import { transformToGSD } from "../migrate/transformer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
function emptyProject(overrides = {}) {
  return {
    path: "/fake/.planning",
    project: null,
    roadmap: null,
    requirements: [],
    state: null,
    config: null,
    phases: {},
    quickTasks: [],
    milestones: [],
    research: [],
    validation: { valid: true, issues: [] },
    ...overrides
  };
}
function flatRoadmap(entries) {
  return {
    raw: entries.map((e) => `- [${e.done ? "x" : " "}] Phase ${e.number}: ${e.title}`).join("\n"),
    milestones: [],
    phases: entries
  };
}
function milestoneRoadmap(milestones) {
  return {
    raw: milestones.map((m) => `## ${m.id}: ${m.title}`).join("\n"),
    milestones,
    phases: []
  };
}
function roadmapEntry(number, title, done = false) {
  return { number, title, done, raw: `- [${done ? "x" : " "}] Phase ${number}: ${title}` };
}
function makePhase(dirName, number, slug, overrides = {}) {
  return {
    dirName,
    number,
    slug,
    plans: {},
    summaries: {},
    research: [],
    verifications: [],
    extraFiles: [],
    ...overrides
  };
}
function makePlan(planNumber, overrides = {}) {
  return {
    fileName: `00-${planNumber}-PLAN.md`,
    planNumber,
    frontmatter: {
      phase: "00",
      plan: planNumber,
      type: "implementation",
      wave: null,
      depends_on: [],
      files_modified: [],
      autonomous: false,
      must_haves: null
    },
    objective: `Objective for plan ${planNumber}`,
    tasks: [`Task 1 for plan ${planNumber}`],
    context: "",
    verification: "",
    successCriteria: "",
    raw: "",
    ...overrides
  };
}
function makeSummary(planNumber, overrides = {}) {
  return {
    fileName: `00-${planNumber}-SUMMARY.md`,
    planNumber,
    frontmatter: {
      phase: "00",
      plan: planNumber,
      subsystem: "core",
      tags: [],
      requires: [],
      provides: [`feature-${planNumber}`],
      affects: [],
      "tech-stack": [],
      "key-files": [`file-${planNumber}.ts`],
      "key-decisions": [`decision-${planNumber}`],
      "patterns-established": [],
      duration: "2h",
      completed: "2026-01-15"
    },
    body: `Summary body for plan ${planNumber}`,
    raw: "",
    ...overrides
  };
}
function makeRequirement(id, title, status = "active") {
  return { id, title, status, description: `Description for ${id}`, raw: "" };
}
function makeResearch(fileName, content) {
  return { fileName, content };
}
test("Scenario 1: Flat single-milestone", () => {
  const project = emptyProject({
    project: "# My Project\nA cool project.",
    roadmap: flatRoadmap([
      roadmapEntry(1, "setup"),
      roadmapEntry(2, "core-logic"),
      roadmapEntry(3, "polish")
    ]),
    phases: {
      "1-setup": makePhase("1-setup", 1, "setup", {
        plans: { "01": makePlan("01") }
      }),
      "2-core-logic": makePhase("2-core-logic", 2, "core-logic", {
        plans: { "01": makePlan("01"), "02": makePlan("02") }
      }),
      "3-polish": makePhase("3-polish", 3, "polish", {
        plans: { "01": makePlan("01") }
      })
    }
  });
  const result = transformToGSD(project);
  assert.deepStrictEqual(result.milestones.length, 1, "flat: produces 1 milestone");
  assert.ok(result.milestones[0]?.id === "M001", "flat: milestone ID is M001");
  assert.deepStrictEqual(result.milestones[0]?.slices.length, 3, "flat: 3 slices");
  assert.deepStrictEqual(result.milestones[0]?.slices[0]?.id, "S01", "flat: first slice is S01");
  assert.deepStrictEqual(result.milestones[0]?.slices[1]?.id, "S02", "flat: second slice is S02");
  assert.deepStrictEqual(result.milestones[0]?.slices[2]?.id, "S03", "flat: third slice is S03");
  assert.ok(result.milestones[0]?.slices[0]?.title.length > 0, "flat: slice title not empty");
  assert.deepStrictEqual(result.milestones[0]?.slices[0]?.tasks.length, 1, "flat: S01 has 1 task");
  assert.deepStrictEqual(result.milestones[0]?.slices[1]?.tasks.length, 2, "flat: S02 has 2 tasks");
  assert.deepStrictEqual(result.milestones[0]?.slices[2]?.tasks.length, 1, "flat: S03 has 1 task");
  assert.deepStrictEqual(result.milestones[0]?.slices[0]?.tasks[0]?.id, "T01", "flat: first task is T01");
  assert.deepStrictEqual(result.milestones[0]?.slices[1]?.tasks[1]?.id, "T02", "flat: second task in S02 is T02");
  assert.ok(result.projectContent.includes("My Project"), "flat: projectContent preserved");
  assert.deepStrictEqual(result.milestones[0]?.boundaryMap, [], "flat: boundaryMap defaults to empty");
});
test("Scenario 2: Multi-milestone", () => {
  const project = emptyProject({
    roadmap: milestoneRoadmap([
      {
        id: "v1",
        title: "Version One",
        collapsed: false,
        phases: [roadmapEntry(1, "alpha"), roadmapEntry(2, "beta")]
      },
      {
        id: "v2",
        title: "Version Two",
        collapsed: false,
        phases: [roadmapEntry(1, "gamma"), roadmapEntry(2, "delta"), roadmapEntry(3, "epsilon")]
      }
    ]),
    phases: {
      "1-alpha": makePhase("1-alpha", 1, "alpha", { plans: { "01": makePlan("01") } }),
      "2-beta": makePhase("2-beta", 2, "beta", { plans: { "01": makePlan("01") } }),
      "1-gamma": makePhase("1-gamma", 1, "gamma", { plans: { "01": makePlan("01") } }),
      "2-delta": makePhase("2-delta", 2, "delta", { plans: { "01": makePlan("01") } }),
      "3-epsilon": makePhase("3-epsilon", 3, "epsilon", { plans: { "01": makePlan("01") } })
    }
  });
  const result = transformToGSD(project);
  assert.deepStrictEqual(result.milestones.length, 2, "multi: 2 milestones");
  assert.deepStrictEqual(result.milestones[0]?.id, "M001", "multi: first milestone M001");
  assert.deepStrictEqual(result.milestones[1]?.id, "M002", "multi: second milestone M002");
  assert.deepStrictEqual(result.milestones[0]?.slices.length, 2, "multi: M001 has 2 slices");
  assert.deepStrictEqual(result.milestones[1]?.slices.length, 3, "multi: M002 has 3 slices");
  assert.deepStrictEqual(result.milestones[0]?.slices[0]?.id, "S01", "multi: M001 starts at S01");
  assert.deepStrictEqual(result.milestones[1]?.slices[0]?.id, "S01", "multi: M002 starts at S01");
  assert.deepStrictEqual(result.milestones[1]?.slices[2]?.id, "S03", "multi: M002 third slice is S03");
  assert.ok(result.milestones[0]?.title.length > 0, "multi: M001 has title");
  assert.ok(result.milestones[1]?.title.length > 0, "multi: M002 has title");
});
test("Scenario 3: Decimal phase ordering", () => {
  const project = emptyProject({
    roadmap: flatRoadmap([
      roadmapEntry(1, "foundation"),
      roadmapEntry(2, "main-feature"),
      roadmapEntry(2.1, "sub-feature-a"),
      roadmapEntry(2.2, "sub-feature-b"),
      roadmapEntry(3, "finalize")
    ]),
    phases: {
      "1-foundation": makePhase("1-foundation", 1, "foundation"),
      "2-main-feature": makePhase("2-main-feature", 2, "main-feature"),
      "2.1-sub-feature-a": makePhase("2.1-sub-feature-a", 2.1, "sub-feature-a"),
      "2.2-sub-feature-b": makePhase("2.2-sub-feature-b", 2.2, "sub-feature-b"),
      "3-finalize": makePhase("3-finalize", 3, "finalize")
    }
  });
  const result = transformToGSD(project);
  assert.deepStrictEqual(result.milestones[0]?.slices.length, 5, "decimal: 5 slices total");
  assert.deepStrictEqual(result.milestones[0]?.slices[0]?.id, "S01", "decimal: first is S01");
  assert.deepStrictEqual(result.milestones[0]?.slices[1]?.id, "S02", "decimal: second is S02");
  assert.deepStrictEqual(result.milestones[0]?.slices[2]?.id, "S03", "decimal: third is S03");
  assert.deepStrictEqual(result.milestones[0]?.slices[3]?.id, "S04", "decimal: fourth is S04");
  assert.deepStrictEqual(result.milestones[0]?.slices[4]?.id, "S05", "decimal: fifth is S05");
  assert.ok(
    result.milestones[0]?.slices[0]?.title.toLowerCase().includes("foundation"),
    "decimal: S01 is foundation (phase 1)"
  );
  assert.ok(
    result.milestones[0]?.slices[4]?.title.toLowerCase().includes("finalize"),
    "decimal: S05 is finalize (phase 3)"
  );
});
test("Scenario 4: Completion state mapping", () => {
  const project = emptyProject({
    roadmap: flatRoadmap([
      roadmapEntry(1, "done-phase", true),
      roadmapEntry(2, "active-phase", false)
    ]),
    phases: {
      "1-done-phase": makePhase("1-done-phase", 1, "done-phase", {
        plans: { "01": makePlan("01"), "02": makePlan("02") },
        summaries: {
          "01": makeSummary("01")
          // plan 02 has no summary → task not done
        }
      }),
      "2-active-phase": makePhase("2-active-phase", 2, "active-phase", {
        plans: { "01": makePlan("01") }
      })
    }
  });
  const result = transformToGSD(project);
  const doneSlice = result.milestones[0]?.slices[0];
  const activeSlice = result.milestones[0]?.slices[1];
  assert.ok(doneSlice?.done === true, "completion: done phase \u2192 done slice");
  assert.ok(activeSlice?.done === false, "completion: active phase \u2192 not-done slice");
  assert.ok(doneSlice?.tasks[0]?.done === true, "completion: plan with summary \u2192 done task");
  assert.ok(doneSlice?.tasks[1]?.done === false, "completion: plan without summary \u2192 not-done task");
  assert.ok(doneSlice?.tasks[0]?.summary !== null, "completion: done task has summary data");
  assert.ok(doneSlice?.tasks[1]?.summary === null, "completion: not-done task has null summary");
  assert.deepStrictEqual(doneSlice?.tasks[0]?.summary?.completedAt, "2026-01-15", "completion: summary completedAt from frontmatter");
  assert.deepStrictEqual(doneSlice?.tasks[0]?.summary?.duration, "2h", "completion: summary duration from frontmatter");
  assert.deepStrictEqual(doneSlice?.tasks[0]?.summary?.provides, ["feature-01"], "completion: summary provides from frontmatter");
  assert.deepStrictEqual(doneSlice?.tasks[0]?.summary?.keyFiles, ["file-01.ts"], "completion: summary keyFiles from frontmatter");
  assert.ok(doneSlice?.tasks[0]?.summary?.whatHappened?.includes("Summary body") ?? false, "completion: summary whatHappened from body");
  assert.ok(doneSlice?.summary !== null, "completion: done slice has slice summary");
  assert.ok(activeSlice?.summary === null, "completion: active slice has null summary");
  assert.deepStrictEqual(doneSlice?.tasks[0]?.estimate, "2h", "completion: task estimate from summary duration");
});
test("Scenario 5: Research consolidation", () => {
  const project = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, "researched-phase")]),
    research: [
      makeResearch("SUMMARY.md", "# Project Summary\nOverview content."),
      makeResearch("ARCHITECTURE.md", "# Architecture\nArch details."),
      makeResearch("PITFALLS.md", "# Pitfalls\nThings to avoid.")
    ],
    phases: {
      "1-researched-phase": makePhase("1-researched-phase", 1, "researched-phase", {
        research: [
          makeResearch("FEATURES.md", "# Phase Features\nFeature list.")
        ]
      })
    }
  });
  const result = transformToGSD(project);
  assert.ok(result.milestones[0]?.research !== null, "research: milestone has consolidated research");
  assert.ok(result.milestones[0]?.research.includes("Project Summary"), "research: includes SUMMARY content");
  assert.ok(result.milestones[0]?.research.includes("Architecture"), "research: includes ARCHITECTURE content");
  assert.ok(result.milestones[0]?.research.includes("Pitfalls"), "research: includes PITFALLS content");
  const summaryIdx = result.milestones[0]?.research.indexOf("Project Summary") ?? -1;
  const archIdx = result.milestones[0]?.research.indexOf("Architecture") ?? -1;
  const pitfallIdx = result.milestones[0]?.research.indexOf("Pitfalls") ?? -1;
  assert.ok(summaryIdx < archIdx, "research: SUMMARY before ARCHITECTURE in consolidated");
  assert.ok(archIdx < pitfallIdx, "research: ARCHITECTURE before PITFALLS in consolidated");
  const slice = result.milestones[0]?.slices[0];
  assert.ok(slice?.research !== null, "research: slice has phase research");
  assert.ok(slice?.research.includes("Phase Features"), "research: slice research includes phase content");
});
test("Scenario 6: Requirements classification", () => {
  const project = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, "req-phase")]),
    requirements: [
      makeRequirement("R001", "Core Feature", "active"),
      makeRequirement("R002", "Secondary Feature", "validated"),
      makeRequirement("R003", "Deferred Feature", "deferred")
    ],
    phases: {
      "1-req-phase": makePhase("1-req-phase", 1, "req-phase")
    }
  });
  const result = transformToGSD(project);
  assert.deepStrictEqual(result.requirements.length, 3, "requirements: 3 requirements");
  assert.deepStrictEqual(result.requirements[0]?.id, "R001", "requirements: first is R001");
  assert.deepStrictEqual(result.requirements[0]?.status, "active", "requirements: R001 status active");
  assert.deepStrictEqual(result.requirements[1]?.status, "validated", "requirements: R002 status validated");
  assert.deepStrictEqual(result.requirements[2]?.status, "deferred", "requirements: R003 status deferred");
  assert.ok(result.requirements[0]?.title === "Core Feature", "requirements: R001 title preserved");
  assert.ok(result.requirements[0]?.description.includes("Description for R001"), "requirements: R001 description preserved");
  assert.deepStrictEqual(result.requirements[0]?.class, "core-capability", "requirements: default class");
  assert.deepStrictEqual(result.requirements[0]?.source, "inferred", "requirements: default source");
  assert.deepStrictEqual(result.requirements[0]?.primarySlice, "none yet", "requirements: default primarySlice");
});
test("Scenario 7: Empty phase", () => {
  const project = emptyProject({
    roadmap: flatRoadmap([
      roadmapEntry(1, "empty-phase"),
      roadmapEntry(2, "non-empty-phase")
    ]),
    phases: {
      "1-empty-phase": makePhase("1-empty-phase", 1, "empty-phase"),
      "2-non-empty-phase": makePhase("2-non-empty-phase", 2, "non-empty-phase", {
        plans: { "01": makePlan("01") }
      })
    }
  });
  const result = transformToGSD(project);
  assert.deepStrictEqual(result.milestones[0]?.slices[0]?.tasks.length, 0, "empty: empty phase \u2192 0 tasks");
  assert.deepStrictEqual(result.milestones[0]?.slices[1]?.tasks.length, 1, "empty: non-empty phase \u2192 1 task");
  assert.ok(result.milestones[0]?.slices[0]?.id === "S01", "empty: empty slice still gets ID");
});
test("Scenario 8: Demo derivation", () => {
  const project = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, "demo-phase")]),
    phases: {
      "1-demo-phase": makePhase("1-demo-phase", 1, "demo-phase", {
        plans: {
          "01": makePlan("01", { objective: "Build the authentication system with JWT tokens." })
        }
      })
    }
  });
  const result = transformToGSD(project);
  assert.ok(result.milestones[0]?.slices[0]?.demo.length > 0, "demo: slice demo is not empty");
  assert.ok(
    result.milestones[0]?.slices[0]?.demo.includes("authentication") || result.milestones[0]?.slices[0]?.demo.includes("Build"),
    "demo: slice demo derived from first plan objective"
  );
  assert.ok(result.milestones[0]?.slices[0]?.goal.length > 0, "demo: slice goal is not empty");
});
test("Scenario 9: Field defaults", () => {
  const project = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, "defaults-phase")]),
    phases: {
      "1-defaults-phase": makePhase("1-defaults-phase", 1, "defaults-phase", {
        plans: {
          "01": makePlan("01", {
            frontmatter: {
              phase: "01",
              plan: "01",
              type: "implementation",
              wave: null,
              depends_on: [],
              files_modified: ["src/auth.ts", "src/db.ts"],
              autonomous: false,
              must_haves: { truths: ["Auth works", "DB connected"], artifacts: [], key_links: [] }
            }
          })
        }
      })
    }
  });
  const result = transformToGSD(project);
  const slice = result.milestones[0]?.slices[0];
  const task = slice?.tasks[0];
  assert.deepStrictEqual(slice?.risk, "medium", "defaults: slice risk defaults to medium");
  assert.deepStrictEqual(slice?.depends, [], "defaults: S01 has no depends");
  assert.ok(task?.description.length > 0, "defaults: task description not empty");
  assert.deepStrictEqual(task?.files, ["src/auth.ts", "src/db.ts"], "defaults: task files from frontmatter");
  assert.deepStrictEqual(task?.mustHaves, ["Auth works", "DB connected"], "defaults: task mustHaves from frontmatter");
  assert.deepStrictEqual(task?.done, false, "defaults: task without summary is not done");
  assert.deepStrictEqual(task?.estimate, "", "defaults: task without summary has empty estimate");
  assert.ok(task?.summary === null, "defaults: task without summary has null summary");
});
test("Scenario 10: Sequential depends", () => {
  const project = emptyProject({
    roadmap: flatRoadmap([
      roadmapEntry(1, "first"),
      roadmapEntry(2, "second"),
      roadmapEntry(3, "third")
    ]),
    phases: {
      "1-first": makePhase("1-first", 1, "first"),
      "2-second": makePhase("2-second", 2, "second"),
      "3-third": makePhase("3-third", 3, "third")
    }
  });
  const result = transformToGSD(project);
  const slices = result.milestones[0]?.slices;
  assert.deepStrictEqual(slices?.[0]?.depends, [], "depends: S01 has empty depends");
  assert.deepStrictEqual(slices?.[1]?.depends, ["S01"], "depends: S02 depends on S01");
  assert.deepStrictEqual(slices?.[2]?.depends, ["S02"], "depends: S03 depends on S02");
});
test("Scenario 11: Requirements edge cases", () => {
  const project = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, "req-edge")]),
    requirements: [
      makeRequirement("", "No ID Feature", "active"),
      makeRequirement("", "Another No ID", "validated"),
      makeRequirement("R005", "Has ID", "something-weird"),
      makeRequirement("R006", "Deferred One", "DEFERRED"),
      makeRequirement("AUTH-7", "Legacy ID", "active")
    ],
    phases: {
      "1-req-edge": makePhase("1-req-edge", 1, "req-edge")
    }
  });
  const result = transformToGSD(project);
  assert.deepStrictEqual(result.requirements[0]?.id, "R001", "req-edge: empty id gets R001");
  assert.deepStrictEqual(result.requirements[1]?.id, "R002", "req-edge: second empty id gets R002");
  assert.deepStrictEqual(result.requirements[2]?.id, "R005", "req-edge: existing id preserved");
  assert.deepStrictEqual(result.requirements[2]?.status, "active", "req-edge: unknown status normalized to active");
  assert.deepStrictEqual(result.requirements[3]?.status, "deferred", "req-edge: uppercase DEFERRED normalized");
  assert.deepStrictEqual(result.requirements[4]?.id, "R003", "req-edge: non-R legacy id gets next canonical id");
  assert.ok(result.requirements[4]?.description.includes("Legacy ID: AUTH-7"), "req-edge: original legacy id is preserved in description");
});
test("Scenario 12: Vision derivation", () => {
  const project1 = emptyProject({
    project: "# Cool Project\nA revolutionary tool for developers.",
    roadmap: flatRoadmap([roadmapEntry(1, "vision-phase")]),
    phases: { "1-vision-phase": makePhase("1-vision-phase", 1, "vision-phase") }
  });
  const result1 = transformToGSD(project1);
  assert.ok(result1.milestones[0]?.vision.includes("revolutionary"), "vision: derived from project first line");
  const project2 = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, "fallback")]),
    phases: { "1-fallback": makePhase("1-fallback", 1, "fallback") }
  });
  const result2 = transformToGSD(project2);
  assert.ok(result2.milestones[0]?.vision.length > 0, "vision: fallback is non-empty");
});
test("Scenario 13: Decisions content", () => {
  const project = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, "decision-phase", true)]),
    phases: {
      "1-decision-phase": makePhase("1-decision-phase", 1, "decision-phase", {
        plans: { "01": makePlan("01") },
        summaries: { "01": makeSummary("01") }
      })
    }
  });
  const result = transformToGSD(project);
  assert.ok(result.decisionsContent.includes("decision-01"), "decisions: extracts key-decisions from summaries");
  assert.ok(result.decisionsContent.includes("| D001 |"), "decisions: writes DB-importable decision ID");
  assert.ok(result.decisionsContent.includes("| # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |"), "decisions: writes canonical table header");
});
test("Scenario 14: No undefined values", () => {
  const project = emptyProject({
    project: "# Test\nDescription.",
    roadmap: flatRoadmap([
      roadmapEntry(1, "full-phase", true),
      roadmapEntry(2, "empty-phase", false)
    ]),
    requirements: [makeRequirement("R001", "Req", "active")],
    research: [makeResearch("SUMMARY.md", "Research content")],
    phases: {
      "1-full-phase": makePhase("1-full-phase", 1, "full-phase", {
        plans: { "01": makePlan("01") },
        summaries: { "01": makeSummary("01") },
        research: [makeResearch("FEATURES.md", "Features")]
      }),
      "2-empty-phase": makePhase("2-empty-phase", 2, "empty-phase")
    }
  });
  const result = transformToGSD(project);
  function checkNoUndefined(obj, path) {
    if (obj === void 0) {
      assert.ok(false, `no-undefined: ${path} is undefined`);
      return;
    }
    if (obj === null) return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        checkNoUndefined(obj[i], `${path}[${i}]`);
      }
    } else if (typeof obj === "object") {
      for (const [key, val] of Object.entries(obj)) {
        checkNoUndefined(val, `${path}.${key}`);
      }
    }
  }
  checkNoUndefined(result, "result");
  assert.ok(true, "no-undefined: deep check completed without finding undefined values");
});
test("Scenario 15: Empty research", () => {
  const project = emptyProject({
    roadmap: flatRoadmap([roadmapEntry(1, "no-research")]),
    phases: { "1-no-research": makePhase("1-no-research", 1, "no-research") }
  });
  const result = transformToGSD(project);
  assert.ok(result.milestones[0]?.research === null, "empty-research: milestone research is null");
  assert.ok(result.milestones[0]?.slices[0]?.research === null, "empty-research: slice research is null");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9taWdyYXRlLXRyYW5zZm9ybWVyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIE1pZ3JhdGlvbiB0cmFuc2Zvcm1lciB0ZXN0IHN1aXRlXG4vLyBUZXN0cyBmb3IgdHJhbnNmb3JtaW5nIHBhcnNlZCBQbGFubmluZ1Byb2plY3QgaW50byBHU0RQcm9qZWN0IHN0cnVjdHVyZXMuXG4vLyBVc2VzIHN5bnRoZXRpYyBpbi1tZW1vcnkgZml4dHVyZXMgXHUyMDE0IG5vIGZpbGVzeXN0ZW0gbmVlZGVkLlxuLy8gVHJhbnNmb3JtZXIgaXMgcHVyZTogUGxhbm5pbmdQcm9qZWN0IFx1MjE5MiBHU0RQcm9qZWN0LlxuXG5pbXBvcnQgeyB0cmFuc2Zvcm1Ub0dTRCB9IGZyb20gJy4uL21pZ3JhdGUvdHJhbnNmb3JtZXIudHMnO1xuaW1wb3J0IHR5cGUge1xuICBQbGFubmluZ1Byb2plY3QsXG4gIFBsYW5uaW5nUGhhc2UsXG4gIFBsYW5uaW5nUGxhbixcbiAgUGxhbm5pbmdTdW1tYXJ5LFxuICBQbGFubmluZ1JvYWRtYXAsXG4gIFBsYW5uaW5nUm9hZG1hcEVudHJ5LFxuICBQbGFubmluZ1JvYWRtYXBNaWxlc3RvbmUsXG4gIFBsYW5uaW5nUmVxdWlyZW1lbnQsXG4gIFBsYW5uaW5nUmVzZWFyY2gsXG4gIEdTRFByb2plY3QsXG4gIEdTRE1pbGVzdG9uZSxcbiAgR1NEU2xpY2UsXG4gIEdTRFRhc2ssXG59IGZyb20gJy4uL21pZ3JhdGUvdHlwZXMudHMnO1xuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBGaXh0dXJlIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGVtcHR5UHJvamVjdChvdmVycmlkZXM6IFBhcnRpYWw8UGxhbm5pbmdQcm9qZWN0PiA9IHt9KTogUGxhbm5pbmdQcm9qZWN0IHtcbiAgcmV0dXJuIHtcbiAgICBwYXRoOiAnL2Zha2UvLnBsYW5uaW5nJyxcbiAgICBwcm9qZWN0OiBudWxsLFxuICAgIHJvYWRtYXA6IG51bGwsXG4gICAgcmVxdWlyZW1lbnRzOiBbXSxcbiAgICBzdGF0ZTogbnVsbCxcbiAgICBjb25maWc6IG51bGwsXG4gICAgcGhhc2VzOiB7fSxcbiAgICBxdWlja1Rhc2tzOiBbXSxcbiAgICBtaWxlc3RvbmVzOiBbXSxcbiAgICByZXNlYXJjaDogW10sXG4gICAgdmFsaWRhdGlvbjogeyB2YWxpZDogdHJ1ZSwgaXNzdWVzOiBbXSB9LFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbn1cblxuZnVuY3Rpb24gZmxhdFJvYWRtYXAoZW50cmllczogUGxhbm5pbmdSb2FkbWFwRW50cnlbXSk6IFBsYW5uaW5nUm9hZG1hcCB7XG4gIHJldHVybiB7XG4gICAgcmF3OiBlbnRyaWVzLm1hcCgoZSkgPT4gYC0gWyR7ZS5kb25lID8gJ3gnIDogJyAnfV0gUGhhc2UgJHtlLm51bWJlcn06ICR7ZS50aXRsZX1gKS5qb2luKCdcXG4nKSxcbiAgICBtaWxlc3RvbmVzOiBbXSxcbiAgICBwaGFzZXM6IGVudHJpZXMsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG1pbGVzdG9uZVJvYWRtYXAobWlsZXN0b25lczogUGxhbm5pbmdSb2FkbWFwTWlsZXN0b25lW10pOiBQbGFubmluZ1JvYWRtYXAge1xuICByZXR1cm4ge1xuICAgIHJhdzogbWlsZXN0b25lcy5tYXAoKG0pID0+IGAjIyAke20uaWR9OiAke20udGl0bGV9YCkuam9pbignXFxuJyksXG4gICAgbWlsZXN0b25lcyxcbiAgICBwaGFzZXM6IFtdLFxuICB9O1xufVxuXG5mdW5jdGlvbiByb2FkbWFwRW50cnkobnVtYmVyOiBudW1iZXIsIHRpdGxlOiBzdHJpbmcsIGRvbmUgPSBmYWxzZSk6IFBsYW5uaW5nUm9hZG1hcEVudHJ5IHtcbiAgcmV0dXJuIHsgbnVtYmVyLCB0aXRsZSwgZG9uZSwgcmF3OiBgLSBbJHtkb25lID8gJ3gnIDogJyAnfV0gUGhhc2UgJHtudW1iZXJ9OiAke3RpdGxlfWAgfTtcbn1cblxuZnVuY3Rpb24gbWFrZVBoYXNlKGRpck5hbWU6IHN0cmluZywgbnVtYmVyOiBudW1iZXIsIHNsdWc6IHN0cmluZywgb3ZlcnJpZGVzOiBQYXJ0aWFsPFBsYW5uaW5nUGhhc2U+ID0ge30pOiBQbGFubmluZ1BoYXNlIHtcbiAgcmV0dXJuIHtcbiAgICBkaXJOYW1lLFxuICAgIG51bWJlcixcbiAgICBzbHVnLFxuICAgIHBsYW5zOiB7fSxcbiAgICBzdW1tYXJpZXM6IHt9LFxuICAgIHJlc2VhcmNoOiBbXSxcbiAgICB2ZXJpZmljYXRpb25zOiBbXSxcbiAgICBleHRyYUZpbGVzOiBbXSxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG1ha2VQbGFuKHBsYW5OdW1iZXI6IHN0cmluZywgb3ZlcnJpZGVzOiBQYXJ0aWFsPFBsYW5uaW5nUGxhbj4gPSB7fSk6IFBsYW5uaW5nUGxhbiB7XG4gIHJldHVybiB7XG4gICAgZmlsZU5hbWU6IGAwMC0ke3BsYW5OdW1iZXJ9LVBMQU4ubWRgLFxuICAgIHBsYW5OdW1iZXIsXG4gICAgZnJvbnRtYXR0ZXI6IHtcbiAgICAgIHBoYXNlOiAnMDAnLFxuICAgICAgcGxhbjogcGxhbk51bWJlcixcbiAgICAgIHR5cGU6ICdpbXBsZW1lbnRhdGlvbicsXG4gICAgICB3YXZlOiBudWxsLFxuICAgICAgZGVwZW5kc19vbjogW10sXG4gICAgICBmaWxlc19tb2RpZmllZDogW10sXG4gICAgICBhdXRvbm9tb3VzOiBmYWxzZSxcbiAgICAgIG11c3RfaGF2ZXM6IG51bGwsXG4gICAgfSxcbiAgICBvYmplY3RpdmU6IGBPYmplY3RpdmUgZm9yIHBsYW4gJHtwbGFuTnVtYmVyfWAsXG4gICAgdGFza3M6IFtgVGFzayAxIGZvciBwbGFuICR7cGxhbk51bWJlcn1gXSxcbiAgICBjb250ZXh0OiAnJyxcbiAgICB2ZXJpZmljYXRpb246ICcnLFxuICAgIHN1Y2Nlc3NDcml0ZXJpYTogJycsXG4gICAgcmF3OiAnJyxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG1ha2VTdW1tYXJ5KHBsYW5OdW1iZXI6IHN0cmluZywgb3ZlcnJpZGVzOiBQYXJ0aWFsPFBsYW5uaW5nU3VtbWFyeT4gPSB7fSk6IFBsYW5uaW5nU3VtbWFyeSB7XG4gIHJldHVybiB7XG4gICAgZmlsZU5hbWU6IGAwMC0ke3BsYW5OdW1iZXJ9LVNVTU1BUlkubWRgLFxuICAgIHBsYW5OdW1iZXIsXG4gICAgZnJvbnRtYXR0ZXI6IHtcbiAgICAgIHBoYXNlOiAnMDAnLFxuICAgICAgcGxhbjogcGxhbk51bWJlcixcbiAgICAgIHN1YnN5c3RlbTogJ2NvcmUnLFxuICAgICAgdGFnczogW10sXG4gICAgICByZXF1aXJlczogW10sXG4gICAgICBwcm92aWRlczogW2BmZWF0dXJlLSR7cGxhbk51bWJlcn1gXSxcbiAgICAgIGFmZmVjdHM6IFtdLFxuICAgICAgJ3RlY2gtc3RhY2snOiBbXSxcbiAgICAgICdrZXktZmlsZXMnOiBbYGZpbGUtJHtwbGFuTnVtYmVyfS50c2BdLFxuICAgICAgJ2tleS1kZWNpc2lvbnMnOiBbYGRlY2lzaW9uLSR7cGxhbk51bWJlcn1gXSxcbiAgICAgICdwYXR0ZXJucy1lc3RhYmxpc2hlZCc6IFtdLFxuICAgICAgZHVyYXRpb246ICcyaCcsXG4gICAgICBjb21wbGV0ZWQ6ICcyMDI2LTAxLTE1JyxcbiAgICB9LFxuICAgIGJvZHk6IGBTdW1tYXJ5IGJvZHkgZm9yIHBsYW4gJHtwbGFuTnVtYmVyfWAsXG4gICAgcmF3OiAnJyxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG1ha2VSZXF1aXJlbWVudChpZDogc3RyaW5nLCB0aXRsZTogc3RyaW5nLCBzdGF0dXMgPSAnYWN0aXZlJyk6IFBsYW5uaW5nUmVxdWlyZW1lbnQge1xuICByZXR1cm4geyBpZCwgdGl0bGUsIHN0YXR1cywgZGVzY3JpcHRpb246IGBEZXNjcmlwdGlvbiBmb3IgJHtpZH1gLCByYXc6ICcnIH07XG59XG5cbmZ1bmN0aW9uIG1ha2VSZXNlYXJjaChmaWxlTmFtZTogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiBQbGFubmluZ1Jlc2VhcmNoIHtcbiAgcmV0dXJuIHsgZmlsZU5hbWUsIGNvbnRlbnQgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDE6IEZsYXQgU2luZ2xlLU1pbGVzdG9uZSAoMyBwaGFzZXMgXHUyMTkyIE0wMDEgd2l0aCBTMDEvUzAyL1MwMykgXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ1NjZW5hcmlvIDE6IEZsYXQgc2luZ2xlLW1pbGVzdG9uZScsICgpID0+IHtcblxuICBjb25zdCBwcm9qZWN0ID0gZW1wdHlQcm9qZWN0KHtcbiAgICBwcm9qZWN0OiAnIyBNeSBQcm9qZWN0XFxuQSBjb29sIHByb2plY3QuJyxcbiAgICByb2FkbWFwOiBmbGF0Um9hZG1hcChbXG4gICAgICByb2FkbWFwRW50cnkoMSwgJ3NldHVwJyksXG4gICAgICByb2FkbWFwRW50cnkoMiwgJ2NvcmUtbG9naWMnKSxcbiAgICAgIHJvYWRtYXBFbnRyeSgzLCAncG9saXNoJyksXG4gICAgXSksXG4gICAgcGhhc2VzOiB7XG4gICAgICAnMS1zZXR1cCc6IG1ha2VQaGFzZSgnMS1zZXR1cCcsIDEsICdzZXR1cCcsIHtcbiAgICAgICAgcGxhbnM6IHsgJzAxJzogbWFrZVBsYW4oJzAxJykgfSxcbiAgICAgIH0pLFxuICAgICAgJzItY29yZS1sb2dpYyc6IG1ha2VQaGFzZSgnMi1jb3JlLWxvZ2ljJywgMiwgJ2NvcmUtbG9naWMnLCB7XG4gICAgICAgIHBsYW5zOiB7ICcwMSc6IG1ha2VQbGFuKCcwMScpLCAnMDInOiBtYWtlUGxhbignMDInKSB9LFxuICAgICAgfSksXG4gICAgICAnMy1wb2xpc2gnOiBtYWtlUGhhc2UoJzMtcG9saXNoJywgMywgJ3BvbGlzaCcsIHtcbiAgICAgICAgcGxhbnM6IHsgJzAxJzogbWFrZVBsYW4oJzAxJykgfSxcbiAgICAgIH0pLFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IHRyYW5zZm9ybVRvR1NEKHByb2plY3QpO1xuXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0Lm1pbGVzdG9uZXMubGVuZ3RoLCAxLCAnZmxhdDogcHJvZHVjZXMgMSBtaWxlc3RvbmUnKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5taWxlc3RvbmVzWzBdPy5pZCA9PT0gJ00wMDEnLCAnZmxhdDogbWlsZXN0b25lIElEIGlzIE0wMDEnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQubWlsZXN0b25lc1swXT8uc2xpY2VzLmxlbmd0aCwgMywgJ2ZsYXQ6IDMgc2xpY2VzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnNsaWNlc1swXT8uaWQsICdTMDEnLCAnZmxhdDogZmlyc3Qgc2xpY2UgaXMgUzAxJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnNsaWNlc1sxXT8uaWQsICdTMDInLCAnZmxhdDogc2Vjb25kIHNsaWNlIGlzIFMwMicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5taWxlc3RvbmVzWzBdPy5zbGljZXNbMl0/LmlkLCAnUzAzJywgJ2ZsYXQ6IHRoaXJkIHNsaWNlIGlzIFMwMycpO1xuICBhc3NlcnQub2socmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnNsaWNlc1swXT8udGl0bGUubGVuZ3RoID4gMCwgJ2ZsYXQ6IHNsaWNlIHRpdGxlIG5vdCBlbXB0eScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5taWxlc3RvbmVzWzBdPy5zbGljZXNbMF0/LnRhc2tzLmxlbmd0aCwgMSwgJ2ZsYXQ6IFMwMSBoYXMgMSB0YXNrJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnNsaWNlc1sxXT8udGFza3MubGVuZ3RoLCAyLCAnZmxhdDogUzAyIGhhcyAyIHRhc2tzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnNsaWNlc1syXT8udGFza3MubGVuZ3RoLCAxLCAnZmxhdDogUzAzIGhhcyAxIHRhc2snKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQubWlsZXN0b25lc1swXT8uc2xpY2VzWzBdPy50YXNrc1swXT8uaWQsICdUMDEnLCAnZmxhdDogZmlyc3QgdGFzayBpcyBUMDEnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQubWlsZXN0b25lc1swXT8uc2xpY2VzWzFdPy50YXNrc1sxXT8uaWQsICdUMDInLCAnZmxhdDogc2Vjb25kIHRhc2sgaW4gUzAyIGlzIFQwMicpO1xuICBhc3NlcnQub2socmVzdWx0LnByb2plY3RDb250ZW50LmluY2x1ZGVzKCdNeSBQcm9qZWN0JyksICdmbGF0OiBwcm9qZWN0Q29udGVudCBwcmVzZXJ2ZWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQubWlsZXN0b25lc1swXT8uYm91bmRhcnlNYXAsIFtdLCAnZmxhdDogYm91bmRhcnlNYXAgZGVmYXVsdHMgdG8gZW1wdHknKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gMjogTXVsdGktTWlsZXN0b25lICgyIG1pbGVzdG9uZXMgd2l0aCBpbmRlcGVuZGVudCBudW1iZXJpbmcpIFx1MjUwMFx1MjUwMFxuXG50ZXN0KCdTY2VuYXJpbyAyOiBNdWx0aS1taWxlc3RvbmUnLCAoKSA9PiB7XG5cbiAgY29uc3QgcHJvamVjdCA9IGVtcHR5UHJvamVjdCh7XG4gICAgcm9hZG1hcDogbWlsZXN0b25lUm9hZG1hcChbXG4gICAgICB7XG4gICAgICAgIGlkOiAndjEnLFxuICAgICAgICB0aXRsZTogJ1ZlcnNpb24gT25lJyxcbiAgICAgICAgY29sbGFwc2VkOiBmYWxzZSxcbiAgICAgICAgcGhhc2VzOiBbcm9hZG1hcEVudHJ5KDEsICdhbHBoYScpLCByb2FkbWFwRW50cnkoMiwgJ2JldGEnKV0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogJ3YyJyxcbiAgICAgICAgdGl0bGU6ICdWZXJzaW9uIFR3bycsXG4gICAgICAgIGNvbGxhcHNlZDogZmFsc2UsXG4gICAgICAgIHBoYXNlczogW3JvYWRtYXBFbnRyeSgxLCAnZ2FtbWEnKSwgcm9hZG1hcEVudHJ5KDIsICdkZWx0YScpLCByb2FkbWFwRW50cnkoMywgJ2Vwc2lsb24nKV0sXG4gICAgICB9LFxuICAgIF0pLFxuICAgIHBoYXNlczoge1xuICAgICAgJzEtYWxwaGEnOiBtYWtlUGhhc2UoJzEtYWxwaGEnLCAxLCAnYWxwaGEnLCB7IHBsYW5zOiB7ICcwMSc6IG1ha2VQbGFuKCcwMScpIH0gfSksXG4gICAgICAnMi1iZXRhJzogbWFrZVBoYXNlKCcyLWJldGEnLCAyLCAnYmV0YScsIHsgcGxhbnM6IHsgJzAxJzogbWFrZVBsYW4oJzAxJykgfSB9KSxcbiAgICAgICcxLWdhbW1hJzogbWFrZVBoYXNlKCcxLWdhbW1hJywgMSwgJ2dhbW1hJywgeyBwbGFuczogeyAnMDEnOiBtYWtlUGxhbignMDEnKSB9IH0pLFxuICAgICAgJzItZGVsdGEnOiBtYWtlUGhhc2UoJzItZGVsdGEnLCAyLCAnZGVsdGEnLCB7IHBsYW5zOiB7ICcwMSc6IG1ha2VQbGFuKCcwMScpIH0gfSksXG4gICAgICAnMy1lcHNpbG9uJzogbWFrZVBoYXNlKCczLWVwc2lsb24nLCAzLCAnZXBzaWxvbicsIHsgcGxhbnM6IHsgJzAxJzogbWFrZVBsYW4oJzAxJykgfSB9KSxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSB0cmFuc2Zvcm1Ub0dTRChwcm9qZWN0KTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5taWxlc3RvbmVzLmxlbmd0aCwgMiwgJ211bHRpOiAyIG1pbGVzdG9uZXMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQubWlsZXN0b25lc1swXT8uaWQsICdNMDAxJywgJ211bHRpOiBmaXJzdCBtaWxlc3RvbmUgTTAwMScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5taWxlc3RvbmVzWzFdPy5pZCwgJ00wMDInLCAnbXVsdGk6IHNlY29uZCBtaWxlc3RvbmUgTTAwMicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5taWxlc3RvbmVzWzBdPy5zbGljZXMubGVuZ3RoLCAyLCAnbXVsdGk6IE0wMDEgaGFzIDIgc2xpY2VzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0Lm1pbGVzdG9uZXNbMV0/LnNsaWNlcy5sZW5ndGgsIDMsICdtdWx0aTogTTAwMiBoYXMgMyBzbGljZXMnKTtcbiAgLy8gSW5kZXBlbmRlbnQgbnVtYmVyaW5nOiBib3RoIHN0YXJ0IGF0IFMwMVxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5taWxlc3RvbmVzWzBdPy5zbGljZXNbMF0/LmlkLCAnUzAxJywgJ211bHRpOiBNMDAxIHN0YXJ0cyBhdCBTMDEnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQubWlsZXN0b25lc1sxXT8uc2xpY2VzWzBdPy5pZCwgJ1MwMScsICdtdWx0aTogTTAwMiBzdGFydHMgYXQgUzAxJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0Lm1pbGVzdG9uZXNbMV0/LnNsaWNlc1syXT8uaWQsICdTMDMnLCAnbXVsdGk6IE0wMDIgdGhpcmQgc2xpY2UgaXMgUzAzJyk7XG4gIGFzc2VydC5vayhyZXN1bHQubWlsZXN0b25lc1swXT8udGl0bGUubGVuZ3RoID4gMCwgJ211bHRpOiBNMDAxIGhhcyB0aXRsZScpO1xuICBhc3NlcnQub2socmVzdWx0Lm1pbGVzdG9uZXNbMV0/LnRpdGxlLmxlbmd0aCA+IDAsICdtdWx0aTogTTAwMiBoYXMgdGl0bGUnKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gMzogRGVjaW1hbCBQaGFzZSBPcmRlcmluZyAoMSwgMiwgMi4xLCAyLjIsIDMgXHUyMTkyIFMwMVx1MjAxM1MwNSkgXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ1NjZW5hcmlvIDM6IERlY2ltYWwgcGhhc2Ugb3JkZXJpbmcnLCAoKSA9PiB7XG5cbiAgY29uc3QgcHJvamVjdCA9IGVtcHR5UHJvamVjdCh7XG4gICAgcm9hZG1hcDogZmxhdFJvYWRtYXAoW1xuICAgICAgcm9hZG1hcEVudHJ5KDEsICdmb3VuZGF0aW9uJyksXG4gICAgICByb2FkbWFwRW50cnkoMiwgJ21haW4tZmVhdHVyZScpLFxuICAgICAgcm9hZG1hcEVudHJ5KDIuMSwgJ3N1Yi1mZWF0dXJlLWEnKSxcbiAgICAgIHJvYWRtYXBFbnRyeSgyLjIsICdzdWItZmVhdHVyZS1iJyksXG4gICAgICByb2FkbWFwRW50cnkoMywgJ2ZpbmFsaXplJyksXG4gICAgXSksXG4gICAgcGhhc2VzOiB7XG4gICAgICAnMS1mb3VuZGF0aW9uJzogbWFrZVBoYXNlKCcxLWZvdW5kYXRpb24nLCAxLCAnZm91bmRhdGlvbicpLFxuICAgICAgJzItbWFpbi1mZWF0dXJlJzogbWFrZVBoYXNlKCcyLW1haW4tZmVhdHVyZScsIDIsICdtYWluLWZlYXR1cmUnKSxcbiAgICAgICcyLjEtc3ViLWZlYXR1cmUtYSc6IG1ha2VQaGFzZSgnMi4xLXN1Yi1mZWF0dXJlLWEnLCAyLjEsICdzdWItZmVhdHVyZS1hJyksXG4gICAgICAnMi4yLXN1Yi1mZWF0dXJlLWInOiBtYWtlUGhhc2UoJzIuMi1zdWItZmVhdHVyZS1iJywgMi4yLCAnc3ViLWZlYXR1cmUtYicpLFxuICAgICAgJzMtZmluYWxpemUnOiBtYWtlUGhhc2UoJzMtZmluYWxpemUnLCAzLCAnZmluYWxpemUnKSxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSB0cmFuc2Zvcm1Ub0dTRChwcm9qZWN0KTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5taWxlc3RvbmVzWzBdPy5zbGljZXMubGVuZ3RoLCA1LCAnZGVjaW1hbDogNSBzbGljZXMgdG90YWwnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQubWlsZXN0b25lc1swXT8uc2xpY2VzWzBdPy5pZCwgJ1MwMScsICdkZWNpbWFsOiBmaXJzdCBpcyBTMDEnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQubWlsZXN0b25lc1swXT8uc2xpY2VzWzFdPy5pZCwgJ1MwMicsICdkZWNpbWFsOiBzZWNvbmQgaXMgUzAyJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnNsaWNlc1syXT8uaWQsICdTMDMnLCAnZGVjaW1hbDogdGhpcmQgaXMgUzAzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnNsaWNlc1szXT8uaWQsICdTMDQnLCAnZGVjaW1hbDogZm91cnRoIGlzIFMwNCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5taWxlc3RvbmVzWzBdPy5zbGljZXNbNF0/LmlkLCAnUzA1JywgJ2RlY2ltYWw6IGZpZnRoIGlzIFMwNScpO1xuICAvLyBPcmRlciBtdXN0IGJlIGJ5IGZsb2F0IHZhbHVlOiAxLCAyLCAyLjEsIDIuMiwgM1xuICBhc3NlcnQub2soXG4gICAgcmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnNsaWNlc1swXT8udGl0bGUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcygnZm91bmRhdGlvbicpLFxuICAgICdkZWNpbWFsOiBTMDEgaXMgZm91bmRhdGlvbiAocGhhc2UgMSknLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgcmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnNsaWNlc1s0XT8udGl0bGUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcygnZmluYWxpemUnKSxcbiAgICAnZGVjaW1hbDogUzA1IGlzIGZpbmFsaXplIChwaGFzZSAzKScsXG4gICk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDQ6IENvbXBsZXRpb24gU3RhdGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ1NjZW5hcmlvIDQ6IENvbXBsZXRpb24gc3RhdGUgbWFwcGluZycsICgpID0+IHtcblxuICBjb25zdCBwcm9qZWN0ID0gZW1wdHlQcm9qZWN0KHtcbiAgICByb2FkbWFwOiBmbGF0Um9hZG1hcChbXG4gICAgICByb2FkbWFwRW50cnkoMSwgJ2RvbmUtcGhhc2UnLCB0cnVlKSxcbiAgICAgIHJvYWRtYXBFbnRyeSgyLCAnYWN0aXZlLXBoYXNlJywgZmFsc2UpLFxuICAgIF0pLFxuICAgIHBoYXNlczoge1xuICAgICAgJzEtZG9uZS1waGFzZSc6IG1ha2VQaGFzZSgnMS1kb25lLXBoYXNlJywgMSwgJ2RvbmUtcGhhc2UnLCB7XG4gICAgICAgIHBsYW5zOiB7ICcwMSc6IG1ha2VQbGFuKCcwMScpLCAnMDInOiBtYWtlUGxhbignMDInKSB9LFxuICAgICAgICBzdW1tYXJpZXM6IHtcbiAgICAgICAgICAnMDEnOiBtYWtlU3VtbWFyeSgnMDEnKSxcbiAgICAgICAgICAvLyBwbGFuIDAyIGhhcyBubyBzdW1tYXJ5IFx1MjE5MiB0YXNrIG5vdCBkb25lXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICAgICcyLWFjdGl2ZS1waGFzZSc6IG1ha2VQaGFzZSgnMi1hY3RpdmUtcGhhc2UnLCAyLCAnYWN0aXZlLXBoYXNlJywge1xuICAgICAgICBwbGFuczogeyAnMDEnOiBtYWtlUGxhbignMDEnKSB9LFxuICAgICAgfSksXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gdHJhbnNmb3JtVG9HU0QocHJvamVjdCk7XG4gIGNvbnN0IGRvbmVTbGljZSA9IHJlc3VsdC5taWxlc3RvbmVzWzBdPy5zbGljZXNbMF07XG4gIGNvbnN0IGFjdGl2ZVNsaWNlID0gcmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnNsaWNlc1sxXTtcblxuICBhc3NlcnQub2soZG9uZVNsaWNlPy5kb25lID09PSB0cnVlLCAnY29tcGxldGlvbjogZG9uZSBwaGFzZSBcdTIxOTIgZG9uZSBzbGljZScpO1xuICBhc3NlcnQub2soYWN0aXZlU2xpY2U/LmRvbmUgPT09IGZhbHNlLCAnY29tcGxldGlvbjogYWN0aXZlIHBoYXNlIFx1MjE5MiBub3QtZG9uZSBzbGljZScpO1xuICBhc3NlcnQub2soZG9uZVNsaWNlPy50YXNrc1swXT8uZG9uZSA9PT0gdHJ1ZSwgJ2NvbXBsZXRpb246IHBsYW4gd2l0aCBzdW1tYXJ5IFx1MjE5MiBkb25lIHRhc2snKTtcbiAgYXNzZXJ0Lm9rKGRvbmVTbGljZT8udGFza3NbMV0/LmRvbmUgPT09IGZhbHNlLCAnY29tcGxldGlvbjogcGxhbiB3aXRob3V0IHN1bW1hcnkgXHUyMTkyIG5vdC1kb25lIHRhc2snKTtcbiAgYXNzZXJ0Lm9rKGRvbmVTbGljZT8udGFza3NbMF0/LnN1bW1hcnkgIT09IG51bGwsICdjb21wbGV0aW9uOiBkb25lIHRhc2sgaGFzIHN1bW1hcnkgZGF0YScpO1xuICBhc3NlcnQub2soZG9uZVNsaWNlPy50YXNrc1sxXT8uc3VtbWFyeSA9PT0gbnVsbCwgJ2NvbXBsZXRpb246IG5vdC1kb25lIHRhc2sgaGFzIG51bGwgc3VtbWFyeScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRvbmVTbGljZT8udGFza3NbMF0/LnN1bW1hcnk/LmNvbXBsZXRlZEF0LCAnMjAyNi0wMS0xNScsICdjb21wbGV0aW9uOiBzdW1tYXJ5IGNvbXBsZXRlZEF0IGZyb20gZnJvbnRtYXR0ZXInKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkb25lU2xpY2U/LnRhc2tzWzBdPy5zdW1tYXJ5Py5kdXJhdGlvbiwgJzJoJywgJ2NvbXBsZXRpb246IHN1bW1hcnkgZHVyYXRpb24gZnJvbSBmcm9udG1hdHRlcicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRvbmVTbGljZT8udGFza3NbMF0/LnN1bW1hcnk/LnByb3ZpZGVzLCBbJ2ZlYXR1cmUtMDEnXSwgJ2NvbXBsZXRpb246IHN1bW1hcnkgcHJvdmlkZXMgZnJvbSBmcm9udG1hdHRlcicpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGRvbmVTbGljZT8udGFza3NbMF0/LnN1bW1hcnk/LmtleUZpbGVzLCBbJ2ZpbGUtMDEudHMnXSwgJ2NvbXBsZXRpb246IHN1bW1hcnkga2V5RmlsZXMgZnJvbSBmcm9udG1hdHRlcicpO1xuICBhc3NlcnQub2soZG9uZVNsaWNlPy50YXNrc1swXT8uc3VtbWFyeT8ud2hhdEhhcHBlbmVkPy5pbmNsdWRlcygnU3VtbWFyeSBib2R5JykgPz8gZmFsc2UsICdjb21wbGV0aW9uOiBzdW1tYXJ5IHdoYXRIYXBwZW5lZCBmcm9tIGJvZHknKTtcbiAgYXNzZXJ0Lm9rKGRvbmVTbGljZT8uc3VtbWFyeSAhPT0gbnVsbCwgJ2NvbXBsZXRpb246IGRvbmUgc2xpY2UgaGFzIHNsaWNlIHN1bW1hcnknKTtcbiAgYXNzZXJ0Lm9rKGFjdGl2ZVNsaWNlPy5zdW1tYXJ5ID09PSBudWxsLCAnY29tcGxldGlvbjogYWN0aXZlIHNsaWNlIGhhcyBudWxsIHN1bW1hcnknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChkb25lU2xpY2U/LnRhc2tzWzBdPy5lc3RpbWF0ZSwgJzJoJywgJ2NvbXBsZXRpb246IHRhc2sgZXN0aW1hdGUgZnJvbSBzdW1tYXJ5IGR1cmF0aW9uJyk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDU6IFJlc2VhcmNoIENvbnNvbGlkYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ1NjZW5hcmlvIDU6IFJlc2VhcmNoIGNvbnNvbGlkYXRpb24nLCAoKSA9PiB7XG5cbiAgY29uc3QgcHJvamVjdCA9IGVtcHR5UHJvamVjdCh7XG4gICAgcm9hZG1hcDogZmxhdFJvYWRtYXAoW3JvYWRtYXBFbnRyeSgxLCAncmVzZWFyY2hlZC1waGFzZScpXSksXG4gICAgcmVzZWFyY2g6IFtcbiAgICAgIG1ha2VSZXNlYXJjaCgnU1VNTUFSWS5tZCcsICcjIFByb2plY3QgU3VtbWFyeVxcbk92ZXJ2aWV3IGNvbnRlbnQuJyksXG4gICAgICBtYWtlUmVzZWFyY2goJ0FSQ0hJVEVDVFVSRS5tZCcsICcjIEFyY2hpdGVjdHVyZVxcbkFyY2ggZGV0YWlscy4nKSxcbiAgICAgIG1ha2VSZXNlYXJjaCgnUElURkFMTFMubWQnLCAnIyBQaXRmYWxsc1xcblRoaW5ncyB0byBhdm9pZC4nKSxcbiAgICBdLFxuICAgIHBoYXNlczoge1xuICAgICAgJzEtcmVzZWFyY2hlZC1waGFzZSc6IG1ha2VQaGFzZSgnMS1yZXNlYXJjaGVkLXBoYXNlJywgMSwgJ3Jlc2VhcmNoZWQtcGhhc2UnLCB7XG4gICAgICAgIHJlc2VhcmNoOiBbXG4gICAgICAgICAgbWFrZVJlc2VhcmNoKCdGRUFUVVJFUy5tZCcsICcjIFBoYXNlIEZlYXR1cmVzXFxuRmVhdHVyZSBsaXN0LicpLFxuICAgICAgICBdLFxuICAgICAgfSksXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gdHJhbnNmb3JtVG9HU0QocHJvamVjdCk7XG5cbiAgLy8gUHJvamVjdC1sZXZlbCByZXNlYXJjaCBcdTIxOTIgbWlsZXN0b25lIHJlc2VhcmNoXG4gIGFzc2VydC5vayhyZXN1bHQubWlsZXN0b25lc1swXT8ucmVzZWFyY2ggIT09IG51bGwsICdyZXNlYXJjaDogbWlsZXN0b25lIGhhcyBjb25zb2xpZGF0ZWQgcmVzZWFyY2gnKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5taWxlc3RvbmVzWzBdPy5yZXNlYXJjaCEuaW5jbHVkZXMoJ1Byb2plY3QgU3VtbWFyeScpLCAncmVzZWFyY2g6IGluY2x1ZGVzIFNVTU1BUlkgY29udGVudCcpO1xuICBhc3NlcnQub2socmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnJlc2VhcmNoIS5pbmNsdWRlcygnQXJjaGl0ZWN0dXJlJyksICdyZXNlYXJjaDogaW5jbHVkZXMgQVJDSElURUNUVVJFIGNvbnRlbnQnKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5taWxlc3RvbmVzWzBdPy5yZXNlYXJjaCEuaW5jbHVkZXMoJ1BpdGZhbGxzJyksICdyZXNlYXJjaDogaW5jbHVkZXMgUElURkFMTFMgY29udGVudCcpO1xuXG4gIC8vIEZpeGVkIG9yZGVyaW5nOiBTVU1NQVJZIGJlZm9yZSBBUkNISVRFQ1RVUkUgYmVmb3JlIFBJVEZBTExTXG4gIGNvbnN0IHN1bW1hcnlJZHggPSByZXN1bHQubWlsZXN0b25lc1swXT8ucmVzZWFyY2ghLmluZGV4T2YoJ1Byb2plY3QgU3VtbWFyeScpID8/IC0xO1xuICBjb25zdCBhcmNoSWR4ID0gcmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnJlc2VhcmNoIS5pbmRleE9mKCdBcmNoaXRlY3R1cmUnKSA/PyAtMTtcbiAgY29uc3QgcGl0ZmFsbElkeCA9IHJlc3VsdC5taWxlc3RvbmVzWzBdPy5yZXNlYXJjaCEuaW5kZXhPZignUGl0ZmFsbHMnKSA/PyAtMTtcbiAgYXNzZXJ0Lm9rKHN1bW1hcnlJZHggPCBhcmNoSWR4LCAncmVzZWFyY2g6IFNVTU1BUlkgYmVmb3JlIEFSQ0hJVEVDVFVSRSBpbiBjb25zb2xpZGF0ZWQnKTtcbiAgYXNzZXJ0Lm9rKGFyY2hJZHggPCBwaXRmYWxsSWR4LCAncmVzZWFyY2g6IEFSQ0hJVEVDVFVSRSBiZWZvcmUgUElURkFMTFMgaW4gY29uc29saWRhdGVkJyk7XG5cbiAgLy8gUGhhc2UtbGV2ZWwgcmVzZWFyY2ggXHUyMTkyIHNsaWNlIHJlc2VhcmNoXG4gIGNvbnN0IHNsaWNlID0gcmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnNsaWNlc1swXTtcbiAgYXNzZXJ0Lm9rKHNsaWNlPy5yZXNlYXJjaCAhPT0gbnVsbCwgJ3Jlc2VhcmNoOiBzbGljZSBoYXMgcGhhc2UgcmVzZWFyY2gnKTtcbiAgYXNzZXJ0Lm9rKHNsaWNlPy5yZXNlYXJjaCEuaW5jbHVkZXMoJ1BoYXNlIEZlYXR1cmVzJyksICdyZXNlYXJjaDogc2xpY2UgcmVzZWFyY2ggaW5jbHVkZXMgcGhhc2UgY29udGVudCcpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyA2OiBSZXF1aXJlbWVudHMgQ2xhc3NpZmljYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ1NjZW5hcmlvIDY6IFJlcXVpcmVtZW50cyBjbGFzc2lmaWNhdGlvbicsICgpID0+IHtcblxuICBjb25zdCBwcm9qZWN0ID0gZW1wdHlQcm9qZWN0KHtcbiAgICByb2FkbWFwOiBmbGF0Um9hZG1hcChbcm9hZG1hcEVudHJ5KDEsICdyZXEtcGhhc2UnKV0pLFxuICAgIHJlcXVpcmVtZW50czogW1xuICAgICAgbWFrZVJlcXVpcmVtZW50KCdSMDAxJywgJ0NvcmUgRmVhdHVyZScsICdhY3RpdmUnKSxcbiAgICAgIG1ha2VSZXF1aXJlbWVudCgnUjAwMicsICdTZWNvbmRhcnkgRmVhdHVyZScsICd2YWxpZGF0ZWQnKSxcbiAgICAgIG1ha2VSZXF1aXJlbWVudCgnUjAwMycsICdEZWZlcnJlZCBGZWF0dXJlJywgJ2RlZmVycmVkJyksXG4gICAgXSxcbiAgICBwaGFzZXM6IHtcbiAgICAgICcxLXJlcS1waGFzZSc6IG1ha2VQaGFzZSgnMS1yZXEtcGhhc2UnLCAxLCAncmVxLXBoYXNlJyksXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gdHJhbnNmb3JtVG9HU0QocHJvamVjdCk7XG5cbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQucmVxdWlyZW1lbnRzLmxlbmd0aCwgMywgJ3JlcXVpcmVtZW50czogMyByZXF1aXJlbWVudHMnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQucmVxdWlyZW1lbnRzWzBdPy5pZCwgJ1IwMDEnLCAncmVxdWlyZW1lbnRzOiBmaXJzdCBpcyBSMDAxJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LnJlcXVpcmVtZW50c1swXT8uc3RhdHVzLCAnYWN0aXZlJywgJ3JlcXVpcmVtZW50czogUjAwMSBzdGF0dXMgYWN0aXZlJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LnJlcXVpcmVtZW50c1sxXT8uc3RhdHVzLCAndmFsaWRhdGVkJywgJ3JlcXVpcmVtZW50czogUjAwMiBzdGF0dXMgdmFsaWRhdGVkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LnJlcXVpcmVtZW50c1syXT8uc3RhdHVzLCAnZGVmZXJyZWQnLCAncmVxdWlyZW1lbnRzOiBSMDAzIHN0YXR1cyBkZWZlcnJlZCcpO1xuICBhc3NlcnQub2socmVzdWx0LnJlcXVpcmVtZW50c1swXT8udGl0bGUgPT09ICdDb3JlIEZlYXR1cmUnLCAncmVxdWlyZW1lbnRzOiBSMDAxIHRpdGxlIHByZXNlcnZlZCcpO1xuICBhc3NlcnQub2socmVzdWx0LnJlcXVpcmVtZW50c1swXT8uZGVzY3JpcHRpb24uaW5jbHVkZXMoJ0Rlc2NyaXB0aW9uIGZvciBSMDAxJyksICdyZXF1aXJlbWVudHM6IFIwMDEgZGVzY3JpcHRpb24gcHJlc2VydmVkJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LnJlcXVpcmVtZW50c1swXT8uY2xhc3MsICdjb3JlLWNhcGFiaWxpdHknLCAncmVxdWlyZW1lbnRzOiBkZWZhdWx0IGNsYXNzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LnJlcXVpcmVtZW50c1swXT8uc291cmNlLCAnaW5mZXJyZWQnLCAncmVxdWlyZW1lbnRzOiBkZWZhdWx0IHNvdXJjZScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5yZXF1aXJlbWVudHNbMF0/LnByaW1hcnlTbGljZSwgJ25vbmUgeWV0JywgJ3JlcXVpcmVtZW50czogZGVmYXVsdCBwcmltYXJ5U2xpY2UnKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gNzogRW1wdHkgUGhhc2UgKG5vIHBsYW5zIFx1MjE5MiBzbGljZSB3aXRoIDAgdGFza3MpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KCdTY2VuYXJpbyA3OiBFbXB0eSBwaGFzZScsICgpID0+IHtcblxuICBjb25zdCBwcm9qZWN0ID0gZW1wdHlQcm9qZWN0KHtcbiAgICByb2FkbWFwOiBmbGF0Um9hZG1hcChbXG4gICAgICByb2FkbWFwRW50cnkoMSwgJ2VtcHR5LXBoYXNlJyksXG4gICAgICByb2FkbWFwRW50cnkoMiwgJ25vbi1lbXB0eS1waGFzZScpLFxuICAgIF0pLFxuICAgIHBoYXNlczoge1xuICAgICAgJzEtZW1wdHktcGhhc2UnOiBtYWtlUGhhc2UoJzEtZW1wdHktcGhhc2UnLCAxLCAnZW1wdHktcGhhc2UnKSxcbiAgICAgICcyLW5vbi1lbXB0eS1waGFzZSc6IG1ha2VQaGFzZSgnMi1ub24tZW1wdHktcGhhc2UnLCAyLCAnbm9uLWVtcHR5LXBoYXNlJywge1xuICAgICAgICBwbGFuczogeyAnMDEnOiBtYWtlUGxhbignMDEnKSB9LFxuICAgICAgfSksXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gdHJhbnNmb3JtVG9HU0QocHJvamVjdCk7XG5cbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQubWlsZXN0b25lc1swXT8uc2xpY2VzWzBdPy50YXNrcy5sZW5ndGgsIDAsICdlbXB0eTogZW1wdHkgcGhhc2UgXHUyMTkyIDAgdGFza3MnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQubWlsZXN0b25lc1swXT8uc2xpY2VzWzFdPy50YXNrcy5sZW5ndGgsIDEsICdlbXB0eTogbm9uLWVtcHR5IHBoYXNlIFx1MjE5MiAxIHRhc2snKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5taWxlc3RvbmVzWzBdPy5zbGljZXNbMF0/LmlkID09PSAnUzAxJywgJ2VtcHR5OiBlbXB0eSBzbGljZSBzdGlsbCBnZXRzIElEJyk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDg6IERlbW8gRGVyaXZhdGlvbiBmcm9tIFBsYW4gT2JqZWN0aXZlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KCdTY2VuYXJpbyA4OiBEZW1vIGRlcml2YXRpb24nLCAoKSA9PiB7XG5cbiAgY29uc3QgcHJvamVjdCA9IGVtcHR5UHJvamVjdCh7XG4gICAgcm9hZG1hcDogZmxhdFJvYWRtYXAoW3JvYWRtYXBFbnRyeSgxLCAnZGVtby1waGFzZScpXSksXG4gICAgcGhhc2VzOiB7XG4gICAgICAnMS1kZW1vLXBoYXNlJzogbWFrZVBoYXNlKCcxLWRlbW8tcGhhc2UnLCAxLCAnZGVtby1waGFzZScsIHtcbiAgICAgICAgcGxhbnM6IHtcbiAgICAgICAgICAnMDEnOiBtYWtlUGxhbignMDEnLCB7IG9iamVjdGl2ZTogJ0J1aWxkIHRoZSBhdXRoZW50aWNhdGlvbiBzeXN0ZW0gd2l0aCBKV1QgdG9rZW5zLicgfSksXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSB0cmFuc2Zvcm1Ub0dTRChwcm9qZWN0KTtcblxuICBhc3NlcnQub2socmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnNsaWNlc1swXT8uZGVtby5sZW5ndGggPiAwLCAnZGVtbzogc2xpY2UgZGVtbyBpcyBub3QgZW1wdHknKTtcbiAgYXNzZXJ0Lm9rKFxuICAgIHJlc3VsdC5taWxlc3RvbmVzWzBdPy5zbGljZXNbMF0/LmRlbW8uaW5jbHVkZXMoJ2F1dGhlbnRpY2F0aW9uJykgfHxcbiAgICByZXN1bHQubWlsZXN0b25lc1swXT8uc2xpY2VzWzBdPy5kZW1vLmluY2x1ZGVzKCdCdWlsZCcpLFxuICAgICdkZW1vOiBzbGljZSBkZW1vIGRlcml2ZWQgZnJvbSBmaXJzdCBwbGFuIG9iamVjdGl2ZScsXG4gICk7XG4gIGFzc2VydC5vayhyZXN1bHQubWlsZXN0b25lc1swXT8uc2xpY2VzWzBdPy5nb2FsLmxlbmd0aCA+IDAsICdkZW1vOiBzbGljZSBnb2FsIGlzIG5vdCBlbXB0eScpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyA5OiBGaWVsZCBEZWZhdWx0cyBhbmQgVHlwZSBTYWZldHkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ1NjZW5hcmlvIDk6IEZpZWxkIGRlZmF1bHRzJywgKCkgPT4ge1xuXG4gIGNvbnN0IHByb2plY3QgPSBlbXB0eVByb2plY3Qoe1xuICAgIHJvYWRtYXA6IGZsYXRSb2FkbWFwKFtyb2FkbWFwRW50cnkoMSwgJ2RlZmF1bHRzLXBoYXNlJyldKSxcbiAgICBwaGFzZXM6IHtcbiAgICAgICcxLWRlZmF1bHRzLXBoYXNlJzogbWFrZVBoYXNlKCcxLWRlZmF1bHRzLXBoYXNlJywgMSwgJ2RlZmF1bHRzLXBoYXNlJywge1xuICAgICAgICBwbGFuczoge1xuICAgICAgICAgICcwMSc6IG1ha2VQbGFuKCcwMScsIHtcbiAgICAgICAgICAgIGZyb250bWF0dGVyOiB7XG4gICAgICAgICAgICAgIHBoYXNlOiAnMDEnLFxuICAgICAgICAgICAgICBwbGFuOiAnMDEnLFxuICAgICAgICAgICAgICB0eXBlOiAnaW1wbGVtZW50YXRpb24nLFxuICAgICAgICAgICAgICB3YXZlOiBudWxsLFxuICAgICAgICAgICAgICBkZXBlbmRzX29uOiBbXSxcbiAgICAgICAgICAgICAgZmlsZXNfbW9kaWZpZWQ6IFsnc3JjL2F1dGgudHMnLCAnc3JjL2RiLnRzJ10sXG4gICAgICAgICAgICAgIGF1dG9ub21vdXM6IGZhbHNlLFxuICAgICAgICAgICAgICBtdXN0X2hhdmVzOiB7IHRydXRoczogWydBdXRoIHdvcmtzJywgJ0RCIGNvbm5lY3RlZCddLCBhcnRpZmFjdHM6IFtdLCBrZXlfbGlua3M6IFtdIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pLFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gdHJhbnNmb3JtVG9HU0QocHJvamVjdCk7XG4gIGNvbnN0IHNsaWNlID0gcmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnNsaWNlc1swXTtcbiAgY29uc3QgdGFzayA9IHNsaWNlPy50YXNrc1swXTtcblxuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHNsaWNlPy5yaXNrLCAnbWVkaXVtJywgJ2RlZmF1bHRzOiBzbGljZSByaXNrIGRlZmF1bHRzIHRvIG1lZGl1bScpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHNsaWNlPy5kZXBlbmRzLCBbXSwgJ2RlZmF1bHRzOiBTMDEgaGFzIG5vIGRlcGVuZHMnKTtcbiAgYXNzZXJ0Lm9rKHRhc2s/LmRlc2NyaXB0aW9uLmxlbmd0aCA+IDAsICdkZWZhdWx0czogdGFzayBkZXNjcmlwdGlvbiBub3QgZW1wdHknKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh0YXNrPy5maWxlcywgWydzcmMvYXV0aC50cycsICdzcmMvZGIudHMnXSwgJ2RlZmF1bHRzOiB0YXNrIGZpbGVzIGZyb20gZnJvbnRtYXR0ZXInKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh0YXNrPy5tdXN0SGF2ZXMsIFsnQXV0aCB3b3JrcycsICdEQiBjb25uZWN0ZWQnXSwgJ2RlZmF1bHRzOiB0YXNrIG11c3RIYXZlcyBmcm9tIGZyb250bWF0dGVyJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwodGFzaz8uZG9uZSwgZmFsc2UsICdkZWZhdWx0czogdGFzayB3aXRob3V0IHN1bW1hcnkgaXMgbm90IGRvbmUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbCh0YXNrPy5lc3RpbWF0ZSwgJycsICdkZWZhdWx0czogdGFzayB3aXRob3V0IHN1bW1hcnkgaGFzIGVtcHR5IGVzdGltYXRlJyk7XG4gIGFzc2VydC5vayh0YXNrPy5zdW1tYXJ5ID09PSBudWxsLCAnZGVmYXVsdHM6IHRhc2sgd2l0aG91dCBzdW1tYXJ5IGhhcyBudWxsIHN1bW1hcnknKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NlbmFyaW8gMTA6IFNlcXVlbnRpYWwgRGVwZW5kcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnU2NlbmFyaW8gMTA6IFNlcXVlbnRpYWwgZGVwZW5kcycsICgpID0+IHtcblxuICBjb25zdCBwcm9qZWN0ID0gZW1wdHlQcm9qZWN0KHtcbiAgICByb2FkbWFwOiBmbGF0Um9hZG1hcChbXG4gICAgICByb2FkbWFwRW50cnkoMSwgJ2ZpcnN0JyksXG4gICAgICByb2FkbWFwRW50cnkoMiwgJ3NlY29uZCcpLFxuICAgICAgcm9hZG1hcEVudHJ5KDMsICd0aGlyZCcpLFxuICAgIF0pLFxuICAgIHBoYXNlczoge1xuICAgICAgJzEtZmlyc3QnOiBtYWtlUGhhc2UoJzEtZmlyc3QnLCAxLCAnZmlyc3QnKSxcbiAgICAgICcyLXNlY29uZCc6IG1ha2VQaGFzZSgnMi1zZWNvbmQnLCAyLCAnc2Vjb25kJyksXG4gICAgICAnMy10aGlyZCc6IG1ha2VQaGFzZSgnMy10aGlyZCcsIDMsICd0aGlyZCcpLFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IHRyYW5zZm9ybVRvR1NEKHByb2plY3QpO1xuICBjb25zdCBzbGljZXMgPSByZXN1bHQubWlsZXN0b25lc1swXT8uc2xpY2VzO1xuXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc2xpY2VzPy5bMF0/LmRlcGVuZHMsIFtdLCAnZGVwZW5kczogUzAxIGhhcyBlbXB0eSBkZXBlbmRzJyk7XG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoc2xpY2VzPy5bMV0/LmRlcGVuZHMsIFsnUzAxJ10sICdkZXBlbmRzOiBTMDIgZGVwZW5kcyBvbiBTMDEnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzbGljZXM/LlsyXT8uZGVwZW5kcywgWydTMDInXSwgJ2RlcGVuZHM6IFMwMyBkZXBlbmRzIG9uIFMwMicpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyAxMTogUmVxdWlyZW1lbnRzIHdpdGggdW5rbm93biBzdGF0dXMgYW5kIG1pc3NpbmcgSURzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KCdTY2VuYXJpbyAxMTogUmVxdWlyZW1lbnRzIGVkZ2UgY2FzZXMnLCAoKSA9PiB7XG5cbiAgY29uc3QgcHJvamVjdCA9IGVtcHR5UHJvamVjdCh7XG4gICAgcm9hZG1hcDogZmxhdFJvYWRtYXAoW3JvYWRtYXBFbnRyeSgxLCAncmVxLWVkZ2UnKV0pLFxuICAgIHJlcXVpcmVtZW50czogW1xuICAgICAgbWFrZVJlcXVpcmVtZW50KCcnLCAnTm8gSUQgRmVhdHVyZScsICdhY3RpdmUnKSxcbiAgICAgIG1ha2VSZXF1aXJlbWVudCgnJywgJ0Fub3RoZXIgTm8gSUQnLCAndmFsaWRhdGVkJyksXG4gICAgICBtYWtlUmVxdWlyZW1lbnQoJ1IwMDUnLCAnSGFzIElEJywgJ3NvbWV0aGluZy13ZWlyZCcpLFxuICAgICAgbWFrZVJlcXVpcmVtZW50KCdSMDA2JywgJ0RlZmVycmVkIE9uZScsICdERUZFUlJFRCcpLFxuICAgICAgbWFrZVJlcXVpcmVtZW50KCdBVVRILTcnLCAnTGVnYWN5IElEJywgJ2FjdGl2ZScpLFxuICAgIF0sXG4gICAgcGhhc2VzOiB7XG4gICAgICAnMS1yZXEtZWRnZSc6IG1ha2VQaGFzZSgnMS1yZXEtZWRnZScsIDEsICdyZXEtZWRnZScpLFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IHRyYW5zZm9ybVRvR1NEKHByb2plY3QpO1xuXG4gIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LnJlcXVpcmVtZW50c1swXT8uaWQsICdSMDAxJywgJ3JlcS1lZGdlOiBlbXB0eSBpZCBnZXRzIFIwMDEnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQucmVxdWlyZW1lbnRzWzFdPy5pZCwgJ1IwMDInLCAncmVxLWVkZ2U6IHNlY29uZCBlbXB0eSBpZCBnZXRzIFIwMDInKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQucmVxdWlyZW1lbnRzWzJdPy5pZCwgJ1IwMDUnLCAncmVxLWVkZ2U6IGV4aXN0aW5nIGlkIHByZXNlcnZlZCcpO1xuICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5yZXF1aXJlbWVudHNbMl0/LnN0YXR1cywgJ2FjdGl2ZScsICdyZXEtZWRnZTogdW5rbm93biBzdGF0dXMgbm9ybWFsaXplZCB0byBhY3RpdmUnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQucmVxdWlyZW1lbnRzWzNdPy5zdGF0dXMsICdkZWZlcnJlZCcsICdyZXEtZWRnZTogdXBwZXJjYXNlIERFRkVSUkVEIG5vcm1hbGl6ZWQnKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQucmVxdWlyZW1lbnRzWzRdPy5pZCwgJ1IwMDMnLCAncmVxLWVkZ2U6IG5vbi1SIGxlZ2FjeSBpZCBnZXRzIG5leHQgY2Fub25pY2FsIGlkJyk7XG4gIGFzc2VydC5vayhyZXN1bHQucmVxdWlyZW1lbnRzWzRdPy5kZXNjcmlwdGlvbi5pbmNsdWRlcygnTGVnYWN5IElEOiBBVVRILTcnKSwgJ3JlcS1lZGdlOiBvcmlnaW5hbCBsZWdhY3kgaWQgaXMgcHJlc2VydmVkIGluIGRlc2NyaXB0aW9uJyk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDEyOiBWaXNpb24gZGVyaXZhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnU2NlbmFyaW8gMTI6IFZpc2lvbiBkZXJpdmF0aW9uJywgKCkgPT4ge1xuXG4gIC8vIFZpc2lvbiBmcm9tIHByb2plY3QgZGVzY3JpcHRpb25cbiAgY29uc3QgcHJvamVjdDEgPSBlbXB0eVByb2plY3Qoe1xuICAgIHByb2plY3Q6ICcjIENvb2wgUHJvamVjdFxcbkEgcmV2b2x1dGlvbmFyeSB0b29sIGZvciBkZXZlbG9wZXJzLicsXG4gICAgcm9hZG1hcDogZmxhdFJvYWRtYXAoW3JvYWRtYXBFbnRyeSgxLCAndmlzaW9uLXBoYXNlJyldKSxcbiAgICBwaGFzZXM6IHsgJzEtdmlzaW9uLXBoYXNlJzogbWFrZVBoYXNlKCcxLXZpc2lvbi1waGFzZScsIDEsICd2aXNpb24tcGhhc2UnKSB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQxID0gdHJhbnNmb3JtVG9HU0QocHJvamVjdDEpO1xuICBhc3NlcnQub2socmVzdWx0MS5taWxlc3RvbmVzWzBdPy52aXNpb24uaW5jbHVkZXMoJ3Jldm9sdXRpb25hcnknKSwgJ3Zpc2lvbjogZGVyaXZlZCBmcm9tIHByb2plY3QgZmlyc3QgbGluZScpO1xuXG4gIC8vIFZpc2lvbiBmYWxsYmFjayB3aGVuIG5vIHByb2plY3RcbiAgY29uc3QgcHJvamVjdDIgPSBlbXB0eVByb2plY3Qoe1xuICAgIHJvYWRtYXA6IGZsYXRSb2FkbWFwKFtyb2FkbWFwRW50cnkoMSwgJ2ZhbGxiYWNrJyldKSxcbiAgICBwaGFzZXM6IHsgJzEtZmFsbGJhY2snOiBtYWtlUGhhc2UoJzEtZmFsbGJhY2snLCAxLCAnZmFsbGJhY2snKSB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQyID0gdHJhbnNmb3JtVG9HU0QocHJvamVjdDIpO1xuICBhc3NlcnQub2socmVzdWx0Mi5taWxlc3RvbmVzWzBdPy52aXNpb24ubGVuZ3RoID4gMCwgJ3Zpc2lvbjogZmFsbGJhY2sgaXMgbm9uLWVtcHR5Jyk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDEzOiBEZWNpc2lvbnMgY29udGVudCBmcm9tIHN1bW1hcmllcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnU2NlbmFyaW8gMTM6IERlY2lzaW9ucyBjb250ZW50JywgKCkgPT4ge1xuXG4gIGNvbnN0IHByb2plY3QgPSBlbXB0eVByb2plY3Qoe1xuICAgIHJvYWRtYXA6IGZsYXRSb2FkbWFwKFtyb2FkbWFwRW50cnkoMSwgJ2RlY2lzaW9uLXBoYXNlJywgdHJ1ZSldKSxcbiAgICBwaGFzZXM6IHtcbiAgICAgICcxLWRlY2lzaW9uLXBoYXNlJzogbWFrZVBoYXNlKCcxLWRlY2lzaW9uLXBoYXNlJywgMSwgJ2RlY2lzaW9uLXBoYXNlJywge1xuICAgICAgICBwbGFuczogeyAnMDEnOiBtYWtlUGxhbignMDEnKSB9LFxuICAgICAgICBzdW1tYXJpZXM6IHsgJzAxJzogbWFrZVN1bW1hcnkoJzAxJykgfSxcbiAgICAgIH0pLFxuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IHRyYW5zZm9ybVRvR1NEKHByb2plY3QpO1xuXG4gIGFzc2VydC5vayhyZXN1bHQuZGVjaXNpb25zQ29udGVudC5pbmNsdWRlcygnZGVjaXNpb24tMDEnKSwgJ2RlY2lzaW9uczogZXh0cmFjdHMga2V5LWRlY2lzaW9ucyBmcm9tIHN1bW1hcmllcycpO1xuICBhc3NlcnQub2socmVzdWx0LmRlY2lzaW9uc0NvbnRlbnQuaW5jbHVkZXMoJ3wgRDAwMSB8JyksICdkZWNpc2lvbnM6IHdyaXRlcyBEQi1pbXBvcnRhYmxlIGRlY2lzaW9uIElEJyk7XG4gIGFzc2VydC5vayhyZXN1bHQuZGVjaXNpb25zQ29udGVudC5pbmNsdWRlcygnfCAjIHwgV2hlbiB8IFNjb3BlIHwgRGVjaXNpb24gfCBDaG9pY2UgfCBSYXRpb25hbGUgfCBSZXZpc2FibGU/IHwgTWFkZSBCeSB8JyksICdkZWNpc2lvbnM6IHdyaXRlcyBjYW5vbmljYWwgdGFibGUgaGVhZGVyJyk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjZW5hcmlvIDE0OiBObyB1bmRlZmluZWQgdmFsdWVzIGluIG91dHB1dCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnU2NlbmFyaW8gMTQ6IE5vIHVuZGVmaW5lZCB2YWx1ZXMnLCAoKSA9PiB7XG5cbiAgY29uc3QgcHJvamVjdCA9IGVtcHR5UHJvamVjdCh7XG4gICAgcHJvamVjdDogJyMgVGVzdFxcbkRlc2NyaXB0aW9uLicsXG4gICAgcm9hZG1hcDogZmxhdFJvYWRtYXAoW1xuICAgICAgcm9hZG1hcEVudHJ5KDEsICdmdWxsLXBoYXNlJywgdHJ1ZSksXG4gICAgICByb2FkbWFwRW50cnkoMiwgJ2VtcHR5LXBoYXNlJywgZmFsc2UpLFxuICAgIF0pLFxuICAgIHJlcXVpcmVtZW50czogW21ha2VSZXF1aXJlbWVudCgnUjAwMScsICdSZXEnLCAnYWN0aXZlJyldLFxuICAgIHJlc2VhcmNoOiBbbWFrZVJlc2VhcmNoKCdTVU1NQVJZLm1kJywgJ1Jlc2VhcmNoIGNvbnRlbnQnKV0sXG4gICAgcGhhc2VzOiB7XG4gICAgICAnMS1mdWxsLXBoYXNlJzogbWFrZVBoYXNlKCcxLWZ1bGwtcGhhc2UnLCAxLCAnZnVsbC1waGFzZScsIHtcbiAgICAgICAgcGxhbnM6IHsgJzAxJzogbWFrZVBsYW4oJzAxJykgfSxcbiAgICAgICAgc3VtbWFyaWVzOiB7ICcwMSc6IG1ha2VTdW1tYXJ5KCcwMScpIH0sXG4gICAgICAgIHJlc2VhcmNoOiBbbWFrZVJlc2VhcmNoKCdGRUFUVVJFUy5tZCcsICdGZWF0dXJlcycpXSxcbiAgICAgIH0pLFxuICAgICAgJzItZW1wdHktcGhhc2UnOiBtYWtlUGhhc2UoJzItZW1wdHktcGhhc2UnLCAyLCAnZW1wdHktcGhhc2UnKSxcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSB0cmFuc2Zvcm1Ub0dTRChwcm9qZWN0KTtcblxuICAvLyBEZWVwIGNoZWNrIGZvciB1bmRlZmluZWQgdmFsdWVzXG4gIGZ1bmN0aW9uIGNoZWNrTm9VbmRlZmluZWQob2JqOiB1bmtub3duLCBwYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAob2JqID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGFzc2VydC5vayhmYWxzZSwgYG5vLXVuZGVmaW5lZDogJHtwYXRofSBpcyB1bmRlZmluZWRgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKG9iaiA9PT0gbnVsbCkgcmV0dXJuOyAvLyBudWxsIGlzIGFsbG93ZWQgKGUuZy4gcmVzZWFyY2gsIHN1bW1hcnkpXG4gICAgaWYgKEFycmF5LmlzQXJyYXkob2JqKSkge1xuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvYmoubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgY2hlY2tOb1VuZGVmaW5lZChvYmpbaV0sIGAke3BhdGh9WyR7aX1dYCk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICh0eXBlb2Ygb2JqID09PSAnb2JqZWN0Jykge1xuICAgICAgZm9yIChjb25zdCBba2V5LCB2YWxdIG9mIE9iamVjdC5lbnRyaWVzKG9iaiBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICAgICAgY2hlY2tOb1VuZGVmaW5lZCh2YWwsIGAke3BhdGh9LiR7a2V5fWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGNoZWNrTm9VbmRlZmluZWQocmVzdWx0LCAncmVzdWx0Jyk7XG4gIGFzc2VydC5vayh0cnVlLCAnbm8tdW5kZWZpbmVkOiBkZWVwIGNoZWNrIGNvbXBsZXRlZCB3aXRob3V0IGZpbmRpbmcgdW5kZWZpbmVkIHZhbHVlcycpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTY2VuYXJpbyAxNTogUmVzZWFyY2ggd2l0aCBubyBmaWxlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnU2NlbmFyaW8gMTU6IEVtcHR5IHJlc2VhcmNoJywgKCkgPT4ge1xuXG4gIGNvbnN0IHByb2plY3QgPSBlbXB0eVByb2plY3Qoe1xuICAgIHJvYWRtYXA6IGZsYXRSb2FkbWFwKFtyb2FkbWFwRW50cnkoMSwgJ25vLXJlc2VhcmNoJyldKSxcbiAgICBwaGFzZXM6IHsgJzEtbm8tcmVzZWFyY2gnOiBtYWtlUGhhc2UoJzEtbm8tcmVzZWFyY2gnLCAxLCAnbm8tcmVzZWFyY2gnKSB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSB0cmFuc2Zvcm1Ub0dTRChwcm9qZWN0KTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdC5taWxlc3RvbmVzWzBdPy5yZXNlYXJjaCA9PT0gbnVsbCwgJ2VtcHR5LXJlc2VhcmNoOiBtaWxlc3RvbmUgcmVzZWFyY2ggaXMgbnVsbCcpO1xuICBhc3NlcnQub2socmVzdWx0Lm1pbGVzdG9uZXNbMF0/LnNsaWNlc1swXT8ucmVzZWFyY2ggPT09IG51bGwsICdlbXB0eS1yZXNlYXJjaDogc2xpY2UgcmVzZWFyY2ggaXMgbnVsbCcpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZXN1bHRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuIl0sCiAgIm1hcHBpbmdzIjogIkFBS0EsU0FBUyxzQkFBc0I7QUFnQi9CLFNBQW1CLFlBQW1DO0FBQ3RELE9BQU8sWUFBWTtBQUluQixTQUFTLGFBQWEsWUFBc0MsQ0FBQyxHQUFvQjtBQUMvRSxTQUFPO0FBQUEsSUFDTCxNQUFNO0FBQUEsSUFDTixTQUFTO0FBQUEsSUFDVCxTQUFTO0FBQUEsSUFDVCxjQUFjLENBQUM7QUFBQSxJ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
