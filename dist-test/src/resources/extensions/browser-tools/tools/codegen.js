import { Type } from "@sinclair/typebox";
import { getActionTimeline } from "../state.js";
function registerCodegenTools(pi, deps) {
  pi.registerTool({
    name: "browser_generate_test",
    label: "Browser Generate Test",
    description: "Generate a runnable Playwright test script from the recorded action timeline. Transforms navigation, click, type, and assertion actions into standard Playwright test syntax. Uses stable selectors (role-based preferred). Writes the test file to a configurable path.",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: "Test name (used for describe/test block and filename). Default: 'recorded-session'." })
      ),
      outputPath: Type.Optional(
        Type.String({
          description: "Output file path for the generated test. Default: writes to session artifacts directory. Use a path ending in .spec.ts for standard Playwright test convention."
        })
      ),
      includeAssertions: Type.Optional(
        Type.Boolean({ description: "Include assertion steps from the timeline (default: true)." })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        await deps.ensureBrowser();
        const timeline = getActionTimeline();
        if (timeline.entries.length === 0) {
          return {
            content: [{ type: "text", text: "No actions recorded in the current session. Interact with pages first, then generate a test." }],
            details: { error: "no_actions" },
            isError: true
          };
        }
        const testName = params.name ?? "recorded-session";
        const includeAssertions = params.includeAssertions ?? true;
        const testLines = [];
        const imports = /* @__PURE__ */ new Set();
        imports.add("test");
        imports.add("expect");
        testLines.push(`test.describe('${escapeString(testName)}', () => {`);
        testLines.push(`  test('recorded session', async ({ page }) => {`);
        let lastUrl = "";
        let actionCount = 0;
        for (const entry of timeline.entries) {
          if (entry.status === "error" && entry.tool !== "browser_assert") continue;
          const params2 = parseParamsSummary(entry.paramsSummary);
          switch (entry.tool) {
            case "browser_navigate": {
              const url = params2.url;
              if (url && url !== lastUrl) {
                testLines.push(`    await page.goto(${quote(url)});`);
                lastUrl = url;
                actionCount++;
              }
              break;
            }
            case "browser_click": {
              const selector = params2.selector;
              if (selector) {
                testLines.push(`    await page.locator(${quote(selector)}).click();`);
                actionCount++;
              }
              break;
            }
            case "browser_click_ref": {
              testLines.push(`    // browser_click_ref: ${entry.paramsSummary} \u2014 replace with stable selector`);
              actionCount++;
              break;
            }
            case "browser_type": {
              const selector = params2.selector;
              const text = params2.text;
              if (selector && text) {
                testLines.push(`    await page.locator(${quote(selector)}).fill(${quote(text)});`);
                actionCount++;
              }
              break;
            }
            case "browser_fill_ref": {
              testLines.push(`    // browser_fill_ref: ${entry.paramsSummary} \u2014 replace with stable selector`);
              actionCount++;
              break;
            }
            case "browser_key_press": {
              const key = params2.key;
              if (key) {
                testLines.push(`    await page.keyboard.press(${quote(key)});`);
                actionCount++;
              }
              break;
            }
            case "browser_select_option": {
              const selector = params2.selector;
              const option = params2.option;
              if (selector && option) {
                testLines.push(`    await page.locator(${quote(selector)}).selectOption(${quote(option)});`);
                actionCount++;
              }
              break;
            }
            case "browser_set_checked": {
              const selector = params2.selector;
              const checked = params2.checked;
              if (selector) {
                testLines.push(`    await page.locator(${quote(selector)}).setChecked(${checked === "true"});`);
                actionCount++;
              }
              break;
            }
            case "browser_hover": {
              const selector = params2.selector;
              if (selector) {
                testLines.push(`    await page.locator(${quote(selector)}).hover();`);
                actionCount++;
              }
              break;
            }
            case "browser_wait_for": {
              const condition = params2.condition;
              const value = params2.value;
              if (condition === "selector_visible" && value) {
                testLines.push(`    await expect(page.locator(${quote(value)})).toBeVisible();`);
                actionCount++;
              } else if (condition === "text_visible" && value) {
                testLines.push(`    await expect(page.locator('body')).toContainText(${quote(value)});`);
                actionCount++;
              } else if (condition === "url_contains" && value) {
                testLines.push(`    await page.waitForURL(${quote(`**/*${value}*`)});`);
                actionCount++;
              } else if (condition === "network_idle") {
                testLines.push(`    await page.waitForLoadState('networkidle');`);
                actionCount++;
              } else if (condition === "delay" && value) {
                testLines.push(`    await page.waitForTimeout(${value});`);
                actionCount++;
              }
              break;
            }
            case "browser_assert": {
              if (!includeAssertions) break;
              if (entry.verificationSummary) {
                testLines.push(`    // Assertion: ${entry.verificationSummary}`);
              }
              actionCount++;
              break;
            }
            case "browser_scroll": {
              const direction = params2.direction;
              const amount = params2.amount ?? "300";
              const delta = direction === "up" ? `-${amount}` : amount;
              testLines.push(`    await page.mouse.wheel(0, ${delta});`);
              actionCount++;
              break;
            }
            case "browser_set_viewport": {
              const width = params2.width;
              const height = params2.height;
              if (width && height) {
                testLines.push(`    await page.setViewportSize({ width: ${width}, height: ${height} });`);
                actionCount++;
              }
              break;
            }
            default:
              break;
          }
        }
        testLines.push(`  });`);
        testLines.push(`});`);
        const importLine = `import { ${[...imports].join(", ")} } from '@playwright/test';`;
        const fullTest = `${importLine}

${testLines.join("\n")}
`;
        let outputPath;
        if (params.outputPath) {
          outputPath = params.outputPath;
        } else {
          const safeName = deps.sanitizeArtifactName(testName, "recorded-session");
          outputPath = deps.buildSessionArtifactPath(`${safeName}.spec.ts`);
        }
        await deps.ensureSessionArtifactDir();
        const { path: writtenPath, bytes } = await deps.writeArtifactFile(outputPath, fullTest);
        return {
          content: [{
            type: "text",
            text: `Test generated: ${writtenPath}
Actions: ${actionCount}
Timeline entries processed: ${timeline.entries.length}

${fullTest}`
          }],
          details: {
            path: writtenPath,
            bytes,
            actionCount,
            timelineEntries: timeline.entries.length,
            testCode: fullTest
          }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Test generation failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
}
function escapeString(s) {
  return s.replace(/'/g, "\\'").replace(/\\/g, "\\\\");
}
function quote(s) {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes("`")) return `\`${s}\``;
  return `'${s.replace(/'/g, "\\'")}'`;
}
function parseParamsSummary(summary) {
  const result = {};
  if (!summary) return result;
  const regex = /(\w+)=(?:"([^"]*(?:\\"[^"]*)*)"|([^,\s]+))/g;
  let match;
  while ((match = regex.exec(summary)) !== null) {
    const key = match[1];
    const value = match[2] ?? match[3];
    result[key] = value;
  }
  return result;
}
export {
  registerCodegenTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvY29kZWdlbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB0eXBlIHsgVG9vbERlcHMgfSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcbmltcG9ydCB7IGdldEFjdGlvblRpbWVsaW5lIH0gZnJvbSBcIi4uL3N0YXRlLmpzXCI7XG5cbi8qKlxuICogVGVzdCBjb2RlIGdlbmVyYXRpb24gXHUyMDE0IHRyYW5zZm9ybSByZWNvcmRlZCBicm93c2VyIHNlc3Npb24gaW50byBhIFBsYXl3cmlnaHQgdGVzdCBzY3JpcHQuXG4gKi9cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyQ29kZWdlblRvb2xzKHBpOiBFeHRlbnNpb25BUEksIGRlcHM6IFRvb2xEZXBzKTogdm9pZCB7XG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX2dlbmVyYXRlX3Rlc3RcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIEdlbmVyYXRlIFRlc3RcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiR2VuZXJhdGUgYSBydW5uYWJsZSBQbGF5d3JpZ2h0IHRlc3Qgc2NyaXB0IGZyb20gdGhlIHJlY29yZGVkIGFjdGlvbiB0aW1lbGluZS4gXCIgK1xuXHRcdFx0XCJUcmFuc2Zvcm1zIG5hdmlnYXRpb24sIGNsaWNrLCB0eXBlLCBhbmQgYXNzZXJ0aW9uIGFjdGlvbnMgaW50byBzdGFuZGFyZCBQbGF5d3JpZ2h0IHRlc3Qgc3ludGF4LiBcIiArXG5cdFx0XHRcIlVzZXMgc3RhYmxlIHNlbGVjdG9ycyAocm9sZS1iYXNlZCBwcmVmZXJyZWQpLiBXcml0ZXMgdGhlIHRlc3QgZmlsZSB0byBhIGNvbmZpZ3VyYWJsZSBwYXRoLlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdG5hbWU6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVGVzdCBuYW1lICh1c2VkIGZvciBkZXNjcmliZS90ZXN0IGJsb2NrIGFuZCBmaWxlbmFtZSkuIERlZmF1bHQ6ICdyZWNvcmRlZC1zZXNzaW9uJy5cIiB9KSxcblx0XHRcdCksXG5cdFx0XHRvdXRwdXRQYXRoOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XHRcIk91dHB1dCBmaWxlIHBhdGggZm9yIHRoZSBnZW5lcmF0ZWQgdGVzdC4gRGVmYXVsdDogd3JpdGVzIHRvIHNlc3Npb24gYXJ0aWZhY3RzIGRpcmVjdG9yeS4gXCIgK1xuXHRcdFx0XHRcdFx0XCJVc2UgYSBwYXRoIGVuZGluZyBpbiAuc3BlYy50cyBmb3Igc3RhbmRhcmQgUGxheXdyaWdodCB0ZXN0IGNvbnZlbnRpb24uXCIsXG5cdFx0XHRcdH0pLFxuXHRcdFx0KSxcblx0XHRcdGluY2x1ZGVBc3NlcnRpb25zOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLkJvb2xlYW4oeyBkZXNjcmlwdGlvbjogXCJJbmNsdWRlIGFzc2VydGlvbiBzdGVwcyBmcm9tIHRoZSB0aW1lbGluZSAoZGVmYXVsdDogdHJ1ZSkuXCIgfSksXG5cdFx0XHQpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCB0aW1lbGluZSA9IGdldEFjdGlvblRpbWVsaW5lKCk7XG5cblx0XHRcdFx0aWYgKHRpbWVsaW5lLmVudHJpZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIk5vIGFjdGlvbnMgcmVjb3JkZWQgaW4gdGhlIGN1cnJlbnQgc2Vzc2lvbi4gSW50ZXJhY3Qgd2l0aCBwYWdlcyBmaXJzdCwgdGhlbiBnZW5lcmF0ZSBhIHRlc3QuXCIgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBcIm5vX2FjdGlvbnNcIiB9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgdGVzdE5hbWUgPSBwYXJhbXMubmFtZSA/PyBcInJlY29yZGVkLXNlc3Npb25cIjtcblx0XHRcdFx0Y29uc3QgaW5jbHVkZUFzc2VydGlvbnMgPSBwYXJhbXMuaW5jbHVkZUFzc2VydGlvbnMgPz8gdHJ1ZTtcblxuXHRcdFx0XHQvLyBUcmFuc2Zvcm0gdGltZWxpbmUgZW50cmllcyBpbnRvIFBsYXl3cmlnaHQgdGVzdCBjb2RlXG5cdFx0XHRcdGNvbnN0IHRlc3RMaW5lczogc3RyaW5nW10gPSBbXTtcblx0XHRcdFx0Y29uc3QgaW1wb3J0cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRcdFx0XHRpbXBvcnRzLmFkZChcInRlc3RcIik7XG5cdFx0XHRcdGltcG9ydHMuYWRkKFwiZXhwZWN0XCIpO1xuXG5cdFx0XHRcdHRlc3RMaW5lcy5wdXNoKGB0ZXN0LmRlc2NyaWJlKCcke2VzY2FwZVN0cmluZyh0ZXN0TmFtZSl9JywgKCkgPT4ge2ApO1xuXHRcdFx0XHR0ZXN0TGluZXMucHVzaChgICB0ZXN0KCdyZWNvcmRlZCBzZXNzaW9uJywgYXN5bmMgKHsgcGFnZSB9KSA9PiB7YCk7XG5cblx0XHRcdFx0bGV0IGxhc3RVcmwgPSBcIlwiO1xuXHRcdFx0XHRsZXQgYWN0aW9uQ291bnQgPSAwO1xuXG5cdFx0XHRcdGZvciAoY29uc3QgZW50cnkgb2YgdGltZWxpbmUuZW50cmllcykge1xuXHRcdFx0XHRcdGlmIChlbnRyeS5zdGF0dXMgPT09IFwiZXJyb3JcIiAmJiBlbnRyeS50b29sICE9PSBcImJyb3dzZXJfYXNzZXJ0XCIpIGNvbnRpbnVlO1xuXG5cdFx0XHRcdFx0Y29uc3QgcGFyYW1zID0gcGFyc2VQYXJhbXNTdW1tYXJ5KGVudHJ5LnBhcmFtc1N1bW1hcnkpO1xuXG5cdFx0XHRcdFx0c3dpdGNoIChlbnRyeS50b29sKSB7XG5cdFx0XHRcdFx0XHRjYXNlIFwiYnJvd3Nlcl9uYXZpZ2F0ZVwiOiB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHVybCA9IHBhcmFtcy51cmw7XG5cdFx0XHRcdFx0XHRcdGlmICh1cmwgJiYgdXJsICE9PSBsYXN0VXJsKSB7XG5cdFx0XHRcdFx0XHRcdFx0dGVzdExpbmVzLnB1c2goYCAgICBhd2FpdCBwYWdlLmdvdG8oJHtxdW90ZSh1cmwpfSk7YCk7XG5cdFx0XHRcdFx0XHRcdFx0bGFzdFVybCA9IHVybDtcblx0XHRcdFx0XHRcdFx0XHRhY3Rpb25Db3VudCsrO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRjYXNlIFwiYnJvd3Nlcl9jbGlja1wiOiB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHNlbGVjdG9yID0gcGFyYW1zLnNlbGVjdG9yO1xuXHRcdFx0XHRcdFx0XHRpZiAoc2VsZWN0b3IpIHtcblx0XHRcdFx0XHRcdFx0XHR0ZXN0TGluZXMucHVzaChgICAgIGF3YWl0IHBhZ2UubG9jYXRvcigke3F1b3RlKHNlbGVjdG9yKX0pLmNsaWNrKCk7YCk7XG5cdFx0XHRcdFx0XHRcdFx0YWN0aW9uQ291bnQrKztcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Y2FzZSBcImJyb3dzZXJfY2xpY2tfcmVmXCI6IHtcblx0XHRcdFx0XHRcdFx0Ly8gUmVmcyBhcmUgc2Vzc2lvbi1zcGVjaWZpYyBcdTIwMTQgYWRkIGNvbW1lbnRcblx0XHRcdFx0XHRcdFx0dGVzdExpbmVzLnB1c2goYCAgICAvLyBicm93c2VyX2NsaWNrX3JlZjogJHtlbnRyeS5wYXJhbXNTdW1tYXJ5fSBcdTIwMTQgcmVwbGFjZSB3aXRoIHN0YWJsZSBzZWxlY3RvcmApO1xuXHRcdFx0XHRcdFx0XHRhY3Rpb25Db3VudCsrO1xuXHRcdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Y2FzZSBcImJyb3dzZXJfdHlwZVwiOiB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHNlbGVjdG9yID0gcGFyYW1zLnNlbGVjdG9yO1xuXHRcdFx0XHRcdFx0XHRjb25zdCB0ZXh0ID0gcGFyYW1zLnRleHQ7XG5cdFx0XHRcdFx0XHRcdGlmIChzZWxlY3RvciAmJiB0ZXh0KSB7XG5cdFx0XHRcdFx0XHRcdFx0dGVzdExpbmVzLnB1c2goYCAgICBhd2FpdCBwYWdlLmxvY2F0b3IoJHtxdW90ZShzZWxlY3Rvcil9KS5maWxsKCR7cXVvdGUodGV4dCl9KTtgKTtcblx0XHRcdFx0XHRcdFx0XHRhY3Rpb25Db3VudCsrO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRjYXNlIFwiYnJvd3Nlcl9maWxsX3JlZlwiOiB7XG5cdFx0XHRcdFx0XHRcdHRlc3RMaW5lcy5wdXNoKGAgICAgLy8gYnJvd3Nlcl9maWxsX3JlZjogJHtlbnRyeS5wYXJhbXNTdW1tYXJ5fSBcdTIwMTQgcmVwbGFjZSB3aXRoIHN0YWJsZSBzZWxlY3RvcmApO1xuXHRcdFx0XHRcdFx0XHRhY3Rpb25Db3VudCsrO1xuXHRcdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Y2FzZSBcImJyb3dzZXJfa2V5X3ByZXNzXCI6IHtcblx0XHRcdFx0XHRcdFx0Y29uc3Qga2V5ID0gcGFyYW1zLmtleTtcblx0XHRcdFx0XHRcdFx0aWYgKGtleSkge1xuXHRcdFx0XHRcdFx0XHRcdHRlc3RMaW5lcy5wdXNoKGAgICAgYXdhaXQgcGFnZS5rZXlib2FyZC5wcmVzcygke3F1b3RlKGtleSl9KTtgKTtcblx0XHRcdFx0XHRcdFx0XHRhY3Rpb25Db3VudCsrO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRjYXNlIFwiYnJvd3Nlcl9zZWxlY3Rfb3B0aW9uXCI6IHtcblx0XHRcdFx0XHRcdFx0Y29uc3Qgc2VsZWN0b3IgPSBwYXJhbXMuc2VsZWN0b3I7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IG9wdGlvbiA9IHBhcmFtcy5vcHRpb247XG5cdFx0XHRcdFx0XHRcdGlmIChzZWxlY3RvciAmJiBvcHRpb24pIHtcblx0XHRcdFx0XHRcdFx0XHR0ZXN0TGluZXMucHVzaChgICAgIGF3YWl0IHBhZ2UubG9jYXRvcigke3F1b3RlKHNlbGVjdG9yKX0pLnNlbGVjdE9wdGlvbigke3F1b3RlKG9wdGlvbil9KTtgKTtcblx0XHRcdFx0XHRcdFx0XHRhY3Rpb25Db3VudCsrO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRjYXNlIFwiYnJvd3Nlcl9zZXRfY2hlY2tlZFwiOiB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHNlbGVjdG9yID0gcGFyYW1zLnNlbGVjdG9yO1xuXHRcdFx0XHRcdFx0XHRjb25zdCBjaGVja2VkID0gcGFyYW1zLmNoZWNrZWQ7XG5cdFx0XHRcdFx0XHRcdGlmIChzZWxlY3Rvcikge1xuXHRcdFx0XHRcdFx0XHRcdHRlc3RMaW5lcy5wdXNoKGAgICAgYXdhaXQgcGFnZS5sb2NhdG9yKCR7cXVvdGUoc2VsZWN0b3IpfSkuc2V0Q2hlY2tlZCgke2NoZWNrZWQgPT09IFwidHJ1ZVwifSk7YCk7XG5cdFx0XHRcdFx0XHRcdFx0YWN0aW9uQ291bnQrKztcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Y2FzZSBcImJyb3dzZXJfaG92ZXJcIjoge1xuXHRcdFx0XHRcdFx0XHRjb25zdCBzZWxlY3RvciA9IHBhcmFtcy5zZWxlY3Rvcjtcblx0XHRcdFx0XHRcdFx0aWYgKHNlbGVjdG9yKSB7XG5cdFx0XHRcdFx0XHRcdFx0dGVzdExpbmVzLnB1c2goYCAgICBhd2FpdCBwYWdlLmxvY2F0b3IoJHtxdW90ZShzZWxlY3Rvcil9KS5ob3ZlcigpO2ApO1xuXHRcdFx0XHRcdFx0XHRcdGFjdGlvbkNvdW50Kys7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGNhc2UgXCJicm93c2VyX3dhaXRfZm9yXCI6IHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgY29uZGl0aW9uID0gcGFyYW1zLmNvbmRpdGlvbjtcblx0XHRcdFx0XHRcdFx0Y29uc3QgdmFsdWUgPSBwYXJhbXMudmFsdWU7XG5cdFx0XHRcdFx0XHRcdGlmIChjb25kaXRpb24gPT09IFwic2VsZWN0b3JfdmlzaWJsZVwiICYmIHZhbHVlKSB7XG5cdFx0XHRcdFx0XHRcdFx0dGVzdExpbmVzLnB1c2goYCAgICBhd2FpdCBleHBlY3QocGFnZS5sb2NhdG9yKCR7cXVvdGUodmFsdWUpfSkpLnRvQmVWaXNpYmxlKCk7YCk7XG5cdFx0XHRcdFx0XHRcdFx0YWN0aW9uQ291bnQrKztcblx0XHRcdFx0XHRcdFx0fSBlbHNlIGlmIChjb25kaXRpb24gPT09IFwidGV4dF92aXNpYmxlXCIgJiYgdmFsdWUpIHtcblx0XHRcdFx0XHRcdFx0XHR0ZXN0TGluZXMucHVzaChgICAgIGF3YWl0IGV4cGVjdChwYWdlLmxvY2F0b3IoJ2JvZHknKSkudG9Db250YWluVGV4dCgke3F1b3RlKHZhbHVlKX0pO2ApO1xuXHRcdFx0XHRcdFx0XHRcdGFjdGlvbkNvdW50Kys7XG5cdFx0XHRcdFx0XHRcdH0gZWxzZSBpZiAoY29uZGl0aW9uID09PSBcInVybF9jb250YWluc1wiICYmIHZhbHVlKSB7XG5cdFx0XHRcdFx0XHRcdFx0dGVzdExpbmVzLnB1c2goYCAgICBhd2FpdCBwYWdlLndhaXRGb3JVUkwoJHtxdW90ZShgKiovKiR7dmFsdWV9KmApfSk7YCk7XG5cdFx0XHRcdFx0XHRcdFx0YWN0aW9uQ291bnQrKztcblx0XHRcdFx0XHRcdFx0fSBlbHNlIGlmIChjb25kaXRpb24gPT09IFwibmV0d29ya19pZGxlXCIpIHtcblx0XHRcdFx0XHRcdFx0XHR0ZXN0TGluZXMucHVzaChgICAgIGF3YWl0IHBhZ2Uud2FpdEZvckxvYWRTdGF0ZSgnbmV0d29ya2lkbGUnKTtgKTtcblx0XHRcdFx0XHRcdFx0XHRhY3Rpb25Db3VudCsrO1xuXHRcdFx0XHRcdFx0XHR9IGVsc2UgaWYgKGNvbmRpdGlvbiA9PT0gXCJkZWxheVwiICYmIHZhbHVlKSB7XG5cdFx0XHRcdFx0XHRcdFx0dGVzdExpbmVzLnB1c2goYCAgICBhd2FpdCBwYWdlLndhaXRGb3JUaW1lb3V0KCR7dmFsdWV9KTtgKTtcblx0XHRcdFx0XHRcdFx0XHRhY3Rpb25Db3VudCsrO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRjYXNlIFwiYnJvd3Nlcl9hc3NlcnRcIjoge1xuXHRcdFx0XHRcdFx0XHRpZiAoIWluY2x1ZGVBc3NlcnRpb25zKSBicmVhaztcblx0XHRcdFx0XHRcdFx0Ly8gVGhlIGFzc2VydGlvbiBkZXRhaWxzIGFyZSBpbiB2ZXJpZmljYXRpb25TdW1tYXJ5XG5cdFx0XHRcdFx0XHRcdGlmIChlbnRyeS52ZXJpZmljYXRpb25TdW1tYXJ5KSB7XG5cdFx0XHRcdFx0XHRcdFx0dGVzdExpbmVzLnB1c2goYCAgICAvLyBBc3NlcnRpb246ICR7ZW50cnkudmVyaWZpY2F0aW9uU3VtbWFyeX1gKTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRhY3Rpb25Db3VudCsrO1xuXHRcdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Y2FzZSBcImJyb3dzZXJfc2Nyb2xsXCI6IHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgZGlyZWN0aW9uID0gcGFyYW1zLmRpcmVjdGlvbjtcblx0XHRcdFx0XHRcdFx0Y29uc3QgYW1vdW50ID0gcGFyYW1zLmFtb3VudCA/PyBcIjMwMFwiO1xuXHRcdFx0XHRcdFx0XHRjb25zdCBkZWx0YSA9IGRpcmVjdGlvbiA9PT0gXCJ1cFwiID8gYC0ke2Ftb3VudH1gIDogYW1vdW50O1xuXHRcdFx0XHRcdFx0XHR0ZXN0TGluZXMucHVzaChgICAgIGF3YWl0IHBhZ2UubW91c2Uud2hlZWwoMCwgJHtkZWx0YX0pO2ApO1xuXHRcdFx0XHRcdFx0XHRhY3Rpb25Db3VudCsrO1xuXHRcdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Y2FzZSBcImJyb3dzZXJfc2V0X3ZpZXdwb3J0XCI6IHtcblx0XHRcdFx0XHRcdFx0Y29uc3Qgd2lkdGggPSBwYXJhbXMud2lkdGg7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGhlaWdodCA9IHBhcmFtcy5oZWlnaHQ7XG5cdFx0XHRcdFx0XHRcdGlmICh3aWR0aCAmJiBoZWlnaHQpIHtcblx0XHRcdFx0XHRcdFx0XHR0ZXN0TGluZXMucHVzaChgICAgIGF3YWl0IHBhZ2Uuc2V0Vmlld3BvcnRTaXplKHsgd2lkdGg6ICR7d2lkdGh9LCBoZWlnaHQ6ICR7aGVpZ2h0fSB9KTtgKTtcblx0XHRcdFx0XHRcdFx0XHRhY3Rpb25Db3VudCsrO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRkZWZhdWx0OlxuXHRcdFx0XHRcdFx0XHQvLyBTa2lwIHRvb2xzIHRoYXQgZG9uJ3QgbWFwIHRvIFBsYXl3cmlnaHQgdGVzdCBhY3Rpb25zXG5cdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdHRlc3RMaW5lcy5wdXNoKGAgIH0pO2ApO1xuXHRcdFx0XHR0ZXN0TGluZXMucHVzaChgfSk7YCk7XG5cblx0XHRcdFx0Y29uc3QgaW1wb3J0TGluZSA9IGBpbXBvcnQgeyAke1suLi5pbXBvcnRzXS5qb2luKFwiLCBcIil9IH0gZnJvbSAnQHBsYXl3cmlnaHQvdGVzdCc7YDtcblx0XHRcdFx0Y29uc3QgZnVsbFRlc3QgPSBgJHtpbXBvcnRMaW5lfVxcblxcbiR7dGVzdExpbmVzLmpvaW4oXCJcXG5cIil9XFxuYDtcblxuXHRcdFx0XHQvLyBXcml0ZSB0byBmaWxlXG5cdFx0XHRcdGxldCBvdXRwdXRQYXRoOiBzdHJpbmc7XG5cdFx0XHRcdGlmIChwYXJhbXMub3V0cHV0UGF0aCkge1xuXHRcdFx0XHRcdG91dHB1dFBhdGggPSBwYXJhbXMub3V0cHV0UGF0aDtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRjb25zdCBzYWZlTmFtZSA9IGRlcHMuc2FuaXRpemVBcnRpZmFjdE5hbWUodGVzdE5hbWUsIFwicmVjb3JkZWQtc2Vzc2lvblwiKTtcblx0XHRcdFx0XHRvdXRwdXRQYXRoID0gZGVwcy5idWlsZFNlc3Npb25BcnRpZmFjdFBhdGgoYCR7c2FmZU5hbWV9LnNwZWMudHNgKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGF3YWl0IGRlcHMuZW5zdXJlU2Vzc2lvbkFydGlmYWN0RGlyKCk7XG5cdFx0XHRcdGNvbnN0IHsgcGF0aDogd3JpdHRlblBhdGgsIGJ5dGVzIH0gPSBhd2FpdCBkZXBzLndyaXRlQXJ0aWZhY3RGaWxlKG91dHB1dFBhdGgsIGZ1bGxUZXN0KTtcblxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdHRleHQ6IGBUZXN0IGdlbmVyYXRlZDogJHt3cml0dGVuUGF0aH1cXG5BY3Rpb25zOiAke2FjdGlvbkNvdW50fVxcblRpbWVsaW5lIGVudHJpZXMgcHJvY2Vzc2VkOiAke3RpbWVsaW5lLmVudHJpZXMubGVuZ3RofVxcblxcbiR7ZnVsbFRlc3R9YCxcblx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7XG5cdFx0XHRcdFx0XHRwYXRoOiB3cml0dGVuUGF0aCxcblx0XHRcdFx0XHRcdGJ5dGVzLFxuXHRcdFx0XHRcdFx0YWN0aW9uQ291bnQsXG5cdFx0XHRcdFx0XHR0aW1lbGluZUVudHJpZXM6IHRpbWVsaW5lLmVudHJpZXMubGVuZ3RoLFxuXHRcdFx0XHRcdFx0dGVzdENvZGU6IGZ1bGxUZXN0LFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgVGVzdCBnZW5lcmF0aW9uIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlU3RyaW5nKHM6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiBzLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKS5yZXBsYWNlKC9cXFxcL2csIFwiXFxcXFxcXFxcIik7XG59XG5cbmZ1bmN0aW9uIHF1b3RlKHM6IHN0cmluZyk6IHN0cmluZyB7XG5cdC8vIFVzZSBzaW5nbGUgcXVvdGVzIGZvciBzaW1wbGUgc3RyaW5ncywgYmFja3RpY2sgZm9yIHRob3NlIHdpdGggcXVvdGVzXG5cdGlmICghcy5pbmNsdWRlcyhcIidcIikpIHJldHVybiBgJyR7c30nYDtcblx0aWYgKCFzLmluY2x1ZGVzKFwiYFwiKSkgcmV0dXJuIGBcXGAke3N9XFxgYDtcblx0cmV0dXJuIGAnJHtzLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKX0nYDtcbn1cblxuLyoqXG4gKiBQYXJzZSB0aGUgcGFyYW1zU3VtbWFyeSBzdHJpbmcgYmFjayBpbnRvIGtleS12YWx1ZSBwYWlycy5cbiAqIEZvcm1hdDoga2V5PVwidmFsdWVcIiwga2V5PXZhbHVlLCBrZXk9W05dLCBrZXk9ey4uLn1cbiAqL1xuZnVuY3Rpb24gcGFyc2VQYXJhbXNTdW1tYXJ5KHN1bW1hcnk6IHN0cmluZyk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuXHRjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcblx0aWYgKCFzdW1tYXJ5KSByZXR1cm4gcmVzdWx0O1xuXG5cdGNvbnN0IHJlZ2V4ID0gLyhcXHcrKT0oPzpcIihbXlwiXSooPzpcXFxcXCJbXlwiXSopKilcInwoW14sXFxzXSspKS9nO1xuXHRsZXQgbWF0Y2g7XG5cdHdoaWxlICgobWF0Y2ggPSByZWdleC5leGVjKHN1bW1hcnkpKSAhPT0gbnVsbCkge1xuXHRcdGNvbnN0IGtleSA9IG1hdGNoWzFdO1xuXHRcdGNvbnN0IHZhbHVlID0gbWF0Y2hbMl0gPz8gbWF0Y2hbM107XG5cdFx0cmVzdWx0W2tleV0gPSB2YWx1ZTtcblx0fVxuXHRyZXR1cm4gcmVzdWx0O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBUyxZQUFZO0FBRXJCLFNBQVMseUJBQXlCO0FBTTNCLFNBQVMscUJBQXFCLElBQWtCLE1BQXNCO0FBQzVFLEtBQUcsYUFBYTtBQUFBLElBQ2YsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDQztBQUFBLElBR0QsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN2QixNQUFNLEtBQUs7QUFBQSxRQUNWLEtBQUssT0FBTyxFQUFFLGFBQWEsc0ZBQXNGLENBQUM7QUFBQSxNQUNuSDtBQUFBLE1BQ0EsWUFBWSxLQUFLO0FBQUEsUUFDaEIsS0FBSyxPQUFPO0FBQUEsVUFDWCxhQUNDO0FBQUEsUUFFRixDQUFDO0FBQUEsTUFDRjtBQUFBLE1BQ0EsbUJBQW1CLEtBQUs7QUFB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
