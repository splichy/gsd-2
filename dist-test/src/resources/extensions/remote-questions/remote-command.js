import { AuthStorage } from "@gsd/pi-coding-agent";
import { Editor, Key, matchesKey, truncateToWidth } from "@gsd/pi-tui";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getGlobalGSDPreferencesPath, loadEffectiveGSDPreferences } from "../gsd/preferences.js";
import { getRemoteConfigStatus, isValidChannelId, resolveRemoteConfig } from "./config.js";
import { maskEditorLine, sanitizeError } from "../shared/mod.js";
import { getLatestPromptSummary } from "./status.js";
import { gsdHome } from "../gsd/gsd-home.js";
async function handleRemote(subcommand, ctx, _pi) {
  const trimmed = subcommand.trim();
  if (trimmed === "slack") return handleSetupSlack(ctx);
  if (trimmed === "discord") return handleSetupDiscord(ctx);
  if (trimmed === "telegram") return handleSetupTelegram(ctx);
  if (trimmed === "status") return handleRemoteStatus(ctx);
  if (trimmed === "disconnect") return handleDisconnect(ctx);
  return handleRemoteMenu(ctx);
}
async function handleSetupSlack(ctx) {
  const token = await promptMaskedInput(ctx, "Slack Bot Token", "Paste your xoxb-... token");
  if (!token) return void ctx.ui.notify("Slack setup cancelled.", "info");
  if (!token.startsWith("xoxb-")) return void ctx.ui.notify("Invalid token format \u2014 Slack bot tokens start with xoxb-.", "warning");
  ctx.ui.notify("Validating token...", "info");
  const auth = await fetchJson("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${token}` } });
  if (!auth?.ok) return void ctx.ui.notify("Token validation failed \u2014 check the token and app install.", "error");
  const channels = await listSlackChannels(token);
  const MANUAL_OPTION = "Enter channel ID manually";
  let channelId;
  if (!channels || channels.length === 0) {
    ctx.ui.notify("Could not list Slack channels \u2014 falling back to manual entry.", "warning");
    channelId = await promptSlackChannelId(ctx) ?? "";
  } else {
    const channelOptions = [...channels.map((channel) => channel.label), MANUAL_OPTION];
    const selectedChannel = await ctx.ui.select("Select a Slack channel", channelOptions);
    if (!selectedChannel) return void ctx.ui.notify("Slack setup cancelled.", "info");
    if (selectedChannel === MANUAL_OPTION) {
      channelId = await promptSlackChannelId(ctx) ?? "";
    } else {
      const chosen = channels.find((channel) => channel.label === selectedChannel);
      if (!chosen) return void ctx.ui.notify("Slack setup cancelled.", "info");
      channelId = chosen.id;
    }
  }
  if (!channelId) return void ctx.ui.notify("Slack setup cancelled.", "info");
  const send = await fetchJson("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: channelId, text: "GSD remote questions connected." })
  });
  if (!send?.ok) return void ctx.ui.notify(`Could not send to channel: ${send?.error ?? "unknown error"}`, "error");
  saveProviderToken("slack_bot", token);
  process.env.SLACK_BOT_TOKEN = token;
  saveRemoteQuestionsConfig("slack", channelId);
  ctx.ui.notify(`Slack connected \u2014 remote questions enabled for channel ${channelId}.`, "info");
}
async function handleSetupDiscord(ctx) {
  const token = await promptMaskedInput(ctx, "Discord Bot Token", "Paste your bot token");
  if (!token) return void ctx.ui.notify("Discord setup cancelled.", "info");
  ctx.ui.notify("Validating token...", "info");
  const headers = { Authorization: `Bot ${token}` };
  const auth = await fetchJson("https://discord.com/api/v10/users/@me", { headers });
  if (!auth?.id) return void ctx.ui.notify("Token validation failed \u2014 check the bot token.", "error");
  const guilds = await fetchJson("https://discord.com/api/v10/users/@me/guilds", { headers });
  if (!Array.isArray(guilds) || guilds.length === 0) {
    return void ctx.ui.notify("Bot is not in any Discord servers.", "error");
  }
  let guildId;
  let guildName;
  if (guilds.length === 1) {
    guildId = guilds[0].id;
    guildName = guilds[0].name;
  } else {
    const guildOptions = guilds.map((g) => g.name);
    const selectedGuild = await ctx.ui.select("Select a Discord server", guildOptions);
    if (!selectedGuild) return void ctx.ui.notify("Discord setup cancelled.", "info");
    const chosen = guilds.find((g) => g.name === selectedGuild);
    if (!chosen) return void ctx.ui.notify("Discord setup cancelled.", "info");
    guildId = chosen.id;
    guildName = chosen.name;
  }
  ctx.ui.notify(`Fetching channels for ${guildName}...`, "info");
  const allChannels = await fetchJson(
    `https://discord.com/api/v10/guilds/${guildId}/channels`,
    { headers }
  );
  const textChannels = Array.isArray(allChannels) ? allChannels.filter((ch) => ch.type === 0 || ch.type === 5) : [];
  const MANUAL_OPTION = "Enter channel ID manually";
  let channelId;
  if (textChannels.length === 0) {
    ctx.ui.notify("No text channels found \u2014 falling back to manual entry.", "warning");
    const manualId = await promptInput(ctx, "Channel ID", "Paste the Discord channel ID (e.g. 1234567890123456789)");
    if (!manualId) return void ctx.ui.notify("Discord setup cancelled.", "info");
    if (!isValidChannelId("discord", manualId)) return void ctx.ui.notify("Invalid Discord channel ID format \u2014 expected 17-20 digit numeric ID.", "error");
    channelId = manualId;
  } else {
    const channelOptions = [...textChannels.map((ch) => `#${ch.name}`), MANUAL_OPTION];
    const selectedChannel = await ctx.ui.select("Select a channel", channelOptions);
    if (!selectedChannel) return void ctx.ui.notify("Discord setup cancelled.", "info");
    if (selectedChannel === MANUAL_OPTION) {
      const manualId = await promptInput(ctx, "Channel ID", "Paste the Discord channel ID (e.g. 1234567890123456789)");
      if (!manualId) return void ctx.ui.notify("Discord setup cancelled.", "info");
      if (!isValidChannelId("discord", manualId)) return void ctx.ui.notify("Invalid Discord channel ID format \u2014 expected 17-20 digit numeric ID.", "error");
      channelId = manualId;
    } else {
      const chosenChannel = textChannels.find((ch) => `#${ch.name}` === selectedChannel);
      if (!chosenChannel) return void ctx.ui.notify("Discord setup cancelled.", "info");
      channelId = chosenChannel.id;
    }
  }
  const sendResponse = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ content: "GSD remote questions connected." }),
    signal: AbortSignal.timeout(15e3)
  });
  if (!sendResponse.ok) {
    const body = await sendResponse.text().catch(() => "");
    return void ctx.ui.notify(`Could not send to channel (HTTP ${sendResponse.status}): ${sanitizeError(body).slice(0, 200)}`, "error");
  }
  saveProviderToken("discord_bot", token);
  process.env.DISCORD_BOT_TOKEN = token;
  saveRemoteQuestionsConfig("discord", channelId);
  ctx.ui.notify(`Discord connected \u2014 remote questions enabled for channel ${channelId}.`, "info");
}
async function handleSetupTelegram(ctx) {
  const token = await promptMaskedInput(ctx, "Telegram Bot Token", "Paste your bot token from @BotFather");
  if (!token) return void ctx.ui.notify("Telegram setup cancelled.", "info");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) return void ctx.ui.notify("Invalid token format \u2014 Telegram bot tokens look like 123456789:ABCdefGHI...", "warning");
  ctx.ui.notify("Validating token...", "info");
  const auth = await fetchJson(`https://api.telegram.org/bot${token}/getMe`);
  if (!auth?.ok || !auth?.result?.id) return void ctx.ui.notify("Token validation failed \u2014 check the bot token.", "error");
  const chatId = await promptInput(ctx, "Chat ID", "Paste the Telegram chat ID (e.g. -1001234567890)");
  if (!chatId) return void ctx.ui.notify("Telegram setup cancelled.", "info");
  if (!isValidChannelId("telegram", chatId)) return void ctx.ui.notify("Invalid Telegram chat ID format \u2014 expected a numeric ID (can be negative for groups).", "error");
  const send = await fetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: "GSD remote questions connected." })
  });
  if (!send?.ok) return void ctx.ui.notify(`Could not send to chat: ${send?.description ?? "unknown error"}`, "error");
  saveProviderToken("telegram_bot", token);
  process.env.TELEGRAM_BOT_TOKEN = token;
  saveRemoteQuestionsConfig("telegram", chatId);
  ctx.ui.notify(`Telegram connected \u2014 remote questions enabled for chat ${chatId}.`, "info");
}
async function handleRemoteStatus(ctx) {
  const status = getRemoteConfigStatus();
  const config = resolveRemoteConfig();
  if (!config) {
    ctx.ui.notify(status, status.includes("disabled") ? "warning" : "info");
    return;
  }
  const latestPrompt = getLatestPromptSummary();
  const lines = [status];
  if (latestPrompt) {
    lines.push(`Last prompt: ${latestPrompt.id}`);
    lines.push(`  status: ${latestPrompt.status}`);
    if (latestPrompt.updatedAt) lines.push(`  updated: ${new Date(latestPrompt.updatedAt).toLocaleString()}`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}
async function handleDisconnect(ctx) {
  const prefs = loadEffectiveGSDPreferences();
  const channel = prefs?.preferences.remote_questions?.channel;
  if (!channel) return void ctx.ui.notify("No remote channel configured \u2014 nothing to disconnect.", "info");
  removeRemoteQuestionsConfig();
  const providerMap = { slack: "slack_bot", discord: "discord_bot", telegram: "telegram_bot" };
  removeProviderToken(providerMap[channel] ?? channel);
  if (channel === "slack") delete process.env.SLACK_BOT_TOKEN;
  if (channel === "discord") delete process.env.DISCORD_BOT_TOKEN;
  if (channel === "telegram") delete process.env.TELEGRAM_BOT_TOKEN;
  ctx.ui.notify(`Remote questions disconnected (${channel}).`, "info");
}
async function handleRemoteMenu(ctx) {
  const config = resolveRemoteConfig();
  const latestPrompt = getLatestPromptSummary();
  const lines = config ? [
    `Remote questions: ${config.channel} configured`,
    `  Timeout: ${config.timeoutMs / 6e4}m, poll: ${config.pollIntervalMs / 1e3}s`,
    latestPrompt ? `  Last prompt: ${latestPrompt.id} (${latestPrompt.status})` : "  No remote prompts recorded yet",
    "",
    "Commands:",
    "  /gsd remote status",
    "  /gsd remote disconnect",
    "  /gsd remote slack",
    "  /gsd remote discord",
    "  /gsd remote telegram"
  ] : [
    "No remote question channel configured.",
    "",
    "Commands:",
    "  /gsd remote slack",
    "  /gsd remote discord",
    "  /gsd remote telegram",
    "  /gsd remote status"
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}
async function fetchJson(url, init) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15e3) });
    return await response.json();
  } catch {
    return null;
  }
}
async function listSlackChannels(token) {
  const headers = { Authorization: `Bearer ${token}` };
  const channels = [];
  let cursor = "";
  do {
    const params = new URLSearchParams({
      exclude_archived: "true",
      limit: "200",
      types: "public_channel,private_channel"
    });
    if (cursor) params.set("cursor", cursor);
    const response = await fetchJson(`https://slack.com/api/users.conversations?${params.toString()}`, { headers });
    if (!response?.ok || !Array.isArray(response.channels)) {
      return channels.length > 0 ? channels.map(({ id, label }) => ({ id, label })) : null;
    }
    for (const channel of response.channels) {
      if (!channel.id || !channel.name) continue;
      channels.push({
        id: channel.id,
        name: channel.name,
        label: channel.is_private ? `[private] ${channel.name}` : `#${channel.name}`
      });
    }
    cursor = typeof response.response_metadata?.next_cursor === "string" ? response.response_metadata.next_cursor : "";
  } while (cursor);
  channels.sort((a, b) => a.name.localeCompare(b.name));
  return channels.map(({ id, label }) => ({ id, label }));
}
async function promptSlackChannelId(ctx) {
  const channelId = await promptInput(ctx, "Channel ID", "Paste the Slack channel ID (e.g. C0123456789)");
  if (!channelId) return null;
  if (!isValidChannelId("slack", channelId)) {
    ctx.ui.notify("Invalid Slack channel ID format \u2014 expected 9-12 uppercase alphanumeric characters.", "error");
    return null;
  }
  return channelId;
}
function getAuthStorage() {
  const authPath = join(gsdHome(), "agent", "auth.json");
  mkdirSync(dirname(authPath), { recursive: true });
  return AuthStorage.create(authPath);
}
function saveProviderToken(provider, token) {
  const auth = getAuthStorage();
  auth.set(provider, { type: "api_key", key: token });
}
function removeProviderToken(provider) {
  const auth = getAuthStorage();
  auth.remove(provider);
}
function saveRemoteQuestionsConfig(channel, channelId) {
  const prefsPath = getGlobalGSDPreferencesPath();
  const block = [
    "remote_questions:",
    `  channel: ${channel}`,
    `  channel_id: "${channelId}"`,
    "  timeout_minutes: 5",
    "  poll_interval_seconds: 5"
  ].join("\n");
  const content = existsSync(prefsPath) ? readFileSync(prefsPath, "utf-8") : "";
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  let next = content;
  if (fmMatch) {
    let frontmatter = fmMatch[1];
    const regex = /remote_questions:[\s\S]*?(?=\n[a-zA-Z_]|\n---|$)/;
    frontmatter = regex.test(frontmatter) ? frontmatter.replace(regex, block) : `${frontmatter.trimEnd()}
${block}`;
    next = `---
${frontmatter}
---${content.slice(fmMatch[0].length)}`;
  } else {
    next = `---
${block}
---

${content}`;
  }
  mkdirSync(dirname(prefsPath), { recursive: true });
  writeFileSync(prefsPath, next, "utf-8");
}
function removeRemoteQuestionsConfig() {
  const prefsPath = getGlobalGSDPreferencesPath();
  if (!existsSync(prefsPath)) return;
  const content = readFileSync(prefsPath, "utf-8");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return;
  const frontmatter = fmMatch[1].replace(/remote_questions:[\s\S]*?(?=\n[a-zA-Z_]|\n---|$)/, "").trim();
  const next = frontmatter ? `---
${frontmatter}
---${content.slice(fmMatch[0].length)}` : content.slice(fmMatch[0].length).replace(/^\n+/, "");
  writeFileSync(prefsPath, next, "utf-8");
}
async function promptMaskedInput(ctx, label, hint) {
  if (!ctx.hasUI) return null;
  return ctx.ui.custom((tui, theme, _kb, done) => {
    let cachedLines;
    const editorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t)
      }
    };
    const editor = new Editor(tui, editorTheme, { paddingX: 1 });
    const refresh = () => {
      cachedLines = void 0;
      tui.requestRender();
    };
    const handleInput = (data) => {
      if (matchesKey(data, Key.enter)) return done(editor.getText().trim() || null);
      if (matchesKey(data, Key.escape)) return done(null);
      editor.handleInput(data);
      refresh();
    };
    const render = (width) => {
      if (cachedLines) return cachedLines;
      const lines = [];
      const add = (s) => lines.push(truncateToWidth(s, width));
      add(theme.fg("accent", "\u2500".repeat(width)));
      add(theme.fg("accent", theme.bold(` ${label}`)));
      add(theme.fg("muted", `  ${hint}`));
      lines.push("");
      add(theme.fg("muted", " Enter value:"));
      for (const line of editor.render(width - 2)) add(theme.fg("text", maskEditorLine(line)));
      lines.push("");
      add(theme.fg("dim", " enter to confirm  |  esc to cancel"));
      add(theme.fg("accent", "\u2500".repeat(width)));
      cachedLines = lines;
      return lines;
    };
    return { render, handleInput, invalidate: () => {
      cachedLines = void 0;
    } };
  });
}
async function promptInput(ctx, label, hint) {
  if (!ctx.hasUI) return null;
  return ctx.ui.custom((tui, theme, _kb, done) => {
    let cachedLines;
    const editorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t)
      }
    };
    const editor = new Editor(tui, editorTheme, { paddingX: 1 });
    const refresh = () => {
      cachedLines = void 0;
      tui.requestRender();
    };
    const handleInput = (data) => {
      if (matchesKey(data, Key.enter)) return done(editor.getText().trim() || null);
      if (matchesKey(data, Key.escape)) return done(null);
      editor.handleInput(data);
      refresh();
    };
    const render = (width) => {
      if (cachedLines) return cachedLines;
      const lines = [];
      const add = (s) => lines.push(truncateToWidth(s, width));
      add(theme.fg("accent", "\u2500".repeat(width)));
      add(theme.fg("accent", theme.bold(` ${label}`)));
      add(theme.fg("muted", `  ${hint}`));
      lines.push("");
      add(theme.fg("muted", " Enter value:"));
      for (const line of editor.render(width - 2)) add(theme.fg("text", line));
      lines.push("");
      add(theme.fg("dim", " enter to confirm  |  esc to cancel"));
      add(theme.fg("accent", "\u2500".repeat(width)));
      cachedLines = lines;
      return lines;
    };
    return { render, handleInput, invalidate: () => {
      cachedLines = void 0;
    } };
  });
}
export {
  handleRemote,
  saveRemoteQuestionsConfig
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3JlbW90ZS1xdWVzdGlvbnMvcmVtb3RlLWNvbW1hbmQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUmVtb3RlIFF1ZXN0aW9ucyBcdTIwMTQgL2dzZCByZW1vdGUgY29tbWFuZFxuICovXG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJLCBFeHRlbnNpb25Db21tYW5kQ29udGV4dCB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgQXV0aFN0b3JhZ2UgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IEVkaXRvciwgdHlwZSBFZGl0b3JUaGVtZSwgS2V5LCBtYXRjaGVzS2V5LCB0cnVuY2F0ZVRvV2lkdGggfSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYywgd3JpdGVGaWxlU3luYywgbWtkaXJTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBnZXRHbG9iYWxHU0RQcmVmZXJlbmNlc1BhdGgsIGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyB9IGZyb20gXCIuLi9nc2QvcHJlZmVyZW5jZXMuanNcIjtcbmltcG9ydCB7IGdldFJlbW90ZUNvbmZpZ1N0YXR1cywgaXNWYWxpZENoYW5uZWxJZCwgcmVzb2x2ZVJlbW90ZUNvbmZpZyB9IGZyb20gXCIuL2NvbmZpZy5qc1wiO1xuaW1wb3J0IHsgbWFza0VkaXRvckxpbmUsIHNhbml0aXplRXJyb3IgfSBmcm9tIFwiLi4vc2hhcmVkL21vZC5qc1wiO1xuaW1wb3J0IHsgZ2V0TGF0ZXN0UHJvbXB0U3VtbWFyeSB9IGZyb20gXCIuL3N0YXR1cy5qc1wiO1xuaW1wb3J0IHsgZ3NkSG9tZSB9IGZyb20gXCIuLi9nc2QvZ3NkLWhvbWUuanNcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZVJlbW90ZShcbiAgc3ViY29tbWFuZDogc3RyaW5nLFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBfcGk6IEV4dGVuc2lvbkFQSSxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0cmltbWVkID0gc3ViY29tbWFuZC50cmltKCk7XG5cbiAgaWYgKHRyaW1tZWQgPT09IFwic2xhY2tcIikgcmV0dXJuIGhhbmRsZVNldHVwU2xhY2soY3R4KTtcbiAgaWYgKHRyaW1tZWQgPT09IFwiZGlzY29yZFwiKSByZXR1cm4gaGFuZGxlU2V0dXBEaXNjb3JkKGN0eCk7XG4gIGlmICh0cmltbWVkID09PSBcInRlbGVncmFtXCIpIHJldHVybiBoYW5kbGVTZXR1cFRlbGVncmFtKGN0eCk7XG4gIGlmICh0cmltbWVkID09PSBcInN0YXR1c1wiKSByZXR1cm4gaGFuZGxlUmVtb3RlU3RhdHVzKGN0eCk7XG4gIGlmICh0cmltbWVkID09PSBcImRpc2Nvbm5lY3RcIikgcmV0dXJuIGhhbmRsZURpc2Nvbm5lY3QoY3R4KTtcblxuICByZXR1cm4gaGFuZGxlUmVtb3RlTWVudShjdHgpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVTZXR1cFNsYWNrKGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdG9rZW4gPSBhd2FpdCBwcm9tcHRNYXNrZWRJbnB1dChjdHgsIFwiU2xhY2sgQm90IFRva2VuXCIsIFwiUGFzdGUgeW91ciB4b3hiLS4uLiB0b2tlblwiKTtcbiAgaWYgKCF0b2tlbikgcmV0dXJuIHZvaWQgY3R4LnVpLm5vdGlmeShcIlNsYWNrIHNldHVwIGNhbmNlbGxlZC5cIiwgXCJpbmZvXCIpO1xuICBpZiAoIXRva2VuLnN0YXJ0c1dpdGgoXCJ4b3hiLVwiKSkgcmV0dXJuIHZvaWQgY3R4LnVpLm5vdGlmeShcIkludmFsaWQgdG9rZW4gZm9ybWF0IFx1MjAxNCBTbGFjayBib3QgdG9rZW5zIHN0YXJ0IHdpdGggeG94Yi0uXCIsIFwid2FybmluZ1wiKTtcblxuICBjdHgudWkubm90aWZ5KFwiVmFsaWRhdGluZyB0b2tlbi4uLlwiLCBcImluZm9cIik7XG4gIGNvbnN0IGF1dGggPSBhd2FpdCBmZXRjaEpzb24oXCJodHRwczovL3NsYWNrLmNvbS9hcGkvYXV0aC50ZXN0XCIsIHsgaGVhZGVyczogeyBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7dG9rZW59YCB9IH0pO1xuICBpZiAoIWF1dGg/Lm9rKSByZXR1cm4gdm9pZCBjdHgudWkubm90aWZ5KFwiVG9rZW4gdmFsaWRhdGlvbiBmYWlsZWQgXHUyMDE0IGNoZWNrIHRoZSB0b2tlbiBhbmQgYXBwIGluc3RhbGwuXCIsIFwiZXJyb3JcIik7XG5cbiAgY29uc3QgY2hhbm5lbHMgPSBhd2FpdCBsaXN0U2xhY2tDaGFubmVscyh0b2tlbik7XG4gIGNvbnN0IE1BTlVBTF9PUFRJT04gPSBcIkVudGVyIGNoYW5uZWwgSUQgbWFudWFsbHlcIjtcbiAgbGV0IGNoYW5uZWxJZDogc3RyaW5nO1xuXG4gIGlmICghY2hhbm5lbHMgfHwgY2hhbm5lbHMubGVuZ3RoID09PSAwKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIkNvdWxkIG5vdCBsaXN0IFNsYWNrIGNoYW5uZWxzIFx1MjAxNCBmYWxsaW5nIGJhY2sgdG8gbWFudWFsIGVudHJ5LlwiLCBcIndhcm5pbmdcIik7XG4gICAgY2hhbm5lbElkID0gYXdhaXQgcHJvbXB0U2xhY2tDaGFubmVsSWQoY3R4KSA/PyBcIlwiO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IGNoYW5uZWxPcHRpb25zID0gWy4uLmNoYW5uZWxzLm1hcCgoY2hhbm5lbCkgPT4gY2hhbm5lbC5sYWJlbCksIE1BTlVBTF9PUFRJT05dO1xuICAgIGNvbnN0IHNlbGVjdGVkQ2hhbm5lbCA9IGF3YWl0IGN0eC51aS5zZWxlY3QoXCJTZWxlY3QgYSBTbGFjayBjaGFubmVsXCIsIGNoYW5uZWxPcHRpb25zKTtcbiAgICBpZiAoIXNlbGVjdGVkQ2hhbm5lbCkgcmV0dXJuIHZvaWQgY3R4LnVpLm5vdGlmeShcIlNsYWNrIHNldHVwIGNhbmNlbGxlZC5cIiwgXCJpbmZvXCIpO1xuXG4gICAgaWYgKHNlbGVjdGVkQ2hhbm5lbCA9PT0gTUFOVUFMX09QVElPTikge1xuICAgICAgY2hhbm5lbElkID0gYXdhaXQgcHJvbXB0U2xhY2tDaGFubmVsSWQoY3R4KSA/PyBcIlwiO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBjaG9zZW4gPSBjaGFubmVscy5maW5kKChjaGFubmVsKSA9PiBjaGFubmVsLmxhYmVsID09PSBzZWxlY3RlZENoYW5uZWwpO1xuICAgICAgaWYgKCFjaG9zZW4pIHJldHVybiB2b2lkIGN0eC51aS5ub3RpZnkoXCJTbGFjayBzZXR1cCBjYW5jZWxsZWQuXCIsIFwiaW5mb1wiKTtcbiAgICAgIGNoYW5uZWxJZCA9IGNob3Nlbi5pZDtcbiAgICB9XG4gIH1cblxuICBpZiAoIWNoYW5uZWxJZCkgcmV0dXJuIHZvaWQgY3R4LnVpLm5vdGlmeShcIlNsYWNrIHNldHVwIGNhbmNlbGxlZC5cIiwgXCJpbmZvXCIpO1xuXG4gIGNvbnN0IHNlbmQgPSBhd2FpdCBmZXRjaEpzb24oXCJodHRwczovL3NsYWNrLmNvbS9hcGkvY2hhdC5wb3N0TWVzc2FnZVwiLCB7XG4gICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICBoZWFkZXJzOiB7IEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHt0b2tlbn1gLCBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLThcIiB9LFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgY2hhbm5lbDogY2hhbm5lbElkLCB0ZXh0OiBcIkdTRCByZW1vdGUgcXVlc3Rpb25zIGNvbm5lY3RlZC5cIiB9KSxcbiAgfSk7XG4gIGlmICghc2VuZD8ub2spIHJldHVybiB2b2lkIGN0eC51aS5ub3RpZnkoYENvdWxkIG5vdCBzZW5kIHRvIGNoYW5uZWw6ICR7c2VuZD8uZXJyb3IgPz8gXCJ1bmtub3duIGVycm9yXCJ9YCwgXCJlcnJvclwiKTtcblxuICBzYXZlUHJvdmlkZXJUb2tlbihcInNsYWNrX2JvdFwiLCB0b2tlbik7XG4gIHByb2Nlc3MuZW52LlNMQUNLX0JPVF9UT0tFTiA9IHRva2VuO1xuICBzYXZlUmVtb3RlUXVlc3Rpb25zQ29uZmlnKFwic2xhY2tcIiwgY2hhbm5lbElkKTtcbiAgY3R4LnVpLm5vdGlmeShgU2xhY2sgY29ubmVjdGVkIFx1MjAxNCByZW1vdGUgcXVlc3Rpb25zIGVuYWJsZWQgZm9yIGNoYW5uZWwgJHtjaGFubmVsSWR9LmAsIFwiaW5mb1wiKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlU2V0dXBEaXNjb3JkKGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdG9rZW4gPSBhd2FpdCBwcm9tcHRNYXNrZWRJbnB1dChjdHgsIFwiRGlzY29yZCBCb3QgVG9rZW5cIiwgXCJQYXN0ZSB5b3VyIGJvdCB0b2tlblwiKTtcbiAgaWYgKCF0b2tlbikgcmV0dXJuIHZvaWQgY3R4LnVpLm5vdGlmeShcIkRpc2NvcmQgc2V0dXAgY2FuY2VsbGVkLlwiLCBcImluZm9cIik7XG5cbiAgY3R4LnVpLm5vdGlmeShcIlZhbGlkYXRpbmcgdG9rZW4uLi5cIiwgXCJpbmZvXCIpO1xuICBjb25zdCBoZWFkZXJzID0geyBBdXRob3JpemF0aW9uOiBgQm90ICR7dG9rZW59YCB9O1xuICBjb25zdCBhdXRoID0gYXdhaXQgZmV0Y2hKc29uKFwiaHR0cHM6Ly9kaXNjb3JkLmNvbS9hcGkvdjEwL3VzZXJzL0BtZVwiLCB7IGhlYWRlcnMgfSk7XG4gIGlmICghYXV0aD8uaWQpIHJldHVybiB2b2lkIGN0eC51aS5ub3RpZnkoXCJUb2tlbiB2YWxpZGF0aW9uIGZhaWxlZCBcdTIwMTQgY2hlY2sgdGhlIGJvdCB0b2tlbi5cIiwgXCJlcnJvclwiKTtcblxuICAvLyBGZXRjaCBndWlsZHMgdGhlIGJvdCBpcyBhIG1lbWJlciBvZlxuICBjb25zdCBndWlsZHM6IEFycmF5PHsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nIH0+IHwgbnVsbCA9IGF3YWl0IGZldGNoSnNvbihcImh0dHBzOi8vZGlzY29yZC5jb20vYXBpL3YxMC91c2Vycy9AbWUvZ3VpbGRzXCIsIHsgaGVhZGVycyB9KTtcbiAgaWYgKCFBcnJheS5pc0FycmF5KGd1aWxkcykgfHwgZ3VpbGRzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB2b2lkIGN0eC51aS5ub3RpZnkoXCJCb3QgaXMgbm90IGluIGFueSBEaXNjb3JkIHNlcnZlcnMuXCIsIFwiZXJyb3JcIik7XG4gIH1cblxuICBsZXQgZ3VpbGRJZDogc3RyaW5nO1xuICBsZXQgZ3VpbGROYW1lOiBzdHJpbmc7XG4gIGlmIChndWlsZHMubGVuZ3RoID09PSAxKSB7XG4gICAgZ3VpbGRJZCA9IGd1aWxkc1swXS5pZDtcbiAgICBndWlsZE5hbWUgPSBndWlsZHNbMF0ubmFtZTtcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBndWlsZE9wdGlvbnMgPSBndWlsZHMubWFwKChnKSA9PiBnLm5hbWUpO1xuICAgIGNvbnN0IHNlbGVjdGVkR3VpbGQgPSBhd2FpdCBjdHgudWkuc2VsZWN0KFwiU2VsZWN0IGEgRGlzY29yZCBzZXJ2ZXJcIiwgZ3VpbGRPcHRpb25zKTtcbiAgICBpZiAoIXNlbGVjdGVkR3VpbGQpIHJldHVybiB2b2lkIGN0eC51aS5ub3RpZnkoXCJEaXNjb3JkIHNldHVwIGNhbmNlbGxlZC5cIiwgXCJpbmZvXCIpO1xuICAgIGNvbnN0IGNob3NlbiA9IGd1aWxkcy5maW5kKChnKSA9PiBnLm5hbWUgPT09IHNlbGVjdGVkR3VpbGQpO1xuICAgIGlmICghY2hvc2VuKSByZXR1cm4gdm9pZCBjdHgudWkubm90aWZ5KFwiRGlzY29yZCBzZXR1cCBjYW5jZWxsZWQuXCIsIFwiaW5mb1wiKTtcbiAgICBndWlsZElkID0gY2hvc2VuLmlkO1xuICAgIGd1aWxkTmFtZSA9IGNob3Nlbi5uYW1lO1xuICB9XG5cbiAgLy8gRmV0Y2ggdGV4dCBhbmQgYW5ub3VuY2VtZW50IGNoYW5uZWxzIGluIHRoZSBzZWxlY3RlZCBndWlsZFxuICBjdHgudWkubm90aWZ5KGBGZXRjaGluZyBjaGFubmVscyBmb3IgJHtndWlsZE5hbWV9Li4uYCwgXCJpbmZvXCIpO1xuICBjb25zdCBhbGxDaGFubmVsczogQXJyYXk8eyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHR5cGU6IG51bWJlciB9PiB8IG51bGwgPSBhd2FpdCBmZXRjaEpzb24oXG4gICAgYGh0dHBzOi8vZGlzY29yZC5jb20vYXBpL3YxMC9ndWlsZHMvJHtndWlsZElkfS9jaGFubmVsc2AsXG4gICAgeyBoZWFkZXJzIH0sXG4gICk7XG4gIGNvbnN0IHRleHRDaGFubmVscyA9IEFycmF5LmlzQXJyYXkoYWxsQ2hhbm5lbHMpXG4gICAgPyBhbGxDaGFubmVscy5maWx0ZXIoKGNoKSA9PiBjaC50eXBlID09PSAwIHx8IGNoLnR5cGUgPT09IDUpXG4gICAgOiBbXTtcblxuICBjb25zdCBNQU5VQUxfT1BUSU9OID0gXCJFbnRlciBjaGFubmVsIElEIG1hbnVhbGx5XCI7XG4gIGxldCBjaGFubmVsSWQ6IHN0cmluZztcblxuICBpZiAodGV4dENoYW5uZWxzLmxlbmd0aCA9PT0gMCkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJObyB0ZXh0IGNoYW5uZWxzIGZvdW5kIFx1MjAxNCBmYWxsaW5nIGJhY2sgdG8gbWFudWFsIGVudHJ5LlwiLCBcIndhcm5pbmdcIik7XG4gICAgY29uc3QgbWFudWFsSWQgPSBhd2FpdCBwcm9tcHRJbnB1dChjdHgsIFwiQ2hhbm5lbCBJRFwiLCBcIlBhc3RlIHRoZSBEaXNjb3JkIGNoYW5uZWwgSUQgKGUuZy4gMTIzNDU2Nzg5MDEyMzQ1Njc4OSlcIik7XG4gICAgaWYgKCFtYW51YWxJZCkgcmV0dXJuIHZvaWQgY3R4LnVpLm5vdGlmeShcIkRpc2NvcmQgc2V0dXAgY2FuY2VsbGVkLlwiLCBcImluZm9cIik7XG4gICAgaWYgKCFpc1ZhbGlkQ2hhbm5lbElkKFwiZGlzY29yZFwiLCBtYW51YWxJZCkpIHJldHVybiB2b2lkIGN0eC51aS5ub3RpZnkoXCJJbnZhbGlkIERpc2NvcmQgY2hhbm5lbCBJRCBmb3JtYXQgXHUyMDE0IGV4cGVjdGVkIDE3LTIwIGRpZ2l0IG51bWVyaWMgSUQuXCIsIFwiZXJyb3JcIik7XG4gICAgY2hhbm5lbElkID0gbWFudWFsSWQ7XG4gIH0gZWxzZSB7XG4gICAgY29uc3QgY2hhbm5lbE9wdGlvbnMgPSBbLi4udGV4dENoYW5uZWxzLm1hcCgoY2gpID0+IGAjJHtjaC5uYW1lfWApLCBNQU5VQUxfT1BUSU9OXTtcbiAgICBjb25zdCBzZWxlY3RlZENoYW5uZWwgPSBhd2FpdCBjdHgudWkuc2VsZWN0KFwiU2VsZWN0IGEgY2hhbm5lbFwiLCBjaGFubmVsT3B0aW9ucyk7XG4gICAgaWYgKCFzZWxlY3RlZENoYW5uZWwpIHJldHVybiB2b2lkIGN0eC51aS5ub3RpZnkoXCJEaXNjb3JkIHNldHVwIGNhbmNlbGxlZC5cIiwgXCJpbmZvXCIpO1xuXG4gICAgaWYgKHNlbGVjdGVkQ2hhbm5lbCA9PT0gTUFOVUFMX09QVElPTikge1xuICAgICAgY29uc3QgbWFudWFsSWQgPSBhd2FpdCBwcm9tcHRJbnB1dChjdHgsIFwiQ2hhbm5lbCBJRFwiLCBcIlBhc3RlIHRoZSBEaXNjb3JkIGNoYW5uZWwgSUQgKGUuZy4gMTIzNDU2Nzg5MDEyMzQ1Njc4OSlcIik7XG4gICAgICBpZiAoIW1hbnVhbElkKSByZXR1cm4gdm9pZCBjdHgudWkubm90aWZ5KFwiRGlzY29yZCBzZXR1cCBjYW5jZWxsZWQuXCIsIFwiaW5mb1wiKTtcbiAgICAgIGlmICghaXNWYWxpZENoYW5uZWxJZChcImRpc2NvcmRcIiwgbWFudWFsSWQpKSByZXR1cm4gdm9pZCBjdHgudWkubm90aWZ5KFwiSW52YWxpZCBEaXNjb3JkIGNoYW5uZWwgSUQgZm9ybWF0IFx1MjAxNCBleHBlY3RlZCAxNy0yMCBkaWdpdCBudW1lcmljIElELlwiLCBcImVycm9yXCIpO1xuICAgICAgY2hhbm5lbElkID0gbWFudWFsSWQ7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGNob3NlbkNoYW5uZWwgPSB0ZXh0Q2hhbm5lbHMuZmluZCgoY2gpID0+IGAjJHtjaC5uYW1lfWAgPT09IHNlbGVjdGVkQ2hhbm5lbCk7XG4gICAgICBpZiAoIWNob3NlbkNoYW5uZWwpIHJldHVybiB2b2lkIGN0eC51aS5ub3RpZnkoXCJEaXNjb3JkIHNldHVwIGNhbmNlbGxlZC5cIiwgXCJpbmZvXCIpO1xuICAgICAgY2hhbm5lbElkID0gY2hvc2VuQ2hhbm5lbC5pZDtcbiAgICB9XG4gIH1cblxuICBjb25zdCBzZW5kUmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgaHR0cHM6Ly9kaXNjb3JkLmNvbS9hcGkvdjEwL2NoYW5uZWxzLyR7Y2hhbm5lbElkfS9tZXNzYWdlc2AsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6IHsgLi4uaGVhZGVycywgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNvbnRlbnQ6IFwiR1NEIHJlbW90ZSBxdWVzdGlvbnMgY29ubmVjdGVkLlwiIH0pLFxuICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxNV8wMDApLFxuICB9KTtcbiAgaWYgKCFzZW5kUmVzcG9uc2Uub2spIHtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgc2VuZFJlc3BvbnNlLnRleHQoKS5jYXRjaCgoKSA9PiBcIlwiKTtcbiAgICByZXR1cm4gdm9pZCBjdHgudWkubm90aWZ5KGBDb3VsZCBub3Qgc2VuZCB0byBjaGFubmVsIChIVFRQICR7c2VuZFJlc3BvbnNlLnN0YXR1c30pOiAke3Nhbml0aXplRXJyb3IoYm9keSkuc2xpY2UoMCwgMjAwKX1gLCBcImVycm9yXCIpO1xuICB9XG5cbiAgc2F2ZVByb3ZpZGVyVG9rZW4oXCJkaXNjb3JkX2JvdFwiLCB0b2tlbik7XG4gIHByb2Nlc3MuZW52LkRJU0NPUkRfQk9UX1RPS0VOID0gdG9rZW47XG4gIHNhdmVSZW1vdGVRdWVzdGlvbnNDb25maWcoXCJkaXNjb3JkXCIsIGNoYW5uZWxJZCk7XG4gIGN0eC51aS5ub3RpZnkoYERpc2NvcmQgY29ubmVjdGVkIFx1MjAxNCByZW1vdGUgcXVlc3Rpb25zIGVuYWJsZWQgZm9yIGNoYW5uZWwgJHtjaGFubmVsSWR9LmAsIFwiaW5mb1wiKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlU2V0dXBUZWxlZ3JhbShjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRva2VuID0gYXdhaXQgcHJvbXB0TWFza2VkSW5wdXQoY3R4LCBcIlRlbGVncmFtIEJvdCBUb2tlblwiLCBcIlBhc3RlIHlvdXIgYm90IHRva2VuIGZyb20gQEJvdEZhdGhlclwiKTtcbiAgaWYgKCF0b2tlbikgcmV0dXJuIHZvaWQgY3R4LnVpLm5vdGlmeShcIlRlbGVncmFtIHNldHVwIGNhbmNlbGxlZC5cIiwgXCJpbmZvXCIpO1xuICBpZiAoIS9eXFxkKzpbQS1aYS16MC05Xy1dKyQvLnRlc3QodG9rZW4pKSByZXR1cm4gdm9pZCBjdHgudWkubm90aWZ5KFwiSW52YWxpZCB0b2tlbiBmb3JtYXQgXHUyMDE0IFRlbGVncmFtIGJvdCB0b2tlbnMgbG9vayBsaWtlIDEyMzQ1Njc4OTpBQkNkZWZHSEkuLi5cIiwgXCJ3YXJuaW5nXCIpO1xuXG4gIGN0eC51aS5ub3RpZnkoXCJWYWxpZGF0aW5nIHRva2VuLi4uXCIsIFwiaW5mb1wiKTtcbiAgY29uc3QgYXV0aCA9IGF3YWl0IGZldGNoSnNvbihgaHR0cHM6Ly9hcGkudGVsZWdyYW0ub3JnL2JvdCR7dG9rZW59L2dldE1lYCk7XG4gIGlmICghYXV0aD8ub2sgfHwgIWF1dGg/LnJlc3VsdD8uaWQpIHJldHVybiB2b2lkIGN0eC51aS5ub3RpZnkoXCJUb2tlbiB2YWxpZGF0aW9uIGZhaWxlZCBcdTIwMTQgY2hlY2sgdGhlIGJvdCB0b2tlbi5cIiwgXCJlcnJvclwiKTtcblxuICBjb25zdCBjaGF0SWQgPSBhd2FpdCBwcm9tcHRJbnB1dChjdHgsIFwiQ2hhdCBJRFwiLCBcIlBhc3RlIHRoZSBUZWxlZ3JhbSBjaGF0IElEIChlLmcuIC0xMDAxMjM0NTY3ODkwKVwiKTtcbiAgaWYgKCFjaGF0SWQpIHJldHVybiB2b2lkIGN0eC51aS5ub3RpZnkoXCJUZWxlZ3JhbSBzZXR1cCBjYW5jZWxsZWQuXCIsIFwiaW5mb1wiKTtcbiAgaWYgKCFpc1ZhbGlkQ2hhbm5lbElkKFwidGVsZWdyYW1cIiwgY2hhdElkKSkgcmV0dXJuIHZvaWQgY3R4LnVpLm5vdGlmeShcIkludmFsaWQgVGVsZWdyYW0gY2hhdCBJRCBmb3JtYXQgXHUyMDE0IGV4cGVjdGVkIGEgbnVtZXJpYyBJRCAoY2FuIGJlIG5lZ2F0aXZlIGZvciBncm91cHMpLlwiLCBcImVycm9yXCIpO1xuXG4gIGNvbnN0IHNlbmQgPSBhd2FpdCBmZXRjaEpzb24oYGh0dHBzOi8vYXBpLnRlbGVncmFtLm9yZy9ib3Qke3Rva2VufS9zZW5kTWVzc2FnZWAsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGNoYXRfaWQ6IGNoYXRJZCwgdGV4dDogXCJHU0QgcmVtb3RlIHF1ZXN0aW9ucyBjb25uZWN0ZWQuXCIgfSksXG4gIH0pO1xuICBpZiAoIXNlbmQ/Lm9rKSByZXR1cm4gdm9pZCBjdHgudWkubm90aWZ5KGBDb3VsZCBub3Qgc2VuZCB0byBjaGF0OiAke3NlbmQ/LmRlc2NyaXB0aW9uID8/IFwidW5rbm93biBlcnJvclwifWAsIFwiZXJyb3JcIik7XG5cbiAgc2F2ZVByb3ZpZGVyVG9rZW4oXCJ0ZWxlZ3JhbV9ib3RcIiwgdG9rZW4pO1xuICBwcm9jZXNzLmVudi5URUxFR1JBTV9CT1RfVE9LRU4gPSB0b2tlbjtcbiAgc2F2ZVJlbW90ZVF1ZXN0aW9uc0NvbmZpZyhcInRlbGVncmFtXCIsIGNoYXRJZCk7XG4gIGN0eC51aS5ub3RpZnkoYFRlbGVncmFtIGNvbm5lY3RlZCBcdTIwMTQgcmVtb3RlIHF1ZXN0aW9ucyBlbmFibGVkIGZvciBjaGF0ICR7Y2hhdElkfS5gLCBcImluZm9cIik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVJlbW90ZVN0YXR1cyhjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHN0YXR1cyA9IGdldFJlbW90ZUNvbmZpZ1N0YXR1cygpO1xuICBjb25zdCBjb25maWcgPSByZXNvbHZlUmVtb3RlQ29uZmlnKCk7XG4gIGlmICghY29uZmlnKSB7XG4gICAgY3R4LnVpLm5vdGlmeShzdGF0dXMsIHN0YXR1cy5pbmNsdWRlcyhcImRpc2FibGVkXCIpID8gXCJ3YXJuaW5nXCIgOiBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgbGF0ZXN0UHJvbXB0ID0gZ2V0TGF0ZXN0UHJvbXB0U3VtbWFyeSgpO1xuICBjb25zdCBsaW5lcyA9IFtzdGF0dXNdO1xuICBpZiAobGF0ZXN0UHJvbXB0KSB7XG4gICAgbGluZXMucHVzaChgTGFzdCBwcm9tcHQ6ICR7bGF0ZXN0UHJvbXB0LmlkfWApO1xuICAgIGxpbmVzLnB1c2goYCAgc3RhdHVzOiAke2xhdGVzdFByb21wdC5zdGF0dXN9YCk7XG4gICAgaWYgKGxhdGVzdFByb21wdC51cGRhdGVkQXQpIGxpbmVzLnB1c2goYCAgdXBkYXRlZDogJHtuZXcgRGF0ZShsYXRlc3RQcm9tcHQudXBkYXRlZEF0KS50b0xvY2FsZVN0cmluZygpfWApO1xuICB9XG5cbiAgY3R4LnVpLm5vdGlmeShsaW5lcy5qb2luKFwiXFxuXCIpLCBcImluZm9cIik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZURpc2Nvbm5lY3QoY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBwcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcygpO1xuICBjb25zdCBjaGFubmVsID0gcHJlZnM/LnByZWZlcmVuY2VzLnJlbW90ZV9xdWVzdGlvbnM/LmNoYW5uZWw7XG4gIGlmICghY2hhbm5lbCkgcmV0dXJuIHZvaWQgY3R4LnVpLm5vdGlmeShcIk5vIHJlbW90ZSBjaGFubmVsIGNvbmZpZ3VyZWQgXHUyMDE0IG5vdGhpbmcgdG8gZGlzY29ubmVjdC5cIiwgXCJpbmZvXCIpO1xuXG4gIHJlbW92ZVJlbW90ZVF1ZXN0aW9uc0NvbmZpZygpO1xuICBjb25zdCBwcm92aWRlck1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHsgc2xhY2s6IFwic2xhY2tfYm90XCIsIGRpc2NvcmQ6IFwiZGlzY29yZF9ib3RcIiwgdGVsZWdyYW06IFwidGVsZWdyYW1fYm90XCIgfTtcbiAgcmVtb3ZlUHJvdmlkZXJUb2tlbihwcm92aWRlck1hcFtjaGFubmVsXSA/PyBjaGFubmVsKTtcbiAgaWYgKGNoYW5uZWwgPT09IFwic2xhY2tcIikgZGVsZXRlIHByb2Nlc3MuZW52LlNMQUNLX0JPVF9UT0tFTjtcbiAgaWYgKGNoYW5uZWwgPT09IFwiZGlzY29yZFwiKSBkZWxldGUgcHJvY2Vzcy5lbnYuRElTQ09SRF9CT1RfVE9LRU47XG4gIGlmIChjaGFubmVsID09PSBcInRlbGVncmFtXCIpIGRlbGV0ZSBwcm9jZXNzLmVudi5URUxFR1JBTV9CT1RfVE9LRU47XG4gIGN0eC51aS5ub3RpZnkoYFJlbW90ZSBxdWVzdGlvbnMgZGlzY29ubmVjdGVkICgke2NoYW5uZWx9KS5gLCBcImluZm9cIik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVJlbW90ZU1lbnUoY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjb25maWcgPSByZXNvbHZlUmVtb3RlQ29uZmlnKCk7XG4gIGNvbnN0IGxhdGVzdFByb21wdCA9IGdldExhdGVzdFByb21wdFN1bW1hcnkoKTtcbiAgY29uc3QgbGluZXMgPSBjb25maWdcbiAgICA/IFtcbiAgICAgICAgYFJlbW90ZSBxdWVzdGlvbnM6ICR7Y29uZmlnLmNoYW5uZWx9IGNvbmZpZ3VyZWRgLFxuICAgICAgICBgICBUaW1lb3V0OiAke2NvbmZpZy50aW1lb3V0TXMgLyA2MDAwMH1tLCBwb2xsOiAke2NvbmZpZy5wb2xsSW50ZXJ2YWxNcyAvIDEwMDB9c2AsXG4gICAgICAgIGxhdGVzdFByb21wdCA/IGAgIExhc3QgcHJvbXB0OiAke2xhdGVzdFByb21wdC5pZH0gKCR7bGF0ZXN0UHJvbXB0LnN0YXR1c30pYCA6IFwiICBObyByZW1vdGUgcHJvbXB0cyByZWNvcmRlZCB5ZXRcIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCJDb21tYW5kczpcIixcbiAgICAgICAgXCIgIC9nc2QgcmVtb3RlIHN0YXR1c1wiLFxuICAgICAgICBcIiAgL2dzZCByZW1vdGUgZGlzY29ubmVjdFwiLFxuICAgICAgICBcIiAgL2dzZCByZW1vdGUgc2xhY2tcIixcbiAgICAgICAgXCIgIC9nc2QgcmVtb3RlIGRpc2NvcmRcIixcbiAgICAgICAgXCIgIC9nc2QgcmVtb3RlIHRlbGVncmFtXCIsXG4gICAgICBdXG4gICAgOiBbXG4gICAgICAgIFwiTm8gcmVtb3RlIHF1ZXN0aW9uIGNoYW5uZWwgY29uZmlndXJlZC5cIixcbiAgICAgICAgXCJcIixcbiAgICAgICAgXCJDb21tYW5kczpcIixcbiAgICAgICAgXCIgIC9nc2QgcmVtb3RlIHNsYWNrXCIsXG4gICAgICAgIFwiICAvZ3NkIHJlbW90ZSBkaXNjb3JkXCIsXG4gICAgICAgIFwiICAvZ3NkIHJlbW90ZSB0ZWxlZ3JhbVwiLFxuICAgICAgICBcIiAgL2dzZCByZW1vdGUgc3RhdHVzXCIsXG4gICAgICBdO1xuXG4gIGN0eC51aS5ub3RpZnkobGluZXMuam9pbihcIlxcblwiKSwgXCJpbmZvXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBmZXRjaEpzb24odXJsOiBzdHJpbmcsIGluaXQ/OiBSZXF1ZXN0SW5pdCk6IFByb21pc2U8YW55PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaCh1cmwsIHsgLi4uaW5pdCwgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDE1XzAwMCkgfSk7XG4gICAgcmV0dXJuIGF3YWl0IHJlc3BvbnNlLmpzb24oKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gbGlzdFNsYWNrQ2hhbm5lbHModG9rZW46IHN0cmluZyk6IFByb21pc2U8QXJyYXk8eyBpZDogc3RyaW5nOyBsYWJlbDogc3RyaW5nIH0+IHwgbnVsbD4ge1xuICBjb25zdCBoZWFkZXJzID0geyBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7dG9rZW59YCB9O1xuICBjb25zdCBjaGFubmVsczogQXJyYXk8eyBpZDogc3RyaW5nOyBsYWJlbDogc3RyaW5nOyBuYW1lOiBzdHJpbmcgfT4gPSBbXTtcbiAgbGV0IGN1cnNvciA9IFwiXCI7XG5cbiAgZG8ge1xuICAgIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoe1xuICAgICAgZXhjbHVkZV9hcmNoaXZlZDogXCJ0cnVlXCIsXG4gICAgICBsaW1pdDogXCIyMDBcIixcbiAgICAgIHR5cGVzOiBcInB1YmxpY19jaGFubmVsLHByaXZhdGVfY2hhbm5lbFwiLFxuICAgIH0pO1xuICAgIGlmIChjdXJzb3IpIHBhcmFtcy5zZXQoXCJjdXJzb3JcIiwgY3Vyc29yKTtcblxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2hKc29uKGBodHRwczovL3NsYWNrLmNvbS9hcGkvdXNlcnMuY29udmVyc2F0aW9ucz8ke3BhcmFtcy50b1N0cmluZygpfWAsIHsgaGVhZGVycyB9KTtcbiAgICBpZiAoIXJlc3BvbnNlPy5vayB8fCAhQXJyYXkuaXNBcnJheShyZXNwb25zZS5jaGFubmVscykpIHtcbiAgICAgIHJldHVybiBjaGFubmVscy5sZW5ndGggPiAwID8gY2hhbm5lbHMubWFwKCh7IGlkLCBsYWJlbCB9KSA9PiAoeyBpZCwgbGFiZWwgfSkpIDogbnVsbDtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IGNoYW5uZWwgb2YgcmVzcG9uc2UuY2hhbm5lbHMgYXMgQXJyYXk8eyBpZD86IHN0cmluZzsgbmFtZT86IHN0cmluZzsgaXNfcHJpdmF0ZT86IGJvb2xlYW4gfT4pIHtcbiAgICAgIGlmICghY2hhbm5lbC5pZCB8fCAhY2hhbm5lbC5uYW1lKSBjb250aW51ZTtcbiAgICAgIGNoYW5uZWxzLnB1c2goe1xuICAgICAgICBpZDogY2hhbm5lbC5pZCxcbiAgICAgICAgbmFtZTogY2hhbm5lbC5uYW1lLFxuICAgICAgICBsYWJlbDogY2hhbm5lbC5pc19wcml2YXRlID8gYFtwcml2YXRlXSAke2NoYW5uZWwubmFtZX1gIDogYCMke2NoYW5uZWwubmFtZX1gLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgY3Vyc29yID0gdHlwZW9mIHJlc3BvbnNlLnJlc3BvbnNlX21ldGFkYXRhPy5uZXh0X2N1cnNvciA9PT0gXCJzdHJpbmdcIlxuICAgICAgPyByZXNwb25zZS5yZXNwb25zZV9tZXRhZGF0YS5uZXh0X2N1cnNvclxuICAgICAgOiBcIlwiO1xuICB9IHdoaWxlIChjdXJzb3IpO1xuXG4gIGNoYW5uZWxzLnNvcnQoKGEsIGIpID0+IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkpO1xuICByZXR1cm4gY2hhbm5lbHMubWFwKCh7IGlkLCBsYWJlbCB9KSA9PiAoeyBpZCwgbGFiZWwgfSkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwcm9tcHRTbGFja0NoYW5uZWxJZChjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0KTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IGNoYW5uZWxJZCA9IGF3YWl0IHByb21wdElucHV0KGN0eCwgXCJDaGFubmVsIElEXCIsIFwiUGFzdGUgdGhlIFNsYWNrIGNoYW5uZWwgSUQgKGUuZy4gQzAxMjM0NTY3ODkpXCIpO1xuICBpZiAoIWNoYW5uZWxJZCkgcmV0dXJuIG51bGw7XG4gIGlmICghaXNWYWxpZENoYW5uZWxJZChcInNsYWNrXCIsIGNoYW5uZWxJZCkpIHtcbiAgICBjdHgudWkubm90aWZ5KFwiSW52YWxpZCBTbGFjayBjaGFubmVsIElEIGZvcm1hdCBcdTIwMTQgZXhwZWN0ZWQgOS0xMiB1cHBlcmNhc2UgYWxwaGFudW1lcmljIGNoYXJhY3RlcnMuXCIsIFwiZXJyb3JcIik7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgcmV0dXJuIGNoYW5uZWxJZDtcbn1cblxuZnVuY3Rpb24gZ2V0QXV0aFN0b3JhZ2UoKTogQXV0aFN0b3JhZ2Uge1xuICBjb25zdCBhdXRoUGF0aCA9IGpvaW4oZ3NkSG9tZSgpLCBcImFnZW50XCIsIFwiYXV0aC5qc29uXCIpO1xuICBta2RpclN5bmMoZGlybmFtZShhdXRoUGF0aCksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gQXV0aFN0b3JhZ2UuY3JlYXRlKGF1dGhQYXRoKTtcbn1cblxuZnVuY3Rpb24gc2F2ZVByb3ZpZGVyVG9rZW4ocHJvdmlkZXI6IHN0cmluZywgdG9rZW46IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBhdXRoID0gZ2V0QXV0aFN0b3JhZ2UoKTtcbiAgYXV0aC5zZXQocHJvdmlkZXIsIHsgdHlwZTogXCJhcGlfa2V5XCIsIGtleTogdG9rZW4gfSk7XG59XG5cbmZ1bmN0aW9uIHJlbW92ZVByb3ZpZGVyVG9rZW4ocHJvdmlkZXI6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBhdXRoID0gZ2V0QXV0aFN0b3JhZ2UoKTtcbiAgYXV0aC5yZW1vdmUocHJvdmlkZXIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2F2ZVJlbW90ZVF1ZXN0aW9uc0NvbmZpZyhjaGFubmVsOiBcInNsYWNrXCIgfCBcImRpc2NvcmRcIiB8IFwidGVsZWdyYW1cIiwgY2hhbm5lbElkOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgcHJlZnNQYXRoID0gZ2V0R2xvYmFsR1NEUHJlZmVyZW5jZXNQYXRoKCk7XG4gIGNvbnN0IGJsb2NrID0gW1xuICAgIFwicmVtb3RlX3F1ZXN0aW9uczpcIixcbiAgICBgICBjaGFubmVsOiAke2NoYW5uZWx9YCxcbiAgICBgICBjaGFubmVsX2lkOiBcXFwiJHtjaGFubmVsSWR9XFxcImAsXG4gICAgXCIgIHRpbWVvdXRfbWludXRlczogNVwiLFxuICAgIFwiICBwb2xsX2ludGVydmFsX3NlY29uZHM6IDVcIixcbiAgXS5qb2luKFwiXFxuXCIpO1xuXG4gIGNvbnN0IGNvbnRlbnQgPSBleGlzdHNTeW5jKHByZWZzUGF0aCkgPyByZWFkRmlsZVN5bmMocHJlZnNQYXRoLCBcInV0Zi04XCIpIDogXCJcIjtcbiAgY29uc3QgZm1NYXRjaCA9IGNvbnRlbnQubWF0Y2goL14tLS1cXG4oW1xcc1xcU10qPylcXG4tLS0vKTtcbiAgbGV0IG5leHQgPSBjb250ZW50O1xuXG4gIGlmIChmbU1hdGNoKSB7XG4gICAgbGV0IGZyb250bWF0dGVyID0gZm1NYXRjaFsxXTtcbiAgICBjb25zdCByZWdleCA9IC9yZW1vdGVfcXVlc3Rpb25zOltcXHNcXFNdKj8oPz1cXG5bYS16QS1aX118XFxuLS0tfCQpLztcbiAgICBmcm9udG1hdHRlciA9IHJlZ2V4LnRlc3QoZnJvbnRtYXR0ZXIpID8gZnJvbnRtYXR0ZXIucmVwbGFjZShyZWdleCwgYmxvY2spIDogYCR7ZnJvbnRtYXR0ZXIudHJpbUVuZCgpfVxcbiR7YmxvY2t9YDtcbiAgICBuZXh0ID0gYC0tLVxcbiR7ZnJvbnRtYXR0ZXJ9XFxuLS0tJHtjb250ZW50LnNsaWNlKGZtTWF0Y2hbMF0ubGVuZ3RoKX1gO1xuICB9IGVsc2Uge1xuICAgIG5leHQgPSBgLS0tXFxuJHtibG9ja31cXG4tLS1cXG5cXG4ke2NvbnRlbnR9YDtcbiAgfVxuXG4gIG1rZGlyU3luYyhkaXJuYW1lKHByZWZzUGF0aCksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKHByZWZzUGF0aCwgbmV4dCwgXCJ1dGYtOFwiKTtcbn1cblxuZnVuY3Rpb24gcmVtb3ZlUmVtb3RlUXVlc3Rpb25zQ29uZmlnKCk6IHZvaWQge1xuICBjb25zdCBwcmVmc1BhdGggPSBnZXRHbG9iYWxHU0RQcmVmZXJlbmNlc1BhdGgoKTtcbiAgaWYgKCFleGlzdHNTeW5jKHByZWZzUGF0aCkpIHJldHVybjtcbiAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhwcmVmc1BhdGgsIFwidXRmLThcIik7XG4gIGNvbnN0IGZtTWF0Y2ggPSBjb250ZW50Lm1hdGNoKC9eLS0tXFxuKFtcXHNcXFNdKj8pXFxuLS0tLyk7XG4gIGlmICghZm1NYXRjaCkgcmV0dXJuO1xuICBjb25zdCBmcm9udG1hdHRlciA9IGZtTWF0Y2hbMV0ucmVwbGFjZSgvcmVtb3RlX3F1ZXN0aW9uczpbXFxzXFxTXSo/KD89XFxuW2EtekEtWl9dfFxcbi0tLXwkKS8sIFwiXCIpLnRyaW0oKTtcbiAgY29uc3QgbmV4dCA9IGZyb250bWF0dGVyID8gYC0tLVxcbiR7ZnJvbnRtYXR0ZXJ9XFxuLS0tJHtjb250ZW50LnNsaWNlKGZtTWF0Y2hbMF0ubGVuZ3RoKX1gIDogY29udGVudC5zbGljZShmbU1hdGNoWzBdLmxlbmd0aCkucmVwbGFjZSgvXlxcbisvLCBcIlwiKTtcbiAgd3JpdGVGaWxlU3luYyhwcmVmc1BhdGgsIG5leHQsIFwidXRmLThcIik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHByb21wdE1hc2tlZElucHV0KGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIGxhYmVsOiBzdHJpbmcsIGhpbnQ6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBpZiAoIWN0eC5oYXNVSSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBjdHgudWkuY3VzdG9tPHN0cmluZyB8IG51bGw+KCh0dWk6IGFueSwgdGhlbWU6IGFueSwgX2tiOiBhbnksIGRvbmU6IChyOiBzdHJpbmcgfCBudWxsKSA9PiB2b2lkKSA9PiB7XG4gICAgbGV0IGNhY2hlZExpbmVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcbiAgICBjb25zdCBlZGl0b3JUaGVtZTogRWRpdG9yVGhlbWUgPSB7XG4gICAgICBib3JkZXJDb2xvcjogKHM6IHN0cmluZykgPT4gdGhlbWUuZmcoXCJhY2NlbnRcIiwgcyksXG4gICAgICBzZWxlY3RMaXN0OiB7XG4gICAgICAgIHNlbGVjdGVkUHJlZml4OiAodDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcImFjY2VudFwiLCB0KSxcbiAgICAgICAgc2VsZWN0ZWRUZXh0OiAodDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcImFjY2VudFwiLCB0KSxcbiAgICAgICAgZGVzY3JpcHRpb246ICh0OiBzdHJpbmcpID0+IHRoZW1lLmZnKFwibXV0ZWRcIiwgdCksXG4gICAgICAgIHNjcm9sbEluZm86ICh0OiBzdHJpbmcpID0+IHRoZW1lLmZnKFwiZGltXCIsIHQpLFxuICAgICAgICBub01hdGNoOiAodDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcIndhcm5pbmdcIiwgdCksXG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3QgZWRpdG9yID0gbmV3IEVkaXRvcih0dWksIGVkaXRvclRoZW1lLCB7IHBhZGRpbmdYOiAxIH0pO1xuICAgIGNvbnN0IHJlZnJlc2ggPSAoKSA9PiB7IGNhY2hlZExpbmVzID0gdW5kZWZpbmVkOyB0dWkucmVxdWVzdFJlbmRlcigpOyB9O1xuICAgIGNvbnN0IGhhbmRsZUlucHV0ID0gKGRhdGE6IHN0cmluZykgPT4ge1xuICAgICAgaWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LmVudGVyKSkgcmV0dXJuIGRvbmUoZWRpdG9yLmdldFRleHQoKS50cmltKCkgfHwgbnVsbCk7XG4gICAgICBpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkuZXNjYXBlKSkgcmV0dXJuIGRvbmUobnVsbCk7XG4gICAgICBlZGl0b3IuaGFuZGxlSW5wdXQoZGF0YSk7IHJlZnJlc2goKTtcbiAgICB9O1xuICAgIGNvbnN0IHJlbmRlciA9ICh3aWR0aDogbnVtYmVyKSA9PiB7XG4gICAgICBpZiAoY2FjaGVkTGluZXMpIHJldHVybiBjYWNoZWRMaW5lcztcbiAgICAgIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgY29uc3QgYWRkID0gKHM6IHN0cmluZykgPT4gbGluZXMucHVzaCh0cnVuY2F0ZVRvV2lkdGgocywgd2lkdGgpKTtcbiAgICAgIGFkZCh0aGVtZS5mZyhcImFjY2VudFwiLCBcIlx1MjUwMFwiLnJlcGVhdCh3aWR0aCkpKTtcbiAgICAgIGFkZCh0aGVtZS5mZyhcImFjY2VudFwiLCB0aGVtZS5ib2xkKGAgJHtsYWJlbH1gKSkpO1xuICAgICAgYWRkKHRoZW1lLmZnKFwibXV0ZWRcIiwgYCAgJHtoaW50fWApKTtcbiAgICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgICBhZGQodGhlbWUuZmcoXCJtdXRlZFwiLCBcIiBFbnRlciB2YWx1ZTpcIikpO1xuICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGVkaXRvci5yZW5kZXIod2lkdGggLSAyKSkgYWRkKHRoZW1lLmZnKFwidGV4dFwiLCBtYXNrRWRpdG9yTGluZShsaW5lKSkpO1xuICAgICAgbGluZXMucHVzaChcIlwiKTtcbiAgICAgIGFkZCh0aGVtZS5mZyhcImRpbVwiLCBcIiBlbnRlciB0byBjb25maXJtICB8ICBlc2MgdG8gY2FuY2VsXCIpKTtcbiAgICAgIGFkZCh0aGVtZS5mZyhcImFjY2VudFwiLCBcIlx1MjUwMFwiLnJlcGVhdCh3aWR0aCkpKTtcbiAgICAgIGNhY2hlZExpbmVzID0gbGluZXM7XG4gICAgICByZXR1cm4gbGluZXM7XG4gICAgfTtcbiAgICByZXR1cm4geyByZW5kZXIsIGhhbmRsZUlucHV0LCBpbnZhbGlkYXRlOiAoKSA9PiB7IGNhY2hlZExpbmVzID0gdW5kZWZpbmVkOyB9IH07XG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwcm9tcHRJbnB1dChjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBsYWJlbDogc3RyaW5nLCBoaW50OiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgaWYgKCFjdHguaGFzVUkpIHJldHVybiBudWxsO1xuICByZXR1cm4gY3R4LnVpLmN1c3RvbTxzdHJpbmcgfCBudWxsPigodHVpOiBhbnksIHRoZW1lOiBhbnksIF9rYjogYW55LCBkb25lOiAocjogc3RyaW5nIHwgbnVsbCkgPT4gdm9pZCkgPT4ge1xuICAgIGxldCBjYWNoZWRMaW5lczogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG4gICAgY29uc3QgZWRpdG9yVGhlbWU6IEVkaXRvclRoZW1lID0ge1xuICAgICAgYm9yZGVyQ29sb3I6IChzOiBzdHJpbmcpID0+IHRoZW1lLmZnKFwiYWNjZW50XCIsIHMpLFxuICAgICAgc2VsZWN0TGlzdDoge1xuICAgICAgICBzZWxlY3RlZFByZWZpeDogKHQ6IHN0cmluZykgPT4gdGhlbWUuZmcoXCJhY2NlbnRcIiwgdCksXG4gICAgICAgIHNlbGVjdGVkVGV4dDogKHQ6IHN0cmluZykgPT4gdGhlbWUuZmcoXCJhY2NlbnRcIiwgdCksXG4gICAgICAgIGRlc2NyaXB0aW9uOiAodDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcIm11dGVkXCIsIHQpLFxuICAgICAgICBzY3JvbGxJbmZvOiAodDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcImRpbVwiLCB0KSxcbiAgICAgICAgbm9NYXRjaDogKHQ6IHN0cmluZykgPT4gdGhlbWUuZmcoXCJ3YXJuaW5nXCIsIHQpLFxuICAgICAgfSxcbiAgICB9O1xuICAgIGNvbnN0IGVkaXRvciA9IG5ldyBFZGl0b3IodHVpLCBlZGl0b3JUaGVtZSwgeyBwYWRkaW5nWDogMSB9KTtcbiAgICBjb25zdCByZWZyZXNoID0gKCkgPT4geyBjYWNoZWRMaW5lcyA9IHVuZGVmaW5lZDsgdHVpLnJlcXVlc3RSZW5kZXIoKTsgfTtcbiAgICBjb25zdCBoYW5kbGVJbnB1dCA9IChkYXRhOiBzdHJpbmcpID0+IHtcbiAgICAgIGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS5lbnRlcikpIHJldHVybiBkb25lKGVkaXRvci5nZXRUZXh0KCkudHJpbSgpIHx8IG51bGwpO1xuICAgICAgaWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LmVzY2FwZSkpIHJldHVybiBkb25lKG51bGwpO1xuICAgICAgZWRpdG9yLmhhbmRsZUlucHV0KGRhdGEpOyByZWZyZXNoKCk7XG4gICAgfTtcbiAgICBjb25zdCByZW5kZXIgPSAod2lkdGg6IG51bWJlcikgPT4ge1xuICAgICAgaWYgKGNhY2hlZExpbmVzKSByZXR1cm4gY2FjaGVkTGluZXM7XG4gICAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICAgIGNvbnN0IGFkZCA9IChzOiBzdHJpbmcpID0+IGxpbmVzLnB1c2godHJ1bmNhdGVUb1dpZHRoKHMsIHdpZHRoKSk7XG4gICAgICBhZGQodGhlbWUuZmcoXCJhY2NlbnRcIiwgXCJcdTI1MDBcIi5yZXBlYXQod2lkdGgpKSk7XG4gICAgICBhZGQodGhlbWUuZmcoXCJhY2NlbnRcIiwgdGhlbWUuYm9sZChgICR7bGFiZWx9YCkpKTtcbiAgICAgIGFkZCh0aGVtZS5mZyhcIm11dGVkXCIsIGAgICR7aGludH1gKSk7XG4gICAgICBsaW5lcy5wdXNoKFwiXCIpO1xuICAgICAgYWRkKHRoZW1lLmZnKFwibXV0ZWRcIiwgXCIgRW50ZXIgdmFsdWU6XCIpKTtcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBlZGl0b3IucmVuZGVyKHdpZHRoIC0gMikpIGFkZCh0aGVtZS5mZyhcInRleHRcIiwgbGluZSkpO1xuICAgICAgbGluZXMucHVzaChcIlwiKTtcbiAgICAgIGFkZCh0aGVtZS5mZyhcImRpbVwiLCBcIiBlbnRlciB0byBjb25maXJtICB8ICBlc2MgdG8gY2FuY2VsXCIpKTtcbiAgICAgIGFkZCh0aGVtZS5mZyhcImFjY2VudFwiLCBcIlx1MjUwMFwiLnJlcGVhdCh3aWR0aCkpKTtcbiAgICAgIGNhY2hlZExpbmVzID0gbGluZXM7XG4gICAgICByZXR1cm4gbGluZXM7XG4gICAgfTtcbiAgICByZXR1cm4geyByZW5kZXIsIGhhbmRsZUlucHV0LCBpbnZhbGlkYXRlOiAoKSA9PiB7IGNhY2hlZExpbmVzID0gdW5kZWZpbmVk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
