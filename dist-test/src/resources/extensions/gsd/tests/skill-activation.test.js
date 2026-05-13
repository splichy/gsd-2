import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkills } from "@gsd/pi-coding-agent";
import {
  buildPlanMilestonePrompt,
  buildResearchMilestonePrompt,
  buildSkillActivationBlock
} from "../auto-prompts.js";
import { warnIfManifestHasMissingSkills } from "../skill-manifest.js";
import { _resetLogs, drainLogs, setStderrLoggingEnabled } from "../workflow-logger.js";
function makeTempBase() {
  return mkdtempSync(join(tmpdir(), "gsd-skill-activation-"));
}
function cleanup(base) {
  rmSync(base, { recursive: true, force: true });
}
function writeSkill(base, name, description) {
  const dir = join(base, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---
name: ${name}
description: ${description}
---

# ${name}
`);
}
function loadOnlyTestSkills(base) {
  loadSkills({ cwd: base, includeDefaults: false, skillPaths: [join(base, "skills")] });
}
function writeProjectPreferences(base, preferences) {
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), `---
${preferences}---
`);
}
function buildBlock(base, params = {}, preferences = {}) {
  return buildSkillActivationBlock({
    base,
    milestoneId: "M001",
    sliceId: "S01",
    ...params,
    preferences
  });
}
test("buildSkillActivationBlock does not auto-activate skills via broad context heuristic", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "react", "Use for React components, hooks, JSX, and frontend UI work.");
    writeSkill(base, "swiftui", "Use for SwiftUI views, iOS layout, and Apple platform UI work.");
    loadOnlyTestSkills(base);
    const result = buildBlock(base, {
      sliceTitle: "Build React dashboard",
      taskId: "T01",
      taskTitle: "Implement React settings panel"
    });
    assert.equal(result, "");
  } finally {
    cleanup(base);
  }
});
test("buildSkillActivationBlock activates skills via prefer_skills when context matches", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "react", "Use for React components, hooks, JSX, and frontend UI work.");
    writeSkill(base, "swiftui", "Use for SwiftUI views, iOS layout, and Apple platform UI work.");
    loadOnlyTestSkills(base);
    const result = buildBlock(base, {
      sliceTitle: "Build React dashboard",
      taskId: "T01",
      taskTitle: "Implement React settings panel"
    }, {
      prefer_skills: ["react"]
    });
    assert.match(result, /Call Skill\(\{ skill: 'react' \}\)/);
    assert.doesNotMatch(result, /swiftui/);
  } finally {
    cleanup(base);
  }
});
test("buildSkillActivationBlock includes always_use_skills from preferences using exact Skill tool format", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "swift-testing", "Use for Swift Testing assertions and verification patterns.");
    loadOnlyTestSkills(base);
    const result = buildBlock(base, { taskTitle: "Unrelated task title" }, {
      always_use_skills: ["swift-testing"]
    });
    assert.equal(result, "<skill_activation>Call Skill({ skill: 'swift-testing' }).</skill_activation>");
  } finally {
    cleanup(base);
  }
});
test("buildSkillActivationBlock includes skill_rules matches and task-plan skills_used", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "prisma", "Use for Prisma schema, migrations, and ORM queries.");
    writeSkill(base, "accessibility", "Use for accessibility, aria attributes, and keyboard support.");
    loadOnlyTestSkills(base);
    const taskPlan = [
      "---",
      "skills_used:",
      "  - accessibility",
      "---",
      "# T01: Example"
    ].join("\n");
    const result = buildBlock(base, {
      taskTitle: "Update prisma schema",
      taskPlanContent: taskPlan
    }, {
      skill_rules: [{ when: "prisma database schema", use: ["prisma"] }]
    });
    assert.match(result, /Call Skill\(\{ skill: 'accessibility' \}\)/);
    assert.match(result, /Call Skill\(\{ skill: 'prisma' \}\)/);
  } finally {
    cleanup(base);
  }
});
test("buildSkillActivationBlock honors avoid_skills against always_use_skills", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "react", "Use for React components and frontend UI work.");
    loadOnlyTestSkills(base);
    const result = buildBlock(base, {
      taskTitle: "Implement React settings panel"
    }, {
      always_use_skills: ["react"],
      avoid_skills: ["react"]
    });
    assert.equal(result, "");
  } finally {
    cleanup(base);
  }
});
test("buildSkillActivationBlock falls back cleanly when nothing matches", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "swiftui", "Use for SwiftUI apps.");
    loadOnlyTestSkills(base);
    const result = buildBlock(base, {
      taskTitle: "Plain text docs task"
    });
    assert.equal(result, "");
  } finally {
    cleanup(base);
  }
});
test("buildSkillActivationBlock does not activate skills from extraContext or taskPlanContent body", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "xcode-build", "Use for Xcode build workflows and iOS compilation.");
    writeSkill(base, "ableton-lom", "Use for Ableton Live Object Model scripting.");
    writeSkill(base, "frontend-design", "Use for frontend design systems and UI components.");
    loadOnlyTestSkills(base);
    const taskPlan = [
      "---",
      "skills_used: []",
      "---",
      "# T01: Build the API endpoint",
      "Use xcode-build patterns and frontend-design tokens."
    ].join("\n");
    const result = buildBlock(base, {
      taskTitle: "Build REST API",
      extraContext: ["Build workflow for iOS and Ableton integration testing"],
      taskPlanContent: taskPlan
    });
    assert.equal(result, "");
  } finally {
    cleanup(base);
  }
});
test("buildSkillActivationBlock rejects skill names with special characters", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "my-skill's", "Skill with apostrophe in name.");
    loadOnlyTestSkills(base);
    const result = buildBlock(base, {}, {
      always_use_skills: ["my-skill's"]
    });
    assert.equal(result, "");
  } finally {
    cleanup(base);
  }
});
test("buildSkillActivationBlock allows valid skill names and rejects invalid ones", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "react", "React skill.");
    writeSkill(base, "bad'name", "Injection attempt.");
    writeSkill(base, "good-skill-2", "Another valid skill.");
    loadOnlyTestSkills(base);
    const result = buildBlock(base, {}, {
      always_use_skills: ["react", "bad'name", "good-skill-2"]
    });
    assert.match(result, /skill_activation/);
    assert.match(result, /Call Skill\(\{ skill: 'react' \}\)/);
    assert.match(result, /Call Skill\(\{ skill: 'good-skill-2' \}\)/);
    assert.doesNotMatch(result, /bad'name/);
  } finally {
    cleanup(base);
  }
});
test("buildSkillActivationBlock: explicit always_use_skills bypass the unit-type manifest", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "write-docs", "Use when writing docs or RFCs.");
    writeSkill(base, "swiftui", "Use for SwiftUI views.");
    loadOnlyTestSkills(base);
    const result = buildBlock(base, { unitType: "research-milestone" }, {
      always_use_skills: ["write-docs", "swiftui"]
    });
    assert.match(result, /Call Skill\(\{ skill: 'write-docs' \}\)/);
    assert.match(result, /Call Skill\(\{ skill: 'swiftui' \}\)/);
  } finally {
    cleanup(base);
  }
});
test("buildSkillActivationBlock falls through to all skills for unknown unit type", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "swiftui", "Use for SwiftUI views.");
    loadOnlyTestSkills(base);
    const result = buildBlock(base, { unitType: "unknown-unit-type" }, {
      always_use_skills: ["swiftui"]
    });
    assert.match(result, /Call Skill\(\{ skill: 'swiftui' \}\)/);
  } finally {
    cleanup(base);
  }
});
test("buildSkillActivationBlock without unitType preserves pre-manifest behavior", () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "swiftui", "Use for SwiftUI views.");
    loadOnlyTestSkills(base);
    const result = buildBlock(base, {}, {
      always_use_skills: ["swiftui"]
    });
    assert.match(result, /Call Skill\(\{ skill: 'swiftui' \}\)/);
  } finally {
    cleanup(base);
  }
});
test("milestone prompt builders propagate always_use_skills through buildSkillActivationBlock", async () => {
  const base = makeTempBase();
  try {
    writeSkill(base, "write-docs", "Use when writing docs or RFCs.");
    writeSkill(base, "swiftui", "Use for SwiftUI views.");
    writeProjectPreferences(base, "always_use_skills:\n  - write-docs\n  - swiftui\n");
    loadOnlyTestSkills(base);
    const researchPrompt = await buildResearchMilestonePrompt("M001", "Test", base);
    assert.match(researchPrompt, /Call Skill\(\{ skill: 'write-docs' \}\)/);
    assert.match(researchPrompt, /Call Skill\(\{ skill: 'swiftui' \}\)/);
    const planPrompt = await buildPlanMilestonePrompt("M001", "Test", base);
    assert.match(planPrompt, /Call Skill\(\{ skill: 'write-docs' \}\)/);
    assert.match(planPrompt, /Call Skill\(\{ skill: 'swiftui' \}\)/);
  } finally {
    cleanup(base);
  }
});
test("skill manifest strict warnings require GSD_SKILL_MANIFEST_STRICT=1", (t) => {
  const previousStrict = process.env.GSD_SKILL_MANIFEST_STRICT;
  const previousStderr = setStderrLoggingEnabled(false);
  t.after(() => {
    if (previousStrict === void 0) {
      delete process.env.GSD_SKILL_MANIFEST_STRICT;
    } else {
      process.env.GSD_SKILL_MANIFEST_STRICT = previousStrict;
    }
    setStderrLoggingEnabled(previousStderr);
    _resetLogs();
  });
  process.env.GSD_SKILL_MANIFEST_STRICT = "0";
  _resetLogs();
  warnIfManifestHasMissingSkills("research-milestone", /* @__PURE__ */ new Set());
  assert.equal(drainLogs().length, 0, "strict=0 must preserve silent behavior");
  process.env.GSD_SKILL_MANIFEST_STRICT = "1";
  _resetLogs();
  warnIfManifestHasMissingSkills("research-milestone", /* @__PURE__ */ new Set());
  const logs = drainLogs();
  assert.ok(
    logs.some((log) => log.message.includes("skill-manifest: references uninstalled skill")),
    "strict=1 should warn about missing manifest entries"
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9za2lsbC1hY3RpdmF0aW9uLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgbG9hZFNraWxscyB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHtcbiAgYnVpbGRQbGFuTWlsZXN0b25lUHJvbXB0LFxuICBidWlsZFJlc2VhcmNoTWlsZXN0b25lUHJvbXB0LFxuICBidWlsZFNraWxsQWN0aXZhdGlvbkJsb2NrLFxufSBmcm9tIFwiLi4vYXV0by1wcm9tcHRzLmpzXCI7XG5pbXBvcnQgeyB3YXJuSWZNYW5pZmVzdEhhc01pc3NpbmdTa2lsbHMgfSBmcm9tIFwiLi4vc2tpbGwtbWFuaWZlc3QuanNcIjtcbmltcG9ydCB7IF9yZXNldExvZ3MsIGRyYWluTG9ncywgc2V0U3RkZXJyTG9nZ2luZ0VuYWJsZWQgfSBmcm9tIFwiLi4vd29ya2Zsb3ctbG9nZ2VyLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEdTRFByZWZlcmVuY2VzIH0gZnJvbSBcIi4uL3ByZWZlcmVuY2VzLmpzXCI7XG5cbmZ1bmN0aW9uIG1ha2VUZW1wQmFzZSgpOiBzdHJpbmcge1xuICByZXR1cm4gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtc2tpbGwtYWN0aXZhdGlvbi1cIikpO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwKGJhc2U6IHN0cmluZyk6IHZvaWQge1xuICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG5mdW5jdGlvbiB3cml0ZVNraWxsKGJhc2U6IHN0cmluZywgbmFtZTogc3RyaW5nLCBkZXNjcmlwdGlvbjogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGRpciA9IGpvaW4oYmFzZSwgXCJza2lsbHNcIiwgbmFtZSk7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIlNLSUxMLm1kXCIpLCBgLS0tXFxubmFtZTogJHtuYW1lfVxcbmRlc2NyaXB0aW9uOiAke2Rlc2NyaXB0aW9ufVxcbi0tLVxcblxcbiMgJHtuYW1lfVxcbmApO1xufVxuXG5mdW5jdGlvbiBsb2FkT25seVRlc3RTa2lsbHMoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIGxvYWRTa2lsbHMoeyBjd2Q6IGJhc2UsIGluY2x1ZGVEZWZhdWx0czogZmFsc2UsIHNraWxsUGF0aHM6IFtqb2luKGJhc2UsIFwic2tpbGxzXCIpXSB9KTtcbn1cblxuZnVuY3Rpb24gd3JpdGVQcm9qZWN0UHJlZmVyZW5jZXMoYmFzZTogc3RyaW5nLCBwcmVmZXJlbmNlczogc3RyaW5nKTogdm9pZCB7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJQUkVGRVJFTkNFUy5tZFwiKSwgYC0tLVxcbiR7cHJlZmVyZW5jZXN9LS0tXFxuYCk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkQmxvY2soXG4gIGJhc2U6IHN0cmluZyxcbiAgcGFyYW1zOiBQYXJ0aWFsPFBhcmFtZXRlcnM8dHlwZW9mIGJ1aWxkU2tpbGxBY3RpdmF0aW9uQmxvY2s+WzBdPiA9IHt9LFxuICBwcmVmZXJlbmNlczogR1NEUHJlZmVyZW5jZXMgPSB7fSxcbik6IHN0cmluZyB7XG4gIHJldHVybiBidWlsZFNraWxsQWN0aXZhdGlvbkJsb2NrKHtcbiAgICBiYXNlLFxuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICBzbGljZUlkOiBcIlMwMVwiLFxuICAgIC4uLnBhcmFtcyxcbiAgICBwcmVmZXJlbmNlcyxcbiAgfSk7XG59XG5cbnRlc3QoXCJidWlsZFNraWxsQWN0aXZhdGlvbkJsb2NrIGRvZXMgbm90IGF1dG8tYWN0aXZhdGUgc2tpbGxzIHZpYSBicm9hZCBjb250ZXh0IGhldXJpc3RpY1wiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVGVtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZVNraWxsKGJhc2UsIFwicmVhY3RcIiwgXCJVc2UgZm9yIFJlYWN0IGNvbXBvbmVudHMsIGhvb2tzLCBKU1gsIGFuZCBmcm9udGVuZCBVSSB3b3JrLlwiKTtcbiAgICB3cml0ZVNraWxsKGJhc2UsIFwic3dpZnR1aVwiLCBcIlVzZSBmb3IgU3dpZnRVSSB2aWV3cywgaU9TIGxheW91dCwgYW5kIEFwcGxlIHBsYXRmb3JtIFVJIHdvcmsuXCIpO1xuICAgIGxvYWRPbmx5VGVzdFNraWxscyhiYXNlKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGJ1aWxkQmxvY2soYmFzZSwge1xuICAgICAgc2xpY2VUaXRsZTogXCJCdWlsZCBSZWFjdCBkYXNoYm9hcmRcIixcbiAgICAgIHRhc2tJZDogXCJUMDFcIixcbiAgICAgIHRhc2tUaXRsZTogXCJJbXBsZW1lbnQgUmVhY3Qgc2V0dGluZ3MgcGFuZWxcIixcbiAgICB9KTtcblxuICAgIC8vIFNraWxscyBzaG91bGQgbm90IGJlIGFjdGl2YXRlZCBqdXN0IGJlY2F1c2UgdGhlaXIgbmFtZSBhcHBlYXJzIGluIHRhc2sgY29udGV4dC5cbiAgICAvLyBBY3RpdmF0aW9uIHJlcXVpcmVzIGV4cGxpY2l0IHByZWZlcmVuY2Ugc291cmNlcyAoYWx3YXlzX3VzZSwgc2tpbGxfcnVsZXMsIHByZWZlcl9za2lsbHMsIHNraWxsc191c2VkKS5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcIlwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcImJ1aWxkU2tpbGxBY3RpdmF0aW9uQmxvY2sgYWN0aXZhdGVzIHNraWxscyB2aWEgcHJlZmVyX3NraWxscyB3aGVuIGNvbnRleHQgbWF0Y2hlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVGVtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZVNraWxsKGJhc2UsIFwicmVhY3RcIiwgXCJVc2UgZm9yIFJlYWN0IGNvbXBvbmVudHMsIGhvb2tzLCBKU1gsIGFuZCBmcm9udGVuZCBVSSB3b3JrLlwiKTtcbiAgICB3cml0ZVNraWxsKGJhc2UsIFwic3dpZnR1aVwiLCBcIlVzZSBmb3IgU3dpZnRVSSB2aWV3cywgaU9TIGxheW91dCwgYW5kIEFwcGxlIHBsYXRmb3JtIFVJIHdvcmsuXCIpO1xuICAgIGxvYWRPbmx5VGVzdFNraWxscyhiYXNlKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGJ1aWxkQmxvY2soYmFzZSwge1xuICAgICAgc2xpY2VUaXRsZTogXCJCdWlsZCBSZWFjdCBkYXNoYm9hcmRcIixcbiAgICAgIHRhc2tJZDogXCJUMDFcIixcbiAgICAgIHRhc2tUaXRsZTogXCJJbXBsZW1lbnQgUmVhY3Qgc2V0dGluZ3MgcGFuZWxcIixcbiAgICB9LCB7XG4gICAgICBwcmVmZXJfc2tpbGxzOiBbXCJyZWFjdFwiXSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9DYWxsIFNraWxsXFwoXFx7IHNraWxsOiAncmVhY3QnIFxcfVxcKS8pO1xuICAgIGFzc2VydC5kb2VzTm90TWF0Y2gocmVzdWx0LCAvc3dpZnR1aS8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiYnVpbGRTa2lsbEFjdGl2YXRpb25CbG9jayBpbmNsdWRlcyBhbHdheXNfdXNlX3NraWxscyBmcm9tIHByZWZlcmVuY2VzIHVzaW5nIGV4YWN0IFNraWxsIHRvb2wgZm9ybWF0XCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUZW1wQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlU2tpbGwoYmFzZSwgXCJzd2lmdC10ZXN0aW5nXCIsIFwiVXNlIGZvciBTd2lmdCBUZXN0aW5nIGFzc2VydGlvbnMgYW5kIHZlcmlmaWNhdGlvbiBwYXR0ZXJucy5cIik7XG4gICAgbG9hZE9ubHlUZXN0U2tpbGxzKGJhc2UpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYnVpbGRCbG9jayhiYXNlLCB7IHRhc2tUaXRsZTogXCJVbnJlbGF0ZWQgdGFzayB0aXRsZVwiIH0sIHtcbiAgICAgIGFsd2F5c191c2Vfc2tpbGxzOiBbXCJzd2lmdC10ZXN0aW5nXCJdLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCI8c2tpbGxfYWN0aXZhdGlvbj5DYWxsIFNraWxsKHsgc2tpbGw6ICdzd2lmdC10ZXN0aW5nJyB9KS48L3NraWxsX2FjdGl2YXRpb24+XCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiYnVpbGRTa2lsbEFjdGl2YXRpb25CbG9jayBpbmNsdWRlcyBza2lsbF9ydWxlcyBtYXRjaGVzIGFuZCB0YXNrLXBsYW4gc2tpbGxzX3VzZWRcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRlbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVTa2lsbChiYXNlLCBcInByaXNtYVwiLCBcIlVzZSBmb3IgUHJpc21hIHNjaGVtYSwgbWlncmF0aW9ucywgYW5kIE9STSBxdWVyaWVzLlwiKTtcbiAgICB3cml0ZVNraWxsKGJhc2UsIFwiYWNjZXNzaWJpbGl0eVwiLCBcIlVzZSBmb3IgYWNjZXNzaWJpbGl0eSwgYXJpYSBhdHRyaWJ1dGVzLCBhbmQga2V5Ym9hcmQgc3VwcG9ydC5cIik7XG4gICAgbG9hZE9ubHlUZXN0U2tpbGxzKGJhc2UpO1xuXG4gICAgY29uc3QgdGFza1BsYW4gPSBbXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJza2lsbHNfdXNlZDpcIixcbiAgICAgIFwiICAtIGFjY2Vzc2liaWxpdHlcIixcbiAgICAgIFwiLS0tXCIsXG4gICAgICBcIiMgVDAxOiBFeGFtcGxlXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYnVpbGRCbG9jayhiYXNlLCB7XG4gICAgICB0YXNrVGl0bGU6IFwiVXBkYXRlIHByaXNtYSBzY2hlbWFcIixcbiAgICAgIHRhc2tQbGFuQ29udGVudDogdGFza1BsYW4sXG4gICAgfSwge1xuICAgICAgc2tpbGxfcnVsZXM6IFt7IHdoZW46IFwicHJpc21hIGRhdGFiYXNlIHNjaGVtYVwiLCB1c2U6IFtcInByaXNtYVwiXSB9XSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9DYWxsIFNraWxsXFwoXFx7IHNraWxsOiAnYWNjZXNzaWJpbGl0eScgXFx9XFwpLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdCwgL0NhbGwgU2tpbGxcXChcXHsgc2tpbGw6ICdwcmlzbWEnIFxcfVxcKS8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiYnVpbGRTa2lsbEFjdGl2YXRpb25CbG9jayBob25vcnMgYXZvaWRfc2tpbGxzIGFnYWluc3QgYWx3YXlzX3VzZV9za2lsbHNcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRlbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVTa2lsbChiYXNlLCBcInJlYWN0XCIsIFwiVXNlIGZvciBSZWFjdCBjb21wb25lbnRzIGFuZCBmcm9udGVuZCBVSSB3b3JrLlwiKTtcbiAgICBsb2FkT25seVRlc3RTa2lsbHMoYmFzZSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBidWlsZEJsb2NrKGJhc2UsIHtcbiAgICAgIHRhc2tUaXRsZTogXCJJbXBsZW1lbnQgUmVhY3Qgc2V0dGluZ3MgcGFuZWxcIixcbiAgICB9LCB7XG4gICAgICBhbHdheXNfdXNlX3NraWxsczogW1wicmVhY3RcIl0sXG4gICAgICBhdm9pZF9za2lsbHM6IFtcInJlYWN0XCJdLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJidWlsZFNraWxsQWN0aXZhdGlvbkJsb2NrIGZhbGxzIGJhY2sgY2xlYW5seSB3aGVuIG5vdGhpbmcgbWF0Y2hlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVGVtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZVNraWxsKGJhc2UsIFwic3dpZnR1aVwiLCBcIlVzZSBmb3IgU3dpZnRVSSBhcHBzLlwiKTtcbiAgICBsb2FkT25seVRlc3RTa2lsbHMoYmFzZSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBidWlsZEJsb2NrKGJhc2UsIHtcbiAgICAgIHRhc2tUaXRsZTogXCJQbGFpbiB0ZXh0IGRvY3MgdGFza1wiLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJidWlsZFNraWxsQWN0aXZhdGlvbkJsb2NrIGRvZXMgbm90IGFjdGl2YXRlIHNraWxscyBmcm9tIGV4dHJhQ29udGV4dCBvciB0YXNrUGxhbkNvbnRlbnQgYm9keVwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVGVtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZVNraWxsKGJhc2UsIFwieGNvZGUtYnVpbGRcIiwgXCJVc2UgZm9yIFhjb2RlIGJ1aWxkIHdvcmtmbG93cyBhbmQgaU9TIGNvbXBpbGF0aW9uLlwiKTtcbiAgICB3cml0ZVNraWxsKGJhc2UsIFwiYWJsZXRvbi1sb21cIiwgXCJVc2UgZm9yIEFibGV0b24gTGl2ZSBPYmplY3QgTW9kZWwgc2NyaXB0aW5nLlwiKTtcbiAgICB3cml0ZVNraWxsKGJhc2UsIFwiZnJvbnRlbmQtZGVzaWduXCIsIFwiVXNlIGZvciBmcm9udGVuZCBkZXNpZ24gc3lzdGVtcyBhbmQgVUkgY29tcG9uZW50cy5cIik7XG4gICAgbG9hZE9ubHlUZXN0U2tpbGxzKGJhc2UpO1xuXG4gICAgY29uc3QgdGFza1BsYW4gPSBbXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJza2lsbHNfdXNlZDogW11cIixcbiAgICAgIFwiLS0tXCIsXG4gICAgICBcIiMgVDAxOiBCdWlsZCB0aGUgQVBJIGVuZHBvaW50XCIsXG4gICAgICBcIlVzZSB4Y29kZS1idWlsZCBwYXR0ZXJucyBhbmQgZnJvbnRlbmQtZGVzaWduIHRva2Vucy5cIixcbiAgICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBidWlsZEJsb2NrKGJhc2UsIHtcbiAgICAgIHRhc2tUaXRsZTogXCJCdWlsZCBSRVNUIEFQSVwiLFxuICAgICAgZXh0cmFDb250ZXh0OiBbXCJCdWlsZCB3b3JrZmxvdyBmb3IgaU9TIGFuZCBBYmxldG9uIGludGVncmF0aW9uIHRlc3RpbmdcIl0sXG4gICAgICB0YXNrUGxhbkNvbnRlbnQ6IHRhc2tQbGFuLFxuICAgIH0pO1xuXG4gICAgLy8gTm9uZSBvZiB0aGVzZSBza2lsbHMgc2hvdWxkIGFjdGl2YXRlIFx1MjAxNCBleHRyYUNvbnRleHQgYW5kIHRhc2tQbGFuQ29udGVudCBib2R5XG4gICAgLy8gbXVzdCBub3QgYmUgdXNlZCBmb3IgaGV1cmlzdGljIG1hdGNoaW5nLlxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwiXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiYnVpbGRTa2lsbEFjdGl2YXRpb25CbG9jayByZWplY3RzIHNraWxsIG5hbWVzIHdpdGggc3BlY2lhbCBjaGFyYWN0ZXJzXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VUZW1wQmFzZSgpO1xuICB0cnkge1xuICAgIC8vIFNraWxsIG5hbWVzIHdpdGggcXVvdGVzLCBicmFjZXMsIG9yIG90aGVyIG5vbi1hbHBoYW51bWVyaWMgY2hhcmFjdGVycyBhcmVcbiAgICAvLyByZWplY3RlZCBieSB0aGUgU0FGRV9TS0lMTF9OQU1FIGd1YXJkIHRvIHByZXZlbnQgcHJvbXB0IGluamVjdGlvbi5cbiAgICB3cml0ZVNraWxsKGJhc2UsIFwibXktc2tpbGwnc1wiLCBcIlNraWxsIHdpdGggYXBvc3Ryb3BoZSBpbiBuYW1lLlwiKTtcbiAgICBsb2FkT25seVRlc3RTa2lsbHMoYmFzZSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBidWlsZEJsb2NrKGJhc2UsIHt9LCB7XG4gICAgICBhbHdheXNfdXNlX3NraWxsczogW1wibXktc2tpbGwnc1wiXSxcbiAgICB9KTtcblxuICAgIC8vIFVuc2FmZSBza2lsbCBuYW1lIGlzIGZpbHRlcmVkIG91dCBcdTIwMTQgZW1wdHkgcmVzdWx0XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJidWlsZFNraWxsQWN0aXZhdGlvbkJsb2NrIGFsbG93cyB2YWxpZCBza2lsbCBuYW1lcyBhbmQgcmVqZWN0cyBpbnZhbGlkIG9uZXNcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRlbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVTa2lsbChiYXNlLCBcInJlYWN0XCIsIFwiUmVhY3Qgc2tpbGwuXCIpO1xuICAgIHdyaXRlU2tpbGwoYmFzZSwgXCJiYWQnbmFtZVwiLCBcIkluamVjdGlvbiBhdHRlbXB0LlwiKTtcbiAgICB3cml0ZVNraWxsKGJhc2UsIFwiZ29vZC1za2lsbC0yXCIsIFwiQW5vdGhlciB2YWxpZCBza2lsbC5cIik7XG4gICAgbG9hZE9ubHlUZXN0U2tpbGxzKGJhc2UpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYnVpbGRCbG9jayhiYXNlLCB7fSwge1xuICAgICAgYWx3YXlzX3VzZV9za2lsbHM6IFtcInJlYWN0XCIsIFwiYmFkJ25hbWVcIiwgXCJnb29kLXNraWxsLTJcIl0sXG4gICAgfSk7XG5cbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvc2tpbGxfYWN0aXZhdGlvbi8pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9DYWxsIFNraWxsXFwoXFx7IHNraWxsOiAncmVhY3QnIFxcfVxcKS8pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9DYWxsIFNraWxsXFwoXFx7IHNraWxsOiAnZ29vZC1za2lsbC0yJyBcXH1cXCkvKTtcbiAgICBhc3NlcnQuZG9lc05vdE1hdGNoKHJlc3VsdCwgL2JhZCduYW1lLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQZXItdW5pdC10eXBlIHNraWxsIG1hbmlmZXN0IChSRkMgIzQ3NzkpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiYnVpbGRTa2lsbEFjdGl2YXRpb25CbG9jazogZXhwbGljaXQgYWx3YXlzX3VzZV9za2lsbHMgYnlwYXNzIHRoZSB1bml0LXR5cGUgbWFuaWZlc3RcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRlbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgLy8gd3JpdGUtZG9jcyBpcyBpbiB0aGUgcmVzZWFyY2gtbWlsZXN0b25lIG1hbmlmZXN0OyBzd2lmdHVpIGlzIG5vdC5cbiAgICAvLyBCb3RoIGFyZSBpbiBhbHdheXNfdXNlX3NraWxscyBcdTIwMTQgYSB1c2VyLWV4cGxpY2l0IHNvdXJjZSBcdTIwMTQgc28gQk9USFxuICAgIC8vIHNob3VsZCBhY3RpdmF0ZSByZWdhcmRsZXNzIG9mIHRoZSBtYW5pZmVzdC4gVXNlciBpbnRlbnQgd2lucyBvdmVyXG4gICAgLy8gdW5pdC10eXBlIGRlZmF1bHRzLiBTZWUgUkZDICM0Nzc5IGFuZCBza2lsbC1tYW5pZmVzdC50cyByYXRpb25hbGUuXG4gICAgd3JpdGVTa2lsbChiYXNlLCBcIndyaXRlLWRvY3NcIiwgXCJVc2Ugd2hlbiB3cml0aW5nIGRvY3Mgb3IgUkZDcy5cIik7XG4gICAgd3JpdGVTa2lsbChiYXNlLCBcInN3aWZ0dWlcIiwgXCJVc2UgZm9yIFN3aWZ0VUkgdmlld3MuXCIpO1xuICAgIGxvYWRPbmx5VGVzdFNraWxscyhiYXNlKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGJ1aWxkQmxvY2soYmFzZSwgeyB1bml0VHlwZTogXCJyZXNlYXJjaC1taWxlc3RvbmVcIiB9LCB7XG4gICAgICBhbHdheXNfdXNlX3NraWxsczogW1wid3JpdGUtZG9jc1wiLCBcInN3aWZ0dWlcIl0sXG4gICAgfSk7XG5cbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvQ2FsbCBTa2lsbFxcKFxceyBza2lsbDogJ3dyaXRlLWRvY3MnIFxcfVxcKS8pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9DYWxsIFNraWxsXFwoXFx7IHNraWxsOiAnc3dpZnR1aScgXFx9XFwpLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJidWlsZFNraWxsQWN0aXZhdGlvbkJsb2NrIGZhbGxzIHRocm91Z2ggdG8gYWxsIHNraWxscyBmb3IgdW5rbm93biB1bml0IHR5cGVcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRlbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVTa2lsbChiYXNlLCBcInN3aWZ0dWlcIiwgXCJVc2UgZm9yIFN3aWZ0VUkgdmlld3MuXCIpO1xuICAgIGxvYWRPbmx5VGVzdFNraWxscyhiYXNlKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGJ1aWxkQmxvY2soYmFzZSwgeyB1bml0VHlwZTogXCJ1bmtub3duLXVuaXQtdHlwZVwiIH0sIHtcbiAgICAgIGFsd2F5c191c2Vfc2tpbGxzOiBbXCJzd2lmdHVpXCJdLFxuICAgIH0pO1xuXG4gICAgLy8gVW5rbm93biB1bml0IHR5cGUgPSB3aWxkY2FyZCBmYWxsYmFjayAocHJlLW1hbmlmZXN0IGJlaGF2aW9yKS5cbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvQ2FsbCBTa2lsbFxcKFxceyBza2lsbDogJ3N3aWZ0dWknIFxcfVxcKS8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiYnVpbGRTa2lsbEFjdGl2YXRpb25CbG9jayB3aXRob3V0IHVuaXRUeXBlIHByZXNlcnZlcyBwcmUtbWFuaWZlc3QgYmVoYXZpb3JcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZVRlbXBCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVTa2lsbChiYXNlLCBcInN3aWZ0dWlcIiwgXCJVc2UgZm9yIFN3aWZ0VUkgdmlld3MuXCIpO1xuICAgIGxvYWRPbmx5VGVzdFNraWxscyhiYXNlKTtcblxuICAgIC8vIE5vIHVuaXRUeXBlIHBhcmFtIFx1MjAxNCBmaWx0ZXIgc2hvdWxkIG5vLW9wLlxuICAgIGNvbnN0IHJlc3VsdCA9IGJ1aWxkQmxvY2soYmFzZSwge30sIHtcbiAgICAgIGFsd2F5c191c2Vfc2tpbGxzOiBbXCJzd2lmdHVpXCJdLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdCwgL0NhbGwgU2tpbGxcXChcXHsgc2tpbGw6ICdzd2lmdHVpJyBcXH1cXCkvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcblxudGVzdChcIm1pbGVzdG9uZSBwcm9tcHQgYnVpbGRlcnMgcHJvcGFnYXRlIGFsd2F5c191c2Vfc2tpbGxzIHRocm91Z2ggYnVpbGRTa2lsbEFjdGl2YXRpb25CbG9ja1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlVGVtcEJhc2UoKTtcbiAgdHJ5IHtcbiAgICAvLyBCb3RoIHNraWxscyBhcmUgaW4gYWx3YXlzX3VzZV9za2lsbHMgXHUyMDE0IGV4cGxpY2l0IHVzZXIgaW50ZW50IGJ5cGFzc2VzXG4gICAgLy8gdGhlIHVuaXQtdHlwZSBtYW5pZmVzdCwgc28gYm90aCBhY3RpdmF0ZSBpbiBib3RoIG1pbGVzdG9uZSBmbG93cy5cbiAgICB3cml0ZVNraWxsKGJhc2UsIFwid3JpdGUtZG9jc1wiLCBcIlVzZSB3aGVuIHdyaXRpbmcgZG9jcyBvciBSRkNzLlwiKTtcbiAgICB3cml0ZVNraWxsKGJhc2UsIFwic3dpZnR1aVwiLCBcIlVzZSBmb3IgU3dpZnRVSSB2aWV3cy5cIik7XG4gICAgd3JpdGVQcm9qZWN0UHJlZmVyZW5jZXMoYmFzZSwgXCJhbHdheXNfdXNlX3NraWxsczpcXG4gIC0gd3JpdGUtZG9jc1xcbiAgLSBzd2lmdHVpXFxuXCIpO1xuICAgIGxvYWRPbmx5VGVzdFNraWxscyhiYXNlKTtcblxuICAgIGNvbnN0IHJlc2VhcmNoUHJvbXB0ID0gYXdhaXQgYnVpbGRSZXNlYXJjaE1pbGVzdG9uZVByb21wdChcIk0wMDFcIiwgXCJUZXN0XCIsIGJhc2UpO1xuICAgIGFzc2VydC5tYXRjaChyZXNlYXJjaFByb21wdCwgL0NhbGwgU2tpbGxcXChcXHsgc2tpbGw6ICd3cml0ZS1kb2NzJyBcXH1cXCkvKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzZWFyY2hQcm9tcHQsIC9DYWxsIFNraWxsXFwoXFx7IHNraWxsOiAnc3dpZnR1aScgXFx9XFwpLyk7XG5cbiAgICBjb25zdCBwbGFuUHJvbXB0ID0gYXdhaXQgYnVpbGRQbGFuTWlsZXN0b25lUHJvbXB0KFwiTTAwMVwiLCBcIlRlc3RcIiwgYmFzZSk7XG4gICAgYXNzZXJ0Lm1hdGNoKHBsYW5Qcm9tcHQsIC9DYWxsIFNraWxsXFwoXFx7IHNraWxsOiAnd3JpdGUtZG9jcycgXFx9XFwpLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHBsYW5Qcm9tcHQsIC9DYWxsIFNraWxsXFwoXFx7IHNraWxsOiAnc3dpZnR1aScgXFx9XFwpLyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJza2lsbCBtYW5pZmVzdCBzdHJpY3Qgd2FybmluZ3MgcmVxdWlyZSBHU0RfU0tJTExfTUFOSUZFU1RfU1RSSUNUPTFcIiwgKHQpID0+IHtcbiAgY29uc3QgcHJldmlvdXNTdHJpY3QgPSBwcm9jZXNzLmVudi5HU0RfU0tJTExfTUFOSUZFU1RfU1RSSUNUO1xuICBjb25zdCBwcmV2aW91c1N0ZGVyciA9IHNldFN0ZGVyckxvZ2dpbmdFbmFibGVkKGZhbHNlKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgaWYgKHByZXZpb3VzU3RyaWN0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfU0tJTExfTUFOSUZFU1RfU1RSSUNUO1xuICAgIH0gZWxzZSB7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfU0tJTExfTUFOSUZFU1RfU1RSSUNUID0gcHJldmlvdXNTdHJpY3Q7XG4gICAgfVxuICAgIHNldFN0ZGVyckxvZ2dpbmdFbmFibGVkKHByZXZpb3VzU3RkZXJyKTtcbiAgICBfcmVzZXRMb2dzKCk7XG4gIH0pO1xuXG4gIHByb2Nlc3MuZW52LkdTRF9TS0lMTF9NQU5JRkVTVF9TVFJJQ1QgPSBcIjBcIjtcbiAgX3Jlc2V0TG9ncygpO1xuICB3YXJuSWZNYW5pZmVzdEhhc01pc3NpbmdTa2lsbHMoXCJyZXNlYXJjaC1taWxlc3RvbmVcIiwgbmV3IFNldCgpKTtcbiAgYXNzZXJ0LmVxdWFsKGRyYWluTG9ncygpLmxlbmd0aCwgMCwgXCJzdHJpY3Q9MCBtdXN0IHByZXNlcnZlIHNpbGVudCBiZWhhdmlvclwiKTtcblxuICBwcm9jZXNzLmVudi5HU0RfU0tJTExfTUFOSUZFU1RfU1RSSUNUID0gXCIxXCI7XG4gIF9yZXNldExvZ3MoKTtcbiAgd2FybklmTWFuaWZlc3RIYXNNaXNzaW5nU2tpbGxzKFwicmVzZWFyY2gtbWlsZXN0b25lXCIsIG5ldyBTZXQoKSk7XG4gIGNvbnN0IGxvZ3MgPSBkcmFpbkxvZ3MoKTtcbiAgYXNzZXJ0Lm9rKFxuICAgIGxvZ3Muc29tZShsb2cgPT4gbG9nLm1lc3NhZ2UuaW5jbHVkZXMoXCJza2lsbC1tYW5pZmVzdDogcmVmZXJlbmNlcyB1bmluc3RhbGxlZCBza2lsbFwiKSksXG4gICAgXCJzdHJpY3Q9MSBzaG91bGQgd2FybiBhYm91dCBtaXNzaW5nIG1hbmlmZXN0IGVudHJpZXNcIixcbiAgKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsa0JBQWtCO0FBQzNCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsc0NBQXNDO0FBQy9DLFNBQVMsWUFBWSxXQUFXLCtCQUErQjtBQUcvRCxTQUFTLGVBQXVCO0FBQzlCLFNBQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyx1QkFBdUIsQ0FBQztBQUM1RDtBQUVBLFNBQVMsUUFBUSxNQUFvQjtBQUNuQyxTQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFDL0M7QUFFQSxTQUFTLFdBQVcsTUFBYyxNQUFjLGFBQTJCO0FBQ3pFLFFBQU0sTUFBTSxLQUFLLE1BQU0sVUFBVSxJQUFJO0FBQ3JDLFlBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xDLGdCQUFjLEtBQUssS0FBSyxVQUFVLEdBQUc7QUFBQSxRQUFjLElBQUk7QUFBQSxlQUFrQixXQUFXO0FBQUE7QUFBQTtBQUFBLElBQWMsSUFBSTtBQUFB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
