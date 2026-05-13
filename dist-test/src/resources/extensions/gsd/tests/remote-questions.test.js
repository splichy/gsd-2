import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSlackReply, parseDiscordResponse, formatForDiscord, formatForSlack, parseSlackReactionResponse, formatForTelegram, parseTelegramResponse } from "../../remote-questions/format.js";
import { resolveRemoteConfig, isValidChannelId } from "../../remote-questions/config.js";
import { DiscordAdapter } from "../../remote-questions/discord-adapter.js";
import { isRemoteConfigured } from "../../remote-questions/manager.js";
import { handleRemote, saveRemoteQuestionsConfig } from "../../remote-questions/remote-command.js";
import { SlackAdapter } from "../../remote-questions/slack-adapter.js";
import { sanitizeError } from "../../shared/sanitize.js";
function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}
async function withTempGsdHome(fn) {
  const oldHome = process.env.GSD_HOME;
  const home = mkdtempSync(join(tmpdir(), "gsd-remote-home-"));
  try {
    process.env.GSD_HOME = home;
    return await fn(home);
  } finally {
    if (oldHome === void 0) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
}
test("parseSlackReply handles single-number single-question answers", () => {
  const result = parseSlackReply("2", [{
    id: "choice",
    header: "Choice",
    question: "Pick one",
    allowMultiple: false,
    options: [
      { label: "Alpha", description: "A" },
      { label: "Beta", description: "B" }
    ]
  }]);
  assert.deepEqual(result, { answers: { choice: { answers: ["Beta"] } } });
});
test("parseSlackReply handles multiline multi-question answers", () => {
  const result = parseSlackReply("1\ncustom note", [
    {
      id: "first",
      header: "First",
      question: "Pick one",
      allowMultiple: false,
      options: [
        { label: "Alpha", description: "A" },
        { label: "Beta", description: "B" }
      ]
    },
    {
      id: "second",
      header: "Second",
      question: "Explain",
      allowMultiple: false,
      options: [
        { label: "Gamma", description: "G" },
        { label: "Delta", description: "D" }
      ]
    }
  ]);
  assert.deepEqual(result, {
    answers: {
      first: { answers: ["Alpha"] },
      second: { answers: [], user_note: "custom note" }
    }
  });
});
test("parseDiscordResponse handles single-question reactions", () => {
  const result = parseDiscordResponse([{ emoji: "2\uFE0F\u20E3", count: 1 }], null, [{
    id: "choice",
    header: "Choice",
    question: "Pick one",
    allowMultiple: false,
    options: [
      { label: "Alpha", description: "A" },
      { label: "Beta", description: "B" }
    ]
  }]);
  assert.deepEqual(result, { answers: { choice: { answers: ["Beta"] } } });
});
test("parseDiscordResponse rejects multi-question reaction parsing", () => {
  const result = parseDiscordResponse([{ emoji: "1\uFE0F\u20E3", count: 1 }], null, [
    {
      id: "first",
      header: "First",
      question: "Pick one",
      allowMultiple: false,
      options: [{ label: "Alpha", description: "A" }]
    },
    {
      id: "second",
      header: "Second",
      question: "Pick one",
      allowMultiple: false,
      options: [{ label: "Beta", description: "B" }]
    }
  ]);
  assert.match(String(result.answers.first.user_note), /single-question prompts/i);
  assert.match(String(result.answers.second.user_note), /single-question prompts/i);
});
test("parseSlackReactionResponse handles single-question reactions", () => {
  const result = parseSlackReactionResponse(["two"], [{
    id: "choice",
    header: "Choice",
    question: "Pick one",
    allowMultiple: false,
    options: [
      { label: "Alpha", description: "A" },
      { label: "Beta", description: "B" }
    ]
  }]);
  assert.deepEqual(result, { answers: { choice: { answers: ["Beta"] } } });
});
test("parseSlackReply truncates user_note longer than 500 chars", () => {
  const longText = "x".repeat(600);
  const result = parseSlackReply(longText, [{
    id: "q1",
    header: "Q1",
    question: "Pick",
    allowMultiple: false,
    options: [{ label: "A", description: "a" }]
  }]);
  const note = result.answers.q1.user_note;
  assert.ok(note.length <= 502, `note should be truncated, got ${note.length} chars`);
  assert.ok(note.endsWith("\u2026"), "truncated note should end with ellipsis");
});
test("isValidChannelId rejects invalid Slack channel IDs", () => {
  assert.equal(isValidChannelId("slack", "C123"), false);
  assert.equal(isValidChannelId("slack", "https://evil.com"), false);
  assert.equal(isValidChannelId("slack", "c12345678"), false);
  assert.equal(isValidChannelId("slack", "C1234567890AB"), false);
  assert.equal(isValidChannelId("slack", "C12345678"), true);
  assert.equal(isValidChannelId("slack", "C12345678AB"), true);
  assert.equal(isValidChannelId("slack", "C1234567890A"), true);
});
test("isValidChannelId rejects invalid Discord channel IDs", () => {
  assert.equal(isValidChannelId("discord", "12345"), false);
  assert.equal(isValidChannelId("discord", "abc12345678901234"), false);
  assert.equal(isValidChannelId("discord", "https://evil.com"), false);
  assert.equal(isValidChannelId("discord", "123456789012345678901"), false);
  assert.equal(isValidChannelId("discord", "12345678901234567"), true);
  assert.equal(isValidChannelId("discord", "11234567890123456789"), true);
});
test("sanitizeError strips Slack token patterns from error messages", () => {
  assert.equal(
    sanitizeError("Auth failed: xoxb-1234-5678-abcdef"),
    "Auth failed: [REDACTED]"
  );
  assert.equal(
    sanitizeError("Bad token xoxp-abc-def-ghi in request"),
    "Bad token [REDACTED] in request"
  );
});
test("sanitizeError strips long opaque secrets", () => {
  const fakeDiscordToken = "MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.G1x2y3.abcdefghijklmnop";
  assert.ok(!sanitizeError(`Token: ${fakeDiscordToken}`).includes(fakeDiscordToken));
});
test("sanitizeError preserves short safe messages", () => {
  assert.equal(sanitizeError("HTTP 401: Unauthorized"), "HTTP 401: Unauthorized");
  assert.equal(sanitizeError("Connection refused"), "Connection refused");
});
test("formatForDiscord includes context source in footer when present", () => {
  const prompt = {
    id: "test-1",
    channel: "discord",
    createdAt: Date.now(),
    timeoutAt: Date.now() + 6e4,
    pollIntervalMs: 5e3,
    context: { source: "auto-mode-dispatch" },
    questions: [{
      id: "q1",
      header: "Confirm",
      question: "Proceed?",
      options: [
        { label: "Yes", description: "Continue" },
        { label: "No", description: "Stop" }
      ],
      allowMultiple: false
    }]
  };
  const { embeds } = formatForDiscord(prompt);
  assert.equal(embeds.length, 1);
  assert.ok(embeds[0].footer?.text.includes("auto-mode-dispatch"), "footer should include context source");
});
test("formatForSlack includes context source when present", () => {
  const blocks = formatForSlack({
    id: "slack-1",
    channel: "slack",
    createdAt: Date.now(),
    timeoutAt: Date.now() + 6e4,
    pollIntervalMs: 5e3,
    context: { source: "ask_user_questions" },
    questions: [{
      id: "q1",
      header: "Confirm",
      question: "Proceed?",
      options: [
        { label: "Yes", description: "Continue" },
        { label: "No", description: "Stop" }
      ],
      allowMultiple: false
    }]
  });
  const sourceBlock = blocks.find((block) => block.type === "context" && block.elements?.some((el) => el.text.includes("Source:")));
  assert.ok(sourceBlock, "Slack blocks should include a context source block");
});
test("formatForSlack multi-question prompts explain semicolon and newline reply format", () => {
  const blocks = formatForSlack({
    id: "slack-2",
    channel: "slack",
    createdAt: Date.now(),
    timeoutAt: Date.now() + 6e4,
    pollIntervalMs: 5e3,
    questions: [
      {
        id: "q1",
        header: "First",
        question: "Pick one",
        options: [
          { label: "Alpha", description: "A" },
          { label: "Beta", description: "B" }
        ],
        allowMultiple: false
      },
      {
        id: "q2",
        header: "Second",
        question: "Explain",
        options: [
          { label: "Gamma", description: "G" },
          { label: "Delta", description: "D" }
        ],
        allowMultiple: false
      }
    ]
  });
  const instructionBlock = blocks.find((block) => block.type === "context" && block.elements?.some((el) => el.text.includes("one line per question")));
  assert.ok(instructionBlock, "Slack multi-question prompts should explain one-line or semicolon reply format");
});
test("formatForDiscord omits source from footer when context is absent", () => {
  const prompt = {
    id: "test-2",
    channel: "discord",
    createdAt: Date.now(),
    timeoutAt: Date.now() + 6e4,
    pollIntervalMs: 5e3,
    questions: [{
      id: "q1",
      header: "Choice",
      question: "Pick one",
      options: [
        { label: "A", description: "Alpha" },
        { label: "B", description: "Beta" }
      ],
      allowMultiple: false
    }]
  };
  const { embeds } = formatForDiscord(prompt);
  assert.ok(!embeds[0].footer?.text.includes("Source:"), "footer should not include Source when context absent");
});
test("formatForDiscord multi-question footer includes question position", () => {
  const prompt = {
    id: "test-3",
    channel: "discord",
    createdAt: Date.now(),
    timeoutAt: Date.now() + 6e4,
    pollIntervalMs: 5e3,
    questions: [
      {
        id: "q1",
        header: "First",
        question: "Pick",
        options: [{ label: "A", description: "a" }],
        allowMultiple: false
      },
      {
        id: "q2",
        header: "Second",
        question: "Pick",
        options: [{ label: "B", description: "b" }],
        allowMultiple: false
      }
    ]
  };
  const { embeds } = formatForDiscord(prompt);
  assert.equal(embeds.length, 2);
  assert.ok(embeds[0].footer?.text.includes("1/2"), "first embed footer should show 1/2");
  assert.ok(embeds[1].footer?.text.includes("2/2"), "second embed footer should show 2/2");
});
test("formatForDiscord single-question generates reaction emojis", () => {
  const prompt = {
    id: "test-4",
    channel: "discord",
    createdAt: Date.now(),
    timeoutAt: Date.now() + 6e4,
    pollIntervalMs: 5e3,
    questions: [{
      id: "q1",
      header: "Pick",
      question: "Choose",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
        { label: "C", description: "c" }
      ],
      allowMultiple: false
    }]
  };
  const { reactionEmojis } = formatForDiscord(prompt);
  assert.equal(reactionEmojis.length, 3, "should generate 3 reaction emojis for 3 options");
  assert.equal(reactionEmojis[0], "1\uFE0F\u20E3");
  assert.equal(reactionEmojis[1], "2\uFE0F\u20E3");
  assert.equal(reactionEmojis[2], "3\uFE0F\u20E3");
});
test("formatForDiscord multi-question generates no reaction emojis", () => {
  const prompt = {
    id: "test-5",
    channel: "discord",
    createdAt: Date.now(),
    timeoutAt: Date.now() + 6e4,
    pollIntervalMs: 5e3,
    questions: [
      {
        id: "q1",
        header: "First",
        question: "Pick",
        options: [{ label: "A", description: "a" }],
        allowMultiple: false
      },
      {
        id: "q2",
        header: "Second",
        question: "Pick",
        options: [{ label: "B", description: "b" }],
        allowMultiple: false
      }
    ]
  };
  const { reactionEmojis } = formatForDiscord(prompt);
  assert.equal(reactionEmojis.length, 0, "multi-question should not generate reaction emojis");
});
test("parseDiscordResponse handles multi-question text reply via semicolons", () => {
  const result = parseDiscordResponse([], "1;2", [
    {
      id: "first",
      header: "First",
      question: "Pick one",
      allowMultiple: false,
      options: [
        { label: "Alpha", description: "A" },
        { label: "Beta", description: "B" }
      ]
    },
    {
      id: "second",
      header: "Second",
      question: "Pick one",
      allowMultiple: false,
      options: [
        { label: "Gamma", description: "G" },
        { label: "Delta", description: "D" }
      ]
    }
  ]);
  assert.deepEqual(result.answers.first.answers, ["Alpha"]);
  assert.deepEqual(result.answers.second.answers, ["Delta"]);
});
test("parseDiscordResponse handles multiple reactions for allowMultiple question", () => {
  const result = parseDiscordResponse(
    [{ emoji: "1\uFE0F\u20E3", count: 1 }, { emoji: "3\uFE0F\u20E3", count: 1 }],
    null,
    [{
      id: "choice",
      header: "Choice",
      question: "Pick any",
      allowMultiple: true,
      options: [
        { label: "Alpha", description: "A" },
        { label: "Beta", description: "B" },
        { label: "Gamma", description: "G" }
      ]
    }]
  );
  assert.deepEqual(result.answers.choice.answers, ["Alpha", "Gamma"]);
});
test("DiscordAdapter validates guild, sends prompt URL, and acknowledges with checkmark", async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url, init) => {
    const href = String(url);
    calls.push({ url: href, method: String(init?.method ?? "GET") });
    if (href.endsWith("/users/@me")) return jsonResponse({ id: "bot-1" });
    if (href.includes("/channels/12345678901234567") && !href.includes("/messages")) return jsonResponse({ guild_id: "guild-1" });
    if (href.endsWith("/messages")) return jsonResponse({ id: "message-1" });
    return jsonResponse({});
  });
  try {
    const adapter = new DiscordAdapter("token", "12345678901234567");
    await adapter.validate();
    const result = await adapter.sendPrompt({
      id: "discord-1",
      channel: "discord",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 6e4,
      pollIntervalMs: 5e3,
      questions: [{
        id: "q1",
        header: "Pick",
        question: "Choose",
        allowMultiple: false,
        options: [{ label: "A", description: "a" }]
      }]
    });
    await adapter.acknowledgeAnswer(result.ref);
    assert.equal(result.ref.threadUrl, "https://discord.com/channels/guild-1/12345678901234567/message-1");
    assert.ok(calls.some((call) => call.method === "PUT" && call.url.includes(encodeURIComponent("\u2705"))));
  } finally {
    fetchMock.mock.restore();
  }
});
test("SlackAdapter polls reactions and acknowledges with white_check_mark", async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url, init) => {
    const href = String(url);
    calls.push({ url: href, method: String(init?.method ?? "GET"), body: String(init?.body ?? "") });
    if (href.includes("/auth.test")) return jsonResponse({ ok: true, user_id: "bot-1" });
    if (href.includes("/chat.postMessage")) return jsonResponse({ ok: true, ts: "123.456", channel: "C12345678" });
    if (href.includes("/reactions.get")) {
      return jsonResponse({
        ok: true,
        message: { reactions: [{ name: "two", count: 1, users: ["human-1"] }] }
      });
    }
    return jsonResponse({ ok: true });
  });
  try {
    const adapter = new SlackAdapter("xoxb-test", "C12345678");
    await adapter.validate();
    const prompt = {
      id: "slack-1",
      channel: "slack",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 6e4,
      pollIntervalMs: 5e3,
      questions: [{
        id: "q1",
        header: "Pick",
        question: "Choose",
        allowMultiple: false,
        options: [
          { label: "A", description: "a" },
          { label: "B", description: "b" }
        ]
      }]
    };
    const sent = await adapter.sendPrompt(prompt);
    const answer = await adapter.pollAnswer(prompt, sent.ref);
    await adapter.acknowledgeAnswer(sent.ref);
    assert.deepEqual(answer, { answers: { q1: { answers: ["B"] } } });
    assert.ok(calls.some((call) => call.url.includes("/reactions.get")));
    assert.ok(calls.some(
      (call) => call.url.includes("/reactions.add") && typeof call.body === "string" && call.body.includes("white_check_mark")
    ));
  } finally {
    fetchMock.mock.restore();
  }
});
test("formatForTelegram single-question produces inline keyboard", () => {
  const prompt = {
    id: "tg-1",
    channel: "telegram",
    createdAt: Date.now(),
    timeoutAt: Date.now() + 6e4,
    pollIntervalMs: 5e3,
    questions: [{
      id: "q1",
      header: "Confirm",
      question: "Proceed?",
      options: [
        { label: "Yes", description: "Continue" },
        { label: "No", description: "Stop" }
      ],
      allowMultiple: false
    }]
  };
  const msg = formatForTelegram(prompt);
  assert.equal(msg.parse_mode, "HTML");
  assert.ok(msg.text.includes("<b>GSD needs your input</b>"));
  assert.ok(msg.text.includes("<b>Confirm</b>"));
  assert.ok(msg.reply_markup, "single-question should have inline keyboard");
  assert.equal(msg.reply_markup.inline_keyboard.length, 2, "should have 2 button rows");
  assert.equal(msg.reply_markup.inline_keyboard[0][0].callback_data, "tg-1:0");
  assert.equal(msg.reply_markup.inline_keyboard[1][0].callback_data, "tg-1:1");
});
test("formatForTelegram multi-question omits inline keyboard", () => {
  const prompt = {
    id: "tg-2",
    channel: "telegram",
    createdAt: Date.now(),
    timeoutAt: Date.now() + 6e4,
    pollIntervalMs: 5e3,
    questions: [
      {
        id: "q1",
        header: "First",
        question: "Pick",
        options: [{ label: "A", description: "a" }],
        allowMultiple: false
      },
      {
        id: "q2",
        header: "Second",
        question: "Pick",
        options: [{ label: "B", description: "b" }],
        allowMultiple: false
      }
    ]
  };
  const msg = formatForTelegram(prompt);
  assert.equal(msg.reply_markup, void 0, "multi-question should not have inline keyboard");
  assert.ok(msg.text.includes("1/2"), "should show question position");
  assert.ok(msg.text.includes("2/2"), "should show question position");
});
test("formatForTelegram escapes HTML in user content", () => {
  const prompt = {
    id: "tg-3",
    channel: "telegram",
    createdAt: Date.now(),
    timeoutAt: Date.now() + 6e4,
    pollIntervalMs: 5e3,
    questions: [{
      id: "q1",
      header: "Test <script>",
      question: "Is 5 > 3 & 2 < 4?",
      options: [{ label: "<b>Yes</b>", description: "it's true" }],
      allowMultiple: false
    }]
  };
  const msg = formatForTelegram(prompt);
  assert.ok(msg.text.includes("&lt;script&gt;"), "should escape < > in header");
  assert.ok(msg.text.includes("5 &gt; 3 &amp; 2 &lt; 4"), "should escape in question");
  assert.ok(msg.text.includes("&lt;b&gt;Yes&lt;/b&gt;"), "should escape in option label");
});
test("parseTelegramResponse handles callback_data button press", () => {
  const questions = [{
    id: "choice",
    header: "Pick",
    question: "Choose",
    allowMultiple: false,
    options: [
      { label: "Alpha", description: "A" },
      { label: "Beta", description: "B" }
    ]
  }];
  const result = parseTelegramResponse("prompt-123:1", null, questions, "prompt-123");
  assert.deepEqual(result, { answers: { choice: { answers: ["Beta"] } } });
});
test("parseTelegramResponse handles text reply delegation", () => {
  const questions = [{
    id: "choice",
    header: "Pick",
    question: "Choose",
    allowMultiple: false,
    options: [
      { label: "Alpha", description: "A" },
      { label: "Beta", description: "B" }
    ]
  }];
  const result = parseTelegramResponse(null, "1", questions, "prompt-123");
  assert.deepEqual(result, { answers: { choice: { answers: ["Alpha"] } } });
});
test("parseTelegramResponse handles multi-question semicolons", () => {
  const questions = [
    {
      id: "first",
      header: "First",
      question: "Pick",
      allowMultiple: false,
      options: [
        { label: "Alpha", description: "A" },
        { label: "Beta", description: "B" }
      ]
    },
    {
      id: "second",
      header: "Second",
      question: "Pick",
      allowMultiple: false,
      options: [
        { label: "Gamma", description: "G" },
        { label: "Delta", description: "D" }
      ]
    }
  ];
  const result = parseTelegramResponse(null, "2;1", questions, "prompt-123");
  assert.deepEqual(result.answers.first.answers, ["Beta"]);
  assert.deepEqual(result.answers.second.answers, ["Gamma"]);
});
test("isValidChannelId validates Telegram chat IDs", () => {
  assert.equal(isValidChannelId("telegram", "12345"), true);
  assert.equal(isValidChannelId("telegram", "-1001234567890"), true);
  assert.equal(isValidChannelId("telegram", "1234"), false);
  assert.equal(isValidChannelId("telegram", "abc12345"), false);
  assert.equal(isValidChannelId("telegram", "https://evil.com"), false);
});
test("sanitizeError strips Telegram bot token patterns", () => {
  const fakeToken = "1234567890:ABCdefGHIjklMNOpqrSTUvwxyz12345678";
  const result = sanitizeError(`Token: ${fakeToken}`);
  assert.ok(!result.includes("1234567890:ABC"), "should strip Telegram bot token");
});
test("resolveRemoteConfig uses configured channel and existing environment token", async () => {
  const saved = process.env.SLACK_BOT_TOKEN;
  try {
    await withTempGsdHome(() => {
      process.env.SLACK_BOT_TOKEN = "xoxb-existing";
      saveRemoteQuestionsConfig("slack", "C12345678");
      assert.deepEqual(resolveRemoteConfig(), {
        channel: "slack",
        channelId: "C12345678",
        timeoutMs: 5 * 60 * 1e3,
        pollIntervalMs: 5 * 1e3,
        token: "xoxb-existing"
      });
      assert.equal(isRemoteConfigured(), true);
    });
  } finally {
    if (saved === void 0) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = saved;
  }
});
test("resolveRemoteConfig returns null when preferences are absent (no env side-effects)", () => {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  const savedDiscord = process.env.DISCORD_BOT_TOKEN;
  const savedSlack = process.env.SLACK_BOT_TOKEN;
  const savedTelegram = process.env.TELEGRAM_BOT_TOKEN;
  try {
    process.env.HOME = "/tmp/gsd-no-such-home-for-test";
    process.env.USERPROFILE = "/tmp/gsd-no-such-home-for-test";
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    const result = resolveRemoteConfig();
    assert.equal(result, null, "resolveRemoteConfig should return null when no preferences are configured");
  } finally {
    process.env.HOME = savedHome;
    process.env.USERPROFILE = savedUserProfile;
    if (savedDiscord !== void 0) process.env.DISCORD_BOT_TOKEN = savedDiscord;
    if (savedSlack !== void 0) process.env.SLACK_BOT_TOKEN = savedSlack;
    if (savedTelegram !== void 0) process.env.TELEGRAM_BOT_TOKEN = savedTelegram;
  }
});
test("remote disconnect removes active env token and disables remote config", async () => {
  const saved = process.env.DISCORD_BOT_TOKEN;
  try {
    await withTempGsdHome(async () => {
      process.env.DISCORD_BOT_TOKEN = "discord-token";
      saveRemoteQuestionsConfig("discord", "12345678901234567");
      assert.equal(isRemoteConfigured(), true);
      const notifications = [];
      await handleRemote("disconnect", {
        ui: { notify(message) {
          notifications.push(message);
        } }
      }, {});
      assert.equal(process.env.DISCORD_BOT_TOKEN, void 0);
      assert.equal(resolveRemoteConfig(), null);
      assert.ok(notifications.some((message) => message.includes("disconnected")));
    });
  } finally {
    if (saved === void 0) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = saved;
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZW1vdGUtcXVlc3Rpb25zLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0LCB7IG1vY2sgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBwYXJzZVNsYWNrUmVwbHksIHBhcnNlRGlzY29yZFJlc3BvbnNlLCBmb3JtYXRGb3JEaXNjb3JkLCBmb3JtYXRGb3JTbGFjaywgcGFyc2VTbGFja1JlYWN0aW9uUmVzcG9uc2UsIGZvcm1hdEZvclRlbGVncmFtLCBwYXJzZVRlbGVncmFtUmVzcG9uc2UgfSBmcm9tIFwiLi4vLi4vcmVtb3RlLXF1ZXN0aW9ucy9mb3JtYXQudHNcIjtcbmltcG9ydCB7IHJlc29sdmVSZW1vdGVDb25maWcsIGlzVmFsaWRDaGFubmVsSWQgfSBmcm9tIFwiLi4vLi4vcmVtb3RlLXF1ZXN0aW9ucy9jb25maWcudHNcIjtcbmltcG9ydCB7IERpc2NvcmRBZGFwdGVyIH0gZnJvbSBcIi4uLy4uL3JlbW90ZS1xdWVzdGlvbnMvZGlzY29yZC1hZGFwdGVyLnRzXCI7XG5pbXBvcnQgeyBpc1JlbW90ZUNvbmZpZ3VyZWQgfSBmcm9tIFwiLi4vLi4vcmVtb3RlLXF1ZXN0aW9ucy9tYW5hZ2VyLnRzXCI7XG5pbXBvcnQgeyBoYW5kbGVSZW1vdGUsIHNhdmVSZW1vdGVRdWVzdGlvbnNDb25maWcgfSBmcm9tIFwiLi4vLi4vcmVtb3RlLXF1ZXN0aW9ucy9yZW1vdGUtY29tbWFuZC50c1wiO1xuaW1wb3J0IHsgU2xhY2tBZGFwdGVyIH0gZnJvbSBcIi4uLy4uL3JlbW90ZS1xdWVzdGlvbnMvc2xhY2stYWRhcHRlci50c1wiO1xuaW1wb3J0IHsgc2FuaXRpemVFcnJvciB9IGZyb20gXCIuLi8uLi9zaGFyZWQvc2FuaXRpemUudHNcIjtcblxuZnVuY3Rpb24ganNvblJlc3BvbnNlKGJvZHk6IHVua25vd24pOiBSZXNwb25zZSB7XG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgc3RhdHVzOiAyMDAsXG4gICAgYXN5bmMganNvbigpIHsgcmV0dXJuIGJvZHk7IH0sXG4gICAgYXN5bmMgdGV4dCgpIHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGJvZHkpOyB9LFxuICB9IGFzIFJlc3BvbnNlO1xufVxuXG5hc3luYyBmdW5jdGlvbiB3aXRoVGVtcEdzZEhvbWU8VD4oZm46IChob21lOiBzdHJpbmcpID0+IFQgfCBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XG4gIGNvbnN0IG9sZEhvbWUgPSBwcm9jZXNzLmVudi5HU0RfSE9NRTtcbiAgY29uc3QgaG9tZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXJlbW90ZS1ob21lLVwiKSk7XG4gIHRyeSB7XG4gICAgcHJvY2Vzcy5lbnYuR1NEX0hPTUUgPSBob21lO1xuICAgIHJldHVybiBhd2FpdCBmbihob21lKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAob2xkSG9tZSA9PT0gdW5kZWZpbmVkKSBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX0hPTUU7XG4gICAgZWxzZSBwcm9jZXNzLmVudi5HU0RfSE9NRSA9IG9sZEhvbWU7XG4gICAgcm1TeW5jKGhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufVxuXG50ZXN0KFwicGFyc2VTbGFja1JlcGx5IGhhbmRsZXMgc2luZ2xlLW51bWJlciBzaW5nbGUtcXVlc3Rpb24gYW5zd2Vyc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHBhcnNlU2xhY2tSZXBseShcIjJcIiwgW3tcbiAgICBpZDogXCJjaG9pY2VcIixcbiAgICBoZWFkZXI6IFwiQ2hvaWNlXCIsXG4gICAgcXVlc3Rpb246IFwiUGljayBvbmVcIixcbiAgICBhbGxvd011bHRpcGxlOiBmYWxzZSxcbiAgICBvcHRpb25zOiBbXG4gICAgICB7IGxhYmVsOiBcIkFscGhhXCIsIGRlc2NyaXB0aW9uOiBcIkFcIiB9LFxuICAgICAgeyBsYWJlbDogXCJCZXRhXCIsIGRlc2NyaXB0aW9uOiBcIkJcIiB9LFxuICAgIF0sXG4gIH1dKTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwgeyBhbnN3ZXJzOiB7IGNob2ljZTogeyBhbnN3ZXJzOiBbXCJCZXRhXCJdIH0gfSB9KTtcbn0pO1xuXG50ZXN0KFwicGFyc2VTbGFja1JlcGx5IGhhbmRsZXMgbXVsdGlsaW5lIG11bHRpLXF1ZXN0aW9uIGFuc3dlcnNcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBwYXJzZVNsYWNrUmVwbHkoXCIxXFxuY3VzdG9tIG5vdGVcIiwgW1xuICAgIHtcbiAgICAgIGlkOiBcImZpcnN0XCIsXG4gICAgICBoZWFkZXI6IFwiRmlyc3RcIixcbiAgICAgIHF1ZXN0aW9uOiBcIlBpY2sgb25lXCIsXG4gICAgICBhbGxvd011bHRpcGxlOiBmYWxzZSxcbiAgICAgIG9wdGlvbnM6IFtcbiAgICAgICAgeyBsYWJlbDogXCJBbHBoYVwiLCBkZXNjcmlwdGlvbjogXCJBXCIgfSxcbiAgICAgICAgeyBsYWJlbDogXCJCZXRhXCIsIGRlc2NyaXB0aW9uOiBcIkJcIiB9LFxuICAgICAgXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGlkOiBcInNlY29uZFwiLFxuICAgICAgaGVhZGVyOiBcIlNlY29uZFwiLFxuICAgICAgcXVlc3Rpb246IFwiRXhwbGFpblwiLFxuICAgICAgYWxsb3dNdWx0aXBsZTogZmFsc2UsXG4gICAgICBvcHRpb25zOiBbXG4gICAgICAgIHsgbGFiZWw6IFwiR2FtbWFcIiwgZGVzY3JpcHRpb246IFwiR1wiIH0sXG4gICAgICAgIHsgbGFiZWw6IFwiRGVsdGFcIiwgZGVzY3JpcHRpb246IFwiRFwiIH0sXG4gICAgICBdLFxuICAgIH0sXG4gIF0pO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LCB7XG4gICAgYW5zd2Vyczoge1xuICAgICAgZmlyc3Q6IHsgYW5zd2VyczogW1wiQWxwaGFcIl0gfSxcbiAgICAgIHNlY29uZDogeyBhbnN3ZXJzOiBbXSwgdXNlcl9ub3RlOiBcImN1c3RvbSBub3RlXCIgfSxcbiAgICB9LFxuICB9KTtcbn0pO1xuXG50ZXN0KFwicGFyc2VEaXNjb3JkUmVzcG9uc2UgaGFuZGxlcyBzaW5nbGUtcXVlc3Rpb24gcmVhY3Rpb25zXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gcGFyc2VEaXNjb3JkUmVzcG9uc2UoW3sgZW1vamk6IFwiMlx1RkUwRlx1MjBFM1wiLCBjb3VudDogMSB9XSwgbnVsbCwgW3tcbiAgICBpZDogXCJjaG9pY2VcIixcbiAgICBoZWFkZXI6IFwiQ2hvaWNlXCIsXG4gICAgcXVlc3Rpb246IFwiUGljayBvbmVcIixcbiAgICBhbGxvd011bHRpcGxlOiBmYWxzZSxcbiAgICBvcHRpb25zOiBbXG4gICAgICB7IGxhYmVsOiBcIkFscGhhXCIsIGRlc2NyaXB0aW9uOiBcIkFcIiB9LFxuICAgICAgeyBsYWJlbDogXCJCZXRhXCIsIGRlc2NyaXB0aW9uOiBcIkJcIiB9LFxuICAgIF0sXG4gIH1dKTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwgeyBhbnN3ZXJzOiB7IGNob2ljZTogeyBhbnN3ZXJzOiBbXCJCZXRhXCJdIH0gfSB9KTtcbn0pO1xuXG50ZXN0KFwicGFyc2VEaXNjb3JkUmVzcG9uc2UgcmVqZWN0cyBtdWx0aS1xdWVzdGlvbiByZWFjdGlvbiBwYXJzaW5nXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gcGFyc2VEaXNjb3JkUmVzcG9uc2UoW3sgZW1vamk6IFwiMVx1RkUwRlx1MjBFM1wiLCBjb3VudDogMSB9XSwgbnVsbCwgW1xuICAgIHtcbiAgICAgIGlkOiBcImZpcnN0XCIsXG4gICAgICBoZWFkZXI6IFwiRmlyc3RcIixcbiAgICAgIHF1ZXN0aW9uOiBcIlBpY2sgb25lXCIsXG4gICAgICBhbGxvd011bHRpcGxlOiBmYWxzZSxcbiAgICAgIG9wdGlvbnM6IFt7IGxhYmVsOiBcIkFscGhhXCIsIGRlc2NyaXB0aW9uOiBcIkFcIiB9XSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGlkOiBcInNlY29uZFwiLFxuICAgICAgaGVhZGVyOiBcIlNlY29uZFwiLFxuICAgICAgcXVlc3Rpb246IFwiUGljayBvbmVcIixcbiAgICAgIGFsbG93TXVsdGlwbGU6IGZhbHNlLFxuICAgICAgb3B0aW9uczogW3sgbGFiZWw6IFwiQmV0YVwiLCBkZXNjcmlwdGlvbjogXCJCXCIgfV0sXG4gICAgfSxcbiAgXSk7XG5cbiAgYXNzZXJ0Lm1hdGNoKFN0cmluZyhyZXN1bHQuYW5zd2Vycy5maXJzdC51c2VyX25vdGUpLCAvc2luZ2xlLXF1ZXN0aW9uIHByb21wdHMvaSk7XG4gIGFzc2VydC5tYXRjaChTdHJpbmcocmVzdWx0LmFuc3dlcnMuc2Vjb25kLnVzZXJfbm90ZSksIC9zaW5nbGUtcXVlc3Rpb24gcHJvbXB0cy9pKTtcbn0pO1xuXG50ZXN0KFwicGFyc2VTbGFja1JlYWN0aW9uUmVzcG9uc2UgaGFuZGxlcyBzaW5nbGUtcXVlc3Rpb24gcmVhY3Rpb25zXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gcGFyc2VTbGFja1JlYWN0aW9uUmVzcG9uc2UoW1widHdvXCJdLCBbe1xuICAgIGlkOiBcImNob2ljZVwiLFxuICAgIGhlYWRlcjogXCJDaG9pY2VcIixcbiAgICBxdWVzdGlvbjogXCJQaWNrIG9uZVwiLFxuICAgIGFsbG93TXVsdGlwbGU6IGZhbHNlLFxuICAgIG9wdGlvbnM6IFtcbiAgICAgIHsgbGFiZWw6IFwiQWxwaGFcIiwgZGVzY3JpcHRpb246IFwiQVwiIH0sXG4gICAgICB7IGxhYmVsOiBcIkJldGFcIiwgZGVzY3JpcHRpb246IFwiQlwiIH0sXG4gICAgXSxcbiAgfV0pO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LCB7IGFuc3dlcnM6IHsgY2hvaWNlOiB7IGFuc3dlcnM6IFtcIkJldGFcIl0gfSB9IH0pO1xufSk7XG5cbnRlc3QoXCJwYXJzZVNsYWNrUmVwbHkgdHJ1bmNhdGVzIHVzZXJfbm90ZSBsb25nZXIgdGhhbiA1MDAgY2hhcnNcIiwgKCkgPT4ge1xuICBjb25zdCBsb25nVGV4dCA9IFwieFwiLnJlcGVhdCg2MDApO1xuICBjb25zdCByZXN1bHQgPSBwYXJzZVNsYWNrUmVwbHkobG9uZ1RleHQsIFt7XG4gICAgaWQ6IFwicTFcIixcbiAgICBoZWFkZXI6IFwiUTFcIixcbiAgICBxdWVzdGlvbjogXCJQaWNrXCIsXG4gICAgYWxsb3dNdWx0aXBsZTogZmFsc2UsXG4gICAgb3B0aW9uczogW3sgbGFiZWw6IFwiQVwiLCBkZXNjcmlwdGlvbjogXCJhXCIgfV0sXG4gIH1dKTtcblxuICBjb25zdCBub3RlID0gcmVzdWx0LmFuc3dlcnMucTEudXNlcl9ub3RlITtcbiAgYXNzZXJ0Lm9rKG5vdGUubGVuZ3RoIDw9IDUwMiwgYG5vdGUgc2hvdWxkIGJlIHRydW5jYXRlZCwgZ290ICR7bm90ZS5sZW5ndGh9IGNoYXJzYCk7XG4gIGFzc2VydC5vayhub3RlLmVuZHNXaXRoKFwiXHUyMDI2XCIpLCBcInRydW5jYXRlZCBub3RlIHNob3VsZCBlbmQgd2l0aCBlbGxpcHNpc1wiKTtcbn0pO1xuXG50ZXN0KFwiaXNWYWxpZENoYW5uZWxJZCByZWplY3RzIGludmFsaWQgU2xhY2sgY2hhbm5lbCBJRHNcIiwgKCkgPT4ge1xuICAvLyBUb28gc2hvcnRcbiAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRDaGFubmVsSWQoXCJzbGFja1wiLCBcIkMxMjNcIiksIGZhbHNlKTtcbiAgLy8gQ29udGFpbnMgaW52YWxpZCBjaGFycyAoVVJMIGluamVjdGlvbilcbiAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRDaGFubmVsSWQoXCJzbGFja1wiLCBcImh0dHBzOi8vZXZpbC5jb21cIiksIGZhbHNlKTtcbiAgLy8gTG93ZXJjYXNlXG4gIGFzc2VydC5lcXVhbChpc1ZhbGlkQ2hhbm5lbElkKFwic2xhY2tcIiwgXCJjMTIzNDU2NzhcIiksIGZhbHNlKTtcbiAgLy8gVG9vIGxvbmdcbiAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRDaGFubmVsSWQoXCJzbGFja1wiLCBcIkMxMjM0NTY3ODkwQUJcIiksIGZhbHNlKTtcbiAgLy8gVmFsaWQ6IDktMTIgdXBwZXJjYXNlIGFscGhhbnVtZXJpY1xuICBhc3NlcnQuZXF1YWwoaXNWYWxpZENoYW5uZWxJZChcInNsYWNrXCIsIFwiQzEyMzQ1Njc4XCIpLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRDaGFubmVsSWQoXCJzbGFja1wiLCBcIkMxMjM0NTY3OEFCXCIpLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRDaGFubmVsSWQoXCJzbGFja1wiLCBcIkMxMjM0NTY3ODkwQVwiKSwgdHJ1ZSk7XG59KTtcblxudGVzdChcImlzVmFsaWRDaGFubmVsSWQgcmVqZWN0cyBpbnZhbGlkIERpc2NvcmQgY2hhbm5lbCBJRHNcIiwgKCkgPT4ge1xuICAvLyBUb28gc2hvcnRcbiAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRDaGFubmVsSWQoXCJkaXNjb3JkXCIsIFwiMTIzNDVcIiksIGZhbHNlKTtcbiAgLy8gQ29udGFpbnMgbGV0dGVycyAobm90IGEgc25vd2ZsYWtlKVxuICBhc3NlcnQuZXF1YWwoaXNWYWxpZENoYW5uZWxJZChcImRpc2NvcmRcIiwgXCJhYmMxMjM0NTY3ODkwMTIzNFwiKSwgZmFsc2UpO1xuICAvLyBVUkwgaW5qZWN0aW9uXG4gIGFzc2VydC5lcXVhbChpc1ZhbGlkQ2hhbm5lbElkKFwiZGlzY29yZFwiLCBcImh0dHBzOi8vZXZpbC5jb21cIiksIGZhbHNlKTtcbiAgLy8gVG9vIGxvbmcgKDIxIGRpZ2l0cylcbiAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRDaGFubmVsSWQoXCJkaXNjb3JkXCIsIFwiMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxXCIpLCBmYWxzZSk7XG4gIC8vIFZhbGlkOiAxNy0yMCBkaWdpdCBzbm93Zmxha2VcbiAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRDaGFubmVsSWQoXCJkaXNjb3JkXCIsIFwiMTIzNDU2Nzg5MDEyMzQ1NjdcIiksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoaXNWYWxpZENoYW5uZWxJZChcImRpc2NvcmRcIiwgXCIxMTIzNDU2Nzg5MDEyMzQ1Njc4OVwiKSwgdHJ1ZSk7XG59KTtcblxudGVzdChcInNhbml0aXplRXJyb3Igc3RyaXBzIFNsYWNrIHRva2VuIHBhdHRlcm5zIGZyb20gZXJyb3IgbWVzc2FnZXNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoXG4gICAgc2FuaXRpemVFcnJvcihcIkF1dGggZmFpbGVkOiB4b3hiLTEyMzQtNTY3OC1hYmNkZWZcIiksXG4gICAgXCJBdXRoIGZhaWxlZDogW1JFREFDVEVEXVwiLFxuICApO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgc2FuaXRpemVFcnJvcihcIkJhZCB0b2tlbiB4b3hwLWFiYy1kZWYtZ2hpIGluIHJlcXVlc3RcIiksXG4gICAgXCJCYWQgdG9rZW4gW1JFREFDVEVEXSBpbiByZXF1ZXN0XCIsXG4gICk7XG59KTtcblxudGVzdChcInNhbml0aXplRXJyb3Igc3RyaXBzIGxvbmcgb3BhcXVlIHNlY3JldHNcIiwgKCkgPT4ge1xuICBjb25zdCBmYWtlRGlzY29yZFRva2VuID0gXCJNVEl6TkRVMk56ZzVNREV5TXpRMU5qYzRPUS5HMXgyeTMuYWJjZGVmZ2hpamtsbW5vcFwiO1xuICBhc3NlcnQub2soIXNhbml0aXplRXJyb3IoYFRva2VuOiAke2Zha2VEaXNjb3JkVG9rZW59YCkuaW5jbHVkZXMoZmFrZURpc2NvcmRUb2tlbikpO1xufSk7XG5cbnRlc3QoXCJzYW5pdGl6ZUVycm9yIHByZXNlcnZlcyBzaG9ydCBzYWZlIG1lc3NhZ2VzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKHNhbml0aXplRXJyb3IoXCJIVFRQIDQwMTogVW5hdXRob3JpemVkXCIpLCBcIkhUVFAgNDAxOiBVbmF1dGhvcml6ZWRcIik7XG4gIGFzc2VydC5lcXVhbChzYW5pdGl6ZUVycm9yKFwiQ29ubmVjdGlvbiByZWZ1c2VkXCIpLCBcIkNvbm5lY3Rpb24gcmVmdXNlZFwiKTtcbn0pO1xuXG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gRGlzY29yZCBQYXJpdHkgVGVzdHNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG50ZXN0KFwiZm9ybWF0Rm9yRGlzY29yZCBpbmNsdWRlcyBjb250ZXh0IHNvdXJjZSBpbiBmb290ZXIgd2hlbiBwcmVzZW50XCIsICgpID0+IHtcbiAgY29uc3QgcHJvbXB0ID0ge1xuICAgIGlkOiBcInRlc3QtMVwiLFxuICAgIGNoYW5uZWw6IFwiZGlzY29yZFwiIGFzIGNvbnN0LFxuICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICB0aW1lb3V0QXQ6IERhdGUubm93KCkgKyA2MDAwMCxcbiAgICBwb2xsSW50ZXJ2YWxNczogNTAwMCxcbiAgICBjb250ZXh0OiB7IHNvdXJjZTogXCJhdXRvLW1vZGUtZGlzcGF0Y2hcIiB9LFxuICAgIHF1ZXN0aW9uczogW3tcbiAgICAgIGlkOiBcInExXCIsXG4gICAgICBoZWFkZXI6IFwiQ29uZmlybVwiLFxuICAgICAgcXVlc3Rpb246IFwiUHJvY2VlZD9cIixcbiAgICAgIG9wdGlvbnM6IFtcbiAgICAgICAgeyBsYWJlbDogXCJZZXNcIiwgZGVzY3JpcHRpb246IFwiQ29udGludWVcIiB9LFxuICAgICAgICB7IGxhYmVsOiBcIk5vXCIsIGRlc2NyaXB0aW9uOiBcIlN0b3BcIiB9LFxuICAgICAgXSxcbiAgICAgIGFsbG93TXVsdGlwbGU6IGZhbHNlLFxuICAgIH1dLFxuICB9O1xuXG4gIGNvbnN0IHsgZW1iZWRzIH0gPSBmb3JtYXRGb3JEaXNjb3JkKHByb21wdCk7XG4gIGFzc2VydC5lcXVhbChlbWJlZHMubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0Lm9rKGVtYmVkc1swXS5mb290ZXI/LnRleHQuaW5jbHVkZXMoXCJhdXRvLW1vZGUtZGlzcGF0Y2hcIiksIFwiZm9vdGVyIHNob3VsZCBpbmNsdWRlIGNvbnRleHQgc291cmNlXCIpO1xufSk7XG5cbnRlc3QoXCJmb3JtYXRGb3JTbGFjayBpbmNsdWRlcyBjb250ZXh0IHNvdXJjZSB3aGVuIHByZXNlbnRcIiwgKCkgPT4ge1xuICBjb25zdCBibG9ja3MgPSBmb3JtYXRGb3JTbGFjayh7XG4gICAgaWQ6IFwic2xhY2stMVwiLFxuICAgIGNoYW5uZWw6IFwic2xhY2tcIixcbiAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgdGltZW91dEF0OiBEYXRlLm5vdygpICsgNjAwMDAsXG4gICAgcG9sbEludGVydmFsTXM6IDUwMDAsXG4gICAgY29udGV4dDogeyBzb3VyY2U6IFwiYXNrX3VzZXJfcXVlc3Rpb25zXCIgfSxcbiAgICBxdWVzdGlvbnM6IFt7XG4gICAgICBpZDogXCJxMVwiLFxuICAgICAgaGVhZGVyOiBcIkNvbmZpcm1cIixcbiAgICAgIHF1ZXN0aW9uOiBcIlByb2NlZWQ/XCIsXG4gICAgICBvcHRpb25zOiBbXG4gICAgICAgIHsgbGFiZWw6IFwiWWVzXCIsIGRlc2NyaXB0aW9uOiBcIkNvbnRpbnVlXCIgfSxcbiAgICAgICAgeyBsYWJlbDogXCJOb1wiLCBkZXNjcmlwdGlvbjogXCJTdG9wXCIgfSxcbiAgICAgIF0sXG4gICAgICBhbGxvd011bHRpcGxlOiBmYWxzZSxcbiAgICB9XSxcbiAgfSk7XG5cbiAgY29uc3Qgc291cmNlQmxvY2sgPSBibG9ja3MuZmluZCgoYmxvY2spID0+IGJsb2NrLnR5cGUgPT09IFwiY29udGV4dFwiICYmIGJsb2NrLmVsZW1lbnRzPy5zb21lKChlbCkgPT4gZWwudGV4dC5pbmNsdWRlcyhcIlNvdXJjZTpcIikpKTtcbiAgYXNzZXJ0Lm9rKHNvdXJjZUJsb2NrLCBcIlNsYWNrIGJsb2NrcyBzaG91bGQgaW5jbHVkZSBhIGNvbnRleHQgc291cmNlIGJsb2NrXCIpO1xufSk7XG5cbnRlc3QoXCJmb3JtYXRGb3JTbGFjayBtdWx0aS1xdWVzdGlvbiBwcm9tcHRzIGV4cGxhaW4gc2VtaWNvbG9uIGFuZCBuZXdsaW5lIHJlcGx5IGZvcm1hdFwiLCAoKSA9PiB7XG4gIGNvbnN0IGJsb2NrcyA9IGZvcm1hdEZvclNsYWNrKHtcbiAgICBpZDogXCJzbGFjay0yXCIsXG4gICAgY2hhbm5lbDogXCJzbGFja1wiLFxuICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICB0aW1lb3V0QXQ6IERhdGUubm93KCkgKyA2MDAwMCxcbiAgICBwb2xsSW50ZXJ2YWxNczogNTAwMCxcbiAgICBxdWVzdGlvbnM6IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwicTFcIixcbiAgICAgICAgaGVhZGVyOiBcIkZpcnN0XCIsXG4gICAgICAgIHF1ZXN0aW9uOiBcIlBpY2sgb25lXCIsXG4gICAgICAgIG9wdGlvbnM6IFtcbiAgICAgICAgICB7IGxhYmVsOiBcIkFscGhhXCIsIGRlc2NyaXB0aW9uOiBcIkFcIiB9LFxuICAgICAgICAgIHsgbGFiZWw6IFwiQmV0YVwiLCBkZXNjcmlwdGlvbjogXCJCXCIgfSxcbiAgICAgICAgXSxcbiAgICAgICAgYWxsb3dNdWx0aXBsZTogZmFsc2UsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogXCJxMlwiLFxuICAgICAgICBoZWFkZXI6IFwiU2Vjb25kXCIsXG4gICAgICAgIHF1ZXN0aW9uOiBcIkV4cGxhaW5cIixcbiAgICAgICAgb3B0aW9uczogW1xuICAgICAgICAgIHsgbGFiZWw6IFwiR2FtbWFcIiwgZGVzY3JpcHRpb246IFwiR1wiIH0sXG4gICAgICAgICAgeyBsYWJlbDogXCJEZWx0YVwiLCBkZXNjcmlwdGlvbjogXCJEXCIgfSxcbiAgICAgICAgXSxcbiAgICAgICAgYWxsb3dNdWx0aXBsZTogZmFsc2UsXG4gICAgICB9LFxuICAgIF0sXG4gIH0pO1xuXG4gIGNvbnN0IGluc3RydWN0aW9uQmxvY2sgPSBibG9ja3MuZmluZCgoYmxvY2spID0+IGJsb2NrLnR5cGUgPT09IFwiY29udGV4dFwiICYmIGJsb2NrLmVsZW1lbnRzPy5zb21lKChlbCkgPT4gZWwudGV4dC5pbmNsdWRlcyhcIm9uZSBsaW5lIHBlciBxdWVzdGlvblwiKSkpO1xuICBhc3NlcnQub2soaW5zdHJ1Y3Rpb25CbG9jaywgXCJTbGFjayBtdWx0aS1xdWVzdGlvbiBwcm9tcHRzIHNob3VsZCBleHBsYWluIG9uZS1saW5lIG9yIHNlbWljb2xvbiByZXBseSBmb3JtYXRcIik7XG59KTtcblxudGVzdChcImZvcm1hdEZvckRpc2NvcmQgb21pdHMgc291cmNlIGZyb20gZm9vdGVyIHdoZW4gY29udGV4dCBpcyBhYnNlbnRcIiwgKCkgPT4ge1xuICBjb25zdCBwcm9tcHQgPSB7XG4gICAgaWQ6IFwidGVzdC0yXCIsXG4gICAgY2hhbm5lbDogXCJkaXNjb3JkXCIgYXMgY29uc3QsXG4gICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgIHRpbWVvdXRBdDogRGF0ZS5ub3coKSArIDYwMDAwLFxuICAgIHBvbGxJbnRlcnZhbE1zOiA1MDAwLFxuICAgIHF1ZXN0aW9uczogW3tcbiAgICAgIGlkOiBcInExXCIsXG4gICAgICBoZWFkZXI6IFwiQ2hvaWNlXCIsXG4gICAgICBxdWVzdGlvbjogXCJQaWNrIG9uZVwiLFxuICAgICAgb3B0aW9uczogW1xuICAgICAgICB7IGxhYmVsOiBcIkFcIiwgZGVzY3JpcHRpb246IFwiQWxwaGFcIiB9LFxuICAgICAgICB7IGxhYmVsOiBcIkJcIiwgZGVzY3JpcHRpb246IFwiQmV0YVwiIH0sXG4gICAgICBdLFxuICAgICAgYWxsb3dNdWx0aXBsZTogZmFsc2UsXG4gICAgfV0sXG4gIH07XG5cbiAgY29uc3QgeyBlbWJlZHMgfSA9IGZvcm1hdEZvckRpc2NvcmQocHJvbXB0KTtcbiAgYXNzZXJ0Lm9rKCFlbWJlZHNbMF0uZm9vdGVyPy50ZXh0LmluY2x1ZGVzKFwiU291cmNlOlwiKSwgXCJmb290ZXIgc2hvdWxkIG5vdCBpbmNsdWRlIFNvdXJjZSB3aGVuIGNvbnRleHQgYWJzZW50XCIpO1xufSk7XG5cbnRlc3QoXCJmb3JtYXRGb3JEaXNjb3JkIG11bHRpLXF1ZXN0aW9uIGZvb3RlciBpbmNsdWRlcyBxdWVzdGlvbiBwb3NpdGlvblwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHtcbiAgICBpZDogXCJ0ZXN0LTNcIixcbiAgICBjaGFubmVsOiBcImRpc2NvcmRcIiBhcyBjb25zdCxcbiAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgdGltZW91dEF0OiBEYXRlLm5vdygpICsgNjAwMDAsXG4gICAgcG9sbEludGVydmFsTXM6IDUwMDAsXG4gICAgcXVlc3Rpb25zOiBbXG4gICAgICB7XG4gICAgICAgIGlkOiBcInExXCIsXG4gICAgICAgIGhlYWRlcjogXCJGaXJzdFwiLFxuICAgICAgICBxdWVzdGlvbjogXCJQaWNrXCIsXG4gICAgICAgIG9wdGlvbnM6IFt7IGxhYmVsOiBcIkFcIiwgZGVzY3JpcHRpb246IFwiYVwiIH1dLFxuICAgICAgICBhbGxvd011bHRpcGxlOiBmYWxzZSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiBcInEyXCIsXG4gICAgICAgIGhlYWRlcjogXCJTZWNvbmRcIixcbiAgICAgICAgcXVlc3Rpb246IFwiUGlja1wiLFxuICAgICAgICBvcHRpb25zOiBbeyBsYWJlbDogXCJCXCIsIGRlc2NyaXB0aW9uOiBcImJcIiB9XSxcbiAgICAgICAgYWxsb3dNdWx0aXBsZTogZmFsc2UsXG4gICAgICB9LFxuICAgIF0sXG4gIH07XG5cbiAgY29uc3QgeyBlbWJlZHMgfSA9IGZvcm1hdEZvckRpc2NvcmQocHJvbXB0KTtcbiAgYXNzZXJ0LmVxdWFsKGVtYmVkcy5sZW5ndGgsIDIpO1xuICBhc3NlcnQub2soZW1iZWRzWzBdLmZvb3Rlcj8udGV4dC5pbmNsdWRlcyhcIjEvMlwiKSwgXCJmaXJzdCBlbWJlZCBmb290ZXIgc2hvdWxkIHNob3cgMS8yXCIpO1xuICBhc3NlcnQub2soZW1iZWRzWzFdLmZvb3Rlcj8udGV4dC5pbmNsdWRlcyhcIjIvMlwiKSwgXCJzZWNvbmQgZW1iZWQgZm9vdGVyIHNob3VsZCBzaG93IDIvMlwiKTtcbn0pO1xuXG50ZXN0KFwiZm9ybWF0Rm9yRGlzY29yZCBzaW5nbGUtcXVlc3Rpb24gZ2VuZXJhdGVzIHJlYWN0aW9uIGVtb2ppc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHtcbiAgICBpZDogXCJ0ZXN0LTRcIixcbiAgICBjaGFubmVsOiBcImRpc2NvcmRcIiBhcyBjb25zdCxcbiAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgdGltZW91dEF0OiBEYXRlLm5vdygpICsgNjAwMDAsXG4gICAgcG9sbEludGVydmFsTXM6IDUwMDAsXG4gICAgcXVlc3Rpb25zOiBbe1xuICAgICAgaWQ6IFwicTFcIixcbiAgICAgIGhlYWRlcjogXCJQaWNrXCIsXG4gICAgICBxdWVzdGlvbjogXCJDaG9vc2VcIixcbiAgICAgIG9wdGlvbnM6IFtcbiAgICAgICAgeyBsYWJlbDogXCJBXCIsIGRlc2NyaXB0aW9uOiBcImFcIiB9LFxuICAgICAgICB7IGxhYmVsOiBcIkJcIiwgZGVzY3JpcHRpb246IFwiYlwiIH0sXG4gICAgICAgIHsgbGFiZWw6IFwiQ1wiLCBkZXNjcmlwdGlvbjogXCJjXCIgfSxcbiAgICAgIF0sXG4gICAgICBhbGxvd011bHRpcGxlOiBmYWxzZSxcbiAgICB9XSxcbiAgfTtcblxuICBjb25zdCB7IHJlYWN0aW9uRW1vamlzIH0gPSBmb3JtYXRGb3JEaXNjb3JkKHByb21wdCk7XG4gIGFzc2VydC5lcXVhbChyZWFjdGlvbkVtb2ppcy5sZW5ndGgsIDMsIFwic2hvdWxkIGdlbmVyYXRlIDMgcmVhY3Rpb24gZW1vamlzIGZvciAzIG9wdGlvbnNcIik7XG4gIGFzc2VydC5lcXVhbChyZWFjdGlvbkVtb2ppc1swXSwgXCIxXHVGRTBGXHUyMEUzXCIpO1xuICBhc3NlcnQuZXF1YWwocmVhY3Rpb25FbW9qaXNbMV0sIFwiMlx1RkUwRlx1MjBFM1wiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlYWN0aW9uRW1vamlzWzJdLCBcIjNcdUZFMEZcdTIwRTNcIik7XG59KTtcblxudGVzdChcImZvcm1hdEZvckRpc2NvcmQgbXVsdGktcXVlc3Rpb24gZ2VuZXJhdGVzIG5vIHJlYWN0aW9uIGVtb2ppc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHtcbiAgICBpZDogXCJ0ZXN0LTVcIixcbiAgICBjaGFubmVsOiBcImRpc2NvcmRcIiBhcyBjb25zdCxcbiAgICBjcmVhdGVkQXQ6IERhdGUubm93KCksXG4gICAgdGltZW91dEF0OiBEYXRlLm5vdygpICsgNjAwMDAsXG4gICAgcG9sbEludGVydmFsTXM6IDUwMDAsXG4gICAgcXVlc3Rpb25zOiBbXG4gICAgICB7XG4gICAgICAgIGlkOiBcInExXCIsXG4gICAgICAgIGhlYWRlcjogXCJGaXJzdFwiLFxuICAgICAgICBxdWVzdGlvbjogXCJQaWNrXCIsXG4gICAgICAgIG9wdGlvbnM6IFt7IGxhYmVsOiBcIkFcIiwgZGVzY3JpcHRpb246IFwiYVwiIH1dLFxuICAgICAgICBhbGxvd011bHRpcGxlOiBmYWxzZSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiBcInEyXCIsXG4gICAgICAgIGhlYWRlcjogXCJTZWNvbmRcIixcbiAgICAgICAgcXVlc3Rpb246IFwiUGlja1wiLFxuICAgICAgICBvcHRpb25zOiBbeyBsYWJlbDogXCJCXCIsIGRlc2NyaXB0aW9uOiBcImJcIiB9XSxcbiAgICAgICAgYWxsb3dNdWx0aXBsZTogZmFsc2UsXG4gICAgICB9LFxuICAgIF0sXG4gIH07XG5cbiAgY29uc3QgeyByZWFjdGlvbkVtb2ppcyB9ID0gZm9ybWF0Rm9yRGlzY29yZChwcm9tcHQpO1xuICBhc3NlcnQuZXF1YWwocmVhY3Rpb25FbW9qaXMubGVuZ3RoLCAwLCBcIm11bHRpLXF1ZXN0aW9uIHNob3VsZCBub3QgZ2VuZXJhdGUgcmVhY3Rpb24gZW1vamlzXCIpO1xufSk7XG5cbnRlc3QoXCJwYXJzZURpc2NvcmRSZXNwb25zZSBoYW5kbGVzIG11bHRpLXF1ZXN0aW9uIHRleHQgcmVwbHkgdmlhIHNlbWljb2xvbnNcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBwYXJzZURpc2NvcmRSZXNwb25zZShbXSwgXCIxOzJcIiwgW1xuICAgIHtcbiAgICAgIGlkOiBcImZpcnN0XCIsXG4gICAgICBoZWFkZXI6IFwiRmlyc3RcIixcbiAgICAgIHF1ZXN0aW9uOiBcIlBpY2sgb25lXCIsXG4gICAgICBhbGxvd011bHRpcGxlOiBmYWxzZSxcbiAgICAgIG9wdGlvbnM6IFtcbiAgICAgICAgeyBsYWJlbDogXCJBbHBoYVwiLCBkZXNjcmlwdGlvbjogXCJBXCIgfSxcbiAgICAgICAgeyBsYWJlbDogXCJCZXRhXCIsIGRlc2NyaXB0aW9uOiBcIkJcIiB9LFxuICAgICAgXSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGlkOiBcInNlY29uZFwiLFxuICAgICAgaGVhZGVyOiBcIlNlY29uZFwiLFxuICAgICAgcXVlc3Rpb246IFwiUGljayBvbmVcIixcbiAgICAgIGFsbG93TXVsdGlwbGU6IGZhbHNlLFxuICAgICAgb3B0aW9uczogW1xuICAgICAgICB7IGxhYmVsOiBcIkdhbW1hXCIsIGRlc2NyaXB0aW9uOiBcIkdcIiB9LFxuICAgICAgICB7IGxhYmVsOiBcIkRlbHRhXCIsIGRlc2NyaXB0aW9uOiBcIkRcIiB9LFxuICAgICAgXSxcbiAgICB9LFxuICBdKTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdC5hbnN3ZXJzLmZpcnN0LmFuc3dlcnMsIFtcIkFscGhhXCJdKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQuYW5zd2Vycy5zZWNvbmQuYW5zd2VycywgW1wiRGVsdGFcIl0pO1xufSk7XG5cbnRlc3QoXCJwYXJzZURpc2NvcmRSZXNwb25zZSBoYW5kbGVzIG11bHRpcGxlIHJlYWN0aW9ucyBmb3IgYWxsb3dNdWx0aXBsZSBxdWVzdGlvblwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHBhcnNlRGlzY29yZFJlc3BvbnNlKFxuICAgIFt7IGVtb2ppOiBcIjFcdUZFMEZcdTIwRTNcIiwgY291bnQ6IDEgfSwgeyBlbW9qaTogXCIzXHVGRTBGXHUyMEUzXCIsIGNvdW50OiAxIH1dLFxuICAgIG51bGwsXG4gICAgW3tcbiAgICAgIGlkOiBcImNob2ljZVwiLFxuICAgICAgaGVhZGVyOiBcIkNob2ljZVwiLFxuICAgICAgcXVlc3Rpb246IFwiUGljayBhbnlcIixcbiAgICAgIGFsbG93TXVsdGlwbGU6IHRydWUsXG4gICAgICBvcHRpb25zOiBbXG4gICAgICAgIHsgbGFiZWw6IFwiQWxwaGFcIiwgZGVzY3JpcHRpb246IFwiQVwiIH0sXG4gICAgICAgIHsgbGFiZWw6IFwiQmV0YVwiLCBkZXNjcmlwdGlvbjogXCJCXCIgfSxcbiAgICAgICAgeyBsYWJlbDogXCJHYW1tYVwiLCBkZXNjcmlwdGlvbjogXCJHXCIgfSxcbiAgICAgIF0sXG4gICAgfV0sXG4gICk7XG5cbiAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQuYW5zd2Vycy5jaG9pY2UuYW5zd2VycywgW1wiQWxwaGFcIiwgXCJHYW1tYVwiXSk7XG59KTtcblxudGVzdChcIkRpc2NvcmRBZGFwdGVyIHZhbGlkYXRlcyBndWlsZCwgc2VuZHMgcHJvbXB0IFVSTCwgYW5kIGFja25vd2xlZGdlcyB3aXRoIGNoZWNrbWFya1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGNhbGxzOiBBcnJheTx7IHVybDogc3RyaW5nOyBtZXRob2Q6IHN0cmluZyB9PiA9IFtdO1xuICBjb25zdCBmZXRjaE1vY2sgPSBtb2NrLm1ldGhvZChnbG9iYWxUaGlzLCBcImZldGNoXCIsIGFzeW5jICh1cmw6IHN0cmluZyB8IFVSTCwgaW5pdD86IFJlcXVlc3RJbml0KSA9PiB7XG4gICAgY29uc3QgaHJlZiA9IFN0cmluZyh1cmwpO1xuICAgIGNhbGxzLnB1c2goeyB1cmw6IGhyZWYsIG1ldGhvZDogU3RyaW5nKGluaXQ/Lm1ldGhvZCA/PyBcIkdFVFwiKSB9KTtcbiAgICBpZiAoaHJlZi5lbmRzV2l0aChcIi91c2Vycy9AbWVcIikpIHJldHVybiBqc29uUmVzcG9uc2UoeyBpZDogXCJib3QtMVwiIH0pO1xuICAgIGlmIChocmVmLmluY2x1ZGVzKFwiL2NoYW5uZWxzLzEyMzQ1Njc4OTAxMjM0NTY3XCIpICYmICFocmVmLmluY2x1ZGVzKFwiL21lc3NhZ2VzXCIpKSByZXR1cm4ganNvblJlc3BvbnNlKHsgZ3VpbGRfaWQ6IFwiZ3VpbGQtMVwiIH0pO1xuICAgIGlmIChocmVmLmVuZHNXaXRoKFwiL21lc3NhZ2VzXCIpKSByZXR1cm4ganNvblJlc3BvbnNlKHsgaWQ6IFwibWVzc2FnZS0xXCIgfSk7XG4gICAgcmV0dXJuIGpzb25SZXNwb25zZSh7fSk7XG4gIH0pO1xuICB0cnkge1xuICAgIGNvbnN0IGFkYXB0ZXIgPSBuZXcgRGlzY29yZEFkYXB0ZXIoXCJ0b2tlblwiLCBcIjEyMzQ1Njc4OTAxMjM0NTY3XCIpO1xuICAgIGF3YWl0IGFkYXB0ZXIudmFsaWRhdGUoKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBhZGFwdGVyLnNlbmRQcm9tcHQoe1xuICAgICAgaWQ6IFwiZGlzY29yZC0xXCIsXG4gICAgICBjaGFubmVsOiBcImRpc2NvcmRcIixcbiAgICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIHRpbWVvdXRBdDogRGF0ZS5ub3coKSArIDYwXzAwMCxcbiAgICAgIHBvbGxJbnRlcnZhbE1zOiA1MDAwLFxuICAgICAgcXVlc3Rpb25zOiBbe1xuICAgICAgICBpZDogXCJxMVwiLFxuICAgICAgICBoZWFkZXI6IFwiUGlja1wiLFxuICAgICAgICBxdWVzdGlvbjogXCJDaG9vc2VcIixcbiAgICAgICAgYWxsb3dNdWx0aXBsZTogZmFsc2UsXG4gICAgICAgIG9wdGlvbnM6IFt7IGxhYmVsOiBcIkFcIiwgZGVzY3JpcHRpb246IFwiYVwiIH1dLFxuICAgICAgfV0sXG4gICAgfSk7XG4gICAgYXdhaXQgYWRhcHRlci5hY2tub3dsZWRnZUFuc3dlcihyZXN1bHQucmVmKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucmVmLnRocmVhZFVybCwgXCJodHRwczovL2Rpc2NvcmQuY29tL2NoYW5uZWxzL2d1aWxkLTEvMTIzNDU2Nzg5MDEyMzQ1NjcvbWVzc2FnZS0xXCIpO1xuICAgIGFzc2VydC5vayhjYWxscy5zb21lKChjYWxsKSA9PiBjYWxsLm1ldGhvZCA9PT0gXCJQVVRcIiAmJiBjYWxsLnVybC5pbmNsdWRlcyhlbmNvZGVVUklDb21wb25lbnQoXCJcdTI3MDVcIikpKSk7XG4gIH0gZmluYWxseSB7XG4gICAgZmV0Y2hNb2NrLm1vY2sucmVzdG9yZSgpO1xuICB9XG59KTtcblxudGVzdChcIlNsYWNrQWRhcHRlciBwb2xscyByZWFjdGlvbnMgYW5kIGFja25vd2xlZGdlcyB3aXRoIHdoaXRlX2NoZWNrX21hcmtcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBjYWxsczogQXJyYXk8eyB1cmw6IHN0cmluZzsgbWV0aG9kOiBzdHJpbmc7IGJvZHk/OiBzdHJpbmcgfT4gPSBbXTtcbiAgY29uc3QgZmV0Y2hNb2NrID0gbW9jay5tZXRob2QoZ2xvYmFsVGhpcywgXCJmZXRjaFwiLCBhc3luYyAodXJsOiBzdHJpbmcgfCBVUkwsIGluaXQ/OiBSZXF1ZXN0SW5pdCkgPT4ge1xuICAgIGNvbnN0IGhyZWYgPSBTdHJpbmcodXJsKTtcbiAgICBjYWxscy5wdXNoKHsgdXJsOiBocmVmLCBtZXRob2Q6IFN0cmluZyhpbml0Py5tZXRob2QgPz8gXCJHRVRcIiksIGJvZHk6IFN0cmluZyhpbml0Py5ib2R5ID8/IFwiXCIpIH0pO1xuICAgIGlmIChocmVmLmluY2x1ZGVzKFwiL2F1dGgudGVzdFwiKSkgcmV0dXJuIGpzb25SZXNwb25zZSh7IG9rOiB0cnVlLCB1c2VyX2lkOiBcImJvdC0xXCIgfSk7XG4gICAgaWYgKGhyZWYuaW5jbHVkZXMoXCIvY2hhdC5wb3N0TWVzc2FnZVwiKSkgcmV0dXJuIGpzb25SZXNwb25zZSh7IG9rOiB0cnVlLCB0czogXCIxMjMuNDU2XCIsIGNoYW5uZWw6IFwiQzEyMzQ1Njc4XCIgfSk7XG4gICAgaWYgKGhyZWYuaW5jbHVkZXMoXCIvcmVhY3Rpb25zLmdldFwiKSkge1xuICAgICAgcmV0dXJuIGpzb25SZXNwb25zZSh7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICBtZXNzYWdlOiB7IHJlYWN0aW9uczogW3sgbmFtZTogXCJ0d29cIiwgY291bnQ6IDEsIHVzZXJzOiBbXCJodW1hbi0xXCJdIH1dIH0sXG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIGpzb25SZXNwb25zZSh7IG9rOiB0cnVlIH0pO1xuICB9KTtcbiAgdHJ5IHtcbiAgICBjb25zdCBhZGFwdGVyID0gbmV3IFNsYWNrQWRhcHRlcihcInhveGItdGVzdFwiLCBcIkMxMjM0NTY3OFwiKTtcbiAgICBhd2FpdCBhZGFwdGVyLnZhbGlkYXRlKCk7XG4gICAgY29uc3QgcHJvbXB0ID0ge1xuICAgICAgaWQ6IFwic2xhY2stMVwiLFxuICAgICAgY2hhbm5lbDogXCJzbGFja1wiIGFzIGNvbnN0LFxuICAgICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgdGltZW91dEF0OiBEYXRlLm5vdygpICsgNjBfMDAwLFxuICAgICAgcG9sbEludGVydmFsTXM6IDUwMDAsXG4gICAgICBxdWVzdGlvbnM6IFt7XG4gICAgICAgIGlkOiBcInExXCIsXG4gICAgICAgIGhlYWRlcjogXCJQaWNrXCIsXG4gICAgICAgIHF1ZXN0aW9uOiBcIkNob29zZVwiLFxuICAgICAgICBhbGxvd011bHRpcGxlOiBmYWxzZSxcbiAgICAgICAgb3B0aW9uczogW1xuICAgICAgICAgIHsgbGFiZWw6IFwiQVwiLCBkZXNjcmlwdGlvbjogXCJhXCIgfSxcbiAgICAgICAgICB7IGxhYmVsOiBcIkJcIiwgZGVzY3JpcHRpb246IFwiYlwiIH0sXG4gICAgICAgIF0sXG4gICAgICB9XSxcbiAgICB9O1xuICAgIGNvbnN0IHNlbnQgPSBhd2FpdCBhZGFwdGVyLnNlbmRQcm9tcHQocHJvbXB0KTtcbiAgICBjb25zdCBhbnN3ZXIgPSBhd2FpdCBhZGFwdGVyLnBvbGxBbnN3ZXIocHJvbXB0LCBzZW50LnJlZik7XG4gICAgYXdhaXQgYWRhcHRlci5hY2tub3dsZWRnZUFuc3dlcihzZW50LnJlZik7XG5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKGFuc3dlciwgeyBhbnN3ZXJzOiB7IHExOiB7IGFuc3dlcnM6IFtcIkJcIl0gfSB9IH0pO1xuICAgIGFzc2VydC5vayhjYWxscy5zb21lKChjYWxsKSA9PiBjYWxsLnVybC5pbmNsdWRlcyhcIi9yZWFjdGlvbnMuZ2V0XCIpKSk7XG4gICAgYXNzZXJ0Lm9rKGNhbGxzLnNvbWUoKGNhbGwpID0+XG4gICAgICBjYWxsLnVybC5pbmNsdWRlcyhcIi9yZWFjdGlvbnMuYWRkXCIpXG4gICAgICAmJiB0eXBlb2YgY2FsbC5ib2R5ID09PSBcInN0cmluZ1wiXG4gICAgICAmJiBjYWxsLmJvZHkuaW5jbHVkZXMoXCJ3aGl0ZV9jaGVja19tYXJrXCIpXG4gICAgKSk7XG4gIH0gZmluYWxseSB7XG4gICAgZmV0Y2hNb2NrLm1vY2sucmVzdG9yZSgpO1xuICB9XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBUZWxlZ3JhbSBUZXN0c1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoXCJmb3JtYXRGb3JUZWxlZ3JhbSBzaW5nbGUtcXVlc3Rpb24gcHJvZHVjZXMgaW5saW5lIGtleWJvYXJkXCIsICgpID0+IHtcbiAgY29uc3QgcHJvbXB0ID0ge1xuICAgIGlkOiBcInRnLTFcIixcbiAgICBjaGFubmVsOiBcInRlbGVncmFtXCIgYXMgY29uc3QsXG4gICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgIHRpbWVvdXRBdDogRGF0ZS5ub3coKSArIDYwMDAwLFxuICAgIHBvbGxJbnRlcnZhbE1zOiA1MDAwLFxuICAgIHF1ZXN0aW9uczogW3tcbiAgICAgIGlkOiBcInExXCIsXG4gICAgICBoZWFkZXI6IFwiQ29uZmlybVwiLFxuICAgICAgcXVlc3Rpb246IFwiUHJvY2VlZD9cIixcbiAgICAgIG9wdGlvbnM6IFtcbiAgICAgICAgeyBsYWJlbDogXCJZZXNcIiwgZGVzY3JpcHRpb246IFwiQ29udGludWVcIiB9LFxuICAgICAgICB7IGxhYmVsOiBcIk5vXCIsIGRlc2NyaXB0aW9uOiBcIlN0b3BcIiB9LFxuICAgICAgXSxcbiAgICAgIGFsbG93TXVsdGlwbGU6IGZhbHNlLFxuICAgIH1dLFxuICB9O1xuXG4gIGNvbnN0IG1zZyA9IGZvcm1hdEZvclRlbGVncmFtKHByb21wdCk7XG4gIGFzc2VydC5lcXVhbChtc2cucGFyc2VfbW9kZSwgXCJIVE1MXCIpO1xuICBhc3NlcnQub2sobXNnLnRleHQuaW5jbHVkZXMoXCI8Yj5HU0QgbmVlZHMgeW91ciBpbnB1dDwvYj5cIikpO1xuICBhc3NlcnQub2sobXNnLnRleHQuaW5jbHVkZXMoXCI8Yj5Db25maXJtPC9iPlwiKSk7XG4gIGFzc2VydC5vayhtc2cucmVwbHlfbWFya3VwLCBcInNpbmdsZS1xdWVzdGlvbiBzaG91bGQgaGF2ZSBpbmxpbmUga2V5Ym9hcmRcIik7XG4gIGFzc2VydC5lcXVhbChtc2cucmVwbHlfbWFya3VwIS5pbmxpbmVfa2V5Ym9hcmQubGVuZ3RoLCAyLCBcInNob3VsZCBoYXZlIDIgYnV0dG9uIHJvd3NcIik7XG4gIGFzc2VydC5lcXVhbChtc2cucmVwbHlfbWFya3VwIS5pbmxpbmVfa2V5Ym9hcmRbMF1bMF0uY2FsbGJhY2tfZGF0YSwgXCJ0Zy0xOjBcIik7XG4gIGFzc2VydC5lcXVhbChtc2cucmVwbHlfbWFya3VwIS5pbmxpbmVfa2V5Ym9hcmRbMV1bMF0uY2FsbGJhY2tfZGF0YSwgXCJ0Zy0xOjFcIik7XG59KTtcblxudGVzdChcImZvcm1hdEZvclRlbGVncmFtIG11bHRpLXF1ZXN0aW9uIG9taXRzIGlubGluZSBrZXlib2FyZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHByb21wdCA9IHtcbiAgICBpZDogXCJ0Zy0yXCIsXG4gICAgY2hhbm5lbDogXCJ0ZWxlZ3JhbVwiIGFzIGNvbnN0LFxuICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICB0aW1lb3V0QXQ6IERhdGUubm93KCkgKyA2MDAwMCxcbiAgICBwb2xsSW50ZXJ2YWxNczogNTAwMCxcbiAgICBxdWVzdGlvbnM6IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwicTFcIixcbiAgICAgICAgaGVhZGVyOiBcIkZpcnN0XCIsXG4gICAgICAgIHF1ZXN0aW9uOiBcIlBpY2tcIixcbiAgICAgICAgb3B0aW9uczogW3sgbGFiZWw6IFwiQVwiLCBkZXNjcmlwdGlvbjogXCJhXCIgfV0sXG4gICAgICAgIGFsbG93TXVsdGlwbGU6IGZhbHNlLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwicTJcIixcbiAgICAgICAgaGVhZGVyOiBcIlNlY29uZFwiLFxuICAgICAgICBxdWVzdGlvbjogXCJQaWNrXCIsXG4gICAgICAgIG9wdGlvbnM6IFt7IGxhYmVsOiBcIkJcIiwgZGVzY3JpcHRpb246IFwiYlwiIH1dLFxuICAgICAgICBhbGxvd011bHRpcGxlOiBmYWxzZSxcbiAgICAgIH0sXG4gICAgXSxcbiAgfTtcblxuICBjb25zdCBtc2cgPSBmb3JtYXRGb3JUZWxlZ3JhbShwcm9tcHQpO1xuICBhc3NlcnQuZXF1YWwobXNnLnJlcGx5X21hcmt1cCwgdW5kZWZpbmVkLCBcIm11bHRpLXF1ZXN0aW9uIHNob3VsZCBub3QgaGF2ZSBpbmxpbmUga2V5Ym9hcmRcIik7XG4gIGFzc2VydC5vayhtc2cudGV4dC5pbmNsdWRlcyhcIjEvMlwiKSwgXCJzaG91bGQgc2hvdyBxdWVzdGlvbiBwb3NpdGlvblwiKTtcbiAgYXNzZXJ0Lm9rKG1zZy50ZXh0LmluY2x1ZGVzKFwiMi8yXCIpLCBcInNob3VsZCBzaG93IHF1ZXN0aW9uIHBvc2l0aW9uXCIpO1xufSk7XG5cbnRlc3QoXCJmb3JtYXRGb3JUZWxlZ3JhbSBlc2NhcGVzIEhUTUwgaW4gdXNlciBjb250ZW50XCIsICgpID0+IHtcbiAgY29uc3QgcHJvbXB0ID0ge1xuICAgIGlkOiBcInRnLTNcIixcbiAgICBjaGFubmVsOiBcInRlbGVncmFtXCIgYXMgY29uc3QsXG4gICAgY3JlYXRlZEF0OiBEYXRlLm5vdygpLFxuICAgIHRpbWVvdXRBdDogRGF0ZS5ub3coKSArIDYwMDAwLFxuICAgIHBvbGxJbnRlcnZhbE1zOiA1MDAwLFxuICAgIHF1ZXN0aW9uczogW3tcbiAgICAgIGlkOiBcInExXCIsXG4gICAgICBoZWFkZXI6IFwiVGVzdCA8c2NyaXB0PlwiLFxuICAgICAgcXVlc3Rpb246IFwiSXMgNSA+IDMgJiAyIDwgND9cIixcbiAgICAgIG9wdGlvbnM6IFt7IGxhYmVsOiBcIjxiPlllczwvYj5cIiwgZGVzY3JpcHRpb246IFwiaXQncyB0cnVlXCIgfV0sXG4gICAgICBhbGxvd011bHRpcGxlOiBmYWxzZSxcbiAgICB9XSxcbiAgfTtcblxuICBjb25zdCBtc2cgPSBmb3JtYXRGb3JUZWxlZ3JhbShwcm9tcHQpO1xuICBhc3NlcnQub2sobXNnLnRleHQuaW5jbHVkZXMoXCImbHQ7c2NyaXB0Jmd0O1wiKSwgXCJzaG91bGQgZXNjYXBlIDwgPiBpbiBoZWFkZXJcIik7XG4gIGFzc2VydC5vayhtc2cudGV4dC5pbmNsdWRlcyhcIjUgJmd0OyAzICZhbXA7IDIgJmx0OyA0XCIpLCBcInNob3VsZCBlc2NhcGUgaW4gcXVlc3Rpb25cIik7XG4gIGFzc2VydC5vayhtc2cudGV4dC5pbmNsdWRlcyhcIiZsdDtiJmd0O1llcyZsdDsvYiZndDtcIiksIFwic2hvdWxkIGVzY2FwZSBpbiBvcHRpb24gbGFiZWxcIik7XG59KTtcblxudGVzdChcInBhcnNlVGVsZWdyYW1SZXNwb25zZSBoYW5kbGVzIGNhbGxiYWNrX2RhdGEgYnV0dG9uIHByZXNzXCIsICgpID0+IHtcbiAgY29uc3QgcXVlc3Rpb25zID0gW3tcbiAgICBpZDogXCJjaG9pY2VcIixcbiAgICBoZWFkZXI6IFwiUGlja1wiLFxuICAgIHF1ZXN0aW9uOiBcIkNob29zZVwiLFxuICAgIGFsbG93TXVsdGlwbGU6IGZhbHNlLFxuICAgIG9wdGlvbnM6IFtcbiAgICAgIHsgbGFiZWw6IFwiQWxwaGFcIiwgZGVzY3JpcHRpb246IFwiQVwiIH0sXG4gICAgICB7IGxhYmVsOiBcIkJldGFcIiwgZGVzY3JpcHRpb246IFwiQlwiIH0sXG4gICAgXSxcbiAgfV07XG5cbiAgY29uc3QgcmVzdWx0ID0gcGFyc2VUZWxlZ3JhbVJlc3BvbnNlKFwicHJvbXB0LTEyMzoxXCIsIG51bGwsIHF1ZXN0aW9ucywgXCJwcm9tcHQtMTIzXCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwgeyBhbnN3ZXJzOiB7IGNob2ljZTogeyBhbnN3ZXJzOiBbXCJCZXRhXCJdIH0gfSB9KTtcbn0pO1xuXG50ZXN0KFwicGFyc2VUZWxlZ3JhbVJlc3BvbnNlIGhhbmRsZXMgdGV4dCByZXBseSBkZWxlZ2F0aW9uXCIsICgpID0+IHtcbiAgY29uc3QgcXVlc3Rpb25zID0gW3tcbiAgICBpZDogXCJjaG9pY2VcIixcbiAgICBoZWFkZXI6IFwiUGlja1wiLFxuICAgIHF1ZXN0aW9uOiBcIkNob29zZVwiLFxuICAgIGFsbG93TXVsdGlwbGU6IGZhbHNlLFxuICAgIG9wdGlvbnM6IFtcbiAgICAgIHsgbGFiZWw6IFwiQWxwaGFcIiwgZGVzY3JpcHRpb246IFwiQVwiIH0sXG4gICAgICB7IGxhYmVsOiBcIkJldGFcIiwgZGVzY3JpcHRpb246IFwiQlwiIH0sXG4gICAgXSxcbiAgfV07XG5cbiAgY29uc3QgcmVzdWx0ID0gcGFyc2VUZWxlZ3JhbVJlc3BvbnNlKG51bGwsIFwiMVwiLCBxdWVzdGlvbnMsIFwicHJvbXB0LTEyM1wiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIHsgYW5zd2VyczogeyBjaG9pY2U6IHsgYW5zd2VyczogW1wiQWxwaGFcIl0gfSB9IH0pO1xufSk7XG5cbnRlc3QoXCJwYXJzZVRlbGVncmFtUmVzcG9uc2UgaGFuZGxlcyBtdWx0aS1xdWVzdGlvbiBzZW1pY29sb25zXCIsICgpID0+IHtcbiAgY29uc3QgcXVlc3Rpb25zID0gW1xuICAgIHtcbiAgICAgIGlkOiBcImZpcnN0XCIsXG4gICAgICBoZWFkZXI6IFwiRmlyc3RcIixcbiAgICAgIHF1ZXN0aW9uOiBcIlBpY2tcIixcbiAgICAgIGFsbG93TXVsdGlwbGU6IGZhbHNlLFxuICAgICAgb3B0aW9uczogW1xuICAgICAgICB7IGxhYmVsOiBcIkFscGhhXCIsIGRlc2NyaXB0aW9uOiBcIkFcIiB9LFxuICAgICAgICB7IGxhYmVsOiBcIkJldGFcIiwgZGVzY3JpcHRpb246IFwiQlwiIH0sXG4gICAgICBdLFxuICAgIH0sXG4gICAge1xuICAgICAgaWQ6IFwic2Vjb25kXCIsXG4gICAgICBoZWFkZXI6IFwiU2Vjb25kXCIsXG4gICAgICBxdWVzdGlvbjogXCJQaWNrXCIsXG4gICAgICBhbGxvd011bHRpcGxlOiBmYWxzZSxcbiAgICAgIG9wdGlvbnM6IFtcbiAgICAgICAgeyBsYWJlbDogXCJHYW1tYVwiLCBkZXNjcmlwdGlvbjogXCJHXCIgfSxcbiAgICAgICAgeyBsYWJlbDogXCJEZWx0YVwiLCBkZXNjcmlwdGlvbjogXCJEXCIgfSxcbiAgICAgIF0sXG4gICAgfSxcbiAgXTtcblxuICBjb25zdCByZXN1bHQgPSBwYXJzZVRlbGVncmFtUmVzcG9uc2UobnVsbCwgXCIyOzFcIiwgcXVlc3Rpb25zLCBcInByb21wdC0xMjNcIik7XG4gIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LmFuc3dlcnMuZmlyc3QuYW5zd2VycywgW1wiQmV0YVwiXSk7XG4gIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LmFuc3dlcnMuc2Vjb25kLmFuc3dlcnMsIFtcIkdhbW1hXCJdKTtcbn0pO1xuXG50ZXN0KFwiaXNWYWxpZENoYW5uZWxJZCB2YWxpZGF0ZXMgVGVsZWdyYW0gY2hhdCBJRHNcIiwgKCkgPT4ge1xuICAvLyBWYWxpZCBwb3NpdGl2ZSBJRFxuICBhc3NlcnQuZXF1YWwoaXNWYWxpZENoYW5uZWxJZChcInRlbGVncmFtXCIsIFwiMTIzNDVcIiksIHRydWUpO1xuICAvLyBWYWxpZCBuZWdhdGl2ZSBncm91cCBJRFxuICBhc3NlcnQuZXF1YWwoaXNWYWxpZENoYW5uZWxJZChcInRlbGVncmFtXCIsIFwiLTEwMDEyMzQ1Njc4OTBcIiksIHRydWUpO1xuICAvLyBUb28gc2hvcnRcbiAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRDaGFubmVsSWQoXCJ0ZWxlZ3JhbVwiLCBcIjEyMzRcIiksIGZhbHNlKTtcbiAgLy8gTm9uLW51bWVyaWNcbiAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRDaGFubmVsSWQoXCJ0ZWxlZ3JhbVwiLCBcImFiYzEyMzQ1XCIpLCBmYWxzZSk7XG4gIC8vIFVSTCBpbmplY3Rpb25cbiAgYXNzZXJ0LmVxdWFsKGlzVmFsaWRDaGFubmVsSWQoXCJ0ZWxlZ3JhbVwiLCBcImh0dHBzOi8vZXZpbC5jb21cIiksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwic2FuaXRpemVFcnJvciBzdHJpcHMgVGVsZWdyYW0gYm90IHRva2VuIHBhdHRlcm5zXCIsICgpID0+IHtcbiAgY29uc3QgZmFrZVRva2VuID0gXCIxMjM0NTY3ODkwOkFCQ2RlZkdISWprbE1OT3BxclNUVXZ3eHl6MTIzNDU2NzhcIjtcbiAgY29uc3QgcmVzdWx0ID0gc2FuaXRpemVFcnJvcihgVG9rZW46ICR7ZmFrZVRva2VufWApO1xuICBhc3NlcnQub2soIXJlc3VsdC5pbmNsdWRlcyhcIjEyMzQ1Njc4OTA6QUJDXCIpLCBcInNob3VsZCBzdHJpcCBUZWxlZ3JhbSBib3QgdG9rZW5cIik7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBBdXRoLmpzb24gVG9rZW4gSHlkcmF0aW9uIFRlc3RzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxudGVzdChcInJlc29sdmVSZW1vdGVDb25maWcgdXNlcyBjb25maWd1cmVkIGNoYW5uZWwgYW5kIGV4aXN0aW5nIGVudmlyb25tZW50IHRva2VuXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmVudi5TTEFDS19CT1RfVE9LRU47XG4gIHRyeSB7XG4gICAgYXdhaXQgd2l0aFRlbXBHc2RIb21lKCgpID0+IHtcbiAgICAgIHByb2Nlc3MuZW52LlNMQUNLX0JPVF9UT0tFTiA9IFwieG94Yi1leGlzdGluZ1wiO1xuICAgICAgc2F2ZVJlbW90ZVF1ZXN0aW9uc0NvbmZpZyhcInNsYWNrXCIsIFwiQzEyMzQ1Njc4XCIpO1xuICAgICAgYXNzZXJ0LmRlZXBFcXVhbChyZXNvbHZlUmVtb3RlQ29uZmlnKCksIHtcbiAgICAgICAgY2hhbm5lbDogXCJzbGFja1wiLFxuICAgICAgICBjaGFubmVsSWQ6IFwiQzEyMzQ1Njc4XCIsXG4gICAgICAgIHRpbWVvdXRNczogNSAqIDYwICogMTAwMCxcbiAgICAgICAgcG9sbEludGVydmFsTXM6IDUgKiAxMDAwLFxuICAgICAgICB0b2tlbjogXCJ4b3hiLWV4aXN0aW5nXCIsXG4gICAgICB9KTtcbiAgICAgIGFzc2VydC5lcXVhbChpc1JlbW90ZUNvbmZpZ3VyZWQoKSwgdHJ1ZSk7XG4gICAgfSk7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHNhdmVkID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5TTEFDS19CT1RfVE9LRU47XG4gICAgZWxzZSBwcm9jZXNzLmVudi5TTEFDS19CT1RfVE9LRU4gPSBzYXZlZDtcbiAgfVxufSk7XG5cbnRlc3QoXCJyZXNvbHZlUmVtb3RlQ29uZmlnIHJldHVybnMgbnVsbCB3aGVuIHByZWZlcmVuY2VzIGFyZSBhYnNlbnQgKG5vIGVudiBzaWRlLWVmZmVjdHMpXCIsICgpID0+IHtcbiAgLy8gR3VhcmQ6IGVuc3VyZSB0aGF0IHdpdGggbm8gcHJlZnMgY29uZmlndXJlZCwgcmVzb2x2ZVJlbW90ZUNvbmZpZyByZXR1cm5zIG51bGwgY2xlYW5seS5cbiAgLy8gVGhpcyBleGVyY2lzZXMgdGhlIGh5ZHJhdGlvbiBwYXRoIHdpdGhvdXQgYXV0aC5qc29uIHByZXNlbnQgKGl0IHNob3VsZCBuby1vcCBzaWxlbnRseSkuXG4gIGNvbnN0IHNhdmVkSG9tZSA9IHByb2Nlc3MuZW52LkhPTUU7XG4gIGNvbnN0IHNhdmVkVXNlclByb2ZpbGUgPSBwcm9jZXNzLmVudi5VU0VSUFJPRklMRTtcbiAgY29uc3Qgc2F2ZWREaXNjb3JkID0gcHJvY2Vzcy5lbnYuRElTQ09SRF9CT1RfVE9LRU47XG4gIGNvbnN0IHNhdmVkU2xhY2sgPSBwcm9jZXNzLmVudi5TTEFDS19CT1RfVE9LRU47XG4gIGNvbnN0IHNhdmVkVGVsZWdyYW0gPSBwcm9jZXNzLmVudi5URUxFR1JBTV9CT1RfVE9LRU47XG4gIHRyeSB7XG4gICAgLy8gUG9pbnQgSE9NRSB0byBhIG5vbmV4aXN0ZW50IGRpciBzbyBhdXRoLmpzb24gbG9va3VwIGZpbmRzIG5vdGhpbmcuXG4gICAgcHJvY2Vzcy5lbnYuSE9NRSA9IFwiL3RtcC9nc2Qtbm8tc3VjaC1ob21lLWZvci10ZXN0XCI7XG4gICAgcHJvY2Vzcy5lbnYuVVNFUlBST0ZJTEUgPSBcIi90bXAvZ3NkLW5vLXN1Y2gtaG9tZS1mb3ItdGVzdFwiO1xuICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5ESVNDT1JEX0JPVF9UT0tFTjtcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnYuU0xBQ0tfQk9UX1RPS0VOO1xuICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5URUxFR1JBTV9CT1RfVE9LRU47XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXNvbHZlUmVtb3RlQ29uZmlnKCk7XG4gICAgLy8gV2l0aCBubyBwcmVmcyBmaWxlLCByZXN1bHQgaXMgbnVsbCBcdTIwMTQgbm90IGFuIGV4Y2VwdGlvbi5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBudWxsLCBcInJlc29sdmVSZW1vdGVDb25maWcgc2hvdWxkIHJldHVybiBudWxsIHdoZW4gbm8gcHJlZmVyZW5jZXMgYXJlIGNvbmZpZ3VyZWRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcHJvY2Vzcy5lbnYuSE9NRSA9IHNhdmVkSG9tZTtcbiAgICBwcm9jZXNzLmVudi5VU0VSUFJPRklMRSA9IHNhdmVkVXNlclByb2ZpbGU7XG4gICAgaWYgKHNhdmVkRGlzY29yZCAhPT0gdW5kZWZpbmVkKSBwcm9jZXNzLmVudi5ESVNDT1JEX0JPVF9UT0tFTiA9IHNhdmVkRGlzY29yZDtcbiAgICBpZiAoc2F2ZWRTbGFjayAhPT0gdW5kZWZpbmVkKSBwcm9jZXNzLmVudi5TTEFDS19CT1RfVE9LRU4gPSBzYXZlZFNsYWNrO1xuICAgIGlmIChzYXZlZFRlbGVncmFtICE9PSB1bmRlZmluZWQpIHByb2Nlc3MuZW52LlRFTEVHUkFNX0JPVF9UT0tFTiA9IHNhdmVkVGVsZWdyYW07XG4gIH1cbn0pO1xuXG50ZXN0KFwicmVtb3RlIGRpc2Nvbm5lY3QgcmVtb3ZlcyBhY3RpdmUgZW52IHRva2VuIGFuZCBkaXNhYmxlcyByZW1vdGUgY29uZmlnXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmVudi5ESVNDT1JEX0JPVF9UT0tFTjtcbiAgdHJ5IHtcbiAgICBhd2FpdCB3aXRoVGVtcEdzZEhvbWUoYXN5bmMgKCkgPT4ge1xuICAgICAgcHJvY2Vzcy5lbnYuRElTQ09SRF9CT1RfVE9LRU4gPSBcImRpc2NvcmQtdG9rZW5cIjtcbiAgICAgIHNhdmVSZW1vdGVRdWVzdGlvbnNDb25maWcoXCJkaXNjb3JkXCIsIFwiMTIzNDU2Nzg5MDEyMzQ1NjdcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNSZW1vdGVDb25maWd1cmVkKCksIHRydWUpO1xuXG4gICAgICBjb25zdCBub3RpZmljYXRpb25zOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgYXdhaXQgaGFuZGxlUmVtb3RlKFwiZGlzY29ubmVjdFwiLCB7XG4gICAgICAgIHVpOiB7IG5vdGlmeShtZXNzYWdlOiBzdHJpbmcpIHsgbm90aWZpY2F0aW9ucy5wdXNoKG1lc3NhZ2UpOyB9IH0sXG4gICAgICB9IGFzIGFueSwge30gYXMgYW55KTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKHByb2Nlc3MuZW52LkRJU0NPUkRfQk9UX1RPS0VOLCB1bmRlZmluZWQpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc29sdmVSZW1vdGVDb25maWcoKSwgbnVsbCk7XG4gICAgICBhc3NlcnQub2sobm90aWZpY2F0aW9ucy5zb21lKChtZXNzYWdlKSA9PiBtZXNzYWdlLmluY2x1ZGVzKFwiZGlzY29ubmVjdGVkXCIpKSk7XG4gICAgfSk7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHNhdmVkID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5ESVNDT1JEX0JPVF9UT0tFTjtcbiAgICBlbHNlIHByb2Nlc3MuZW52LkRJU0NPUkRfQk9UX1RPS0VOID0gc2F2ZWQ7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxRQUFRLFlBQVk7QUFDM0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxjQUFjO0FBQ3BDLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxpQkFBaUIsc0JBQXNCLGtCQUFrQixnQkFBZ0IsNEJBQTRCLG1CQUFtQiw2QkFBNkI7QUFDOUosU0FBUyxxQkFBcUIsd0JBQXdCO0FBQ3RELFNBQVMsc0JBQXNCO0FBQy9CLFNBQVMsMEJBQTBCO0FBQ25DLFNBQVMsY0FBYyxpQ0FBaUM7QUFDeEQsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxxQkFBcUI7QUFFOUIsU0FBUyxhQUFhLE1BQXlCO0FBQzdDLFNBQU87QUFBQSxJQUNMLElBQUk7QUFBQSxJQUNKLFFBQVE7QUFBQSxJQUNSLE1BQU0sT0FBTztBQUFFLGFBQU87QUFBQSxJQUFNO0FBQUEsSUFDNUIsTUFBTSxPQUFPO0FBQUUsYUFBTyxLQUFLLFVBQVUsSUFBSTtBQUFBLElBQUc7QUFBQSxFQUM5QztBQUNGO0FBRUEsZUFBZSxnQkFBbUIsSUFBa0Q7QUFDbEYsUUFBTSxVQUFVLFFBQVEsSUFBSTtBQUM1QixRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyxrQkFBa0IsQ0FBQztBQUMzRCxNQUFJO0FBQ0YsWUFBUSxJQUFJLFdBQVc7QUFDdkIsV0FBTyxNQUFNLEdBQUcsSUFBSTtBQUFBLEVBQ3RCLFVBQUU7QUFDQSxRQUFJLFlBQVksT0FBVyxRQUFPLFFBQVEsSUFBSTtBQUFBLFFBQ3pDLFNBQVEsSUFBSSxXQUFXO0FBQzVCLFdBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQy9DO0FBQ0Y7QUFFQSxLQUFLLGlFQUFpRSxNQUFNO0FBQzFFLFFBQU0sU0FBUyxnQkFBZ0IsS0FBSyxDQUFDO0FBQUEsSUFDbkMsSUFB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
