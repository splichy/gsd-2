import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promptGoldenUnits } from "./fixtures/prompt-golden-fixtures.js";
test("prompt golden fixtures render required markers and measurable sizes", async (t) => {
  const base = makePromptFixtureRoot();
  t.after(() => cleanup(base));
  const { buildCompleteSlicePrompt, buildExecuteTaskPrompt, buildPlanSlicePrompt, invalidateAllCaches } = await loadPromptBuilders(base);
  invalidateAllCaches();
  const prompts = {
    "plan-slice": await buildPlanSlicePrompt("M001", "Baseline Milestone", "S01", "Baseline Slice", base, "minimal"),
    "execute-task": await buildExecuteTaskPrompt("M001", "S01", "Baseline Slice", "T01", "Implement baseline harness", base, "minimal"),
    "complete-slice": await buildCompleteSlicePrompt("M001", "Baseline Milestone", "S01", "Baseline Slice", base, "minimal")
  };
  for (const fixture of promptGoldenUnits) {
    const prompt = prompts[fixture.unitType];
    const metrics = promptMetric(prompt);
    assert.ok(metrics.chars > 1e3, `${fixture.unitType} should be a real prompt, not an empty fixture`);
    assert.match(metrics.sha256, /^[a-f0-9]{64}$/);
    for (const marker of fixture.requiredMarkers) {
      assert.ok(prompt.includes(marker), `${fixture.unitType} prompt should include marker: ${marker}`);
    }
  }
});
test("prompt golden fixtures meet Phase 2 reduction gate", async (t) => {
  const base = makePromptFixtureRoot();
  t.after(() => cleanup(base));
  const { buildCompleteSlicePrompt, buildExecuteTaskPrompt, buildPlanSlicePrompt, invalidateAllCaches } = await loadPromptBuilders(base);
  invalidateAllCaches();
  const prompts = {
    "plan-slice": await buildPlanSlicePrompt("M001", "Baseline Milestone", "S01", "Baseline Slice", base, "minimal"),
    "execute-task": await buildExecuteTaskPrompt("M001", "S01", "Baseline Slice", "T01", "Implement baseline harness", base, "minimal"),
    "complete-slice": await buildCompleteSlicePrompt("M001", "Baseline Milestone", "S01", "Baseline Slice", base, "minimal")
  };
  let baselineChars = 0;
  let currentChars = 0;
  for (const fixture of promptGoldenUnits) {
    const chars = prompts[fixture.unitType].length;
    baselineChars += fixture.phase2StartChars;
    currentChars += chars;
    assert.ok(
      chars <= Math.floor(fixture.phase2StartChars * 0.6),
      `${fixture.unitType} should be at least 40% smaller than Phase 2 start baseline (${chars}/${fixture.phase2StartChars})`
    );
  }
  assert.ok(
    currentChars <= Math.floor(baselineChars * 0.6),
    `representative fixtures should be at least 40% smaller in aggregate (${currentChars}/${baselineChars})`
  );
});
test("prompt golden fixtures expose stable unit coverage for future reductions", () => {
  assert.deepEqual(
    promptGoldenUnits.map((unit) => unit.unitType),
    ["plan-slice", "execute-task", "complete-slice"]
  );
  for (const unit of promptGoldenUnits) {
    assert.ok(unit.requiredMarkers.length >= 4, `${unit.unitType} should pin meaningful prompt markers`);
  }
});
function promptMetric(prompt) {
  return {
    chars: prompt.length,
    bytes: Buffer.byteLength(prompt, "utf8"),
    lines: prompt.length === 0 ? 0 : prompt.split(/\r\n|\r|\n/).length,
    sha256: createHash("sha256").update(prompt).digest("hex")
  };
}
async function loadPromptBuilders(base) {
  process.env.GSD_HOME = join(base, ".test-gsd-home");
  const prompts = await import("../resources/extensions/gsd/auto-prompts.js");
  const cache = await import("../resources/extensions/gsd/cache.js");
  return { ...prompts, invalidateAllCaches: cache.invalidateAllCaches };
}
function makePromptFixtureRoot() {
  const base = mkdtempSync(join(tmpdir(), "gsd-prompt-golden-"));
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    [
      "# M001 Roadmap",
      "",
      "## Slices",
      "- [ ] **S01: Baseline Slice** `risk:low` `depends:[]`",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    [
      "# S01 Plan",
      "",
      "## Goal",
      "Create a baseline harness for the long-running refactor.",
      "",
      "## Tasks",
      "- T01: Implement baseline harness",
      "",
      "## Verification",
      "- Baseline tests pass.",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(tasksDir, "T01-PLAN.md"),
    [
      "# T01 Plan",
      "",
      "## Steps",
      "1. Implement baseline harness.",
      "2. Add tests.",
      "",
      "## Must-haves",
      "- Metrics are emitted as JSON.",
      "",
      "## Verification",
      "- Run focused baseline tests.",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(tasksDir, "T01-SUMMARY.md"),
    [
      "---",
      "id: T01",
      "---",
      "# T01 Summary",
      "",
      "Implemented baseline harness and tests.",
      ""
    ].join("\n")
  );
  return base;
}
function cleanup(base) {
  rmSync(base, { recursive: true, force: true });
}
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL3Byb21wdC1nb2xkZW4tZml4dHVyZXMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IENoYXJhY3Rlcml6YXRpb24gdGVzdHMgZm9yIHJlcHJlc2VudGF0aXZlIEdTRCBwcm9tcHQgZml4dHVyZSBtZXRyaWNzLlxuXG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7IG1rZGlyU3luYywgbWtkdGVtcFN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcblxuaW1wb3J0IHsgcHJvbXB0R29sZGVuVW5pdHMsIHR5cGUgUHJvbXB0R29sZGVuVW5pdFR5cGUgfSBmcm9tIFwiLi9maXh0dXJlcy9wcm9tcHQtZ29sZGVuLWZpeHR1cmVzLnRzXCI7XG5cbnRlc3QoXCJwcm9tcHQgZ29sZGVuIGZpeHR1cmVzIHJlbmRlciByZXF1aXJlZCBtYXJrZXJzIGFuZCBtZWFzdXJhYmxlIHNpemVzXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlUHJvbXB0Rml4dHVyZVJvb3QoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGJhc2UpKTtcbiAgY29uc3QgeyBidWlsZENvbXBsZXRlU2xpY2VQcm9tcHQsIGJ1aWxkRXhlY3V0ZVRhc2tQcm9tcHQsIGJ1aWxkUGxhblNsaWNlUHJvbXB0LCBpbnZhbGlkYXRlQWxsQ2FjaGVzIH0gPSBhd2FpdCBsb2FkUHJvbXB0QnVpbGRlcnMoYmFzZSk7XG4gIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcblxuICBjb25zdCBwcm9tcHRzOiBSZWNvcmQ8UHJvbXB0R29sZGVuVW5pdFR5cGUsIHN0cmluZz4gPSB7XG4gICAgXCJwbGFuLXNsaWNlXCI6IGF3YWl0IGJ1aWxkUGxhblNsaWNlUHJvbXB0KFwiTTAwMVwiLCBcIkJhc2VsaW5lIE1pbGVzdG9uZVwiLCBcIlMwMVwiLCBcIkJhc2VsaW5lIFNsaWNlXCIsIGJhc2UsIFwibWluaW1hbFwiKSxcbiAgICBcImV4ZWN1dGUtdGFza1wiOiBhd2FpdCBidWlsZEV4ZWN1dGVUYXNrUHJvbXB0KFwiTTAwMVwiLCBcIlMwMVwiLCBcIkJhc2VsaW5lIFNsaWNlXCIsIFwiVDAxXCIsIFwiSW1wbGVtZW50IGJhc2VsaW5lIGhhcm5lc3NcIiwgYmFzZSwgXCJtaW5pbWFsXCIpLFxuICAgIFwiY29tcGxldGUtc2xpY2VcIjogYXdhaXQgYnVpbGRDb21wbGV0ZVNsaWNlUHJvbXB0KFwiTTAwMVwiLCBcIkJhc2VsaW5lIE1pbGVzdG9uZVwiLCBcIlMwMVwiLCBcIkJhc2VsaW5lIFNsaWNlXCIsIGJhc2UsIFwibWluaW1hbFwiKSxcbiAgfTtcblxuICBmb3IgKGNvbnN0IGZpeHR1cmUgb2YgcHJvbXB0R29sZGVuVW5pdHMpIHtcbiAgICBjb25zdCBwcm9tcHQgPSBwcm9tcHRzW2ZpeHR1cmUudW5pdFR5cGVdO1xuICAgIGNvbnN0IG1ldHJpY3MgPSBwcm9tcHRNZXRyaWMocHJvbXB0KTtcblxuICAgIGFzc2VydC5vayhtZXRyaWNzLmNoYXJzID4gMTAwMCwgYCR7Zml4dHVyZS51bml0VHlwZX0gc2hvdWxkIGJlIGEgcmVhbCBwcm9tcHQsIG5vdCBhbiBlbXB0eSBmaXh0dXJlYCk7XG4gICAgYXNzZXJ0Lm1hdGNoKG1ldHJpY3Muc2hhMjU2LCAvXlthLWYwLTldezY0fSQvKTtcbiAgICBmb3IgKGNvbnN0IG1hcmtlciBvZiBmaXh0dXJlLnJlcXVpcmVkTWFya2Vycykge1xuICAgICAgYXNzZXJ0Lm9rKHByb21wdC5pbmNsdWRlcyhtYXJrZXIpLCBgJHtmaXh0dXJlLnVuaXRUeXBlfSBwcm9tcHQgc2hvdWxkIGluY2x1ZGUgbWFya2VyOiAke21hcmtlcn1gKTtcbiAgICB9XG4gIH1cbn0pO1xuXG50ZXN0KFwicHJvbXB0IGdvbGRlbiBmaXh0dXJlcyBtZWV0IFBoYXNlIDIgcmVkdWN0aW9uIGdhdGVcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VQcm9tcHRGaXh0dXJlUm9vdCgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBjb25zdCB7IGJ1aWxkQ29tcGxldGVTbGljZVByb21wdCwgYnVpbGRFeGVjdXRlVGFza1Byb21wdCwgYnVpbGRQbGFuU2xpY2VQcm9tcHQsIGludmFsaWRhdGVBbGxDYWNoZXMgfSA9IGF3YWl0IGxvYWRQcm9tcHRCdWlsZGVycyhiYXNlKTtcbiAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuXG4gIGNvbnN0IHByb21wdHM6IFJlY29yZDxQcm9tcHRHb2xkZW5Vbml0VHlwZSwgc3RyaW5nPiA9IHtcbiAgICBcInBsYW4tc2xpY2VcIjogYXdhaXQgYnVpbGRQbGFuU2xpY2VQcm9tcHQoXCJNMDAxXCIsIFwiQmFzZWxpbmUgTWlsZXN0b25lXCIsIFwiUzAxXCIsIFwiQmFzZWxpbmUgU2xpY2VcIiwgYmFzZSwgXCJtaW5pbWFsXCIpLFxuICAgIFwiZXhlY3V0ZS10YXNrXCI6IGF3YWl0IGJ1aWxkRXhlY3V0ZVRhc2tQcm9tcHQoXCJNMDAxXCIsIFwiUzAxXCIsIFwiQmFzZWxpbmUgU2xpY2VcIiwgXCJUMDFcIiwgXCJJbXBsZW1lbnQgYmFzZWxpbmUgaGFybmVzc1wiLCBiYXNlLCBcIm1pbmltYWxcIiksXG4gICAgXCJjb21wbGV0ZS1zbGljZVwiOiBhd2FpdCBidWlsZENvbXBsZXRlU2xpY2VQcm9tcHQoXCJNMDAxXCIsIFwiQmFzZWxpbmUgTWlsZXN0b25lXCIsIFwiUzAxXCIsIFwiQmFzZWxpbmUgU2xpY2VcIiwgYmFzZSwgXCJtaW5pbWFsXCIpLFxuICB9O1xuXG4gIGxldCBiYXNlbGluZUNoYXJzID0gMDtcbiAgbGV0IGN1cnJlbnRDaGFycyA9IDA7XG4gIGZvciAoY29uc3QgZml4dHVyZSBvZiBwcm9tcHRHb2xkZW5Vbml0cykge1xuICAgIGNvbnN0IGNoYXJzID0gcHJvbXB0c1tmaXh0dXJlLnVuaXRUeXBlXS5sZW5ndGg7XG4gICAgYmFzZWxpbmVDaGFycyArPSBmaXh0dXJlLnBoYXNlMlN0YXJ0Q2hhcnM7XG4gICAgY3VycmVudENoYXJzICs9IGNoYXJzO1xuICAgIGFzc2VydC5vayhcbiAgICAgIGNoYXJzIDw9IE1hdGguZmxvb3IoZml4dHVyZS5waGFzZTJTdGFydENoYXJzICogMC42KSxcbiAgICAgIGAke2ZpeHR1cmUudW5pdFR5cGV9IHNob3VsZCBiZSBhdCBsZWFzdCA0MCUgc21hbGxlciB0aGFuIFBoYXNlIDIgc3RhcnQgYmFzZWxpbmUgKCR7Y2hhcnN9LyR7Zml4dHVyZS5waGFzZTJTdGFydENoYXJzfSlgLFxuICAgICk7XG4gIH1cbiAgYXNzZXJ0Lm9rKFxuICAgIGN1cnJlbnRDaGFycyA8PSBNYXRoLmZsb29yKGJhc2VsaW5lQ2hhcnMgKiAwLjYpLFxuICAgIGByZXByZXNlbnRhdGl2ZSBmaXh0dXJlcyBzaG91bGQgYmUgYXQgbGVhc3QgNDAlIHNtYWxsZXIgaW4gYWdncmVnYXRlICgke2N1cnJlbnRDaGFyc30vJHtiYXNlbGluZUNoYXJzfSlgLFxuICApO1xufSk7XG5cbnRlc3QoXCJwcm9tcHQgZ29sZGVuIGZpeHR1cmVzIGV4cG9zZSBzdGFibGUgdW5pdCBjb3ZlcmFnZSBmb3IgZnV0dXJlIHJlZHVjdGlvbnNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIHByb21wdEdvbGRlblVuaXRzLm1hcCh1bml0ID0+IHVuaXQudW5pdFR5cGUpLFxuICAgIFtcInBsYW4tc2xpY2VcIiwgXCJleGVjdXRlLXRhc2tcIiwgXCJjb21wbGV0ZS1zbGljZVwiXSxcbiAgKTtcbiAgZm9yIChjb25zdCB1bml0IG9mIHByb21wdEdvbGRlblVuaXRzKSB7XG4gICAgYXNzZXJ0Lm9rKHVuaXQucmVxdWlyZWRNYXJrZXJzLmxlbmd0aCA+PSA0LCBgJHt1bml0LnVuaXRUeXBlfSBzaG91bGQgcGluIG1lYW5pbmdmdWwgcHJvbXB0IG1hcmtlcnNgKTtcbiAgfVxufSk7XG5cbmZ1bmN0aW9uIHByb21wdE1ldHJpYyhwcm9tcHQ6IHN0cmluZyk6IHsgY2hhcnM6IG51bWJlcjsgYnl0ZXM6IG51bWJlcjsgbGluZXM6IG51bWJlcjsgc2hhMjU2OiBzdHJpbmcgfSB7XG4gIHJldHVybiB7XG4gICAgY2hhcnM6IHByb21wdC5sZW5ndGgsXG4gICAgYnl0ZXM6IEJ1ZmZlci5ieXRlTGVuZ3RoKHByb21wdCwgXCJ1dGY4XCIpLFxuICAgIGxpbmVzOiBwcm9tcHQubGVuZ3RoID09PSAwID8gMCA6IHByb21wdC5zcGxpdCgvXFxyXFxufFxccnxcXG4vKS5sZW5ndGgsXG4gICAgc2hhMjU2OiBjcmVhdGVIYXNoKFwic2hhMjU2XCIpLnVwZGF0ZShwcm9tcHQpLmRpZ2VzdChcImhleFwiKSxcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9hZFByb21wdEJ1aWxkZXJzKGJhc2U6IHN0cmluZyk6IFByb21pc2U8e1xuICBidWlsZENvbXBsZXRlU2xpY2VQcm9tcHQ6IHR5cGVvZiBpbXBvcnQoXCIuLi9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvYXV0by1wcm9tcHRzLnRzXCIpLmJ1aWxkQ29tcGxldGVTbGljZVByb21wdDtcbiAgYnVpbGRFeGVjdXRlVGFza1Byb21wdDogdHlwZW9mIGltcG9ydChcIi4uL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLXByb21wdHMudHNcIikuYnVpbGRFeGVjdXRlVGFza1Byb21wdDtcbiAgYnVpbGRQbGFuU2xpY2VQcm9tcHQ6IHR5cGVvZiBpbXBvcnQoXCIuLi9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvYXV0by1wcm9tcHRzLnRzXCIpLmJ1aWxkUGxhblNsaWNlUHJvbXB0O1xuICBpbnZhbGlkYXRlQWxsQ2FjaGVzOiB0eXBlb2YgaW1wb3J0KFwiLi4vcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2NhY2hlLnRzXCIpLmludmFsaWRhdGVBbGxDYWNoZXM7XG59PiB7XG4gIHByb2Nlc3MuZW52LkdTRF9IT01FID0gam9pbihiYXNlLCBcIi50ZXN0LWdzZC1ob21lXCIpO1xuICBjb25zdCBwcm9tcHRzID0gYXdhaXQgaW1wb3J0KFwiLi4vcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2F1dG8tcHJvbXB0cy50c1wiKTtcbiAgY29uc3QgY2FjaGUgPSBhd2FpdCBpbXBvcnQoXCIuLi9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvY2FjaGUudHNcIik7XG4gIHJldHVybiB7IC4uLnByb21wdHMsIGludmFsaWRhdGVBbGxDYWNoZXM6IGNhY2hlLmludmFsaWRhdGVBbGxDYWNoZXMgfTtcbn1cblxuZnVuY3Rpb24gbWFrZVByb21wdEZpeHR1cmVSb290KCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1wcm9tcHQtZ29sZGVuLVwiKSk7XG4gIGNvbnN0IHNsaWNlRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgY29uc3QgdGFza3NEaXIgPSBqb2luKHNsaWNlRGlyLCBcInRhc2tzXCIpO1xuICBta2RpclN5bmModGFza3NEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSxcbiAgICBbXG4gICAgICBcIiMgTTAwMSBSb2FkbWFwXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBTbGljZXNcIixcbiAgICAgIFwiLSBbIF0gKipTMDE6IEJhc2VsaW5lIFNsaWNlKiogYHJpc2s6bG93YCBgZGVwZW5kczpbXWBcIixcbiAgICAgIFwiXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oc2xpY2VEaXIsIFwiUzAxLVBMQU4ubWRcIiksXG4gICAgW1xuICAgICAgXCIjIFMwMSBQbGFuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBHb2FsXCIsXG4gICAgICBcIkNyZWF0ZSBhIGJhc2VsaW5lIGhhcm5lc3MgZm9yIHRoZSBsb25nLXJ1bm5pbmcgcmVmYWN0b3IuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBUYXNrc1wiLFxuICAgICAgXCItIFQwMTogSW1wbGVtZW50IGJhc2VsaW5lIGhhcm5lc3NcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFZlcmlmaWNhdGlvblwiLFxuICAgICAgXCItIEJhc2VsaW5lIHRlc3RzIHBhc3MuXCIsXG4gICAgICBcIlwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgKTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKHRhc2tzRGlyLCBcIlQwMS1QTEFOLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiIyBUMDEgUGxhblwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgU3RlcHNcIixcbiAgICAgIFwiMS4gSW1wbGVtZW50IGJhc2VsaW5lIGhhcm5lc3MuXCIsXG4gICAgICBcIjIuIEFkZCB0ZXN0cy5cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIE11c3QtaGF2ZXNcIixcbiAgICAgIFwiLSBNZXRyaWNzIGFyZSBlbWl0dGVkIGFzIEpTT04uXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBWZXJpZmljYXRpb25cIixcbiAgICAgIFwiLSBSdW4gZm9jdXNlZCBiYXNlbGluZSB0ZXN0cy5cIixcbiAgICAgIFwiXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4odGFza3NEaXIsIFwiVDAxLVNVTU1BUlkubWRcIiksXG4gICAgW1xuICAgICAgXCItLS1cIixcbiAgICAgIFwiaWQ6IFQwMVwiLFxuICAgICAgXCItLS1cIixcbiAgICAgIFwiIyBUMDEgU3VtbWFyeVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiSW1wbGVtZW50ZWQgYmFzZWxpbmUgaGFybmVzcyBhbmQgdGVzdHMuXCIsXG4gICAgICBcIlwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgKTtcblxuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLE9BQU8sWUFBWTtBQUNuQixTQUFTLGtCQUFrQjtBQUMzQixTQUFTLFdBQVcsYUFBYSxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBQ3JCLE9BQU8sVUFBVTtBQUVqQixTQUFTLHlCQUFvRDtBQUU3RCxLQUFLLHVFQUF1RSxPQUFPLE1BQU07QUFDdkYsUUFBTSxPQUFPLHNCQUFzQjtBQUNuQyxJQUFFLE1BQU0sTUFBTSxRQUFRLElBQUksQ0FBQztBQUMzQixRQUFNLEVBQUUsMEJBQTBCLHdCQUF3QixzQkFBc0Isb0JBQW9CLElBQUksTUFBTSxtQkFBbUIsSUFBSTtBQUNySSxzQkFBb0I7QUFFcEIsUUFBTSxVQUFnRDtBQUFBLElBQ3BELGNBQWMsTUFBTSxxQkFBcUIsUUFBUSxzQkFBc0IsT0FBTyxrQkFBa0IsTUFBTSxTQUFTO0FBQUEsSUFDL0csZ0JBQWdCLE1BQU0sdUJBQXVCLFFBQVEsT0FBTyxrQkFBa0IsT0FBTyw4QkFBOEIsTUFBTSxTQUFTO0FBQUEsSUFDbEksa0JBQWtCLE1BQU0seUJBQXlCLFFBQVEsc0JBQXNCLE9BQU8sa0JBQWtCLE1BQU0sU0FBUztBQUFBLEVBQ3pIO0FBRUEsYUFBVyxXQUFXLG1CQUFtQjtBQUN2QyxVQUFNLFNBQVMsUUFBUSxRQUFRLFFBQVE7QUFDdkMsVUFB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
