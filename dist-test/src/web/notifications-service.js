import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBridgeRuntimeConfig } from "./bridge-service.js";
import { resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.js";
const NOTIFICATIONS_MAX_BUFFER = 2 * 1024 * 1024;
const NOTIFICATIONS_MODULE_ENV = "GSD_NOTIFICATIONS_MODULE";
function resolveTsLoaderPath(packageRoot) {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
}
async function collectNotificationsData(projectCwdOverride) {
  const config = resolveBridgeRuntimeConfig(void 0, projectCwdOverride);
  const { packageRoot, projectCwd } = config;
  const resolveTsLoader = resolveTsLoaderPath(packageRoot);
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/notification-store.ts");
  const modulePath = moduleResolution.modulePath;
  if (!moduleResolution.useCompiledJs && (!existsSync(resolveTsLoader) || !existsSync(modulePath))) {
    throw new Error(
      `notifications data provider not found; checked=${resolveTsLoader},${modulePath}`
    );
  }
  if (moduleResolution.useCompiledJs && !existsSync(modulePath)) {
    throw new Error(`notifications data provider not found; checked=${modulePath}`);
  }
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${NOTIFICATIONS_MODULE_ENV}).href);`,
    "const basePath = process.env.GSD_NOTIFICATIONS_BASE;",
    "const entries = mod.readNotifications(basePath);",
    "const unread = entries.filter(e => !e.read).length;",
    "const result = { entries, unreadCount: unread, totalCount: entries.length };",
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
          [NOTIFICATIONS_MODULE_ENV]: modulePath,
          GSD_NOTIFICATIONS_BASE: projectCwd
        },
        maxBuffer: NOTIFICATIONS_MAX_BUFFER,
        timeout: 1e4
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`notifications subprocess failed: ${err.message}${stderr ? `
stderr: ${stderr}` : ""}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolveResult(parsed);
        } catch (parseErr) {
          reject(new Error(`Failed to parse notifications output: ${parseErr.message}`));
        }
      }
    );
  });
}
async function clearNotificationsData(projectCwdOverride) {
  const config = resolveBridgeRuntimeConfig(void 0, projectCwdOverride);
  const { packageRoot, projectCwd } = config;
  const resolveTsLoader = resolveTsLoaderPath(packageRoot);
  const moduleResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/notification-store.ts");
  const modulePath = moduleResolution.modulePath;
  if (moduleResolution.useCompiledJs && !existsSync(modulePath)) {
    throw new Error(`notifications data provider not found; checked=${modulePath}`);
  }
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    `const mod = await import(pathToFileURL(process.env.${NOTIFICATIONS_MODULE_ENV}).href);`,
    "mod.clearNotifications(process.env.GSD_NOTIFICATIONS_BASE);",
    'process.stdout.write("ok");'
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
          [NOTIFICATIONS_MODULE_ENV]: modulePath,
          GSD_NOTIFICATIONS_BASE: projectCwd
        },
        maxBuffer: NOTIFICATIONS_MAX_BUFFER,
        timeout: 1e4
      },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`clear notifications subprocess failed: ${err.message}${stderr ? `
