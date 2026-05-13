import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCompleteMilestonePrompt, buildPlanMilestonePrompt } from "../auto-prompts.js";
function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com" }
  }).trim();
}
function makeRepo(files) {
  const base = mkdtempSync(join(tmpdir(), "gsd-right-size-"));
  git(base, ["init", "-b", "main"]);
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# Context\n\nTest milestone.");
  for (const [path, content] of Object.entries(files)) {
    const abs = join(base, path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  git(base, ["add", "."]);
  git(base, ["commit", "-m", "init"]);
  return base;
}
function writeCompleteMilestoneFiles(base, validation) {
  const dir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(join(dir, "slices", "S01"), { recursive: true });
  writeFileSync(join(dir, "M001-ROADMAP.md"), "# M001\n\n## Slices\n- [x] **S01: One** `risk:low` `depends:[]`\n  > Done\n");
  writeFileSync(join(dir, "M001-VALIDATION.md"), validation);
  writeFileSync(join(dir, "slices", "S01", "S01-SUMMARY.md"), "# S01 Summary\n\n**Verification:** passed\n");
}
function validationMetadata() {
  return [
    "validation_metadata:",
    "  covered_artifacts:",
    "    - `.gsd/milestones/M001/M001-VALIDATION.md`",
    "    - `.gsd/milestones/M001/M001-ROADMAP.md`",
    "    - `.gsd/milestones/M001/slices/S01/S01-SUMMARY.md`"
  ].join("\n");
}
test("plan-milestone prompt includes tiny untyped project classification and one-slice guidance", async () => {
  const base = makeRepo({ "index.html": "<!doctype html>\n<title>Test</title>\n" });
  try {
    const prompt = await buildPlanMilestonePrompt("M001", "Polish static page", base, "minimal");
    assert.match(prompt, /\*\*Kind:\*\* untyped-existing/);
    assert.match(prompt, /\*\*Content files:\*\* 1/);
    assert.match(prompt, /`index\.html`/);
    assert.match(prompt, /Prefer exactly one slice/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("plan-milestone prompt includes small untyped project 1-2 slice guidance", async () => {
  const base = makeRepo({
    "index.html": "html",
    "README.md": "readme",
    "styles.css": "body {}"
  });
  try {
    const prompt = await buildPlanMilestonePrompt("M001", "Polish static files", base, "minimal");
    assert.match(prompt, /\*\*Kind:\*\* untyped-existing/);
    assert.match(prompt, /\*\*Content files:\*\* 3/);
    assert.match(prompt, /Prefer 1-2 slices/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("plan-milestone prompt keeps normal guidance for typed projects", async () => {
  const base = makeRepo({
    "package.json": '{"scripts":{"test":"node --test"}}\n',
    "src/index.js": "console.log('ok');\n"
  });
  try {
    const prompt = await buildPlanMilestonePrompt("M001", "Update app", base, "minimal");
    assert.match(prompt, /\*\*Kind:\*\* typed-existing/);
    assert.match(prompt, /Use normal ecosystem-aware planning guidance/);
    assert.doesNotMatch(prompt, /Prefer exactly one slice/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("workflow docs no longer contain blanket 4-10 slice guidance", () => {
  const docs = readFileSync(join(process.cwd(), "src", "resources", "GSD-WORKFLOW.md"), "utf-8");
  assert.doesNotMatch(docs, /4-10 slices/);
  assert.match(docs, /1-10 slices/);
  assert.match(docs, /single-file/);
});
test("prompt templates carry right-sized planning and closeout mode guidance", () => {
  const planTemplate = readFileSync(join(process.cwd(), "src", "resources", "extensions", "gsd", "prompts", "plan-milestone.md"), "utf-8");
  const completeTemplate = readFileSync(join(process.cwd(), "src", "resources", "extensions", "gsd", "prompts", "complete-milestone.md"), "utf-8");
  assert.match(planTemplate, /Use 1-10 slices, sized to the work/);
  assert.match(planTemplate, /tiny\/single-file\/static work should usually be one slice/);
  assert.match(planTemplate, /untyped-existing/);
  assert.match(completeTemplate, /Closeout Review Mode/);
  assert.match(completeTemplate, /passing validation artifact is present/);
  assert.doesNotMatch(completeTemplate, /^### Delegate Review Work/m);
});
test("complete-milestone prompt trusts passing validation artifact", async () => {
  const base = makeRepo({ "index.html": "<!doctype html>\n<title>Test</title>\n" });
  try {
    writeCompleteMilestoneFiles(base, `---
verdict: pass
remediation_round: 0
---

# Validation
${validationMetadata()}

All checks passed.`);
    const prompt = await buildCompleteMilestonePrompt("M001", "Polish static page", base, "minimal");
    assert.match(prompt, /Passing Validation Artifact/);
    assert.match(prompt, /Treat it as authoritative/);
    assert.match(prompt, /Do not delegate fresh reviewer\/security\/tester audits/);
    assert.match(prompt, /All checks passed/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("complete-milestone prompt trusts centralized markdown body pass verdict", async () => {
  const base = makeRepo({ "index.html": "<!doctype html>\n<title>Test</title>\n" });
  try {
    writeCompleteMilestoneFiles(base, `# Validation

**Verdict:** PASS

${validationMetadata()}

All checks passed.`);
    const prompt = await buildCompleteMilestonePrompt("M001", "Polish static page", base, "minimal");
    assert.match(prompt, /Passing Validation Artifact/);
    assert.match(prompt, /Treat it as authoritative/);
    assert.match(prompt, /Do not delegate fresh reviewer\/security\/tester audits/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("complete-milestone prompt does not trust stale pass validation without metadata", async () => {
  const base = makeRepo({ "index.html": "<!doctype html>\n<title>Test</title>\n" });
  try {
    writeCompleteMilestoneFiles(base, "---\nverdict: pass\nremediation_round: 0\n---\n\n# Validation\nAll checks passed.");
    const prompt = await buildCompleteMilestonePrompt("M001", "Polish static page", base, "minimal");
    assert.match(prompt, /Validation Requires Attention/);
    assert.match(prompt, /missing freshness metadata/);
    assert.doesNotMatch(prompt, /Passing Validation Artifact/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("complete-milestone prompt does not trust pass validation missing current summary coverage", async () => {
  const base = makeRepo({ "index.html": "<!doctype html>\n<title>Test</title>\n" });
  try {
    writeCompleteMilestoneFiles(base, [
      "---",
      "verdict: pass",
      "remediation_round: 0",
      "---",
      "",
      "# Validation",
      "validation_metadata:",
      "  covered_artifacts:",
      "    - `.gsd/milestones/M001/M001-VALIDATION.md`",
      "    - `.gsd/milestones/M001/M001-ROADMAP.md`",
      "",
      "All checks passed."
    ].join("\n"));
    const prompt = await buildCompleteMilestonePrompt("M001", "Polish static page", base, "minimal");
    assert.match(prompt, /Validation Requires Attention/);
    assert.match(prompt, /does not cover current milestone artifacts/);
    assert.doesNotMatch(prompt, /Passing Validation Artifact/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("complete-milestone prompt keeps deeper review path without passing validation", async () => {
  const base = makeRepo({ "index.html": "<!doctype html>\n<title>Test</title>\n" });
  try {
    writeCompleteMilestoneFiles(base, "---\nverdict: needs-attention\nremediation_round: 0\n---\n\n# Validation\nFix gaps.");
    const prompt = await buildCompleteMilestonePrompt("M001", "Polish static page", base, "minimal");
    assert.match(prompt, /Validation Requires Attention/);
    assert.match(prompt, /verdict `needs-attention`/);
    assert.match(prompt, /Use `subagent` for review work needing fresh context/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yaWdodC1zaXplZC13b3JrZmxvdy1wcm9tcHRzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7IGJ1aWxkQ29tcGxldGVNaWxlc3RvbmVQcm9tcHQsIGJ1aWxkUGxhbk1pbGVzdG9uZVByb21wdCB9IGZyb20gXCIuLi9hdXRvLXByb21wdHMudHNcIjtcblxuZnVuY3Rpb24gZ2l0KGN3ZDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIHJldHVybiBleGVjRmlsZVN5bmMoXCJnaXRcIiwgYXJncywge1xuICAgIGN3ZCxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICBlbnY6IHsgLi4ucHJvY2Vzcy5lbnYsIEdJVF9BVVRIT1JfTkFNRTogXCJUZXN0IFVzZXJcIiwgR0lUX0FVVEhPUl9FTUFJTDogXCJ0ZXN0QGV4YW1wbGUuY29tXCIsIEdJVF9DT01NSVRURVJfTkFNRTogXCJUZXN0IFVzZXJcIiwgR0lUX0NPTU1JVFRFUl9FTUFJTDogXCJ0ZXN0QGV4YW1wbGUuY29tXCIgfSxcbiAgfSkudHJpbSgpO1xufVxuXG5mdW5jdGlvbiBtYWtlUmVwbyhmaWxlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1yaWdodC1zaXplLVwiKSk7XG4gIGdpdChiYXNlLCBbXCJpbml0XCIsIFwiLWJcIiwgXCJtYWluXCJdKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLUNPTlRFWFQubWRcIiksIFwiIyBDb250ZXh0XFxuXFxuVGVzdCBtaWxlc3RvbmUuXCIpO1xuICBmb3IgKGNvbnN0IFtwYXRoLCBjb250ZW50XSBvZiBPYmplY3QuZW50cmllcyhmaWxlcykpIHtcbiAgICBjb25zdCBhYnMgPSBqb2luKGJhc2UsIHBhdGgpO1xuICAgIG1rZGlyU3luYyhqb2luKGFicywgXCIuLlwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgd3JpdGVGaWxlU3luYyhhYnMsIGNvbnRlbnQpO1xuICB9XG4gIGdpdChiYXNlLCBbXCJhZGRcIiwgXCIuXCJdKTtcbiAgZ2l0KGJhc2UsIFtcImNvbW1pdFwiLCBcIi1tXCIsIFwiaW5pdFwiXSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiB3cml0ZUNvbXBsZXRlTWlsZXN0b25lRmlsZXMoYmFzZTogc3RyaW5nLCB2YWxpZGF0aW9uOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKTtcbiAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcInNsaWNlc1wiLCBcIlMwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiTTAwMS1ST0FETUFQLm1kXCIpLCBcIiMgTTAwMVxcblxcbiMjIFNsaWNlc1xcbi0gW3hdICoqUzAxOiBPbmUqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFxcbiAgPiBEb25lXFxuXCIpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIk0wMDEtVkFMSURBVElPTi5tZFwiKSwgdmFsaWRhdGlvbik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwiUzAxLVNVTU1BUlkubWRcIiksIFwiIyBTMDEgU3VtbWFyeVxcblxcbioqVmVyaWZpY2F0aW9uOioqIHBhc3NlZFxcblwiKTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGlvbk1ldGFkYXRhKCk6IHN0cmluZyB7XG4gIHJldHVybiBbXG4gICAgXCJ2YWxpZGF0aW9uX21ldGFkYXRhOlwiLFxuICAgIFwiICBjb3ZlcmVkX2FydGlmYWN0czpcIixcbiAgICBcIiAgICAtIGAuZ3NkL21pbGVzdG9uZXMvTTAwMS9NMDAxLVZBTElEQVRJT04ubWRgXCIsXG4gICAgXCIgICAgLSBgLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kYFwiLFxuICAgIFwiICAgIC0gYC5nc2QvbWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDEvUzAxLVNVTU1BUlkubWRgXCIsXG4gIF0uam9pbihcIlxcblwiKTtcbn1cblxudGVzdChcInBsYW4tbWlsZXN0b25lIHByb21wdCBpbmNsdWRlcyB0aW55IHVudHlwZWQgcHJvamVjdCBjbGFzc2lmaWNhdGlvbiBhbmQgb25lLXNsaWNlIGd1aWRhbmNlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VSZXBvKHsgXCJpbmRleC5odG1sXCI6IFwiPCFkb2N0eXBlIGh0bWw+XFxuPHRpdGxlPlRlc3Q8L3RpdGxlPlxcblwiIH0pO1xuICB0cnkge1xuICAgIGNvbnN0IHByb21wdCA9IGF3YWl0IGJ1aWxkUGxhbk1pbGVzdG9uZVByb21wdChcIk0wMDFcIiwgXCJQb2xpc2ggc3RhdGljIHBhZ2VcIiwgYmFzZSwgXCJtaW5pbWFsXCIpO1xuICAgIGFzc2VydC5tYXRjaChwcm9tcHQsIC9cXCpcXCpLaW5kOlxcKlxcKiB1bnR5cGVkLWV4aXN0aW5nLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1xcKlxcKkNvbnRlbnQgZmlsZXM6XFwqXFwqIDEvKTtcbiAgICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvYGluZGV4XFwuaHRtbGAvKTtcbiAgICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvUHJlZmVyIGV4YWN0bHkgb25lIHNsaWNlLyk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJwbGFuLW1pbGVzdG9uZSBwcm9tcHQgaW5jbHVkZXMgc21hbGwgdW50eXBlZCBwcm9qZWN0IDEtMiBzbGljZSBndWlkYW5jZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlUmVwbyh7XG4gICAgXCJpbmRleC5odG1sXCI6IFwiaHRtbFwiLFxuICAgIFwiUkVBRE1FLm1kXCI6IFwicmVhZG1lXCIsXG4gICAgXCJzdHlsZXMuY3NzXCI6IFwiYm9keSB7fVwiLFxuICB9KTtcbiAgdHJ5IHtcbiAgICBjb25zdCBwcm9tcHQgPSBhd2FpdCBidWlsZFBsYW5NaWxlc3RvbmVQcm9tcHQoXCJNMDAxXCIsIFwiUG9saXNoIHN0YXRpYyBmaWxlc1wiLCBiYXNlLCBcIm1pbmltYWxcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1xcKlxcKktpbmQ6XFwqXFwqIHVudHlwZWQtZXhpc3RpbmcvKTtcbiAgICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvXFwqXFwqQ29udGVudCBmaWxlczpcXCpcXCogMy8pO1xuICAgIGFzc2VydC5tYXRjaChwcm9tcHQsIC9QcmVmZXIgMS0yIHNsaWNlcy8pO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwicGxhbi1taWxlc3RvbmUgcHJvbXB0IGtlZXBzIG5vcm1hbCBndWlkYW5jZSBmb3IgdHlwZWQgcHJvamVjdHNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVJlcG8oe1xuICAgIFwicGFja2FnZS5qc29uXCI6IFwie1xcXCJzY3JpcHRzXFxcIjp7XFxcInRlc3RcXFwiOlxcXCJub2RlIC0tdGVzdFxcXCJ9fVxcblwiLFxuICAgIFwic3JjL2luZGV4LmpzXCI6IFwiY29uc29sZS5sb2coJ29rJyk7XFxuXCIsXG4gIH0pO1xuICB0cnkge1xuICAgIGNvbnN0IHByb21wdCA9IGF3YWl0IGJ1aWxkUGxhbk1pbGVzdG9uZVByb21wdChcIk0wMDFcIiwgXCJVcGRhdGUgYXBwXCIsIGJhc2UsIFwibWluaW1hbFwiKTtcbiAgICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvXFwqXFwqS2luZDpcXCpcXCogdHlwZWQtZXhpc3RpbmcvKTtcbiAgICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvVXNlIG5vcm1hbCBlY29zeXN0ZW0tYXdhcmUgcGxhbm5pbmcgZ3VpZGFuY2UvKTtcbiAgICBhc3NlcnQuZG9lc05vdE1hdGNoKHByb21wdCwgL1ByZWZlciBleGFjdGx5IG9uZSBzbGljZS8pO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwid29ya2Zsb3cgZG9jcyBubyBsb25nZXIgY29udGFpbiBibGFua2V0IDQtMTAgc2xpY2UgZ3VpZGFuY2VcIiwgKCkgPT4ge1xuICBjb25zdCBkb2NzID0gcmVhZEZpbGVTeW5jKGpvaW4ocHJvY2Vzcy5jd2QoKSwgXCJzcmNcIiwgXCJyZXNvdXJjZXNcIiwgXCJHU0QtV09SS0ZMT1cubWRcIiksIFwidXRmLThcIik7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2goZG9jcywgLzQtMTAgc2xpY2VzLyk7XG4gIGFzc2VydC5tYXRjaChkb2NzLCAvMS0xMCBzbGljZXMvKTtcbiAgYXNzZXJ0Lm1hdGNoKGRvY3MsIC9zaW5nbGUtZmlsZS8pO1xufSk7XG5cbnRlc3QoXCJwcm9tcHQgdGVtcGxhdGVzIGNhcnJ5IHJpZ2h0LXNpemVkIHBsYW5uaW5nIGFuZCBjbG9zZW91dCBtb2RlIGd1aWRhbmNlXCIsICgpID0+IHtcbiAgY29uc3QgcGxhblRlbXBsYXRlID0gcmVhZEZpbGVTeW5jKGpvaW4ocHJvY2Vzcy5jd2QoKSwgXCJzcmNcIiwgXCJyZXNvdXJjZXNcIiwgXCJleHRlbnNpb25zXCIsIFwiZ3NkXCIsIFwicHJvbXB0c1wiLCBcInBsYW4tbWlsZXN0b25lLm1kXCIpLCBcInV0Zi04XCIpO1xuICBjb25zdCBjb21wbGV0ZVRlbXBsYXRlID0gcmVhZEZpbGVTeW5jKGpvaW4ocHJvY2Vzcy5jd2QoKSwgXCJzcmNcIiwgXCJyZXNvdXJjZXNcIiwgXCJleHRlbnNpb25zXCIsIFwiZ3NkXCIsIFwicHJvbXB0c1wiLCBcImNvbXBsZXRlLW1pbGVzdG9uZS5tZFwiKSwgXCJ1dGYtOFwiKTtcblxuICBhc3NlcnQubWF0Y2gocGxhblRlbXBsYXRlLCAvVXNlIDEtMTAgc2xpY2VzLCBzaXplZCB0byB0aGUgd29yay8pO1xuICBhc3NlcnQubWF0Y2gocGxhblRlbXBsYXRlLCAvdGlueVxcL3NpbmdsZS1maWxlXFwvc3RhdGljIHdvcmsgc2hvdWxkIHVzdWFsbHkgYmUgb25lIHNsaWNlLyk7XG4gIGFzc2VydC5tYXRjaChwbGFuVGVtcGxhdGUsIC91bnR5cGVkLWV4aXN0aW5nLyk7XG4gIGFzc2VydC5tYXRjaChjb21wbGV0ZVRlbXBsYXRlLCAvQ2xvc2VvdXQgUmV2aWV3IE1vZGUvKTtcbiAgYXNzZXJ0Lm1hdGNoKGNvbXBsZXRlVGVtcGxhdGUsIC9wYXNzaW5nIHZhbGlkYXRpb24gYXJ0aWZhY3QgaXMgcHJlc2VudC8pO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKGNvbXBsZXRlVGVtcGxhdGUsIC9eIyMjIERlbGVnYXRlIFJldmlldyBXb3JrL20pO1xufSk7XG5cbnRlc3QoXCJjb21wbGV0ZS1taWxlc3RvbmUgcHJvbXB0IHRydXN0cyBwYXNzaW5nIHZhbGlkYXRpb24gYXJ0aWZhY3RcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVJlcG8oeyBcImluZGV4Lmh0bWxcIjogXCI8IWRvY3R5cGUgaHRtbD5cXG48dGl0bGU+VGVzdDwvdGl0bGU+XFxuXCIgfSk7XG4gIHRyeSB7XG4gICAgd3JpdGVDb21wbGV0ZU1pbGVzdG9uZUZpbGVzKGJhc2UsIGAtLS1cXG52ZXJkaWN0OiBwYXNzXFxucmVtZWRpYXRpb25fcm91bmQ6IDBcXG4tLS1cXG5cXG4jIFZhbGlkYXRpb25cXG4ke3ZhbGlkYXRpb25NZXRhZGF0YSgpfVxcblxcbkFsbCBjaGVja3MgcGFzc2VkLmApO1xuICAgIGNvbnN0IHByb21wdCA9IGF3YWl0IGJ1aWxkQ29tcGxldGVNaWxlc3RvbmVQcm9tcHQoXCJNMDAxXCIsIFwiUG9saXNoIHN0YXRpYyBwYWdlXCIsIGJhc2UsIFwibWluaW1hbFwiKTtcbiAgICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvUGFzc2luZyBWYWxpZGF0aW9uIEFydGlmYWN0Lyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1RyZWF0IGl0IGFzIGF1dGhvcml0YXRpdmUvKTtcbiAgICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvRG8gbm90IGRlbGVnYXRlIGZyZXNoIHJldmlld2VyXFwvc2VjdXJpdHlcXC90ZXN0ZXIgYXVkaXRzLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0FsbCBjaGVja3MgcGFzc2VkLyk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJjb21wbGV0ZS1taWxlc3RvbmUgcHJvbXB0IHRydXN0cyBjZW50cmFsaXplZCBtYXJrZG93biBib2R5IHBhc3MgdmVyZGljdFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlUmVwbyh7IFwiaW5kZXguaHRtbFwiOiBcIjwhZG9jdHlwZSBodG1sPlxcbjx0aXRsZT5UZXN0PC90aXRsZT5cXG5cIiB9KTtcbiAgdHJ5IHtcbiAgICB3cml0ZUNvbXBsZXRlTWlsZXN0b25lRmlsZXMoYmFzZSwgYCMgVmFsaWRhdGlvblxcblxcbioqVmVyZGljdDoqKiBQQVNTXFxuXFxuJHt2YWxpZGF0aW9uTWV0YWRhdGEoKX1cXG5cXG5BbGwgY2hlY2tzIHBhc3NlZC5gKTtcbiAgICBjb25zdCBwcm9tcHQgPSBhd2FpdCBidWlsZENvbXBsZXRlTWlsZXN0b25lUHJvbXB0KFwiTTAwMVwiLCBcIlBvbGlzaCBzdGF0aWMgcGFnZVwiLCBiYXNlLCBcIm1pbmltYWxcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1Bhc3NpbmcgVmFsaWRhdGlvbiBBcnRpZmFjdC8pO1xuICAgIGFzc2VydC5tYXRjaChwcm9tcHQsIC9UcmVhdCBpdCBhcyBhdXRob3JpdGF0aXZlLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL0RvIG5vdCBkZWxlZ2F0ZSBmcmVzaCByZXZpZXdlclxcL3NlY3VyaXR5XFwvdGVzdGVyIGF1ZGl0cy8pO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiY29tcGxldGUtbWlsZXN0b25lIHByb21wdCBkb2VzIG5vdCB0cnVzdCBzdGFsZSBwYXNzIHZhbGlkYXRpb24gd2l0aG91dCBtZXRhZGF0YVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlUmVwbyh7IFwiaW5kZXguaHRtbFwiOiBcIjwhZG9jdHlwZSBodG1sPlxcbjx0aXRsZT5UZXN0PC90aXRsZT5cXG5cIiB9KTtcbiAgdHJ5IHtcbiAgICB3cml0ZUNvbXBsZXRlTWlsZXN0b25lRmlsZXMoYmFzZSwgXCItLS1cXG52ZXJkaWN0OiBwYXNzXFxucmVtZWRpYXRpb25fcm91bmQ6IDBcXG4tLS1cXG5cXG4jIFZhbGlkYXRpb25cXG5BbGwgY2hlY2tzIHBhc3NlZC5cIik7XG4gICAgY29uc3QgcHJvbXB0ID0gYXdhaXQgYnVpbGRDb21wbGV0ZU1pbGVzdG9uZVByb21wdChcIk0wMDFcIiwgXCJQb2xpc2ggc3RhdGljIHBhZ2VcIiwgYmFzZSwgXCJtaW5pbWFsXCIpO1xuICAgIGFzc2VydC5tYXRjaChwcm9tcHQsIC9WYWxpZGF0aW9uIFJlcXVpcmVzIEF0dGVudGlvbi8pO1xuICAgIGFzc2VydC5tYXRjaChwcm9tcHQsIC9taXNzaW5nIGZyZXNobmVzcyBtZXRhZGF0YS8pO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvUGFzc2luZyBWYWxpZGF0aW9uIEFydGlmYWN0Lyk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJjb21wbGV0ZS1taWxlc3RvbmUgcHJvbXB0IGRvZXMgbm90IHRydXN0IHBhc3MgdmFsaWRhdGlvbiBtaXNzaW5nIGN1cnJlbnQgc3VtbWFyeSBjb3ZlcmFnZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlUmVwbyh7IFwiaW5kZXguaHRtbFwiOiBcIjwhZG9jdHlwZSBodG1sPlxcbjx0aXRsZT5UZXN0PC90aXRsZT5cXG5cIiB9KTtcbiAgdHJ5IHtcbiAgICB3cml0ZUNvbXBsZXRlTWlsZXN0b25lRmlsZXMoYmFzZSwgW1xuICAgICAgXCItLS1cIixcbiAgICAgIFwidmVyZGljdDogcGFzc1wiLFxuICAgICAgXCJyZW1lZGlhdGlvbl9yb3VuZDogMFwiLFxuICAgICAgXCItLS1cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMgVmFsaWRhdGlvblwiLFxuICAgICAgXCJ2YWxpZGF0aW9uX21ldGFkYXRhOlwiLFxuICAgICAgXCIgIGNvdmVyZWRfYXJ0aWZhY3RzOlwiLFxuICAgICAgXCIgICAgLSBgLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1WQUxJREFUSU9OLm1kYFwiLFxuICAgICAgXCIgICAgLSBgLmdzZC9taWxlc3RvbmVzL00wMDEvTTAwMS1ST0FETUFQLm1kYFwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiQWxsIGNoZWNrcyBwYXNzZWQuXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpKTtcbiAgICBjb25zdCBwcm9tcHQgPSBhd2FpdCBidWlsZENvbXBsZXRlTWlsZXN0b25lUHJvbXB0KFwiTTAwMVwiLCBcIlBvbGlzaCBzdGF0aWMgcGFnZVwiLCBiYXNlLCBcIm1pbmltYWxcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1ZhbGlkYXRpb24gUmVxdWlyZXMgQXR0ZW50aW9uLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL2RvZXMgbm90IGNvdmVyIGN1cnJlbnQgbWlsZXN0b25lIGFydGlmYWN0cy8pO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2gocHJvbXB0LCAvUGFzc2luZyBWYWxpZGF0aW9uIEFydGlmYWN0Lyk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJjb21wbGV0ZS1taWxlc3RvbmUgcHJvbXB0IGtlZXBzIGRlZXBlciByZXZpZXcgcGF0aCB3aXRob3V0IHBhc3NpbmcgdmFsaWRhdGlvblwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlUmVwbyh7IFwiaW5kZXguaHRtbFwiOiBcIjwhZG9jdHlwZSBodG1sPlxcbjx0aXRsZT5UZXN0PC90aXRsZT5cXG5cIiB9KTtcbiAgdHJ5IHtcbiAgICB3cml0ZUNvbXBsZXRlTWlsZXN0b25lRmlsZXMoYmFzZSwgXCItLS1cXG52ZXJkaWN0OiBuZWVkcy1hdHRlbnRpb25cXG5yZW1lZGlhdGlvbl9yb3VuZDogMFxcbi0tLVxcblxcbiMgVmFsaWRhdGlvblxcbkZpeCBnYXBzLlwiKTtcbiAgICBjb25zdCBwcm9tcHQgPSBhd2FpdCBidWlsZENvbXBsZXRlTWlsZXN0b25lUHJvbXB0KFwiTTAwMVwiLCBcIlBvbGlzaCBzdGF0aWMgcGFnZVwiLCBiYXNlLCBcIm1pbmltYWxcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1ZhbGlkYXRpb24gUmVxdWlyZXMgQXR0ZW50aW9uLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL3ZlcmRpY3QgYG5lZWRzLWF0dGVudGlvbmAvKTtcbiAgICBhc3NlcnQubWF0Y2gocHJvbXB0LCAvVXNlIGBzdWJhZ2VudGAgZm9yIHJldmlldyB3b3JrIG5lZWRpbmcgZnJlc2ggY29udGV4dC9pKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxhQUFhLFdBQVcsY0FBYyxRQUFRLHFCQUFxQjtBQUM1RSxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMsOEJBQThCLGdDQUFnQztBQUV2RSxTQUFTLElBQUksS0FBYSxNQUF3QjtBQUNoRCxTQUFPLGFBQWEsT0FBTyxNQUFNO0FBQUEsSUFDL0I7QUFBQSxJQUNBLE9BQU8sQ0FBQyxVQUFVLFFBQVEsTUFBTTtBQUFBLElBQ2hDLFVBQVU7QUFBQSxJQUNWLEtBQUssRUFBRSxHQUFHLFFBQVEsS0FBSyxpQkFBaUIsYUFBYSxrQkFBa0Isb0JBQW9CLG9CQUFvQixhQUFhLHFCQUFxQixtQkFBbUI7QUFBQSxFQUN0SyxDQUFDLEVBQUUsS0FBSztBQUNWO0FBRUEsU0FBUyxTQUFTLE9BQXVDO0FBQ3ZELFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLGlCQUFpQixDQUFDO0FBQzFELE1BQUksTUFBTSxD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
