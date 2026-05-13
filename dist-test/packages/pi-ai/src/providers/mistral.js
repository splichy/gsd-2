let _MistralClass;
async function getMistralClass() {
  if (!_MistralClass) {
    const mod = await import("@mistralai/mistralai");
    _MistralClass = mod.Mistral;
  }
  return _MistralClass;
}
import { getEnvApiKey } from "../env-api-keys.js";
import { calculateCost } from "../models.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { shortHash } from "../utils/hash.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { buildBaseOptions, clampReasoning } from "./simple-options.js";
import { transformMessagesWithReport } from "./transform-messages.js";
const MISTRAL_TOOL_CALL_ID_LENGTH = 9;
const MAX_MISTRAL_ERROR_BODY_CHARS = 4e3;
const streamMistral = (model, context, options) => {
  const stream = new AssistantMessageEventStream();
  (async () => {
    const output = createOutput(model);
    try {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider);
      if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }
      const MistralSDK = await getMistralClass();
      const mistral = new MistralSDK({
        apiKey,
        serverURL: model.baseUrl
      });
      const normalizeMistralToolCallId = createMistralToolCallIdNormalizer();
      const transformedMessages = transformMessagesWithReport(context.messages, model, (id) => normalizeMistralToolCallId(id), "mistral-conversations");
      let payload = buildChatPayload(model, context, transformedMessages, options);
      const nextPayload = await options?.onPayload?.(payload, model);
      if (nextPayload !== void 0) {
        payload = nextPayload;
      }
      const mistralStream = await mistral.chat.stream(payload, buildRequestOptions(model, options));
      stream.push({ type: "start", partial: output });
      await consumeChatStream(model, output, stream, mistralStream);
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatMistralError(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
};
const streamSimpleMistral = (model, context, options) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const base = buildBaseOptions(model, options, apiKey);
  const reasoning = clampReasoning(options?.reasoning);
  return streamMistral(model, context, {
    ...base,
    promptMode: model.reasoning && reasoning ? "reasoning" : void 0
  });
};
function createOutput(model) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  };
}
function createMistralToolCallIdNormalizer() {
  const idMap = /* @__PURE__ */ new Map();
  const reverseMap = /* @__PURE__ */ new Map();
  return (id) => {
    const existing = idMap.get(id);
    if (existing) return existing;
    let attempt = 0;
    while (true) {
      const candidate = deriveMistralToolCallId(id, attempt);
      const owner = reverseMap.get(candidate);
      if (!owner || owner === id) {
        idMap.set(id, candidate);
        reverseMap.set(candidate, id);
        return candidate;
      }
      attempt++;
    }
  };
}
function deriveMistralToolCallId(id, attempt) {
  const normalized = id.replace(/[^a-zA-Z0-9]/g, "");
  if (attempt === 0 && normalized.length === MISTRAL_TOOL_CALL_ID_LENGTH) return normalized;
  const seedBase = normalized || id;
  const seed = attempt === 0 ? seedBase : `${seedBase}:${attempt}`;
  return shortHash(seed).replace(/[^a-zA-Z0-9]/g, "").slice(0, MISTRAL_TOOL_CALL_ID_LENGTH);
}
function formatMistralError(error) {
  if (error instanceof Error) {
    const sdkError = error;
    const statusCode = typeof sdkError.statusCode === "number" ? sdkError.statusCode : void 0;
    const bodyText = typeof sdkError.body === "string" ? sdkError.body.trim() : void 0;
    if (statusCode !== void 0 && bodyText) {
      return `Mistral API error (${statusCode}): ${truncateErrorText(bodyText, MAX_MISTRAL_ERROR_BODY_CHARS)}`;
    }
    if (statusCode !== void 0) return `Mistral API error (${statusCode}): ${error.message}`;
    return error.message;
  }
  return safeJsonStringify(error);
}
function truncateErrorText(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}
function safeJsonStringify(value) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === void 0 ? String(value) : serialized;
  } catch {
    return String(value);
  }
}
function buildRequestOptions(model, options) {
  const requestOptions = {};
  if (options?.signal) requestOptions.signal = options.signal;
  requestOptions.retries = { strategy: "none" };
  const headers = {};
  if (model.headers) Object.assign(headers, model.headers);
  if (options?.headers) Object.assign(headers, options.headers);
  if (options?.sessionId && !headers["x-affinity"]) {
    headers["x-affinity"] = options.sessionId;
  }
  if (Object.keys(headers).length > 0) {
    requestOptions.headers = headers;
  }
  return requestOptions;
}
function buildChatPayload(model, context, messages, options) {
  const payload = {
    model: model.id,
    stream: true,
    messages: toChatMessages(messages, model.input.includes("image"))
  };
  if (context.tools?.length) payload.tools = toFunctionTools(context.tools);
  if (options?.temperature !== void 0) payload.temperature = options.temperature;
  if (options?.maxTokens !== void 0) payload.maxTokens = options.maxTokens;
  if (options?.toolChoice) payload.toolChoice = mapToolChoice(options.toolChoice);
  if (options?.promptMode) payload.promptMode = options.promptMode;
  if (context.systemPrompt) {
    payload.messages.unshift({
      role: "system",
      content: sanitizeSurrogates(context.systemPrompt)
    });
  }
  return payload;
}
async function consumeChatStream(model, output, stream, mistralStream) {
  let currentBlock = null;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;
  const toolBlocksByKey = /* @__PURE__ */ new Map();
  const finishCurrentBlock = (block) => {
    if (!block) return;
    if (block.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: blockIndex(),
        content: block.text,
        partial: output
      });
      return;
    }
    if (block.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: blockIndex(),
        content: block.thinking,
        partial: output
      });
    }
  };
  for await (const event of mistralStream) {
    const chunk = event.data;
    if (chunk.usage) {
      output.usage.input = chunk.usage.promptTokens || 0;
      output.usage.output = chunk.usage.completionTokens || 0;
      output.usage.cacheRead = 0;
      output.usage.cacheWrite = 0;
      output.usage.totalTokens = chunk.usage.totalTokens || output.usage.input + output.usage.output;
      calculateCost(model, output.usage);
    }
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.finishReason) {
      output.stopReason = mapChatStopReason(choice.finishReason);
    }
    const delta = choice.delta;
    if (delta.content !== null && delta.content !== void 0) {
      const contentItems = typeof delta.content === "string" ? [delta.content] : delta.content;
      for (const item of contentItems) {
        if (typeof item === "string") {
          const textDelta = sanitizeSurrogates(item);
          if (!currentBlock || currentBlock.type !== "text") {
            finishCurrentBlock(currentBlock);
            currentBlock = { type: "text", text: "" };
            output.content.push(currentBlock);
            stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
          }
          currentBlock.text += textDelta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: textDelta,
            partial: output
          });
          continue;
        }
        if (item.type === "thinking") {
          const deltaText = item.thinking.map((part) => "text" in part ? part.text : "").filter((text) => text.length > 0).join("");
          const thinkingDelta = sanitizeSurrogates(deltaText);
          if (!thinkingDelta) continue;
          if (!currentBlock || currentBlock.type !== "thinking") {
            finishCurrentBlock(currentBlock);
            currentBlock = { type: "thinking", thinking: "" };
            output.content.push(currentBlock);
            stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
          }
          currentBlock.thinking += thinkingDelta;
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: thinkingDelta,
            partial: output
          });
          continue;
        }
        if (item.type === "text") {
          const textDelta = sanitizeSurrogates(item.text);
          if (!currentBlock || currentBlock.type !== "text") {
            finishCurrentBlock(currentBlock);
            currentBlock = { type: "text", text: "" };
            output.content.push(currentBlock);
            stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
          }
          currentBlock.text += textDelta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: textDelta,
            partial: output
          });
        }
      }
    }
    const toolCalls = delta.toolCalls || [];
    for (const toolCall of toolCalls) {
      if (currentBlock) {
        finishCurrentBlock(currentBlock);
        currentBlock = null;
      }
      const callId = toolCall.id && toolCall.id !== "null" ? toolCall.id : deriveMistralToolCallId(`toolcall:${toolCall.index ?? 0}`, 0);
      const key = `${callId}:${toolCall.index || 0}`;
      const existingIndex = toolBlocksByKey.get(key);
      let block;
      if (existingIndex !== void 0) {
        const existing = output.content[existingIndex];
        if (existing?.type === "toolCall") {
          block = existing;
        }
      }
      if (!block) {
        block = {
          type: "toolCall",
          id: callId,
          name: toolCall.function.name,
          arguments: {},
          partialArgs: ""
        };
        output.content.push(block);
        toolBlocksByKey.set(key, output.content.length - 1);
        stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
      }
      const argsDelta = typeof toolCall.function.arguments === "string" ? toolCall.function.arguments : JSON.stringify(toolCall.function.arguments || {});
      block.partialArgs = (block.partialArgs || "") + argsDelta;
      block.arguments = parseStreamingJson(block.partialArgs);
      stream.push({
        type: "toolcall_delta",
        contentIndex: toolBlocksByKey.get(key),
        delta: argsDelta,
        partial: output
      });
    }
  }
  finishCurrentBlock(currentBlock);
  for (const index of toolBlocksByKey.values()) {
    const block = output.content[index];
    if (block.type !== "toolCall") continue;
    const toolBlock = block;
    toolBlock.arguments = parseStreamingJson(toolBlock.partialArgs);
    delete toolBlock.partialArgs;
    stream.push({
      type: "toolcall_end",
      contentIndex: index,
      toolCall: toolBlock,
      partial: output
    });
  }
}
function toFunctionTools(tools) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false
    }
  }));
}
function toChatMessages(messages, supportsImages) {
  const result = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: sanitizeSurrogates(msg.content) });
        continue;
      }
      const hadImages = msg.content.some((item) => item.type === "image");
      const content = msg.content.filter((item) => item.type === "text" || supportsImages).map((item) => {
        if (item.type === "text") return { type: "text", text: sanitizeSurrogates(item.text) };
        return { type: "image_url", imageUrl: `data:${item.mimeType};base64,${item.data}` };
      });
      if (content.length > 0) {
        result.push({ role: "user", content });
        continue;
      }
      if (hadImages && !supportsImages) {
        result.push({ role: "user", content: "(image omitted: model does not support images)" });
      }
      continue;
    }
    if (msg.role === "assistant") {
      const contentParts = [];
      const toolCalls = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length > 0) {
            contentParts.push({ type: "text", text: sanitizeSurrogates(block.text) });
          }
          continue;
        }
        if (block.type === "thinking") {
          if (block.thinking.trim().length > 0) {
            contentParts.push({
              type: "thinking",
              thinking: [{ type: "text", text: sanitizeSurrogates(block.thinking) }]
            });
          }
          continue;
        }
        if (block.type !== "toolCall") {
          continue;
        }
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.arguments || {}) }
        });
      }
      const assistantMessage = { role: "assistant" };
      if (contentParts.length > 0) assistantMessage.content = contentParts;
      if (toolCalls.length > 0) assistantMessage.toolCalls = toolCalls;
      if (contentParts.length > 0 || toolCalls.length > 0) result.push(assistantMessage);
      continue;
    }
    const toolContent = [];
    const textResult = msg.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? sanitizeSurrogates(part.text) : "").join("\n");
    const hasImages = msg.content.some((part) => part.type === "image");
    const toolText = buildToolResultText(textResult, hasImages, supportsImages, msg.isError);
    toolContent.push({ type: "text", text: toolText });
    for (const part of msg.content) {
      if (!supportsImages) continue;
      if (part.type !== "image") continue;
      toolContent.push({
        type: "image_url",
        imageUrl: `data:${part.mimeType};base64,${part.data}`
      });
    }
    result.push({
      role: "tool",
      toolCallId: msg.toolCallId,
      name: msg.toolName,
      content: toolContent
    });
  }
  return result;
}
function buildToolResultText(text, hasImages, supportsImages, isError) {
  const trimmed = text.trim();
  const errorPrefix = isError ? "[tool error] " : "";
  if (trimmed.length > 0) {
    const imageSuffix = hasImages && !supportsImages ? "\n[tool image omitted: model does not support images]" : "";
    return `${errorPrefix}${trimmed}${imageSuffix}`;
  }
  if (hasImages) {
    if (supportsImages) {
      return isError ? "[tool error] (see attached image)" : "(see attached image)";
    }
    return isError ? "[tool error] (image omitted: model does not support images)" : "(image omitted: model does not support images)";
  }
  return isError ? "[tool error] (no tool output)" : "(no tool output)";
}
function mapToolChoice(choice) {
  if (!choice) return void 0;
  if (choice === "auto" || choice === "none" || choice === "any" || choice === "required") {
    return choice;
  }
  return {
    type: "function",
    function: { name: choice.function.name }
  };
}
function mapChatStopReason(reason) {
  if (reason === null) return "stop";
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
    case "model_length":
      return "length";
    case "tool_calls":
      return "toolUse";
    case "error":
      return "error";
    default:
      return "stop";
  }
}
export {
  streamMistral,
  streamSimpleMistral
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy9taXN0cmFsLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBMYXp5LWxvYWRlZDogTWlzdHJhbCBTREsgKH4zNjltcykgaXMgaW1wb3J0ZWQgb24gZmlyc3QgdXNlLCBub3QgYXQgc3RhcnR1cC5cbi8vIFRoaXMgYXZvaWRzIHBlbmFsaXppbmcgdXNlcnMgd2hvIGRvbid0IHVzZSBNaXN0cmFsIG1vZGVscy5cbmltcG9ydCB0eXBlIHsgTWlzdHJhbCB9IGZyb20gXCJAbWlzdHJhbGFpL21pc3RyYWxhaVwiO1xuaW1wb3J0IHR5cGUgeyBSZXF1ZXN0T3B0aW9ucyB9IGZyb20gXCJAbWlzdHJhbGFpL21pc3RyYWxhaS9saWIvc2Rrcy5qc1wiO1xuaW1wb3J0IHR5cGUge1xuXHRDaGF0Q29tcGxldGlvblN0cmVhbVJlcXVlc3QsXG5cdENoYXRDb21wbGV0aW9uU3RyZWFtUmVxdWVzdE1lc3NhZ2VzLFxuXHRDb21wbGV0aW9uRXZlbnQsXG5cdENvbnRlbnRDaHVuayxcblx0RnVuY3Rpb25Ub29sLFxufSBmcm9tIFwiQG1pc3RyYWxhaS9taXN0cmFsYWkvbW9kZWxzL2NvbXBvbmVudHMvaW5kZXguanNcIjtcblxubGV0IF9NaXN0cmFsQ2xhc3M6IHR5cGVvZiBNaXN0cmFsIHwgdW5kZWZpbmVkO1xuYXN5bmMgZnVuY3Rpb24gZ2V0TWlzdHJhbENsYXNzKCk6IFByb21pc2U8dHlwZW9mIE1pc3RyYWw+IHtcblx0aWYgKCFfTWlzdHJhbENsYXNzKSB7XG5cdFx0Y29uc3QgbW9kID0gYXdhaXQgaW1wb3J0KFwiQG1pc3RyYWxhaS9taXN0cmFsYWlcIik7XG5cdFx0X01pc3RyYWxDbGFzcyA9IG1vZC5NaXN0cmFsO1xuXHR9XG5cdHJldHVybiBfTWlzdHJhbENsYXNzO1xufVxuaW1wb3J0IHsgZ2V0RW52QXBpS2V5IH0gZnJvbSBcIi4uL2Vudi1hcGkta2V5cy5qc1wiO1xuaW1wb3J0IHsgY2FsY3VsYXRlQ29zdCB9IGZyb20gXCIuLi9tb2RlbHMuanNcIjtcbmltcG9ydCB0eXBlIHtcblx0QXNzaXN0YW50TWVzc2FnZSxcblx0Q29udGV4dCxcblx0TWVzc2FnZSxcblx0TW9kZWwsXG5cdFNpbXBsZVN0cmVhbU9wdGlvbnMsXG5cdFN0b3BSZWFzb24sXG5cdFN0cmVhbUZ1bmN0aW9uLFxuXHRTdHJlYW1PcHRpb25zLFxuXHRUZXh0Q29udGVudCxcblx0VGhpbmtpbmdDb250ZW50LFxuXHRUb29sLFxuXHRUb29sQ2FsbCxcbn0gZnJvbSBcIi4uL3R5cGVzLmpzXCI7XG5pbXBvcnQgeyBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0gfSBmcm9tIFwiLi4vdXRpbHMvZXZlbnQtc3RyZWFtLmpzXCI7XG5pbXBvcnQgeyBzaG9ydEhhc2ggfSBmcm9tIFwiLi4vdXRpbHMvaGFzaC5qc1wiO1xuaW1wb3J0IHsgcGFyc2VTdHJlYW1pbmdKc29uIH0gZnJvbSBcIi4uL3V0aWxzL2pzb24tcGFyc2UuanNcIjtcbmltcG9ydCB7IHNhbml0aXplU3Vycm9nYXRlcyB9IGZyb20gXCIuLi91dGlscy9zYW5pdGl6ZS11bmljb2RlLmpzXCI7XG5pbXBvcnQgeyBidWlsZEJhc2VPcHRpb25zLCBjbGFtcFJlYXNvbmluZyB9IGZyb20gXCIuL3NpbXBsZS1vcHRpb25zLmpzXCI7XG5pbXBvcnQgeyB0cmFuc2Zvcm1NZXNzYWdlc1dpdGhSZXBvcnQgfSBmcm9tIFwiLi90cmFuc2Zvcm0tbWVzc2FnZXMuanNcIjtcblxuY29uc3QgTUlTVFJBTF9UT09MX0NBTExfSURfTEVOR1RIID0gOTtcbmNvbnN0IE1BWF9NSVNUUkFMX0VSUk9SX0JPRFlfQ0hBUlMgPSA0MDAwO1xuXG4vKipcbiAqIFByb3ZpZGVyLXNwZWNpZmljIG9wdGlvbnMgZm9yIHRoZSBNaXN0cmFsIEFQSS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBNaXN0cmFsT3B0aW9ucyBleHRlbmRzIFN0cmVhbU9wdGlvbnMge1xuXHR0b29sQ2hvaWNlPzogXCJhdXRvXCIgfCBcIm5vbmVcIiB8IFwiYW55XCIgfCBcInJlcXVpcmVkXCIgfCB7IHR5cGU6IFwiZnVuY3Rpb25cIjsgZnVuY3Rpb246IHsgbmFtZTogc3RyaW5nIH0gfTtcblx0cHJvbXB0TW9kZT86IFwicmVhc29uaW5nXCI7XG59XG5cbi8qKlxuICogU3RyZWFtIHJlc3BvbnNlcyBmcm9tIE1pc3RyYWwgdXNpbmcgYGNoYXQuc3RyZWFtYC5cbiAqL1xuZXhwb3J0IGNvbnN0IHN0cmVhbU1pc3RyYWw6IFN0cmVhbUZ1bmN0aW9uPFwibWlzdHJhbC1jb252ZXJzYXRpb25zXCIsIE1pc3RyYWxPcHRpb25zPiA9IChcblx0bW9kZWw6IE1vZGVsPFwibWlzdHJhbC1jb252ZXJzYXRpb25zXCI+LFxuXHRjb250ZXh0OiBDb250ZXh0LFxuXHRvcHRpb25zPzogTWlzdHJhbE9wdGlvbnMsXG4pOiBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0gPT4ge1xuXHRjb25zdCBzdHJlYW0gPSBuZXcgQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtKCk7XG5cblx0KGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBvdXRwdXQgPSBjcmVhdGVPdXRwdXQobW9kZWwpO1xuXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGFwaUtleSA9IG9wdGlvbnM/LmFwaUtleSB8fCBnZXRFbnZBcGlLZXkobW9kZWwucHJvdmlkZXIpO1xuXHRcdFx0aWYgKCFhcGlLZXkpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBObyBBUEkga2V5IGZvciBwcm92aWRlcjogJHttb2RlbC5wcm92aWRlcn1gKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gSW50ZW50aW9uYWxseSBwZXItcmVxdWVzdDogYXZvaWRzIHNoYXJlZCBTREsgbXV0YWJsZSBzdGF0ZSBhY3Jvc3MgY29uY3VycmVudCBjb25zdW1lcnMuXG5cdFx0XHRjb25zdCBNaXN0cmFsU0RLID0gYXdhaXQgZ2V0TWlzdHJhbENsYXNzKCk7XG5cdFx0XHRjb25zdCBtaXN0cmFsID0gbmV3IE1pc3RyYWxTREsoe1xuXHRcdFx0XHRhcGlLZXksXG5cdFx0XHRcdHNlcnZlclVSTDogbW9kZWwuYmFzZVVybCxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCBub3JtYWxpemVNaXN0cmFsVG9vbENhbGxJZCA9IGNyZWF0ZU1pc3RyYWxUb29sQ2FsbElkTm9ybWFsaXplcigpO1xuXHRcdFx0Y29uc3QgdHJhbnNmb3JtZWRNZXNzYWdlcyA9IHRyYW5zZm9ybU1lc3NhZ2VzV2l0aFJlcG9ydChjb250ZXh0Lm1lc3NhZ2VzLCBtb2RlbCwgKGlkKSA9PiBub3JtYWxpemVNaXN0cmFsVG9vbENhbGxJZChpZCksIFwibWlzdHJhbC1jb252ZXJzYXRpb25zXCIpO1xuXG5cdFx0XHRsZXQgcGF5bG9hZCA9IGJ1aWxkQ2hhdFBheWxvYWQobW9kZWwsIGNvbnRleHQsIHRyYW5zZm9ybWVkTWVzc2FnZXMsIG9wdGlvbnMpO1xuXHRcdFx0Y29uc3QgbmV4dFBheWxvYWQgPSBhd2FpdCBvcHRpb25zPy5vblBheWxvYWQ/LihwYXlsb2FkLCBtb2RlbCk7XG5cdFx0XHRpZiAobmV4dFBheWxvYWQgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRwYXlsb2FkID0gbmV4dFBheWxvYWQgYXMgQ2hhdENvbXBsZXRpb25TdHJlYW1SZXF1ZXN0O1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgbWlzdHJhbFN0cmVhbSA9IGF3YWl0IG1pc3RyYWwuY2hhdC5zdHJlYW0ocGF5bG9hZCwgYnVpbGRSZXF1ZXN0T3B0aW9ucyhtb2RlbCwgb3B0aW9ucykpO1xuXHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInN0YXJ0XCIsIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHRcdGF3YWl0IGNvbnN1bWVDaGF0U3RyZWFtKG1vZGVsLCBvdXRwdXQsIHN0cmVhbSwgbWlzdHJhbFN0cmVhbSk7XG5cblx0XHRcdGlmIChvcHRpb25zPy5zaWduYWw/LmFib3J0ZWQpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiUmVxdWVzdCB3YXMgYWJvcnRlZFwiKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKG91dHB1dC5zdG9wUmVhc29uID09PSBcImFib3J0ZWRcIiB8fCBvdXRwdXQuc3RvcFJlYXNvbiA9PT0gXCJlcnJvclwiKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIkFuIHVua25vd24gZXJyb3Igb2NjdXJyZWRcIik7XG5cdFx0XHR9XG5cblx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJkb25lXCIsIHJlYXNvbjogb3V0cHV0LnN0b3BSZWFzb24sIG1lc3NhZ2U6IG91dHB1dCB9KTtcblx0XHRcdHN0cmVhbS5lbmQoKTtcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0b3V0cHV0LnN0b3BSZWFzb24gPSBvcHRpb25zPy5zaWduYWw/LmFib3J0ZWQgPyBcImFib3J0ZWRcIiA6IFwiZXJyb3JcIjtcblx0XHRcdG91dHB1dC5lcnJvck1lc3NhZ2UgPSBmb3JtYXRNaXN0cmFsRXJyb3IoZXJyb3IpO1xuXHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcImVycm9yXCIsIHJlYXNvbjogb3V0cHV0LnN0b3BSZWFzb24sIGVycm9yOiBvdXRwdXQgfSk7XG5cdFx0XHRzdHJlYW0uZW5kKCk7XG5cdFx0fVxuXHR9KSgpO1xuXG5cdHJldHVybiBzdHJlYW07XG59O1xuXG4vKipcbiAqIE1hcHMgcHJvdmlkZXItYWdub3N0aWMgYFNpbXBsZVN0cmVhbU9wdGlvbnNgIHRvIE1pc3RyYWwgb3B0aW9ucy5cbiAqL1xuZXhwb3J0IGNvbnN0IHN0cmVhbVNpbXBsZU1pc3RyYWw6IFN0cmVhbUZ1bmN0aW9uPFwibWlzdHJhbC1jb252ZXJzYXRpb25zXCIsIFNpbXBsZVN0cmVhbU9wdGlvbnM+ID0gKFxuXHRtb2RlbDogTW9kZWw8XCJtaXN0cmFsLWNvbnZlcnNhdGlvbnNcIj4sXG5cdGNvbnRleHQ6IENvbnRleHQsXG5cdG9wdGlvbnM/OiBTaW1wbGVTdHJlYW1PcHRpb25zLFxuKTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtID0+IHtcblx0Y29uc3QgYXBpS2V5ID0gb3B0aW9ucz8uYXBpS2V5IHx8IGdldEVudkFwaUtleShtb2RlbC5wcm92aWRlcik7XG5cdGlmICghYXBpS2V5KSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKGBObyBBUEkga2V5IGZvciBwcm92aWRlcjogJHttb2RlbC5wcm92aWRlcn1gKTtcblx0fVxuXG5cdGNvbnN0IGJhc2UgPSBidWlsZEJhc2VPcHRpb25zKG1vZGVsLCBvcHRpb25zLCBhcGlLZXkpO1xuXHRjb25zdCByZWFzb25pbmcgPSBjbGFtcFJlYXNvbmluZyhvcHRpb25zPy5yZWFzb25pbmcpO1xuXG5cdHJldHVybiBzdHJlYW1NaXN0cmFsKG1vZGVsLCBjb250ZXh0LCB7XG5cdFx0Li4uYmFzZSxcblx0XHRwcm9tcHRNb2RlOiBtb2RlbC5yZWFzb25pbmcgJiYgcmVhc29uaW5nID8gXCJyZWFzb25pbmdcIiA6IHVuZGVmaW5lZCxcblx0fSBzYXRpc2ZpZXMgTWlzdHJhbE9wdGlvbnMpO1xufTtcblxuZnVuY3Rpb24gY3JlYXRlT3V0cHV0KG1vZGVsOiBNb2RlbDxcIm1pc3RyYWwtY29udmVyc2F0aW9uc1wiPik6IEFzc2lzdGFudE1lc3NhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdHJvbGU6IFwiYXNzaXN0YW50XCIsXG5cdFx0Y29udGVudDogW10sXG5cdFx0YXBpOiBtb2RlbC5hcGksXG5cdFx0cHJvdmlkZXI6IG1vZGVsLnByb3ZpZGVyLFxuXHRcdG1vZGVsOiBtb2RlbC5pZCxcblx0XHR1c2FnZToge1xuXHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0dG90YWxUb2tlbnM6IDAsXG5cdFx0XHRjb3N0OiB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgdG90YWw6IDAgfSxcblx0XHR9LFxuXHRcdHN0b3BSZWFzb246IFwic3RvcFwiLFxuXHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0fTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlTWlzdHJhbFRvb2xDYWxsSWROb3JtYWxpemVyKCk6IChpZDogc3RyaW5nKSA9PiBzdHJpbmcge1xuXHRjb25zdCBpZE1hcCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG5cdGNvbnN0IHJldmVyc2VNYXAgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuXG5cdHJldHVybiAoaWQ6IHN0cmluZyk6IHN0cmluZyA9PiB7XG5cdFx0Y29uc3QgZXhpc3RpbmcgPSBpZE1hcC5nZXQoaWQpO1xuXHRcdGlmIChleGlzdGluZykgcmV0dXJuIGV4aXN0aW5nO1xuXG5cdFx0bGV0IGF0dGVtcHQgPSAwO1xuXHRcdHdoaWxlICh0cnVlKSB7XG5cdFx0XHRjb25zdCBjYW5kaWRhdGUgPSBkZXJpdmVNaXN0cmFsVG9vbENhbGxJZChpZCwgYXR0ZW1wdCk7XG5cdFx0XHRjb25zdCBvd25lciA9IHJldmVyc2VNYXAuZ2V0KGNhbmRpZGF0ZSk7XG5cdFx0XHRpZiAoIW93bmVyIHx8IG93bmVyID09PSBpZCkge1xuXHRcdFx0XHRpZE1hcC5zZXQoaWQsIGNhbmRpZGF0ZSk7XG5cdFx0XHRcdHJldmVyc2VNYXAuc2V0KGNhbmRpZGF0ZSwgaWQpO1xuXHRcdFx0XHRyZXR1cm4gY2FuZGlkYXRlO1xuXHRcdFx0fVxuXHRcdFx0YXR0ZW1wdCsrO1xuXHRcdH1cblx0fTtcbn1cblxuZnVuY3Rpb24gZGVyaXZlTWlzdHJhbFRvb2xDYWxsSWQoaWQ6IHN0cmluZywgYXR0ZW1wdDogbnVtYmVyKTogc3RyaW5nIHtcblx0Y29uc3Qgbm9ybWFsaXplZCA9IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XS9nLCBcIlwiKTtcblx0aWYgKGF0dGVtcHQgPT09IDAgJiYgbm9ybWFsaXplZC5sZW5ndGggPT09IE1JU1RSQUxfVE9PTF9DQUxMX0lEX0xFTkdUSCkgcmV0dXJuIG5vcm1hbGl6ZWQ7XG5cdGNvbnN0IHNlZWRCYXNlID0gbm9ybWFsaXplZCB8fCBpZDtcblx0Y29uc3Qgc2VlZCA9IGF0dGVtcHQgPT09IDAgPyBzZWVkQmFzZSA6IGAke3NlZWRCYXNlfToke2F0dGVtcHR9YDtcblx0cmV0dXJuIHNob3J0SGFzaChzZWVkKVxuXHRcdC5yZXBsYWNlKC9bXmEtekEtWjAtOV0vZywgXCJcIilcblx0XHQuc2xpY2UoMCwgTUlTVFJBTF9UT09MX0NBTExfSURfTEVOR1RIKTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0TWlzdHJhbEVycm9yKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcblx0aWYgKGVycm9yIGluc3RhbmNlb2YgRXJyb3IpIHtcblx0XHRjb25zdCBzZGtFcnJvciA9IGVycm9yIGFzIEVycm9yICYgeyBzdGF0dXNDb2RlPzogdW5rbm93bjsgYm9keT86IHVua25vd24gfTtcblx0XHRjb25zdCBzdGF0dXNDb2RlID0gdHlwZW9mIHNka0Vycm9yLnN0YXR1c0NvZGUgPT09IFwibnVtYmVyXCIgPyBzZGtFcnJvci5zdGF0dXNDb2RlIDogdW5kZWZpbmVkO1xuXHRcdGNvbnN0IGJvZHlUZXh0ID0gdHlwZW9mIHNka0Vycm9yLmJvZHkgPT09IFwic3RyaW5nXCIgPyBzZGtFcnJvci5ib2R5LnRyaW0oKSA6IHVuZGVmaW5lZDtcblx0XHRpZiAoc3RhdHVzQ29kZSAhPT0gdW5kZWZpbmVkICYmIGJvZHlUZXh0KSB7XG5cdFx0XHRyZXR1cm4gYE1pc3RyYWwgQVBJIGVycm9yICgke3N0YXR1c0NvZGV9KTogJHt0cnVuY2F0ZUVycm9yVGV4dChib2R5VGV4dCwgTUFYX01JU1RSQUxfRVJST1JfQk9EWV9DSEFSUyl9YDtcblx0XHR9XG5cdFx0aWYgKHN0YXR1c0NvZGUgIT09IHVuZGVmaW5lZCkgcmV0dXJuIGBNaXN0cmFsIEFQSSBlcnJvciAoJHtzdGF0dXNDb2RlfSk6ICR7ZXJyb3IubWVzc2FnZX1gO1xuXHRcdHJldHVybiBlcnJvci5tZXNzYWdlO1xuXHR9XG5cdHJldHVybiBzYWZlSnNvblN0cmluZ2lmeShlcnJvcik7XG59XG5cbmZ1bmN0aW9uIHRydW5jYXRlRXJyb3JUZXh0KHRleHQ6IHN0cmluZywgbWF4Q2hhcnM6IG51bWJlcik6IHN0cmluZyB7XG5cdGlmICh0ZXh0Lmxlbmd0aCA8PSBtYXhDaGFycykgcmV0dXJuIHRleHQ7XG5cdHJldHVybiBgJHt0ZXh0LnNsaWNlKDAsIG1heENoYXJzKX0uLi4gW3RydW5jYXRlZCAke3RleHQubGVuZ3RoIC0gbWF4Q2hhcnN9IGNoYXJzXWA7XG59XG5cbmZ1bmN0aW9uIHNhZmVKc29uU3RyaW5naWZ5KHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHtcblx0dHJ5IHtcblx0XHRjb25zdCBzZXJpYWxpemVkID0gSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xuXHRcdHJldHVybiBzZXJpYWxpemVkID09PSB1bmRlZmluZWQgPyBTdHJpbmcodmFsdWUpIDogc2VyaWFsaXplZDtcblx0fSBjYXRjaCB7XG5cdFx0cmV0dXJuIFN0cmluZyh2YWx1ZSk7XG5cdH1cbn1cblxuZnVuY3Rpb24gYnVpbGRSZXF1ZXN0T3B0aW9ucyhtb2RlbDogTW9kZWw8XCJtaXN0cmFsLWNvbnZlcnNhdGlvbnNcIj4sIG9wdGlvbnM/OiBNaXN0cmFsT3B0aW9ucyk6IFJlcXVlc3RPcHRpb25zIHtcblx0Y29uc3QgcmVxdWVzdE9wdGlvbnM6IFJlcXVlc3RPcHRpb25zID0ge307XG5cdGlmIChvcHRpb25zPy5zaWduYWwpIHJlcXVlc3RPcHRpb25zLnNpZ25hbCA9IG9wdGlvbnMuc2lnbmFsO1xuXHRyZXF1ZXN0T3B0aW9ucy5yZXRyaWVzID0geyBzdHJhdGVneTogXCJub25lXCIgfTtcblxuXHRjb25zdCBoZWFkZXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG5cdGlmIChtb2RlbC5oZWFkZXJzKSBPYmplY3QuYXNzaWduKGhlYWRlcnMsIG1vZGVsLmhlYWRlcnMpO1xuXHRpZiAob3B0aW9ucz8uaGVhZGVycykgT2JqZWN0LmFzc2lnbihoZWFkZXJzLCBvcHRpb25zLmhlYWRlcnMpO1xuXG5cdC8vIE1pc3RyYWwgaW5mcmFzdHJ1Y3R1cmUgdXNlcyBgeC1hZmZpbml0eWAgZm9yIEtWLWNhY2hlIHJldXNlIChwcmVmaXggY2FjaGluZykuXG5cdC8vIFJlc3BlY3QgZXhwbGljaXQgY2FsbGVyLXByb3ZpZGVkIGhlYWRlciB2YWx1ZXMuXG5cdGlmIChvcHRpb25zPy5zZXNzaW9uSWQgJiYgIWhlYWRlcnNbXCJ4LWFmZmluaXR5XCJdKSB7XG5cdFx0aGVhZGVyc1tcIngtYWZmaW5pdHlcIl0gPSBvcHRpb25zLnNlc3Npb25JZDtcblx0fVxuXG5cdGlmIChPYmplY3Qua2V5cyhoZWFkZXJzKS5sZW5ndGggPiAwKSB7XG5cdFx0cmVxdWVzdE9wdGlvbnMuaGVhZGVycyA9IGhlYWRlcnM7XG5cdH1cblxuXHRyZXR1cm4gcmVxdWVzdE9wdGlvbnM7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkQ2hhdFBheWxvYWQoXG5cdG1vZGVsOiBNb2RlbDxcIm1pc3RyYWwtY29udmVyc2F0aW9uc1wiPixcblx0Y29udGV4dDogQ29udGV4dCxcblx0bWVzc2FnZXM6IE1lc3NhZ2VbXSxcblx0b3B0aW9ucz86IE1pc3RyYWxPcHRpb25zLFxuKTogQ2hhdENvbXBsZXRpb25TdHJlYW1SZXF1ZXN0IHtcblx0Y29uc3QgcGF5bG9hZDogQ2hhdENvbXBsZXRpb25TdHJlYW1SZXF1ZXN0ID0ge1xuXHRcdG1vZGVsOiBtb2RlbC5pZCxcblx0XHRzdHJlYW06IHRydWUsXG5cdFx0bWVzc2FnZXM6IHRvQ2hhdE1lc3NhZ2VzKG1lc3NhZ2VzLCBtb2RlbC5pbnB1dC5pbmNsdWRlcyhcImltYWdlXCIpKSxcblx0fTtcblxuXHRpZiAoY29udGV4dC50b29scz8ubGVuZ3RoKSBwYXlsb2FkLnRvb2xzID0gdG9GdW5jdGlvblRvb2xzKGNvbnRleHQudG9vbHMpO1xuXHRpZiAob3B0aW9ucz8udGVtcGVyYXR1cmUgIT09IHVuZGVmaW5lZCkgcGF5bG9hZC50ZW1wZXJhdHVyZSA9IG9wdGlvbnMudGVtcGVyYXR1cmU7XG5cdGlmIChvcHRpb25zPy5tYXhUb2tlbnMgIT09IHVuZGVmaW5lZCkgcGF5bG9hZC5tYXhUb2tlbnMgPSBvcHRpb25zLm1heFRva2Vucztcblx0aWYgKG9wdGlvbnM/LnRvb2xDaG9pY2UpIHBheWxvYWQudG9vbENob2ljZSA9IG1hcFRvb2xDaG9pY2Uob3B0aW9ucy50b29sQ2hvaWNlKTtcblx0aWYgKG9wdGlvbnM/LnByb21wdE1vZGUpIHBheWxvYWQucHJvbXB0TW9kZSA9IG9wdGlvbnMucHJvbXB0TW9kZSBhcyBhbnk7XG5cblx0aWYgKGNvbnRleHQuc3lzdGVtUHJvbXB0KSB7XG5cdFx0cGF5bG9hZC5tZXNzYWdlcy51bnNoaWZ0KHtcblx0XHRcdHJvbGU6IFwic3lzdGVtXCIsXG5cdFx0XHRjb250ZW50OiBzYW5pdGl6ZVN1cnJvZ2F0ZXMoY29udGV4dC5zeXN0ZW1Qcm9tcHQpLFxuXHRcdH0pO1xuXHR9XG5cblx0cmV0dXJuIHBheWxvYWQ7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNvbnN1bWVDaGF0U3RyZWFtKFxuXHRtb2RlbDogTW9kZWw8XCJtaXN0cmFsLWNvbnZlcnNhdGlvbnNcIj4sXG5cdG91dHB1dDogQXNzaXN0YW50TWVzc2FnZSxcblx0c3RyZWFtOiBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0sXG5cdG1pc3RyYWxTdHJlYW06IEFzeW5jSXRlcmFibGU8Q29tcGxldGlvbkV2ZW50Pixcbik6IFByb21pc2U8dm9pZD4ge1xuXHRsZXQgY3VycmVudEJsb2NrOiBUZXh0Q29udGVudCB8IFRoaW5raW5nQ29udGVudCB8IG51bGwgPSBudWxsO1xuXHRjb25zdCBibG9ja3MgPSBvdXRwdXQuY29udGVudDtcblx0Y29uc3QgYmxvY2tJbmRleCA9ICgpID0+IGJsb2Nrcy5sZW5ndGggLSAxO1xuXHRjb25zdCB0b29sQmxvY2tzQnlLZXkgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuXG5cdGNvbnN0IGZpbmlzaEN1cnJlbnRCbG9jayA9IChibG9jaz86IHR5cGVvZiBjdXJyZW50QmxvY2spID0+IHtcblx0XHRpZiAoIWJsb2NrKSByZXR1cm47XG5cdFx0aWYgKGJsb2NrLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdHR5cGU6IFwidGV4dF9lbmRcIixcblx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdGNvbnRlbnQ6IGJsb2NrLnRleHQsXG5cdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdH0pO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAoYmxvY2sudHlwZSA9PT0gXCJ0aGlua2luZ1wiKSB7XG5cdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdHR5cGU6IFwidGhpbmtpbmdfZW5kXCIsXG5cdFx0XHRcdGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLFxuXHRcdFx0XHRjb250ZW50OiBibG9jay50aGlua2luZyxcblx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0fSk7XG5cdFx0fVxuXHR9O1xuXG5cdGZvciBhd2FpdCAoY29uc3QgZXZlbnQgb2YgbWlzdHJhbFN0cmVhbSkge1xuXHRcdGNvbnN0IGNodW5rID0gZXZlbnQuZGF0YTtcblxuXHRcdGlmIChjaHVuay51c2FnZSkge1xuXHRcdFx0b3V0cHV0LnVzYWdlLmlucHV0ID0gY2h1bmsudXNhZ2UucHJvbXB0VG9rZW5zIHx8IDA7XG5cdFx0XHRvdXRwdXQudXNhZ2Uub3V0cHV0ID0gY2h1bmsudXNhZ2UuY29tcGxldGlvblRva2VucyB8fCAwO1xuXHRcdFx0b3V0cHV0LnVzYWdlLmNhY2hlUmVhZCA9IDA7XG5cdFx0XHRvdXRwdXQudXNhZ2UuY2FjaGVXcml0ZSA9IDA7XG5cdFx0XHRvdXRwdXQudXNhZ2UudG90YWxUb2tlbnMgPSBjaHVuay51c2FnZS50b3RhbFRva2VucyB8fCBvdXRwdXQudXNhZ2UuaW5wdXQgKyBvdXRwdXQudXNhZ2Uub3V0cHV0O1xuXHRcdFx0Y2FsY3VsYXRlQ29zdChtb2RlbCwgb3V0cHV0LnVzYWdlKTtcblx0XHR9XG5cblx0XHRjb25zdCBjaG9pY2UgPSBjaHVuay5jaG9pY2VzWzBdO1xuXHRcdGlmICghY2hvaWNlKSBjb250aW51ZTtcblxuXHRcdGlmIChjaG9pY2UuZmluaXNoUmVhc29uKSB7XG5cdFx0XHRvdXRwdXQuc3RvcFJlYXNvbiA9IG1hcENoYXRTdG9wUmVhc29uKGNob2ljZS5maW5pc2hSZWFzb24pO1xuXHRcdH1cblxuXHRcdGNvbnN0IGRlbHRhID0gY2hvaWNlLmRlbHRhO1xuXHRcdGlmIChkZWx0YS5jb250ZW50ICE9PSBudWxsICYmIGRlbHRhLmNvbnRlbnQgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0Y29uc3QgY29udGVudEl0ZW1zID0gdHlwZW9mIGRlbHRhLmNvbnRlbnQgPT09IFwic3RyaW5nXCIgPyBbZGVsdGEuY29udGVudF0gOiBkZWx0YS5jb250ZW50O1xuXHRcdFx0Zm9yIChjb25zdCBpdGVtIG9mIGNvbnRlbnRJdGVtcykge1xuXHRcdFx0XHRpZiAodHlwZW9mIGl0ZW0gPT09IFwic3RyaW5nXCIpIHtcblx0XHRcdFx0XHRjb25zdCB0ZXh0RGVsdGEgPSBzYW5pdGl6ZVN1cnJvZ2F0ZXMoaXRlbSk7XG5cdFx0XHRcdFx0aWYgKCFjdXJyZW50QmxvY2sgfHwgY3VycmVudEJsb2NrLnR5cGUgIT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0XHRmaW5pc2hDdXJyZW50QmxvY2soY3VycmVudEJsb2NrKTtcblx0XHRcdFx0XHRcdGN1cnJlbnRCbG9jayA9IHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiXCIgfTtcblx0XHRcdFx0XHRcdG91dHB1dC5jb250ZW50LnB1c2goY3VycmVudEJsb2NrKTtcblx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0ZXh0X3N0YXJ0XCIsIGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGN1cnJlbnRCbG9jay50ZXh0ICs9IHRleHREZWx0YTtcblx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRleHRfZGVsdGFcIixcblx0XHRcdFx0XHRcdGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLFxuXHRcdFx0XHRcdFx0ZGVsdGE6IHRleHREZWx0YSxcblx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChpdGVtLnR5cGUgPT09IFwidGhpbmtpbmdcIikge1xuXHRcdFx0XHRcdGNvbnN0IGRlbHRhVGV4dCA9IGl0ZW0udGhpbmtpbmdcblx0XHRcdFx0XHRcdC5tYXAoKHBhcnQpID0+IChcInRleHRcIiBpbiBwYXJ0ID8gcGFydC50ZXh0IDogXCJcIikpXG5cdFx0XHRcdFx0XHQuZmlsdGVyKCh0ZXh0KSA9PiB0ZXh0Lmxlbmd0aCA+IDApXG5cdFx0XHRcdFx0XHQuam9pbihcIlwiKTtcblx0XHRcdFx0XHRjb25zdCB0aGlua2luZ0RlbHRhID0gc2FuaXRpemVTdXJyb2dhdGVzKGRlbHRhVGV4dCk7XG5cdFx0XHRcdFx0aWYgKCF0aGlua2luZ0RlbHRhKSBjb250aW51ZTtcblx0XHRcdFx0XHRpZiAoIWN1cnJlbnRCbG9jayB8fCBjdXJyZW50QmxvY2sudHlwZSAhPT0gXCJ0aGlua2luZ1wiKSB7XG5cdFx0XHRcdFx0XHRmaW5pc2hDdXJyZW50QmxvY2soY3VycmVudEJsb2NrKTtcblx0XHRcdFx0XHRcdGN1cnJlbnRCbG9jayA9IHsgdHlwZTogXCJ0aGlua2luZ1wiLCB0aGlua2luZzogXCJcIiB9O1xuXHRcdFx0XHRcdFx0b3V0cHV0LmNvbnRlbnQucHVzaChjdXJyZW50QmxvY2spO1xuXHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInRoaW5raW5nX3N0YXJ0XCIsIGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGN1cnJlbnRCbG9jay50aGlua2luZyArPSB0aGlua2luZ0RlbHRhO1xuXHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdHR5cGU6IFwidGhpbmtpbmdfZGVsdGFcIixcblx0XHRcdFx0XHRcdGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLFxuXHRcdFx0XHRcdFx0ZGVsdGE6IHRoaW5raW5nRGVsdGEsXG5cdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoaXRlbS50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHRcdGNvbnN0IHRleHREZWx0YSA9IHNhbml0aXplU3Vycm9nYXRlcyhpdGVtLnRleHQpO1xuXHRcdFx0XHRcdGlmICghY3VycmVudEJsb2NrIHx8IGN1cnJlbnRCbG9jay50eXBlICE9PSBcInRleHRcIikge1xuXHRcdFx0XHRcdFx0ZmluaXNoQ3VycmVudEJsb2NrKGN1cnJlbnRCbG9jayk7XG5cdFx0XHRcdFx0XHRjdXJyZW50QmxvY2sgPSB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlwiIH07XG5cdFx0XHRcdFx0XHRvdXRwdXQuY29udGVudC5wdXNoKGN1cnJlbnRCbG9jayk7XG5cdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwidGV4dF9zdGFydFwiLCBjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSwgcGFydGlhbDogb3V0cHV0IH0pO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRjdXJyZW50QmxvY2sudGV4dCArPSB0ZXh0RGVsdGE7XG5cdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0X2RlbHRhXCIsXG5cdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdGRlbHRhOiB0ZXh0RGVsdGEsXG5cdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHRjb25zdCB0b29sQ2FsbHMgPSBkZWx0YS50b29sQ2FsbHMgfHwgW107XG5cdFx0Zm9yIChjb25zdCB0b29sQ2FsbCBvZiB0b29sQ2FsbHMpIHtcblx0XHRcdGlmIChjdXJyZW50QmxvY2spIHtcblx0XHRcdFx0ZmluaXNoQ3VycmVudEJsb2NrKGN1cnJlbnRCbG9jayk7XG5cdFx0XHRcdGN1cnJlbnRCbG9jayA9IG51bGw7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBjYWxsSWQgPVxuXHRcdFx0XHR0b29sQ2FsbC5pZCAmJiB0b29sQ2FsbC5pZCAhPT0gXCJudWxsXCJcblx0XHRcdFx0XHQ/IHRvb2xDYWxsLmlkXG5cdFx0XHRcdFx0OiBkZXJpdmVNaXN0cmFsVG9vbENhbGxJZChgdG9vbGNhbGw6JHt0b29sQ2FsbC5pbmRleCA/PyAwfWAsIDApO1xuXHRcdFx0Y29uc3Qga2V5ID0gYCR7Y2FsbElkfToke3Rvb2xDYWxsLmluZGV4IHx8IDB9YDtcblx0XHRcdGNvbnN0IGV4aXN0aW5nSW5kZXggPSB0b29sQmxvY2tzQnlLZXkuZ2V0KGtleSk7XG5cdFx0XHRsZXQgYmxvY2s6IChUb29sQ2FsbCAmIHsgcGFydGlhbEFyZ3M/OiBzdHJpbmcgfSkgfCB1bmRlZmluZWQ7XG5cblx0XHRcdGlmIChleGlzdGluZ0luZGV4ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0Y29uc3QgZXhpc3RpbmcgPSBvdXRwdXQuY29udGVudFtleGlzdGluZ0luZGV4XTtcblx0XHRcdFx0aWYgKGV4aXN0aW5nPy50eXBlID09PSBcInRvb2xDYWxsXCIpIHtcblx0XHRcdFx0XHRibG9jayA9IGV4aXN0aW5nIGFzIFRvb2xDYWxsICYgeyBwYXJ0aWFsQXJncz86IHN0cmluZyB9O1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGlmICghYmxvY2spIHtcblx0XHRcdFx0YmxvY2sgPSB7XG5cdFx0XHRcdFx0dHlwZTogXCJ0b29sQ2FsbFwiLFxuXHRcdFx0XHRcdGlkOiBjYWxsSWQsXG5cdFx0XHRcdFx0bmFtZTogdG9vbENhbGwuZnVuY3Rpb24ubmFtZSxcblx0XHRcdFx0XHRhcmd1bWVudHM6IHt9LFxuXHRcdFx0XHRcdHBhcnRpYWxBcmdzOiBcIlwiLFxuXHRcdFx0XHR9O1xuXHRcdFx0XHRvdXRwdXQuY29udGVudC5wdXNoKGJsb2NrKTtcblx0XHRcdFx0dG9vbEJsb2Nrc0J5S2V5LnNldChrZXksIG91dHB1dC5jb250ZW50Lmxlbmd0aCAtIDEpO1xuXHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwidG9vbGNhbGxfc3RhcnRcIiwgY29udGVudEluZGV4OiBvdXRwdXQuY29udGVudC5sZW5ndGggLSAxLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGFyZ3NEZWx0YSA9XG5cdFx0XHRcdHR5cGVvZiB0b29sQ2FsbC5mdW5jdGlvbi5hcmd1bWVudHMgPT09IFwic3RyaW5nXCJcblx0XHRcdFx0XHQ/IHRvb2xDYWxsLmZ1bmN0aW9uLmFyZ3VtZW50c1xuXHRcdFx0XHRcdDogSlNPTi5zdHJpbmdpZnkodG9vbENhbGwuZnVuY3Rpb24uYXJndW1lbnRzIHx8IHt9KTtcblx0XHRcdGJsb2NrLnBhcnRpYWxBcmdzID0gKGJsb2NrLnBhcnRpYWxBcmdzIHx8IFwiXCIpICsgYXJnc0RlbHRhO1xuXHRcdFx0YmxvY2suYXJndW1lbnRzID0gcGFyc2VTdHJlYW1pbmdKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihibG9jay5wYXJ0aWFsQXJncyk7XG5cdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdHR5cGU6IFwidG9vbGNhbGxfZGVsdGFcIixcblx0XHRcdFx0Y29udGVudEluZGV4OiB0b29sQmxvY2tzQnlLZXkuZ2V0KGtleSkhLFxuXHRcdFx0XHRkZWx0YTogYXJnc0RlbHRhLFxuXHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHR9KTtcblx0XHR9XG5cdH1cblxuXHRmaW5pc2hDdXJyZW50QmxvY2soY3VycmVudEJsb2NrKTtcblx0Zm9yIChjb25zdCBpbmRleCBvZiB0b29sQmxvY2tzQnlLZXkudmFsdWVzKCkpIHtcblx0XHRjb25zdCBibG9jayA9IG91dHB1dC5jb250ZW50W2luZGV4XTtcblx0XHRpZiAoYmxvY2sudHlwZSAhPT0gXCJ0b29sQ2FsbFwiKSBjb250aW51ZTtcblx0XHRjb25zdCB0b29sQmxvY2sgPSBibG9jayBhcyBUb29sQ2FsbCAmIHsgcGFydGlhbEFyZ3M/OiBzdHJpbmcgfTtcblx0XHR0b29sQmxvY2suYXJndW1lbnRzID0gcGFyc2VTdHJlYW1pbmdKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+Pih0b29sQmxvY2sucGFydGlhbEFyZ3MpO1xuXHRcdGRlbGV0ZSB0b29sQmxvY2sucGFydGlhbEFyZ3M7XG5cdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0dHlwZTogXCJ0b29sY2FsbF9lbmRcIixcblx0XHRcdGNvbnRlbnRJbmRleDogaW5kZXgsXG5cdFx0XHR0b29sQ2FsbDogdG9vbEJsb2NrLFxuXHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdH0pO1xuXHR9XG59XG5cbmZ1bmN0aW9uIHRvRnVuY3Rpb25Ub29scyh0b29sczogVG9vbFtdKTogQXJyYXk8RnVuY3Rpb25Ub29sICYgeyB0eXBlOiBcImZ1bmN0aW9uXCIgfT4ge1xuXHRyZXR1cm4gdG9vbHMubWFwKCh0b29sKSA9PiAoe1xuXHRcdHR5cGU6IFwiZnVuY3Rpb25cIixcblx0XHRmdW5jdGlvbjoge1xuXHRcdFx0bmFtZTogdG9vbC5uYW1lLFxuXHRcdFx0ZGVzY3JpcHRpb246IHRvb2wuZGVzY3JpcHRpb24sXG5cdFx0XHRwYXJhbWV0ZXJzOiB0b29sLnBhcmFtZXRlcnMgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcblx0XHRcdHN0cmljdDogZmFsc2UsXG5cdFx0fSxcblx0fSkpO1xufVxuXG5mdW5jdGlvbiB0b0NoYXRNZXNzYWdlcyhtZXNzYWdlczogTWVzc2FnZVtdLCBzdXBwb3J0c0ltYWdlczogYm9vbGVhbik6IENoYXRDb21wbGV0aW9uU3RyZWFtUmVxdWVzdE1lc3NhZ2VzW10ge1xuXHRjb25zdCByZXN1bHQ6IENoYXRDb21wbGV0aW9uU3RyZWFtUmVxdWVzdE1lc3NhZ2VzW10gPSBbXTtcblxuXHRmb3IgKGNvbnN0IG1zZyBvZiBtZXNzYWdlcykge1xuXHRcdGlmIChtc2cucm9sZSA9PT0gXCJ1c2VyXCIpIHtcblx0XHRcdGlmICh0eXBlb2YgbXNnLmNvbnRlbnQgPT09IFwic3RyaW5nXCIpIHtcblx0XHRcdFx0cmVzdWx0LnB1c2goeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogc2FuaXRpemVTdXJyb2dhdGVzKG1zZy5jb250ZW50KSB9KTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBoYWRJbWFnZXMgPSBtc2cuY29udGVudC5zb21lKChpdGVtKSA9PiBpdGVtLnR5cGUgPT09IFwiaW1hZ2VcIik7XG5cdFx0XHRjb25zdCBjb250ZW50OiBDb250ZW50Q2h1bmtbXSA9IG1zZy5jb250ZW50XG5cdFx0XHRcdC5maWx0ZXIoKGl0ZW0pID0+IGl0ZW0udHlwZSA9PT0gXCJ0ZXh0XCIgfHwgc3VwcG9ydHNJbWFnZXMpXG5cdFx0XHRcdC5tYXAoKGl0ZW0pID0+IHtcblx0XHRcdFx0XHRpZiAoaXRlbS50eXBlID09PSBcInRleHRcIikgcmV0dXJuIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IHNhbml0aXplU3Vycm9nYXRlcyhpdGVtLnRleHQpIH07XG5cdFx0XHRcdFx0cmV0dXJuIHsgdHlwZTogXCJpbWFnZV91cmxcIiwgaW1hZ2VVcmw6IGBkYXRhOiR7aXRlbS5taW1lVHlwZX07YmFzZTY0LCR7aXRlbS5kYXRhfWAgfTtcblx0XHRcdFx0fSk7XG5cdFx0XHRpZiAoY29udGVudC5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdHJlc3VsdC5wdXNoKHsgcm9sZTogXCJ1c2VyXCIsIGNvbnRlbnQgfSk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0aWYgKGhhZEltYWdlcyAmJiAhc3VwcG9ydHNJbWFnZXMpIHtcblx0XHRcdFx0cmVzdWx0LnB1c2goeyByb2xlOiBcInVzZXJcIiwgY29udGVudDogXCIoaW1hZ2Ugb21pdHRlZDogbW9kZWwgZG9lcyBub3Qgc3VwcG9ydCBpbWFnZXMpXCIgfSk7XG5cdFx0XHR9XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRpZiAobXNnLnJvbGUgPT09IFwiYXNzaXN0YW50XCIpIHtcblx0XHRcdGNvbnN0IGNvbnRlbnRQYXJ0czogQ29udGVudENodW5rW10gPSBbXTtcblx0XHRcdGNvbnN0IHRvb2xDYWxsczogQXJyYXk8eyBpZDogc3RyaW5nOyB0eXBlOiBcImZ1bmN0aW9uXCI7IGZ1bmN0aW9uOiB7IG5hbWU6IHN0cmluZzsgYXJndW1lbnRzOiBzdHJpbmcgfSB9PiA9IFtdO1xuXG5cdFx0XHRmb3IgKGNvbnN0IGJsb2NrIG9mIG1zZy5jb250ZW50KSB7XG5cdFx0XHRcdGlmIChibG9jay50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHRcdGlmIChibG9jay50ZXh0LnRyaW0oKS5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0XHRjb250ZW50UGFydHMucHVzaCh7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBzYW5pdGl6ZVN1cnJvZ2F0ZXMoYmxvY2sudGV4dCkgfSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmIChibG9jay50eXBlID09PSBcInRoaW5raW5nXCIpIHtcblx0XHRcdFx0XHRpZiAoYmxvY2sudGhpbmtpbmcudHJpbSgpLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0XHRcdGNvbnRlbnRQYXJ0cy5wdXNoKHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0aGlua2luZ1wiLFxuXHRcdFx0XHRcdFx0XHR0aGlua2luZzogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IHNhbml0aXplU3Vycm9nYXRlcyhibG9jay50aGlua2luZykgfV0sXG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKGJsb2NrLnR5cGUgIT09IFwidG9vbENhbGxcIikge1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHRvb2xDYWxscy5wdXNoKHtcblx0XHRcdFx0XHRpZDogYmxvY2suaWQsXG5cdFx0XHRcdFx0dHlwZTogXCJmdW5jdGlvblwiLFxuXHRcdFx0XHRcdGZ1bmN0aW9uOiB7IG5hbWU6IGJsb2NrLm5hbWUsIGFyZ3VtZW50czogSlNPTi5zdHJpbmdpZnkoYmxvY2suYXJndW1lbnRzIHx8IHt9KSB9LFxuXHRcdFx0XHR9KTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgYXNzaXN0YW50TWVzc2FnZTogQ2hhdENvbXBsZXRpb25TdHJlYW1SZXF1ZXN0TWVzc2FnZXMgPSB7IHJvbGU6IFwiYXNzaXN0YW50XCIgfTtcblx0XHRcdGlmIChjb250ZW50UGFydHMubGVuZ3RoID4gMCkgYXNzaXN0YW50TWVzc2FnZS5jb250ZW50ID0gY29udGVudFBhcnRzO1xuXHRcdFx0aWYgKHRvb2xDYWxscy5sZW5ndGggPiAwKSBhc3Npc3RhbnRNZXNzYWdlLnRvb2xDYWxscyA9IHRvb2xDYWxscztcblx0XHRcdGlmIChjb250ZW50UGFydHMubGVuZ3RoID4gMCB8fCB0b29sQ2FsbHMubGVuZ3RoID4gMCkgcmVzdWx0LnB1c2goYXNzaXN0YW50TWVzc2FnZSk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRjb25zdCB0b29sQ29udGVudDogQ29udGVudENodW5rW10gPSBbXTtcblx0XHRjb25zdCB0ZXh0UmVzdWx0ID0gbXNnLmNvbnRlbnRcblx0XHRcdC5maWx0ZXIoKHBhcnQpID0+IHBhcnQudHlwZSA9PT0gXCJ0ZXh0XCIpXG5cdFx0XHQubWFwKChwYXJ0KSA9PiAocGFydC50eXBlID09PSBcInRleHRcIiA/IHNhbml0aXplU3Vycm9nYXRlcyhwYXJ0LnRleHQpIDogXCJcIikpXG5cdFx0XHQuam9pbihcIlxcblwiKTtcblx0XHRjb25zdCBoYXNJbWFnZXMgPSBtc2cuY29udGVudC5zb21lKChwYXJ0KSA9PiBwYXJ0LnR5cGUgPT09IFwiaW1hZ2VcIik7XG5cdFx0Y29uc3QgdG9vbFRleHQgPSBidWlsZFRvb2xSZXN1bHRUZXh0KHRleHRSZXN1bHQsIGhhc0ltYWdlcywgc3VwcG9ydHNJbWFnZXMsIG1zZy5pc0Vycm9yKTtcblx0XHR0b29sQ29udGVudC5wdXNoKHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IHRvb2xUZXh0IH0pO1xuXHRcdGZvciAoY29uc3QgcGFydCBvZiBtc2cuY29udGVudCkge1xuXHRcdFx0aWYgKCFzdXBwb3J0c0ltYWdlcykgY29udGludWU7XG5cdFx0XHRpZiAocGFydC50eXBlICE9PSBcImltYWdlXCIpIGNvbnRpbnVlO1xuXHRcdFx0dG9vbENvbnRlbnQucHVzaCh7XG5cdFx0XHRcdHR5cGU6IFwiaW1hZ2VfdXJsXCIsXG5cdFx0XHRcdGltYWdlVXJsOiBgZGF0YToke3BhcnQubWltZVR5cGV9O2Jhc2U2NCwke3BhcnQuZGF0YX1gLFxuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdHJlc3VsdC5wdXNoKHtcblx0XHRcdHJvbGU6IFwidG9vbFwiLFxuXHRcdFx0dG9vbENhbGxJZDogbXNnLnRvb2xDYWxsSWQsXG5cdFx0XHRuYW1lOiBtc2cudG9vbE5hbWUsXG5cdFx0XHRjb250ZW50OiB0b29sQ29udGVudCxcblx0XHR9KTtcblx0fVxuXG5cdHJldHVybiByZXN1bHQ7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkVG9vbFJlc3VsdFRleHQodGV4dDogc3RyaW5nLCBoYXNJbWFnZXM6IGJvb2xlYW4sIHN1cHBvcnRzSW1hZ2VzOiBib29sZWFuLCBpc0Vycm9yOiBib29sZWFuKTogc3RyaW5nIHtcblx0Y29uc3QgdHJpbW1lZCA9IHRleHQudHJpbSgpO1xuXHRjb25zdCBlcnJvclByZWZpeCA9IGlzRXJyb3IgPyBcIlt0b29sIGVycm9yXSBcIiA6IFwiXCI7XG5cblx0aWYgKHRyaW1tZWQubGVuZ3RoID4gMCkge1xuXHRcdGNvbnN0IGltYWdlU3VmZml4ID0gaGFzSW1hZ2VzICYmICFzdXBwb3J0c0ltYWdlcyA/IFwiXFxuW3Rvb2wgaW1hZ2Ugb21pdHRlZDogbW9kZWwgZG9lcyBub3Qgc3VwcG9ydCBpbWFnZXNdXCIgOiBcIlwiO1xuXHRcdHJldHVybiBgJHtlcnJvclByZWZpeH0ke3RyaW1tZWR9JHtpbWFnZVN1ZmZpeH1gO1xuXHR9XG5cblx0aWYgKGhhc0ltYWdlcykge1xuXHRcdGlmIChzdXBwb3J0c0ltYWdlcykge1xuXHRcdFx0cmV0dXJuIGlzRXJyb3IgPyBcIlt0b29sIGVycm9yXSAoc2VlIGF0dGFjaGVkIGltYWdlKVwiIDogXCIoc2VlIGF0dGFjaGVkIGltYWdlKVwiO1xuXHRcdH1cblx0XHRyZXR1cm4gaXNFcnJvclxuXHRcdFx0PyBcIlt0b29sIGVycm9yXSAoaW1hZ2Ugb21pdHRlZDogbW9kZWwgZG9lcyBub3Qgc3VwcG9ydCBpbWFnZXMpXCJcblx0XHRcdDogXCIoaW1hZ2Ugb21pdHRlZDogbW9kZWwgZG9lcyBub3Qgc3VwcG9ydCBpbWFnZXMpXCI7XG5cdH1cblxuXHRyZXR1cm4gaXNFcnJvciA/IFwiW3Rvb2wgZXJyb3JdIChubyB0b29sIG91dHB1dClcIiA6IFwiKG5vIHRvb2wgb3V0cHV0KVwiO1xufVxuXG5mdW5jdGlvbiBtYXBUb29sQ2hvaWNlKFxuXHRjaG9pY2U6IE1pc3RyYWxPcHRpb25zW1widG9vbENob2ljZVwiXSxcbik6IFwiYXV0b1wiIHwgXCJub25lXCIgfCBcImFueVwiIHwgXCJyZXF1aXJlZFwiIHwgeyB0eXBlOiBcImZ1bmN0aW9uXCI7IGZ1bmN0aW9uOiB7IG5hbWU6IHN0cmluZyB9IH0gfCB1bmRlZmluZWQge1xuXHRpZiAoIWNob2ljZSkgcmV0dXJuIHVuZGVmaW5lZDtcblx0aWYgKGNob2ljZSA9PT0gXCJhdXRvXCIgfHwgY2hvaWNlID09PSBcIm5vbmVcIiB8fCBjaG9pY2UgPT09IFwiYW55XCIgfHwgY2hvaWNlID09PSBcInJlcXVpcmVkXCIpIHtcblx0XHRyZXR1cm4gY2hvaWNlIGFzIGFueTtcblx0fVxuXHRyZXR1cm4ge1xuXHRcdHR5cGU6IFwiZnVuY3Rpb25cIixcblx0XHRmdW5jdGlvbjogeyBuYW1lOiBjaG9pY2UuZnVuY3Rpb24ubmFtZSB9LFxuXHR9O1xufVxuXG5mdW5jdGlvbiBtYXBDaGF0U3RvcFJlYXNvbihyZWFzb246IHN0cmluZyB8IG51bGwpOiBTdG9wUmVhc29uIHtcblx0aWYgKHJlYXNvbiA9PT0gbnVsbCkgcmV0dXJuIFwic3RvcFwiO1xuXHRzd2l0Y2ggKHJlYXNvbikge1xuXHRcdGNhc2UgXCJzdG9wXCI6XG5cdFx0XHRyZXR1cm4gXCJzdG9wXCI7XG5cdFx0Y2FzZSBcImxlbmd0aFwiOlxuXHRcdGNhc2UgXCJtb2RlbF9sZW5ndGhcIjpcblx0XHRcdHJldHVybiBcImxlbmd0aFwiO1xuXHRcdGNhc2UgXCJ0b29sX2NhbGxzXCI6XG5cdFx0XHRyZXR1cm4gXCJ0b29sVXNlXCI7XG5cdFx0Y2FzZSBcImVycm9yXCI6XG5cdFx0XHRyZXR1cm4gXCJlcnJvclwiO1xuXHRcdGRlZmF1bHQ6XG5cdFx0XHRyZXR1cm4gXCJzdG9wXCI7XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVlBLElBQUk7QUFDSixlQUFlLGtCQUEyQztBQUN6RCxNQUFJLENBQUMsZUFBZTtBQUNuQixVQUFNLE1BQU0sTUFBTSxPQUFPLHNCQUFzQjtBQUMvQyxvQkFBZ0IsSUFBSTtBQUFBLEVBQ3JCO0FBQ0EsU0FBTztBQUNSO0FBQ0EsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxxQkFBcUI7QUFlOUIsU0FBUyxtQ0FBbUM7QUFDNUMsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUywwQkFBMEI7QUFDbkMsU0FBUywwQkFBMEI7QUFDbkMsU0FBUyxrQkFBa0Isc0JBQXNCO0FBQ2pELFNBQVMsbUNBQW1DO0FBRTVDLE1BQU0sOEJBQThCO0FBQ3BDLE1BQU0sK0JBQStCO0FBYTlCLE1BQU0sZ0JBQXlFLENBQ3JGLE9BQ0EsU0FDQSxZQUNp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
