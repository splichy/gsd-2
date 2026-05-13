import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setAutoActiveForTest } from "../auto.js";
import { buildCompleteMilestonePrompt, buildCompleteSlicePrompt } from "../auto-prompts.js";
import { registerHooks } from "../bootstrap/register-hooks.js";
function makePromptBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-prompt-order-"));
  const msDir = join(base, ".gsd", "milestones", "M001");
  const sliceDir = join(msDir, "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });
  writeFileSync(
    join(msDir, "M001-ROADMAP.md"),
    "# Roadmap\n\n## Slices\n\n- [x] **S01: Done** `risk:low` `depends:[]`\n"
  );
  writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01 Plan\n\n## Tasks\n\n- T01\n");
  writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\n\nDone.\n");
  return base;
}
function numberedStepIndex(prompt, needle) {
  const lines = prompt.split("\n");
  const idx = lines.findIndex((line) => /^\d+\.\s/.test(line) && needle.test(line));
  assert.notEqual(idx, -1, `missing numbered step matching ${needle}`);
  return idx;
}
describe("prompt step ordering (#3696)", () => {
  test("complete-milestone prompt orders durable writes before gsd_complete_milestone", async () => {
    const base = makePromptBase();
    try {
      const prompt = await buildCompleteMilestonePrompt("M001", "Milestone", base, "minimal");
      const guardIdx = numberedStepIndex(prompt, /gsd_milestone_status/);
      const requirementIdx = numberedStepIndex(prompt, /gsd_requirement_update/);
      const projectIdx = numberedStepIndex(prompt, /PROJECT\.md/);
      const learningsIdx = numberedStepIndex(prompt, /Extract structured learnings/);
      const completeIdx = numberedStepIndex(prompt, /gsd_complete_milestone/);
      assert.ok(guardIdx < requirementIdx);
      assert.ok(requirementIdx < completeIdx);
      assert.ok(projectIdx < completeIdx);
      assert.ok(learningsIdx < completeIdx);
      assert.match(prompt, /status(?:`|\*\*)?\s+(?:is\s+)?(?:`complete`|"complete")/i);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("complete-slice prompt exposes gsd_requirement_update", async () => {
    const base = makePromptBase();
    try {
      const prompt = await buildCompleteSlicePrompt("M001", "Milestone", "S01", "Done", base, "minimal");
      assert.match(prompt, /gsd_requirement_update/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
describe("register-hooks session_before_compact (#3696)", () => {
  test("registered hook cancels compaction only while auto-mode is active", async () => {
    const handlers = /* @__PURE__ */ new Map();
    registerHooks({
      on(event, handler) {
        handlers.set(event, handler);
      }
    }, []);
    const compact = handlers.get("session_before_compact");
    assert.ok(compact, "session_before_compact hook should be registered");
    _setAutoActiveForTest(true);
    try {
      const result = await compact({}, { cwd: mkdtempSync(join(tmpdir(), "gsd-compact-active-")), ui: { notify() {
      }, setWidget() {
      } } });
      assert.deepEqual(result, { cancel: true });
    } finally {
      _setAutoActiveForTest(false);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcm9tcHQtc3RlcC1vcmRlcmluZy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdHMgZm9yICMzNjk2IFx1MjAxNCBwcm9tcHQgc3RlcCBvcmRlcmluZyBhbmQgY29tcGFjdCBob29rIGJlaGF2aW9yLlxuICpcbiAqIFRoZXNlIHRlc3RzIGFzc2VydCByZW5kZXJlZCBwcm9tcHRzIGFuZCByZWdpc3RlcmVkIGhvb2sgYmVoYXZpb3IgaW5zdGVhZCBvZlxuICogcmVhZGluZyBzb3VyY2UgZmlsZXMgYXMgdGV4dC5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBta2RpclN5bmMsIG1rZHRlbXBTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5cbmltcG9ydCB7IF9zZXRBdXRvQWN0aXZlRm9yVGVzdCB9IGZyb20gJy4uL2F1dG8udHMnO1xuaW1wb3J0IHsgYnVpbGRDb21wbGV0ZU1pbGVzdG9uZVByb21wdCwgYnVpbGRDb21wbGV0ZVNsaWNlUHJvbXB0IH0gZnJvbSAnLi4vYXV0by1wcm9tcHRzLnRzJztcbmltcG9ydCB7IHJlZ2lzdGVySG9va3MgfSBmcm9tICcuLi9ib290c3RyYXAvcmVnaXN0ZXItaG9va3MudHMnO1xuXG5mdW5jdGlvbiBtYWtlUHJvbXB0QmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1wcm9tcHQtb3JkZXItJykpO1xuICBjb25zdCBtc0RpciA9IGpvaW4oYmFzZSwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJyk7XG4gIGNvbnN0IHNsaWNlRGlyID0gam9pbihtc0RpciwgJ3NsaWNlcycsICdTMDEnKTtcbiAgbWtkaXJTeW5jKHNsaWNlRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKG1zRGlyLCAnTTAwMS1ST0FETUFQLm1kJyksXG4gICAgJyMgUm9hZG1hcFxcblxcbiMjIFNsaWNlc1xcblxcbi0gW3hdICoqUzAxOiBEb25lKiogYHJpc2s6bG93YCBgZGVwZW5kczpbXWBcXG4nLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oc2xpY2VEaXIsICdTMDEtUExBTi5tZCcpLCAnIyBTMDEgUGxhblxcblxcbiMjIFRhc2tzXFxuXFxuLSBUMDFcXG4nKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHNsaWNlRGlyLCAnUzAxLVNVTU1BUlkubWQnKSwgJyMgUzAxIFN1bW1hcnlcXG5cXG5Eb25lLlxcbicpO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gbnVtYmVyZWRTdGVwSW5kZXgocHJvbXB0OiBzdHJpbmcsIG5lZWRsZTogUmVnRXhwKTogbnVtYmVyIHtcbiAgY29uc3QgbGluZXMgPSBwcm9tcHQuc3BsaXQoJ1xcbicpO1xuICBjb25zdCBpZHggPSBsaW5lcy5maW5kSW5kZXgoKGxpbmUpID0+IC9eXFxkK1xcLlxccy8udGVzdChsaW5lKSAmJiBuZWVkbGUudGVzdChsaW5lKSk7XG4gIGFzc2VydC5ub3RFcXVhbChpZHgsIC0xLCBgbWlzc2luZyBudW1iZXJlZCBzdGVwIG1hdGNoaW5nICR7bmVlZGxlfWApO1xuICByZXR1cm4gaWR4O1xufVxuXG5kZXNjcmliZSgncHJvbXB0IHN0ZXAgb3JkZXJpbmcgKCMzNjk2KScsICgpID0+IHtcbiAgdGVzdCgnY29tcGxldGUtbWlsZXN0b25lIHByb21wdCBvcmRlcnMgZHVyYWJsZSB3cml0ZXMgYmVmb3JlIGdzZF9jb21wbGV0ZV9taWxlc3RvbmUnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1ha2VQcm9tcHRCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHByb21wdCA9IGF3YWl0IGJ1aWxkQ29tcGxldGVNaWxlc3RvbmVQcm9tcHQoJ00wMDEnLCAnTWlsZXN0b25lJywgYmFzZSwgJ21pbmltYWwnKTtcbiAgICAgIGNvbnN0IGd1YXJkSWR4ID0gbnVtYmVyZWRTdGVwSW5kZXgocHJvbXB0LCAvZ3NkX21pbGVzdG9uZV9zdGF0dXMvKTtcbiAgICAgIGNvbnN0IHJlcXVpcmVtZW50SWR4ID0gbnVtYmVyZWRTdGVwSW5kZXgocHJvbXB0LCAvZ3NkX3JlcXVpcmVtZW50X3VwZGF0ZS8pO1xuICAgICAgY29uc3QgcHJvamVjdElkeCA9IG51bWJlcmVkU3RlcEluZGV4KHByb21wdCwgL1BST0pFQ1RcXC5tZC8pO1xuICAgICAgY29uc3QgbGVhcm5pbmdzSWR4ID0gbnVtYmVyZWRTdGVwSW5kZXgocHJvbXB0LCAvRXh0cmFjdCBzdHJ1Y3R1cmVkIGxlYXJuaW5ncy8pO1xuICAgICAgY29uc3QgY29tcGxldGVJZHggPSBudW1iZXJlZFN0ZXBJbmRleChwcm9tcHQsIC9nc2RfY29tcGxldGVfbWlsZXN0b25lLyk7XG5cbiAgICAgIGFzc2VydC5vayhndWFyZElkeCA8IHJlcXVpcmVtZW50SWR4KTtcbiAgICAgIGFzc2VydC5vayhyZXF1aXJlbWVudElkeCA8IGNvbXBsZXRlSWR4KTtcbiAgICAgIGFzc2VydC5vayhwcm9qZWN0SWR4IDwgY29tcGxldGVJZHgpO1xuICAgICAgYXNzZXJ0Lm9rKGxlYXJuaW5nc0lkeCA8IGNvbXBsZXRlSWR4KTtcbiAgICAgIGFzc2VydC5tYXRjaChwcm9tcHQsIC9zdGF0dXMoPzpgfFxcKlxcKik/XFxzKyg/OmlzXFxzKyk/KD86YGNvbXBsZXRlYHxcImNvbXBsZXRlXCIpL2kpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdCgnY29tcGxldGUtc2xpY2UgcHJvbXB0IGV4cG9zZXMgZ3NkX3JlcXVpcmVtZW50X3VwZGF0ZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVByb21wdEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcHJvbXB0ID0gYXdhaXQgYnVpbGRDb21wbGV0ZVNsaWNlUHJvbXB0KCdNMDAxJywgJ01pbGVzdG9uZScsICdTMDEnLCAnRG9uZScsIGJhc2UsICdtaW5pbWFsJyk7XG4gICAgICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvZ3NkX3JlcXVpcmVtZW50X3VwZGF0ZS8pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ3JlZ2lzdGVyLWhvb2tzIHNlc3Npb25fYmVmb3JlX2NvbXBhY3QgKCMzNjk2KScsICgpID0+IHtcbiAgdGVzdCgncmVnaXN0ZXJlZCBob29rIGNhbmNlbHMgY29tcGFjdGlvbiBvbmx5IHdoaWxlIGF1dG8tbW9kZSBpcyBhY3RpdmUnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgaGFuZGxlcnMgPSBuZXcgTWFwPHN0cmluZywgRnVuY3Rpb24+KCk7XG4gICAgcmVnaXN0ZXJIb29rcyh7XG4gICAgICBvbihldmVudDogc3RyaW5nLCBoYW5kbGVyOiBGdW5jdGlvbikge1xuICAgICAgICBoYW5kbGVycy5zZXQoZXZlbnQsIGhhbmRsZXIpO1xuICAgICAgfSxcbiAgICB9IGFzIGFueSwgW10pO1xuXG4gICAgY29uc3QgY29tcGFjdCA9IGhhbmRsZXJzLmdldCgnc2Vzc2lvbl9iZWZvcmVfY29tcGFjdCcpO1xuICAgIGFzc2VydC5vayhjb21wYWN0LCAnc2Vzc2lvbl9iZWZvcmVfY29tcGFjdCBob29rIHNob3VsZCBiZSByZWdpc3RlcmVkJyk7XG5cbiAgICBfc2V0QXV0b0FjdGl2ZUZvclRlc3QodHJ1ZSk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNvbXBhY3Qoe30sIHsgY3dkOiBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLWNvbXBhY3QtYWN0aXZlLScpKSwgdWk6IHsgbm90aWZ5KCkge30sIHNldFdpZGdldCgpIHt9IH0gfSk7XG4gICAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwgeyBjYW5jZWw6IHRydWUgfSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIF9zZXRBdXRvQWN0aXZlRm9yVGVzdChmYWxzZSk7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBT0EsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxhQUFhLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyw2QkFBNkI7QUFDdEMsU0FBUyw4QkFBOEIsZ0NBQWdDO0FBQ3ZFLFNBQVMscUJBQXFCO0FBRTlCLFNBQVMsaUJBQXlCO0FBQ2hDLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLG1CQUFtQixDQUFDO0FBQzVELFFBQU0sUUFBUSxLQUFLLE1BQU0sUUFBUSxjQUFjLE1BQU07QUFDckQsUUFBTSxXQUFXLEtBQUssT0FBTyxVQUFVLEtBQUs7QUFDNUMsWUFBVSxVQUFVLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkM7QUFBQSxJQUNFLEtBQUssT0FBTyxpQkFBaUI7QUFBQSxJQUM3QjtBQUFBLEVBQ0Y7QUFDQSxnQkFBYyxLQUFLLFVBQVUsYUFBYSxHQUFHLG1DQUFtQztBQUNoRixnQkFBYyxLQUFLLFVBQVUsZ0JBQWdCLEdBQUcsMEJBQTBCO0FBQzFFLFNBQU87QUFDVDtBQUVBLFNBQVMsa0JBQWtCLFFBQWdCLFFBQXdCO0FBQ2pFLFFBQU0sUUFBUSxPQUFPLE1BQU0sSUFBSTtBQUMvQixRQUFNLE1BQU0sTUFBTSxVQUFVLENBQUMsU0FBUyxXQUFXLEtBQUssSUFBSSxLQUFLLE9BQU8sS0FBSyxJQUFJLENBQUM7QUFDaEYsU0FBTyxTQUFTLEtBQUssSUFBSSxrQ0FBa0MsTUFBTSxFQUFFO0FBQ25FLFNBQU87QUFDVDtBQUVBLFNBQVMsZ0NBQWdDLE1BQU07QUFDN0MsT0FBSyxpRkFBaUYsWUFBWTtBQUNoRyxVQUFNLE9BQU8sZUFBZTtBQUM1QixRQUFJO0FBQ0YsWUFBTSxTQUFTLE1BQU0sNkJBQTZCLFFBQVEsYUFBYSxNQUFNLFNBQVM7QUFDdEYsWUFBTSxXQUFXLGtCQUFrQixRQUFRLHNCQUFzQjtBQUNqRSxZQUFNLGlCQUFpQixrQkFBa0IsUUFBUSx3QkFBd0I7QUFDekUsWUFBTSxhQUFhLGtCQUFrQixRQUFRLGFBQWE7QUFDMUQsWUFBTSxlQUFlLGtCQUFrQixRQUFRLDhCQUE4QjtBQUM3RSxZQUFNLGNBQWMsa0JBQWtCLFFBQVEsd0JBQXdCO0FBRXRFLGFBQU8sR0FBRyxXQUFXLGNBQWM7QUFDbkMsYUFBTyxHQUFHLGlCQUFpQixXQUFXO0FBQ3RDLGFBQU8sR0FBRyxhQUFhLFdBQVc7QUFDbEMsYUFBTyxHQUFHLGVBQWUsV0FBVztBQUNwQyxhQUFPLE1BQU0sUUFBUSwwREFBMEQ7QUFBQSxJQUNqRixVQUFFO0FBQ0EsYUFBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDL0M7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHdEQUF3RCxZQUFZO0FBQ3ZFLFVBQU0sT0FBTyxlQUFlO0FBQzVCLFFBQUk7QUFDRixZQUFNLFNBQVMsTUFBTSx5QkFBeUIsUUFBUSxhQUFhLE9BQU8sUUFBUSxNQUFNLFNBQVM7QUFDakcsYUFBTyxNQUFNLFFBQVEsd0JBQXdCO0FBQUEsSUFDL0MsVUFBRTtBQUNBLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQztBQUVELFNBQVMsaURBQWlELE1BQU07QUFDOUQsT0FBSyxxRUFBcUUsWUFBWTtBQUNwRixVQUFNLFdBQVcsb0JBQUksSUFBc0I7QUFDM0Msa0JBQWM7QUFBQSxNQUNaLEdBQUcsT0FBZSxTQUFtQjtBQUNuQyxpQkFBUyxJQUFJLE9BQU8sT0FBTztBQUFBLE1BQzdCO0FBQUEsSUFDRixHQUFVLENBQUMsQ0FBQztBQUVaLFVBQU0sVUFBVSxTQUFTLElBQUksd0JBQXdCO0FBQ3JELFdBQU8sR0FBRyxTQUFTLGtEQUFrRDtBQUVyRSwwQkFBc0IsSUFBSTtBQUMxQixRQUFJO0FBQ0YsWUFBTSxTQUFTLE1BQU0sUUFBUSxDQUFDLEdBQUcsRUFBRSxLQUFLLFlBQVksS0FBSyxPQUFPLEdBQUcscUJBQXFCLENBQUMsR0FBRyxJQUFJLEVBQUUsU0FBUztBQUFBLE1BQUMsR0FBRyxZQUFZO0FBQUEsTUFBQyxFQUFFLEVBQUUsQ0FBQztBQUNqSSxhQUFPLFVBQVUsUUFBUSxFQUFFLFFBQVEsS0FBSyxDQUFDO0FBQUEsSUFDM0MsVUFBRTtBQUNBLDRCQUFzQixLQUFLO0FBQUEsSUFDN0I7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
