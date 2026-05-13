import { getAgentDir, SettingsManager } from "@gsd/pi-coding-agent";
import { completeSimple } from "@gsd/pi-ai";
import { createHash } from "crypto";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { getFullMemory, getMemorySummary, runStartup } from "./pipeline.js";
import { MemoryStorage } from "./storage.js";
function encodeCwd(cwd) {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}
function getMemoryDir(cwd) {
  return join(getAgentDir(), "memories", encodeCwd(cwd));
}
function getDbPath() {
  return join(getAgentDir(), "agent.db");
}
let storageInstance = null;
async function getStorage() {
  if (!storageInstance) {
    storageInstance = await MemoryStorage.create(getDbPath());
  }
  return storageInstance;
}
function memoryExtension(api) {
  let memorySettings;
  try {
    const sm = SettingsManager.create();
    memorySettings = sm.getMemorySettings();
  } catch {
    memorySettings = {
      enabled: false,
      maxRolloutsPerStartup: 64,
      maxRolloutAgeDays: 30,
      minRolloutIdleHours: 12,
      stage1Concurrency: 8,
      summaryInjectionTokenLimit: 5e3
    };
  }
  if (!memorySettings.enabled) {
    api.registerCommand("memory", {
      description: "Memory extraction pipeline (disabled - enable in settings)",
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          'Memory extraction is disabled. Enable it with: settings.json \u2192 "memory": { "enabled": true }',
          "info"
        );
      }
    });
    return;
  }
  let cwd = "";
  let memoryDir = "";
  api.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    memoryDir = getMemoryDir(cwd);
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }
    const sessionsDir = join(getAgentDir(), "sessions");
    const llmCall = async (system, user, options) => {
      const model = ctx.model;
      if (!model) {
        throw new Error("No model available for memory extraction");
      }
      const result = await completeSimple(
        model,
        {
          systemPrompt: system,
          messages: [{ role: "user", content: user, timestamp: Date.now() }]
        },
        { maxTokens: options?.maxTokens ?? 4096 }
      );
      const textParts = result.content.filter((part) => part.type === "text").map((part) => part.text);
      return textParts.join("");
    };
    runStartup(
      await getStorage(),
      {
        sessionsDir,
        memoryDir,
        cwd,
        maxRolloutsPerStartup: memorySettings.maxRolloutsPerStartup,
        maxRolloutAgeDays: memorySettings.maxRolloutAgeDays,
        minRolloutIdleHours: memorySettings.minRolloutIdleHours,
        stage1Concurrency: memorySettings.stage1Concurrency
      },
      llmCall
    ).catch(() => {
    });
  });
  api.on("before_agent_start", async (_event, ctx) => {
    if (!memoryDir) {
      memoryDir = getMemoryDir(ctx.cwd);
    }
    const summary = getMemorySummary(memoryDir);
    if (summary) {
      const charLimit = memorySettings.summaryInjectionTokenLimit * 4;
      const truncated = summary.length > charLimit ? summary.slice(0, charLimit) + "\n[...truncated]" : summary;
      return {
        systemPrompt: _event.systemPrompt + "\n\n" + truncated
      };
    }
  });
  api.registerCommand("memory", {
    description: "View or manage extracted project memories",
    getArgumentCompletions: (prefix) => {
      const subcommands = [
        { label: "view", description: "View current memories (default)" },
        { label: "clear", description: "Clear all memories for this project" },
        { label: "rebuild", description: "Re-extract all memories" },
        { label: "stats", description: "Show pipeline statistics" }
      ];
      return subcommands.filter((s) => s.label.startsWith(prefix)).map((s) => ({ value: s.label, label: s.label, description: s.description }));
    },
    handler: async (args, ctx) => {
      const subcommand = args.trim().split(/\s+/)[0] || "view";
      const projectMemoryDir = getMemoryDir(ctx.cwd);
      switch (subcommand) {
        case "view": {
          const memory = getFullMemory(projectMemoryDir);
          if (memory) {
            api.sendMessage({
              customType: "memory:view",
              content: memory,
              display: true
            });
          } else {
            ctx.ui.notify(
              "No memories extracted yet. Memories are extracted on session startup.",
              "info"
            );
          }
          break;
        }
        case "clear": {
          const confirmed = await ctx.ui.confirm(
            "Clear Memories",
            "Delete all extracted memories for this project?"
          );
          if (confirmed) {
            (await getStorage()).clearForCwd(ctx.cwd);
            if (existsSync(projectMemoryDir)) {
              rmSync(projectMemoryDir, { recursive: true, force: true });
            }
            ctx.ui.notify("Memories cleared.", "info");
          }
          break;
        }
        case "rebuild": {
          const confirmed = await ctx.ui.confirm(
            "Rebuild Memories",
            "Re-extract all memories from session history? This may take a while."
          );
          if (confirmed) {
            (await getStorage()).resetAllForCwd(ctx.cwd);
            if (existsSync(projectMemoryDir)) {
              rmSync(projectMemoryDir, { recursive: true, force: true });
            }
            ctx.ui.notify(
              "Memory rebuild enqueued. Extraction will run on next session startup.",
              "info"
            );
          }
          break;
        }
        case "stats": {
          const stats = (await getStorage()).getStats();
          const statsText = [
            "Memory Pipeline Statistics:",
            `  Total sessions tracked: ${stats.totalThreads}`,
            `  Pending extraction: ${stats.pendingThreads}`,
            `  Extracted: ${stats.doneThreads}`,
            `  Errors: ${stats.errorThreads}`,
            `  Stage 1 outputs: ${stats.totalStage1Outputs}`,
            `  Pending stage 1 jobs: ${stats.pendingStage1Jobs}`,
            `  Memory dir: ${projectMemoryDir}`,
            `  Memory exists: ${existsSync(join(projectMemoryDir, "MEMORY.md"))}`
          ].join("\n");
          api.sendMessage({
            customType: "memory:stats",
            content: statsText,
            display: true
          });
          break;
        }
        default:
          ctx.ui.notify(
            `Unknown subcommand: ${subcommand}. Use: view, clear, rebuild, stats`,
            "warning"
          );
      }
    }
  });
  api.on("session_shutdown", async () => {
    if (storageInstance) {
      storageInstance.close();
      storageInstance = null;
    }
  });
}
export {
  memoryExtension as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9tZW1vcnkvaW5kZXgudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogTWVtb3J5IGV4dHJhY3Rpb24gZXh0ZW5zaW9uLlxuICpcbiAqIEF1dG9tYXRlZCB0d28tcGhhc2UgcGlwZWxpbmUgdGhhdCBleHRyYWN0cyBkdXJhYmxlIGtub3dsZWRnZSBmcm9tIHNlc3Npb25cbiAqIHRyYW5zY3JpcHRzIGFuZCBjb25zb2xpZGF0ZXMgaW50byBwcm9qZWN0LXNjb3BlZCBtZW1vcnkgYXJ0aWZhY3RzIGluamVjdGVkXG4gKiBpbnRvIGZ1dHVyZSBzZXNzaW9ucy5cbiAqXG4gKiBMaWZlY3ljbGU6XG4gKiAtIHNlc3Npb25fc3RhcnQgKGRlcHRoIDApOiBmaXJlLWFuZC1mb3JnZXQgcGlwZWxpbmUucnVuU3RhcnR1cCgpXG4gKiAtIGJlZm9yZV9hZ2VudF9zdGFydDogaW5qZWN0IG1lbW9yeV9zdW1tYXJ5Lm1kIGludG8gc3lzdGVtIHByb21wdFxuICogLSAvbWVtb3J5IGNvbW1hbmQ6IHZpZXcsIGNsZWFyLCByZWJ1aWxkLCBzdGF0c1xuICovXG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBnZXRBZ2VudERpciwgU2V0dGluZ3NNYW5hZ2VyIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBjb21wbGV0ZVNpbXBsZSB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSBcImNyeXB0b1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCBybVN5bmMgfSBmcm9tIFwiZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwicGF0aFwiO1xuaW1wb3J0IHsgZ2V0RnVsbE1lbW9yeSwgZ2V0TWVtb3J5U3VtbWFyeSwgcnVuU3RhcnR1cCB9IGZyb20gXCIuL3BpcGVsaW5lLmpzXCI7XG5pbXBvcnQgeyBNZW1vcnlTdG9yYWdlIH0gZnJvbSBcIi4vc3RvcmFnZS5qc1wiO1xuXG4vKiogRW5jb2RlIGN3ZCB0byBhIGZpbGVzeXN0ZW0tc2FmZSBkaXJlY3RvcnkgbmFtZSAqL1xuZnVuY3Rpb24gZW5jb2RlQ3dkKGN3ZDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKGN3ZCkuZGlnZXN0KFwiaGV4XCIpLnNsaWNlKDAsIDE2KTtcbn1cblxuLyoqIEdldCB0aGUgbWVtb3J5IGRpcmVjdG9yeSBmb3IgYSBwcm9qZWN0ICovXG5mdW5jdGlvbiBnZXRNZW1vcnlEaXIoY3dkOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gam9pbihnZXRBZ2VudERpcigpLCBcIm1lbW9yaWVzXCIsIGVuY29kZUN3ZChjd2QpKTtcbn1cblxuLyoqIEdldCB0aGUgZGF0YWJhc2UgcGF0aCAqL1xuZnVuY3Rpb24gZ2V0RGJQYXRoKCk6IHN0cmluZyB7XG5cdHJldHVybiBqb2luKGdldEFnZW50RGlyKCksIFwiYWdlbnQuZGJcIik7XG59XG5cbmxldCBzdG9yYWdlSW5zdGFuY2U6IE1lbW9yeVN0b3JhZ2UgfCBudWxsID0gbnVsbDtcblxuYXN5bmMgZnVuY3Rpb24gZ2V0U3RvcmFnZSgpOiBQcm9taXNlPE1lbW9yeVN0b3JhZ2U+IHtcblx0aWYgKCFzdG9yYWdlSW5zdGFuY2UpIHtcblx0XHRzdG9yYWdlSW5zdGFuY2UgPSBhd2FpdCBNZW1vcnlTdG9yYWdlLmNyZWF0ZShnZXREYlBhdGgoKSk7XG5cdH1cblx0cmV0dXJuIHN0b3JhZ2VJbnN0YW5jZTtcbn1cblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gbWVtb3J5RXh0ZW5zaW9uKGFwaTogRXh0ZW5zaW9uQVBJKTogdm9pZCB7XG5cdGludGVyZmFjZSBNZW1vcnlTZXR0aW5nc1Jlc29sdmVkIHtcblx0XHRlbmFibGVkOiBib29sZWFuO1xuXHRcdG1heFJvbGxvdXRzUGVyU3RhcnR1cDogbnVtYmVyO1xuXHRcdG1heFJvbGxvdXRBZ2VEYXlzOiBudW1iZXI7XG5cdFx0bWluUm9sbG91dElkbGVIb3VyczogbnVtYmVyO1xuXHRcdHN0YWdlMUNvbmN1cnJlbmN5OiBudW1iZXI7XG5cdFx0c3VtbWFyeUluamVjdGlvblRva2VuTGltaXQ6IG51bWJlcjtcblx0fVxuXG5cdGxldCBtZW1vcnlTZXR0aW5nczogTWVtb3J5U2V0dGluZ3NSZXNvbHZlZDtcblx0dHJ5IHtcblx0XHRjb25zdCBzbSA9IFNldHRpbmdzTWFuYWdlci5jcmVhdGUoKTtcblx0XHRtZW1vcnlTZXR0aW5ncyA9IHNtLmdldE1lbW9yeVNldHRpbmdzKCk7XG5cdH0gY2F0Y2gge1xuXHRcdG1lbW9yeVNldHRpbmdzID0ge1xuXHRcdFx0ZW5hYmxlZDogZmFsc2UsXG5cdFx0XHRtYXhSb2xsb3V0c1BlclN0YXJ0dXA6IDY0LFxuXHRcdFx0bWF4Um9sbG91dEFnZURheXM6IDMwLFxuXHRcdFx0bWluUm9sbG91dElkbGVIb3VyczogMTIsXG5cdFx0XHRzdGFnZTFDb25jdXJyZW5jeTogOCxcblx0XHRcdHN1bW1hcnlJbmplY3Rpb25Ub2tlbkxpbWl0OiA1MDAwLFxuXHRcdH07XG5cdH1cblxuXHRpZiAoIW1lbW9yeVNldHRpbmdzLmVuYWJsZWQpIHtcblx0XHRhcGkucmVnaXN0ZXJDb21tYW5kKFwibWVtb3J5XCIsIHtcblx0XHRcdGRlc2NyaXB0aW9uOiBcIk1lbW9yeSBleHRyYWN0aW9uIHBpcGVsaW5lIChkaXNhYmxlZCAtIGVuYWJsZSBpbiBzZXR0aW5ncylcIixcblx0XHRcdGhhbmRsZXI6IGFzeW5jIChfYXJncywgY3R4KSA9PiB7XG5cdFx0XHRcdGN0eC51aS5ub3RpZnkoXG5cdFx0XHRcdFx0J01lbW9yeSBleHRyYWN0aW9uIGlzIGRpc2FibGVkLiBFbmFibGUgaXQgd2l0aDogc2V0dGluZ3MuanNvbiBcXHUyMTkyIFwibWVtb3J5XCI6IHsgXCJlbmFibGVkXCI6IHRydWUgfScsXG5cdFx0XHRcdFx0XCJpbmZvXCIsXG5cdFx0XHRcdCk7XG5cdFx0XHR9LFxuXHRcdH0pO1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGxldCBjd2QgPSBcIlwiO1xuXHRsZXQgbWVtb3J5RGlyID0gXCJcIjtcblxuXHQvLyBPbiBzZXNzaW9uIHN0YXJ0LCBmaXJlLWFuZC1mb3JnZXQgdGhlIHBpcGVsaW5lXG5cdGFwaS5vbihcInNlc3Npb25fc3RhcnRcIiwgYXN5bmMgKF9ldmVudCwgY3R4KSA9PiB7XG5cdFx0Y3dkID0gY3R4LmN3ZDtcblx0XHRtZW1vcnlEaXIgPSBnZXRNZW1vcnlEaXIoY3dkKTtcblxuXHRcdGlmICghZXhpc3RzU3luYyhtZW1vcnlEaXIpKSB7XG5cdFx0XHRta2RpclN5bmMobWVtb3J5RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHR9XG5cblx0XHRjb25zdCBzZXNzaW9uc0RpciA9IGpvaW4oZ2V0QWdlbnREaXIoKSwgXCJzZXNzaW9uc1wiKTtcblxuXHRcdC8vIENyZWF0ZSB0aGUgTExNIGNhbGwgZnVuY3Rpb24gdXNpbmcgdGhlIGV4dGVuc2lvbiBjb250ZXh0XG5cdFx0Y29uc3QgbGxtQ2FsbCA9IGFzeW5jIChcblx0XHRcdHN5c3RlbTogc3RyaW5nLFxuXHRcdFx0dXNlcjogc3RyaW5nLFxuXHRcdFx0b3B0aW9ucz86IHsgbWF4VG9rZW5zPzogbnVtYmVyIH0sXG5cdFx0KTogUHJvbWlzZTxzdHJpbmc+ID0+IHtcblx0XHRcdGNvbnN0IG1vZGVsID0gY3R4Lm1vZGVsO1xuXHRcdFx0aWYgKCFtb2RlbCkge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJObyBtb2RlbCBhdmFpbGFibGUgZm9yIG1lbW9yeSBleHRyYWN0aW9uXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBjb21wbGV0ZVNpbXBsZShcblx0XHRcdFx0bW9kZWwsXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRzeXN0ZW1Qcm9tcHQ6IHN5c3RlbSxcblx0XHRcdFx0XHRtZXNzYWdlczogW3sgcm9sZTogXCJ1c2VyXCIgYXMgY29uc3QsIGNvbnRlbnQ6IHVzZXIsIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9XSxcblx0XHRcdFx0fSxcblx0XHRcdFx0eyBtYXhUb2tlbnM6IG9wdGlvbnM/Lm1heFRva2VucyA/PyA0MDk2IH0sXG5cdFx0XHQpO1xuXG5cdFx0XHQvLyBFeHRyYWN0IHRleHQgZnJvbSB0aGUgcmVzdWx0XG5cdFx0XHRjb25zdCB0ZXh0UGFydHMgPSByZXN1bHQuY29udGVudFxuXHRcdFx0XHQuZmlsdGVyKChwYXJ0KSA9PiBwYXJ0LnR5cGUgPT09IFwidGV4dFwiKVxuXHRcdFx0XHQubWFwKChwYXJ0KSA9PiBwYXJ0LnRleHQpO1xuXHRcdFx0cmV0dXJuIHRleHRQYXJ0cy5qb2luKFwiXCIpO1xuXHRcdH07XG5cblx0XHQvLyBGaXJlIGFuZCBmb3JnZXRcblx0XHRydW5TdGFydHVwKFxuXHRcdFx0YXdhaXQgZ2V0U3RvcmFnZSgpLFxuXHRcdFx0e1xuXHRcdFx0XHRzZXNzaW9uc0Rpcixcblx0XHRcdFx0bWVtb3J5RGlyLFxuXHRcdFx0XHRjd2QsXG5cdFx0XHRcdG1heFJvbGxvdXRzUGVyU3RhcnR1cDogbWVtb3J5U2V0dGluZ3MubWF4Um9sbG91dHNQZXJTdGFydHVwLFxuXHRcdFx0XHRtYXhSb2xsb3V0QWdlRGF5czogbWVtb3J5U2V0dGluZ3MubWF4Um9sbG91dEFnZURheXMsXG5cdFx0XHRcdG1pblJvbGxvdXRJZGxlSG91cnM6IG1lbW9yeVNldHRpbmdzLm1pblJvbGxvdXRJZGxlSG91cnMsXG5cdFx0XHRcdHN0YWdlMUNvbmN1cnJlbmN5OiBtZW1vcnlTZXR0aW5ncy5zdGFnZTFDb25jdXJyZW5jeSxcblx0XHRcdH0sXG5cdFx0XHRsbG1DYWxsLFxuXHRcdCkuY2F0Y2goKCkgPT4ge1xuXHRcdFx0Ly8gTWVtb3J5IGV4dHJhY3Rpb24gaXMgYmVzdC1lZmZvcnRcblx0XHR9KTtcblx0fSk7XG5cblx0Ly8gSW5qZWN0IG1lbW9yeSBzdW1tYXJ5IGludG8gc3lzdGVtIHByb21wdFxuXHRhcGkub24oXCJiZWZvcmVfYWdlbnRfc3RhcnRcIiwgYXN5bmMgKF9ldmVudCwgY3R4KSA9PiB7XG5cdFx0aWYgKCFtZW1vcnlEaXIpIHtcblx0XHRcdG1lbW9yeURpciA9IGdldE1lbW9yeURpcihjdHguY3dkKTtcblx0XHR9XG5cblx0XHRjb25zdCBzdW1tYXJ5ID0gZ2V0TWVtb3J5U3VtbWFyeShtZW1vcnlEaXIpO1xuXHRcdGlmIChzdW1tYXJ5KSB7XG5cdFx0XHRjb25zdCBjaGFyTGltaXQgPSBtZW1vcnlTZXR0aW5ncy5zdW1tYXJ5SW5qZWN0aW9uVG9rZW5MaW1pdCAqIDQ7XG5cdFx0XHRjb25zdCB0cnVuY2F0ZWQgPVxuXHRcdFx0XHRzdW1tYXJ5Lmxlbmd0aCA+IGNoYXJMaW1pdFxuXHRcdFx0XHRcdD8gc3VtbWFyeS5zbGljZSgwLCBjaGFyTGltaXQpICsgXCJcXG5bLi4udHJ1bmNhdGVkXVwiXG5cdFx0XHRcdFx0OiBzdW1tYXJ5O1xuXG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRzeXN0ZW1Qcm9tcHQ6IF9ldmVudC5zeXN0ZW1Qcm9tcHQgKyBcIlxcblxcblwiICsgdHJ1bmNhdGVkLFxuXHRcdFx0fTtcblx0XHR9XG5cdH0pO1xuXG5cdC8vIFJlZ2lzdGVyIC9tZW1vcnkgY29tbWFuZFxuXHRhcGkucmVnaXN0ZXJDb21tYW5kKFwibWVtb3J5XCIsIHtcblx0XHRkZXNjcmlwdGlvbjogXCJWaWV3IG9yIG1hbmFnZSBleHRyYWN0ZWQgcHJvamVjdCBtZW1vcmllc1wiLFxuXHRcdGdldEFyZ3VtZW50Q29tcGxldGlvbnM6IChwcmVmaXgpID0+IHtcblx0XHRcdGNvbnN0IHN1YmNvbW1hbmRzID0gW1xuXHRcdFx0XHR7IGxhYmVsOiBcInZpZXdcIiwgZGVzY3JpcHRpb246IFwiVmlldyBjdXJyZW50IG1lbW9yaWVzIChkZWZhdWx0KVwiIH0sXG5cdFx0XHRcdHsgbGFiZWw6IFwiY2xlYXJcIiwgZGVzY3JpcHRpb246IFwiQ2xlYXIgYWxsIG1lbW9yaWVzIGZvciB0aGlzIHByb2plY3RcIiB9LFxuXHRcdFx0XHR7IGxhYmVsOiBcInJlYnVpbGRcIiwgZGVzY3JpcHRpb246IFwiUmUtZXh0cmFjdCBhbGwgbWVtb3JpZXNcIiB9LFxuXHRcdFx0XHR7IGxhYmVsOiBcInN0YXRzXCIsIGRlc2NyaXB0aW9uOiBcIlNob3cgcGlwZWxpbmUgc3RhdGlzdGljc1wiIH0sXG5cdFx0XHRdO1xuXHRcdFx0cmV0dXJuIHN1YmNvbW1hbmRzXG5cdFx0XHRcdC5maWx0ZXIoKHMpID0+IHMubGFiZWwuc3RhcnRzV2l0aChwcmVmaXgpKVxuXHRcdFx0XHQubWFwKChzKSA9PiAoeyB2YWx1ZTogcy5sYWJlbCwgbGFiZWw6IHMubGFiZWwsIGRlc2NyaXB0aW9uOiBzLmRlc2NyaXB0aW9uIH0pKTtcblx0XHR9LFxuXHRcdGhhbmRsZXI6IGFzeW5jIChhcmdzLCBjdHgpID0+IHtcblx0XHRcdGNvbnN0IHN1YmNvbW1hbmQgPSBhcmdzLnRyaW0oKS5zcGxpdCgvXFxzKy8pWzBdIHx8IFwidmlld1wiO1xuXHRcdFx0Y29uc3QgcHJvamVjdE1lbW9yeURpciA9IGdldE1lbW9yeURpcihjdHguY3dkKTtcblxuXHRcdFx0c3dpdGNoIChzdWJjb21tYW5kKSB7XG5cdFx0XHRcdGNhc2UgXCJ2aWV3XCI6IHtcblx0XHRcdFx0XHRjb25zdCBtZW1vcnkgPSBnZXRGdWxsTWVtb3J5KHByb2plY3RNZW1vcnlEaXIpO1xuXHRcdFx0XHRcdGlmIChtZW1vcnkpIHtcblx0XHRcdFx0XHRcdGFwaS5zZW5kTWVzc2FnZSh7XG5cdFx0XHRcdFx0XHRcdGN1c3RvbVR5cGU6IFwibWVtb3J5OnZpZXdcIixcblx0XHRcdFx0XHRcdFx0Y29udGVudDogbWVtb3J5LFxuXHRcdFx0XHRcdFx0XHRkaXNwbGF5OiB0cnVlLFxuXHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdGN0eC51aS5ub3RpZnkoXG5cdFx0XHRcdFx0XHRcdFwiTm8gbWVtb3JpZXMgZXh0cmFjdGVkIHlldC4gTWVtb3JpZXMgYXJlIGV4dHJhY3RlZCBvbiBzZXNzaW9uIHN0YXJ0dXAuXCIsXG5cdFx0XHRcdFx0XHRcdFwiaW5mb1wiLFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjYXNlIFwiY2xlYXJcIjoge1xuXHRcdFx0XHRcdGNvbnN0IGNvbmZpcm1lZCA9IGF3YWl0IGN0eC51aS5jb25maXJtKFxuXHRcdFx0XHRcdFx0XCJDbGVhciBNZW1vcmllc1wiLFxuXHRcdFx0XHRcdFx0XCJEZWxldGUgYWxsIGV4dHJhY3RlZCBtZW1vcmllcyBmb3IgdGhpcyBwcm9qZWN0P1wiLFxuXHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0aWYgKGNvbmZpcm1lZCkge1xuXHRcdFx0XHRcdFx0KGF3YWl0IGdldFN0b3JhZ2UoKSkuY2xlYXJGb3JDd2QoY3R4LmN3ZCk7XG5cdFx0XHRcdFx0XHRpZiAoZXhpc3RzU3luYyhwcm9qZWN0TWVtb3J5RGlyKSkge1xuXHRcdFx0XHRcdFx0XHRybVN5bmMocHJvamVjdE1lbW9yeURpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0Y3R4LnVpLm5vdGlmeShcIk1lbW9yaWVzIGNsZWFyZWQuXCIsIFwiaW5mb1wiKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjYXNlIFwicmVidWlsZFwiOiB7XG5cdFx0XHRcdFx0Y29uc3QgY29uZmlybWVkID0gYXdhaXQgY3R4LnVpLmNvbmZpcm0oXG5cdFx0XHRcdFx0XHRcIlJlYnVpbGQgTWVtb3JpZXNcIixcblx0XHRcdFx0XHRcdFwiUmUtZXh0cmFjdCBhbGwgbWVtb3JpZXMgZnJvbSBzZXNzaW9uIGhpc3Rvcnk/IFRoaXMgbWF5IHRha2UgYSB3aGlsZS5cIixcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdGlmIChjb25maXJtZWQpIHtcblx0XHRcdFx0XHRcdChhd2FpdCBnZXRTdG9yYWdlKCkpLnJlc2V0QWxsRm9yQ3dkKGN0eC5jd2QpO1xuXHRcdFx0XHRcdFx0aWYgKGV4aXN0c1N5bmMocHJvamVjdE1lbW9yeURpcikpIHtcblx0XHRcdFx0XHRcdFx0cm1TeW5jKHByb2plY3RNZW1vcnlEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGN0eC51aS5ub3RpZnkoXG5cdFx0XHRcdFx0XHRcdFwiTWVtb3J5IHJlYnVpbGQgZW5xdWV1ZWQuIEV4dHJhY3Rpb24gd2lsbCBydW4gb24gbmV4dCBzZXNzaW9uIHN0YXJ0dXAuXCIsXG5cdFx0XHRcdFx0XHRcdFwiaW5mb1wiLFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjYXNlIFwic3RhdHNcIjoge1xuXHRcdFx0XHRcdGNvbnN0IHN0YXRzID0gKGF3YWl0IGdldFN0b3JhZ2UoKSkuZ2V0U3RhdHMoKTtcblx0XHRcdFx0XHRjb25zdCBzdGF0c1RleHQgPSBbXG5cdFx0XHRcdFx0XHRcIk1lbW9yeSBQaXBlbGluZSBTdGF0aXN0aWNzOlwiLFxuXHRcdFx0XHRcdFx0YCAgVG90YWwgc2Vzc2lvbnMgdHJhY2tlZDogJHtzdGF0cy50b3RhbFRocmVhZHN9YCxcblx0XHRcdFx0XHRcdGAgIFBlbmRpbmcgZXh0cmFjdGlvbjogJHtzdGF0cy5wZW5kaW5nVGhyZWFkc31gLFxuXHRcdFx0XHRcdFx0YCAgRXh0cmFjdGVkOiAke3N0YXRzLmRvbmVUaHJlYWRzfWAsXG5cdFx0XHRcdFx0XHRgICBFcnJvcnM6ICR7c3RhdHMuZXJyb3JUaHJlYWRzfWAsXG5cdFx0XHRcdFx0XHRgICBTdGFnZSAxIG91dHB1dHM6ICR7c3RhdHMudG90YWxTdGFnZTFPdXRwdXRzfWAsXG5cdFx0XHRcdFx0XHRgICBQZW5kaW5nIHN0YWdlIDEgam9iczogJHtzdGF0cy5wZW5kaW5nU3RhZ2UxSm9ic31gLFxuXHRcdFx0XHRcdFx0YCAgTWVtb3J5IGRpcjogJHtwcm9qZWN0TWVtb3J5RGlyfWAsXG5cdFx0XHRcdFx0XHRgICBNZW1vcnkgZXhpc3RzOiAke2V4aXN0c1N5bmMoam9pbihwcm9qZWN0TWVtb3J5RGlyLCBcIk1FTU9SWS5tZFwiKSl9YCxcblx0XHRcdFx0XHRdLmpvaW4oXCJcXG5cIik7XG5cdFx0XHRcdFx0YXBpLnNlbmRNZXNzYWdlKHtcblx0XHRcdFx0XHRcdGN1c3RvbVR5cGU6IFwibWVtb3J5OnN0YXRzXCIsXG5cdFx0XHRcdFx0XHRjb250ZW50OiBzdGF0c1RleHQsXG5cdFx0XHRcdFx0XHRkaXNwbGF5OiB0cnVlLFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0ZGVmYXVsdDpcblx0XHRcdFx0XHRjdHgudWkubm90aWZ5KFxuXHRcdFx0XHRcdFx0YFVua25vd24gc3ViY29tbWFuZDogJHtzdWJjb21tYW5kfS4gVXNlOiB2aWV3LCBjbGVhciwgcmVidWlsZCwgc3RhdHNgLFxuXHRcdFx0XHRcdFx0XCJ3YXJuaW5nXCIsXG5cdFx0XHRcdFx0KTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyBDbGVhbnVwIG9uIHNodXRkb3duXG5cdGFwaS5vbihcInNlc3Npb25fc2h1dGRvd25cIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGlmIChzdG9yYWdlSW5zdGFuY2UpIHtcblx0XHRcdHN0b3JhZ2VJbnN0YW5jZS5jbG9zZSgpO1xuXHRcdFx0c3RvcmFnZUluc3RhbmNlID0gbnVsbDtcblx0XHR9XG5cdH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBY0EsU0FBUyxhQUFhLHVCQUF1QjtBQUM3QyxTQUFTLHNCQUFzQjtBQUMvQixTQUFTLGtCQUFrQjtBQUMzQixTQUFTLFlBQVksV0FBVyxjQUFjO0FBQzlDLFNBQVMsWUFBWTtBQUNyQixTQUFT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
