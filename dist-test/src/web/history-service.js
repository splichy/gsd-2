import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBridgeRuntimeConfig } from "./bridge-service.js";
import { resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.js";
const HISTORY_MAX_BUFFER = 2 * 1024 * 1024;
const HISTORY_MODULE_ENV = "GSD_HISTORY_MODULE";
function resolveTsLoaderPath(packageRoot) {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
}
async function collectHistoryData(projectCwdOverride) {
  const config = resolveBridgeRuntimeConfig(void 0, projectCwdOverride);
  const { packageRoot, projectCwd } = config;
  const resolveTsLoader = resolveTsLoaderPath(packageRoot);
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/metrics.ts");
  const historyModulePath = moduleResolution.modulePath;
  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(historyModulePath))) {
    throw new Error(
      `history data provider not found; checked=${resolveTsLoader},${historyModulePath}`
    );
  }
  if (moduleResolution.useCompiledJs && !existsSync(historyModulePath)) {
    throw new Error(`history data provider not found; checked=${historyModulePath}`);
  }
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${HISTORY_MODULE_ENV}).href);`,
    `const ledger = mod.loadLedgerFromDisk(process.env.GSD_HISTORY_BASE);`,
    "const units = ledger ? ledger.units : [];",
    "const totals = mod.getProjectTotals(units);",
    "const byPhase = mod.aggregateByPhase(units);",
    "const bySlice = mod.aggregateBySlice(units);",
    "const byModel = mod.aggregateByModel(units);",
    "process.stdout.write(JSON.stringify({ units, totals, byPhase, bySlice, byModel }));"
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
          [HISTORY_MODULE_ENV]: historyModulePath,
          GSD_HISTORY_BASE: projectCwd
        },
        maxBuffer: HISTORY_MAX_BUFFER,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`history data subprocess failed: ${stderr || error.message}`));
          return;
        }
        try {
          resolveResult(JSON.parse(stdout));
        } catch (parseError) {
          reject(
            new Error(
              `history data subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            )
          );
        }
      }
    );
  });
}
export {
  collectHistoryData
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3dlYi9oaXN0b3J5LXNlcnZpY2UudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGV4ZWNGaWxlIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiXG5pbXBvcnQgeyBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIlxuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIlxuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gXCJub2RlOnVybFwiXG5cbmltcG9ydCB7IHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnIH0gZnJvbSBcIi4vYnJpZGdlLXNlcnZpY2UudHNcIlxuaW1wb3J0IHsgcmVzb2x2ZVR5cGVTdHJpcHBpbmdGbGFnLCByZXNvbHZlU3VicHJvY2Vzc01vZHVsZSwgYnVpbGRTdWJwcm9jZXNzUHJlZml4QXJncyB9IGZyb20gXCIuL3RzLXN1YnByb2Nlc3MtZmxhZ3MudHNcIlxuaW1wb3J0IHR5cGUgeyBIaXN0b3J5RGF0YSB9IGZyb20gXCIuLi8uLi93ZWIvbGliL3JlbWFpbmluZy1jb21tYW5kLXR5cGVzLnRzXCJcblxuY29uc3QgSElTVE9SWV9NQVhfQlVGRkVSID0gMiAqIDEwMjQgKiAxMDI0XG5jb25zdCBISVNUT1JZX01PRFVMRV9FTlYgPSBcIkdTRF9ISVNUT1JZX01PRFVMRVwiXG5cbmZ1bmN0aW9uIHJlc29sdmVUc0xvYWRlclBhdGgocGFja2FnZVJvb3Q6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKHBhY2thZ2VSb290LCBcInNyY1wiLCBcInJlc291cmNlc1wiLCBcImV4dGVuc2lvbnNcIiwgXCJnc2RcIiwgXCJ0ZXN0c1wiLCBcInJlc29sdmUtdHMubWpzXCIpXG59XG5cbi8qKlxuICogTG9hZHMgaGlzdG9yeS9tZXRyaWNzIGRhdGEgdmlhIGEgY2hpbGQgcHJvY2Vzcy5cbiAqIFJlYWRzIHRoZSBtZXRyaWNzIGxlZGdlciBmcm9tIGRpc2sgYW5kIGNvbXB1dGVzIGFnZ3JlZ2F0aW9uIHZpZXdzXG4gKiAodG90YWxzLCBieVBoYXNlLCBieVNsaWNlLCBieU1vZGVsKSBmb3IgYnJvd3NlciBjb25zdW1wdGlvbi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvbGxlY3RIaXN0b3J5RGF0YShwcm9qZWN0Q3dkT3ZlcnJpZGU/OiBzdHJpbmcpOiBQcm9taXNlPEhpc3RvcnlEYXRhPiB7XG4gIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnKHVuZGVmaW5lZCwgcHJvamVjdEN3ZE92ZXJyaWRlKVxuICBjb25zdCB7IHBhY2thZ2VSb290LCBwcm9qZWN0Q3dkIH0gPSBjb25maWdcblxuICBjb25zdCByZXNvbHZlVHNMb2FkZXIgPSByZXNvbHZlVHNMb2FkZXJQYXRoKHBhY2thZ2VSb290KVxuICBjb25zdCBtb2R1bGVSZXNvbHV0aW9uID0gcmVzb2x2ZVN1YnByb2Nlc3NNb2R1bGUocGFja2FnZVJvb3QsIFwicmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL21ldHJpY3MudHNcIilcbiAgY29uc3QgaGlzdG9yeU1vZHVsZVBhdGggPSBtb2R1bGVSZXNvbHV0aW9uLm1vZHVsZVBhdGhcblxuICBpZiAoIW1vZHVsZVJlc29sdXRpb24udXNlQ29tcGlsZWRKcyAmJiAoIWV4aXN0c1N5bmMocmVzb2x2ZVRzTG9hZGVyKSB8fCAhZXhpc3RzU3luYyhoaXN0b3J5TW9kdWxlUGF0aCkpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGhpc3RvcnkgZGF0YSBwcm92aWRlciBub3QgZm91bmQ7IGNoZWNrZWQ9JHtyZXNvbHZlVHNMb2FkZXJ9LCR7aGlzdG9yeU1vZHVsZVBhdGh9YCxcbiAgICApXG4gIH1cbiAgaWYgKG1vZHVsZVJlc29sdXRpb24udXNlQ29tcGlsZWRKcyAmJiAhZXhpc3RzU3luYyhoaXN0b3J5TW9kdWxlUGF0aCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYGhpc3RvcnkgZGF0YSBwcm92aWRlciBub3QgZm91bmQ7IGNoZWNrZWQ9JHtoaXN0b3J5TW9kdWxlUGF0aH1gKVxuICB9XG5cbiAgY29uc3Qgc2NyaXB0ID0gW1xuICAgICdjb25zdCB7IHBhdGhUb0ZpbGVVUkwgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6dXJsXCIpOycsXG4gICAgYGNvbnN0IG1vZCA9IGF3YWl0IGltcG9ydChwYXRoVG9GaWxlVVJMKHByb2Nlc3MuZW52LiR7SElTVE9SWV9NT0RVTEVfRU5WfSkuaHJlZik7YCxcbiAgICBgY29uc3QgbGVkZ2VyID0gbW9kLmxvYWRMZWRnZXJGcm9tRGlzayhwcm9jZXNzLmVudi5HU0RfSElTVE9SWV9CQVNFKTtgLFxuICAgICdjb25zdCB1bml0cyA9IGxlZGdlciA/IGxlZGdlci51bml0cyA6IFtdOycsXG4gICAgJ2NvbnN0IHRvdGFscyA9IG1vZC5nZXRQcm9qZWN0VG90YWxzKHVuaXRzKTsnLFxuICAgICdjb25zdCBieVBoYXNlID0gbW9kLmFnZ3JlZ2F0ZUJ5UGhhc2UodW5pdHMpOycsXG4gICAgJ2NvbnN0IGJ5U2xpY2UgPSBtb2QuYWdncmVnYXRlQnlTbGljZSh1bml0cyk7JyxcbiAgICAnY29uc3QgYnlNb2RlbCA9IG1vZC5hZ2dyZWdhdGVCeU1vZGVsKHVuaXRzKTsnLFxuICAgICdwcm9jZXNzLnN0ZG91dC53cml0ZShKU09OLnN0cmluZ2lmeSh7IHVuaXRzLCB0b3RhbHMsIGJ5UGhhc2UsIGJ5U2xpY2UsIGJ5TW9kZWwgfSkpOycsXG4gIF0uam9pbihcIiBcIilcblxuICBjb25zdCBwcmVmaXhBcmdzID0gYnVpbGRTdWJwcm9jZXNzUHJlZml4QXJncyhwYWNrYWdlUm9vdCwgbW9kdWxlUmVzb2x1dGlvbiwgcGF0aFRvRmlsZVVSTChyZXNvbHZlVHNMb2FkZXIpLmhyZWYpXG5cbiAgcmV0dXJuIGF3YWl0IG5ldyBQcm9taXNlPEhpc3RvcnlEYXRhPigocmVzb2x2ZVJlc3VsdCwgcmVqZWN0KSA9PiB7XG4gICAgZXhlY0ZpbGUoXG4gICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgW1xuICAgICAgICAuLi5wcmVmaXhBcmdzLFxuICAgICAgICBcIi0tZXZhbFwiLFxuICAgICAgICBzY3JpcHQsXG4gICAgICBdLFxuICAgICAge1xuICAgICAgICBjd2Q6IHBhY2thZ2VSb290LFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgICBbSElTVE9SWV9NT0RVTEVfRU5WXTogaGlzdG9yeU1vZHVsZVBhdGgsXG4gICAgICAgICAgR1NEX0hJU1RPUllfQkFTRTogcHJvamVjdEN3ZCxcbiAgICAgICAgfSxcbiAgICAgICAgbWF4QnVmZmVyOiBISVNUT1JZX01BWF9CVUZGRVIsXG4gICAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIChlcnJvciwgc3Rkb3V0LCBzdGRlcnIpID0+IHtcbiAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgaGlzdG9yeSBkYXRhIHN1YnByb2Nlc3MgZmFpbGVkOiAke3N0ZGVyciB8fCBlcnJvci5tZXNzYWdlfWApKVxuICAgICAgICAgIHJldHVyblxuICAgICAgICB9XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXNvbHZlUmVzdWx0KEpTT04ucGFyc2Uoc3Rkb3V0KSBhcyBIaXN0b3J5RGF0YSlcbiAgICAgICAgfSBjYXRjaCAocGFyc2VFcnJvcikge1xuICAgICAgICAgIHJlamVjdChcbiAgICAgICAgICAgIG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgYGhpc3RvcnkgZGF0YSBzdWJwcm9jZXNzIHJldHVybmVkIGludmFsaWQgSlNPTjogJHtwYXJzZUVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBwYXJzZUVycm9yLm1lc3NhZ2UgOiBTdHJpbmcocGFyc2VFcnJvcil9YCxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICB9LFxuICAgIClcbiAgfSlcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsZ0JBQWdCO0FBQ3pCLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsWUFBWTtBQUNyQixTQUFTLHFCQUFxQjtBQUU5QixTQUFTLGtDQUFrQztBQUMzQyxTQUFtQyx5QkFBeUIsaUNBQWlDO0FBRzdGLE1BQU0scUJBQXFCLElBQUksT0FBTztBQUN0QyxNQUFNLHFCQUFxQjtBQUUzQixTQUFTLG9CQUFvQixhQUE2QjtBQUN4RCxTQUFPLEtBQUssYUFBYSxPQUFPLGFBQWEsY0FBYyxPQUFPLFNBQVMsZ0JBQWdCO0FBQzdGO0FBT0EsZUFBc0IsbUJBQW1CLG9CQUFtRDtBQUMxRixRQUFNLFNBQVMsMkJBQTJCLFFBQVcsa0JBQWtCO0FBQ3ZFLFFBQU0sRUFBRSxhQUFhLFdBQVcsSUFBSTtBQUVwQyxRQUFNLGtCQUFrQixvQkFBb0IsV0FBVztBQUN2RCxRQUFNLG1CQUFtQix3QkFBd0IsYUFBYSxxQ0FBcUM7QUFDbkcsUUFBTSxvQkFBb0IsaUJBQWlCO0FBRTNDLE1BQUksQ0FBQyxpQkFBaUIsa0JBQWtCLENBQUMsV0FBVyxlQUFlLEtBQUssQ0FBQyxXQUFXLGlCQUFpQixJQUFJO0FBQ3ZHLFVBQU0sSUFBSTtBQUFBLE1BQ1IsNENBQTRDLGVBQWUsSUFBSSxpQkFBaUI7QUFBQSxJQUNsRjtBQUFBLEVBQ0Y7QUFDQSxNQUFJLGlCQUFpQixpQkFBaUIsQ0FBQyxXQUFXLGlCQUFpQixHQUFHO0FBQ3BFLFVBQU0sSUFBSSxNQUFNLDRDQUE0QyxpQkFBaUIsRUFBRTtBQUFBLEVBQ2pGO0FBRUEsUUFBTSxTQUFTO0FBQUEsSUFDYjtBQUFBLElBQ0Esc0RBQXNELGtCQUFrQjtBQUFBLElBQ3hFO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixFQUFFLEtBQUssR0FBRztBQUVWLFFBQU0sYUFBYSwwQkFBMEIsYUFBYSxrQkFBa0IsY0FBYyxlQUFlLEVBQUUsSUFBSTtBQUUvRyxTQUFPLE1BQU0sSUFBSSxRQUFxQixDQUFDLGVBQWUsV0FBVztBQUMvRDtBQUFBLE1BQ0UsUUFBUTtBQUFBLE1BQ1I7QUFBQSxRQUNFLEdBQUc7QUFBQSxRQUNIO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFBQSxNQUNBO0FBQUEsUUFDRSxLQUFLO0FBQUEsUUFDTCxLQUFLO0FBQUEsVUFDSCxHQUFHLFFBQVE7QUFBQSxVQUNYLENBQUMsa0JBQWtCLEdBQUc7QUFBQSxVQUN0QixrQkFBa0I7QUFBQSxRQUNwQjtBQUFBLFFBQ0EsV0FBVztBQUFBLFFBQ1gsYUFBYTtBQUFBLE1BQ2Y7QUFBQSxNQUNBLENBQUMsT0FBTyxRQUFRLFdBQVc7QUFDekIsWUFBSSxPQUFPO0FBQ1QsaUJBQU8sSUFBSSxNQUFNLG1DQUFtQyxVQUFVLE1BQU0sT0FBTyxFQUFFLENBQUM7QUFDOUU7QUFBQSxRQUNGO0FBRUEsWUFBSTtBQUNGLHdCQUFjLEtBQUssTUFBTSxNQUFNLENBQWdCO0FBQUEsUUFDakQsU0FBUyxZQUFZO0FBQ25CO0FBQUEsWUFDRSxJQUFJO0FBQUEsY0FDRixrREFBa0Qsc0JBQXNCLFFBQVEsV0FBVyxVQUFVLE9BQU8sVUFBVSxDQUFDO0FBQUEsWUFDekg7QUFBQSxVQUNGO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBQ0g7IiwKICAibmFtZXMiOiBbXQp9Cg==
