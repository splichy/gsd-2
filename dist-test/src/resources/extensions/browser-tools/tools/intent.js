import { Type } from "@sinclair/typebox";
import { diffCompactStates } from "../core.js";
import {
  setLastActionBeforeState,
  setLastActionAfterState
} from "../state.js";
const INTENTS = [
  "submit_form",
  "close_dialog",
  "primary_cta",
  "search_field",
  "next_step",
  "dismiss",
  "auth_action",
  "back_navigation"
];
function StringEnum(values, options) {
  return Type.Unsafe({
    type: "string",
    enum: values,
    ...options?.description && { description: options.description },
    ...options?.default && { default: options.default }
  });
}
function buildIntentScoringScript(intent, scope) {
  const scopeSelector = JSON.stringify(scope ?? null);
  return `(() => {
	var pi = window.__pi;
	if (!pi) return { error: "window.__pi not available \u2014 browser helpers not injected" };

	var intentRaw = ${JSON.stringify(intent)};
	var normalized = intentRaw.toLowerCase().replace(/[\\s_\\-]+/g, "");
	var scopeSel = ${scopeSelector};
	var root = scopeSel ? document.querySelector(scopeSel) : document.body;
	if (!root) return { error: "Scope selector not found: " + scopeSel };

	// --- Shared helpers ---
	function textOf(el) {
		return (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120).toLowerCase();
	}

	function clamp01(v) { return Math.max(0, Math.min(1, v)); }

	function makeCandidate(el, score, reason) {
		return {
			score: Math.round(clamp01(score) * 100) / 100,
			selector: pi.cssPath(el),
			tag: el.tagName.toLowerCase(),
			role: pi.inferRole(el) || "",
			name: pi.accessibleName(el) || "",
			text: textOf(el).slice(0, 80),
			reason: reason,
		};
	}

	function qsa(sel) { return Array.from(root.querySelectorAll(sel)); }

	function visibleEnabled(el) {
		return pi.isVisible(el) && pi.isEnabled(el);
	}

	function textMatches(el, patterns) {
		var t = textOf(el);
		var n = (pi.accessibleName(el) || "").toLowerCase();
		var combined = t + " " + n;
		for (var i = 0; i < patterns.length; i++) {
			if (combined.indexOf(patterns[i]) !== -1) return true;
		}
		return false;
	}

	function textMatchStrength(el, patterns) {
		var t = textOf(el);
		var n = (pi.accessibleName(el) || "").toLowerCase();
		var combined = t + " " + n;
		var count = 0;
		for (var i = 0; i < patterns.length; i++) {
			if (combined.indexOf(patterns[i]) !== -1) count++;
		}
		return Math.min(count / Math.max(patterns.length, 1), 1);
	}

	// --- Intent-specific scoring ---
	var candidates = [];

	if (normalized === "submitform") {
		var els = qsa('button[type="submit"], input[type="submit"], button:not([type]), button[type="button"]');
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (!visibleEnabled(el)) continue;
			var d1 = el.type === "submit" || el.getAttribute("type") === "submit" ? 0.35 : 0;
			var d2 = el.closest("form") ? 0.3 : 0;
			var d3 = textMatches(el, ["submit", "send", "save", "create", "add", "post", "confirm", "ok", "done", "register", "sign up", "log in"]) ? 0.2 : 0;
			var d4 = 0.15;
			var score = d1 + d2 + d3 + d4;
			var reasons = [];
			if (d1 > 0) reasons.push("submit-type");
			if (d2 > 0) reasons.push("inside-form");
			if (d3 > 0) reasons.push("text-suggests-submit");
			reasons.push("visible+enabled");
			candidates.push(makeCandidate(el, score, reasons.join(", ")));
		}
	}

	else if (normalized === "closedialog") {
		var containers = qsa('[role="dialog"], dialog, [aria-modal="true"], [role="alertdialog"]');
		for (var ci = 0; ci < containers.length; ci++) {
			var btns = containers[ci].querySelectorAll("button, a, [role='button']");
			for (var bi = 0; bi < btns.length; bi++) {
				var el = btns[bi];
				if (!visibleEnabled(el)) continue;
				var d1 = textMatches(el, ["close", "cancel", "dismiss", "\xD7", "\u2715", "x", "got it", "ok", "done"]) ? 0.35 : 0;
				var ariaLbl = (el.getAttribute("aria-label") || "").toLowerCase();
				var d2 = (ariaLbl.indexOf("close") !== -1 || ariaLbl.indexOf("dismiss") !== -1) ? 0.25 : 0;
				var d3 = 0.2;
				var rect = el.getBoundingClientRect();
				var parentRect = containers[ci].getBoundingClientRect();
				var isTopRight = rect.top - parentRect.top < 60 && parentRect.right - rect.right < 60;
				var d4 = isTopRight ? 0.2 : 0;
				var score = d1 + d2 + d3 + d4;
				var reasons = [];
				if (d1 > 0) reasons.push("text-matches-close");
				if (d2 > 0) reasons.push("aria-label-close");
				reasons.push("inside-dialog");
				if (d4 > 0) reasons.push("top-right-position");
				candidates.push(makeCandidate(el, score, reasons.join(", ")));
			}
		}
	}

	else if (normalized === "primarycta") {
		var els = qsa("button, a, [role='button'], input[type='submit'], input[type='button']");
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (!visibleEnabled(el)) continue;
			var rect = el.getBoundingClientRect();
			var area = rect.width * rect.height;
			var d1 = clamp01(area / 12000);
			var role = pi.inferRole(el);
			var d2 = role === "button" ? 0.25 : (role === "link" ? 0.1 : 0.15);
			var isNegative = textMatches(el, ["cancel", "dismiss", "close", "skip", "no thanks", "no, thanks", "maybe later"]);
			var d3 = isNegative ? 0 : 0.2;
			var inMain = !!el.closest("main, [role='main'], article, section, .hero, .content");
			var d4 = inMain ? 0.15 : 0;
			var score = d1 + d2 + d3 + d4;
			var reasons = [];
			reasons.push("size:" + Math.round(area));
			if (d2 >= 0.25) reasons.push("button-role");
			if (d3 > 0) reasons.push("non-dismissive");
			if (d4 > 0) reasons.push("in-main-content");
			candidates.push(makeCandidate(el, score, reasons.join(", ")));
		}
	}

	else if (normalized === "searchfield") {
		var els = qsa("input, textarea, [role='searchbox'], [role='combobox'], [contenteditable='true']");
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (!pi.isVisible(el)) continue;
			var type = (el.getAttribute("type") || "text").toLowerCase();
			if (["hidden", "submit", "button", "reset", "image", "checkbox", "radio", "file"].indexOf(type) !== -1 && el.tagName.toLowerCase() === "input") continue;
			var d1 = type === "search" || pi.inferRole(el) === "searchbox" ? 0.4 : 0;
			var ph = (el.getAttribute("placeholder") || "").toLowerCase();
			var nm = (el.getAttribute("name") || "").toLowerCase();
			var ariaLbl = (el.getAttribute("aria-label") || "").toLowerCase();
			var combined = ph + " " + nm + " " + ariaLbl;
			var d2 = combined.indexOf("search") !== -1 || combined.indexOf("query") !== -1 || combined.indexOf("find") !== -1 ? 0.3 : 0;
			var d3 = pi.isEnabled(el) ? 0.15 : 0;
			var inHeader = !!el.closest("header, nav, [role='banner'], [role='navigation'], [role='search']");
			var d4 = inHeader ? 0.15 : 0;
			var score = d1 + d2 + d3 + d4;
			if (score < 0.1) continue;
			var reasons = [];
			if (d1 > 0) reasons.push("search-type/role");
			if (d2 > 0) reasons.push("name/placeholder-match");
			if (d3 > 0) reasons.push("enabled");
			if (d4 > 0) reasons.push("in-header/nav");
			candidates.push(makeCandidate(el, score, reasons.join(", ")));
		}
	}

	else if (normalized === "nextstep") {
		var els = qsa("button, a, [role='button'], input[type='submit'], input[type='button']");
		var patterns = ["next", "continue", "proceed", "forward", "go", "step"];
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (!visibleEnabled(el)) continue;
			var d1 = textMatchStrength(el, patterns) * 0.4;
			if (d1 === 0) continue;
			var role = pi.inferRole(el);
			var d2 = role === "button" ? 0.25 : 0.1;
			var d3 = 0.2;
			var isDisabled = !pi.isEnabled(el);
			var d4 = isDisabled ? 0 : 0.15;
			var score = d1 + d2 + d3 + d4;
			var reasons = [];
			reasons.push("text-match");
			if (d2 >= 0.25) reasons.push("button-role");
			reasons.push("visible");
			if (d4 > 0) reasons.push("enabled");
			candidates.push(makeCandidate(el, score, reasons.join(", ")));
		}
	}

	else if (normalized === "dismiss") {
		var els = qsa("button, a, [role='button'], [role='link']");
		var patterns = ["close", "cancel", "dismiss", "skip", "no thanks", "no, thanks", "maybe later", "not now", "\xD7", "\u2715"];
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (!visibleEnabled(el)) continue;
			var d1 = textMatchStrength(el, patterns) * 0.35;
			if (d1 === 0) continue;
			var inOverlay = !!el.closest('[role="dialog"], dialog, [aria-modal="true"], [role="alertdialog"], .modal, .overlay, .popup, .popover, .toast, .banner');
			var d2 = inOverlay ? 0.3 : 0.05;
			var rect = el.getBoundingClientRect();
			var isEdge = rect.top < 80 || rect.right > window.innerWidth - 80;
			var d3 = isEdge ? 0.15 : 0;
			var d4 = 0.15;
			var score = d1 + d2 + d3 + d4;
			var reasons = [];
			reasons.push("text-match");
			if (d2 >= 0.3) reasons.push("inside-overlay");
			if (d3 > 0) reasons.push("edge-position");
			reasons.push("visible+enabled");
			candidates.push(makeCandidate(el, score, reasons.join(", ")));
		}
	}

	else if (normalized === "authaction") {
		var els = qsa("button, a, [role='button'], [role='link'], input[type='submit']");
		var patterns = ["log in", "login", "sign in", "signin", "sign up", "signup", "register", "create account", "join", "get started"];
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (!visibleEnabled(el)) continue;
			var d1 = textMatchStrength(el, patterns) * 0.4;
			if (d1 === 0) continue;
			var role = pi.inferRole(el);
			var d2 = (role === "button" || role === "link") ? 0.25 : 0.1;
			var rect = el.getBoundingClientRect();
			var inHeader = !!el.closest("header, nav, [role='banner'], [role='navigation']");
			var isProminent = inHeader || rect.top < 200;
			var d3 = isProminent ? 0.2 : 0.05;
			var d4 = 0.15;
			var score = d1 + d2 + d3 + d4;
			var reasons = [];
			reasons.push("text-match");
			if (d2 >= 0.25) reasons.push("button-or-link");
			if (d3 >= 0.2) reasons.push("prominent-position");
			reasons.push("visible+enabled");
			candidates.push(makeCandidate(el, score, reasons.join(", ")));
		}
	}

	else if (normalized === "backnavigation") {
		var els = qsa("button, a, [role='button'], [role='link']");
		var patterns = ["back", "previous", "prev", "return", "go back"];
		for (var i = 0; i < els.length; i++) {
			var el = els[i];
			if (!visibleEnabled(el)) continue;
			var d1 = textMatchStrength(el, patterns) * 0.35;
			if (d1 === 0) continue;
			var innerHtml = el.innerHTML.toLowerCase();
			var hasArrow = innerHtml.indexOf("\u2190") !== -1 || innerHtml.indexOf("&larr") !== -1 || innerHtml.indexOf("arrow") !== -1 || innerHtml.indexOf("chevron-left") !== -1 || innerHtml.indexOf("back") !== -1;
			var d2 = hasArrow ? 0.25 : 0;
			var inNav = !!el.closest("header, nav, [role='banner'], [role='navigation'], .breadcrumb, .toolbar");
			var d3 = inNav ? 0.25 : 0.05;
			var d4 = 0.15;
			var score = d1 + d2 + d3 + d4;
			var reasons = [];
			reasons.push("text-match");
			if (d2 > 0) reasons.push("has-back-arrow/icon");
			if (d3 >= 0.25) reasons.push("in-nav/header");
			reasons.push("visible+enabled");
			candidates.push(makeCandidate(el, score, reasons.join(", ")));
		}
	}

	else {
		return { error: "Unknown intent: " + intentRaw + ". Valid: submit_form, close_dialog, primary_cta, search_field, next_step, dismiss, auth_action, back_navigation" };
	}

	// Sort by score descending, cap at 5
	candidates.sort(function(a, b) { return b.score - a.score; });
	candidates = candidates.slice(0, 5);

	return { intent: intentRaw, normalized: normalized, count: candidates.length, candidates: candidates };
})()`;
}
function registerIntentTools(pi, deps) {
  pi.registerTool({
    name: "browser_find_best",
    label: "Find Best",
    description: 'Find the best-matching element for a semantic intent. Returns up to 5 scored candidates (0-1) ranked by structural position, role, text signals, and visibility. Use this to discover which element the agent should interact with for a given goal \u2014 e.g. intent="submit_form" finds submit buttons, intent="close_dialog" finds close/dismiss buttons inside dialogs. Each candidate includes a CSS selector usable with browser_click.',
    parameters: Type.Object({
      intent: StringEnum(INTENTS, {
        description: "Semantic intent: submit_form, close_dialog, primary_cta, search_field, next_step, dismiss, auth_action, back_navigation"
      }),
      scope: Type.Optional(
        Type.String({
          description: "CSS selector to narrow the search area. If omitted, searches the full page."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let actionId = null;
      let beforeState = null;
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        beforeState = await deps.captureCompactPageState(p, {
          selectors: params.scope ? [params.scope] : [],
          includeBodyText: false,
          target
        });
        actionId = deps.beginTrackedAction("browser_find_best", params, beforeState.url).id;
        const script = buildIntentScoringScript(params.intent, params.scope);
        const result = await target.evaluate(script);
        if (result.error) {
          deps.finishTrackedAction(actionId, {
            status: "error",
            error: result.error,
            beforeState
          });
          return {
            content: [{ type: "text", text: result.error }],
            details: {},
            isError: true
          };
        }
        const afterState = await deps.captureCompactPageState(p, {
          selectors: params.scope ? [params.scope] : [],
          includeBodyText: false,
          target
        });
        setLastActionBeforeState(beforeState);
        setLastActionAfterState(afterState);
        deps.finishTrackedAction(actionId, {
          status: "success",
          afterUrl: afterState.url,
          beforeState,
          afterState
        });
        const lines = [];
        lines.push(`Intent: ${params.intent} \u2192 ${result.count} candidate(s)`);
        if (params.scope) lines.push(`Scope: ${params.scope}`);
        lines.push("");
        if (result.candidates.length === 0) {
          lines.push("No candidates found for this intent on the current page.");
        } else {
          for (let i = 0; i < result.candidates.length; i++) {
            const c = result.candidates[i];
            lines.push(`${i + 1}. **${c.score}** \`${c.selector}\``);
            lines.push(`   ${c.tag}${c.role ? ` [${c.role}]` : ""} \u2014 "${c.name || c.text}"`);
            lines.push(`   Reason: ${c.reason}`);
          }
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { intentResult: result }
        };
      } catch (err) {
        const screenshot = await deps.captureErrorScreenshot(
          (() => {
            try {
              return deps.getActivePage();
            } catch {
              return null;
            }
          })()
        );
        const errMsg = deps.firstErrorLine(err);
        if (actionId !== null) {
          deps.finishTrackedAction(actionId, {
            status: "error",
            error: errMsg,
            beforeState: beforeState ?? void 0
          });
        }
        const content = [
          { type: "text", text: `browser_find_best failed: ${errMsg}` }
        ];
        if (screenshot) {
          content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType });
        }
        return { content, details: {}, isError: true };
      }
    }
  });
  pi.registerTool({
    name: "browser_act",
    label: "Browser Act",
    description: 'Execute a semantic action in one call. Resolves the top candidate for the given intent (same scoring as browser_find_best), performs the action (click for buttons/links, focus for search fields), settles the page, and returns a before/after diff. Use when you know what you want to accomplish semantically \u2014 e.g. intent="submit_form" finds and clicks the submit button, intent="close_dialog" dismisses the dialog.',
    parameters: Type.Object({
      intent: StringEnum(INTENTS, {
        description: "Semantic intent: submit_form, close_dialog, primary_cta, search_field, next_step, dismiss, auth_action, back_navigation"
      }),
      scope: Type.Optional(
        Type.String({
          description: "CSS selector to narrow the search area. If omitted, searches the full page."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let actionId = null;
      let beforeState = null;
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        beforeState = await deps.captureCompactPageState(p, {
          selectors: params.scope ? [params.scope] : [],
          includeBodyText: true,
          target
        });
        actionId = deps.beginTrackedAction("browser_act", params, beforeState.url).id;
        const script = buildIntentScoringScript(params.intent, params.scope);
        const result = await target.evaluate(script);
        if (result.error) {
          deps.finishTrackedAction(actionId, {
            status: "error",
            error: result.error,
            beforeState
          });
          return {
            content: [{ type: "text", text: `browser_act failed: ${result.error}` }],
            details: {},
            isError: true
          };
        }
        if (result.candidates.length === 0) {
          deps.finishTrackedAction(actionId, {
            status: "error",
            error: `No candidates found for intent "${params.intent}"`,
            beforeState
          });
          return {
            content: [{
              type: "text",
              text: `browser_act: No candidates found for intent "${params.intent}" on the current page. The page may not have the expected elements (e.g. no dialog for close_dialog, no form for submit_form).`
            }],
            details: { intentResult: result },
            isError: true
          };
        }
        const top = result.candidates[0];
        const normalizedIntent = params.intent.toLowerCase().replace(/[\s_-]+/g, "");
        if (normalizedIntent === "searchfield") {
          try {
            await target.locator(top.selector).first().focus({ timeout: 5e3 });
          } catch {
            await target.locator(top.selector).first().click({ timeout: 5e3 });
          }
        } else {
          try {
            await target.locator(top.selector).first().click({ timeout: 5e3 });
          } catch {
            const nameMatch = top.selector.match(/\[(?:aria-label|name|placeholder)="([^"]+)"\]/i);
            const roleName = nameMatch?.[1];
            let clicked = false;
            for (const role of ["button", "link", "combobox", "textbox"]) {
              try {
                const loc = roleName ? target.getByRole(role, { name: new RegExp(roleName, "i") }) : target.getByRole(role, { name: new RegExp(top.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
                await loc.first().click({ timeout: 3e3 });
                clicked = true;
                break;
              } catch {
              }
            }
            if (!clicked) {
              throw new Error(`Could not click top candidate "${top.selector}" for intent "${params.intent}"`);
            }
          }
        }
        await deps.settleAfterActionAdaptive(p);
        const afterState = await deps.captureCompactPageState(p, {
          selectors: params.scope ? [params.scope] : [],
          includeBodyText: true,
          target
        });
        const diff = diffCompactStates(beforeState, afterState);
        const summary = deps.formatCompactStateSummary(afterState);
        const jsErrors = deps.getRecentErrors(p.url());
        setLastActionBeforeState(beforeState);
        setLastActionAfterState(afterState);
        deps.finishTrackedAction(actionId, {
          status: "success",
          afterUrl: afterState.url,
          diffSummary: diff.summary,
          beforeState,
          afterState
        });
        const lines = [];
        lines.push(`Intent: ${params.intent}`);
        lines.push(`Action: ${normalizedIntent === "searchfield" ? "focused" : "clicked"} top candidate (score: ${top.score})`);
        lines.push(`Target: \`${top.selector}\` \u2014 "${top.name || top.text}"`);
        lines.push(`Reason: ${top.reason}`);
        lines.push("");
        lines.push(`Diff:
${deps.formatDiffText(diff)}`);
        if (jsErrors.trim()) {
          lines.push(`
JS Errors:
${jsErrors}`);
        }
        lines.push(`
Page summary:
${summary}`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { intentResult: result, topCandidate: top, diff }
        };
      } catch (err) {
        const screenshot = await deps.captureErrorScreenshot(
          (() => {
            try {
              return deps.getActivePage();
            } catch {
              return null;
            }
          })()
        );
        const errMsg = deps.firstErrorLine(err);
        if (actionId !== null) {
          deps.finishTrackedAction(actionId, {
            status: "error",
            error: errMsg,
            beforeState: beforeState ?? void 0
          });
        }
        const content = [
          { type: "text", text: `browser_act failed: ${errMsg}` }
        ];
        if (screenshot) {
          content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType });
        }
        return { content, details: {}, isError: true };
      }
    }
  });
}
export {
  buildIntentScoringScript,
  registerIntentTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvaW50ZW50LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgdHlwZSBUVW5zYWZlLCBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgeyBkaWZmQ29tcGFjdFN0YXRlcyB9IGZyb20gXCIuLi9jb3JlLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFRvb2xEZXBzLCBDb21wYWN0UGFnZVN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlLmpzXCI7XG5pbXBvcnQge1xuXHRzZXRMYXN0QWN0aW9uQmVmb3JlU3RhdGUsXG5cdHNldExhc3RBY3Rpb25BZnRlclN0YXRlLFxufSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBJbnRlbnQgZGVmaW5pdGlvbnNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5jb25zdCBJTlRFTlRTID0gW1xuXHRcInN1Ym1pdF9mb3JtXCIsXG5cdFwiY2xvc2VfZGlhbG9nXCIsXG5cdFwicHJpbWFyeV9jdGFcIixcblx0XCJzZWFyY2hfZmllbGRcIixcblx0XCJuZXh0X3N0ZXBcIixcblx0XCJkaXNtaXNzXCIsXG5cdFwiYXV0aF9hY3Rpb25cIixcblx0XCJiYWNrX25hdmlnYXRpb25cIixcbl0gYXMgY29uc3Q7XG5cbnR5cGUgSW50ZW50ID0gKHR5cGVvZiBJTlRFTlRTKVtudW1iZXJdO1xuXG5mdW5jdGlvbiBTdHJpbmdFbnVtPFQgZXh0ZW5kcyByZWFkb25seSBzdHJpbmdbXT4oXG5cdHZhbHVlczogVCxcblx0b3B0aW9ucz86IHsgZGVzY3JpcHRpb24/OiBzdHJpbmc7IGRlZmF1bHQ/OiBUW251bWJlcl0gfSxcbik6IFRVbnNhZmU8VFtudW1iZXJdPiB7XG5cdHJldHVybiBUeXBlLlVuc2FmZTxUW251bWJlcl0+KHtcblx0XHR0eXBlOiBcInN0cmluZ1wiLFxuXHRcdGVudW06IHZhbHVlcyBhcyBhbnksXG5cdFx0Li4uKG9wdGlvbnM/LmRlc2NyaXB0aW9uICYmIHsgZGVzY3JpcHRpb246IG9wdGlvbnMuZGVzY3JpcHRpb24gfSksXG5cdFx0Li4uKG9wdGlvbnM/LmRlZmF1bHQgJiYgeyBkZWZhdWx0OiBvcHRpb25zLmRlZmF1bHQgfSksXG5cdH0pO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFNjb3JpbmcgZXZhbHVhdGUgc2NyaXB0IFx1MjAxNCBydW5zIGVudGlyZWx5IGluLWJyb3dzZXIgdmlhIHBhZ2UuZXZhbHVhdGUoKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogQnVpbGRzIGEgc2VsZi1jb250YWluZWQgSUlGRSBzdHJpbmcgdGhhdCBzY29yZXMgY2FuZGlkYXRlIGVsZW1lbnRzIGZvciBhXG4gKiBnaXZlbiBpbnRlbnQuIFJldHVybnMgdG9wIDUgY2FuZGlkYXRlcyBzb3J0ZWQgYnkgc2NvcmUgZGVzY2VuZGluZywgZWFjaFxuICogd2l0aCB7IHNjb3JlLCBzZWxlY3RvciwgdGFnLCByb2xlLCBuYW1lLCB0ZXh0LCByZWFzb24gfS5cbiAqXG4gKiBVc2VzIHdpbmRvdy5fX3BpIHV0aWxpdGllcyAoaW5qZWN0ZWQgdmlhIGFkZEluaXRTY3JpcHQpIGZvciBlbGVtZW50XG4gKiBtZXRhZGF0YSBcdTIwMTQgbm8gaW5saW5lIHJlZGVjbGFyYXRpb25zLlxuICovXG4vLyBFeHBvcnRlZCBmb3IgdGVzdHMgb25seSAoc2VlIHRlc3RzL2Jyb3dzZXItdG9vbHMtaW50ZWdyYXRpb24udGVzdC5tanMpLlxuLy8gS2VlcCB0aGlzIGZ1bmN0aW9uIHRyZWF0ZWQgYXMgbW9kdWxlLXByaXZhdGUgZm9yIHByb2R1Y3Rpb24gY2FsbCBzaXRlcyBcdTIwMTRcbi8vIHRoZSBvbmx5IGxlZ2l0aW1hdGUgZXh0ZXJuYWwgY2FsbGVyIGlzIHRoZSBQbGF5d3JpZ2h0LWRyaXZlbiBpbnRlZ3JhdGlvblxuLy8gc3VpdGUgdGhhdCBuZWVkcyB0byBldmFsdWF0ZSB0aGUgcmV0dXJuZWQgSUlGRSBhZ2FpbnN0IHJlYWwgRE9NLlxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkSW50ZW50U2NvcmluZ1NjcmlwdChpbnRlbnQ6IHN0cmluZywgc2NvcGU/OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBzY29wZVNlbGVjdG9yID0gSlNPTi5zdHJpbmdpZnkoc2NvcGUgPz8gbnVsbCk7XG5cblx0cmV0dXJuIGAoKCkgPT4ge1xuXHR2YXIgcGkgPSB3aW5kb3cuX19waTtcblx0aWYgKCFwaSkgcmV0dXJuIHsgZXJyb3I6IFwid2luZG93Ll9fcGkgbm90IGF2YWlsYWJsZSBcdTIwMTQgYnJvd3NlciBoZWxwZXJzIG5vdCBpbmplY3RlZFwiIH07XG5cblx0dmFyIGludGVudFJhdyA9ICR7SlNPTi5zdHJpbmdpZnkoaW50ZW50KX07XG5cdHZhciBub3JtYWxpemVkID0gaW50ZW50UmF3LnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW1xcXFxzX1xcXFwtXSsvZywgXCJcIik7XG5cdHZhciBzY29wZVNlbCA9ICR7c2NvcGVTZWxlY3Rvcn07XG5cdHZhciByb290ID0gc2NvcGVTZWwgPyBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKHNjb3BlU2VsKSA6IGRvY3VtZW50LmJvZHk7XG5cdGlmICghcm9vdCkgcmV0dXJuIHsgZXJyb3I6IFwiU2NvcGUgc2VsZWN0b3Igbm90IGZvdW5kOiBcIiArIHNjb3BlU2VsIH07XG5cblx0Ly8gLS0tIFNoYXJlZCBoZWxwZXJzIC0tLVxuXHRmdW5jdGlvbiB0ZXh0T2YoZWwpIHtcblx0XHRyZXR1cm4gKGVsLnRleHRDb250ZW50IHx8IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXFxccysvZywgXCIgXCIpLnNsaWNlKDAsIDEyMCkudG9Mb3dlckNhc2UoKTtcblx0fVxuXG5cdGZ1bmN0aW9uIGNsYW1wMDEodikgeyByZXR1cm4gTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgdikpOyB9XG5cblx0ZnVuY3Rpb24gbWFrZUNhbmRpZGF0ZShlbCwgc2NvcmUsIHJlYXNvbikge1xuXHRcdHJldHVybiB7XG5cdFx0XHRzY29yZTogTWF0aC5yb3VuZChjbGFtcDAxKHNjb3JlKSAqIDEwMCkgLyAxMDAsXG5cdFx0XHRzZWxlY3RvcjogcGkuY3NzUGF0aChlbCksXG5cdFx0XHR0YWc6IGVsLnRhZ05hbWUudG9Mb3dlckNhc2UoKSxcblx0XHRcdHJvbGU6IHBpLmluZmVyUm9sZShlbCkgfHwgXCJcIixcblx0XHRcdG5hbWU6IHBpLmFjY2Vzc2libGVOYW1lKGVsKSB8fCBcIlwiLFxuXHRcdFx0dGV4dDogdGV4dE9mKGVsKS5zbGljZSgwLCA4MCksXG5cdFx0XHRyZWFzb246IHJlYXNvbixcblx0XHR9O1xuXHR9XG5cblx0ZnVuY3Rpb24gcXNhKHNlbCkgeyByZXR1cm4gQXJyYXkuZnJvbShyb290LnF1ZXJ5U2VsZWN0b3JBbGwoc2VsKSk7IH1cblxuXHRmdW5jdGlvbiB2aXNpYmxlRW5hYmxlZChlbCkge1xuXHRcdHJldHVybiBwaS5pc1Zpc2libGUoZWwpICYmIHBpLmlzRW5hYmxlZChlbCk7XG5cdH1cblxuXHRmdW5jdGlvbiB0ZXh0TWF0Y2hlcyhlbCwgcGF0dGVybnMpIHtcblx0XHR2YXIgdCA9IHRleHRPZihlbCk7XG5cdFx0dmFyIG4gPSAocGkuYWNjZXNzaWJsZU5hbWUoZWwpIHx8IFwiXCIpLnRvTG93ZXJDYXNlKCk7XG5cdFx0dmFyIGNvbWJpbmVkID0gdCArIFwiIFwiICsgbjtcblx0XHRmb3IgKHZhciBpID0gMDsgaSA8IHBhdHRlcm5zLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRpZiAoY29tYmluZWQuaW5kZXhPZihwYXR0ZXJuc1tpXSkgIT09IC0xKSByZXR1cm4gdHJ1ZTtcblx0XHR9XG5cdFx0cmV0dXJuIGZhbHNlO1xuXHR9XG5cblx0ZnVuY3Rpb24gdGV4dE1hdGNoU3RyZW5ndGgoZWwsIHBhdHRlcm5zKSB7XG5cdFx0dmFyIHQgPSB0ZXh0T2YoZWwpO1xuXHRcdHZhciBuID0gKHBpLmFjY2Vzc2libGVOYW1lKGVsKSB8fCBcIlwiKS50b0xvd2VyQ2FzZSgpO1xuXHRcdHZhciBjb21iaW5lZCA9IHQgKyBcIiBcIiArIG47XG5cdFx0dmFyIGNvdW50ID0gMDtcblx0XHRmb3IgKHZhciBpID0gMDsgaSA8IHBhdHRlcm5zLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRpZiAoY29tYmluZWQuaW5kZXhPZihwYXR0ZXJuc1tpXSkgIT09IC0xKSBjb3VudCsrO1xuXHRcdH1cblx0XHRyZXR1cm4gTWF0aC5taW4oY291bnQgLyBNYXRoLm1heChwYXR0ZXJucy5sZW5ndGgsIDEpLCAxKTtcblx0fVxuXG5cdC8vIC0tLSBJbnRlbnQtc3BlY2lmaWMgc2NvcmluZyAtLS1cblx0dmFyIGNhbmRpZGF0ZXMgPSBbXTtcblxuXHRpZiAobm9ybWFsaXplZCA9PT0gXCJzdWJtaXRmb3JtXCIpIHtcblx0XHR2YXIgZWxzID0gcXNhKCdidXR0b25bdHlwZT1cInN1Ym1pdFwiXSwgaW5wdXRbdHlwZT1cInN1Ym1pdFwiXSwgYnV0dG9uOm5vdChbdHlwZV0pLCBidXR0b25bdHlwZT1cImJ1dHRvblwiXScpO1xuXHRcdGZvciAodmFyIGkgPSAwOyBpIDwgZWxzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHR2YXIgZWwgPSBlbHNbaV07XG5cdFx0XHRpZiAoIXZpc2libGVFbmFibGVkKGVsKSkgY29udGludWU7XG5cdFx0XHR2YXIgZDEgPSBlbC50eXBlID09PSBcInN1Ym1pdFwiIHx8IGVsLmdldEF0dHJpYnV0ZShcInR5cGVcIikgPT09IFwic3VibWl0XCIgPyAwLjM1IDogMDtcblx0XHRcdHZhciBkMiA9IGVsLmNsb3Nlc3QoXCJmb3JtXCIpID8gMC4zIDogMDtcblx0XHRcdHZhciBkMyA9IHRleHRNYXRjaGVzKGVsLCBbXCJzdWJtaXRcIiwgXCJzZW5kXCIsIFwic2F2ZVwiLCBcImNyZWF0ZVwiLCBcImFkZFwiLCBcInBvc3RcIiwgXCJjb25maXJtXCIsIFwib2tcIiwgXCJkb25lXCIsIFwicmVnaXN0ZXJcIiwgXCJzaWduIHVwXCIsIFwibG9nIGluXCJdKSA/IDAuMiA6IDA7XG5cdFx0XHR2YXIgZDQgPSAwLjE1O1xuXHRcdFx0dmFyIHNjb3JlID0gZDEgKyBkMiArIGQzICsgZDQ7XG5cdFx0XHR2YXIgcmVhc29ucyA9IFtdO1xuXHRcdFx0aWYgKGQxID4gMCkgcmVhc29ucy5wdXNoKFwic3VibWl0LXR5cGVcIik7XG5cdFx0XHRpZiAoZDIgPiAwKSByZWFzb25zLnB1c2goXCJpbnNpZGUtZm9ybVwiKTtcblx0XHRcdGlmIChkMyA+IDApIHJlYXNvbnMucHVzaChcInRleHQtc3VnZ2VzdHMtc3VibWl0XCIpO1xuXHRcdFx0cmVhc29ucy5wdXNoKFwidmlzaWJsZStlbmFibGVkXCIpO1xuXHRcdFx0Y2FuZGlkYXRlcy5wdXNoKG1ha2VDYW5kaWRhdGUoZWwsIHNjb3JlLCByZWFzb25zLmpvaW4oXCIsIFwiKSkpO1xuXHRcdH1cblx0fVxuXG5cdGVsc2UgaWYgKG5vcm1hbGl6ZWQgPT09IFwiY2xvc2VkaWFsb2dcIikge1xuXHRcdHZhciBjb250YWluZXJzID0gcXNhKCdbcm9sZT1cImRpYWxvZ1wiXSwgZGlhbG9nLCBbYXJpYS1tb2RhbD1cInRydWVcIl0sIFtyb2xlPVwiYWxlcnRkaWFsb2dcIl0nKTtcblx0XHRmb3IgKHZhciBjaSA9IDA7IGNpIDwgY29udGFpbmVycy5sZW5ndGg7IGNpKyspIHtcblx0XHRcdHZhciBidG5zID0gY29udGFpbmVyc1tjaV0ucXVlcnlTZWxlY3RvckFsbChcImJ1dHRvbiwgYSwgW3JvbGU9J2J1dHRvbiddXCIpO1xuXHRcdFx0Zm9yICh2YXIgYmkgPSAwOyBiaSA8IGJ0bnMubGVuZ3RoOyBiaSsrKSB7XG5cdFx0XHRcdHZhciBlbCA9IGJ0bnNbYmldO1xuXHRcdFx0XHRpZiAoIXZpc2libGVFbmFibGVkKGVsKSkgY29udGludWU7XG5cdFx0XHRcdHZhciBkMSA9IHRleHRNYXRjaGVzKGVsLCBbXCJjbG9zZVwiLCBcImNhbmNlbFwiLCBcImRpc21pc3NcIiwgXCJcdTAwRDdcIiwgXCJcdTI3MTVcIiwgXCJ4XCIsIFwiZ290IGl0XCIsIFwib2tcIiwgXCJkb25lXCJdKSA/IDAuMzUgOiAwO1xuXHRcdFx0XHR2YXIgYXJpYUxibCA9IChlbC5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpIHx8IFwiXCIpLnRvTG93ZXJDYXNlKCk7XG5cdFx0XHRcdHZhciBkMiA9IChhcmlhTGJsLmluZGV4T2YoXCJjbG9zZVwiKSAhPT0gLTEgfHwgYXJpYUxibC5pbmRleE9mKFwiZGlzbWlzc1wiKSAhPT0gLTEpID8gMC4yNSA6IDA7XG5cdFx0XHRcdHZhciBkMyA9IDAuMjtcblx0XHRcdFx0dmFyIHJlY3QgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcblx0XHRcdFx0dmFyIHBhcmVudFJlY3QgPSBjb250YWluZXJzW2NpXS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcblx0XHRcdFx0dmFyIGlzVG9wUmlnaHQgPSByZWN0LnRvcCAtIHBhcmVudFJlY3QudG9wIDwgNjAgJiYgcGFyZW50UmVjdC5yaWdodCAtIHJlY3QucmlnaHQgPCA2MDtcblx0XHRcdFx0dmFyIGQ0ID0gaXNUb3BSaWdodCA/IDAuMiA6IDA7XG5cdFx0XHRcdHZhciBzY29yZSA9IGQxICsgZDIgKyBkMyArIGQ0O1xuXHRcdFx0XHR2YXIgcmVhc29ucyA9IFtdO1xuXHRcdFx0XHRpZiAoZDEgPiAwKSByZWFzb25zLnB1c2goXCJ0ZXh0LW1hdGNoZXMtY2xvc2VcIik7XG5cdFx0XHRcdGlmIChkMiA+IDApIHJlYXNvbnMucHVzaChcImFyaWEtbGFiZWwtY2xvc2VcIik7XG5cdFx0XHRcdHJlYXNvbnMucHVzaChcImluc2lkZS1kaWFsb2dcIik7XG5cdFx0XHRcdGlmIChkNCA+IDApIHJlYXNvbnMucHVzaChcInRvcC1yaWdodC1wb3NpdGlvblwiKTtcblx0XHRcdFx0Y2FuZGlkYXRlcy5wdXNoKG1ha2VDYW5kaWRhdGUoZWwsIHNjb3JlLCByZWFzb25zLmpvaW4oXCIsIFwiKSkpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdGVsc2UgaWYgKG5vcm1hbGl6ZWQgPT09IFwicHJpbWFyeWN0YVwiKSB7XG5cdFx0dmFyIGVscyA9IHFzYShcImJ1dHRvbiwgYSwgW3JvbGU9J2J1dHRvbiddLCBpbnB1dFt0eXBlPSdzdWJtaXQnXSwgaW5wdXRbdHlwZT0nYnV0dG9uJ11cIik7XG5cdFx0Zm9yICh2YXIgaSA9IDA7IGkgPCBlbHMubGVuZ3RoOyBpKyspIHtcblx0XHRcdHZhciBlbCA9IGVsc1tpXTtcblx0XHRcdGlmICghdmlzaWJsZUVuYWJsZWQoZWwpKSBjb250aW51ZTtcblx0XHRcdHZhciByZWN0ID0gZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG5cdFx0XHR2YXIgYXJlYSA9IHJlY3Qud2lkdGggKiByZWN0LmhlaWdodDtcblx0XHRcdHZhciBkMSA9IGNsYW1wMDEoYXJlYSAvIDEyMDAwKTtcblx0XHRcdHZhciByb2xlID0gcGkuaW5mZXJSb2xlKGVsKTtcblx0XHRcdHZhciBkMiA9IHJvbGUgPT09IFwiYnV0dG9uXCIgPyAwLjI1IDogKHJvbGUgPT09IFwibGlua1wiID8gMC4xIDogMC4xNSk7XG5cdFx0XHR2YXIgaXNOZWdhdGl2ZSA9IHRleHRNYXRjaGVzKGVsLCBbXCJjYW5jZWxcIiwgXCJkaXNtaXNzXCIsIFwiY2xvc2VcIiwgXCJza2lwXCIsIFwibm8gdGhhbmtzXCIsIFwibm8sIHRoYW5rc1wiLCBcIm1heWJlIGxhdGVyXCJdKTtcblx0XHRcdHZhciBkMyA9IGlzTmVnYXRpdmUgPyAwIDogMC4yO1xuXHRcdFx0dmFyIGluTWFpbiA9ICEhZWwuY2xvc2VzdChcIm1haW4sIFtyb2xlPSdtYWluJ10sIGFydGljbGUsIHNlY3Rpb24sIC5oZXJvLCAuY29udGVudFwiKTtcblx0XHRcdHZhciBkNCA9IGluTWFpbiA/IDAuMTUgOiAwO1xuXHRcdFx0dmFyIHNjb3JlID0gZDEgKyBkMiArIGQzICsgZDQ7XG5cdFx0XHR2YXIgcmVhc29ucyA9IFtdO1xuXHRcdFx0cmVhc29ucy5wdXNoKFwic2l6ZTpcIiArIE1hdGgucm91bmQoYXJlYSkpO1xuXHRcdFx0aWYgKGQyID49IDAuMjUpIHJlYXNvbnMucHVzaChcImJ1dHRvbi1yb2xlXCIpO1xuXHRcdFx0aWYgKGQzID4gMCkgcmVhc29ucy5wdXNoKFwibm9uLWRpc21pc3NpdmVcIik7XG5cdFx0XHRpZiAoZDQgPiAwKSByZWFzb25zLnB1c2goXCJpbi1tYWluLWNvbnRlbnRcIik7XG5cdFx0XHRjYW5kaWRhdGVzLnB1c2gobWFrZUNhbmRpZGF0ZShlbCwgc2NvcmUsIHJlYXNvbnMuam9pbihcIiwgXCIpKSk7XG5cdFx0fVxuXHR9XG5cblx0ZWxzZSBpZiAobm9ybWFsaXplZCA9PT0gXCJzZWFyY2hmaWVsZFwiKSB7XG5cdFx0dmFyIGVscyA9IHFzYShcImlucHV0LCB0ZXh0YXJlYSwgW3JvbGU9J3NlYXJjaGJveCddLCBbcm9sZT0nY29tYm9ib3gnXSwgW2NvbnRlbnRlZGl0YWJsZT0ndHJ1ZSddXCIpO1xuXHRcdGZvciAodmFyIGkgPSAwOyBpIDwgZWxzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHR2YXIgZWwgPSBlbHNbaV07XG5cdFx0XHRpZiAoIXBpLmlzVmlzaWJsZShlbCkpIGNvbnRpbnVlO1xuXHRcdFx0dmFyIHR5cGUgPSAoZWwuZ2V0QXR0cmlidXRlKFwidHlwZVwiKSB8fCBcInRleHRcIikudG9Mb3dlckNhc2UoKTtcblx0XHRcdGlmIChbXCJoaWRkZW5cIiwgXCJzdWJtaXRcIiwgXCJidXR0b25cIiwgXCJyZXNldFwiLCBcImltYWdlXCIsIFwiY2hlY2tib3hcIiwgXCJyYWRpb1wiLCBcImZpbGVcIl0uaW5kZXhPZih0eXBlKSAhPT0gLTEgJiYgZWwudGFnTmFtZS50b0xvd2VyQ2FzZSgpID09PSBcImlucHV0XCIpIGNvbnRpbnVlO1xuXHRcdFx0dmFyIGQxID0gdHlwZSA9PT0gXCJzZWFyY2hcIiB8fCBwaS5pbmZlclJvbGUoZWwpID09PSBcInNlYXJjaGJveFwiID8gMC40IDogMDtcblx0XHRcdHZhciBwaCA9IChlbC5nZXRBdHRyaWJ1dGUoXCJwbGFjZWhvbGRlclwiKSB8fCBcIlwiKS50b0xvd2VyQ2FzZSgpO1xuXHRcdFx0dmFyIG5tID0gKGVsLmdldEF0dHJpYnV0ZShcIm5hbWVcIikgfHwgXCJcIikudG9Mb3dlckNhc2UoKTtcblx0XHRcdHZhciBhcmlhTGJsID0gKGVsLmdldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIikgfHwgXCJcIikudG9Mb3dlckNhc2UoKTtcblx0XHRcdHZhciBjb21iaW5lZCA9IHBoICsgXCIgXCIgKyBubSArIFwiIFwiICsgYXJpYUxibDtcblx0XHRcdHZhciBkMiA9IGNvbWJpbmVkLmluZGV4T2YoXCJzZWFyY2hcIikgIT09IC0xIHx8IGNvbWJpbmVkLmluZGV4T2YoXCJxdWVyeVwiKSAhPT0gLTEgfHwgY29tYmluZWQuaW5kZXhPZihcImZpbmRcIikgIT09IC0xID8gMC4zIDogMDtcblx0XHRcdHZhciBkMyA9IHBpLmlzRW5hYmxlZChlbCkgPyAwLjE1IDogMDtcblx0XHRcdHZhciBpbkhlYWRlciA9ICEhZWwuY2xvc2VzdChcImhlYWRlciwgbmF2LCBbcm9sZT0nYmFubmVyJ10sIFtyb2xlPSduYXZpZ2F0aW9uJ10sIFtyb2xlPSdzZWFyY2gnXVwiKTtcblx0XHRcdHZhciBkNCA9IGluSGVhZGVyID8gMC4xNSA6IDA7XG5cdFx0XHR2YXIgc2NvcmUgPSBkMSArIGQyICsgZDMgKyBkNDtcblx0XHRcdGlmIChzY29yZSA8IDAuMSkgY29udGludWU7XG5cdFx0XHR2YXIgcmVhc29ucyA9IFtdO1xuXHRcdFx0aWYgKGQxID4gMCkgcmVhc29ucy5wdXNoKFwic2VhcmNoLXR5cGUvcm9sZVwiKTtcblx0XHRcdGlmIChkMiA+IDApIHJlYXNvbnMucHVzaChcIm5hbWUvcGxhY2Vob2xkZXItbWF0Y2hcIik7XG5cdFx0XHRpZiAoZDMgPiAwKSByZWFzb25zLnB1c2goXCJlbmFibGVkXCIpO1xuXHRcdFx0aWYgKGQ0ID4gMCkgcmVhc29ucy5wdXNoKFwiaW4taGVhZGVyL25hdlwiKTtcblx0XHRcdGNhbmRpZGF0ZXMucHVzaChtYWtlQ2FuZGlkYXRlKGVsLCBzY29yZSwgcmVhc29ucy5qb2luKFwiLCBcIikpKTtcblx0XHR9XG5cdH1cblxuXHRlbHNlIGlmIChub3JtYWxpemVkID09PSBcIm5leHRzdGVwXCIpIHtcblx0XHR2YXIgZWxzID0gcXNhKFwiYnV0dG9uLCBhLCBbcm9sZT0nYnV0dG9uJ10sIGlucHV0W3R5cGU9J3N1Ym1pdCddLCBpbnB1dFt0eXBlPSdidXR0b24nXVwiKTtcblx0XHR2YXIgcGF0dGVybnMgPSBbXCJuZXh0XCIsIFwiY29udGludWVcIiwgXCJwcm9jZWVkXCIsIFwiZm9yd2FyZFwiLCBcImdvXCIsIFwic3RlcFwiXTtcblx0XHRmb3IgKHZhciBpID0gMDsgaSA8IGVscy5sZW5ndGg7IGkrKykge1xuXHRcdFx0dmFyIGVsID0gZWxzW2ldO1xuXHRcdFx0aWYgKCF2aXNpYmxlRW5hYmxlZChlbCkpIGNvbnRpbnVlO1xuXHRcdFx0dmFyIGQxID0gdGV4dE1hdGNoU3RyZW5ndGgoZWwsIHBhdHRlcm5zKSAqIDAuNDtcblx0XHRcdGlmIChkMSA9PT0gMCkgY29udGludWU7XG5cdFx0XHR2YXIgcm9sZSA9IHBpLmluZmVyUm9sZShlbCk7XG5cdFx0XHR2YXIgZDIgPSByb2xlID09PSBcImJ1dHRvblwiID8gMC4yNSA6IDAuMTtcblx0XHRcdHZhciBkMyA9IDAuMjtcblx0XHRcdHZhciBpc0Rpc2FibGVkID0gIXBpLmlzRW5hYmxlZChlbCk7XG5cdFx0XHR2YXIgZDQgPSBpc0Rpc2FibGVkID8gMCA6IDAuMTU7XG5cdFx0XHR2YXIgc2NvcmUgPSBkMSArIGQyICsgZDMgKyBkNDtcblx0XHRcdHZhciByZWFzb25zID0gW107XG5cdFx0XHRyZWFzb25zLnB1c2goXCJ0ZXh0LW1hdGNoXCIpO1xuXHRcdFx0aWYgKGQyID49IDAuMjUpIHJlYXNvbnMucHVzaChcImJ1dHRvbi1yb2xlXCIpO1xuXHRcdFx0cmVhc29ucy5wdXNoKFwidmlzaWJsZVwiKTtcblx0XHRcdGlmIChkNCA+IDApIHJlYXNvbnMucHVzaChcImVuYWJsZWRcIik7XG5cdFx0XHRjYW5kaWRhdGVzLnB1c2gobWFrZUNhbmRpZGF0ZShlbCwgc2NvcmUsIHJlYXNvbnMuam9pbihcIiwgXCIpKSk7XG5cdFx0fVxuXHR9XG5cblx0ZWxzZSBpZiAobm9ybWFsaXplZCA9PT0gXCJkaXNtaXNzXCIpIHtcblx0XHR2YXIgZWxzID0gcXNhKFwiYnV0dG9uLCBhLCBbcm9sZT0nYnV0dG9uJ10sIFtyb2xlPSdsaW5rJ11cIik7XG5cdFx0dmFyIHBhdHRlcm5zID0gW1wiY2xvc2VcIiwgXCJjYW5jZWxcIiwgXCJkaXNtaXNzXCIsIFwic2tpcFwiLCBcIm5vIHRoYW5rc1wiLCBcIm5vLCB0aGFua3NcIiwgXCJtYXliZSBsYXRlclwiLCBcIm5vdCBub3dcIiwgXCJcdTAwRDdcIiwgXCJcdTI3MTVcIl07XG5cdFx0Zm9yICh2YXIgaSA9IDA7IGkgPCBlbHMubGVuZ3RoOyBpKyspIHtcblx0XHRcdHZhciBlbCA9IGVsc1tpXTtcblx0XHRcdGlmICghdmlzaWJsZUVuYWJsZWQoZWwpKSBjb250aW51ZTtcblx0XHRcdHZhciBkMSA9IHRleHRNYXRjaFN0cmVuZ3RoKGVsLCBwYXR0ZXJucykgKiAwLjM1O1xuXHRcdFx0aWYgKGQxID09PSAwKSBjb250aW51ZTtcblx0XHRcdHZhciBpbk92ZXJsYXkgPSAhIWVsLmNsb3Nlc3QoJ1tyb2xlPVwiZGlhbG9nXCJdLCBkaWFsb2csIFthcmlhLW1vZGFsPVwidHJ1ZVwiXSwgW3JvbGU9XCJhbGVydGRpYWxvZ1wiXSwgLm1vZGFsLCAub3ZlcmxheSwgLnBvcHVwLCAucG9wb3ZlciwgLnRvYXN0LCAuYmFubmVyJyk7XG5cdFx0XHR2YXIgZDIgPSBpbk92ZXJsYXkgPyAwLjMgOiAwLjA1O1xuXHRcdFx0dmFyIHJlY3QgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcblx0XHRcdHZhciBpc0VkZ2UgPSByZWN0LnRvcCA8IDgwIHx8IHJlY3QucmlnaHQgPiB3aW5kb3cuaW5uZXJXaWR0aCAtIDgwO1xuXHRcdFx0dmFyIGQzID0gaXNFZGdlID8gMC4xNSA6IDA7XG5cdFx0XHR2YXIgZDQgPSAwLjE1O1xuXHRcdFx0dmFyIHNjb3JlID0gZDEgKyBkMiArIGQzICsgZDQ7XG5cdFx0XHR2YXIgcmVhc29ucyA9IFtdO1xuXHRcdFx0cmVhc29ucy5wdXNoKFwidGV4dC1tYXRjaFwiKTtcblx0XHRcdGlmIChkMiA+PSAwLjMpIHJlYXNvbnMucHVzaChcImluc2lkZS1vdmVybGF5XCIpO1xuXHRcdFx0aWYgKGQzID4gMCkgcmVhc29ucy5wdXNoKFwiZWRnZS1wb3NpdGlvblwiKTtcblx0XHRcdHJlYXNvbnMucHVzaChcInZpc2libGUrZW5hYmxlZFwiKTtcblx0XHRcdGNhbmRpZGF0ZXMucHVzaChtYWtlQ2FuZGlkYXRlKGVsLCBzY29yZSwgcmVhc29ucy5qb2luKFwiLCBcIikpKTtcblx0XHR9XG5cdH1cblxuXHRlbHNlIGlmIChub3JtYWxpemVkID09PSBcImF1dGhhY3Rpb25cIikge1xuXHRcdHZhciBlbHMgPSBxc2EoXCJidXR0b24sIGEsIFtyb2xlPSdidXR0b24nXSwgW3JvbGU9J2xpbmsnXSwgaW5wdXRbdHlwZT0nc3VibWl0J11cIik7XG5cdFx0dmFyIHBhdHRlcm5zID0gW1wibG9nIGluXCIsIFwibG9naW5cIiwgXCJzaWduIGluXCIsIFwic2lnbmluXCIsIFwic2lnbiB1cFwiLCBcInNpZ251cFwiLCBcInJlZ2lzdGVyXCIsIFwiY3JlYXRlIGFjY291bnRcIiwgXCJqb2luXCIsIFwiZ2V0IHN0YXJ0ZWRcIl07XG5cdFx0Zm9yICh2YXIgaSA9IDA7IGkgPCBlbHMubGVuZ3RoOyBpKyspIHtcblx0XHRcdHZhciBlbCA9IGVsc1tpXTtcblx0XHRcdGlmICghdmlzaWJsZUVuYWJsZWQoZWwpKSBjb250aW51ZTtcblx0XHRcdHZhciBkMSA9IHRleHRNYXRjaFN0cmVuZ3RoKGVsLCBwYXR0ZXJucykgKiAwLjQ7XG5cdFx0XHRpZiAoZDEgPT09IDApIGNvbnRpbnVlO1xuXHRcdFx0dmFyIHJvbGUgPSBwaS5pbmZlclJvbGUoZWwpO1xuXHRcdFx0dmFyIGQyID0gKHJvbGUgPT09IFwiYnV0dG9uXCIgfHwgcm9sZSA9PT0gXCJsaW5rXCIpID8gMC4yNSA6IDAuMTtcblx0XHRcdHZhciByZWN0ID0gZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG5cdFx0XHR2YXIgaW5IZWFkZXIgPSAhIWVsLmNsb3Nlc3QoXCJoZWFkZXIsIG5hdiwgW3JvbGU9J2Jhbm5lciddLCBbcm9sZT0nbmF2aWdhdGlvbiddXCIpO1xuXHRcdFx0dmFyIGlzUHJvbWluZW50ID0gaW5IZWFkZXIgfHwgcmVjdC50b3AgPCAyMDA7XG5cdFx0XHR2YXIgZDMgPSBpc1Byb21pbmVudCA/IDAuMiA6IDAuMDU7XG5cdFx0XHR2YXIgZDQgPSAwLjE1O1xuXHRcdFx0dmFyIHNjb3JlID0gZDEgKyBkMiArIGQzICsgZDQ7XG5cdFx0XHR2YXIgcmVhc29ucyA9IFtdO1xuXHRcdFx0cmVhc29ucy5wdXNoKFwidGV4dC1tYXRjaFwiKTtcblx0XHRcdGlmIChkMiA+PSAwLjI1KSByZWFzb25zLnB1c2goXCJidXR0b24tb3ItbGlua1wiKTtcblx0XHRcdGlmIChkMyA+PSAwLjIpIHJlYXNvbnMucHVzaChcInByb21pbmVudC1wb3NpdGlvblwiKTtcblx0XHRcdHJlYXNvbnMucHVzaChcInZpc2libGUrZW5hYmxlZFwiKTtcblx0XHRcdGNhbmRpZGF0ZXMucHVzaChtYWtlQ2FuZGlkYXRlKGVsLCBzY29yZSwgcmVhc29ucy5qb2luKFwiLCBcIikpKTtcblx0XHR9XG5cdH1cblxuXHRlbHNlIGlmIChub3JtYWxpemVkID09PSBcImJhY2tuYXZpZ2F0aW9uXCIpIHtcblx0XHR2YXIgZWxzID0gcXNhKFwiYnV0dG9uLCBhLCBbcm9sZT0nYnV0dG9uJ10sIFtyb2xlPSdsaW5rJ11cIik7XG5cdFx0dmFyIHBhdHRlcm5zID0gW1wiYmFja1wiLCBcInByZXZpb3VzXCIsIFwicHJldlwiLCBcInJldHVyblwiLCBcImdvIGJhY2tcIl07XG5cdFx0Zm9yICh2YXIgaSA9IDA7IGkgPCBlbHMubGVuZ3RoOyBpKyspIHtcblx0XHRcdHZhciBlbCA9IGVsc1tpXTtcblx0XHRcdGlmICghdmlzaWJsZUVuYWJsZWQoZWwpKSBjb250aW51ZTtcblx0XHRcdHZhciBkMSA9IHRleHRNYXRjaFN0cmVuZ3RoKGVsLCBwYXR0ZXJucykgKiAwLjM1O1xuXHRcdFx0aWYgKGQxID09PSAwKSBjb250aW51ZTtcblx0XHRcdHZhciBpbm5lckh0bWwgPSBlbC5pbm5lckhUTUwudG9Mb3dlckNhc2UoKTtcblx0XHRcdHZhciBoYXNBcnJvdyA9IGlubmVySHRtbC5pbmRleE9mKFwiXHUyMTkwXCIpICE9PSAtMSB8fCBpbm5lckh0bWwuaW5kZXhPZihcIiZsYXJyXCIpICE9PSAtMSB8fCBpbm5lckh0bWwuaW5kZXhPZihcImFycm93XCIpICE9PSAtMSB8fCBpbm5lckh0bWwuaW5kZXhPZihcImNoZXZyb24tbGVmdFwiKSAhPT0gLTEgfHwgaW5uZXJIdG1sLmluZGV4T2YoXCJiYWNrXCIpICE9PSAtMTtcblx0XHRcdHZhciBkMiA9IGhhc0Fycm93ID8gMC4yNSA6IDA7XG5cdFx0XHR2YXIgaW5OYXYgPSAhIWVsLmNsb3Nlc3QoXCJoZWFkZXIsIG5hdiwgW3JvbGU9J2Jhbm5lciddLCBbcm9sZT0nbmF2aWdhdGlvbiddLCAuYnJlYWRjcnVtYiwgLnRvb2xiYXJcIik7XG5cdFx0XHR2YXIgZDMgPSBpbk5hdiA/IDAuMjUgOiAwLjA1O1xuXHRcdFx0dmFyIGQ0ID0gMC4xNTtcblx0XHRcdHZhciBzY29yZSA9IGQxICsgZDIgKyBkMyArIGQ0O1xuXHRcdFx0dmFyIHJlYXNvbnMgPSBbXTtcblx0XHRcdHJlYXNvbnMucHVzaChcInRleHQtbWF0Y2hcIik7XG5cdFx0XHRpZiAoZDIgPiAwKSByZWFzb25zLnB1c2goXCJoYXMtYmFjay1hcnJvdy9pY29uXCIpO1xuXHRcdFx0aWYgKGQzID49IDAuMjUpIHJlYXNvbnMucHVzaChcImluLW5hdi9oZWFkZXJcIik7XG5cdFx0XHRyZWFzb25zLnB1c2goXCJ2aXNpYmxlK2VuYWJsZWRcIik7XG5cdFx0XHRjYW5kaWRhdGVzLnB1c2gobWFrZUNhbmRpZGF0ZShlbCwgc2NvcmUsIHJlYXNvbnMuam9pbihcIiwgXCIpKSk7XG5cdFx0fVxuXHR9XG5cblx0ZWxzZSB7XG5cdFx0cmV0dXJuIHsgZXJyb3I6IFwiVW5rbm93biBpbnRlbnQ6IFwiICsgaW50ZW50UmF3ICsgXCIuIFZhbGlkOiBzdWJtaXRfZm9ybSwgY2xvc2VfZGlhbG9nLCBwcmltYXJ5X2N0YSwgc2VhcmNoX2ZpZWxkLCBuZXh0X3N0ZXAsIGRpc21pc3MsIGF1dGhfYWN0aW9uLCBiYWNrX25hdmlnYXRpb25cIiB9O1xuXHR9XG5cblx0Ly8gU29ydCBieSBzY29yZSBkZXNjZW5kaW5nLCBjYXAgYXQgNVxuXHRjYW5kaWRhdGVzLnNvcnQoZnVuY3Rpb24oYSwgYikgeyByZXR1cm4gYi5zY29yZSAtIGEuc2NvcmU7IH0pO1xuXHRjYW5kaWRhdGVzID0gY2FuZGlkYXRlcy5zbGljZSgwLCA1KTtcblxuXHRyZXR1cm4geyBpbnRlbnQ6IGludGVudFJhdywgbm9ybWFsaXplZDogbm9ybWFsaXplZCwgY291bnQ6IGNhbmRpZGF0ZXMubGVuZ3RoLCBjYW5kaWRhdGVzOiBjYW5kaWRhdGVzIH07XG59KSgpYDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBSZXN1bHQgdHlwZXNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5pbnRlcmZhY2UgSW50ZW50Q2FuZGlkYXRlIHtcblx0c2NvcmU6IG51bWJlcjtcblx0c2VsZWN0b3I6IHN0cmluZztcblx0dGFnOiBzdHJpbmc7XG5cdHJvbGU6IHN0cmluZztcblx0bmFtZTogc3RyaW5nO1xuXHR0ZXh0OiBzdHJpbmc7XG5cdHJlYXNvbjogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgSW50ZW50U2NvcmluZ1Jlc3VsdCB7XG5cdGludGVudDogc3RyaW5nO1xuXHRub3JtYWxpemVkOiBzdHJpbmc7XG5cdGNvdW50OiBudW1iZXI7XG5cdGNhbmRpZGF0ZXM6IEludGVudENhbmRpZGF0ZVtdO1xuXHRlcnJvcj86IHN0cmluZztcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBSZWdpc3RyYXRpb25cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJJbnRlbnRUb29scyhwaTogRXh0ZW5zaW9uQVBJLCBkZXBzOiBUb29sRGVwcyk6IHZvaWQge1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfZmluZF9iZXN0XG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX2ZpbmRfYmVzdFwiLFxuXHRcdGxhYmVsOiBcIkZpbmQgQmVzdFwiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJGaW5kIHRoZSBiZXN0LW1hdGNoaW5nIGVsZW1lbnQgZm9yIGEgc2VtYW50aWMgaW50ZW50LiBSZXR1cm5zIHVwIHRvIDUgc2NvcmVkIGNhbmRpZGF0ZXMgKDAtMSkgcmFua2VkIGJ5IHN0cnVjdHVyYWwgcG9zaXRpb24sIHJvbGUsIHRleHQgc2lnbmFscywgYW5kIHZpc2liaWxpdHkuIFVzZSB0aGlzIHRvIGRpc2NvdmVyIHdoaWNoIGVsZW1lbnQgdGhlIGFnZW50IHNob3VsZCBpbnRlcmFjdCB3aXRoIGZvciBhIGdpdmVuIGdvYWwgXHUyMDE0IGUuZy4gaW50ZW50PVxcXCJzdWJtaXRfZm9ybVxcXCIgZmluZHMgc3VibWl0IGJ1dHRvbnMsIGludGVudD1cXFwiY2xvc2VfZGlhbG9nXFxcIiBmaW5kcyBjbG9zZS9kaXNtaXNzIGJ1dHRvbnMgaW5zaWRlIGRpYWxvZ3MuIEVhY2ggY2FuZGlkYXRlIGluY2x1ZGVzIGEgQ1NTIHNlbGVjdG9yIHVzYWJsZSB3aXRoIGJyb3dzZXJfY2xpY2suXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0aW50ZW50OiBTdHJpbmdFbnVtKElOVEVOVFMsIHtcblx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XCJTZW1hbnRpYyBpbnRlbnQ6IHN1Ym1pdF9mb3JtLCBjbG9zZV9kaWFsb2csIHByaW1hcnlfY3RhLCBzZWFyY2hfZmllbGQsIG5leHRfc3RlcCwgZGlzbWlzcywgYXV0aF9hY3Rpb24sIGJhY2tfbmF2aWdhdGlvblwiLFxuXHRcdFx0fSksXG5cdFx0XHRzY29wZTogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5TdHJpbmcoe1xuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XHRcdFx0XCJDU1Mgc2VsZWN0b3IgdG8gbmFycm93IHRoZSBzZWFyY2ggYXJlYS4gSWYgb21pdHRlZCwgc2VhcmNoZXMgdGhlIGZ1bGwgcGFnZS5cIixcblx0XHRcdFx0fSlcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0bGV0IGFjdGlvbklkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblx0XHRcdGxldCBiZWZvcmVTdGF0ZTogQ29tcGFjdFBhZ2VTdGF0ZSB8IG51bGwgPSBudWxsO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBwYWdlOiBwIH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblx0XHRcdFx0Y29uc3QgdGFyZ2V0ID0gZGVwcy5nZXRBY3RpdmVUYXJnZXQoKTtcblx0XHRcdFx0YmVmb3JlU3RhdGUgPSBhd2FpdCBkZXBzLmNhcHR1cmVDb21wYWN0UGFnZVN0YXRlKHAsIHtcblx0XHRcdFx0XHRzZWxlY3RvcnM6IHBhcmFtcy5zY29wZSA/IFtwYXJhbXMuc2NvcGVdIDogW10sXG5cdFx0XHRcdFx0aW5jbHVkZUJvZHlUZXh0OiBmYWxzZSxcblx0XHRcdFx0XHR0YXJnZXQsXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRhY3Rpb25JZCA9IGRlcHMuYmVnaW5UcmFja2VkQWN0aW9uKFwiYnJvd3Nlcl9maW5kX2Jlc3RcIiwgcGFyYW1zLCBiZWZvcmVTdGF0ZS51cmwpLmlkO1xuXG5cdFx0XHRcdGNvbnN0IHNjcmlwdCA9IGJ1aWxkSW50ZW50U2NvcmluZ1NjcmlwdChwYXJhbXMuaW50ZW50LCBwYXJhbXMuc2NvcGUpO1xuXHRcdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCB0YXJnZXQuZXZhbHVhdGUoc2NyaXB0KSBhcyBJbnRlbnRTY29yaW5nUmVzdWx0O1xuXG5cdFx0XHRcdGlmIChyZXN1bHQuZXJyb3IpIHtcblx0XHRcdFx0XHRkZXBzLmZpbmlzaFRyYWNrZWRBY3Rpb24oYWN0aW9uSWQsIHtcblx0XHRcdFx0XHRcdHN0YXR1czogXCJlcnJvclwiLFxuXHRcdFx0XHRcdFx0ZXJyb3I6IHJlc3VsdC5lcnJvcixcblx0XHRcdFx0XHRcdGJlZm9yZVN0YXRlLFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogcmVzdWx0LmVycm9yIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczoge30sXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCBhZnRlclN0YXRlID0gYXdhaXQgZGVwcy5jYXB0dXJlQ29tcGFjdFBhZ2VTdGF0ZShwLCB7XG5cdFx0XHRcdFx0c2VsZWN0b3JzOiBwYXJhbXMuc2NvcGUgPyBbcGFyYW1zLnNjb3BlXSA6IFtdLFxuXHRcdFx0XHRcdGluY2x1ZGVCb2R5VGV4dDogZmFsc2UsXG5cdFx0XHRcdFx0dGFyZ2V0LFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0c2V0TGFzdEFjdGlvbkJlZm9yZVN0YXRlKGJlZm9yZVN0YXRlKTtcblx0XHRcdFx0c2V0TGFzdEFjdGlvbkFmdGVyU3RhdGUoYWZ0ZXJTdGF0ZSk7XG5cblx0XHRcdFx0ZGVwcy5maW5pc2hUcmFja2VkQWN0aW9uKGFjdGlvbklkLCB7XG5cdFx0XHRcdFx0c3RhdHVzOiBcInN1Y2Nlc3NcIixcblx0XHRcdFx0XHRhZnRlclVybDogYWZ0ZXJTdGF0ZS51cmwsXG5cdFx0XHRcdFx0YmVmb3JlU3RhdGUsXG5cdFx0XHRcdFx0YWZ0ZXJTdGF0ZSxcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0Ly8gRm9ybWF0IG91dHB1dFxuXHRcdFx0XHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblx0XHRcdFx0bGluZXMucHVzaChgSW50ZW50OiAke3BhcmFtcy5pbnRlbnR9IFx1MjE5MiAke3Jlc3VsdC5jb3VudH0gY2FuZGlkYXRlKHMpYCk7XG5cdFx0XHRcdGlmIChwYXJhbXMuc2NvcGUpIGxpbmVzLnB1c2goYFNjb3BlOiAke3BhcmFtcy5zY29wZX1gKTtcblx0XHRcdFx0bGluZXMucHVzaChcIlwiKTtcblxuXHRcdFx0XHRpZiAocmVzdWx0LmNhbmRpZGF0ZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0bGluZXMucHVzaChcIk5vIGNhbmRpZGF0ZXMgZm91bmQgZm9yIHRoaXMgaW50ZW50IG9uIHRoZSBjdXJyZW50IHBhZ2UuXCIpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGZvciAobGV0IGkgPSAwOyBpIDwgcmVzdWx0LmNhbmRpZGF0ZXMubGVuZ3RoOyBpKyspIHtcblx0XHRcdFx0XHRcdGNvbnN0IGMgPSByZXN1bHQuY2FuZGlkYXRlc1tpXTtcblx0XHRcdFx0XHRcdGxpbmVzLnB1c2goYCR7aSArIDF9LiAqKiR7Yy5zY29yZX0qKiBcXGAke2Muc2VsZWN0b3J9XFxgYCk7XG5cdFx0XHRcdFx0XHRsaW5lcy5wdXNoKGAgICAke2MudGFnfSR7Yy5yb2xlID8gYCBbJHtjLnJvbGV9XWAgOiBcIlwifSBcdTIwMTQgXCIke2MubmFtZSB8fCBjLnRleHR9XCJgKTtcblx0XHRcdFx0XHRcdGxpbmVzLnB1c2goYCAgIFJlYXNvbjogJHtjLnJlYXNvbn1gKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBsaW5lcy5qb2luKFwiXFxuXCIpIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgaW50ZW50UmVzdWx0OiByZXN1bHQgfSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogdW5rbm93bikge1xuXHRcdFx0XHRjb25zdCBzY3JlZW5zaG90ID0gYXdhaXQgZGVwcy5jYXB0dXJlRXJyb3JTY3JlZW5zaG90KFxuXHRcdFx0XHRcdCgoKSA9PiB7IHRyeSB7IHJldHVybiBkZXBzLmdldEFjdGl2ZVBhZ2UoKTsgfSBjYXRjaCB7IHJldHVybiBudWxsOyB9IH0pKClcblx0XHRcdFx0KTtcblx0XHRcdFx0Y29uc3QgZXJyTXNnID0gZGVwcy5maXJzdEVycm9yTGluZShlcnIpO1xuXG5cdFx0XHRcdGlmIChhY3Rpb25JZCAhPT0gbnVsbCkge1xuXHRcdFx0XHRcdGRlcHMuZmluaXNoVHJhY2tlZEFjdGlvbihhY3Rpb25JZCwge1xuXHRcdFx0XHRcdFx0c3RhdHVzOiBcImVycm9yXCIsXG5cdFx0XHRcdFx0XHRlcnJvcjogZXJyTXNnLFxuXHRcdFx0XHRcdFx0YmVmb3JlU3RhdGU6IGJlZm9yZVN0YXRlID8/IHVuZGVmaW5lZCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQ6IEFycmF5PHsgdHlwZTogXCJ0ZXh0XCI7IHRleHQ6IHN0cmluZyB9IHwgeyB0eXBlOiBcImltYWdlXCI7IGRhdGE6IHN0cmluZzsgbWltZVR5cGU6IHN0cmluZyB9PiA9IFtcblx0XHRcdFx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgYnJvd3Nlcl9maW5kX2Jlc3QgZmFpbGVkOiAke2Vyck1zZ31gIH0sXG5cdFx0XHRcdF07XG5cdFx0XHRcdGlmIChzY3JlZW5zaG90KSB7XG5cdFx0XHRcdFx0Y29udGVudC5wdXNoKHsgdHlwZTogXCJpbWFnZVwiLCBkYXRhOiBzY3JlZW5zaG90LmRhdGEsIG1pbWVUeXBlOiBzY3JlZW5zaG90Lm1pbWVUeXBlIH0pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiB7IGNvbnRlbnQsIGRldGFpbHM6IHt9LCBpc0Vycm9yOiB0cnVlIH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG5cblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gYnJvd3Nlcl9hY3Rcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfYWN0XCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBBY3RcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiRXhlY3V0ZSBhIHNlbWFudGljIGFjdGlvbiBpbiBvbmUgY2FsbC4gUmVzb2x2ZXMgdGhlIHRvcCBjYW5kaWRhdGUgZm9yIHRoZSBnaXZlbiBpbnRlbnQgKHNhbWUgc2NvcmluZyBhcyBicm93c2VyX2ZpbmRfYmVzdCksIHBlcmZvcm1zIHRoZSBhY3Rpb24gKGNsaWNrIGZvciBidXR0b25zL2xpbmtzLCBmb2N1cyBmb3Igc2VhcmNoIGZpZWxkcyksIHNldHRsZXMgdGhlIHBhZ2UsIGFuZCByZXR1cm5zIGEgYmVmb3JlL2FmdGVyIGRpZmYuIFVzZSB3aGVuIHlvdSBrbm93IHdoYXQgeW91IHdhbnQgdG8gYWNjb21wbGlzaCBzZW1hbnRpY2FsbHkgXHUyMDE0IGUuZy4gaW50ZW50PVxcXCJzdWJtaXRfZm9ybVxcXCIgZmluZHMgYW5kIGNsaWNrcyB0aGUgc3VibWl0IGJ1dHRvbiwgaW50ZW50PVxcXCJjbG9zZV9kaWFsb2dcXFwiIGRpc21pc3NlcyB0aGUgZGlhbG9nLlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdGludGVudDogU3RyaW5nRW51bShJTlRFTlRTLCB7XG5cdFx0XHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XHRcdFwiU2VtYW50aWMgaW50ZW50OiBzdWJtaXRfZm9ybSwgY2xvc2VfZGlhbG9nLCBwcmltYXJ5X2N0YSwgc2VhcmNoX2ZpZWxkLCBuZXh0X3N0ZXAsIGRpc21pc3MsIGF1dGhfYWN0aW9uLCBiYWNrX25hdmlnYXRpb25cIixcblx0XHRcdH0pLFxuXHRcdFx0c2NvcGU6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFx0XHRcdFwiQ1NTIHNlbGVjdG9yIHRvIG5hcnJvdyB0aGUgc2VhcmNoIGFyZWEuIElmIG9taXR0ZWQsIHNlYXJjaGVzIHRoZSBmdWxsIHBhZ2UuXCIsXG5cdFx0XHRcdH0pXG5cdFx0XHQpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdGxldCBhY3Rpb25JZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cdFx0XHRsZXQgYmVmb3JlU3RhdGU6IENvbXBhY3RQYWdlU3RhdGUgfCBudWxsID0gbnVsbDtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHsgcGFnZTogcCB9ID0gYXdhaXQgZGVwcy5lbnN1cmVCcm93c2VyKCk7XG5cdFx0XHRcdGNvbnN0IHRhcmdldCA9IGRlcHMuZ2V0QWN0aXZlVGFyZ2V0KCk7XG5cdFx0XHRcdGJlZm9yZVN0YXRlID0gYXdhaXQgZGVwcy5jYXB0dXJlQ29tcGFjdFBhZ2VTdGF0ZShwLCB7XG5cdFx0XHRcdFx0c2VsZWN0b3JzOiBwYXJhbXMuc2NvcGUgPyBbcGFyYW1zLnNjb3BlXSA6IFtdLFxuXHRcdFx0XHRcdGluY2x1ZGVCb2R5VGV4dDogdHJ1ZSxcblx0XHRcdFx0XHR0YXJnZXQsXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRhY3Rpb25JZCA9IGRlcHMuYmVnaW5UcmFja2VkQWN0aW9uKFwiYnJvd3Nlcl9hY3RcIiwgcGFyYW1zLCBiZWZvcmVTdGF0ZS51cmwpLmlkO1xuXG5cdFx0XHRcdC8vIFNjb3JlIGNhbmRpZGF0ZXNcblx0XHRcdFx0Y29uc3Qgc2NyaXB0ID0gYnVpbGRJbnRlbnRTY29yaW5nU2NyaXB0KHBhcmFtcy5pbnRlbnQsIHBhcmFtcy5zY29wZSk7XG5cdFx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRhcmdldC5ldmFsdWF0ZShzY3JpcHQpIGFzIEludGVudFNjb3JpbmdSZXN1bHQ7XG5cblx0XHRcdFx0aWYgKHJlc3VsdC5lcnJvcikge1xuXHRcdFx0XHRcdGRlcHMuZmluaXNoVHJhY2tlZEFjdGlvbihhY3Rpb25JZCwge1xuXHRcdFx0XHRcdFx0c3RhdHVzOiBcImVycm9yXCIsXG5cdFx0XHRcdFx0XHRlcnJvcjogcmVzdWx0LmVycm9yLFxuXHRcdFx0XHRcdFx0YmVmb3JlU3RhdGUsXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgYnJvd3Nlcl9hY3QgZmFpbGVkOiAke3Jlc3VsdC5lcnJvcn1gIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczoge30sXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAocmVzdWx0LmNhbmRpZGF0ZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0ZGVwcy5maW5pc2hUcmFja2VkQWN0aW9uKGFjdGlvbklkLCB7XG5cdFx0XHRcdFx0XHRzdGF0dXM6IFwiZXJyb3JcIixcblx0XHRcdFx0XHRcdGVycm9yOiBgTm8gY2FuZGlkYXRlcyBmb3VuZCBmb3IgaW50ZW50IFwiJHtwYXJhbXMuaW50ZW50fVwiYCxcblx0XHRcdFx0XHRcdGJlZm9yZVN0YXRlLFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbe1xuXHRcdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIiBhcyBjb25zdCxcblx0XHRcdFx0XHRcdFx0dGV4dDogYGJyb3dzZXJfYWN0OiBObyBjYW5kaWRhdGVzIGZvdW5kIGZvciBpbnRlbnQgXCIke3BhcmFtcy5pbnRlbnR9XCIgb24gdGhlIGN1cnJlbnQgcGFnZS4gVGhlIHBhZ2UgbWF5IG5vdCBoYXZlIHRoZSBleHBlY3RlZCBlbGVtZW50cyAoZS5nLiBubyBkaWFsb2cgZm9yIGNsb3NlX2RpYWxvZywgbm8gZm9ybSBmb3Igc3VibWl0X2Zvcm0pLmAsXG5cdFx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgaW50ZW50UmVzdWx0OiByZXN1bHQgfSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIFRha2UgdG9wIGNhbmRpZGF0ZSBhbmQgZXhlY3V0ZSBhY3Rpb25cblx0XHRcdFx0Y29uc3QgdG9wID0gcmVzdWx0LmNhbmRpZGF0ZXNbMF07XG5cdFx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRJbnRlbnQgPSBwYXJhbXMuaW50ZW50LnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW1xcc18tXSsvZywgXCJcIik7XG5cblx0XHRcdFx0aWYgKG5vcm1hbGl6ZWRJbnRlbnQgPT09IFwic2VhcmNoZmllbGRcIikge1xuXHRcdFx0XHRcdC8vIEZvY3VzIGluc3RlYWQgb2YgY2xpY2sgZm9yIHNlYXJjaCBmaWVsZHNcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0YXdhaXQgdGFyZ2V0LmxvY2F0b3IodG9wLnNlbGVjdG9yKS5maXJzdCgpLmZvY3VzKHsgdGltZW91dDogNTAwMCB9KTtcblx0XHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRcdC8vIEZhbGxiYWNrOiBjbGljayB0byBmb2N1c1xuXHRcdFx0XHRcdFx0YXdhaXQgdGFyZ2V0LmxvY2F0b3IodG9wLnNlbGVjdG9yKS5maXJzdCgpLmNsaWNrKHsgdGltZW91dDogNTAwMCB9KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0Ly8gQ2xpY2sgdmlhIFBsYXl3cmlnaHQgbG9jYXRvciAoRDAyMSlcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0YXdhaXQgdGFyZ2V0LmxvY2F0b3IodG9wLnNlbGVjdG9yKS5maXJzdCgpLmNsaWNrKHsgdGltZW91dDogNTAwMCB9KTtcblx0XHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRcdC8vIGdldEJ5Um9sZSBmYWxsYmFjayBmcm9tIGludGVyYWN0aW9uLnRzIHBhdHRlcm5cblx0XHRcdFx0XHRcdGNvbnN0IG5hbWVNYXRjaCA9IHRvcC5zZWxlY3Rvci5tYXRjaCgvXFxbKD86YXJpYS1sYWJlbHxuYW1lfHBsYWNlaG9sZGVyKT1cIihbXlwiXSspXCJcXF0vaSk7XG5cdFx0XHRcdFx0XHRjb25zdCByb2xlTmFtZSA9IG5hbWVNYXRjaD8uWzFdO1xuXHRcdFx0XHRcdFx0bGV0IGNsaWNrZWQgPSBmYWxzZTtcblx0XHRcdFx0XHRcdGZvciAoY29uc3Qgcm9sZSBvZiBbXCJidXR0b25cIiwgXCJsaW5rXCIsIFwiY29tYm9ib3hcIiwgXCJ0ZXh0Ym94XCJdIGFzIGNvbnN0KSB7XG5cdFx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgbG9jID0gcm9sZU5hbWVcblx0XHRcdFx0XHRcdFx0XHRcdD8gdGFyZ2V0LmdldEJ5Um9sZShyb2xlLCB7IG5hbWU6IG5ldyBSZWdFeHAocm9sZU5hbWUsIFwiaVwiKSB9KVxuXHRcdFx0XHRcdFx0XHRcdFx0OiB0YXJnZXQuZ2V0QnlSb2xlKHJvbGUsIHsgbmFtZTogbmV3IFJlZ0V4cCh0b3AubmFtZS5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgXCJcXFxcJCZcIiksIFwiaVwiKSB9KTtcblx0XHRcdFx0XHRcdFx0XHRhd2FpdCBsb2MuZmlyc3QoKS5jbGljayh7IHRpbWVvdXQ6IDMwMDAgfSk7XG5cdFx0XHRcdFx0XHRcdFx0Y2xpY2tlZCA9IHRydWU7XG5cdFx0XHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0XHRcdH0gY2F0Y2ggeyAvKiB0cnkgbmV4dCByb2xlICovIH1cblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGlmICghY2xpY2tlZCkge1xuXHRcdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYENvdWxkIG5vdCBjbGljayB0b3AgY2FuZGlkYXRlIFwiJHt0b3Auc2VsZWN0b3J9XCIgZm9yIGludGVudCBcIiR7cGFyYW1zLmludGVudH1cImApO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIFNldHRsZSBhZnRlciBhY3Rpb25cblx0XHRcdFx0YXdhaXQgZGVwcy5zZXR0bGVBZnRlckFjdGlvbkFkYXB0aXZlKHApO1xuXG5cdFx0XHRcdC8vIENhcHR1cmUgYWZ0ZXIgc3RhdGUgYW5kIGRpZmZcblx0XHRcdFx0Y29uc3QgYWZ0ZXJTdGF0ZSA9IGF3YWl0IGRlcHMuY2FwdHVyZUNvbXBhY3RQYWdlU3RhdGUocCwge1xuXHRcdFx0XHRcdHNlbGVjdG9yczogcGFyYW1zLnNjb3BlID8gW3BhcmFtcy5zY29wZV0gOiBbXSxcblx0XHRcdFx0XHRpbmNsdWRlQm9keVRleHQ6IHRydWUsXG5cdFx0XHRcdFx0dGFyZ2V0LFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0Y29uc3QgZGlmZiA9IGRpZmZDb21wYWN0U3RhdGVzKGJlZm9yZVN0YXRlLCBhZnRlclN0YXRlKTtcblx0XHRcdFx0Y29uc3Qgc3VtbWFyeSA9IGRlcHMuZm9ybWF0Q29tcGFjdFN0YXRlU3VtbWFyeShhZnRlclN0YXRlKTtcblx0XHRcdFx0Y29uc3QganNFcnJvcnMgPSBkZXBzLmdldFJlY2VudEVycm9ycyhwLnVybCgpKTtcblxuXHRcdFx0XHRzZXRMYXN0QWN0aW9uQmVmb3JlU3RhdGUoYmVmb3JlU3RhdGUpO1xuXHRcdFx0XHRzZXRMYXN0QWN0aW9uQWZ0ZXJTdGF0ZShhZnRlclN0YXRlKTtcblxuXHRcdFx0XHRkZXBzLmZpbmlzaFRyYWNrZWRBY3Rpb24oYWN0aW9uSWQsIHtcblx0XHRcdFx0XHRzdGF0dXM6IFwic3VjY2Vzc1wiLFxuXHRcdFx0XHRcdGFmdGVyVXJsOiBhZnRlclN0YXRlLnVybCxcblx0XHRcdFx0XHRkaWZmU3VtbWFyeTogZGlmZi5zdW1tYXJ5LFxuXHRcdFx0XHRcdGJlZm9yZVN0YXRlLFxuXHRcdFx0XHRcdGFmdGVyU3RhdGUsXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdC8vIEZvcm1hdCBvdXRwdXRcblx0XHRcdFx0Y29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cdFx0XHRcdGxpbmVzLnB1c2goYEludGVudDogJHtwYXJhbXMuaW50ZW50fWApO1xuXHRcdFx0XHRsaW5lcy5wdXNoKGBBY3Rpb246ICR7bm9ybWFsaXplZEludGVudCA9PT0gXCJzZWFyY2hmaWVsZFwiID8gXCJmb2N1c2VkXCIgOiBcImNsaWNrZWRcIn0gdG9wIGNhbmRpZGF0ZSAoc2NvcmU6ICR7dG9wLnNjb3JlfSlgKTtcblx0XHRcdFx0bGluZXMucHVzaChgVGFyZ2V0OiBcXGAke3RvcC5zZWxlY3Rvcn1cXGAgXHUyMDE0IFwiJHt0b3AubmFtZSB8fCB0b3AudGV4dH1cImApO1xuXHRcdFx0XHRsaW5lcy5wdXNoKGBSZWFzb246ICR7dG9wLnJlYXNvbn1gKTtcblx0XHRcdFx0bGluZXMucHVzaChcIlwiKTtcblx0XHRcdFx0bGluZXMucHVzaChgRGlmZjpcXG4ke2RlcHMuZm9ybWF0RGlmZlRleHQoZGlmZil9YCk7XG5cdFx0XHRcdGlmIChqc0Vycm9ycy50cmltKCkpIHtcblx0XHRcdFx0XHRsaW5lcy5wdXNoKGBcXG5KUyBFcnJvcnM6XFxuJHtqc0Vycm9yc31gKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRsaW5lcy5wdXNoKGBcXG5QYWdlIHN1bW1hcnk6XFxuJHtzdW1tYXJ5fWApO1xuXG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGxpbmVzLmpvaW4oXCJcXG5cIikgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBpbnRlbnRSZXN1bHQ6IHJlc3VsdCwgdG9wQ2FuZGlkYXRlOiB0b3AsIGRpZmYgfSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogdW5rbm93bikge1xuXHRcdFx0XHRjb25zdCBzY3JlZW5zaG90ID0gYXdhaXQgZGVwcy5jYXB0dXJlRXJyb3JTY3JlZW5zaG90KFxuXHRcdFx0XHRcdCgoKSA9PiB7IHRyeSB7IHJldHVybiBkZXBzLmdldEFjdGl2ZVBhZ2UoKTsgfSBjYXRjaCB7IHJldHVybiBudWxsOyB9IH0pKClcblx0XHRcdFx0KTtcblx0XHRcdFx0Y29uc3QgZXJyTXNnID0gZGVwcy5maXJzdEVycm9yTGluZShlcnIpO1xuXG5cdFx0XHRcdGlmIChhY3Rpb25JZCAhPT0gbnVsbCkge1xuXHRcdFx0XHRcdGRlcHMuZmluaXNoVHJhY2tlZEFjdGlvbihhY3Rpb25JZCwge1xuXHRcdFx0XHRcdFx0c3RhdHVzOiBcImVycm9yXCIsXG5cdFx0XHRcdFx0XHRlcnJvcjogZXJyTXNnLFxuXHRcdFx0XHRcdFx0YmVmb3JlU3RhdGU6IGJlZm9yZVN0YXRlID8/IHVuZGVmaW5lZCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQ6IEFycmF5PHsgdHlwZTogXCJ0ZXh0XCI7IHRleHQ6IHN0cmluZyB9IHwgeyB0eXBlOiBcImltYWdlXCI7IGRhdGE6IHN0cmluZzsgbWltZVR5cGU6IHN0cmluZyB9PiA9IFtcblx0XHRcdFx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgYnJvd3Nlcl9hY3QgZmFpbGVkOiAke2Vyck1zZ31gIH0sXG5cdFx0XHRcdF07XG5cdFx0XHRcdGlmIChzY3JlZW5zaG90KSB7XG5cdFx0XHRcdFx0Y29udGVudC5wdXNoKHsgdHlwZTogXCJpbWFnZVwiLCBkYXRhOiBzY3JlZW5zaG90LmRhdGEsIG1pbWVUeXBlOiBzY3JlZW5zaG90Lm1pbWVUeXBlIH0pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiB7IGNvbnRlbnQsIGRldGFpbHM6IHt9LCBpc0Vycm9yOiB0cnVlIH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUF1QixZQUFZO0FBQ25DLFNBQVMseUJBQXlCO0FBRWxDO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBTVAsTUFBTSxVQUFVO0FBQUEsRUFDZjtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRDtBQUlBLFNBQVMsV0FDUixRQUNBLFNBQ3FCO0FBQ3JCLFNBQU8sS0FBSyxPQUFrQjtBQUFBLElBQzdCLE1BQU07QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLEdBQUksU0FBUyxlQUFlLEVBQUUsYUFBYSxRQUFRLFlBQVk7QUFBQSxJQUMvRCxHQUFJLFNBQVMsV0FBVyxFQUFFLFNBQVMsUUFBUSxRQUFRO0FBQUEsRUFDcEQsQ0FBQztBQUNGO0FBa0JPLFNBQVMseUJBQXlCLFFBQWdCLE9BQXdCO0FBQ2hGLFFBQU0sZ0JBQWdCLEtBQUssVUFBVSxTQUFTLElBQUk7QUFFbEQsU0FBTztBQUFBO0FBQUE7QUFBQTtBQUFBLG1CQUlXLEtBQUssVUFBVSxNQUFNLENBQUM7QUFBQTtBQUFBLGtCQUV2QixhQUFhO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQStQL0I7QUE0Qk8sU0FBUyxvQkFBb0IsSUFBa0IsTUFBc0I7QUFLM0UsS0FBRyxhQUFhO0FBQUEsSUFDZixNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUNDO0FBQUEsSUFDRCxZQUFZLEtBQUssT0FBTztBQUFBLE1BQ3ZCLFFBQVEsV0FBVyxTQUFTO0FBQUEsUUFDM0IsYUFDQztBQUFBLE1BQ0YsQ0FBQztBQUFBLE1BQ0QsT0FBTyxLQUFLO0FBQUEsUUFDWCxLQUFLLE9B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
