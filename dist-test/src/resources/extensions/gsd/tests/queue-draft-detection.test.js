import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveState } from "../state.js";
import { buildExistingMilestonesContext } from "../guided-flow.js";
import { extractSourceRegion } from "./test-helpers.js";
describe("queue-draft-detection", () => {
  test("draft and context milestone detection", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "gsd-queue-draft-test-"));
    const gsd = join(tmpBase, ".gsd");
    try {
      mkdirSync(join(gsd, "milestones", "M001"), { recursive: true });
      writeFileSync(
        join(gsd, "milestones", "M001", "M001-CONTEXT-DRAFT.md"),
        "# M001: Draft Milestone\n\nSeed material from prior discussion.\n"
      );
      mkdirSync(join(gsd, "milestones", "M002"), { recursive: true });
      writeFileSync(
        join(gsd, "milestones", "M002", "M002-CONTEXT.md"),
        "# M002: Ready Milestone\n\nFull context from deep discussion.\n"
      );
      mkdirSync(join(gsd, "milestones", "M003"), { recursive: true });
      writeFileSync(
        join(gsd, "milestones", "M003", "M003-CONTEXT.md"),
        "# M003: Full Context\n\nThis is the real context.\n"
      );
      writeFileSync(
        join(gsd, "milestones", "M003", "M003-CONTEXT-DRAFT.md"),
        "# M003: Draft\n\nThis should be ignored.\n"
      );
      mkdirSync(join(gsd, "milestones", "M004"), { recursive: true });
      const state = await deriveState(tmpBase);
      const milestoneIds = ["M001", "M002", "M003", "M004"];
      const context = await buildExistingMilestonesContext(tmpBase, milestoneIds, state);
      assert.ok(
        context.includes("Draft context available"),
        "M001 (draft-only) should include 'Draft context available' label"
      );
      assert.ok(
        context.includes("Seed material from prior discussion"),
        "M001 draft content should be included in context output"
      );
      assert.ok(
        context.includes("**Context:**"),
        "M002 (full context) should use 'Context:' label"
      );
      assert.ok(
        context.includes("Full context from deep discussion"),
        "M002 context content should be included"
      );
      const m003Idx = context.indexOf("M003:");
      const m003Section = extractSourceRegion(context, "M003:");
      assert.ok(
        m003Section.includes("**Context:**"),
        "M003 (both files) should use 'Context:' label (CONTEXT.md wins)"
      );
      assert.ok(
        !m003Section.includes("Draft context available"),
        "M003 (both files) should NOT show draft label \u2014 CONTEXT.md takes precedence"
      );
      assert.ok(
        m003Section.includes("This is the real context"),
        "M003 should show CONTEXT.md content, not draft content"
      );
      const m004Idx = context.indexOf("M004:");
      const m004Section = extractSourceRegion(context, "M004:");
      assert.ok(
        !m004Section.includes("**Context:**"),
        "M004 (neither file) should not have Context: label"
      );
      assert.ok(
        !m004Section.includes("Draft context available"),
        "M004 (neither file) should not have Draft label"
      );
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9xdWV1ZS1kcmFmdC1kZXRlY3Rpb24udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBkZXJpdmVTdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHsgYnVpbGRFeGlzdGluZ01pbGVzdG9uZXNDb250ZXh0IH0gZnJvbSBcIi4uL2d1aWRlZC1mbG93LmpzXCI7XG5pbXBvcnQgeyBleHRyYWN0U291cmNlUmVnaW9uIH0gZnJvbSBcIi4vdGVzdC1oZWxwZXJzLnRzXCI7XG5cbmRlc2NyaWJlKCdxdWV1ZS1kcmFmdC1kZXRlY3Rpb24nLCAoKSA9PiB7XG4gIHRlc3QoJ2RyYWZ0IGFuZCBjb250ZXh0IG1pbGVzdG9uZSBkZXRlY3Rpb24nLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wQmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXF1ZXVlLWRyYWZ0LXRlc3QtXCIpKTtcbiAgICBjb25zdCBnc2QgPSBqb2luKHRtcEJhc2UsIFwiLmdzZFwiKTtcblxuICAgIHRyeSB7XG4gICAgICAvLyBNMDAxOiBoYXMgb25seSBDT05URVhULURSQUZULm1kIChkcmFmdCBtaWxlc3RvbmUpXG4gICAgICBta2RpclN5bmMoam9pbihnc2QsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhcbiAgICAgICAgam9pbihnc2QsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLUNPTlRFWFQtRFJBRlQubWRcIiksXG4gICAgICAgIFwiIyBNMDAxOiBEcmFmdCBNaWxlc3RvbmVcXG5cXG5TZWVkIG1hdGVyaWFsIGZyb20gcHJpb3IgZGlzY3Vzc2lvbi5cXG5cIixcbiAgICAgICk7XG5cbiAgICAgIC8vIE0wMDI6IGhhcyBmdWxsIENPTlRFWFQubWQgKHJlYWR5IG1pbGVzdG9uZSlcbiAgICAgIG1rZGlyU3luYyhqb2luKGdzZCwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMlwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKGdzZCwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMlwiLCBcIk0wMDItQ09OVEVYVC5tZFwiKSxcbiAgICAgICAgXCIjIE0wMDI6IFJlYWR5IE1pbGVzdG9uZVxcblxcbkZ1bGwgY29udGV4dCBmcm9tIGRlZXAgZGlzY3Vzc2lvbi5cXG5cIixcbiAgICAgICk7XG5cbiAgICAgIC8vIE0wMDM6IGhhcyBib3RoIENPTlRFWFQubWQgYW5kIENPTlRFWFQtRFJBRlQubWQgKENPTlRFWFQgd2lucylcbiAgICAgIG1rZGlyU3luYyhqb2luKGdzZCwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwM1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKGdzZCwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwM1wiLCBcIk0wMDMtQ09OVEVYVC5tZFwiKSxcbiAgICAgICAgXCIjIE0wMDM6IEZ1bGwgQ29udGV4dFxcblxcblRoaXMgaXMgdGhlIHJlYWwgY29udGV4dC5cXG5cIixcbiAgICAgICk7XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKGdzZCwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwM1wiLCBcIk0wMDMtQ09OVEVYVC1EUkFGVC5tZFwiKSxcbiAgICAgICAgXCIjIE0wMDM6IERyYWZ0XFxuXFxuVGhpcyBzaG91bGQgYmUgaWdub3JlZC5cXG5cIixcbiAgICAgICk7XG5cbiAgICAgIC8vIE0wMDQ6IGhhcyBuZWl0aGVyIChlbXB0eSBtaWxlc3RvbmUgZGlyKVxuICAgICAgbWtkaXJTeW5jKGpvaW4oZ3NkLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDA0XCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgICAgLy8gQnVpbGQgY29udGV4dFxuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZSh0bXBCYXNlKTtcbiAgICAgIGNvbnN0IG1pbGVzdG9uZUlkcyA9IFtcIk0wMDFcIiwgXCJNMDAyXCIsIFwiTTAwM1wiLCBcIk0wMDRcIl07XG4gICAgICBjb25zdCBjb250ZXh0ID0gYXdhaXQgYnVpbGRFeGlzdGluZ01pbGVzdG9uZXNDb250ZXh0KHRtcEJhc2UsIG1pbGVzdG9uZUlkcywgc3RhdGUpO1xuXG4gICAgICAvLyBkcmFmdC1vbmx5IG1pbGVzdG9uZSBpbmNsdWRlcyBcIkRyYWZ0IGNvbnRleHQgYXZhaWxhYmxlXCJcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgY29udGV4dC5pbmNsdWRlcyhcIkRyYWZ0IGNvbnRleHQgYXZhaWxhYmxlXCIpLFxuICAgICAgICBcIk0wMDEgKGRyYWZ0LW9ubHkpIHNob3VsZCBpbmNsdWRlICdEcmFmdCBjb250ZXh0IGF2YWlsYWJsZScgbGFiZWxcIixcbiAgICAgICk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGNvbnRleHQuaW5jbHVkZXMoXCJTZWVkIG1hdGVyaWFsIGZyb20gcHJpb3IgZGlzY3Vzc2lvblwiKSxcbiAgICAgICAgXCJNMDAxIGRyYWZ0IGNvbnRlbnQgc2hvdWxkIGJlIGluY2x1ZGVkIGluIGNvbnRleHQgb3V0cHV0XCIsXG4gICAgICApO1xuXG4gICAgICAvLyBmdWxsLWNvbnRleHQgbWlsZXN0b25lIHVzZXMgXCJDb250ZXh0OlwiIGxhYmVsXG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGNvbnRleHQuaW5jbHVkZXMoXCIqKkNvbnRleHQ6KipcIiksXG4gICAgICAgIFwiTTAwMiAoZnVsbCBjb250ZXh0KSBzaG91bGQgdXNlICdDb250ZXh0OicgbGFiZWxcIixcbiAgICAgICk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGNvbnRleHQuaW5jbHVkZXMoXCJGdWxsIGNvbnRleHQgZnJvbSBkZWVwIGRpc2N1c3Npb25cIiksXG4gICAgICAgIFwiTTAwMiBjb250ZXh0IGNvbnRlbnQgc2hvdWxkIGJlIGluY2x1ZGVkXCIsXG4gICAgICApO1xuXG4gICAgICAvLyBib3RoIGZpbGVzOiBDT05URVhULm1kIHdpbnMsIG5vIGRyYWZ0IGxhYmVsXG4gICAgICBjb25zdCBtMDAzSWR4ID0gY29udGV4dC5pbmRleE9mKFwiTTAwMzpcIik7XG4gICAgICBjb25zdCBtMDAzU2VjdGlvbiA9IGV4dHJhY3RTb3VyY2VSZWdpb24oY29udGV4dCwgXCJNMDAzOlwiKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgbTAwM1NlY3Rpb24uaW5jbHVkZXMoXCIqKkNvbnRleHQ6KipcIiksXG4gICAgICAgIFwiTTAwMyAoYm90aCBmaWxlcykgc2hvdWxkIHVzZSAnQ29udGV4dDonIGxhYmVsIChDT05URVhULm1kIHdpbnMpXCIsXG4gICAgICApO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICAhbTAwM1NlY3Rpb24uaW5jbHVkZXMoXCJEcmFmdCBjb250ZXh0IGF2YWlsYWJsZVwiKSxcbiAgICAgICAgXCJNMDAzIChib3RoIGZpbGVzKSBzaG91bGQgTk9UIHNob3cgZHJhZnQgbGFiZWwgXHUyMDE0IENPTlRFWFQubWQgdGFrZXMgcHJlY2VkZW5jZVwiLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgbTAwM1NlY3Rpb24uaW5jbHVkZXMoXCJUaGlzIGlzIHRoZSByZWFsIGNvbnRleHRcIiksXG4gICAgICAgIFwiTTAwMyBzaG91bGQgc2hvdyBDT05URVhULm1kIGNvbnRlbnQsIG5vdCBkcmFmdCBjb250ZW50XCIsXG4gICAgICApO1xuXG4gICAgICAvLyBuZWl0aGVyIGZpbGU6IG5vIGNvbnRleHQgc2VjdGlvblxuICAgICAgY29uc3QgbTAwNElkeCA9IGNvbnRleHQuaW5kZXhPZihcIk0wMDQ6XCIpO1xuICAgICAgY29uc3QgbTAwNFNlY3Rpb24gPSBleHRyYWN0U291cmNlUmVnaW9uKGNvbnRleHQsIFwiTTAwNDpcIik7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgICFtMDA0U2VjdGlvbi5pbmNsdWRlcyhcIioqQ29udGV4dDoqKlwiKSxcbiAgICAgICAgXCJNMDA0IChuZWl0aGVyIGZpbGUpIHNob3VsZCBub3QgaGF2ZSBDb250ZXh0OiBsYWJlbFwiLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgIW0wMDRTZWN0aW9uLmluY2x1ZGVzKFwiRHJhZnQgY29udGV4dCBhdmFpbGFibGVcIiksXG4gICAgICAgIFwiTTAwNCAobmVpdGhlciBmaWxlKSBzaG91bGQgbm90IGhhdmUgRHJhZnQgbGFiZWxcIixcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0bXBCYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyxzQ0FBc0M7QUFDL0MsU0FBUywyQkFBMkI7QUFFcEMsU0FBUyx5QkFBeUIsTUFBTTtBQUN0QyxPQUFLLHlDQUF5QyxZQUFZO0FBQ3hELFVBQU0sVUFBVSxZQUFZLEtBQUssT0FBTyxHQUFHLHVCQUF1QixDQUFDO0FBQ25FLFVBQU0sTUFBTSxLQUFLLFNBQVMsTUFBTTtBQUVoQyxRQUFJO0FBRUYsZ0JBQVUsS0FBSyxLQUFLLGNBQWMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDOUQ7QUFBQSxRQUNFLEtBQUssS0FBSyxjQUFjLFFBQVEsdUJBQXVCO0FBQUEsUUFDdkQ7QUFBQSxNQUNGO0FBR0EsZ0JBQVUsS0FBSyxLQUFLLGNBQWMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDOUQ7QUFBQSxRQUNFLEtBQUssS0FBSyxjQUFjLFFBQVEsaUJBQWlCO0FBQUEsUUFDakQ7QUFBQSxNQUNGO0FBR0EsZ0JBQVUsS0FBSyxLQUFLLGNBQWMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDOUQ7QUFBQSxRQUNFLEtBQUssS0FBSyxjQUFjLFFBQVEsaUJBQWlCO0FBQUEsUUFDakQ7QUFBQSxNQUNGO0FBQ0E7QUFBQSxRQUNFLEtBQUssS0FBSyxjQUFjLFFBQVEsdUJBQXVCO0FBQUEsUUFDdkQ7QUFBQSxNQUNGO0FBR0EsZ0JBQVUsS0FBSyxLQUFLLGNBQWMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFHOUQsWUFBTSxRQUFRLE1BQU0sWUFBWSxPQUFPO0FBQ3ZDLFlBQU0sZUFBZSxDQUFDLFFBQVEsUUFBUSxRQUFRLE1BQU07QUFDcEQsWUFBTSxVQUFVLE1BQU0sK0JBQStCLFNBQVMsY0FBYyxLQUFLO0FBR2pGLGFBQU87QUFBQSxRQUNMLFFBQVEsU0FBUyx5QkFBeUI7QUFBQSxRQUMxQztBQUFBLE1BQ0Y7QUFDQSxhQUFPO0FBQUEsUUFDTCxRQUFRLFNBQVMscUNBQXFDO0FBQUEsUUFDdEQ7QUFBQSxNQUNGO0FBR0EsYUFBTztBQUFBLFFBQ0wsUUFBUSxTQUFTLGNBQWM7QUFBQSxRQUMvQjtBQUFBLE1BQ0Y7QUFDQSxhQUFPO0FBQUEsUUFDTCxRQUFRLFNBQVMsbUNBQW1DO0FBQUEsUUFDcEQ7QUFBQSxNQUNGO0FBR0EsWUFBTSxVQUFVLFFBQVEsUUFBUSxPQUFPO0FBQ3ZDLFlBQU0sY0FBYyxvQkFBb0IsU0FBUyxPQUFPO0FBQ3hELGFBQU87QUFBQSxRQUNMLFlBQVksU0FBUyxjQUFjO0FBQUEsUUFDbkM7QUFBQSxNQUNGO0FBQ0EsYUFBTztBQUFBLFFBQ0wsQ0FBQyxZQUFZLFNBQVMseUJBQXlCO0FBQUEsUUFDL0M7QUFBQSxNQUNGO0FBQ0EsYUFBTztBQUFBLFFBQ0wsWUFBWSxTQUFTLDBCQUEwQjtBQUFBLFFBQy9DO0FBQUEsTUFDRjtBQUdBLFlBQU0sVUFBVSxRQUFRLFFBQVEsT0FBTztBQUN2QyxZQUFNLGNBQWMsb0JBQW9CLFNBQVMsT0FBTztBQUN4RCxhQUFPO0FBQUEsUUFDTCxDQUFDLFlBQVksU0FBUyxjQUFjO0FBQUEsUUFDcEM7QUFBQSxNQUNGO0FBQ0EsYUFBTztBQUFBLFFBQ0wsQ0FBQyxZQUFZLFNBQVMseUJBQXlCO0FBQUEsUUFDL0M7QUFBQSxNQUNGO0FBQUEsSUFDRixVQUFFO0FBQ0EsYUFBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDbEQ7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