stderr: ${stderr}` : ""}`));
          return;
        }
        resolveResult();
      }
    );
  });
}
export {
  clearNotificationsData,
  collectNotificationsData
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3dlYi9ub3RpZmljYXRpb25zLXNlcnZpY2UudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRCBXZWIgXHUyMDE0IE5vdGlmaWNhdGlvbnMgU2VydmljZVxuLy8gTG9hZHMgbm90aWZpY2F0aW9uIGRhdGEgdmlhIGEgY2hpbGQgcHJvY2VzcyB0aGF0IGltcG9ydHMgdGhlIG5vdGlmaWNhdGlvbiBzdG9yZS5cblxuaW1wb3J0IHsgZXhlY0ZpbGUgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCJcbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiXG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiXG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCJcblxuaW1wb3J0IHsgcmVzb2x2ZUJyaWRnZVJ1bnRpbWVDb25maWcgfSBmcm9tIFwiLi9icmlkZ2Utc2VydmljZS50c1wiXG5pbXBvcnQgeyByZXNvbHZlVHlwZVN0cmlwcGluZ0ZsYWcsIHJlc29sdmVTdWJwcm9jZXNzTW9kdWxlLCBidWlsZFN1YnByb2Nlc3NQcmVmaXhBcmdzIH0gZnJvbSBcIi4vdHMtc3VicHJvY2Vzcy1mbGFncy50c1wiXG5cbmV4cG9ydCBpbnRlcmZhY2UgTm90aWZpY2F0aW9uc0RhdGEge1xuICBlbnRyaWVzOiBBcnJheTx7XG4gICAgaWQ6IHN0cmluZ1xuICAgIHRzOiBzdHJpbmdcbiAgICBzZXZlcml0eTogc3RyaW5nXG4gICAgbWVzc2FnZTogc3RyaW5nXG4gICAgc291cmNlOiBzdHJpbmdcbiAgICByZWFkOiBib29sZWFuXG4gIH0+XG4gIHVucmVhZENvdW50OiBudW1iZXJcbiAgdG90YWxDb3VudDogbnVtYmVyXG59XG5cbmNvbnN0IE5PVElGSUNBVElPTlNfTUFYX0JVRkZFUiA9IDIgKiAxMDI0ICogMTAyNFxuY29uc3QgTk9USUZJQ0FUSU9OU19NT0RVTEVfRU5WID0gXCJHU0RfTk9USUZJQ0FUSU9OU19NT0RVTEVcIlxuXG5mdW5jdGlvbiByZXNvbHZlVHNMb2FkZXJQYXRoKHBhY2thZ2VSb290OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihwYWNrYWdlUm9vdCwgXCJzcmNcIiwgXCJyZXNvdXJjZXNcIiwgXCJleHRlbnNpb25zXCIsIFwiZ3NkXCIsIFwidGVzdHNcIiwgXCJyZXNvbHZlLXRzLm1qc1wiKVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY29sbGVjdE5vdGlmaWNhdGlvbnNEYXRhKHByb2plY3RDd2RPdmVycmlkZT86IHN0cmluZyk6IFByb21pc2U8Tm90aWZpY2F0aW9uc0RhdGE+IHtcbiAgY29uc3QgY29uZmlnID0gcmVzb2x2ZUJyaWRnZVJ1bnRpbWVDb25maWcodW5kZWZpbmVkLCBwcm9qZWN0Q3dkT3ZlcnJpZGUpXG4gIGNvbnN0IHsgcGFja2FnZVJvb3QsIHByb2plY3RDd2QgfSA9IGNvbmZpZ1xuXG4gIGNvbnN0IHJlc29sdmVUc0xvYWRlciA9IHJlc29sdmVUc0xvYWRlclBhdGgocGFja2FnZVJvb3QpXG4gIGNvbnN0IG1vZHVsZVJlc29sdXRpb24gPSByZXNvbHZlU3VicHJvY2Vzc01vZHVsZShwYWNrYWdlUm9vdCwgXCJyZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2Qvbm90aWZpY2F0aW9uLXN0b3JlLnRzXCIpXG4gIGNvbnN0IG1vZHVsZVBhdGggPSBtb2R1bGVSZXNvbHV0aW9uLm1vZHVsZVBhdGhcblxuICBpZiAoIW1vZHVsZVJlc29sdXRpb24udXNlQ29tcGlsZWRKcyAmJiAoIWV4aXN0c1N5bmMocmVzb2x2ZVRzTG9hZGVyKSB8fCAhZXhpc3RzU3luYyhtb2R1bGVQYXRoKSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgbm90aWZpY2F0aW9ucyBkYXRhIHByb3ZpZGVyIG5vdCBmb3VuZDsgY2hlY2tlZD0ke3Jlc29sdmVUc0xvYWRlcn0sJHttb2R1bGVQYXRofWAsXG4gICAgKVxuICB9XG4gIGlmIChtb2R1bGVSZXNvbHV0aW9uLnVzZUNvbXBpbGVkSnMgJiYgIWV4aXN0c1N5bmMobW9kdWxlUGF0aCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYG5vdGlmaWNhdGlvbnMgZGF0YSBwcm92aWRlciBub3QgZm91bmQ7IGNoZWNrZWQ9JHttb2R1bGVQYXRofWApXG4gIH1cblxuICBjb25zdCBzY3JpcHQgPSBbXG4gICAgJ2NvbnN0IHsgcGF0aFRvRmlsZVVSTCB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTp1cmxcIik7JyxcbiAgICBgY29uc3QgbW9kID0gYXdhaXQgaW1wb3J0KHBhdGhUb0ZpbGVVUkwocHJvY2Vzcy5lbnYuJHtOT1RJRklDQVRJT05TX01PRFVMRV9FTlZ9KS5ocmVmKTtgLFxuICAgICdjb25zdCBiYXNlUGF0aCA9IHByb2Nlc3MuZW52LkdTRF9OT1RJRklDQVRJT05TX0JBU0U7JyxcbiAgICAnY29uc3QgZW50cmllcyA9IG1vZC5yZWFkTm90aWZpY2F0aW9ucyhiYXNlUGF0aCk7JyxcbiAgICAnY29uc3QgdW5yZWFkID0gZW50cmllcy5maWx0ZXIoZSA9PiAhZS5yZWFkKS5sZW5ndGg7JyxcbiAgICAnY29uc3QgcmVzdWx0ID0geyBlbnRyaWVzLCB1bnJlYWRDb3VudDogdW5yZWFkLCB0b3RhbENvdW50OiBlbnRyaWVzLmxlbmd0aCB9OycsXG4gICAgJ3Byb2Nlc3Muc3Rkb3V0LndyaXRlKEpTT04uc3RyaW5naWZ5KHJlc3VsdCkpOycsXG4gIF0uam9pbihcIiBcIilcblxuICBjb25zdCBwcmVmaXhBcmdzID0gYnVpbGRTdWJwcm9jZXNzUHJlZml4QXJncyhwYWNrYWdlUm9vdCwgbW9kdWxlUmVzb2x1dGlvbiwgcGF0aFRvRmlsZVVSTChyZXNvbHZlVHNMb2FkZXIpLmhyZWYpXG5cbiAgcmV0dXJuIGF3YWl0IG5ldyBQcm9taXNlPE5vdGlmaWNhdGlvbnNEYXRhPigocmVzb2x2ZVJlc3VsdCwgcmVqZWN0KSA9PiB7XG4gICAgZXhlY0ZpbGUoXG4gICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgW1xuICAgICAgICAuLi5wcmVmaXhBcmdzLFxuICAgICAgICBcIi0tZXZhbFwiLFxuICAgICAgICBzY3JpcHQsXG4gICAgICBdLFxuICAgICAge1xuICAgICAgICBjd2Q6IHBhY2thZ2VSb290LFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgICBbTk9USUZJQ0FUSU9OU19NT0RVTEVfRU5WXTogbW9kdWxlUGF0aCxcbiAgICAgICAgICBHU0RfTk9USUZJQ0FUSU9OU19CQVNFOiBwcm9qZWN0Q3dkLFxuICAgICAgICB9LFxuICAgICAgICBtYXhCdWZmZXI6IE5PVElGSUNBVElPTlNfTUFYX0JVRkZFUixcbiAgICAgICAgdGltZW91dDogMTBfMDAwLFxuICAgICAgfSxcbiAgICAgIChlcnIsIHN0ZG91dCwgc3RkZXJyKSA9PiB7XG4gICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICByZWplY3QobmV3IEVycm9yKGBub3RpZmljYXRpb25zIHN1YnByb2Nlc3MgZmFpbGVkOiAke2Vyci5tZXNzYWdlfSR7c3RkZXJyID8gYFxcbnN0ZGVycjogJHtzdGRlcnJ9YCA6IFwiXCJ9YCkpXG4gICAgICAgICAgcmV0dXJuXG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHN0ZG91dCkgYXMgTm90aWZpY2F0aW9uc0RhdGFcbiAgICAgICAgICByZXNvbHZlUmVzdWx0KHBhcnNlZClcbiAgICAgICAgfSBjYXRjaCAocGFyc2VFcnIpIHtcbiAgICAgICAgICByZWplY3QobmV3IEVycm9yKGBGYWlsZWQgdG8gcGFyc2Ugbm90aWZpY2F0aW9ucyBvdXRwdXQ6ICR7KHBhcnNlRXJyIGFzIEVycm9yKS5tZXNzYWdlfWApKVxuICAgICAgICB9XG4gICAgICB9LFxuICAgIClcbiAgfSlcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFyTm90aWZpY2F0aW9uc0RhdGEocHJvamVjdEN3ZE92ZXJyaWRlPzogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnKHVuZGVmaW5lZCwgcHJvamVjdEN3ZE92ZXJyaWRlKVxuICBjb25zdCB7IHBhY2thZ2VSb290LCBwcm9qZWN0Q3dkIH0gPSBjb25maWdcblxuICBjb25zdCByZXNvbHZlVHNMb2FkZXIgPSByZXNvbHZlVHNMb2FkZXJQYXRoKHBhY2thZ2VSb290KVxuICBjb25zdCBtb2R1bGVSZXNvbHV0aW9uID0gcmVzb2x2ZVN1YnByb2Nlc3NNb2R1bGUocGFja2FnZVJvb3QsIFwicmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL25vdGlmaWNhdGlvbi1zdG9yZS50c1wiKVxuICBjb25zdCBtb2R1bGVQYXRoID0gbW9kdWxlUmVzb2x1dGlvbi5tb2R1bGVQYXRoXG5cbiAgaWYgKG1vZHVsZVJlc29sdXRpb24udXNlQ29tcGlsZWRKcyAmJiAhZXhpc3RzU3luYyhtb2R1bGVQYXRoKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgbm90aWZpY2F0aW9ucyBkYXRhIHByb3ZpZGVyIG5vdCBmb3VuZDsgY2hlY2tlZD0ke21vZHVsZVBhdGh9YClcbiAgfVxuXG4gIGNvbnN0IHNjcmlwdCA9IFtcbiAgICAnY29uc3QgeyBwYXRoVG9GaWxlVVJMIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOnVybFwiKTsnLFxuICAgIGBjb25zdCBtb2QgPSBhd2FpdCBpbXBvcnQocGF0aFRvRmlsZVVSTChwcm9jZXNzLmVudi4ke05PVElGSUNBVElPTlNfTU9EVUxFX0VOVn0pLmhyZWYpO2AsXG4gICAgJ21vZC5jbGVhck5vdGlmaWNhdGlvbnMocHJvY2Vzcy5lbnYuR1NEX05PVElGSUNBVElPTlNfQkFTRSk7JyxcbiAgICAncHJvY2Vzcy5zdGRvdXQud3JpdGUoXCJva1wiKTsnLFxuICBdLmpvaW4oXCIgXCIpXG5cbiAgY29uc3QgcHJlZml4QXJncyA9IGJ1aWxkU3VicHJvY2Vzc1ByZWZpeEFyZ3MocGFja2FnZVJvb3QsIG1vZHVsZVJlc29sdXRpb24sIHBhdGhUb0ZpbGVVUkwocmVzb2x2ZVRzTG9hZGVyKS5ocmVmKVxuXG4gIHJldHVybiBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZVJlc3VsdCwgcmVqZWN0KSA9PiB7XG4gICAgZXhlY0ZpbGUoXG4gICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgW1xuICAgICAgICAuLi5wcmVmaXhBcmdzLFxuICAgICAgICBcIi0tZXZhbFwiLFxuICAgICAgICBzY3JpcHQsXG4gICAgICBdLFxuICAgICAge1xuICAgICAgICBjd2Q6IHBhY2thZ2VSb290LFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgICBbTk9USUZJQ0FUSU9OU19NT0RVTEVfRU5WXTogbW9kdWxlUGF0aCxcbiAgICAgICAgICBHU0RfTk9USUZJQ0FUSU9OU19CQVNFOiBwcm9qZWN0Q3dkLFxuICAgICAgICB9LFxuICAgICAgICBtYXhCdWZmZXI6IE5PVElGSUNBVElPTlNfTUFYX0JVRkZFUixcbiAgICAgICAgdGltZW91dDogMTBfMDAwLFxuICAgICAgfSxcbiAgICAgIChlcnIsIF9zdGRvdXQsIHN0ZGVycikgPT4ge1xuICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgY2xlYXIgbm90aWZpY2F0aW9ucyBzdWJwcm9jZXNzIGZhaWxlZDogJHtlcnIubWVzc2FnZX0ke3N0ZGVyciA/IGBcXG5zdGRlcnI6ICR7c3RkZXJyfWAgOiBcIlwifWApKVxuICAgICAgICAgIHJldHVyblxuICAgICAgICB9XG4gICAgICAgIHJlc29sdmVSZXN1bHQoKVxuICAgICAgfSxcbiAgICApXG4gIH0pXG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxTQUFTLGdCQUFnQjtBQUN6QixTQUFTLGtCQUFrQjtBQUMzQixTQUFTLFlBQVk7QUFDckIsU0FBUyxxQkFBcUI7QUFFOUIsU0FBUyxrQ0FBa0M7QUFDM0MsU0FB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
