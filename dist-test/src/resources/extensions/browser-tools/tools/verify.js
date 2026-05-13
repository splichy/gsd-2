import { Type } from "@sinclair/typebox";
function registerVerifyTools(pi, deps) {
  pi.registerTool({
    name: "browser_verify",
    label: "Browser Verify",
    description: "Run a structured browser verification flow: navigate to a URL, run checks (element visibility, text content), capture screenshots as evidence, and return structured pass/fail results.",
    promptGuidelines: [
      "Use browser_verify for UAT verification flows that need structured evidence.",
      "Each check produces a pass/fail result with captured evidence.",
      "Prefer this over manual navigation + assertion sequences for verification tasks."
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to" }),
      checks: Type.Array(
        Type.Object({
          description: Type.String({ description: "What this check verifies" }),
          selector: Type.Optional(Type.String({ description: "CSS selector to check" })),
          expectedText: Type.Optional(Type.String({ description: "Expected text content" })),
          expectedVisible: Type.Optional(Type.Boolean({ description: "Whether element should be visible" })),
          screenshot: Type.Optional(Type.Boolean({ description: "Capture screenshot as evidence" }))
        }),
        { description: "Verification checks to run" }
      ),
      timeout: Type.Optional(Type.Number({ description: "Navigation timeout in ms", default: 1e4 }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const startTime = Date.now();
      const { page } = await deps.ensureBrowser();
      const timeout = params.timeout ?? 1e4;
      try {
        await page.goto(params.url, { waitUntil: "domcontentloaded", timeout });
      } catch (navErr) {
        const msg = navErr instanceof Error ? navErr.message : String(navErr);
        return {
          content: [{ type: "text", text: `Navigation failed: ${msg}` }],
          details: {
            url: params.url,
            passed: false,
            checks: params.checks.map((c) => ({ description: c.description, passed: false, error: msg })),
            duration: Date.now() - startTime
          }
        };
      }
      const results = [];
      for (const check of params.checks) {
        try {
          let passed = true;
          let actual;
          let evidence;
          if (check.selector) {
            const element = await page.$(check.selector);
            if (check.expectedVisible !== void 0) {
              const isVisible = element ? await element.isVisible() : false;
              passed = isVisible === check.expectedVisible;
              actual = `visible=${isVisible}`;
            }
            if (check.expectedText !== void 0 && element) {
              const text = await element.textContent();
              passed = passed && (text?.includes(check.expectedText) ?? false);
              actual = `text="${text?.slice(0, 200)}"`;
            }
            if (!element && (check.expectedVisible === true || check.expectedText)) {
              passed = false;
              actual = "element not found";
            }
          }
          if (check.screenshot) {
            try {
              const buf = await page.screenshot({ type: "png" });
              evidence = `screenshot captured (${buf.length} bytes)`;
            } catch {
              evidence = "screenshot failed";
            }
          }
          results.push({ description: check.description, passed, actual, evidence });
        } catch (checkErr) {
          results.push({
            description: check.description,
            passed: false,
            error: checkErr instanceof Error ? checkErr.message : String(checkErr)
          });
        }
      }
      const allPassed = results.every((r) => r.passed);
      const summary = results.map((r) => `${r.passed ? "PASS" : "FAIL"}: ${r.description}${r.actual ? ` (${r.actual})` : ""}${r.error ? ` \u2014 ${r.error}` : ""}`).join("\n");
      return {
        content: [{ type: "text", text: `Verification ${allPassed ? "PASSED" : "FAILED"} (${results.filter((r) => r.passed).length}/${results.length})

${summary}` }],
        details: {
          url: params.url,
          passed: allPassed,
          checks: results,
          duration: Date.now() - startTime
        }
      };
    }
  });
}
export {
  registerVerifyTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvdmVyaWZ5LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHR5cGUgeyBUb29sRGVwcyB9IGZyb20gXCIuLi9zdGF0ZS5qc1wiO1xuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJWZXJpZnlUb29scyhwaTogRXh0ZW5zaW9uQVBJLCBkZXBzOiBUb29sRGVwcyk6IHZvaWQge1xuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl92ZXJpZnlcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIFZlcmlmeVwiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJSdW4gYSBzdHJ1Y3R1cmVkIGJyb3dzZXIgdmVyaWZpY2F0aW9uIGZsb3c6IG5hdmlnYXRlIHRvIGEgVVJMLCBydW4gY2hlY2tzIChlbGVtZW50IHZpc2liaWxpdHksIHRleHQgY29udGVudCksIGNhcHR1cmUgc2NyZWVuc2hvdHMgYXMgZXZpZGVuY2UsIGFuZCByZXR1cm4gc3RydWN0dXJlZCBwYXNzL2ZhaWwgcmVzdWx0cy5cIixcblx0XHRwcm9tcHRHdWlkZWxpbmVzOiBbXG5cdFx0XHRcIlVzZSBicm93c2VyX3ZlcmlmeSBmb3IgVUFUIHZlcmlmaWNhdGlvbiBmbG93cyB0aGF0IG5lZWQgc3RydWN0dXJlZCBldmlkZW5jZS5cIixcblx0XHRcdFwiRWFjaCBjaGVjayBwcm9kdWNlcyBhIHBhc3MvZmFpbCByZXN1bHQgd2l0aCBjYXB0dXJlZCBldmlkZW5jZS5cIixcblx0XHRcdFwiUHJlZmVyIHRoaXMgb3ZlciBtYW51YWwgbmF2aWdhdGlvbiArIGFzc2VydGlvbiBzZXF1ZW5jZXMgZm9yIHZlcmlmaWNhdGlvbiB0YXNrcy5cIixcblx0XHRdLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdHVybDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJVUkwgdG8gbmF2aWdhdGUgdG9cIiB9KSxcblx0XHRcdGNoZWNrczogVHlwZS5BcnJheShcblx0XHRcdFx0VHlwZS5PYmplY3Qoe1xuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIldoYXQgdGhpcyBjaGVjayB2ZXJpZmllc1wiIH0pLFxuXHRcdFx0XHRcdHNlbGVjdG9yOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQ1NTIHNlbGVjdG9yIHRvIGNoZWNrXCIgfSkpLFxuXHRcdFx0XHRcdGV4cGVjdGVkVGV4dDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkV4cGVjdGVkIHRleHQgY29udGVudFwiIH0pKSxcblx0XHRcdFx0XHRleHBlY3RlZFZpc2libGU6IFR5cGUuT3B0aW9uYWwoVHlwZS5Cb29sZWFuKHsgZGVzY3JpcHRpb246IFwiV2hldGhlciBlbGVtZW50IHNob3VsZCBiZSB2aXNpYmxlXCIgfSkpLFxuXHRcdFx0XHRcdHNjcmVlbnNob3Q6IFR5cGUuT3B0aW9uYWwoVHlwZS5Cb29sZWFuKHsgZGVzY3JpcHRpb246IFwiQ2FwdHVyZSBzY3JlZW5zaG90IGFzIGV2aWRlbmNlXCIgfSkpLFxuXHRcdFx0XHR9KSxcblx0XHRcdFx0eyBkZXNjcmlwdGlvbjogXCJWZXJpZmljYXRpb24gY2hlY2tzIHRvIHJ1blwiIH0sXG5cdFx0XHQpLFxuXHRcdFx0dGltZW91dDogVHlwZS5PcHRpb25hbChUeXBlLk51bWJlcih7IGRlc2NyaXB0aW9uOiBcIk5hdmlnYXRpb24gdGltZW91dCBpbiBtc1wiLCBkZWZhdWx0OiAxMDAwMCB9KSksXG5cdFx0fSksXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG5cdFx0XHRjb25zdCB7IHBhZ2UgfSA9IGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0Y29uc3QgdGltZW91dCA9IHBhcmFtcy50aW1lb3V0ID8/IDEwMDAwO1xuXG5cdFx0XHR0cnkge1xuXHRcdFx0XHRhd2FpdCBwYWdlLmdvdG8ocGFyYW1zLnVybCwgeyB3YWl0VW50aWw6IFwiZG9tY29udGVudGxvYWRlZFwiLCB0aW1lb3V0IH0pO1xuXHRcdFx0fSBjYXRjaCAobmF2RXJyKSB7XG5cdFx0XHRcdGNvbnN0IG1zZyA9IG5hdkVyciBpbnN0YW5jZW9mIEVycm9yID8gbmF2RXJyLm1lc3NhZ2UgOiBTdHJpbmcobmF2RXJyKTtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYE5hdmlnYXRpb24gZmFpbGVkOiAke21zZ31gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHRcdHVybDogcGFyYW1zLnVybCxcblx0XHRcdFx0XHRcdHBhc3NlZDogZmFsc2UsXG5cdFx0XHRcdFx0XHRjaGVja3M6IHBhcmFtcy5jaGVja3MubWFwKChjKSA9PiAoeyBkZXNjcmlwdGlvbjogYy5kZXNjcmlwdGlvbiwgcGFzc2VkOiBmYWxzZSwgZXJyb3I6IG1zZyB9KSksXG5cdFx0XHRcdFx0XHRkdXJhdGlvbjogRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCByZXN1bHRzOiBBcnJheTx7XG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBzdHJpbmc7XG5cdFx0XHRcdHBhc3NlZDogYm9vbGVhbjtcblx0XHRcdFx0YWN0dWFsPzogc3RyaW5nO1xuXHRcdFx0XHRldmlkZW5jZT86IHN0cmluZztcblx0XHRcdFx0ZXJyb3I/OiBzdHJpbmc7XG5cdFx0XHR9PiA9IFtdO1xuXG5cdFx0XHRmb3IgKGNvbnN0IGNoZWNrIG9mIHBhcmFtcy5jaGVja3MpIHtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRsZXQgcGFzc2VkID0gdHJ1ZTtcblx0XHRcdFx0XHRsZXQgYWN0dWFsOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0bGV0IGV2aWRlbmNlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cblx0XHRcdFx0XHRpZiAoY2hlY2suc2VsZWN0b3IpIHtcblx0XHRcdFx0XHRcdGNvbnN0IGVsZW1lbnQgPSBhd2FpdCBwYWdlLiQoY2hlY2suc2VsZWN0b3IpO1xuXG5cdFx0XHRcdFx0XHRpZiAoY2hlY2suZXhwZWN0ZWRWaXNpYmxlICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgaXNWaXNpYmxlID0gZWxlbWVudCA/IGF3YWl0IGVsZW1lbnQuaXNWaXNpYmxlKCkgOiBmYWxzZTtcblx0XHRcdFx0XHRcdFx0cGFzc2VkID0gaXNWaXNpYmxlID09PSBjaGVjay5leHBlY3RlZFZpc2libGU7XG5cdFx0XHRcdFx0XHRcdGFjdHVhbCA9IGB2aXNpYmxlPSR7aXNWaXNpYmxlfWA7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGlmIChjaGVjay5leHBlY3RlZFRleHQgIT09IHVuZGVmaW5lZCAmJiBlbGVtZW50KSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHRleHQgPSBhd2FpdCBlbGVtZW50LnRleHRDb250ZW50KCk7XG5cdFx0XHRcdFx0XHRcdHBhc3NlZCA9IHBhc3NlZCAmJiAodGV4dD8uaW5jbHVkZXMoY2hlY2suZXhwZWN0ZWRUZXh0KSA/PyBmYWxzZSk7XG5cdFx0XHRcdFx0XHRcdGFjdHVhbCA9IGB0ZXh0PVwiJHt0ZXh0Py5zbGljZSgwLCAyMDApfVwiYDtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0aWYgKCFlbGVtZW50ICYmIChjaGVjay5leHBlY3RlZFZpc2libGUgPT09IHRydWUgfHwgY2hlY2suZXhwZWN0ZWRUZXh0KSkge1xuXHRcdFx0XHRcdFx0XHRwYXNzZWQgPSBmYWxzZTtcblx0XHRcdFx0XHRcdFx0YWN0dWFsID0gXCJlbGVtZW50IG5vdCBmb3VuZFwiO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGlmIChjaGVjay5zY3JlZW5zaG90KSB7XG5cdFx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0XHRjb25zdCBidWYgPSBhd2FpdCBwYWdlLnNjcmVlbnNob3QoeyB0eXBlOiBcInBuZ1wiIH0pO1xuXHRcdFx0XHRcdFx0XHRldmlkZW5jZSA9IGBzY3JlZW5zaG90IGNhcHR1cmVkICgke2J1Zi5sZW5ndGh9IGJ5dGVzKWA7XG5cdFx0XHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRcdFx0ZXZpZGVuY2UgPSBcInNjcmVlbnNob3QgZmFpbGVkXCI7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0cmVzdWx0cy5wdXNoKHsgZGVzY3JpcHRpb246IGNoZWNrLmRlc2NyaXB0aW9uLCBwYXNzZWQsIGFjdHVhbCwgZXZpZGVuY2UgfSk7XG5cdFx0XHRcdH0gY2F0Y2ggKGNoZWNrRXJyKSB7XG5cdFx0XHRcdFx0cmVzdWx0cy5wdXNoKHtcblx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBjaGVjay5kZXNjcmlwdGlvbixcblx0XHRcdFx0XHRcdHBhc3NlZDogZmFsc2UsXG5cdFx0XHRcdFx0XHRlcnJvcjogY2hlY2tFcnIgaW5zdGFuY2VvZiBFcnJvciA/IGNoZWNrRXJyLm1lc3NhZ2UgOiBTdHJpbmcoY2hlY2tFcnIpLFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGFsbFBhc3NlZCA9IHJlc3VsdHMuZXZlcnkoKHIpID0+IHIucGFzc2VkKTtcblx0XHRcdGNvbnN0IHN1bW1hcnkgPSByZXN1bHRzLm1hcCgocikgPT4gYCR7ci5wYXNzZWQgPyBcIlBBU1NcIiA6IFwiRkFJTFwifTogJHtyLmRlc2NyaXB0aW9ufSR7ci5hY3R1YWwgPyBgICgke3IuYWN0dWFsfSlgIDogXCJcIn0ke3IuZXJyb3IgPyBgIFx1MjAxNCAke3IuZXJyb3J9YCA6IFwiXCJ9YCkuam9pbihcIlxcblwiKTtcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgVmVyaWZpY2F0aW9uICR7YWxsUGFzc2VkID8gXCJQQVNTRURcIiA6IFwiRkFJTEVEXCJ9ICgke3Jlc3VsdHMuZmlsdGVyKHIgPT4gci5wYXNzZWQpLmxlbmd0aH0vJHtyZXN1bHRzLmxlbmd0aH0pXFxuXFxuJHtzdW1tYXJ5fWAgfV0sXG5cdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHR1cmw6IHBhcmFtcy51cmwsXG5cdFx0XHRcdFx0cGFzc2VkOiBhbGxQYXNzZWQsXG5cdFx0XHRcdFx0Y2hlY2tzOiByZXN1bHRzLFxuXHRcdFx0XHRcdGR1cmF0aW9uOiBEYXRlLm5vdygpIC0gc3RhcnRUaW1lLFxuXHRcdFx0XHR9LFxuXHRcdFx0fTtcblx0XHR9LFxuXHR9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUNBLFNBQVMsWUFBWTtBQUdkLFNBQVMsb0JBQW9CLElBQWtCLE1BQXNCO0FBQzNFLEtBQUcsYUFBYTtBQUFBLElBQ2YsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDQztBQUFBLElBQ0Qsa0JBQWtCO0FBQUEsTUFDakI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Q7QUFBQSxJQUNBLFlBQVksS0FBSyxPQUFPO0FBQUEsTUFDdkIsS0FBSyxLQUFLLE9BQU8sRUFBRSxhQUFhLHFCQUFxQixDQUFDO0FBQUEsTUFDdEQsUUFBUSxLQUFLO0FBQUEsUUFDWixLQUFLLE9BQU87QUFBQSxVQUNYLGFBQWEsS0FBSyxPQUFPLEVBQUUsYUFBYSwyQkFBMkIsQ0FBQztBQUFBLFVBQ3BFLFVBQVUsS0FB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
