import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBridgeRuntimeConfig } from "./bridge-service.js";
import { resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.js";
const UNDO_MAX_BUFFER = 2 * 1024 * 1024;
const UNDO_MODULE_ENV = "GSD_UNDO_MODULE";
const PATHS_MODULE_ENV = "GSD_PATHS_MODULE";
function resolveTsLoaderPath(packageRoot) {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
}
async function collectUndoInfo(projectCwdOverride) {
  const config = resolveBridgeRuntimeConfig(void 0, projectCwdOverride);
  const { projectCwd } = config;
  const gsdDir = join(projectCwd, ".gsd");
  const completedPath = join(gsdDir, "completed-units.json");
  const empty = {
    lastUnitType: null,
    lastUnitId: null,
    lastUnitKey: null,
    completedCount: 0,
    commits: []
  };
  if (!existsSync(completedPath)) return empty;
  let entries;
  try {
    entries = JSON.parse(readFileSync(completedPath, "utf-8"));
  } catch {
    return empty;
  }
  if (!Array.isArray(entries) || entries.length === 0) return empty;
  const last = entries[entries.length - 1];
  const unitType = last.type ?? null;
  const unitId = last.id ?? null;
  const unitKey = last.key ?? (unitType && unitId ? `${unitType}:${unitId}` : null);
  const activityDir = join(gsdDir, "activity");
  let commits = [];
  if (unitType && unitId && existsSync(activityDir)) {
    try {
      const { readdirSync } = await import("node:fs");
      const safeUnitId = unitId.replace(/\//g, "-");
      const files = readdirSync(activityDir).filter((f) => f.includes(unitType) && f.includes(safeUnitId) && f.endsWith(".jsonl")).sort().reverse();
      if (files.length > 0) {
        const content = readFileSync(join(activityDir, files[0]), "utf-8");
        const shaRegex = /\b[0-9a-f]{7,40}\b/g;
        const commitSet = /* @__PURE__ */ new Set();
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry?.message?.content) {
              const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
              for (const block of blocks) {
                if (block.type === "tool_result" && typeof block.content === "string") {
                  const matches = block.content.match(shaRegex);
                  if (matches) {
                    for (const sha of matches) {
                      if (sha.length >= 7 && !commitSet.has(sha)) {
                        commitSet.add(sha);
                        commits.push(sha);
                      }
                    }
                  }
                }
              }
            }
          } catch {
          }
        }
      }
    } catch {
    }
  }
  return {
    lastUnitType: unitType,
    lastUnitId: unitId,
    lastUnitKey: unitKey,
    completedCount: entries.length,
    commits
  };
}
async function executeUndo(projectCwdOverride) {
  const config = resolveBridgeRuntimeConfig(void 0, projectCwdOverride);
  const { packageRoot, projectCwd } = config;
  const resolveTsLoader = resolveTsLoaderPath(packageRoot);
  const undoResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/undo.ts");
  const pathsResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/paths.ts");
  const undoModulePath = undoResolution.modulePath;
  const pathsModulePath = pathsResolution.modulePath;
  if (!undoResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(undoModulePath) || !existsSync(pathsModulePath))) {
    throw new Error(
      `undo service modules not found; checked=${resolveTsLoader},${undoModulePath},${pathsModulePath}`
    );
  }
  if (undoResolution.useCompiledJs && (!existsSync(undoModulePath) || !existsSync(pathsModulePath))) {
    throw new Error(`undo service modules not found; checked=${undoModulePath},${pathsModulePath}`);
  }
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    'const { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } = await import("node:fs");',
    'const { join } = await import("node:path");',
    `const undoMod = await import(pathToFileURL(process.env.${UNDO_MODULE_ENV}).href);`,
    `const pathsMod = await import(pathToFileURL(process.env.${PATHS_MODULE_ENV}).href);`,
    "const basePath = process.env.GSD_UNDO_BASE;",
    "const gsdDir = pathsMod.gsdRoot(basePath);",
    'const completedPath = join(gsdDir, "completed-units.json");',
    'if (!existsSync(completedPath)) { process.stdout.write(JSON.stringify({ success: false, message: "No completed units to undo" })); process.exit(0); }',
    "let entries;",
    'try { entries = JSON.parse(readFileSync(completedPath, "utf-8")); } catch { process.stdout.write(JSON.stringify({ success: false, message: "Could not parse completed-units.json" })); process.exit(0); }',
    'if (!Array.isArray(entries) || entries.length === 0) { process.stdout.write(JSON.stringify({ success: false, message: "No completed units to undo" })); process.exit(0); }',
    "const last = entries[entries.length - 1];",
    "const unitType = last.type;",
    "const unitId = last.id;",
    'const parts = unitId ? unitId.split("/") : [];',
    "let planUpdated = false;",
    'if (unitType === "execute-task" && parts.length === 3) { const [mid, sid, tid] = parts; planUpdated = undoMod.uncheckTaskInPlan(basePath, mid, sid, tid); }',
    "let commitsReverted = 0;",
    'const activityDir = join(gsdDir, "activity");',
    "if (existsSync(activityDir)) {",
    "  const commits = undoMod.findCommitsForUnit(activityDir, unitType, unitId);",
    "  if (commits.length > 0) {",
    '    const { execFileSync } = await import("node:child_process");',
    "    for (const sha of commits.reverse()) {",
    '      try { execFileSync("git", ["revert", "--no-commit", sha], { cwd: basePath, stdio: "pipe" }); commitsReverted++; }',
    '      catch { try { execFileSync("git", ["revert", "--abort"], { cwd: basePath, stdio: "pipe" }); } catch {} break; }',
    "    }",
    "  }",
    "}",
    "entries.pop();",
    'writeFileSync(completedPath, JSON.stringify(entries, null, 2), "utf-8");',
    "const results = [`Undone: ${unitType} (${unitId})`];",
    'results.push("  - Removed from completed-units.json");',
    'if (planUpdated) results.push("  - Unchecked task in PLAN");',
    "if (commitsReverted > 0) { results.push(`  - Reverted ${commitsReverted} commit(s) (staged, not committed)`); }",
    'process.stdout.write(JSON.stringify({ success: true, message: results.join("\\n") }));'
  ].join(" ");
  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, undoResolution, pathToFileURL(resolveTsLoader).href);
  return await new Promise((resolveResult, reject) => {
    execFile(
      process.execPath,
      [
        ...prefixArgs,
        "--eval",
        script
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          [UNDO_MODULE_ENV]: undoModulePath,
          [PATHS_MODULE_ENV]: pathsModulePath,
          GSD_UNDO_BASE: projectCwd
        },
        maxBuffer: UNDO_MAX_BUFFER,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`undo subprocess failed: ${stderr || error.message}`));
          return;
        }
        try {
          resolveResult(JSON.parse(stdout));
        } catch (parseError) {
          reject(
            new Error(
              `undo subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            )
          );
        }
      }
    );
  });
}
export {
  collectUndoInfo,
  executeUndo
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3dlYi91bmRvLXNlcnZpY2UudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGV4ZWNGaWxlIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiXG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiXG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCJcblxuaW1wb3J0IHsgcmVzb2x2ZUJyaWRnZVJ1bnRpbWVDb25maWcgfSBmcm9tIFwiLi9icmlkZ2Utc2VydmljZS50c1wiXG5pbXBvcnQgeyByZXNvbHZlVHlwZVN0cmlwcGluZ0ZsYWcsIHJlc29sdmVTdWJwcm9jZXNzTW9kdWxlLCBidWlsZFN1YnByb2Nlc3NQcmVmaXhBcmdzIH0gZnJvbSBcIi4vdHMtc3VicHJvY2Vzcy1mbGFncy50c1wiXG5pbXBvcnQgdHlwZSB7IFVuZG9JbmZvLCBVbmRvUmVzdWx0IH0gZnJvbSBcIi4uLy4uL3dlYi9saWIvcmVtYWluaW5nLWNvbW1hbmQtdHlwZXMudHNcIlxuXG5jb25zdCBVTkRPX01BWF9CVUZGRVIgPSAyICogMTAyNCAqIDEwMjRcbmNvbnN0IFVORE9fTU9EVUxFX0VOViA9IFwiR1NEX1VORE9fTU9EVUxFXCJcbmNvbnN0IFBBVEhTX01PRFVMRV9FTlYgPSBcIkdTRF9QQVRIU19NT0RVTEVcIlxuXG5mdW5jdGlvbiByZXNvbHZlVHNMb2FkZXJQYXRoKHBhY2thZ2VSb290OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihwYWNrYWdlUm9vdCwgXCJzcmNcIiwgXCJyZXNvdXJjZXNcIiwgXCJleHRlbnNpb25zXCIsIFwiZ3NkXCIsIFwidGVzdHNcIiwgXCJyZXNvbHZlLXRzLm1qc1wiKVxufVxuXG4vKipcbiAqIENvbGxlY3RzIGluZm9ybWF0aW9uIGFib3V0IHRoZSBsYXN0IGNvbXBsZXRlZCB1bml0IGZvciBkaXNwbGF5IGluIHRoZSB1bmRvIHBhbmVsLlxuICogUmVhZHMgY29tcGxldGVkLXVuaXRzLmpzb24gZGlyZWN0bHkgKHBsYWluIEpTT04sIG5vIGNoaWxkIHByb2Nlc3MgbmVlZGVkKVxuICogYW5kIHNjYW5zIHRoZSBhY3Rpdml0eSBsb2cgZGlyZWN0b3J5IGZvciBhc3NvY2lhdGVkIGNvbW1pdHMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb2xsZWN0VW5kb0luZm8ocHJvamVjdEN3ZE92ZXJyaWRlPzogc3RyaW5nKTogUHJvbWlzZTxVbmRvSW5mbz4ge1xuICBjb25zdCBjb25maWcgPSByZXNvbHZlQnJpZGdlUnVudGltZUNvbmZpZyh1bmRlZmluZWQsIHByb2plY3RDd2RPdmVycmlkZSlcbiAgY29uc3QgeyBwcm9qZWN0Q3dkIH0gPSBjb25maWdcblxuICBjb25zdCBnc2REaXIgPSBqb2luKHByb2plY3RDd2QsIFwiLmdzZFwiKVxuICBjb25zdCBjb21wbGV0ZWRQYXRoID0gam9pbihnc2REaXIsIFwiY29tcGxldGVkLXVuaXRzLmpzb25cIilcblxuICBjb25zdCBlbXB0eTogVW5kb0luZm8gPSB7XG4gICAgbGFzdFVuaXRUeXBlOiBudWxsLFxuICAgIGxhc3RVbml0SWQ6IG51bGwsXG4gICAgbGFzdFVuaXRLZXk6IG51bGwsXG4gICAgY29tcGxldGVkQ291bnQ6IDAsXG4gICAgY29tbWl0czogW10sXG4gIH1cblxuICBpZiAoIWV4aXN0c1N5bmMoY29tcGxldGVkUGF0aCkpIHJldHVybiBlbXB0eVxuXG4gIGxldCBlbnRyaWVzOiBBcnJheTx7IHR5cGU6IHN0cmluZzsgaWQ6IHN0cmluZzsga2V5Pzogc3RyaW5nIH0+XG4gIHRyeSB7XG4gICAgZW50cmllcyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGNvbXBsZXRlZFBhdGgsIFwidXRmLThcIikpXG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBlbXB0eVxuICB9XG5cbiAgaWYgKCFBcnJheS5pc0FycmF5KGVudHJpZXMpIHx8IGVudHJpZXMubGVuZ3RoID09PSAwKSByZXR1cm4gZW1wdHlcblxuICBjb25zdCBsYXN0ID0gZW50cmllc1tlbnRyaWVzLmxlbmd0aCAtIDFdXG4gIGNvbnN0IHVuaXRUeXBlID0gbGFzdC50eXBlID8/IG51bGxcbiAgY29uc3QgdW5pdElkID0gbGFzdC5pZCA/PyBudWxsXG4gIGNvbnN0IHVuaXRLZXkgPSBsYXN0LmtleSA/PyAodW5pdFR5cGUgJiYgdW5pdElkID8gYCR7dW5pdFR5cGV9OiR7dW5pdElkfWAgOiBudWxsKVxuXG4gIC8vIFNjYW4gYWN0aXZpdHkgbG9nIGZvciBhc3NvY2lhdGVkIGNvbW1pdHNcbiAgY29uc3QgYWN0aXZpdHlEaXIgPSBqb2luKGdzZERpciwgXCJhY3Rpdml0eVwiKVxuICBsZXQgY29tbWl0czogc3RyaW5nW10gPSBbXVxuICBpZiAodW5pdFR5cGUgJiYgdW5pdElkICYmIGV4aXN0c1N5bmMoYWN0aXZpdHlEaXIpKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgcmVhZGRpclN5bmMgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6ZnNcIilcbiAgICAgIGNvbnN0IHNhZmVVbml0SWQgPSB1bml0SWQucmVwbGFjZSgvXFwvL2csIFwiLVwiKVxuICAgICAgY29uc3QgZmlsZXMgPSByZWFkZGlyU3luYyhhY3Rpdml0eURpcilcbiAgICAgICAgLmZpbHRlcigoZjogc3RyaW5nKSA9PiBmLmluY2x1ZGVzKHVuaXRUeXBlKSAmJiBmLmluY2x1ZGVzKHNhZmVVbml0SWQpICYmIGYuZW5kc1dpdGgoXCIuanNvbmxcIikpXG4gICAgICAgIC5zb3J0KClcbiAgICAgICAgLnJldmVyc2UoKVxuXG4gICAgICBpZiAoZmlsZXMubGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGpvaW4oYWN0aXZpdHlEaXIsIGZpbGVzWzBdKSwgXCJ1dGYtOFwiKVxuICAgICAgICBjb25zdCBzaGFSZWdleCA9IC9cXGJbMC05YS1mXXs3LDQwfVxcYi9nXG4gICAgICAgIGNvbnN0IGNvbW1pdFNldCA9IG5ldyBTZXQ8c3RyaW5nPigpXG4gICAgICAgIGZvciAoY29uc3QgbGluZSBvZiBjb250ZW50LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICAgICAgaWYgKCFsaW5lLnRyaW0oKSkgY29udGludWVcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgZW50cnkgPSBKU09OLnBhcnNlKGxpbmUpXG4gICAgICAgICAgICBpZiAoZW50cnk/Lm1lc3NhZ2U/LmNvbnRlbnQpIHtcbiAgICAgICAgICAgICAgY29uc3QgYmxvY2tzID0gQXJyYXkuaXNBcnJheShlbnRyeS5tZXNzYWdlLmNvbnRlbnQpID8gZW50cnkubWVzc2FnZS5jb250ZW50IDogW11cbiAgICAgICAgICAgICAgZm9yIChjb25zdCBibG9jayBvZiBibG9ja3MpIHtcbiAgICAgICAgICAgICAgICBpZiAoYmxvY2sudHlwZSA9PT0gXCJ0b29sX3Jlc3VsdFwiICYmIHR5cGVvZiBibG9jay5jb250ZW50ID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgICBjb25zdCBtYXRjaGVzID0gYmxvY2suY29udGVudC5tYXRjaChzaGFSZWdleClcbiAgICAgICAgICAgICAgICAgIGlmIChtYXRjaGVzKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvciAoY29uc3Qgc2hhIG9mIG1hdGNoZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICBpZiAoc2hhLmxlbmd0aCA+PSA3ICYmICFjb21taXRTZXQuaGFzKHNoYSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbW1pdFNldC5hZGQoc2hhKVxuICAgICAgICAgICAgICAgICAgICAgICAgY29tbWl0cy5wdXNoKHNoYSlcbiAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8vIFNraXAgbWFsZm9ybWVkIGxpbmVzXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBBY3Rpdml0eSBsb2cgc2Nhbm5pbmcgaXMgYmVzdC1lZmZvcnRcbiAgICB9XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGxhc3RVbml0VHlwZTogdW5pdFR5cGUsXG4gICAgbGFzdFVuaXRJZDogdW5pdElkLFxuICAgIGxhc3RVbml0S2V5OiB1bml0S2V5LFxuICAgIGNvbXBsZXRlZENvdW50OiBlbnRyaWVzLmxlbmd0aCxcbiAgICBjb21taXRzLFxuICB9XG59XG5cbi8qKlxuICogRXhlY3V0ZXMgdGhlIHVuZG8gb3BlcmF0aW9uIHZpYSBhIGNoaWxkIHByb2Nlc3MuXG4gKiBDaGlsZC1wcm9jZXNzIHBhdHRlcm4gcmVxdWlyZWQgYmVjYXVzZSB1bmRvIGNhbGxzIHVwc3RyZWFtIGZ1bmN0aW9ucyB0aGF0XG4gKiBtb2RpZnkgZ2l0IHN0YXRlLCBjb21wbGV0ZWQtdW5pdHMuanNvbiwgYW5kIHBsYW4gZmlsZXMgXHUyMDE0IGFsbCBvZiB3aGljaFxuICogdXNlIC50cyBpbXBvcnRzIHRoYXQgbmVlZCB0aGUgcmVzb2x2ZS10cy5tanMgbG9hZGVyLlxuICpcbiAqIE5PVEU6IFRoZSBjaGlsZCBzY3JpcHQgdXNlcyBleGVjU3luYyBmb3IgZ2l0LXJldmVydCBiZWNhdXNlIHRoZSB1cHN0cmVhbVxuICogdW5kbyBtb2R1bGUgYWxyZWFkeSB1c2VzIGl0LiBUaGlzIGlzIGludGVudGlvbmFsbHkgcHJlc2VydmVkIGZyb20gdGhlXG4gKiBvcmlnaW5hbCBpbXBsZW1lbnRhdGlvbi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVVbmRvKHByb2plY3RDd2RPdmVycmlkZT86IHN0cmluZyk6IFByb21pc2U8VW5kb1Jlc3VsdD4ge1xuICBjb25zdCBjb25maWcgPSByZXNvbHZlQnJpZGdlUnVudGltZUNvbmZpZyh1bmRlZmluZWQsIHByb2plY3RDd2RPdmVycmlkZSlcbiAgY29uc3QgeyBwYWNrYWdlUm9vdCwgcHJvamVjdEN3ZCB9ID0gY29uZmlnXG5cbiAgY29uc3QgcmVzb2x2ZVRzTG9hZGVyID0gcmVzb2x2ZVRzTG9hZGVyUGF0aChwYWNrYWdlUm9vdClcbiAgY29uc3QgdW5kb1Jlc29sdXRpb24gPSByZXNvbHZlU3VicHJvY2Vzc01vZHVsZShwYWNrYWdlUm9vdCwgXCJyZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvdW5kby50c1wiKVxuICBjb25zdCBwYXRoc1Jlc29sdXRpb24gPSByZXNvbHZlU3VicHJvY2Vzc01vZHVsZShwYWNrYWdlUm9vdCwgXCJyZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvcGF0aHMudHNcIilcbiAgY29uc3QgdW5kb01vZHVsZVBhdGggPSB1bmRvUmVzb2x1dGlvbi5tb2R1bGVQYXRoXG4gIGNvbnN0IHBhdGhzTW9kdWxlUGF0aCA9IHBhdGhzUmVzb2x1dGlvbi5tb2R1bGVQYXRoXG5cbiAgLy8gRm9yIHN1YnByb2Nlc3MgYXJncyB3ZSB1c2UgdGhlIHVuZG8gcmVzb2x1dGlvbiAoYm90aCBtb2R1bGVzIHNoYXJlIHRoZSBzYW1lIGNvbXBpbGVkLXZzLXNvdXJjZSBzdGF0ZSlcbiAgaWYgKCF1bmRvUmVzb2x1dGlvbi51c2VDb21waWxlZEpzICYmICghZXhpc3RzU3luYyhyZXNvbHZlVHNMb2FkZXIpIHx8ICFleGlzdHNTeW5jKHVuZG9Nb2R1bGVQYXRoKSB8fCAhZXhpc3RzU3luYyhwYXRoc01vZHVsZVBhdGgpKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGB1bmRvIHNlcnZpY2UgbW9kdWxlcyBub3QgZm91bmQ7IGNoZWNrZWQ9JHtyZXNvbHZlVHNMb2FkZXJ9LCR7dW5kb01vZHVsZVBhdGh9LCR7cGF0aHNNb2R1bGVQYXRofWAsXG4gICAgKVxuICB9XG4gIGlmICh1bmRvUmVzb2x1dGlvbi51c2VDb21waWxlZEpzICYmICghZXhpc3RzU3luYyh1bmRvTW9kdWxlUGF0aCkgfHwgIWV4aXN0c1N5bmMocGF0aHNNb2R1bGVQYXRoKSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYHVuZG8gc2VydmljZSBtb2R1bGVzIG5vdCBmb3VuZDsgY2hlY2tlZD0ke3VuZG9Nb2R1bGVQYXRofSwke3BhdGhzTW9kdWxlUGF0aH1gKVxuICB9XG5cbiAgY29uc3Qgc2NyaXB0ID0gW1xuICAgICdjb25zdCB7IHBhdGhUb0ZpbGVVUkwgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6dXJsXCIpOycsXG4gICAgJ2NvbnN0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jLCByZWFkZGlyU3luYywgdW5saW5rU3luYyB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTpmc1wiKTsnLFxuICAgICdjb25zdCB7IGpvaW4gfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6cGF0aFwiKTsnLFxuICAgIGBjb25zdCB1bmRvTW9kID0gYXdhaXQgaW1wb3J0KHBhdGhUb0ZpbGVVUkwocHJvY2Vzcy5lbnYuJHtVTkRPX01PRFVMRV9FTlZ9KS5ocmVmKTtgLFxuICAgIGBjb25zdCBwYXRoc01vZCA9IGF3YWl0IGltcG9ydChwYXRoVG9GaWxlVVJMKHByb2Nlc3MuZW52LiR7UEFUSFNfTU9EVUxFX0VOVn0pLmhyZWYpO2AsXG4gICAgJ2NvbnN0IGJhc2VQYXRoID0gcHJvY2Vzcy5lbnYuR1NEX1VORE9fQkFTRTsnLFxuICAgICdjb25zdCBnc2REaXIgPSBwYXRoc01vZC5nc2RSb290KGJhc2VQYXRoKTsnLFxuICAgICdjb25zdCBjb21wbGV0ZWRQYXRoID0gam9pbihnc2REaXIsIFwiY29tcGxldGVkLXVuaXRzLmpzb25cIik7JyxcbiAgICAnaWYgKCFleGlzdHNTeW5jKGNvbXBsZXRlZFBhdGgpKSB7IHByb2Nlc3Muc3Rkb3V0LndyaXRlKEpTT04uc3RyaW5naWZ5KHsgc3VjY2VzczogZmFsc2UsIG1lc3NhZ2U6IFwiTm8gY29tcGxldGVkIHVuaXRzIHRvIHVuZG9cIiB9KSk7IHByb2Nlc3MuZXhpdCgwKTsgfScsXG4gICAgJ2xldCBlbnRyaWVzOycsXG4gICAgJ3RyeSB7IGVudHJpZXMgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhjb21wbGV0ZWRQYXRoLCBcInV0Zi04XCIpKTsgfSBjYXRjaCB7IHByb2Nlc3Muc3Rkb3V0LndyaXRlKEpTT04uc3RyaW5naWZ5KHsgc3VjY2VzczogZmFsc2UsIG1lc3NhZ2U6IFwiQ291bGQgbm90IHBhcnNlIGNvbXBsZXRlZC11bml0cy5qc29uXCIgfSkpOyBwcm9jZXNzLmV4aXQoMCk7IH0nLFxuICAgICdpZiAoIUFycmF5LmlzQXJyYXkoZW50cmllcykgfHwgZW50cmllcy5sZW5ndGggPT09IDApIHsgcHJvY2Vzcy5zdGRvdXQud3JpdGUoSlNPTi5zdHJpbmdpZnkoeyBzdWNjZXNzOiBmYWxzZSwgbWVzc2FnZTogXCJObyBjb21wbGV0ZWQgdW5pdHMgdG8gdW5kb1wiIH0pKTsgcHJvY2Vzcy5leGl0KDApOyB9JyxcbiAgICAnY29uc3QgbGFzdCA9IGVudHJpZXNbZW50cmllcy5sZW5ndGggLSAxXTsnLFxuICAgICdjb25zdCB1bml0VHlwZSA9IGxhc3QudHlwZTsnLFxuICAgICdjb25zdCB1bml0SWQgPSBsYXN0LmlkOycsXG4gICAgJ2NvbnN0IHBhcnRzID0gdW5pdElkID8gdW5pdElkLnNwbGl0KFwiL1wiKSA6IFtdOycsXG4gICAgJ2xldCBwbGFuVXBkYXRlZCA9IGZhbHNlOycsXG4gICAgJ2lmICh1bml0VHlwZSA9PT0gXCJleGVjdXRlLXRhc2tcIiAmJiBwYXJ0cy5sZW5ndGggPT09IDMpIHsgY29uc3QgW21pZCwgc2lkLCB0aWRdID0gcGFydHM7IHBsYW5VcGRhdGVkID0gdW5kb01vZC51bmNoZWNrVGFza0luUGxhbihiYXNlUGF0aCwgbWlkLCBzaWQsIHRpZCk7IH0nLFxuICAgICdsZXQgY29tbWl0c1JldmVydGVkID0gMDsnLFxuICAgICdjb25zdCBhY3Rpdml0eURpciA9IGpvaW4oZ3NkRGlyLCBcImFjdGl2aXR5XCIpOycsXG4gICAgJ2lmIChleGlzdHNTeW5jKGFjdGl2aXR5RGlyKSkgeycsXG4gICAgJyAgY29uc3QgY29tbWl0cyA9IHVuZG9Nb2QuZmluZENvbW1pdHNGb3JVbml0KGFjdGl2aXR5RGlyLCB1bml0VHlwZSwgdW5pdElkKTsnLFxuICAgICcgIGlmIChjb21taXRzLmxlbmd0aCA+IDApIHsnLFxuICAgICcgICAgY29uc3QgeyBleGVjRmlsZVN5bmMgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiKTsnLFxuICAgICcgICAgZm9yIChjb25zdCBzaGEgb2YgY29tbWl0cy5yZXZlcnNlKCkpIHsnLFxuICAgICcgICAgICB0cnkgeyBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wicmV2ZXJ0XCIsIFwiLS1uby1jb21taXRcIiwgc2hhXSwgeyBjd2Q6IGJhc2VQYXRoLCBzdGRpbzogXCJwaXBlXCIgfSk7IGNvbW1pdHNSZXZlcnRlZCsrOyB9JyxcbiAgICAnICAgICAgY2F0Y2ggeyB0cnkgeyBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wicmV2ZXJ0XCIsIFwiLS1hYm9ydFwiXSwgeyBjd2Q6IGJhc2VQYXRoLCBzdGRpbzogXCJwaXBlXCIgfSk7IH0gY2F0Y2gge30gYnJlYWs7IH0nLFxuICAgICcgICAgfScsXG4gICAgJyAgfScsXG4gICAgJ30nLFxuICAgICdlbnRyaWVzLnBvcCgpOycsXG4gICAgJ3dyaXRlRmlsZVN5bmMoY29tcGxldGVkUGF0aCwgSlNPTi5zdHJpbmdpZnkoZW50cmllcywgbnVsbCwgMiksIFwidXRmLThcIik7JyxcbiAgICAnY29uc3QgcmVzdWx0cyA9IFtgVW5kb25lOiAke3VuaXRUeXBlfSAoJHt1bml0SWR9KWBdOycsXG4gICAgJ3Jlc3VsdHMucHVzaChcIiAgLSBSZW1vdmVkIGZyb20gY29tcGxldGVkLXVuaXRzLmpzb25cIik7JyxcbiAgICAnaWYgKHBsYW5VcGRhdGVkKSByZXN1bHRzLnB1c2goXCIgIC0gVW5jaGVja2VkIHRhc2sgaW4gUExBTlwiKTsnLFxuICAgICdpZiAoY29tbWl0c1JldmVydGVkID4gMCkgeyByZXN1bHRzLnB1c2goYCAgLSBSZXZlcnRlZCAke2NvbW1pdHNSZXZlcnRlZH0gY29tbWl0KHMpIChzdGFnZWQsIG5vdCBjb21taXR0ZWQpYCk7IH0nLFxuICAgICdwcm9jZXNzLnN0ZG91dC53cml0ZShKU09OLnN0cmluZ2lmeSh7IHN1Y2Nlc3M6IHRydWUsIG1lc3NhZ2U6IHJlc3VsdHMuam9pbihcIlxcXFxuXCIpIH0pKTsnLFxuICBdLmpvaW4oXCIgXCIpXG5cbiAgY29uc3QgcHJlZml4QXJncyA9IGJ1aWxkU3VicHJvY2Vzc1ByZWZpeEFyZ3MocGFja2FnZVJvb3QsIHVuZG9SZXNvbHV0aW9uLCBwYXRoVG9GaWxlVVJMKHJlc29sdmVUc0xvYWRlcikuaHJlZilcblxuICByZXR1cm4gYXdhaXQgbmV3IFByb21pc2U8VW5kb1Jlc3VsdD4oKHJlc29sdmVSZXN1bHQsIHJlamVjdCkgPT4ge1xuICAgIGV4ZWNGaWxlKFxuICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgIFtcbiAgICAgICAgLi4ucHJlZml4QXJncyxcbiAgICAgICAgXCItLWV2YWxcIixcbiAgICAgICAgc2NyaXB0LFxuICAgICAgXSxcbiAgICAgIHtcbiAgICAgICAgY3dkOiBwYWNrYWdlUm9vdCxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgLi4ucHJvY2Vzcy5lbnYsXG4gICAgICAgICAgW1VORE9fTU9EVUxFX0VOVl06IHVuZG9Nb2R1bGVQYXRoLFxuICAgICAgICAgIFtQQVRIU19NT0RVTEVfRU5WXTogcGF0aHNNb2R1bGVQYXRoLFxuICAgICAgICAgIEdTRF9VTkRPX0JBU0U6IHByb2plY3RDd2QsXG4gICAgICAgIH0sXG4gICAgICAgIG1heEJ1ZmZlcjogVU5ET19NQVhfQlVGRkVSLFxuICAgICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICAoZXJyb3IsIHN0ZG91dCwgc3RkZXJyKSA9PiB7XG4gICAgICAgIGlmIChlcnJvcikge1xuICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoYHVuZG8gc3VicHJvY2VzcyBmYWlsZWQ6ICR7c3RkZXJyIHx8IGVycm9yLm1lc3NhZ2V9YCkpXG4gICAgICAgICAgcmV0dXJuXG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlc29sdmVSZXN1bHQoSlNPTi5wYXJzZShzdGRvdXQpIGFzIFVuZG9SZXN1bHQpXG4gICAgICAgIH0gY2F0Y2ggKHBhcnNlRXJyb3IpIHtcbiAgICAgICAgICByZWplY3QoXG4gICAgICAgICAgICBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgIGB1bmRvIHN1YnByb2Nlc3MgcmV0dXJuZWQgaW52YWxpZCBKU09OOiAke3BhcnNlRXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IHBhcnNlRXJyb3IubWVzc2FnZSA6IFN0cmluZyhwYXJzZUVycm9yKX1gLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgKVxuICB9KVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxZQUFZLG9CQUFvQjtBQUN6QyxTQUFTLFlBQVk7QUFDckIsU0FBUyxxQkFBcUI7QUFFOUIsU0FBUyxrQ0FBa0M7QUFDM0MsU0FBbUMseUJBQXlCLGlDQUFpQztBQUc3RixNQUFNLGtCQUFrQixJQUFJLE9BQU87QUFDbkMsTUFBTSxrQkFBa0I7QUFDeEIsTUFBTSxtQkFBbUI7QUFFekIsU0FBUyxvQkFBb0IsYUFBNkI7QUFDeEQsU0FBTyxLQUFLLGFBQWEsT0FBTyxhQUFhLGNBQWMsT0FBTyxTQUFTLGdCQUFnQjtBQUM3RjtBQU9BLGVBQXNCLGdCQUFnQixvQkFBZ0Q7QUFDcEYsUUFBTSxTQUFTLDJCQUEyQixRQUFXLGtCQUFrQjtBQUN2RSxRQUFNLEVBQUUsV0FBVyxJQUFJO0FBRXZCLFFBQU0sU0FBUyxLQUFLLFlBQVksTUFBTTtBQUN0QyxRQUFNLGdC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
