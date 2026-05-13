import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const PER_REQUEST_TIMEOUT_MS = 15e3;
const DISCORD_API = "https://discord.com/api/v10";
const SLACK_API = "https://slack.com/api";
const TELEGRAM_API = "https://api.telegram.org";
const DISCORD_NUMBER_EMOJIS = ["1\uFE0F\u20E3", "2\uFE0F\u20E3", "3\uFE0F\u20E3", "4\uFE0F\u20E3", "5\uFE0F\u20E3"];
const SLACK_NUMBER_REACTION_NAMES = ["one", "two", "three", "four", "five"];
const DEFAULT_TIMEOUT_MINUTES = 5;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 30;
const MIN_POLL_INTERVAL_SECONDS = 2;
const MAX_POLL_INTERVAL_SECONDS = 30;
const CHANNEL_ID_PATTERNS = {
  slack: /^[A-Z0-9]{9,12}$/,
  discord: /^\d{17,20}$/,
  telegram: /^-?\d{5,20}$/
};
const ENV_KEYS = {
  slack: "SLACK_BOT_TOKEN",
  discord: "DISCORD_BOT_TOKEN",
  telegram: "TELEGRAM_BOT_TOKEN"
};
function clampNumber(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function parseSimpleFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m);
  if (!match) return {};
  const yaml = match[1];
  const result = {};
  let currentSection = null;
  const sectionData = {};
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const topMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (topMatch) {
      currentSection = topMatch[1];
      const val = topMatch[2].trim();
      if (val) {
        result[currentSection] = parseSimpleScalar(val);
        currentSection = null;
      } else {
        sectionData[currentSection] = {};
        result[currentSection] = sectionData[currentSection];
      }
      continue;
    }
    const childMatch = line.match(/^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (childMatch && currentSection && sectionData[currentSection]) {
      const childKey = childMatch[1];
      const childVal = childMatch[2].trim();
      sectionData[currentSection][childKey] = parseSimpleScalar(childVal);
    }
  }
  return result;
}
function parseSimpleScalar(raw) {
  const s = raw.replace(/^["']|["']$/g, "").trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  const n = Number(s);
  if (s !== "" && !Number.isNaN(n)) return n;
  return s;
}
function loadPreferencesFromFile(path) {
  try {
    const content = readFileSync(path, "utf-8");
    return parseSimpleFrontmatter(content);
  } catch {
    return null;
  }
}
function resolveRemoteConfig() {
  const gsdHome = process.env["GSD_HOME"] ?? join(homedir(), ".gsd");
  const globalPath = join(gsdHome, "PREFERENCES.md");
  const prefs = loadPreferencesFromFile(globalPath);
  if (!prefs) return null;
  const rq = prefs["remote_questions"];
  if (!rq || !rq["channel"] || !rq["channel_id"]) return null;
  const channel = String(rq["channel"]);
  if (channel !== "slack" && channel !== "discord" && channel !== "telegram") return null;
  const channelId = String(rq["channel_id"]);
  if (!CHANNEL_ID_PATTERNS[channel].test(channelId)) return null;
  const token = process.env[ENV_KEYS[channel]];
  if (!token) return null;
  const timeoutMs = clampNumber(rq["timeout_minutes"], DEFAULT_TIMEOUT_MINUTES, MIN_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES) * 60 * 1e3;
  const pollIntervalMs = clampNumber(rq["poll_interval_seconds"], DEFAULT_POLL_INTERVAL_SECONDS, MIN_POLL_INTERVAL_SECONDS, MAX_POLL_INTERVAL_SECONDS) * 1e3;
  return { channel, channelId, timeoutMs, pollIntervalMs, token };
}
function isRemoteConfigured() {
  return resolveRemoteConfig() !== null;
}
async function apiRequest(url, method, body, authScheme, authToken, errorLabel) {
  const headers = {
    Authorization: `${authScheme} ${authToken}`
  };
  const init = {
    method,
    headers,
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS)
  };
  if (body !== void 0) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  if (response.status === 204) return {};
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const safeText = text.length > 200 ? text.slice(0, 200) + "\u2026" : text;
    throw new Error(`${errorLabel} HTTP ${response.status}: ${safeText}`);
  }
  return response.json();
}
function formatForDiscord(prompt) {
  const reactionEmojis = [];
  const embeds = prompt.questions.map((q, questionIndex) => {
    const supportsReactions = prompt.questions.length === 1;
    const optionLines = q.options.map((opt, i) => {
      const emoji = DISCORD_NUMBER_EMOJIS[i] ?? `${i + 1}.`;
      if (supportsReactions && DISCORD_NUMBER_EMOJIS[i]) reactionEmojis.push(DISCORD_NUMBER_EMOJIS[i]);
      return `${emoji} **${opt.label}** \u2014 ${opt.description}`;
    });
    const footerParts = [];
    if (supportsReactions) {
      footerParts.push(q.allowMultiple ? "Reply with comma-separated choices (`1,3`) or react with matching numbers" : "Reply with a number or react with the matching number");
    } else {
      footerParts.push(`Question ${questionIndex + 1}/${prompt.questions.length} \u2014 reply with one line per question or use semicolons`);
    }
    footerParts.push(`Source: ${prompt.context.source}`);
    return {
      title: q.header,
      description: q.question,
      color: 8141549,
      fields: [{ name: "Options", value: optionLines.join("\n") }],
      footer: { text: footerParts.join(" \xB7 ") }
    };
  });
  return { embeds, reactionEmojis };
}
function formatForSlack(prompt) {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: "GSD needs your input" } }
  ];
  if (prompt.questions.length > 1) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Reply once in thread using one line per question or semicolons (`1; 2; custom note`)." }]
    });
  }
  for (const q of prompt.questions) {
    const supportsReactions = prompt.questions.length === 1;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${q.header}*
${q.question}` } });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: q.options.map((opt, i) => `${i + 1}. *${opt.label}* \u2014 ${opt.description}`).join("\n") }
    });
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: prompt.questions.length > 1 ? q.allowMultiple ? "For this question, use comma-separated numbers (`1,3`) or free text." : "For this question, use one number (`1`) or free text." : q.allowMultiple ? supportsReactions ? "Reply in thread with comma-separated numbers (`1,3`) or react with matching number emoji." : "Reply in thread with comma-separated numbers (`1,3`) or free text." : supportsReactions ? "Reply in thread with a number (`1`) or react with the matching number emoji." : "Reply in thread with a number (`1`) or free text."
      }]
    });
    blocks.push({ type: "divider" });
  }
  return blocks;
}
function formatForTelegram(prompt) {
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = ["<b>GSD needs your input</b>", ""];
  for (let qi = 0; qi < prompt.questions.length; qi++) {
    const q = prompt.questions[qi];
    lines.push(`<b>${escape(q.header)}</b>`);
    lines.push(escape(q.question));
    lines.push("");
    for (let i = 0; i < q.options.length; i++) {
      lines.push(`${i + 1}. <b>${escape(q.options[i].label)}</b> \u2014 ${escape(q.options[i].description)}`);
    }
    lines.push("");
    if (prompt.questions.length === 1) {
      lines.push(q.allowMultiple ? "Reply with comma-separated numbers (1,3) or free text." : "Reply with a number or tap a button below.");
    } else {
      lines.push(`Question ${qi + 1}/${prompt.questions.length} \u2014 reply with one line per question or use semicolons.`);
    }
    if (qi < prompt.questions.length - 1) lines.push("");
  }
  const result = {
    text: lines.join("\n"),
    parse_mode: "HTML"
  };
  if (prompt.questions.length === 1 && prompt.questions[0].options.length <= 5) {
    result.reply_markup = {
      inline_keyboard: prompt.questions[0].options.map((opt, i) => [{
        text: `${i + 1}. ${opt.label}`,
        callback_data: `${prompt.id}:${i}`
      }])
    };
  }
  return result;
}
function parseAnswerForQuestion(text, q) {
  if (!text) return { answers: [], user_note: "No response provided" };
  if (/^[\d,\s]+$/.test(text)) {
    const nums = text.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n) && n >= 1 && n <= q.options.length);
    if (nums.length > 0) {
      const selected = nums.map((n) => q.options[n - 1].label);
      return { answers: q.allowMultiple ? selected : [selected[0]] };
    }
  }
  const single = parseInt(text, 10);
  if (!Number.isNaN(single) && single >= 1 && single <= q.options.length) {
    return { answers: [q.options[single - 1].label] };
  }
  const truncated = text.length > 500 ? text.slice(0, 500) + "\u2026" : text;
  return { answers: [], user_note: truncated };
}
function parseTextReply(text, questions) {
  const answers = {};
  const trimmed = text.trim();
  if (questions.length === 1) {
    answers[questions[0].id] = parseAnswerForQuestion(trimmed, questions[0]);
    return { answers };
  }
  const parts = trimmed.includes(";") ? trimmed.split(";").map((s) => s.trim()).filter(Boolean) : trimmed.split("\n").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < questions.length; i++) {
    answers[questions[i].id] = parseAnswerForQuestion(parts[i] ?? "", questions[i]);
  }
  return { answers };
}
function parseDiscordReactions(reactions, questions) {
  const answers = {};
  if (questions.length !== 1) {
    for (const q2 of questions) {
      answers[q2.id] = { answers: [], user_note: "Discord reactions are only supported for single-question prompts" };
    }
    return { answers };
  }
  const q = questions[0];
  const picked = reactions.filter((r) => DISCORD_NUMBER_EMOJIS.includes(r.emoji) && r.count > 0).map((r) => q.options[DISCORD_NUMBER_EMOJIS.indexOf(r.emoji)]?.label).filter((l) => Boolean(l));
  answers[q.id] = picked.length > 0 ? { answers: q.allowMultiple ? picked : [picked[0]] } : { answers: [], user_note: "No clear response via reactions" };
  return { answers };
}
function parseSlackReactions(reactionNames, questions) {
  const answers = {};
  if (questions.length !== 1) {
    for (const q2 of questions) {
      answers[q2.id] = { answers: [], user_note: "Slack reactions are only supported for single-question prompts" };
    }
    return { answers };
  }
  const q = questions[0];
  const picked = reactionNames.filter((name) => SLACK_NUMBER_REACTION_NAMES.includes(name)).map((name) => q.options[SLACK_NUMBER_REACTION_NAMES.indexOf(name)]?.label).filter((l) => Boolean(l));
  answers[q.id] = picked.length > 0 ? { answers: q.allowMultiple ? picked : [picked[0]] } : { answers: [], user_note: "No clear response via reactions" };
  return { answers };
}
function parseTelegramCallbackData(callbackData, questions, promptId) {
  const pattern = new RegExp(`^${promptId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)$`);
  const match = callbackData.match(pattern);
  if (match && questions.length === 1) {
    const idx = parseInt(match[1], 10);
    const q = questions[0];
    if (idx >= 0 && idx < q.options.length) {
      return { answers: { [q.id]: { answers: [q.options[idx].label] } } };
    }
  }
  return null;
}
async function discordValidate(token, channelId) {
  const meRes = await apiRequest(`${DISCORD_API}/users/@me`, "GET", void 0, "Bot", token, "Discord API");
  if (!meRes["id"]) throw new Error("Discord auth failed: invalid token");
  const botUserId = String(meRes["id"]);
  let guildId = null;
  try {
    const chanRes = await apiRequest(`${DISCORD_API}/channels/${channelId}`, "GET", void 0, "Bot", token, "Discord API");
    if (chanRes["guild_id"]) guildId = String(chanRes["guild_id"]);
  } catch {
  }
  return { botUserId, guildId };
}
async function discordSend(prompt, token, channelId, guildId) {
  const { embeds, reactionEmojis } = formatForDiscord(prompt);
  const res = await apiRequest(
    `${DISCORD_API}/channels/${channelId}/messages`,
    "POST",
    { content: "**GSD needs your input** \u2014 reply to this message with your answer", embeds },
    "Bot",
    token,
    "Discord API"
  );
  if (!res["id"]) throw new Error(`Discord send failed: ${JSON.stringify(res)}`);
  const messageId = String(res["id"]);
  if (prompt.questions.length === 1) {
    for (const emoji of reactionEmojis) {
      try {
        await apiRequest(`${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, "PUT", void 0, "Bot", token, "Discord API");
      } catch {
      }
    }
  }
  const threadUrl = guildId ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : void 0;
  return { ref: { id: prompt.id, channel: "discord", messageId, channelId, threadUrl } };
}
async function discordPoll(prompt, ref, token, botUserId) {
  if (prompt.questions.length === 1) {
    const reactions = [];
    for (const emoji of DISCORD_NUMBER_EMOJIS) {
      try {
        const users = await apiRequest(
          `${DISCORD_API}/channels/${ref.channelId}/messages/${ref.messageId}/reactions/${encodeURIComponent(emoji)}`,
          "GET",
          void 0,
          "Bot",
          token,
          "Discord API"
        );
        if (Array.isArray(users)) {
          const humanUsers = users.filter((u) => u["id"] !== botUserId);
          if (humanUsers.length > 0) reactions.push({ emoji, count: humanUsers.length });
        }
      } catch (err) {
        const msg = String(err.message ?? "");
        if (msg.includes("HTTP 404")) continue;
        if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) throw err;
      }
    }
    if (reactions.length > 0) return parseDiscordReactions(reactions, prompt.questions);
  }
  const messages = await apiRequest(
    `${DISCORD_API}/channels/${ref.channelId}/messages?after=${ref.messageId}&limit=10`,
    "GET",
    void 0,
    "Bot",
    token,
    "Discord API"
  );
  if (!Array.isArray(messages)) return null;
  const replies = messages.filter((m) => {
    const msg = m;
    const author = msg["author"];
    const msgRef = msg["message_reference"];
    return author?.["id"] && author["id"] !== botUserId && msgRef?.["message_id"] === ref.messageId && msg["content"];
  });
  if (replies.length === 0) return null;
  const first = replies[0];
  return parseTextReply(String(first["content"]), prompt.questions);
}
async function discordAcknowledge(ref, token) {
  try {
    await apiRequest(
      `${DISCORD_API}/channels/${ref.channelId}/messages/${ref.messageId}/reactions/${encodeURIComponent("\u2705")}/@me`,
      "PUT",
      void 0,
      "Bot",
      token,
      "Discord API"
    );
  } catch {
  }
}
async function slackValidate(token) {
  const res = await apiRequest(`${SLACK_API}/auth.test`, "GET", void 0, "Bearer", token, "Slack API");
  if (!res["ok"]) throw new Error(`Slack auth failed: ${res["error"] ?? "invalid token"}`);
  return String(res["user_id"] ?? "");
}
async function slackSend(prompt, token, channelId) {
  const res = await apiRequest(
    `${SLACK_API}/chat.postMessage`,
    "POST",
    { channel: channelId, text: "GSD needs your input", blocks: formatForSlack(prompt) },
    "Bearer",
    token,
    "Slack API"
  );
  if (!res["ok"]) throw new Error(`Slack postMessage failed: ${res["error"] ?? "unknown"}`);
  const ts = String(res["ts"]);
  const channel = String(res["channel"]);
  if (prompt.questions.length === 1) {
    const reactionNames = SLACK_NUMBER_REACTION_NAMES.slice(0, prompt.questions[0].options.length);
    for (const name of reactionNames) {
      try {
        await apiRequest(`${SLACK_API}/reactions.add`, "POST", { channel, timestamp: ts, name }, "Bearer", token, "Slack API");
      } catch {
      }
    }
  }
  return {
    ref: {
      id: prompt.id,
      channel: "slack",
      messageId: ts,
      threadTs: ts,
      channelId: channel,
      threadUrl: `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`
    }
  };
}
async function slackPoll(prompt, ref, token, botUserId) {
  if (prompt.questions.length === 1) {
    const qs2 = new URLSearchParams({ channel: ref.channelId, timestamp: ref.messageId, full: "true" }).toString();
    const res2 = await apiRequest(`${SLACK_API}/reactions.get?${qs2}`, "GET", void 0, "Bearer", token, "Slack API");
    if (res2["ok"]) {
      const message = res2["message"] ?? {};
      const reactions = Array.isArray(message.reactions) ? message.reactions : [];
      const picked = reactions.filter((r) => r.name && SLACK_NUMBER_REACTION_NAMES.includes(r.name)).filter((r) => {
        const count = Number(r.count ?? 0);
        const users = Array.isArray(r.users) ? r.users.map(String) : [];
        const botIncluded = botUserId ? users.includes(botUserId) : false;
        return count > (botIncluded ? 1 : 0);
      }).map((r) => String(r.name));
      if (picked.length > 0) return parseSlackReactions(picked, prompt.questions);
    }
  }
  const qs = new URLSearchParams({ channel: ref.channelId, ts: ref.threadTs, limit: "20" }).toString();
  const res = await apiRequest(`${SLACK_API}/conversations.replies?${qs}`, "GET", void 0, "Bearer", token, "Slack API");
  if (!res["ok"]) return null;
  const messages = res["messages"] ?? [];
  const userReplies = messages.filter((m) => m.ts !== ref.threadTs && m.user && m.user !== botUserId && m.text);
  if (userReplies.length === 0) return null;
  return parseTextReply(String(userReplies[0].text), prompt.questions);
}
async function slackAcknowledge(ref, token) {
  try {
    await apiRequest(
      `${SLACK_API}/reactions.add`,
      "POST",
      { channel: ref.channelId, timestamp: ref.messageId, name: "white_check_mark" },
      "Bearer",
      token,
      "Slack API"
    );
  } catch {
  }
}
async function telegramValidate(token) {
  const res = await apiRequest(`${TELEGRAM_API}/bot${token}/getMe`, "GET", void 0, "Bearer", token, "Telegram API");
  const result = res["result"];
  if (!res["ok"] || !result?.["id"]) throw new Error("Telegram auth failed: invalid bot token");
  return result["id"];
}
async function telegramSend(prompt, token, chatId) {
  const payload = formatForTelegram(prompt);
  const params = { chat_id: chatId, text: payload.text, parse_mode: payload.parse_mode };
  if (payload.reply_markup) params["reply_markup"] = payload.reply_markup;
  const res = await apiRequest(`${TELEGRAM_API}/bot${token}/sendMessage`, "POST", params, "Bearer", token, "Telegram API");
  const result = res["result"];
  if (!res["ok"] || !result?.["message_id"]) throw new Error(`Telegram sendMessage failed: ${JSON.stringify(res)}`);
  const messageId = String(result["message_id"]);
  const isPublic = !chatId.startsWith("-");
  const messageUrl = isPublic ? `https://t.me/${chatId.replace("@", "")}/${messageId}` : void 0;
  return { ref: { id: prompt.id, channel: "telegram", messageId, channelId: chatId, threadUrl: messageUrl } };
}
async function telegramPoll(prompt, ref, token, botUserId, lastUpdateId) {
  const params = {
    offset: lastUpdateId.value + 1,
    timeout: 0,
    allowed_updates: ["message", "callback_query"]
  };
  const res = await apiRequest(`${TELEGRAM_API}/bot${token}/getUpdates`, "POST", params, "Bearer", token, "Telegram API");
  if (!res["ok"] || !Array.isArray(res["result"])) return null;
  for (const update of res["result"]) {
    if (update["update_id"] > lastUpdateId.value) {
      lastUpdateId.value = update["update_id"];
    }
    if (update["callback_query"]) {
      const cq = update["callback_query"];
      const msg = cq["message"];
      const from = cq["from"];
      if (msg && String(msg["chat"]?.["id"]) === ref.channelId && String(msg["message_id"]) === ref.messageId && from?.["id"] !== botUserId) {
        try {
          await apiRequest(`${TELEGRAM_API}/bot${token}/answerCallbackQuery`, "POST", { callback_query_id: cq["id"] }, "Bearer", token, "Telegram API");
        } catch {
        }
        const callbackData = cq["data"] ? String(cq["data"]) : null;
        if (callbackData) {
          const parsed = parseTelegramCallbackData(callbackData, prompt.questions, prompt.id);
          if (parsed) return parsed;
        }
      }
    }
    if (update["message"]) {
      const msg = update["message"];
      const from = msg["from"];
      if (String(msg["chat"]?.["id"]) === ref.channelId && from?.["id"] !== botUserId && msg["text"]) {
        return parseTextReply(String(msg["text"]), prompt.questions);
      }
    }
  }
  return null;
}
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
async function pollUntilDone(config, prompt, ref, state, signal) {
  while (Date.now() < prompt.timeoutAt && !signal?.aborted) {
    try {
      let answer = null;
      if (config.channel === "discord") {
        answer = await discordPoll(prompt, ref, config.token, String(state.botUserId));
      } else if (config.channel === "slack") {
        answer = await slackPoll(prompt, ref, config.token, String(state.botUserId));
      } else {
        answer = await telegramPoll(prompt, ref, config.token, state.botUserId, state.lastUpdateId);
      }
      if (answer) return answer;
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) {
        throw err;
      }
    }
    await sleep(prompt.pollIntervalMs, signal);
  }
  return null;
}
function buildPrompt(questions, config) {
  const createdAt = Date.now();
  return {
    id: randomUUID(),
    channel: config.channel,
    createdAt,
    timeoutAt: createdAt + config.timeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    context: { source: "ask_user_questions" },
    questions: questions.map((q) => ({
      id: q.id,
      header: q.header,
      question: q.question,
      options: q.options,
      allowMultiple: q.allowMultiple ?? false
    }))
  };
}
function formatForTool(answer) {
  const out = {};
  for (const [id, data] of Object.entries(answer.answers)) {
    const list = [...data.answers];
    if (data.user_note) list.push(`user_note: ${data.user_note}`);
    out[id] = { answers: list };
  }
  return out;
}
function toRoundResultResponse(answer, questions) {
  const allowMultipleById = /* @__PURE__ */ new Map();
  for (const q of questions) allowMultipleById.set(q.id, q.allowMultiple ?? false);
  const normalized = {};
  for (const [id, data] of Object.entries(answer.answers)) {
    const list = data.answers ?? [];
    const allowMultiple = allowMultipleById.get(id) ?? false;
    const selected = allowMultiple ? list : list[0] ?? "";
    normalized[id] = { selected, notes: data.user_note ?? "" };
  }
  return { endInterview: false, answers: normalized };
}
async function tryRemoteQuestions(questions, signal) {
  const config = resolveRemoteConfig();
  if (!config) return null;
  const prompt = buildPrompt(questions, config);
  let ref;
  let state;
  try {
    if (config.channel === "discord") {
      const { botUserId, guildId } = await discordValidate(config.token, config.channelId);
      state = { botUserId, guildId };
      const dispatch = await discordSend(prompt, config.token, config.channelId, guildId);
      ref = dispatch.ref;
    } else if (config.channel === "slack") {
      const botUserId = await slackValidate(config.token);
      state = { botUserId };
      const dispatch = await slackSend(prompt, config.token, config.channelId);
      ref = dispatch.ref;
    } else {
      const botUserId = await telegramValidate(config.token);
      state = { botUserId, lastUpdateId: { value: 0 } };
      const dispatch = await telegramSend(prompt, config.token, config.channelId);
      ref = dispatch.ref;
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: `Remote questions failed (${config.channel}): ${err.message}` }],
      details: { remote: true, channel: config.channel, error: true, status: "failed" }
    };
  }
  let answer;
  try {
    answer = await pollUntilDone(config, prompt, ref, state, signal);
  } catch (err) {
    return {
      content: [{ type: "text", text: `Remote questions failed (${config.channel}): ${err.message}` }],
      details: { remote: true, channel: config.channel, error: true, status: "failed" }
    };
  }
  if (!answer) {
    const timedOut = !signal?.aborted;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          timed_out: timedOut,
          channel: config.channel,
          prompt_id: prompt.id,
          timeout_minutes: config.timeoutMs / 6e4,
          thread_url: ref.threadUrl ?? null,
          message: `User did not respond within ${config.timeoutMs / 6e4} minutes.`
        })
      }],
      details: {
        remote: true,
        channel: config.channel,
        timed_out: timedOut,
        promptId: prompt.id,
        threadUrl: ref.threadUrl ?? null,
        status: signal?.aborted ? "cancelled" : "timed_out"
      }
    };
  }
  try {
    if (config.channel === "discord") await discordAcknowledge(ref, config.token);
    else if (config.channel === "slack") await slackAcknowledge(ref, config.token);
  } catch {
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ answers: formatForTool(answer) }) }],
    details: {
      remote: true,
      channel: config.channel,
      timed_out: false,
      promptId: prompt.id,
      threadUrl: ref.threadUrl ?? null,
      questions,
      response: toRoundResultResponse(answer, questions),
      status: "answered"
    }
  };
}
export {
  isRemoteConfigured,
  toRoundResultResponse,
  tryRemoteQuestions
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvbWNwLXNlcnZlci9zcmMvcmVtb3RlLXF1ZXN0aW9ucy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSZW1vdGUgUXVlc3Rpb25zIFx1MjAxNCBzZWxmLWNvbnRhaW5lZCBNQ1Atc2VydmVyIGFkYXB0ZXJcbiAqXG4gKiBNaXJyb3JzIHRoZSByb3V0aW5nIGxvZ2ljIGZyb20gc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Fzay11c2VyLXF1ZXN0aW9ucy50c1xuICogYnV0IHdpdGhvdXQgYW55IGRlcGVuZGVuY3kgb24gQGdzZC9waS1jb2RpbmctYWdlbnQgb3IgdGhlIG1haW4gc3JjLyB0cmVlLlxuICogQWxsIGNoYW5uZWwgYWRhcHRlcnMgKERpc2NvcmQsIFNsYWNrLCBUZWxlZ3JhbSksIGNvbmZpZyByZXNvbHV0aW9uLCBIVFRQXG4gKiBjYWxscywgYW5kIHBvbGxpbmcgYXJlIGlubGluZWQgaGVyZSBzbyBwYWNrYWdlcy9tY3Atc2VydmVyIHJlbWFpbnMgYVxuICogc3RhbmRhbG9uZSBwYWNrYWdlLlxuICpcbiAqIEVudHJ5IHBvaW50cyBjb25zdW1lZCBieSBzZXJ2ZXIudHM6XG4gKiAgIGlzUmVtb3RlQ29uZmlndXJlZCgpICAgICBcdTIwMTQgY2hlYXAgc3luY2hyb25vdXMgY29uZmlnIGNoZWNrXG4gKiAgIHRyeVJlbW90ZVF1ZXN0aW9ucyguLi4pICBcdTIwMTQgZGlzcGF0Y2ggKyBwb2xsICsgcmV0dXJuIHJlc3VsdFxuICovXG5cbmltcG9ydCB7IHJlYWRGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFR5cGVzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxudHlwZSBSZW1vdGVDaGFubmVsID0gJ3NsYWNrJyB8ICdkaXNjb3JkJyB8ICd0ZWxlZ3JhbSc7XG5cbmludGVyZmFjZSBRdWVzdGlvbk9wdGlvbiB7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVtb3RlUXVlc3Rpb24ge1xuICBpZDogc3RyaW5nO1xuICBoZWFkZXI6IHN0cmluZztcbiAgcXVlc3Rpb246IHN0cmluZztcbiAgb3B0aW9uczogUXVlc3Rpb25PcHRpb25bXTtcbiAgYWxsb3dNdWx0aXBsZT86IGJvb2xlYW47XG59XG5cbmludGVyZmFjZSBSZW1vdGVQcm9tcHQge1xuICBpZDogc3RyaW5nO1xuICBjaGFubmVsOiBSZW1vdGVDaGFubmVsO1xuICBjcmVhdGVkQXQ6IG51bWJlcjtcbiAgdGltZW91dEF0OiBudW1iZXI7XG4gIHBvbGxJbnRlcnZhbE1zOiBudW1iZXI7XG4gIHF1ZXN0aW9uczogUmVtb3RlUXVlc3Rpb25bXTtcbiAgY29udGV4dDogeyBzb3VyY2U6IHN0cmluZyB9O1xufVxuXG5pbnRlcmZhY2UgUmVtb3RlUHJvbXB0UmVmIHtcbiAgaWQ6IHN0cmluZztcbiAgY2hhbm5lbDogUmVtb3RlQ2hhbm5lbDtcbiAgbWVzc2FnZUlkOiBzdHJpbmc7XG4gIGNoYW5uZWxJZDogc3RyaW5nO1xuICB0aHJlYWRUcz86IHN0cmluZztcbiAgdGhyZWFkVXJsPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgUmVtb3RlQW5zd2VyIHtcbiAgYW5zd2VyczogUmVjb3JkPHN0cmluZywgeyBhbnN3ZXJzOiBzdHJpbmdbXTsgdXNlcl9ub3RlPzogc3RyaW5nIH0+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlbW90ZVRvb2xSZXN1bHQge1xuICBjb250ZW50OiBBcnJheTx7IHR5cGU6ICd0ZXh0JzsgdGV4dDogc3RyaW5nIH0+O1xuICBkZXRhaWxzPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG59XG5cbmludGVyZmFjZSBSZXNvbHZlZENvbmZpZyB7XG4gIGNoYW5uZWw6IFJlbW90ZUNoYW5uZWw7XG4gIGNoYW5uZWxJZDogc3RyaW5nO1xuICB0aW1lb3V0TXM6IG51bWJlcjtcbiAgcG9sbEludGVydmFsTXM6IG51bWJlcjtcbiAgdG9rZW46IHN0cmluZztcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBDb25zdGFudHNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5jb25zdCBQRVJfUkVRVUVTVF9USU1FT1VUX01TID0gMTVfMDAwO1xuY29uc3QgRElTQ09SRF9BUEkgPSAnaHR0cHM6Ly9kaXNjb3JkLmNvbS9hcGkvdjEwJztcbmNvbnN0IFNMQUNLX0FQSSA9ICdodHRwczovL3NsYWNrLmNvbS9hcGknO1xuY29uc3QgVEVMRUdSQU1fQVBJID0gJ2h0dHBzOi8vYXBpLnRlbGVncmFtLm9yZyc7XG5cbmNvbnN0IERJU0NPUkRfTlVNQkVSX0VNT0pJUyA9IFsnMVx1RkUwRlx1MjBFMycsICcyXHVGRTBGXHUyMEUzJywgJzNcdUZFMEZcdTIwRTMnLCAnNFx1RkUwRlx1MjBFMycsICc1XHVGRTBGXHUyMEUzJ107XG5jb25zdCBTTEFDS19OVU1CRVJfUkVBQ1RJT05fTkFNRVMgPSBbJ29uZScsICd0d28nLCAndGhyZWUnLCAnZm91cicsICdmaXZlJ107XG5cbmNvbnN0IERFRkFVTFRfVElNRU9VVF9NSU5VVEVTID0gNTtcbmNvbnN0IERFRkFVTFRfUE9MTF9JTlRFUlZBTF9TRUNPTkRTID0gNTtcbmNvbnN0IE1JTl9USU1FT1VUX01JTlVURVMgPSAxO1xuY29uc3QgTUFYX1RJTUVPVVRfTUlOVVRFUyA9IDMwO1xuY29uc3QgTUlOX1BPTExfSU5URVJWQUxfU0VDT05EUyA9IDI7XG5jb25zdCBNQVhfUE9MTF9JTlRFUlZBTF9TRUNPTkRTID0gMzA7XG5cbmNvbnN0IENIQU5ORUxfSURfUEFUVEVSTlM6IFJlY29yZDxSZW1vdGVDaGFubmVsLCBSZWdFeHA+ID0ge1xuICBzbGFjazogL15bQS1aMC05XXs5LDEyfSQvLFxuICBkaXNjb3JkOiAvXlxcZHsxNywyMH0kLyxcbiAgdGVsZWdyYW06IC9eLT9cXGR7NSwyMH0kLyxcbn07XG5cbmNvbnN0IEVOVl9LRVlTOiBSZWNvcmQ8UmVtb3RlQ2hhbm5lbCwgc3RyaW5nPiA9IHtcbiAgc2xhY2s6ICdTTEFDS19CT1RfVE9LRU4nLFxuICBkaXNjb3JkOiAnRElTQ09SRF9CT1RfVE9LRU4nLFxuICB0ZWxlZ3JhbTogJ1RFTEVHUkFNX0JPVF9UT0tFTicsXG59O1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIENvbmZpZyByZXNvbHV0aW9uIFx1MjAxNCByZWFkcyB+Ly5nc2QvUFJFRkVSRU5DRVMubWQgWUFNTCBmcm9udG1hdHRlclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIGNsYW1wTnVtYmVyKHZhbHVlOiB1bmtub3duLCBmYWxsYmFjazogbnVtYmVyLCBtaW46IG51bWJlciwgbWF4OiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyA/IHZhbHVlIDogTnVtYmVyKHZhbHVlKTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobikpIHJldHVybiBmYWxsYmFjaztcbiAgcmV0dXJuIE1hdGgubWF4KG1pbiwgTWF0aC5taW4obWF4LCBuKSk7XG59XG5cbi8qKlxuICogTWluaW1hbCBZQU1MIGZyb250bWF0dGVyIHJlYWRlci4gSGFuZGxlczpcbiAqICAgLS0tXG4gKiAgIGtleTogdmFsdWVcbiAqICAgbmVzdGVkX2tleTpcbiAqICAgICBjaGlsZDogdmFsdWVcbiAqICAgLS0tXG4gKiBTdWZmaWNpZW50IGZvciB0aGUgZmxhdCByZW1vdGVfcXVlc3Rpb25zIGNvbmZpZyBibG9jay5cbiAqL1xuZnVuY3Rpb24gcGFyc2VTaW1wbGVGcm9udG1hdHRlcihjb250ZW50OiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IG1hdGNoID0gY29udGVudC5tYXRjaCgvXi0tLVxccj9cXG4oW1xcc1xcU10qPylcXHI/XFxuLS0tL20pO1xuICBpZiAoIW1hdGNoKSByZXR1cm4ge307XG5cbiAgY29uc3QgeWFtbCA9IG1hdGNoWzFdO1xuICBjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIGxldCBjdXJyZW50U2VjdGlvbjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHNlY3Rpb25EYXRhOiBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4gPSB7fTtcblxuICBmb3IgKGNvbnN0IHJhd0xpbmUgb2YgeWFtbC5zcGxpdCgnXFxuJykpIHtcbiAgICBjb25zdCBsaW5lID0gcmF3TGluZS5yZXBsYWNlKC9cXHIkLywgJycpO1xuICAgIGlmICghbGluZS50cmltKCkgfHwgbGluZS50cmltKCkuc3RhcnRzV2l0aCgnIycpKSBjb250aW51ZTtcblxuICAgIC8vIFRvcC1sZXZlbCBrZXkgKG5vIGluZGVudClcbiAgICBjb25zdCB0b3BNYXRjaCA9IGxpbmUubWF0Y2goL14oW2EtekEtWl9dW2EtekEtWjAtOV9dKik6XFxzKiguKikkLyk7XG4gICAgaWYgKHRvcE1hdGNoKSB7XG4gICAgICBjdXJyZW50U2VjdGlvbiA9IHRvcE1hdGNoWzFdO1xuICAgICAgY29uc3QgdmFsID0gdG9wTWF0Y2hbMl0udHJpbSgpO1xuICAgICAgaWYgKHZhbCkge1xuICAgICAgICByZXN1bHRbY3VycmVudFNlY3Rpb25dID0gcGFyc2VTaW1wbGVTY2FsYXIodmFsKTtcbiAgICAgICAgY3VycmVudFNlY3Rpb24gPSBudWxsOyAvLyBzY2FsYXIsIG5vIGNoaWxkcmVuXG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZWN0aW9uRGF0YVtjdXJyZW50U2VjdGlvbl0gPSB7fTtcbiAgICAgICAgcmVzdWx0W2N1cnJlbnRTZWN0aW9uXSA9IHNlY3Rpb25EYXRhW2N1cnJlbnRTZWN0aW9uXTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIEluZGVudGVkIGNoaWxkIGtleVxuICAgIGNvbnN0IGNoaWxkTWF0Y2ggPSBsaW5lLm1hdGNoKC9eXFxzKyhbYS16QS1aX11bYS16QS1aMC05X10qKTpcXHMqKC4qKSQvKTtcbiAgICBpZiAoY2hpbGRNYXRjaCAmJiBjdXJyZW50U2VjdGlvbiAmJiBzZWN0aW9uRGF0YVtjdXJyZW50U2VjdGlvbl0pIHtcbiAgICAgIGNvbnN0IGNoaWxkS2V5ID0gY2hpbGRNYXRjaFsxXTtcbiAgICAgIGNvbnN0IGNoaWxkVmFsID0gY2hpbGRNYXRjaFsyXS50cmltKCk7XG4gICAgICBzZWN0aW9uRGF0YVtjdXJyZW50U2VjdGlvbl1bY2hpbGRLZXldID0gcGFyc2VTaW1wbGVTY2FsYXIoY2hpbGRWYWwpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZXN1bHQ7XG59XG5cbmZ1bmN0aW9uIHBhcnNlU2ltcGxlU2NhbGFyKHJhdzogc3RyaW5nKTogc3RyaW5nIHwgbnVtYmVyIHwgYm9vbGVhbiB8IG51bGwge1xuICBjb25zdCBzID0gcmF3LnJlcGxhY2UoL15bXCInXXxbXCInXSQvZywgJycpLnRyaW0oKTtcbiAgaWYgKHMgPT09ICd0cnVlJykgcmV0dXJuIHRydWU7XG4gIGlmIChzID09PSAnZmFsc2UnKSByZXR1cm4gZmFsc2U7XG4gIGlmIChzID09PSAnbnVsbCcgfHwgcyA9PT0gJ34nKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgbiA9IE51bWJlcihzKTtcbiAgaWYgKHMgIT09ICcnICYmICFOdW1iZXIuaXNOYU4obikpIHJldHVybiBuO1xuICByZXR1cm4gcztcbn1cblxuZnVuY3Rpb24gbG9hZFByZWZlcmVuY2VzRnJvbUZpbGUocGF0aDogc3RyaW5nKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKHBhdGgsICd1dGYtOCcpO1xuICAgIHJldHVybiBwYXJzZVNpbXBsZUZyb250bWF0dGVyKGNvbnRlbnQpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNvbHZlUmVtb3RlQ29uZmlnKCk6IFJlc29sdmVkQ29uZmlnIHwgbnVsbCB7XG4gIGNvbnN0IGdzZEhvbWUgPSBwcm9jZXNzLmVudlsnR1NEX0hPTUUnXSA/PyBqb2luKGhvbWVkaXIoKSwgJy5nc2QnKTtcbiAgY29uc3QgZ2xvYmFsUGF0aCA9IGpvaW4oZ3NkSG9tZSwgJ1BSRUZFUkVOQ0VTLm1kJyk7XG5cbiAgY29uc3QgcHJlZnMgPSBsb2FkUHJlZmVyZW5jZXNGcm9tRmlsZShnbG9iYWxQYXRoKTtcbiAgaWYgKCFwcmVmcykgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgcnEgPSBwcmVmc1sncmVtb3RlX3F1ZXN0aW9ucyddIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICBpZiAoIXJxIHx8ICFycVsnY2hhbm5lbCddIHx8ICFycVsnY2hhbm5lbF9pZCddKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBjaGFubmVsID0gU3RyaW5nKHJxWydjaGFubmVsJ10pIGFzIFJlbW90ZUNoYW5uZWw7XG4gIGlmIChjaGFubmVsICE9PSAnc2xhY2snICYmIGNoYW5uZWwgIT09ICdkaXNjb3JkJyAmJiBjaGFubmVsICE9PSAndGVsZWdyYW0nKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBjaGFubmVsSWQgPSBTdHJpbmcocnFbJ2NoYW5uZWxfaWQnXSk7XG4gIGlmICghQ0hBTk5FTF9JRF9QQVRURVJOU1tjaGFubmVsXS50ZXN0KGNoYW5uZWxJZCkpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IHRva2VuID0gcHJvY2Vzcy5lbnZbRU5WX0tFWVNbY2hhbm5lbF1dO1xuICBpZiAoIXRva2VuKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCB0aW1lb3V0TXMgPSBjbGFtcE51bWJlcihycVsndGltZW91dF9taW51dGVzJ10sIERFRkFVTFRfVElNRU9VVF9NSU5VVEVTLCBNSU5fVElNRU9VVF9NSU5VVEVTLCBNQVhfVElNRU9VVF9NSU5VVEVTKSAqIDYwICogMTAwMDtcbiAgY29uc3QgcG9sbEludGVydmFsTXMgPSBjbGFtcE51bWJlcihycVsncG9sbF9pbnRlcnZhbF9zZWNvbmRzJ10sIERFRkFVTFRfUE9MTF9JTlRFUlZBTF9TRUNPTkRTLCBNSU5fUE9MTF9JTlRFUlZBTF9TRUNPTkRTLCBNQVhfUE9MTF9JTlRFUlZBTF9TRUNPTkRTKSAqIDEwMDA7XG5cbiAgcmV0dXJuIHsgY2hhbm5lbCwgY2hhbm5lbElkLCB0aW1lb3V0TXMsIHBvbGxJbnRlcnZhbE1zLCB0b2tlbiB9O1xufVxuXG4vKipcbiAqIENoZWFwIHN5bmNocm9ub3VzIGNoZWNrIFx1MjAxNCBkb2VzIG5vdCBtYWtlIGFueSBIVFRQIHJlcXVlc3RzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNSZW1vdGVDb25maWd1cmVkKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gcmVzb2x2ZVJlbW90ZUNvbmZpZygpICE9PSBudWxsO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEhUVFAgaGVscGVyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuYXN5bmMgZnVuY3Rpb24gYXBpUmVxdWVzdChcbiAgdXJsOiBzdHJpbmcsXG4gIG1ldGhvZDogJ0dFVCcgfCAnUE9TVCcgfCAnUFVUJyB8ICdERUxFVEUnLFxuICBib2R5OiB1bmtub3duLFxuICBhdXRoU2NoZW1lOiAnQmVhcmVyJyB8ICdCb3QnLFxuICBhdXRoVG9rZW46IHN0cmluZyxcbiAgZXJyb3JMYWJlbDogc3RyaW5nLFxuKTogUHJvbWlzZTx1bmtub3duPiB7XG4gIGNvbnN0IGhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgQXV0aG9yaXphdGlvbjogYCR7YXV0aFNjaGVtZX0gJHthdXRoVG9rZW59YCxcbiAgfTtcblxuICBjb25zdCBpbml0OiBSZXF1ZXN0SW5pdCA9IHtcbiAgICBtZXRob2QsXG4gICAgaGVhZGVycyxcbiAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoUEVSX1JFUVVFU1RfVElNRU9VVF9NUyksXG4gIH07XG5cbiAgaWYgKGJvZHkgIT09IHVuZGVmaW5lZCkge1xuICAgIGhlYWRlcnNbJ0NvbnRlbnQtVHlwZSddID0gJ2FwcGxpY2F0aW9uL2pzb24nO1xuICAgIGluaXQuYm9keSA9IEpTT04uc3RyaW5naWZ5KGJvZHkpO1xuICB9XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaCh1cmwsIGluaXQpO1xuXG4gIGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDIwNCkgcmV0dXJuIHt9O1xuXG4gIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpLmNhdGNoKCgpID0+ICcnKTtcbiAgICBjb25zdCBzYWZlVGV4dCA9IHRleHQubGVuZ3RoID4gMjAwID8gdGV4dC5zbGljZSgwLCAyMDApICsgJ1xcdTIwMjYnIDogdGV4dDtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYCR7ZXJyb3JMYWJlbH0gSFRUUCAke3Jlc3BvbnNlLnN0YXR1c306ICR7c2FmZVRleHR9YCk7XG4gIH1cblxuICByZXR1cm4gcmVzcG9uc2UuanNvbigpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFBheWxvYWQgZm9ybWF0dGluZ1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIGZvcm1hdEZvckRpc2NvcmQocHJvbXB0OiBSZW1vdGVQcm9tcHQpOiB7IGVtYmVkczogdW5rbm93bltdOyByZWFjdGlvbkVtb2ppczogc3RyaW5nW10gfSB7XG4gIGNvbnN0IHJlYWN0aW9uRW1vamlzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBlbWJlZHMgPSBwcm9tcHQucXVlc3Rpb25zLm1hcCgocSwgcXVlc3Rpb25JbmRleCkgPT4ge1xuICAgIGNvbnN0IHN1cHBvcnRzUmVhY3Rpb25zID0gcHJvbXB0LnF1ZXN0aW9ucy5sZW5ndGggPT09IDE7XG4gICAgY29uc3Qgb3B0aW9uTGluZXMgPSBxLm9wdGlvbnMubWFwKChvcHQsIGkpID0+IHtcbiAgICAgIGNvbnN0IGVtb2ppID0gRElTQ09SRF9OVU1CRVJfRU1PSklTW2ldID8/IGAke2kgKyAxfS5gO1xuICAgICAgaWYgKHN1cHBvcnRzUmVhY3Rpb25zICYmIERJU0NPUkRfTlVNQkVSX0VNT0pJU1tpXSkgcmVhY3Rpb25FbW9qaXMucHVzaChESVNDT1JEX05VTUJFUl9FTU9KSVNbaV0pO1xuICAgICAgcmV0dXJuIGAke2Vtb2ppfSAqKiR7b3B0LmxhYmVsfSoqIFx1MjAxNCAke29wdC5kZXNjcmlwdGlvbn1gO1xuICAgIH0pO1xuXG4gICAgY29uc3QgZm9vdGVyUGFydHM6IHN0cmluZ1tdID0gW107XG4gICAgaWYgKHN1cHBvcnRzUmVhY3Rpb25zKSB7XG4gICAgICBmb290ZXJQYXJ0cy5wdXNoKHEuYWxsb3dNdWx0aXBsZVxuICAgICAgICA/ICdSZXBseSB3aXRoIGNvbW1hLXNlcGFyYXRlZCBjaG9pY2VzIChgMSwzYCkgb3IgcmVhY3Qgd2l0aCBtYXRjaGluZyBudW1iZXJzJ1xuICAgICAgICA6ICdSZXBseSB3aXRoIGEgbnVtYmVyIG9yIHJlYWN0IHdpdGggdGhlIG1hdGNoaW5nIG51bWJlcicpO1xuICAgIH0gZWxzZSB7XG4gICAgICBmb290ZXJQYXJ0cy5wdXNoKGBRdWVzdGlvbiAke3F1ZXN0aW9uSW5kZXggKyAxfS8ke3Byb21wdC5xdWVzdGlvbnMubGVuZ3RofSBcdTIwMTQgcmVwbHkgd2l0aCBvbmUgbGluZSBwZXIgcXVlc3Rpb24gb3IgdXNlIHNlbWljb2xvbnNgKTtcbiAgICB9XG4gICAgZm9vdGVyUGFydHMucHVzaChgU291cmNlOiAke3Byb21wdC5jb250ZXh0LnNvdXJjZX1gKTtcblxuICAgIHJldHVybiB7XG4gICAgICB0aXRsZTogcS5oZWFkZXIsXG4gICAgICBkZXNjcmlwdGlvbjogcS5xdWVzdGlvbixcbiAgICAgIGNvbG9yOiAweDdjM2FlZCxcbiAgICAgIGZpZWxkczogW3sgbmFtZTogJ09wdGlvbnMnLCB2YWx1ZTogb3B0aW9uTGluZXMuam9pbignXFxuJykgfV0sXG4gICAgICBmb290ZXI6IHsgdGV4dDogZm9vdGVyUGFydHMuam9pbignIFx1MDBCNyAnKSB9LFxuICAgIH07XG4gIH0pO1xuXG4gIHJldHVybiB7IGVtYmVkcywgcmVhY3Rpb25FbW9qaXMgfTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0Rm9yU2xhY2socHJvbXB0OiBSZW1vdGVQcm9tcHQpOiB1bmtub3duW10ge1xuICBjb25zdCBibG9ja3M6IHVua25vd25bXSA9IFtcbiAgICB7IHR5cGU6ICdoZWFkZXInLCB0ZXh0OiB7IHR5cGU6ICdwbGFpbl90ZXh0JywgdGV4dDogJ0dTRCBuZWVkcyB5b3VyIGlucHV0JyB9IH0sXG4gIF07XG5cbiAgaWYgKHByb21wdC5xdWVzdGlvbnMubGVuZ3RoID4gMSkge1xuICAgIGJsb2Nrcy5wdXNoKHtcbiAgICAgIHR5cGU6ICdjb250ZXh0JyxcbiAgICAgIGVsZW1lbnRzOiBbeyB0eXBlOiAnbXJrZHduJywgdGV4dDogJ1JlcGx5IG9uY2UgaW4gdGhyZWFkIHVzaW5nIG9uZSBsaW5lIHBlciBxdWVzdGlvbiBvciBzZW1pY29sb25zIChgMTsgMjsgY3VzdG9tIG5vdGVgKS4nIH1dLFxuICAgIH0pO1xuICB9XG5cbiAgZm9yIChjb25zdCBxIG9mIHByb21wdC5xdWVzdGlvbnMpIHtcbiAgICBjb25zdCBzdXBwb3J0c1JlYWN0aW9ucyA9IHByb21wdC5xdWVzdGlvbnMubGVuZ3RoID09PSAxO1xuICAgIGJsb2Nrcy5wdXNoKHsgdHlwZTogJ3NlY3Rpb24nLCB0ZXh0OiB7IHR5cGU6ICdtcmtkd24nLCB0ZXh0OiBgKiR7cS5oZWFkZXJ9KlxcbiR7cS5xdWVzdGlvbn1gIH0gfSk7XG4gICAgYmxvY2tzLnB1c2goe1xuICAgICAgdHlwZTogJ3NlY3Rpb24nLFxuICAgICAgdGV4dDogeyB0eXBlOiAnbXJrZHduJywgdGV4dDogcS5vcHRpb25zLm1hcCgob3B0LCBpKSA9PiBgJHtpICsgMX0uICoke29wdC5sYWJlbH0qIFx1MjAxNCAke29wdC5kZXNjcmlwdGlvbn1gKS5qb2luKCdcXG4nKSB9LFxuICAgIH0pO1xuICAgIGJsb2Nrcy5wdXNoKHtcbiAgICAgIHR5cGU6ICdjb250ZXh0JyxcbiAgICAgIGVsZW1lbnRzOiBbe1xuICAgICAgICB0eXBlOiAnbXJrZHduJyxcbiAgICAgICAgdGV4dDogcHJvbXB0LnF1ZXN0aW9ucy5sZW5ndGggPiAxXG4gICAgICAgICAgPyAocS5hbGxvd011bHRpcGxlID8gJ0ZvciB0aGlzIHF1ZXN0aW9uLCB1c2UgY29tbWEtc2VwYXJhdGVkIG51bWJlcnMgKGAxLDNgKSBvciBmcmVlIHRleHQuJyA6ICdGb3IgdGhpcyBxdWVzdGlvbiwgdXNlIG9uZSBudW1iZXIgKGAxYCkgb3IgZnJlZSB0ZXh0LicpXG4gICAgICAgICAgOiAocS5hbGxvd011bHRpcGxlXG4gICAgICAgICAgICAgID8gKHN1cHBvcnRzUmVhY3Rpb25zID8gJ1JlcGx5IGluIHRocmVhZCB3aXRoIGNvbW1hLXNlcGFyYXRlZCBudW1iZXJzIChgMSwzYCkgb3IgcmVhY3Qgd2l0aCBtYXRjaGluZyBudW1iZXIgZW1vamkuJyA6ICdSZXBseSBpbiB0aHJlYWQgd2l0aCBjb21tYS1zZXBhcmF0ZWQgbnVtYmVycyAoYDEsM2ApIG9yIGZyZWUgdGV4dC4nKVxuICAgICAgICAgICAgICA6IChzdXBwb3J0c1JlYWN0aW9ucyA/ICdSZXBseSBpbiB0aHJlYWQgd2l0aCBhIG51bWJlciAoYDFgKSBvciByZWFjdCB3aXRoIHRoZSBtYXRjaGluZyBudW1iZXIgZW1vamkuJyA6ICdSZXBseSBpbiB0aHJlYWQgd2l0aCBhIG51bWJlciAoYDFgKSBvciBmcmVlIHRleHQuJykpLFxuICAgICAgfV0sXG4gICAgfSk7XG4gICAgYmxvY2tzLnB1c2goeyB0eXBlOiAnZGl2aWRlcicgfSk7XG4gIH1cblxuICByZXR1cm4gYmxvY2tzO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRGb3JUZWxlZ3JhbShwcm9tcHQ6IFJlbW90ZVByb21wdCk6IHsgdGV4dDogc3RyaW5nOyBwYXJzZV9tb2RlOiAnSFRNTCc7IHJlcGx5X21hcmt1cD86IHVua25vd24gfSB7XG4gIGNvbnN0IGVzY2FwZSA9IChzOiBzdHJpbmcpID0+IHMucmVwbGFjZSgvJi9nLCAnJmFtcDsnKS5yZXBsYWNlKC88L2csICcmbHQ7JykucmVwbGFjZSgvPi9nLCAnJmd0OycpO1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbJzxiPkdTRCBuZWVkcyB5b3VyIGlucHV0PC9iPicsICcnXTtcblxuICBmb3IgKGxldCBxaSA9IDA7IHFpIDwgcHJvbXB0LnF1ZXN0aW9ucy5sZW5ndGg7IHFpKyspIHtcbiAgICBjb25zdCBxID0gcHJvbXB0LnF1ZXN0aW9uc1txaV07XG4gICAgbGluZXMucHVzaChgPGI+JHtlc2NhcGUocS5oZWFkZXIpfTwvYj5gKTtcbiAgICBsaW5lcy5wdXNoKGVzY2FwZShxLnF1ZXN0aW9uKSk7XG4gICAgbGluZXMucHVzaCgnJyk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBxLm9wdGlvbnMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGxpbmVzLnB1c2goYCR7aSArIDF9LiA8Yj4ke2VzY2FwZShxLm9wdGlvbnNbaV0ubGFiZWwpfTwvYj4gXHUyMDE0ICR7ZXNjYXBlKHEub3B0aW9uc1tpXS5kZXNjcmlwdGlvbil9YCk7XG4gICAgfVxuICAgIGxpbmVzLnB1c2goJycpO1xuICAgIGlmIChwcm9tcHQucXVlc3Rpb25zLmxlbmd0aCA9PT0gMSkge1xuICAgICAgbGluZXMucHVzaChxLmFsbG93TXVsdGlwbGUgPyAnUmVwbHkgd2l0aCBjb21tYS1zZXBhcmF0ZWQgbnVtYmVycyAoMSwzKSBvciBmcmVlIHRleHQuJyA6ICdSZXBseSB3aXRoIGEgbnVtYmVyIG9yIHRhcCBhIGJ1dHRvbiBiZWxvdy4nKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbGluZXMucHVzaChgUXVlc3Rpb24gJHtxaSArIDF9LyR7cHJvbXB0LnF1ZXN0aW9ucy5sZW5ndGh9IFx1MjAxNCByZXBseSB3aXRoIG9uZSBsaW5lIHBlciBxdWVzdGlvbiBvciB1c2Ugc2VtaWNvbG9ucy5gKTtcbiAgICB9XG4gICAgaWYgKHFpIDwgcHJvbXB0LnF1ZXN0aW9ucy5sZW5ndGggLSAxKSBsaW5lcy5wdXNoKCcnKTtcbiAgfVxuXG4gIGNvbnN0IHJlc3VsdDogeyB0ZXh0OiBzdHJpbmc7IHBhcnNlX21vZGU6ICdIVE1MJzsgcmVwbHlfbWFya3VwPzogdW5rbm93biB9ID0ge1xuICAgIHRleHQ6IGxpbmVzLmpvaW4oJ1xcbicpLFxuICAgIHBhcnNlX21vZGU6ICdIVE1MJyxcbiAgfTtcblxuICBpZiAocHJvbXB0LnF1ZXN0aW9ucy5sZW5ndGggPT09IDEgJiYgcHJvbXB0LnF1ZXN0aW9uc1swXS5vcHRpb25zLmxlbmd0aCA8PSA1KSB7XG4gICAgcmVzdWx0LnJlcGx5X21hcmt1cCA9IHtcbiAgICAgIGlubGluZV9rZXlib2FyZDogcHJvbXB0LnF1ZXN0aW9uc1swXS5vcHRpb25zLm1hcCgob3B0LCBpKSA9PiBbe1xuICAgICAgICB0ZXh0OiBgJHtpICsgMX0uICR7b3B0LmxhYmVsfWAsXG4gICAgICAgIGNhbGxiYWNrX2RhdGE6IGAke3Byb21wdC5pZH06JHtpfWAsXG4gICAgICB9XSksXG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiByZXN1bHQ7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUmVzcG9uc2UgcGFyc2luZ1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIHBhcnNlQW5zd2VyRm9yUXVlc3Rpb24odGV4dDogc3RyaW5nLCBxOiBSZW1vdGVRdWVzdGlvbik6IHsgYW5zd2Vyczogc3RyaW5nW107IHVzZXJfbm90ZT86IHN0cmluZyB9IHtcbiAgaWYgKCF0ZXh0KSByZXR1cm4geyBhbnN3ZXJzOiBbXSwgdXNlcl9ub3RlOiAnTm8gcmVzcG9uc2UgcHJvdmlkZWQnIH07XG5cbiAgaWYgKC9eW1xcZCxcXHNdKyQvLnRlc3QodGV4dCkpIHtcbiAgICBjb25zdCBudW1zID0gdGV4dFxuICAgICAgLnNwbGl0KCcsJylcbiAgICAgIC5tYXAoKHMpID0+IHBhcnNlSW50KHMudHJpbSgpLCAxMCkpXG4gICAgICAuZmlsdGVyKChuKSA9PiAhTnVtYmVyLmlzTmFOKG4pICYmIG4gPj0gMSAmJiBuIDw9IHEub3B0aW9ucy5sZW5ndGgpO1xuICAgIGlmIChudW1zLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IHNlbGVjdGVkID0gbnVtcy5tYXAoKG4pID0+IHEub3B0aW9uc1tuIC0gMV0ubGFiZWwpO1xuICAgICAgcmV0dXJuIHsgYW5zd2VyczogcS5hbGxvd011bHRpcGxlID8gc2VsZWN0ZWQgOiBbc2VsZWN0ZWRbMF1dIH07XG4gICAgfVxuICB9XG5cbiAgY29uc3Qgc2luZ2xlID0gcGFyc2VJbnQodGV4dCwgMTApO1xuICBpZiAoIU51bWJlci5pc05hTihzaW5nbGUpICYmIHNpbmdsZSA+PSAxICYmIHNpbmdsZSA8PSBxLm9wdGlvbnMubGVuZ3RoKSB7XG4gICAgcmV0dXJuIHsgYW5zd2VyczogW3Eub3B0aW9uc1tzaW5nbGUgLSAxXS5sYWJlbF0gfTtcbiAgfVxuXG4gIGNvbnN0IHRydW5jYXRlZCA9IHRleHQubGVuZ3RoID4gNTAwID8gdGV4dC5zbGljZSgwLCA1MDApICsgJ1xcdTIwMjYnIDogdGV4dDtcbiAgcmV0dXJuIHsgYW5zd2VyczogW10sIHVzZXJfbm90ZTogdHJ1bmNhdGVkIH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlVGV4dFJlcGx5KHRleHQ6IHN0cmluZywgcXVlc3Rpb25zOiBSZW1vdGVRdWVzdGlvbltdKTogUmVtb3RlQW5zd2VyIHtcbiAgY29uc3QgYW5zd2VyczogUmVtb3RlQW5zd2VyWydhbnN3ZXJzJ10gPSB7fTtcbiAgY29uc3QgdHJpbW1lZCA9IHRleHQudHJpbSgpO1xuXG4gIGlmIChxdWVzdGlvbnMubGVuZ3RoID09PSAxKSB7XG4gICAgYW5zd2Vyc1txdWVzdGlvbnNbMF0uaWRdID0gcGFyc2VBbnN3ZXJGb3JRdWVzdGlvbih0cmltbWVkLCBxdWVzdGlvbnNbMF0pO1xuICAgIHJldHVybiB7IGFuc3dlcnMgfTtcbiAgfVxuXG4gIGNvbnN0IHBhcnRzID0gdHJpbW1lZC5pbmNsdWRlcygnOycpXG4gICAgPyB0cmltbWVkLnNwbGl0KCc7JykubWFwKChzKSA9PiBzLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pXG4gICAgOiB0cmltbWVkLnNwbGl0KCdcXG4nKS5tYXAoKHMpID0+IHMudHJpbSgpKS5maWx0ZXIoQm9vbGVhbik7XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBxdWVzdGlvbnMubGVuZ3RoOyBpKyspIHtcbiAgICBhbnN3ZXJzW3F1ZXN0aW9uc1tpXS5pZF0gPSBwYXJzZUFuc3dlckZvclF1ZXN0aW9uKHBhcnRzW2ldID8/ICcnLCBxdWVzdGlvbnNbaV0pO1xuICB9XG5cbiAgcmV0dXJuIHsgYW5zd2VycyB9O1xufVxuXG5mdW5jdGlvbiBwYXJzZURpc2NvcmRSZWFjdGlvbnMoXG4gIHJlYWN0aW9uczogQXJyYXk8eyBlbW9qaTogc3RyaW5nOyBjb3VudDogbnVtYmVyIH0+LFxuICBxdWVzdGlvbnM6IFJlbW90ZVF1ZXN0aW9uW10sXG4pOiBSZW1vdGVBbnN3ZXIge1xuICBjb25zdCBhbnN3ZXJzOiBSZW1vdGVBbnN3ZXJbJ2Fuc3dlcnMnXSA9IHt9O1xuICBpZiAocXVlc3Rpb25zLmxlbmd0aCAhPT0gMSkge1xuICAgIGZvciAoY29uc3QgcSBvZiBxdWVzdGlvbnMpIHtcbiAgICAgIGFuc3dlcnNbcS5pZF0gPSB7IGFuc3dlcnM6IFtdLCB1c2VyX25vdGU6ICdEaXNjb3JkIHJlYWN0aW9ucyBhcmUgb25seSBzdXBwb3J0ZWQgZm9yIHNpbmdsZS1xdWVzdGlvbiBwcm9tcHRzJyB9O1xuICAgIH1cbiAgICByZXR1cm4geyBhbnN3ZXJzIH07XG4gIH1cblxuICBjb25zdCBxID0gcXVlc3Rpb25zWzBdO1xuICBjb25zdCBwaWNrZWQgPSByZWFjdGlvbnNcbiAgICAuZmlsdGVyKChyKSA9PiBESVNDT1JEX05VTUJFUl9FTU9KSVMuaW5jbHVkZXMoci5lbW9qaSkgJiYgci5jb3VudCA+IDApXG4gICAgLm1hcCgocikgPT4gcS5vcHRpb25zW0RJU0NPUkRfTlVNQkVSX0VNT0pJUy5pbmRleE9mKHIuZW1vamkpXT8ubGFiZWwpXG4gICAgLmZpbHRlcigobCk6IGwgaXMgc3RyaW5nID0+IEJvb2xlYW4obCkpO1xuXG4gIGFuc3dlcnNbcS5pZF0gPSBwaWNrZWQubGVuZ3RoID4gMFxuICAgID8geyBhbnN3ZXJzOiBxLmFsbG93TXVsdGlwbGUgPyBwaWNrZWQgOiBbcGlja2VkWzBdXSB9XG4gICAgOiB7IGFuc3dlcnM6IFtdLCB1c2VyX25vdGU6ICdObyBjbGVhciByZXNwb25zZSB2aWEgcmVhY3Rpb25zJyB9O1xuXG4gIHJldHVybiB7IGFuc3dlcnMgfTtcbn1cblxuZnVuY3Rpb24gcGFyc2VTbGFja1JlYWN0aW9ucyhyZWFjdGlvbk5hbWVzOiBzdHJpbmdbXSwgcXVlc3Rpb25zOiBSZW1vdGVRdWVzdGlvbltdKTogUmVtb3RlQW5zd2VyIHtcbiAgY29uc3QgYW5zd2VyczogUmVtb3RlQW5zd2VyWydhbnN3ZXJzJ10gPSB7fTtcbiAgaWYgKHF1ZXN0aW9ucy5sZW5ndGggIT09IDEpIHtcbiAgICBmb3IgKGNvbnN0IHEgb2YgcXVlc3Rpb25zKSB7XG4gICAgICBhbnN3ZXJzW3EuaWRdID0geyBhbnN3ZXJzOiBbXSwgdXNlcl9ub3RlOiAnU2xhY2sgcmVhY3Rpb25zIGFyZSBvbmx5IHN1cHBvcnRlZCBmb3Igc2luZ2xlLXF1ZXN0aW9uIHByb21wdHMnIH07XG4gICAgfVxuICAgIHJldHVybiB7IGFuc3dlcnMgfTtcbiAgfVxuXG4gIGNvbnN0IHEgPSBxdWVzdGlvbnNbMF07XG4gIGNvbnN0IHBpY2tlZCA9IHJlYWN0aW9uTmFtZXNcbiAgICAuZmlsdGVyKChuYW1lKSA9PiBTTEFDS19OVU1CRVJfUkVBQ1RJT05fTkFNRVMuaW5jbHVkZXMobmFtZSkpXG4gICAgLm1hcCgobmFtZSkgPT4gcS5vcHRpb25zW1NMQUNLX05VTUJFUl9SRUFDVElPTl9OQU1FUy5pbmRleE9mKG5hbWUpXT8ubGFiZWwpXG4gICAgLmZpbHRlcigobCk6IGwgaXMgc3RyaW5nID0+IEJvb2xlYW4obCkpO1xuXG4gIGFuc3dlcnNbcS5pZF0gPSBwaWNrZWQubGVuZ3RoID4gMFxuICAgID8geyBhbnN3ZXJzOiBxLmFsbG93TXVsdGlwbGUgPyBwaWNrZWQgOiBbcGlja2VkWzBdXSB9XG4gICAgOiB7IGFuc3dlcnM6IFtdLCB1c2VyX25vdGU6ICdObyBjbGVhciByZXNwb25zZSB2aWEgcmVhY3Rpb25zJyB9O1xuXG4gIHJldHVybiB7IGFuc3dlcnMgfTtcbn1cblxuZnVuY3Rpb24gcGFyc2VUZWxlZ3JhbUNhbGxiYWNrRGF0YShjYWxsYmFja0RhdGE6IHN0cmluZywgcXVlc3Rpb25zOiBSZW1vdGVRdWVzdGlvbltdLCBwcm9tcHRJZDogc3RyaW5nKTogUmVtb3RlQW5zd2VyIHwgbnVsbCB7XG4gIGNvbnN0IHBhdHRlcm4gPSBuZXcgUmVnRXhwKGBeJHtwcm9tcHRJZC5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgJ1xcXFwkJicpfTooXFxcXGQrKSRgKTtcbiAgY29uc3QgbWF0Y2ggPSBjYWxsYmFja0RhdGEubWF0Y2gocGF0dGVybik7XG4gIGlmIChtYXRjaCAmJiBxdWVzdGlvbnMubGVuZ3RoID09PSAxKSB7XG4gICAgY29uc3QgaWR4ID0gcGFyc2VJbnQobWF0Y2hbMV0sIDEwKTtcbiAgICBjb25zdCBxID0gcXVlc3Rpb25zWzBdO1xuICAgIGlmIChpZHggPj0gMCAmJiBpZHggPCBxLm9wdGlvbnMubGVuZ3RoKSB7XG4gICAgICByZXR1cm4geyBhbnN3ZXJzOiB7IFtxLmlkXTogeyBhbnN3ZXJzOiBbcS5vcHRpb25zW2lkeF0ubGFiZWxdIH0gfSB9O1xuICAgIH1cbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBDaGFubmVsIGFkYXB0ZXJzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuaW50ZXJmYWNlIERpc3BhdGNoUmVzdWx0IHtcbiAgcmVmOiBSZW1vdGVQcm9tcHRSZWY7XG59XG5cbi8vIC0tLSBEaXNjb3JkIC0tLVxuXG5hc3luYyBmdW5jdGlvbiBkaXNjb3JkVmFsaWRhdGUodG9rZW46IHN0cmluZywgY2hhbm5lbElkOiBzdHJpbmcpOiBQcm9taXNlPHsgYm90VXNlcklkOiBzdHJpbmc7IGd1aWxkSWQ6IHN0cmluZyB8IG51bGwgfT4ge1xuICBjb25zdCBtZVJlcyA9IGF3YWl0IGFwaVJlcXVlc3QoYCR7RElTQ09SRF9BUEl9L3VzZXJzL0BtZWAsICdHRVQnLCB1bmRlZmluZWQsICdCb3QnLCB0b2tlbiwgJ0Rpc2NvcmQgQVBJJykgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGlmICghbWVSZXNbJ2lkJ10pIHRocm93IG5ldyBFcnJvcignRGlzY29yZCBhdXRoIGZhaWxlZDogaW52YWxpZCB0b2tlbicpO1xuICBjb25zdCBib3RVc2VySWQgPSBTdHJpbmcobWVSZXNbJ2lkJ10pO1xuXG4gIGxldCBndWlsZElkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCBjaGFuUmVzID0gYXdhaXQgYXBpUmVxdWVzdChgJHtESVNDT1JEX0FQSX0vY2hhbm5lbHMvJHtjaGFubmVsSWR9YCwgJ0dFVCcsIHVuZGVmaW5lZCwgJ0JvdCcsIHRva2VuLCAnRGlzY29yZCBBUEknKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBpZiAoY2hhblJlc1snZ3VpbGRfaWQnXSkgZ3VpbGRJZCA9IFN0cmluZyhjaGFuUmVzWydndWlsZF9pZCddKTtcbiAgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9XG5cbiAgcmV0dXJuIHsgYm90VXNlcklkLCBndWlsZElkIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGRpc2NvcmRTZW5kKHByb21wdDogUmVtb3RlUHJvbXB0LCB0b2tlbjogc3RyaW5nLCBjaGFubmVsSWQ6IHN0cmluZywgZ3VpbGRJZDogc3RyaW5nIHwgbnVsbCk6IFByb21pc2U8RGlzcGF0Y2hSZXN1bHQ+IHtcbiAgY29uc3QgeyBlbWJlZHMsIHJlYWN0aW9uRW1vamlzIH0gPSBmb3JtYXRGb3JEaXNjb3JkKHByb21wdCk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGFwaVJlcXVlc3QoXG4gICAgYCR7RElTQ09SRF9BUEl9L2NoYW5uZWxzLyR7Y2hhbm5lbElkfS9tZXNzYWdlc2AsXG4gICAgJ1BPU1QnLFxuICAgIHsgY29udGVudDogJyoqR1NEIG5lZWRzIHlvdXIgaW5wdXQqKiBcdTIwMTQgcmVwbHkgdG8gdGhpcyBtZXNzYWdlIHdpdGggeW91ciBhbnN3ZXInLCBlbWJlZHMgfSxcbiAgICAnQm90JywgdG9rZW4sICdEaXNjb3JkIEFQSScsXG4gICkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cbiAgaWYgKCFyZXNbJ2lkJ10pIHRocm93IG5ldyBFcnJvcihgRGlzY29yZCBzZW5kIGZhaWxlZDogJHtKU09OLnN0cmluZ2lmeShyZXMpfWApO1xuICBjb25zdCBtZXNzYWdlSWQgPSBTdHJpbmcocmVzWydpZCddKTtcblxuICBpZiAocHJvbXB0LnF1ZXN0aW9ucy5sZW5ndGggPT09IDEpIHtcbiAgICBmb3IgKGNvbnN0IGVtb2ppIG9mIHJlYWN0aW9uRW1vamlzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBhcGlSZXF1ZXN0KGAke0RJU0NPUkRfQVBJfS9jaGFubmVscy8ke2NoYW5uZWxJZH0vbWVzc2FnZXMvJHttZXNzYWdlSWR9L3JlYWN0aW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChlbW9qaSl9L0BtZWAsICdQVVQnLCB1bmRlZmluZWQsICdCb3QnLCB0b2tlbiwgJ0Rpc2NvcmQgQVBJJyk7XG4gICAgICB9IGNhdGNoIHsgLyogYmVzdC1lZmZvcnQgKi8gfVxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHRocmVhZFVybCA9IGd1aWxkSWQgPyBgaHR0cHM6Ly9kaXNjb3JkLmNvbS9jaGFubmVscy8ke2d1aWxkSWR9LyR7Y2hhbm5lbElkfS8ke21lc3NhZ2VJZH1gIDogdW5kZWZpbmVkO1xuICByZXR1cm4geyByZWY6IHsgaWQ6IHByb21wdC5pZCwgY2hhbm5lbDogJ2Rpc2NvcmQnLCBtZXNzYWdlSWQsIGNoYW5uZWxJZCwgdGhyZWFkVXJsIH0gfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZGlzY29yZFBvbGwocHJvbXB0OiBSZW1vdGVQcm9tcHQsIHJlZjogUmVtb3RlUHJvbXB0UmVmLCB0b2tlbjogc3RyaW5nLCBib3RVc2VySWQ6IHN0cmluZyk6IFByb21pc2U8UmVtb3RlQW5zd2VyIHwgbnVsbD4ge1xuICAvLyBUcnkgcmVhY3Rpb25zIGZpcnN0IGZvciBzaW5nbGUtcXVlc3Rpb24gcHJvbXB0c1xuICBpZiAocHJvbXB0LnF1ZXN0aW9ucy5sZW5ndGggPT09IDEpIHtcbiAgICBjb25zdCByZWFjdGlvbnM6IEFycmF5PHsgZW1vamk6IHN0cmluZzsgY291bnQ6IG51bWJlciB9PiA9IFtdO1xuICAgIGZvciAoY29uc3QgZW1vamkgb2YgRElTQ09SRF9OVU1CRVJfRU1PSklTKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCB1c2VycyA9IGF3YWl0IGFwaVJlcXVlc3QoXG4gICAgICAgICAgYCR7RElTQ09SRF9BUEl9L2NoYW5uZWxzLyR7cmVmLmNoYW5uZWxJZH0vbWVzc2FnZXMvJHtyZWYubWVzc2FnZUlkfS9yZWFjdGlvbnMvJHtlbmNvZGVVUklDb21wb25lbnQoZW1vamkpfWAsXG4gICAgICAgICAgJ0dFVCcsIHVuZGVmaW5lZCwgJ0JvdCcsIHRva2VuLCAnRGlzY29yZCBBUEknLFxuICAgICAgICApIGFzIHVua25vd25bXTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodXNlcnMpKSB7XG4gICAgICAgICAgY29uc3QgaHVtYW5Vc2VycyA9IHVzZXJzLmZpbHRlcigodSkgPT4gKHUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pWydpZCddICE9PSBib3RVc2VySWQpO1xuICAgICAgICAgIGlmIChodW1hblVzZXJzLmxlbmd0aCA+IDApIHJlYWN0aW9ucy5wdXNoKHsgZW1vamksIGNvdW50OiBodW1hblVzZXJzLmxlbmd0aCB9KTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnN0IG1zZyA9IFN0cmluZygoZXJyIGFzIEVycm9yKS5tZXNzYWdlID8/ICcnKTtcbiAgICAgICAgaWYgKG1zZy5pbmNsdWRlcygnSFRUUCA0MDQnKSkgY29udGludWU7XG4gICAgICAgIGlmIChtc2cuaW5jbHVkZXMoJ0hUVFAgNDAxJykgfHwgbXNnLmluY2x1ZGVzKCdIVFRQIDQwMycpKSB0aHJvdyBlcnI7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChyZWFjdGlvbnMubGVuZ3RoID4gMCkgcmV0dXJuIHBhcnNlRGlzY29yZFJlYWN0aW9ucyhyZWFjdGlvbnMsIHByb21wdC5xdWVzdGlvbnMpO1xuICB9XG5cbiAgLy8gVHJ5IHRleHQgcmVwbGllc1xuICBjb25zdCBtZXNzYWdlcyA9IGF3YWl0IGFwaVJlcXVlc3QoXG4gICAgYCR7RElTQ09SRF9BUEl9L2NoYW5uZWxzLyR7cmVmLmNoYW5uZWxJZH0vbWVzc2FnZXM/YWZ0ZXI9JHtyZWYubWVzc2FnZUlkfSZsaW1pdD0xMGAsXG4gICAgJ0dFVCcsIHVuZGVmaW5lZCwgJ0JvdCcsIHRva2VuLCAnRGlzY29yZCBBUEknLFxuICApIGFzIHVua25vd25bXTtcblxuICBpZiAoIUFycmF5LmlzQXJyYXkobWVzc2FnZXMpKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCByZXBsaWVzID0gbWVzc2FnZXMuZmlsdGVyKChtKSA9PiB7XG4gICAgY29uc3QgbXNnID0gbSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBjb25zdCBhdXRob3IgPSBtc2dbJ2F1dGhvciddIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgIGNvbnN0IG1zZ1JlZiA9IG1zZ1snbWVzc2FnZV9yZWZlcmVuY2UnXSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICByZXR1cm4gYXV0aG9yPy5bJ2lkJ10gJiYgYXV0aG9yWydpZCddICE9PSBib3RVc2VySWQgJiYgbXNnUmVmPy5bJ21lc3NhZ2VfaWQnXSA9PT0gcmVmLm1lc3NhZ2VJZCAmJiBtc2dbJ2NvbnRlbnQnXTtcbiAgfSk7XG5cbiAgaWYgKHJlcGxpZXMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZmlyc3QgPSByZXBsaWVzWzBdIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICByZXR1cm4gcGFyc2VUZXh0UmVwbHkoU3RyaW5nKGZpcnN0Wydjb250ZW50J10pLCBwcm9tcHQucXVlc3Rpb25zKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZGlzY29yZEFja25vd2xlZGdlKHJlZjogUmVtb3RlUHJvbXB0UmVmLCB0b2tlbjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIHRyeSB7XG4gICAgYXdhaXQgYXBpUmVxdWVzdChcbiAgICAgIGAke0RJU0NPUkRfQVBJfS9jaGFubmVscy8ke3JlZi5jaGFubmVsSWR9L21lc3NhZ2VzLyR7cmVmLm1lc3NhZ2VJZH0vcmVhY3Rpb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KCdcdTI3MDUnKX0vQG1lYCxcbiAgICAgICdQVVQnLCB1bmRlZmluZWQsICdCb3QnLCB0b2tlbiwgJ0Rpc2NvcmQgQVBJJyxcbiAgICApO1xuICB9IGNhdGNoIHsgLyogYmVzdC1lZmZvcnQgKi8gfVxufVxuXG4vLyAtLS0gU2xhY2sgLS0tXG5cbmFzeW5jIGZ1bmN0aW9uIHNsYWNrVmFsaWRhdGUodG9rZW46IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGFwaVJlcXVlc3QoYCR7U0xBQ0tfQVBJfS9hdXRoLnRlc3RgLCAnR0VUJywgdW5kZWZpbmVkLCAnQmVhcmVyJywgdG9rZW4sICdTbGFjayBBUEknKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgaWYgKCFyZXNbJ29rJ10pIHRocm93IG5ldyBFcnJvcihgU2xhY2sgYXV0aCBmYWlsZWQ6ICR7cmVzWydlcnJvciddID8/ICdpbnZhbGlkIHRva2VuJ31gKTtcbiAgcmV0dXJuIFN0cmluZyhyZXNbJ3VzZXJfaWQnXSA/PyAnJyk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNsYWNrU2VuZChwcm9tcHQ6IFJlbW90ZVByb21wdCwgdG9rZW46IHN0cmluZywgY2hhbm5lbElkOiBzdHJpbmcpOiBQcm9taXNlPERpc3BhdGNoUmVzdWx0PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGFwaVJlcXVlc3QoXG4gICAgYCR7U0xBQ0tfQVBJfS9jaGF0LnBvc3RNZXNzYWdlYCxcbiAgICAnUE9TVCcsXG4gICAgeyBjaGFubmVsOiBjaGFubmVsSWQsIHRleHQ6ICdHU0QgbmVlZHMgeW91ciBpbnB1dCcsIGJsb2NrczogZm9ybWF0Rm9yU2xhY2socHJvbXB0KSB9LFxuICAgICdCZWFyZXInLCB0b2tlbiwgJ1NsYWNrIEFQSScsXG4gICkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cbiAgaWYgKCFyZXNbJ29rJ10pIHRocm93IG5ldyBFcnJvcihgU2xhY2sgcG9zdE1lc3NhZ2UgZmFpbGVkOiAke3Jlc1snZXJyb3InXSA/PyAndW5rbm93bid9YCk7XG5cbiAgY29uc3QgdHMgPSBTdHJpbmcocmVzWyd0cyddKTtcbiAgY29uc3QgY2hhbm5lbCA9IFN0cmluZyhyZXNbJ2NoYW5uZWwnXSk7XG5cbiAgaWYgKHByb21wdC5xdWVzdGlvbnMubGVuZ3RoID09PSAxKSB7XG4gICAgY29uc3QgcmVhY3Rpb25OYW1lcyA9IFNMQUNLX05VTUJFUl9SRUFDVElPTl9OQU1FUy5zbGljZSgwLCBwcm9tcHQucXVlc3Rpb25zWzBdLm9wdGlvbnMubGVuZ3RoKTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgcmVhY3Rpb25OYW1lcykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgYXBpUmVxdWVzdChgJHtTTEFDS19BUEl9L3JlYWN0aW9ucy5hZGRgLCAnUE9TVCcsIHsgY2hhbm5lbCwgdGltZXN0YW1wOiB0cywgbmFtZSB9LCAnQmVhcmVyJywgdG9rZW4sICdTbGFjayBBUEknKTtcbiAgICAgIH0gY2F0Y2ggeyAvKiBiZXN0LWVmZm9ydCAqLyB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHtcbiAgICByZWY6IHtcbiAgICAgIGlkOiBwcm9tcHQuaWQsXG4gICAgICBjaGFubmVsOiAnc2xhY2snLFxuICAgICAgbWVzc2FnZUlkOiB0cyxcbiAgICAgIHRocmVhZFRzOiB0cyxcbiAgICAgIGNoYW5uZWxJZDogY2hhbm5lbCxcbiAgICAgIHRocmVhZFVybDogYGh0dHBzOi8vc2xhY2suY29tL2FyY2hpdmVzLyR7Y2hhbm5lbH0vcCR7dHMucmVwbGFjZSgnLicsICcnKX1gLFxuICAgIH0sXG4gIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNsYWNrUG9sbChwcm9tcHQ6IFJlbW90ZVByb21wdCwgcmVmOiBSZW1vdGVQcm9tcHRSZWYsIHRva2VuOiBzdHJpbmcsIGJvdFVzZXJJZDogc3RyaW5nKTogUHJvbWlzZTxSZW1vdGVBbnN3ZXIgfCBudWxsPiB7XG4gIC8vIENoZWNrIHJlYWN0aW9ucyBmb3Igc2luZ2xlLXF1ZXN0aW9uIHByb21wdHNcbiAgaWYgKHByb21wdC5xdWVzdGlvbnMubGVuZ3RoID09PSAxKSB7XG4gICAgY29uc3QgcXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHsgY2hhbm5lbDogcmVmLmNoYW5uZWxJZCwgdGltZXN0YW1wOiByZWYubWVzc2FnZUlkLCBmdWxsOiAndHJ1ZScgfSkudG9TdHJpbmcoKTtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBhcGlSZXF1ZXN0KGAke1NMQUNLX0FQSX0vcmVhY3Rpb25zLmdldD8ke3FzfWAsICdHRVQnLCB1bmRlZmluZWQsICdCZWFyZXInLCB0b2tlbiwgJ1NsYWNrIEFQSScpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXG4gICAgaWYgKHJlc1snb2snXSkge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IChyZXNbJ21lc3NhZ2UnXSA/PyB7fSkgYXMgeyByZWFjdGlvbnM/OiBBcnJheTx7IG5hbWU/OiBzdHJpbmc7IGNvdW50PzogbnVtYmVyOyB1c2Vycz86IHN0cmluZ1tdIH0+IH07XG4gICAgICBjb25zdCByZWFjdGlvbnMgPSBBcnJheS5pc0FycmF5KG1lc3NhZ2UucmVhY3Rpb25zKSA/IG1lc3NhZ2UucmVhY3Rpb25zIDogW107XG4gICAgICBjb25zdCBwaWNrZWQgPSByZWFjdGlvbnNcbiAgICAgICAgLmZpbHRlcigocikgPT4gci5uYW1lICYmIFNMQUNLX05VTUJFUl9SRUFDVElPTl9OQU1FUy5pbmNsdWRlcyhyLm5hbWUpKVxuICAgICAgICAuZmlsdGVyKChyKSA9PiB7XG4gICAgICAgICAgY29uc3QgY291bnQgPSBOdW1iZXIoci5jb3VudCA/PyAwKTtcbiAgICAgICAgICBjb25zdCB1c2VycyA9IEFycmF5LmlzQXJyYXkoci51c2VycykgPyByLnVzZXJzLm1hcChTdHJpbmcpIDogW107XG4gICAgICAgICAgY29uc3QgYm90SW5jbHVkZWQgPSBib3RVc2VySWQgPyB1c2Vycy5pbmNsdWRlcyhib3RVc2VySWQpIDogZmFsc2U7XG4gICAgICAgICAgcmV0dXJuIGNvdW50ID4gKGJvdEluY2x1ZGVkID8gMSA6IDApO1xuICAgICAgICB9KVxuICAgICAgICAubWFwKChyKSA9PiBTdHJpbmcoci5uYW1lKSk7XG5cbiAgICAgIGlmIChwaWNrZWQubGVuZ3RoID4gMCkgcmV0dXJuIHBhcnNlU2xhY2tSZWFjdGlvbnMocGlja2VkLCBwcm9tcHQucXVlc3Rpb25zKTtcbiAgICB9XG4gIH1cblxuICAvLyBDaGVjayB0aHJlYWQgcmVwbGllc1xuICBjb25zdCBxcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoeyBjaGFubmVsOiByZWYuY2hhbm5lbElkLCB0czogcmVmLnRocmVhZFRzISwgbGltaXQ6ICcyMCcgfSkudG9TdHJpbmcoKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgYXBpUmVxdWVzdChgJHtTTEFDS19BUEl9L2NvbnZlcnNhdGlvbnMucmVwbGllcz8ke3FzfWAsICdHRVQnLCB1bmRlZmluZWQsICdCZWFyZXInLCB0b2tlbiwgJ1NsYWNrIEFQSScpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXG4gIGlmICghcmVzWydvayddKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBtZXNzYWdlcyA9IChyZXNbJ21lc3NhZ2VzJ10gPz8gW10pIGFzIEFycmF5PHsgdXNlcj86IHN0cmluZzsgdGV4dD86IHN0cmluZzsgdHM6IHN0cmluZyB9PjtcbiAgY29uc3QgdXNlclJlcGxpZXMgPSBtZXNzYWdlcy5maWx0ZXIoKG0pID0+IG0udHMgIT09IHJlZi50aHJlYWRUcyAmJiBtLnVzZXIgJiYgbS51c2VyICE9PSBib3RVc2VySWQgJiYgbS50ZXh0KTtcbiAgaWYgKHVzZXJSZXBsaWVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cbiAgcmV0dXJuIHBhcnNlVGV4dFJlcGx5KFN0cmluZyh1c2VyUmVwbGllc1swXS50ZXh0KSwgcHJvbXB0LnF1ZXN0aW9ucyk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNsYWNrQWNrbm93bGVkZ2UocmVmOiBSZW1vdGVQcm9tcHRSZWYsIHRva2VuOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBhd2FpdCBhcGlSZXF1ZXN0KFxuICAgICAgYCR7U0xBQ0tfQVBJfS9yZWFjdGlvbnMuYWRkYCxcbiAgICAgICdQT1NUJyxcbiAgICAgIHsgY2hhbm5lbDogcmVmLmNoYW5uZWxJZCwgdGltZXN0YW1wOiByZWYubWVzc2FnZUlkLCBuYW1lOiAnd2hpdGVfY2hlY2tfbWFyaycgfSxcbiAgICAgICdCZWFyZXInLCB0b2tlbiwgJ1NsYWNrIEFQSScsXG4gICAgKTtcbiAgfSBjYXRjaCB7IC8qIGJlc3QtZWZmb3J0ICovIH1cbn1cblxuLy8gLS0tIFRlbGVncmFtIC0tLVxuXG5hc3luYyBmdW5jdGlvbiB0ZWxlZ3JhbVZhbGlkYXRlKHRva2VuOiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBhcGlSZXF1ZXN0KGAke1RFTEVHUkFNX0FQSX0vYm90JHt0b2tlbn0vZ2V0TWVgLCAnR0VUJywgdW5kZWZpbmVkLCAnQmVhcmVyJywgdG9rZW4sICdUZWxlZ3JhbSBBUEknKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgY29uc3QgcmVzdWx0ID0gcmVzWydyZXN1bHQnXSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgaWYgKCFyZXNbJ29rJ10gfHwgIXJlc3VsdD8uWydpZCddKSB0aHJvdyBuZXcgRXJyb3IoJ1RlbGVncmFtIGF1dGggZmFpbGVkOiBpbnZhbGlkIGJvdCB0b2tlbicpO1xuICByZXR1cm4gcmVzdWx0WydpZCddIGFzIG51bWJlcjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdGVsZWdyYW1TZW5kKHByb21wdDogUmVtb3RlUHJvbXB0LCB0b2tlbjogc3RyaW5nLCBjaGF0SWQ6IHN0cmluZyk6IFByb21pc2U8RGlzcGF0Y2hSZXN1bHQ+IHtcbiAgY29uc3QgcGF5bG9hZCA9IGZvcm1hdEZvclRlbGVncmFtKHByb21wdCk7XG4gIGNvbnN0IHBhcmFtczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IGNoYXRfaWQ6IGNoYXRJZCwgdGV4dDogcGF5bG9hZC50ZXh0LCBwYXJzZV9tb2RlOiBwYXlsb2FkLnBhcnNlX21vZGUgfTtcbiAgaWYgKHBheWxvYWQucmVwbHlfbWFya3VwKSBwYXJhbXNbJ3JlcGx5X21hcmt1cCddID0gcGF5bG9hZC5yZXBseV9tYXJrdXA7XG5cbiAgY29uc3QgcmVzID0gYXdhaXQgYXBpUmVxdWVzdChgJHtURUxFR1JBTV9BUEl9L2JvdCR7dG9rZW59L3NlbmRNZXNzYWdlYCwgJ1BPU1QnLCBwYXJhbXMsICdCZWFyZXInLCB0b2tlbiwgJ1RlbGVncmFtIEFQSScpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBjb25zdCByZXN1bHQgPSByZXNbJ3Jlc3VsdCddIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICBpZiAoIXJlc1snb2snXSB8fCAhcmVzdWx0Py5bJ21lc3NhZ2VfaWQnXSkgdGhyb3cgbmV3IEVycm9yKGBUZWxlZ3JhbSBzZW5kTWVzc2FnZSBmYWlsZWQ6ICR7SlNPTi5zdHJpbmdpZnkocmVzKX1gKTtcblxuICBjb25zdCBtZXNzYWdlSWQgPSBTdHJpbmcocmVzdWx0WydtZXNzYWdlX2lkJ10pO1xuICAvLyBCdWlsZCBwdWJsaWMgVVJMIG9ubHkgZm9yIHB1YmxpYyBjaGFubmVscyAobmVnYXRpdmUgSURzIGFyZSBwcml2YXRlIGdyb3VwcylcbiAgY29uc3QgaXNQdWJsaWMgPSAhY2hhdElkLnN0YXJ0c1dpdGgoJy0nKTtcbiAgY29uc3QgbWVzc2FnZVVybCA9IGlzUHVibGljID8gYGh0dHBzOi8vdC5tZS8ke2NoYXRJZC5yZXBsYWNlKCdAJywgJycpfS8ke21lc3NhZ2VJZH1gIDogdW5kZWZpbmVkO1xuXG4gIHJldHVybiB7IHJlZjogeyBpZDogcHJvbXB0LmlkLCBjaGFubmVsOiAndGVsZWdyYW0nLCBtZXNzYWdlSWQsIGNoYW5uZWxJZDogY2hhdElkLCB0aHJlYWRVcmw6IG1lc3NhZ2VVcmwgfSB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiB0ZWxlZ3JhbVBvbGwoXG4gIHByb21wdDogUmVtb3RlUHJvbXB0LFxuICByZWY6IFJlbW90ZVByb21wdFJlZixcbiAgdG9rZW46IHN0cmluZyxcbiAgYm90VXNlcklkOiBudW1iZXIsXG4gIGxhc3RVcGRhdGVJZDogeyB2YWx1ZTogbnVtYmVyIH0sXG4pOiBQcm9taXNlPFJlbW90ZUFuc3dlciB8IG51bGw+IHtcbiAgY29uc3QgcGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBvZmZzZXQ6IGxhc3RVcGRhdGVJZC52YWx1ZSArIDEsXG4gICAgdGltZW91dDogMCxcbiAgICBhbGxvd2VkX3VwZGF0ZXM6IFsnbWVzc2FnZScsICdjYWxsYmFja19xdWVyeSddLFxuICB9O1xuXG4gIGNvbnN0IHJlcyA9IGF3YWl0IGFwaVJlcXVlc3QoYCR7VEVMRUdSQU1fQVBJfS9ib3Qke3Rva2VufS9nZXRVcGRhdGVzYCwgJ1BPU1QnLCBwYXJhbXMsICdCZWFyZXInLCB0b2tlbiwgJ1RlbGVncmFtIEFQSScpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBpZiAoIXJlc1snb2snXSB8fCAhQXJyYXkuaXNBcnJheShyZXNbJ3Jlc3VsdCddKSkgcmV0dXJuIG51bGw7XG5cbiAgZm9yIChjb25zdCB1cGRhdGUgb2YgcmVzWydyZXN1bHQnXSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdKSB7XG4gICAgaWYgKCh1cGRhdGVbJ3VwZGF0ZV9pZCddIGFzIG51bWJlcikgPiBsYXN0VXBkYXRlSWQudmFsdWUpIHtcbiAgICAgIGxhc3RVcGRhdGVJZC52YWx1ZSA9IHVwZGF0ZVsndXBkYXRlX2lkJ10gYXMgbnVtYmVyO1xuICAgIH1cblxuICAgIC8vIENhbGxiYWNrIHF1ZXJ5IChpbmxpbmUga2V5Ym9hcmQgYnV0dG9uIHByZXNzKVxuICAgIGlmICh1cGRhdGVbJ2NhbGxiYWNrX3F1ZXJ5J10pIHtcbiAgICAgIGNvbnN0IGNxID0gdXBkYXRlWydjYWxsYmFja19xdWVyeSddIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgY29uc3QgbXNnID0gY3FbJ21lc3NhZ2UnXSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGZyb20gPSBjcVsnZnJvbSddIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKG1zZyAmJiBTdHJpbmcoKG1zZ1snY2hhdCddIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KT8uWydpZCddKSA9PT0gcmVmLmNoYW5uZWxJZCAmJlxuICAgICAgICAgIFN0cmluZyhtc2dbJ21lc3NhZ2VfaWQnXSkgPT09IHJlZi5tZXNzYWdlSWQgJiYgZnJvbT8uWydpZCddICE9PSBib3RVc2VySWQpIHtcbiAgICAgICAgLy8gRGlzbWlzcyBsb2FkaW5nIHNwaW5uZXJcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBhd2FpdCBhcGlSZXF1ZXN0KGAke1RFTEVHUkFNX0FQSX0vYm90JHt0b2tlbn0vYW5zd2VyQ2FsbGJhY2tRdWVyeWAsICdQT1NUJywgeyBjYWxsYmFja19xdWVyeV9pZDogY3FbJ2lkJ10gfSwgJ0JlYXJlcicsIHRva2VuLCAnVGVsZWdyYW0gQVBJJyk7XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBiZXN0LWVmZm9ydCAqLyB9XG4gICAgICAgIGNvbnN0IGNhbGxiYWNrRGF0YSA9IGNxWydkYXRhJ10gPyBTdHJpbmcoY3FbJ2RhdGEnXSkgOiBudWxsO1xuICAgICAgICBpZiAoY2FsbGJhY2tEYXRhKSB7XG4gICAgICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VUZWxlZ3JhbUNhbGxiYWNrRGF0YShjYWxsYmFja0RhdGEsIHByb21wdC5xdWVzdGlvbnMsIHByb21wdC5pZCk7XG4gICAgICAgICAgaWYgKHBhcnNlZCkgcmV0dXJuIHBhcnNlZDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFRleHQgbWVzc2FnZSByZXBseVxuICAgIGlmICh1cGRhdGVbJ21lc3NhZ2UnXSkge1xuICAgICAgY29uc3QgbXNnID0gdXBkYXRlWydtZXNzYWdlJ10gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICBjb25zdCBmcm9tID0gbXNnWydmcm9tJ10gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gICAgICBpZiAoU3RyaW5nKChtc2dbJ2NoYXQnXSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik/LlsnaWQnXSkgPT09IHJlZi5jaGFubmVsSWQgJiZcbiAgICAgICAgICBmcm9tPy5bJ2lkJ10gIT09IGJvdFVzZXJJZCAmJiBtc2dbJ3RleHQnXSkge1xuICAgICAgICByZXR1cm4gcGFyc2VUZXh0UmVwbHkoU3RyaW5nKG1zZ1sndGV4dCddKSwgcHJvbXB0LnF1ZXN0aW9ucyk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUG9sbGluZyBsb29wXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gc2xlZXAobXM6IG51bWJlciwgc2lnbmFsPzogQWJvcnRTaWduYWwpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgaWYgKHNpZ25hbD8uYWJvcnRlZCkgcmV0dXJuIHJlc29sdmUoKTtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIG9uQWJvcnQpO1xuICAgICAgcmVzb2x2ZSgpO1xuICAgIH0sIG1zKTtcbiAgICBjb25zdCBvbkFib3J0ID0gKCkgPT4geyBjbGVhclRpbWVvdXQodGltZXIpOyByZXNvbHZlKCk7IH07XG4gICAgc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIG9uQWJvcnQsIHsgb25jZTogdHJ1ZSB9KTtcbiAgfSk7XG59XG5cbmludGVyZmFjZSBDaGFubmVsU3RhdGUge1xuICBib3RVc2VySWQ6IHN0cmluZyB8IG51bWJlcjtcbiAgZ3VpbGRJZD86IHN0cmluZyB8IG51bGw7IC8vIERpc2NvcmQgb25seVxuICBsYXN0VXBkYXRlSWQ/OiB7IHZhbHVlOiBudW1iZXIgfTsgLy8gVGVsZWdyYW0gb25seVxufVxuXG5hc3luYyBmdW5jdGlvbiBwb2xsVW50aWxEb25lKFxuICBjb25maWc6IFJlc29sdmVkQ29uZmlnLFxuICBwcm9tcHQ6IFJlbW90ZVByb21wdCxcbiAgcmVmOiBSZW1vdGVQcm9tcHRSZWYsXG4gIHN0YXRlOiBDaGFubmVsU3RhdGUsXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsLFxuKTogUHJvbWlzZTxSZW1vdGVBbnN3ZXIgfCBudWxsPiB7XG4gIHdoaWxlIChEYXRlLm5vdygpIDwgcHJvbXB0LnRpbWVvdXRBdCAmJiAhc2lnbmFsPy5hYm9ydGVkKSB7XG4gICAgdHJ5IHtcbiAgICAgIGxldCBhbnN3ZXI6IFJlbW90ZUFuc3dlciB8IG51bGwgPSBudWxsO1xuXG4gICAgICBpZiAoY29uZmlnLmNoYW5uZWwgPT09ICdkaXNjb3JkJykge1xuICAgICAgICBhbnN3ZXIgPSBhd2FpdCBkaXNjb3JkUG9sbChwcm9tcHQsIHJlZiwgY29uZmlnLnRva2VuLCBTdHJpbmcoc3RhdGUuYm90VXNlcklkKSk7XG4gICAgICB9IGVsc2UgaWYgKGNvbmZpZy5jaGFubmVsID09PSAnc2xhY2snKSB7XG4gICAgICAgIGFuc3dlciA9IGF3YWl0IHNsYWNrUG9sbChwcm9tcHQsIHJlZiwgY29uZmlnLnRva2VuLCBTdHJpbmcoc3RhdGUuYm90VXNlcklkKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhbnN3ZXIgPSBhd2FpdCB0ZWxlZ3JhbVBvbGwocHJvbXB0LCByZWYsIGNvbmZpZy50b2tlbiwgc3RhdGUuYm90VXNlcklkIGFzIG51bWJlciwgc3RhdGUubGFzdFVwZGF0ZUlkISk7XG4gICAgICB9XG5cbiAgICAgIGlmIChhbnN3ZXIpIHJldHVybiBhbnN3ZXI7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAvLyBBdXRoIGVycm9ycyAoNDAxLzQwMykgbWVhbiB0aGUgY29uZmlndXJlZCB0b2tlbiBpcyBpbnZhbGlkIG9yXG4gICAgICAvLyByZXZva2VkIFx1MjAxNCByZS10aHJvdyBzbyB0aGUgY2FsbGVyIGNhbiBzdXJmYWNlIGEgdXNlZnVsIGVycm9yXG4gICAgICAvLyBpbW1lZGlhdGVseSBpbnN0ZWFkIG9mIHNpbGVudGx5IHNwaW5uaW5nIHVudGlsIHRoZSB0aW1lb3V0LlxuICAgICAgLy8gTmV0d29yay90cmFuc2llbnQgZXJyb3JzIGtlZXAgdGhlIHJldHJ5IGJlaGF2aW91ci5cbiAgICAgIGNvbnN0IG1zZyA9IFN0cmluZygoZXJyIGFzIEVycm9yKT8ubWVzc2FnZSA/PyBlcnIpO1xuICAgICAgaWYgKG1zZy5pbmNsdWRlcygnSFRUUCA0MDEnKSB8fCBtc2cuaW5jbHVkZXMoJ0hUVFAgNDAzJykpIHtcbiAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgfVxuICAgICAgLy8gTm9uLWZhdGFsIHBvbGwgZXJyb3IgXHUyMDE0IHdhaXQgYW5kIHJldHJ5XG4gICAgfVxuXG4gICAgYXdhaXQgc2xlZXAocHJvbXB0LnBvbGxJbnRlcnZhbE1zLCBzaWduYWwpO1xuICB9XG5cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUHVibGljIGVudHJ5IHBvaW50XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gYnVpbGRQcm9tcHQocXVlc3Rpb25zOiBSZW1vdGVRdWVzdGlvbltdLCBjb25maWc6IFJlc29sdmVkQ29uZmlnKTogUmVtb3RlUHJvbXB0IHtcbiAgY29uc3QgY3JlYXRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgcmV0dXJuIHtcbiAgICBpZDogcmFuZG9tVVVJRCgpLFxuICAgIGNoYW5uZWw6IGNvbmZpZy5jaGFubmVsLFxuICAgIGNyZWF0ZWRBdCxcbiAgICB0aW1lb3V0QXQ6IGNyZWF0ZWRBdCArIGNvbmZpZy50aW1lb3V0TXMsXG4gICAgcG9sbEludGVydmFsTXM6IGNvbmZpZy5wb2xsSW50ZXJ2YWxNcyxcbiAgICBjb250ZXh0OiB7IHNvdXJjZTogJ2Fza191c2VyX3F1ZXN0aW9ucycgfSxcbiAgICBxdWVzdGlvbnM6IHF1ZXN0aW9ucy5tYXAoKHEpID0+ICh7XG4gICAgICBpZDogcS5pZCxcbiAgICAgIGhlYWRlcjogcS5oZWFkZXIsXG4gICAgICBxdWVzdGlvbjogcS5xdWVzdGlvbixcbiAgICAgIG9wdGlvbnM6IHEub3B0aW9ucyxcbiAgICAgIGFsbG93TXVsdGlwbGU6IHEuYWxsb3dNdWx0aXBsZSA/PyBmYWxzZSxcbiAgICB9KSksXG4gIH07XG59XG5cbmZ1bmN0aW9uIGZvcm1hdEZvclRvb2woYW5zd2VyOiBSZW1vdGVBbnN3ZXIpOiBSZWNvcmQ8c3RyaW5nLCB7IGFuc3dlcnM6IHN0cmluZ1tdIH0+IHtcbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB7IGFuc3dlcnM6IHN0cmluZ1tdIH0+ID0ge307XG4gIGZvciAoY29uc3QgW2lkLCBkYXRhXSBvZiBPYmplY3QuZW50cmllcyhhbnN3ZXIuYW5zd2VycykpIHtcbiAgICBjb25zdCBsaXN0ID0gWy4uLmRhdGEuYW5zd2Vyc107XG4gICAgaWYgKGRhdGEudXNlcl9ub3RlKSBsaXN0LnB1c2goYHVzZXJfbm90ZTogJHtkYXRhLnVzZXJfbm90ZX1gKTtcbiAgICBvdXRbaWRdID0geyBhbnN3ZXJzOiBsaXN0IH07XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqXG4gKiBOb3JtYWxpemUgYSBgUmVtb3RlQW5zd2VyYCBpbnRvIHRoZSBgUm91bmRSZXN1bHRgIHNoYXBlIHRoZSBHU0RcbiAqIGRpc2N1c3Npb24tZ2F0ZSBob29rIHJlYWRzIGZyb20gYHRvb2xfcmVzdWx0YCBgZGV0YWlscy5yZXNwb25zZWAuIE1pcnJvcnNcbiAqIGBzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvcmVtb3RlLXF1ZXN0aW9ucy9tYW5hZ2VyLnRzOnRvUm91bmRSZXN1bHRSZXNwb25zZWBcbiAqIGFuZCB0aGUgbG9jYWwtcGF0aCBoZWxwZXIgYGJ1aWxkQXNrVXNlclF1ZXN0aW9uc1JvdW5kUmVzdWx0YCBpbiBzZXJ2ZXIudHMuXG4gKiBXaXRob3V0IHRoaXMsIHRoZSByZW1vdGUgY2hhbm5lbCAoRGlzY29yZCAvIFNsYWNrIC8gVGVsZWdyYW0pIHdvdWxkIGhhdmVcbiAqIHRoZSBzYW1lIGdhdGUtc3R1Y2sgcHJvYmxlbSBhcyB0aGUgbG9jYWwgZWxpY2l0YXRpb24gcGF0aC4gU2VlICM1MjY3LlxuICpcbiAqIGBxdWVzdGlvbnNgIGlzIHJlcXVpcmVkIHNvIHRoZSBtdWx0aS1zZWxlY3QgY29udHJhY3QgaXMgcHJlc2VydmVkOiBhXG4gKiBgYWxsb3dNdWx0aXBsZWAgcXVlc3Rpb24gd2l0aCBhIHNpbmdsZSBzZWxlY3Rpb24gbXVzdCBzdGlsbCBzdXJmYWNlXG4gKiBgc2VsZWN0ZWQ6IFtsYWJlbF1gIHNvIGNvbnN1bWVycyByZWFkaW5nIGBzZWxlY3RlZC5pbmNsdWRlcyguLi4pYCBrZWVwXG4gKiB3b3JraW5nLiBGYWxsaW5nIGJhY2sgdG8gbGVuZ3RoLWJhc2VkIGluZmVyZW5jZSAodGhlIHByZXZpb3VzIGJlaGF2aW9yKVxuICogc2lsZW50bHkgZGVtb3RlZCBzaW5nbGUtcGljayBtdWx0aS1zZWxlY3QgYW5zd2VycyB0byBzdHJpbmdzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdG9Sb3VuZFJlc3VsdFJlc3BvbnNlKFxuICBhbnN3ZXI6IFJlbW90ZUFuc3dlcixcbiAgcXVlc3Rpb25zOiBSZW1vdGVRdWVzdGlvbltdLFxuKToge1xuICBlbmRJbnRlcnZpZXc6IGZhbHNlO1xuICBhbnN3ZXJzOiBSZWNvcmQ8c3RyaW5nLCB7IHNlbGVjdGVkOiBzdHJpbmcgfCBzdHJpbmdbXTsgbm90ZXM6IHN0cmluZyB9Pjtcbn0ge1xuICBjb25zdCBhbGxvd011bHRpcGxlQnlJZCA9IG5ldyBNYXA8c3RyaW5nLCBib29sZWFuPigpO1xuICBmb3IgKGNvbnN0IHEgb2YgcXVlc3Rpb25zKSBhbGxvd011bHRpcGxlQnlJZC5zZXQocS5pZCwgcS5hbGxvd011bHRpcGxlID8/IGZhbHNlKTtcblxuICBjb25zdCBub3JtYWxpemVkOiBSZWNvcmQ8c3RyaW5nLCB7IHNlbGVjdGVkOiBzdHJpbmcgfCBzdHJpbmdbXTsgbm90ZXM6IHN0cmluZyB9PiA9IHt9O1xuICBmb3IgKGNvbnN0IFtpZCwgZGF0YV0gb2YgT2JqZWN0LmVudHJpZXMoYW5zd2VyLmFuc3dlcnMpKSB7XG4gICAgY29uc3QgbGlzdCA9IGRhdGEuYW5zd2VycyA/PyBbXTtcbiAgICBjb25zdCBhbGxvd011bHRpcGxlID0gYWxsb3dNdWx0aXBsZUJ5SWQuZ2V0KGlkKSA/PyBmYWxzZTtcbiAgICBjb25zdCBzZWxlY3RlZDogc3RyaW5nIHwgc3RyaW5nW10gPSBhbGxvd011bHRpcGxlID8gbGlzdCA6IChsaXN0WzBdID8/ICcnKTtcbiAgICBub3JtYWxpemVkW2lkXSA9IHsgc2VsZWN0ZWQsIG5vdGVzOiBkYXRhLnVzZXJfbm90ZSA/PyAnJyB9O1xuICB9XG4gIHJldHVybiB7IGVuZEludGVydmlldzogZmFsc2UsIGFuc3dlcnM6IG5vcm1hbGl6ZWQgfTtcbn1cblxuLyoqXG4gKiBEaXNwYXRjaCBxdWVzdGlvbnMgdG8gdGhlIGNvbmZpZ3VyZWQgcmVtb3RlIGNoYW5uZWwgYW5kIHdhaXQgZm9yIGEgcmVzcG9uc2UuXG4gKlxuICogUmV0dXJucyBudWxsIHdoZW4gbm8gcmVtb3RlIGNoYW5uZWwgaXMgY29uZmlndXJlZC5cbiAqIFJldHVybnMgYSB0b29sIHJlc3VsdCBzaGFwZWQgbGlrZSB7IGNvbnRlbnQsIGRldGFpbHMgfSBvbiBzdWNjZXNzIG9yXG4gKiB0aW1lb3V0IFx1MjAxNCBjYWxsZXJzIHNob3VsZCBjaGVjayBkZXRhaWxzLnRpbWVkX291dCBiZWZvcmUgdHJ1c3RpbmcgdGhlIHJlc3VsdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRyeVJlbW90ZVF1ZXN0aW9ucyhcbiAgcXVlc3Rpb25zOiBSZW1vdGVRdWVzdGlvbltdLFxuICBzaWduYWw/OiBBYm9ydFNpZ25hbCxcbik6IFByb21pc2U8UmVtb3RlVG9vbFJlc3VsdCB8IG51bGw+IHtcbiAgY29uc3QgY29uZmlnID0gcmVzb2x2ZVJlbW90ZUNvbmZpZygpO1xuICBpZiAoIWNvbmZpZykgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgcHJvbXB0ID0gYnVpbGRQcm9tcHQocXVlc3Rpb25zLCBjb25maWcpO1xuXG4gIC8vIFZhbGlkYXRlIGF1dGggYW5kIHNlbmQgdGhlIHByb21wdFxuICBsZXQgcmVmOiBSZW1vdGVQcm9tcHRSZWY7XG4gIGxldCBzdGF0ZTogQ2hhbm5lbFN0YXRlO1xuXG4gIHRyeSB7XG4gICAgaWYgKGNvbmZpZy5jaGFubmVsID09PSAnZGlzY29yZCcpIHtcbiAgICAgIGNvbnN0IHsgYm90VXNlcklkLCBndWlsZElkIH0gPSBhd2FpdCBkaXNjb3JkVmFsaWRhdGUoY29uZmlnLnRva2VuLCBjb25maWcuY2hhbm5lbElkKTtcbiAgICAgIHN0YXRlID0geyBib3RVc2VySWQsIGd1aWxkSWQgfTtcbiAgICAgIGNvbnN0IGRpc3BhdGNoID0gYXdhaXQgZGlzY29yZFNlbmQocHJvbXB0LCBjb25maWcudG9rZW4sIGNvbmZpZy5jaGFubmVsSWQsIGd1aWxkSWQpO1xuICAgICAgcmVmID0gZGlzcGF0Y2gucmVmO1xuICAgIH0gZWxzZSBpZiAoY29uZmlnLmNoYW5uZWwgPT09ICdzbGFjaycpIHtcbiAgICAgIGNvbnN0IGJvdFVzZXJJZCA9IGF3YWl0IHNsYWNrVmFsaWRhdGUoY29uZmlnLnRva2VuKTtcbiAgICAgIHN0YXRlID0geyBib3RVc2VySWQgfTtcbiAgICAgIGNvbnN0IGRpc3BhdGNoID0gYXdhaXQgc2xhY2tTZW5kKHByb21wdCwgY29uZmlnLnRva2VuLCBjb25maWcuY2hhbm5lbElkKTtcbiAgICAgIHJlZiA9IGRpc3BhdGNoLnJlZjtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgYm90VXNlcklkID0gYXdhaXQgdGVsZWdyYW1WYWxpZGF0ZShjb25maWcudG9rZW4pO1xuICAgICAgc3RhdGUgPSB7IGJvdFVzZXJJZCwgbGFzdFVwZGF0ZUlkOiB7IHZhbHVlOiAwIH0gfTtcbiAgICAgIGNvbnN0IGRpc3BhdGNoID0gYXdhaXQgdGVsZWdyYW1TZW5kKHByb21wdCwgY29uZmlnLnRva2VuLCBjb25maWcuY2hhbm5lbElkKTtcbiAgICAgIHJlZiA9IGRpc3BhdGNoLnJlZjtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiAndGV4dCcsIHRleHQ6IGBSZW1vdGUgcXVlc3Rpb25zIGZhaWxlZCAoJHtjb25maWcuY2hhbm5lbH0pOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCB9XSxcbiAgICAgIGRldGFpbHM6IHsgcmVtb3RlOiB0cnVlLCBjaGFubmVsOiBjb25maWcuY2hhbm5lbCwgZXJyb3I6IHRydWUsIHN0YXR1czogJ2ZhaWxlZCcgfSxcbiAgICB9O1xuICB9XG5cbiAgbGV0IGFuc3dlcjogUmVtb3RlQW5zd2VyIHwgbnVsbDtcbiAgdHJ5IHtcbiAgICBhbnN3ZXIgPSBhd2FpdCBwb2xsVW50aWxEb25lKGNvbmZpZywgcHJvbXB0LCByZWYsIHN0YXRlLCBzaWduYWwpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW3sgdHlwZTogJ3RleHQnLCB0ZXh0OiBgUmVtb3RlIHF1ZXN0aW9ucyBmYWlsZWQgKCR7Y29uZmlnLmNoYW5uZWx9KTogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWAgfV0sXG4gICAgICBkZXRhaWxzOiB7IHJlbW90ZTogdHJ1ZSwgY2hhbm5lbDogY29uZmlnLmNoYW5uZWwsIGVycm9yOiB0cnVlLCBzdGF0dXM6ICdmYWlsZWQnIH0sXG4gICAgfTtcbiAgfVxuXG4gIGlmICghYW5zd2VyKSB7XG4gICAgY29uc3QgdGltZWRPdXQgPSAhc2lnbmFsPy5hYm9ydGVkO1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbe1xuICAgICAgICB0eXBlOiAndGV4dCcsXG4gICAgICAgIHRleHQ6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICB0aW1lZF9vdXQ6IHRpbWVkT3V0LFxuICAgICAgICAgIGNoYW5uZWw6IGNvbmZpZy5jaGFubmVsLFxuICAgICAgICAgIHByb21wdF9pZDogcHJvbXB0LmlkLFxuICAgICAgICAgIHRpbWVvdXRfbWludXRlczogY29uZmlnLnRpbWVvdXRNcyAvIDYwMDAwLFxuICAgICAgICAgIHRocmVhZF91cmw6IHJlZi50aHJlYWRVcmwgPz8gbnVsbCxcbiAgICAgICAgICBtZXNzYWdlOiBgVXNlciBkaWQgbm90IHJlc3BvbmQgd2l0aGluICR7Y29uZmlnLnRpbWVvdXRNcyAvIDYwMDAwfSBtaW51dGVzLmAsXG4gICAgICAgIH0pLFxuICAgICAgfV0sXG4gICAgICBkZXRhaWxzOiB7XG4gICAgICAgIHJlbW90ZTogdHJ1ZSxcbiAgICAgICAgY2hhbm5lbDogY29uZmlnLmNoYW5uZWwsXG4gICAgICAgIHRpbWVkX291dDogdGltZWRPdXQsXG4gICAgICAgIHByb21wdElkOiBwcm9tcHQuaWQsXG4gICAgICAgIHRocmVhZFVybDogcmVmLnRocmVhZFVybCA/PyBudWxsLFxuICAgICAgICBzdGF0dXM6IHNpZ25hbD8uYWJvcnRlZCA/ICdjYW5jZWxsZWQnIDogJ3RpbWVkX291dCcsXG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICAvLyBCZXN0LWVmZm9ydCBhY2tub3dsZWRnZW1lbnRcbiAgdHJ5IHtcbiAgICBpZiAoY29uZmlnLmNoYW5uZWwgPT09ICdkaXNjb3JkJykgYXdhaXQgZGlzY29yZEFja25vd2xlZGdlKHJlZiwgY29uZmlnLnRva2VuKTtcbiAgICBlbHNlIGlmIChjb25maWcuY2hhbm5lbCA9PT0gJ3NsYWNrJykgYXdhaXQgc2xhY2tBY2tub3dsZWRnZShyZWYsIGNvbmZpZy50b2tlbik7XG4gIH0gY2F0Y2ggeyAvKiBiZXN0LWVmZm9ydCAqLyB9XG5cbiAgcmV0dXJuIHtcbiAgICBjb250ZW50OiBbeyB0eXBlOiAndGV4dCcsIHRleHQ6IEpTT04uc3RyaW5naWZ5KHsgYW5zd2VyczogZm9ybWF0Rm9yVG9vbChhbnN3ZXIpIH0pIH1dLFxuICAgIGRldGFpbHM6IHtcbiAgICAgIHJlbW90ZTogdHJ1ZSxcbiAgICAgIGNoYW5uZWw6IGNvbmZpZy5jaGFubmVsLFxuICAgICAgdGltZWRfb3V0OiBmYWxzZSxcbiAgICAgIHByb21wdElkOiBwcm9tcHQuaWQsXG4gICAgICB0aHJlYWRVcmw6IHJlZi50aHJlYWRVcmwgPz8gbnVsbCxcbiAgICAgIHF1ZXN0aW9ucyxcbiAgICAgIHJlc3BvbnNlOiB0b1JvdW5kUmVzdWx0UmVzcG9uc2UoYW5zd2VyLCBxdWVzdGlvbnMpLFxuICAgICAgc3RhdHVzOiAnYW5zd2VyZWQnLFxuICAgIH0sXG4gIH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFjQSxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLGVBQWU7QUFDeEIsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsa0JBQWtCO0FBNkQzQixNQUFNLHlCQUF5QjtBQUMvQixNQUFNLGNBQWM7QUFDcEIsTUFBTSxZQUFZO0FBQ2xCLE1BQU0sZUFBZTtBQUVyQixNQUFNLHdCQUF3QixDQUFDLGlCQUFPLGlCQUFPLGlCQUFPLGlCQUFPLGVBQUs7QUFDaEUsTUFBTSw4QkFBOEIsQ0FBQyxPQUFPLE9BQU8sU0FBUyxRQUFRLE1BQU07QUFFMUUsTUFBTSwwQkFBMEI7QUFDaEMsTUFBTSxnQ0FBZ0M7QUFDdEMsTUFBTSxzQkFBc0I7QUFDNUIsTUFBTSxzQkFBc0I7QUFDNUIsTUFBTSw0QkFBNEI7QUFDbEMsTUFBTSw0QkFBNEI7QUFFbEMsTUFBTSxzQkFBcUQ7QUFBQSxFQUN6RCxPQUFPO0FBQUEsRUFDUCxTQUFTO0FBQUEsRUFDVCxVQUFVO0FBQ1o7QUFFQSxNQUFNLFdBQTBDO0FBQUEsRUFDOUMsT0FBTztBQUFBLEVBQ1AsU0FBUztBQUFBLEVBQ1QsVUFBVTtBQUNaO0FBTUEsU0FBUyxZQUFZLE9BQWdCLFVBQWtCLEtBQWEsS0FBcUI7QUFDdkYsUUFBTSxJQUFJLE9BQU8sVUFBVSxXQUFXLFFBQVEsT0FBTyxLQUFLO0FBQzFELE1BQUksQ0FBQyxPQUFPLFNBQVMsQ0FBQyxFQUFHLFFBQU87QUFDaEMsU0FBTyxLQUFLLElBQUksS0FBSyxLQUFLLElBQUksS0FBSyxDQUFDLENBQUM7QUFDdkM7QUFXQSxTQUFTLHVCQUF1QixTQUEwQztBQUN4RSxRQUFNLFFBQVEsUUFB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
