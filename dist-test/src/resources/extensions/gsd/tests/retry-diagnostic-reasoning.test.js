import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractTrace, getDeepDiagnostic } from "../session-forensics.js";
function makeAssistantText(text) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }]
    }
  };
}
function makeToolPair(toolName, input, resultText, isError) {
  const toolCallId = `toolu_${Math.random().toString(36).slice(2, 10)}`;
  return [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: toolName,
            arguments: input
          }
        ]
      }
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        toolName,
        isError,
        content: [{ type: "text", text: resultText }]
      }
    }
  ];
}
describe("retry diagnostic excludes lastReasoning (#2195)", () => {
  test("extractTrace still captures lastReasoning in the trace object", () => {
    const entries = [
      makeAssistantText("I am going to write the summary file now"),
      ...makeToolPair("write", { path: "/tmp/SUMMARY.md" }, "ok", false),
      makeAssistantText("The task is complete \u2014 all files written.")
    ];
    const trace = extractTrace(entries);
    assert.ok(
      trace.lastReasoning.length > 0,
      "extractTrace should still populate lastReasoning"
    );
    assert.ok(
      trace.lastReasoning.includes("all files written"),
      "lastReasoning should contain the last assistant text"
    );
  });
  test("getDeepDiagnostic output does NOT contain lastReasoning", () => {
    const tempBase = mkdtempSync(join(tmpdir(), "gsd-diag-test-"));
    const gsdDir = join(tempBase, ".gsd");
    const activityDir = join(gsdDir, "activity");
    mkdirSync(activityDir, { recursive: true });
    try {
      const entries = [
        makeAssistantText("Let me analyze the codebase structure first"),
        ...makeToolPair("bash", { command: "ls src/" }, "index.ts\nutils.ts", false),
        makeAssistantText("I see the milestone/M001 branch has a significantly different ... 3. ")
      ];
      const jsonl = entries.map((e) => JSON.stringify(e)).join("\n");
      writeFileSync(join(activityDir, "2025-01-01T00-00-00.jsonl"), jsonl);
      const diagnostic = getDeepDiagnostic(tempBase);
      assert.ok(diagnostic !== null, "diagnostic should not be null");
      assert.ok(
        diagnostic.includes("Tool calls completed:"),
        "should include tool call count"
      );
      assert.ok(
        diagnostic.includes("ls src/"),
        "should include commands run"
      );
      assert.ok(
        !diagnostic.includes("Last reasoning"),
        "diagnostic must not include 'Last reasoning' label"
      );
      assert.ok(
        !diagnostic.includes("analyze the codebase"),
        "diagnostic must not include prior assistant text"
      );
      assert.ok(
        !diagnostic.includes("significantly different"),
        "diagnostic must not include truncated assistant reasoning"
      );
    } finally {
      rmSync(tempBase, { recursive: true, force: true });
    }
  });
  test("getDeepDiagnostic still includes errors and file operations", () => {
    const tempBase = mkdtempSync(join(tmpdir(), "gsd-diag-test-"));
    const gsdDir = join(tempBase, ".gsd");
    const activityDir = join(gsdDir, "activity");
    mkdirSync(activityDir, { recursive: true });
    try {
      const entries = [
        makeAssistantText("Writing the plan file"),
        ...makeToolPair("write", { path: "M001/S01/S01-PLAN.md" }, "ok", false),
        ...makeToolPair("bash", { command: "npm run build" }, "Error: type mismatch", true),
        makeAssistantText("The build failed, let me investigate")
      ];
      const jsonl = entries.map((e) => JSON.stringify(e)).join("\n");
      writeFileSync(join(activityDir, "2025-01-01T00-00-00.jsonl"), jsonl);
      const diagnostic = getDeepDiagnostic(tempBase);
      assert.ok(diagnostic !== null);
      assert.ok(
        diagnostic.includes("S01-PLAN.md"),
        "should include files written"
      );
      assert.ok(
        diagnostic.includes("npm run build"),
        "should include commands run"
      );
      assert.ok(
        diagnostic.includes("type mismatch"),
        "should include errors"
      );
      assert.ok(
        !diagnostic.includes("Writing the plan"),
        "must not include assistant reasoning"
      );
      assert.ok(
        !diagnostic.includes("build failed"),
        "must not include assistant reasoning about failures"
      );
    } finally {
      rmSync(tempBase, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZXRyeS1kaWFnbm9zdGljLXJlYXNvbmluZy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdHMgZm9yICMyMTk1OiBmb3JtYXRUcmFjZVN1bW1hcnkgKHVzZWQgYnkgZ2V0RGVlcERpYWdub3N0aWMgXHUyMTkyXG4gKiByZXRyeSBwcm9tcHRzKSBtdXN0IE5PVCBpbmNsdWRlIGxhc3RSZWFzb25pbmcgZnJvbSBwcmlvciBhc3Npc3RhbnQgdGV4dC5cbiAqXG4gKiBJbmNsdWRpbmcgcHJpb3IgYXNzaXN0YW50IGZyZWUtdGV4dCBpbiByZXRyeSBkaWFnbm9zdGljcyBjYXVzZXMgaGFsbHVjaW5hdGlvblxuICogbG9vcHMgd2hlbiB0aGUgcHJldmlvdXMgdHVybiB3YXMgdHJ1bmNhdGVkIG9yIG1hbGZvcm1lZC5cbiAqXG4gKiBUaGUgY3Jhc2ggcmVjb3ZlcnkgcGF0aCAoZm9ybWF0Q3Jhc2hSZWNvdmVyeUJyaWVmaW5nKSBoYXMgaXRzIG93biBzYWZlIGhhbmRsaW5nXG4gKiBvZiBsYXN0UmVhc29uaW5nIGFuZCBpcyBOT1QgYWZmZWN0ZWQgYnkgdGhpcyBjaGFuZ2UuXG4gKi9cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMsIHJtU3luYywgbWtkdGVtcFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7IGV4dHJhY3RUcmFjZSwgZ2V0RGVlcERpYWdub3N0aWMgfSBmcm9tIFwiLi4vc2Vzc2lvbi1mb3JlbnNpY3MudHNcIjtcblxuLyoqIEJ1aWxkIGEgbWluaW1hbCBhc3Npc3RhbnQgdGV4dCByZWFzb25pbmcgZW50cnkuICovXG5mdW5jdGlvbiBtYWtlQXNzaXN0YW50VGV4dCh0ZXh0OiBzdHJpbmcpOiB1bmtub3duIHtcbiAgcmV0dXJuIHtcbiAgICB0eXBlOiBcIm1lc3NhZ2VcIixcbiAgICBtZXNzYWdlOiB7XG4gICAgICByb2xlOiBcImFzc2lzdGFudFwiLFxuICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQgfV0sXG4gICAgfSxcbiAgfTtcbn1cblxuLyoqIEJ1aWxkIGEgbWluaW1hbCBhc3Npc3RhbnQgdG9vbCBjYWxsICsgdG9vbCByZXN1bHQgcGFpci4gKi9cbmZ1bmN0aW9uIG1ha2VUb29sUGFpcihcbiAgdG9vbE5hbWU6IHN0cmluZyxcbiAgaW5wdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICByZXN1bHRUZXh0OiBzdHJpbmcsXG4gIGlzRXJyb3I6IGJvb2xlYW4sXG4pOiB1bmtub3duW10ge1xuICBjb25zdCB0b29sQ2FsbElkID0gYHRvb2x1XyR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgMTApfWA7XG4gIHJldHVybiBbXG4gICAge1xuICAgICAgdHlwZTogXCJtZXNzYWdlXCIsXG4gICAgICBtZXNzYWdlOiB7XG4gICAgICAgIHJvbGU6IFwiYXNzaXN0YW50XCIsXG4gICAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICB0eXBlOiBcInRvb2xDYWxsXCIsXG4gICAgICAgICAgICBpZDogdG9vbENhbGxJZCxcbiAgICAgICAgICAgIG5hbWU6IHRvb2xOYW1lLFxuICAgICAgICAgICAgYXJndW1lbnRzOiBpbnB1dCxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICB9LFxuICAgIHtcbiAgICAgIHR5cGU6IFwibWVzc2FnZVwiLFxuICAgICAgbWVzc2FnZToge1xuICAgICAgICByb2xlOiBcInRvb2xSZXN1bHRcIixcbiAgICAgICAgdG9vbENhbGxJZCxcbiAgICAgICAgdG9vbE5hbWUsXG4gICAgICAgIGlzRXJyb3IsXG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiByZXN1bHRUZXh0IH1dLFxuICAgICAgfSxcbiAgICB9LFxuICBdO1xufVxuXG5kZXNjcmliZShcInJldHJ5IGRpYWdub3N0aWMgZXhjbHVkZXMgbGFzdFJlYXNvbmluZyAoIzIxOTUpXCIsICgpID0+IHtcbiAgdGVzdChcImV4dHJhY3RUcmFjZSBzdGlsbCBjYXB0dXJlcyBsYXN0UmVhc29uaW5nIGluIHRoZSB0cmFjZSBvYmplY3RcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGVudHJpZXMgPSBbXG4gICAgICBtYWtlQXNzaXN0YW50VGV4dChcIkkgYW0gZ29pbmcgdG8gd3JpdGUgdGhlIHN1bW1hcnkgZmlsZSBub3dcIiksXG4gICAgICAuLi5tYWtlVG9vbFBhaXIoXCJ3cml0ZVwiLCB7IHBhdGg6IFwiL3RtcC9TVU1NQVJZLm1kXCIgfSwgXCJva1wiLCBmYWxzZSksXG4gICAgICBtYWtlQXNzaXN0YW50VGV4dChcIlRoZSB0YXNrIGlzIGNvbXBsZXRlIFx1MjAxNCBhbGwgZmlsZXMgd3JpdHRlbi5cIiksXG4gICAgXTtcblxuICAgIGNvbnN0IHRyYWNlID0gZXh0cmFjdFRyYWNlKGVudHJpZXMpO1xuICAgIC8vIGV4dHJhY3RUcmFjZSBzaG91bGQgc3RpbGwgY29sbGVjdCBsYXN0UmVhc29uaW5nIGZvciBjcmFzaCByZWNvdmVyeVxuICAgIGFzc2VydC5vayh0cmFjZS5sYXN0UmVhc29uaW5nLmxlbmd0aCA+IDAsXG4gICAgICBcImV4dHJhY3RUcmFjZSBzaG91bGQgc3RpbGwgcG9wdWxhdGUgbGFzdFJlYXNvbmluZ1wiKTtcbiAgICBhc3NlcnQub2sodHJhY2UubGFzdFJlYXNvbmluZy5pbmNsdWRlcyhcImFsbCBmaWxlcyB3cml0dGVuXCIpLFxuICAgICAgXCJsYXN0UmVhc29uaW5nIHNob3VsZCBjb250YWluIHRoZSBsYXN0IGFzc2lzdGFudCB0ZXh0XCIpO1xuICB9KTtcblxuICB0ZXN0KFwiZ2V0RGVlcERpYWdub3N0aWMgb3V0cHV0IGRvZXMgTk9UIGNvbnRhaW4gbGFzdFJlYXNvbmluZ1wiLCAoKSA9PiB7XG4gICAgLy8gQ3JlYXRlIGEgdGVtcG9yYXJ5IGFjdGl2aXR5IGRpcmVjdG9yeSB3aXRoIGEgSlNPTkwgZmlsZVxuICAgIGNvbnN0IHRlbXBCYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZGlhZy10ZXN0LVwiKSk7XG4gICAgY29uc3QgZ3NkRGlyID0gam9pbih0ZW1wQmFzZSwgXCIuZ3NkXCIpO1xuICAgIGNvbnN0IGFjdGl2aXR5RGlyID0gam9pbihnc2REaXIsIFwiYWN0aXZpdHlcIik7XG4gICAgbWtkaXJTeW5jKGFjdGl2aXR5RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIHRyeSB7XG4gICAgICAvLyBCdWlsZCBlbnRyaWVzIHdpdGggYm90aCB0b29sIGNhbGxzIGFuZCBhc3Npc3RhbnQgcmVhc29uaW5nXG4gICAgICBjb25zdCBlbnRyaWVzID0gW1xuICAgICAgICBtYWtlQXNzaXN0YW50VGV4dChcIkxldCBtZSBhbmFseXplIHRoZSBjb2RlYmFzZSBzdHJ1Y3R1cmUgZmlyc3RcIiksXG4gICAgICAgIC4uLm1ha2VUb29sUGFpcihcImJhc2hcIiwgeyBjb21tYW5kOiBcImxzIHNyYy9cIiB9LCBcImluZGV4LnRzXFxudXRpbHMudHNcIiwgZmFsc2UpLFxuICAgICAgICBtYWtlQXNzaXN0YW50VGV4dChcIkkgc2VlIHRoZSBtaWxlc3RvbmUvTTAwMSBicmFuY2ggaGFzIGEgc2lnbmlmaWNhbnRseSBkaWZmZXJlbnQgLi4uIDMuIFwiKSxcbiAgICAgIF07XG5cbiAgICAgIC8vIFdyaXRlIEpTT05MIGFjdGl2aXR5IGZpbGVcbiAgICAgIGNvbnN0IGpzb25sID0gZW50cmllcy5tYXAoZSA9PiBKU09OLnN0cmluZ2lmeShlKSkuam9pbihcIlxcblwiKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihhY3Rpdml0eURpciwgXCIyMDI1LTAxLTAxVDAwLTAwLTAwLmpzb25sXCIpLCBqc29ubCk7XG5cbiAgICAgIGNvbnN0IGRpYWdub3N0aWMgPSBnZXREZWVwRGlhZ25vc3RpYyh0ZW1wQmFzZSk7XG5cbiAgICAgIC8vIERpYWdub3N0aWMgc2hvdWxkIGV4aXN0ICh3ZSBoYXZlIHRvb2wgY2FsbHMpXG4gICAgICBhc3NlcnQub2soZGlhZ25vc3RpYyAhPT0gbnVsbCwgXCJkaWFnbm9zdGljIHNob3VsZCBub3QgYmUgbnVsbFwiKTtcblxuICAgICAgLy8gRGlhZ25vc3RpYyBzaG91bGQgY29udGFpbiBzdHJ1Y3R1cmVkIGV4ZWN1dGlvbiBldmlkZW5jZVxuICAgICAgYXNzZXJ0Lm9rKGRpYWdub3N0aWMhLmluY2x1ZGVzKFwiVG9vbCBjYWxscyBjb21wbGV0ZWQ6XCIpLFxuICAgICAgICBcInNob3VsZCBpbmNsdWRlIHRvb2wgY2FsbCBjb3VudFwiKTtcbiAgICAgIGFzc2VydC5vayhkaWFnbm9zdGljIS5pbmNsdWRlcyhcImxzIHNyYy9cIiksXG4gICAgICAgIFwic2hvdWxkIGluY2x1ZGUgY29tbWFuZHMgcnVuXCIpO1xuXG4gICAgICAvLyBEaWFnbm9zdGljIG11c3QgTk9UIGNvbnRhaW4gdGhlIGFzc2lzdGFudCdzIGZyZWUtdGV4dCByZWFzb25pbmdcbiAgICAgIGFzc2VydC5vayghZGlhZ25vc3RpYyEuaW5jbHVkZXMoXCJMYXN0IHJlYXNvbmluZ1wiKSxcbiAgICAgICAgXCJkaWFnbm9zdGljIG11c3Qgbm90IGluY2x1ZGUgJ0xhc3QgcmVhc29uaW5nJyBsYWJlbFwiKTtcbiAgICAgIGFzc2VydC5vayghZGlhZ25vc3RpYyEuaW5jbHVkZXMoXCJhbmFseXplIHRoZSBjb2RlYmFzZVwiKSxcbiAgICAgICAgXCJkaWFnbm9zdGljIG11c3Qgbm90IGluY2x1ZGUgcHJpb3IgYXNzaXN0YW50IHRleHRcIik7XG4gICAgICBhc3NlcnQub2soIWRpYWdub3N0aWMhLmluY2x1ZGVzKFwic2lnbmlmaWNhbnRseSBkaWZmZXJlbnRcIiksXG4gICAgICAgIFwiZGlhZ25vc3RpYyBtdXN0IG5vdCBpbmNsdWRlIHRydW5jYXRlZCBhc3Npc3RhbnQgcmVhc29uaW5nXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModGVtcEJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJnZXREZWVwRGlhZ25vc3RpYyBzdGlsbCBpbmNsdWRlcyBlcnJvcnMgYW5kIGZpbGUgb3BlcmF0aW9uc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgdGVtcEJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1kaWFnLXRlc3QtXCIpKTtcbiAgICBjb25zdCBnc2REaXIgPSBqb2luKHRlbXBCYXNlLCBcIi5nc2RcIik7XG4gICAgY29uc3QgYWN0aXZpdHlEaXIgPSBqb2luKGdzZERpciwgXCJhY3Rpdml0eVwiKTtcbiAgICBta2RpclN5bmMoYWN0aXZpdHlEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVudHJpZXMgPSBbXG4gICAgICAgIG1ha2VBc3Npc3RhbnRUZXh0KFwiV3JpdGluZyB0aGUgcGxhbiBmaWxlXCIpLFxuICAgICAgICAuLi5tYWtlVG9vbFBhaXIoXCJ3cml0ZVwiLCB7IHBhdGg6IFwiTTAwMS9TMDEvUzAxLVBMQU4ubWRcIiB9LCBcIm9rXCIsIGZhbHNlKSxcbiAgICAgICAgLi4ubWFrZVRvb2xQYWlyKFwiYmFzaFwiLCB7IGNvbW1hbmQ6IFwibnBtIHJ1biBidWlsZFwiIH0sIFwiRXJyb3I6IHR5cGUgbWlzbWF0Y2hcIiwgdHJ1ZSksXG4gICAgICAgIG1ha2VBc3Npc3RhbnRUZXh0KFwiVGhlIGJ1aWxkIGZhaWxlZCwgbGV0IG1lIGludmVzdGlnYXRlXCIpLFxuICAgICAgXTtcblxuICAgICAgY29uc3QganNvbmwgPSBlbnRyaWVzLm1hcChlID0+IEpTT04uc3RyaW5naWZ5KGUpKS5qb2luKFwiXFxuXCIpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGFjdGl2aXR5RGlyLCBcIjIwMjUtMDEtMDFUMDAtMDAtMDAuanNvbmxcIiksIGpzb25sKTtcblxuICAgICAgY29uc3QgZGlhZ25vc3RpYyA9IGdldERlZXBEaWFnbm9zdGljKHRlbXBCYXNlKTtcbiAgICAgIGFzc2VydC5vayhkaWFnbm9zdGljICE9PSBudWxsKTtcblxuICAgICAgLy8gU3RydWN0dXJlZCBldmlkZW5jZSBzaG91bGQgYmUgcHJlc2VudFxuICAgICAgYXNzZXJ0Lm9rKGRpYWdub3N0aWMhLmluY2x1ZGVzKFwiUzAxLVBMQU4ubWRcIiksXG4gICAgICAgIFwic2hvdWxkIGluY2x1ZGUgZmlsZXMgd3JpdHRlblwiKTtcbiAgICAgIGFzc2VydC5vayhkaWFnbm9zdGljIS5pbmNsdWRlcyhcIm5wbSBydW4gYnVpbGRcIiksXG4gICAgICAgIFwic2hvdWxkIGluY2x1ZGUgY29tbWFuZHMgcnVuXCIpO1xuICAgICAgYXNzZXJ0Lm9rKGRpYWdub3N0aWMhLmluY2x1ZGVzKFwidHlwZSBtaXNtYXRjaFwiKSxcbiAgICAgICAgXCJzaG91bGQgaW5jbHVkZSBlcnJvcnNcIik7XG5cbiAgICAgIC8vIEJ1dCBOT1QgdGhlIGFzc2lzdGFudCdzIGZyZWUtdGV4dFxuICAgICAgYXNzZXJ0Lm9rKCFkaWFnbm9zdGljIS5pbmNsdWRlcyhcIldyaXRpbmcgdGhlIHBsYW5cIiksXG4gICAgICAgIFwibXVzdCBub3QgaW5jbHVkZSBhc3Npc3RhbnQgcmVhc29uaW5nXCIpO1xuICAgICAgYXNzZXJ0Lm9rKCFkaWFnbm9zdGljIS5pbmNsdWRlcyhcImJ1aWxkIGZhaWxlZFwiKSxcbiAgICAgICAgXCJtdXN0IG5vdCBpbmNsdWRlIGFzc2lzdGFudCByZWFzb25pbmcgYWJvdXQgZmFpbHVyZXNcIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0ZW1wQmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVVBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsZUFBZSxRQUFRLG1CQUFtQjtBQUM5RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMsY0FBYyx5QkFBeUI7QUFHaEQsU0FBUyxrQkFBa0IsTUFBdUI7QUFDaEQsU0FBTztBQUFBLElBQ0wsTUFBTTtBQUFBLElBQ04sU0FBUztBQUFBLE1BQ1AsTUFBTTtBQUFBLE1BQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLEtBQUssQ0FBQztBQUFBLElBQ2xDO0FBQUEsRUFDRjtBQUNGO0FBR0EsU0FBUyxhQUNQLFVBQ0EsT0FDQSxZQUNBLFNBQ1c7QUFDWCxRQUFNLGFBQWEsU0FBUyxLQUFLLE9BQU8sRUFBRSxTQUFTLEVBQUUsRUFBRSxNQUFNLEdBQUcsRUFBRSxDQUFDO0FBQ25FLFNBQU87QUFBQSxJQUNMO0FBQUEsTUFDRSxNQUFNO0FBQUEsTUFDTixTQUFTO0FBQUEsUUFDUCxNQUFNO0FBQUEsUUFDTixTQUFTO0FBQUEsVUFDUDtBQUFBLFlBQ0UsTUFBTTtBQUFBLFlBQ04sSUFBSTtBQUFBLFlBQ0osTUFBTTtBQUFBLFlBQ04sV0FBVztBQUFBLFVBQ2I7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxJQUNBO0FBQUEsTUFDRSxNQUFNO0FBQUEsTUFDTixTQUFTO0FBQUEsUUFDUCxNQUFNO0FBQUEsUUFDTjtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQSxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxXQUFXLENBQUM7QUFBQSxNQUM5QztBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0Y7QUFFQSxTQUFTLG1EQUFtRCxNQUFNO0FBQ2hFLE9BQUssaUVBQWlFLE1BQU07QUFDMUUsVUFBTSxVQUFVO0FB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
