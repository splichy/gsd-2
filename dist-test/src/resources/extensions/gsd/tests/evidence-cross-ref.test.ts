// Project/App: GSD-2
// File Purpose: Tests for verification evidence cross-reference mismatch policy.

import test from "node:test";
import assert from "node:assert/strict";

import { crossReferenceEvidence } from "../safety/evidence-cross-ref.ts";
import type { EvidenceEntry } from "../safety/evidence-collector.ts";

test("claims of passing verification become errors when recorded bash evidence failed", () => {
  const mismatches = crossReferenceEvidence(
    [{ command: "npm test", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "npm test",
        exitCode: 1,
        outputSnippet: "failed",
        timestamp: Date.now(),
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
  assert.match(mismatches[0].reason, /Claimed exitCode=0/);
});

test("missing recorded bash evidence remains a warning", () => {
  const mismatches = crossReferenceEvidence(
    [{ command: "npm test", exitCode: 0, verdict: "passed" }],
    [],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "warning");
});
