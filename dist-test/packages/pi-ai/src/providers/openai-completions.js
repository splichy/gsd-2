import { getEnvApiKey } from "../env-api-keys.js";
import { calculateCost, supportsXhigh } from "../models.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { buildBaseOptions, clampReasoning } from "./simple-options.js";
import {
  assertStreamSuccess,
  buildInitialOutput,
  createOpenAIClient,
  finalizeStream,
  handleStreamError
} from "./openai-shared.js";
import { ThinkTagParser } from "./think-tag-parser.js";
import { transformMessagesWithReport } from "./transform-messages.js";
function hasToolHistory(messages) {
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      return true;
    }
    if (msg.role === "assistant") {
      if (msg.content.some((block) => block.type === "toolCall")) {
        return true;
      }
    }
  }
  return false;
}
const streamOpenAICompletions = (model, context, options) => {
  const stream = new AssistantMessageEventStream();
  (async () => {
    const output = buildInitialOutput(model);
    try {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      const isZai = model.provider === "zai" || model.baseUrl.includes("api.z.ai");
      const client = await createOpenAIClient(model, context, apiKey, {
        optionsHeaders: options?.headers,
        extraClientOptions: isZai ? { timeout: 1e5, maxRetries: 4 } : void 0
      });
      let params = buildParams(model, context, options);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== void 0) {
        params = nextParams;
      }
      const openaiStream = await client.chat.completions.create(params, { signal: options?.signal });
      stream.push({ type: "start", partial: output });
      let currentBlock = null;
      const thinkTagParser = new ThinkTagParser();
      const blocks = output.content;
      const blockIndex = () => blocks.length - 1;
      const finishCurrentBlock = (block) => {
        if (block) {
          if (block.type === "text") {
            stream.push({
              type: "text_end",
              contentIndex: blockIndex(),
              content: block.text,
              partial: output
            });
          } else if (block.type === "thinking") {
            stream.push({
              type: "thinking_end",
              contentIndex: blockIndex(),
              content: block.thinking,
              partial: output
            });
          } else if (block.type === "toolCall") {
            block.arguments = parseStreamingJson(block.partialArgs);
            delete block.partialArgs;
            stream.push({
              type: "toolcall_end",
              contentIndex: blockIndex(),
              toolCall: block,
              partial: output
            });
          }
        }
      };
      const appendTextDelta = (delta) => {
        if (!delta) return;
        if (!currentBlock || currentBlock.type !== "text") {
          finishCurrentBlock(currentBlock);
          currentBlock = { type: "text", text: "" };
          output.content.push(currentBlock);
          stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
        }
        if (currentBlock.type === "text") {
          currentBlock.text += delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta,
            partial: output
          });
        }
      };
      const appendThinkingDelta = (delta) => {
        if (!delta) return;
        if (!currentBlock || currentBlock.type !== "thinking") {
          finishCurrentBlock(currentBlock);
          currentBlock = {
            type: "thinking",
            thinking: "",
            thinkingSignature: "think-tag"
          };
          output.content.push(currentBlock);
          stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
        }
        if (currentBlock.type === "thinking") {
          currentBlock.thinking += delta;
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta,
            partial: output
          });
        }
      };
      const appendContentDelta = (delta) => {
        const segments = thinkTagParser.consume(delta);
        for (const segment of segments) {
          if (segment.type === "thinking") appendThinkingDelta(segment.text);
          else appendTextDelta(segment.text);
        }
      };
      for await (const chunk of openaiStream) {
        if (chunk.usage) {
          const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens || 0;
          const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens || 0;
          const input = (chunk.usage.prompt_tokens || 0) - cachedTokens;
          const outputTokens = (chunk.usage.completion_tokens || 0) + reasoningTokens;
          output.usage = {
            // OpenAI includes cached tokens in prompt_tokens, so subtract to get non-cached input
            input,
            output: outputTokens,
            cacheRead: cachedTokens,
            cacheWrite: 0,
            // Compute totalTokens ourselves since we add reasoning_tokens to output
            // and some providers (e.g., Groq) don't include them in total_tokens
            totalTokens: input + outputTokens + cachedTokens,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0
            }
          };
          calculateCost(model, output.usage);
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) {
          output.stopReason = mapStopReason(choice.finish_reason);
        }
        if (choice.delta) {
          if (choice.delta.content !== null && choice.delta.content !== void 0 && choice.delta.content.length > 0) {
            appendContentDelta(choice.delta.content);
          }
          const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
          let foundReasoningField = null;
          for (const field of reasoningFields) {
            if (choice.delta[field] !== null && choice.delta[field] !== void 0 && choice.delta[field].length > 0) {
              if (!foundReasoningField) {
                foundReasoningField = field;
                break;
              }
            }
          }
          if (foundReasoningField) {
            if (!currentBlock || currentBlock.type !== "thinking") {
              finishCurrentBlock(currentBlock);
              currentBlock = {
                type: "thinking",
                thinking: "",
                thinkingSignature: foundReasoningField
              };
              output.content.push(currentBlock);
              stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
            }
            if (currentBlock.type === "thinking") {
              const delta = choice.delta[foundReasoningField];
              currentBlock.thinking += delta;
              stream.push({
                type: "thinking_delta",
                contentIndex: blockIndex(),
                delta,
                partial: output
              });
            }
          }
          if (choice?.delta?.tool_calls) {
            for (const toolCall of choice.delta.tool_calls) {
              if (!currentBlock || currentBlock.type !== "toolCall" || toolCall.id && currentBlock.id !== toolCall.id) {
                finishCurrentBlock(currentBlock);
                currentBlock = {
                  type: "toolCall",
                  id: toolCall.id || "",
                  name: toolCall.function?.name || "",
                  arguments: {},
                  partialArgs: ""
                };
                output.content.push(currentBlock);
                stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
              }
              if (currentBlock.type === "toolCall") {
                if (toolCall.id) currentBlock.id = toolCall.id;
                if (toolCall.function?.name) currentBlock.name = toolCall.function.name;
                let delta = "";
                if (toolCall.function?.arguments) {
                  delta = toolCall.function.arguments;
                  currentBlock.partialArgs += toolCall.function.arguments;
                  currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
                }
                stream.push({
                  type: "toolcall_delta",
                  contentIndex: blockIndex(),
                  delta,
                  partial: output
                });
              }
            }
          }
          const reasoningDetails = choice.delta.reasoning_details;
          if (reasoningDetails && Array.isArray(reasoningDetails)) {
            for (const detail of reasoningDetails) {
              if (detail.type === "reasoning.encrypted" && detail.id && detail.data) {
                const matchingToolCall = output.content.find(
                  (b) => b.type === "toolCall" && b.id === detail.id
                );
                if (matchingToolCall) {
                  matchingToolCall.thoughtSignature = JSON.stringify(detail);
                }
              }
            }
          }
        }
      }
      for (const segment of thinkTagParser.flush()) {
        if (segment.type === "thinking") appendThinkingDelta(segment.text);
        else appendTextDelta(segment.text);
      }
      finishCurrentBlock(currentBlock);
      assertStreamSuccess(output, options?.signal);
      finalizeStream(stream, output);
    } catch (error) {
      const rawMetadata = error?.error?.metadata?.raw;
      handleStreamError(stream, output, error, options?.signal, rawMetadata);
    }
  })();
  return stream;
};
const streamSimpleOpenAICompletions = (model, context, options) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const base = buildBaseOptions(model, options, apiKey);
  const reasoningEffort = supportsXhigh(model) ? options?.reasoning : clampReasoning(options?.reasoning);
  const toolChoice = options?.toolChoice;
  return streamOpenAICompletions(model, context, {
    ...base,
    reasoningEffort,
    toolChoice
  });
};
function buildParams(model, context, options) {
  const compat = getCompat(model);
  const messages = convertMessages(model, context, compat);
  maybeAddOpenRouterAnthropicCacheControl(model, messages);
  const params = {
    model: model.id,
    messages,
    stream: true
  };
  if (compat.supportsUsageInStreaming !== false) {
    params.stream_options = { include_usage: true };
  }
  if (compat.supportsStore) {
    params.store = false;
  }
  if (options?.maxTokens) {
    if (compat.maxTokensField === "max_tokens") {
      params.max_tokens = options.maxTokens;
    } else {
      params.max_completion_tokens = options.maxTokens;
    }
  }
  if (options?.temperature !== void 0) {
    params.temperature = options.temperature;
  }
  if (context.tools) {
    params.tools = convertTools(context.tools, compat);
    maybeAddOpenRouterAnthropicToolCacheControl(model, params.tools);
  } else if (hasToolHistory(context.messages)) {
    params.tools = [];
  }
  if (options?.toolChoice) {
    params.tool_choice = options.toolChoice;
  }
  if ((compat.thinkingFormat === "zai" || compat.thinkingFormat === "qwen") && model.reasoning) {
    params.enable_thinking = !!options?.reasoningEffort;
  } else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
    params.reasoning_effort = mapReasoningEffort(options.reasoningEffort, compat.reasoningEffortMap);
  }
  if (model.baseUrl.includes("openrouter.ai") && model.compat?.openRouterRouting) {
    params.provider = model.compat.openRouterRouting;
  }
  if (model.baseUrl.includes("ai-gateway.vercel.sh") && model.compat?.vercelGatewayRouting) {
    const routing = model.compat.vercelGatewayRouting;
    if (routing.only || routing.order) {
      const gatewayOptions = {};
      if (routing.only) gatewayOptions.only = routing.only;
      if (routing.order) gatewayOptions.order = routing.order;
      params.providerOptions = { gateway: gatewayOptions };
    }
  }
  return params;
}
function maybeAddOpenRouterAnthropicToolCacheControl(model, tools) {
  if (model.provider !== "openrouter" || !model.id.startsWith("anthropic/")) return;
  if (!tools?.length) return;
  const lastTool = tools[tools.length - 1];
  if ("function" in lastTool) {
    Object.assign(lastTool.function, { cache_control: { type: "ephemeral" } });
  }
}
function mapReasoningEffort(effort, reasoningEffortMap) {
  return reasoningEffortMap[effort] ?? effort;
}
function maybeAddOpenRouterAnthropicCacheControl(model, messages) {
  if (model.provider !== "openrouter" || !model.id.startsWith("anthropic/")) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") {
      msg.content = [
        Object.assign({ type: "text", text: content }, { cache_control: { type: "ephemeral" } })
      ];
      return;
    }
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      if (part?.type === "text") {
        Object.assign(part, { cache_control: { type: "ephemeral" } });
        return;
      }
    }
  }
}
function convertMessages(model, context, compat) {
  const params = [];
  const normalizeToolCallId = (id) => {
    if (id.includes("|")) {
      const [callId] = id.split("|");
      return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    }
    if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
    return id;
  };
  const transformedMessages = transformMessagesWithReport(context.messages, model, (id) => normalizeToolCallId(id), "openai-completions");
  if (context.systemPrompt) {
    const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
    const role = useDeveloperRole ? "developer" : "system";
    params.push({ role, content: sanitizeSurrogates(context.systemPrompt) });
  }
  let lastRole = null;
  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
      params.push({
        role: "assistant",
        content: "I have processed the tool results."
      });
    }
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        params.push({
          role: "user",
          content: sanitizeSurrogates(msg.content)
        });
      } else {
        const content = msg.content.map((item) => {
          if (item.type === "text") {
            return {
              type: "text",
              text: sanitizeSurrogates(item.text)
            };
          } else {
            return {
              type: "image_url",
              image_url: {
                url: `data:${item.mimeType};base64,${item.data}`
              }
            };
          }
        });
        const filteredContent = !model.input.includes("image") ? content.filter((c) => c.type !== "image_url") : content;
        if (filteredContent.length === 0) continue;
        params.push({
          role: "user",
          content: filteredContent
        });
      }
    } else if (msg.role === "assistant") {
      const assistantMsg = {
        role: "assistant",
        content: compat.requiresAssistantAfterToolResult ? "" : null
      };
      const textBlocks = msg.content.filter((b) => b.type === "text");
      const nonEmptyTextBlocks = textBlocks.filter((b) => b.text && b.text.trim().length > 0);
      if (nonEmptyTextBlocks.length > 0) {
        if (model.provider === "github-copilot") {
          assistantMsg.content = nonEmptyTextBlocks.map((b) => sanitizeSurrogates(b.text)).join("");
        } else {
          assistantMsg.content = nonEmptyTextBlocks.map((b) => {
            return { type: "text", text: sanitizeSurrogates(b.text) };
          });
        }
      }
      const thinkingBlocks = msg.content.filter((b) => b.type === "thinking");
      const nonEmptyThinkingBlocks = thinkingBlocks.filter((b) => b.thinking && b.thinking.trim().length > 0);
      if (nonEmptyThinkingBlocks.length > 0) {
        if (compat.requiresThinkingAsText) {
          const thinkingText = nonEmptyThinkingBlocks.map((b) => b.thinking).join("\n\n");
          const textContent = assistantMsg.content;
          if (textContent) {
            textContent.unshift({ type: "text", text: thinkingText });
          } else {
            assistantMsg.content = [{ type: "text", text: thinkingText }];
          }
        } else {
          const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
          if (signature && signature.length > 0) {
            assistantMsg[signature] = nonEmptyThinkingBlocks.map((b) => b.thinking).join("\n");
          }
        }
      }
      const toolCalls = msg.content.filter((b) => b.type === "toolCall");
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        }));
        const reasoningDetails = toolCalls.filter((tc) => tc.thoughtSignature).map((tc) => {
          try {
            return JSON.parse(tc.thoughtSignature);
          } catch {
            return null;
          }
        }).filter(Boolean);
        if (reasoningDetails.length > 0) {
          assistantMsg.reasoning_details = reasoningDetails;
        }
      }
      const content = assistantMsg.content;
      const hasContent = content !== null && content !== void 0 && (typeof content === "string" ? content.length > 0 : content.length > 0);
      if (!hasContent && !assistantMsg.tool_calls) {
        continue;
      }
      params.push(assistantMsg);
    } else if (msg.role === "toolResult") {
      const imageBlocks = [];
      let j = i;
      for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
        const toolMsg = transformedMessages[j];
        const textResult = toolMsg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
        const hasImages = toolMsg.content.some((c) => c.type === "image");
        const hasText = textResult.length > 0;
        const toolResultMsg = {
          role: "tool",
          content: sanitizeSurrogates(hasText ? textResult : "(see attached image)"),
          tool_call_id: toolMsg.toolCallId
        };
        if (compat.requiresToolResultName && toolMsg.toolName) {
          toolResultMsg.name = toolMsg.toolName;
        }
        params.push(toolResultMsg);
        if (hasImages && model.input.includes("image")) {
          for (const block of toolMsg.content) {
            if (block.type === "image") {
              imageBlocks.push({
                type: "image_url",
                image_url: {
                  url: `data:${block.mimeType};base64,${block.data}`
                }
              });
            }
          }
        }
      }
      i = j - 1;
      if (imageBlocks.length > 0) {
        if (compat.requiresAssistantAfterToolResult) {
          params.push({
            role: "assistant",
            content: "I have processed the tool results."
          });
        }
        params.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "Attached image(s) from tool result:"
            },
            ...imageBlocks
          ]
        });
        lastRole = "user";
      } else {
        lastRole = "toolResult";
      }
      continue;
    }
    lastRole = msg.role;
  }
  return params;
}
function convertTools(tools, compat) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // TypeBox already generates JSON Schema
      // Only include strict if provider supports it. Some reject unknown fields.
      ...compat.supportsStrictMode !== false && { strict: false }
    }
  }));
}
function mapStopReason(reason) {
  if (reason === null) return "stop";
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "function_call":
    case "tool_calls":
      return "toolUse";
    case "content_filter":
      return "error";
    default:
      return "stop";
  }
}
function detectCompat(model) {
  const provider = model.provider;
  const baseUrl = model.baseUrl;
  const isZai = provider === "zai" || baseUrl.includes("api.z.ai");
  const isNonStandard = provider === "cerebras" || baseUrl.includes("cerebras.ai") || provider === "xai" || baseUrl.includes("api.x.ai") || baseUrl.includes("chutes.ai") || baseUrl.includes("deepseek.com") || isZai || provider === "opencode" || baseUrl.includes("opencode.ai");
  const useMaxTokens = baseUrl.includes("chutes.ai");
  const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
  const isGroq = provider === "groq" || baseUrl.includes("groq.com");
  const reasoningEffortMap = isGroq && model.id === "qwen/qwen3-32b" ? {
    minimal: "default",
    low: "default",
    medium: "default",
    high: "default",
    xhigh: "default"
  } : {};
  return {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: !isNonStandard,
    supportsReasoningEffort: !isGrok && !isZai,
    reasoningEffortMap,
    supportsUsageInStreaming: true,
    maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    thinkingFormat: isZai ? "zai" : "openai",
    openRouterRouting: {},
    vercelGatewayRouting: {},
    supportsStrictMode: true
  };
}
function getCompat(model) {
  const detected = detectCompat(model);
  if (!model.compat) return detected;
  return {
    supportsStore: model.compat.supportsStore ?? detected.supportsStore,
    supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
    reasoningEffortMap: model.compat.reasoningEffortMap ?? detected.reasoningEffortMap,
    supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
    maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
    requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult: model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
    thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
    openRouterRouting: model.compat.openRouterRouting ?? {},
    vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
    supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode
  };
}
export {
  convertMessages,
  streamOpenAICompletions,
  streamSimpleOpenAICompletions
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy9vcGVuYWktY29tcGxldGlvbnMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIExhenktbG9hZGVkOiBPcGVuQUkgU0RLIGlzIGltcG9ydGVkIG9uIGZpcnN0IHVzZSwgbm90IGF0IHN0YXJ0dXAuXG4vLyBUaGlzIGF2b2lkcyBwZW5hbGl6aW5nIHVzZXJzIHdobyBkb24ndCB1c2UgT3BlbkFJIG1vZGVscy5cbmltcG9ydCB0eXBlIE9wZW5BSSBmcm9tIFwib3BlbmFpXCI7XG5pbXBvcnQgdHlwZSB7XG5cdENoYXRDb21wbGV0aW9uQXNzaXN0YW50TWVzc2FnZVBhcmFtLFxuXHRDaGF0Q29tcGxldGlvbkNodW5rLFxuXHRDaGF0Q29tcGxldGlvbkNvbnRlbnRQYXJ0LFxuXHRDaGF0Q29tcGxldGlvbkNvbnRlbnRQYXJ0SW1hZ2UsXG5cdENoYXRDb21wbGV0aW9uQ29udGVudFBhcnRUZXh0LFxuXHRDaGF0Q29tcGxldGlvbk1lc3NhZ2VQYXJhbSxcblx0Q2hhdENvbXBsZXRpb25Ub29sTWVzc2FnZVBhcmFtLFxufSBmcm9tIFwib3BlbmFpL3Jlc291cmNlcy9jaGF0L2NvbXBsZXRpb25zLmpzXCI7XG5pbXBvcnQgeyBnZXRFbnZBcGlLZXkgfSBmcm9tIFwiLi4vZW52LWFwaS1rZXlzLmpzXCI7XG5pbXBvcnQgeyBjYWxjdWxhdGVDb3N0LCBzdXBwb3J0c1hoaWdoIH0gZnJvbSBcIi4uL21vZGVscy5qc1wiO1xuaW1wb3J0IHR5cGUge1xuXHRBc3Npc3RhbnRNZXNzYWdlLFxuXHRDb250ZXh0LFxuXHRNZXNzYWdlLFxuXHRNb2RlbCxcblx0T3BlbkFJQ29tcGxldGlvbnNDb21wYXQsXG5cdFNpbXBsZVN0cmVhbU9wdGlvbnMsXG5cdFN0b3BSZWFzb24sXG5cdFN0cmVhbUZ1bmN0aW9uLFxuXHRTdHJlYW1PcHRpb25zLFxuXHRUZXh0Q29udGVudCxcblx0VGhpbmtpbmdDb250ZW50LFxuXHRUb29sLFxuXHRUb29sQ2FsbCxcblx0VG9vbFJlc3VsdE1lc3NhZ2UsXG59IGZyb20gXCIuLi90eXBlcy5qc1wiO1xuaW1wb3J0IHsgQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtIH0gZnJvbSBcIi4uL3V0aWxzL2V2ZW50LXN0cmVhbS5qc1wiO1xuaW1wb3J0IHsgcGFyc2VTdHJlYW1pbmdKc29uIH0gZnJvbSBcIi4uL3V0aWxzL2pzb24tcGFyc2UuanNcIjtcbmltcG9ydCB7IHNhbml0aXplU3Vycm9nYXRlcyB9IGZyb20gXCIuLi91dGlscy9zYW5pdGl6ZS11bmljb2RlLmpzXCI7XG5pbXBvcnQgeyBidWlsZEJhc2VPcHRpb25zLCBjbGFtcFJlYXNvbmluZyB9IGZyb20gXCIuL3NpbXBsZS1vcHRpb25zLmpzXCI7XG5pbXBvcnQge1xuXHRhc3NlcnRTdHJlYW1TdWNjZXNzLFxuXHRidWlsZEluaXRpYWxPdXRwdXQsXG5cdGNyZWF0ZU9wZW5BSUNsaWVudCxcblx0ZmluYWxpemVTdHJlYW0sXG5cdGhhbmRsZVN0cmVhbUVycm9yLFxufSBmcm9tIFwiLi9vcGVuYWktc2hhcmVkLmpzXCI7XG5pbXBvcnQgeyBUaGlua1RhZ1BhcnNlciB9IGZyb20gXCIuL3RoaW5rLXRhZy1wYXJzZXIuanNcIjtcbmltcG9ydCB7IHRyYW5zZm9ybU1lc3NhZ2VzV2l0aFJlcG9ydCB9IGZyb20gXCIuL3RyYW5zZm9ybS1tZXNzYWdlcy5qc1wiO1xuXG4vKipcbiAqIENoZWNrIGlmIGNvbnZlcnNhdGlvbiBtZXNzYWdlcyBjb250YWluIHRvb2wgY2FsbHMgb3IgdG9vbCByZXN1bHRzLlxuICogVGhpcyBpcyBuZWVkZWQgYmVjYXVzZSBBbnRocm9waWMgKHZpYSBwcm94eSkgcmVxdWlyZXMgdGhlIHRvb2xzIHBhcmFtXG4gKiB0byBiZSBwcmVzZW50IHdoZW4gbWVzc2FnZXMgaW5jbHVkZSB0b29sX2NhbGxzIG9yIHRvb2wgcm9sZSBtZXNzYWdlcy5cbiAqL1xuZnVuY3Rpb24gaGFzVG9vbEhpc3RvcnkobWVzc2FnZXM6IE1lc3NhZ2VbXSk6IGJvb2xlYW4ge1xuXHRmb3IgKGNvbnN0IG1zZyBvZiBtZXNzYWdlcykge1xuXHRcdGlmIChtc2cucm9sZSA9PT0gXCJ0b29sUmVzdWx0XCIpIHtcblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH1cblx0XHRpZiAobXNnLnJvbGUgPT09IFwiYXNzaXN0YW50XCIpIHtcblx0XHRcdGlmIChtc2cuY29udGVudC5zb21lKChibG9jaykgPT4gYmxvY2sudHlwZSA9PT0gXCJ0b29sQ2FsbFwiKSkge1xuXHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblx0cmV0dXJuIGZhbHNlO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIE9wZW5BSUNvbXBsZXRpb25zT3B0aW9ucyBleHRlbmRzIFN0cmVhbU9wdGlvbnMge1xuXHR0b29sQ2hvaWNlPzogXCJhdXRvXCIgfCBcIm5vbmVcIiB8IFwicmVxdWlyZWRcIiB8IHsgdHlwZTogXCJmdW5jdGlvblwiOyBmdW5jdGlvbjogeyBuYW1lOiBzdHJpbmcgfSB9O1xuXHRyZWFzb25pbmdFZmZvcnQ/OiBcIm1pbmltYWxcIiB8IFwibG93XCIgfCBcIm1lZGl1bVwiIHwgXCJoaWdoXCIgfCBcInhoaWdoXCI7XG59XG5cbmV4cG9ydCBjb25zdCBzdHJlYW1PcGVuQUlDb21wbGV0aW9uczogU3RyZWFtRnVuY3Rpb248XCJvcGVuYWktY29tcGxldGlvbnNcIiwgT3BlbkFJQ29tcGxldGlvbnNPcHRpb25zPiA9IChcblx0bW9kZWw6IE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRjb250ZXh0OiBDb250ZXh0LFxuXHRvcHRpb25zPzogT3BlbkFJQ29tcGxldGlvbnNPcHRpb25zLFxuKTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtID0+IHtcblx0Y29uc3Qgc3RyZWFtID0gbmV3IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSgpO1xuXG5cdChhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgb3V0cHV0ID0gYnVpbGRJbml0aWFsT3V0cHV0KG1vZGVsKTtcblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBhcGlLZXkgPSBvcHRpb25zPy5hcGlLZXkgfHwgZ2V0RW52QXBpS2V5KG1vZGVsLnByb3ZpZGVyKSB8fCBcIlwiO1xuXHRcdFx0Y29uc3QgaXNaYWkgPSBtb2RlbC5wcm92aWRlciA9PT0gXCJ6YWlcIiB8fCBtb2RlbC5iYXNlVXJsLmluY2x1ZGVzKFwiYXBpLnouYWlcIik7XG5cdFx0XHRjb25zdCBjbGllbnQgPSBhd2FpdCBjcmVhdGVPcGVuQUlDbGllbnQobW9kZWwsIGNvbnRleHQsIGFwaUtleSwge1xuXHRcdFx0XHRvcHRpb25zSGVhZGVyczogb3B0aW9ucz8uaGVhZGVycyxcblx0XHRcdFx0ZXh0cmFDbGllbnRPcHRpb25zOiBpc1phaSA/IHsgdGltZW91dDogMTAwXzAwMCwgbWF4UmV0cmllczogNCB9IDogdW5kZWZpbmVkLFxuXHRcdFx0fSk7XG5cdFx0XHRsZXQgcGFyYW1zID0gYnVpbGRQYXJhbXMobW9kZWwsIGNvbnRleHQsIG9wdGlvbnMpO1xuXHRcdFx0Y29uc3QgbmV4dFBhcmFtcyA9IGF3YWl0IG9wdGlvbnM/Lm9uUGF5bG9hZD8uKHBhcmFtcywgbW9kZWwpO1xuXHRcdFx0aWYgKG5leHRQYXJhbXMgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRwYXJhbXMgPSBuZXh0UGFyYW1zIGFzIE9wZW5BSS5DaGF0LkNvbXBsZXRpb25zLkNoYXRDb21wbGV0aW9uQ3JlYXRlUGFyYW1zU3RyZWFtaW5nO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3Qgb3BlbmFpU3RyZWFtID0gYXdhaXQgY2xpZW50LmNoYXQuY29tcGxldGlvbnMuY3JlYXRlKHBhcmFtcywgeyBzaWduYWw6IG9wdGlvbnM/LnNpZ25hbCB9KTtcblx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJzdGFydFwiLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cblx0XHRcdGxldCBjdXJyZW50QmxvY2s6IFRleHRDb250ZW50IHwgVGhpbmtpbmdDb250ZW50IHwgKFRvb2xDYWxsICYgeyBwYXJ0aWFsQXJncz86IHN0cmluZyB9KSB8IG51bGwgPSBudWxsO1xuXHRcdFx0Y29uc3QgdGhpbmtUYWdQYXJzZXIgPSBuZXcgVGhpbmtUYWdQYXJzZXIoKTtcblx0XHRcdGNvbnN0IGJsb2NrcyA9IG91dHB1dC5jb250ZW50O1xuXHRcdFx0Y29uc3QgYmxvY2tJbmRleCA9ICgpID0+IGJsb2Nrcy5sZW5ndGggLSAxO1xuXHRcdFx0Y29uc3QgZmluaXNoQ3VycmVudEJsb2NrID0gKGJsb2NrPzogdHlwZW9mIGN1cnJlbnRCbG9jaykgPT4ge1xuXHRcdFx0XHRpZiAoYmxvY2spIHtcblx0XHRcdFx0XHRpZiAoYmxvY2sudHlwZSA9PT0gXCJ0ZXh0XCIpIHtcblx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0X2VuZFwiLFxuXHRcdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdFx0Y29udGVudDogYmxvY2sudGV4dCxcblx0XHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0fSBlbHNlIGlmIChibG9jay50eXBlID09PSBcInRoaW5raW5nXCIpIHtcblx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0aGlua2luZ19lbmRcIixcblx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IGJsb2NrLnRoaW5raW5nLFxuXHRcdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHR9IGVsc2UgaWYgKGJsb2NrLnR5cGUgPT09IFwidG9vbENhbGxcIikge1xuXHRcdFx0XHRcdFx0YmxvY2suYXJndW1lbnRzID0gcGFyc2VTdHJlYW1pbmdKc29uKGJsb2NrLnBhcnRpYWxBcmdzKTtcblx0XHRcdFx0XHRcdGRlbGV0ZSBibG9jay5wYXJ0aWFsQXJncztcblx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0b29sY2FsbF9lbmRcIixcblx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0XHRcdHRvb2xDYWxsOiBibG9jayxcblx0XHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXHRcdFx0Y29uc3QgYXBwZW5kVGV4dERlbHRhID0gKGRlbHRhOiBzdHJpbmcpID0+IHtcblx0XHRcdFx0aWYgKCFkZWx0YSkgcmV0dXJuO1xuXHRcdFx0XHRpZiAoIWN1cnJlbnRCbG9jayB8fCBjdXJyZW50QmxvY2sudHlwZSAhPT0gXCJ0ZXh0XCIpIHtcblx0XHRcdFx0XHRmaW5pc2hDdXJyZW50QmxvY2soY3VycmVudEJsb2NrKTtcblx0XHRcdFx0XHRjdXJyZW50QmxvY2sgPSB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlwiIH07XG5cdFx0XHRcdFx0b3V0cHV0LmNvbnRlbnQucHVzaChjdXJyZW50QmxvY2spO1xuXHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0ZXh0X3N0YXJ0XCIsIGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoY3VycmVudEJsb2NrLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0Y3VycmVudEJsb2NrLnRleHQgKz0gZGVsdGE7XG5cdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0X2RlbHRhXCIsXG5cdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdGRlbHRhLFxuXHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXHRcdFx0Y29uc3QgYXBwZW5kVGhpbmtpbmdEZWx0YSA9IChkZWx0YTogc3RyaW5nKSA9PiB7XG5cdFx0XHRcdGlmICghZGVsdGEpIHJldHVybjtcblx0XHRcdFx0aWYgKCFjdXJyZW50QmxvY2sgfHwgY3VycmVudEJsb2NrLnR5cGUgIT09IFwidGhpbmtpbmdcIikge1xuXHRcdFx0XHRcdGZpbmlzaEN1cnJlbnRCbG9jayhjdXJyZW50QmxvY2spO1xuXHRcdFx0XHRcdGN1cnJlbnRCbG9jayA9IHtcblx0XHRcdFx0XHRcdHR5cGU6IFwidGhpbmtpbmdcIixcblx0XHRcdFx0XHRcdHRoaW5raW5nOiBcIlwiLFxuXHRcdFx0XHRcdFx0dGhpbmtpbmdTaWduYXR1cmU6IFwidGhpbmstdGFnXCIsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRvdXRwdXQuY29udGVudC5wdXNoKGN1cnJlbnRCbG9jayk7XG5cdFx0XHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInRoaW5raW5nX3N0YXJ0XCIsIGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoY3VycmVudEJsb2NrLnR5cGUgPT09IFwidGhpbmtpbmdcIikge1xuXHRcdFx0XHRcdGN1cnJlbnRCbG9jay50aGlua2luZyArPSBkZWx0YTtcblx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRoaW5raW5nX2RlbHRhXCIsXG5cdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdGRlbHRhLFxuXHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXHRcdFx0Y29uc3QgYXBwZW5kQ29udGVudERlbHRhID0gKGRlbHRhOiBzdHJpbmcpID0+IHtcblx0XHRcdFx0Y29uc3Qgc2VnbWVudHMgPSB0aGlua1RhZ1BhcnNlci5jb25zdW1lKGRlbHRhKTtcblx0XHRcdFx0Zm9yIChjb25zdCBzZWdtZW50IG9mIHNlZ21lbnRzKSB7XG5cdFx0XHRcdFx0aWYgKHNlZ21lbnQudHlwZSA9PT0gXCJ0aGlua2luZ1wiKSBhcHBlbmRUaGlua2luZ0RlbHRhKHNlZ21lbnQudGV4dCk7XG5cdFx0XHRcdFx0ZWxzZSBhcHBlbmRUZXh0RGVsdGEoc2VnbWVudC50ZXh0KTtcblx0XHRcdFx0fVxuXHRcdFx0fTtcblxuXHRcdFx0Zm9yIGF3YWl0IChjb25zdCBjaHVuayBvZiBvcGVuYWlTdHJlYW0pIHtcblx0XHRcdFx0aWYgKGNodW5rLnVzYWdlKSB7XG5cdFx0XHRcdFx0Y29uc3QgY2FjaGVkVG9rZW5zID0gY2h1bmsudXNhZ2UucHJvbXB0X3Rva2Vuc19kZXRhaWxzPy5jYWNoZWRfdG9rZW5zIHx8IDA7XG5cdFx0XHRcdFx0Y29uc3QgcmVhc29uaW5nVG9rZW5zID0gY2h1bmsudXNhZ2UuY29tcGxldGlvbl90b2tlbnNfZGV0YWlscz8ucmVhc29uaW5nX3Rva2VucyB8fCAwO1xuXHRcdFx0XHRcdGNvbnN0IGlucHV0ID0gKGNodW5rLnVzYWdlLnByb21wdF90b2tlbnMgfHwgMCkgLSBjYWNoZWRUb2tlbnM7XG5cdFx0XHRcdFx0Y29uc3Qgb3V0cHV0VG9rZW5zID0gKGNodW5rLnVzYWdlLmNvbXBsZXRpb25fdG9rZW5zIHx8IDApICsgcmVhc29uaW5nVG9rZW5zO1xuXHRcdFx0XHRcdG91dHB1dC51c2FnZSA9IHtcblx0XHRcdFx0XHRcdC8vIE9wZW5BSSBpbmNsdWRlcyBjYWNoZWQgdG9rZW5zIGluIHByb21wdF90b2tlbnMsIHNvIHN1YnRyYWN0IHRvIGdldCBub24tY2FjaGVkIGlucHV0XG5cdFx0XHRcdFx0XHRpbnB1dCxcblx0XHRcdFx0XHRcdG91dHB1dDogb3V0cHV0VG9rZW5zLFxuXHRcdFx0XHRcdFx0Y2FjaGVSZWFkOiBjYWNoZWRUb2tlbnMsXG5cdFx0XHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0XHRcdFx0Ly8gQ29tcHV0ZSB0b3RhbFRva2VucyBvdXJzZWx2ZXMgc2luY2Ugd2UgYWRkIHJlYXNvbmluZ190b2tlbnMgdG8gb3V0cHV0XG5cdFx0XHRcdFx0XHQvLyBhbmQgc29tZSBwcm92aWRlcnMgKGUuZy4sIEdyb3EpIGRvbid0IGluY2x1ZGUgdGhlbSBpbiB0b3RhbF90b2tlbnNcblx0XHRcdFx0XHRcdHRvdGFsVG9rZW5zOiBpbnB1dCArIG91dHB1dFRva2VucyArIGNhY2hlZFRva2Vucyxcblx0XHRcdFx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0XHRcdFx0XHR0b3RhbDogMCxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRjYWxjdWxhdGVDb3N0KG1vZGVsLCBvdXRwdXQudXNhZ2UpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgY2hvaWNlID0gY2h1bmsuY2hvaWNlcz8uWzBdO1xuXHRcdFx0XHRpZiAoIWNob2ljZSkgY29udGludWU7XG5cblx0XHRcdFx0aWYgKGNob2ljZS5maW5pc2hfcmVhc29uKSB7XG5cdFx0XHRcdFx0b3V0cHV0LnN0b3BSZWFzb24gPSBtYXBTdG9wUmVhc29uKGNob2ljZS5maW5pc2hfcmVhc29uKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChjaG9pY2UuZGVsdGEpIHtcblx0XHRcdFx0XHRpZiAoXG5cdFx0XHRcdFx0XHRjaG9pY2UuZGVsdGEuY29udGVudCAhPT0gbnVsbCAmJlxuXHRcdFx0XHRcdFx0Y2hvaWNlLmRlbHRhLmNvbnRlbnQgIT09IHVuZGVmaW5lZCAmJlxuXHRcdFx0XHRcdFx0Y2hvaWNlLmRlbHRhLmNvbnRlbnQubGVuZ3RoID4gMFxuXHRcdFx0XHRcdCkge1xuXHRcdFx0XHRcdFx0YXBwZW5kQ29udGVudERlbHRhKGNob2ljZS5kZWx0YS5jb250ZW50KTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHQvLyBTb21lIGVuZHBvaW50cyByZXR1cm4gcmVhc29uaW5nIGluIHJlYXNvbmluZ19jb250ZW50IChsbGFtYS5jcHApLFxuXHRcdFx0XHRcdC8vIG9yIHJlYXNvbmluZyAob3RoZXIgb3BlbmFpIGNvbXBhdGlibGUgZW5kcG9pbnRzKVxuXHRcdFx0XHRcdC8vIFVzZSB0aGUgZmlyc3Qgbm9uLWVtcHR5IHJlYXNvbmluZyBmaWVsZCB0byBhdm9pZCBkdXBsaWNhdGlvblxuXHRcdFx0XHRcdC8vIChlLmcuLCBjaHV0ZXMuYWkgcmV0dXJucyBib3RoIHJlYXNvbmluZ19jb250ZW50IGFuZCByZWFzb25pbmcgd2l0aCBzYW1lIGNvbnRlbnQpXG5cdFx0XHRcdFx0Y29uc3QgcmVhc29uaW5nRmllbGRzID0gW1wicmVhc29uaW5nX2NvbnRlbnRcIiwgXCJyZWFzb25pbmdcIiwgXCJyZWFzb25pbmdfdGV4dFwiXTtcblx0XHRcdFx0XHRsZXQgZm91bmRSZWFzb25pbmdGaWVsZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cdFx0XHRcdFx0Zm9yIChjb25zdCBmaWVsZCBvZiByZWFzb25pbmdGaWVsZHMpIHtcblx0XHRcdFx0XHRcdGlmIChcblx0XHRcdFx0XHRcdFx0KGNob2ljZS5kZWx0YSBhcyBhbnkpW2ZpZWxkXSAhPT0gbnVsbCAmJlxuXHRcdFx0XHRcdFx0XHQoY2hvaWNlLmRlbHRhIGFzIGFueSlbZmllbGRdICE9PSB1bmRlZmluZWQgJiZcblx0XHRcdFx0XHRcdFx0KGNob2ljZS5kZWx0YSBhcyBhbnkpW2ZpZWxkXS5sZW5ndGggPiAwXG5cdFx0XHRcdFx0XHQpIHtcblx0XHRcdFx0XHRcdFx0aWYgKCFmb3VuZFJlYXNvbmluZ0ZpZWxkKSB7XG5cdFx0XHRcdFx0XHRcdFx0Zm91bmRSZWFzb25pbmdGaWVsZCA9IGZpZWxkO1xuXHRcdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0aWYgKGZvdW5kUmVhc29uaW5nRmllbGQpIHtcblx0XHRcdFx0XHRcdGlmICghY3VycmVudEJsb2NrIHx8IGN1cnJlbnRCbG9jay50eXBlICE9PSBcInRoaW5raW5nXCIpIHtcblx0XHRcdFx0XHRcdFx0ZmluaXNoQ3VycmVudEJsb2NrKGN1cnJlbnRCbG9jayk7XG5cdFx0XHRcdFx0XHRcdGN1cnJlbnRCbG9jayA9IHtcblx0XHRcdFx0XHRcdFx0XHR0eXBlOiBcInRoaW5raW5nXCIsXG5cdFx0XHRcdFx0XHRcdFx0dGhpbmtpbmc6IFwiXCIsXG5cdFx0XHRcdFx0XHRcdFx0dGhpbmtpbmdTaWduYXR1cmU6IGZvdW5kUmVhc29uaW5nRmllbGQsXG5cdFx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHRcdG91dHB1dC5jb250ZW50LnB1c2goY3VycmVudEJsb2NrKTtcblx0XHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInRoaW5raW5nX3N0YXJ0XCIsIGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGlmIChjdXJyZW50QmxvY2sudHlwZSA9PT0gXCJ0aGlua2luZ1wiKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGRlbHRhID0gKGNob2ljZS5kZWx0YSBhcyBhbnkpW2ZvdW5kUmVhc29uaW5nRmllbGRdO1xuXHRcdFx0XHRcdFx0XHRjdXJyZW50QmxvY2sudGhpbmtpbmcgKz0gZGVsdGE7XG5cdFx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdFx0XHR0eXBlOiBcInRoaW5raW5nX2RlbHRhXCIsXG5cdFx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0XHRcdFx0ZGVsdGEsXG5cdFx0XHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRpZiAoY2hvaWNlPy5kZWx0YT8udG9vbF9jYWxscykge1xuXHRcdFx0XHRcdFx0Zm9yIChjb25zdCB0b29sQ2FsbCBvZiBjaG9pY2UuZGVsdGEudG9vbF9jYWxscykge1xuXHRcdFx0XHRcdFx0XHRpZiAoXG5cdFx0XHRcdFx0XHRcdFx0IWN1cnJlbnRCbG9jayB8fFxuXHRcdFx0XHRcdFx0XHRcdGN1cnJlbnRCbG9jay50eXBlICE9PSBcInRvb2xDYWxsXCIgfHxcblx0XHRcdFx0XHRcdFx0XHQodG9vbENhbGwuaWQgJiYgY3VycmVudEJsb2NrLmlkICE9PSB0b29sQ2FsbC5pZClcblx0XHRcdFx0XHRcdFx0KSB7XG5cdFx0XHRcdFx0XHRcdFx0ZmluaXNoQ3VycmVudEJsb2NrKGN1cnJlbnRCbG9jayk7XG5cdFx0XHRcdFx0XHRcdFx0Y3VycmVudEJsb2NrID0ge1xuXHRcdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0b29sQ2FsbFwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0aWQ6IHRvb2xDYWxsLmlkIHx8IFwiXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRuYW1lOiB0b29sQ2FsbC5mdW5jdGlvbj8ubmFtZSB8fCBcIlwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0YXJndW1lbnRzOiB7fSxcblx0XHRcdFx0XHRcdFx0XHRcdHBhcnRpYWxBcmdzOiBcIlwiLFxuXHRcdFx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHRcdFx0b3V0cHV0LmNvbnRlbnQucHVzaChjdXJyZW50QmxvY2spO1xuXHRcdFx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0b29sY2FsbF9zdGFydFwiLCBjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSwgcGFydGlhbDogb3V0cHV0IH0pO1xuXHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0aWYgKGN1cnJlbnRCbG9jay50eXBlID09PSBcInRvb2xDYWxsXCIpIHtcblx0XHRcdFx0XHRcdFx0XHRpZiAodG9vbENhbGwuaWQpIGN1cnJlbnRCbG9jay5pZCA9IHRvb2xDYWxsLmlkO1xuXHRcdFx0XHRcdFx0XHRcdGlmICh0b29sQ2FsbC5mdW5jdGlvbj8ubmFtZSkgY3VycmVudEJsb2NrLm5hbWUgPSB0b29sQ2FsbC5mdW5jdGlvbi5uYW1lO1xuXHRcdFx0XHRcdFx0XHRcdGxldCBkZWx0YSA9IFwiXCI7XG5cdFx0XHRcdFx0XHRcdFx0aWYgKHRvb2xDYWxsLmZ1bmN0aW9uPy5hcmd1bWVudHMpIHtcblx0XHRcdFx0XHRcdFx0XHRcdGRlbHRhID0gdG9vbENhbGwuZnVuY3Rpb24uYXJndW1lbnRzO1xuXHRcdFx0XHRcdFx0XHRcdFx0Y3VycmVudEJsb2NrLnBhcnRpYWxBcmdzICs9IHRvb2xDYWxsLmZ1bmN0aW9uLmFyZ3VtZW50cztcblx0XHRcdFx0XHRcdFx0XHRcdGN1cnJlbnRCbG9jay5hcmd1bWVudHMgPSBwYXJzZVN0cmVhbWluZ0pzb24oY3VycmVudEJsb2NrLnBhcnRpYWxBcmdzKTtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0b29sY2FsbF9kZWx0YVwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0XHRcdFx0XHRkZWx0YSxcblx0XHRcdFx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNvbnN0IHJlYXNvbmluZ0RldGFpbHMgPSAoY2hvaWNlLmRlbHRhIGFzIGFueSkucmVhc29uaW5nX2RldGFpbHM7XG5cdFx0XHRcdFx0aWYgKHJlYXNvbmluZ0RldGFpbHMgJiYgQXJyYXkuaXNBcnJheShyZWFzb25pbmdEZXRhaWxzKSkge1xuXHRcdFx0XHRcdFx0Zm9yIChjb25zdCBkZXRhaWwgb2YgcmVhc29uaW5nRGV0YWlscykge1xuXHRcdFx0XHRcdFx0XHRpZiAoZGV0YWlsLnR5cGUgPT09IFwicmVhc29uaW5nLmVuY3J5cHRlZFwiICYmIGRldGFpbC5pZCAmJiBkZXRhaWwuZGF0YSkge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IG1hdGNoaW5nVG9vbENhbGwgPSBvdXRwdXQuY29udGVudC5maW5kKFxuXHRcdFx0XHRcdFx0XHRcdFx0KGIpID0+IGIudHlwZSA9PT0gXCJ0b29sQ2FsbFwiICYmIGIuaWQgPT09IGRldGFpbC5pZCxcblx0XHRcdFx0XHRcdFx0XHQpIGFzIFRvb2xDYWxsIHwgdW5kZWZpbmVkO1xuXHRcdFx0XHRcdFx0XHRcdGlmIChtYXRjaGluZ1Rvb2xDYWxsKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRtYXRjaGluZ1Rvb2xDYWxsLnRob3VnaHRTaWduYXR1cmUgPSBKU09OLnN0cmluZ2lmeShkZXRhaWwpO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRmb3IgKGNvbnN0IHNlZ21lbnQgb2YgdGhpbmtUYWdQYXJzZXIuZmx1c2goKSkge1xuXHRcdFx0XHRpZiAoc2VnbWVudC50eXBlID09PSBcInRoaW5raW5nXCIpIGFwcGVuZFRoaW5raW5nRGVsdGEoc2VnbWVudC50ZXh0KTtcblx0XHRcdFx0ZWxzZSBhcHBlbmRUZXh0RGVsdGEoc2VnbWVudC50ZXh0KTtcblx0XHRcdH1cblxuXHRcdFx0ZmluaXNoQ3VycmVudEJsb2NrKGN1cnJlbnRCbG9jayk7XG5cdFx0XHRhc3NlcnRTdHJlYW1TdWNjZXNzKG91dHB1dCwgb3B0aW9ucz8uc2lnbmFsKTtcblx0XHRcdGZpbmFsaXplU3RyZWFtKHN0cmVhbSwgb3V0cHV0KTtcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0Ly8gU29tZSBwcm92aWRlcnMgdmlhIE9wZW5Sb3V0ZXIgZ2l2ZSBhZGRpdGlvbmFsIGluZm9ybWF0aW9uIGluIHRoaXMgZmllbGQuXG5cdFx0XHRjb25zdCByYXdNZXRhZGF0YSA9IChlcnJvciBhcyBhbnkpPy5lcnJvcj8ubWV0YWRhdGE/LnJhdztcblx0XHRcdGhhbmRsZVN0cmVhbUVycm9yKHN0cmVhbSwgb3V0cHV0LCBlcnJvciwgb3B0aW9ucz8uc2lnbmFsLCByYXdNZXRhZGF0YSk7XG5cdFx0fVxuXHR9KSgpO1xuXG5cdHJldHVybiBzdHJlYW07XG59O1xuXG5leHBvcnQgY29uc3Qgc3RyZWFtU2ltcGxlT3BlbkFJQ29tcGxldGlvbnM6IFN0cmVhbUZ1bmN0aW9uPFwib3BlbmFpLWNvbXBsZXRpb25zXCIsIFNpbXBsZVN0cmVhbU9wdGlvbnM+ID0gKFxuXHRtb2RlbDogTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdGNvbnRleHQ6IENvbnRleHQsXG5cdG9wdGlvbnM/OiBTaW1wbGVTdHJlYW1PcHRpb25zLFxuKTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtID0+IHtcblx0Y29uc3QgYXBpS2V5ID0gb3B0aW9ucz8uYXBpS2V5IHx8IGdldEVudkFwaUtleShtb2RlbC5wcm92aWRlcik7XG5cdGlmICghYXBpS2V5KSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKGBObyBBUEkga2V5IGZvciBwcm92aWRlcjogJHttb2RlbC5wcm92aWRlcn1gKTtcblx0fVxuXG5cdGNvbnN0IGJhc2UgPSBidWlsZEJhc2VPcHRpb25zKG1vZGVsLCBvcHRpb25zLCBhcGlLZXkpO1xuXHRjb25zdCByZWFzb25pbmdFZmZvcnQgPSBzdXBwb3J0c1hoaWdoKG1vZGVsKSA/IG9wdGlvbnM/LnJlYXNvbmluZyA6IGNsYW1wUmVhc29uaW5nKG9wdGlvbnM/LnJlYXNvbmluZyk7XG5cdGNvbnN0IHRvb2xDaG9pY2UgPSAob3B0aW9ucyBhcyBPcGVuQUlDb21wbGV0aW9uc09wdGlvbnMgfCB1bmRlZmluZWQpPy50b29sQ2hvaWNlO1xuXG5cdHJldHVybiBzdHJlYW1PcGVuQUlDb21wbGV0aW9ucyhtb2RlbCwgY29udGV4dCwge1xuXHRcdC4uLmJhc2UsXG5cdFx0cmVhc29uaW5nRWZmb3J0LFxuXHRcdHRvb2xDaG9pY2UsXG5cdH0gc2F0aXNmaWVzIE9wZW5BSUNvbXBsZXRpb25zT3B0aW9ucyk7XG59O1xuXG5mdW5jdGlvbiBidWlsZFBhcmFtcyhtb2RlbDogTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sIGNvbnRleHQ6IENvbnRleHQsIG9wdGlvbnM/OiBPcGVuQUlDb21wbGV0aW9uc09wdGlvbnMpIHtcblx0Y29uc3QgY29tcGF0ID0gZ2V0Q29tcGF0KG1vZGVsKTtcblx0Y29uc3QgbWVzc2FnZXMgPSBjb252ZXJ0TWVzc2FnZXMobW9kZWwsIGNvbnRleHQsIGNvbXBhdCk7XG5cdG1heWJlQWRkT3BlblJvdXRlckFudGhyb3BpY0NhY2hlQ29udHJvbChtb2RlbCwgbWVzc2FnZXMpO1xuXG5cdGNvbnN0IHBhcmFtczogT3BlbkFJLkNoYXQuQ29tcGxldGlvbnMuQ2hhdENvbXBsZXRpb25DcmVhdGVQYXJhbXNTdHJlYW1pbmcgPSB7XG5cdFx0bW9kZWw6IG1vZGVsLmlkLFxuXHRcdG1lc3NhZ2VzLFxuXHRcdHN0cmVhbTogdHJ1ZSxcblx0fTtcblxuXHRpZiAoY29tcGF0LnN1cHBvcnRzVXNhZ2VJblN0cmVhbWluZyAhPT0gZmFsc2UpIHtcblx0XHQocGFyYW1zIGFzIGFueSkuc3RyZWFtX29wdGlvbnMgPSB7IGluY2x1ZGVfdXNhZ2U6IHRydWUgfTtcblx0fVxuXG5cdGlmIChjb21wYXQuc3VwcG9ydHNTdG9yZSkge1xuXHRcdHBhcmFtcy5zdG9yZSA9IGZhbHNlO1xuXHR9XG5cblx0aWYgKG9wdGlvbnM/Lm1heFRva2Vucykge1xuXHRcdGlmIChjb21wYXQubWF4VG9rZW5zRmllbGQgPT09IFwibWF4X3Rva2Vuc1wiKSB7XG5cdFx0XHQocGFyYW1zIGFzIGFueSkubWF4X3Rva2VucyA9IG9wdGlvbnMubWF4VG9rZW5zO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRwYXJhbXMubWF4X2NvbXBsZXRpb25fdG9rZW5zID0gb3B0aW9ucy5tYXhUb2tlbnM7XG5cdFx0fVxuXHR9XG5cblx0aWYgKG9wdGlvbnM/LnRlbXBlcmF0dXJlICE9PSB1bmRlZmluZWQpIHtcblx0XHRwYXJhbXMudGVtcGVyYXR1cmUgPSBvcHRpb25zLnRlbXBlcmF0dXJlO1xuXHR9XG5cblx0aWYgKGNvbnRleHQudG9vbHMpIHtcblx0XHRwYXJhbXMudG9vbHMgPSBjb252ZXJ0VG9vbHMoY29udGV4dC50b29scywgY29tcGF0KTtcblx0XHRtYXliZUFkZE9wZW5Sb3V0ZXJBbnRocm9waWNUb29sQ2FjaGVDb250cm9sKG1vZGVsLCBwYXJhbXMudG9vbHMpO1xuXHR9IGVsc2UgaWYgKGhhc1Rvb2xIaXN0b3J5KGNvbnRleHQubWVzc2FnZXMpKSB7XG5cdFx0Ly8gQW50aHJvcGljICh2aWEgTGl0ZUxMTS9wcm94eSkgcmVxdWlyZXMgdG9vbHMgcGFyYW0gd2hlbiBjb252ZXJzYXRpb24gaGFzIHRvb2xfY2FsbHMvdG9vbF9yZXN1bHRzXG5cdFx0cGFyYW1zLnRvb2xzID0gW107XG5cdH1cblxuXHRpZiAob3B0aW9ucz8udG9vbENob2ljZSkge1xuXHRcdHBhcmFtcy50b29sX2Nob2ljZSA9IG9wdGlvbnMudG9vbENob2ljZTtcblx0fVxuXG5cdGlmICgoY29tcGF0LnRoaW5raW5nRm9ybWF0ID09PSBcInphaVwiIHx8IGNvbXBhdC50aGlua2luZ0Zvcm1hdCA9PT0gXCJxd2VuXCIpICYmIG1vZGVsLnJlYXNvbmluZykge1xuXHRcdC8vIEJvdGggWi5haSBhbmQgUXdlbiB1c2UgZW5hYmxlX3RoaW5raW5nOiBib29sZWFuXG5cdFx0KHBhcmFtcyBhcyBhbnkpLmVuYWJsZV90aGlua2luZyA9ICEhb3B0aW9ucz8ucmVhc29uaW5nRWZmb3J0O1xuXHR9IGVsc2UgaWYgKG9wdGlvbnM/LnJlYXNvbmluZ0VmZm9ydCAmJiBtb2RlbC5yZWFzb25pbmcgJiYgY29tcGF0LnN1cHBvcnRzUmVhc29uaW5nRWZmb3J0KSB7XG5cdFx0Ly8gT3BlbkFJLXN0eWxlIHJlYXNvbmluZ19lZmZvcnRcblx0XHQocGFyYW1zIGFzIGFueSkucmVhc29uaW5nX2VmZm9ydCA9IG1hcFJlYXNvbmluZ0VmZm9ydChvcHRpb25zLnJlYXNvbmluZ0VmZm9ydCwgY29tcGF0LnJlYXNvbmluZ0VmZm9ydE1hcCk7XG5cdH1cblxuXHQvLyBPcGVuUm91dGVyIHByb3ZpZGVyIHJvdXRpbmcgcHJlZmVyZW5jZXNcblx0aWYgKG1vZGVsLmJhc2VVcmwuaW5jbHVkZXMoXCJvcGVucm91dGVyLmFpXCIpICYmIG1vZGVsLmNvbXBhdD8ub3BlblJvdXRlclJvdXRpbmcpIHtcblx0XHQocGFyYW1zIGFzIGFueSkucHJvdmlkZXIgPSBtb2RlbC5jb21wYXQub3BlblJvdXRlclJvdXRpbmc7XG5cdH1cblxuXHQvLyBWZXJjZWwgQUkgR2F0ZXdheSBwcm92aWRlciByb3V0aW5nIHByZWZlcmVuY2VzXG5cdGlmIChtb2RlbC5iYXNlVXJsLmluY2x1ZGVzKFwiYWktZ2F0ZXdheS52ZXJjZWwuc2hcIikgJiYgbW9kZWwuY29tcGF0Py52ZXJjZWxHYXRld2F5Um91dGluZykge1xuXHRcdGNvbnN0IHJvdXRpbmcgPSBtb2RlbC5jb21wYXQudmVyY2VsR2F0ZXdheVJvdXRpbmc7XG5cdFx0aWYgKHJvdXRpbmcub25seSB8fCByb3V0aW5nLm9yZGVyKSB7XG5cdFx0XHRjb25zdCBnYXRld2F5T3B0aW9uczogUmVjb3JkPHN0cmluZywgc3RyaW5nW10+ID0ge307XG5cdFx0XHRpZiAocm91dGluZy5vbmx5KSBnYXRld2F5T3B0aW9ucy5vbmx5ID0gcm91dGluZy5vbmx5O1xuXHRcdFx0aWYgKHJvdXRpbmcub3JkZXIpIGdhdGV3YXlPcHRpb25zLm9yZGVyID0gcm91dGluZy5vcmRlcjtcblx0XHRcdChwYXJhbXMgYXMgYW55KS5wcm92aWRlck9wdGlvbnMgPSB7IGdhdGV3YXk6IGdhdGV3YXlPcHRpb25zIH07XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIHBhcmFtcztcbn1cblxuZnVuY3Rpb24gbWF5YmVBZGRPcGVuUm91dGVyQW50aHJvcGljVG9vbENhY2hlQ29udHJvbChcblx0bW9kZWw6IE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHR0b29sczogT3BlbkFJLkNoYXQuQ29tcGxldGlvbnMuQ2hhdENvbXBsZXRpb25Ub29sW10gfCB1bmRlZmluZWQsXG4pOiB2b2lkIHtcblx0aWYgKG1vZGVsLnByb3ZpZGVyICE9PSBcIm9wZW5yb3V0ZXJcIiB8fCAhbW9kZWwuaWQuc3RhcnRzV2l0aChcImFudGhyb3BpYy9cIikpIHJldHVybjtcblx0aWYgKCF0b29scz8ubGVuZ3RoKSByZXR1cm47XG5cblx0Y29uc3QgbGFzdFRvb2wgPSB0b29sc1t0b29scy5sZW5ndGggLSAxXTtcblx0aWYgKFwiZnVuY3Rpb25cIiBpbiBsYXN0VG9vbCkge1xuXHRcdE9iamVjdC5hc3NpZ24obGFzdFRvb2wuZnVuY3Rpb24sIHsgY2FjaGVfY29udHJvbDogeyB0eXBlOiBcImVwaGVtZXJhbFwiIH0gfSk7XG5cdH1cbn1cblxuZnVuY3Rpb24gbWFwUmVhc29uaW5nRWZmb3J0KFxuXHRlZmZvcnQ6IE5vbk51bGxhYmxlPE9wZW5BSUNvbXBsZXRpb25zT3B0aW9uc1tcInJlYXNvbmluZ0VmZm9ydFwiXT4sXG5cdHJlYXNvbmluZ0VmZm9ydE1hcDogUGFydGlhbDxSZWNvcmQ8Tm9uTnVsbGFibGU8T3BlbkFJQ29tcGxldGlvbnNPcHRpb25zW1wicmVhc29uaW5nRWZmb3J0XCJdPiwgc3RyaW5nPj4sXG4pOiBzdHJpbmcge1xuXHRyZXR1cm4gcmVhc29uaW5nRWZmb3J0TWFwW2VmZm9ydF0gPz8gZWZmb3J0O1xufVxuXG5mdW5jdGlvbiBtYXliZUFkZE9wZW5Sb3V0ZXJBbnRocm9waWNDYWNoZUNvbnRyb2woXG5cdG1vZGVsOiBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0bWVzc2FnZXM6IENoYXRDb21wbGV0aW9uTWVzc2FnZVBhcmFtW10sXG4pOiB2b2lkIHtcblx0aWYgKG1vZGVsLnByb3ZpZGVyICE9PSBcIm9wZW5yb3V0ZXJcIiB8fCAhbW9kZWwuaWQuc3RhcnRzV2l0aChcImFudGhyb3BpYy9cIikpIHJldHVybjtcblxuXHQvLyBBbnRocm9waWMtc3R5bGUgY2FjaGluZyByZXF1aXJlcyBjYWNoZV9jb250cm9sIG9uIGEgdGV4dCBwYXJ0LiBBZGQgYSBicmVha3BvaW50XG5cdC8vIG9uIHRoZSBsYXN0IHVzZXIvYXNzaXN0YW50IG1lc3NhZ2UgKHdhbGtpbmcgYmFja3dhcmRzIHVudGlsIHdlIGZpbmQgdGV4dCBjb250ZW50KS5cblx0Zm9yIChsZXQgaSA9IG1lc3NhZ2VzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG5cdFx0Y29uc3QgbXNnID0gbWVzc2FnZXNbaV07XG5cdFx0aWYgKG1zZy5yb2xlICE9PSBcInVzZXJcIiAmJiBtc2cucm9sZSAhPT0gXCJhc3Npc3RhbnRcIikgY29udGludWU7XG5cblx0XHRjb25zdCBjb250ZW50ID0gbXNnLmNvbnRlbnQ7XG5cdFx0aWYgKHR5cGVvZiBjb250ZW50ID09PSBcInN0cmluZ1wiKSB7XG5cdFx0XHRtc2cuY29udGVudCA9IFtcblx0XHRcdFx0T2JqZWN0LmFzc2lnbih7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBjb250ZW50IH0sIHsgY2FjaGVfY29udHJvbDogeyB0eXBlOiBcImVwaGVtZXJhbFwiIH0gfSksXG5cdFx0XHRdO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmICghQXJyYXkuaXNBcnJheShjb250ZW50KSkgY29udGludWU7XG5cblx0XHQvLyBGaW5kIGxhc3QgdGV4dCBwYXJ0IGFuZCBhZGQgY2FjaGVfY29udHJvbFxuXHRcdGZvciAobGV0IGogPSBjb250ZW50Lmxlbmd0aCAtIDE7IGogPj0gMDsgai0tKSB7XG5cdFx0XHRjb25zdCBwYXJ0ID0gY29udGVudFtqXTtcblx0XHRcdGlmIChwYXJ0Py50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHRPYmplY3QuYXNzaWduKHBhcnQsIHsgY2FjaGVfY29udHJvbDogeyB0eXBlOiBcImVwaGVtZXJhbFwiIH0gfSk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHR9XG5cdH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNvbnZlcnRNZXNzYWdlcyhcblx0bW9kZWw6IE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRjb250ZXh0OiBDb250ZXh0LFxuXHRjb21wYXQ6IFJlcXVpcmVkPE9wZW5BSUNvbXBsZXRpb25zQ29tcGF0Pixcbik6IENoYXRDb21wbGV0aW9uTWVzc2FnZVBhcmFtW10ge1xuXHRjb25zdCBwYXJhbXM6IENoYXRDb21wbGV0aW9uTWVzc2FnZVBhcmFtW10gPSBbXTtcblxuXHRjb25zdCBub3JtYWxpemVUb29sQ2FsbElkID0gKGlkOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuXHRcdC8vIEhhbmRsZSBwaXBlLXNlcGFyYXRlZCBJRHMgZnJvbSBPcGVuQUkgUmVzcG9uc2VzIEFQSVxuXHRcdC8vIEZvcm1hdDoge2NhbGxfaWR9fHtpZH0gd2hlcmUge2lkfSBjYW4gYmUgNDAwKyBjaGFycyB3aXRoIHNwZWNpYWwgY2hhcnMgKCssIC8sID0pXG5cdFx0Ly8gVGhlc2UgY29tZSBmcm9tIHByb3ZpZGVycyBsaWtlIGdpdGh1Yi1jb3BpbG90LCBvcGVuYWktY29kZXgsIG9wZW5jb2RlXG5cdFx0Ly8gRXh0cmFjdCBqdXN0IHRoZSBjYWxsX2lkIHBhcnQgYW5kIG5vcm1hbGl6ZSBpdFxuXHRcdGlmIChpZC5pbmNsdWRlcyhcInxcIikpIHtcblx0XHRcdGNvbnN0IFtjYWxsSWRdID0gaWQuc3BsaXQoXCJ8XCIpO1xuXHRcdFx0Ly8gU2FuaXRpemUgdG8gYWxsb3dlZCBjaGFycyBhbmQgdHJ1bmNhdGUgdG8gNDAgY2hhcnMgKE9wZW5BSSBsaW1pdClcblx0XHRcdHJldHVybiBjYWxsSWQucmVwbGFjZSgvW15hLXpBLVowLTlfLV0vZywgXCJfXCIpLnNsaWNlKDAsIDQwKTtcblx0XHR9XG5cblx0XHRpZiAobW9kZWwucHJvdmlkZXIgPT09IFwib3BlbmFpXCIpIHJldHVybiBpZC5sZW5ndGggPiA0MCA/IGlkLnNsaWNlKDAsIDQwKSA6IGlkO1xuXHRcdHJldHVybiBpZDtcblx0fTtcblxuXHRjb25zdCB0cmFuc2Zvcm1lZE1lc3NhZ2VzID0gdHJhbnNmb3JtTWVzc2FnZXNXaXRoUmVwb3J0KGNvbnRleHQubWVzc2FnZXMsIG1vZGVsLCAoaWQpID0+IG5vcm1hbGl6ZVRvb2xDYWxsSWQoaWQpLCBcIm9wZW5haS1jb21wbGV0aW9uc1wiKTtcblxuXHRpZiAoY29udGV4dC5zeXN0ZW1Qcm9tcHQpIHtcblx0XHRjb25zdCB1c2VEZXZlbG9wZXJSb2xlID0gbW9kZWwucmVhc29uaW5nICYmIGNvbXBhdC5zdXBwb3J0c0RldmVsb3BlclJvbGU7XG5cdFx0Y29uc3Qgcm9sZSA9IHVzZURldmVsb3BlclJvbGUgPyBcImRldmVsb3BlclwiIDogXCJzeXN0ZW1cIjtcblx0XHRwYXJhbXMucHVzaCh7IHJvbGU6IHJvbGUsIGNvbnRlbnQ6IHNhbml0aXplU3Vycm9nYXRlcyhjb250ZXh0LnN5c3RlbVByb21wdCkgfSk7XG5cdH1cblxuXHRsZXQgbGFzdFJvbGU6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5cdGZvciAobGV0IGkgPSAwOyBpIDwgdHJhbnNmb3JtZWRNZXNzYWdlcy5sZW5ndGg7IGkrKykge1xuXHRcdGNvbnN0IG1zZyA9IHRyYW5zZm9ybWVkTWVzc2FnZXNbaV07XG5cdFx0Ly8gU29tZSBwcm92aWRlcnMgZG9uJ3QgYWxsb3cgdXNlciBtZXNzYWdlcyBkaXJlY3RseSBhZnRlciB0b29sIHJlc3VsdHNcblx0XHQvLyBJbnNlcnQgYSBzeW50aGV0aWMgYXNzaXN0YW50IG1lc3NhZ2UgdG8gYnJpZGdlIHRoZSBnYXBcblx0XHRpZiAoY29tcGF0LnJlcXVpcmVzQXNzaXN0YW50QWZ0ZXJUb29sUmVzdWx0ICYmIGxhc3RSb2xlID09PSBcInRvb2xSZXN1bHRcIiAmJiBtc2cucm9sZSA9PT0gXCJ1c2VyXCIpIHtcblx0XHRcdHBhcmFtcy5wdXNoKHtcblx0XHRcdFx0cm9sZTogXCJhc3Npc3RhbnRcIixcblx0XHRcdFx0Y29udGVudDogXCJJIGhhdmUgcHJvY2Vzc2VkIHRoZSB0b29sIHJlc3VsdHMuXCIsXG5cdFx0XHR9KTtcblx0XHR9XG5cblx0XHRpZiAobXNnLnJvbGUgPT09IFwidXNlclwiKSB7XG5cdFx0XHRpZiAodHlwZW9mIG1zZy5jb250ZW50ID09PSBcInN0cmluZ1wiKSB7XG5cdFx0XHRcdHBhcmFtcy5wdXNoKHtcblx0XHRcdFx0XHRyb2xlOiBcInVzZXJcIixcblx0XHRcdFx0XHRjb250ZW50OiBzYW5pdGl6ZVN1cnJvZ2F0ZXMobXNnLmNvbnRlbnQpLFxuXHRcdFx0XHR9KTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQ6IENoYXRDb21wbGV0aW9uQ29udGVudFBhcnRbXSA9IG1zZy5jb250ZW50Lm1hcCgoaXRlbSk6IENoYXRDb21wbGV0aW9uQ29udGVudFBhcnQgPT4ge1xuXHRcdFx0XHRcdGlmIChpdGVtLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdFx0dGV4dDogc2FuaXRpemVTdXJyb2dhdGVzKGl0ZW0udGV4dCksXG5cdFx0XHRcdFx0XHR9IHNhdGlzZmllcyBDaGF0Q29tcGxldGlvbkNvbnRlbnRQYXJ0VGV4dDtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJpbWFnZV91cmxcIixcblx0XHRcdFx0XHRcdFx0aW1hZ2VfdXJsOiB7XG5cdFx0XHRcdFx0XHRcdFx0dXJsOiBgZGF0YToke2l0ZW0ubWltZVR5cGV9O2Jhc2U2NCwke2l0ZW0uZGF0YX1gLFxuXHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0fSBzYXRpc2ZpZXMgQ2hhdENvbXBsZXRpb25Db250ZW50UGFydEltYWdlO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSk7XG5cdFx0XHRcdGNvbnN0IGZpbHRlcmVkQ29udGVudCA9ICFtb2RlbC5pbnB1dC5pbmNsdWRlcyhcImltYWdlXCIpXG5cdFx0XHRcdFx0PyBjb250ZW50LmZpbHRlcigoYykgPT4gYy50eXBlICE9PSBcImltYWdlX3VybFwiKVxuXHRcdFx0XHRcdDogY29udGVudDtcblx0XHRcdFx0aWYgKGZpbHRlcmVkQ29udGVudC5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuXHRcdFx0XHRwYXJhbXMucHVzaCh7XG5cdFx0XHRcdFx0cm9sZTogXCJ1c2VyXCIsXG5cdFx0XHRcdFx0Y29udGVudDogZmlsdGVyZWRDb250ZW50LFxuXHRcdFx0XHR9KTtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKG1zZy5yb2xlID09PSBcImFzc2lzdGFudFwiKSB7XG5cdFx0XHQvLyBTb21lIHByb3ZpZGVycyBkb24ndCBhY2NlcHQgbnVsbCBjb250ZW50LCB1c2UgZW1wdHkgc3RyaW5nIGluc3RlYWRcblx0XHRcdGNvbnN0IGFzc2lzdGFudE1zZzogQ2hhdENvbXBsZXRpb25Bc3Npc3RhbnRNZXNzYWdlUGFyYW0gPSB7XG5cdFx0XHRcdHJvbGU6IFwiYXNzaXN0YW50XCIsXG5cdFx0XHRcdGNvbnRlbnQ6IGNvbXBhdC5yZXF1aXJlc0Fzc2lzdGFudEFmdGVyVG9vbFJlc3VsdCA/IFwiXCIgOiBudWxsLFxuXHRcdFx0fTtcblxuXHRcdFx0Y29uc3QgdGV4dEJsb2NrcyA9IG1zZy5jb250ZW50LmZpbHRlcigoYikgPT4gYi50eXBlID09PSBcInRleHRcIikgYXMgVGV4dENvbnRlbnRbXTtcblx0XHRcdC8vIEZpbHRlciBvdXQgZW1wdHkgdGV4dCBibG9ja3MgdG8gYXZvaWQgQVBJIHZhbGlkYXRpb24gZXJyb3JzXG5cdFx0XHRjb25zdCBub25FbXB0eVRleHRCbG9ja3MgPSB0ZXh0QmxvY2tzLmZpbHRlcigoYikgPT4gYi50ZXh0ICYmIGIudGV4dC50cmltKCkubGVuZ3RoID4gMCk7XG5cdFx0XHRpZiAobm9uRW1wdHlUZXh0QmxvY2tzLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0Ly8gR2l0SHViIENvcGlsb3QgcmVxdWlyZXMgYXNzaXN0YW50IGNvbnRlbnQgYXMgYSBzdHJpbmcsIG5vdCBhbiBhcnJheS5cblx0XHRcdFx0Ly8gU2VuZGluZyBhcyBhcnJheSBjYXVzZXMgQ2xhdWRlIG1vZGVscyB0byByZS1hbnN3ZXIgYWxsIHByZXZpb3VzIHByb21wdHMuXG5cdFx0XHRcdGlmIChtb2RlbC5wcm92aWRlciA9PT0gXCJnaXRodWItY29waWxvdFwiKSB7XG5cdFx0XHRcdFx0YXNzaXN0YW50TXNnLmNvbnRlbnQgPSBub25FbXB0eVRleHRCbG9ja3MubWFwKChiKSA9PiBzYW5pdGl6ZVN1cnJvZ2F0ZXMoYi50ZXh0KSkuam9pbihcIlwiKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRhc3Npc3RhbnRNc2cuY29udGVudCA9IG5vbkVtcHR5VGV4dEJsb2Nrcy5tYXAoKGIpID0+IHtcblx0XHRcdFx0XHRcdHJldHVybiB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBzYW5pdGl6ZVN1cnJvZ2F0ZXMoYi50ZXh0KSB9O1xuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIEhhbmRsZSB0aGlua2luZyBibG9ja3Ncblx0XHRcdGNvbnN0IHRoaW5raW5nQmxvY2tzID0gbXNnLmNvbnRlbnQuZmlsdGVyKChiKSA9PiBiLnR5cGUgPT09IFwidGhpbmtpbmdcIikgYXMgVGhpbmtpbmdDb250ZW50W107XG5cdFx0XHQvLyBGaWx0ZXIgb3V0IGVtcHR5IHRoaW5raW5nIGJsb2NrcyB0byBhdm9pZCBBUEkgdmFsaWRhdGlvbiBlcnJvcnNcblx0XHRcdGNvbnN0IG5vbkVtcHR5VGhpbmtpbmdCbG9ja3MgPSB0aGlua2luZ0Jsb2Nrcy5maWx0ZXIoKGIpID0+IGIudGhpbmtpbmcgJiYgYi50aGlua2luZy50cmltKCkubGVuZ3RoID4gMCk7XG5cdFx0XHRpZiAobm9uRW1wdHlUaGlua2luZ0Jsb2Nrcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdGlmIChjb21wYXQucmVxdWlyZXNUaGlua2luZ0FzVGV4dCkge1xuXHRcdFx0XHRcdC8vIENvbnZlcnQgdGhpbmtpbmcgYmxvY2tzIHRvIHBsYWluIHRleHQgKG5vIHRhZ3MgdG8gYXZvaWQgbW9kZWwgbWltaWNraW5nIHRoZW0pXG5cdFx0XHRcdFx0Y29uc3QgdGhpbmtpbmdUZXh0ID0gbm9uRW1wdHlUaGlua2luZ0Jsb2Nrcy5tYXAoKGIpID0+IGIudGhpbmtpbmcpLmpvaW4oXCJcXG5cXG5cIik7XG5cdFx0XHRcdFx0Y29uc3QgdGV4dENvbnRlbnQgPSBhc3Npc3RhbnRNc2cuY29udGVudCBhcyBBcnJheTx7IHR5cGU6IFwidGV4dFwiOyB0ZXh0OiBzdHJpbmcgfT4gfCBudWxsO1xuXHRcdFx0XHRcdGlmICh0ZXh0Q29udGVudCkge1xuXHRcdFx0XHRcdFx0dGV4dENvbnRlbnQudW5zaGlmdCh7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiB0aGlua2luZ1RleHQgfSk7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdGFzc2lzdGFudE1zZy5jb250ZW50ID0gW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IHRoaW5raW5nVGV4dCB9XTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0Ly8gVXNlIHRoZSBzaWduYXR1cmUgZnJvbSB0aGUgZmlyc3QgdGhpbmtpbmcgYmxvY2sgaWYgYXZhaWxhYmxlIChmb3IgbGxhbWEuY3BwIHNlcnZlciArIGdwdC1vc3MpXG5cdFx0XHRcdFx0Y29uc3Qgc2lnbmF0dXJlID0gbm9uRW1wdHlUaGlua2luZ0Jsb2Nrc1swXS50aGlua2luZ1NpZ25hdHVyZTtcblx0XHRcdFx0XHRpZiAoc2lnbmF0dXJlICYmIHNpZ25hdHVyZS5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0XHQoYXNzaXN0YW50TXNnIGFzIGFueSlbc2lnbmF0dXJlXSA9IG5vbkVtcHR5VGhpbmtpbmdCbG9ja3MubWFwKChiKSA9PiBiLnRoaW5raW5nKS5qb2luKFwiXFxuXCIpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCB0b29sQ2FsbHMgPSBtc2cuY29udGVudC5maWx0ZXIoKGIpID0+IGIudHlwZSA9PT0gXCJ0b29sQ2FsbFwiKSBhcyBUb29sQ2FsbFtdO1xuXHRcdFx0aWYgKHRvb2xDYWxscy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdGFzc2lzdGFudE1zZy50b29sX2NhbGxzID0gdG9vbENhbGxzLm1hcCgodGMpID0+ICh7XG5cdFx0XHRcdFx0aWQ6IHRjLmlkLFxuXHRcdFx0XHRcdHR5cGU6IFwiZnVuY3Rpb25cIiBhcyBjb25zdCxcblx0XHRcdFx0XHRmdW5jdGlvbjoge1xuXHRcdFx0XHRcdFx0bmFtZTogdGMubmFtZSxcblx0XHRcdFx0XHRcdGFyZ3VtZW50czogSlNPTi5zdHJpbmdpZnkodGMuYXJndW1lbnRzKSxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9KSk7XG5cdFx0XHRcdGNvbnN0IHJlYXNvbmluZ0RldGFpbHMgPSB0b29sQ2FsbHNcblx0XHRcdFx0XHQuZmlsdGVyKCh0YykgPT4gdGMudGhvdWdodFNpZ25hdHVyZSlcblx0XHRcdFx0XHQubWFwKCh0YykgPT4ge1xuXHRcdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIEpTT04ucGFyc2UodGMudGhvdWdodFNpZ25hdHVyZSEpO1xuXHRcdFx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiBudWxsO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH0pXG5cdFx0XHRcdFx0LmZpbHRlcihCb29sZWFuKTtcblx0XHRcdFx0aWYgKHJlYXNvbmluZ0RldGFpbHMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRcdChhc3Npc3RhbnRNc2cgYXMgYW55KS5yZWFzb25pbmdfZGV0YWlscyA9IHJlYXNvbmluZ0RldGFpbHM7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdC8vIFNraXAgYXNzaXN0YW50IG1lc3NhZ2VzIHRoYXQgaGF2ZSBubyBjb250ZW50IGFuZCBubyB0b29sIGNhbGxzLlxuXHRcdFx0Ly8gU29tZSBwcm92aWRlcnMgcmVxdWlyZSBcImVpdGhlciBjb250ZW50IG9yIHRvb2xfY2FsbHMsIGJ1dCBub3Qgbm9uZVwiLlxuXHRcdFx0Ly8gT3RoZXIgcHJvdmlkZXJzIGFsc28gZG9uJ3QgYWNjZXB0IGVtcHR5IGFzc2lzdGFudCBtZXNzYWdlcy5cblx0XHRcdC8vIFRoaXMgaGFuZGxlcyBhYm9ydGVkIGFzc2lzdGFudCByZXNwb25zZXMgdGhhdCBnb3Qgbm8gY29udGVudC5cblx0XHRcdGNvbnN0IGNvbnRlbnQgPSBhc3Npc3RhbnRNc2cuY29udGVudDtcblx0XHRcdGNvbnN0IGhhc0NvbnRlbnQgPVxuXHRcdFx0XHRjb250ZW50ICE9PSBudWxsICYmXG5cdFx0XHRcdGNvbnRlbnQgIT09IHVuZGVmaW5lZCAmJlxuXHRcdFx0XHQodHlwZW9mIGNvbnRlbnQgPT09IFwic3RyaW5nXCIgPyBjb250ZW50Lmxlbmd0aCA+IDAgOiBjb250ZW50Lmxlbmd0aCA+IDApO1xuXHRcdFx0aWYgKCFoYXNDb250ZW50ICYmICFhc3Npc3RhbnRNc2cudG9vbF9jYWxscykge1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdHBhcmFtcy5wdXNoKGFzc2lzdGFudE1zZyk7XG5cdFx0fSBlbHNlIGlmIChtc2cucm9sZSA9PT0gXCJ0b29sUmVzdWx0XCIpIHtcblx0XHRcdGNvbnN0IGltYWdlQmxvY2tzOiBBcnJheTx7IHR5cGU6IFwiaW1hZ2VfdXJsXCI7IGltYWdlX3VybDogeyB1cmw6IHN0cmluZyB9IH0+ID0gW107XG5cdFx0XHRsZXQgaiA9IGk7XG5cblx0XHRcdGZvciAoOyBqIDwgdHJhbnNmb3JtZWRNZXNzYWdlcy5sZW5ndGggJiYgdHJhbnNmb3JtZWRNZXNzYWdlc1tqXS5yb2xlID09PSBcInRvb2xSZXN1bHRcIjsgaisrKSB7XG5cdFx0XHRcdGNvbnN0IHRvb2xNc2cgPSB0cmFuc2Zvcm1lZE1lc3NhZ2VzW2pdIGFzIFRvb2xSZXN1bHRNZXNzYWdlO1xuXG5cdFx0XHRcdC8vIEV4dHJhY3QgdGV4dCBhbmQgaW1hZ2UgY29udGVudFxuXHRcdFx0XHRjb25zdCB0ZXh0UmVzdWx0ID0gdG9vbE1zZy5jb250ZW50XG5cdFx0XHRcdFx0LmZpbHRlcigoYykgPT4gYy50eXBlID09PSBcInRleHRcIilcblx0XHRcdFx0XHQubWFwKChjKSA9PiAoYyBhcyBhbnkpLnRleHQpXG5cdFx0XHRcdFx0LmpvaW4oXCJcXG5cIik7XG5cdFx0XHRcdGNvbnN0IGhhc0ltYWdlcyA9IHRvb2xNc2cuY29udGVudC5zb21lKChjKSA9PiBjLnR5cGUgPT09IFwiaW1hZ2VcIik7XG5cblx0XHRcdFx0Ly8gQWx3YXlzIHNlbmQgdG9vbCByZXN1bHQgd2l0aCB0ZXh0IChvciBwbGFjZWhvbGRlciBpZiBvbmx5IGltYWdlcylcblx0XHRcdFx0Y29uc3QgaGFzVGV4dCA9IHRleHRSZXN1bHQubGVuZ3RoID4gMDtcblx0XHRcdFx0Ly8gU29tZSBwcm92aWRlcnMgcmVxdWlyZSB0aGUgJ25hbWUnIGZpZWxkIGluIHRvb2wgcmVzdWx0c1xuXHRcdFx0XHRjb25zdCB0b29sUmVzdWx0TXNnOiBDaGF0Q29tcGxldGlvblRvb2xNZXNzYWdlUGFyYW0gPSB7XG5cdFx0XHRcdFx0cm9sZTogXCJ0b29sXCIsXG5cdFx0XHRcdFx0Y29udGVudDogc2FuaXRpemVTdXJyb2dhdGVzKGhhc1RleHQgPyB0ZXh0UmVzdWx0IDogXCIoc2VlIGF0dGFjaGVkIGltYWdlKVwiKSxcblx0XHRcdFx0XHR0b29sX2NhbGxfaWQ6IHRvb2xNc2cudG9vbENhbGxJZCxcblx0XHRcdFx0fTtcblx0XHRcdFx0aWYgKGNvbXBhdC5yZXF1aXJlc1Rvb2xSZXN1bHROYW1lICYmIHRvb2xNc2cudG9vbE5hbWUpIHtcblx0XHRcdFx0XHQodG9vbFJlc3VsdE1zZyBhcyBhbnkpLm5hbWUgPSB0b29sTXNnLnRvb2xOYW1lO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHBhcmFtcy5wdXNoKHRvb2xSZXN1bHRNc2cpO1xuXG5cdFx0XHRcdGlmIChoYXNJbWFnZXMgJiYgbW9kZWwuaW5wdXQuaW5jbHVkZXMoXCJpbWFnZVwiKSkge1xuXHRcdFx0XHRcdGZvciAoY29uc3QgYmxvY2sgb2YgdG9vbE1zZy5jb250ZW50KSB7XG5cdFx0XHRcdFx0XHRpZiAoYmxvY2sudHlwZSA9PT0gXCJpbWFnZVwiKSB7XG5cdFx0XHRcdFx0XHRcdGltYWdlQmxvY2tzLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwiaW1hZ2VfdXJsXCIsXG5cdFx0XHRcdFx0XHRcdFx0aW1hZ2VfdXJsOiB7XG5cdFx0XHRcdFx0XHRcdFx0XHR1cmw6IGBkYXRhOiR7KGJsb2NrIGFzIGFueSkubWltZVR5cGV9O2Jhc2U2NCwkeyhibG9jayBhcyBhbnkpLmRhdGF9YCxcblx0XHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0aSA9IGogLSAxO1xuXG5cdFx0XHRpZiAoaW1hZ2VCbG9ja3MubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRpZiAoY29tcGF0LnJlcXVpcmVzQXNzaXN0YW50QWZ0ZXJUb29sUmVzdWx0KSB7XG5cdFx0XHRcdFx0cGFyYW1zLnB1c2goe1xuXHRcdFx0XHRcdFx0cm9sZTogXCJhc3Npc3RhbnRcIixcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFwiSSBoYXZlIHByb2Nlc3NlZCB0aGUgdG9vbCByZXN1bHRzLlwiLFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0cGFyYW1zLnB1c2goe1xuXHRcdFx0XHRcdHJvbGU6IFwidXNlclwiLFxuXHRcdFx0XHRcdGNvbnRlbnQ6IFtcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHRcdHRleHQ6IFwiQXR0YWNoZWQgaW1hZ2UocykgZnJvbSB0b29sIHJlc3VsdDpcIixcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHQuLi5pbWFnZUJsb2Nrcyxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0bGFzdFJvbGUgPSBcInVzZXJcIjtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGxhc3RSb2xlID0gXCJ0b29sUmVzdWx0XCI7XG5cdFx0XHR9XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRsYXN0Um9sZSA9IG1zZy5yb2xlO1xuXHR9XG5cblx0cmV0dXJuIHBhcmFtcztcbn1cblxuZnVuY3Rpb24gY29udmVydFRvb2xzKFxuXHR0b29sczogVG9vbFtdLFxuXHRjb21wYXQ6IFJlcXVpcmVkPE9wZW5BSUNvbXBsZXRpb25zQ29tcGF0Pixcbik6IE9wZW5BSS5DaGF0LkNvbXBsZXRpb25zLkNoYXRDb21wbGV0aW9uVG9vbFtdIHtcblx0cmV0dXJuIHRvb2xzLm1hcCgodG9vbCkgPT4gKHtcblx0XHR0eXBlOiBcImZ1bmN0aW9uXCIsXG5cdFx0ZnVuY3Rpb246IHtcblx0XHRcdG5hbWU6IHRvb2wubmFtZSxcblx0XHRcdGRlc2NyaXB0aW9uOiB0b29sLmRlc2NyaXB0aW9uLFxuXHRcdFx0cGFyYW1ldGVyczogdG9vbC5wYXJhbWV0ZXJzIGFzIGFueSwgLy8gVHlwZUJveCBhbHJlYWR5IGdlbmVyYXRlcyBKU09OIFNjaGVtYVxuXHRcdFx0Ly8gT25seSBpbmNsdWRlIHN0cmljdCBpZiBwcm92aWRlciBzdXBwb3J0cyBpdC4gU29tZSByZWplY3QgdW5rbm93biBmaWVsZHMuXG5cdFx0XHQuLi4oY29tcGF0LnN1cHBvcnRzU3RyaWN0TW9kZSAhPT0gZmFsc2UgJiYgeyBzdHJpY3Q6IGZhbHNlIH0pLFxuXHRcdH0sXG5cdH0pKTtcbn1cblxuZnVuY3Rpb24gbWFwU3RvcFJlYXNvbihyZWFzb246IENoYXRDb21wbGV0aW9uQ2h1bmsuQ2hvaWNlW1wiZmluaXNoX3JlYXNvblwiXSk6IFN0b3BSZWFzb24ge1xuXHRpZiAocmVhc29uID09PSBudWxsKSByZXR1cm4gXCJzdG9wXCI7XG5cdHN3aXRjaCAocmVhc29uKSB7XG5cdFx0Y2FzZSBcInN0b3BcIjpcblx0XHRcdHJldHVybiBcInN0b3BcIjtcblx0XHRjYXNlIFwibGVuZ3RoXCI6XG5cdFx0XHRyZXR1cm4gXCJsZW5ndGhcIjtcblx0XHRjYXNlIFwiZnVuY3Rpb25fY2FsbFwiOlxuXHRcdGNhc2UgXCJ0b29sX2NhbGxzXCI6XG5cdFx0XHRyZXR1cm4gXCJ0b29sVXNlXCI7XG5cdFx0Y2FzZSBcImNvbnRlbnRfZmlsdGVyXCI6XG5cdFx0XHRyZXR1cm4gXCJlcnJvclwiO1xuXHRcdGRlZmF1bHQ6XG5cdFx0XHQvLyBUaGlyZC1wYXJ0eSBhbmQgY29tbXVuaXR5IG1vZGVscyAoZS5nLiBRd2VuIEdHVUYgcXVhbnRzKSBtYXkgZW1pdFxuXHRcdFx0Ly8gbm9uLXN0YW5kYXJkIGZpbmlzaF9yZWFzb24gdmFsdWVzIGxpa2UgXCJlb3NfdG9rZW5cIiwgXCJlb3NcIiwgb3Jcblx0XHRcdC8vIFwiZW5kX29mX3R1cm5cIi4gVGhlIE9wZW5BSSBzcGVjIGRlZmluZXMgZmluaXNoX3JlYXNvbiBhcyBhIHN0cmluZyxcblx0XHRcdC8vIHNvIHdlIHRyZWF0IHVucmVjb2duaXplZCB2YWx1ZXMgYXMgYSBub3JtYWwgc3RvcCByYXRoZXIgdGhhblxuXHRcdFx0Ly8gdGhyb3dpbmcgXHUyMDE0IHdoaWNoIHdvdWxkIGFib3J0IGluLWZsaWdodCB0b29sIGNhbGxzICgjODYzKS5cblx0XHRcdHJldHVybiBcInN0b3BcIjtcblx0fVxufVxuXG4vKipcbiAqIERldGVjdCBjb21wYXRpYmlsaXR5IHNldHRpbmdzIGZyb20gcHJvdmlkZXIgYW5kIGJhc2VVcmwgZm9yIGtub3duIHByb3ZpZGVycy5cbiAqIFByb3ZpZGVyIHRha2VzIHByZWNlZGVuY2Ugb3ZlciBVUkwtYmFzZWQgZGV0ZWN0aW9uIHNpbmNlIGl0J3MgZXhwbGljaXRseSBjb25maWd1cmVkLlxuICogUmV0dXJucyBhIGZ1bGx5IHJlc29sdmVkIE9wZW5BSUNvbXBsZXRpb25zQ29tcGF0IG9iamVjdCB3aXRoIGFsbCBmaWVsZHMgc2V0LlxuICovXG5mdW5jdGlvbiBkZXRlY3RDb21wYXQobW9kZWw6IE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+KTogUmVxdWlyZWQ8T3BlbkFJQ29tcGxldGlvbnNDb21wYXQ+IHtcblx0Y29uc3QgcHJvdmlkZXIgPSBtb2RlbC5wcm92aWRlcjtcblx0Y29uc3QgYmFzZVVybCA9IG1vZGVsLmJhc2VVcmw7XG5cblx0Y29uc3QgaXNaYWkgPSBwcm92aWRlciA9PT0gXCJ6YWlcIiB8fCBiYXNlVXJsLmluY2x1ZGVzKFwiYXBpLnouYWlcIik7XG5cblx0Y29uc3QgaXNOb25TdGFuZGFyZCA9XG5cdFx0cHJvdmlkZXIgPT09IFwiY2VyZWJyYXNcIiB8fFxuXHRcdGJhc2VVcmwuaW5jbHVkZXMoXCJjZXJlYnJhcy5haVwiKSB8fFxuXHRcdHByb3ZpZGVyID09PSBcInhhaVwiIHx8XG5cdFx0YmFzZVVybC5pbmNsdWRlcyhcImFwaS54LmFpXCIpIHx8XG5cdFx0YmFzZVVybC5pbmNsdWRlcyhcImNodXRlcy5haVwiKSB8fFxuXHRcdGJhc2VVcmwuaW5jbHVkZXMoXCJkZWVwc2Vlay5jb21cIikgfHxcblx0XHRpc1phaSB8fFxuXHRcdHByb3ZpZGVyID09PSBcIm9wZW5jb2RlXCIgfHxcblx0XHRiYXNlVXJsLmluY2x1ZGVzKFwib3BlbmNvZGUuYWlcIik7XG5cblx0Y29uc3QgdXNlTWF4VG9rZW5zID0gYmFzZVVybC5pbmNsdWRlcyhcImNodXRlcy5haVwiKTtcblxuXHRjb25zdCBpc0dyb2sgPSBwcm92aWRlciA9PT0gXCJ4YWlcIiB8fCBiYXNlVXJsLmluY2x1ZGVzKFwiYXBpLnguYWlcIik7XG5cdGNvbnN0IGlzR3JvcSA9IHByb3ZpZGVyID09PSBcImdyb3FcIiB8fCBiYXNlVXJsLmluY2x1ZGVzKFwiZ3JvcS5jb21cIik7XG5cblx0Y29uc3QgcmVhc29uaW5nRWZmb3J0TWFwID1cblx0XHRpc0dyb3EgJiYgbW9kZWwuaWQgPT09IFwicXdlbi9xd2VuMy0zMmJcIlxuXHRcdFx0PyB7XG5cdFx0XHRcdFx0bWluaW1hbDogXCJkZWZhdWx0XCIsXG5cdFx0XHRcdFx0bG93OiBcImRlZmF1bHRcIixcblx0XHRcdFx0XHRtZWRpdW06IFwiZGVmYXVsdFwiLFxuXHRcdFx0XHRcdGhpZ2g6IFwiZGVmYXVsdFwiLFxuXHRcdFx0XHRcdHhoaWdoOiBcImRlZmF1bHRcIixcblx0XHRcdFx0fVxuXHRcdFx0OiB7fTtcblx0cmV0dXJuIHtcblx0XHRzdXBwb3J0c1N0b3JlOiAhaXNOb25TdGFuZGFyZCxcblx0XHRzdXBwb3J0c0RldmVsb3BlclJvbGU6ICFpc05vblN0YW5kYXJkLFxuXHRcdHN1cHBvcnRzUmVhc29uaW5nRWZmb3J0OiAhaXNHcm9rICYmICFpc1phaSxcblx0XHRyZWFzb25pbmdFZmZvcnRNYXAsXG5cdFx0c3VwcG9ydHNVc2FnZUluU3RyZWFtaW5nOiB0cnVlLFxuXHRcdG1heFRva2Vuc0ZpZWxkOiB1c2VNYXhUb2tlbnMgPyBcIm1heF90b2tlbnNcIiA6IFwibWF4X2NvbXBsZXRpb25fdG9rZW5zXCIsXG5cdFx0cmVxdWlyZXNUb29sUmVzdWx0TmFtZTogZmFsc2UsXG5cdFx0cmVxdWlyZXNBc3Npc3RhbnRBZnRlclRvb2xSZXN1bHQ6IGZhbHNlLFxuXHRcdHJlcXVpcmVzVGhpbmtpbmdBc1RleHQ6IGZhbHNlLFxuXHRcdHRoaW5raW5nRm9ybWF0OiBpc1phaSA/IFwiemFpXCIgOiBcIm9wZW5haVwiLFxuXHRcdG9wZW5Sb3V0ZXJSb3V0aW5nOiB7fSxcblx0XHR2ZXJjZWxHYXRld2F5Um91dGluZzoge30sXG5cdFx0c3VwcG9ydHNTdHJpY3RNb2RlOiB0cnVlLFxuXHR9O1xufVxuXG4vKipcbiAqIEdldCByZXNvbHZlZCBjb21wYXRpYmlsaXR5IHNldHRpbmdzIGZvciBhIG1vZGVsLlxuICogVXNlcyBleHBsaWNpdCBtb2RlbC5jb21wYXQgaWYgcHJvdmlkZWQsIG90aGVyd2lzZSBhdXRvLWRldGVjdHMgZnJvbSBwcm92aWRlci9VUkwuXG4gKi9cbmZ1bmN0aW9uIGdldENvbXBhdChtb2RlbDogTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4pOiBSZXF1aXJlZDxPcGVuQUlDb21wbGV0aW9uc0NvbXBhdD4ge1xuXHRjb25zdCBkZXRlY3RlZCA9IGRldGVjdENvbXBhdChtb2RlbCk7XG5cdGlmICghbW9kZWwuY29tcGF0KSByZXR1cm4gZGV0ZWN0ZWQ7XG5cblx0cmV0dXJuIHtcblx0XHRzdXBwb3J0c1N0b3JlOiBtb2RlbC5jb21wYXQuc3VwcG9ydHNTdG9yZSA/PyBkZXRlY3RlZC5zdXBwb3J0c1N0b3JlLFxuXHRcdHN1cHBvcnRzRGV2ZWxvcGVyUm9sZTogbW9kZWwuY29tcGF0LnN1cHBvcnRzRGV2ZWxvcGVyUm9sZSA/PyBkZXRlY3RlZC5zdXBwb3J0c0RldmVsb3BlclJvbGUsXG5cdFx0c3VwcG9ydHNSZWFzb25pbmdFZmZvcnQ6IG1vZGVsLmNvbXBhdC5zdXBwb3J0c1JlYXNvbmluZ0VmZm9ydCA/PyBkZXRlY3RlZC5zdXBwb3J0c1JlYXNvbmluZ0VmZm9ydCxcblx0XHRyZWFzb25pbmdFZmZvcnRNYXA6IG1vZGVsLmNvbXBhdC5yZWFzb25pbmdFZmZvcnRNYXAgPz8gZGV0ZWN0ZWQucmVhc29uaW5nRWZmb3J0TWFwLFxuXHRcdHN1cHBvcnRzVXNhZ2VJblN0cmVhbWluZzogbW9kZWwuY29tcGF0LnN1cHBvcnRzVXNhZ2VJblN0cmVhbWluZyA/PyBkZXRlY3RlZC5zdXBwb3J0c1VzYWdlSW5TdHJlYW1pbmcsXG5cdFx0bWF4VG9rZW5zRmllbGQ6IG1vZGVsLmNvbXBhdC5tYXhUb2tlbnNGaWVsZCA/PyBkZXRlY3RlZC5tYXhUb2tlbnNGaWVsZCxcblx0XHRyZXF1aXJlc1Rvb2xSZXN1bHROYW1lOiBtb2RlbC5jb21wYXQucmVxdWlyZXNUb29sUmVzdWx0TmFtZSA/PyBkZXRlY3RlZC5yZXF1aXJlc1Rvb2xSZXN1bHROYW1lLFxuXHRcdHJlcXVpcmVzQXNzaXN0YW50QWZ0ZXJUb29sUmVzdWx0OlxuXHRcdFx0bW9kZWwuY29tcGF0LnJlcXVpcmVzQXNzaXN0YW50QWZ0ZXJUb29sUmVzdWx0ID8/IGRldGVjdGVkLnJlcXVpcmVzQXNzaXN0YW50QWZ0ZXJUb29sUmVzdWx0LFxuXHRcdHJlcXVpcmVzVGhpbmtpbmdBc1RleHQ6IG1vZGVsLmNvbXBhdC5yZXF1aXJlc1RoaW5raW5nQXNUZXh0ID8/IGRldGVjdGVkLnJlcXVpcmVzVGhpbmtpbmdBc1RleHQsXG5cdFx0dGhpbmtpbmdGb3JtYXQ6IG1vZGVsLmNvbXBhdC50aGlua2luZ0Zvcm1hdCA/PyBkZXRlY3RlZC50aGlua2luZ0Zvcm1hdCxcblx0XHRvcGVuUm91dGVyUm91dGluZzogbW9kZWwuY29tcGF0Lm9wZW5Sb3V0ZXJSb3V0aW5nID8/IHt9LFxuXHRcdHZlcmNlbEdhdGV3YXlSb3V0aW5nOiBtb2RlbC5jb21wYXQudmVyY2VsR2F0ZXdheVJvdXRpbmcgPz8gZGV0ZWN0ZWQudmVyY2VsR2F0ZXdheVJvdXRpbmcsXG5cdFx0c3VwcG9ydHNTdHJpY3RNb2RlOiBtb2RlbC5jb21wYXQuc3VwcG9ydHNTdHJpY3RNb2RlID8/IGRldGVjdGVkLnN1cHBvcnRzU3RyaWN0TW9kZSxcblx0fTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVlBLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsZUFBZSxxQkFBcUI7QUFpQjdDLFNBQVMsbUNBQW1DO0FBQzVDLFNBQVMsMEJBQTBCO0FBQ25DLFNBQVMsMEJBQTBCO0FBQ25DLFNBQVMsa0JBQWtCLHNCQUFzQjtBQUNqRDtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUNQLFNBQVMsc0JBQXNCO0FBQy9CLFNBQVMsbUNBQW1DO0FBTzVDLFNBQVMsZUFBZSxVQUE4QjtBQUNyRCxhQUFXLE9BQU8sVUFBVTtBQUMzQixRQUFJLElBQUksU0FBUyxjQUFjO0FBQzlCLGFBQU87QUFBQSxJQUNSO0FB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
