import { completeSimple } from "@gsd/pi-ai";
import { COMPACTION_KEEP_RECENT_TOKENS, COMPACTION_RESERVE_TOKENS } from "../constants.js";
import { convertToLlm } from "../messages.js";
import {
  collectMessages,
  computeFileLists,
  createFileOps,
  createSummarizationMessage,
  estimateSerializedTokens,
  extractFileOpsFromMessage,
  extractTextContent,
  formatFileOperations,
  SUMMARIZATION_SYSTEM_PROMPT,
  serializeConversation
} from "./utils.js";
function extractFileOperations(messages, entries, prevCompactionIndex) {
  const fileOps = createFileOps();
  if (prevCompactionIndex >= 0) {
    const prevCompaction = entries[prevCompactionIndex];
    if (!prevCompaction.fromHook && prevCompaction.details) {
      const details = prevCompaction.details;
      if (Array.isArray(details.readFiles)) {
        for (const f of details.readFiles) fileOps.read.add(f);
      }
      if (Array.isArray(details.modifiedFiles)) {
        for (const f of details.modifiedFiles) fileOps.edited.add(f);
      }
    }
  }
  for (const msg of messages) {
    extractFileOpsFromMessage(msg, fileOps);
  }
  return fileOps;
}
const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: COMPACTION_RESERVE_TOKENS,
  keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS
};
function calculateContextTokens(usage) {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(msg) {
  if (msg.role === "assistant" && "usage" in msg) {
    const assistantMsg = msg;
    if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
      return assistantMsg.usage;
    }
  }
  return void 0;
}
function getLastAssistantUsage(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message") {
      const usage = getAssistantUsage(entry.message);
      if (usage) return usage;
    }
  }
  return void 0;
}
function getLastAssistantUsageInfo(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (usage) return { usage, index: i };
  }
  return void 0;
}
function estimateContextTokens(messages) {
  const usageInfo = getLastAssistantUsageInfo(messages);
  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) {
      estimated += estimateTokens(message);
    }
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null
    };
  }
  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i]);
  }
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index
  };
}
function shouldCompact(contextTokens, contextWindow, settings) {
  if (!settings.enabled) return false;
  if (settings.thresholdPercent !== void 0 && settings.thresholdPercent > 0 && settings.thresholdPercent < 1) {
    return contextTokens > contextWindow * settings.thresholdPercent;
  }
  return contextTokens > contextWindow - settings.reserveTokens;
}
function estimateTokens(message) {
  let chars = 0;
  switch (message.role) {
    case "user": {
      const content = message.content;
      if (typeof content === "string") {
        chars = content.length;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            chars += block.text.length;
          }
        }
      }
      return Math.ceil(chars / 4);
    }
    case "assistant": {
      const assistant = message;
      for (const block of assistant.content) {
        if (block.type === "text") {
          chars += block.text.length;
        } else if (block.type === "thinking") {
          chars += block.thinking.length;
        } else if (block.type === "toolCall") {
          chars += block.name.length + JSON.stringify(block.arguments).length;
        }
      }
      return Math.ceil(chars / 4);
    }
    case "custom":
    case "toolResult": {
      if (typeof message.content === "string") {
        chars = message.content.length;
      } else {
        for (const block of message.content) {
          if (block.type === "text" && block.text) {
            chars += block.text.length;
          }
          if (block.type === "image") {
            chars += 4800;
          }
        }
      }
      return Math.ceil(chars / 4);
    }
    case "bashExecution": {
      chars = message.command.length + message.output.length;
      return Math.ceil(chars / 4);
    }
    case "branchSummary":
    case "compactionSummary": {
      chars = message.summary.length;
      return Math.ceil(chars / 4);
    }
  }
  return 0;
}
function findValidCutPoints(entries, startIndex, endIndex) {
  const cutPoints = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    switch (entry.type) {
      case "message": {
        const role = entry.message.role;
        switch (role) {
          case "bashExecution":
          case "custom":
          case "branchSummary":
          case "compactionSummary":
          case "user":
          case "assistant":
            cutPoints.push(i);
            break;
          case "toolResult":
            break;
        }
        break;
      }
      case "thinking_level_change":
      case "model_change":
      case "compaction":
      case "branch_summary":
      case "custom":
      case "custom_message":
      case "label":
    }
    if (entry.type === "branch_summary" || entry.type === "custom_message") {
      cutPoints.push(i);
    }
  }
  return cutPoints;
}
function findTurnStartIndex(entries, entryIndex, startIndex) {
  for (let i = entryIndex; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type === "branch_summary" || entry.type === "custom_message") {
      return i;
    }
    if (entry.type === "message") {
      const role = entry.message.role;
      if (role === "user" || role === "bashExecution") {
        return i;
      }
    }
  }
  return -1;
}
function findCutPoint(entries, startIndex, endIndex, keepRecentTokens) {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }
  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0];
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const messageTokens = estimateTokens(entry.message);
    accumulatedTokens += messageTokens;
    if (accumulatedTokens >= keepRecentTokens) {
      for (let c = 0; c < cutPoints.length; c++) {
        if (cutPoints[c] >= i) {
          cutIndex = cutPoints[c];
          break;
        }
      }
      break;
    }
  }
  while (cutIndex > startIndex) {
    const prevEntry = entries[cutIndex - 1];
    if (prevEntry.type === "compaction") {
      break;
    }
    if (prevEntry.type === "message") {
      break;
    }
    cutIndex--;
  }
  const cutEntry = entries[cutIndex];
  const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
  const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1
  };
}
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
function chunkMessages(messages, maxTokensPerChunk) {
  const chunks = [];
  let currentChunk = [];
  let currentTokens = 0;
  for (const msg of messages) {
    const msgTokens = estimateSerializedTokens(msg);
    if (currentChunk.length > 0 && currentTokens + msgTokens > maxTokensPerChunk) {
      chunks.push(currentChunk);
      currentChunk = [msg];
      currentTokens = msgTokens;
    } else {
      currentChunk.push(msg);
      currentTokens += msgTokens;
    }
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  return chunks;
}
function isDegenerateSummary(summary) {
  if (summary === void 0) return false;
  const lower = summary.toLowerCase();
  if (lower.includes("empty conversation")) return true;
  if (lower.includes("no conversation to summarize")) return true;
  if (lower.includes("no messages to summarize")) return true;
  if (summary.trim().length < 100) return true;
  return false;
}
async function generateSummary(currentMessages, model, reserveTokens, apiKey, signal, customInstructions, previousSummary, _completeFn) {
  const complete = _completeFn ?? completeSimple;
  let totalTokens = 0;
  for (const msg of currentMessages) {
    totalTokens += estimateSerializedTokens(msg);
  }
  const promptOverhead = 4e3;
  const maxTokens = Math.floor(0.8 * reserveTokens);
  const maxInputTokens = (model.contextWindow || 2e5) - reserveTokens - promptOverhead;
  if (totalTokens <= maxInputTokens) {
    return singlePassSummary(currentMessages, model, reserveTokens, apiKey, signal, customInstructions, previousSummary, complete);
  }
  const chunks = chunkMessages(currentMessages, maxInputTokens);
  let runningSummary = previousSummary;
  for (let i = 0; i < chunks.length; i++) {
    const chunkSummary = await singlePassSummary(
      chunks[i],
      model,
      reserveTokens,
      apiKey,
      signal,
      customInstructions,
      runningSummary,
      complete
    );
    if (isDegenerateSummary(chunkSummary)) {
      const retryPreviousSummary = i === 0 && runningSummary === void 0 ? void 0 : runningSummary;
      const retry = await singlePassSummary(
        chunks[i],
        model,
        reserveTokens,
        apiKey,
        signal,
        customInstructions,
        retryPreviousSummary,
        complete
      );
      if (!isDegenerateSummary(retry)) {
        runningSummary = retry;
        continue;
      }
      process.stderr.write(
        `[compaction] WARN: chunk ${i + 1}/${chunks.length} produced a degenerate summary on both attempts; dropping chunk content from summary.
`
      );
      continue;
    }
    runningSummary = chunkSummary;
  }
  if (runningSummary === void 0) {
    if (previousSummary !== void 0) {
      process.stderr.write(
        "[compaction] WARN: every chunk produced a degenerate summary; falling back to existing previousSummary.\n"
      );
      return previousSummary;
    }
    throw new CompactionProducedNoSummaryError(
      `Compaction produced no usable summary: all ${chunks.length} chunk(s) were degenerate and no previousSummary was available.`
    );
  }
  return runningSummary;
}
class CompactionProducedNoSummaryError extends Error {
  constructor(message) {
    super(message);
    this.name = "CompactionProducedNoSummaryError";
  }
}
async function singlePassSummary(currentMessages, model, reserveTokens, apiKey, signal, customInstructions, previousSummary, complete = completeSimple) {
  const maxTokens = Math.floor(0.8 * reserveTokens);
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}

Additional focus: ${customInstructions}`;
  }
  const llmMessages = convertToLlm(currentMessages);
  const conversationText = serializeConversation(llmMessages);
  let promptText = `<conversation>
${conversationText}
</conversation>

`;
  if (previousSummary) {
    promptText += `<previous-summary>
${previousSummary}
</previous-summary>

`;
  }
  promptText += basePrompt;
  const completionOptions = model.reasoning ? { maxTokens, signal, apiKey, reasoning: "high" } : { maxTokens, signal, apiKey };
  const response = await complete(
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: createSummarizationMessage(promptText) },
    completionOptions
  );
  if (response.stopReason === "error") {
    throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  return extractTextContent(response.content);
}
function prepareCompaction(pathEntries, settings) {
  if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
    return void 0;
  }
  let prevCompactionIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    if (pathEntries[i].type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }
  const boundaryStart = prevCompactionIndex + 1;
  const boundaryEnd = pathEntries.length;
  const usageStart = prevCompactionIndex >= 0 ? prevCompactionIndex : 0;
  const usageMessages = collectMessages(pathEntries, usageStart, boundaryEnd);
  const tokensBefore = estimateContextTokens(usageMessages).tokens;
  const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
  const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) {
    return void 0;
  }
  const firstKeptEntryId = firstKeptEntry.id;
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const messagesToSummarize = collectMessages(pathEntries, boundaryStart, historyEnd);
  const turnPrefixMessages = cutPoint.isSplitTurn ? collectMessages(pathEntries, cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex) : [];
  let previousSummary;
  if (prevCompactionIndex >= 0) {
    const prevCompaction = pathEntries[prevCompactionIndex];
    previousSummary = prevCompaction.summary;
  }
  const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
  if (cutPoint.isSplitTurn) {
    for (const msg of turnPrefixMessages) {
      extractFileOpsFromMessage(msg, fileOps);
    }
  }
  return {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings
  };
}
const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;
async function compact(preparation, model, apiKey, customInstructions, signal) {
  const {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings
  } = preparation;
  let summary;
  if (isSplitTurn && turnPrefixMessages.length > 0) {
    const [historyResult, turnPrefixResult] = await Promise.all([
      messagesToSummarize.length > 0 ? generateSummary(
        messagesToSummarize,
        model,
        settings.reserveTokens,
        apiKey,
        signal,
        customInstructions,
        previousSummary
      ) : Promise.resolve("No prior history."),
      generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, signal)
    ]);
    summary = `${historyResult}

---

**Turn Context (split turn):**

${turnPrefixResult}`;
  } else {
    summary = await generateSummary(
      messagesToSummarize,
      model,
      settings.reserveTokens,
      apiKey,
      signal,
      customInstructions,
      previousSummary
    );
  }
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);
  if (!firstKeptEntryId) {
    throw new Error("First kept entry has no UUID - session may need migration");
  }
  return {
    summary,
    firstKeptEntryId,
    tokensBefore,
    details: { readFiles, modifiedFiles }
  };
}
async function generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, signal) {
  const maxTokens = Math.floor(0.5 * reserveTokens);
  const llmMessages = convertToLlm(messages);
  const conversationText = serializeConversation(llmMessages);
  const promptText = `<conversation>
${conversationText}
</conversation>

${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  const response = await completeSimple(
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: createSummarizationMessage(promptText) },
    { maxTokens, signal, apiKey }
  );
  if (response.stopReason === "error") {
    throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
  }
  return extractTextContent(response.content);
}
export {
  CompactionProducedNoSummaryError,
  DEFAULT_COMPACTION_SETTINGS,
  calculateContextTokens,
  chunkMessages,
  compact,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  generateSummary,
  getLastAssistantUsage,
  isDegenerateSummary,
  prepareCompaction,
  shouldCompact
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2NvbXBhY3Rpb24vY29tcGFjdGlvbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBDb250ZXh0IGNvbXBhY3Rpb24gZm9yIGxvbmcgc2Vzc2lvbnMuXG4gKlxuICogUHVyZSBmdW5jdGlvbnMgZm9yIGNvbXBhY3Rpb24gbG9naWMuIFRoZSBzZXNzaW9uIG1hbmFnZXIgaGFuZGxlcyBJL08sXG4gKiBhbmQgYWZ0ZXIgY29tcGFjdGlvbiB0aGUgc2Vzc2lvbiBpcyByZWxvYWRlZC5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEFnZW50TWVzc2FnZSB9IGZyb20gXCJAZ3NkL3BpLWFnZW50LWNvcmVcIjtcbmltcG9ydCB0eXBlIHsgQXNzaXN0YW50TWVzc2FnZSwgTW9kZWwsIFVzYWdlIH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB7IGNvbXBsZXRlU2ltcGxlIH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB7IENPTVBBQ1RJT05fS0VFUF9SRUNFTlRfVE9LRU5TLCBDT01QQUNUSU9OX1JFU0VSVkVfVE9LRU5TIH0gZnJvbSBcIi4uL2NvbnN0YW50cy5qc1wiO1xuaW1wb3J0IHsgY29udmVydFRvTGxtIH0gZnJvbSBcIi4uL21lc3NhZ2VzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IENvbXBhY3Rpb25FbnRyeSwgU2Vzc2lvbkVudHJ5IH0gZnJvbSBcIi4uL3Nlc3Npb24tbWFuYWdlci5qc1wiO1xuaW1wb3J0IHtcblx0Y29sbGVjdE1lc3NhZ2VzLFxuXHRjb21wdXRlRmlsZUxpc3RzLFxuXHRjcmVhdGVGaWxlT3BzLFxuXHRjcmVhdGVTdW1tYXJpemF0aW9uTWVzc2FnZSxcblx0ZXN0aW1hdGVTZXJpYWxpemVkVG9rZW5zLFxuXHRleHRyYWN0RmlsZU9wc0Zyb21NZXNzYWdlLFxuXHRleHRyYWN0VGV4dENvbnRlbnQsXG5cdHR5cGUgRmlsZU9wZXJhdGlvbnMsXG5cdGZvcm1hdEZpbGVPcGVyYXRpb25zLFxuXHRnZXRNZXNzYWdlRnJvbUVudHJ5LFxuXHRTVU1NQVJJWkFUSU9OX1NZU1RFTV9QUk9NUFQsXG5cdHNlcmlhbGl6ZUNvbnZlcnNhdGlvbixcbn0gZnJvbSBcIi4vdXRpbHMuanNcIjtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gRmlsZSBPcGVyYXRpb24gVHJhY2tpbmdcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqIERldGFpbHMgc3RvcmVkIGluIENvbXBhY3Rpb25FbnRyeS5kZXRhaWxzIGZvciBmaWxlIHRyYWNraW5nICovXG5leHBvcnQgaW50ZXJmYWNlIENvbXBhY3Rpb25EZXRhaWxzIHtcblx0cmVhZEZpbGVzOiBzdHJpbmdbXTtcblx0bW9kaWZpZWRGaWxlczogc3RyaW5nW107XG59XG5cbi8qKlxuICogRXh0cmFjdCBmaWxlIG9wZXJhdGlvbnMgZnJvbSBtZXNzYWdlcyBhbmQgcHJldmlvdXMgY29tcGFjdGlvbiBlbnRyaWVzLlxuICovXG5mdW5jdGlvbiBleHRyYWN0RmlsZU9wZXJhdGlvbnMoXG5cdG1lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSxcblx0ZW50cmllczogU2Vzc2lvbkVudHJ5W10sXG5cdHByZXZDb21wYWN0aW9uSW5kZXg6IG51bWJlcixcbik6IEZpbGVPcGVyYXRpb25zIHtcblx0Y29uc3QgZmlsZU9wcyA9IGNyZWF0ZUZpbGVPcHMoKTtcblxuXHQvLyBDb2xsZWN0IGZyb20gcHJldmlvdXMgY29tcGFjdGlvbidzIGRldGFpbHMgKGlmIHBpLWdlbmVyYXRlZClcblx0aWYgKHByZXZDb21wYWN0aW9uSW5kZXggPj0gMCkge1xuXHRcdGNvbnN0IHByZXZDb21wYWN0aW9uID0gZW50cmllc1twcmV2Q29tcGFjdGlvbkluZGV4XSBhcyBDb21wYWN0aW9uRW50cnk7XG5cdFx0aWYgKCFwcmV2Q29tcGFjdGlvbi5mcm9tSG9vayAmJiBwcmV2Q29tcGFjdGlvbi5kZXRhaWxzKSB7XG5cdFx0XHQvLyBmcm9tSG9vayBmaWVsZCBrZXB0IGZvciBzZXNzaW9uIGZpbGUgY29tcGF0aWJpbGl0eVxuXHRcdFx0Y29uc3QgZGV0YWlscyA9IHByZXZDb21wYWN0aW9uLmRldGFpbHMgYXMgQ29tcGFjdGlvbkRldGFpbHM7XG5cdFx0XHRpZiAoQXJyYXkuaXNBcnJheShkZXRhaWxzLnJlYWRGaWxlcykpIHtcblx0XHRcdFx0Zm9yIChjb25zdCBmIG9mIGRldGFpbHMucmVhZEZpbGVzKSBmaWxlT3BzLnJlYWQuYWRkKGYpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKEFycmF5LmlzQXJyYXkoZGV0YWlscy5tb2RpZmllZEZpbGVzKSkge1xuXHRcdFx0XHRmb3IgKGNvbnN0IGYgb2YgZGV0YWlscy5tb2RpZmllZEZpbGVzKSBmaWxlT3BzLmVkaXRlZC5hZGQoZik7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0Ly8gRXh0cmFjdCBmcm9tIHRvb2wgY2FsbHMgaW4gbWVzc2FnZXNcblx0Zm9yIChjb25zdCBtc2cgb2YgbWVzc2FnZXMpIHtcblx0XHRleHRyYWN0RmlsZU9wc0Zyb21NZXNzYWdlKG1zZywgZmlsZU9wcyk7XG5cdH1cblxuXHRyZXR1cm4gZmlsZU9wcztcbn1cblxuLyoqIFJlc3VsdCBmcm9tIGNvbXBhY3QoKSAtIFNlc3Npb25NYW5hZ2VyIGFkZHMgdXVpZC9wYXJlbnRVdWlkIHdoZW4gc2F2aW5nICovXG5leHBvcnQgaW50ZXJmYWNlIENvbXBhY3Rpb25SZXN1bHQ8VCA9IHVua25vd24+IHtcblx0c3VtbWFyeTogc3RyaW5nO1xuXHRmaXJzdEtlcHRFbnRyeUlkOiBzdHJpbmc7XG5cdHRva2Vuc0JlZm9yZTogbnVtYmVyO1xuXHQvKiogRXh0ZW5zaW9uLXNwZWNpZmljIGRhdGEgKGUuZy4sIEFydGlmYWN0SW5kZXgsIHZlcnNpb24gbWFya2VycyBmb3Igc3RydWN0dXJlZCBjb21wYWN0aW9uKSAqL1xuXHRkZXRhaWxzPzogVDtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gVHlwZXNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGludGVyZmFjZSBDb21wYWN0aW9uU2V0dGluZ3Mge1xuXHRlbmFibGVkOiBib29sZWFuO1xuXHRyZXNlcnZlVG9rZW5zOiBudW1iZXI7XG5cdGtlZXBSZWNlbnRUb2tlbnM6IG51bWJlcjtcblx0LyoqXG5cdCAqIE9wdGlvbmFsIHBlcmNlbnQtb2YtY29udGV4dC13aW5kb3cgdGhyZXNob2xkICgwIDwgdmFsdWUgPCAxKS4gV2hlbiBzZXQsXG5cdCAqIGBzaG91bGRDb21wYWN0KClgIGZpcmVzIG9uY2UgYGNvbnRleHRUb2tlbnMgPiBjb250ZXh0V2luZG93ICogdGhyZXNob2xkUGVyY2VudGAsXG5cdCAqIG92ZXJyaWRpbmcgdGhlIGFic29sdXRlIGByZXNlcnZlVG9rZW5zYCBjYWxjdWxhdGlvbi4gTGV0cyBob3N0IGludGVncmF0aW9uc1xuXHQgKiAoZS5nLiBHU0QpIGV4cHJlc3MgY29tcGFjdGlvbiBwb2xpY3kgYXMgYSBmcmFjdGlvbiBpbmRlcGVuZGVudCBvZiBtb2RlbCBzaXplLlxuXHQgKi9cblx0dGhyZXNob2xkUGVyY2VudD86IG51bWJlcjtcbn1cblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfQ09NUEFDVElPTl9TRVRUSU5HUzogQ29tcGFjdGlvblNldHRpbmdzID0ge1xuXHRlbmFibGVkOiB0cnVlLFxuXHRyZXNlcnZlVG9rZW5zOiBDT01QQUNUSU9OX1JFU0VSVkVfVE9LRU5TLFxuXHRrZWVwUmVjZW50VG9rZW5zOiBDT01QQUNUSU9OX0tFRVBfUkVDRU5UX1RPS0VOUyxcbn07XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFRva2VuIGNhbGN1bGF0aW9uXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogQ2FsY3VsYXRlIHRvdGFsIGNvbnRleHQgdG9rZW5zIGZyb20gdXNhZ2UuXG4gKiBVc2VzIHRoZSBuYXRpdmUgdG90YWxUb2tlbnMgZmllbGQgd2hlbiBhdmFpbGFibGUsIGZhbGxzIGJhY2sgdG8gY29tcHV0aW5nIGZyb20gY29tcG9uZW50cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhbGN1bGF0ZUNvbnRleHRUb2tlbnModXNhZ2U6IFVzYWdlKTogbnVtYmVyIHtcblx0cmV0dXJuIHVzYWdlLnRvdGFsVG9rZW5zIHx8IHVzYWdlLmlucHV0ICsgdXNhZ2Uub3V0cHV0ICsgdXNhZ2UuY2FjaGVSZWFkICsgdXNhZ2UuY2FjaGVXcml0ZTtcbn1cblxuLyoqXG4gKiBHZXQgdXNhZ2UgZnJvbSBhbiBhc3Npc3RhbnQgbWVzc2FnZSBpZiBhdmFpbGFibGUuXG4gKiBTa2lwcyBhYm9ydGVkIGFuZCBlcnJvciBtZXNzYWdlcyBhcyB0aGV5IGRvbid0IGhhdmUgdmFsaWQgdXNhZ2UgZGF0YS5cbiAqL1xuZnVuY3Rpb24gZ2V0QXNzaXN0YW50VXNhZ2UobXNnOiBBZ2VudE1lc3NhZ2UpOiBVc2FnZSB8IHVuZGVmaW5lZCB7XG5cdGlmIChtc2cucm9sZSA9PT0gXCJhc3Npc3RhbnRcIiAmJiBcInVzYWdlXCIgaW4gbXNnKSB7XG5cdFx0Y29uc3QgYXNzaXN0YW50TXNnID0gbXNnIGFzIEFzc2lzdGFudE1lc3NhZ2U7XG5cdFx0aWYgKGFzc2lzdGFudE1zZy5zdG9wUmVhc29uICE9PSBcImFib3J0ZWRcIiAmJiBhc3Npc3RhbnRNc2cuc3RvcFJlYXNvbiAhPT0gXCJlcnJvclwiICYmIGFzc2lzdGFudE1zZy51c2FnZSkge1xuXHRcdFx0cmV0dXJuIGFzc2lzdGFudE1zZy51c2FnZTtcblx0XHR9XG5cdH1cblx0cmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBGaW5kIHRoZSBsYXN0IG5vbi1hYm9ydGVkIGFzc2lzdGFudCBtZXNzYWdlIHVzYWdlIGZyb20gc2Vzc2lvbiBlbnRyaWVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0TGFzdEFzc2lzdGFudFVzYWdlKGVudHJpZXM6IFNlc3Npb25FbnRyeVtdKTogVXNhZ2UgfCB1bmRlZmluZWQge1xuXHRmb3IgKGxldCBpID0gZW50cmllcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuXHRcdGNvbnN0IGVudHJ5ID0gZW50cmllc1tpXTtcblx0XHRpZiAoZW50cnkudHlwZSA9PT0gXCJtZXNzYWdlXCIpIHtcblx0XHRcdGNvbnN0IHVzYWdlID0gZ2V0QXNzaXN0YW50VXNhZ2UoZW50cnkubWVzc2FnZSk7XG5cdFx0XHRpZiAodXNhZ2UpIHJldHVybiB1c2FnZTtcblx0XHR9XG5cdH1cblx0cmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb250ZXh0VXNhZ2VFc3RpbWF0ZSB7XG5cdHRva2VuczogbnVtYmVyO1xuXHR1c2FnZVRva2VuczogbnVtYmVyO1xuXHR0cmFpbGluZ1Rva2VuczogbnVtYmVyO1xuXHRsYXN0VXNhZ2VJbmRleDogbnVtYmVyIHwgbnVsbDtcbn1cblxuZnVuY3Rpb24gZ2V0TGFzdEFzc2lzdGFudFVzYWdlSW5mbyhtZXNzYWdlczogQWdlbnRNZXNzYWdlW10pOiB7IHVzYWdlOiBVc2FnZTsgaW5kZXg6IG51bWJlciB9IHwgdW5kZWZpbmVkIHtcblx0Zm9yIChsZXQgaSA9IG1lc3NhZ2VzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG5cdFx0Y29uc3QgdXNhZ2UgPSBnZXRBc3Npc3RhbnRVc2FnZShtZXNzYWdlc1tpXSk7XG5cdFx0aWYgKHVzYWdlKSByZXR1cm4geyB1c2FnZSwgaW5kZXg6IGkgfTtcblx0fVxuXHRyZXR1cm4gdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIEVzdGltYXRlIGNvbnRleHQgdG9rZW5zIGZyb20gbWVzc2FnZXMsIHVzaW5nIHRoZSBsYXN0IGFzc2lzdGFudCB1c2FnZSB3aGVuIGF2YWlsYWJsZS5cbiAqIElmIHRoZXJlIGFyZSBtZXNzYWdlcyBhZnRlciB0aGUgbGFzdCB1c2FnZSwgZXN0aW1hdGUgdGhlaXIgdG9rZW5zIHdpdGggZXN0aW1hdGVUb2tlbnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlc3RpbWF0ZUNvbnRleHRUb2tlbnMobWVzc2FnZXM6IEFnZW50TWVzc2FnZVtdKTogQ29udGV4dFVzYWdlRXN0aW1hdGUge1xuXHRjb25zdCB1c2FnZUluZm8gPSBnZXRMYXN0QXNzaXN0YW50VXNhZ2VJbmZvKG1lc3NhZ2VzKTtcblxuXHRpZiAoIXVzYWdlSW5mbykge1xuXHRcdGxldCBlc3RpbWF0ZWQgPSAwO1xuXHRcdGZvciAoY29uc3QgbWVzc2FnZSBvZiBtZXNzYWdlcykge1xuXHRcdFx0ZXN0aW1hdGVkICs9IGVzdGltYXRlVG9rZW5zKG1lc3NhZ2UpO1xuXHRcdH1cblx0XHRyZXR1cm4ge1xuXHRcdFx0dG9rZW5zOiBlc3RpbWF0ZWQsXG5cdFx0XHR1c2FnZVRva2VuczogMCxcblx0XHRcdHRyYWlsaW5nVG9rZW5zOiBlc3RpbWF0ZWQsXG5cdFx0XHRsYXN0VXNhZ2VJbmRleDogbnVsbCxcblx0XHR9O1xuXHR9XG5cblx0Y29uc3QgdXNhZ2VUb2tlbnMgPSBjYWxjdWxhdGVDb250ZXh0VG9rZW5zKHVzYWdlSW5mby51c2FnZSk7XG5cdGxldCB0cmFpbGluZ1Rva2VucyA9IDA7XG5cdGZvciAobGV0IGkgPSB1c2FnZUluZm8uaW5kZXggKyAxOyBpIDwgbWVzc2FnZXMubGVuZ3RoOyBpKyspIHtcblx0XHR0cmFpbGluZ1Rva2VucyArPSBlc3RpbWF0ZVRva2VucyhtZXNzYWdlc1tpXSk7XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdHRva2VuczogdXNhZ2VUb2tlbnMgKyB0cmFpbGluZ1Rva2Vucyxcblx0XHR1c2FnZVRva2Vucyxcblx0XHR0cmFpbGluZ1Rva2Vucyxcblx0XHRsYXN0VXNhZ2VJbmRleDogdXNhZ2VJbmZvLmluZGV4LFxuXHR9O1xufVxuXG4vKipcbiAqIENoZWNrIGlmIGNvbXBhY3Rpb24gc2hvdWxkIHRyaWdnZXIgYmFzZWQgb24gY29udGV4dCB1c2FnZS5cbiAqXG4gKiBXaGVuIGB0aHJlc2hvbGRQZXJjZW50YCBpcyBzZXQgKGFuZCB3aXRoaW4gKDAsIDEpKSwgaXQgb3ZlcnJpZGVzIHRoZSBhYnNvbHV0ZVxuICogYHJlc2VydmVUb2tlbnNgIGNhbGN1bGF0aW9uOiBjb21wYWN0aW9uIGZpcmVzIGF0IGBjb250ZXh0V2luZG93ICogdGhyZXNob2xkUGVyY2VudGAuXG4gKiBPdGhlcndpc2UgdGhlIGxlZ2FjeSBgY29udGV4dFdpbmRvdyAtIHJlc2VydmVUb2tlbnNgIGhlYWRyb29tIGlzIHVzZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRDb21wYWN0KGNvbnRleHRUb2tlbnM6IG51bWJlciwgY29udGV4dFdpbmRvdzogbnVtYmVyLCBzZXR0aW5nczogQ29tcGFjdGlvblNldHRpbmdzKTogYm9vbGVhbiB7XG5cdGlmICghc2V0dGluZ3MuZW5hYmxlZCkgcmV0dXJuIGZhbHNlO1xuXHRpZiAoXG5cdFx0c2V0dGluZ3MudGhyZXNob2xkUGVyY2VudCAhPT0gdW5kZWZpbmVkICYmXG5cdFx0c2V0dGluZ3MudGhyZXNob2xkUGVyY2VudCA+IDAgJiZcblx0XHRzZXR0aW5ncy50aHJlc2hvbGRQZXJjZW50IDwgMVxuXHQpIHtcblx0XHRyZXR1cm4gY29udGV4dFRva2VucyA+IGNvbnRleHRXaW5kb3cgKiBzZXR0aW5ncy50aHJlc2hvbGRQZXJjZW50O1xuXHR9XG5cdHJldHVybiBjb250ZXh0VG9rZW5zID4gY29udGV4dFdpbmRvdyAtIHNldHRpbmdzLnJlc2VydmVUb2tlbnM7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEN1dCBwb2ludCBkZXRlY3Rpb25cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBFc3RpbWF0ZSB0b2tlbiBjb3VudCBmb3IgYSBtZXNzYWdlIHVzaW5nIGNoYXJzLzQgaGV1cmlzdGljLlxuICogVGhpcyBpcyBjb25zZXJ2YXRpdmUgKG92ZXJlc3RpbWF0ZXMgdG9rZW5zKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVzdGltYXRlVG9rZW5zKG1lc3NhZ2U6IEFnZW50TWVzc2FnZSk6IG51bWJlciB7XG5cdGxldCBjaGFycyA9IDA7XG5cblx0c3dpdGNoIChtZXNzYWdlLnJvbGUpIHtcblx0XHRjYXNlIFwidXNlclwiOiB7XG5cdFx0XHRjb25zdCBjb250ZW50ID0gKG1lc3NhZ2UgYXMgeyBjb250ZW50OiBzdHJpbmcgfCBBcnJheTx7IHR5cGU6IHN0cmluZzsgdGV4dD86IHN0cmluZyB9PiB9KS5jb250ZW50O1xuXHRcdFx0aWYgKHR5cGVvZiBjb250ZW50ID09PSBcInN0cmluZ1wiKSB7XG5cdFx0XHRcdGNoYXJzID0gY29udGVudC5sZW5ndGg7XG5cdFx0XHR9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkoY29udGVudCkpIHtcblx0XHRcdFx0Zm9yIChjb25zdCBibG9jayBvZiBjb250ZW50KSB7XG5cdFx0XHRcdFx0aWYgKGJsb2NrLnR5cGUgPT09IFwidGV4dFwiICYmIGJsb2NrLnRleHQpIHtcblx0XHRcdFx0XHRcdGNoYXJzICs9IGJsb2NrLnRleHQubGVuZ3RoO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIE1hdGguY2VpbChjaGFycyAvIDQpO1xuXHRcdH1cblx0XHRjYXNlIFwiYXNzaXN0YW50XCI6IHtcblx0XHRcdGNvbnN0IGFzc2lzdGFudCA9IG1lc3NhZ2UgYXMgQXNzaXN0YW50TWVzc2FnZTtcblx0XHRcdGZvciAoY29uc3QgYmxvY2sgb2YgYXNzaXN0YW50LmNvbnRlbnQpIHtcblx0XHRcdFx0aWYgKGJsb2NrLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0Y2hhcnMgKz0gYmxvY2sudGV4dC5sZW5ndGg7XG5cdFx0XHRcdH0gZWxzZSBpZiAoYmxvY2sudHlwZSA9PT0gXCJ0aGlua2luZ1wiKSB7XG5cdFx0XHRcdFx0Y2hhcnMgKz0gYmxvY2sudGhpbmtpbmcubGVuZ3RoO1xuXHRcdFx0XHR9IGVsc2UgaWYgKGJsb2NrLnR5cGUgPT09IFwidG9vbENhbGxcIikge1xuXHRcdFx0XHRcdGNoYXJzICs9IGJsb2NrLm5hbWUubGVuZ3RoICsgSlNPTi5zdHJpbmdpZnkoYmxvY2suYXJndW1lbnRzKS5sZW5ndGg7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdHJldHVybiBNYXRoLmNlaWwoY2hhcnMgLyA0KTtcblx0XHR9XG5cdFx0Y2FzZSBcImN1c3RvbVwiOlxuXHRcdGNhc2UgXCJ0b29sUmVzdWx0XCI6IHtcblx0XHRcdGlmICh0eXBlb2YgbWVzc2FnZS5jb250ZW50ID09PSBcInN0cmluZ1wiKSB7XG5cdFx0XHRcdGNoYXJzID0gbWVzc2FnZS5jb250ZW50Lmxlbmd0aDtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGZvciAoY29uc3QgYmxvY2sgb2YgbWVzc2FnZS5jb250ZW50KSB7XG5cdFx0XHRcdFx0aWYgKGJsb2NrLnR5cGUgPT09IFwidGV4dFwiICYmIGJsb2NrLnRleHQpIHtcblx0XHRcdFx0XHRcdGNoYXJzICs9IGJsb2NrLnRleHQubGVuZ3RoO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRpZiAoYmxvY2sudHlwZSA9PT0gXCJpbWFnZVwiKSB7XG5cdFx0XHRcdFx0XHRjaGFycyArPSA0ODAwOyAvLyBFc3RpbWF0ZSBpbWFnZXMgYXMgNDAwMCBjaGFycywgb3IgMTIwMCB0b2tlbnNcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdHJldHVybiBNYXRoLmNlaWwoY2hhcnMgLyA0KTtcblx0XHR9XG5cdFx0Y2FzZSBcImJhc2hFeGVjdXRpb25cIjoge1xuXHRcdFx0Y2hhcnMgPSBtZXNzYWdlLmNvbW1hbmQubGVuZ3RoICsgbWVzc2FnZS5vdXRwdXQubGVuZ3RoO1xuXHRcdFx0cmV0dXJuIE1hdGguY2VpbChjaGFycyAvIDQpO1xuXHRcdH1cblx0XHRjYXNlIFwiYnJhbmNoU3VtbWFyeVwiOlxuXHRcdGNhc2UgXCJjb21wYWN0aW9uU3VtbWFyeVwiOiB7XG5cdFx0XHRjaGFycyA9IG1lc3NhZ2Uuc3VtbWFyeS5sZW5ndGg7XG5cdFx0XHRyZXR1cm4gTWF0aC5jZWlsKGNoYXJzIC8gNCk7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIDA7XG59XG5cbi8qKlxuICogRmluZCB2YWxpZCBjdXQgcG9pbnRzOiBpbmRpY2VzIG9mIHVzZXIsIGFzc2lzdGFudCwgY3VzdG9tLCBvciBiYXNoRXhlY3V0aW9uIG1lc3NhZ2VzLlxuICogTmV2ZXIgY3V0IGF0IHRvb2wgcmVzdWx0cyAodGhleSBtdXN0IGZvbGxvdyB0aGVpciB0b29sIGNhbGwpLlxuICogV2hlbiB3ZSBjdXQgYXQgYW4gYXNzaXN0YW50IG1lc3NhZ2Ugd2l0aCB0b29sIGNhbGxzLCBpdHMgdG9vbCByZXN1bHRzIGZvbGxvdyBpdFxuICogYW5kIHdpbGwgYmUga2VwdC5cbiAqIEJhc2hFeGVjdXRpb25NZXNzYWdlIGlzIHRyZWF0ZWQgbGlrZSBhIHVzZXIgbWVzc2FnZSAodXNlci1pbml0aWF0ZWQgY29udGV4dCkuXG4gKi9cbmZ1bmN0aW9uIGZpbmRWYWxpZEN1dFBvaW50cyhlbnRyaWVzOiBTZXNzaW9uRW50cnlbXSwgc3RhcnRJbmRleDogbnVtYmVyLCBlbmRJbmRleDogbnVtYmVyKTogbnVtYmVyW10ge1xuXHRjb25zdCBjdXRQb2ludHM6IG51bWJlcltdID0gW107XG5cdGZvciAobGV0IGkgPSBzdGFydEluZGV4OyBpIDwgZW5kSW5kZXg7IGkrKykge1xuXHRcdGNvbnN0IGVudHJ5ID0gZW50cmllc1tpXTtcblx0XHRzd2l0Y2ggKGVudHJ5LnR5cGUpIHtcblx0XHRcdGNhc2UgXCJtZXNzYWdlXCI6IHtcblx0XHRcdFx0Y29uc3Qgcm9sZSA9IGVudHJ5Lm1lc3NhZ2Uucm9sZTtcblx0XHRcdFx0c3dpdGNoIChyb2xlKSB7XG5cdFx0XHRcdFx0Y2FzZSBcImJhc2hFeGVjdXRpb25cIjpcblx0XHRcdFx0XHRjYXNlIFwiY3VzdG9tXCI6XG5cdFx0XHRcdFx0Y2FzZSBcImJyYW5jaFN1bW1hcnlcIjpcblx0XHRcdFx0XHRjYXNlIFwiY29tcGFjdGlvblN1bW1hcnlcIjpcblx0XHRcdFx0XHRjYXNlIFwidXNlclwiOlxuXHRcdFx0XHRcdGNhc2UgXCJhc3Npc3RhbnRcIjpcblx0XHRcdFx0XHRcdGN1dFBvaW50cy5wdXNoKGkpO1xuXHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0Y2FzZSBcInRvb2xSZXN1bHRcIjpcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdFx0Y2FzZSBcInRoaW5raW5nX2xldmVsX2NoYW5nZVwiOlxuXHRcdFx0Y2FzZSBcIm1vZGVsX2NoYW5nZVwiOlxuXHRcdFx0Y2FzZSBcImNvbXBhY3Rpb25cIjpcblx0XHRcdGNhc2UgXCJicmFuY2hfc3VtbWFyeVwiOlxuXHRcdFx0Y2FzZSBcImN1c3RvbVwiOlxuXHRcdFx0Y2FzZSBcImN1c3RvbV9tZXNzYWdlXCI6XG5cdFx0XHRjYXNlIFwibGFiZWxcIjpcblx0XHR9XG5cdFx0Ly8gYnJhbmNoX3N1bW1hcnkgYW5kIGN1c3RvbV9tZXNzYWdlIGFyZSB1c2VyLXJvbGUgbWVzc2FnZXMsIHZhbGlkIGN1dCBwb2ludHNcblx0XHRpZiAoZW50cnkudHlwZSA9PT0gXCJicmFuY2hfc3VtbWFyeVwiIHx8IGVudHJ5LnR5cGUgPT09IFwiY3VzdG9tX21lc3NhZ2VcIikge1xuXHRcdFx0Y3V0UG9pbnRzLnB1c2goaSk7XG5cdFx0fVxuXHR9XG5cdHJldHVybiBjdXRQb2ludHM7XG59XG5cbi8qKlxuICogRmluZCB0aGUgdXNlciBtZXNzYWdlIChvciBiYXNoRXhlY3V0aW9uKSB0aGF0IHN0YXJ0cyB0aGUgdHVybiBjb250YWluaW5nIHRoZSBnaXZlbiBlbnRyeSBpbmRleC5cbiAqIFJldHVybnMgLTEgaWYgbm8gdHVybiBzdGFydCBmb3VuZCBiZWZvcmUgdGhlIGluZGV4LlxuICogQmFzaEV4ZWN1dGlvbk1lc3NhZ2UgaXMgdHJlYXRlZCBsaWtlIGEgdXNlciBtZXNzYWdlIGZvciB0dXJuIGJvdW5kYXJpZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kVHVyblN0YXJ0SW5kZXgoZW50cmllczogU2Vzc2lvbkVudHJ5W10sIGVudHJ5SW5kZXg6IG51bWJlciwgc3RhcnRJbmRleDogbnVtYmVyKTogbnVtYmVyIHtcblx0Zm9yIChsZXQgaSA9IGVudHJ5SW5kZXg7IGkgPj0gc3RhcnRJbmRleDsgaS0tKSB7XG5cdFx0Y29uc3QgZW50cnkgPSBlbnRyaWVzW2ldO1xuXHRcdC8vIGJyYW5jaF9zdW1tYXJ5IGFuZCBjdXN0b21fbWVzc2FnZSBhcmUgdXNlci1yb2xlIG1lc3NhZ2VzLCBjYW4gc3RhcnQgYSB0dXJuXG5cdFx0aWYgKGVudHJ5LnR5cGUgPT09IFwiYnJhbmNoX3N1bW1hcnlcIiB8fCBlbnRyeS50eXBlID09PSBcImN1c3RvbV9tZXNzYWdlXCIpIHtcblx0XHRcdHJldHVybiBpO1xuXHRcdH1cblx0XHRpZiAoZW50cnkudHlwZSA9PT0gXCJtZXNzYWdlXCIpIHtcblx0XHRcdGNvbnN0IHJvbGUgPSBlbnRyeS5tZXNzYWdlLnJvbGU7XG5cdFx0XHRpZiAocm9sZSA9PT0gXCJ1c2VyXCIgfHwgcm9sZSA9PT0gXCJiYXNoRXhlY3V0aW9uXCIpIHtcblx0XHRcdFx0cmV0dXJuIGk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cdHJldHVybiAtMTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDdXRQb2ludFJlc3VsdCB7XG5cdC8qKiBJbmRleCBvZiBmaXJzdCBlbnRyeSB0byBrZWVwICovXG5cdGZpcnN0S2VwdEVudHJ5SW5kZXg6IG51bWJlcjtcblx0LyoqIEluZGV4IG9mIHVzZXIgbWVzc2FnZSB0aGF0IHN0YXJ0cyB0aGUgdHVybiBiZWluZyBzcGxpdCwgb3IgLTEgaWYgbm90IHNwbGl0dGluZyAqL1xuXHR0dXJuU3RhcnRJbmRleDogbnVtYmVyO1xuXHQvKiogV2hldGhlciB0aGlzIGN1dCBzcGxpdHMgYSB0dXJuIChjdXQgcG9pbnQgaXMgbm90IGEgdXNlciBtZXNzYWdlKSAqL1xuXHRpc1NwbGl0VHVybjogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBGaW5kIHRoZSBjdXQgcG9pbnQgaW4gc2Vzc2lvbiBlbnRyaWVzIHRoYXQga2VlcHMgYXBwcm94aW1hdGVseSBga2VlcFJlY2VudFRva2Vuc2AuXG4gKlxuICogQWxnb3JpdGhtOiBXYWxrIGJhY2t3YXJkcyBmcm9tIG5ld2VzdCwgYWNjdW11bGF0aW5nIGVzdGltYXRlZCBtZXNzYWdlIHNpemVzLlxuICogU3RvcCB3aGVuIHdlJ3ZlIGFjY3VtdWxhdGVkID49IGtlZXBSZWNlbnRUb2tlbnMuIEN1dCBhdCB0aGF0IHBvaW50LlxuICpcbiAqIENhbiBjdXQgYXQgdXNlciBPUiBhc3Npc3RhbnQgbWVzc2FnZXMgKG5ldmVyIHRvb2wgcmVzdWx0cykuIFdoZW4gY3V0dGluZyBhdCBhblxuICogYXNzaXN0YW50IG1lc3NhZ2Ugd2l0aCB0b29sIGNhbGxzLCBpdHMgdG9vbCByZXN1bHRzIGNvbWUgYWZ0ZXIgYW5kIHdpbGwgYmUga2VwdC5cbiAqXG4gKiBSZXR1cm5zIEN1dFBvaW50UmVzdWx0IHdpdGg6XG4gKiAtIGZpcnN0S2VwdEVudHJ5SW5kZXg6IHRoZSBlbnRyeSBpbmRleCB0byBzdGFydCBrZWVwaW5nIGZyb21cbiAqIC0gdHVyblN0YXJ0SW5kZXg6IGlmIGN1dHRpbmcgbWlkLXR1cm4sIHRoZSB1c2VyIG1lc3NhZ2UgdGhhdCBzdGFydGVkIHRoYXQgdHVyblxuICogLSBpc1NwbGl0VHVybjogd2hldGhlciB3ZSdyZSBjdXR0aW5nIGluIHRoZSBtaWRkbGUgb2YgYSB0dXJuXG4gKlxuICogT25seSBjb25zaWRlcnMgZW50cmllcyBiZXR3ZWVuIGBzdGFydEluZGV4YCBhbmQgYGVuZEluZGV4YCAoZXhjbHVzaXZlKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmRDdXRQb2ludChcblx0ZW50cmllczogU2Vzc2lvbkVudHJ5W10sXG5cdHN0YXJ0SW5kZXg6IG51bWJlcixcblx0ZW5kSW5kZXg6IG51bWJlcixcblx0a2VlcFJlY2VudFRva2VuczogbnVtYmVyLFxuKTogQ3V0UG9pbnRSZXN1bHQge1xuXHRjb25zdCBjdXRQb2ludHMgPSBmaW5kVmFsaWRDdXRQb2ludHMoZW50cmllcywgc3RhcnRJbmRleCwgZW5kSW5kZXgpO1xuXG5cdGlmIChjdXRQb2ludHMubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIHsgZmlyc3RLZXB0RW50cnlJbmRleDogc3RhcnRJbmRleCwgdHVyblN0YXJ0SW5kZXg6IC0xLCBpc1NwbGl0VHVybjogZmFsc2UgfTtcblx0fVxuXG5cdC8vIFdhbGsgYmFja3dhcmRzIGZyb20gbmV3ZXN0LCBhY2N1bXVsYXRpbmcgZXN0aW1hdGVkIG1lc3NhZ2Ugc2l6ZXNcblx0bGV0IGFjY3VtdWxhdGVkVG9rZW5zID0gMDtcblx0bGV0IGN1dEluZGV4ID0gY3V0UG9pbnRzWzBdOyAvLyBEZWZhdWx0OiBrZWVwIGZyb20gZmlyc3QgbWVzc2FnZSAobm90IGhlYWRlcilcblxuXHRmb3IgKGxldCBpID0gZW5kSW5kZXggLSAxOyBpID49IHN0YXJ0SW5kZXg7IGktLSkge1xuXHRcdGNvbnN0IGVudHJ5ID0gZW50cmllc1tpXTtcblx0XHRpZiAoZW50cnkudHlwZSAhPT0gXCJtZXNzYWdlXCIpIGNvbnRpbnVlO1xuXG5cdFx0Ly8gRXN0aW1hdGUgdGhpcyBtZXNzYWdlJ3Mgc2l6ZVxuXHRcdGNvbnN0IG1lc3NhZ2VUb2tlbnMgPSBlc3RpbWF0ZVRva2VucyhlbnRyeS5tZXNzYWdlKTtcblx0XHRhY2N1bXVsYXRlZFRva2VucyArPSBtZXNzYWdlVG9rZW5zO1xuXG5cdFx0Ly8gQ2hlY2sgaWYgd2UndmUgZXhjZWVkZWQgdGhlIGJ1ZGdldFxuXHRcdGlmIChhY2N1bXVsYXRlZFRva2VucyA+PSBrZWVwUmVjZW50VG9rZW5zKSB7XG5cdFx0XHQvLyBGaW5kIHRoZSBjbG9zZXN0IHZhbGlkIGN1dCBwb2ludCBhdCBvciBhZnRlciB0aGlzIGVudHJ5XG5cdFx0XHRmb3IgKGxldCBjID0gMDsgYyA8IGN1dFBvaW50cy5sZW5ndGg7IGMrKykge1xuXHRcdFx0XHRpZiAoY3V0UG9pbnRzW2NdID49IGkpIHtcblx0XHRcdFx0XHRjdXRJbmRleCA9IGN1dFBvaW50c1tjXTtcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXHR9XG5cblx0Ly8gU2NhbiBiYWNrd2FyZHMgZnJvbSBjdXRJbmRleCB0byBpbmNsdWRlIGFueSBub24tbWVzc2FnZSBlbnRyaWVzIChiYXNoLCBzZXR0aW5ncywgZXRjLilcblx0d2hpbGUgKGN1dEluZGV4ID4gc3RhcnRJbmRleCkge1xuXHRcdGNvbnN0IHByZXZFbnRyeSA9IGVudHJpZXNbY3V0SW5kZXggLSAxXTtcblx0XHQvLyBTdG9wIGF0IHNlc3Npb24gaGVhZGVyIG9yIGNvbXBhY3Rpb24gYm91bmRhcmllc1xuXHRcdGlmIChwcmV2RW50cnkudHlwZSA9PT0gXCJjb21wYWN0aW9uXCIpIHtcblx0XHRcdGJyZWFrO1xuXHRcdH1cblx0XHRpZiAocHJldkVudHJ5LnR5cGUgPT09IFwibWVzc2FnZVwiKSB7XG5cdFx0XHQvLyBTdG9wIGlmIHdlIGhpdCBhbnkgbWVzc2FnZVxuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXHRcdC8vIEluY2x1ZGUgdGhpcyBub24tbWVzc2FnZSBlbnRyeSAoYmFzaCwgc2V0dGluZ3MgY2hhbmdlLCBldGMuKVxuXHRcdGN1dEluZGV4LS07XG5cdH1cblxuXHQvLyBEZXRlcm1pbmUgaWYgdGhpcyBpcyBhIHNwbGl0IHR1cm5cblx0Y29uc3QgY3V0RW50cnkgPSBlbnRyaWVzW2N1dEluZGV4XTtcblx0Y29uc3QgaXNVc2VyTWVzc2FnZSA9IGN1dEVudHJ5LnR5cGUgPT09IFwibWVzc2FnZVwiICYmIGN1dEVudHJ5Lm1lc3NhZ2Uucm9sZSA9PT0gXCJ1c2VyXCI7XG5cdGNvbnN0IHR1cm5TdGFydEluZGV4ID0gaXNVc2VyTWVzc2FnZSA/IC0xIDogZmluZFR1cm5TdGFydEluZGV4KGVudHJpZXMsIGN1dEluZGV4LCBzdGFydEluZGV4KTtcblxuXHRyZXR1cm4ge1xuXHRcdGZpcnN0S2VwdEVudHJ5SW5kZXg6IGN1dEluZGV4LFxuXHRcdHR1cm5TdGFydEluZGV4LFxuXHRcdGlzU3BsaXRUdXJuOiAhaXNVc2VyTWVzc2FnZSAmJiB0dXJuU3RhcnRJbmRleCAhPT0gLTEsXG5cdH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFN1bW1hcml6YXRpb25cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuY29uc3QgU1VNTUFSSVpBVElPTl9QUk9NUFQgPSBgVGhlIG1lc3NhZ2VzIGFib3ZlIGFyZSBhIGNvbnZlcnNhdGlvbiB0byBzdW1tYXJpemUuIENyZWF0ZSBhIHN0cnVjdHVyZWQgY29udGV4dCBjaGVja3BvaW50IHN1bW1hcnkgdGhhdCBhbm90aGVyIExMTSB3aWxsIHVzZSB0byBjb250aW51ZSB0aGUgd29yay5cblxuVXNlIHRoaXMgRVhBQ1QgZm9ybWF0OlxuXG4jIyBHb2FsXG5bV2hhdCBpcyB0aGUgdXNlciB0cnlpbmcgdG8gYWNjb21wbGlzaD8gQ2FuIGJlIG11bHRpcGxlIGl0ZW1zIGlmIHRoZSBzZXNzaW9uIGNvdmVycyBkaWZmZXJlbnQgdGFza3MuXVxuXG4jIyBDb25zdHJhaW50cyAmIFByZWZlcmVuY2VzXG4tIFtBbnkgY29uc3RyYWludHMsIHByZWZlcmVuY2VzLCBvciByZXF1aXJlbWVudHMgbWVudGlvbmVkIGJ5IHVzZXJdXG4tIFtPciBcIihub25lKVwiIGlmIG5vbmUgd2VyZSBtZW50aW9uZWRdXG5cbiMjIFByb2dyZXNzXG4jIyMgRG9uZVxuLSBbeF0gW0NvbXBsZXRlZCB0YXNrcy9jaGFuZ2VzXVxuXG4jIyMgSW4gUHJvZ3Jlc3Ncbi0gWyBdIFtDdXJyZW50IHdvcmtdXG5cbiMjIyBCbG9ja2VkXG4tIFtJc3N1ZXMgcHJldmVudGluZyBwcm9ncmVzcywgaWYgYW55XVxuXG4jIyBLZXkgRGVjaXNpb25zXG4tICoqW0RlY2lzaW9uXSoqOiBbQnJpZWYgcmF0aW9uYWxlXVxuXG4jIyBOZXh0IFN0ZXBzXG4xLiBbT3JkZXJlZCBsaXN0IG9mIHdoYXQgc2hvdWxkIGhhcHBlbiBuZXh0XVxuXG4jIyBDcml0aWNhbCBDb250ZXh0XG4tIFtBbnkgZGF0YSwgZXhhbXBsZXMsIG9yIHJlZmVyZW5jZXMgbmVlZGVkIHRvIGNvbnRpbnVlXVxuLSBbT3IgXCIobm9uZSlcIiBpZiBub3QgYXBwbGljYWJsZV1cblxuS2VlcCBlYWNoIHNlY3Rpb24gY29uY2lzZS4gUHJlc2VydmUgZXhhY3QgZmlsZSBwYXRocywgZnVuY3Rpb24gbmFtZXMsIGFuZCBlcnJvciBtZXNzYWdlcy5gO1xuXG5jb25zdCBVUERBVEVfU1VNTUFSSVpBVElPTl9QUk9NUFQgPSBgVGhlIG1lc3NhZ2VzIGFib3ZlIGFyZSBORVcgY29udmVyc2F0aW9uIG1lc3NhZ2VzIHRvIGluY29ycG9yYXRlIGludG8gdGhlIGV4aXN0aW5nIHN1bW1hcnkgcHJvdmlkZWQgaW4gPHByZXZpb3VzLXN1bW1hcnk+IHRhZ3MuXG5cblVwZGF0ZSB0aGUgZXhpc3Rpbmcgc3RydWN0dXJlZCBzdW1tYXJ5IHdpdGggbmV3IGluZm9ybWF0aW9uLiBSVUxFUzpcbi0gUFJFU0VSVkUgYWxsIGV4aXN0aW5nIGluZm9ybWF0aW9uIGZyb20gdGhlIHByZXZpb3VzIHN1bW1hcnlcbi0gQUREIG5ldyBwcm9ncmVzcywgZGVjaXNpb25zLCBhbmQgY29udGV4dCBmcm9tIHRoZSBuZXcgbWVzc2FnZXNcbi0gVVBEQVRFIHRoZSBQcm9ncmVzcyBzZWN0aW9uOiBtb3ZlIGl0ZW1zIGZyb20gXCJJbiBQcm9ncmVzc1wiIHRvIFwiRG9uZVwiIHdoZW4gY29tcGxldGVkXG4tIFVQREFURSBcIk5leHQgU3RlcHNcIiBiYXNlZCBvbiB3aGF0IHdhcyBhY2NvbXBsaXNoZWRcbi0gUFJFU0VSVkUgZXhhY3QgZmlsZSBwYXRocywgZnVuY3Rpb24gbmFtZXMsIGFuZCBlcnJvciBtZXNzYWdlc1xuLSBJZiBzb21ldGhpbmcgaXMgbm8gbG9uZ2VyIHJlbGV2YW50LCB5b3UgbWF5IHJlbW92ZSBpdFxuXG5Vc2UgdGhpcyBFWEFDVCBmb3JtYXQ6XG5cbiMjIEdvYWxcbltQcmVzZXJ2ZSBleGlzdGluZyBnb2FscywgYWRkIG5ldyBvbmVzIGlmIHRoZSB0YXNrIGV4cGFuZGVkXVxuXG4jIyBDb25zdHJhaW50cyAmIFByZWZlcmVuY2VzXG4tIFtQcmVzZXJ2ZSBleGlzdGluZywgYWRkIG5ldyBvbmVzIGRpc2NvdmVyZWRdXG5cbiMjIFByb2dyZXNzXG4jIyMgRG9uZVxuLSBbeF0gW0luY2x1ZGUgcHJldmlvdXNseSBkb25lIGl0ZW1zIEFORCBuZXdseSBjb21wbGV0ZWQgaXRlbXNdXG5cbiMjIyBJbiBQcm9ncmVzc1xuLSBbIF0gW0N1cnJlbnQgd29yayAtIHVwZGF0ZSBiYXNlZCBvbiBwcm9ncmVzc11cblxuIyMjIEJsb2NrZWRcbi0gW0N1cnJlbnQgYmxvY2tlcnMgLSByZW1vdmUgaWYgcmVzb2x2ZWRdXG5cbiMjIEtleSBEZWNpc2lvbnNcbi0gKipbRGVjaXNpb25dKio6IFtCcmllZiByYXRpb25hbGVdIChwcmVzZXJ2ZSBhbGwgcHJldmlvdXMsIGFkZCBuZXcpXG5cbiMjIE5leHQgU3RlcHNcbjEuIFtVcGRhdGUgYmFzZWQgb24gY3VycmVudCBzdGF0ZV1cblxuIyMgQ3JpdGljYWwgQ29udGV4dFxuLSBbUHJlc2VydmUgaW1wb3J0YW50IGNvbnRleHQsIGFkZCBuZXcgaWYgbmVlZGVkXVxuXG5LZWVwIGVhY2ggc2VjdGlvbiBjb25jaXNlLiBQcmVzZXJ2ZSBleGFjdCBmaWxlIHBhdGhzLCBmdW5jdGlvbiBuYW1lcywgYW5kIGVycm9yIG1lc3NhZ2VzLmA7XG5cbi8qKlxuICogU3BsaXQgbWVzc2FnZXMgaW50byBjaHVua3Mgd2hlcmUgZWFjaCBjaHVuaydzIGVzdGltYXRlZCB0b2tlbiBjb3VudFxuICogc3RheXMgd2l0aGluIGBtYXhUb2tlbnNQZXJDaHVua2AuIEEgc2luZ2xlIG1lc3NhZ2UgdGhhdCBleGNlZWRzIHRoZVxuICogYnVkZ2V0IGlzIHBsYWNlZCBhbG9uZSBpbiBpdHMgb3duIGNodW5rIChuZXZlciBkcm9wcGVkKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNodW5rTWVzc2FnZXMobWVzc2FnZXM6IEFnZW50TWVzc2FnZVtdLCBtYXhUb2tlbnNQZXJDaHVuazogbnVtYmVyKTogQWdlbnRNZXNzYWdlW11bXSB7XG5cdGNvbnN0IGNodW5rczogQWdlbnRNZXNzYWdlW11bXSA9IFtdO1xuXHRsZXQgY3VycmVudENodW5rOiBBZ2VudE1lc3NhZ2VbXSA9IFtdO1xuXHRsZXQgY3VycmVudFRva2VucyA9IDA7XG5cblx0Zm9yIChjb25zdCBtc2cgb2YgbWVzc2FnZXMpIHtcblx0XHQvLyBVc2UgUE9TVC10cnVuY2F0aW9uIHRva2VuIGVzdGltYXRlOiBzZXJpYWxpemVDb252ZXJzYXRpb24gY2FwcyBldmVyeVxuXHRcdC8vIGxhcmdlIGNvbnRlbnQgYmxvY2sgdG8gVE9PTF9SRVNVTFRfTUFYX0NIQVJTIGJlZm9yZSBzZW5kaW5nIHRvIHRoZSBMTE0sXG5cdFx0Ly8gc28gY2h1bmsgc2l6aW5nIG11c3QgcmVmbGVjdCB3aGF0IHRoZSBMTE0gd2lsbCBhY3R1YWxseSBzZWUuIFVzaW5nIHRoZVxuXHRcdC8vIHByZS10cnVuY2F0aW9uIGBlc3RpbWF0ZVRva2Vuc2AgaGVyZSB3YXMgdGhlIHJvb3QgY2F1c2Ugb2YgaXNzdWUgIzQ2NjU6XG5cdFx0Ly8gYSBzaW5nbGUgNDAwSy1jaGFyIHRvb2wgcmVzdWx0IGxvb2tlZCBsaWtlIDEwMEsgdG9rZW5zIGJ1dCBzZXJpYWxpemVkXG5cdFx0Ly8gdG8gfjYwMCB0b2tlbnMsIHByb2R1Y2luZyB0ZW5zIG9mIHRpbnkgaW5mb3JtYXRpb24tc3RhcnZlZCBjaHVua3MuXG5cdFx0Y29uc3QgbXNnVG9rZW5zID0gZXN0aW1hdGVTZXJpYWxpemVkVG9rZW5zKG1zZyk7XG5cblx0XHRpZiAoY3VycmVudENodW5rLmxlbmd0aCA+IDAgJiYgY3VycmVudFRva2VucyArIG1zZ1Rva2VucyA+IG1heFRva2Vuc1BlckNodW5rKSB7XG5cdFx0XHQvLyBDdXJyZW50IGNodW5rIGlzIGZ1bGwgXHUyMDE0IHN0YXJ0IGEgbmV3IG9uZVxuXHRcdFx0Y2h1bmtzLnB1c2goY3VycmVudENodW5rKTtcblx0XHRcdGN1cnJlbnRDaHVuayA9IFttc2ddO1xuXHRcdFx0Y3VycmVudFRva2VucyA9IG1zZ1Rva2Vucztcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y3VycmVudENodW5rLnB1c2gobXNnKTtcblx0XHRcdGN1cnJlbnRUb2tlbnMgKz0gbXNnVG9rZW5zO1xuXHRcdH1cblx0fVxuXG5cdGlmIChjdXJyZW50Q2h1bmsubGVuZ3RoID4gMCkge1xuXHRcdGNodW5rcy5wdXNoKGN1cnJlbnRDaHVuayk7XG5cdH1cblxuXHRyZXR1cm4gY2h1bmtzO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBEZWdlbmVyYXRlIHN1bW1hcnkgZGV0ZWN0aW9uIChpc3N1ZSAjNDY2NSlcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBIZXVyaXN0aWM6IGRvZXMgdGhpcyBzdW1tYXJ5IGxvb2sgbGlrZSB0aGUgXCJlbXB0eSBjb252ZXJzYXRpb25cIiBkZWdlbmVyYXRlXG4gKiBvdXRwdXQgdGhhdCBwb2lzb25zIHRoZSBpdGVyYXRpdmUgVVBEQVRFX1NVTU1BUklaQVRJT05fUFJPTVBUIGNoYWluP1xuICpcbiAqIFRoZSBMTE0gb2NjYXNpb25hbGx5IHJldHVybnMgc2hvcnQgZW1wdHktc291bmRpbmcgc3VtbWFyaWVzIHdoZW4gYSBjaHVua1xuICogY29udGFpbnMgb25seSB0cnVuY2F0ZWQgdG9vbC1jYWxsIHByZWFtYmxlcyB3aXRob3V0IHJlc3VsdHMuIElmIHRoZSBjaGFpblxuICogcHJvcGFnYXRlcyB0aGlzIGZvcndhcmQsIGV2ZXJ5IHN1YnNlcXVlbnQgY2h1bmsgaXMgdG9sZCB0byBcIlBSRVNFUlZFIGFsbFxuICogZXhpc3RpbmcgaW5mb3JtYXRpb25cIiBcdTIwMTQgd2hpY2ggcHJlc2VydmVzIHRoZSBlbXB0aW5lc3MuXG4gKlxuICogQ29uc2VydmF0aXZlIG1hdGNoOiBhbiBleHBsaWNpdCBzdWJzdHJpbmcgaGl0IE9SIGxlbmd0aCA8IDEwMCBjaGFycy4gV2Uga2VlcFxuICogdGhpcyBkZXRlcm1pbmlzdGljIChubyBmdXp6eSBzY29yaW5nKSBiZWNhdXNlIGZ1enp5IG1hdGNoaW5nIGlzIHdoZXJlXG4gKiBxdWFsaXR5IGdhdGVzIGJlY29tZSBmbGFreSBhbmQgaGFyZCB0byB0ZXN0LlxuICpcbiAqIEV4cG9ydGVkIGZvciB0ZXN0IGFjY2VzcyBvbmx5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNEZWdlbmVyYXRlU3VtbWFyeShzdW1tYXJ5OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcblx0Ly8gdW5kZWZpbmVkIG1lYW5zIFwibm8gc3VtbWFyeSB3YXMgcHJvZHVjZWQgeWV0XCIgKGZpcnN0IGNodW5rIGJlZm9yZSBhbnkgY2FsbClcblx0Ly8gXHUyMDE0IG5vdCBkZWdlbmVyYXRlLiBFbXB0eSBzdHJpbmcgSVMgZGVnZW5lcmF0ZTogdGhlIExMTSByZXR1cm5lZCBub3RoaW5nLlxuXHRpZiAoc3VtbWFyeSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XG5cdGNvbnN0IGxvd2VyID0gc3VtbWFyeS50b0xvd2VyQ2FzZSgpO1xuXHRpZiAobG93ZXIuaW5jbHVkZXMoXCJlbXB0eSBjb252ZXJzYXRpb25cIikpIHJldHVybiB0cnVlO1xuXHRpZiAobG93ZXIuaW5jbHVkZXMoXCJubyBjb252ZXJzYXRpb24gdG8gc3VtbWFyaXplXCIpKSByZXR1cm4gdHJ1ZTtcblx0aWYgKGxvd2VyLmluY2x1ZGVzKFwibm8gbWVzc2FnZXMgdG8gc3VtbWFyaXplXCIpKSByZXR1cm4gdHJ1ZTtcblx0Ly8gTGVuZ3RoIGd1YXJkOiBhbnkgc3VtbWFyeSBzaG9ydGVyIHRoYW4gMTAwIGNoYXJzIGlzIGFsbW9zdCBjZXJ0YWlubHlcblx0Ly8gZGVnZW5lcmF0ZSBmb3IgYSBtdWx0aS1jaHVuayBwaXBlbGluZS5cblx0aWYgKHN1bW1hcnkudHJpbSgpLmxlbmd0aCA8IDEwMCkgcmV0dXJuIHRydWU7XG5cdHJldHVybiBmYWxzZTtcbn1cblxuLyoqIFR5cGUgZm9yIHRoZSBjb21wbGV0aW9uIGZ1bmN0aW9uLCBhbGxvd2luZyBpbmplY3Rpb24gZm9yIHRlc3RzLiAqL1xudHlwZSBDb21wbGV0ZUZuID0gdHlwZW9mIGNvbXBsZXRlU2ltcGxlO1xuXG4vKipcbiAqIEdlbmVyYXRlIGEgc3VtbWFyeSBvZiB0aGUgY29udmVyc2F0aW9uIHVzaW5nIHRoZSBMTE0uXG4gKiBJZiBwcmV2aW91c1N1bW1hcnkgaXMgcHJvdmlkZWQsIHVzZXMgdGhlIHVwZGF0ZSBwcm9tcHQgdG8gbWVyZ2UuXG4gKlxuICogV2hlbiB0aGUgbWVzc2FnZXMgZXhjZWVkIHRoZSBtb2RlbCdzIGNvbnRleHQgd2luZG93LCBhdXRvbWF0aWNhbGx5XG4gKiBmYWxscyBiYWNrIHRvIGNodW5rZWQgc3VtbWFyaXphdGlvbjogc3VtbWFyaXplIHRoZSBmaXJzdCBjaHVuayxcbiAqIHRoZW4gaXRlcmF0aXZlbHkgbWVyZ2Ugc3Vic2VxdWVudCBjaHVua3MgdXNpbmcgdGhlIHVwZGF0ZSBwcm9tcHQuXG4gKlxuICogQHBhcmFtIF9jb21wbGV0ZUZuIC0gSW50ZXJuYWwgb3ZlcnJpZGUgZm9yIHRlc3Rpbmc7IGRlZmF1bHRzIHRvIGNvbXBsZXRlU2ltcGxlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2VuZXJhdGVTdW1tYXJ5KFxuXHRjdXJyZW50TWVzc2FnZXM6IEFnZW50TWVzc2FnZVtdLFxuXHRtb2RlbDogTW9kZWw8YW55Pixcblx0cmVzZXJ2ZVRva2VuczogbnVtYmVyLFxuXHRhcGlLZXk6IHN0cmluZyB8IHVuZGVmaW5lZCxcblx0c2lnbmFsPzogQWJvcnRTaWduYWwsXG5cdGN1c3RvbUluc3RydWN0aW9ucz86IHN0cmluZyxcblx0cHJldmlvdXNTdW1tYXJ5Pzogc3RyaW5nLFxuXHRfY29tcGxldGVGbj86IENvbXBsZXRlRm4sXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuXHRjb25zdCBjb21wbGV0ZSA9IF9jb21wbGV0ZUZuID8/IGNvbXBsZXRlU2ltcGxlO1xuXG5cdC8vIEVzdGltYXRlIHRvdGFsIHRva2VucyB1c2luZyB0aGUgUE9TVC10cnVuY2F0aW9uIHNlcmlhbGl6ZXIgdmlldyAoaXNzdWUgIzQ2NjUpLlxuXHQvLyBzZXJpYWxpemVDb252ZXJzYXRpb24gY2FwcyBsYXJnZSBjb250ZW50IGJsb2NrcyB0byBUT09MX1JFU1VMVF9NQVhfQ0hBUlNcblx0Ly8gYmVmb3JlIHNlbmRpbmcsIHNvIGFza2luZyBcImRvZXMgdGhpcyBmaXQgaW4gb25lIHBhc3M/XCIgbXVzdCByZWZsZWN0IHRoYXQuXG5cdGxldCB0b3RhbFRva2VucyA9IDA7XG5cdGZvciAoY29uc3QgbXNnIG9mIGN1cnJlbnRNZXNzYWdlcykge1xuXHRcdHRvdGFsVG9rZW5zICs9IGVzdGltYXRlU2VyaWFsaXplZFRva2Vucyhtc2cpO1xuXHR9XG5cblx0Ly8gT3ZlcmhlYWQgZm9yIHRoZSBwcm9tcHQgZnJhbWluZywgc3lzdGVtIHByb21wdCwgYW5kIHJlc3BvbnNlIGJ1ZGdldFxuXHRjb25zdCBwcm9tcHRPdmVyaGVhZCA9IDRfMDAwO1xuXHRjb25zdCBtYXhUb2tlbnMgPSBNYXRoLmZsb29yKDAuOCAqIHJlc2VydmVUb2tlbnMpO1xuXHRjb25zdCBtYXhJbnB1dFRva2VucyA9IChtb2RlbC5jb250ZXh0V2luZG93IHx8IDIwMF8wMDApIC0gcmVzZXJ2ZVRva2VucyAtIHByb21wdE92ZXJoZWFkO1xuXG5cdC8vIElmIG1lc3NhZ2VzIGZpdCBpbiB0aGUgY29udGV4dCB3aW5kb3csIHVzZSBzaW5nbGUtcGFzcyBzdW1tYXJpemF0aW9uXG5cdGlmICh0b3RhbFRva2VucyA8PSBtYXhJbnB1dFRva2Vucykge1xuXHRcdHJldHVybiBzaW5nbGVQYXNzU3VtbWFyeShjdXJyZW50TWVzc2FnZXMsIG1vZGVsLCByZXNlcnZlVG9rZW5zLCBhcGlLZXksIHNpZ25hbCwgY3VzdG9tSW5zdHJ1Y3Rpb25zLCBwcmV2aW91c1N1bW1hcnksIGNvbXBsZXRlKTtcblx0fVxuXG5cdC8vIENodW5rZWQgZmFsbGJhY2s6IHNwbGl0IG1lc3NhZ2VzIGFuZCBpdGVyYXRpdmVseSBzdW1tYXJpemUuXG5cdGNvbnN0IGNodW5rcyA9IGNodW5rTWVzc2FnZXMoY3VycmVudE1lc3NhZ2VzLCBtYXhJbnB1dFRva2Vucyk7XG5cdGxldCBydW5uaW5nU3VtbWFyeSA9IHByZXZpb3VzU3VtbWFyeTtcblxuXHRmb3IgKGxldCBpID0gMDsgaSA8IGNodW5rcy5sZW5ndGg7IGkrKykge1xuXHRcdGNvbnN0IGNodW5rU3VtbWFyeSA9IGF3YWl0IHNpbmdsZVBhc3NTdW1tYXJ5KFxuXHRcdFx0Y2h1bmtzW2ldLFxuXHRcdFx0bW9kZWwsXG5cdFx0XHRyZXNlcnZlVG9rZW5zLFxuXHRcdFx0YXBpS2V5LFxuXHRcdFx0c2lnbmFsLFxuXHRcdFx0Y3VzdG9tSW5zdHJ1Y3Rpb25zLFxuXHRcdFx0cnVubmluZ1N1bW1hcnksXG5cdFx0XHRjb21wbGV0ZSxcblx0XHQpO1xuXG5cdFx0Ly8gRGVnZW5lcmF0ZS1zdW1tYXJ5IGd1YXJkIChpc3N1ZSAjNDY2NSkuIFVQREFURV9TVU1NQVJJWkFUSU9OX1BST01QVCBzYXlzXG5cdFx0Ly8gXCJQUkVTRVJWRSBhbGwgZXhpc3RpbmcgaW5mb3JtYXRpb25cIiBcdTIwMTQgc28gaWYgYSBjaHVuayBzdW1tYXJ5IGlzIGVtcHR5IG9yXG5cdFx0Ly8gbmVhci1lbXB0eSwgcHJvcGFnYXRpbmcgaXQgZm9yd2FyZCBhY3RpdmVseSByZWluZm9yY2VzIHRoZSBlbXB0aW5lc3Ncblx0XHQvLyBmb3IgZXZlcnkgc3Vic2VxdWVudCBjaHVuay5cblx0XHQvL1xuXHRcdC8vIFN0cmF0ZWd5IHBlciBjaHVuazpcblx0XHQvLyAgIDEuIElmIGRlZ2VuZXJhdGUsIHJldHJ5IG9uY2UuIEZvciB0aGUgRklSU1QgY2h1bmsgd2l0aCBubyBwcmlvclxuXHRcdC8vICAgICAgY29udGV4dCwgcmV0cnkgd2l0aCB0aGUgaW5pdGlhbCBwcm9tcHQgKHVuZGVmaW5lZCBwcmV2aW91c1N1bW1hcnkpXG5cdFx0Ly8gICAgICB0byBicmVhayB0aGUgcG9pc29uIGNoYWluIGF0IGl0cyBzb3VyY2UuIEZvciBsYXRlciBjaHVua3MsIHJldHJ5XG5cdFx0Ly8gICAgICB3aXRoIHRoZSBzYW1lIHByb21wdCBzdGF0ZSAocnVubmluZ1N1bW1hcnkgcHJlc2VydmVkKSBzaW5jZSB0aGVcblx0XHQvLyAgICAgIGZpcnN0IGZhaWx1cmUgbWF5IGhhdmUgYmVlbiB0cmFuc2llbnQuXG5cdFx0Ly8gICAyLiBJZiB0aGUgcmV0cnkgaXMgYWxzbyBkZWdlbmVyYXRlLCB3YXJuIGFuZCBjb250aW51ZSBXSVRIT1VUXG5cdFx0Ly8gICAgICB1cGRhdGluZyBydW5uaW5nU3VtbWFyeSBcdTIwMTQgbG9zaW5nIHRoYXQgY2h1bmsncyBjb250ZW50IGlzIHN0aWxsXG5cdFx0Ly8gICAgICBwcmVmZXJhYmxlIHRvIHByb3BhZ2F0aW5nIGVtcHRpbmVzcyBmb3J3YXJkLCBidXQgdGhlIGRyb3AgaXMgbm93XG5cdFx0Ly8gICAgICBvYnNlcnZhYmxlIGluIGxvZ3MuXG5cdFx0aWYgKGlzRGVnZW5lcmF0ZVN1bW1hcnkoY2h1bmtTdW1tYXJ5KSkge1xuXHRcdFx0Y29uc3QgcmV0cnlQcmV2aW91c1N1bW1hcnkgPSBpID09PSAwICYmIHJ1bm5pbmdTdW1tYXJ5ID09PSB1bmRlZmluZWRcblx0XHRcdFx0PyB1bmRlZmluZWRcblx0XHRcdFx0OiBydW5uaW5nU3VtbWFyeTtcblx0XHRcdGNvbnN0IHJldHJ5ID0gYXdhaXQgc2luZ2xlUGFzc1N1bW1hcnkoXG5cdFx0XHRcdGNodW5rc1tpXSxcblx0XHRcdFx0bW9kZWwsXG5cdFx0XHRcdHJlc2VydmVUb2tlbnMsXG5cdFx0XHRcdGFwaUtleSxcblx0XHRcdFx0c2lnbmFsLFxuXHRcdFx0XHRjdXN0b21JbnN0cnVjdGlvbnMsXG5cdFx0XHRcdHJldHJ5UHJldmlvdXNTdW1tYXJ5LFxuXHRcdFx0XHRjb21wbGV0ZSxcblx0XHRcdCk7XG5cdFx0XHRpZiAoIWlzRGVnZW5lcmF0ZVN1bW1hcnkocmV0cnkpKSB7XG5cdFx0XHRcdHJ1bm5pbmdTdW1tYXJ5ID0gcmV0cnk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0Ly8gQm90aCBhdHRlbXB0cyBkZWdlbmVyYXRlIFx1MjAxNCBsb2cgYW5kIHNraXAgd2l0aG91dCBwb2lzb25pbmcgdGhlIGNoYWluLlxuXHRcdFx0Ly8gVXNpbmcgcHJvY2Vzcy5zdGRlcnIgZGlyZWN0bHkgc28gdGhpcyBkb2Vzbid0IHJlcXVpcmUgdGhlIGxvZ2dlclxuXHRcdFx0Ly8gZGVwZW5kZW5jeSBncmFwaC4gVmlzaWJsZSB0byBvcGVyYXRvcnMgcmV2aWV3aW5nIGNvbXBhY3Rpb24gaGVhbHRoLlxuXHRcdFx0cHJvY2Vzcy5zdGRlcnIud3JpdGUoXG5cdFx0XHRcdGBbY29tcGFjdGlvbl0gV0FSTjogY2h1bmsgJHtpICsgMX0vJHtjaHVua3MubGVuZ3RofSBwcm9kdWNlZCBhIGRlZ2VuZXJhdGUgc3VtbWFyeSBvbiBib3RoIGF0dGVtcHRzOyBkcm9wcGluZyBjaHVuayBjb250ZW50IGZyb20gc3VtbWFyeS5cXG5gLFxuXHRcdFx0KTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdHJ1bm5pbmdTdW1tYXJ5ID0gY2h1bmtTdW1tYXJ5O1xuXHR9XG5cblx0Ly8gUjYgKGlzc3VlICM0NjY1IGZvbGxvdy11cCk6IGlmIGV2ZXJ5IGNodW5rIHdhcyBkZWdlbmVyYXRlIGFuZCB3ZSBoYXZlIG5vXG5cdC8vIHJ1bm5pbmdTdW1tYXJ5LCBkbyBOT1Qgc2lsZW50bHkgcmV0dXJuIFwiXCIgXHUyMDE0IHRoZSBjYWxsZXIgd291bGQgd3JpdGUgYW5cblx0Ly8gZW1wdHkgY29tcGFjdGlvbiBlbnRyeSwgZGVzdHJveWluZyBhbGwgY29udGV4dCB3aXRoIG5vIHNpZ25hbC4gRmFsbCBiYWNrXG5cdC8vIHRvIHRoZSBvcmlnaW5hbCBwcmV2aW91c1N1bW1hcnkgaWYgYXZhaWxhYmxlOyBvdGhlcndpc2UgdGhyb3cgYSBuYW1lZFxuXHQvLyBlcnJvciBzbyB0aGUgY29tcGFjdGlvbiBwaXBlbGluZSBjYW4gc2tpcCBhcHBlbmRpbmcgdGhlIGVudHJ5LlxuXHRpZiAocnVubmluZ1N1bW1hcnkgPT09IHVuZGVmaW5lZCkge1xuXHRcdGlmIChwcmV2aW91c1N1bW1hcnkgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0cHJvY2Vzcy5zdGRlcnIud3JpdGUoXG5cdFx0XHRcdFwiW2NvbXBhY3Rpb25dIFdBUk46IGV2ZXJ5IGNodW5rIHByb2R1Y2VkIGEgZGVnZW5lcmF0ZSBzdW1tYXJ5OyBmYWxsaW5nIGJhY2sgdG8gZXhpc3RpbmcgcHJldmlvdXNTdW1tYXJ5LlxcblwiLFxuXHRcdFx0KTtcblx0XHRcdHJldHVybiBwcmV2aW91c1N1bW1hcnk7XG5cdFx0fVxuXHRcdHRocm93IG5ldyBDb21wYWN0aW9uUHJvZHVjZWROb1N1bW1hcnlFcnJvcihcblx0XHRcdGBDb21wYWN0aW9uIHByb2R1Y2VkIG5vIHVzYWJsZSBzdW1tYXJ5OiBhbGwgJHtjaHVua3MubGVuZ3RofSBjaHVuayhzKSB3ZXJlIGRlZ2VuZXJhdGUgYW5kIG5vIHByZXZpb3VzU3VtbWFyeSB3YXMgYXZhaWxhYmxlLmAsXG5cdFx0KTtcblx0fVxuXG5cdHJldHVybiBydW5uaW5nU3VtbWFyeTtcbn1cblxuLyoqXG4gKiBUaHJvd24gd2hlbiBgZ2VuZXJhdGVTdW1tYXJ5YCBjb3VsZCBub3QgcHJvZHVjZSBhbnkgbm9uLWRlZ2VuZXJhdGUgc3VtbWFyeVxuICogZnJvbSB0aGUgcHJvdmlkZWQgbWVzc2FnZXMgQU5EIG5vIHByZXZpb3VzIHN1bW1hcnkgd2FzIGF2YWlsYWJsZSB0byBmYWxsXG4gKiBiYWNrIHRvLiBDYWxsZXJzIHNob3VsZCBjYXRjaCB0aGlzIGFuZCBza2lwIHdyaXRpbmcgYSBjb21wYWN0aW9uIGVudHJ5XG4gKiByYXRoZXIgdGhhbiB3cml0aW5nIGFuIGVtcHR5IHN0cmluZyB0byB0aGUgc2Vzc2lvbiBoaXN0b3J5IChpc3N1ZSAjNDY2NSkuXG4gKi9cbmV4cG9ydCBjbGFzcyBDb21wYWN0aW9uUHJvZHVjZWROb1N1bW1hcnlFcnJvciBleHRlbmRzIEVycm9yIHtcblx0Y29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nKSB7XG5cdFx0c3VwZXIobWVzc2FnZSk7XG5cdFx0dGhpcy5uYW1lID0gXCJDb21wYWN0aW9uUHJvZHVjZWROb1N1bW1hcnlFcnJvclwiO1xuXHR9XG59XG5cbi8qKlxuICogU2luZ2xlLXBhc3Mgc3VtbWFyaXphdGlvbiBvZiBtZXNzYWdlcyB1c2luZyB0aGUgTExNLlxuICogSWYgcHJldmlvdXNTdW1tYXJ5IGlzIHByb3ZpZGVkLCB1c2VzIHRoZSB1cGRhdGUgcHJvbXB0IHRvIG1lcmdlLlxuICovXG5hc3luYyBmdW5jdGlvbiBzaW5nbGVQYXNzU3VtbWFyeShcblx0Y3VycmVudE1lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSxcblx0bW9kZWw6IE1vZGVsPGFueT4sXG5cdHJlc2VydmVUb2tlbnM6IG51bWJlcixcblx0YXBpS2V5OiBzdHJpbmcgfCB1bmRlZmluZWQsXG5cdHNpZ25hbD86IEFib3J0U2lnbmFsLFxuXHRjdXN0b21JbnN0cnVjdGlvbnM/OiBzdHJpbmcsXG5cdHByZXZpb3VzU3VtbWFyeT86IHN0cmluZyxcblx0Y29tcGxldGU6IENvbXBsZXRlRm4gPSBjb21wbGV0ZVNpbXBsZSxcbik6IFByb21pc2U8c3RyaW5nPiB7XG5cdGNvbnN0IG1heFRva2VucyA9IE1hdGguZmxvb3IoMC44ICogcmVzZXJ2ZVRva2Vucyk7XG5cblx0Ly8gVXNlIHVwZGF0ZSBwcm9tcHQgaWYgd2UgaGF2ZSBhIHByZXZpb3VzIHN1bW1hcnksIG90aGVyd2lzZSBpbml0aWFsIHByb21wdFxuXHRsZXQgYmFzZVByb21wdCA9IHByZXZpb3VzU3VtbWFyeSA/IFVQREFURV9TVU1NQVJJWkFUSU9OX1BST01QVCA6IFNVTU1BUklaQVRJT05fUFJPTVBUO1xuXHRpZiAoY3VzdG9tSW5zdHJ1Y3Rpb25zKSB7XG5cdFx0YmFzZVByb21wdCA9IGAke2Jhc2VQcm9tcHR9XFxuXFxuQWRkaXRpb25hbCBmb2N1czogJHtjdXN0b21JbnN0cnVjdGlvbnN9YDtcblx0fVxuXG5cdC8vIFNlcmlhbGl6ZSBjb252ZXJzYXRpb24gdG8gdGV4dCBzbyBtb2RlbCBkb2Vzbid0IHRyeSB0byBjb250aW51ZSBpdFxuXHQvLyBDb252ZXJ0IHRvIExMTSBtZXNzYWdlcyBmaXJzdCAoaGFuZGxlcyBjdXN0b20gdHlwZXMgbGlrZSBiYXNoRXhlY3V0aW9uLCBjdXN0b20sIGV0Yy4pXG5cdGNvbnN0IGxsbU1lc3NhZ2VzID0gY29udmVydFRvTGxtKGN1cnJlbnRNZXNzYWdlcyk7XG5cdGNvbnN0IGNvbnZlcnNhdGlvblRleHQgPSBzZXJpYWxpemVDb252ZXJzYXRpb24obGxtTWVzc2FnZXMpO1xuXG5cdC8vIEJ1aWxkIHRoZSBwcm9tcHQgd2l0aCBjb252ZXJzYXRpb24gd3JhcHBlZCBpbiB0YWdzXG5cdGxldCBwcm9tcHRUZXh0ID0gYDxjb252ZXJzYXRpb24+XFxuJHtjb252ZXJzYXRpb25UZXh0fVxcbjwvY29udmVyc2F0aW9uPlxcblxcbmA7XG5cdGlmIChwcmV2aW91c1N1bW1hcnkpIHtcblx0XHRwcm9tcHRUZXh0ICs9IGA8cHJldmlvdXMtc3VtbWFyeT5cXG4ke3ByZXZpb3VzU3VtbWFyeX1cXG48L3ByZXZpb3VzLXN1bW1hcnk+XFxuXFxuYDtcblx0fVxuXHRwcm9tcHRUZXh0ICs9IGJhc2VQcm9tcHQ7XG5cblx0Y29uc3QgY29tcGxldGlvbk9wdGlvbnMgPSBtb2RlbC5yZWFzb25pbmdcblx0XHQ/IHsgbWF4VG9rZW5zLCBzaWduYWwsIGFwaUtleSwgcmVhc29uaW5nOiBcImhpZ2hcIiBhcyBjb25zdCB9XG5cdFx0OiB7IG1heFRva2Vucywgc2lnbmFsLCBhcGlLZXkgfTtcblxuXHRjb25zdCByZXNwb25zZSA9IGF3YWl0IGNvbXBsZXRlKFxuXHRcdG1vZGVsLFxuXHRcdHsgc3lzdGVtUHJvbXB0OiBTVU1NQVJJWkFUSU9OX1NZU1RFTV9QUk9NUFQsIG1lc3NhZ2VzOiBjcmVhdGVTdW1tYXJpemF0aW9uTWVzc2FnZShwcm9tcHRUZXh0KSB9LFxuXHRcdGNvbXBsZXRpb25PcHRpb25zLFxuXHQpO1xuXG5cdGlmIChyZXNwb25zZS5zdG9wUmVhc29uID09PSBcImVycm9yXCIpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoYFN1bW1hcml6YXRpb24gZmFpbGVkOiAke3Jlc3BvbnNlLmVycm9yTWVzc2FnZSB8fCBcIlVua25vd24gZXJyb3JcIn1gKTtcblx0fVxuXG5cdHJldHVybiBleHRyYWN0VGV4dENvbnRlbnQocmVzcG9uc2UuY29udGVudCk7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIENvbXBhY3Rpb24gUHJlcGFyYXRpb24gKGZvciBleHRlbnNpb25zKVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbXBhY3Rpb25QcmVwYXJhdGlvbiB7XG5cdC8qKiBVVUlEIG9mIGZpcnN0IGVudHJ5IHRvIGtlZXAgKi9cblx0Zmlyc3RLZXB0RW50cnlJZDogc3RyaW5nO1xuXHQvKiogTWVzc2FnZXMgdGhhdCB3aWxsIGJlIHN1bW1hcml6ZWQgYW5kIGRpc2NhcmRlZCAqL1xuXHRtZXNzYWdlc1RvU3VtbWFyaXplOiBBZ2VudE1lc3NhZ2VbXTtcblx0LyoqIE1lc3NhZ2VzIHRoYXQgd2lsbCBiZSB0dXJuZWQgaW50byB0dXJuIHByZWZpeCBzdW1tYXJ5IChpZiBzcGxpdHRpbmcpICovXG5cdHR1cm5QcmVmaXhNZXNzYWdlczogQWdlbnRNZXNzYWdlW107XG5cdC8qKiBXaGV0aGVyIHRoaXMgaXMgYSBzcGxpdCB0dXJuIChjdXQgcG9pbnQgaW4gbWlkZGxlIG9mIHR1cm4pICovXG5cdGlzU3BsaXRUdXJuOiBib29sZWFuO1xuXHR0b2tlbnNCZWZvcmU6IG51bWJlcjtcblx0LyoqIFN1bW1hcnkgZnJvbSBwcmV2aW91cyBjb21wYWN0aW9uLCBmb3IgaXRlcmF0aXZlIHVwZGF0ZSAqL1xuXHRwcmV2aW91c1N1bW1hcnk/OiBzdHJpbmc7XG5cdC8qKiBGaWxlIG9wZXJhdGlvbnMgZXh0cmFjdGVkIGZyb20gbWVzc2FnZXNUb1N1bW1hcml6ZSAqL1xuXHRmaWxlT3BzOiBGaWxlT3BlcmF0aW9ucztcblx0LyoqIENvbXBhY3Rpb24gc2V0dGlvbnMgZnJvbSBzZXR0aW5ncy5qc29ubFx0Ki9cblx0c2V0dGluZ3M6IENvbXBhY3Rpb25TZXR0aW5ncztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHByZXBhcmVDb21wYWN0aW9uKFxuXHRwYXRoRW50cmllczogU2Vzc2lvbkVudHJ5W10sXG5cdHNldHRpbmdzOiBDb21wYWN0aW9uU2V0dGluZ3MsXG4pOiBDb21wYWN0aW9uUHJlcGFyYXRpb24gfCB1bmRlZmluZWQge1xuXHRpZiAocGF0aEVudHJpZXMubGVuZ3RoID4gMCAmJiBwYXRoRW50cmllc1twYXRoRW50cmllcy5sZW5ndGggLSAxXS50eXBlID09PSBcImNvbXBhY3Rpb25cIikge1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1cblxuXHRsZXQgcHJldkNvbXBhY3Rpb25JbmRleCA9IC0xO1xuXHRmb3IgKGxldCBpID0gcGF0aEVudHJpZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcblx0XHRpZiAocGF0aEVudHJpZXNbaV0udHlwZSA9PT0gXCJjb21wYWN0aW9uXCIpIHtcblx0XHRcdHByZXZDb21wYWN0aW9uSW5kZXggPSBpO1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXHR9XG5cdGNvbnN0IGJvdW5kYXJ5U3RhcnQgPSBwcmV2Q29tcGFjdGlvbkluZGV4ICsgMTtcblx0Y29uc3QgYm91bmRhcnlFbmQgPSBwYXRoRW50cmllcy5sZW5ndGg7XG5cblx0Y29uc3QgdXNhZ2VTdGFydCA9IHByZXZDb21wYWN0aW9uSW5kZXggPj0gMCA/IHByZXZDb21wYWN0aW9uSW5kZXggOiAwO1xuXHRjb25zdCB1c2FnZU1lc3NhZ2VzID0gY29sbGVjdE1lc3NhZ2VzKHBhdGhFbnRyaWVzLCB1c2FnZVN0YXJ0LCBib3VuZGFyeUVuZCk7XG5cdGNvbnN0IHRva2Vuc0JlZm9yZSA9IGVzdGltYXRlQ29udGV4dFRva2Vucyh1c2FnZU1lc3NhZ2VzKS50b2tlbnM7XG5cblx0Y29uc3QgY3V0UG9pbnQgPSBmaW5kQ3V0UG9pbnQocGF0aEVudHJpZXMsIGJvdW5kYXJ5U3RhcnQsIGJvdW5kYXJ5RW5kLCBzZXR0aW5ncy5rZWVwUmVjZW50VG9rZW5zKTtcblxuXHQvLyBHZXQgVVVJRCBvZiBmaXJzdCBrZXB0IGVudHJ5XG5cdGNvbnN0IGZpcnN0S2VwdEVudHJ5ID0gcGF0aEVudHJpZXNbY3V0UG9pbnQuZmlyc3RLZXB0RW50cnlJbmRleF07XG5cdGlmICghZmlyc3RLZXB0RW50cnk/LmlkKSB7XG5cdFx0cmV0dXJuIHVuZGVmaW5lZDsgLy8gU2Vzc2lvbiBuZWVkcyBtaWdyYXRpb25cblx0fVxuXHRjb25zdCBmaXJzdEtlcHRFbnRyeUlkID0gZmlyc3RLZXB0RW50cnkuaWQ7XG5cblx0Y29uc3QgaGlzdG9yeUVuZCA9IGN1dFBvaW50LmlzU3BsaXRUdXJuID8gY3V0UG9pbnQudHVyblN0YXJ0SW5kZXggOiBjdXRQb2ludC5maXJzdEtlcHRFbnRyeUluZGV4O1xuXG5cdC8vIE1lc3NhZ2VzIHRvIHN1bW1hcml6ZSAod2lsbCBiZSBkaXNjYXJkZWQgYWZ0ZXIgc3VtbWFyeSlcblx0Y29uc3QgbWVzc2FnZXNUb1N1bW1hcml6ZSA9IGNvbGxlY3RNZXNzYWdlcyhwYXRoRW50cmllcywgYm91bmRhcnlTdGFydCwgaGlzdG9yeUVuZCk7XG5cblx0Ly8gTWVzc2FnZXMgZm9yIHR1cm4gcHJlZml4IHN1bW1hcnkgKGlmIHNwbGl0dGluZyBhIHR1cm4pXG5cdGNvbnN0IHR1cm5QcmVmaXhNZXNzYWdlcyA9IGN1dFBvaW50LmlzU3BsaXRUdXJuXG5cdFx0PyBjb2xsZWN0TWVzc2FnZXMocGF0aEVudHJpZXMsIGN1dFBvaW50LnR1cm5TdGFydEluZGV4LCBjdXRQb2ludC5maXJzdEtlcHRFbnRyeUluZGV4KVxuXHRcdDogW107XG5cblx0Ly8gR2V0IHByZXZpb3VzIHN1bW1hcnkgZm9yIGl0ZXJhdGl2ZSB1cGRhdGVcblx0bGV0IHByZXZpb3VzU3VtbWFyeTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXHRpZiAocHJldkNvbXBhY3Rpb25JbmRleCA+PSAwKSB7XG5cdFx0Y29uc3QgcHJldkNvbXBhY3Rpb24gPSBwYXRoRW50cmllc1twcmV2Q29tcGFjdGlvbkluZGV4XSBhcyBDb21wYWN0aW9uRW50cnk7XG5cdFx0cHJldmlvdXNTdW1tYXJ5ID0gcHJldkNvbXBhY3Rpb24uc3VtbWFyeTtcblx0fVxuXG5cdC8vIEV4dHJhY3QgZmlsZSBvcGVyYXRpb25zIGZyb20gbWVzc2FnZXMgYW5kIHByZXZpb3VzIGNvbXBhY3Rpb25cblx0Y29uc3QgZmlsZU9wcyA9IGV4dHJhY3RGaWxlT3BlcmF0aW9ucyhtZXNzYWdlc1RvU3VtbWFyaXplLCBwYXRoRW50cmllcywgcHJldkNvbXBhY3Rpb25JbmRleCk7XG5cblx0Ly8gQWxzbyBleHRyYWN0IGZpbGUgb3BzIGZyb20gdHVybiBwcmVmaXggaWYgc3BsaXR0aW5nXG5cdGlmIChjdXRQb2ludC5pc1NwbGl0VHVybikge1xuXHRcdGZvciAoY29uc3QgbXNnIG9mIHR1cm5QcmVmaXhNZXNzYWdlcykge1xuXHRcdFx0ZXh0cmFjdEZpbGVPcHNGcm9tTWVzc2FnZShtc2csIGZpbGVPcHMpO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiB7XG5cdFx0Zmlyc3RLZXB0RW50cnlJZCxcblx0XHRtZXNzYWdlc1RvU3VtbWFyaXplLFxuXHRcdHR1cm5QcmVmaXhNZXNzYWdlcyxcblx0XHRpc1NwbGl0VHVybjogY3V0UG9pbnQuaXNTcGxpdFR1cm4sXG5cdFx0dG9rZW5zQmVmb3JlLFxuXHRcdHByZXZpb3VzU3VtbWFyeSxcblx0XHRmaWxlT3BzLFxuXHRcdHNldHRpbmdzLFxuXHR9O1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBNYWluIGNvbXBhY3Rpb24gZnVuY3Rpb25cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuY29uc3QgVFVSTl9QUkVGSVhfU1VNTUFSSVpBVElPTl9QUk9NUFQgPSBgVGhpcyBpcyB0aGUgUFJFRklYIG9mIGEgdHVybiB0aGF0IHdhcyB0b28gbGFyZ2UgdG8ga2VlcC4gVGhlIFNVRkZJWCAocmVjZW50IHdvcmspIGlzIHJldGFpbmVkLlxuXG5TdW1tYXJpemUgdGhlIHByZWZpeCB0byBwcm92aWRlIGNvbnRleHQgZm9yIHRoZSByZXRhaW5lZCBzdWZmaXg6XG5cbiMjIE9yaWdpbmFsIFJlcXVlc3RcbltXaGF0IGRpZCB0aGUgdXNlciBhc2sgZm9yIGluIHRoaXMgdHVybj9dXG5cbiMjIEVhcmx5IFByb2dyZXNzXG4tIFtLZXkgZGVjaXNpb25zIGFuZCB3b3JrIGRvbmUgaW4gdGhlIHByZWZpeF1cblxuIyMgQ29udGV4dCBmb3IgU3VmZml4XG4tIFtJbmZvcm1hdGlvbiBuZWVkZWQgdG8gdW5kZXJzdGFuZCB0aGUgcmV0YWluZWQgcmVjZW50IHdvcmtdXG5cbkJlIGNvbmNpc2UuIEZvY3VzIG9uIHdoYXQncyBuZWVkZWQgdG8gdW5kZXJzdGFuZCB0aGUga2VwdCBzdWZmaXguYDtcblxuLyoqXG4gKiBHZW5lcmF0ZSBzdW1tYXJpZXMgZm9yIGNvbXBhY3Rpb24gdXNpbmcgcHJlcGFyZWQgZGF0YS5cbiAqIFJldHVybnMgQ29tcGFjdGlvblJlc3VsdCAtIFNlc3Npb25NYW5hZ2VyIGFkZHMgdXVpZC9wYXJlbnRVdWlkIHdoZW4gc2F2aW5nLlxuICpcbiAqIEBwYXJhbSBwcmVwYXJhdGlvbiAtIFByZS1jYWxjdWxhdGVkIHByZXBhcmF0aW9uIGZyb20gcHJlcGFyZUNvbXBhY3Rpb24oKVxuICogQHBhcmFtIGN1c3RvbUluc3RydWN0aW9ucyAtIE9wdGlvbmFsIGN1c3RvbSBmb2N1cyBmb3IgdGhlIHN1bW1hcnlcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvbXBhY3QoXG5cdHByZXBhcmF0aW9uOiBDb21wYWN0aW9uUHJlcGFyYXRpb24sXG5cdG1vZGVsOiBNb2RlbDxhbnk+LFxuXHRhcGlLZXk6IHN0cmluZyB8IHVuZGVmaW5lZCxcblx0Y3VzdG9tSW5zdHJ1Y3Rpb25zPzogc3RyaW5nLFxuXHRzaWduYWw/OiBBYm9ydFNpZ25hbCxcbik6IFByb21pc2U8Q29tcGFjdGlvblJlc3VsdD4ge1xuXHRjb25zdCB7XG5cdFx0Zmlyc3RLZXB0RW50cnlJZCxcblx0XHRtZXNzYWdlc1RvU3VtbWFyaXplLFxuXHRcdHR1cm5QcmVmaXhNZXNzYWdlcyxcblx0XHRpc1NwbGl0VHVybixcblx0XHR0b2tlbnNCZWZvcmUsXG5cdFx0cHJldmlvdXNTdW1tYXJ5LFxuXHRcdGZpbGVPcHMsXG5cdFx0c2V0dGluZ3MsXG5cdH0gPSBwcmVwYXJhdGlvbjtcblxuXHQvLyBHZW5lcmF0ZSBzdW1tYXJpZXMgKGNhbiBiZSBwYXJhbGxlbCBpZiBib3RoIG5lZWRlZCkgYW5kIG1lcmdlIGludG8gb25lXG5cdGxldCBzdW1tYXJ5OiBzdHJpbmc7XG5cblx0aWYgKGlzU3BsaXRUdXJuICYmIHR1cm5QcmVmaXhNZXNzYWdlcy5sZW5ndGggPiAwKSB7XG5cdFx0Ly8gR2VuZXJhdGUgYm90aCBzdW1tYXJpZXMgaW4gcGFyYWxsZWxcblx0XHRjb25zdCBbaGlzdG9yeVJlc3VsdCwgdHVyblByZWZpeFJlc3VsdF0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG5cdFx0XHRtZXNzYWdlc1RvU3VtbWFyaXplLmxlbmd0aCA+IDBcblx0XHRcdFx0PyBnZW5lcmF0ZVN1bW1hcnkoXG5cdFx0XHRcdFx0XHRtZXNzYWdlc1RvU3VtbWFyaXplLFxuXHRcdFx0XHRcdFx0bW9kZWwsXG5cdFx0XHRcdFx0XHRzZXR0aW5ncy5yZXNlcnZlVG9rZW5zLFxuXHRcdFx0XHRcdFx0YXBpS2V5LFxuXHRcdFx0XHRcdFx0c2lnbmFsLFxuXHRcdFx0XHRcdFx0Y3VzdG9tSW5zdHJ1Y3Rpb25zLFxuXHRcdFx0XHRcdFx0cHJldmlvdXNTdW1tYXJ5LFxuXHRcdFx0XHRcdClcblx0XHRcdFx0OiBQcm9taXNlLnJlc29sdmUoXCJObyBwcmlvciBoaXN0b3J5LlwiKSxcblx0XHRcdGdlbmVyYXRlVHVyblByZWZpeFN1bW1hcnkodHVyblByZWZpeE1lc3NhZ2VzLCBtb2RlbCwgc2V0dGluZ3MucmVzZXJ2ZVRva2VucywgYXBpS2V5LCBzaWduYWwpLFxuXHRcdF0pO1xuXHRcdC8vIE1lcmdlIGludG8gc2luZ2xlIHN1bW1hcnlcblx0XHRzdW1tYXJ5ID0gYCR7aGlzdG9yeVJlc3VsdH1cXG5cXG4tLS1cXG5cXG4qKlR1cm4gQ29udGV4dCAoc3BsaXQgdHVybik6KipcXG5cXG4ke3R1cm5QcmVmaXhSZXN1bHR9YDtcblx0fSBlbHNlIHtcblx0XHQvLyBKdXN0IGdlbmVyYXRlIGhpc3Rvcnkgc3VtbWFyeVxuXHRcdHN1bW1hcnkgPSBhd2FpdCBnZW5lcmF0ZVN1bW1hcnkoXG5cdFx0XHRtZXNzYWdlc1RvU3VtbWFyaXplLFxuXHRcdFx0bW9kZWwsXG5cdFx0XHRzZXR0aW5ncy5yZXNlcnZlVG9rZW5zLFxuXHRcdFx0YXBpS2V5LFxuXHRcdFx0c2lnbmFsLFxuXHRcdFx0Y3VzdG9tSW5zdHJ1Y3Rpb25zLFxuXHRcdFx0cHJldmlvdXNTdW1tYXJ5LFxuXHRcdCk7XG5cdH1cblxuXHQvLyBDb21wdXRlIGZpbGUgbGlzdHMgYW5kIGFwcGVuZCB0byBzdW1tYXJ5XG5cdGNvbnN0IHsgcmVhZEZpbGVzLCBtb2RpZmllZEZpbGVzIH0gPSBjb21wdXRlRmlsZUxpc3RzKGZpbGVPcHMpO1xuXHRzdW1tYXJ5ICs9IGZvcm1hdEZpbGVPcGVyYXRpb25zKHJlYWRGaWxlcywgbW9kaWZpZWRGaWxlcyk7XG5cblx0aWYgKCFmaXJzdEtlcHRFbnRyeUlkKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKFwiRmlyc3Qga2VwdCBlbnRyeSBoYXMgbm8gVVVJRCAtIHNlc3Npb24gbWF5IG5lZWQgbWlncmF0aW9uXCIpO1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHRzdW1tYXJ5LFxuXHRcdGZpcnN0S2VwdEVudHJ5SWQsXG5cdFx0dG9rZW5zQmVmb3JlLFxuXHRcdGRldGFpbHM6IHsgcmVhZEZpbGVzLCBtb2RpZmllZEZpbGVzIH0gYXMgQ29tcGFjdGlvbkRldGFpbHMsXG5cdH07XG59XG5cbi8qKlxuICogR2VuZXJhdGUgYSBzdW1tYXJ5IGZvciBhIHR1cm4gcHJlZml4ICh3aGVuIHNwbGl0dGluZyBhIHR1cm4pLlxuICovXG5hc3luYyBmdW5jdGlvbiBnZW5lcmF0ZVR1cm5QcmVmaXhTdW1tYXJ5KFxuXHRtZXNzYWdlczogQWdlbnRNZXNzYWdlW10sXG5cdG1vZGVsOiBNb2RlbDxhbnk+LFxuXHRyZXNlcnZlVG9rZW5zOiBudW1iZXIsXG5cdGFwaUtleTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuXHRzaWduYWw/OiBBYm9ydFNpZ25hbCxcbik6IFByb21pc2U8c3RyaW5nPiB7XG5cdGNvbnN0IG1heFRva2VucyA9IE1hdGguZmxvb3IoMC41ICogcmVzZXJ2ZVRva2Vucyk7IC8vIFNtYWxsZXIgYnVkZ2V0IGZvciB0dXJuIHByZWZpeFxuXHRjb25zdCBsbG1NZXNzYWdlcyA9IGNvbnZlcnRUb0xsbShtZXNzYWdlcyk7XG5cdGNvbnN0IGNvbnZlcnNhdGlvblRleHQgPSBzZXJpYWxpemVDb252ZXJzYXRpb24obGxtTWVzc2FnZXMpO1xuXHRjb25zdCBwcm9tcHRUZXh0ID0gYDxjb252ZXJzYXRpb24+XFxuJHtjb252ZXJzYXRpb25UZXh0fVxcbjwvY29udmVyc2F0aW9uPlxcblxcbiR7VFVSTl9QUkVGSVhfU1VNTUFSSVpBVElPTl9QUk9NUFR9YDtcblxuXHRjb25zdCByZXNwb25zZSA9IGF3YWl0IGNvbXBsZXRlU2ltcGxlKFxuXHRcdG1vZGVsLFxuXHRcdHsgc3lzdGVtUHJvbXB0OiBTVU1NQVJJWkFUSU9OX1NZU1RFTV9QUk9NUFQsIG1lc3NhZ2VzOiBjcmVhdGVTdW1tYXJpemF0aW9uTWVzc2FnZShwcm9tcHRUZXh0KSB9LFxuXHRcdHsgbWF4VG9rZW5zLCBzaWduYWwsIGFwaUtleSB9LFxuXHQpO1xuXG5cdGlmIChyZXNwb25zZS5zdG9wUmVhc29uID09PSBcImVycm9yXCIpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoYFR1cm4gcHJlZml4IHN1bW1hcml6YXRpb24gZmFpbGVkOiAke3Jlc3BvbnNlLmVycm9yTWVzc2FnZSB8fCBcIlVua25vd24gZXJyb3JcIn1gKTtcblx0fVxuXG5c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
