import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { _parseWorkflowArgsForTest } from "./workflow-tools.js";
const minimalSchema = z.object({
  projectDir: z.string().optional(),
  milestoneId: z.string().optional()
});
describe("parseWorkflowArgs $HOME guard", () => {
  it("throws when projectDir resolves to the user's home directory", () => {
    assert.throws(
      () => _parseWorkflowArgsForTest(minimalSchema, { projectDir: homedir() }),
      /home directory/i
    );
  });
});
describe("parseWorkflowArgs sole-worktree fallback", () => {
  it("routes writes to the lone auto-worktree when milestoneId is omitted", () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "gsd-mcp-wt-")));
    try {
      mkdirSync(join(project, ".gsd"), { recursive: true });
      const wt = join(project, ".gsd", "worktrees", "M001");
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, ".git"), "gitdir: /fake/path/to/git\n");
      const result = _parseWorkflowArgsForTest(minimalSchema, { projectDir: project });
      assert.equal(result.projectDir, wt, "should re-route to the sole worktree");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
  it("stays at project root when multiple worktrees exist (ambiguous)", () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "gsd-mcp-wt-multi-")));
    try {
      mkdirSync(join(project, ".gsd"), { recursive: true });
      for (const id of ["M001", "M002"]) {
        const wt = join(project, ".gsd", "worktrees", id);
        mkdirSync(wt, { recursive: true });
        writeFileSync(join(wt, ".git"), "gitdir: /fake/git\n");
      }
      const result = _parseWorkflowArgsForTest(minimalSchema, { projectDir: project });
      assert.equal(result.projectDir, project, "ambiguous \u2192 keep project root");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
  it("uses the explicit milestone worktree when milestoneId is provided", () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "gsd-mcp-wt-explicit-")));
    try {
      mkdirSync(join(project, ".gsd"), { recursive: true });
      const wt = join(project, ".gsd", "worktrees", "M042");
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, ".git"), "gitdir: /fake/git\n");
      const result = _parseWorkflowArgsForTest(minimalSchema, {
        projectDir: project,
        milestoneId: "M042"
      });
      assert.equal(result.projectDir, wt);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvbWNwLXNlcnZlci9zcmMvcGFyc2Utd29ya2Zsb3ctYXJncy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdHMgZm9yIHBhcnNlV29ya2Zsb3dBcmdzIGN3ZCBoYW5kbGluZzpcbiAqICAtIFJlZnVzZXMgd2hlbiBwcm9qZWN0RGlyIHJlc29sdmVzIHRvICRIT01FIChkZWZlbnNlLWluLWRlcHRoIGFnYWluc3QgdGhlXG4gKiAgICBNQ1Agc2VydmVyJ3MgcHJvY2Vzcy5jd2QoKSBmYWxsaW5nIGJhY2sgdG8gaG9tZSkuXG4gKiAgLSBSb3V0ZXMgd3JpdGVzIHRvIGEgc29sZSBhY3RpdmUgYXV0by13b3JrdHJlZSB3aGVuIG1pbGVzdG9uZUlkIGlzIG9taXR0ZWQuXG4gKi9cbmltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCBta2R0ZW1wU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jLCByZWFscGF0aFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB6IH0gZnJvbSBcInpvZFwiO1xuXG5pbXBvcnQgeyBfcGFyc2VXb3JrZmxvd0FyZ3NGb3JUZXN0IH0gZnJvbSBcIi4vd29ya2Zsb3ctdG9vbHMuanNcIjtcblxuY29uc3QgbWluaW1hbFNjaGVtYSA9IHoub2JqZWN0KHtcbiAgcHJvamVjdERpcjogei5zdHJpbmcoKS5vcHRpb25hbCgpLFxuICBtaWxlc3RvbmVJZDogei5zdHJpbmcoKS5vcHRpb25hbCgpLFxufSk7XG5cbmRlc2NyaWJlKFwicGFyc2VXb3JrZmxvd0FyZ3MgJEhPTUUgZ3VhcmRcIiwgKCkgPT4ge1xuICBpdChcInRocm93cyB3aGVuIHByb2plY3REaXIgcmVzb2x2ZXMgdG8gdGhlIHVzZXIncyBob21lIGRpcmVjdG9yeVwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LnRocm93cyhcbiAgICAgICgpID0+IF9wYXJzZVdvcmtmbG93QXJnc0ZvclRlc3QobWluaW1hbFNjaGVtYSwgeyBwcm9qZWN0RGlyOiBob21lZGlyKCkgfSksXG4gICAgICAvaG9tZSBkaXJlY3RvcnkvaSxcbiAgICApO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcInBhcnNlV29ya2Zsb3dBcmdzIHNvbGUtd29ya3RyZWUgZmFsbGJhY2tcIiwgKCkgPT4ge1xuICBpdChcInJvdXRlcyB3cml0ZXMgdG8gdGhlIGxvbmUgYXV0by13b3JrdHJlZSB3aGVuIG1pbGVzdG9uZUlkIGlzIG9taXR0ZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHByb2plY3QgPSByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtbWNwLXd0LVwiKSkpO1xuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMoam9pbihwcm9qZWN0LCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgY29uc3Qgd3QgPSBqb2luKHByb2plY3QsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiLCBcIk0wMDFcIik7XG4gICAgICBta2RpclN5bmMod3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHd0LCBcIi5naXRcIiksIFwiZ2l0ZGlyOiAvZmFrZS9wYXRoL3RvL2dpdFxcblwiKTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gX3BhcnNlV29ya2Zsb3dBcmdzRm9yVGVzdChtaW5pbWFsU2NoZW1hLCB7IHByb2plY3REaXI6IHByb2plY3QgfSk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnByb2plY3REaXIsIHd0LCBcInNob3VsZCByZS1yb3V0ZSB0byB0aGUgc29sZSB3b3JrdHJlZVwiKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHByb2plY3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwic3RheXMgYXQgcHJvamVjdCByb290IHdoZW4gbXVsdGlwbGUgd29ya3RyZWVzIGV4aXN0IChhbWJpZ3VvdXMpXCIsICgpID0+IHtcbiAgICBjb25zdCBwcm9qZWN0ID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLW1jcC13dC1tdWx0aS1cIikpKTtcbiAgICB0cnkge1xuICAgICAgbWtkaXJTeW5jKGpvaW4ocHJvamVjdCwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIGZvciAoY29uc3QgaWQgb2YgW1wiTTAwMVwiLCBcIk0wMDJcIl0pIHtcbiAgICAgICAgY29uc3Qgd3QgPSBqb2luKHByb2plY3QsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiLCBpZCk7XG4gICAgICAgIG1rZGlyU3luYyh3dCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgIHdyaXRlRmlsZVN5bmMoam9pbih3dCwgXCIuZ2l0XCIpLCBcImdpdGRpcjogL2Zha2UvZ2l0XFxuXCIpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCByZXN1bHQgPSBfcGFyc2VXb3JrZmxvd0FyZ3NGb3JUZXN0KG1pbmltYWxTY2hlbWEsIHsgcHJvamVjdERpcjogcHJvamVjdCB9KTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQucHJvamVjdERpciwgcHJvamVjdCwgXCJhbWJpZ3VvdXMgXHUyMTkyIGtlZXAgcHJvamVjdCByb290XCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMocHJvamVjdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJ1c2VzIHRoZSBleHBsaWNpdCBtaWxlc3RvbmUgd29ya3RyZWUgd2hlbiBtaWxlc3RvbmVJZCBpcyBwcm92aWRlZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcHJvamVjdCA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1tY3Atd3QtZXhwbGljaXQtXCIpKSk7XG4gICAgdHJ5IHtcbiAgICAgIG1rZGlyU3luYyhqb2luKHByb2plY3QsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBjb25zdCB3dCA9IGpvaW4ocHJvamVjdCwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiTTA0MlwiKTtcbiAgICAgIG1rZGlyU3luYyh3dCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4od3QsIFwiLmdpdFwiKSwgXCJnaXRkaXI6IC9mYWtlL2dpdFxcblwiKTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0gX3BhcnNlV29ya2Zsb3dBcmdzRm9yVGVzdChtaW5pbWFsU2NoZW1hLCB7XG4gICAgICAgIHByb2plY3REaXI6IHByb2plY3QsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wNDJcIixcbiAgICAgIH0pO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5wcm9qZWN0RGlyLCB3dCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhwcm9qZWN0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBTUEsU0FBUyxVQUFVLFVBQVU7QUFDN0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxhQUFhLFFBQVEsZUFBZSxvQkFBb0I7QUFDNUUsU0FBUyxTQUFTLGNBQWM7QUFDaEMsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsU0FBUztBQUVsQixTQUFTLGlDQUFpQztBQUUxQyxNQUFNLGdCQUFnQixFQUFFLE9BQU87QUFBQSxFQUM3QixZQUFZLEVB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
