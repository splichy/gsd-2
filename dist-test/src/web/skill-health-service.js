import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBridgeRuntimeConfig } from "./bridge-service.js";
import { resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.js";
const SKILL_HEALTH_MAX_BUFFER = 2 * 1024 * 1024;
const SKILL_HEALTH_MODULE_ENV = "GSD_SKILL_HEALTH_MODULE";
function resolveTsLoaderPath(packageRoot) {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
}
async function collectSkillHealthData(projectCwdOverride) {
  const config = resolveBridgeRuntimeConfig(void 0, projectCwdOverride);
  const { packageRoot, projectCwd } = config;
  const resolveTsLoader = resolveTsLoaderPath(packageRoot);
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/skill-health.ts");
  const skillHealthModulePath = moduleResolution.modulePath;
  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(skillHealthModulePath))) {
    throw new Error(
      `skill-health data provider not found; checked=${resolveTsLoader},${skillHealthModulePath}`
    );
  }
  if (moduleResolution.useCompiledJs && !existsSync(skillHealthModulePath)) {
    throw new Error(`skill-health data provider not found; checked=${skillHealthModulePath}`);
  }
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${SKILL_HEALTH_MODULE_ENV}).href);`,
    "const basePath = process.env.GSD_SKILL_HEALTH_BASE;",
    "const report = mod.generateSkillHealthReport(basePath);",
    "process.stdout.write(JSON.stringify(report));"
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
          [SKILL_HEALTH_MODULE_ENV]: skillHealthModulePath,
          GSD_SKILL_HEALTH_BASE: projectCwd
        },
        maxBuffer: SKILL_HEALTH_MAX_BUFFER,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`skill-health subprocess failed: ${stderr || error.message}`));
          return;
        }
        try {
          resolveResult(JSON.parse(stdout));
        } catch (parseError) {
          reject(
            new Error(
              `skill-health subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            )
          );
        }
      }
    );
  });
}
export {
  collectSkillHealthData
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3dlYi9za2lsbC1oZWFsdGgtc2VydmljZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZXhlY0ZpbGUgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCJcbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiXG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiXG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCJcblxuaW1wb3J0IHsgcmVzb2x2ZUJyaWRnZVJ1bnRpbWVDb25maWcgfSBmcm9tIFwiLi9icmlkZ2Utc2VydmljZS50c1wiXG5pbXBvcnQgeyByZXNvbHZlVHlwZVN0cmlwcGluZ0ZsYWcsIHJlc29sdmVTdWJwcm9jZXNzTW9kdWxlLCBidWlsZFN1YnByb2Nlc3NQcmVmaXhBcmdzIH0gZnJvbSBcIi4vdHMtc3VicHJvY2Vzcy1mbGFncy50c1wiXG5pbXBvcnQgdHlwZSB7IFNraWxsSGVhbHRoUmVwb3J0IH0gZnJvbSBcIi4uLy4uL3dlYi9saWIvZGlhZ25vc3RpY3MtdHlwZXMudHNcIlxuXG5jb25zdCBTS0lMTF9IRUFMVEhfTUFYX0JVRkZFUiA9IDIgKiAxMDI0ICogMTAyNFxuY29uc3QgU0tJTExfSEVBTFRIX01PRFVMRV9FTlYgPSBcIkdTRF9TS0lMTF9IRUFMVEhfTU9EVUxFXCJcblxuZnVuY3Rpb24gcmVzb2x2ZVRzTG9hZGVyUGF0aChwYWNrYWdlUm9vdDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4ocGFja2FnZVJvb3QsIFwic3JjXCIsIFwicmVzb3VyY2VzXCIsIFwiZXh0ZW5zaW9uc1wiLCBcImdzZFwiLCBcInRlc3RzXCIsIFwicmVzb2x2ZS10cy5tanNcIilcbn1cblxuLyoqXG4gKiBMb2FkcyBza2lsbCBoZWFsdGggcmVwb3J0IHZpYSBhIGNoaWxkIHByb2Nlc3MuXG4gKiBTa2lsbEhlYWx0aFJlcG9ydCBpcyBhbHJlYWR5IGFsbCBwbGFpbiBvYmplY3RzIFx1MjAxNCBubyBNYXAvU2V0IGNvbnZlcnNpb24gbmVlZGVkLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY29sbGVjdFNraWxsSGVhbHRoRGF0YShwcm9qZWN0Q3dkT3ZlcnJpZGU/OiBzdHJpbmcpOiBQcm9taXNlPFNraWxsSGVhbHRoUmVwb3J0PiB7XG4gIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnKHVuZGVmaW5lZCwgcHJvamVjdEN3ZE92ZXJyaWRlKVxuICBjb25zdCB7IHBhY2thZ2VSb290LCBwcm9qZWN0Q3dkIH0gPSBjb25maWdcblxuICBjb25zdCByZXNvbHZlVHNMb2FkZXIgPSByZXNvbHZlVHNMb2FkZXJQYXRoKHBhY2thZ2VSb290KVxuICBjb25zdCBtb2R1bGVSZXNvbHV0aW9uID0gcmVzb2x2ZVN1YnByb2Nlc3NNb2R1bGUocGFja2FnZVJvb3QsIFwicmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3NraWxsLWhlYWx0aC50c1wiKVxuICBjb25zdCBza2lsbEhlYWx0aE1vZHVsZVBhdGggPSBtb2R1bGVSZXNvbHV0aW9uLm1vZHVsZVBhdGhcblxuICBpZiAoIW1vZHVsZVJlc29sdXRpb24udXNlQ29tcGlsZWRKcyAmJiAoIWV4aXN0c1N5bmMocmVzb2x2ZVRzTG9hZGVyKSB8fCAhZXhpc3RzU3luYyhza2lsbEhlYWx0aE1vZHVsZVBhdGgpKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBza2lsbC1oZWFsdGggZGF0YSBwcm92aWRlciBub3QgZm91bmQ7IGNoZWNrZWQ9JHtyZXNvbHZlVHNMb2FkZXJ9LCR7c2tpbGxIZWFsdGhNb2R1bGVQYXRofWAsXG4gICAgKVxuICB9XG4gIGlmIChtb2R1bGVSZXNvbHV0aW9uLnVzZUNvbXBpbGVkSnMgJiYgIWV4aXN0c1N5bmMoc2tpbGxIZWFsdGhNb2R1bGVQYXRoKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgc2tpbGwtaGVhbHRoIGRhdGEgcHJvdmlkZXIgbm90IGZvdW5kOyBjaGVja2VkPSR7c2tpbGxIZWFsdGhNb2R1bGVQYXRofWApXG4gIH1cblxuICBjb25zdCBzY3JpcHQgPSBbXG4gICAgJ2NvbnN0IHsgcGF0aFRvRmlsZVVSTCB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTp1cmxcIik7JyxcbiAgICBgY29uc3QgbW9kID0gYXdhaXQgaW1wb3J0KHBhdGhUb0ZpbGVVUkwocHJvY2Vzcy5lbnYuJHtTS0lMTF9IRUFMVEhfTU9EVUxFX0VOVn0pLmhyZWYpO2AsXG4gICAgJ2NvbnN0IGJhc2VQYXRoID0gcHJvY2Vzcy5lbnYuR1NEX1NLSUxMX0hFQUxUSF9CQVNFOycsXG4gICAgJ2NvbnN0IHJlcG9ydCA9IG1vZC5nZW5lcmF0ZVNraWxsSGVhbHRoUmVwb3J0KGJhc2VQYXRoKTsnLFxuICAgICdwcm9jZXNzLnN0ZG91dC53cml0ZShKU09OLnN0cmluZ2lmeShyZXBvcnQpKTsnLFxuICBdLmpvaW4oXCIgXCIpXG5cbiAgY29uc3QgcHJlZml4QXJncyA9IGJ1aWxkU3VicHJvY2Vzc1ByZWZpeEFyZ3MocGFja2FnZVJvb3QsIG1vZHVsZVJlc29sdXRpb24sIHBhdGhUb0ZpbGVVUkwocmVzb2x2ZVRzTG9hZGVyKS5ocmVmKVxuXG4gIHJldHVybiBhd2FpdCBuZXcgUHJvbWlzZTxTa2lsbEhlYWx0aFJlcG9ydD4oKHJlc29sdmVSZXN1bHQsIHJlamVjdCkgPT4ge1xuICAgIGV4ZWNGaWxlKFxuICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgIFtcbiAgICAgICAgLi4ucHJlZml4QXJncyxcbiAgICAgICAgXCItLWV2YWxcIixcbiAgICAgICAgc2NyaXB0LFxuICAgICAgXSxcbiAgICAgIHtcbiAgICAgICAgY3dkOiBwYWNrYWdlUm9vdCxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgLi4ucHJvY2Vzcy5lbnYsXG4gICAgICAgICAgW1NLSUxMX0hFQUxUSF9NT0RVTEVfRU5WXTogc2tpbGxIZWFsdGhNb2R1bGVQYXRoLFxuICAgICAgICAgIEdTRF9TS0lMTF9IRUFMVEhfQkFTRTogcHJvamVjdEN3ZCxcbiAgICAgICAgfSxcbiAgICAgICAgbWF4QnVmZmVyOiBTS0lMTF9IRUFMVEhfTUFYX0JVRkZFUixcbiAgICAgICAgd2luZG93c0hpZGU6IHRydWUsXG4gICAgICB9LFxuICAgICAgKGVycm9yLCBzdGRvdXQsIHN0ZGVycikgPT4ge1xuICAgICAgICBpZiAoZXJyb3IpIHtcbiAgICAgICAgICByZWplY3QobmV3IEVycm9yKGBza2lsbC1oZWFsdGggc3VicHJvY2VzcyBmYWlsZWQ6ICR7c3RkZXJyIHx8IGVycm9yLm1lc3NhZ2V9YCkpXG4gICAgICAgICAgcmV0dXJuXG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlc29sdmVSZXN1bHQoSlNPTi5wYXJzZShzdGRvdXQpIGFzIFNraWxsSGVhbHRoUmVwb3J0KVxuICAgICAgICB9IGNhdGNoIChwYXJzZUVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KFxuICAgICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgICBgc2tpbGwtaGVhbHRoIHN1YnByb2Nlc3MgcmV0dXJuZWQgaW52YWxpZCBKU09OOiAke3BhcnNlRXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IHBhcnNlRXJyb3IubWVzc2FnZSA6IFN0cmluZyhwYXJzZUVycm9yKX1gLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgKVxuICB9KVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxZQUFZO0FBQ3JCLFNBQVMscUJBQXFCO0FBRTlCLFNBQVMsa0NBQWtDO0FBQzNDLFNBQW1DLHlCQUF5QixpQ0FBaUM7QUFHN0YsTUFBTSwwQkFBMEIsSUFBSSxPQUFPO0FBQzNDLE1BQU0sMEJBQTBCO0FBRWhDLFNBQVMsb0JBQW9CLGFBQTZCO0FBQ3hELFNBQU8sS0FBSyxhQUFhLE9BQU8sYUFBYSxjQUFjLE9BQU8sU0FBUyxnQkFBZ0I7QUFDN0Y7QUFNQSxlQUFzQix1QkFBdUIsb0JBQXlEO0FBQ3BHLFFBQU0sU0FBUywyQkFBMkIsUUFBVyxrQkFBa0I7QUFDdkUsUUFBTSxFQUFFLGFBQWEsV0FBVyxJQUFJO0FBRXBDLFFBQU0sa0JBQWtCLG9CQUFvQixXQUFXO0FBQ3ZELFFBQU0sbUJBQW1CLHdCQUF3QixhQUFhLDBDQUEwQztBQUN4RyxRQUFNLHdCQUF3QixpQkFBaUI7QUFFL0MsTUFBSSxDQUFDLGlCQUFpQixrQkFBa0IsQ0FBQyxXQUFXLGVBQWUsS0FBSyxDQUFDLFdBQVcscUJBQXFCLElBQUk7QUFDM0csVUFBTSxJQUFJO0FBQUEsTUFDUixpREFBaUQsZUFBZSxJQUFJLHFCQUFxQjtBQUFBLElBQzNGO0FBQUEsRUFDRjtBQUNBLE1BQUksaUJBQWlCLGlCQUFpQixDQUFDLFdBQVcscUJBQXFCLEdBQUc7QUFDeEUsVUFBTSxJQUFJLE1BQU0saURBQWlELHFCQUFxQixFQUFFO0FBQUEsRUFDMUY7QUFFQSxRQUFNLFNBQVM7QUFBQSxJQUNiO0FBQUEsSUFDQSxzREFBc0QsdUJBQXVCO0FBQUEsSUFDN0U7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0YsRUFBRSxLQUFLLEdBQUc7QUFFVixRQUFNLGFBQWEsMEJBQTBCLGFBQWEsa0JBQWtCLGNBQWMsZUFBZSxFQUFFLElBQUk7QUFFL0csU0FBTyxNQUFNLElBQUksUUFBMkIsQ0FBQyxlQUFlLFdBQVc7QUFDckU7QUFBQSxNQUNFLFFBQVE7QUFBQSxNQUNSO0FBQUEsUUFDRSxHQUFHO0FBQUEsUUFDSDtBQUFBLFFBQ0E7QUFBQSxNQUNGO0FBQUEsTUFDQTtBQUFBLFFBQ0UsS0FBSztBQUFBLFFBQ0wsS0FBSztBQUFBLFVBQ0gsR0FBRyxRQUFRO0FBQUEsVUFDWCxDQUFDLHVCQUF1QixHQUFHO0FBQUEsVUFDM0IsdUJBQXVCO0FBQUEsUUFDekI7QUFBQSxRQUNBLFdBQVc7QUFBQSxRQUNYLGFBQWE7QUFBQSxNQUNmO0FBQUEsTUFDQSxDQUFDLE9BQU8sUUFBUSxXQUFXO0FBQ3pCLFlBQUksT0FBTztBQUNULGlCQUFPLElBQUksTUFBTSxtQ0FBbUMsVUFBVSxNQUFNLE9BQU8sRUFBRSxDQUFDO0FBQzlFO0FBQUEsUUFDRjtBQUVBLFlBQUk7QUFDRix3QkFBYyxLQUFLLE1BQU0sTUFBTSxDQUFzQjtBQUFBLFFBQ3ZELFNBQVMsWUFBWTtBQUNuQjtBQUFBLFlBQ0UsSUFBSTtBQUFBLGNBQ0Ysa0RBQWtELHNCQUFzQixRQUFRLFdBQVcsVUFBVSxPQUFPLFVBQVUsQ0FBQztBQUFBLFlBQ3pIO0FBQUEsVUFDRjtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUNIOyIsCiAgIm5hbWVzIjogW10KfQo=
