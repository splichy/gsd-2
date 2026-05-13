import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBridgeRuntimeConfig } from "./bridge-service.js";
import { resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.js";
const EXPORT_MAX_BUFFER = 4 * 1024 * 1024;
const EXPORT_MODULE_ENV = "GSD_EXPORT_MODULE";
function resolveTsLoaderPath(packageRoot) {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
}
async function collectExportData(format = "markdown", projectCwdOverride) {
  const config = resolveBridgeRuntimeConfig(void 0, projectCwdOverride);
  const { packageRoot, projectCwd } = config;
  const resolveTsLoader = resolveTsLoaderPath(packageRoot);
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/export.ts");
  const exportModulePath = moduleResolution.modulePath;
  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(exportModulePath))) {
    throw new Error(
      `export data provider not found; checked=${resolveTsLoader},${exportModulePath}`
    );
  }
  if (moduleResolution.useCompiledJs && !existsSync(exportModulePath)) {
    throw new Error(`export data provider not found; checked=${exportModulePath}`);
  }
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${EXPORT_MODULE_ENV}).href);`,
    'const format = process.env.GSD_EXPORT_FORMAT || "markdown";',
    "const basePath = process.env.GSD_EXPORT_BASE;",
    "const filePath = mod.writeExportFile(basePath, format);",
    "if (filePath) {",
    '  const { readFileSync } = await import("node:fs");',
    '  const { basename } = await import("node:path");',
    '  const content = readFileSync(filePath, "utf-8");',
    "  process.stdout.write(JSON.stringify({ content, format, filename: basename(filePath) }));",
    "} else {",
    '  process.stdout.write(JSON.stringify({ content: "No metrics data available for export.", format, filename: "export." + (format === "json" ? "json" : "md") }));',
    "}"
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
          [EXPORT_MODULE_ENV]: exportModulePath,
          GSD_EXPORT_BASE: projectCwd,
          GSD_EXPORT_FORMAT: format
        },
        maxBuffer: EXPORT_MAX_BUFFER,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`export data subprocess failed: ${stderr || error.message}`));
          return;
        }
        try {
          resolveResult(JSON.parse(stdout));
        } catch (parseError) {
          reject(
            new Error(
              `export data subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            )
          );
        }
      }
    );
  });
}
export {
  collectExportData
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3dlYi9leHBvcnQtc2VydmljZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZXhlY0ZpbGUgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCJcbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiXG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiXG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCJcblxuaW1wb3J0IHsgcmVzb2x2ZUJyaWRnZVJ1bnRpbWVDb25maWcgfSBmcm9tIFwiLi9icmlkZ2Utc2VydmljZS50c1wiXG5pbXBvcnQgeyByZXNvbHZlVHlwZVN0cmlwcGluZ0ZsYWcsIHJlc29sdmVTdWJwcm9jZXNzTW9kdWxlLCBidWlsZFN1YnByb2Nlc3NQcmVmaXhBcmdzIH0gZnJvbSBcIi4vdHMtc3VicHJvY2Vzcy1mbGFncy50c1wiXG5pbXBvcnQgdHlwZSB7IEV4cG9ydFJlc3VsdCB9IGZyb20gXCIuLi8uLi93ZWIvbGliL3JlbWFpbmluZy1jb21tYW5kLXR5cGVzLnRzXCJcblxuY29uc3QgRVhQT1JUX01BWF9CVUZGRVIgPSA0ICogMTAyNCAqIDEwMjRcbmNvbnN0IEVYUE9SVF9NT0RVTEVfRU5WID0gXCJHU0RfRVhQT1JUX01PRFVMRVwiXG5cbmZ1bmN0aW9uIHJlc29sdmVUc0xvYWRlclBhdGgocGFja2FnZVJvb3Q6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKHBhY2thZ2VSb290LCBcInNyY1wiLCBcInJlc291cmNlc1wiLCBcImV4dGVuc2lvbnNcIiwgXCJnc2RcIiwgXCJ0ZXN0c1wiLCBcInJlc29sdmUtdHMubWpzXCIpXG59XG5cbi8qKlxuICogR2VuZXJhdGVzIGFuIGV4cG9ydCBmaWxlIHZpYSBhIGNoaWxkIHByb2Nlc3MgYW5kIHJldHVybnMgaXRzIGNvbnRlbnQuXG4gKiBUaGUgY2hpbGQgY2FsbHMgd3JpdGVFeHBvcnRGaWxlKCkgd2hpY2ggY3JlYXRlcyBhIHRpbWVzdGFtcGVkIGZpbGUgaW4gLmdzZC8sXG4gKiB0aGVuIHJlYWRzIGl0cyBjb250ZW50IGJhY2sgZm9yIGJyb3dzZXIgZGlzcGxheS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvbGxlY3RFeHBvcnREYXRhKFxuICBmb3JtYXQ6IFwibWFya2Rvd25cIiB8IFwianNvblwiID0gXCJtYXJrZG93blwiLFxuICBwcm9qZWN0Q3dkT3ZlcnJpZGU/OiBzdHJpbmcsXG4pOiBQcm9taXNlPEV4cG9ydFJlc3VsdD4ge1xuICBjb25zdCBjb25maWcgPSByZXNvbHZlQnJpZGdlUnVudGltZUNvbmZpZyh1bmRlZmluZWQsIHByb2plY3RDd2RPdmVycmlkZSlcbiAgY29uc3QgeyBwYWNrYWdlUm9vdCwgcHJvamVjdEN3ZCB9ID0gY29uZmlnXG5cbiAgY29uc3QgcmVzb2x2ZVRzTG9hZGVyID0gcmVzb2x2ZVRzTG9hZGVyUGF0aChwYWNrYWdlUm9vdClcbiAgY29uc3QgbW9kdWxlUmVzb2x1dGlvbiA9IHJlc29sdmVTdWJwcm9jZXNzTW9kdWxlKHBhY2thZ2VSb290LCBcInJlc291cmNlcy9leHRlbnNpb25zL2dzZC9leHBvcnQudHNcIilcbiAgY29uc3QgZXhwb3J0TW9kdWxlUGF0aCA9IG1vZHVsZVJlc29sdXRpb24ubW9kdWxlUGF0aFxuXG4gIGlmICghbW9kdWxlUmVzb2x1dGlvbi51c2VDb21waWxlZEpzICYmICghZXhpc3RzU3luYyhyZXNvbHZlVHNMb2FkZXIpIHx8ICFleGlzdHNTeW5jKGV4cG9ydE1vZHVsZVBhdGgpKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBleHBvcnQgZGF0YSBwcm92aWRlciBub3QgZm91bmQ7IGNoZWNrZWQ9JHtyZXNvbHZlVHNMb2FkZXJ9LCR7ZXhwb3J0TW9kdWxlUGF0aH1gLFxuICAgIClcbiAgfVxuICBpZiAobW9kdWxlUmVzb2x1dGlvbi51c2VDb21waWxlZEpzICYmICFleGlzdHNTeW5jKGV4cG9ydE1vZHVsZVBhdGgpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBleHBvcnQgZGF0YSBwcm92aWRlciBub3QgZm91bmQ7IGNoZWNrZWQ9JHtleHBvcnRNb2R1bGVQYXRofWApXG4gIH1cblxuICBjb25zdCBzY3JpcHQgPSBbXG4gICAgJ2NvbnN0IHsgcGF0aFRvRmlsZVVSTCB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTp1cmxcIik7JyxcbiAgICBgY29uc3QgbW9kID0gYXdhaXQgaW1wb3J0KHBhdGhUb0ZpbGVVUkwocHJvY2Vzcy5lbnYuJHtFWFBPUlRfTU9EVUxFX0VOVn0pLmhyZWYpO2AsXG4gICAgJ2NvbnN0IGZvcm1hdCA9IHByb2Nlc3MuZW52LkdTRF9FWFBPUlRfRk9STUFUIHx8IFwibWFya2Rvd25cIjsnLFxuICAgICdjb25zdCBiYXNlUGF0aCA9IHByb2Nlc3MuZW52LkdTRF9FWFBPUlRfQkFTRTsnLFxuICAgICdjb25zdCBmaWxlUGF0aCA9IG1vZC53cml0ZUV4cG9ydEZpbGUoYmFzZVBhdGgsIGZvcm1hdCk7JyxcbiAgICAnaWYgKGZpbGVQYXRoKSB7JyxcbiAgICAnICBjb25zdCB7IHJlYWRGaWxlU3luYyB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTpmc1wiKTsnLFxuICAgICcgIGNvbnN0IHsgYmFzZW5hbWUgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6cGF0aFwiKTsnLFxuICAgICcgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoZmlsZVBhdGgsIFwidXRmLThcIik7JyxcbiAgICAnICBwcm9jZXNzLnN0ZG91dC53cml0ZShKU09OLnN0cmluZ2lmeSh7IGNvbnRlbnQsIGZvcm1hdCwgZmlsZW5hbWU6IGJhc2VuYW1lKGZpbGVQYXRoKSB9KSk7JyxcbiAgICAnfSBlbHNlIHsnLFxuICAgICcgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKEpTT04uc3RyaW5naWZ5KHsgY29udGVudDogXCJObyBtZXRyaWNzIGRhdGEgYXZhaWxhYmxlIGZvciBleHBvcnQuXCIsIGZvcm1hdCwgZmlsZW5hbWU6IFwiZXhwb3J0LlwiICsgKGZvcm1hdCA9PT0gXCJqc29uXCIgPyBcImpzb25cIiA6IFwibWRcIikgfSkpOycsXG4gICAgJ30nLFxuICBdLmpvaW4oXCIgXCIpXG5cbiAgY29uc3QgcHJlZml4QXJncyA9IGJ1aWxkU3VicHJvY2Vzc1ByZWZpeEFyZ3MocGFja2FnZVJvb3QsIG1vZHVsZVJlc29sdXRpb24sIHBhdGhUb0ZpbGVVUkwocmVzb2x2ZVRzTG9hZGVyKS5ocmVmKVxuXG4gIHJldHVybiBhd2FpdCBuZXcgUHJvbWlzZTxFeHBvcnRSZXN1bHQ+KChyZXNvbHZlUmVzdWx0LCByZWplY3QpID0+IHtcbiAgICBleGVjRmlsZShcbiAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICBbXG4gICAgICAgIC4uLnByZWZpeEFyZ3MsXG4gICAgICAgIFwiLS1ldmFsXCIsXG4gICAgICAgIHNjcmlwdCxcbiAgICAgIF0sXG4gICAgICB7XG4gICAgICAgIGN3ZDogcGFja2FnZVJvb3QsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICAgIFtFWFBPUlRfTU9EVUxFX0VOVl06IGV4cG9ydE1vZHVsZVBhdGgsXG4gICAgICAgICAgR1NEX0VYUE9SVF9CQVNFOiBwcm9qZWN0Q3dkLFxuICAgICAgICAgIEdTRF9FWFBPUlRfRk9STUFUOiBmb3JtYXQsXG4gICAgICAgIH0sXG4gICAgICAgIG1heEJ1ZmZlcjogRVhQT1JUX01BWF9CVUZGRVIsXG4gICAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIChlcnJvciwgc3Rkb3V0LCBzdGRlcnIpID0+IHtcbiAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgZXhwb3J0IGRhdGEgc3VicHJvY2VzcyBmYWlsZWQ6ICR7c3RkZXJyIHx8IGVycm9yLm1lc3NhZ2V9YCkpXG4gICAgICAgICAgcmV0dXJuXG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlc29sdmVSZXN1bHQoSlNPTi5wYXJzZShzdGRvdXQpIGFzIEV4cG9ydFJlc3VsdClcbiAgICAgICAgfSBjYXRjaCAocGFyc2VFcnJvcikge1xuICAgICAgICAgIHJlamVjdChcbiAgICAgICAgICAgIG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgYGV4cG9ydCBkYXRhIHN1YnByb2Nlc3MgcmV0dXJuZWQgaW52YWxpZCBKU09OOiAke3BhcnNlRXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IHBhcnNlRXJyb3IubWVzc2FnZSA6IFN0cmluZyhwYXJzZUVycm9yKX1gLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgKVxuICB9KVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxZQUFZO0FBQ3JCLFNBQVMscUJBQXFCO0FBRTlCLFNBQVMsa0NBQWtDO0FBQzNDLFNBQW1DLHlCQUF5QixpQ0FBaUM7QUFHN0YsTUFBTSxvQkFBb0IsSUFBSSxPQUFPO0FBQ3JDLE1BQU0sb0JBQW9CO0FBRTFCLFNBQVMsb0JBQW9CLGFBQTZCO0FBQ3hELFNBQU8sS0FBSyxhQUFhLE9BQU8sYUFBYSxjQUFjLE9BQU8sU0FBUyxnQkFBZ0I7QUFDN0Y7QUFPQSxlQUFzQixrQkFDcEIsU0FBOEIsWUFDOUIsb0JBQ3VCO0FBQ3ZCLFFBQU0sU0FBUywyQkFBMkIsUUFBVyxrQkFBa0I7QUFDdkUsUUFBTSxFQUFFLGFBQWEsV0FBVyxJQUFJO0FBRXBDLFFBQU0sa0JBQWtCLG9CQUFvQixXQUFXO0FBQ3ZELFFBQU0sbUJBQW1CLHdCQUF3QixhQUFhLG9DQUFvQztBQUNsRyxRQUFNLG1CQUFtQixpQkFBaUI7QUFFMUMsTUFBSSxDQUFDLGlCQUFpQixrQkFBa0IsQ0FBQyxXQUFXLGVBQWUsS0FBSyxDQUFDLFdBQVcsZ0JBQWdCLElBQUk7QUFDdEcsVUFBTSxJQUFJO0FBQUEsTUFDUiwyQ0FBMkMsZUFBZSxJQUFJLGdCQUFnQjtBQUFBLElBQ2hGO0FBQUEsRUFDRjtBQUNBLE1BQUksaUJBQWlCLGlCQUFpQixDQUFDLFdBQVcsZ0JBQWdCLEdBQUc7QUFDbkUsVUFBTSxJQUFJLE1BQU0sMkNBQTJDLGdCQUFnQixFQUFFO0FBQUEsRUFDL0U7QUFFQSxRQUFNLFNBQVM7QUFBQSxJQUNiO0FBQUEsSUFDQSxzREFBc0QsaUJBQWlCO0FBQUEsSUFDdkU7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixFQUFFLEtBQUssR0FBRztBQUVWLFFBQU0sYUFBYSwwQkFBMEIsYUFBYSxrQkFBa0IsY0FBYyxlQUFlLEVBQUUsSUFBSTtBQUUvRyxTQUFPLE1BQU0sSUFBSSxRQUFzQixDQUFDLGVBQWUsV0FBVztBQUNoRTtBQUFBLE1BQ0UsUUFBUTtBQUFBLE1BQ1I7QUFBQSxRQUNFLEdBQUc7QUFBQSxRQUNIO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFBQSxNQUNBO0FBQUEsUUFDRSxLQUFLO0FBQUEsUUFDTCxLQUFLO0FBQUEsVUFDSCxHQUFHLFFBQVE7QUFBQSxVQUNYLENBQUMsaUJBQWlCLEdBQUc7QUFBQSxVQUNyQixpQkFBaUI7QUFBQSxVQUNqQixtQkFBbUI7QUFBQSxRQUNyQjtBQUFBLFFBQ0EsV0FBVztBQUFBLFFBQ1gsYUFBYTtBQUFBLE1BQ2Y7QUFBQSxNQUNBLENBQUMsT0FBTyxRQUFRLFdBQVc7QUFDekIsWUFBSSxPQUFPO0FBQ1QsaUJBQU8sSUFBSSxNQUFNLGtDQUFrQyxVQUFVLE1BQU0sT0FBTyxFQUFFLENBQUM7QUFDN0U7QUFBQSxRQUNGO0FBRUEsWUFBSTtBQUNGLHdCQUFjLEtBQUssTUFBTSxNQUFNLENBQWlCO0FBQUEsUUFDbEQsU0FBUyxZQUFZO0FBQ25CO0FBQUEsWUFDRSxJQUFJO0FBQUEsY0FDRixpREFBaUQsc0JBQXNCLFFBQVEsV0FBVyxVQUFVLE9BQU8sVUFBVSxDQUFDO0FBQUEsWUFDeEg7QUFBQSxVQUNGO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBQ0g7IiwKICAibmFtZXMiOiBbXQp9Cg==
