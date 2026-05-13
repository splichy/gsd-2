import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openDatabase, closeDatabase, getAllMilestones } from "../gsd-db.js";
import { markApprovalGateVerified, clearDiscussionFlowState } from "../bootstrap/write-gate.js";
import { executeSummarySave } from "../tools/workflow-tool-executors.js";
function makeTmpBase() {
  const base = join(tmpdir(), `gsd-summary-save-empty-project-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}
function cleanup(base) {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
function openTestDb(base) {
  openDatabase(join(base, ".gsd", "gsd.db"));
}
async function inProjectDir(dir, fn) {
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}
function setupBase(t) {
  const base = makeTmpBase();
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: deep\n---\n");
  openTestDb(base);
  markApprovalGateVerified("depth_verification_project_confirm", base);
  t.after(() => {
    clearDiscussionFlowState(base);
    closeDatabase();
    cleanup(base);
  });
  return base;
}
test("executeSummarySave returns isError when PROJECT.md content has zero parseable milestone lines", async (t) => {
  const base = setupBase(t);
  const content = [
    "# Project",
    "",
    "## What This Is",
    "",
    "Bad-separator regression fixture.",
    "",
    "## Milestone Sequence",
    "",
    // Wrong separator: " : " instead of em-dash / -- / -  → MILESTONE_LINE_RE matches zero lines.
    "- [ ] M001: Foundation : Establish the first runnable slice.",
    "",
    "## Next Section",
    "",
    "Trailing prose with no list bullets so MILESTONE_LINE_RE cannot bridge across lines.",
    ""
  ].join("\n");
  const result = await inProjectDir(base, () => executeSummarySave({
    artifact_type: "PROJECT",
    content
  }, base));
  assert.equal(result.isError, true);
  assert.equal(result.details.error, "milestone_registration_empty_parse");
  assert.match(result.content[0].text, /zero parseable milestone lines/);
  assert.equal(getAllMilestones().length, 0);
});
test("executeSummarySave registers milestones when PROJECT.md uses canonical em-dash format", async (t) => {
  const base = setupBase(t);
  const content = [
    "# Project",
    "",
    "## What This Is",
    "",
    "Canonical milestone-sequence fixture.",
    "",
    "## Milestone Sequence",
    "",
    "- [ ] M001: Foo \u2014 bar",
    "- [ ] M002: Baz \u2014 qux",
    ""
  ].join("\n");
  const result = await inProjectDir(base, () => executeSummarySave({
    artifact_type: "PROJECT",
    content
  }, base));
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.details.registeredMilestones, ["M001", "M002"]);
  assert.equal(getAllMilestones().length, 2);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9leGVjdXRlLXN1bW1hcnktc2F2ZS1lbXB0eS1wcm9qZWN0LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIGdzZC0yIC8gZXhlY3V0ZS1zdW1tYXJ5LXNhdmUgUFJPSkVDVCByZWdpc3RyYXRpb24gaGFyZC1mYWlsIHRlc3RzXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuXG5pbXBvcnQgeyBvcGVuRGF0YWJhc2UsIGNsb3NlRGF0YWJhc2UsIGdldEFsbE1pbGVzdG9uZXMgfSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5pbXBvcnQgeyBtYXJrQXBwcm92YWxHYXRlVmVyaWZpZWQsIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZSB9IGZyb20gXCIuLi9ib290c3RyYXAvd3JpdGUtZ2F0ZS50c1wiO1xuaW1wb3J0IHsgZXhlY3V0ZVN1bW1hcnlTYXZlIH0gZnJvbSBcIi4uL3Rvb2xzL3dvcmtmbG93LXRvb2wtZXhlY3V0b3JzLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VUbXBCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBqb2luKHRtcGRpcigpLCBgZ3NkLXN1bW1hcnktc2F2ZS1lbXB0eS1wcm9qZWN0LSR7cmFuZG9tVVVJRCgpfWApO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7IC8qIHN3YWxsb3cgKi8gfVxufVxuXG5mdW5jdGlvbiBvcGVuVGVzdERiKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBpblByb2plY3REaXI8VD4oZGlyOiBzdHJpbmcsIGZuOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XG4gIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgdHJ5IHtcbiAgICBwcm9jZXNzLmNoZGlyKGRpcik7XG4gICAgcmV0dXJuIGF3YWl0IGZuKCk7XG4gIH0gZmluYWxseSB7XG4gICAgcHJvY2Vzcy5jaGRpcihvcmlnaW5hbEN3ZCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gc2V0dXBCYXNlKHQ6IHsgYWZ0ZXI6IChmbjogKCkgPT4gdm9pZCkgPT4gdm9pZCB9KTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gIC8vIEZvcmNlIGRlZXAgcGxhbm5pbmcgc28gdGhlIHJvb3QtYXJ0aWZhY3QgZ3VhcmQgcmVxdWlyZXMgYSB2ZXJpZmllZCBhcHByb3ZhbCBnYXRlLFxuICAvLyBtYXRjaGluZyB0aGUgcHJvZHVjdGlvbiBmbG93IHRoYXQgc3VyZmFjZXMgdGhlIHJlZ3Jlc3Npb24uXG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSwgXCItLS1cXG5wbGFubmluZ19kZXB0aDogZGVlcFxcbi0tLVxcblwiKTtcbiAgb3BlblRlc3REYihiYXNlKTtcbiAgbWFya0FwcHJvdmFsR2F0ZVZlcmlmaWVkKFwiZGVwdGhfdmVyaWZpY2F0aW9uX3Byb2plY3RfY29uZmlybVwiLCBiYXNlKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgY2xlYXJEaXNjdXNzaW9uRmxvd1N0YXRlKGJhc2UpO1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbnRlc3QoXCJleGVjdXRlU3VtbWFyeVNhdmUgcmV0dXJucyBpc0Vycm9yIHdoZW4gUFJPSkVDVC5tZCBjb250ZW50IGhhcyB6ZXJvIHBhcnNlYWJsZSBtaWxlc3RvbmUgbGluZXNcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IHNldHVwQmFzZSh0KTtcblxuICBjb25zdCBjb250ZW50ID0gW1xuICAgIFwiIyBQcm9qZWN0XCIsXG4gICAgXCJcIixcbiAgICBcIiMjIFdoYXQgVGhpcyBJc1wiLFxuICAgIFwiXCIsXG4gICAgXCJCYWQtc2VwYXJhdG9yIHJlZ3Jlc3Npb24gZml4dHVyZS5cIixcbiAgICBcIlwiLFxuICAgIFwiIyMgTWlsZXN0b25lIFNlcXVlbmNlXCIsXG4gICAgXCJcIixcbiAgICAvLyBXcm9uZyBzZXBhcmF0b3I6IFwiIDogXCIgaW5zdGVhZCBvZiBlbS1kYXNoIC8gLS0gLyAtICBcdTIxOTIgTUlMRVNUT05FX0xJTkVfUkUgbWF0Y2hlcyB6ZXJvIGxpbmVzLlxuICAgIFwiLSBbIF0gTTAwMTogRm91bmRhdGlvbiA6IEVzdGFibGlzaCB0aGUgZmlyc3QgcnVubmFibGUgc2xpY2UuXCIsXG4gICAgXCJcIixcbiAgICBcIiMjIE5leHQgU2VjdGlvblwiLFxuICAgIFwiXCIsXG4gICAgXCJUcmFpbGluZyBwcm9zZSB3aXRoIG5vIGxpc3QgYnVsbGV0cyBzbyBNSUxFU1RPTkVfTElORV9SRSBjYW5ub3QgYnJpZGdlIGFjcm9zcyBsaW5lcy5cIixcbiAgICBcIlwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW5Qcm9qZWN0RGlyKGJhc2UsICgpID0+IGV4ZWN1dGVTdW1tYXJ5U2F2ZSh7XG4gICAgYXJ0aWZhY3RfdHlwZTogXCJQUk9KRUNUXCIsXG4gICAgY29udGVudCxcbiAgfSwgYmFzZSkpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQuaXNFcnJvciwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuZGV0YWlscy5lcnJvciwgXCJtaWxlc3RvbmVfcmVnaXN0cmF0aW9uX2VtcHR5X3BhcnNlXCIpO1xuICBhc3NlcnQubWF0Y2gocmVzdWx0LmNvbnRlbnRbMF0udGV4dCwgL3plcm8gcGFyc2VhYmxlIG1pbGVzdG9uZSBsaW5lcy8pO1xuICBhc3NlcnQuZXF1YWwoZ2V0QWxsTWlsZXN0b25lcygpLmxlbmd0aCwgMCk7XG59KTtcblxudGVzdChcImV4ZWN1dGVTdW1tYXJ5U2F2ZSByZWdpc3RlcnMgbWlsZXN0b25lcyB3aGVuIFBST0pFQ1QubWQgdXNlcyBjYW5vbmljYWwgZW0tZGFzaCBmb3JtYXRcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IHNldHVwQmFzZSh0KTtcblxuICBjb25zdCBjb250ZW50ID0gW1xuICAgIFwiIyBQcm9qZWN0XCIsXG4gICAgXCJcIixcbiAgICBcIiMjIFdoYXQgVGhpcyBJc1wiLFxuICAgIFwiXCIsXG4gICAgXCJDYW5vbmljYWwgbWlsZXN0b25lLXNlcXVlbmNlIGZpeHR1cmUuXCIsXG4gICAgXCJcIixcbiAgICBcIiMjIE1pbGVzdG9uZSBTZXF1ZW5jZVwiLFxuICAgIFwiXCIsXG4gICAgXCItIFsgXSBNMDAxOiBGb28gXHUyMDE0IGJhclwiLFxuICAgIFwiLSBbIF0gTTAwMjogQmF6IFx1MjAxNCBxdXhcIixcbiAgICBcIlwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaW5Qcm9qZWN0RGlyKGJhc2UsICgpID0+IGV4ZWN1dGVTdW1tYXJ5U2F2ZSh7XG4gICAgYXJ0aWZhY3RfdHlwZTogXCJQUk9KRUNUXCIsXG4gICAgY29udGVudCxcbiAgfSwgYmFzZSkpO1xuXG4gIGFzc2VydC5ub3RFcXVhbChyZXN1bHQuaXNFcnJvciwgdHJ1ZSk7XG4gIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LmRldGFpbHMucmVnaXN0ZXJlZE1pbGVzdG9uZXMsIFtcIk0wMDFcIiwgXCJNMDAyXCJdKTtcbiAgYXNzZXJ0LmVxdWFsKGdldEFsbE1pbGVzdG9uZXMoKS5sZW5ndGgsIDIpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxRQUFRLHFCQUFxQjtBQUNqRCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsa0JBQWtCO0FBRTNCLFNBQVMsY0FBYyxlQUFlLHdCQUF3QjtBQUM5RCxTQUFTLDBCQUEwQixnQ0FBZ0M7QUFDbkUsU0FBUywwQkFBMEI7QUFFbkMsU0FBUyxjQUFzQjtBQUM3QixRQUFNLE9BQU8sS0FBSyxPQUFPLEdBQUcsa0NBQWtDLFdBQVcsQ0FBQyxFQUFFO0FBQzVFLFlBQVUsS0FBSyxNQUFNLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2pELFNBQU87QUFDVDtBQUVBLFNBQVMsUUFBUSxNQUFvQjtBQUNuQyxNQUFJO0FBQUUsV0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFBRyxRQUFRO0FBQUEsRUFBZ0I7QUFDaEY7QUFFQSxTQUFTLFdBQVcsTUFBb0I7QUFDdEMsZUFBYSxLQUFLLE1BQU0sUUFBUSxRQUFRLENBQUM7QUFDM0M7QUFFQSxlQUFlLGFBQWdCLEtBQWEsSUFBa0M7QUFDNUUsUUFBTSxjQUFjLFFBQVEsSUFBSTtBQUNoQyxNQUFJO0FBQ0YsWUFBUSxNQUFNLEdBQUc7QUFDakIsV0FBTyxNQUFNLEdBQUc7QUFBQSxFQUNsQixVQUFFO0FBQ0EsWUFBUSxNQUFNLFdBQVc7QUFBQSxFQUMzQjtBQUNGO0FBRUEsU0FBUyxVQUFVLEdBQWdEO0FBQ2pFLFFBQU0sT0FBTyxZQUFZO0FBR3pCLGdCQUFjLEtBQUssTUFBTSxRQUFRLGdCQUFnQixHQUFHLGtDQUFrQztBQUN0RixhQUFXLElBQUk7QUFDZiwyQkFBeUIsc0NBQXNDLElBQUk7QUFDbkUsSUFBRSxNQUFNLE1BQU07QUFDWiw2QkFBeUIsSUFBSTtBQUM3QixrQkFBYztBQUNkLFlBQVEsSUFBSTtBQUFBLEVBQ2QsQ0FBQztBQUNELFNBQU87QUFDVDtBQUVBLEtBQUssaUdBQWlHLE9BQU8sTUFBTTtBQUNqSCxRQUFNLE9BQU8sVUFBVSxDQUFDO0FBRXhCLFFBQU0sVUFBVTtBQUFBLElBQ2Q7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUE7QUFBQSxJQUVBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGLEVBQUUsS0FBSyxJQUFJO0FBRVgsUUFBTSxTQUFTLE1BQU0sYUFBYSxNQUFNLE1BQU0sbUJBQW1CO0FBQUEsSUFDL0QsZUFBZTtBQUFBLElBQ2Y7QUFBQSxFQUNGLEdBQUcsSUFBSSxDQUFDO0FBRVIsU0FBTyxNQUFNLE9BQU8sU0FBUyxJQUFJO0FBQ2pDLFNBQU8sTUFBTSxPQUFPLFFBQVEsT0FBTyxvQ0FBb0M7QUFDdkUsU0FBTyxNQUFNLE9BQU8sUUFBUSxDQUFDLEVBQUUsTUFBTSxnQ0FBZ0M7QUFDckUsU0FBTyxNQUFNLGlCQUFpQixFQUFFLFFBQVEsQ0FBQztBQUMzQyxDQUFDO0FBRUQsS0FBSyx5RkFBeUYsT0FBTyxNQUFNO0FBQ3pHLFFBQU0sT0FBTyxVQUFVLENBQUM7QUFFeEIsUUFBTSxVQUFVO0FBQUEsSUFDZDtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGLEVBQUUsS0FBSyxJQUFJO0FBRVgsUUFBTSxTQUFTLE1BQU0sYUFBYSxNQUFNLE1BQU0sbUJBQW1CO0FBQUEsSUFDL0QsZUFBZTtBQUFBLElBQ2Y7QUFBQSxFQUNGLEdBQUcsSUFBSSxDQUFDO0FBRVIsU0FBTyxTQUFTLE9BQU8sU0FBUyxJQUFJO0FBQ3BDLFNBQU8sVUFBVSxPQUFPLFFBQVEsc0JBQXNCLENBQUMsUUFBUSxNQUFNLENBQUM7QUFDdEUsU0FBTyxNQUFNLGlCQUFpQixFQUFFLFFBQVEsQ0FBQztBQUMzQyxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
