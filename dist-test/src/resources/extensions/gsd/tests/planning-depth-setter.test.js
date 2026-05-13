import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { setPlanningDepth } from "../planning-depth.js";
function makeBase() {
  const base = join(tmpdir(), `gsd-planning-depth-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  return base;
}
function readFrontmatter(path) {
  const content = readFileSync(path, "utf-8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  assert.ok(match, "PREFERENCES.md must have frontmatter delimiters");
  const parsed = parseYaml(match[1]);
  assert.ok(parsed && typeof parsed === "object", "frontmatter must parse to an object");
  return { frontmatter: parsed, body: match[2] };
}
test("Deep mode: setPlanningDepth creates PREFERENCES.md when missing", (t) => {
  const base = makeBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  setPlanningDepth(base, "deep");
  const path = join(base, ".gsd", "PREFERENCES.md");
  assert.ok(existsSync(path), "PREFERENCES.md must be created");
  const { frontmatter } = readFrontmatter(path);
  assert.strictEqual(frontmatter.planning_depth, "deep");
  assert.strictEqual(frontmatter.workflow_prefs_captured, true);
  assert.strictEqual(frontmatter.commit_policy, "per-task");
  assert.strictEqual(frontmatter.branch_model, "single");
  assert.strictEqual(frontmatter.uat_dispatch, true);
  assert.deepStrictEqual(frontmatter.models, { executor_class: "balanced" });
  assert.ok(existsSync(join(base, ".gsd", "runtime", "research-decision.json")));
  const researchDecision = JSON.parse(
    readFileSync(join(base, ".gsd", "runtime", "research-decision.json"), "utf-8")
  );
  assert.strictEqual(researchDecision.decision, "skip");
  assert.strictEqual(researchDecision.source, "workflow-preferences");
  assert.strictEqual(researchDecision.reason, "deterministic-default");
});
test("Deep mode: setPlanningDepth updates existing planning_depth", (t) => {
  const base = makeBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "---\nplanning_depth: light\n---\n");
  setPlanningDepth(base, "deep");
  const { frontmatter } = readFrontmatter(join(base, ".gsd", "PREFERENCES.md"));
  assert.strictEqual(frontmatter.planning_depth, "deep");
});
test("Deep mode: setPlanningDepth preserves other frontmatter keys", (t) => {
  const base = makeBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\nversion: 1\nmode: solo\nuat_dispatch: true\n---\n"
  );
  setPlanningDepth(base, "deep");
  const { frontmatter } = readFrontmatter(join(base, ".gsd", "PREFERENCES.md"));
  assert.strictEqual(frontmatter.planning_depth, "deep");
  assert.strictEqual(frontmatter.version, 1);
  assert.strictEqual(frontmatter.mode, "solo");
  assert.strictEqual(frontmatter.uat_dispatch, true);
});
test("Deep mode: setPlanningDepth preserves explicit workflow preference values", (t) => {
  const base = makeBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    [
      "---",
      "planning_depth: deep",
      "commit_policy: manual",
      "branch_model: per-milestone-worktree",
      "uat_dispatch: false",
      "models:",
      "  executor_class: heavy",
      "---",
      ""
    ].join("\n")
  );
  setPlanningDepth(base, "deep");
  const { frontmatter } = readFrontmatter(join(base, ".gsd", "PREFERENCES.md"));
  assert.strictEqual(frontmatter.workflow_prefs_captured, true);
  assert.strictEqual(frontmatter.commit_policy, "manual");
  assert.strictEqual(frontmatter.branch_model, "per-milestone-worktree");
  assert.strictEqual(frontmatter.uat_dispatch, false);
  assert.deepStrictEqual(frontmatter.models, { executor_class: "heavy" });
});
test("Deep mode: setPlanningDepth preserves body content", (t) => {
  const base = makeBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  const original = "---\nversion: 1\n---\n\n# User notes\n\nKeep this body intact.\n";
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), original);
  setPlanningDepth(base, "deep");
  const content = readFileSync(join(base, ".gsd", "PREFERENCES.md"), "utf-8");
  assert.ok(content.includes("# User notes"), "body header must survive");
  assert.ok(content.includes("Keep this body intact."), "body text must survive");
});
test("Deep mode: setPlanningDepth handles file without frontmatter delimiters", (t) => {
  const base = makeBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "version: 1\nmode: solo\n");
  setPlanningDepth(base, "deep");
  const content = readFileSync(join(base, ".gsd", "PREFERENCES.md"), "utf-8");
  assert.ok(content.startsWith("---\n"), "result must have frontmatter delimiters");
  const { frontmatter, body } = readFrontmatter(join(base, ".gsd", "PREFERENCES.md"));
  assert.strictEqual(frontmatter.planning_depth, "deep");
  assert.ok(body.includes("version: 1"), "legacy content preserved as body");
});
test("Deep mode: setPlanningDepth can flip back to light", (t) => {
  const base = makeBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  setPlanningDepth(base, "deep");
  setPlanningDepth(base, "light");
  const { frontmatter } = readFrontmatter(join(base, ".gsd", "PREFERENCES.md"));
  assert.strictEqual(frontmatter.planning_depth, "light");
});
test("Deep mode: setPlanningDepth preserves explicit user research decision", (t) => {
  const base = makeBase();
  t.after(() => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "runtime", "research-decision.json"),
    JSON.stringify({ decision: "research", source: "research-decision", decided_at: "2026-04-27T00:00:00Z" })
  );
  setPlanningDepth(base, "deep");
  const researchDecision = JSON.parse(
    readFileSync(join(base, ".gsd", "runtime", "research-decision.json"), "utf-8")
  );
  assert.strictEqual(researchDecision.decision, "research");
  assert.strictEqual(researchDecision.source, "research-decision");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wbGFubmluZy1kZXB0aC1zZXR0ZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgXHUyMDE0IERlZXAgcGxhbm5pbmcgbW9kZSBzZXRQbGFubmluZ0RlcHRoIGhlbHBlci5cbi8vIFZlcmlmaWVzIHRoZSBoZWxwZXIgY29ycmVjdGx5IGNyZWF0ZXMgYW5kIHVwZGF0ZXMgLmdzZC9QUkVGRVJFTkNFUy5tZCB3aGlsZVxuLy8gcHJlc2VydmluZyBleGlzdGluZyBmcm9udG1hdHRlciBrZXlzIGFuZCBib2R5IGNvbnRlbnQuXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IHBhcnNlIGFzIHBhcnNlWWFtbCB9IGZyb20gXCJ5YW1sXCI7XG5cbmltcG9ydCB7IHNldFBsYW5uaW5nRGVwdGggfSBmcm9tIFwiLi4vcGxhbm5pbmctZGVwdGgudHNcIjtcblxuZnVuY3Rpb24gbWFrZUJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IGpvaW4odG1wZGlyKCksIGBnc2QtcGxhbm5pbmctZGVwdGgtJHtyYW5kb21VVUlEKCl9YCk7XG4gIG1rZGlyU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIHJlYWRGcm9udG1hdHRlcihwYXRoOiBzdHJpbmcpOiB7IGZyb250bWF0dGVyOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjsgYm9keTogc3RyaW5nIH0ge1xuICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmLThcIik7XG4gIGNvbnN0IG1hdGNoID0gY29udGVudC5tYXRjaCgvXi0tLVxccj9cXG4oW1xcc1xcU10qPylcXHI/XFxuLS0tXFxyP1xcbj8oW1xcc1xcU10qKSQvKTtcbiAgYXNzZXJ0Lm9rKG1hdGNoLCBcIlBSRUZFUkVOQ0VTLm1kIG11c3QgaGF2ZSBmcm9udG1hdHRlciBkZWxpbWl0ZXJzXCIpO1xuICBjb25zdCBwYXJzZWQgPSBwYXJzZVlhbWwobWF0Y2hbMV0pO1xuICBhc3NlcnQub2socGFyc2VkICYmIHR5cGVvZiBwYXJzZWQgPT09IFwib2JqZWN0XCIsIFwiZnJvbnRtYXR0ZXIgbXVzdCBwYXJzZSB0byBhbiBvYmplY3RcIik7XG4gIHJldHVybiB7IGZyb250bWF0dGVyOiBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGJvZHk6IG1hdGNoWzJdIH07XG59XG5cbnRlc3QoXCJEZWVwIG1vZGU6IHNldFBsYW5uaW5nRGVwdGggY3JlYXRlcyBQUkVGRVJFTkNFUy5tZCB3aGVuIG1pc3NpbmdcIiwgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4geyB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHt9IH0pO1xuXG4gIHNldFBsYW5uaW5nRGVwdGgoYmFzZSwgXCJkZWVwXCIpO1xuXG4gIGNvbnN0IHBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpO1xuICBhc3NlcnQub2soZXhpc3RzU3luYyhwYXRoKSwgXCJQUkVGRVJFTkNFUy5tZCBtdXN0IGJlIGNyZWF0ZWRcIik7XG4gIGNvbnN0IHsgZnJvbnRtYXR0ZXIgfSA9IHJlYWRGcm9udG1hdHRlcihwYXRoKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGZyb250bWF0dGVyLnBsYW5uaW5nX2RlcHRoLCBcImRlZXBcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChmcm9udG1hdHRlci53b3JrZmxvd19wcmVmc19jYXB0dXJlZCwgdHJ1ZSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChmcm9udG1hdHRlci5jb21taXRfcG9saWN5LCBcInBlci10YXNrXCIpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoZnJvbnRtYXR0ZXIuYnJhbmNoX21vZGVsLCBcInNpbmdsZVwiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGZyb250bWF0dGVyLnVhdF9kaXNwYXRjaCwgdHJ1ZSk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZnJvbnRtYXR0ZXIubW9kZWxzLCB7IGV4ZWN1dG9yX2NsYXNzOiBcImJhbGFuY2VkXCIgfSk7XG4gIGFzc2VydC5vayhleGlzdHNTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInJlc2VhcmNoLWRlY2lzaW9uLmpzb25cIikpKTtcbiAgY29uc3QgcmVzZWFyY2hEZWNpc2lvbiA9IEpTT04ucGFyc2UoXG4gICAgcmVhZEZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwicnVudGltZVwiLCBcInJlc2VhcmNoLWRlY2lzaW9uLmpzb25cIiksIFwidXRmLThcIiksXG4gICk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXNlYXJjaERlY2lzaW9uLmRlY2lzaW9uLCBcInNraXBcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXNlYXJjaERlY2lzaW9uLnNvdXJjZSwgXCJ3b3JrZmxvdy1wcmVmZXJlbmNlc1wiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc2VhcmNoRGVjaXNpb24ucmVhc29uLCBcImRldGVybWluaXN0aWMtZGVmYXVsdFwiKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlOiBzZXRQbGFubmluZ0RlcHRoIHVwZGF0ZXMgZXhpc3RpbmcgcGxhbm5pbmdfZGVwdGhcIiwgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4geyB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHt9IH0pO1xuXG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSwgXCItLS1cXG5wbGFubmluZ19kZXB0aDogbGlnaHRcXG4tLS1cXG5cIik7XG4gIHNldFBsYW5uaW5nRGVwdGgoYmFzZSwgXCJkZWVwXCIpO1xuXG4gIGNvbnN0IHsgZnJvbnRtYXR0ZXIgfSA9IHJlYWRGcm9udG1hdHRlcihqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGZyb250bWF0dGVyLnBsYW5uaW5nX2RlcHRoLCBcImRlZXBcIik7XG59KTtcblxudGVzdChcIkRlZXAgbW9kZTogc2V0UGxhbm5pbmdEZXB0aCBwcmVzZXJ2ZXMgb3RoZXIgZnJvbnRtYXR0ZXIga2V5c1wiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2gge30gfSk7XG5cbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgIFwiLS0tXFxudmVyc2lvbjogMVxcbm1vZGU6IHNvbG9cXG51YXRfZGlzcGF0Y2g6IHRydWVcXG4tLS1cXG5cIixcbiAgKTtcbiAgc2V0UGxhbm5pbmdEZXB0aChiYXNlLCBcImRlZXBcIik7XG5cbiAgY29uc3QgeyBmcm9udG1hdHRlciB9ID0gcmVhZEZyb250bWF0dGVyKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJFRkVSRU5DRVMubWRcIikpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoZnJvbnRtYXR0ZXIucGxhbm5pbmdfZGVwdGgsIFwiZGVlcFwiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGZyb250bWF0dGVyLnZlcnNpb24sIDEpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoZnJvbnRtYXR0ZXIubW9kZSwgXCJzb2xvXCIpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoZnJvbnRtYXR0ZXIudWF0X2Rpc3BhdGNoLCB0cnVlKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlOiBzZXRQbGFubmluZ0RlcHRoIHByZXNlcnZlcyBleHBsaWNpdCB3b3JrZmxvdyBwcmVmZXJlbmNlIHZhbHVlc1wiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2gge30gfSk7XG5cbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiLS0tXCIsXG4gICAgICBcInBsYW5uaW5nX2RlcHRoOiBkZWVwXCIsXG4gICAgICBcImNvbW1pdF9wb2xpY3k6IG1hbnVhbFwiLFxuICAgICAgXCJicmFuY2hfbW9kZWw6IHBlci1taWxlc3RvbmUtd29ya3RyZWVcIixcbiAgICAgIFwidWF0X2Rpc3BhdGNoOiBmYWxzZVwiLFxuICAgICAgXCJtb2RlbHM6XCIsXG4gICAgICBcIiAgZXhlY3V0b3JfY2xhc3M6IGhlYXZ5XCIsXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICk7XG4gIHNldFBsYW5uaW5nRGVwdGgoYmFzZSwgXCJkZWVwXCIpO1xuXG4gIGNvbnN0IHsgZnJvbnRtYXR0ZXIgfSA9IHJlYWRGcm9udG1hdHRlcihqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGZyb250bWF0dGVyLndvcmtmbG93X3ByZWZzX2NhcHR1cmVkLCB0cnVlKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGZyb250bWF0dGVyLmNvbW1pdF9wb2xpY3ksIFwibWFudWFsXCIpO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwoZnJvbnRtYXR0ZXIuYnJhbmNoX21vZGVsLCBcInBlci1taWxlc3RvbmUtd29ya3RyZWVcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChmcm9udG1hdHRlci51YXRfZGlzcGF0Y2gsIGZhbHNlKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChmcm9udG1hdHRlci5tb2RlbHMsIHsgZXhlY3V0b3JfY2xhc3M6IFwiaGVhdnlcIiB9KTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlOiBzZXRQbGFubmluZ0RlcHRoIHByZXNlcnZlcyBib2R5IGNvbnRlbnRcIiwgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4geyB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHt9IH0pO1xuXG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IG9yaWdpbmFsID0gXCItLS1cXG52ZXJzaW9uOiAxXFxuLS0tXFxuXFxuIyBVc2VyIG5vdGVzXFxuXFxuS2VlcCB0aGlzIGJvZHkgaW50YWN0LlxcblwiO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJFRkVSRU5DRVMubWRcIiksIG9yaWdpbmFsKTtcbiAgc2V0UGxhbm5pbmdEZXB0aChiYXNlLCBcImRlZXBcIik7XG5cbiAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLCBcInV0Zi04XCIpO1xuICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcyhcIiMgVXNlciBub3Rlc1wiKSwgXCJib2R5IGhlYWRlciBtdXN0IHN1cnZpdmVcIik7XG4gIGFzc2VydC5vayhjb250ZW50LmluY2x1ZGVzKFwiS2VlcCB0aGlzIGJvZHkgaW50YWN0LlwiKSwgXCJib2R5IHRleHQgbXVzdCBzdXJ2aXZlXCIpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGU6IHNldFBsYW5uaW5nRGVwdGggaGFuZGxlcyBmaWxlIHdpdGhvdXQgZnJvbnRtYXR0ZXIgZGVsaW1pdGVyc1wiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2gge30gfSk7XG5cbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgLy8gU29tZSBhZ2VudHMgd3JpdGUgcHJlZmVyZW5jZXMgd2l0aG91dCBmcm9udG1hdHRlciBkZWxpbWl0ZXJzICgjMjAzNiBjYXNlKVxuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiUFJFRkVSRU5DRVMubWRcIiksIFwidmVyc2lvbjogMVxcbm1vZGU6IHNvbG9cXG5cIik7XG4gIHNldFBsYW5uaW5nRGVwdGgoYmFzZSwgXCJkZWVwXCIpO1xuXG4gIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSwgXCJ1dGYtOFwiKTtcbiAgYXNzZXJ0Lm9rKGNvbnRlbnQuc3RhcnRzV2l0aChcIi0tLVxcblwiKSwgXCJyZXN1bHQgbXVzdCBoYXZlIGZyb250bWF0dGVyIGRlbGltaXRlcnNcIik7XG4gIGNvbnN0IHsgZnJvbnRtYXR0ZXIsIGJvZHkgfSA9IHJlYWRGcm9udG1hdHRlcihqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGZyb250bWF0dGVyLnBsYW5uaW5nX2RlcHRoLCBcImRlZXBcIik7XG4gIC8vIFRoZSBsZWdhY3kgbm9uLWZyb250bWF0dGVyIGNvbnRlbnQgaXMgcHJlc2VydmVkIGFzIGJvZHlcbiAgYXNzZXJ0Lm9rKGJvZHkuaW5jbHVkZXMoXCJ2ZXJzaW9uOiAxXCIpLCBcImxlZ2FjeSBjb250ZW50IHByZXNlcnZlZCBhcyBib2R5XCIpO1xufSk7XG5cbnRlc3QoXCJEZWVwIG1vZGU6IHNldFBsYW5uaW5nRGVwdGggY2FuIGZsaXAgYmFjayB0byBsaWdodFwiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiB7IHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2gge30gfSk7XG5cbiAgc2V0UGxhbm5pbmdEZXB0aChiYXNlLCBcImRlZXBcIik7XG4gIHNldFBsYW5uaW5nRGVwdGgoYmFzZSwgXCJsaWdodFwiKTtcblxuICBjb25zdCB7IGZyb250bWF0dGVyIH0gPSByZWFkRnJvbnRtYXR0ZXIoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChmcm9udG1hdHRlci5wbGFubmluZ19kZXB0aCwgXCJsaWdodFwiKTtcbn0pO1xuXG50ZXN0KFwiRGVlcCBtb2RlOiBzZXRQbGFubmluZ0RlcHRoIHByZXNlcnZlcyBleHBsaWNpdCB1c2VyIHJlc2VhcmNoIGRlY2lzaW9uXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IHsgdHJ5IHsgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7fSB9KTtcblxuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJyZXNlYXJjaC1kZWNpc2lvbi5qc29uXCIpLFxuICAgIEpTT04uc3RyaW5naWZ5KHsgZGVjaXNpb246IFwicmVzZWFyY2hcIiwgc291cmNlOiBcInJlc2VhcmNoLWRlY2lzaW9uXCIsIGRlY2lkZWRfYXQ6IFwiMjAyNi0wNC0yN1QwMDowMDowMFpcIiB9KSxcbiAgKTtcblxuICBzZXRQbGFubmluZ0RlcHRoKGJhc2UsIFwiZGVlcFwiKTtcblxuICBjb25zdCByZXNlYXJjaERlY2lzaW9uID0gSlNPTi5wYXJzZShcbiAgICByZWFkRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwicmVzZWFyY2gtZGVjaXNpb24uanNvblwiKSwgXCJ1dGYtOFwiKSxcbiAgKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKHJlc2VhcmNoRGVjaXNpb24uZGVjaXNpb24sIFwicmVzZWFyY2hcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXNlYXJjaERlY2lzaW9uLnNvdXJjZSwgXCJyZXNlYXJjaC1kZWNpc2lvblwiKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBSUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFlBQVksV0FBVyxjQUFjLFFBQVEscUJBQXFCO0FBQzNFLFNBQVMsY0FBYztBQUN2QixTQUFTLFlBQVk7QUFDckIsU0FBUyxrQkFBa0I7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
