import test from "node:test";
import assert from "node:assert/strict";
import { buildPrEvidence } from "../pr-evidence.js";
test("pr-evidence hardening: strips HTML comments from summaries", () => {
  const evidence = buildPrEvidence({
    milestoneId: "M001",
    summaries: ["visible<!-- hidden secret -->tail"]
  });
  assert.ok(!evidence.body.includes("<!--"), "raw <!-- must not appear");
  assert.ok(!evidence.body.includes("hidden secret"), "comment contents must be stripped");
  assert.ok(evidence.body.includes("visibletail"), "non-comment text must remain");
});
test("pr-evidence hardening: removes Co-Authored-By trailer from why", () => {
  const evidence = buildPrEvidence({
    milestoneId: "M001",
    why: "Real reason here.\nCo-Authored-By: Evil <e@evil.com>\nMore reason."
  });
  assert.ok(!evidence.body.includes("Evil <e@evil.com>"));
  assert.ok(!/Co-Authored-By:/i.test(evidence.body));
  assert.ok(evidence.body.includes("Real reason here."));
  assert.ok(evidence.body.includes("More reason."));
});
test("pr-evidence hardening: removes Signed-off-by trailer from how", () => {
  const evidence = buildPrEvidence({
    milestoneId: "M001",
    how: "Step one.\nSigned-off-by: Forged <f@x.com>\nStep two."
  });
  assert.ok(!evidence.body.includes("Forged <f@x.com>"));
  assert.ok(!/Signed-off-by:/i.test(evidence.body));
  assert.ok(evidence.body.includes("Step one."));
  assert.ok(evidence.body.includes("Step two."));
});
test("pr-evidence hardening: trailer-name match is case-insensitive", () => {
  const evidence = buildPrEvidence({
    milestoneId: "M001",
    why: "ok\nco-authored-by: lower <l@l.com>\nSIGNED-OFF-BY: upper <u@u.com>\nend"
  });
  assert.ok(!evidence.body.includes("lower <l@l.com>"));
  assert.ok(!evidence.body.includes("upper <u@u.com>"));
  assert.ok(evidence.body.includes("ok"));
  assert.ok(evidence.body.includes("end"));
});
test("pr-evidence hardening: caps oversize summaries item with truncation suffix", () => {
  const big = "A".repeat(5 * 1024);
  const evidence = buildPrEvidence({
    milestoneId: "M001",
    summaries: [big]
  });
  const lines = evidence.body.split("\n");
  const longLine = lines.find((l) => l.startsWith("AAAA"));
  assert.ok(longLine, "expected truncated A-line in body");
  assert.ok(longLine.endsWith(" \u2026 [truncated]"), "must end with truncation suffix");
  assert.ok(
    Buffer.byteLength(longLine, "utf8") <= 2048,
    `truncated item must be within 2 KB cap, got ${Buffer.byteLength(longLine, "utf8")}`
  );
});
test("pr-evidence hardening: HTML comment split across summary items is preserved literally", () => {
  const evidence = buildPrEvidence({
    milestoneId: "M001",
    summaries: ["first item ends <!--", "--> second item begins"]
  });
  assert.ok(evidence.body.includes("<!--"), "open marker preserved as literal");
  assert.ok(evidence.body.includes("-->"), "close marker preserved as literal");
  assert.ok(evidence.body.includes("first item ends"));
  assert.ok(evidence.body.includes("second item begins"));
});
test("pr-evidence hardening: clean input is byte-identical to pre-hardening output", () => {
  const cleanInput = {
    milestoneId: "M001",
    milestoneTitle: "Authentication",
    changeType: "feat",
    linkedIssue: "Closes #123",
    summaries: ["### S01\nImplemented login flow."],
    blockers: ["Awaiting design review"],
    roadmapItems: ["- [x] **S01: Login**"],
    metrics: ["**Units executed:** 3"],
    testsRun: ["npm test", "npm run typecheck:extensions"],
    why: "Users need to authenticate before accessing protected resources.",
    how: "Added password hash check and session token issuance.",
    rollbackNotes: ["Revert the merge commit."]
  };
  const expected = [
    "## TL;DR",
    "",
    "**What:** Ship milestone M001 - Authentication",
    "**Why:** Users need to authenticate before accessing protected resources.",
    "**How:** Added password hash check and session token issuance.",
    "",
    "## What",
    "",
    "### S01\nImplemented login flow.",
    "",
    "## Blockers",
    "",
    "- Awaiting design review",
    "",
    "## Why",
    "",
    "Users need to authenticate before accessing protected resources.",
    "",
    "## How",
    "",
    "Added password hash check and session token issuance.",
    "",
    "## Linked Issue",
    "",
    "Closes #123",
    "",
    "## Roadmap",
    "",
    "- [x] **S01: Login**",
    "",
    "## Metrics",
    "",
    "- **Units executed:** 3",
    "",
    "## Tests Run",
    "",
    "- npm test",
    "- npm run typecheck:extensions",
    "",
    "## Change Type",
    "",
    "- [x] `feat` - New feature or capability",
    "- [ ] `fix` - Bug fix",
    "- [ ] `refactor` - Code restructuring",
    "- [ ] `test` - Adding or updating tests",
    "- [ ] `docs` - Documentation only",
    "- [ ] `chore` - Build, CI, or tooling changes",
    "",
    "## Rollback And Compatibility",
    "",
    "- Revert the merge commit.",
    "",
    "## AI Assistance Disclosure",
    "",
    "This PR was prepared with AI assistance."
  ].join("\n");
  const actual = buildPrEvidence(cleanInput).body;
  assert.equal(actual, expected, "clean input must produce byte-identical output (sanitizer is no-op)");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wci1ldmlkZW5jZS1oYXJkZW5pbmcudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IEhhcmRlbmluZyB0ZXN0cyBmb3IgYnVpbGRQckV2aWRlbmNlIFx1MjAxNCBIVE1MLWNvbW1lbnQgc3RyaXBwaW5nLCBmYWtlIGNvbW1pdC10cmFpbGVyIHJlbW92YWwsIGFuZCBwZXItaXRlbSBsZW5ndGggY2FwcGluZy5cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbmltcG9ydCB7IGJ1aWxkUHJFdmlkZW5jZSwgdHlwZSBQckV2aWRlbmNlSW5wdXQgfSBmcm9tIFwiLi4vcHItZXZpZGVuY2UudHNcIjtcblxudGVzdChcInByLWV2aWRlbmNlIGhhcmRlbmluZzogc3RyaXBzIEhUTUwgY29tbWVudHMgZnJvbSBzdW1tYXJpZXNcIiwgKCkgPT4ge1xuICBjb25zdCBldmlkZW5jZSA9IGJ1aWxkUHJFdmlkZW5jZSh7XG4gICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHN1bW1hcmllczogW1widmlzaWJsZTwhLS0gaGlkZGVuIHNlY3JldCAtLT50YWlsXCJdLFxuICB9KTtcbiAgYXNzZXJ0Lm9rKCFldmlkZW5jZS5ib2R5LmluY2x1ZGVzKFwiPCEtLVwiKSwgXCJyYXcgPCEtLSBtdXN0IG5vdCBhcHBlYXJcIik7XG4gIGFzc2VydC5vayghZXZpZGVuY2UuYm9keS5pbmNsdWRlcyhcImhpZGRlbiBzZWNyZXRcIiksIFwiY29tbWVudCBjb250ZW50cyBtdXN0IGJlIHN0cmlwcGVkXCIpO1xuICBhc3NlcnQub2soZXZpZGVuY2UuYm9keS5pbmNsdWRlcyhcInZpc2libGV0YWlsXCIpLCBcIm5vbi1jb21tZW50IHRleHQgbXVzdCByZW1haW5cIik7XG59KTtcblxudGVzdChcInByLWV2aWRlbmNlIGhhcmRlbmluZzogcmVtb3ZlcyBDby1BdXRob3JlZC1CeSB0cmFpbGVyIGZyb20gd2h5XCIsICgpID0+IHtcbiAgY29uc3QgZXZpZGVuY2UgPSBidWlsZFByRXZpZGVuY2Uoe1xuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICB3aHk6IFwiUmVhbCByZWFzb24gaGVyZS5cXG5Dby1BdXRob3JlZC1CeTogRXZpbCA8ZUBldmlsLmNvbT5cXG5Nb3JlIHJlYXNvbi5cIixcbiAgfSk7XG4gIGFzc2VydC5vayghZXZpZGVuY2UuYm9keS5pbmNsdWRlcyhcIkV2aWwgPGVAZXZpbC5jb20+XCIpKTtcbiAgYXNzZXJ0Lm9rKCEvQ28tQXV0aG9yZWQtQnk6L2kudGVzdChldmlkZW5jZS5ib2R5KSk7XG4gIGFzc2VydC5vayhldmlkZW5jZS5ib2R5LmluY2x1ZGVzKFwiUmVhbCByZWFzb24gaGVyZS5cIikpO1xuICBhc3NlcnQub2soZXZpZGVuY2UuYm9keS5pbmNsdWRlcyhcIk1vcmUgcmVhc29uLlwiKSk7XG59KTtcblxudGVzdChcInByLWV2aWRlbmNlIGhhcmRlbmluZzogcmVtb3ZlcyBTaWduZWQtb2ZmLWJ5IHRyYWlsZXIgZnJvbSBob3dcIiwgKCkgPT4ge1xuICBjb25zdCBldmlkZW5jZSA9IGJ1aWxkUHJFdmlkZW5jZSh7XG4gICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIGhvdzogXCJTdGVwIG9uZS5cXG5TaWduZWQtb2ZmLWJ5OiBGb3JnZWQgPGZAeC5jb20+XFxuU3RlcCB0d28uXCIsXG4gIH0pO1xuICBhc3NlcnQub2soIWV2aWRlbmNlLmJvZHkuaW5jbHVkZXMoXCJGb3JnZWQgPGZAeC5jb20+XCIpKTtcbiAgYXNzZXJ0Lm9rKCEvU2lnbmVkLW9mZi1ieTovaS50ZXN0KGV2aWRlbmNlLmJvZHkpKTtcbiAgYXNzZXJ0Lm9rKGV2aWRlbmNlLmJvZHkuaW5jbHVkZXMoXCJTdGVwIG9uZS5cIikpO1xuICBhc3NlcnQub2soZXZpZGVuY2UuYm9keS5pbmNsdWRlcyhcIlN0ZXAgdHdvLlwiKSk7XG59KTtcblxudGVzdChcInByLWV2aWRlbmNlIGhhcmRlbmluZzogdHJhaWxlci1uYW1lIG1hdGNoIGlzIGNhc2UtaW5zZW5zaXRpdmVcIiwgKCkgPT4ge1xuICBjb25zdCBldmlkZW5jZSA9IGJ1aWxkUHJFdmlkZW5jZSh7XG4gICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHdoeTogXCJva1xcbmNvLWF1dGhvcmVkLWJ5OiBsb3dlciA8bEBsLmNvbT5cXG5TSUdORUQtT0ZGLUJZOiB1cHBlciA8dUB1LmNvbT5cXG5lbmRcIixcbiAgfSk7XG4gIGFzc2VydC5vayghZXZpZGVuY2UuYm9keS5pbmNsdWRlcyhcImxvd2VyIDxsQGwuY29tPlwiKSk7XG4gIGFzc2VydC5vayghZXZpZGVuY2UuYm9keS5pbmNsdWRlcyhcInVwcGVyIDx1QHUuY29tPlwiKSk7XG4gIGFzc2VydC5vayhldmlkZW5jZS5ib2R5LmluY2x1ZGVzKFwib2tcIikpO1xuICBhc3NlcnQub2soZXZpZGVuY2UuYm9keS5pbmNsdWRlcyhcImVuZFwiKSk7XG59KTtcblxudGVzdChcInByLWV2aWRlbmNlIGhhcmRlbmluZzogY2FwcyBvdmVyc2l6ZSBzdW1tYXJpZXMgaXRlbSB3aXRoIHRydW5jYXRpb24gc3VmZml4XCIsICgpID0+IHtcbiAgY29uc3QgYmlnID0gXCJBXCIucmVwZWF0KDUgKiAxMDI0KTsgLy8gNSBLQlxuICBjb25zdCBldmlkZW5jZSA9IGJ1aWxkUHJFdmlkZW5jZSh7XG4gICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHN1bW1hcmllczogW2JpZ10sXG4gIH0pO1xuICAvLyBGaW5kIHRoZSB0cnVuY2F0ZWQgQS1ibG9jayBpbiB0aGUgYm9keSBhbmQgYXNzZXJ0IGl0IGlzIGJvdW5kZWQuXG4gIGNvbnN0IGxpbmVzID0gZXZpZGVuY2UuYm9keS5zcGxpdChcIlxcblwiKTtcbiAgY29uc3QgbG9uZ0xpbmUgPSBsaW5lcy5maW5kKChsKSA9PiBsLnN0YXJ0c1dpdGgoXCJBQUFBXCIpKTtcbiAgYXNzZXJ0Lm9rKGxvbmdMaW5lLCBcImV4cGVjdGVkIHRydW5jYXRlZCBBLWxpbmUgaW4gYm9keVwiKTtcbiAgYXNzZXJ0Lm9rKGxvbmdMaW5lIS5lbmRzV2l0aChcIiBcdTIwMjYgW3RydW5jYXRlZF1cIiksIFwibXVzdCBlbmQgd2l0aCB0cnVuY2F0aW9uIHN1ZmZpeFwiKTtcbiAgYXNzZXJ0Lm9rKFxuICAgIEJ1ZmZlci5ieXRlTGVuZ3RoKGxvbmdMaW5lISwgXCJ1dGY4XCIpIDw9IDIwNDgsXG4gICAgYHRydW5jYXRlZCBpdGVtIG11c3QgYmUgd2l0aGluIDIgS0IgY2FwLCBnb3QgJHtCdWZmZXIuYnl0ZUxlbmd0aChsb25nTGluZSEsIFwidXRmOFwiKX1gLFxuICApO1xufSk7XG5cbnRlc3QoXCJwci1ldmlkZW5jZSBoYXJkZW5pbmc6IEhUTUwgY29tbWVudCBzcGxpdCBhY3Jvc3Mgc3VtbWFyeSBpdGVtcyBpcyBwcmVzZXJ2ZWQgbGl0ZXJhbGx5XCIsICgpID0+IHtcbiAgLy8gRG9jdW1lbnRlZCBiZWhhdmlvcjogZWFjaCBpdGVtIGlzIHNhbml0aXplZCBpbmRlcGVuZGVudGx5LiBBIGNvbW1lbnRcbiAgLy8gdGhhdCBiZWdpbnMgaW4gb25lIGl0ZW0gYW5kIGNsb3NlcyBpbiB0aGUgbmV4dCBpcyBOT1Qgam9pbmVkLCBzbyB0aGVcbiAgLy8gb3Blbi9jbG9zZSBtYXJrZXJzIHJlbWFpbiBhcyBsaXRlcmFsIHRleHQuIFRoaXMgaXMgaW50ZW50aW9uYWwgXHUyMDE0IGpvaW5pbmdcbiAgLy8gaXRlbXMgYmVmb3JlIHNhbml0aXppbmcgd291bGQgbGV0IGFuIGF0dGFja2VyIHN0cmFkZGxlIGl0ZW1zIHRvIGluamVjdFxuICAvLyBhbiBhbGlnbmVkIGNvbW1lbnQgdGhhdCBoaWRlcyB0aGUgc2Vjb25kIGl0ZW0gZnJvbSByZW5kZXJlZCB2aWV3LlxuICBjb25zdCBldmlkZW5jZSA9IGJ1aWxkUHJFdmlkZW5jZSh7XG4gICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgIHN1bW1hcmllczogW1wiZmlyc3QgaXRlbSBlbmRzIDwhLS1cIiwgXCItLT4gc2Vjb25kIGl0ZW0gYmVnaW5zXCJdLFxuICB9KTtcbiAgLy8gVGhlIGxpdGVyYWwgbWFya2VycyBzdXJ2aXZlIGJlY2F1c2UgZWFjaCBpdGVtIHdhcyBzYW5pdGl6ZWQgYWxvbmUuXG4gIGFzc2VydC5vayhldmlkZW5jZS5ib2R5LmluY2x1ZGVzKFwiPCEtLVwiKSwgXCJvcGVuIG1hcmtlciBwcmVzZXJ2ZWQgYXMgbGl0ZXJhbFwiKTtcbiAgYXNzZXJ0Lm9rKGV2aWRlbmNlLmJvZHkuaW5jbHVkZXMoXCItLT5cIiksIFwiY2xvc2UgbWFya2VyIHByZXNlcnZlZCBhcyBsaXRlcmFsXCIpO1xuICBhc3NlcnQub2soZXZpZGVuY2UuYm9keS5pbmNsdWRlcyhcImZpcnN0IGl0ZW0gZW5kc1wiKSk7XG4gIGFzc2VydC5vayhldmlkZW5jZS5ib2R5LmluY2x1ZGVzKFwic2Vjb25kIGl0ZW0gYmVnaW5zXCIpKTtcbn0pO1xuXG50ZXN0KFwicHItZXZpZGVuY2UgaGFyZGVuaW5nOiBjbGVhbiBpbnB1dCBpcyBieXRlLWlkZW50aWNhbCB0byBwcmUtaGFyZGVuaW5nIG91dHB1dFwiLCAoKSA9PiB7XG4gIC8vIFRoaXMgdGVzdCBpcyB0aGUgY29udHJhY3QgdGhhdCBwcm90ZWN0cyB0aGUgZ29sZGVuIGZpeHR1cmVzOiB0aGVcbiAgLy8gc2FuaXRpemVyIG11c3QgYmUgYSB0cnVlIG5vLW9wIGZvciB3ZWxsLWZvcm1lZCBpbnB1dC4gSWYgdGhpcyBmYWlscyxcbiAgLy8gdGhlcmUgaXMgYSBidWcgaW4gdGhlIHNhbml0aXplciAobm90IGluIHRoZSBnb2xkZW5zKS5cbiAgY29uc3QgY2xlYW5JbnB1dDogUHJFdmlkZW5jZUlucHV0ID0ge1xuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICBtaWxlc3RvbmVUaXRsZTogXCJBdXRoZW50aWNhdGlvblwiLFxuICAgIGNoYW5nZVR5cGU6IFwiZmVhdFwiLFxuICAgIGxpbmtlZElzc3VlOiBcIkNsb3NlcyAjMTIzXCIsXG4gICAgc3VtbWFyaWVzOiBbXCIjIyMgUzAxXFxuSW1wbGVtZW50ZWQgbG9naW4gZmxvdy5cIl0sXG4gICAgYmxvY2tlcnM6IFtcIkF3YWl0aW5nIGRlc2lnbiByZXZpZXdcIl0sXG4gICAgcm9hZG1hcEl0ZW1zOiBbXCItIFt4XSAqKlMwMTogTG9naW4qKlwiXSxcbiAgICBtZXRyaWNzOiBbXCIqKlVuaXRzIGV4ZWN1dGVkOioqIDNcIl0sXG4gICAgdGVzdHNSdW46IFtcIm5wbSB0ZXN0XCIsIFwibnBtIHJ1biB0eXBlY2hlY2s6ZXh0ZW5zaW9uc1wiXSxcbiAgICB3aHk6IFwiVXNlcnMgbmVlZCB0byBhdXRoZW50aWNhdGUgYmVmb3JlIGFjY2Vzc2luZyBwcm90ZWN0ZWQgcmVzb3VyY2VzLlwiLFxuICAgIGhvdzogXCJBZGRlZCBwYXNzd29yZCBoYXNoIGNoZWNrIGFuZCBzZXNzaW9uIHRva2VuIGlzc3VhbmNlLlwiLFxuICAgIHJvbGxiYWNrTm90ZXM6IFtcIlJldmVydCB0aGUgbWVyZ2UgY29tbWl0LlwiXSxcbiAgfTtcblxuICBjb25zdCBleHBlY3RlZCA9IFtcbiAgICBcIiMjIFRMO0RSXCIsXG4gICAgXCJcIixcbiAgICBcIioqV2hhdDoqKiBTaGlwIG1pbGVzdG9uZSBNMDAxIC0gQXV0aGVudGljYXRpb25cIixcbiAgICBcIioqV2h5OioqIFVzZXJzIG5lZWQgdG8gYXV0aGVudGljYXRlIGJlZm9yZSBhY2Nlc3NpbmcgcHJvdGVjdGVkIHJlc291cmNlcy5cIixcbiAgICBcIioqSG93OioqIEFkZGVkIHBhc3N3b3JkIGhhc2ggY2hlY2sgYW5kIHNlc3Npb24gdG9rZW4gaXNzdWFuY2UuXCIsXG4gICAgXCJcIixcbiAgICBcIiMjIFdoYXRcIixcbiAgICBcIlwiLFxuICAgIFwiIyMjIFMwMVxcbkltcGxlbWVudGVkIGxvZ2luIGZsb3cuXCIsXG4gICAgXCJcIixcbiAgICBcIiMjIEJsb2NrZXJzXCIsXG4gICAgXCJcIixcbiAgICBcIi0gQXdhaXRpbmcgZGVzaWduIHJldmlld1wiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBXaHlcIixcbiAgICBcIlwiLFxuICAgIFwiVXNlcnMgbmVlZCB0byBhdXRoZW50aWNhdGUgYmVmb3JlIGFjY2Vzc2luZyBwcm90ZWN0ZWQgcmVzb3VyY2VzLlwiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBIb3dcIixcbiAgICBcIlwiLFxuICAgIFwiQWRkZWQgcGFzc3dvcmQgaGFzaCBjaGVjayBhbmQgc2Vzc2lvbiB0b2tlbiBpc3N1YW5jZS5cIixcbiAgICBcIlwiLFxuICAgIFwiIyMgTGlua2VkIElzc3VlXCIsXG4gICAgXCJcIixcbiAgICBcIkNsb3NlcyAjMTIzXCIsXG4gICAgXCJcIixcbiAgICBcIiMjIFJvYWRtYXBcIixcbiAgICBcIlwiLFxuICAgIFwiLSBbeF0gKipTMDE6IExvZ2luKipcIixcbiAgICBcIlwiLFxuICAgIFwiIyMgTWV0cmljc1wiLFxuICAgIFwiXCIsXG4gICAgXCItICoqVW5pdHMgZXhlY3V0ZWQ6KiogM1wiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBUZXN0cyBSdW5cIixcbiAgICBcIlwiLFxuICAgIFwiLSBucG0gdGVzdFwiLFxuICAgIFwiLSBucG0gcnVuIHR5cGVjaGVjazpleHRlbnNpb25zXCIsXG4gICAgXCJcIixcbiAgICBcIiMjIENoYW5nZSBUeXBlXCIsXG4gICAgXCJcIixcbiAgICBcIi0gW3hdIGBmZWF0YCAtIE5ldyBmZWF0dXJlIG9yIGNhcGFiaWxpdHlcIixcbiAgICBcIi0gWyBdIGBmaXhgIC0gQnVnIGZpeFwiLFxuICAgIFwiLSBbIF0gYHJlZmFjdG9yYCAtIENvZGUgcmVzdHJ1Y3R1cmluZ1wiLFxuICAgIFwiLSBbIF0gYHRlc3RgIC0gQWRkaW5nIG9yIHVwZGF0aW5nIHRlc3RzXCIsXG4gICAgXCItIFsgXSBgZG9jc2AgLSBEb2N1bWVudGF0aW9uIG9ubHlcIixcbiAgICBcIi0gWyBdIGBjaG9yZWAgLSBCdWlsZCwgQ0ksIG9yIHRvb2xpbmcgY2hhbmdlc1wiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBSb2xsYmFjayBBbmQgQ29tcGF0aWJpbGl0eVwiLFxuICAgIFwiXCIsXG4gICAgXCItIFJldmVydCB0aGUgbWVyZ2UgY29tbWl0LlwiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBBSSBBc3Npc3RhbmNlIERpc2Nsb3N1cmVcIixcbiAgICBcIlwiLFxuICAgIFwiVGhpcyBQUiB3YXMgcHJlcGFyZWQgd2l0aCBBSSBhc3Npc3RhbmNlLlwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG5cbiAgY29uc3QgYWN0dWFsID0gYnVpbGRQckV2aWRlbmNlKGNsZWFuSW5wdXQpLmJvZHk7XG4gIGFzc2VydC5lcXVhbChhY3R1YWwsIGV4cGVjdGVkLCBcImNsZWFuIGlucHV0IG11c3QgcHJvZHVjZSBieXRlLWlkZW50aWNhbCBvdXRwdXQgKHNhbml0aXplciBpcyBuby1vcClcIik7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFFbkIsU0FBUyx1QkFBNkM7QUFFdEQsS0FBSyw4REFBOEQsTUFBTTtBQUN2RSxRQUFNLFdBQVcsZ0JBQWdCO0FBQUEsSUFDL0IsYUFBYTtBQUFBLElBQ2IsV0FBVyxDQUFDLG1DQUFtQztBQUFBLEVBQ2pELENBQUM7QUFDRCxTQUFPLEdBQUcsQ0FBQyxTQUFTLEtBQUssU0FBUyxNQUFNLEdBQUcsMEJBQTBCO0FBQ3JFLFNBQU8sR0FBRyxDQUFDLFNBQVMsS0FBSyxTQUFTLGVBQWUsR0FBRyxtQ0FBbUM7QUFDdkYsU0FBTyxHQUFHLFNBQVMsS0FBSyxTQUFTLGFBQWEsR0FBRyw4QkFBOEI7QUFDakYsQ0FBQztBQUVELEtBQUssa0VBQWtFLE1BQU07QUFDM0UsUUFBTSxXQUFXLGdCQUFnQjtBQUFBLElBQy9CLGFBQWE7QUFBQSxJQUNiLEtBQUs7QUFBQSxFQUNQLENBQUM7QUFDRCxTQUFPLEdBQUcsQ0FBQyxTQUFTLEtBQUssU0FBUyxtQkFBbUIsQ0FBQztBQUN0RCxTQUFPLEdBQUcsQ0FBQyxtQkFBbUIsS0FBSyxTQUFTLElBQUksQ0FBQztBQUNqRCxTQUFPLEdBQUcsU0FBUyxLQUFLLFNBQVMsbUJBQW1CLENBQUM7QUFDckQsU0FBTyxHQUFHLFNBQVMsS0FBSyxTQUFTLGNBQWMsQ0FBQztBQUNsRCxDQUFDO0FBRUQsS0FBSyxpRUFBaUUsTUFBTTtBQUMxRSxRQUFNLFdBQVcsZ0JBQWdCO0FBQUEsSUFDL0IsYUFBYTtBQUFBLElBQ2IsS0FBSztBQUFBLEVBQ1AsQ0FBQztBQUNELFNBQU8sR0FBRyxDQUFDLFNBQVMsS0FBSyxTQUFTLGtCQUFrQixDQUFDO0FBQ3JELFNBQU8sR0FBRyxDQUFDLGtCQUFrQixLQUFLLFNBQVMsSUFBSSxDQUFDO0FBQ2hELFNBQU8sR0FBRyxTQUFTLEtBQUssU0FBUyxXQUFXLENBQUM7QUFDN0MsU0FBTyxHQUFHLFNBQVMsS0FBSyxTQUFTLFdBQVcsQ0FBQztBQUMvQyxDQUFDO0FBRUQsS0FBSyxpRUFBaUUsTUFBTTtBQUMxRSxRQUFNLFdBQVcsZ0JBQWdCO0FBQUEsSUFDL0IsYUFBYTtBQUFBLElBQ2IsS0FBSztBQUFBLEVBQ1AsQ0FBQztBQUNELFNBQU8sR0FBRyxDQUFDLFNBQVMsS0FBSyxTQUFTLGlCQUFpQixDQUFDO0FBQ3BELFNBQU8sR0FBRyxDQUFDLFNBQVMsS0FBSyxTQUFTLGlCQUFpQixDQUFDO0FBQ3BELFNBQU8sR0FBRyxTQUFTLEtBQUssU0FBUyxJQUFJLENBQUM7QUFDdEMsU0FBTyxHQUFHLFNBQVMsS0FBSyxTQUFTLEtBQUssQ0FBQztBQUN6QyxDQUFDO0FBRUQsS0FBSyw4RUFBOEUsTUFBTTtBQUN2RixRQUFNLE1BQU0sSUFBSSxPQUFPLElBQUksSUFBSTtBQUMvQixRQUFNLFdBQVcsZ0JBQWdCO0FBQUEsSUFDL0IsYUFBYTtBQUFBLElBQ2IsV0FBVyxDQUFDLEdBQUc7QUFBQSxFQUNqQixDQUFDO0FBRUQsUUFBTSxRQUFRLFNBQVMsS0FBSyxNQUFNLElBQUk7QUFDdEMsUUFBTSxXQUFXLE1BQU0sS0FBSyxDQUFDLE1BQU0sRUFBRSxXQUFXLE1BQU0sQ0FBQztBQUN2RCxTQUFPLEdBQUcsVUFBVSxtQ0FBbUM7QUFDdkQsU0FBTyxHQUFHLFNBQVUsU0FBUyxxQkFBZ0IsR0FBRyxpQ0FBaUM7QUFDakYsU0FBTztBQUFBLElBQ0wsT0FBTyxXQUFXLFVBQVcsTUFBTSxLQUFLO0FBQUEsSUFDeEMsK0NBQStDLE9BQU8sV0FBVyxVQUFXLE1BQU0sQ0FBQztBQUFBLEVBQ3JGO0FBQ0YsQ0FBQztBQUVELEtBQUsseUZBQXlGLE1BQU07QUFNbEcsUUFBTSxXQUFXLGdCQUFnQjtBQUFBLElBQy9CLGFBQWE7QUFBQSxJQUNiLFdBQVcsQ0FBQyx3QkFBd0Isd0JBQXdCO0FBQUEsRUFDOUQsQ0FBQztBQUVELFNBQU8sR0FBRyxTQUFTLEtBQUssU0FBUyxNQUFNLEdBQUcsa0NBQWtDO0FBQzVFLFNBQU8sR0FBRyxTQUFTLEtBQUssU0FBUyxLQUFLLEdBQUcsbUNBQW1DO0FBQzVFLFNBQU8sR0FBRyxTQUFTLEtBQUssU0FBUyxpQkFBaUIsQ0FBQztBQUNuRCxTQUFPLEdBQUcsU0FBUyxLQUFLLFNBQVMsb0JBQW9CLENBQUM7QUFDeEQsQ0FBQztBQUVELEtBQUssZ0ZBQWdGLE1BQU07QUFJekYsUUFBTSxhQUE4QjtBQUFBLElBQ2xDLGFBQWE7QUFBQSxJQUNiLGdCQUFnQjtBQUFBLElBQ2hCLFlBQVk7QUFBQSxJQUNaLGFBQWE7QUFBQSxJQUNiLFdBQVcsQ0FBQyxrQ0FBa0M7QUFBQSxJQUM5QyxVQUFVLENBQUMsd0JBQXdCO0FBQUEsSUFDbkMsY0FBYyxDQUFDLHNCQUFzQjtBQUFBLElBQ3JDLFNBQVMsQ0FBQyx1QkFBdUI7QUFBQSxJQUNqQyxVQUFVLENBQUMsWUFBWSw4QkFBOEI7QUFBQSxJQUNyRCxLQUFLO0FBQUEsSUFDTCxLQUFLO0FBQUEsSUFDTCxlQUFlLENBQUMsMEJBQTBCO0FBQUEsRUFDNUM7QUFFQSxRQUFNLFdBQVc7QUFBQSxJQUNmO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixFQUFFLEtBQUssSUFBSTtBQUVYLFFBQU0sU0FBUyxnQkFBZ0IsVUFBVSxFQUFFO0FBQzNDLFNBQU8sTUFBTSxRQUFRLFVBQVUscUVBQXFFO0FBQ3RHLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
