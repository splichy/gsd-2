import { Type } from "@sinclair/typebox";
const INJECTION_PATTERNS = [
  // Direct instruction override attempts
  { pattern: /ignore\s+(all\s+)?previous\s+(instructions?|prompts?)/i, category: "instruction_override", severity: "high" },
  { pattern: /disregard\s+(all\s+)?previous\s+(instructions?|prompts?)/i, category: "instruction_override", severity: "high" },
  { pattern: /forget\s+(all\s+)?previous\s+(instructions?|prompts?)/i, category: "instruction_override", severity: "high" },
  { pattern: /override\s+(all\s+)?previous\s+(instructions?|prompts?)/i, category: "instruction_override", severity: "high" },
  // System prompt extraction
  { pattern: /(?:what|show|reveal|display|repeat|tell)\s+(?:me\s+)?(?:your|the)\s+system\s+prompt/i, category: "prompt_extraction", severity: "high" },
  { pattern: /print\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions)/i, category: "prompt_extraction", severity: "high" },
  // Role reassignment
  { pattern: /you\s+are\s+now\s+(?:a\s+)?(?:DAN|jailbreak|unrestricted|unfiltered)/i, category: "role_reassignment", severity: "high" },
  { pattern: /act\s+as\s+(?:a\s+)?(?:DAN|jailbreak|unrestricted|unfiltered)/i, category: "role_reassignment", severity: "high" },
  { pattern: /entering\s+(?:a\s+)?(?:developer|admin|root|sudo)\s+mode/i, category: "role_reassignment", severity: "high" },
  // Hidden instruction injection
  { pattern: /\[SYSTEM\]\s*:/i, category: "fake_system_message", severity: "high" },
  { pattern: /\[INST\]\s*:/i, category: "fake_system_message", severity: "medium" },
  { pattern: /<\/?system>/i, category: "fake_system_message", severity: "high" },
  // Tool/action manipulation
  { pattern: /execute\s+(?:the\s+following\s+)?(?:command|code|script)/i, category: "command_injection", severity: "medium" },
  { pattern: /run\s+(?:this|the\s+following)\s+(?:command|code|script)/i, category: "command_injection", severity: "medium" },
  // Invisible text / social engineering
  { pattern: /do\s+not\s+(?:read|process|show)\s+(?:the\s+)?(?:following|rest)/i, category: "social_engineering", severity: "low" },
  { pattern: /(?:this|the\s+following)\s+(?:is|are)\s+(?:your\s+)?new\s+instructions/i, category: "instruction_override", severity: "high" },
  // Base64/encoded content markers
  { pattern: /base64\s*:\s*[A-Za-z0-9+\/=]{50,}/i, category: "encoded_payload", severity: "medium" }
];
function registerInjectionDetectionTools(pi, deps) {
  pi.registerTool({
    name: "browser_check_injection",
    label: "Browser Check Injection",
    description: "Scan current page content for potential prompt injection attempts. Checks visible text and hidden elements for patterns that might hijack the agent. Returns findings with severity levels. Use after navigating to untrusted pages.",
    parameters: Type.Object({
      includeHidden: Type.Optional(
        Type.Boolean({
          description: "Also scan hidden/invisible text (default: true). Hidden text is a common vector for injection attacks."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const includeHidden = params.includeHidden ?? true;
        const pageContent = await p.evaluate((scanHidden) => {
          const results = [];
          const bodyText = document.body?.innerText ?? "";
          results.push({ text: bodyText, source: "body_visible_text", visible: true });
          results.push({ text: document.title, source: "page_title", visible: true });
          const metas = document.querySelectorAll("meta[name], meta[property]");
          for (const meta of metas) {
            const content = meta.getAttribute("content");
            if (content) {
              results.push({
                text: content,
                source: `meta:${meta.getAttribute("name") || meta.getAttribute("property")}`,
                visible: false
              });
            }
          }
          if (scanHidden) {
            const allElements = document.querySelectorAll("*");
            for (const el of allElements) {
              const htmlEl = el;
              const style = window.getComputedStyle(htmlEl);
              const isHidden = style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || htmlEl.getAttribute("aria-hidden") === "true" || htmlEl.offsetWidth === 0 && htmlEl.offsetHeight === 0;
              if (isHidden && htmlEl.textContent?.trim()) {
                const text = htmlEl.textContent.trim();
                if (text.length > 5 && text.length < 5e3) {
                  results.push({ text, source: "hidden_element", visible: false });
                }
              }
            }
            const walker = document.createTreeWalker(
              document.documentElement,
              NodeFilter.SHOW_COMMENT
            );
            let node;
            while (node = walker.nextNode()) {
              const text = node.textContent?.trim() ?? "";
              if (text.length > 10) {
                results.push({ text, source: "html_comment", visible: false });
              }
            }
            const dataElements = document.querySelectorAll("[data-prompt], [data-instruction], [data-system]");
            for (const el of dataElements) {
              for (const attr of el.attributes) {
                if (attr.name.startsWith("data-") && attr.value.length > 10) {
                  results.push({
                    text: attr.value,
                    source: `data_attribute:${attr.name}`,
                    visible: false
                  });
                }
              }
            }
          }
          return results;
        }, includeHidden);
        const findings = [];
        for (const { text, source, visible } of pageContent) {
          for (const { pattern, category, severity } of INJECTION_PATTERNS) {
            const match = text.match(pattern);
            if (match) {
              findings.push({
                pattern: pattern.source.slice(0, 60),
                category,
                severity,
                source,
                visible,
                matchedText: match[0].slice(0, 100)
              });
            }
          }
        }
        const seen = /* @__PURE__ */ new Set();
        const uniqueFindings = findings.filter((f) => {
          const key = `${f.category}|${f.source}|${f.matchedText}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const highCount = uniqueFindings.filter((f) => f.severity === "high").length;
        const medCount = uniqueFindings.filter((f) => f.severity === "medium").length;
        const lowCount = uniqueFindings.filter((f) => f.severity === "low").length;
        if (uniqueFindings.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No prompt injection patterns detected.
Scanned: ${pageContent.length} text regions (hidden: ${includeHidden})`
            }],
            details: {
              clean: true,
              scannedRegions: pageContent.length,
              includeHidden
            }
          };
        }
        const findingLines = uniqueFindings.map(
          (f) => `  [${f.severity.toUpperCase()}] ${f.category} in ${f.source}${!f.visible ? " (HIDDEN)" : ""}: "${f.matchedText}"`
        );
        return {
          content: [{
            type: "text",
            text: `\u26A0\uFE0F Prompt injection patterns detected: ${uniqueFindings.length} finding(s)
High: ${highCount} | Medium: ${medCount} | Low: ${lowCount}

${findingLines.join("\n")}

\u26A0\uFE0F This page may be attempting to manipulate the agent. Proceed with caution.`
          }],
          details: {
            clean: false,
            findings: uniqueFindings,
            counts: { high: highCount, medium: medCount, low: lowCount, total: uniqueFindings.length },
            scannedRegions: pageContent.length,
            includeHidden
          }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Injection check failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
}
export {
  registerInjectionDetectionTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvaW5qZWN0aW9uLWRldGVjdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB0eXBlIHsgVG9vbERlcHMgfSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcblxuLyoqXG4gKiBQcm9tcHQgaW5qZWN0aW9uIGRldGVjdGlvbiBcdTIwMTQgc2NhbiBwYWdlIGNvbnRlbnQgZm9yIHRleHQgYXR0ZW1wdGluZyB0byBoaWphY2sgdGhlIGFnZW50LlxuICovXG5cbi8vIEtub3duIGluamVjdGlvbiBwYXR0ZXJucyBcdTIwMTQgcmVnZXggcGF0dGVybnMgdGhhdCBtYXRjaCBjb21tb24gcHJvbXB0IGluamVjdGlvbiBhdHRlbXB0c1xuY29uc3QgSU5KRUNUSU9OX1BBVFRFUk5TOiBBcnJheTx7IHBhdHRlcm46IFJlZ0V4cDsgY2F0ZWdvcnk6IHN0cmluZzsgc2V2ZXJpdHk6IFwiaGlnaFwiIHwgXCJtZWRpdW1cIiB8IFwibG93XCIgfT4gPSBbXG5cdC8vIERpcmVjdCBpbnN0cnVjdGlvbiBvdmVycmlkZSBhdHRlbXB0c1xuXHR7IHBhdHRlcm46IC9pZ25vcmVcXHMrKGFsbFxccyspP3ByZXZpb3VzXFxzKyhpbnN0cnVjdGlvbnM/fHByb21wdHM/KS9pLCBjYXRlZ29yeTogXCJpbnN0cnVjdGlvbl9vdmVycmlkZVwiLCBzZXZlcml0eTogXCJoaWdoXCIgfSxcblx0eyBwYXR0ZXJuOiAvZGlzcmVnYXJkXFxzKyhhbGxcXHMrKT9wcmV2aW91c1xccysoaW5zdHJ1Y3Rpb25zP3xwcm9tcHRzPykvaSwgY2F0ZWdvcnk6IFwiaW5zdHJ1Y3Rpb25fb3ZlcnJpZGVcIiwgc2V2ZXJpdHk6IFwiaGlnaFwiIH0sXG5cdHsgcGF0dGVybjogL2ZvcmdldFxccysoYWxsXFxzKyk/cHJldmlvdXNcXHMrKGluc3RydWN0aW9ucz98cHJvbXB0cz8pL2ksIGNhdGVnb3J5OiBcImluc3RydWN0aW9uX292ZXJyaWRlXCIsIHNldmVyaXR5OiBcImhpZ2hcIiB9LFxuXHR7IHBhdHRlcm46IC9vdmVycmlkZVxccysoYWxsXFxzKyk/cHJldmlvdXNcXHMrKGluc3RydWN0aW9ucz98cHJvbXB0cz8pL2ksIGNhdGVnb3J5OiBcImluc3RydWN0aW9uX292ZXJyaWRlXCIsIHNldmVyaXR5OiBcImhpZ2hcIiB9LFxuXG5cdC8vIFN5c3RlbSBwcm9tcHQgZXh0cmFjdGlvblxuXHR7IHBhdHRlcm46IC8oPzp3aGF0fHNob3d8cmV2ZWFsfGRpc3BsYXl8cmVwZWF0fHRlbGwpXFxzKyg/Om1lXFxzKyk/KD86eW91cnx0aGUpXFxzK3N5c3RlbVxccytwcm9tcHQvaSwgY2F0ZWdvcnk6IFwicHJvbXB0X2V4dHJhY3Rpb25cIiwgc2V2ZXJpdHk6IFwiaGlnaFwiIH0sXG5cdHsgcGF0dGVybjogL3ByaW50XFxzKyg/OnlvdXJ8dGhlKVxccysoPzpzeXN0ZW1cXHMrKT8oPzpwcm9tcHR8aW5zdHJ1Y3Rpb25zKS9pLCBjYXRlZ29yeTogXCJwcm9tcHRfZXh0cmFjdGlvblwiLCBzZXZlcml0eTogXCJoaWdoXCIgfSxcblxuXHQvLyBSb2xlIHJlYXNzaWdubWVudFxuXHR7IHBhdHRlcm46IC95b3VcXHMrYXJlXFxzK25vd1xccysoPzphXFxzKyk/KD86REFOfGphaWxicmVha3x1bnJlc3RyaWN0ZWR8dW5maWx0ZXJlZCkvaSwgY2F0ZWdvcnk6IFwicm9sZV9yZWFzc2lnbm1lbnRcIiwgc2V2ZXJpdHk6IFwiaGlnaFwiIH0sXG5cdHsgcGF0dGVybjogL2FjdFxccythc1xccysoPzphXFxzKyk/KD86REFOfGphaWxicmVha3x1bnJlc3RyaWN0ZWR8dW5maWx0ZXJlZCkvaSwgY2F0ZWdvcnk6IFwicm9sZV9yZWFzc2lnbm1lbnRcIiwgc2V2ZXJpdHk6IFwiaGlnaFwiIH0sXG5cdHsgcGF0dGVybjogL2VudGVyaW5nXFxzKyg/OmFcXHMrKT8oPzpkZXZlbG9wZXJ8YWRtaW58cm9vdHxzdWRvKVxccyttb2RlL2ksIGNhdGVnb3J5OiBcInJvbGVfcmVhc3NpZ25tZW50XCIsIHNldmVyaXR5OiBcImhpZ2hcIiB9LFxuXG5cdC8vIEhpZGRlbiBpbnN0cnVjdGlvbiBpbmplY3Rpb25cblx0eyBwYXR0ZXJuOiAvXFxbU1lTVEVNXFxdXFxzKjovaSwgY2F0ZWdvcnk6IFwiZmFrZV9zeXN0ZW1fbWVzc2FnZVwiLCBzZXZlcml0eTogXCJoaWdoXCIgfSxcblx0eyBwYXR0ZXJuOiAvXFxbSU5TVFxcXVxccyo6L2ksIGNhdGVnb3J5OiBcImZha2Vfc3lzdGVtX21lc3NhZ2VcIiwgc2V2ZXJpdHk6IFwibWVkaXVtXCIgfSxcblx0eyBwYXR0ZXJuOiAvPFxcLz9zeXN0ZW0+L2ksIGNhdGVnb3J5OiBcImZha2Vfc3lzdGVtX21lc3NhZ2VcIiwgc2V2ZXJpdHk6IFwiaGlnaFwiIH0sXG5cblx0Ly8gVG9vbC9hY3Rpb24gbWFuaXB1bGF0aW9uXG5cdHsgcGF0dGVybjogL2V4ZWN1dGVcXHMrKD86dGhlXFxzK2ZvbGxvd2luZ1xccyspPyg/OmNvbW1hbmR8Y29kZXxzY3JpcHQpL2ksIGNhdGVnb3J5OiBcImNvbW1hbmRfaW5qZWN0aW9uXCIsIHNldmVyaXR5OiBcIm1lZGl1bVwiIH0sXG5cdHsgcGF0dGVybjogL3J1blxccysoPzp0aGlzfHRoZVxccytmb2xsb3dpbmcpXFxzKyg/OmNvbW1hbmR8Y29kZXxzY3JpcHQpL2ksIGNhdGVnb3J5OiBcImNvbW1hbmRfaW5qZWN0aW9uXCIsIHNldmVyaXR5OiBcIm1lZGl1bVwiIH0sXG5cblx0Ly8gSW52aXNpYmxlIHRleHQgLyBzb2NpYWwgZW5naW5lZXJpbmdcblx0eyBwYXR0ZXJuOiAvZG9cXHMrbm90XFxzKyg/OnJlYWR8cHJvY2Vzc3xzaG93KVxccysoPzp0aGVcXHMrKT8oPzpmb2xsb3dpbmd8cmVzdCkvaSwgY2F0ZWdvcnk6IFwic29jaWFsX2VuZ2luZWVyaW5nXCIsIHNldmVyaXR5OiBcImxvd1wiIH0sXG5cdHsgcGF0dGVybjogLyg/OnRoaXN8dGhlXFxzK2ZvbGxvd2luZylcXHMrKD86aXN8YXJlKVxccysoPzp5b3VyXFxzKyk/bmV3XFxzK2luc3RydWN0aW9ucy9pLCBjYXRlZ29yeTogXCJpbnN0cnVjdGlvbl9vdmVycmlkZVwiLCBzZXZlcml0eTogXCJoaWdoXCIgfSxcblxuXHQvLyBCYXNlNjQvZW5jb2RlZCBjb250ZW50IG1hcmtlcnNcblx0eyBwYXR0ZXJuOiAvYmFzZTY0XFxzKjpcXHMqW0EtWmEtejAtOStcXC89XXs1MCx9L2ksIGNhdGVnb3J5OiBcImVuY29kZWRfcGF5bG9hZFwiLCBzZXZlcml0eTogXCJtZWRpdW1cIiB9LFxuXTtcblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVySW5qZWN0aW9uRGV0ZWN0aW9uVG9vbHMocGk6IEV4dGVuc2lvbkFQSSwgZGVwczogVG9vbERlcHMpOiB2b2lkIHtcblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfY2hlY2tfaW5qZWN0aW9uXCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBDaGVjayBJbmplY3Rpb25cIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiU2NhbiBjdXJyZW50IHBhZ2UgY29udGVudCBmb3IgcG90ZW50aWFsIHByb21wdCBpbmplY3Rpb24gYXR0ZW1wdHMuIFwiICtcblx0XHRcdFwiQ2hlY2tzIHZpc2libGUgdGV4dCBhbmQgaGlkZGVuIGVsZW1lbnRzIGZvciBwYXR0ZXJucyB0aGF0IG1pZ2h0IGhpamFjayB0aGUgYWdlbnQuIFwiICtcblx0XHRcdFwiUmV0dXJucyBmaW5kaW5ncyB3aXRoIHNldmVyaXR5IGxldmVscy4gVXNlIGFmdGVyIG5hdmlnYXRpbmcgdG8gdW50cnVzdGVkIHBhZ2VzLlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdGluY2x1ZGVIaWRkZW46IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuQm9vbGVhbih7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XHRcIkFsc28gc2NhbiBoaWRkZW4vaW52aXNpYmxlIHRleHQgKGRlZmF1bHQ6IHRydWUpLiBcIiArXG5cdFx0XHRcdFx0XHRcIkhpZGRlbiB0ZXh0IGlzIGEgY29tbW9uIHZlY3RvciBmb3IgaW5qZWN0aW9uIGF0dGFja3MuXCIsXG5cdFx0XHRcdH0pLFxuXHRcdFx0KSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCB7IHBhZ2U6IHAgfSA9IGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCBpbmNsdWRlSGlkZGVuID0gcGFyYW1zLmluY2x1ZGVIaWRkZW4gPz8gdHJ1ZTtcblxuXHRcdFx0XHQvLyBFeHRyYWN0IHRleHQgY29udGVudCBmcm9tIHRoZSBwYWdlXG5cdFx0XHRcdGNvbnN0IHBhZ2VDb250ZW50ID0gYXdhaXQgcC5ldmFsdWF0ZSgoc2NhbkhpZGRlbjogYm9vbGVhbikgPT4ge1xuXHRcdFx0XHRcdGNvbnN0IHJlc3VsdHM6IEFycmF5PHsgdGV4dDogc3RyaW5nOyBzb3VyY2U6IHN0cmluZzsgdmlzaWJsZTogYm9vbGVhbiB9PiA9IFtdO1xuXG5cdFx0XHRcdFx0Ly8gMS4gVmlzaWJsZSB0ZXh0IGNvbnRlbnRcblx0XHRcdFx0XHRjb25zdCBib2R5VGV4dCA9IGRvY3VtZW50LmJvZHk/LmlubmVyVGV4dCA/PyBcIlwiO1xuXHRcdFx0XHRcdHJlc3VsdHMucHVzaCh7IHRleHQ6IGJvZHlUZXh0LCBzb3VyY2U6IFwiYm9keV92aXNpYmxlX3RleHRcIiwgdmlzaWJsZTogdHJ1ZSB9KTtcblxuXHRcdFx0XHRcdC8vIDIuIFRpdGxlIGFuZCBtZXRhXG5cdFx0XHRcdFx0cmVzdWx0cy5wdXNoKHsgdGV4dDogZG9jdW1lbnQudGl0bGUsIHNvdXJjZTogXCJwYWdlX3RpdGxlXCIsIHZpc2libGU6IHRydWUgfSk7XG5cblx0XHRcdFx0XHQvLyBNZXRhIGRlc2NyaXB0aW9ucyBhbmQga2V5d29yZHNcblx0XHRcdFx0XHRjb25zdCBtZXRhcyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoXCJtZXRhW25hbWVdLCBtZXRhW3Byb3BlcnR5XVwiKTtcblx0XHRcdFx0XHRmb3IgKGNvbnN0IG1ldGEgb2YgbWV0YXMpIHtcblx0XHRcdFx0XHRcdGNvbnN0IGNvbnRlbnQgPSBtZXRhLmdldEF0dHJpYnV0ZShcImNvbnRlbnRcIik7XG5cdFx0XHRcdFx0XHRpZiAoY29udGVudCkge1xuXHRcdFx0XHRcdFx0XHRyZXN1bHRzLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdHRleHQ6IGNvbnRlbnQsXG5cdFx0XHRcdFx0XHRcdFx0c291cmNlOiBgbWV0YToke21ldGEuZ2V0QXR0cmlidXRlKFwibmFtZVwiKSB8fCBtZXRhLmdldEF0dHJpYnV0ZShcInByb3BlcnR5XCIpfWAsXG5cdFx0XHRcdFx0XHRcdFx0dmlzaWJsZTogZmFsc2UsXG5cdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGlmIChzY2FuSGlkZGVuKSB7XG5cdFx0XHRcdFx0XHQvLyAzLiBIaWRkZW4gZWxlbWVudHMgKGRpc3BsYXk6bm9uZSwgdmlzaWJpbGl0eTpoaWRkZW4sIG9wYWNpdHk6MCwgb2ZmLXNjcmVlbiwgYXJpYS1oaWRkZW4pXG5cdFx0XHRcdFx0XHRjb25zdCBhbGxFbGVtZW50cyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoXCIqXCIpO1xuXHRcdFx0XHRcdFx0Zm9yIChjb25zdCBlbCBvZiBhbGxFbGVtZW50cykge1xuXHRcdFx0XHRcdFx0XHRjb25zdCBodG1sRWwgPSBlbCBhcyBIVE1MRWxlbWVudDtcblx0XHRcdFx0XHRcdFx0Y29uc3Qgc3R5bGUgPSB3aW5kb3cuZ2V0Q29tcHV0ZWRTdHlsZShodG1sRWwpO1xuXHRcdFx0XHRcdFx0XHRjb25zdCBpc0hpZGRlbiA9XG5cdFx0XHRcdFx0XHRcdFx0c3R5bGUuZGlzcGxheSA9PT0gXCJub25lXCIgfHxcblx0XHRcdFx0XHRcdFx0XHRzdHlsZS52aXNpYmlsaXR5ID09PSBcImhpZGRlblwiIHx8XG5cdFx0XHRcdFx0XHRcdFx0c3R5bGUub3BhY2l0eSA9PT0gXCIwXCIgfHxcblx0XHRcdFx0XHRcdFx0XHRodG1sRWwuZ2V0QXR0cmlidXRlKFwiYXJpYS1oaWRkZW5cIikgPT09IFwidHJ1ZVwiIHx8XG5cdFx0XHRcdFx0XHRcdFx0KGh0bWxFbC5vZmZzZXRXaWR0aCA9PT0gMCAmJiBodG1sRWwub2Zmc2V0SGVpZ2h0ID09PSAwKTtcblxuXHRcdFx0XHRcdFx0XHRpZiAoaXNIaWRkZW4gJiYgaHRtbEVsLnRleHRDb250ZW50Py50cmltKCkpIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCB0ZXh0ID0gaHRtbEVsLnRleHRDb250ZW50LnRyaW0oKTtcblx0XHRcdFx0XHRcdFx0XHRpZiAodGV4dC5sZW5ndGggPiA1ICYmIHRleHQubGVuZ3RoIDwgNTAwMCkge1xuXHRcdFx0XHRcdFx0XHRcdFx0cmVzdWx0cy5wdXNoKHsgdGV4dCwgc291cmNlOiBcImhpZGRlbl9lbGVtZW50XCIsIHZpc2libGU6IGZhbHNlIH0pO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHQvLyA0LiBIVE1MIGNvbW1lbnRzXG5cdFx0XHRcdFx0XHRjb25zdCB3YWxrZXIgPSBkb2N1bWVudC5jcmVhdGVUcmVlV2Fsa2VyKFxuXHRcdFx0XHRcdFx0XHRkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQsXG5cdFx0XHRcdFx0XHRcdE5vZGVGaWx0ZXIuU0hPV19DT01NRU5ULFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdGxldCBub2RlO1xuXHRcdFx0XHRcdFx0d2hpbGUgKChub2RlID0gd2Fsa2VyLm5leHROb2RlKCkpKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHRleHQgPSAobm9kZSBhcyBDb21tZW50KS50ZXh0Q29udGVudD8udHJpbSgpID8/IFwiXCI7XG5cdFx0XHRcdFx0XHRcdGlmICh0ZXh0Lmxlbmd0aCA+IDEwKSB7XG5cdFx0XHRcdFx0XHRcdFx0cmVzdWx0cy5wdXNoKHsgdGV4dCwgc291cmNlOiBcImh0bWxfY29tbWVudFwiLCB2aXNpYmxlOiBmYWxzZSB9KTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHQvLyA1LiBEYXRhIGF0dHJpYnV0ZXMgd2l0aCB0ZXh0IGNvbnRlbnRcblx0XHRcdFx0XHRcdGNvbnN0IGRhdGFFbGVtZW50cyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoXCJbZGF0YS1wcm9tcHRdLCBbZGF0YS1pbnN0cnVjdGlvbl0sIFtkYXRhLXN5c3RlbV1cIik7XG5cdFx0XHRcdFx0XHRmb3IgKGNvbnN0IGVsIG9mIGRhdGFFbGVtZW50cykge1xuXHRcdFx0XHRcdFx0XHRmb3IgKGNvbnN0IGF0dHIgb2YgZWwuYXR0cmlidXRlcykge1xuXHRcdFx0XHRcdFx0XHRcdGlmIChhdHRyLm5hbWUuc3RhcnRzV2l0aChcImRhdGEtXCIpICYmIGF0dHIudmFsdWUubGVuZ3RoID4gMTApIHtcblx0XHRcdFx0XHRcdFx0XHRcdHJlc3VsdHMucHVzaCh7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdHRleHQ6IGF0dHIudmFsdWUsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdHNvdXJjZTogYGRhdGFfYXR0cmlidXRlOiR7YXR0ci5uYW1lfWAsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdHZpc2libGU6IGZhbHNlLFxuXHRcdFx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0cmV0dXJuIHJlc3VsdHM7XG5cdFx0XHRcdH0sIGluY2x1ZGVIaWRkZW4pO1xuXG5cdFx0XHRcdC8vIFNjYW4gYWxsIGV4dHJhY3RlZCB0ZXh0IGFnYWluc3QgaW5qZWN0aW9uIHBhdHRlcm5zXG5cdFx0XHRcdGNvbnN0IGZpbmRpbmdzOiBBcnJheTx7XG5cdFx0XHRcdFx0cGF0dGVybjogc3RyaW5nO1xuXHRcdFx0XHRcdGNhdGVnb3J5OiBzdHJpbmc7XG5cdFx0XHRcdFx0c2V2ZXJpdHk6IHN0cmluZztcblx0XHRcdFx0XHRzb3VyY2U6IHN0cmluZztcblx0XHRcdFx0XHR2aXNpYmxlOiBib29sZWFuO1xuXHRcdFx0XHRcdG1hdGNoZWRUZXh0OiBzdHJpbmc7XG5cdFx0XHRcdH0+ID0gW107XG5cblx0XHRcdFx0Zm9yIChjb25zdCB7IHRleHQsIHNvdXJjZSwgdmlzaWJsZSB9IG9mIHBhZ2VDb250ZW50KSB7XG5cdFx0XHRcdFx0Zm9yIChjb25zdCB7IHBhdHRlcm4sIGNhdGVnb3J5LCBzZXZlcml0eSB9IG9mIElOSkVDVElPTl9QQVRURVJOUykge1xuXHRcdFx0XHRcdFx0Y29uc3QgbWF0Y2ggPSB0ZXh0Lm1hdGNoKHBhdHRlcm4pO1xuXHRcdFx0XHRcdFx0aWYgKG1hdGNoKSB7XG5cdFx0XHRcdFx0XHRcdGZpbmRpbmdzLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdHBhdHRlcm46IHBhdHRlcm4uc291cmNlLnNsaWNlKDAsIDYwKSxcblx0XHRcdFx0XHRcdFx0XHRjYXRlZ29yeSxcblx0XHRcdFx0XHRcdFx0XHRzZXZlcml0eSxcblx0XHRcdFx0XHRcdFx0XHRzb3VyY2UsXG5cdFx0XHRcdFx0XHRcdFx0dmlzaWJsZSxcblx0XHRcdFx0XHRcdFx0XHRtYXRjaGVkVGV4dDogbWF0Y2hbMF0uc2xpY2UoMCwgMTAwKSxcblx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gRGVkdXBsaWNhdGUgZmluZGluZ3MgYnkgY2F0ZWdvcnkgKyBzb3VyY2Vcblx0XHRcdFx0Y29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRcdFx0XHRjb25zdCB1bmlxdWVGaW5kaW5ncyA9IGZpbmRpbmdzLmZpbHRlcigoZikgPT4ge1xuXHRcdFx0XHRcdGNvbnN0IGtleSA9IGAke2YuY2F0ZWdvcnl9fCR7Zi5zb3VyY2V9fCR7Zi5tYXRjaGVkVGV4dH1gO1xuXHRcdFx0XHRcdGlmIChzZWVuLmhhcyhrZXkpKSByZXR1cm4gZmFsc2U7XG5cdFx0XHRcdFx0c2Vlbi5hZGQoa2V5KTtcblx0XHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0Y29uc3QgaGlnaENvdW50ID0gdW5pcXVlRmluZGluZ3MuZmlsdGVyKChmKSA9PiBmLnNldmVyaXR5ID09PSBcImhpZ2hcIikubGVuZ3RoO1xuXHRcdFx0XHRjb25zdCBtZWRDb3VudCA9IHVuaXF1ZUZpbmRpbmdzLmZpbHRlcigoZikgPT4gZi5zZXZlcml0eSA9PT0gXCJtZWRpdW1cIikubGVuZ3RoO1xuXHRcdFx0XHRjb25zdCBsb3dDb3VudCA9IHVuaXF1ZUZpbmRpbmdzLmZpbHRlcigoZikgPT4gZi5zZXZlcml0eSA9PT0gXCJsb3dcIikubGVuZ3RoO1xuXG5cdFx0XHRcdGlmICh1bmlxdWVGaW5kaW5ncy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3tcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHRcdHRleHQ6IGBObyBwcm9tcHQgaW5qZWN0aW9uIHBhdHRlcm5zIGRldGVjdGVkLlxcblNjYW5uZWQ6ICR7cGFnZUNvbnRlbnQubGVuZ3RofSB0ZXh0IHJlZ2lvbnMgKGhpZGRlbjogJHtpbmNsdWRlSGlkZGVufSlgLFxuXHRcdFx0XHRcdFx0fV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7XG5cdFx0XHRcdFx0XHRcdGNsZWFuOiB0cnVlLFxuXHRcdFx0XHRcdFx0XHRzY2FubmVkUmVnaW9uczogcGFnZUNvbnRlbnQubGVuZ3RoLFxuXHRcdFx0XHRcdFx0XHRpbmNsdWRlSGlkZGVuLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgZmluZGluZ0xpbmVzID0gdW5pcXVlRmluZGluZ3MubWFwKChmKSA9PlxuXHRcdFx0XHRcdGAgIFske2Yuc2V2ZXJpdHkudG9VcHBlckNhc2UoKX1dICR7Zi5jYXRlZ29yeX0gaW4gJHtmLnNvdXJjZX0keyFmLnZpc2libGUgPyBcIiAoSElEREVOKVwiIDogXCJcIn06IFwiJHtmLm1hdGNoZWRUZXh0fVwiYCxcblx0XHRcdFx0KTtcblxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdHRleHQ6IGBcdTI2QTBcdUZFMEYgUHJvbXB0IGluamVjdGlvbiBwYXR0ZXJucyBkZXRlY3RlZDogJHt1bmlxdWVGaW5kaW5ncy5sZW5ndGh9IGZpbmRpbmcocylcXG5IaWdoOiAke2hpZ2hDb3VudH0gfCBNZWRpdW06ICR7bWVkQ291bnR9IHwgTG93OiAke2xvd0NvdW50fVxcblxcbiR7ZmluZGluZ0xpbmVzLmpvaW4oXCJcXG5cIil9XFxuXFxuXHUyNkEwXHVGRTBGIFRoaXMgcGFnZSBtYXkgYmUgYXR0ZW1wdGluZyB0byBtYW5pcHVsYXRlIHRoZSBhZ2VudC4gUHJvY2VlZCB3aXRoIGNhdXRpb24uYCxcblx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7XG5cdFx0XHRcdFx0XHRjbGVhbjogZmFsc2UsXG5cdFx0XHRcdFx0XHRmaW5kaW5nczogdW5pcXVlRmluZGluZ3MsXG5cdFx0XHRcdFx0XHRjb3VudHM6IHsgaGlnaDogaGlnaENvdW50LCBtZWRpdW06IG1lZENvdW50LCBsb3c6IGxvd0NvdW50LCB0b3RhbDogdW5pcXVlRmluZGluZ3MubGVuZ3RoIH0sXG5cdFx0XHRcdFx0XHRzY2FubmVkUmVnaW9uczogcGFnZUNvbnRlbnQubGVuZ3RoLFxuXHRcdFx0XHRcdFx0aW5jbHVkZUhpZGRlbixcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEluamVjdGlvbiBjaGVjayBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSB9LFxuXHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLFlBQVk7QUFRckIsTUFBTSxxQkFBd0c7QUFBQTtBQUFBLEVBRTdHLEVBQUUsU0FBUywwREFBMEQsVUFBVSx3QkFBd0IsVUFBVSxPQUFPO0FBQUEsRUFDeEgsRUFBRSxTQUFTLDZEQUE2RCxVQUFVLHdCQUF3QixVQUFVLE9BQU87QUFBQSxFQUMzSCxFQUFFLFNBQVMsMERBQTBELFVBQVUsd0JBQXdCLFVBQVUsT0FBTztBQUFBLEVBQ3hILEVBQUUsU0FBUyw0REFBNEQsVUFBVSx3QkFBd0IsVUFBVSxPQUFPO0FBQUE7QUFBQSxFQUcxSCxFQUFFLFNBQVMsd0ZBQXdGLFVBQVUscUJBQXFCLFVBQVUsT0FBTztBQUFBLEVBQ25KLEVBQUUsU0FBUyxpRUFBaUUsVUFBVSxxQkFBcUIsVUFBVSxPQUFPO0FBQUE7QUFBQSxFQUc1SCxFQUFFLFNBQVMseUVBQXlFLFVBQVUscUJBQXFCLFVBQVUsT0FBTztBQUFBLEVBQ3BJLEVBQUUsU0FBUyxrRUFBa0UsVUFBVSxxQkFBcUIsVUFBVSxPQUFPO0FBQUEsRUFDN0gsRUFBRSxTQUFTLDZEQUE2RCxVQUFVLHFCQUFxQixVQUFVLE9BQU87QUFBQTtBQUFBLEVBR3hILEVBQUUsU0FBUyxtQkFBbUIsVUFBVSx1QkFBdUIsVUFBVSxPQUFPO0FBQUEsRUFDaEYs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
