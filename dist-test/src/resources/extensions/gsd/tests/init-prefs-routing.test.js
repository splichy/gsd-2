import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapInitPrefsToWizardShape } from "../init-wizard.js";
import { handlePrefsWizard, writePreferencesFile } from "../commands-prefs-wizard.js";
test("mapInitPrefsToWizardShape \u2014 full roundtrip with all fields", () => {
  const out = mapInitPrefsToWizardShape({
    mode: "team",
    gitIsolation: "branch",
    mainBranch: "develop",
    verificationCommands: ["npm test", "npm run lint"],
    customInstructions: ["Use TypeScript strict mode", "Always write tests"],
    tokenProfile: "quality",
    skipResearch: true,
    autoPush: false
  });
  assert.equal(out.mode, "team");
  assert.deepEqual(out.git, { isolation: "branch", main_branch: "develop", auto_push: false });
  assert.deepEqual(out.verification_commands, ["npm test", "npm run lint"]);
  assert.deepEqual(out.custom_instructions, ["Use TypeScript strict mode", "Always write tests"]);
  assert.equal(out.token_profile, "quality");
  assert.deepEqual(out.phases, { skip_research: true });
});
test("mapInitPrefsToWizardShape \u2014 omits defaults to keep YAML clean", () => {
  const out = mapInitPrefsToWizardShape({
    mode: "solo",
    gitIsolation: "worktree",
    mainBranch: "main",
    verificationCommands: [],
    customInstructions: [],
    tokenProfile: "balanced",
    skipResearch: false,
    autoPush: true
  });
  assert.equal(out.token_profile, void 0);
  assert.equal(out.phases, void 0);
  assert.equal(out.verification_commands, void 0);
  assert.equal(out.custom_instructions, void 0);
});
test("writePreferencesFile \u2014 writes valid frontmatter from prefill", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-init-prefs-routing-"));
  const path = join(tmp, "PREFERENCES.md");
  try {
    const prefs = mapInitPrefsToWizardShape({
      mode: "solo",
      gitIsolation: "worktree",
      mainBranch: "main",
      verificationCommands: ["npm test"],
      customInstructions: [],
      tokenProfile: "balanced",
      skipResearch: false,
      autoPush: true
    });
    await writePreferencesFile(path, prefs, null, { scope: "project" });
    const content = readFileSync(path, "utf-8");
    assert.match(content, /^---/);
    assert.match(content, /mode: solo/);
    assert.match(content, /git:/);
    assert.match(content, /isolation: worktree/);
    assert.match(content, /main_branch: main/);
    assert.match(content, /auto_push: true/);
    assert.match(content, /verification_commands:/);
    assert.match(content, /- npm test/);
    assert.match(content, /version: 1/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("writePreferencesFile \u2014 preserves existing markdown body", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-init-prefs-routing-"));
  const path = join(tmp, "PREFERENCES.md");
  const customBody = "\n# My Custom Notes\n\nUser-edited content here.\n";
  try {
    writeFileSync(path, `---
mode: solo
version: 1
---${customBody}`, "utf-8");
    await writePreferencesFile(path, { mode: "team", version: 1 }, null);
    const content = readFileSync(path, "utf-8");
    assert.match(content, /mode: team/);
    assert.match(content, /My Custom Notes/);
    assert.match(content, /User-edited content here/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("writePreferencesFile \u2014 falls back to default body for new files", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-init-prefs-routing-"));
  const path = join(tmp, "PREFERENCES.md");
  const initBody = "\n# Init body marker\n";
  try {
    await writePreferencesFile(path, { mode: "solo" }, null, { defaultBody: initBody });
    const content = readFileSync(path, "utf-8");
    assert.match(content, /Init body marker/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("handlePrefsWizard \u2014 Advanced config writes min_request_interval_ms", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-init-prefs-routing-"));
  const path = join(tmp, "PREFERENCES.md");
  try {
    const selectResponses = [
      "Advanced",
      "(keep current)",
      "(keep current)",
      "(keep current)",
      "(keep current)",
      "(keep current)",
      "(keep current)",
      "(keep current)",
      "\u2500\u2500 Save & Exit \u2500\u2500"
    ];
    const inputResponses = ["250"];
    const ctx = {
      ui: {
        notify: () => {
        },
        select: async (_label, options) => {
          const response = selectResponses.shift();
          if (response === void 0) {
            throw new Error(
              `Unexpected extra select prompt in handlePrefsWizard flow: selectResponses queue exhausted for "${_label}" (expected no additional select prompts)`
            );
          }
          if (response === "Advanced") {
            const advancedOption = options.find((option) => option.startsWith("Advanced"));
            if (!advancedOption) {
              throw new Error(`Expected an "Advanced" option in "${_label}" menu`);
            }
            return advancedOption;
          }
          return response;
        },
        input: async () => {
          const response = inputResponses.shift();
          if (response === void 0) {
            throw new Error(
              "Unexpected extra input prompt in handlePrefsWizard flow: inputResponses queue exhausted (expected no additional input prompts)"
            );
          }
          return response;
        }
      },
      waitForIdle: async () => {
      },
      reload: async () => {
      }
    };
    await handlePrefsWizard(ctx, "project", {}, { pathOverride: path });
    assert.equal(selectResponses.length, 0, "Expected all queued selectResponses to be consumed");
    assert.equal(inputResponses.length, 0, "Expected all queued inputResponses to be consumed");
    const content = readFileSync(path, "utf-8");
    assert.match(content, /^min_request_interval_ms:\s*250$/m);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
test("init \u2014 Step 9b shape: 'not_yet' option is recognized as defer (#4457 review)", async () => {
  const { showNextAction } = await import("../../shared/tui.js");
  assert.equal(typeof showNextAction, "function");
  const src = readFileSync(
    new URL("../init-wizard.ts", import.meta.url),
    "utf-8"
  );
  assert.match(
    src,
    /reviewChoice === "not_yet"[\s\S]*?return \{ completed: false, bootstrapped: false \}/,
    "init Step 9b must short-circuit on not_yet without writing preferences"
  );
});
test("init \u2014 preferences path is basePath-derived, not cwd-derived (#4457 review)", async () => {
  const src = readFileSync(
    new URL("../init-wizard.ts", import.meta.url),
    "utf-8"
  );
  assert.match(
    src,
    /projectPrefsPath\s*=\s*join\(gsdRoot\(basePath\),\s*"PREFERENCES\.md"\)/,
    "init must derive the project preferences path from basePath"
  );
  assert.doesNotMatch(
    src,
    /getProjectGSDPreferencesPath\s*\(/,
    "init must not use the cwd-derived getProjectGSDPreferencesPath()"
  );
});
test("handlePrefsWizard \u2014 accepts pathOverride to target a non-cwd location", async () => {
  const { handlePrefsWizard: handlePrefsWizard2 } = await import("../commands-prefs-wizard.js");
  assert.equal(handlePrefsWizard2.length >= 2, true);
  const src = readFileSync(
    new URL("../commands-prefs-wizard.ts", import.meta.url),
    "utf-8"
  );
  assert.match(
    src,
    /opts\?\.pathOverride[\s\S]*?\?\?[\s\S]*?(getProjectGSDPreferencesPath|getGlobalGSDPreferencesPath)/,
    "handlePrefsWizard must honor opts.pathOverride before falling back to scope-derived path"
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9pbml0LXByZWZzLXJvdXRpbmcudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIFx1MjAxNCAvZ3NkIGluaXQgXHUyMTkyIHVuaWZpZWQgcHJlZmVyZW5jZXMtd3JpdGUgcm91dGluZyB0ZXN0cy5cbi8vXG4vLyBWZXJpZmllcyB0aGUgcmVmYWN0b3IgdGhhdCByb3V0ZXMgaW5pdCdzIHByZWZlcmVuY2VzIHdyaXRlIHRocm91Z2ggdGhlIHNhbWVcbi8vIHdyaXRlUHJlZmVyZW5jZXNGaWxlIGhlbHBlciB1c2VkIGJ5IGhhbmRsZVByZWZzV2l6YXJkLCBhbmQgdGhhdCB0aGUgdHlwZWRcbi8vIFByb2plY3RQcmVmZXJlbmNlcyBzaGFwZSBtYXBzIGNvcnJlY3RseSBpbnRvIHRoZSB3aXphcmQnc1xuLy8gUmVjb3JkPHN0cmluZywgdW5rbm93bj4gc2hhcGUuXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgeyBtYXBJbml0UHJlZnNUb1dpemFyZFNoYXBlIH0gZnJvbSBcIi4uL2luaXQtd2l6YXJkLnRzXCI7XG5pbXBvcnQgeyBoYW5kbGVQcmVmc1dpemFyZCwgd3JpdGVQcmVmZXJlbmNlc0ZpbGUgfSBmcm9tIFwiLi4vY29tbWFuZHMtcHJlZnMtd2l6YXJkLnRzXCI7XG5cbnRlc3QoXCJtYXBJbml0UHJlZnNUb1dpemFyZFNoYXBlIFx1MjAxNCBmdWxsIHJvdW5kdHJpcCB3aXRoIGFsbCBmaWVsZHNcIiwgKCkgPT4ge1xuICBjb25zdCBvdXQgPSBtYXBJbml0UHJlZnNUb1dpemFyZFNoYXBlKHtcbiAgICBtb2RlOiBcInRlYW1cIixcbiAgICBnaXRJc29sYXRpb246IFwiYnJhbmNoXCIsXG4gICAgbWFpbkJyYW5jaDogXCJkZXZlbG9wXCIsXG4gICAgdmVyaWZpY2F0aW9uQ29tbWFuZHM6IFtcIm5wbSB0ZXN0XCIsIFwibnBtIHJ1biBsaW50XCJdLFxuICAgIGN1c3RvbUluc3RydWN0aW9uczogW1wiVXNlIFR5cGVTY3JpcHQgc3RyaWN0IG1vZGVcIiwgXCJBbHdheXMgd3JpdGUgdGVzdHNcIl0sXG4gICAgdG9rZW5Qcm9maWxlOiBcInF1YWxpdHlcIixcbiAgICBza2lwUmVzZWFyY2g6IHRydWUsXG4gICAgYXV0b1B1c2g6IGZhbHNlLFxuICB9KTtcblxuICBhc3NlcnQuZXF1YWwob3V0Lm1vZGUsIFwidGVhbVwiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChvdXQuZ2l0LCB7IGlzb2xhdGlvbjogXCJicmFuY2hcIiwgbWFpbl9icmFuY2g6IFwiZGV2ZWxvcFwiLCBhdXRvX3B1c2g6IGZhbHNlIH0pO1xuICBhc3NlcnQuZGVlcEVxdWFsKG91dC52ZXJpZmljYXRpb25fY29tbWFuZHMsIFtcIm5wbSB0ZXN0XCIsIFwibnBtIHJ1biBsaW50XCJdKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChvdXQuY3VzdG9tX2luc3RydWN0aW9ucywgW1wiVXNlIFR5cGVTY3JpcHQgc3RyaWN0IG1vZGVcIiwgXCJBbHdheXMgd3JpdGUgdGVzdHNcIl0pO1xuICBhc3NlcnQuZXF1YWwob3V0LnRva2VuX3Byb2ZpbGUsIFwicXVhbGl0eVwiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChvdXQucGhhc2VzLCB7IHNraXBfcmVzZWFyY2g6IHRydWUgfSk7XG59KTtcblxudGVzdChcIm1hcEluaXRQcmVmc1RvV2l6YXJkU2hhcGUgXHUyMDE0IG9taXRzIGRlZmF1bHRzIHRvIGtlZXAgWUFNTCBjbGVhblwiLCAoKSA9PiB7XG4gIGNvbnN0IG91dCA9IG1hcEluaXRQcmVmc1RvV2l6YXJkU2hhcGUoe1xuICAgIG1vZGU6IFwic29sb1wiLFxuICAgIGdpdElzb2xhdGlvbjogXCJ3b3JrdHJlZVwiLFxuICAgIG1haW5CcmFuY2g6IFwibWFpblwiLFxuICAgIHZlcmlmaWNhdGlvbkNvbW1hbmRzOiBbXSxcbiAgICBjdXN0b21JbnN0cnVjdGlvbnM6IFtdLFxuICAgIHRva2VuUHJvZmlsZTogXCJiYWxhbmNlZFwiLFxuICAgIHNraXBSZXNlYXJjaDogZmFsc2UsXG4gICAgYXV0b1B1c2g6IHRydWUsXG4gIH0pO1xuXG4gIC8vIHRva2VuUHJvZmlsZT1iYWxhbmNlZCBpcyB0aGUgZGVmYXVsdCBcdTIwMTQgc2hvdWxkIG5vdCBiZSBzZXJpYWxpemVkLlxuICBhc3NlcnQuZXF1YWwob3V0LnRva2VuX3Byb2ZpbGUsIHVuZGVmaW5lZCk7XG4gIC8vIHNraXBSZXNlYXJjaD1mYWxzZSBpcyB0aGUgZGVmYXVsdCBcdTIwMTQgcGhhc2VzIHNob3VsZCBub3QgYXBwZWFyLlxuICBhc3NlcnQuZXF1YWwob3V0LnBoYXNlcywgdW5kZWZpbmVkKTtcbiAgLy8gRW1wdHkgYXJyYXlzIHNob3VsZCBub3QgYmUgc2VyaWFsaXplZC5cbiAgYXNzZXJ0LmVxdWFsKG91dC52ZXJpZmljYXRpb25fY29tbWFuZHMsIHVuZGVmaW5lZCk7XG4gIGFzc2VydC5lcXVhbChvdXQuY3VzdG9tX2luc3RydWN0aW9ucywgdW5kZWZpbmVkKTtcbn0pO1xuXG50ZXN0KFwid3JpdGVQcmVmZXJlbmNlc0ZpbGUgXHUyMDE0IHdyaXRlcyB2YWxpZCBmcm9udG1hdHRlciBmcm9tIHByZWZpbGxcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1pbml0LXByZWZzLXJvdXRpbmctXCIpKTtcbiAgY29uc3QgcGF0aCA9IGpvaW4odG1wLCBcIlBSRUZFUkVOQ0VTLm1kXCIpO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcHJlZnMgPSBtYXBJbml0UHJlZnNUb1dpemFyZFNoYXBlKHtcbiAgICAgIG1vZGU6IFwic29sb1wiLFxuICAgICAgZ2l0SXNvbGF0aW9uOiBcIndvcmt0cmVlXCIsXG4gICAgICBtYWluQnJhbmNoOiBcIm1haW5cIixcbiAgICAgIHZlcmlmaWNhdGlvbkNvbW1hbmRzOiBbXCJucG0gdGVzdFwiXSxcbiAgICAgIGN1c3RvbUluc3RydWN0aW9uczogW10sXG4gICAgICB0b2tlblByb2ZpbGU6IFwiYmFsYW5jZWRcIixcbiAgICAgIHNraXBSZXNlYXJjaDogZmFsc2UsXG4gICAgICBhdXRvUHVzaDogdHJ1ZSxcbiAgICB9KTtcblxuICAgIGF3YWl0IHdyaXRlUHJlZmVyZW5jZXNGaWxlKHBhdGgsIHByZWZzLCBudWxsLCB7IHNjb3BlOiBcInByb2plY3RcIiB9KTtcblxuICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKTtcbiAgICBhc3NlcnQubWF0Y2goY29udGVudCwgL14tLS0vKTtcbiAgICBhc3NlcnQubWF0Y2goY29udGVudCwgL21vZGU6IHNvbG8vKTtcbiAgICBhc3NlcnQubWF0Y2goY29udGVudCwgL2dpdDovKTtcbiAgICBhc3NlcnQubWF0Y2goY29udGVudCwgL2lzb2xhdGlvbjogd29ya3RyZWUvKTtcbiAgICBhc3NlcnQubWF0Y2goY29udGVudCwgL21haW5fYnJhbmNoOiBtYWluLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNvbnRlbnQsIC9hdXRvX3B1c2g6IHRydWUvKTtcbiAgICBhc3NlcnQubWF0Y2goY29udGVudCwgL3ZlcmlmaWNhdGlvbl9jb21tYW5kczovKTtcbiAgICBhc3NlcnQubWF0Y2goY29udGVudCwgLy0gbnBtIHRlc3QvKTtcbiAgICAvLyB2ZXJzaW9uOiAxIGlzIGFkZGVkIGJ5IHdyaXRlUHJlZmVyZW5jZXNGaWxlIGlmIG1pc3NpbmdcbiAgICBhc3NlcnQubWF0Y2goY29udGVudCwgL3ZlcnNpb246IDEvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwid3JpdGVQcmVmZXJlbmNlc0ZpbGUgXHUyMDE0IHByZXNlcnZlcyBleGlzdGluZyBtYXJrZG93biBib2R5XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtaW5pdC1wcmVmcy1yb3V0aW5nLVwiKSk7XG4gIGNvbnN0IHBhdGggPSBqb2luKHRtcCwgXCJQUkVGRVJFTkNFUy5tZFwiKTtcbiAgY29uc3QgY3VzdG9tQm9keSA9IFwiXFxuIyBNeSBDdXN0b20gTm90ZXNcXG5cXG5Vc2VyLWVkaXRlZCBjb250ZW50IGhlcmUuXFxuXCI7XG5cbiAgdHJ5IHtcbiAgICAvLyBTZWVkIGZpbGUgd2l0aCBmcm9udG1hdHRlciArIGN1c3RvbSBib2R5XG4gICAgd3JpdGVGaWxlU3luYyhwYXRoLCBgLS0tXFxubW9kZTogc29sb1xcbnZlcnNpb246IDFcXG4tLS0ke2N1c3RvbUJvZHl9YCwgXCJ1dGYtOFwiKTtcblxuICAgIGF3YWl0IHdyaXRlUHJlZmVyZW5jZXNGaWxlKHBhdGgsIHsgbW9kZTogXCJ0ZWFtXCIsIHZlcnNpb246IDEgfSwgbnVsbCk7XG5cbiAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmLThcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKGNvbnRlbnQsIC9tb2RlOiB0ZWFtLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNvbnRlbnQsIC9NeSBDdXN0b20gTm90ZXMvKTtcbiAgICBhc3NlcnQubWF0Y2goY29udGVudCwgL1VzZXItZWRpdGVkIGNvbnRlbnQgaGVyZS8pO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJ3cml0ZVByZWZlcmVuY2VzRmlsZSBcdTIwMTQgZmFsbHMgYmFjayB0byBkZWZhdWx0IGJvZHkgZm9yIG5ldyBmaWxlc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWluaXQtcHJlZnMtcm91dGluZy1cIikpO1xuICBjb25zdCBwYXRoID0gam9pbih0bXAsIFwiUFJFRkVSRU5DRVMubWRcIik7XG4gIGNvbnN0IGluaXRCb2R5ID0gXCJcXG4jIEluaXQgYm9keSBtYXJrZXJcXG5cIjtcblxuICB0cnkge1xuICAgIGF3YWl0IHdyaXRlUHJlZmVyZW5jZXNGaWxlKHBhdGgsIHsgbW9kZTogXCJzb2xvXCIgfSwgbnVsbCwgeyBkZWZhdWx0Qm9keTogaW5pdEJvZHkgfSk7XG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0Zi04XCIpO1xuICAgIGFzc2VydC5tYXRjaChjb250ZW50LCAvSW5pdCBib2R5IG1hcmtlci8pO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJoYW5kbGVQcmVmc1dpemFyZCBcdTIwMTQgQWR2YW5jZWQgY29uZmlnIHdyaXRlcyBtaW5fcmVxdWVzdF9pbnRlcnZhbF9tc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHRtcCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWluaXQtcHJlZnMtcm91dGluZy1cIikpO1xuICBjb25zdCBwYXRoID0gam9pbih0bXAsIFwiUFJFRkVSRU5DRVMubWRcIik7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBzZWxlY3RSZXNwb25zZXMgPSBbXG4gICAgICBcIkFkdmFuY2VkXCIsXG4gICAgICBcIihrZWVwIGN1cnJlbnQpXCIsXG4gICAgICBcIihrZWVwIGN1cnJlbnQpXCIsXG4gICAgICBcIihrZWVwIGN1cnJlbnQpXCIsXG4gICAgICBcIihrZWVwIGN1cnJlbnQpXCIsXG4gICAgICBcIihrZWVwIGN1cnJlbnQpXCIsXG4gICAgICBcIihrZWVwIGN1cnJlbnQpXCIsXG4gICAgICBcIihrZWVwIGN1cnJlbnQpXCIsXG4gICAgICBcIlx1MjUwMFx1MjUwMCBTYXZlICYgRXhpdCBcdTI1MDBcdTI1MDBcIixcbiAgICBdO1xuICAgIGNvbnN0IGlucHV0UmVzcG9uc2VzID0gW1wiMjUwXCJdO1xuICAgIGNvbnN0IGN0eCA9IHtcbiAgICAgIHVpOiB7XG4gICAgICAgIG5vdGlmeTogKCkgPT4ge30sXG4gICAgICAgIHNlbGVjdDogYXN5bmMgKF9sYWJlbDogc3RyaW5nLCBvcHRpb25zOiBzdHJpbmdbXSkgPT4ge1xuICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gc2VsZWN0UmVzcG9uc2VzLnNoaWZ0KCk7XG4gICAgICAgICAgaWYgKHJlc3BvbnNlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgYFVuZXhwZWN0ZWQgZXh0cmEgc2VsZWN0IHByb21wdCBpbiBoYW5kbGVQcmVmc1dpemFyZCBmbG93OiBzZWxlY3RSZXNwb25zZXMgcXVldWUgZXhoYXVzdGVkIGZvciBcIiR7X2xhYmVsfVwiIGAgK1xuICAgICAgICAgICAgICAgIFwiKGV4cGVjdGVkIG5vIGFkZGl0aW9uYWwgc2VsZWN0IHByb21wdHMpXCIsXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAocmVzcG9uc2UgPT09IFwiQWR2YW5jZWRcIikge1xuICAgICAgICAgICAgY29uc3QgYWR2YW5jZWRPcHRpb24gPSBvcHRpb25zLmZpbmQoKG9wdGlvbikgPT4gb3B0aW9uLnN0YXJ0c1dpdGgoXCJBZHZhbmNlZFwiKSk7XG4gICAgICAgICAgICBpZiAoIWFkdmFuY2VkT3B0aW9uKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRXhwZWN0ZWQgYW4gXCJBZHZhbmNlZFwiIG9wdGlvbiBpbiBcIiR7X2xhYmVsfVwiIG1lbnVgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBhZHZhbmNlZE9wdGlvbjtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgICB9LFxuICAgICAgICBpbnB1dDogYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHJlc3BvbnNlID0gaW5wdXRSZXNwb25zZXMuc2hpZnQoKTtcbiAgICAgICAgICBpZiAocmVzcG9uc2UgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICBcIlVuZXhwZWN0ZWQgZXh0cmEgaW5wdXQgcHJvbXB0IGluIGhhbmRsZVByZWZzV2l6YXJkIGZsb3c6IGlucHV0UmVzcG9uc2VzIHF1ZXVlIGV4aGF1c3RlZCBcIiArXG4gICAgICAgICAgICAgICAgXCIoZXhwZWN0ZWQgbm8gYWRkaXRpb25hbCBpbnB1dCBwcm9tcHRzKVwiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIHdhaXRGb3JJZGxlOiBhc3luYyAoKSA9PiB7fSxcbiAgICAgIHJlbG9hZDogYXN5bmMgKCkgPT4ge30sXG4gICAgfTtcblxuICAgIGF3YWl0IGhhbmRsZVByZWZzV2l6YXJkKGN0eCBhcyBhbnksIFwicHJvamVjdFwiLCB7fSwgeyBwYXRoT3ZlcnJpZGU6IHBhdGggfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwoc2VsZWN0UmVzcG9uc2VzLmxlbmd0aCwgMCwgXCJFeHBlY3RlZCBhbGwgcXVldWVkIHNlbGVjdFJlc3BvbnNlcyB0byBiZSBjb25zdW1lZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoaW5wdXRSZXNwb25zZXMubGVuZ3RoLCAwLCBcIkV4cGVjdGVkIGFsbCBxdWV1ZWQgaW5wdXRSZXNwb25zZXMgdG8gYmUgY29uc3VtZWRcIik7XG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0Zi04XCIpO1xuICAgIGFzc2VydC5tYXRjaChjb250ZW50LCAvXm1pbl9yZXF1ZXN0X2ludGVydmFsX21zOlxccyoyNTAkL20pO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZWdyZXNzaW9uIHRlc3RzIGZyb20gIzQ0NTcgY29kZXggYWR2ZXJzYXJpYWwgcmV2aWV3IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiaW5pdCBcdTIwMTQgU3RlcCA5YiBzaGFwZTogJ25vdF95ZXQnIG9wdGlvbiBpcyByZWNvZ25pemVkIGFzIGRlZmVyICgjNDQ1NyByZXZpZXcpXCIsIGFzeW5jICgpID0+IHtcbiAgLy8gVGhlIGluaXQgd2l6YXJkIHJlbGllcyBvbiBzaG93TmV4dEFjdGlvbiBhbHdheXMgYXBwZW5kaW5nIGEgYG5vdF95ZXRgIGFjdGlvblxuICAvLyBhbmQgbWFwcGluZyBFc2NhcGUgdG8gaXQuIFRoZSBTdGVwIDliIGNvZGUgbXVzdCBleHBsaWNpdGx5IGhhbmRsZSBgbm90X3lldGBcbiAgLy8gYXMgZGVmZXIgKHJldHVybiB3aXRob3V0IGJvb3RzdHJhcHBpbmcgb3IgcGVyc2lzdGluZyBwcmVmcykuIFRoaXMgdGVzdFxuICAvLyBkb2N1bWVudHMgdGhlIGNvbnRyYWN0IFx1MjAxNCBpdCBkb2Vzbid0IGRyaXZlIHRoZSBmdWxsIHdpemFyZCwgYnV0IGl0IGxvY2tzIGluXG4gIC8vIHRoYXQgXCJub3RfeWV0XCIgaXMgdGhlIGNhbm9uaWNhbCBkZWZlciBzaWduYWwgc28gYSBmdXR1cmUgcmVmYWN0b3IgY2FuJ3RcbiAgLy8gc2lsZW50bHkgZHJvcCB0aGUgZXhwbGljaXQgYnJhbmNoLlxuICBjb25zdCB7IHNob3dOZXh0QWN0aW9uIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi8uLi9zaGFyZWQvdHVpLnRzXCIpIGFzIHsgc2hvd05leHRBY3Rpb246IHVua25vd24gfTtcbiAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBzaG93TmV4dEFjdGlvbiwgXCJmdW5jdGlvblwiKTtcblxuICAvLyBSZWFkIHRoZSBzb3VyY2UgdG8gYXNzZXJ0IFN0ZXAgOWIgZXhwbGljaXRseSBoYW5kbGVzIG5vdF95ZXQgXHUyMDE0IGEgc3RhdGljXG4gIC8vIHNtb2tlIHRlc3QgY2hlYXBlciB0aGFuIHNwaW5uaW5nIHVwIHRoZSBmdWxsIHdpemFyZCB3aXRoIGEgbW9ja2VkIGN0eC5cbiAgY29uc3Qgc3JjID0gcmVhZEZpbGVTeW5jKFxuICAgIG5ldyBVUkwoXCIuLi9pbml0LXdpemFyZC50c1wiLCBpbXBvcnQubWV0YS51cmwpLFxuICAgIFwidXRmLThcIixcbiAgKTtcbiAgYXNzZXJ0Lm1hdGNoKFxuICAgIHNyYyxcbiAgICAvcmV2aWV3Q2hvaWNlID09PSBcIm5vdF95ZXRcIltcXHNcXFNdKj9yZXR1cm4gXFx7IGNvbXBsZXRlZDogZmFsc2UsIGJvb3RzdHJhcHBlZDogZmFsc2UgXFx9LyxcbiAgICBcImluaXQgU3RlcCA5YiBtdXN0IHNob3J0LWNpcmN1aXQgb24gbm90X3lldCB3aXRob3V0IHdyaXRpbmcgcHJlZmVyZW5jZXNcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiaW5pdCBcdTIwMTQgcHJlZmVyZW5jZXMgcGF0aCBpcyBiYXNlUGF0aC1kZXJpdmVkLCBub3QgY3dkLWRlcml2ZWQgKCM0NDU3IHJldmlldylcIiwgYXN5bmMgKCkgPT4ge1xuICAvLyBJZiBiYXNlUGF0aCAhPT0gcHJvY2Vzcy5jd2QoKSwgcHJlZmVyZW5jZXMgbXVzdCBzdGlsbCB3cml0ZSB0b1xuICAvLyBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLCBub3QgdGhlIGN3ZC1kZXJpdmVkIHBhdGguXG4gIC8vIFN0YXRpYyBjaGVjazogdGhlIHBvc3QtIzQ0NTctcmV2aWV3IGNvZGUgY29uc3RydWN0cyB0aGUgcGF0aCBmcm9tIGdzZFJvb3QoYmFzZVBhdGgpLlxuICBjb25zdCBzcmMgPSByZWFkRmlsZVN5bmMoXG4gICAgbmV3IFVSTChcIi4uL2luaXQtd2l6YXJkLnRzXCIsIGltcG9ydC5tZXRhLnVybCksXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICBhc3NlcnQubWF0Y2goXG4gICAgc3JjLFxuICAgIC9wcm9qZWN0UHJlZnNQYXRoXFxzKj1cXHMqam9pblxcKGdzZFJvb3RcXChiYXNlUGF0aFxcKSxcXHMqXCJQUkVGRVJFTkNFU1xcLm1kXCJcXCkvLFxuICAgIFwiaW5pdCBtdXN0IGRlcml2ZSB0aGUgcHJvamVjdCBwcmVmZXJlbmNlcyBwYXRoIGZyb20gYmFzZVBhdGhcIixcbiAgKTtcbiAgLy8gQW5kIG5laXRoZXIgd3JpdGUgc2l0ZSBzaG91bGQgY2FsbCBnZXRQcm9qZWN0R1NEUHJlZmVyZW5jZXNQYXRoKCkgKHdoaWNoXG4gIC8vIHJlc29sdmVzIGZyb20gcHJvY2Vzcy5jd2QoKSkuXG4gIGFzc2VydC5kb2VzTm90TWF0Y2goXG4gICAgc3JjLFxuICAgIC9nZXRQcm9qZWN0R1NEUHJlZmVyZW5jZXNQYXRoXFxzKlxcKC8sXG4gICAgXCJpbml0IG11c3Qgbm90IHVzZSB0aGUgY3dkLWRlcml2ZWQgZ2V0UHJvamVjdEdTRFByZWZlcmVuY2VzUGF0aCgpXCIsXG4gICk7XG59KTtcblxudGVzdChcImhhbmRsZVByZWZzV2l6YXJkIFx1MjAxNCBhY2NlcHRzIHBhdGhPdmVycmlkZSB0byB0YXJnZXQgYSBub24tY3dkIGxvY2F0aW9uXCIsIGFzeW5jICgpID0+IHtcbiAgLy8gVGhlIHdpemFyZCdzIHNpZ25hdHVyZSBtdXN0IHN1cHBvcnQgcGF0aE92ZXJyaWRlIHNvIC9nc2QgaW5pdCBjYW4gcm91dGVcbiAgLy8gYm90aCB0aGUgcmV2aWV3IGFuZCBza2lwIGJyYW5jaGVzIHRvIHRoZSBiYXNlUGF0aC1kZXJpdmVkIHBhdGguXG4gIGNvbnN0IHsgaGFuZGxlUHJlZnNXaXphcmQgfSA9IGF3YWl0IGltcG9ydChcIi4uL2NvbW1hbmRzLXByZWZzLXdpemFyZC50c1wiKTtcbiAgYXNzZXJ0LmVxdWFsKGhhbmRsZVByZWZzV2l6YXJkLmxlbmd0aCA+PSAyLCB0cnVlKTtcbiAgLy8gUmVhZCBzb3VyY2UgdG8gY29uZmlybSB0aGUgb3B0cy5wYXRoT3ZlcnJpZGUgd2lyaW5nIGV4aXN0cyBcdTIwMTQgY2FsbGluZ1xuICAvLyBoYW5kbGVQcmVmc1dpemFyZCBlbmQtdG8tZW5kIHJlcXVpcmVzIGEgZnVsbCBFeHRlbnNpb25Db21tYW5kQ29udGV4dFxuICAvLyBtb2NrLCB3aGljaCBpcyBoZWF2aWVyIHRoYW4gdGhpcyBjb250cmFjdCBjaGVjayB3YXJyYW50cy5cbiAgY29uc3Qgc3JjID0gcmVhZEZpbGVTeW5jKFxuICAgIG5ldyBVUkwoXCIuLi9jb21tYW5kcy1wcmVmcy13aXphcmQudHNcIiwgaW1wb3J0Lm1ldGEudXJsKSxcbiAgICBcInV0Zi04XCIsXG4gICk7XG4gIGFzc2VydC5tYXRjaChcbiAgICBzcmMsXG4gICAgL29wdHNcXD9cXC5wYXRoT3ZlcnJpZGVbXFxzXFxTXSo/XFw/XFw/W1xcc1xcU10qPyhnZXRQcm9qZWN0R1NEUHJlZmVyZW5jZXNQYXRofGdldEdsb2JhbEdTRFByZWZlcmVuY2VzUGF0aCkvLFxuICAgIFwiaGFuZGxlUHJlZnNXaXphcmQgbXVzdCBob25vciBvcHRzLnBhdGhPdmVycmlkZSBiZWZvcmUgZmFsbGluZyBiYWNrIHRvIHNjb3BlLWRlcml2ZWQgcGF0aFwiLFxuICApO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFPQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxjQUFjLFFBQVEscUJBQXFCO0FBQ2pFLFNBQVMsY0FBYztBQUN2QixTQUFTLFlBQVk7QUFFckIsU0FBUyxp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
