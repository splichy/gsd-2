function createActionTimeline(limit = 60) {
  return {
    limit,
    nextId: 1,
    entries: []
  };
}
function beginAction(timeline, partial) {
  const entry = {
    id: timeline.nextId++,
    tool: partial.tool,
    paramsSummary: partial.paramsSummary ?? "",
    startedAt: partial.startedAt ?? Date.now(),
    finishedAt: null,
    status: "running",
    beforeUrl: partial.beforeUrl ?? "",
    afterUrl: partial.afterUrl ?? "",
    verificationSummary: partial.verificationSummary,
    warningSummary: partial.warningSummary,
    diffSummary: partial.diffSummary,
    changed: partial.changed,
    error: partial.error
  };
  timeline.entries.push(entry);
  if (timeline.entries.length > timeline.limit) {
    timeline.entries.splice(0, timeline.entries.length - timeline.limit);
  }
  return entry;
}
function finishAction(timeline, actionId, updates = {}) {
  const entry = timeline.entries.find((item) => item.id === actionId);
  if (!entry) return null;
  Object.assign(entry, updates, {
    finishedAt: updates.finishedAt ?? Date.now(),
    status: updates.status ?? entry.status ?? "success",
    afterUrl: updates.afterUrl ?? entry.afterUrl ?? "",
    verificationSummary: updates.verificationSummary ?? entry.verificationSummary,
    warningSummary: updates.warningSummary ?? entry.warningSummary,
    diffSummary: updates.diffSummary ?? entry.diffSummary,
    changed: updates.changed ?? entry.changed,
    error: updates.error ?? entry.error
  });
  return entry;
}
function findAction(timeline, actionId) {
  return timeline.entries.find((item) => item.id === actionId) ?? null;
}
function toActionParamsSummary(params) {
  if (!params || typeof params !== "object") return "";
  const entries = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === void 0 || value === null) continue;
    if (typeof value === "string") {
      entries.push(`${key}=${JSON.stringify(value.length > 60 ? `${value.slice(0, 57)}...` : value)}`);
      continue;
    }
    if (Array.isArray(value)) {
      entries.push(`${key}=[${value.length}]`);
      continue;
    }
    if (typeof value === "object") {
      entries.push(`${key}={...}`);
      continue;
    }
    entries.push(`${key}=${String(value)}`);
  }
  return entries.slice(0, 6).join(", ");
}
function diffCompactStates(before, after) {
  const changes = [];
  if (!before || !after) {
    return {
      changed: false,
      changes: [],
      summary: "Diff unavailable"
    };
  }
  if (before.url !== after.url) {
    changes.push({ type: "url", before: before.url, after: after.url });
  }
  if (before.title !== after.title) {
    changes.push({ type: "title", before: before.title, after: after.title });
  }
  if (before.focus !== after.focus) {
    changes.push({ type: "focus", before: before.focus, after: after.focus });
  }
  if ((before.dialog?.count ?? 0) !== (after.dialog?.count ?? 0)) {
    changes.push({
      type: "dialog_count",
      before: before.dialog?.count ?? 0,
      after: after.dialog?.count ?? 0
    });
  }
  if ((before.dialog?.title ?? "") !== (after.dialog?.title ?? "")) {
    changes.push({
      type: "dialog_title",
      before: before.dialog?.title ?? "",
      after: after.dialog?.title ?? ""
    });
  }
  for (const key of ["landmarks", "buttons", "links", "inputs"]) {
    const beforeValue = before.counts?.[key] ?? 0;
    const afterValue = after.counts?.[key] ?? 0;
    if (beforeValue !== afterValue) {
      changes.push({ type: `count:${key}`, before: beforeValue, after: afterValue });
    }
  }
  const beforeHeadings = JSON.stringify(before.headings ?? []);
  const afterHeadings = JSON.stringify(after.headings ?? []);
  if (beforeHeadings !== afterHeadings) {
    changes.push({
      type: "headings",
      before: before.headings ?? [],
      after: after.headings ?? []
    });
  }
  const beforeBody = before.bodyText ?? "";
  const afterBody = after.bodyText ?? "";
  if (beforeBody !== afterBody) {
    changes.push({
      type: "body_text",
      before: beforeBody.slice(0, 120),
      after: afterBody.slice(0, 120)
    });
  }
  const changed = changes.length > 0;
  const summary = changed ? changes.slice(0, 4).map((change) => {
    if (change.type === "url") return `URL changed to ${change.after}`;
    if (change.type === "title") return `title changed to ${change.after}`;
    if (change.type === "focus") return `focus changed`;
    if (change.type === "dialog_count") return `dialog count ${change.before}\u2192${change.after}`;
    if (change.type.startsWith("count:")) return `${change.type.slice(6)} ${change.before}\u2192${change.after}`;
    if (change.type === "headings") return "headings changed";
    if (change.type === "body_text") return "visible text changed";
    return `${change.type} changed`;
  }).join("; ") : "No meaningful browser-state change detected";
  return { changed, changes, summary };
}
function normalizeString(value) {
  return String(value ?? "").trim();
}
function includesNeedle(haystack, needle) {
  return normalizeString(haystack).toLowerCase().includes(normalizeString(needle).toLowerCase());
}
function parseThreshold(value) {
  if (value == null) return null;
  const str = String(value).trim();
  if (str === "") return null;
  const match = str.match(/^(>=|<=|==|>|<)?\s*(\d+)$/);
  if (!match) return null;
  const op = match[1] || ">=";
  const n = parseInt(match[2], 10);
  return { op, n };
}
function meetsThreshold(count, threshold) {
  switch (threshold.op) {
    case ">=":
      return count >= threshold.n;
    case "<=":
      return count <= threshold.n;
    case "==":
      return count === threshold.n;
    case ">":
      return count > threshold.n;
    case "<":
      return count < threshold.n;
    default:
      return false;
  }
}
function getEntriesSince(entries, sinceActionId, timeline) {
  if (!entries || !Array.isArray(entries)) return [];
  if (sinceActionId == null || !timeline) return entries;
  const action = findAction(timeline, sinceActionId);
  if (!action) return entries;
  const since = action.startedAt;
  return entries.filter((e) => (e.timestamp ?? 0) >= since);
}
function evaluateAssertionChecks({ checks, state }) {
  const results = [];
  const selectorStates = state.selectorStates ?? {};
  const consoleEntries = state.consoleEntries ?? [];
  const networkEntries = state.networkEntries ?? [];
  const allConsoleEntries = state.allConsoleEntries ?? state.consoleEntries ?? [];
  const allNetworkEntries = state.allNetworkEntries ?? state.networkEntries ?? [];
  const actionTimeline = state.actionTimeline ?? null;
  for (const check of checks) {
    const selectorState = check.selector ? selectorStates[check.selector] ?? null : null;
    let passed = false;
    let actual;
    let expected;
    switch (check.kind) {
      case "url_contains":
        actual = state.url ?? "";
        expected = check.value ?? "";
        passed = includesNeedle(actual, expected);
        break;
      case "title_contains":
        actual = state.title ?? "";
        expected = check.value ?? "";
        passed = includesNeedle(actual, expected);
        break;
      case "text_visible":
        actual = state.bodyText ?? "";
        expected = check.text ?? "";
        passed = includesNeedle(actual, expected);
        break;
      case "text_not_visible":
        actual = state.bodyText ?? "";
        expected = check.text ?? "";
        passed = !includesNeedle(actual, expected);
        break;
      case "selector_visible":
        actual = selectorState?.visible ?? false;
        expected = true;
        passed = actual === true;
        break;
      case "selector_hidden":
        actual = selectorState?.visible ?? false;
        expected = false;
        passed = actual === false;
        break;
      case "value_equals":
        actual = selectorState?.value ?? "";
        expected = check.value ?? "";
        passed = actual === expected;
        break;
      case "value_contains":
        actual = selectorState?.value ?? "";
        expected = check.value ?? "";
        passed = includesNeedle(actual, expected);
        break;
      case "focused_matches":
        actual = state.focus ?? "";
        expected = check.value ?? "";
        passed = includesNeedle(actual, expected);
        break;
      case "checked_equals":
        actual = selectorState?.checked ?? null;
        expected = !!check.checked;
        passed = actual === expected;
        break;
      case "no_console_errors":
        actual = consoleEntries.filter((entry) => entry.type === "error" || entry.type === "pageerror").length;
        expected = 0;
        passed = actual === 0;
        break;
      case "no_failed_requests":
        actual = networkEntries.filter((entry) => entry.failed || typeof entry.status === "number" && entry.status >= 400).length;
        expected = 0;
        passed = actual === 0;
        break;
      // --- S02: New structured network/console assertion kinds ---
      case "request_url_seen": {
        const filtered = getEntriesSince(allNetworkEntries, check.sinceActionId, actionTimeline);
        const matches = filtered.filter((e) => includesNeedle(e.url ?? "", check.text ?? ""));
        actual = matches.length > 0;
        expected = true;
        passed = actual === true;
        break;
      }
      case "response_status": {
        const filtered = getEntriesSince(allNetworkEntries, check.sinceActionId, actionTimeline);
        const statusNum = parseInt(check.value, 10);
        const matches = filtered.filter(
          (e) => includesNeedle(e.url ?? "", check.text ?? "") && typeof e.status === "number" && e.status === statusNum
        );
        actual = matches.length > 0 ? `found (status=${matches[0].status})` : `not found`;
        expected = `status=${check.value ?? ""}`;
        passed = matches.length > 0;
        break;
      }
      case "console_message_matches": {
        const filtered = getEntriesSince(allConsoleEntries, check.sinceActionId, actionTimeline);
        const matches = filtered.filter((e) => includesNeedle(e.text ?? "", check.text ?? ""));
        actual = matches.length > 0;
        expected = true;
        passed = actual === true;
        break;
      }
      case "network_count": {
        const filtered = getEntriesSince(allNetworkEntries, check.sinceActionId, actionTimeline);
        const matches = filtered.filter((e) => includesNeedle(e.url ?? "", check.text ?? ""));
        const threshold = parseThreshold(check.value);
        if (!threshold) {
          actual = `invalid threshold: ${check.value}`;
          expected = check.value ?? "";
          passed = false;
        } else {
          actual = `count=${matches.length}`;
          expected = `${threshold.op}${threshold.n}`;
          passed = meetsThreshold(matches.length, threshold);
        }
        break;
      }
      case "console_count": {
        const filtered = getEntriesSince(allConsoleEntries, check.sinceActionId, actionTimeline);
        const matches = filtered.filter((e) => includesNeedle(e.text ?? "", check.text ?? ""));
        const threshold = parseThreshold(check.value);
        if (!threshold) {
          actual = `invalid threshold: ${check.value}`;
          expected = check.value ?? "";
          passed = false;
        } else {
          actual = `count=${matches.length}`;
          expected = `${threshold.op}${threshold.n}`;
          passed = meetsThreshold(matches.length, threshold);
        }
        break;
      }
      case "no_console_errors_since": {
        const filtered = getEntriesSince(allConsoleEntries, check.sinceActionId, actionTimeline);
        const errors = filtered.filter((e) => e.type === "error" || e.type === "pageerror");
        actual = errors.length;
        expected = 0;
        passed = errors.length === 0;
        break;
      }
      case "no_failed_requests_since": {
        const filtered = getEntriesSince(allNetworkEntries, check.sinceActionId, actionTimeline);
        const failures = filtered.filter((e) => e.failed || typeof e.status === "number" && e.status >= 400);
        actual = failures.length;
        expected = 0;
        passed = failures.length === 0;
        break;
      }
      default:
        actual = "unsupported";
        expected = check.kind;
        passed = false;
        break;
    }
    results.push({
      name: check.kind,
      passed,
      actual,
      expected,
      selector: check.selector,
      text: check.text
    });
  }
  const failed = results.filter((result) => !result.passed);
  const verified = failed.length === 0;
  return {
    verified,
    checks: results,
    summary: verified ? `PASS (${results.length}/${results.length} checks)` : `FAIL (${failed.length}/${results.length} checks failed)`,
    agentHint: verified ? "All assertion checks passed" : failed[0] ? `Investigate ${failed[0].name} (expected ${JSON.stringify(failed[0].expected)}, got ${JSON.stringify(failed[0].actual)})` : "Assertion failed"
  };
}
const WAIT_CONDITIONS = {
  // Existing 5 conditions
  selector_visible: { needsValue: true, valueLabel: "CSS selector" },
  selector_hidden: { needsValue: true, valueLabel: "CSS selector" },
  url_contains: { needsValue: true, valueLabel: "URL substring" },
  network_idle: { needsValue: false, valueLabel: "" },
  delay: { needsValue: true, valueLabel: "milliseconds as a string (e.g. '1000')" },
  // New 6 conditions (S03)
  text_visible: { needsValue: true, valueLabel: "text to search for" },
  text_hidden: { needsValue: true, valueLabel: "text to search for" },
  request_completed: { needsValue: true, valueLabel: "URL substring to match" },
  console_message: { needsValue: true, valueLabel: "message substring to match" },
  element_count: { needsValue: true, valueLabel: "CSS selector", needsThreshold: true },
  region_stable: { needsValue: true, valueLabel: "CSS selector" }
};
function validateWaitParams(params) {
  const { condition, value, threshold } = params ?? {};
  if (!condition) {
    return { error: "condition is required" };
  }
  const spec = WAIT_CONDITIONS[condition];
  if (!spec) {
    const known = Object.keys(WAIT_CONDITIONS).join(", ");
    return { error: `unknown condition "${condition}". Known conditions: ${known}` };
  }
  if (spec.needsValue && (!value || String(value).trim() === "")) {
    return { error: `${condition} requires a value (${spec.valueLabel})` };
  }
  if (spec.needsThreshold && threshold != null && String(threshold).trim() !== "") {
    const parsed = parseThreshold(threshold);
    if (!parsed) {
      return { error: `${condition} threshold is malformed: "${threshold}". Expected format: >=N, <=N, ==N, >N, <N, or bare N` };
    }
  }
  return null;
}
function createRegionStableScript(selector) {
  const safeKey = Array.from(selector).reduce((h, c) => (h << 5) - h + c.charCodeAt(0) | 0, 0) >>> 0;
  const windowKey = `__pw_region_stable_${safeKey}`;
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const snapshot = el.innerHTML.length + '|' + el.childElementCount + '|' + el.innerText.length;
  const prev = window[${JSON.stringify(windowKey)}];
  window[${JSON.stringify(windowKey)}] = snapshot;
  if (prev === undefined) return false;
  return snapshot === prev;
})()`;
}
function createPageRegistry() {
  return { pages: [], activePageId: null, nextId: 1 };
}
function registryAddPage(registry, { page, title = "", url = "", opener = null }) {
  const entry = { id: registry.nextId++, page, title, url, opener };
  registry.pages.push(entry);
  return entry;
}
function registryRemovePage(registry, pageId) {
  const idx = registry.pages.findIndex((p) => p.id === pageId);
  if (idx === -1) {
    const available = registry.pages.map((p) => p.id);
    throw new Error(
      `registryRemovePage: page ${pageId} not found. Available page IDs: [${available.join(", ")}]. Registry size: ${registry.pages.length}.`
    );
  }
  const [removed] = registry.pages.splice(idx, 1);
  for (const entry of registry.pages) {
    if (entry.opener === pageId) {
      entry.opener = null;
    }
  }
  let newActiveId = registry.activePageId;
  if (registry.activePageId === pageId) {
    if (registry.pages.length === 0) {
      newActiveId = null;
    } else if (removed.opener !== null && registry.pages.some((p) => p.id === removed.opener)) {
      newActiveId = removed.opener;
    } else {
      newActiveId = registry.pages[registry.pages.length - 1].id;
    }
    registry.activePageId = newActiveId;
  }
  return { removed, newActiveId };
}
function registrySetActive(registry, pageId) {
  const entry = registry.pages.find((p) => p.id === pageId);
  if (!entry) {
    const available = registry.pages.map((p) => p.id);
    throw new Error(
      `registrySetActive: page ${pageId} not found. Available page IDs: [${available.join(", ")}]. Registry size: ${registry.pages.length}.`
    );
  }
  registry.activePageId = pageId;
}
function registryGetActive(registry) {
  if (registry.activePageId === null) {
    throw new Error(
      `registryGetActive: no active page. Registry contains ${registry.pages.length} page(s). Page IDs: [${registry.pages.map((p) => p.id).join(", ")}].`
    );
  }
  const entry = registry.pages.find((p) => p.id === registry.activePageId);
  if (!entry) {
    throw new Error(
      `registryGetActive: activePageId ${registry.activePageId} not found in registry. Available page IDs: [${registry.pages.map((p) => p.id).join(", ")}]. Registry size: ${registry.pages.length}. This indicates stale state.`
    );
  }
  return entry;
}
function registryGetPage(registry, pageId) {
  return registry.pages.find((p) => p.id === pageId) ?? null;
}
function registryListPages(registry) {
  return registry.pages.map((entry) => ({
    id: entry.id,
    title: entry.title,
    url: entry.url,
    opener: entry.opener,
    isActive: entry.id === registry.activePageId
  }));
}
function createBoundedLogPusher(maxSize) {
  return function push(array, entry) {
    array.push(entry);
    if (array.length > maxSize) {
      array.splice(0, array.length - maxSize);
    }
  };
}
async function runBatchSteps({ steps, executeStep, stopOnFailure = true }) {
  const results = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const result = await executeStep(step, i);
    results.push(result);
    if (result.ok === false && stopOnFailure) {
      return {
        ok: false,
        stopReason: "step_failed",
        failedStepIndex: i,
        stepResults: results,
        summary: `Stopped at step ${i + 1} (${step.action})`
      };
    }
  }
  return {
    ok: true,
    stopReason: null,
    failedStepIndex: null,
    stepResults: results,
    summary: `Completed ${results.length} step(s)`
  };
}
const SNAPSHOT_MODES = {
  interactive: {
    tags: [],
    roles: [],
    selectors: [],
    ariaAttributes: [],
    useInteractiveFilter: true
  },
  form: {
    tags: ["input", "select", "textarea", "button", "fieldset", "label", "output", "datalist"],
    roles: ["textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "listbox", "option"],
    selectors: ["[contenteditable]"],
    ariaAttributes: [],
    useInteractiveFilter: false
  },
  dialog: {
    tags: ["dialog"],
    roles: ["dialog", "alertdialog"],
    selectors: ['[role="dialog"]', '[role="alertdialog"]'],
    ariaAttributes: [],
    useInteractiveFilter: false,
    containerExpand: true
  },
  navigation: {
    tags: ["a", "nav"],
    roles: ["link", "navigation", "menubar", "menu", "menuitem"],
    selectors: [],
    ariaAttributes: [],
    useInteractiveFilter: false
  },
  errors: {
    tags: [],
    roles: ["alert", "status"],
    selectors: ['[aria-invalid="true"]', '[role="alert"]', '[role="status"]'],
    ariaAttributes: ["aria-invalid", "aria-errormessage"],
    useInteractiveFilter: false,
    containerExpand: true
  },
  headings: {
    tags: ["h1", "h2", "h3", "h4", "h5", "h6"],
    roles: ["heading"],
    selectors: [],
    ariaAttributes: [],
    useInteractiveFilter: false
  },
  visible_only: {
    tags: [],
    roles: [],
    selectors: [],
    ariaAttributes: [],
    useInteractiveFilter: false,
    visibleOnly: true
  }
};
function getSnapshotModeConfig(mode) {
  return SNAPSHOT_MODES[mode] ?? null;
}
function computeContentHash(text) {
  if (!text) return "0";
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = (h << 5) - h + text.charCodeAt(i) | 0;
  }
  return (h >>> 0).toString(16);
}
function computeStructuralSignature(tag, role, childTags) {
  const input = `${tag}|${role}|${childTags.join(",")}`;
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i) | 0;
  }
  return (h >>> 0).toString(16);
}
function matchFingerprint(stored, candidate) {
  if (!stored || !candidate) return false;
  if (!stored.contentHash || !stored.structuralSignature) return false;
  if (!candidate.contentHash || !candidate.structuralSignature) return false;
  return stored.contentHash === candidate.contentHash && stored.structuralSignature === candidate.structuralSignature;
}
function formatDurationMs(entry) {
  const startedAt = typeof entry?.startedAt === "number" ? entry.startedAt : null;
  const finishedAt = typeof entry?.finishedAt === "number" ? entry.finishedAt : null;
  if (startedAt == null || finishedAt == null || finishedAt < startedAt) return null;
  return finishedAt - startedAt;
}
function summarizeActionStatus(status) {
  if (status === "error") return "error";
  if (status === "running") return "running";
  return "success";
}
function looksBoundedWarning(value) {
  return /bounded .*history/i.test(String(value ?? ""));
}
function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}
function formatTimelineEntries(entries = [], options = {}) {
  const retained = options.retained ?? entries.length;
  const totalRecorded = options.totalRecorded ?? retained;
  const bounded = totalRecorded > retained;
  if (!entries.length) {
    return {
      entries: [],
      retained,
      totalRecorded,
      bounded,
      summary: "No browser actions recorded."
    };
  }
  const formattedEntries = entries.map((entry) => {
    const status = summarizeActionStatus(entry.status);
    const durationMs = formatDurationMs(entry);
    const parts = [
      `#${entry.id ?? "?"}`,
      entry.tool ?? "unknown_tool",
      status
    ];
    if (durationMs != null) parts.push(`${durationMs}ms`);
    if (entry.paramsSummary) parts.push(entry.paramsSummary);
    if (entry.error) parts.push(entry.error);
    if (entry.verificationSummary) parts.push(entry.verificationSummary);
    if (entry.diffSummary) parts.push(entry.diffSummary);
    if (entry.warningSummary) parts.push(entry.warningSummary);
    return {
      id: entry.id ?? null,
      tool: entry.tool ?? "",
      status,
      durationMs,
      beforeUrl: entry.beforeUrl ?? "",
      afterUrl: entry.afterUrl ?? "",
      line: parts.join(" | ")
    };
  });
  const summary = bounded ? `Timeline: showing ${retained} of ${totalRecorded} recorded browser actions; older actions were discarded due to bounded history.` : `Timeline: ${retained} browser action${retained === 1 ? "" : "s"} recorded.`;
  return {
    entries: formattedEntries,
    retained,
    totalRecorded,
    bounded,
    summary
  };
}
function buildFailureHypothesis(session = {}) {
  const timelineEntries = session.actionTimeline?.entries ?? [];
  const consoleEntries = session.consoleEntries ?? [];
  const networkEntries = session.networkEntries ?? [];
  const dialogEntries = session.dialogEntries ?? [];
  const signals = [];
  for (const entry of timelineEntries) {
    if (entry?.status !== "error") continue;
    if (entry.tool === "browser_wait_for") {
      signals.push({
        category: "wait",
        source: `action#${entry.id ?? "?"}`,
        detail: entry.error || entry.warningSummary || "Wait condition failed"
      });
      continue;
    }
    if (entry.tool === "browser_assert") {
      signals.push({
        category: "assert",
        source: `action#${entry.id ?? "?"}`,
        detail: entry.error || entry.verificationSummary || "Assertion failed"
      });
      continue;
    }
    signals.push({
      category: "action",
      source: `action#${entry.id ?? "?"}`,
      detail: entry.error || `${entry.tool ?? "browser action"} failed`
    });
  }
  for (const entry of consoleEntries) {
    if (entry?.type !== "error" && entry?.type !== "pageerror") continue;
    signals.push({
      category: "console",
      source: entry.type,
      detail: entry.text || "Console error recorded"
    });
  }
  for (const entry of networkEntries) {
    const failed = entry?.failed || typeof entry?.status === "number" && entry.status >= 400;
    if (!failed) continue;
    signals.push({
      category: "network",
      source: entry.url || "network request",
      detail: `${entry.url || "request"} failed${typeof entry?.status === "number" ? ` with ${entry.status}` : ""}`
    });
  }
  for (const entry of dialogEntries) {
    signals.push({
      category: "dialog",
      source: entry?.type || "dialog",
      detail: entry?.message || "Dialog appeared during failure investigation"
    });
  }
  const categories = uniqueStrings(signals.map((signal) => signal.category));
  const hasFailures = categories.length > 0;
  const summary = hasFailures ? `Recent failure signals detected across ${categories.join(", ")}.` : "No recent failure signals detected.";
  return {
    hasFailures,
    categories,
    summary,
    signals
  };
}
function summarizeBrowserSession(session = {}) {
  const actionTimeline = session.actionTimeline ?? { limit: 0, entries: [] };
  const actionEntries = actionTimeline.entries ?? [];
  const retainedActionCount = session.retainedActionCount ?? actionEntries.length;
  const totalActionCount = session.totalActionCount ?? retainedActionCount;
  const pages = session.pages ?? [];
  const consoleEntries = session.consoleEntries ?? [];
  const networkEntries = session.networkEntries ?? [];
  const dialogEntries = session.dialogEntries ?? [];
  const actionStatusCounts = actionEntries.reduce(
    (acc, entry) => {
      const status = summarizeActionStatus(entry.status);
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    },
    { success: 0, error: 0, running: 0 }
  );
  const waitEntries = actionEntries.filter((entry) => entry.tool === "browser_wait_for");
  const assertEntries = actionEntries.filter((entry) => entry.tool === "browser_assert");
  const consoleErrors = consoleEntries.filter((entry) => entry.type === "error" || entry.type === "pageerror");
  const failedRequests = networkEntries.filter((entry) => entry.failed || typeof entry.status === "number" && entry.status >= 400);
  const activePage = pages.find((page) => page.isActive) ?? pages[0] ?? null;
  const caveats = [];
  if (totalActionCount > retainedActionCount) {
    caveats.push(`Showing ${retainedActionCount} of ${totalActionCount} recorded actions; older actions were discarded due to bounded history.`);
  }
  if (actionEntries.some((entry) => looksBoundedWarning(entry.warningSummary) || looksBoundedWarning(entry.error)) || consoleEntries.some((entry) => looksBoundedWarning(entry.text) || looksBoundedWarning(entry.message)) || consoleEntries.length > 0) {
    caveats.push("bounded console history may hide older console events.");
  }
  if (failedRequests.length > 0 || networkEntries.length > 0) {
    caveats.push("bounded network history may hide older requests.");
  }
  const failureHypothesis = buildFailureHypothesis(session);
  if (!actionEntries.length && pages.length === 0 && consoleEntries.length === 0 && networkEntries.length === 0 && dialogEntries.length === 0) {
    return {
      counts: {
        pages: 0,
        actions: { total: 0, retained: 0, success: 0, error: 0, running: 0 },
        waits: { total: 0, success: 0, error: 0, running: 0 },
        assertions: { total: 0, passed: 0, failed: 0, running: 0 },
        consoleErrors: 0,
        failedRequests: 0,
        dialogs: 0
      },
      activePage: null,
      caveats: [],
      failureHypothesis,
      summary: "No browser session activity recorded."
    };
  }
  return {
    counts: {
      pages: pages.length,
      actions: {
        total: totalActionCount,
        retained: retainedActionCount,
        success: actionStatusCounts.success,
        error: actionStatusCounts.error,
        running: actionStatusCounts.running
      },
      waits: {
        total: waitEntries.length,
        success: waitEntries.filter((entry) => summarizeActionStatus(entry.status) === "success").length,
        error: waitEntries.filter((entry) => summarizeActionStatus(entry.status) === "error").length,
        running: waitEntries.filter((entry) => summarizeActionStatus(entry.status) === "running").length
      },
      assertions: {
        total: assertEntries.length,
        passed: assertEntries.filter((entry) => summarizeActionStatus(entry.status) === "success").length,
        failed: assertEntries.filter((entry) => summarizeActionStatus(entry.status) === "error").length,
        running: assertEntries.filter((entry) => summarizeActionStatus(entry.status) === "running").length
      },
      consoleErrors: consoleErrors.length,
      failedRequests: failedRequests.length,
      dialogs: dialogEntries.length
    },
    activePage: activePage ? {
      id: activePage.id ?? null,
      title: activePage.title ?? "",
      url: activePage.url ?? ""
    } : null,
    caveats,
    failureHypothesis,
    summary: `Session: ${pages.length} page${pages.length === 1 ? "" : "s"}, ${totalActionCount} actions, ${waitEntries.length} wait${waitEntries.length === 1 ? "" : "s"}, ${assertEntries.length} assert${assertEntries.length === 1 ? "" : "s"}.${caveats.length ? ` ${caveats.join(" ")}` : ""}`
  };
}
export {
  SNAPSHOT_MODES,
  beginAction,
  buildFailureHypothesis,
  computeContentHash,
  computeStructuralSignature,
  createActionTimeline,
  createBoundedLogPusher,
  createPageRegistry,
  createRegionStableScript,
  diffCompactStates,
  evaluateAssertionChecks,
  findAction,
  finishAction,
  formatTimelineEntries,
  getEntriesSince,
  getSnapshotModeConfig,
  includesNeedle,
  matchFingerprint,
  meetsThreshold,
  parseThreshold,
  registryAddPage,
  registryGetActive,
  registryGetPage,
  registryListPages,
  registryRemovePage,
  registrySetActive,
  runBatchSteps,
  summarizeBrowserSession,
  toActionParamsSummary,
  validateWaitParams
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvY29yZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSdW50aW1lLW5ldXRyYWwgaGVscGVyIGxvZ2ljIGZvciBicm93c2VyLXRvb2xzLlxuICpcbiAqIEtlcHQgZnJlZSBvZiBwaS1zcGVjaWZpYyBpbXBvcnRzIHNvIGl0IGNhbiBiZSBleGVyY2lzZWQgd2l0aCBub2RlOnRlc3QuXG4gKi9cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBJbnRlcmZhY2VzICYgVHlwZXNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgaW50ZXJmYWNlIEFjdGlvblRpbWVsaW5lIHtcblx0bGltaXQ6IG51bWJlcjtcblx0bmV4dElkOiBudW1iZXI7XG5cdGVudHJpZXM6IEFjdGlvbkVudHJ5W107XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQWN0aW9uRW50cnkge1xuXHRpZDogbnVtYmVyO1xuXHR0b29sOiBzdHJpbmc7XG5cdHBhcmFtc1N1bW1hcnk6IHN0cmluZztcblx0c3RhcnRlZEF0OiBudW1iZXI7XG5cdGZpbmlzaGVkQXQ6IG51bWJlciB8IG51bGw7XG5cdHN0YXR1czogc3RyaW5nO1xuXHRiZWZvcmVVcmw6IHN0cmluZztcblx0YWZ0ZXJVcmw6IHN0cmluZztcblx0dmVyaWZpY2F0aW9uU3VtbWFyeT86IHN0cmluZztcblx0d2FybmluZ1N1bW1hcnk/OiBzdHJpbmc7XG5cdGRpZmZTdW1tYXJ5Pzogc3RyaW5nO1xuXHRjaGFuZ2VkPzogYm9vbGVhbjtcblx0ZXJyb3I/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQWN0aW9uUGFydGlhbCB7XG5cdHRvb2w6IHN0cmluZztcblx0cGFyYW1zU3VtbWFyeT86IHN0cmluZztcblx0c3RhcnRlZEF0PzogbnVtYmVyO1xuXHRiZWZvcmVVcmw/OiBzdHJpbmc7XG5cdGFmdGVyVXJsPzogc3RyaW5nO1xuXHR2ZXJpZmljYXRpb25TdW1tYXJ5Pzogc3RyaW5nO1xuXHR3YXJuaW5nU3VtbWFyeT86IHN0cmluZztcblx0ZGlmZlN1bW1hcnk/OiBzdHJpbmc7XG5cdGNoYW5nZWQ/OiBib29sZWFuO1xuXHRlcnJvcj86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBY3Rpb25VcGRhdGVzIHtcblx0ZmluaXNoZWRBdD86IG51bWJlcjtcblx0c3RhdHVzPzogc3RyaW5nO1xuXHRhZnRlclVybD86IHN0cmluZztcblx0dmVyaWZpY2F0aW9uU3VtbWFyeT86IHN0cmluZztcblx0d2FybmluZ1N1bW1hcnk/OiBzdHJpbmc7XG5cdGRpZmZTdW1tYXJ5Pzogc3RyaW5nO1xuXHRjaGFuZ2VkPzogYm9vbGVhbjtcblx0ZXJyb3I/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGlmZlJlc3VsdCB7XG5cdGNoYW5nZWQ6IGJvb2xlYW47XG5cdGNoYW5nZXM6IEFycmF5PHsgdHlwZTogc3RyaW5nOyBiZWZvcmU6IHVua25vd247IGFmdGVyOiB1bmtub3duIH0+O1xuXHRzdW1tYXJ5OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVGhyZXNob2xkIHtcblx0b3A6IHN0cmluZztcblx0bjogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFBhZ2VSZWdpc3RyeSB7XG5cdHBhZ2VzOiBQYWdlRW50cnlbXTtcblx0YWN0aXZlUGFnZUlkOiBudW1iZXIgfCBudWxsO1xuXHRuZXh0SWQ6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQYWdlRW50cnkge1xuXHRpZDogbnVtYmVyO1xuXHRwYWdlOiBhbnk7XG5cdHRpdGxlOiBzdHJpbmc7XG5cdHVybDogc3RyaW5nO1xuXHRvcGVuZXI6IG51bWJlciB8IG51bGw7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUGFnZUxpc3RFbnRyeSB7XG5cdGlkOiBudW1iZXI7XG5cdHRpdGxlOiBzdHJpbmc7XG5cdHVybDogc3RyaW5nO1xuXHRvcGVuZXI6IG51bWJlciB8IG51bGw7XG5cdGlzQWN0aXZlOiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNuYXBzaG90TW9kZUNvbmZpZyB7XG5cdHRhZ3M6IHN0cmluZ1tdO1xuXHRyb2xlczogc3RyaW5nW107XG5cdHNlbGVjdG9yczogc3RyaW5nW107XG5cdGFyaWFBdHRyaWJ1dGVzOiBzdHJpbmdbXTtcblx0dXNlSW50ZXJhY3RpdmVGaWx0ZXI6IGJvb2xlYW47XG5cdHZpc2libGVPbmx5PzogYm9vbGVhbjtcblx0Y29udGFpbmVyRXhwYW5kPzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBc3NlcnRpb25DaGVja1Jlc3VsdCB7XG5cdG5hbWU6IHN0cmluZztcblx0cGFzc2VkOiBib29sZWFuO1xuXHRhY3R1YWw6IHVua25vd247XG5cdGV4cGVjdGVkOiB1bmtub3duO1xuXHRzZWxlY3Rvcj86IHN0cmluZztcblx0dGV4dD86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBc3NlcnRpb25FdmFsdWF0aW9uIHtcblx0dmVyaWZpZWQ6IGJvb2xlYW47XG5cdGNoZWNrczogQXNzZXJ0aW9uQ2hlY2tSZXN1bHRbXTtcblx0c3VtbWFyeTogc3RyaW5nO1xuXHRhZ2VudEhpbnQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXYWl0VmFsaWRhdGlvbkVycm9yIHtcblx0ZXJyb3I6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBCYXRjaFN0ZXBSZXN1bHQge1xuXHRvazogYm9vbGVhbjtcblx0c3RvcFJlYXNvbjogc3RyaW5nIHwgbnVsbDtcblx0ZmFpbGVkU3RlcEluZGV4OiBudW1iZXIgfCBudWxsO1xuXHRzdGVwUmVzdWx0czogdW5rbm93bltdO1xuXHRzdW1tYXJ5OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRm9ybWF0dGVkVGltZWxpbmUge1xuXHRlbnRyaWVzOiBBcnJheTx7XG5cdFx0aWQ6IG51bWJlciB8IG51bGw7XG5cdFx0dG9vbDogc3RyaW5nO1xuXHRcdHN0YXR1czogc3RyaW5nO1xuXHRcdGR1cmF0aW9uTXM6IG51bWJlciB8IG51bGw7XG5cdFx0YmVmb3JlVXJsOiBzdHJpbmc7XG5cdFx0YWZ0ZXJVcmw6IHN0cmluZztcblx0XHRsaW5lOiBzdHJpbmc7XG5cdH0+O1xuXHRyZXRhaW5lZDogbnVtYmVyO1xuXHR0b3RhbFJlY29yZGVkOiBudW1iZXI7XG5cdGJvdW5kZWQ6IGJvb2xlYW47XG5cdHN1bW1hcnk6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBGYWlsdXJlSHlwb3RoZXNpcyB7XG5cdGhhc0ZhaWx1cmVzOiBib29sZWFuO1xuXHRjYXRlZ29yaWVzOiBzdHJpbmdbXTtcblx0c3VtbWFyeTogc3RyaW5nO1xuXHRzaWduYWxzOiBBcnJheTx7IGNhdGVnb3J5OiBzdHJpbmc7IHNvdXJjZTogc3RyaW5nOyBkZXRhaWw6IHN0cmluZyB9Pjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZXNzaW9uU3VtbWFyeSB7XG5cdGNvdW50czoge1xuXHRcdHBhZ2VzOiBudW1iZXI7XG5cdFx0YWN0aW9uczogeyB0b3RhbDogbnVtYmVyOyByZXRhaW5lZDogbnVtYmVyOyBzdWNjZXNzOiBudW1iZXI7IGVycm9yOiBudW1iZXI7IHJ1bm5pbmc6IG51bWJlciB9O1xuXHRcdHdhaXRzOiB7IHRvdGFsOiBudW1iZXI7IHN1Y2Nlc3M6IG51bWJlcjsgZXJyb3I6IG51bWJlcjsgcnVubmluZzogbnVtYmVyIH07XG5cdFx0YXNzZXJ0aW9uczogeyB0b3RhbDogbnVtYmVyOyBwYXNzZWQ6IG51bWJlcjsgZmFpbGVkOiBudW1iZXI7IHJ1bm5pbmc6IG51bWJlciB9O1xuXHRcdGNvbnNvbGVFcnJvcnM6IG51bWJlcjtcblx0XHRmYWlsZWRSZXF1ZXN0czogbnVtYmVyO1xuXHRcdGRpYWxvZ3M6IG51bWJlcjtcblx0fTtcblx0YWN0aXZlUGFnZTogeyBpZDogbnVtYmVyIHwgbnVsbDsgdGl0bGU6IHN0cmluZzsgdXJsOiBzdHJpbmcgfSB8IG51bGw7XG5cdGNhdmVhdHM6IHN0cmluZ1tdO1xuXHRmYWlsdXJlSHlwb3RoZXNpczogRmFpbHVyZUh5cG90aGVzaXM7XG5cdHN1bW1hcnk6IHN0cmluZztcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBBY3Rpb24gVGltZWxpbmVcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlQWN0aW9uVGltZWxpbmUobGltaXQgPSA2MCk6IEFjdGlvblRpbWVsaW5lIHtcbiAgcmV0dXJuIHtcbiAgICBsaW1pdCxcbiAgICBuZXh0SWQ6IDEsXG4gICAgZW50cmllczogW10sXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBiZWdpbkFjdGlvbih0aW1lbGluZTogQWN0aW9uVGltZWxpbmUsIHBhcnRpYWw6IEFjdGlvblBhcnRpYWwpOiBBY3Rpb25FbnRyeSB7XG4gIGNvbnN0IGVudHJ5OiBBY3Rpb25FbnRyeSA9IHtcbiAgICBpZDogdGltZWxpbmUubmV4dElkKyssXG4gICAgdG9vbDogcGFydGlhbC50b29sLFxuICAgIHBhcmFtc1N1bW1hcnk6IHBhcnRpYWwucGFyYW1zU3VtbWFyeSA/PyBcIlwiLFxuICAgIHN0YXJ0ZWRBdDogcGFydGlhbC5zdGFydGVkQXQgPz8gRGF0ZS5ub3coKSxcbiAgICBmaW5pc2hlZEF0OiBudWxsLFxuICAgIHN0YXR1czogXCJydW5uaW5nXCIsXG4gICAgYmVmb3JlVXJsOiBwYXJ0aWFsLmJlZm9yZVVybCA/PyBcIlwiLFxuICAgIGFmdGVyVXJsOiBwYXJ0aWFsLmFmdGVyVXJsID8/IFwiXCIsXG4gICAgdmVyaWZpY2F0aW9uU3VtbWFyeTogcGFydGlhbC52ZXJpZmljYXRpb25TdW1tYXJ5LFxuICAgIHdhcm5pbmdTdW1tYXJ5OiBwYXJ0aWFsLndhcm5pbmdTdW1tYXJ5LFxuICAgIGRpZmZTdW1tYXJ5OiBwYXJ0aWFsLmRpZmZTdW1tYXJ5LFxuICAgIGNoYW5nZWQ6IHBhcnRpYWwuY2hhbmdlZCxcbiAgICBlcnJvcjogcGFydGlhbC5lcnJvcixcbiAgfTtcbiAgdGltZWxpbmUuZW50cmllcy5wdXNoKGVudHJ5KTtcbiAgaWYgKHRpbWVsaW5lLmVudHJpZXMubGVuZ3RoID4gdGltZWxpbmUubGltaXQpIHtcbiAgICB0aW1lbGluZS5lbnRyaWVzLnNwbGljZSgwLCB0aW1lbGluZS5lbnRyaWVzLmxlbmd0aCAtIHRpbWVsaW5lLmxpbWl0KTtcbiAgfVxuICByZXR1cm4gZW50cnk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmaW5pc2hBY3Rpb24odGltZWxpbmU6IEFjdGlvblRpbWVsaW5lLCBhY3Rpb25JZDogbnVtYmVyLCB1cGRhdGVzOiBBY3Rpb25VcGRhdGVzID0ge30pOiBBY3Rpb25FbnRyeSB8IG51bGwge1xuICBjb25zdCBlbnRyeSA9IHRpbWVsaW5lLmVudHJpZXMuZmluZCgoaXRlbSkgPT4gaXRlbS5pZCA9PT0gYWN0aW9uSWQpO1xuICBpZiAoIWVudHJ5KSByZXR1cm4gbnVsbDtcbiAgT2JqZWN0LmFzc2lnbihlbnRyeSwgdXBkYXRlcywge1xuICAgIGZpbmlzaGVkQXQ6IHVwZGF0ZXMuZmluaXNoZWRBdCA/PyBEYXRlLm5vdygpLFxuICAgIHN0YXR1czogdXBkYXRlcy5zdGF0dXMgPz8gZW50cnkuc3RhdHVzID8/IFwic3VjY2Vzc1wiLFxuICAgIGFmdGVyVXJsOiB1cGRhdGVzLmFmdGVyVXJsID8/IGVudHJ5LmFmdGVyVXJsID8/IFwiXCIsXG4gICAgdmVyaWZpY2F0aW9uU3VtbWFyeTogdXBkYXRlcy52ZXJpZmljYXRpb25TdW1tYXJ5ID8/IGVudHJ5LnZlcmlmaWNhdGlvblN1bW1hcnksXG4gICAgd2FybmluZ1N1bW1hcnk6IHVwZGF0ZXMud2FybmluZ1N1bW1hcnkgPz8gZW50cnkud2FybmluZ1N1bW1hcnksXG4gICAgZGlmZlN1bW1hcnk6IHVwZGF0ZXMuZGlmZlN1bW1hcnkgPz8gZW50cnkuZGlmZlN1bW1hcnksXG4gICAgY2hhbmdlZDogdXBkYXRlcy5jaGFuZ2VkID8/IGVudHJ5LmNoYW5nZWQsXG4gICAgZXJyb3I6IHVwZGF0ZXMuZXJyb3IgPz8gZW50cnkuZXJyb3IsXG4gIH0pO1xuICByZXR1cm4gZW50cnk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmaW5kQWN0aW9uKHRpbWVsaW5lOiBBY3Rpb25UaW1lbGluZSwgYWN0aW9uSWQ6IG51bWJlcik6IEFjdGlvbkVudHJ5IHwgbnVsbCB7XG4gIHJldHVybiB0aW1lbGluZS5lbnRyaWVzLmZpbmQoKGl0ZW0pID0+IGl0ZW0uaWQgPT09IGFjdGlvbklkKSA/PyBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdG9BY3Rpb25QYXJhbXNTdW1tYXJ5KHBhcmFtczogdW5rbm93bik6IHN0cmluZyB7XG4gIGlmICghcGFyYW1zIHx8IHR5cGVvZiBwYXJhbXMgIT09IFwib2JqZWN0XCIpIHJldHVybiBcIlwiO1xuICBjb25zdCBlbnRyaWVzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhwYXJhbXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XG4gICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIGNvbnRpbnVlO1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIGVudHJpZXMucHVzaChgJHtrZXl9PSR7SlNPTi5zdHJpbmdpZnkodmFsdWUubGVuZ3RoID4gNjAgPyBgJHt2YWx1ZS5zbGljZSgwLCA1Nyl9Li4uYCA6IHZhbHVlKX1gKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgIGVudHJpZXMucHVzaChgJHtrZXl9PVske3ZhbHVlLmxlbmd0aH1dYCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIikge1xuICAgICAgZW50cmllcy5wdXNoKGAke2tleX09ey4uLn1gKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBlbnRyaWVzLnB1c2goYCR7a2V5fT0ke1N0cmluZyh2YWx1ZSl9YCk7XG4gIH1cbiAgcmV0dXJuIGVudHJpZXMuc2xpY2UoMCwgNikuam9pbihcIiwgXCIpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIENvbXBhY3QgU3RhdGUgRGlmZmluZ1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmludGVyZmFjZSBDb21wYWN0U3RhdGVGb3JEaWZmIHtcbiAgdXJsPzogc3RyaW5nO1xuICB0aXRsZT86IHN0cmluZztcbiAgZm9jdXM/OiBzdHJpbmc7XG4gIGRpYWxvZz86IHsgY291bnQ/OiBudW1iZXI7IHRpdGxlPzogc3RyaW5nIH07XG4gIGNvdW50cz86IFJlY29yZDxzdHJpbmcsIG51bWJlcj47XG4gIGhlYWRpbmdzPzogc3RyaW5nW107XG4gIGJvZHlUZXh0Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGlmZkNvbXBhY3RTdGF0ZXMoYmVmb3JlOiBDb21wYWN0U3RhdGVGb3JEaWZmIHwgbnVsbCB8IHVuZGVmaW5lZCwgYWZ0ZXI6IENvbXBhY3RTdGF0ZUZvckRpZmYgfCBudWxsIHwgdW5kZWZpbmVkKTogRGlmZlJlc3VsdCB7XG4gIGNvbnN0IGNoYW5nZXM6IEFycmF5PHsgdHlwZTogc3RyaW5nOyBiZWZvcmU6IHVua25vd247IGFmdGVyOiB1bmtub3duIH0+ID0gW107XG4gIGlmICghYmVmb3JlIHx8ICFhZnRlcikge1xuICAgIHJldHVybiB7XG4gICAgICBjaGFuZ2VkOiBmYWxzZSxcbiAgICAgIGNoYW5nZXM6IFtdLFxuICAgICAgc3VtbWFyeTogXCJEaWZmIHVuYXZhaWxhYmxlXCIsXG4gICAgfTtcbiAgfVxuXG4gIGlmIChiZWZvcmUudXJsICE9PSBhZnRlci51cmwpIHtcbiAgICBjaGFuZ2VzLnB1c2goeyB0eXBlOiBcInVybFwiLCBiZWZvcmU6IGJlZm9yZS51cmwsIGFmdGVyOiBhZnRlci51cmwgfSk7XG4gIH1cbiAgaWYgKGJlZm9yZS50aXRsZSAhPT0gYWZ0ZXIudGl0bGUpIHtcbiAgICBjaGFuZ2VzLnB1c2goeyB0eXBlOiBcInRpdGxlXCIsIGJlZm9yZTogYmVmb3JlLnRpdGxlLCBhZnRlcjogYWZ0ZXIudGl0bGUgfSk7XG4gIH1cbiAgaWYgKGJlZm9yZS5mb2N1cyAhPT0gYWZ0ZXIuZm9jdXMpIHtcbiAgICBjaGFuZ2VzLnB1c2goeyB0eXBlOiBcImZvY3VzXCIsIGJlZm9yZTogYmVmb3JlLmZvY3VzLCBhZnRlcjogYWZ0ZXIuZm9jdXMgfSk7XG4gIH1cbiAgaWYgKChiZWZvcmUuZGlhbG9nPy5jb3VudCA/PyAwKSAhPT0gKGFmdGVyLmRpYWxvZz8uY291bnQgPz8gMCkpIHtcbiAgICBjaGFuZ2VzLnB1c2goe1xuICAgICAgdHlwZTogXCJkaWFsb2dfY291bnRcIixcbiAgICAgIGJlZm9yZTogYmVmb3JlLmRpYWxvZz8uY291bnQgPz8gMCxcbiAgICAgIGFmdGVyOiBhZnRlci5kaWFsb2c/LmNvdW50ID8/IDAsXG4gICAgfSk7XG4gIH1cbiAgaWYgKChiZWZvcmUuZGlhbG9nPy50aXRsZSA/PyBcIlwiKSAhPT0gKGFmdGVyLmRpYWxvZz8udGl0bGUgPz8gXCJcIikpIHtcbiAgICBjaGFuZ2VzLnB1c2goe1xuICAgICAgdHlwZTogXCJkaWFsb2dfdGl0bGVcIixcbiAgICAgIGJlZm9yZTogYmVmb3JlLmRpYWxvZz8udGl0bGUgPz8gXCJcIixcbiAgICAgIGFmdGVyOiBhZnRlci5kaWFsb2c/LnRpdGxlID8/IFwiXCIsXG4gICAgfSk7XG4gIH1cblxuICBmb3IgKGNvbnN0IGtleSBvZiBbXCJsYW5kbWFya3NcIiwgXCJidXR0b25zXCIsIFwibGlua3NcIiwgXCJpbnB1dHNcIl0pIHtcbiAgICBjb25zdCBiZWZvcmVWYWx1ZSA9IGJlZm9yZS5jb3VudHM/LltrZXldID8/IDA7XG4gICAgY29uc3QgYWZ0ZXJWYWx1ZSA9IGFmdGVyLmNvdW50cz8uW2tleV0gPz8gMDtcbiAgICBpZiAoYmVmb3JlVmFsdWUgIT09IGFmdGVyVmFsdWUpIHtcbiAgICAgIGNoYW5nZXMucHVzaCh7IHR5cGU6IGBjb3VudDoke2tleX1gLCBiZWZvcmU6IGJlZm9yZVZhbHVlLCBhZnRlcjogYWZ0ZXJWYWx1ZSB9KTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBiZWZvcmVIZWFkaW5ncyA9IEpTT04uc3RyaW5naWZ5KGJlZm9yZS5oZWFkaW5ncyA/PyBbXSk7XG4gIGNvbnN0IGFmdGVySGVhZGluZ3MgPSBKU09OLnN0cmluZ2lmeShhZnRlci5oZWFkaW5ncyA/PyBbXSk7XG4gIGlmIChiZWZvcmVIZWFkaW5ncyAhPT0gYWZ0ZXJIZWFkaW5ncykge1xuICAgIGNoYW5nZXMucHVzaCh7XG4gICAgICB0eXBlOiBcImhlYWRpbmdzXCIsXG4gICAgICBiZWZvcmU6IGJlZm9yZS5oZWFkaW5ncyA/PyBbXSxcbiAgICAgIGFmdGVyOiBhZnRlci5oZWFkaW5ncyA/PyBbXSxcbiAgICB9KTtcbiAgfVxuXG4gIGNvbnN0IGJlZm9yZUJvZHkgPSBiZWZvcmUuYm9keVRleHQgPz8gXCJcIjtcbiAgY29uc3QgYWZ0ZXJCb2R5ID0gYWZ0ZXIuYm9keVRleHQgPz8gXCJcIjtcbiAgaWYgKGJlZm9yZUJvZHkgIT09IGFmdGVyQm9keSkge1xuICAgIGNoYW5nZXMucHVzaCh7XG4gICAgICB0eXBlOiBcImJvZHlfdGV4dFwiLFxuICAgICAgYmVmb3JlOiBiZWZvcmVCb2R5LnNsaWNlKDAsIDEyMCksXG4gICAgICBhZnRlcjogYWZ0ZXJCb2R5LnNsaWNlKDAsIDEyMCksXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCBjaGFuZ2VkID0gY2hhbmdlcy5sZW5ndGggPiAwO1xuICBjb25zdCBzdW1tYXJ5ID0gY2hhbmdlZFxuICAgID8gY2hhbmdlc1xuICAgICAgICAuc2xpY2UoMCwgNClcbiAgICAgICAgLm1hcCgoY2hhbmdlKSA9PiB7XG4gICAgICAgICAgaWYgKGNoYW5nZS50eXBlID09PSBcInVybFwiKSByZXR1cm4gYFVSTCBjaGFuZ2VkIHRvICR7Y2hhbmdlLmFmdGVyfWA7XG4gICAgICAgICAgaWYgKGNoYW5nZS50eXBlID09PSBcInRpdGxlXCIpIHJldHVybiBgdGl0bGUgY2hhbmdlZCB0byAke2NoYW5nZS5hZnRlcn1gO1xuICAgICAgICAgIGlmIChjaGFuZ2UudHlwZSA9PT0gXCJmb2N1c1wiKSByZXR1cm4gYGZvY3VzIGNoYW5nZWRgO1xuICAgICAgICAgIGlmIChjaGFuZ2UudHlwZSA9PT0gXCJkaWFsb2dfY291bnRcIikgcmV0dXJuIGBkaWFsb2cgY291bnQgJHtjaGFuZ2UuYmVmb3JlfVx1MjE5MiR7Y2hhbmdlLmFmdGVyfWA7XG4gICAgICAgICAgaWYgKGNoYW5nZS50eXBlLnN0YXJ0c1dpdGgoXCJjb3VudDpcIikpIHJldHVybiBgJHtjaGFuZ2UudHlwZS5zbGljZSg2KX0gJHtjaGFuZ2UuYmVmb3JlfVx1MjE5MiR7Y2hhbmdlLmFmdGVyfWA7XG4gICAgICAgICAgaWYgKGNoYW5nZS50eXBlID09PSBcImhlYWRpbmdzXCIpIHJldHVybiBcImhlYWRpbmdzIGNoYW5nZWRcIjtcbiAgICAgICAgICBpZiAoY2hhbmdlLnR5cGUgPT09IFwiYm9keV90ZXh0XCIpIHJldHVybiBcInZpc2libGUgdGV4dCBjaGFuZ2VkXCI7XG4gICAgICAgICAgcmV0dXJuIGAke2NoYW5nZS50eXBlfSBjaGFuZ2VkYDtcbiAgICAgICAgfSlcbiAgICAgICAgLmpvaW4oXCI7IFwiKVxuICAgIDogXCJObyBtZWFuaW5nZnVsIGJyb3dzZXItc3RhdGUgY2hhbmdlIGRldGVjdGVkXCI7XG5cbiAgcmV0dXJuIHsgY2hhbmdlZCwgY2hhbmdlcywgc3VtbWFyeSB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFN0cmluZyBoZWxwZXJzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3RyaW5nKHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIFN0cmluZyh2YWx1ZSA/PyBcIlwiKS50cmltKCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpbmNsdWRlc05lZWRsZShoYXlzdGFjazogc3RyaW5nLCBuZWVkbGU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gbm9ybWFsaXplU3RyaW5nKGhheXN0YWNrKS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKG5vcm1hbGl6ZVN0cmluZyhuZWVkbGUpLnRvTG93ZXJDYXNlKCkpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRocmVzaG9sZCBwYXJzaW5nIGZvciBjb3VudC1iYXNlZCBhc3NlcnRpb25zXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBQYXJzZSBhIHRocmVzaG9sZCBleHByZXNzaW9uIGxpa2UgXCI+PTNcIiwgXCI9PTBcIiwgXCI8NVwiLCBvciBiYXJlIFwiM1wiIChkZWZhdWx0cyB0byBcIj49XCIpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VUaHJlc2hvbGQodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBUaHJlc2hvbGQgfCBudWxsIHtcbiAgaWYgKHZhbHVlID09IG51bGwpIHJldHVybiBudWxsO1xuICBjb25zdCBzdHIgPSBTdHJpbmcodmFsdWUpLnRyaW0oKTtcbiAgaWYgKHN0ciA9PT0gXCJcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IG1hdGNoID0gc3RyLm1hdGNoKC9eKD49fDw9fD09fD58PCk/XFxzKihcXGQrKSQvKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IG9wID0gbWF0Y2hbMV0gfHwgXCI+PVwiO1xuICBjb25zdCBuID0gcGFyc2VJbnQobWF0Y2hbMl0sIDEwKTtcbiAgcmV0dXJuIHsgb3AsIG4gfTtcbn1cblxuLyoqXG4gKiBFdmFsdWF0ZSB3aGV0aGVyIGEgY291bnQgbWVldHMgYSBwYXJzZWQgdGhyZXNob2xkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWVldHNUaHJlc2hvbGQoY291bnQ6IG51bWJlciwgdGhyZXNob2xkOiBUaHJlc2hvbGQpOiBib29sZWFuIHtcbiAgc3dpdGNoICh0aHJlc2hvbGQub3ApIHtcbiAgICBjYXNlIFwiPj1cIjogcmV0dXJuIGNvdW50ID49IHRocmVzaG9sZC5uO1xuICAgIGNhc2UgXCI8PVwiOiByZXR1cm4gY291bnQgPD0gdGhyZXNob2xkLm47XG4gICAgY2FzZSBcIj09XCI6IHJldHVybiBjb3VudCA9PT0gdGhyZXNob2xkLm47XG4gICAgY2FzZSBcIj5cIjogIHJldHVybiBjb3VudCA+IHRocmVzaG9sZC5uO1xuICAgIGNhc2UgXCI8XCI6ICByZXR1cm4gY291bnQgPCB0aHJlc2hvbGQubjtcbiAgICBkZWZhdWx0OiAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIEZpbHRlciBlbnRyaWVzIHRoYXQgb2NjdXJyZWQgYXQgb3IgYWZ0ZXIgYSBnaXZlbiBhY3Rpb24ncyBzdGFydCB0aW1lLlxuICogSWYgc2luY2VBY3Rpb25JZCBpcyBtaXNzaW5nIG9yIHRoZSBhY3Rpb24gaXNuJ3QgZm91bmQsIHJldHVybnMgYWxsIGVudHJpZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRFbnRyaWVzU2luY2UoXG4gIGVudHJpZXM6IEFycmF5PHsgdGltZXN0YW1wPzogbnVtYmVyIH0+LFxuICBzaW5jZUFjdGlvbklkOiBudW1iZXIgfCB1bmRlZmluZWQsXG4gIHRpbWVsaW5lOiBBY3Rpb25UaW1lbGluZSxcbik6IEFycmF5PHsgdGltZXN0YW1wPzogbnVtYmVyIH0+IHtcbiAgaWYgKCFlbnRyaWVzIHx8ICFBcnJheS5pc0FycmF5KGVudHJpZXMpKSByZXR1cm4gW107XG4gIGlmIChzaW5jZUFjdGlvbklkID09IG51bGwgfHwgIXRpbWVsaW5lKSByZXR1cm4gZW50cmllcztcbiAgY29uc3QgYWN0aW9uID0gZmluZEFjdGlvbih0aW1lbGluZSwgc2luY2VBY3Rpb25JZCk7XG4gIGlmICghYWN0aW9uKSByZXR1cm4gZW50cmllcztcbiAgY29uc3Qgc2luY2UgPSBhY3Rpb24uc3RhcnRlZEF0O1xuICByZXR1cm4gZW50cmllcy5maWx0ZXIoKGUpID0+IChlLnRpbWVzdGFtcCA/PyAwKSA+PSBzaW5jZSk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQXNzZXJ0aW9uIEV2YWx1YXRpb25cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5pbnRlcmZhY2UgQXNzZXJ0aW9uQ2hlY2tJbnB1dCB7XG4gIGtpbmQ6IHN0cmluZztcbiAgc2VsZWN0b3I/OiBzdHJpbmc7XG4gIHZhbHVlPzogc3RyaW5nO1xuICB0ZXh0Pzogc3RyaW5nO1xuICBjaGVja2VkPzogYm9vbGVhbjtcbiAgc2luY2VBY3Rpb25JZD86IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIEFzc2VydGlvblN0YXRlIHtcbiAgdXJsPzogc3RyaW5nO1xuICB0aXRsZT86IHN0cmluZztcbiAgYm9keVRleHQ/OiBzdHJpbmc7XG4gIGZvY3VzPzogc3RyaW5nO1xuICBzZWxlY3RvclN0YXRlcz86IFJlY29yZDxzdHJpbmcsIHsgdmlzaWJsZT86IGJvb2xlYW47IHZhbHVlPzogc3RyaW5nOyBjaGVja2VkPzogYm9vbGVhbiB8IG51bGwgfT47XG4gIGNvbnNvbGVFbnRyaWVzPzogQXJyYXk8eyB0eXBlPzogc3RyaW5nOyB0ZXh0Pzogc3RyaW5nOyBtZXNzYWdlPzogc3RyaW5nOyB0aW1lc3RhbXA/OiBudW1iZXIgfT47XG4gIG5ldHdvcmtFbnRyaWVzPzogQXJyYXk8eyB0eXBlPzogc3RyaW5nOyB1cmw/OiBzdHJpbmc7IHN0YXR1cz86IG51bWJlcjsgZmFpbGVkPzogYm9vbGVhbjsgdGltZXN0YW1wPzogbnVtYmVyIH0+O1xuICBhbGxDb25zb2xlRW50cmllcz86IEFycmF5PHsgdHlwZT86IHN0cmluZzsgdGV4dD86IHN0cmluZzsgbWVzc2FnZT86IHN0cmluZzsgdGltZXN0YW1wPzogbnVtYmVyIH0+O1xuICBhbGxOZXR3b3JrRW50cmllcz86IEFycmF5PHsgdHlwZT86IHN0cmluZzsgdXJsPzogc3RyaW5nOyBzdGF0dXM/OiBudW1iZXI7IGZhaWxlZD86IGJvb2xlYW47IHRpbWVzdGFtcD86IG51bWJlciB9PjtcbiAgYWN0aW9uVGltZWxpbmU/OiBBY3Rpb25UaW1lbGluZSB8IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBldmFsdWF0ZUFzc2VydGlvbkNoZWNrcyh7IGNoZWNrcywgc3RhdGUgfTogeyBjaGVja3M6IEFzc2VydGlvbkNoZWNrSW5wdXRbXTsgc3RhdGU6IEFzc2VydGlvblN0YXRlIH0pOiBBc3NlcnRpb25FdmFsdWF0aW9uIHtcbiAgY29uc3QgcmVzdWx0czogQXNzZXJ0aW9uQ2hlY2tSZXN1bHRbXSA9IFtdO1xuICBjb25zdCBzZWxlY3RvclN0YXRlcyA9IHN0YXRlLnNlbGVjdG9yU3RhdGVzID8/IHt9O1xuICBjb25zdCBjb25zb2xlRW50cmllcyA9IHN0YXRlLmNvbnNvbGVFbnRyaWVzID8/IFtdO1xuICBjb25zdCBuZXR3b3JrRW50cmllcyA9IHN0YXRlLm5ldHdvcmtFbnRyaWVzID8/IFtdO1xuICBjb25zdCBhbGxDb25zb2xlRW50cmllcyA9IHN0YXRlLmFsbENvbnNvbGVFbnRyaWVzID8/IHN0YXRlLmNvbnNvbGVFbnRyaWVzID8/IFtdO1xuICBjb25zdCBhbGxOZXR3b3JrRW50cmllcyA9IHN0YXRlLmFsbE5ldHdvcmtFbnRyaWVzID8/IHN0YXRlLm5ldHdvcmtFbnRyaWVzID8/IFtdO1xuICBjb25zdCBhY3Rpb25UaW1lbGluZSA9IHN0YXRlLmFjdGlvblRpbWVsaW5lID8/IG51bGw7XG5cbiAgZm9yIChjb25zdCBjaGVjayBvZiBjaGVja3MpIHtcbiAgICBjb25zdCBzZWxlY3RvclN0YXRlID0gY2hlY2suc2VsZWN0b3IgPyBzZWxlY3RvclN0YXRlc1tjaGVjay5zZWxlY3Rvcl0gPz8gbnVsbCA6IG51bGw7XG4gICAgbGV0IHBhc3NlZCA9IGZhbHNlO1xuICAgIGxldCBhY3R1YWw6IHVua25vd247XG4gICAgbGV0IGV4cGVjdGVkOiB1bmtub3duO1xuXG4gICAgc3dpdGNoIChjaGVjay5raW5kKSB7XG4gICAgICBjYXNlIFwidXJsX2NvbnRhaW5zXCI6XG4gICAgICAgIGFjdHVhbCA9IHN0YXRlLnVybCA/PyBcIlwiO1xuICAgICAgICBleHBlY3RlZCA9IGNoZWNrLnZhbHVlID8/IFwiXCI7XG4gICAgICAgIHBhc3NlZCA9IGluY2x1ZGVzTmVlZGxlKGFjdHVhbCBhcyBzdHJpbmcsIGV4cGVjdGVkIGFzIHN0cmluZyk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInRpdGxlX2NvbnRhaW5zXCI6XG4gICAgICAgIGFjdHVhbCA9IHN0YXRlLnRpdGxlID8/IFwiXCI7XG4gICAgICAgIGV4cGVjdGVkID0gY2hlY2sudmFsdWUgPz8gXCJcIjtcbiAgICAgICAgcGFzc2VkID0gaW5jbHVkZXNOZWVkbGUoYWN0dWFsIGFzIHN0cmluZywgZXhwZWN0ZWQgYXMgc3RyaW5nKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwidGV4dF92aXNpYmxlXCI6XG4gICAgICAgIGFjdHVhbCA9IHN0YXRlLmJvZHlUZXh0ID8/IFwiXCI7XG4gICAgICAgIGV4cGVjdGVkID0gY2hlY2sudGV4dCA/PyBcIlwiO1xuICAgICAgICBwYXNzZWQgPSBpbmNsdWRlc05lZWRsZShhY3R1YWwgYXMgc3RyaW5nLCBleHBlY3RlZCBhcyBzdHJpbmcpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ0ZXh0X25vdF92aXNpYmxlXCI6XG4gICAgICAgIGFjdHVhbCA9IHN0YXRlLmJvZHlUZXh0ID8/IFwiXCI7XG4gICAgICAgIGV4cGVjdGVkID0gY2hlY2sudGV4dCA/PyBcIlwiO1xuICAgICAgICBwYXNzZWQgPSAhaW5jbHVkZXNOZWVkbGUoYWN0dWFsIGFzIHN0cmluZywgZXhwZWN0ZWQgYXMgc3RyaW5nKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwic2VsZWN0b3JfdmlzaWJsZVwiOlxuICAgICAgICBhY3R1YWwgPSBzZWxlY3RvclN0YXRlPy52aXNpYmxlID8/IGZhbHNlO1xuICAgICAgICBleHBlY3RlZCA9IHRydWU7XG4gICAgICAgIHBhc3NlZCA9IGFjdHVhbCA9PT0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwic2VsZWN0b3JfaGlkZGVuXCI6XG4gICAgICAgIGFjdHVhbCA9IHNlbGVjdG9yU3RhdGU/LnZpc2libGUgPz8gZmFsc2U7XG4gICAgICAgIGV4cGVjdGVkID0gZmFsc2U7XG4gICAgICAgIHBhc3NlZCA9IGFjdHVhbCA9PT0gZmFsc2U7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInZhbHVlX2VxdWFsc1wiOlxuICAgICAgICBhY3R1YWwgPSBzZWxlY3RvclN0YXRlPy52YWx1ZSA/PyBcIlwiO1xuICAgICAgICBleHBlY3RlZCA9IGNoZWNrLnZhbHVlID8/IFwiXCI7XG4gICAgICAgIHBhc3NlZCA9IGFjdHVhbCA9PT0gZXhwZWN0ZWQ7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInZhbHVlX2NvbnRhaW5zXCI6XG4gICAgICAgIGFjdHVhbCA9IHNlbGVjdG9yU3RhdGU/LnZhbHVlID8/IFwiXCI7XG4gICAgICAgIGV4cGVjdGVkID0gY2hlY2sudmFsdWUgPz8gXCJcIjtcbiAgICAgICAgcGFzc2VkID0gaW5jbHVkZXNOZWVkbGUoYWN0dWFsIGFzIHN0cmluZywgZXhwZWN0ZWQgYXMgc3RyaW5nKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiZm9jdXNlZF9tYXRjaGVzXCI6XG4gICAgICAgIGFjdHVhbCA9IHN0YXRlLmZvY3VzID8/IFwiXCI7XG4gICAgICAgIGV4cGVjdGVkID0gY2hlY2sudmFsdWUgPz8gXCJcIjtcbiAgICAgICAgcGFzc2VkID0gaW5jbHVkZXNOZWVkbGUoYWN0dWFsIGFzIHN0cmluZywgZXhwZWN0ZWQgYXMgc3RyaW5nKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiY2hlY2tlZF9lcXVhbHNcIjpcbiAgICAgICAgYWN0dWFsID0gc2VsZWN0b3JTdGF0ZT8uY2hlY2tlZCA/PyBudWxsO1xuICAgICAgICBleHBlY3RlZCA9ICEhY2hlY2suY2hlY2tlZDtcbiAgICAgICAgcGFzc2VkID0gYWN0dWFsID09PSBleHBlY3RlZDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwibm9fY29uc29sZV9lcnJvcnNcIjpcbiAgICAgICAgYWN0dWFsID0gY29uc29sZUVudHJpZXMuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkudHlwZSA9PT0gXCJlcnJvclwiIHx8IGVudHJ5LnR5cGUgPT09IFwicGFnZWVycm9yXCIpLmxlbmd0aDtcbiAgICAgICAgZXhwZWN0ZWQgPSAwO1xuICAgICAgICBwYXNzZWQgPSBhY3R1YWwgPT09IDA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcIm5vX2ZhaWxlZF9yZXF1ZXN0c1wiOlxuICAgICAgICBhY3R1YWwgPSBuZXR3b3JrRW50cmllcy5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeS5mYWlsZWQgfHwgKHR5cGVvZiBlbnRyeS5zdGF0dXMgPT09IFwibnVtYmVyXCIgJiYgZW50cnkuc3RhdHVzID49IDQwMCkpLmxlbmd0aDtcbiAgICAgICAgZXhwZWN0ZWQgPSAwO1xuICAgICAgICBwYXNzZWQgPSBhY3R1YWwgPT09IDA7XG4gICAgICAgIGJyZWFrO1xuXG4gICAgICAvLyAtLS0gUzAyOiBOZXcgc3RydWN0dXJlZCBuZXR3b3JrL2NvbnNvbGUgYXNzZXJ0aW9uIGtpbmRzIC0tLVxuXG4gICAgICBjYXNlIFwicmVxdWVzdF91cmxfc2VlblwiOiB7XG4gICAgICAgIGNvbnN0IGZpbHRlcmVkID0gZ2V0RW50cmllc1NpbmNlKGFsbE5ldHdvcmtFbnRyaWVzLCBjaGVjay5zaW5jZUFjdGlvbklkLCBhY3Rpb25UaW1lbGluZSEpO1xuICAgICAgICBjb25zdCBtYXRjaGVzID0gKGZpbHRlcmVkIGFzIHR5cGVvZiBhbGxOZXR3b3JrRW50cmllcykuZmlsdGVyKChlKSA9PiBpbmNsdWRlc05lZWRsZShlLnVybCA/PyBcIlwiLCBjaGVjay50ZXh0ID8/IFwiXCIpKTtcbiAgICAgICAgYWN0dWFsID0gbWF0Y2hlcy5sZW5ndGggPiAwO1xuICAgICAgICBleHBlY3RlZCA9IHRydWU7XG4gICAgICAgIHBhc3NlZCA9IGFjdHVhbCA9PT0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIGNhc2UgXCJyZXNwb25zZV9zdGF0dXNcIjoge1xuICAgICAgICBjb25zdCBmaWx0ZXJlZCA9IGdldEVudHJpZXNTaW5jZShhbGxOZXR3b3JrRW50cmllcywgY2hlY2suc2luY2VBY3Rpb25JZCwgYWN0aW9uVGltZWxpbmUhKTtcbiAgICAgICAgY29uc3Qgc3RhdHVzTnVtID0gcGFyc2VJbnQoY2hlY2sudmFsdWUhLCAxMCk7XG4gICAgICAgIGNvbnN0IG1hdGNoZXMgPSAoZmlsdGVyZWQgYXMgdHlwZW9mIGFsbE5ldHdvcmtFbnRyaWVzKS5maWx0ZXIoXG4gICAgICAgICAgKGUpID0+IGluY2x1ZGVzTmVlZGxlKGUudXJsID8/IFwiXCIsIGNoZWNrLnRleHQgPz8gXCJcIikgJiYgdHlwZW9mIGUuc3RhdHVzID09PSBcIm51bWJlclwiICYmIGUuc3RhdHVzID09PSBzdGF0dXNOdW1cbiAgICAgICAgKTtcbiAgICAgICAgYWN0dWFsID0gbWF0Y2hlcy5sZW5ndGggPiAwID8gYGZvdW5kIChzdGF0dXM9JHttYXRjaGVzWzBdLnN0YXR1c30pYCA6IGBub3QgZm91bmRgO1xuICAgICAgICBleHBlY3RlZCA9IGBzdGF0dXM9JHtjaGVjay52YWx1ZSA/PyBcIlwifWA7XG4gICAgICAgIHBhc3NlZCA9IG1hdGNoZXMubGVuZ3RoID4gMDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIGNhc2UgXCJjb25zb2xlX21lc3NhZ2VfbWF0Y2hlc1wiOiB7XG4gICAgICAgIGNvbnN0IGZpbHRlcmVkID0gZ2V0RW50cmllc1NpbmNlKGFsbENvbnNvbGVFbnRyaWVzLCBjaGVjay5zaW5jZUFjdGlvbklkLCBhY3Rpb25UaW1lbGluZSEpO1xuICAgICAgICBjb25zdCBtYXRjaGVzID0gKGZpbHRlcmVkIGFzIHR5cGVvZiBhbGxDb25zb2xlRW50cmllcykuZmlsdGVyKChlKSA9PiBpbmNsdWRlc05lZWRsZShlLnRleHQgPz8gXCJcIiwgY2hlY2sudGV4dCA/PyBcIlwiKSk7XG4gICAgICAgIGFjdHVhbCA9IG1hdGNoZXMubGVuZ3RoID4gMDtcbiAgICAgICAgZXhwZWN0ZWQgPSB0cnVlO1xuICAgICAgICBwYXNzZWQgPSBhY3R1YWwgPT09IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBjYXNlIFwibmV0d29ya19jb3VudFwiOiB7XG4gICAgICAgIGNvbnN0IGZpbHRlcmVkID0gZ2V0RW50cmllc1NpbmNlKGFsbE5ldHdvcmtFbnRyaWVzLCBjaGVjay5zaW5jZUFjdGlvbklkLCBhY3Rpb25UaW1lbGluZSEpO1xuICAgICAgICBjb25zdCBtYXRjaGVzID0gKGZpbHRlcmVkIGFzIHR5cGVvZiBhbGxOZXR3b3JrRW50cmllcykuZmlsdGVyKChlKSA9PiBpbmNsdWRlc05lZWRsZShlLnVybCA/PyBcIlwiLCBjaGVjay50ZXh0ID8/IFwiXCIpKTtcbiAgICAgICAgY29uc3QgdGhyZXNob2xkID0gcGFyc2VUaHJlc2hvbGQoY2hlY2sudmFsdWUpO1xuICAgICAgICBpZiAoIXRocmVzaG9sZCkge1xuICAgICAgICAgIGFjdHVhbCA9IGBpbnZhbGlkIHRocmVzaG9sZDogJHtjaGVjay52YWx1ZX1gO1xuICAgICAgICAgIGV4cGVjdGVkID0gY2hlY2sudmFsdWUgPz8gXCJcIjtcbiAgICAgICAgICBwYXNzZWQgPSBmYWxzZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBhY3R1YWwgPSBgY291bnQ9JHttYXRjaGVzLmxlbmd0aH1gO1xuICAgICAgICAgIGV4cGVjdGVkID0gYCR7dGhyZXNob2xkLm9wfSR7dGhyZXNob2xkLm59YDtcbiAgICAgICAgICBwYXNzZWQgPSBtZWV0c1RocmVzaG9sZChtYXRjaGVzLmxlbmd0aCwgdGhyZXNob2xkKTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgY2FzZSBcImNvbnNvbGVfY291bnRcIjoge1xuICAgICAgICBjb25zdCBmaWx0ZXJlZCA9IGdldEVudHJpZXNTaW5jZShhbGxDb25zb2xlRW50cmllcywgY2hlY2suc2luY2VBY3Rpb25JZCwgYWN0aW9uVGltZWxpbmUhKTtcbiAgICAgICAgY29uc3QgbWF0Y2hlcyA9IChmaWx0ZXJlZCBhcyB0eXBlb2YgYWxsQ29uc29sZUVudHJpZXMpLmZpbHRlcigoZSkgPT4gaW5jbHVkZXNOZWVkbGUoZS50ZXh0ID8/IFwiXCIsIGNoZWNrLnRleHQgPz8gXCJcIikpO1xuICAgICAgICBjb25zdCB0aHJlc2hvbGQgPSBwYXJzZVRocmVzaG9sZChjaGVjay52YWx1ZSk7XG4gICAgICAgIGlmICghdGhyZXNob2xkKSB7XG4gICAgICAgICAgYWN0dWFsID0gYGludmFsaWQgdGhyZXNob2xkOiAke2NoZWNrLnZhbHVlfWA7XG4gICAgICAgICAgZXhwZWN0ZWQgPSBjaGVjay52YWx1ZSA/PyBcIlwiO1xuICAgICAgICAgIHBhc3NlZCA9IGZhbHNlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGFjdHVhbCA9IGBjb3VudD0ke21hdGNoZXMubGVuZ3RofWA7XG4gICAgICAgICAgZXhwZWN0ZWQgPSBgJHt0aHJlc2hvbGQub3B9JHt0aHJlc2hvbGQubn1gO1xuICAgICAgICAgIHBhc3NlZCA9IG1lZXRzVGhyZXNob2xkKG1hdGNoZXMubGVuZ3RoLCB0aHJlc2hvbGQpO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBjYXNlIFwibm9fY29uc29sZV9lcnJvcnNfc2luY2VcIjoge1xuICAgICAgICBjb25zdCBmaWx0ZXJlZCA9IGdldEVudHJpZXNTaW5jZShhbGxDb25zb2xlRW50cmllcywgY2hlY2suc2luY2VBY3Rpb25JZCwgYWN0aW9uVGltZWxpbmUhKTtcbiAgICAgICAgY29uc3QgZXJyb3JzID0gKGZpbHRlcmVkIGFzIHR5cGVvZiBhbGxDb25zb2xlRW50cmllcykuZmlsdGVyKChlKSA9PiBlLnR5cGUgPT09IFwiZXJyb3JcIiB8fCBlLnR5cGUgPT09IFwicGFnZWVycm9yXCIpO1xuICAgICAgICBhY3R1YWwgPSBlcnJvcnMubGVuZ3RoO1xuICAgICAgICBleHBlY3RlZCA9IDA7XG4gICAgICAgIHBhc3NlZCA9IGVycm9ycy5sZW5ndGggPT09IDA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBjYXNlIFwibm9fZmFpbGVkX3JlcXVlc3RzX3NpbmNlXCI6IHtcbiAgICAgICAgY29uc3QgZmlsdGVyZWQgPSBnZXRFbnRyaWVzU2luY2UoYWxsTmV0d29ya0VudHJpZXMsIGNoZWNrLnNpbmNlQWN0aW9uSWQsIGFjdGlvblRpbWVsaW5lISk7XG4gICAgICAgIGNvbnN0IGZhaWx1cmVzID0gKGZpbHRlcmVkIGFzIHR5cGVvZiBhbGxOZXR3b3JrRW50cmllcykuZmlsdGVyKChlKSA9PiBlLmZhaWxlZCB8fCAodHlwZW9mIGUuc3RhdHVzID09PSBcIm51bWJlclwiICYmIGUuc3RhdHVzID49IDQwMCkpO1xuICAgICAgICBhY3R1YWwgPSBmYWlsdXJlcy5sZW5ndGg7XG4gICAgICAgIGV4cGVjdGVkID0gMDtcbiAgICAgICAgcGFzc2VkID0gZmFpbHVyZXMubGVuZ3RoID09PSAwO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgYWN0dWFsID0gXCJ1bnN1cHBvcnRlZFwiO1xuICAgICAgICBleHBlY3RlZCA9IGNoZWNrLmtpbmQ7XG4gICAgICAgIHBhc3NlZCA9IGZhbHNlO1xuICAgICAgICBicmVhaztcbiAgICB9XG5cbiAgICByZXN1bHRzLnB1c2goe1xuICAgICAgbmFtZTogY2hlY2sua2luZCxcbiAgICAgIHBhc3NlZCxcbiAgICAgIGFjdHVhbCxcbiAgICAgIGV4cGVjdGVkLFxuICAgICAgc2VsZWN0b3I6IGNoZWNrLnNlbGVjdG9yLFxuICAgICAgdGV4dDogY2hlY2sudGV4dCxcbiAgICB9KTtcbiAgfVxuXG4gIGNvbnN0IGZhaWxlZCA9IHJlc3VsdHMuZmlsdGVyKChyZXN1bHQpID0+ICFyZXN1bHQucGFzc2VkKTtcbiAgY29uc3QgdmVyaWZpZWQgPSBmYWlsZWQubGVuZ3RoID09PSAwO1xuICByZXR1cm4ge1xuICAgIHZlcmlmaWVkLFxuICAgIGNoZWNrczogcmVzdWx0cyxcbiAgICBzdW1tYXJ5OiB2ZXJpZmllZFxuICAgICAgPyBgUEFTUyAoJHtyZXN1bHRzLmxlbmd0aH0vJHtyZXN1bHRzLmxlbmd0aH0gY2hlY2tzKWBcbiAgICAgIDogYEZBSUwgKCR7ZmFpbGVkLmxlbmd0aH0vJHtyZXN1bHRzLmxlbmd0aH0gY2hlY2tzIGZhaWxlZClgLFxuICAgIGFnZW50SGludDogdmVyaWZpZWRcbiAgICAgID8gXCJBbGwgYXNzZXJ0aW9uIGNoZWNrcyBwYXNzZWRcIlxuICAgICAgOiBmYWlsZWRbMF1cbiAgICAgICAgPyBgSW52ZXN0aWdhdGUgJHtmYWlsZWRbMF0ubmFtZX0gKGV4cGVjdGVkICR7SlNPTi5zdHJpbmdpZnkoZmFpbGVkWzBdLmV4cGVjdGVkKX0sIGdvdCAke0pTT04uc3RyaW5naWZ5KGZhaWxlZFswXS5hY3R1YWwpfSlgXG4gICAgICAgIDogXCJBc3NlcnRpb24gZmFpbGVkXCIsXG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gV2FpdC1jb25kaXRpb24gdmFsaWRhdGlvblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmludGVyZmFjZSBXYWl0Q29uZGl0aW9uU3BlYyB7XG4gIG5lZWRzVmFsdWU6IGJvb2xlYW47XG4gIHZhbHVlTGFiZWw6IHN0cmluZztcbiAgbmVlZHNUaHJlc2hvbGQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIEFsbCByZWNvZ25pemVkIHdhaXQgY29uZGl0aW9ucyB3aXRoIHRoZWlyIHBhcmFtZXRlciByZXF1aXJlbWVudHMuXG4gKi9cbmNvbnN0IFdBSVRfQ09ORElUSU9OUzogUmVjb3JkPHN0cmluZywgV2FpdENvbmRpdGlvblNwZWM+ID0ge1xuICAvLyBFeGlzdGluZyA1IGNvbmRpdGlvbnNcbiAgc2VsZWN0b3JfdmlzaWJsZTogICB7IG5lZWRzVmFsdWU6IHRydWUsICB2YWx1ZUxhYmVsOiBcIkNTUyBzZWxlY3RvclwiIH0sXG4gIHNlbGVjdG9yX2hpZGRlbjogICAgeyBuZWVkc1ZhbHVlOiB0cnVlLCAgdmFsdWVMYWJlbDogXCJDU1Mgc2VsZWN0b3JcIiB9LFxuICB1cmxfY29udGFpbnM6ICAgICAgIHsgbmVlZHNWYWx1ZTogdHJ1ZSwgIHZhbHVlTGFiZWw6IFwiVVJMIHN1YnN0cmluZ1wiIH0sXG4gIG5ldHdvcmtfaWRsZTogICAgICAgeyBuZWVkc1ZhbHVlOiBmYWxzZSwgdmFsdWVMYWJlbDogXCJcIiB9LFxuICBkZWxheTogICAgICAgICAgICAgIHsgbmVlZHNWYWx1ZTogdHJ1ZSwgIHZhbHVlTGFiZWw6IFwibWlsbGlzZWNvbmRzIGFzIGEgc3RyaW5nIChlLmcuICcxMDAwJylcIiB9LFxuXG4gIC8vIE5ldyA2IGNvbmRpdGlvbnMgKFMwMylcbiAgdGV4dF92aXNpYmxlOiAgICAgICB7IG5lZWRzVmFsdWU6IHRydWUsICB2YWx1ZUxhYmVsOiBcInRleHQgdG8gc2VhcmNoIGZvclwiIH0sXG4gIHRleHRfaGlkZGVuOiAgICAgICAgeyBuZWVkc1ZhbHVlOiB0cnVlLCAgdmFsdWVMYWJlbDogXCJ0ZXh0IHRvIHNlYXJjaCBmb3JcIiB9LFxuICByZXF1ZXN0X2NvbXBsZXRlZDogIHsgbmVlZHNWYWx1ZTogdHJ1ZSwgIHZhbHVlTGFiZWw6IFwiVVJMIHN1YnN0cmluZyB0byBtYXRjaFwiIH0sXG4gIGNvbnNvbGVfbWVzc2FnZTogICAgeyBuZWVkc1ZhbHVlOiB0cnVlLCAgdmFsdWVMYWJlbDogXCJtZXNzYWdlIHN1YnN0cmluZyB0byBtYXRjaFwiIH0sXG4gIGVsZW1lbnRfY291bnQ6ICAgICAgeyBuZWVkc1ZhbHVlOiB0cnVlLCAgdmFsdWVMYWJlbDogXCJDU1Mgc2VsZWN0b3JcIiwgbmVlZHNUaHJlc2hvbGQ6IHRydWUgfSxcbiAgcmVnaW9uX3N0YWJsZTogICAgICB7IG5lZWRzVmFsdWU6IHRydWUsICB2YWx1ZUxhYmVsOiBcIkNTUyBzZWxlY3RvclwiIH0sXG59O1xuXG4vKipcbiAqIFZhbGlkYXRlIHBhcmFtZXRlcnMgZm9yIGEgYnJvd3Nlcl93YWl0X2ZvciBjb25kaXRpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZVdhaXRQYXJhbXMocGFyYW1zOiB7IGNvbmRpdGlvbjogc3RyaW5nOyB2YWx1ZT86IHN0cmluZzsgdGhyZXNob2xkPzogc3RyaW5nIH0pOiBXYWl0VmFsaWRhdGlvbkVycm9yIHwgbnVsbCB7XG4gIGNvbnN0IHsgY29uZGl0aW9uLCB2YWx1ZSwgdGhyZXNob2xkIH0gPSBwYXJhbXMgPz8ge307XG5cbiAgaWYgKCFjb25kaXRpb24pIHtcbiAgICByZXR1cm4geyBlcnJvcjogXCJjb25kaXRpb24gaXMgcmVxdWlyZWRcIiB9O1xuICB9XG5cbiAgY29uc3Qgc3BlYyA9IFdBSVRfQ09ORElUSU9OU1tjb25kaXRpb25dO1xuICBpZiAoIXNwZWMpIHtcbiAgICBjb25zdCBrbm93biA9IE9iamVjdC5rZXlzKFdBSVRfQ09ORElUSU9OUykuam9pbihcIiwgXCIpO1xuICAgIHJldHVybiB7IGVycm9yOiBgdW5rbm93biBjb25kaXRpb24gXCIke2NvbmRpdGlvbn1cIi4gS25vd24gY29uZGl0aW9uczogJHtrbm93bn1gIH07XG4gIH1cblxuICBpZiAoc3BlYy5uZWVkc1ZhbHVlICYmICghdmFsdWUgfHwgU3RyaW5nKHZhbHVlKS50cmltKCkgPT09IFwiXCIpKSB7XG4gICAgcmV0dXJuIHsgZXJyb3I6IGAke2NvbmRpdGlvbn0gcmVxdWlyZXMgYSB2YWx1ZSAoJHtzcGVjLnZhbHVlTGFiZWx9KWAgfTtcbiAgfVxuXG4gIGlmIChzcGVjLm5lZWRzVGhyZXNob2xkICYmIHRocmVzaG9sZCAhPSBudWxsICYmIFN0cmluZyh0aHJlc2hvbGQpLnRyaW0oKSAhPT0gXCJcIikge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVGhyZXNob2xkKHRocmVzaG9sZCk7XG4gICAgaWYgKCFwYXJzZWQpIHtcbiAgICAgIHJldHVybiB7IGVycm9yOiBgJHtjb25kaXRpb259IHRocmVzaG9sZCBpcyBtYWxmb3JtZWQ6IFwiJHt0aHJlc2hvbGR9XCIuIEV4cGVjdGVkIGZvcm1hdDogPj1OLCA8PU4sID09TiwgPk4sIDxOLCBvciBiYXJlIE5gIH07XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUmVnaW9uLXN0YWJsZSBzY3JpcHQgZ2VuZXJhdG9yXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBHZW5lcmF0ZSBhIEpTIGV4cHJlc3Npb24gc3RyaW5nIGZvciBwYWdlLndhaXRGb3JGdW5jdGlvbigpIHRoYXQgZGV0ZWN0c1xuICogRE9NIHN0YWJpbGl0eSBieSBjb21wYXJpbmcgc25hcHNob3QgaGFzaGVzIGFjcm9zcyBwb2xsaW5nIGludGVydmFscy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVJlZ2lvblN0YWJsZVNjcmlwdChzZWxlY3Rvcjogc3RyaW5nKTogc3RyaW5nIHtcbiAgLy8gQ3JlYXRlIGEgc3RhYmxlIGtleSBmcm9tIHRoZSBzZWxlY3RvciAoc2ltcGxlIGhhc2ggdG8gYXZvaWQgc3BlY2lhbCBjaGFycylcbiAgY29uc3Qgc2FmZUtleSA9IEFycmF5LmZyb20oc2VsZWN0b3IpLnJlZHVjZSgoaCwgYykgPT4gKChoIDw8IDUpIC0gaCArIGMuY2hhckNvZGVBdCgwKSkgfCAwLCAwKSA+Pj4gMDtcbiAgY29uc3Qgd2luZG93S2V5ID0gYF9fcHdfcmVnaW9uX3N0YWJsZV8ke3NhZmVLZXl9YDtcblxuICByZXR1cm4gYCgoKSA9PiB7XG4gIGNvbnN0IGVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3Rvcigke0pTT04uc3RyaW5naWZ5KHNlbGVjdG9yKX0pO1xuICBpZiAoIWVsKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHNuYXBzaG90ID0gZWwuaW5uZXJIVE1MLmxlbmd0aCArICd8JyArIGVsLmNoaWxkRWxlbWVudENvdW50ICsgJ3wnICsgZWwuaW5uZXJUZXh0Lmxlbmd0aDtcbiAgY29uc3QgcHJldiA9IHdpbmRvd1ske0pTT04uc3RyaW5naWZ5KHdpbmRvd0tleSl9XTtcbiAgd2luZG93WyR7SlNPTi5zdHJpbmdpZnkod2luZG93S2V5KX1dID0gc25hcHNob3Q7XG4gIGlmIChwcmV2ID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHNuYXBzaG90ID09PSBwcmV2O1xufSkoKWA7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUGFnZSBSZWdpc3RyeSBcdTIwMTQgcHVyZS1sb2dpYyBvcGVyYXRpb25zIGZvciBtdWx0aS1wYWdlL3RhYiBtYW5hZ2VtZW50XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVBhZ2VSZWdpc3RyeSgpOiBQYWdlUmVnaXN0cnkge1xuICByZXR1cm4geyBwYWdlczogW10sIGFjdGl2ZVBhZ2VJZDogbnVsbCwgbmV4dElkOiAxIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RyeUFkZFBhZ2UoXG4gIHJlZ2lzdHJ5OiBQYWdlUmVnaXN0cnksXG4gIHsgcGFnZSwgdGl0bGUgPSBcIlwiLCB1cmwgPSBcIlwiLCBvcGVuZXIgPSBudWxsIH06IHsgcGFnZTogdW5rbm93bjsgdGl0bGU/OiBzdHJpbmc7IHVybD86IHN0cmluZzsgb3BlbmVyPzogbnVtYmVyIHwgbnVsbCB9LFxuKTogUGFnZUVudHJ5IHtcbiAgY29uc3QgZW50cnk6IFBhZ2VFbnRyeSA9IHsgaWQ6IHJlZ2lzdHJ5Lm5leHRJZCsrLCBwYWdlLCB0aXRsZSwgdXJsLCBvcGVuZXIgfTtcbiAgcmVnaXN0cnkucGFnZXMucHVzaChlbnRyeSk7XG4gIHJldHVybiBlbnRyeTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdHJ5UmVtb3ZlUGFnZShyZWdpc3RyeTogUGFnZVJlZ2lzdHJ5LCBwYWdlSWQ6IG51bWJlcik6IHsgcmVtb3ZlZDogUGFnZUVudHJ5OyBuZXdBY3RpdmVJZDogbnVtYmVyIHwgbnVsbCB9IHtcbiAgY29uc3QgaWR4ID0gcmVnaXN0cnkucGFnZXMuZmluZEluZGV4KChwKSA9PiBwLmlkID09PSBwYWdlSWQpO1xuICBpZiAoaWR4ID09PSAtMSkge1xuICAgIGNvbnN0IGF2YWlsYWJsZSA9IHJlZ2lzdHJ5LnBhZ2VzLm1hcCgocCkgPT4gcC5pZCk7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYHJlZ2lzdHJ5UmVtb3ZlUGFnZTogcGFnZSAke3BhZ2VJZH0gbm90IGZvdW5kLiBgICtcbiAgICAgICAgYEF2YWlsYWJsZSBwYWdlIElEczogWyR7YXZhaWxhYmxlLmpvaW4oXCIsIFwiKX1dLiBgICtcbiAgICAgICAgYFJlZ2lzdHJ5IHNpemU6ICR7cmVnaXN0cnkucGFnZXMubGVuZ3RofS5gXG4gICAgKTtcbiAgfVxuICBjb25zdCBbcmVtb3ZlZF0gPSByZWdpc3RyeS5wYWdlcy5zcGxpY2UoaWR4LCAxKTtcblxuICAvLyBPcnBoYW4gYW55IHBhZ2VzIHdob3NlIG9wZW5lciB3YXMgdGhlIHJlbW92ZWQgcGFnZVxuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlZ2lzdHJ5LnBhZ2VzKSB7XG4gICAgaWYgKGVudHJ5Lm9wZW5lciA9PT0gcGFnZUlkKSB7XG4gICAgICBlbnRyeS5vcGVuZXIgPSBudWxsO1xuICAgIH1cbiAgfVxuXG4gIGxldCBuZXdBY3RpdmVJZCA9IHJlZ2lzdHJ5LmFjdGl2ZVBhZ2VJZDtcbiAgaWYgKHJlZ2lzdHJ5LmFjdGl2ZVBhZ2VJZCA9PT0gcGFnZUlkKSB7XG4gICAgaWYgKHJlZ2lzdHJ5LnBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgbmV3QWN0aXZlSWQgPSBudWxsO1xuICAgIH0gZWxzZSBpZiAocmVtb3ZlZC5vcGVuZXIgIT09IG51bGwgJiYgcmVnaXN0cnkucGFnZXMuc29tZSgocCkgPT4gcC5pZCA9PT0gcmVtb3ZlZC5vcGVuZXIpKSB7XG4gICAgICBuZXdBY3RpdmVJZCA9IHJlbW92ZWQub3BlbmVyO1xuICAgIH0gZWxzZSB7XG4gICAgICBuZXdBY3RpdmVJZCA9IHJlZ2lzdHJ5LnBhZ2VzW3JlZ2lzdHJ5LnBhZ2VzLmxlbmd0aCAtIDFdLmlkO1xuICAgIH1cbiAgICByZWdpc3RyeS5hY3RpdmVQYWdlSWQgPSBuZXdBY3RpdmVJZDtcbiAgfVxuXG4gIHJldHVybiB7IHJlbW92ZWQsIG5ld0FjdGl2ZUlkIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RyeVNldEFjdGl2ZShyZWdpc3RyeTogUGFnZVJlZ2lzdHJ5LCBwYWdlSWQ6IG51bWJlcik6IHZvaWQge1xuICBjb25zdCBlbnRyeSA9IHJlZ2lzdHJ5LnBhZ2VzLmZpbmQoKHApID0+IHAuaWQgPT09IHBhZ2VJZCk7XG4gIGlmICghZW50cnkpIHtcbiAgICBjb25zdCBhdmFpbGFibGUgPSByZWdpc3RyeS5wYWdlcy5tYXAoKHApID0+IHAuaWQpO1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGByZWdpc3RyeVNldEFjdGl2ZTogcGFnZSAke3BhZ2VJZH0gbm90IGZvdW5kLiBgICtcbiAgICAgICAgYEF2YWlsYWJsZSBwYWdlIElEczogWyR7YXZhaWxhYmxlLmpvaW4oXCIsIFwiKX1dLiBgICtcbiAgICAgICAgYFJlZ2lzdHJ5IHNpemU6ICR7cmVnaXN0cnkucGFnZXMubGVuZ3RofS5gXG4gICAgKTtcbiAgfVxuICByZWdpc3RyeS5hY3RpdmVQYWdlSWQgPSBwYWdlSWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RyeUdldEFjdGl2ZShyZWdpc3RyeTogUGFnZVJlZ2lzdHJ5KTogUGFnZUVudHJ5IHtcbiAgaWYgKHJlZ2lzdHJ5LmFjdGl2ZVBhZ2VJZCA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGByZWdpc3RyeUdldEFjdGl2ZTogbm8gYWN0aXZlIHBhZ2UuIGAgK1xuICAgICAgICBgUmVnaXN0cnkgY29udGFpbnMgJHtyZWdpc3RyeS5wYWdlcy5sZW5ndGh9IHBhZ2UocykuIGAgK1xuICAgICAgICBgUGFnZSBJRHM6IFske3JlZ2lzdHJ5LnBhZ2VzLm1hcCgocCkgPT4gcC5pZCkuam9pbihcIiwgXCIpfV0uYFxuICAgICk7XG4gIH1cbiAgY29uc3QgZW50cnkgPSByZWdpc3RyeS5wYWdlcy5maW5kKChwKSA9PiBwLmlkID09PSByZWdpc3RyeS5hY3RpdmVQYWdlSWQpO1xuICBpZiAoIWVudHJ5KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYHJlZ2lzdHJ5R2V0QWN0aXZlOiBhY3RpdmVQYWdlSWQgJHtyZWdpc3RyeS5hY3RpdmVQYWdlSWR9IG5vdCBmb3VuZCBpbiByZWdpc3RyeS4gYCArXG4gICAgICAgIGBBdmFpbGFibGUgcGFnZSBJRHM6IFske3JlZ2lzdHJ5LnBhZ2VzLm1hcCgocCkgPT4gcC5pZCkuam9pbihcIiwgXCIpfV0uIGAgK1xuICAgICAgICBgUmVnaXN0cnkgc2l6ZTogJHtyZWdpc3RyeS5wYWdlcy5sZW5ndGh9LiBUaGlzIGluZGljYXRlcyBzdGFsZSBzdGF0ZS5gXG4gICAgKTtcbiAgfVxuICByZXR1cm4gZW50cnk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RyeUdldFBhZ2UocmVnaXN0cnk6IFBhZ2VSZWdpc3RyeSwgcGFnZUlkOiBudW1iZXIpOiBQYWdlRW50cnkgfCBudWxsIHtcbiAgcmV0dXJuIHJlZ2lzdHJ5LnBhZ2VzLmZpbmQoKHApID0+IHAuaWQgPT09IHBhZ2VJZCkgPz8gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdHJ5TGlzdFBhZ2VzKHJlZ2lzdHJ5OiBQYWdlUmVnaXN0cnkpOiBQYWdlTGlzdEVudHJ5W10ge1xuICByZXR1cm4gcmVnaXN0cnkucGFnZXMubWFwKChlbnRyeSkgPT4gKHtcbiAgICBpZDogZW50cnkuaWQsXG4gICAgdGl0bGU6IGVudHJ5LnRpdGxlLFxuICAgIHVybDogZW50cnkudXJsLFxuICAgIG9wZW5lcjogZW50cnkub3BlbmVyLFxuICAgIGlzQWN0aXZlOiBlbnRyeS5pZCA9PT0gcmVnaXN0cnkuYWN0aXZlUGFnZUlkLFxuICB9KSk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRklGTyBCb3VuZGVkIExvZyBQdXNoZXJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlQm91bmRlZExvZ1B1c2hlcihtYXhTaXplOiBudW1iZXIpOiAoYXJyYXk6IHVua25vd25bXSwgZW50cnk6IHVua25vd24pID0+IHZvaWQge1xuICByZXR1cm4gZnVuY3Rpb24gcHVzaChhcnJheTogdW5rbm93bltdLCBlbnRyeTogdW5rbm93bik6IHZvaWQge1xuICAgIGFycmF5LnB1c2goZW50cnkpO1xuICAgIGlmIChhcnJheS5sZW5ndGggPiBtYXhTaXplKSB7XG4gICAgICBhcnJheS5zcGxpY2UoMCwgYXJyYXkubGVuZ3RoIC0gbWF4U2l6ZSk7XG4gICAgfVxuICB9O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuQmF0Y2hTdGVwcyh7IHN0ZXBzLCBleGVjdXRlU3RlcCwgc3RvcE9uRmFpbHVyZSA9IHRydWUgfToge1xuICBzdGVwczogdW5rbm93bltdO1xuICBleGVjdXRlU3RlcDogKHN0ZXA6IHVua25vd24sIGluZGV4OiBudW1iZXIpID0+IFByb21pc2U8eyBvazogYm9vbGVhbjsgW2tleTogc3RyaW5nXTogdW5rbm93biB9PjtcbiAgc3RvcE9uRmFpbHVyZT86IGJvb2xlYW47XG59KTogUHJvbWlzZTxCYXRjaFN0ZXBSZXN1bHQ+IHtcbiAgY29uc3QgcmVzdWx0czogdW5rbm93bltdID0gW107XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgc3RlcHMubGVuZ3RoOyBpICs9IDEpIHtcbiAgICBjb25zdCBzdGVwID0gc3RlcHNbaV0gYXMgeyBhY3Rpb246IHN0cmluZyB9O1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dGVTdGVwKHN0ZXAsIGkpO1xuICAgIHJlc3VsdHMucHVzaChyZXN1bHQpO1xuICAgIGlmIChyZXN1bHQub2sgPT09IGZhbHNlICYmIHN0b3BPbkZhaWx1cmUpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgc3RvcFJlYXNvbjogXCJzdGVwX2ZhaWxlZFwiLFxuICAgICAgICBmYWlsZWRTdGVwSW5kZXg6IGksXG4gICAgICAgIHN0ZXBSZXN1bHRzOiByZXN1bHRzLFxuICAgICAgICBzdW1tYXJ5OiBgU3RvcHBlZCBhdCBzdGVwICR7aSArIDF9ICgke3N0ZXAuYWN0aW9ufSlgLFxuICAgICAgfTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBvazogdHJ1ZSxcbiAgICBzdG9wUmVhc29uOiBudWxsLFxuICAgIGZhaWxlZFN0ZXBJbmRleDogbnVsbCxcbiAgICBzdGVwUmVzdWx0czogcmVzdWx0cyxcbiAgICBzdW1tYXJ5OiBgQ29tcGxldGVkICR7cmVzdWx0cy5sZW5ndGh9IHN0ZXAocylgLFxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFNuYXBzaG90IE1vZGVzIFx1MjAxNCBzZW1hbnRpYyBlbGVtZW50IGZpbHRlcmluZyBmb3IgYnJvd3Nlcl9zbmFwc2hvdF9yZWZzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGNvbnN0IFNOQVBTSE9UX01PREVTOiBSZWNvcmQ8c3RyaW5nLCBTbmFwc2hvdE1vZGVDb25maWc+ID0ge1xuICBpbnRlcmFjdGl2ZToge1xuICAgIHRhZ3M6IFtdLFxuICAgIHJvbGVzOiBbXSxcbiAgICBzZWxlY3RvcnM6IFtdLFxuICAgIGFyaWFBdHRyaWJ1dGVzOiBbXSxcbiAgICB1c2VJbnRlcmFjdGl2ZUZpbHRlcjogdHJ1ZSxcbiAgfSxcbiAgZm9ybToge1xuICAgIHRhZ3M6IFtcImlucHV0XCIsIFwic2VsZWN0XCIsIFwidGV4dGFyZWFcIiwgXCJidXR0b25cIiwgXCJmaWVsZHNldFwiLCBcImxhYmVsXCIsIFwib3V0cHV0XCIsIFwiZGF0YWxpc3RcIl0sXG4gICAgcm9sZXM6IFtcInRleHRib3hcIiwgXCJzZWFyY2hib3hcIiwgXCJjb21ib2JveFwiLCBcImNoZWNrYm94XCIsIFwicmFkaW9cIiwgXCJzd2l0Y2hcIiwgXCJzbGlkZXJcIiwgXCJzcGluYnV0dG9uXCIsIFwibGlzdGJveFwiLCBcIm9wdGlvblwiXSxcbiAgICBzZWxlY3RvcnM6IFtcIltjb250ZW50ZWRpdGFibGVdXCJdLFxuICAgIGFyaWFBdHRyaWJ1dGVzOiBbXSxcbiAgICB1c2VJbnRlcmFjdGl2ZUZpbHRlcjogZmFsc2UsXG4gIH0sXG4gIGRpYWxvZzoge1xuICAgIHRhZ3M6IFtcImRpYWxvZ1wiXSxcbiAgICByb2xlczogW1wiZGlhbG9nXCIsIFwiYWxlcnRkaWFsb2dcIl0sXG4gICAgc2VsZWN0b3JzOiBbJ1tyb2xlPVwiZGlhbG9nXCJdJywgJ1tyb2xlPVwiYWxlcnRkaWFsb2dcIl0nXSxcbiAgICBhcmlhQXR0cmlidXRlczogW10sXG4gICAgdXNlSW50ZXJhY3RpdmVGaWx0ZXI6IGZhbHNlLFxuICAgIGNvbnRhaW5lckV4cGFuZDogdHJ1ZSxcbiAgfSxcbiAgbmF2aWdhdGlvbjoge1xuICAgIHRhZ3M6IFtcImFcIiwgXCJuYXZcIl0sXG4gICAgcm9sZXM6IFtcImxpbmtcIiwgXCJuYXZpZ2F0aW9uXCIsIFwibWVudWJhclwiLCBcIm1lbnVcIiwgXCJtZW51aXRlbVwiXSxcbiAgICBzZWxlY3RvcnM6IFtdLFxuICAgIGFyaWFBdHRyaWJ1dGVzOiBbXSxcbiAgICB1c2VJbnRlcmFjdGl2ZUZpbHRlcjogZmFsc2UsXG4gIH0sXG4gIGVycm9yczoge1xuICAgIHRhZ3M6IFtdLFxuICAgIHJvbGVzOiBbXCJhbGVydFwiLCBcInN0YXR1c1wiXSxcbiAgICBzZWxlY3RvcnM6IFsnW2FyaWEtaW52YWxpZD1cInRydWVcIl0nLCAnW3JvbGU9XCJhbGVydFwiXScsICdbcm9sZT1cInN0YXR1c1wiXSddLFxuICAgIGFyaWFBdHRyaWJ1dGVzOiBbXCJhcmlhLWludmFsaWRcIiwgXCJhcmlhLWVycm9ybWVzc2FnZVwiXSxcbiAgICB1c2VJbnRlcmFjdGl2ZUZpbHRlcjogZmFsc2UsXG4gICAgY29udGFpbmVyRXhwYW5kOiB0cnVlLFxuICB9LFxuICBoZWFkaW5nczoge1xuICAgIHRhZ3M6IFtcImgxXCIsIFwiaDJcIiwgXCJoM1wiLCBcImg0XCIsIFwiaDVcIiwgXCJoNlwiXSxcbiAgICByb2xlczogW1wiaGVhZGluZ1wiXSxcbiAgICBzZWxlY3RvcnM6IFtdLFxuICAgIGFyaWFBdHRyaWJ1dGVzOiBbXSxcbiAgICB1c2VJbnRlcmFjdGl2ZUZpbHRlcjogZmFsc2UsXG4gIH0sXG4gIHZpc2libGVfb25seToge1xuICAgIHRhZ3M6IFtdLFxuICAgIHJvbGVzOiBbXSxcbiAgICBzZWxlY3RvcnM6IFtdLFxuICAgIGFyaWFBdHRyaWJ1dGVzOiBbXSxcbiAgICB1c2VJbnRlcmFjdGl2ZUZpbHRlcjogZmFsc2UsXG4gICAgdmlzaWJsZU9ubHk6IHRydWUsXG4gIH0sXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gZ2V0U25hcHNob3RNb2RlQ29uZmlnKG1vZGU6IHN0cmluZyk6IFNuYXBzaG90TW9kZUNvbmZpZyB8IG51bGwge1xuICByZXR1cm4gU05BUFNIT1RfTU9ERVNbbW9kZV0gPz8gbnVsbDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBGaW5nZXJwcmludCBmdW5jdGlvbnMgXHUyMDE0IHN0cnVjdHVyYWwgaWRlbnRpdHkgZm9yIHJlZiByZXNvbHV0aW9uXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGZ1bmN0aW9uIGNvbXB1dGVDb250ZW50SGFzaCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIXRleHQpIHJldHVybiBcIjBcIjtcbiAgbGV0IGggPSA1MzgxO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHRleHQubGVuZ3RoOyBpKyspIHtcbiAgICBoID0gKChoIDw8IDUpIC0gaCArIHRleHQuY2hhckNvZGVBdChpKSkgfCAwO1xuICB9XG4gIHJldHVybiAoaCA+Pj4gMCkudG9TdHJpbmcoMTYpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY29tcHV0ZVN0cnVjdHVyYWxTaWduYXR1cmUodGFnOiBzdHJpbmcsIHJvbGU6IHN0cmluZywgY2hpbGRUYWdzOiBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIGNvbnN0IGlucHV0ID0gYCR7dGFnfXwke3JvbGV9fCR7Y2hpbGRUYWdzLmpvaW4oXCIsXCIpfWA7XG4gIGxldCBoID0gNTM4MTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBpbnB1dC5sZW5ndGg7IGkrKykge1xuICAgIGggPSAoKGggPDwgNSkgLSBoICsgaW5wdXQuY2hhckNvZGVBdChpKSkgfCAwO1xuICB9XG4gIHJldHVybiAoaCA+Pj4gMCkudG9TdHJpbmcoMTYpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF0Y2hGaW5nZXJwcmludChcbiAgc3RvcmVkOiB7IGNvbnRlbnRIYXNoPzogc3RyaW5nOyBzdHJ1Y3R1cmFsU2lnbmF0dXJlPzogc3RyaW5nIH0sXG4gIGNhbmRpZGF0ZTogeyBjb250ZW50SGFzaD86IHN0cmluZzsgc3RydWN0dXJhbFNpZ25hdHVyZT86IHN0cmluZyB9LFxuKTogYm9vbGVhbiB7XG4gIGlmICghc3RvcmVkIHx8ICFjYW5kaWRhdGUpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFzdG9yZWQuY29udGVudEhhc2ggfHwgIXN0b3JlZC5zdHJ1Y3R1cmFsU2lnbmF0dXJlKSByZXR1cm4gZmFsc2U7XG4gIGlmICghY2FuZGlkYXRlLmNvbnRlbnRIYXNoIHx8ICFjYW5kaWRhdGUuc3RydWN0dXJhbFNpZ25hdHVyZSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gc3RvcmVkLmNvbnRlbnRIYXNoID09PSBjYW5kaWRhdGUuY29udGVudEhhc2ggJiZcbiAgICBzdG9yZWQuc3RydWN0dXJhbFNpZ25hdHVyZSA9PT0gY2FuZGlkYXRlLnN0cnVjdHVyYWxTaWduYXR1cmU7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVGltZWxpbmUgRm9ybWF0dGluZ1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIGZvcm1hdER1cmF0aW9uTXMoZW50cnk6IHsgc3RhcnRlZEF0PzogbnVtYmVyOyBmaW5pc2hlZEF0PzogbnVtYmVyIHwgbnVsbCB9KTogbnVtYmVyIHwgbnVsbCB7XG4gIGNvbnN0IHN0YXJ0ZWRBdCA9IHR5cGVvZiBlbnRyeT8uc3RhcnRlZEF0ID09PSBcIm51bWJlclwiID8gZW50cnkuc3RhcnRlZEF0IDogbnVsbDtcbiAgY29uc3QgZmluaXNoZWRBdCA9IHR5cGVvZiBlbnRyeT8uZmluaXNoZWRBdCA9PT0gXCJudW1iZXJcIiA/IGVudHJ5LmZpbmlzaGVkQXQgOiBudWxsO1xuICBpZiAoc3RhcnRlZEF0ID09IG51bGwgfHwgZmluaXNoZWRBdCA9PSBudWxsIHx8IGZpbmlzaGVkQXQgPCBzdGFydGVkQXQpIHJldHVybiBudWxsO1xuICByZXR1cm4gZmluaXNoZWRBdCAtIHN0YXJ0ZWRBdDtcbn1cblxuZnVuY3Rpb24gc3VtbWFyaXplQWN0aW9uU3RhdHVzKHN0YXR1czogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcbiAgaWYgKHN0YXR1cyA9PT0gXCJlcnJvclwiKSByZXR1cm4gXCJlcnJvclwiO1xuICBpZiAoc3RhdHVzID09PSBcInJ1bm5pbmdcIikgcmV0dXJuIFwicnVubmluZ1wiO1xuICByZXR1cm4gXCJzdWNjZXNzXCI7XG59XG5cbmZ1bmN0aW9uIGxvb2tzQm91bmRlZFdhcm5pbmcodmFsdWU6IHVua25vd24pOiBib29sZWFuIHtcbiAgcmV0dXJuIC9ib3VuZGVkIC4qaGlzdG9yeS9pLnRlc3QoU3RyaW5nKHZhbHVlID8/IFwiXCIpKTtcbn1cblxuZnVuY3Rpb24gdW5pcXVlU3RyaW5ncyh2YWx1ZXM6IChzdHJpbmcgfCB1bmRlZmluZWQpW10pOiBzdHJpbmdbXSB7XG4gIHJldHVybiBbLi4ubmV3IFNldCh2YWx1ZXMuZmlsdGVyKEJvb2xlYW4pKV0gYXMgc3RyaW5nW107XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXRUaW1lbGluZUVudHJpZXMoZW50cmllczogQWN0aW9uRW50cnlbXSA9IFtdLCBvcHRpb25zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9KTogRm9ybWF0dGVkVGltZWxpbmUge1xuICBjb25zdCByZXRhaW5lZCA9IChvcHRpb25zLnJldGFpbmVkIGFzIG51bWJlcikgPz8gZW50cmllcy5sZW5ndGg7XG4gIGNvbnN0IHRvdGFsUmVjb3JkZWQgPSAob3B0aW9ucy50b3RhbFJlY29yZGVkIGFzIG51bWJlcikgPz8gcmV0YWluZWQ7XG4gIGNvbnN0IGJvdW5kZWQgPSB0b3RhbFJlY29yZGVkID4gcmV0YWluZWQ7XG5cbiAgaWYgKCFlbnRyaWVzLmxlbmd0aCkge1xuICAgIHJldHVybiB7XG4gICAgICBlbnRyaWVzOiBbXSxcbiAgICAgIHJldGFpbmVkLFxuICAgICAgdG90YWxSZWNvcmRlZCxcbiAgICAgIGJvdW5kZWQsXG4gICAgICBzdW1tYXJ5OiBcIk5vIGJyb3dzZXIgYWN0aW9ucyByZWNvcmRlZC5cIixcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgZm9ybWF0dGVkRW50cmllcyA9IGVudHJpZXMubWFwKChlbnRyeSkgPT4ge1xuICAgIGNvbnN0IHN0YXR1cyA9IHN1bW1hcml6ZUFjdGlvblN0YXR1cyhlbnRyeS5zdGF0dXMpO1xuICAgIGNvbnN0IGR1cmF0aW9uTXMgPSBmb3JtYXREdXJhdGlvbk1zKGVudHJ5KTtcbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXG4gICAgICBgIyR7ZW50cnkuaWQgPz8gXCI/XCJ9YCxcbiAgICAgIGVudHJ5LnRvb2wgPz8gXCJ1bmtub3duX3Rvb2xcIixcbiAgICAgIHN0YXR1cyxcbiAgICBdO1xuXG4gICAgaWYgKGR1cmF0aW9uTXMgIT0gbnVsbCkgcGFydHMucHVzaChgJHtkdXJhdGlvbk1zfW1zYCk7XG4gICAgaWYgKGVudHJ5LnBhcmFtc1N1bW1hcnkpIHBhcnRzLnB1c2goZW50cnkucGFyYW1zU3VtbWFyeSk7XG4gICAgaWYgKGVudHJ5LmVycm9yKSBwYXJ0cy5wdXNoKGVudHJ5LmVycm9yKTtcbiAgICBpZiAoZW50cnkudmVyaWZpY2F0aW9uU3VtbWFyeSkgcGFydHMucHVzaChlbnRyeS52ZXJpZmljYXRpb25TdW1tYXJ5KTtcbiAgICBpZiAoZW50cnkuZGlmZlN1bW1hcnkpIHBhcnRzLnB1c2goZW50cnkuZGlmZlN1bW1hcnkpO1xuICAgIGlmIChlbnRyeS53YXJuaW5nU3VtbWFyeSkgcGFydHMucHVzaChlbnRyeS53YXJuaW5nU3VtbWFyeSk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgaWQ6IGVudHJ5LmlkID8/IG51bGwsXG4gICAgICB0b29sOiBlbnRyeS50b29sID8/IFwiXCIsXG4gICAgICBzdGF0dXMsXG4gICAgICBkdXJhdGlvbk1zLFxuICAgICAgYmVmb3JlVXJsOiBlbnRyeS5iZWZvcmVVcmwgPz8gXCJcIixcbiAgICAgIGFmdGVyVXJsOiBlbnRyeS5hZnRlclVybCA/PyBcIlwiLFxuICAgICAgbGluZTogcGFydHMuam9pbihcIiB8IFwiKSxcbiAgICB9O1xuICB9KTtcblxuICBjb25zdCBzdW1tYXJ5ID0gYm91bmRlZFxuICAgID8gYFRpbWVsaW5lOiBzaG93aW5nICR7cmV0YWluZWR9IG9mICR7dG90YWxSZWNvcmRlZH0gcmVjb3JkZWQgYnJvd3NlciBhY3Rpb25zOyBvbGRlciBhY3Rpb25zIHdlcmUgZGlzY2FyZGVkIGR1ZSB0byBib3VuZGVkIGhpc3RvcnkuYFxuICAgIDogYFRpbWVsaW5lOiAke3JldGFpbmVkfSBicm93c2VyIGFjdGlvbiR7cmV0YWluZWQgPT09IDEgPyBcIlwiIDogXCJzXCJ9IHJlY29yZGVkLmA7XG5cbiAgcmV0dXJuIHtcbiAgICBlbnRyaWVzOiBmb3JtYXR0ZWRFbnRyaWVzLFxuICAgIHJldGFpbmVkLFxuICAgIHRvdGFsUmVjb3JkZWQsXG4gICAgYm91bmRlZCxcbiAgICBzdW1tYXJ5LFxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEZhaWx1cmUgSHlwb3RoZXNpc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEZhaWx1cmVIeXBvdGhlc2lzKHNlc3Npb246IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7fSk6IEZhaWx1cmVIeXBvdGhlc2lzIHtcbiAgY29uc3QgdGltZWxpbmVFbnRyaWVzID0gc2Vzc2lvbi5hY3Rpb25UaW1lbGluZT8uZW50cmllcyA/PyBbXTtcbiAgY29uc3QgY29uc29sZUVudHJpZXMgPSBzZXNzaW9uLmNvbnNvbGVFbnRyaWVzID8/IFtdO1xuICBjb25zdCBuZXR3b3JrRW50cmllcyA9IHNlc3Npb24ubmV0d29ya0VudHJpZXMgPz8gW107XG4gIGNvbnN0IGRpYWxvZ0VudHJpZXMgPSBzZXNzaW9uLmRpYWxvZ0VudHJpZXMgPz8gW107XG4gIGNvbnN0IHNpZ25hbHM6IEFycmF5PHsgY2F0ZWdvcnk6IHN0cmluZzsgc291cmNlOiBzdHJpbmc7IGRldGFpbDogc3RyaW5nIH0+ID0gW107XG5cbiAgZm9yIChjb25zdCBlbnRyeSBvZiB0aW1lbGluZUVudHJpZXMpIHtcbiAgICBpZiAoZW50cnk/LnN0YXR1cyAhPT0gXCJlcnJvclwiKSBjb250aW51ZTtcbiAgICBpZiAoZW50cnkudG9vbCA9PT0gXCJicm93c2VyX3dhaXRfZm9yXCIpIHtcbiAgICAgIHNpZ25hbHMucHVzaCh7XG4gICAgICAgIGNhdGVnb3J5OiBcIndhaXRcIixcbiAgICAgICAgc291cmNlOiBgYWN0aW9uIyR7ZW50cnkuaWQgPz8gXCI/XCJ9YCxcbiAgICAgICAgZGV0YWlsOiBlbnRyeS5lcnJvciB8fCBlbnRyeS53YXJuaW5nU3VtbWFyeSB8fCBcIldhaXQgY29uZGl0aW9uIGZhaWxlZFwiLFxuICAgICAgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGVudHJ5LnRvb2wgPT09IFwiYnJvd3Nlcl9hc3NlcnRcIikge1xuICAgICAgc2lnbmFscy5wdXNoKHtcbiAgICAgICAgY2F0ZWdvcnk6IFwiYXNzZXJ0XCIsXG4gICAgICAgIHNvdXJjZTogYGFjdGlvbiMke2VudHJ5LmlkID8/IFwiP1wifWAsXG4gICAgICAgIGRldGFpbDogZW50cnkuZXJyb3IgfHwgZW50cnkudmVyaWZpY2F0aW9uU3VtbWFyeSB8fCBcIkFzc2VydGlvbiBmYWlsZWRcIixcbiAgICAgIH0pO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHNpZ25hbHMucHVzaCh7XG4gICAgICBjYXRlZ29yeTogXCJhY3Rpb25cIixcbiAgICAgIHNvdXJjZTogYGFjdGlvbiMke2VudHJ5LmlkID8/IFwiP1wifWAsXG4gICAgICBkZXRhaWw6IGVudHJ5LmVycm9yIHx8IGAke2VudHJ5LnRvb2wgPz8gXCJicm93c2VyIGFjdGlvblwifSBmYWlsZWRgLFxuICAgIH0pO1xuICB9XG5cbiAgZm9yIChjb25zdCBlbnRyeSBvZiBjb25zb2xlRW50cmllcykge1xuICAgIGlmIChlbnRyeT8udHlwZSAhPT0gXCJlcnJvclwiICYmIGVudHJ5Py50eXBlICE9PSBcInBhZ2VlcnJvclwiKSBjb250aW51ZTtcbiAgICBzaWduYWxzLnB1c2goe1xuICAgICAgY2F0ZWdvcnk6IFwiY29uc29sZVwiLFxuICAgICAgc291cmNlOiBlbnRyeS50eXBlISxcbiAgICAgIGRldGFpbDogZW50cnkudGV4dCB8fCBcIkNvbnNvbGUgZXJyb3IgcmVjb3JkZWRcIixcbiAgICB9KTtcbiAgfVxuXG4gIGZvciAoY29uc3QgZW50cnkgb2YgbmV0d29ya0VudHJpZXMpIHtcbiAgICBjb25zdCBmYWlsZWQgPSBlbnRyeT8uZmFpbGVkIHx8ICh0eXBlb2YgZW50cnk/LnN0YXR1cyA9PT0gXCJudW1iZXJcIiAmJiBlbnRyeS5zdGF0dXMgPj0gNDAwKTtcbiAgICBpZiAoIWZhaWxlZCkgY29udGludWU7XG4gICAgc2lnbmFscy5wdXNoKHtcbiAgICAgIGNhdGVnb3J5OiBcIm5ldHdvcmtcIixcbiAgICAgIHNvdXJjZTogZW50cnkudXJsIHx8IFwibmV0d29yayByZXF1ZXN0XCIsXG4gICAgICBkZXRhaWw6IGAke2VudHJ5LnVybCB8fCBcInJlcXVlc3RcIn0gZmFpbGVkJHt0eXBlb2YgZW50cnk/LnN0YXR1cyA9PT0gXCJudW1iZXJcIiA/IGAgd2l0aCAke2VudHJ5LnN0YXR1c31gIDogXCJcIn1gLFxuICAgIH0pO1xuICB9XG5cbiAgZm9yIChjb25zdCBlbnRyeSBvZiBkaWFsb2dFbnRyaWVzKSB7XG4gICAgc2lnbmFscy5wdXNoKHtcbiAgICAgIGNhdGVnb3J5OiBcImRpYWxvZ1wiLFxuICAgICAgc291cmNlOiBlbnRyeT8udHlwZSB8fCBcImRpYWxvZ1wiLFxuICAgICAgZGV0YWlsOiBlbnRyeT8ubWVzc2FnZSB8fCBcIkRpYWxvZyBhcHBlYXJlZCBkdXJpbmcgZmFpbHVyZSBpbnZlc3RpZ2F0aW9uXCIsXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCBjYXRlZ29yaWVzID0gdW5pcXVlU3RyaW5ncyhzaWduYWxzLm1hcCgoc2lnbmFsKSA9PiBzaWduYWwuY2F0ZWdvcnkpKTtcbiAgY29uc3QgaGFzRmFpbHVyZXMgPSBjYXRlZ29yaWVzLmxlbmd0aCA+IDA7XG4gIGNvbnN0IHN1bW1hcnkgPSBoYXNGYWlsdXJlc1xuICAgID8gYFJlY2VudCBmYWlsdXJlIHNpZ25hbHMgZGV0ZWN0ZWQgYWNyb3NzICR7Y2F0ZWdvcmllcy5qb2luKFwiLCBcIil9LmBcbiAgICA6IFwiTm8gcmVjZW50IGZhaWx1cmUgc2lnbmFscyBkZXRlY3RlZC5cIjtcblxuICByZXR1cm4ge1xuICAgIGhhc0ZhaWx1cmVzLFxuICAgIGNhdGVnb3JpZXMsXG4gICAgc3VtbWFyeSxcbiAgICBzaWduYWxzLFxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFNlc3Npb24gU3VtbWFyeVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBmdW5jdGlvbiBzdW1tYXJpemVCcm93c2VyU2Vzc2lvbihzZXNzaW9uOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge30pOiBTZXNzaW9uU3VtbWFyeSB7XG4gIGNvbnN0IGFjdGlvblRpbWVsaW5lID0gc2Vzc2lvbi5hY3Rpb25UaW1lbGluZSA/PyB7IGxpbWl0OiAwLCBlbnRyaWVzOiBbXSBhcyBBY3Rpb25FbnRyeVtdIH07XG4gIGNvbnN0IGFjdGlvbkVudHJpZXM6IEFjdGlvbkVudHJ5W10gPSBhY3Rpb25UaW1lbGluZS5lbnRyaWVzID8/IFtdO1xuICBjb25zdCByZXRhaW5lZEFjdGlvbkNvdW50OiBudW1iZXIgPSBzZXNzaW9uLnJldGFpbmVkQWN0aW9uQ291bnQgPz8gYWN0aW9uRW50cmllcy5sZW5ndGg7XG4gIGNvbnN0IHRvdGFsQWN0aW9uQ291bnQ6IG51bWJlciA9IHNlc3Npb24udG90YWxBY3Rpb25Db3VudCA/PyByZXRhaW5lZEFjdGlvbkNvdW50O1xuICBjb25zdCBwYWdlczogQXJyYXk8UmVjb3JkPHN0cmluZywgYW55Pj4gPSBzZXNzaW9uLnBhZ2VzID8/IFtdO1xuICBjb25zdCBjb25zb2xlRW50cmllczogQXJyYXk8UmVjb3JkPHN0cmluZywgYW55Pj4gPSBzZXNzaW9uLmNvbnNvbGVFbnRyaWVzID8/IFtdO1xuICBjb25zdCBuZXR3b3JrRW50cmllczogQXJyYXk8UmVjb3JkPHN0cmluZywgYW55Pj4gPSBzZXNzaW9uLm5ldHdvcmtFbnRyaWVzID8/IFtdO1xuICBjb25zdCBkaWFsb2dFbnRyaWVzOiBBcnJheTxSZWNvcmQ8c3RyaW5nLCBhbnk+PiA9IHNlc3Npb24uZGlhbG9nRW50cmllcyA/PyBbXTtcblxuICBjb25zdCBhY3Rpb25TdGF0dXNDb3VudHMgPSBhY3Rpb25FbnRyaWVzLnJlZHVjZShcbiAgICAoYWNjOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+LCBlbnRyeTogQWN0aW9uRW50cnkpID0+IHtcbiAgICAgIGNvbnN0IHN0YXR1cyA9IHN1bW1hcml6ZUFjdGlvblN0YXR1cyhlbnRyeS5zdGF0dXMpO1xuICAgICAgYWNjW3N0YXR1c10gPSAoYWNjW3N0YXR1c10gPz8gMCkgKyAxO1xuICAgICAgcmV0dXJuIGFjYztcbiAgICB9LFxuICAgIHsgc3VjY2VzczogMCwgZXJyb3I6IDAsIHJ1bm5pbmc6IDAgfSxcbiAgKTtcblxuICBjb25zdCB3YWl0RW50cmllcyA9IGFjdGlvbkVudHJpZXMuZmlsdGVyKChlbnRyeTogQWN0aW9uRW50cnkpID0+IGVudHJ5LnRvb2wgPT09IFwiYnJvd3Nlcl93YWl0X2ZvclwiKTtcbiAgY29uc3QgYXNzZXJ0RW50cmllcyA9IGFjdGlvbkVudHJpZXMuZmlsdGVyKChlbnRyeTogQWN0aW9uRW50cnkpID0+IGVudHJ5LnRvb2wgPT09IFwiYnJvd3Nlcl9hc3NlcnRcIik7XG4gIGNvbnN0IGNvbnNvbGVFcnJvcnMgPSBjb25zb2xlRW50cmllcy5maWx0ZXIoKGVudHJ5OiBSZWNvcmQ8c3RyaW5nLCBhbnk+KSA9PiBlbnRyeS50eXBlID09PSBcImVycm9yXCIgfHwgZW50cnkudHlwZSA9PT0gXCJwYWdlZXJyb3JcIik7XG4gIGNvbnN0IGZhaWxlZFJlcXVlc3RzID0gbmV0d29ya0VudHJpZXMuZmlsdGVyKChlbnRyeTogUmVjb3JkPHN0cmluZywgYW55PikgPT4gZW50cnkuZmFpbGVkIHx8ICh0eXBlb2YgZW50cnkuc3RhdHVzID09PSBcIm51bWJlclwiICYmIGVudHJ5LnN0YXR1cyA+PSA0MDApKTtcbiAgY29uc3QgYWN0aXZlUGFnZSA9IHBhZ2VzLmZpbmQoKHBhZ2U6IFJlY29yZDxzdHJpbmcsIGFueT4pID0+IHBhZ2UuaXNBY3RpdmUpID8/IHBhZ2VzWzBdID8/IG51bGw7XG5cbiAgY29uc3QgY2F2ZWF0czogc3RyaW5nW10gPSBbXTtcbiAgaWYgKHRvdGFsQWN0aW9uQ291bnQgPiByZXRhaW5lZEFjdGlvbkNvdW50KSB7XG4gICAgY2F2ZWF0cy5wdXNoKGBTaG93aW5nICR7cmV0YWluZWRBY3Rpb25Db3VudH0gb2YgJHt0b3RhbEFjdGlvbkNvdW50fSByZWNvcmRlZCBhY3Rpb25zOyBvbGRlciBhY3Rpb25zIHdlcmUgZGlzY2FyZGVkIGR1ZSB0byBib3VuZGVkIGhpc3RvcnkuYCk7XG4gIH1cbiAgaWYgKFxuICAgIGFjdGlvbkVudHJpZXMuc29tZSgoZW50cnkpID0+IGxvb2tzQm91bmRlZFdhcm5pbmcoZW50cnkud2FybmluZ1N1bW1hcnkpIHx8IGxvb2tzQm91bmRlZFdhcm5pbmcoZW50cnkuZXJyb3IpKSB8fFxuICAgIGNvbnNvbGVFbnRyaWVzLnNvbWUoKGVudHJ5KSA9PiBsb29rc0JvdW5kZWRXYXJuaW5nKGVudHJ5LnRleHQpIHx8IGxvb2tzQm91bmRlZFdhcm5pbmcoZW50cnkubWVzc2FnZSkpIHx8XG4gICAgY29uc29sZUVudHJpZXMubGVuZ3RoID4gMFxuICApIHtcbiAgICBjYXZlYXRzLnB1c2goXCJib3VuZGVkIGNvbnNvbGUgaGlzdG9yeSBtYXkgaGlkZSBvbGRlciBjb25zb2xlIGV2ZW50cy5cIik7XG4gIH1cbiAgaWYgKGZhaWxlZFJlcXVlc3RzLmxlbmd0aCA+IDAgfHwgbmV0d29ya0VudHJpZXMubGVuZ3RoID4gMCkge1xuICAgIGNhdmVhdHMucHVzaChcImJvdW5kZWQgbmV0d29yayBoaXN0b3J5IG1heSBoaWRlIG9sZGVyIHJlcXVlc3RzLlwiKTtcbiAgfVxuXG4gIGNvbnN0IGZhaWx1cmVIeXBvdGhlc2lzID0gYnVpbGRGYWlsdXJlSHlwb3RoZXNpcyhzZXNzaW9uKTtcblxuICBpZiAoIWFjdGlvbkVudHJpZXMubGVuZ3RoICYmIHBhZ2VzLmxlbmd0aCA9PT0gMCAmJiBjb25zb2xlRW50cmllcy5sZW5ndGggPT09IDAgJiYgbmV0d29ya0VudHJpZXMubGVuZ3RoID09PSAwICYmIGRpYWxvZ0VudHJpZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvdW50czoge1xuICAgICAgICBwYWdlczogMCxcbiAgICAgICAgYWN0aW9uczogeyB0b3RhbDogMCwgcmV0YWluZWQ6IDAsIHN1Y2Nlc3M6IDAsIGVycm9yOiAwLCBydW5uaW5nOiAwIH0sXG4gICAgICAgIHdhaXRzOiB7IHRvdGFsOiAwLCBzdWNjZXNzOiAwLCBlcnJvcjogMCwgcnVubmluZzogMCB9LFxuICAgICAgICBhc3NlcnRpb25zOiB7IHRvdGFsOiAwLCBwYXNzZWQ6IDAsIGZhaWxlZDogMCwgcnVubmluZzogMCB9LFxuICAgICAgICBjb25zb2xlRXJyb3JzOiAwLFxuICAgICAgICBmYWlsZWRSZXF1ZXN0czogMCxcbiAgICAgICAgZGlhbG9nczogMCxcbiAgICAgIH0sXG4gICAgICBhY3RpdmVQYWdlOiBudWxsLFxuICAgICAgY2F2ZWF0czogW10sXG4gICAgICBmYWlsdXJlSHlwb3RoZXNpcyxcbiAgICAgIHN1bW1hcnk6IFwiTm8gYnJvd3NlciBzZXNzaW9uIGFjdGl2aXR5IHJlY29yZGVkLlwiLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGNvdW50czoge1xuICAgICAgcGFnZXM6IHBhZ2VzLmxlbmd0aCxcbiAgICAgIGFjdGlvbnM6IHtcbiAgICAgICAgdG90YWw6IHRvdGFsQWN0aW9uQ291bnQsXG4gICAgICAgIHJldGFpbmVkOiByZXRhaW5lZEFjdGlvbkNvdW50LFxuICAgICAgICBzdWNjZXNzOiBhY3Rpb25TdGF0dXNDb3VudHMuc3VjY2VzcyxcbiAgICAgICAgZXJyb3I6IGFjdGlvblN0YXR1c0NvdW50cy5lcnJvcixcbiAgICAgICAgcnVubmluZzogYWN0aW9uU3RhdHVzQ291bnRzLnJ1bm5pbmcsXG4gICAgICB9LFxuICAgICAgd2FpdHM6IHtcbiAgICAgICAgdG90YWw6IHdhaXRFbnRyaWVzLmxlbmd0aCxcbiAgICAgICAgc3VjY2Vzczogd2FpdEVudHJpZXMuZmlsdGVyKChlbnRyeSkgPT4gc3VtbWFyaXplQWN0aW9uU3RhdHVzKGVudHJ5LnN0YXR1cykgPT09IFwic3VjY2Vzc1wiKS5sZW5ndGgsXG4gICAgICAgIGVycm9yOiB3YWl0RW50cmllcy5maWx0ZXIoKGVudHJ5KSA9PiBzdW1tYXJpemVBY3Rpb25TdGF0dXMoZW50cnkuc3RhdHVzKSA9PT0gXCJlcnJvclwiKS5sZW5ndGgsXG4gICAgICAgIHJ1bm5pbmc6IHdhaXRFbnRyaWVzLmZpbHRlcigoZW50cnkpID0+IHN1bW1hcml6ZUFjdGlvblN0YXR1cyhlbnRyeS5zdGF0dXMpID09PSBcInJ1bm5pbmdcIikubGVuZ3RoLFxuICAgICAgfSxcbiAgICAgIGFzc2VydGlvbnM6IHtcbiAgICAgICAgdG90YWw6IGFzc2VydEVudHJpZXMubGVuZ3RoLFxuICAgICAgICBwYXNzZWQ6IGFzc2VydEVudHJpZXMuZmlsdGVyKChlbnRyeSkgPT4gc3VtbWFyaXplQWN0aW9uU3RhdHVzKGVudHJ5LnN0YXR1cykgPT09IFwic3VjY2Vzc1wiKS5sZW5ndGgsXG4gICAgICAgIGZhaWxlZDogYXNzZXJ0RW50cmllcy5maWx0ZXIoKGVudHJ5KSA9PiBzdW1tYXJpemVBY3Rpb25TdGF0dXMoZW50cnkuc3RhdHVzKSA9PT0gXCJlcnJvclwiKS5sZW5ndGgsXG4gICAgICAgIHJ1bm5pbmc6IGFzc2VydEVudHJpZXMuZmlsdGVyKChlbnRyeSkgPT4gc3VtbWFyaXplQWN0aW9uU3RhdHVzKGVudHJ5LnN0YXR1cykgPT09IFwicnVubmluZ1wiKS5sZW5ndGgsXG4gICAgICB9LFxuICAgICAgY29uc29sZUVycm9yczogY29uc29sZUVycm9ycy5sZW5ndGgsXG4gICAgICBmYWlsZWRSZXF1ZXN0czogZmFpbGVkUmVxdWVzdHMubGVuZ3RoLFxuICAgICAgZGlhbG9nczogZGlhbG9nRW50cmllcy5sZW5ndGgsXG4gICAgfSxcbiAgICBhY3RpdmVQYWdlOiBhY3RpdmVQYWdlXG4gICAgICA/IHtcbiAgICAgICAgICBpZDogYWN0aXZlUGFnZS5pZCA/PyBudWxsLFxuICAgICAgICAgIHRpdGxlOiBhY3RpdmVQYWdlLnRpdGxlID8/IFwiXCIsXG4gICAgICAgICAgdXJsOiBhY3RpdmVQYWdlLnVybCA/PyBcIlwiLFxuICAgICAgICB9XG4gICAgICA6IG51bGwsXG4gICAgY2F2ZWF0cyxcbiAgICBmYWlsdXJlSHlwb3RoZXNpcyxcbiAgICBzdW1tYXJ5OiBgU2Vzc2lvbjogJHtwYWdlcy5sZW5ndGh9IHBhZ2Uke3BhZ2VzLmxlbmd0aCA9PT0gMSA/IFwiXCIgOiBcInNcIn0sICR7dG90YWxBY3Rpb25Db3VudH0gYWN0aW9ucywgJHt3YWl0RW50cmllcy5sZW5ndGh9IHdhaXQke3dhaXRFbnRyaWVzLmxlbmd0aCA9PT0gMSA/IFwiXCIgOiBcInNcIn0sICR7YXNzZXJ0RW50cmllcy5sZW5ndGh9IGFzc2VydCR7YXNzZXJ0RW50cmllcy5sZW5ndGggPT09IDEgPyBcIlwiIDogXCJzXCJ9LiR7Y2F2ZWF0cy5sZW5ndGggPyBgICR7Y2F2ZWF0cy5qb2luKFwiIFwiKX1gIDogXCJcIn1gLFxuICB9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBMEtPLFNBQVMscUJBQXFCLFFBQVEsSUFBb0I7QUFDL0QsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBLFFBQVE7QUFBQSxJQUNSLFNBQVMsQ0FBQztBQUFBLEVBQ1o7QUFDRjtBQUVPLFNBQVMsWUFBWSxVQUEwQixTQUFxQztBQUN6RixRQUFNLFFBQXFCO0FBQUEsSUFDekIsSUFBSSxTQUFTO0FBQUEsSUFDYixNQUFNLFFBQVE7QUFBQSxJQUNkLGVBQWUsUUFBUSxpQkFBaUI7QUFBQSxJQUN4QyxXQUFXLFFBQVEsYUFBYSxLQUFLLElBQUk7QUFBQSxJQUN6QyxZQUFZO0FBQUEsSUFDWixRQUFRO0FBQUEsSUFDUixXQUFXLFFBQVEsYUFBYTtBQUFBLElBQ2hDLFVBQVUsUUFBUSxZQUFZO0FBQUEsSUFDOUIscUJBQXFCLFFBQVE7QUFBQSxJQUM3QixnQkFBZ0IsUUFBUTtBQUFBLElBQ3hCLGFBQWEsUUFBUTtBQUFBLElBQ3JCLFNBQVMsUUFBUTtBQUFBLElBQ2pCLE9BQU8sUUFBUTtBQUFBLEVBQ2pCO0FBQ0EsV0FBUyxRQUFRLEtBQUssS0FBSztBQUMzQixNQUFJLFNBQVMsUUFBUSxTQUFTLFNBQVMsT0FBTztBQUM1QyxhQUFTLFFBQVEsT0FBTyxHQUFHLFNBQVMsUUFBUSxTQUFTLFNBQVMsS0FBSztBQUFBLEVBQ3JFO0FBQ0EsU0FBTztBQUNUO0FBRU8sU0FBUyxhQUFhLFVBQTBCLFVBQWtCLFVBQXlCLENBQUMsR0FBdUI7QUFDeEgsUUFBTSxRQUFRLFNBQVMsUUFBUSxLQUFLLENBQUMsU0FBUyxLQUFLLE9BQU8sUUFBUTtBQUNsRSxNQUFJLENBQUMsTUFBTyxRQUFPO0FBQ25CLFNB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
