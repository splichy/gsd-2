import {
  BedrockRuntimeClient,
  StopReason as BedrockStopReason,
  CachePointType,
  CacheTTL,
  ConversationRole,
  ConverseStreamCommand,
  ImageFormat,
  ToolResultStatus
} from "@aws-sdk/client-bedrock-runtime";
import { calculateCost } from "../models.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { adjustMaxTokensForThinking, buildBaseOptions, clampReasoning } from "./simple-options.js";
import { transformMessagesWithReport } from "./transform-messages.js";
const streamBedrock = (model, context, options = {}) => {
  const stream = new AssistantMessageEventStream();
  (async () => {
    const output = {
      role: "assistant",
      content: [],
      api: "bedrock-converse-stream",
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
    const blocks = output.content;
    const config = {
      profile: options.profile
    };
    if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
      const explicitRegion = options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
      if (explicitRegion) {
        config.region = explicitRegion;
      } else if (!process.env.AWS_PROFILE) {
        config.region = "us-east-1";
      }
      if (process.env.AWS_BEDROCK_SKIP_AUTH === "1") {
        config.credentials = {
          accessKeyId: "dummy-access-key",
          secretAccessKey: "dummy-secret-key"
        };
      }
      if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.NO_PROXY || process.env.http_proxy || process.env.https_proxy || process.env.no_proxy) {
        const nodeHttpHandler = await import("@smithy/node-http-handler");
        const proxyAgent = await import("proxy-agent");
        const agent = new proxyAgent.ProxyAgent();
        config.requestHandler = new nodeHttpHandler.NodeHttpHandler({
          httpAgent: agent,
          httpsAgent: agent
        });
      } else if (process.env.AWS_BEDROCK_FORCE_HTTP1 === "1") {
        const nodeHttpHandler = await import("@smithy/node-http-handler");
        config.requestHandler = new nodeHttpHandler.NodeHttpHandler();
      }
    } else {
      config.region = options.region || "us-east-1";
    }
    try {
      const client = new BedrockRuntimeClient(config);
      const cacheRetention = resolveCacheRetention(options.cacheRetention);
      let commandInput = {
        modelId: model.id,
        messages: convertMessages(context, model, cacheRetention),
        system: buildSystemPrompt(context.systemPrompt, model, cacheRetention),
        inferenceConfig: { maxTokens: options.maxTokens, temperature: options.temperature },
        toolConfig: convertToolConfig(context.tools, options.toolChoice, model, cacheRetention),
        additionalModelRequestFields: buildAdditionalModelRequestFields(model, options)
      };
      const nextCommandInput = await options?.onPayload?.(commandInput, model);
      if (nextCommandInput !== void 0) {
        commandInput = nextCommandInput;
      }
      const command = new ConverseStreamCommand(commandInput);
      const response = await client.send(command, { abortSignal: options.signal });
      for await (const item of response.stream) {
        if (item.messageStart) {
          if (item.messageStart.role !== ConversationRole.ASSISTANT) {
            throw new Error("Unexpected assistant message start but got user message start instead");
          }
          stream.push({ type: "start", partial: output });
        } else if (item.contentBlockStart) {
          handleContentBlockStart(item.contentBlockStart, blocks, output, stream);
        } else if (item.contentBlockDelta) {
          handleContentBlockDelta(item.contentBlockDelta, blocks, output, stream);
        } else if (item.contentBlockStop) {
          handleContentBlockStop(item.contentBlockStop, blocks, output, stream);
        } else if (item.messageStop) {
          output.stopReason = mapStopReason(item.messageStop.stopReason);
        } else if (item.metadata) {
          handleMetadata(item.metadata, model, output);
        } else if (item.internalServerException) {
          throw new Error(`Internal server error: ${item.internalServerException.message}`);
        } else if (item.modelStreamErrorException) {
          throw new Error(`Model stream error: ${item.modelStreamErrorException.message}`);
        } else if (item.validationException) {
          throw new Error(`Validation error: ${item.validationException.message}`);
        } else if (item.throttlingException) {
          throw new Error(`Throttling error: ${item.throttlingException.message}`);
        } else if (item.serviceUnavailableException) {
          throw new Error(`Service unavailable: ${item.serviceUnavailableException.message}`);
        }
      }
      if (options.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        throw new Error("An unknown error occurred");
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete block.index;
        delete block.partialJson;
      }
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
};
const streamSimpleBedrock = (model, context, options) => {
  const base = buildBaseOptions(model, options, void 0);
  if (!options?.reasoning) {
    return streamBedrock(model, context, { ...base, reasoning: void 0 });
  }
  if (model.id.includes("anthropic.claude") || model.id.includes("anthropic/claude")) {
    if (supportsAdaptiveThinking(model.id)) {
      return streamBedrock(model, context, {
        ...base,
        reasoning: options.reasoning,
        thinkingBudgets: options.thinkingBudgets
      });
    }
    const adjusted = adjustMaxTokensForThinking(
      base.maxTokens || 0,
      model.maxTokens,
      options.reasoning,
      options.thinkingBudgets
    );
    return streamBedrock(model, context, {
      ...base,
      maxTokens: adjusted.maxTokens,
      reasoning: options.reasoning,
      thinkingBudgets: {
        ...options.thinkingBudgets || {},
        [clampReasoning(options.reasoning)]: adjusted.thinkingBudget
      }
    });
  }
  return streamBedrock(model, context, {
    ...base,
    reasoning: options.reasoning,
    thinkingBudgets: options.thinkingBudgets
  });
};
function handleContentBlockStart(event, blocks, output, stream) {
  const index = event.contentBlockIndex;
  const start = event.start;
  if (start?.toolUse) {
    const block = {
      type: "toolCall",
      id: start.toolUse.toolUseId || "",
      name: start.toolUse.name || "",
      arguments: {},
      partialJson: "",
      index
    };
    output.content.push(block);
    stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
  }
}
function handleContentBlockDelta(event, blocks, output, stream) {
  const contentBlockIndex = event.contentBlockIndex;
  const delta = event.delta;
  let index = blocks.findIndex((b) => b.index === contentBlockIndex);
  let block = blocks[index];
  if (delta?.text !== void 0) {
    if (!block) {
      const newBlock = { type: "text", text: "", index: contentBlockIndex };
      output.content.push(newBlock);
      index = blocks.length - 1;
      block = blocks[index];
      stream.push({ type: "text_start", contentIndex: index, partial: output });
    }
    if (block.type === "text") {
      block.text += delta.text;
      stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: output });
    }
  } else if (delta?.toolUse && block?.type === "toolCall") {
    block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");
    block.arguments = parseStreamingJson(block.partialJson);
    stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.toolUse.input || "", partial: output });
  } else if (delta?.reasoningContent) {
    let thinkingBlock = block;
    let thinkingIndex = index;
    if (!thinkingBlock) {
      const newBlock = { type: "thinking", thinking: "", thinkingSignature: "", index: contentBlockIndex };
      output.content.push(newBlock);
      thinkingIndex = blocks.length - 1;
      thinkingBlock = blocks[thinkingIndex];
      stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
    }
    if (thinkingBlock?.type === "thinking") {
      if (delta.reasoningContent.text) {
        thinkingBlock.thinking += delta.reasoningContent.text;
        stream.push({
          type: "thinking_delta",
          contentIndex: thinkingIndex,
          delta: delta.reasoningContent.text,
          partial: output
        });
      }
      if (delta.reasoningContent.signature) {
        thinkingBlock.thinkingSignature = (thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
      }
    }
  }
}
function handleMetadata(event, model, output) {
  if (event.usage) {
    output.usage.input = event.usage.inputTokens || 0;
    output.usage.output = event.usage.outputTokens || 0;
    output.usage.cacheRead = event.usage.cacheReadInputTokens || 0;
    output.usage.cacheWrite = event.usage.cacheWriteInputTokens || 0;
    output.usage.totalTokens = event.usage.totalTokens || output.usage.input + output.usage.output;
    calculateCost(model, output.usage);
  }
}
function handleContentBlockStop(event, blocks, output, stream) {
  const index = blocks.findIndex((b) => b.index === event.contentBlockIndex);
  const block = blocks[index];
  if (!block) return;
  delete block.index;
  switch (block.type) {
    case "text":
      stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
      break;
    case "thinking":
      stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
      break;
    case "toolCall":
      block.arguments = parseStreamingJson(block.partialJson);
      delete block.partialJson;
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
      break;
  }
}
function supportsAdaptiveThinking(modelId) {
  return modelId.includes("opus-4-6") || modelId.includes("opus-4.6") || modelId.includes("opus-4-7") || modelId.includes("opus-4.7") || modelId.includes("sonnet-4-6") || modelId.includes("sonnet-4.6") || modelId.includes("sonnet-4-7") || modelId.includes("sonnet-4.7") || modelId.includes("haiku-4-5") || modelId.includes("haiku-4.5");
}
function mapThinkingLevelToEffort(level, modelId) {
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
function resolveCacheRetention(cacheRetention) {
  if (cacheRetention) {
    return cacheRetention;
  }
  if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
}
function supportsPromptCaching(model) {
  if (model.cost.cacheRead || model.cost.cacheWrite) {
    return true;
  }
  const id = model.id.toLowerCase();
  if (id.includes("claude") && (id.includes("-4-") || id.includes("-4."))) return true;
  if (id.includes("claude-3-7-sonnet")) return true;
  if (id.includes("claude-3-5-haiku")) return true;
  return false;
}
function supportsThinkingSignature(model) {
  const id = model.id.toLowerCase();
  return id.includes("anthropic.claude") || id.includes("anthropic/claude");
}
function buildSystemPrompt(systemPrompt, model, cacheRetention) {
  if (!systemPrompt) return void 0;
  const blocks = [{ text: sanitizeSurrogates(systemPrompt) }];
  if (cacheRetention !== "none" && supportsPromptCaching(model)) {
    blocks.push({
      cachePoint: { type: CachePointType.DEFAULT, ...cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {} }
    });
  }
  return blocks;
}
function normalizeToolCallId(id) {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}
function convertMessages(context, model, cacheRetention) {
  const result = [];
  const transformedMessages = transformMessagesWithReport(context.messages, model, normalizeToolCallId, "bedrock-converse-stream");
  for (let i = 0; i < transformedMessages.length; i++) {
    const m = transformedMessages[i];
    switch (m.role) {
      case "user":
        result.push({
          role: ConversationRole.USER,
          content: typeof m.content === "string" ? [{ text: sanitizeSurrogates(m.content) }] : m.content.map((c) => {
            switch (c.type) {
              case "text":
                return { text: sanitizeSurrogates(c.text) };
              case "image":
                return { image: createImageBlock(c.mimeType, c.data) };
              default:
                throw new Error("Unknown user content type");
            }
          })
        });
        break;
      case "assistant": {
        if (m.content.length === 0) {
          continue;
        }
        const contentBlocks = [];
        for (const c of m.content) {
          switch (c.type) {
            case "text":
              if (c.text.trim().length === 0) continue;
              contentBlocks.push({ text: sanitizeSurrogates(c.text) });
              break;
            case "toolCall":
              contentBlocks.push({
                toolUse: { toolUseId: c.id, name: c.name, input: c.arguments }
              });
              break;
            case "thinking":
              if (c.thinking.trim().length === 0) continue;
              if (supportsThinkingSignature(model)) {
                contentBlocks.push({
                  reasoningContent: {
                    reasoningText: { text: sanitizeSurrogates(c.thinking), signature: c.thinkingSignature }
                  }
                });
              } else {
                contentBlocks.push({
                  reasoningContent: {
                    reasoningText: { text: sanitizeSurrogates(c.thinking) }
                  }
                });
              }
              break;
            default:
              throw new Error("Unknown assistant content type");
          }
        }
        if (contentBlocks.length === 0) {
          continue;
        }
        result.push({
          role: ConversationRole.ASSISTANT,
          content: contentBlocks
        });
        break;
      }
      case "toolResult": {
        const toolResults = [];
        toolResults.push({
          toolResult: {
            toolUseId: m.toolCallId,
            content: m.content.map(
              (c) => c.type === "image" ? { image: createImageBlock(c.mimeType, c.data) } : { text: sanitizeSurrogates(c.text) }
            ),
            status: m.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS
          }
        });
        let j = i + 1;
        while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
          const nextMsg = transformedMessages[j];
          toolResults.push({
            toolResult: {
              toolUseId: nextMsg.toolCallId,
              content: nextMsg.content.map(
                (c) => c.type === "image" ? { image: createImageBlock(c.mimeType, c.data) } : { text: sanitizeSurrogates(c.text) }
              ),
              status: nextMsg.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS
            }
          });
          j++;
        }
        i = j - 1;
        result.push({
          role: ConversationRole.USER,
          content: toolResults
        });
        break;
      }
      default:
        throw new Error("Unknown message role");
    }
  }
  if (cacheRetention !== "none" && supportsPromptCaching(model) && result.length > 0) {
    const lastMessage = result[result.length - 1];
    if (lastMessage.role === ConversationRole.USER && lastMessage.content) {
      lastMessage.content.push({
        cachePoint: {
          type: CachePointType.DEFAULT,
          ...cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}
        }
      });
    }
  }
  return result;
}
function convertToolConfig(tools, toolChoice, model, cacheRetention) {
  if (!tools?.length || toolChoice === "none") return void 0;
  const bedrockTools = tools.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.parameters }
    }
  }));
  if (cacheRetention !== "none" && supportsPromptCaching(model)) {
    bedrockTools.push({
      cachePoint: {
        type: CachePointType.DEFAULT,
        ...cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}
      }
    });
  }
  let bedrockToolChoice;
  switch (toolChoice) {
    case "auto":
      bedrockToolChoice = { auto: {} };
      break;
    case "any":
      bedrockToolChoice = { any: {} };
      break;
    default:
      if (toolChoice?.type === "tool") {
        bedrockToolChoice = { tool: { name: toolChoice.name } };
      }
  }
  return { tools: bedrockTools, toolChoice: bedrockToolChoice };
}
function mapStopReason(reason) {
  switch (reason) {
    case BedrockStopReason.END_TURN:
    case BedrockStopReason.STOP_SEQUENCE:
      return "stop";
    case BedrockStopReason.MAX_TOKENS:
    case BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED:
      return "length";
    case BedrockStopReason.TOOL_USE:
      return "toolUse";
    default:
      return "error";
  }
}
function buildAdditionalModelRequestFields(model, options) {
  if (!options.reasoning || !model.reasoning) {
    return void 0;
  }
  if (model.id.includes("anthropic.claude") || model.id.includes("anthropic/claude")) {
    const result = supportsAdaptiveThinking(model.id) ? {
      thinking: { type: "adaptive" },
      output_config: { effort: mapThinkingLevelToEffort(options.reasoning, model.id) }
    } : (() => {
      const defaultBudgets = {
        minimal: 1024,
        low: 2048,
        medium: 8192,
        high: 16384,
        xhigh: 16384
        // Claude doesn't support xhigh, clamp to high
      };
      const level = options.reasoning === "xhigh" ? "high" : options.reasoning;
      const budget = options.thinkingBudgets?.[level] ?? defaultBudgets[options.reasoning];
      return {
        thinking: {
          type: "enabled",
          budget_tokens: budget
        }
      };
    })();
    if (!supportsAdaptiveThinking(model.id) && (options.interleavedThinking ?? true)) {
      result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
    }
    return result;
  }
  return void 0;
}
function createImageBlock(mimeType, data) {
  let format;
  switch (mimeType) {
    case "image/jpeg":
    case "image/jpg":
      format = ImageFormat.JPEG;
      break;
    case "image/png":
      format = ImageFormat.PNG;
      break;
    case "image/gif":
      format = ImageFormat.GIF;
      break;
    case "image/webp":
      format = ImageFormat.WEBP;
      break;
    default:
      throw new Error(`Unknown image type: ${mimeType}`);
  }
  const binaryString = atob(data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return { source: { bytes }, format };
}
export {
  buildAdditionalModelRequestFields,
  mapThinkingLevelToEffort,
  streamBedrock,
  streamSimpleBedrock,
  supportsAdaptiveThinking
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy9hbWF6b24tYmVkcm9jay50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHtcblx0QmVkcm9ja1J1bnRpbWVDbGllbnQsXG5cdHR5cGUgQmVkcm9ja1J1bnRpbWVDbGllbnRDb25maWcsXG5cdFN0b3BSZWFzb24gYXMgQmVkcm9ja1N0b3BSZWFzb24sXG5cdHR5cGUgVG9vbCBhcyBCZWRyb2NrVG9vbCxcblx0Q2FjaGVQb2ludFR5cGUsXG5cdENhY2hlVFRMLFxuXHR0eXBlIENvbnRlbnRCbG9jayxcblx0dHlwZSBDb250ZW50QmxvY2tEZWx0YUV2ZW50LFxuXHR0eXBlIENvbnRlbnRCbG9ja1N0YXJ0RXZlbnQsXG5cdHR5cGUgQ29udGVudEJsb2NrU3RvcEV2ZW50LFxuXHRDb252ZXJzYXRpb25Sb2xlLFxuXHRDb252ZXJzZVN0cmVhbUNvbW1hbmQsXG5cdHR5cGUgQ29udmVyc2VTdHJlYW1NZXRhZGF0YUV2ZW50LFxuXHRJbWFnZUZvcm1hdCxcblx0dHlwZSBNZXNzYWdlLFxuXHR0eXBlIFN5c3RlbUNvbnRlbnRCbG9jayxcblx0dHlwZSBUb29sQ2hvaWNlLFxuXHR0eXBlIFRvb2xDb25maWd1cmF0aW9uLFxuXHRUb29sUmVzdWx0U3RhdHVzLFxufSBmcm9tIFwiQGF3cy1zZGsvY2xpZW50LWJlZHJvY2stcnVudGltZVwiO1xuXG5pbXBvcnQgeyBjYWxjdWxhdGVDb3N0IH0gZnJvbSBcIi4uL21vZGVscy5qc1wiO1xuaW1wb3J0IHR5cGUge1xuXHRBcGksXG5cdEFzc2lzdGFudE1lc3NhZ2UsXG5cdENhY2hlUmV0ZW50aW9uLFxuXHRDb250ZXh0LFxuXHRNb2RlbCxcblx0U2ltcGxlU3RyZWFtT3B0aW9ucyxcblx0U3RvcFJlYXNvbixcblx0U3RyZWFtRnVuY3Rpb24sXG5cdFN0cmVhbU9wdGlvbnMsXG5cdFRleHRDb250ZW50LFxuXHRUaGlua2luZ0J1ZGdldHMsXG5cdFRoaW5raW5nQ29udGVudCxcblx0VGhpbmtpbmdMZXZlbCxcblx0VG9vbCxcblx0VG9vbENhbGwsXG5cdFRvb2xSZXN1bHRNZXNzYWdlLFxufSBmcm9tIFwiLi4vdHlwZXMuanNcIjtcbmltcG9ydCB7IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSB9IGZyb20gXCIuLi91dGlscy9ldmVudC1zdHJlYW0uanNcIjtcbmltcG9ydCB7IHBhcnNlU3RyZWFtaW5nSnNvbiB9IGZyb20gXCIuLi91dGlscy9qc29uLXBhcnNlLmpzXCI7XG5pbXBvcnQgeyBzYW5pdGl6ZVN1cnJvZ2F0ZXMgfSBmcm9tIFwiLi4vdXRpbHMvc2FuaXRpemUtdW5pY29kZS5qc1wiO1xuaW1wb3J0IHsgYWRqdXN0TWF4VG9rZW5zRm9yVGhpbmtpbmcsIGJ1aWxkQmFzZU9wdGlvbnMsIGNsYW1wUmVhc29uaW5nIH0gZnJvbSBcIi4vc2ltcGxlLW9wdGlvbnMuanNcIjtcbmltcG9ydCB7IHRyYW5zZm9ybU1lc3NhZ2VzV2l0aFJlcG9ydCB9IGZyb20gXCIuL3RyYW5zZm9ybS1tZXNzYWdlcy5qc1wiO1xuXG4vKiogU3RyZWFtIG9wdGlvbnMgc3BlY2lmaWMgdG8gdGhlIEFtYXpvbiBCZWRyb2NrIGNvbnZlcnNlLXN0cmVhbSBwcm92aWRlciwgaW5jbHVkaW5nIHJlZ2lvbiwgcmVhc29uaW5nLCBhbmQgY2FjaGluZyBrbm9icy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQmVkcm9ja09wdGlvbnMgZXh0ZW5kcyBTdHJlYW1PcHRpb25zIHtcblx0cmVnaW9uPzogc3RyaW5nO1xuXHRwcm9maWxlPzogc3RyaW5nO1xuXHR0b29sQ2hvaWNlPzogXCJhdXRvXCIgfCBcImFueVwiIHwgXCJub25lXCIgfCB7IHR5cGU6IFwidG9vbFwiOyBuYW1lOiBzdHJpbmcgfTtcblx0LyogU2VlIGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9iZWRyb2NrL2xhdGVzdC91c2VyZ3VpZGUvaW5mZXJlbmNlLXJlYXNvbmluZy5odG1sIGZvciBzdXBwb3J0ZWQgbW9kZWxzLiAqL1xuXHRyZWFzb25pbmc/OiBUaGlua2luZ0xldmVsO1xuXHQvKiBDdXN0b20gdG9rZW4gYnVkZ2V0cyBwZXIgdGhpbmtpbmcgbGV2ZWwuIE92ZXJyaWRlcyBkZWZhdWx0IGJ1ZGdldHMuICovXG5cdHRoaW5raW5nQnVkZ2V0cz86IFRoaW5raW5nQnVkZ2V0cztcblx0LyogT25seSBzdXBwb3J0ZWQgYnkgQ2xhdWRlIDQueCBtb2RlbHMsIHNlZSBodHRwczovL2RvY3MuYXdzLmFtYXpvbi5jb20vYmVkcm9jay9sYXRlc3QvdXNlcmd1aWRlL2NsYXVkZS1tZXNzYWdlcy1leHRlbmRlZC10aGlua2luZy5odG1sI2NsYXVkZS1tZXNzYWdlcy1leHRlbmRlZC10aGlua2luZy10b29sLXVzZS1pbnRlcmxlYXZlZCAqL1xuXHRpbnRlcmxlYXZlZFRoaW5raW5nPzogYm9vbGVhbjtcbn1cblxuLyoqIEludGVybmFsIHdvcmtpbmcgdHlwZSB0aGF0IGFubm90YXRlcyBjb250ZW50IGJsb2NrcyB3aXRoIGEgc3RyZWFtaW5nIGluZGV4IGFuZCBwYXJ0aWFsIEpTT04gYWNjdW11bGF0b3IuICovXG50eXBlIEJsb2NrID0gKFRleHRDb250ZW50IHwgVGhpbmtpbmdDb250ZW50IHwgVG9vbENhbGwpICYgeyBpbmRleD86IG51bWJlcjsgcGFydGlhbEpzb24/OiBzdHJpbmcgfTtcblxuLyoqIFN0cmVhbSBhIGNvbnZlcnNhdGlvbiB0dXJuIHZpYSBBbWF6b24gQmVkcm9jaydzIGNvbnZlcnNlLXN0cmVhbSBBUEkuICovXG5leHBvcnQgY29uc3Qgc3RyZWFtQmVkcm9jazogU3RyZWFtRnVuY3Rpb248XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLCBCZWRyb2NrT3B0aW9ucz4gPSAoXG5cdG1vZGVsOiBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRjb250ZXh0OiBDb250ZXh0LFxuXHRvcHRpb25zOiBCZWRyb2NrT3B0aW9ucyA9IHt9LFxuKTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtID0+IHtcblx0Y29uc3Qgc3RyZWFtID0gbmV3IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSgpO1xuXG5cdChhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgb3V0cHV0OiBBc3Npc3RhbnRNZXNzYWdlID0ge1xuXHRcdFx0cm9sZTogXCJhc3Npc3RhbnRcIixcblx0XHRcdGNvbnRlbnQ6IFtdLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIgYXMgQXBpLFxuXHRcdFx0cHJvdmlkZXI6IG1vZGVsLnByb3ZpZGVyLFxuXHRcdFx0bW9kZWw6IG1vZGVsLmlkLFxuXHRcdFx0dXNhZ2U6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0XHR0b3RhbFRva2VuczogMCxcblx0XHRcdFx0Y29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsOiAwIH0sXG5cdFx0XHR9LFxuXHRcdFx0c3RvcFJlYXNvbjogXCJzdG9wXCIsXG5cdFx0XHR0aW1lc3RhbXA6IERhdGUubm93KCksXG5cdFx0fTtcblxuXHRcdGNvbnN0IGJsb2NrcyA9IG91dHB1dC5jb250ZW50IGFzIEJsb2NrW107XG5cblx0XHRjb25zdCBjb25maWc6IEJlZHJvY2tSdW50aW1lQ2xpZW50Q29uZmlnID0ge1xuXHRcdFx0cHJvZmlsZTogb3B0aW9ucy5wcm9maWxlLFxuXHRcdH07XG5cblx0XHQvLyBpbiBOb2RlLmpzL0J1biBlbnZpcm9ubWVudCBvbmx5XG5cdFx0aWYgKHR5cGVvZiBwcm9jZXNzICE9PSBcInVuZGVmaW5lZFwiICYmIChwcm9jZXNzLnZlcnNpb25zPy5ub2RlIHx8IHByb2Nlc3MudmVyc2lvbnM/LmJ1bikpIHtcblx0XHRcdC8vIFJlZ2lvbiByZXNvbHV0aW9uOiBleHBsaWNpdCBvcHRpb24gPiBlbnYgdmFycyA+IFNESyBkZWZhdWx0IGNoYWluLlxuXHRcdFx0Ly8gV2hlbiBBV1NfUFJPRklMRSBpcyBzZXQsIHdlIGxlYXZlIHJlZ2lvbiB1bmRlZmluZWQgc28gdGhlIFNESyBjYW5cblx0XHRcdC8vIHJlc292bGUgaXQgZnJvbSBhd3MgcHJvZmlsZSBjb25maWdzLiBPdGhlcndpc2UgZmFsbCBiYWNrIHRvIHVzLWVhc3QtMS5cblx0XHRcdGNvbnN0IGV4cGxpY2l0UmVnaW9uID0gb3B0aW9ucy5yZWdpb24gfHwgcHJvY2Vzcy5lbnYuQVdTX1JFR0lPTiB8fCBwcm9jZXNzLmVudi5BV1NfREVGQVVMVF9SRUdJT047XG5cdFx0XHRpZiAoZXhwbGljaXRSZWdpb24pIHtcblx0XHRcdFx0Y29uZmlnLnJlZ2lvbiA9IGV4cGxpY2l0UmVnaW9uO1xuXHRcdFx0fSBlbHNlIGlmICghcHJvY2Vzcy5lbnYuQVdTX1BST0ZJTEUpIHtcblx0XHRcdFx0Y29uZmlnLnJlZ2lvbiA9IFwidXMtZWFzdC0xXCI7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFN1cHBvcnQgcHJveGllcyB0aGF0IGRvbid0IG5lZWQgYXV0aGVudGljYXRpb25cblx0XHRcdGlmIChwcm9jZXNzLmVudi5BV1NfQkVEUk9DS19TS0lQX0FVVEggPT09IFwiMVwiKSB7XG5cdFx0XHRcdGNvbmZpZy5jcmVkZW50aWFscyA9IHtcblx0XHRcdFx0XHRhY2Nlc3NLZXlJZDogXCJkdW1teS1hY2Nlc3Mta2V5XCIsXG5cdFx0XHRcdFx0c2VjcmV0QWNjZXNzS2V5OiBcImR1bW15LXNlY3JldC1rZXlcIixcblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKFxuXHRcdFx0XHRwcm9jZXNzLmVudi5IVFRQX1BST1hZIHx8XG5cdFx0XHRcdHByb2Nlc3MuZW52LkhUVFBTX1BST1hZIHx8XG5cdFx0XHRcdHByb2Nlc3MuZW52Lk5PX1BST1hZIHx8XG5cdFx0XHRcdHByb2Nlc3MuZW52Lmh0dHBfcHJveHkgfHxcblx0XHRcdFx0cHJvY2Vzcy5lbnYuaHR0cHNfcHJveHkgfHxcblx0XHRcdFx0cHJvY2Vzcy5lbnYubm9fcHJveHlcblx0XHRcdCkge1xuXHRcdFx0XHRjb25zdCBub2RlSHR0cEhhbmRsZXIgPSBhd2FpdCBpbXBvcnQoXCJAc21pdGh5L25vZGUtaHR0cC1oYW5kbGVyXCIpO1xuXHRcdFx0XHRjb25zdCBwcm94eUFnZW50ID0gYXdhaXQgaW1wb3J0KFwicHJveHktYWdlbnRcIik7XG5cblx0XHRcdFx0Y29uc3QgYWdlbnQgPSBuZXcgcHJveHlBZ2VudC5Qcm94eUFnZW50KCk7XG5cblx0XHRcdFx0Ly8gQmVkcm9jayBydW50aW1lIHVzZXMgTm9kZUh0dHAySGFuZGxlciBieSBkZWZhdWx0IHNpbmNlIHYzLjc5OC4wLCB3aGljaCBpcyBiYXNlZFxuXHRcdFx0XHQvLyBvbiBgaHR0cDJgIG1vZHVsZSBhbmQgaGFzIG5vIHN1cHBvcnQgZm9yIGh0dHAgYWdlbnQuXG5cdFx0XHRcdC8vIFVzZSBOb2RlSHR0cEhhbmRsZXIgdG8gc3VwcG9ydCBodHRwIGFnZW50LlxuXHRcdFx0XHRjb25maWcucmVxdWVzdEhhbmRsZXIgPSBuZXcgbm9kZUh0dHBIYW5kbGVyLk5vZGVIdHRwSGFuZGxlcih7XG5cdFx0XHRcdFx0aHR0cEFnZW50OiBhZ2VudCxcblx0XHRcdFx0XHRodHRwc0FnZW50OiBhZ2VudCxcblx0XHRcdFx0fSk7XG5cdFx0XHR9IGVsc2UgaWYgKHByb2Nlc3MuZW52LkFXU19CRURST0NLX0ZPUkNFX0hUVFAxID09PSBcIjFcIikge1xuXHRcdFx0XHQvLyBTb21lIGN1c3RvbSBlbmRwb2ludHMgcmVxdWlyZSBIVFRQLzEuMSBpbnN0ZWFkIG9mIEhUVFAvMlxuXHRcdFx0XHRjb25zdCBub2RlSHR0cEhhbmRsZXIgPSBhd2FpdCBpbXBvcnQoXCJAc21pdGh5L25vZGUtaHR0cC1oYW5kbGVyXCIpO1xuXHRcdFx0XHRjb25maWcucmVxdWVzdEhhbmRsZXIgPSBuZXcgbm9kZUh0dHBIYW5kbGVyLk5vZGVIdHRwSGFuZGxlcigpO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBOb24tTm9kZSBlbnZpcm9ubWVudCAoYnJvd3Nlcik6IGZhbGwgYmFjayB0byB1cy1lYXN0LTEgc2luY2Vcblx0XHRcdC8vIHRoZXJlJ3Mgbm8gY29uZmlnIGZpbGUgcmVzb2x1dGlvbiBhdmFpbGFibGUuXG5cdFx0XHRjb25maWcucmVnaW9uID0gb3B0aW9ucy5yZWdpb24gfHwgXCJ1cy1lYXN0LTFcIjtcblx0XHR9XG5cblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgY2xpZW50ID0gbmV3IEJlZHJvY2tSdW50aW1lQ2xpZW50KGNvbmZpZyk7XG5cblx0XHRcdGNvbnN0IGNhY2hlUmV0ZW50aW9uID0gcmVzb2x2ZUNhY2hlUmV0ZW50aW9uKG9wdGlvbnMuY2FjaGVSZXRlbnRpb24pO1xuXHRcdFx0bGV0IGNvbW1hbmRJbnB1dCA9IHtcblx0XHRcdFx0bW9kZWxJZDogbW9kZWwuaWQsXG5cdFx0XHRcdG1lc3NhZ2VzOiBjb252ZXJ0TWVzc2FnZXMoY29udGV4dCwgbW9kZWwsIGNhY2hlUmV0ZW50aW9uKSxcblx0XHRcdFx0c3lzdGVtOiBidWlsZFN5c3RlbVByb21wdChjb250ZXh0LnN5c3RlbVByb21wdCwgbW9kZWwsIGNhY2hlUmV0ZW50aW9uKSxcblx0XHRcdFx0aW5mZXJlbmNlQ29uZmlnOiB7IG1heFRva2Vuczogb3B0aW9ucy5tYXhUb2tlbnMsIHRlbXBlcmF0dXJlOiBvcHRpb25zLnRlbXBlcmF0dXJlIH0sXG5cdFx0XHRcdHRvb2xDb25maWc6IGNvbnZlcnRUb29sQ29uZmlnKGNvbnRleHQudG9vbHMsIG9wdGlvbnMudG9vbENob2ljZSwgbW9kZWwsIGNhY2hlUmV0ZW50aW9uKSxcblx0XHRcdFx0YWRkaXRpb25hbE1vZGVsUmVxdWVzdEZpZWxkczogYnVpbGRBZGRpdGlvbmFsTW9kZWxSZXF1ZXN0RmllbGRzKG1vZGVsLCBvcHRpb25zKSxcblx0XHRcdH07XG5cdFx0XHRjb25zdCBuZXh0Q29tbWFuZElucHV0ID0gYXdhaXQgb3B0aW9ucz8ub25QYXlsb2FkPy4oY29tbWFuZElucHV0LCBtb2RlbCk7XG5cdFx0XHRpZiAobmV4dENvbW1hbmRJbnB1dCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdGNvbW1hbmRJbnB1dCA9IG5leHRDb21tYW5kSW5wdXQgYXMgdHlwZW9mIGNvbW1hbmRJbnB1dDtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGNvbW1hbmQgPSBuZXcgQ29udmVyc2VTdHJlYW1Db21tYW5kKGNvbW1hbmRJbnB1dCk7XG5cblx0XHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgY2xpZW50LnNlbmQoY29tbWFuZCwgeyBhYm9ydFNpZ25hbDogb3B0aW9ucy5zaWduYWwgfSk7XG5cblx0XHRcdGZvciBhd2FpdCAoY29uc3QgaXRlbSBvZiByZXNwb25zZS5zdHJlYW0hKSB7XG5cdFx0XHRcdGlmIChpdGVtLm1lc3NhZ2VTdGFydCkge1xuXHRcdFx0XHRcdGlmIChpdGVtLm1lc3NhZ2VTdGFydC5yb2xlICE9PSBDb252ZXJzYXRpb25Sb2xlLkFTU0lTVEFOVCkge1xuXHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiVW5leHBlY3RlZCBhc3Npc3RhbnQgbWVzc2FnZSBzdGFydCBidXQgZ290IHVzZXIgbWVzc2FnZSBzdGFydCBpbnN0ZWFkXCIpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwic3RhcnRcIiwgcGFydGlhbDogb3V0cHV0IH0pO1xuXHRcdFx0XHR9IGVsc2UgaWYgKGl0ZW0uY29udGVudEJsb2NrU3RhcnQpIHtcblx0XHRcdFx0XHRoYW5kbGVDb250ZW50QmxvY2tTdGFydChpdGVtLmNvbnRlbnRCbG9ja1N0YXJ0LCBibG9ja3MsIG91dHB1dCwgc3RyZWFtKTtcblx0XHRcdFx0fSBlbHNlIGlmIChpdGVtLmNvbnRlbnRCbG9ja0RlbHRhKSB7XG5cdFx0XHRcdFx0aGFuZGxlQ29udGVudEJsb2NrRGVsdGEoaXRlbS5jb250ZW50QmxvY2tEZWx0YSwgYmxvY2tzLCBvdXRwdXQsIHN0cmVhbSk7XG5cdFx0XHRcdH0gZWxzZSBpZiAoaXRlbS5jb250ZW50QmxvY2tTdG9wKSB7XG5cdFx0XHRcdFx0aGFuZGxlQ29udGVudEJsb2NrU3RvcChpdGVtLmNvbnRlbnRCbG9ja1N0b3AsIGJsb2Nrcywgb3V0cHV0LCBzdHJlYW0pO1xuXHRcdFx0XHR9IGVsc2UgaWYgKGl0ZW0ubWVzc2FnZVN0b3ApIHtcblx0XHRcdFx0XHRvdXRwdXQuc3RvcFJlYXNvbiA9IG1hcFN0b3BSZWFzb24oaXRlbS5tZXNzYWdlU3RvcC5zdG9wUmVhc29uKTtcblx0XHRcdFx0fSBlbHNlIGlmIChpdGVtLm1ldGFkYXRhKSB7XG5cdFx0XHRcdFx0aGFuZGxlTWV0YWRhdGEoaXRlbS5tZXRhZGF0YSwgbW9kZWwsIG91dHB1dCk7XG5cdFx0XHRcdH0gZWxzZSBpZiAoaXRlbS5pbnRlcm5hbFNlcnZlckV4Y2VwdGlvbikge1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgSW50ZXJuYWwgc2VydmVyIGVycm9yOiAke2l0ZW0uaW50ZXJuYWxTZXJ2ZXJFeGNlcHRpb24ubWVzc2FnZX1gKTtcblx0XHRcdFx0fSBlbHNlIGlmIChpdGVtLm1vZGVsU3RyZWFtRXJyb3JFeGNlcHRpb24pIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYE1vZGVsIHN0cmVhbSBlcnJvcjogJHtpdGVtLm1vZGVsU3RyZWFtRXJyb3JFeGNlcHRpb24ubWVzc2FnZX1gKTtcblx0XHRcdFx0fSBlbHNlIGlmIChpdGVtLnZhbGlkYXRpb25FeGNlcHRpb24pIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYFZhbGlkYXRpb24gZXJyb3I6ICR7aXRlbS52YWxpZGF0aW9uRXhjZXB0aW9uLm1lc3NhZ2V9YCk7XG5cdFx0XHRcdH0gZWxzZSBpZiAoaXRlbS50aHJvdHRsaW5nRXhjZXB0aW9uKSB7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBUaHJvdHRsaW5nIGVycm9yOiAke2l0ZW0udGhyb3R0bGluZ0V4Y2VwdGlvbi5tZXNzYWdlfWApO1xuXHRcdFx0XHR9IGVsc2UgaWYgKGl0ZW0uc2VydmljZVVuYXZhaWxhYmxlRXhjZXB0aW9uKSB7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBTZXJ2aWNlIHVuYXZhaWxhYmxlOiAke2l0ZW0uc2VydmljZVVuYXZhaWxhYmxlRXhjZXB0aW9uLm1lc3NhZ2V9YCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0aWYgKG9wdGlvbnMuc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIlJlcXVlc3Qgd2FzIGFib3J0ZWRcIik7XG5cdFx0XHR9XG5cblx0XHRcdGlmIChvdXRwdXQuc3RvcFJlYXNvbiA9PT0gXCJlcnJvclwiIHx8IG91dHB1dC5zdG9wUmVhc29uID09PSBcImFib3J0ZWRcIikge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJBbiB1bmtub3duIGVycm9yIG9jY3VycmVkXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwiZG9uZVwiLCByZWFzb246IG91dHB1dC5zdG9wUmVhc29uLCBtZXNzYWdlOiBvdXRwdXQgfSk7XG5cdFx0XHRzdHJlYW0uZW5kKCk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGZvciAoY29uc3QgYmxvY2sgb2Ygb3V0cHV0LmNvbnRlbnQpIHtcblx0XHRcdFx0ZGVsZXRlIChibG9jayBhcyBCbG9jaykuaW5kZXg7XG5cdFx0XHRcdGRlbGV0ZSAoYmxvY2sgYXMgQmxvY2spLnBhcnRpYWxKc29uO1xuXHRcdFx0fVxuXHRcdFx0b3V0cHV0LnN0b3BSZWFzb24gPSBvcHRpb25zLnNpZ25hbD8uYWJvcnRlZCA/IFwiYWJvcnRlZFwiIDogXCJlcnJvclwiO1xuXHRcdFx0b3V0cHV0LmVycm9yTWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogSlNPTi5zdHJpbmdpZnkoZXJyb3IpO1xuXHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcImVycm9yXCIsIHJlYXNvbjogb3V0cHV0LnN0b3BSZWFzb24sIGVycm9yOiBvdXRwdXQgfSk7XG5cdFx0XHRzdHJlYW0uZW5kKCk7XG5cdFx0fVxuXHR9KSgpO1xuXG5cdHJldHVybiBzdHJlYW07XG59O1xuXG4vKiogU2ltcGxpZmllZCBlbnRyeSBwb2ludCBmb3IgQmVkcm9jayBzdHJlYW1pbmc7IHJlc29sdmVzIHRoaW5raW5nIGJ1ZGdldHMgYW5kIGFkYXB0aXZlLXRoaW5raW5nIHN1cHBvcnQuICovXG5leHBvcnQgY29uc3Qgc3RyZWFtU2ltcGxlQmVkcm9jazogU3RyZWFtRnVuY3Rpb248XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLCBTaW1wbGVTdHJlYW1PcHRpb25zPiA9IChcblx0bW9kZWw6IE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdGNvbnRleHQ6IENvbnRleHQsXG5cdG9wdGlvbnM/OiBTaW1wbGVTdHJlYW1PcHRpb25zLFxuKTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtID0+IHtcblx0Y29uc3QgYmFzZSA9IGJ1aWxkQmFzZU9wdGlvbnMobW9kZWwsIG9wdGlvbnMsIHVuZGVmaW5lZCk7XG5cdGlmICghb3B0aW9ucz8ucmVhc29uaW5nKSB7XG5cdFx0cmV0dXJuIHN0cmVhbUJlZHJvY2sobW9kZWwsIGNvbnRleHQsIHsgLi4uYmFzZSwgcmVhc29uaW5nOiB1bmRlZmluZWQgfSBzYXRpc2ZpZXMgQmVkcm9ja09wdGlvbnMpO1xuXHR9XG5cblx0aWYgKG1vZGVsLmlkLmluY2x1ZGVzKFwiYW50aHJvcGljLmNsYXVkZVwiKSB8fCBtb2RlbC5pZC5pbmNsdWRlcyhcImFudGhyb3BpYy9jbGF1ZGVcIikpIHtcblx0XHRpZiAoc3VwcG9ydHNBZGFwdGl2ZVRoaW5raW5nKG1vZGVsLmlkKSkge1xuXHRcdFx0cmV0dXJuIHN0cmVhbUJlZHJvY2sobW9kZWwsIGNvbnRleHQsIHtcblx0XHRcdFx0Li4uYmFzZSxcblx0XHRcdFx0cmVhc29uaW5nOiBvcHRpb25zLnJlYXNvbmluZyxcblx0XHRcdFx0dGhpbmtpbmdCdWRnZXRzOiBvcHRpb25zLnRoaW5raW5nQnVkZ2V0cyxcblx0XHRcdH0gc2F0aXNmaWVzIEJlZHJvY2tPcHRpb25zKTtcblx0XHR9XG5cblx0XHRjb25zdCBhZGp1c3RlZCA9IGFkanVzdE1heFRva2Vuc0ZvclRoaW5raW5nKFxuXHRcdFx0YmFzZS5tYXhUb2tlbnMgfHwgMCxcblx0XHRcdG1vZGVsLm1heFRva2Vucyxcblx0XHRcdG9wdGlvbnMucmVhc29uaW5nLFxuXHRcdFx0b3B0aW9ucy50aGlua2luZ0J1ZGdldHMsXG5cdFx0KTtcblxuXHRcdHJldHVybiBzdHJlYW1CZWRyb2NrKG1vZGVsLCBjb250ZXh0LCB7XG5cdFx0XHQuLi5iYXNlLFxuXHRcdFx0bWF4VG9rZW5zOiBhZGp1c3RlZC5tYXhUb2tlbnMsXG5cdFx0XHRyZWFzb25pbmc6IG9wdGlvbnMucmVhc29uaW5nLFxuXHRcdFx0dGhpbmtpbmdCdWRnZXRzOiB7XG5cdFx0XHRcdC4uLihvcHRpb25zLnRoaW5raW5nQnVkZ2V0cyB8fCB7fSksXG5cdFx0XHRcdFtjbGFtcFJlYXNvbmluZyhvcHRpb25zLnJlYXNvbmluZykhXTogYWRqdXN0ZWQudGhpbmtpbmdCdWRnZXQsXG5cdFx0XHR9LFxuXHRcdH0gc2F0aXNmaWVzIEJlZHJvY2tPcHRpb25zKTtcblx0fVxuXG5cdHJldHVybiBzdHJlYW1CZWRyb2NrKG1vZGVsLCBjb250ZXh0LCB7XG5cdFx0Li4uYmFzZSxcblx0XHRyZWFzb25pbmc6IG9wdGlvbnMucmVhc29uaW5nLFxuXHRcdHRoaW5raW5nQnVkZ2V0czogb3B0aW9ucy50aGlua2luZ0J1ZGdldHMsXG5cdH0gc2F0aXNmaWVzIEJlZHJvY2tPcHRpb25zKTtcbn07XG5cbi8qKiBIYW5kbGUgYSBgY29udGVudEJsb2NrU3RhcnRgIGV2ZW50LCBpbml0aWFsaXNpbmcgYSBuZXcgdG9vbC1jYWxsIGJsb2NrIHdoZW4gYSB0b29sLXVzZSBzdGFydCBhcnJpdmVzLiAqL1xuZnVuY3Rpb24gaGFuZGxlQ29udGVudEJsb2NrU3RhcnQoXG5cdGV2ZW50OiBDb250ZW50QmxvY2tTdGFydEV2ZW50LFxuXHRibG9ja3M6IEJsb2NrW10sXG5cdG91dHB1dDogQXNzaXN0YW50TWVzc2FnZSxcblx0c3RyZWFtOiBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0sXG4pOiB2b2lkIHtcblx0Y29uc3QgaW5kZXggPSBldmVudC5jb250ZW50QmxvY2tJbmRleCE7XG5cdGNvbnN0IHN0YXJ0ID0gZXZlbnQuc3RhcnQ7XG5cblx0aWYgKHN0YXJ0Py50b29sVXNlKSB7XG5cdFx0Y29uc3QgYmxvY2s6IEJsb2NrID0ge1xuXHRcdFx0dHlwZTogXCJ0b29sQ2FsbFwiLFxuXHRcdFx0aWQ6IHN0YXJ0LnRvb2xVc2UudG9vbFVzZUlkIHx8IFwiXCIsXG5cdFx0XHRuYW1lOiBzdGFydC50b29sVXNlLm5hbWUgfHwgXCJcIixcblx0XHRcdGFyZ3VtZW50czoge30sXG5cdFx0XHRwYXJ0aWFsSnNvbjogXCJcIixcblx0XHRcdGluZGV4LFxuXHRcdH07XG5cdFx0b3V0cHV0LmNvbnRlbnQucHVzaChibG9jayk7XG5cdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInRvb2xjYWxsX3N0YXJ0XCIsIGNvbnRlbnRJbmRleDogYmxvY2tzLmxlbmd0aCAtIDEsIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0fVxufVxuXG4vKiogSGFuZGxlIGEgYGNvbnRlbnRCbG9ja0RlbHRhYCBldmVudCwgYXBwZW5kaW5nIHRleHQsIHRvb2wtaW5wdXQgSlNPTiwgb3IgcmVhc29uaW5nIGNvbnRlbnQgdG8gdGhlIGFjdGl2ZSBibG9jay4gKi9cbmZ1bmN0aW9uIGhhbmRsZUNvbnRlbnRCbG9ja0RlbHRhKFxuXHRldmVudDogQ29udGVudEJsb2NrRGVsdGFFdmVudCxcblx0YmxvY2tzOiBCbG9ja1tdLFxuXHRvdXRwdXQ6IEFzc2lzdGFudE1lc3NhZ2UsXG5cdHN0cmVhbTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtLFxuKTogdm9pZCB7XG5cdGNvbnN0IGNvbnRlbnRCbG9ja0luZGV4ID0gZXZlbnQuY29udGVudEJsb2NrSW5kZXghO1xuXHRjb25zdCBkZWx0YSA9IGV2ZW50LmRlbHRhO1xuXHRsZXQgaW5kZXggPSBibG9ja3MuZmluZEluZGV4KChiKSA9PiBiLmluZGV4ID09PSBjb250ZW50QmxvY2tJbmRleCk7XG5cdGxldCBibG9jayA9IGJsb2Nrc1tpbmRleF07XG5cblx0aWYgKGRlbHRhPy50ZXh0ICE9PSB1bmRlZmluZWQpIHtcblx0XHQvLyBJZiBubyB0ZXh0IGJsb2NrIGV4aXN0cyB5ZXQsIGNyZWF0ZSBvbmUsIGFzIGBoYW5kbGVDb250ZW50QmxvY2tTdGFydGAgaXMgbm90IHNlbnQgZm9yIHRleHQgYmxvY2tzXG5cdFx0aWYgKCFibG9jaykge1xuXHRcdFx0Y29uc3QgbmV3QmxvY2s6IEJsb2NrID0geyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJcIiwgaW5kZXg6IGNvbnRlbnRCbG9ja0luZGV4IH07XG5cdFx0XHRvdXRwdXQuY29udGVudC5wdXNoKG5ld0Jsb2NrKTtcblx0XHRcdGluZGV4ID0gYmxvY2tzLmxlbmd0aCAtIDE7XG5cdFx0XHRibG9jayA9IGJsb2Nrc1tpbmRleF07XG5cdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwidGV4dF9zdGFydFwiLCBjb250ZW50SW5kZXg6IGluZGV4LCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0fVxuXHRcdGlmIChibG9jay50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0YmxvY2sudGV4dCArPSBkZWx0YS50ZXh0O1xuXHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInRleHRfZGVsdGFcIiwgY29udGVudEluZGV4OiBpbmRleCwgZGVsdGE6IGRlbHRhLnRleHQsIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHR9XG5cdH0gZWxzZSBpZiAoZGVsdGE/LnRvb2xVc2UgJiYgYmxvY2s/LnR5cGUgPT09IFwidG9vbENhbGxcIikge1xuXHRcdGJsb2NrLnBhcnRpYWxKc29uID0gKGJsb2NrLnBhcnRpYWxKc29uIHx8IFwiXCIpICsgKGRlbHRhLnRvb2xVc2UuaW5wdXQgfHwgXCJcIik7XG5cdFx0YmxvY2suYXJndW1lbnRzID0gcGFyc2VTdHJlYW1pbmdKc29uKGJsb2NrLnBhcnRpYWxKc29uKTtcblx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwidG9vbGNhbGxfZGVsdGFcIiwgY29udGVudEluZGV4OiBpbmRleCwgZGVsdGE6IGRlbHRhLnRvb2xVc2UuaW5wdXQgfHwgXCJcIiwgcGFydGlhbDogb3V0cHV0IH0pO1xuXHR9IGVsc2UgaWYgKGRlbHRhPy5yZWFzb25pbmdDb250ZW50KSB7XG5cdFx0bGV0IHRoaW5raW5nQmxvY2sgPSBibG9jaztcblx0XHRsZXQgdGhpbmtpbmdJbmRleCA9IGluZGV4O1xuXG5cdFx0aWYgKCF0aGlua2luZ0Jsb2NrKSB7XG5cdFx0XHRjb25zdCBuZXdCbG9jazogQmxvY2sgPSB7IHR5cGU6IFwidGhpbmtpbmdcIiwgdGhpbmtpbmc6IFwiXCIsIHRoaW5raW5nU2lnbmF0dXJlOiBcIlwiLCBpbmRleDogY29udGVudEJsb2NrSW5kZXggfTtcblx0XHRcdG91dHB1dC5jb250ZW50LnB1c2gobmV3QmxvY2spO1xuXHRcdFx0dGhpbmtpbmdJbmRleCA9IGJsb2Nrcy5sZW5ndGggLSAxO1xuXHRcdFx0dGhpbmtpbmdCbG9jayA9IGJsb2Nrc1t0aGlua2luZ0luZGV4XTtcblx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0aGlua2luZ19zdGFydFwiLCBjb250ZW50SW5kZXg6IHRoaW5raW5nSW5kZXgsIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHR9XG5cblx0XHRpZiAodGhpbmtpbmdCbG9jaz8udHlwZSA9PT0gXCJ0aGlua2luZ1wiKSB7XG5cdFx0XHRpZiAoZGVsdGEucmVhc29uaW5nQ29udGVudC50ZXh0KSB7XG5cdFx0XHRcdHRoaW5raW5nQmxvY2sudGhpbmtpbmcgKz0gZGVsdGEucmVhc29uaW5nQ29udGVudC50ZXh0O1xuXHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0dHlwZTogXCJ0aGlua2luZ19kZWx0YVwiLFxuXHRcdFx0XHRcdGNvbnRlbnRJbmRleDogdGhpbmtpbmdJbmRleCxcblx0XHRcdFx0XHRkZWx0YTogZGVsdGEucmVhc29uaW5nQ29udGVudC50ZXh0LFxuXHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0XHRpZiAoZGVsdGEucmVhc29uaW5nQ29udGVudC5zaWduYXR1cmUpIHtcblx0XHRcdFx0dGhpbmtpbmdCbG9jay50aGlua2luZ1NpZ25hdHVyZSA9XG5cdFx0XHRcdFx0KHRoaW5raW5nQmxvY2sudGhpbmtpbmdTaWduYXR1cmUgfHwgXCJcIikgKyBkZWx0YS5yZWFzb25pbmdDb250ZW50LnNpZ25hdHVyZTtcblx0XHRcdH1cblx0XHR9XG5cdH1cbn1cblxuLyoqIEhhbmRsZSBhIGBtZXRhZGF0YWAgZXZlbnQsIHVwZGF0aW5nIHRva2VuLXVzYWdlIGNvdW50ZXJzIGFuZCBjb3N0IG9uIHRoZSBvdXRwdXQgbWVzc2FnZS4gKi9cbmZ1bmN0aW9uIGhhbmRsZU1ldGFkYXRhKFxuXHRldmVudDogQ29udmVyc2VTdHJlYW1NZXRhZGF0YUV2ZW50LFxuXHRtb2RlbDogTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0b3V0cHV0OiBBc3Npc3RhbnRNZXNzYWdlLFxuKTogdm9pZCB7XG5cdGlmIChldmVudC51c2FnZSkge1xuXHRcdG91dHB1dC51c2FnZS5pbnB1dCA9IGV2ZW50LnVzYWdlLmlucHV0VG9rZW5zIHx8IDA7XG5cdFx0b3V0cHV0LnVzYWdlLm91dHB1dCA9IGV2ZW50LnVzYWdlLm91dHB1dFRva2VucyB8fCAwO1xuXHRcdG91dHB1dC51c2FnZS5jYWNoZVJlYWQgPSBldmVudC51c2FnZS5jYWNoZVJlYWRJbnB1dFRva2VucyB8fCAwO1xuXHRcdG91dHB1dC51c2FnZS5jYWNoZVdyaXRlID0gZXZlbnQudXNhZ2UuY2FjaGVXcml0ZUlucHV0VG9rZW5zIHx8IDA7XG5cdFx0b3V0cHV0LnVzYWdlLnRvdGFsVG9rZW5zID0gZXZlbnQudXNhZ2UudG90YWxUb2tlbnMgfHwgb3V0cHV0LnVzYWdlLmlucHV0ICsgb3V0cHV0LnVzYWdlLm91dHB1dDtcblx0XHRjYWxjdWxhdGVDb3N0KG1vZGVsLCBvdXRwdXQudXNhZ2UpO1xuXHR9XG59XG5cbi8qKiBIYW5kbGUgYSBgY29udGVudEJsb2NrU3RvcGAgZXZlbnQsIGZpbmFsaXNpbmcgdGhlIGJsb2NrIGFuZCBwdXNoaW5nIHRoZSBhcHByb3ByaWF0ZSBjb21wbGV0aW9uIGV2ZW50LiAqL1xuZnVuY3Rpb24gaGFuZGxlQ29udGVudEJsb2NrU3RvcChcblx0ZXZlbnQ6IENvbnRlbnRCbG9ja1N0b3BFdmVudCxcblx0YmxvY2tzOiBCbG9ja1tdLFxuXHRvdXRwdXQ6IEFzc2lzdGFudE1lc3NhZ2UsXG5cdHN0cmVhbTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtLFxuKTogdm9pZCB7XG5cdGNvbnN0IGluZGV4ID0gYmxvY2tzLmZpbmRJbmRleCgoYikgPT4gYi5pbmRleCA9PT0gZXZlbnQuY29udGVudEJsb2NrSW5kZXgpO1xuXHRjb25zdCBibG9jayA9IGJsb2Nrc1tpbmRleF07XG5cdGlmICghYmxvY2spIHJldHVybjtcblx0ZGVsZXRlIChibG9jayBhcyBCbG9jaykuaW5kZXg7XG5cblx0c3dpdGNoIChibG9jay50eXBlKSB7XG5cdFx0Y2FzZSBcInRleHRcIjpcblx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0ZXh0X2VuZFwiLCBjb250ZW50SW5kZXg6IGluZGV4LCBjb250ZW50OiBibG9jay50ZXh0LCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHRicmVhaztcblx0XHRjYXNlIFwidGhpbmtpbmdcIjpcblx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0aGlua2luZ19lbmRcIiwgY29udGVudEluZGV4OiBpbmRleCwgY29udGVudDogYmxvY2sudGhpbmtpbmcsIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHRcdGJyZWFrO1xuXHRcdGNhc2UgXCJ0b29sQ2FsbFwiOlxuXHRcdFx0YmxvY2suYXJndW1lbnRzID0gcGFyc2VTdHJlYW1pbmdKc29uKGJsb2NrLnBhcnRpYWxKc29uKTtcblx0XHRcdGRlbGV0ZSAoYmxvY2sgYXMgQmxvY2spLnBhcnRpYWxKc29uO1xuXHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInRvb2xjYWxsX2VuZFwiLCBjb250ZW50SW5kZXg6IGluZGV4LCB0b29sQ2FsbDogYmxvY2ssIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHRcdGJyZWFrO1xuXHR9XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgdGhlIG1vZGVsIHN1cHBvcnRzIGFkYXB0aXZlIHRoaW5raW5nIChPcHVzIDQuNi80LjcsIFNvbm5ldCA0LjYvNC43LCBIYWlrdSA0LjUpLlxuICogQGludGVybmFsIGV4cG9ydGVkIGZvciB0ZXN0aW5nIG9ubHlcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1cHBvcnRzQWRhcHRpdmVUaGlua2luZyhtb2RlbElkOiBzdHJpbmcpOiBib29sZWFuIHtcblx0cmV0dXJuIChcblx0XHRtb2RlbElkLmluY2x1ZGVzKFwib3B1cy00LTZcIikgfHxcblx0XHRtb2RlbElkLmluY2x1ZGVzKFwib3B1cy00LjZcIikgfHxcblx0XHRtb2RlbElkLmluY2x1ZGVzKFwib3B1cy00LTdcIikgfHxcblx0XHRtb2RlbElkLmluY2x1ZGVzKFwib3B1cy00LjdcIikgfHxcblx0XHRtb2RlbElkLmluY2x1ZGVzKFwic29ubmV0LTQtNlwiKSB8fFxuXHRcdG1vZGVsSWQuaW5jbHVkZXMoXCJzb25uZXQtNC42XCIpIHx8XG5cdFx0bW9kZWxJZC5pbmNsdWRlcyhcInNvbm5ldC00LTdcIikgfHxcblx0XHRtb2RlbElkLmluY2x1ZGVzKFwic29ubmV0LTQuN1wiKSB8fFxuXHRcdG1vZGVsSWQuaW5jbHVkZXMoXCJoYWlrdS00LTVcIikgfHxcblx0XHRtb2RlbElkLmluY2x1ZGVzKFwiaGFpa3UtNC41XCIpXG5cdCk7XG59XG5cbi8qKlxuICogTWFwcyBhIHJlYXNvbmluZy90aGlua2luZyBsZXZlbCB0byB0aGUgQmVkcm9jayBlZmZvcnQgc3RyaW5nIGZvciB0aGUgZ2l2ZW4gbW9kZWwuXG4gKiBSZXR1cm5zIGBcInhoaWdoXCJgIGZvciA0LjcrIG1vZGVscyBhbmQgYFwibWF4XCJgIGZvciBvbGRlciBvbmVzOyBgXCJsb3dcImAgZm9yIG1pbmltYWwvbG93LlxuICogQGludGVybmFsIGV4cG9ydGVkIGZvciB0ZXN0aW5nIG9ubHlcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hcFRoaW5raW5nTGV2ZWxUb0VmZm9ydChcblx0bGV2ZWw6IFNpbXBsZVN0cmVhbU9wdGlvbnNbXCJyZWFzb25pbmdcIl0sXG5cdG1vZGVsSWQ6IHN0cmluZyxcbik6IFwibG93XCIgfCBcIm1lZGl1bVwiIHwgXCJoaWdoXCIgfCBcInhoaWdoXCIgfCBcIm1heFwiIHtcblx0c3dpdGNoIChsZXZlbCkge1xuXHRcdGNhc2UgXCJtaW5pbWFsXCI6XG5cdFx0Y2FzZSBcImxvd1wiOlxuXHRcdFx0cmV0dXJuIFwibG93XCI7XG5cdFx0Y2FzZSBcIm1lZGl1bVwiOlxuXHRcdFx0cmV0dXJuIFwibWVkaXVtXCI7XG5cdFx0Y2FzZSBcImhpZ2hcIjpcblx0XHRcdHJldHVybiBcImhpZ2hcIjtcblx0XHRjYXNlIFwieGhpZ2hcIjpcblx0XHRcdGlmIChtb2RlbElkLmluY2x1ZGVzKFwib3B1cy00LTdcIikgfHwgbW9kZWxJZC5pbmNsdWRlcyhcIm9wdXMtNC43XCIpKSByZXR1cm4gXCJ4aGlnaFwiO1xuXHRcdFx0aWYgKG1vZGVsSWQuaW5jbHVkZXMoXCJvcHVzLTQtNlwiKSB8fCBtb2RlbElkLmluY2x1ZGVzKFwib3B1cy00LjZcIikpIHJldHVybiBcIm1heFwiO1xuXHRcdFx0cmV0dXJuIFwiaGlnaFwiO1xuXHRcdGRlZmF1bHQ6XG5cdFx0XHRyZXR1cm4gXCJoaWdoXCI7XG5cdH1cbn1cblxuLyoqXG4gKiBSZXNvbHZlIGNhY2hlIHJldGVudGlvbiBwcmVmZXJlbmNlLlxuICogRGVmYXVsdHMgdG8gXCJzaG9ydFwiIGFuZCB1c2VzIFBJX0NBQ0hFX1JFVEVOVElPTiBmb3IgYmFja3dhcmQgY29tcGF0aWJpbGl0eS5cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZUNhY2hlUmV0ZW50aW9uKGNhY2hlUmV0ZW50aW9uPzogQ2FjaGVSZXRlbnRpb24pOiBDYWNoZVJldGVudGlvbiB7XG5cdGlmIChjYWNoZVJldGVudGlvbikge1xuXHRcdHJldHVybiBjYWNoZVJldGVudGlvbjtcblx0fVxuXHRpZiAodHlwZW9mIHByb2Nlc3MgIT09IFwidW5kZWZpbmVkXCIgJiYgcHJvY2Vzcy5lbnYuUElfQ0FDSEVfUkVURU5USU9OID09PSBcImxvbmdcIikge1xuXHRcdHJldHVybiBcImxvbmdcIjtcblx0fVxuXHRyZXR1cm4gXCJzaG9ydFwiO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIHRoZSBtb2RlbCBzdXBwb3J0cyBwcm9tcHQgY2FjaGluZy5cbiAqIFN1cHBvcnRlZDogQ2xhdWRlIDMuNSBIYWlrdSwgQ2xhdWRlIDMuNyBTb25uZXQsIENsYXVkZSA0LnggbW9kZWxzXG4gKi9cbmZ1bmN0aW9uIHN1cHBvcnRzUHJvbXB0Q2FjaGluZyhtb2RlbDogTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPik6IGJvb2xlYW4ge1xuXHRpZiAobW9kZWwuY29zdC5jYWNoZVJlYWQgfHwgbW9kZWwuY29zdC5jYWNoZVdyaXRlKSB7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblxuXHRjb25zdCBpZCA9IG1vZGVsLmlkLnRvTG93ZXJDYXNlKCk7XG5cdC8vIENsYXVkZSA0LnggbW9kZWxzIChvcHVzLTQsIHNvbm5ldC00LCBoYWlrdS00KVxuXHRpZiAoaWQuaW5jbHVkZXMoXCJjbGF1ZGVcIikgJiYgKGlkLmluY2x1ZGVzKFwiLTQtXCIpIHx8IGlkLmluY2x1ZGVzKFwiLTQuXCIpKSkgcmV0dXJuIHRydWU7XG5cdC8vIENsYXVkZSAzLjcgU29ubmV0XG5cdGlmIChpZC5pbmNsdWRlcyhcImNsYXVkZS0zLTctc29ubmV0XCIpKSByZXR1cm4gdHJ1ZTtcblx0Ly8gQ2xhdWRlIDMuNSBIYWlrdVxuXHRpZiAoaWQuaW5jbHVkZXMoXCJjbGF1ZGUtMy01LWhhaWt1XCIpKSByZXR1cm4gdHJ1ZTtcblx0cmV0dXJuIGZhbHNlO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIHRoZSBtb2RlbCBzdXBwb3J0cyB0aGlua2luZyBzaWduYXR1cmVzIGluIHJlYXNvbmluZ0NvbnRlbnQuXG4gKiBPbmx5IEFudGhyb3BpYyBDbGF1ZGUgbW9kZWxzIHN1cHBvcnQgdGhlIHNpZ25hdHVyZSBmaWVsZC5cbiAqIE90aGVyIG1vZGVscyAoT3BlbkFJLCBRd2VuLCBNaW5pbWF4LCBNb29uc2hvdCwgZXRjLikgcmVqZWN0IGl0IHdpdGg6XG4gKiBcIlRoaXMgbW9kZWwgZG9lc24ndCBzdXBwb3J0IHRoZSByZWFzb25pbmdDb250ZW50LnJlYXNvbmluZ1RleHQuc2lnbmF0dXJlIGZpZWxkXCJcbiAqL1xuZnVuY3Rpb24gc3VwcG9ydHNUaGlua2luZ1NpZ25hdHVyZShtb2RlbDogTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPik6IGJvb2xlYW4ge1xuXHRjb25zdCBpZCA9IG1vZGVsLmlkLnRvTG93ZXJDYXNlKCk7XG5cdHJldHVybiBpZC5pbmNsdWRlcyhcImFudGhyb3BpYy5jbGF1ZGVcIikgfHwgaWQuaW5jbHVkZXMoXCJhbnRocm9waWMvY2xhdWRlXCIpO1xufVxuXG4vKiogQnVpbGQgdGhlIEJlZHJvY2sgc3lzdGVtLXByb21wdCBibG9jayBhcnJheSwgYXBwZW5kaW5nIGEgY2FjaGUgcG9pbnQgZm9yIHN1cHBvcnRlZCBtb2RlbHMgd2hlbiBjYWNoaW5nIGlzIGVuYWJsZWQuICovXG5mdW5jdGlvbiBidWlsZFN5c3RlbVByb21wdChcblx0c3lzdGVtUHJvbXB0OiBzdHJpbmcgfCB1bmRlZmluZWQsXG5cdG1vZGVsOiBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRjYWNoZVJldGVudGlvbjogQ2FjaGVSZXRlbnRpb24sXG4pOiBTeXN0ZW1Db250ZW50QmxvY2tbXSB8IHVuZGVmaW5lZCB7XG5cdGlmICghc3lzdGVtUHJvbXB0KSByZXR1cm4gdW5kZWZpbmVkO1xuXG5cdGNvbnN0IGJsb2NrczogU3lzdGVtQ29udGVudEJsb2NrW10gPSBbeyB0ZXh0OiBzYW5pdGl6ZVN1cnJvZ2F0ZXMoc3lzdGVtUHJvbXB0KSB9XTtcblxuXHQvLyBBZGQgY2FjaGUgcG9pbnQgZm9yIHN1cHBvcnRlZCBDbGF1ZGUgbW9kZWxzIHdoZW4gY2FjaGluZyBpcyBlbmFibGVkXG5cdGlmIChjYWNoZVJldGVudGlvbiAhPT0gXCJub25lXCIgJiYgc3VwcG9ydHNQcm9tcHRDYWNoaW5nKG1vZGVsKSkge1xuXHRcdGJsb2Nrcy5wdXNoKHtcblx0XHRcdGNhY2hlUG9pbnQ6IHsgdHlwZTogQ2FjaGVQb2ludFR5cGUuREVGQVVMVCwgLi4uKGNhY2hlUmV0ZW50aW9uID09PSBcImxvbmdcIiA/IHsgdHRsOiBDYWNoZVRUTC5PTkVfSE9VUiB9IDoge30pIH0sXG5cdFx0fSk7XG5cdH1cblxuXHRyZXR1cm4gYmxvY2tzO1xufVxuXG4vKiogU2FuaXRpc2UgYSB0b29sLWNhbGwgSUQgdG8gYWxwaGFudW1lcmljLCB1bmRlcnNjb3JlLCBhbmQgaHlwaGVuIGNoYXJhY3RlcnMgKG1heCA2NCBjaGFycykgZm9yIEJlZHJvY2sgY29tcGF0aWJpbGl0eS4gKi9cbmZ1bmN0aW9uIG5vcm1hbGl6ZVRvb2xDYWxsSWQoaWQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdGNvbnN0IHNhbml0aXplZCA9IGlkLnJlcGxhY2UoL1teYS16QS1aMC05Xy1dL2csIFwiX1wiKTtcblx0cmV0dXJuIHNhbml0aXplZC5sZW5ndGggPiA2NCA/IHNhbml0aXplZC5zbGljZSgwLCA2NCkgOiBzYW5pdGl6ZWQ7XG59XG5cbi8qKiBDb252ZXJ0IEdTRCBjb250ZXh0IG1lc3NhZ2VzIHRvIHRoZSBCZWRyb2NrIGBNZXNzYWdlW11gIGZvcm1hdCwgY29sbGFwc2luZyBjb25zZWN1dGl2ZSB0b29sLXJlc3VsdCB0dXJucyBpbnRvIGEgc2luZ2xlIHVzZXIgbWVzc2FnZS4gKi9cbmZ1bmN0aW9uIGNvbnZlcnRNZXNzYWdlcyhcblx0Y29udGV4dDogQ29udGV4dCxcblx0bW9kZWw6IE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdGNhY2hlUmV0ZW50aW9uOiBDYWNoZVJldGVudGlvbixcbik6IE1lc3NhZ2VbXSB7XG5cdGNvbnN0IHJlc3VsdDogTWVzc2FnZVtdID0gW107XG5cdGNvbnN0IHRyYW5zZm9ybWVkTWVzc2FnZXMgPSB0cmFuc2Zvcm1NZXNzYWdlc1dpdGhSZXBvcnQoY29udGV4dC5tZXNzYWdlcywgbW9kZWwsIG5vcm1hbGl6ZVRvb2xDYWxsSWQsIFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIik7XG5cblx0Zm9yIChsZXQgaSA9IDA7IGkgPCB0cmFuc2Zvcm1lZE1lc3NhZ2VzLmxlbmd0aDsgaSsrKSB7XG5cdFx0Y29uc3QgbSA9IHRyYW5zZm9ybWVkTWVzc2FnZXNbaV07XG5cblx0XHRzd2l0Y2ggKG0ucm9sZSkge1xuXHRcdFx0Y2FzZSBcInVzZXJcIjpcblx0XHRcdFx0cmVzdWx0LnB1c2goe1xuXHRcdFx0XHRcdHJvbGU6IENvbnZlcnNhdGlvblJvbGUuVVNFUixcblx0XHRcdFx0XHRjb250ZW50OlxuXHRcdFx0XHRcdFx0dHlwZW9mIG0uY29udGVudCA9PT0gXCJzdHJpbmdcIlxuXHRcdFx0XHRcdFx0XHQ/IFt7IHRleHQ6IHNhbml0aXplU3Vycm9nYXRlcyhtLmNvbnRlbnQpIH1dXG5cdFx0XHRcdFx0XHRcdDogbS5jb250ZW50Lm1hcCgoYykgPT4ge1xuXHRcdFx0XHRcdFx0XHRcdFx0c3dpdGNoIChjLnR5cGUpIHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0Y2FzZSBcInRleHRcIjpcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRyZXR1cm4geyB0ZXh0OiBzYW5pdGl6ZVN1cnJvZ2F0ZXMoYy50ZXh0KSB9O1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRjYXNlIFwiaW1hZ2VcIjpcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRyZXR1cm4geyBpbWFnZTogY3JlYXRlSW1hZ2VCbG9jayhjLm1pbWVUeXBlLCBjLmRhdGEpIH07XG5cdFx0XHRcdFx0XHRcdFx0XHRcdGRlZmF1bHQ6XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiVW5rbm93biB1c2VyIGNvbnRlbnQgdHlwZVwiKTtcblx0XHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHR9KSxcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0Y2FzZSBcImFzc2lzdGFudFwiOiB7XG5cdFx0XHRcdC8vIFNraXAgYXNzaXN0YW50IG1lc3NhZ2VzIHdpdGggZW1wdHkgY29udGVudCAoZS5nLiwgZnJvbSBhYm9ydGVkIHJlcXVlc3RzKVxuXHRcdFx0XHQvLyBCZWRyb2NrIHJlamVjdHMgbWVzc2FnZXMgd2l0aCBlbXB0eSBjb250ZW50IGFycmF5c1xuXHRcdFx0XHRpZiAobS5jb250ZW50Lmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnRCbG9ja3M6IENvbnRlbnRCbG9ja1tdID0gW107XG5cdFx0XHRcdGZvciAoY29uc3QgYyBvZiBtLmNvbnRlbnQpIHtcblx0XHRcdFx0XHRzd2l0Y2ggKGMudHlwZSkge1xuXHRcdFx0XHRcdFx0Y2FzZSBcInRleHRcIjpcblx0XHRcdFx0XHRcdFx0Ly8gU2tpcCBlbXB0eSB0ZXh0IGJsb2Nrc1xuXHRcdFx0XHRcdFx0XHRpZiAoYy50ZXh0LnRyaW0oKS5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuXHRcdFx0XHRcdFx0XHRjb250ZW50QmxvY2tzLnB1c2goeyB0ZXh0OiBzYW5pdGl6ZVN1cnJvZ2F0ZXMoYy50ZXh0KSB9KTtcblx0XHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0XHRjYXNlIFwidG9vbENhbGxcIjpcblx0XHRcdFx0XHRcdFx0Y29udGVudEJsb2Nrcy5wdXNoKHtcblx0XHRcdFx0XHRcdFx0XHR0b29sVXNlOiB7IHRvb2xVc2VJZDogYy5pZCwgbmFtZTogYy5uYW1lLCBpbnB1dDogYy5hcmd1bWVudHMgfSxcblx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0Y2FzZSBcInRoaW5raW5nXCI6XG5cdFx0XHRcdFx0XHRcdC8vIFNraXAgZW1wdHkgdGhpbmtpbmcgYmxvY2tzXG5cdFx0XHRcdFx0XHRcdGlmIChjLnRoaW5raW5nLnRyaW0oKS5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuXHRcdFx0XHRcdFx0XHQvLyBPbmx5IEFudGhyb3BpYyBtb2RlbHMgc3VwcG9ydCB0aGUgc2lnbmF0dXJlIGZpZWxkIGluIHJlYXNvbmluZ1RleHQuXG5cdFx0XHRcdFx0XHRcdC8vIEZvciBvdGhlciBtb2RlbHMsIHdlIG9taXQgdGhlIHNpZ25hdHVyZSB0byBhdm9pZCBlcnJvcnMgbGlrZTpcblx0XHRcdFx0XHRcdFx0Ly8gXCJUaGlzIG1vZGVsIGRvZXNuJ3Qgc3VwcG9ydCB0aGUgcmVhc29uaW5nQ29udGVudC5yZWFzb25pbmdUZXh0LnNpZ25hdHVyZSBmaWVsZFwiXG5cdFx0XHRcdFx0XHRcdGlmIChzdXBwb3J0c1RoaW5raW5nU2lnbmF0dXJlKG1vZGVsKSkge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnRlbnRCbG9ja3MucHVzaCh7XG5cdFx0XHRcdFx0XHRcdFx0XHRyZWFzb25pbmdDb250ZW50OiB7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdHJlYXNvbmluZ1RleHQ6IHsgdGV4dDogc2FuaXRpemVTdXJyb2dhdGVzKGMudGhpbmtpbmcpLCBzaWduYXR1cmU6IGMudGhpbmtpbmdTaWduYXR1cmUgfSxcblx0XHRcdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0Y29udGVudEJsb2Nrcy5wdXNoKHtcblx0XHRcdFx0XHRcdFx0XHRcdHJlYXNvbmluZ0NvbnRlbnQ6IHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0cmVhc29uaW5nVGV4dDogeyB0ZXh0OiBzYW5pdGl6ZVN1cnJvZ2F0ZXMoYy50aGlua2luZykgfSxcblx0XHRcdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0XHRkZWZhdWx0OlxuXHRcdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJVbmtub3duIGFzc2lzdGFudCBjb250ZW50IHR5cGVcIik7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIFNraXAgaWYgYWxsIGNvbnRlbnQgYmxvY2tzIHdlcmUgZmlsdGVyZWQgb3V0XG5cdFx0XHRcdGlmIChjb250ZW50QmxvY2tzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJlc3VsdC5wdXNoKHtcblx0XHRcdFx0XHRyb2xlOiBDb252ZXJzYXRpb25Sb2xlLkFTU0lTVEFOVCxcblx0XHRcdFx0XHRjb250ZW50OiBjb250ZW50QmxvY2tzLFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cdFx0XHRjYXNlIFwidG9vbFJlc3VsdFwiOiB7XG5cdFx0XHRcdC8vIENvbGxlY3QgYWxsIGNvbnNlY3V0aXZlIHRvb2xSZXN1bHQgbWVzc2FnZXMgaW50byBhIHNpbmdsZSB1c2VyIG1lc3NhZ2Vcblx0XHRcdFx0Ly8gQmVkcm9jayByZXF1aXJlcyBhbGwgdG9vbCByZXN1bHRzIHRvIGJlIGluIG9uZSBtZXNzYWdlXG5cdFx0XHRcdGNvbnN0IHRvb2xSZXN1bHRzOiBDb250ZW50QmxvY2suVG9vbFJlc3VsdE1lbWJlcltdID0gW107XG5cblx0XHRcdFx0Ly8gQWRkIGN1cnJlbnQgdG9vbCByZXN1bHQgd2l0aCBhbGwgY29udGVudCBibG9ja3MgY29tYmluZWRcblx0XHRcdFx0dG9vbFJlc3VsdHMucHVzaCh7XG5cdFx0XHRcdFx0dG9vbFJlc3VsdDoge1xuXHRcdFx0XHRcdFx0dG9vbFVzZUlkOiBtLnRvb2xDYWxsSWQsXG5cdFx0XHRcdFx0XHRjb250ZW50OiBtLmNvbnRlbnQubWFwKChjKSA9PlxuXHRcdFx0XHRcdFx0XHRjLnR5cGUgPT09IFwiaW1hZ2VcIlxuXHRcdFx0XHRcdFx0XHRcdD8geyBpbWFnZTogY3JlYXRlSW1hZ2VCbG9jayhjLm1pbWVUeXBlLCBjLmRhdGEpIH1cblx0XHRcdFx0XHRcdFx0XHQ6IHsgdGV4dDogc2FuaXRpemVTdXJyb2dhdGVzKGMudGV4dCkgfSxcblx0XHRcdFx0XHRcdCksXG5cdFx0XHRcdFx0XHRzdGF0dXM6IG0uaXNFcnJvciA/IFRvb2xSZXN1bHRTdGF0dXMuRVJST1IgOiBUb29sUmVzdWx0U3RhdHVzLlNVQ0NFU1MsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0Ly8gTG9vayBhaGVhZCBmb3IgY29uc2VjdXRpdmUgdG9vbFJlc3VsdCBtZXNzYWdlc1xuXHRcdFx0XHRsZXQgaiA9IGkgKyAxO1xuXHRcdFx0XHR3aGlsZSAoaiA8IHRyYW5zZm9ybWVkTWVzc2FnZXMubGVuZ3RoICYmIHRyYW5zZm9ybWVkTWVzc2FnZXNbal0ucm9sZSA9PT0gXCJ0b29sUmVzdWx0XCIpIHtcblx0XHRcdFx0XHRjb25zdCBuZXh0TXNnID0gdHJhbnNmb3JtZWRNZXNzYWdlc1tqXSBhcyBUb29sUmVzdWx0TWVzc2FnZTtcblx0XHRcdFx0XHR0b29sUmVzdWx0cy5wdXNoKHtcblx0XHRcdFx0XHRcdHRvb2xSZXN1bHQ6IHtcblx0XHRcdFx0XHRcdFx0dG9vbFVzZUlkOiBuZXh0TXNnLnRvb2xDYWxsSWQsXG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IG5leHRNc2cuY29udGVudC5tYXAoKGMpID0+XG5cdFx0XHRcdFx0XHRcdFx0Yy50eXBlID09PSBcImltYWdlXCJcblx0XHRcdFx0XHRcdFx0XHRcdD8geyBpbWFnZTogY3JlYXRlSW1hZ2VCbG9jayhjLm1pbWVUeXBlLCBjLmRhdGEpIH1cblx0XHRcdFx0XHRcdFx0XHRcdDogeyB0ZXh0OiBzYW5pdGl6ZVN1cnJvZ2F0ZXMoYy50ZXh0KSB9LFxuXHRcdFx0XHRcdFx0XHQpLFxuXHRcdFx0XHRcdFx0XHRzdGF0dXM6IG5leHRNc2cuaXNFcnJvciA/IFRvb2xSZXN1bHRTdGF0dXMuRVJST1IgOiBUb29sUmVzdWx0U3RhdHVzLlNVQ0NFU1MsXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdGorKztcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIFNraXAgdGhlIG1lc3NhZ2VzIHdlJ3ZlIGFscmVhZHkgcHJvY2Vzc2VkXG5cdFx0XHRcdGkgPSBqIC0gMTtcblxuXHRcdFx0XHRyZXN1bHQucHVzaCh7XG5cdFx0XHRcdFx0cm9sZTogQ29udmVyc2F0aW9uUm9sZS5VU0VSLFxuXHRcdFx0XHRcdGNvbnRlbnQ6IHRvb2xSZXN1bHRzLFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cdFx0XHRkZWZhdWx0OlxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJVbmtub3duIG1lc3NhZ2Ugcm9sZVwiKTtcblx0XHR9XG5cdH1cblxuXHQvLyBBZGQgY2FjaGUgcG9pbnQgdG8gdGhlIGxhc3QgdXNlciBtZXNzYWdlIGZvciBzdXBwb3J0ZWQgQ2xhdWRlIG1vZGVscyB3aGVuIGNhY2hpbmcgaXMgZW5hYmxlZFxuXHRpZiAoY2FjaGVSZXRlbnRpb24gIT09IFwibm9uZVwiICYmIHN1cHBvcnRzUHJvbXB0Q2FjaGluZyhtb2RlbCkgJiYgcmVzdWx0Lmxlbmd0aCA+IDApIHtcblx0XHRjb25zdCBsYXN0TWVzc2FnZSA9IHJlc3VsdFtyZXN1bHQubGVuZ3RoIC0gMV07XG5cdFx0aWYgKGxhc3RNZXNzYWdlLnJvbGUgPT09IENvbnZlcnNhdGlvblJvbGUuVVNFUiAmJiBsYXN0TWVzc2FnZS5jb250ZW50KSB7XG5cdFx0XHQobGFzdE1lc3NhZ2UuY29udGVudCBhcyBDb250ZW50QmxvY2tbXSkucHVzaCh7XG5cdFx0XHRcdGNhY2hlUG9pbnQ6IHtcblx0XHRcdFx0XHR0eXBlOiBDYWNoZVBvaW50VHlwZS5ERUZBVUxULFxuXHRcdFx0XHRcdC4uLihjYWNoZVJldGVudGlvbiA9PT0gXCJsb25nXCIgPyB7IHR0bDogQ2FjaGVUVEwuT05FX0hPVVIgfSA6IHt9KSxcblx0XHRcdFx0fSxcblx0XHRcdH0pO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiByZXN1bHQ7XG59XG5cbi8qKiBDb252ZXJ0IEdTRCB0b29sIGRlZmluaXRpb25zIGFuZCB0b29sLWNob2ljZSBwcmVmZXJlbmNlIHRvIGEgQmVkcm9jayBgVG9vbENvbmZpZ3VyYXRpb25gLCBhcHBlbmRpbmcgYSBjYWNoZSBwb2ludCBmb3Igc3VwcG9ydGVkIG1vZGVscy4gKi9cbmZ1bmN0aW9uIGNvbnZlcnRUb29sQ29uZmlnKFxuXHR0b29sczogVG9vbFtdIHwgdW5kZWZpbmVkLFxuXHR0b29sQ2hvaWNlOiBCZWRyb2NrT3B0aW9uc1tcInRvb2xDaG9pY2VcIl0sXG5cdG1vZGVsOiBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRjYWNoZVJldGVudGlvbjogQ2FjaGVSZXRlbnRpb24sXG4pOiBUb29sQ29uZmlndXJhdGlvbiB8IHVuZGVmaW5lZCB7XG5cdGlmICghdG9vbHM/Lmxlbmd0aCB8fCB0b29sQ2hvaWNlID09PSBcIm5vbmVcIikgcmV0dXJuIHVuZGVmaW5lZDtcblxuXHRjb25zdCBiZWRyb2NrVG9vbHM6IEJlZHJvY2tUb29sW10gPSB0b29scy5tYXAoKHRvb2wpID0+ICh7XG5cdFx0dG9vbFNwZWM6IHtcblx0XHRcdG5hbWU6IHRvb2wubmFtZSxcblx0XHRcdGRlc2NyaXB0aW9uOiB0b29sLmRlc2NyaXB0aW9uLFxuXHRcdFx0aW5wdXRTY2hlbWE6IHsganNvbjogdG9vbC5wYXJhbWV0ZXJzIH0sXG5cdFx0fSxcblx0fSkpO1xuXG5cdC8vIEFkZCBjYWNoZVBvaW50IGFmdGVyIGxhc3QgdG9vbCBmb3Igc3VwcG9ydGVkIG1vZGVsc1xuXHRpZiAoY2FjaGVSZXRlbnRpb24gIT09IFwibm9uZVwiICYmIHN1cHBvcnRzUHJvbXB0Q2FjaGluZyhtb2RlbCkpIHtcblx0XHRiZWRyb2NrVG9vbHMucHVzaCh7XG5cdFx0XHRjYWNoZVBvaW50OiB7XG5cdFx0XHRcdHR5cGU6IENhY2hlUG9pbnRUeXBlLkRFRkFVTFQsXG5cdFx0XHRcdC4uLihjYWNoZVJldGVudGlvbiA9PT0gXCJsb25nXCIgPyB7IHR0bDogQ2FjaGVUVEwuT05FX0hPVVIgfSA6IHt9KSxcblx0XHRcdH0sXG5cdFx0fSBhcyBhbnkpO1xuXHR9XG5cblx0bGV0IGJlZHJvY2tUb29sQ2hvaWNlOiBUb29sQ2hvaWNlIHwgdW5kZWZpbmVkO1xuXHRzd2l0Y2ggKHRvb2xDaG9pY2UpIHtcblx0XHRjYXNlIFwiYXV0b1wiOlxuXHRcdFx0YmVkcm9ja1Rvb2xDaG9pY2UgPSB7IGF1dG86IHt9IH07XG5cdFx0XHRicmVhaztcblx0XHRjYXNlIFwiYW55XCI6XG5cdFx0XHRiZWRyb2NrVG9vbENob2ljZSA9IHsgYW55OiB7fSB9O1xuXHRcdFx0YnJlYWs7XG5cdFx0ZGVmYXVsdDpcblx0XHRcdGlmICh0b29sQ2hvaWNlPy50eXBlID09PSBcInRvb2xcIikge1xuXHRcdFx0XHRiZWRyb2NrVG9vbENob2ljZSA9IHsgdG9vbDogeyBuYW1lOiB0b29sQ2hvaWNlLm5hbWUgfSB9O1xuXHRcdFx0fVxuXHR9XG5cblx0cmV0dXJuIHsgdG9vbHM6IGJlZHJvY2tUb29scywgdG9vbENob2ljZTogYmVkcm9ja1Rvb2xDaG9pY2UgfTtcbn1cblxuLyoqIE1hcCBhIEJlZHJvY2sgc3RvcC1yZWFzb24gc3RyaW5nIHRvIEdTRCdzIGludGVybmFsIGBTdG9wUmVhc29uYC4gKi9cbmZ1bmN0aW9uIG1hcFN0b3BSZWFzb24ocmVhc29uOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBTdG9wUmVhc29uIHtcblx0c3dpdGNoIChyZWFzb24pIHtcblx0XHRjYXNlIEJlZHJvY2tTdG9wUmVhc29uLkVORF9UVVJOOlxuXHRcdGNhc2UgQmVkcm9ja1N0b3BSZWFzb24uU1RPUF9TRVFVRU5DRTpcblx0XHRcdHJldHVybiBcInN0b3BcIjtcblx0XHRjYXNlIEJlZHJvY2tTdG9wUmVhc29uLk1BWF9UT0tFTlM6XG5cdFx0Y2FzZSBCZWRyb2NrU3RvcFJlYXNvbi5NT0RFTF9DT05URVhUX1dJTkRPV19FWENFRURFRDpcblx0XHRcdHJldHVybiBcImxlbmd0aFwiO1xuXHRcdGNhc2UgQmVkcm9ja1N0b3BSZWFzb24uVE9PTF9VU0U6XG5cdFx0XHRyZXR1cm4gXCJ0b29sVXNlXCI7XG5cdFx0ZGVmYXVsdDpcblx0XHRcdHJldHVybiBcImVycm9yXCI7XG5cdH1cbn1cblxuLyoqXG4gKiBCdWlsZHMgdGhlIEJlZHJvY2sgYGFkZGl0aW9uYWxNb2RlbFJlcXVlc3RGaWVsZHNgIHBheWxvYWQgZm9yIENsYXVkZSBtb2RlbHMuXG4gKiBIYW5kbGVzIGFkYXB0aXZlIHZzLiBidWRnZXQtYmFzZWQgdGhpbmtpbmcsIGJldGEgZmxhZ3MsIGFuZCB4aGlnaC10by1tYXggY2xhbXBpbmdcbiAqIGZvciBtb2RlbHMgdGhhdCBsYWNrIG5hdGl2ZSB4aGlnaCBzdXBwb3J0LlxuICogQGludGVybmFsIGV4cG9ydGVkIGZvciB0ZXN0aW5nIG9ubHlcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkQWRkaXRpb25hbE1vZGVsUmVxdWVzdEZpZWxkcyhcblx0bW9kZWw6IE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdG9wdGlvbnM6IEJlZHJvY2tPcHRpb25zLFxuKTogUmVjb3JkPHN0cmluZywgYW55PiB8IHVuZGVmaW5lZCB7XG5cdGlmICghb3B0aW9ucy5yZWFzb25pbmcgfHwgIW1vZGVsLnJlYXNvbmluZykge1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1cblxuXHRpZiAobW9kZWwuaWQuaW5jbHVkZXMoXCJhbnRocm9waWMuY2xhdWRlXCIpIHx8IG1vZGVsLmlkLmluY2x1ZGVzKFwiYW50aHJvcGljL2NsYXVkZVwiKSkge1xuXHRcdGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgYW55PiA9IHN1cHBvcnRzQWRhcHRpdmVUaGlua2luZyhtb2RlbC5pZClcblx0XHRcdD8ge1xuXHRcdFx0XHRcdHRoaW5raW5nOiB7IHR5cGU6IFwiYWRhcHRpdmVcIiB9LFxuXHRcdFx0XHRcdG91dHB1dF9jb25maWc6IHsgZWZmb3J0OiBtYXBUaGlua2luZ0xldmVsVG9FZmZvcnQob3B0aW9ucy5yZWFzb25pbmcsIG1vZGVsLmlkKSB9LFxuXHRcdFx0XHR9XG5cdFx0XHQ6ICgoKSA9PiB7XG5cdFx0XHRcdFx0Y29uc3QgZGVmYXVsdEJ1ZGdldHM6IFJlY29yZDxUaGlua2luZ0xldmVsLCBudW1iZXI+ID0ge1xuXHRcdFx0XHRcdFx0bWluaW1hbDogMTAyNCxcblx0XHRcdFx0XHRcdGxvdzogMjA0OCxcblx0XHRcdFx0XHRcdG1lZGl1bTogODE5Mixcblx0XHRcdFx0XHRcdGhpZ2g6IDE2Mzg0LFxuXHRcdFx0XHRcdFx0eGhpZ2g6IDE2Mzg0LCAvLyBDbGF1ZGUgZG9lc24ndCBzdXBwb3J0IHhoaWdoLCBjbGFtcCB0byBoaWdoXG5cdFx0XHRcdFx0fTtcblxuXHRcdFx0XHRcdC8vIEN1c3RvbSBidWRnZXRzIG92ZXJyaWRlIGRlZmF1bHRzICh4aGlnaCBub3QgaW4gVGhpbmtpbmdCdWRnZXRzLCB1c2UgaGlnaClcblx0XHRcdFx0XHRjb25zdCBsZXZlbCA9IG9wdGlvbnMucmVhc29uaW5nID09PSBcInhoaWdoXCIgPyBcImhpZ2hcIiA6IG9wdGlvbnMucmVhc29uaW5nO1xuXHRcdFx0XHRcdGNvbnN0IGJ1ZGdldCA9IG9wdGlvbnMudGhpbmtpbmdCdWRnZXRzPy5bbGV2ZWxdID8/IGRlZmF1bHRCdWRnZXRzW29wdGlvbnMucmVhc29uaW5nXTtcblxuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHR0aGlua2luZzoge1xuXHRcdFx0XHRcdFx0XHR0eXBlOiBcImVuYWJsZWRcIixcblx0XHRcdFx0XHRcdFx0YnVkZ2V0X3Rva2VuczogYnVkZ2V0LFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9KSgpO1xuXG5cdFx0aWYgKCFzdXBwb3J0c0FkYXB0aXZlVGhpbmtpbmcobW9kZWwuaWQpICYmIChvcHRpb25zLmludGVybGVhdmVkVGhpbmtpbmcgPz8gdHJ1ZSkpIHtcblx0XHRcdHJlc3VsdC5hbnRocm9waWNfYmV0YSA9IFtcImludGVybGVhdmVkLXRoaW5raW5nLTIwMjUtMDUtMTRcIl07XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHJlc3VsdDtcblx0fVxuXG5cdHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKiBDb252ZXJ0IGEgYmFzZTY0LWVuY29kZWQgaW1hZ2UgdG8gYSBCZWRyb2NrIGltYWdlIGNvbnRlbnQgYmxvY2sgd2l0aCB0aGUgYXBwcm9wcmlhdGUgYEltYWdlRm9ybWF0YC4gKi9cbmZ1bmN0aW9uIGNyZWF0ZUltYWdlQmxvY2sobWltZVR5cGU6IHN0cmluZywgZGF0YTogc3RyaW5nKSB7XG5cdGxldCBmb3JtYXQ6IEltYWdlRm9ybWF0O1xuXHRzd2l0Y2ggKG1pbWVUeXBlKSB7XG5cdFx0Y2FzZSBcImltYWdlL2pwZWdcIjpcblx0XHRjYXNlIFwiaW1hZ2UvanBnXCI6XG5cdFx0XHRmb3JtYXQgPSBJbWFnZUZvcm1hdC5KUEVHO1xuXHRcdFx0YnJlYWs7XG5cdFx0Y2FzZSBcImltYWdlL3BuZ1wiOlxuXHRcdFx0Zm9ybWF0ID0gSW1hZ2VGb3JtYXQuUE5HO1xuXHRcdFx0YnJlYWs7XG5cdFx0Y2FzZSBcImltYWdlL2dpZlwiOlxuXHRcdFx0Zm9ybWF0ID0gSW1hZ2VGb3JtYXQuR0lGO1xuXHRcdFx0YnJlYWs7XG5cdFx0Y2FzZSBcImltYWdlL3dlYnBcIjpcblx0XHRcdGZvcm1hdCA9IEltYWdlRm9ybWF0LldFQlA7XG5cdFx0XHRicmVhaztcblx0XHRkZWZhdWx0OlxuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGBVbmtub3duIGltYWdlIHR5cGU6ICR7bWltZVR5cGV9YCk7XG5cdH1cblxuXHRjb25zdCBiaW5hcnlTdHJpbmcgPSBhdG9iKGRhdGEpO1xuXHRjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGJpbmFyeVN0cmluZy5sZW5ndGgpO1xuXHRmb3IgKGxldCBpID0gMDsgaSA8IGJpbmFyeVN0cmluZy5sZW5ndGg7IGkrKykge1xuXHRcdGJ5dGVzW2ldID0gYmluYXJ5U3RyaW5nLmNoYXJDb2RlQXQoaSk7XG5cdH1cblxuXHRyZXR1cm4geyBzb3VyY2U6IHsgYnl0ZXMgfSwgZm9ybWF0IH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQTtBQUFBLEVBQ0M7QUFBQSxFQUVBLGNBQWM7QUFBQSxFQUVkO0FBQUEsRUFDQTtBQUFBLEVBS0E7QUFBQSxFQUNBO0FBQUEsRUFFQTtBQUFBLEVBS0E7QUFBQSxPQUNNO0FBRVAsU0FBUyxxQkFBcUI7QUFtQjlCLFNBQVMsbUNBQW1DO0FBQzVDLFNBQVMsMEJBQTBCO0FBQ25DLFNBQVMsMEJBQTBCO0FBQ25DLFNBQVMsNEJBQTRCLGtCQUFrQixzQkFBc0I7QUFDN0UsU0FBUyxtQ0FBbUM7QUFtQnJDLE1BQU0sZ0JBQTJFLENBQ3ZGLE9BQ0EsU0FDQSxVQUEwQixDQUFDLE1BQ007QUFDakMsUUFBTSxTQUFTLElBQUksNEJBQTRCO0FBRS9DLEdBQUMsWUFBWTtBQUNaLFVBQU0sU0FBMkI7QUFBQSxNQUNoQyxNQUFNO0FBQUEsTUFDTixTQUFTLENBQUM7QUFBQSxNQUNWLEtBQUs7QUFBQSxNQUNMLFVBQVUsTUFBTTtBQUFBLE1BQ2hCLE9BQU8sTUFBTTtBQUFBLE1BQ2IsT0FBTztBQUFBLFFBQ04sT0FBTztBQUFBLFFBQ1AsUUFBUTtBQUFBLFFBQ1IsV0FBVztBQUFBLFFBQ1gsWUFBWTtBQUFBLFFBQ1osYUFBYTtBQUFBLFFBQ2IsTUFBTSxFQUFFLE9BQU8sR0FBRyxRQUFRLEdBQUcsV0FBVyxHQUFHLFlBQVksR0FBRyxPQUFPLEVBQUU7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
