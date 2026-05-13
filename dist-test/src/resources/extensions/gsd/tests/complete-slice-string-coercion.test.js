import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask
} from "../gsd-db.js";
import { handleCompleteSlice } from "../tools/complete-slice.js";
function splitPair(s) {
  const m = s.match(/^(.+?)\s*(?:—|-)\s+(.+)$/);
  return m ? [m[1].trim(), m[2].trim()] : [s.trim(), ""];
}
function makeValidSliceParams() {
  return {
    sliceId: "S01",
    milestoneId: "M001",
    sliceTitle: "Test Slice",
    oneLiner: "Implemented test slice",
    narrative: "Built and tested.",
    verification: "All tests pass.",
    deviations: "None.",
    knownLimitations: "None.",
    followUps: "None.",
    keyFiles: ["src/foo.ts"],
    keyDecisions: ["D001"],
    patternsEstablished: [],
    observabilitySurfaces: [],
    provides: ["test handler"],
    requirementsSurfaced: [],
    drillDownPaths: [],
    affects: [],
    requirementsAdvanced: [{ id: "R001", how: "Handler validates" }],
    requirementsValidated: [],
    requirementsInvalidated: [],
    filesModified: [{ path: "src/foo.ts", description: "Handler" }],
    requires: [],
    uatContent: "## Smoke Test\n\nVerify all assertions pass."
  };
}
describe("splitPair coercion helper (#3565)", () => {
  test("plain string without delimiter returns string + empty", () => {
    const [a, b] = splitPair("src/foo.ts");
    assert.equal(a, "src/foo.ts");
    assert.equal(b, "");
  });
  test("em-dash delimiter parses both parts", () => {
    const [id, how] = splitPair("R001 \u2014 Handler validates task completion");
    assert.equal(id, "R001");
    assert.equal(how, "Handler validates task completion");
  });
  test("hyphen delimiter parses both parts", () => {
    const [id, proof] = splitPair("R002 - Tests pass");
    assert.equal(id, "R002");
    assert.equal(proof, "Tests pass");
  });
  test("string with no space around hyphen is treated as plain", () => {
    const [a, b] = splitPair("src/foo-bar.ts");
    assert.equal(a, "src/foo-bar.ts");
    assert.equal(b, "");
  });
  test("whitespace is trimmed from both parts", () => {
    const [id, how] = splitPair("  R003  \u2014  Trimmed value  ");
    assert.equal(id, "R003");
    assert.equal(how, "Trimmed value");
  });
});
describe("verificationEvidence sentinel coercion (#3565)", () => {
  function coerceEvidence(v) {
    return typeof v === "string" ? { command: v, exitCode: -1, verdict: "unknown (coerced from string)", durationMs: 0 } : v;
  }
  test("string input produces non-passing sentinel", () => {
    const result = coerceEvidence("npm test");
    assert.equal(result.command, "npm test");
    assert.equal(result.exitCode, -1);
    assert.equal(result.verdict, "unknown (coerced from string)");
    assert.equal(result.durationMs, 0);
  });
  test("object input passes through unchanged", () => {
    const obj = { command: "npm test", exitCode: 0, verdict: "pass", durationMs: 1234 };
    const result = coerceEvidence(obj);
    assert.equal(result.exitCode, 0);
    assert.equal(result.verdict, "pass");
    assert.equal(result.durationMs, 1234);
  });
  test("sentinel exitCode is not 0 (must not fabricate success)", () => {
    const result = coerceEvidence("anything");
    assert.notEqual(result.exitCode, 0, "exitCode must not be 0 for coerced strings");
    assert.ok(
      !result.verdict.includes("pass"),
      "verdict must not contain 'pass' for coerced strings"
    );
  });
});
describe("wrapArray coercion for simple string-array fields (#3585)", () => {
  function wrapArray(v) {
    return v == null ? [] : Array.isArray(v) ? v : [v];
  }
  test("null returns empty array", () => {
    assert.deepEqual(wrapArray(null), []);
  });
  test("undefined returns empty array", () => {
    assert.deepEqual(wrapArray(void 0), []);
  });
  test("plain string wraps into single-element array", () => {
    assert.deepEqual(
      wrapArray("Validated Tech UI flows and Portal self-service flows"),
      ["Validated Tech UI flows and Portal self-service flows"]
    );
  });
  test("array passes through unchanged", () => {
    const arr = ["item1", "item2"];
    assert.deepEqual(wrapArray(arr), arr);
  });
  test("empty array passes through unchanged", () => {
    assert.deepEqual(wrapArray([]), []);
  });
});
describe("handleCompleteSlice with coerced string arrays (#3565)", () => {
  let dbPath;
  let basePath;
  beforeEach(() => {
    dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "gsd-coerce-")),
      "test.db"
    );
    openDatabase(dbPath);
    basePath = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-coerce-handler-"));
    const sliceDir = path.join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
    fs.mkdirSync(sliceDir, { recursive: true });
    const roadmapPath = path.join(basePath, ".gsd", "milestones", "M001", "M001-ROADMAP.md");
    fs.writeFileSync(
      roadmapPath,
      [
        "# M001: Test Milestone",
        "",
        "## Slices",
        "",
        "- [ ] **S01: Test Slice** `risk:medium` `depends:[]`",
        "  - After this: basic functionality works"
      ].join("\n")
    );
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete", title: "Task 1" });
  });
  afterEach(() => {
    closeDatabase();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    fs.rmSync(basePath, { recursive: true, force: true });
  });
  test("handler succeeds with coerced filesModified and requirementsAdvanced", async () => {
    const params = makeValidSliceParams();
    params.filesModified = ["src/foo.ts", "src/bar.ts"].map((f) => {
      const [p, d] = splitPair(f);
      return { path: p, description: d };
    });
    params.requirementsAdvanced = ["R001 \u2014 Handler validates task completion"].map((r) => {
      const [id, how] = splitPair(r);
      return { id, how };
    });
    const result = await handleCompleteSlice(params, basePath);
    assert.ok(!("error" in result), "handler should succeed");
    if (!("error" in result)) {
      const summary = fs.readFileSync(result.summaryPath, "utf-8");
      assert.match(summary, /src\/foo\.ts/);
      assert.match(summary, /R001/);
      assert.match(summary, /Handler validates task completion/);
    }
  });
  test("handler succeeds with coerced requires and requirementsValidated", async () => {
    const params = makeValidSliceParams();
    params.requires = ["S00 \u2014 Provided base infrastructure"].map((r) => {
      const [slice, provides] = splitPair(r);
      return { slice, provides };
    });
    params.requirementsValidated = ["R002 - Tests pass"].map((r) => {
      const [id, proof] = splitPair(r);
      return { id, proof };
    });
    const result = await handleCompleteSlice(params, basePath);
    assert.ok(!("error" in result), "handler should succeed");
    if (!("error" in result)) {
      const summary = fs.readFileSync(result.summaryPath, "utf-8");
      assert.match(summary, /S00/);
      assert.match(summary, /Provided base infrastructure/);
      assert.match(summary, /R002/);
      assert.match(summary, /Tests pass/);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21wbGV0ZS1zbGljZS1zdHJpbmctY29lcmNpb24udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIEV4dGVuc2lvbiBcdTIwMTQgU3RyaW5nIGNvZXJjaW9uIHJlZ3Jlc3Npb24gdGVzdHMgZm9yIGNvbXBsZXRlLXNsaWNlL3Rhc2sgdG9vbHNcblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0ICogYXMgZnMgZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0ICogYXMgb3MgZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBpbnNlcnRTbGljZSxcbiAgaW5zZXJ0VGFzayxcbn0gZnJvbSBcIi4uL2dzZC1kYi50c1wiO1xuaW1wb3J0IHsgaGFuZGxlQ29tcGxldGVTbGljZSB9IGZyb20gXCIuLi90b29scy9jb21wbGV0ZS1zbGljZS50c1wiO1xuaW1wb3J0IHR5cGUgeyBDb21wbGV0ZVNsaWNlUGFyYW1zIH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFRoZSBzcGxpdFBhaXIgY29lcmNpb24gbG9naWMgZXh0cmFjdGVkIGZyb20gZGItdG9vbHMudHMgc2xpY2VDb21wbGV0ZUV4ZWN1dGUuXG4gKiBEdXBsaWNhdGVkIGhlcmUgc28gd2UgY2FuIHVuaXQtdGVzdCBpdCBkaXJlY3RseS5cbiAqL1xuZnVuY3Rpb24gc3BsaXRQYWlyKHM6IHN0cmluZyk6IFtzdHJpbmcsIHN0cmluZ10ge1xuICBjb25zdCBtID0gcy5tYXRjaCgvXiguKz8pXFxzKig/Olx1MjAxNHwtKVxccysoLispJC8pO1xuICByZXR1cm4gbSA/IFttWzFdLnRyaW0oKSwgbVsyXS50cmltKCldIDogW3MudHJpbSgpLCBcIlwiXTtcbn1cblxuZnVuY3Rpb24gbWFrZVZhbGlkU2xpY2VQYXJhbXMoKTogQ29tcGxldGVTbGljZVBhcmFtcyB7XG4gIHJldHVybiB7XG4gICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgc2xpY2VUaXRsZTogXCJUZXN0IFNsaWNlXCIsXG4gICAgb25lTGluZXI6IFwiSW1wbGVtZW50ZWQgdGVzdCBzbGljZVwiLFxuICAgIG5hcnJhdGl2ZTogXCJCdWlsdCBhbmQgdGVzdGVkLlwiLFxuICAgIHZlcmlmaWNhdGlvbjogXCJBbGwgdGVzdHMgcGFzcy5cIixcbiAgICBkZXZpYXRpb25zOiBcIk5vbmUuXCIsXG4gICAga25vd25MaW1pdGF0aW9uczogXCJOb25lLlwiLFxuICAgIGZvbGxvd1VwczogXCJOb25lLlwiLFxuICAgIGtleUZpbGVzOiBbXCJzcmMvZm9vLnRzXCJdLFxuICAgIGtleURlY2lzaW9uczogW1wiRDAwMVwiXSxcbiAgICBwYXR0ZXJuc0VzdGFibGlzaGVkOiBbXSxcbiAgICBvYnNlcnZhYmlsaXR5U3VyZmFjZXM6IFtdLFxuICAgIHByb3ZpZGVzOiBbXCJ0ZXN0IGhhbmRsZXJcIl0sXG4gICAgcmVxdWlyZW1lbnRzU3VyZmFjZWQ6IFtdLFxuICAgIGRyaWxsRG93blBhdGhzOiBbXSxcbiAgICBhZmZlY3RzOiBbXSxcbiAgICByZXF1aXJlbWVudHNBZHZhbmNlZDogW3sgaWQ6IFwiUjAwMVwiLCBob3c6IFwiSGFuZGxlciB2YWxpZGF0ZXNcIiB9XSxcbiAgICByZXF1aXJlbWVudHNWYWxpZGF0ZWQ6IFtdLFxuICAgIHJlcXVpcmVtZW50c0ludmFsaWRhdGVkOiBbXSxcbiAgICBmaWxlc01vZGlmaWVkOiBbeyBwYXRoOiBcInNyYy9mb28udHNcIiwgZGVzY3JpcHRpb246IFwiSGFuZGxlclwiIH1dLFxuICAgIHJlcXVpcmVzOiBbXSxcbiAgICB1YXRDb250ZW50OiBcIiMjIFNtb2tlIFRlc3RcXG5cXG5WZXJpZnkgYWxsIGFzc2VydGlvbnMgcGFzcy5cIixcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHNwbGl0UGFpciB1bml0IHRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcInNwbGl0UGFpciBjb2VyY2lvbiBoZWxwZXIgKCMzNTY1KVwiLCAoKSA9PiB7XG4gIHRlc3QoXCJwbGFpbiBzdHJpbmcgd2l0aG91dCBkZWxpbWl0ZXIgcmV0dXJucyBzdHJpbmcgKyBlbXB0eVwiLCAoKSA9PiB7XG4gICAgY29uc3QgW2EsIGJdID0gc3BsaXRQYWlyKFwic3JjL2Zvby50c1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoYSwgXCJzcmMvZm9vLnRzXCIpO1xuICAgIGFzc2VydC5lcXVhbChiLCBcIlwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImVtLWRhc2ggZGVsaW1pdGVyIHBhcnNlcyBib3RoIHBhcnRzXCIsICgpID0+IHtcbiAgICBjb25zdCBbaWQsIGhvd10gPSBzcGxpdFBhaXIoXCJSMDAxIFx1MjAxNCBIYW5kbGVyIHZhbGlkYXRlcyB0YXNrIGNvbXBsZXRpb25cIik7XG4gICAgYXNzZXJ0LmVxdWFsKGlkLCBcIlIwMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGhvdywgXCJIYW5kbGVyIHZhbGlkYXRlcyB0YXNrIGNvbXBsZXRpb25cIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJoeXBoZW4gZGVsaW1pdGVyIHBhcnNlcyBib3RoIHBhcnRzXCIsICgpID0+IHtcbiAgICBjb25zdCBbaWQsIHByb29mXSA9IHNwbGl0UGFpcihcIlIwMDIgLSBUZXN0cyBwYXNzXCIpO1xuICAgIGFzc2VydC5lcXVhbChpZCwgXCJSMDAyXCIpO1xuICAgIGFzc2VydC5lcXVhbChwcm9vZiwgXCJUZXN0cyBwYXNzXCIpO1xuICB9KTtcblxuICB0ZXN0KFwic3RyaW5nIHdpdGggbm8gc3BhY2UgYXJvdW5kIGh5cGhlbiBpcyB0cmVhdGVkIGFzIHBsYWluXCIsICgpID0+IHtcbiAgICAvLyBlLmcuIGEgZmlsZSBwYXRoIGxpa2UgXCJzcmMvZm9vLWJhci50c1wiIHNob3VsZCBub3Qgc3BsaXRcbiAgICBjb25zdCBbYSwgYl0gPSBzcGxpdFBhaXIoXCJzcmMvZm9vLWJhci50c1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoYSwgXCJzcmMvZm9vLWJhci50c1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoYiwgXCJcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJ3aGl0ZXNwYWNlIGlzIHRyaW1tZWQgZnJvbSBib3RoIHBhcnRzXCIsICgpID0+IHtcbiAgICBjb25zdCBbaWQsIGhvd10gPSBzcGxpdFBhaXIoXCIgIFIwMDMgIFx1MjAxNCAgVHJpbW1lZCB2YWx1ZSAgXCIpO1xuICAgIGFzc2VydC5lcXVhbChpZCwgXCJSMDAzXCIpO1xuICAgIGFzc2VydC5lcXVhbChob3csIFwiVHJpbW1lZCB2YWx1ZVwiKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHZlcmlmaWNhdGlvbkV2aWRlbmNlIHNlbnRpbmVsIHRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcInZlcmlmaWNhdGlvbkV2aWRlbmNlIHNlbnRpbmVsIGNvZXJjaW9uICgjMzU2NSlcIiwgKCkgPT4ge1xuICBmdW5jdGlvbiBjb2VyY2VFdmlkZW5jZSh2OiBhbnkpIHtcbiAgICByZXR1cm4gdHlwZW9mIHYgPT09IFwic3RyaW5nXCJcbiAgICAgID8geyBjb21tYW5kOiB2LCBleGl0Q29kZTogLTEsIHZlcmRpY3Q6IFwidW5rbm93biAoY29lcmNlZCBmcm9tIHN0cmluZylcIiwgZHVyYXRpb25NczogMCB9XG4gICAgICA6IHY7XG4gIH1cblxuICB0ZXN0KFwic3RyaW5nIGlucHV0IHByb2R1Y2VzIG5vbi1wYXNzaW5nIHNlbnRpbmVsXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBjb2VyY2VFdmlkZW5jZShcIm5wbSB0ZXN0XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY29tbWFuZCwgXCJucG0gdGVzdFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmV4aXRDb2RlLCAtMSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC52ZXJkaWN0LCBcInVua25vd24gKGNvZXJjZWQgZnJvbSBzdHJpbmcpXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuZHVyYXRpb25NcywgMCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJvYmplY3QgaW5wdXQgcGFzc2VzIHRocm91Z2ggdW5jaGFuZ2VkXCIsICgpID0+IHtcbiAgICBjb25zdCBvYmogPSB7IGNvbW1hbmQ6IFwibnBtIHRlc3RcIiwgZXhpdENvZGU6IDAsIHZlcmRpY3Q6IFwicGFzc1wiLCBkdXJhdGlvbk1zOiAxMjM0IH07XG4gICAgY29uc3QgcmVzdWx0ID0gY29lcmNlRXZpZGVuY2Uob2JqKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmV4aXRDb2RlLCAwKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnZlcmRpY3QsIFwicGFzc1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmR1cmF0aW9uTXMsIDEyMzQpO1xuICB9KTtcblxuICB0ZXN0KFwic2VudGluZWwgZXhpdENvZGUgaXMgbm90IDAgKG11c3Qgbm90IGZhYnJpY2F0ZSBzdWNjZXNzKVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gY29lcmNlRXZpZGVuY2UoXCJhbnl0aGluZ1wiKTtcbiAgICBhc3NlcnQubm90RXF1YWwocmVzdWx0LmV4aXRDb2RlLCAwLCBcImV4aXRDb2RlIG11c3Qgbm90IGJlIDAgZm9yIGNvZXJjZWQgc3RyaW5nc1wiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICAhcmVzdWx0LnZlcmRpY3QuaW5jbHVkZXMoXCJwYXNzXCIpLFxuICAgICAgXCJ2ZXJkaWN0IG11c3Qgbm90IGNvbnRhaW4gJ3Bhc3MnIGZvciBjb2VyY2VkIHN0cmluZ3NcIixcbiAgICApO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgd3JhcEFycmF5IGNvZXJjaW9uIHVuaXQgdGVzdHMgKCMzNTg1KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJ3cmFwQXJyYXkgY29lcmNpb24gZm9yIHNpbXBsZSBzdHJpbmctYXJyYXkgZmllbGRzICgjMzU4NSlcIiwgKCkgPT4ge1xuICAvKipcbiAgICogVGhlIHdyYXBBcnJheSBjb2VyY2lvbiBsb2dpYyBleHRyYWN0ZWQgZnJvbSBkYi10b29scy50cyBzbGljZUNvbXBsZXRlRXhlY3V0ZS5cbiAgICogRHVwbGljYXRlZCBoZXJlIHNvIHdlIGNhbiB1bml0LXRlc3QgaXQgZGlyZWN0bHkuXG4gICAqL1xuICBmdW5jdGlvbiB3cmFwQXJyYXkodjogYW55KTogYW55W10ge1xuICAgIHJldHVybiB2ID09IG51bGwgPyBbXSA6IEFycmF5LmlzQXJyYXkodikgPyB2IDogW3ZdO1xuICB9XG5cbiAgdGVzdChcIm51bGwgcmV0dXJucyBlbXB0eSBhcnJheVwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbCh3cmFwQXJyYXkobnVsbCksIFtdKTtcbiAgfSk7XG5cbiAgdGVzdChcInVuZGVmaW5lZCByZXR1cm5zIGVtcHR5IGFycmF5XCIsICgpID0+IHtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHdyYXBBcnJheSh1bmRlZmluZWQpLCBbXSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJwbGFpbiBzdHJpbmcgd3JhcHMgaW50byBzaW5nbGUtZWxlbWVudCBhcnJheVwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICAgIHdyYXBBcnJheShcIlZhbGlkYXRlZCBUZWNoIFVJIGZsb3dzIGFuZCBQb3J0YWwgc2VsZi1zZXJ2aWNlIGZsb3dzXCIpLFxuICAgICAgW1wiVmFsaWRhdGVkIFRlY2ggVUkgZmxvd3MgYW5kIFBvcnRhbCBzZWxmLXNlcnZpY2UgZmxvd3NcIl0sXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcImFycmF5IHBhc3NlcyB0aHJvdWdoIHVuY2hhbmdlZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgYXJyID0gW1wiaXRlbTFcIiwgXCJpdGVtMlwiXTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHdyYXBBcnJheShhcnIpLCBhcnIpO1xuICB9KTtcblxuICB0ZXN0KFwiZW1wdHkgYXJyYXkgcGFzc2VzIHRocm91Z2ggdW5jaGFuZ2VkXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHdyYXBBcnJheShbXSksIFtdKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEhhbmRsZXIgaW50ZWdyYXRpb24gd2l0aCBjb2VyY2VkIHBhcmFtcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJoYW5kbGVDb21wbGV0ZVNsaWNlIHdpdGggY29lcmNlZCBzdHJpbmcgYXJyYXlzICgjMzU2NSlcIiwgKCkgPT4ge1xuICBsZXQgZGJQYXRoOiBzdHJpbmc7XG4gIGxldCBiYXNlUGF0aDogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIGRiUGF0aCA9IHBhdGguam9pbihcbiAgICAgIGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgXCJnc2QtY29lcmNlLVwiKSksXG4gICAgICBcInRlc3QuZGJcIixcbiAgICApO1xuICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuXG4gICAgYmFzZVBhdGggPSBmcy5ta2R0ZW1wU3luYyhwYXRoLmpvaW4ob3MudG1wZGlyKCksIFwiZ3NkLWNvZXJjZS1oYW5kbGVyLVwiKSk7XG4gICAgY29uc3Qgc2xpY2VEaXIgPSBwYXRoLmpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIik7XG4gICAgZnMubWtkaXJTeW5jKHNsaWNlRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIGNvbnN0IHJvYWRtYXBQYXRoID0gcGF0aC5qb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtUk9BRE1BUC5tZFwiKTtcbiAgICBmcy53cml0ZUZpbGVTeW5jKFxuICAgICAgcm9hZG1hcFBhdGgsXG4gICAgICBbXG4gICAgICAgIFwiIyBNMDAxOiBUZXN0IE1pbGVzdG9uZVwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgICBcIlwiLFxuICAgICAgICAnLSBbIF0gKipTMDE6IFRlc3QgU2xpY2UqKiBgcmlzazptZWRpdW1gIGBkZXBlbmRzOltdYCcsXG4gICAgICAgIFwiICAtIEFmdGVyIHRoaXM6IGJhc2ljIGZ1bmN0aW9uYWxpdHkgd29ya3NcIixcbiAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICApO1xuXG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiB9KTtcbiAgICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIsIHRpdGxlOiBcIlRhc2sgMVwiIH0pO1xuICB9KTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBmcy5ybVN5bmMocGF0aC5kaXJuYW1lKGRiUGF0aCksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICBmcy5ybVN5bmMoYmFzZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgdGVzdChcImhhbmRsZXIgc3VjY2VlZHMgd2l0aCBjb2VyY2VkIGZpbGVzTW9kaWZpZWQgYW5kIHJlcXVpcmVtZW50c0FkdmFuY2VkXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBwYXJhbXMgPSBtYWtlVmFsaWRTbGljZVBhcmFtcygpO1xuICAgIC8vIFNpbXVsYXRlIGNvZXJjaW9uIGZyb20gcGxhaW4gc3RyaW5nc1xuICAgIHBhcmFtcy5maWxlc01vZGlmaWVkID0gW1wic3JjL2Zvby50c1wiLCBcInNyYy9iYXIudHNcIl0ubWFwKChmKSA9PiB7XG4gICAgICBjb25zdCBbcCwgZF0gPSBzcGxpdFBhaXIoZik7XG4gICAgICByZXR1cm4geyBwYXRoOiBwLCBkZXNjcmlwdGlvbjogZCB9O1xuICAgIH0pO1xuICAgIHBhcmFtcy5yZXF1aXJlbWVudHNBZHZhbmNlZCA9IFtcIlIwMDEgXHUyMDE0IEhhbmRsZXIgdmFsaWRhdGVzIHRhc2sgY29tcGxldGlvblwiXS5tYXAoKHIpID0+IHtcbiAgICAgIGNvbnN0IFtpZCwgaG93XSA9IHNwbGl0UGFpcihyKTtcbiAgICAgIHJldHVybiB7IGlkLCBob3cgfTtcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZUNvbXBsZXRlU2xpY2UocGFyYW1zLCBiYXNlUGF0aCk7XG4gICAgYXNzZXJ0Lm9rKCEoXCJlcnJvclwiIGluIHJlc3VsdCksIFwiaGFuZGxlciBzaG91bGQgc3VjY2VlZFwiKTtcbiAgICBpZiAoIShcImVycm9yXCIgaW4gcmVzdWx0KSkge1xuICAgICAgY29uc3Qgc3VtbWFyeSA9IGZzLnJlYWRGaWxlU3luYyhyZXN1bHQuc3VtbWFyeVBhdGgsIFwidXRmLThcIik7XG4gICAgICBhc3NlcnQubWF0Y2goc3VtbWFyeSwgL3NyY1xcL2Zvb1xcLnRzLyk7XG4gICAgICBhc3NlcnQubWF0Y2goc3VtbWFyeSwgL1IwMDEvKTtcbiAgICAgIGFzc2VydC5tYXRjaChzdW1tYXJ5LCAvSGFuZGxlciB2YWxpZGF0ZXMgdGFzayBjb21wbGV0aW9uLyk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiaGFuZGxlciBzdWNjZWVkcyB3aXRoIGNvZXJjZWQgcmVxdWlyZXMgYW5kIHJlcXVpcmVtZW50c1ZhbGlkYXRlZFwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcGFyYW1zID0gbWFrZVZhbGlkU2xpY2VQYXJhbXMoKTtcbiAgICBwYXJhbXMucmVxdWlyZXMgPSBbXCJTMDAgXHUyMDE0IFByb3ZpZGVkIGJhc2UgaW5mcmFzdHJ1Y3R1cmVcIl0ubWFwKChyKSA9PiB7XG4gICAgICBjb25zdCBbc2xpY2UsIHByb3ZpZGVzXSA9IHNwbGl0UGFpcihyKTtcbiAgICAgIHJldHVybiB7IHNsaWNlLCBwcm92aWRlcyB9O1xuICAgIH0pO1xuICAgIHBhcmFtcy5yZXF1aXJlbWVudHNWYWxpZGF0ZWQgPSBbXCJSMDAyIC0gVGVzdHMgcGFzc1wiXS5tYXAoKHIpID0+IHtcbiAgICAgIGNvbnN0IFtpZCwgcHJvb2ZdID0gc3BsaXRQYWlyKHIpO1xuICAgICAgcmV0dXJuIHsgaWQsIHByb29mIH07XG4gICAgfSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVDb21wbGV0ZVNsaWNlKHBhcmFtcywgYmFzZVBhdGgpO1xuICAgIGFzc2VydC5vayghKFwiZXJyb3JcIiBpbiByZXN1bHQpLCBcImhhbmRsZXIgc2hvdWxkIHN1Y2NlZWRcIik7XG4gICAgaWYgKCEoXCJlcnJvclwiIGluIHJlc3VsdCkpIHtcbiAgICAgIGNvbnN0IHN1bW1hcnkgPSBmcy5yZWFkRmlsZVN5bmMocmVzdWx0LnN1bW1hcnlQYXRoLCBcInV0Zi04XCIpO1xuICAgICAgYXNzZXJ0Lm1hdGNoKHN1bW1hcnksIC9TMDAvKTtcbiAgICAgIGFzc2VydC5tYXRjaChzdW1tYXJ5LCAvUHJvdmlkZWQgYmFzZSBpbmZyYXN0cnVjdHVyZS8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKHN1bW1hcnksIC9SMDAyLyk7XG4gICAgICBhc3NlcnQubWF0Y2goc3VtbWFyeSwgL1Rlc3RzIHBhc3MvKTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxTQUFTLFVBQVUsTUFBTSxZQUFZLGlCQUFpQjtBQUN0RCxPQUFPLFlBQVk7QUFDbkIsWUFBWSxRQUFRO0FBQ3BCLFlBQVksVUFBVTtBQUN0QixZQUFZLFFBQVE7QUFDcEI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLDJCQUEyQjtBQVNwQyxTQUFTLFVBQVUsR0FBNkI7QUFDOUMsUUFBTSxJQUFJLEVBQUUsTUFBTSwwQkFBMEI7QUFDNUMsU0FBTyxJQUFJLENBQUMsRUFBRSxDQUFDLEVBQUUsS0FBSyxHQUFHLEVBQUUsQ0FBQyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsRUFBRSxLQUFLLEdBQUcsRUFBRTtBQUN2RDtBQUVBLFNBQVMsdUJBQTRDO0FBQ25ELFNBQU87QUFBQSxJQUNMLFNBQVM7QUFBQSxJQUNULGFBQWE7QUFBQSxJQUNiLFlBQVk7QUFBQSxJQUNaLFVBQVU7QUFBQSxJQUNWLFdBQVc7QUFBQSxJQUNYLGNBQWM7QUFBQSxJQUNkLFlBQVk7QUFBQSxJQUNaLGtCQUFrQjtBQUFBLElBQ2xCLFdBQVc7QUFBQSxJQUNYLFVBQVUsQ0FBQyxZQUFZO0FBQUEsSUFDdkIsY0FBYyxDQUFDLE1BQU07QUFBQSxJQUNyQixxQkFBcUIsQ0FBQztBQUFBLElBQ3RCLHVCQUF1QixDQUFDO0FBQUEsSUFDeEIsVUFBVSxDQUFDLGNBQWM7QUFBQSxJQUN6QixzQkFBc0IsQ0FBQztB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
