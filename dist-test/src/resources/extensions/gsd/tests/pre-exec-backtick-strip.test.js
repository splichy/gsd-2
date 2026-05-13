import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeFilePath, checkFilePathConsistency } from "../pre-execution-checks.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
describe("normalizeFilePath backtick stripping (#3649)", () => {
  it("strips backticks from file paths", () => {
    assert.equal(normalizeFilePath("`src/foo.ts`"), "src/foo.ts");
  });
  it("strips doubled backticks and trailing notes from file paths", () => {
    assert.equal(normalizeFilePath("``src/foo.ts`` - current state"), "src/foo.ts");
    assert.equal(normalizeFilePath("``src/foo.ts`` (current state)"), "src/foo.ts");
  });
  it("strips stray backticks from dash-annotated bare paths (#4550)", () => {
    assert.equal(
      normalizeFilePath(".gsd/KNOWLEDGE.md` \u2014 append-only S05 lessons section"),
      ".gsd/KNOWLEDGE.md"
    );
  });
  it("prefers a backticked path inside a dash-annotated prefix (#4550)", () => {
    assert.equal(
      normalizeFilePath("Input `src/foo.ts` \u2014 current state"),
      "src/foo.ts"
    );
  });
  it("strips backticks even when mixed with other normalization", () => {
    assert.equal(normalizeFilePath("`./src//bar.ts`"), "src/bar.ts");
  });
  it("leaves normal paths unchanged", () => {
    assert.equal(normalizeFilePath("src/foo.ts"), "src/foo.ts");
  });
  it("handles empty string", () => {
    assert.equal(normalizeFilePath(""), "");
  });
});
describe("checkFilePathConsistency checks task.inputs not task.files (#3626)", () => {
  it("ignores missing task.files entries that are only likely outputs", () => {
    const task = {
      milestone_id: "M001",
      slice_id: "S01",
      id: "T01",
      title: "Create missing file",
      status: "pending",
      one_liner: "",
      narrative: "",
      verification_result: "",
      duration: "",
      completed_at: null,
      blocker_discovered: false,
      deviations: "",
      known_issues: "",
      key_files: [],
      key_decisions: [],
      full_summary_md: "",
      description: "",
      estimate: "",
      files: ["src/new-file.ts"],
      verify: "",
      inputs: [],
      expected_output: ["src/new-file.ts"],
      observability_impact: "",
      full_plan_md: "",
      sequence: 0
    };
    const tmp = resolve(process.cwd(), ".tmp-pre-exec-files-ignore");
    try {
      mkdirSync(tmp, { recursive: true });
      assert.deepEqual(checkFilePathConsistency([task], tmp), []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
describe("checkFilePathConsistency handles doubled-backtick annotations (#3892)", () => {
  it("accepts existing files when task.inputs include doubled-backtick notes", () => {
    const task = {
      milestone_id: "M001",
      slice_id: "S01",
      id: "T01",
      title: "Test Task",
      status: "pending",
      one_liner: "",
      narrative: "",
      verification_result: "",
      duration: "",
      completed_at: null,
      blocker_discovered: false,
      deviations: "",
      known_issues: "",
      key_files: [],
      key_decisions: [],
      full_summary_md: "",
      description: "",
      estimate: "",
      files: [],
      verify: "",
      inputs: ["``src/foo.ts`` (current state)"],
      expected_output: [],
      observability_impact: "",
      full_plan_md: "",
      sequence: 0
    };
    const tmp = resolve(process.cwd(), ".tmp-pre-exec-3892");
    try {
      mkdirSync(resolve(tmp, "src"), { recursive: true });
      writeFileSync(resolve(tmp, "src", "foo.ts"), "// ok");
      const results = checkFilePathConsistency([task], tmp);
      assert.deepEqual(results, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcmUtZXhlYy1iYWNrdGljay1zdHJpcC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdCBmb3IgIzM2MjYgLyAjMzY0OSBcdTIwMTQgcHJlLWV4ZWN1dGlvbi1jaGVja3MgZmFsc2UgcG9zaXRpdmVzXG4gKlxuICogVHdvIHNvdXJjZXMgb2YgZmFsc2UgcG9zaXRpdmVzIHdlcmUgZml4ZWQ6XG4gKiAgIDEuIG5vcm1hbGl6ZUZpbGVQYXRoIGRpZCBub3Qgc3RyaXAgYmFja3RpY2sgd3JhcHBpbmcgZnJvbSBMTE0tZ2VuZXJhdGVkXG4gKiAgICAgIHBhdGhzIGxpa2UgYHNyYy9mb28udHNgLCBjYXVzaW5nIGZpbGUtZXhpc3RlbmNlIGNoZWNrcyB0byBmYWlsICgjMzY0OSkuXG4gKiAgIDIuIGNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSBjaGVja2VkIGJvdGggdGFzay5maWxlcyBhbmQgdGFzay5pbnB1dHMsIGJ1dFxuICogICAgICB0YXNrLmZpbGVzIChcImZpbGVzIGxpa2VseSB0b3VjaGVkXCIpIGludGVudGlvbmFsbHkgaW5jbHVkZXMgZmlsZXMgdGhhdFxuICogICAgICB3aWxsIGJlIGNyZWF0ZWQgYnkgdGhlIHRhc2ssIHNvIHRoZXkgZG9uJ3QgbmVlZCB0byBwcmUtZXhpc3QgKCMzNjI2KS5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tICdub2RlOnRlc3QnXG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCdcbmltcG9ydCB7IG5vcm1hbGl6ZUZpbGVQYXRoLCBjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3kgfSBmcm9tICcuLi9wcmUtZXhlY3V0aW9uLWNoZWNrcy50cydcbmltcG9ydCB7IG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcydcbmltcG9ydCB7IHJlc29sdmUgfSBmcm9tICdub2RlOnBhdGgnXG5cbmRlc2NyaWJlKCdub3JtYWxpemVGaWxlUGF0aCBiYWNrdGljayBzdHJpcHBpbmcgKCMzNjQ5KScsICgpID0+IHtcbiAgaXQoJ3N0cmlwcyBiYWNrdGlja3MgZnJvbSBmaWxlIHBhdGhzJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChub3JtYWxpemVGaWxlUGF0aCgnYHNyYy9mb28udHNgJyksICdzcmMvZm9vLnRzJylcbiAgfSlcblxuICBpdCgnc3RyaXBzIGRvdWJsZWQgYmFja3RpY2tzIGFuZCB0cmFpbGluZyBub3RlcyBmcm9tIGZpbGUgcGF0aHMnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKG5vcm1hbGl6ZUZpbGVQYXRoKCdgYHNyYy9mb28udHNgYCAtIGN1cnJlbnQgc3RhdGUnKSwgJ3NyYy9mb28udHMnKVxuICAgIGFzc2VydC5lcXVhbChub3JtYWxpemVGaWxlUGF0aCgnYGBzcmMvZm9vLnRzYGAgKGN1cnJlbnQgc3RhdGUpJyksICdzcmMvZm9vLnRzJylcbiAgfSlcblxuICBpdCgnc3RyaXBzIHN0cmF5IGJhY2t0aWNrcyBmcm9tIGRhc2gtYW5ub3RhdGVkIGJhcmUgcGF0aHMgKCM0NTUwKScsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBub3JtYWxpemVGaWxlUGF0aCgnLmdzZC9LTk9XTEVER0UubWRgIFx1MjAxNCBhcHBlbmQtb25seSBTMDUgbGVzc29ucyBzZWN0aW9uJyksXG4gICAgICAnLmdzZC9LTk9XTEVER0UubWQnLFxuICAgIClcbiAgfSlcblxuICBpdCgncHJlZmVycyBhIGJhY2t0aWNrZWQgcGF0aCBpbnNpZGUgYSBkYXNoLWFubm90YXRlZCBwcmVmaXggKCM0NTUwKScsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBub3JtYWxpemVGaWxlUGF0aCgnSW5wdXQgYHNyYy9mb28udHNgIFx1MjAxNCBjdXJyZW50IHN0YXRlJyksXG4gICAgICAnc3JjL2Zvby50cycsXG4gICAgKVxuICB9KVxuXG4gIGl0KCdzdHJpcHMgYmFja3RpY2tzIGV2ZW4gd2hlbiBtaXhlZCB3aXRoIG90aGVyIG5vcm1hbGl6YXRpb24nLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKG5vcm1hbGl6ZUZpbGVQYXRoKCdgLi9zcmMvL2Jhci50c2AnKSwgJ3NyYy9iYXIudHMnKVxuICB9KVxuXG4gIGl0KCdsZWF2ZXMgbm9ybWFsIHBhdGhzIHVuY2hhbmdlZCcsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwobm9ybWFsaXplRmlsZVBhdGgoJ3NyYy9mb28udHMnKSwgJ3NyYy9mb28udHMnKVxuICB9KVxuXG4gIGl0KCdoYW5kbGVzIGVtcHR5IHN0cmluZycsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwobm9ybWFsaXplRmlsZVBhdGgoJycpLCAnJylcbiAgfSlcbn0pXG5cbmRlc2NyaWJlKCdjaGVja0ZpbGVQYXRoQ29uc2lzdGVuY3kgY2hlY2tzIHRhc2suaW5wdXRzIG5vdCB0YXNrLmZpbGVzICgjMzYyNiknLCAoKSA9PiB7XG4gIGl0KCdpZ25vcmVzIG1pc3NpbmcgdGFzay5maWxlcyBlbnRyaWVzIHRoYXQgYXJlIG9ubHkgbGlrZWx5IG91dHB1dHMnLCAoKSA9PiB7XG4gICAgY29uc3QgdGFzayA9IHtcbiAgICAgIG1pbGVzdG9uZV9pZDogJ00wMDEnLFxuICAgICAgc2xpY2VfaWQ6ICdTMDEnLFxuICAgICAgaWQ6ICdUMDEnLFxuICAgICAgdGl0bGU6ICdDcmVhdGUgbWlzc2luZyBmaWxlJyxcbiAgICAgIHN0YXR1czogJ3BlbmRpbmcnLFxuICAgICAgb25lX2xpbmVyOiAnJyxcbiAgICAgIG5hcnJhdGl2ZTogJycsXG4gICAgICB2ZXJpZmljYXRpb25fcmVzdWx0OiAnJyxcbiAgICAgIGR1cmF0aW9uOiAnJyxcbiAgICAgIGNvbXBsZXRlZF9hdDogbnVsbCxcbiAgICAgIGJsb2NrZXJfZGlzY292ZXJlZDogZmFsc2UsXG4gICAgICBkZXZpYXRpb25zOiAnJyxcbiAgICAgIGtub3duX2lzc3VlczogJycsXG4gICAgICBrZXlfZmlsZXM6IFtdLFxuICAgICAga2V5X2RlY2lzaW9uczogW10sXG4gICAgICBmdWxsX3N1bW1hcnlfbWQ6ICcnLFxuICAgICAgZGVzY3JpcHRpb246ICcnLFxuICAgICAgZXN0aW1hdGU6ICcnLFxuICAgICAgZmlsZXM6IFsnc3JjL25ldy1maWxlLnRzJ10sXG4gICAgICB2ZXJpZnk6ICcnLFxuICAgICAgaW5wdXRzOiBbXSxcbiAgICAgIGV4cGVjdGVkX291dHB1dDogWydzcmMvbmV3LWZpbGUudHMnXSxcbiAgICAgIG9ic2VydmFiaWxpdHlfaW1wYWN0OiAnJyxcbiAgICAgIGZ1bGxfcGxhbl9tZDogJycsXG4gICAgICBzZXF1ZW5jZTogMCxcbiAgICB9XG5cbiAgICBjb25zdCB0bXAgPSByZXNvbHZlKHByb2Nlc3MuY3dkKCksICcudG1wLXByZS1leGVjLWZpbGVzLWlnbm9yZScpXG4gICAgdHJ5IHtcbiAgICAgIG1rZGlyU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlIH0pXG4gICAgICBhc3NlcnQuZGVlcEVxdWFsKGNoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeShbdGFzayBhcyBhbnldLCB0bXApLCBbXSlcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pXG4gICAgfVxuICB9KVxufSlcblxuZGVzY3JpYmUoJ2NoZWNrRmlsZVBhdGhDb25zaXN0ZW5jeSBoYW5kbGVzIGRvdWJsZWQtYmFja3RpY2sgYW5ub3RhdGlvbnMgKCMzODkyKScsICgpID0+IHtcbiAgaXQoJ2FjY2VwdHMgZXhpc3RpbmcgZmlsZXMgd2hlbiB0YXNrLmlucHV0cyBpbmNsdWRlIGRvdWJsZWQtYmFja3RpY2sgbm90ZXMnLCAoKSA9PiB7XG4gICAgY29uc3QgdGFzayA9IHtcbiAgICAgIG1pbGVzdG9uZV9pZDogJ00wMDEnLFxuICAgICAgc2xpY2VfaWQ6ICdTMDEnLFxuICAgICAgaWQ6ICdUMDEnLFxuICAgICAgdGl0bGU6ICdUZXN0IFRhc2snLFxuICAgICAgc3RhdHVzOiAncGVuZGluZycsXG4gICAgICBvbmVfbGluZXI6ICcnLFxuICAgICAgbmFycmF0aXZlOiAnJyxcbiAgICAgIHZlcmlmaWNhdGlvbl9yZXN1bHQ6ICcnLFxuICAgICAgZHVyYXRpb246ICcnLFxuICAgICAgY29tcGxldGVkX2F0OiBudWxsLFxuICAgICAgYmxvY2tlcl9kaXNjb3ZlcmVkOiBmYWxzZSxcbiAgICAgIGRldmlhdGlvbnM6ICcnLFxuICAgICAga25vd25faXNzdWVzOiAnJyxcbiAgICAgIGtleV9maWxlczogW10sXG4gICAgICBrZXlfZGVjaXNpb25zOiBbXSxcbiAgICAgIGZ1bGxfc3VtbWFyeV9tZDogJycsXG4gICAgICBkZXNjcmlwdGlvbjogJycsXG4gICAgICBlc3RpbWF0ZTogJycsXG4gICAgICBmaWxlczogW10sXG4gICAgICB2ZXJpZnk6ICcnLFxuICAgICAgaW5wdXRzOiBbJ2Bgc3JjL2Zvby50c2BgIChjdXJyZW50IHN0YXRlKSddLFxuICAgICAgZXhwZWN0ZWRfb3V0cHV0OiBbXSxcbiAgICAgIG9ic2VydmFiaWxpdHlfaW1wYWN0OiAnJyxcbiAgICAgIGZ1bGxfcGxhbl9tZDogJycsXG4gICAgICBzZXF1ZW5jZTogMCxcbiAgICB9XG5cbiAgICBjb25zdCB0bXAgPSByZXNvbHZlKHByb2Nlc3MuY3dkKCksICcudG1wLXByZS1leGVjLTM4OTInKVxuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMocmVzb2x2ZSh0bXAsICdzcmMnKSwgeyByZWN1cnNpdmU6IHRydWUgfSlcbiAgICAgIHdyaXRlRmlsZVN5bmMocmVzb2x2ZSh0bXAsICdzcmMnLCAnZm9vLnRzJyksICcvLyBvaycpXG4gICAgICBjb25zdCByZXN1bHRzID0gY2hlY2tGaWxlUGF0aENvbnNpc3RlbmN5KFt0YXNrIGFzIGFueV0sIHRtcClcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0cywgW10pXG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KVxuICAgIH1cbiAgfSlcbn0pXG4iXSwKICAibWFwcGluZ3MiOiAiQUFXQSxTQUFTLFVBQVUsVUFBVTtBQUM3QixPQUFPLFlBQVk7QUFDbkIsU0FBUyxtQkFBbUIsZ0NBQWdDO0FBQzVELFNBQVMsV0FBVyxRQUFRLHFCQUFxQjtBQUNqRCxTQUFTLGVBQWU7QUFFeEIsU0FBUyxnREFBZ0QsTUFBTTtBQUM3RCxLQUFHLG9DQUFvQyxNQUFNO0FBQzNDLFdBQU8sTUFBTSxrQkFBa0IsY0FBYyxHQUFHLFlBQVk7QUFBQSxFQUM5RCxDQUFDO0FBRUQsS0FBRywrREFBK0QsTUFBTTtBQUN0RSxXQUFPLE1BQU0sa0JBQWtCLGdDQUFnQyxHQUFHLFlBQVk7QUFDOUUsV0FBTyxNQUFNLGtCQUFrQixnQ0FBZ0MsR0FBRyxZQUFZO0FBQUEsRUFDaEYsQ0FBQztBQUVELEtBQUcsaUVBQWlFLE1BQU07QUFDeEUsV0FBTztBQUFBLE1BQ0wsa0JBQWtCLDJEQUFzRDtBQUFBLE1BQ3hFO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsb0VBQW9FLE1BQU07QUFDM0UsV0FBTztBQUFBLE1BQ0wsa0JBQWtCLHlDQUFvQztBQUFBLE1BQ3REO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsNkRBQTZELE1BQU07QUFDcEUsV0FBTyxNQUFNLGtCQUFrQixpQkFBaUIsR0FBRyxZQUFZO0FBQUEsRUFDakUsQ0FBQztBQUVELEtBQUcsaUNBQWlDLE1BQU07QUFDeEMsV0FBTyxNQUFNLGtCQUFrQixZQUFZLEdBQUcsWUFBWTtBQUFBLEVBQzVELENBQUM7QUFFRCxLQUFHLHdCQUF3QixNQUFNO0FBQy9CLFdBQU8sTUFBTSxrQkFBa0IsRUFBRSxHQUFHLEVBQUU7QUFBQSxFQUN4QyxDQUFDO0FBQ0gsQ0FBQztBQUVELFNBQVMsc0VBQXNFLE1BQU07QUFDbkYsS0FBRyxtRUFBbUUsTUFBTTtB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
