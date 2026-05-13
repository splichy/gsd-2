import { Type } from "@sinclair/typebox";
import { StringEnum } from "@gsd/pi-ai";
import {
  diffCompactStates
} from "../core.js";
import {
  setLastActionBeforeState,
  setLastActionAfterState
} from "../state.js";
import { readFocusedDescriptor } from "../settle.js";
function registerInteractionTools(pi, deps) {
  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description: "Click an element on the page by CSS selector or by x,y coordinates. Returns a compact page summary plus lightweight verification details after clicking. Provide either selector or both x and y. Prefer selector over coordinates \u2014 selectors are more reliable because they handle shadow DOM via getByRole fallbacks. Use coordinates only when you have no other option.",
    parameters: Type.Object({
      selector: Type.Optional(
        Type.String({ description: "CSS selector of the element to click. The tool will try getByRole fallbacks if the CSS selector fails (handles shadow DOM)." })
      ),
      x: Type.Optional(Type.Number({ description: "X coordinate to click" })),
      y: Type.Optional(Type.Number({ description: "Y coordinate to click" }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let actionId = null;
      let beforeState = null;
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        beforeState = await deps.captureCompactPageState(p, { selectors: params.selector ? [params.selector] : [], includeBodyText: true, target });
        actionId = deps.beginTrackedAction("browser_click", params, beforeState.url).id;
        const beforeUrl = p.url();
        const beforeHash = deps.getUrlHash(beforeUrl);
        const beforeTargetState = params.selector ? await deps.captureClickTargetState(target, params.selector) : null;
        if (params.selector) {
          try {
            await target.locator(params.selector).first().click({ timeout: 5e3 });
          } catch {
            const nameMatch = params.selector.match(/\[(?:aria-label|name|placeholder)="([^"]+)"\]/i);
            const roleName = nameMatch?.[1];
            let clicked = false;
            for (const role of ["combobox", "searchbox", "textbox", "button", "link"]) {
              try {
                const loc = roleName ? target.getByRole(role, { name: new RegExp(roleName, "i") }) : target.getByRole(role);
                await loc.first().click({ timeout: 3e3 });
                clicked = true;
                break;
              } catch {
              }
            }
            if (!clicked) {
              if (params.x !== void 0 && params.y !== void 0) {
                await p.mouse.click(params.x, params.y);
              } else {
                throw new Error(`Could not click selector "${params.selector}" \u2014 element not found (shadow DOM?)`);
              }
            }
          }
        } else if (params.x !== void 0 && params.y !== void 0) {
          await p.mouse.click(params.x, params.y);
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Must provide either selector or both x and y coordinates"
              }
            ],
            details: {},
            isError: true
          };
        }
        const settle = await deps.settleAfterActionAdaptive(p);
        const afterState = await deps.captureCompactPageState(p, { selectors: params.selector ? [params.selector] : [], includeBodyText: true, target });
        const url = afterState.url;
        const hash = deps.getUrlHash(url);
        const afterTargetState = params.selector ? await deps.captureClickTargetState(target, params.selector) : null;
        const targetStateChanged = !!beforeTargetState && !!afterTargetState && (beforeTargetState.exists !== afterTargetState.exists || beforeTargetState.ariaExpanded !== afterTargetState.ariaExpanded || beforeTargetState.ariaPressed !== afterTargetState.ariaPressed || beforeTargetState.ariaSelected !== afterTargetState.ariaSelected || beforeTargetState.open !== afterTargetState.open);
        const verification = deps.verificationFromChecks(
          [
            { name: "url_changed", passed: url !== beforeUrl, value: url, expected: `!= ${beforeUrl}` },
            { name: "hash_changed", passed: hash !== beforeHash, value: hash, expected: `!= ${beforeHash}` },
            { name: "target_state_changed", passed: targetStateChanged, value: afterTargetState, expected: beforeTargetState },
            { name: "dialog_open", passed: afterState.dialog.count > beforeState.dialog.count, value: afterState.dialog.count, expected: `> ${beforeState.dialog.count}` }
          ],
          "Try a more specific selector or click a clearly interactive element."
        );
        const clickTarget = params.selector ?? `(${params.x}, ${params.y})`;
        const summary = deps.formatCompactStateSummary(afterState);
        const jsErrors = deps.getRecentErrors(p.url());
        const diff = diffCompactStates(beforeState, afterState);
        setLastActionBeforeState(beforeState);
        setLastActionAfterState(afterState);
        deps.finishTrackedAction(actionId, {
          status: "success",
          afterUrl: afterState.url,
          verificationSummary: verification.verificationSummary,
          warningSummary: jsErrors.trim() || void 0,
          diffSummary: diff.summary,
          changed: diff.changed,
          beforeState,
          afterState
        });
        return {
          content: [{ type: "text", text: `Clicked: ${clickTarget}
URL: ${url}
Action: ${actionId}
${deps.verificationLine(verification)}${jsErrors}

Diff:
${deps.formatDiffText(diff)}

Page summary:
${summary}` }],
          details: { target: clickTarget, url, actionId, diff, ...settle, ...verification }
        };
      } catch (err) {
        if (actionId !== null) {
          deps.finishTrackedAction(actionId, { status: "error", afterUrl: deps.getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? void 0 });
        }
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const content = [{ type: "text", text: `Click failed: ${err.message}` }];
        if (errorShot) {
          content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        }
        return {
          content,
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_drag",
    label: "Browser Drag",
    description: "Drag an element and drop it onto another element. Use for sortable lists, kanban boards, sliders, and any drag-and-drop UI.",
    parameters: Type.Object({
      sourceSelector: Type.String({
        description: "CSS selector of the element to drag"
      }),
      targetSelector: Type.String({
        description: "CSS selector of the element to drop onto"
      })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        await target.dragAndDrop(params.sourceSelector, params.targetSelector, { timeout: 1e4 });
        const settle = await deps.settleAfterActionAdaptive(p);
        const afterState = await deps.captureCompactPageState(p, { includeBodyText: false, target });
        const summary = deps.formatCompactStateSummary(afterState);
        const jsErrors = deps.getRecentErrors(p.url());
        return {
          content: [{
            type: "text",
            text: `Dragged "${params.sourceSelector}" \u2192 "${params.targetSelector}"${jsErrors}

Page summary:
${summary}`
          }],
          details: { source: params.sourceSelector, target: params.targetSelector, ...settle }
        };
      } catch (err) {
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const content = [{ type: "text", text: `Drag failed: ${err.message}` }];
        if (errorShot) {
          content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        }
        return { content, details: { error: err.message }, isError: true };
      }
    }
  });
  pi.registerTool({
    name: "browser_type",
    label: "Browser Type",
    description: "Type text into an input element. By default uses atomic fill (clears and sets value instantly). Use 'slowly' for character-by-character typing when you need to trigger key handlers (e.g. search autocomplete). Use 'submit' to press Enter after typing. Returns a compact page summary plus lightweight verification details. IMPORTANT: Always provide a selector \u2014 do NOT rely on coordinate clicks to focus an input before calling this. CSS attribute selectors like combobox[aria-label='X'] work for most inputs; for shadow DOM inputs (e.g. Google Search), the tool automatically tries getByRole fallbacks.",
    parameters: Type.Object({
      text: Type.String({ description: "Text to type" }),
      selector: Type.Optional(
        Type.String({ description: `CSS selector of the input to type into (clicks it first). Examples: 'input[name=q]', 'textarea', 'combobox[aria-label="Search"]'. The tool will try getByRole fallbacks if the CSS selector fails.` })
      ),
      clearFirst: Type.Optional(
        Type.Boolean({
          description: "Clear the input's existing value before typing (default: false). Use this when replacing existing text."
        })
      ),
      submit: Type.Optional(
        Type.Boolean({
          description: "Press Enter after typing to submit the form (default: false)."
        })
      ),
      slowly: Type.Optional(
        Type.Boolean({
          description: "Type one character at a time instead of filling atomically. Use when you need to trigger key handlers (e.g. search autocomplete). Default: false."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let actionId = null;
      let beforeState = null;
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        beforeState = await deps.captureCompactPageState(p, { selectors: params.selector ? [params.selector] : [], includeBodyText: true, target });
        actionId = deps.beginTrackedAction("browser_type", params, beforeState.url).id;
        const beforeUrl = p.url();
        async function focusViaRole(selector) {
          const nameMatch = selector.match(/\[(?:aria-label|name|placeholder)="([^"]+)"\]/i);
          const roleName = nameMatch?.[1];
          for (const role of ["combobox", "searchbox", "textbox"]) {
            try {
              const loc = roleName ? target.getByRole(role, { name: new RegExp(roleName, "i") }) : target.getByRole(role);
              await loc.first().click({ timeout: 3e3 });
              return true;
            } catch {
            }
          }
          return false;
        }
        if (params.selector) {
          if (params.slowly) {
            let focused = false;
            try {
              await target.locator(params.selector).first().click({ timeout: 5e3 });
              focused = true;
            } catch {
              focused = await focusViaRole(params.selector);
            }
            if (!focused) throw new Error(`Could not focus selector "${params.selector}"`);
            if (params.clearFirst) {
              await p.keyboard.press("Control+A");
              await p.keyboard.press("Delete");
            }
            await p.keyboard.type(params.text);
          } else {
            let filled = false;
            try {
              await target.locator(params.selector).first().fill(params.text, { timeout: 5e3 });
              filled = true;
            } catch {
            }
            if (!filled) {
              const nameMatch = params.selector.match(/\[(?:aria-label|name|placeholder)="([^"]+)"\]/i);
              const roleName = nameMatch?.[1];
              for (const role of ["combobox", "searchbox", "textbox"]) {
                try {
                  const loc = roleName ? target.getByRole(role, { name: new RegExp(roleName, "i") }) : target.getByRole(role);
                  await loc.first().fill(params.text, { timeout: 3e3 });
                  filled = true;
                  break;
                } catch {
                }
              }
            }
            if (!filled) {
              let focused = false;
              try {
                await target.locator(params.selector).first().click({ timeout: 5e3 });
                focused = true;
              } catch {
                focused = await focusViaRole(params.selector);
              }
              if (!focused) throw new Error(`Could not focus selector "${params.selector}"`);
              if (params.clearFirst) {
                await p.keyboard.press("Control+A");
                await p.keyboard.press("Delete");
              }
              await target.locator(":focus").pressSequentially(params.text, { timeout: 5e3 }).catch(
                () => p.keyboard.type(params.text)
              );
            } else if (params.clearFirst) {
            }
          }
        } else {
          const hasFocus = await target.evaluate(() => {
            const el = document.activeElement;
            return !!(el && el !== document.body && el !== document.documentElement);
          });
          if (!hasFocus) {
            return {
              content: [{ type: "text", text: "Type failed: no element is focused. Use browser_click to focus an input first, or provide a selector." }],
              details: { error: "no focused element" },
              isError: true
            };
          }
          await target.locator(":focus").pressSequentially(params.text, { timeout: 1e4 }).catch(
            () => p.keyboard.type(params.text)
          );
        }
        if (params.submit) {
          await p.keyboard.press("Enter");
        }
        const settle = await deps.settleAfterActionAdaptive(p);
        const typedValue = await deps.readInputLikeValue(target, params.selector);
        const afterUrl = p.url();
        const verification = deps.verificationFromChecks(
          [
            { name: "value_equals_expected", passed: typedValue === params.text, value: typedValue, expected: params.text },
            { name: "value_contains_expected", passed: typeof typedValue === "string" && typedValue.includes(params.text), value: typedValue, expected: params.text },
            { name: "url_changed_after_submit", passed: !!params.submit && afterUrl !== beforeUrl, value: afterUrl, expected: `!= ${beforeUrl}` }
          ],
          "Try clearFirst=true, use a more specific selector, or set slowly=true for key-driven inputs."
        );
        const typeTarget = params.selector ? ` into "${params.selector}"` : "";
        const afterState = await deps.captureCompactPageState(p, { selectors: params.selector ? [params.selector] : [], includeBodyText: true, target });
        const summary = deps.formatCompactStateSummary(afterState);
        const jsErrors = deps.getRecentErrors(p.url());
        const diff = diffCompactStates(beforeState, afterState);
        setLastActionBeforeState(beforeState);
        setLastActionAfterState(afterState);
        deps.finishTrackedAction(actionId, {
          status: "success",
          afterUrl: afterState.url,
          verificationSummary: verification.verificationSummary,
          warningSummary: jsErrors.trim() || void 0,
          diffSummary: diff.summary,
          changed: diff.changed,
          beforeState,
          afterState
        });
        return {
          content: [{ type: "text", text: `Typed "${params.text}"${typeTarget}
Action: ${actionId}
${deps.verificationLine(verification)}${jsErrors}

Diff:
${deps.formatDiffText(diff)}

Page summary:
${summary}` }],
          details: { text: params.text, selector: params.selector, typedValue, actionId, diff, ...settle, ...verification }
        };
      } catch (err) {
        if (actionId !== null) {
          deps.finishTrackedAction(actionId, { status: "error", afterUrl: deps.getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? void 0 });
        }
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const content = [{ type: "text", text: `Type failed: ${err.message}` }];
        if (errorShot) {
          content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        }
        return {
          content,
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_upload_file",
    label: "Browser Upload File",
    description: 'Set files on a file input element. The selector must target an <input type="file"> element. Accepts one or more absolute file paths.',
    parameters: Type.Object({
      selector: Type.String({
        description: 'CSS selector targeting the <input type="file"> element'
      }),
      files: Type.Array(Type.String({ description: "Absolute path to a file" }), {
        description: "One or more file paths to upload"
      })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        const cleanFiles = params.files.map((f) => f.replace(/^@/, ""));
        await target.locator(params.selector).first().setInputFiles(cleanFiles);
        const settle = await deps.settleAfterActionAdaptive(p);
        const afterState = await deps.captureCompactPageState(p, { includeBodyText: false, target });
        const summary = deps.formatCompactStateSummary(afterState);
        const jsErrors = deps.getRecentErrors(p.url());
        return {
          content: [{
            type: "text",
            text: `Uploaded ${cleanFiles.length} file(s) to "${params.selector}": ${cleanFiles.join(", ")}${jsErrors}

Page summary:
${summary}`
          }],
          details: { selector: params.selector, files: cleanFiles, ...settle }
        };
      } catch (err) {
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const content = [{ type: "text", text: `Upload failed: ${err.message}` }];
        if (errorShot) {
          content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        }
        return { content, details: { error: err.message }, isError: true };
      }
    }
  });
  pi.registerTool({
    name: "browser_scroll",
    label: "Browser Scroll",
    description: "Scroll the page up or down by a given number of pixels. Returns scroll position (px and percentage) and an accessibility snapshot of the visible content.",
    parameters: Type.Object({
      direction: StringEnum(["up", "down"]),
      amount: Type.Optional(
        Type.Number({ description: "Pixels to scroll (default: 300)" })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        const pixels = params.amount ?? 300;
        const delta = params.direction === "up" ? -pixels : pixels;
        await p.mouse.wheel(0, delta);
        const settle = await deps.settleAfterActionAdaptive(p);
        const scrollInfo = await target.evaluate(() => ({
          scrollY: Math.round(window.scrollY),
          scrollHeight: document.documentElement.scrollHeight,
          clientHeight: document.documentElement.clientHeight
        }));
        const maxScroll = scrollInfo.scrollHeight - scrollInfo.clientHeight;
        const percent = maxScroll > 0 ? Math.round(scrollInfo.scrollY / maxScroll * 100) : 0;
        const afterState = await deps.captureCompactPageState(p, { includeBodyText: false, target });
        const summary = deps.formatCompactStateSummary(afterState);
        const jsErrors = deps.getRecentErrors(p.url());
        return {
          content: [
            {
              type: "text",
              text: `Scrolled ${params.direction} by ${pixels}px
Position: ${scrollInfo.scrollY}px / ${scrollInfo.scrollHeight}px (${percent}% down)
Viewport height: ${scrollInfo.clientHeight}px${jsErrors}

Page summary:
${summary}`
            }
          ],
          details: { direction: params.direction, amount: pixels, ...scrollInfo, percent, ...settle }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Scroll failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_hover",
    label: "Browser Hover",
    description: "Move the mouse over an element to trigger hover states \u2014 reveals tooltips, dropdown menus, CSS :hover effects, and other hover-dependent UI. Returns a compact page summary showing the resulting hover state.",
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector of the element to hover over"
      })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        await target.locator(params.selector).first().hover({ timeout: 1e4 });
        const settle = await deps.settleAfterActionAdaptive(p);
        const afterState = await deps.captureCompactPageState(p, { includeBodyText: false, target });
        const summary = deps.formatCompactStateSummary(afterState);
        const jsErrors = deps.getRecentErrors(p.url());
        return {
          content: [{ type: "text", text: `Hovering over "${params.selector}"${jsErrors}

Page summary:
${summary}` }],
          details: { selector: params.selector, ...settle }
        };
      } catch (err) {
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const content = [{ type: "text", text: `Hover failed: ${err.message}` }];
        if (errorShot) {
          content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        }
        return {
          content,
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_key_press",
    label: "Browser Key Press",
    description: "Press a keyboard key or key combination. Returns a compact page summary plus lightweight verification details after the key press. Use for: submitting forms (Enter), closing modals (Escape), navigating focusable elements (Tab / Shift+Tab), operating dropdowns and menus (ArrowDown, ArrowUp, Space), copying/pasting (Meta+C, Meta+V). Key names follow the DOM KeyboardEvent key convention.",
    parameters: Type.Object({
      key: Type.String({
        description: "Key or combination to press, e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'Space', 'Meta+A', 'Shift+Tab', 'Control+Enter'"
      })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let actionId = null;
      let beforeState = null;
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        beforeState = await deps.captureCompactPageState(p, { includeBodyText: true, target });
        actionId = deps.beginTrackedAction("browser_key_press", params, beforeState.url).id;
        const beforeUrl = p.url();
        const beforeFocus = await readFocusedDescriptor(target);
        await p.keyboard.press(params.key);
        const settle = await deps.settleAfterActionAdaptive(p, { checkFocusStability: true });
        const afterState = await deps.captureCompactPageState(p, { includeBodyText: true, target });
        const afterUrl = afterState.url;
        const afterFocus = await readFocusedDescriptor(target);
        const verification = deps.verificationFromChecks(
          [
            { name: "url_changed", passed: afterUrl !== beforeUrl, value: afterUrl, expected: `!= ${beforeUrl}` },
            { name: "focus_changed", passed: afterFocus !== beforeFocus, value: afterFocus, expected: `!= ${beforeFocus}` },
            { name: "dialog_open", passed: afterState.dialog.count > beforeState.dialog.count, value: afterState.dialog.count, expected: `> ${beforeState.dialog.count}` }
          ],
          "If this key should trigger UI changes, confirm focus is on the intended element first."
        );
        const summary = deps.formatCompactStateSummary(afterState);
        const jsErrors = deps.getRecentErrors(p.url());
        const diff = diffCompactStates(beforeState, afterState);
        setLastActionBeforeState(beforeState);
        setLastActionAfterState(afterState);
        deps.finishTrackedAction(actionId, {
          status: "success",
          afterUrl: afterState.url,
          verificationSummary: verification.verificationSummary,
          warningSummary: jsErrors.trim() || void 0,
          diffSummary: diff.summary,
          changed: diff.changed,
          beforeState,
          afterState
        });
        return {
          content: [{ type: "text", text: `Pressed "${params.key}"
Action: ${actionId}
${deps.verificationLine(verification)}${jsErrors}

Diff:
${deps.formatDiffText(diff)}

Page summary:
${summary}` }],
          details: { key: params.key, beforeFocus, afterFocus, actionId, diff, ...settle, ...verification }
        };
      } catch (err) {
        if (actionId !== null) {
          deps.finishTrackedAction(actionId, { status: "error", afterUrl: deps.getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? void 0 });
        }
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const content = [{ type: "text", text: `Key press failed: ${err.message}` }];
        if (errorShot) {
          content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        }
        return {
          content,
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_select_option",
    label: "Browser Select Option",
    description: "Select an option from a <select> dropdown element by its visible label or value. Returns a compact page summary plus lightweight verification details. For custom-built dropdowns use browser_click to open them then browser_click to pick the option.",
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector targeting the <select> element"
      }),
      option: Type.String({
        description: "The option to select \u2014 can be the visible label text or the value attribute. Will try label first, then value."
      })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let actionId = null;
      let beforeState = null;
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        beforeState = await deps.captureCompactPageState(p, { selectors: [params.selector], includeBodyText: true, target });
        actionId = deps.beginTrackedAction("browser_select_option", params, beforeState.url).id;
        let selected;
        try {
          selected = await target.selectOption(params.selector, { label: params.option }, { timeout: 5e3 });
        } catch {
          selected = await target.selectOption(params.selector, { value: params.option }, { timeout: 5e3 });
        }
        const settle = await deps.settleAfterActionAdaptive(p);
        const selectedState = await target.locator(params.selector).first().evaluate((el) => {
          if (!(el instanceof HTMLSelectElement)) {
            return { selectedValues: [], selectedLabels: [] };
          }
          const selectedOptions = Array.from(el.selectedOptions || []);
          return {
            selectedValues: selectedOptions.map((opt) => opt.value),
            selectedLabels: selectedOptions.map((opt) => (opt.textContent || "").trim())
          };
        });
        const optionNeedle = params.option.toLowerCase();
        const verification = deps.verificationFromChecks(
          [
            { name: "selected_values_include_option", passed: selectedState.selectedValues.includes(params.option), value: selectedState.selectedValues, expected: params.option },
            { name: "selected_labels_include_option", passed: selectedState.selectedLabels.some((label) => label.toLowerCase().includes(optionNeedle)), value: selectedState.selectedLabels, expected: params.option }
          ],
          "Confirm whether the target select uses option label or value, then retry with that exact text."
        );
        const afterState = await deps.captureCompactPageState(p, { selectors: [params.selector], includeBodyText: true, target });
        const summary = deps.formatCompactStateSummary(afterState);
        const jsErrors = deps.getRecentErrors(p.url());
        const diff = diffCompactStates(beforeState, afterState);
        setLastActionBeforeState(beforeState);
        setLastActionAfterState(afterState);
        deps.finishTrackedAction(actionId, {
          status: "success",
          afterUrl: afterState.url,
          verificationSummary: verification.verificationSummary,
          warningSummary: jsErrors.trim() || void 0,
          diffSummary: diff.summary,
          changed: diff.changed,
          beforeState,
          afterState
        });
        return {
          content: [
            {
              type: "text",
              text: `Selected "${params.option}" in "${params.selector}". Values: ${selected.join(", ")}
Action: ${actionId}
${deps.verificationLine(verification)}${jsErrors}

Diff:
${deps.formatDiffText(diff)}

Page summary:
${summary}`
            }
          ],
          details: { selector: params.selector, option: params.option, selected, selectedState, actionId, diff, ...settle, ...verification }
        };
      } catch (err) {
        if (actionId !== null) {
          deps.finishTrackedAction(actionId, { status: "error", afterUrl: deps.getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? void 0 });
        }
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const content = [{ type: "text", text: `Select option failed: ${err.message}` }];
        if (errorShot) {
          content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        }
        return {
          content,
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_set_checked",
    label: "Browser Set Checked",
    description: "Check or uncheck a checkbox or radio button. More reliable than clicking for form elements where you need a specific state.",
    parameters: Type.Object({
      selector: Type.String({
        description: "CSS selector targeting the checkbox or radio input"
      }),
      checked: Type.Boolean({
        description: "true to check, false to uncheck"
      })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      let actionId = null;
      let beforeState = null;
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        beforeState = await deps.captureCompactPageState(p, { selectors: [params.selector], includeBodyText: true, target });
        actionId = deps.beginTrackedAction("browser_set_checked", params, beforeState.url).id;
        await target.locator(params.selector).first().setChecked(params.checked, { timeout: 1e4 });
        const settle = await deps.settleAfterActionAdaptive(p);
        const actualChecked = await target.locator(params.selector).first().isChecked().catch(() => null);
        const verification = deps.verificationFromChecks(
          [
            { name: "checked_state_matches", passed: actualChecked === params.checked, value: actualChecked, expected: params.checked }
          ],
          "Ensure selector points to a checkbox/radio input and retry."
        );
        const state = params.checked ? "checked" : "unchecked";
        const afterState = await deps.captureCompactPageState(p, { selectors: [params.selector], includeBodyText: true, target });
        const summary = deps.formatCompactStateSummary(afterState);
        const jsErrors = deps.getRecentErrors(p.url());
        const diff = diffCompactStates(beforeState, afterState);
        setLastActionBeforeState(beforeState);
        setLastActionAfterState(afterState);
        deps.finishTrackedAction(actionId, {
          status: "success",
          afterUrl: afterState.url,
          verificationSummary: verification.verificationSummary,
          warningSummary: jsErrors.trim() || void 0,
          diffSummary: diff.summary,
          changed: diff.changed,
          beforeState,
          afterState
        });
        return {
          content: [{
            type: "text",
            text: `Set "${params.selector}" to ${state}
Action: ${actionId}
${deps.verificationLine(verification)}${jsErrors}

Diff:
${deps.formatDiffText(diff)}

Page summary:
${summary}`
          }],
          details: { selector: params.selector, checked: params.checked, actualChecked, actionId, diff, ...settle, ...verification }
        };
      } catch (err) {
        if (actionId !== null) {
          deps.finishTrackedAction(actionId, { status: "error", afterUrl: deps.getActivePageOrNull()?.url() ?? "", error: err.message, beforeState: beforeState ?? void 0 });
        }
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const content = [{ type: "text", text: `Set checked failed: ${err.message}` }];
        if (errorShot) {
          content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        }
        return { content, details: { error: err.message }, isError: true };
      }
    }
  });
  pi.registerTool({
    name: "browser_set_viewport",
    label: "Browser Set Viewport",
    description: "Resize the browser viewport to test responsive layouts at different screen sizes. Use presets for common breakpoints or specify exact pixel dimensions. Essential for verifying mobile/tablet/desktop layouts.",
    parameters: Type.Object({
      preset: Type.Optional(
        StringEnum(["mobile", "tablet", "desktop", "wide"])
      ),
      width: Type.Optional(
        Type.Number({ description: "Custom viewport width in pixels (requires height too)" })
      ),
      height: Type.Optional(
        Type.Number({ description: "Custom viewport height in pixels (requires width too)" })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        let width;
        let height;
        let label;
        if (params.preset) {
          switch (params.preset) {
            case "mobile":
              width = 390;
              height = 844;
              label = "mobile (390\xD7844)";
              break;
            case "tablet":
              width = 768;
              height = 1024;
              label = "tablet (768\xD71024)";
              break;
            case "desktop":
              width = 1280;
              height = 800;
              label = "desktop (1280\xD7800)";
              break;
            case "wide":
              width = 1920;
              height = 1080;
              label = "wide (1920\xD71080)";
              break;
          }
        } else if (params.width !== void 0 && params.height !== void 0) {
          width = params.width;
          height = params.height;
          label = `custom (${width}\xD7${height})`;
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Provide either a preset (mobile/tablet/desktop/wide) or both width and height."
              }
            ],
            details: {},
            isError: true
          };
        }
        await p.setViewportSize({ width, height });
        return {
          content: [{ type: "text", text: `Viewport set to ${label}` }],
          details: { width, height, label }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Set viewport failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
}
export {
  registerInteractionTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvaW50ZXJhY3Rpb24udHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgeyBTdHJpbmdFbnVtIH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB7XG5cdGRpZmZDb21wYWN0U3RhdGVzLFxufSBmcm9tIFwiLi4vY29yZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBUb29sRGVwcywgQ29tcGFjdFBhZ2VTdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHtcblx0c2V0TGFzdEFjdGlvbkJlZm9yZVN0YXRlLFxuXHRzZXRMYXN0QWN0aW9uQWZ0ZXJTdGF0ZSxcbn0gZnJvbSBcIi4uL3N0YXRlLmpzXCI7XG5pbXBvcnQgeyByZWFkRm9jdXNlZERlc2NyaXB0b3IgfSBmcm9tIFwiLi4vc2V0dGxlLmpzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlckludGVyYWN0aW9uVG9vbHMocGk6IEV4dGVuc2lvbkFQSSwgZGVwczogVG9vbERlcHMpOiB2b2lkIHtcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBicm93c2VyX2NsaWNrXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfY2xpY2tcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIENsaWNrXCIsXG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcIkNsaWNrIGFuIGVsZW1lbnQgb24gdGhlIHBhZ2UgYnkgQ1NTIHNlbGVjdG9yIG9yIGJ5IHgseSBjb29yZGluYXRlcy4gUmV0dXJucyBhIGNvbXBhY3QgcGFnZSBzdW1tYXJ5IHBsdXMgbGlnaHR3ZWlnaHQgdmVyaWZpY2F0aW9uIGRldGFpbHMgYWZ0ZXIgY2xpY2tpbmcuIFByb3ZpZGUgZWl0aGVyIHNlbGVjdG9yIG9yIGJvdGggeCBhbmQgeS4gUHJlZmVyIHNlbGVjdG9yIG92ZXIgY29vcmRpbmF0ZXMgXHUyMDE0IHNlbGVjdG9ycyBhcmUgbW9yZSByZWxpYWJsZSBiZWNhdXNlIHRoZXkgaGFuZGxlIHNoYWRvdyBET00gdmlhIGdldEJ5Um9sZSBmYWxsYmFja3MuIFVzZSBjb29yZGluYXRlcyBvbmx5IHdoZW4geW91IGhhdmUgbm8gb3RoZXIgb3B0aW9uLlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdHNlbGVjdG9yOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkNTUyBzZWxlY3RvciBvZiB0aGUgZWxlbWVudCB0byBjbGljay4gVGhlIHRvb2wgd2lsbCB0cnkgZ2V0QnlSb2xlIGZhbGxiYWNrcyBpZiB0aGUgQ1NTIHNlbGVjdG9yIGZhaWxzIChoYW5kbGVzIHNoYWRvdyBET00pLlwiIH0pXG5cdFx0XHQpLFxuXHRcdFx0eDogVHlwZS5PcHRpb25hbChUeXBlLk51bWJlcih7IGRlc2NyaXB0aW9uOiBcIlggY29vcmRpbmF0ZSB0byBjbGlja1wiIH0pKSxcblx0XHRcdHk6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoeyBkZXNjcmlwdGlvbjogXCJZIGNvb3JkaW5hdGUgdG8gY2xpY2tcIiB9KSksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0bGV0IGFjdGlvbklkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblx0XHRcdGxldCBiZWZvcmVTdGF0ZTogQ29tcGFjdFBhZ2VTdGF0ZSB8IG51bGwgPSBudWxsO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBwYWdlOiBwIH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblx0XHRcdFx0Y29uc3QgdGFyZ2V0ID0gZGVwcy5nZXRBY3RpdmVUYXJnZXQoKTtcblx0XHRcdFx0YmVmb3JlU3RhdGUgPSBhd2FpdCBkZXBzLmNhcHR1cmVDb21wYWN0UGFnZVN0YXRlKHAsIHsgc2VsZWN0b3JzOiBwYXJhbXMuc2VsZWN0b3IgPyBbcGFyYW1zLnNlbGVjdG9yXSA6IFtdLCBpbmNsdWRlQm9keVRleHQ6IHRydWUsIHRhcmdldCB9KTtcblx0XHRcdFx0YWN0aW9uSWQgPSBkZXBzLmJlZ2luVHJhY2tlZEFjdGlvbihcImJyb3dzZXJfY2xpY2tcIiwgcGFyYW1zLCBiZWZvcmVTdGF0ZS51cmwpLmlkO1xuXHRcdFx0XHRjb25zdCBiZWZvcmVVcmwgPSBwLnVybCgpO1xuXHRcdFx0XHRjb25zdCBiZWZvcmVIYXNoID0gZGVwcy5nZXRVcmxIYXNoKGJlZm9yZVVybCk7XG5cdFx0XHRcdGNvbnN0IGJlZm9yZVRhcmdldFN0YXRlID0gcGFyYW1zLnNlbGVjdG9yXG5cdFx0XHRcdFx0PyBhd2FpdCBkZXBzLmNhcHR1cmVDbGlja1RhcmdldFN0YXRlKHRhcmdldCwgcGFyYW1zLnNlbGVjdG9yKVxuXHRcdFx0XHRcdDogbnVsbDtcblxuXHRcdFx0XHRpZiAocGFyYW1zLnNlbGVjdG9yKSB7XG5cdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdGF3YWl0IHRhcmdldC5sb2NhdG9yKHBhcmFtcy5zZWxlY3RvcikuZmlyc3QoKS5jbGljayh7IHRpbWVvdXQ6IDUwMDAgfSk7XG5cdFx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0XHRjb25zdCBuYW1lTWF0Y2ggPSBwYXJhbXMuc2VsZWN0b3IubWF0Y2goL1xcWyg/OmFyaWEtbGFiZWx8bmFtZXxwbGFjZWhvbGRlcik9XCIoW15cIl0rKVwiXFxdL2kpO1xuXHRcdFx0XHRcdFx0Y29uc3Qgcm9sZU5hbWUgPSBuYW1lTWF0Y2g/LlsxXTtcblx0XHRcdFx0XHRcdGxldCBjbGlja2VkID0gZmFsc2U7XG5cdFx0XHRcdFx0XHRmb3IgKGNvbnN0IHJvbGUgb2YgW1wiY29tYm9ib3hcIiwgXCJzZWFyY2hib3hcIiwgXCJ0ZXh0Ym94XCIsIFwiYnV0dG9uXCIsIFwibGlua1wiXSBhcyBjb25zdCkge1xuXHRcdFx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IGxvYyA9IHJvbGVOYW1lXG5cdFx0XHRcdFx0XHRcdFx0XHQ/IHRhcmdldC5nZXRCeVJvbGUocm9sZSwgeyBuYW1lOiBuZXcgUmVnRXhwKHJvbGVOYW1lLCBcImlcIikgfSlcblx0XHRcdFx0XHRcdFx0XHRcdDogdGFyZ2V0LmdldEJ5Um9sZShyb2xlKTtcblx0XHRcdFx0XHRcdFx0XHRhd2FpdCBsb2MuZmlyc3QoKS5jbGljayh7IHRpbWVvdXQ6IDMwMDAgfSk7XG5cdFx0XHRcdFx0XHRcdFx0Y2xpY2tlZCA9IHRydWU7XG5cdFx0XHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0XHRcdH0gY2F0Y2ggeyAvKiB0cnkgbmV4dCByb2xlICovIH1cblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGlmICghY2xpY2tlZCkge1xuXHRcdFx0XHRcdFx0XHRpZiAocGFyYW1zLnggIT09IHVuZGVmaW5lZCAmJiBwYXJhbXMueSAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0XHRcdFx0YXdhaXQgcC5tb3VzZS5jbGljayhwYXJhbXMueCwgcGFyYW1zLnkpO1xuXHRcdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgQ291bGQgbm90IGNsaWNrIHNlbGVjdG9yIFwiJHtwYXJhbXMuc2VsZWN0b3J9XCIgXHUyMDE0IGVsZW1lbnQgbm90IGZvdW5kIChzaGFkb3cgRE9NPylgKTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBlbHNlIGlmIChwYXJhbXMueCAhPT0gdW5kZWZpbmVkICYmIHBhcmFtcy55ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0XHRhd2FpdCBwLm1vdXNlLmNsaWNrKHBhcmFtcy54LCBwYXJhbXMueSk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0XHRcdHRleHQ6IFwiTXVzdCBwcm92aWRlIGVpdGhlciBzZWxlY3RvciBvciBib3RoIHggYW5kIHkgY29vcmRpbmF0ZXNcIixcblx0XHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdF0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7fSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IHNldHRsZSA9IGF3YWl0IGRlcHMuc2V0dGxlQWZ0ZXJBY3Rpb25BZGFwdGl2ZShwKTtcblxuXHRcdFx0XHRjb25zdCBhZnRlclN0YXRlID0gYXdhaXQgZGVwcy5jYXB0dXJlQ29tcGFjdFBhZ2VTdGF0ZShwLCB7IHNlbGVjdG9yczogcGFyYW1zLnNlbGVjdG9yID8gW3BhcmFtcy5zZWxlY3Rvcl0gOiBbXSwgaW5jbHVkZUJvZHlUZXh0OiB0cnVlLCB0YXJnZXQgfSk7XG5cdFx0XHRcdGNvbnN0IHVybCA9IGFmdGVyU3RhdGUudXJsO1xuXHRcdFx0XHRjb25zdCBoYXNoID0gZGVwcy5nZXRVcmxIYXNoKHVybCk7XG5cdFx0XHRcdGNvbnN0IGFmdGVyVGFyZ2V0U3RhdGUgPSBwYXJhbXMuc2VsZWN0b3Jcblx0XHRcdFx0XHQ/IGF3YWl0IGRlcHMuY2FwdHVyZUNsaWNrVGFyZ2V0U3RhdGUodGFyZ2V0LCBwYXJhbXMuc2VsZWN0b3IpXG5cdFx0XHRcdFx0OiBudWxsO1xuXHRcdFx0XHRjb25zdCB0YXJnZXRTdGF0ZUNoYW5nZWQgPSAhIWJlZm9yZVRhcmdldFN0YXRlICYmICEhYWZ0ZXJUYXJnZXRTdGF0ZSAmJiAoXG5cdFx0XHRcdFx0YmVmb3JlVGFyZ2V0U3RhdGUuZXhpc3RzICE9PSBhZnRlclRhcmdldFN0YXRlLmV4aXN0cyB8fFxuXHRcdFx0XHRcdGJlZm9yZVRhcmdldFN0YXRlLmFyaWFFeHBhbmRlZCAhPT0gYWZ0ZXJUYXJnZXRTdGF0ZS5hcmlhRXhwYW5kZWQgfHxcblx0XHRcdFx0XHRiZWZvcmVUYXJnZXRTdGF0ZS5hcmlhUHJlc3NlZCAhPT0gYWZ0ZXJUYXJnZXRTdGF0ZS5hcmlhUHJlc3NlZCB8fFxuXHRcdFx0XHRcdGJlZm9yZVRhcmdldFN0YXRlLmFyaWFTZWxlY3RlZCAhPT0gYWZ0ZXJUYXJnZXRTdGF0ZS5hcmlhU2VsZWN0ZWQgfHxcblx0XHRcdFx0XHRiZWZvcmVUYXJnZXRTdGF0ZS5vcGVuICE9PSBhZnRlclRhcmdldFN0YXRlLm9wZW5cblx0XHRcdFx0KTtcblx0XHRcdFx0Y29uc3QgdmVyaWZpY2F0aW9uID0gZGVwcy52ZXJpZmljYXRpb25Gcm9tQ2hlY2tzKFxuXHRcdFx0XHRcdFtcblx0XHRcdFx0XHRcdHsgbmFtZTogXCJ1cmxfY2hhbmdlZFwiLCBwYXNzZWQ6IHVybCAhPT0gYmVmb3JlVXJsLCB2YWx1ZTogdXJsLCBleHBlY3RlZDogYCE9ICR7YmVmb3JlVXJsfWAgfSxcblx0XHRcdFx0XHRcdHsgbmFtZTogXCJoYXNoX2NoYW5nZWRcIiwgcGFzc2VkOiBoYXNoICE9PSBiZWZvcmVIYXNoLCB2YWx1ZTogaGFzaCwgZXhwZWN0ZWQ6IGAhPSAke2JlZm9yZUhhc2h9YCB9LFxuXHRcdFx0XHRcdFx0eyBuYW1lOiBcInRhcmdldF9zdGF0ZV9jaGFuZ2VkXCIsIHBhc3NlZDogdGFyZ2V0U3RhdGVDaGFuZ2VkLCB2YWx1ZTogYWZ0ZXJUYXJnZXRTdGF0ZSwgZXhwZWN0ZWQ6IGJlZm9yZVRhcmdldFN0YXRlIH0sXG5cdFx0XHRcdFx0XHR7IG5hbWU6IFwiZGlhbG9nX29wZW5cIiwgcGFzc2VkOiBhZnRlclN0YXRlLmRpYWxvZy5jb3VudCA+IGJlZm9yZVN0YXRlIS5kaWFsb2cuY291bnQsIHZhbHVlOiBhZnRlclN0YXRlLmRpYWxvZy5jb3VudCwgZXhwZWN0ZWQ6IGA+ICR7YmVmb3JlU3RhdGUhLmRpYWxvZy5jb3VudH1gIH0sXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRcIlRyeSBhIG1vcmUgc3BlY2lmaWMgc2VsZWN0b3Igb3IgY2xpY2sgYSBjbGVhcmx5IGludGVyYWN0aXZlIGVsZW1lbnQuXCJcblx0XHRcdFx0KTtcblx0XHRcdFx0Y29uc3QgY2xpY2tUYXJnZXQgPSBwYXJhbXMuc2VsZWN0b3IgPz8gYCgke3BhcmFtcy54fSwgJHtwYXJhbXMueX0pYDtcblx0XHRcdFx0Y29uc3Qgc3VtbWFyeSA9IGRlcHMuZm9ybWF0Q29tcGFjdFN0YXRlU3VtbWFyeShhZnRlclN0YXRlKTtcblx0XHRcdFx0Y29uc3QganNFcnJvcnMgPSBkZXBzLmdldFJlY2VudEVycm9ycyhwLnVybCgpKTtcblx0XHRcdFx0Y29uc3QgZGlmZiA9IGRpZmZDb21wYWN0U3RhdGVzKGJlZm9yZVN0YXRlISwgYWZ0ZXJTdGF0ZSk7XG5cdFx0XHRcdHNldExhc3RBY3Rpb25CZWZvcmVTdGF0ZShiZWZvcmVTdGF0ZSEpO1xuXHRcdFx0XHRzZXRMYXN0QWN0aW9uQWZ0ZXJTdGF0ZShhZnRlclN0YXRlKTtcblx0XHRcdFx0ZGVwcy5maW5pc2hUcmFja2VkQWN0aW9uKGFjdGlvbklkISwge1xuXHRcdFx0XHRcdHN0YXR1czogXCJzdWNjZXNzXCIsXG5cdFx0XHRcdFx0YWZ0ZXJVcmw6IGFmdGVyU3RhdGUudXJsLFxuXHRcdFx0XHRcdHZlcmlmaWNhdGlvblN1bW1hcnk6IHZlcmlmaWNhdGlvbi52ZXJpZmljYXRpb25TdW1tYXJ5LFxuXHRcdFx0XHRcdHdhcm5pbmdTdW1tYXJ5OiBqc0Vycm9ycy50cmltKCkgfHwgdW5kZWZpbmVkLFxuXHRcdFx0XHRcdGRpZmZTdW1tYXJ5OiBkaWZmLnN1bW1hcnksXG5cdFx0XHRcdFx0Y2hhbmdlZDogZGlmZi5jaGFuZ2VkLFxuXHRcdFx0XHRcdGJlZm9yZVN0YXRlOiBiZWZvcmVTdGF0ZSEsXG5cdFx0XHRcdFx0YWZ0ZXJTdGF0ZSxcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYENsaWNrZWQ6ICR7Y2xpY2tUYXJnZXR9XFxuVVJMOiAke3VybH1cXG5BY3Rpb246ICR7YWN0aW9uSWR9XFxuJHtkZXBzLnZlcmlmaWNhdGlvbkxpbmUodmVyaWZpY2F0aW9uKX0ke2pzRXJyb3JzfVxcblxcbkRpZmY6XFxuJHtkZXBzLmZvcm1hdERpZmZUZXh0KGRpZmYpfVxcblxcblBhZ2Ugc3VtbWFyeTpcXG4ke3N1bW1hcnl9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IHRhcmdldDogY2xpY2tUYXJnZXQsIHVybCwgYWN0aW9uSWQsIGRpZmYsIC4uLnNldHRsZSwgLi4udmVyaWZpY2F0aW9uIH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRpZiAoYWN0aW9uSWQgIT09IG51bGwpIHtcblx0XHRcdFx0XHRkZXBzLmZpbmlzaFRyYWNrZWRBY3Rpb24oYWN0aW9uSWQsIHsgc3RhdHVzOiBcImVycm9yXCIsIGFmdGVyVXJsOiBkZXBzLmdldEFjdGl2ZVBhZ2VPck51bGwoKT8udXJsKCkgPz8gXCJcIiwgZXJyb3I6IGVyci5tZXNzYWdlLCBiZWZvcmVTdGF0ZTogYmVmb3JlU3RhdGUgPz8gdW5kZWZpbmVkIH0pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IGVycm9yU2hvdCA9IGF3YWl0IGRlcHMuY2FwdHVyZUVycm9yU2NyZWVuc2hvdChkZXBzLmdldEFjdGl2ZVBhZ2VPck51bGwoKSk7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQ6IGFueVtdID0gW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBDbGljayBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XTtcblx0XHRcdFx0aWYgKGVycm9yU2hvdCkge1xuXHRcdFx0XHRcdGNvbnRlbnQucHVzaCh7IHR5cGU6IFwiaW1hZ2VcIiwgZGF0YTogZXJyb3JTaG90LmRhdGEsIG1pbWVUeXBlOiBlcnJvclNob3QubWltZVR5cGUgfSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50LFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfZHJhZ1xuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX2RyYWdcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIERyYWdcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiRHJhZyBhbiBlbGVtZW50IGFuZCBkcm9wIGl0IG9udG8gYW5vdGhlciBlbGVtZW50LiBVc2UgZm9yIHNvcnRhYmxlIGxpc3RzLCBrYW5iYW4gYm9hcmRzLCBzbGlkZXJzLCBhbmQgYW55IGRyYWctYW5kLWRyb3AgVUkuXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0c291cmNlU2VsZWN0b3I6IFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0ZGVzY3JpcHRpb246IFwiQ1NTIHNlbGVjdG9yIG9mIHRoZSBlbGVtZW50IHRvIGRyYWdcIixcblx0XHRcdH0pLFxuXHRcdFx0dGFyZ2V0U2VsZWN0b3I6IFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0ZGVzY3JpcHRpb246IFwiQ1NTIHNlbGVjdG9yIG9mIHRoZSBlbGVtZW50IHRvIGRyb3Agb250b1wiLFxuXHRcdFx0fSksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBwYWdlOiBwIH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblx0XHRcdFx0Y29uc3QgdGFyZ2V0ID0gZGVwcy5nZXRBY3RpdmVUYXJnZXQoKTtcblx0XHRcdFx0YXdhaXQgdGFyZ2V0LmRyYWdBbmREcm9wKHBhcmFtcy5zb3VyY2VTZWxlY3RvciwgcGFyYW1zLnRhcmdldFNlbGVjdG9yLCB7IHRpbWVvdXQ6IDEwMDAwIH0pO1xuXHRcdFx0XHRjb25zdCBzZXR0bGUgPSBhd2FpdCBkZXBzLnNldHRsZUFmdGVyQWN0aW9uQWRhcHRpdmUocCk7XG5cblx0XHRcdFx0Y29uc3QgYWZ0ZXJTdGF0ZSA9IGF3YWl0IGRlcHMuY2FwdHVyZUNvbXBhY3RQYWdlU3RhdGUocCwgeyBpbmNsdWRlQm9keVRleHQ6IGZhbHNlLCB0YXJnZXQgfSk7XG5cdFx0XHRcdGNvbnN0IHN1bW1hcnkgPSBkZXBzLmZvcm1hdENvbXBhY3RTdGF0ZVN1bW1hcnkoYWZ0ZXJTdGF0ZSk7XG5cdFx0XHRcdGNvbnN0IGpzRXJyb3JzID0gZGVwcy5nZXRSZWNlbnRFcnJvcnMocC51cmwoKSk7XG5cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHR0ZXh0OiBgRHJhZ2dlZCBcIiR7cGFyYW1zLnNvdXJjZVNlbGVjdG9yfVwiIFx1MjE5MiBcIiR7cGFyYW1zLnRhcmdldFNlbGVjdG9yfVwiJHtqc0Vycm9yc31cXG5cXG5QYWdlIHN1bW1hcnk6XFxuJHtzdW1tYXJ5fWAsXG5cdFx0XHRcdFx0fV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBzb3VyY2U6IHBhcmFtcy5zb3VyY2VTZWxlY3RvciwgdGFyZ2V0OiBwYXJhbXMudGFyZ2V0U2VsZWN0b3IsIC4uLnNldHRsZSB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0Y29uc3QgZXJyb3JTaG90ID0gYXdhaXQgZGVwcy5jYXB0dXJlRXJyb3JTY3JlZW5zaG90KGRlcHMuZ2V0QWN0aXZlUGFnZU9yTnVsbCgpKTtcblx0XHRcdFx0Y29uc3QgY29udGVudDogYW55W10gPSBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYERyYWcgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfV07XG5cdFx0XHRcdGlmIChlcnJvclNob3QpIHtcblx0XHRcdFx0XHRjb250ZW50LnB1c2goeyB0eXBlOiBcImltYWdlXCIsIGRhdGE6IGVycm9yU2hvdC5kYXRhLCBtaW1lVHlwZTogZXJyb3JTaG90Lm1pbWVUeXBlIH0pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiB7IGNvbnRlbnQsIGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sIGlzRXJyb3I6IHRydWUgfTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfdHlwZVxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX3R5cGVcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIFR5cGVcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiVHlwZSB0ZXh0IGludG8gYW4gaW5wdXQgZWxlbWVudC4gQnkgZGVmYXVsdCB1c2VzIGF0b21pYyBmaWxsIChjbGVhcnMgYW5kIHNldHMgdmFsdWUgaW5zdGFudGx5KS4gVXNlICdzbG93bHknIGZvciBjaGFyYWN0ZXItYnktY2hhcmFjdGVyIHR5cGluZyB3aGVuIHlvdSBuZWVkIHRvIHRyaWdnZXIga2V5IGhhbmRsZXJzIChlLmcuIHNlYXJjaCBhdXRvY29tcGxldGUpLiBVc2UgJ3N1Ym1pdCcgdG8gcHJlc3MgRW50ZXIgYWZ0ZXIgdHlwaW5nLiBSZXR1cm5zIGEgY29tcGFjdCBwYWdlIHN1bW1hcnkgcGx1cyBsaWdodHdlaWdodCB2ZXJpZmljYXRpb24gZGV0YWlscy4gSU1QT1JUQU5UOiBBbHdheXMgcHJvdmlkZSBhIHNlbGVjdG9yIFx1MjAxNCBkbyBOT1QgcmVseSBvbiBjb29yZGluYXRlIGNsaWNrcyB0byBmb2N1cyBhbiBpbnB1dCBiZWZvcmUgY2FsbGluZyB0aGlzLiBDU1MgYXR0cmlidXRlIHNlbGVjdG9ycyBsaWtlIGNvbWJvYm94W2FyaWEtbGFiZWw9J1gnXSB3b3JrIGZvciBtb3N0IGlucHV0czsgZm9yIHNoYWRvdyBET00gaW5wdXRzIChlLmcuIEdvb2dsZSBTZWFyY2gpLCB0aGUgdG9vbCBhdXRvbWF0aWNhbGx5IHRyaWVzIGdldEJ5Um9sZSBmYWxsYmFja3MuXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0dGV4dDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJUZXh0IHRvIHR5cGVcIiB9KSxcblx0XHRcdHNlbGVjdG9yOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkNTUyBzZWxlY3RvciBvZiB0aGUgaW5wdXQgdG8gdHlwZSBpbnRvIChjbGlja3MgaXQgZmlyc3QpLiBFeGFtcGxlczogJ2lucHV0W25hbWU9cV0nLCAndGV4dGFyZWEnLCAnY29tYm9ib3hbYXJpYS1sYWJlbD1cXFwiU2VhcmNoXFxcIl0nLiBUaGUgdG9vbCB3aWxsIHRyeSBnZXRCeVJvbGUgZmFsbGJhY2tzIGlmIHRoZSBDU1Mgc2VsZWN0b3IgZmFpbHMuXCIgfSlcblx0XHRcdCksXG5cdFx0XHRjbGVhckZpcnN0OiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLkJvb2xlYW4oe1xuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XHRcdFx0XCJDbGVhciB0aGUgaW5wdXQncyBleGlzdGluZyB2YWx1ZSBiZWZvcmUgdHlwaW5nIChkZWZhdWx0OiBmYWxzZSkuIFVzZSB0aGlzIHdoZW4gcmVwbGFjaW5nIGV4aXN0aW5nIHRleHQuXCIsXG5cdFx0XHRcdH0pXG5cdFx0XHQpLFxuXHRcdFx0c3VibWl0OiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLkJvb2xlYW4oe1xuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIlByZXNzIEVudGVyIGFmdGVyIHR5cGluZyB0byBzdWJtaXQgdGhlIGZvcm0gKGRlZmF1bHQ6IGZhbHNlKS5cIixcblx0XHRcdFx0fSlcblx0XHRcdCksXG5cdFx0XHRzbG93bHk6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuQm9vbGVhbih7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XHRcIlR5cGUgb25lIGNoYXJhY3RlciBhdCBhIHRpbWUgaW5zdGVhZCBvZiBmaWxsaW5nIGF0b21pY2FsbHkuIFVzZSB3aGVuIHlvdSBuZWVkIHRvIHRyaWdnZXIga2V5IGhhbmRsZXJzIChlLmcuIHNlYXJjaCBhdXRvY29tcGxldGUpLiBEZWZhdWx0OiBmYWxzZS5cIixcblx0XHRcdFx0fSlcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0bGV0IGFjdGlvbklkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblx0XHRcdGxldCBiZWZvcmVTdGF0ZTogQ29tcGFjdFBhZ2VTdGF0ZSB8IG51bGwgPSBudWxsO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBwYWdlOiBwIH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblx0XHRcdFx0Y29uc3QgdGFyZ2V0ID0gZGVwcy5nZXRBY3RpdmVUYXJnZXQoKTtcblx0XHRcdFx0YmVmb3JlU3RhdGUgPSBhd2FpdCBkZXBzLmNhcHR1cmVDb21wYWN0UGFnZVN0YXRlKHAsIHsgc2VsZWN0b3JzOiBwYXJhbXMuc2VsZWN0b3IgPyBbcGFyYW1zLnNlbGVjdG9yXSA6IFtdLCBpbmNsdWRlQm9keVRleHQ6IHRydWUsIHRhcmdldCB9KTtcblx0XHRcdFx0YWN0aW9uSWQgPSBkZXBzLmJlZ2luVHJhY2tlZEFjdGlvbihcImJyb3dzZXJfdHlwZVwiLCBwYXJhbXMsIGJlZm9yZVN0YXRlLnVybCkuaWQ7XG5cdFx0XHRcdGNvbnN0IGJlZm9yZVVybCA9IHAudXJsKCk7XG5cblx0XHRcdFx0YXN5bmMgZnVuY3Rpb24gZm9jdXNWaWFSb2xlKHNlbGVjdG9yOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcblx0XHRcdFx0XHRjb25zdCBuYW1lTWF0Y2ggPSBzZWxlY3Rvci5tYXRjaCgvXFxbKD86YXJpYS1sYWJlbHxuYW1lfHBsYWNlaG9sZGVyKT1cIihbXlwiXSspXCJcXF0vaSk7XG5cdFx0XHRcdFx0Y29uc3Qgcm9sZU5hbWUgPSBuYW1lTWF0Y2g/LlsxXTtcblx0XHRcdFx0XHRmb3IgKGNvbnN0IHJvbGUgb2YgW1wiY29tYm9ib3hcIiwgXCJzZWFyY2hib3hcIiwgXCJ0ZXh0Ym94XCJdIGFzIGNvbnN0KSB7XG5cdFx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0XHRjb25zdCBsb2MgPSByb2xlTmFtZVxuXHRcdFx0XHRcdFx0XHRcdD8gdGFyZ2V0LmdldEJ5Um9sZShyb2xlLCB7IG5hbWU6IG5ldyBSZWdFeHAocm9sZU5hbWUsIFwiaVwiKSB9KVxuXHRcdFx0XHRcdFx0XHRcdDogdGFyZ2V0LmdldEJ5Um9sZShyb2xlKTtcblx0XHRcdFx0XHRcdFx0YXdhaXQgbG9jLmZpcnN0KCkuY2xpY2soeyB0aW1lb3V0OiAzMDAwIH0pO1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdFx0XHRcdH0gY2F0Y2ggeyAvKiB0cnkgbmV4dCAqLyB9XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdHJldHVybiBmYWxzZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChwYXJhbXMuc2VsZWN0b3IpIHtcblx0XHRcdFx0XHRpZiAocGFyYW1zLnNsb3dseSkge1xuXHRcdFx0XHRcdFx0bGV0IGZvY3VzZWQgPSBmYWxzZTtcblx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdGF3YWl0IHRhcmdldC5sb2NhdG9yKHBhcmFtcy5zZWxlY3RvcikuZmlyc3QoKS5jbGljayh7IHRpbWVvdXQ6IDUwMDAgfSk7XG5cdFx0XHRcdFx0XHRcdGZvY3VzZWQgPSB0cnVlO1xuXHRcdFx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0XHRcdGZvY3VzZWQgPSBhd2FpdCBmb2N1c1ZpYVJvbGUocGFyYW1zLnNlbGVjdG9yKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGlmICghZm9jdXNlZCkgdGhyb3cgbmV3IEVycm9yKGBDb3VsZCBub3QgZm9jdXMgc2VsZWN0b3IgXCIke3BhcmFtcy5zZWxlY3Rvcn1cImApO1xuXHRcdFx0XHRcdFx0aWYgKHBhcmFtcy5jbGVhckZpcnN0KSB7XG5cdFx0XHRcdFx0XHRcdGF3YWl0IHAua2V5Ym9hcmQucHJlc3MoXCJDb250cm9sK0FcIik7XG5cdFx0XHRcdFx0XHRcdGF3YWl0IHAua2V5Ym9hcmQucHJlc3MoXCJEZWxldGVcIik7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRhd2FpdCBwLmtleWJvYXJkLnR5cGUocGFyYW1zLnRleHQpO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRsZXQgZmlsbGVkID0gZmFsc2U7XG5cdFx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0XHRhd2FpdCB0YXJnZXQubG9jYXRvcihwYXJhbXMuc2VsZWN0b3IpLmZpcnN0KCkuZmlsbChwYXJhbXMudGV4dCwgeyB0aW1lb3V0OiA1MDAwIH0pO1xuXHRcdFx0XHRcdFx0XHRmaWxsZWQgPSB0cnVlO1xuXHRcdFx0XHRcdFx0fSBjYXRjaCB7IC8qIGZhbGwgdGhyb3VnaCAqLyB9XG5cblx0XHRcdFx0XHRcdGlmICghZmlsbGVkKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IG5hbWVNYXRjaCA9IHBhcmFtcy5zZWxlY3Rvci5tYXRjaCgvXFxbKD86YXJpYS1sYWJlbHxuYW1lfHBsYWNlaG9sZGVyKT1cIihbXlwiXSspXCJcXF0vaSk7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHJvbGVOYW1lID0gbmFtZU1hdGNoPy5bMV07XG5cdFx0XHRcdFx0XHRcdGZvciAoY29uc3Qgcm9sZSBvZiBbXCJjb21ib2JveFwiLCBcInNlYXJjaGJveFwiLCBcInRleHRib3hcIl0gYXMgY29uc3QpIHtcblx0XHRcdFx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0XHRcdFx0Y29uc3QgbG9jID0gcm9sZU5hbWVcblx0XHRcdFx0XHRcdFx0XHRcdFx0PyB0YXJnZXQuZ2V0QnlSb2xlKHJvbGUsIHsgbmFtZTogbmV3IFJlZ0V4cChyb2xlTmFtZSwgXCJpXCIpIH0pXG5cdFx0XHRcdFx0XHRcdFx0XHRcdDogdGFyZ2V0LmdldEJ5Um9sZShyb2xlKTtcblx0XHRcdFx0XHRcdFx0XHRcdGF3YWl0IGxvYy5maXJzdCgpLmZpbGwocGFyYW1zLnRleHQsIHsgdGltZW91dDogMzAwMCB9KTtcblx0XHRcdFx0XHRcdFx0XHRcdGZpbGxlZCA9IHRydWU7XG5cdFx0XHRcdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRcdFx0XHR9IGNhdGNoIHsgLyogdHJ5IG5leHQgKi8gfVxuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGlmICghZmlsbGVkKSB7XG5cdFx0XHRcdFx0XHRcdGxldCBmb2N1c2VkID0gZmFsc2U7XG5cdFx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdFx0YXdhaXQgdGFyZ2V0LmxvY2F0b3IocGFyYW1zLnNlbGVjdG9yKS5maXJzdCgpLmNsaWNrKHsgdGltZW91dDogNTAwMCB9KTtcblx0XHRcdFx0XHRcdFx0XHRmb2N1c2VkID0gdHJ1ZTtcblx0XHRcdFx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0XHRcdFx0Zm9jdXNlZCA9IGF3YWl0IGZvY3VzVmlhUm9sZShwYXJhbXMuc2VsZWN0b3IpO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdGlmICghZm9jdXNlZCkgdGhyb3cgbmV3IEVycm9yKGBDb3VsZCBub3QgZm9jdXMgc2VsZWN0b3IgXCIke3BhcmFtcy5zZWxlY3Rvcn1cImApO1xuXHRcdFx0XHRcdFx0XHRpZiAocGFyYW1zLmNsZWFyRmlyc3QpIHtcblx0XHRcdFx0XHRcdFx0XHRhd2FpdCBwLmtleWJvYXJkLnByZXNzKFwiQ29udHJvbCtBXCIpO1xuXHRcdFx0XHRcdFx0XHRcdGF3YWl0IHAua2V5Ym9hcmQucHJlc3MoXCJEZWxldGVcIik7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0YXdhaXQgdGFyZ2V0LmxvY2F0b3IoXCI6Zm9jdXNcIikucHJlc3NTZXF1ZW50aWFsbHkocGFyYW1zLnRleHQsIHsgdGltZW91dDogNTAwMCB9KS5jYXRjaCgoKSA9PlxuXHRcdFx0XHRcdFx0XHRcdHAua2V5Ym9hcmQudHlwZShwYXJhbXMudGV4dClcblx0XHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdH0gZWxzZSBpZiAocGFyYW1zLmNsZWFyRmlyc3QpIHtcblx0XHRcdFx0XHRcdFx0Ly8gZmlsbCgpIGFscmVhZHkgcmVwbGFjZWQgdGhlIHZhbHVlOyBjbGVhckZpcnN0IGlzIGEgbm8tb3AgaGVyZVxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRjb25zdCBoYXNGb2N1cyA9IGF3YWl0IHRhcmdldC5ldmFsdWF0ZSgoKSA9PiB7XG5cdFx0XHRcdFx0XHRjb25zdCBlbCA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ7XG5cdFx0XHRcdFx0XHRyZXR1cm4gISEoZWwgJiYgZWwgIT09IGRvY3VtZW50LmJvZHkgJiYgZWwgIT09IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCk7XG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0aWYgKCFoYXNGb2N1cykge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiVHlwZSBmYWlsZWQ6IG5vIGVsZW1lbnQgaXMgZm9jdXNlZC4gVXNlIGJyb3dzZXJfY2xpY2sgdG8gZm9jdXMgYW4gaW5wdXQgZmlyc3QsIG9yIHByb3ZpZGUgYSBzZWxlY3Rvci5cIiB9XSxcblx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogXCJubyBmb2N1c2VkIGVsZW1lbnRcIiB9LFxuXHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0YXdhaXQgdGFyZ2V0LmxvY2F0b3IoXCI6Zm9jdXNcIikucHJlc3NTZXF1ZW50aWFsbHkocGFyYW1zLnRleHQsIHsgdGltZW91dDogMTAwMDAgfSkuY2F0Y2goKCkgPT5cblx0XHRcdFx0XHRcdHAua2V5Ym9hcmQudHlwZShwYXJhbXMudGV4dClcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKHBhcmFtcy5zdWJtaXQpIHtcblx0XHRcdFx0XHRhd2FpdCBwLmtleWJvYXJkLnByZXNzKFwiRW50ZXJcIik7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCBzZXR0bGUgPSBhd2FpdCBkZXBzLnNldHRsZUFmdGVyQWN0aW9uQWRhcHRpdmUocCk7XG5cblx0XHRcdFx0Y29uc3QgdHlwZWRWYWx1ZSA9IGF3YWl0IGRlcHMucmVhZElucHV0TGlrZVZhbHVlKHRhcmdldCwgcGFyYW1zLnNlbGVjdG9yKTtcblx0XHRcdFx0Y29uc3QgYWZ0ZXJVcmwgPSBwLnVybCgpO1xuXHRcdFx0XHRjb25zdCB2ZXJpZmljYXRpb24gPSBkZXBzLnZlcmlmaWNhdGlvbkZyb21DaGVja3MoXG5cdFx0XHRcdFx0W1xuXHRcdFx0XHRcdFx0eyBuYW1lOiBcInZhbHVlX2VxdWFsc19leHBlY3RlZFwiLCBwYXNzZWQ6IHR5cGVkVmFsdWUgPT09IHBhcmFtcy50ZXh0LCB2YWx1ZTogdHlwZWRWYWx1ZSwgZXhwZWN0ZWQ6IHBhcmFtcy50ZXh0IH0sXG5cdFx0XHRcdFx0XHR7IG5hbWU6IFwidmFsdWVfY29udGFpbnNfZXhwZWN0ZWRcIiwgcGFzc2VkOiB0eXBlb2YgdHlwZWRWYWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiB0eXBlZFZhbHVlLmluY2x1ZGVzKHBhcmFtcy50ZXh0KSwgdmFsdWU6IHR5cGVkVmFsdWUsIGV4cGVjdGVkOiBwYXJhbXMudGV4dCB9LFxuXHRcdFx0XHRcdFx0eyBuYW1lOiBcInVybF9jaGFuZ2VkX2FmdGVyX3N1Ym1pdFwiLCBwYXNzZWQ6ICEhcGFyYW1zLnN1Ym1pdCAmJiBhZnRlclVybCAhPT0gYmVmb3JlVXJsLCB2YWx1ZTogYWZ0ZXJVcmwsIGV4cGVjdGVkOiBgIT0gJHtiZWZvcmVVcmx9YCB9LFxuXHRcdFx0XHRcdF0sXG5cdFx0XHRcdFx0XCJUcnkgY2xlYXJGaXJzdD10cnVlLCB1c2UgYSBtb3JlIHNwZWNpZmljIHNlbGVjdG9yLCBvciBzZXQgc2xvd2x5PXRydWUgZm9yIGtleS1kcml2ZW4gaW5wdXRzLlwiXG5cdFx0XHRcdCk7XG5cdFx0XHRcdGNvbnN0IHR5cGVUYXJnZXQgPSBwYXJhbXMuc2VsZWN0b3IgPyBgIGludG8gXCIke3BhcmFtcy5zZWxlY3Rvcn1cImAgOiBcIlwiO1xuXHRcdFx0XHRjb25zdCBhZnRlclN0YXRlID0gYXdhaXQgZGVwcy5jYXB0dXJlQ29tcGFjdFBhZ2VTdGF0ZShwLCB7IHNlbGVjdG9yczogcGFyYW1zLnNlbGVjdG9yID8gW3BhcmFtcy5zZWxlY3Rvcl0gOiBbXSwgaW5jbHVkZUJvZHlUZXh0OiB0cnVlLCB0YXJnZXQgfSk7XG5cdFx0XHRcdGNvbnN0IHN1bW1hcnkgPSBkZXBzLmZvcm1hdENvbXBhY3RTdGF0ZVN1bW1hcnkoYWZ0ZXJTdGF0ZSk7XG5cdFx0XHRcdGNvbnN0IGpzRXJyb3JzID0gZGVwcy5nZXRSZWNlbnRFcnJvcnMocC51cmwoKSk7XG5cdFx0XHRcdGNvbnN0IGRpZmYgPSBkaWZmQ29tcGFjdFN0YXRlcyhiZWZvcmVTdGF0ZSEsIGFmdGVyU3RhdGUpO1xuXHRcdFx0XHRzZXRMYXN0QWN0aW9uQmVmb3JlU3RhdGUoYmVmb3JlU3RhdGUhKTtcblx0XHRcdFx0c2V0TGFzdEFjdGlvbkFmdGVyU3RhdGUoYWZ0ZXJTdGF0ZSk7XG5cdFx0XHRcdGRlcHMuZmluaXNoVHJhY2tlZEFjdGlvbihhY3Rpb25JZCEsIHtcblx0XHRcdFx0XHRzdGF0dXM6IFwic3VjY2Vzc1wiLFxuXHRcdFx0XHRcdGFmdGVyVXJsOiBhZnRlclN0YXRlLnVybCxcblx0XHRcdFx0XHR2ZXJpZmljYXRpb25TdW1tYXJ5OiB2ZXJpZmljYXRpb24udmVyaWZpY2F0aW9uU3VtbWFyeSxcblx0XHRcdFx0XHR3YXJuaW5nU3VtbWFyeToganNFcnJvcnMudHJpbSgpIHx8IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRkaWZmU3VtbWFyeTogZGlmZi5zdW1tYXJ5LFxuXHRcdFx0XHRcdGNoYW5nZWQ6IGRpZmYuY2hhbmdlZCxcblx0XHRcdFx0XHRiZWZvcmVTdGF0ZTogYmVmb3JlU3RhdGUhLFxuXHRcdFx0XHRcdGFmdGVyU3RhdGUsXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBUeXBlZCBcIiR7cGFyYW1zLnRleHR9XCIke3R5cGVUYXJnZXR9XFxuQWN0aW9uOiAke2FjdGlvbklkfVxcbiR7ZGVwcy52ZXJpZmljYXRpb25MaW5lKHZlcmlmaWNhdGlvbil9JHtqc0Vycm9yc31cXG5cXG5EaWZmOlxcbiR7ZGVwcy5mb3JtYXREaWZmVGV4dChkaWZmKX1cXG5cXG5QYWdlIHN1bW1hcnk6XFxuJHtzdW1tYXJ5fWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyB0ZXh0OiBwYXJhbXMudGV4dCwgc2VsZWN0b3I6IHBhcmFtcy5zZWxlY3RvciwgdHlwZWRWYWx1ZSwgYWN0aW9uSWQsIGRpZmYsIC4uLnNldHRsZSwgLi4udmVyaWZpY2F0aW9uIH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRpZiAoYWN0aW9uSWQgIT09IG51bGwpIHtcblx0XHRcdFx0XHRkZXBzLmZpbmlzaFRyYWNrZWRBY3Rpb24oYWN0aW9uSWQsIHsgc3RhdHVzOiBcImVycm9yXCIsIGFmdGVyVXJsOiBkZXBzLmdldEFjdGl2ZVBhZ2VPck51bGwoKT8udXJsKCkgPz8gXCJcIiwgZXJyb3I6IGVyci5tZXNzYWdlLCBiZWZvcmVTdGF0ZTogYmVmb3JlU3RhdGUgPz8gdW5kZWZpbmVkIH0pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IGVycm9yU2hvdCA9IGF3YWl0IGRlcHMuY2FwdHVyZUVycm9yU2NyZWVuc2hvdChkZXBzLmdldEFjdGl2ZVBhZ2VPck51bGwoKSk7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQ6IGFueVtdID0gW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBUeXBlIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gIH1dO1xuXHRcdFx0XHRpZiAoZXJyb3JTaG90KSB7XG5cdFx0XHRcdFx0Y29udGVudC5wdXNoKHsgdHlwZTogXCJpbWFnZVwiLCBkYXRhOiBlcnJvclNob3QuZGF0YSwgbWltZVR5cGU6IGVycm9yU2hvdC5taW1lVHlwZSB9KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQsXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gYnJvd3Nlcl91cGxvYWRfZmlsZVxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX3VwbG9hZF9maWxlXCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBVcGxvYWQgRmlsZVwiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJTZXQgZmlsZXMgb24gYSBmaWxlIGlucHV0IGVsZW1lbnQuIFRoZSBzZWxlY3RvciBtdXN0IHRhcmdldCBhbiA8aW5wdXQgdHlwZT1cXFwiZmlsZVxcXCI+IGVsZW1lbnQuIEFjY2VwdHMgb25lIG9yIG1vcmUgYWJzb2x1dGUgZmlsZSBwYXRocy5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRzZWxlY3RvcjogVHlwZS5TdHJpbmcoe1xuXHRcdFx0XHRkZXNjcmlwdGlvbjogJ0NTUyBzZWxlY3RvciB0YXJnZXRpbmcgdGhlIDxpbnB1dCB0eXBlPVwiZmlsZVwiPiBlbGVtZW50Jyxcblx0XHRcdH0pLFxuXHRcdFx0ZmlsZXM6IFR5cGUuQXJyYXkoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJBYnNvbHV0ZSBwYXRoIHRvIGEgZmlsZVwiIH0pLCB7XG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBcIk9uZSBvciBtb3JlIGZpbGUgcGF0aHMgdG8gdXBsb2FkXCIsXG5cdFx0XHR9KSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCB7IHBhZ2U6IHAgfSA9IGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCB0YXJnZXQgPSBkZXBzLmdldEFjdGl2ZVRhcmdldCgpO1xuXHRcdFx0XHRjb25zdCBjbGVhbkZpbGVzID0gcGFyYW1zLmZpbGVzLm1hcCgoZjogc3RyaW5nKSA9PiBmLnJlcGxhY2UoL15ALywgXCJcIikpO1xuXHRcdFx0XHRhd2FpdCB0YXJnZXQubG9jYXRvcihwYXJhbXMuc2VsZWN0b3IpLmZpcnN0KCkuc2V0SW5wdXRGaWxlcyhjbGVhbkZpbGVzKTtcblx0XHRcdFx0Y29uc3Qgc2V0dGxlID0gYXdhaXQgZGVwcy5zZXR0bGVBZnRlckFjdGlvbkFkYXB0aXZlKHApO1xuXG5cdFx0XHRcdGNvbnN0IGFmdGVyU3RhdGUgPSBhd2FpdCBkZXBzLmNhcHR1cmVDb21wYWN0UGFnZVN0YXRlKHAsIHsgaW5jbHVkZUJvZHlUZXh0OiBmYWxzZSwgdGFyZ2V0IH0pO1xuXHRcdFx0XHRjb25zdCBzdW1tYXJ5ID0gZGVwcy5mb3JtYXRDb21wYWN0U3RhdGVTdW1tYXJ5KGFmdGVyU3RhdGUpO1xuXHRcdFx0XHRjb25zdCBqc0Vycm9ycyA9IGRlcHMuZ2V0UmVjZW50RXJyb3JzKHAudXJsKCkpO1xuXG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3tcblx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0dGV4dDogYFVwbG9hZGVkICR7Y2xlYW5GaWxlcy5sZW5ndGh9IGZpbGUocykgdG8gXCIke3BhcmFtcy5zZWxlY3Rvcn1cIjogJHtjbGVhbkZpbGVzLmpvaW4oXCIsIFwiKX0ke2pzRXJyb3JzfVxcblxcblBhZ2Ugc3VtbWFyeTpcXG4ke3N1bW1hcnl9YCxcblx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IHNlbGVjdG9yOiBwYXJhbXMuc2VsZWN0b3IsIGZpbGVzOiBjbGVhbkZpbGVzLCAuLi5zZXR0bGUgfSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdGNvbnN0IGVycm9yU2hvdCA9IGF3YWl0IGRlcHMuY2FwdHVyZUVycm9yU2NyZWVuc2hvdChkZXBzLmdldEFjdGl2ZVBhZ2VPck51bGwoKSk7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQ6IGFueVtdID0gW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBVcGxvYWQgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfV07XG5cdFx0XHRcdGlmIChlcnJvclNob3QpIHtcblx0XHRcdFx0XHRjb250ZW50LnB1c2goeyB0eXBlOiBcImltYWdlXCIsIGRhdGE6IGVycm9yU2hvdC5kYXRhLCBtaW1lVHlwZTogZXJyb3JTaG90Lm1pbWVUeXBlIH0pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiB7IGNvbnRlbnQsIGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sIGlzRXJyb3I6IHRydWUgfTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfc2Nyb2xsXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfc2Nyb2xsXCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBTY3JvbGxcIixcblx0XHRkZXNjcmlwdGlvbjogXCJTY3JvbGwgdGhlIHBhZ2UgdXAgb3IgZG93biBieSBhIGdpdmVuIG51bWJlciBvZiBwaXhlbHMuIFJldHVybnMgc2Nyb2xsIHBvc2l0aW9uIChweCBhbmQgcGVyY2VudGFnZSkgYW5kIGFuIGFjY2Vzc2liaWxpdHkgc25hcHNob3Qgb2YgdGhlIHZpc2libGUgY29udGVudC5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRkaXJlY3Rpb246IFN0cmluZ0VudW0oW1widXBcIiwgXCJkb3duXCJdIGFzIGNvbnN0KSxcblx0XHRcdGFtb3VudDogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5OdW1iZXIoeyBkZXNjcmlwdGlvbjogXCJQaXhlbHMgdG8gc2Nyb2xsIChkZWZhdWx0OiAzMDApXCIgfSlcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBwYWdlOiBwIH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblx0XHRcdFx0Y29uc3QgdGFyZ2V0ID0gZGVwcy5nZXRBY3RpdmVUYXJnZXQoKTtcblx0XHRcdFx0Y29uc3QgcGl4ZWxzID0gcGFyYW1zLmFtb3VudCA/PyAzMDA7XG5cdFx0XHRcdGNvbnN0IGRlbHRhID0gcGFyYW1zLmRpcmVjdGlvbiA9PT0gXCJ1cFwiID8gLXBpeGVscyA6IHBpeGVscztcblx0XHRcdFx0YXdhaXQgcC5tb3VzZS53aGVlbCgwLCBkZWx0YSk7XG5cblx0XHRcdFx0Y29uc3Qgc2V0dGxlID0gYXdhaXQgZGVwcy5zZXR0bGVBZnRlckFjdGlvbkFkYXB0aXZlKHApO1xuXG5cdFx0XHRcdGNvbnN0IHNjcm9sbEluZm8gPSBhd2FpdCB0YXJnZXQuZXZhbHVhdGUoKCkgPT4gKHtcblx0XHRcdFx0XHRzY3JvbGxZOiBNYXRoLnJvdW5kKHdpbmRvdy5zY3JvbGxZKSxcblx0XHRcdFx0XHRzY3JvbGxIZWlnaHQ6IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5zY3JvbGxIZWlnaHQsXG5cdFx0XHRcdFx0Y2xpZW50SGVpZ2h0OiBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xpZW50SGVpZ2h0LFxuXHRcdFx0XHR9KSk7XG5cdFx0XHRcdGNvbnN0IG1heFNjcm9sbCA9IHNjcm9sbEluZm8uc2Nyb2xsSGVpZ2h0IC0gc2Nyb2xsSW5mby5jbGllbnRIZWlnaHQ7XG5cdFx0XHRcdGNvbnN0IHBlcmNlbnQgPSBtYXhTY3JvbGwgPiAwID8gTWF0aC5yb3VuZCgoc2Nyb2xsSW5mby5zY3JvbGxZIC8gbWF4U2Nyb2xsKSAqIDEwMCkgOiAwO1xuXG5cdFx0XHRcdGNvbnN0IGFmdGVyU3RhdGUgPSBhd2FpdCBkZXBzLmNhcHR1cmVDb21wYWN0UGFnZVN0YXRlKHAsIHsgaW5jbHVkZUJvZHlUZXh0OiBmYWxzZSwgdGFyZ2V0IH0pO1xuXHRcdFx0XHRjb25zdCBzdW1tYXJ5ID0gZGVwcy5mb3JtYXRDb21wYWN0U3RhdGVTdW1tYXJ5KGFmdGVyU3RhdGUpO1xuXHRcdFx0XHRjb25zdCBqc0Vycm9ycyA9IGRlcHMuZ2V0UmVjZW50RXJyb3JzKHAudXJsKCkpO1xuXG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdFx0dGV4dDogYFNjcm9sbGVkICR7cGFyYW1zLmRpcmVjdGlvbn0gYnkgJHtwaXhlbHN9cHhcXG5gICtcblx0XHRcdFx0XHRcdFx0XHQgIGBQb3NpdGlvbjogJHtzY3JvbGxJbmZvLnNjcm9sbFl9cHggLyAke3Njcm9sbEluZm8uc2Nyb2xsSGVpZ2h0fXB4ICgke3BlcmNlbnR9JSBkb3duKVxcbmAgK1xuXHRcdFx0XHRcdFx0XHRcdCAgYFZpZXdwb3J0IGhlaWdodDogJHtzY3JvbGxJbmZvLmNsaWVudEhlaWdodH1weCR7anNFcnJvcnN9XFxuXFxuUGFnZSBzdW1tYXJ5OlxcbiR7c3VtbWFyeX1gLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZGlyZWN0aW9uOiBwYXJhbXMuZGlyZWN0aW9uLCBhbW91bnQ6IHBpeGVscywgLi4uc2Nyb2xsSW5mbywgcGVyY2VudCwgLi4uc2V0dGxlIH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgU2Nyb2xsIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfaG92ZXJcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9ob3ZlclwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgSG92ZXJcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiTW92ZSB0aGUgbW91c2Ugb3ZlciBhbiBlbGVtZW50IHRvIHRyaWdnZXIgaG92ZXIgc3RhdGVzIFx1MjAxNCByZXZlYWxzIHRvb2x0aXBzLCBkcm9wZG93biBtZW51cywgQ1NTIDpob3ZlciBlZmZlY3RzLCBhbmQgb3RoZXIgaG92ZXItZGVwZW5kZW50IFVJLiBSZXR1cm5zIGEgY29tcGFjdCBwYWdlIHN1bW1hcnkgc2hvd2luZyB0aGUgcmVzdWx0aW5nIGhvdmVyIHN0YXRlLlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdHNlbGVjdG9yOiBUeXBlLlN0cmluZyh7XG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBcIkNTUyBzZWxlY3RvciBvZiB0aGUgZWxlbWVudCB0byBob3ZlciBvdmVyXCIsXG5cdFx0XHR9KSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCB7IHBhZ2U6IHAgfSA9IGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCB0YXJnZXQgPSBkZXBzLmdldEFjdGl2ZVRhcmdldCgpO1xuXHRcdFx0XHRhd2FpdCB0YXJnZXQubG9jYXRvcihwYXJhbXMuc2VsZWN0b3IpLmZpcnN0KCkuaG92ZXIoeyB0aW1lb3V0OiAxMDAwMCB9KTtcblx0XHRcdFx0Y29uc3Qgc2V0dGxlID0gYXdhaXQgZGVwcy5zZXR0bGVBZnRlckFjdGlvbkFkYXB0aXZlKHApO1xuXG5cdFx0XHRcdGNvbnN0IGFmdGVyU3RhdGUgPSBhd2FpdCBkZXBzLmNhcHR1cmVDb21wYWN0UGFnZVN0YXRlKHAsIHsgaW5jbHVkZUJvZHlUZXh0OiBmYWxzZSwgdGFyZ2V0IH0pO1xuXHRcdFx0XHRjb25zdCBzdW1tYXJ5ID0gZGVwcy5mb3JtYXRDb21wYWN0U3RhdGVTdW1tYXJ5KGFmdGVyU3RhdGUpO1xuXHRcdFx0XHRjb25zdCBqc0Vycm9ycyA9IGRlcHMuZ2V0UmVjZW50RXJyb3JzKHAudXJsKCkpO1xuXG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBIb3ZlcmluZyBvdmVyIFwiJHtwYXJhbXMuc2VsZWN0b3J9XCIke2pzRXJyb3JzfVxcblxcblBhZ2Ugc3VtbWFyeTpcXG4ke3N1bW1hcnl9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IHNlbGVjdG9yOiBwYXJhbXMuc2VsZWN0b3IsIC4uLnNldHRsZSB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0Y29uc3QgZXJyb3JTaG90ID0gYXdhaXQgZGVwcy5jYXB0dXJlRXJyb3JTY3JlZW5zaG90KGRlcHMuZ2V0QWN0aXZlUGFnZU9yTnVsbCgpKTtcblx0XHRcdFx0Y29uc3QgY29udGVudDogYW55W10gPSBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEhvdmVyIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gIH1dO1xuXHRcdFx0XHRpZiAoZXJyb3JTaG90KSB7XG5cdFx0XHRcdFx0Y29udGVudC5wdXNoKHsgdHlwZTogXCJpbWFnZVwiLCBkYXRhOiBlcnJvclNob3QuZGF0YSwgbWltZVR5cGU6IGVycm9yU2hvdC5taW1lVHlwZSB9KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQsXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gYnJvd3Nlcl9rZXlfcHJlc3Ncblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9rZXlfcHJlc3NcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIEtleSBQcmVzc1wiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJQcmVzcyBhIGtleWJvYXJkIGtleSBvciBrZXkgY29tYmluYXRpb24uIFJldHVybnMgYSBjb21wYWN0IHBhZ2Ugc3VtbWFyeSBwbHVzIGxpZ2h0d2VpZ2h0IHZlcmlmaWNhdGlvbiBkZXRhaWxzIGFmdGVyIHRoZSBrZXkgcHJlc3MuIFVzZSBmb3I6IHN1Ym1pdHRpbmcgZm9ybXMgKEVudGVyKSwgY2xvc2luZyBtb2RhbHMgKEVzY2FwZSksIG5hdmlnYXRpbmcgZm9jdXNhYmxlIGVsZW1lbnRzIChUYWIgLyBTaGlmdCtUYWIpLCBvcGVyYXRpbmcgZHJvcGRvd25zIGFuZCBtZW51cyAoQXJyb3dEb3duLCBBcnJvd1VwLCBTcGFjZSksIGNvcHlpbmcvcGFzdGluZyAoTWV0YStDLCBNZXRhK1YpLiBLZXkgbmFtZXMgZm9sbG93IHRoZSBET00gS2V5Ym9hcmRFdmVudCBrZXkgY29udmVudGlvbi5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRrZXk6IFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XCJLZXkgb3IgY29tYmluYXRpb24gdG8gcHJlc3MsIGUuZy4gJ0VudGVyJywgJ0VzY2FwZScsICdUYWInLCAnQXJyb3dEb3duJywgJ0Fycm93VXAnLCAnU3BhY2UnLCAnTWV0YStBJywgJ1NoaWZ0K1RhYicsICdDb250cm9sK0VudGVyJ1wiLFxuXHRcdFx0fSksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0bGV0IGFjdGlvbklkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblx0XHRcdGxldCBiZWZvcmVTdGF0ZTogQ29tcGFjdFBhZ2VTdGF0ZSB8IG51bGwgPSBudWxsO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBwYWdlOiBwIH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblx0XHRcdFx0Y29uc3QgdGFyZ2V0ID0gZGVwcy5nZXRBY3RpdmVUYXJnZXQoKTtcblx0XHRcdFx0YmVmb3JlU3RhdGUgPSBhd2FpdCBkZXBzLmNhcHR1cmVDb21wYWN0UGFnZVN0YXRlKHAsIHsgaW5jbHVkZUJvZHlUZXh0OiB0cnVlLCB0YXJnZXQgfSk7XG5cdFx0XHRcdGFjdGlvbklkID0gZGVwcy5iZWdpblRyYWNrZWRBY3Rpb24oXCJicm93c2VyX2tleV9wcmVzc1wiLCBwYXJhbXMsIGJlZm9yZVN0YXRlLnVybCkuaWQ7XG5cdFx0XHRcdGNvbnN0IGJlZm9yZVVybCA9IHAudXJsKCk7XG5cdFx0XHRcdGNvbnN0IGJlZm9yZUZvY3VzID0gYXdhaXQgcmVhZEZvY3VzZWREZXNjcmlwdG9yKHRhcmdldCk7XG5cblx0XHRcdFx0YXdhaXQgcC5rZXlib2FyZC5wcmVzcyhwYXJhbXMua2V5KTtcblx0XHRcdFx0Y29uc3Qgc2V0dGxlID0gYXdhaXQgZGVwcy5zZXR0bGVBZnRlckFjdGlvbkFkYXB0aXZlKHAsIHsgY2hlY2tGb2N1c1N0YWJpbGl0eTogdHJ1ZSB9KTtcblxuXHRcdFx0XHRjb25zdCBhZnRlclN0YXRlID0gYXdhaXQgZGVwcy5jYXB0dXJlQ29tcGFjdFBhZ2VTdGF0ZShwLCB7IGluY2x1ZGVCb2R5VGV4dDogdHJ1ZSwgdGFyZ2V0IH0pO1xuXHRcdFx0XHRjb25zdCBhZnRlclVybCA9IGFmdGVyU3RhdGUudXJsO1xuXHRcdFx0XHRjb25zdCBhZnRlckZvY3VzID0gYXdhaXQgcmVhZEZvY3VzZWREZXNjcmlwdG9yKHRhcmdldCk7XG5cdFx0XHRcdGNvbnN0IHZlcmlmaWNhdGlvbiA9IGRlcHMudmVyaWZpY2F0aW9uRnJvbUNoZWNrcyhcblx0XHRcdFx0XHRbXG5cdFx0XHRcdFx0XHR7IG5hbWU6IFwidXJsX2NoYW5nZWRcIiwgcGFzc2VkOiBhZnRlclVybCAhPT0gYmVmb3JlVXJsLCB2YWx1ZTogYWZ0ZXJVcmwsIGV4cGVjdGVkOiBgIT0gJHtiZWZvcmVVcmx9YCB9LFxuXHRcdFx0XHRcdFx0eyBuYW1lOiBcImZvY3VzX2NoYW5nZWRcIiwgcGFzc2VkOiBhZnRlckZvY3VzICE9PSBiZWZvcmVGb2N1cywgdmFsdWU6IGFmdGVyRm9jdXMsIGV4cGVjdGVkOiBgIT0gJHtiZWZvcmVGb2N1c31gIH0sXG5cdFx0XHRcdFx0XHR7IG5hbWU6IFwiZGlhbG9nX29wZW5cIiwgcGFzc2VkOiBhZnRlclN0YXRlLmRpYWxvZy5jb3VudCA+IGJlZm9yZVN0YXRlIS5kaWFsb2cuY291bnQsIHZhbHVlOiBhZnRlclN0YXRlLmRpYWxvZy5jb3VudCwgZXhwZWN0ZWQ6IGA+ICR7YmVmb3JlU3RhdGUhLmRpYWxvZy5jb3VudH1gIH0sXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRcIklmIHRoaXMga2V5IHNob3VsZCB0cmlnZ2VyIFVJIGNoYW5nZXMsIGNvbmZpcm0gZm9jdXMgaXMgb24gdGhlIGludGVuZGVkIGVsZW1lbnQgZmlyc3QuXCJcblx0XHRcdFx0KTtcblxuXHRcdFx0XHRjb25zdCBzdW1tYXJ5ID0gZGVwcy5mb3JtYXRDb21wYWN0U3RhdGVTdW1tYXJ5KGFmdGVyU3RhdGUpO1xuXHRcdFx0XHRjb25zdCBqc0Vycm9ycyA9IGRlcHMuZ2V0UmVjZW50RXJyb3JzKHAudXJsKCkpO1xuXHRcdFx0XHRjb25zdCBkaWZmID0gZGlmZkNvbXBhY3RTdGF0ZXMoYmVmb3JlU3RhdGUhLCBhZnRlclN0YXRlKTtcblx0XHRcdFx0c2V0TGFzdEFjdGlvbkJlZm9yZVN0YXRlKGJlZm9yZVN0YXRlISk7XG5cdFx0XHRcdHNldExhc3RBY3Rpb25BZnRlclN0YXRlKGFmdGVyU3RhdGUpO1xuXHRcdFx0XHRkZXBzLmZpbmlzaFRyYWNrZWRBY3Rpb24oYWN0aW9uSWQhLCB7XG5cdFx0XHRcdFx0c3RhdHVzOiBcInN1Y2Nlc3NcIixcblx0XHRcdFx0XHRhZnRlclVybDogYWZ0ZXJTdGF0ZS51cmwsXG5cdFx0XHRcdFx0dmVyaWZpY2F0aW9uU3VtbWFyeTogdmVyaWZpY2F0aW9uLnZlcmlmaWNhdGlvblN1bW1hcnksXG5cdFx0XHRcdFx0d2FybmluZ1N1bW1hcnk6IGpzRXJyb3JzLnRyaW0oKSB8fCB1bmRlZmluZWQsXG5cdFx0XHRcdFx0ZGlmZlN1bW1hcnk6IGRpZmYuc3VtbWFyeSxcblx0XHRcdFx0XHRjaGFuZ2VkOiBkaWZmLmNoYW5nZWQsXG5cdFx0XHRcdFx0YmVmb3JlU3RhdGU6IGJlZm9yZVN0YXRlISxcblx0XHRcdFx0XHRhZnRlclN0YXRlLFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgUHJlc3NlZCBcIiR7cGFyYW1zLmtleX1cIlxcbkFjdGlvbjogJHthY3Rpb25JZH1cXG4ke2RlcHMudmVyaWZpY2F0aW9uTGluZSh2ZXJpZmljYXRpb24pfSR7anNFcnJvcnN9XFxuXFxuRGlmZjpcXG4ke2RlcHMuZm9ybWF0RGlmZlRleHQoZGlmZil9XFxuXFxuUGFnZSBzdW1tYXJ5OlxcbiR7c3VtbWFyeX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsga2V5OiBwYXJhbXMua2V5LCBiZWZvcmVGb2N1cywgYWZ0ZXJGb2N1cywgYWN0aW9uSWQsIGRpZmYsIC4uLnNldHRsZSwgLi4udmVyaWZpY2F0aW9uIH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRpZiAoYWN0aW9uSWQgIT09IG51bGwpIHtcblx0XHRcdFx0XHRkZXBzLmZpbmlzaFRyYWNrZWRBY3Rpb24oYWN0aW9uSWQsIHsgc3RhdHVzOiBcImVycm9yXCIsIGFmdGVyVXJsOiBkZXBzLmdldEFjdGl2ZVBhZ2VPck51bGwoKT8udXJsKCkgPz8gXCJcIiwgZXJyb3I6IGVyci5tZXNzYWdlLCBiZWZvcmVTdGF0ZTogYmVmb3JlU3RhdGUgPz8gdW5kZWZpbmVkIH0pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IGVycm9yU2hvdCA9IGF3YWl0IGRlcHMuY2FwdHVyZUVycm9yU2NyZWVuc2hvdChkZXBzLmdldEFjdGl2ZVBhZ2VPck51bGwoKSk7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQ6IGFueVtdID0gW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBLZXkgcHJlc3MgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfV07XG5cdFx0XHRcdGlmIChlcnJvclNob3QpIHtcblx0XHRcdFx0XHRjb250ZW50LnB1c2goeyB0eXBlOiBcImltYWdlXCIsIGRhdGE6IGVycm9yU2hvdC5kYXRhLCBtaW1lVHlwZTogZXJyb3JTaG90Lm1pbWVUeXBlIH0pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudCxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSB9LFxuXHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG5cblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBicm93c2VyX3NlbGVjdF9vcHRpb25cblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9zZWxlY3Rfb3B0aW9uXCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBTZWxlY3QgT3B0aW9uXCIsXG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcIlNlbGVjdCBhbiBvcHRpb24gZnJvbSBhIDxzZWxlY3Q+IGRyb3Bkb3duIGVsZW1lbnQgYnkgaXRzIHZpc2libGUgbGFiZWwgb3IgdmFsdWUuIFJldHVybnMgYSBjb21wYWN0IHBhZ2Ugc3VtbWFyeSBwbHVzIGxpZ2h0d2VpZ2h0IHZlcmlmaWNhdGlvbiBkZXRhaWxzLiBGb3IgY3VzdG9tLWJ1aWx0IGRyb3Bkb3ducyB1c2UgYnJvd3Nlcl9jbGljayB0byBvcGVuIHRoZW0gdGhlbiBicm93c2VyX2NsaWNrIHRvIHBpY2sgdGhlIG9wdGlvbi5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRzZWxlY3RvcjogVHlwZS5TdHJpbmcoe1xuXHRcdFx0XHRkZXNjcmlwdGlvbjogXCJDU1Mgc2VsZWN0b3IgdGFyZ2V0aW5nIHRoZSA8c2VsZWN0PiBlbGVtZW50XCIsXG5cdFx0XHR9KSxcblx0XHRcdG9wdGlvbjogVHlwZS5TdHJpbmcoe1xuXHRcdFx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFx0XHRcIlRoZSBvcHRpb24gdG8gc2VsZWN0IFx1MjAxNCBjYW4gYmUgdGhlIHZpc2libGUgbGFiZWwgdGV4dCBvciB0aGUgdmFsdWUgYXR0cmlidXRlLiBXaWxsIHRyeSBsYWJlbCBmaXJzdCwgdGhlbiB2YWx1ZS5cIixcblx0XHRcdH0pLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdGxldCBhY3Rpb25JZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cdFx0XHRsZXQgYmVmb3JlU3RhdGU6IENvbXBhY3RQYWdlU3RhdGUgfCBudWxsID0gbnVsbDtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHsgcGFnZTogcCB9ID0gYXdhaXQgZGVwcy5lbnN1cmVCcm93c2VyKCk7XG5cdFx0XHRcdGNvbnN0IHRhcmdldCA9IGRlcHMuZ2V0QWN0aXZlVGFyZ2V0KCk7XG5cdFx0XHRcdGJlZm9yZVN0YXRlID0gYXdhaXQgZGVwcy5jYXB0dXJlQ29tcGFjdFBhZ2VTdGF0ZShwLCB7IHNlbGVjdG9yczogW3BhcmFtcy5zZWxlY3Rvcl0sIGluY2x1ZGVCb2R5VGV4dDogdHJ1ZSwgdGFyZ2V0IH0pO1xuXHRcdFx0XHRhY3Rpb25JZCA9IGRlcHMuYmVnaW5UcmFja2VkQWN0aW9uKFwiYnJvd3Nlcl9zZWxlY3Rfb3B0aW9uXCIsIHBhcmFtcywgYmVmb3JlU3RhdGUudXJsKS5pZDtcblxuXHRcdFx0XHRsZXQgc2VsZWN0ZWQ6IHN0cmluZ1tdO1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdHNlbGVjdGVkID0gYXdhaXQgdGFyZ2V0LnNlbGVjdE9wdGlvbihwYXJhbXMuc2VsZWN0b3IsIHsgbGFiZWw6IHBhcmFtcy5vcHRpb24gfSwgeyB0aW1lb3V0OiA1MDAwIH0pO1xuXHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRzZWxlY3RlZCA9IGF3YWl0IHRhcmdldC5zZWxlY3RPcHRpb24ocGFyYW1zLnNlbGVjdG9yLCB7IHZhbHVlOiBwYXJhbXMub3B0aW9uIH0sIHsgdGltZW91dDogNTAwMCB9KTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IHNldHRsZSA9IGF3YWl0IGRlcHMuc2V0dGxlQWZ0ZXJBY3Rpb25BZGFwdGl2ZShwKTtcblxuXHRcdFx0XHRjb25zdCBzZWxlY3RlZFN0YXRlID0gYXdhaXQgdGFyZ2V0LmxvY2F0b3IocGFyYW1zLnNlbGVjdG9yKS5maXJzdCgpLmV2YWx1YXRlKChlbCkgPT4ge1xuXHRcdFx0XHRcdGlmICghKGVsIGluc3RhbmNlb2YgSFRNTFNlbGVjdEVsZW1lbnQpKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4geyBzZWxlY3RlZFZhbHVlczogW10gYXMgc3RyaW5nW10sIHNlbGVjdGVkTGFiZWxzOiBbXSBhcyBzdHJpbmdbXSB9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRjb25zdCBzZWxlY3RlZE9wdGlvbnMgPSBBcnJheS5mcm9tKGVsLnNlbGVjdGVkT3B0aW9ucyB8fCBbXSk7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdHNlbGVjdGVkVmFsdWVzOiBzZWxlY3RlZE9wdGlvbnMubWFwKChvcHQpID0+IG9wdC52YWx1ZSksXG5cdFx0XHRcdFx0XHRzZWxlY3RlZExhYmVsczogc2VsZWN0ZWRPcHRpb25zLm1hcCgob3B0KSA9PiAob3B0LnRleHRDb250ZW50IHx8IFwiXCIpLnRyaW0oKSksXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGNvbnN0IG9wdGlvbk5lZWRsZSA9IHBhcmFtcy5vcHRpb24udG9Mb3dlckNhc2UoKTtcblx0XHRcdFx0Y29uc3QgdmVyaWZpY2F0aW9uID0gZGVwcy52ZXJpZmljYXRpb25Gcm9tQ2hlY2tzKFxuXHRcdFx0XHRcdFtcblx0XHRcdFx0XHRcdHsgbmFtZTogXCJzZWxlY3RlZF92YWx1ZXNfaW5jbHVkZV9vcHRpb25cIiwgcGFzc2VkOiBzZWxlY3RlZFN0YXRlLnNlbGVjdGVkVmFsdWVzLmluY2x1ZGVzKHBhcmFtcy5vcHRpb24pLCB2YWx1ZTogc2VsZWN0ZWRTdGF0ZS5zZWxlY3RlZFZhbHVlcywgZXhwZWN0ZWQ6IHBhcmFtcy5vcHRpb24gfSxcblx0XHRcdFx0XHRcdHsgbmFtZTogXCJzZWxlY3RlZF9sYWJlbHNfaW5jbHVkZV9vcHRpb25cIiwgcGFzc2VkOiBzZWxlY3RlZFN0YXRlLnNlbGVjdGVkTGFiZWxzLnNvbWUoKGxhYmVsKSA9PiBsYWJlbC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKG9wdGlvbk5lZWRsZSkpLCB2YWx1ZTogc2VsZWN0ZWRTdGF0ZS5zZWxlY3RlZExhYmVscywgZXhwZWN0ZWQ6IHBhcmFtcy5vcHRpb24gfSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdFwiQ29uZmlybSB3aGV0aGVyIHRoZSB0YXJnZXQgc2VsZWN0IHVzZXMgb3B0aW9uIGxhYmVsIG9yIHZhbHVlLCB0aGVuIHJldHJ5IHdpdGggdGhhdCBleGFjdCB0ZXh0LlwiXG5cdFx0XHRcdCk7XG5cblx0XHRcdFx0Y29uc3QgYWZ0ZXJTdGF0ZSA9IGF3YWl0IGRlcHMuY2FwdHVyZUNvbXBhY3RQYWdlU3RhdGUocCwgeyBzZWxlY3RvcnM6IFtwYXJhbXMuc2VsZWN0b3JdLCBpbmNsdWRlQm9keVRleHQ6IHRydWUsIHRhcmdldCB9KTtcblx0XHRcdFx0Y29uc3Qgc3VtbWFyeSA9IGRlcHMuZm9ybWF0Q29tcGFjdFN0YXRlU3VtbWFyeShhZnRlclN0YXRlKTtcblx0XHRcdFx0Y29uc3QganNFcnJvcnMgPSBkZXBzLmdldFJlY2VudEVycm9ycyhwLnVybCgpKTtcblx0XHRcdFx0Y29uc3QgZGlmZiA9IGRpZmZDb21wYWN0U3RhdGVzKGJlZm9yZVN0YXRlISwgYWZ0ZXJTdGF0ZSk7XG5cdFx0XHRcdHNldExhc3RBY3Rpb25CZWZvcmVTdGF0ZShiZWZvcmVTdGF0ZSEpO1xuXHRcdFx0XHRzZXRMYXN0QWN0aW9uQWZ0ZXJTdGF0ZShhZnRlclN0YXRlKTtcblx0XHRcdFx0ZGVwcy5maW5pc2hUcmFja2VkQWN0aW9uKGFjdGlvbklkISwge1xuXHRcdFx0XHRcdHN0YXR1czogXCJzdWNjZXNzXCIsXG5cdFx0XHRcdFx0YWZ0ZXJVcmw6IGFmdGVyU3RhdGUudXJsLFxuXHRcdFx0XHRcdHZlcmlmaWNhdGlvblN1bW1hcnk6IHZlcmlmaWNhdGlvbi52ZXJpZmljYXRpb25TdW1tYXJ5LFxuXHRcdFx0XHRcdHdhcm5pbmdTdW1tYXJ5OiBqc0Vycm9ycy50cmltKCkgfHwgdW5kZWZpbmVkLFxuXHRcdFx0XHRcdGRpZmZTdW1tYXJ5OiBkaWZmLnN1bW1hcnksXG5cdFx0XHRcdFx0Y2hhbmdlZDogZGlmZi5jaGFuZ2VkLFxuXHRcdFx0XHRcdGJlZm9yZVN0YXRlOiBiZWZvcmVTdGF0ZSEsXG5cdFx0XHRcdFx0YWZ0ZXJTdGF0ZSxcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0XHR0ZXh0OiBgU2VsZWN0ZWQgXCIke3BhcmFtcy5vcHRpb259XCIgaW4gXCIke3BhcmFtcy5zZWxlY3Rvcn1cIi4gVmFsdWVzOiAke3NlbGVjdGVkLmpvaW4oXCIsIFwiKX1cXG5BY3Rpb246ICR7YWN0aW9uSWR9XFxuJHtkZXBzLnZlcmlmaWNhdGlvbkxpbmUodmVyaWZpY2F0aW9uKX0ke2pzRXJyb3JzfVxcblxcbkRpZmY6XFxuJHtkZXBzLmZvcm1hdERpZmZUZXh0KGRpZmYpfVxcblxcblBhZ2Ugc3VtbWFyeTpcXG4ke3N1bW1hcnl9YCxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IHNlbGVjdG9yOiBwYXJhbXMuc2VsZWN0b3IsIG9wdGlvbjogcGFyYW1zLm9wdGlvbiwgc2VsZWN0ZWQsIHNlbGVjdGVkU3RhdGUsIGFjdGlvbklkLCBkaWZmLCAuLi5zZXR0bGUsIC4uLnZlcmlmaWNhdGlvbiB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0aWYgKGFjdGlvbklkICE9PSBudWxsKSB7XG5cdFx0XHRcdFx0ZGVwcy5maW5pc2hUcmFja2VkQWN0aW9uKGFjdGlvbklkLCB7IHN0YXR1czogXCJlcnJvclwiLCBhZnRlclVybDogZGVwcy5nZXRBY3RpdmVQYWdlT3JOdWxsKCk/LnVybCgpID8/IFwiXCIsIGVycm9yOiBlcnIubWVzc2FnZSwgYmVmb3JlU3RhdGU6IGJlZm9yZVN0YXRlID8/IHVuZGVmaW5lZCB9KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBlcnJvclNob3QgPSBhd2FpdCBkZXBzLmNhcHR1cmVFcnJvclNjcmVlbnNob3QoZGVwcy5nZXRBY3RpdmVQYWdlT3JOdWxsKCkpO1xuXHRcdFx0XHRjb25zdCBjb250ZW50OiBhbnlbXSA9IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgU2VsZWN0IG9wdGlvbiBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XTtcblx0XHRcdFx0aWYgKGVycm9yU2hvdCkge1xuXHRcdFx0XHRcdGNvbnRlbnQucHVzaCh7IHR5cGU6IFwiaW1hZ2VcIiwgZGF0YTogZXJyb3JTaG90LmRhdGEsIG1pbWVUeXBlOiBlcnJvclNob3QubWltZVR5cGUgfSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50LFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfc2V0X2NoZWNrZWRcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9zZXRfY2hlY2tlZFwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgU2V0IENoZWNrZWRcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiQ2hlY2sgb3IgdW5jaGVjayBhIGNoZWNrYm94IG9yIHJhZGlvIGJ1dHRvbi4gTW9yZSByZWxpYWJsZSB0aGFuIGNsaWNraW5nIGZvciBmb3JtIGVsZW1lbnRzIHdoZXJlIHlvdSBuZWVkIGEgc3BlY2lmaWMgc3RhdGUuXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0c2VsZWN0b3I6IFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0ZGVzY3JpcHRpb246IFwiQ1NTIHNlbGVjdG9yIHRhcmdldGluZyB0aGUgY2hlY2tib3ggb3IgcmFkaW8gaW5wdXRcIixcblx0XHRcdH0pLFxuXHRcdFx0Y2hlY2tlZDogVHlwZS5Cb29sZWFuKHtcblx0XHRcdFx0ZGVzY3JpcHRpb246IFwidHJ1ZSB0byBjaGVjaywgZmFsc2UgdG8gdW5jaGVja1wiLFxuXHRcdFx0fSksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0bGV0IGFjdGlvbklkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblx0XHRcdGxldCBiZWZvcmVTdGF0ZTogQ29tcGFjdFBhZ2VTdGF0ZSB8IG51bGwgPSBudWxsO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBwYWdlOiBwIH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblx0XHRcdFx0Y29uc3QgdGFyZ2V0ID0gZGVwcy5nZXRBY3RpdmVUYXJnZXQoKTtcblx0XHRcdFx0YmVmb3JlU3RhdGUgPSBhd2FpdCBkZXBzLmNhcHR1cmVDb21wYWN0UGFnZVN0YXRlKHAsIHsgc2VsZWN0b3JzOiBbcGFyYW1zLnNlbGVjdG9yXSwgaW5jbHVkZUJvZHlUZXh0OiB0cnVlLCB0YXJnZXQgfSk7XG5cdFx0XHRcdGFjdGlvbklkID0gZGVwcy5iZWdpblRyYWNrZWRBY3Rpb24oXCJicm93c2VyX3NldF9jaGVja2VkXCIsIHBhcmFtcywgYmVmb3JlU3RhdGUudXJsKS5pZDtcblx0XHRcdFx0YXdhaXQgdGFyZ2V0LmxvY2F0b3IocGFyYW1zLnNlbGVjdG9yKS5maXJzdCgpLnNldENoZWNrZWQocGFyYW1zLmNoZWNrZWQsIHsgdGltZW91dDogMTAwMDAgfSk7XG5cdFx0XHRcdGNvbnN0IHNldHRsZSA9IGF3YWl0IGRlcHMuc2V0dGxlQWZ0ZXJBY3Rpb25BZGFwdGl2ZShwKTtcblxuXHRcdFx0XHRjb25zdCBhY3R1YWxDaGVja2VkID0gYXdhaXQgdGFyZ2V0LmxvY2F0b3IocGFyYW1zLnNlbGVjdG9yKS5maXJzdCgpLmlzQ2hlY2tlZCgpLmNhdGNoKCgpID0+IG51bGwpO1xuXHRcdFx0XHRjb25zdCB2ZXJpZmljYXRpb24gPSBkZXBzLnZlcmlmaWNhdGlvbkZyb21DaGVja3MoXG5cdFx0XHRcdFx0W1xuXHRcdFx0XHRcdFx0eyBuYW1lOiBcImNoZWNrZWRfc3RhdGVfbWF0Y2hlc1wiLCBwYXNzZWQ6IGFjdHVhbENoZWNrZWQgPT09IHBhcmFtcy5jaGVja2VkLCB2YWx1ZTogYWN0dWFsQ2hlY2tlZCwgZXhwZWN0ZWQ6IHBhcmFtcy5jaGVja2VkIH0sXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRcIkVuc3VyZSBzZWxlY3RvciBwb2ludHMgdG8gYSBjaGVja2JveC9yYWRpbyBpbnB1dCBhbmQgcmV0cnkuXCJcblx0XHRcdFx0KTtcblxuXHRcdFx0XHRjb25zdCBzdGF0ZSA9IHBhcmFtcy5jaGVja2VkID8gXCJjaGVja2VkXCIgOiBcInVuY2hlY2tlZFwiO1xuXHRcdFx0XHRjb25zdCBhZnRlclN0YXRlID0gYXdhaXQgZGVwcy5jYXB0dXJlQ29tcGFjdFBhZ2VTdGF0ZShwLCB7IHNlbGVjdG9yczogW3BhcmFtcy5zZWxlY3Rvcl0sIGluY2x1ZGVCb2R5VGV4dDogdHJ1ZSwgdGFyZ2V0IH0pO1xuXHRcdFx0XHRjb25zdCBzdW1tYXJ5ID0gZGVwcy5mb3JtYXRDb21wYWN0U3RhdGVTdW1tYXJ5KGFmdGVyU3RhdGUpO1xuXHRcdFx0XHRjb25zdCBqc0Vycm9ycyA9IGRlcHMuZ2V0UmVjZW50RXJyb3JzKHAudXJsKCkpO1xuXHRcdFx0XHRjb25zdCBkaWZmID0gZGlmZkNvbXBhY3RTdGF0ZXMoYmVmb3JlU3RhdGUhLCBhZnRlclN0YXRlKTtcblx0XHRcdFx0c2V0TGFzdEFjdGlvbkJlZm9yZVN0YXRlKGJlZm9yZVN0YXRlISk7XG5cdFx0XHRcdHNldExhc3RBY3Rpb25BZnRlclN0YXRlKGFmdGVyU3RhdGUpO1xuXHRcdFx0XHRkZXBzLmZpbmlzaFRyYWNrZWRBY3Rpb24oYWN0aW9uSWQhLCB7XG5cdFx0XHRcdFx0c3RhdHVzOiBcInN1Y2Nlc3NcIixcblx0XHRcdFx0XHRhZnRlclVybDogYWZ0ZXJTdGF0ZS51cmwsXG5cdFx0XHRcdFx0dmVyaWZpY2F0aW9uU3VtbWFyeTogdmVyaWZpY2F0aW9uLnZlcmlmaWNhdGlvblN1bW1hcnksXG5cdFx0XHRcdFx0d2FybmluZ1N1bW1hcnk6IGpzRXJyb3JzLnRyaW0oKSB8fCB1bmRlZmluZWQsXG5cdFx0XHRcdFx0ZGlmZlN1bW1hcnk6IGRpZmYuc3VtbWFyeSxcblx0XHRcdFx0XHRjaGFuZ2VkOiBkaWZmLmNoYW5nZWQsXG5cdFx0XHRcdFx0YmVmb3JlU3RhdGU6IGJlZm9yZVN0YXRlISxcblx0XHRcdFx0XHRhZnRlclN0YXRlLFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdHRleHQ6IGBTZXQgXCIke3BhcmFtcy5zZWxlY3Rvcn1cIiB0byAke3N0YXRlfVxcbkFjdGlvbjogJHthY3Rpb25JZH1cXG4ke2RlcHMudmVyaWZpY2F0aW9uTGluZSh2ZXJpZmljYXRpb24pfSR7anNFcnJvcnN9XFxuXFxuRGlmZjpcXG4ke2RlcHMuZm9ybWF0RGlmZlRleHQoZGlmZil9XFxuXFxuUGFnZSBzdW1tYXJ5OlxcbiR7c3VtbWFyeX1gLFxuXHRcdFx0XHRcdH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgc2VsZWN0b3I6IHBhcmFtcy5zZWxlY3RvciwgY2hlY2tlZDogcGFyYW1zLmNoZWNrZWQsIGFjdHVhbENoZWNrZWQsIGFjdGlvbklkLCBkaWZmLCAuLi5zZXR0bGUsIC4uLnZlcmlmaWNhdGlvbiB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0aWYgKGFjdGlvbklkICE9PSBudWxsKSB7XG5cdFx0XHRcdFx0ZGVwcy5maW5pc2hUcmFja2VkQWN0aW9uKGFjdGlvbklkLCB7IHN0YXR1czogXCJlcnJvclwiLCBhZnRlclVybDogZGVwcy5nZXRBY3RpdmVQYWdlT3JOdWxsKCk/LnVybCgpID8/IFwiXCIsIGVycm9yOiBlcnIubWVzc2FnZSwgYmVmb3JlU3RhdGU6IGJlZm9yZVN0YXRlID8/IHVuZGVmaW5lZCB9KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBlcnJvclNob3QgPSBhd2FpdCBkZXBzLmNhcHR1cmVFcnJvclNjcmVlbnNob3QoZGVwcy5nZXRBY3RpdmVQYWdlT3JOdWxsKCkpO1xuXHRcdFx0XHRjb25zdCBjb250ZW50OiBhbnlbXSA9IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgU2V0IGNoZWNrZWQgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfV07XG5cdFx0XHRcdGlmIChlcnJvclNob3QpIHtcblx0XHRcdFx0XHRjb250ZW50LnB1c2goeyB0eXBlOiBcImltYWdlXCIsIGRhdGE6IGVycm9yU2hvdC5kYXRhLCBtaW1lVHlwZTogZXJyb3JTaG90Lm1pbWVUeXBlIH0pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiB7IGNvbnRlbnQsIGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sIGlzRXJyb3I6IHRydWUgfTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfc2V0X3ZpZXdwb3J0XG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfc2V0X3ZpZXdwb3J0XCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBTZXQgVmlld3BvcnRcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiUmVzaXplIHRoZSBicm93c2VyIHZpZXdwb3J0IHRvIHRlc3QgcmVzcG9uc2l2ZSBsYXlvdXRzIGF0IGRpZmZlcmVudCBzY3JlZW4gc2l6ZXMuIFVzZSBwcmVzZXRzIGZvciBjb21tb24gYnJlYWtwb2ludHMgb3Igc3BlY2lmeSBleGFjdCBwaXhlbCBkaW1lbnNpb25zLiBFc3NlbnRpYWwgZm9yIHZlcmlmeWluZyBtb2JpbGUvdGFibGV0L2Rlc2t0b3AgbGF5b3V0cy5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRwcmVzZXQ6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFN0cmluZ0VudW0oW1wibW9iaWxlXCIsIFwidGFibGV0XCIsIFwiZGVza3RvcFwiLCBcIndpZGVcIl0gYXMgY29uc3QpXG5cdFx0XHQpLFxuXHRcdFx0d2lkdGg6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiQ3VzdG9tIHZpZXdwb3J0IHdpZHRoIGluIHBpeGVscyAocmVxdWlyZXMgaGVpZ2h0IHRvbylcIiB9KVxuXHRcdFx0KSxcblx0XHRcdGhlaWdodDogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5OdW1iZXIoeyBkZXNjcmlwdGlvbjogXCJDdXN0b20gdmlld3BvcnQgaGVpZ2h0IGluIHBpeGVscyAocmVxdWlyZXMgd2lkdGggdG9vKVwiIH0pXG5cdFx0XHQpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHsgcGFnZTogcCB9ID0gYXdhaXQgZGVwcy5lbnN1cmVCcm93c2VyKCk7XG5cblx0XHRcdFx0bGV0IHdpZHRoOiBudW1iZXI7XG5cdFx0XHRcdGxldCBoZWlnaHQ6IG51bWJlcjtcblx0XHRcdFx0bGV0IGxhYmVsOiBzdHJpbmc7XG5cblx0XHRcdFx0aWYgKHBhcmFtcy5wcmVzZXQpIHtcblx0XHRcdFx0XHRzd2l0Y2ggKHBhcmFtcy5wcmVzZXQpIHtcblx0XHRcdFx0XHRcdGNhc2UgXCJtb2JpbGVcIjpcblx0XHRcdFx0XHRcdFx0d2lkdGggPSAzOTA7XG5cdFx0XHRcdFx0XHRcdGhlaWdodCA9IDg0NDtcblx0XHRcdFx0XHRcdFx0bGFiZWwgPSBcIm1vYmlsZSAoMzkwXHUwMEQ3ODQ0KVwiO1xuXHRcdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRcdGNhc2UgXCJ0YWJsZXRcIjpcblx0XHRcdFx0XHRcdFx0d2lkdGggPSA3Njg7XG5cdFx0XHRcdFx0XHRcdGhlaWdodCA9IDEwMjQ7XG5cdFx0XHRcdFx0XHRcdGxhYmVsID0gXCJ0YWJsZXQgKDc2OFx1MDBENzEwMjQpXCI7XG5cdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0Y2FzZSBcImRlc2t0b3BcIjpcblx0XHRcdFx0XHRcdFx0d2lkdGggPSAxMjgwO1xuXHRcdFx0XHRcdFx0XHRoZWlnaHQgPSA4MDA7XG5cdFx0XHRcdFx0XHRcdGxhYmVsID0gXCJkZXNrdG9wICgxMjgwXHUwMEQ3ODAwKVwiO1xuXHRcdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRcdGNhc2UgXCJ3aWRlXCI6XG5cdFx0XHRcdFx0XHRcdHdpZHRoID0gMTkyMDtcblx0XHRcdFx0XHRcdFx0aGVpZ2h0ID0gMTA4MDtcblx0XHRcdFx0XHRcdFx0bGFiZWwgPSBcIndpZGUgKDE5MjBcdTAwRDcxMDgwKVwiO1xuXHRcdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0gZWxzZSBpZiAocGFyYW1zLndpZHRoICE9PSB1bmRlZmluZWQgJiYgcGFyYW1zLmhlaWdodCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0d2lkdGggPSBwYXJhbXMud2lkdGg7XG5cdFx0XHRcdFx0aGVpZ2h0ID0gcGFyYW1zLmhlaWdodDtcblx0XHRcdFx0XHRsYWJlbCA9IGBjdXN0b20gKCR7d2lkdGh9XHUwMEQ3JHtoZWlnaHR9KWA7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0XHRcdHRleHQ6IFwiUHJvdmlkZSBlaXRoZXIgYSBwcmVzZXQgKG1vYmlsZS90YWJsZXQvZGVza3RvcC93aWRlKSBvciBib3RoIHdpZHRoIGFuZCBoZWlnaHQuXCIsXG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczoge30sXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRhd2FpdCBwLnNldFZpZXdwb3J0U2l6ZSh7IHdpZHRoOiB3aWR0aCEsIGhlaWdodDogaGVpZ2h0ISB9KTtcblxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgVmlld3BvcnQgc2V0IHRvICR7bGFiZWwhfWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyB3aWR0aDogd2lkdGghLCBoZWlnaHQ6IGhlaWdodCEsIGxhYmVsOiBsYWJlbCEgfSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBTZXQgdmlld3BvcnQgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsa0JBQWtCO0FBQzNCO0FBQUEsRUFDQztBQUFBLE9BQ007QUFFUDtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUNQLFNBQVMsNkJBQTZCO0FBRS9CLFNBQVMseUJBQXlCLElBQWtCLE1BQXNCO0FBSWhGLEtBQUcsYUFBYTtBQUFBLElBQ2YsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDQztBQUFBLElBQ0QsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN2QixVQUFVLEtBQUs7QUFBQSxRQUNkLEtBQUssT0FBTyxFQUFFLGFBQWEsOEhBQThILENBQUM7QUFBQSxNQUMzSjtBQUFBLE1BQ0EsR0FBRyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSx3QkFBd0IsQ0FBQyxDQUFDO0FBQUEsTUFDdEUsR0FBRyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSx3QkFBd0IsQ0FBQyxDQUFDO0FBQUEsSUFDdkUsQ0FBQztBQUFBLElBRUQsTUFBTSxRQUFRLGFBQWEsUUFBUSxTQUFTLFdBQVcsTUFBTTtBQUM1RCxVQUFJLFdBQTBCO0FBQzlCLFVBQUksY0FBdUM7QUFDM0MsVUFBSTtBQUNILGNBQU0sRUFBRSxNQUFNLEVBQUUsSUFBSSxNQUFNLEtBQUssY0FBYztBQUM3QyxjQUFNLFNBQVMsS0FBSyxnQkFBZ0I7QUFDcEMsc0JBQWMsTUFBTSxLQUFLLHdCQUF3QixHQUFHLEVBQUUsV0FBVyxPQUFPLFdBQVcsQ0FBQyxPQUFPLFFBQVEsSUFBSSxDQUFDLEdBQUcs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
