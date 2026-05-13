import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBridgeRuntimeConfig } from "./bridge-service.js";
import { resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.js";
const SETTINGS_MAX_BUFFER = 2 * 1024 * 1024;
function resolveTsLoaderPath(packageRoot) {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
}
async function collectSettingsData(projectCwdOverride) {
  const config = resolveBridgeRuntimeConfig(void 0, projectCwdOverride);
  const { packageRoot, projectCwd } = config;
  const resolveTsLoader = resolveTsLoaderPath(packageRoot);
  const prefsResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/preferences.ts");
  const routerResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/model-router.ts");
  const budgetResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/context-budget.ts");
  const historyResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/routing-history.ts");
  const metricsResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/metrics.ts");
  const prefsPath = prefsResolution.modulePath;
  const routerPath = routerResolution.modulePath;
  const budgetPath = budgetResolution.modulePath;
  const historyPath = historyResolution.modulePath;
  const metricsPath = metricsResolution.modulePath;
  const useCompiledJs = prefsResolution.useCompiledJs;
  if (!useCompiledJs) {
    const requiredPaths = [resolveTsLoader, prefsPath, routerPath, budgetPath, historyPath, metricsPath];
    for (const p of requiredPaths) {
      if (!existsSync(p)) {
        throw new Error(`settings data provider not found; missing=${p}`);
      }
    }
  } else {
    const requiredPaths = [prefsPath, routerPath, budgetPath, historyPath, metricsPath];
    for (const p of requiredPaths) {
      if (!existsSync(p)) {
        throw new Error(`settings data provider not found; missing=${p}`);
      }
    }
  }
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    "const prefsMod = await import(pathToFileURL(process.env.GSD_SETTINGS_PREFS_MODULE).href);",
    "const routerMod = await import(pathToFileURL(process.env.GSD_SETTINGS_ROUTER_MODULE).href);",
    "const budgetMod = await import(pathToFileURL(process.env.GSD_SETTINGS_BUDGET_MODULE).href);",
    "const historyMod = await import(pathToFileURL(process.env.GSD_SETTINGS_HISTORY_MODULE).href);",
    "const metricsMod = await import(pathToFileURL(process.env.GSD_SETTINGS_METRICS_MODULE).href);",
    // 1. Effective preferences (may be null if no preferences files exist)
    "const loaded = prefsMod.loadEffectiveGSDPreferences();",
    "let preferences = null;",
    "if (loaded) {",
    "  const p = loaded.preferences;",
    "  const models = {};",
    '  if (p.models && typeof p.models === "object") {',
    "    for (const [phase, value] of Object.entries(p.models)) {",
    '      if (typeof value === "string") {',
    "        models[phase] = value;",
    "        continue;",
    "      }",
    '      if (value && typeof value === "object" && typeof value.model === "string") {',
    '        models[phase] = typeof value.provider === "string" && value.provider && !value.model.includes("/")',
    "          ? `${value.provider}/${value.model}`",
    "          : value.model;",
    "      }",
    "    }",
    "  }",
    "  preferences = {",
    "    mode: p.mode,",
    "    models: Object.keys(models).length > 0 ? models : undefined,",
    "    budgetCeiling: p.budget_ceiling,",
    "    budgetEnforcement: p.budget_enforcement,",
    "    tokenProfile: p.token_profile,",
    "    dynamicRouting: p.dynamic_routing,",
    "    customInstructions: p.custom_instructions,",
    "    alwaysUseSkills: p.always_use_skills,",
    "    preferSkills: p.prefer_skills,",
    "    avoidSkills: p.avoid_skills,",
    "    autoSupervisor: p.auto_supervisor ? {",
    "      enabled: true,",
    "      softTimeoutMinutes: p.auto_supervisor.soft_timeout_minutes,",
    "    } : undefined,",
    "    uatDispatch: p.uat_dispatch,",
    "    autoVisualize: p.auto_visualize,",
    "    phases: p.phases,",
    "    contextSelection: p.context_selection,",
    "    reactiveExecution: p.reactive_execution,",
    "    gateEvaluation: p.gate_evaluation,",
    "    sliceParallel: p.slice_parallel,",
    "    serviceTier: p.service_tier,",
    "    showTokenCost: p.show_token_cost,",
    "    contextWindowOverride: p.context_window_override,",
    "    language: p.language,",
    "    remoteQuestions: p.remote_questions ? {",
    "      channel: p.remote_questions.channel,",
    "      channelId: String(p.remote_questions.channel_id),",
    "      timeoutMinutes: p.remote_questions.timeout_minutes,",
    "      pollIntervalSeconds: p.remote_questions.poll_interval_seconds,",
    "    } : undefined,",
    "    scope: loaded.scope,",
    "    path: loaded.path,",
    "    warnings: loaded.warnings,",
    "    experimental: p.experimental ? { rtk: p.experimental.rtk } : undefined,",
    "  };",
    "}",
    // 2. Resolved dynamic routing config (always returns a config with defaults)
    "const routingConfig = prefsMod.resolveDynamicRoutingConfig();",
    // 3. Budget allocation (use 200K as default context window)
    "const budgetAllocation = budgetMod.computeBudgets(200000);",
    // 4. Routing history (must init before reading)
    "historyMod.initRoutingHistory(process.env.GSD_SETTINGS_BASE);",
    "const routingHistory = historyMod.getRoutingHistory();",
    // 5. Project totals (null if no metrics ledger exists)
    "const ledger = metricsMod.loadLedgerFromDisk(process.env.GSD_SETTINGS_BASE);",
    "const projectTotals = ledger ? metricsMod.getProjectTotals(ledger.units) : null;",
    // Write combined payload
    "process.stdout.write(JSON.stringify({ preferences, routingConfig, budgetAllocation, routingHistory, projectTotals }));"
  ].join(" ");
  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, prefsResolution, pathToFileURL(resolveTsLoader).href);
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
          GSD_SETTINGS_PREFS_MODULE: prefsPath,
          GSD_SETTINGS_ROUTER_MODULE: routerPath,
          GSD_SETTINGS_BUDGET_MODULE: budgetPath,
          GSD_SETTINGS_HISTORY_MODULE: historyPath,
          GSD_SETTINGS_METRICS_MODULE: metricsPath,
          GSD_SETTINGS_BASE: projectCwd
        },
        maxBuffer: SETTINGS_MAX_BUFFER,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`settings data subprocess failed: ${stderr || error.message}`));
          return;
        }
        try {
          resolveResult(JSON.parse(stdout));
        } catch (parseError) {
          reject(
            new Error(
              `settings data subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            )
          );
        }
      }
    );
  });
}
export {
  collectSettingsData
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3dlYi9zZXR0aW5ncy1zZXJ2aWNlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBleGVjRmlsZSB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIlxuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCJcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCJcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tIFwibm9kZTp1cmxcIlxuXG5pbXBvcnQgeyByZXNvbHZlQnJpZGdlUnVudGltZUNvbmZpZyB9IGZyb20gXCIuL2JyaWRnZS1zZXJ2aWNlLnRzXCJcbmltcG9ydCB7IHJlc29sdmVUeXBlU3RyaXBwaW5nRmxhZywgcmVzb2x2ZVN1YnByb2Nlc3NNb2R1bGUsIGJ1aWxkU3VicHJvY2Vzc1ByZWZpeEFyZ3MgfSBmcm9tIFwiLi90cy1zdWJwcm9jZXNzLWZsYWdzLnRzXCJcbmltcG9ydCB0eXBlIHsgU2V0dGluZ3NEYXRhIH0gZnJvbSBcIi4uLy4uL3dlYi9saWIvc2V0dGluZ3MtdHlwZXMudHNcIlxuXG5jb25zdCBTRVRUSU5HU19NQVhfQlVGRkVSID0gMiAqIDEwMjQgKiAxMDI0XG5cbmZ1bmN0aW9uIHJlc29sdmVUc0xvYWRlclBhdGgocGFja2FnZVJvb3Q6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKHBhY2thZ2VSb290LCBcInNyY1wiLCBcInJlc291cmNlc1wiLCBcImV4dGVuc2lvbnNcIiwgXCJnc2RcIiwgXCJ0ZXN0c1wiLCBcInJlc29sdmUtdHMubWpzXCIpXG59XG5cbi8qKlxuICogTG9hZHMgc2V0dGluZ3MgZGF0YSB2aWEgYSBjaGlsZCBwcm9jZXNzLiBDYWxscyB1cHN0cmVhbSBleHRlbnNpb24gbW9kdWxlc1xuICogZm9yIHByZWZlcmVuY2VzLCByb3V0aW5nIGNvbmZpZywgYnVkZ2V0IGFsbG9jYXRpb24sIHJvdXRpbmcgaGlzdG9yeSwgYW5kXG4gKiBwcm9qZWN0IHRvdGFscywgdGhlbiBjb21iaW5lcyByZXN1bHRzIGludG8gYSBzaW5nbGUgU2V0dGluZ3NEYXRhIHBheWxvYWQuXG4gKlxuICogVXNlcyB0aGUgc2FtZSBjaGlsZC1wcm9jZXNzIHBhdHRlcm4gYXMgZm9yZW5zaWNzLXNlcnZpY2UudHMgXHUyMDE0IFR1cmJvcGFja1xuICogY2Fubm90IHJlc29sdmUgdGhlIC5qcyBleHRlbnNpb24gaW1wb3J0cyB0aGVzZSB1cHN0cmVhbSBtb2R1bGVzIHVzZSwgc29cbiAqIGV4ZWNGaWxlICsgcmVzb2x2ZS10cy5tanMgaXMgcmVxdWlyZWQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb2xsZWN0U2V0dGluZ3NEYXRhKHByb2plY3RDd2RPdmVycmlkZT86IHN0cmluZyk6IFByb21pc2U8U2V0dGluZ3NEYXRhPiB7XG4gIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnKHVuZGVmaW5lZCwgcHJvamVjdEN3ZE92ZXJyaWRlKVxuICBjb25zdCB7IHBhY2thZ2VSb290LCBwcm9qZWN0Q3dkIH0gPSBjb25maWdcblxuICBjb25zdCByZXNvbHZlVHNMb2FkZXIgPSByZXNvbHZlVHNMb2FkZXJQYXRoKHBhY2thZ2VSb290KVxuICBjb25zdCBwcmVmc1Jlc29sdXRpb24gPSByZXNvbHZlU3VicHJvY2Vzc01vZHVsZShwYWNrYWdlUm9vdCwgXCJyZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvcHJlZmVyZW5jZXMudHNcIilcbiAgY29uc3Qgcm91dGVyUmVzb2x1dGlvbiA9IHJlc29sdmVTdWJwcm9jZXNzTW9kdWxlKHBhY2thZ2VSb290LCBcInJlc291cmNlcy9leHRlbnNpb25zL2dzZC9tb2RlbC1yb3V0ZXIudHNcIilcbiAgY29uc3QgYnVkZ2V0UmVzb2x1dGlvbiA9IHJlc29sdmVTdWJwcm9jZXNzTW9kdWxlKHBhY2thZ2VSb290LCBcInJlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb250ZXh0LWJ1ZGdldC50c1wiKVxuICBjb25zdCBoaXN0b3J5UmVzb2x1dGlvbiA9IHJlc29sdmVTdWJwcm9jZXNzTW9kdWxlKHBhY2thZ2VSb290LCBcInJlc291cmNlcy9leHRlbnNpb25zL2dzZC9yb3V0aW5nLWhpc3RvcnkudHNcIilcbiAgY29uc3QgbWV0cmljc1Jlc29sdXRpb24gPSByZXNvbHZlU3VicHJvY2Vzc01vZHVsZShwYWNrYWdlUm9vdCwgXCJyZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvbWV0cmljcy50c1wiKVxuXG4gIGNvbnN0IHByZWZzUGF0aCA9IHByZWZzUmVzb2x1dGlvbi5tb2R1bGVQYXRoXG4gIGNvbnN0IHJvdXRlclBhdGggPSByb3V0ZXJSZXNvbHV0aW9uLm1vZHVsZVBhdGhcbiAgY29uc3QgYnVkZ2V0UGF0aCA9IGJ1ZGdldFJlc29sdXRpb24ubW9kdWxlUGF0aFxuICBjb25zdCBoaXN0b3J5UGF0aCA9IGhpc3RvcnlSZXNvbHV0aW9uLm1vZHVsZVBhdGhcbiAgY29uc3QgbWV0cmljc1BhdGggPSBtZXRyaWNzUmVzb2x1dGlvbi5tb2R1bGVQYXRoXG5cbiAgLy8gQWxsIG1vZHVsZXMgc2hhcmUgdGhlIHNhbWUgY29tcGlsZWQtdnMtc291cmNlIG1vZGUgKHRoZXkncmUgYWxsIGZyb20gdGhlIHNhbWUgcGFja2FnZSlcbiAgY29uc3QgdXNlQ29tcGlsZWRKcyA9IHByZWZzUmVzb2x1dGlvbi51c2VDb21waWxlZEpzXG5cbiAgaWYgKCF1c2VDb21waWxlZEpzKSB7XG4gICAgY29uc3QgcmVxdWlyZWRQYXRocyA9IFtyZXNvbHZlVHNMb2FkZXIsIHByZWZzUGF0aCwgcm91dGVyUGF0aCwgYnVkZ2V0UGF0aCwgaGlzdG9yeVBhdGgsIG1ldHJpY3NQYXRoXVxuICAgIGZvciAoY29uc3QgcCBvZiByZXF1aXJlZFBhdGhzKSB7XG4gICAgICBpZiAoIWV4aXN0c1N5bmMocCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBzZXR0aW5ncyBkYXRhIHByb3ZpZGVyIG5vdCBmb3VuZDsgbWlzc2luZz0ke3B9YClcbiAgICAgIH1cbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgY29uc3QgcmVxdWlyZWRQYXRocyA9IFtwcmVmc1BhdGgsIHJvdXRlclBhdGgsIGJ1ZGdldFBhdGgsIGhpc3RvcnlQYXRoLCBtZXRyaWNzUGF0aF1cbiAgICBmb3IgKGNvbnN0IHAgb2YgcmVxdWlyZWRQYXRocykge1xuICAgICAgaWYgKCFleGlzdHNTeW5jKHApKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgc2V0dGluZ3MgZGF0YSBwcm92aWRlciBub3QgZm91bmQ7IG1pc3Npbmc9JHtwfWApXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gVGhlIGNoaWxkIHNjcmlwdCBsb2FkcyBhbGwgdXBzdHJlYW0gbW9kdWxlcywgY2FsbHMgdGhlIDUgZGF0YSBmdW5jdGlvbnMsXG4gIC8vIGFuZCB3cml0ZXMgYSBjb21iaW5lZCBKU09OIHBheWxvYWQgdG8gc3Rkb3V0LlxuICBjb25zdCBzY3JpcHQgPSBbXG4gICAgJ2NvbnN0IHsgcGF0aFRvRmlsZVVSTCB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTp1cmxcIik7JyxcbiAgICAnY29uc3QgcHJlZnNNb2QgPSBhd2FpdCBpbXBvcnQocGF0aFRvRmlsZVVSTChwcm9jZXNzLmVudi5HU0RfU0VUVElOR1NfUFJFRlNfTU9EVUxFKS5ocmVmKTsnLFxuICAgICdjb25zdCByb3V0ZXJNb2QgPSBhd2FpdCBpbXBvcnQocGF0aFRvRmlsZVVSTChwcm9jZXNzLmVudi5HU0RfU0VUVElOR1NfUk9VVEVSX01PRFVMRSkuaHJlZik7JyxcbiAgICAnY29uc3QgYnVkZ2V0TW9kID0gYXdhaXQgaW1wb3J0KHBhdGhUb0ZpbGVVUkwocHJvY2Vzcy5lbnYuR1NEX1NFVFRJTkdTX0JVREdFVF9NT0RVTEUpLmhyZWYpOycsXG4gICAgJ2NvbnN0IGhpc3RvcnlNb2QgPSBhd2FpdCBpbXBvcnQocGF0aFRvRmlsZVVSTChwcm9jZXNzLmVudi5HU0RfU0VUVElOR1NfSElTVE9SWV9NT0RVTEUpLmhyZWYpOycsXG4gICAgJ2NvbnN0IG1ldHJpY3NNb2QgPSBhd2FpdCBpbXBvcnQocGF0aFRvRmlsZVVSTChwcm9jZXNzLmVudi5HU0RfU0VUVElOR1NfTUVUUklDU19NT0RVTEUpLmhyZWYpOycsXG5cbiAgICAvLyAxLiBFZmZlY3RpdmUgcHJlZmVyZW5jZXMgKG1heSBiZSBudWxsIGlmIG5vIHByZWZlcmVuY2VzIGZpbGVzIGV4aXN0KVxuICAgICdjb25zdCBsb2FkZWQgPSBwcmVmc01vZC5sb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKTsnLFxuICAgICdsZXQgcHJlZmVyZW5jZXMgPSBudWxsOycsXG4gICAgJ2lmIChsb2FkZWQpIHsnLFxuICAgICcgIGNvbnN0IHAgPSBsb2FkZWQucHJlZmVyZW5jZXM7JyxcbiAgICAnICBjb25zdCBtb2RlbHMgPSB7fTsnLFxuICAgICcgIGlmIChwLm1vZGVscyAmJiB0eXBlb2YgcC5tb2RlbHMgPT09IFwib2JqZWN0XCIpIHsnLFxuICAgICcgICAgZm9yIChjb25zdCBbcGhhc2UsIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwLm1vZGVscykpIHsnLFxuICAgICcgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiKSB7JyxcbiAgICAnICAgICAgICBtb2RlbHNbcGhhc2VdID0gdmFsdWU7JyxcbiAgICAnICAgICAgICBjb250aW51ZTsnLFxuICAgICcgICAgICB9JyxcbiAgICAnICAgICAgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiAmJiB0eXBlb2YgdmFsdWUubW9kZWwgPT09IFwic3RyaW5nXCIpIHsnLFxuICAgICcgICAgICAgIG1vZGVsc1twaGFzZV0gPSB0eXBlb2YgdmFsdWUucHJvdmlkZXIgPT09IFwic3RyaW5nXCIgJiYgdmFsdWUucHJvdmlkZXIgJiYgIXZhbHVlLm1vZGVsLmluY2x1ZGVzKFwiL1wiKScsXG4gICAgJyAgICAgICAgICA/IGAke3ZhbHVlLnByb3ZpZGVyfS8ke3ZhbHVlLm1vZGVsfWAnLFxuICAgICcgICAgICAgICAgOiB2YWx1ZS5tb2RlbDsnLFxuICAgICcgICAgICB9JyxcbiAgICAnICAgIH0nLFxuICAgICcgIH0nLFxuICAgICcgIHByZWZlcmVuY2VzID0geycsXG4gICAgJyAgICBtb2RlOiBwLm1vZGUsJyxcbiAgICAnICAgIG1vZGVsczogT2JqZWN0LmtleXMobW9kZWxzKS5sZW5ndGggPiAwID8gbW9kZWxzIDogdW5kZWZpbmVkLCcsXG4gICAgJyAgICBidWRnZXRDZWlsaW5nOiBwLmJ1ZGdldF9jZWlsaW5nLCcsXG4gICAgJyAgICBidWRnZXRFbmZvcmNlbWVudDogcC5idWRnZXRfZW5mb3JjZW1lbnQsJyxcbiAgICAnICAgIHRva2VuUHJvZmlsZTogcC50b2tlbl9wcm9maWxlLCcsXG4gICAgJyAgICBkeW5hbWljUm91dGluZzogcC5keW5hbWljX3JvdXRpbmcsJyxcbiAgICAnICAgIGN1c3RvbUluc3RydWN0aW9uczogcC5jdXN0b21faW5zdHJ1Y3Rpb25zLCcsXG4gICAgJyAgICBhbHdheXNVc2VTa2lsbHM6IHAuYWx3YXlzX3VzZV9za2lsbHMsJyxcbiAgICAnICAgIHByZWZlclNraWxsczogcC5wcmVmZXJfc2tpbGxzLCcsXG4gICAgJyAgICBhdm9pZFNraWxsczogcC5hdm9pZF9za2lsbHMsJyxcbiAgICAnICAgIGF1dG9TdXBlcnZpc29yOiBwLmF1dG9fc3VwZXJ2aXNvciA/IHsnLFxuICAgICcgICAgICBlbmFibGVkOiB0cnVlLCcsXG4gICAgJyAgICAgIHNvZnRUaW1lb3V0TWludXRlczogcC5hdXRvX3N1cGVydmlzb3Iuc29mdF90aW1lb3V0X21pbnV0ZXMsJyxcbiAgICAnICAgIH0gOiB1bmRlZmluZWQsJyxcbiAgICAnICAgIHVhdERpc3BhdGNoOiBwLnVhdF9kaXNwYXRjaCwnLFxuICAgICcgICAgYXV0b1Zpc3VhbGl6ZTogcC5hdXRvX3Zpc3VhbGl6ZSwnLFxuICAgICcgICAgcGhhc2VzOiBwLnBoYXNlcywnLFxuICAgICcgICAgY29udGV4dFNlbGVjdGlvbjogcC5jb250ZXh0X3NlbGVjdGlvbiwnLFxuICAgICcgICAgcmVhY3RpdmVFeGVjdXRpb246IHAucmVhY3RpdmVfZXhlY3V0aW9uLCcsXG4gICAgJyAgICBnYXRlRXZhbHVhdGlvbjogcC5nYXRlX2V2YWx1YXRpb24sJyxcbiAgICAnICAgIHNsaWNlUGFyYWxsZWw6IHAuc2xpY2VfcGFyYWxsZWwsJyxcbiAgICAnICAgIHNlcnZpY2VUaWVyOiBwLnNlcnZpY2VfdGllciwnLFxuICAgICcgICAgc2hvd1Rva2VuQ29zdDogcC5zaG93X3Rva2VuX2Nvc3QsJyxcbiAgICAnICAgIGNvbnRleHRXaW5kb3dPdmVycmlkZTogcC5jb250ZXh0X3dpbmRvd19vdmVycmlkZSwnLFxuICAgICcgICAgbGFuZ3VhZ2U6IHAubGFuZ3VhZ2UsJyxcbiAgICAnICAgIHJlbW90ZVF1ZXN0aW9uczogcC5yZW1vdGVfcXVlc3Rpb25zID8geycsXG4gICAgJyAgICAgIGNoYW5uZWw6IHAucmVtb3RlX3F1ZXN0aW9ucy5jaGFubmVsLCcsXG4gICAgJyAgICAgIGNoYW5uZWxJZDogU3RyaW5nKHAucmVtb3RlX3F1ZXN0aW9ucy5jaGFubmVsX2lkKSwnLFxuICAgICcgICAgICB0aW1lb3V0TWludXRlczogcC5yZW1vdGVfcXVlc3Rpb25zLnRpbWVvdXRfbWludXRlcywnLFxuICAgICcgICAgICBwb2xsSW50ZXJ2YWxTZWNvbmRzOiBwLnJlbW90ZV9xdWVzdGlvbnMucG9sbF9pbnRlcnZhbF9zZWNvbmRzLCcsXG4gICAgJyAgICB9IDogdW5kZWZpbmVkLCcsXG4gICAgJyAgICBzY29wZTogbG9hZGVkLnNjb3BlLCcsXG4gICAgJyAgICBwYXRoOiBsb2FkZWQucGF0aCwnLFxuICAgICcgICAgd2FybmluZ3M6IGxvYWRlZC53YXJuaW5ncywnLFxuICAgICcgICAgZXhwZXJpbWVudGFsOiBwLmV4cGVyaW1lbnRhbCA/IHsgcnRrOiBwLmV4cGVyaW1lbnRhbC5ydGsgfSA6IHVuZGVmaW5lZCwnLFxuICAgICcgIH07JyxcbiAgICAnfScsXG5cbiAgICAvLyAyLiBSZXNvbHZlZCBkeW5hbWljIHJvdXRpbmcgY29uZmlnIChhbHdheXMgcmV0dXJucyBhIGNvbmZpZyB3aXRoIGRlZmF1bHRzKVxuICAgICdjb25zdCByb3V0aW5nQ29uZmlnID0gcHJlZnNNb2QucmVzb2x2ZUR5bmFtaWNSb3V0aW5nQ29uZmlnKCk7JyxcblxuICAgIC8vIDMuIEJ1ZGdldCBhbGxvY2F0aW9uICh1c2UgMjAwSyBhcyBkZWZhdWx0IGNvbnRleHQgd2luZG93KVxuICAgICdjb25zdCBidWRnZXRBbGxvY2F0aW9uID0gYnVkZ2V0TW9kLmNvbXB1dGVCdWRnZXRzKDIwMDAwMCk7JyxcblxuICAgIC8vIDQuIFJvdXRpbmcgaGlzdG9yeSAobXVzdCBpbml0IGJlZm9yZSByZWFkaW5nKVxuICAgICdoaXN0b3J5TW9kLmluaXRSb3V0aW5nSGlzdG9yeShwcm9jZXNzLmVudi5HU0RfU0VUVElOR1NfQkFTRSk7JyxcbiAgICAnY29uc3Qgcm91dGluZ0hpc3RvcnkgPSBoaXN0b3J5TW9kLmdldFJvdXRpbmdIaXN0b3J5KCk7JyxcblxuICAgIC8vIDUuIFByb2plY3QgdG90YWxzIChudWxsIGlmIG5vIG1ldHJpY3MgbGVkZ2VyIGV4aXN0cylcbiAgICAnY29uc3QgbGVkZ2VyID0gbWV0cmljc01vZC5sb2FkTGVkZ2VyRnJvbURpc2socHJvY2Vzcy5lbnYuR1NEX1NFVFRJTkdTX0JBU0UpOycsXG4gICAgJ2NvbnN0IHByb2plY3RUb3RhbHMgPSBsZWRnZXIgPyBtZXRyaWNzTW9kLmdldFByb2plY3RUb3RhbHMobGVkZ2VyLnVuaXRzKSA6IG51bGw7JyxcblxuICAgIC8vIFdyaXRlIGNvbWJpbmVkIHBheWxvYWRcbiAgICAncHJvY2Vzcy5zdGRvdXQud3JpdGUoSlNPTi5zdHJpbmdpZnkoeyBwcmVmZXJlbmNlcywgcm91dGluZ0NvbmZpZywgYnVkZ2V0QWxsb2NhdGlvbiwgcm91dGluZ0hpc3RvcnksIHByb2plY3RUb3RhbHMgfSkpOycsXG4gIF0uam9pbihcIiBcIilcblxuICBjb25zdCBwcmVmaXhBcmdzID0gYnVpbGRTdWJwcm9jZXNzUHJlZml4QXJncyhwYWNrYWdlUm9vdCwgcHJlZnNSZXNvbHV0aW9uLCBwYXRoVG9GaWxlVVJMKHJlc29sdmVUc0xvYWRlcikuaHJlZilcblxuICByZXR1cm4gYXdhaXQgbmV3IFByb21pc2U8U2V0dGluZ3NEYXRhPigocmVzb2x2ZVJlc3VsdCwgcmVqZWN0KSA9PiB7XG4gICAgZXhlY0ZpbGUoXG4gICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgW1xuICAgICAgICAuLi5wcmVmaXhBcmdzLFxuICAgICAgICBcIi0tZXZhbFwiLFxuICAgICAgICBzY3JpcHQsXG4gICAgICBdLFxuICAgICAge1xuICAgICAgICBjd2Q6IHBhY2thZ2VSb290LFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgICBHU0RfU0VUVElOR1NfUFJFRlNfTU9EVUxFOiBwcmVmc1BhdGgsXG4gICAgICAgICAgR1NEX1NFVFRJTkdTX1JPVVRFUl9NT0RVTEU6IHJvdXRlclBhdGgsXG4gICAgICAgICAgR1NEX1NFVFRJTkdTX0JVREdFVF9NT0RVTEU6IGJ1ZGdldFBhdGgsXG4gICAgICAgICAgR1NEX1NFVFRJTkdTX0hJU1RPUllfTU9EVUxFOiBoaXN0b3J5UGF0aCxcbiAgICAgICAgICBHU0RfU0VUVElOR1NfTUVUUklDU19NT0RVTEU6IG1ldHJpY3NQYXRoLFxuICAgICAgICAgIEdTRF9TRVRUSU5HU19CQVNFOiBwcm9qZWN0Q3dkLFxuICAgICAgICB9LFxuICAgICAgICBtYXhCdWZmZXI6IFNFVFRJTkdTX01BWF9CVUZGRVIsXG4gICAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIChlcnJvciwgc3Rkb3V0LCBzdGRlcnIpID0+IHtcbiAgICAgICAgaWYgKGVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgc2V0dGluZ3MgZGF0YSBzdWJwcm9jZXNzIGZhaWxlZDogJHtzdGRlcnIgfHwgZXJyb3IubWVzc2FnZX1gKSlcbiAgICAgICAgICByZXR1cm5cbiAgICAgICAgfVxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVzb2x2ZVJlc3VsdChKU09OLnBhcnNlKHN0ZG91dCkgYXMgU2V0dGluZ3NEYXRhKVxuICAgICAgICB9IGNhdGNoIChwYXJzZUVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KFxuICAgICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgICBgc2V0dGluZ3MgZGF0YSBzdWJwcm9jZXNzIHJldHVybmVkIGludmFsaWQgSlNPTjogJHtwYXJzZUVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBwYXJzZUVycm9yLm1lc3NhZ2UgOiBTdHJpbmcocGFyc2VFcnJvcil9YCxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICB9LFxuICAgIClcbiAgfSlcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsZ0JBQWdCO0FBQ3pCLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsWUFBWTtBQUNyQixTQUFTLHFCQUFxQjtBQUU5QixTQUFTLGtDQUFrQztBQUMzQyxTQUFtQyx5QkFBeUIsaUNBQWlDO0FBRzdGLE1BQU0sc0JBQXNCLElBQUksT0FBTztBQUV2QyxTQUFTLG9CQUFvQixhQUE2QjtBQUN4RCxTQUFPLEtBQUssYUFBYSxPQUFPLGFBQWEsY0FBYyxPQUFPLFNBQVMsZ0JBQWdCO0FBQzdGO0FBV0EsZUFBc0Isb0JBQW9CLG9CQUFvRDtBQUM1RixRQUFNLFNBQVMsMkJBQTJCLFFBQVcsa0JBQWtCO0FBQ3ZFLFFBQU0sRUFBRSxhQUFhLFdBQVcsSUFBSTtBQUVwQyxRQUFNLGtCQUFrQixvQkFBb0IsV0FBVztBQUN2RCxRQUFNLGtCQUFrQix3QkFBd0IsYUFBYSx5Q0FBeUM7QUFDdEcsUUFBTSxtQkFBbUIsd0JBQXdCLGFBQWEsMENBQTBDO0FBQ3hHLFFBQU0sbUJBQW1CLHdCQUF3QixhQUFhLDRDQUE0QztBQUMxRyxRQUFNLG9C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
