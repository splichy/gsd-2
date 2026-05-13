import { Type } from "@sinclair/typebox";
import { StringEnum } from "@gsd/pi-ai";
import {
  diffCompactStates,
  evaluateAssertionChecks,
  findAction,
  runBatchSteps,
  validateWaitParams,
  createRegionStableScript,
  parseThreshold,
  includesNeedle
} from "../core.js";
import {
  getConsoleLogs,
  getCurrentRefMap,
  getLastActionBeforeState,
  getLastActionAfterState,
  setLastActionBeforeState,
  setLastActionAfterState,
  getActionTimeline
} from "../state.js";
function registerAssertionTools(pi, deps) {
  pi.registerTool({
    name: "browser_assert",
    label: "Browser Assert",
    description: "Run one or more explicit browser assertions and return structured PASS/FAIL results. Prefer this for verification instead of inferring success from prose summaries.",
    promptGuidelines: [
      "Prefer browser_assert for browser verification instead of inferring success from summaries.",
      "When finishing UI work, explicit browser assertions should usually be the final verification step.",
      "Use checks for URL, text, selector state, value, and browser diagnostics whenever those signals are available."
    ],
    parameters: Type.Object({
      checks: Type.Array(
        Type.Object({
          kind: Type.String({ description: "Assertion kind, e.g. url_contains, text_visible, selector_visible, value_equals, no_console_errors, no_failed_requests, request_url_seen, response_status, console_message_matches, network_count, console_count, no_console_errors_since, no_failed_requests_since" }),
          selector: Type.Optional(Type.String()),
          text: Type.Optional(Type.String()),
          value: Type.Optional(Type.String()),
          checked: Type.Optional(Type.Boolean()),
          sinceActionId: Type.Optional(Type.Number())
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        const state = await deps.collectAssertionState(p, params.checks, target);
        const result = evaluateAssertionChecks({ checks: params.checks, state });
        return {
          content: [{ type: "text", text: `Browser assert

${deps.formatAssertionText(result)}` }],
          details: { ...result, url: state.url, title: state.title },
          isError: !result.verified
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Browser assert failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_diff",
    label: "Browser Diff",
    description: "Report meaningful browser-state changes. By default compares the current page to the most recent tracked action state. Use this to understand what changed after a click, submit, or navigation.",
    promptGuidelines: [
      "Use browser_diff after ambiguous or high-impact actions when you need to know what changed.",
      "Prefer browser_diff over requesting a broad new page inspection when the question is change detection."
    ],
    parameters: Type.Object({
      sinceActionId: Type.Optional(Type.Number({ description: "Optional action id to diff against. Uses that action's stored after-state when available." }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        const current = await deps.captureCompactPageState(p, { includeBodyText: true, target });
        let baseline = null;
        if (params.sinceActionId) {
          const actionTimeline = getActionTimeline();
          const action = findAction(actionTimeline, params.sinceActionId);
          baseline = action?.afterState ?? null;
        }
        if (!baseline) {
          baseline = getLastActionAfterState() ?? getLastActionBeforeState();
        }
        if (!baseline) {
          return {
            content: [{ type: "text", text: "Browser diff unavailable: no prior tracked browser state exists yet." }],
            details: { changed: false, changes: [], summary: "No prior tracked state" },
            isError: true
          };
        }
        const diff = diffCompactStates(baseline, current);
        return {
          content: [{ type: "text", text: `Browser diff

${deps.formatDiffText(diff)}` }],
          details: diff
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Browser diff failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_batch",
    label: "Browser Batch",
    description: "Execute multiple explicit browser steps in one call. Prefer this for obvious action sequences like click \u2192 type \u2192 wait \u2192 assert to reduce round trips and token usage.",
    promptGuidelines: [
      "If the next 2-5 browser actions are obvious and low-risk, prefer browser_batch over multiple tiny browser calls.",
      "Use browser_batch for explicit sequences like click \u2192 type \u2192 submit \u2192 wait \u2192 assert.",
      "Keep browser_batch steps explicit; do not use it as a speculative planner."
    ],
    parameters: Type.Object({
      steps: Type.Array(
        Type.Object({
          action: StringEnum(["navigate", "click", "type", "key_press", "wait_for", "assert", "click_ref", "fill_ref"]),
          selector: Type.Optional(Type.String()),
          text: Type.Optional(Type.String()),
          url: Type.Optional(Type.String()),
          key: Type.Optional(Type.String()),
          condition: Type.Optional(Type.String()),
          value: Type.Optional(Type.String()),
          threshold: Type.Optional(Type.String()),
          timeout: Type.Optional(Type.Number()),
          clearFirst: Type.Optional(Type.Boolean()),
          submit: Type.Optional(Type.Boolean()),
          ref: Type.Optional(Type.String()),
          checks: Type.Optional(Type.Array(Type.Object({
            kind: Type.String({ description: "Assertion kind, e.g. url_contains, text_visible, selector_visible, value_equals, no_console_errors, no_failed_requests, request_url_seen, response_status, console_message_matches, network_count, console_count, no_console_errors_since, no_failed_requests_since" }),
            selector: Type.Optional(Type.String()),
            text: Type.Optional(Type.String()),
            value: Type.Optional(Type.String()),
            checked: Type.Optional(Type.Boolean()),
            sinceActionId: Type.Optional(Type.Number())
          })))
        })
      ),
      stopOnFailure: Type.Optional(Type.Boolean({ description: "Stop after the first failing step (default: true)." })),
      finalSummaryOnly: Type.Optional(Type.Boolean({ description: "Return only the compact final batch summary in content while keeping step results in details." }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let actionId = null;
      let beforeState = null;
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        beforeState = await deps.captureCompactPageState(p, { includeBodyText: true, target });
        actionId = deps.beginTrackedAction("browser_batch", params, beforeState.url).id;
        const executeStep = async (step, index) => {
          const stepTarget = deps.getActiveTarget();
          try {
            switch (step.action) {
              case "navigate": {
                await p.goto(step.url, { waitUntil: "domcontentloaded", timeout: 3e4 });
                await p.waitForLoadState("networkidle", { timeout: 5e3 }).catch(() => {
                });
                return { ok: true, action: step.action, url: p.url() };
              }
              case "click": {
                await stepTarget.locator(step.selector).first().click({ timeout: step.timeout ?? 8e3 });
                await deps.settleAfterActionAdaptive(p);
                return { ok: true, action: step.action, selector: step.selector, url: p.url() };
              }
              case "type": {
                if (step.clearFirst) {
                  await stepTarget.locator(step.selector).first().fill("");
                }
                await stepTarget.locator(step.selector).first().fill(step.text ?? "", { timeout: step.timeout ?? 8e3 });
                if (step.submit) await p.keyboard.press("Enter");
                await deps.settleAfterActionAdaptive(p);
                return { ok: true, action: step.action, selector: step.selector, text: step.text };
              }
              case "key_press": {
                await p.keyboard.press(step.key);
                await deps.settleAfterActionAdaptive(p, { checkFocusStability: true });
                return { ok: true, action: step.action, key: step.key };
              }
              case "wait_for": {
                const timeout = step.timeout ?? 1e4;
                const waitValidation = validateWaitParams({ condition: step.condition, value: step.value, threshold: step.threshold });
                if (waitValidation) throw new Error(waitValidation.error);
                if (step.condition === "selector_visible") await stepTarget.waitForSelector(step.value, { state: "visible", timeout });
                else if (step.condition === "selector_hidden") await stepTarget.waitForSelector(step.value, { state: "hidden", timeout });
                else if (step.condition === "url_contains") await p.waitForURL((url) => url.toString().includes(step.value), { timeout });
                else if (step.condition === "network_idle") await p.waitForLoadState("networkidle", { timeout });
                else if (step.condition === "delay") await new Promise((resolve) => setTimeout(resolve, parseInt(step.value ?? "1000", 10)));
                else if (step.condition === "text_visible") {
                  await stepTarget.waitForFunction(
                    (needle) => (document.body?.innerText ?? "").toLowerCase().includes(needle.toLowerCase()),
                    step.value,
                    { timeout }
                  );
                } else if (step.condition === "text_hidden") {
                  await stepTarget.waitForFunction(
                    (needle) => !(document.body?.innerText ?? "").toLowerCase().includes(needle.toLowerCase()),
                    step.value,
                    { timeout }
                  );
                } else if (step.condition === "request_completed") {
                  await deps.getActivePage().waitForResponse(
                    (resp) => resp.url().includes(step.value),
                    { timeout }
                  );
                } else if (step.condition === "console_message") {
                  const needle = step.value;
                  const startTime = Date.now();
                  let found = false;
                  while (Date.now() - startTime < timeout) {
                    if (getConsoleLogs().find((entry) => includesNeedle(entry.text, needle))) {
                      found = true;
                      break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                  if (!found) throw new Error(`Timed out waiting for console message matching "${needle}" (${timeout}ms)`);
                } else if (step.condition === "element_count") {
                  const threshold = parseThreshold(step.threshold ?? ">=1");
                  if (!threshold) throw new Error(`element_count threshold is malformed: "${step.threshold}"`);
                  const selector = step.value;
                  const op = threshold.op;
                  const n = threshold.n;
                  await stepTarget.waitForFunction(
                    ({ selector: selector2, op: op2, n: n2 }) => {
                      const count = document.querySelectorAll(selector2).length;
                      switch (op2) {
                        case ">=":
                          return count >= n2;
                        case "<=":
                          return count <= n2;
                        case "==":
                          return count === n2;
                        case ">":
                          return count > n2;
                        case "<":
                          return count < n2;
                        default:
                          return false;
                      }
                    },
                    { selector, op, n },
                    { timeout }
                  );
                } else if (step.condition === "region_stable") {
                  const script = createRegionStableScript(step.value);
                  await stepTarget.waitForFunction(script, void 0, { timeout, polling: 200 });
                } else throw new Error(`Unsupported wait condition: ${step.condition}`);
                return { ok: true, action: step.action, condition: step.condition, value: step.value };
              }
              case "assert": {
                const state = await deps.collectAssertionState(p, step.checks ?? [], stepTarget);
                const assertion = evaluateAssertionChecks({ checks: step.checks ?? [], state });
                return { ok: assertion.verified, action: step.action, summary: assertion.summary, assertion };
              }
              case "click_ref": {
                const parsedRef = deps.parseRef(step.ref);
                const currentRefMap = getCurrentRefMap();
                const node = currentRefMap[parsedRef.key];
                if (!node) throw new Error(`Unknown ref: ${step.ref}`);
                const resolved = await deps.resolveRefTarget(stepTarget, node);
                if (!resolved.ok) throw new Error(resolved.reason);
                await stepTarget.locator(resolved.selector).first().click({ timeout: step.timeout ?? 8e3 });
                await deps.settleAfterActionAdaptive(p);
                return { ok: true, action: step.action, ref: step.ref };
              }
              case "fill_ref": {
                const parsedRef = deps.parseRef(step.ref);
                const currentRefMap = getCurrentRefMap();
                const node = currentRefMap[parsedRef.key];
                if (!node) throw new Error(`Unknown ref: ${step.ref}`);
                const resolved = await deps.resolveRefTarget(stepTarget, node);
                if (!resolved.ok) throw new Error(resolved.reason);
                if (step.clearFirst) await stepTarget.locator(resolved.selector).first().fill("");
                await stepTarget.locator(resolved.selector).first().fill(step.text ?? "", { timeout: step.timeout ?? 8e3 });
                if (step.submit) await p.keyboard.press("Enter");
                await deps.settleAfterActionAdaptive(p);
                return { ok: true, action: step.action, ref: step.ref, text: step.text };
              }
              default:
                throw new Error(`Unsupported batch action: ${step.action}`);
            }
          } catch (err) {
            return { ok: false, action: step.action, index, message: err.message };
          }
        };
        const run = await runBatchSteps({
          steps: params.steps,
          executeStep,
          stopOnFailure: params.stopOnFailure !== false
        });
        const batchEndTarget = deps.getActiveTarget();
        const afterState = await deps.captureCompactPageState(p, { includeBodyText: true, target: batchEndTarget });
        const diff = diffCompactStates(beforeState, afterState);
        setLastActionBeforeState(beforeState);
        setLastActionAfterState(afterState);
        deps.finishTrackedAction(actionId, {
          status: run.ok ? "success" : "error",
          afterUrl: afterState.url,
          diffSummary: diff.summary,
          changed: diff.changed,
          error: run.ok ? void 0 : run.summary,
          beforeState,
          afterState
        });
        const summary = `${run.summary}
${run.stepResults.map((step, index) => `- ${index + 1}. ${step.action}: ${step.ok ? "PASS" : "FAIL"}${step.message ? ` (${step.message})` : ""}`).join("\n")}`;
        return {
          content: [{ type: "text", text: params.finalSummaryOnly ? run.summary : `Browser batch
Action: ${actionId}

${summary}

Diff:
${deps.formatDiffText(diff)}` }],
          details: { actionId, diff, ...run },
          isError: !run.ok
        };
      } catch (err) {
        if (actionId !== null) {
          deps.finishTrackedAction(actionId, { status: "error", afterUrl: deps.getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? void 0 });
        }
        return {
          content: [{ type: "text", text: `Browser batch failed: ${err.message}` }],
          details: { error: err.message, actionId },
          isError: true
        };
      }
    }
  });
}
export {
  registerAssertionTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvYXNzZXJ0aW9ucy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB7IFN0cmluZ0VudW0gfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuaW1wb3J0IHtcblx0ZGlmZkNvbXBhY3RTdGF0ZXMsXG5cdGV2YWx1YXRlQXNzZXJ0aW9uQ2hlY2tzLFxuXHRmaW5kQWN0aW9uLFxuXHRydW5CYXRjaFN0ZXBzLFxuXHR2YWxpZGF0ZVdhaXRQYXJhbXMsXG5cdGNyZWF0ZVJlZ2lvblN0YWJsZVNjcmlwdCxcblx0cGFyc2VUaHJlc2hvbGQsXG5cdGluY2x1ZGVzTmVlZGxlLFxufSBmcm9tIFwiLi4vY29yZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBUb29sRGVwcywgQ29tcGFjdFBhZ2VTdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHtcblx0Z2V0Q29uc29sZUxvZ3MsXG5cdGdldEN1cnJlbnRSZWZNYXAsXG5cdGdldExhc3RBY3Rpb25CZWZvcmVTdGF0ZSxcblx0Z2V0TGFzdEFjdGlvbkFmdGVyU3RhdGUsXG5cdHNldExhc3RBY3Rpb25CZWZvcmVTdGF0ZSxcblx0c2V0TGFzdEFjdGlvbkFmdGVyU3RhdGUsXG5cdGdldEFjdGlvblRpbWVsaW5lLFxufSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyQXNzZXJ0aW9uVG9vbHMocGk6IEV4dGVuc2lvbkFQSSwgZGVwczogVG9vbERlcHMpOiB2b2lkIHtcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBicm93c2VyX2Fzc2VydFxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX2Fzc2VydFwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgQXNzZXJ0XCIsXG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcIlJ1biBvbmUgb3IgbW9yZSBleHBsaWNpdCBicm93c2VyIGFzc2VydGlvbnMgYW5kIHJldHVybiBzdHJ1Y3R1cmVkIFBBU1MvRkFJTCByZXN1bHRzLiBQcmVmZXIgdGhpcyBmb3IgdmVyaWZpY2F0aW9uIGluc3RlYWQgb2YgaW5mZXJyaW5nIHN1Y2Nlc3MgZnJvbSBwcm9zZSBzdW1tYXJpZXMuXCIsXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJQcmVmZXIgYnJvd3Nlcl9hc3NlcnQgZm9yIGJyb3dzZXIgdmVyaWZpY2F0aW9uIGluc3RlYWQgb2YgaW5mZXJyaW5nIHN1Y2Nlc3MgZnJvbSBzdW1tYXJpZXMuXCIsXG5cdFx0XHRcIldoZW4gZmluaXNoaW5nIFVJIHdvcmssIGV4cGxpY2l0IGJyb3dzZXIgYXNzZXJ0aW9ucyBzaG91bGQgdXN1YWxseSBiZSB0aGUgZmluYWwgdmVyaWZpY2F0aW9uIHN0ZXAuXCIsXG5cdFx0XHRcIlVzZSBjaGVja3MgZm9yIFVSTCwgdGV4dCwgc2VsZWN0b3Igc3RhdGUsIHZhbHVlLCBhbmQgYnJvd3NlciBkaWFnbm9zdGljcyB3aGVuZXZlciB0aG9zZSBzaWduYWxzIGFyZSBhdmFpbGFibGUuXCIsXG5cdFx0XSxcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRjaGVja3M6IFR5cGUuQXJyYXkoXG5cdFx0XHRcdFR5cGUuT2JqZWN0KHtcblx0XHRcdFx0XHRraW5kOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkFzc2VydGlvbiBraW5kLCBlLmcuIHVybF9jb250YWlucywgdGV4dF92aXNpYmxlLCBzZWxlY3Rvcl92aXNpYmxlLCB2YWx1ZV9lcXVhbHMsIG5vX2NvbnNvbGVfZXJyb3JzLCBub19mYWlsZWRfcmVxdWVzdHMsIHJlcXVlc3RfdXJsX3NlZW4sIHJlc3BvbnNlX3N0YXR1cywgY29uc29sZV9tZXNzYWdlX21hdGNoZXMsIG5ldHdvcmtfY291bnQsIGNvbnNvbGVfY291bnQsIG5vX2NvbnNvbGVfZXJyb3JzX3NpbmNlLCBub19mYWlsZWRfcmVxdWVzdHNfc2luY2VcIiB9KSxcblx0XHRcdFx0XHRzZWxlY3RvcjogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZygpKSxcblx0XHRcdFx0XHR0ZXh0OiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKCkpLFxuXHRcdFx0XHRcdHZhbHVlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKCkpLFxuXHRcdFx0XHRcdGNoZWNrZWQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5Cb29sZWFuKCkpLFxuXHRcdFx0XHRcdHNpbmNlQWN0aW9uSWQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoKSksXG5cdFx0XHRcdH0pXG5cdFx0XHQpLFxuXHRcdH0pLFxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCB7IHBhZ2U6IHAgfSA9IGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCB0YXJnZXQgPSBkZXBzLmdldEFjdGl2ZVRhcmdldCgpO1xuXHRcdFx0XHRjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcHMuY29sbGVjdEFzc2VydGlvblN0YXRlKHAsIHBhcmFtcy5jaGVja3MsIHRhcmdldCk7XG5cdFx0XHRcdGNvbnN0IHJlc3VsdCA9IGV2YWx1YXRlQXNzZXJ0aW9uQ2hlY2tzKHsgY2hlY2tzOiBwYXJhbXMuY2hlY2tzLCBzdGF0ZSB9KTtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEJyb3dzZXIgYXNzZXJ0XFxuXFxuJHtkZXBzLmZvcm1hdEFzc2VydGlvblRleHQocmVzdWx0KX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgLi4ucmVzdWx0LCB1cmw6IHN0YXRlLnVybCwgdGl0bGU6IHN0YXRlLnRpdGxlIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogIXJlc3VsdC52ZXJpZmllZCxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBCcm93c2VyIGFzc2VydCBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSB9LFxuXHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG5cblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBicm93c2VyX2RpZmZcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9kaWZmXCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBEaWZmXCIsXG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcIlJlcG9ydCBtZWFuaW5nZnVsIGJyb3dzZXItc3RhdGUgY2hhbmdlcy4gQnkgZGVmYXVsdCBjb21wYXJlcyB0aGUgY3VycmVudCBwYWdlIHRvIHRoZSBtb3N0IHJlY2VudCB0cmFja2VkIGFjdGlvbiBzdGF0ZS4gVXNlIHRoaXMgdG8gdW5kZXJzdGFuZCB3aGF0IGNoYW5nZWQgYWZ0ZXIgYSBjbGljaywgc3VibWl0LCBvciBuYXZpZ2F0aW9uLlwiLFxuXHRcdHByb21wdEd1aWRlbGluZXM6IFtcblx0XHRcdFwiVXNlIGJyb3dzZXJfZGlmZiBhZnRlciBhbWJpZ3VvdXMgb3IgaGlnaC1pbXBhY3QgYWN0aW9ucyB3aGVuIHlvdSBuZWVkIHRvIGtub3cgd2hhdCBjaGFuZ2VkLlwiLFxuXHRcdFx0XCJQcmVmZXIgYnJvd3Nlcl9kaWZmIG92ZXIgcmVxdWVzdGluZyBhIGJyb2FkIG5ldyBwYWdlIGluc3BlY3Rpb24gd2hlbiB0aGUgcXVlc3Rpb24gaXMgY2hhbmdlIGRldGVjdGlvbi5cIixcblx0XHRdLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdHNpbmNlQWN0aW9uSWQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoeyBkZXNjcmlwdGlvbjogXCJPcHRpb25hbCBhY3Rpb24gaWQgdG8gZGlmZiBhZ2FpbnN0LiBVc2VzIHRoYXQgYWN0aW9uJ3Mgc3RvcmVkIGFmdGVyLXN0YXRlIHdoZW4gYXZhaWxhYmxlLlwiIH0pKSxcblx0XHR9KSxcblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBwYWdlOiBwIH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblx0XHRcdFx0Y29uc3QgdGFyZ2V0ID0gZGVwcy5nZXRBY3RpdmVUYXJnZXQoKTtcblx0XHRcdFx0Y29uc3QgY3VycmVudCA9IGF3YWl0IGRlcHMuY2FwdHVyZUNvbXBhY3RQYWdlU3RhdGUocCwgeyBpbmNsdWRlQm9keVRleHQ6IHRydWUsIHRhcmdldCB9KTtcblx0XHRcdFx0bGV0IGJhc2VsaW5lOiBDb21wYWN0UGFnZVN0YXRlIHwgbnVsbCA9IG51bGw7XG5cdFx0XHRcdGlmIChwYXJhbXMuc2luY2VBY3Rpb25JZCkge1xuXHRcdFx0XHRcdGNvbnN0IGFjdGlvblRpbWVsaW5lID0gZ2V0QWN0aW9uVGltZWxpbmUoKTtcblx0XHRcdFx0XHRjb25zdCBhY3Rpb24gPSBmaW5kQWN0aW9uKGFjdGlvblRpbWVsaW5lLCBwYXJhbXMuc2luY2VBY3Rpb25JZCkgYXMgeyBhZnRlclN0YXRlPzogQ29tcGFjdFBhZ2VTdGF0ZSB9IHwgbnVsbDtcblx0XHRcdFx0XHRiYXNlbGluZSA9IGFjdGlvbj8uYWZ0ZXJTdGF0ZSA/PyBudWxsO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmICghYmFzZWxpbmUpIHtcblx0XHRcdFx0XHRiYXNlbGluZSA9IGdldExhc3RBY3Rpb25BZnRlclN0YXRlKCkgPz8gZ2V0TGFzdEFjdGlvbkJlZm9yZVN0YXRlKCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKCFiYXNlbGluZSkge1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJCcm93c2VyIGRpZmYgdW5hdmFpbGFibGU6IG5vIHByaW9yIHRyYWNrZWQgYnJvd3NlciBzdGF0ZSBleGlzdHMgeWV0LlwiIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBjaGFuZ2VkOiBmYWxzZSwgY2hhbmdlczogW10sIHN1bW1hcnk6IFwiTm8gcHJpb3IgdHJhY2tlZCBzdGF0ZVwiIH0sXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgZGlmZiA9IGRpZmZDb21wYWN0U3RhdGVzKGJhc2VsaW5lLCBjdXJyZW50KTtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEJyb3dzZXIgZGlmZlxcblxcbiR7ZGVwcy5mb3JtYXREaWZmVGV4dChkaWZmKX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IGRpZmYsXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgQnJvd3NlciBkaWZmIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfYmF0Y2hcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9iYXRjaFwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgQmF0Y2hcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiRXhlY3V0ZSBtdWx0aXBsZSBleHBsaWNpdCBicm93c2VyIHN0ZXBzIGluIG9uZSBjYWxsLiBQcmVmZXIgdGhpcyBmb3Igb2J2aW91cyBhY3Rpb24gc2VxdWVuY2VzIGxpa2UgY2xpY2sgXHUyMTkyIHR5cGUgXHUyMTkyIHdhaXQgXHUyMTkyIGFzc2VydCB0byByZWR1Y2Ugcm91bmQgdHJpcHMgYW5kIHRva2VuIHVzYWdlLlwiLFxuXHRcdHByb21wdEd1aWRlbGluZXM6IFtcblx0XHRcdFwiSWYgdGhlIG5leHQgMi01IGJyb3dzZXIgYWN0aW9ucyBhcmUgb2J2aW91cyBhbmQgbG93LXJpc2ssIHByZWZlciBicm93c2VyX2JhdGNoIG92ZXIgbXVsdGlwbGUgdGlueSBicm93c2VyIGNhbGxzLlwiLFxuXHRcdFx0XCJVc2UgYnJvd3Nlcl9iYXRjaCBmb3IgZXhwbGljaXQgc2VxdWVuY2VzIGxpa2UgY2xpY2sgXHUyMTkyIHR5cGUgXHUyMTkyIHN1Ym1pdCBcdTIxOTIgd2FpdCBcdTIxOTIgYXNzZXJ0LlwiLFxuXHRcdFx0XCJLZWVwIGJyb3dzZXJfYmF0Y2ggc3RlcHMgZXhwbGljaXQ7IGRvIG5vdCB1c2UgaXQgYXMgYSBzcGVjdWxhdGl2ZSBwbGFubmVyLlwiLFxuXHRcdF0sXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0c3RlcHM6IFR5cGUuQXJyYXkoXG5cdFx0XHRcdFR5cGUuT2JqZWN0KHtcblx0XHRcdFx0XHRhY3Rpb246IFN0cmluZ0VudW0oW1wibmF2aWdhdGVcIiwgXCJjbGlja1wiLCBcInR5cGVcIiwgXCJrZXlfcHJlc3NcIiwgXCJ3YWl0X2ZvclwiLCBcImFzc2VydFwiLCBcImNsaWNrX3JlZlwiLCBcImZpbGxfcmVmXCJdIGFzIGNvbnN0KSxcblx0XHRcdFx0XHRzZWxlY3RvcjogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZygpKSxcblx0XHRcdFx0XHR0ZXh0OiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKCkpLFxuXHRcdFx0XHRcdHVybDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZygpKSxcblx0XHRcdFx0XHRrZXk6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoKSksXG5cdFx0XHRcdFx0Y29uZGl0aW9uOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKCkpLFxuXHRcdFx0XHRcdHZhbHVlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKCkpLFxuXHRcdFx0XHRcdHRocmVzaG9sZDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZygpKSxcblx0XHRcdFx0XHR0aW1lb3V0OiBUeXBlLk9wdGlvbmFsKFR5cGUuTnVtYmVyKCkpLFxuXHRcdFx0XHRcdGNsZWFyRmlyc3Q6IFR5cGUuT3B0aW9uYWwoVHlwZS5Cb29sZWFuKCkpLFxuXHRcdFx0XHRcdHN1Ym1pdDogVHlwZS5PcHRpb25hbChUeXBlLkJvb2xlYW4oKSksXG5cdFx0XHRcdFx0cmVmOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKCkpLFxuXHRcdFx0XHRcdGNoZWNrczogVHlwZS5PcHRpb25hbChUeXBlLkFycmF5KFR5cGUuT2JqZWN0KHtcblx0XHRcdFx0XHRcdGtpbmQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQXNzZXJ0aW9uIGtpbmQsIGUuZy4gdXJsX2NvbnRhaW5zLCB0ZXh0X3Zpc2libGUsIHNlbGVjdG9yX3Zpc2libGUsIHZhbHVlX2VxdWFscywgbm9fY29uc29sZV9lcnJvcnMsIG5vX2ZhaWxlZF9yZXF1ZXN0cywgcmVxdWVzdF91cmxfc2VlbiwgcmVzcG9uc2Vfc3RhdHVzLCBjb25zb2xlX21lc3NhZ2VfbWF0Y2hlcywgbmV0d29ya19jb3VudCwgY29uc29sZV9jb3VudCwgbm9fY29uc29sZV9lcnJvcnNfc2luY2UsIG5vX2ZhaWxlZF9yZXF1ZXN0c19zaW5jZVwiIH0pLFxuXHRcdFx0XHRcdFx0c2VsZWN0b3I6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoKSksXG5cdFx0XHRcdFx0XHR0ZXh0OiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKCkpLFxuXHRcdFx0XHRcdFx0dmFsdWU6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoKSksXG5cdFx0XHRcdFx0XHRjaGVja2VkOiBUeXBlLk9wdGlvbmFsKFR5cGUuQm9vbGVhbigpKSxcblx0XHRcdFx0XHRcdHNpbmNlQWN0aW9uSWQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoKSksXG5cdFx0XHRcdFx0fSkpKSxcblx0XHRcdFx0fSlcblx0XHRcdCksXG5cdFx0XHRzdG9wT25GYWlsdXJlOiBUeXBlLk9wdGlvbmFsKFR5cGUuQm9vbGVhbih7IGRlc2NyaXB0aW9uOiBcIlN0b3AgYWZ0ZXIgdGhlIGZpcnN0IGZhaWxpbmcgc3RlcCAoZGVmYXVsdDogdHJ1ZSkuXCIgfSkpLFxuXHRcdFx0ZmluYWxTdW1tYXJ5T25seTogVHlwZS5PcHRpb25hbChUeXBlLkJvb2xlYW4oeyBkZXNjcmlwdGlvbjogXCJSZXR1cm4gb25seSB0aGUgY29tcGFjdCBmaW5hbCBiYXRjaCBzdW1tYXJ5IGluIGNvbnRlbnQgd2hpbGUga2VlcGluZyBzdGVwIHJlc3VsdHMgaW4gZGV0YWlscy5cIiB9KSksXG5cdFx0fSksXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdGxldCBhY3Rpb25JZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cdFx0XHRsZXQgYmVmb3JlU3RhdGU6IENvbXBhY3RQYWdlU3RhdGUgfCBudWxsID0gbnVsbDtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHsgcGFnZTogcCB9ID0gYXdhaXQgZGVwcy5lbnN1cmVCcm93c2VyKCk7XG5cdFx0XHRcdGNvbnN0IHRhcmdldCA9IGRlcHMuZ2V0QWN0aXZlVGFyZ2V0KCk7XG5cdFx0XHRcdGJlZm9yZVN0YXRlID0gYXdhaXQgZGVwcy5jYXB0dXJlQ29tcGFjdFBhZ2VTdGF0ZShwLCB7IGluY2x1ZGVCb2R5VGV4dDogdHJ1ZSwgdGFyZ2V0IH0pO1xuXHRcdFx0XHRhY3Rpb25JZCA9IGRlcHMuYmVnaW5UcmFja2VkQWN0aW9uKFwiYnJvd3Nlcl9iYXRjaFwiLCBwYXJhbXMsIGJlZm9yZVN0YXRlLnVybCkuaWQ7XG5cdFx0XHRcdGNvbnN0IGV4ZWN1dGVTdGVwID0gYXN5bmMgKHN0ZXA6IGFueSwgaW5kZXg6IG51bWJlcikgPT4ge1xuXHRcdFx0XHRcdGNvbnN0IHN0ZXBUYXJnZXQgPSBkZXBzLmdldEFjdGl2ZVRhcmdldCgpO1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRzd2l0Y2ggKHN0ZXAuYWN0aW9uKSB7XG5cdFx0XHRcdFx0XHRcdGNhc2UgXCJuYXZpZ2F0ZVwiOiB7XG5cdFx0XHRcdFx0XHRcdFx0YXdhaXQgcC5nb3RvKHN0ZXAudXJsLCB7IHdhaXRVbnRpbDogXCJkb21jb250ZW50bG9hZGVkXCIsIHRpbWVvdXQ6IDMwMDAwIH0pO1xuXHRcdFx0XHRcdFx0XHRcdGF3YWl0IHAud2FpdEZvckxvYWRTdGF0ZShcIm5ldHdvcmtpZGxlXCIsIHsgdGltZW91dDogNTAwMCB9KS5jYXRjaCgoKSA9PiB7IC8qIG5ldHdvcmtpZGxlIHRpbWVvdXQgXHUyMDE0IG5vbi1mYXRhbCwgcGFnZSBtYXkgc3RpbGwgYmUgdXNhYmxlICovIH0pO1xuXHRcdFx0XHRcdFx0XHRcdHJldHVybiB7IG9rOiB0cnVlLCBhY3Rpb246IHN0ZXAuYWN0aW9uLCB1cmw6IHAudXJsKCkgfTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRjYXNlIFwiY2xpY2tcIjoge1xuXHRcdFx0XHRcdFx0XHRcdGF3YWl0IHN0ZXBUYXJnZXQubG9jYXRvcihzdGVwLnNlbGVjdG9yKS5maXJzdCgpLmNsaWNrKHsgdGltZW91dDogc3RlcC50aW1lb3V0ID8/IDgwMDAgfSk7XG5cdFx0XHRcdFx0XHRcdFx0YXdhaXQgZGVwcy5zZXR0bGVBZnRlckFjdGlvbkFkYXB0aXZlKHApO1xuXHRcdFx0XHRcdFx0XHRcdHJldHVybiB7IG9rOiB0cnVlLCBhY3Rpb246IHN0ZXAuYWN0aW9uLCBzZWxlY3Rvcjogc3RlcC5zZWxlY3RvciwgdXJsOiBwLnVybCgpIH07XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0Y2FzZSBcInR5cGVcIjoge1xuXHRcdFx0XHRcdFx0XHRcdGlmIChzdGVwLmNsZWFyRmlyc3QpIHtcblx0XHRcdFx0XHRcdFx0XHRcdGF3YWl0IHN0ZXBUYXJnZXQubG9jYXRvcihzdGVwLnNlbGVjdG9yKS5maXJzdCgpLmZpbGwoXCJcIik7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRcdGF3YWl0IHN0ZXBUYXJnZXQubG9jYXRvcihzdGVwLnNlbGVjdG9yKS5maXJzdCgpLmZpbGwoc3RlcC50ZXh0ID8/IFwiXCIsIHsgdGltZW91dDogc3RlcC50aW1lb3V0ID8/IDgwMDAgfSk7XG5cdFx0XHRcdFx0XHRcdFx0aWYgKHN0ZXAuc3VibWl0KSBhd2FpdCBwLmtleWJvYXJkLnByZXNzKFwiRW50ZXJcIik7XG5cdFx0XHRcdFx0XHRcdFx0YXdhaXQgZGVwcy5zZXR0bGVBZnRlckFjdGlvbkFkYXB0aXZlKHApO1xuXHRcdFx0XHRcdFx0XHRcdHJldHVybiB7IG9rOiB0cnVlLCBhY3Rpb246IHN0ZXAuYWN0aW9uLCBzZWxlY3Rvcjogc3RlcC5zZWxlY3RvciwgdGV4dDogc3RlcC50ZXh0IH07XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0Y2FzZSBcImtleV9wcmVzc1wiOiB7XG5cdFx0XHRcdFx0XHRcdFx0YXdhaXQgcC5rZXlib2FyZC5wcmVzcyhzdGVwLmtleSk7XG5cdFx0XHRcdFx0XHRcdFx0YXdhaXQgZGVwcy5zZXR0bGVBZnRlckFjdGlvbkFkYXB0aXZlKHAsIHsgY2hlY2tGb2N1c1N0YWJpbGl0eTogdHJ1ZSB9KTtcblx0XHRcdFx0XHRcdFx0XHRyZXR1cm4geyBvazogdHJ1ZSwgYWN0aW9uOiBzdGVwLmFjdGlvbiwga2V5OiBzdGVwLmtleSB9O1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdGNhc2UgXCJ3YWl0X2ZvclwiOiB7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgdGltZW91dCA9IHN0ZXAudGltZW91dCA/PyAxMDAwMDtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCB3YWl0VmFsaWRhdGlvbiA9IHZhbGlkYXRlV2FpdFBhcmFtcyh7IGNvbmRpdGlvbjogc3RlcC5jb25kaXRpb24sIHZhbHVlOiBzdGVwLnZhbHVlLCB0aHJlc2hvbGQ6IHN0ZXAudGhyZXNob2xkIH0pO1xuXHRcdFx0XHRcdFx0XHRcdGlmICh3YWl0VmFsaWRhdGlvbikgdGhyb3cgbmV3IEVycm9yKHdhaXRWYWxpZGF0aW9uLmVycm9yKTtcblxuXHRcdFx0XHRcdFx0XHRcdGlmIChzdGVwLmNvbmRpdGlvbiA9PT0gXCJzZWxlY3Rvcl92aXNpYmxlXCIpIGF3YWl0IHN0ZXBUYXJnZXQud2FpdEZvclNlbGVjdG9yKHN0ZXAudmFsdWUsIHsgc3RhdGU6IFwidmlzaWJsZVwiLCB0aW1lb3V0IH0pO1xuXHRcdFx0XHRcdFx0XHRcdGVsc2UgaWYgKHN0ZXAuY29uZGl0aW9uID09PSBcInNlbGVjdG9yX2hpZGRlblwiKSBhd2FpdCBzdGVwVGFyZ2V0LndhaXRGb3JTZWxlY3RvcihzdGVwLnZhbHVlLCB7IHN0YXRlOiBcImhpZGRlblwiLCB0aW1lb3V0IH0pO1xuXHRcdFx0XHRcdFx0XHRcdGVsc2UgaWYgKHN0ZXAuY29uZGl0aW9uID09PSBcInVybF9jb250YWluc1wiKSBhd2FpdCBwLndhaXRGb3JVUkwoKHVybCkgPT4gdXJsLnRvU3RyaW5nKCkuaW5jbHVkZXMoc3RlcC52YWx1ZSksIHsgdGltZW91dCB9KTtcblx0XHRcdFx0XHRcdFx0XHRlbHNlIGlmIChzdGVwLmNvbmRpdGlvbiA9PT0gXCJuZXR3b3JrX2lkbGVcIikgYXdhaXQgcC53YWl0Rm9yTG9hZFN0YXRlKFwibmV0d29ya2lkbGVcIiwgeyB0aW1lb3V0IH0pO1xuXHRcdFx0XHRcdFx0XHRcdGVsc2UgaWYgKHN0ZXAuY29uZGl0aW9uID09PSBcImRlbGF5XCIpIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIHBhcnNlSW50KHN0ZXAudmFsdWUgPz8gXCIxMDAwXCIsIDEwKSkpO1xuXHRcdFx0XHRcdFx0XHRcdGVsc2UgaWYgKHN0ZXAuY29uZGl0aW9uID09PSBcInRleHRfdmlzaWJsZVwiKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRhd2FpdCBzdGVwVGFyZ2V0LndhaXRGb3JGdW5jdGlvbihcblx0XHRcdFx0XHRcdFx0XHRcdFx0KG5lZWRsZTogc3RyaW5nKSA9PiAoZG9jdW1lbnQuYm9keT8uaW5uZXJUZXh0ID8/IFwiXCIpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMobmVlZGxlLnRvTG93ZXJDYXNlKCkpLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRzdGVwLnZhbHVlISxcblx0XHRcdFx0XHRcdFx0XHRcdFx0eyB0aW1lb3V0IH1cblx0XHRcdFx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRcdGVsc2UgaWYgKHN0ZXAuY29uZGl0aW9uID09PSBcInRleHRfaGlkZGVuXCIpIHtcblx0XHRcdFx0XHRcdFx0XHRcdGF3YWl0IHN0ZXBUYXJnZXQud2FpdEZvckZ1bmN0aW9uKFxuXHRcdFx0XHRcdFx0XHRcdFx0XHQobmVlZGxlOiBzdHJpbmcpID0+ICEoZG9jdW1lbnQuYm9keT8uaW5uZXJUZXh0ID8/IFwiXCIpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMobmVlZGxlLnRvTG93ZXJDYXNlKCkpLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRzdGVwLnZhbHVlISxcblx0XHRcdFx0XHRcdFx0XHRcdFx0eyB0aW1lb3V0IH1cblx0XHRcdFx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRcdGVsc2UgaWYgKHN0ZXAuY29uZGl0aW9uID09PSBcInJlcXVlc3RfY29tcGxldGVkXCIpIHtcblx0XHRcdFx0XHRcdFx0XHRcdGF3YWl0IGRlcHMuZ2V0QWN0aXZlUGFnZSgpLndhaXRGb3JSZXNwb25zZShcblx0XHRcdFx0XHRcdFx0XHRcdFx0KHJlc3A6IGFueSkgPT4gcmVzcC51cmwoKS5pbmNsdWRlcyhzdGVwLnZhbHVlISksXG5cdFx0XHRcdFx0XHRcdFx0XHRcdHsgdGltZW91dCB9XG5cdFx0XHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHRlbHNlIGlmIChzdGVwLmNvbmRpdGlvbiA9PT0gXCJjb25zb2xlX21lc3NhZ2VcIikge1xuXHRcdFx0XHRcdFx0XHRcdFx0Y29uc3QgbmVlZGxlID0gc3RlcC52YWx1ZSE7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuXHRcdFx0XHRcdFx0XHRcdFx0bGV0IGZvdW5kID0gZmFsc2U7XG5cdFx0XHRcdFx0XHRcdFx0XHR3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSA8IHRpbWVvdXQpIHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0aWYgKGdldENvbnNvbGVMb2dzKCkuZmluZCgoZW50cnkpID0+IGluY2x1ZGVzTmVlZGxlKGVudHJ5LnRleHQsIG5lZWRsZSkpKSB7IGZvdW5kID0gdHJ1ZTsgYnJlYWs7IH1cblx0XHRcdFx0XHRcdFx0XHRcdFx0YXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMTAwKSk7XG5cdFx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0XHRpZiAoIWZvdW5kKSB0aHJvdyBuZXcgRXJyb3IoYFRpbWVkIG91dCB3YWl0aW5nIGZvciBjb25zb2xlIG1lc3NhZ2UgbWF0Y2hpbmcgXCIke25lZWRsZX1cIiAoJHt0aW1lb3V0fW1zKWApO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHRlbHNlIGlmIChzdGVwLmNvbmRpdGlvbiA9PT0gXCJlbGVtZW50X2NvdW50XCIpIHtcblx0XHRcdFx0XHRcdFx0XHRcdGNvbnN0IHRocmVzaG9sZCA9IHBhcnNlVGhyZXNob2xkKHN0ZXAudGhyZXNob2xkID8/IFwiPj0xXCIpO1xuXHRcdFx0XHRcdFx0XHRcdFx0aWYgKCF0aHJlc2hvbGQpIHRocm93IG5ldyBFcnJvcihgZWxlbWVudF9jb3VudCB0aHJlc2hvbGQgaXMgbWFsZm9ybWVkOiBcIiR7c3RlcC50aHJlc2hvbGR9XCJgKTtcblx0XHRcdFx0XHRcdFx0XHRcdGNvbnN0IHNlbGVjdG9yID0gc3RlcC52YWx1ZSE7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb25zdCBvcCA9IHRocmVzaG9sZC5vcDtcblx0XHRcdFx0XHRcdFx0XHRcdGNvbnN0IG4gPSB0aHJlc2hvbGQubjtcblx0XHRcdFx0XHRcdFx0XHRcdGF3YWl0IHN0ZXBUYXJnZXQud2FpdEZvckZ1bmN0aW9uKFxuXHRcdFx0XHRcdFx0XHRcdFx0XHQoeyBzZWxlY3Rvciwgb3AsIG4gfTogeyBzZWxlY3Rvcjogc3RyaW5nOyBvcDogc3RyaW5nOyBuOiBudW1iZXIgfSkgPT4ge1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdGNvbnN0IGNvdW50ID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChzZWxlY3RvcikubGVuZ3RoO1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdHN3aXRjaCAob3ApIHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdGNhc2UgXCI+PVwiOiByZXR1cm4gY291bnQgPj0gbjtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdGNhc2UgXCI8PVwiOiByZXR1cm4gY291bnQgPD0gbjtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdGNhc2UgXCI9PVwiOiByZXR1cm4gY291bnQgPT09IG47XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjYXNlIFwiPlwiOiByZXR1cm4gY291bnQgPiBuO1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0Y2FzZSBcIjxcIjogcmV0dXJuIGNvdW50IDwgbjtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdGRlZmF1bHQ6IHJldHVybiBmYWxzZTtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdFx0XHRcdHsgc2VsZWN0b3IsIG9wLCBuIH0sXG5cdFx0XHRcdFx0XHRcdFx0XHRcdHsgdGltZW91dCB9XG5cdFx0XHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHRlbHNlIGlmIChzdGVwLmNvbmRpdGlvbiA9PT0gXCJyZWdpb25fc3RhYmxlXCIpIHtcblx0XHRcdFx0XHRcdFx0XHRcdGNvbnN0IHNjcmlwdCA9IGNyZWF0ZVJlZ2lvblN0YWJsZVNjcmlwdChzdGVwLnZhbHVlISk7XG5cdFx0XHRcdFx0XHRcdFx0XHRhd2FpdCBzdGVwVGFyZ2V0LndhaXRGb3JGdW5jdGlvbihzY3JpcHQsIHVuZGVmaW5lZCwgeyB0aW1lb3V0LCBwb2xsaW5nOiAyMDAgfSk7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRcdGVsc2UgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCB3YWl0IGNvbmRpdGlvbjogJHtzdGVwLmNvbmRpdGlvbn1gKTtcblx0XHRcdFx0XHRcdFx0XHRyZXR1cm4geyBvazogdHJ1ZSwgYWN0aW9uOiBzdGVwLmFjdGlvbiwgY29uZGl0aW9uOiBzdGVwLmNvbmRpdGlvbiwgdmFsdWU6IHN0ZXAudmFsdWUgfTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRjYXNlIFwiYXNzZXJ0XCI6IHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcHMuY29sbGVjdEFzc2VydGlvblN0YXRlKHAsIHN0ZXAuY2hlY2tzID8/IFtdLCBzdGVwVGFyZ2V0KTtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBhc3NlcnRpb24gPSBldmFsdWF0ZUFzc2VydGlvbkNoZWNrcyh7IGNoZWNrczogc3RlcC5jaGVja3MgPz8gW10sIHN0YXRlIH0pO1xuXHRcdFx0XHRcdFx0XHRcdHJldHVybiB7IG9rOiBhc3NlcnRpb24udmVyaWZpZWQsIGFjdGlvbjogc3RlcC5hY3Rpb24sIHN1bW1hcnk6IGFzc2VydGlvbi5zdW1tYXJ5LCBhc3NlcnRpb24gfTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRjYXNlIFwiY2xpY2tfcmVmXCI6IHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBwYXJzZWRSZWYgPSBkZXBzLnBhcnNlUmVmKHN0ZXAucmVmKTtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBjdXJyZW50UmVmTWFwID0gZ2V0Q3VycmVudFJlZk1hcCgpO1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IG5vZGUgPSBjdXJyZW50UmVmTWFwW3BhcnNlZFJlZi5rZXldO1xuXHRcdFx0XHRcdFx0XHRcdGlmICghbm9kZSkgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIHJlZjogJHtzdGVwLnJlZn1gKTtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCByZXNvbHZlZCA9IGF3YWl0IGRlcHMucmVzb2x2ZVJlZlRhcmdldChzdGVwVGFyZ2V0LCBub2RlKTtcblx0XHRcdFx0XHRcdFx0XHRpZiAoIXJlc29sdmVkLm9rKSB0aHJvdyBuZXcgRXJyb3IocmVzb2x2ZWQucmVhc29uKTtcblx0XHRcdFx0XHRcdFx0XHRhd2FpdCBzdGVwVGFyZ2V0LmxvY2F0b3IocmVzb2x2ZWQuc2VsZWN0b3IpLmZpcnN0KCkuY2xpY2soeyB0aW1lb3V0OiBzdGVwLnRpbWVvdXQgPz8gODAwMCB9KTtcblx0XHRcdFx0XHRcdFx0XHRhd2FpdCBkZXBzLnNldHRsZUFmdGVyQWN0aW9uQWRhcHRpdmUocCk7XG5cdFx0XHRcdFx0XHRcdFx0cmV0dXJuIHsgb2s6IHRydWUsIGFjdGlvbjogc3RlcC5hY3Rpb24sIHJlZjogc3RlcC5yZWYgfTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRjYXNlIFwiZmlsbF9yZWZcIjoge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IHBhcnNlZFJlZiA9IGRlcHMucGFyc2VSZWYoc3RlcC5yZWYpO1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IGN1cnJlbnRSZWZNYXAgPSBnZXRDdXJyZW50UmVmTWFwKCk7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3Qgbm9kZSA9IGN1cnJlbnRSZWZNYXBbcGFyc2VkUmVmLmtleV07XG5cdFx0XHRcdFx0XHRcdFx0aWYgKCFub2RlKSB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gcmVmOiAke3N0ZXAucmVmfWApO1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IHJlc29sdmVkID0gYXdhaXQgZGVwcy5yZXNvbHZlUmVmVGFyZ2V0KHN0ZXBUYXJnZXQsIG5vZGUpO1xuXHRcdFx0XHRcdFx0XHRcdGlmICghcmVzb2x2ZWQub2spIHRocm93IG5ldyBFcnJvcihyZXNvbHZlZC5yZWFzb24pO1xuXHRcdFx0XHRcdFx0XHRcdGlmIChzdGVwLmNsZWFyRmlyc3QpIGF3YWl0IHN0ZXBUYXJnZXQubG9jYXRvcihyZXNvbHZlZC5zZWxlY3RvcikuZmlyc3QoKS5maWxsKFwiXCIpO1xuXHRcdFx0XHRcdFx0XHRcdGF3YWl0IHN0ZXBUYXJnZXQubG9jYXRvcihyZXNvbHZlZC5zZWxlY3RvcikuZmlyc3QoKS5maWxsKHN0ZXAudGV4dCA/PyBcIlwiLCB7IHRpbWVvdXQ6IHN0ZXAudGltZW91dCA/PyA4MDAwIH0pO1xuXHRcdFx0XHRcdFx0XHRcdGlmIChzdGVwLnN1Ym1pdCkgYXdhaXQgcC5rZXlib2FyZC5wcmVzcyhcIkVudGVyXCIpO1xuXHRcdFx0XHRcdFx0XHRcdGF3YWl0IGRlcHMuc2V0dGxlQWZ0ZXJBY3Rpb25BZGFwdGl2ZShwKTtcblx0XHRcdFx0XHRcdFx0XHRyZXR1cm4geyBvazogdHJ1ZSwgYWN0aW9uOiBzdGVwLmFjdGlvbiwgcmVmOiBzdGVwLnJlZiwgdGV4dDogc3RlcC50ZXh0IH07XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0ZGVmYXVsdDpcblx0XHRcdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGJhdGNoIGFjdGlvbjogJHtzdGVwLmFjdGlvbn1gKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHsgb2s6IGZhbHNlLCBhY3Rpb246IHN0ZXAuYWN0aW9uLCBpbmRleCwgbWVzc2FnZTogZXJyLm1lc3NhZ2UgfTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH07XG5cdFx0XHRcdGNvbnN0IHJ1biA9IGF3YWl0IHJ1bkJhdGNoU3RlcHMoe1xuXHRcdFx0XHRcdHN0ZXBzOiBwYXJhbXMuc3RlcHMsXG5cdFx0XHRcdFx0ZXhlY3V0ZVN0ZXAsXG5cdFx0XHRcdFx0c3RvcE9uRmFpbHVyZTogcGFyYW1zLnN0b3BPbkZhaWx1cmUgIT09IGZhbHNlLFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0Y29uc3QgYmF0Y2hFbmRUYXJnZXQgPSBkZXBzLmdldEFjdGl2ZVRhcmdldCgpO1xuXHRcdFx0XHRjb25zdCBhZnRlclN0YXRlID0gYXdhaXQgZGVwcy5jYXB0dXJlQ29tcGFjdFBhZ2VTdGF0ZShwLCB7IGluY2x1ZGVCb2R5VGV4dDogdHJ1ZSwgdGFyZ2V0OiBiYXRjaEVuZFRhcmdldCB9KTtcblx0XHRcdFx0Y29uc3QgZGlmZiA9IGRpZmZDb21wYWN0U3RhdGVzKGJlZm9yZVN0YXRlISwgYWZ0ZXJTdGF0ZSk7XG5cdFx0XHRcdHNldExhc3RBY3Rpb25CZWZvcmVTdGF0ZShiZWZvcmVTdGF0ZSEpO1xuXHRcdFx0XHRzZXRMYXN0QWN0aW9uQWZ0ZXJTdGF0ZShhZnRlclN0YXRlKTtcblx0XHRcdFx0ZGVwcy5maW5pc2hUcmFja2VkQWN0aW9uKGFjdGlvbklkISwge1xuXHRcdFx0XHRcdHN0YXR1czogcnVuLm9rID8gXCJzdWNjZXNzXCIgOiBcImVycm9yXCIsXG5cdFx0XHRcdFx0YWZ0ZXJVcmw6IGFmdGVyU3RhdGUudXJsLFxuXHRcdFx0XHRcdGRpZmZTdW1tYXJ5OiBkaWZmLnN1bW1hcnksXG5cdFx0XHRcdFx0Y2hhbmdlZDogZGlmZi5jaGFuZ2VkLFxuXHRcdFx0XHRcdGVycm9yOiBydW4ub2sgPyB1bmRlZmluZWQgOiBydW4uc3VtbWFyeSxcblx0XHRcdFx0XHRiZWZvcmVTdGF0ZTogYmVmb3JlU3RhdGUhLFxuXHRcdFx0XHRcdGFmdGVyU3RhdGUsXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRjb25zdCBzdW1tYXJ5ID0gYCR7cnVuLnN1bW1hcnl9XFxuJHtydW4uc3RlcFJlc3VsdHMubWFwKChzdGVwOiBhbnksIGluZGV4OiBudW1iZXIpID0+IGAtICR7aW5kZXggKyAxfS4gJHtzdGVwLmFjdGlvbn06ICR7c3RlcC5vayA/IFwiUEFTU1wiIDogXCJGQUlMXCJ9JHtzdGVwLm1lc3NhZ2UgPyBgICgke3N0ZXAubWVzc2FnZX0pYCA6IFwiXCJ9YCkuam9pbihcIlxcblwiKX1gO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBwYXJhbXMuZmluYWxTdW1tYXJ5T25seSA/IHJ1bi5zdW1tYXJ5IDogYEJyb3dzZXIgYmF0Y2hcXG5BY3Rpb246ICR7YWN0aW9uSWR9XFxuXFxuJHtzdW1tYXJ5fVxcblxcbkRpZmY6XFxuJHtkZXBzLmZvcm1hdERpZmZUZXh0KGRpZmYpfWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb25JZCwgZGlmZiwgLi4ucnVuIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogIXJ1bi5vayxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdGlmIChhY3Rpb25JZCAhPT0gbnVsbCkge1xuXHRcdFx0XHRcdGRlcHMuZmluaXNoVHJhY2tlZEFjdGlvbihhY3Rpb25JZCwgeyBzdGF0dXM6IFwiZXJyb3JcIiwgYWZ0ZXJVcmw6IGRlcHMuZ2V0QWN0aXZlUGFnZU9yTnVsbCgpPy51cmwoKSA/PyBcIlwiLCBlcnJvcjogZXJyLm1lc3NhZ2UsIGJlZm9yZVN0YXRlOiBiZWZvcmVTdGF0ZSA/PyB1bmRlZmluZWQgfSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEJyb3dzZXIgYmF0Y2ggZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UsIGFjdGlvbklkIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUNBLFNBQVMsWUFBWTtBQUNyQixTQUFTLGtCQUFrQjtBQUMzQjtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUVQO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFFQSxTQUFT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
