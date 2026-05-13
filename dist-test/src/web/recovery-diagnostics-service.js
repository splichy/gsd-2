import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectCurrentProjectOnboardingState,
  collectSelectiveLiveStatePayload,
  resolveBridgeRuntimeConfig
} from "./bridge-service.js";
import { resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.js";
const RECOVERY_DIAGNOSTICS_MAX_BUFFER = 1024 * 1024;
function redactSensitiveText(value) {
  return value.replace(/sk-[A-Za-z0-9_-]{6,}/g, "[redacted]").replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted]").replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").replace(/([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET)["'=:\s]+)([^\s,;"']+)/gi, "$1[redacted]");
}
function sanitizeText(value) {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  return redactSensitiveText(raw).replace(/\s+/g, " ").trim();
}
function humanizeCode(code) {
  return code.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
function activeScopeFromWorkspace(workspace) {
  if (!workspace?.active.milestoneId) return null;
  if (workspace.active.taskId && workspace.active.sliceId) {
    return `${workspace.active.milestoneId}/${workspace.active.sliceId}/${workspace.active.taskId}`;
  }
  if (workspace.active.sliceId) {
    return `${workspace.active.milestoneId}/${workspace.active.sliceId}`;
  }
  return workspace.active.milestoneId;
}
function recoveryUnitFromWorkspace(workspace) {
  const scope = activeScopeFromWorkspace(workspace);
  if (!scope) return null;
  if (workspace?.active.taskId) {
    return { type: "execute-task", id: scope };
  }
  if (workspace?.active.sliceId) {
    return { type: "execute-slice", id: scope };
  }
  return { type: "execute-milestone", id: scope };
}
function selectRecoverySessionFile(activeSessionFile, resumableSessions) {
  if (!activeSessionFile) {
    return resumableSessions[0]?.path ?? null;
  }
  const normalizedActiveSessionFile = resolve(activeSessionFile);
  const matchingCurrentProjectSession = resumableSessions.find((session) => resolve(session.path) === normalizedActiveSessionFile);
  if (matchingCurrentProjectSession) {
    return matchingCurrentProjectSession.path;
  }
  return resumableSessions[0]?.path ?? activeSessionFile;
}
function selectRecoverySessionId(activeSessionId, sessionFile, resumableSessions) {
  if (!sessionFile) return activeSessionId ?? null;
  const normalizedSessionFile = resolve(sessionFile);
  return resumableSessions.find((session) => resolve(session.path) === normalizedSessionFile)?.id ?? activeSessionId ?? null;
}
function summarizeSeverityCounts(issues) {
  return issues.reduce(
    (counts, issue) => ({
      errors: counts.errors + Number(issue.severity === "error"),
      warnings: counts.warnings + Number(issue.severity === "warning"),
      infos: counts.infos + Number(issue.severity === "info")
    }),
    { errors: 0, warnings: 0, infos: 0 }
  );
}
function summarizeCodes(issues) {
  const map = /* @__PURE__ */ new Map();
  const severityRank = { info: 0, warning: 1, error: 2 };
  for (const issue of issues) {
    const current = map.get(issue.code);
    if (!current) {
      map.set(issue.code, { count: 1, severity: issue.severity });
      continue;
    }
    map.set(issue.code, {
      count: current.count + 1,
      severity: severityRank[issue.severity] > severityRank[current.severity] ? issue.severity : current.severity
    });
  }
  return [...map.entries()].map(([code, data]) => ({
    code,
    count: data.count,
    label: humanizeCode(code),
    severity: data.severity
  })).sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}
function sanitizeIssueDigest(issue) {
  return {
    code: issue.code,
    severity: issue.severity,
    scope: issue.scope,
    message: sanitizeText(issue.message),
    file: issue.file,
    suggestion: issue.suggestion ? sanitizeText(issue.suggestion) : void 0,
    unitId: issue.unitId
  };
}
function buildCommandSuggestions(activeScope, phase, validationCount) {
  const suggestions = /* @__PURE__ */ new Map();
  const add = (command, label) => {
    if (!suggestions.has(command)) {
      suggestions.set(command, { command, label });
    }
  };
  if (phase === "planning") add("/gsd", "Open GSD planning");
  if (phase === "executing" || phase === "summarizing") add("/gsd auto", "Resume GSD auto mode");
  if (activeScope) add(`/gsd doctor ${activeScope}`, "Inspect scoped doctor report");
  if (activeScope) add(`/gsd doctor fix ${activeScope}`, "Apply scoped doctor fixes");
  if (validationCount > 0 && activeScope) add(`/gsd doctor audit ${activeScope}`, "Audit validation diagnostics");
  add("/gsd status", "Check current-project status");
  return [...suggestions.values()];
}
function buildBrowserActions(options) {
  const actions = /* @__PURE__ */ new Map();
  const add = (action) => {
    actions.set(action.id, action);
  };
  add({
    id: "refresh_diagnostics",
    label: "Refresh diagnostics",
    detail: "Reload the on-demand recovery route without refreshing the entire workspace.",
    emphasis: "primary"
  });
  add({
    id: "refresh_workspace",
    label: "Refresh workspace",
    detail: "Run one soft workspace refresh so the browser re-syncs boot, bridge, and onboarding state."
  });
  if (options.retryActive || options.autoRetryEnabled || options.bridgeFailure || options.compactionActive) {
    add({
      id: "open_retry_controls",
      label: "Open retry controls",
      detail: "Inspect or change live retry and compaction controls on the authoritative browser surface."
    });
  }
  if (options.hasSessions) {
    add({
      id: "open_resume_controls",
      label: "Open resume controls",
      detail: "Switch to another current-project session if recovery should continue elsewhere."
    });
  }
  if (options.authAttentionNeeded) {
    add({
      id: "open_auth_controls",
      label: "Open auth controls",
      detail: "Inspect provider setup and bridge auth refresh failures from the shared browser surface.",
      emphasis: "danger"
    });
  }
  return [...actions.values()];
}
function resolveSummary(options) {
  if (options.authFailureMessage) {
    return {
      tone: "danger",
      label: "Bridge auth refresh failed",
      detail: options.authFailureMessage
    };
  }
  if (options.bridgeFailureMessage) {
    return {
      tone: "danger",
      label: options.lastFailurePhase ? `Bridge recovery failed during ${options.lastFailurePhase}` : "Bridge recovery failed",
      detail: options.bridgeFailureMessage
    };
  }
  if (options.doctorErrors > 0 || options.validationErrors > 0) {
    return {
      tone: "danger",
      label: `Recovery blockers detected (${options.doctorErrors + options.validationErrors})`,
      detail: `Doctor and validation surfaced blocking issues for ${options.currentUnitId ?? "the current project"}.`
    };
  }
  if (options.retryInProgress) {
    return {
      tone: "warning",
      label: `Retry attempt ${Math.max(1, options.retryAttempt)} is active`,
      detail: "The bridge is retrying work right now; inspect retry controls before issuing more recovery actions."
    };
  }
  if (options.compactionActive) {
    return {
      tone: "warning",
      label: "Compaction is active",
      detail: "The live session is compacting context before work continues."
    };
  }
  if (options.validationCount > 0 || options.doctorTotal > 0) {
    return {
      tone: "warning",
      label: `Recovery diagnostics found ${options.validationCount + options.doctorTotal} actionable issue${options.validationCount + options.doctorTotal === 1 ? "" : "s"}`,
      detail: `Review the doctor and validation sections below before resuming work on ${options.currentUnitId ?? "the current project"}.`
    };
  }
  if (options.interruptedRunDetected) {
    return {
      tone: "warning",
      label: "Interrupted-run evidence is available",
      detail: options.interruptedRunDetail
    };
  }
  if (options.status === "unavailable") {
    return {
      tone: "healthy",
      label: "Recovery diagnostics unavailable",
      detail: "No current-project recovery evidence has been captured yet. Start or resume a session to populate diagnostics."
    };
  }
  return {
    tone: "healthy",
    label: "Recovery diagnostics healthy",
    detail: "No bridge, validation, doctor, or interrupted-run recovery issues are currently active."
  };
}
function resolveTsLoaderPath(packageRoot) {
  return join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
}
async function collectRecoveryDiagnosticsChildPayload(packageRoot, basePath, scope, unit, sessionFile, options) {
  const env = options.env ?? process.env;
  const checkExists = options.existsSync ?? existsSync;
  const resolveTsLoader = resolveTsLoaderPath(packageRoot);
  const doctorResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/doctor.ts", checkExists);
  const forensicsResolution = resolveSubprocessModule(packageRoot, "resources/extensions/gsd/session-forensics.ts", checkExists);
  const doctorModulePath = doctorResolution.modulePath;
  const sessionForensicsModulePath = forensicsResolution.modulePath;
  if (!doctorResolution.useCompiledJs && (!checkExists(resolveTsLoader) || !checkExists(doctorModulePath) || !checkExists(sessionForensicsModulePath))) {
    throw new Error(
      `recovery diagnostics providers not found; checked=${resolveTsLoader},${doctorModulePath},${sessionForensicsModulePath}`
    );
  }
  if (doctorResolution.useCompiledJs && (!checkExists(doctorModulePath) || !checkExists(sessionForensicsModulePath))) {
    throw new Error(
      `recovery diagnostics providers not found; checked=${doctorModulePath},${sessionForensicsModulePath}`
    );
  }
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    "const doctor = await import(pathToFileURL(process.env.GSD_RECOVERY_DOCTOR_MODULE).href);",
    "const forensics = await import(pathToFileURL(process.env.GSD_RECOVERY_FORENSICS_MODULE).href);",
    "const basePath = process.env.GSD_RECOVERY_BASE;",
    "const scope = process.env.GSD_RECOVERY_SCOPE || undefined;",
    'const unitType = process.env.GSD_RECOVERY_UNIT_TYPE || "execute-project";',
    'const unitId = process.env.GSD_RECOVERY_UNIT_ID || "project";',
    "const sessionFile = process.env.GSD_RECOVERY_SESSION_FILE || undefined;",
    "const activityDir = process.env.GSD_RECOVERY_ACTIVITY_DIR || undefined;",
    'const report = await doctor.runGSDDoctor(basePath, { fix: false, scope, fixLevel: "task" });',
    "const summary = doctor.summarizeDoctorIssues(report.issues);",
    "const briefing = forensics.synthesizeCrashRecovery(basePath, unitType, unitId, sessionFile, activityDir);",
    "const trace = briefing?.trace;",
    "const available = Boolean(sessionFile || trace?.toolCallCount || briefing?.gitChanges);",
    "const detected = Boolean((trace?.toolCallCount ?? 0) > 0 || (trace?.errors?.length ?? 0) > 0 || (trace?.commandsRun?.length ?? 0) > 0 || (trace?.filesWritten?.length ?? 0) > 0 || briefing?.gitChanges);",
    "const interruptedRun = available",
    "  ? detected",
    "    ? {",
    "        available: true,",
    "        detected: true,",
    '        label: "Interrupted-run recovery available",',
    '        detail: "Recent session forensics captured unfinished work or errors that may need resume or retry follow-up.",',
    "        unit: { type: briefing?.unitType ?? unitType, id: briefing?.unitId ?? unitId },",
    "        counts: {",
    "          toolCalls: trace?.toolCallCount ?? 0,",
    "          filesWritten: trace?.filesWritten?.length ?? 0,",
    "          commandsRun: trace?.commandsRun?.length ?? 0,",
    "          errors: trace?.errors?.length ?? 0,",
    "        },",
    "        gitChangesDetected: Boolean(briefing?.gitChanges),",
    "        lastError: trace?.errors?.at(-1) ?? null,",
    "      }",
    "    : {",
    "        available: true,",
    "        detected: false,",
    '        label: "Session forensics available",',
    '        detail: "A current-project session was inspected, but it did not show unfinished tool or error activity.",',
    "        unit: { type: briefing?.unitType ?? unitType, id: briefing?.unitId ?? unitId },",
    "        counts: {",
    "          toolCalls: trace?.toolCallCount ?? 0,",
    "          filesWritten: trace?.filesWritten?.length ?? 0,",
    "          commandsRun: trace?.commandsRun?.length ?? 0,",
    "          errors: trace?.errors?.length ?? 0,",
    "        },",
    "        gitChangesDetected: Boolean(briefing?.gitChanges),",
    "        lastError: trace?.errors?.at(-1) ?? null,",
    "      }",
    "  : {",
    "      available: false,",
    "      detected: false,",
    '      label: "No interrupted-run evidence",',
    '      detail: "No current-project session or activity log is available for interrupted-run forensics yet.",',
    "      unit: null,",
    "      counts: { toolCalls: 0, filesWritten: 0, commandsRun: 0, errors: 0 },",
    "      gitChangesDetected: false,",
    "      lastError: null,",
    "    };",
    "process.stdout.write(JSON.stringify({",
    "  doctor: {",
    "    scope: scope ?? null,",
    "    total: summary.total,",
    "    errors: summary.errors,",
    "    warnings: summary.warnings,",
    "    infos: summary.infos,",
    "    fixable: summary.fixable,",
    "    codes: summary.byCode,",
    "    topIssues: report.issues.slice(0, 6).map((issue) => ({",
    "      code: issue.code,",
    "      severity: issue.severity,",
    "      scope: issue.scope,",
    "      message: issue.message,",
    "      file: issue.file,",
    "      unitId: issue.unitId,",
    "    })),",
    "  },",
    "  interruptedRun,",
    "}));"
  ].join(" ");
  const prefixArgs = buildSubprocessPrefixArgs(packageRoot, doctorResolution, pathToFileURL(resolveTsLoader).href);
  return await new Promise((resolveResult, reject) => {
    execFile(
      options.execPath ?? process.execPath,
      [
        ...prefixArgs,
        "--eval",
        script
      ],
      {
        cwd: packageRoot,
        env: {
          ...env,
          GSD_RECOVERY_BASE: basePath,
          GSD_RECOVERY_SCOPE: scope ?? "",
          GSD_RECOVERY_UNIT_TYPE: unit?.type ?? "execute-project",
          GSD_RECOVERY_UNIT_ID: unit?.id ?? "project",
          GSD_RECOVERY_SESSION_FILE: sessionFile ?? "",
          GSD_RECOVERY_ACTIVITY_DIR: join(basePath, ".gsd", "activity"),
          GSD_RECOVERY_DOCTOR_MODULE: doctorModulePath,
          GSD_RECOVERY_FORENSICS_MODULE: sessionForensicsModulePath
        },
        maxBuffer: RECOVERY_DIAGNOSTICS_MAX_BUFFER,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`recovery diagnostics subprocess failed: ${stderr || error.message}`));
          return;
        }
        try {
          resolveResult(JSON.parse(stdout));
        } catch (parseError) {
          reject(
            new Error(
              `recovery diagnostics subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            )
          );
        }
      }
    );
  });
}
async function collectCurrentProjectRecoveryDiagnostics(options = {}, projectCwdOverride) {
  const env = options.env ?? process.env;
  const config = resolveBridgeRuntimeConfig(options.env, projectCwdOverride);
  const [{ bridge: bridgeSnapshot, workspace, resumableSessions: resumableSessionsRaw }, onboarding] = await Promise.all([
    collectSelectiveLiveStatePayload(["workspace", "resumable_sessions"], projectCwdOverride),
    collectCurrentProjectOnboardingState(projectCwdOverride)
  ]);
  const resumableSessions = resumableSessionsRaw ?? [];
  const activeScope = activeScopeFromWorkspace(workspace);
  const unit = recoveryUnitFromWorkspace(workspace);
  const sessionFile = selectRecoverySessionFile(bridgeSnapshot.activeSessionFile, resumableSessions);
  const recoverySessionId = selectRecoverySessionId(bridgeSnapshot.activeSessionId, sessionFile, resumableSessions);
  const recoveryChild = await collectRecoveryDiagnosticsChildPayload(
    config.packageRoot,
    config.projectCwd,
    activeScope,
    unit,
    sessionFile,
    options
  );
  const validationIssues = (workspace?.validationIssues ?? []).map((issue) => {
    const typedIssue = issue;
    return {
      code: typedIssue.ruleId ?? "unknown_validation_issue",
      severity: typedIssue.severity ?? "warning",
      scope: typedIssue.scope ?? "workspace",
      message: sanitizeText(typedIssue.message ?? "Validation issue"),
      file: typedIssue.file,
      suggestion: typedIssue.suggestion ? sanitizeText(typedIssue.suggestion) : void 0
    };
  });
  const validationCounts = summarizeSeverityCounts(validationIssues);
  const validationCodes = summarizeCodes(validationIssues);
  const doctorTopIssues = recoveryChild.doctor.topIssues.map(sanitizeIssueDigest);
  const interruptedRun = {
    ...recoveryChild.interruptedRun,
    label: sanitizeText(recoveryChild.interruptedRun.label),
    detail: sanitizeText(recoveryChild.interruptedRun.detail),
    lastError: recoveryChild.interruptedRun.lastError ? sanitizeText(recoveryChild.interruptedRun.lastError) : null
  };
  const bridgeFailure = bridgeSnapshot.lastError ? {
    message: sanitizeText(bridgeSnapshot.lastError.message),
    phase: bridgeSnapshot.lastError.phase,
    at: bridgeSnapshot.lastError.at,
    commandType: bridgeSnapshot.lastError.commandType ?? null,
    afterSessionAttachment: bridgeSnapshot.lastError.afterSessionAttachment
  } : null;
  const authRefreshPhase = onboarding.bridgeAuthRefresh.phase;
  const authRefreshError = onboarding.bridgeAuthRefresh.error ? sanitizeText(onboarding.bridgeAuthRefresh.error) : null;
  const authRefreshLabel = authRefreshPhase === "failed" ? "Bridge auth refresh failed" : authRefreshPhase === "pending" ? "Bridge auth refresh pending" : authRefreshPhase === "succeeded" ? "Bridge auth refresh succeeded" : "Bridge auth refresh idle";
  const status = bridgeFailure || authRefreshPhase === "failed" || validationIssues.length > 0 || recoveryChild.doctor.total > 0 || interruptedRun.available || resumableSessions.length > 0 || Boolean(bridgeSnapshot.sessionState?.retryInProgress) || Boolean(bridgeSnapshot.sessionState?.isCompacting) ? "ready" : "unavailable";
  const currentUnitId = unit?.id ?? activeScope;
  const summary = resolveSummary({
    status,
    validationCount: validationIssues.length,
    validationErrors: validationCounts.errors,
    doctorTotal: recoveryChild.doctor.total,
    doctorErrors: recoveryChild.doctor.errors,
    retryAttempt: bridgeSnapshot.sessionState?.retryAttempt ?? 0,
    retryInProgress: Boolean(bridgeSnapshot.sessionState?.retryInProgress),
    compactionActive: Boolean(bridgeSnapshot.sessionState?.isCompacting),
    currentUnitId: currentUnitId ?? null,
    lastFailurePhase: authRefreshPhase === "failed" ? "bridge_auth_refresh" : bridgeFailure?.phase ?? null,
    bridgeFailureMessage: bridgeFailure?.message ?? null,
    authFailureMessage: authRefreshPhase === "failed" ? authRefreshError : null,
    interruptedRunDetected: interruptedRun.detected,
    interruptedRunDetail: interruptedRun.detail
  });
  return {
    status,
    loadedAt: (/* @__PURE__ */ new Date()).toISOString(),
    project: {
      cwd: config.projectCwd,
      activeScope,
      activeSessionPath: sessionFile,
      activeSessionId: recoverySessionId
    },
    summary: {
      tone: summary.tone,
      label: summary.label,
      detail: summary.detail,
      validationCount: validationIssues.length,
      doctorIssueCount: recoveryChild.doctor.total,
      lastFailurePhase: authRefreshPhase === "failed" ? "bridge_auth_refresh" : bridgeFailure?.phase ?? null,
      currentUnitId: currentUnitId ?? null,
      retryAttempt: bridgeSnapshot.sessionState?.retryAttempt ?? 0,
      retryInProgress: Boolean(bridgeSnapshot.sessionState?.retryInProgress),
      compactionActive: Boolean(bridgeSnapshot.sessionState?.isCompacting)
    },
    bridge: {
      phase: bridgeSnapshot.phase,
      retry: {
        enabled: Boolean(bridgeSnapshot.sessionState?.autoRetryEnabled),
        inProgress: Boolean(bridgeSnapshot.sessionState?.retryInProgress),
        attempt: bridgeSnapshot.sessionState?.retryAttempt ?? 0,
        label: bridgeSnapshot.sessionState?.retryInProgress ? `Attempt ${Math.max(1, bridgeSnapshot.sessionState?.retryAttempt ?? 0)}` : bridgeSnapshot.sessionState?.autoRetryEnabled ? "Enabled" : "Disabled"
      },
      compaction: {
        active: Boolean(bridgeSnapshot.sessionState?.isCompacting),
        label: bridgeSnapshot.sessionState?.isCompacting ? "Compaction active" : "Compaction idle"
      },
      lastFailure: bridgeFailure,
      authRefresh: {
        phase: authRefreshPhase,
        error: authRefreshError,
        label: authRefreshLabel
      }
    },
    validation: {
      total: validationIssues.length,
      bySeverity: validationCounts,
      codes: validationCodes,
      topIssues: validationIssues.slice(0, 6)
    },
    doctor: {
      scope: recoveryChild.doctor.scope,
      total: recoveryChild.doctor.total,
      errors: recoveryChild.doctor.errors,
      warnings: recoveryChild.doctor.warnings,
      infos: recoveryChild.doctor.infos,
      fixable: recoveryChild.doctor.fixable,
      codes: recoveryChild.doctor.codes,
      topIssues: doctorTopIssues
    },
    interruptedRun,
    actions: {
      browser: buildBrowserActions({
        hasSessions: resumableSessions.length > 0,
        retryActive: Boolean(bridgeSnapshot.sessionState?.retryInProgress),
        autoRetryEnabled: Boolean(bridgeSnapshot.sessionState?.autoRetryEnabled),
        bridgeFailure: Boolean(bridgeFailure),
        compactionActive: Boolean(bridgeSnapshot.sessionState?.isCompacting),
        authAttentionNeeded: onboarding.locked || authRefreshPhase === "failed" || onboarding.lastValidation?.status === "failed"
      }),
      commands: buildCommandSuggestions(activeScope, workspace?.active.phase, validationIssues.length)
    }
  };
}
export {
  collectCurrentProjectRecoveryDiagnostics
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3dlYi9yZWNvdmVyeS1kaWFnbm9zdGljcy1zZXJ2aWNlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBleGVjRmlsZSB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIlxuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCJcbmltcG9ydCB7IGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCJcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tIFwibm9kZTp1cmxcIlxuXG5pbXBvcnQge1xuICBjb2xsZWN0Q3VycmVudFByb2plY3RPbmJvYXJkaW5nU3RhdGUsXG4gIGNvbGxlY3RTZWxlY3RpdmVMaXZlU3RhdGVQYXlsb2FkLFxuICByZXNvbHZlQnJpZGdlUnVudGltZUNvbmZpZyxcbn0gZnJvbSBcIi4vYnJpZGdlLXNlcnZpY2UudHNcIlxuaW1wb3J0IHsgcmVzb2x2ZVR5cGVTdHJpcHBpbmdGbGFnLCByZXNvbHZlU3VicHJvY2Vzc01vZHVsZSwgYnVpbGRTdWJwcm9jZXNzUHJlZml4QXJncyB9IGZyb20gXCIuL3RzLXN1YnByb2Nlc3MtZmxhZ3MudHNcIlxuaW1wb3J0IHR5cGUge1xuICBXb3Jrc3BhY2VSZWNvdmVyeUJyb3dzZXJBY3Rpb24sXG4gIFdvcmtzcGFjZVJlY292ZXJ5Q29kZVN1bW1hcnksXG4gIFdvcmtzcGFjZVJlY292ZXJ5Q29tbWFuZFN1Z2dlc3Rpb24sXG4gIFdvcmtzcGFjZVJlY292ZXJ5RGlhZ25vc3RpY3MsXG4gIFdvcmtzcGFjZVJlY292ZXJ5SXNzdWVEaWdlc3QsXG4gIFdvcmtzcGFjZVJlY292ZXJ5U3VtbWFyeVRvbmUsXG59IGZyb20gXCIuLi8uLi93ZWIvbGliL2NvbW1hbmQtc3VyZmFjZS1jb250cmFjdC50c1wiXG5cbmNvbnN0IFJFQ09WRVJZX0RJQUdOT1NUSUNTX01BWF9CVUZGRVIgPSAxMDI0ICogMTAyNFxuXG50eXBlIFJlY292ZXJ5RGlhZ25vc3RpY3NTZXZlcml0eSA9IFwiaW5mb1wiIHwgXCJ3YXJuaW5nXCIgfCBcImVycm9yXCJcblxuaW50ZXJmYWNlIFJlY292ZXJ5RGlhZ25vc3RpY3NTZXJ2aWNlT3B0aW9ucyB7XG4gIGV4ZWNQYXRoPzogc3RyaW5nXG4gIGVudj86IE5vZGVKUy5Qcm9jZXNzRW52XG4gIGV4aXN0c1N5bmM/OiAocGF0aDogc3RyaW5nKSA9PiBib29sZWFuXG59XG5cbmludGVyZmFjZSBSZWNvdmVyeURpYWdub3N0aWNzQ2hpbGRJc3N1ZSB7XG4gIGNvZGU6IHN0cmluZ1xuICBzZXZlcml0eTogUmVjb3ZlcnlEaWFnbm9zdGljc1NldmVyaXR5XG4gIHNjb3BlOiBzdHJpbmdcbiAgbWVzc2FnZTogc3RyaW5nXG4gIGZpbGU/OiBzdHJpbmdcbiAgc3VnZ2VzdGlvbj86IHN0cmluZ1xuICB1bml0SWQ/OiBzdHJpbmdcbn1cblxuaW50ZXJmYWNlIFJlY292ZXJ5RGlhZ25vc3RpY3NDaGlsZFBheWxvYWQge1xuICBkb2N0b3I6IHtcbiAgICBzY29wZTogc3RyaW5nIHwgbnVsbFxuICAgIHRvdGFsOiBudW1iZXJcbiAgICBlcnJvcnM6IG51bWJlclxuICAgIHdhcm5pbmdzOiBudW1iZXJcbiAgICBpbmZvczogbnVtYmVyXG4gICAgZml4YWJsZTogbnVtYmVyXG4gICAgY29kZXM6IEFycmF5PHsgY29kZTogc3RyaW5nOyBjb3VudDogbnVtYmVyIH0+XG4gICAgdG9wSXNzdWVzOiBSZWNvdmVyeURpYWdub3N0aWNzQ2hpbGRJc3N1ZVtdXG4gIH1cbiAgaW50ZXJydXB0ZWRSdW46IHtcbiAgICBhdmFpbGFibGU6IGJvb2xlYW5cbiAgICBkZXRlY3RlZDogYm9vbGVhblxuICAgIGxhYmVsOiBzdHJpbmdcbiAgICBkZXRhaWw6IHN0cmluZ1xuICAgIHVuaXQ6IHtcbiAgICAgIHR5cGU6IHN0cmluZ1xuICAgICAgaWQ6IHN0cmluZ1xuICAgIH0gfCBudWxsXG4gICAgY291bnRzOiB7XG4gICAgICB0b29sQ2FsbHM6IG51bWJlclxuICAgICAgZmlsZXNXcml0dGVuOiBudW1iZXJcbiAgICAgIGNvbW1hbmRzUnVuOiBudW1iZXJcbiAgICAgIGVycm9yczogbnVtYmVyXG4gICAgfVxuICAgIGdpdENoYW5nZXNEZXRlY3RlZDogYm9vbGVhblxuICAgIGxhc3RFcnJvcjogc3RyaW5nIHwgbnVsbFxuICB9XG59XG5cbmZ1bmN0aW9uIHJlZGFjdFNlbnNpdGl2ZVRleHQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZVxuICAgIC5yZXBsYWNlKC9zay1bQS1aYS16MC05Xy1dezYsfS9nLCBcIltyZWRhY3RlZF1cIilcbiAgICAucmVwbGFjZSgveG94W2JhcHJzXS1bQS1aYS16MC05LV0rL2csIFwiW3JlZGFjdGVkXVwiKVxuICAgIC5yZXBsYWNlKC9CZWFyZXJcXHMrW15cXHNdKy9naSwgXCJCZWFyZXIgW3JlZGFjdGVkXVwiKVxuICAgIC5yZXBsYWNlKC8oW0EtWjAtOV9dKig/OkFQSVtfLV0/S0VZfFRPS0VOfFNFQ1JFVClbXCInPTpcXHNdKykoW15cXHMsO1wiJ10rKS9naSwgXCIkMVtyZWRhY3RlZF1cIilcbn1cblxuZnVuY3Rpb24gc2FuaXRpemVUZXh0KHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHtcbiAgY29uc3QgcmF3ID0gdmFsdWUgaW5zdGFuY2VvZiBFcnJvciA/IHZhbHVlLm1lc3NhZ2UgOiBTdHJpbmcodmFsdWUgPz8gXCJcIilcbiAgcmV0dXJuIHJlZGFjdFNlbnNpdGl2ZVRleHQocmF3KS5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50cmltKClcbn1cblxuZnVuY3Rpb24gaHVtYW5pemVDb2RlKGNvZGU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBjb2RlLnJlcGxhY2UoL1tfLV0rL2csIFwiIFwiKS5yZXBsYWNlKC9cXGJcXHcvZywgKGNoYXJhY3RlcikgPT4gY2hhcmFjdGVyLnRvVXBwZXJDYXNlKCkpXG59XG5cbmZ1bmN0aW9uIGFjdGl2ZVNjb3BlRnJvbVdvcmtzcGFjZSh3b3Jrc3BhY2U6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgY29sbGVjdFNlbGVjdGl2ZUxpdmVTdGF0ZVBheWxvYWQ+PltcIndvcmtzcGFjZVwiXSk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIXdvcmtzcGFjZT8uYWN0aXZlLm1pbGVzdG9uZUlkKSByZXR1cm4gbnVsbFxuICBpZiAod29ya3NwYWNlLmFjdGl2ZS50YXNrSWQgJiYgd29ya3NwYWNlLmFjdGl2ZS5zbGljZUlkKSB7XG4gICAgcmV0dXJuIGAke3dvcmtzcGFjZS5hY3RpdmUubWlsZXN0b25lSWR9LyR7d29ya3NwYWNlLmFjdGl2ZS5zbGljZUlkfS8ke3dvcmtzcGFjZS5hY3RpdmUudGFza0lkfWBcbiAgfVxuICBpZiAod29ya3NwYWNlLmFjdGl2ZS5zbGljZUlkKSB7XG4gICAgcmV0dXJuIGAke3dvcmtzcGFjZS5hY3RpdmUubWlsZXN0b25lSWR9LyR7d29ya3NwYWNlLmFjdGl2ZS5zbGljZUlkfWBcbiAgfVxuICByZXR1cm4gd29ya3NwYWNlLmFjdGl2ZS5taWxlc3RvbmVJZFxufVxuXG5mdW5jdGlvbiByZWNvdmVyeVVuaXRGcm9tV29ya3NwYWNlKHdvcmtzcGFjZTogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBjb2xsZWN0U2VsZWN0aXZlTGl2ZVN0YXRlUGF5bG9hZD4+W1wid29ya3NwYWNlXCJdKTogeyB0eXBlOiBzdHJpbmc7IGlkOiBzdHJpbmcgfSB8IG51bGwge1xuICBjb25zdCBzY29wZSA9IGFjdGl2ZVNjb3BlRnJvbVdvcmtzcGFjZSh3b3Jrc3BhY2UpXG4gIGlmICghc2NvcGUpIHJldHVybiBudWxsXG5cbiAgaWYgKHdvcmtzcGFjZT8uYWN0aXZlLnRhc2tJZCkge1xuICAgIHJldHVybiB7IHR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsIGlkOiBzY29wZSB9XG4gIH1cbiAgaWYgKHdvcmtzcGFjZT8uYWN0aXZlLnNsaWNlSWQpIHtcbiAgICByZXR1cm4geyB0eXBlOiBcImV4ZWN1dGUtc2xpY2VcIiwgaWQ6IHNjb3BlIH1cbiAgfVxuICByZXR1cm4geyB0eXBlOiBcImV4ZWN1dGUtbWlsZXN0b25lXCIsIGlkOiBzY29wZSB9XG59XG5cbmZ1bmN0aW9uIHNlbGVjdFJlY292ZXJ5U2Vzc2lvbkZpbGUoXG4gIGFjdGl2ZVNlc3Npb25GaWxlOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkLFxuICByZXN1bWFibGVTZXNzaW9uczogQXJyYXk8eyBpZDogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfT4sXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCFhY3RpdmVTZXNzaW9uRmlsZSkge1xuICAgIHJldHVybiByZXN1bWFibGVTZXNzaW9uc1swXT8ucGF0aCA/PyBudWxsXG4gIH1cblxuICBjb25zdCBub3JtYWxpemVkQWN0aXZlU2Vzc2lvbkZpbGUgPSByZXNvbHZlKGFjdGl2ZVNlc3Npb25GaWxlKVxuICBjb25zdCBtYXRjaGluZ0N1cnJlbnRQcm9qZWN0U2Vzc2lvbiA9IHJlc3VtYWJsZVNlc3Npb25zLmZpbmQoKHNlc3Npb24pID0+IHJlc29sdmUoc2Vzc2lvbi5wYXRoKSA9PT0gbm9ybWFsaXplZEFjdGl2ZVNlc3Npb25GaWxlKVxuICBpZiAobWF0Y2hpbmdDdXJyZW50UHJvamVjdFNlc3Npb24pIHtcbiAgICByZXR1cm4gbWF0Y2hpbmdDdXJyZW50UHJvamVjdFNlc3Npb24ucGF0aFxuICB9XG5cbiAgcmV0dXJuIHJlc3VtYWJsZVNlc3Npb25zWzBdPy5wYXRoID8/IGFjdGl2ZVNlc3Npb25GaWxlXG59XG5cbmZ1bmN0aW9uIHNlbGVjdFJlY292ZXJ5U2Vzc2lvbklkKFxuICBhY3RpdmVTZXNzaW9uSWQ6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQsXG4gIHNlc3Npb25GaWxlOiBzdHJpbmcgfCBudWxsLFxuICByZXN1bWFibGVTZXNzaW9uczogQXJyYXk8eyBpZDogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfT4sXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCFzZXNzaW9uRmlsZSkgcmV0dXJuIGFjdGl2ZVNlc3Npb25JZCA/PyBudWxsXG5cbiAgY29uc3Qgbm9ybWFsaXplZFNlc3Npb25GaWxlID0gcmVzb2x2ZShzZXNzaW9uRmlsZSlcbiAgcmV0dXJuIHJlc3VtYWJsZVNlc3Npb25zLmZpbmQoKHNlc3Npb24pID0+IHJlc29sdmUoc2Vzc2lvbi5wYXRoKSA9PT0gbm9ybWFsaXplZFNlc3Npb25GaWxlKT8uaWQgPz8gYWN0aXZlU2Vzc2lvbklkID8/IG51bGxcbn1cblxuZnVuY3Rpb24gc3VtbWFyaXplU2V2ZXJpdHlDb3VudHMoaXNzdWVzOiBBcnJheTx7IHNldmVyaXR5OiBSZWNvdmVyeURpYWdub3N0aWNzU2V2ZXJpdHkgfT4pOiB7XG4gIGVycm9yczogbnVtYmVyXG4gIHdhcm5pbmdzOiBudW1iZXJcbiAgaW5mb3M6IG51bWJlclxufSB7XG4gIHJldHVybiBpc3N1ZXMucmVkdWNlKFxuICAgIChjb3VudHMsIGlzc3VlKSA9PiAoe1xuICAgICAgZXJyb3JzOiBjb3VudHMuZXJyb3JzICsgTnVtYmVyKGlzc3VlLnNldmVyaXR5ID09PSBcImVycm9yXCIpLFxuICAgICAgd2FybmluZ3M6IGNvdW50cy53YXJuaW5ncyArIE51bWJlcihpc3N1ZS5zZXZlcml0eSA9PT0gXCJ3YXJuaW5nXCIpLFxuICAgICAgaW5mb3M6IGNvdW50cy5pbmZvcyArIE51bWJlcihpc3N1ZS5zZXZlcml0eSA9PT0gXCJpbmZvXCIpLFxuICAgIH0pLFxuICAgIHsgZXJyb3JzOiAwLCB3YXJuaW5nczogMCwgaW5mb3M6IDAgfSxcbiAgKVxufVxuXG5mdW5jdGlvbiBzdW1tYXJpemVDb2RlcyhcbiAgaXNzdWVzOiBBcnJheTx7IGNvZGU6IHN0cmluZzsgc2V2ZXJpdHk6IFJlY292ZXJ5RGlhZ25vc3RpY3NTZXZlcml0eSB9Pixcbik6IFdvcmtzcGFjZVJlY292ZXJ5Q29kZVN1bW1hcnlbXSB7XG4gIGNvbnN0IG1hcCA9IG5ldyBNYXA8c3RyaW5nLCB7IGNvdW50OiBudW1iZXI7IHNldmVyaXR5OiBSZWNvdmVyeURpYWdub3N0aWNzU2V2ZXJpdHkgfT4oKVxuICBjb25zdCBzZXZlcml0eVJhbms6IFJlY29yZDxSZWNvdmVyeURpYWdub3N0aWNzU2V2ZXJpdHksIG51bWJlcj4gPSB7IGluZm86IDAsIHdhcm5pbmc6IDEsIGVycm9yOiAyIH1cblxuICBmb3IgKGNvbnN0IGlzc3VlIG9mIGlzc3Vlcykge1xuICAgIGNvbnN0IGN1cnJlbnQgPSBtYXAuZ2V0KGlzc3VlLmNvZGUpXG4gICAgaWYgKCFjdXJyZW50KSB7XG4gICAgICBtYXAuc2V0KGlzc3VlLmNvZGUsIHsgY291bnQ6IDEsIHNldmVyaXR5OiBpc3N1ZS5zZXZlcml0eSB9KVxuICAgICAgY29udGludWVcbiAgICB9XG5cbiAgICBtYXAuc2V0KGlzc3VlLmNvZGUsIHtcbiAgICAgIGNvdW50OiBjdXJyZW50LmNvdW50ICsgMSxcbiAgICAgIHNldmVyaXR5OiBzZXZlcml0eVJhbmtbaXNzdWUuc2V2ZXJpdHldID4gc2V2ZXJpdHlSYW5rW2N1cnJlbnQuc2V2ZXJpdHldID8gaXNzdWUuc2V2ZXJpdHkgOiBjdXJyZW50LnNldmVyaXR5LFxuICAgIH0pXG4gIH1cblxuICByZXR1cm4gWy4uLm1hcC5lbnRyaWVzKCldXG4gICAgLm1hcCgoW2NvZGUsIGRhdGFdKSA9PiAoe1xuICAgICAgY29kZSxcbiAgICAgIGNvdW50OiBkYXRhLmNvdW50LFxuICAgICAgbGFiZWw6IGh1bWFuaXplQ29kZShjb2RlKSxcbiAgICAgIHNldmVyaXR5OiBkYXRhLnNldmVyaXR5LFxuICAgIH0pKVxuICAgIC5zb3J0KChsZWZ0LCByaWdodCkgPT4gcmlnaHQuY291bnQgLSBsZWZ0LmNvdW50IHx8IGxlZnQuY29kZS5sb2NhbGVDb21wYXJlKHJpZ2h0LmNvZGUpKVxufVxuXG5mdW5jdGlvbiBzYW5pdGl6ZUlzc3VlRGlnZXN0KGlzc3VlOiBSZWNvdmVyeURpYWdub3N0aWNzQ2hpbGRJc3N1ZSk6IFdvcmtzcGFjZVJlY292ZXJ5SXNzdWVEaWdlc3Qge1xuICByZXR1cm4ge1xuICAgIGNvZGU6IGlzc3VlLmNvZGUsXG4gICAgc2V2ZXJpdHk6IGlzc3VlLnNldmVyaXR5LFxuICAgIHNjb3BlOiBpc3N1ZS5zY29wZSxcbiAgICBtZXNzYWdlOiBzYW5pdGl6ZVRleHQoaXNzdWUubWVzc2FnZSksXG4gICAgZmlsZTogaXNzdWUuZmlsZSxcbiAgICBzdWdnZXN0aW9uOiBpc3N1ZS5zdWdnZXN0aW9uID8gc2FuaXRpemVUZXh0KGlzc3VlLnN1Z2dlc3Rpb24pIDogdW5kZWZpbmVkLFxuICAgIHVuaXRJZDogaXNzdWUudW5pdElkLFxuICB9XG59XG5cbmZ1bmN0aW9uIGJ1aWxkQ29tbWFuZFN1Z2dlc3Rpb25zKFxuICBhY3RpdmVTY29wZTogc3RyaW5nIHwgbnVsbCxcbiAgcGhhc2U6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgdmFsaWRhdGlvbkNvdW50OiBudW1iZXIsXG4pOiBXb3Jrc3BhY2VSZWNvdmVyeUNvbW1hbmRTdWdnZXN0aW9uW10ge1xuICBjb25zdCBzdWdnZXN0aW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBXb3Jrc3BhY2VSZWNvdmVyeUNvbW1hbmRTdWdnZXN0aW9uPigpXG4gIGNvbnN0IGFkZCA9IChjb21tYW5kOiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcpID0+IHtcbiAgICBpZiAoIXN1Z2dlc3Rpb25zLmhhcyhjb21tYW5kKSkge1xuICAgICAgc3VnZ2VzdGlvbnMuc2V0KGNvbW1hbmQsIHsgY29tbWFuZCwgbGFiZWwgfSlcbiAgICB9XG4gIH1cblxuICBpZiAocGhhc2UgPT09IFwicGxhbm5pbmdcIikgYWRkKFwiL2dzZFwiLCBcIk9wZW4gR1NEIHBsYW5uaW5nXCIpXG4gIGlmIChwaGFzZSA9PT0gXCJleGVjdXRpbmdcIiB8fCBwaGFzZSA9PT0gXCJzdW1tYXJpemluZ1wiKSBhZGQoXCIvZ3NkIGF1dG9cIiwgXCJSZXN1bWUgR1NEIGF1dG8gbW9kZVwiKVxuICBpZiAoYWN0aXZlU2NvcGUpIGFkZChgL2dzZCBkb2N0b3IgJHthY3RpdmVTY29wZX1gLCBcIkluc3BlY3Qgc2NvcGVkIGRvY3RvciByZXBvcnRcIilcbiAgaWYgKGFjdGl2ZVNjb3BlKSBhZGQoYC9nc2QgZG9jdG9yIGZpeCAke2FjdGl2ZVNjb3BlfWAsIFwiQXBwbHkgc2NvcGVkIGRvY3RvciBmaXhlc1wiKVxuICBpZiAodmFsaWRhdGlvbkNvdW50ID4gMCAmJiBhY3RpdmVTY29wZSkgYWRkKGAvZ3NkIGRvY3RvciBhdWRpdCAke2FjdGl2ZVNjb3BlfWAsIFwiQXVkaXQgdmFsaWRhdGlvbiBkaWFnbm9zdGljc1wiKVxuICBhZGQoXCIvZ3NkIHN0YXR1c1wiLCBcIkNoZWNrIGN1cnJlbnQtcHJvamVjdCBzdGF0dXNcIilcblxuICByZXR1cm4gWy4uLnN1Z2dlc3Rpb25zLnZhbHVlcygpXVxufVxuXG5mdW5jdGlvbiBidWlsZEJyb3dzZXJBY3Rpb25zKG9wdGlvbnM6IHtcbiAgaGFzU2Vzc2lvbnM6IGJvb2xlYW5cbiAgcmV0cnlBY3RpdmU6IGJvb2xlYW5cbiAgYXV0b1JldHJ5RW5hYmxlZDogYm9vbGVhblxuICBicmlkZ2VGYWlsdXJlOiBib29sZWFuXG4gIGNvbXBhY3Rpb25BY3RpdmU6IGJvb2xlYW5cbiAgYXV0aEF0dGVudGlvbk5lZWRlZDogYm9vbGVhblxufSk6IFdvcmtzcGFjZVJlY292ZXJ5QnJvd3NlckFjdGlvbltdIHtcbiAgY29uc3QgYWN0aW9ucyA9IG5ldyBNYXA8V29ya3NwYWNlUmVjb3ZlcnlCcm93c2VyQWN0aW9uW1wiaWRcIl0sIFdvcmtzcGFjZVJlY292ZXJ5QnJvd3NlckFjdGlvbj4oKVxuICBjb25zdCBhZGQgPSAoYWN0aW9uOiBXb3Jrc3BhY2VSZWNvdmVyeUJyb3dzZXJBY3Rpb24pID0+IHtcbiAgICBhY3Rpb25zLnNldChhY3Rpb24uaWQsIGFjdGlvbilcbiAgfVxuXG4gIGFkZCh7XG4gICAgaWQ6IFwicmVmcmVzaF9kaWFnbm9zdGljc1wiLFxuICAgIGxhYmVsOiBcIlJlZnJlc2ggZGlhZ25vc3RpY3NcIixcbiAgICBkZXRhaWw6IFwiUmVsb2FkIHRoZSBvbi1kZW1hbmQgcmVjb3Zlcnkgcm91dGUgd2l0aG91dCByZWZyZXNoaW5nIHRoZSBlbnRpcmUgd29ya3NwYWNlLlwiLFxuICAgIGVtcGhhc2lzOiBcInByaW1hcnlcIixcbiAgfSlcbiAgYWRkKHtcbiAgICBpZDogXCJyZWZyZXNoX3dvcmtzcGFjZVwiLFxuICAgIGxhYmVsOiBcIlJlZnJlc2ggd29ya3NwYWNlXCIsXG4gICAgZGV0YWlsOiBcIlJ1biBvbmUgc29mdCB3b3Jrc3BhY2UgcmVmcmVzaCBzbyB0aGUgYnJvd3NlciByZS1zeW5jcyBib290LCBicmlkZ2UsIGFuZCBvbmJvYXJkaW5nIHN0YXRlLlwiLFxuICB9KVxuXG4gIGlmIChvcHRpb25zLnJldHJ5QWN0aXZlIHx8IG9wdGlvbnMuYXV0b1JldHJ5RW5hYmxlZCB8fCBvcHRpb25zLmJyaWRnZUZhaWx1cmUgfHwgb3B0aW9ucy5jb21wYWN0aW9uQWN0aXZlKSB7XG4gICAgYWRkKHtcbiAgICAgIGlkOiBcIm9wZW5fcmV0cnlfY29udHJvbHNcIixcbiAgICAgIGxhYmVsOiBcIk9wZW4gcmV0cnkgY29udHJvbHNcIixcbiAgICAgIGRldGFpbDogXCJJbnNwZWN0IG9yIGNoYW5nZSBsaXZlIHJldHJ5IGFuZCBjb21wYWN0aW9uIGNvbnRyb2xzIG9uIHRoZSBhdXRob3JpdGF0aXZlIGJyb3dzZXIgc3VyZmFjZS5cIixcbiAgICB9KVxuICB9XG5cbiAgaWYgKG9wdGlvbnMuaGFzU2Vzc2lvbnMpIHtcbiAgICBhZGQoe1xuICAgICAgaWQ6IFwib3Blbl9yZXN1bWVfY29udHJvbHNcIixcbiAgICAgIGxhYmVsOiBcIk9wZW4gcmVzdW1lIGNvbnRyb2xzXCIsXG4gICAgICBkZXRhaWw6IFwiU3dpdGNoIHRvIGFub3RoZXIgY3VycmVudC1wcm9qZWN0IHNlc3Npb24gaWYgcmVjb3Zlcnkgc2hvdWxkIGNvbnRpbnVlIGVsc2V3aGVyZS5cIixcbiAgICB9KVxuICB9XG5cbiAgaWYgKG9wdGlvbnMuYXV0aEF0dGVudGlvbk5lZWRlZCkge1xuICAgIGFkZCh7XG4gICAgICBpZDogXCJvcGVuX2F1dGhfY29udHJvbHNcIixcbiAgICAgIGxhYmVsOiBcIk9wZW4gYXV0aCBjb250cm9sc1wiLFxuICAgICAgZGV0YWlsOiBcIkluc3BlY3QgcHJvdmlkZXIgc2V0dXAgYW5kIGJyaWRnZSBhdXRoIHJlZnJlc2ggZmFpbHVyZXMgZnJvbSB0aGUgc2hhcmVkIGJyb3dzZXIgc3VyZmFjZS5cIixcbiAgICAgIGVtcGhhc2lzOiBcImRhbmdlclwiLFxuICAgIH0pXG4gIH1cblxuICByZXR1cm4gWy4uLmFjdGlvbnMudmFsdWVzKCldXG59XG5cbmZ1bmN0aW9uIHJlc29sdmVTdW1tYXJ5KG9wdGlvbnM6IHtcbiAgc3RhdHVzOiBXb3Jrc3BhY2VSZWNvdmVyeURpYWdub3N0aWNzW1wic3RhdHVzXCJdXG4gIHZhbGlkYXRpb25Db3VudDogbnVtYmVyXG4gIHZhbGlkYXRpb25FcnJvcnM6IG51bWJlclxuICBkb2N0b3JUb3RhbDogbnVtYmVyXG4gIGRvY3RvckVycm9yczogbnVtYmVyXG4gIHJldHJ5QXR0ZW1wdDogbnVtYmVyXG4gIHJldHJ5SW5Qcm9ncmVzczogYm9vbGVhblxuICBjb21wYWN0aW9uQWN0aXZlOiBib29sZWFuXG4gIGN1cnJlbnRVbml0SWQ6IHN0cmluZyB8IG51bGxcbiAgbGFzdEZhaWx1cmVQaGFzZTogc3RyaW5nIHwgbnVsbFxuICBicmlkZ2VGYWlsdXJlTWVzc2FnZTogc3RyaW5nIHwgbnVsbFxuICBhdXRoRmFpbHVyZU1lc3NhZ2U6IHN0cmluZyB8IG51bGxcbiAgaW50ZXJydXB0ZWRSdW5EZXRlY3RlZDogYm9vbGVhblxuICBpbnRlcnJ1cHRlZFJ1bkRldGFpbDogc3RyaW5nXG59KTogeyB0b25lOiBXb3Jrc3BhY2VSZWNvdmVyeVN1bW1hcnlUb25lOyBsYWJlbDogc3RyaW5nOyBkZXRhaWw6IHN0cmluZyB9IHtcbiAgaWYgKG9wdGlvbnMuYXV0aEZhaWx1cmVNZXNzYWdlKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHRvbmU6IFwiZGFuZ2VyXCIsXG4gICAgICBsYWJlbDogXCJCcmlkZ2UgYXV0aCByZWZyZXNoIGZhaWxlZFwiLFxuICAgICAgZGV0YWlsOiBvcHRpb25zLmF1dGhGYWlsdXJlTWVzc2FnZSxcbiAgICB9XG4gIH1cblxuICBpZiAob3B0aW9ucy5icmlkZ2VGYWlsdXJlTWVzc2FnZSkge1xuICAgIHJldHVybiB7XG4gICAgICB0b25lOiBcImRhbmdlclwiLFxuICAgICAgbGFiZWw6IG9wdGlvbnMubGFzdEZhaWx1cmVQaGFzZSA/IGBCcmlkZ2UgcmVjb3ZlcnkgZmFpbGVkIGR1cmluZyAke29wdGlvbnMubGFzdEZhaWx1cmVQaGFzZX1gIDogXCJCcmlkZ2UgcmVjb3ZlcnkgZmFpbGVkXCIsXG4gICAgICBkZXRhaWw6IG9wdGlvbnMuYnJpZGdlRmFpbHVyZU1lc3NhZ2UsXG4gICAgfVxuICB9XG5cbiAgaWYgKG9wdGlvbnMuZG9jdG9yRXJyb3JzID4gMCB8fCBvcHRpb25zLnZhbGlkYXRpb25FcnJvcnMgPiAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHRvbmU6IFwiZGFuZ2VyXCIsXG4gICAgICBsYWJlbDogYFJlY292ZXJ5IGJsb2NrZXJzIGRldGVjdGVkICgke29wdGlvbnMuZG9jdG9yRXJyb3JzICsgb3B0aW9ucy52YWxpZGF0aW9uRXJyb3JzfSlgLFxuICAgICAgZGV0YWlsOiBgRG9jdG9yIGFuZCB2YWxpZGF0aW9uIHN1cmZhY2VkIGJsb2NraW5nIGlzc3VlcyBmb3IgJHtvcHRpb25zLmN1cnJlbnRVbml0SWQgPz8gXCJ0aGUgY3VycmVudCBwcm9qZWN0XCJ9LmAsXG4gICAgfVxuICB9XG5cbiAgaWYgKG9wdGlvbnMucmV0cnlJblByb2dyZXNzKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHRvbmU6IFwid2FybmluZ1wiLFxuICAgICAgbGFiZWw6IGBSZXRyeSBhdHRlbXB0ICR7TWF0aC5tYXgoMSwgb3B0aW9ucy5yZXRyeUF0dGVtcHQpfSBpcyBhY3RpdmVgLFxuICAgICAgZGV0YWlsOiBcIlRoZSBicmlkZ2UgaXMgcmV0cnlpbmcgd29yayByaWdodCBub3c7IGluc3BlY3QgcmV0cnkgY29udHJvbHMgYmVmb3JlIGlzc3VpbmcgbW9yZSByZWNvdmVyeSBhY3Rpb25zLlwiLFxuICAgIH1cbiAgfVxuXG4gIGlmIChvcHRpb25zLmNvbXBhY3Rpb25BY3RpdmUpIHtcbiAgICByZXR1cm4ge1xuICAgICAgdG9uZTogXCJ3YXJuaW5nXCIsXG4gICAgICBsYWJlbDogXCJDb21wYWN0aW9uIGlzIGFjdGl2ZVwiLFxuICAgICAgZGV0YWlsOiBcIlRoZSBsaXZlIHNlc3Npb24gaXMgY29tcGFjdGluZyBjb250ZXh0IGJlZm9yZSB3b3JrIGNvbnRpbnVlcy5cIixcbiAgICB9XG4gIH1cblxuICBpZiAob3B0aW9ucy52YWxpZGF0aW9uQ291bnQgPiAwIHx8IG9wdGlvbnMuZG9jdG9yVG90YWwgPiAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHRvbmU6IFwid2FybmluZ1wiLFxuICAgICAgbGFiZWw6IGBSZWNvdmVyeSBkaWFnbm9zdGljcyBmb3VuZCAke29wdGlvbnMudmFsaWRhdGlvbkNvdW50ICsgb3B0aW9ucy5kb2N0b3JUb3RhbH0gYWN0aW9uYWJsZSBpc3N1ZSR7b3B0aW9ucy52YWxpZGF0aW9uQ291bnQgKyBvcHRpb25zLmRvY3RvclRvdGFsID09PSAxID8gXCJcIiA6IFwic1wifWAsXG4gICAgICBkZXRhaWw6IGBSZXZpZXcgdGhlIGRvY3RvciBhbmQgdmFsaWRhdGlvbiBzZWN0aW9ucyBiZWxvdyBiZWZvcmUgcmVzdW1pbmcgd29yayBvbiAke29wdGlvbnMuY3VycmVudFVuaXRJZCA/PyBcInRoZSBjdXJyZW50IHByb2plY3RcIn0uYCxcbiAgICB9XG4gIH1cblxuICBpZiAob3B0aW9ucy5pbnRlcnJ1cHRlZFJ1bkRldGVjdGVkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHRvbmU6IFwid2FybmluZ1wiLFxuICAgICAgbGFiZWw6IFwiSW50ZXJydXB0ZWQtcnVuIGV2aWRlbmNlIGlzIGF2YWlsYWJsZVwiLFxuICAgICAgZGV0YWlsOiBvcHRpb25zLmludGVycnVwdGVkUnVuRGV0YWlsLFxuICAgIH1cbiAgfVxuXG4gIGlmIChvcHRpb25zLnN0YXR1cyA9PT0gXCJ1bmF2YWlsYWJsZVwiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHRvbmU6IFwiaGVhbHRoeVwiLFxuICAgICAgbGFiZWw6IFwiUmVjb3ZlcnkgZGlhZ25vc3RpY3MgdW5hdmFpbGFibGVcIixcbiAgICAgIGRldGFpbDogXCJObyBjdXJyZW50LXByb2plY3QgcmVjb3ZlcnkgZXZpZGVuY2UgaGFzIGJlZW4gY2FwdHVyZWQgeWV0LiBTdGFydCBvciByZXN1bWUgYSBzZXNzaW9uIHRvIHBvcHVsYXRlIGRpYWdub3N0aWNzLlwiLFxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7XG4gICAgdG9uZTogXCJoZWFsdGh5XCIsXG4gICAgbGFiZWw6IFwiUmVjb3ZlcnkgZGlhZ25vc3RpY3MgaGVhbHRoeVwiLFxuICAgIGRldGFpbDogXCJObyBicmlkZ2UsIHZhbGlkYXRpb24sIGRvY3Rvciwgb3IgaW50ZXJydXB0ZWQtcnVuIHJlY292ZXJ5IGlzc3VlcyBhcmUgY3VycmVudGx5IGFjdGl2ZS5cIixcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNvbHZlVHNMb2FkZXJQYXRoKHBhY2thZ2VSb290OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihwYWNrYWdlUm9vdCwgXCJzcmNcIiwgXCJyZXNvdXJjZXNcIiwgXCJleHRlbnNpb25zXCIsIFwiZ3NkXCIsIFwidGVzdHNcIiwgXCJyZXNvbHZlLXRzLm1qc1wiKVxufVxuXG5hc3luYyBmdW5jdGlvbiBjb2xsZWN0UmVjb3ZlcnlEaWFnbm9zdGljc0NoaWxkUGF5bG9hZChcbiAgcGFja2FnZVJvb3Q6IHN0cmluZyxcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgc2NvcGU6IHN0cmluZyB8IG51bGwsXG4gIHVuaXQ6IHsgdHlwZTogc3RyaW5nOyBpZDogc3RyaW5nIH0gfCBudWxsLFxuICBzZXNzaW9uRmlsZTogc3RyaW5nIHwgbnVsbCxcbiAgb3B0aW9uczogUmVjb3ZlcnlEaWFnbm9zdGljc1NlcnZpY2VPcHRpb25zLFxuKTogUHJvbWlzZTxSZWNvdmVyeURpYWdub3N0aWNzQ2hpbGRQYXlsb2FkPiB7XG4gIGNvbnN0IGVudiA9IG9wdGlvbnMuZW52ID8/IHByb2Nlc3MuZW52XG4gIGNvbnN0IGNoZWNrRXhpc3RzID0gb3B0aW9ucy5leGlzdHNTeW5jID8/IGV4aXN0c1N5bmNcbiAgY29uc3QgcmVzb2x2ZVRzTG9hZGVyID0gcmVzb2x2ZVRzTG9hZGVyUGF0aChwYWNrYWdlUm9vdClcbiAgY29uc3QgZG9jdG9yUmVzb2x1dGlvbiA9IHJlc29sdmVTdWJwcm9jZXNzTW9kdWxlKHBhY2thZ2VSb290LCBcInJlc291cmNlcy9leHRlbnNpb25zL2dzZC9kb2N0b3IudHNcIiwgY2hlY2tFeGlzdHMpXG4gIGNvbnN0IGZvcmVuc2ljc1Jlc29sdXRpb24gPSByZXNvbHZlU3VicHJvY2Vzc01vZHVsZShwYWNrYWdlUm9vdCwgXCJyZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2Qvc2Vzc2lvbi1mb3JlbnNpY3MudHNcIiwgY2hlY2tFeGlzdHMpXG4gIGNvbnN0IGRvY3Rvck1vZHVsZVBhdGggPSBkb2N0b3JSZXNvbHV0aW9uLm1vZHVsZVBhdGhcbiAgY29uc3Qgc2Vzc2lvbkZvcmVuc2ljc01vZHVsZVBhdGggPSBmb3JlbnNpY3NSZXNvbHV0aW9uLm1vZHVsZVBhdGhcblxuICBpZiAoIWRvY3RvclJlc29sdXRpb24udXNlQ29tcGlsZWRKcyAmJiAoIWNoZWNrRXhpc3RzKHJlc29sdmVUc0xvYWRlcikgfHwgIWNoZWNrRXhpc3RzKGRvY3Rvck1vZHVsZVBhdGgpIHx8ICFjaGVja0V4aXN0cyhzZXNzaW9uRm9yZW5zaWNzTW9kdWxlUGF0aCkpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYHJlY292ZXJ5IGRpYWdub3N0aWNzIHByb3ZpZGVycyBub3QgZm91bmQ7IGNoZWNrZWQ9JHtyZXNvbHZlVHNMb2FkZXJ9LCR7ZG9jdG9yTW9kdWxlUGF0aH0sJHtzZXNzaW9uRm9yZW5zaWNzTW9kdWxlUGF0aH1gLFxuICAgIClcbiAgfVxuICBpZiAoZG9jdG9yUmVzb2x1dGlvbi51c2VDb21waWxlZEpzICYmICghY2hlY2tFeGlzdHMoZG9jdG9yTW9kdWxlUGF0aCkgfHwgIWNoZWNrRXhpc3RzKHNlc3Npb25Gb3JlbnNpY3NNb2R1bGVQYXRoKSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgcmVjb3ZlcnkgZGlhZ25vc3RpY3MgcHJvdmlkZXJzIG5vdCBmb3VuZDsgY2hlY2tlZD0ke2RvY3Rvck1vZHVsZVBhdGh9LCR7c2Vzc2lvbkZvcmVuc2ljc01vZHVsZVBhdGh9YCxcbiAgICApXG4gIH1cblxuICBjb25zdCBzY3JpcHQgPSBbXG4gICAgJ2NvbnN0IHsgcGF0aFRvRmlsZVVSTCB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTp1cmxcIik7JyxcbiAgICAnY29uc3QgZG9jdG9yID0gYXdhaXQgaW1wb3J0KHBhdGhUb0ZpbGVVUkwocHJvY2Vzcy5lbnYuR1NEX1JFQ09WRVJZX0RPQ1RPUl9NT0RVTEUpLmhyZWYpOycsXG4gICAgJ2NvbnN0IGZvcmVuc2ljcyA9IGF3YWl0IGltcG9ydChwYXRoVG9GaWxlVVJMKHByb2Nlc3MuZW52LkdTRF9SRUNPVkVSWV9GT1JFTlNJQ1NfTU9EVUxFKS5ocmVmKTsnLFxuICAgICdjb25zdCBiYXNlUGF0aCA9IHByb2Nlc3MuZW52LkdTRF9SRUNPVkVSWV9CQVNFOycsXG4gICAgJ2NvbnN0IHNjb3BlID0gcHJvY2Vzcy5lbnYuR1NEX1JFQ09WRVJZX1NDT1BFIHx8IHVuZGVmaW5lZDsnLFxuICAgICdjb25zdCB1bml0VHlwZSA9IHByb2Nlc3MuZW52LkdTRF9SRUNPVkVSWV9VTklUX1RZUEUgfHwgXCJleGVjdXRlLXByb2plY3RcIjsnLFxuICAgICdjb25zdCB1bml0SWQgPSBwcm9jZXNzLmVudi5HU0RfUkVDT1ZFUllfVU5JVF9JRCB8fCBcInByb2plY3RcIjsnLFxuICAgICdjb25zdCBzZXNzaW9uRmlsZSA9IHByb2Nlc3MuZW52LkdTRF9SRUNPVkVSWV9TRVNTSU9OX0ZJTEUgfHwgdW5kZWZpbmVkOycsXG4gICAgJ2NvbnN0IGFjdGl2aXR5RGlyID0gcHJvY2Vzcy5lbnYuR1NEX1JFQ09WRVJZX0FDVElWSVRZX0RJUiB8fCB1bmRlZmluZWQ7JyxcbiAgICAnY29uc3QgcmVwb3J0ID0gYXdhaXQgZG9jdG9yLnJ1bkdTRERvY3RvcihiYXNlUGF0aCwgeyBmaXg6IGZhbHNlLCBzY29wZSwgZml4TGV2ZWw6IFwidGFza1wiIH0pOycsXG4gICAgJ2NvbnN0IHN1bW1hcnkgPSBkb2N0b3Iuc3VtbWFyaXplRG9jdG9ySXNzdWVzKHJlcG9ydC5pc3N1ZXMpOycsXG4gICAgJ2NvbnN0IGJyaWVmaW5nID0gZm9yZW5zaWNzLnN5bnRoZXNpemVDcmFzaFJlY292ZXJ5KGJhc2VQYXRoLCB1bml0VHlwZSwgdW5pdElkLCBzZXNzaW9uRmlsZSwgYWN0aXZpdHlEaXIpOycsXG4gICAgJ2NvbnN0IHRyYWNlID0gYnJpZWZpbmc/LnRyYWNlOycsXG4gICAgJ2NvbnN0IGF2YWlsYWJsZSA9IEJvb2xlYW4oc2Vzc2lvbkZpbGUgfHwgdHJhY2U/LnRvb2xDYWxsQ291bnQgfHwgYnJpZWZpbmc/LmdpdENoYW5nZXMpOycsXG4gICAgJ2NvbnN0IGRldGVjdGVkID0gQm9vbGVhbigodHJhY2U/LnRvb2xDYWxsQ291bnQgPz8gMCkgPiAwIHx8ICh0cmFjZT8uZXJyb3JzPy5sZW5ndGggPz8gMCkgPiAwIHx8ICh0cmFjZT8uY29tbWFuZHNSdW4/Lmxlbmd0aCA/PyAwKSA+IDAgfHwgKHRyYWNlPy5maWxlc1dyaXR0ZW4/Lmxlbmd0aCA/PyAwKSA+IDAgfHwgYnJpZWZpbmc/LmdpdENoYW5nZXMpOycsXG4gICAgJ2NvbnN0IGludGVycnVwdGVkUnVuID0gYXZhaWxhYmxlJyxcbiAgICAnICA/IGRldGVjdGVkJyxcbiAgICAnICAgID8geycsXG4gICAgJyAgICAgICAgYXZhaWxhYmxlOiB0cnVlLCcsXG4gICAgJyAgICAgICAgZGV0ZWN0ZWQ6IHRydWUsJyxcbiAgICAnICAgICAgICBsYWJlbDogXCJJbnRlcnJ1cHRlZC1ydW4gcmVjb3ZlcnkgYXZhaWxhYmxlXCIsJyxcbiAgICAnICAgICAgICBkZXRhaWw6IFwiUmVjZW50IHNlc3Npb24gZm9yZW5zaWNzIGNhcHR1cmVkIHVuZmluaXNoZWQgd29yayBvciBlcnJvcnMgdGhhdCBtYXkgbmVlZCByZXN1bWUgb3IgcmV0cnkgZm9sbG93LXVwLlwiLCcsXG4gICAgJyAgICAgICAgdW5pdDogeyB0eXBlOiBicmllZmluZz8udW5pdFR5cGUgPz8gdW5pdFR5cGUsIGlkOiBicmllZmluZz8udW5pdElkID8/IHVuaXRJZCB9LCcsXG4gICAgJyAgICAgICAgY291bnRzOiB7JyxcbiAgICAnICAgICAgICAgIHRvb2xDYWxsczogdHJhY2U/LnRvb2xDYWxsQ291bnQgPz8gMCwnLFxuICAgICcgICAgICAgICAgZmlsZXNXcml0dGVuOiB0cmFjZT8uZmlsZXNXcml0dGVuPy5sZW5ndGggPz8gMCwnLFxuICAgICcgICAgICAgICAgY29tbWFuZHNSdW46IHRyYWNlPy5jb21tYW5kc1J1bj8ubGVuZ3RoID8/IDAsJyxcbiAgICAnICAgICAgICAgIGVycm9yczogdHJhY2U/LmVycm9ycz8ubGVuZ3RoID8/IDAsJyxcbiAgICAnICAgICAgICB9LCcsXG4gICAgJyAgICAgICAgZ2l0Q2hhbmdlc0RldGVjdGVkOiBCb29sZWFuKGJyaWVmaW5nPy5naXRDaGFuZ2VzKSwnLFxuICAgICcgICAgICAgIGxhc3RFcnJvcjogdHJhY2U/LmVycm9ycz8uYXQoLTEpID8/IG51bGwsJyxcbiAgICAnICAgICAgfScsXG4gICAgJyAgICA6IHsnLFxuICAgICcgICAgICAgIGF2YWlsYWJsZTogdHJ1ZSwnLFxuICAgICcgICAgICAgIGRldGVjdGVkOiBmYWxzZSwnLFxuICAgICcgICAgICAgIGxhYmVsOiBcIlNlc3Npb24gZm9yZW5zaWNzIGF2YWlsYWJsZVwiLCcsXG4gICAgJyAgICAgICAgZGV0YWlsOiBcIkEgY3VycmVudC1wcm9qZWN0IHNlc3Npb24gd2FzIGluc3BlY3RlZCwgYnV0IGl0IGRpZCBub3Qgc2hvdyB1bmZpbmlzaGVkIHRvb2wgb3IgZXJyb3IgYWN0aXZpdHkuXCIsJyxcbiAgICAnICAgICAgICB1bml0OiB7IHR5cGU6IGJyaWVmaW5nPy51bml0VHlwZSA/PyB1bml0VHlwZSwgaWQ6IGJyaWVmaW5nPy51bml0SWQgPz8gdW5pdElkIH0sJyxcbiAgICAnICAgICAgICBjb3VudHM6IHsnLFxuICAgICcgICAgICAgICAgdG9vbENhbGxzOiB0cmFjZT8udG9vbENhbGxDb3VudCA/PyAwLCcsXG4gICAgJyAgICAgICAgICBmaWxlc1dyaXR0ZW46IHRyYWNlPy5maWxlc1dyaXR0ZW4/Lmxlbmd0aCA/PyAwLCcsXG4gICAgJyAgICAgICAgICBjb21tYW5kc1J1bjogdHJhY2U/LmNvbW1hbmRzUnVuPy5sZW5ndGggPz8gMCwnLFxuICAgICcgICAgICAgICAgZXJyb3JzOiB0cmFjZT8uZXJyb3JzPy5sZW5ndGggPz8gMCwnLFxuICAgICcgICAgICAgIH0sJyxcbiAgICAnICAgICAgICBnaXRDaGFuZ2VzRGV0ZWN0ZWQ6IEJvb2xlYW4oYnJpZWZpbmc/LmdpdENoYW5nZXMpLCcsXG4gICAgJyAgICAgICAgbGFzdEVycm9yOiB0cmFjZT8uZXJyb3JzPy5hdCgtMSkgPz8gbnVsbCwnLFxuICAgICcgICAgICB9JyxcbiAgICAnICA6IHsnLFxuICAgICcgICAgICBhdmFpbGFibGU6IGZhbHNlLCcsXG4gICAgJyAgICAgIGRldGVjdGVkOiBmYWxzZSwnLFxuICAgICcgICAgICBsYWJlbDogXCJObyBpbnRlcnJ1cHRlZC1ydW4gZXZpZGVuY2VcIiwnLFxuICAgICcgICAgICBkZXRhaWw6IFwiTm8gY3VycmVudC1wcm9qZWN0IHNlc3Npb24gb3IgYWN0aXZpdHkgbG9nIGlzIGF2YWlsYWJsZSBmb3IgaW50ZXJydXB0ZWQtcnVuIGZvcmVuc2ljcyB5ZXQuXCIsJyxcbiAgICAnICAgICAgdW5pdDogbnVsbCwnLFxuICAgICcgICAgICBjb3VudHM6IHsgdG9vbENhbGxzOiAwLCBmaWxlc1dyaXR0ZW46IDAsIGNvbW1hbmRzUnVuOiAwLCBlcnJvcnM6IDAgfSwnLFxuICAgICcgICAgICBnaXRDaGFuZ2VzRGV0ZWN0ZWQ6IGZhbHNlLCcsXG4gICAgJyAgICAgIGxhc3RFcnJvcjogbnVsbCwnLFxuICAgICcgICAgfTsnLFxuICAgICdwcm9jZXNzLnN0ZG91dC53cml0ZShKU09OLnN0cmluZ2lmeSh7JyxcbiAgICAnICBkb2N0b3I6IHsnLFxuICAgICcgICAgc2NvcGU6IHNjb3BlID8/IG51bGwsJyxcbiAgICAnICAgIHRvdGFsOiBzdW1tYXJ5LnRvdGFsLCcsXG4gICAgJyAgICBlcnJvcnM6IHN1bW1hcnkuZXJyb3JzLCcsXG4gICAgJyAgICB3YXJuaW5nczogc3VtbWFyeS53YXJuaW5ncywnLFxuICAgICcgICAgaW5mb3M6IHN1bW1hcnkuaW5mb3MsJyxcbiAgICAnICAgIGZpeGFibGU6IHN1bW1hcnkuZml4YWJsZSwnLFxuICAgICcgICAgY29kZXM6IHN1bW1hcnkuYnlDb2RlLCcsXG4gICAgJyAgICB0b3BJc3N1ZXM6IHJlcG9ydC5pc3N1ZXMuc2xpY2UoMCwgNikubWFwKChpc3N1ZSkgPT4gKHsnLFxuICAgICcgICAgICBjb2RlOiBpc3N1ZS5jb2RlLCcsXG4gICAgJyAgICAgIHNldmVyaXR5OiBpc3N1ZS5zZXZlcml0eSwnLFxuICAgICcgICAgICBzY29wZTogaXNzdWUuc2NvcGUsJyxcbiAgICAnICAgICAgbWVzc2FnZTogaXNzdWUubWVzc2FnZSwnLFxuICAgICcgICAgICBmaWxlOiBpc3N1ZS5maWxlLCcsXG4gICAgJyAgICAgIHVuaXRJZDogaXNzdWUudW5pdElkLCcsXG4gICAgJyAgICB9KSksJyxcbiAgICAnICB9LCcsXG4gICAgJyAgaW50ZXJydXB0ZWRSdW4sJyxcbiAgICAnfSkpOycsXG4gIF0uam9pbihcIiBcIilcblxuICBjb25zdCBwcmVmaXhBcmdzID0gYnVpbGRTdWJwcm9jZXNzUHJlZml4QXJncyhwYWNrYWdlUm9vdCwgZG9jdG9yUmVzb2x1dGlvbiwgcGF0aFRvRmlsZVVSTChyZXNvbHZlVHNMb2FkZXIpLmhyZWYpXG5cbiAgcmV0dXJuIGF3YWl0IG5ldyBQcm9taXNlPFJlY292ZXJ5RGlhZ25vc3RpY3NDaGlsZFBheWxvYWQ+KChyZXNvbHZlUmVzdWx0LCByZWplY3QpID0+IHtcbiAgICBleGVjRmlsZShcbiAgICAgIG9wdGlvbnMuZXhlY1BhdGggPz8gcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgIFtcbiAgICAgICAgLi4ucHJlZml4QXJncyxcbiAgICAgICAgXCItLWV2YWxcIixcbiAgICAgICAgc2NyaXB0LFxuICAgICAgXSxcbiAgICAgIHtcbiAgICAgICAgY3dkOiBwYWNrYWdlUm9vdCxcbiAgICAgICAgZW52OiB7XG4gICAgICAgICAgLi4uZW52LFxuICAgICAgICAgIEdTRF9SRUNPVkVSWV9CQVNFOiBiYXNlUGF0aCxcbiAgICAgICAgICBHU0RfUkVDT1ZFUllfU0NPUEU6IHNjb3BlID8/IFwiXCIsXG4gICAgICAgICAgR1NEX1JFQ09WRVJZX1VOSVRfVFlQRTogdW5pdD8udHlwZSA/PyBcImV4ZWN1dGUtcHJvamVjdFwiLFxuICAgICAgICAgIEdTRF9SRUNPVkVSWV9VTklUX0lEOiB1bml0Py5pZCA/PyBcInByb2plY3RcIixcbiAgICAgICAgICBHU0RfUkVDT1ZFUllfU0VTU0lPTl9GSUxFOiBzZXNzaW9uRmlsZSA/PyBcIlwiLFxuICAgICAgICAgIEdTRF9SRUNPVkVSWV9BQ1RJVklUWV9ESVI6IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcImFjdGl2aXR5XCIpLFxuICAgICAgICAgIEdTRF9SRUNPVkVSWV9ET0NUT1JfTU9EVUxFOiBkb2N0b3JNb2R1bGVQYXRoLFxuICAgICAgICAgIEdTRF9SRUNPVkVSWV9GT1JFTlNJQ1NfTU9EVUxFOiBzZXNzaW9uRm9yZW5zaWNzTW9kdWxlUGF0aCxcbiAgICAgICAgfSxcbiAgICAgICAgbWF4QnVmZmVyOiBSRUNPVkVSWV9ESUFHTk9TVElDU19NQVhfQlVGRkVSLFxuICAgICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICAoZXJyb3IsIHN0ZG91dCwgc3RkZXJyKSA9PiB7XG4gICAgICAgIGlmIChlcnJvcikge1xuICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoYHJlY292ZXJ5IGRpYWdub3N0aWNzIHN1YnByb2Nlc3MgZmFpbGVkOiAke3N0ZGVyciB8fCBlcnJvci5tZXNzYWdlfWApKVxuICAgICAgICAgIHJldHVyblxuICAgICAgICB9XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXNvbHZlUmVzdWx0KEpTT04ucGFyc2Uoc3Rkb3V0KSBhcyBSZWNvdmVyeURpYWdub3N0aWNzQ2hpbGRQYXlsb2FkKVxuICAgICAgICB9IGNhdGNoIChwYXJzZUVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KFxuICAgICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgICBgcmVjb3ZlcnkgZGlhZ25vc3RpY3Mgc3VicHJvY2VzcyByZXR1cm5lZCBpbnZhbGlkIEpTT046ICR7cGFyc2VFcnJvciBpbnN0YW5jZW9mIEVycm9yID8gcGFyc2VFcnJvci5tZXNzYWdlIDogU3RyaW5nKHBhcnNlRXJyb3IpfWAsXG4gICAgICAgICAgICApLFxuICAgICAgICAgIClcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICApXG4gIH0pXG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb2xsZWN0Q3VycmVudFByb2plY3RSZWNvdmVyeURpYWdub3N0aWNzKFxuICBvcHRpb25zOiBSZWNvdmVyeURpYWdub3N0aWNzU2VydmljZU9wdGlvbnMgPSB7fSxcbiAgcHJvamVjdEN3ZE92ZXJyaWRlPzogc3RyaW5nLFxuKTogUHJvbWlzZTxXb3Jrc3BhY2VSZWNvdmVyeURpYWdub3N0aWNzPiB7XG4gIGNvbnN0IGVudiA9IG9wdGlvbnMuZW52ID8/IHByb2Nlc3MuZW52XG4gIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnKG9wdGlvbnMuZW52LCBwcm9qZWN0Q3dkT3ZlcnJpZGUpXG4gIGNvbnN0IFt7IGJyaWRnZTogYnJpZGdlU25hcHNob3QsIHdvcmtzcGFjZSwgcmVzdW1hYmxlU2Vzc2lvbnM6IHJlc3VtYWJsZVNlc3Npb25zUmF3IH0sIG9uYm9hcmRpbmddID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgIGNvbGxlY3RTZWxlY3RpdmVMaXZlU3RhdGVQYXlsb2FkKFtcIndvcmtzcGFjZVwiLCBcInJlc3VtYWJsZV9zZXNzaW9uc1wiXSwgcHJvamVjdEN3ZE92ZXJyaWRlKSxcbiAgICBjb2xsZWN0Q3VycmVudFByb2plY3RPbmJvYXJkaW5nU3RhdGUocHJvamVjdEN3ZE92ZXJyaWRlKSxcbiAgXSlcbiAgY29uc3QgcmVzdW1hYmxlU2Vzc2lvbnMgPSByZXN1bWFibGVTZXNzaW9uc1JhdyA/PyBbXVxuXG4gIGNvbnN0IGFjdGl2ZVNjb3BlID0gYWN0aXZlU2NvcGVGcm9tV29ya3NwYWNlKHdvcmtzcGFjZSlcbiAgY29uc3QgdW5pdCA9IHJlY292ZXJ5VW5pdEZyb21Xb3Jrc3BhY2Uod29ya3NwYWNlKVxuICBjb25zdCBzZXNzaW9uRmlsZSA9IHNlbGVjdFJlY292ZXJ5U2Vzc2lvbkZpbGUoYnJpZGdlU25hcHNob3QuYWN0aXZlU2Vzc2lvbkZpbGUsIHJlc3VtYWJsZVNlc3Npb25zKVxuICBjb25zdCByZWNvdmVyeVNlc3Npb25JZCA9IHNlbGVjdFJlY292ZXJ5U2Vzc2lvbklkKGJyaWRnZVNuYXBzaG90LmFjdGl2ZVNlc3Npb25JZCwgc2Vzc2lvbkZpbGUsIHJlc3VtYWJsZVNlc3Npb25zKVxuICBjb25zdCByZWNvdmVyeUNoaWxkID0gYXdhaXQgY29sbGVjdFJlY292ZXJ5RGlhZ25vc3RpY3NDaGlsZFBheWxvYWQoXG4gICAgY29uZmlnLnBhY2thZ2VSb290LFxuICAgIGNvbmZpZy5wcm9qZWN0Q3dkLFxuICAgIGFjdGl2ZVNjb3BlLFxuICAgIHVuaXQsXG4gICAgc2Vzc2lvbkZpbGUsXG4gICAgb3B0aW9ucyxcbiAgKVxuXG4gIGNvbnN0IHZhbGlkYXRpb25Jc3N1ZXMgPSAod29ya3NwYWNlPy52YWxpZGF0aW9uSXNzdWVzID8/IFtdKS5tYXAoKGlzc3VlKSA9PiB7XG4gICAgY29uc3QgdHlwZWRJc3N1ZSA9IGlzc3VlIGFzIHtcbiAgICAgIHJ1bGVJZD86IHN0cmluZ1xuICAgICAgc2V2ZXJpdHk/OiBSZWNvdmVyeURpYWdub3N0aWNzU2V2ZXJpdHlcbiAgICAgIHNjb3BlPzogc3RyaW5nXG4gICAgICBtZXNzYWdlPzogc3RyaW5nXG4gICAgICBmaWxlPzogc3RyaW5nXG4gICAgICBzdWdnZXN0aW9uPzogc3RyaW5nXG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBjb2RlOiB0eXBlZElzc3VlLnJ1bGVJZCA/PyBcInVua25vd25fdmFsaWRhdGlvbl9pc3N1ZVwiLFxuICAgICAgc2V2ZXJpdHk6ICh0eXBlZElzc3VlLnNldmVyaXR5ID8/IFwid2FybmluZ1wiKSBhcyBSZWNvdmVyeURpYWdub3N0aWNzU2V2ZXJpdHksXG4gICAgICBzY29wZTogdHlwZWRJc3N1ZS5zY29wZSA/PyBcIndvcmtzcGFjZVwiLFxuICAgICAgbWVzc2FnZTogc2FuaXRpemVUZXh0KHR5cGVkSXNzdWUubWVzc2FnZSA/PyBcIlZhbGlkYXRpb24gaXNzdWVcIiksXG4gICAgICBmaWxlOiB0eXBlZElzc3VlLmZpbGUsXG4gICAgICBzdWdnZXN0aW9uOiB0eXBlZElzc3VlLnN1Z2dlc3Rpb24gPyBzYW5pdGl6ZVRleHQodHlwZWRJc3N1ZS5zdWdnZXN0aW9uKSA6IHVuZGVmaW5lZCxcbiAgICB9IHNhdGlzZmllcyBXb3Jrc3BhY2VSZWNvdmVyeUlzc3VlRGlnZXN0XG4gIH0pXG4gIGNvbnN0IHZhbGlkYXRpb25Db3VudHMgPSBzdW1tYXJpemVTZXZlcml0eUNvdW50cyh2YWxpZGF0aW9uSXNzdWVzKVxuICBjb25zdCB2YWxpZGF0aW9uQ29kZXMgPSBzdW1tYXJpemVDb2Rlcyh2YWxpZGF0aW9uSXNzdWVzKVxuXG4gIGNvbnN0IGRvY3RvclRvcElzc3VlcyA9IHJlY292ZXJ5Q2hpbGQuZG9jdG9yLnRvcElzc3Vlcy5tYXAoc2FuaXRpemVJc3N1ZURpZ2VzdClcbiAgY29uc3QgaW50ZXJydXB0ZWRSdW4gPSB7XG4gICAgLi4ucmVjb3ZlcnlDaGlsZC5pbnRlcnJ1cHRlZFJ1bixcbiAgICBsYWJlbDogc2FuaXRpemVUZXh0KHJlY292ZXJ5Q2hpbGQuaW50ZXJydXB0ZWRSdW4ubGFiZWwpLFxuICAgIGRldGFpbDogc2FuaXRpemVUZXh0KHJlY292ZXJ5Q2hpbGQuaW50ZXJydXB0ZWRSdW4uZGV0YWlsKSxcbiAgICBsYXN0RXJyb3I6IHJlY292ZXJ5Q2hpbGQuaW50ZXJydXB0ZWRSdW4ubGFzdEVycm9yID8gc2FuaXRpemVUZXh0KHJlY292ZXJ5Q2hpbGQuaW50ZXJydXB0ZWRSdW4ubGFzdEVycm9yKSA6IG51bGwsXG4gIH1cblxuICBjb25zdCBicmlkZ2VGYWlsdXJlID0gYnJpZGdlU25hcHNob3QubGFzdEVycm9yXG4gICAgPyB7XG4gICAgICAgIG1lc3NhZ2U6IHNhbml0aXplVGV4dChicmlkZ2VTbmFwc2hvdC5sYXN0RXJyb3IubWVzc2FnZSksXG4gICAgICAgIHBoYXNlOiBicmlkZ2VTbmFwc2hvdC5sYXN0RXJyb3IucGhhc2UsXG4gICAgICAgIGF0OiBicmlkZ2VTbmFwc2hvdC5sYXN0RXJyb3IuYXQsXG4gICAgICAgIGNvbW1hbmRUeXBlOiBicmlkZ2VTbmFwc2hvdC5sYXN0RXJyb3IuY29tbWFuZFR5cGUgPz8gbnVsbCxcbiAgICAgICAgYWZ0ZXJTZXNzaW9uQXR0YWNobWVudDogYnJpZGdlU25hcHNob3QubGFzdEVycm9yLmFmdGVyU2Vzc2lvbkF0dGFjaG1lbnQsXG4gICAgICB9XG4gICAgOiBudWxsXG5cbiAgY29uc3QgYXV0aFJlZnJlc2hQaGFzZSA9IG9uYm9hcmRpbmcuYnJpZGdlQXV0aFJlZnJlc2gucGhhc2VcbiAgY29uc3QgYXV0aFJlZnJlc2hFcnJvciA9IG9uYm9hcmRpbmcuYnJpZGdlQXV0aFJlZnJlc2guZXJyb3IgPyBzYW5pdGl6ZVRleHQob25ib2FyZGluZy5icmlkZ2VBdXRoUmVmcmVzaC5lcnJvcikgOiBudWxsXG4gIGNvbnN0IGF1dGhSZWZyZXNoTGFiZWwgPVxuICAgIGF1dGhSZWZyZXNoUGhhc2UgPT09IFwiZmFpbGVkXCJcbiAgICAgID8gXCJCcmlkZ2UgYXV0aCByZWZyZXNoIGZhaWxlZFwiXG4gICAgICA6IGF1dGhSZWZyZXNoUGhhc2UgPT09IFwicGVuZGluZ1wiXG4gICAgICAgID8gXCJCcmlkZ2UgYXV0aCByZWZyZXNoIHBlbmRpbmdcIlxuICAgICAgICA6IGF1dGhSZWZyZXNoUGhhc2UgPT09IFwic3VjY2VlZGVkXCJcbiAgICAgICAgICA/IFwiQnJpZGdlIGF1dGggcmVmcmVzaCBzdWNjZWVkZWRcIlxuICAgICAgICAgIDogXCJCcmlkZ2UgYXV0aCByZWZyZXNoIGlkbGVcIlxuXG4gIGNvbnN0IHN0YXR1czogV29ya3NwYWNlUmVjb3ZlcnlEaWFnbm9zdGljc1tcInN0YXR1c1wiXSA9XG4gICAgYnJpZGdlRmFpbHVyZSB8fFxuICAgIGF1dGhSZWZyZXNoUGhhc2UgPT09IFwiZmFpbGVkXCIgfHxcbiAgICB2YWxpZGF0aW9uSXNzdWVzLmxlbmd0aCA+IDAgfHxcbiAgICByZWNvdmVyeUNoaWxkLmRvY3Rvci50b3RhbCA+IDAgfHxcbiAgICBpbnRlcnJ1cHRlZFJ1bi5hdmFpbGFibGUgfHxcbiAgICByZXN1bWFibGVTZXNzaW9ucy5sZW5ndGggPiAwIHx8XG4gICAgQm9vbGVhbihicmlkZ2VTbmFwc2hvdC5zZXNzaW9uU3RhdGU/LnJldHJ5SW5Qcm9ncmVzcykgfHxcbiAgICBCb29sZWFuKGJyaWRnZVNuYXBzaG90LnNlc3Npb25TdGF0ZT8uaXNDb21wYWN0aW5nKVxuICAgICAgPyBcInJlYWR5XCJcbiAgICAgIDogXCJ1bmF2YWlsYWJsZVwiXG5cbiAgY29uc3QgY3VycmVudFVuaXRJZCA9IHVuaXQ/LmlkID8/IGFjdGl2ZVNjb3BlXG4gIGNvbnN0IHN1bW1hcnkgPSByZXNvbHZlU3VtbWFyeSh7XG4gICAgc3RhdHVzLFxuICAgIHZhbGlkYXRpb25Db3VudDogdmFsaWRhdGlvbklzc3Vlcy5sZW5ndGgsXG4gICAgdmFsaWRhdGlvbkVycm9yczogdmFsaWRhdGlvbkNvdW50cy5lcnJvcnMsXG4gICAgZG9jdG9yVG90YWw6IHJlY292ZXJ5Q2hpbGQuZG9jdG9yLnRvdGFsLFxuICAgIGRvY3RvckVycm9yczogcmVjb3ZlcnlDaGlsZC5kb2N0b3IuZXJyb3JzLFxuICAgIHJldHJ5QXR0ZW1wdDogYnJpZGdlU25hcHNob3Quc2Vzc2lvblN0YXRlPy5yZXRyeUF0dGVtcHQgPz8gMCxcbiAgICByZXRyeUluUHJvZ3Jlc3M6IEJvb2xlYW4oYnJpZGdlU25hcHNob3Quc2Vzc2lvblN0YXRlPy5yZXRyeUluUHJvZ3Jlc3MpLFxuICAgIGNvbXBhY3Rpb25BY3RpdmU6IEJvb2xlYW4oYnJpZGdlU25hcHNob3Quc2Vzc2lvblN0YXRlPy5pc0NvbXBhY3RpbmcpLFxuICAgIGN1cnJlbnRVbml0SWQ6IGN1cnJlbnRVbml0SWQgPz8gbnVsbCxcbiAgICBsYXN0RmFpbHVyZVBoYXNlOiBhdXRoUmVmcmVzaFBoYXNlID09PSBcImZhaWxlZFwiID8gXCJicmlkZ2VfYXV0aF9yZWZyZXNoXCIgOiBicmlkZ2VGYWlsdXJlPy5waGFzZSA/PyBudWxsLFxuICAgIGJyaWRnZUZhaWx1cmVNZXNzYWdlOiBicmlkZ2VGYWlsdXJlPy5tZXNzYWdlID8/IG51bGwsXG4gICAgYXV0aEZhaWx1cmVNZXNzYWdlOiBhdXRoUmVmcmVzaFBoYXNlID09PSBcImZhaWxlZFwiID8gYXV0aFJlZnJlc2hFcnJvciA6IG51bGwsXG4gICAgaW50ZXJydXB0ZWRSdW5EZXRlY3RlZDogaW50ZXJydXB0ZWRSdW4uZGV0ZWN0ZWQsXG4gICAgaW50ZXJydXB0ZWRSdW5EZXRhaWw6IGludGVycnVwdGVkUnVuLmRldGFpbCxcbiAgfSlcblxuICByZXR1cm4ge1xuICAgIHN0YXR1cyxcbiAgICBsb2FkZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIHByb2plY3Q6IHtcbiAgICAgIGN3ZDogY29uZmlnLnByb2plY3RDd2QsXG4gICAgICBhY3RpdmVTY29wZSxcbiAgICAgIGFjdGl2ZVNlc3Npb25QYXRoOiBzZXNzaW9uRmlsZSxcbiAgICAgIGFjdGl2ZVNlc3Npb25JZDogcmVjb3ZlcnlTZXNzaW9uSWQsXG4gICAgfSxcbiAgICBzdW1tYXJ5OiB7XG4gICAgICB0b25lOiBzdW1tYXJ5LnRvbmUsXG4gICAgICBsYWJlbDogc3VtbWFyeS5sYWJlbCxcbiAgICAgIGRldGFpbDogc3VtbWFyeS5kZXRhaWwsXG4gICAgICB2YWxpZGF0aW9uQ291bnQ6IHZhbGlkYXRpb25Jc3N1ZXMubGVuZ3RoLFxuICAgICAgZG9jdG9ySXNzdWVDb3VudDogcmVjb3ZlcnlDaGlsZC5kb2N0b3IudG90YWwsXG4gICAgICBsYXN0RmFpbHVyZVBoYXNlOiBhdXRoUmVmcmVzaFBoYXNlID09PSBcImZhaWxlZFwiID8gXCJicmlkZ2VfYXV0aF9yZWZyZXNoXCIgOiBicmlkZ2VGYWlsdXJlPy5waGFzZSA/PyBudWxsLFxuICAgICAgY3VycmVudFVuaXRJZDogY3VycmVudFVuaXRJZCA/PyBudWxsLFxuICAgICAgcmV0cnlBdHRlbXB0OiBicmlkZ2VTbmFwc2hvdC5zZXNzaW9uU3RhdGU/LnJldHJ5QXR0ZW1wdCA/PyAwLFxuICAgICAgcmV0cnlJblByb2dyZXNzOiBCb29sZWFuKGJyaWRnZVNuYXBzaG90LnNlc3Npb25TdGF0ZT8ucmV0cnlJblByb2dyZXNzKSxcbiAgICAgIGNvbXBhY3Rpb25BY3RpdmU6IEJvb2xlYW4oYnJpZGdlU25hcHNob3Quc2Vzc2lvblN0YXRlPy5pc0NvbXBhY3RpbmcpLFxuICAgIH0sXG4gICAgYnJpZGdlOiB7XG4gICAgICBwaGFzZTogYnJpZGdlU25hcHNob3QucGhhc2UsXG4gICAgICByZXRyeToge1xuICAgICAgICBlbmFibGVkOiBCb29sZWFuKGJyaWRnZVNuYXBzaG90LnNlc3Npb25TdGF0ZT8uYXV0b1JldHJ5RW5hYmxlZCksXG4gICAgICAgIGluUHJvZ3Jlc3M6IEJvb2xlYW4oYnJpZGdlU25hcHNob3Quc2Vzc2lvblN0YXRlPy5yZXRyeUluUHJvZ3Jlc3MpLFxuICAgICAgICBhdHRlbXB0OiBicmlkZ2VTbmFwc2hvdC5zZXNzaW9uU3RhdGU/LnJldHJ5QXR0ZW1wdCA/PyAwLFxuICAgICAgICBsYWJlbDogYnJpZGdlU25hcHNob3Quc2Vzc2lvblN0YXRlPy5yZXRyeUluUHJvZ3Jlc3NcbiAgICAgICAgICA/IGBBdHRlbXB0ICR7TWF0aC5tYXgoMSwgYnJpZGdlU25hcHNob3Quc2Vzc2lvblN0YXRlPy5yZXRyeUF0dGVtcHQgPz8gMCl9YFxuICAgICAgICAgIDogYnJpZGdlU25hcHNob3Quc2Vzc2lvblN0YXRlPy5hdXRvUmV0cnlFbmFibGVkXG4gICAgICAgICAgICA/IFwiRW5hYmxlZFwiXG4gICAgICAgICAgICA6IFwiRGlzYWJsZWRcIixcbiAgICAgIH0sXG4gICAgICBjb21wYWN0aW9uOiB7XG4gICAgICAgIGFjdGl2ZTogQm9vbGVhbihicmlkZ2VTbmFwc2hvdC5zZXNzaW9uU3RhdGU/LmlzQ29tcGFjdGluZyksXG4gICAgICAgIGxhYmVsOiBicmlkZ2VTbmFwc2hvdC5zZXNzaW9uU3RhdGU/LmlzQ29tcGFjdGluZyA/IFwiQ29tcGFjdGlvbiBhY3RpdmVcIiA6IFwiQ29tcGFjdGlvbiBpZGxlXCIsXG4gICAgICB9LFxuICAgICAgbGFzdEZhaWx1cmU6IGJyaWRnZUZhaWx1cmUsXG4gICAgICBhdXRoUmVmcmVzaDoge1xuICAgICAgICBwaGFzZTogYXV0aFJlZnJlc2hQaGFzZSxcbiAgICAgICAgZXJyb3I6IGF1dGhSZWZyZXNoRXJyb3IsXG4gICAgICAgIGxhYmVsOiBhdXRoUmVmcmVzaExhYmVsLFxuICAgICAgfSxcbiAgICB9LFxuICAgIHZhbGlkYXRpb246IHtcbiAgICAgIHRvdGFsOiB2YWxpZGF0aW9uSXNzdWVzLmxlbmd0aCxcbiAgICAgIGJ5U2V2ZXJpdHk6IHZhbGlkYXRpb25Db3VudHMsXG4gICAgICBjb2RlczogdmFsaWRhdGlvbkNvZGVzLFxuICAgICAgdG9wSXNzdWVzOiB2YWxpZGF0aW9uSXNzdWVzLnNsaWNlKDAsIDYpLFxuICAgIH0sXG4gICAgZG9jdG9yOiB7XG4gICAgICBzY29wZTogcmVjb3ZlcnlDaGlsZC5kb2N0b3Iuc2NvcGUsXG4gICAgICB0b3RhbDogcmVjb3ZlcnlDaGlsZC5kb2N0b3IudG90YWwsXG4gICAgICBlcnJvcnM6IHJlY292ZXJ5Q2hpbGQuZG9jdG9yLmVycm9ycyxcbiAgICAgIHdhcm5pbmdzOiByZWNvdmVyeUNoaWxkLmRvY3Rvci53YXJuaW5ncyxcbiAgICAgIGluZm9zOiByZWNvdmVyeUNoaWxkLmRvY3Rvci5pbmZvcyxcbiAgICAgIGZpeGFibGU6IHJlY292ZXJ5Q2hpbGQuZG9jdG9yLmZpeGFibGUsXG4gICAgICBjb2RlczogcmVjb3ZlcnlDaGlsZC5kb2N0b3IuY29kZXMsXG4gICAgICB0b3BJc3N1ZXM6IGRvY3RvclRvcElzc3VlcyxcbiAgICB9LFxuICAgIGludGVycnVwdGVkUnVuLFxuICAgIGFjdGlvbnM6IHtcbiAgICAgIGJyb3dzZXI6IGJ1aWxkQnJvd3NlckFjdGlvbnMoe1xuICAgICAgICBoYXNTZXNzaW9uczogcmVzdW1hYmxlU2Vzc2lvbnMubGVuZ3RoID4gMCxcbiAgICAgICAgcmV0cnlBY3RpdmU6IEJvb2xlYW4oYnJpZGdlU25hcHNob3Quc2Vzc2lvblN0YXRlPy5yZXRyeUluUHJvZ3Jlc3MpLFxuICAgICAgICBhdXRvUmV0cnlFbmFibGVkOiBCb29sZWFuKGJyaWRnZVNuYXBzaG90LnNlc3Npb25TdGF0ZT8uYXV0b1JldHJ5RW5hYmxlZCksXG4gICAgICAgIGJyaWRnZUZhaWx1cmU6IEJvb2xlYW4oYnJpZGdlRmFpbHVyZSksXG4gICAgICAgIGNvbXBhY3Rpb25BY3RpdmU6IEJvb2xlYW4oYnJpZGdlU25hcHNob3Quc2Vzc2lvblN0YXRlPy5pc0NvbXBhY3RpbmcpLFxuICAgICAgICBhdXRoQXR0ZW50aW9uTmVlZGVkOlxuICAgICAgICAgIG9uYm9hcmRpbmcubG9ja2VkIHx8IGF1dGhSZWZyZXNoUGhhc2UgPT09IFwiZmFpbGVkXCIgfHwgb25ib2FyZGluZy5sYXN0VmFsaWRhdGlvbj8uc3RhdHVzID09PSBcImZhaWxlZFwiLFxuICAgICAgfSksXG4gICAgICBjb21tYW5kczogYnVpbGRDb21tYW5kU3VnZ2VzdGlvbnMoYWN0aXZlU2NvcGUsIHdvcmtzcGFjZT8uYWN0aXZlLnBoYXNlLCB2YWxpZGF0aW9uSXNzdWVzLmxlbmd0aCksXG4gICAgfSxcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxNQUFNLGVBQWU7QUFDOUIsU0FBUyxxQkFBcUI7QUFFOUI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBbUMseUJBQXlCLGlDQUFpQztBQVU3RixNQUFNLGtDQUFrQyxPQUFPO0FBbUQvQyxTQUFTLG9CQUFvQixPQUF1QjtBQUNsRCxTQUFPLE1BQ0osUUFBUSx5QkFBeUIsWUFBWSxFQUM3QyxRQUFRLDZCQUE2QixZQUFZLEVBQ2pELFFBQVEscUJBQXFCLG1CQUFtQixFQUNoRCxRQUFRLG1FQUFtRSxjQUFjO0FBQzlGO0FBRUEsU0FBUyxhQUFhLE9BQXdCO0FBQzVDLFFBQU0sTUFBTSxpQkFBaUIsUUFBUSxNQUFNLFVBQVUsT0FBTyxTQUFTLEVBQUU7QUFDdkUsU0FBTyxvQkFBb0IsR0FBRyxFQUFFLFFBQVEsUUFBUSxHQUFHLEVBQUUsS0FBSztBQUM1RDtBQUVBLFNBQVMsYUFBYSxNQUFzQjtBQUMxQyxTQUFPLEtBQUssUUFBUSxVQUFVLEdBQUcsRUFBRSxRQUFRLFNBQVMsQ0FBQyxjQUFjLFVBQVUsWUFBWSxDQUFDO0FBQzVGO0FBRUEsU0FBUyx5QkFBeUIsV0FBcUc7QUFDckksTUFBSSxDQUFDLFdBQVcsT0FBTyxZQUFhLFFBQU87QUFDM0MsTUFBSSxVQUFVLE9BQU8sVUFBVSxVQUFVLE9BQU8sU0FBUztBQUN2RCxXQUFPLEdBQUcsVUFBVSxPQUFPLFdBQVcsSUFBSSxVQUFVLE9BQU8sT0FBTyxJQUFJLFVBQVUs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
