import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleAgentEnd } from "../bootstrap/agent-end-recovery.js";
import { resolveMilestoneFile, clearPathCache } from "../paths.js";
function mkBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-4648-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}
describe("#4648 stale dirListCache", () => {
  test("resolveMilestoneFile returns stale null until clearPathCache runs", () => {
    const base = mkBase();
    try {
      clearPathCache();
      assert.equal(resolveMilestoneFile(base, "M001", "CONTEXT"), null);
      writeFileSync(
        join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
        "# M001 Context\n"
      );
      assert.equal(resolveMilestoneFile(base, "M001", "CONTEXT"), null);
      clearPathCache();
      assert.match(resolveMilestoneFile(base, "M001", "CONTEXT") ?? "", /M001-CONTEXT\.md$/);
    } finally {
      clearPathCache();
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("handleAgentEnd invalidates the path cache before recovery guards read artifacts", async () => {
    const base = mkBase();
    const previousCwd = process.cwd();
    try {
      process.chdir(base);
      clearPathCache();
      assert.equal(resolveMilestoneFile(base, "M001", "CONTEXT"), null);
      writeFileSync(
        join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
        "# M001 Context\n"
      );
      await handleAgentEnd({}, { messages: [] }, {
        ui: { notify: () => {
        } }
      });
      assert.match(resolveMilestoneFile(base, "M001", "CONTEXT") ?? "", /M001-CONTEXT\.md$/);
    } finally {
      process.chdir(previousCwd);
      clearPathCache();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zdGFsZS1kaXJsaXN0Y2FjaGUtNDY0OC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEdTRC0yIC8gYWdlbnQtZW5kLXJlY292ZXJ5IFx1MjAxNCByZWdyZXNzaW9uIHRlc3RzIGZvciAjNDY0OC5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBoYW5kbGVBZ2VudEVuZCB9IGZyb20gXCIuLi9ib290c3RyYXAvYWdlbnQtZW5kLXJlY292ZXJ5LnRzXCI7XG5pbXBvcnQgeyByZXNvbHZlTWlsZXN0b25lRmlsZSwgY2xlYXJQYXRoQ2FjaGUgfSBmcm9tIFwiLi4vcGF0aHMudHNcIjtcblxuZnVuY3Rpb24gbWtCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC00NjQ4LVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmRlc2NyaWJlKFwiIzQ2NDggc3RhbGUgZGlyTGlzdENhY2hlXCIsICgpID0+IHtcbiAgdGVzdChcInJlc29sdmVNaWxlc3RvbmVGaWxlIHJldHVybnMgc3RhbGUgbnVsbCB1bnRpbCBjbGVhclBhdGhDYWNoZSBydW5zXCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWtCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNsZWFyUGF0aENhY2hlKCk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgXCJNMDAxXCIsIFwiQ09OVEVYVFwiKSwgbnVsbCk7XG5cbiAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLUNPTlRFWFQubWRcIiksXG4gICAgICAgIFwiIyBNMDAxIENvbnRleHRcXG5cIixcbiAgICAgICk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChyZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlLCBcIk0wMDFcIiwgXCJDT05URVhUXCIpLCBudWxsKTtcbiAgICAgIGNsZWFyUGF0aENhY2hlKCk7XG4gICAgICBhc3NlcnQubWF0Y2gocmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgXCJNMDAxXCIsIFwiQ09OVEVYVFwiKSA/PyBcIlwiLCAvTTAwMS1DT05URVhUXFwubWQkLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFyUGF0aENhY2hlKCk7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZUFnZW50RW5kIGludmFsaWRhdGVzIHRoZSBwYXRoIGNhY2hlIGJlZm9yZSByZWNvdmVyeSBndWFyZHMgcmVhZCBhcnRpZmFjdHNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBta0Jhc2UoKTtcbiAgICBjb25zdCBwcmV2aW91c0N3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gICAgdHJ5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG4gICAgICBjbGVhclBhdGhDYWNoZSgpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2UsIFwiTTAwMVwiLCBcIkNPTlRFWFRcIiksIG51bGwpO1xuXG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1DT05URVhULm1kXCIpLFxuICAgICAgICBcIiMgTTAwMSBDb250ZXh0XFxuXCIsXG4gICAgICApO1xuXG4gICAgICBhd2FpdCBoYW5kbGVBZ2VudEVuZCh7fSBhcyBhbnksIHsgbWVzc2FnZXM6IFtdIH0sIHtcbiAgICAgICAgdWk6IHsgbm90aWZ5OiAoKSA9PiB7fSB9LFxuICAgICAgfSBhcyBhbnkpO1xuXG4gICAgICBhc3NlcnQubWF0Y2gocmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgXCJNMDAxXCIsIFwiQ09OVEVYVFwiKSA/PyBcIlwiLCAvTTAwMS1DT05URVhUXFwubWQkLyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIocHJldmlvdXNDd2QpO1xuICAgICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBSUEsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyxzQkFBc0I7QUFDL0IsU0FBUyxzQkFBc0Isc0JBQXNCO0FBRXJELFNBQVMsU0FBaUI7QUFDeEIsUUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsV0FBVyxDQUFDO0FBQ3BELFlBQVUsS0FBSyxNQUFNLFFBQVEsY0FBYyxNQUFNLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN2RSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLDRCQUE0QixNQUFNO0FBQ3pDLE9BQUsscUVBQXFFLE1BQU07QUFDOUUsVUFBTSxPQUFPLE9BQU87QUFDcEIsUUFBSTtBQUNGLHFCQUFlO0FBQ2YsYUFBTyxNQUFNLHFCQUFxQixNQUFNLFFBQVEsU0FBUyxHQUFHLElBQUk7QUFFaEU7QUFBQSxRQUNFLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxpQkFBaUI7QUFBQSxRQUMxRDtBQUFBLE1BQ0Y7QUFFQSxhQUFPLE1BQU0scUJBQXFCLE1BQU0sUUFBUSxTQUFTLEdBQUcsSUFBSTtBQUNoRSxxQkFBZTtBQUNmLGFBQU8sTUFBTSxxQkFBcUIsTUFBTSxRQUFRLFNBQVMsS0FBSyxJQUFJLG1CQUFtQjtBQUFBLElBQ3ZGLFVBQUU7QUFDQSxxQkFBZTtBQUNmLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyxtRkFBbUYsWUFBWTtBQUNsRyxVQUFNLE9BQU8sT0FBTztBQUNwQixVQUFNLGNBQWMsUUFBUSxJQUFJO0FBQ2hDLFFBQUk7QUFDRixjQUFRLE1BQU0sSUFBSTtBQUNsQixxQkFBZTtBQUNmLGFBQU8sTUFBTSxxQkFBcUIsTUFBTSxRQUFRLFNBQVMsR0FBRyxJQUFJO0FBRWhFO0FBQUEsUUFDRSxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsaUJBQWlCO0FBQUEsUUFDMUQ7QUFBQSxNQUNGO0FBRUEsWUFBTSxlQUFlLENBQUMsR0FBVSxFQUFFLFVBQVUsQ0FBQyxFQUFFLEdBQUc7QUFBQSxRQUNoRCxJQUFJLEVBQUUsUUFBUSxNQUFNO0FBQUEsUUFBQyxFQUFFO0FBQUEsTUFDekIsQ0FBUTtBQUVSLGFBQU8sTUFBTSxxQkFBcUIsTUFBTSxRQUFRLFNBQVMsS0FBSyxJQUFJLG1CQUFtQjtBQUFBLElBQ3ZGLFVBQUU7QUFDQSxjQUFRLE1BQU0sV0FBVztBQUN6QixxQkFBZTtBQUNmLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
