import { calculateCost } from "../models.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { hasXmlParameterTags, repairToolJson } from "../utils/repair-tool-json.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessagesWithReport } from "./transform-messages.js";
const claudeCodeTools = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch"
];
const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));
const toClaudeCodeName = (name) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name, tools) => {
  if (tools && tools.length > 0) {
    const lowerName = name.toLowerCase();
    const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
    if (matchedTool) return matchedTool.name;
  }
  return name;
};
function resolveCacheRetention(cacheRetention) {
  if (cacheRetention) {
    return cacheRetention;
  }
  if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
}
function getCacheControl(baseUrl, cacheRetention) {
  const retention = resolveCacheRetention(cacheRetention);
  if (retention === "none") {
    return { retention };
  }
  const ttl = retention === "long" && baseUrl.includes("api.anthropic.com") ? "1h" : void 0;
  return {
    retention,
    cacheControl: { type: "ephemeral", ...ttl && { ttl } }
  };
}
function convertContentBlocks(content) {
  const hasImages = content.some((c) => c.type === "image");
  if (!hasImages) {
    return sanitizeSurrogates(content.map((c) => c.text).join("\n"));
  }
  const blocks = content.map((block) => {
    if (block.type === "text") {
      return {
        type: "text",
        text: sanitizeSurrogates(block.text)
      };
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: block.mimeType,
        data: block.data
      }
    };
  });
  const hasText = blocks.some((b) => b.type === "text");
  if (!hasText) {
    blocks.unshift({
      type: "text",
      text: "(see attached image)"
    });
  }
  return blocks;
}
function supportsAdaptiveThinking(modelId) {
  return modelId.includes("opus-4-6") || modelId.includes("opus-4.6") || modelId.includes("opus-4-7") || modelId.includes("opus-4.7") || modelId.includes("sonnet-4-6") || modelId.includes("sonnet-4.6") || modelId.includes("sonnet-4-7") || modelId.includes("sonnet-4.7") || modelId.includes("haiku-4-5") || modelId.includes("haiku-4.5");
}
function mapThinkingLevelToEffort(level, modelId) {
  switch (level) {
    case "minimal":
      return "low";
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
function isTransientNetworkError(error) {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  const code = error.code;
  return code === "ECONNRESET" || code === "EPIPE" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN" || msg.includes("connector_closed") || msg.includes("socket hang up") || msg.includes("network") || msg.includes("connection") && msg.includes("closed") || msg.includes("fetch failed");
}
function extractRetryAfterMs(headers, errorText = "") {
  const normalizeDelay = (ms) => ms > 0 ? Math.ceil(ms + 1e3) : void 0;
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      const delay = normalizeDelay(seconds * 1e3);
      if (delay !== void 0) return delay;
    }
    const asDate = new Date(retryAfter).getTime();
    if (!Number.isNaN(asDate)) {
      const delay = normalizeDelay(asDate - Date.now());
      if (delay !== void 0) return delay;
    }
  }
  for (const header of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const value = headers.get(header);
    if (value) {
      const resetSeconds = Number(value);
      if (Number.isFinite(resetSeconds)) {
        const delay = normalizeDelay(resetSeconds * 1e3 - Date.now());
        if (delay !== void 0) return delay;
      }
    }
  }
  return void 0;
}
function normalizeToolCallId(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}
function convertMessages(messages, model, isOAuthToken, cacheControl) {
  const params = [];
  const breakpointIndices = [];
  const transformedMessages = transformMessagesWithReport(messages, model, normalizeToolCallId, "anthropic-messages");
  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          params.push({
            role: "user",
            content: sanitizeSurrogates(msg.content)
          });
          if (msg.cacheBreakpoint) breakpointIndices.push(params.length - 1);
        }
      } else {
        const blocks = msg.content.map((item) => {
          if (item.type === "text") {
            return {
              type: "text",
              text: sanitizeSurrogates(item.text)
            };
          } else {
            return {
              type: "image",
              source: {
                type: "base64",
                media_type: item.mimeType,
                data: item.data
              }
            };
          }
        });
        let filteredBlocks = !model?.input.includes("image") ? blocks.filter((b) => b.type !== "image") : blocks;
        filteredBlocks = filteredBlocks.filter((b) => {
          if (b.type === "text") {
            return b.text.trim().length > 0;
          }
          return true;
        });
        if (filteredBlocks.length === 0) continue;
        params.push({
          role: "user",
          content: filteredBlocks
        });
        if (msg.cacheBreakpoint) breakpointIndices.push(params.length - 1);
      }
    } else if (msg.role === "assistant") {
      const blocks = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) continue;
          blocks.push({
            type: "text",
            text: sanitizeSurrogates(block.text)
          });
        } else if (block.type === "thinking") {
          if (block.redacted) {
            blocks.push({
              type: "redacted_thinking",
              data: block.thinkingSignature
            });
            continue;
          }
          if (block.thinking.trim().length === 0) continue;
          if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
            blocks.push({
              type: "text",
              text: sanitizeSurrogates(block.thinking)
            });
          } else {
            blocks.push({
              type: "thinking",
              thinking: sanitizeSurrogates(block.thinking),
              signature: block.thinkingSignature
            });
          }
        } else if (block.type === "toolCall") {
          const toolName = isOAuthToken ? toClaudeCodeName(block.name) : block.name;
          if (!toolName) continue;
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: toolName,
            input: block.arguments ?? {}
          });
        } else if (block.type === "serverToolUse") {
          blocks.push({
            type: "server_tool_use",
            id: block.id,
            name: block.name,
            input: block.input ?? {}
          });
        } else if (block.type === "webSearchResult") {
          blocks.push({
            type: "web_search_tool_result",
            tool_use_id: block.toolUseId,
            content: block.content
          });
        }
      }
      if (blocks.length === 0) continue;
      params.push({
        role: "assistant",
        content: blocks
      });
    } else if (msg.role === "toolResult") {
      const toolResults = [];
      toolResults.push({
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: convertContentBlocks(msg.content),
        is_error: msg.isError
      });
      let j = i + 1;
      while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
        const nextMsg = transformedMessages[j];
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextMsg.toolCallId,
          content: convertContentBlocks(nextMsg.content),
          is_error: nextMsg.isError
        });
        j++;
      }
      i = j - 1;
      params.push({
        role: "user",
        content: toolResults
      });
    }
  }
  if (cacheControl && params.length > 0) {
    applyCacheControlToParam(params, params.length - 1, cacheControl);
    const mostRecentBreakpoint = breakpointIndices[breakpointIndices.length - 1];
    if (mostRecentBreakpoint !== void 0 && mostRecentBreakpoint !== params.length - 1) {
      applyCacheControlToParam(params, mostRecentBreakpoint, cacheControl);
    }
  }
  return params;
}
function applyCacheControlToParam(params, index, cacheControl) {
  const param = params[index];
  if (!param || param.role !== "user") return;
  if (Array.isArray(param.content)) {
    const lastBlock = param.content[param.content.length - 1];
    if (lastBlock && (lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")) {
      lastBlock.cache_control = cacheControl;
    }
  } else if (typeof param.content === "string") {
    param.content = [
      {
        type: "text",
        text: param.content,
        cache_control: cacheControl
      }
    ];
  }
}
function convertTools(tools, isOAuthToken, cacheControl) {
  if (!tools) return [];
  const result = tools.map((tool) => {
    const jsonSchema = tool.parameters;
    return {
      name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: jsonSchema.properties || {},
        required: jsonSchema.required || []
      }
    };
  });
  if (cacheControl && result.length > 0) {
    result[result.length - 1].cache_control = cacheControl;
  }
  return result;
}
function buildParams(model, context, isOAuthToken, options) {
  const { cacheControl } = getCacheControl(model.baseUrl, options?.cacheRetention);
  const apiModelId = model.id.replace(/\[.*\]$/, "");
  const params = {
    model: apiModelId,
    messages: convertMessages(context.messages, model, isOAuthToken, cacheControl),
    max_tokens: options?.maxTokens || model.maxTokens / 3 | 0,
    stream: true
  };
  if (isOAuthToken) {
    const hasUserSystemPrompt = Boolean(context.systemPrompt);
    params.system = [
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        ...cacheControl && !hasUserSystemPrompt ? { cache_control: cacheControl } : {}
      }
    ];
    if (context.systemPrompt) {
      params.system.push({
        type: "text",
        text: sanitizeSurrogates(context.systemPrompt),
        ...cacheControl ? { cache_control: cacheControl } : {}
      });
    }
  } else if (context.systemPrompt) {
    params.system = [
      {
        type: "text",
        text: sanitizeSurrogates(context.systemPrompt),
        ...cacheControl ? { cache_control: cacheControl } : {}
      }
    ];
  }
  if (options?.temperature !== void 0 && !options?.thinkingEnabled) {
    params.temperature = options.temperature;
  }
  if (context.tools) {
    params.tools = convertTools(context.tools, isOAuthToken, cacheControl);
  }
  if (options?.thinkingEnabled && model.reasoning) {
    if (supportsAdaptiveThinking(model.id)) {
      params.thinking = { type: "adaptive" };
      if (options.effort) {
        params.output_config = { effort: options.effort };
      }
    } else {
      params.thinking = {
        type: "enabled",
        budget_tokens: options.thinkingBudgetTokens || 1024
      };
    }
  }
  if (options?.metadata) {
    const userId = options.metadata.user_id;
    if (typeof userId === "string") {
      params.metadata = { user_id: userId };
    }
  }
  if (options?.toolChoice) {
    if (typeof options.toolChoice === "string") {
      params.tool_choice = { type: options.toolChoice };
    } else {
      params.tool_choice = options.toolChoice;
    }
  }
  return params;
}
function mapStopReason(reason) {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
      return "error";
    case "pause_turn":
      return "pauseTurn";
    case "stop_sequence":
      return "stop";
    case "sensitive":
      return "error";
    default:
      throw new Error(`Unhandled stop reason: ${reason}`);
  }
}
function processAnthropicStream(stream, args) {
  const { client, model, context, isOAuthToken, options, AnthropicSdkClass } = args;
  (async () => {
    const output = {
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
    try {
      let params = buildParams(model, context, isOAuthToken, options);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== void 0) {
        params = nextParams;
      }
      const anthropicStream = client.messages.stream({ ...params, stream: true }, { signal: options?.signal });
      stream.push({ type: "start", partial: output });
      const blocks = output.content;
      for await (const event of anthropicStream) {
        if (event.type === "message_start") {
          output.usage.input = event.message.usage.input_tokens || 0;
          output.usage.output = event.message.usage.output_tokens || 0;
          output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
          output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
          output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          calculateCost(model, output.usage);
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "text") {
            const block = {
              type: "text",
              text: "",
              index: event.index
            };
            output.content.push(block);
            stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
          } else if (event.content_block.type === "thinking") {
            const block = {
              type: "thinking",
              thinking: "",
              thinkingSignature: "",
              index: event.index
            };
            output.content.push(block);
            stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
          } else if (event.content_block.type === "redacted_thinking") {
            const block = {
              type: "thinking",
              thinking: "[Reasoning redacted]",
              thinkingSignature: event.content_block.data,
              redacted: true,
              index: event.index
            };
            output.content.push(block);
            stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
          } else if (event.content_block.type === "tool_use") {
            const rawName = event.content_block.name;
            let resolvedName;
            if (rawName) {
              resolvedName = isOAuthToken ? fromClaudeCodeName(rawName, context.tools) : rawName;
            } else {
              const fallbackName = context.tools?.[0]?.name ?? rawName;
              if (fallbackName && fallbackName !== rawName) {
                console.warn(`[anthropic-shared] Empty tool name in content_block_start (id=${event.content_block.id}); falling back to first tool: ${fallbackName}`);
              }
              resolvedName = fallbackName;
            }
            const block = {
              type: "toolCall",
              id: event.content_block.id,
              name: resolvedName,
              arguments: event.content_block.input ?? {},
              partialJson: "",
              index: event.index
            };
            output.content.push(block);
            stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
          } else if (event.content_block.type === "server_tool_use") {
            const serverBlock = event.content_block;
            const block = {
              type: "serverToolUse",
              id: serverBlock.id,
              name: serverBlock.name,
              input: serverBlock.input,
              index: event.index
            };
            output.content.push(block);
            stream.push({ type: "server_tool_use", contentIndex: output.content.length - 1, partial: output });
          } else if (event.content_block.type === "web_search_tool_result") {
            const resultBlock = event.content_block;
            const block = {
              type: "webSearchResult",
              toolUseId: resultBlock.tool_use_id,
              content: resultBlock.content,
              index: event.index
            };
            output.content.push(block);
            stream.push({ type: "web_search_result", contentIndex: output.content.length - 1, partial: output });
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            const index = blocks.findIndex((b) => b.index === event.index);
            const block = blocks[index];
            if (block && block.type === "text") {
              block.text += event.delta.text;
              stream.push({
                type: "text_delta",
                contentIndex: index,
                delta: event.delta.text,
                partial: output
              });
            }
          } else if (event.delta.type === "thinking_delta") {
            const index = blocks.findIndex((b) => b.index === event.index);
            const block = blocks[index];
            if (block && block.type === "thinking") {
              block.thinking += event.delta.thinking;
              stream.push({
                type: "thinking_delta",
                contentIndex: index,
                delta: event.delta.thinking,
                partial: output
              });
            }
          } else if (event.delta.type === "input_json_delta") {
            const index = blocks.findIndex((b) => b.index === event.index);
            const block = blocks[index];
            if (block && block.type === "toolCall") {
              block.partialJson += event.delta.partial_json;
              block.arguments = parseStreamingJson(block.partialJson);
              stream.push({
                type: "toolcall_delta",
                contentIndex: index,
                delta: event.delta.partial_json,
                partial: output
              });
            }
          } else if (event.delta.type === "signature_delta") {
            const index = blocks.findIndex((b) => b.index === event.index);
            const block = blocks[index];
            if (block && block.type === "thinking") {
              block.thinkingSignature = block.thinkingSignature || "";
              block.thinkingSignature += event.delta.signature;
            }
          }
        } else if (event.type === "content_block_stop") {
          const index = blocks.findIndex((b) => b.index === event.index);
          const block = blocks[index];
          if (block) {
            delete block.index;
            if (block.type === "text") {
              stream.push({
                type: "text_end",
                contentIndex: index,
                content: block.text,
                partial: output
              });
            } else if (block.type === "thinking") {
              stream.push({
                type: "thinking_end",
                contentIndex: index,
                content: block.thinking,
                partial: output
              });
            } else if (block.type === "toolCall") {
              const raw = block.partialJson ?? "";
              const rawForParse = hasXmlParameterTags(raw) ? repairToolJson(raw) : raw;
              let parsed;
              try {
                parsed = JSON.parse(rawForParse);
              } catch {
                try {
                  parsed = JSON.parse(repairToolJson(rawForParse));
                } catch {
                }
              }
              block.arguments = parsed ?? parseStreamingJson(block.partialJson);
              delete block.partialJson;
              stream.push({
                type: "toolcall_end",
                contentIndex: index,
                toolCall: block,
                partial: output
              });
            }
          }
        } else if (event.type === "message_delta") {
          if (event.delta.stop_reason) {
            output.stopReason = mapStopReason(event.delta.stop_reason);
          }
          if (event.usage.input_tokens != null) {
            output.usage.input = event.usage.input_tokens;
          }
          if (event.usage.output_tokens != null) {
            output.usage.output = event.usage.output_tokens;
          }
          if (event.usage.cache_read_input_tokens != null) {
            output.usage.cacheRead = event.usage.cache_read_input_tokens;
          }
          if (event.usage.cache_creation_input_tokens != null) {
            output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
          }
          output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          calculateCost(model, output.usage);
        }
      }
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) delete block.index;
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      if (model.provider === "alibaba-coding-plan") {
        output.errorMessage = `[alibaba-coding-plan] ${output.errorMessage}`;
      }
      if (AnthropicSdkClass && error instanceof AnthropicSdkClass.APIError && error.headers) {
        const retryAfterMs = extractRetryAfterMs(error.headers, error.message);
        if (retryAfterMs !== void 0) {
          output.retryAfterMs = retryAfterMs;
        }
      }
      if (isTransientNetworkError(error)) {
        output.retryAfterMs = output.retryAfterMs ?? 5e3;
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
}
export {
  buildParams,
  convertContentBlocks,
  convertMessages,
  convertTools,
  extractRetryAfterMs,
  fromClaudeCodeName,
  getCacheControl,
  isTransientNetworkError,
  mapStopReason,
  mapThinkingLevelToEffort,
  normalizeToolCallId,
  processAnthropicStream,
  supportsAdaptiveThinking,
  toClaudeCodeName
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy9hbnRocm9waWMtc2hhcmVkLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFNoYXJlZCB1dGlsaXRpZXMgZm9yIEFudGhyb3BpYyBwcm92aWRlcnMgKGRpcmVjdCBBUEkgYW5kIFZlcnRleCBBSSkuXG4gKiBJbmNsdWRlcyBtZXNzYWdlIGNvbnZlcnNpb24sIHRvb2wgbm9ybWFsaXNhdGlvbiwgY2FjaGUtY29udHJvbCBoZWxwZXJzLFxuICogYWRhcHRpdmUtdGhpbmtpbmcgZGV0ZWN0aW9uLCBhbmQgdGhlIGNvcmUgYHByb2Nlc3NBbnRocm9waWNTdHJlYW1gIHB1bXAuXG4gKi9cbmltcG9ydCB0eXBlIEFudGhyb3BpYyBmcm9tIFwiQGFudGhyb3BpYy1haS9zZGtcIjtcbmltcG9ydCB0eXBlIHtcblx0Q29udGVudEJsb2NrUGFyYW0sXG5cdE1lc3NhZ2VDcmVhdGVQYXJhbXNTdHJlYW1pbmcsXG5cdE1lc3NhZ2VQYXJhbSxcbn0gZnJvbSBcIkBhbnRocm9waWMtYWkvc2RrL3Jlc291cmNlcy9tZXNzYWdlcy5qc1wiO1xuaW1wb3J0IHsgY2FsY3VsYXRlQ29zdCB9IGZyb20gXCIuLi9tb2RlbHMuanNcIjtcbmltcG9ydCB0eXBlIHtcblx0QXBpLFxuXHRBc3Npc3RhbnRNZXNzYWdlLFxuXHRDYWNoZVJldGVudGlvbixcblx0Q29udGV4dCxcblx0SW1hZ2VDb250ZW50LFxuXHRNZXNzYWdlLFxuXHRNb2RlbCxcblx0U2VydmVyVG9vbFVzZUNvbnRlbnQsXG5cdFN0b3BSZWFzb24sXG5cdFN0cmVhbU9wdGlvbnMsXG5cdFRleHRDb250ZW50LFxuXHRUaGlua2luZ0NvbnRlbnQsXG5cdFRvb2wsXG5cdFRvb2xDYWxsLFxuXHRUb29sUmVzdWx0TWVzc2FnZSxcblx0V2ViU2VhcmNoUmVzdWx0Q29udGVudCxcbn0gZnJvbSBcIi4uL3R5cGVzLmpzXCI7XG5cbi8qKiBBUEkgdHlwZXMgdGhhdCB1c2UgdGhlIEFudGhyb3BpYyBNZXNzYWdlcyBwcm90b2NvbCAqL1xuZXhwb3J0IHR5cGUgQW50aHJvcGljQXBpID0gXCJhbnRocm9waWMtbWVzc2FnZXNcIiB8IFwiYW50aHJvcGljLXZlcnRleFwiO1xuaW1wb3J0IHR5cGUgeyBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0gfSBmcm9tIFwiLi4vdXRpbHMvZXZlbnQtc3RyZWFtLmpzXCI7XG5pbXBvcnQgeyBwYXJzZVN0cmVhbWluZ0pzb24gfSBmcm9tIFwiLi4vdXRpbHMvanNvbi1wYXJzZS5qc1wiO1xuaW1wb3J0IHsgaGFzWG1sUGFyYW1ldGVyVGFncywgcmVwYWlyVG9vbEpzb24gfSBmcm9tIFwiLi4vdXRpbHMvcmVwYWlyLXRvb2wtanNvbi5qc1wiO1xuaW1wb3J0IHsgc2FuaXRpemVTdXJyb2dhdGVzIH0gZnJvbSBcIi4uL3V0aWxzL3Nhbml0aXplLXVuaWNvZGUuanNcIjtcbmltcG9ydCB7IHRyYW5zZm9ybU1lc3NhZ2VzV2l0aFJlcG9ydCB9IGZyb20gXCIuL3RyYW5zZm9ybS1tZXNzYWdlcy5qc1wiO1xuXG4vKiogRWZmb3J0IGxldmVscyBhY2NlcHRlZCBieSB0aGUgQW50aHJvcGljIGBvdXRwdXRfY29uZmlnLmVmZm9ydGAgZmllbGQuICovXG5leHBvcnQgdHlwZSBBbnRocm9waWNFZmZvcnQgPSBcImxvd1wiIHwgXCJtZWRpdW1cIiB8IFwiaGlnaFwiIHwgXCJ4aGlnaFwiIHwgXCJtYXhcIjtcblxuLyoqIEV4dGVuZGVkIHN0cmVhbSBvcHRpb25zIGZvciBBbnRocm9waWMtcHJvdG9jb2wgcHJvdmlkZXJzIChkaXJlY3QgQVBJIGFuZCBWZXJ0ZXggQUkpLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBbnRocm9waWNPcHRpb25zIGV4dGVuZHMgU3RyZWFtT3B0aW9ucyB7XG5cdHRoaW5raW5nRW5hYmxlZD86IGJvb2xlYW47XG5cdHRoaW5raW5nQnVkZ2V0VG9rZW5zPzogbnVtYmVyO1xuXHRlZmZvcnQ/OiBBbnRocm9waWNFZmZvcnQ7XG5cdGludGVybGVhdmVkVGhpbmtpbmc/OiBib29sZWFuO1xuXHR0b29sQ2hvaWNlPzogXCJhdXRvXCIgfCBcImFueVwiIHwgXCJub25lXCIgfCB7IHR5cGU6IFwidG9vbFwiOyBuYW1lOiBzdHJpbmcgfTtcbn1cblxuLyoqIENhbm9uaWNhbCBsaXN0IG9mIENsYXVkZSBDb2RlIGJ1aWx0LWluIHRvb2wgbmFtZXMgdXNlZCBmb3IgY2FzZS1ub3JtYWxpc2F0aW9uLiAqL1xuY29uc3QgY2xhdWRlQ29kZVRvb2xzID0gW1xuXHRcIlJlYWRcIixcblx0XCJXcml0ZVwiLFxuXHRcIkVkaXRcIixcblx0XCJCYXNoXCIsXG5cdFwiR3JlcFwiLFxuXHRcIkdsb2JcIixcblx0XCJBc2tVc2VyUXVlc3Rpb25cIixcblx0XCJFbnRlclBsYW5Nb2RlXCIsXG5cdFwiRXhpdFBsYW5Nb2RlXCIsXG5cdFwiS2lsbFNoZWxsXCIsXG5cdFwiTm90ZWJvb2tFZGl0XCIsXG5cdFwiU2tpbGxcIixcblx0XCJUYXNrXCIsXG5cdFwiVGFza091dHB1dFwiLFxuXHRcIlRvZG9Xcml0ZVwiLFxuXHRcIldlYkZldGNoXCIsXG5cdFwiV2ViU2VhcmNoXCIsXG5dO1xuXG4vKiogTG93ZXJjYXNlLWtleWVkIGxvb2t1cCBtYXAgYnVpbHQgZnJvbSBgY2xhdWRlQ29kZVRvb2xzYCBmb3IgTygxKSBjYXNlLWluc2Vuc2l0aXZlIG5hbWUgcmVzb2x1dGlvbi4gKi9cbmNvbnN0IGNjVG9vbExvb2t1cCA9IG5ldyBNYXAoY2xhdWRlQ29kZVRvb2xzLm1hcCgodCkgPT4gW3QudG9Mb3dlckNhc2UoKSwgdF0pKTtcblxuLyoqIE5vcm1hbGlzZSBhIHRvb2wgbmFtZSB0byBpdHMgY2Fub25pY2FsIENsYXVkZSBDb2RlIGNhc2luZy4gKi9cbmV4cG9ydCBjb25zdCB0b0NsYXVkZUNvZGVOYW1lID0gKG5hbWU6IHN0cmluZykgPT4gY2NUb29sTG9va3VwLmdldChuYW1lLnRvTG93ZXJDYXNlKCkpID8/IG5hbWU7XG4vKiogUmV2ZXJzZS1tYXAgYSBDbGF1ZGUgQ29kZSB0b29sIG5hbWUgYmFjayB0byB0aGUgcHJvdmlkZXIncyBvd24gY2FzaW5nLCB1c2luZyB0aGUgdG9vbHMgbGlzdCBpZiBhdmFpbGFibGUuICovXG5leHBvcnQgY29uc3QgZnJvbUNsYXVkZUNvZGVOYW1lID0gKG5hbWU6IHN0cmluZywgdG9vbHM/OiBUb29sW10pID0+IHtcblx0aWYgKHRvb2xzICYmIHRvb2xzLmxlbmd0aCA+IDApIHtcblx0XHRjb25zdCBsb3dlck5hbWUgPSBuYW1lLnRvTG93ZXJDYXNlKCk7XG5cdFx0Y29uc3QgbWF0Y2hlZFRvb2wgPSB0b29scy5maW5kKCh0b29sKSA9PiB0b29sLm5hbWUudG9Mb3dlckNhc2UoKSA9PT0gbG93ZXJOYW1lKTtcblx0XHRpZiAobWF0Y2hlZFRvb2wpIHJldHVybiBtYXRjaGVkVG9vbC5uYW1lO1xuXHR9XG5cdHJldHVybiBuYW1lO1xufTtcblxuLyoqXG4gKiBSZXNvbHZlIGNhY2hlIHJldGVudGlvbiBwcmVmZXJlbmNlLlxuICogRGVmYXVsdHMgdG8gXCJzaG9ydFwiIGFuZCB1c2VzIFBJX0NBQ0hFX1JFVEVOVElPTiBmb3IgYmFja3dhcmQgY29tcGF0aWJpbGl0eS5cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZUNhY2hlUmV0ZW50aW9uKGNhY2hlUmV0ZW50aW9uPzogQ2FjaGVSZXRlbnRpb24pOiBDYWNoZVJldGVudGlvbiB7XG5cdGlmIChjYWNoZVJldGVudGlvbikge1xuXHRcdHJldHVybiBjYWNoZVJldGVudGlvbjtcblx0fVxuXHRpZiAodHlwZW9mIHByb2Nlc3MgIT09IFwidW5kZWZpbmVkXCIgJiYgcHJvY2Vzcy5lbnYuUElfQ0FDSEVfUkVURU5USU9OID09PSBcImxvbmdcIikge1xuXHRcdHJldHVybiBcImxvbmdcIjtcblx0fVxuXHRyZXR1cm4gXCJzaG9ydFwiO1xufVxuXG4vKiogUmVzb2x2ZSBjYWNoZSByZXRlbnRpb24gYW5kIHJldHVybiB0aGUgbWF0Y2hpbmcgQW50aHJvcGljIGBjYWNoZV9jb250cm9sYCBibG9jay4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRDYWNoZUNvbnRyb2woXG5cdGJhc2VVcmw6IHN0cmluZyxcblx0Y2FjaGVSZXRlbnRpb24/OiBDYWNoZVJldGVudGlvbixcbik6IHsgcmV0ZW50aW9uOiBDYWNoZVJldGVudGlvbjsgY2FjaGVDb250cm9sPzogeyB0eXBlOiBcImVwaGVtZXJhbFwiOyB0dGw/OiBcIjFoXCIgfSB9IHtcblx0Y29uc3QgcmV0ZW50aW9uID0gcmVzb2x2ZUNhY2hlUmV0ZW50aW9uKGNhY2hlUmV0ZW50aW9uKTtcblx0aWYgKHJldGVudGlvbiA9PT0gXCJub25lXCIpIHtcblx0XHRyZXR1cm4geyByZXRlbnRpb24gfTtcblx0fVxuXHRjb25zdCB0dGwgPSByZXRlbnRpb24gPT09IFwibG9uZ1wiICYmIGJhc2VVcmwuaW5jbHVkZXMoXCJhcGkuYW50aHJvcGljLmNvbVwiKSA/IFwiMWhcIiA6IHVuZGVmaW5lZDtcblx0cmV0dXJuIHtcblx0XHRyZXRlbnRpb24sXG5cdFx0Y2FjaGVDb250cm9sOiB7IHR5cGU6IFwiZXBoZW1lcmFsXCIsIC4uLih0dGwgJiYgeyB0dGwgfSkgfSxcblx0fTtcbn1cblxuLyoqIENvbnZlcnQgR1NEIGNvbnRlbnQgYmxvY2tzIHRvIHRoZSBBbnRocm9waWMgU0RLJ3MgdXNlci1tZXNzYWdlIGNvbnRlbnQgZm9ybWF0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbnZlcnRDb250ZW50QmxvY2tzKGNvbnRlbnQ6IChUZXh0Q29udGVudCB8IEltYWdlQ29udGVudClbXSk6XG5cdHwgc3RyaW5nXG5cdHwgQXJyYXk8XG5cdFx0XHR8IHsgdHlwZTogXCJ0ZXh0XCI7IHRleHQ6IHN0cmluZyB9XG5cdFx0XHR8IHtcblx0XHRcdFx0XHR0eXBlOiBcImltYWdlXCI7XG5cdFx0XHRcdFx0c291cmNlOiB7XG5cdFx0XHRcdFx0XHR0eXBlOiBcImJhc2U2NFwiO1xuXHRcdFx0XHRcdFx0bWVkaWFfdHlwZTogXCJpbWFnZS9qcGVnXCIgfCBcImltYWdlL3BuZ1wiIHwgXCJpbWFnZS9naWZcIiB8IFwiaW1hZ2Uvd2VicFwiO1xuXHRcdFx0XHRcdFx0ZGF0YTogc3RyaW5nO1xuXHRcdFx0XHRcdH07XG5cdFx0XHQgIH1cblx0ICA+IHtcblx0Y29uc3QgaGFzSW1hZ2VzID0gY29udGVudC5zb21lKChjKSA9PiBjLnR5cGUgPT09IFwiaW1hZ2VcIik7XG5cdGlmICghaGFzSW1hZ2VzKSB7XG5cdFx0cmV0dXJuIHNhbml0aXplU3Vycm9nYXRlcyhjb250ZW50Lm1hcCgoYykgPT4gKGMgYXMgVGV4dENvbnRlbnQpLnRleHQpLmpvaW4oXCJcXG5cIikpO1xuXHR9XG5cblx0Y29uc3QgYmxvY2tzID0gY29udGVudC5tYXAoKGJsb2NrKSA9PiB7XG5cdFx0aWYgKGJsb2NrLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHR0eXBlOiBcInRleHRcIiBhcyBjb25zdCxcblx0XHRcdFx0dGV4dDogc2FuaXRpemVTdXJyb2dhdGVzKGJsb2NrLnRleHQpLFxuXHRcdFx0fTtcblx0XHR9XG5cdFx0cmV0dXJuIHtcblx0XHRcdHR5cGU6IFwiaW1hZ2VcIiBhcyBjb25zdCxcblx0XHRcdHNvdXJjZToge1xuXHRcdFx0XHR0eXBlOiBcImJhc2U2NFwiIGFzIGNvbnN0LFxuXHRcdFx0XHRtZWRpYV90eXBlOiBibG9jay5taW1lVHlwZSBhcyBcImltYWdlL2pwZWdcIiB8IFwiaW1hZ2UvcG5nXCIgfCBcImltYWdlL2dpZlwiIHwgXCJpbWFnZS93ZWJwXCIsXG5cdFx0XHRcdGRhdGE6IGJsb2NrLmRhdGEsXG5cdFx0XHR9LFxuXHRcdH07XG5cdH0pO1xuXG5cdGNvbnN0IGhhc1RleHQgPSBibG9ja3Muc29tZSgoYikgPT4gYi50eXBlID09PSBcInRleHRcIik7XG5cdGlmICghaGFzVGV4dCkge1xuXHRcdGJsb2Nrcy51bnNoaWZ0KHtcblx0XHRcdHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LFxuXHRcdFx0dGV4dDogXCIoc2VlIGF0dGFjaGVkIGltYWdlKVwiLFxuXHRcdH0pO1xuXHR9XG5cblx0cmV0dXJuIGJsb2Nrcztcbn1cblxuLyoqIFJldHVybnMgdHJ1ZSBmb3IgbW9kZWxzIHRoYXQgc3VwcG9ydCB0aGUgYWRhcHRpdmUgdGhpbmtpbmcgQVBJIChPcHVzIDQuNi80LjcsIFNvbm5ldCA0LjYvNC43LCBIYWlrdSA0LjUpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1cHBvcnRzQWRhcHRpdmVUaGlua2luZyhtb2RlbElkOiBzdHJpbmcpOiBib29sZWFuIHtcblx0cmV0dXJuIChcblx0XHRtb2RlbElkLmluY2x1ZGVzKFwib3B1cy00LTZcIikgfHxcblx0XHRtb2RlbElkLmluY2x1ZGVzKFwib3B1cy00LjZcIikgfHxcblx0XHRtb2RlbElkLmluY2x1ZGVzKFwib3B1cy00LTdcIikgfHxcblx0XHRtb2RlbElkLmluY2x1ZGVzKFwib3B1cy00LjdcIikgfHxcblx0XHRtb2RlbElkLmluY2x1ZGVzKFwic29ubmV0LTQtNlwiKSB8fFxuXHRcdG1vZGVsSWQuaW5jbHVkZXMoXCJzb25uZXQtNC42XCIpIHx8XG5cdFx0bW9kZWxJZC5pbmNsdWRlcyhcInNvbm5ldC00LTdcIikgfHxcblx0XHRtb2RlbElkLmluY2x1ZGVzKFwic29ubmV0LTQuN1wiKSB8fFxuXHRcdG1vZGVsSWQuaW5jbHVkZXMoXCJoYWlrdS00LTVcIikgfHxcblx0XHRtb2RlbElkLmluY2x1ZGVzKFwiaGFpa3UtNC41XCIpXG5cdCk7XG59XG5cbi8qKiBNYXAgYSBHU0QgdGhpbmtpbmcgbGV2ZWwgdG8gdGhlIGNvcnJlc3BvbmRpbmcgQW50aHJvcGljIGVmZm9ydCB2YWx1ZTsgbW9kZWwtc3BlY2lmaWMgZm9yIHhoaWdoLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hcFRoaW5raW5nTGV2ZWxUb0VmZm9ydChsZXZlbDogc3RyaW5nIHwgdW5kZWZpbmVkLCBtb2RlbElkOiBzdHJpbmcpOiBBbnRocm9waWNFZmZvcnQge1xuXHRzd2l0Y2ggKGxldmVsKSB7XG5cdFx0Y2FzZSBcIm1pbmltYWxcIjpcblx0XHRcdHJldHVybiBcImxvd1wiO1xuXHRcdGNhc2UgXCJsb3dcIjpcblx0XHRcdHJldHVybiBcImxvd1wiO1xuXHRcdGNhc2UgXCJtZWRpdW1cIjpcblx0XHRcdHJldHVybiBcIm1lZGl1bVwiO1xuXHRcdGNhc2UgXCJoaWdoXCI6XG5cdFx0XHRyZXR1cm4gXCJoaWdoXCI7XG5cdFx0Y2FzZSBcInhoaWdoXCI6XG5cdFx0XHRpZiAobW9kZWxJZC5pbmNsdWRlcyhcIm9wdXMtNC03XCIpIHx8IG1vZGVsSWQuaW5jbHVkZXMoXCJvcHVzLTQuN1wiKSkgcmV0dXJuIFwieGhpZ2hcIjtcblx0XHRcdGlmIChtb2RlbElkLmluY2x1ZGVzKFwib3B1cy00LTZcIikgfHwgbW9kZWxJZC5pbmNsdWRlcyhcIm9wdXMtNC42XCIpKSByZXR1cm4gXCJtYXhcIjtcblx0XHRcdHJldHVybiBcImhpZ2hcIjtcblx0XHRkZWZhdWx0OlxuXHRcdFx0cmV0dXJuIFwiaGlnaFwiO1xuXHR9XG59XG5cbi8qKiBSZXR1cm5zIHRydWUgZm9yIGxvdy1sZXZlbCBuZXR3b3JrIGVycm9ycyB0aGF0IGFyZSBzYWZlIHRvIHJldHJ5IChyZXNldCwgcGlwZSwgdGltZW91dCwgRE5TKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1RyYW5zaWVudE5ldHdvcmtFcnJvcihlcnJvcjogdW5rbm93bik6IGJvb2xlYW4ge1xuXHRpZiAoIShlcnJvciBpbnN0YW5jZW9mIEVycm9yKSkgcmV0dXJuIGZhbHNlO1xuXHRjb25zdCBtc2cgPSBlcnJvci5tZXNzYWdlLnRvTG93ZXJDYXNlKCk7XG5cdGNvbnN0IGNvZGUgPSAoZXJyb3IgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlO1xuXHRyZXR1cm4gKFxuXHRcdGNvZGUgPT09ICdFQ09OTlJFU0VUJyB8fFxuXHRcdGNvZGUgPT09ICdFUElQRScgfHxcblx0XHRjb2RlID09PSAnRVRJTUVET1VUJyB8fFxuXHRcdGNvZGUgPT09ICdFTk9URk9VTkQnIHx8XG5cdFx0Y29kZSA9PT0gJ0VBSV9BR0FJTicgfHxcblx0XHRtc2cuaW5jbHVkZXMoJ2Nvbm5lY3Rvcl9jbG9zZWQnKSB8fFxuXHRcdG1zZy5pbmNsdWRlcygnc29ja2V0IGhhbmcgdXAnKSB8fFxuXHRcdG1zZy5pbmNsdWRlcygnbmV0d29yaycpIHx8XG5cdFx0bXNnLmluY2x1ZGVzKCdjb25uZWN0aW9uJykgJiYgbXNnLmluY2x1ZGVzKCdjbG9zZWQnKSB8fFxuXHRcdG1zZy5pbmNsdWRlcygnZmV0Y2ggZmFpbGVkJylcblx0KTtcbn1cblxuLyoqIFBhcnNlIGBSZXRyeS1BZnRlcmAgLyByYXRlLWxpbWl0IHJlc2V0IGhlYWRlcnMgYW5kIHJldHVybiBhIHN1Z2dlc3RlZCBkZWxheSBpbiBtaWxsaXNlY29uZHMuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdFJldHJ5QWZ0ZXJNcyhoZWFkZXJzOiBIZWFkZXJzIHwgeyBnZXQobmFtZTogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB9LCBlcnJvclRleHQgPSBcIlwiKTogbnVtYmVyIHwgdW5kZWZpbmVkIHtcblx0Y29uc3Qgbm9ybWFsaXplRGVsYXkgPSAobXM6IG51bWJlcik6IG51bWJlciB8IHVuZGVmaW5lZCA9PiAobXMgPiAwID8gTWF0aC5jZWlsKG1zICsgMTAwMCkgOiB1bmRlZmluZWQpO1xuXG5cdGNvbnN0IHJldHJ5QWZ0ZXIgPSBoZWFkZXJzLmdldChcInJldHJ5LWFmdGVyXCIpO1xuXHRpZiAocmV0cnlBZnRlcikge1xuXHRcdGNvbnN0IHNlY29uZHMgPSBOdW1iZXIocmV0cnlBZnRlcik7XG5cdFx0aWYgKE51bWJlci5pc0Zpbml0ZShzZWNvbmRzKSkge1xuXHRcdFx0Y29uc3QgZGVsYXkgPSBub3JtYWxpemVEZWxheShzZWNvbmRzICogMTAwMCk7XG5cdFx0XHRpZiAoZGVsYXkgIT09IHVuZGVmaW5lZCkgcmV0dXJuIGRlbGF5O1xuXHRcdH1cblx0XHRjb25zdCBhc0RhdGUgPSBuZXcgRGF0ZShyZXRyeUFmdGVyKS5nZXRUaW1lKCk7XG5cdFx0aWYgKCFOdW1iZXIuaXNOYU4oYXNEYXRlKSkge1xuXHRcdFx0Y29uc3QgZGVsYXkgPSBub3JtYWxpemVEZWxheShhc0RhdGUgLSBEYXRlLm5vdygpKTtcblx0XHRcdGlmIChkZWxheSAhPT0gdW5kZWZpbmVkKSByZXR1cm4gZGVsYXk7XG5cdFx0fVxuXHR9XG5cblx0Zm9yIChjb25zdCBoZWFkZXIgb2YgW1wieC1yYXRlbGltaXQtcmVzZXQtcmVxdWVzdHNcIiwgXCJ4LXJhdGVsaW1pdC1yZXNldC10b2tlbnNcIl0pIHtcblx0XHRjb25zdCB2YWx1ZSA9IGhlYWRlcnMuZ2V0KGhlYWRlcik7XG5cdFx0aWYgKHZhbHVlKSB7XG5cdFx0XHRjb25zdCByZXNldFNlY29uZHMgPSBOdW1iZXIodmFsdWUpO1xuXHRcdFx0aWYgKE51bWJlci5pc0Zpbml0ZShyZXNldFNlY29uZHMpKSB7XG5cdFx0XHRcdGNvbnN0IGRlbGF5ID0gbm9ybWFsaXplRGVsYXkocmVzZXRTZWNvbmRzICogMTAwMCAtIERhdGUubm93KCkpO1xuXHRcdFx0XHRpZiAoZGVsYXkgIT09IHVuZGVmaW5lZCkgcmV0dXJuIGRlbGF5O1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKiBTYW5pdGlzZSBhIHRvb2wtY2FsbCBJRCB0byBvbmx5IGFscGhhbnVtZXJpYywgdW5kZXJzY29yZSwgYW5kIGh5cGhlbiBjaGFyYWN0ZXJzIChtYXggNjQgY2hhcnMpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVRvb2xDYWxsSWQoaWQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV8tXS9nLCBcIl9cIikuc2xpY2UoMCwgNjQpO1xufVxuXG4vKiogQ29udmVydCBHU0QgbWVzc2FnZXMgdG8gQW50aHJvcGljIFNESyBgTWVzc2FnZVBhcmFtYCBmb3JtYXQsIGFwcGx5aW5nIGNhY2hlIGNvbnRyb2wgdG8gdGhlIGxhc3QgdXNlciB0dXJuLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbnZlcnRNZXNzYWdlcyhcblx0bWVzc2FnZXM6IE1lc3NhZ2VbXSxcblx0bW9kZWw6IE1vZGVsPEFudGhyb3BpY0FwaT4sXG5cdGlzT0F1dGhUb2tlbjogYm9vbGVhbixcblx0Y2FjaGVDb250cm9sPzogeyB0eXBlOiBcImVwaGVtZXJhbFwiOyB0dGw/OiBcIjFoXCIgfSxcbik6IE1lc3NhZ2VQYXJhbVtdIHtcblx0Y29uc3QgcGFyYW1zOiBNZXNzYWdlUGFyYW1bXSA9IFtdO1xuXHQvLyBJbmRpY2VzIGludG8gYHBhcmFtc2AgZm9yIG1lc3NhZ2VzIGZsYWdnZWQgd2l0aCBgY2FjaGVCcmVha3BvaW50OiB0cnVlYCBcdTIwMTRcblx0Ly8gZS5nLiBjb21wYWN0aW9uIHN1bW1hcmllcy4gV2UgYXBwbHkgY2FjaGVfY29udHJvbCB0byB0aGUgbW9zdCByZWNlbnQgb25lXG5cdC8vIChpbiBhZGRpdGlvbiB0byB0aGUgbGFzdCBtZXNzYWdlKSBzbyB0aGUgc3RhYmxlIHN1bW1hcnkgKyBrZXB0LWhpc3Rvcnlcblx0Ly8gYmxvY2sgY2FuIGVhcm4gY2FjaGUgcmVhZHMgb24gZXZlcnkgcG9zdC1jb21wYWN0aW9uIHR1cm4uICgjNTAyNylcblx0Y29uc3QgYnJlYWtwb2ludEluZGljZXM6IG51bWJlcltdID0gW107XG5cblx0Y29uc3QgdHJhbnNmb3JtZWRNZXNzYWdlcyA9IHRyYW5zZm9ybU1lc3NhZ2VzV2l0aFJlcG9ydChtZXNzYWdlcywgbW9kZWwsIG5vcm1hbGl6ZVRvb2xDYWxsSWQsIFwiYW50aHJvcGljLW1lc3NhZ2VzXCIpO1xuXG5cdGZvciAobGV0IGkgPSAwOyBpIDwgdHJhbnNmb3JtZWRNZXNzYWdlcy5sZW5ndGg7IGkrKykge1xuXHRcdGNvbnN0IG1zZyA9IHRyYW5zZm9ybWVkTWVzc2FnZXNbaV07XG5cblx0XHRpZiAobXNnLnJvbGUgPT09IFwidXNlclwiKSB7XG5cdFx0XHRpZiAodHlwZW9mIG1zZy5jb250ZW50ID09PSBcInN0cmluZ1wiKSB7XG5cdFx0XHRcdGlmIChtc2cuY29udGVudC50cmltKCkubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRcdHBhcmFtcy5wdXNoKHtcblx0XHRcdFx0XHRcdHJvbGU6IFwidXNlclwiLFxuXHRcdFx0XHRcdFx0Y29udGVudDogc2FuaXRpemVTdXJyb2dhdGVzKG1zZy5jb250ZW50KSxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRpZiAobXNnLmNhY2hlQnJlYWtwb2ludCkgYnJlYWtwb2ludEluZGljZXMucHVzaChwYXJhbXMubGVuZ3RoIC0gMSk7XG5cdFx0XHRcdH1cblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGNvbnN0IGJsb2NrczogQ29udGVudEJsb2NrUGFyYW1bXSA9IG1zZy5jb250ZW50Lm1hcCgoaXRlbSkgPT4ge1xuXHRcdFx0XHRcdGlmIChpdGVtLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdFx0dGV4dDogc2FuaXRpemVTdXJyb2dhdGVzKGl0ZW0udGV4dCksXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHR0eXBlOiBcImltYWdlXCIsXG5cdFx0XHRcdFx0XHRcdHNvdXJjZToge1xuXHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwiYmFzZTY0XCIsXG5cdFx0XHRcdFx0XHRcdFx0bWVkaWFfdHlwZTogaXRlbS5taW1lVHlwZSBhcyBcImltYWdlL2pwZWdcIiB8IFwiaW1hZ2UvcG5nXCIgfCBcImltYWdlL2dpZlwiIHwgXCJpbWFnZS93ZWJwXCIsXG5cdFx0XHRcdFx0XHRcdFx0ZGF0YTogaXRlbS5kYXRhLFxuXHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRsZXQgZmlsdGVyZWRCbG9ja3MgPSAhbW9kZWw/LmlucHV0LmluY2x1ZGVzKFwiaW1hZ2VcIikgPyBibG9ja3MuZmlsdGVyKChiKSA9PiBiLnR5cGUgIT09IFwiaW1hZ2VcIikgOiBibG9ja3M7XG5cdFx0XHRcdGZpbHRlcmVkQmxvY2tzID0gZmlsdGVyZWRCbG9ja3MuZmlsdGVyKChiKSA9PiB7XG5cdFx0XHRcdFx0aWYgKGIudHlwZSA9PT0gXCJ0ZXh0XCIpIHtcblx0XHRcdFx0XHRcdHJldHVybiBiLnRleHQudHJpbSgpLmxlbmd0aCA+IDA7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0XHR9KTtcblx0XHRcdFx0aWYgKGZpbHRlcmVkQmxvY2tzLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG5cdFx0XHRcdHBhcmFtcy5wdXNoKHtcblx0XHRcdFx0XHRyb2xlOiBcInVzZXJcIixcblx0XHRcdFx0XHRjb250ZW50OiBmaWx0ZXJlZEJsb2Nrcyxcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGlmIChtc2cuY2FjaGVCcmVha3BvaW50KSBicmVha3BvaW50SW5kaWNlcy5wdXNoKHBhcmFtcy5sZW5ndGggLSAxKTtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKG1zZy5yb2xlID09PSBcImFzc2lzdGFudFwiKSB7XG5cdFx0XHRjb25zdCBibG9ja3M6IENvbnRlbnRCbG9ja1BhcmFtW10gPSBbXTtcblxuXHRcdFx0Zm9yIChjb25zdCBibG9jayBvZiBtc2cuY29udGVudCkge1xuXHRcdFx0XHRpZiAoYmxvY2sudHlwZSA9PT0gXCJ0ZXh0XCIpIHtcblx0XHRcdFx0XHRpZiAoYmxvY2sudGV4dC50cmltKCkubGVuZ3RoID09PSAwKSBjb250aW51ZTtcblx0XHRcdFx0XHRibG9ja3MucHVzaCh7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdHRleHQ6IHNhbml0aXplU3Vycm9nYXRlcyhibG9jay50ZXh0KSxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fSBlbHNlIGlmIChibG9jay50eXBlID09PSBcInRoaW5raW5nXCIpIHtcblx0XHRcdFx0XHRpZiAoYmxvY2sucmVkYWN0ZWQpIHtcblx0XHRcdFx0XHRcdGJsb2Nrcy5wdXNoKHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJyZWRhY3RlZF90aGlua2luZ1wiLFxuXHRcdFx0XHRcdFx0XHRkYXRhOiBibG9jay50aGlua2luZ1NpZ25hdHVyZSEsXG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRpZiAoYmxvY2sudGhpbmtpbmcudHJpbSgpLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG5cdFx0XHRcdFx0aWYgKCFibG9jay50aGlua2luZ1NpZ25hdHVyZSB8fCBibG9jay50aGlua2luZ1NpZ25hdHVyZS50cmltKCkubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0XHRibG9ja3MucHVzaCh7XG5cdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0XHR0ZXh0OiBzYW5pdGl6ZVN1cnJvZ2F0ZXMoYmxvY2sudGhpbmtpbmcpLFxuXHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdGJsb2Nrcy5wdXNoKHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0aGlua2luZ1wiLFxuXHRcdFx0XHRcdFx0XHR0aGlua2luZzogc2FuaXRpemVTdXJyb2dhdGVzKGJsb2NrLnRoaW5raW5nKSxcblx0XHRcdFx0XHRcdFx0c2lnbmF0dXJlOiBibG9jay50aGlua2luZ1NpZ25hdHVyZSxcblx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBlbHNlIGlmIChibG9jay50eXBlID09PSBcInRvb2xDYWxsXCIpIHtcblx0XHRcdFx0XHQvLyBHdWFyZDogbmV2ZXIgZm9yd2FyZCBhIHRvb2xfdXNlIGJsb2NrIHdpdGggYW4gZW1wdHkgbmFtZS5cblx0XHRcdFx0XHQvLyBmaW5lLWdyYWluZWQtdG9vbC1zdHJlYW1pbmctMjAyNS0wNS0xNCBjYW4gY2F1c2UgdGhlIG5hbWUgdG8gYXJyaXZlXG5cdFx0XHRcdFx0Ly8gYXMgYSBkZWx0YSBvbiBpbmNvbXBhdGlibGUgcHJvdmlkZXJzIChlLmcuIE1pbmlNYXgpLCBsZWF2aW5nIGJsb2NrLm5hbWVcblx0XHRcdFx0XHQvLyBhcyBcIlwiLiBSZS1zZW5kaW5nIHRoYXQgdG8gTWluaU1heCB0cmlnZ2VycyBlcnJvciAyMDEzICgjNDUzOCkuXG5cdFx0XHRcdFx0Y29uc3QgdG9vbE5hbWUgPSBpc09BdXRoVG9rZW4gPyB0b0NsYXVkZUNvZGVOYW1lKGJsb2NrLm5hbWUpIDogYmxvY2submFtZTtcblx0XHRcdFx0XHRpZiAoIXRvb2xOYW1lKSBjb250aW51ZTtcblx0XHRcdFx0XHRibG9ja3MucHVzaCh7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRvb2xfdXNlXCIsXG5cdFx0XHRcdFx0XHRpZDogYmxvY2suaWQsXG5cdFx0XHRcdFx0XHRuYW1lOiB0b29sTmFtZSxcblx0XHRcdFx0XHRcdGlucHV0OiBibG9jay5hcmd1bWVudHMgPz8ge30sXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH0gZWxzZSBpZiAoYmxvY2sudHlwZSA9PT0gXCJzZXJ2ZXJUb29sVXNlXCIpIHtcblx0XHRcdFx0XHRibG9ja3MucHVzaCh7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInNlcnZlcl90b29sX3VzZVwiLFxuXHRcdFx0XHRcdFx0aWQ6IGJsb2NrLmlkLFxuXHRcdFx0XHRcdFx0bmFtZTogYmxvY2submFtZSxcblx0XHRcdFx0XHRcdGlucHV0OiBibG9jay5pbnB1dCA/PyB7fSxcblx0XHRcdFx0XHR9IGFzIGFueSk7XG5cdFx0XHRcdH0gZWxzZSBpZiAoYmxvY2sudHlwZSA9PT0gXCJ3ZWJTZWFyY2hSZXN1bHRcIikge1xuXHRcdFx0XHRcdGJsb2Nrcy5wdXNoKHtcblx0XHRcdFx0XHRcdHR5cGU6IFwid2ViX3NlYXJjaF90b29sX3Jlc3VsdFwiLFxuXHRcdFx0XHRcdFx0dG9vbF91c2VfaWQ6IGJsb2NrLnRvb2xVc2VJZCxcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IGJsb2NrLmNvbnRlbnQsXG5cdFx0XHRcdFx0fSBhcyBhbnkpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHRpZiAoYmxvY2tzLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG5cdFx0XHRwYXJhbXMucHVzaCh7XG5cdFx0XHRcdHJvbGU6IFwiYXNzaXN0YW50XCIsXG5cdFx0XHRcdGNvbnRlbnQ6IGJsb2Nrcyxcblx0XHRcdH0pO1xuXHRcdH0gZWxzZSBpZiAobXNnLnJvbGUgPT09IFwidG9vbFJlc3VsdFwiKSB7XG5cdFx0XHRjb25zdCB0b29sUmVzdWx0czogQ29udGVudEJsb2NrUGFyYW1bXSA9IFtdO1xuXG5cdFx0XHR0b29sUmVzdWx0cy5wdXNoKHtcblx0XHRcdFx0dHlwZTogXCJ0b29sX3Jlc3VsdFwiLFxuXHRcdFx0XHR0b29sX3VzZV9pZDogbXNnLnRvb2xDYWxsSWQsXG5cdFx0XHRcdGNvbnRlbnQ6IGNvbnZlcnRDb250ZW50QmxvY2tzKG1zZy5jb250ZW50KSxcblx0XHRcdFx0aXNfZXJyb3I6IG1zZy5pc0Vycm9yLFxuXHRcdFx0fSk7XG5cblx0XHRcdGxldCBqID0gaSArIDE7XG5cdFx0XHR3aGlsZSAoaiA8IHRyYW5zZm9ybWVkTWVzc2FnZXMubGVuZ3RoICYmIHRyYW5zZm9ybWVkTWVzc2FnZXNbal0ucm9sZSA9PT0gXCJ0b29sUmVzdWx0XCIpIHtcblx0XHRcdFx0Y29uc3QgbmV4dE1zZyA9IHRyYW5zZm9ybWVkTWVzc2FnZXNbal0gYXMgVG9vbFJlc3VsdE1lc3NhZ2U7XG5cdFx0XHRcdHRvb2xSZXN1bHRzLnB1c2goe1xuXHRcdFx0XHRcdHR5cGU6IFwidG9vbF9yZXN1bHRcIixcblx0XHRcdFx0XHR0b29sX3VzZV9pZDogbmV4dE1zZy50b29sQ2FsbElkLFxuXHRcdFx0XHRcdGNvbnRlbnQ6IGNvbnZlcnRDb250ZW50QmxvY2tzKG5leHRNc2cuY29udGVudCksXG5cdFx0XHRcdFx0aXNfZXJyb3I6IG5leHRNc2cuaXNFcnJvcixcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGorKztcblx0XHRcdH1cblxuXHRcdFx0aSA9IGogLSAxO1xuXG5cdFx0XHRwYXJhbXMucHVzaCh7XG5cdFx0XHRcdHJvbGU6IFwidXNlclwiLFxuXHRcdFx0XHRjb250ZW50OiB0b29sUmVzdWx0cyxcblx0XHRcdH0pO1xuXHRcdH1cblx0fVxuXG5cdGlmIChjYWNoZUNvbnRyb2wgJiYgcGFyYW1zLmxlbmd0aCA+IDApIHtcblx0XHQvLyBBcHBseSB0byB0aGUgdm9sYXRpbGUgc3VmZml4IGFuY2hvciAobGFzdCB1c2VyIG1lc3NhZ2UpIFx1MjAxNCBleGlzdGluZyBiZWhhdmlvci5cblx0XHRhcHBseUNhY2hlQ29udHJvbFRvUGFyYW0ocGFyYW1zLCBwYXJhbXMubGVuZ3RoIC0gMSwgY2FjaGVDb250cm9sKTtcblxuXHRcdC8vIEFwcGx5IHRvIHRoZSBtb3N0IHJlY2VudCBjb21wYWN0aW9uLWJvdW5kYXJ5IG1lc3NhZ2UsIGlmIGFueS4gQ2FwcGluZyBhdFxuXHRcdC8vIG9uZSBib3VuZGFyeSBrZWVwcyB1cyBzYWZlbHkgdW5kZXIgQW50aHJvcGljJ3MgNC1icmVha3BvaW50IGxpbWl0XG5cdFx0Ly8gKHN5c3RlbSArIHRvb2xzICsgYm91bmRhcnkgKyBsYXN0IHVzZXIgPSA0KS4gSWYgbXVsdGlwbGVcblx0XHQvLyBjYWNoZUJyZWFrcG9pbnQgbWVzc2FnZXMgYXJlIHByZXNlbnQsIG9ubHkgdGhlIG1vc3QgcmVjZW50IG9uZSBcdTIwMTQgdGhlXG5cdFx0Ly8gZnJlc2hlc3Qgc3RhYmxlIGJvdW5kYXJ5IFx1MjAxNCBlYXJucyB0aGUgYnJlYWtwb2ludC4gKCM1MDI3KVxuXHRcdGNvbnN0IG1vc3RSZWNlbnRCcmVha3BvaW50ID0gYnJlYWtwb2ludEluZGljZXNbYnJlYWtwb2ludEluZGljZXMubGVuZ3RoIC0gMV07XG5cdFx0aWYgKG1vc3RSZWNlbnRCcmVha3BvaW50ICE9PSB1bmRlZmluZWQgJiYgbW9zdFJlY2VudEJyZWFrcG9pbnQgIT09IHBhcmFtcy5sZW5ndGggLSAxKSB7XG5cdFx0XHRhcHBseUNhY2hlQ29udHJvbFRvUGFyYW0ocGFyYW1zLCBtb3N0UmVjZW50QnJlYWtwb2ludCwgY2FjaGVDb250cm9sKTtcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gcGFyYW1zO1xufVxuXG4vKiogQXBwbHkgYGNhY2hlX2NvbnRyb2xgIHRvIHRoZSBsYXN0IGNhY2hlYWJsZSBibG9jayBvZiB0aGUgdXNlci1yb2xlIHBhcmFtIGF0IGBpbmRleGAuIE5vLW9wIGZvciBub24tdXNlciByb2xlcy4gKi9cbmZ1bmN0aW9uIGFwcGx5Q2FjaGVDb250cm9sVG9QYXJhbShcblx0cGFyYW1zOiBNZXNzYWdlUGFyYW1bXSxcblx0aW5kZXg6IG51bWJlcixcblx0Y2FjaGVDb250cm9sOiB7IHR5cGU6IFwiZXBoZW1lcmFsXCI7IHR0bD86IFwiMWhcIiB9LFxuKTogdm9pZCB7XG5cdGNvbnN0IHBhcmFtID0gcGFyYW1zW2luZGV4XTtcblx0aWYgKCFwYXJhbSB8fCBwYXJhbS5yb2xlICE9PSBcInVzZXJcIikgcmV0dXJuO1xuXHRpZiAoQXJyYXkuaXNBcnJheShwYXJhbS5jb250ZW50KSkge1xuXHRcdGNvbnN0IGxhc3RCbG9jayA9IHBhcmFtLmNvbnRlbnRbcGFyYW0uY29udGVudC5sZW5ndGggLSAxXTtcblx0XHRpZiAoXG5cdFx0XHRsYXN0QmxvY2sgJiZcblx0XHRcdChsYXN0QmxvY2sudHlwZSA9PT0gXCJ0ZXh0XCIgfHwgbGFzdEJsb2NrLnR5cGUgPT09IFwiaW1hZ2VcIiB8fCBsYXN0QmxvY2sudHlwZSA9PT0gXCJ0b29sX3Jlc3VsdFwiKVxuXHRcdCkge1xuXHRcdFx0KGxhc3RCbG9jayBhcyBhbnkpLmNhY2hlX2NvbnRyb2wgPSBjYWNoZUNvbnRyb2w7XG5cdFx0fVxuXHR9IGVsc2UgaWYgKHR5cGVvZiBwYXJhbS5jb250ZW50ID09PSBcInN0cmluZ1wiKSB7XG5cdFx0cGFyYW0uY29udGVudCA9IFtcblx0XHRcdHtcblx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdHRleHQ6IHBhcmFtLmNvbnRlbnQsXG5cdFx0XHRcdGNhY2hlX2NvbnRyb2w6IGNhY2hlQ29udHJvbCxcblx0XHRcdH0sXG5cdFx0XSBhcyBhbnk7XG5cdH1cbn1cblxuLyoqIENvbnZlcnQgR1NEIHRvb2xzIHRvIEFudGhyb3BpYyBTREsgdG9vbCBkZWZpbml0aW9ucywgYXBwbHlpbmcgY2FjaGUgY29udHJvbCB0byB0aGUgbGFzdCBlbnRyeS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb252ZXJ0VG9vbHMoXG5cdHRvb2xzOiBUb29sW10sXG5cdGlzT0F1dGhUb2tlbjogYm9vbGVhbixcblx0Y2FjaGVDb250cm9sPzogeyB0eXBlOiBcImVwaGVtZXJhbFwiOyB0dGw/OiBcIjFoXCIgfSxcbik6IEFudGhyb3BpYy5NZXNzYWdlcy5Ub29sW10ge1xuXHRpZiAoIXRvb2xzKSByZXR1cm4gW107XG5cblx0Y29uc3QgcmVzdWx0ID0gdG9vbHMubWFwKCh0b29sKSA9PiB7XG5cdFx0Y29uc3QganNvblNjaGVtYSA9IHRvb2wucGFyYW1ldGVycyBhcyBhbnk7XG5cblx0XHRyZXR1cm4ge1xuXHRcdFx0bmFtZTogaXNPQXV0aFRva2VuID8gdG9DbGF1ZGVDb2RlTmFtZSh0b29sLm5hbWUpIDogdG9vbC5uYW1lLFxuXHRcdFx0ZGVzY3JpcHRpb246IHRvb2wuZGVzY3JpcHRpb24sXG5cdFx0XHRpbnB1dF9zY2hlbWE6IHtcblx0XHRcdFx0dHlwZTogXCJvYmplY3RcIiBhcyBjb25zdCxcblx0XHRcdFx0cHJvcGVydGllczoganNvblNjaGVtYS5wcm9wZXJ0aWVzIHx8IHt9LFxuXHRcdFx0XHRyZXF1aXJlZDoganNvblNjaGVtYS5yZXF1aXJlZCB8fCBbXSxcblx0XHRcdH0sXG5cdFx0fTtcblx0fSk7XG5cblx0Ly8gQWRkIGNhY2hlIGJyZWFrcG9pbnQgdG8gbGFzdCB0b29sIFx1MjAxNCBjb3ZlcnMgZW50aXJlIHRvb2wgYmxvY2tcblx0aWYgKGNhY2hlQ29udHJvbCAmJiByZXN1bHQubGVuZ3RoID4gMCkge1xuXHRcdChyZXN1bHRbcmVzdWx0Lmxlbmd0aCAtIDFdIGFzIGFueSkuY2FjaGVfY29udHJvbCA9IGNhY2hlQ29udHJvbDtcblx0fVxuXG5cdHJldHVybiByZXN1bHQ7XG59XG5cbi8qKiBCdWlsZCB0aGUgYE1lc3NhZ2VDcmVhdGVQYXJhbXNTdHJlYW1pbmdgIHBheWxvYWQgZm9yIGFuIEFudGhyb3BpYyBBUEkgY2FsbC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFBhcmFtcyhcblx0bW9kZWw6IE1vZGVsPEFudGhyb3BpY0FwaT4sXG5cdGNvbnRleHQ6IENvbnRleHQsXG5cdGlzT0F1dGhUb2tlbjogYm9vbGVhbixcblx0b3B0aW9ucz86IEFudGhyb3BpY09wdGlvbnMsXG4pOiBNZXNzYWdlQ3JlYXRlUGFyYW1zU3RyZWFtaW5nIHtcblx0Y29uc3QgeyBjYWNoZUNvbnRyb2wgfSA9IGdldENhY2hlQ29udHJvbChtb2RlbC5iYXNlVXJsLCBvcHRpb25zPy5jYWNoZVJldGVudGlvbik7XG5cdGNvbnN0IGFwaU1vZGVsSWQgPSBtb2RlbC5pZC5yZXBsYWNlKC9cXFsuKlxcXSQvLCBcIlwiKTtcblx0Y29uc3QgcGFyYW1zOiBNZXNzYWdlQ3JlYXRlUGFyYW1zU3RyZWFtaW5nID0ge1xuXHRcdG1vZGVsOiBhcGlNb2RlbElkLFxuXHRcdG1lc3NhZ2VzOiBjb252ZXJ0TWVzc2FnZXMoY29udGV4dC5tZXNzYWdlcywgbW9kZWwsIGlzT0F1dGhUb2tlbiwgY2FjaGVDb250cm9sKSxcblx0XHRtYXhfdG9rZW5zOiBvcHRpb25zPy5tYXhUb2tlbnMgfHwgKG1vZGVsLm1heFRva2VucyAvIDMpIHwgMCxcblx0XHRzdHJlYW06IHRydWUsXG5cdH07XG5cblx0aWYgKGlzT0F1dGhUb2tlbikge1xuXHRcdC8vIE9ubHkgdGhlIExBU1Qgc3lzdGVtIGJsb2NrIGNhcnJpZXMgYGNhY2hlX2NvbnRyb2xgIFx1MjAxNCB0aGUgYm91bmRhcnlcblx0XHQvLyBjb3ZlcnMgdGhlIGVudGlyZSBzeXN0ZW0gcHJlZml4IHVwIHRvIHRoYXQgcG9pbnQuIFB1dHRpbmcgY2FjaGVfY29udHJvbFxuXHRcdC8vIG9uIHRoZSBzaG9ydCBcIllvdSBhcmUgQ2xhdWRlIENvZGVcIiBoZWFkZXIgQU5EIHRoZSB1c2VyIHN5c3RlbVByb21wdFxuXHRcdC8vIHdvdWxkIGNvbnN1bWUgdHdvIG9mIEFudGhyb3BpYydzIDQgYnJlYWtwb2ludCBzbG90cyBmb3IgcmVkdW5kYW50XG5cdFx0Ly8gY292ZXJhZ2UsIGxlYXZpbmcgbm8gcm9vbSBmb3IgYSBjb21wYWN0aW9uLXN1bW1hcnkgYnJlYWtwb2ludC4gKCM1MDI3KVxuXHRcdGNvbnN0IGhhc1VzZXJTeXN0ZW1Qcm9tcHQgPSBCb29sZWFuKGNvbnRleHQuc3lzdGVtUHJvbXB0KTtcblx0XHRwYXJhbXMuc3lzdGVtID0gW1xuXHRcdFx0e1xuXHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0dGV4dDogXCJZb3UgYXJlIENsYXVkZSBDb2RlLCBBbnRocm9waWMncyBvZmZpY2lhbCBDTEkgZm9yIENsYXVkZS5cIixcblx0XHRcdFx0Li4uKGNhY2hlQ29udHJvbCAmJiAhaGFzVXNlclN5c3RlbVByb21wdCA/IHsgY2FjaGVfY29udHJvbDogY2FjaGVDb250cm9sIH0gOiB7fSksXG5cdFx0XHR9LFxuXHRcdF07XG5cdFx0aWYgKGNvbnRleHQuc3lzdGVtUHJvbXB0KSB7XG5cdFx0XHRwYXJhbXMuc3lzdGVtLnB1c2goe1xuXHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0dGV4dDogc2FuaXRpemVTdXJyb2dhdGVzKGNvbnRleHQuc3lzdGVtUHJvbXB0KSxcblx0XHRcdFx0Li4uKGNhY2hlQ29udHJvbCA/IHsgY2FjaGVfY29udHJvbDogY2FjaGVDb250cm9sIH0gOiB7fSksXG5cdFx0XHR9KTtcblx0XHR9XG5cdH0gZWxzZSBpZiAoY29udGV4dC5zeXN0ZW1Qcm9tcHQpIHtcblx0XHRwYXJhbXMuc3lzdGVtID0gW1xuXHRcdFx0e1xuXHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0dGV4dDogc2FuaXRpemVTdXJyb2dhdGVzKGNvbnRleHQuc3lzdGVtUHJvbXB0KSxcblx0XHRcdFx0Li4uKGNhY2hlQ29udHJvbCA/IHsgY2FjaGVfY29udHJvbDogY2FjaGVDb250cm9sIH0gOiB7fSksXG5cdFx0XHR9LFxuXHRcdF07XG5cdH1cblxuXHRpZiAob3B0aW9ucz8udGVtcGVyYXR1cmUgIT09IHVuZGVmaW5lZCAmJiAhb3B0aW9ucz8udGhpbmtpbmdFbmFibGVkKSB7XG5cdFx0cGFyYW1zLnRlbXBlcmF0dXJlID0gb3B0aW9ucy50ZW1wZXJhdHVyZTtcblx0fVxuXG5cdGlmIChjb250ZXh0LnRvb2xzKSB7XG5cdFx0cGFyYW1zLnRvb2xzID0gY29udmVydFRvb2xzKGNvbnRleHQudG9vbHMsIGlzT0F1dGhUb2tlbiwgY2FjaGVDb250cm9sKTtcblx0fVxuXG5cdGlmIChvcHRpb25zPy50aGlua2luZ0VuYWJsZWQgJiYgbW9kZWwucmVhc29uaW5nKSB7XG5cdFx0aWYgKHN1cHBvcnRzQWRhcHRpdmVUaGlua2luZyhtb2RlbC5pZCkpIHtcblx0XHRcdHBhcmFtcy50aGlua2luZyA9IHsgdHlwZTogXCJhZGFwdGl2ZVwiIH07XG5cdFx0XHRpZiAob3B0aW9ucy5lZmZvcnQpIHtcblx0XHRcdFx0Ly8gVGhlIFNESydzIE91dHB1dENvbmZpZy5lZmZvcnQgdHlwZSBkb2Vzbid0IGluY2x1ZGUgXCJ4aGlnaFwiIHlldC5cblx0XHRcdFx0Ly8gQ2FzdCBzbyBvdXIgc3VwZXJzZXQgQW50aHJvcGljRWZmb3J0IHR5cGUgY29tcGlsZXMgY2xlYW5seS5cblx0XHRcdFx0cGFyYW1zLm91dHB1dF9jb25maWcgPSB7IGVmZm9ydDogb3B0aW9ucy5lZmZvcnQgYXMgXCJsb3dcIiB8IFwibWVkaXVtXCIgfCBcImhpZ2hcIiB8IFwibWF4XCIgfTtcblx0XHRcdH1cblx0XHR9IGVsc2Uge1xuXHRcdFx0cGFyYW1zLnRoaW5raW5nID0ge1xuXHRcdFx0XHR0eXBlOiBcImVuYWJsZWRcIixcblx0XHRcdFx0YnVkZ2V0X3Rva2Vuczogb3B0aW9ucy50aGlua2luZ0J1ZGdldFRva2VucyB8fCAxMDI0LFxuXHRcdFx0fTtcblx0XHR9XG5cdH1cblxuXHRpZiAob3B0aW9ucz8ubWV0YWRhdGEpIHtcblx0XHRjb25zdCB1c2VySWQgPSBvcHRpb25zLm1ldGFkYXRhLnVzZXJfaWQ7XG5cdFx0aWYgKHR5cGVvZiB1c2VySWQgPT09IFwic3RyaW5nXCIpIHtcblx0XHRcdHBhcmFtcy5tZXRhZGF0YSA9IHsgdXNlcl9pZDogdXNlcklkIH07XG5cdFx0fVxuXHR9XG5cblx0aWYgKG9wdGlvbnM/LnRvb2xDaG9pY2UpIHtcblx0XHRpZiAodHlwZW9mIG9wdGlvbnMudG9vbENob2ljZSA9PT0gXCJzdHJpbmdcIikge1xuXHRcdFx0cGFyYW1zLnRvb2xfY2hvaWNlID0geyB0eXBlOiBvcHRpb25zLnRvb2xDaG9pY2UgfTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0cGFyYW1zLnRvb2xfY2hvaWNlID0gb3B0aW9ucy50b29sQ2hvaWNlO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBwYXJhbXM7XG59XG5cbi8qKiBNYXAgYW4gQW50aHJvcGljIEFQSSBzdG9wIHJlYXNvbiBzdHJpbmcgdG8gR1NEJ3MgaW50ZXJuYWwgYFN0b3BSZWFzb25gLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hcFN0b3BSZWFzb24ocmVhc29uOiBzdHJpbmcpOiBTdG9wUmVhc29uIHtcblx0c3dpdGNoIChyZWFzb24pIHtcblx0XHRjYXNlIFwiZW5kX3R1cm5cIjpcblx0XHRcdHJldHVybiBcInN0b3BcIjtcblx0XHRjYXNlIFwibWF4X3Rva2Vuc1wiOlxuXHRcdFx0cmV0dXJuIFwibGVuZ3RoXCI7XG5cdFx0Y2FzZSBcInRvb2xfdXNlXCI6XG5cdFx0XHRyZXR1cm4gXCJ0b29sVXNlXCI7XG5cdFx0Y2FzZSBcInJlZnVzYWxcIjpcblx0XHRcdHJldHVybiBcImVycm9yXCI7XG5cdFx0Y2FzZSBcInBhdXNlX3R1cm5cIjpcblx0XHRcdHJldHVybiBcInBhdXNlVHVyblwiO1xuXHRcdGNhc2UgXCJzdG9wX3NlcXVlbmNlXCI6XG5cdFx0XHRyZXR1cm4gXCJzdG9wXCI7XG5cdFx0Y2FzZSBcInNlbnNpdGl2ZVwiOlxuXHRcdFx0cmV0dXJuIFwiZXJyb3JcIjtcblx0XHRkZWZhdWx0OlxuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGBVbmhhbmRsZWQgc3RvcCByZWFzb246ICR7cmVhc29ufWApO1xuXHR9XG59XG5cbi8qKiBBcmd1bWVudHMgZm9yIGBwcm9jZXNzQW50aHJvcGljU3RyZWFtYC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU3RyZWFtQW50aHJvcGljQXJncyB7XG5cdGNsaWVudDogQW50aHJvcGljO1xuXHRtb2RlbDogTW9kZWw8QW50aHJvcGljQXBpPjtcblx0Y29udGV4dDogQ29udGV4dDtcblx0aXNPQXV0aFRva2VuOiBib29sZWFuO1xuXHRvcHRpb25zPzogQW50aHJvcGljT3B0aW9ucztcblx0QW50aHJvcGljU2RrQ2xhc3M/OiB0eXBlb2YgQW50aHJvcGljO1xufVxuXG4vKiogRHJpdmUgYW4gQW50aHJvcGljIHN0cmVhbWluZyByZXNwb25zZSwgcHVzaGluZyBgQXNzaXN0YW50TWVzc2FnZUV2ZW50YHMgaW50byBgc3RyZWFtYCB1bnRpbCBkb25lIG9yIGVycm9yLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByb2Nlc3NBbnRocm9waWNTdHJlYW0oXG5cdHN0cmVhbTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtLFxuXHRhcmdzOiBTdHJlYW1BbnRocm9waWNBcmdzLFxuKTogdm9pZCB7XG5cdGNvbnN0IHsgY2xpZW50LCBtb2RlbCwgY29udGV4dCwgaXNPQXV0aFRva2VuLCBvcHRpb25zLCBBbnRocm9waWNTZGtDbGFzcyB9ID0gYXJncztcblxuXHQoYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IG91dHB1dDogQXNzaXN0YW50TWVzc2FnZSA9IHtcblx0XHRcdHJvbGU6IFwiYXNzaXN0YW50XCIsXG5cdFx0XHRjb250ZW50OiBbXSxcblx0XHRcdGFwaTogbW9kZWwuYXBpIGFzIEFwaSxcblx0XHRcdHByb3ZpZGVyOiBtb2RlbC5wcm92aWRlcixcblx0XHRcdG1vZGVsOiBtb2RlbC5pZCxcblx0XHRcdHVzYWdlOiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdFx0dG90YWxUb2tlbnM6IDAsXG5cdFx0XHRcdGNvc3Q6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbDogMCB9LFxuXHRcdFx0fSxcblx0XHRcdHN0b3BSZWFzb246IFwic3RvcFwiLFxuXHRcdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHRcdH07XG5cblx0XHR0cnkge1xuXHRcdFx0bGV0IHBhcmFtcyA9IGJ1aWxkUGFyYW1zKG1vZGVsLCBjb250ZXh0LCBpc09BdXRoVG9rZW4sIG9wdGlvbnMpO1xuXHRcdFx0Y29uc3QgbmV4dFBhcmFtcyA9IGF3YWl0IG9wdGlvbnM/Lm9uUGF5bG9hZD8uKHBhcmFtcywgbW9kZWwpO1xuXHRcdFx0aWYgKG5leHRQYXJhbXMgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRwYXJhbXMgPSBuZXh0UGFyYW1zIGFzIE1lc3NhZ2VDcmVhdGVQYXJhbXNTdHJlYW1pbmc7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBhbnRocm9waWNTdHJlYW0gPSBjbGllbnQubWVzc2FnZXMuc3RyZWFtKHsgLi4ucGFyYW1zLCBzdHJlYW06IHRydWUgfSwgeyBzaWduYWw6IG9wdGlvbnM/LnNpZ25hbCB9KTtcblx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJzdGFydFwiLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cblx0XHRcdHR5cGUgQmxvY2sgPSAoVGhpbmtpbmdDb250ZW50IHwgVGV4dENvbnRlbnQgfCAoVG9vbENhbGwgJiB7IHBhcnRpYWxKc29uOiBzdHJpbmcgfSkgfCBTZXJ2ZXJUb29sVXNlQ29udGVudCB8IFdlYlNlYXJjaFJlc3VsdENvbnRlbnQpICYgeyBpbmRleDogbnVtYmVyIH07XG5cdFx0XHRjb25zdCBibG9ja3MgPSBvdXRwdXQuY29udGVudCBhcyBCbG9ja1tdO1xuXG5cdFx0XHRmb3IgYXdhaXQgKGNvbnN0IGV2ZW50IG9mIGFudGhyb3BpY1N0cmVhbSkge1xuXHRcdFx0XHRpZiAoZXZlbnQudHlwZSA9PT0gXCJtZXNzYWdlX3N0YXJ0XCIpIHtcblx0XHRcdFx0XHRvdXRwdXQudXNhZ2UuaW5wdXQgPSBldmVudC5tZXNzYWdlLnVzYWdlLmlucHV0X3Rva2VucyB8fCAwO1xuXHRcdFx0XHRcdG91dHB1dC51c2FnZS5vdXRwdXQgPSBldmVudC5tZXNzYWdlLnVzYWdlLm91dHB1dF90b2tlbnMgfHwgMDtcblx0XHRcdFx0XHRvdXRwdXQudXNhZ2UuY2FjaGVSZWFkID0gZXZlbnQubWVzc2FnZS51c2FnZS5jYWNoZV9yZWFkX2lucHV0X3Rva2VucyB8fCAwO1xuXHRcdFx0XHRcdG91dHB1dC51c2FnZS5jYWNoZVdyaXRlID0gZXZlbnQubWVzc2FnZS51c2FnZS5jYWNoZV9jcmVhdGlvbl9pbnB1dF90b2tlbnMgfHwgMDtcblx0XHRcdFx0XHRvdXRwdXQudXNhZ2UudG90YWxUb2tlbnMgPVxuXHRcdFx0XHRcdFx0b3V0cHV0LnVzYWdlLmlucHV0ICsgb3V0cHV0LnVzYWdlLm91dHB1dCArIG91dHB1dC51c2FnZS5jYWNoZVJlYWQgKyBvdXRwdXQudXNhZ2UuY2FjaGVXcml0ZTtcblx0XHRcdFx0XHRjYWxjdWxhdGVDb3N0KG1vZGVsLCBvdXRwdXQudXNhZ2UpO1xuXHRcdFx0XHR9IGVsc2UgaWYgKGV2ZW50LnR5cGUgPT09IFwiY29udGVudF9ibG9ja19zdGFydFwiKSB7XG5cdFx0XHRcdFx0aWYgKGV2ZW50LmNvbnRlbnRfYmxvY2sudHlwZSA9PT0gXCJ0ZXh0XCIpIHtcblx0XHRcdFx0XHRcdGNvbnN0IGJsb2NrOiBCbG9jayA9IHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHRcdHRleHQ6IFwiXCIsXG5cdFx0XHRcdFx0XHRcdGluZGV4OiBldmVudC5pbmRleCxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHRvdXRwdXQuY29udGVudC5wdXNoKGJsb2NrKTtcblx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0ZXh0X3N0YXJ0XCIsIGNvbnRlbnRJbmRleDogb3V0cHV0LmNvbnRlbnQubGVuZ3RoIC0gMSwgcGFydGlhbDogb3V0cHV0IH0pO1xuXHRcdFx0XHRcdH0gZWxzZSBpZiAoZXZlbnQuY29udGVudF9ibG9jay50eXBlID09PSBcInRoaW5raW5nXCIpIHtcblx0XHRcdFx0XHRcdGNvbnN0IGJsb2NrOiBCbG9jayA9IHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0aGlua2luZ1wiLFxuXHRcdFx0XHRcdFx0XHR0aGlua2luZzogXCJcIixcblx0XHRcdFx0XHRcdFx0dGhpbmtpbmdTaWduYXR1cmU6IFwiXCIsXG5cdFx0XHRcdFx0XHRcdGluZGV4OiBldmVudC5pbmRleCxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHRvdXRwdXQuY29udGVudC5wdXNoKGJsb2NrKTtcblx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0aGlua2luZ19zdGFydFwiLCBjb250ZW50SW5kZXg6IG91dHB1dC5jb250ZW50Lmxlbmd0aCAtIDEsIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHRcdFx0XHR9IGVsc2UgaWYgKGV2ZW50LmNvbnRlbnRfYmxvY2sudHlwZSA9PT0gXCJyZWRhY3RlZF90aGlua2luZ1wiKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBibG9jazogQmxvY2sgPSB7XG5cdFx0XHRcdFx0XHRcdHR5cGU6IFwidGhpbmtpbmdcIixcblx0XHRcdFx0XHRcdFx0dGhpbmtpbmc6IFwiW1JlYXNvbmluZyByZWRhY3RlZF1cIixcblx0XHRcdFx0XHRcdFx0dGhpbmtpbmdTaWduYXR1cmU6IGV2ZW50LmNvbnRlbnRfYmxvY2suZGF0YSxcblx0XHRcdFx0XHRcdFx0cmVkYWN0ZWQ6IHRydWUsXG5cdFx0XHRcdFx0XHRcdGluZGV4OiBldmVudC5pbmRleCxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHRvdXRwdXQuY29udGVudC5wdXNoKGJsb2NrKTtcblx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0aGlua2luZ19zdGFydFwiLCBjb250ZW50SW5kZXg6IG91dHB1dC5jb250ZW50Lmxlbmd0aCAtIDEsIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHRcdFx0XHR9IGVsc2UgaWYgKGV2ZW50LmNvbnRlbnRfYmxvY2sudHlwZSA9PT0gXCJ0b29sX3VzZVwiKSB7XG5cdFx0XHRcdFx0XHQvLyBHdWFyZDogc29tZSBBbnRocm9waWMtY29tcGF0aWJsZSBwcm92aWRlcnMgKGUuZy4gTWluaU1heCB3aXRoXG5cdFx0XHRcdFx0XHQvLyBmaW5lLWdyYWluZWQtdG9vbC1zdHJlYW1pbmcgYmV0YSkgc3RyZWFtIHRoZSB0b29sIG5hbWUgYXMgYSBkZWx0YSxcblx0XHRcdFx0XHRcdC8vIGxlYXZpbmcgY29udGVudF9ibG9jay5uYW1lIGFzIFwiXCIgaGVyZS4gRmFsbCBiYWNrIHRvIHRoZSB0b29sIGxpc3Rcblx0XHRcdFx0XHRcdC8vIGlmIGF2YWlsYWJsZSB0byBhdm9pZCBzdG9yaW5nIGFuIGVtcHR5IG5hbWUgaW4gaGlzdG9yeSAoIzQ1MzgpLlxuXHRcdFx0XHRcdFx0Y29uc3QgcmF3TmFtZSA9IGV2ZW50LmNvbnRlbnRfYmxvY2submFtZTtcblx0XHRcdFx0XHRcdGxldCByZXNvbHZlZE5hbWU6IHN0cmluZztcblx0XHRcdFx0XHRcdGlmIChyYXdOYW1lKSB7XG5cdFx0XHRcdFx0XHRcdHJlc29sdmVkTmFtZSA9IGlzT0F1dGhUb2tlbiA/IGZyb21DbGF1ZGVDb2RlTmFtZShyYXdOYW1lLCBjb250ZXh0LnRvb2xzKSA6IHJhd05hbWU7XG5cdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRjb25zdCBmYWxsYmFja05hbWUgPSBjb250ZXh0LnRvb2xzPy5bMF0/Lm5hbWUgPz8gcmF3TmFtZTtcblx0XHRcdFx0XHRcdFx0aWYgKGZhbGxiYWNrTmFtZSAmJiBmYWxsYmFja05hbWUgIT09IHJhd05hbWUpIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zb2xlLndhcm4oYFthbnRocm9waWMtc2hhcmVkXSBFbXB0eSB0b29sIG5hbWUgaW4gY29udGVudF9ibG9ja19zdGFydCAoaWQ9JHtldmVudC5jb250ZW50X2Jsb2NrLmlkfSk7IGZhbGxpbmcgYmFjayB0byBmaXJzdCB0b29sOiAke2ZhbGxiYWNrTmFtZX1gKTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRyZXNvbHZlZE5hbWUgPSBmYWxsYmFja05hbWU7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRjb25zdCBibG9jazogQmxvY2sgPSB7XG5cdFx0XHRcdFx0XHRcdHR5cGU6IFwidG9vbENhbGxcIixcblx0XHRcdFx0XHRcdFx0aWQ6IGV2ZW50LmNvbnRlbnRfYmxvY2suaWQsXG5cdFx0XHRcdFx0XHRcdG5hbWU6IHJlc29sdmVkTmFtZSxcblx0XHRcdFx0XHRcdFx0YXJndW1lbnRzOiAoZXZlbnQuY29udGVudF9ibG9jay5pbnB1dCBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+KSA/PyB7fSxcblx0XHRcdFx0XHRcdFx0cGFydGlhbEpzb246IFwiXCIsXG5cdFx0XHRcdFx0XHRcdGluZGV4OiBldmVudC5pbmRleCxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHRvdXRwdXQuY29udGVudC5wdXNoKGJsb2NrKTtcblx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0b29sY2FsbF9zdGFydFwiLCBjb250ZW50SW5kZXg6IG91dHB1dC5jb250ZW50Lmxlbmd0aCAtIDEsIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHRcdFx0XHR9IGVsc2UgaWYgKChldmVudC5jb250ZW50X2Jsb2NrIGFzIGFueSkudHlwZSA9PT0gXCJzZXJ2ZXJfdG9vbF91c2VcIikge1xuXHRcdFx0XHRcdFx0Y29uc3Qgc2VydmVyQmxvY2sgPSBldmVudC5jb250ZW50X2Jsb2NrIGFzIGFueTtcblx0XHRcdFx0XHRcdGNvbnN0IGJsb2NrOiBCbG9jayA9IHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJzZXJ2ZXJUb29sVXNlXCIsXG5cdFx0XHRcdFx0XHRcdGlkOiBzZXJ2ZXJCbG9jay5pZCxcblx0XHRcdFx0XHRcdFx0bmFtZTogc2VydmVyQmxvY2submFtZSxcblx0XHRcdFx0XHRcdFx0aW5wdXQ6IHNlcnZlckJsb2NrLmlucHV0LFxuXHRcdFx0XHRcdFx0XHRpbmRleDogZXZlbnQuaW5kZXgsXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdFx0b3V0cHV0LmNvbnRlbnQucHVzaChibG9jayk7XG5cdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwic2VydmVyX3Rvb2xfdXNlXCIsIGNvbnRlbnRJbmRleDogb3V0cHV0LmNvbnRlbnQubGVuZ3RoIC0gMSwgcGFydGlhbDogb3V0cHV0IH0pO1xuXHRcdFx0XHRcdH0gZWxzZSBpZiAoKGV2ZW50LmNvbnRlbnRfYmxvY2sgYXMgYW55KS50eXBlID09PSBcIndlYl9zZWFyY2hfdG9vbF9yZXN1bHRcIikge1xuXHRcdFx0XHRcdFx0Y29uc3QgcmVzdWx0QmxvY2sgPSBldmVudC5jb250ZW50X2Jsb2NrIGFzIGFueTtcblx0XHRcdFx0XHRcdGNvbnN0IGJsb2NrOiBCbG9jayA9IHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ3ZWJTZWFyY2hSZXN1bHRcIixcblx0XHRcdFx0XHRcdFx0dG9vbFVzZUlkOiByZXN1bHRCbG9jay50b29sX3VzZV9pZCxcblx0XHRcdFx0XHRcdFx0Y29udGVudDogcmVzdWx0QmxvY2suY29udGVudCxcblx0XHRcdFx0XHRcdFx0aW5kZXg6IGV2ZW50LmluZGV4LFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdG91dHB1dC5jb250ZW50LnB1c2goYmxvY2spO1xuXHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcIndlYl9zZWFyY2hfcmVzdWx0XCIsIGNvbnRlbnRJbmRleDogb3V0cHV0LmNvbnRlbnQubGVuZ3RoIC0gMSwgcGFydGlhbDogb3V0cHV0IH0pO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBlbHNlIGlmIChldmVudC50eXBlID09PSBcImNvbnRlbnRfYmxvY2tfZGVsdGFcIikge1xuXHRcdFx0XHRcdGlmIChldmVudC5kZWx0YS50eXBlID09PSBcInRleHRfZGVsdGFcIikge1xuXHRcdFx0XHRcdFx0Y29uc3QgaW5kZXggPSBibG9ja3MuZmluZEluZGV4KChiKSA9PiBiLmluZGV4ID09PSBldmVudC5pbmRleCk7XG5cdFx0XHRcdFx0XHRjb25zdCBibG9jayA9IGJsb2Nrc1tpbmRleF07XG5cdFx0XHRcdFx0XHRpZiAoYmxvY2sgJiYgYmxvY2sudHlwZSA9PT0gXCJ0ZXh0XCIpIHtcblx0XHRcdFx0XHRcdFx0YmxvY2sudGV4dCArPSBldmVudC5kZWx0YS50ZXh0O1xuXHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0X2RlbHRhXCIsXG5cdFx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBpbmRleCxcblx0XHRcdFx0XHRcdFx0XHRkZWx0YTogZXZlbnQuZGVsdGEudGV4dCxcblx0XHRcdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH0gZWxzZSBpZiAoZXZlbnQuZGVsdGEudHlwZSA9PT0gXCJ0aGlua2luZ19kZWx0YVwiKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBpbmRleCA9IGJsb2Nrcy5maW5kSW5kZXgoKGIpID0+IGIuaW5kZXggPT09IGV2ZW50LmluZGV4KTtcblx0XHRcdFx0XHRcdGNvbnN0IGJsb2NrID0gYmxvY2tzW2luZGV4XTtcblx0XHRcdFx0XHRcdGlmIChibG9jayAmJiBibG9jay50eXBlID09PSBcInRoaW5raW5nXCIpIHtcblx0XHRcdFx0XHRcdFx0YmxvY2sudGhpbmtpbmcgKz0gZXZlbnQuZGVsdGEudGhpbmtpbmc7XG5cdFx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdFx0XHR0eXBlOiBcInRoaW5raW5nX2RlbHRhXCIsXG5cdFx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBpbmRleCxcblx0XHRcdFx0XHRcdFx0XHRkZWx0YTogZXZlbnQuZGVsdGEudGhpbmtpbmcsXG5cdFx0XHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9IGVsc2UgaWYgKGV2ZW50LmRlbHRhLnR5cGUgPT09IFwiaW5wdXRfanNvbl9kZWx0YVwiKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBpbmRleCA9IGJsb2Nrcy5maW5kSW5kZXgoKGIpID0+IGIuaW5kZXggPT09IGV2ZW50LmluZGV4KTtcblx0XHRcdFx0XHRcdGNvbnN0IGJsb2NrID0gYmxvY2tzW2luZGV4XTtcblx0XHRcdFx0XHRcdGlmIChibG9jayAmJiBibG9jay50eXBlID09PSBcInRvb2xDYWxsXCIpIHtcblx0XHRcdFx0XHRcdFx0YmxvY2sucGFydGlhbEpzb24gKz0gZXZlbnQuZGVsdGEucGFydGlhbF9qc29uO1xuXHRcdFx0XHRcdFx0XHRibG9jay5hcmd1bWVudHMgPSBwYXJzZVN0cmVhbWluZ0pzb24oYmxvY2sucGFydGlhbEpzb24pO1xuXHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0b29sY2FsbF9kZWx0YVwiLFxuXHRcdFx0XHRcdFx0XHRcdGNvbnRlbnRJbmRleDogaW5kZXgsXG5cdFx0XHRcdFx0XHRcdFx0ZGVsdGE6IGV2ZW50LmRlbHRhLnBhcnRpYWxfanNvbixcblx0XHRcdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH0gZWxzZSBpZiAoZXZlbnQuZGVsdGEudHlwZSA9PT0gXCJzaWduYXR1cmVfZGVsdGFcIikge1xuXHRcdFx0XHRcdFx0Y29uc3QgaW5kZXggPSBibG9ja3MuZmluZEluZGV4KChiKSA9PiBiLmluZGV4ID09PSBldmVudC5pbmRleCk7XG5cdFx0XHRcdFx0XHRjb25zdCBibG9jayA9IGJsb2Nrc1tpbmRleF07XG5cdFx0XHRcdFx0XHRpZiAoYmxvY2sgJiYgYmxvY2sudHlwZSA9PT0gXCJ0aGlua2luZ1wiKSB7XG5cdFx0XHRcdFx0XHRcdGJsb2NrLnRoaW5raW5nU2lnbmF0dXJlID0gYmxvY2sudGhpbmtpbmdTaWduYXR1cmUgfHwgXCJcIjtcblx0XHRcdFx0XHRcdFx0YmxvY2sudGhpbmtpbmdTaWduYXR1cmUgKz0gZXZlbnQuZGVsdGEuc2lnbmF0dXJlO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBlbHNlIGlmIChldmVudC50eXBlID09PSBcImNvbnRlbnRfYmxvY2tfc3RvcFwiKSB7XG5cdFx0XHRcdFx0Y29uc3QgaW5kZXggPSBibG9ja3MuZmluZEluZGV4KChiKSA9PiBiLmluZGV4ID09PSBldmVudC5pbmRleCk7XG5cdFx0XHRcdFx0Y29uc3QgYmxvY2sgPSBibG9ja3NbaW5kZXhdO1xuXHRcdFx0XHRcdGlmIChibG9jaykge1xuXHRcdFx0XHRcdFx0ZGVsZXRlIChibG9jayBhcyBhbnkpLmluZGV4O1xuXHRcdFx0XHRcdFx0aWYgKGJsb2NrLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdFx0XHR0eXBlOiBcInRleHRfZW5kXCIsXG5cdFx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBpbmRleCxcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBibG9jay50ZXh0LFxuXHRcdFx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHR9IGVsc2UgaWYgKGJsb2NrLnR5cGUgPT09IFwidGhpbmtpbmdcIikge1xuXHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0aGlua2luZ19lbmRcIixcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGluZGV4LFxuXHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IGJsb2NrLnRoaW5raW5nLFxuXHRcdFx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHR9IGVsc2UgaWYgKGJsb2NrLnR5cGUgPT09IFwidG9vbENhbGxcIikge1xuXHRcdFx0XHRcdFx0XHQvLyBUcnkgc3RyaWN0IHBhcnNlIGZpcnN0OyBpZiBpdCBmYWlscywgYXR0ZW1wdCBZQU1MIGJ1bGxldFxuXHRcdFx0XHRcdFx0XHQvLyByZXBhaXIgKCMyNjYwKSBiZWZvcmUgZmFsbGluZyBiYWNrIHRvIHRoZSBsZW5pZW50IHN0cmVhbWluZ1xuXHRcdFx0XHRcdFx0XHQvLyBwYXJzZXIgd2hpY2ggc2lsZW50bHkgc3dhbGxvd3MgZXJyb3JzLlxuXHRcdFx0XHRcdFx0XHRjb25zdCByYXcgPSBibG9jay5wYXJ0aWFsSnNvbiA/PyBcIlwiO1xuXHRcdFx0XHRcdFx0XHRjb25zdCByYXdGb3JQYXJzZSA9IGhhc1htbFBhcmFtZXRlclRhZ3MocmF3KSA/IHJlcGFpclRvb2xKc29uKHJhdykgOiByYXc7XG5cdFx0XHRcdFx0XHRcdGxldCBwYXJzZWQ6IFJlY29yZDxzdHJpbmcsIGFueT4gfCB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdFx0cGFyc2VkID0gSlNPTi5wYXJzZShyYXdGb3JQYXJzZSk7XG5cdFx0XHRcdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRwYXJzZWQgPSBKU09OLnBhcnNlKHJlcGFpclRvb2xKc29uKHJhd0ZvclBhcnNlKSk7XG5cdFx0XHRcdFx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0XHRcdFx0XHQvLyBGYWxsIHRocm91Z2ggdG8gc3RyZWFtaW5nIHBhcnNlclxuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRibG9jay5hcmd1bWVudHMgPSBwYXJzZWQgPz8gcGFyc2VTdHJlYW1pbmdKc29uKGJsb2NrLnBhcnRpYWxKc29uKTtcblx0XHRcdFx0XHRcdFx0ZGVsZXRlIChibG9jayBhcyBhbnkpLnBhcnRpYWxKc29uO1xuXHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0b29sY2FsbF9lbmRcIixcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGluZGV4LFxuXHRcdFx0XHRcdFx0XHRcdHRvb2xDYWxsOiBibG9jayxcblx0XHRcdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBlbHNlIGlmIChldmVudC50eXBlID09PSBcIm1lc3NhZ2VfZGVsdGFcIikge1xuXHRcdFx0XHRcdGlmIChldmVudC5kZWx0YS5zdG9wX3JlYXNvbikge1xuXHRcdFx0XHRcdFx0b3V0cHV0LnN0b3BSZWFzb24gPSBtYXBTdG9wUmVhc29uKGV2ZW50LmRlbHRhLnN0b3BfcmVhc29uKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0aWYgKGV2ZW50LnVzYWdlLmlucHV0X3Rva2VucyAhPSBudWxsKSB7XG5cdFx0XHRcdFx0XHRvdXRwdXQudXNhZ2UuaW5wdXQgPSBldmVudC51c2FnZS5pbnB1dF90b2tlbnM7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGlmIChldmVudC51c2FnZS5vdXRwdXRfdG9rZW5zICE9IG51bGwpIHtcblx0XHRcdFx0XHRcdG91dHB1dC51c2FnZS5vdXRwdXQgPSBldmVudC51c2FnZS5vdXRwdXRfdG9rZW5zO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRpZiAoZXZlbnQudXNhZ2UuY2FjaGVfcmVhZF9pbnB1dF90b2tlbnMgIT0gbnVsbCkge1xuXHRcdFx0XHRcdFx0b3V0cHV0LnVzYWdlLmNhY2hlUmVhZCA9IGV2ZW50LnVzYWdlLmNhY2hlX3JlYWRfaW5wdXRfdG9rZW5zO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRpZiAoZXZlbnQudXNhZ2UuY2FjaGVfY3JlYXRpb25faW5wdXRfdG9rZW5zICE9IG51bGwpIHtcblx0XHRcdFx0XHRcdG91dHB1dC51c2FnZS5jYWNoZVdyaXRlID0gZXZlbnQudXNhZ2UuY2FjaGVfY3JlYXRpb25faW5wdXRfdG9rZW5zO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRvdXRwdXQudXNhZ2UudG90YWxUb2tlbnMgPVxuXHRcdFx0XHRcdFx0b3V0cHV0LnVzYWdlLmlucHV0ICsgb3V0cHV0LnVzYWdlLm91dHB1dCArIG91dHB1dC51c2FnZS5jYWNoZVJlYWQgKyBvdXRwdXQudXNhZ2UuY2FjaGVXcml0ZTtcblx0XHRcdFx0XHRjYWxjdWxhdGVDb3N0KG1vZGVsLCBvdXRwdXQudXNhZ2UpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGlmIChvcHRpb25zPy5zaWduYWw/LmFib3J0ZWQpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiUmVxdWVzdCB3YXMgYWJvcnRlZFwiKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKG91dHB1dC5zdG9wUmVhc29uID09PSBcImFib3J0ZWRcIiB8fCBvdXRwdXQuc3RvcFJlYXNvbiA9PT0gXCJlcnJvclwiKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIkFuIHVua25vd24gZXJyb3Igb2NjdXJyZWRcIik7XG5cdFx0XHR9XG5cblx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJkb25lXCIsIHJlYXNvbjogb3V0cHV0LnN0b3BSZWFzb24sIG1lc3NhZ2U6IG91dHB1dCB9KTtcblx0XHRcdHN0cmVhbS5lbmQoKTtcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0Zm9yIChjb25zdCBibG9jayBvZiBvdXRwdXQuY29udGVudCkgZGVsZXRlIChibG9jayBhcyBhbnkpLmluZGV4O1xuXHRcdFx0b3V0cHV0LnN0b3BSZWFzb24gPSBvcHRpb25zPy5zaWduYWw/LmFib3J0ZWQgPyBcImFib3J0ZWRcIiA6IFwiZXJyb3JcIjtcblx0XHRcdG91dHB1dC5lcnJvck1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IEpTT04uc3RyaW5naWZ5KGVycm9yKTtcblx0XHRcdGlmIChtb2RlbC5wcm92aWRlciA9PT0gXCJhbGliYWJhLWNvZGluZy1wbGFuXCIpIHtcblx0XHRcdFx0b3V0cHV0LmVycm9yTWVzc2FnZSA9IGBbYWxpYmFiYS1jb2RpbmctcGxhbl0gJHtvdXRwdXQuZXJyb3JNZXNzYWdlfWA7XG5cdFx0XHR9XG5cdFx0XHRpZiAoQW50aHJvcGljU2RrQ2xhc3MgJiYgZXJyb3IgaW5zdGFuY2VvZiBBbnRocm9waWNTZGtDbGFzcy5BUElFcnJvciAmJiBlcnJvci5oZWFkZXJzKSB7XG5cdFx0XHRcdGNvbnN0IHJldHJ5QWZ0ZXJNcyA9IGV4dHJhY3RSZXRyeUFmdGVyTXMoZXJyb3IuaGVhZGVycywgZXJyb3IubWVzc2FnZSk7XG5cdFx0XHRcdGlmIChyZXRyeUFmdGVyTXMgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRcdG91dHB1dC5yZXRyeUFmdGVyTXMgPSByZXRyeUFmdGVyTXM7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdGlmIChpc1RyYW5zaWVudE5ldHdvcmtFcnJvcihlcnJvcikpIHtcblx0XHRcdFx0b3V0cHV0LnJldHJ5QWZ0ZXJNcyA9IG91dHB1dC5yZXRyeUFmdGVyTXMgPz8gNTAwMDtcblx0XHRcdH1cblx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJlcnJvclwiLCByZWFzb246IG91dHB1dC5zdG9wUmVhc29uLCBlcnJvcjogb3V0cHV0IH0pO1xuXHRcdFx0c3RyZWFtLmVu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
