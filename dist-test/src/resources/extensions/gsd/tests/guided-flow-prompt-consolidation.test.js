import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExecuteTaskPrompt,
  buildCompleteSlicePrompt
} from "../auto-prompts.js";
const MID = "M001";
const SID = "S01";
const TID = "T01";
const M_TITLE = "Test milestone";
const S_TITLE = "Test slice";
const T_TITLE = "Test task";
describe("guided-flow \u2192 auto-prompts consolidation (#5183)", () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "gsd-prompt-consolidation-"));
    const sliceDir = join(base, ".gsd", "milestones", MID, "slices", SID);
    const tasksDir = join(sliceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(
      join(base, ".gsd", "milestones", MID, `${MID}-ROADMAP.md`),
      "# Roadmap\n- [ ] **S01: Test slice**\n"
    );
    writeFileSync(
      join(sliceDir, `${SID}-PLAN.md`),
      [
        "# Slice plan",
        "",
        "## Tasks",
        "- T01: Test task",
        "",
        "## Verification",
        "- All tests pass"
      ].join("\n")
    );
    writeFileSync(
      join(tasksDir, `${TID}-PLAN.md`),
      [
        "# Task plan",
        "",
        "## Steps",
        "1. Implement the thing",
        "",
        "## Must-haves",
        "- Working code"
      ].join("\n")
    );
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });
  test("buildExecuteTaskPrompt carries the execute-task contract", async () => {
    const prompt = await buildExecuteTaskPrompt(MID, SID, S_TITLE, TID, T_TITLE, base);
    assert.ok(prompt.includes(MID), "must mention milestone id");
    assert.ok(prompt.includes(SID), "must mention slice id");
    assert.ok(prompt.includes(TID), "must mention task id");
    assert.ok(prompt.includes(T_TITLE), "must mention task title");
    assert.ok(
      prompt.includes("gsd_task_complete"),
      "must instruct calling the canonical gsd_task_complete tool"
    );
    assert.ok(
      prompt.includes(base),
      "must bind the explicit working directory absolute path"
    );
    assert.ok(
      prompt.includes("Inlined Task Plan"),
      "must inline the task plan as the authoritative execution contract"
    );
    assert.ok(
      prompt.includes("Implement the thing"),
      "must include task plan body content from disk"
    );
    assert.ok(prompt.includes("## Context Mode"), "execute-task should include standalone Context Mode guidance");
    assert.ok(prompt.includes("execution lane"), "execute-task should render the execution lane");
  });
  test("buildExecuteTaskPrompt omits Context Mode when disabled", async () => {
    writeFileSync(
      join(base, ".gsd", "PREFERENCES.md"),
      ["---", "context_mode:", "  enabled: false", "---", ""].join("\n")
    );
    const prompt = await buildExecuteTaskPrompt(MID, SID, S_TITLE, TID, T_TITLE, base);
    assert.ok(!prompt.includes("## Context Mode"));
    assert.ok(!prompt.includes("Context Mode (execution lane)"));
  });
  test("buildCompleteSlicePrompt carries the complete-slice contract", async () => {
    const prompt = await buildCompleteSlicePrompt(MID, M_TITLE, SID, S_TITLE, base);
    assert.ok(prompt.includes(MID), "must mention milestone id");
    assert.ok(prompt.includes(SID), "must mention slice id");
    assert.ok(prompt.includes(S_TITLE), "must mention slice title");
    assert.ok(
      prompt.includes("gsd_slice_complete"),
      "must instruct calling gsd_slice_complete (was in guided-complete-slice.md)"
    );
    assert.ok(
      prompt.includes(base),
      "must bind the explicit working directory absolute path"
    );
    assert.ok(
      /Operational Readiness/i.test(prompt),
      "must reference Q8 Operational Readiness doctrine (backported from guided-complete-slice.md)"
    );
    assert.ok(
      /Slice Summary/i.test(prompt),
      "must reference the Slice Summary output template"
    );
    assert.ok(
      /UAT/.test(prompt),
      "must reference the UAT output template"
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9ndWlkZWQtZmxvdy1wcm9tcHQtY29uc29saWRhdGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEdTRDIgXHUyMDE0IHJlZ3Jlc3Npb24gdGVzdCBmb3IgIzUxODM6IHByb21wdCBjb25zb2xpZGF0aW9uLlxuICpcbiAqIFRoZSBQUiByZW1vdmVkIGBndWlkZWQtZXhlY3V0ZS10YXNrLm1kYCBhbmQgYGd1aWRlZC1jb21wbGV0ZS1zbGljZS5tZGAgYW5kXG4gKiByb3V0ZWQgYGd1aWRlZC1mbG93LnRzYCBjYWxsZXJzIHRvIGBidWlsZEV4ZWN1dGVUYXNrUHJvbXB0YCAvXG4gKiBgYnVpbGRDb21wbGV0ZVNsaWNlUHJvbXB0YCBmcm9tIGBhdXRvLXByb21wdHMudHNgLiBUaGlzIHRlc3QgZXhlcmNpc2VzIHRoZVxuICogY29uc29saWRhdGVkIGJ1aWxkZXJzIGFnYWluc3QgYSByZWFsIGZpeHR1cmUgYW5kIGFzc2VydHMgdGhleSBwcm9kdWNlXG4gKiBwcm9tcHRzIGNhcnJ5aW5nIHRoZSBjb250cmFjdCB0aGUgZGVsZXRlZCB2YXJpYW50cyB1c2VkIHRvIGVuZm9yY2U6XG4gKiAgIC0gdGhlIGNhbm9uaWNhbCBgZ3NkXypfY29tcGxldGVgIHRvb2wgcmVmZXJlbmNlLFxuICogICAtIHRoZSBleHBsaWNpdCB3b3JraW5nIGRpcmVjdG9yeSBiaW5kaW5nLFxuICogICAtIHRoZSB1bml0IGlkZW50aWZpZXJzIChtaWxlc3RvbmUvc2xpY2UvdGFzayksXG4gKiAgIC0gdGhlIHF1YWxpdHktZ2F0ZSBkb2N0cmluZSB0aGF0IHdhcyBiYWNrcG9ydGVkIGludG8gdGhlIGNhbm9uaWNhbCBmaWxlc1xuICogICAgIChROCBPcGVyYXRpb25hbCBSZWFkaW5lc3MgZm9yIGNvbXBsZXRlLXNsaWNlKS5cbiAqXG4gKiBGYWlsdXJlIG9mIHRoaXMgdGVzdCBtZWFucyB0aGUgbWFudWFsIGAvZ3NkYCBmbG93IG5vIGxvbmdlciBtYXRjaGVzIHRoZVxuICogZG9jdHJpbmUgdGhlIGF1dG8tbW9kZSBwaXBlbGluZSByZWxpZXMgb24gXHUyMDE0IGV4YWN0bHkgdGhlIGRyaWZ0IHRoZSBQUiBpc1xuICogc3VwcG9zZWQgdG8gcHJldmVudC5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCwgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB7XG4gIGJ1aWxkRXhlY3V0ZVRhc2tQcm9tcHQsXG4gIGJ1aWxkQ29tcGxldGVTbGljZVByb21wdCxcbn0gZnJvbSBcIi4uL2F1dG8tcHJvbXB0cy50c1wiO1xuXG5jb25zdCBNSUQgPSBcIk0wMDFcIjtcbmNvbnN0IFNJRCA9IFwiUzAxXCI7XG5jb25zdCBUSUQgPSBcIlQwMVwiO1xuY29uc3QgTV9USVRMRSA9IFwiVGVzdCBtaWxlc3RvbmVcIjtcbmNvbnN0IFNfVElUTEUgPSBcIlRlc3Qgc2xpY2VcIjtcbmNvbnN0IFRfVElUTEUgPSBcIlRlc3QgdGFza1wiO1xuXG5kZXNjcmliZShcImd1aWRlZC1mbG93IFx1MjE5MiBhdXRvLXByb21wdHMgY29uc29saWRhdGlvbiAoIzUxODMpXCIsICgpID0+IHtcbiAgbGV0IGJhc2U6IHN0cmluZztcblxuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcHJvbXB0LWNvbnNvbGlkYXRpb24tXCIpKTtcbiAgICBjb25zdCBzbGljZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBNSUQsIFwic2xpY2VzXCIsIFNJRCk7XG4gICAgY29uc3QgdGFza3NEaXIgPSBqb2luKHNsaWNlRGlyLCBcInRhc2tzXCIpO1xuICAgIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIE1JRCwgYCR7TUlEfS1ST0FETUFQLm1kYCksXG4gICAgICBcIiMgUm9hZG1hcFxcbi0gWyBdICoqUzAxOiBUZXN0IHNsaWNlKipcXG5cIixcbiAgICApO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKHNsaWNlRGlyLCBgJHtTSUR9LVBMQU4ubWRgKSxcbiAgICAgIFtcbiAgICAgICAgXCIjIFNsaWNlIHBsYW5cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBUYXNrc1wiLFxuICAgICAgICBcIi0gVDAxOiBUZXN0IHRhc2tcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBWZXJpZmljYXRpb25cIixcbiAgICAgICAgXCItIEFsbCB0ZXN0cyBwYXNzXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgKTtcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbih0YXNrc0RpciwgYCR7VElEfS1QTEFOLm1kYCksXG4gICAgICBbXG4gICAgICAgIFwiIyBUYXNrIHBsYW5cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBTdGVwc1wiLFxuICAgICAgICBcIjEuIEltcGxlbWVudCB0aGUgdGhpbmdcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIyBNdXN0LWhhdmVzXCIsXG4gICAgICAgIFwiLSBXb3JraW5nIGNvZGVcIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICApO1xuICB9KTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJidWlsZEV4ZWN1dGVUYXNrUHJvbXB0IGNhcnJpZXMgdGhlIGV4ZWN1dGUtdGFzayBjb250cmFjdFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcHJvbXB0ID0gYXdhaXQgYnVpbGRFeGVjdXRlVGFza1Byb21wdChNSUQsIFNJRCwgU19USVRMRSwgVElELCBUX1RJVExFLCBiYXNlKTtcblxuICAgIGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoTUlEKSwgXCJtdXN0IG1lbnRpb24gbWlsZXN0b25lIGlkXCIpO1xuICAgIGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoU0lEKSwgXCJtdXN0IG1lbnRpb24gc2xpY2UgaWRcIik7XG4gICAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhUSUQpLCBcIm11c3QgbWVudGlvbiB0YXNrIGlkXCIpO1xuICAgIGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoVF9USVRMRSksIFwibXVzdCBtZW50aW9uIHRhc2sgdGl0bGVcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcHJvbXB0LmluY2x1ZGVzKFwiZ3NkX3Rhc2tfY29tcGxldGVcIiksXG4gICAgICBcIm11c3QgaW5zdHJ1Y3QgY2FsbGluZyB0aGUgY2Fub25pY2FsIGdzZF90YXNrX2NvbXBsZXRlIHRvb2xcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHByb21wdC5pbmNsdWRlcyhiYXNlKSxcbiAgICAgIFwibXVzdCBiaW5kIHRoZSBleHBsaWNpdCB3b3JraW5nIGRpcmVjdG9yeSBhYnNvbHV0ZSBwYXRoXCIsXG4gICAgKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBwcm9tcHQuaW5jbHVkZXMoXCJJbmxpbmVkIFRhc2sgUGxhblwiKSxcbiAgICAgIFwibXVzdCBpbmxpbmUgdGhlIHRhc2sgcGxhbiBhcyB0aGUgYXV0aG9yaXRhdGl2ZSBleGVjdXRpb24gY29udHJhY3RcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHByb21wdC5pbmNsdWRlcyhcIkltcGxlbWVudCB0aGUgdGhpbmdcIiksXG4gICAgICBcIm11c3QgaW5jbHVkZSB0YXNrIHBsYW4gYm9keSBjb250ZW50IGZyb20gZGlza1wiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcIiMjIENvbnRleHQgTW9kZVwiKSwgXCJleGVjdXRlLXRhc2sgc2hvdWxkIGluY2x1ZGUgc3RhbmRhbG9uZSBDb250ZXh0IE1vZGUgZ3VpZGFuY2VcIik7XG4gICAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhcImV4ZWN1dGlvbiBsYW5lXCIpLCBcImV4ZWN1dGUtdGFzayBzaG91bGQgcmVuZGVyIHRoZSBleGVjdXRpb24gbGFuZVwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImJ1aWxkRXhlY3V0ZVRhc2tQcm9tcHQgb21pdHMgQ29udGV4dCBNb2RlIHdoZW4gZGlzYWJsZWRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgICAgW1wiLS0tXCIsIFwiY29udGV4dF9tb2RlOlwiLCBcIiAgZW5hYmxlZDogZmFsc2VcIiwgXCItLS1cIiwgXCJcIl0uam9pbihcIlxcblwiKSxcbiAgICApO1xuXG4gICAgY29uc3QgcHJvbXB0ID0gYXdhaXQgYnVpbGRFeGVjdXRlVGFza1Byb21wdChNSUQsIFNJRCwgU19USVRMRSwgVElELCBUX1RJVExFLCBiYXNlKTtcblxuICAgIGFzc2VydC5vayghcHJvbXB0LmluY2x1ZGVzKFwiIyMgQ29udGV4dCBNb2RlXCIpKTtcbiAgICBhc3NlcnQub2soIXByb21wdC5pbmNsdWRlcyhcIkNvbnRleHQgTW9kZSAoZXhlY3V0aW9uIGxhbmUpXCIpKTtcbiAgfSk7XG5cbiAgdGVzdChcImJ1aWxkQ29tcGxldGVTbGljZVByb21wdCBjYXJyaWVzIHRoZSBjb21wbGV0ZS1zbGljZSBjb250cmFjdFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcHJvbXB0ID0gYXdhaXQgYnVpbGRDb21wbGV0ZVNsaWNlUHJvbXB0KE1JRCwgTV9USVRMRSwgU0lELCBTX1RJVExFLCBiYXNlKTtcblxuICAgIGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoTUlEKSwgXCJtdXN0IG1lbnRpb24gbWlsZXN0b25lIGlkXCIpO1xuICAgIGFzc2VydC5vayhwcm9tcHQuaW5jbHVkZXMoU0lEKSwgXCJtdXN0IG1lbnRpb24gc2xpY2UgaWRcIik7XG4gICAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhTX1RJVExFKSwgXCJtdXN0IG1lbnRpb24gc2xpY2UgdGl0bGVcIik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcHJvbXB0LmluY2x1ZGVzKFwiZ3NkX3NsaWNlX2NvbXBsZXRlXCIpLFxuICAgICAgXCJtdXN0IGluc3RydWN0IGNhbGxpbmcgZ3NkX3NsaWNlX2NvbXBsZXRlICh3YXMgaW4gZ3VpZGVkLWNvbXBsZXRlLXNsaWNlLm1kKVwiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgcHJvbXB0LmluY2x1ZGVzKGJhc2UpLFxuICAgICAgXCJtdXN0IGJpbmQgdGhlIGV4cGxpY2l0IHdvcmtpbmcgZGlyZWN0b3J5IGFic29sdXRlIHBhdGhcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIC9PcGVyYXRpb25hbCBSZWFkaW5lc3MvaS50ZXN0KHByb21wdCksXG4gICAgICBcIm11c3QgcmVmZXJlbmNlIFE4IE9wZXJhdGlvbmFsIFJlYWRpbmVzcyBkb2N0cmluZSAoYmFja3BvcnRlZCBmcm9tIGd1aWRlZC1jb21wbGV0ZS1zbGljZS5tZClcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIC9TbGljZSBTdW1tYXJ5L2kudGVzdChwcm9tcHQpLFxuICAgICAgXCJtdXN0IHJlZmVyZW5jZSB0aGUgU2xpY2UgU3VtbWFyeSBvdXRwdXQgdGVtcGxhdGVcIixcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIC9VQVQvLnRlc3QocHJvbXB0KSxcbiAgICAgIFwibXVzdCByZWZlcmVuY2UgdGhlIFVBVCBvdXRwdXQgdGVtcGxhdGVcIixcbiAgICApO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBbUJBLFNBQVMsVUFBVSxNQUFNLFlBQVksaUJBQWlCO0FBQ3RELE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBRXJCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBRVAsTUFBTSxNQUFNO0FBQ1osTUFBTSxNQUFNO0FBQ1osTUFBTSxNQUFNO0FBQ1osTUFBTSxVQUFVO0FBQ2hCLE1BQU0sVUFBVTtBQUNoQixNQUFNLFVBQVU7QUFFaEIsU0FBUyx5REFBb0QsTUFBTTtBQUNqRSxNQUFJO0FBRUosYUFBVyxNQUFNO0FBQ2YsV0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLDJCQUEyQixDQUFDO0FBQzlELFVBQU0sV0FBVyxLQUFLLE1BQU0sUUFBUSxjQUFjLEtBQUssVUFBVSxHQUFHO0FBQ3BFLFVBQU0sV0FBVyxLQUFLLFVBQVUsT0FBTztBQUN2QyxjQUFVLFVBQVUsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUV2QztBQUFBLE1BQ0UsS0FBSyxNQUFNLFFBQVEsY0FBYyxLQUFLLEdBQUcsR0FBRyxhQUFhO0FBQUEsTUFDekQ7QUFBQSxJQUNGO0FBQ0E7QUFBQSxNQUNFLEtBQUssVUFBVSxHQUFHLEdBQUcsVUFBVTtBQUFBLE1BQy9CO0FBQUEsUUFDRTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0YsRUFBRSxLQUFLLElBQUk7QUFBQSxJQUNiO0FBQ0E7QUFBQSxNQUNFLEtBQUssVUFBVSxHQUFHLEdBQUcsVUFBVTtBQUFBLE1B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
