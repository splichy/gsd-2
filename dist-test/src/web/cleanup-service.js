import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBridgeRuntimeConfig } from "./bridge-service.js";
import { resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.js";
const CLEANUP_MAX_BUFFER = 2 * 1024 * 1024;
const CLEANUP_MODULE_ENV = "GSD_CLEANUP_MODULE";
function resolveTsLoaderPath(packageRoot) {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
}
async function collectCleanupData(projectCwdOverride) {
  const config = resolveBridgeRuntimeConfig(void 0, projectCwdOverride);
  const { packageRoot, projectCwd } = config;
  const resolveTsLoader = resolveTsLoaderPath(packageRoot);
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/native-git-bridge.ts");
  const cleanupModulePath = moduleResolution.modulePath;
  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(cleanupModulePath))) {
    throw new Error(
      `cleanup data provider not found; checked=${resolveTsLoader},${cleanupModulePath}`
    );
  }
  if (moduleResolution.useCompiledJs && !existsSync(cleanupModulePath)) {
    throw new Error(`cleanup data provider not found; checked=${cleanupModulePath}`);
  }
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${CLEANUP_MODULE_ENV}).href);`,
    "const basePath = process.env.GSD_CLEANUP_BASE;",
    // Get all GSD branches
    "let branches = [];",
    'try { branches = mod.nativeBranchList(basePath, "gsd/*"); } catch {}',
    // Detect main branch and find which GSD branches are merged
    'let mainBranch = "main";',
    "try { mainBranch = mod.nativeDetectMainBranch(basePath); } catch {}",
    "let merged = [];",
    'try { merged = mod.nativeBranchListMerged(basePath, mainBranch, "gsd/*"); } catch {}',
    "const mergedSet = new Set(merged);",
    "const branchList = branches.map(b => ({ name: b, merged: mergedSet.has(b) }));",
    // Get snapshot refs
    "let refs = [];",
    'try { refs = mod.nativeForEachRef(basePath, "refs/gsd/snapshots/"); } catch {}',
    "const snapshotList = refs.map(r => {",
    '  const parts = r.split(" ");',
    '  return { ref: parts[0] || r, date: parts.length > 1 ? parts.slice(1).join(" ") : "" };',
    "});",
    "process.stdout.write(JSON.stringify({ branches: branchList, snapshots: snapshotList }));"
  ].join(" ");
  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, moduleResolution, pathToFileURL(resolveTsLoader).href);
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
          [CLEANUP_MODULE_ENV]: cleanupModulePath,
          GSD_CLEANUP_BASE: projectCwd
        },
        maxBuffer: CLEANUP_MAX_BUFFER,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`cleanup data subprocess failed: ${stderr || error.message}`));
          return;
        }
        try {
          resolveResult(JSON.parse(stdout));
        } catch (parseError) {
          reject(
            new Error(
              `cleanup data subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            )
          );
        }
      }
    );
  });
}
async function executeCleanup(deleteBranches, pruneSnapshots, projectCwdOverride) {
  const config = resolveBridgeRuntimeConfig(void 0, projectCwdOverride);
  const { packageRoot, projectCwd } = config;
  const resolveTsLoader = resolveTsLoaderPath(packageRoot);
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/native-git-bridge.ts");
  const cleanupModulePath = moduleResolution.modulePath;
  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(cleanupModulePath))) {
    throw new Error(
      `cleanup service modules not found; checked=${resolveTsLoader},${cleanupModulePath}`
    );
  }
  if (moduleResolution.useCompiledJs && !existsSync(cleanupModulePath)) {
    throw new Error(`cleanup service modules not found; checked=${cleanupModulePath}`);
  }
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${CLEANUP_MODULE_ENV}).href);`,
    "const basePath = process.env.GSD_CLEANUP_BASE;",
    'const branches = JSON.parse(process.env.GSD_CLEANUP_BRANCHES || "[]");',
    'const snapshots = JSON.parse(process.env.GSD_CLEANUP_SNAPSHOTS || "[]");',
    "let deletedBranches = 0;",
    "let prunedSnapshots = 0;",
    "const errors = [];",
    "for (const branch of branches) {",
    "  try { mod.nativeBranchDelete(basePath, branch, true); deletedBranches++; }",
    "  catch (e) { errors.push(`Branch ${branch}: ${e.message}`); }",
    "}",
    "for (const ref of snapshots) {",
    "  try { mod.nativeUpdateRef(basePath, ref); prunedSnapshots++; }",
    "  catch (e) { errors.push(`Ref ${ref}: ${e.message}`); }",
    "}",
    "const parts = [];",
    "if (deletedBranches > 0) parts.push(`Deleted ${deletedBranches} branch(es)`);",
    "if (prunedSnapshots > 0) parts.push(`Pruned ${prunedSnapshots} snapshot(s)`);",
    'if (errors.length > 0) parts.push(`Errors: ${errors.join("; ")}`);',
    'const message = parts.length > 0 ? parts.join(". ") : "No items to clean up";',
    "process.stdout.write(JSON.stringify({ deletedBranches, prunedSnapshots, message }));"
  ].join(" ");
  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, moduleResolution, pathToFileURL(resolveTsLoader).href);
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
          [CLEANUP_MODULE_ENV]: cleanupModulePath,
          GSD_CLEANUP_BASE: projectCwd,
          GSD_CLEANUP_BRANCHES: JSON.stringify(deleteBranches),
          GSD_CLEANUP_SNAPSHOTS: JSON.stringify(pruneSnapshots)
        },
        maxBuffer: CLEANUP_MAX_BUFFER,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`cleanup subprocess failed: ${stderr || error.message}`));
          return;
        }
        try {
          resolveResult(JSON.parse(stdout));
        } catch (parseError) {
          reject(
            new Error(
              `cleanup subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            )
          );
        }
      }
    );
  });
}
export {
  collectCleanupData,
  executeCleanup
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3dlYi9jbGVhbnVwLXNlcnZpY2UudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGV4ZWNGaWxlIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiXG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIlxuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIlxuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gXCJub2RlOnVybFwiXG5cbmltcG9ydCB7IHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnIH0gZnJvbSBcIi4vYnJpZGdlLXNlcnZpY2UudHNcIlxuaW1wb3J0IHsgcmVzb2x2ZVR5cGVTdHJpcHBpbmdGbGFnLCByZXNvbHZlU3VicHJvY2Vzc01vZHVsZSwgYnVpbGRTdWJwcm9jZXNzUHJlZml4QXJncyB9IGZyb20gXCIuL3RzLXN1YnByb2Nlc3MtZmxhZ3MudHNcIlxuaW1wb3J0IHR5cGUgeyBDbGVhbnVwRGF0YSwgQ2xlYW51cFJlc3VsdCB9IGZyb20gXCIuLi8uLi93ZWIvbGliL3JlbWFpbmluZy1jb21tYW5kLXR5cGVzLnRzXCJcblxuY29uc3QgQ0xFQU5VUF9NQVhfQlVGRkVSID0gMiAqIDEwMjQgKiAxMDI0XG5jb25zdCBDTEVBTlVQX01PRFVMRV9FTlYgPSBcIkdTRF9DTEVBTlVQX01PRFVMRVwiXG5cbmZ1bmN0aW9uIHJlc29sdmVUc0xvYWRlclBhdGgocGFja2FnZVJvb3Q6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKHBhY2thZ2VSb290LCBcInNyY1wiLCBcInJlc291cmNlc1wiLCBcImV4dGVuc2lvbnNcIiwgXCJnc2RcIiwgXCJ0ZXN0c1wiLCBcInJlc29sdmUtdHMubWpzXCIpXG59XG5cbi8qKlxuICogQ29sbGVjdHMgY2xlYW51cCBkYXRhIChHU0QgYnJhbmNoZXMgYW5kIHNuYXBzaG90IHJlZnMpIHZpYSBhIGNoaWxkIHByb2Nlc3MuXG4gKiBDaGlsZC1wcm9jZXNzIHBhdHRlcm4gcmVxdWlyZWQgYmVjYXVzZSBuYXRpdmUtZ2l0LWJyaWRnZS50cyB1c2VzIC50cyBpbXBvcnRzXG4gKiB0aGF0IG5lZWQgdGhlIHJlc29sdmUtdHMubWpzIGxvYWRlci5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvbGxlY3RDbGVhbnVwRGF0YShwcm9qZWN0Q3dkT3ZlcnJpZGU/OiBzdHJpbmcpOiBQcm9taXNlPENsZWFudXBEYXRhPiB7XG4gIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnKHVuZGVmaW5lZCwgcHJvamVjdEN3ZE92ZXJyaWRlKVxuICBjb25zdCB7IHBhY2thZ2VSb290LCBwcm9qZWN0Q3dkIH0gPSBjb25maWdcblxuICBjb25zdCByZXNvbHZlVHNMb2FkZXIgPSByZXNvbHZlVHNMb2FkZXJQYXRoKHBhY2thZ2VSb290KVxuICBjb25zdCBtb2R1bGVSZXNvbHV0aW9uID0gcmVzb2x2ZVN1YnByb2Nlc3NNb2R1bGUocGFja2FnZVJvb3QsIFwicmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL25hdGl2ZS1naXQtYnJpZGdlLnRzXCIpXG4gIGNvbnN0IGNsZWFudXBNb2R1bGVQYXRoID0gbW9kdWxlUmVzb2x1dGlvbi5tb2R1bGVQYXRoXG5cbiAgaWYgKCFtb2R1bGVSZXNvbHV0aW9uLnVzZUNvbXBpbGVkSnMgJiYgKCFleGlzdHNTeW5jKHJlc29sdmVUc0xvYWRlcikgfHwgIWV4aXN0c1N5bmMoY2xlYW51cE1vZHVsZVBhdGgpKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBjbGVhbnVwIGRhdGEgcHJvdmlkZXIgbm90IGZvdW5kOyBjaGVja2VkPSR7cmVzb2x2ZVRzTG9hZGVyfSwke2NsZWFudXBNb2R1bGVQYXRofWAsXG4gICAgKVxuICB9XG4gIGlmIChtb2R1bGVSZXNvbHV0aW9uLnVzZUNvbXBpbGVkSnMgJiYgIWV4aXN0c1N5bmMoY2xlYW51cE1vZHVsZVBhdGgpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBjbGVhbnVwIGRhdGEgcHJvdmlkZXIgbm90IGZvdW5kOyBjaGVja2VkPSR7Y2xlYW51cE1vZHVsZVBhdGh9YClcbiAgfVxuXG4gIGNvbnN0IHNjcmlwdCA9IFtcbiAgICAnY29uc3QgeyBwYXRoVG9GaWxlVVJMIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOnVybFwiKTsnLFxuICAgIGBjb25zdCBtb2QgPSBhd2FpdCBpbXBvcnQocGF0aFRvRmlsZVVSTChwcm9jZXNzLmVudi4ke0NMRUFOVVBfTU9EVUxFX0VOVn0pLmhyZWYpO2AsXG4gICAgJ2NvbnN0IGJhc2VQYXRoID0gcHJvY2Vzcy5lbnYuR1NEX0NMRUFOVVBfQkFTRTsnLFxuICAgIC8vIEdldCBhbGwgR1NEIGJyYW5jaGVzXG4gICAgJ2xldCBicmFuY2hlcyA9IFtdOycsXG4gICAgJ3RyeSB7IGJyYW5jaGVzID0gbW9kLm5hdGl2ZUJyYW5jaExpc3QoYmFzZVBhdGgsIFwiZ3NkLypcIik7IH0gY2F0Y2gge30nLFxuICAgIC8vIERldGVjdCBtYWluIGJyYW5jaCBhbmQgZmluZCB3aGljaCBHU0QgYnJhbmNoZXMgYXJlIG1lcmdlZFxuICAgICdsZXQgbWFpbkJyYW5jaCA9IFwibWFpblwiOycsXG4gICAgJ3RyeSB7IG1haW5CcmFuY2ggPSBtb2QubmF0aXZlRGV0ZWN0TWFpbkJyYW5jaChiYXNlUGF0aCk7IH0gY2F0Y2gge30nLFxuICAgICdsZXQgbWVyZ2VkID0gW107JyxcbiAgICAndHJ5IHsgbWVyZ2VkID0gbW9kLm5hdGl2ZUJyYW5jaExpc3RNZXJnZWQoYmFzZVBhdGgsIG1haW5CcmFuY2gsIFwiZ3NkLypcIik7IH0gY2F0Y2gge30nLFxuICAgICdjb25zdCBtZXJnZWRTZXQgPSBuZXcgU2V0KG1lcmdlZCk7JyxcbiAgICAnY29uc3QgYnJhbmNoTGlzdCA9IGJyYW5jaGVzLm1hcChiID0+ICh7IG5hbWU6IGIsIG1lcmdlZDogbWVyZ2VkU2V0LmhhcyhiKSB9KSk7JyxcbiAgICAvLyBHZXQgc25hcHNob3QgcmVmc1xuICAgICdsZXQgcmVmcyA9IFtdOycsXG4gICAgJ3RyeSB7IHJlZnMgPSBtb2QubmF0aXZlRm9yRWFjaFJlZihiYXNlUGF0aCwgXCJyZWZzL2dzZC9zbmFwc2hvdHMvXCIpOyB9IGNhdGNoIHt9JyxcbiAgICAnY29uc3Qgc25hcHNob3RMaXN0ID0gcmVmcy5tYXAociA9PiB7JyxcbiAgICAnICBjb25zdCBwYXJ0cyA9IHIuc3BsaXQoXCIgXCIpOycsXG4gICAgJyAgcmV0dXJuIHsgcmVmOiBwYXJ0c1swXSB8fCByLCBkYXRlOiBwYXJ0cy5sZW5ndGggPiAxID8gcGFydHMuc2xpY2UoMSkuam9pbihcIiBcIikgOiBcIlwiIH07JyxcbiAgICAnfSk7JyxcbiAgICAncHJvY2Vzcy5zdGRvdXQud3JpdGUoSlNPTi5zdHJpbmdpZnkoeyBicmFuY2hlczogYnJhbmNoTGlzdCwgc25hcHNob3RzOiBzbmFwc2hvdExpc3QgfSkpOycsXG4gIF0uam9pbihcIiBcIilcblxuICBjb25zdCBwcmVmaXhBcmdzID0gYnVpbGRTdWJwcm9jZXNzUHJlZml4QXJncyhwYWNrYWdlUm9vdCwgbW9kdWxlUmVzb2x1dGlvbiwgcGF0aFRvRmlsZVVSTChyZXNvbHZlVHNMb2FkZXIpLmhyZWYpXG5cbiAgcmV0dXJuIGF3YWl0IG5ldyBQcm9taXNlPENsZWFudXBEYXRhPigocmVzb2x2ZVJlc3VsdCwgcmVqZWN0KSA9PiB7XG4gICAgZXhlY0ZpbGUoXG4gICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgW1xuICAgICAgICAuLi5wcmVmaXhBcmdzLFxuICAgICAgICBcIi0tZXZhbFwiLFxuICAgICAgICBzY3JpcHQsXG4gICAgICBdLFxuICAgICAge1xuICAgICAgICBjd2Q6IHBhY2thZ2VSb290LFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgICBbQ0xFQU5VUF9NT0RVTEVfRU5WXTogY2xlYW51cE1vZHVsZVBhdGgsXG4gICAgICAgICAgR1NEX0NMRUFOVVBfQkFTRTogcHJvamVjdEN3ZCxcbiAgICAgICAgfSxcbiAgICAgICAgbWF4QnVmZmVyOiBDTEVBTlVQX01BWF9CVUZGRVIsXG4gICAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIChlcnJvciwgc3Rkb3V0LCBzdGRlcnIpID0+IHtcbiAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgY2xlYW51cCBkYXRhIHN1YnByb2Nlc3MgZmFpbGVkOiAke3N0ZGVyciB8fCBlcnJvci5tZXNzYWdlfWApKVxuICAgICAgICAgIHJldHVyblxuICAgICAgICB9XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXNvbHZlUmVzdWx0KEpTT04ucGFyc2Uoc3Rkb3V0KSBhcyBDbGVhbnVwRGF0YSlcbiAgICAgICAgfSBjYXRjaCAocGFyc2VFcnJvcikge1xuICAgICAgICAgIHJlamVjdChcbiAgICAgICAgICAgIG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgYGNsZWFudXAgZGF0YSBzdWJwcm9jZXNzIHJldHVybmVkIGludmFsaWQgSlNPTjogJHtwYXJzZUVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBwYXJzZUVycm9yLm1lc3NhZ2UgOiBTdHJpbmcocGFyc2VFcnJvcil9YCxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICB9LFxuICAgIClcbiAgfSlcbn1cblxuLyoqXG4gKiBFeGVjdXRlcyBjbGVhbnVwIG9wZXJhdGlvbnMgKGJyYW5jaCBkZWxldGlvbiBhbmQgc25hcHNob3QgcHJ1bmluZykgdmlhIGEgY2hpbGQgcHJvY2Vzcy5cbiAqIENoaWxkLXByb2Nlc3MgcGF0dGVybiByZXF1aXJlZCBiZWNhdXNlIG5hdGl2ZUJyYW5jaERlbGV0ZSBhbmQgbmF0aXZlVXBkYXRlUmVmXG4gKiBtb2RpZnkgZ2l0IHN0YXRlIHVzaW5nIC50cyBpbXBvcnRzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZUNsZWFudXAoXG4gIGRlbGV0ZUJyYW5jaGVzOiBzdHJpbmdbXSxcbiAgcHJ1bmVTbmFwc2hvdHM6IHN0cmluZ1tdLFxuICBwcm9qZWN0Q3dkT3ZlcnJpZGU/OiBzdHJpbmcsXG4pOiBQcm9taXNlPENsZWFudXBSZXN1bHQ+IHtcbiAgY29uc3QgY29uZmlnID0gcmVzb2x2ZUJyaWRnZVJ1bnRpbWVDb25maWcodW5kZWZpbmVkLCBwcm9qZWN0Q3dkT3ZlcnJpZGUpXG4gIGNvbnN0IHsgcGFja2FnZVJvb3QsIHByb2plY3RDd2QgfSA9IGNvbmZpZ1xuXG4gIGNvbnN0IHJlc29sdmVUc0xvYWRlciA9IHJlc29sdmVUc0xvYWRlclBhdGgocGFja2FnZVJvb3QpXG4gIGNvbnN0IG1vZHVsZVJlc29sdXRpb24gPSByZXNvbHZlU3VicHJvY2Vzc01vZHVsZShwYWNrYWdlUm9vdCwgXCJyZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvbmF0aXZlLWdpdC1icmlkZ2UudHNcIilcbiAgY29uc3QgY2xlYW51cE1vZHVsZVBhdGggPSBtb2R1bGVSZXNvbHV0aW9uLm1vZHVsZVBhdGhcblxuICBpZiAoIW1vZHVsZVJlc29sdXRpb24udXNlQ29tcGlsZWRKcyAmJiAoIWV4aXN0c1N5bmMocmVzb2x2ZVRzTG9hZGVyKSB8fCAhZXhpc3RzU3luYyhjbGVhbnVwTW9kdWxlUGF0aCkpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGNsZWFudXAgc2VydmljZSBtb2R1bGVzIG5vdCBmb3VuZDsgY2hlY2tlZD0ke3Jlc29sdmVUc0xvYWRlcn0sJHtjbGVhbnVwTW9kdWxlUGF0aH1gLFxuICAgIClcbiAgfVxuICBpZiAobW9kdWxlUmVzb2x1dGlvbi51c2VDb21waWxlZEpzICYmICFleGlzdHNTeW5jKGNsZWFudXBNb2R1bGVQYXRoKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgY2xlYW51cCBzZXJ2aWNlIG1vZHVsZXMgbm90IGZvdW5kOyBjaGVja2VkPSR7Y2xlYW51cE1vZHVsZVBhdGh9YClcbiAgfVxuXG4gIGNvbnN0IHNjcmlwdCA9IFtcbiAgICAnY29uc3QgeyBwYXRoVG9GaWxlVVJMIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOnVybFwiKTsnLFxuICAgIGBjb25zdCBtb2QgPSBhd2FpdCBpbXBvcnQocGF0aFRvRmlsZVVSTChwcm9jZXNzLmVudi4ke0NMRUFOVVBfTU9EVUxFX0VOVn0pLmhyZWYpO2AsXG4gICAgJ2NvbnN0IGJhc2VQYXRoID0gcHJvY2Vzcy5lbnYuR1NEX0NMRUFOVVBfQkFTRTsnLFxuICAgICdjb25zdCBicmFuY2hlcyA9IEpTT04ucGFyc2UocHJvY2Vzcy5lbnYuR1NEX0NMRUFOVVBfQlJBTkNIRVMgfHwgXCJbXVwiKTsnLFxuICAgICdjb25zdCBzbmFwc2hvdHMgPSBKU09OLnBhcnNlKHByb2Nlc3MuZW52LkdTRF9DTEVBTlVQX1NOQVBTSE9UUyB8fCBcIltdXCIpOycsXG4gICAgJ2xldCBkZWxldGVkQnJhbmNoZXMgPSAwOycsXG4gICAgJ2xldCBwcnVuZWRTbmFwc2hvdHMgPSAwOycsXG4gICAgJ2NvbnN0IGVycm9ycyA9IFtdOycsXG4gICAgJ2ZvciAoY29uc3QgYnJhbmNoIG9mIGJyYW5jaGVzKSB7JyxcbiAgICAnICB0cnkgeyBtb2QubmF0aXZlQnJhbmNoRGVsZXRlKGJhc2VQYXRoLCBicmFuY2gsIHRydWUpOyBkZWxldGVkQnJhbmNoZXMrKzsgfScsXG4gICAgJyAgY2F0Y2ggKGUpIHsgZXJyb3JzLnB1c2goYEJyYW5jaCAke2JyYW5jaH06ICR7ZS5tZXNzYWdlfWApOyB9JyxcbiAgICAnfScsXG4gICAgJ2ZvciAoY29uc3QgcmVmIG9mIHNuYXBzaG90cykgeycsXG4gICAgJyAgdHJ5IHsgbW9kLm5hdGl2ZVVwZGF0ZVJlZihiYXNlUGF0aCwgcmVmKTsgcHJ1bmVkU25hcHNob3RzKys7IH0nLFxuICAgICcgIGNhdGNoIChlKSB7IGVycm9ycy5wdXNoKGBSZWYgJHtyZWZ9OiAke2UubWVzc2FnZX1gKTsgfScsXG4gICAgJ30nLFxuICAgICdjb25zdCBwYXJ0cyA9IFtdOycsXG4gICAgJ2lmIChkZWxldGVkQnJhbmNoZXMgPiAwKSBwYXJ0cy5wdXNoKGBEZWxldGVkICR7ZGVsZXRlZEJyYW5jaGVzfSBicmFuY2goZXMpYCk7JyxcbiAgICAnaWYgKHBydW5lZFNuYXBzaG90cyA+IDApIHBhcnRzLnB1c2goYFBydW5lZCAke3BydW5lZFNuYXBzaG90c30gc25hcHNob3QocylgKTsnLFxuICAgICdpZiAoZXJyb3JzLmxlbmd0aCA+IDApIHBhcnRzLnB1c2goYEVycm9yczogJHtlcnJvcnMuam9pbihcIjsgXCIpfWApOycsXG4gICAgJ2NvbnN0IG1lc3NhZ2UgPSBwYXJ0cy5sZW5ndGggPiAwID8gcGFydHMuam9pbihcIi4gXCIpIDogXCJObyBpdGVtcyB0byBjbGVhbiB1cFwiOycsXG4gICAgJ3Byb2Nlc3Muc3Rkb3V0LndyaXRlKEpTT04uc3RyaW5naWZ5KHsgZGVsZXRlZEJyYW5jaGVzLCBwcnVuZWRTbmFwc2hvdHMsIG1lc3NhZ2UgfSkpOycsXG4gIF0uam9pbihcIiBcIilcblxuICBjb25zdCBwcmVmaXhBcmdzID0gYnVpbGRTdWJwcm9jZXNzUHJlZml4QXJncyhwYWNrYWdlUm9vdCwgbW9kdWxlUmVzb2x1dGlvbiwgcGF0aFRvRmlsZVVSTChyZXNvbHZlVHNMb2FkZXIpLmhyZWYpXG5cbiAgcmV0dXJuIGF3YWl0IG5ldyBQcm9taXNlPENsZWFudXBSZXN1bHQ+KChyZXNvbHZlUmVzdWx0LCByZWplY3QpID0+IHtcbiAgICBleGVjRmlsZShcbiAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICBbXG4gICAgICAgIC4uLnByZWZpeEFyZ3MsXG4gICAgICAgIFwiLS1ldmFsXCIsXG4gICAgICAgIHNjcmlwdCxcbiAgICAgIF0sXG4gICAgICB7XG4gICAgICAgIGN3ZDogcGFja2FnZVJvb3QsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICAgIFtDTEVBTlVQX01PRFVMRV9FTlZdOiBjbGVhbnVwTW9kdWxlUGF0aCxcbiAgICAgICAgICBHU0RfQ0xFQU5VUF9CQVNFOiBwcm9qZWN0Q3dkLFxuICAgICAgICAgIEdTRF9DTEVBTlVQX0JSQU5DSEVTOiBKU09OLnN0cmluZ2lmeShkZWxldGVCcmFuY2hlcyksXG4gICAgICAgICAgR1NEX0NMRUFOVVBfU05BUFNIT1RTOiBKU09OLnN0cmluZ2lmeShwcnVuZVNuYXBzaG90cyksXG4gICAgICAgIH0sXG4gICAgICAgIG1heEJ1ZmZlcjogQ0xFQU5VUF9NQVhfQlVGRkVSLFxuICAgICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICAoZXJyb3IsIHN0ZG91dCwgc3RkZXJyKSA9PiB7XG4gICAgICAgIGlmIChlcnJvcikge1xuICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoYGNsZWFudXAgc3VicHJvY2VzcyBmYWlsZWQ6ICR7c3RkZXJyIHx8IGVycm9yLm1lc3NhZ2V9YCkpXG4gICAgICAgICAgcmV0dXJuXG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlc29sdmVSZXN1bHQoSlNPTi5wYXJzZShzdGRvdXQpIGFzIENsZWFudXBSZXN1bHQpXG4gICAgICAgIH0gY2F0Y2ggKHBhcnNlRXJyb3IpIHtcbiAgICAgICAgICByZWplY3QoXG4gICAgICAgICAgICBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgIGBjbGVhbnVwIHN1YnByb2Nlc3MgcmV0dXJuZWQgaW52YWxpZCBKU09OOiAke3BhcnNlRXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IHBhcnNlRXJyb3IubWVzc2FnZSA6IFN0cmluZyhwYXJzZUVycm9yKX1gLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgKVxuICB9KVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxZQUFZO0FBQ3JCLFNBQVMscUJBQXFCO0FBRTlCLFNBQVMsa0NBQWtDO0FBQzNDLFNBQW1DLHlCQUF5QixpQ0FB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
