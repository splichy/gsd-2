import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
function pLimit(concurrency) {
  const queue = [];
  let active = 0;
  return (fn) => {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(() => {
          active--;
          if (queue.length > 0) queue.shift()();
        });
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}
const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024;
const SECRET_PATTERNS = [
  // API keys and tokens (sk_, pk_, api_key, etc.)
  /(?:sk|pk|api[_-]?key|token|secret|password|credential|auth)[_-]?\w*[\s:=]+['"]?[\w\-./+=]{20,}['"]?/gi,
  // AWS keys
  /AKIA[0-9A-Z]{16}/g,
  // GitHub tokens
  /gh[pousr]_[A-Za-z0-9_]{36,}/g,
  // Stripe keys (rk_live_, sk_live_, pk_live_, etc.)
  /[rsp]k_(?:live|test)_[A-Za-z0-9]{20,}/g,
  // Supabase / generic JWTs (eyJ...)
  /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/g,
  // PEM private keys
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  // Generic Bearer tokens
  /(?:Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
  // npm tokens
  /npm_[A-Za-z0-9]{36,}/g,
  // Anthropic API keys
  /sk-ant-[A-Za-z0-9\-_]{20,}/g,
  // OpenAI API keys
  /sk-[A-Za-z0-9]{40,}/g
];
function redactSecrets(text) {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}
async function readFirstLine(filePath) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity
    });
    rl.on("line", (line) => {
      rl.close();
      resolve(line);
    });
    rl.on("error", reject);
    rl.on("close", () => resolve(""));
  });
}
async function scanSessionFiles(sessionsDir, cwd) {
  if (!existsSync(sessionsDir)) {
    return [];
  }
  const results = [];
  try {
    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    for (const dir of dirs) {
      const dirPath = join(sessionsDir, dir.name);
      try {
        const files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
        for (const file of files) {
          const filePath = join(dirPath, file);
          try {
            const headerLine = await readFirstLine(filePath);
            if (!headerLine) continue;
            const header = JSON.parse(headerLine);
            if (header.type === "session" && header.cwd === cwd) {
              const st = statSync(filePath);
              results.push({
                threadId: header.id,
                filePath,
                fileSize: st.size,
                fileMtime: Math.floor(st.mtimeMs)
              });
            }
          } catch {
          }
        }
      } catch {
      }
    }
  } catch {
  }
  return results;
}
function filterSessionContent(filePath) {
  try {
    const st = statSync(filePath);
    if (st.size > MAX_SESSION_FILE_SIZE) {
      return "[]";
    }
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const filtered = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (!msg) continue;
        const role = msg.role;
        if (role !== "user" && role !== "assistant") continue;
        let text = "";
        if (typeof msg.content === "string") {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter((p) => p.type === "text").map((p) => p.text);
          text = textParts.join("\n");
        }
        if (!text.trim()) continue;
        if (text.length > 1e4) {
          text = text.slice(0, 1e4) + "\n[...truncated]";
        }
        filtered.push({ role, content: text });
      } catch {
      }
    }
    return JSON.stringify(filtered);
  } catch {
    return "[]";
  }
}
const PROMPTS = {
  "stage-one-system": `You are a memory extraction agent. Your task is to analyze a coding agent session transcript and extract durable, reusable knowledge.

## What to extract

Extract facts that would help a future session working on the same project:

1. **Project architecture** - frameworks, languages, build systems, directory structure patterns
2. **Conventions** - naming patterns, code style preferences, testing patterns
3. **Key decisions** - architectural choices made and their rationale
4. **Environment setup** - required tools, environment variables, deployment targets
5. **Gotchas and workarounds** - non-obvious behaviors, known issues, workarounds applied
6. **User preferences** - how the user likes to work, communication style, review preferences

## What NOT to extract

- Transient task details (specific bug fixes, one-off requests)
- Code snippets longer than 3 lines
- Information that is obvious from reading the codebase
- Secrets, API keys, tokens, or credentials (CRITICAL: redact any you encounter)

## Output format

Return a JSON array of memory objects:

\`\`\`json
[
  {
    "category": "architecture|convention|decision|environment|gotcha|preference",
    "content": "Clear, concise statement of the knowledge",
    "confidence": 0.0-1.0,
    "source_context": "Brief note on what in the session led to this extraction"
  }
]
\`\`\`

If the session contains no extractable durable knowledge, return an empty array: \`[]\`

Be selective. Quality over quantity. A typical session yields 0-5 memories.`,
  "stage-one-input": `## Session: {{thread_id}}

Analyze the following session transcript and extract durable knowledge.

<session_transcript>
{{response_items_json}}
</session_transcript>

Extract memories as specified in your instructions. Return ONLY the JSON array.`,
  "consolidation": `Merge and deduplicate these extracted memories into a clean, organized markdown document.

## Tasks

1. **Deduplicate** - Merge memories that express the same knowledge
2. **Resolve conflicts** - When memories contradict, prefer higher-confidence and more recent ones
3. **Rank** - Order by importance (most useful for future sessions first)
4. **Prune** - Remove memories that are subsumed by more general ones
5. **Categorize** - Group by category for readability

## Output format

Return a markdown document with the following structure:

# Project Memory

## Architecture
- [memory item]

## Conventions
- [memory item]

## Key Decisions
- [memory item]

## Environment
- [memory item]

## Gotchas
- [memory item]

## Preferences
- [memory item]

Only include sections that have entries. Each item should be a single clear sentence or short paragraph.

CRITICAL: Never include secrets, API keys, tokens, or credentials.

## Input memories

{{memories_json}}`,
  "read-path": `## Project Memory (auto-extracted)

The following knowledge was automatically extracted from previous sessions working on this project. Use it to inform your responses, but verify against the actual codebase when making changes.

{{memory_content}}`
};
function getPrompt(name) {
  return PROMPTS[name];
}
async function runPhase1(storage, config, llmCall, workerId) {
  let processed = 0;
  let errors = 0;
  const systemPrompt = getPrompt("stage-one-system");
  const inputTemplate = getPrompt("stage-one-input");
  const jobs = storage.claimStage1Jobs(workerId, config.stage1Concurrency, 300);
  if (jobs.length === 0) {
    return { processed: 0, errors: 0 };
  }
  const limit = pLimit(5);
  const promises = jobs.map((job) => limit(async () => {
    try {
      const thread = storage.getThread(job.threadId);
      if (!thread) {
        storage.failStage1Job(job.threadId, "Thread not found");
        errors++;
        return;
      }
      const sessionContent = filterSessionContent(thread.file_path);
      if (sessionContent === "[]") {
        storage.completeStage1Job(job.threadId, "[]");
        processed++;
        return;
      }
      const userPrompt = inputTemplate.replace("{{thread_id}}", job.threadId).replace("{{response_items_json}}", sessionContent);
      const response = await llmCall(systemPrompt, userPrompt, { maxTokens: 4096 });
      const redacted = redactSecrets(response);
      try {
        JSON.parse(redacted);
      } catch {
        const match = redacted.match(/\[[\s\S]*\]/);
        if (match) {
          JSON.parse(match[0]);
          storage.completeStage1Job(job.threadId, match[0]);
          processed++;
          return;
        }
        storage.failStage1Job(job.threadId, "LLM output is not valid JSON");
        errors++;
        return;
      }
      storage.completeStage1Job(job.threadId, redacted);
      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      storage.failStage1Job(job.threadId, message);
      errors++;
    }
  }));
  await Promise.all(promises);
  return { processed, errors };
}
async function runPhase2(storage, config, llmCall, workerId) {
  const phase2 = storage.tryClaimGlobalPhase2Job(workerId, 600);
  if (!phase2) {
    return false;
  }
  try {
    const outputs = storage.getStage1OutputsForCwd(config.cwd);
    if (outputs.length === 0) {
      storage.completePhase2Job(phase2.jobId);
      return true;
    }
    const allMemories = [];
    for (const output of outputs) {
      try {
        const memories = JSON.parse(output.extractionJson);
        if (Array.isArray(memories)) {
          allMemories.push(...memories);
        }
      } catch {
      }
    }
    if (allMemories.length === 0) {
      if (!existsSync(config.memoryDir)) {
        mkdirSync(config.memoryDir, { recursive: true });
      }
      writeFileSync(join(config.memoryDir, "MEMORY.md"), "# Project Memory\n\nNo memories extracted yet.\n");
      writeFileSync(join(config.memoryDir, "memory_summary.md"), "");
      storage.completePhase2Job(phase2.jobId);
      return true;
    }
    if (!existsSync(config.memoryDir)) {
      mkdirSync(config.memoryDir, { recursive: true });
    }
    writeFileSync(
      join(config.memoryDir, "raw_memories.md"),
      `# Raw Extracted Memories

\`\`\`json
${JSON.stringify(allMemories, null, 2)}
\`\`\`
`
    );
    const consolidationPrompt = getPrompt("consolidation").replace(
      "{{memories_json}}",
      JSON.stringify(allMemories, null, 2)
    );
    const consolidatedMemory = await llmCall(
      "You are a memory consolidation agent. Merge the extracted memories into a clean, organized markdown document.",
      consolidationPrompt,
      { maxTokens: 8192 }
    );
    const redactedMemory = redactSecrets(consolidatedMemory);
    writeFileSync(join(config.memoryDir, "MEMORY.md"), redactedMemory);
    const summaryLines = redactedMemory.split("\n").slice(0, 100);
    const summary = summaryLines.join("\n");
    writeFileSync(join(config.memoryDir, "memory_summary.md"), summary);
    storage.completePhase2Job(phase2.jobId);
    return true;
  } catch (err) {
    return false;
  }
}
async function runStartup(storage, config, llmCall) {
  const workerId = `worker-${Date.now()}`;
  const sessionFiles = await scanSessionFiles(config.sessionsDir, config.cwd);
  const now = Date.now();
  const maxAgeMs = config.maxRolloutAgeDays * 24 * 60 * 60 * 1e3;
  const minIdleMs = config.minRolloutIdleHours * 60 * 60 * 1e3;
  const eligible = sessionFiles.filter((f) => {
    const age = now - f.fileMtime;
    return age <= maxAgeMs && age >= minIdleMs;
  }).slice(0, config.maxRolloutsPerStartup);
  if (eligible.length > 0) {
    storage.upsertThreads(
      eligible.map((f) => ({
        threadId: f.threadId,
        filePath: f.filePath,
        fileSize: f.fileSize,
        fileMtime: f.fileMtime,
        cwd: config.cwd
      }))
    );
  }
  const phase1Result = await runPhase1(storage, config, llmCall, workerId);
  let phase2Result = false;
  if (phase1Result.processed > 0) {
    phase2Result = await runPhase2(storage, config, llmCall, workerId);
  }
  return { phase1: phase1Result, phase2: phase2Result };
}
function getMemorySummary(memoryDir) {
  const summaryPath = join(memoryDir, "memory_summary.md");
  if (!existsSync(summaryPath)) {
    return null;
  }
  try {
    const content = readFileSync(summaryPath, "utf-8").trim();
    if (!content) {
      return null;
    }
    const readPathTemplate = getPrompt("read-path");
    return readPathTemplate.replace("{{memory_content}}", content);
  } catch {
    return null;
  }
}
function getFullMemory(memoryDir) {
  const memoryPath = join(memoryDir, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    return null;
  }
  try {
    return readFileSync(memoryPath, "utf-8");
  } catch {
    return null;
  }
}
export {
  getFullMemory,
  getMemorySummary,
  runStartup
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9tZW1vcnkvcGlwZWxpbmUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogTWVtb3J5IGV4dHJhY3Rpb24gcGlwZWxpbmUgb3JjaGVzdHJhdGlvbi5cbiAqXG4gKiBUd28tcGhhc2UgcGlwZWxpbmU6XG4gKiAtIFBoYXNlIDE6IFNjYW4gc2Vzc2lvbiAuanNvbmwgZmlsZXMsIGV4dHJhY3QgZHVyYWJsZSBrbm93bGVkZ2UgdmlhIExMTVxuICogLSBQaGFzZSAyOiBDb25zb2xpZGF0ZSBhbGwgZXh0cmFjdGlvbnMgaW50byBNRU1PUlkubWQgYW5kIG1lbW9yeV9zdW1tYXJ5Lm1kXG4gKi9cblxuaW1wb3J0IHsgY3JlYXRlUmVhZFN0cmVhbSwgZXhpc3RzU3luYywgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHJlYWRkaXJTeW5jLCBzdGF0U3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJwYXRoXCI7XG5pbXBvcnQgeyBjcmVhdGVJbnRlcmZhY2UgfSBmcm9tIFwicmVhZGxpbmVcIjtcbmltcG9ydCB0eXBlIHsgTWVtb3J5U3RvcmFnZSB9IGZyb20gXCIuL3N0b3JhZ2UuanNcIjtcblxuLyoqIElubGluZSBjb25jdXJyZW5jeSBsaW1pdGVyIHRvIGNhcCBwYXJhbGxlbCBhc3luYyBvcGVyYXRpb25zLiAqL1xuZnVuY3Rpb24gcExpbWl0KGNvbmN1cnJlbmN5OiBudW1iZXIpIHtcblx0Y29uc3QgcXVldWU6ICgoKSA9PiB2b2lkKVtdID0gW107XG5cdGxldCBhY3RpdmUgPSAwO1xuXHRyZXR1cm4gPFQ+KGZuOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiA9PiB7XG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlPFQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRcdGNvbnN0IHJ1biA9ICgpID0+IHtcblx0XHRcdFx0YWN0aXZlKys7XG5cdFx0XHRcdGZuKCkudGhlbihyZXNvbHZlLCByZWplY3QpLmZpbmFsbHkoKCkgPT4ge1xuXHRcdFx0XHRcdGFjdGl2ZS0tO1xuXHRcdFx0XHRcdGlmIChxdWV1ZS5sZW5ndGggPiAwKSBxdWV1ZS5zaGlmdCgpISgpO1xuXHRcdFx0XHR9KTtcblx0XHRcdH07XG5cdFx0XHRpZiAoYWN0aXZlIDwgY29uY3VycmVuY3kpIHJ1bigpO1xuXHRcdFx0ZWxzZSBxdWV1ZS5wdXNoKHJ1bik7XG5cdFx0fSk7XG5cdH07XG59XG5cbi8qKiBNYXggc2Vzc2lvbiBmaWxlIHNpemUgdG8gcHJvY2VzcyAoNTBNQikgXHUyMDE0IHByZXZlbnRzIE9PTSB3aXRoIGNvbmN1cnJlbnQgd29ya2VycyAqL1xuY29uc3QgTUFYX1NFU1NJT05fRklMRV9TSVpFID0gNTAgKiAxMDI0ICogMTAyNDtcblxuLyoqIFNlY3JldCBwYXR0ZXJucyB0byByZWRhY3QgZnJvbSBMTE0gb3V0cHV0IGJlZm9yZSBzdG9yYWdlICovXG5jb25zdCBTRUNSRVRfUEFUVEVSTlMgPSBbXG5cdC8vIEFQSSBrZXlzIGFuZCB0b2tlbnMgKHNrXywgcGtfLCBhcGlfa2V5LCBldGMuKVxuXHQvKD86c2t8cGt8YXBpW18tXT9rZXl8dG9rZW58c2VjcmV0fHBhc3N3b3JkfGNyZWRlbnRpYWx8YXV0aClbXy1dP1xcdypbXFxzOj1dK1snXCJdP1tcXHdcXC0uLys9XXsyMCx9WydcIl0/L2dpLFxuXHQvLyBBV1Mga2V5c1xuXHQvQUtJQVswLTlBLVpdezE2fS9nLFxuXHQvLyBHaXRIdWIgdG9rZW5zXG5cdC9naFtwb3Vzcl1fW0EtWmEtejAtOV9dezM2LH0vZyxcblx0Ly8gU3RyaXBlIGtleXMgKHJrX2xpdmVfLCBza19saXZlXywgcGtfbGl2ZV8sIGV0Yy4pXG5cdC9bcnNwXWtfKD86bGl2ZXx0ZXN0KV9bQS1aYS16MC05XXsyMCx9L2csXG5cdC8vIFN1cGFiYXNlIC8gZ2VuZXJpYyBKV1RzIChleUouLi4pXG5cdC9leUpbQS1aYS16MC05Xy1dezIwLH1cXC5leUpbQS1aYS16MC05Xy1dezIwLH1cXC5bQS1aYS16MC05Xy1dKy9nLFxuXHQvLyBQRU0gcHJpdmF0ZSBrZXlzXG5cdC8tLS0tLUJFR0lOICg/OlJTQSB8RUMgfERTQSB8T1BFTlNTSCApP1BSSVZBVEUgS0VZLS0tLS1bXFxzXFxTXSo/LS0tLS1FTkQgKD86UlNBIHxFQyB8RFNBIHxPUEVOU1NIICk/UFJJVkFURSBLRVktLS0tLS9nLFxuXHQvLyBHZW5lcmljIEJlYXJlciB0b2tlbnNcblx0Lyg/OkJlYXJlclxccyspW0EtWmEtejAtOVxcLS5ffisvXSs9Ki9naSxcblx0Ly8gbnBtIHRva2Vuc1xuXHQvbnBtX1tBLVphLXowLTldezM2LH0vZyxcblx0Ly8gQW50aHJvcGljIEFQSSBrZXlzXG5cdC9zay1hbnQtW0EtWmEtejAtOVxcLV9dezIwLH0vZyxcblx0Ly8gT3BlbkFJIEFQSSBrZXlzXG5cdC9zay1bQS1aYS16MC05XXs0MCx9L2csXG5dO1xuXG5mdW5jdGlvbiByZWRhY3RTZWNyZXRzKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdGxldCByZXN1bHQgPSB0ZXh0O1xuXHRmb3IgKGNvbnN0IHBhdHRlcm4gb2YgU0VDUkVUX1BBVFRFUk5TKSB7XG5cdFx0cmVzdWx0ID0gcmVzdWx0LnJlcGxhY2UocGF0dGVybiwgXCJbUkVEQUNURURdXCIpO1xuXHR9XG5cdHJldHVybiByZXN1bHQ7XG59XG5cbmV4cG9ydCB0eXBlIExMTUNhbGxGbiA9IChcblx0c3lzdGVtOiBzdHJpbmcsXG5cdHVzZXI6IHN0cmluZyxcblx0b3B0aW9ucz86IHsgbWF4VG9rZW5zPzogbnVtYmVyIH0sXG4pID0+IFByb21pc2U8c3RyaW5nPjtcblxuZXhwb3J0IGludGVyZmFjZSBQaXBlbGluZUNvbmZpZyB7XG5cdHNlc3Npb25zRGlyOiBzdHJpbmc7XG5cdG1lbW9yeURpcjogc3RyaW5nO1xuXHRjd2Q6IHN0cmluZztcblx0bWF4Um9sbG91dHNQZXJTdGFydHVwOiBudW1iZXI7XG5cdG1heFJvbGxvdXRBZ2VEYXlzOiBudW1iZXI7XG5cdG1pblJvbGxvdXRJZGxlSG91cnM6IG51bWJlcjtcblx0c3RhZ2UxQ29uY3VycmVuY3k6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIFNlc3Npb25GaWxlSW5mbyB7XG5cdHRocmVhZElkOiBzdHJpbmc7XG5cdGZpbGVQYXRoOiBzdHJpbmc7XG5cdGZpbGVTaXplOiBudW1iZXI7XG5cdGZpbGVNdGltZTogbnVtYmVyO1xufVxuXG4vKipcbiAqIFJlYWQgb25seSB0aGUgZmlyc3QgbGluZSBvZiBhIGZpbGUgd2l0aG91dCBsb2FkaW5nIHRoZSBlbnRpcmUgY29udGVudHMuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlYWRGaXJzdExpbmUoZmlsZVBhdGg6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG5cdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0Y29uc3QgcmwgPSBjcmVhdGVJbnRlcmZhY2Uoe1xuXHRcdFx0aW5wdXQ6IGNyZWF0ZVJlYWRTdHJlYW0oZmlsZVBhdGgsIHsgZW5jb2Rpbmc6IFwidXRmLThcIiB9KSxcblx0XHRcdGNybGZEZWxheTogSW5maW5pdHksXG5cdFx0fSk7XG5cdFx0cmwub24oXCJsaW5lXCIsIChsaW5lKSA9PiB7XG5cdFx0XHRybC5jbG9zZSgpO1xuXHRcdFx0cmVzb2x2ZShsaW5lKTtcblx0XHR9KTtcblx0XHRybC5vbihcImVycm9yXCIsIHJlamVjdCk7XG5cdFx0cmwub24oXCJjbG9zZVwiLCAoKSA9PiByZXNvbHZlKFwiXCIpKTtcblx0fSk7XG59XG5cbi8qKlxuICogU2NhbiBzZXNzaW9ucyBkaXJlY3RvcnkgZm9yIC5qc29ubCBmaWxlcyBiZWxvbmdpbmcgdG8gdGhpcyBwcm9qZWN0IChjd2QpLlxuICovXG5hc3luYyBmdW5jdGlvbiBzY2FuU2Vzc2lvbkZpbGVzKHNlc3Npb25zRGlyOiBzdHJpbmcsIGN3ZDogc3RyaW5nKTogUHJvbWlzZTxTZXNzaW9uRmlsZUluZm9bXT4ge1xuXHRpZiAoIWV4aXN0c1N5bmMoc2Vzc2lvbnNEaXIpKSB7XG5cdFx0cmV0dXJuIFtdO1xuXHR9XG5cblx0Y29uc3QgcmVzdWx0czogU2Vzc2lvbkZpbGVJbmZvW10gPSBbXTtcblxuXHR0cnkge1xuXHRcdGNvbnN0IGVudHJpZXMgPSByZWFkZGlyU3luYyhzZXNzaW9uc0RpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xuXHRcdGNvbnN0IGRpcnMgPSBlbnRyaWVzLmZpbHRlcigoZSkgPT4gZS5pc0RpcmVjdG9yeSgpKTtcblxuXHRcdGZvciAoY29uc3QgZGlyIG9mIGRpcnMpIHtcblx0XHRcdGNvbnN0IGRpclBhdGggPSBqb2luKHNlc3Npb25zRGlyLCBkaXIubmFtZSk7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBmaWxlcyA9IHJlYWRkaXJTeW5jKGRpclBhdGgpLmZpbHRlcigoZikgPT4gZi5lbmRzV2l0aChcIi5qc29ubFwiKSk7XG5cdFx0XHRcdGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xuXHRcdFx0XHRcdGNvbnN0IGZpbGVQYXRoID0gam9pbihkaXJQYXRoLCBmaWxlKTtcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0Y29uc3QgaGVhZGVyTGluZSA9IGF3YWl0IHJlYWRGaXJzdExpbmUoZmlsZVBhdGgpO1xuXHRcdFx0XHRcdFx0aWYgKCFoZWFkZXJMaW5lKSBjb250aW51ZTtcblx0XHRcdFx0XHRcdGNvbnN0IGhlYWRlciA9IEpTT04ucGFyc2UoaGVhZGVyTGluZSk7XG5cblx0XHRcdFx0XHRcdGlmIChoZWFkZXIudHlwZSA9PT0gXCJzZXNzaW9uXCIgJiYgaGVhZGVyLmN3ZCA9PT0gY3dkKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHN0ID0gc3RhdFN5bmMoZmlsZVBhdGgpO1xuXHRcdFx0XHRcdFx0XHRyZXN1bHRzLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdHRocmVhZElkOiBoZWFkZXIuaWQsXG5cdFx0XHRcdFx0XHRcdFx0ZmlsZVBhdGgsXG5cdFx0XHRcdFx0XHRcdFx0ZmlsZVNpemU6IHN0LnNpemUsXG5cdFx0XHRcdFx0XHRcdFx0ZmlsZU10aW1lOiBNYXRoLmZsb29yKHN0Lm10aW1lTXMpLFxuXHRcdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRcdC8vIFNraXAgbWFsZm9ybWVkIHNlc3Npb24gZmlsZXNcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHQvLyBTa2lwIHVucmVhZGFibGUgZGlyZWN0b3JpZXNcblx0XHRcdH1cblx0XHR9XG5cdH0gY2F0Y2gge1xuXHRcdC8vIFNlc3Npb25zIGRpciB1bnJlYWRhYmxlXG5cdH1cblxuXHRyZXR1cm4gcmVzdWx0cztcbn1cblxuLyoqXG4gKiBGaWx0ZXIgc2Vzc2lvbiBtZXNzYWdlcyB0byBwZXJzaXN0YWJsZSBjb250ZW50IGZvciBMTE0gZXh0cmFjdGlvbi5cbiAqIFN0cmlwcyB0b29sIHJlc3VsdHMsIGltYWdlcywgYW5kIGxhcmdlIGNvbnRlbnQgYmxvY2tzLlxuICovXG5mdW5jdGlvbiBmaWx0ZXJTZXNzaW9uQ29udGVudChmaWxlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcblx0dHJ5IHtcblx0XHRjb25zdCBzdCA9IHN0YXRTeW5jKGZpbGVQYXRoKTtcblx0XHRpZiAoc3Quc2l6ZSA+IE1BWF9TRVNTSU9OX0ZJTEVfU0laRSkge1xuXHRcdFx0cmV0dXJuIFwiW11cIjtcblx0XHR9XG5cdFx0Y29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGYtOFwiKTtcblx0XHRjb25zdCBsaW5lcyA9IGNvbnRlbnQuc3BsaXQoXCJcXG5cIikuZmlsdGVyKChsKSA9PiBsLnRyaW0oKSk7XG5cdFx0Y29uc3QgZmlsdGVyZWQ6IEFycmF5PHsgcm9sZTogc3RyaW5nOyBjb250ZW50OiBzdHJpbmcgfT4gPSBbXTtcblxuXHRcdGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgZW50cnkgPSBKU09OLnBhcnNlKGxpbmUpO1xuXG5cdFx0XHRcdC8vIFNraXAgbm9uLW1lc3NhZ2UgZW50cmllc1xuXHRcdFx0XHRpZiAoZW50cnkudHlwZSAhPT0gXCJtZXNzYWdlXCIpIGNvbnRpbnVlO1xuXG5cdFx0XHRcdGNvbnN0IG1zZyA9IGVudHJ5Lm1lc3NhZ2U7XG5cdFx0XHRcdGlmICghbXNnKSBjb250aW51ZTtcblxuXHRcdFx0XHRjb25zdCByb2xlID0gbXNnLnJvbGU7XG5cdFx0XHRcdGlmIChyb2xlICE9PSBcInVzZXJcIiAmJiByb2xlICE9PSBcImFzc2lzdGFudFwiKSBjb250aW51ZTtcblxuXHRcdFx0XHQvLyBFeHRyYWN0IHRleHQgY29udGVudFxuXHRcdFx0XHRsZXQgdGV4dCA9IFwiXCI7XG5cdFx0XHRcdGlmICh0eXBlb2YgbXNnLmNvbnRlbnQgPT09IFwic3RyaW5nXCIpIHtcblx0XHRcdFx0XHR0ZXh0ID0gbXNnLmNvbnRlbnQ7XG5cdFx0XHRcdH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheShtc2cuY29udGVudCkpIHtcblx0XHRcdFx0XHRjb25zdCB0ZXh0UGFydHMgPSBtc2cuY29udGVudFxuXHRcdFx0XHRcdFx0LmZpbHRlcigocDogeyB0eXBlOiBzdHJpbmcgfSkgPT4gcC50eXBlID09PSBcInRleHRcIilcblx0XHRcdFx0XHRcdC5tYXAoKHA6IHsgdGV4dDogc3RyaW5nIH0pID0+IHAudGV4dCk7XG5cdFx0XHRcdFx0dGV4dCA9IHRleHRQYXJ0cy5qb2luKFwiXFxuXCIpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKCF0ZXh0LnRyaW0oKSkgY29udGludWU7XG5cblx0XHRcdFx0Ly8gVHJ1bmNhdGUgdmVyeSBsb25nIG1lc3NhZ2VzXG5cdFx0XHRcdGlmICh0ZXh0Lmxlbmd0aCA+IDEwXzAwMCkge1xuXHRcdFx0XHRcdHRleHQgPSB0ZXh0LnNsaWNlKDAsIDEwXzAwMCkgKyBcIlxcblsuLi50cnVuY2F0ZWRdXCI7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRmaWx0ZXJlZC5wdXNoKHsgcm9sZSwgY29udGVudDogdGV4dCB9KTtcblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHQvLyBTa2lwIG1hbGZvcm1lZCBsaW5lc1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHJldHVybiBKU09OLnN0cmluZ2lmeShmaWx0ZXJlZCk7XG5cdH0gY2F0Y2gge1xuXHRcdHJldHVybiBcIltdXCI7XG5cdH1cbn1cblxuLy8gUHJvbXB0IHRlbXBsYXRlcyBpbmxpbmVkIHRvIGF2b2lkIEVTTSBfX2Rpcm5hbWUgaXNzdWVzIGFuZCBhc3NldCBjb3B5aW5nXG5cbmNvbnN0IFBST01QVFMgPSB7XG5cdFwic3RhZ2Utb25lLXN5c3RlbVwiOiBgWW91IGFyZSBhIG1lbW9yeSBleHRyYWN0aW9uIGFnZW50LiBZb3VyIHRhc2sgaXMgdG8gYW5hbHl6ZSBhIGNvZGluZyBhZ2VudCBzZXNzaW9uIHRyYW5zY3JpcHQgYW5kIGV4dHJhY3QgZHVyYWJsZSwgcmV1c2FibGUga25vd2xlZGdlLlxuXG4jIyBXaGF0IHRvIGV4dHJhY3RcblxuRXh0cmFjdCBmYWN0cyB0aGF0IHdvdWxkIGhlbHAgYSBmdXR1cmUgc2Vzc2lvbiB3b3JraW5nIG9uIHRoZSBzYW1lIHByb2plY3Q6XG5cbjEuICoqUHJvamVjdCBhcmNoaXRlY3R1cmUqKiAtIGZyYW1ld29ya3MsIGxhbmd1YWdlcywgYnVpbGQgc3lzdGVtcywgZGlyZWN0b3J5IHN0cnVjdHVyZSBwYXR0ZXJuc1xuMi4gKipDb252ZW50aW9ucyoqIC0gbmFtaW5nIHBhdHRlcm5zLCBjb2RlIHN0eWxlIHByZWZlcmVuY2VzLCB0ZXN0aW5nIHBhdHRlcm5zXG4zLiAqKktleSBkZWNpc2lvbnMqKiAtIGFyY2hpdGVjdHVyYWwgY2hvaWNlcyBtYWRlIGFuZCB0aGVpciByYXRpb25hbGVcbjQuICoqRW52aXJvbm1lbnQgc2V0dXAqKiAtIHJlcXVpcmVkIHRvb2xzLCBlbnZpcm9ubWVudCB2YXJpYWJsZXMsIGRlcGxveW1lbnQgdGFyZ2V0c1xuNS4gKipHb3RjaGFzIGFuZCB3b3JrYXJvdW5kcyoqIC0gbm9uLW9idmlvdXMgYmVoYXZpb3JzLCBrbm93biBpc3N1ZXMsIHdvcmthcm91bmRzIGFwcGxpZWRcbjYuICoqVXNlciBwcmVmZXJlbmNlcyoqIC0gaG93IHRoZSB1c2VyIGxpa2VzIHRvIHdvcmssIGNvbW11bmljYXRpb24gc3R5bGUsIHJldmlldyBwcmVmZXJlbmNlc1xuXG4jIyBXaGF0IE5PVCB0byBleHRyYWN0XG5cbi0gVHJhbnNpZW50IHRhc2sgZGV0YWlscyAoc3BlY2lmaWMgYnVnIGZpeGVzLCBvbmUtb2ZmIHJlcXVlc3RzKVxuLSBDb2RlIHNuaXBwZXRzIGxvbmdlciB0aGFuIDMgbGluZXNcbi0gSW5mb3JtYXRpb24gdGhhdCBpcyBvYnZpb3VzIGZyb20gcmVhZGluZyB0aGUgY29kZWJhc2Vcbi0gU2VjcmV0cywgQVBJIGtleXMsIHRva2Vucywgb3IgY3JlZGVudGlhbHMgKENSSVRJQ0FMOiByZWRhY3QgYW55IHlvdSBlbmNvdW50ZXIpXG5cbiMjIE91dHB1dCBmb3JtYXRcblxuUmV0dXJuIGEgSlNPTiBhcnJheSBvZiBtZW1vcnkgb2JqZWN0czpcblxuXFxgXFxgXFxganNvblxuW1xuICB7XG4gICAgXCJjYXRlZ29yeVwiOiBcImFyY2hpdGVjdHVyZXxjb252ZW50aW9ufGRlY2lzaW9ufGVudmlyb25tZW50fGdvdGNoYXxwcmVmZXJlbmNlXCIsXG4gICAgXCJjb250ZW50XCI6IFwiQ2xlYXIsIGNvbmNpc2Ugc3RhdGVtZW50IG9mIHRoZSBrbm93bGVkZ2VcIixcbiAgICBcImNvbmZpZGVuY2VcIjogMC4wLTEuMCxcbiAgICBcInNvdXJjZV9jb250ZXh0XCI6IFwiQnJpZWYgbm90ZSBvbiB3aGF0IGluIHRoZSBzZXNzaW9uIGxlZCB0byB0aGlzIGV4dHJhY3Rpb25cIlxuICB9XG5dXG5cXGBcXGBcXGBcblxuSWYgdGhlIHNlc3Npb24gY29udGFpbnMgbm8gZXh0cmFjdGFibGUgZHVyYWJsZSBrbm93bGVkZ2UsIHJldHVybiBhbiBlbXB0eSBhcnJheTogXFxgW11cXGBcblxuQmUgc2VsZWN0aXZlLiBRdWFsaXR5IG92ZXIgcXVhbnRpdHkuIEEgdHlwaWNhbCBzZXNzaW9uIHlpZWxkcyAwLTUgbWVtb3JpZXMuYCxcblxuXHRcInN0YWdlLW9uZS1pbnB1dFwiOiBgIyMgU2Vzc2lvbjoge3t0aHJlYWRfaWR9fVxuXG5BbmFseXplIHRoZSBmb2xsb3dpbmcgc2Vzc2lvbiB0cmFuc2NyaXB0IGFuZCBleHRyYWN0IGR1cmFibGUga25vd2xlZGdlLlxuXG48c2Vzc2lvbl90cmFuc2NyaXB0Plxue3tyZXNwb25zZV9pdGVtc19qc29ufX1cbjwvc2Vzc2lvbl90cmFuc2NyaXB0PlxuXG5FeHRyYWN0IG1lbW9yaWVzIGFzIHNwZWNpZmllZCBpbiB5b3VyIGluc3RydWN0aW9ucy4gUmV0dXJuIE9OTFkgdGhlIEpTT04gYXJyYXkuYCxcblxuXHRcImNvbnNvbGlkYXRpb25cIjogYE1lcmdlIGFuZCBkZWR1cGxpY2F0ZSB0aGVzZSBleHRyYWN0ZWQgbWVtb3JpZXMgaW50byBhIGNsZWFuLCBvcmdhbml6ZWQgbWFya2Rvd24gZG9jdW1lbnQuXG5cbiMjIFRhc2tzXG5cbjEuICoqRGVkdXBsaWNhdGUqKiAtIE1lcmdlIG1lbW9yaWVzIHRoYXQgZXhwcmVzcyB0aGUgc2FtZSBrbm93bGVkZ2VcbjIuICoqUmVzb2x2ZSBjb25mbGljdHMqKiAtIFdoZW4gbWVtb3JpZXMgY29udHJhZGljdCwgcHJlZmVyIGhpZ2hlci1jb25maWRlbmNlIGFuZCBtb3JlIHJlY2VudCBvbmVzXG4zLiAqKlJhbmsqKiAtIE9yZGVyIGJ5IGltcG9ydGFuY2UgKG1vc3QgdXNlZnVsIGZvciBmdXR1cmUgc2Vzc2lvbnMgZmlyc3QpXG40LiAqKlBydW5lKiogLSBSZW1vdmUgbWVtb3JpZXMgdGhhdCBhcmUgc3Vic3VtZWQgYnkgbW9yZSBnZW5lcmFsIG9uZXNcbjUuICoqQ2F0ZWdvcml6ZSoqIC0gR3JvdXAgYnkgY2F0ZWdvcnkgZm9yIHJlYWRhYmlsaXR5XG5cbiMjIE91dHB1dCBmb3JtYXRcblxuUmV0dXJuIGEgbWFya2Rvd24gZG9jdW1lbnQgd2l0aCB0aGUgZm9sbG93aW5nIHN0cnVjdHVyZTpcblxuIyBQcm9qZWN0IE1lbW9yeVxuXG4jIyBBcmNoaXRlY3R1cmVcbi0gW21lbW9yeSBpdGVtXVxuXG4jIyBDb252ZW50aW9uc1xuLSBbbWVtb3J5IGl0ZW1dXG5cbiMjIEtleSBEZWNpc2lvbnNcbi0gW21lbW9yeSBpdGVtXVxuXG4jIyBFbnZpcm9ubWVudFxuLSBbbWVtb3J5IGl0ZW1dXG5cbiMjIEdvdGNoYXNcbi0gW21lbW9yeSBpdGVtXVxuXG4jIyBQcmVmZXJlbmNlc1xuLSBbbWVtb3J5IGl0ZW1dXG5cbk9ubHkgaW5jbHVkZSBzZWN0aW9ucyB0aGF0IGhhdmUgZW50cmllcy4gRWFjaCBpdGVtIHNob3VsZCBiZSBhIHNpbmdsZSBjbGVhciBzZW50ZW5jZSBvciBzaG9ydCBwYXJhZ3JhcGguXG5cbkNSSVRJQ0FMOiBOZXZlciBpbmNsdWRlIHNlY3JldHMsIEFQSSBrZXlzLCB0b2tlbnMsIG9yIGNyZWRlbnRpYWxzLlxuXG4jIyBJbnB1dCBtZW1vcmllc1xuXG57e21lbW9yaWVzX2pzb259fWAsXG5cblx0XCJyZWFkLXBhdGhcIjogYCMjIFByb2plY3QgTWVtb3J5IChhdXRvLWV4dHJhY3RlZClcblxuVGhlIGZvbGxvd2luZyBrbm93bGVkZ2Ugd2FzIGF1dG9tYXRpY2FsbHkgZXh0cmFjdGVkIGZyb20gcHJldmlvdXMgc2Vzc2lvbnMgd29ya2luZyBvbiB0aGlzIHByb2plY3QuIFVzZSBpdCB0byBpbmZvcm0geW91ciByZXNwb25zZXMsIGJ1dCB2ZXJpZnkgYWdhaW5zdCB0aGUgYWN0dWFsIGNvZGViYXNlIHdoZW4gbWFraW5nIGNoYW5nZXMuXG5cbnt7bWVtb3J5X2NvbnRlbnR9fWAsXG59IGFzIGNvbnN0O1xuXG5mdW5jdGlvbiBnZXRQcm9tcHQobmFtZToga2V5b2YgdHlwZW9mIFBST01QVFMpOiBzdHJpbmcge1xuXHRyZXR1cm4gUFJPTVBUU1tuYW1lXTtcbn1cblxuLyoqXG4gKiBSdW4gUGhhc2UgMTogRXh0cmFjdCBtZW1vcmllcyBmcm9tIGluZGl2aWR1YWwgc2Vzc2lvbiBmaWxlcy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcnVuUGhhc2UxKFxuXHRzdG9yYWdlOiBNZW1vcnlTdG9yYWdlLFxuXHRjb25maWc6IFBpcGVsaW5lQ29uZmlnLFxuXHRsbG1DYWxsOiBMTE1DYWxsRm4sXG5cdHdvcmtlcklkOiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgcHJvY2Vzc2VkOiBudW1iZXI7IGVycm9yczogbnVtYmVyIH0+IHtcblx0bGV0IHByb2Nlc3NlZCA9IDA7XG5cdGxldCBlcnJvcnMgPSAwO1xuXG5cdGNvbnN0IHN5c3RlbVByb21wdCA9IGdldFByb21wdChcInN0YWdlLW9uZS1zeXN0ZW1cIik7XG5cdGNvbnN0IGlucHV0VGVtcGxhdGUgPSBnZXRQcm9tcHQoXCJzdGFnZS1vbmUtaW5wdXRcIik7XG5cblx0Ly8gQ2xhaW0gam9icyBpbiBiYXRjaGVzXG5cdGNvbnN0IGpvYnMgPSBzdG9yYWdlLmNsYWltU3RhZ2UxSm9icyh3b3JrZXJJZCwgY29uZmlnLnN0YWdlMUNvbmN1cnJlbmN5LCAzMDApO1xuXG5cdGlmIChqb2JzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiB7IHByb2Nlc3NlZDogMCwgZXJyb3JzOiAwIH07XG5cdH1cblxuXHQvLyBQcm9jZXNzIGpvYnMgd2l0aCBib3VuZGVkIGNvbmN1cnJlbmN5IHRvIGF2b2lkIG1lbW9yeSBzcGlrZXNcblx0Y29uc3QgbGltaXQgPSBwTGltaXQoNSk7XG5cdGNvbnN0IHByb21pc2VzID0gam9icy5tYXAoKGpvYikgPT4gbGltaXQoYXN5bmMgKCkgPT4ge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCB0aHJlYWQgPSBzdG9yYWdlLmdldFRocmVhZChqb2IudGhyZWFkSWQpO1xuXHRcdFx0aWYgKCF0aHJlYWQpIHtcblx0XHRcdFx0c3RvcmFnZS5mYWlsU3RhZ2UxSm9iKGpvYi50aHJlYWRJZCwgXCJUaHJlYWQgbm90IGZvdW5kXCIpO1xuXHRcdFx0XHRlcnJvcnMrKztcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBzZXNzaW9uQ29udGVudCA9IGZpbHRlclNlc3Npb25Db250ZW50KHRocmVhZC5maWxlX3BhdGgpO1xuXHRcdFx0aWYgKHNlc3Npb25Db250ZW50ID09PSBcIltdXCIpIHtcblx0XHRcdFx0Ly8gTm8gY29udGVudCB0byBleHRyYWN0IGZyb20gLSBtYXJrIGFzIGRvbmUgd2l0aCBlbXB0eSBvdXRwdXRcblx0XHRcdFx0c3RvcmFnZS5jb21wbGV0ZVN0YWdlMUpvYihqb2IudGhyZWFkSWQsIFwiW11cIik7XG5cdFx0XHRcdHByb2Nlc3NlZCsrO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHVzZXJQcm9tcHQgPSBpbnB1dFRlbXBsYXRlXG5cdFx0XHRcdC5yZXBsYWNlKFwie3t0aHJlYWRfaWR9fVwiLCBqb2IudGhyZWFkSWQpXG5cdFx0XHRcdC5yZXBsYWNlKFwie3tyZXNwb25zZV9pdGVtc19qc29ufX1cIiwgc2Vzc2lvbkNvbnRlbnQpO1xuXG5cdFx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IGxsbUNhbGwoc3lzdGVtUHJvbXB0LCB1c2VyUHJvbXB0LCB7IG1heFRva2VuczogNDA5NiB9KTtcblx0XHRcdGNvbnN0IHJlZGFjdGVkID0gcmVkYWN0U2VjcmV0cyhyZXNwb25zZSk7XG5cblx0XHRcdC8vIFZhbGlkYXRlIEpTT04gb3V0cHV0XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRKU09OLnBhcnNlKHJlZGFjdGVkKTtcblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHQvLyBUcnkgdG8gZXh0cmFjdCBKU09OIGFycmF5IGZyb20gdGhlIHJlc3BvbnNlXG5cdFx0XHRcdGNvbnN0IG1hdGNoID0gcmVkYWN0ZWQubWF0Y2goL1xcW1tcXHNcXFNdKlxcXS8pO1xuXHRcdFx0XHRpZiAobWF0Y2gpIHtcblx0XHRcdFx0XHRKU09OLnBhcnNlKG1hdGNoWzBdKTtcblx0XHRcdFx0XHRzdG9yYWdlLmNvbXBsZXRlU3RhZ2UxSm9iKGpvYi50aHJlYWRJZCwgbWF0Y2hbMF0pO1xuXHRcdFx0XHRcdHByb2Nlc3NlZCsrO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXHRcdFx0XHRzdG9yYWdlLmZhaWxTdGFnZTFKb2Ioam9iLnRocmVhZElkLCBcIkxMTSBvdXRwdXQgaXMgbm90IHZhbGlkIEpTT05cIik7XG5cdFx0XHRcdGVycm9ycysrO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdHN0b3JhZ2UuY29tcGxldGVTdGFnZTFKb2Ioam9iLnRocmVhZElkLCByZWRhY3RlZCk7XG5cdFx0XHRwcm9jZXNzZWQrKztcblx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG5cdFx0XHRzdG9yYWdlLmZhaWxTdGFnZTFKb2Ioam9iLnRocmVhZElkLCBtZXNzYWdlKTtcblx0XHRcdGVycm9ycysrO1xuXHRcdH1cblx0fSkpO1xuXG5cdGF3YWl0IFByb21pc2UuYWxsKHByb21pc2VzKTtcblx0cmV0dXJuIHsgcHJvY2Vzc2VkLCBlcnJvcnMgfTtcbn1cblxuLyoqXG4gKiBSdW4gUGhhc2UgMjogQ29uc29saWRhdGUgYWxsIHN0YWdlMSBvdXRwdXRzIGludG8gTUVNT1JZLm1kLlxuICovXG5hc3luYyBmdW5jdGlvbiBydW5QaGFzZTIoXG5cdHN0b3JhZ2U6IE1lbW9yeVN0b3JhZ2UsXG5cdGNvbmZpZzogUGlwZWxpbmVDb25maWcsXG5cdGxsbUNhbGw6IExMTUNhbGxGbixcblx0d29ya2VySWQ6IHN0cmluZyxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuXHRjb25zdCBwaGFzZTIgPSBzdG9yYWdlLnRyeUNsYWltR2xvYmFsUGhhc2UySm9iKHdvcmtlcklkLCA2MDApO1xuXHRpZiAoIXBoYXNlMikge1xuXHRcdHJldHVybiBmYWxzZTtcblx0fVxuXG5cdHRyeSB7XG5cdFx0Y29uc3Qgb3V0cHV0cyA9IHN0b3JhZ2UuZ2V0U3RhZ2UxT3V0cHV0c0ZvckN3ZChjb25maWcuY3dkKTtcblx0XHRpZiAob3V0cHV0cy5sZW5ndGggPT09IDApIHtcblx0XHRcdHN0b3JhZ2UuY29tcGxldGVQaGFzZTJKb2IocGhhc2UyLmpvYklkKTtcblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH1cblxuXHRcdC8vIENvbGxlY3QgYWxsIG1lbW9yaWVzXG5cdFx0Y29uc3QgYWxsTWVtb3JpZXM6IHVua25vd25bXSA9IFtdO1xuXHRcdGZvciAoY29uc3Qgb3V0cHV0IG9mIG91dHB1dHMpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IG1lbW9yaWVzID0gSlNPTi5wYXJzZShvdXRwdXQuZXh0cmFjdGlvbkpzb24pO1xuXHRcdFx0XHRpZiAoQXJyYXkuaXNBcnJheShtZW1vcmllcykpIHtcblx0XHRcdFx0XHRhbGxNZW1vcmllcy5wdXNoKC4uLm1lbW9yaWVzKTtcblx0XHRcdFx0fVxuXHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdC8vIFNraXAgbWFsZm9ybWVkIG91dHB1dHNcblx0XHRcdH1cblx0XHR9XG5cblx0XHRpZiAoYWxsTWVtb3JpZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHQvLyBXcml0ZSBlbXB0eSBtZW1vcnkgZmlsZXNcblx0XHRcdGlmICghZXhpc3RzU3luYyhjb25maWcubWVtb3J5RGlyKSkge1xuXHRcdFx0XHRta2RpclN5bmMoY29uZmlnLm1lbW9yeURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdFx0XHR9XG5cdFx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oY29uZmlnLm1lbW9yeURpciwgXCJNRU1PUlkubWRcIiksIFwiIyBQcm9qZWN0IE1lbW9yeVxcblxcbk5vIG1lbW9yaWVzIGV4dHJhY3RlZCB5ZXQuXFxuXCIpO1xuXHRcdFx0d3JpdGVGaWxlU3luYyhqb2luKGNvbmZpZy5tZW1vcnlEaXIsIFwibWVtb3J5X3N1bW1hcnkubWRcIiksIFwiXCIpO1xuXHRcdFx0c3RvcmFnZS5jb21wbGV0ZVBoYXNlMkpvYihwaGFzZTIuam9iSWQpO1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fVxuXG5cdFx0Ly8gU2F2ZSByYXcgbWVtb3JpZXNcblx0XHRpZiAoIWV4aXN0c1N5bmMoY29uZmlnLm1lbW9yeURpcikpIHtcblx0XHRcdG1rZGlyU3luYyhjb25maWcubWVtb3J5RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHR9XG5cdFx0d3JpdGVGaWxlU3luYyhcblx0XHRcdGpvaW4oY29uZmlnLm1lbW9yeURpciwgXCJyYXdfbWVtb3JpZXMubWRcIiksXG5cdFx0XHRgIyBSYXcgRXh0cmFjdGVkIE1lbW9yaWVzXFxuXFxuXFxgXFxgXFxganNvblxcbiR7SlNPTi5zdHJpbmdpZnkoYWxsTWVtb3JpZXMsIG51bGwsIDIpfVxcblxcYFxcYFxcYFxcbmAsXG5cdFx0KTtcblxuXHRcdC8vIENhbGwgTExNIGZvciBjb25zb2xpZGF0aW9uXG5cdFx0Y29uc3QgY29uc29saWRhdGlvblByb21wdCA9IGdldFByb21wdChcImNvbnNvbGlkYXRpb25cIikucmVwbGFjZShcblx0XHRcdFwie3ttZW1vcmllc19qc29ufX1cIixcblx0XHRcdEpTT04uc3RyaW5naWZ5KGFsbE1lbW9yaWVzLCBudWxsLCAyKSxcblx0XHQpO1xuXG5cdFx0Y29uc3QgY29uc29saWRhdGVkTWVtb3J5ID0gYXdhaXQgbGxtQ2FsbChcblx0XHRcdFwiWW91IGFyZSBhIG1lbW9yeSBjb25zb2xpZGF0aW9uIGFnZW50LiBNZXJnZSB0aGUgZXh0cmFjdGVkIG1lbW9yaWVzIGludG8gYSBjbGVhbiwgb3JnYW5pemVkIG1hcmtkb3duIGRvY3VtZW50LlwiLFxuXHRcdFx0Y29uc29saWRhdGlvblByb21wdCxcblx0XHRcdHsgbWF4VG9rZW5zOiA4MTkyIH0sXG5cdFx0KTtcblxuXHRcdGNvbnN0IHJlZGFjdGVkTWVtb3J5ID0gcmVkYWN0U2VjcmV0cyhjb25zb2xpZGF0ZWRNZW1vcnkpO1xuXG5cdFx0Ly8gV3JpdGUgTUVNT1JZLm1kXG5cdFx0d3JpdGVGaWxlU3luYyhqb2luKGNvbmZpZy5tZW1vcnlEaXIsIFwiTUVNT1JZLm1kXCIpLCByZWRhY3RlZE1lbW9yeSk7XG5cblx0XHQvLyBXcml0ZSBtZW1vcnlfc3VtbWFyeS5tZCAodHJ1bmNhdGVkIHZlcnNpb24gZm9yIGluamVjdGlvbilcblx0XHRjb25zdCBzdW1tYXJ5TGluZXMgPSByZWRhY3RlZE1lbW9yeS5zcGxpdChcIlxcblwiKS5zbGljZSgwLCAxMDApO1xuXHRcdGNvbnN0IHN1bW1hcnkgPSBzdW1tYXJ5TGluZXMuam9pbihcIlxcblwiKTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oY29uZmlnLm1lbW9yeURpciwgXCJtZW1vcnlfc3VtbWFyeS5tZFwiKSwgc3VtbWFyeSk7XG5cblx0XHRzdG9yYWdlLmNvbXBsZXRlUGhhc2UySm9iKHBoYXNlMi5qb2JJZCk7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH0gY2F0Y2ggKGVycikge1xuXHRcdC8vIFBoYXNlIDIgZmFpbGVkIC0gam9iIHdpbGwgZXhwaXJlIGFuZCBjYW4gYmUgcmV0cmllZFxuXHRcdHJldHVybiBmYWxzZTtcblx0fVxufVxuXG4vKipcbiAqIFJ1biB0aGUgZnVsbCBwaXBlbGluZSBzdGFydHVwIHNlcXVlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuU3RhcnR1cChcblx0c3RvcmFnZTogTWVtb3J5U3RvcmFnZSxcblx0Y29uZmlnOiBQaXBlbGluZUNvbmZpZyxcblx0bGxtQ2FsbDogTExNQ2FsbEZuLFxuKTogUHJvbWlzZTx7IHBoYXNlMTogeyBwcm9jZXNzZWQ6IG51bWJlcjsgZXJyb3JzOiBudW1iZXIgfTsgcGhhc2UyOiBib29sZWFuIH0+IHtcblx0Y29uc3Qgd29ya2VySWQgPSBgd29ya2VyLSR7RGF0ZS5ub3coKX1gO1xuXG5cdC8vIFN0ZXAgMTogU2NhbiBzZXNzaW9ucyBhbmQgdXBzZXJ0IHRocmVhZHNcblx0Y29uc3Qgc2Vzc2lvbkZpbGVzID0gYXdhaXQgc2NhblNlc3Npb25GaWxlcyhjb25maWcuc2Vzc2lvbnNEaXIsIGNvbmZpZy5jd2QpO1xuXG5cdC8vIEFwcGx5IGFnZSBhbmQgaWRsZSBmaWx0ZXJzXG5cdGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG5cdGNvbnN0IG1heEFnZU1zID0gY29uZmlnLm1heFJvbGxvdXRBZ2VEYXlzICogMjQgKiA2MCAqIDYwICogMTAwMDtcblx0Y29uc3QgbWluSWRsZU1zID0gY29uZmlnLm1pblJvbGxvdXRJZGxlSG91cnMgKiA2MCAqIDYwICogMTAwMDtcblxuXHRjb25zdCBlbGlnaWJsZSA9IHNlc3Npb25GaWxlc1xuXHRcdC5maWx0ZXIoKGYpID0+IHtcblx0XHRcdGNvbnN0IGFnZSA9IG5vdyAtIGYuZmlsZU10aW1lO1xuXHRcdFx0cmV0dXJuIGFnZSA8PSBtYXhBZ2VNcyAmJiBhZ2UgPj0gbWluSWRsZU1zO1xuXHRcdH0pXG5cdFx0LnNsaWNlKDAsIGNvbmZpZy5tYXhSb2xsb3V0c1BlclN0YXJ0dXApO1xuXG5cdGlmIChlbGlnaWJsZS5sZW5ndGggPiAwKSB7XG5cdFx0c3RvcmFnZS51cHNlcnRUaHJlYWRzKFxuXHRcdFx0ZWxpZ2libGUubWFwKChmKSA9PiAoe1xuXHRcdFx0XHR0aHJlYWRJZDogZi50aHJlYWRJZCxcblx0XHRcdFx0ZmlsZVBhdGg6IGYuZmlsZVBhdGgsXG5cdFx0XHRcdGZpbGVTaXplOiBmLmZpbGVTaXplLFxuXHRcdFx0XHRmaWxlTXRpbWU6IGYuZmlsZU10aW1lLFxuXHRcdFx0XHRjd2Q6IGNvbmZpZy5jd2QsXG5cdFx0XHR9KSksXG5cdFx0KTtcblx0fVxuXG5cdC8vIFN0ZXAgMjogUnVuIFBoYXNlIDFcblx0Y29uc3QgcGhhc2UxUmVzdWx0ID0gYXdhaXQgcnVuUGhhc2UxKHN0b3JhZ2UsIGNvbmZpZywgbGxtQ2FsbCwgd29ya2VySWQpO1xuXG5cdC8vIFN0ZXAgMzogUnVuIFBoYXNlIDIgKG9ubHkgaWYgcGhhc2UgMSBkaWQgd29yaylcblx0bGV0IHBoYXNlMlJlc3VsdCA9IGZhbHNlO1xuXHRpZiAocGhhc2UxUmVzdWx0LnByb2Nlc3NlZCA+IDApIHtcblx0XHRwaGFzZTJSZXN1bHQgPSBhd2FpdCBydW5QaGFzZTIoc3RvcmFnZSwgY29uZmlnLCBsbG1DYWxsLCB3b3JrZXJJZCk7XG5cdH1cblxuXHRyZXR1cm4geyBwaGFzZTE6IHBoYXNlMVJlc3VsdCwgcGhhc2UyOiBwaGFzZTJSZXN1bHQgfTtcbn1cblxuLyoqXG4gKiBHZXQgdGhlIG1lbW9yeSBzdW1tYXJ5IGZvciBpbmplY3Rpb24gaW50byB0aGUgc3lzdGVtIHByb21wdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldE1lbW9yeVN1bW1hcnkobWVtb3J5RGlyOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcblx0Y29uc3Qgc3VtbWFyeVBhdGggPSBqb2luKG1lbW9yeURpciwgXCJtZW1vcnlfc3VtbWFyeS5tZFwiKTtcblx0aWYgKCFleGlzdHNTeW5jKHN1bW1hcnlQYXRoKSkge1xuXHRcdHJldHVybiBudWxsO1xuXHR9XG5cblx0dHJ5IHtcblx0XHRjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKHN1bW1hcnlQYXRoLCBcInV0Zi04XCIpLnRyaW0oKTtcblx0XHRpZiAoIWNvbnRlbnQpIHtcblx0XHRcdHJldHVybiBudWxsO1xuXHRcdH1cblxuXHRcdGNvbnN0IHJlYWRQYXRoVGVtcGxhdGUgPSBnZXRQcm9tcHQoXCJyZWFkLXBhdGhcIik7XG5cdFx0cmV0dXJuIHJlYWRQYXRoVGVtcGxhdGUucmVwbGFjZShcInt7bWVtb3J5X2NvbnRlbnR9fVwiLCBjb250ZW50KTtcblx0fSBjYXRjaCB7XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cbn1cblxuLyoqXG4gKiBHZXQgdGhlIGZ1bGwgTUVNT1JZLm1kIGNvbnRlbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRGdWxsTWVtb3J5KG1lbW9yeURpcjogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG5cdGNvbnN0IG1lbW9yeVBhdGggPSBqb2luKG1lbW9yeURpciwgXCJNRU1PUlkubWRcIik7XG5cdGlmICghZXhpc3RzU3luYyhtZW1vcnlQYXRoKSkge1xuXHRcdHJldHVybiBudWxsO1xuXHR9XG5cblx0dHJ5IHtcblx0XHRyZXR1cm4gcmVhZEZpbGVTeW5jKG1lbW9yeVBhdGgsIFwidXRmLThcIik7XG5cdH0gY2F0Y2gge1xuXHRcdHJldHVybiBudWxsO1xuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFRQSxTQUFTLGtCQUFrQixZQUFZLFdBQVcsY0FBYyxhQUFhLFVBQVUscUJBQXFCO0FBQzVHLFNBQVMsWUFBWTtBQUNyQixTQUFTLHVCQUF1QjtBQUloQyxTQUFTLE9BQU8sYUFBcUI7QUFDcEMsUUFBTSxRQUF3QixDQUFDO0FBQy9CLE1BQUksU0FBUztBQUNiLFNBQU8sQ0FBSSxPQUFxQztBQUMvQyxXQUFPLElBQUksUUFBVyxDQUFDLFNBQVMsV0FBVztBQUMxQyxZQUFNLE1BQU0sTUFBTTtBQUNqQjtBQUNBLFdBQUcsRUFBRSxLQUFLLFNBQVMsTUFBTSxFQUFFLFFBQVEsTUFBTTtBQUN4QztBQUNBLGNBQUksTUFBTSxTQUFTLEVBQUcsT0FBTSxNQUFNLEVBQUc7QUFBQSxRQUN0QyxDQUFDO0FBQUEsTUFDRjtBQUNBLFVBQUksU0FBUyxZQUFhLEtBQUk7QUFBQSxVQUN6QixPQUFNLEtBQUssR0FBRztBQUFBLElBQ3BCLENBQUM7QUFBQSxFQUNGO0FBQ0Q7QUFHQSxNQUFNLHdCQUF3QixLQUFLLE9BQU87QUFHMUMsTUFBTSxrQkFBa0I7QUFBQTtBQUFBLEVBRXZCO0FBQUE7QUFBQSxFQUVBO0FBQUE7QUFBQSxFQUVBO0FBQUE7QUFBQSxFQUVBO0FBQUE7QUFBQSxFQUVBO0FBQUE7QUFBQSxFQUVBO0FBQUE7QUFBQSxFQUVBO0FBQUE7QUFBQSxFQUVBO0FBQUE7QUFBQSxFQUVBO0FBQUE7QUFBQSxFQUVBO0FBQ0Q7QUFFQSxTQUFTLGNBQWMsTUFBc0I7QUFDNUMsTUFBSSxTQUFTO0FB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
