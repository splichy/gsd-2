import { Type } from "@sinclair/typebox";
import {
  setLastActionBeforeState,
  setLastActionAfterState
} from "../state.js";
function buildFormAnalysisScript(selector) {
  return `(() => {
		// --- helpers ---
		function isVisible(el) {
			if (!el) return false;
			const style = window.getComputedStyle(el);
			if (style.display === 'none' || style.visibility === 'hidden') return false;
			if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
			return true;
		}

		function humanizeName(name) {
			if (!name) return '';
			return name
				.replace(/([a-z])([A-Z])/g, '$1 $2')
				.replace(/[_\\-]+/g, ' ')
				.replace(/\\bid\\b/i, 'ID')
				.trim()
				.replace(/^./, c => c.toUpperCase());
		}

		function getTextContent(el) {
			if (!el) return '';
			return (el.textContent || '').trim().replace(/\\s+/g, ' ');
		}

		// --- label resolution (7-level priority chain) ---
		function resolveLabel(field) {
			// 1. aria-labelledby
			const labelledBy = field.getAttribute('aria-labelledby');
			if (labelledBy) {
				const parts = labelledBy.split(/\\s+/).map(id => {
					const el = document.getElementById(id);
					return el ? getTextContent(el) : '';
				}).filter(Boolean);
				if (parts.length) return parts.join(' ');
			}

			// 2. aria-label
			const ariaLabel = field.getAttribute('aria-label');
			if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

			// 3. label[for="id"]
			const fieldId = field.id;
			if (fieldId) {
				const labelFor = document.querySelector('label[for="' + CSS.escape(fieldId) + '"]');
				if (labelFor) {
					const text = getTextContent(labelFor);
					if (text) return text;
				}
			}

			// 4. wrapping label
			const wrappingLabel = field.closest('label');
			if (wrappingLabel) {
				// Clone and remove the field itself to get just the label text
				const clone = wrappingLabel.cloneNode(true);
				const inputs = clone.querySelectorAll('input, select, textarea');
				inputs.forEach(inp => inp.remove());
				const text = (clone.textContent || '').trim().replace(/\\s+/g, ' ');
				if (text) return text;
			}

			// 5. placeholder
			const placeholder = field.getAttribute('placeholder');
			if (placeholder && placeholder.trim()) return placeholder.trim();

			// 6. title
			const title = field.getAttribute('title');
			if (title && title.trim()) return title.trim();

			// 7. humanized name
			const name = field.getAttribute('name');
			if (name) return humanizeName(name);

			return '';
		}

		// --- form detection ---
		let form;
		const selectorArg = ${JSON.stringify(selector ?? null)};

		if (selectorArg) {
			form = document.querySelector(selectorArg);
			if (!form) return { error: 'Form not found for selector: ' + selectorArg };
		} else {
			const forms = Array.from(document.querySelectorAll('form'));
			if (forms.length === 1) {
				form = forms[0];
			} else if (forms.length > 1) {
				// Pick form with most visible inputs
				let best = null;
				let bestCount = -1;
				for (const f of forms) {
					const inputs = f.querySelectorAll('input, select, textarea');
					let visCount = 0;
					inputs.forEach(inp => { if (isVisible(inp)) visCount++; });
					if (visCount > bestCount) {
						bestCount = visCount;
						best = f;
					}
				}
				form = best;
			} else {
				form = document.body;
			}
		}

		// Build a useful selector for the form
		let formSelector = 'body';
		if (form !== document.body) {
			if (form.id) {
				formSelector = '#' + CSS.escape(form.id);
			} else if (form.getAttribute('name')) {
				formSelector = 'form[name="' + form.getAttribute('name') + '"]';
			} else if (form.getAttribute('action')) {
				formSelector = 'form[action="' + form.getAttribute('action') + '"]';
			} else {
				// nth-of-type fallback
				const allForms = Array.from(document.querySelectorAll('form'));
				const idx = allForms.indexOf(form);
				formSelector = idx >= 0 ? 'form:nth-of-type(' + (idx + 1) + ')' : 'form';
			}
		}

		// --- field inventory ---
		const fieldElements = form.querySelectorAll('input, select, textarea');
		const fields = [];

		fieldElements.forEach(field => {
			const tag = field.tagName.toLowerCase();
			const type = tag === 'select' ? 'select'
				: tag === 'textarea' ? 'textarea'
				: (field.getAttribute('type') || 'text').toLowerCase();

			// Skip submit/button/reset/image inputs \u2014 they're not data fields
			if (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(type)) return;

			const label = resolveLabel(field);
			const name = field.getAttribute('name') || '';
			const id = field.id || '';
			const required = field.required || field.getAttribute('aria-required') === 'true';
			const hidden = type === 'hidden' || !isVisible(field);
			const disabled = field.disabled;

			// Value
			let value = '';
			if (tag === 'select') {
				const selected = field.querySelector('option:checked');
				value = selected ? selected.value : '';
			} else {
				value = field.value || '';
			}

			const info = {
				type,
				name,
				id,
				label,
				required,
				value,
				hidden,
				disabled,
				validation: {
					valid: field.validity ? field.validity.valid : true,
					message: field.validationMessage || '',
				},
			};

			// Checked state for checkboxes/radios
			if (type === 'checkbox' || type === 'radio') {
				info.checked = field.checked;
			}

			// Options for select elements
			if (tag === 'select') {
				info.options = Array.from(field.querySelectorAll('option')).map(opt => ({
					value: opt.value,
					label: opt.textContent.trim(),
					selected: opt.selected,
				}));
			}

			// Fieldset/legend group
			const fieldset = field.closest('fieldset');
			if (fieldset) {
				const legend = fieldset.querySelector('legend');
				if (legend) {
					info.group = getTextContent(legend);
				}
			}

			fields.push(info);
		});

		// --- submit buttons ---
		const submitButtons = [];
		const buttonCandidates = form.querySelectorAll('button, input[type="submit"]');
		buttonCandidates.forEach(btn => {
			const tag = btn.tagName.toLowerCase();
			const type = (btn.getAttribute('type') || (tag === 'button' ? 'submit' : '')).toLowerCase();
			// Include: explicit submit, or button without explicit type (defaults to submit)
			if (type === 'submit' || (tag === 'button' && !btn.getAttribute('type'))) {
				submitButtons.push({
					tag,
					type: type || 'submit',
					text: tag === 'input' ? (btn.value || '') : getTextContent(btn),
					name: btn.getAttribute('name') || '',
					disabled: btn.disabled,
				});
			}
		});

		const visibleFieldCount = fields.filter(f => !f.hidden).length;

		return {
			formSelector,
			fields,
			submitButtons,
			fieldCount: fields.length,
			visibleFieldCount,
		};
	})()`;
}
function buildPostFillValidationScript(formSelector) {
  return `(() => {
		const form = ${JSON.stringify(formSelector)} === 'body'
			? document.body
			: document.querySelector(${JSON.stringify(formSelector)});
		if (!form) return { valid: false, invalidCount: 0, fields: [] };

		const fieldEls = form.querySelectorAll('input, select, textarea');
		let validCount = 0;
		let invalidCount = 0;
		const invalidFields = [];

		fieldEls.forEach(f => {
			const tag = f.tagName.toLowerCase();
			const type = tag === 'select' ? 'select'
				: tag === 'textarea' ? 'textarea'
				: (f.getAttribute('type') || 'text').toLowerCase();
			if (['submit', 'button', 'reset', 'image', 'hidden'].includes(type)) return;

			if (f.validity && !f.validity.valid) {
				invalidCount++;
				invalidFields.push({
					name: f.getAttribute('name') || f.id || type,
					message: f.validationMessage || 'Invalid',
				});
			} else {
				validCount++;
			}
		});

		return {
			valid: invalidCount === 0,
			validCount,
			invalidCount,
			invalidFields,
		};
	})()`;
}
function registerFormTools(pi, deps) {
  pi.registerTool({
    name: "browser_analyze_form",
    label: "Analyze Form",
    description: "Analyze a form on the current page and return a structured field inventory. Auto-detects the form if no selector is provided (picks the single <form>, or the form with most visible inputs, or falls back to document.body). Returns field types, labels (resolved via aria-labelledby \u2192 aria-label \u2192 label[for] \u2192 wrapping label \u2192 placeholder \u2192 title \u2192 name), values, validation state, and submit buttons.",
    parameters: Type.Object({
      selector: Type.Optional(
        Type.String({
          description: "CSS selector targeting the form element to analyze. If omitted, auto-detects the primary form on the page."
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
          selectors: params.selector ? [params.selector] : [],
          includeBodyText: false,
          target
        });
        actionId = deps.beginTrackedAction("browser_analyze_form", params, beforeState.url).id;
        const script = buildFormAnalysisScript(params.selector);
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
          selectors: params.selector ? [params.selector] : [],
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
        lines.push(`Form: ${result.formSelector}`);
        lines.push(`Fields: ${result.fieldCount} total, ${result.visibleFieldCount} visible`);
        lines.push(`Submit buttons: ${result.submitButtons.length}`);
        lines.push("");
        if (result.fields.length > 0) {
          lines.push("## Fields");
          for (const f of result.fields) {
            const flags = [];
            if (f.required) flags.push("required");
            if (f.hidden) flags.push("hidden");
            if (f.disabled) flags.push("disabled");
            if (f.checked !== void 0) flags.push(f.checked ? "checked" : "unchecked");
            if (!f.validation.valid) flags.push(`invalid: ${f.validation.message}`);
            const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
            const valueStr = f.value ? ` = "${f.value}"` : "";
            const labelStr = f.label || "(no label)";
            const selectorHint = f.id ? `#${f.id}` : f.name ? `[name="${f.name}"]` : f.type;
            const groupStr = f.group ? ` (group: ${f.group})` : "";
            lines.push(`- **${labelStr}** \`${f.type}\` \`${selectorHint}\`${valueStr}${flagStr}${groupStr}`);
            if (f.options && f.options.length > 0) {
              for (const opt of f.options) {
                const sel = opt.selected ? " \u2713" : "";
                lines.push(`  - ${opt.label} (${opt.value})${sel}`);
              }
            }
          }
          lines.push("");
        }
        if (result.submitButtons.length > 0) {
          lines.push("## Submit Buttons");
          for (const btn of result.submitButtons) {
            const disStr = btn.disabled ? " [disabled]" : "";
            lines.push(`- "${btn.text}" \`<${btn.tag} type="${btn.type}">\`${btn.name ? ` name="${btn.name}"` : ""}${disStr}`);
          }
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { formAnalysis: result }
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
          { type: "text", text: `browser_analyze_form failed: ${errMsg}` }
        ];
        if (screenshot) {
          content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType });
        }
        return { content, details: {}, isError: true };
      }
    }
  });
  pi.registerTool({
    name: "browser_fill_form",
    label: "Fill Form",
    description: "Fill a form on the current page using a values mapping. Keys are field identifiers (label text, name attribute, placeholder, or aria-label). Resolves fields by label \u2192 name \u2192 placeholder \u2192 aria-label (exact first, then case-insensitive). Uses fill() for text inputs, selectOption() for selects, setChecked() for checkboxes/radios. Skips file and hidden inputs. Optionally submits the form.",
    parameters: Type.Object({
      selector: Type.Optional(
        Type.String({
          description: "CSS selector targeting the form element. If omitted, auto-detects the primary form."
        })
      ),
      values: Type.Record(Type.String(), Type.String(), {
        description: "Mapping of field identifiers to values. Keys can be label text, name, placeholder, or aria-label. Values are strings \u2014 for checkboxes use 'true'/'false' or 'on'/'off', for selects use the option label or value."
      }),
      submit: Type.Optional(
        Type.Boolean({
          description: "If true, clicks the form's submit button after filling all fields."
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
          selectors: params.selector ? [params.selector] : [],
          includeBodyText: false,
          target
        });
        actionId = deps.beginTrackedAction("browser_fill_form", params, beforeState.url).id;
        const formSelector = params.selector ?? await target.evaluate(`(() => {
					const forms = Array.from(document.querySelectorAll('form'));
					if (forms.length === 1) {
						const f = forms[0];
						if (f.id) return '#' + CSS.escape(f.id);
						if (f.getAttribute('name')) return 'form[name="' + f.getAttribute('name') + '"]';
						return 'form';
					} else if (forms.length > 1) {
						let best = null;
						let bestCount = -1;
						let bestIdx = 0;
						for (let i = 0; i < forms.length; i++) {
							const inputs = forms[i].querySelectorAll('input, select, textarea');
							let vis = 0;
							inputs.forEach(inp => {
								const s = window.getComputedStyle(inp);
								if (s.display !== 'none' && s.visibility !== 'hidden') vis++;
							});
							if (vis > bestCount) { bestCount = vis; best = forms[i]; bestIdx = i; }
						}
						if (best.id) return '#' + CSS.escape(best.id);
						if (best.getAttribute('name')) return 'form[name="' + best.getAttribute('name') + '"]';
						return 'form:nth-of-type(' + (bestIdx + 1) + ')';
					}
					return 'body';
				})()`);
        const formLocator = formSelector === "body" ? target.locator("body") : target.locator(formSelector);
        const matched = [];
        const unmatched = [];
        const skipped = [];
        for (const [key, value] of Object.entries(params.values)) {
          let resolvedLocator = null;
          let resolvedBy = "";
          try {
            const loc = formLocator.getByLabel(key, { exact: true });
            const count = await loc.count();
            if (count === 1) {
              resolvedLocator = loc;
              resolvedBy = "label (exact)";
            } else if (count > 1) {
              skipped.push({ key, reason: `Ambiguous: ${count} fields match label "${key}"` });
              continue;
            }
          } catch {
          }
          if (!resolvedLocator) {
            try {
              const loc = formLocator.getByLabel(key);
              const count = await loc.count();
              if (count === 1) {
                resolvedLocator = loc;
                resolvedBy = "label";
              } else if (count > 1) {
                skipped.push({ key, reason: `Ambiguous: ${count} fields match label "${key}" (case-insensitive)` });
                continue;
              }
            } catch {
            }
          }
          if (!resolvedLocator) {
            try {
              const loc = formLocator.locator(`[name="${CSS.escape(key)}"]`);
              const count = await loc.count();
              if (count === 1) {
                resolvedLocator = loc;
                resolvedBy = "name";
              } else if (count > 1) {
                skipped.push({ key, reason: `Ambiguous: ${count} fields match name="${key}"` });
                continue;
              }
            } catch {
            }
          }
          if (!resolvedLocator) {
            try {
              const loc = formLocator.locator(`[placeholder="${key}" i]`);
              const count = await loc.count();
              if (count === 1) {
                resolvedLocator = loc;
                resolvedBy = "placeholder";
              } else if (count > 1) {
                skipped.push({ key, reason: `Ambiguous: ${count} fields match placeholder="${key}"` });
                continue;
              }
            } catch {
            }
          }
          if (!resolvedLocator) {
            try {
              const loc = formLocator.locator(`[aria-label="${key}" i]`);
              const count = await loc.count();
              if (count === 1) {
                resolvedLocator = loc;
                resolvedBy = "aria-label";
              } else if (count > 1) {
                skipped.push({ key, reason: `Ambiguous: ${count} fields match aria-label="${key}"` });
                continue;
              }
            } catch {
            }
          }
          if (!resolvedLocator) {
            unmatched.push({ key, reason: "No matching field found" });
            continue;
          }
          const fieldInfo = await resolvedLocator.first().evaluate((el) => {
            const tag = el.tagName.toLowerCase();
            const type = tag === "select" ? "select" : tag === "textarea" ? "textarea" : (el.type || "text").toLowerCase();
            const hidden = type === "hidden" || window.getComputedStyle(el).display === "none" || window.getComputedStyle(el).visibility === "hidden";
            return { tag, type, hidden };
          });
          if (fieldInfo.type === "file") {
            skipped.push({ key, reason: "File input \u2014 use browser_upload_file instead" });
            continue;
          }
          if (fieldInfo.hidden) {
            skipped.push({ key, reason: "Hidden input" });
            continue;
          }
          try {
            if (fieldInfo.type === "checkbox" || fieldInfo.type === "radio") {
              const checked = value === "true" || value === "on";
              await resolvedLocator.first().setChecked(checked, { timeout: 5e3 });
              matched.push({ key, resolvedBy, value: checked ? "checked" : "unchecked", fieldType: fieldInfo.type });
            } else if (fieldInfo.tag === "select") {
              try {
                await resolvedLocator.first().selectOption({ label: value }, { timeout: 5e3 });
              } catch {
                await resolvedLocator.first().selectOption({ value }, { timeout: 5e3 });
              }
              matched.push({ key, resolvedBy, value, fieldType: "select" });
            } else {
              await resolvedLocator.first().fill(value, { timeout: 5e3 });
              matched.push({ key, resolvedBy, value, fieldType: fieldInfo.type });
            }
          } catch (fillErr) {
            const msg = fillErr instanceof Error ? fillErr.message : String(fillErr);
            skipped.push({ key, reason: `Fill failed: ${msg.split("\n")[0]}` });
          }
        }
        await deps.settleAfterActionAdaptive(p);
        let submitted = false;
        if (params.submit) {
          try {
            const submitLoc = formLocator.locator('[type="submit"], button:not([type])').first();
            const submitExists = await submitLoc.count();
            if (submitExists > 0) {
              await submitLoc.click({ timeout: 5e3 });
              await deps.settleAfterActionAdaptive(p);
              submitted = true;
            } else {
              skipped.push({ key: "_submit", reason: "No submit button found in form" });
            }
          } catch (submitErr) {
            const msg = submitErr instanceof Error ? submitErr.message : String(submitErr);
            skipped.push({ key: "_submit", reason: `Submit failed: ${msg.split("\n")[0]}` });
          }
        }
        const validationSummary = await target.evaluate(
          buildPostFillValidationScript(formSelector)
        );
        const afterState = await deps.captureCompactPageState(p, {
          selectors: params.selector ? [params.selector] : [],
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
        lines.push(`Form: ${formSelector}`);
        lines.push(`Filled: ${matched.length} | Unmatched: ${unmatched.length} | Skipped: ${skipped.length}${submitted ? " | Submitted: yes" : ""}`);
        lines.push("");
        if (matched.length > 0) {
          lines.push("## Matched");
          for (const m of matched) {
            lines.push(`- \u2713 **${m.key}** \u2192 "${m.value}" (${m.fieldType}, resolved by ${m.resolvedBy})`);
          }
          lines.push("");
        }
        if (unmatched.length > 0) {
          lines.push("## Unmatched");
          for (const u of unmatched) {
            lines.push(`- \u2717 **${u.key}** \u2014 ${u.reason}`);
          }
          lines.push("");
        }
        if (skipped.length > 0) {
          lines.push("## Skipped");
          for (const s of skipped) {
            lines.push(`- \u2298 **${s.key}** \u2014 ${s.reason}`);
          }
          lines.push("");
        }
        if (!validationSummary.valid) {
          lines.push("## Validation Issues");
          for (const inv of validationSummary.invalidFields) {
            lines.push(`- ${inv.name}: ${inv.message}`);
          }
        } else {
          lines.push("Validation: all fields valid \u2713");
        }
        const fillResult = {
          matched,
          unmatched,
          skipped,
          submitted,
          validationSummary
        };
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { fillResult }
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
          { type: "text", text: `browser_fill_form failed: ${errMsg}` }
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
  buildFormAnalysisScript,
  registerFormTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvZm9ybXMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgdHlwZSB7IFRvb2xEZXBzLCBDb21wYWN0UGFnZVN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlLmpzXCI7XG5pbXBvcnQge1xuXHRzZXRMYXN0QWN0aW9uQmVmb3JlU3RhdGUsXG5cdHNldExhc3RBY3Rpb25BZnRlclN0YXRlLFxufSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBGb3JtIGFuYWx5c2lzIGV2YWx1YXRlIGNhbGxiYWNrIFx1MjAxNCBydW5zIGluIHRoZSBicm93c2VyIGNvbnRleHQuXG4vLyBTZWxmLWNvbnRhaW5lZDogbm8gZXh0ZXJuYWwgZGVwcywgbm8gd2luZG93Ll9fcGkgY2FsbHMuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuaW50ZXJmYWNlIEZvcm1GaWVsZEluZm8ge1xuXHR0eXBlOiBzdHJpbmc7XG5cdG5hbWU6IHN0cmluZztcblx0aWQ6IHN0cmluZztcblx0bGFiZWw6IHN0cmluZztcblx0cmVxdWlyZWQ6IGJvb2xlYW47XG5cdHZhbHVlOiBzdHJpbmc7XG5cdGNoZWNrZWQ/OiBib29sZWFuO1xuXHRvcHRpb25zPzogQXJyYXk8eyB2YWx1ZTogc3RyaW5nOyBsYWJlbDogc3RyaW5nOyBzZWxlY3RlZDogYm9vbGVhbiB9Pjtcblx0dmFsaWRhdGlvbjogeyB2YWxpZDogYm9vbGVhbjsgbWVzc2FnZTogc3RyaW5nIH07XG5cdGhpZGRlbjogYm9vbGVhbjtcblx0ZGlzYWJsZWQ6IGJvb2xlYW47XG5cdGdyb3VwPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgRm9ybVN1Ym1pdEJ1dHRvbiB7XG5cdHRhZzogc3RyaW5nO1xuXHR0eXBlOiBzdHJpbmc7XG5cdHRleHQ6IHN0cmluZztcblx0bmFtZTogc3RyaW5nO1xuXHRkaXNhYmxlZDogYm9vbGVhbjtcbn1cblxuaW50ZXJmYWNlIEZvcm1BbmFseXNpc1Jlc3VsdCB7XG5cdGZvcm1TZWxlY3Rvcjogc3RyaW5nO1xuXHRmaWVsZHM6IEZvcm1GaWVsZEluZm9bXTtcblx0c3VibWl0QnV0dG9uczogRm9ybVN1Ym1pdEJ1dHRvbltdO1xuXHRmaWVsZENvdW50OiBudW1iZXI7XG5cdHZpc2libGVGaWVsZENvdW50OiBudW1iZXI7XG59XG5cbi8qKlxuICogUnVucyBpbnNpZGUgcGFnZS5ldmFsdWF0ZSgpLiBGaW5kcyB0aGUgdGFyZ2V0IGZvcm0sIGludmVudG9yaWVzIGFsbCBmaWVsZHNcbiAqIHdpdGggZnVsbCBsYWJlbCByZXNvbHV0aW9uLCBhbmQgcmV0dXJucyBhIHN0cnVjdHVyZWQgcmVzdWx0LlxuICovXG4vLyBFeHBvcnRlZCBmb3IgdGVzdHMgb25seSAoc2VlIHRlc3RzL2Jyb3dzZXItdG9vbHMtaW50ZWdyYXRpb24udGVzdC5tanMpLlxuLy8gS2VlcCB0aGlzIGZ1bmN0aW9uIHRyZWF0ZWQgYXMgbW9kdWxlLXByaXZhdGUgZm9yIHByb2R1Y3Rpb24gY2FsbCBzaXRlcyBcdTIwMTRcbi8vIHRoZSBvbmx5IGxlZ2l0aW1hdGUgZXh0ZXJuYWwgY2FsbGVyIGlzIHRoZSBQbGF5d3JpZ2h0LWRyaXZlbiBpbnRlZ3JhdGlvblxuLy8gc3VpdGUgdGhhdCBuZWVkcyB0byBldmFsdWF0ZSB0aGUgcmV0dXJuZWQgSUlGRSBhZ2FpbnN0IHJlYWwgRE9NLlxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRm9ybUFuYWx5c2lzU2NyaXB0KHNlbGVjdG9yPzogc3RyaW5nKTogc3RyaW5nIHtcblx0Ly8gV2UgcmV0dXJuIGEgc3RyaW5nIHRoYXQgd2lsbCBiZSBldmFsdWF0ZWQgaW4gdGhlIHBhZ2UgY29udGV4dC5cblx0Ly8gVGhpcyBhdm9pZHMgc2VyaWFsaXphdGlvbiBpc3N1ZXMgd2l0aCBwYXNzaW5nIGZ1bmN0aW9ucy5cblx0cmV0dXJuIGAoKCkgPT4ge1xuXHRcdC8vIC0tLSBoZWxwZXJzIC0tLVxuXHRcdGZ1bmN0aW9uIGlzVmlzaWJsZShlbCkge1xuXHRcdFx0aWYgKCFlbCkgcmV0dXJuIGZhbHNlO1xuXHRcdFx0Y29uc3Qgc3R5bGUgPSB3aW5kb3cuZ2V0Q29tcHV0ZWRTdHlsZShlbCk7XG5cdFx0XHRpZiAoc3R5bGUuZGlzcGxheSA9PT0gJ25vbmUnIHx8IHN0eWxlLnZpc2liaWxpdHkgPT09ICdoaWRkZW4nKSByZXR1cm4gZmFsc2U7XG5cdFx0XHRpZiAoZWwub2Zmc2V0V2lkdGggPT09IDAgJiYgZWwub2Zmc2V0SGVpZ2h0ID09PSAwKSByZXR1cm4gZmFsc2U7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9XG5cblx0XHRmdW5jdGlvbiBodW1hbml6ZU5hbWUobmFtZSkge1xuXHRcdFx0aWYgKCFuYW1lKSByZXR1cm4gJyc7XG5cdFx0XHRyZXR1cm4gbmFtZVxuXHRcdFx0XHQucmVwbGFjZSgvKFthLXpdKShbQS1aXSkvZywgJyQxICQyJylcblx0XHRcdFx0LnJlcGxhY2UoL1tfXFxcXC1dKy9nLCAnICcpXG5cdFx0XHRcdC5yZXBsYWNlKC9cXFxcYmlkXFxcXGIvaSwgJ0lEJylcblx0XHRcdFx0LnRyaW0oKVxuXHRcdFx0XHQucmVwbGFjZSgvXi4vLCBjID0+IGMudG9VcHBlckNhc2UoKSk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gZ2V0VGV4dENvbnRlbnQoZWwpIHtcblx0XHRcdGlmICghZWwpIHJldHVybiAnJztcblx0XHRcdHJldHVybiAoZWwudGV4dENvbnRlbnQgfHwgJycpLnRyaW0oKS5yZXBsYWNlKC9cXFxccysvZywgJyAnKTtcblx0XHR9XG5cblx0XHQvLyAtLS0gbGFiZWwgcmVzb2x1dGlvbiAoNy1sZXZlbCBwcmlvcml0eSBjaGFpbikgLS0tXG5cdFx0ZnVuY3Rpb24gcmVzb2x2ZUxhYmVsKGZpZWxkKSB7XG5cdFx0XHQvLyAxLiBhcmlhLWxhYmVsbGVkYnlcblx0XHRcdGNvbnN0IGxhYmVsbGVkQnkgPSBmaWVsZC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWxsZWRieScpO1xuXHRcdFx0aWYgKGxhYmVsbGVkQnkpIHtcblx0XHRcdFx0Y29uc3QgcGFydHMgPSBsYWJlbGxlZEJ5LnNwbGl0KC9cXFxccysvKS5tYXAoaWQgPT4ge1xuXHRcdFx0XHRcdGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpO1xuXHRcdFx0XHRcdHJldHVybiBlbCA/IGdldFRleHRDb250ZW50KGVsKSA6ICcnO1xuXHRcdFx0XHR9KS5maWx0ZXIoQm9vbGVhbik7XG5cdFx0XHRcdGlmIChwYXJ0cy5sZW5ndGgpIHJldHVybiBwYXJ0cy5qb2luKCcgJyk7XG5cdFx0XHR9XG5cblx0XHRcdC8vIDIuIGFyaWEtbGFiZWxcblx0XHRcdGNvbnN0IGFyaWFMYWJlbCA9IGZpZWxkLmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpO1xuXHRcdFx0aWYgKGFyaWFMYWJlbCAmJiBhcmlhTGFiZWwudHJpbSgpKSByZXR1cm4gYXJpYUxhYmVsLnRyaW0oKTtcblxuXHRcdFx0Ly8gMy4gbGFiZWxbZm9yPVwiaWRcIl1cblx0XHRcdGNvbnN0IGZpZWxkSWQgPSBmaWVsZC5pZDtcblx0XHRcdGlmIChmaWVsZElkKSB7XG5cdFx0XHRcdGNvbnN0IGxhYmVsRm9yID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignbGFiZWxbZm9yPVwiJyArIENTUy5lc2NhcGUoZmllbGRJZCkgKyAnXCJdJyk7XG5cdFx0XHRcdGlmIChsYWJlbEZvcikge1xuXHRcdFx0XHRcdGNvbnN0IHRleHQgPSBnZXRUZXh0Q29udGVudChsYWJlbEZvcik7XG5cdFx0XHRcdFx0aWYgKHRleHQpIHJldHVybiB0ZXh0O1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIDQuIHdyYXBwaW5nIGxhYmVsXG5cdFx0XHRjb25zdCB3cmFwcGluZ0xhYmVsID0gZmllbGQuY2xvc2VzdCgnbGFiZWwnKTtcblx0XHRcdGlmICh3cmFwcGluZ0xhYmVsKSB7XG5cdFx0XHRcdC8vIENsb25lIGFuZCByZW1vdmUgdGhlIGZpZWxkIGl0c2VsZiB0byBnZXQganVzdCB0aGUgbGFiZWwgdGV4dFxuXHRcdFx0XHRjb25zdCBjbG9uZSA9IHdyYXBwaW5nTGFiZWwuY2xvbmVOb2RlKHRydWUpO1xuXHRcdFx0XHRjb25zdCBpbnB1dHMgPSBjbG9uZS5xdWVyeVNlbGVjdG9yQWxsKCdpbnB1dCwgc2VsZWN0LCB0ZXh0YXJlYScpO1xuXHRcdFx0XHRpbnB1dHMuZm9yRWFjaChpbnAgPT4gaW5wLnJlbW92ZSgpKTtcblx0XHRcdFx0Y29uc3QgdGV4dCA9IChjbG9uZS50ZXh0Q29udGVudCB8fCAnJykudHJpbSgpLnJlcGxhY2UoL1xcXFxzKy9nLCAnICcpO1xuXHRcdFx0XHRpZiAodGV4dCkgcmV0dXJuIHRleHQ7XG5cdFx0XHR9XG5cblx0XHRcdC8vIDUuIHBsYWNlaG9sZGVyXG5cdFx0XHRjb25zdCBwbGFjZWhvbGRlciA9IGZpZWxkLmdldEF0dHJpYnV0ZSgncGxhY2Vob2xkZXInKTtcblx0XHRcdGlmIChwbGFjZWhvbGRlciAmJiBwbGFjZWhvbGRlci50cmltKCkpIHJldHVybiBwbGFjZWhvbGRlci50cmltKCk7XG5cblx0XHRcdC8vIDYuIHRpdGxlXG5cdFx0XHRjb25zdCB0aXRsZSA9IGZpZWxkLmdldEF0dHJpYnV0ZSgndGl0bGUnKTtcblx0XHRcdGlmICh0aXRsZSAmJiB0aXRsZS50cmltKCkpIHJldHVybiB0aXRsZS50cmltKCk7XG5cblx0XHRcdC8vIDcuIGh1bWFuaXplZCBuYW1lXG5cdFx0XHRjb25zdCBuYW1lID0gZmllbGQuZ2V0QXR0cmlidXRlKCduYW1lJyk7XG5cdFx0XHRpZiAobmFtZSkgcmV0dXJuIGh1bWFuaXplTmFtZShuYW1lKTtcblxuXHRcdFx0cmV0dXJuICcnO1xuXHRcdH1cblxuXHRcdC8vIC0tLSBmb3JtIGRldGVjdGlvbiAtLS1cblx0XHRsZXQgZm9ybTtcblx0XHRjb25zdCBzZWxlY3RvckFyZyA9ICR7SlNPTi5zdHJpbmdpZnkoc2VsZWN0b3IgPz8gbnVsbCl9O1xuXG5cdFx0aWYgKHNlbGVjdG9yQXJnKSB7XG5cdFx0XHRmb3JtID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWxlY3RvckFyZyk7XG5cdFx0XHRpZiAoIWZvcm0pIHJldHVybiB7IGVycm9yOiAnRm9ybSBub3QgZm91bmQgZm9yIHNlbGVjdG9yOiAnICsgc2VsZWN0b3JBcmcgfTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc3QgZm9ybXMgPSBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ2Zvcm0nKSk7XG5cdFx0XHRpZiAoZm9ybXMubGVuZ3RoID09PSAxKSB7XG5cdFx0XHRcdGZvcm0gPSBmb3Jtc1swXTtcblx0XHRcdH0gZWxzZSBpZiAoZm9ybXMubGVuZ3RoID4gMSkge1xuXHRcdFx0XHQvLyBQaWNrIGZvcm0gd2l0aCBtb3N0IHZpc2libGUgaW5wdXRzXG5cdFx0XHRcdGxldCBiZXN0ID0gbnVsbDtcblx0XHRcdFx0bGV0IGJlc3RDb3VudCA9IC0xO1xuXHRcdFx0XHRmb3IgKGNvbnN0IGYgb2YgZm9ybXMpIHtcblx0XHRcdFx0XHRjb25zdCBpbnB1dHMgPSBmLnF1ZXJ5U2VsZWN0b3JBbGwoJ2lucHV0LCBzZWxlY3QsIHRleHRhcmVhJyk7XG5cdFx0XHRcdFx0bGV0IHZpc0NvdW50ID0gMDtcblx0XHRcdFx0XHRpbnB1dHMuZm9yRWFjaChpbnAgPT4geyBpZiAoaXNWaXNpYmxlKGlucCkpIHZpc0NvdW50Kys7IH0pO1xuXHRcdFx0XHRcdGlmICh2aXNDb3VudCA+IGJlc3RDb3VudCkge1xuXHRcdFx0XHRcdFx0YmVzdENvdW50ID0gdmlzQ291bnQ7XG5cdFx0XHRcdFx0XHRiZXN0ID0gZjtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdFx0Zm9ybSA9IGJlc3Q7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRmb3JtID0gZG9jdW1lbnQuYm9keTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBCdWlsZCBhIHVzZWZ1bCBzZWxlY3RvciBmb3IgdGhlIGZvcm1cblx0XHRsZXQgZm9ybVNlbGVjdG9yID0gJ2JvZHknO1xuXHRcdGlmIChmb3JtICE9PSBkb2N1bWVudC5ib2R5KSB7XG5cdFx0XHRpZiAoZm9ybS5pZCkge1xuXHRcdFx0XHRmb3JtU2VsZWN0b3IgPSAnIycgKyBDU1MuZXNjYXBlKGZvcm0uaWQpO1xuXHRcdFx0fSBlbHNlIGlmIChmb3JtLmdldEF0dHJpYnV0ZSgnbmFtZScpKSB7XG5cdFx0XHRcdGZvcm1TZWxlY3RvciA9ICdmb3JtW25hbWU9XCInICsgZm9ybS5nZXRBdHRyaWJ1dGUoJ25hbWUnKSArICdcIl0nO1xuXHRcdFx0fSBlbHNlIGlmIChmb3JtLmdldEF0dHJpYnV0ZSgnYWN0aW9uJykpIHtcblx0XHRcdFx0Zm9ybVNlbGVjdG9yID0gJ2Zvcm1bYWN0aW9uPVwiJyArIGZvcm0uZ2V0QXR0cmlidXRlKCdhY3Rpb24nKSArICdcIl0nO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Ly8gbnRoLW9mLXR5cGUgZmFsbGJhY2tcblx0XHRcdFx0Y29uc3QgYWxsRm9ybXMgPSBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ2Zvcm0nKSk7XG5cdFx0XHRcdGNvbnN0IGlkeCA9IGFsbEZvcm1zLmluZGV4T2YoZm9ybSk7XG5cdFx0XHRcdGZvcm1TZWxlY3RvciA9IGlkeCA+PSAwID8gJ2Zvcm06bnRoLW9mLXR5cGUoJyArIChpZHggKyAxKSArICcpJyA6ICdmb3JtJztcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyAtLS0gZmllbGQgaW52ZW50b3J5IC0tLVxuXHRcdGNvbnN0IGZpZWxkRWxlbWVudHMgPSBmb3JtLnF1ZXJ5U2VsZWN0b3JBbGwoJ2lucHV0LCBzZWxlY3QsIHRleHRhcmVhJyk7XG5cdFx0Y29uc3QgZmllbGRzID0gW107XG5cblx0XHRmaWVsZEVsZW1lbnRzLmZvckVhY2goZmllbGQgPT4ge1xuXHRcdFx0Y29uc3QgdGFnID0gZmllbGQudGFnTmFtZS50b0xvd2VyQ2FzZSgpO1xuXHRcdFx0Y29uc3QgdHlwZSA9IHRhZyA9PT0gJ3NlbGVjdCcgPyAnc2VsZWN0J1xuXHRcdFx0XHQ6IHRhZyA9PT0gJ3RleHRhcmVhJyA/ICd0ZXh0YXJlYSdcblx0XHRcdFx0OiAoZmllbGQuZ2V0QXR0cmlidXRlKCd0eXBlJykgfHwgJ3RleHQnKS50b0xvd2VyQ2FzZSgpO1xuXG5cdFx0XHQvLyBTa2lwIHN1Ym1pdC9idXR0b24vcmVzZXQvaW1hZ2UgaW5wdXRzIFx1MjAxNCB0aGV5J3JlIG5vdCBkYXRhIGZpZWxkc1xuXHRcdFx0aWYgKHRhZyA9PT0gJ2lucHV0JyAmJiBbJ3N1Ym1pdCcsICdidXR0b24nLCAncmVzZXQnLCAnaW1hZ2UnXS5pbmNsdWRlcyh0eXBlKSkgcmV0dXJuO1xuXG5cdFx0XHRjb25zdCBsYWJlbCA9IHJlc29sdmVMYWJlbChmaWVsZCk7XG5cdFx0XHRjb25zdCBuYW1lID0gZmllbGQuZ2V0QXR0cmlidXRlKCduYW1lJykgfHwgJyc7XG5cdFx0XHRjb25zdCBpZCA9IGZpZWxkLmlkIHx8ICcnO1xuXHRcdFx0Y29uc3QgcmVxdWlyZWQgPSBmaWVsZC5yZXF1aXJlZCB8fCBmaWVsZC5nZXRBdHRyaWJ1dGUoJ2FyaWEtcmVxdWlyZWQnKSA9PT0gJ3RydWUnO1xuXHRcdFx0Y29uc3QgaGlkZGVuID0gdHlwZSA9PT0gJ2hpZGRlbicgfHwgIWlzVmlzaWJsZShmaWVsZCk7XG5cdFx0XHRjb25zdCBkaXNhYmxlZCA9IGZpZWxkLmRpc2FibGVkO1xuXG5cdFx0XHQvLyBWYWx1ZVxuXHRcdFx0bGV0IHZhbHVlID0gJyc7XG5cdFx0XHRpZiAodGFnID09PSAnc2VsZWN0Jykge1xuXHRcdFx0XHRjb25zdCBzZWxlY3RlZCA9IGZpZWxkLnF1ZXJ5U2VsZWN0b3IoJ29wdGlvbjpjaGVja2VkJyk7XG5cdFx0XHRcdHZhbHVlID0gc2VsZWN0ZWQgPyBzZWxlY3RlZC52YWx1ZSA6ICcnO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0dmFsdWUgPSBmaWVsZC52YWx1ZSB8fCAnJztcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgaW5mbyA9IHtcblx0XHRcdFx0dHlwZSxcblx0XHRcdFx0bmFtZSxcblx0XHRcdFx0aWQsXG5cdFx0XHRcdGxhYmVsLFxuXHRcdFx0XHRyZXF1aXJlZCxcblx0XHRcdFx0dmFsdWUsXG5cdFx0XHRcdGhpZGRlbixcblx0XHRcdFx0ZGlzYWJsZWQsXG5cdFx0XHRcdHZhbGlkYXRpb246IHtcblx0XHRcdFx0XHR2YWxpZDogZmllbGQudmFsaWRpdHkgPyBmaWVsZC52YWxpZGl0eS52YWxpZCA6IHRydWUsXG5cdFx0XHRcdFx0bWVzc2FnZTogZmllbGQudmFsaWRhdGlvbk1lc3NhZ2UgfHwgJycsXG5cdFx0XHRcdH0sXG5cdFx0XHR9O1xuXG5cdFx0XHQvLyBDaGVja2VkIHN0YXRlIGZvciBjaGVja2JveGVzL3JhZGlvc1xuXHRcdFx0aWYgKHR5cGUgPT09ICdjaGVja2JveCcgfHwgdHlwZSA9PT0gJ3JhZGlvJykge1xuXHRcdFx0XHRpbmZvLmNoZWNrZWQgPSBmaWVsZC5jaGVja2VkO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBPcHRpb25zIGZvciBzZWxlY3QgZWxlbWVudHNcblx0XHRcdGlmICh0YWcgPT09ICdzZWxlY3QnKSB7XG5cdFx0XHRcdGluZm8ub3B0aW9ucyA9IEFycmF5LmZyb20oZmllbGQucXVlcnlTZWxlY3RvckFsbCgnb3B0aW9uJykpLm1hcChvcHQgPT4gKHtcblx0XHRcdFx0XHR2YWx1ZTogb3B0LnZhbHVlLFxuXHRcdFx0XHRcdGxhYmVsOiBvcHQudGV4dENvbnRlbnQudHJpbSgpLFxuXHRcdFx0XHRcdHNlbGVjdGVkOiBvcHQuc2VsZWN0ZWQsXG5cdFx0XHRcdH0pKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gRmllbGRzZXQvbGVnZW5kIGdyb3VwXG5cdFx0XHRjb25zdCBmaWVsZHNldCA9IGZpZWxkLmNsb3Nlc3QoJ2ZpZWxkc2V0Jyk7XG5cdFx0XHRpZiAoZmllbGRzZXQpIHtcblx0XHRcdFx0Y29uc3QgbGVnZW5kID0gZmllbGRzZXQucXVlcnlTZWxlY3RvcignbGVnZW5kJyk7XG5cdFx0XHRcdGlmIChsZWdlbmQpIHtcblx0XHRcdFx0XHRpbmZvLmdyb3VwID0gZ2V0VGV4dENvbnRlbnQobGVnZW5kKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRmaWVsZHMucHVzaChpbmZvKTtcblx0XHR9KTtcblxuXHRcdC8vIC0tLSBzdWJtaXQgYnV0dG9ucyAtLS1cblx0XHRjb25zdCBzdWJtaXRCdXR0b25zID0gW107XG5cdFx0Y29uc3QgYnV0dG9uQ2FuZGlkYXRlcyA9IGZvcm0ucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uLCBpbnB1dFt0eXBlPVwic3VibWl0XCJdJyk7XG5cdFx0YnV0dG9uQ2FuZGlkYXRlcy5mb3JFYWNoKGJ0biA9PiB7XG5cdFx0XHRjb25zdCB0YWcgPSBidG4udGFnTmFtZS50b0xvd2VyQ2FzZSgpO1xuXHRcdFx0Y29uc3QgdHlwZSA9IChidG4uZ2V0QXR0cmlidXRlKCd0eXBlJykgfHwgKHRhZyA9PT0gJ2J1dHRvbicgPyAnc3VibWl0JyA6ICcnKSkudG9Mb3dlckNhc2UoKTtcblx0XHRcdC8vIEluY2x1ZGU6IGV4cGxpY2l0IHN1Ym1pdCwgb3IgYnV0dG9uIHdpdGhvdXQgZXhwbGljaXQgdHlwZSAoZGVmYXVsdHMgdG8gc3VibWl0KVxuXHRcdFx0aWYgKHR5cGUgPT09ICdzdWJtaXQnIHx8ICh0YWcgPT09ICdidXR0b24nICYmICFidG4uZ2V0QXR0cmlidXRlKCd0eXBlJykpKSB7XG5cdFx0XHRcdHN1Ym1pdEJ1dHRvbnMucHVzaCh7XG5cdFx0XHRcdFx0dGFnLFxuXHRcdFx0XHRcdHR5cGU6IHR5cGUgfHwgJ3N1Ym1pdCcsXG5cdFx0XHRcdFx0dGV4dDogdGFnID09PSAnaW5wdXQnID8gKGJ0bi52YWx1ZSB8fCAnJykgOiBnZXRUZXh0Q29udGVudChidG4pLFxuXHRcdFx0XHRcdG5hbWU6IGJ0bi5nZXRBdHRyaWJ1dGUoJ25hbWUnKSB8fCAnJyxcblx0XHRcdFx0XHRkaXNhYmxlZDogYnRuLmRpc2FibGVkLFxuXHRcdFx0XHR9KTtcblx0XHRcdH1cblx0XHR9KTtcblxuXHRcdGNvbnN0IHZpc2libGVGaWVsZENvdW50ID0gZmllbGRzLmZpbHRlcihmID0+ICFmLmhpZGRlbikubGVuZ3RoO1xuXG5cdFx0cmV0dXJuIHtcblx0XHRcdGZvcm1TZWxlY3Rvcixcblx0XHRcdGZpZWxkcyxcblx0XHRcdHN1Ym1pdEJ1dHRvbnMsXG5cdFx0XHRmaWVsZENvdW50OiBmaWVsZHMubGVuZ3RoLFxuXHRcdFx0dmlzaWJsZUZpZWxkQ291bnQsXG5cdFx0fTtcblx0fSkoKWA7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUG9zdC1maWxsIHZhbGlkYXRpb24gY29sbGVjdGlvbiBcdTIwMTQgcnVucyBpbiBicm93c2VyIGNvbnRleHQuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gYnVpbGRQb3N0RmlsbFZhbGlkYXRpb25TY3JpcHQoZm9ybVNlbGVjdG9yOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gYCgoKSA9PiB7XG5cdFx0Y29uc3QgZm9ybSA9ICR7SlNPTi5zdHJpbmdpZnkoZm9ybVNlbGVjdG9yKX0gPT09ICdib2R5J1xuXHRcdFx0PyBkb2N1bWVudC5ib2R5XG5cdFx0XHQ6IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJHtKU09OLnN0cmluZ2lmeShmb3JtU2VsZWN0b3IpfSk7XG5cdFx0aWYgKCFmb3JtKSByZXR1cm4geyB2YWxpZDogZmFsc2UsIGludmFsaWRDb3VudDogMCwgZmllbGRzOiBbXSB9O1xuXG5cdFx0Y29uc3QgZmllbGRFbHMgPSBmb3JtLnF1ZXJ5U2VsZWN0b3JBbGwoJ2lucHV0LCBzZWxlY3QsIHRleHRhcmVhJyk7XG5cdFx0bGV0IHZhbGlkQ291bnQgPSAwO1xuXHRcdGxldCBpbnZhbGlkQ291bnQgPSAwO1xuXHRcdGNvbnN0IGludmFsaWRGaWVsZHMgPSBbXTtcblxuXHRcdGZpZWxkRWxzLmZvckVhY2goZiA9PiB7XG5cdFx0XHRjb25zdCB0YWcgPSBmLnRhZ05hbWUudG9Mb3dlckNhc2UoKTtcblx0XHRcdGNvbnN0IHR5cGUgPSB0YWcgPT09ICdzZWxlY3QnID8gJ3NlbGVjdCdcblx0XHRcdFx0OiB0YWcgPT09ICd0ZXh0YXJlYScgPyAndGV4dGFyZWEnXG5cdFx0XHRcdDogKGYuZ2V0QXR0cmlidXRlKCd0eXBlJykgfHwgJ3RleHQnKS50b0xvd2VyQ2FzZSgpO1xuXHRcdFx0aWYgKFsnc3VibWl0JywgJ2J1dHRvbicsICdyZXNldCcsICdpbWFnZScsICdoaWRkZW4nXS5pbmNsdWRlcyh0eXBlKSkgcmV0dXJuO1xuXG5cdFx0XHRpZiAoZi52YWxpZGl0eSAmJiAhZi52YWxpZGl0eS52YWxpZCkge1xuXHRcdFx0XHRpbnZhbGlkQ291bnQrKztcblx0XHRcdFx0aW52YWxpZEZpZWxkcy5wdXNoKHtcblx0XHRcdFx0XHRuYW1lOiBmLmdldEF0dHJpYnV0ZSgnbmFtZScpIHx8IGYuaWQgfHwgdHlwZSxcblx0XHRcdFx0XHRtZXNzYWdlOiBmLnZhbGlkYXRpb25NZXNzYWdlIHx8ICdJbnZhbGlkJyxcblx0XHRcdFx0fSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHR2YWxpZENvdW50Kys7XG5cdFx0XHR9XG5cdFx0fSk7XG5cblx0XHRyZXR1cm4ge1xuXHRcdFx0dmFsaWQ6IGludmFsaWRDb3VudCA9PT0gMCxcblx0XHRcdHZhbGlkQ291bnQsXG5cdFx0XHRpbnZhbGlkQ291bnQsXG5cdFx0XHRpbnZhbGlkRmllbGRzLFxuXHRcdH07XG5cdH0pKClgO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFJlZ2lzdHJhdGlvblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlckZvcm1Ub29scyhwaTogRXh0ZW5zaW9uQVBJLCBkZXBzOiBUb29sRGVwcyk6IHZvaWQge1xuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBicm93c2VyX2FuYWx5emVfZm9ybVxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9hbmFseXplX2Zvcm1cIixcblx0XHRsYWJlbDogXCJBbmFseXplIEZvcm1cIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiQW5hbHl6ZSBhIGZvcm0gb24gdGhlIGN1cnJlbnQgcGFnZSBhbmQgcmV0dXJuIGEgc3RydWN0dXJlZCBmaWVsZCBpbnZlbnRvcnkuIEF1dG8tZGV0ZWN0cyB0aGUgZm9ybSBpZiBubyBzZWxlY3RvciBpcyBwcm92aWRlZCAocGlja3MgdGhlIHNpbmdsZSA8Zm9ybT4sIG9yIHRoZSBmb3JtIHdpdGggbW9zdCB2aXNpYmxlIGlucHV0cywgb3IgZmFsbHMgYmFjayB0byBkb2N1bWVudC5ib2R5KS4gUmV0dXJucyBmaWVsZCB0eXBlcywgbGFiZWxzIChyZXNvbHZlZCB2aWEgYXJpYS1sYWJlbGxlZGJ5IFx1MjE5MiBhcmlhLWxhYmVsIFx1MjE5MiBsYWJlbFtmb3JdIFx1MjE5MiB3cmFwcGluZyBsYWJlbCBcdTIxOTIgcGxhY2Vob2xkZXIgXHUyMTkyIHRpdGxlIFx1MjE5MiBuYW1lKSwgdmFsdWVzLCB2YWxpZGF0aW9uIHN0YXRlLCBhbmQgc3VibWl0IGJ1dHRvbnMuXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0c2VsZWN0b3I6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFx0XHRcdFwiQ1NTIHNlbGVjdG9yIHRhcmdldGluZyB0aGUgZm9ybSBlbGVtZW50IHRvIGFuYWx5emUuIElmIG9taXR0ZWQsIGF1dG8tZGV0ZWN0cyB0aGUgcHJpbWFyeSBmb3JtIG9uIHRoZSBwYWdlLlwiLFxuXHRcdFx0XHR9KVxuXHRcdFx0KSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHRsZXQgYWN0aW9uSWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXHRcdFx0bGV0IGJlZm9yZVN0YXRlOiBDb21wYWN0UGFnZVN0YXRlIHwgbnVsbCA9IG51bGw7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCB7IHBhZ2U6IHAgfSA9IGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCB0YXJnZXQgPSBkZXBzLmdldEFjdGl2ZVRhcmdldCgpO1xuXHRcdFx0XHRiZWZvcmVTdGF0ZSA9IGF3YWl0IGRlcHMuY2FwdHVyZUNvbXBhY3RQYWdlU3RhdGUocCwge1xuXHRcdFx0XHRcdHNlbGVjdG9yczogcGFyYW1zLnNlbGVjdG9yID8gW3BhcmFtcy5zZWxlY3Rvcl0gOiBbXSxcblx0XHRcdFx0XHRpbmNsdWRlQm9keVRleHQ6IGZhbHNlLFxuXHRcdFx0XHRcdHRhcmdldCxcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGFjdGlvbklkID0gZGVwcy5iZWdpblRyYWNrZWRBY3Rpb24oXCJicm93c2VyX2FuYWx5emVfZm9ybVwiLCBwYXJhbXMsIGJlZm9yZVN0YXRlLnVybCkuaWQ7XG5cblx0XHRcdFx0Y29uc3Qgc2NyaXB0ID0gYnVpbGRGb3JtQW5hbHlzaXNTY3JpcHQocGFyYW1zLnNlbGVjdG9yKTtcblx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgdGFyZ2V0LmV2YWx1YXRlKHNjcmlwdCkgYXMgRm9ybUFuYWx5c2lzUmVzdWx0ICYgeyBlcnJvcj86IHN0cmluZyB9O1xuXG5cdFx0XHRcdGlmIChyZXN1bHQuZXJyb3IpIHtcblx0XHRcdFx0XHRkZXBzLmZpbmlzaFRyYWNrZWRBY3Rpb24oYWN0aW9uSWQhLCB7XG5cdFx0XHRcdFx0XHRzdGF0dXM6IFwiZXJyb3JcIixcblx0XHRcdFx0XHRcdGVycm9yOiByZXN1bHQuZXJyb3IsXG5cdFx0XHRcdFx0XHRiZWZvcmVTdGF0ZSxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IHJlc3VsdC5lcnJvciB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHt9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgYWZ0ZXJTdGF0ZSA9IGF3YWl0IGRlcHMuY2FwdHVyZUNvbXBhY3RQYWdlU3RhdGUocCwge1xuXHRcdFx0XHRcdHNlbGVjdG9yczogcGFyYW1zLnNlbGVjdG9yID8gW3BhcmFtcy5zZWxlY3Rvcl0gOiBbXSxcblx0XHRcdFx0XHRpbmNsdWRlQm9keVRleHQ6IGZhbHNlLFxuXHRcdFx0XHRcdHRhcmdldCxcblx0XHRcdFx0fSk7XG5cdFx0XHRcdHNldExhc3RBY3Rpb25CZWZvcmVTdGF0ZShiZWZvcmVTdGF0ZSk7XG5cdFx0XHRcdHNldExhc3RBY3Rpb25BZnRlclN0YXRlKGFmdGVyU3RhdGUpO1xuXG5cdFx0XHRcdGRlcHMuZmluaXNoVHJhY2tlZEFjdGlvbihhY3Rpb25JZCEsIHtcblx0XHRcdFx0XHRzdGF0dXM6IFwic3VjY2Vzc1wiLFxuXHRcdFx0XHRcdGFmdGVyVXJsOiBhZnRlclN0YXRlLnVybCxcblx0XHRcdFx0XHRiZWZvcmVTdGF0ZSxcblx0XHRcdFx0XHRhZnRlclN0YXRlLFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHQvLyBGb3JtYXQgb3V0cHV0XG5cdFx0XHRcdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdFx0XHRsaW5lcy5wdXNoKGBGb3JtOiAke3Jlc3VsdC5mb3JtU2VsZWN0b3J9YCk7XG5cdFx0XHRcdGxpbmVzLnB1c2goYEZpZWxkczogJHtyZXN1bHQuZmllbGRDb3VudH0gdG90YWwsICR7cmVzdWx0LnZpc2libGVGaWVsZENvdW50fSB2aXNpYmxlYCk7XG5cdFx0XHRcdGxpbmVzLnB1c2goYFN1Ym1pdCBidXR0b25zOiAke3Jlc3VsdC5zdWJtaXRCdXR0b25zLmxlbmd0aH1gKTtcblx0XHRcdFx0bGluZXMucHVzaChcIlwiKTtcblxuXHRcdFx0XHRpZiAocmVzdWx0LmZpZWxkcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0bGluZXMucHVzaChcIiMjIEZpZWxkc1wiKTtcblx0XHRcdFx0XHRmb3IgKGNvbnN0IGYgb2YgcmVzdWx0LmZpZWxkcykge1xuXHRcdFx0XHRcdFx0Y29uc3QgZmxhZ3M6IHN0cmluZ1tdID0gW107XG5cdFx0XHRcdFx0XHRpZiAoZi5yZXF1aXJlZCkgZmxhZ3MucHVzaChcInJlcXVpcmVkXCIpO1xuXHRcdFx0XHRcdFx0aWYgKGYuaGlkZGVuKSBmbGFncy5wdXNoKFwiaGlkZGVuXCIpO1xuXHRcdFx0XHRcdFx0aWYgKGYuZGlzYWJsZWQpIGZsYWdzLnB1c2goXCJkaXNhYmxlZFwiKTtcblx0XHRcdFx0XHRcdGlmIChmLmNoZWNrZWQgIT09IHVuZGVmaW5lZCkgZmxhZ3MucHVzaChmLmNoZWNrZWQgPyBcImNoZWNrZWRcIiA6IFwidW5jaGVja2VkXCIpO1xuXHRcdFx0XHRcdFx0aWYgKCFmLnZhbGlkYXRpb24udmFsaWQpIGZsYWdzLnB1c2goYGludmFsaWQ6ICR7Zi52YWxpZGF0aW9uLm1lc3NhZ2V9YCk7XG5cblx0XHRcdFx0XHRcdGNvbnN0IGZsYWdTdHIgPSBmbGFncy5sZW5ndGggPyBgIFske2ZsYWdzLmpvaW4oXCIsIFwiKX1dYCA6IFwiXCI7XG5cdFx0XHRcdFx0XHRjb25zdCB2YWx1ZVN0ciA9IGYudmFsdWUgPyBgID0gXCIke2YudmFsdWV9XCJgIDogXCJcIjtcblx0XHRcdFx0XHRcdGNvbnN0IGxhYmVsU3RyID0gZi5sYWJlbCB8fCBcIihubyBsYWJlbClcIjtcblx0XHRcdFx0XHRcdGNvbnN0IHNlbGVjdG9ySGludCA9IGYuaWQgPyBgIyR7Zi5pZH1gIDogZi5uYW1lID8gYFtuYW1lPVwiJHtmLm5hbWV9XCJdYCA6IGYudHlwZTtcblx0XHRcdFx0XHRcdGNvbnN0IGdyb3VwU3RyID0gZi5ncm91cCA/IGAgKGdyb3VwOiAke2YuZ3JvdXB9KWAgOiBcIlwiO1xuXG5cdFx0XHRcdFx0XHRsaW5lcy5wdXNoKGAtICoqJHtsYWJlbFN0cn0qKiBcXGAke2YudHlwZX1cXGAgXFxgJHtzZWxlY3RvckhpbnR9XFxgJHt2YWx1ZVN0cn0ke2ZsYWdTdHJ9JHtncm91cFN0cn1gKTtcblxuXHRcdFx0XHRcdFx0aWYgKGYub3B0aW9ucyAmJiBmLm9wdGlvbnMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRcdFx0XHRmb3IgKGNvbnN0IG9wdCBvZiBmLm9wdGlvbnMpIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBzZWwgPSBvcHQuc2VsZWN0ZWQgPyBcIiBcdTI3MTNcIiA6IFwiXCI7XG5cdFx0XHRcdFx0XHRcdFx0bGluZXMucHVzaChgICAtICR7b3B0LmxhYmVsfSAoJHtvcHQudmFsdWV9KSR7c2VsfWApO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGxpbmVzLnB1c2goXCJcIik7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAocmVzdWx0LnN1Ym1pdEJ1dHRvbnMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRcdGxpbmVzLnB1c2goXCIjIyBTdWJtaXQgQnV0dG9uc1wiKTtcblx0XHRcdFx0XHRmb3IgKGNvbnN0IGJ0biBvZiByZXN1bHQuc3VibWl0QnV0dG9ucykge1xuXHRcdFx0XHRcdFx0Y29uc3QgZGlzU3RyID0gYnRuLmRpc2FibGVkID8gXCIgW2Rpc2FibGVkXVwiIDogXCJcIjtcblx0XHRcdFx0XHRcdGxpbmVzLnB1c2goYC0gXCIke2J0bi50ZXh0fVwiIFxcYDwke2J0bi50YWd9IHR5cGU9XCIke2J0bi50eXBlfVwiPlxcYCR7YnRuLm5hbWUgPyBgIG5hbWU9XCIke2J0bi5uYW1lfVwiYCA6IFwiXCJ9JHtkaXNTdHJ9YCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogbGluZXMuam9pbihcIlxcblwiKSB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGZvcm1BbmFseXNpczogcmVzdWx0IH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IHVua25vd24pIHtcblx0XHRcdFx0Y29uc3Qgc2NyZWVuc2hvdCA9IGF3YWl0IGRlcHMuY2FwdHVyZUVycm9yU2NyZWVuc2hvdChcblx0XHRcdFx0XHQoKCkgPT4geyB0cnkgeyByZXR1cm4gZGVwcy5nZXRBY3RpdmVQYWdlKCk7IH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfSB9KSgpXG5cdFx0XHRcdCk7XG5cdFx0XHRcdGNvbnN0IGVyck1zZyA9IGRlcHMuZmlyc3RFcnJvckxpbmUoZXJyKTtcblxuXHRcdFx0XHRpZiAoYWN0aW9uSWQgIT09IG51bGwpIHtcblx0XHRcdFx0XHRkZXBzLmZpbmlzaFRyYWNrZWRBY3Rpb24oYWN0aW9uSWQsIHtcblx0XHRcdFx0XHRcdHN0YXR1czogXCJlcnJvclwiLFxuXHRcdFx0XHRcdFx0ZXJyb3I6IGVyck1zZyxcblx0XHRcdFx0XHRcdGJlZm9yZVN0YXRlOiBiZWZvcmVTdGF0ZSA/PyB1bmRlZmluZWQsXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCBjb250ZW50OiBBcnJheTx7IHR5cGU6IFwidGV4dFwiOyB0ZXh0OiBzdHJpbmcgfSB8IHsgdHlwZTogXCJpbWFnZVwiOyBkYXRhOiBzdHJpbmc7IG1pbWVUeXBlOiBzdHJpbmcgfT4gPSBbXG5cdFx0XHRcdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogYGJyb3dzZXJfYW5hbHl6ZV9mb3JtIGZhaWxlZDogJHtlcnJNc2d9YCB9LFxuXHRcdFx0XHRdO1xuXHRcdFx0XHRpZiAoc2NyZWVuc2hvdCkge1xuXHRcdFx0XHRcdGNvbnRlbnQucHVzaCh7IHR5cGU6IFwiaW1hZ2VcIiwgZGF0YTogc2NyZWVuc2hvdC5kYXRhLCBtaW1lVHlwZTogc2NyZWVuc2hvdC5taW1lVHlwZSB9KTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdHJldHVybiB7IGNvbnRlbnQsIGRldGFpbHM6IHt9LCBpc0Vycm9yOiB0cnVlIH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG5cblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gYnJvd3Nlcl9maWxsX2Zvcm1cblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfZmlsbF9mb3JtXCIsXG5cdFx0bGFiZWw6IFwiRmlsbCBGb3JtXCIsXG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcIkZpbGwgYSBmb3JtIG9uIHRoZSBjdXJyZW50IHBhZ2UgdXNpbmcgYSB2YWx1ZXMgbWFwcGluZy4gS2V5cyBhcmUgZmllbGQgaWRlbnRpZmllcnMgKGxhYmVsIHRleHQsIG5hbWUgYXR0cmlidXRlLCBwbGFjZWhvbGRlciwgb3IgYXJpYS1sYWJlbCkuIFJlc29sdmVzIGZpZWxkcyBieSBsYWJlbCBcdTIxOTIgbmFtZSBcdTIxOTIgcGxhY2Vob2xkZXIgXHUyMTkyIGFyaWEtbGFiZWwgKGV4YWN0IGZpcnN0LCB0aGVuIGNhc2UtaW5zZW5zaXRpdmUpLiBVc2VzIGZpbGwoKSBmb3IgdGV4dCBpbnB1dHMsIHNlbGVjdE9wdGlvbigpIGZvciBzZWxlY3RzLCBzZXRDaGVja2VkKCkgZm9yIGNoZWNrYm94ZXMvcmFkaW9zLiBTa2lwcyBmaWxlIGFuZCBoaWRkZW4gaW5wdXRzLiBPcHRpb25hbGx5IHN1Ym1pdHMgdGhlIGZvcm0uXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0c2VsZWN0b3I6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFx0XHRcdFwiQ1NTIHNlbGVjdG9yIHRhcmdldGluZyB0aGUgZm9ybSBlbGVtZW50LiBJZiBvbWl0dGVkLCBhdXRvLWRldGVjdHMgdGhlIHByaW1hcnkgZm9ybS5cIixcblx0XHRcdFx0fSlcblx0XHRcdCksXG5cdFx0XHR2YWx1ZXM6IFR5cGUuUmVjb3JkKFR5cGUuU3RyaW5nKCksIFR5cGUuU3RyaW5nKCksIHtcblx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XCJNYXBwaW5nIG9mIGZpZWxkIGlkZW50aWZpZXJzIHRvIHZhbHVlcy4gS2V5cyBjYW4gYmUgbGFiZWwgdGV4dCwgbmFtZSwgcGxhY2Vob2xkZXIsIG9yIGFyaWEtbGFiZWwuIFZhbHVlcyBhcmUgc3RyaW5ncyBcdTIwMTQgZm9yIGNoZWNrYm94ZXMgdXNlICd0cnVlJy8nZmFsc2UnIG9yICdvbicvJ29mZicsIGZvciBzZWxlY3RzIHVzZSB0aGUgb3B0aW9uIGxhYmVsIG9yIHZhbHVlLlwiLFxuXHRcdFx0fSksXG5cdFx0XHRzdWJtaXQ6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuQm9vbGVhbih7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiSWYgdHJ1ZSwgY2xpY2tzIHRoZSBmb3JtJ3Mgc3VibWl0IGJ1dHRvbiBhZnRlciBmaWxsaW5nIGFsbCBmaWVsZHMuXCIsXG5cdFx0XHRcdH0pXG5cdFx0XHQpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdGxldCBhY3Rpb25JZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cdFx0XHRsZXQgYmVmb3JlU3RhdGU6IENvbXBhY3RQYWdlU3RhdGUgfCBudWxsID0gbnVsbDtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHsgcGFnZTogcCB9ID0gYXdhaXQgZGVwcy5lbnN1cmVCcm93c2VyKCk7XG5cdFx0XHRcdGNvbnN0IHRhcmdldCA9IGRlcHMuZ2V0QWN0aXZlVGFyZ2V0KCk7XG5cdFx0XHRcdGJlZm9yZVN0YXRlID0gYXdhaXQgZGVwcy5jYXB0dXJlQ29tcGFjdFBhZ2VTdGF0ZShwLCB7XG5cdFx0XHRcdFx0c2VsZWN0b3JzOiBwYXJhbXMuc2VsZWN0b3IgPyBbcGFyYW1zLnNlbGVjdG9yXSA6IFtdLFxuXHRcdFx0XHRcdGluY2x1ZGVCb2R5VGV4dDogZmFsc2UsXG5cdFx0XHRcdFx0dGFyZ2V0LFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0YWN0aW9uSWQgPSBkZXBzLmJlZ2luVHJhY2tlZEFjdGlvbihcImJyb3dzZXJfZmlsbF9mb3JtXCIsIHBhcmFtcywgYmVmb3JlU3RhdGUudXJsKS5pZDtcblxuXHRcdFx0XHQvLyAtLS0gRGV0ZWN0IGZvcm0gc2VsZWN0b3IgLS0tXG5cdFx0XHRcdC8vIFJldXNlIHRoZSBzYW1lIGRldGVjdGlvbiBsb2dpYyBhcyBhbmFseXplX2Zvcm0gdmlhIGEgbGlnaHR3ZWlnaHQgZXZhbHVhdGVcblx0XHRcdFx0Y29uc3QgZm9ybVNlbGVjdG9yOiBzdHJpbmcgPSBwYXJhbXMuc2VsZWN0b3IgPz8gYXdhaXQgdGFyZ2V0LmV2YWx1YXRlKGAoKCkgPT4ge1xuXHRcdFx0XHRcdGNvbnN0IGZvcm1zID0gQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdmb3JtJykpO1xuXHRcdFx0XHRcdGlmIChmb3Jtcy5sZW5ndGggPT09IDEpIHtcblx0XHRcdFx0XHRcdGNvbnN0IGYgPSBmb3Jtc1swXTtcblx0XHRcdFx0XHRcdGlmIChmLmlkKSByZXR1cm4gJyMnICsgQ1NTLmVzY2FwZShmLmlkKTtcblx0XHRcdFx0XHRcdGlmIChmLmdldEF0dHJpYnV0ZSgnbmFtZScpKSByZXR1cm4gJ2Zvcm1bbmFtZT1cIicgKyBmLmdldEF0dHJpYnV0ZSgnbmFtZScpICsgJ1wiXSc7XG5cdFx0XHRcdFx0XHRyZXR1cm4gJ2Zvcm0nO1xuXHRcdFx0XHRcdH0gZWxzZSBpZiAoZm9ybXMubGVuZ3RoID4gMSkge1xuXHRcdFx0XHRcdFx0bGV0IGJlc3QgPSBudWxsO1xuXHRcdFx0XHRcdFx0bGV0IGJlc3RDb3VudCA9IC0xO1xuXHRcdFx0XHRcdFx0bGV0IGJlc3RJZHggPSAwO1xuXHRcdFx0XHRcdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBmb3Jtcy5sZW5ndGg7IGkrKykge1xuXHRcdFx0XHRcdFx0XHRjb25zdCBpbnB1dHMgPSBmb3Jtc1tpXS5xdWVyeVNlbGVjdG9yQWxsKCdpbnB1dCwgc2VsZWN0LCB0ZXh0YXJlYScpO1xuXHRcdFx0XHRcdFx0XHRsZXQgdmlzID0gMDtcblx0XHRcdFx0XHRcdFx0aW5wdXRzLmZvckVhY2goaW5wID0+IHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBzID0gd2luZG93LmdldENvbXB1dGVkU3R5bGUoaW5wKTtcblx0XHRcdFx0XHRcdFx0XHRpZiAocy5kaXNwbGF5ICE9PSAnbm9uZScgJiYgcy52aXNpYmlsaXR5ICE9PSAnaGlkZGVuJykgdmlzKys7XG5cdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRpZiAodmlzID4gYmVzdENvdW50KSB7IGJlc3RDb3VudCA9IHZpczsgYmVzdCA9IGZvcm1zW2ldOyBiZXN0SWR4ID0gaTsgfVxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0aWYgKGJlc3QuaWQpIHJldHVybiAnIycgKyBDU1MuZXNjYXBlKGJlc3QuaWQpO1xuXHRcdFx0XHRcdFx0aWYgKGJlc3QuZ2V0QXR0cmlidXRlKCduYW1lJykpIHJldHVybiAnZm9ybVtuYW1lPVwiJyArIGJlc3QuZ2V0QXR0cmlidXRlKCduYW1lJykgKyAnXCJdJztcblx0XHRcdFx0XHRcdHJldHVybiAnZm9ybTpudGgtb2YtdHlwZSgnICsgKGJlc3RJZHggKyAxKSArICcpJztcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuICdib2R5Jztcblx0XHRcdFx0fSkoKWApIGFzIHN0cmluZztcblxuXHRcdFx0XHRjb25zdCBmb3JtTG9jYXRvciA9IGZvcm1TZWxlY3RvciA9PT0gXCJib2R5XCJcblx0XHRcdFx0XHQ/IHRhcmdldC5sb2NhdG9yKFwiYm9keVwiKVxuXHRcdFx0XHRcdDogdGFyZ2V0LmxvY2F0b3IoZm9ybVNlbGVjdG9yKTtcblxuXHRcdFx0XHQvLyAtLS0gUmVzb2x2ZSBhbmQgZmlsbCBlYWNoIGZpZWxkIC0tLVxuXHRcdFx0XHRpbnRlcmZhY2UgTWF0Y2hlZEZpZWxkIHtcblx0XHRcdFx0XHRrZXk6IHN0cmluZztcblx0XHRcdFx0XHRyZXNvbHZlZEJ5OiBzdHJpbmc7XG5cdFx0XHRcdFx0dmFsdWU6IHN0cmluZztcblx0XHRcdFx0XHRmaWVsZFR5cGU6IHN0cmluZztcblx0XHRcdFx0fVxuXHRcdFx0XHRpbnRlcmZhY2UgVW5tYXRjaGVkRmllbGQge1xuXHRcdFx0XHRcdGtleTogc3RyaW5nO1xuXHRcdFx0XHRcdHJlYXNvbjogc3RyaW5nO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGludGVyZmFjZSBTa2lwcGVkRmllbGQge1xuXHRcdFx0XHRcdGtleTogc3RyaW5nO1xuXHRcdFx0XHRcdHJlYXNvbjogc3RyaW5nO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgbWF0Y2hlZDogTWF0Y2hlZEZpZWxkW10gPSBbXTtcblx0XHRcdFx0Y29uc3QgdW5tYXRjaGVkOiBVbm1hdGNoZWRGaWVsZFtdID0gW107XG5cdFx0XHRcdGNvbnN0IHNraXBwZWQ6IFNraXBwZWRGaWVsZFtdID0gW107XG5cblx0XHRcdFx0Zm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocGFyYW1zLnZhbHVlcykpIHtcblx0XHRcdFx0XHQvLyBUcnkgdG8gcmVzb2x2ZSB0aGUgZmllbGQgaW4gcHJpb3JpdHkgb3JkZXJcblx0XHRcdFx0XHRsZXQgcmVzb2x2ZWRMb2NhdG9yOiBSZXR1cm5UeXBlPHR5cGVvZiBmb3JtTG9jYXRvci5sb2NhdG9yPiB8IG51bGwgPSBudWxsO1xuXHRcdFx0XHRcdGxldCByZXNvbHZlZEJ5ID0gXCJcIjtcblxuXHRcdFx0XHRcdC8vIDEuIEV4YWN0IGxhYmVsIG1hdGNoXG5cdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdGNvbnN0IGxvYyA9IGZvcm1Mb2NhdG9yLmdldEJ5TGFiZWwoa2V5LCB7IGV4YWN0OiB0cnVlIH0pO1xuXHRcdFx0XHRcdFx0Y29uc3QgY291bnQgPSBhd2FpdCBsb2MuY291bnQoKTtcblx0XHRcdFx0XHRcdGlmIChjb3VudCA9PT0gMSkge1xuXHRcdFx0XHRcdFx0XHRyZXNvbHZlZExvY2F0b3IgPSBsb2M7XG5cdFx0XHRcdFx0XHRcdHJlc29sdmVkQnkgPSBcImxhYmVsIChleGFjdClcIjtcblx0XHRcdFx0XHRcdH0gZWxzZSBpZiAoY291bnQgPiAxKSB7XG5cdFx0XHRcdFx0XHRcdHNraXBwZWQucHVzaCh7IGtleSwgcmVhc29uOiBgQW1iaWd1b3VzOiAke2NvdW50fSBmaWVsZHMgbWF0Y2ggbGFiZWwgXCIke2tleX1cImAgfSk7XG5cdFx0XHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH0gY2F0Y2ggeyAvKiBub3QgZm91bmQsIHRyeSBuZXh0ICovIH1cblxuXHRcdFx0XHRcdC8vIDIuIENhc2UtaW5zZW5zaXRpdmUgbGFiZWwgbWF0Y2hcblx0XHRcdFx0XHRpZiAoIXJlc29sdmVkTG9jYXRvcikge1xuXHRcdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgbG9jID0gZm9ybUxvY2F0b3IuZ2V0QnlMYWJlbChrZXkpO1xuXHRcdFx0XHRcdFx0XHRjb25zdCBjb3VudCA9IGF3YWl0IGxvYy5jb3VudCgpO1xuXHRcdFx0XHRcdFx0XHRpZiAoY291bnQgPT09IDEpIHtcblx0XHRcdFx0XHRcdFx0XHRyZXNvbHZlZExvY2F0b3IgPSBsb2M7XG5cdFx0XHRcdFx0XHRcdFx0cmVzb2x2ZWRCeSA9IFwibGFiZWxcIjtcblx0XHRcdFx0XHRcdFx0fSBlbHNlIGlmIChjb3VudCA+IDEpIHtcblx0XHRcdFx0XHRcdFx0XHRza2lwcGVkLnB1c2goeyBrZXksIHJlYXNvbjogYEFtYmlndW91czogJHtjb3VudH0gZmllbGRzIG1hdGNoIGxhYmVsIFwiJHtrZXl9XCIgKGNhc2UtaW5zZW5zaXRpdmUpYCB9KTtcblx0XHRcdFx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fSBjYXRjaCB7IC8qIG5vdCBmb3VuZCwgdHJ5IG5leHQgKi8gfVxuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdC8vIDMuIG5hbWUgYXR0cmlidXRlXG5cdFx0XHRcdFx0aWYgKCFyZXNvbHZlZExvY2F0b3IpIHtcblx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGxvYyA9IGZvcm1Mb2NhdG9yLmxvY2F0b3IoYFtuYW1lPVwiJHtDU1MuZXNjYXBlKGtleSl9XCJdYCk7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGNvdW50ID0gYXdhaXQgbG9jLmNvdW50KCk7XG5cdFx0XHRcdFx0XHRcdGlmIChjb3VudCA9PT0gMSkge1xuXHRcdFx0XHRcdFx0XHRcdHJlc29sdmVkTG9jYXRvciA9IGxvYztcblx0XHRcdFx0XHRcdFx0XHRyZXNvbHZlZEJ5ID0gXCJuYW1lXCI7XG5cdFx0XHRcdFx0XHRcdH0gZWxzZSBpZiAoY291bnQgPiAxKSB7XG5cdFx0XHRcdFx0XHRcdFx0c2tpcHBlZC5wdXNoKHsga2V5LCByZWFzb246IGBBbWJpZ3VvdXM6ICR7Y291bnR9IGZpZWxkcyBtYXRjaCBuYW1lPVwiJHtrZXl9XCJgIH0pO1xuXHRcdFx0XHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9IGNhdGNoIHsgLyogbm90IGZvdW5kLCB0cnkgbmV4dCAqLyB9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gNC4gcGxhY2Vob2xkZXIgYXR0cmlidXRlIChjYXNlLWluc2Vuc2l0aXZlKVxuXHRcdFx0XHRcdGlmICghcmVzb2x2ZWRMb2NhdG9yKSB7XG5cdFx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0XHRjb25zdCBsb2MgPSBmb3JtTG9jYXRvci5sb2NhdG9yKGBbcGxhY2Vob2xkZXI9XCIke2tleX1cIiBpXWApO1xuXHRcdFx0XHRcdFx0XHRjb25zdCBjb3VudCA9IGF3YWl0IGxvYy5jb3VudCgpO1xuXHRcdFx0XHRcdFx0XHRpZiAoY291bnQgPT09IDEpIHtcblx0XHRcdFx0XHRcdFx0XHRyZXNvbHZlZExvY2F0b3IgPSBsb2M7XG5cdFx0XHRcdFx0XHRcdFx0cmVzb2x2ZWRCeSA9IFwicGxhY2Vob2xkZXJcIjtcblx0XHRcdFx0XHRcdFx0fSBlbHNlIGlmIChjb3VudCA+IDEpIHtcblx0XHRcdFx0XHRcdFx0XHRza2lwcGVkLnB1c2goeyBrZXksIHJlYXNvbjogYEFtYmlndW91czogJHtjb3VudH0gZmllbGRzIG1hdGNoIHBsYWNlaG9sZGVyPVwiJHtrZXl9XCJgIH0pO1xuXHRcdFx0XHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9IGNhdGNoIHsgLyogbm90IGZvdW5kLCB0cnkgbmV4dCAqLyB9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gNS4gYXJpYS1sYWJlbCBhdHRyaWJ1dGUgKGNhc2UtaW5zZW5zaXRpdmUpXG5cdFx0XHRcdFx0aWYgKCFyZXNvbHZlZExvY2F0b3IpIHtcblx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGxvYyA9IGZvcm1Mb2NhdG9yLmxvY2F0b3IoYFthcmlhLWxhYmVsPVwiJHtrZXl9XCIgaV1gKTtcblx0XHRcdFx0XHRcdFx0Y29uc3QgY291bnQgPSBhd2FpdCBsb2MuY291bnQoKTtcblx0XHRcdFx0XHRcdFx0aWYgKGNvdW50ID09PSAxKSB7XG5cdFx0XHRcdFx0XHRcdFx0cmVzb2x2ZWRMb2NhdG9yID0gbG9jO1xuXHRcdFx0XHRcdFx0XHRcdHJlc29sdmVkQnkgPSBcImFyaWEtbGFiZWxcIjtcblx0XHRcdFx0XHRcdFx0fSBlbHNlIGlmIChjb3VudCA+IDEpIHtcblx0XHRcdFx0XHRcdFx0XHRza2lwcGVkLnB1c2goeyBrZXksIHJlYXNvbjogYEFtYmlndW91czogJHtjb3VudH0gZmllbGRzIG1hdGNoIGFyaWEtbGFiZWw9XCIke2tleX1cImAgfSk7XG5cdFx0XHRcdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH0gY2F0Y2ggeyAvKiBub3QgZm91bmQsIHRyeSBuZXh0ICovIH1cblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRpZiAoIXJlc29sdmVkTG9jYXRvcikge1xuXHRcdFx0XHRcdFx0dW5tYXRjaGVkLnB1c2goeyBrZXksIHJlYXNvbjogXCJObyBtYXRjaGluZyBmaWVsZCBmb3VuZFwiIH0pO1xuXHRcdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gRGV0ZXJtaW5lIGZpZWxkIHR5cGVcblx0XHRcdFx0XHRjb25zdCBmaWVsZEluZm8gPSBhd2FpdCByZXNvbHZlZExvY2F0b3IuZmlyc3QoKS5ldmFsdWF0ZSgoZWw6IEVsZW1lbnQpID0+IHtcblx0XHRcdFx0XHRcdGNvbnN0IHRhZyA9IGVsLnRhZ05hbWUudG9Mb3dlckNhc2UoKTtcblx0XHRcdFx0XHRcdGNvbnN0IHR5cGUgPSB0YWcgPT09IFwic2VsZWN0XCIgPyBcInNlbGVjdFwiXG5cdFx0XHRcdFx0XHRcdDogdGFnID09PSBcInRleHRhcmVhXCIgPyBcInRleHRhcmVhXCJcblx0XHRcdFx0XHRcdFx0OiAoKGVsIGFzIEhUTUxJbnB1dEVsZW1lbnQpLnR5cGUgfHwgXCJ0ZXh0XCIpLnRvTG93ZXJDYXNlKCk7XG5cdFx0XHRcdFx0XHRjb25zdCBoaWRkZW4gPSB0eXBlID09PSBcImhpZGRlblwiIHx8XG5cdFx0XHRcdFx0XHRcdCh3aW5kb3cuZ2V0Q29tcHV0ZWRTdHlsZShlbCkuZGlzcGxheSA9PT0gXCJub25lXCIpIHx8XG5cdFx0XHRcdFx0XHRcdCh3aW5kb3cuZ2V0Q29tcHV0ZWRTdHlsZShlbCkudmlzaWJpbGl0eSA9PT0gXCJoaWRkZW5cIik7XG5cdFx0XHRcdFx0XHRyZXR1cm4geyB0YWcsIHR5cGUsIGhpZGRlbiB9O1xuXHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0Ly8gU2tpcCBmaWxlIGlucHV0c1xuXHRcdFx0XHRcdGlmIChmaWVsZEluZm8udHlwZSA9PT0gXCJmaWxlXCIpIHtcblx0XHRcdFx0XHRcdHNraXBwZWQucHVzaCh7IGtleSwgcmVhc29uOiBcIkZpbGUgaW5wdXQgXHUyMDE0IHVzZSBicm93c2VyX3VwbG9hZF9maWxlIGluc3RlYWRcIiB9KTtcblx0XHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdC8vIFNraXAgaGlkZGVuIGlucHV0c1xuXHRcdFx0XHRcdGlmIChmaWVsZEluZm8uaGlkZGVuKSB7XG5cdFx0XHRcdFx0XHRza2lwcGVkLnB1c2goeyBrZXksIHJlYXNvbjogXCJIaWRkZW4gaW5wdXRcIiB9KTtcblx0XHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdC8vIEZpbGwgYmFzZWQgb24gdHlwZVxuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRpZiAoZmllbGRJbmZvLnR5cGUgPT09IFwiY2hlY2tib3hcIiB8fCBmaWVsZEluZm8udHlwZSA9PT0gXCJyYWRpb1wiKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGNoZWNrZWQgPSB2YWx1ZSA9PT0gXCJ0cnVlXCIgfHwgdmFsdWUgPT09IFwib25cIjtcblx0XHRcdFx0XHRcdFx0YXdhaXQgcmVzb2x2ZWRMb2NhdG9yLmZpcnN0KCkuc2V0Q2hlY2tlZChjaGVja2VkLCB7IHRpbWVvdXQ6IDUwMDAgfSk7XG5cdFx0XHRcdFx0XHRcdG1hdGNoZWQucHVzaCh7IGtleSwgcmVzb2x2ZWRCeSwgdmFsdWU6IGNoZWNrZWQgPyBcImNoZWNrZWRcIiA6IFwidW5jaGVja2VkXCIsIGZpZWxkVHlwZTogZmllbGRJbmZvLnR5cGUgfSk7XG5cdFx0XHRcdFx0XHR9IGVsc2UgaWYgKGZpZWxkSW5mby50YWcgPT09IFwic2VsZWN0XCIpIHtcblx0XHRcdFx0XHRcdFx0Ly8gVHJ5IGxhYmVsIGZpcnN0LCB0aGVuIHZhbHVlXG5cdFx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdFx0YXdhaXQgcmVzb2x2ZWRMb2NhdG9yLmZpcnN0KCkuc2VsZWN0T3B0aW9uKHsgbGFiZWw6IHZhbHVlIH0sIHsgdGltZW91dDogNTAwMCB9KTtcblx0XHRcdFx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0XHRcdFx0YXdhaXQgcmVzb2x2ZWRMb2NhdG9yLmZpcnN0KCkuc2VsZWN0T3B0aW9uKHsgdmFsdWUgfSwgeyB0aW1lb3V0OiA1MDAwIH0pO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdG1hdGNoZWQucHVzaCh7IGtleSwgcmVzb2x2ZWRCeSwgdmFsdWUsIGZpZWxkVHlwZTogXCJzZWxlY3RcIiB9KTtcblx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdC8vIFRleHQtbGlrZSBpbnB1dHMgYW5kIHRleHRhcmVhXG5cdFx0XHRcdFx0XHRcdGF3YWl0IHJlc29sdmVkTG9jYXRvci5maXJzdCgpLmZpbGwodmFsdWUsIHsgdGltZW91dDogNTAwMCB9KTtcblx0XHRcdFx0XHRcdFx0bWF0Y2hlZC5wdXNoKHsga2V5LCByZXNvbHZlZEJ5LCB2YWx1ZSwgZmllbGRUeXBlOiBmaWVsZEluZm8udHlwZSB9KTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9IGNhdGNoIChmaWxsRXJyOiB1bmtub3duKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBtc2cgPSBmaWxsRXJyIGluc3RhbmNlb2YgRXJyb3IgPyBmaWxsRXJyLm1lc3NhZ2UgOiBTdHJpbmcoZmlsbEVycik7XG5cdFx0XHRcdFx0XHRza2lwcGVkLnB1c2goeyBrZXksIHJlYXNvbjogYEZpbGwgZmFpbGVkOiAke21zZy5zcGxpdChcIlxcblwiKVswXX1gIH0pO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIC0tLSBTZXR0bGUgYWZ0ZXIgYWxsIGZpbGxzIC0tLVxuXHRcdFx0XHRhd2FpdCBkZXBzLnNldHRsZUFmdGVyQWN0aW9uQWRhcHRpdmUocCk7XG5cblx0XHRcdFx0Ly8gLS0tIFN1Ym1pdCBpZiByZXF1ZXN0ZWQgLS0tXG5cdFx0XHRcdGxldCBzdWJtaXR0ZWQgPSBmYWxzZTtcblx0XHRcdFx0aWYgKHBhcmFtcy5zdWJtaXQpIHtcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0Ly8gRmluZCBzdWJtaXQgYnV0dG9uIGluIGZvcm1cblx0XHRcdFx0XHRcdGNvbnN0IHN1Ym1pdExvYyA9IGZvcm1Mb2NhdG9yLmxvY2F0b3IoJ1t0eXBlPVwic3VibWl0XCJdLCBidXR0b246bm90KFt0eXBlXSknKS5maXJzdCgpO1xuXHRcdFx0XHRcdFx0Y29uc3Qgc3VibWl0RXhpc3RzID0gYXdhaXQgc3VibWl0TG9jLmNvdW50KCk7XG5cdFx0XHRcdFx0XHRpZiAoc3VibWl0RXhpc3RzID4gMCkge1xuXHRcdFx0XHRcdFx0XHRhd2FpdCBzdWJtaXRMb2MuY2xpY2soeyB0aW1lb3V0OiA1MDAwIH0pO1xuXHRcdFx0XHRcdFx0XHRhd2FpdCBkZXBzLnNldHRsZUFmdGVyQWN0aW9uQWRhcHRpdmUocCk7XG5cdFx0XHRcdFx0XHRcdHN1Ym1pdHRlZCA9IHRydWU7XG5cdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRza2lwcGVkLnB1c2goeyBrZXk6IFwiX3N1Ym1pdFwiLCByZWFzb246IFwiTm8gc3VibWl0IGJ1dHRvbiBmb3VuZCBpbiBmb3JtXCIgfSk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fSBjYXRjaCAoc3VibWl0RXJyOiB1bmtub3duKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBtc2cgPSBzdWJtaXRFcnIgaW5zdGFuY2VvZiBFcnJvciA/IHN1Ym1pdEVyci5tZXNzYWdlIDogU3RyaW5nKHN1Ym1pdEVycik7XG5cdFx0XHRcdFx0XHRza2lwcGVkLnB1c2goeyBrZXk6IFwiX3N1Ym1pdFwiLCByZWFzb246IGBTdWJtaXQgZmFpbGVkOiAke21zZy5zcGxpdChcIlxcblwiKVswXX1gIH0pO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIC0tLSBQb3N0LWZpbGwgdmFsaWRhdGlvbiBzdGF0ZSAtLS1cblx0XHRcdFx0Y29uc3QgdmFsaWRhdGlvblN1bW1hcnkgPSBhd2FpdCB0YXJnZXQuZXZhbHVhdGUoXG5cdFx0XHRcdFx0YnVpbGRQb3N0RmlsbFZhbGlkYXRpb25TY3JpcHQoZm9ybVNlbGVjdG9yKVxuXHRcdFx0XHQpIGFzIHsgdmFsaWQ6IGJvb2xlYW47IHZhbGlkQ291bnQ6IG51bWJlcjsgaW52YWxpZENvdW50OiBudW1iZXI7IGludmFsaWRGaWVsZHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBtZXNzYWdlOiBzdHJpbmcgfT4gfTtcblxuXHRcdFx0XHRjb25zdCBhZnRlclN0YXRlID0gYXdhaXQgZGVwcy5jYXB0dXJlQ29tcGFjdFBhZ2VTdGF0ZShwLCB7XG5cdFx0XHRcdFx0c2VsZWN0b3JzOiBwYXJhbXMuc2VsZWN0b3IgPyBbcGFyYW1zLnNlbGVjdG9yXSA6IFtdLFxuXHRcdFx0XHRcdGluY2x1ZGVCb2R5VGV4dDogZmFsc2UsXG5cdFx0XHRcdFx0dGFyZ2V0LFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0c2V0TGFzdEFjdGlvbkJlZm9yZVN0YXRlKGJlZm9yZVN0YXRlKTtcblx0XHRcdFx0c2V0TGFzdEFjdGlvbkFmdGVyU3RhdGUoYWZ0ZXJTdGF0ZSk7XG5cblx0XHRcdFx0ZGVwcy5maW5pc2hUcmFja2VkQWN0aW9uKGFjdGlvbklkISwge1xuXHRcdFx0XHRcdHN0YXR1czogXCJzdWNjZXNzXCIsXG5cdFx0XHRcdFx0YWZ0ZXJVcmw6IGFmdGVyU3RhdGUudXJsLFxuXHRcdFx0XHRcdGJlZm9yZVN0YXRlLFxuXHRcdFx0XHRcdGFmdGVyU3RhdGUsXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdC8vIC0tLSBGb3JtYXQgb3V0cHV0IC0tLVxuXHRcdFx0XHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblx0XHRcdFx0bGluZXMucHVzaChgRm9ybTogJHtmb3JtU2VsZWN0b3J9YCk7XG5cdFx0XHRcdGxpbmVzLnB1c2goYEZpbGxlZDogJHttYXRjaGVkLmxlbmd0aH0gfCBVbm1hdGNoZWQ6ICR7dW5tYXRjaGVkLmxlbmd0aH0gfCBTa2lwcGVkOiAke3NraXBwZWQubGVuZ3RofSR7c3VibWl0dGVkID8gXCIgfCBTdWJtaXR0ZWQ6IHllc1wiIDogXCJcIn1gKTtcblx0XHRcdFx0bGluZXMucHVzaChcIlwiKTtcblxuXHRcdFx0XHRpZiAobWF0Y2hlZC5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0bGluZXMucHVzaChcIiMjIE1hdGNoZWRcIik7XG5cdFx0XHRcdFx0Zm9yIChjb25zdCBtIG9mIG1hdGNoZWQpIHtcblx0XHRcdFx0XHRcdGxpbmVzLnB1c2goYC0gXHUyNzEzICoqJHttLmtleX0qKiBcdTIxOTIgXCIke20udmFsdWV9XCIgKCR7bS5maWVsZFR5cGV9LCByZXNvbHZlZCBieSAke20ucmVzb2x2ZWRCeX0pYCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGxpbmVzLnB1c2goXCJcIik7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAodW5tYXRjaGVkLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0XHRsaW5lcy5wdXNoKFwiIyMgVW5tYXRjaGVkXCIpO1xuXHRcdFx0XHRcdGZvciAoY29uc3QgdSBvZiB1bm1hdGNoZWQpIHtcblx0XHRcdFx0XHRcdGxpbmVzLnB1c2goYC0gXHUyNzE3ICoqJHt1LmtleX0qKiBcdTIwMTQgJHt1LnJlYXNvbn1gKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0bGluZXMucHVzaChcIlwiKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChza2lwcGVkLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0XHRsaW5lcy5wdXNoKFwiIyMgU2tpcHBlZFwiKTtcblx0XHRcdFx0XHRmb3IgKGNvbnN0IHMgb2Ygc2tpcHBlZCkge1xuXHRcdFx0XHRcdFx0bGluZXMucHVzaChgLSBcdTIyOTggKioke3Mua2V5fSoqIFx1MjAxNCAke3MucmVhc29ufWApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRsaW5lcy5wdXNoKFwiXCIpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKCF2YWxpZGF0aW9uU3VtbWFyeS52YWxpZCkge1xuXHRcdFx0XHRcdGxpbmVzLnB1c2goXCIjIyBWYWxpZGF0aW9uIElzc3Vlc1wiKTtcblx0XHRcdFx0XHRmb3IgKGNvbnN0IGludiBvZiB2YWxpZGF0aW9uU3VtbWFyeS5pbnZhbGlkRmllbGRzKSB7XG5cdFx0XHRcdFx0XHRsaW5lcy5wdXNoKGAtICR7aW52Lm5hbWV9OiAke2ludi5tZXNzYWdlfWApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRsaW5lcy5wdXNoKFwiVmFsaWRhdGlvbjogYWxsIGZpZWxkcyB2YWxpZCBcdTI3MTNcIik7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCBmaWxsUmVzdWx0ID0ge1xuXHRcdFx0XHRcdG1hdGNoZWQsXG5cdFx0XHRcdFx0dW5tYXRjaGVkLFxuXHRcdFx0XHRcdHNraXBwZWQsXG5cdFx0XHRcdFx0c3VibWl0dGVkLFxuXHRcdFx0XHRcdHZhbGlkYXRpb25TdW1tYXJ5LFxuXHRcdFx0XHR9O1xuXG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGxpbmVzLmpvaW4oXCJcXG5cIikgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBmaWxsUmVzdWx0IH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IHVua25vd24pIHtcblx0XHRcdFx0Y29uc3Qgc2NyZWVuc2hvdCA9IGF3YWl0IGRlcHMuY2FwdHVyZUVycm9yU2NyZWVuc2hvdChcblx0XHRcdFx0XHQoKCkgPT4geyB0cnkgeyByZXR1cm4gZGVwcy5nZXRBY3RpdmVQYWdlKCk7IH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfSB9KSgpXG5cdFx0XHRcdCk7XG5cdFx0XHRcdGNvbnN0IGVyck1zZyA9IGRlcHMuZmlyc3RFcnJvckxpbmUoZXJyKTtcblxuXHRcdFx0XHRpZiAoYWN0aW9uSWQgIT09IG51bGwpIHtcblx0XHRcdFx0XHRkZXBzLmZpbmlzaFRyYWNrZWRBY3Rpb24oYWN0aW9uSWQsIHtcblx0XHRcdFx0XHRcdHN0YXR1czogXCJlcnJvclwiLFxuXHRcdFx0XHRcdFx0ZXJyb3I6IGVyck1zZyxcblx0XHRcdFx0XHRcdGJlZm9yZVN0YXRlOiBiZWZvcmVTdGF0ZSA/PyB1bmRlZmluZWQsXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCBjb250ZW50OiBBcnJheTx7IHR5cGU6IFwidGV4dFwiOyB0ZXh0OiBzdHJpbmcgfSB8IHsgdHlwZTogXCJpbWFnZVwiOyBkYXRhOiBzdHJpbmc7IG1pbWVUeXBlOiBzdHJpbmcgfT4gPSBbXG5cdFx0XHRcdFx0eyB0eXBlOiBcInRleHRcIiwgdGV4dDogYGJyb3dzZXJfZmlsbF9mb3JtIGZhaWxlZDogJHtlcnJNc2d9YCB9LFxuXHRcdFx0XHRdO1xuXHRcdFx0XHRpZiAoc2NyZWVuc2hvdCkge1xuXHRcdFx0XHRcdGNvbnRlbnQucHVzaCh7IHR5cGU6IFwiaW1hZ2VcIiwgZGF0YTogc2NyZWVuc2hvdC5kYXRhLCBtaW1lVHlwZTogc2NyZWVuc2hvdC5taW1lVHlwZSB9KTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdHJldHVybiB7IGNvbnRlbnQsIGRldGFpbHM6IHt9LCBpc0Vycm9yOiB0cnVlIH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLFlBQVk7QUFFckI7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLE9BQ007QUE4Q0EsU0FBUyx3QkFBd0IsVUFBMkI7QUFHbEUsU0FBTztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLHdCQStFZ0IsS0FBSyxVQUFVLFlBQVksSUFBSSxDQUFDO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUErSXhEO0FBTUEsU0FBUyw4QkFBOEIsY0FBOEI7QUFDcEUsU0FBTztBQUFBLGlCQUNTLEtBQUssVUFBVSxZQUFZLENBQUM7QUFBQTtBQUFBLDhCQUVmLEtBQUssVUFBVSxZQUFZLENBQUM7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBaUMxRDtBQU1PLFNBQVMs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
