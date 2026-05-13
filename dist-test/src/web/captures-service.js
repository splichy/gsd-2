import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBridgeRuntimeConfig } from "./bridge-service.js";
import { resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.js";
const CAPTURES_MAX_BUFFER = 2 * 1024 * 1024;
const CAPTURES_MODULE_ENV = "GSD_CAPTURES_MODULE";
function resolveTsLoaderPath(packageRoot) {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
}
async function collectCapturesData(projectCwdOverride) {
  const config = resolveBridgeRuntimeConfig(void 0, projectCwdOverride);
  const { packageRoot, projectCwd } = config;
  const resolveTsLoader = resolveTsLoaderPath(packageRoot);
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/captures.ts");
  const capturesModulePath = moduleResolution.modulePath;
  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(capturesModulePath))) {
    throw new Error(
      `captures data provider not found; checked=${resolveTsLoader},${capturesModulePath}`
    );
  }
  if (moduleResolution.useCompiledJs && !existsSync(capturesModulePath)) {
    throw new Error(`captures data provider not found; checked=${capturesModulePath}`);
  }
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${CAPTURES_MODULE_ENV}).href);`,
    `const all = mod.loadAllCaptures(process.env.GSD_CAPTURES_BASE);`,
    'const pending = all.filter(c => c.status === "pending");',
    `const actionable = mod.loadActionableCaptures(process.env.GSD_CAPTURES_BASE);`,
    "const result = { entries: all, pendingCount: pending.length, actionableCount: actionable.length };",
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
          [CAPTURES_MODULE_ENV]: capturesModulePath,
          GSD_CAPTURES_BASE: projectCwd
        },
        maxBuffer: CAPTURES_MAX_BUFFER,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`captures data subprocess failed: ${stderr || error.message}`));
          return;
        }
        try {
          resolveResult(JSON.parse(stdout));
        } catch (parseError) {
          reject(
            new Error(
              `captures data subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            )
          );
        }
      }
    );
  });
}
async function resolveCaptureAction(request, projectCwdOverride) {
  const config = resolveBridgeRuntimeConfig(void 0, projectCwdOverride);
  const { packageRoot, projectCwd } = config;
  const resolveTsLoader = resolveTsLoaderPath(packageRoot);
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/captures.ts");
  const capturesModulePath = moduleResolution.modulePath;
  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(capturesModulePath))) {
    throw new Error(
      `captures data provider not found; checked=${resolveTsLoader},${capturesModulePath}`
    );
  }
  if (moduleResolution.useCompiledJs && !existsSync(capturesModulePath)) {
    throw new Error(`captures data provider not found; checked=${capturesModulePath}`);
  }
  const safeId = JSON.stringify(request.captureId);
  const safeClassification = JSON.stringify(request.classification);
  const safeResolution = JSON.stringify(request.resolution);
  const safeRationale = JSON.stringify(request.rationale);
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${CAPTURES_MODULE_ENV}).href);`,
    `mod.markCaptureResolved(process.env.GSD_CAPTURES_BASE, ${safeId}, ${safeClassification}, ${safeResolution}, ${safeRationale});`,
    `process.stdout.write(JSON.stringify({ ok: true, captureId: ${safeId} }));`
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
          [CAPTURES_MODULE_ENV]: capturesModulePath,
          GSD_CAPTURES_BASE: projectCwd
        },
        maxBuffer: CAPTURES_MAX_BUFFER,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`capture resolve subprocess failed: ${stderr || error.message}`));
          return;
        }
        try {
          resolveResult(JSON.parse(stdout));
        } catch (parseError) {
          reject(
            new Error(
              `capture resolve subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            )
          );
        }
      }
    );
  });
}
export {
  collectCapturesData,
  resolveCaptureAction
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3dlYi9jYXB0dXJlcy1zZXJ2aWNlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBleGVjRmlsZSB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIlxuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCJcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCJcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tIFwibm9kZTp1cmxcIlxuXG5pbXBvcnQgeyByZXNvbHZlQnJpZGdlUnVudGltZUNvbmZpZyB9IGZyb20gXCIuL2JyaWRnZS1zZXJ2aWNlLnRzXCJcbmltcG9ydCB7IHJlc29sdmVUeXBlU3RyaXBwaW5nRmxhZywgcmVzb2x2ZVN1YnByb2Nlc3NNb2R1bGUsIGJ1aWxkU3VicHJvY2Vzc1ByZWZpeEFyZ3MgfSBmcm9tIFwiLi90cy1zdWJwcm9jZXNzLWZsYWdzLnRzXCJcbmltcG9ydCB0eXBlIHsgQ2FwdHVyZXNEYXRhLCBDYXB0dXJlUmVzb2x2ZVJlcXVlc3QsIENhcHR1cmVSZXNvbHZlUmVzdWx0IH0gZnJvbSBcIi4uLy4uL3dlYi9saWIva25vd2xlZGdlLWNhcHR1cmVzLXR5cGVzLnRzXCJcblxuY29uc3QgQ0FQVFVSRVNfTUFYX0JVRkZFUiA9IDIgKiAxMDI0ICogMTAyNFxuY29uc3QgQ0FQVFVSRVNfTU9EVUxFX0VOViA9IFwiR1NEX0NBUFRVUkVTX01PRFVMRVwiXG5cbmZ1bmN0aW9uIHJlc29sdmVUc0xvYWRlclBhdGgocGFja2FnZVJvb3Q6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKHBhY2thZ2VSb290LCBcInNyY1wiLCBcInJlc291cmNlc1wiLCBcImV4dGVuc2lvbnNcIiwgXCJnc2RcIiwgXCJ0ZXN0c1wiLCBcInJlc29sdmUtdHMubWpzXCIpXG59XG5cbi8qKlxuICogTG9hZHMgYWxsIGNhcHR1cmUgZW50cmllcyB2aWEgYSBjaGlsZCBwcm9jZXNzLiBUaGUgY2hpbGQgaW1wb3J0cyB0aGUgdXBzdHJlYW1cbiAqIGNhcHR1cmVzIG1vZHVsZSwgY2FsbHMgbG9hZEFsbENhcHR1cmVzKCkgYW5kIGxvYWRBY3Rpb25hYmxlQ2FwdHVyZXMoKSwgYW5kXG4gKiB3cml0ZXMgYSBDYXB0dXJlc0RhdGEgSlNPTiB0byBzdGRvdXQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb2xsZWN0Q2FwdHVyZXNEYXRhKHByb2plY3RDd2RPdmVycmlkZT86IHN0cmluZyk6IFByb21pc2U8Q2FwdHVyZXNEYXRhPiB7XG4gIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnKHVuZGVmaW5lZCwgcHJvamVjdEN3ZE92ZXJyaWRlKVxuICBjb25zdCB7IHBhY2thZ2VSb290LCBwcm9qZWN0Q3dkIH0gPSBjb25maWdcblxuICBjb25zdCByZXNvbHZlVHNMb2FkZXIgPSByZXNvbHZlVHNMb2FkZXJQYXRoKHBhY2thZ2VSb290KVxuICBjb25zdCBtb2R1bGVSZXNvbHV0aW9uID0gcmVzb2x2ZVN1YnByb2Nlc3NNb2R1bGUocGFja2FnZVJvb3QsIFwicmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2NhcHR1cmVzLnRzXCIpXG4gIGNvbnN0IGNhcHR1cmVzTW9kdWxlUGF0aCA9IG1vZHVsZVJlc29sdXRpb24ubW9kdWxlUGF0aFxuXG4gIGlmICghbW9kdWxlUmVzb2x1dGlvbi51c2VDb21waWxlZEpzICYmICghZXhpc3RzU3luYyhyZXNvbHZlVHNMb2FkZXIpIHx8ICFleGlzdHNTeW5jKGNhcHR1cmVzTW9kdWxlUGF0aCkpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGNhcHR1cmVzIGRhdGEgcHJvdmlkZXIgbm90IGZvdW5kOyBjaGVja2VkPSR7cmVzb2x2ZVRzTG9hZGVyfSwke2NhcHR1cmVzTW9kdWxlUGF0aH1gLFxuICAgIClcbiAgfVxuICBpZiAobW9kdWxlUmVzb2x1dGlvbi51c2VDb21waWxlZEpzICYmICFleGlzdHNTeW5jKGNhcHR1cmVzTW9kdWxlUGF0aCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYGNhcHR1cmVzIGRhdGEgcHJvdmlkZXIgbm90IGZvdW5kOyBjaGVja2VkPSR7Y2FwdHVyZXNNb2R1bGVQYXRofWApXG4gIH1cblxuICBjb25zdCBzY3JpcHQgPSBbXG4gICAgJ2NvbnN0IHsgcGF0aFRvRmlsZVVSTCB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTp1cmxcIik7JyxcbiAgICBgY29uc3QgbW9kID0gYXdhaXQgaW1wb3J0KHBhdGhUb0ZpbGVVUkwocHJvY2Vzcy5lbnYuJHtDQVBUVVJFU19NT0RVTEVfRU5WfSkuaHJlZik7YCxcbiAgICBgY29uc3QgYWxsID0gbW9kLmxvYWRBbGxDYXB0dXJlcyhwcm9jZXNzLmVudi5HU0RfQ0FQVFVSRVNfQkFTRSk7YCxcbiAgICAnY29uc3QgcGVuZGluZyA9IGFsbC5maWx0ZXIoYyA9PiBjLnN0YXR1cyA9PT0gXCJwZW5kaW5nXCIpOycsXG4gICAgYGNvbnN0IGFjdGlvbmFibGUgPSBtb2QubG9hZEFjdGlvbmFibGVDYXB0dXJlcyhwcm9jZXNzLmVudi5HU0RfQ0FQVFVSRVNfQkFTRSk7YCxcbiAgICAnY29uc3QgcmVzdWx0ID0geyBlbnRyaWVzOiBhbGwsIHBlbmRpbmdDb3VudDogcGVuZGluZy5sZW5ndGgsIGFjdGlvbmFibGVDb3VudDogYWN0aW9uYWJsZS5sZW5ndGggfTsnLFxuICAgICdwcm9jZXNzLnN0ZG91dC53cml0ZShKU09OLnN0cmluZ2lmeShyZXN1bHQpKTsnLFxuICBdLmpvaW4oXCIgXCIpXG5cbiAgY29uc3QgcHJlZml4QXJncyA9IGJ1aWxkU3VicHJvY2Vzc1ByZWZpeEFyZ3MocGFja2FnZVJvb3QsIG1vZHVsZVJlc29sdXRpb24sIHBhdGhUb0ZpbGVVUkwocmVzb2x2ZVRzTG9hZGVyKS5ocmVmKVxuXG4gIHJldHVybiBhd2FpdCBuZXcgUHJvbWlzZTxDYXB0dXJlc0RhdGE+KChyZXNvbHZlUmVzdWx0LCByZWplY3QpID0+IHtcbiAgICBleGVjRmlsZShcbiAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICBbXG4gICAgICAgIC4uLnByZWZpeEFyZ3MsXG4gICAgICAgIFwiLS1ldmFsXCIsXG4gICAgICAgIHNjcmlwdCxcbiAgICAgIF0sXG4gICAgICB7XG4gICAgICAgIGN3ZDogcGFja2FnZVJvb3QsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICAgIFtDQVBUVVJFU19NT0RVTEVfRU5WXTogY2FwdHVyZXNNb2R1bGVQYXRoLFxuICAgICAgICAgIEdTRF9DQVBUVVJFU19CQVNFOiBwcm9qZWN0Q3dkLFxuICAgICAgICB9LFxuICAgICAgICBtYXhCdWZmZXI6IENBUFRVUkVTX01BWF9CVUZGRVIsXG4gICAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIChlcnJvciwgc3Rkb3V0LCBzdGRlcnIpID0+IHtcbiAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgY2FwdHVyZXMgZGF0YSBzdWJwcm9jZXNzIGZhaWxlZDogJHtzdGRlcnIgfHwgZXJyb3IubWVzc2FnZX1gKSlcbiAgICAgICAgICByZXR1cm5cbiAgICAgICAgfVxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVzb2x2ZVJlc3VsdChKU09OLnBhcnNlKHN0ZG91dCkgYXMgQ2FwdHVyZXNEYXRhKVxuICAgICAgICB9IGNhdGNoIChwYXJzZUVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KFxuICAgICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgICBgY2FwdHVyZXMgZGF0YSBzdWJwcm9jZXNzIHJldHVybmVkIGludmFsaWQgSlNPTjogJHtwYXJzZUVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBwYXJzZUVycm9yLm1lc3NhZ2UgOiBTdHJpbmcocGFyc2VFcnJvcil9YCxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICB9LFxuICAgIClcbiAgfSlcbn1cblxuLyoqXG4gKiBSZXNvbHZlcyAodHJpYWdlcykgYSBzaW5nbGUgY2FwdHVyZSBieSBjYWxsaW5nIG1hcmtDYXB0dXJlUmVzb2x2ZWQoKSBpbiBhXG4gKiBjaGlsZCBwcm9jZXNzLiBSZXR1cm5zIHsgb2s6IHRydWUsIGNhcHR1cmVJZCB9IG9uIHN1Y2Nlc3MuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXNvbHZlQ2FwdHVyZUFjdGlvbihyZXF1ZXN0OiBDYXB0dXJlUmVzb2x2ZVJlcXVlc3QsIHByb2plY3RDd2RPdmVycmlkZT86IHN0cmluZyk6IFByb21pc2U8Q2FwdHVyZVJlc29sdmVSZXN1bHQ+IHtcbiAgY29uc3QgY29uZmlnID0gcmVzb2x2ZUJyaWRnZVJ1bnRpbWVDb25maWcodW5kZWZpbmVkLCBwcm9qZWN0Q3dkT3ZlcnJpZGUpXG4gIGNvbnN0IHsgcGFja2FnZVJvb3QsIHByb2plY3RDd2QgfSA9IGNvbmZpZ1xuXG4gIGNvbnN0IHJlc29sdmVUc0xvYWRlciA9IHJlc29sdmVUc0xvYWRlclBhdGgocGFja2FnZVJvb3QpXG4gIGNvbnN0IG1vZHVsZVJlc29sdXRpb24gPSByZXNvbHZlU3VicHJvY2Vzc01vZHVsZShwYWNrYWdlUm9vdCwgXCJyZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvY2FwdHVyZXMudHNcIilcbiAgY29uc3QgY2FwdHVyZXNNb2R1bGVQYXRoID0gbW9kdWxlUmVzb2x1dGlvbi5tb2R1bGVQYXRoXG5cbiAgaWYgKCFtb2R1bGVSZXNvbHV0aW9uLnVzZUNvbXBpbGVkSnMgJiYgKCFleGlzdHNTeW5jKHJlc29sdmVUc0xvYWRlcikgfHwgIWV4aXN0c1N5bmMoY2FwdHVyZXNNb2R1bGVQYXRoKSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgY2FwdHVyZXMgZGF0YSBwcm92aWRlciBub3QgZm91bmQ7IGNoZWNrZWQ9JHtyZXNvbHZlVHNMb2FkZXJ9LCR7Y2FwdHVyZXNNb2R1bGVQYXRofWAsXG4gICAgKVxuICB9XG4gIGlmIChtb2R1bGVSZXNvbHV0aW9uLnVzZUNvbXBpbGVkSnMgJiYgIWV4aXN0c1N5bmMoY2FwdHVyZXNNb2R1bGVQYXRoKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgY2FwdHVyZXMgZGF0YSBwcm92aWRlciBub3QgZm91bmQ7IGNoZWNrZWQ9JHtjYXB0dXJlc01vZHVsZVBhdGh9YClcbiAgfVxuXG4gIGNvbnN0IHNhZmVJZCA9IEpTT04uc3RyaW5naWZ5KHJlcXVlc3QuY2FwdHVyZUlkKVxuICBjb25zdCBzYWZlQ2xhc3NpZmljYXRpb24gPSBKU09OLnN0cmluZ2lmeShyZXF1ZXN0LmNsYXNzaWZpY2F0aW9uKVxuICBjb25zdCBzYWZlUmVzb2x1dGlvbiA9IEpTT04uc3RyaW5naWZ5KHJlcXVlc3QucmVzb2x1dGlvbilcbiAgY29uc3Qgc2FmZVJhdGlvbmFsZSA9IEpTT04uc3RyaW5naWZ5KHJlcXVlc3QucmF0aW9uYWxlKVxuXG4gIGNvbnN0IHNjcmlwdCA9IFtcbiAgICAnY29uc3QgeyBwYXRoVG9GaWxlVVJMIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOnVybFwiKTsnLFxuICAgIGBjb25zdCBtb2QgPSBhd2FpdCBpbXBvcnQocGF0aFRvRmlsZVVSTChwcm9jZXNzLmVudi4ke0NBUFRVUkVTX01PRFVMRV9FTlZ9KS5ocmVmKTtgLFxuICAgIGBtb2QubWFya0NhcHR1cmVSZXNvbHZlZChwcm9jZXNzLmVudi5HU0RfQ0FQVFVSRVNfQkFTRSwgJHtzYWZlSWR9LCAke3NhZmVDbGFzc2lmaWNhdGlvbn0sICR7c2FmZVJlc29sdXRpb259LCAke3NhZmVSYXRpb25hbGV9KTtgLFxuICAgIGBwcm9jZXNzLnN0ZG91dC53cml0ZShKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBjYXB0dXJlSWQ6ICR7c2FmZUlkfSB9KSk7YCxcbiAgXS5qb2luKFwiIFwiKVxuXG4gIGNvbnN0IHByZWZpeEFyZ3MgPSBidWlsZFN1YnByb2Nlc3NQcmVmaXhBcmdzKHBhY2thZ2VSb290LCBtb2R1bGVSZXNvbHV0aW9uLCBwYXRoVG9GaWxlVVJMKHJlc29sdmVUc0xvYWRlcikuaHJlZilcblxuICByZXR1cm4gYXdhaXQgbmV3IFByb21pc2U8Q2FwdHVyZVJlc29sdmVSZXN1bHQ+KChyZXNvbHZlUmVzdWx0LCByZWplY3QpID0+IHtcbiAgICBleGVjRmlsZShcbiAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICBbXG4gICAgICAgIC4uLnByZWZpeEFyZ3MsXG4gICAgICAgIFwiLS1ldmFsXCIsXG4gICAgICAgIHNjcmlwdCxcbiAgICAgIF0sXG4gICAgICB7XG4gICAgICAgIGN3ZDogcGFja2FnZVJvb3QsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICAgIFtDQVBUVVJFU19NT0RVTEVfRU5WXTogY2FwdHVyZXNNb2R1bGVQYXRoLFxuICAgICAgICAgIEdTRF9DQVBUVVJFU19CQVNFOiBwcm9qZWN0Q3dkLFxuICAgICAgICB9LFxuICAgICAgICBtYXhCdWZmZXI6IENBUFRVUkVTX01BWF9CVUZGRVIsXG4gICAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIChlcnJvciwgc3Rkb3V0LCBzdGRlcnIpID0+IHtcbiAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgY2FwdHVyZSByZXNvbHZlIHN1YnByb2Nlc3MgZmFpbGVkOiAke3N0ZGVyciB8fCBlcnJvci5tZXNzYWdlfWApKVxuICAgICAgICAgIHJldHVyblxuICAgICAgICB9XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXNvbHZlUmVzdWx0KEpTT04ucGFyc2Uoc3Rkb3V0KSBhcyBDYXB0dXJlUmVzb2x2ZVJlc3VsdClcbiAgICAgICAgfSBjYXRjaCAocGFyc2VFcnJvcikge1xuICAgICAgICAgIHJlamVjdChcbiAgICAgICAgICAgIG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgYGNhcHR1cmUgcmVzb2x2ZSBzdWJwcm9jZXNzIHJldHVybmVkIGludmFsaWQgSlNPTjogJHtwYXJzZUVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBwYXJzZUVycm9yLm1lc3NhZ2UgOiBTdHJpbmcocGFyc2VFcnJvcil9YCxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICB9LFxuICAgIClcbiAgfSlcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsZ0JBQWdCO0FBQ3pCLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsWUFBWTtBQUNyQixTQUFTLHFCQUFxQjtBQUU5QixTQUFTLGtDQUFrQztBQUMzQyxTQUFtQyx5QkFBeUIsaUNBQWlDO0FBRzdGLE1BQU0sc0JBQXNCLElBQUksT0FBTztBQUN2QyxNQUFNLHNCQUFzQjtBQUU1QixTQUFTLG9CQUFvQixhQUE2QjtBQUN4RCxTQUFPLEtBQUssYUFBYSxPQUFPLGFBQWEsY0FBYyxPQUFPLFNBQVMsZ0JBQWdCO0FBQzdGO0FBT0EsZUFBc0Isb0JBQW9CLG9CQUFvRDtBQUM1RixRQUFNLFNBQVMsMkJBQTJCLFFBQVcsa0JBQWtCO0FBQ3ZFLFFBQU0sRUFBRSxhQUFhLFdBQVcsSUFBSTtBQUVwQyxRQUFNLGtCQUFrQixvQkFBb0IsV0FBVztBQUN2RCxRQUFNLG1CQUFtQix3QkFBd0IsYUFBYSxzQ0FBc0M7QUFDcEcsUUFBTSxxQkFBcUIsaUJBQWlCO0FBRTVDLE1BQUksQ0FBQyxpQkFBaUIsa0JBQWtCLENBQUMsV0FBVyxlQUFlLEtBQUssQ0FBQyxXQUFXLGtCQUFrQixJQUFJO0FBQ3hHLFVBQU0sSUFBSTtBQUFBLE1BQ1IsNkNBQTZDLGVBQWUsSUFBSSxrQkFBa0I7QUFBQSxJQUNwRjtBQUFBLEVBQ0Y7QUFDQSxNQUFJLGlCQUFpQixpQkFBaUIsQ0FBQyxXQUFXLGtCQUFrQixHQUFHO0FBQ3JFLFVBQU0sSUFBSSxNQUFNLDZDQUE2QyxrQkFBa0IsRUFBRTtBQUFBLEVBQ25GO0FBRUEsUUFBTSxTQUFTO0FBQUEsSUFDYjtBQUFBLElBQ0Esc0RBQXNELG1CQUFtQjtBQUFBLElBQ3pFO0FB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
