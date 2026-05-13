import { mkdir, stat, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead
} from "@gsd/pi-coding-agent";
import {
  beginAction,
  finishAction,
  findAction,
  toActionParamsSummary,
  registryListPages
} from "./core.js";
import {
  ARTIFACT_ROOT,
  getActiveFrame,
  getActiveTraceSession,
  getConsoleLogs,
  getDialogLogs,
  getHarState,
  getNetworkLogs,
  getSessionArtifactDir,
  getSessionStartedAt,
  setSessionArtifactDir,
  setSessionStartedAt,
  pageRegistry,
  actionTimeline,
  getPendingCriticalRequestsByPage
} from "./state.js";
function truncateText(text) {
  const result = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES
  });
  if (result.truncated) {
    return result.content + `

[Output truncated: ${result.outputLines}/${result.totalLines} lines shown]`;
  }
  return result.content;
}
function formatArtifactTimestamp(timestamp) {
  return new Date(timestamp).toISOString().replace(/[:.]/g, "-");
}
async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}
async function writeArtifactFile(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, content);
  const fileStat = await stat(filePath);
  return { path: filePath, bytes: fileStat.size };
}
async function copyArtifactFile(sourcePath, destinationPath) {
  await ensureDir(path.dirname(destinationPath));
  await copyFile(sourcePath, destinationPath);
  const fileStat = await stat(destinationPath);
  return { path: destinationPath, bytes: fileStat.size };
}
function ensureSessionStartedAt() {
  let t = getSessionStartedAt();
  if (!t) {
    t = Date.now();
    setSessionStartedAt(t);
  }
  return t;
}
async function ensureSessionArtifactDir() {
  const existing = getSessionArtifactDir();
  if (existing) {
    await ensureDir(existing);
    return existing;
  }
  const startedAt = ensureSessionStartedAt();
  const dir = path.join(ARTIFACT_ROOT, `${formatArtifactTimestamp(startedAt)}-session`);
  setSessionArtifactDir(dir);
  await ensureDir(dir);
  return dir;
}
function buildSessionArtifactPath(filename) {
  const dir = getSessionArtifactDir();
  if (!dir) {
    throw new Error("browser session artifact directory is not initialized");
  }
  return path.join(dir, filename);
}
function getActivePageMetadata() {
  const registry = pageRegistry;
  const activeEntry = registry.activePageId !== null ? registry.pages.find((entry) => entry.id === registry.activePageId) ?? null : null;
  return {
    id: activeEntry?.id ?? null,
    title: activeEntry?.title ?? "",
    url: activeEntry?.url ?? ""
  };
}
function getActiveFrameMetadata() {
  const frame = getActiveFrame();
  if (!frame) {
    return { name: null, url: null };
  }
  return {
    name: frame.name() || null,
    url: frame.url() || null
  };
}
function getSessionArtifactMetadata() {
  return {
    artifactRoot: ARTIFACT_ROOT,
    sessionStartedAt: getSessionStartedAt(),
    sessionArtifactDir: getSessionArtifactDir(),
    activeTraceSession: getActiveTraceSession(),
    harState: { ...getHarState() },
    activePage: getActivePageMetadata(),
    activeFrame: getActiveFrameMetadata()
  };
}
function sanitizeArtifactName(value, fallback) {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}
function createGetLivePagesSnapshot(ensureBrowser) {
  return async function getLivePagesSnapshot() {
    await ensureBrowser();
    for (const entry of pageRegistry.pages) {
      try {
        entry.title = await entry.page.title();
        entry.url = entry.page.url();
      } catch {
      }
    }
    return registryListPages(pageRegistry);
  };
}
async function resolveAccessibilityScope(selector) {
  if (selector?.trim()) {
    return {
      selector: selector.trim(),
      scope: `selector:${selector.trim()}`,
      source: "explicit_selector"
    };
  }
  const frame = getActiveFrame();
  if (frame) {
    return {
      selector: "body",
      scope: frame.name() ? `active frame:${frame.name()}` : "active frame",
      source: "active_frame"
    };
  }
  return { selector: "body", scope: "full page", source: "full_page" };
}
async function captureAccessibilityMarkdown(target, selector) {
  const scopeInfo = await resolveAccessibilityScope(selector);
  const locator = target.locator(scopeInfo.selector ?? "body").first();
  const snapshot = await locator.ariaSnapshot();
  return { snapshot, scope: scopeInfo.scope, source: scopeInfo.source };
}
function isCriticalResourceType(resourceType) {
  return resourceType === "document" || resourceType === "fetch" || resourceType === "xhr";
}
function updatePendingCriticalRequests(p, delta) {
  const map = getPendingCriticalRequestsByPage();
  const current = map.get(p) ?? 0;
  map.set(p, Math.max(0, current + delta));
}
function getPendingCriticalRequests(p) {
  return getPendingCriticalRequestsByPage().get(p) ?? 0;
}
function verificationFromChecks(checks, retryHint) {
  const passedChecks = checks.filter((check) => check.passed).map((check) => check.name);
  const verified = passedChecks.length > 0;
  return {
    verified,
    checks,
    verificationSummary: verified ? `PASS (${passedChecks.join(", ")})` : "SOFT-FAIL (no observable state change)",
    retryHint: verified ? void 0 : retryHint
  };
}
function verificationLine(verification) {
  return `Verification: ${verification.verificationSummary}`;
}
async function collectAssertionState(p, checks, captureCompactPageState, target) {
  const selectors = checks.map((check) => check.selector).filter((value) => !!value);
  const compactState = await captureCompactPageState(p, {
    selectors,
    includeBodyText: true,
    target
  });
  const sinceActionId = checks.reduce((max, check) => {
    if (check.sinceActionId === void 0) return max;
    if (max === void 0) return check.sinceActionId;
    return Math.max(max, check.sinceActionId);
  }, void 0);
  return {
    url: compactState.url,
    title: compactState.title,
    bodyText: compactState.bodyText,
    focus: compactState.focus,
    selectorStates: compactState.selectorStates,
    consoleEntries: getConsoleEntriesSince(sinceActionId),
    networkEntries: getNetworkEntriesSince(sinceActionId),
    allConsoleEntries: getConsoleLogs(),
    allNetworkEntries: getNetworkLogs(),
    actionTimeline
  };
}
function formatAssertionText(result) {
  const lines = [result.summary];
  for (const check of result.checks.slice(0, 8)) {
    lines.push(
      `- ${check.passed ? "PASS" : "FAIL"} ${check.name}: expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)}`
    );
  }
  lines.push(`Hint: ${result.agentHint}`);
  return lines.join("\n");
}
function formatDiffText(diff) {
  const lines = [diff.summary];
  for (const change of diff.changes.slice(0, 8)) {
    lines.push(
      `- ${change.type}: ${JSON.stringify(change.before ?? null)} \u2192 ${JSON.stringify(change.after ?? null)}`
    );
  }
  return lines.join("\n");
}
function getUrlHash(url) {
  try {
    return new URL(url).hash || "";
  } catch {
    return "";
  }
}
async function countOpenDialogs(target) {
  try {
    return await target.evaluate(
      () => document.querySelectorAll('[role="dialog"]:not([hidden]),dialog[open]').length
    );
  } catch {
    return 0;
  }
}
async function captureClickTargetState(target, selector) {
  try {
    return await target.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) {
        return {
          exists: false,
          ariaExpanded: null,
          ariaPressed: null,
          ariaSelected: null,
          open: null
        };
      }
      return {
        exists: true,
        ariaExpanded: el.getAttribute("aria-expanded"),
        ariaPressed: el.getAttribute("aria-pressed"),
        ariaSelected: el.getAttribute("aria-selected"),
        open: el instanceof HTMLDialogElement ? el.open : el.getAttribute("open") !== null
      };
    }, selector);
  } catch {
    return {
      exists: false,
      ariaExpanded: null,
      ariaPressed: null,
      ariaSelected: null,
      open: null
    };
  }
}
async function readInputLikeValue(target, selector) {
  try {
    return await target.evaluate((sel) => {
      const resolveTarget = () => {
        if (sel) return document.querySelector(sel);
        const active = document.activeElement;
        if (!active || active === document.body || active === document.documentElement)
          return null;
        return active;
      };
      const target2 = resolveTarget();
      if (!target2) return null;
      if (target2 instanceof HTMLInputElement || target2 instanceof HTMLTextAreaElement) {
        return target2.value;
      }
      if (target2 instanceof HTMLSelectElement) {
        return target2.value;
      }
      if (target2.isContentEditable) {
        return (target2.textContent ?? "").trim();
      }
      return target2.getAttribute("value");
    }, selector);
  } catch {
    return null;
  }
}
function firstErrorLine(err) {
  const message = typeof err === "object" && err && "message" in err ? String(err.message ?? "") : String(err ?? "unknown error");
  return message.split("\n")[0] || "unknown error";
}
function beginTrackedAction(tool, params, beforeUrl) {
  return beginAction(actionTimeline, {
    tool,
    paramsSummary: toActionParamsSummary(params),
    beforeUrl
  });
}
function finishTrackedAction(actionId, updates) {
  return finishAction(actionTimeline, actionId, updates);
}
function getSinceTimestamp(sinceActionId) {
  if (!sinceActionId) return 0;
  const action = findAction(actionTimeline, sinceActionId);
  if (!action) return 0;
  return action.startedAt ?? 0;
}
function getConsoleEntriesSince(sinceActionId) {
  const since = getSinceTimestamp(sinceActionId);
  return getConsoleLogs().filter((entry) => entry.timestamp >= since);
}
function getNetworkEntriesSince(sinceActionId) {
  const since = getSinceTimestamp(sinceActionId);
  return getNetworkLogs().filter((entry) => entry.timestamp >= since);
}
function getRecentErrors(pageUrl) {
  const parts = [];
  const now = Date.now();
  const since = now - 12e3;
  const toOrigin = (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  };
  const pageOrigin = toOrigin(pageUrl);
  const sameOrigin = (url) => !pageOrigin || toOrigin(url) === pageOrigin;
  const summarize = (items, max) => {
    const counts = /* @__PURE__ */ new Map();
    const order = [];
    for (const item of items) {
      if (!counts.has(item)) order.push(item);
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
    return order.slice(0, max).map((item) => {
      const count = counts.get(item) ?? 1;
      return count > 1 ? `${item} (x${count})` : item;
    });
  };
  const consoleLogs = getConsoleLogs();
  const jsWarnings = consoleLogs.filter(
    (e) => (e.type === "error" || e.type === "pageerror") && e.timestamp >= since && sameOrigin(e.url)
  ).map((e) => e.text.slice(0, 120));
  if (jsWarnings.length > 0) {
    parts.push("JS: " + summarize(jsWarnings, 2).join(" | "));
  }
  const actionableStatus = /* @__PURE__ */ new Set([401, 403, 404, 408, 409, 422, 429]);
  const actionableTypes = /* @__PURE__ */ new Set(["document", "fetch", "xhr", "script"]);
  const networkLogs = getNetworkLogs();
  const netWarnings = networkLogs.filter((e) => e.timestamp >= since && sameOrigin(e.url)).filter((e) => {
    if (e.failed) return actionableTypes.has(e.resourceType);
    if (e.status === null) return false;
    if (e.status >= 500) return true;
    return actionableStatus.has(e.status) && actionableTypes.has(e.resourceType);
  }).map((e) => {
    if (e.failed) return `${e.method} ${e.resourceType} FAILED`;
    return `${e.method} ${e.resourceType} ${e.status}`;
  });
  if (netWarnings.length > 0) {
    parts.push("Network: " + summarize(netWarnings, 2).join(" | "));
  }
  const dialogLogs = getDialogLogs();
  const dialogWarnings = dialogLogs.filter((e) => e.timestamp >= since && sameOrigin(e.url)).map((e) => `${e.type}: ${e.message.slice(0, 80)}`);
  if (dialogWarnings.length > 0) {
    parts.push("Dialogs: " + summarize(dialogWarnings, 1).join(" | "));
  }
  if (parts.length === 0) return "";
  return `

Warnings: ${parts.join("; ")}
Use browser_get_console_logs/browser_get_network_logs for full diagnostics.`;
}
function parseRef(input) {
  const trimmed = input.trim().toLowerCase();
  const token = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const versioned = token.match(/^v(\d+):(e\d+)$/);
  if (versioned) {
    const version = parseInt(versioned[1], 10);
    const key = versioned[2];
    return { key, version, display: `@v${version}:${key}` };
  }
  return { key: token, version: null, display: `@${token}` };
}
function formatVersionedRef(version, key) {
  return `@v${version}:${key}`;
}
function staleRefGuidance(refDisplay, reason) {
  return `Ref ${refDisplay} could not be resolved (${reason}). The ref is likely stale after DOM/navigation changes. Call browser_snapshot_refs again to refresh refs.`;
}
function formatCompactStateSummary(state) {
  const lines = [];
  lines.push(`Title: ${state.title}`);
  lines.push(`URL: ${state.url}`);
  lines.push(
    `Elements: ${state.counts.landmarks} landmarks, ${state.counts.buttons} buttons, ${state.counts.links} links, ${state.counts.inputs} inputs`
  );
  if (state.headings.length > 0) {
    lines.push(
      "Headings: " + state.headings.map((text, index) => `H${index + 1} "${text}"`).join(", ")
    );
  }
  if (state.focus) {
    lines.push(`Focused: ${state.focus}`);
  }
  if (state.dialog.title) {
    lines.push(`Active dialog: "${state.dialog.title}"`);
  }
  lines.push(
    "Use browser_find for targeted discovery, browser_assert for verification, or browser_get_accessibility_tree for full detail."
  );
  return lines.join("\n");
}
export {
  beginTrackedAction,
  buildSessionArtifactPath,
  captureAccessibilityMarkdown,
  captureClickTargetState,
  collectAssertionState,
  copyArtifactFile,
  countOpenDialogs,
  createGetLivePagesSnapshot,
  ensureDir,
  ensureSessionArtifactDir,
  ensureSessionStartedAt,
  finishTrackedAction,
  firstErrorLine,
  formatArtifactTimestamp,
  formatAssertionText,
  formatCompactStateSummary,
  formatDiffText,
  formatVersionedRef,
  getActiveFrameMetadata,
  getActivePageMetadata,
  getConsoleEntriesSince,
  getNetworkEntriesSince,
  getPendingCriticalRequests,
  getRecentErrors,
  getSessionArtifactMetadata,
  getSinceTimestamp,
  getUrlHash,
  isCriticalResourceType,
  parseRef,
  readInputLikeValue,
  resolveAccessibilityScope,
  sanitizeArtifactName,
  staleRefGuidance,
  truncateText,
  updatePendingCriticalRequests,
  verificationFromChecks,
  verificationLine,
  writeArtifactFile
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdXRpbHMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogYnJvd3Nlci10b29scyBcdTIwMTQgTm9kZS1zaWRlIHV0aWxpdHkgZnVuY3Rpb25zXG4gKlxuICogQWxsIGZ1bmN0aW9ucyB0aGF0IHdlcmUgaGVscGVycyBpbiBpbmRleC50cyBidXQgcnVuIGluIE5vZGUgKG5vdCBicm93c2VyKS5cbiAqIFRoZXkgaW1wb3J0IHN0YXRlIGFjY2Vzc29ycyBmcm9tIC4vc3RhdGUudHMgXHUyMDE0IG5ldmVyIHJhdyBtb2R1bGUtbGV2ZWwgdmFyaWFibGVzLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRnJhbWUsIFBhZ2UgfSBmcm9tIFwicGxheXdyaWdodFwiO1xuaW1wb3J0IHsgbWtkaXIsIHN0YXQsIHdyaXRlRmlsZSwgY29weUZpbGUgfSBmcm9tIFwibm9kZTpmcy9wcm9taXNlc1wiO1xuaW1wb3J0IHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHtcblx0REVGQVVMVF9NQVhfQllURVMsXG5cdERFRkFVTFRfTUFYX0xJTkVTLFxuXHR0cnVuY2F0ZUhlYWQsXG59IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHtcblx0YmVnaW5BY3Rpb24sXG5cdGZpbmlzaEFjdGlvbixcblx0ZmluZEFjdGlvbixcblx0dG9BY3Rpb25QYXJhbXNTdW1tYXJ5LFxuXHRyZWdpc3RyeUxpc3RQYWdlcyxcbn0gZnJvbSBcIi4vY29yZS5qc1wiO1xuaW1wb3J0IHtcblx0QVJUSUZBQ1RfUk9PVCxcblx0Z2V0QWN0aXZlRnJhbWUsXG5cdGdldEFjdGl2ZVRyYWNlU2Vzc2lvbixcblx0Z2V0Q29uc29sZUxvZ3MsXG5cdGdldERpYWxvZ0xvZ3MsXG5cdGdldEhhclN0YXRlLFxuXHRnZXROZXR3b3JrTG9ncyxcblx0Z2V0U2Vzc2lvbkFydGlmYWN0RGlyLFxuXHRnZXRTZXNzaW9uU3RhcnRlZEF0LFxuXHRzZXRTZXNzaW9uQXJ0aWZhY3REaXIsXG5cdHNldFNlc3Npb25TdGFydGVkQXQsXG5cdHBhZ2VSZWdpc3RyeSxcblx0YWN0aW9uVGltZWxpbmUsXG5cdGdldFBlbmRpbmdDcml0aWNhbFJlcXVlc3RzQnlQYWdlLFxuXHRnZXRMYXN0QWN0aW9uQmVmb3JlU3RhdGUsXG5cdGdldExhc3RBY3Rpb25BZnRlclN0YXRlLFxuXHRzZXRMYXN0QWN0aW9uQmVmb3JlU3RhdGUsXG5cdHNldExhc3RBY3Rpb25BZnRlclN0YXRlLFxuXHR0eXBlIENvbnNvbGVFbnRyeSxcblx0dHlwZSBOZXR3b3JrRW50cnksXG5cdHR5cGUgQ29tcGFjdFBhZ2VTdGF0ZSxcblx0dHlwZSBDb21wYWN0U2VsZWN0b3JTdGF0ZSxcblx0dHlwZSBDbGlja1RhcmdldFN0YXRlU25hcHNob3QsXG5cdHR5cGUgQnJvd3NlclZlcmlmaWNhdGlvbkNoZWNrLFxuXHR0eXBlIEJyb3dzZXJWZXJpZmljYXRpb25SZXN1bHQsXG5cdHR5cGUgQnJvd3NlckFzc2VydGlvbkNoZWNrSW5wdXQsXG5cdHR5cGUgQWRhcHRpdmVTZXR0bGVPcHRpb25zLFxuXHR0eXBlIEFkYXB0aXZlU2V0dGxlRGV0YWlscyxcblx0dHlwZSBQYXJzZWRSZWZTcGVjLFxufSBmcm9tIFwiLi9zdGF0ZS5qc1wiO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRleHQgdHJ1bmNhdGlvblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBmdW5jdGlvbiB0cnVuY2F0ZVRleHQodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0Y29uc3QgcmVzdWx0ID0gdHJ1bmNhdGVIZWFkKHRleHQsIHtcblx0XHRtYXhMaW5lczogREVGQVVMVF9NQVhfTElORVMsXG5cdFx0bWF4Qnl0ZXM6IERFRkFVTFRfTUFYX0JZVEVTLFxuXHR9KTtcblx0aWYgKHJlc3VsdC50cnVuY2F0ZWQpIHtcblx0XHRyZXR1cm4gKFxuXHRcdFx0cmVzdWx0LmNvbnRlbnQgK1xuXHRcdFx0YFxcblxcbltPdXRwdXQgdHJ1bmNhdGVkOiAke3Jlc3VsdC5vdXRwdXRMaW5lc30vJHtyZXN1bHQudG90YWxMaW5lc30gbGluZXMgc2hvd25dYFxuXHRcdCk7XG5cdH1cblx0cmV0dXJuIHJlc3VsdC5jb250ZW50O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEFydGlmYWN0IGhlbHBlcnNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0QXJ0aWZhY3RUaW1lc3RhbXAodGltZXN0YW1wOiBudW1iZXIpOiBzdHJpbmcge1xuXHRyZXR1cm4gbmV3IERhdGUodGltZXN0YW1wKS50b0lTT1N0cmluZygpLnJlcGxhY2UoL1s6Ll0vZywgXCItXCIpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZW5zdXJlRGlyKGRpclBhdGg6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG5cdGF3YWl0IG1rZGlyKGRpclBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRyZXR1cm4gZGlyUGF0aDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdyaXRlQXJ0aWZhY3RGaWxlKFxuXHRmaWxlUGF0aDogc3RyaW5nLFxuXHRjb250ZW50OiBzdHJpbmcgfCBVaW50OEFycmF5LFxuKTogUHJvbWlzZTx7IHBhdGg6IHN0cmluZzsgYnl0ZXM6IG51bWJlciB9PiB7XG5cdGF3YWl0IGVuc3VyZURpcihwYXRoLmRpcm5hbWUoZmlsZVBhdGgpKTtcblx0YXdhaXQgd3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50KTtcblx0Y29uc3QgZmlsZVN0YXQgPSBhd2FpdCBzdGF0KGZpbGVQYXRoKTtcblx0cmV0dXJuIHsgcGF0aDogZmlsZVBhdGgsIGJ5dGVzOiBmaWxlU3RhdC5zaXplIH07XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb3B5QXJ0aWZhY3RGaWxlKFxuXHRzb3VyY2VQYXRoOiBzdHJpbmcsXG5cdGRlc3RpbmF0aW9uUGF0aDogc3RyaW5nLFxuKTogUHJvbWlzZTx7IHBhdGg6IHN0cmluZzsgYnl0ZXM6IG51bWJlciB9PiB7XG5cdGF3YWl0IGVuc3VyZURpcihwYXRoLmRpcm5hbWUoZGVzdGluYXRpb25QYXRoKSk7XG5cdGF3YWl0IGNvcHlGaWxlKHNvdXJjZVBhdGgsIGRlc3RpbmF0aW9uUGF0aCk7XG5cdGNvbnN0IGZpbGVTdGF0ID0gYXdhaXQgc3RhdChkZXN0aW5hdGlvblBhdGgpO1xuXHRyZXR1cm4geyBwYXRoOiBkZXN0aW5hdGlvblBhdGgsIGJ5dGVzOiBmaWxlU3RhdC5zaXplIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBlbnN1cmVTZXNzaW9uU3RhcnRlZEF0KCk6IG51bWJlciB7XG5cdGxldCB0ID0gZ2V0U2Vzc2lvblN0YXJ0ZWRBdCgpO1xuXHRpZiAoIXQpIHtcblx0XHR0ID0gRGF0ZS5ub3coKTtcblx0XHRzZXRTZXNzaW9uU3RhcnRlZEF0KHQpO1xuXHR9XG5cdHJldHVybiB0O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZW5zdXJlU2Vzc2lvbkFydGlmYWN0RGlyKCk6IFByb21pc2U8c3RyaW5nPiB7XG5cdGNvbnN0IGV4aXN0aW5nID0gZ2V0U2Vzc2lvbkFydGlmYWN0RGlyKCk7XG5cdGlmIChleGlzdGluZykge1xuXHRcdGF3YWl0IGVuc3VyZURpcihleGlzdGluZyk7XG5cdFx0cmV0dXJuIGV4aXN0aW5nO1xuXHR9XG5cdGNvbnN0IHN0YXJ0ZWRBdCA9IGVuc3VyZVNlc3Npb25TdGFydGVkQXQoKTtcblx0Y29uc3QgZGlyID0gcGF0aC5qb2luKEFSVElGQUNUX1JPT1QsIGAke2Zvcm1hdEFydGlmYWN0VGltZXN0YW1wKHN0YXJ0ZWRBdCl9LXNlc3Npb25gKTtcblx0c2V0U2Vzc2lvbkFydGlmYWN0RGlyKGRpcik7XG5cdGF3YWl0IGVuc3VyZURpcihkaXIpO1xuXHRyZXR1cm4gZGlyO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTZXNzaW9uQXJ0aWZhY3RQYXRoKGZpbGVuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBkaXIgPSBnZXRTZXNzaW9uQXJ0aWZhY3REaXIoKTtcblx0aWYgKCFkaXIpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoXCJicm93c2VyIHNlc3Npb24gYXJ0aWZhY3QgZGlyZWN0b3J5IGlzIG5vdCBpbml0aWFsaXplZFwiKTtcblx0fVxuXHRyZXR1cm4gcGF0aC5qb2luKGRpciwgZmlsZW5hbWUpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QWN0aXZlUGFnZU1ldGFkYXRhKCkge1xuXHRjb25zdCByZWdpc3RyeSA9IHBhZ2VSZWdpc3RyeTtcblx0Y29uc3QgYWN0aXZlRW50cnkgPVxuXHRcdHJlZ2lzdHJ5LmFjdGl2ZVBhZ2VJZCAhPT0gbnVsbFxuXHRcdFx0PyByZWdpc3RyeS5wYWdlcy5maW5kKChlbnRyeTogYW55KSA9PiBlbnRyeS5pZCA9PT0gcmVnaXN0cnkuYWN0aXZlUGFnZUlkKSA/PyBudWxsXG5cdFx0XHQ6IG51bGw7XG5cdHJldHVybiB7XG5cdFx0aWQ6IGFjdGl2ZUVudHJ5Py5pZCA/PyBudWxsLFxuXHRcdHRpdGxlOiBhY3RpdmVFbnRyeT8udGl0bGUgPz8gXCJcIixcblx0XHR1cmw6IGFjdGl2ZUVudHJ5Py51cmwgPz8gXCJcIixcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEFjdGl2ZUZyYW1lTWV0YWRhdGEoKSB7XG5cdGNvbnN0IGZyYW1lID0gZ2V0QWN0aXZlRnJhbWUoKTtcblx0aWYgKCFmcmFtZSkge1xuXHRcdHJldHVybiB7IG5hbWU6IG51bGwsIHVybDogbnVsbCB9O1xuXHR9XG5cdHJldHVybiB7XG5cdFx0bmFtZTogZnJhbWUubmFtZSgpIHx8IG51bGwsXG5cdFx0dXJsOiBmcmFtZS51cmwoKSB8fCBudWxsLFxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2Vzc2lvbkFydGlmYWN0TWV0YWRhdGEoKSB7XG5cdHJldHVybiB7XG5cdFx0YXJ0aWZhY3RSb290OiBBUlRJRkFDVF9ST09ULFxuXHRcdHNlc3Npb25TdGFydGVkQXQ6IGdldFNlc3Npb25TdGFydGVkQXQoKSxcblx0XHRzZXNzaW9uQXJ0aWZhY3REaXI6IGdldFNlc3Npb25BcnRpZmFjdERpcigpLFxuXHRcdGFjdGl2ZVRyYWNlU2Vzc2lvbjogZ2V0QWN0aXZlVHJhY2VTZXNzaW9uKCksXG5cdFx0aGFyU3RhdGU6IHsgLi4uZ2V0SGFyU3RhdGUoKSB9LFxuXHRcdGFjdGl2ZVBhZ2U6IGdldEFjdGl2ZVBhZ2VNZXRhZGF0YSgpLFxuXHRcdGFjdGl2ZUZyYW1lOiBnZXRBY3RpdmVGcmFtZU1ldGFkYXRhKCksXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzYW5pdGl6ZUFydGlmYWN0TmFtZSh2YWx1ZTogc3RyaW5nLCBmYWxsYmFjazogc3RyaW5nKTogc3RyaW5nIHtcblx0Y29uc3Qgc2FuaXRpemVkID0gdmFsdWVcblx0XHQudHJpbSgpXG5cdFx0LnJlcGxhY2UoL1teYS16QS1aMC05Ll8tXSsvZywgXCItXCIpXG5cdFx0LnJlcGxhY2UoL14tK3wtKyQvZywgXCJcIik7XG5cdHJldHVybiBzYW5pdGl6ZWQgfHwgZmFsbGJhY2s7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUGFnZSBoZWxwZXJzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBnZXRMaXZlUGFnZXNTbmFwc2hvdCByZXF1aXJlcyBlbnN1cmVCcm93c2VyIChjaXJjdWxhcikgXHUyMDE0IGl0IHdpbGwgYmVcbiAqIHdpcmVkIGluIHZpYSBUb29sRGVwcy4gVGhpcyBpcyBhIGZhY3RvcnkgdGhhdCB0YWtlcyBlbnN1cmVCcm93c2VyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlR2V0TGl2ZVBhZ2VzU25hcHNob3QoXG5cdGVuc3VyZUJyb3dzZXI6ICgpID0+IFByb21pc2U8eyBwYWdlOiBQYWdlIH0+LFxuKSB7XG5cdHJldHVybiBhc3luYyBmdW5jdGlvbiBnZXRMaXZlUGFnZXNTbmFwc2hvdCgpIHtcblx0XHRhd2FpdCBlbnN1cmVCcm93c2VyKCk7XG5cdFx0Zm9yIChjb25zdCBlbnRyeSBvZiBwYWdlUmVnaXN0cnkucGFnZXMpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGVudHJ5LnRpdGxlID0gYXdhaXQgZW50cnkucGFnZS50aXRsZSgpO1xuXHRcdFx0XHRlbnRyeS51cmwgPSBlbnRyeS5wYWdlLnVybCgpO1xuXHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdC8vIFBhZ2UgbWF5IGhhdmUgYmVlbiBjbG9zZWQgYmV0d2VlbiBzbmFwc2hvdHMuXG5cdFx0XHR9XG5cdFx0fVxuXHRcdHJldHVybiByZWdpc3RyeUxpc3RQYWdlcyhwYWdlUmVnaXN0cnkpO1xuXHR9O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUFjY2Vzc2liaWxpdHlTY29wZShcblx0c2VsZWN0b3I/OiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgc2VsZWN0b3I/OiBzdHJpbmc7IHNjb3BlOiBzdHJpbmc7IHNvdXJjZTogc3RyaW5nIH0+IHtcblx0aWYgKHNlbGVjdG9yPy50cmltKCkpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0c2VsZWN0b3I6IHNlbGVjdG9yLnRyaW0oKSxcblx0XHRcdHNjb3BlOiBgc2VsZWN0b3I6JHtzZWxlY3Rvci50cmltKCl9YCxcblx0XHRcdHNvdXJjZTogXCJleHBsaWNpdF9zZWxlY3RvclwiLFxuXHRcdH07XG5cdH1cblx0Y29uc3QgZnJhbWUgPSBnZXRBY3RpdmVGcmFtZSgpO1xuXHQvLyBXZSBuZWVkIGdldEFjdGl2ZVRhcmdldCBmb3IgZGlhbG9nIGNoZWNrLCBidXQgdGhhdCByZXF1aXJlcyBwYWdlIGFjY2Vzcy5cblx0Ly8gRm9yIG5vbi1mcmFtZSBzY29waW5nLCB0aGUgY2FsbGVyIG11c3QgaGFuZGxlIGRpYWxvZyBkZXRlY3Rpb24gc2VwYXJhdGVseVxuXHQvLyBpZiBuZWVkZWQuIEhlcmUgd2UgaGFuZGxlIHRoZSBmcmFtZSBjYXNlIGFuZCBmYWxsIHRocm91Z2ggdG8gZnVsbF9wYWdlLlxuXHRpZiAoZnJhbWUpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0c2VsZWN0b3I6IFwiYm9keVwiLFxuXHRcdFx0c2NvcGU6IGZyYW1lLm5hbWUoKVxuXHRcdFx0XHQ/IGBhY3RpdmUgZnJhbWU6JHtmcmFtZS5uYW1lKCl9YFxuXHRcdFx0XHQ6IFwiYWN0aXZlIGZyYW1lXCIsXG5cdFx0XHRzb3VyY2U6IFwiYWN0aXZlX2ZyYW1lXCIsXG5cdFx0fTtcblx0fVxuXHRyZXR1cm4geyBzZWxlY3RvcjogXCJib2R5XCIsIHNjb3BlOiBcImZ1bGwgcGFnZVwiLCBzb3VyY2U6IFwiZnVsbF9wYWdlXCIgfTtcbn1cblxuLyoqXG4gKiBjYXB0dXJlQWNjZXNzaWJpbGl0eU1hcmtkb3duIFx1MjAxNCBuZWVkcyBhY2Nlc3MgdG8gdGhlIGFjdGl2ZSB0YXJnZXQuXG4gKiBBY2NlcHRzIHRoZSB0YXJnZXQgKFBhZ2UgfCBGcmFtZSkgc28gaXQgZG9lc24ndCBuZWVkIHRvIHB1bGwgZnJvbSBzdGF0ZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNhcHR1cmVBY2Nlc3NpYmlsaXR5TWFya2Rvd24oXG5cdHRhcmdldDogUGFnZSB8IEZyYW1lLFxuXHRzZWxlY3Rvcj86IHN0cmluZyxcbik6IFByb21pc2U8eyBzbmFwc2hvdDogc3RyaW5nOyBzY29wZTogc3RyaW5nOyBzb3VyY2U6IHN0cmluZyB9PiB7XG5cdGNvbnN0IHNjb3BlSW5mbyA9IGF3YWl0IHJlc29sdmVBY2Nlc3NpYmlsaXR5U2NvcGUoc2VsZWN0b3IpO1xuXHRjb25zdCBsb2NhdG9yID0gdGFyZ2V0LmxvY2F0b3Ioc2NvcGVJbmZvLnNlbGVjdG9yID8/IFwiYm9keVwiKS5maXJzdCgpO1xuXHRjb25zdCBzbmFwc2hvdCA9IGF3YWl0IGxvY2F0b3IuYXJpYVNuYXBzaG90KCk7XG5cdHJldHVybiB7IHNuYXBzaG90LCBzY29wZTogc2NvcGVJbmZvLnNjb3BlLCBzb3VyY2U6IHNjb3BlSW5mby5zb3VyY2UgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBDcml0aWNhbCByZXF1ZXN0IHRyYWNraW5nXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzQ3JpdGljYWxSZXNvdXJjZVR5cGUocmVzb3VyY2VUeXBlOiBzdHJpbmcpOiBib29sZWFuIHtcblx0cmV0dXJuIHJlc291cmNlVHlwZSA9PT0gXCJkb2N1bWVudFwiIHx8IHJlc291cmNlVHlwZSA9PT0gXCJmZXRjaFwiIHx8IHJlc291cmNlVHlwZSA9PT0gXCJ4aHJcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBlbmRpbmdDcml0aWNhbFJlcXVlc3RzKHA6IFBhZ2UsIGRlbHRhOiBudW1iZXIpOiB2b2lkIHtcblx0Y29uc3QgbWFwID0gZ2V0UGVuZGluZ0NyaXRpY2FsUmVxdWVzdHNCeVBhZ2UoKTtcblx0Y29uc3QgY3VycmVudCA9IG1hcC5nZXQocCkgPz8gMDtcblx0bWFwLnNldChwLCBNYXRoLm1heCgwLCBjdXJyZW50ICsgZGVsdGEpKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFBlbmRpbmdDcml0aWNhbFJlcXVlc3RzKHA6IFBhZ2UpOiBudW1iZXIge1xuXHRyZXR1cm4gZ2V0UGVuZGluZ0NyaXRpY2FsUmVxdWVzdHNCeVBhZ2UoKS5nZXQocCkgPz8gMDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBWZXJpZmljYXRpb24gaGVscGVyc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBmdW5jdGlvbiB2ZXJpZmljYXRpb25Gcm9tQ2hlY2tzKFxuXHRjaGVja3M6IEJyb3dzZXJWZXJpZmljYXRpb25DaGVja1tdLFxuXHRyZXRyeUhpbnQ/OiBzdHJpbmcsXG4pOiBCcm93c2VyVmVyaWZpY2F0aW9uUmVzdWx0IHtcblx0Y29uc3QgcGFzc2VkQ2hlY2tzID0gY2hlY2tzXG5cdFx0LmZpbHRlcigoY2hlY2spID0+IGNoZWNrLnBhc3NlZClcblx0XHQubWFwKChjaGVjaykgPT4gY2hlY2submFtZSk7XG5cdGNvbnN0IHZlcmlmaWVkID0gcGFzc2VkQ2hlY2tzLmxlbmd0aCA+IDA7XG5cdHJldHVybiB7XG5cdFx0dmVyaWZpZWQsXG5cdFx0Y2hlY2tzLFxuXHRcdHZlcmlmaWNhdGlvblN1bW1hcnk6IHZlcmlmaWVkXG5cdFx0XHQ/IGBQQVNTICgke3Bhc3NlZENoZWNrcy5qb2luKFwiLCBcIil9KWBcblx0XHRcdDogXCJTT0ZULUZBSUwgKG5vIG9ic2VydmFibGUgc3RhdGUgY2hhbmdlKVwiLFxuXHRcdHJldHJ5SGludDogdmVyaWZpZWQgPyB1bmRlZmluZWQgOiByZXRyeUhpbnQsXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB2ZXJpZmljYXRpb25MaW5lKHZlcmlmaWNhdGlvbjogQnJvd3NlclZlcmlmaWNhdGlvblJlc3VsdCk6IHN0cmluZyB7XG5cdHJldHVybiBgVmVyaWZpY2F0aW9uOiAke3ZlcmlmaWNhdGlvbi52ZXJpZmljYXRpb25TdW1tYXJ5fWA7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQXNzZXJ0aW9uIGhlbHBlcnNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY29sbGVjdEFzc2VydGlvblN0YXRlKFxuXHRwOiBQYWdlLFxuXHRjaGVja3M6IEJyb3dzZXJBc3NlcnRpb25DaGVja0lucHV0W10sXG5cdGNhcHR1cmVDb21wYWN0UGFnZVN0YXRlOiAoXG5cdFx0cDogUGFnZSxcblx0XHRvcHRpb25zPzogeyBzZWxlY3RvcnM/OiBzdHJpbmdbXTsgaW5jbHVkZUJvZHlUZXh0PzogYm9vbGVhbjsgdGFyZ2V0PzogUGFnZSB8IEZyYW1lIH0sXG5cdCkgPT4gUHJvbWlzZTxDb21wYWN0UGFnZVN0YXRlPixcblx0dGFyZ2V0PzogUGFnZSB8IEZyYW1lLFxuKTogUHJvbWlzZTx7XG5cdHVybDogc3RyaW5nO1xuXHR0aXRsZTogc3RyaW5nO1xuXHRib2R5VGV4dDogc3RyaW5nO1xuXHRmb2N1czogc3RyaW5nO1xuXHRzZWxlY3RvclN0YXRlczogUmVjb3JkPHN0cmluZywgQ29tcGFjdFNlbGVjdG9yU3RhdGU+O1xuXHRjb25zb2xlRW50cmllczogQ29uc29sZUVudHJ5W107XG5cdG5ldHdvcmtFbnRyaWVzOiBOZXR3b3JrRW50cnlbXTtcblx0YWxsQ29uc29sZUVudHJpZXM6IENvbnNvbGVFbnRyeVtdO1xuXHRhbGxOZXR3b3JrRW50cmllczogTmV0d29ya0VudHJ5W107XG5cdGFjdGlvblRpbWVsaW5lOiB0eXBlb2YgYWN0aW9uVGltZWxpbmU7XG59PiB7XG5cdGNvbnN0IHNlbGVjdG9ycyA9IGNoZWNrc1xuXHRcdC5tYXAoKGNoZWNrKSA9PiBjaGVjay5zZWxlY3Rvcilcblx0XHQuZmlsdGVyKCh2YWx1ZSk6IHZhbHVlIGlzIHN0cmluZyA9PiAhIXZhbHVlKTtcblx0Y29uc3QgY29tcGFjdFN0YXRlID0gYXdhaXQgY2FwdHVyZUNvbXBhY3RQYWdlU3RhdGUocCwge1xuXHRcdHNlbGVjdG9ycyxcblx0XHRpbmNsdWRlQm9keVRleHQ6IHRydWUsXG5cdFx0dGFyZ2V0LFxuXHR9KTtcblx0Y29uc3Qgc2luY2VBY3Rpb25JZCA9IGNoZWNrcy5yZWR1Y2U8bnVtYmVyIHwgdW5kZWZpbmVkPigobWF4LCBjaGVjaykgPT4ge1xuXHRcdGlmIChjaGVjay5zaW5jZUFjdGlvbklkID09PSB1bmRlZmluZWQpIHJldHVybiBtYXg7XG5cdFx0aWYgKG1heCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gY2hlY2suc2luY2VBY3Rpb25JZDtcblx0XHRyZXR1cm4gTWF0aC5tYXgobWF4LCBjaGVjay5zaW5jZUFjdGlvbklkKTtcblx0fSwgdW5kZWZpbmVkKTtcblx0cmV0dXJuIHtcblx0XHR1cmw6IGNvbXBhY3RTdGF0ZS51cmwsXG5cdFx0dGl0bGU6IGNvbXBhY3RTdGF0ZS50aXRsZSxcblx0XHRib2R5VGV4dDogY29tcGFjdFN0YXRlLmJvZHlUZXh0LFxuXHRcdGZvY3VzOiBjb21wYWN0U3RhdGUuZm9jdXMsXG5cdFx0c2VsZWN0b3JTdGF0ZXM6IGNvbXBhY3RTdGF0ZS5zZWxlY3RvclN0YXRlcyxcblx0XHRjb25zb2xlRW50cmllczogZ2V0Q29uc29sZUVudHJpZXNTaW5jZShzaW5jZUFjdGlvbklkKSxcblx0XHRuZXR3b3JrRW50cmllczogZ2V0TmV0d29ya0VudHJpZXNTaW5jZShzaW5jZUFjdGlvbklkKSxcblx0XHRhbGxDb25zb2xlRW50cmllczogZ2V0Q29uc29sZUxvZ3MoKSxcblx0XHRhbGxOZXR3b3JrRW50cmllczogZ2V0TmV0d29ya0xvZ3MoKSxcblx0XHRhY3Rpb25UaW1lbGluZSxcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdEFzc2VydGlvblRleHQoXG5cdHJlc3VsdDogUmV0dXJuVHlwZTx0eXBlb2YgaW1wb3J0KFwiLi9jb3JlLmpzXCIpLmV2YWx1YXRlQXNzZXJ0aW9uQ2hlY2tzPixcbik6IHN0cmluZyB7XG5cdGNvbnN0IGxpbmVzID0gW3Jlc3VsdC5zdW1tYXJ5XTtcblx0Zm9yIChjb25zdCBjaGVjayBvZiByZXN1bHQuY2hlY2tzLnNsaWNlKDAsIDgpKSB7XG5cdFx0bGluZXMucHVzaChcblx0XHRcdGAtICR7Y2hlY2sucGFzc2VkID8gXCJQQVNTXCIgOiBcIkZBSUxcIn0gJHtjaGVjay5uYW1lfTogZXhwZWN0ZWQgJHtKU09OLnN0cmluZ2lmeShjaGVjay5leHBlY3RlZCl9LCBnb3QgJHtKU09OLnN0cmluZ2lmeShjaGVjay5hY3R1YWwpfWAsXG5cdFx0KTtcblx0fVxuXHRsaW5lcy5wdXNoKGBIaW50OiAke3Jlc3VsdC5hZ2VudEhpbnR9YCk7XG5cdHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0RGlmZlRleHQoXG5cdGRpZmY6IFJldHVyblR5cGU8dHlwZW9mIGltcG9ydChcIi4vY29yZS5qc1wiKS5kaWZmQ29tcGFjdFN0YXRlcz4sXG4pOiBzdHJpbmcge1xuXHRjb25zdCBsaW5lcyA9IFtkaWZmLnN1bW1hcnldO1xuXHRmb3IgKGNvbnN0IGNoYW5nZSBvZiBkaWZmLmNoYW5nZXMuc2xpY2UoMCwgOCkpIHtcblx0XHRsaW5lcy5wdXNoKFxuXHRcdFx0YC0gJHtjaGFuZ2UudHlwZX06ICR7SlNPTi5zdHJpbmdpZnkoY2hhbmdlLmJlZm9yZSA/PyBudWxsKX0gXHUyMTkyICR7SlNPTi5zdHJpbmdpZnkoY2hhbmdlLmFmdGVyID8/IG51bGwpfWAsXG5cdFx0KTtcblx0fVxuXHRyZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBVUkwgLyBkaWFsb2cgaGVscGVyc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRVcmxIYXNoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcblx0dHJ5IHtcblx0XHRyZXR1cm4gbmV3IFVSTCh1cmwpLmhhc2ggfHwgXCJcIjtcblx0fSBjYXRjaCB7XG5cdFx0cmV0dXJuIFwiXCI7XG5cdH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvdW50T3BlbkRpYWxvZ3ModGFyZ2V0OiBQYWdlIHwgRnJhbWUpOiBQcm9taXNlPG51bWJlcj4ge1xuXHR0cnkge1xuXHRcdHJldHVybiBhd2FpdCB0YXJnZXQuZXZhbHVhdGUoKCkgPT5cblx0XHRcdGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tyb2xlPVwiZGlhbG9nXCJdOm5vdChbaGlkZGVuXSksZGlhbG9nW29wZW5dJylcblx0XHRcdFx0Lmxlbmd0aCxcblx0XHQpO1xuXHR9IGNhdGNoIHtcblx0XHRyZXR1cm4gMDtcblx0fVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIENsaWNrIC8gaW5wdXQgaGVscGVyc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjYXB0dXJlQ2xpY2tUYXJnZXRTdGF0ZShcblx0dGFyZ2V0OiBQYWdlIHwgRnJhbWUsXG5cdHNlbGVjdG9yOiBzdHJpbmcsXG4pOiBQcm9taXNlPENsaWNrVGFyZ2V0U3RhdGVTbmFwc2hvdD4ge1xuXHR0cnkge1xuXHRcdHJldHVybiBhd2FpdCB0YXJnZXQuZXZhbHVhdGUoKHNlbCkgPT4ge1xuXHRcdFx0Y29uc3QgZWwgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKHNlbCkgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuXHRcdFx0aWYgKCFlbCkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGV4aXN0czogZmFsc2UsXG5cdFx0XHRcdFx0YXJpYUV4cGFuZGVkOiBudWxsLFxuXHRcdFx0XHRcdGFyaWFQcmVzc2VkOiBudWxsLFxuXHRcdFx0XHRcdGFyaWFTZWxlY3RlZDogbnVsbCxcblx0XHRcdFx0XHRvcGVuOiBudWxsLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0ZXhpc3RzOiB0cnVlLFxuXHRcdFx0XHRhcmlhRXhwYW5kZWQ6IGVsLmdldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiksXG5cdFx0XHRcdGFyaWFQcmVzc2VkOiBlbC5nZXRBdHRyaWJ1dGUoXCJhcmlhLXByZXNzZWRcIiksXG5cdFx0XHRcdGFyaWFTZWxlY3RlZDogZWwuZ2V0QXR0cmlidXRlKFwiYXJpYS1zZWxlY3RlZFwiKSxcblx0XHRcdFx0b3Blbjpcblx0XHRcdFx0XHRlbCBpbnN0YW5jZW9mIEhUTUxEaWFsb2dFbGVtZW50XG5cdFx0XHRcdFx0XHQ/IGVsLm9wZW5cblx0XHRcdFx0XHRcdDogZWwuZ2V0QXR0cmlidXRlKFwib3BlblwiKSAhPT0gbnVsbCxcblx0XHRcdH07XG5cdFx0fSwgc2VsZWN0b3IpO1xuXHR9IGNhdGNoIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0ZXhpc3RzOiBmYWxzZSxcblx0XHRcdGFyaWFFeHBhbmRlZDogbnVsbCxcblx0XHRcdGFyaWFQcmVzc2VkOiBudWxsLFxuXHRcdFx0YXJpYVNlbGVjdGVkOiBudWxsLFxuXHRcdFx0b3BlbjogbnVsbCxcblx0XHR9O1xuXHR9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkSW5wdXRMaWtlVmFsdWUoXG5cdHRhcmdldDogUGFnZSB8IEZyYW1lLFxuXHRzZWxlY3Rvcj86IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuXHR0cnkge1xuXHRcdHJldHVybiBhd2FpdCB0YXJnZXQuZXZhbHVhdGUoKHNlbCkgPT4ge1xuXHRcdFx0Y29uc3QgcmVzb2x2ZVRhcmdldCA9ICgpOiBFbGVtZW50IHwgbnVsbCA9PiB7XG5cdFx0XHRcdGlmIChzZWwpIHJldHVybiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKHNlbCk7XG5cdFx0XHRcdGNvbnN0IGFjdGl2ZSA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ7XG5cdFx0XHRcdGlmIChcblx0XHRcdFx0XHQhYWN0aXZlIHx8XG5cdFx0XHRcdFx0YWN0aXZlID09PSBkb2N1bWVudC5ib2R5IHx8XG5cdFx0XHRcdFx0YWN0aXZlID09PSBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnRcblx0XHRcdFx0KVxuXHRcdFx0XHRcdHJldHVybiBudWxsO1xuXHRcdFx0XHRyZXR1cm4gYWN0aXZlO1xuXHRcdFx0fTtcblxuXHRcdFx0Y29uc3QgdGFyZ2V0ID0gcmVzb2x2ZVRhcmdldCgpO1xuXHRcdFx0aWYgKCF0YXJnZXQpIHJldHVybiBudWxsO1xuXHRcdFx0aWYgKFxuXHRcdFx0XHR0YXJnZXQgaW5zdGFuY2VvZiBIVE1MSW5wdXRFbGVtZW50IHx8XG5cdFx0XHRcdHRhcmdldCBpbnN0YW5jZW9mIEhUTUxUZXh0QXJlYUVsZW1lbnRcblx0XHRcdCkge1xuXHRcdFx0XHRyZXR1cm4gdGFyZ2V0LnZhbHVlO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHRhcmdldCBpbnN0YW5jZW9mIEhUTUxTZWxlY3RFbGVtZW50KSB7XG5cdFx0XHRcdHJldHVybiB0YXJnZXQudmFsdWU7XG5cdFx0XHR9XG5cdFx0XHRpZiAoKHRhcmdldCBhcyBIVE1MRWxlbWVudCkuaXNDb250ZW50RWRpdGFibGUpIHtcblx0XHRcdFx0cmV0dXJuICh0YXJnZXQudGV4dENvbnRlbnQgPz8gXCJcIikudHJpbSgpO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuICh0YXJnZXQgYXMgSFRNTEVsZW1lbnQpLmdldEF0dHJpYnV0ZShcInZhbHVlXCIpO1xuXHRcdH0sIHNlbGVjdG9yKTtcblx0fSBjYXRjaCB7XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZpcnN0RXJyb3JMaW5lKGVycjogdW5rbm93bik6IHN0cmluZyB7XG5cdGNvbnN0IG1lc3NhZ2UgPVxuXHRcdHR5cGVvZiBlcnIgPT09IFwib2JqZWN0XCIgJiYgZXJyICYmIFwibWVzc2FnZVwiIGluIGVyclxuXHRcdFx0PyBTdHJpbmcoKGVyciBhcyB7IG1lc3NhZ2U/OiB1bmtub3duIH0pLm1lc3NhZ2UgPz8gXCJcIilcblx0XHRcdDogU3RyaW5nKGVyciA/PyBcInVua25vd24gZXJyb3JcIik7XG5cdHJldHVybiBtZXNzYWdlLnNwbGl0KFwiXFxuXCIpWzBdIHx8IFwidW5rbm93biBlcnJvclwiO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEFjdGlvbiB0cmFja2luZ1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBmdW5jdGlvbiBiZWdpblRyYWNrZWRBY3Rpb24oXG5cdHRvb2w6IHN0cmluZyxcblx0cGFyYW1zOiB1bmtub3duLFxuXHRiZWZvcmVVcmw6IHN0cmluZyxcbikge1xuXHRyZXR1cm4gYmVnaW5BY3Rpb24oYWN0aW9uVGltZWxpbmUsIHtcblx0XHR0b29sLFxuXHRcdHBhcmFtc1N1bW1hcnk6IHRvQWN0aW9uUGFyYW1zU3VtbWFyeShwYXJhbXMpLFxuXHRcdGJlZm9yZVVybCxcblx0fSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmaW5pc2hUcmFja2VkQWN0aW9uKFxuXHRhY3Rpb25JZDogbnVtYmVyLFxuXHR1cGRhdGVzOiB7XG5cdFx0c3RhdHVzOiBcInN1Y2Nlc3NcIiB8IFwiZXJyb3JcIjtcblx0XHRhZnRlclVybD86IHN0cmluZztcblx0XHR2ZXJpZmljYXRpb25TdW1tYXJ5Pzogc3RyaW5nO1xuXHRcdHdhcm5pbmdTdW1tYXJ5Pzogc3RyaW5nO1xuXHRcdGRpZmZTdW1tYXJ5Pzogc3RyaW5nO1xuXHRcdGNoYW5nZWQ/OiBib29sZWFuO1xuXHRcdGVycm9yPzogc3RyaW5nO1xuXHRcdGJlZm9yZVN0YXRlPzogQ29tcGFjdFBhZ2VTdGF0ZTtcblx0XHRhZnRlclN0YXRlPzogQ29tcGFjdFBhZ2VTdGF0ZTtcblx0fSxcbikge1xuXHRyZXR1cm4gZmluaXNoQWN0aW9uKGFjdGlvblRpbWVsaW5lLCBhY3Rpb25JZCwgdXBkYXRlcyk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRTaW5jZVRpbWVzdGFtcChzaW5jZUFjdGlvbklkPzogbnVtYmVyKTogbnVtYmVyIHtcblx0aWYgKCFzaW5jZUFjdGlvbklkKSByZXR1cm4gMDtcblx0Y29uc3QgYWN0aW9uID0gZmluZEFjdGlvbihhY3Rpb25UaW1lbGluZSwgc2luY2VBY3Rpb25JZCk7XG5cdGlmICghYWN0aW9uKSByZXR1cm4gMDtcblx0cmV0dXJuIGFjdGlvbi5zdGFydGVkQXQgPz8gMDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldENvbnNvbGVFbnRyaWVzU2luY2Uoc2luY2VBY3Rpb25JZD86IG51bWJlcik6IENvbnNvbGVFbnRyeVtdIHtcblx0Y29uc3Qgc2luY2UgPSBnZXRTaW5jZVRpbWVzdGFtcChzaW5jZUFjdGlvbklkKTtcblx0cmV0dXJuIGdldENvbnNvbGVMb2dzKCkuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkudGltZXN0YW1wID49IHNpbmNlKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldE5ldHdvcmtFbnRyaWVzU2luY2Uoc2luY2VBY3Rpb25JZD86IG51bWJlcik6IE5ldHdvcmtFbnRyeVtdIHtcblx0Y29uc3Qgc2luY2UgPSBnZXRTaW5jZVRpbWVzdGFtcChzaW5jZUFjdGlvbklkKTtcblx0cmV0dXJuIGdldE5ldHdvcmtMb2dzKCkuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkudGltZXN0YW1wID49IHNpbmNlKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBFcnJvciBzdW1tYXJ5XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJlY2VudEVycm9ycyhwYWdlVXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcblx0Y29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcblx0Y29uc3Qgc2luY2UgPSBub3cgLSAxMl8wMDA7XG5cblx0Y29uc3QgdG9PcmlnaW4gPSAodXJsOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsID0+IHtcblx0XHR0cnkge1xuXHRcdFx0cmV0dXJuIG5ldyBVUkwodXJsKS5vcmlnaW47XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHRyZXR1cm4gbnVsbDtcblx0XHR9XG5cdH07XG5cdGNvbnN0IHBhZ2VPcmlnaW4gPSB0b09yaWdpbihwYWdlVXJsKTtcblx0Y29uc3Qgc2FtZU9yaWdpbiA9ICh1cmw6IHN0cmluZyk6IGJvb2xlYW4gPT5cblx0XHQhcGFnZU9yaWdpbiB8fCB0b09yaWdpbih1cmwpID09PSBwYWdlT3JpZ2luO1xuXG5cdGNvbnN0IHN1bW1hcml6ZSA9IChpdGVtczogc3RyaW5nW10sIG1heDogbnVtYmVyKTogc3RyaW5nW10gPT4ge1xuXHRcdGNvbnN0IGNvdW50cyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG5cdFx0Y29uc3Qgb3JkZXI6IHN0cmluZ1tdID0gW107XG5cdFx0Zm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XG5cdFx0XHRpZiAoIWNvdW50cy5oYXMoaXRlbSkpIG9yZGVyLnB1c2goaXRlbSk7XG5cdFx0XHRjb3VudHMuc2V0KGl0ZW0sIChjb3VudHMuZ2V0KGl0ZW0pID8/IDApICsgMSk7XG5cdFx0fVxuXHRcdHJldHVybiBvcmRlci5zbGljZSgwLCBtYXgpLm1hcCgoaXRlbSkgPT4ge1xuXHRcdFx0Y29uc3QgY291bnQgPSBjb3VudHMuZ2V0KGl0ZW0pID8/IDE7XG5cdFx0XHRyZXR1cm4gY291bnQgPiAxID8gYCR7aXRlbX0gKHgke2NvdW50fSlgIDogaXRlbTtcblx0XHR9KTtcblx0fTtcblxuXHRjb25zdCBjb25zb2xlTG9ncyA9IGdldENvbnNvbGVMb2dzKCk7XG5cdGNvbnN0IGpzV2FybmluZ3MgPSBjb25zb2xlTG9nc1xuXHRcdC5maWx0ZXIoXG5cdFx0XHQoZSkgPT5cblx0XHRcdFx0KGUudHlwZSA9PT0gXCJlcnJvclwiIHx8IGUudHlwZSA9PT0gXCJwYWdlZXJyb3JcIikgJiZcblx0XHRcdFx0ZS50aW1lc3RhbXAgPj0gc2luY2UgJiZcblx0XHRcdFx0c2FtZU9yaWdpbihlLnVybCksXG5cdFx0KVxuXHRcdC5tYXAoKGUpID0+IGUudGV4dC5zbGljZSgwLCAxMjApKTtcblx0aWYgKGpzV2FybmluZ3MubGVuZ3RoID4gMCkge1xuXHRcdHBhcnRzLnB1c2goXCJKUzogXCIgKyBzdW1tYXJpemUoanNXYXJuaW5ncywgMikuam9pbihcIiB8IFwiKSk7XG5cdH1cblxuXHRjb25zdCBhY3Rpb25hYmxlU3RhdHVzID0gbmV3IFNldChbNDAxLCA0MDMsIDQwNCwgNDA4LCA0MDksIDQyMiwgNDI5XSk7XG5cdGNvbnN0IGFjdGlvbmFibGVUeXBlcyA9IG5ldyBTZXQoW1wiZG9jdW1lbnRcIiwgXCJmZXRjaFwiLCBcInhoclwiLCBcInNjcmlwdFwiXSk7XG5cdGNvbnN0IG5ldHdvcmtMb2dzID0gZ2V0TmV0d29ya0xvZ3MoKTtcblx0Y29uc3QgbmV0V2FybmluZ3MgPSBuZXR3b3JrTG9nc1xuXHRcdC5maWx0ZXIoKGUpID0+IGUudGltZXN0YW1wID49IHNpbmNlICYmIHNhbWVPcmlnaW4oZS51cmwpKVxuXHRcdC5maWx0ZXIoKGUpID0+IHtcblx0XHRcdGlmIChlLmZhaWxlZCkgcmV0dXJuIGFjdGlvbmFibGVUeXBlcy5oYXMoZS5yZXNvdXJjZVR5cGUpO1xuXHRcdFx0aWYgKGUuc3RhdHVzID09PSBudWxsKSByZXR1cm4gZmFsc2U7XG5cdFx0XHRpZiAoZS5zdGF0dXMgPj0gNTAwKSByZXR1cm4gdHJ1ZTtcblx0XHRcdHJldHVybiAoXG5cdFx0XHRcdGFjdGlvbmFibGVTdGF0dXMuaGFzKGUuc3RhdHVzKSAmJlxuXHRcdFx0XHRhY3Rpb25hYmxlVHlwZXMuaGFzKGUucmVzb3VyY2VUeXBlKVxuXHRcdFx0KTtcblx0XHR9KVxuXHRcdC5tYXAoKGUpID0+IHtcblx0XHRcdGlmIChlLmZhaWxlZCkgcmV0dXJuIGAke2UubWV0aG9kfSAke2UucmVzb3VyY2VUeXBlfSBGQUlMRURgO1xuXHRcdFx0cmV0dXJuIGAke2UubWV0aG9kfSAke2UucmVzb3VyY2VUeXBlfSAke2Uuc3RhdHVzfWA7XG5cdFx0fSk7XG5cdGlmIChuZXRXYXJuaW5ncy5sZW5ndGggPiAwKSB7XG5cdFx0cGFydHMucHVzaChcIk5ldHdvcms6IFwiICsgc3VtbWFyaXplKG5ldFdhcm5pbmdzLCAyKS5qb2luKFwiIHwgXCIpKTtcblx0fVxuXG5cdGNvbnN0IGRpYWxvZ0xvZ3MgPSBnZXREaWFsb2dMb2dzKCk7XG5cdGNvbnN0IGRpYWxvZ1dhcm5pbmdzID0gZGlhbG9nTG9nc1xuXHRcdC5maWx0ZXIoKGUpID0+IGUudGltZXN0YW1wID49IHNpbmNlICYmIHNhbWVPcmlnaW4oZS51cmwpKVxuXHRcdC5tYXAoKGUpID0+IGAke2UudHlwZX06ICR7ZS5tZXNzYWdlLnNsaWNlKDAsIDgwKX1gKTtcblx0aWYgKGRpYWxvZ1dhcm5pbmdzLmxlbmd0aCA+IDApIHtcblx0XHRwYXJ0cy5wdXNoKFwiRGlhbG9nczogXCIgKyBzdW1tYXJpemUoZGlhbG9nV2FybmluZ3MsIDEpLmpvaW4oXCIgfCBcIikpO1xuXHR9XG5cblx0aWYgKHBhcnRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFwiXCI7XG5cdHJldHVybiBgXFxuXFxuV2FybmluZ3M6ICR7cGFydHMuam9pbihcIjsgXCIpfVxcblVzZSBicm93c2VyX2dldF9jb25zb2xlX2xvZ3MvYnJvd3Nlcl9nZXRfbmV0d29ya19sb2dzIGZvciBmdWxsIGRpYWdub3N0aWNzLmA7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUmVmIGhlbHBlcnMgKHBhcnNpbmcgLyBmb3JtYXR0aW5nIFx1MjAxNCBubyBicm93c2VyIGV2YWx1YXRlKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVJlZihpbnB1dDogc3RyaW5nKTogUGFyc2VkUmVmU3BlYyB7XG5cdGNvbnN0IHRyaW1tZWQgPSBpbnB1dC50cmltKCkudG9Mb3dlckNhc2UoKTtcblx0Y29uc3QgdG9rZW4gPSB0cmltbWVkLnN0YXJ0c1dpdGgoXCJAXCIpID8gdHJpbW1lZC5zbGljZSgxKSA6IHRyaW1tZWQ7XG5cdGNvbnN0IHZlcnNpb25lZCA9IHRva2VuLm1hdGNoKC9edihcXGQrKTooZVxcZCspJC8pO1xuXHRpZiAodmVyc2lvbmVkKSB7XG5cdFx0Y29uc3QgdmVyc2lvbiA9IHBhcnNlSW50KHZlcnNpb25lZFsxXSwgMTApO1xuXHRcdGNvbnN0IGtleSA9IHZlcnNpb25lZFsyXTtcblx0XHRyZXR1cm4geyBrZXksIHZlcnNpb24sIGRpc3BsYXk6IGBAdiR7dmVyc2lvbn06JHtrZXl9YCB9O1xuXHR9XG5cdHJldHVybiB7IGtleTogdG9rZW4sIHZlcnNpb246IG51bGwsIGRpc3BsYXk6IGBAJHt0b2tlbn1gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRWZXJzaW9uZWRSZWYodmVyc2lvbjogbnVtYmVyLCBrZXk6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiBgQHYke3ZlcnNpb259OiR7a2V5fWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzdGFsZVJlZkd1aWRhbmNlKHJlZkRpc3BsYXk6IHN0cmluZywgcmVhc29uOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gYFJlZiAke3JlZkRpc3BsYXl9IGNvdWxkIG5vdCBiZSByZXNvbHZlZCAoJHtyZWFzb259KS4gVGhlIHJlZiBpcyBsaWtlbHkgc3RhbGUgYWZ0ZXIgRE9NL25hdmlnYXRpb24gY2hhbmdlcy4gQ2FsbCBicm93c2VyX3NuYXBzaG90X3JlZnMgYWdhaW4gdG8gcmVmcmVzaCByZWZzLmA7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQ29tcGFjdCBzdGF0ZSBzdW1tYXJ5IGZvcm1hdHRpbmdcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0Q29tcGFjdFN0YXRlU3VtbWFyeShzdGF0ZTogQ29tcGFjdFBhZ2VTdGF0ZSk6IHN0cmluZyB7XG5cdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXHRsaW5lcy5wdXNoKGBUaXRsZTogJHtzdGF0ZS50aXRsZX1gKTtcblx0bGluZXMucHVzaChgVVJMOiAke3N0YXRlLnVybH1gKTtcblx0bGluZXMucHVzaChcblx0XHRgRWxlbWVudHM6ICR7c3RhdGUuY291bnRzLmxhbmRtYXJrc30gbGFuZG1hcmtzLCAke3N0YXRlLmNvdW50cy5idXR0b25zfSBidXR0b25zLCAke3N0YXRlLmNvdW50cy5saW5rc30gbGlua3MsICR7c3RhdGUuY291bnRzLmlucHV0c30gaW5wdXRzYCxcblx0KTtcblx0aWYgKHN0YXRlLmhlYWRpbmdzLmxlbmd0aCA+IDApIHtcblx0XHRsaW5lcy5wdXNoKFxuXHRcdFx0XCJIZWFkaW5nczogXCIgK1xuXHRcdFx0XHRzdGF0ZS5oZWFkaW5nc1xuXHRcdFx0XHRcdC5tYXAoKHRleHQsIGluZGV4KSA9PiBgSCR7aW5kZXggKyAxfSBcXFwiJHt0ZXh0fVxcXCJgKVxuXHRcdFx0XHRcdC5qb2luKFwiLCBcIiksXG5cdFx0KTtcblx0fVxuXHRpZiAoc3RhdGUuZm9jdXMpIHtcblx0XHRsaW5lcy5wdXNoKGBGb2N1c2VkOiAke3N0YXRlLmZvY3VzfWApO1xuXHR9XG5cdGlmIChzdGF0ZS5kaWFsb2cudGl0bGUpIHtcblx0XHRsaW5lcy5wdXNoKGBBY3RpdmUgZGlhbG9nOiBcIiR7c3RhdGUuZGlhbG9nLnRpdGxlfVwiYCk7XG5cdH1cblx0bGluZXMucHVzaChcblx0XHRcIlVzZSBicm93c2VyX2ZpbmQgZm9yIHRhcmdldGVkIGRpc2NvdmVyeSwgYnJvd3Nlcl9hc3NlcnQgZm9yIHZlcmlmaWNhdGlvbiwgb3IgYnJvd3Nlcl9nZXRfYWNjZXNzaWJpbGl0eV90cmVlIGZvciBmdWxsIGRldGFpbC5cIixcblx0KTtcblx0cmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFRQSxTQUFTLE9BQU8sTUFBTSxXQUFXLGdCQUFnQjtBQUNqRCxPQUFPLFVBQVU7QUFDakI7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBQ1A7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFDUDtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FnQk07QUFNQSxTQUFTLGFBQWEsTUFBc0I7QUFDbEQsUUFBTSxTQUFTLGFBQWEsTUFBTTtBQUFBLElBQ2pDLFVBQVU7QUFBQSxJQUNWLFVBQVU7QUFBQSxFQUNYLENBQUM7QUFDRCxNQUFJLE9BQU8sV0FBVztBQUNyQixXQUNDLE9BQU8sVUFDUDtBQUFBO0FBQUEscUJBQTBCLE9BQU8sV0FBVyxJQUFJLE9BQU8sVUFBVTtBQUFBLEVBRW5FO0FBQ0EsU0FBTyxPQUFPO0FBQ2Y7QUFNTyxTQUFTLHdCQUF3QixXQUEyQjtBQUNsRSxTQUFPLElBQUksS0FBSyxTQUFTLEVBQUUsWUFBWSxFQUFFLFFBQVEsU0FBUyxHQUFHO0FBQzlEO0FBRUEsZUFBc0IsVUFBVSxTQUFrQztBQUNqRSxRQUFNLE1BQU0sU0FBUyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3hDLFNBQU87QUFDUjtBQUVBLGVBQXNCLGtCQUNyQixVQUNBLFNBQzJDO0FBQzNDLFFBQU0sVUFBVSxLQUFLLFFBQVEsUUFBUSxDQUFDO0FBQ3RDLFFBQU0sVUFBVSxVQUFVLE9BQU87QUFDakMsUUFBTSxXQUFXLE1BQU0sS0FBSyxRQUFRO0FBQ3BDLFNBQU8sRUFBRSxNQUFNLFVBQVUsT0FBTyxTQUFTLEtBQUs7QUFDL0M7QUFFQSxlQUFzQixpQkFDckIsWUFDQSxpQkFDMkM7QUFDM0MsUUFBTSxVQUFVLEtBQUssUUFBUSxlQUFlLENBQUM7QUFDN0MsUUFBTSxTQUFTLFlBQVksZUFBZTtBQUMxQyxRQUFNLFdBQVcsTUFBTSxLQUFLLGVBQWU7QUFDM0MsU0FBTyxFQUFFLE1BQU0saUJBQWlCLE9BQU8sU0FBUyxLQUFLO0FBQ3REO0FBRU8sU0FBUyx5QkFBaUM7QUFDaEQsTUFBSSxJQUFJLG9CQUFvQjtBQUM1QixNQUFJLENBQUMsR0FBRztBQUNQLFFBQUksS0FBSyxJQUFJO0FBQ2Isd0JBQW9CLENBQUM7QUFBQSxFQUN0QjtBQUNBLFNBQU87QUFDUjtBQUVBLGVBQXNCLDJCQUE0QztBQUNqRSxRQUFNLFdBQVcsc0JBQXNCO0FBQ3ZDLE1BQUksVUFBVTtBQUNiLFVBQU0sVUFBVSxRQUFRO0FBQ3hCLFdBQU87QUFBQSxFQUNSO0FBQ0EsUUFBTSxZQUFZLHVCQUF1QjtBQUN6QyxRQUFNLE1BQU0sS0FBSyxLQUFLLGVBQWUsR0FBRyx3QkFBd0IsU0FBUyxDQUFDLFVBQVU7QUFDcEYsd0JBQXNCLEdBQUc7QUFDekIsUUFBTSxVQUFVLEdBQUc7QUFDbkIsU0FBTztBQUNSO0FBRU8sU0FBUyx5QkFBeUIsVUFBMEI7QUFDbEUsUUFBTSxNQUFNLHNCQUFzQjtBQUNsQyxNQUFJLENBQUMsS0FBSztBQUNULFVBQU0sSUFBSSxNQUFNLHVEQUF1RDtBQUFBLEVBQ3hFO0FBQ0EsU0FBTyxLQUFLLEtBQUssS0FBSyxRQUFRO0FBQy9CO0FBRU8sU0FBUyx3QkFBd0I7QUFDdkMsUUFBTSxXQUFXO0FBQ2pCLFFBQU0sY0FDTCxTQUFTLGlCQUFpQixPQUN2QixTQUFTLE1BQU0sS0FBSyxDQUFDLFVBQWUsTUFBTSxPQUFPLFNBQVMsWUFBWSxLQUFLLE9BQzNFO0FBQ0osU0FBTztBQUFBLElBQ04sSUFBSSxhQUFhLE1BQU07QUFBQSxJQUN2QixPQUFPLGFBQWEsU0FBUztBQUFBLElBQzdCLEtBQUssYUFBYSxPQUFPO0FBQUEsRUFDMUI7QUFDRDtBQUVPLFNBQVMseUJBQXlCO0FBQ3hDLFFBQU0sUUFBUSxlQUFlO0FBQzdCLE1BQUksQ0FBQyxPQUFPO0FBQ1gsV0FBTyxFQUFFLE1BQU0sTUFBTSxLQUFLLEtBQUs7QUFBQSxFQUNoQztBQUNBLFNBQU87QUFBQSxJQUNOLE1BQU0sTUFBTSxLQUFLLEtBQUs7QUFBQSxJQUN0QixLQUFLLE1BQU0sSUFBSSxLQUFLO0FBQUEsRUFDckI7QUFDRDtBQUVPLFNBQVMsNkJBQTZCO0FBQzVDLFNBQU87QUFBQSxJQUNOLGNBQWM7QUFBQSxJQUNkLGtCQUFrQixvQkFBb0I7QUFBQSxJQUN0QyxvQkFBb0Isc0JBQXNCO0FBQUEsSUFDMUMsb0JBQW9CLHNCQUFzQjtBQUFBLElBQzFDLFVBQVUsRUFBRSxHQUFHLFlBQVksRUFBRTtBQUFBLElBQzdCLFlBQVksc0JBQXNCO0FBQUEsSUFDbEMsYUFBYSx1QkFBdUI7QUFBQSxFQUNyQztBQUNEO0FBRU8sU0FBUyxxQkFBcUIsT0FBZSxVQUEwQjtBQUM3RSxRQUFNLFlBQVksTUFDaEIsS0FBSyxFQUNMLFFBQVEscUJBQXFCLEdBQUcsRUFDaEMsUUFBUSxZQUFZLEVBQUU7QUFDeEIsU0FBTyxhQUFhO0FBQ3JCO0FBVU8sU0FBUywyQkFDZixlQUNDO0FBQ0QsU0FBTyxlQUFlLHVCQUF1QjtBQUM1QyxVQUFNLGNBQWM7QUFDcEIsZUFBVyxTQUFTLGFBQWEsT0FBTztBQUN2QyxVQUFJO0FBQ0gsY0FBTSxRQUFRLE1BQU0sTUFBTSxLQUFLLE1BQU07QUFDckMsY0FBTSxNQUFNLE1BQU0sS0FBSyxJQUFJO0FBQUEsTUFDNUIsUUFBUTtBQUFBLE1BRVI7QUFBQSxJQUNEO0FBQ0EsV0FBTyxrQkFBa0IsWUFBWTtBQUFBLEVBQ3RDO0FBQ0Q7QUFFQSxlQUFzQiwwQkFDckIsVUFDZ0U7QUFDaEUsTUFBSSxVQUFVLEtBQUssR0FBRztBQUNyQixXQUFPO0FBQUEsTUFDTixVQUFVLFNBQVMsS0FBSztBQUFBLE1BQ3hCLE9BQU8sWUFBWSxTQUFTLEtBQUssQ0FBQztBQUFBLE1BQ2xDLFFBQVE7QUFBQSxJQUNUO0FBQUEsRUFDRDtBQUNBLFFBQU0sUUFBUSxlQUFlO0FBSTdCLE1BQUksT0FBTztBQUNWLFdBQU87QUFBQSxNQUNOLFVBQVU7QUFBQSxNQUNWLE9BQU8sTUFBTSxLQUFLLElBQ2YsZ0JBQWdCLE1BQU0sS0FBSyxDQUFDLEtBQzVCO0FBQUEsTUFDSCxRQUFRO0FBQUEsSUFDVDtBQUFBLEVBQ0Q7QUFDQSxTQUFPLEVBQUUsVUFBVSxRQUFRLE9BQU8sYUFBYSxRQUFRLFlBQVk7QUFDcEU7QUFNQSxlQUFzQiw2QkFDckIsUUFDQSxVQUMrRDtBQUMvRCxRQUFNLFlBQVksTUFBTSwwQkFBMEIsUUFBUTtBQUMxRCxRQUFNLFVBQVUsT0FBTyxRQUFRLFVBQVUsWUFBWSxNQUFNLEVBQUUsTUFBTTtBQUNuRSxRQUFNLFdBQVcsTUFBTSxRQUFRLGFBQWE7QUFDNUMsU0FBTyxFQUFFLFVBQVUsT0FBTyxVQUFVLE9BQU8sUUFBUSxVQUFVLE9BQU87QUFDckU7QUFNTyxTQUFTLHVCQUF1QixjQUErQjtBQUNyRSxTQUFPLGlCQUFpQixjQUFjLGlCQUFpQixXQUFXLGlCQUFpQjtBQUNwRjtBQUVPLFNBQVMsOEJBQThCLEdBQVMsT0FBcUI7QUFDM0UsUUFBTSxNQUFNLGlDQUFpQztBQUM3QyxRQUFNLFVBQVUsSUFBSSxJQUFJLENBQUMsS0FBSztBQUM5QixNQUFJLElBQUksR0FBRyxLQUFLLElBQUksR0FBRyxVQUFVLEtBQUssQ0FBQztBQUN4QztBQUVPLFNBQVMsMkJBQTJCLEdBQWlCO0FBQzNELFNBQU8saUNBQWlDLEVBQUUsSUFBSSxDQUFDLEtBQUs7QUFDckQ7QUFNTyxTQUFTLHVCQUNmLFFBQ0EsV0FDNEI7QUFDNUIsUUFBTSxlQUFlLE9BQ25CLE9BQU8sQ0FBQyxVQUFVLE1BQU0sTUFBTSxFQUM5QixJQUFJLENBQUMsVUFBVSxNQUFNLElBQUk7QUFDM0IsUUFBTSxXQUFXLGFBQWEsU0FBUztBQUN2QyxTQUFPO0FBQUEsSUFDTjtBQUFBLElBQ0E7QUFBQSxJQUNBLHFCQUFxQixXQUNsQixTQUFTLGFBQWEsS0FBSyxJQUFJLENBQUMsTUFDaEM7QUFBQSxJQUNILFdBQVcsV0FBVyxTQUFZO0FBQUEsRUFDbkM7QUFDRDtBQUVPLFNBQVMsaUJBQWlCLGNBQWlEO0FBQ2pGLFNBQU8saUJBQWlCLGFBQWEsbUJBQW1CO0FBQ3pEO0FBTUEsZUFBc0Isc0JBQ3JCLEdBQ0EsUUFDQSx5QkFJQSxRQVlFO0FBQ0YsUUFBTSxZQUFZLE9BQ2hCLElBQUksQ0FBQyxVQUFVLE1BQU0sUUFBUSxFQUM3QixPQUFPLENBQUMsVUFBMkIsQ0FBQyxDQUFDLEtBQUs7QUFDNUMsUUFBTSxlQUFlLE1BQU0sd0JBQXdCLEdBQUc7QUFBQSxJQUNyRDtBQUFBLElBQ0EsaUJBQWlCO0FBQUEsSUFDakI7QUFBQSxFQUNELENBQUM7QUFDRCxRQUFNLGdCQUFnQixPQUFPLE9BQTJCLENBQUMsS0FBSyxVQUFVO0FBQ3ZFLFFBQUksTUFBTSxrQkFBa0IsT0FBVyxRQUFPO0FBQzlDLFFBQUksUUFBUSxPQUFXLFFBQU8sTUFBTTtBQUNwQyxXQUFPLEtBQUssSUFBSSxLQUFLLE1BQU0sYUFBYTtBQUFBLEVBQ3pDLEdBQUcsTUFBUztBQUNaLFNBQU87QUFBQSxJQUNOLEtBQUssYUFBYTtBQUFBLElBQ2xCLE9BQU8sYUFBYTtBQUFBLElBQ3BCLFVBQVUsYUFBYTtBQUFBLElBQ3ZCLE9BQU8sYUFBYTtBQUFBLElBQ3BCLGdCQUFnQixhQUFhO0FBQUEsSUFDN0IsZ0JBQWdCLHVCQUF1QixhQUFhO0FBQUEsSUFDcEQsZ0JBQWdCLHVCQUF1QixhQUFhO0FBQUEsSUFDcEQsbUJBQW1CLGVBQWU7QUFBQSxJQUNsQyxtQkFBbUIsZUFBZTtBQUFBLElBQ2xDO0FBQUEsRUFDRDtBQUNEO0FBRU8sU0FBUyxvQkFDZixRQUNTO0FBQ1QsUUFBTSxRQUFRLENBQUMsT0FBTyxPQUFPO0FBQzdCLGFBQVcsU0FBUyxPQUFPLE9BQU8sTUFBTSxHQUFHLENBQUMsR0FBRztBQUM5QyxVQUFNO0FBQUEsTUFDTCxLQUFLLE1BQU0sU0FBUyxTQUFTLE1BQU0sSUFBSSxNQUFNLElBQUksY0FBYyxLQUFLLFVBQVUsTUFBTSxRQUFRLENBQUMsU0FBUyxLQUFLLFVBQVUsTUFBTSxNQUFNLENBQUM7QUFBQSxJQUNuSTtBQUFBLEVBQ0Q7QUFDQSxRQUFNLEtBQUssU0FBUyxPQUFPLFNBQVMsRUFBRTtBQUN0QyxTQUFPLE1BQU0sS0FBSyxJQUFJO0FBQ3ZCO0FBRU8sU0FBUyxlQUNmLE1BQ1M7QUFDVCxRQUFNLFFBQVEsQ0FBQyxLQUFLLE9BQU87QUFDM0IsYUFBVyxVQUFVLEtBQUssUUFBUSxNQUFNLEdBQUcsQ0FBQyxHQUFHO0FBQzlDLFVBQU07QUFBQSxNQUNMLEtBQUssT0FBTyxJQUFJLEtBQUssS0FBSyxVQUFVLE9BQU8sVUFBVSxJQUFJLENBQUMsV0FBTSxLQUFLLFVBQVUsT0FBTyxTQUFTLElBQUksQ0FBQztBQUFBLElBQ3JHO0FBQUEsRUFDRDtBQUNBLFNBQU8sTUFBTSxLQUFLLElBQUk7QUFDdkI7QUFNTyxTQUFTLFdBQVcsS0FBcUI7QUFDL0MsTUFBSTtBQUNILFdBQU8sSUFBSSxJQUFJLEdBQUcsRUFBRSxRQUFRO0FBQUEsRUFDN0IsUUFBUTtBQUNQLFdBQU87QUFBQSxFQUNSO0FBQ0Q7QUFFQSxlQUFzQixpQkFBaUIsUUFBdUM7QUFDN0UsTUFBSTtBQUNILFdBQU8sTUFBTSxPQUFPO0FBQUEsTUFBUyxNQUM1QixTQUFTLGlCQUFpQiw0Q0FBNEMsRUFDcEU7QUFBQSxJQUNIO0FBQUEsRUFDRCxRQUFRO0FBQ1AsV0FBTztBQUFBLEVBQ1I7QUFDRDtBQU1BLGVBQXNCLHdCQUNyQixRQUNBLFVBQ29DO0FBQ3BDLE1BQUk7QUFDSCxXQUFPLE1BQU0sT0FBTyxTQUFTLENBQUMsUUFBUTtBQUNyQyxZQUFNLEtBQUssU0FBUyxjQUFjLEdBQUc7QUFDckMsVUFBSSxDQUFDLElBQUk7QUFDUixlQUFPO0FBQUEsVUFDTixRQUFRO0FBQUEsVUFDUixjQUFjO0FBQUEsVUFDZCxhQUFhO0FBQUEsVUFDYixjQUFjO0FBQUEsVUFDZCxNQUFNO0FBQUEsUUFDUDtBQUFBLE1BQ0Q7QUFDQSxhQUFPO0FBQUEsUUFDTixRQUFRO0FBQUEsUUFDUixjQUFjLEdBQUcsYUFBYSxlQUFlO0FBQUEsUUFDN0MsYUFBYSxHQUFHLGFBQWEsY0FBYztBQUFBLFFBQzNDLGNBQWMsR0FBRyxhQUFhLGVBQWU7QUFBQSxRQUM3QyxNQUNDLGNBQWMsb0JBQ1gsR0FBRyxPQUNILEdBQUcsYUFBYSxNQUFNLE1BQU07QUFBQSxNQUNqQztBQUFBLElBQ0QsR0FBRyxRQUFRO0FBQUEsRUFDWixRQUFRO0FBQ1AsV0FBTztBQUFBLE1BQ04sUUFBUTtBQUFBLE1BQ1IsY0FBYztBQUFBLE1BQ2QsYUFBYTtBQUFBLE1BQ2IsY0FBYztBQUFBLE1BQ2QsTUFBTTtBQUFBLElBQ1A7QUFBQSxFQUNEO0FBQ0Q7QUFFQSxlQUFzQixtQkFDckIsUUFDQSxVQUN5QjtBQUN6QixNQUFJO0FBQ0gsV0FBTyxNQUFNLE9BQU8sU0FBUyxDQUFDLFFBQVE7QUFDckMsWUFBTSxnQkFBZ0IsTUFBc0I7QUFDM0MsWUFBSSxJQUFLLFFBQU8sU0FBUyxjQUFjLEdBQUc7QUFDMUMsY0FBTSxTQUFTLFNBQVM7QUFDeEIsWUFDQyxDQUFDLFVBQ0QsV0FBVyxTQUFTLFFBQ3BCLFdBQVcsU0FBUztBQUVwQixpQkFBTztBQUNSLGVBQU87QUFBQSxNQUNSO0FBRUEsWUFBTUEsVUFBUyxjQUFjO0FBQzdCLFVBQUksQ0FBQ0EsUUFBUSxRQUFPO0FBQ3BCLFVBQ0NBLG1CQUFrQixvQkFDbEJBLG1CQUFrQixxQkFDakI7QUFDRCxlQUFPQSxRQUFPO0FBQUEsTUFDZjtBQUNBLFVBQUlBLG1CQUFrQixtQkFBbUI7QUFDeEMsZUFBT0EsUUFBTztBQUFBLE1BQ2Y7QUFDQSxVQUFLQSxRQUF1QixtQkFBbUI7QUFDOUMsZ0JBQVFBLFFBQU8sZUFBZSxJQUFJLEtBQUs7QUFBQSxNQUN4QztBQUNBLGFBQVFBLFFBQXVCLGFBQWEsT0FBTztBQUFBLElBQ3BELEdBQUcsUUFBUTtBQUFBLEVBQ1osUUFBUTtBQUNQLFdBQU87QUFBQSxFQUNSO0FBQ0Q7QUFFTyxTQUFTLGVBQWUsS0FBc0I7QUFDcEQsUUFBTSxVQUNMLE9BQU8sUUFBUSxZQUFZLE9BQU8sYUFBYSxNQUM1QyxPQUFRLElBQThCLFdBQVcsRUFBRSxJQUNuRCxPQUFPLE9BQU8sZUFBZTtBQUNqQyxTQUFPLFFBQVEsTUFBTSxJQUFJLEVBQUUsQ0FBQyxLQUFLO0FBQ2xDO0FBTU8sU0FBUyxtQkFDZixNQUNBLFFBQ0EsV0FDQztBQUNELFNBQU8sWUFBWSxnQkFBZ0I7QUFBQSxJQUNsQztBQUFBLElBQ0EsZUFBZSxzQkFBc0IsTUFBTTtBQUFBLElBQzNDO0FBQUEsRUFDRCxDQUFDO0FBQ0Y7QUFFTyxTQUFTLG9CQUNmLFVBQ0EsU0FXQztBQUNELFNBQU8sYUFBYSxnQkFBZ0IsVUFBVSxPQUFPO0FBQ3REO0FBRU8sU0FBUyxrQkFBa0IsZUFBZ0M7QUFDakUsTUFBSSxDQUFDLGNBQWUsUUFBTztBQUMzQixRQUFNLFNBQVMsV0FBVyxnQkFBZ0IsYUFBYTtBQUN2RCxNQUFJLENBQUMsT0FBUSxRQUFPO0FBQ3BCLFNBQU8sT0FBTyxhQUFhO0FBQzVCO0FBRU8sU0FBUyx1QkFBdUIsZUFBd0M7QUFDOUUsUUFBTSxRQUFRLGtCQUFrQixhQUFhO0FBQzdDLFNBQU8sZUFBZSxFQUFFLE9BQU8sQ0FBQyxVQUFVLE1BQU0sYUFBYSxLQUFLO0FBQ25FO0FBRU8sU0FBUyx1QkFBdUIsZUFBd0M7QUFDOUUsUUFBTSxRQUFRLGtCQUFrQixhQUFhO0FBQzdDLFNBQU8sZUFBZSxFQUFFLE9BQU8sQ0FBQyxVQUFVLE1BQU0sYUFBYSxLQUFLO0FBQ25FO0FBTU8sU0FBUyxnQkFBZ0IsU0FBeUI7QUFDeEQsUUFBTSxRQUFrQixDQUFDO0FBQ3pCLFFBQU0sTUFBTSxLQUFLLElBQUk7QUFDckIsUUFBTSxRQUFRLE1BQU07QUFFcEIsUUFBTSxXQUFXLENBQUMsUUFBK0I7QUFDaEQsUUFBSTtBQUNILGFBQU8sSUFBSSxJQUFJLEdBQUcsRUFBRTtBQUFBLElBQ3JCLFFBQVE7QUFDUCxhQUFPO0FBQUEsSUFDUjtBQUFBLEVBQ0Q7QUFDQSxRQUFNLGFBQWEsU0FBUyxPQUFPO0FBQ25DLFFBQU0sYUFBYSxDQUFDLFFBQ25CLENBQUMsY0FBYyxTQUFTLEdBQUcsTUFBTTtBQUVsQyxRQUFNLFlBQVksQ0FBQyxPQUFpQixRQUEwQjtBQUM3RCxVQUFNLFNBQVMsb0JBQUksSUFBb0I7QUFDdkMsVUFBTSxRQUFrQixDQUFDO0FBQ3pCLGVBQVcsUUFBUSxPQUFPO0FBQ3pCLFVBQUksQ0FBQyxPQUFPLElBQUksSUFBSSxFQUFHLE9BQU0sS0FBSyxJQUFJO0FBQ3RDLGFBQU8sSUFBSSxPQUFPLE9BQU8sSUFBSSxJQUFJLEtBQUssS0FBSyxDQUFDO0FBQUEsSUFDN0M7QUFDQSxXQUFPLE1BQU0sTUFBTSxHQUFHLEdBQUcsRUFBRSxJQUFJLENBQUMsU0FBUztBQUN4QyxZQUFNLFFBQVEsT0FBTyxJQUFJLElBQUksS0FBSztBQUNsQyxhQUFPLFFBQVEsSUFBSSxHQUFHLElBQUksTUFBTSxLQUFLLE1BQU07QUFBQSxJQUM1QyxDQUFDO0FBQUEsRUFDRjtBQUVBLFFBQU0sY0FBYyxlQUFlO0FBQ25DLFFBQU0sYUFBYSxZQUNqQjtBQUFBLElBQ0EsQ0FBQyxPQUNDLEVBQUUsU0FBUyxXQUFXLEVBQUUsU0FBUyxnQkFDbEMsRUFBRSxhQUFhLFNBQ2YsV0FBVyxFQUFFLEdBQUc7QUFBQSxFQUNsQixFQUNDLElBQUksQ0FBQyxNQUFNLEVBQUUsS0FBSyxNQUFNLEdBQUcsR0FBRyxDQUFDO0FBQ2pDLE1BQUksV0FBVyxTQUFTLEdBQUc7QUFDMUIsVUFBTSxLQUFLLFNBQVMsVUFBVSxZQUFZLENBQUMsRUFBRSxLQUFLLEtBQUssQ0FBQztBQUFBLEVBQ3pEO0FBRUEsUUFBTSxtQkFBbUIsb0JBQUksSUFBSSxDQUFDLEtBQUssS0FBSyxLQUFLLEtBQUssS0FBSyxLQUFLLEdBQUcsQ0FBQztBQUNwRSxRQUFNLGtCQUFrQixvQkFBSSxJQUFJLENBQUMsWUFBWSxTQUFTLE9BQU8sUUFBUSxDQUFDO0FBQ3RFLFFBQU0sY0FBYyxlQUFlO0FBQ25DLFFBQU0sY0FBYyxZQUNsQixPQUFPLENBQUMsTUFBTSxFQUFFLGFBQWEsU0FBUyxXQUFXLEVBQUUsR0FBRyxDQUFDLEVBQ3ZELE9BQU8sQ0FBQyxNQUFNO0FBQ2QsUUFBSSxFQUFFLE9BQVEsUUFBTyxnQkFBZ0IsSUFBSSxFQUFFLFlBQVk7QUFDdkQsUUFBSSxFQUFFLFdBQVcsS0FBTSxRQUFPO0FBQzlCLFFBQUksRUFBRSxVQUFVLElBQUssUUFBTztBQUM1QixXQUNDLGlCQUFpQixJQUFJLEVBQUUsTUFBTSxLQUM3QixnQkFBZ0IsSUFBSSxFQUFFLFlBQVk7QUFBQSxFQUVwQyxDQUFDLEVBQ0EsSUFBSSxDQUFDLE1BQU07QUFDWCxRQUFJLEVBQUUsT0FBUSxRQUFPLEdBQUcsRUFBRSxNQUFNLElBQUksRUFBRSxZQUFZO0FBQ2xELFdBQU8sR0FBRyxFQUFFLE1BQU0sSUFBSSxFQUFFLFlBQVksSUFBSSxFQUFFLE1BQU07QUFBQSxFQUNqRCxDQUFDO0FBQ0YsTUFBSSxZQUFZLFNBQVMsR0FBRztBQUMzQixVQUFNLEtBQUssY0FBYyxVQUFVLGFBQWEsQ0FBQyxFQUFFLEtBQUssS0FBSyxDQUFDO0FBQUEsRUFDL0Q7QUFFQSxRQUFNLGFBQWEsY0FBYztBQUNqQyxRQUFNLGlCQUFpQixXQUNyQixPQUFPLENBQUMsTUFBTSxFQUFFLGFBQWEsU0FBUyxXQUFXLEVBQUUsR0FBRyxDQUFDLEVBQ3ZELElBQUksQ0FBQyxNQUFNLEdBQUcsRUFBRSxJQUFJLEtBQUssRUFBRSxRQUFRLE1BQU0sR0FBRyxFQUFFLENBQUMsRUFBRTtBQUNuRCxNQUFJLGVBQWUsU0FBUyxHQUFHO0FBQzlCLFVBQU0sS0FBSyxjQUFjLFVBQVUsZ0JBQWdCLENBQUMsRUFBRSxLQUFLLEtBQUssQ0FBQztBQUFBLEVBQ2xFO0FBRUEsTUFBSSxNQUFNLFdBQVcsRUFBRyxRQUFPO0FBQy9CLFNBQU87QUFBQTtBQUFBLFlBQWlCLE1BQU0sS0FBSyxJQUFJLENBQUM7QUFBQTtBQUN6QztBQU1PLFNBQVMsU0FBUyxPQUE4QjtBQUN0RCxRQUFNLFVBQVUsTUFBTSxLQUFLLEVBQUUsWUFBWTtBQUN6QyxRQUFNLFFBQVEsUUFBUSxXQUFXLEdBQUcsSUFBSSxRQUFRLE1BQU0sQ0FBQyxJQUFJO0FBQzNELFFBQU0sWUFBWSxNQUFNLE1BQU0saUJBQWlCO0FBQy9DLE1BQUksV0FBVztBQUNkLFVBQU0sVUFBVSxTQUFTLFVBQVUsQ0FBQyxHQUFHLEVBQUU7QUFDekMsVUFBTSxNQUFNLFVBQVUsQ0FBQztBQUN2QixXQUFPLEVBQUUsS0FBSyxTQUFTLFNBQVMsS0FBSyxPQUFPLElBQUksR0FBRyxHQUFHO0FBQUEsRUFDdkQ7QUFDQSxTQUFPLEVBQUUsS0FBSyxPQUFPLFNBQVMsTUFBTSxTQUFTLElBQUksS0FBSyxHQUFHO0FBQzFEO0FBRU8sU0FBUyxtQkFBbUIsU0FBaUIsS0FBcUI7QUFDeEUsU0FBTyxLQUFLLE9BQU8sSUFBSSxHQUFHO0FBQzNCO0FBRU8sU0FBUyxpQkFBaUIsWUFBb0IsUUFBd0I7QUFDNUUsU0FBTyxPQUFPLFVBQVUsMkJBQTJCLE1BQU07QUFDMUQ7QUFNTyxTQUFTLDBCQUEwQixPQUFpQztBQUMxRSxRQUFNLFFBQWtCLENBQUM7QUFDekIsUUFBTSxLQUFLLFVBQVUsTUFBTSxLQUFLLEVBQUU7QUFDbEMsUUFBTSxLQUFLLFFBQVEsTUFBTSxHQUFHLEVBQUU7QUFDOUIsUUFBTTtBQUFBLElBQ0wsYUFBYSxNQUFNLE9BQU8sU0FBUyxlQUFlLE1BQU0sT0FBTyxPQUFPLGFBQWEsTUFBTSxPQUFPLEtBQUssV0FBVyxNQUFNLE9BQU8sTUFBTTtBQUFBLEVBQ3BJO0FBQ0EsTUFBSSxNQUFNLFNBQVMsU0FBUyxHQUFHO0FBQzlCLFVBQU07QUFBQSxNQUNMLGVBQ0MsTUFBTSxTQUNKLElBQUksQ0FBQyxNQUFNLFVBQVUsSUFBSSxRQUFRLENBQUMsS0FBTSxJQUFJLEdBQUksRUFDaEQsS0FBSyxJQUFJO0FBQUEsSUFDYjtBQUFBLEVBQ0Q7QUFDQSxNQUFJLE1BQU0sT0FBTztBQUNoQixVQUFNLEtBQUssWUFBWSxNQUFNLEtBQUssRUFBRTtBQUFBLEVBQ3JDO0FBQ0EsTUFBSSxNQUFNLE9BQU8sT0FBTztBQUN2QixVQUFNLEtBQUssbUJBQW1CLE1BQU0sT0FBTyxLQUFLLEdBQUc7QUFBQSxFQUNwRDtBQUNBLFFBQU07QUFBQSxJQUNMO0FBQUEsRUFDRDtBQUNBLFNBQU8sTUFBTSxLQUFLLElBQUk7QUFDdkI7IiwKICAibmFtZXMiOiBbInRhcmdldCJdCn0K
