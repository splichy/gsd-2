const COMMAND_SURFACE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
function createInitialDiagnosticsPhaseState() {
  return { phase: "idle", data: null, error: null, lastLoadedAt: null };
}
function createInitialDoctorState() {
  return { phase: "idle", data: null, error: null, lastLoadedAt: null, fixPending: false, lastFixResult: null, lastFixError: null };
}
function createInitialDiagnosticsState() {
  return {
    forensics: createInitialDiagnosticsPhaseState(),
    doctor: createInitialDoctorState(),
    skillHealth: createInitialDiagnosticsPhaseState()
  };
}
function createInitialKnowledgeCapturesState() {
  return {
    knowledge: createInitialDiagnosticsPhaseState(),
    captures: createInitialDiagnosticsPhaseState(),
    resolveRequest: { pending: false, lastError: null, lastResult: null }
  };
}
function createInitialSettingsState() {
  return createInitialDiagnosticsPhaseState();
}
function createInitialRemainingState() {
  return {
    history: createInitialDiagnosticsPhaseState(),
    inspect: createInitialDiagnosticsPhaseState(),
    hooks: createInitialDiagnosticsPhaseState(),
    exportData: createInitialDiagnosticsPhaseState(),
    undo: createInitialDiagnosticsPhaseState(),
    cleanup: createInitialDiagnosticsPhaseState(),
    steer: createInitialDiagnosticsPhaseState()
  };
}
const AUTH_SURFACE_COMMANDS = /* @__PURE__ */ new Set(["settings", "login", "logout"]);
const SETTINGS_MUTATION_ACTION_TO_REQUEST = {
  set_steering_mode: "steeringMode",
  set_follow_up_mode: "followUpMode",
  set_auto_compaction: "autoCompaction",
  set_auto_retry: "autoRetry",
  abort_retry: "abortRetry"
};
function matchingSessionPath(sessions, query) {
  if (!sessions?.length) return void 0;
  const normalizedQuery = query?.trim().toLowerCase();
  if (!normalizedQuery) {
    return sessions.find((session) => !session.isActive)?.path ?? sessions[0]?.path;
  }
  const exactMatch = sessions.find((session) => {
    const values = [session.id, session.name, session.path].filter(Boolean).map((value) => value.toLowerCase());
    return values.includes(normalizedQuery);
  });
  if (exactMatch) return exactMatch.path;
  return sessions.find((session) => {
    const values = [session.id, session.name, session.path].filter(Boolean).map((value) => value.toLowerCase());
    return values.some((value) => value.includes(normalizedQuery));
  })?.path;
}
function createInitialCommandSurfaceSessionBrowserState(overrides = {}) {
  return {
    scope: null,
    projectCwd: null,
    projectSessionsDir: null,
    activeSessionPath: null,
    query: "",
    sortMode: "threaded",
    nameFilter: "all",
    totalSessions: 0,
    returnedSessions: 0,
    sessions: [],
    loaded: false,
    error: null,
    ...overrides
  };
}
function createInitialCommandSurfaceSessionMutationState() {
  return {
    pending: false,
    sessionPath: null,
    result: null,
    error: null
  };
}
function createInitialCommandSurfaceSettingMutationState() {
  return {
    pending: false,
    result: null,
    error: null
  };
}
function createInitialCommandSurfaceSettingsMutationState() {
  return {
    steeringMode: createInitialCommandSurfaceSettingMutationState(),
    followUpMode: createInitialCommandSurfaceSettingMutationState(),
    autoCompaction: createInitialCommandSurfaceSettingMutationState(),
    autoRetry: createInitialCommandSurfaceSettingMutationState(),
    abortRetry: createInitialCommandSurfaceSettingMutationState()
  };
}
function createInitialCommandSurfaceGitSummaryState() {
  return {
    pending: false,
    loaded: false,
    result: null,
    error: null
  };
}
function createInitialCommandSurfaceRecoveryState() {
  return {
    phase: "idle",
    pending: false,
    loaded: false,
    stale: false,
    diagnostics: null,
    error: null,
    lastLoadedAt: null,
    lastInvalidatedAt: null,
    lastFailureAt: null
  };
}
function buildInitialSessionBrowserState(request) {
  const initialQuery = request.surface === "resume" ? request.args?.trim() ?? "" : "";
  return createInitialCommandSurfaceSessionBrowserState({
    activeSessionPath: request.currentSessionPath ?? null,
    projectCwd: request.projectCwd ?? null,
    projectSessionsDir: request.projectSessionsDir ?? null,
    query: initialQuery,
    sortMode: initialQuery ? "relevance" : "threaded"
  });
}
function isCommandSurfaceThinkingLevel(value) {
  return COMMAND_SURFACE_THINKING_LEVELS.includes(value ?? "");
}
function createInitialCommandSurfaceState() {
  return {
    open: false,
    activeSurface: null,
    source: null,
    section: null,
    args: "",
    pendingAction: null,
    selectedTarget: null,
    lastError: null,
    lastResult: null,
    availableModels: [],
    forkMessages: [],
    sessionStats: null,
    lastCompaction: null,
    gitSummary: createInitialCommandSurfaceGitSummaryState(),
    recovery: createInitialCommandSurfaceRecoveryState(),
    diagnostics: createInitialDiagnosticsState(),
    knowledgeCaptures: createInitialKnowledgeCapturesState(),
    settingsData: createInitialSettingsState(),
    remainingCommands: createInitialRemainingState(),
    sessionBrowser: createInitialCommandSurfaceSessionBrowserState(),
    resumeRequest: createInitialCommandSurfaceSessionMutationState(),
    renameRequest: createInitialCommandSurfaceSessionMutationState(),
    settingsRequests: createInitialCommandSurfaceSettingsMutationState()
  };
}
function commandSurfaceSectionForRequest(request) {
  switch (request.surface) {
    case "model":
      return "model";
    case "thinking":
      return "thinking";
    case "settings":
      return request.onboardingLocked ? "auth" : "general";
    case "git":
      return "git";
    case "login":
    case "logout":
      return "auth";
    case "resume":
      return "resume";
    case "name":
      return "name";
    case "fork":
      return "fork";
    case "session":
    case "export":
      return "session";
    case "compact":
      return "compact";
    // GSD subcommand surfaces (S02)
    case "gsd-status":
      return "gsd-status";
    case "gsd-visualize":
      return "gsd-visualize";
    case "gsd-forensics":
      return "gsd-forensics";
    case "gsd-doctor":
      return "gsd-doctor";
    case "gsd-skill-health":
      return "gsd-skill-health";
    case "gsd-knowledge":
      return "gsd-knowledge";
    case "gsd-capture":
      return "gsd-capture";
    case "gsd-triage":
      return "gsd-triage";
    case "gsd-quick":
      return "gsd-quick";
    case "gsd-history":
      return "gsd-history";
    case "gsd-undo":
      return "gsd-undo";
    case "gsd-inspect":
      return "gsd-inspect";
    case "gsd-prefs":
      return "gsd-prefs";
    case "gsd-config":
      return "gsd-config";
    case "gsd-hooks":
      return "gsd-hooks";
    case "gsd-mode":
      return "gsd-mode";
    case "gsd-steer":
      return "gsd-steer";
    case "gsd-export":
      return "gsd-export";
    case "gsd-cleanup":
      return "gsd-cleanup";
    case "gsd-queue":
      return "gsd-queue";
    default:
      return null;
  }
}
function buildSettingsTarget(section) {
  return { kind: "settings", section };
}
function buildModelTarget(request) {
  const query = request.args?.trim() || void 0;
  return {
    kind: "model",
    provider: request.currentModel?.provider,
    modelId: request.currentModel?.modelId,
    query
  };
}
function buildThinkingTarget(request) {
  const requestedLevel = request.args?.trim().toLowerCase() || "";
  const level = isCommandSurfaceThinkingLevel(requestedLevel) ? requestedLevel : isCommandSurfaceThinkingLevel(request.currentThinkingLevel) ? request.currentThinkingLevel : "off";
  return {
    kind: "thinking",
    level
  };
}
function buildAuthTarget(request) {
  const requestedProviderId = request.args?.trim() || void 0;
  return {
    kind: "auth",
    providerId: requestedProviderId ?? request.preferredProviderId ?? void 0,
    intent: request.surface === "login" ? "login" : request.surface === "logout" ? "logout" : "manage"
  };
}
function buildResumeTarget(request) {
  const selectedPath = matchingSessionPath(request.resumableSessions, request.args);
  return {
    kind: "resume",
    sessionPath: selectedPath
  };
}
function buildNameTarget(request) {
  const providedName = request.args?.trim();
  return {
    kind: "name",
    sessionPath: request.currentSessionPath ?? void 0,
    name: providedName !== void 0 && providedName.length > 0 ? providedName : request.currentSessionName?.trim() ?? ""
  };
}
function buildForkTarget(request) {
  const entryId = request.args?.trim() || void 0;
  return {
    kind: "fork",
    entryId
  };
}
function buildSessionTarget(request) {
  const outputPath = request.args?.trim() || void 0;
  return {
    kind: "session",
    outputPath
  };
}
function buildCompactTarget(request) {
  return {
    kind: "compact",
    customInstructions: request.args?.trim() ?? ""
  };
}
function buildCommandSurfaceTarget(request) {
  if (request.selectedTarget !== void 0) {
    return request.selectedTarget;
  }
  const section = commandSurfaceSectionForRequest(request);
  if (!section) return null;
  if (request.surface === "settings") {
    return buildSettingsTarget(section);
  }
  if (request.surface === "model") {
    return buildModelTarget(request);
  }
  if (request.surface === "thinking") {
    return buildThinkingTarget(request);
  }
  if (AUTH_SURFACE_COMMANDS.has(request.surface)) {
    return buildAuthTarget(request);
  }
  if (request.surface === "resume") {
    return buildResumeTarget(request);
  }
  if (request.surface === "name") {
    return buildNameTarget(request);
  }
  if (request.surface === "fork") {
    return buildForkTarget(request);
  }
  if (request.surface === "session" || request.surface === "export") {
    return buildSessionTarget(request);
  }
  if (request.surface === "compact") {
    return buildCompactTarget(request);
  }
  if (request.surface?.startsWith("gsd-")) {
    const subcommand = request.surface.slice(4);
    return { kind: "gsd", surface: request.surface, subcommand, args: request.args ?? "" };
  }
  return buildSettingsTarget(section);
}
function openCommandSurfaceState(current, request) {
  const section = commandSurfaceSectionForRequest(request);
  return {
    ...current,
    open: true,
    activeSurface: request.surface,
    source: request.source,
    section,
    args: request.args?.trim() ?? "",
    pendingAction: null,
    selectedTarget: buildCommandSurfaceTarget(request),
    lastError: null,
    lastResult: null,
    sessionStats: null,
    forkMessages: [],
    lastCompaction: null,
    gitSummary: createInitialCommandSurfaceGitSummaryState(),
    recovery: createInitialCommandSurfaceRecoveryState(),
    diagnostics: createInitialDiagnosticsState(),
    knowledgeCaptures: createInitialKnowledgeCapturesState(),
    settingsData: createInitialSettingsState(),
    remainingCommands: createInitialRemainingState(),
    sessionBrowser: buildInitialSessionBrowserState(request),
    resumeRequest: createInitialCommandSurfaceSessionMutationState(),
    renameRequest: createInitialCommandSurfaceSessionMutationState(),
    settingsRequests: createInitialCommandSurfaceSettingsMutationState()
  };
}
function closeCommandSurfaceState(current) {
  return {
    ...current,
    open: false,
    pendingAction: null
  };
}
function setCommandSurfaceSection(current, section, context = {}) {
  const request = {
    surface: current.activeSurface ?? "settings",
    source: current.source ?? "surface",
    args: current.args,
    ...context
  };
  const currentSessionPath = current.selectedTarget?.kind === "resume" ? current.selectedTarget.sessionPath : current.selectedTarget?.kind === "name" ? current.selectedTarget.sessionPath : void 0;
  const currentDraftName = current.selectedTarget?.kind === "name" ? current.selectedTarget.name : void 0;
  let selectedTarget = current.selectedTarget;
  if (section === "model") {
    selectedTarget = buildModelTarget(request);
  } else if (section === "thinking") {
    selectedTarget = buildThinkingTarget(request);
  } else if (section === "general" || section === "session-behavior" || section === "queue" || section === "compaction" || section === "retry" || section === "recovery" || section === "git" || section === "admin") {
    selectedTarget = buildSettingsTarget(section);
  } else if (section === "auth") {
    selectedTarget = buildAuthTarget({
      ...request,
      surface: current.activeSurface === "logout" ? "logout" : current.activeSurface === "login" ? "login" : "settings"
    });
  } else if (section === "resume") {
    selectedTarget = { kind: "resume", sessionPath: currentSessionPath ?? buildResumeTarget(request).sessionPath };
  } else if (section === "name") {
    selectedTarget = {
      kind: "name",
      sessionPath: currentSessionPath ?? request.currentSessionPath ?? void 0,
      name: currentDraftName ?? request.currentSessionName?.trim() ?? ""
    };
  } else if (section === "fork") {
    selectedTarget = buildForkTarget(request);
  } else if (section === "session") {
    selectedTarget = buildSessionTarget(request);
  } else if (section === "compact") {
    selectedTarget = buildCompactTarget(request);
  }
  return {
    ...current,
    section,
    selectedTarget
  };
}
function selectCommandSurfaceStateTarget(current, target) {
  const nextSection = target.kind === "settings" ? target.section : target.kind === "model" ? "model" : target.kind === "thinking" ? "thinking" : target.kind === "auth" ? "auth" : target.kind === "resume" ? "resume" : target.kind === "name" ? "name" : target.kind === "fork" ? "fork" : target.kind === "session" ? "session" : "compact";
  return {
    ...current,
    section: nextSection,
    selectedTarget: target,
    lastError: null,
    lastResult: null
  };
}
function setCommandSurfacePending(current, action, selectedTarget = current.selectedTarget) {
  const nextResumeRequest = action === "switch_session" ? {
    pending: true,
    sessionPath: selectedTarget?.kind === "resume" ? selectedTarget.sessionPath ?? null : null,
    result: null,
    error: null
  } : current.resumeRequest;
  const nextRenameRequest = action === "rename_session" ? {
    pending: true,
    sessionPath: selectedTarget?.kind === "name" ? selectedTarget.sessionPath ?? null : null,
    result: null,
    error: null
  } : current.renameRequest;
  const settingsRequestKey = SETTINGS_MUTATION_ACTION_TO_REQUEST[action];
  const nextSettingsRequests = settingsRequestKey ? {
    ...current.settingsRequests,
    [settingsRequestKey]: {
      pending: true,
      result: null,
      error: null
    }
  } : current.settingsRequests;
  return {
    ...current,
    pendingAction: action,
    selectedTarget,
    lastError: null,
    lastResult: null,
    gitSummary: action === "load_git_summary" ? {
      ...current.gitSummary,
      pending: true,
      error: null
    } : current.gitSummary,
    recovery: action === "load_recovery_diagnostics" ? {
      ...current.recovery,
      pending: true,
      error: null,
      phase: current.recovery.loaded ? current.recovery.phase : "loading"
    } : current.recovery,
    sessionBrowser: action === "load_session_browser" ? {
      ...current.sessionBrowser,
      error: null
    } : current.sessionBrowser,
    resumeRequest: nextResumeRequest,
    renameRequest: nextRenameRequest,
    settingsRequests: nextSettingsRequests
  };
}
function applyCommandSurfaceActionResult(current, result) {
  const nextSelectedTarget = result.selectedTarget === void 0 ? current.selectedTarget : result.selectedTarget;
  const resumeSessionPath = (nextSelectedTarget?.kind === "resume" ? nextSelectedTarget.sessionPath : void 0) ?? current.resumeRequest.sessionPath;
  const renameSessionPath = (nextSelectedTarget?.kind === "name" ? nextSelectedTarget.sessionPath : void 0) ?? current.renameRequest.sessionPath;
  const settingsRequestKey = SETTINGS_MUTATION_ACTION_TO_REQUEST[result.action];
  const nextSettingsRequests = settingsRequestKey ? {
    ...current.settingsRequests,
    [settingsRequestKey]: {
      pending: false,
      result: result.success ? result.message : null,
      error: result.success ? null : result.message
    }
  } : current.settingsRequests;
  return {
    ...current,
    pendingAction: null,
    selectedTarget: nextSelectedTarget,
    availableModels: result.availableModels ?? current.availableModels,
    forkMessages: result.forkMessages ?? current.forkMessages,
    sessionStats: result.sessionStats === void 0 ? current.sessionStats : result.sessionStats,
    lastCompaction: result.lastCompaction === void 0 ? current.lastCompaction : result.lastCompaction,
    gitSummary: result.gitSummary === void 0 ? current.gitSummary : {
      ...result.gitSummary,
      pending: false,
      loaded: result.gitSummary.loaded || result.success
    },
    recovery: result.recovery ?? current.recovery,
    sessionBrowser: result.sessionBrowser ?? current.sessionBrowser,
    resumeRequest: result.action === "switch_session" ? {
      pending: false,
      sessionPath: resumeSessionPath ?? null,
      result: result.success ? result.message : null,
      error: result.success ? null : result.message
    } : current.resumeRequest,
    renameRequest: result.action === "rename_session" ? {
      pending: false,
      sessionPath: renameSessionPath ?? null,
      result: result.success ? result.message : null,
      error: result.success ? null : result.message
    } : current.renameRequest,
    settingsRequests: nextSettingsRequests,
    lastError: result.success ? null : result.message,
    lastResult: result.success ? result.message : null
  };
}
function surfaceOutcomeToOpenRequest(outcome, context = {}) {
  return {
    surface: outcome.surface,
    source: "slash",
    args: outcome.args,
    ...context
  };
}
export {
  COMMAND_SURFACE_THINKING_LEVELS,
  applyCommandSurfaceActionResult,
  buildCommandSurfaceTarget,
  closeCommandSurfaceState,
  commandSurfaceSectionForRequest,
  createInitialCommandSurfaceRecoveryState,
  createInitialCommandSurfaceState,
  createInitialDiagnosticsPhaseState,
  createInitialDiagnosticsState,
  createInitialDoctorState,
  createInitialKnowledgeCapturesState,
  createInitialRemainingState,
  createInitialSettingsState,
  isCommandSurfaceThinkingLevel,
  openCommandSurfaceState,
  selectCommandSurfaceStateTarget,
  setCommandSurfacePending,
  setCommandSurfaceSection,
  surfaceOutcomeToOpenRequest
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vd2ViL2xpYi9jb21tYW5kLXN1cmZhY2UtY29udHJhY3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0eXBlIHsgQnJvd3NlclNsYXNoQ29tbWFuZERpc3BhdGNoUmVzdWx0LCBCcm93c2VyU2xhc2hDb21tYW5kU3VyZmFjZSB9IGZyb20gXCIuL2Jyb3dzZXItc2xhc2gtY29tbWFuZC1kaXNwYXRjaFwiXG5pbXBvcnQgdHlwZSB7IERvY3RvckZpeFJlc3VsdCwgRG9jdG9yUmVwb3J0LCBGb3JlbnNpY1JlcG9ydCwgU2tpbGxIZWFsdGhSZXBvcnQgfSBmcm9tIFwiLi9kaWFnbm9zdGljcy10eXBlc1wiXG5pbXBvcnQgdHlwZSB7IEtub3dsZWRnZURhdGEsIENhcHR1cmVzRGF0YSwgQ2FwdHVyZVJlc29sdmVSZXN1bHQgfSBmcm9tIFwiLi9rbm93bGVkZ2UtY2FwdHVyZXMtdHlwZXNcIlxuaW1wb3J0IHR5cGUgeyBTZXR0aW5nc0RhdGEgfSBmcm9tIFwiLi9zZXR0aW5ncy10eXBlc1wiXG5pbXBvcnQgdHlwZSB7XG4gIEhpc3RvcnlEYXRhLFxuICBJbnNwZWN0RGF0YSxcbiAgSG9va3NEYXRhLFxuICBFeHBvcnRSZXN1bHQsXG4gIFVuZG9JbmZvLFxuICBDbGVhbnVwRGF0YSxcbiAgU3RlZXJEYXRhLFxufSBmcm9tIFwiLi9yZW1haW5pbmctY29tbWFuZC10eXBlc1wiXG5pbXBvcnQgdHlwZSB7IEdpdFN1bW1hcnlSZXNwb25zZSB9IGZyb20gXCIuL2dpdC1zdW1tYXJ5LWNvbnRyYWN0XCJcbmltcG9ydCB0eXBlIHtcbiAgU2Vzc2lvbkJyb3dzZXJOYW1lRmlsdGVyLFxuICBTZXNzaW9uQnJvd3NlclNlc3Npb24sXG4gIFNlc3Npb25Ccm93c2VyU29ydE1vZGUsXG59IGZyb20gXCIuL3Nlc3Npb24tYnJvd3Nlci1jb250cmFjdFwiXG5cbmV4cG9ydCBjb25zdCBDT01NQU5EX1NVUkZBQ0VfVEhJTktJTkdfTEVWRUxTID0gW1wib2ZmXCIsIFwibWluaW1hbFwiLCBcImxvd1wiLCBcIm1lZGl1bVwiLCBcImhpZ2hcIiwgXCJ4aGlnaFwiXSBhcyBjb25zdFxuXG5leHBvcnQgdHlwZSBDb21tYW5kU3VyZmFjZVRoaW5raW5nTGV2ZWwgPSAodHlwZW9mIENPTU1BTkRfU1VSRkFDRV9USElOS0lOR19MRVZFTFMpW251bWJlcl1cbmV4cG9ydCB0eXBlIENvbW1hbmRTdXJmYWNlU2VjdGlvbiA9XG4gIHwgXCJnZW5lcmFsXCJcbiAgfCBcIm1vZGVsXCJcbiAgfCBcInRoaW5raW5nXCJcbiAgfCBcInF1ZXVlXCJcbiAgfCBcImNvbXBhY3Rpb25cIlxuICB8IFwicmV0cnlcIlxuICB8IFwic2Vzc2lvbi1iZWhhdmlvclwiXG4gIHwgXCJyZWNvdmVyeVwiXG4gIHwgXCJhdXRoXCJcbiAgfCBcImFkbWluXCJcbiAgfCBcImdpdFwiXG4gIHwgXCJyZXN1bWVcIlxuICB8IFwibmFtZVwiXG4gIHwgXCJmb3JrXCJcbiAgfCBcInNlc3Npb25cIlxuICB8IFwiY29tcGFjdFwiXG4gIHwgXCJ3b3Jrc3BhY2VcIlxuICB8IFwiaW50ZWdyYXRpb25zXCJcbiAgfCBcImV4cGVyaW1lbnRhbFwiXG4gIC8vIEdTRCBzdWJjb21tYW5kIHN1cmZhY2VzIChTMDIpXG4gIHwgXCJnc2Qtc3RhdHVzXCJcbiAgfCBcImdzZC12aXN1YWxpemVcIlxuICB8IFwiZ3NkLWZvcmVuc2ljc1wiXG4gIHwgXCJnc2QtZG9jdG9yXCJcbiAgfCBcImdzZC1za2lsbC1oZWFsdGhcIlxuICB8IFwiZ3NkLWtub3dsZWRnZVwiXG4gIHwgXCJnc2QtY2FwdHVyZVwiXG4gIHwgXCJnc2QtdHJpYWdlXCJcbiAgfCBcImdzZC1xdWlja1wiXG4gIHwgXCJnc2QtaGlzdG9yeVwiXG4gIHwgXCJnc2QtdW5kb1wiXG4gIHwgXCJnc2QtaW5zcGVjdFwiXG4gIHwgXCJnc2QtcHJlZnNcIlxuICB8IFwiZ3NkLWNvbmZpZ1wiXG4gIHwgXCJnc2QtaG9va3NcIlxuICB8IFwiZ3NkLW1vZGVcIlxuICB8IFwiZ3NkLXN0ZWVyXCJcbiAgfCBcImdzZC1leHBvcnRcIlxuICB8IFwiZ3NkLWNsZWFudXBcIlxuICB8IFwiZ3NkLXF1ZXVlXCJcbmV4cG9ydCB0eXBlIENvbW1hbmRTdXJmYWNlU291cmNlID0gXCJzbGFzaFwiIHwgXCJzaWRlYmFyXCIgfCBcInN1cmZhY2VcIlxuZXhwb3J0IHR5cGUgQ29tbWFuZFN1cmZhY2VQZW5kaW5nQWN0aW9uID1cbiAgfCBcImxvYWRpbmdfbW9kZWxzXCJcbiAgfCBcInNldF9tb2RlbFwiXG4gIHwgXCJzZXRfdGhpbmtpbmdfbGV2ZWxcIlxuICB8IFwic2V0X3N0ZWVyaW5nX21vZGVcIlxuICB8IFwic2V0X2ZvbGxvd191cF9tb2RlXCJcbiAgfCBcInNldF9hdXRvX2NvbXBhY3Rpb25cIlxuICB8IFwic2V0X2F1dG9fcmV0cnlcIlxuICB8IFwiYWJvcnRfcmV0cnlcIlxuICB8IFwibG9hZF9naXRfc3VtbWFyeVwiXG4gIHwgXCJsb2FkX3JlY292ZXJ5X2RpYWdub3N0aWNzXCJcbiAgfCBcImxvYWRfc2Vzc2lvbl9icm93c2VyXCJcbiAgfCBcInJlbmFtZV9zZXNzaW9uXCJcbiAgfCBcInNhdmVfYXBpX2tleVwiXG4gIHwgXCJzdGFydF9wcm92aWRlcl9mbG93XCJcbiAgfCBcInN1Ym1pdF9wcm92aWRlcl9mbG93X2lucHV0XCJcbiAgfCBcImNhbmNlbF9wcm92aWRlcl9mbG93XCJcbiAgfCBcImxvZ291dF9wcm92aWRlclwiXG4gIHwgXCJzd2l0Y2hfc2Vzc2lvblwiXG4gIHwgXCJsb2FkX2ZvcmtfbWVzc2FnZXNcIlxuICB8IFwiZm9ya19zZXNzaW9uXCJcbiAgfCBcImxvYWRfc2Vzc2lvbl9zdGF0c1wiXG4gIHwgXCJleHBvcnRfaHRtbFwiXG4gIHwgXCJjb21wYWN0X3Nlc3Npb25cIlxuXG5leHBvcnQgaW50ZXJmYWNlIENvbW1hbmRTdXJmYWNlTW9kZWxPcHRpb24ge1xuICBwcm92aWRlcjogc3RyaW5nXG4gIG1vZGVsSWQ6IHN0cmluZ1xuICBuYW1lPzogc3RyaW5nXG4gIHJlYXNvbmluZzogYm9vbGVhblxuICBpc0N1cnJlbnQ6IGJvb2xlYW5cbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb21tYW5kU3VyZmFjZUZvcmtNZXNzYWdlIHtcbiAgZW50cnlJZDogc3RyaW5nXG4gIHRleHQ6IHN0cmluZ1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbW1hbmRTdXJmYWNlU2Vzc2lvblN0YXRzIHtcbiAgc2Vzc2lvbkZpbGU6IHN0cmluZyB8IHVuZGVmaW5lZFxuICBzZXNzaW9uSWQ6IHN0cmluZ1xuICB1c2VyTWVzc2FnZXM6IG51bWJlclxuICBhc3Npc3RhbnRNZXNzYWdlczogbnVtYmVyXG4gIHRvb2xDYWxsczogbnVtYmVyXG4gIHRvb2xSZXN1bHRzOiBudW1iZXJcbiAgdG90YWxNZXNzYWdlczogbnVtYmVyXG4gIHRva2Vuczoge1xuICAgIGlucHV0OiBudW1iZXJcbiAgICBvdXRwdXQ6IG51bWJlclxuICAgIGNhY2hlUmVhZDogbnVtYmVyXG4gICAgY2FjaGVXcml0ZTogbnVtYmVyXG4gICAgdG90YWw6IG51bWJlclxuICB9XG4gIGNvc3Q6IG51bWJlclxufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbW1hbmRTdXJmYWNlQ29tcGFjdGlvblJlc3VsdCB7XG4gIHN1bW1hcnk6IHN0cmluZ1xuICBmaXJzdEtlcHRFbnRyeUlkOiBzdHJpbmdcbiAgdG9rZW5zQmVmb3JlOiBudW1iZXJcbiAgZGV0YWlscz86IHVua25vd25cbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb21tYW5kU3VyZmFjZVJlc3VtYWJsZVNlc3Npb24ge1xuICBpZDogc3RyaW5nXG4gIHBhdGg6IHN0cmluZ1xuICBuYW1lPzogc3RyaW5nXG4gIGlzQWN0aXZlOiBib29sZWFuXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tbWFuZFN1cmZhY2VTZXNzaW9uQnJvd3NlclN0YXRlIHtcbiAgc2NvcGU6IFwiY3VycmVudF9wcm9qZWN0XCIgfCBudWxsXG4gIHByb2plY3RDd2Q6IHN0cmluZyB8IG51bGxcbiAgcHJvamVjdFNlc3Npb25zRGlyOiBzdHJpbmcgfCBudWxsXG4gIGFjdGl2ZVNlc3Npb25QYXRoOiBzdHJpbmcgfCBudWxsXG4gIHF1ZXJ5OiBzdHJpbmdcbiAgc29ydE1vZGU6IFNlc3Npb25Ccm93c2VyU29ydE1vZGVcbiAgbmFtZUZpbHRlcjogU2Vzc2lvbkJyb3dzZXJOYW1lRmlsdGVyXG4gIHRvdGFsU2Vzc2lvbnM6IG51bWJlclxuICByZXR1cm5lZFNlc3Npb25zOiBudW1iZXJcbiAgc2Vzc2lvbnM6IFNlc3Npb25Ccm93c2VyU2Vzc2lvbltdXG4gIGxvYWRlZDogYm9vbGVhblxuICBlcnJvcjogc3RyaW5nIHwgbnVsbFxufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbW1hbmRTdXJmYWNlU2Vzc2lvbk11dGF0aW9uU3RhdGUge1xuICBwZW5kaW5nOiBib29sZWFuXG4gIHNlc3Npb25QYXRoOiBzdHJpbmcgfCBudWxsXG4gIHJlc3VsdDogc3RyaW5nIHwgbnVsbFxuICBlcnJvcjogc3RyaW5nIHwgbnVsbFxufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbW1hbmRTdXJmYWNlU2V0dGluZ011dGF0aW9uU3RhdGUge1xuICBwZW5kaW5nOiBib29sZWFuXG4gIHJlc3VsdDogc3RyaW5nIHwgbnVsbFxuICBlcnJvcjogc3RyaW5nIHwgbnVsbFxufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbW1hbmRTdXJmYWNlU2V0dGluZ3NNdXRhdGlvblN0YXRlIHtcbiAgc3RlZXJpbmdNb2RlOiBDb21tYW5kU3VyZmFjZVNldHRpbmdNdXRhdGlvblN0YXRlXG4gIGZvbGxvd1VwTW9kZTogQ29tbWFuZFN1cmZhY2VTZXR0aW5nTXV0YXRpb25TdGF0ZVxuICBhdXRvQ29tcGFjdGlvbjogQ29tbWFuZFN1cmZhY2VTZXR0aW5nTXV0YXRpb25TdGF0ZVxuICBhdXRvUmV0cnk6IENvbW1hbmRTdXJmYWNlU2V0dGluZ011dGF0aW9uU3RhdGVcbiAgYWJvcnRSZXRyeTogQ29tbWFuZFN1cmZhY2VTZXR0aW5nTXV0YXRpb25TdGF0ZVxufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbW1hbmRTdXJmYWNlR2l0U3VtbWFyeVN0YXRlIHtcbiAgcGVuZGluZzogYm9vbGVhblxuICBsb2FkZWQ6IGJvb2xlYW5cbiAgcmVzdWx0OiBHaXRTdW1tYXJ5UmVzcG9uc2UgfCBudWxsXG4gIGVycm9yOiBzdHJpbmcgfCBudWxsXG59XG5cbmV4cG9ydCB0eXBlIFdvcmtzcGFjZVJlY292ZXJ5U3VtbWFyeVRvbmUgPSBcImhlYWx0aHlcIiB8IFwid2FybmluZ1wiIHwgXCJkYW5nZXJcIlxuZXhwb3J0IHR5cGUgV29ya3NwYWNlUmVjb3ZlcnlEaWFnbm9zdGljc1N0YXR1cyA9IFwicmVhZHlcIiB8IFwidW5hdmFpbGFibGVcIlxuZXhwb3J0IHR5cGUgV29ya3NwYWNlUmVjb3ZlcnlCcm93c2VyQWN0aW9uSWQgPVxuICB8IFwicmVmcmVzaF9kaWFnbm9zdGljc1wiXG4gIHwgXCJyZWZyZXNoX3dvcmtzcGFjZVwiXG4gIHwgXCJvcGVuX3JldHJ5X2NvbnRyb2xzXCJcbiAgfCBcIm9wZW5fcmVzdW1lX2NvbnRyb2xzXCJcbiAgfCBcIm9wZW5fYXV0aF9jb250cm9sc1wiXG5leHBvcnQgdHlwZSBDb21tYW5kU3VyZmFjZVJlY292ZXJ5UGhhc2UgPSBcImlkbGVcIiB8IFwibG9hZGluZ1wiIHwgXCJyZWFkeVwiIHwgXCJ1bmF2YWlsYWJsZVwiIHwgXCJlcnJvclwiXG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlUmVjb3ZlcnlCcm93c2VyQWN0aW9uIHtcbiAgaWQ6IFdvcmtzcGFjZVJlY292ZXJ5QnJvd3NlckFjdGlvbklkXG4gIGxhYmVsOiBzdHJpbmdcbiAgZGV0YWlsOiBzdHJpbmdcbiAgZW1waGFzaXM/OiBcInByaW1hcnlcIiB8IFwic2Vjb25kYXJ5XCIgfCBcImRhbmdlclwiXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlUmVjb3ZlcnlDb21tYW5kU3VnZ2VzdGlvbiB7XG4gIGxhYmVsOiBzdHJpbmdcbiAgY29tbWFuZDogc3RyaW5nXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlUmVjb3ZlcnlDb2RlU3VtbWFyeSB7XG4gIGNvZGU6IHN0cmluZ1xuICBjb3VudDogbnVtYmVyXG4gIGxhYmVsOiBzdHJpbmdcbiAgc2V2ZXJpdHk6IFwiaW5mb1wiIHwgXCJ3YXJuaW5nXCIgfCBcImVycm9yXCJcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VSZWNvdmVyeUlzc3VlRGlnZXN0IHtcbiAgY29kZTogc3RyaW5nXG4gIHNldmVyaXR5OiBcImluZm9cIiB8IFwid2FybmluZ1wiIHwgXCJlcnJvclwiXG4gIHNjb3BlOiBzdHJpbmdcbiAgbWVzc2FnZTogc3RyaW5nXG4gIGZpbGU/OiBzdHJpbmdcbiAgc3VnZ2VzdGlvbj86IHN0cmluZ1xuICB1bml0SWQ/OiBzdHJpbmdcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VSZWNvdmVyeURpYWdub3N0aWNzIHtcbiAgc3RhdHVzOiBXb3Jrc3BhY2VSZWNvdmVyeURpYWdub3N0aWNzU3RhdHVzXG4gIGxvYWRlZEF0OiBzdHJpbmdcbiAgcHJvamVjdDoge1xuICAgIGN3ZDogc3RyaW5nXG4gICAgYWN0aXZlU2NvcGU6IHN0cmluZyB8IG51bGxcbiAgICBhY3RpdmVTZXNzaW9uUGF0aDogc3RyaW5nIHwgbnVsbFxuICAgIGFjdGl2ZVNlc3Npb25JZDogc3RyaW5nIHwgbnVsbFxuICB9XG4gIHN1bW1hcnk6IHtcbiAgICB0b25lOiBXb3Jrc3BhY2VSZWNvdmVyeVN1bW1hcnlUb25lXG4gICAgbGFiZWw6IHN0cmluZ1xuICAgIGRldGFpbDogc3RyaW5nXG4gICAgdmFsaWRhdGlvbkNvdW50OiBudW1iZXJcbiAgICBkb2N0b3JJc3N1ZUNvdW50OiBudW1iZXJcbiAgICBsYXN0RmFpbHVyZVBoYXNlOiBzdHJpbmcgfCBudWxsXG4gICAgY3VycmVudFVuaXRJZDogc3RyaW5nIHwgbnVsbFxuICAgIHJldHJ5QXR0ZW1wdDogbnVtYmVyXG4gICAgcmV0cnlJblByb2dyZXNzOiBib29sZWFuXG4gICAgY29tcGFjdGlvbkFjdGl2ZTogYm9vbGVhblxuICB9XG4gIGJyaWRnZToge1xuICAgIHBoYXNlOiBzdHJpbmdcbiAgICByZXRyeToge1xuICAgICAgZW5hYmxlZDogYm9vbGVhblxuICAgICAgaW5Qcm9ncmVzczogYm9vbGVhblxuICAgICAgYXR0ZW1wdDogbnVtYmVyXG4gICAgICBsYWJlbDogc3RyaW5nXG4gICAgfVxuICAgIGNvbXBhY3Rpb246IHtcbiAgICAgIGFjdGl2ZTogYm9vbGVhblxuICAgICAgbGFiZWw6IHN0cmluZ1xuICAgIH1cbiAgICBsYXN0RmFpbHVyZToge1xuICAgICAgbWVzc2FnZTogc3RyaW5nXG4gICAgICBwaGFzZTogc3RyaW5nXG4gICAgICBhdDogc3RyaW5nXG4gICAgICBjb21tYW5kVHlwZTogc3RyaW5nIHwgbnVsbFxuICAgICAgYWZ0ZXJTZXNzaW9uQXR0YWNobWVudDogYm9vbGVhblxuICAgIH0gfCBudWxsXG4gICAgYXV0aFJlZnJlc2g6IHtcbiAgICAgIHBoYXNlOiBzdHJpbmdcbiAgICAgIGVycm9yOiBzdHJpbmcgfCBudWxsXG4gICAgICBsYWJlbDogc3RyaW5nXG4gICAgfVxuICB9XG4gIHZhbGlkYXRpb246IHtcbiAgICB0b3RhbDogbnVtYmVyXG4gICAgYnlTZXZlcml0eToge1xuICAgICAgZXJyb3JzOiBudW1iZXJcbiAgICAgIHdhcm5pbmdzOiBudW1iZXJcbiAgICAgIGluZm9zOiBudW1iZXJcbiAgICB9XG4gICAgY29kZXM6IFdvcmtzcGFjZVJlY292ZXJ5Q29kZVN1bW1hcnlbXVxuICAgIHRvcElzc3VlczogV29ya3NwYWNlUmVjb3ZlcnlJc3N1ZURpZ2VzdFtdXG4gIH1cbiAgZG9jdG9yOiB7XG4gICAgc2NvcGU6IHN0cmluZyB8IG51bGxcbiAgICB0b3RhbDogbnVtYmVyXG4gICAgZXJyb3JzOiBudW1iZXJcbiAgICB3YXJuaW5nczogbnVtYmVyXG4gICAgaW5mb3M6IG51bWJlclxuICAgIGZpeGFibGU6IG51bWJlclxuICAgIGNvZGVzOiBBcnJheTx7IGNvZGU6IHN0cmluZzsgY291bnQ6IG51bWJlciB9PlxuICAgIHRvcElzc3VlczogV29ya3NwYWNlUmVjb3ZlcnlJc3N1ZURpZ2VzdFtdXG4gIH1cbiAgaW50ZXJydXB0ZWRSdW46IHtcbiAgICBhdmFpbGFibGU6IGJvb2xlYW5cbiAgICBkZXRlY3RlZDogYm9vbGVhblxuICAgIGxhYmVsOiBzdHJpbmdcbiAgICBkZXRhaWw6IHN0cmluZ1xuICAgIHVuaXQ6IHtcbiAgICAgIHR5cGU6IHN0cmluZ1xuICAgICAgaWQ6IHN0cmluZ1xuICAgIH0gfCBudWxsXG4gICAgY291bnRzOiB7XG4gICAgICB0b29sQ2FsbHM6IG51bWJlclxuICAgICAgZmlsZXNXcml0dGVuOiBudW1iZXJcbiAgICAgIGNvbW1hbmRzUnVuOiBudW1iZXJcbiAgICAgIGVycm9yczogbnVtYmVyXG4gICAgfVxuICAgIGdpdENoYW5nZXNEZXRlY3RlZDogYm9vbGVhblxuICAgIGxhc3RFcnJvcjogc3RyaW5nIHwgbnVsbFxuICB9XG4gIGFjdGlvbnM6IHtcbiAgICBicm93c2VyOiBXb3Jrc3BhY2VSZWNvdmVyeUJyb3dzZXJBY3Rpb25bXVxuICAgIGNvbW1hbmRzOiBXb3Jrc3BhY2VSZWNvdmVyeUNvbW1hbmRTdWdnZXN0aW9uW11cbiAgfVxufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbW1hbmRTdXJmYWNlUmVjb3ZlcnlTdGF0ZSB7XG4gIHBoYXNlOiBDb21tYW5kU3VyZmFjZVJlY292ZXJ5UGhhc2VcbiAgcGVuZGluZzogYm9vbGVhblxuICBsb2FkZWQ6IGJvb2xlYW5cbiAgc3RhbGU6IGJvb2xlYW5cbiAgZGlhZ25vc3RpY3M6IFdvcmtzcGFjZVJlY292ZXJ5RGlhZ25vc3RpY3MgfCBudWxsXG4gIGVycm9yOiBzdHJpbmcgfCBudWxsXG4gIGxhc3RMb2FkZWRBdDogc3RyaW5nIHwgbnVsbFxuICBsYXN0SW52YWxpZGF0ZWRBdDogc3RyaW5nIHwgbnVsbFxuICBsYXN0RmFpbHVyZUF0OiBzdHJpbmcgfCBudWxsXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3NwYWNlUmVjb3ZlcnlTdW1tYXJ5IHtcbiAgdmlzaWJsZTogYm9vbGVhblxuICB0b25lOiBXb3Jrc3BhY2VSZWNvdmVyeVN1bW1hcnlUb25lXG4gIGxhYmVsOiBzdHJpbmdcbiAgZGV0YWlsOiBzdHJpbmdcbiAgdmFsaWRhdGlvbkNvdW50OiBudW1iZXJcbiAgcmV0cnlJblByb2dyZXNzOiBib29sZWFuXG4gIHJldHJ5QXR0ZW1wdDogbnVtYmVyXG4gIGF1dG9SZXRyeUVuYWJsZWQ6IGJvb2xlYW5cbiAgaXNDb21wYWN0aW5nOiBib29sZWFuXG4gIGN1cnJlbnRVbml0SWQ6IHN0cmluZyB8IG51bGxcbiAgZnJlc2huZXNzOiBcImlkbGVcIiB8IFwiZnJlc2hcIiB8IFwic3RhbGVcIiB8IFwiZXJyb3JcIlxuICBlbnRyeXBvaW50TGFiZWw6IHN0cmluZ1xuICBsYXN0RXJyb3I6IHtcbiAgICBtZXNzYWdlOiBzdHJpbmdcbiAgICBwaGFzZTogc3RyaW5nXG4gICAgYXQ6IHN0cmluZ1xuICB9IHwgbnVsbFxufVxuXG5leHBvcnQgdHlwZSBDb21tYW5kU3VyZmFjZVRhcmdldCA9XG4gIHwgeyBraW5kOiBcInNldHRpbmdzXCI7IHNlY3Rpb246IENvbW1hbmRTdXJmYWNlU2VjdGlvbiB9XG4gIHwgeyBraW5kOiBcIm1vZGVsXCI7IHByb3ZpZGVyPzogc3RyaW5nOyBtb2RlbElkPzogc3RyaW5nOyBxdWVyeT86IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcInRoaW5raW5nXCI7IGxldmVsOiBDb21tYW5kU3VyZmFjZVRoaW5raW5nTGV2ZWwgfVxuICB8IHsga2luZDogXCJhdXRoXCI7IHByb3ZpZGVySWQ/OiBzdHJpbmc7IGludGVudDogXCJsb2dpblwiIHwgXCJsb2dvdXRcIiB8IFwibWFuYWdlXCIgfVxuICB8IHsga2luZDogXCJyZXN1bWVcIjsgc2Vzc2lvblBhdGg/OiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJuYW1lXCI7IHNlc3Npb25QYXRoPzogc3RyaW5nOyBuYW1lOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJmb3JrXCI7IGVudHJ5SWQ/OiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJzZXNzaW9uXCI7IG91dHB1dFBhdGg/OiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJjb21wYWN0XCI7IGN1c3RvbUluc3RydWN0aW9uczogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwiZ3NkXCI7IHN1cmZhY2U6IHN0cmluZzsgc3ViY29tbWFuZDogc3RyaW5nOyBhcmdzOiBzdHJpbmcgfVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRGlhZ25vc3RpY3MgcGFuZWwgc3RhdGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCB0eXBlIENvbW1hbmRTdXJmYWNlRGlhZ25vc3RpY3NQaGFzZSA9IFwiaWRsZVwiIHwgXCJsb2FkaW5nXCIgfCBcImxvYWRlZFwiIHwgXCJlcnJvclwiXG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tbWFuZFN1cmZhY2VEaWFnbm9zdGljc1BoYXNlU3RhdGU8VD4ge1xuICBwaGFzZTogQ29tbWFuZFN1cmZhY2VEaWFnbm9zdGljc1BoYXNlXG4gIGRhdGE6IFQgfCBudWxsXG4gIGVycm9yOiBzdHJpbmcgfCBudWxsXG4gIGxhc3RMb2FkZWRBdDogc3RyaW5nIHwgbnVsbFxufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbW1hbmRTdXJmYWNlRG9jdG9yU3RhdGUgZXh0ZW5kcyBDb21tYW5kU3VyZmFjZURpYWdub3N0aWNzUGhhc2VTdGF0ZTxEb2N0b3JSZXBvcnQ+IHtcbiAgZml4UGVuZGluZzogYm9vbGVhblxuICBsYXN0Rml4UmVzdWx0OiBEb2N0b3JGaXhSZXN1bHQgfCBudWxsXG4gIGxhc3RGaXhFcnJvcjogc3RyaW5nIHwgbnVsbFxufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbW1hbmRTdXJmYWNlRGlhZ25vc3RpY3NTdGF0ZSB7XG4gIGZvcmVuc2ljczogQ29tbWFuZFN1cmZhY2VEaWFnbm9zdGljc1BoYXNlU3RhdGU8Rm9yZW5zaWNSZXBvcnQ+XG4gIGRvY3RvcjogQ29tbWFuZFN1cmZhY2VEb2N0b3JTdGF0ZVxuICBza2lsbEhlYWx0aDogQ29tbWFuZFN1cmZhY2VEaWFnbm9zdGljc1BoYXNlU3RhdGU8U2tpbGxIZWFsdGhSZXBvcnQ+XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVJbml0aWFsRGlhZ25vc3RpY3NQaGFzZVN0YXRlPFQ+KCk6IENvbW1hbmRTdXJmYWNlRGlhZ25vc3RpY3NQaGFzZVN0YXRlPFQ+IHtcbiAgcmV0dXJuIHsgcGhhc2U6IFwiaWRsZVwiLCBkYXRhOiBudWxsLCBlcnJvcjogbnVsbCwgbGFzdExvYWRlZEF0OiBudWxsIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUluaXRpYWxEb2N0b3JTdGF0ZSgpOiBDb21tYW5kU3VyZmFjZURvY3RvclN0YXRlIHtcbiAgcmV0dXJuIHsgcGhhc2U6IFwiaWRsZVwiLCBkYXRhOiBudWxsLCBlcnJvcjogbnVsbCwgbGFzdExvYWRlZEF0OiBudWxsLCBmaXhQZW5kaW5nOiBmYWxzZSwgbGFzdEZpeFJlc3VsdDogbnVsbCwgbGFzdEZpeEVycm9yOiBudWxsIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUluaXRpYWxEaWFnbm9zdGljc1N0YXRlKCk6IENvbW1hbmRTdXJmYWNlRGlhZ25vc3RpY3NTdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgZm9yZW5zaWNzOiBjcmVhdGVJbml0aWFsRGlhZ25vc3RpY3NQaGFzZVN0YXRlPEZvcmVuc2ljUmVwb3J0PigpLFxuICAgIGRvY3RvcjogY3JlYXRlSW5pdGlhbERvY3RvclN0YXRlKCksXG4gICAgc2tpbGxIZWFsdGg6IGNyZWF0ZUluaXRpYWxEaWFnbm9zdGljc1BoYXNlU3RhdGU8U2tpbGxIZWFsdGhSZXBvcnQ+KCksXG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEtub3dsZWRnZS9DYXB0dXJlcyBwYW5lbCBzdGF0ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBDb21tYW5kU3VyZmFjZUtub3dsZWRnZUNhcHR1cmVzUmVzb2x2ZVN0YXRlIHtcbiAgcGVuZGluZzogYm9vbGVhblxuICBsYXN0RXJyb3I6IHN0cmluZyB8IG51bGxcbiAgbGFzdFJlc3VsdDogQ2FwdHVyZVJlc29sdmVSZXN1bHQgfCBudWxsXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tbWFuZFN1cmZhY2VLbm93bGVkZ2VDYXB0dXJlc1N0YXRlIHtcbiAga25vd2xlZGdlOiBDb21tYW5kU3VyZmFjZURpYWdub3N0aWNzUGhhc2VTdGF0ZTxLbm93bGVkZ2VEYXRhPlxuICBjYXB0dXJlczogQ29tbWFuZFN1cmZhY2VEaWFnbm9zdGljc1BoYXNlU3RhdGU8Q2FwdHVyZXNEYXRhPlxuICByZXNvbHZlUmVxdWVzdDogQ29tbWFuZFN1cmZhY2VLbm93bGVkZ2VDYXB0dXJlc1Jlc29sdmVTdGF0ZVxufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlSW5pdGlhbEtub3dsZWRnZUNhcHR1cmVzU3RhdGUoKTogQ29tbWFuZFN1cmZhY2VLbm93bGVkZ2VDYXB0dXJlc1N0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICBrbm93bGVkZ2U6IGNyZWF0ZUluaXRpYWxEaWFnbm9zdGljc1BoYXNlU3RhdGU8S25vd2xlZGdlRGF0YT4oKSxcbiAgICBjYXB0dXJlczogY3JlYXRlSW5pdGlhbERpYWdub3N0aWNzUGhhc2VTdGF0ZTxDYXB0dXJlc0RhdGE+KCksXG4gICAgcmVzb2x2ZVJlcXVlc3Q6IHsgcGVuZGluZzogZmFsc2UsIGxhc3RFcnJvcjogbnVsbCwgbGFzdFJlc3VsdDogbnVsbCB9LFxuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTZXR0aW5ncyBwYW5lbCBzdGF0ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IHR5cGUgQ29tbWFuZFN1cmZhY2VTZXR0aW5nc1N0YXRlID0gQ29tbWFuZFN1cmZhY2VEaWFnbm9zdGljc1BoYXNlU3RhdGU8U2V0dGluZ3NEYXRhPlxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlSW5pdGlhbFNldHRpbmdzU3RhdGUoKTogQ29tbWFuZFN1cmZhY2VTZXR0aW5nc1N0YXRlIHtcbiAgcmV0dXJuIGNyZWF0ZUluaXRpYWxEaWFnbm9zdGljc1BoYXNlU3RhdGU8U2V0dGluZ3NEYXRhPigpXG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZW1haW5pbmcgY29tbWFuZCBzdXJmYWNlcyBzdGF0ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBDb21tYW5kU3VyZmFjZVJlbWFpbmluZ1N0YXRlIHtcbiAgaGlzdG9yeTogQ29tbWFuZFN1cmZhY2VEaWFnbm9zdGljc1BoYXNlU3RhdGU8SGlzdG9yeURhdGE+XG4gIGluc3BlY3Q6IENvbW1hbmRTdXJmYWNlRGlhZ25vc3RpY3NQaGFzZVN0YXRlPEluc3BlY3REYXRhPlxuICBob29rczogQ29tbWFuZFN1cmZhY2VEaWFnbm9zdGljc1BoYXNlU3RhdGU8SG9va3NEYXRhPlxuICBleHBvcnREYXRhOiBDb21tYW5kU3VyZmFjZURpYWdub3N0aWNzUGhhc2VTdGF0ZTxFeHBvcnRSZXN1bHQ+XG4gIHVuZG86IENvbW1hbmRTdXJmYWNlRGlhZ25vc3RpY3NQaGFzZVN0YXRlPFVuZG9JbmZvPlxuICBjbGVhbnVwOiBDb21tYW5kU3VyZmFjZURpYWdub3N0aWNzUGhhc2VTdGF0ZTxDbGVhbnVwRGF0YT5cbiAgc3RlZXI6IENvbW1hbmRTdXJmYWNlRGlhZ25vc3RpY3NQaGFzZVN0YXRlPFN0ZWVyRGF0YT5cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUluaXRpYWxSZW1haW5pbmdTdGF0ZSgpOiBDb21tYW5kU3VyZmFjZVJlbWFpbmluZ1N0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICBoaXN0b3J5OiBjcmVhdGVJbml0aWFsRGlhZ25vc3RpY3NQaGFzZVN0YXRlPEhpc3RvcnlEYXRhPigpLFxuICAgIGluc3BlY3Q6IGNyZWF0ZUluaXRpYWxEaWFnbm9zdGljc1BoYXNlU3RhdGU8SW5zcGVjdERhdGE+KCksXG4gICAgaG9va3M6IGNyZWF0ZUluaXRpYWxEaWFnbm9zdGljc1BoYXNlU3RhdGU8SG9va3NEYXRhPigpLFxuICAgIGV4cG9ydERhdGE6IGNyZWF0ZUluaXRpYWxEaWFnbm9zdGljc1BoYXNlU3RhdGU8RXhwb3J0UmVzdWx0PigpLFxuICAgIHVuZG86IGNyZWF0ZUluaXRpYWxEaWFnbm9zdGljc1BoYXNlU3RhdGU8VW5kb0luZm8+KCksXG4gICAgY2xlYW51cDogY3JlYXRlSW5pdGlhbERpYWdub3N0aWNzUGhhc2VTdGF0ZTxDbGVhbnVwRGF0YT4oKSxcbiAgICBzdGVlcjogY3JlYXRlSW5pdGlhbERpYWdub3N0aWNzUGhhc2VTdGF0ZTxTdGVlckRhdGE+KCksXG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3Jrc3BhY2VDb21tYW5kU3VyZmFjZVN0YXRlIHtcbiAgb3BlbjogYm9vbGVhblxuICBhY3RpdmVTdXJmYWNlOiBCcm93c2VyU2xhc2hDb21tYW5kU3VyZmFjZSB8IG51bGxcbiAgc291cmNlOiBDb21tYW5kU3VyZmFjZVNvdXJjZSB8IG51bGxcbiAgc2VjdGlvbjogQ29tbWFuZFN1cmZhY2VTZWN0aW9uIHwgbnVsbFxuICBhcmdzOiBzdHJpbmdcbiAgcGVuZGluZ0FjdGlvbjogQ29tbWFuZFN1cmZhY2VQZW5kaW5nQWN0aW9uIHwgbnVsbFxuICBzZWxlY3RlZFRhcmdldDogQ29tbWFuZFN1cmZhY2VUYXJnZXQgfCBudWxsXG4gIGxhc3RFcnJvcjogc3RyaW5nIHwgbnVsbFxuICBsYXN0UmVzdWx0OiBzdHJpbmcgfCBudWxsXG4gIGF2YWlsYWJsZU1vZGVsczogQ29tbWFuZFN1cmZhY2VNb2RlbE9wdGlvbltdXG4gIGZvcmtNZXNzYWdlczogQ29tbWFuZFN1cmZhY2VGb3JrTWVzc2FnZVtdXG4gIHNlc3Npb25TdGF0czogQ29tbWFuZFN1cmZhY2VTZXNzaW9uU3RhdHMgfCBudWxsXG4gIGxhc3RDb21wYWN0aW9uOiBDb21tYW5kU3VyZmFjZUNvbXBhY3Rpb25SZXN1bHQgfCBudWxsXG4gIGdpdFN1bW1hcnk6IENvbW1hbmRTdXJmYWNlR2l0U3VtbWFyeVN0YXRlXG4gIHJlY292ZXJ5OiBDb21tYW5kU3VyZmFjZVJlY292ZXJ5U3RhdGVcbiAgZGlhZ25vc3RpY3M6IENvbW1hbmRTdXJmYWNlRGlhZ25vc3RpY3NTdGF0ZVxuICBrbm93bGVkZ2VDYXB0dXJlczogQ29tbWFuZFN1cmZhY2VLbm93bGVkZ2VDYXB0dXJlc1N0YXRlXG4gIHNldHRpbmdzRGF0YTogQ29tbWFuZFN1cmZhY2VTZXR0aW5nc1N0YXRlXG4gIHJlbWFpbmluZ0NvbW1hbmRzOiBDb21tYW5kU3VyZmFjZVJlbWFpbmluZ1N0YXRlXG4gIHNlc3Npb25Ccm93c2VyOiBDb21tYW5kU3VyZmFjZVNlc3Npb25Ccm93c2VyU3RhdGVcbiAgcmVzdW1lUmVxdWVzdDogQ29tbWFuZFN1cmZhY2VTZXNzaW9uTXV0YXRpb25TdGF0ZVxuICByZW5hbWVSZXF1ZXN0OiBDb21tYW5kU3VyZmFjZVNlc3Npb25NdXRhdGlvblN0YXRlXG4gIHNldHRpbmdzUmVxdWVzdHM6IENvbW1hbmRTdXJmYWNlU2V0dGluZ3NNdXRhdGlvblN0YXRlXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tbWFuZFN1cmZhY2VPcGVuQ29udGV4dCB7XG4gIG9uYm9hcmRpbmdMb2NrZWQ/OiBib29sZWFuXG4gIGN1cnJlbnRNb2RlbD86IHsgcHJvdmlkZXI/OiBzdHJpbmc7IG1vZGVsSWQ/OiBzdHJpbmcgfSB8IG51bGxcbiAgY3VycmVudFRoaW5raW5nTGV2ZWw/OiBzdHJpbmcgfCBudWxsXG4gIHByZWZlcnJlZFByb3ZpZGVySWQ/OiBzdHJpbmcgfCBudWxsXG4gIHJlc3VtYWJsZVNlc3Npb25zPzogQ29tbWFuZFN1cmZhY2VSZXN1bWFibGVTZXNzaW9uW11cbiAgY3VycmVudFNlc3Npb25QYXRoPzogc3RyaW5nIHwgbnVsbFxuICBjdXJyZW50U2Vzc2lvbk5hbWU/OiBzdHJpbmcgfCBudWxsXG4gIHByb2plY3RDd2Q/OiBzdHJpbmcgfCBudWxsXG4gIHByb2plY3RTZXNzaW9uc0Rpcj86IHN0cmluZyB8IG51bGxcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb21tYW5kU3VyZmFjZU9wZW5SZXF1ZXN0IGV4dGVuZHMgQ29tbWFuZFN1cmZhY2VPcGVuQ29udGV4dCB7XG4gIHN1cmZhY2U6IEJyb3dzZXJTbGFzaENvbW1hbmRTdXJmYWNlXG4gIHNvdXJjZTogQ29tbWFuZFN1cmZhY2VTb3VyY2VcbiAgYXJncz86IHN0cmluZ1xuICBzZWxlY3RlZFRhcmdldD86IENvbW1hbmRTdXJmYWNlVGFyZ2V0IHwgbnVsbFxufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbW1hbmRTdXJmYWNlQWN0aW9uUmVzdWx0IHtcbiAgYWN0aW9uOiBDb21tYW5kU3VyZmFjZVBlbmRpbmdBY3Rpb25cbiAgc3VjY2VzczogYm9vbGVhblxuICBtZXNzYWdlOiBzdHJpbmdcbiAgc2VsZWN0ZWRUYXJnZXQ/OiBDb21tYW5kU3VyZmFjZVRhcmdldCB8IG51bGxcbiAgYXZhaWxhYmxlTW9kZWxzPzogQ29tbWFuZFN1cmZhY2VNb2RlbE9wdGlvbltdXG4gIGZvcmtNZXNzYWdlcz86IENvbW1hbmRTdXJmYWNlRm9ya01lc3NhZ2VbXVxuICBzZXNzaW9uU3RhdHM/OiBDb21tYW5kU3VyZmFjZVNlc3Npb25TdGF0cyB8IG51bGxcbiAgbGFzdENvbXBhY3Rpb24/OiBDb21tYW5kU3VyZmFjZUNvbXBhY3Rpb25SZXN1bHQgfCBudWxsXG4gIGdpdFN1bW1hcnk/OiBDb21tYW5kU3VyZmFjZUdpdFN1bW1hcnlTdGF0ZVxuICByZWNvdmVyeT86IENvbW1hbmRTdXJmYWNlUmVjb3ZlcnlTdGF0ZVxuICBzZXNzaW9uQnJvd3Nlcj86IENvbW1hbmRTdXJmYWNlU2Vzc2lvbkJyb3dzZXJTdGF0ZVxufVxuXG5jb25zdCBBVVRIX1NVUkZBQ0VfQ09NTUFORFMgPSBuZXcgU2V0PEJyb3dzZXJTbGFzaENvbW1hbmRTdXJmYWNlPihbXCJzZXR0aW5nc1wiLCBcImxvZ2luXCIsIFwibG9nb3V0XCJdKVxuY29uc3QgU0VUVElOR1NfTVVUQVRJT05fQUNUSU9OX1RPX1JFUVVFU1Q6IFBhcnRpYWw8XG4gIFJlY29yZDxDb21tYW5kU3VyZmFjZVBlbmRpbmdBY3Rpb24sIGtleW9mIENvbW1hbmRTdXJmYWNlU2V0dGluZ3NNdXRhdGlvblN0YXRlPlxuPiA9IHtcbiAgc2V0X3N0ZWVyaW5nX21vZGU6IFwic3RlZXJpbmdNb2RlXCIsXG4gIHNldF9mb2xsb3dfdXBfbW9kZTogXCJmb2xsb3dVcE1vZGVcIixcbiAgc2V0X2F1dG9fY29tcGFjdGlvbjogXCJhdXRvQ29tcGFjdGlvblwiLFxuICBzZXRfYXV0b19yZXRyeTogXCJhdXRvUmV0cnlcIixcbiAgYWJvcnRfcmV0cnk6IFwiYWJvcnRSZXRyeVwiLFxufVxuXG5mdW5jdGlvbiBtYXRjaGluZ1Nlc3Npb25QYXRoKFxuICBzZXNzaW9uczogQ29tbWFuZFN1cmZhY2VSZXN1bWFibGVTZXNzaW9uW10gfCB1bmRlZmluZWQsXG4gIHF1ZXJ5OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBpZiAoIXNlc3Npb25zPy5sZW5ndGgpIHJldHVybiB1bmRlZmluZWRcbiAgY29uc3Qgbm9ybWFsaXplZFF1ZXJ5ID0gcXVlcnk/LnRyaW0oKS50b0xvd2VyQ2FzZSgpXG4gIGlmICghbm9ybWFsaXplZFF1ZXJ5KSB7XG4gICAgcmV0dXJuIHNlc3Npb25zLmZpbmQoKHNlc3Npb24pID0+ICFzZXNzaW9uLmlzQWN0aXZlKT8ucGF0aCA/PyBzZXNzaW9uc1swXT8ucGF0aFxuICB9XG5cbiAgY29uc3QgZXhhY3RNYXRjaCA9IHNlc3Npb25zLmZpbmQoKHNlc3Npb24pID0+IHtcbiAgICBjb25zdCB2YWx1ZXMgPSBbc2Vzc2lvbi5pZCwgc2Vzc2lvbi5uYW1lLCBzZXNzaW9uLnBhdGhdLmZpbHRlcihCb29sZWFuKS5tYXAoKHZhbHVlKSA9PiB2YWx1ZSEudG9Mb3dlckNhc2UoKSlcbiAgICByZXR1cm4gdmFsdWVzLmluY2x1ZGVzKG5vcm1hbGl6ZWRRdWVyeSlcbiAgfSlcbiAgaWYgKGV4YWN0TWF0Y2gpIHJldHVybiBleGFjdE1hdGNoLnBhdGhcblxuICByZXR1cm4gc2Vzc2lvbnMuZmluZCgoc2Vzc2lvbikgPT4ge1xuICAgIGNvbnN0IHZhbHVlcyA9IFtzZXNzaW9uLmlkLCBzZXNzaW9uLm5hbWUsIHNlc3Npb24ucGF0aF0uZmlsdGVyKEJvb2xlYW4pLm1hcCgodmFsdWUpID0+IHZhbHVlIS50b0xvd2VyQ2FzZSgpKVxuICAgIHJldHVybiB2YWx1ZXMuc29tZSgodmFsdWUpID0+IHZhbHVlLmluY2x1ZGVzKG5vcm1hbGl6ZWRRdWVyeSkpXG4gIH0pPy5wYXRoXG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUluaXRpYWxDb21tYW5kU3VyZmFjZVNlc3Npb25Ccm93c2VyU3RhdGUoXG4gIG92ZXJyaWRlczogUGFydGlhbDxDb21tYW5kU3VyZmFjZVNlc3Npb25Ccm93c2VyU3RhdGU+ID0ge30sXG4pOiBDb21tYW5kU3VyZmFjZVNlc3Npb25Ccm93c2VyU3RhdGUge1xuICByZXR1cm4ge1xuICAgIHNjb3BlOiBudWxsLFxuICAgIHByb2plY3RDd2Q6IG51bGwsXG4gICAgcHJvamVjdFNlc3Npb25zRGlyOiBudWxsLFxuICAgIGFjdGl2ZVNlc3Npb25QYXRoOiBudWxsLFxuICAgIHF1ZXJ5OiBcIlwiLFxuICAgIHNvcnRNb2RlOiBcInRocmVhZGVkXCIsXG4gICAgbmFtZUZpbHRlcjogXCJhbGxcIixcbiAgICB0b3RhbFNlc3Npb25zOiAwLFxuICAgIHJldHVybmVkU2Vzc2lvbnM6IDAsXG4gICAgc2Vzc2lvbnM6IFtdLFxuICAgIGxvYWRlZDogZmFsc2UsXG4gICAgZXJyb3I6IG51bGwsXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUluaXRpYWxDb21tYW5kU3VyZmFjZVNlc3Npb25NdXRhdGlvblN0YXRlKCk6IENvbW1hbmRTdXJmYWNlU2Vzc2lvbk11dGF0aW9uU3RhdGUge1xuICByZXR1cm4ge1xuICAgIHBlbmRpbmc6IGZhbHNlLFxuICAgIHNlc3Npb25QYXRoOiBudWxsLFxuICAgIHJlc3VsdDogbnVsbCxcbiAgICBlcnJvcjogbnVsbCxcbiAgfVxufVxuXG5mdW5jdGlvbiBjcmVhdGVJbml0aWFsQ29tbWFuZFN1cmZhY2VTZXR0aW5nTXV0YXRpb25TdGF0ZSgpOiBDb21tYW5kU3VyZmFjZVNldHRpbmdNdXRhdGlvblN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICBwZW5kaW5nOiBmYWxzZSxcbiAgICByZXN1bHQ6IG51bGwsXG4gICAgZXJyb3I6IG51bGwsXG4gIH1cbn1cblxuZnVuY3Rpb24gY3JlYXRlSW5pdGlhbENvbW1hbmRTdXJmYWNlU2V0dGluZ3NNdXRhdGlvblN0YXRlKCk6IENvbW1hbmRTdXJmYWNlU2V0dGluZ3NNdXRhdGlvblN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICBzdGVlcmluZ01vZGU6IGNyZWF0ZUluaXRpYWxDb21tYW5kU3VyZmFjZVNldHRpbmdNdXRhdGlvblN0YXRlKCksXG4gICAgZm9sbG93VXBNb2RlOiBjcmVhdGVJbml0aWFsQ29tbWFuZFN1cmZhY2VTZXR0aW5nTXV0YXRpb25TdGF0ZSgpLFxuICAgIGF1dG9Db21wYWN0aW9uOiBjcmVhdGVJbml0aWFsQ29tbWFuZFN1cmZhY2VTZXR0aW5nTXV0YXRpb25TdGF0ZSgpLFxuICAgIGF1dG9SZXRyeTogY3JlYXRlSW5pdGlhbENvbW1hbmRTdXJmYWNlU2V0dGluZ011dGF0aW9uU3RhdGUoKSxcbiAgICBhYm9ydFJldHJ5OiBjcmVhdGVJbml0aWFsQ29tbWFuZFN1cmZhY2VTZXR0aW5nTXV0YXRpb25TdGF0ZSgpLFxuICB9XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUluaXRpYWxDb21tYW5kU3VyZmFjZUdpdFN1bW1hcnlTdGF0ZSgpOiBDb21tYW5kU3VyZmFjZUdpdFN1bW1hcnlTdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgcGVuZGluZzogZmFsc2UsXG4gICAgbG9hZGVkOiBmYWxzZSxcbiAgICByZXN1bHQ6IG51bGwsXG4gICAgZXJyb3I6IG51bGwsXG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUluaXRpYWxDb21tYW5kU3VyZmFjZVJlY292ZXJ5U3RhdGUoKTogQ29tbWFuZFN1cmZhY2VSZWNvdmVyeVN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICBwaGFzZTogXCJpZGxlXCIsXG4gICAgcGVuZGluZzogZmFsc2UsXG4gICAgbG9hZGVkOiBmYWxzZSxcbiAgICBzdGFsZTogZmFsc2UsXG4gICAgZGlhZ25vc3RpY3M6IG51bGwsXG4gICAgZXJyb3I6IG51bGwsXG4gICAgbGFzdExvYWRlZEF0OiBudWxsLFxuICAgIGxhc3RJbnZhbGlkYXRlZEF0OiBudWxsLFxuICAgIGxhc3RGYWlsdXJlQXQ6IG51bGwsXG4gIH1cbn1cblxuZnVuY3Rpb24gYnVpbGRJbml0aWFsU2Vzc2lvbkJyb3dzZXJTdGF0ZShyZXF1ZXN0OiBDb21tYW5kU3VyZmFjZU9wZW5SZXF1ZXN0KTogQ29tbWFuZFN1cmZhY2VTZXNzaW9uQnJvd3NlclN0YXRlIHtcbiAgY29uc3QgaW5pdGlhbFF1ZXJ5ID0gcmVxdWVzdC5zdXJmYWNlID09PSBcInJlc3VtZVwiID8gcmVxdWVzdC5hcmdzPy50cmltKCkgPz8gXCJcIiA6IFwiXCJcbiAgcmV0dXJuIGNyZWF0ZUluaXRpYWxDb21tYW5kU3VyZmFjZVNlc3Npb25Ccm93c2VyU3RhdGUoe1xuICAgIGFjdGl2ZVNlc3Npb25QYXRoOiByZXF1ZXN0LmN1cnJlbnRTZXNzaW9uUGF0aCA/PyBudWxsLFxuICAgIHByb2plY3RDd2Q6IHJlcXVlc3QucHJvamVjdEN3ZCA/PyBudWxsLFxuICAgIHByb2plY3RTZXNzaW9uc0RpcjogcmVxdWVzdC5wcm9qZWN0U2Vzc2lvbnNEaXIgPz8gbnVsbCxcbiAgICBxdWVyeTogaW5pdGlhbFF1ZXJ5LFxuICAgIHNvcnRNb2RlOiBpbml0aWFsUXVlcnkgPyBcInJlbGV2YW5jZVwiIDogXCJ0aHJlYWRlZFwiLFxuICB9KVxufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNDb21tYW5kU3VyZmFjZVRoaW5raW5nTGV2ZWwodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiB2YWx1ZSBpcyBDb21tYW5kU3VyZmFjZVRoaW5raW5nTGV2ZWwge1xuICByZXR1cm4gQ09NTUFORF9TVVJGQUNFX1RISU5LSU5HX0xFVkVMUy5pbmNsdWRlcygodmFsdWUgPz8gXCJcIikgYXMgQ29tbWFuZFN1cmZhY2VUaGlua2luZ0xldmVsKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlSW5pdGlhbENvbW1hbmRTdXJmYWNlU3RhdGUoKTogV29ya3NwYWNlQ29tbWFuZFN1cmZhY2VTdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgb3BlbjogZmFsc2UsXG4gICAgYWN0aXZlU3VyZmFjZTogbnVsbCxcbiAgICBzb3VyY2U6IG51bGwsXG4gICAgc2VjdGlvbjogbnVsbCxcbiAgICBhcmdzOiBcIlwiLFxuICAgIHBlbmRpbmdBY3Rpb246IG51bGwsXG4gICAgc2VsZWN0ZWRUYXJnZXQ6IG51bGwsXG4gICAgbGFzdEVycm9yOiBudWxsLFxuICAgIGxhc3RSZXN1bHQ6IG51bGwsXG4gICAgYXZhaWxhYmxlTW9kZWxzOiBbXSxcbiAgICBmb3JrTWVzc2FnZXM6IFtdLFxuICAgIHNlc3Npb25TdGF0czogbnVsbCxcbiAgICBsYXN0Q29tcGFjdGlvbjogbnVsbCxcbiAgICBnaXRTdW1tYXJ5OiBjcmVhdGVJbml0aWFsQ29tbWFuZFN1cmZhY2VHaXRTdW1tYXJ5U3RhdGUoKSxcbiAgICByZWNvdmVyeTogY3JlYXRlSW5pdGlhbENvbW1hbmRTdXJmYWNlUmVjb3ZlcnlTdGF0ZSgpLFxuICAgIGRpYWdub3N0aWNzOiBjcmVhdGVJbml0aWFsRGlhZ25vc3RpY3NTdGF0ZSgpLFxuICAgIGtub3dsZWRnZUNhcHR1cmVzOiBjcmVhdGVJbml0aWFsS25vd2xlZGdlQ2FwdHVyZXNTdGF0ZSgpLFxuICAgIHNldHRpbmdzRGF0YTogY3JlYXRlSW5pdGlhbFNldHRpbmdzU3RhdGUoKSxcbiAgICByZW1haW5pbmdDb21tYW5kczogY3JlYXRlSW5pdGlhbFJlbWFpbmluZ1N0YXRlKCksXG4gICAgc2Vzc2lvbkJyb3dzZXI6IGNyZWF0ZUluaXRpYWxDb21tYW5kU3VyZmFjZVNlc3Npb25Ccm93c2VyU3RhdGUoKSxcbiAgICByZXN1bWVSZXF1ZXN0OiBjcmVhdGVJbml0aWFsQ29tbWFuZFN1cmZhY2VTZXNzaW9uTXV0YXRpb25TdGF0ZSgpLFxuICAgIHJlbmFtZVJlcXVlc3Q6IGNyZWF0ZUluaXRpYWxDb21tYW5kU3VyZmFjZVNlc3Npb25NdXRhdGlvblN0YXRlKCksXG4gICAgc2V0dGluZ3NSZXF1ZXN0czogY3JlYXRlSW5pdGlhbENvbW1hbmRTdXJmYWNlU2V0dGluZ3NNdXRhdGlvblN0YXRlKCksXG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRTdXJmYWNlU2VjdGlvbkZvclJlcXVlc3QocmVxdWVzdDogQ29tbWFuZFN1cmZhY2VPcGVuUmVxdWVzdCk6IENvbW1hbmRTdXJmYWNlU2VjdGlvbiB8IG51bGwge1xuICBzd2l0Y2ggKHJlcXVlc3Quc3VyZmFjZSkge1xuICAgIGNhc2UgXCJtb2RlbFwiOlxuICAgICAgcmV0dXJuIFwibW9kZWxcIlxuICAgIGNhc2UgXCJ0aGlua2luZ1wiOlxuICAgICAgcmV0dXJuIFwidGhpbmtpbmdcIlxuICAgIGNhc2UgXCJzZXR0aW5nc1wiOlxuICAgICAgcmV0dXJuIHJlcXVlc3Qub25ib2FyZGluZ0xvY2tlZCA/IFwiYXV0aFwiIDogXCJnZW5lcmFsXCJcbiAgICBjYXNlIFwiZ2l0XCI6XG4gICAgICByZXR1cm4gXCJnaXRcIlxuICAgIGNhc2UgXCJsb2dpblwiOlxuICAgIGNhc2UgXCJsb2dvdXRcIjpcbiAgICAgIHJldHVybiBcImF1dGhcIlxuICAgIGNhc2UgXCJyZXN1bWVcIjpcbiAgICAgIHJldHVybiBcInJlc3VtZVwiXG4gICAgY2FzZSBcIm5hbWVcIjpcbiAgICAgIHJldHVybiBcIm5hbWVcIlxuICAgIGNhc2UgXCJmb3JrXCI6XG4gICAgICByZXR1cm4gXCJmb3JrXCJcbiAgICBjYXNlIFwic2Vzc2lvblwiOlxuICAgIGNhc2UgXCJleHBvcnRcIjpcbiAgICAgIHJldHVybiBcInNlc3Npb25cIlxuICAgIGNhc2UgXCJjb21wYWN0XCI6XG4gICAgICByZXR1cm4gXCJjb21wYWN0XCJcbiAgICAvLyBHU0Qgc3ViY29tbWFuZCBzdXJmYWNlcyAoUzAyKVxuICAgIGNhc2UgXCJnc2Qtc3RhdHVzXCI6IHJldHVybiBcImdzZC1zdGF0dXNcIlxuICAgIGNhc2UgXCJnc2QtdmlzdWFsaXplXCI6IHJldHVybiBcImdzZC12aXN1YWxpemVcIlxuICAgIGNhc2UgXCJnc2QtZm9yZW5zaWNzXCI6IHJldHVybiBcImdzZC1mb3JlbnNpY3NcIlxuICAgIGNhc2UgXCJnc2QtZG9jdG9yXCI6IHJldHVybiBcImdzZC1kb2N0b3JcIlxuICAgIGNhc2UgXCJnc2Qtc2tpbGwtaGVhbHRoXCI6IHJldHVybiBcImdzZC1za2lsbC1oZWFsdGhcIlxuICAgIGNhc2UgXCJnc2Qta25vd2xlZGdlXCI6IHJldHVybiBcImdzZC1rbm93bGVkZ2VcIlxuICAgIGNhc2UgXCJnc2QtY2FwdHVyZVwiOiByZXR1cm4gXCJnc2QtY2FwdHVyZVwiXG4gICAgY2FzZSBcImdzZC10cmlhZ2VcIjogcmV0dXJuIFwiZ3NkLXRyaWFnZVwiXG4gICAgY2FzZSBcImdzZC1xdWlja1wiOiByZXR1cm4gXCJnc2QtcXVpY2tcIlxuICAgIGNhc2UgXCJnc2QtaGlzdG9yeVwiOiByZXR1cm4gXCJnc2QtaGlzdG9yeVwiXG4gICAgY2FzZSBcImdzZC11bmRvXCI6IHJldHVybiBcImdzZC11bmRvXCJcbiAgICBjYXNlIFwiZ3NkLWluc3BlY3RcIjogcmV0dXJuIFwiZ3NkLWluc3BlY3RcIlxuICAgIGNhc2UgXCJnc2QtcHJlZnNcIjogcmV0dXJuIFwiZ3NkLXByZWZzXCJcbiAgICBjYXNlIFwiZ3NkLWNvbmZpZ1wiOiByZXR1cm4gXCJnc2QtY29uZmlnXCJcbiAgICBjYXNlIFwiZ3NkLWhvb2tzXCI6IHJldHVybiBcImdzZC1ob29rc1wiXG4gICAgY2FzZSBcImdzZC1tb2RlXCI6IHJldHVybiBcImdzZC1tb2RlXCJcbiAgICBjYXNlIFwiZ3NkLXN0ZWVyXCI6IHJldHVybiBcImdzZC1zdGVlclwiXG4gICAgY2FzZSBcImdzZC1leHBvcnRcIjogcmV0dXJuIFwiZ3NkLWV4cG9ydFwiXG4gICAgY2FzZSBcImdzZC1jbGVhbnVwXCI6IHJldHVybiBcImdzZC1jbGVhbnVwXCJcbiAgICBjYXNlIFwiZ3NkLXF1ZXVlXCI6IHJldHVybiBcImdzZC1xdWV1ZVwiXG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiBudWxsXG4gIH1cbn1cblxuZnVuY3Rpb24gYnVpbGRTZXR0aW5nc1RhcmdldChzZWN0aW9uOiBDb21tYW5kU3VyZmFjZVNlY3Rpb24pOiBDb21tYW5kU3VyZmFjZVRhcmdldCB7XG4gIHJldHVybiB7IGtpbmQ6IFwic2V0dGluZ3NcIiwgc2VjdGlvbiB9XG59XG5cbmZ1bmN0aW9uIGJ1aWxkTW9kZWxUYXJnZXQocmVxdWVzdDogQ29tbWFuZFN1cmZhY2VPcGVuUmVxdWVzdCk6IENvbW1hbmRTdXJmYWNlVGFyZ2V0IHtcbiAgY29uc3QgcXVlcnkgPSByZXF1ZXN0LmFyZ3M/LnRyaW0oKSB8fCB1bmRlZmluZWRcbiAgcmV0dXJuIHtcbiAgICBraW5kOiBcIm1vZGVsXCIsXG4gICAgcHJvdmlkZXI6IHJlcXVlc3QuY3VycmVudE1vZGVsPy5wcm92aWRlcixcbiAgICBtb2RlbElkOiByZXF1ZXN0LmN1cnJlbnRNb2RlbD8ubW9kZWxJZCxcbiAgICBxdWVyeSxcbiAgfVxufVxuXG5mdW5jdGlvbiBidWlsZFRoaW5raW5nVGFyZ2V0KHJlcXVlc3Q6IENvbW1hbmRTdXJmYWNlT3BlblJlcXVlc3QpOiBDb21tYW5kU3VyZmFjZVRhcmdldCB7XG4gIGNvbnN0IHJlcXVlc3RlZExldmVsID0gcmVxdWVzdC5hcmdzPy50cmltKCkudG9Mb3dlckNhc2UoKSB8fCBcIlwiXG4gIGNvbnN0IGxldmVsID0gaXNDb21tYW5kU3VyZmFjZVRoaW5raW5nTGV2ZWwocmVxdWVzdGVkTGV2ZWwpXG4gICAgPyByZXF1ZXN0ZWRMZXZlbFxuICAgIDogaXNDb21tYW5kU3VyZmFjZVRoaW5raW5nTGV2ZWwocmVxdWVzdC5jdXJyZW50VGhpbmtpbmdMZXZlbClcbiAgICAgID8gcmVxdWVzdC5jdXJyZW50VGhpbmtpbmdMZXZlbFxuICAgICAgOiBcIm9mZlwiXG5cbiAgcmV0dXJuIHtcbiAgICBraW5kOiBcInRoaW5raW5nXCIsXG4gICAgbGV2ZWwsXG4gIH1cbn1cblxuZnVuY3Rpb24gYnVpbGRBdXRoVGFyZ2V0KHJlcXVlc3Q6IENvbW1hbmRTdXJmYWNlT3BlblJlcXVlc3QpOiBDb21tYW5kU3VyZmFjZVRhcmdldCB7XG4gIGNvbnN0IHJlcXVlc3RlZFByb3ZpZGVySWQgPSByZXF1ZXN0LmFyZ3M/LnRyaW0oKSB8fCB1bmRlZmluZWRcbiAgcmV0dXJuIHtcbiAgICBraW5kOiBcImF1dGhcIixcbiAgICBwcm92aWRlcklkOiByZXF1ZXN0ZWRQcm92aWRlcklkID8/IHJlcXVlc3QucHJlZmVycmVkUHJvdmlkZXJJZCA/PyB1bmRlZmluZWQsXG4gICAgaW50ZW50OiByZXF1ZXN0LnN1cmZhY2UgPT09IFwibG9naW5cIiA/IFwibG9naW5cIiA6IHJlcXVlc3Quc3VyZmFjZSA9PT0gXCJsb2dvdXRcIiA/IFwibG9nb3V0XCIgOiBcIm1hbmFnZVwiLFxuICB9XG59XG5cbmZ1bmN0aW9uIGJ1aWxkUmVzdW1lVGFyZ2V0KHJlcXVlc3Q6IENvbW1hbmRTdXJmYWNlT3BlblJlcXVlc3QpOiBFeHRyYWN0PENvbW1hbmRTdXJmYWNlVGFyZ2V0LCB7IGtpbmQ6IFwicmVzdW1lXCIgfT4ge1xuICBjb25zdCBzZWxlY3RlZFBhdGggPSBtYXRjaGluZ1Nlc3Npb25QYXRoKHJlcXVlc3QucmVzdW1hYmxlU2Vzc2lvbnMsIHJlcXVlc3QuYXJncylcbiAgcmV0dXJuIHtcbiAgICBraW5kOiBcInJlc3VtZVwiLFxuICAgIHNlc3Npb25QYXRoOiBzZWxlY3RlZFBhdGgsXG4gIH1cbn1cblxuZnVuY3Rpb24gYnVpbGROYW1lVGFyZ2V0KHJlcXVlc3Q6IENvbW1hbmRTdXJmYWNlT3BlblJlcXVlc3QpOiBDb21tYW5kU3VyZmFjZVRhcmdldCB7XG4gIGNvbnN0IHByb3ZpZGVkTmFtZSA9IHJlcXVlc3QuYXJncz8udHJpbSgpXG4gIHJldHVybiB7XG4gICAga2luZDogXCJuYW1lXCIsXG4gICAgc2Vzc2lvblBhdGg6IHJlcXVlc3QuY3VycmVudFNlc3Npb25QYXRoID8/IHVuZGVmaW5lZCxcbiAgICBuYW1lOiBwcm92aWRlZE5hbWUgIT09IHVuZGVmaW5lZCAmJiBwcm92aWRlZE5hbWUubGVuZ3RoID4gMCA/IHByb3ZpZGVkTmFtZSA6IHJlcXVlc3QuY3VycmVudFNlc3Npb25OYW1lPy50cmltKCkgPz8gXCJcIixcbiAgfVxufVxuXG5mdW5jdGlvbiBidWlsZEZvcmtUYXJnZXQocmVxdWVzdDogQ29tbWFuZFN1cmZhY2VPcGVuUmVxdWVzdCk6IENvbW1hbmRTdXJmYWNlVGFyZ2V0IHtcbiAgY29uc3QgZW50cnlJZCA9IHJlcXVlc3QuYXJncz8udHJpbSgpIHx8IHVuZGVmaW5lZFxuICByZXR1cm4ge1xuICAgIGtpbmQ6IFwiZm9ya1wiLFxuICAgIGVudHJ5SWQsXG4gIH1cbn1cblxuZnVuY3Rpb24gYnVpbGRTZXNzaW9uVGFyZ2V0KHJlcXVlc3Q6IENvbW1hbmRTdXJmYWNlT3BlblJlcXVlc3QpOiBDb21tYW5kU3VyZmFjZVRhcmdldCB7XG4gIGNvbnN0IG91dHB1dFBhdGggPSByZXF1ZXN0LmFyZ3M/LnRyaW0oKSB8fCB1bmRlZmluZWRcbiAgcmV0dXJuIHtcbiAgICBraW5kOiBcInNlc3Npb25cIixcbiAgICBvdXRwdXRQYXRoLFxuICB9XG59XG5cbmZ1bmN0aW9uIGJ1aWxkQ29tcGFjdFRhcmdldChyZXF1ZXN0OiBDb21tYW5kU3VyZmFjZU9wZW5SZXF1ZXN0KTogQ29tbWFuZFN1cmZhY2VUYXJnZXQge1xuICByZXR1cm4ge1xuICAgIGtpbmQ6IFwiY29tcGFjdFwiLFxuICAgIGN1c3RvbUluc3RydWN0aW9uczogcmVxdWVzdC5hcmdzPy50cmltKCkgPz8gXCJcIixcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRDb21tYW5kU3VyZmFjZVRhcmdldChyZXF1ZXN0OiBDb21tYW5kU3VyZmFjZU9wZW5SZXF1ZXN0KTogQ29tbWFuZFN1cmZhY2VUYXJnZXQgfCBudWxsIHtcbiAgaWYgKHJlcXVlc3Quc2VsZWN0ZWRUYXJnZXQgIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiByZXF1ZXN0LnNlbGVjdGVkVGFyZ2V0XG4gIH1cblxuICBjb25zdCBzZWN0aW9uID0gY29tbWFuZFN1cmZhY2VTZWN0aW9uRm9yUmVxdWVzdChyZXF1ZXN0KVxuICBpZiAoIXNlY3Rpb24pIHJldHVybiBudWxsXG5cbiAgaWYgKHJlcXVlc3Quc3VyZmFjZSA9PT0gXCJzZXR0aW5nc1wiKSB7XG4gICAgcmV0dXJuIGJ1aWxkU2V0dGluZ3NUYXJnZXQoc2VjdGlvbilcbiAgfVxuXG4gIGlmIChyZXF1ZXN0LnN1cmZhY2UgPT09IFwibW9kZWxcIikge1xuICAgIHJldHVybiBidWlsZE1vZGVsVGFyZ2V0KHJlcXVlc3QpXG4gIH1cblxuICBpZiAocmVxdWVzdC5zdXJmYWNlID09PSBcInRoaW5raW5nXCIpIHtcbiAgICByZXR1cm4gYnVpbGRUaGlua2luZ1RhcmdldChyZXF1ZXN0KVxuICB9XG5cbiAgaWYgKEFVVEhfU1VSRkFDRV9DT01NQU5EUy5oYXMocmVxdWVzdC5zdXJmYWNlKSkge1xuICAgIHJldHVybiBidWlsZEF1dGhUYXJnZXQocmVxdWVzdClcbiAgfVxuXG4gIGlmIChyZXF1ZXN0LnN1cmZhY2UgPT09IFwicmVzdW1lXCIpIHtcbiAgICByZXR1cm4gYnVpbGRSZXN1bWVUYXJnZXQocmVxdWVzdClcbiAgfVxuXG4gIGlmIChyZXF1ZXN0LnN1cmZhY2UgPT09IFwibmFtZVwiKSB7XG4gICAgcmV0dXJuIGJ1aWxkTmFtZVRhcmdldChyZXF1ZXN0KVxuICB9XG5cbiAgaWYgKHJlcXVlc3Quc3VyZmFjZSA9PT0gXCJmb3JrXCIpIHtcbiAgICByZXR1cm4gYnVpbGRGb3JrVGFyZ2V0KHJlcXVlc3QpXG4gIH1cblxuICBpZiAocmVxdWVzdC5zdXJmYWNlID09PSBcInNlc3Npb25cIiB8fCByZXF1ZXN0LnN1cmZhY2UgPT09IFwiZXhwb3J0XCIpIHtcbiAgICByZXR1cm4gYnVpbGRTZXNzaW9uVGFyZ2V0KHJlcXVlc3QpXG4gIH1cblxuICBpZiAocmVxdWVzdC5zdXJmYWNlID09PSBcImNvbXBhY3RcIikge1xuICAgIHJldHVybiBidWlsZENvbXBhY3RUYXJnZXQocmVxdWVzdClcbiAgfVxuXG4gIC8vIEdTRCBzdWJjb21tYW5kIHN1cmZhY2VzIFx1MjAxNCBnZW5lcmljIHRhcmdldCAoUzAyKVxuICBpZiAocmVxdWVzdC5zdXJmYWNlPy5zdGFydHNXaXRoKFwiZ3NkLVwiKSkge1xuICAgIGNvbnN0IHN1YmNvbW1hbmQgPSByZXF1ZXN0LnN1cmZhY2Uuc2xpY2UoNCkgLy8gXCJnc2QtZm9yZW5zaWNzXCIgLT4gXCJmb3JlbnNpY3NcIlxuICAgIHJldHVybiB7IGtpbmQ6IFwiZ3NkXCIsIHN1cmZhY2U6IHJlcXVlc3Quc3VyZmFjZSwgc3ViY29tbWFuZCwgYXJnczogcmVxdWVzdC5hcmdzID8/IFwiXCIgfVxuICB9XG5cbiAgcmV0dXJuIGJ1aWxkU2V0dGluZ3NUYXJnZXQoc2VjdGlvbilcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG9wZW5Db21tYW5kU3VyZmFjZVN0YXRlKFxuICBjdXJyZW50OiBXb3Jrc3BhY2VDb21tYW5kU3VyZmFjZVN0YXRlLFxuICByZXF1ZXN0OiBDb21tYW5kU3VyZmFjZU9wZW5SZXF1ZXN0LFxuKTogV29ya3NwYWNlQ29tbWFuZFN1cmZhY2VTdGF0ZSB7XG4gIGNvbnN0IHNlY3Rpb24gPSBjb21tYW5kU3VyZmFjZVNlY3Rpb25Gb3JSZXF1ZXN0KHJlcXVlc3QpXG4gIHJldHVybiB7XG4gICAgLi4uY3VycmVudCxcbiAgICBvcGVuOiB0cnVlLFxuICAgIGFjdGl2ZVN1cmZhY2U6IHJlcXVlc3Quc3VyZmFjZSxcbiAgICBzb3VyY2U6IHJlcXVlc3Quc291cmNlLFxuICAgIHNlY3Rpb24sXG4gICAgYXJnczogcmVxdWVzdC5hcmdzPy50cmltKCkgPz8gXCJcIixcbiAgICBwZW5kaW5nQWN0aW9uOiBudWxsLFxuICAgIHNlbGVjdGVkVGFyZ2V0OiBidWlsZENvbW1hbmRTdXJmYWNlVGFyZ2V0KHJlcXVlc3QpLFxuICAgIGxhc3RFcnJvcjogbnVsbCxcbiAgICBsYXN0UmVzdWx0OiBudWxsLFxuICAgIHNlc3Npb25TdGF0czogbnVsbCxcbiAgICBmb3JrTWVzc2FnZXM6IFtdLFxuICAgIGxhc3RDb21wYWN0aW9uOiBudWxsLFxuICAgIGdpdFN1bW1hcnk6IGNyZWF0ZUluaXRpYWxDb21tYW5kU3VyZmFjZUdpdFN1bW1hcnlTdGF0ZSgpLFxuICAgIHJlY292ZXJ5OiBjcmVhdGVJbml0aWFsQ29tbWFuZFN1cmZhY2VSZWNvdmVyeVN0YXRlKCksXG4gICAgZGlhZ25vc3RpY3M6IGNyZWF0ZUluaXRpYWxEaWFnbm9zdGljc1N0YXRlKCksXG4gICAga25vd2xlZGdlQ2FwdHVyZXM6IGNyZWF0ZUluaXRpYWxLbm93bGVkZ2VDYXB0dXJlc1N0YXRlKCksXG4gICAgc2V0dGluZ3NEYXRhOiBjcmVhdGVJbml0aWFsU2V0dGluZ3NTdGF0ZSgpLFxuICAgIHJlbWFpbmluZ0NvbW1hbmRzOiBjcmVhdGVJbml0aWFsUmVtYWluaW5nU3RhdGUoKSxcbiAgICBzZXNzaW9uQnJvd3NlcjogYnVpbGRJbml0aWFsU2Vzc2lvbkJyb3dzZXJTdGF0ZShyZXF1ZXN0KSxcbiAgICByZXN1bWVSZXF1ZXN0OiBjcmVhdGVJbml0aWFsQ29tbWFuZFN1cmZhY2VTZXNzaW9uTXV0YXRpb25TdGF0ZSgpLFxuICAgIHJlbmFtZVJlcXVlc3Q6IGNyZWF0ZUluaXRpYWxDb21tYW5kU3VyZmFjZVNlc3Npb25NdXRhdGlvblN0YXRlKCksXG4gICAgc2V0dGluZ3NSZXF1ZXN0czogY3JlYXRlSW5pdGlhbENvbW1hbmRTdXJmYWNlU2V0dGluZ3NNdXRhdGlvblN0YXRlKCksXG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsb3NlQ29tbWFuZFN1cmZhY2VTdGF0ZShjdXJyZW50OiBXb3Jrc3BhY2VDb21tYW5kU3VyZmFjZVN0YXRlKTogV29ya3NwYWNlQ29tbWFuZFN1cmZhY2VTdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgLi4uY3VycmVudCxcbiAgICBvcGVuOiBmYWxzZSxcbiAgICBwZW5kaW5nQWN0aW9uOiBudWxsLFxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRDb21tYW5kU3VyZmFjZVNlY3Rpb24oXG4gIGN1cnJlbnQ6IFdvcmtzcGFjZUNvbW1hbmRTdXJmYWNlU3RhdGUsXG4gIHNlY3Rpb246IENvbW1hbmRTdXJmYWNlU2VjdGlvbixcbiAgY29udGV4dDogQ29tbWFuZFN1cmZhY2VPcGVuQ29udGV4dCA9IHt9LFxuKTogV29ya3NwYWNlQ29tbWFuZFN1cmZhY2VTdGF0ZSB7XG4gIGNvbnN0IHJlcXVlc3Q6IENvbW1hbmRTdXJmYWNlT3BlblJlcXVlc3QgPSB7XG4gICAgc3VyZmFjZTogY3VycmVudC5hY3RpdmVTdXJmYWNlID8/IFwic2V0dGluZ3NcIixcbiAgICBzb3VyY2U6IGN1cnJlbnQuc291cmNlID8/IFwic3VyZmFjZVwiLFxuICAgIGFyZ3M6IGN1cnJlbnQuYXJncyxcbiAgICAuLi5jb250ZXh0LFxuICB9XG5cbiAgY29uc3QgY3VycmVudFNlc3Npb25QYXRoID1cbiAgICBjdXJyZW50LnNlbGVjdGVkVGFyZ2V0Py5raW5kID09PSBcInJlc3VtZVwiXG4gICAgICA/IGN1cnJlbnQuc2VsZWN0ZWRUYXJnZXQuc2Vzc2lvblBhdGhcbiAgICAgIDogY3VycmVudC5zZWxlY3RlZFRhcmdldD8ua2luZCA9PT0gXCJuYW1lXCJcbiAgICAgICAgPyBjdXJyZW50LnNlbGVjdGVkVGFyZ2V0LnNlc3Npb25QYXRoXG4gICAgICAgIDogdW5kZWZpbmVkXG4gIGNvbnN0IGN1cnJlbnREcmFmdE5hbWUgPSBjdXJyZW50LnNlbGVjdGVkVGFyZ2V0Py5raW5kID09PSBcIm5hbWVcIiA/IGN1cnJlbnQuc2VsZWN0ZWRUYXJnZXQubmFtZSA6IHVuZGVmaW5lZFxuXG4gIGxldCBzZWxlY3RlZFRhcmdldDogQ29tbWFuZFN1cmZhY2VUYXJnZXQgfCBudWxsID0gY3VycmVudC5zZWxlY3RlZFRhcmdldFxuICBpZiAoc2VjdGlvbiA9PT0gXCJtb2RlbFwiKSB7XG4gICAgc2VsZWN0ZWRUYXJnZXQgPSBidWlsZE1vZGVsVGFyZ2V0KHJlcXVlc3QpXG4gIH0gZWxzZSBpZiAoc2VjdGlvbiA9PT0gXCJ0aGlua2luZ1wiKSB7XG4gICAgc2VsZWN0ZWRUYXJnZXQgPSBidWlsZFRoaW5raW5nVGFyZ2V0KHJlcXVlc3QpXG4gIH0gZWxzZSBpZiAoc2VjdGlvbiA9PT0gXCJnZW5lcmFsXCIgfHwgc2VjdGlvbiA9PT0gXCJzZXNzaW9uLWJlaGF2aW9yXCIgfHwgc2VjdGlvbiA9PT0gXCJxdWV1ZVwiIHx8IHNlY3Rpb24gPT09IFwiY29tcGFjdGlvblwiIHx8IHNlY3Rpb24gPT09IFwicmV0cnlcIiB8fCBzZWN0aW9uID09PSBcInJlY292ZXJ5XCIgfHwgc2VjdGlvbiA9PT0gXCJnaXRcIiB8fCBzZWN0aW9uID09PSBcImFkbWluXCIpIHtcbiAgICBzZWxlY3RlZFRhcmdldCA9IGJ1aWxkU2V0dGluZ3NUYXJnZXQoc2VjdGlvbilcbiAgfSBlbHNlIGlmIChzZWN0aW9uID09PSBcImF1dGhcIikge1xuICAgIHNlbGVjdGVkVGFyZ2V0ID0gYnVpbGRBdXRoVGFyZ2V0KHtcbiAgICAgIC4uLnJlcXVlc3QsXG4gICAgICBzdXJmYWNlOlxuICAgICAgICBjdXJyZW50LmFjdGl2ZVN1cmZhY2UgPT09IFwibG9nb3V0XCJcbiAgICAgICAgICA/IFwibG9nb3V0XCJcbiAgICAgICAgICA6IGN1cnJlbnQuYWN0aXZlU3VyZmFjZSA9PT0gXCJsb2dpblwiXG4gICAgICAgICAgICA/IFwibG9naW5cIlxuICAgICAgICAgICAgOiBcInNldHRpbmdzXCIsXG4gICAgfSlcbiAgfSBlbHNlIGlmIChzZWN0aW9uID09PSBcInJlc3VtZVwiKSB7XG4gICAgc2VsZWN0ZWRUYXJnZXQgPSB7IGtpbmQ6IFwicmVzdW1lXCIsIHNlc3Npb25QYXRoOiBjdXJyZW50U2Vzc2lvblBhdGggPz8gYnVpbGRSZXN1bWVUYXJnZXQocmVxdWVzdCkuc2Vzc2lvblBhdGggfVxuICB9IGVsc2UgaWYgKHNlY3Rpb24gPT09IFwibmFtZVwiKSB7XG4gICAgc2VsZWN0ZWRUYXJnZXQgPSB7XG4gICAgICBraW5kOiBcIm5hbWVcIixcbiAgICAgIHNlc3Npb25QYXRoOiBjdXJyZW50U2Vzc2lvblBhdGggPz8gcmVxdWVzdC5jdXJyZW50U2Vzc2lvblBhdGggPz8gdW5kZWZpbmVkLFxuICAgICAgbmFtZTogY3VycmVudERyYWZ0TmFtZSA/PyByZXF1ZXN0LmN1cnJlbnRTZXNzaW9uTmFtZT8udHJpbSgpID8/IFwiXCIsXG4gICAgfVxuICB9IGVsc2UgaWYgKHNlY3Rpb24gPT09IFwiZm9ya1wiKSB7XG4gICAgc2VsZWN0ZWRUYXJnZXQgPSBidWlsZEZvcmtUYXJnZXQocmVxdWVzdClcbiAgfSBlbHNlIGlmIChzZWN0aW9uID09PSBcInNlc3Npb25cIikge1xuICAgIHNlbGVjdGVkVGFyZ2V0ID0gYnVpbGRTZXNzaW9uVGFyZ2V0KHJlcXVlc3QpXG4gIH0gZWxzZSBpZiAoc2VjdGlvbiA9PT0gXCJjb21wYWN0XCIpIHtcbiAgICBzZWxlY3RlZFRhcmdldCA9IGJ1aWxkQ29tcGFjdFRhcmdldChyZXF1ZXN0KVxuICB9XG5cbiAgcmV0dXJuIHtcbiAgICAuLi5jdXJyZW50LFxuICAgIHNlY3Rpb24sXG4gICAgc2VsZWN0ZWRUYXJnZXQsXG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNlbGVjdENvbW1hbmRTdXJmYWNlU3RhdGVUYXJnZXQoXG4gIGN1cnJlbnQ6IFdvcmtzcGFjZUNvbW1hbmRTdXJmYWNlU3RhdGUsXG4gIHRhcmdldDogQ29tbWFuZFN1cmZhY2VUYXJnZXQsXG4pOiBXb3Jrc3BhY2VDb21tYW5kU3VyZmFjZVN0YXRlIHtcbiAgY29uc3QgbmV4dFNlY3Rpb24gPVxuICAgIHRhcmdldC5raW5kID09PSBcInNldHRpbmdzXCJcbiAgICAgID8gdGFyZ2V0LnNlY3Rpb25cbiAgICAgIDogdGFyZ2V0LmtpbmQgPT09IFwibW9kZWxcIlxuICAgICAgICA/IFwibW9kZWxcIlxuICAgICAgICA6IHRhcmdldC5raW5kID09PSBcInRoaW5raW5nXCJcbiAgICAgICAgICA/IFwidGhpbmtpbmdcIlxuICAgICAgICAgIDogdGFyZ2V0LmtpbmQgPT09IFwiYXV0aFwiXG4gICAgICAgICAgICA/IFwiYXV0aFwiXG4gICAgICAgICAgICA6IHRhcmdldC5raW5kID09PSBcInJlc3VtZVwiXG4gICAgICAgICAgICAgID8gXCJyZXN1bWVcIlxuICAgICAgICAgICAgICA6IHRhcmdldC5raW5kID09PSBcIm5hbWVcIlxuICAgICAgICAgICAgICAgID8gXCJuYW1lXCJcbiAgICAgICAgICAgICAgICA6IHRhcmdldC5raW5kID09PSBcImZvcmtcIlxuICAgICAgICAgICAgICAgICAgPyBcImZvcmtcIlxuICAgICAgICAgICAgICAgICAgOiB0YXJnZXQua2luZCA9PT0gXCJzZXNzaW9uXCJcbiAgICAgICAgICAgICAgICAgICAgPyBcInNlc3Npb25cIlxuICAgICAgICAgICAgICAgICAgICA6IFwiY29tcGFjdFwiXG5cbiAgcmV0dXJuIHtcbiAgICAuLi5jdXJyZW50LFxuICAgIHNlY3Rpb246IG5leHRTZWN0aW9uLFxuICAgIHNlbGVjdGVkVGFyZ2V0OiB0YXJnZXQsXG4gICAgbGFzdEVycm9yOiBudWxsLFxuICAgIGxhc3RSZXN1bHQ6IG51bGwsXG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldENvbW1hbmRTdXJmYWNlUGVuZGluZyhcbiAgY3VycmVudDogV29ya3NwYWNlQ29tbWFuZFN1cmZhY2VTdGF0ZSxcbiAgYWN0aW9uOiBDb21tYW5kU3VyZmFjZVBlbmRpbmdBY3Rpb24sXG4gIHNlbGVjdGVkVGFyZ2V0OiBDb21tYW5kU3VyZmFjZVRhcmdldCB8IG51bGwgPSBjdXJyZW50LnNlbGVjdGVkVGFyZ2V0LFxuKTogV29ya3NwYWNlQ29tbWFuZFN1cmZhY2VTdGF0ZSB7XG4gIGNvbnN0IG5leHRSZXN1bWVSZXF1ZXN0ID1cbiAgICBhY3Rpb24gPT09IFwic3dpdGNoX3Nlc3Npb25cIlxuICAgICAgPyB7XG4gICAgICAgICAgcGVuZGluZzogdHJ1ZSxcbiAgICAgICAgICBzZXNzaW9uUGF0aDogc2VsZWN0ZWRUYXJnZXQ/LmtpbmQgPT09IFwicmVzdW1lXCIgPyBzZWxlY3RlZFRhcmdldC5zZXNzaW9uUGF0aCA/PyBudWxsIDogbnVsbCxcbiAgICAgICAgICByZXN1bHQ6IG51bGwsXG4gICAgICAgICAgZXJyb3I6IG51bGwsXG4gICAgICAgIH1cbiAgICAgIDogY3VycmVudC5yZXN1bWVSZXF1ZXN0XG5cbiAgY29uc3QgbmV4dFJlbmFtZVJlcXVlc3QgPVxuICAgIGFjdGlvbiA9PT0gXCJyZW5hbWVfc2Vzc2lvblwiXG4gICAgICA/IHtcbiAgICAgICAgICBwZW5kaW5nOiB0cnVlLFxuICAgICAgICAgIHNlc3Npb25QYXRoOiBzZWxlY3RlZFRhcmdldD8ua2luZCA9PT0gXCJuYW1lXCIgPyBzZWxlY3RlZFRhcmdldC5zZXNzaW9uUGF0aCA/PyBudWxsIDogbnVsbCxcbiAgICAgICAgICByZXN1bHQ6IG51bGwsXG4gICAgICAgICAgZXJyb3I6IG51bGwsXG4gICAgICAgIH1cbiAgICAgIDogY3VycmVudC5yZW5hbWVSZXF1ZXN0XG5cbiAgY29uc3Qgc2V0dGluZ3NSZXF1ZXN0S2V5ID0gU0VUVElOR1NfTVVUQVRJT05fQUNUSU9OX1RPX1JFUVVFU1RbYWN0aW9uXVxuICBjb25zdCBuZXh0U2V0dGluZ3NSZXF1ZXN0cyA9IHNldHRpbmdzUmVxdWVzdEtleVxuICAgID8ge1xuICAgICAgICAuLi5jdXJyZW50LnNldHRpbmdzUmVxdWVzdHMsXG4gICAgICAgIFtzZXR0aW5nc1JlcXVlc3RLZXldOiB7XG4gICAgICAgICAgcGVuZGluZzogdHJ1ZSxcbiAgICAgICAgICByZXN1bHQ6IG51bGwsXG4gICAgICAgICAgZXJyb3I6IG51bGwsXG4gICAgICAgIH0sXG4gICAgICB9XG4gICAgOiBjdXJyZW50LnNldHRpbmdzUmVxdWVzdHNcblxuICByZXR1cm4ge1xuICAgIC4uLmN1cnJlbnQsXG4gICAgcGVuZGluZ0FjdGlvbjogYWN0aW9uLFxuICAgIHNlbGVjdGVkVGFyZ2V0LFxuICAgIGxhc3RFcnJvcjogbnVsbCxcbiAgICBsYXN0UmVzdWx0OiBudWxsLFxuICAgIGdpdFN1bW1hcnk6XG4gICAgICBhY3Rpb24gPT09IFwibG9hZF9naXRfc3VtbWFyeVwiXG4gICAgICAgID8ge1xuICAgICAgICAgICAgLi4uY3VycmVudC5naXRTdW1tYXJ5LFxuICAgICAgICAgICAgcGVuZGluZzogdHJ1ZSxcbiAgICAgICAgICAgIGVycm9yOiBudWxsLFxuICAgICAgICAgIH1cbiAgICAgICAgOiBjdXJyZW50LmdpdFN1bW1hcnksXG4gICAgcmVjb3Zlcnk6XG4gICAgICBhY3Rpb24gPT09IFwibG9hZF9yZWNvdmVyeV9kaWFnbm9zdGljc1wiXG4gICAgICAgID8ge1xuICAgICAgICAgICAgLi4uY3VycmVudC5yZWNvdmVyeSxcbiAgICAgICAgICAgIHBlbmRpbmc6IHRydWUsXG4gICAgICAgICAgICBlcnJvcjogbnVsbCxcbiAgICAgICAgICAgIHBoYXNlOiBjdXJyZW50LnJlY292ZXJ5LmxvYWRlZCA/IGN1cnJlbnQucmVjb3ZlcnkucGhhc2UgOiBcImxvYWRpbmdcIixcbiAgICAgICAgICB9XG4gICAgICAgIDogY3VycmVudC5yZWNvdmVyeSxcbiAgICBzZXNzaW9uQnJvd3NlcjpcbiAgICAgIGFjdGlvbiA9PT0gXCJsb2FkX3Nlc3Npb25fYnJvd3NlclwiXG4gICAgICAgID8ge1xuICAgICAgICAgICAgLi4uY3VycmVudC5zZXNzaW9uQnJvd3NlcixcbiAgICAgICAgICAgIGVycm9yOiBudWxsLFxuICAgICAgICAgIH1cbiAgICAgICAgOiBjdXJyZW50LnNlc3Npb25Ccm93c2VyLFxuICAgIHJlc3VtZVJlcXVlc3Q6IG5leHRSZXN1bWVSZXF1ZXN0LFxuICAgIHJlbmFtZVJlcXVlc3Q6IG5leHRSZW5hbWVSZXF1ZXN0LFxuICAgIHNldHRpbmdzUmVxdWVzdHM6IG5leHRTZXR0aW5nc1JlcXVlc3RzLFxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBseUNvbW1hbmRTdXJmYWNlQWN0aW9uUmVzdWx0KFxuICBjdXJyZW50OiBXb3Jrc3BhY2VDb21tYW5kU3VyZmFjZVN0YXRlLFxuICByZXN1bHQ6IENvbW1hbmRTdXJmYWNlQWN0aW9uUmVzdWx0LFxuKTogV29ya3NwYWNlQ29tbWFuZFN1cmZhY2VTdGF0ZSB7XG4gIGNvbnN0IG5leHRTZWxlY3RlZFRhcmdldCA9IHJlc3VsdC5zZWxlY3RlZFRhcmdldCA9PT0gdW5kZWZpbmVkID8gY3VycmVudC5zZWxlY3RlZFRhcmdldCA6IHJlc3VsdC5zZWxlY3RlZFRhcmdldFxuICBjb25zdCByZXN1bWVTZXNzaW9uUGF0aCA9XG4gICAgKG5leHRTZWxlY3RlZFRhcmdldD8ua2luZCA9PT0gXCJyZXN1bWVcIiA/IG5leHRTZWxlY3RlZFRhcmdldC5zZXNzaW9uUGF0aCA6IHVuZGVmaW5lZCkgPz8gY3VycmVudC5yZXN1bWVSZXF1ZXN0LnNlc3Npb25QYXRoXG4gIGNvbnN0IHJlbmFtZVNlc3Npb25QYXRoID1cbiAgICAobmV4dFNlbGVjdGVkVGFyZ2V0Py5raW5kID09PSBcIm5hbWVcIiA/IG5leHRTZWxlY3RlZFRhcmdldC5zZXNzaW9uUGF0aCA6IHVuZGVmaW5lZCkgPz8gY3VycmVudC5yZW5hbWVSZXF1ZXN0LnNlc3Npb25QYXRoXG4gIGNvbnN0IHNldHRpbmdzUmVxdWVzdEtleSA9IFNFVFRJTkdTX01VVEFUSU9OX0FDVElPTl9UT19SRVFVRVNUW3Jlc3VsdC5hY3Rpb25dXG4gIGNvbnN0IG5leHRTZXR0aW5nc1JlcXVlc3RzID0gc2V0dGluZ3NSZXF1ZXN0S2V5XG4gICAgPyB7XG4gICAgICAgIC4uLmN1cnJlbnQuc2V0dGluZ3NSZXF1ZXN0cyxcbiAgICAgICAgW3NldHRpbmdzUmVxdWVzdEtleV06IHtcbiAgICAgICAgICBwZW5kaW5nOiBmYWxzZSxcbiAgICAgICAgICByZXN1bHQ6IHJlc3VsdC5zdWNjZXNzID8gcmVzdWx0Lm1lc3NhZ2UgOiBudWxsLFxuICAgICAgICAgIGVycm9yOiByZXN1bHQuc3VjY2VzcyA/IG51bGwgOiByZXN1bHQubWVzc2FnZSxcbiAgICAgICAgfSxcbiAgICAgIH1cbiAgICA6IGN1cnJlbnQuc2V0dGluZ3NSZXF1ZXN0c1xuXG4gIHJldHVybiB7XG4gICAgLi4uY3VycmVudCxcbiAgICBwZW5kaW5nQWN0aW9uOiBudWxsLFxuICAgIHNlbGVjdGVkVGFyZ2V0OiBuZXh0U2VsZWN0ZWRUYXJnZXQsXG4gICAgYXZhaWxhYmxlTW9kZWxzOiByZXN1bHQuYXZhaWxhYmxlTW9kZWxzID8/IGN1cnJlbnQuYXZhaWxhYmxlTW9kZWxzLFxuICAgIGZvcmtNZXNzYWdlczogcmVzdWx0LmZvcmtNZXNzYWdlcyA/PyBjdXJyZW50LmZvcmtNZXNzYWdlcyxcbiAgICBzZXNzaW9uU3RhdHM6IHJlc3VsdC5zZXNzaW9uU3RhdHMgPT09IHVuZGVmaW5lZCA/IGN1cnJlbnQuc2Vzc2lvblN0YXRzIDogcmVzdWx0LnNlc3Npb25TdGF0cyxcbiAgICBsYXN0Q29tcGFjdGlvbjogcmVzdWx0Lmxhc3RDb21wYWN0aW9uID09PSB1bmRlZmluZWQgPyBjdXJyZW50Lmxhc3RDb21wYWN0aW9uIDogcmVzdWx0Lmxhc3RDb21wYWN0aW9uLFxuICAgIGdpdFN1bW1hcnk6XG4gICAgICByZXN1bHQuZ2l0U3VtbWFyeSA9PT0gdW5kZWZpbmVkXG4gICAgICAgID8gY3VycmVudC5naXRTdW1tYXJ5XG4gICAgICAgIDoge1xuICAgICAgICAgICAgLi4ucmVzdWx0LmdpdFN1bW1hcnksXG4gICAgICAgICAgICBwZW5kaW5nOiBmYWxzZSxcbiAgICAgICAgICAgIGxvYWRlZDogcmVzdWx0LmdpdFN1bW1hcnkubG9hZGVkIHx8IHJlc3VsdC5zdWNjZXNzLFxuICAgICAgICAgIH0sXG4gICAgcmVjb3Zlcnk6IHJlc3VsdC5yZWNvdmVyeSA/PyBjdXJyZW50LnJlY292ZXJ5LFxuICAgIHNlc3Npb25Ccm93c2VyOiByZXN1bHQuc2Vzc2lvbkJyb3dzZXIgPz8gY3VycmVudC5zZXNzaW9uQnJvd3NlcixcbiAgICByZXN1bWVSZXF1ZXN0OlxuICAgICAgcmVzdWx0LmFjdGlvbiA9PT0gXCJzd2l0Y2hfc2Vzc2lvblwiXG4gICAgICAgID8ge1xuICAgICAgICAgICAgcGVuZGluZzogZmFsc2UsXG4gICAgICAgICAgICBzZXNzaW9uUGF0aDogcmVzdW1lU2Vzc2lvblBhdGggPz8gbnVsbCxcbiAgICAgICAgICAgIHJlc3VsdDogcmVzdWx0LnN1Y2Nlc3MgPyByZXN1bHQubWVzc2FnZSA6IG51bGwsXG4gICAgICAgICAgICBlcnJvcjogcmVzdWx0LnN1Y2Nlc3MgPyBudWxsIDogcmVzdWx0Lm1lc3NhZ2UsXG4gICAgICAgICAgfVxuICAgICAgICA6IGN1cnJlbnQucmVzdW1lUmVxdWVzdCxcbiAgICByZW5hbWVSZXF1ZXN0OlxuICAgICAgcmVzdWx0LmFjdGlvbiA9PT0gXCJyZW5hbWVfc2Vzc2lvblwiXG4gICAgICAgID8ge1xuICAgICAgICAgICAgcGVuZGluZzogZmFsc2UsXG4gICAgICAgICAgICBzZXNzaW9uUGF0aDogcmVuYW1lU2Vzc2lvblBhdGggPz8gbnVsbCxcbiAgICAgICAgICAgIHJlc3VsdDogcmVzdWx0LnN1Y2Nlc3MgPyByZXN1bHQubWVzc2FnZSA6IG51bGwsXG4gICAgICAgICAgICBlcnJvcjogcmVzdWx0LnN1Y2Nlc3MgPyBudWxsIDogcmVzdWx0Lm1lc3NhZ2UsXG4gICAgICAgICAgfVxuICAgICAgICA6IGN1cnJlbnQucmVuYW1lUmVxdWVzdCxcbiAgICBzZXR0aW5nc1JlcXVlc3RzOiBuZXh0U2V0dGluZ3NSZXF1ZXN0cyxcbiAgICBsYXN0RXJyb3I6IHJlc3VsdC5zdWNjZXNzID8gbnVsbCA6IHJlc3VsdC5tZXNzYWdlLFxuICAgIGxhc3RSZXN1bHQ6IHJlc3VsdC5zdWNjZXNzID8gcmVzdWx0Lm1lc3NhZ2UgOiBudWxsLFxuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzdXJmYWNlT3V0Y29tZVRvT3BlblJlcXVlc3QoXG4gIG91dGNvbWU6IEV4dHJhY3Q8QnJvd3NlclNsYXNoQ29tbWFuZERpc3BhdGNoUmVzdWx0LCB7IGtpbmQ6IFwic3VyZmFjZVwiIH0+LFxuICBjb250ZXh0OiBDb21tYW5kU3VyZmFjZU9wZW5Db250ZXh0ID0ge30sXG4pOiBDb21tYW5kU3VyZmFjZU9wZW5SZXF1ZXN0IHtcbiAgcmV0dXJuIHtcbiAgICBzdXJmYWNlOiBvdXRjb21lLnN1cmZhY2UsXG4gICAgc291cmNlOiBcInNsYXNoXCIsXG4gICAgYXJnczogb3V0Y29tZS5hcmdzLFxuICAgIC4uLmNvbnRleHQsXG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQW9CTyxNQUFNLGtDQUFrQyxDQUFDLE9BQU8sV0FBVyxPQUFPLFVBQVUsUUFBUSxPQUFPO0FBa1czRixTQUFTLHFDQUFnRjtBQUM5RixTQUFPLEVBQUUsT0FBTyxRQUFRLE1BQU0sTUFBTSxPQUFPLE1BQU0sY0FBYyxLQUFLO0FBQ3RFO0FBRU8sU0FBUywyQkFBc0Q7QUFDcEUsU0FBTyxFQUFFLE9BQU8sUUFBUSxNQUFNLE1BQU0sT0FBTyxNQUFNLGNBQWMsTUFBTSxZQUFZLE9BQU8sZUFBZSxNQUFNLGNBQWMsS0FBSztBQUNsSTtBQUVPLFNBQVMsZ0NBQWdFO0FBQzlFLFNBQU87QUFBQSxJQUNMLFdBQVcsbUNBQW1EO0FBQUEsSUFDOUQsUUFBUSx5QkFBeUI7QUFBQSxJQUNqQyxhQUFhLG1DQUFzRDtBQUFBLEVBQ3JFO0FBQ0Y7QUFn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
