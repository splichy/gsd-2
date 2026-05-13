import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DISPATCH_RULES } from "../auto-dispatch.js";
const completingRule = DISPATCH_RULES.find((r) => r.name === "completing-milestone \u2192 complete-milestone");
test("completing-milestone dispatch rule exists", () => {
  assert.ok(completingRule, "rule should exist in DISPATCH_RULES");
});
test("completing-milestone blocks when VALIDATION verdict is needs-remediation (#2675)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-remediation-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  try {
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
      [
        "---",
        "verdict: needs-remediation",
        "remediation_round: 0",
        "---",
        "",
        "# Validation Report",
        "",
        "3 success criteria failed. Remediation required."
      ].join("\n")
    );
    const ctx = {
      mid: "M001",
      midTitle: "Test Milestone",
      basePath: base,
      state: { phase: "completing-milestone" },
      prefs: {},
      session: void 0
    };
    const result = await completingRule.match(ctx);
    assert.ok(result !== null, "rule should match");
    assert.equal(result.action, "stop", "should return stop action");
    if (result.action === "stop") {
      assert.equal(result.level, "warning", "should be warning level (pausable)");
      assert.ok(
        result.reason.includes("needs-remediation"),
        "reason should mention needs-remediation"
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("completing-milestone blocks when VALIDATION verdict is needs-attention (#5747)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-attention-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  try {
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
      [
        "---",
        "verdict: needs-attention",
        "remediation_round: 0",
        "---",
        "",
        "# Validation Report",
        "",
        "Acceptance proof is incomplete and needs human attention."
      ].join("\n")
    );
    const ctx = {
      mid: "M001",
      midTitle: "Test Milestone",
      basePath: base,
      state: { phase: "completing-milestone" },
      prefs: {},
      session: void 0
    };
    const result = await completingRule.match(ctx);
    assert.ok(result !== null, "rule should match");
    assert.equal(result.action, "stop", "should return stop action");
    if (result.action === "stop") {
      assert.equal(result.level, "warning", "should be warning level (pausable)");
      assert.ok(
        result.reason.includes("needs-attention"),
        "reason should mention needs-attention"
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("completing-milestone proceeds normally when VALIDATION verdict is pass (#2675 guard)", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-remediation-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  try {
    writeFileSync(
      join(base, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
      [
        "---",
        "verdict: pass",
        "---",
        "",
        "# Validation Report",
        "",
        "All criteria met."
      ].join("\n")
    );
    const ctx = {
      mid: "M001",
      midTitle: "Test Milestone",
      basePath: base,
      state: { phase: "completing-milestone" },
      prefs: {},
      session: void 0
    };
    const result = await completingRule.match(ctx);
    if (result && result.action === "stop") {
      assert.ok(
        !result.reason.includes("needs-remediation"),
        "pass verdict should NOT trigger the remediation guard"
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZW1lZGlhdGlvbi1jb21wbGV0aW9uLWd1YXJkLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUmVncmVzc2lvbiB0ZXN0cyBmb3Igbm9uLXBhc3NpbmcgVkFMSURBVElPTiB2ZXJkaWN0czogY29tcGxldGluZy1taWxlc3RvbmVcbiAqIGRpc3BhdGNoIG11c3QgYmxvY2sgY29tcGxldGlvbiB3aGVuIFZBTElEQVRJT04gbmVlZHMgcmVtZWRpYXRpb24gb3IgYXR0ZW50aW9uLlxuICpcbiAqIFdpdGhvdXQgdGhpcyBndWFyZCwgbmVlZHMtcmVtZWRpYXRpb24gKyBhbGxTbGljZXNEb25lIGNhdXNlcyBhIGxvb3A6XG4gKiBjb21wbGV0ZS1taWxlc3RvbmUgZGlzcGF0Y2hlZCBcdTIxOTIgYWdlbnQgcmVmdXNlcyAoY29ycmVjdCkgXHUyMTkyIG5vIFNVTU1BUllcbiAqIFx1MjE5MiByZS1kaXNwYXRjaCBcdTIxOTIgcmVwZWF0IHVudGlsIHN0dWNrIGRldGVjdGlvbiBmaXJlcy5cbiAqL1xuaW1wb3J0IHsgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBESVNQQVRDSF9SVUxFUyB9IGZyb20gXCIuLi9hdXRvLWRpc3BhdGNoLnRzXCI7XG5cbi8qKiBGaW5kIHRoZSBjb21wbGV0aW5nLW1pbGVzdG9uZSBkaXNwYXRjaCBydWxlICovXG5jb25zdCBjb21wbGV0aW5nUnVsZSA9IERJU1BBVENIX1JVTEVTLmZpbmQociA9PiByLm5hbWUgPT09IFwiY29tcGxldGluZy1taWxlc3RvbmUgXHUyMTkyIGNvbXBsZXRlLW1pbGVzdG9uZVwiKTtcblxudGVzdChcImNvbXBsZXRpbmctbWlsZXN0b25lIGRpc3BhdGNoIHJ1bGUgZXhpc3RzXCIsICgpID0+IHtcbiAgYXNzZXJ0Lm9rKGNvbXBsZXRpbmdSdWxlLCBcInJ1bGUgc2hvdWxkIGV4aXN0IGluIERJU1BBVENIX1JVTEVTXCIpO1xufSk7XG5cbnRlc3QoXCJjb21wbGV0aW5nLW1pbGVzdG9uZSBibG9ja3Mgd2hlbiBWQUxJREFUSU9OIHZlcmRpY3QgaXMgbmVlZHMtcmVtZWRpYXRpb24gKCMyNjc1KVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1yZW1lZGlhdGlvbi1cIikpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgdHJ5IHtcbiAgICAvLyBXcml0ZSBhIFZBTElEQVRJT04gZmlsZSB3aXRoIG5lZWRzLXJlbWVkaWF0aW9uIHZlcmRpY3RcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtVkFMSURBVElPTi5tZFwiKSxcbiAgICAgIFtcbiAgICAgICAgXCItLS1cIixcbiAgICAgICAgXCJ2ZXJkaWN0OiBuZWVkcy1yZW1lZGlhdGlvblwiLFxuICAgICAgICBcInJlbWVkaWF0aW9uX3JvdW5kOiAwXCIsXG4gICAgICAgIFwiLS0tXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyBWYWxpZGF0aW9uIFJlcG9ydFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIjMgc3VjY2VzcyBjcml0ZXJpYSBmYWlsZWQuIFJlbWVkaWF0aW9uIHJlcXVpcmVkLlwiLFxuICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICk7XG5cbiAgICBjb25zdCBjdHggPSB7XG4gICAgICBtaWQ6IFwiTTAwMVwiLFxuICAgICAgbWlkVGl0bGU6IFwiVGVzdCBNaWxlc3RvbmVcIixcbiAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgc3RhdGU6IHsgcGhhc2U6IFwiY29tcGxldGluZy1taWxlc3RvbmVcIiB9IGFzIGFueSxcbiAgICAgIHByZWZzOiB7fSBhcyBhbnksXG4gICAgICBzZXNzaW9uOiB1bmRlZmluZWQsXG4gICAgfTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNvbXBsZXRpbmdSdWxlIS5tYXRjaChjdHgpO1xuXG4gICAgYXNzZXJ0Lm9rKHJlc3VsdCAhPT0gbnVsbCwgXCJydWxlIHNob3VsZCBtYXRjaFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0IS5hY3Rpb24sIFwic3RvcFwiLCBcInNob3VsZCByZXR1cm4gc3RvcCBhY3Rpb25cIik7XG4gICAgaWYgKHJlc3VsdCEuYWN0aW9uID09PSBcInN0b3BcIikge1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCEubGV2ZWwsIFwid2FybmluZ1wiLCBcInNob3VsZCBiZSB3YXJuaW5nIGxldmVsIChwYXVzYWJsZSlcIik7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIHJlc3VsdCEucmVhc29uLmluY2x1ZGVzKFwibmVlZHMtcmVtZWRpYXRpb25cIiksXG4gICAgICAgIFwicmVhc29uIHNob3VsZCBtZW50aW9uIG5lZWRzLXJlbWVkaWF0aW9uXCIsXG4gICAgICApO1xuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcImNvbXBsZXRpbmctbWlsZXN0b25lIGJsb2NrcyB3aGVuIFZBTElEQVRJT04gdmVyZGljdCBpcyBuZWVkcy1hdHRlbnRpb24gKCM1NzQ3KVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1hdHRlbnRpb24tXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLVZBTElEQVRJT04ubWRcIiksXG4gICAgICBbXG4gICAgICAgIFwiLS0tXCIsXG4gICAgICAgIFwidmVyZGljdDogbmVlZHMtYXR0ZW50aW9uXCIsXG4gICAgICAgIFwicmVtZWRpYXRpb25fcm91bmQ6IDBcIixcbiAgICAgICAgXCItLS1cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCIjIFZhbGlkYXRpb24gUmVwb3J0XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiQWNjZXB0YW5jZSBwcm9vZiBpcyBpbmNvbXBsZXRlIGFuZCBuZWVkcyBodW1hbiBhdHRlbnRpb24uXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgKTtcblxuICAgIGNvbnN0IGN0eCA9IHtcbiAgICAgIG1pZDogXCJNMDAxXCIsXG4gICAgICBtaWRUaXRsZTogXCJUZXN0IE1pbGVzdG9uZVwiLFxuICAgICAgYmFzZVBhdGg6IGJhc2UsXG4gICAgICBzdGF0ZTogeyBwaGFzZTogXCJjb21wbGV0aW5nLW1pbGVzdG9uZVwiIH0gYXMgYW55LFxuICAgICAgcHJlZnM6IHt9IGFzIGFueSxcbiAgICAgIHNlc3Npb246IHVuZGVmaW5lZCxcbiAgICB9O1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY29tcGxldGluZ1J1bGUhLm1hdGNoKGN0eCk7XG5cbiAgICBhc3NlcnQub2socmVzdWx0ICE9PSBudWxsLCBcInJ1bGUgc2hvdWxkIG1hdGNoXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQhLmFjdGlvbiwgXCJzdG9wXCIsIFwic2hvdWxkIHJldHVybiBzdG9wIGFjdGlvblwiKTtcbiAgICBpZiAocmVzdWx0IS5hY3Rpb24gPT09IFwic3RvcFwiKSB7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0IS5sZXZlbCwgXCJ3YXJuaW5nXCIsIFwic2hvdWxkIGJlIHdhcm5pbmcgbGV2ZWwgKHBhdXNhYmxlKVwiKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgcmVzdWx0IS5yZWFzb24uaW5jbHVkZXMoXCJuZWVkcy1hdHRlbnRpb25cIiksXG4gICAgICAgIFwicmVhc29uIHNob3VsZCBtZW50aW9uIG5lZWRzLWF0dGVudGlvblwiLFxuICAgICAgKTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJjb21wbGV0aW5nLW1pbGVzdG9uZSBwcm9jZWVkcyBub3JtYWxseSB3aGVuIFZBTElEQVRJT04gdmVyZGljdCBpcyBwYXNzICgjMjY3NSBndWFyZClcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcmVtZWRpYXRpb24tXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIHRyeSB7XG4gICAgLy8gV3JpdGUgYSBWQUxJREFUSU9OIGZpbGUgd2l0aCBwYXNzIHZlcmRpY3RcbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtVkFMSURBVElPTi5tZFwiKSxcbiAgICAgIFtcbiAgICAgICAgXCItLS1cIixcbiAgICAgICAgXCJ2ZXJkaWN0OiBwYXNzXCIsXG4gICAgICAgIFwiLS0tXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiIyBWYWxpZGF0aW9uIFJlcG9ydFwiLFxuICAgICAgICBcIlwiLFxuICAgICAgICBcIkFsbCBjcml0ZXJpYSBtZXQuXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgKTtcblxuICAgIGNvbnN0IGN0eCA9IHtcbiAgICAgIG1pZDogXCJNMDAxXCIsXG4gICAgICBtaWRUaXRsZTogXCJUZXN0IE1pbGVzdG9uZVwiLFxuICAgICAgYmFzZVBhdGg6IGJhc2UsXG4gICAgICBzdGF0ZTogeyBwaGFzZTogXCJjb21wbGV0aW5nLW1pbGVzdG9uZVwiIH0gYXMgYW55LFxuICAgICAgcHJlZnM6IHt9IGFzIGFueSxcbiAgICAgIHNlc3Npb246IHVuZGVmaW5lZCxcbiAgICB9O1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY29tcGxldGluZ1J1bGUhLm1hdGNoKGN0eCk7XG5cbiAgICAvLyBTaG91bGQgTk9UIHJldHVybiBhIHN0b3AgXHUyMDE0IHNob3VsZCBlaXRoZXIgZGlzcGF0Y2ggb3IgcmV0dXJuIHN0b3AgZm9yXG4gICAgLy8gYSBkaWZmZXJlbnQgcmVhc29uIChlLmcuIG1pc3NpbmcgU1VNTUFSWSBmaWxlcywgbm8gaW1wbGVtZW50YXRpb24pXG4gICAgaWYgKHJlc3VsdCAmJiByZXN1bHQuYWN0aW9uID09PSBcInN0b3BcIikge1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICAhcmVzdWx0LnJlYXNvbi5pbmNsdWRlcyhcIm5lZWRzLXJlbWVkaWF0aW9uXCIpLFxuICAgICAgICBcInBhc3MgdmVyZGljdCBzaG91bGQgTk9UIHRyaWdnZXIgdGhlIHJlbWVkaWF0aW9uIGd1YXJkXCIsXG4gICAgICApO1xuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVFBLFNB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
