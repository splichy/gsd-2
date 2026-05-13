import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPlanMilestonePrompt } from "../auto-prompts.js";
function createBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-plan-queue-"));
  mkdirSync(join(base, ".gsd", "milestones", "M010"), { recursive: true });
  return base;
}
function cleanup(base) {
  rmSync(base, { recursive: true, force: true });
}
describe("plan-milestone queue context", () => {
  test("includes queue brief when planning milestone without roadmap context", async () => {
    const base = createBase();
    try {
      writeFileSync(
        join(base, ".gsd", "QUEUE.md"),
        [
          "# Queue",
          "",
          "### M010: Analytics Dashboard \u2014 Interactivity, Intelligence & Demo Readiness",
          "**Vision:** Ship a polished analytics dashboard with drilldowns and AI assistance.",
          "",
          "## Scope",
          "- Interactivity",
          "- Intelligence",
          "- Demo readiness",
          ""
        ].join("\n")
      );
      const prompt = await buildPlanMilestonePrompt("M010", "M010", base);
      assert.match(prompt, /Source: `\.gsd\/QUEUE\.md`/);
      assert.match(prompt, /Analytics Dashboard — Interactivity, Intelligence & Demo Readiness/);
      assert.match(prompt, /Ship a polished analytics dashboard/);
    } finally {
      cleanup(base);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wbGFuLW1pbGVzdG9uZS1xdWV1ZS1jb250ZXh0LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7IGJ1aWxkUGxhbk1pbGVzdG9uZVByb21wdCB9IGZyb20gXCIuLi9hdXRvLXByb21wdHMudHNcIjtcblxuZnVuY3Rpb24gY3JlYXRlQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcGxhbi1xdWV1ZS1cIikpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAxMFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG5kZXNjcmliZShcInBsYW4tbWlsZXN0b25lIHF1ZXVlIGNvbnRleHRcIiwgKCkgPT4ge1xuICB0ZXN0KFwiaW5jbHVkZXMgcXVldWUgYnJpZWYgd2hlbiBwbGFubmluZyBtaWxlc3RvbmUgd2l0aG91dCByb2FkbWFwIGNvbnRleHRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBjcmVhdGVCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUVVFVUUubWRcIiksXG4gICAgICAgIFtcbiAgICAgICAgICBcIiMgUXVldWVcIixcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIFwiIyMjIE0wMTA6IEFuYWx5dGljcyBEYXNoYm9hcmQgXHUyMDE0IEludGVyYWN0aXZpdHksIEludGVsbGlnZW5jZSAmIERlbW8gUmVhZGluZXNzXCIsXG4gICAgICAgICAgXCIqKlZpc2lvbjoqKiBTaGlwIGEgcG9saXNoZWQgYW5hbHl0aWNzIGRhc2hib2FyZCB3aXRoIGRyaWxsZG93bnMgYW5kIEFJIGFzc2lzdGFuY2UuXCIsXG4gICAgICAgICAgXCJcIixcbiAgICAgICAgICBcIiMjIFNjb3BlXCIsXG4gICAgICAgICAgXCItIEludGVyYWN0aXZpdHlcIixcbiAgICAgICAgICBcIi0gSW50ZWxsaWdlbmNlXCIsXG4gICAgICAgICAgXCItIERlbW8gcmVhZGluZXNzXCIsXG4gICAgICAgICAgXCJcIixcbiAgICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgKTtcblxuICAgICAgY29uc3QgcHJvbXB0ID0gYXdhaXQgYnVpbGRQbGFuTWlsZXN0b25lUHJvbXB0KFwiTTAxMFwiLCBcIk0wMTBcIiwgYmFzZSk7XG5cbiAgICAgIGFzc2VydC5tYXRjaChwcm9tcHQsIC9Tb3VyY2U6IGBcXC5nc2RcXC9RVUVVRVxcLm1kYC8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0FuYWx5dGljcyBEYXNoYm9hcmQgXHUyMDE0IEludGVyYWN0aXZpdHksIEludGVsbGlnZW5jZSAmIERlbW8gUmVhZGluZXNzLyk7XG4gICAgICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvU2hpcCBhIHBvbGlzaGVkIGFuYWx5dGljcyBkYXNoYm9hcmQvKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYW51cChiYXNlKTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxxQkFBcUI7QUFDOUQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLGdDQUFnQztBQUV6QyxTQUFTLGFBQXFCO0FBQzVCLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLGlCQUFpQixDQUFDO0FBQzFELFlBQVUsS0FBSyxNQUFNLFFBQVEsY0FBYyxNQUFNLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN2RSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLFFBQVEsTUFBb0I7QUFDbkMsU0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQy9DO0FBRUEsU0FBUyxnQ0FBZ0MsTUFBTTtBQUM3QyxPQUFLLHdFQUF3RSxZQUFZO0FBQ3ZGLFVBQU0sT0FBTyxXQUFXO0FBQ3hCLFFBQUk7QUFDRjtBQUFBLFFBQ0UsS0FBSyxNQUFNLFFBQVEsVUFBVTtBQUFBLFFBQzdCO0FBQUEsVUFDRTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFFBQ0YsRUFBRSxLQUFLLElBQUk7QUFBQSxNQUNiO0FBRUEsWUFBTSxTQUFTLE1BQU0seUJBQXlCLFFBQVEsUUFBUSxJQUFJO0FBRWxFLGFBQU8sTUFBTSxRQUFRLDRCQUE0QjtBQUNqRCxhQUFPLE1BQU0sUUFBUSxvRUFBb0U7QUFDekYsYUFBTyxNQUFNLFFBQVEscUNBQXFDO0FBQUEsSUFDNUQsVUFBRTtBQUNBLGNBQVEsSUFBSTtBQUFBLElBQ2Q7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
