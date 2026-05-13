import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBridgeRuntimeConfig } from "./bridge-service.js";
import { resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.js";
const FORENSICS_MAX_BUFFER = 2 * 1024 * 1024;
const FORENSICS_MODULE_ENV = "GSD_FORENSICS_MODULE";
function resolveTsLoaderPath(packageRoot) {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
}
async function collectForensicsData(projectCwdOverride) {
  const config = resolveBridgeRuntimeConfig(void 0, projectCwdOverride);
  const { packageRoot, projectCwd } = config;
  const resolveTsLoader = resolveTsLoaderPath(packageRoot);
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/forensics.ts");
  const forensicsModulePath = moduleResolution.modulePath;
  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(forensicsModulePath))) {
    throw new Error(
      `forensics data provider not found; checked=${resolveTsLoader},${forensicsModulePath}`
    );
  }
  if (moduleResolution.useCompiledJs && !existsSync(forensicsModulePath)) {
    throw new Error(`forensics data provider not found; checked=${forensicsModulePath}`);
  }
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${FORENSICS_MODULE_ENV}).href);`,
    `const report = await mod.buildForensicReport(process.env.GSD_FORENSICS_BASE);`,
    // Simplify unitTraces: strip deep ExecutionTrace, keep file/unitType/unitId/seq/mtime
    "const unitTraces = (report.unitTraces || []).map(t => ({",
    "  file: t.file, unitType: t.unitType, unitId: t.unitId, seq: t.seq, mtime: t.mtime,",
    "}));",
    // Flatten metrics to summary
    "let metrics = null;",
    "if (report.metrics && report.metrics.units) {",
    "  const units = report.metrics.units;",
    "  const totalCost = units.reduce((s, u) => s + u.cost, 0);",
    "  const totalDuration = units.reduce((s, u) => s + (u.finishedAt - u.startedAt), 0);",
    "  metrics = { totalUnits: units.length, totalCost, totalDuration };",
    "}",
    "const result = {",
    "  gsdVersion: report.gsdVersion,",
    "  timestamp: report.timestamp,",
    "  basePath: report.basePath,",
    "  activeMilestone: report.activeMilestone,",
    "  activeSlice: report.activeSlice,",
    "  anomalies: report.anomalies,",
    "  recentUnits: report.recentUnits,",
    "  crashLock: report.crashLock,",
    "  doctorIssueCount: (report.doctorIssues || []).length,",
    "  unitTraceCount: unitTraces.length,",
    "  unitTraces,",
    "  completedKeyCount: (report.completedKeys || []).length,",
    "  metrics,",
    "  journalSummary: report.journalSummary || null,",
    "  activityLogMeta: report.activityLogMeta || null,",
    "};",
    "process.stdout.write(JSON.stringify(result));"
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
          [FORENSICS_MODULE_ENV]: forensicsModulePath,
          GSD_FORENSICS_BASE: projectCwd
        },
        maxBuffer: FORENSICS_MAX_BUFFER,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`forensics data subprocess failed: ${stderr || error.message}`));
          return;
        }
        try {
          resolveResult(JSON.parse(stdout));
        } catch (parseError) {
          reject(
            new Error(
              `forensics data subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            )
          );
        }
      }
    );
  });
}
export {
  collectForensicsData
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3dlYi9mb3JlbnNpY3Mtc2VydmljZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZXhlY0ZpbGUgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCJcbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiXG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiXG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCJcblxuaW1wb3J0IHsgcmVzb2x2ZUJyaWRnZVJ1bnRpbWVDb25maWcgfSBmcm9tIFwiLi9icmlkZ2Utc2VydmljZS50c1wiXG5pbXBvcnQgeyByZXNvbHZlVHlwZVN0cmlwcGluZ0ZsYWcsIHJlc29sdmVTdWJwcm9jZXNzTW9kdWxlLCBidWlsZFN1YnByb2Nlc3NQcmVmaXhBcmdzIH0gZnJvbSBcIi4vdHMtc3VicHJvY2Vzcy1mbGFncy50c1wiXG5pbXBvcnQgdHlwZSB7IEZvcmVuc2ljUmVwb3J0IH0gZnJvbSBcIi4uLy4uL3dlYi9saWIvZGlhZ25vc3RpY3MtdHlwZXMudHNcIlxuXG5jb25zdCBGT1JFTlNJQ1NfTUFYX0JVRkZFUiA9IDIgKiAxMDI0ICogMTAyNFxuY29uc3QgRk9SRU5TSUNTX01PRFVMRV9FTlYgPSBcIkdTRF9GT1JFTlNJQ1NfTU9EVUxFXCJcblxuZnVuY3Rpb24gcmVzb2x2ZVRzTG9hZGVyUGF0aChwYWNrYWdlUm9vdDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4ocGFja2FnZVJvb3QsIFwic3JjXCIsIFwicmVzb3VyY2VzXCIsIFwiZXh0ZW5zaW9uc1wiLCBcImdzZFwiLCBcInRlc3RzXCIsIFwicmVzb2x2ZS10cy5tanNcIilcbn1cblxuLyoqXG4gKiBMb2FkcyBmb3JlbnNpYyByZXBvcnQgZGF0YSB2aWEgYSBjaGlsZCBwcm9jZXNzLiBDb252ZXJ0cyB0aGUgZnVsbCB1cHN0cmVhbVxuICogRm9yZW5zaWNSZXBvcnQgaW50byBhIGJyb3dzZXItc2FmZSBzdWJzZXQ6IGRlZXAgRXhlY3V0aW9uVHJhY2Ugb2JqZWN0cyBhcmVcbiAqIHJlcGxhY2VkIHdpdGggdHJhY2UgY291bnRzIGFuZCBzaW1wbGlmaWVkIGVudHJpZXMsIE1ldHJpY3NMZWRnZXIgaXMgZmxhdHRlbmVkXG4gKiB0byBzdW1tYXJ5IHRvdGFscywgYW5kIGRvY3Rvcklzc3VlcyBpcyByZXBsYWNlZCB3aXRoIGEgY291bnQgKGRvY3RvciBwYW5lbFxuICogaGFzIGl0cyBvd24gZGVkaWNhdGVkIEFQSSByb3V0ZSkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb2xsZWN0Rm9yZW5zaWNzRGF0YShwcm9qZWN0Q3dkT3ZlcnJpZGU/OiBzdHJpbmcpOiBQcm9taXNlPEZvcmVuc2ljUmVwb3J0PiB7XG4gIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnKHVuZGVmaW5lZCwgcHJvamVjdEN3ZE92ZXJyaWRlKVxuICBjb25zdCB7IHBhY2thZ2VSb290LCBwcm9qZWN0Q3dkIH0gPSBjb25maWdcblxuICBjb25zdCByZXNvbHZlVHNMb2FkZXIgPSByZXNvbHZlVHNMb2FkZXJQYXRoKHBhY2thZ2VSb290KVxuICBjb25zdCBtb2R1bGVSZXNvbHV0aW9uID0gcmVzb2x2ZVN1YnByb2Nlc3NNb2R1bGUocGFja2FnZVJvb3QsIFwicmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2ZvcmVuc2ljcy50c1wiKVxuICBjb25zdCBmb3JlbnNpY3NNb2R1bGVQYXRoID0gbW9kdWxlUmVzb2x1dGlvbi5tb2R1bGVQYXRoXG5cbiAgaWYgKCFtb2R1bGVSZXNvbHV0aW9uLnVzZUNvbXBpbGVkSnMgJiYgKCFleGlzdHNTeW5jKHJlc29sdmVUc0xvYWRlcikgfHwgIWV4aXN0c1N5bmMoZm9yZW5zaWNzTW9kdWxlUGF0aCkpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGZvcmVuc2ljcyBkYXRhIHByb3ZpZGVyIG5vdCBmb3VuZDsgY2hlY2tlZD0ke3Jlc29sdmVUc0xvYWRlcn0sJHtmb3JlbnNpY3NNb2R1bGVQYXRofWAsXG4gICAgKVxuICB9XG4gIGlmIChtb2R1bGVSZXNvbHV0aW9uLnVzZUNvbXBpbGVkSnMgJiYgIWV4aXN0c1N5bmMoZm9yZW5zaWNzTW9kdWxlUGF0aCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYGZvcmVuc2ljcyBkYXRhIHByb3ZpZGVyIG5vdCBmb3VuZDsgY2hlY2tlZD0ke2ZvcmVuc2ljc01vZHVsZVBhdGh9YClcbiAgfVxuXG4gIC8vIFRoZSBjaGlsZCBzY3JpcHQgbG9hZHMgdGhlIHVwc3RyZWFtIG1vZHVsZSwgY2FsbHMgYnVpbGRGb3JlbnNpY1JlcG9ydCgpLFxuICAvLyBzaW1wbGlmaWVzIHRoZSBvdXRwdXQgZm9yIGJyb3dzZXIgY29uc3VtcHRpb24sIGFuZCB3cml0ZXMgSlNPTiB0byBzdGRvdXQuXG4gIGNvbnN0IHNjcmlwdCA9IFtcbiAgICAnY29uc3QgeyBwYXRoVG9GaWxlVVJMIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOnVybFwiKTsnLFxuICAgIGBjb25zdCBtb2QgPSBhd2FpdCBpbXBvcnQocGF0aFRvRmlsZVVSTChwcm9jZXNzLmVudi4ke0ZPUkVOU0lDU19NT0RVTEVfRU5WfSkuaHJlZik7YCxcbiAgICBgY29uc3QgcmVwb3J0ID0gYXdhaXQgbW9kLmJ1aWxkRm9yZW5zaWNSZXBvcnQocHJvY2Vzcy5lbnYuR1NEX0ZPUkVOU0lDU19CQVNFKTtgLFxuICAgIC8vIFNpbXBsaWZ5IHVuaXRUcmFjZXM6IHN0cmlwIGRlZXAgRXhlY3V0aW9uVHJhY2UsIGtlZXAgZmlsZS91bml0VHlwZS91bml0SWQvc2VxL210aW1lXG4gICAgJ2NvbnN0IHVuaXRUcmFjZXMgPSAocmVwb3J0LnVuaXRUcmFjZXMgfHwgW10pLm1hcCh0ID0+ICh7JyxcbiAgICAnICBmaWxlOiB0LmZpbGUsIHVuaXRUeXBlOiB0LnVuaXRUeXBlLCB1bml0SWQ6IHQudW5pdElkLCBzZXE6IHQuc2VxLCBtdGltZTogdC5tdGltZSwnLFxuICAgICd9KSk7JyxcbiAgICAvLyBGbGF0dGVuIG1ldHJpY3MgdG8gc3VtbWFyeVxuICAgICdsZXQgbWV0cmljcyA9IG51bGw7JyxcbiAgICAnaWYgKHJlcG9ydC5tZXRyaWNzICYmIHJlcG9ydC5tZXRyaWNzLnVuaXRzKSB7JyxcbiAgICAnICBjb25zdCB1bml0cyA9IHJlcG9ydC5tZXRyaWNzLnVuaXRzOycsXG4gICAgJyAgY29uc3QgdG90YWxDb3N0ID0gdW5pdHMucmVkdWNlKChzLCB1KSA9PiBzICsgdS5jb3N0LCAwKTsnLFxuICAgICcgIGNvbnN0IHRvdGFsRHVyYXRpb24gPSB1bml0cy5yZWR1Y2UoKHMsIHUpID0+IHMgKyAodS5maW5pc2hlZEF0IC0gdS5zdGFydGVkQXQpLCAwKTsnLFxuICAgICcgIG1ldHJpY3MgPSB7IHRvdGFsVW5pdHM6IHVuaXRzLmxlbmd0aCwgdG90YWxDb3N0LCB0b3RhbER1cmF0aW9uIH07JyxcbiAgICAnfScsXG4gICAgJ2NvbnN0IHJlc3VsdCA9IHsnLFxuICAgICcgIGdzZFZlcnNpb246IHJlcG9ydC5nc2RWZXJzaW9uLCcsXG4gICAgJyAgdGltZXN0YW1wOiByZXBvcnQudGltZXN0YW1wLCcsXG4gICAgJyAgYmFzZVBhdGg6IHJlcG9ydC5iYXNlUGF0aCwnLFxuICAgICcgIGFjdGl2ZU1pbGVzdG9uZTogcmVwb3J0LmFjdGl2ZU1pbGVzdG9uZSwnLFxuICAgICcgIGFjdGl2ZVNsaWNlOiByZXBvcnQuYWN0aXZlU2xpY2UsJyxcbiAgICAnICBhbm9tYWxpZXM6IHJlcG9ydC5hbm9tYWxpZXMsJyxcbiAgICAnICByZWNlbnRVbml0czogcmVwb3J0LnJlY2VudFVuaXRzLCcsXG4gICAgJyAgY3Jhc2hMb2NrOiByZXBvcnQuY3Jhc2hMb2NrLCcsXG4gICAgJyAgZG9jdG9ySXNzdWVDb3VudDogKHJlcG9ydC5kb2N0b3JJc3N1ZXMgfHwgW10pLmxlbmd0aCwnLFxuICAgICcgIHVuaXRUcmFjZUNvdW50OiB1bml0VHJhY2VzLmxlbmd0aCwnLFxuICAgICcgIHVuaXRUcmFjZXMsJyxcbiAgICAnICBjb21wbGV0ZWRLZXlDb3VudDogKHJlcG9ydC5jb21wbGV0ZWRLZXlzIHx8IFtdKS5sZW5ndGgsJyxcbiAgICAnICBtZXRyaWNzLCcsXG4gICAgJyAgam91cm5hbFN1bW1hcnk6IHJlcG9ydC5qb3VybmFsU3VtbWFyeSB8fCBudWxsLCcsXG4gICAgJyAgYWN0aXZpdHlMb2dNZXRhOiByZXBvcnQuYWN0aXZpdHlMb2dNZXRhIHx8IG51bGwsJyxcbiAgICAnfTsnLFxuICAgICdwcm9jZXNzLnN0ZG91dC53cml0ZShKU09OLnN0cmluZ2lmeShyZXN1bHQpKTsnLFxuICBdLmpvaW4oXCIgXCIpXG5cbiAgY29uc3QgcHJlZml4QXJncyA9IGJ1aWxkU3VicHJvY2Vzc1ByZWZpeEFyZ3MocGFja2FnZVJvb3QsIG1vZHVsZVJlc29sdXRpb24sIHBhdGhUb0ZpbGVVUkwocmVzb2x2ZVRzTG9hZGVyKS5ocmVmKVxuXG4gIHJldHVybiBhd2FpdCBuZXcgUHJvbWlzZTxGb3JlbnNpY1JlcG9ydD4oKHJlc29sdmVSZXN1bHQsIHJlamVjdCkgPT4ge1xuICAgIGV4ZWNGaWxlKFxuICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgIFtcbiAgICAgICAgLi4ucHJlZml4QXJncyxcbiAgICAgICAgXCItLWV2YWxcIixcbiAgICAgICAgc2NyaXB0LFxuICAgICAgXSxcbiAgICAgIHtcbiAgICAgICAgY3dkOiBwYWNrYWdlUm9vdCxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgLi4ucHJvY2Vzcy5lbnYsXG4gICAgICAgICAgW0ZPUkVOU0lDU19NT0RVTEVfRU5WXTogZm9yZW5zaWNzTW9kdWxlUGF0aCxcbiAgICAgICAgICBHU0RfRk9SRU5TSUNTX0JBU0U6IHByb2plY3RDd2QsXG4gICAgICAgIH0sXG4gICAgICAgIG1heEJ1ZmZlcjogRk9SRU5TSUNTX01BWF9CVUZGRVIsXG4gICAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIChlcnJvciwgc3Rkb3V0LCBzdGRlcnIpID0+IHtcbiAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgZm9yZW5zaWNzIGRhdGEgc3VicHJvY2VzcyBmYWlsZWQ6ICR7c3RkZXJyIHx8IGVycm9yLm1lc3NhZ2V9YCkpXG4gICAgICAgICAgcmV0dXJuXG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlc29sdmVSZXN1bHQoSlNPTi5wYXJzZShzdGRvdXQpIGFzIEZvcmVuc2ljUmVwb3J0KVxuICAgICAgICB9IGNhdGNoIChwYXJzZUVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KFxuICAgICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgICBgZm9yZW5zaWNzIGRhdGEgc3VicHJvY2VzcyByZXR1cm5lZCBpbnZhbGlkIEpTT046ICR7cGFyc2VFcnJvciBpbnN0YW5jZW9mIEVycm9yID8gcGFyc2VFcnJvci5tZXNzYWdlIDogU3RyaW5nKHBhcnNlRXJyb3IpfWAsXG4gICAgICAgICAgICApLFxuICAgICAgICAgIClcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICApXG4gIH0pXG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLGdCQUFnQjtBQUN6QixTQUFTLGtCQUFrQjtBQUMzQixTQUFTLFlBQVk7QUFDckIsU0FBUyxxQkFBcUI7QUFFOUIsU0FBUyxrQ0FBa0M7QUFDM0MsU0FBbUMseUJBQXlCLGlDQUFpQztBQUc3RixNQUFNLHVCQUF1QixJQUFJLE9BQU87QUFDeEMsTUFBTSx1QkFBdUI7QUFFN0IsU0FBUyxvQkFBb0IsYUFBNkI7QUFDeEQsU0FBTyxLQUFLLGFBQWEsT0FBTyxhQUFhLGNBQWMsT0FBTyxTQUFTLGdCQUFnQjtBQUM3RjtBQVNBLGVBQXNCLHFCQUFxQixvQkFBc0Q7QUFDL0YsUUFBTSxTQUFTLDJCQUEyQixRQUFXLGtCQUFrQjtBQUN2RSxRQUFNLEVBQUUsYUFBYSxXQUFXLElBQUk7QUFFcEMsUUFBTSxrQkFBa0Isb0JBQW9CLFdBQVc7QUFDdkQsUUFBTSxtQkFBbUIsd0JBQXdCLGFBQWEsdUNBQXVDO0FBQ3JHLFFBQU0sc0JBQXNCLGlCQUFpQjtBQUU3QyxNQUFJLENBQUMsaUJBQWlCLGtCQUFrQixDQUFDLFdBQVcsZUFBZSxLQUFLLENBQUMsV0FBVyxtQkFBbUIsSUFBSTtBQUN6RyxVQUFNLElBQUk7QUFBQSxNQUNSLDhDQUE4QyxlQUFlLElBQUksbUJBQW1CO0FBQUEsSUFDdEY7QUFBQSxFQUNGO0FBQ0EsTUFBSSxpQkFBaUIsaUJBQWlCLENBQUMsV0FBVyxtQkFBbUIsR0FBRztBQUN0RSxVQUFNLElBQUksTUFBTSw4Q0FBOEMsbUJBQW1CLEVBQUU7QUFBQSxFQUNyRjtBQUlBLFFBQU0sU0FBUztBQUFBLElBQ2I7QUFBQSxJQUNBLHNEQUFzRCxvQkFBb0I7QUFBQSxJQUMxRTtBQUFBO0FBQUEsSUFFQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUE7QUFBQSxJQUVBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixFQUFFLEtBQUssR0FBRztBQUVWLFFBQU0sYUFBYSwwQkFBMEIsYUFBYSxrQkFBa0IsY0FBYyxlQUFlLEVBQUUsSUFBSTtBQUUvRyxTQUFPLE1BQU0sSUFBSSxRQUF3QixDQUFDLGVBQWUsV0FBVztBQUNsRTtBQUFBLE1BQ0UsUUFBUTtBQUFBLE1BQ1I7QUFBQSxRQUNFLEdBQUc7QUFBQSxRQUNIO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFBQSxNQUNBO0FBQUEsUUFDRSxLQUFLO0FBQUEsUUFDTCxLQUFLO0FBQUEsVUFDSCxHQUFHLFFBQVE7QUFBQSxVQUNYLENBQUMsb0JBQW9CLEdBQUc7QUFBQSxVQUN4QixvQkFBb0I7QUFBQSxRQUN0QjtBQUFBLFFBQ0EsV0FBVztBQUFBLFFBQ1gsYUFBYTtBQUFBLE1BQ2Y7QUFBQSxNQUNBLENBQUMsT0FBTyxRQUFRLFdBQVc7QUFDekIsWUFBSSxPQUFPO0FBQ1QsaUJBQU8sSUFBSSxNQUFNLHFDQUFxQyxVQUFVLE1BQU0sT0FBTyxFQUFFLENBQUM7QUFDaEY7QUFBQSxRQUNGO0FBRUEsWUFBSTtBQUNGLHdCQUFjLEtBQUssTUFBTSxNQUFNLENBQW1CO0FBQUEsUUFDcEQsU0FBUyxZQUFZO0FBQ25CO0FBQUEsWUFDRSxJQUFJO0FBQUEsY0FDRixvREFBb0Qsc0JBQXNCLFFBQVEsV0FBVyxVQUFVLE9BQU8sVUFBVSxDQUFDO0FBQUEsWUFDM0g7QUFBQSxVQUNGO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBQ0g7IiwKICAibmFtZXMiOiBbXQp9Cg==
