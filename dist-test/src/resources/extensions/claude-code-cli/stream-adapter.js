import { EventStream } from "@gsd/pi-ai";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PartialMessageBuilder, ZERO_USAGE, mapUsage } from "./partial-builder.js";
import { buildWorkflowMcpServers } from "../gsd/workflow-mcp.js";
import { loadProjectGSDPreferences } from "../gsd/preferences.js";
import { discoverMcpServerNames, computeMcpDisallowedTools } from "../gsd/mcp-filter.js";
import { showInterviewRound } from "../shared/tui.js";
function resolveClaudeCodeCwd(options) {
  return options?.cwd && options.cwd.trim().length > 0 ? options.cwd : process.cwd();
}
const OTHER_OPTION_LABEL = "None of the above";
const SENSITIVE_FIELD_PATTERN = /(password|passphrase|secret|token|api[_\s-]*key|private[_\s-]*key|credential)/i;
function createAssistantStream() {
  return new EventStream(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      if (event.type === "error") return event.error;
      throw new Error("Unexpected event type for final result");
    }
  );
}
function getResultErrorMessage(result) {
  if ("errors" in result && Array.isArray(result.errors) && result.errors.length > 0) {
    return result.errors.join("; ");
  }
  if ("result" in result && typeof result.result === "string" && result.result.trim().length > 0) {
    return result.result.trim();
  }
  return result.subtype === "success" ? "claude_code_request_failed" : result.subtype;
}
let cachedClaudePath = null;
const requireFromHere = createRequire(import.meta.url);
function getClaudeLookupCommand(platform = process.platform) {
  return platform === "win32" ? "where claude" : "which claude";
}
function parseClaudeLookupOutput(output, platform = process.platform) {
  const lines = output.toString().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  if (platform !== "win32") return lines[0] ?? "";
  const exeCandidate = lines.find((line) => /\.exe$/i.test(line));
  if (exeCandidate) return exeCandidate;
  const cmdCandidate = lines.find((line) => /\.cmd$/i.test(line));
  if (cmdCandidate) return cmdCandidate;
  return lines[0] ?? "";
}
function resolveBundledClaudeCliPath() {
  try {
    const sdkEntry = requireFromHere.resolve("@anthropic-ai/claude-agent-sdk");
    const cliPath = join(dirname(sdkEntry), "cli.js");
    return existsSync(cliPath) ? cliPath : null;
  } catch {
    return null;
  }
}
function normalizeClaudePathForSdk(resolvedPath, platform = process.platform, bundledCliPath = resolveBundledClaudeCliPath()) {
  if (platform !== "win32") return resolvedPath;
  if (/\.exe$/i.test(resolvedPath)) return resolvedPath;
  if (bundledCliPath) return bundledCliPath;
  return resolvedPath;
}
function getClaudePath() {
  if (cachedClaudePath) return cachedClaudePath;
  const fallback = process.platform === "win32" ? resolveBundledClaudeCliPath() ?? "claude.cmd" : "claude";
  try {
    const lookupOutput = execSync(getClaudeLookupCommand(), { timeout: 5e3, stdio: "pipe" });
    const parsed = parseClaudeLookupOutput(lookupOutput, process.platform);
    cachedClaudePath = normalizeClaudePathForSdk(parsed || fallback, process.platform);
  } catch {
    cachedClaudePath = fallback;
  }
  return cachedClaudePath;
}
function extractMessageText(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    const textParts = msg.content.filter((part) => part.type === "text").map((part) => part.text ?? part.thinking ?? "");
    if (textParts.length > 0) return textParts.join("\n");
  }
  return "";
}
function buildPromptFromContext(context) {
  const hasContent = Boolean(context.systemPrompt) || context.messages.some((m) => extractMessageText(m));
  if (!hasContent) return "";
  const parts = [
    "Respond only to the final user message below. Do not emit <user_message>, <assistant_message>, or <prior_system_context> tags in your response."
  ];
  if (context.systemPrompt) {
    parts.push(`<prior_system_context>
${context.systemPrompt}
</prior_system_context>`);
  }
  const turns = [];
  for (const msg of context.messages) {
    const text = extractMessageText(msg);
    if (!text) continue;
    const tag = msg.role === "user" ? "user_message" : msg.role === "assistant" ? "assistant_message" : "system_message";
    turns.push(`<${tag}>
${text}
</${tag}>`);
  }
  if (turns.length > 0) {
    parts.push(`<conversation_history>
${turns.join("\n")}
</conversation_history>`);
  }
  return parts.join("\n\n");
}
function stripDataUriPrefix(value) {
  const commaIndex = value.indexOf(",");
  if (value.startsWith("data:") && commaIndex !== -1) {
    return value.slice(commaIndex + 1);
  }
  return value;
}
function inferMimeTypeFromDataUri(value) {
  const match = /^data:([^;,]+);base64,/.exec(value);
  return match?.[1] ?? null;
}
function extractImageBlocksFromContext(context) {
  const imageBlocks = [];
  for (const msg of context.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      const block = part;
      if (block.type !== "image" || typeof block.data !== "string") continue;
      const mimeType = typeof block.mimeType === "string" && block.mimeType.length > 0 ? block.mimeType : inferMimeTypeFromDataUri(block.data);
      if (!mimeType) continue;
      imageBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mimeType,
          data: stripDataUriPrefix(block.data)
        }
      });
    }
  }
  return imageBlocks;
}
function buildSdkQueryPrompt(context, textPrompt = buildPromptFromContext(context)) {
  const imageBlocks = extractImageBlocksFromContext(context);
  if (imageBlocks.length === 0) {
    return textPrompt;
  }
  const content = [...imageBlocks];
  if (textPrompt) {
    content.push({ type: "text", text: textPrompt });
  }
  const sdkMessage = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null
  };
  return (async function* () {
    yield sdkMessage;
  })();
}
function makeErrorMessage(model, errorMsg) {
  return {
    role: "assistant",
    content: [{ type: "text", text: `Claude Code error: ${errorMsg}` }],
    api: "anthropic-messages",
    provider: "claude-code",
    model,
    usage: { ...ZERO_USAGE },
    stopReason: "error",
    errorMessage: errorMsg,
    timestamp: Date.now()
  };
}
function isClaudeCodeAbortErrorMessage(message) {
  if (!message) return false;
  return /\b(?:claude code process aborted by user|request aborted by user|process aborted by user)\b/i.test(message);
}
function isBareClaudeCodeAbortErrorMessage(message) {
  if (!message) return false;
  const normalized = message.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized === "claude code process aborted by user" || normalized === "request aborted by user" || normalized === "process aborted by user";
}
function resolveClaudeCodeAbortedMessageText(errorMsg, lastTextContent) {
  const trimmedError = errorMsg.trim();
  if (trimmedError && !isBareClaudeCodeAbortErrorMessage(trimmedError)) {
    return trimmedError;
  }
  return lastTextContent;
}
function makeStreamExhaustedErrorMessage(model, lastTextContent) {
  const errorMsg = "stream_exhausted_without_result";
  const message = makeErrorMessage(model, errorMsg);
  if (lastTextContent) {
    message.content = [{ type: "text", text: lastTextContent }];
  }
  return message;
}
function readElicitationChoices(options) {
  if (!Array.isArray(options)) return [];
  return options.map((option) => typeof option?.const === "string" ? option.const : typeof option?.title === "string" ? option.title : "").filter((option) => option.length > 0);
}
function parseAskUserQuestionsElicitation(request) {
  if (request.mode && request.mode !== "form") return null;
  const properties = request.requestedSchema?.properties;
  if (!properties || typeof properties !== "object") return null;
  const questions = [];
  for (const [fieldId, rawField] of Object.entries(properties)) {
    if (fieldId.endsWith("__note")) continue;
    if (!rawField || typeof rawField !== "object") return null;
    const header = typeof rawField.title === "string" && rawField.title.length > 0 ? rawField.title : fieldId;
    const question = typeof rawField.description === "string" ? rawField.description : "";
    if (rawField.type === "array") {
      const options = readElicitationChoices(rawField.items?.anyOf).map((label) => ({ label, description: "" }));
      if (options.length === 0) return null;
      questions.push({
        id: fieldId,
        header,
        question,
        options,
        allowMultiple: true
      });
      continue;
    }
    if (rawField.type === "string") {
      const noteFieldId = Object.prototype.hasOwnProperty.call(properties, `${fieldId}__note`) ? `${fieldId}__note` : void 0;
      const options = readElicitationChoices(rawField.oneOf).filter((label) => label !== OTHER_OPTION_LABEL).map((label) => ({ label, description: "" }));
      if (options.length === 0) return null;
      questions.push({
        id: fieldId,
        header,
        question,
        options,
        noteFieldId
      });
      continue;
    }
    return null;
  }
  return questions.length > 0 ? questions : null;
}
function isSecureElicitationField(requestMessage, fieldId, field) {
  if (field.format === "password") return true;
  if (field.writeOnly === true) return true;
  const rawField = field;
  if (rawField.sensitive === true || rawField["x-sensitive"] === true) return true;
  const haystack = [
    requestMessage,
    fieldId.replace(/[_-]+/g, " "),
    typeof field.title === "string" ? field.title : "",
    typeof field.description === "string" ? field.description : ""
  ].join(" ").toLowerCase();
  return SENSITIVE_FIELD_PATTERN.test(haystack);
}
function parseTextInputElicitation(request) {
  if (request.mode && request.mode !== "form") return null;
  const schema = request.requestedSchema;
  const fieldsSource = schema?.properties && typeof schema.properties === "object" ? schema.properties : schema?.keys && typeof schema.keys === "object" ? schema.keys : void 0;
  if (!fieldsSource) return null;
  const requiredSet = new Set(
    Array.isArray(request.requestedSchema?.required) ? request.requestedSchema.required.filter((value) => typeof value === "string") : []
  );
  const fields = [];
  for (const [fieldId, field] of Object.entries(fieldsSource)) {
    if (!field || typeof field !== "object") continue;
    if (field.type !== "string") continue;
    if (Array.isArray(field.oneOf) && field.oneOf.length > 0) continue;
    fields.push({
      id: fieldId,
      title: typeof field.title === "string" && field.title.length > 0 ? field.title : fieldId,
      description: typeof field.description === "string" ? field.description : "",
      required: requiredSet.has(fieldId),
      secure: isSecureElicitationField(request.message, fieldId, field)
    });
  }
  return fields.length > 0 ? fields : null;
}
function roundResultToElicitationContent(questions, result) {
  const content = {};
  for (const question of questions) {
    const answer = result.answers[question.id];
    if (!answer) continue;
    if (question.allowMultiple) {
      const selected2 = Array.isArray(answer.selected) ? answer.selected : [answer.selected];
      content[question.id] = selected2;
      continue;
    }
    const selected = Array.isArray(answer.selected) ? answer.selected[0] ?? "" : answer.selected;
    content[question.id] = selected;
    if (question.noteFieldId && selected === OTHER_OPTION_LABEL && answer.notes.trim().length > 0) {
      content[question.noteFieldId] = answer.notes.trim();
    }
  }
  return content;
}
function buildElicitationPromptTitle(request, question) {
  const parts = [
    request.serverName ? `[${request.serverName}]` : "",
    question.header,
    question.question
  ].filter((part) => part && part.trim().length > 0);
  return parts.join("\n\n");
}
async function promptElicitationWithDialogs(request, questions, ui, signal) {
  const content = {};
  for (const question of questions) {
    const title = buildElicitationPromptTitle(request, question);
    if (question.allowMultiple) {
      const selected2 = await ui.select(title, question.options.map((option) => option.label), {
        allowMultiple: true,
        signal
      });
      if (Array.isArray(selected2)) {
        if (selected2.length === 0) return { action: "cancel" };
        content[question.id] = selected2;
        continue;
      }
      if (typeof selected2 === "string" && selected2.length > 0) {
        content[question.id] = [selected2];
        continue;
      }
      return { action: "cancel" };
    }
    const selected = await ui.select(title, [...question.options.map((option) => option.label), OTHER_OPTION_LABEL], { signal });
    if (typeof selected !== "string" || selected.length === 0) {
      return { action: "cancel" };
    }
    content[question.id] = selected;
    if (question.noteFieldId && selected === OTHER_OPTION_LABEL) {
      const note = await ui.input(`${question.header} note`, "Explain your answer", { signal });
      if (note === void 0) return { action: "cancel" };
      if (note.trim().length > 0) {
        content[question.noteFieldId] = note.trim();
      }
    }
  }
  return { action: "accept", content };
}
function buildTextInputPromptTitle(request, field) {
  const parts = [
    request.serverName ? `[${request.serverName}]` : "",
    field.title,
    field.description
  ].filter((part) => typeof part === "string" && part.trim().length > 0);
  return parts.join("\n\n");
}
function buildTextInputPlaceholder(field) {
  const desc = field.description.trim();
  if (!desc) return field.required ? "Required" : "Leave empty to skip";
  const formatLine = desc.split(/\r?\n/).map((line) => line.trim()).find((line) => /^format:/i.test(line));
  if (!formatLine) return field.required ? "Required" : "Leave empty to skip";
  const hint = formatLine.replace(/^format:\s*/i, "").trim();
  return hint.length > 0 ? hint : field.required ? "Required" : "Leave empty to skip";
}
async function promptTextInputElicitation(request, fields, ui, signal) {
  const content = {};
  for (const field of fields) {
    const value = await ui.input(
      buildTextInputPromptTitle(request, field),
      buildTextInputPlaceholder(field),
      { signal, ...field.secure ? { secure: true } : {} }
    );
    if (value === void 0) {
      return { action: "cancel" };
    }
    content[field.id] = value;
  }
  return { action: "accept", content };
}
const SUBCOMMAND_DEPTH = {
  git: 1,
  gh: 2,
  npm: 1,
  npx: 1,
  yarn: 1,
  pnpm: 1,
  docker: 1,
  kubectl: 1,
  aws: 2,
  az: 2,
  gcloud: 2,
  cargo: 1,
  pip: 1,
  pip3: 1,
  brew: 1,
  terraform: 1,
  helm: 1,
  dotnet: 1
};
const CMD_PASSTHROUGH = /* @__PURE__ */ new Set(["sudo", "env", "command"]);
function buildBashPermissionPattern(command) {
  const segments = command.split(/\s*(?:&&|\|\||;)\s*/);
  const SETUP_RE = /^\s*cd\s/;
  const SUPPRESSOR_RE = /^\s*(?:true|:|echo\b)/;
  let meaningful;
  if (segments.length > 1) {
    const trimmed = segments.filter((s) => !SUPPRESSOR_RE.test(s));
    const core = trimmed.filter((s) => !SETUP_RE.test(s));
    meaningful = core.length > 0 ? core[core.length - 1] : trimmed[trimmed.length - 1];
  }
  meaningful = meaningful || segments[0] || command;
  const rawTokens = meaningful.trim().split(/\s+/);
  let idx = 0;
  while (idx < rawTokens.length) {
    if (CMD_PASSTHROUGH.has(rawTokens[idx])) {
      idx++;
      continue;
    }
    if (/^[A-Za-z_]\w*=/.test(rawTokens[idx])) {
      idx++;
      continue;
    }
    break;
  }
  const tokens = rawTokens.slice(idx).filter(Boolean);
  if (tokens.length === 0) return "Bash(*)";
  const base = tokens[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
  const depth = SUBCOMMAND_DEPTH[base];
  if (depth !== void 0) {
    const significant = [base, ...tokens.slice(1, 1 + depth)].join(" ");
    return `Bash(${significant}:*)`;
  }
  return `Bash(${base}:*)`;
}
function buildBashPermissionPatternOptions(command) {
  const segments = command.split(/\s*(?:&&|\|\||;)\s*/);
  const SETUP_RE = /^\s*cd\s/;
  const SUPPRESSOR_RE = /^\s*(?:true|:|echo\b)/;
  let meaningful;
  if (segments.length > 1) {
    const trimmed = segments.filter((s) => !SUPPRESSOR_RE.test(s));
    const core = trimmed.filter((s) => !SETUP_RE.test(s));
    meaningful = core.length > 0 ? core[core.length - 1] : trimmed[trimmed.length - 1];
  }
  meaningful = meaningful || segments[0] || command;
  const rawTokens = meaningful.trim().split(/\s+/);
  let idx = 0;
  while (idx < rawTokens.length) {
    if (CMD_PASSTHROUGH.has(rawTokens[idx])) {
      idx++;
      continue;
    }
    if (/^[A-Za-z_]\w*=/.test(rawTokens[idx])) {
      idx++;
      continue;
    }
    break;
  }
  const tokens = rawTokens.slice(idx).filter(Boolean);
  if (tokens.length === 0) return ["Bash(*)"];
  const base = tokens[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
  const subTokens = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) break;
    subTokens.push(t);
    if (subTokens.length >= 3) break;
  }
  const patterns = [`Bash(${base}:*)`];
  for (let i = 1; i <= subTokens.length; i++) {
    patterns.push(`Bash(${[base, ...subTokens.slice(0, i)].join(" ")}:*)`);
  }
  return patterns;
}
function readBashAllowRulesFromSettings() {
  const rules = [];
  const paths = [
    join(process.cwd(), ".claude", "settings.local.json"),
    join(process.cwd(), ".claude", "settings.json")
  ];
  try {
    paths.push(join(homedir(), ".claude", "settings.json"));
  } catch {
  }
  for (const settingsPath of paths) {
    try {
      if (!existsSync(settingsPath)) continue;
      const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
      const allow = raw?.permissions?.allow;
      if (!Array.isArray(allow)) continue;
      for (const entry of allow) {
        if (typeof entry !== "string") continue;
        const m = /^Bash\((.+)\)$/.exec(entry);
        if (m) rules.push(m[1]);
      }
    } catch {
    }
  }
  return rules;
}
function bashCommandMatchesSavedRules(command) {
  const segments = command.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  if (segments.length === 0) return false;
  let meaningful;
  if (segments.length === 1) {
    meaningful = segments[0].trim();
  } else {
    const SETUP_RE = /^cd\s/;
    const SUPPRESSOR_RE = /^\s*(?:true|:|echo\b)/;
    const trimmed = segments.filter((s) => !SUPPRESSOR_RE.test(s.trim()));
    const core = trimmed.filter((s) => !SETUP_RE.test(s.trim()));
    if (core.length !== 1) return false;
    meaningful = core[0].trim();
  }
  if (!meaningful) return false;
  const rules = readBashAllowRulesFromSettings();
  if (rules.length === 0) return false;
  for (const rule of rules) {
    const prefixMatch = /^(.+):\*$/.exec(rule);
    if (prefixMatch) {
      const prefix = prefixMatch[1];
      if (meaningful === prefix || meaningful.startsWith(prefix + " ")) {
        return true;
      }
      continue;
    }
    if (meaningful === rule) return true;
  }
  return false;
}
function formatToolInput(toolName, input) {
  if (input.command && typeof input.command === "string") {
    const cmd = input.command.length > 300 ? input.command.slice(0, 300) + "\u2026" : input.command;
    return cmd;
  }
  if (input.file_path && typeof input.file_path === "string") {
    return `${toolName}: ${input.file_path}`;
  }
  const json = JSON.stringify(input);
  if (json.length <= 200) return json;
  return json.slice(0, 200) + "\u2026";
}
function createClaudeCodeCanUseToolHandler(ui) {
  if (!ui) return void 0;
  return async (toolName, _input, options) => {
    if (options.signal.aborted) {
      return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
    }
    if (toolName === "Bash" && typeof _input.command === "string") {
      if (bashCommandMatchesSavedRules(_input.command)) {
        return { behavior: "allow", updatedInput: _input, toolUseID: options.toolUseID };
      }
    }
    const inputSummary = formatToolInput(toolName, _input);
    const title = options.title || `Allow Claude Code to use: ${toolName}?`;
    const body = [
      options.description,
      inputSummary
    ].filter(Boolean).join("\n");
    const alwaysAllowLabel = "Always Allow";
    try {
      const choice = await ui.select(
        `${title}
${body}`,
        ["Allow", alwaysAllowLabel, "Deny"],
        { signal: options.signal }
      );
      if (options.signal.aborted) {
        return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
      }
      if (choice === alwaysAllowLabel) {
        let perms = options.suggestions;
        let notifyLabel;
        if (toolName === "Bash" && typeof _input.command === "string") {
          const patternOptions = buildBashPermissionPatternOptions(_input.command);
          let chosenPattern;
          if (patternOptions.length <= 1) {
            chosenPattern = patternOptions[0] ?? buildBashPermissionPattern(_input.command);
          } else {
            const levelChoiceRaw = await ui.select(
              "Save permission at which level?",
              patternOptions,
              { signal: options.signal }
            );
            if (options.signal.aborted) {
              return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
            }
            const levelChoice = Array.isArray(levelChoiceRaw) ? levelChoiceRaw[0] : levelChoiceRaw;
            if (!levelChoice || !patternOptions.includes(levelChoice)) {
              return {
                behavior: "deny",
                message: "User cancelled permission selection",
                toolUseID: options.toolUseID
              };
            }
            chosenPattern = levelChoice;
          }
          notifyLabel = chosenPattern;
          const ruleContent = chosenPattern.replace(/^Bash\(/, "").replace(/\)$/, "");
          if (perms && Array.isArray(perms) && perms.length > 0) {
            perms = perms.map((s) => {
              if (s.type === "addRules" && Array.isArray(s.rules)) {
                return {
                  ...s,
                  rules: s.rules.map(
                    (r) => r.toolName === "Bash" ? { ...r, ruleContent } : r
                  )
                };
              }
              return s;
            });
          } else {
            perms = [{
              type: "addRules",
              rules: [{ toolName: "Bash", ruleContent }],
              behavior: "allow",
              destination: "localSettings"
            }];
          }
        } else if (!perms || Array.isArray(perms) && perms.length === 0) {
          perms = [{
            type: "addRules",
            rules: [{ toolName }],
            behavior: "allow",
            destination: "localSettings"
          }];
          notifyLabel = toolName;
        }
        if (notifyLabel) {
          ui.notify(`Saved: ${notifyLabel}`, "info");
        }
        return {
          behavior: "allow",
          updatedInput: _input,
          toolUseID: options.toolUseID,
          ...perms ? { updatedPermissions: perms } : {}
        };
      }
      if (choice === "Allow") {
        return {
          behavior: "allow",
          updatedInput: _input,
          toolUseID: options.toolUseID
        };
      }
      return { behavior: "deny", message: "User denied", toolUseID: options.toolUseID };
    } catch {
      return { behavior: "deny", message: "Aborted", toolUseID: options.toolUseID };
    }
  };
}
function createClaudeCodeElicitationHandler(ui) {
  if (!ui) return void 0;
  return async (request, { signal }) => {
    if (request.mode === "url") {
      return { action: "decline" };
    }
    const questions = parseAskUserQuestionsElicitation(request);
    if (questions) {
      const interviewResult = await showInterviewRound(questions, { signal }, { ui }).catch(() => void 0);
      if (interviewResult && Object.keys(interviewResult.answers).length > 0) {
        return {
          action: "accept",
          content: roundResultToElicitationContent(questions, interviewResult)
        };
      }
      return promptElicitationWithDialogs(request, questions, ui, signal);
    }
    const textFields = parseTextInputElicitation(request);
    if (textFields) {
      return promptTextInputElicitation(request, textFields, ui, signal);
    }
    return { action: "decline" };
  };
}
function makeAbortedMessage(model, lastTextContent) {
  const message = {
    role: "assistant",
    content: lastTextContent ? [{ type: "text", text: lastTextContent }] : [{ type: "text", text: "Claude Code stream aborted by caller" }],
    api: "anthropic-messages",
    provider: "claude-code",
    model,
    usage: { ...ZERO_USAGE },
    stopReason: "aborted",
    timestamp: Date.now()
  };
  return message;
}
async function resolveClaudePermissionMode(env = process.env) {
  const override = env.GSD_CLAUDE_CODE_PERMISSION_MODE?.trim();
  if (override === "bypassPermissions" || override === "acceptEdits" || override === "default" || override === "plan") {
    return override;
  }
  if (env.GSD_HEADLESS === "1") {
    console.warn(
      "[claude-code-cli] Headless mode detected (GSD_HEADLESS=1): defaulting permissionMode to 'bypassPermissions' so verification Bash commands can run. Set GSD_CLAUDE_CODE_PERMISSION_MODE=acceptEdits to opt out."
    );
    return "bypassPermissions";
  }
  return "bypassPermissions";
}
function modelSupportsAdaptiveThinking(modelId) {
  return modelId.includes("opus-4-6") || modelId.includes("opus-4.6") || modelId.includes("opus-4-7") || modelId.includes("opus-4.7") || modelId.includes("sonnet-4-6") || modelId.includes("sonnet-4.6") || modelId.includes("sonnet-4-7") || modelId.includes("sonnet-4.7") || modelId.includes("haiku-4-5") || modelId.includes("haiku-4.5");
}
function mapThinkingLevelToAnthropicEffort(level, modelId) {
  switch (level) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      if (modelId.includes("opus-4-7") || modelId.includes("opus-4.7")) return "xhigh";
      if (modelId.includes("opus-4-6") || modelId.includes("opus-4.6")) return "max";
      return "high";
    default:
      return "high";
  }
}
function buildSdkOptions(modelId, prompt, overrides, extraOptions = {}) {
  const { reasoning, cwd, ...sdkExtraOptions } = extraOptions;
  const sdkCwd = typeof cwd === "string" && cwd.trim().length > 0 ? cwd : process.cwd();
  const mcpServers = buildWorkflowMcpServers(sdkCwd);
  const permissionMode = overrides?.permissionMode ?? "bypassPermissions";
  const preferences = loadProjectGSDPreferences(sdkCwd);
  const mcpConfig = preferences?.preferences.claude_code_mcp;
  const workflowServerName = mcpServers ? Object.keys(mcpServers)[0] : void 0;
  let filteredMcpServers = mcpServers;
  let extraDisallowedTools = [];
  if (mcpConfig) {
    const discovered = discoverMcpServerNames(sdkCwd);
    extraDisallowedTools = computeMcpDisallowedTools(modelId, mcpConfig, discovered, workflowServerName);
    if (workflowServerName && extraDisallowedTools.includes(`mcp__${workflowServerName}__*`)) {
      filteredMcpServers = void 0;
    }
  }
  const workflowMcpTools = filteredMcpServers ? Object.keys(filteredMcpServers).map((serverName) => `mcp__${serverName}__*`) : [];
  const disallowedTools = [...workflowMcpTools.length > 0 ? ["AskUserQuestion"] : [], ...extraDisallowedTools];
  const allowedTools = [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Bash",
    "Agent",
    "WebFetch",
    "WebSearch",
    ...workflowMcpTools.length > 0 ? workflowMcpTools : ["AskUserQuestion"]
  ];
  const supportsAdaptive = modelSupportsAdaptiveThinking(modelId);
  const effort = reasoning && supportsAdaptive ? mapThinkingLevelToAnthropicEffort(reasoning, modelId) : void 0;
  const thinkingConfig = supportsAdaptive ? effort ? { thinking: { type: "adaptive" } } : { thinking: { type: "disabled" } } : void 0;
  return {
    pathToClaudeCodeExecutable: getClaudePath(),
    model: modelId,
    includePartialMessages: true,
    persistSession: true,
    cwd: sdkCwd,
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
    settingSources: ["project"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    disallowedTools,
    ...allowedTools.length > 0 ? { allowedTools } : {},
    ...filteredMcpServers ? { mcpServers: filteredMcpServers } : {},
    betas: modelId.includes("sonnet") || modelId.includes("opus-4-7") || modelId.includes("opus-4.7") ? ["context-1m-2025-08-07"] : [],
    ...thinkingConfig ?? {},
    ...effort ? { effort } : {},
    ...sdkExtraOptions
  };
}
function normalizeToolResultContent(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    if (content == null) return [{ type: "text", text: "" }];
    return [{ type: "text", text: JSON.stringify(content) }];
  }
  const blocks = [];
  for (const item of content) {
    if (typeof item === "string") {
      blocks.push({ type: "text", text: item });
      continue;
    }
    if (!item || typeof item !== "object") {
      blocks.push({ type: "text", text: String(item) });
      continue;
    }
    const block = item;
    if (block.type === "text") {
      blocks.push({ type: "text", text: typeof block.text === "string" ? block.text : "" });
      continue;
    }
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
      continue;
    }
    blocks.push({ type: "text", text: JSON.stringify(block) });
  }
  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}
