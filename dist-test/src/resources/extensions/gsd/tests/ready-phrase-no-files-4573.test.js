import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  setPendingAutoStart,
  clearPendingAutoStart,
  maybeHandleReadyPhraseWithoutFiles,
  maybeHandleEmptyIntentTurn,
  resetEmptyTurnCounter
} from "../guided-flow.js";
import { drainLogs } from "../workflow-logger.js";
import { resolveMilestoneFile, clearPathCache } from "../paths.js";
function mkCapture() {
  return { notifies: [], messages: [] };
}
function mkCtx(cap) {
  return {
    ui: {
      notify: (msg, level) => {
        cap.notifies.push({ msg, level });
      }
    }
  };
}
function mkPi(cap, opts = {}) {
  return {
    sendMessage: (payload, options) => {
      if (opts.sendThrows) throw new Error("send failed");
      cap.messages.push({ payload, options });
    },
    setActiveTools: () => void 0,
    getActiveTools: () => []
  };
}
function mkBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-4573-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  return base;
}
function assistantMsg(text, opts = {}) {
  const content = [];
  if (text) content.push({ type: "text", text });
  if (opts.toolUse) {
    if (opts.toolUse === "serverToolUse") {
      content.push({ type: "serverToolUse", id: "test-id", name: "web_search", input: {} });
    } else {
      content.push({ type: "toolCall", id: "test-id", name: "whatever", arguments: {} });
    }
  }
  return { role: "assistant", content };
}
describe("#4573 maybeHandleReadyPhraseWithoutFiles", () => {
  beforeEach(() => {
    clearPendingAutoStart();
    resetEmptyTurnCounter();
  });
  test("no pending entry \u2192 no-op", () => {
    const cap = mkCapture();
    const event = { messages: [assistantMsg("Milestone M001 ready.")] };
    const handled = maybeHandleReadyPhraseWithoutFiles(event);
    assert.equal(handled, false);
    assert.equal(cap.messages.length, 0);
  });
  test("pending entry, ready phrase, no files \u2192 notify + sendMessage", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleReadyPhraseWithoutFiles({
        messages: [assistantMsg("Milestone M001 ready.")]
      });
      assert.equal(handled, true);
      assert.equal(cap.messages.length, 1);
      assert.equal(cap.messages[0].payload.customType, "gsd-ready-no-files");
      assert.equal(cap.messages[0].options.triggerTurn, true);
      assert.ok(
        cap.notifies.some((n) => /rejected/.test(n.msg)),
        "user notified about rejection"
      );
    } finally {
      clearPendingAutoStart();
    }
  });
  test("retry cap \u2014 after MAX_READY_REJECTS the nudge stops and entry clears", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const event = { messages: [assistantMsg("Milestone M001 ready.")] };
      const first = maybeHandleReadyPhraseWithoutFiles(event);
      const second = maybeHandleReadyPhraseWithoutFiles(event);
      const third = maybeHandleReadyPhraseWithoutFiles(event);
      assert.equal(first, true);
      assert.equal(second, true);
      assert.equal(third, true);
      assert.equal(cap.messages.length, 2, "only 2 nudges sent (MAX_READY_REJECTS=2)");
      assert.ok(
        cap.notifies.some((n) => /Stopping auto-nudge/.test(n.msg)),
        "gives up with error notify"
      );
      const fourth = maybeHandleReadyPhraseWithoutFiles(event);
      assert.equal(fourth, false, "pending entry was cleared \u2014 nothing to handle");
    } finally {
      clearPendingAutoStart();
    }
  });
  test("files present \u2192 no nudge (happy path already fired)", () => {
    const base = mkBase();
    try {
      writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# ctx");
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleReadyPhraseWithoutFiles({
        messages: [assistantMsg("Milestone M001 ready.")]
      });
      assert.equal(handled, false);
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });
  test("stale path cache from a prior listing \u2192 fresh writes are detected (regression)", () => {
    const base = mkBase();
    try {
      const mDir = join(base, ".gsd", "milestones", "M001");
      clearPathCache();
      assert.equal(
        resolveMilestoneFile(base, "M001", "CONTEXT"),
        null,
        "precondition: resolver must report missing before files are written"
      );
      writeFileSync(join(mDir, "M001-CONTEXT.md"), "# ctx");
      writeFileSync(join(mDir, "M001-ROADMAP.md"), "# roadmap");
      assert.equal(
        resolveMilestoneFile(base, "M001", "CONTEXT"),
        null,
        "stale cache still reports missing pre-clearPathCache"
      );
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleReadyPhraseWithoutFiles({
        messages: [assistantMsg("Milestone M001 ready.")]
      });
      assert.equal(
        handled,
        false,
        "fresh writes must not trigger the rejection nudge \u2014 cache must be busted before resolution"
      );
      assert.equal(cap.messages.length, 0, "no nudge sent");
      assert.equal(
        cap.notifies.length,
        0,
        "no rejection notify when files exist on disk"
      );
    } finally {
      clearPendingAutoStart();
    }
  });
  test("legacy unprefixed files present \u2192 no nudge", () => {
    const base = mkBase();
    try {
      writeFileSync(join(base, ".gsd", "milestones", "M001", "CONTEXT.md"), "# ctx");
      writeFileSync(join(base, ".gsd", "milestones", "M001", "ROADMAP.md"), "# roadmap");
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleReadyPhraseWithoutFiles({
        messages: [assistantMsg("Milestone M001 ready.")]
      });
      assert.equal(handled, false);
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });
  test("last message lacks ready phrase \u2192 no-op", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleReadyPhraseWithoutFiles({
        messages: [assistantMsg("Let me think about the slices first.")]
      });
      assert.equal(handled, false);
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });
  test("nudge fires \u2192 diagnostic warning logged with basePath, mDir, canonical-path existsSync results", () => {
    const base = mkBase();
    try {
      drainLogs();
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleReadyPhraseWithoutFiles({
        messages: [assistantMsg("Milestone M001 ready.")]
      });
      assert.equal(handled, true);
      const logs = drainLogs();
      const diag = logs.find(
        (e) => e.component === "guided" && /ready-phrase-reject diagnostic/.test(e.message)
      );
      assert.ok(diag, "expected diagnostic warning to be logged when nudge fires");
      assert.match(diag.message, /mid=M001/);
      assert.match(diag.message, new RegExp(`basePath=${base.replace(/[/\\]/g, "[/\\\\]")}`));
      assert.match(diag.message, /mDir=/);
      assert.match(diag.message, /ctx-exists=false/);
      assert.match(diag.message, /roadmap-exists=false/);
    } finally {
      clearPendingAutoStart();
    }
  });
  test("diagnostic logs ctx-exists=true when file is on disk but cached resolver missed it", () => {
    const base = mkBase();
    try {
      drainLogs();
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      maybeHandleReadyPhraseWithoutFiles({
        messages: [assistantMsg("Milestone M001 ready.")]
      });
      const logs = drainLogs();
      const diag = logs.find(
        (e) => e.component === "guided" && /ready-phrase-reject diagnostic/.test(e.message)
      );
      assert.ok(diag, "diagnostic logged");
      assert.match(diag.message, /mDir=.+M001/);
      assert.match(diag.message, /canonical-ctx=.+M001-CONTEXT\.md/);
      assert.match(diag.message, /canonical-roadmap=.+M001-ROADMAP\.md/);
    } finally {
      clearPendingAutoStart();
    }
  });
  test("fresh entry after give-up resets counter", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const event = { messages: [assistantMsg("Milestone M001 ready.")] };
      maybeHandleReadyPhraseWithoutFiles(event);
      maybeHandleReadyPhraseWithoutFiles(event);
      maybeHandleReadyPhraseWithoutFiles(event);
      cap.messages.length = 0;
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleReadyPhraseWithoutFiles(event);
      assert.equal(handled, true);
      assert.equal(cap.messages.length, 1, "fresh entry fires nudge again");
    } finally {
      clearPendingAutoStart();
    }
  });
});
describe("#4573 maybeHandleEmptyIntentTurn", () => {
  beforeEach(() => {
    clearPendingAutoStart();
    resetEmptyTurnCounter();
  });
  test("no pending entry + isAuto false \u2192 no-op (interactive discuss is user-driven)", () => {
    const event = { messages: [assistantMsg("I'll write the CONTEXT.md now.")] };
    const handled = maybeHandleEmptyIntentTurn(event, false);
    assert.equal(handled, false);
  });
  test("text-only turn WITHOUT commit phrase \u2192 not flagged (legitimate text)", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleEmptyIntentTurn(
        { messages: [assistantMsg("Here is the roadmap preview \u2014 three slices.")] },
        false
      );
      assert.equal(handled, false);
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });
  test("text-only turn ending in question \u2192 treated as user-handoff, not flagged", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleEmptyIntentTurn(
        { messages: [assistantMsg("Ready to write, or want to adjust?")] },
        false
      );
      assert.equal(handled, false);
    } finally {
      clearPendingAutoStart();
    }
  });
  test("multi-line message with mid-message question \u2192 treated as user-handoff (regression: discuss flow)", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const text = [
        "Let me make sure I understand what you're testing here.",
        "",
        "We need something to plan. A few lightweight options:",
        "- A simple CLI tool",
        "- A static API",
        "",
        "What should the fictional project be?",
        "",
        "If you have a preference, say the word and I'll pick one."
      ].join("\n");
      const handled = maybeHandleEmptyIntentTurn(
        { messages: [assistantMsg(text)] },
        false
      );
      assert.equal(handled, false, "any line ending in ? must defer to the user");
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });
  test("single-line approval prompt with mid-line `?` and conditional intent \u2192 treated as user-handoff (regression: #5187 follow-up)", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleEmptyIntentTurn(
        {
          messages: [
            assistantMsg(
              "Did I capture that correctly? If so, say yes and I'll write requirements and the roadmap preview."
            )
          ]
        },
        false
      );
      assert.equal(handled, false, "any sentence-terminating ? must defer to the user");
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });
  test('"Let me make sure" meta phrase \u2192 not flagged as commit intent (regression)', () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleEmptyIntentTurn(
        { messages: [assistantMsg("Let me make sure I have this right.")] },
        false
      );
      assert.equal(handled, false, "meta acknowledgments are not action announcements");
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });
  test("commit-intent phrase WITHOUT tool call \u2192 nudge fires", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleEmptyIntentTurn(
        { messages: [assistantMsg("I'll now write the CONTEXT.md file.")] },
        false
      );
      assert.equal(handled, true);
      assert.equal(cap.messages.length, 1);
      assert.equal(cap.messages[0].payload.customType, "gsd-empty-turn-recovery");
    } finally {
      clearPendingAutoStart();
    }
  });
  test("commit-intent WITH tool-use block \u2192 not flagged", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleEmptyIntentTurn(
        { messages: [assistantMsg("I'll write the file now.", { toolUse: true })] },
        false
      );
      assert.equal(handled, false);
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });
  test("cc-cli MCP tool call surfaced as canonical toolCall \u2192 not flagged", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleEmptyIntentTurn(
        {
          messages: [
            assistantMsg("Let me call ask_user_questions to gather your preferences.", {
              toolUse: "toolCall"
            })
          ]
        },
        false
      );
      assert.equal(handled, false);
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });
  test("serverToolUse block (cc-cli web search etc.) \u2192 not flagged", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleEmptyIntentTurn(
        {
          messages: [
            assistantMsg("Let me invoke the search tool now.", {
              toolUse: "serverToolUse"
            })
          ]
        },
        false
      );
      assert.equal(handled, false);
      assert.equal(cap.messages.length, 0);
    } finally {
      clearPendingAutoStart();
    }
  });
  test("ready phrase is NOT treated as empty-turn (handled by other recovery path)", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const handled = maybeHandleEmptyIntentTurn(
        { messages: [assistantMsg("Milestone M001 ready.")] },
        false
      );
      assert.equal(handled, false);
    } finally {
      clearPendingAutoStart();
    }
  });
  test("empty-turn retry cap \u2014 stops after MAX_EMPTY_TURN_RETRIES", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const event = { messages: [assistantMsg("I'll write the CONTEXT.md file.")] };
      maybeHandleEmptyIntentTurn(event, false);
      maybeHandleEmptyIntentTurn(event, false);
      const third = maybeHandleEmptyIntentTurn(event, false);
      assert.equal(cap.messages.length, 2, "only 2 nudges sent");
      assert.equal(third, false, "after cap, no further injection");
      assert.ok(
        cap.notifies.some((n) => /Stopping auto-nudge/.test(n.msg)),
        "user notified of give-up"
      );
    } finally {
      clearPendingAutoStart();
    }
  });
  test("resetEmptyTurnCounter clears state after a successful tool-use turn", () => {
    const base = mkBase();
    try {
      const cap = mkCapture();
      setPendingAutoStart(base, {
        basePath: base,
        milestoneId: "M001",
        ctx: mkCtx(cap),
        pi: mkPi(cap)
      });
      const event = { messages: [assistantMsg("I'll write the CONTEXT.md file.")] };
      maybeHandleEmptyIntentTurn(event, false);
      maybeHandleEmptyIntentTurn(event, false);
      resetEmptyTurnCounter();
      cap.messages.length = 0;
      const after = maybeHandleEmptyIntentTurn(event, false);
      assert.equal(after, true, "counter reset \u2014 nudge fires again");
      assert.equal(cap.messages.length, 1);
    } finally {
      clearPendingAutoStart();
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZWFkeS1waHJhc2Utbm8tZmlsZXMtNDU3My50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEdTRC0yIC8gZ3VpZGVkLWZsb3cgXHUyMDE0IHJlZ3Jlc3Npb24gdGVzdHMgZm9yICM0NTczXG4gKlxuICogQ292ZXJzIHR3byByZWNvdmVyeSBwYXRoczpcbiAqICAgLSBtYXliZUhhbmRsZVJlYWR5UGhyYXNlV2l0aG91dEZpbGVzOiBudWRnZSB3aGVuIExMTSBlbWl0c1xuICogICAgIFwiTWlsZXN0b25lIE0wMDEgcmVhZHkuXCIgd2l0aG91dCB3cml0aW5nIENPTlRFWFQubWQgLyBST0FETUFQLm1kXG4gKiAgIC0gbWF5YmVIYW5kbGVFbXB0eUludGVudFR1cm46IG51ZGdlIHdoZW4gTExNIG5hcnJhdGVzIGludGVudCBidXRcbiAqICAgICBlbWl0cyBubyB0b29sLXVzZSBibG9ja3NcbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCwgYmVmb3JlRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQge1xuICBzZXRQZW5kaW5nQXV0b1N0YXJ0LFxuICBjbGVhclBlbmRpbmdBdXRvU3RhcnQsXG4gIG1heWJlSGFuZGxlUmVhZHlQaHJhc2VXaXRob3V0RmlsZXMsXG4gIG1heWJlSGFuZGxlRW1wdHlJbnRlbnRUdXJuLFxuICByZXNldEVtcHR5VHVybkNvdW50ZXIsXG59IGZyb20gXCIuLi9ndWlkZWQtZmxvdy50c1wiO1xuaW1wb3J0IHsgZHJhaW5Mb2dzIH0gZnJvbSBcIi4uL3dvcmtmbG93LWxvZ2dlci50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1pbGVzdG9uZUZpbGUsIGNsZWFyUGF0aENhY2hlIH0gZnJvbSBcIi4uL3BhdGhzLnRzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUZXN0IGhhcm5lc3MgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmludGVyZmFjZSBNb2NrQ2FwdHVyZSB7XG4gIG5vdGlmaWVzOiBBcnJheTx7IG1zZzogc3RyaW5nOyBsZXZlbDogc3RyaW5nIH0+O1xuICBtZXNzYWdlczogQXJyYXk8eyBwYXlsb2FkOiBhbnk7IG9wdGlvbnM6IGFueSB9Pjtcbn1cblxuZnVuY3Rpb24gbWtDYXB0dXJlKCk6IE1vY2tDYXB0dXJlIHtcbiAgcmV0dXJuIHsgbm90aWZpZXM6IFtdLCBtZXNzYWdlczogW10gfTtcbn1cblxuZnVuY3Rpb24gbWtDdHgoY2FwOiBNb2NrQ2FwdHVyZSk6IGFueSB7XG4gIHJldHVybiB7XG4gICAgdWk6IHtcbiAgICAgIG5vdGlmeTogKG1zZzogc3RyaW5nLCBsZXZlbDogc3RyaW5nKSA9PiB7XG4gICAgICAgIGNhcC5ub3RpZmllcy5wdXNoKHsgbXNnLCBsZXZlbCB9KTtcbiAgICAgIH0sXG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWtQaShjYXA6IE1vY2tDYXB0dXJlLCBvcHRzOiB7IHNlbmRUaHJvd3M/OiBib29sZWFuIH0gPSB7fSk6IGFueSB7XG4gIHJldHVybiB7XG4gICAgc2VuZE1lc3NhZ2U6IChwYXlsb2FkOiBhbnksIG9wdGlvbnM6IGFueSkgPT4ge1xuICAgICAgaWYgKG9wdHMuc2VuZFRocm93cykgdGhyb3cgbmV3IEVycm9yKFwic2VuZCBmYWlsZWRcIik7XG4gICAgICBjYXAubWVzc2FnZXMucHVzaCh7IHBheWxvYWQsIG9wdGlvbnMgfSk7XG4gICAgfSxcbiAgICBzZXRBY3RpdmVUb29sczogKCkgPT4gdW5kZWZpbmVkLFxuICAgIGdldEFjdGl2ZVRvb2xzOiAoKSA9PiBbXSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWtCYXNlKCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC00NTczLVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIGFzc2lzdGFudE1zZyhcbiAgdGV4dDogc3RyaW5nLFxuICBvcHRzOiB7IHRvb2xVc2U/OiBib29sZWFuIHwgXCJ0b29sQ2FsbFwiIHwgXCJzZXJ2ZXJUb29sVXNlXCIgfSA9IHt9LFxuKTogYW55IHtcbiAgY29uc3QgY29udGVudDogYW55W10gPSBbXTtcbiAgaWYgKHRleHQpIGNvbnRlbnQucHVzaCh7IHR5cGU6IFwidGV4dFwiLCB0ZXh0IH0pO1xuICBpZiAob3B0cy50b29sVXNlKSB7XG4gICAgLy8gVGhlIGNhbm9uaWNhbCBwaS1haSBBc3Npc3RhbnRNZXNzYWdlIHVzZXMgXCJ0b29sQ2FsbFwiIC8gXCJzZXJ2ZXJUb29sVXNlXCJcbiAgICAvLyAoc2VlIHBhY2thZ2VzL3BpLWFpL3NyYy90eXBlcy50cykuIEV2ZXJ5IHByb3ZpZGVyIFx1MjAxNCBhbnRocm9waWMtZGlyZWN0LFxuICAgIC8vIGNsYXVkZS1jb2RlLWNsaSwgb3BlbmFpIFx1MjAxNCBub3JtYWxpemVzIGluY29taW5nIHRvb2wgYmxvY2tzIGludG8gdGhlc2VcbiAgICAvLyBzaGFwZXMgYmVmb3JlIHRoZXkgcmVhY2ggZ3VpZGVkLWZsb3cuIFRoZSBBbnRocm9waWMtd2lyZSBsaXRlcmFsXG4gICAgLy8gXCJ0b29sX3VzZVwiIG5ldmVyIGFwcGVhcnMgaGVyZS5cbiAgICBpZiAob3B0cy50b29sVXNlID09PSBcInNlcnZlclRvb2xVc2VcIikge1xuICAgICAgY29udGVudC5wdXNoKHsgdHlwZTogXCJzZXJ2ZXJUb29sVXNlXCIsIGlkOiBcInRlc3QtaWRcIiwgbmFtZTogXCJ3ZWJfc2VhcmNoXCIsIGlucHV0OiB7fSB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29udGVudC5wdXNoKHsgdHlwZTogXCJ0b29sQ2FsbFwiLCBpZDogXCJ0ZXN0LWlkXCIsIG5hbWU6IFwid2hhdGV2ZXJcIiwgYXJndW1lbnRzOiB7fSB9KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHsgcm9sZTogXCJhc3Npc3RhbnRcIiwgY29udGVudCB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcmVhZHktcGhyYXNlIHJlY292ZXJ5IChMYXllciAyKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCIjNDU3MyBtYXliZUhhbmRsZVJlYWR5UGhyYXNlV2l0aG91dEZpbGVzXCIsICgpID0+IHtcbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgY2xlYXJQZW5kaW5nQXV0b1N0YXJ0KCk7XG4gICAgcmVzZXRFbXB0eVR1cm5Db3VudGVyKCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJubyBwZW5kaW5nIGVudHJ5IFx1MjE5MiBuby1vcFwiLCAoKSA9PiB7XG4gICAgY29uc3QgY2FwID0gbWtDYXB0dXJlKCk7XG4gICAgY29uc3QgZXZlbnQgPSB7IG1lc3NhZ2VzOiBbYXNzaXN0YW50TXNnKFwiTWlsZXN0b25lIE0wMDEgcmVhZHkuXCIpXSB9O1xuICAgIGNvbnN0IGhhbmRsZWQgPSBtYXliZUhhbmRsZVJlYWR5UGhyYXNlV2l0aG91dEZpbGVzKGV2ZW50KTtcbiAgICBhc3NlcnQuZXF1YWwoaGFuZGxlZCwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChjYXAubWVzc2FnZXMubGVuZ3RoLCAwKTtcbiAgfSk7XG5cbiAgdGVzdChcInBlbmRpbmcgZW50cnksIHJlYWR5IHBocmFzZSwgbm8gZmlsZXMgXHUyMTkyIG5vdGlmeSArIHNlbmRNZXNzYWdlXCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWtCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNhcCA9IG1rQ2FwdHVyZSgpO1xuICAgICAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlLCB7XG4gICAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIGN0eDogbWtDdHgoY2FwKSxcbiAgICAgICAgcGk6IG1rUGkoY2FwKSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgaGFuZGxlZCA9IG1heWJlSGFuZGxlUmVhZHlQaHJhc2VXaXRob3V0RmlsZXMoe1xuICAgICAgICBtZXNzYWdlczogW2Fzc2lzdGFudE1zZyhcIk1pbGVzdG9uZSBNMDAxIHJlYWR5LlwiKV0sXG4gICAgICB9KTtcbiAgICAgIGFzc2VydC5lcXVhbChoYW5kbGVkLCB0cnVlKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYXAubWVzc2FnZXMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYXAubWVzc2FnZXNbMF0ucGF5bG9hZC5jdXN0b21UeXBlLCBcImdzZC1yZWFkeS1uby1maWxlc1wiKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYXAubWVzc2FnZXNbMF0ub3B0aW9ucy50cmlnZ2VyVHVybiwgdHJ1ZSk7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGNhcC5ub3RpZmllcy5zb21lKChuKSA9PiAvcmVqZWN0ZWQvLnRlc3Qobi5tc2cpKSxcbiAgICAgICAgXCJ1c2VyIG5vdGlmaWVkIGFib3V0IHJlamVjdGlvblwiLFxuICAgICAgKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYXJQZW5kaW5nQXV0b1N0YXJ0KCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwicmV0cnkgY2FwIFx1MjAxNCBhZnRlciBNQVhfUkVBRFlfUkVKRUNUUyB0aGUgbnVkZ2Ugc3RvcHMgYW5kIGVudHJ5IGNsZWFyc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1rQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjYXAgPSBta0NhcHR1cmUoKTtcbiAgICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZSwge1xuICAgICAgICBiYXNlUGF0aDogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICBjdHg6IG1rQ3R4KGNhcCksXG4gICAgICAgIHBpOiBta1BpKGNhcCksXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGV2ZW50ID0geyBtZXNzYWdlczogW2Fzc2lzdGFudE1zZyhcIk1pbGVzdG9uZSBNMDAxIHJlYWR5LlwiKV0gfTtcblxuICAgICAgY29uc3QgZmlyc3QgPSBtYXliZUhhbmRsZVJlYWR5UGhyYXNlV2l0aG91dEZpbGVzKGV2ZW50KTtcbiAgICAgIGNvbnN0IHNlY29uZCA9IG1heWJlSGFuZGxlUmVhZHlQaHJhc2VXaXRob3V0RmlsZXMoZXZlbnQpO1xuICAgICAgY29uc3QgdGhpcmQgPSBtYXliZUhhbmRsZVJlYWR5UGhyYXNlV2l0aG91dEZpbGVzKGV2ZW50KTsgLy8gPiBNQVhcblxuICAgICAgYXNzZXJ0LmVxdWFsKGZpcnN0LCB0cnVlKTtcbiAgICAgIGFzc2VydC5lcXVhbChzZWNvbmQsIHRydWUpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHRoaXJkLCB0cnVlKTsgLy8gc3RpbGwgcmV0dXJucyB0cnVlIChoYW5kbGVkIHZpYSBnaXZlLXVwKVxuICAgICAgYXNzZXJ0LmVxdWFsKGNhcC5tZXNzYWdlcy5sZW5ndGgsIDIsIFwib25seSAyIG51ZGdlcyBzZW50IChNQVhfUkVBRFlfUkVKRUNUUz0yKVwiKTtcbiAgICAgIGFzc2VydC5vayhcbiAgICAgICAgY2FwLm5vdGlmaWVzLnNvbWUoKG4pID0+IC9TdG9wcGluZyBhdXRvLW51ZGdlLy50ZXN0KG4ubXNnKSksXG4gICAgICAgIFwiZ2l2ZXMgdXAgd2l0aCBlcnJvciBub3RpZnlcIixcbiAgICAgICk7XG5cbiAgICAgIC8vIEFmdGVyIGdpdmluZyB1cCwgYSBmcmVzaCByZS1lbnRyeSBzdGFydHMgY2xlYW5cbiAgICAgIGNvbnN0IGZvdXJ0aCA9IG1heWJlSGFuZGxlUmVhZHlQaHJhc2VXaXRob3V0RmlsZXMoZXZlbnQpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGZvdXJ0aCwgZmFsc2UsIFwicGVuZGluZyBlbnRyeSB3YXMgY2xlYXJlZCBcdTIwMTQgbm90aGluZyB0byBoYW5kbGVcIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFyUGVuZGluZ0F1dG9TdGFydCgpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImZpbGVzIHByZXNlbnQgXHUyMTkyIG5vIG51ZGdlIChoYXBweSBwYXRoIGFscmVhZHkgZmlyZWQpXCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWtCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtQ09OVEVYVC5tZFwiKSwgXCIjIGN0eFwiKTtcbiAgICAgIGNvbnN0IGNhcCA9IG1rQ2FwdHVyZSgpO1xuICAgICAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlLCB7XG4gICAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIGN0eDogbWtDdHgoY2FwKSxcbiAgICAgICAgcGk6IG1rUGkoY2FwKSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgaGFuZGxlZCA9IG1heWJlSGFuZGxlUmVhZHlQaHJhc2VXaXRob3V0RmlsZXMoe1xuICAgICAgICBtZXNzYWdlczogW2Fzc2lzdGFudE1zZyhcIk1pbGVzdG9uZSBNMDAxIHJlYWR5LlwiKV0sXG4gICAgICB9KTtcbiAgICAgIGFzc2VydC5lcXVhbChoYW5kbGVkLCBmYWxzZSk7XG4gICAgICBhc3NlcnQuZXF1YWwoY2FwLm1lc3NhZ2VzLmxlbmd0aCwgMCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFyUGVuZGluZ0F1dG9TdGFydCgpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInN0YWxlIHBhdGggY2FjaGUgZnJvbSBhIHByaW9yIGxpc3RpbmcgXHUyMTkyIGZyZXNoIHdyaXRlcyBhcmUgZGV0ZWN0ZWQgKHJlZ3Jlc3Npb24pXCIsICgpID0+IHtcbiAgICAvLyBSZXBybyB0aGUgbGl2ZSBiaW5hcnkgZmFpbHVyZSB3aGVyZTpcbiAgICAvLyAgIDEuIHBhdGhzLnRzIGNhY2hlZCBkaXIgbGlzdGluZ3Mgd2VyZSBwb3B1bGF0ZWQgd2hlbiBNMDAxLyB3YXMgZW1wdHlcbiAgICAvLyAgICAgIChvciB0aGUgbWlsZXN0b25lIGRpciBkaWRuJ3QgeWV0IGV4aXN0KS5cbiAgICAvLyAgIDIuIFRoZSBMTE0gdGhlbiB3cm90ZSBNMDAxLUNPTlRFWFQubWQgYW5kIE0wMDEtUk9BRE1BUC5tZCB2aWEgdGhlXG4gICAgLy8gICAgICBzdGFuZGFyZCBXcml0ZSB0b29sIFx1MjAxNCB3aGljaCBoYXMgbm8gYXdhcmVuZXNzIG9mIHBhdGhzLnRzIGNhY2hlcy5cbiAgICAvLyAgIDMuIG1heWJlSGFuZGxlUmVhZHlQaHJhc2VXaXRob3V0RmlsZXMgY2FsbGVkIHJlc29sdmVNaWxlc3RvbmVGaWxlLFxuICAgIC8vICAgICAgd2hpY2ggcmVhZCB0aGUgc3RhbGUgY2FjaGUgYW5kIHJlcG9ydGVkIHRoZSBhcnRpZmFjdHMgbWlzc2luZyxcbiAgICAvLyAgICAgIGZpcmluZyBhIGZhbHNlIHJlamVjdGlvbiBudWRnZSB1bnRpbCBNQVhfUkVBRFlfUkVKRUNUUyBhYm9ydGVkXG4gICAgLy8gICAgICB0aGUgYXV0by1zdGFydCB3aXRoIGBMTE0gc2lnbmFsZWQgXCJyZWFkeVwiIDMgdGltZXMgd2l0aG91dFxuICAgIC8vICAgICAgd3JpdGluZyBmaWxlc2AuXG4gICAgLy9cbiAgICAvLyBUaGUgZml4IGJ1c3RzIHRoZSBwYXRoIGNhY2hlIGF0IHRoZSB0b3Agb2YgdGhlIHZhbGlkYXRvciBiZWZvcmVcbiAgICAvLyByZS1yZXNvbHZpbmcuIFRoaXMgdGVzdCBmYWlscyBwcmUtZml4IChoYW5kbGVkID09PSB0cnVlKSBiZWNhdXNlIHRoZVxuICAgIC8vIGNhY2hlIHJldHVybnMgdGhlIGVtcHR5IGxpc3RpbmcgaXQgY2FwdHVyZWQgaW4gc3RlcCAoYSkuXG4gICAgY29uc3QgYmFzZSA9IG1rQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBtRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKTtcblxuICAgICAgLy8gKGEpIFByaW1lIHRoZSBjYWNoZSB3aXRoIGEgbGlzdGluZyB0aGF0IERPRVMgTk9UIGluY2x1ZGUgTTAwMSdzXG4gICAgICAvLyAgICAgQ09OVEVYVC9ST0FETUFQIGZpbGVzLiBta0Jhc2UoKSBoYXMgYWxyZWFkeSBjcmVhdGVkIHRoZSBNMDAxXG4gICAgICAvLyAgICAgZGlyZWN0b3J5IGJ1dCBub3RoaW5nIGluc2lkZSBpdCB5ZXQgXHUyMDE0IHNvIHRoaXMgcmVhZGRpciBjYWNoZXMgYW5cbiAgICAgIC8vICAgICBlbXB0eSBlbnRyeSBsaXN0IGtleWVkIGJ5IHRoZSBNMDAxIGRpciBwYXRoLlxuICAgICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICAgIGFzc2VydC5lcXVhbChcbiAgICAgICAgcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgXCJNMDAxXCIsIFwiQ09OVEVYVFwiKSxcbiAgICAgICAgbnVsbCxcbiAgICAgICAgXCJwcmVjb25kaXRpb246IHJlc29sdmVyIG11c3QgcmVwb3J0IG1pc3NpbmcgYmVmb3JlIGZpbGVzIGFyZSB3cml0dGVuXCIsXG4gICAgICApO1xuXG4gICAgICAvLyAoYikgV3JpdGUgdGhlIGFydGlmYWN0cyBkaXJlY3RseSB0byBkaXNrIChzaW11bGF0ZXMgdGhlIExMTSBXcml0ZVxuICAgICAgLy8gICAgIHRvb2wgXHUyMDE0IG5vIGNsZWFyUGF0aENhY2hlKCkgY2FsbCBiZXR3ZWVuIHRoZSB3cml0ZSBhbmQgdGhlXG4gICAgICAvLyAgICAgdmFsaWRhdG9yKS5cbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihtRGlyLCBcIk0wMDEtQ09OVEVYVC5tZFwiKSwgXCIjIGN0eFwiKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihtRGlyLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSwgXCIjIHJvYWRtYXBcIik7XG5cbiAgICAgIC8vIChjKSBTYW5pdHk6IHRoZSBjYWNoZSBpcyBzdGlsbCBzdGFsZS4gV2l0aG91dCB0aGUgZml4LCB0aGVcbiAgICAgIC8vICAgICB2YWxpZGF0b3Igd291bGQgc3RpbGwgc2VlIHRoZSBlbXB0eSBjYWNoZWQgbGlzdGluZy5cbiAgICAgIGFzc2VydC5lcXVhbChcbiAgICAgICAgcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgXCJNMDAxXCIsIFwiQ09OVEVYVFwiKSxcbiAgICAgICAgbnVsbCxcbiAgICAgICAgXCJzdGFsZSBjYWNoZSBzdGlsbCByZXBvcnRzIG1pc3NpbmcgcHJlLWNsZWFyUGF0aENhY2hlXCIsXG4gICAgICApO1xuXG4gICAgICAvLyAoZCkgUnVuIHRoZSB2YWxpZGF0b3IuIFdpdGggdGhlIGZpeCBpdCBidXN0cyB0aGUgY2FjaGUgYmVmb3JlXG4gICAgICAvLyAgICAgcmVzb2x2aW5nIGFuZCByZXR1cm5zIGZhbHNlIChubyBudWRnZSkuIFdpdGhvdXQgdGhlIGZpeCBpdFxuICAgICAgLy8gICAgIGZpcmVzIHRoZSBudWRnZS5cbiAgICAgIGNvbnN0IGNhcCA9IG1rQ2FwdHVyZSgpO1xuICAgICAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlLCB7XG4gICAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIGN0eDogbWtDdHgoY2FwKSxcbiAgICAgICAgcGk6IG1rUGkoY2FwKSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgaGFuZGxlZCA9IG1heWJlSGFuZGxlUmVhZHlQaHJhc2VXaXRob3V0RmlsZXMoe1xuICAgICAgICBtZXNzYWdlczogW2Fzc2lzdGFudE1zZyhcIk1pbGVzdG9uZSBNMDAxIHJlYWR5LlwiKV0sXG4gICAgICB9KTtcbiAgICAgIGFzc2VydC5lcXVhbChcbiAgICAgICAgaGFuZGxlZCxcbiAgICAgICAgZmFsc2UsXG4gICAgICAgIFwiZnJlc2ggd3JpdGVzIG11c3Qgbm90IHRyaWdnZXIgdGhlIHJlamVjdGlvbiBudWRnZSBcdTIwMTQgY2FjaGUgbXVzdCBiZSBidXN0ZWQgYmVmb3JlIHJlc29sdXRpb25cIixcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZXF1YWwoY2FwLm1lc3NhZ2VzLmxlbmd0aCwgMCwgXCJubyBudWRnZSBzZW50XCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgICBjYXAubm90aWZpZXMubGVuZ3RoLFxuICAgICAgICAwLFxuICAgICAgICBcIm5vIHJlamVjdGlvbiBub3RpZnkgd2hlbiBmaWxlcyBleGlzdCBvbiBkaXNrXCIsXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhclBlbmRpbmdBdXRvU3RhcnQoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJsZWdhY3kgdW5wcmVmaXhlZCBmaWxlcyBwcmVzZW50IFx1MjE5MiBubyBudWRnZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1rQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJDT05URVhULm1kXCIpLCBcIiMgY3R4XCIpO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiUk9BRE1BUC5tZFwiKSwgXCIjIHJvYWRtYXBcIik7XG4gICAgICBjb25zdCBjYXAgPSBta0NhcHR1cmUoKTtcbiAgICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZSwge1xuICAgICAgICBiYXNlUGF0aDogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICBjdHg6IG1rQ3R4KGNhcCksXG4gICAgICAgIHBpOiBta1BpKGNhcCksXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGhhbmRsZWQgPSBtYXliZUhhbmRsZVJlYWR5UGhyYXNlV2l0aG91dEZpbGVzKHtcbiAgICAgICAgbWVzc2FnZXM6IFthc3Npc3RhbnRNc2coXCJNaWxlc3RvbmUgTTAwMSByZWFkeS5cIildLFxuICAgICAgfSk7XG4gICAgICBhc3NlcnQuZXF1YWwoaGFuZGxlZCwgZmFsc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNhcC5tZXNzYWdlcy5sZW5ndGgsIDApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhclBlbmRpbmdBdXRvU3RhcnQoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJsYXN0IG1lc3NhZ2UgbGFja3MgcmVhZHkgcGhyYXNlIFx1MjE5MiBuby1vcFwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1rQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjYXAgPSBta0NhcHR1cmUoKTtcbiAgICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZSwge1xuICAgICAgICBiYXNlUGF0aDogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICBjdHg6IG1rQ3R4KGNhcCksXG4gICAgICAgIHBpOiBta1BpKGNhcCksXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGhhbmRsZWQgPSBtYXliZUhhbmRsZVJlYWR5UGhyYXNlV2l0aG91dEZpbGVzKHtcbiAgICAgICAgbWVzc2FnZXM6IFthc3Npc3RhbnRNc2coXCJMZXQgbWUgdGhpbmsgYWJvdXQgdGhlIHNsaWNlcyBmaXJzdC5cIildLFxuICAgICAgfSk7XG4gICAgICBhc3NlcnQuZXF1YWwoaGFuZGxlZCwgZmFsc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNhcC5tZXNzYWdlcy5sZW5ndGgsIDApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhclBlbmRpbmdBdXRvU3RhcnQoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJudWRnZSBmaXJlcyBcdTIxOTIgZGlhZ25vc3RpYyB3YXJuaW5nIGxvZ2dlZCB3aXRoIGJhc2VQYXRoLCBtRGlyLCBjYW5vbmljYWwtcGF0aCBleGlzdHNTeW5jIHJlc3VsdHNcIiwgKCkgPT4ge1xuICAgIC8vIERpYWdub3N0aWMgbG9nZ2luZyBhZGRlZCBzbyB3ZSBjYW4gdGVsbCwgaW4gcmVhbCBmYWlsdXJlcywgd2hldGhlclxuICAgIC8vIHJlc29sdmVNaWxlc3RvbmVGaWxlIGlzIHJlcG9ydGluZyBmaWxlcyBtaXNzaW5nIHRoYXQgYWN0dWFsbHkgZXhpc3Qgb25cbiAgICAvLyBkaXNrIChiYXNlUGF0aC9zeW1saW5rIG1pc21hdGNoLCBzdGFsZSBjYWNoZSBkZXNwaXRlIHRoZVxuICAgIC8vIGFnZW50LWVuZC1yZWNvdmVyeSBmbHVzaCwgbGVnYWN5IGRlc2NyaXB0b3IgZGlyLCBldGMuKS5cbiAgICBjb25zdCBiYXNlID0gbWtCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGRyYWluTG9ncygpOyAvLyBkaXNjYXJkIHByaW9yIHRlc3Qgbm9pc2VcbiAgICAgIGNvbnN0IGNhcCA9IG1rQ2FwdHVyZSgpO1xuICAgICAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlLCB7XG4gICAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIGN0eDogbWtDdHgoY2FwKSxcbiAgICAgICAgcGk6IG1rUGkoY2FwKSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgaGFuZGxlZCA9IG1heWJlSGFuZGxlUmVhZHlQaHJhc2VXaXRob3V0RmlsZXMoe1xuICAgICAgICBtZXNzYWdlczogW2Fzc2lzdGFudE1zZyhcIk1pbGVzdG9uZSBNMDAxIHJlYWR5LlwiKV0sXG4gICAgICB9KTtcbiAgICAgIGFzc2VydC5lcXVhbChoYW5kbGVkLCB0cnVlKTtcblxuICAgICAgY29uc3QgbG9ncyA9IGRyYWluTG9ncygpO1xuICAgICAgY29uc3QgZGlhZyA9IGxvZ3MuZmluZChcbiAgICAgICAgKGUpID0+IGUuY29tcG9uZW50ID09PSBcImd1aWRlZFwiICYmIC9yZWFkeS1waHJhc2UtcmVqZWN0IGRpYWdub3N0aWMvLnRlc3QoZS5tZXNzYWdlKSxcbiAgICAgICk7XG4gICAgICBhc3NlcnQub2soZGlhZywgXCJleHBlY3RlZCBkaWFnbm9zdGljIHdhcm5pbmcgdG8gYmUgbG9nZ2VkIHdoZW4gbnVkZ2UgZmlyZXNcIik7XG4gICAgICBhc3NlcnQubWF0Y2goZGlhZyEubWVzc2FnZSwgL21pZD1NMDAxLyk7XG4gICAgICBhc3NlcnQubWF0Y2goZGlhZyEubWVzc2FnZSwgbmV3IFJlZ0V4cChgYmFzZVBhdGg9JHtiYXNlLnJlcGxhY2UoL1svXFxcXF0vZywgXCJbL1xcXFxcXFxcXVwiKX1gKSk7XG4gICAgICBhc3NlcnQubWF0Y2goZGlhZyEubWVzc2FnZSwgL21EaXI9Lyk7XG4gICAgICBhc3NlcnQubWF0Y2goZGlhZyEubWVzc2FnZSwgL2N0eC1leGlzdHM9ZmFsc2UvKTtcbiAgICAgIGFzc2VydC5tYXRjaChkaWFnIS5tZXNzYWdlLCAvcm9hZG1hcC1leGlzdHM9ZmFsc2UvKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYXJQZW5kaW5nQXV0b1N0YXJ0KCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiZGlhZ25vc3RpYyBsb2dzIGN0eC1leGlzdHM9dHJ1ZSB3aGVuIGZpbGUgaXMgb24gZGlzayBidXQgY2FjaGVkIHJlc29sdmVyIG1pc3NlZCBpdFwiLCAoKSA9PiB7XG4gICAgLy8gU2ltdWxhdGVzIHRoZSB0ZXN0MTIzICM1eHh4IHNjZW5hcmlvOiBmaWxlIGV4aXN0cyBvbiBkaXNrLCBjYWNoZWRcbiAgICAvLyByZXNvbHZlciBjbGFpbXMgaXQgZG9lc24ndC4gV2UgZHJvcCBhIGZpbGUgd2l0aCBhIG5vbi1jYW5vbmljYWwgcGF0aFxuICAgIC8vIChmb3JjZXMgdGhlIGxlZ2FjeS1kZXNjcmlwdG9yIHBhdHRlcm4gbWlzcykgc28gcmVzb2x2ZU1pbGVzdG9uZUZpbGVcbiAgICAvLyByZXR1cm5zIG51bGwgYnV0IGV4aXN0c1N5bmMgb24gdGhlIGNhbm9uaWNhbCBwYXRoIHJldHVybnMgdHJ1ZS5cbiAgICAvL1xuICAgIC8vIE5vdGU6IHRoZSBjYW5vbmljYWwgcGF0aCBwcm9iZSBpbiB0aGUgZGlhZ25vc3RpYyB1c2VzIHRoZSBsaXRlcmFsXG4gICAgLy8gYCR7bWlsZXN0b25lSWR9LUNPTlRFWFQubWRgIGZpbGVuYW1lLiBJZiBhIGZpbGUgaXMgYXQgdGhhdCBwYXRoLFxuICAgIC8vIGV4aXN0c1N5bmMgd2lsbCBzZWUgaXQgcmVnYXJkbGVzcyBvZiByZXNvbHZlciBiZWhhdmlvci5cbiAgICBjb25zdCBiYXNlID0gbWtCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGRyYWluTG9ncygpO1xuICAgICAgLy8gV3JpdGUgdGhlIGNhbm9uaWNhbCBmaWxlIGRpcmVjdGx5IFx1MjAxNCBib3RoIHJlc29sdmVyIEFORCBleGlzdHNTeW5jXG4gICAgICAvLyB3b3VsZCBub3JtYWxseSBzZWUgaXQuIFRvIHByb3ZlIHRoZSBkaWFnbm9zdGljIGNhcHR1cmVzIHRoZVxuICAgICAgLy8gZXhpc3RzU3luYyByZXN1bHQgaW5kZXBlbmRlbnRseSwgd2UgY292ZXIgdGhlIGJhc2ljIGNhc2UgaGVyZS5cbiAgICAgIGNvbnN0IGNhcCA9IG1rQ2FwdHVyZSgpO1xuICAgICAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlLCB7XG4gICAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIGN0eDogbWtDdHgoY2FwKSxcbiAgICAgICAgcGk6IG1rUGkoY2FwKSxcbiAgICAgIH0pO1xuICAgICAgLy8gTm8gZmlsZXMgd3JpdHRlbiBcdTIwMTQgYm90aCBwcm9iZXMgc2hvdWxkIHJlcG9ydCBmYWxzZS5cbiAgICAgIG1heWJlSGFuZGxlUmVhZHlQaHJhc2VXaXRob3V0RmlsZXMoe1xuICAgICAgICBtZXNzYWdlczogW2Fzc2lzdGFudE1zZyhcIk1pbGVzdG9uZSBNMDAxIHJlYWR5LlwiKV0sXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGxvZ3MgPSBkcmFpbkxvZ3MoKTtcbiAgICAgIGNvbnN0IGRpYWcgPSBsb2dzLmZpbmQoXG4gICAgICAgIChlKSA9PiBlLmNvbXBvbmVudCA9PT0gXCJndWlkZWRcIiAmJiAvcmVhZHktcGhyYXNlLXJlamVjdCBkaWFnbm9zdGljLy50ZXN0KGUubWVzc2FnZSksXG4gICAgICApO1xuICAgICAgYXNzZXJ0Lm9rKGRpYWcsIFwiZGlhZ25vc3RpYyBsb2dnZWRcIik7XG4gICAgICAvLyBtRGlyIHJlc29sdmVzIGJlY2F1c2UgbWtCYXNlIGNyZWF0ZXMgdGhlIGRpcmVjdG9yeVxuICAgICAgYXNzZXJ0Lm1hdGNoKGRpYWchLm1lc3NhZ2UsIC9tRGlyPS4rTTAwMS8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGRpYWchLm1lc3NhZ2UsIC9jYW5vbmljYWwtY3R4PS4rTTAwMS1DT05URVhUXFwubWQvKTtcbiAgICAgIGFzc2VydC5tYXRjaChkaWFnIS5tZXNzYWdlLCAvY2Fub25pY2FsLXJvYWRtYXA9LitNMDAxLVJPQURNQVBcXC5tZC8pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhclBlbmRpbmdBdXRvU3RhcnQoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJmcmVzaCBlbnRyeSBhZnRlciBnaXZlLXVwIHJlc2V0cyBjb3VudGVyXCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWtCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNhcCA9IG1rQ2FwdHVyZSgpO1xuICAgICAgLy8gRmlyc3QgY3ljbGU6IGV4aGF1c3QgY2FwXG4gICAgICBzZXRQZW5kaW5nQXV0b1N0YXJ0KGJhc2UsIHtcbiAgICAgICAgYmFzZVBhdGg6IGJhc2UsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgICAgY3R4OiBta0N0eChjYXApLFxuICAgICAgICBwaTogbWtQaShjYXApLFxuICAgICAgfSk7XG4gICAgICBjb25zdCBldmVudCA9IHsgbWVzc2FnZXM6IFthc3Npc3RhbnRNc2coXCJNaWxlc3RvbmUgTTAwMSByZWFkeS5cIildIH07XG4gICAgICBtYXliZUhhbmRsZVJlYWR5UGhyYXNlV2l0aG91dEZpbGVzKGV2ZW50KTtcbiAgICAgIG1heWJlSGFuZGxlUmVhZHlQaHJhc2VXaXRob3V0RmlsZXMoZXZlbnQpO1xuICAgICAgbWF5YmVIYW5kbGVSZWFkeVBocmFzZVdpdGhvdXRGaWxlcyhldmVudCk7IC8vIGNsZWFycyBlbnRyeVxuXG4gICAgICAvLyBOZXcgL2dzZCBydW4gXHUyMDE0IHJlLXNlZWRzIGVudHJ5OyBjb3VudGVyIG11c3QgYmUgMCBhZ2FpblxuICAgICAgY2FwLm1lc3NhZ2VzLmxlbmd0aCA9IDA7XG4gICAgICBzZXRQZW5kaW5nQXV0b1N0YXJ0KGJhc2UsIHtcbiAgICAgICAgYmFzZVBhdGg6IGJhc2UsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgICAgY3R4OiBta0N0eChjYXApLFxuICAgICAgICBwaTogbWtQaShjYXApLFxuICAgICAgfSk7XG4gICAgICBjb25zdCBoYW5kbGVkID0gbWF5YmVIYW5kbGVSZWFkeVBocmFzZVdpdGhvdXRGaWxlcyhldmVudCk7XG4gICAgICBhc3NlcnQuZXF1YWwoaGFuZGxlZCwgdHJ1ZSk7XG4gICAgICBhc3NlcnQuZXF1YWwoY2FwLm1lc3NhZ2VzLmxlbmd0aCwgMSwgXCJmcmVzaCBlbnRyeSBmaXJlcyBudWRnZSBhZ2FpblwiKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYXJQZW5kaW5nQXV0b1N0YXJ0KCk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZW1wdHktdHVybiByZWNvdmVyeSAoTGF5ZXIgMykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiIzQ1NzMgbWF5YmVIYW5kbGVFbXB0eUludGVudFR1cm5cIiwgKCkgPT4ge1xuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICBjbGVhclBlbmRpbmdBdXRvU3RhcnQoKTtcbiAgICByZXNldEVtcHR5VHVybkNvdW50ZXIoKTtcbiAgfSk7XG5cbiAgdGVzdChcIm5vIHBlbmRpbmcgZW50cnkgKyBpc0F1dG8gZmFsc2UgXHUyMTkyIG5vLW9wIChpbnRlcmFjdGl2ZSBkaXNjdXNzIGlzIHVzZXItZHJpdmVuKVwiLCAoKSA9PiB7XG4gICAgY29uc3QgZXZlbnQgPSB7IG1lc3NhZ2VzOiBbYXNzaXN0YW50TXNnKFwiSSdsbCB3cml0ZSB0aGUgQ09OVEVYVC5tZCBub3cuXCIpXSB9O1xuICAgIGNvbnN0IGhhbmRsZWQgPSBtYXliZUhhbmRsZUVtcHR5SW50ZW50VHVybihldmVudCwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChoYW5kbGVkLCBmYWxzZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJ0ZXh0LW9ubHkgdHVybiBXSVRIT1VUIGNvbW1pdCBwaHJhc2UgXHUyMTkyIG5vdCBmbGFnZ2VkIChsZWdpdGltYXRlIHRleHQpXCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWtCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNhcCA9IG1rQ2FwdHVyZSgpO1xuICAgICAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlLCB7XG4gICAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIGN0eDogbWtDdHgoY2FwKSxcbiAgICAgICAgcGk6IG1rUGkoY2FwKSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgaGFuZGxlZCA9IG1heWJlSGFuZGxlRW1wdHlJbnRlbnRUdXJuKFxuICAgICAgICB7IG1lc3NhZ2VzOiBbYXNzaXN0YW50TXNnKFwiSGVyZSBpcyB0aGUgcm9hZG1hcCBwcmV2aWV3IFx1MjAxNCB0aHJlZSBzbGljZXMuXCIpXSB9LFxuICAgICAgICBmYWxzZSxcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZXF1YWwoaGFuZGxlZCwgZmFsc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNhcC5tZXNzYWdlcy5sZW5ndGgsIDApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhclBlbmRpbmdBdXRvU3RhcnQoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJ0ZXh0LW9ubHkgdHVybiBlbmRpbmcgaW4gcXVlc3Rpb24gXHUyMTkyIHRyZWF0ZWQgYXMgdXNlci1oYW5kb2ZmLCBub3QgZmxhZ2dlZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1rQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjYXAgPSBta0NhcHR1cmUoKTtcbiAgICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZSwge1xuICAgICAgICBiYXNlUGF0aDogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICBjdHg6IG1rQ3R4KGNhcCksXG4gICAgICAgIHBpOiBta1BpKGNhcCksXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGhhbmRsZWQgPSBtYXliZUhhbmRsZUVtcHR5SW50ZW50VHVybihcbiAgICAgICAgeyBtZXNzYWdlczogW2Fzc2lzdGFudE1zZyhcIlJlYWR5IHRvIHdyaXRlLCBvciB3YW50IHRvIGFkanVzdD9cIildIH0sXG4gICAgICAgIGZhbHNlLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5lcXVhbChoYW5kbGVkLCBmYWxzZSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFyUGVuZGluZ0F1dG9TdGFydCgpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcIm11bHRpLWxpbmUgbWVzc2FnZSB3aXRoIG1pZC1tZXNzYWdlIHF1ZXN0aW9uIFx1MjE5MiB0cmVhdGVkIGFzIHVzZXItaGFuZG9mZiAocmVncmVzc2lvbjogZGlzY3VzcyBmbG93KVwiLCAoKSA9PiB7XG4gICAgLy8gUmVncmVzc2lvbiBmb3IgdGhlIGRlZXAtbW9kZSBkaXNjdXNzLXByb2plY3QgY2FzZSB3aGVyZSB0aGUgTExNIGFza2VkXG4gICAgLy8gYSBjbGFyaWZ5aW5nIHF1ZXN0aW9uIG1pZC1tZXNzYWdlIGFuZCBlbmRlZCBvbiBhIGNsb3NpbmcgcmVtYXJrLiBUaGVcbiAgICAvLyBwcmV2aW91cyBoZXVyaXN0aWMgb25seSBjaGVja2VkIHRoZSBMQVNUIGxpbmUgZm9yIGA/YCBhbmQgbWlzc2VkIHRoZVxuICAgIC8vIGVhcmxpZXIgcXVlc3Rpb24sIGNhdXNpbmcgdGhlIGVtcHR5LXR1cm4gbnVkZ2UgdG8gYXV0by1yZXBseSBvblxuICAgIC8vIGJlaGFsZiBvZiB0aGUgdXNlci5cbiAgICBjb25zdCBiYXNlID0gbWtCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNhcCA9IG1rQ2FwdHVyZSgpO1xuICAgICAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlLCB7XG4gICAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIGN0eDogbWtDdHgoY2FwKSxcbiAgICAgICAgcGk6IG1rUGkoY2FwKSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgdGV4dCA9IFtcbiAgICAgICAgXCJMZXQgbWUgbWFrZSBzdXJlIEkgdW5kZXJzdGFuZCB3aGF0IHlvdSdyZSB0ZXN0aW5nIGhlcmUuXCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiV2UgbmVlZCBzb21ldGhpbmcgdG8gcGxhbi4gQSBmZXcgbGlnaHR3ZWlnaHQgb3B0aW9uczpcIixcbiAgICAgICAgXCItIEEgc2ltcGxlIENMSSB0b29sXCIsXG4gICAgICAgIFwiLSBBIHN0YXRpYyBBUElcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCJXaGF0IHNob3VsZCB0aGUgZmljdGlvbmFsIHByb2plY3QgYmU/XCIsXG4gICAgICAgIFwiXCIsXG4gICAgICAgIFwiSWYgeW91IGhhdmUgYSBwcmVmZXJlbmNlLCBzYXkgdGhlIHdvcmQgYW5kIEknbGwgcGljayBvbmUuXCIsXG4gICAgICBdLmpvaW4oXCJcXG5cIik7XG4gICAgICBjb25zdCBoYW5kbGVkID0gbWF5YmVIYW5kbGVFbXB0eUludGVudFR1cm4oXG4gICAgICAgIHsgbWVzc2FnZXM6IFthc3Npc3RhbnRNc2codGV4dCldIH0sXG4gICAgICAgIGZhbHNlLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5lcXVhbChoYW5kbGVkLCBmYWxzZSwgXCJhbnkgbGluZSBlbmRpbmcgaW4gPyBtdXN0IGRlZmVyIHRvIHRoZSB1c2VyXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNhcC5tZXNzYWdlcy5sZW5ndGgsIDApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhclBlbmRpbmdBdXRvU3RhcnQoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJzaW5nbGUtbGluZSBhcHByb3ZhbCBwcm9tcHQgd2l0aCBtaWQtbGluZSBgP2AgYW5kIGNvbmRpdGlvbmFsIGludGVudCBcdTIxOTIgdHJlYXRlZCBhcyB1c2VyLWhhbmRvZmYgKHJlZ3Jlc3Npb246ICM1MTg3IGZvbGxvdy11cClcIiwgKCkgPT4ge1xuICAgIC8vIFJlZ3Jlc3Npb24gZm9yIHRoZSBkaXNjdXNzLW1pbGVzdG9uZSBjYXNlIHdoZXJlIHRoZSBMTE0gcHJlc2VudGVkIGFcbiAgICAvLyBkZXB0aCBzdW1tYXJ5IGFuZCBlbmRlZCB3aXRoOiBcIkRpZCBJIGNhcHR1cmUgdGhhdCBjb3JyZWN0bHk/IElmIHNvLFxuICAgIC8vIHNheSB5ZXMgYW5kIEknbGwgd3JpdGUgcmVxdWlyZW1lbnRzIGFuZCB0aGUgcm9hZG1hcCBwcmV2aWV3LlwiXG4gICAgLy8gVGhlIHByZXZpb3VzIGhldXJpc3RpYyBvbmx5IGNoZWNrZWQgZm9yIGxpbmVzICplbmRpbmcqIGluIGA/YCwgc29cbiAgICAvLyB0aGlzIHNpbmdsZS1saW5lIHBhcmFncmFwaCAodGVybWluYXRpbmcgaW4gYC5gKSBieXBhc3NlZCB0aGVcbiAgICAvLyB1c2VyLWhhbmRvZmYgZ3VhcmQsIHRoZW4gQ09NTUlUX0lOVEVOVF9SRSBtYXRjaGVkIFwiSSdsbCB3cml0ZVwiIGFuZFxuICAgIC8vIHRoZSBudWRnZSBhdXRvLXJlcGxpZWQgd2hpbGUgdGhlIHVzZXIgd2FzIG1lYW50IHRvIGFwcHJvdmUuXG4gICAgY29uc3QgYmFzZSA9IG1rQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjYXAgPSBta0NhcHR1cmUoKTtcbiAgICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZSwge1xuICAgICAgICBiYXNlUGF0aDogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICBjdHg6IG1rQ3R4KGNhcCksXG4gICAgICAgIHBpOiBta1BpKGNhcCksXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGhhbmRsZWQgPSBtYXliZUhhbmRsZUVtcHR5SW50ZW50VHVybihcbiAgICAgICAge1xuICAgICAgICAgIG1lc3NhZ2VzOiBbXG4gICAgICAgICAgICBhc3Npc3RhbnRNc2coXG4gICAgICAgICAgICAgIFwiRGlkIEkgY2FwdHVyZSB0aGF0IGNvcnJlY3RseT8gSWYgc28sIHNheSB5ZXMgYW5kIEknbGwgd3JpdGUgcmVxdWlyZW1lbnRzIGFuZCB0aGUgcm9hZG1hcCBwcmV2aWV3LlwiLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICBdLFxuICAgICAgICB9LFxuICAgICAgICBmYWxzZSxcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZXF1YWwoaGFuZGxlZCwgZmFsc2UsIFwiYW55IHNlbnRlbmNlLXRlcm1pbmF0aW5nID8gbXVzdCBkZWZlciB0byB0aGUgdXNlclwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYXAubWVzc2FnZXMubGVuZ3RoLCAwKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYXJQZW5kaW5nQXV0b1N0YXJ0KCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCdcIkxldCBtZSBtYWtlIHN1cmVcIiBtZXRhIHBocmFzZSBcdTIxOTIgbm90IGZsYWdnZWQgYXMgY29tbWl0IGludGVudCAocmVncmVzc2lvbiknLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1rQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjYXAgPSBta0NhcHR1cmUoKTtcbiAgICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZSwge1xuICAgICAgICBiYXNlUGF0aDogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICBjdHg6IG1rQ3R4KGNhcCksXG4gICAgICAgIHBpOiBta1BpKGNhcCksXG4gICAgICB9KTtcbiAgICAgIC8vIE5vIHF1ZXN0aW9uIG1hcmsgYW55d2hlcmUgXHUyMDE0IHNvIHRoZSBvbmx5IHRoaW5nIGtlZXBpbmcgdGhpcyBmcm9tXG4gICAgICAvLyBmaXJpbmcgdGhlIG51ZGdlIHNob3VsZCBiZSB0aGUgcmVmaW5lZCBjb21taXQtaW50ZW50IHJlZ2V4XG4gICAgICAvLyAoZHJvcHBpbmcgXCJtYWtlXCIgZnJvbSB0aGUgdmVyYiBsaXN0KS5cbiAgICAgIGNvbnN0IGhhbmRsZWQgPSBtYXliZUhhbmRsZUVtcHR5SW50ZW50VHVybihcbiAgICAgICAgeyBtZXNzYWdlczogW2Fzc2lzdGFudE1zZyhcIkxldCBtZSBtYWtlIHN1cmUgSSBoYXZlIHRoaXMgcmlnaHQuXCIpXSB9LFxuICAgICAgICBmYWxzZSxcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZXF1YWwoaGFuZGxlZCwgZmFsc2UsIFwibWV0YSBhY2tub3dsZWRnbWVudHMgYXJlIG5vdCBhY3Rpb24gYW5ub3VuY2VtZW50c1wiKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYXAubWVzc2FnZXMubGVuZ3RoLCAwKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYXJQZW5kaW5nQXV0b1N0YXJ0KCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwiY29tbWl0LWludGVudCBwaHJhc2UgV0lUSE9VVCB0b29sIGNhbGwgXHUyMTkyIG51ZGdlIGZpcmVzXCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWtCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNhcCA9IG1rQ2FwdHVyZSgpO1xuICAgICAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlLCB7XG4gICAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIGN0eDogbWtDdHgoY2FwKSxcbiAgICAgICAgcGk6IG1rUGkoY2FwKSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgaGFuZGxlZCA9IG1heWJlSGFuZGxlRW1wdHlJbnRlbnRUdXJuKFxuICAgICAgICB7IG1lc3NhZ2VzOiBbYXNzaXN0YW50TXNnKFwiSSdsbCBub3cgd3JpdGUgdGhlIENPTlRFWFQubWQgZmlsZS5cIildIH0sXG4gICAgICAgIGZhbHNlLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5lcXVhbChoYW5kbGVkLCB0cnVlKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYXAubWVzc2FnZXMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYXAubWVzc2FnZXNbMF0ucGF5bG9hZC5jdXN0b21UeXBlLCBcImdzZC1lbXB0eS10dXJuLXJlY292ZXJ5XCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhclBlbmRpbmdBdXRvU3RhcnQoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJjb21taXQtaW50ZW50IFdJVEggdG9vbC11c2UgYmxvY2sgXHUyMTkyIG5vdCBmbGFnZ2VkXCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWtCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNhcCA9IG1rQ2FwdHVyZSgpO1xuICAgICAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlLCB7XG4gICAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIGN0eDogbWtDdHgoY2FwKSxcbiAgICAgICAgcGk6IG1rUGkoY2FwKSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgaGFuZGxlZCA9IG1heWJlSGFuZGxlRW1wdHlJbnRlbnRUdXJuKFxuICAgICAgICB7IG1lc3NhZ2VzOiBbYXNzaXN0YW50TXNnKFwiSSdsbCB3cml0ZSB0aGUgZmlsZSBub3cuXCIsIHsgdG9vbFVzZTogdHJ1ZSB9KV0gfSxcbiAgICAgICAgZmFsc2UsXG4gICAgICApO1xuICAgICAgYXNzZXJ0LmVxdWFsKGhhbmRsZWQsIGZhbHNlKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYXAubWVzc2FnZXMubGVuZ3RoLCAwKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYXJQZW5kaW5nQXV0b1N0YXJ0KCk7XG4gICAgfVxuICB9KTtcblxuICAvLyBSZWdyZXNzaW9uIGZvciAjNDY1OCBcdTIwMTQgdW5kZXIgY2xhdWRlLWNvZGUtY2xpLCBNQ1AgdG9vbCBjYWxscyAoZS5nLlxuICAvLyBhc2tfdXNlcl9xdWVzdGlvbnMpIHJlYWNoIGd1aWRlZC1mbG93IGFzIGNhbm9uaWNhbCBcInRvb2xDYWxsXCIgLyBcInNlcnZlclRvb2xVc2VcIlxuICAvLyBibG9ja3MuIFByZS1maXgsIGhhc1Rvb2xVc2Ugb25seSBtYXRjaGVkIHRoZSBBbnRocm9waWMtd2lyZSBsaXRlcmFsIFwidG9vbF91c2VcIixcbiAgLy8gc28gdGhlIGVtcHR5LXR1cm4gbnVkZ2UgZmlyZWQgZHVyaW5nIHByZS1xdWVzdGlvbiBuYXJyYXRpb24gYW5kIHByZS1lbXB0ZWQgdGhlXG4gIC8vIHVzZXIncyBjaGFuY2UgdG8gYW5zd2VyLlxuICB0ZXN0KFwiY2MtY2xpIE1DUCB0b29sIGNhbGwgc3VyZmFjZWQgYXMgY2Fub25pY2FsIHRvb2xDYWxsIFx1MjE5MiBub3QgZmxhZ2dlZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1rQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjYXAgPSBta0NhcHR1cmUoKTtcbiAgICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZSwge1xuICAgICAgICBiYXNlUGF0aDogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICBjdHg6IG1rQ3R4KGNhcCksXG4gICAgICAgIHBpOiBta1BpKGNhcCksXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGhhbmRsZWQgPSBtYXliZUhhbmRsZUVtcHR5SW50ZW50VHVybihcbiAgICAgICAge1xuICAgICAgICAgIG1lc3NhZ2VzOiBbXG4gICAgICAgICAgICBhc3Npc3RhbnRNc2coXCJMZXQgbWUgY2FsbCBhc2tfdXNlcl9xdWVzdGlvbnMgdG8gZ2F0aGVyIHlvdXIgcHJlZmVyZW5jZXMuXCIsIHtcbiAgICAgICAgICAgICAgdG9vbFVzZTogXCJ0b29sQ2FsbFwiLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgXSxcbiAgICAgICAgfSxcbiAgICAgICAgZmFsc2UsXG4gICAgICApO1xuICAgICAgYXNzZXJ0LmVxdWFsKGhhbmRsZWQsIGZhbHNlKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYXAubWVzc2FnZXMubGVuZ3RoLCAwKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYXJQZW5kaW5nQXV0b1N0YXJ0KCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwic2VydmVyVG9vbFVzZSBibG9jayAoY2MtY2xpIHdlYiBzZWFyY2ggZXRjLikgXHUyMTkyIG5vdCBmbGFnZ2VkXCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWtCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNhcCA9IG1rQ2FwdHVyZSgpO1xuICAgICAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlLCB7XG4gICAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIGN0eDogbWtDdHgoY2FwKSxcbiAgICAgICAgcGk6IG1rUGkoY2FwKSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgaGFuZGxlZCA9IG1heWJlSGFuZGxlRW1wdHlJbnRlbnRUdXJuKFxuICAgICAgICB7XG4gICAgICAgICAgbWVzc2FnZXM6IFtcbiAgICAgICAgICAgIGFzc2lzdGFudE1zZyhcIkxldCBtZSBpbnZva2UgdGhlIHNlYXJjaCB0b29sIG5vdy5cIiwge1xuICAgICAgICAgICAgICB0b29sVXNlOiBcInNlcnZlclRvb2xVc2VcIixcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIF0sXG4gICAgICAgIH0sXG4gICAgICAgIGZhbHNlLFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5lcXVhbChoYW5kbGVkLCBmYWxzZSk7XG4gICAgICBhc3NlcnQuZXF1YWwoY2FwLm1lc3NhZ2VzLmxlbmd0aCwgMCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFyUGVuZGluZ0F1dG9TdGFydCgpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInJlYWR5IHBocmFzZSBpcyBOT1QgdHJlYXRlZCBhcyBlbXB0eS10dXJuIChoYW5kbGVkIGJ5IG90aGVyIHJlY292ZXJ5IHBhdGgpXCIsICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWtCYXNlKCk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNhcCA9IG1rQ2FwdHVyZSgpO1xuICAgICAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlLCB7XG4gICAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgIGN0eDogbWtDdHgoY2FwKSxcbiAgICAgICAgcGk6IG1rUGkoY2FwKSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgaGFuZGxlZCA9IG1heWJlSGFuZGxlRW1wdHlJbnRlbnRUdXJuKFxuICAgICAgICB7IG1lc3NhZ2VzOiBbYXNzaXN0YW50TXNnKFwiTWlsZXN0b25lIE0wMDEgcmVhZHkuXCIpXSB9LFxuICAgICAgICBmYWxzZSxcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZXF1YWwoaGFuZGxlZCwgZmFsc2UpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhclBlbmRpbmdBdXRvU3RhcnQoKTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJlbXB0eS10dXJuIHJldHJ5IGNhcCBcdTIwMTQgc3RvcHMgYWZ0ZXIgTUFYX0VNUFRZX1RVUk5fUkVUUklFU1wiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IG1rQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjYXAgPSBta0NhcHR1cmUoKTtcbiAgICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZSwge1xuICAgICAgICBiYXNlUGF0aDogYmFzZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICBjdHg6IG1rQ3R4KGNhcCksXG4gICAgICAgIHBpOiBta1BpKGNhcCksXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGV2ZW50ID0geyBtZXNzYWdlczogW2Fzc2lzdGFudE1zZyhcIkknbGwgd3JpdGUgdGhlIENPTlRFWFQubWQgZmlsZS5cIildIH07XG5cbiAgICAgIG1heWJlSGFuZGxlRW1wdHlJbnRlbnRUdXJuKGV2ZW50LCBmYWxzZSk7IC8vIDFcbiAgICAgIG1heWJlSGFuZGxlRW1wdHlJbnRlbnRUdXJuKGV2ZW50LCBmYWxzZSk7IC8vIDJcbiAgICAgIGNvbnN0IHRoaXJkID0gbWF5YmVIYW5kbGVFbXB0eUludGVudFR1cm4oZXZlbnQsIGZhbHNlKTsgLy8gPiBjYXBcblxuICAgICAgYXNzZXJ0LmVxdWFsKGNhcC5tZXNzYWdlcy5sZW5ndGgsIDIsIFwib25seSAyIG51ZGdlcyBzZW50XCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHRoaXJkLCBmYWxzZSwgXCJhZnRlciBjYXAsIG5vIGZ1cnRoZXIgaW5qZWN0aW9uXCIpO1xuICAgICAgYXNzZXJ0Lm9rKFxuICAgICAgICBjYXAubm90aWZpZXMuc29tZSgobikgPT4gL1N0b3BwaW5nIGF1dG8tbnVkZ2UvLnRlc3Qobi5tc2cpKSxcbiAgICAgICAgXCJ1c2VyIG5vdGlmaWVkIG9mIGdpdmUtdXBcIixcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFyUGVuZGluZ0F1dG9TdGFydCgpO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInJlc2V0RW1wdHlUdXJuQ291bnRlciBjbGVhcnMgc3RhdGUgYWZ0ZXIgYSBzdWNjZXNzZnVsIHRvb2wtdXNlIHR1cm5cIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBta0Jhc2UoKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgY2FwID0gbWtDYXB0dXJlKCk7XG4gICAgICBzZXRQZW5kaW5nQXV0b1N0YXJ0KGJhc2UsIHtcbiAgICAgICAgYmFzZVBhdGg6IGJhc2UsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgICAgY3R4OiBta0N0eChjYXApLFxuICAgICAgICBwaTogbWtQaShjYXApLFxuICAgICAgfSk7XG4gICAgICBjb25zdCBldmVudCA9IHsgbWVzc2FnZXM6IFthc3Npc3RhbnRNc2coXCJJJ2xsIHdyaXRlIHRoZSBDT05URVhULm1kIGZpbGUuXCIpXSB9O1xuXG4gICAgICBtYXliZUhhbmRsZUVtcHR5SW50ZW50VHVybihldmVudCwgZmFsc2UpOyAvLyAxXG4gICAgICBtYXliZUhhbmRsZUVtcHR5SW50ZW50VHVybihldmVudCwgZmFsc2UpOyAvLyAyIFx1MjAxNCBhdCBjYXBcbiAgICAgIHJlc2V0RW1wdHlUdXJuQ291bnRlcigpOyAvLyBzaW11bGF0ZSBhIHN1Y2Nlc3NmdWwgdG9vbC11c2UgdHVybiBpbiBiZXR3ZWVuXG5cbiAgICAgIGNhcC5tZXNzYWdlcy5sZW5ndGggPSAwO1xuICAgICAgY29uc3QgYWZ0ZXIgPSBtYXliZUhhbmRsZUVtcHR5SW50ZW50VHVybihldmVudCwgZmFsc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGFmdGVyLCB0cnVlLCBcImNvdW50ZXIgcmVzZXQgXHUyMDE0IG51ZGdlIGZpcmVzIGFnYWluXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNhcC5tZXNzYWdlcy5sZW5ndGgsIDEpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjbGVhclBlbmRpbmdBdXRvU3RhcnQoKTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFVQSxTQUFTLFVBQVUsTUFBTSxrQkFBa0I7QUFDM0MsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxX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