function extractStructuredDetailsFromBlock(block) {
  const sibling = block.structuredContent ?? block.structured_content;
  if (sibling && typeof sibling === "object" && !Array.isArray(sibling)) {
    return sibling;
  }
  if (Array.isArray(block.content)) {
    for (const item of block.content) {
      if (!item || typeof item !== "object") continue;
      const sub = item;
      if (sub.type !== "structuredContent" && sub.type !== "structured_content") continue;
      const payload = sub.structuredContent ?? sub.structured_content ?? sub.data ?? sub.value;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        return payload;
      }
    }
  }
  return void 0;
}
function isStructuredContentPseudoBlock(item) {
  if (!item || typeof item !== "object") return false;
  const type = item.type;
  return type === "structuredContent" || type === "structured_content";
}
function stripStructuredContentPseudoBlocks(content) {
  if (!Array.isArray(content)) return content;
  return content.filter((item) => !isStructuredContentPseudoBlock(item));
}
function extractToolResultsFromSdkUserMessage(message) {
  const extracted = [];
  const seen = /* @__PURE__ */ new Set();
  const rawMessage = message.message;
  const content = Array.isArray(rawMessage?.content) ? rawMessage.content : [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item;
    const type = typeof block.type === "string" ? block.type : "";
    if (type !== "tool_result" && type !== "mcp_tool_result") continue;
    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
    if (!toolUseId || seen.has(toolUseId)) continue;
    seen.add(toolUseId);
    extracted.push({
      toolUseId,
      result: {
        content: normalizeToolResultContent(stripStructuredContentPseudoBlocks(block.content)),
        details: extractStructuredDetailsFromBlock(block),
        isError: block.is_error === true
      }
    });
  }
  if (extracted.length === 0) {
    const fallback = message.tool_use_result;
    if (fallback && typeof fallback === "object") {
      const toolResult = fallback;
      const toolUseId = typeof toolResult.tool_use_id === "string" ? toolResult.tool_use_id : "";
      if (toolUseId) {
        extracted.push({
          toolUseId,
          result: {
            content: normalizeToolResultContent(stripStructuredContentPseudoBlocks(toolResult.content)),
            details: extractStructuredDetailsFromBlock(toolResult),
            isError: toolResult.is_error === true
          }
        });
      }
    }
  }
  return extracted;
}
function attachExternalResultsToToolBlocks(toolBlocks, toolResultsById) {
  for (const block of toolBlocks) {
    if (block.type !== "toolCall" && block.type !== "serverToolUse") continue;
    const externalResult = toolResultsById.get(block.id);
    if (!externalResult) continue;
    block.externalResult = externalResult;
  }
}
function buildFinalAssistantContent(params) {
  const mergedToolBlocks = [...params.intermediateToolBlocks];
  if (params.pendingContent) {
    mergePendingToolCalls(mergedToolBlocks, params.pendingContent);
  }
  attachExternalResultsToToolBlocks(mergedToolBlocks, params.toolResultsById);
  const finalContent = [...mergedToolBlocks];
  if (params.pendingContent && params.pendingContent.length > 0) {
    for (const block of params.pendingContent) {
      if (block.type === "text" || block.type === "thinking") {
        finalContent.push(block);
      }
    }
  } else {
    if (params.lastThinkingContent) {
      finalContent.push({ type: "thinking", thinking: params.lastThinkingContent });
    }
    if (params.lastTextContent) {
      finalContent.push({ type: "text", text: params.lastTextContent });
    }
  }
  if (finalContent.length === 0 && params.fallbackResultText) {
    finalContent.push({ type: "text", text: params.fallbackResultText });
  }
  return finalContent;
}
function mergePendingToolCalls(intermediate, pending) {
  const alreadyIncluded = /* @__PURE__ */ new Set();
  for (const block of intermediate) {
    if (block.type === "toolCall") alreadyIncluded.add(block.id);
  }
  for (const block of pending) {
    if (block.type !== "toolCall") continue;
    if (alreadyIncluded.has(block.id)) continue;
    alreadyIncluded.add(block.id);
    intermediate.push(block);
  }
  return intermediate;
}
function streamViaClaudeCode(model, context, options) {
  const stream = createAssistantStream();
  void pumpSdkMessages(model, context, options, stream);
  return stream;
}
async function pumpSdkMessages(model, context, options, stream) {
  const modelId = model.id;
  let builder = null;
  let lastTextContent = "";
  let lastThinkingContent = "";
  const intermediateToolBlocks = [];
  const toolResultsById = /* @__PURE__ */ new Map();
  try {
    const sdkModule = "@anthropic-ai/claude-agent-sdk";
    const sdk = await import(
      /* webpackIgnore: true */
      sdkModule
    );
    const controller = new AbortController();
    if (options?.signal) {
      options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const prompt = buildPromptFromContext(context);
    const queryPrompt = buildSdkQueryPrompt(context, prompt);
    const permissionMode = await resolveClaudePermissionMode();
    const uiContext = options?.extensionUIContext;
    const cwd = resolveClaudeCodeCwd(options);
    const canUseToolHandler = createClaudeCodeCanUseToolHandler(uiContext);
    const canUseToolFallback = canUseToolHandler ?? (async (_toolName, _input, opts) => ({ behavior: "allow", toolUseID: opts.toolUseID }));
    const sdkOpts = buildSdkOptions(
      modelId,
      prompt,
      { permissionMode },
      {
        cwd,
        reasoning: options?.reasoning,
        canUseTool: canUseToolFallback,
        ...uiContext ? {
          onElicitation: createClaudeCodeElicitationHandler(uiContext)
        } : {}
      }
    );
    const queryResult = sdk.query({
      prompt: queryPrompt,
      options: {
        ...sdkOpts,
        abortController: controller
      }
    });
    const initialPartial = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "claude-code",
      model: modelId,
      usage: { ...ZERO_USAGE },
      stopReason: "stop",
      timestamp: Date.now()
    };
    stream.push({ type: "start", partial: initialPartial });
    for await (const msg of queryResult) {
      if (options?.signal?.aborted) {
        stream.push({
          type: "error",
          reason: "aborted",
          error: makeAbortedMessage(modelId, lastTextContent)
        });
        return;
      }
      switch (msg.type) {
        // -- Init --
        case "system": {
          break;
        }
        // -- Streaming partial messages --
        case "stream_event": {
          const partial = msg;
          const event = partial.event;
          if (event.type === "message_start") {
            builder = new PartialMessageBuilder(
              event.message?.model ?? modelId
            );
            break;
          }
          if (!builder) break;
          const assistantEvent = builder.handleEvent(event);
          if (assistantEvent) {
            stream.push(assistantEvent);
          }
          break;
        }
        // -- Complete assistant message (non-streaming fallback) --
        case "assistant": {
          const sdkAssistant = msg;
          for (const block of sdkAssistant.message.content) {
            if (block.type === "text") {
              lastTextContent = block.text;
            } else if (block.type === "thinking") {
              lastThinkingContent = block.thinking;
            }
          }
          break;
        }
        // -- User message (synthetic tool result — signals turn boundary) --
        case "user": {
          if (builder) {
            for (const block of builder.message.content) {
              if (block.type === "text" && block.text) {
                lastTextContent = block.text;
              } else if (block.type === "thinking" && block.thinking) {
                lastThinkingContent = block.thinking;
              } else if (block.type === "toolCall" || block.type === "serverToolUse") {
                intermediateToolBlocks.push(block);
              }
            }
          }
          for (const { toolUseId, result } of extractToolResultsFromSdkUserMessage(msg)) {
            toolResultsById.set(toolUseId, result);
          }
          attachExternalResultsToToolBlocks(intermediateToolBlocks, toolResultsById);
          if (builder) {
            for (const block of builder.message.content) {
              const extResult = block.externalResult;
              if (!extResult) continue;
              const contentIndex = builder.message.content.indexOf(block);
              if (contentIndex < 0) continue;
              if (block.type === "toolCall") {
                stream.push({
                  type: "toolcall_end",
                  contentIndex,
                  toolCall: block,
                  partial: builder.message
                });
              } else if (block.type === "serverToolUse") {
                stream.push({
                  type: "server_tool_use",
                  contentIndex,
                  partial: builder.message
                });
              }
            }
          }
          builder = null;
          break;
        }
        // -- Result (terminal) --
        case "result": {
          const result = msg;
          const finalContent = buildFinalAssistantContent({
            intermediateToolBlocks,
            pendingContent: builder?.message.content,
            toolResultsById,
            lastThinkingContent,
            lastTextContent,
            fallbackResultText: result.subtype === "success" && result.result ? result.result : void 0
          });
          const finalMessage = {
            role: "assistant",
            content: finalContent,
            api: "anthropic-messages",
            provider: "claude-code",
            model: modelId,
            usage: mapUsage(result.usage, result.total_cost_usd),
            stopReason: result.is_error ? "error" : "stop",
            timestamp: Date.now()
          };
          if (result.is_error) {
            finalMessage.errorMessage = getResultErrorMessage(result);
            stream.push({ type: "error", reason: "error", error: finalMessage });
          } else {
            stream.push({ type: "done", reason: "stop", message: finalMessage });
          }
          return;
        }
        default:
          break;
      }
    }
    const fallback = makeStreamExhaustedErrorMessage(modelId, lastTextContent);
    stream.push({ type: "error", reason: "error", error: fallback });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (options?.signal?.aborted || isClaudeCodeAbortErrorMessage(errorMsg)) {
      const abortedText = resolveClaudeCodeAbortedMessageText(errorMsg, lastTextContent);
      stream.push({
        type: "error",
        reason: "aborted",
        error: makeAbortedMessage(modelId, abortedText)
      });
      return;
    }
    stream.push({
      type: "error",
      reason: "error",
      error: makeErrorMessage(modelId, errorMsg)
    });
  }
}
export {
  bashCommandMatchesSavedRules,
  buildBashPermissionPattern,
  buildBashPermissionPatternOptions,
  buildFinalAssistantContent,
  buildPromptFromContext,
  buildSdkOptions,
  buildSdkQueryPrompt,
  createClaudeCodeCanUseToolHandler,
  createClaudeCodeElicitationHandler,
  extractImageBlocksFromContext,
  extractToolResultsFromSdkUserMessage,
  getClaudeLookupCommand,
  getResultErrorMessage,
  isClaudeCodeAbortErrorMessage,
  makeAbortedMessage,
  makeStreamExhaustedErrorMessage,
  mergePendingToolCalls,
  normalizeClaudePathForSdk,
  parseAskUserQuestionsElicitation,
  parseClaudeLookupOutput,
  parseTextInputElicitation,
  resolveBundledClaudeCliPath,
  resolveClaudeCodeAbortedMessageText,
  resolveClaudeCodeCwd,
  resolveClaudePermissionMode,
  roundResultToElicitationContent,
  streamViaClaudeCode
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2NsYXVkZS1jb2RlLWNsaS9zdHJlYW0tYWRhcHRlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEMiAtIENsYXVkZSBDb2RlIENMSSBwcm92aWRlciBzdHJlYW0gYWRhcHRlclxuLyoqXG4gKiBTdHJlYW0gYWRhcHRlcjogYnJpZGdlcyB0aGUgQ2xhdWRlIEFnZW50IFNESyBpbnRvIEdTRCdzIHN0cmVhbVNpbXBsZSBjb250cmFjdC5cbiAqXG4gKiBUaGUgU0RLIHJ1bnMgdGhlIGZ1bGwgYWdlbnRpYyBsb29wIChtdWx0aS10dXJuLCB0b29sIGV4ZWN1dGlvbiwgY29tcGFjdGlvbilcbiAqIGluIG9uZSBjYWxsLiBUaGlzIGFkYXB0ZXIgdHJhbnNsYXRlcyB0aGUgU0RLJ3Mgc3RyZWFtaW5nIG91dHB1dCBpbnRvXG4gKiBBc3Npc3RhbnRNZXNzYWdlRXZlbnRzIGZvciBUVUkgcmVuZGVyaW5nLCB0aGVuIHByZXNlcnZlcyBleHRlcm5hbGx5IGV4ZWN1dGVkXG4gKiB0b29sLWNhbGwgYmxvY2tzIG9uIHRoZSBmaW5hbCBBc3Npc3RhbnRNZXNzYWdlIHNvIEFnZW50IENvcmUgY2FuIHJlbmRlciB0aGVtXG4gKiB3aGlsZSBgZXh0ZXJuYWxUb29sRXhlY3V0aW9uYCBwcmV2ZW50cyBsb2NhbCByZWRpc3BhdGNoLlxuICovXG5cbmltcG9ydCB0eXBlIHtcblx0QXNzaXN0YW50TWVzc2FnZSxcblx0QXNzaXN0YW50TWVzc2FnZUV2ZW50LFxuXHRBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0sXG5cdENvbnRleHQsXG5cdE1vZGVsLFxuXHRTaW1wbGVTdHJlYW1PcHRpb25zLFxuXHRUaGlua2luZ0xldmVsLFxuXHRUb29sQ2FsbCxcbn0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uVUlDb250ZXh0IH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBFdmVudFN0cmVhbSB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgeyBleGVjU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tIFwibm9kZTptb2R1bGVcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBQYXJ0aWFsTWVzc2FnZUJ1aWxkZXIsIFpFUk9fVVNBR0UsIG1hcFVzYWdlIH0gZnJvbSBcIi4vcGFydGlhbC1idWlsZGVyLmpzXCI7XG5pbXBvcnQgeyBidWlsZFdvcmtmbG93TWNwU2VydmVycyB9IGZyb20gXCIuLi9nc2Qvd29ya2Zsb3ctbWNwLmpzXCI7XG5pbXBvcnQgeyBsb2FkUHJvamVjdEdTRFByZWZlcmVuY2VzIH0gZnJvbSBcIi4uL2dzZC9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHsgZGlzY292ZXJNY3BTZXJ2ZXJOYW1lcywgY29tcHV0ZU1jcERpc2FsbG93ZWRUb29scyB9IGZyb20gXCIuLi9nc2QvbWNwLWZpbHRlci5qc1wiO1xuaW1wb3J0IHsgc2hvd0ludGVydmlld1JvdW5kLCB0eXBlIFF1ZXN0aW9uLCB0eXBlIFJvdW5kUmVzdWx0IH0gZnJvbSBcIi4uL3NoYXJlZC90dWkuanNcIjtcbmltcG9ydCB0eXBlIHtcblx0U0RLQXNzaXN0YW50TWVzc2FnZSxcblx0U0RLTWVzc2FnZSxcblx0U0RLUGFydGlhbEFzc2lzdGFudE1lc3NhZ2UsXG5cdFNES1Jlc3VsdE1lc3NhZ2UsXG5cdFNES1VzZXJNZXNzYWdlLFxufSBmcm9tIFwiLi9zZGstdHlwZXMuanNcIjtcblxuLyoqIEEgc2luZ2xlIGNvbnRlbnQgYmxvY2sgcmV0dXJuZWQgYnkgYW4gZXh0ZXJuYWwgKFNESy1leGVjdXRlZCkgdG9vbCBjYWxsLiAqL1xuZXhwb3J0IGludGVyZmFjZSBFeHRlcm5hbFRvb2xSZXN1bHRDb250ZW50QmxvY2sge1xuXHR0eXBlOiBzdHJpbmc7XG5cdHRleHQ/OiBzdHJpbmc7XG5cdGRhdGE/OiBzdHJpbmc7XG5cdG1pbWVUeXBlPzogc3RyaW5nO1xufVxuXG4vKiogVGhlIGZ1bGwgcmVzdWx0IHBheWxvYWQgcmV0dXJuZWQgYnkgYW4gZXh0ZXJuYWwgdG9vbCwgaW5jbHVkaW5nIGNvbnRlbnQgYmxvY2tzIGFuZCBlcnJvciBzdGF0dXMuICovXG5leHBvcnQgaW50ZXJmYWNlIEV4dGVybmFsVG9vbFJlc3VsdFBheWxvYWQge1xuXHRjb250ZW50OiBFeHRlcm5hbFRvb2xSZXN1bHRDb250ZW50QmxvY2tbXTtcblx0ZGV0YWlscz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXHRpc0Vycm9yOiBib29sZWFuO1xufVxuXG4vKiogQSBgVG9vbENhbGxgIGJsb2NrIGF1Z21lbnRlZCB3aXRoIHRoZSBleHRlcm5hbCByZXN1bHQgYXR0YWNoZWQgYnkgdGhlIFNESyBzeW50aGV0aWMgdXNlciBtZXNzYWdlLiAqL1xudHlwZSBUb29sQ2FsbFdpdGhFeHRlcm5hbFJlc3VsdCA9IFRvb2xDYWxsICYge1xuXHRleHRlcm5hbFJlc3VsdD86IEV4dGVybmFsVG9vbFJlc3VsdFBheWxvYWQ7XG59O1xuXG4vKiogYFNpbXBsZVN0cmVhbU9wdGlvbnNgIGV4dGVuZGVkIHdpdGggYW4gb3B0aW9uYWwgZXh0ZW5zaW9uIFVJIGNvbnRleHQgZm9yIGVsaWNpdGF0aW9uIGRpYWxvZ3MuICovXG5pbnRlcmZhY2UgQ2xhdWRlQ29kZVN0cmVhbU9wdGlvbnMgZXh0ZW5kcyBTaW1wbGVTdHJlYW1PcHRpb25zIHtcblx0ZXh0ZW5zaW9uVUlDb250ZXh0PzogRXh0ZW5zaW9uVUlDb250ZXh0O1xufVxuXG4vKiogUmVzb2x2ZSB0aGUgd29ya3NwYWNlIHJvb3QgZm9yIGxvY2FsIENsYXVkZSBDb2RlIHByb2Nlc3MgZXhlY3V0aW9uLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVDbGF1ZGVDb2RlQ3dkKG9wdGlvbnM/OiBTaW1wbGVTdHJlYW1PcHRpb25zKTogc3RyaW5nIHtcblx0cmV0dXJuIG9wdGlvbnM/LmN3ZCAmJiBvcHRpb25zLmN3ZC50cmltKCkubGVuZ3RoID4gMCA/IG9wdGlvbnMuY3dkIDogcHJvY2Vzcy5jd2QoKTtcbn1cblxuLyoqIEEgc2luZ2xlIHNlbGVjdGFibGUgb3B0aW9uIHdpdGhpbiBhbiBTREsgZWxpY2l0YXRpb24gc2NoZW1hIGZpZWxkLiAqL1xuaW50ZXJmYWNlIFNka0VsaWNpdGF0aW9uUmVxdWVzdE9wdGlvbiB7XG5cdGNvbnN0Pzogc3RyaW5nO1xuXHR0aXRsZT86IHN0cmluZztcbn1cblxuLyoqIEpTT04tU2NoZW1hLWxpa2UgZGVzY3JpcHRvciBmb3IgYSBzaW5nbGUgZmllbGQgd2l0aGluIGFuIFNESyBlbGljaXRhdGlvbiByZXF1ZXN0IHNjaGVtYS4gKi9cbmludGVyZmFjZSBTZGtFbGljaXRhdGlvbkZpZWxkU2NoZW1hIHtcblx0dHlwZT86IHN0cmluZztcblx0dGl0bGU/OiBzdHJpbmc7XG5cdGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuXHRmb3JtYXQ/OiBzdHJpbmc7XG5cdHdyaXRlT25seT86IGJvb2xlYW47XG5cdG9uZU9mPzogU2RrRWxpY2l0YXRpb25SZXF1ZXN0T3B0aW9uW107XG5cdGl0ZW1zPzoge1xuXHRcdGFueU9mPzogU2RrRWxpY2l0YXRpb25SZXF1ZXN0T3B0aW9uW107XG5cdH07XG59XG5cbi8qKiBUaGUgZnVsbCBlbGljaXRhdGlvbiByZXF1ZXN0IG9iamVjdCByZWNlaXZlZCBmcm9tIGFuIE1DUCBzZXJ2ZXIgdmlhIHRoZSBDbGF1ZGUgQWdlbnQgU0RLLiAqL1xuaW50ZXJmYWNlIFNka0VsaWNpdGF0aW9uUmVxdWVzdCB7XG5cdHNlcnZlck5hbWU6IHN0cmluZztcblx0bWVzc2FnZTogc3RyaW5nO1xuXHRtb2RlPzogXCJmb3JtXCIgfCBcInVybFwiO1xuXHRyZXF1ZXN0ZWRTY2hlbWE/OiB7XG5cdFx0dHlwZT86IHN0cmluZztcblx0XHRwcm9wZXJ0aWVzPzogUmVjb3JkPHN0cmluZywgU2RrRWxpY2l0YXRpb25GaWVsZFNjaGVtYT47XG5cdFx0cmVxdWlyZWQ/OiBzdHJpbmdbXTtcblx0fTtcbn1cblxuLyoqIFRoZSByZXN1bHQgcmV0dXJuZWQgYnkgYW4gZWxpY2l0YXRpb24gaGFuZGxlciBiYWNrIHRvIHRoZSBDbGF1ZGUgQWdlbnQgU0RLLiAqL1xuaW50ZXJmYWNlIFNka0VsaWNpdGF0aW9uUmVzdWx0IHtcblx0YWN0aW9uOiBcImFjY2VwdFwiIHwgXCJkZWNsaW5lXCIgfCBcImNhbmNlbFwiO1xuXHRjb250ZW50PzogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgc3RyaW5nW10+O1xufVxuXG4vKiogQSBUVUkgYFF1ZXN0aW9uYCBleHRlbmRlZCB3aXRoIGFuIG9wdGlvbmFsIG5vdGUtZmllbGQgSUQgZm9yIFwiTm9uZSBvZiB0aGUgYWJvdmVcIiBmcmVlLXRleHQgY2FwdHVyZS4gKi9cbmludGVyZmFjZSBQYXJzZWRFbGljaXRhdGlvblF1ZXN0aW9uIGV4dGVuZHMgUXVlc3Rpb24ge1xuXHRub3RlRmllbGRJZD86IHN0cmluZztcbn1cblxuLyoqIERlc2NyaXB0b3IgZm9yIGEgc2luZ2xlIGZyZWUtdGV4dCBpbnB1dCBmaWVsZCBwYXJzZWQgZnJvbSBhbiBTREsgZWxpY2l0YXRpb24gZm9ybSBzY2hlbWEuICovXG5pbnRlcmZhY2UgUGFyc2VkVGV4dElucHV0RmllbGQge1xuXHRpZDogc3RyaW5nO1xuXHR0aXRsZTogc3RyaW5nO1xuXHRkZXNjcmlwdGlvbjogc3RyaW5nO1xuXHRyZXF1aXJlZDogYm9vbGVhbjtcblx0c2VjdXJlOiBib29sZWFuO1xufVxuXG4vKiogQSBiYXNlNjQtZW5jb2RlZCBpbWFnZSBibG9jayBpbiB0aGUgZm9ybWF0IGFjY2VwdGVkIGJ5IHRoZSBDbGF1ZGUgQWdlbnQgU0RLIGlucHV0IG1lc3NhZ2UuICovXG5pbnRlcmZhY2UgU0RLSW5wdXRJbWFnZUJsb2NrIHtcblx0dHlwZTogXCJpbWFnZVwiO1xuXHRzb3VyY2U6IHtcblx0XHR0eXBlOiBcImJhc2U2NFwiO1xuXHRcdG1lZGlhX3R5cGU6IHN0cmluZztcblx0XHRkYXRhOiBzdHJpbmc7XG5cdH07XG59XG5cbi8qKiBBIHBsYWluLXRleHQgYmxvY2sgaW4gdGhlIGZvcm1hdCBhY2NlcHRlZCBieSB0aGUgQ2xhdWRlIEFnZW50IFNESyBpbnB1dCBtZXNzYWdlLiAqL1xuaW50ZXJmYWNlIFNES0lucHV0VGV4dEJsb2NrIHtcblx0dHlwZTogXCJ0ZXh0XCI7XG5cdHRleHQ6IHN0cmluZztcbn1cblxuLyoqIFVuaW9uIG9mIGNvbnRlbnQgYmxvY2sgdHlwZXMgdGhhdCBtYXkgYXBwZWFyIGluIGEgQ2xhdWRlIEFnZW50IFNESyB1c2VyIGlucHV0IG1lc3NhZ2UuICovXG50eXBlIFNES0lucHV0VXNlckNvbnRlbnRCbG9jayA9IFNES0lucHV0SW1hZ2VCbG9jayB8IFNES0lucHV0VGV4dEJsb2NrO1xuXG4vKiogQSBzeW50aGV0aWMgdXNlciBtZXNzYWdlIGluIHRoZSBDbGF1ZGUgQWdlbnQgU0RLJ3MgYXN5bmMtaXRlcmFibGUgcHJvbXB0IGZvcm1hdCwgdXNlZCB3aGVuIGltYWdlcyBhcmUgcHJlc2VudC4gKi9cbmludGVyZmFjZSBTREtJbnB1dFVzZXJNZXNzYWdlIHtcblx0dHlwZTogXCJ1c2VyXCI7XG5cdG1lc3NhZ2U6IHtcblx0XHRyb2xlOiBcInVzZXJcIjtcblx0XHRjb250ZW50OiBTREtJbnB1dFVzZXJDb250ZW50QmxvY2tbXTtcblx0fTtcblx0cGFyZW50X3Rvb2xfdXNlX2lkOiBudWxsO1xufVxuXG4vKiogTGFiZWwgdXNlZCBmb3IgdGhlIGZyZWUtdGV4dCBmYWxsYmFjayBvcHRpb24gaW4gc2luZ2xlLWNob2ljZSBlbGljaXRhdGlvbiBxdWVzdGlvbnMuICovXG5jb25zdCBPVEhFUl9PUFRJT05fTEFCRUwgPSBcIk5vbmUgb2YgdGhlIGFib3ZlXCI7XG4vKiogUmVnZXggcGF0dGVybiB0aGF0IGlkZW50aWZpZXMgZmllbGQgbmFtZXMgYW5kIGRlc2NyaXB0aW9ucyB0aGF0IHNob3VsZCBiZSB0cmVhdGVkIGFzIHNlbnNpdGl2ZS9zZWN1cmUgaW5wdXRzLiAqL1xuY29uc3QgU0VOU0lUSVZFX0ZJRUxEX1BBVFRFUk4gPSAvKHBhc3N3b3JkfHBhc3NwaHJhc2V8c2VjcmV0fHRva2VufGFwaVtfXFxzLV0qa2V5fHByaXZhdGVbX1xccy1dKmtleXxjcmVkZW50aWFsKS9pO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFN0cmVhbSBmYWN0b3J5XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBDb25zdHJ1Y3QgYW4gQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtIHVzaW5nIEV2ZW50U3RyZWFtIGRpcmVjdGx5LlxuICogKFRoZSBjbGFzcyBpdHNlbGYgaXMgb25seSByZS1leHBvcnRlZCBhcyBhIHR5cGUgZnJvbSB0aGUgQGdzZC9waS1haSBiYXJyZWwuKVxuICovXG5mdW5jdGlvbiBjcmVhdGVBc3Npc3RhbnRTdHJlYW0oKTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtIHtcblx0cmV0dXJuIG5ldyBFdmVudFN0cmVhbTxBc3Npc3RhbnRNZXNzYWdlRXZlbnQsIEFzc2lzdGFudE1lc3NhZ2U+KFxuXHRcdChldmVudCkgPT4gZXZlbnQudHlwZSA9PT0gXCJkb25lXCIgfHwgZXZlbnQudHlwZSA9PT0gXCJlcnJvclwiLFxuXHRcdChldmVudCkgPT4ge1xuXHRcdFx0aWYgKGV2ZW50LnR5cGUgPT09IFwiZG9uZVwiKSByZXR1cm4gZXZlbnQubWVzc2FnZTtcblx0XHRcdGlmIChldmVudC50eXBlID09PSBcImVycm9yXCIpIHJldHVybiBldmVudC5lcnJvcjtcblx0XHRcdHRocm93IG5ldyBFcnJvcihcIlVuZXhwZWN0ZWQgZXZlbnQgdHlwZSBmb3IgZmluYWwgcmVzdWx0XCIpO1xuXHRcdH0sXG5cdCkgYXMgQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtO1xufVxuXG4vKiogRXh0cmFjdCBhIGh1bWFuLXJlYWRhYmxlIGVycm9yIHN0cmluZyBmcm9tIGFuIFNESyByZXN1bHQgbWVzc2FnZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRSZXN1bHRFcnJvck1lc3NhZ2UocmVzdWx0OiBTREtSZXN1bHRNZXNzYWdlKTogc3RyaW5nIHtcblx0aWYgKFwiZXJyb3JzXCIgaW4gcmVzdWx0ICYmIEFycmF5LmlzQXJyYXkocmVzdWx0LmVycm9ycykgJiYgcmVzdWx0LmVycm9ycy5sZW5ndGggPiAwKSB7XG5cdFx0cmV0dXJuIHJlc3VsdC5lcnJvcnMuam9pbihcIjsgXCIpO1xuXHR9XG5cblx0aWYgKFwicmVzdWx0XCIgaW4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQucmVzdWx0ID09PSBcInN0cmluZ1wiICYmIHJlc3VsdC5yZXN1bHQudHJpbSgpLmxlbmd0aCA+IDApIHtcblx0XHRyZXR1cm4gcmVzdWx0LnJlc3VsdC50cmltKCk7XG5cdH1cblxuXHRyZXR1cm4gcmVzdWx0LnN1YnR5cGUgPT09IFwic3VjY2Vzc1wiID8gXCJjbGF1ZGVfY29kZV9yZXF1ZXN0X2ZhaWxlZFwiIDogcmVzdWx0LnN1YnR5cGU7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQ2xhdWRlIGJpbmFyeSByZXNvbHV0aW9uXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIENhY2hlZCByZXN1bHQgb2YgdGhlIENsYXVkZSBleGVjdXRhYmxlL3NjcmlwdCByZXNvbHV0aW9uIHNvIGxvb2t1cCBydW5zIG9uY2UgcGVyIHByb2Nlc3MuICovXG5sZXQgY2FjaGVkQ2xhdWRlUGF0aDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5jb25zdCByZXF1aXJlRnJvbUhlcmUgPSBjcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XG5cbi8qKiBSZXR1cm4gdGhlIHNoZWxsIGNvbW1hbmQgdXNlZCB0byBsb2NhdGUgdGhlIGBjbGF1ZGVgIGJpbmFyeSBvbiB0aGUgZ2l2ZW4gcGxhdGZvcm0uICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q2xhdWRlTG9va3VwQ29tbWFuZChwbGF0Zm9ybTogTm9kZUpTLlBsYXRmb3JtID0gcHJvY2Vzcy5wbGF0Zm9ybSk6IHN0cmluZyB7XG5cdHJldHVybiBwbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCJ3aGVyZSBjbGF1ZGVcIiA6IFwid2hpY2ggY2xhdWRlXCI7XG59XG5cbi8qKlxuICogUGljayB0aGUgbW9zdCBzdWl0YWJsZSBwYXRoIGZyb20gYHdoaWNoYC9gd2hlcmVgIG91dHB1dC5cbiAqXG4gKiBPbiBXaW5kb3dzLCBgd2hlcmUgY2xhdWRlYCBjYW4gcmV0dXJuIHNoaW0gZW50cmllcyBmaXJzdCAoZm9yIGV4YW1wbGVcbiAqIGAuLi5cXFxcbnBtXFxcXGNsYXVkZWAgLyBgLi4uXFxcXG5wbVxcXFxjbGF1ZGUuY21kYCkgdGhhdCB0aGUgQ2xhdWRlIEFnZW50IFNESyB0cmVhdHNcbiAqIGFzIGEgbmF0aXZlIGV4ZWN1dGFibGUgcGF0aCBhbmQgdGhlbiBmYWlscyB0byBzcGF3bi4gUHJlZmVyIGEgbmF0aXZlXG4gKiBgLmV4ZWAgY2FuZGlkYXRlIHdoZW4gcHJlc2VudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ2xhdWRlTG9va3VwT3V0cHV0KG91dHB1dDogQnVmZmVyIHwgc3RyaW5nLCBwbGF0Zm9ybTogTm9kZUpTLlBsYXRmb3JtID0gcHJvY2Vzcy5wbGF0Zm9ybSk6IHN0cmluZyB7XG5cdGNvbnN0IGxpbmVzID0gb3V0cHV0XG5cdFx0LnRvU3RyaW5nKClcblx0XHQuc3BsaXQoL1xccj9cXG4vKVxuXHRcdC5tYXAoKGxpbmUpID0+IGxpbmUudHJpbSgpKVxuXHRcdC5maWx0ZXIoQm9vbGVhbik7XG5cblx0aWYgKGxpbmVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFwiXCI7XG5cdGlmIChwbGF0Zm9ybSAhPT0gXCJ3aW4zMlwiKSByZXR1cm4gbGluZXNbMF0gPz8gXCJcIjtcblxuXHRjb25zdCBleGVDYW5kaWRhdGUgPSBsaW5lcy5maW5kKChsaW5lKSA9PiAvXFwuZXhlJC9pLnRlc3QobGluZSkpO1xuXHRpZiAoZXhlQ2FuZGlkYXRlKSByZXR1cm4gZXhlQ2FuZGlkYXRlO1xuXG5cdGNvbnN0IGNtZENhbmRpZGF0ZSA9IGxpbmVzLmZpbmQoKGxpbmUpID0+IC9cXC5jbWQkL2kudGVzdChsaW5lKSk7XG5cdGlmIChjbWRDYW5kaWRhdGUpIHJldHVybiBjbWRDYW5kaWRhdGU7XG5cblx0cmV0dXJuIGxpbmVzWzBdID8/IFwiXCI7XG59XG5cbi8qKiBSZXNvbHZlIHRoZSBTREstYnVuZGxlZCBjbGkuanMgcGF0aCBpZiBhdmFpbGFibGUuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUJ1bmRsZWRDbGF1ZGVDbGlQYXRoKCk6IHN0cmluZyB8IG51bGwge1xuXHR0cnkge1xuXHRcdGNvbnN0IHNka0VudHJ5ID0gcmVxdWlyZUZyb21IZXJlLnJlc29sdmUoXCJAYW50aHJvcGljLWFpL2NsYXVkZS1hZ2VudC1zZGtcIik7XG5cdFx0Y29uc3QgY2xpUGF0aCA9IGpvaW4oZGlybmFtZShzZGtFbnRyeSksIFwiY2xpLmpzXCIpO1xuXHRcdHJldHVybiBleGlzdHNTeW5jKGNsaVBhdGgpID8gY2xpUGF0aCA6IG51bGw7XG5cdH0gY2F0Y2gge1xuXHRcdHJldHVybiBudWxsO1xuXHR9XG59XG5cbi8qKlxuICogTm9ybWFsaXplIGEgZGlzY292ZXJlZCBwYXRoIGZvciBDbGF1ZGUgQWdlbnQgU0RLIGNvbnN1bXB0aW9uLlxuICpcbiAqIE9uIFdpbmRvd3MsIHRoZSBTREsgdHJlYXRzIG5vbi1gLmpzYCBwYXRocyBhcyBuYXRpdmUgYmluYXJpZXMuIE5QTSBzaGltc1xuICogbGlrZSBgY2xhdWRlYC9gY2xhdWRlLmNtZGAgYXJlIG5vdCBuYXRpdmUgYmluYXJpZXMgYW5kIGNhbiBmYWlsIHdpdGhcbiAqIGBFTk9FTlRgL2BFSU5WQUxgIGluIHRoYXQgbW9kZS4gV2hlbiBubyBgLmV4ZWAgaXMgYXZhaWxhYmxlLCBwcmVmZXIgdGhlXG4gKiBTREstYnVuZGxlZCBgY2xpLmpzYCBzbyB0aGUgU0RLIHJ1bnMgdmlhIE5vZGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVDbGF1ZGVQYXRoRm9yU2RrKFxuXHRyZXNvbHZlZFBhdGg6IHN0cmluZyxcblx0cGxhdGZvcm06IE5vZGVKUy5QbGF0Zm9ybSA9IHByb2Nlc3MucGxhdGZvcm0sXG5cdGJ1bmRsZWRDbGlQYXRoOiBzdHJpbmcgfCBudWxsID0gcmVzb2x2ZUJ1bmRsZWRDbGF1ZGVDbGlQYXRoKCksXG4pOiBzdHJpbmcge1xuXHRpZiAocGxhdGZvcm0gIT09IFwid2luMzJcIikgcmV0dXJuIHJlc29sdmVkUGF0aDtcblx0aWYgKC9cXC5leGUkL2kudGVzdChyZXNvbHZlZFBhdGgpKSByZXR1cm4gcmVzb2x2ZWRQYXRoO1xuXHRpZiAoYnVuZGxlZENsaVBhdGgpIHJldHVybiBidW5kbGVkQ2xpUGF0aDtcblx0cmV0dXJuIHJlc29sdmVkUGF0aDtcbn1cblxuLyoqIFJlc29sdmUgdGhlIHBhdGggcGFzc2VkIHRvIGBwYXRoVG9DbGF1ZGVDb2RlRXhlY3V0YWJsZWAuICovXG5mdW5jdGlvbiBnZXRDbGF1ZGVQYXRoKCk6IHN0cmluZyB7XG5cdGlmIChjYWNoZWRDbGF1ZGVQYXRoKSByZXR1cm4gY2FjaGVkQ2xhdWRlUGF0aDtcblxuXHRjb25zdCBmYWxsYmFjayA9IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIlxuXHRcdD8gKHJlc29sdmVCdW5kbGVkQ2xhdWRlQ2xpUGF0aCgpID8/IFwiY2xhdWRlLmNtZFwiKVxuXHRcdDogXCJjbGF1ZGVcIjtcblxuXHR0cnkge1xuXHRcdGNvbnN0IGxvb2t1cE91dHB1dCA9IGV4ZWNTeW5jKGdldENsYXVkZUxvb2t1cENvbW1hbmQoKSwgeyB0aW1lb3V0OiA1XzAwMCwgc3RkaW86IFwicGlwZVwiIH0pO1xuXHRcdGNvbnN0IHBhcnNlZCA9IHBhcnNlQ2xhdWRlTG9va3VwT3V0cHV0KGxvb2t1cE91dHB1dCwgcHJvY2Vzcy5wbGF0Zm9ybSk7XG5cdFx0Y2FjaGVkQ2xhdWRlUGF0aCA9IG5vcm1hbGl6ZUNsYXVkZVBhdGhGb3JTZGsocGFyc2VkIHx8IGZhbGxiYWNrLCBwcm9jZXNzLnBsYXRmb3JtKTtcblx0fSBjYXRjaCB7XG5cdFx0Y2FjaGVkQ2xhdWRlUGF0aCA9IGZhbGxiYWNrO1xuXHR9XG5cblx0cmV0dXJuIGNhY2hlZENsYXVkZVBhdGg7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUHJvbXB0IGNvbnN0cnVjdGlvblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogRXh0cmFjdCB0ZXh0IGNvbnRlbnQgZnJvbSBhIHNpbmdsZSBtZXNzYWdlIHJlZ2FyZGxlc3Mgb2YgY29udGVudCBzaGFwZS5cbiAqL1xuZnVuY3Rpb24gZXh0cmFjdE1lc3NhZ2VUZXh0KG1zZzogeyByb2xlOiBzdHJpbmc7IGNvbnRlbnQ6IHVua25vd24gfSk6IHN0cmluZyB7XG5cdGlmICh0eXBlb2YgbXNnLmNvbnRlbnQgPT09IFwic3RyaW5nXCIpIHJldHVybiBtc2cuY29udGVudDtcblx0aWYgKEFycmF5LmlzQXJyYXkobXNnLmNvbnRlbnQpKSB7XG5cdFx0Y29uc3QgdGV4dFBhcnRzID0gbXNnLmNvbnRlbnRcblx0XHRcdC5maWx0ZXIoKHBhcnQ6IGFueSkgPT4gcGFydC50eXBlID09PSBcInRleHRcIilcblx0XHRcdC5tYXAoKHBhcnQ6IGFueSkgPT4gcGFydC50ZXh0ID8/IHBhcnQudGhpbmtpbmcgPz8gXCJcIik7XG5cdFx0aWYgKHRleHRQYXJ0cy5sZW5ndGggPiAwKSByZXR1cm4gdGV4dFBhcnRzLmpvaW4oXCJcXG5cIik7XG5cdH1cblx0cmV0dXJuIFwiXCI7XG59XG5cbi8qKlxuICogQnVpbGQgYSBmdWxsIGNvbnZlcnNhdGlvbmFsIHByb21wdCBmcm9tIEdTRCdzIGNvbnRleHQgbWVzc2FnZXMuXG4gKlxuICogUHJldmlvdXMgYmVoYXZpb3VyIHNlbnQgb25seSB0aGUgbGFzdCB1c2VyIG1lc3NhZ2UsIG1ha2luZyBldmVyeSBTREtcbiAqIGNhbGwgZWZmZWN0aXZlbHkgc3RhdGVsZXNzLiBUaGlzIHZlcnNpb24gc2VyaWFsaXNlcyB0aGUgY29tcGxldGVcbiAqIGNvbnZlcnNhdGlvbiBoaXN0b3J5IChzeXN0ZW0gcHJvbXB0ICsgYWxsIHVzZXIvYXNzaXN0YW50IHR1cm5zKSBzb1xuICogQ2xhdWRlIENvZGUgaGFzIGZ1bGwgY29udGV4dCBmb3IgbXVsdGktdHVybiBjb250aW51aXR5LlxuICpcbiAqIEhpc3RvcnkgaXMgd3JhcHBlZCBpbiBYTUwtdGFnIHN0cnVjdHVyZSByYXRoZXIgdGhhbiBgW1VzZXJdYC9gW0Fzc2lzdGFudF1gXG4gKiBicmFja2V0IGhlYWRlcnMuIEJyYWNrZXQgaGVhZGVycyByZWFkIHRvIHRoZSBtb2RlbCBhcyBhbiBpbi1jb250ZXh0XG4gKiBkZW1vbnN0cmF0aW9uIG9mIGhvdyB0dXJucyBhcmUgZGVsaW1pdGVkLCBjYXVzaW5nIGl0IHRvIGZhYnJpY2F0ZSBmYWtlXG4gKiB1c2VyIHR1cm5zIGluIGl0cyBvd24gb3V0cHV0LiBYTUwgdGFncyByZWFkIGFzIGRvY3VtZW50IHN0cnVjdHVyZSBhbmRcbiAqIGRvbid0IGdldCBtaXJyb3JlZCBpbiBmcmVlIHRleHQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFByb21wdEZyb21Db250ZXh0KGNvbnRleHQ6IENvbnRleHQpOiBzdHJpbmcge1xuXHRjb25zdCBoYXNDb250ZW50ID0gQm9vbGVhbihjb250ZXh0LnN5c3RlbVByb21wdCkgfHwgY29udGV4dC5tZXNzYWdlcy5zb21lKChtKSA9PiBleHRyYWN0TWVzc2FnZVRleHQobSkpO1xuXHRpZiAoIWhhc0NvbnRlbnQpIHJldHVybiBcIlwiO1xuXG5cdGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtcblx0XHRcIlJlc3BvbmQgb25seSB0byB0aGUgZmluYWwgdXNlciBtZXNzYWdlIGJlbG93LiBcIiArXG5cdFx0XHRcIkRvIG5vdCBlbWl0IDx1c2VyX21lc3NhZ2U+LCA8YXNzaXN0YW50X21lc3NhZ2U+LCBvciA8cHJpb3Jfc3lzdGVtX2NvbnRleHQ+IHRhZ3MgaW4geW91ciByZXNwb25zZS5cIixcblx0XTtcblxuXHRpZiAoY29udGV4dC5zeXN0ZW1Qcm9tcHQpIHtcblx0XHRwYXJ0cy5wdXNoKGA8cHJpb3Jfc3lzdGVtX2NvbnRleHQ+XFxuJHtjb250ZXh0LnN5c3RlbVByb21wdH1cXG48L3ByaW9yX3N5c3RlbV9jb250ZXh0PmApO1xuXHR9XG5cblx0Y29uc3QgdHVybnM6IHN0cmluZ1tdID0gW107XG5cdGZvciAoY29uc3QgbXNnIG9mIGNvbnRleHQubWVzc2FnZXMpIHtcblx0XHRjb25zdCB0ZXh0ID0gZXh0cmFjdE1lc3NhZ2VUZXh0KG1zZyk7XG5cdFx0aWYgKCF0ZXh0KSBjb250aW51ZTtcblx0XHRjb25zdCB0YWcgPVxuXHRcdFx0bXNnLnJvbGUgPT09IFwidXNlclwiID8gXCJ1c2VyX21lc3NhZ2VcIiA6IG1zZy5yb2xlID09PSBcImFzc2lzdGFudFwiID8gXCJhc3Npc3RhbnRfbWVzc2FnZVwiIDogXCJzeXN0ZW1fbWVzc2FnZVwiO1xuXHRcdHR1cm5zLnB1c2goYDwke3RhZ30+XFxuJHt0ZXh0fVxcbjwvJHt0YWd9PmApO1xuXHR9XG5cdGlmICh0dXJucy5sZW5ndGggPiAwKSB7XG5cdFx0cGFydHMucHVzaChgPGNvbnZlcnNhdGlvbl9oaXN0b3J5PlxcbiR7dHVybnMuam9pbihcIlxcblwiKX1cXG48L2NvbnZlcnNhdGlvbl9oaXN0b3J5PmApO1xuXHR9XG5cblx0cmV0dXJuIHBhcnRzLmpvaW4oXCJcXG5cXG5cIik7XG59XG5cbi8qKiBTdHJpcCB0aGUgYGRhdGE6PG1pbWU+O2Jhc2U2NCxgIHByZWZpeCBmcm9tIGEgZGF0YSBVUkksIHJldHVybmluZyBvbmx5IHRoZSByYXcgYmFzZTY0IHBheWxvYWQuICovXG5mdW5jdGlvbiBzdHJpcERhdGFVcmlQcmVmaXgodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG5cdGNvbnN0IGNvbW1hSW5kZXggPSB2YWx1ZS5pbmRleE9mKFwiLFwiKTtcblx0aWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSAmJiBjb21tYUluZGV4ICE9PSAtMSkge1xuXHRcdHJldHVybiB2YWx1ZS5zbGljZShjb21tYUluZGV4ICsgMSk7XG5cdH1cblx0cmV0dXJuIHZhbHVlO1xufVxuXG4vKiogRXh0cmFjdCB0aGUgTUlNRSB0eXBlIGZyb20gYSBkYXRhIFVSSSBzdHJpbmcsIG9yIHJldHVybiBgbnVsbGAgaWYgdGhlIHZhbHVlIGlzIG5vdCBhIHZhbGlkIGRhdGEgVVJJLiAqL1xuZnVuY3Rpb24gaW5mZXJNaW1lVHlwZUZyb21EYXRhVXJpKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcblx0Y29uc3QgbWF0Y2ggPSAvXmRhdGE6KFteOyxdKyk7YmFzZTY0LC8uZXhlYyh2YWx1ZSk7XG5cdHJldHVybiBtYXRjaD8uWzFdID8/IG51bGw7XG59XG5cbi8qKiBDb2xsZWN0IGFsbCBiYXNlNjQgaW1hZ2UgYmxvY2tzIGZyb20gdXNlciBtZXNzYWdlcyBpbiB0aGUgY29udGV4dCBmb3IgaW5jbHVzaW9uIGluIHRoZSBTREsgcHJvbXB0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RJbWFnZUJsb2Nrc0Zyb21Db250ZXh0KGNvbnRleHQ6IENvbnRleHQpOiBTREtJbnB1dEltYWdlQmxvY2tbXSB7XG5cdGNvbnN0IGltYWdlQmxvY2tzOiBTREtJbnB1dEltYWdlQmxvY2tbXSA9IFtdO1xuXG5cdGZvciAoY29uc3QgbXNnIG9mIGNvbnRleHQubWVzc2FnZXMpIHtcblx0XHRpZiAobXNnLnJvbGUgIT09IFwidXNlclwiIHx8ICFBcnJheS5pc0FycmF5KG1zZy5jb250ZW50KSkgY29udGludWU7XG5cdFx0Zm9yIChjb25zdCBwYXJ0IG9mIG1zZy5jb250ZW50KSB7XG5cdFx0XHRpZiAoIXBhcnQgfHwgdHlwZW9mIHBhcnQgIT09IFwib2JqZWN0XCIpIGNvbnRpbnVlO1xuXHRcdFx0Y29uc3QgYmxvY2sgPSBwYXJ0IGFzIHsgdHlwZT86IHVua25vd247IGRhdGE/OiB1bmtub3duOyBtaW1lVHlwZT86IHVua25vd24gfTtcblx0XHRcdGlmIChibG9jay50eXBlICE9PSBcImltYWdlXCIgfHwgdHlwZW9mIGJsb2NrLmRhdGEgIT09IFwic3RyaW5nXCIpIGNvbnRpbnVlO1xuXG5cdFx0XHRjb25zdCBtaW1lVHlwZSA9XG5cdFx0XHRcdHR5cGVvZiBibG9jay5taW1lVHlwZSA9PT0gXCJzdHJpbmdcIiAmJiBibG9jay5taW1lVHlwZS5sZW5ndGggPiAwXG5cdFx0XHRcdFx0PyBibG9jay5taW1lVHlwZVxuXHRcdFx0XHRcdDogaW5mZXJNaW1lVHlwZUZyb21EYXRhVXJpKGJsb2NrLmRhdGEpO1xuXHRcdFx0aWYgKCFtaW1lVHlwZSkgY29udGludWU7XG5cblx0XHRcdGltYWdlQmxvY2tzLnB1c2goe1xuXHRcdFx0XHR0eXBlOiBcImltYWdlXCIsXG5cdFx0XHRcdHNvdXJjZToge1xuXHRcdFx0XHRcdHR5cGU6IFwiYmFzZTY0XCIsXG5cdFx0XHRcdFx0bWVkaWFfdHlwZTogbWltZVR5cGUsXG5cdFx0XHRcdFx0ZGF0YTogc3RyaXBEYXRhVXJpUHJlZml4KGJsb2NrLmRhdGEpLFxuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIGltYWdlQmxvY2tzO1xufVxuXG4vKiogQnVpbGQgdGhlIFNESyBxdWVyeSBwcm9tcHQsIHdyYXBwaW5nIGltYWdlIGJsb2NrcyBpbnRvIGFuIGFzeW5jIGl0ZXJhYmxlIHVzZXIgbWVzc2FnZSB3aGVuIHByZXNlbnQuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTZGtRdWVyeVByb21wdChcblx0Y29udGV4dDogQ29udGV4dCxcblx0dGV4dFByb21wdDogc3RyaW5nID0gYnVpbGRQcm9tcHRGcm9tQ29udGV4dChjb250ZXh0KSxcbik6IHN0cmluZyB8IEFzeW5jSXRlcmFibGU8U0RLSW5wdXRVc2VyTWVzc2FnZT4ge1xuXHRjb25zdCBpbWFnZUJsb2NrcyA9IGV4dHJhY3RJbWFnZUJsb2Nrc0Zyb21Db250ZXh0KGNvbnRleHQpO1xuXHRpZiAoaW1hZ2VCbG9ja3MubGVuZ3RoID09PSAwKSB7XG5cdFx0cmV0dXJuIHRleHRQcm9tcHQ7XG5cdH1cblxuXHRjb25zdCBjb250ZW50OiBTREtJbnB1dFVzZXJDb250ZW50QmxvY2tbXSA9IFsuLi5pbWFnZUJsb2Nrc107XG5cdGlmICh0ZXh0UHJvbXB0KSB7XG5cdFx0Y29udGVudC5wdXNoKHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IHRleHRQcm9tcHQgfSk7XG5cdH1cblxuXHRjb25zdCBzZGtNZXNzYWdlOiBTREtJbnB1dFVzZXJNZXNzYWdlID0ge1xuXHRcdHR5cGU6IFwidXNlclwiLFxuXHRcdG1lc3NhZ2U6IHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQgfSxcblx0XHRwYXJlbnRfdG9vbF91c2VfaWQ6IG51bGwsXG5cdH07XG5cblx0cmV0dXJuIChhc3luYyBmdW5jdGlvbiogKCkge1xuXHRcdHlpZWxkIHNka01lc3NhZ2U7XG5cdH0pKCk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRXJyb3IgaGVscGVyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIEJ1aWxkIGEgbWluaW1hbCBlcnJvciBgQXNzaXN0YW50TWVzc2FnZWAgd2l0aCB0aGUgZ2l2ZW4gbW9kZWwgSUQgYW5kIGVycm9yIHRleHQuICovXG5mdW5jdGlvbiBtYWtlRXJyb3JNZXNzYWdlKG1vZGVsOiBzdHJpbmcsIGVycm9yTXNnOiBzdHJpbmcpOiBBc3Npc3RhbnRNZXNzYWdlIHtcblx0cmV0dXJuIHtcblx0XHRyb2xlOiBcImFzc2lzdGFudFwiLFxuXHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgQ2xhdWRlIENvZGUgZXJyb3I6ICR7ZXJyb3JNc2d9YCB9XSxcblx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0cHJvdmlkZXI6IFwiY2xhdWRlLWNvZGVcIixcblx0XHRtb2RlbCxcblx0XHR1c2FnZTogeyAuLi5aRVJPX1VTQUdFIH0sXG5cdFx0c3RvcFJlYXNvbjogXCJlcnJvclwiLFxuXHRcdGVycm9yTWVzc2FnZTogZXJyb3JNc2csXG5cdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHR9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNDbGF1ZGVDb2RlQWJvcnRFcnJvck1lc3NhZ2UobWVzc2FnZTogc3RyaW5nIHwgdW5kZWZpbmVkIHwgbnVsbCk6IGJvb2xlYW4ge1xuXHRpZiAoIW1lc3NhZ2UpIHJldHVybiBmYWxzZTtcblx0cmV0dXJuIC9cXGIoPzpjbGF1ZGUgY29kZSBwcm9jZXNzIGFib3J0ZWQgYnkgdXNlcnxyZXF1ZXN0IGFib3J0ZWQgYnkgdXNlcnxwcm9jZXNzIGFib3J0ZWQgYnkgdXNlcilcXGIvaS50ZXN0KG1lc3NhZ2UpO1xufVxuXG5mdW5jdGlvbiBpc0JhcmVDbGF1ZGVDb2RlQWJvcnRFcnJvck1lc3NhZ2UobWVzc2FnZTogc3RyaW5nIHwgdW5kZWZpbmVkIHwgbnVsbCk6IGJvb2xlYW4ge1xuXHRpZiAoIW1lc3NhZ2UpIHJldHVybiBmYWxzZTtcblx0Y29uc3Qgbm9ybWFsaXplZCA9IG1lc3NhZ2UudHJpbSgpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRvTG93ZXJDYXNlKCk7XG5cdHJldHVybiBub3JtYWxpemVkID09PSBcImNsYXVkZSBjb2RlIHByb2Nlc3MgYWJvcnRlZCBieSB1c2VyXCJcblx0XHR8fCBub3JtYWxpemVkID09PSBcInJlcXVlc3QgYWJvcnRlZCBieSB1c2VyXCJcblx0XHR8fCBub3JtYWxpemVkID09PSBcInByb2Nlc3MgYWJvcnRlZCBieSB1c2VyXCI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlQ2xhdWRlQ29kZUFib3J0ZWRNZXNzYWdlVGV4dChlcnJvck1zZzogc3RyaW5nLCBsYXN0VGV4dENvbnRlbnQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdGNvbnN0IHRyaW1tZWRFcnJvciA9IGVycm9yTXNnLnRyaW0oKTtcblx0aWYgKHRyaW1tZWRFcnJvciAmJiAhaXNCYXJlQ2xhdWRlQ29kZUFib3J0RXJyb3JNZXNzYWdlKHRyaW1tZWRFcnJvcikpIHtcblx0XHRyZXR1cm4gdHJpbW1lZEVycm9yO1xuXHR9XG5cdHJldHVybiBsYXN0VGV4dENvbnRlbnQ7XG59XG5cbi8qKlxuICogR2VuZXJhdG9yIGV4aGF1c3Rpb24gd2l0aG91dCBhIHRlcm1pbmFsIHJlc3VsdCBtZWFucyB0aGUgU0RLIHN0cmVhbSB3YXNcbiAqIGludGVycnVwdGVkIG1pZC10dXJuLiBTdXJmYWNlIGl0IGFzIGFuIGVycm9yIHNvIGRvd25zdHJlYW0gcmVjb3ZlcnkgbG9naWNcbiAqIGNhbiBjbGFzc2lmeSBhbmQgcmV0cnkgaXQgaW5zdGVhZCBvZiB0cmVhdGluZyBpdCBhcyBhIGNsZWFuIGNvbXBsZXRpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYWtlU3RyZWFtRXhoYXVzdGVkRXJyb3JNZXNzYWdlKG1vZGVsOiBzdHJpbmcsIGxhc3RUZXh0Q29udGVudDogc3RyaW5nKTogQXNzaXN0YW50TWVzc2FnZSB7XG5cdGNvbnN0IGVycm9yTXNnID0gXCJzdHJlYW1fZXhoYXVzdGVkX3dpdGhvdXRfcmVzdWx0XCI7XG5cdGNvbnN0IG1lc3NhZ2UgPSBtYWtlRXJyb3JNZXNzYWdlKG1vZGVsLCBlcnJvck1zZyk7XG5cdGlmIChsYXN0VGV4dENvbnRlbnQpIHtcblx0XHRtZXNzYWdlLmNvbnRlbnQgPSBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogbGFzdFRleHRDb250ZW50IH1dO1xuXHR9XG5cdHJldHVybiBtZXNzYWdlO1xufVxuXG4vKiogRXh0cmFjdCB0aGUgc3RyaW5nIGxhYmVscyBmcm9tIGFuIGFycmF5IG9mIFNESyBlbGljaXRhdGlvbiBvcHRpb24gb2JqZWN0cywgZmlsdGVyaW5nIG91dCBibGFuayBlbnRyaWVzLiAqL1xuZnVuY3Rpb24gcmVhZEVsaWNpdGF0aW9uQ2hvaWNlcyhvcHRpb25zOiBTZGtFbGljaXRhdGlvblJlcXVlc3RPcHRpb25bXSB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdIHtcblx0aWYgKCFBcnJheS5pc0FycmF5KG9wdGlvbnMpKSByZXR1cm4gW107XG5cdHJldHVybiBvcHRpb25zXG5cdFx0Lm1hcCgob3B0aW9uKSA9PiAodHlwZW9mIG9wdGlvbj8uY29uc3QgPT09IFwic3RyaW5nXCIgPyBvcHRpb24uY29uc3QgOiB0eXBlb2Ygb3B0aW9uPy50aXRsZSA9PT0gXCJzdHJpbmdcIiA/IG9wdGlvbi50aXRsZSA6IFwiXCIpKVxuXHRcdC5maWx0ZXIoKG9wdGlvbik6IG9wdGlvbiBpcyBzdHJpbmcgPT4gb3B0aW9uLmxlbmd0aCA+IDApO1xufVxuXG4vKiogUGFyc2UgYW4gU0RLIGVsaWNpdGF0aW9uIHJlcXVlc3QgaW50byBzdHJ1Y3R1cmVkIG11bHRpcGxlLWNob2ljZSBxdWVzdGlvbnMsIG9yIG51bGwgaWYgdGhlIHNjaGVtYSBpcyB1bnN1cHBvcnRlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUFza1VzZXJRdWVzdGlvbnNFbGljaXRhdGlvbihcblx0cmVxdWVzdDogUGljazxTZGtFbGljaXRhdGlvblJlcXVlc3QsIFwibW9kZVwiIHwgXCJyZXF1ZXN0ZWRTY2hlbWFcIj4sXG4pOiBQYXJzZWRFbGljaXRhdGlvblF1ZXN0aW9uW10gfCBudWxsIHtcblx0aWYgKHJlcXVlc3QubW9kZSAmJiByZXF1ZXN0Lm1vZGUgIT09IFwiZm9ybVwiKSByZXR1cm4gbnVsbDtcblx0Y29uc3QgcHJvcGVydGllcyA9IHJlcXVlc3QucmVxdWVzdGVkU2NoZW1hPy5wcm9wZXJ0aWVzO1xuXHRpZiAoIXByb3BlcnRpZXMgfHwgdHlwZW9mIHByb3BlcnRpZXMgIT09IFwib2JqZWN0XCIpIHJldHVybiBudWxsO1xuXG5cdGNvbnN0IHF1ZXN0aW9uczogUGFyc2VkRWxpY2l0YXRpb25RdWVzdGlvbltdID0gW107XG5cblx0Zm9yIChjb25zdCBbZmllbGRJZCwgcmF3RmllbGRdIG9mIE9iamVjdC5lbnRyaWVzKHByb3BlcnRpZXMpKSB7XG5cdFx0aWYgKGZpZWxkSWQuZW5kc1dpdGgoXCJfX25vdGVcIikpIGNvbnRpbnVlO1xuXHRcdGlmICghcmF3RmllbGQgfHwgdHlwZW9mIHJhd0ZpZWxkICE9PSBcIm9iamVjdFwiKSByZXR1cm4gbnVsbDtcblxuXHRcdGNvbnN0IGhlYWRlciA9IHR5cGVvZiByYXdGaWVsZC50aXRsZSA9PT0gXCJzdHJpbmdcIiAmJiByYXdGaWVsZC50aXRsZS5sZW5ndGggPiAwID8gcmF3RmllbGQudGl0bGUgOiBmaWVsZElkO1xuXHRcdGNvbnN0IHF1ZXN0aW9uID0gdHlwZW9mIHJhd0ZpZWxkLmRlc2NyaXB0aW9uID09PSBcInN0cmluZ1wiID8gcmF3RmllbGQuZGVzY3JpcHRpb24gOiBcIlwiO1xuXG5cdFx0aWYgKHJhd0ZpZWxkLnR5cGUgPT09IFwiYXJyYXlcIikge1xuXHRcdFx0Y29uc3Qgb3B0aW9ucyA9IHJlYWRFbGljaXRhdGlvbkNob2ljZXMocmF3RmllbGQuaXRlbXM/LmFueU9mKS5tYXAoKGxhYmVsKSA9PiAoeyBsYWJlbCwgZGVzY3JpcHRpb246IFwiXCIgfSkpO1xuXHRcdFx0aWYgKG9wdGlvbnMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcblx0XHRcdHF1ZXN0aW9ucy5wdXNoKHtcblx0XHRcdFx0aWQ6IGZpZWxkSWQsXG5cdFx0XHRcdGhlYWRlcixcblx0XHRcdFx0cXVlc3Rpb24sXG5cdFx0XHRcdG9wdGlvbnMsXG5cdFx0XHRcdGFsbG93TXVsdGlwbGU6IHRydWUsXG5cdFx0XHR9KTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGlmIChyYXdGaWVsZC50eXBlID09PSBcInN0cmluZ1wiKSB7XG5cdFx0XHRjb25zdCBub3RlRmllbGRJZCA9IE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChwcm9wZXJ0aWVzLCBgJHtmaWVsZElkfV9fbm90ZWApXG5cdFx0XHRcdD8gYCR7ZmllbGRJZH1fX25vdGVgXG5cdFx0XHRcdDogdW5kZWZpbmVkO1xuXHRcdFx0Y29uc3Qgb3B0aW9ucyA9IHJlYWRFbGljaXRhdGlvbkNob2ljZXMocmF3RmllbGQub25lT2YpXG5cdFx0XHRcdC5maWx0ZXIoKGxhYmVsKSA9PiBsYWJlbCAhPT0gT1RIRVJfT1BUSU9OX0xBQkVMKVxuXHRcdFx0XHQubWFwKChsYWJlbCkgPT4gKHsgbGFiZWwsIGRlc2NyaXB0aW9uOiBcIlwiIH0pKTtcblx0XHRcdGlmIChvcHRpb25zLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cdFx0XHRxdWVzdGlvbnMucHVzaCh7XG5cdFx0XHRcdGlkOiBmaWVsZElkLFxuXHRcdFx0XHRoZWFkZXIsXG5cdFx0XHRcdHF1ZXN0aW9uLFxuXHRcdFx0XHRvcHRpb25zLFxuXHRcdFx0XHRub3RlRmllbGRJZCxcblx0XHRcdH0pO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cblxuXHRyZXR1cm4gcXVlc3Rpb25zLmxlbmd0aCA+IDAgPyBxdWVzdGlvbnMgOiBudWxsO1xufVxuXG4vKiogUmV0dXJuIHRydWUgaWYgdGhlIGVsaWNpdGF0aW9uIGZpZWxkIHNob3VsZCBiZSB0cmVhdGVkIGFzIHNlbnNpdGl2ZSBhbmQgcmVuZGVyZWQgYXMgYSBzZWN1cmUvcGFzc3dvcmQgaW5wdXQuICovXG5mdW5jdGlvbiBpc1NlY3VyZUVsaWNpdGF0aW9uRmllbGQoXG5cdHJlcXVlc3RNZXNzYWdlOiBzdHJpbmcsXG5cdGZpZWxkSWQ6IHN0cmluZyxcblx0ZmllbGQ6IFNka0VsaWNpdGF0aW9uRmllbGRTY2hlbWEsXG4pOiBib29sZWFuIHtcblx0aWYgKGZpZWxkLmZvcm1hdCA9PT0gXCJwYXNzd29yZFwiKSByZXR1cm4gdHJ1ZTtcblx0aWYgKGZpZWxkLndyaXRlT25seSA9PT0gdHJ1ZSkgcmV0dXJuIHRydWU7XG5cblx0Y29uc3QgcmF3RmllbGQgPSBmaWVsZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcblx0aWYgKHJhd0ZpZWxkLnNlbnNpdGl2ZSA9PT0gdHJ1ZSB8fCByYXdGaWVsZFtcIngtc2Vuc2l0aXZlXCJdID09PSB0cnVlKSByZXR1cm4gdHJ1ZTtcblxuXHRjb25zdCBoYXlzdGFjayA9IFtcblx0XHRyZXF1ZXN0TWVzc2FnZSxcblx0XHRmaWVsZElkLnJlcGxhY2UoL1tfLV0rL2csIFwiIFwiKSxcblx0XHR0eXBlb2YgZmllbGQudGl0bGUgPT09IFwic3RyaW5nXCIgPyBmaWVsZC50aXRsZSA6IFwiXCIsXG5cdFx0dHlwZW9mIGZpZWxkLmRlc2NyaXB0aW9uID09PSBcInN0cmluZ1wiID8gZmllbGQuZGVzY3JpcHRpb24gOiBcIlwiLFxuXHRdXG5cdFx0LmpvaW4oXCIgXCIpXG5cdFx0LnRvTG93ZXJDYXNlKCk7XG5cblx0cmV0dXJuIFNFTlNJVElWRV9GSUVMRF9QQVRURVJOLnRlc3QoaGF5c3RhY2spO1xufVxuXG4vKiogUGFyc2UgYW4gU0RLIGVsaWNpdGF0aW9uIHJlcXVlc3QgaW50byBmcmVlLXRleHQgaW5wdXQgZmllbGQgZGVzY3JpcHRvcnMsIG9yIG51bGwgaWYgdW5zdXBwb3J0ZWQuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VUZXh0SW5wdXRFbGljaXRhdGlvbihcblx0cmVxdWVzdDogUGljazxTZGtFbGljaXRhdGlvblJlcXVlc3QsIFwibWVzc2FnZVwiIHwgXCJtb2RlXCIgfCBcInJlcXVlc3RlZFNjaGVtYVwiPixcbik6IFBhcnNlZFRleHRJbnB1dEZpZWxkW10gfCBudWxsIHtcblx0aWYgKHJlcXVlc3QubW9kZSAmJiByZXF1ZXN0Lm1vZGUgIT09IFwiZm9ybVwiKSByZXR1cm4gbnVsbDtcblx0Y29uc3Qgc2NoZW1hID0gcmVxdWVzdC5yZXF1ZXN0ZWRTY2hlbWEgYXNcblx0XHR8ICh7IHByb3BlcnRpZXM/OiBSZWNvcmQ8c3RyaW5nLCBTZGtFbGljaXRhdGlvbkZpZWxkU2NoZW1hPjsga2V5cz86IFJlY29yZDxzdHJpbmcsIFNka0VsaWNpdGF0aW9uRmllbGRTY2hlbWE+IH0gJiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilcblx0XHR8IHVuZGVmaW5lZDtcblx0Y29uc3QgZmllbGRzU291cmNlID0gc2NoZW1hPy5wcm9wZXJ0aWVzICYmIHR5cGVvZiBzY2hlbWEucHJvcGVydGllcyA9PT0gXCJvYmplY3RcIlxuXHRcdD8gc2NoZW1hLnByb3BlcnRpZXNcblx0XHQ6IHNjaGVtYT8ua2V5cyAmJiB0eXBlb2Ygc2NoZW1hLmtleXMgPT09IFwib2JqZWN0XCJcblx0XHRcdD8gc2NoZW1hLmtleXNcblx0XHRcdDogdW5kZWZpbmVkO1xuXHRpZiAoIWZpZWxkc1NvdXJjZSkgcmV0dXJuIG51bGw7XG5cblx0Y29uc3QgcmVxdWlyZWRTZXQgPSBuZXcgU2V0KFxuXHRcdEFycmF5LmlzQXJyYXkocmVxdWVzdC5yZXF1ZXN0ZWRTY2hlbWE/LnJlcXVpcmVkKVxuXHRcdFx0PyByZXF1ZXN0LnJlcXVlc3RlZFNjaGVtYS5yZXF1aXJlZC5maWx0ZXIoKHZhbHVlKTogdmFsdWUgaXMgc3RyaW5nID0+IHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIilcblx0XHRcdDogW10sXG5cdCk7XG5cblx0Y29uc3QgZmllbGRzOiBQYXJzZWRUZXh0SW5wdXRGaWVsZFtdID0gW107XG5cdGZvciAoY29uc3QgW2ZpZWxkSWQsIGZpZWxkXSBvZiBPYmplY3QuZW50cmllcyhmaWVsZHNTb3VyY2UpKSB7XG5cdFx0aWYgKCFmaWVsZCB8fCB0eXBlb2YgZmllbGQgIT09IFwib2JqZWN0XCIpIGNvbnRpbnVlO1xuXHRcdGlmIChmaWVsZC50eXBlICE9PSBcInN0cmluZ1wiKSBjb250aW51ZTtcblx0XHRpZiAoQXJyYXkuaXNBcnJheShmaWVsZC5vbmVPZikgJiYgZmllbGQub25lT2YubGVuZ3RoID4gMCkgY29udGludWU7XG5cblx0XHRmaWVsZHMucHVzaCh7XG5cdFx0XHRpZDogZmllbGRJZCxcblx0XHRcdHRpdGxlOiB0eXBlb2YgZmllbGQudGl0bGUgPT09IFwic3RyaW5nXCIgJiYgZmllbGQudGl0bGUubGVuZ3RoID4gMCA/IGZpZWxkLnRpdGxlIDogZmllbGRJZCxcblx0XHRcdGRlc2NyaXB0aW9uOiB0eXBlb2YgZmllbGQuZGVzY3JpcHRpb24gPT09IFwic3RyaW5nXCIgPyBmaWVsZC5kZXNjcmlwdGlvbiA6IFwiXCIsXG5cdFx0XHRyZXF1aXJlZDogcmVxdWlyZWRTZXQuaGFzKGZpZWxkSWQpLFxuXHRcdFx0c2VjdXJlOiBpc1NlY3VyZUVsaWNpdGF0aW9uRmllbGQocmVxdWVzdC5tZXNzYWdlLCBmaWVsZElkLCBmaWVsZCksXG5cdFx0fSk7XG5cdH1cblxuXHRyZXR1cm4gZmllbGRzLmxlbmd0aCA+IDAgPyBmaWVsZHMgOiBudWxsO1xufVxuXG4vKiogQ29udmVydCBhIFRVSSBpbnRlcnZpZXcgcm91bmQgcmVzdWx0IGludG8gdGhlIFNESyBlbGljaXRhdGlvbiBjb250ZW50IG1hcC4gKi9cbmV4cG9ydCBmdW5jdGlvbiByb3VuZFJlc3VsdFRvRWxpY2l0YXRpb25Db250ZW50KFxuXHRxdWVzdGlvbnM6IFBhcnNlZEVsaWNpdGF0aW9uUXVlc3Rpb25bXSxcblx0cmVzdWx0OiBSb3VuZFJlc3VsdCxcbik6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHN0cmluZ1tdPiB7XG5cdGNvbnN0IGNvbnRlbnQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHN0cmluZ1tdPiA9IHt9O1xuXG5cdGZvciAoY29uc3QgcXVlc3Rpb24gb2YgcXVlc3Rpb25zKSB7XG5cdFx0Y29uc3QgYW5zd2VyID0gcmVzdWx0LmFuc3dlcnNbcXVlc3Rpb24uaWRdO1xuXHRcdGlmICghYW5zd2VyKSBjb250aW51ZTtcblxuXHRcdGlmIChxdWVzdGlvbi5hbGxvd011bHRpcGxlKSB7XG5cdFx0XHRjb25zdCBzZWxlY3RlZCA9IEFycmF5LmlzQXJyYXkoYW5zd2VyLnNlbGVjdGVkKSA/IGFuc3dlci5zZWxlY3RlZCA6IFthbnN3ZXIuc2VsZWN0ZWRdO1xuXHRcdFx0Y29udGVudFtxdWVzdGlvbi5pZF0gPSBzZWxlY3RlZDtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGNvbnN0IHNlbGVjdGVkID0gQXJyYXkuaXNBcnJheShhbnN3ZXIuc2VsZWN0ZWQpID8gYW5zd2VyLnNlbGVjdGVkWzBdID8/IFwiXCIgOiBhbnN3ZXIuc2VsZWN0ZWQ7XG5cdFx0Y29udGVudFtxdWVzdGlvbi5pZF0gPSBzZWxlY3RlZDtcblx0XHRpZiAocXVlc3Rpb24ubm90ZUZpZWxkSWQgJiYgc2VsZWN0ZWQgPT09IE9USEVSX09QVElPTl9MQUJFTCAmJiBhbnN3ZXIubm90ZXMudHJpbSgpLmxlbmd0aCA+IDApIHtcblx0XHRcdGNvbnRlbnRbcXVlc3Rpb24ubm90ZUZpZWxkSWRdID0gYW5zd2VyLm5vdGVzLnRyaW0oKTtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gY29udGVudDtcbn1cblxuLyoqIEJ1aWxkIHRoZSBkaWFsb2cgdGl0bGUgc3RyaW5nIGZvciBhIG11bHRpcGxlLWNob2ljZSBlbGljaXRhdGlvbiBxdWVzdGlvbiwgY29tYmluaW5nIHNlcnZlciBuYW1lLCBoZWFkZXIsIGFuZCBxdWVzdGlvbiB0ZXh0LiAqL1xuZnVuY3Rpb24gYnVpbGRFbGljaXRhdGlvblByb21wdFRpdGxlKHJlcXVlc3Q6IFNka0VsaWNpdGF0aW9uUmVxdWVzdCwgcXVlc3Rpb246IFBhcnNlZEVsaWNpdGF0aW9uUXVlc3Rpb24pOiBzdHJpbmcge1xuXHRjb25zdCBwYXJ0cyA9IFtcblx0XHRyZXF1ZXN0LnNlcnZlck5hbWUgPyBgWyR7cmVxdWVzdC5zZXJ2ZXJOYW1lfV1gIDogXCJcIixcblx0XHRxdWVzdGlvbi5oZWFkZXIsXG5cdFx0cXVlc3Rpb24ucXVlc3Rpb24sXG5cdF0uZmlsdGVyKChwYXJ0KSA9PiBwYXJ0ICYmIHBhcnQudHJpbSgpLmxlbmd0aCA+IDApO1xuXHRyZXR1cm4gcGFydHMuam9pbihcIlxcblxcblwiKTtcbn1cblxuLyoqIERyaXZlIGVhY2ggbXVsdGlwbGUtY2hvaWNlIGVsaWNpdGF0aW9uIHF1ZXN0aW9uIHRocm91Z2ggdGhlIGV4dGVuc2lvbiBVSSdzIGBzZWxlY3RgIGRpYWxvZywgY29sbGVjdGluZyBhbnN3ZXJzIGludG8gYW4gU0RLIHJlc3VsdC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHByb21wdEVsaWNpdGF0aW9uV2l0aERpYWxvZ3MoXG5cdHJlcXVlc3Q6IFNka0VsaWNpdGF0aW9uUmVxdWVzdCxcblx0cXVlc3Rpb25zOiBQYXJzZWRFbGljaXRhdGlvblF1ZXN0aW9uW10sXG5cdHVpOiBFeHRlbnNpb25VSUNvbnRleHQsXG5cdHNpZ25hbDogQWJvcnRTaWduYWwsXG4pOiBQcm9taXNlPFNka0VsaWNpdGF0aW9uUmVzdWx0PiB7XG5cdGNvbnN0IGNvbnRlbnQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHN0cmluZ1tdPiA9IHt9O1xuXG5cdGZvciAoY29uc3QgcXVlc3Rpb24gb2YgcXVlc3Rpb25zKSB7XG5cdFx0Y29uc3QgdGl0bGUgPSBidWlsZEVsaWNpdGF0aW9uUHJvbXB0VGl0bGUocmVxdWVzdCwgcXVlc3Rpb24pO1xuXG5cdFx0aWYgKHF1ZXN0aW9uLmFsbG93TXVsdGlwbGUpIHtcblx0XHRcdGNvbnN0IHNlbGVjdGVkID0gYXdhaXQgdWkuc2VsZWN0KHRpdGxlLCBxdWVzdGlvbi5vcHRpb25zLm1hcCgob3B0aW9uKSA9PiBvcHRpb24ubGFiZWwpLCB7XG5cdFx0XHRcdGFsbG93TXVsdGlwbGU6IHRydWUsXG5cdFx0XHRcdHNpZ25hbCxcblx0XHRcdH0pO1xuXHRcdFx0aWYgKEFycmF5LmlzQXJyYXkoc2VsZWN0ZWQpKSB7XG5cdFx0XHRcdGlmIChzZWxlY3RlZC5sZW5ndGggPT09IDApIHJldHVybiB7IGFjdGlvbjogXCJjYW5jZWxcIiB9O1xuXHRcdFx0XHRjb250ZW50W3F1ZXN0aW9uLmlkXSA9IHNlbGVjdGVkO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdGlmICh0eXBlb2Ygc2VsZWN0ZWQgPT09IFwic3RyaW5nXCIgJiYgc2VsZWN0ZWQubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRjb250ZW50W3F1ZXN0aW9uLmlkXSA9IFtzZWxlY3RlZF07XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIHsgYWN0aW9uOiBcImNhbmNlbFwiIH07XG5cdFx0fVxuXG5cdFx0Y29uc3Qgc2VsZWN0ZWQgPSBhd2FpdCB1aS5zZWxlY3QodGl0bGUsIFsuLi5xdWVzdGlvbi5vcHRpb25zLm1hcCgob3B0aW9uKSA9PiBvcHRpb24ubGFiZWwpLCBPVEhFUl9PUFRJT05fTEFCRUxdLCB7IHNpZ25hbCB9KTtcblx0XHRpZiAodHlwZW9mIHNlbGVjdGVkICE9PSBcInN0cmluZ1wiIHx8IHNlbGVjdGVkLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0cmV0dXJuIHsgYWN0aW9uOiBcImNhbmNlbFwiIH07XG5cdFx0fVxuXG5cdFx0Y29udGVudFtxdWVzdGlvbi5pZF0gPSBzZWxlY3RlZDtcblx0XHRpZiAocXVlc3Rpb24ubm90ZUZpZWxkSWQgJiYgc2VsZWN0ZWQgPT09IE9USEVSX09QVElPTl9MQUJFTCkge1xuXHRcdFx0Y29uc3Qgbm90ZSA9IGF3YWl0IHVpLmlucHV0KGAke3F1ZXN0aW9uLmhlYWRlcn0gbm90ZWAsIFwiRXhwbGFpbiB5b3VyIGFuc3dlclwiLCB7IHNpZ25hbCB9KTtcblx0XHRcdGlmIChub3RlID09PSB1bmRlZmluZWQpIHJldHVybiB7IGFjdGlvbjogXCJjYW5jZWxcIiB9O1xuXHRcdFx0aWYgKG5vdGUudHJpbSgpLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0Y29udGVudFtxdWVzdGlvbi5ub3RlRmllbGRJZF0gPSBub3RlLnRyaW0oKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRyZXR1cm4geyBhY3Rpb246IFwiYWNjZXB0XCIsIGNvbnRlbnQgfTtcbn1cblxuLyoqIEJ1aWxkIHRoZSBkaWFsb2cgdGl0bGUgc3RyaW5nIGZvciBhIGZyZWUtdGV4dCBpbnB1dCBmaWVsZCwgY29tYmluaW5nIHNlcnZlciBuYW1lLCBmaWVsZCB0aXRsZSwgYW5kIGRlc2NyaXB0aW9uLiAqL1xuZnVuY3Rpb24gYnVpbGRUZXh0SW5wdXRQcm9tcHRUaXRsZShyZXF1ZXN0OiBTZGtFbGljaXRhdGlvblJlcXVlc3QsIGZpZWxkOiBQYXJzZWRUZXh0SW5wdXRGaWVsZCk6IHN0cmluZyB7XG5cdGNvbnN0IHBhcnRzID0gW1xuXHRcdHJlcXVlc3Quc2VydmVyTmFtZSA/IGBbJHtyZXF1ZXN0LnNlcnZlck5hbWV9XWAgOiBcIlwiLFxuXHRcdGZpZWxkLnRpdGxlLFxuXHRcdGZpZWxkLmRlc2NyaXB0aW9uLFxuXHRdLmZpbHRlcigocGFydCkgPT4gdHlwZW9mIHBhcnQgPT09IFwic3RyaW5nXCIgJiYgcGFydC50cmltKCkubGVuZ3RoID4gMCk7XG5cdHJldHVybiBwYXJ0cy5qb2luKFwiXFxuXFxuXCIpO1xufVxuXG4vKiogRGVyaXZlIGEgcGxhY2Vob2xkZXIgaGludCBmb3IgYSBmcmVlLXRleHQgaW5wdXQgZmllbGQgZnJvbSBpdHMgZGVzY3JpcHRpb24sIGZhbGxpbmcgYmFjayB0byBcIlJlcXVpcmVkXCIgb3IgXCJMZWF2ZSBlbXB0eSB0byBza2lwXCIuICovXG5mdW5jdGlvbiBidWlsZFRleHRJbnB1dFBsYWNlaG9sZGVyKGZpZWxkOiBQYXJzZWRUZXh0SW5wdXRGaWVsZCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG5cdGNvbnN0IGRlc2MgPSBmaWVsZC5kZXNjcmlwdGlvbi50cmltKCk7XG5cdGlmICghZGVzYykgcmV0dXJuIGZpZWxkLnJlcXVpcmVkID8gXCJSZXF1aXJlZFwiIDogXCJMZWF2ZSBlbXB0eSB0byBza2lwXCI7XG5cblx0Y29uc3QgZm9ybWF0TGluZSA9IGRlc2Ncblx0XHQuc3BsaXQoL1xccj9cXG4vKVxuXHRcdC5tYXAoKGxpbmUpID0+IGxpbmUudHJpbSgpKVxuXHRcdC5maW5kKChsaW5lKSA9PiAvXmZvcm1hdDovaS50ZXN0KGxpbmUpKTtcblxuXHRpZiAoIWZvcm1hdExpbmUpIHJldHVybiBmaWVsZC5yZXF1aXJlZCA/IFwiUmVxdWlyZWRcIiA6IFwiTGVhdmUgZW1wdHkgdG8gc2tpcFwiO1xuXHRjb25zdCBoaW50ID0gZm9ybWF0TGluZS5yZXBsYWNlKC9eZm9ybWF0OlxccyovaSwgXCJcIikudHJpbSgpO1xuXHRyZXR1cm4gaGludC5sZW5ndGggPiAwID8gaGludCA6IGZpZWxkLnJlcXVpcmVkID8gXCJSZXF1aXJlZFwiIDogXCJMZWF2ZSBlbXB0eSB0byBza2lwXCI7XG59XG5cbi8qKiBDb2xsZWN0IGVhY2ggZnJlZS10ZXh0IGlucHV0IGZpZWxkIHZpYSB0aGUgZXh0ZW5zaW9uIFVJJ3MgYGlucHV0YCBkaWFsb2csIHJldHVybmluZyB0aGUgZmlsbGVkIFNESyBlbGljaXRhdGlvbiByZXN1bHQuICovXG5hc3luYyBmdW5jdGlvbiBwcm9tcHRUZXh0SW5wdXRFbGljaXRhdGlvbihcblx0cmVxdWVzdDogU2RrRWxpY2l0YXRpb25SZXF1ZXN0LFxuXHRmaWVsZHM6IFBhcnNlZFRleHRJbnB1dEZpZWxkW10sXG5cdHVpOiBFeHRlbnNpb25VSUNvbnRleHQsXG5cdHNpZ25hbDogQWJvcnRTaWduYWwsXG4pOiBQcm9taXNlPFNka0VsaWNpdGF0aW9uUmVzdWx0PiB7XG5cdGNvbnN0IGNvbnRlbnQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHN0cmluZ1tdPiA9IHt9O1xuXG5cdGZvciAoY29uc3QgZmllbGQgb2YgZmllbGRzKSB7XG5cdFx0Y29uc3QgdmFsdWUgPSBhd2FpdCB1aS5pbnB1dChcblx0XHRcdGJ1aWxkVGV4dElucHV0UHJvbXB0VGl0bGUocmVxdWVzdCwgZmllbGQpLFxuXHRcdFx0YnVpbGRUZXh0SW5wdXRQbGFjZWhvbGRlcihmaWVsZCksXG5cdFx0XHR7IHNpZ25hbCwgLi4uKGZpZWxkLnNlY3VyZSA/IHsgc2VjdXJlOiB0cnVlIH0gOiB7fSkgfSxcblx0XHQpO1xuXHRcdGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRyZXR1cm4geyBhY3Rpb246IFwiY2FuY2VsXCIgfTtcblx0XHR9XG5cdFx0Y29udGVudFtmaWVsZC5pZF0gPSB2YWx1ZTtcblx0fVxuXG5cdHJldHVybiB7IGFjdGlvbjogXCJhY2NlcHRcIiwgY29udGVudCB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGNhblVzZVRvb2wgaGFuZGxlclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBPcHRpb25zIHBhc3NlZCBieSB0aGUgU0RLIHRvIHRoZSBjYW5Vc2VUb29sIGNhbGxiYWNrLiAqL1xuaW50ZXJmYWNlIENhblVzZVRvb2xPcHRpb25zIHtcblx0c2lnbmFsOiBBYm9ydFNpZ25hbDtcblx0c3VnZ2VzdGlvbnM/OiBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG5cdGJsb2NrZWRQYXRoPzogc3RyaW5nO1xuXHRkZWNpc2lvblJlYXNvbj86IHN0cmluZztcblx0dGl0bGU/OiBzdHJpbmc7XG5cdGRpc3BsYXlOYW1lPzogc3RyaW5nO1xuXHRkZXNjcmlwdGlvbj86IHN0cmluZztcblx0dG9vbFVzZUlEOiBzdHJpbmc7XG5cdGFnZW50SUQ/OiBzdHJpbmc7XG59XG5cbi8qKiBSZXN1bHQgcmV0dXJuZWQgYnkgdGhlIGNhblVzZVRvb2wgY2FsbGJhY2sgdG8gdGhlIFNESy4gKi9cbnR5cGUgQ2FuVXNlVG9vbFBlcm1pc3Npb25SZXN1bHQgPVxuXHR8IHsgYmVoYXZpb3I6IFwiYWxsb3dcIjsgdXBkYXRlZElucHV0PzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47IHVwZGF0ZWRQZXJtaXNzaW9ucz86IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PjsgdG9vbFVzZUlEPzogc3RyaW5nIH1cblx0fCB7IGJlaGF2aW9yOiBcImRlbnlcIjsgbWVzc2FnZTogc3RyaW5nOyBpbnRlcnJ1cHQ/OiBib29sZWFuOyB0b29sVXNlSUQ/OiBzdHJpbmcgfTtcblxuLyoqXG4gKiBLbm93biBDTEkgdG9vbHMgd2hlcmUgdGhlIHN1YmNvbW1hbmQgdmVyYiBjaGFuZ2VzIHRoZSByaXNrIHByb2ZpbGUuXG4gKiBWYWx1ZSA9IG51bWJlciBvZiBzdWJjb21tYW5kIHRva2VucyAoYmV5b25kIHRoZSBleGVjdXRhYmxlKSB0byBjYXB0dXJlXG4gKiBpbiB0aGUgXCJBbHdheXMgQWxsb3dcIiBwZXJtaXNzaW9uIHBhdHRlcm4uXG4gKlxuICogYGdpdCBwdXNoYCBhbmQgYGdpdCBsb2dgIGFyZSB2ZXJ5IGRpZmZlcmVudCBcdTIxOTIgZGVwdGggMSBcdTIxOTIgYEJhc2goZ2l0IHB1c2g6KilgXG4gKiBgZ2ggcHIgY3JlYXRlYCBhbmQgYGdoIHByIGxpc3RgIGRpZmZlciBhdCBkZXB0aCAyIFx1MjE5MiBgQmFzaChnaCBwciBjcmVhdGU6KilgXG4gKiBgcGluZ2AgaXMgYWx3YXlzIHNhZmUgXHUyMTkyIG5vdCBsaXN0ZWQgXHUyMTkyIGBCYXNoKHBpbmc6KilgXG4gKi9cbmNvbnN0IFNVQkNPTU1BTkRfREVQVEg6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7XG5cdGdpdDogMSxcblx0Z2g6IDIsXG5cdG5wbTogMSxcblx0bnB4OiAxLFxuXHR5YXJuOiAxLFxuXHRwbnBtOiAxLFxuXHRkb2NrZXI6IDEsXG5cdGt1YmVjdGw6IDEsXG5cdGF3czogMixcblx0YXo6IDIsXG5cdGdjbG91ZDogMixcblx0Y2FyZ286IDEsXG5cdHBpcDogMSxcblx0cGlwMzogMSxcblx0YnJldzogMSxcblx0dGVycmFmb3JtOiAxLFxuXHRoZWxtOiAxLFxuXHRkb3RuZXQ6IDEsXG59O1xuXG4vKiogQ29tbWFuZCB3cmFwcGVycyB0byBza2lwIHdoZW4gZXh0cmFjdGluZyB0aGUgYmFzZSBleGVjdXRhYmxlLiAqL1xuY29uc3QgQ01EX1BBU1NUSFJPVUdIID0gbmV3IFNldChbXCJzdWRvXCIsIFwiZW52XCIsIFwiY29tbWFuZFwiXSk7XG5cbi8qKlxuICogQnVpbGQgYSBzbWFydCBwZXJtaXNzaW9uIHBhdHRlcm4gZm9yIEJhc2ggXCJBbHdheXMgQWxsb3dcIi5cbiAqXG4gKiBTaW1wbGUgY29tbWFuZHMgXHUyMTkyIGBCYXNoKHBpbmc6KilgIChhbnkgYXJncyBhcmUgZmluZSlcbiAqIFN1YmNvbW1hbmQtc2Vuc2l0aXZlIENMSXMgXHUyMTkyIGBCYXNoKGdpdCBwdXNoOiopYCAodmVyYiBpcyBjYXB0dXJlZCwgYXJncyB3aWxkY2FyZGVkKVxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oY29tbWFuZDogc3RyaW5nKTogc3RyaW5nIHtcblx0Ly8gV2hlbiB0aGUgY29tbWFuZCBpcyBhIGNoYWluIGxpa2UgXCJjZCAvZm9vICYmIGdoIHByIGxpc3RcIiwgZXh0cmFjdCB0aGVcblx0Ly8gbGFzdCBzZWdtZW50IFx1MjAxNCBgY2RgIGlzIGp1c3Qgc2V0dXAsIHRoZSBtZWFuaW5nZnVsIG9wZXJhdGlvbiBpcyB3aGF0IGZvbGxvd3MuXG5cdGNvbnN0IHNlZ21lbnRzID0gY29tbWFuZC5zcGxpdCgvXFxzKig/OiYmfFxcfFxcfHw7KVxccyovKTtcblx0Ly8gU2tpcCBsZWFkaW5nIGBjZGAgKGRpcmVjdG9yeSBzZXR1cCkgYW5kIHRyYWlsaW5nIGVycm9yIHN1cHByZXNzb3JzXG5cdC8vIGxpa2UgYHx8IHRydWVgLCBgfHwgOmAsIGB8fCBlY2hvIC4uLmAuICBUaGUgbWVhbmluZ2Z1bCBjb21tYW5kIGlzXG5cdC8vIHRoZSBmaXJzdCBzZWdtZW50IHRoYXQgaXMgKm5laXRoZXIqIG9mIHRob3NlLlxuXHRjb25zdCBTRVRVUF9SRSA9IC9eXFxzKmNkXFxzLztcblx0Y29uc3QgU1VQUFJFU1NPUl9SRSA9IC9eXFxzKig/OnRydWV8OnxlY2hvXFxiKS87XG5cdGxldCBtZWFuaW5nZnVsOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cdGlmIChzZWdtZW50cy5sZW5ndGggPiAxKSB7XG5cdFx0Ly8gU3RyaXAgc3VwcHJlc3NvcnMsIHRoZW4gc3RyaXAgY2QgcHJlZml4ZXM7IHRha2UgdGhlICpsYXN0KiByZW1haW5pbmdcblx0XHQvLyBzZWdtZW50IFx1MjAxNCB0aGF0J3MgdGhlIG1lYW5pbmdmdWwgY29tbWFuZC5cblx0XHRjb25zdCB0cmltbWVkID0gc2VnbWVudHMuZmlsdGVyKHMgPT4gIVNVUFBSRVNTT1JfUkUudGVzdChzKSk7XG5cdFx0Y29uc3QgY29yZSA9IHRyaW1tZWQuZmlsdGVyKHMgPT4gIVNFVFVQX1JFLnRlc3QocykpO1xuXHRcdG1lYW5pbmdmdWwgPSBjb3JlLmxlbmd0aCA+IDAgPyBjb3JlW2NvcmUubGVuZ3RoIC0gMV0gOiB0cmltbWVkW3RyaW1tZWQubGVuZ3RoIC0gMV07XG5cdH1cblx0bWVhbmluZ2Z1bCA9IG1lYW5pbmdmdWwgfHwgc2VnbWVudHNbMF0gfHwgY29tbWFuZDtcblx0Y29uc3QgcmF3VG9rZW5zID0gbWVhbmluZ2Z1bC50cmltKCkuc3BsaXQoL1xccysvKTtcblxuXHQvLyBTa2lwIHN1ZG8vZW52IHdyYXBwZXJzIGFuZCBsZWFkaW5nIFZBUj12YWwgYXNzaWdubWVudHNcblx0bGV0IGlkeCA9IDA7XG5cdHdoaWxlIChpZHggPCByYXdUb2tlbnMubGVuZ3RoKSB7XG5cdFx0aWYgKENNRF9QQVNTVEhST1VHSC5oYXMocmF3VG9rZW5zW2lkeF0pKSB7IGlkeCsrOyBjb250aW51ZTsgfVxuXHRcdGlmICgvXltBLVphLXpfXVxcdyo9Ly50ZXN0KHJhd1Rva2Vuc1tpZHhdKSkgeyBpZHgrKzsgY29udGludWU7IH1cblx0XHRicmVhaztcblx0fVxuXHRjb25zdCB0b2tlbnMgPSByYXdUb2tlbnMuc2xpY2UoaWR4KS5maWx0ZXIoQm9vbGVhbik7XG5cdGlmICh0b2tlbnMubGVuZ3RoID09PSAwKSByZXR1cm4gXCJCYXNoKCopXCI7XG5cblx0Ly8gU3RyaXAgcGF0aCBhbmQgLmV4ZSBmcm9tIGV4ZWN1dGFibGUgbmFtZVxuXHRjb25zdCBiYXNlID0gdG9rZW5zWzBdLnJlcGxhY2UoL14uKltcXFxcL10vLCBcIlwiKS5yZXBsYWNlKC9cXC5leGUkL2ksIFwiXCIpO1xuXHRjb25zdCBkZXB0aCA9IFNVQkNPTU1BTkRfREVQVEhbYmFzZV07XG5cblx0aWYgKGRlcHRoICE9PSB1bmRlZmluZWQpIHtcblx0XHQvLyBDYXB0dXJlIGJhc2UgKyBOIHN1YmNvbW1hbmQgdG9rZW5zOiBcImdoIHByIGxpc3RcIiBcdTIxOTIgQmFzaChnaCBwciBsaXN0OiopXG5cdFx0Y29uc3Qgc2lnbmlmaWNhbnQgPSBbYmFzZSwgLi4udG9rZW5zLnNsaWNlKDEsIDEgKyBkZXB0aCldLmpvaW4oXCIgXCIpO1xuXHRcdHJldHVybiBgQmFzaCgke3NpZ25pZmljYW50fToqKWA7XG5cdH1cblxuXHQvLyBTaW1wbGUgY29tbWFuZCBcdTIwMTQgYW55IGFyZ3MgYXJlIGZpbmU6IFwicGluZ1wiIFx1MjE5MiBCYXNoKHBpbmc6Kilcblx0cmV0dXJuIGBCYXNoKCR7YmFzZX06KilgO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBsaXN0IG9mIGdyYW51bGFyaXR5IG9wdGlvbnMgcHJlc2VudGVkIGFmdGVyIGEgdXNlciBjaG9vc2VzXG4gKiBcIkFsd2F5cyBBbGxvd1wiIGZvciBhIEJhc2ggY29tbWFuZC5cbiAqXG4gKiBSYXRoZXIgdGhhbiBhc3N1bWluZyB0aGUgdXNlciB3YW50cyB0aGUgZGVmYXVsdCBzbWFydCBwYXR0ZXJuLCB0aGUgVUlcbiAqIHNob3dzIGV2ZXJ5IG1lYW5pbmdmdWwgcHJlZml4IHNvIHRoZSB1c2VyIGV4cGxpY2l0bHkgcGlja3MgdGhlIHNjb3BlOlxuICpcbiAqICAgXCJnaCBwciBsaXN0IC0tbGltaXQgNVwiIFx1MjE5MiBbXG4gKiAgICAgXCJCYXNoKGdoOiopXCIsICAgICAgICAgLy8gYWxsb3cgYW55IGdoIGNvbW1hbmRcbiAqICAgICBcIkJhc2goZ2ggcHI6KilcIiwgICAgICAvLyBhbGxvdyBhbnkgZ2ggcHIgc3ViY29tbWFuZFxuICogICAgIFwiQmFzaChnaCBwciBsaXN0OiopXCIsIC8vIGFsbG93IGp1c3QgdGhpcyB2ZXJiXG4gKiAgIF1cbiAqXG4gKiBGbGFncyAodG9rZW5zIHN0YXJ0aW5nIHdpdGggYC1gKSB0ZXJtaW5hdGUgdGhlIHN1YmNvbW1hbmQgY2hhaW4gXHUyMDE0IHRoZXlcbiAqIGFyZSBjYWxsLXNpdGUgYXJndW1lbnRzLCBub3Qgc3RhYmxlIHZlcmJzLiBTdWJjb21tYW5kIGRlcHRoIGlzIGNhcHBlZFxuICogYXQgMyB0byBrZWVwIHRoZSBtZW51IHNob3J0IChtYXggNCBvcHRpb25zKS5cbiAqXG4gKiBSZXR1cm5zIGEgc2luZ2xlLWVudHJ5IGxpc3Qgd2hlbiB0aGVyZSBpcyBubyBtZWFuaW5nZnVsIHN1YmNvbW1hbmQgdG9cbiAqIGNob29zZSBmcm9tIChlLmcuIGBscyAtbGFgKS4gQ2FsbGVycyBjYW4gc2tpcCB0aGUgc2Vjb25kIGRpYWxvZyBpblxuICogdGhhdCBjYXNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm5PcHRpb25zKGNvbW1hbmQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcblx0Y29uc3Qgc2VnbWVudHMgPSBjb21tYW5kLnNwbGl0KC9cXHMqKD86JiZ8XFx8XFx8fDspXFxzKi8pO1xuXHRjb25zdCBTRVRVUF9SRSA9IC9eXFxzKmNkXFxzLztcblx0Y29uc3QgU1VQUFJFU1NPUl9SRSA9IC9eXFxzKig/OnRydWV8OnxlY2hvXFxiKS87XG5cdGxldCBtZWFuaW5nZnVsOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cdGlmIChzZWdtZW50cy5sZW5ndGggPiAxKSB7XG5cdFx0Y29uc3QgdHJpbW1lZCA9IHNlZ21lbnRzLmZpbHRlcihzID0+ICFTVVBQUkVTU09SX1JFLnRlc3QocykpO1xuXHRcdGNvbnN0IGNvcmUgPSB0cmltbWVkLmZpbHRlcihzID0+ICFTRVRVUF9SRS50ZXN0KHMpKTtcblx0XHRtZWFuaW5nZnVsID0gY29yZS5sZW5ndGggPiAwID8gY29yZVtjb3JlLmxlbmd0aCAtIDFdIDogdHJpbW1lZFt0cmltbWVkLmxlbmd0aCAtIDFdO1xuXHR9XG5cdG1lYW5pbmdmdWwgPSBtZWFuaW5nZnVsIHx8IHNlZ21lbnRzWzBdIHx8IGNvbW1hbmQ7XG5cdGNvbnN0IHJhd1Rva2VucyA9IG1lYW5pbmdmdWwudHJpbSgpLnNwbGl0KC9cXHMrLyk7XG5cblx0bGV0IGlkeCA9IDA7XG5cdHdoaWxlIChpZHggPCByYXdUb2tlbnMubGVuZ3RoKSB7XG5cdFx0aWYgKENNRF9QQVNTVEhST1VHSC5oYXMocmF3VG9rZW5zW2lkeF0pKSB7IGlkeCsrOyBjb250aW51ZTsgfVxuXHRcdGlmICgvXltBLVphLXpfXVxcdyo9Ly50ZXN0KHJhd1Rva2Vuc1tpZHhdKSkgeyBpZHgrKzsgY29udGludWU7IH1cblx0XHRicmVhaztcblx0fVxuXHRjb25zdCB0b2tlbnMgPSByYXdUb2tlbnMuc2xpY2UoaWR4KS5maWx0ZXIoQm9vbGVhbik7XG5cdGlmICh0b2tlbnMubGVuZ3RoID09PSAwKSByZXR1cm4gW1wiQmFzaCgqKVwiXTtcblxuXHRjb25zdCBiYXNlID0gdG9rZW5zWzBdLnJlcGxhY2UoL14uKltcXFxcL10vLCBcIlwiKS5yZXBsYWNlKC9cXC5leGUkL2ksIFwiXCIpO1xuXG5cdC8vIENvbGxlY3QgdXAgdG8gMyBzdWJjb21tYW5kIHRva2Vucywgc3RvcHBpbmcgYXQgdGhlIGZpcnN0IGZsYWcuXG5cdGNvbnN0IHN1YlRva2Vuczogc3RyaW5nW10gPSBbXTtcblx0Zm9yIChsZXQgaSA9IDE7IGkgPCB0b2tlbnMubGVuZ3RoOyBpKyspIHtcblx0XHRjb25zdCB0ID0gdG9rZW5zW2ldO1xuXHRcdGlmICh0LnN0YXJ0c1dpdGgoXCItXCIpKSBicmVhaztcblx0XHRzdWJUb2tlbnMucHVzaCh0KTtcblx0XHRpZiAoc3ViVG9rZW5zLmxlbmd0aCA+PSAzKSBicmVhaztcblx0fVxuXG5cdGNvbnN0IHBhdHRlcm5zOiBzdHJpbmdbXSA9IFtgQmFzaCgke2Jhc2V9OiopYF07XG5cdGZvciAobGV0IGkgPSAxOyBpIDw9IHN1YlRva2Vucy5sZW5ndGg7IGkrKykge1xuXHRcdHBhdHRlcm5zLnB1c2goYEJhc2goJHtbYmFzZSwgLi4uc3ViVG9rZW5zLnNsaWNlKDAsIGkpXS5qb2luKFwiIFwiKX06KilgKTtcblx0fVxuXHRyZXR1cm4gcGF0dGVybnM7XG59XG5cbi8qKlxuICogUmVhZCBCYXNoIGFsbG93LXJ1bGUgcGF0dGVybnMgZnJvbSBwcm9qZWN0IGFuZCB1c2VyIHNldHRpbmdzIGZpbGVzLlxuICpcbiAqIFJldHVybnMgdGhlIHJ1bGVDb250ZW50IHBvcnRpb24gKGUuZy4gYFwiZ2ggcHIgbGlzdDoqXCJgKSBmb3IgZWFjaFxuICogYEJhc2goLi4uKWAgZW50cnkgZm91bmQgaW4gYHBlcm1pc3Npb25zLmFsbG93YC5cbiAqL1xuZnVuY3Rpb24gcmVhZEJhc2hBbGxvd1J1bGVzRnJvbVNldHRpbmdzKCk6IHN0cmluZ1tdIHtcblx0Y29uc3QgcnVsZXM6IHN0cmluZ1tdID0gW107XG5cdGNvbnN0IHBhdGhzID0gW1xuXHRcdGpvaW4ocHJvY2Vzcy5jd2QoKSwgXCIuY2xhdWRlXCIsIFwic2V0dGluZ3MubG9jYWwuanNvblwiKSxcblx0XHRqb2luKHByb2Nlc3MuY3dkKCksIFwiLmNsYXVkZVwiLCBcInNldHRpbmdzLmpzb25cIiksXG5cdF07XG5cdHRyeSB7XG5cdFx0cGF0aHMucHVzaChqb2luKGhvbWVkaXIoKSwgXCIuY2xhdWRlXCIsIFwic2V0dGluZ3MuanNvblwiKSk7XG5cdH0gY2F0Y2gge1xuXHRcdC8vIGhvbWVkaXIoKSBjYW4gdGhyb3cgb24gc29tZSBwbGF0Zm9ybXNcblx0fVxuXHRmb3IgKGNvbnN0IHNldHRpbmdzUGF0aCBvZiBwYXRocykge1xuXHRcdHRyeSB7XG5cdFx0XHRpZiAoIWV4aXN0c1N5bmMoc2V0dGluZ3NQYXRoKSkgY29udGludWU7XG5cdFx0XHRjb25zdCByYXcgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhzZXR0aW5nc1BhdGgsIFwidXRmOFwiKSk7XG5cdFx0XHRjb25zdCBhbGxvdyA9IHJhdz8ucGVybWlzc2lvbnM/LmFsbG93O1xuXHRcdFx0aWYgKCFBcnJheS5pc0FycmF5KGFsbG93KSkgY29udGludWU7XG5cdFx0XHRmb3IgKGNvbnN0IGVudHJ5IG9mIGFsbG93KSB7XG5cdFx0XHRcdGlmICh0eXBlb2YgZW50cnkgIT09IFwic3RyaW5nXCIpIGNvbnRpbnVlO1xuXHRcdFx0XHRjb25zdCBtID0gL15CYXNoXFwoKC4rKVxcKSQvLmV4ZWMoZW50cnkpO1xuXHRcdFx0XHRpZiAobSkgcnVsZXMucHVzaChtWzFdKTtcblx0XHRcdH1cblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIElnbm9yZSBtYWxmb3JtZWQgc2V0dGluZ3MgZmlsZXNcblx0XHR9XG5cdH1cblx0cmV0dXJuIHJ1bGVzO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIGEgQmFzaCBjb21wb3VuZCBjb21tYW5kIG1hdGNoZXMgc2F2ZWQgYWxsb3cgcnVsZXMgYWZ0ZXJcbiAqIGV4dHJhY3RpbmcgdGhlIG1lYW5pbmdmdWwgc2VnbWVudC5cbiAqXG4gKiBUaGUgU0RLJ3MgYnVpbHQtaW4gbWF0Y2hlciByZWZ1c2VzIHRvIG1hdGNoIHByZWZpeCBydWxlcyBhZ2FpbnN0XG4gKiBjb21wb3VuZCBjb21tYW5kcyAoZS5nLiBgY2QgL3BhdGggJiYgZ2ggcHIgbGlzdGApLiBDbGF1ZGUgQ29kZVxuICogcm91dGluZWx5IHByZXBlbmRzIGBjZCA8Y3dkPiAmJmAgdG8gY29tbWFuZHMsIGNhdXNpbmcgc2F2ZWQgcnVsZXNcbiAqIHRvIG5ldmVyIG1hdGNoIG9uIHJlLWludm9jYXRpb24uIFRoaXMgZnVuY3Rpb24gc3RyaXBzIHNhZmUgbGVhZGluZ1xuICogc2VnbWVudHMgKG9ubHkgYGNkYCBjb21tYW5kcykgYW5kIGNoZWNrcyB0aGUgcmVtYWluaW5nIG9wZXJhdGlvblxuICogYWdhaW5zdCBzYXZlZCBydWxlcy5cbiAqXG4gKiBGb3IgY29tcG91bmQgY29tbWFuZHMsIHJldHVybnMgdHJ1ZSBvbmx5IHdoZW4gYWxsIGxlYWRpbmcgc2VnbWVudHNcbiAqIGFyZSBgY2RgIGNvbW1hbmRzIGFuZCB0aGUgZmluYWwgc2VnbWVudCBtYXRjaGVzIGEgc2F2ZWQgcnVsZS5cbiAqIEZvciBzaW1wbGUgKHNpbmdsZS1zZWdtZW50KSBjb21tYW5kcywgY2hlY2tzIGRpcmVjdGx5IGFnYWluc3Qgc2F2ZWRcbiAqIHJ1bGVzIFx1MjAxNCB0aGlzIGNvdmVycyB0aGUgY2FzZSB3aGVyZSBhIHJ1bGUgd2FzIGFkZGVkIG1pZC1zZXNzaW9uIGFuZFxuICogdGhlIFNESydzIGluLW1lbW9yeSBjYWNoZSBpcyBzdGFsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJhc2hDb21tYW5kTWF0Y2hlc1NhdmVkUnVsZXMoY29tbWFuZDogc3RyaW5nKTogYm9vbGVhbiB7XG5cdGNvbnN0IHNlZ21lbnRzID0gY29tbWFuZC5zcGxpdCgvXFxzKig/OiYmfFxcfFxcfHw7KVxccyovKS5maWx0ZXIoQm9vbGVhbik7XG5cdGlmIChzZWdtZW50cy5sZW5ndGggPT09IDApIHJldHVybiBmYWxzZTtcblxuXHRsZXQgbWVhbmluZ2Z1bDogc3RyaW5nO1xuXHRpZiAoc2VnbWVudHMubGVuZ3RoID09PSAxKSB7XG5cdFx0bWVhbmluZ2Z1bCA9IHNlZ21lbnRzWzBdLnRyaW0oKTtcblx0fSBlbHNlIHtcblx0XHQvLyBTdHJpcCB0cmFpbGluZyBlcnJvciBzdXBwcmVzc29ycyAofHwgdHJ1ZSwgfHwgOiwgfHwgZWNobyAuLi4pXG5cdFx0Ly8gYW5kIGxlYWRpbmcgY2Qgc2VnbWVudHMuICBUaGUgZmlyc3QgcmVtYWluaW5nIHNlZ21lbnQgaXMgdGhlXG5cdFx0Ly8gbWVhbmluZ2Z1bCBjb21tYW5kLiAgQWxsIG90aGVyIG5vbi1jZCwgbm9uLXN1cHByZXNzb3Igc2VnbWVudHNcblx0XHQvLyBtdXN0IGJlIGFic2VudCBcdTIwMTQgb3RoZXJ3aXNlIHdlIGNhbid0IHNhZmVseSBhdXRvLWFwcHJvdmUuXG5cdFx0Y29uc3QgU0VUVVBfUkUgPSAvXmNkXFxzLztcblx0XHRjb25zdCBTVVBQUkVTU09SX1JFID0gL15cXHMqKD86dHJ1ZXw6fGVjaG9cXGIpLztcblx0XHRjb25zdCB0cmltbWVkID0gc2VnbWVudHMuZmlsdGVyKHMgPT4gIVNVUFBSRVNTT1JfUkUudGVzdChzLnRyaW0oKSkpO1xuXHRcdGNvbnN0IGNvcmUgPSB0cmltbWVkLmZpbHRlcihzID0+ICFTRVRVUF9SRS50ZXN0KHMudHJpbSgpKSk7XG5cdFx0aWYgKGNvcmUubGVuZ3RoICE9PSAxKSByZXR1cm4gZmFsc2U7IC8vIGFtYmlndW91cyBcdTIwMTQgbXVsdGlwbGUgcmVhbCBjb21tYW5kc1xuXHRcdG1lYW5pbmdmdWwgPSBjb3JlWzBdLnRyaW0oKTtcblx0fVxuXHRpZiAoIW1lYW5pbmdmdWwpIHJldHVybiBmYWxzZTtcblxuXHRjb25zdCBydWxlcyA9IHJlYWRCYXNoQWxsb3dSdWxlc0Zyb21TZXR0aW5ncygpO1xuXHRpZiAocnVsZXMubGVuZ3RoID09PSAwKSByZXR1cm4gZmFsc2U7XG5cblx0Zm9yIChjb25zdCBydWxlIG9mIHJ1bGVzKSB7XG5cdFx0Y29uc3QgcHJlZml4TWF0Y2ggPSAvXiguKyk6XFwqJC8uZXhlYyhydWxlKTtcblx0XHRpZiAocHJlZml4TWF0Y2gpIHtcblx0XHRcdGNvbnN0IHByZWZpeCA9IHByZWZpeE1hdGNoWzFdO1xuXHRcdFx0aWYgKG1lYW5pbmdmdWwgPT09IHByZWZpeCB8fCBtZWFuaW5nZnVsLnN0YXJ0c1dpdGgocHJlZml4ICsgXCIgXCIpKSB7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fVxuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXHRcdC8vIEV4YWN0IG1hdGNoXG5cdFx0aWYgKG1lYW5pbmdmdWwgPT09IHJ1bGUpIHJldHVybiB0cnVlO1xuXHR9XG5cblx0cmV0dXJuIGZhbHNlO1xufVxuXG4vKiogRm9ybWF0IHRoZSB0b29sIGlucHV0IGludG8gYSBodW1hbi1yZWFkYWJsZSBzdW1tYXJ5IGZvciB0aGUgcGVybWlzc2lvbiBwcm9tcHQuICovXG5mdW5jdGlvbiBmb3JtYXRUb29sSW5wdXQodG9vbE5hbWU6IHN0cmluZywgaW5wdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHtcblx0Ly8gQmFzaCBcdTIwMTQgc2hvdyB0aGUgY29tbWFuZFxuXHRpZiAoaW5wdXQuY29tbWFuZCAmJiB0eXBlb2YgaW5wdXQuY29tbWFuZCA9PT0gXCJzdHJpbmdcIikge1xuXHRcdGNvbnN0IGNtZCA9IGlucHV0LmNvbW1hbmQubGVuZ3RoID4gMzAwID8gaW5wdXQuY29tbWFuZC5zbGljZSgwLCAzMDApICsgXCJcdTIwMjZcIiA6IGlucHV0LmNvbW1hbmQ7XG5cdFx0cmV0dXJuIGNtZDtcblx0fVxuXHQvLyBGaWxlLW9yaWVudGVkIHRvb2xzIFx1MjAxNCBzaG93IHBhdGhcblx0aWYgKGlucHV0LmZpbGVfcGF0aCAmJiB0eXBlb2YgaW5wdXQuZmlsZV9wYXRoID09PSBcInN0cmluZ1wiKSB7XG5cdFx0cmV0dXJuIGAke3Rvb2xOYW1lfTogJHtpbnB1dC5maWxlX3BhdGh9YDtcblx0fVxuXHQvLyBHZW5lcmljIGZhbGxiYWNrIFx1MjAxNCBjb21wYWN0IEpTT04sIHRydW5jYXRlZFxuXHRjb25zdCBqc29uID0gSlNPTi5zdHJpbmdpZnkoaW5wdXQpO1xuXHRpZiAoanNvbi5sZW5ndGggPD0gMjAwKSByZXR1cm4ganNvbjtcblx0cmV0dXJuIGpzb24uc2xpY2UoMCwgMjAwKSArIFwiXHUyMDI2XCI7XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgY2FuVXNlVG9vbCBoYW5kbGVyIHRoYXQgcm91dGVzIFNESyBwZXJtaXNzaW9uIHJlcXVlc3RzIHRocm91Z2ggdGhlXG4gKiBleHRlbnNpb24gVUkncyBzZWxlY3QgZGlhbG9nLCBvciBhdXRvLWFwcHJvdmVzIHdoZW4gbm8gVUkgaXMgYXZhaWxhYmxlLlxuICpcbiAqIFByZXNlbnRzIHRocmVlIG9wdGlvbnM6XG4gKiAtICoqQWxsb3cqKiBcdTIwMTQgYXBwcm92ZSB0aGlzIG9uZSBpbnZvY2F0aW9uXG4gKiAtICoqQWx3YXlzIEFsbG93KiogXHUyMDE0IGFwcHJvdmUgYW5kIHBhc3MgYHN1Z2dlc3Rpb25zYCBiYWNrIGFzIGB1cGRhdGVkUGVybWlzc2lvbnNgXG4gKiAgIHNvIHRoZSBTREsgcmVtZW1iZXJzIHRoZSBjaG9pY2UgZm9yIHRoZSByZXN0IG9mIHRoZSBzZXNzaW9uXG4gKiAtICoqRGVueSoqIFx1MjAxNCByZWplY3QgdGhlIGludm9jYXRpb25cbiAqXG4gKiBGb2xsb3dzIHRoZSBzYW1lIHBhdHRlcm4gYXMge0BsaW5rIGNyZWF0ZUNsYXVkZUNvZGVFbGljaXRhdGlvbkhhbmRsZXJ9OlxuICogdGFrZXMgYW4gb3B0aW9uYWwgVUkgY29udGV4dCBhbmQgcmV0dXJucyB0aGUgY2FsbGJhY2sgb3IgdW5kZWZpbmVkLlxuICpcbiAqIFdoZW4gVUkgaXMgdW5hdmFpbGFibGUgKGhlYWRsZXNzIC8gYXV0by1tb2RlIHN1Yi1hZ2VudHMpLCByZXR1cm5zIGEgaGFuZGxlclxuICogdGhhdCBhbHdheXMgYXBwcm92ZXMgXHUyMDE0IHJlcGxhY2luZyB0aGUgb2xkIEdTRF9BVVRPX01PREUgXHUyMTkyIGJ5cGFzc1Blcm1pc3Npb25zXG4gKiB3b3JrYXJvdW5kLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlQ2xhdWRlQ29kZUNhblVzZVRvb2xIYW5kbGVyKFxuXHR1aTogRXh0ZW5zaW9uVUlDb250ZXh0IHwgdW5kZWZpbmVkLFxuKTogKCh0b29sTmFtZTogc3RyaW5nLCBpbnB1dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIG9wdGlvbnM6IENhblVzZVRvb2xPcHRpb25zKSA9PiBQcm9taXNlPENhblVzZVRvb2xQZXJtaXNzaW9uUmVzdWx0PikgfCB1bmRlZmluZWQge1xuXHRpZiAoIXVpKSByZXR1cm4gdW5kZWZpbmVkO1xuXG5cdHJldHVybiBhc3luYyAodG9vbE5hbWUsIF9pbnB1dCwgb3B0aW9ucykgPT4ge1xuXHRcdC8vIEFib3J0IGVhcmx5IGlmIHRoZSBzaWduYWwgaXMgYWxyZWFkeSBmaXJlZFxuXHRcdGlmIChvcHRpb25zLnNpZ25hbC5hYm9ydGVkKSB7XG5cdFx0XHRyZXR1cm4geyBiZWhhdmlvcjogXCJkZW55XCIsIG1lc3NhZ2U6IFwiQWJvcnRlZFwiLCB0b29sVXNlSUQ6IG9wdGlvbnMudG9vbFVzZUlEIH07XG5cdFx0fVxuXG5cdFx0Ly8gRm9yIEJhc2ggY29tcG91bmQgY29tbWFuZHMgKGUuZy4gXCJjZCAvcGF0aCAmJiBnaCBwciBsaXN0XCIpLFxuXHRcdC8vIGNoZWNrIGlmIHRoZSBtZWFuaW5nZnVsIG9wZXJhdGlvbiBtYXRjaGVzIGEgc2F2ZWQgYWxsb3cgcnVsZS5cblx0XHQvLyBUaGUgU0RLJ3MgYnVpbHQtaW4gbWF0Y2hlciByZWplY3RzIHByZWZpeCBydWxlcyBmb3IgY29tcG91bmRcblx0XHQvLyBjb21tYW5kcywgYnV0IGNkLXByZWZpeGVkIGNvbW1hbmRzIGFyZSByb3V0aW5lIGFuZCB0aGUgYWN0dWFsXG5cdFx0Ly8gb3BlcmF0aW9uIGlzIGFscmVhZHkgYXBwcm92ZWQuXG5cdFx0aWYgKHRvb2xOYW1lID09PSBcIkJhc2hcIiAmJiB0eXBlb2YgX2lucHV0LmNvbW1hbmQgPT09IFwic3RyaW5nXCIpIHtcblx0XHRcdGlmIChiYXNoQ29tbWFuZE1hdGNoZXNTYXZlZFJ1bGVzKF9pbnB1dC5jb21tYW5kKSkge1xuXHRcdFx0XHRyZXR1cm4geyBiZWhhdmlvcjogXCJhbGxvd1wiLCB1cGRhdGVkSW5wdXQ6IF9pbnB1dCwgdG9vbFVzZUlEOiBvcHRpb25zLnRvb2xVc2VJRCB9O1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGNvbnN0IGlucHV0U3VtbWFyeSA9IGZvcm1hdFRvb2xJbnB1dCh0b29sTmFtZSwgX2lucHV0KTtcblx0XHRjb25zdCB0aXRsZSA9IG9wdGlvbnMudGl0bGUgfHwgYEFsbG93IENsYXVkZSBDb2RlIHRvIHVzZTogJHt0b29sTmFtZX0/YDtcblx0XHRjb25zdCBib2R5ID0gW1xuXHRcdFx0b3B0aW9ucy5kZXNjcmlwdGlvbixcblx0XHRcdGlucHV0U3VtbWFyeSxcblx0XHRdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiXFxuXCIpO1xuXG5cdFx0Ly8gVGhlIDJuZCBtZW51IChsZXZlbCBwaWNrZXIpIGxldHMgdGhlIHVzZXIgY2hvb3NlIHRoZSBleGFjdCBwYXR0ZXJuLFxuXHRcdC8vIHNvIHRoZSAxc3QgbWVudSBqdXN0IHNob3dzIFwiQWx3YXlzIEFsbG93XCIgd2l0aG91dCBhIGNvbW1hbmQgc3VmZml4LlxuXHRcdGNvbnN0IGFsd2F5c0FsbG93TGFiZWwgPSBcIkFsd2F5cyBBbGxvd1wiO1xuXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGNob2ljZSA9IGF3YWl0IHVpLnNlbGVjdChcblx0XHRcdFx0YCR7dGl0bGV9XFxuJHtib2R5fWAsXG5cdFx0XHRcdFtcIkFsbG93XCIsIGFsd2F5c0FsbG93TGFiZWwsIFwiRGVueVwiXSxcblx0XHRcdFx0eyBzaWduYWw6IG9wdGlvbnMuc2lnbmFsIH0sXG5cdFx0XHQpO1xuXG5cdFx0XHRpZiAob3B0aW9ucy5zaWduYWwuYWJvcnRlZCkge1xuXHRcdFx0XHRyZXR1cm4geyBiZWhhdmlvcjogXCJkZW55XCIsIG1lc3NhZ2U6IFwiQWJvcnRlZFwiLCB0b29sVXNlSUQ6IG9wdGlvbnMudG9vbFVzZUlEIH07XG5cdFx0XHR9XG5cblx0XHRcdGlmIChjaG9pY2UgPT09IGFsd2F5c0FsbG93TGFiZWwpIHtcblx0XHRcdFx0Ly8gUGFzcyB0aGUgU0RLJ3Mgb3duIHN1Z2dlc3Rpb25zIGJhY2sgYXMgdXBkYXRlZFBlcm1pc3Npb25zIHNvXG5cdFx0XHRcdC8vIGl0IGtub3dzIGhvdyB0byBwZXJzaXN0IHRoZW0gKFBlcm1pc3Npb25VcGRhdGVbXSBzaGFwZSkuXG5cdFx0XHRcdC8vIEZvciBCYXNoLCBwYXRjaCB0aGUgcnVsZUNvbnRlbnQgd2l0aCB0aGUgdXNlci1jaG9zZW5cblx0XHRcdFx0Ly8gZ3JhbnVsYXJpdHkgcGF0dGVybiAoZS5nLiBcImdoXCIsIFwiZ2ggcHJcIiwgXCJnaCBwciBsaXN0XCIpIHNvXG5cdFx0XHRcdC8vIHRoZSBzYXZlZCBydWxlIG1hdGNoZXMgdGhlIHNjb3BlIHRoZSB1c2VyIGFjdHVhbGx5IHdhbnRzLlxuXHRcdFx0XHRsZXQgcGVybXMgPSBvcHRpb25zLnN1Z2dlc3Rpb25zO1xuXHRcdFx0XHRsZXQgbm90aWZ5TGFiZWw6IHN0cmluZyB8IHVuZGVmaW5lZDtcblx0XHRcdFx0aWYgKHRvb2xOYW1lID09PSBcIkJhc2hcIiAmJiB0eXBlb2YgX2lucHV0LmNvbW1hbmQgPT09IFwic3RyaW5nXCIpIHtcblx0XHRcdFx0XHQvLyBQcmVzZW50IGV2ZXJ5IG1lYW5pbmdmdWwgcHJlZml4IHNvIHRoZSB1c2VyIHBpY2tzIHRoZVxuXHRcdFx0XHRcdC8vIHNjb3BlIGV4cGxpY2l0bHkgcmF0aGVyIHRoYW4gZ2V0dGluZyBhIGJsYW5rZXQgbWF0Y2guXG5cdFx0XHRcdFx0Y29uc3QgcGF0dGVybk9wdGlvbnMgPSBidWlsZEJhc2hQZXJtaXNzaW9uUGF0dGVybk9wdGlvbnMoX2lucHV0LmNvbW1hbmQpO1xuXHRcdFx0XHRcdGxldCBjaG9zZW5QYXR0ZXJuOiBzdHJpbmc7XG5cdFx0XHRcdFx0aWYgKHBhdHRlcm5PcHRpb25zLmxlbmd0aCA8PSAxKSB7XG5cdFx0XHRcdFx0XHQvLyBObyBzdWJjb21tYW5kIGNob2ljZSB0byBtYWtlIChlLmcuIFwibHMgLWxhXCIpIFx1MjAxNCB1c2Vcblx0XHRcdFx0XHRcdC8vIHRoZSBzaW5nbGUgYXZhaWxhYmxlIHBhdHRlcm4gZGlyZWN0bHkuXG5cdFx0XHRcdFx0XHRjaG9zZW5QYXR0ZXJuID0gcGF0dGVybk9wdGlvbnNbMF0gPz8gYnVpbGRCYXNoUGVybWlzc2lvblBhdHRlcm4oX2lucHV0LmNvbW1hbmQpO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRjb25zdCBsZXZlbENob2ljZVJhdyA9IGF3YWl0IHVpLnNlbGVjdChcblx0XHRcdFx0XHRcdFx0XCJTYXZlIHBlcm1pc3Npb24gYXQgd2hpY2ggbGV2ZWw/XCIsXG5cdFx0XHRcdFx0XHRcdHBhdHRlcm5PcHRpb25zLFxuXHRcdFx0XHRcdFx0XHR7IHNpZ25hbDogb3B0aW9ucy5zaWduYWwgfSxcblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRpZiAob3B0aW9ucy5zaWduYWwuYWJvcnRlZCkge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4geyBiZWhhdmlvcjogXCJkZW55XCIsIG1lc3NhZ2U6IFwiQWJvcnRlZFwiLCB0b29sVXNlSUQ6IG9wdGlvbnMudG9vbFVzZUlEIH07XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRjb25zdCBsZXZlbENob2ljZSA9IEFycmF5LmlzQXJyYXkobGV2ZWxDaG9pY2VSYXcpID8gbGV2ZWxDaG9pY2VSYXdbMF0gOiBsZXZlbENob2ljZVJhdztcblx0XHRcdFx0XHRcdGlmICghbGV2ZWxDaG9pY2UgfHwgIXBhdHRlcm5PcHRpb25zLmluY2x1ZGVzKGxldmVsQ2hvaWNlKSkge1xuXHRcdFx0XHRcdFx0XHQvLyBVc2VyIGRpc21pc3NlZCB0aGUgbGV2ZWwgcGlja2VyIFx1MjAxNCBjYW5jZWwgdGhlXG5cdFx0XHRcdFx0XHRcdC8vIHRvb2wgdXNlLiBGYWxsaW5nIGJhY2sgdG8gYSBvbmUtdGltZSBhbGxvd1xuXHRcdFx0XHRcdFx0XHQvLyBoZXJlIHdvdWxkIGxlYXZlIHRoZSBzcGF3bmVkIGFnZW50IHJ1bm5pbmdcblx0XHRcdFx0XHRcdFx0Ly8gd2l0aCBubyBjbGVhciBzaWduYWwgdGhhdCB0aGUgdXNlciBiYWlsZWQuXG5cdFx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdFx0YmVoYXZpb3I6IFwiZGVueVwiLFxuXHRcdFx0XHRcdFx0XHRcdG1lc3NhZ2U6IFwiVXNlciBjYW5jZWxsZWQgcGVybWlzc2lvbiBzZWxlY3Rpb25cIixcblx0XHRcdFx0XHRcdFx0XHR0b29sVXNlSUQ6IG9wdGlvbnMudG9vbFVzZUlELFxuXHRcdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0Y2hvc2VuUGF0dGVybiA9IGxldmVsQ2hvaWNlO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRub3RpZnlMYWJlbCA9IGNob3NlblBhdHRlcm47XG5cdFx0XHRcdFx0Ly8gRXh0cmFjdCB0aGUgcnVsZUNvbnRlbnQgcG9ydGlvbiBmcm9tIFwiQmFzaChnaCBwciBsaXN0OiopXCIgXHUyMTkyIFwiZ2ggcHIgbGlzdDoqXCJcblx0XHRcdFx0XHRjb25zdCBydWxlQ29udGVudCA9IGNob3NlblBhdHRlcm4ucmVwbGFjZSgvXkJhc2hcXCgvLCBcIlwiKS5yZXBsYWNlKC9cXCkkLywgXCJcIik7XG5cdFx0XHRcdFx0aWYgKHBlcm1zICYmIEFycmF5LmlzQXJyYXkocGVybXMpICYmIHBlcm1zLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0XHRcdC8vIENsb25lIHN1Z2dlc3Rpb25zIGFuZCBwYXRjaCBydWxlQ29udGVudCBvbiBhbnkgQmFzaCBhZGRSdWxlcyBlbnRyeVxuXHRcdFx0XHRcdFx0cGVybXMgPSBwZXJtcy5tYXAoKHM6IGFueSkgPT4ge1xuXHRcdFx0XHRcdFx0XHRpZiAocy50eXBlID09PSBcImFkZFJ1bGVzXCIgJiYgQXJyYXkuaXNBcnJheShzLnJ1bGVzKSkge1xuXHRcdFx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdFx0XHQuLi5zLFxuXHRcdFx0XHRcdFx0XHRcdFx0cnVsZXM6IHMucnVsZXMubWFwKChyOiBhbnkpID0+XG5cdFx0XHRcdFx0XHRcdFx0XHRcdHIudG9vbE5hbWUgPT09IFwiQmFzaFwiID8geyAuLi5yLCBydWxlQ29udGVudCB9IDogcixcblx0XHRcdFx0XHRcdFx0XHRcdCksXG5cdFx0XHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRyZXR1cm4gcztcblx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHQvLyBObyBzdWdnZXN0aW9ucyBmcm9tIFNESyBcdTIwMTQgYnVpbGQgYSBwcm9wZXIgUGVybWlzc2lvblVwZGF0ZVxuXHRcdFx0XHRcdFx0cGVybXMgPSBbe1xuXHRcdFx0XHRcdFx0XHR0eXBlOiBcImFkZFJ1bGVzXCIsXG5cdFx0XHRcdFx0XHRcdHJ1bGVzOiBbeyB0b29sTmFtZTogXCJCYXNoXCIsIHJ1bGVDb250ZW50IH1dLFxuXHRcdFx0XHRcdFx0XHRiZWhhdmlvcjogXCJhbGxvd1wiLFxuXHRcdFx0XHRcdFx0XHRkZXN0aW5hdGlvbjogXCJsb2NhbFNldHRpbmdzXCIsXG5cdFx0XHRcdFx0XHR9XTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0gZWxzZSBpZiAoIXBlcm1zIHx8IChBcnJheS5pc0FycmF5KHBlcm1zKSAmJiBwZXJtcy5sZW5ndGggPT09IDApKSB7XG5cdFx0XHRcdFx0Ly8gTm9uLUJhc2ggdG9vbCB3aXRoIG5vIFNESy1zdXBwbGllZCBzdWdnZXN0aW9ucy4gV2l0aG91dCBhXG5cdFx0XHRcdFx0Ly8gZmFsbGJhY2sgcnVsZSB0aGUgU0RLIHdvdWxkIHJldHVybiBgYmVoYXZpb3I6IFwiYWxsb3dcImBcblx0XHRcdFx0XHQvLyB3aXRoIG5vIGB1cGRhdGVkUGVybWlzc2lvbnNgLCBzbyBcIkFsd2F5cyBBbGxvd1wiIHNpbGVudGx5XG5cdFx0XHRcdFx0Ly8gZmFpbHMgdG8gcGVyc2lzdCBmb3IgdG9vbHMgd2hvc2UgaW5wdXQgdmFyaWVzIHBlciBjYWxsXG5cdFx0XHRcdFx0Ly8gKGUuZy4gQXNrVXNlclF1ZXN0aW9uIHdpdGggZGlmZmVyZW50IGBxdWVzdGlvbnNgIHBheWxvYWRzKS5cblx0XHRcdFx0XHQvLyBBIGJhcmUgYHsgdG9vbE5hbWUgfWAgcnVsZSBtYXRjaGVzIGFueSBpbnB1dC5cblx0XHRcdFx0XHRwZXJtcyA9IFt7XG5cdFx0XHRcdFx0XHR0eXBlOiBcImFkZFJ1bGVzXCIsXG5cdFx0XHRcdFx0XHRydWxlczogW3sgdG9vbE5hbWUgfV0sXG5cdFx0XHRcdFx0XHRiZWhhdmlvcjogXCJhbGxvd1wiLFxuXHRcdFx0XHRcdFx0ZGVzdGluYXRpb246IFwibG9jYWxTZXR0aW5nc1wiLFxuXHRcdFx0XHRcdH1dO1xuXHRcdFx0XHRcdG5vdGlmeUxhYmVsID0gdG9vbE5hbWU7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gTm90aWZ5IHdpdGggdGhlIHJlc29sdmVkIHBhdHRlcm4gKGxhYmVsIGFscmVhZHkgcHJldmlld2VkIGl0KVxuXHRcdFx0XHRpZiAobm90aWZ5TGFiZWwpIHtcblx0XHRcdFx0XHR1aS5ub3RpZnkoYFNhdmVkOiAke25vdGlmeUxhYmVsfWAsIFwiaW5mb1wiKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGJlaGF2aW9yOiBcImFsbG93XCIsXG5cdFx0XHRcdFx0dXBkYXRlZElucHV0OiBfaW5wdXQsXG5cdFx0XHRcdFx0dG9vbFVzZUlEOiBvcHRpb25zLnRvb2xVc2VJRCxcblx0XHRcdFx0XHQuLi4ocGVybXMgPyB7IHVwZGF0ZWRQZXJtaXNzaW9uczogcGVybXMgfSA6IHt9KSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKGNob2ljZSA9PT0gXCJBbGxvd1wiKSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0YmVoYXZpb3I6IFwiYWxsb3dcIixcblx0XHRcdFx0XHR1cGRhdGVkSW5wdXQ6IF9pbnB1dCxcblx0XHRcdFx0XHR0b29sVXNlSUQ6IG9wdGlvbnMudG9vbFVzZUlELFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXG5cdFx0XHRyZXR1cm4geyBiZWhhdmlvcjogXCJkZW55XCIsIG1lc3NhZ2U6IFwiVXNlciBkZW5pZWRcIiwgdG9vbFVzZUlEOiBvcHRpb25zLnRvb2xVc2VJRCB9O1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0cmV0dXJuIHsgYmVoYXZpb3I6IFwiZGVueVwiLCBtZXNzYWdlOiBcIkFib3J0ZWRcIiwgdG9vbFVzZUlEOiBvcHRpb25zLnRvb2xVc2VJRCB9O1xuXHRcdH1cblx0fTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBFbGljaXRhdGlvbiBoYW5kbGVyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIENyZWF0ZSBhbiBTREsgZWxpY2l0YXRpb24gaGFuZGxlciB0aGF0IHJvdXRlcyByZXF1ZXN0cyB0aHJvdWdoIHRoZSBleHRlbnNpb24gVUkgZGlhbG9ncywgb3IgdW5kZWZpbmVkIGlmIG5vIFVJIGlzIGF2YWlsYWJsZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVDbGF1ZGVDb2RlRWxpY2l0YXRpb25IYW5kbGVyKFxuXHR1aTogRXh0ZW5zaW9uVUlDb250ZXh0IHwgdW5kZWZpbmVkLFxuKTogKChyZXF1ZXN0OiBTZGtFbGljaXRhdGlvblJlcXVlc3QsIG9wdGlvbnM6IHsgc2lnbmFsOiBBYm9ydFNpZ25hbCB9KSA9PiBQcm9taXNlPFNka0VsaWNpdGF0aW9uUmVzdWx0PikgfCB1bmRlZmluZWQge1xuXHRpZiAoIXVpKSByZXR1cm4gdW5kZWZpbmVkO1xuXG5cdHJldHVybiBhc3luYyAocmVxdWVzdCwgeyBzaWduYWwgfSkgPT4ge1xuXHRcdGlmIChyZXF1ZXN0Lm1vZGUgPT09IFwidXJsXCIpIHtcblx0XHRcdHJldHVybiB7IGFjdGlvbjogXCJkZWNsaW5lXCIgfTtcblx0XHR9XG5cblx0XHRjb25zdCBxdWVzdGlvbnMgPSBwYXJzZUFza1VzZXJRdWVzdGlvbnNFbGljaXRhdGlvbihyZXF1ZXN0KTtcblx0XHRpZiAocXVlc3Rpb25zKSB7XG5cdFx0XHRjb25zdCBpbnRlcnZpZXdSZXN1bHQgPSBhd2FpdCBzaG93SW50ZXJ2aWV3Um91bmQocXVlc3Rpb25zLCB7IHNpZ25hbCB9LCB7IHVpIH0gYXMgYW55KS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xuXHRcdFx0aWYgKGludGVydmlld1Jlc3VsdCAmJiBPYmplY3Qua2V5cyhpbnRlcnZpZXdSZXN1bHQuYW5zd2VycykubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGFjdGlvbjogXCJhY2NlcHRcIixcblx0XHRcdFx0XHRjb250ZW50OiByb3VuZFJlc3VsdFRvRWxpY2l0YXRpb25Db250ZW50KHF1ZXN0aW9ucywgaW50ZXJ2aWV3UmVzdWx0KSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIHByb21wdEVsaWNpdGF0aW9uV2l0aERpYWxvZ3MocmVxdWVzdCwgcXVlc3Rpb25zLCB1aSwgc2lnbmFsKTtcblx0XHR9XG5cblx0XHRjb25zdCB0ZXh0RmllbGRzID0gcGFyc2VUZXh0SW5wdXRFbGljaXRhdGlvbihyZXF1ZXN0KTtcblx0XHRpZiAodGV4dEZpZWxkcykge1xuXHRcdFx0cmV0dXJuIHByb21wdFRleHRJbnB1dEVsaWNpdGF0aW9uKHJlcXVlc3QsIHRleHRGaWVsZHMsIHVpLCBzaWduYWwpO1xuXHRcdH1cblxuXHRcdHJldHVybiB7IGFjdGlvbjogXCJkZWNsaW5lXCIgfTtcblx0fTtcbn1cblxuLyoqXG4gKiBBYm9ydGVkIGJ5IHRoZSBjYWxsZXIncyBBYm9ydFNpZ25hbCBcdTIwMTQgZGlzdGluY3QgZnJvbSBleGhhdXN0aW9uLiBHU0Qnc1xuICogYWdlbnQgbG9vcCBrZXlzIG9mZiBgc3RvcFJlYXNvbiA9PT0gXCJhYm9ydGVkXCJgIHRvIHRyZWF0IHRoaXMgYXMgYSBjbGVhblxuICogdXNlciBjYW5jZWwgaW5zdGVhZCBvZiBhIHJldHJ5LWVsaWdpYmxlIHByb3ZpZGVyIGZhaWx1cmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYWtlQWJvcnRlZE1lc3NhZ2UobW9kZWw6IHN0cmluZywgbGFzdFRleHRDb250ZW50OiBzdHJpbmcpOiBBc3Npc3RhbnRNZXNzYWdlIHtcblx0Y29uc3QgbWVzc2FnZTogQXNzaXN0YW50TWVzc2FnZSA9IHtcblx0XHRyb2xlOiBcImFzc2lzdGFudFwiLFxuXHRcdGNvbnRlbnQ6IGxhc3RUZXh0Q29udGVudFxuXHRcdFx0PyBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogbGFzdFRleHRDb250ZW50IH1dXG5cdFx0XHQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkNsYXVkZSBDb2RlIHN0cmVhbSBhYm9ydGVkIGJ5IGNhbGxlclwiIH1dLFxuXHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRwcm92aWRlcjogXCJjbGF1ZGUtY29kZVwiLFxuXHRcdG1vZGVsLFxuXHRcdHVzYWdlOiB7IC4uLlpFUk9fVVNBR0UgfSxcblx0XHRzdG9wUmVhc29uOiBcImFib3J0ZWRcIixcblx0XHR0aW1lc3RhbXA6IERhdGUubm93KCksXG5cdH07XG5cdHJldHVybiBtZXNzYWdlO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFNESyBvcHRpb25zIGJ1aWxkZXJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIENsYXVkZSBDb2RlIHBlcm1pc3Npb24gbW9kZSBmb3IgdGhlIGN1cnJlbnQgcnVuLlxuICpcbiAqIERlZmF1bHRzIHRvIGBhY2NlcHRFZGl0c2AsIHdoaWNoIGF1dG8tYXBwcm92ZXMgZmlsZSByZWFkcy9lZGl0cyBidXRcbiAqIHN1cmZhY2VzIGEgcGVybWlzc2lvbiBkaWFsb2cgZm9yIGRhbmdlcm91cyBvcGVyYXRpb25zIChlLmcuIGdlbmVyYWwgQmFzaCxcbiAqIEFnZW50LCBXZWJGZXRjaCkuIFRoaXMgcHJldmVudHMgdG9vbHMgb3V0c2lkZSB0aGUgYWxsb3dsaXN0IGZyb20gYmVpbmdcbiAqIHNpbGVudGx5IGRlbmllZCBcdTIwMTQgdGhlIFNESyBlbWl0cyBhbiBgZXh0ZW5zaW9uX3VpX3JlcXVlc3RgIGV2ZW50IHNvIHRoZVxuICogdXNlciBzZWVzIGEgcHJvbXB0IGluc3RlYWQgb2YgYSBzaWxlbnQgcmVmdXNhbCB0aGF0IENsYXVkZSBDb2RlIG1pc3Rha2VzXG4gKiBmb3IgdXNlciByZWplY3Rpb24gKCM0MzgzKS5cbiAqXG4gKiBTZXQgYEdTRF9DTEFVREVfQ09ERV9QRVJNSVNTSU9OX01PREVgIHRvIGBieXBhc3NQZXJtaXNzaW9uc2AgdG8gcmVzdG9yZVxuICogdGhlIG9sZCBhbHdheXMtYXBwcm92ZSBiZWhhdmlvdXIsIG9yIHRvIGBkZWZhdWx0YCAvIGBwbGFuYCBmb3Igc3RyaWN0ZXJcbiAqIG1vZGVzLlxuICpcbiAqIFdoZW4gYEdTRF9IRUFETEVTUz0xYCBpcyBzZXQgKGF1dG8tbW9kZSAvIG5vbi1pbnRlcmFjdGl2ZSBydW5zKSwgdGhlXG4gKiBkZWZhdWx0IGZsaXBzIHRvIGBieXBhc3NQZXJtaXNzaW9uc2AgYmVjYXVzZSB0aGVyZSBpcyBubyBVSSB0byBhcHByb3ZlXG4gKiBwZXJtaXNzaW9uIGRpYWxvZ3MgXHUyMDE0IGBhY2NlcHRFZGl0c2Agd291bGQgaGFuZyB2ZXJpZmljYXRpb24gY29tbWFuZHMgbGlrZVxuICogYG5weCB0c2MgLS1ub0VtaXRgIG9yIGBucHggdml0ZXN0IHJ1bmAgaW5kZWZpbml0ZWx5ICgjNDY1NykuIEV4cGxpY2l0XG4gKiBvdmVycmlkZXMgc3RpbGwgd2luLCBzbyB1c2VycyBjYW4gb3B0IGJhY2sgaW50byBgYWNjZXB0RWRpdHNgIGluIGhlYWRsZXNzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUNsYXVkZVBlcm1pc3Npb25Nb2RlKFxuXHRlbnY6IE5vZGVKUy5Qcm9jZXNzRW52ID0gcHJvY2Vzcy5lbnYsXG4pOiBQcm9taXNlPFwiYnlwYXNzUGVybWlzc2lvbnNcIiB8IFwiYWNjZXB0RWRpdHNcIiB8IFwiZGVmYXVsdFwiIHwgXCJwbGFuXCI+IHtcblx0Y29uc3Qgb3ZlcnJpZGUgPSBlbnYuR1NEX0NMQVVERV9DT0RFX1BFUk1JU1NJT05fTU9ERT8udHJpbSgpO1xuXHRpZiAob3ZlcnJpZGUgPT09IFwiYnlwYXNzUGVybWlzc2lvbnNcIiB8fCBvdmVycmlkZSA9PT0gXCJhY2NlcHRFZGl0c1wiIHx8IG92ZXJyaWRlID09PSBcImRlZmF1bHRcIiB8fCBvdmVycmlkZSA9PT0gXCJwbGFuXCIpIHtcblx0XHRyZXR1cm4gb3ZlcnJpZGU7XG5cdH1cblx0aWYgKGVudi5HU0RfSEVBRExFU1MgPT09IFwiMVwiKSB7XG5cdFx0Y29uc29sZS53YXJuKFxuXHRcdFx0XCJbY2xhdWRlLWNvZGUtY2xpXSBIZWFkbGVzcyBtb2RlIGRldGVjdGVkIChHU0RfSEVBRExFU1M9MSk6IGRlZmF1bHRpbmcgcGVybWlzc2lvbk1vZGUgdG8gJ2J5cGFzc1Blcm1pc3Npb25zJyBzbyB2ZXJpZmljYXRpb24gQmFzaCBjb21tYW5kcyBjYW4gcnVuLiBTZXQgR1NEX0NMQVVERV9DT0RFX1BFUk1JU1NJT05fTU9ERT1hY2NlcHRFZGl0cyB0byBvcHQgb3V0LlwiLFxuXHRcdCk7XG5cdFx0cmV0dXJuIFwiYnlwYXNzUGVybWlzc2lvbnNcIjtcblx0fVxuXHRyZXR1cm4gXCJieXBhc3NQZXJtaXNzaW9uc1wiO1xufVxuXG4vLyBOT1RFOiBUaGVzZSBoZWxwZXJzIGludGVudGlvbmFsbHkgbWlycm9yIEBnc2QvcGktYWkgYW50aHJvcGljLXNoYXJlZFxuLy8gYmVoYXZpb3Igc28gdGhpcyBleHRlbnNpb24gcmVtYWlucyB0eXBlY2hlY2stc3RhYmxlIGV2ZW4gd2hlbiB0aGUgcHVibGlzaGVkXG4vLyBAZ3NkL3BpLWFpIGJhcnJlbCBsYWdzIGJlaGluZCBtb25vcmVwbyBzb3VyY2UgZXhwb3J0cy5cbi8qKiBSZXR1cm4gdHJ1ZSBmb3IgbW9kZWwgSURzIHRoYXQgc3VwcG9ydCB0aGUgYWRhcHRpdmUgdGhpbmtpbmcgQVBJIChPcHVzIDQuNi80LjcsIFNvbm5ldCA0LjYvNC43LCBIYWlrdSA0LjUpLiAqL1xuZnVuY3Rpb24gbW9kZWxTdXBwb3J0c0FkYXB0aXZlVGhpbmtpbmcobW9kZWxJZDogc3RyaW5nKTogYm9vbGVhbiB7XG5cdHJldHVybiAoXG5cdFx0bW9kZWxJZC5pbmNsdWRlcyhcIm9wdXMtNC02XCIpXG5cdFx0fHwgbW9kZWxJZC5pbmNsdWRlcyhcIm9wdXMtNC42XCIpXG5cdFx0fHwgbW9kZWxJZC5pbmNsdWRlcyhcIm9wdXMtNC03XCIpXG5cdFx0fHwgbW9kZWxJZC5pbmNsdWRlcyhcIm9wdXMtNC43XCIpXG5cdFx0fHwgbW9kZWxJZC5pbmNsdWRlcyhcInNvbm5ldC00LTZcIilcblx0XHR8fCBtb2RlbElkLmluY2x1ZGVzKFwic29ubmV0LTQuNlwiKVxuXHRcdHx8IG1vZGVsSWQuaW5jbHVkZXMoXCJzb25uZXQtNC03XCIpXG5cdFx0fHwgbW9kZWxJZC5pbmNsdWRlcyhcInNvbm5ldC00LjdcIilcblx0XHR8fCBtb2RlbElkLmluY2x1ZGVzKFwiaGFpa3UtNC01XCIpXG5cdFx0fHwgbW9kZWxJZC5pbmNsdWRlcyhcImhhaWt1LTQuNVwiKVxuXHQpO1xufVxuXG4vKiogTWFwIGEgR1NEIHRoaW5raW5nIGxldmVsIHRvIHRoZSBBbnRocm9waWMgZWZmb3J0IHZhbHVlLCBjbGFtcGluZyB4aGlnaCB0byBtYXggZm9yIG1vZGVscyB0aGF0IGxhY2sgbmF0aXZlIHhoaWdoIHN1cHBvcnQuICovXG5mdW5jdGlvbiBtYXBUaGlua2luZ0xldmVsVG9BbnRocm9waWNFZmZvcnQobGV2ZWw6IFRoaW5raW5nTGV2ZWwgfCB1bmRlZmluZWQsIG1vZGVsSWQ6IHN0cmluZyk6IFwibG93XCIgfCBcIm1lZGl1bVwiIHwgXCJoaWdoXCIgfCBcInhoaWdoXCIgfCBcIm1heFwiIHtcblx0c3dpdGNoIChsZXZlbCkge1xuXHRcdGNhc2UgXCJtaW5pbWFsXCI6XG5cdFx0Y2FzZSBcImxvd1wiOlxuXHRcdFx0cmV0dXJuIFwibG93XCI7XG5cdFx0Y2FzZSBcIm1lZGl1bVwiOlxuXHRcdFx0cmV0dXJuIFwibWVkaXVtXCI7XG5cdFx0Y2FzZSBcImhpZ2hcIjpcblx0XHRcdHJldHVybiBcImhpZ2hcIjtcblx0XHRjYXNlIFwieGhpZ2hcIjpcblx0XHRcdGlmIChtb2RlbElkLmluY2x1ZGVzKFwib3B1cy00LTdcIikgfHwgbW9kZWxJZC5pbmNsdWRlcyhcIm9wdXMtNC43XCIpKSByZXR1cm4gXCJ4aGlnaFwiO1xuXHRcdFx0aWYgKG1vZGVsSWQuaW5jbHVkZXMoXCJvcHVzLTQtNlwiKSB8fCBtb2RlbElkLmluY2x1ZGVzKFwib3B1cy00LjZcIikpIHJldHVybiBcIm1heFwiO1xuXHRcdFx0cmV0dXJuIFwiaGlnaFwiO1xuXHRcdGRlZmF1bHQ6XG5cdFx0XHRyZXR1cm4gXCJoaWdoXCI7XG5cdH1cbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgb3B0aW9ucyBvYmplY3QgcGFzc2VkIHRvIHRoZSBDbGF1ZGUgQWdlbnQgU0RLJ3MgYHF1ZXJ5KClgIGNhbGwuXG4gKlxuICogRXh0cmFjdGVkIGZvciB0ZXN0YWJpbGl0eSBcdTIwMTQgY2FsbGVycyBjYW4gdmVyaWZ5IHNlc3Npb24gcGVyc2lzdGVuY2UsXG4gKiBiZXRhIGZsYWdzLCBhbmQgb3RoZXIgY29uZmlndXJhdGlvbiB3aXRob3V0IG1vY2tpbmcgdGhlIGZ1bGwgU0RLLlxuICpcbiAqIGBwZXJtaXNzaW9uTW9kZWAgLyBgYWxsb3dEYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uc2AgYXJlIHJlc29sdmVkIHRocm91Z2hcbiAqIHtAbGluayByZXNvbHZlQ2xhdWRlUGVybWlzc2lvbk1vZGV9IHNvIGludGVyYWN0aXZlIHJ1bnMgZG9uJ3Qgc2lsZW50bHlcbiAqIGJ5cGFzcyB0aGUgU0RLJ3MgcGVybWlzc2lvbiBnYXRlLiBDYWxsZXJzIHRoYXQgd2FudCB0aGUgb2xkIGFsd2F5cy1ieXBhc3NcbiAqIGJlaGF2aW91ciBwYXNzIGBwZXJtaXNzaW9uTW9kZTogXCJieXBhc3NQZXJtaXNzaW9uc1wiYCBleHBsaWNpdGx5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTZGtPcHRpb25zKFxuXHRtb2RlbElkOiBzdHJpbmcsXG5cdHByb21wdDogc3RyaW5nLFxuXHRvdmVycmlkZXM/OiB7IHBlcm1pc3Npb25Nb2RlPzogXCJieXBhc3NQZXJtaXNzaW9uc1wiIHwgXCJhY2NlcHRFZGl0c1wiIHwgXCJkZWZhdWx0XCIgfCBcInBsYW5cIiB9LFxuXHRleHRyYU9wdGlvbnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ICYgeyByZWFzb25pbmc/OiBUaGlua2luZ0xldmVsIH0gPSB7fSxcbik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcblx0Y29uc3QgeyByZWFzb25pbmcsIGN3ZCwgLi4uc2RrRXh0cmFPcHRpb25zIH0gPSBleHRyYU9wdGlvbnM7XG5cdGNvbnN0IHNka0N3ZCA9IHR5cGVvZiBjd2QgPT09IFwic3RyaW5nXCIgJiYgY3dkLnRyaW0oKS5sZW5ndGggPiAwID8gY3dkIDogcHJvY2Vzcy5jd2QoKTtcblx0Y29uc3QgbWNwU2VydmVycyA9IGJ1aWxkV29ya2Zsb3dNY3BTZXJ2ZXJzKHNka0N3ZCk7XG5cdGNvbnN0IHBlcm1pc3Npb25Nb2RlID0gb3ZlcnJpZGVzPy5wZXJtaXNzaW9uTW9kZSA/PyBcImJ5cGFzc1Blcm1pc3Npb25zXCI7XG5cblx0Y29uc3QgcHJlZmVyZW5jZXMgPSBsb2FkUHJvamVjdEdTRFByZWZlcmVuY2VzKHNka0N3ZCk7XG5cdGNvbnN0IG1jcENvbmZpZyA9IHByZWZlcmVuY2VzPy5wcmVmZXJlbmNlcy5jbGF1ZGVfY29kZV9tY3A7XG5cdGNvbnN0IHdvcmtmbG93U2VydmVyTmFtZSA9IG1jcFNlcnZlcnMgPyBPYmplY3Qua2V5cyhtY3BTZXJ2ZXJzKVswXSA6IHVuZGVmaW5lZDtcblxuXHRsZXQgZmlsdGVyZWRNY3BTZXJ2ZXJzID0gbWNwU2VydmVycztcblx0bGV0IGV4dHJhRGlzYWxsb3dlZFRvb2xzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdGlmIChtY3BDb25maWcpIHtcblx0XHRjb25zdCBkaXNjb3ZlcmVkID0gZGlzY292ZXJNY3BTZXJ2ZXJOYW1lcyhzZGtDd2QpO1xuXHRcdGV4dHJhRGlzYWxsb3dlZFRvb2xzID0gY29tcHV0ZU1jcERpc2FsbG93ZWRUb29scyhtb2RlbElkLCBtY3BDb25maWcsIGRpc2NvdmVyZWQsIHdvcmtmbG93U2VydmVyTmFtZSk7XG5cdFx0aWYgKHdvcmtmbG93U2VydmVyTmFtZSAmJiBleHRyYURpc2FsbG93ZWRUb29scy5pbmNsdWRlcyhgbWNwX18ke3dvcmtmbG93U2VydmVyTmFtZX1fXypgKSkge1xuXHRcdFx0ZmlsdGVyZWRNY3BTZXJ2ZXJzID0gdW5kZWZpbmVkO1xuXHRcdH1cblx0fVxuXG5cdC8vIEdsb2JhbGx5IHVuYmxvY2sgdGhlIHRvb2xzIEdTRCBleHBlY3RzIENsYXVkZSBDb2RlIHRvIHJ1bi4gV2hlbiB0aGVcblx0Ly8gd29ya2Zsb3cgTUNQIHNlcnZlciBpcyBhdmFpbGFibGUsIHByZWZlciBpdHMgYGFza191c2VyX3F1ZXN0aW9uc2AgdG9vbCBvdmVyXG5cdC8vIENsYXVkZSBDb2RlJ3MgbmF0aXZlIGBBc2tVc2VyUXVlc3Rpb25gOyB0aGUgTUNQIHBhdGggY2FycmllcyBzdGFibGUgSURzIGFuZFxuXHQvLyByb3V0ZXMgcmVzcG9uc2VzIHRocm91Z2ggdGhlIEdTRCBlbGljaXRhdGlvbiBicmlkZ2UuXG5cdC8vIE9wdCBiYWNrIGludG8gZ2F0ZWQgbW9kZSB3aXRoIEdTRF9DTEFVREVfQ09ERV9QRVJNSVNTSU9OX01PREU9YWNjZXB0RWRpdHMuXG5cdGNvbnN0IHdvcmtmbG93TWNwVG9vbHMgPSBmaWx0ZXJlZE1jcFNlcnZlcnMgPyBPYmplY3Qua2V5cyhmaWx0ZXJlZE1jcFNlcnZlcnMpLm1hcCgoc2VydmVyTmFtZSkgPT4gYG1jcF9fJHtzZXJ2ZXJOYW1lfV9fKmApIDogW107XG5cdGNvbnN0IGRpc2FsbG93ZWRUb29sczogc3RyaW5nW10gPSBbLi4uKHdvcmtmbG93TWNwVG9vbHMubGVuZ3RoID4gMCA/IFtcIkFza1VzZXJRdWVzdGlvblwiXSA6IFtdKSwgLi4uZXh0cmFEaXNhbGxvd2VkVG9vbHNdO1xuXHRjb25zdCBhbGxvd2VkVG9vbHMgPSBbXG5cdFx0XCJSZWFkXCIsXG5cdFx0XCJXcml0ZVwiLFxuXHRcdFwiRWRpdFwiLFxuXHRcdFwiR2xvYlwiLFxuXHRcdFwiR3JlcFwiLFxuXHRcdFwiQmFzaFwiLFxuXHRcdFwiQWdlbnRcIixcblx0XHRcIldlYkZldGNoXCIsXG5cdFx0XCJXZWJTZWFyY2hcIixcblx0XHQuLi4od29ya2Zsb3dNY3BUb29scy5sZW5ndGggPiAwID8gd29ya2Zsb3dNY3BUb29scyA6IFtcIkFza1VzZXJRdWVzdGlvblwiXSksXG5cdF07XG5cdGNvbnN0IHN1cHBvcnRzQWRhcHRpdmUgPSBtb2RlbFN1cHBvcnRzQWRhcHRpdmVUaGlua2luZyhtb2RlbElkKTtcblx0Y29uc3QgZWZmb3J0ID1cblx0XHRyZWFzb25pbmcgJiYgc3VwcG9ydHNBZGFwdGl2ZVxuXHRcdFx0PyBtYXBUaGlua2luZ0xldmVsVG9BbnRocm9waWNFZmZvcnQocmVhc29uaW5nLCBtb2RlbElkKVxuXHRcdFx0OiB1bmRlZmluZWQ7XG5cblx0Ly8gQnVnIEI6IFNESyByZXF1aXJlcyB0aGlua2luZzp7dHlwZTpcImFkYXB0aXZlXCJ9IGFsb25nc2lkZSBlZmZvcnQgZm9yIGFkYXB0aXZlIHRoaW5raW5nIHRvIGFjdGl2YXRlLlxuXHQvLyBCdWcgQzogU0RLIHJlcXVpcmVzIHRoaW5raW5nOnt0eXBlOlwiZGlzYWJsZWRcIn0gdG8gYWN0dWFsbHkgc3RvcCBhZGFwdGl2ZSB0aGlua2luZyB3aGVuIHJlYXNvbmluZyBpcyBvZmY7XG5cdC8vICAgICAgICBvbWl0dGluZyB0aGUgZmllbGQgbGVhdmVzIHRoZSBTREsgaW4gaXRzIGFkYXB0aXZlIGRlZmF1bHQgKG9yIHBlcnNpc3RlZCBzZXNzaW9uIHN0YXRlKS5cblx0Y29uc3QgdGhpbmtpbmdDb25maWcgPSBzdXBwb3J0c0FkYXB0aXZlXG5cdFx0PyBlZmZvcnRcblx0XHRcdD8geyB0aGlua2luZzogeyB0eXBlOiBcImFkYXB0aXZlXCIgfSB9XG5cdFx0XHQ6IHsgdGhpbmtpbmc6IHsgdHlwZTogXCJkaXNhYmxlZFwiIH0gfVxuXHRcdDogdW5kZWZpbmVkO1xuXG5cdHJldHVybiB7XG5cdFx0cGF0aFRvQ2xhdWRlQ29kZUV4ZWN1dGFibGU6IGdldENsYXVkZVBhdGgoKSxcblx0XHRtb2RlbDogbW9kZWxJZCxcblx0XHRpbmNsdWRlUGFydGlhbE1lc3NhZ2VzOiB0cnVlLFxuXHRcdHBlcnNpc3RTZXNzaW9uOiB0cnVlLFxuXHRcdGN3ZDogc2RrQ3dkLFxuXHRcdHBlcm1pc3Npb25Nb2RlLFxuXHRcdGFsbG93RGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnM6IHBlcm1pc3Npb25Nb2RlID09PSBcImJ5cGFzc1Blcm1pc3Npb25zXCIsXG5cdFx0c2V0dGluZ1NvdXJjZXM6IFtcInByb2plY3RcIl0sXG5cdFx0c3lzdGVtUHJvbXB0OiB7IHR5cGU6IFwicHJlc2V0XCIsIHByZXNldDogXCJjbGF1ZGVfY29kZVwiIH0sXG5cdFx0ZGlzYWxsb3dlZFRvb2xzLFxuXHRcdC4uLihhbGxvd2VkVG9vbHMubGVuZ3RoID4gMCA/IHsgYWxsb3dlZFRvb2xzIH0gOiB7fSksXG5cdFx0Li4uKGZpbHRlcmVkTWNwU2VydmVycyA/IHsgbWNwU2VydmVyczogZmlsdGVyZWRNY3BTZXJ2ZXJzIH0gOiB7fSksXG5cdFx0YmV0YXM6IChtb2RlbElkLmluY2x1ZGVzKFwic29ubmV0XCIpIHx8IG1vZGVsSWQuaW5jbHVkZXMoXCJvcHVzLTQtN1wiKSB8fCBtb2RlbElkLmluY2x1ZGVzKFwib3B1cy00LjdcIikpID8gW1wiY29udGV4dC0xbS0yMDI1LTA4LTA3XCJdIDogW10sXG5cdFx0Li4uKHRoaW5raW5nQ29uZmlnID8/IHt9KSxcblx0XHQuLi4oZWZmb3J0ID8geyBlZmZvcnQgfSA6IHt9KSxcblx0XHQuLi5zZGtFeHRyYU9wdGlvbnMsXG5cdH07XG59XG5cbi8qKiBOb3JtYWxpc2UgaGV0ZXJvZ2VuZW91cyBTREsgdG9vbC1yZXN1bHQgY29udGVudCAoc3RyaW5nLCBhcnJheSwgb3Igb2JqZWN0KSBpbnRvIGEgdW5pZm9ybSBgRXh0ZXJuYWxUb29sUmVzdWx0Q29udGVudEJsb2NrW11gLiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplVG9vbFJlc3VsdENvbnRlbnQoY29udGVudDogdW5rbm93bik6IEV4dGVybmFsVG9vbFJlc3VsdENvbnRlbnRCbG9ja1tdIHtcblx0aWYgKHR5cGVvZiBjb250ZW50ID09PSBcInN0cmluZ1wiKSB7XG5cdFx0cmV0dXJuIFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBjb250ZW50IH1dO1xuXHR9XG5cblx0aWYgKCFBcnJheS5pc0FycmF5KGNvbnRlbnQpKSB7XG5cdFx0aWYgKGNvbnRlbnQgPT0gbnVsbCkgcmV0dXJuIFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlwiIH1dO1xuXHRcdHJldHVybiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogSlNPTi5zdHJpbmdpZnkoY29udGVudCkgfV07XG5cdH1cblxuXHRjb25zdCBibG9ja3M6IEV4dGVybmFsVG9vbFJlc3VsdENvbnRlbnRCbG9ja1tdID0gW107XG5cblx0Zm9yIChjb25zdCBpdGVtIG9mIGNvbnRlbnQpIHtcblx0XHRpZiAodHlwZW9mIGl0ZW0gPT09IFwic3RyaW5nXCIpIHtcblx0XHRcdGJsb2Nrcy5wdXNoKHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGl0ZW0gfSk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cdFx0aWYgKCFpdGVtIHx8IHR5cGVvZiBpdGVtICE9PSBcIm9iamVjdFwiKSB7XG5cdFx0XHRibG9ja3MucHVzaCh7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBTdHJpbmcoaXRlbSkgfSk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRjb25zdCBibG9jayA9IGl0ZW0gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cdFx0aWYgKGJsb2NrLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRibG9ja3MucHVzaCh7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiB0eXBlb2YgYmxvY2sudGV4dCA9PT0gXCJzdHJpbmdcIiA/IGJsb2NrLnRleHQgOiBcIlwiIH0pO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXHRcdGlmIChcblx0XHRcdGJsb2NrLnR5cGUgPT09IFwiaW1hZ2VcIlxuXHRcdFx0JiYgdHlwZW9mIGJsb2NrLmRhdGEgPT09IFwic3RyaW5nXCJcblx0XHRcdCYmIHR5cGVvZiBibG9jay5taW1lVHlwZSA9PT0gXCJzdHJpbmdcIlxuXHRcdCkge1xuXHRcdFx0YmxvY2tzLnB1c2goeyB0eXBlOiBcImltYWdlXCIsIGRhdGE6IGJsb2NrLmRhdGEsIG1pbWVUeXBlOiBibG9jay5taW1lVHlwZSB9KTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGJsb2Nrcy5wdXNoKHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IEpTT04uc3RyaW5naWZ5KGJsb2NrKSB9KTtcblx0fVxuXG5cdHJldHVybiBibG9ja3MubGVuZ3RoID4gMCA/IGJsb2NrcyA6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlwiIH1dO1xufVxuXG4vKipcbiAqIEV4dHJhY3QgYSBgZGV0YWlsc2AgcGF5bG9hZCBmcm9tIGFuIE1DUCB0b29sLXJlc3VsdCBibG9jay5cbiAqXG4gKiBNQ1AncyBgQ2FsbFRvb2xSZXN1bHRgIGNhcnJpZXMgc3RydWN0dXJlZCBkYXRhIGluIGBzdHJ1Y3R1cmVkQ29udGVudGAgXHUyMDE0IHRoZVxuICogcHJvdG9jb2wncyBzdXBwb3J0ZWQgY2hhbm5lbCBmb3Igbm9uLXRleHQgcGF5bG9hZHMuIENsYXVkZSBDb2RlJ3Mgc3ludGhldGljXG4gKiB1c2VyIG1lc3NhZ2UgbWF5IHN1cmZhY2UgdGhhdCBmaWVsZCBpbiBvbmUgb2YgdHdvIHNoYXBlcyBkZXBlbmRpbmcgb24gU0RLXG4gKiB2ZXJzaW9uOiBhcyBhIHNpYmxpbmcgb24gdGhlIGBtY3BfdG9vbF9yZXN1bHRgIGJsb2NrIGl0c2VsZiwgb3IgYXMgYVxuICogZGVkaWNhdGVkIGNvbnRlbnQgc3ViLWJsb2NrIHdpdGggYHR5cGU6IFwic3RydWN0dXJlZENvbnRlbnRcImAuIFNuYWtlLWNhc2VcbiAqIChgc3RydWN0dXJlZF9jb250ZW50YCkgaXMgYWNjZXB0ZWQgZGVmZW5zaXZlbHkgaW4gY2FzZSBhIHRyYW5zcG9ydCBob3BcbiAqIHJld3JpdGVzIGNhc2luZy4gQWxsIG90aGVyIHNoYXBlcyBmYWxsIGJhY2sgdG8gYW4gZW1wdHkgb2JqZWN0IHNvIGNhbGxlcnNcbiAqIGNhbiByZWx5IG9uIGBkZXRhaWxzYCBiZWluZyBwcmVzZW50LlxuICovXG5mdW5jdGlvbiBleHRyYWN0U3RydWN0dXJlZERldGFpbHNGcm9tQmxvY2soYmxvY2s6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQge1xuXHRjb25zdCBzaWJsaW5nID0gYmxvY2suc3RydWN0dXJlZENvbnRlbnQgPz8gKGJsb2NrIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KS5zdHJ1Y3R1cmVkX2NvbnRlbnQ7XG5cdGlmIChzaWJsaW5nICYmIHR5cGVvZiBzaWJsaW5nID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHNpYmxpbmcpKSB7XG5cdFx0cmV0dXJuIHNpYmxpbmcgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cdH1cblxuXHRpZiAoQXJyYXkuaXNBcnJheShibG9jay5jb250ZW50KSkge1xuXHRcdGZvciAoY29uc3QgaXRlbSBvZiBibG9jay5jb250ZW50KSB7XG5cdFx0XHRpZiAoIWl0ZW0gfHwgdHlwZW9mIGl0ZW0gIT09IFwib2JqZWN0XCIpIGNvbnRpbnVlO1xuXHRcdFx0Y29uc3Qgc3ViID0gaXRlbSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcblx0XHRcdGlmIChzdWIudHlwZSAhPT0gXCJzdHJ1Y3R1cmVkQ29udGVudFwiICYmIHN1Yi50eXBlICE9PSBcInN0cnVjdHVyZWRfY29udGVudFwiKSBjb250aW51ZTtcblx0XHRcdGNvbnN0IHBheWxvYWQgPSBzdWIuc3RydWN0dXJlZENvbnRlbnQgPz8gc3ViLnN0cnVjdHVyZWRfY29udGVudCA/PyBzdWIuZGF0YSA/PyBzdWIudmFsdWU7XG5cdFx0XHRpZiAocGF5bG9hZCAmJiB0eXBlb2YgcGF5bG9hZCA9PT0gXCJvYmplY3RcIiAmJiAhQXJyYXkuaXNBcnJheShwYXlsb2FkKSkge1xuXHRcdFx0XHRyZXR1cm4gcGF5bG9hZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHQvLyBSZXR1cm4gdW5kZWZpbmVkIChub3Qge30pIHdoZW4gbm8gc3RydWN0dXJlZCBwYXlsb2FkIGlzIHByZXNlbnQsIG1hdGNoaW5nXG5cdC8vIHRoZSBwcmUtIzQ0NzcgY29udHJhY3Qgd2hlcmUgYGRldGFpbHNgIHdhcyBudWxsYWJsZS4gQW4gZW1wdHktb2JqZWN0XG5cdC8vIHNlbnRpbmVsIGlzIHRydXRoeSBhbmQgYnJlYWtzIGRvd25zdHJlYW0gY29uc3VtZXJzIHRoYXQgZ2F0ZSBvblxuXHQvLyBgaWYgKGRldGFpbHMpYC4gYHVuZGVmaW5lZGAgbWF0Y2hlcyB0aGUgdHlwZSBvZiB0aGUgZmllbGQgdGhlc2UgcmVzdWx0c1xuXHQvLyBmbG93IGludG8gKGBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZGApLlxuXHRyZXR1cm4gdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIFRydWUgZm9yIGl0ZW1zIHRoYXQgYXJlIE1DUCBgc3RydWN0dXJlZENvbnRlbnRgIHBzZXVkby1ibG9ja3MgbGl2aW5nIGluc2lkZVxuICogYSB0b29sLXJlc3VsdCBgY29udGVudFtdYCBhcnJheS4gVGhlc2UgYmxvY2tzIGNhcnJ5IHRoZSBzdHJ1Y3R1cmVkIHBheWxvYWRcbiAqIChleHRyYWN0ZWQgc2VwYXJhdGVseSBieSBgZXh0cmFjdFN0cnVjdHVyZWREZXRhaWxzRnJvbUJsb2NrYCkgYW5kIG11c3QgTk9UXG4gKiBsZWFrIGludG8gdGhlIHZpc2libGUgY29udGVudCByZW5kZXJlZCB0byB0aGUgdXNlciBcdTIwMTQgb3RoZXJ3aXNlIHRoZSByZW5kZXJlclxuICogc3RyaW5naWZpZXMgdGhlIEpTT04gcHNldWRvLWJsb2NrIGFuZCBzaG93cyBpdCBuZXh0IHRvIHRoZSBhY3R1YWwgdG9vbFxuICogb3V0cHV0LiBTZWUgUFIgIzQ0NzcgcmV2aWV3IChDb2RlUmFiYml0LCBwb3N0LWZpeC1yb3VuZCkuXG4gKi9cbmZ1bmN0aW9uIGlzU3RydWN0dXJlZENvbnRlbnRQc2V1ZG9CbG9jayhpdGVtOiB1bmtub3duKTogYm9vbGVhbiB7XG5cdGlmICghaXRlbSB8fCB0eXBlb2YgaXRlbSAhPT0gXCJvYmplY3RcIikgcmV0dXJuIGZhbHNlO1xuXHRjb25zdCB0eXBlID0gKGl0ZW0gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLnR5cGU7XG5cdHJldHVybiB0eXBlID09PSBcInN0cnVjdHVyZWRDb250ZW50XCIgfHwgdHlwZSA9PT0gXCJzdHJ1Y3R1cmVkX2NvbnRlbnRcIjtcbn1cblxuLyoqXG4gKiBTdHJpcCBgc3RydWN0dXJlZENvbnRlbnRgIHBzZXVkby1ibG9ja3MgZnJvbSBhIHRvb2wtcmVzdWx0IGNvbnRlbnQgYXJyYXlcbiAqIGJlZm9yZSBub3JtYWxpemF0aW9uLiBUaGUgc3RydWN0dXJlZCBwYXlsb2FkIGlzIGV4dHJhY3RlZCB2aWEgdGhlIHNpYmxpbmdcbiAqIGBzdHJ1Y3R1cmVkQ29udGVudGAgZmllbGQgKG9yIGEgZGVkaWNhdGVkIGV4dHJhY3RvciBwYXNzIG9uIHRoZSByYXcgYmxvY2spO1xuICogdGhlIHZpc2libGUgY29udGVudCBwYXRoIG11c3Qgbm90IGluY2x1ZGUgdGhlIHBzZXVkby1ibG9jayBpdHNlbGYuXG4gKi9cbmZ1bmN0aW9uIHN0cmlwU3RydWN0dXJlZENvbnRlbnRQc2V1ZG9CbG9ja3MoY29udGVudDogdW5rbm93bik6IHVua25vd24ge1xuXHRpZiAoIUFycmF5LmlzQXJyYXkoY29udGVudCkpIHJldHVybiBjb250ZW50O1xuXHRyZXR1cm4gY29udGVudC5maWx0ZXIoKGl0ZW0pID0+ICFpc1N0cnVjdHVyZWRDb250ZW50UHNldWRvQmxvY2soaXRlbSkpO1xufVxuXG4vKiogRXh0cmFjdCB0b29sIHJlc3VsdCBwYXlsb2FkcyBmcm9tIGFuIFNESyBzeW50aGV0aWMgdXNlciBtZXNzYWdlLCBrZXllZCBieSB0b29sLXVzZSBJRC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0VG9vbFJlc3VsdHNGcm9tU2RrVXNlck1lc3NhZ2UobWVzc2FnZTogU0RLVXNlck1lc3NhZ2UpOiBBcnJheTx7XG5cdHRvb2xVc2VJZDogc3RyaW5nO1xuXHRyZXN1bHQ6IEV4dGVybmFsVG9vbFJlc3VsdFBheWxvYWQ7XG59PiB7XG5cdGNvbnN0IGV4dHJhY3RlZDogQXJyYXk8eyB0b29sVXNlSWQ6IHN0cmluZzsgcmVzdWx0OiBFeHRlcm5hbFRvb2xSZXN1bHRQYXlsb2FkIH0+ID0gW107XG5cdGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0Y29uc3QgcmF3TWVzc2FnZSA9IG1lc3NhZ2UubWVzc2FnZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwgfCB1bmRlZmluZWQ7XG5cdGNvbnN0IGNvbnRlbnQgPSBBcnJheS5pc0FycmF5KHJhd01lc3NhZ2U/LmNvbnRlbnQpID8gcmF3TWVzc2FnZS5jb250ZW50IDogW107XG5cblx0Zm9yIChjb25zdCBpdGVtIG9mIGNvbnRlbnQpIHtcblx0XHRpZiAoIWl0ZW0gfHwgdHlwZW9mIGl0ZW0gIT09IFwib2JqZWN0XCIpIGNvbnRpbnVlO1xuXHRcdGNvbnN0IGJsb2NrID0gaXRlbSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcblx0XHRjb25zdCB0eXBlID0gdHlwZW9mIGJsb2NrLnR5cGUgPT09IFwic3RyaW5nXCIgPyBibG9jay50eXBlIDogXCJcIjtcblx0XHRpZiAodHlwZSAhPT0gXCJ0b29sX3Jlc3VsdFwiICYmIHR5cGUgIT09IFwibWNwX3Rvb2xfcmVzdWx0XCIpIGNvbnRpbnVlO1xuXG5cdFx0Y29uc3QgdG9vbFVzZUlkID0gdHlwZW9mIGJsb2NrLnRvb2xfdXNlX2lkID09PSBcInN0cmluZ1wiID8gYmxvY2sudG9vbF91c2VfaWQgOiBcIlwiO1xuXHRcdGlmICghdG9vbFVzZUlkIHx8IHNlZW4uaGFzKHRvb2xVc2VJZCkpIGNvbnRpbnVlO1xuXHRcdHNlZW4uYWRkKHRvb2xVc2VJZCk7XG5cblx0XHRleHRyYWN0ZWQucHVzaCh7XG5cdFx0XHR0b29sVXNlSWQsXG5cdFx0XHRyZXN1bHQ6IHtcblx0XHRcdFx0Y29udGVudDogbm9ybWFsaXplVG9vbFJlc3VsdENvbnRlbnQoc3RyaXBTdHJ1Y3R1cmVkQ29udGVudFBzZXVkb0Jsb2NrcyhibG9jay5jb250ZW50KSksXG5cdFx0XHRcdGRldGFpbHM6IGV4dHJhY3RTdHJ1Y3R1cmVkRGV0YWlsc0Zyb21CbG9jayhibG9jayksXG5cdFx0XHRcdGlzRXJyb3I6IGJsb2NrLmlzX2Vycm9yID09PSB0cnVlLFxuXHRcdFx0fSxcblx0XHR9KTtcblx0fVxuXG5cdGlmIChleHRyYWN0ZWQubGVuZ3RoID09PSAwKSB7XG5cdFx0Y29uc3QgZmFsbGJhY2sgPSBtZXNzYWdlLnRvb2xfdXNlX3Jlc3VsdDtcblx0XHRpZiAoZmFsbGJhY2sgJiYgdHlwZW9mIGZhbGxiYWNrID09PSBcIm9iamVjdFwiKSB7XG5cdFx0XHRjb25zdCB0b29sUmVzdWx0ID0gZmFsbGJhY2sgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cdFx0XHRjb25zdCB0b29sVXNlSWQgPSB0eXBlb2YgdG9vbFJlc3VsdC50b29sX3VzZV9pZCA9PT0gXCJzdHJpbmdcIiA/IHRvb2xSZXN1bHQudG9vbF91c2VfaWQgOiBcIlwiO1xuXHRcdFx0aWYgKHRvb2xVc2VJZCkge1xuXHRcdFx0XHRleHRyYWN0ZWQucHVzaCh7XG5cdFx0XHRcdFx0dG9vbFVzZUlkLFxuXHRcdFx0XHRcdHJlc3VsdDoge1xuXHRcdFx0XHRcdFx0Y29udGVudDogbm9ybWFsaXplVG9vbFJlc3VsdENvbnRlbnQoc3RyaXBTdHJ1Y3R1cmVkQ29udGVudFBzZXVkb0Jsb2Nrcyh0b29sUmVzdWx0LmNvbnRlbnQpKSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IGV4dHJhY3RTdHJ1Y3R1cmVkRGV0YWlsc0Zyb21CbG9jayh0b29sUmVzdWx0KSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IHRvb2xSZXN1bHQuaXNfZXJyb3IgPT09IHRydWUsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIGV4dHJhY3RlZDtcbn1cblxuLyoqIEF0dGFjaCBleHRlcm5hbCB0b29sIHJlc3VsdHMgZnJvbSB0aGUgU0RLIHN5bnRoZXRpYyB1c2VyIG1lc3NhZ2UgdG8gdGhlaXIgY29ycmVzcG9uZGluZyB0b29sLWNhbGwgYmxvY2tzIGJ5IElELiAqL1xuZnVuY3Rpb24gYXR0YWNoRXh0ZXJuYWxSZXN1bHRzVG9Ub29sQmxvY2tzKFxuXHR0b29sQmxvY2tzOiBBc3Npc3RhbnRNZXNzYWdlW1wiY29udGVudFwiXSxcblx0dG9vbFJlc3VsdHNCeUlkOiBSZWFkb25seU1hcDxzdHJpbmcsIEV4dGVybmFsVG9vbFJlc3VsdFBheWxvYWQ+LFxuKTogdm9pZCB7XG5cdGZvciAoY29uc3QgYmxvY2sgb2YgdG9vbEJsb2Nrcykge1xuXHRcdGlmIChibG9jay50eXBlICE9PSBcInRvb2xDYWxsXCIgJiYgYmxvY2sudHlwZSAhPT0gXCJzZXJ2ZXJUb29sVXNlXCIpIGNvbnRpbnVlO1xuXHRcdGNvbnN0IGV4dGVybmFsUmVzdWx0ID0gdG9vbFJlc3VsdHNCeUlkLmdldChibG9jay5pZCk7XG5cdFx0aWYgKCFleHRlcm5hbFJlc3VsdCkgY29udGludWU7XG5cdFx0KGJsb2NrIGFzIFRvb2xDYWxsV2l0aEV4dGVybmFsUmVzdWx0ICYgeyBpZDogc3RyaW5nIH0pLmV4dGVybmFsUmVzdWx0ID0gZXh0ZXJuYWxSZXN1bHQ7XG5cdH1cbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgZmluYWwgYXNzaXN0YW50IGNvbnRlbnQgdGhhdCBBZ2VudCBDb3JlIGNvbnN1bWVzIGluXG4gKiBgZXh0ZXJuYWxUb29sRXhlY3V0aW9uYCBtb2RlLiBUaGlzIHByZXNlcnZlcyB0b29sLWNhbGwgYmxvY2tzLCBhdHRhY2hlcyBhbnlcbiAqIFNESy1wcm9kdWNlZCBleHRlcm5hbCByZXN1bHRzIGJ5IHRvb2wtY2FsbCBpZCwgYW5kIHRoZW4gYXBwZW5kcyB0aGUgZmluYWxcbiAqIHRleHQvdGhpbmtpbmcgYmxvY2tzIGZvciB0aGUgY29tcGxldGVkIHR1cm4uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEZpbmFsQXNzaXN0YW50Q29udGVudChwYXJhbXM6IHtcblx0aW50ZXJtZWRpYXRlVG9vbEJsb2NrczogQXNzaXN0YW50TWVzc2FnZVtcImNvbnRlbnRcIl07XG5cdHBlbmRpbmdDb250ZW50PzogQXNzaXN0YW50TWVzc2FnZVtcImNvbnRlbnRcIl07XG5cdHRvb2xSZXN1bHRzQnlJZDogUmVhZG9ubHlNYXA8c3RyaW5nLCBFeHRlcm5hbFRvb2xSZXN1bHRQYXlsb2FkPjtcblx0bGFzdFRoaW5raW5nQ29udGVudD86IHN0cmluZztcblx0bGFzdFRleHRDb250ZW50Pzogc3RyaW5nO1xuXHRmYWxsYmFja1Jlc3VsdFRleHQ/OiBzdHJpbmc7XG59KTogQXNzaXN0YW50TWVzc2FnZVtcImNvbnRlbnRcIl0ge1xuXHRjb25zdCBtZXJnZWRUb29sQmxvY2tzID0gWy4uLnBhcmFtcy5pbnRlcm1lZGlhdGVUb29sQmxvY2tzXTtcblx0aWYgKHBhcmFtcy5wZW5kaW5nQ29udGVudCkge1xuXHRcdG1lcmdlUGVuZGluZ1Rvb2xDYWxscyhtZXJnZWRUb29sQmxvY2tzLCBwYXJhbXMucGVuZGluZ0NvbnRlbnQpO1xuXHR9XG5cdGF0dGFjaEV4dGVybmFsUmVzdWx0c1RvVG9vbEJsb2NrcyhtZXJnZWRUb29sQmxvY2tzLCBwYXJhbXMudG9vbFJlc3VsdHNCeUlkKTtcblxuXHRjb25zdCBmaW5hbENvbnRlbnQ6IEFzc2lzdGFudE1lc3NhZ2VbXCJjb250ZW50XCJdID0gWy4uLm1lcmdlZFRvb2xCbG9ja3NdO1xuXHRpZiAocGFyYW1zLnBlbmRpbmdDb250ZW50ICYmIHBhcmFtcy5wZW5kaW5nQ29udGVudC5sZW5ndGggPiAwKSB7XG5cdFx0Zm9yIChjb25zdCBibG9jayBvZiBwYXJhbXMucGVuZGluZ0NvbnRlbnQpIHtcblx0XHRcdGlmIChibG9jay50eXBlID09PSBcInRleHRcIiB8fCBibG9jay50eXBlID09PSBcInRoaW5raW5nXCIpIHtcblx0XHRcdFx0ZmluYWxDb250ZW50LnB1c2goYmxvY2spO1xuXHRcdFx0fVxuXHRcdH1cblx0fSBlbHNlIHtcblx0XHRpZiAocGFyYW1zLmxhc3RUaGlua2luZ0NvbnRlbnQpIHtcblx0XHRcdGZpbmFsQ29udGVudC5wdXNoKHsgdHlwZTogXCJ0aGlua2luZ1wiLCB0aGlua2luZzogcGFyYW1zLmxhc3RUaGlua2luZ0NvbnRlbnQgfSk7XG5cdFx0fVxuXHRcdGlmIChwYXJhbXMubGFzdFRleHRDb250ZW50KSB7XG5cdFx0XHRmaW5hbENvbnRlbnQucHVzaCh7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBwYXJhbXMubGFzdFRleHRDb250ZW50IH0pO1xuXHRcdH1cblx0fVxuXG5cdGlmIChmaW5hbENvbnRlbnQubGVuZ3RoID09PSAwICYmIHBhcmFtcy5mYWxsYmFja1Jlc3VsdFRleHQpIHtcblx0XHRmaW5hbENvbnRlbnQucHVzaCh7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBwYXJhbXMuZmFsbGJhY2tSZXN1bHRUZXh0IH0pO1xuXHR9XG5cblx0cmV0dXJuIGZpbmFsQ29udGVudDtcbn1cblxuLyoqXG4gKiBNZXJnZSB0b29sLWNhbGwgYmxvY2tzIGZyb20gdGhlIGFjdGl2ZSBwYXJ0aWFsLW1lc3NhZ2UgYnVpbGRlciBpbnRvIHRoZVxuICogcnVubmluZyBsaXN0IG9mIGludGVybWVkaWF0ZSB0b29sIGNhbGxzLCBwcmVzZXJ2aW5nIG9yZGVyIGFuZCBkZS1kdXBpbmdcbiAqIGJ5IHRvb2wtY2FsbCBpZC4gRXhwb3NlZCBmb3IgdGVzdGluZyB0aGUgRjMgZml4IChmaW5hbC10dXJuIHRvb2wgY2FsbHNcbiAqIGRyb3BwZWQgd2hlbiBgcmVzdWx0YCBhcnJpdmVzIHdpdGhvdXQgYSBwcmVjZWRpbmcgc3ludGhldGljIGB1c2VyYCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJnZVBlbmRpbmdUb29sQ2FsbHMoXG5cdGludGVybWVkaWF0ZTogQXNzaXN0YW50TWVzc2FnZVtcImNvbnRlbnRcIl0sXG5cdHBlbmRpbmc6IEFzc2lzdGFudE1lc3NhZ2VbXCJjb250ZW50XCJdLFxuKTogQXNzaXN0YW50TWVzc2FnZVtcImNvbnRlbnRcIl0ge1xuXHRjb25zdCBhbHJlYWR5SW5jbHVkZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0Zm9yIChjb25zdCBibG9jayBvZiBpbnRlcm1lZGlhdGUpIHtcblx0XHRpZiAoYmxvY2sudHlwZSA9PT0gXCJ0b29sQ2FsbFwiKSBhbHJlYWR5SW5jbHVkZWQuYWRkKGJsb2NrLmlkKTtcblx0fVxuXHRmb3IgKGNvbnN0IGJsb2NrIG9mIHBlbmRpbmcpIHtcblx0XHRpZiAoYmxvY2sudHlwZSAhPT0gXCJ0b29sQ2FsbFwiKSBjb250aW51ZTtcblx0XHRpZiAoYWxyZWFkeUluY2x1ZGVkLmhhcyhibG9jay5pZCkpIGNvbnRpbnVlO1xuXHRcdGFscmVhZHlJbmNsdWRlZC5hZGQoYmxvY2suaWQpO1xuXHRcdGludGVybWVkaWF0ZS5wdXNoKGJsb2NrKTtcblx0fVxuXHRyZXR1cm4gaW50ZXJtZWRpYXRlO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIHN0cmVhbVNpbXBsZSBpbXBsZW1lbnRhdGlvblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogR1NEIHN0cmVhbVNpbXBsZSBmdW5jdGlvbiB0aGF0IGRlbGVnYXRlcyB0byB0aGUgQ2xhdWRlIEFnZW50IFNESy5cbiAqXG4gKiBFbWl0cyBBc3Npc3RhbnRNZXNzYWdlRXZlbnQgZGVsdGFzIGZvciByZWFsLXRpbWUgVFVJIHJlbmRlcmluZ1xuICogKHRoaW5raW5nLCB0ZXh0LCB0b29sIGNhbGxzKS4gVGhlIGZpbmFsIEFzc2lzdGFudE1lc3NhZ2UgcHJlc2VydmVzXG4gKiBTREstZXhlY3V0ZWQgdG9vbC1jYWxsIGJsb2NrcyBmb3IgQWdlbnQgQ29yZSdzIGBleHRlcm5hbFRvb2xFeGVjdXRpb25gXG4gKiBwYXRoLCB3aGljaCByZW5kZXJzIHRoZSByZXN1bHRzIHdpdGhvdXQgZGlzcGF0Y2hpbmcgdGhlIHRvb2xzIGxvY2FsbHkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdHJlYW1WaWFDbGF1ZGVDb2RlKFxuXHRtb2RlbDogTW9kZWw8YW55Pixcblx0Y29udGV4dDogQ29udGV4dCxcblx0b3B0aW9ucz86IFNpbXBsZVN0cmVhbU9wdGlvbnMsXG4pOiBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0ge1xuXHRjb25zdCBzdHJlYW0gPSBjcmVhdGVBc3Npc3RhbnRTdHJlYW0oKTtcblxuXHR2b2lkIHB1bXBTZGtNZXNzYWdlcyhtb2RlbCwgY29udGV4dCwgb3B0aW9ucywgc3RyZWFtKTtcblxuXHRyZXR1cm4gc3RyZWFtO1xufVxuXG4vKiogQXN5bmMgcHVtcCB0aGF0IGRyaXZlcyB0aGUgQ2xhdWRlIEFnZW50IFNESydzIGFzeW5jLWl0ZXJhYmxlIG1lc3NhZ2Ugc3RyZWFtIGFuZCBwdXNoZXMgZXZlbnRzIGludG8gYHN0cmVhbWAuICovXG5hc3luYyBmdW5jdGlvbiBwdW1wU2RrTWVzc2FnZXMoXG5cdG1vZGVsOiBNb2RlbDxhbnk+LFxuXHRjb250ZXh0OiBDb250ZXh0LFxuXHRvcHRpb25zOiBTaW1wbGVTdHJlYW1PcHRpb25zIHwgdW5kZWZpbmVkLFxuXHRzdHJlYW06IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSxcbik6IFByb21pc2U8dm9pZD4ge1xuXHRjb25zdCBtb2RlbElkID0gbW9kZWwuaWQ7XG5cdGxldCBidWlsZGVyOiBQYXJ0aWFsTWVzc2FnZUJ1aWxkZXIgfCBudWxsID0gbnVsbDtcblx0LyoqIFRyYWNrIHRoZSBsYXN0IHRleHQgY29udGVudCBzZWVuIGFjcm9zcyBhbGwgYXNzaXN0YW50IHR1cm5zIGZvciB0aGUgZmluYWwgbWVzc2FnZS4gKi9cblx0bGV0IGxhc3RUZXh0Q29udGVudCA9IFwiXCI7XG5cdGxldCBsYXN0VGhpbmtpbmdDb250ZW50ID0gXCJcIjtcblx0LyoqIENvbGxlY3QgdG9vbCBibG9ja3MgZnJvbSBpbnRlcm1lZGlhdGUgU0RLIHR1cm5zIGZvciB0b29sIGV4ZWN1dGlvbiByZW5kZXJpbmcuICovXG5cdGNvbnN0IGludGVybWVkaWF0ZVRvb2xCbG9ja3M6IEFzc2lzdGFudE1lc3NhZ2VbXCJjb250ZW50XCJdID0gW107XG5cdC8qKiBQcmVzZXJ2ZSByZWFsIGV4dGVybmFsIHRvb2wgcmVzdWx0cyBmcm9tIENsYXVkZSBDb2RlJ3Mgc3ludGhldGljIHVzZXIgbWVzc2FnZXMuICovXG5cdGNvbnN0IHRvb2xSZXN1bHRzQnlJZCA9IG5ldyBNYXA8c3RyaW5nLCBFeHRlcm5hbFRvb2xSZXN1bHRQYXlsb2FkPigpO1xuXG5cdHRyeSB7XG5cdFx0Ly8gRHluYW1pYyBpbXBvcnQgXHUyMDE0IHRoZSBTREsgaXMgYW4gb3B0aW9uYWwgZGVwZW5kZW5jeS5cblx0XHRjb25zdCBzZGtNb2R1bGUgPSBcIkBhbnRocm9waWMtYWkvY2xhdWRlLWFnZW50LXNka1wiO1xuXHRcdGNvbnN0IHNkayA9IChhd2FpdCBpbXBvcnQoLyogd2VicGFja0lnbm9yZTogdHJ1ZSAqLyBzZGtNb2R1bGUpKSBhcyB7XG5cdFx0XHRxdWVyeTogKGFyZ3M6IHtcblx0XHRcdFx0cHJvbXB0OiBzdHJpbmcgfCBBc3luY0l0ZXJhYmxlPHVua25vd24+O1xuXHRcdFx0XHRvcHRpb25zPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cdFx0XHR9KSA9PiBBc3luY0l0ZXJhYmxlPFNES01lc3NhZ2U+O1xuXHRcdH07XG5cblx0XHQvLyBCcmlkZ2UgR1NEJ3MgQWJvcnRTaWduYWwgdG8gU0RLJ3MgQWJvcnRDb250cm9sbGVyXG5cdFx0Y29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcblx0XHRpZiAob3B0aW9ucz8uc2lnbmFsKSB7XG5cdFx0XHRvcHRpb25zLnNpZ25hbC5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCB7IG9uY2U6IHRydWUgfSk7XG5cdFx0fVxuXG5cdFx0Y29uc3QgcHJvbXB0ID0gYnVpbGRQcm9tcHRGcm9tQ29udGV4dChjb250ZXh0KTtcblx0XHRjb25zdCBxdWVyeVByb21wdCA9IGJ1aWxkU2RrUXVlcnlQcm9tcHQoY29udGV4dCwgcHJvbXB0KTtcblx0XHRjb25zdCBwZXJtaXNzaW9uTW9kZSA9IGF3YWl0IHJlc29sdmVDbGF1ZGVQZXJtaXNzaW9uTW9kZSgpO1xuXHRcdGNvbnN0IHVpQ29udGV4dCA9IChvcHRpb25zIGFzIENsYXVkZUNvZGVTdHJlYW1PcHRpb25zIHwgdW5kZWZpbmVkKT8uZXh0ZW5zaW9uVUlDb250ZXh0O1xuXHRcdGNvbnN0IGN3ZCA9IHJlc29sdmVDbGF1ZGVDb2RlQ3dkKG9wdGlvbnMpO1xuXHRcdGNvbnN0IGNhblVzZVRvb2xIYW5kbGVyID0gY3JlYXRlQ2xhdWRlQ29kZUNhblVzZVRvb2xIYW5kbGVyKHVpQ29udGV4dCk7XG5cdFx0Ly8gV2hlbiBubyBVSSBpcyBhdmFpbGFibGUgKGhlYWRsZXNzIC8gYXV0by1tb2RlKSwgYXV0by1hcHByb3ZlIGFsbFxuXHRcdC8vIHRvb2wgcmVxdWVzdHMuIFRoaXMgcmVwbGFjZXMgdGhlIG9sZCBieXBhc3NQZXJtaXNzaW9ucyB3b3JrYXJvdW5kLlxuXHRcdGNvbnN0IGNhblVzZVRvb2xGYWxsYmFjayA9IGNhblVzZVRvb2xIYW5kbGVyXG5cdFx0XHQ/PyAoYXN5bmMgKF90b29sTmFtZTogc3RyaW5nLCBfaW5wdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBvcHRzOiBDYW5Vc2VUb29sT3B0aW9ucyk6IFByb21pc2U8Q2FuVXNlVG9vbFBlcm1pc3Npb25SZXN1bHQ+ID0+XG5cdFx0XHRcdCh7IGJlaGF2aW9yOiBcImFsbG93XCIsIHRvb2xVc2VJRDogb3B0cy50b29sVXNlSUQgfSkpO1xuXHRcdGNvbnN0IHNka09wdHMgPSBidWlsZFNka09wdGlvbnMoXG5cdFx0XHRtb2RlbElkLFxuXHRcdFx0cHJvbXB0LFxuXHRcdFx0eyBwZXJtaXNzaW9uTW9kZSB9LFxuXHRcdFx0e1xuXHRcdFx0XHRjd2QsXG5cdFx0XHRcdHJlYXNvbmluZzogb3B0aW9ucz8ucmVhc29uaW5nLFxuXHRcdFx0XHRjYW5Vc2VUb29sOiBjYW5Vc2VUb29sRmFsbGJhY2ssXG5cdFx0XHRcdC4uLih1aUNvbnRleHRcblx0XHRcdFx0XHQ/IHtcblx0XHRcdFx0XHRcdFx0b25FbGljaXRhdGlvbjogY3JlYXRlQ2xhdWRlQ29kZUVsaWNpdGF0aW9uSGFuZGxlcih1aUNvbnRleHQpLFxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdDoge30pLFxuXHRcdFx0fSxcblx0XHQpO1xuXG5cdFx0Y29uc3QgcXVlcnlSZXN1bHQgPSBzZGsucXVlcnkoe1xuXHRcdFx0cHJvbXB0OiBxdWVyeVByb21wdCxcblx0XHRcdG9wdGlvbnM6IHtcblx0XHRcdFx0Li4uc2RrT3B0cyxcblx0XHRcdFx0YWJvcnRDb250cm9sbGVyOiBjb250cm9sbGVyLFxuXHRcdFx0fSxcblx0XHR9KTtcblxuXHRcdC8vIEVtaXQgc3RhcnQgd2l0aCBhbiBlbXB0eSBwYXJ0aWFsXG5cdFx0Y29uc3QgaW5pdGlhbFBhcnRpYWw6IEFzc2lzdGFudE1lc3NhZ2UgPSB7XG5cdFx0XHRyb2xlOiBcImFzc2lzdGFudFwiLFxuXHRcdFx0Y29udGVudDogW10sXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJjbGF1ZGUtY29kZVwiLFxuXHRcdFx0bW9kZWw6IG1vZGVsSWQsXG5cdFx0XHR1c2FnZTogeyAuLi5aRVJPX1VTQUdFIH0sXG5cdFx0XHRzdG9wUmVhc29uOiBcInN0b3BcIixcblx0XHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0XHR9O1xuXHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJzdGFydFwiLCBwYXJ0aWFsOiBpbml0aWFsUGFydGlhbCB9KTtcblxuXHRcdGZvciBhd2FpdCAoY29uc3QgbXNnIG9mIHF1ZXJ5UmVzdWx0IGFzIEFzeW5jSXRlcmFibGU8U0RLTWVzc2FnZT4pIHtcblx0XHRcdGlmIChvcHRpb25zPy5zaWduYWw/LmFib3J0ZWQpIHtcblx0XHRcdFx0Ly8gVXNlci1pbml0aWF0ZWQgY2FuY2VsIFx1MjAxNCBlbWl0IGFuIGFib3J0ZWQgZXJyb3Igc28gdGhlIGFnZW50XG5cdFx0XHRcdC8vIGxvb3AgY2xhc3NpZmllcyB0aGlzIGFzIGEgZGVsaWJlcmF0ZSBzdG9wLCBub3QgYSB0cmFuc2llbnRcblx0XHRcdFx0Ly8gcHJvdmlkZXIgZmFpbHVyZSB0aGF0IHNob3VsZCBiZSByZXRyaWVkLlxuXHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0dHlwZTogXCJlcnJvclwiLFxuXHRcdFx0XHRcdHJlYXNvbjogXCJhYm9ydGVkXCIsXG5cdFx0XHRcdFx0ZXJyb3I6IG1ha2VBYm9ydGVkTWVzc2FnZShtb2RlbElkLCBsYXN0VGV4dENvbnRlbnQpLFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRzd2l0Y2ggKG1zZy50eXBlKSB7XG5cdFx0XHRcdC8vIC0tIEluaXQgLS1cblx0XHRcdFx0Y2FzZSBcInN5c3RlbVwiOiB7XG5cdFx0XHRcdFx0Ly8gTm90aGluZyB0byBlbWl0IFx1MjAxNCB0aGUgc3RyZWFtIGlzIGFscmVhZHkgc3RhcnRlZC5cblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIC0tIFN0cmVhbWluZyBwYXJ0aWFsIG1lc3NhZ2VzIC0tXG5cdFx0XHRcdGNhc2UgXCJzdHJlYW1fZXZlbnRcIjoge1xuXHRcdFx0XHRcdGNvbnN0IHBhcnRpYWwgPSBtc2cgYXMgU0RLUGFydGlhbEFzc2lzdGFudE1lc3NhZ2U7XG5cblx0XHRcdFx0XHRjb25zdCBldmVudCA9IHBhcnRpYWwuZXZlbnQ7XG5cblx0XHRcdFx0XHQvLyBOZXcgYXNzaXN0YW50IHR1cm4gc3RhcnRzIHdpdGggbWVzc2FnZV9zdGFydFxuXHRcdFx0XHRcdGlmIChldmVudC50eXBlID09PSBcIm1lc3NhZ2Vfc3RhcnRcIikge1xuXHRcdFx0XHRcdFx0YnVpbGRlciA9IG5ldyBQYXJ0aWFsTWVzc2FnZUJ1aWxkZXIoXG5cdFx0XHRcdFx0XHRcdChldmVudCBhcyBhbnkpLm1lc3NhZ2U/Lm1vZGVsID8/IG1vZGVsSWQsXG5cdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0aWYgKCFidWlsZGVyKSBicmVhaztcblxuXHRcdFx0XHRcdGNvbnN0IGFzc2lzdGFudEV2ZW50ID0gYnVpbGRlci5oYW5kbGVFdmVudChldmVudCk7XG5cdFx0XHRcdFx0aWYgKGFzc2lzdGFudEV2ZW50KSB7XG5cdFx0XHRcdFx0XHRzdHJlYW0ucHVzaChhc3Npc3RhbnRFdmVudCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gLS0gQ29tcGxldGUgYXNzaXN0YW50IG1lc3NhZ2UgKG5vbi1zdHJlYW1pbmcgZmFsbGJhY2spIC0tXG5cdFx0XHRcdGNhc2UgXCJhc3Npc3RhbnRcIjoge1xuXHRcdFx0XHRcdGNvbnN0IHNka0Fzc2lzdGFudCA9IG1zZyBhcyBTREtBc3Npc3RhbnRNZXNzYWdlO1xuXG5cdFx0XHRcdFx0Ly8gQ2FwdHVyZSB0ZXh0IGNvbnRlbnQgZnJvbSBjb21wbGV0ZSBtZXNzYWdlc1xuXHRcdFx0XHRcdGZvciAoY29uc3QgYmxvY2sgb2Ygc2RrQXNzaXN0YW50Lm1lc3NhZ2UuY29udGVudCkge1xuXHRcdFx0XHRcdFx0aWYgKGJsb2NrLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0XHRcdGxhc3RUZXh0Q29udGVudCA9IGJsb2NrLnRleHQ7XG5cdFx0XHRcdFx0XHR9IGVsc2UgaWYgKGJsb2NrLnR5cGUgPT09IFwidGhpbmtpbmdcIikge1xuXHRcdFx0XHRcdFx0XHRsYXN0VGhpbmtpbmdDb250ZW50ID0gYmxvY2sudGhpbmtpbmc7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gLS0gVXNlciBtZXNzYWdlIChzeW50aGV0aWMgdG9vbCByZXN1bHQgXHUyMDE0IHNpZ25hbHMgdHVybiBib3VuZGFyeSkgLS1cblx0XHRcdFx0Y2FzZSBcInVzZXJcIjoge1xuXHRcdFx0XHRcdC8vIENhcHR1cmUgY29udGVudCBmcm9tIHRoZSBjb21wbGV0ZWQgdHVybiBiZWZvcmUgcmVzZXR0aW5nXG5cdFx0XHRcdFx0aWYgKGJ1aWxkZXIpIHtcblx0XHRcdFx0XHRcdGZvciAoY29uc3QgYmxvY2sgb2YgYnVpbGRlci5tZXNzYWdlLmNvbnRlbnQpIHtcblx0XHRcdFx0XHRcdFx0aWYgKGJsb2NrLnR5cGUgPT09IFwidGV4dFwiICYmIGJsb2NrLnRleHQpIHtcblx0XHRcdFx0XHRcdFx0XHRsYXN0VGV4dENvbnRlbnQgPSBibG9jay50ZXh0O1xuXHRcdFx0XHRcdFx0XHR9IGVsc2UgaWYgKGJsb2NrLnR5cGUgPT09IFwidGhpbmtpbmdcIiAmJiBibG9jay50aGlua2luZykge1xuXHRcdFx0XHRcdFx0XHRcdGxhc3RUaGlua2luZ0NvbnRlbnQgPSBibG9jay50aGlua2luZztcblx0XHRcdFx0XHRcdFx0fSBlbHNlIGlmIChibG9jay50eXBlID09PSBcInRvb2xDYWxsXCIgfHwgYmxvY2sudHlwZSA9PT0gXCJzZXJ2ZXJUb29sVXNlXCIpIHtcblx0XHRcdFx0XHRcdFx0XHQvLyBDb2xsZWN0IHRvb2wgYmxvY2tzIGZvciBleHRlcm5hbFRvb2xFeGVjdXRpb24gcmVuZGVyaW5nXG5cdFx0XHRcdFx0XHRcdFx0aW50ZXJtZWRpYXRlVG9vbEJsb2Nrcy5wdXNoKGJsb2NrKTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdC8vIEV4dHJhY3QgdG9vbCByZXN1bHRzIGZyb20gdGhlIFNESydzIHN5bnRoZXRpYyB1c2VyIG1lc3NhZ2Vcblx0XHRcdFx0XHQvLyBhbmQgYXR0YWNoIHRvIGNvcnJlc3BvbmRpbmcgdG9vbCBjYWxsIGJsb2NrcyBpbW1lZGlhdGVseS5cblx0XHRcdFx0XHRmb3IgKGNvbnN0IHsgdG9vbFVzZUlkLCByZXN1bHQgfSBvZiBleHRyYWN0VG9vbFJlc3VsdHNGcm9tU2RrVXNlck1lc3NhZ2UobXNnIGFzIFNES1VzZXJNZXNzYWdlKSkge1xuXHRcdFx0XHRcdFx0dG9vbFJlc3VsdHNCeUlkLnNldCh0b29sVXNlSWQsIHJlc3VsdCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGF0dGFjaEV4dGVybmFsUmVzdWx0c1RvVG9vbEJsb2NrcyhpbnRlcm1lZGlhdGVUb29sQmxvY2tzLCB0b29sUmVzdWx0c0J5SWQpO1xuXG5cdFx0XHRcdFx0Ly8gUHVzaCBhIHN5bnRoZXRpYyB0b29sY2FsbF9lbmQgZm9yIGVhY2ggdG9vbCBjYWxsIGZyb20gdGhpcyB0dXJuXG5cdFx0XHRcdFx0Ly8gc28gdGhlIFRVSSBjYW4gcmVuZGVyIHRvb2wgcmVzdWx0cyBpbiByZWFsLXRpbWUgZHVyaW5nIHRoZSBTREtcblx0XHRcdFx0XHQvLyBzZXNzaW9uIGluc3RlYWQgb2Ygd2FpdGluZyB1bnRpbCB0aGUgZW50aXJlIHNlc3Npb24gY29tcGxldGVzLlxuXHRcdFx0XHRcdGlmIChidWlsZGVyKSB7XG5cdFx0XHRcdFx0XHRmb3IgKGNvbnN0IGJsb2NrIG9mIGJ1aWxkZXIubWVzc2FnZS5jb250ZW50KSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGV4dFJlc3VsdCA9IChibG9jayBhcyBUb29sQ2FsbFdpdGhFeHRlcm5hbFJlc3VsdCkuZXh0ZXJuYWxSZXN1bHQ7XG5cdFx0XHRcdFx0XHRcdGlmICghZXh0UmVzdWx0KSBjb250aW51ZTtcblx0XHRcdFx0XHRcdFx0Y29uc3QgY29udGVudEluZGV4ID0gYnVpbGRlci5tZXNzYWdlLmNvbnRlbnQuaW5kZXhPZihibG9jayk7XG5cdFx0XHRcdFx0XHRcdGlmIChjb250ZW50SW5kZXggPCAwKSBjb250aW51ZTtcblx0XHRcdFx0XHRcdFx0Ly8gUHVzaCBzeW50aGV0aWMgY29tcGxldGlvbiBldmVudHMgd2l0aCByZXN1bHQgYXR0YWNoZWQgc28gdGhlXG5cdFx0XHRcdFx0XHRcdC8vIGNoYXQtY29udHJvbGxlciBjYW4gdXBkYXRlIHBlbmRpbmcgVG9vbEV4ZWN1dGlvbkNvbXBvbmVudHMuXG5cdFx0XHRcdFx0XHRcdGlmIChibG9jay50eXBlID09PSBcInRvb2xDYWxsXCIpIHtcblx0XHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHRcdFx0XHR0eXBlOiBcInRvb2xjYWxsX2VuZFwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4LFxuXHRcdFx0XHRcdFx0XHRcdFx0dG9vbENhbGw6IGJsb2NrLFxuXHRcdFx0XHRcdFx0XHRcdFx0cGFydGlhbDogYnVpbGRlci5tZXNzYWdlLFxuXHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHR9IGVsc2UgaWYgKGJsb2NrLnR5cGUgPT09IFwic2VydmVyVG9vbFVzZVwiKSB7XG5cdFx0XHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJzZXJ2ZXJfdG9vbF91c2VcIixcblx0XHRcdFx0XHRcdFx0XHRcdGNvbnRlbnRJbmRleCxcblx0XHRcdFx0XHRcdFx0XHRcdHBhcnRpYWw6IGJ1aWxkZXIubWVzc2FnZSxcblx0XHRcdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGJ1aWxkZXIgPSBudWxsO1xuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gLS0gUmVzdWx0ICh0ZXJtaW5hbCkgLS1cblx0XHRcdFx0Y2FzZSBcInJlc3VsdFwiOiB7XG5cdFx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gbXNnIGFzIFNES1Jlc3VsdE1lc3NhZ2U7XG5cdFx0XHRcdFx0Y29uc3QgZmluYWxDb250ZW50ID0gYnVpbGRGaW5hbEFzc2lzdGFudENvbnRlbnQoe1xuXHRcdFx0XHRcdFx0aW50ZXJtZWRpYXRlVG9vbEJsb2Nrcyxcblx0XHRcdFx0XHRcdHBlbmRpbmdDb250ZW50OiBidWlsZGVyPy5tZXNzYWdlLmNvbnRlbnQsXG5cdFx0XHRcdFx0XHR0b29sUmVzdWx0c0J5SWQsXG5cdFx0XHRcdFx0XHRsYXN0VGhpbmtpbmdDb250ZW50LFxuXHRcdFx0XHRcdFx0bGFzdFRleHRDb250ZW50LFxuXHRcdFx0XHRcdFx0ZmFsbGJhY2tSZXN1bHRUZXh0OlxuXHRcdFx0XHRcdFx0XHRyZXN1bHQuc3VidHlwZSA9PT0gXCJzdWNjZXNzXCIgJiYgcmVzdWx0LnJlc3VsdCA/IHJlc3VsdC5yZXN1bHQgOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0fSk7XG5cblx0XHRcdFx0XHRjb25zdCBmaW5hbE1lc3NhZ2U6IEFzc2lzdGFudE1lc3NhZ2UgPSB7XG5cdFx0XHRcdFx0XHRyb2xlOiBcImFzc2lzdGFudFwiLFxuXHRcdFx0XHRcdFx0Y29udGVudDogZmluYWxDb250ZW50LFxuXHRcdFx0XHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0XHRcdFx0cHJvdmlkZXI6IFwiY2xhdWRlLWNvZGVcIixcblx0XHRcdFx0XHRcdG1vZGVsOiBtb2RlbElkLFxuXHRcdFx0XHRcdFx0dXNhZ2U6IG1hcFVzYWdlKHJlc3VsdC51c2FnZSwgcmVzdWx0LnRvdGFsX2Nvc3RfdXNkKSxcblx0XHRcdFx0XHRcdHN0b3BSZWFzb246IHJlc3VsdC5pc19lcnJvciA/IFwiZXJyb3JcIiA6IFwic3RvcFwiLFxuXHRcdFx0XHRcdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHRcdFx0XHRcdH07XG5cblx0XHRcdFx0XHRpZiAocmVzdWx0LmlzX2Vycm9yKSB7XG5cdFx0XHRcdFx0XHRmaW5hbE1lc3NhZ2UuZXJyb3JNZXNzYWdlID0gZ2V0UmVzdWx0RXJyb3JNZXNzYWdlKHJlc3VsdCk7XG5cdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwiZXJyb3JcIiwgcmVhc29uOiBcImVycm9yXCIsIGVycm9yOiBmaW5hbE1lc3NhZ2UgfSk7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJkb25lXCIsIHJlYXNvbjogXCJzdG9wXCIsIG1lc3NhZ2U6IGZpbmFsTWVzc2FnZSB9KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0ZGVmYXVsdDpcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBHZW5lcmF0b3IgZXhoYXVzdGlvbiB3aXRob3V0IGEgdGVybWluYWwgcmVzdWx0IGlzIGEgc3RyZWFtIGludGVycnVwdGlvbixcblx0XHQvLyBub3QgYSBzdWNjZXNzZnVsIGNvbXBsZXRpb24uIEVtaXR0aW5nIGFuIGVycm9yIGxldHMgR1NEIGNsYXNzaWZ5IGl0IGFzIGFcblx0XHQvLyB0cmFuc2llbnQgcHJvdmlkZXIgZmFpbHVyZSBpbnN0ZWFkIG9mIGFkdmFuY2luZyBhdXRvLW1vZGUgc3RhdGUuXG5cdFx0Y29uc3QgZmFsbGJhY2sgPSBtYWtlU3RyZWFtRXhoYXVzdGVkRXJyb3JNZXNzYWdlKG1vZGVsSWQsIGxhc3RUZXh0Q29udGVudCk7XG5cdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcImVycm9yXCIsIHJlYXNvbjogXCJlcnJvclwiLCBlcnJvcjogZmFsbGJhY2sgfSk7XG5cdH0gY2F0Y2ggKGVycikge1xuXHRcdGNvbnN0IGVycm9yTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdGlmIChvcHRpb25zPy5zaWduYWw/LmFib3J0ZWQgfHwgaXNDbGF1ZGVDb2RlQWJvcnRFcnJvck1lc3NhZ2UoZXJyb3JNc2cpKSB7XG5cdFx0XHRjb25zdCBhYm9ydGVkVGV4dCA9IHJlc29sdmVDbGF1ZGVDb2RlQWJvcnRlZE1lc3NhZ2VUZXh0KGVycm9yTXNnLCBsYXN0VGV4dENvbnRlbnQpO1xuXHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHR0eXBlOiBcImVycm9yXCIsXG5cdFx0XHRcdHJlYXNvbjogXCJhYm9ydGVkXCIsXG5cdFx0XHRcdGVycm9yOiBtYWtlQWJvcnRlZE1lc3NhZ2UobW9kZWxJZCwgYWJvcnRlZFRleHQpLFxuXHRcdFx0fSk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdHR5cGU6IFwiZXJyb3JcIixcblx0XHRcdHJlYXNvbjogXCJlcnJvclwiLFxuXHRcdFx0ZXJyb3I6IG1ha2VFcnJvck1lc3NhZ2UobW9kZWxJZCwgZXJyb3JNc2cpLFxuXHRcdH0pO1xu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a0JBQ0EsU0FBUyxRQUFRO0FBQUEsZ0JBQ2xCLENBQUM7QUFBQSxjQUNGO0FBQUEsWUFDRDtBQUFBLFVBQ0Q7QUFFQSxvQkFBVTtBQUNWO0FBQUEsUUFDRDtBQUFBO0FBQUEsUUFHQSxLQUFLLFVBQVU7QUFDZCxnQkFBTSxTQUFTO0FBQ2YsZ0JBQU0sZUFBZSwyQkFBMkI7QUFBQSxZQUMvQztBQUFBLFlBQ0EsZ0JBQWdCLFNBQVMsUUFBUTtBQUFBLFlBQ2pDO0FBQUEsWUFDQTtBQUFBLFlBQ0E7QUFBQSxZQUNBLG9CQUNDLE9BQU8sWUFBWSxhQUFhLE9BQU8sU0FBUyxPQUFPLFNBQVM7QUFBQSxVQUNsRSxDQUFDO0FBRUQsZ0JBQU0sZUFBaUM7QUFBQSxZQUN0QyxNQUFNO0FBQUEsWUFDTixTQUFTO0FBQUEsWUFDVCxLQUFLO0FBQUEsWUFDTCxVQUFVO0FBQUEsWUFDVixPQUFPO0FBQUEsWUFDUCxPQUFPLFNBQVMsT0FBTyxPQUFPLE9BQU8sY0FBYztBQUFBLFlBQ25ELFlBQVksT0FBTyxXQUFXLFVBQVU7QUFBQSxZQUN4QyxXQUFXLEtBQUssSUFBSTtBQUFBLFVBQ3JCO0FBRUEsY0FBSSxPQUFPLFVBQVU7QUFDcEIseUJBQWEsZUFBZSxzQkFBc0IsTUFBTTtBQUN4RCxtQkFBTyxLQUFLLEVBQUUsTUFBTSxTQUFTLFFBQVEsU0FBUyxPQUFPLGFBQWEsQ0FBQztBQUFBLFVBQ3BFLE9BQU87QUFDTixtQkFBTyxLQUFLLEVBQUUsTUFBTSxRQUFRLFFBQVEsUUFBUSxTQUFTLGFBQWEsQ0FBQztBQUFBLFVBQ3BFO0FBQ0E7QUFBQSxRQUNEO0FBQUEsUUFFQTtBQUNDO0FBQUEsTUFDRjtBQUFBLElBQ0Q7QUFLQSxVQUFNLFdBQVcsZ0NBQWdDLFNBQVMsZUFBZTtBQUN6RSxXQUFPLEtBQUssRUFBRSxNQUFNLFNBQVMsUUFBUSxTQUFTLE9BQU8sU0FBUyxDQUFDO0FBQUEsRUFDaEUsU0FBUyxLQUFLO0FBQ2IsVUFBTSxXQUFXLGVBQWUsUUFBUSxJQUFJLFVBQVUsT0FBTyxHQUFHO0FBQ2hFLFFBQUksU0FBUyxRQUFRLFdBQVcsOEJBQThCLFFBQVEsR0FBRztBQUN4RSxZQUFNLGNBQWMsb0NBQW9DLFVBQVUsZUFBZTtBQUNqRixhQUFPLEtBQUs7QUFBQSxRQUNYLE1BQU07QUFBQSxRQUNOLFFBQVE7QUFBQSxRQUNSLE9BQU8sbUJBQW1CLFNBQVMsV0FBVztBQUFBLE1BQy9DLENBQUM7QUFDRDtBQUFBLElBQ0Q7QUFDQSxXQUFPLEtBQUs7QUFBQSxNQUNYLE1BQU07QUFBQSxNQUNOLFFBQVE7QUFBQSxNQUNSLE9BQU8saUJBQWlCLFNBQVMsUUFBUTtBQUFBLElBQzFDLENBQUM7QUFBQSxFQUNGO0FBQ0Q7IiwKICAibmFtZXMiOiBbInNlbGVjdGVkIl0KfQo=
