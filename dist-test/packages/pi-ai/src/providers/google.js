let _GoogleGenAIClass;
async function getGoogleGenAIClass() {
  if (!_GoogleGenAIClass) {
    const mod = await import("@google/genai");
    _GoogleGenAIClass = mod.GoogleGenAI;
  }
  return _GoogleGenAIClass;
}
import { getEnvApiKey } from "../env-api-keys.js";
import { calculateCost } from "../models.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
  convertMessages,
  convertTools,
  isThinkingPart,
  mapStopReason,
  mapToolChoice,
  retainThoughtSignature
} from "./google-shared.js";
import { buildBaseOptions, clampReasoning } from "./simple-options.js";
let toolCallCounter = 0;
const streamGoogle = (model, context, options) => {
  const stream = new AssistantMessageEventStream();
  (async () => {
    const output = {
      role: "assistant",
      content: [],
      api: "google-generative-ai",
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
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      const client = await createClient(model, apiKey, options?.headers);
      let params = buildParams(model, context, options);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== void 0) {
        params = nextParams;
      }
      const googleStream = await client.models.generateContentStream(params);
      stream.push({ type: "start", partial: output });
      let currentBlock = null;
      const blocks = output.content;
      const blockIndex = () => blocks.length - 1;
      for await (const chunk of googleStream) {
        const candidate = chunk.candidates?.[0];
        if (candidate?.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.text !== void 0) {
              const isThinking = isThinkingPart(part);
              if (!currentBlock || isThinking && currentBlock.type !== "thinking" || !isThinking && currentBlock.type !== "text") {
                if (currentBlock) {
                  if (currentBlock.type === "text") {
                    stream.push({
                      type: "text_end",
                      contentIndex: blocks.length - 1,
                      content: currentBlock.text,
                      partial: output
                    });
                  } else {
                    stream.push({
                      type: "thinking_end",
                      contentIndex: blockIndex(),
                      content: currentBlock.thinking,
                      partial: output
                    });
                  }
                }
                if (isThinking) {
                  currentBlock = { type: "thinking", thinking: "", thinkingSignature: void 0 };
                  output.content.push(currentBlock);
                  stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
                } else {
                  currentBlock = { type: "text", text: "" };
                  output.content.push(currentBlock);
                  stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
                }
              }
              if (currentBlock.type === "thinking") {
                currentBlock.thinking += part.text;
                currentBlock.thinkingSignature = retainThoughtSignature(
                  currentBlock.thinkingSignature,
                  part.thoughtSignature
                );
                stream.push({
                  type: "thinking_delta",
                  contentIndex: blockIndex(),
                  delta: part.text,
                  partial: output
                });
              } else {
                currentBlock.text += part.text;
                currentBlock.textSignature = retainThoughtSignature(
                  currentBlock.textSignature,
                  part.thoughtSignature
                );
                stream.push({
                  type: "text_delta",
                  contentIndex: blockIndex(),
                  delta: part.text,
                  partial: output
                });
              }
            }
            if (part.functionCall) {
              if (currentBlock) {
                if (currentBlock.type === "text") {
                  stream.push({
                    type: "text_end",
                    contentIndex: blockIndex(),
                    content: currentBlock.text,
                    partial: output
                  });
                } else {
                  stream.push({
                    type: "thinking_end",
                    contentIndex: blockIndex(),
                    content: currentBlock.thinking,
                    partial: output
                  });
                }
                currentBlock = null;
              }
              const providedId = part.functionCall.id;
              const needsNewId = !providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
              const toolCallId = needsNewId ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}` : providedId;
              const toolCall = {
                type: "toolCall",
                id: toolCallId,
                name: part.functionCall.name || "",
                arguments: part.functionCall.args ?? {},
                ...part.thoughtSignature && { thoughtSignature: part.thoughtSignature }
              };
              output.content.push(toolCall);
              stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
              stream.push({
                type: "toolcall_delta",
                contentIndex: blockIndex(),
                delta: JSON.stringify(toolCall.arguments),
                partial: output
              });
              stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
            }
          }
        }
        if (candidate?.finishReason) {
          output.stopReason = mapStopReason(candidate.finishReason);
          if (output.content.some((b) => b.type === "toolCall")) {
            output.stopReason = "toolUse";
          }
        }
        if (chunk.usageMetadata) {
          output.usage = {
            input: chunk.usageMetadata.promptTokenCount || 0,
            output: (chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
            cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
            cacheWrite: 0,
            totalTokens: chunk.usageMetadata.totalTokenCount || 0,
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
      }
      if (currentBlock) {
        if (currentBlock.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex: blockIndex(),
            content: currentBlock.text,
            partial: output
          });
        } else {
          stream.push({
            type: "thinking_end",
            contentIndex: blockIndex(),
            content: currentBlock.thinking,
            partial: output
          });
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
      for (const block of output.content) {
        if ("index" in block) {
          delete block.index;
        }
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
};
const streamSimpleGoogle = (model, context, options) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const base = buildBaseOptions(model, options, apiKey);
  if (!options?.reasoning) {
    return streamGoogle(model, context, { ...base, thinking: { enabled: false } });
  }
  const effort = clampReasoning(options.reasoning);
  const googleModel = model;
  if (isGemini3ProModel(googleModel) || isGemini3FlashModel(googleModel)) {
    return streamGoogle(model, context, {
      ...base,
      thinking: {
        enabled: true,
        level: getGemini3ThinkingLevel(effort, googleModel)
      }
    });
  }
  return streamGoogle(model, context, {
    ...base,
    thinking: {
      enabled: true,
      budgetTokens: getGoogleBudget(googleModel, effort, options.thinkingBudgets)
    }
  });
};
async function createClient(model, apiKey, optionsHeaders) {
  const httpOptions = {};
  if (model.baseUrl) {
    httpOptions.baseUrl = model.baseUrl;
    httpOptions.apiVersion = "";
  }
  if (model.headers || optionsHeaders) {
    httpOptions.headers = { ...model.headers, ...optionsHeaders };
  }
  const GoogleGenAIClass = await getGoogleGenAIClass();
  return new GoogleGenAIClass({
    apiKey,
    httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : void 0
  });
}
function buildParams(model, context, options = {}) {
  const contents = convertMessages(model, context);
  const generationConfig = {};
  if (options.temperature !== void 0) {
    generationConfig.temperature = options.temperature;
  }
  if (options.maxTokens !== void 0) {
    generationConfig.maxOutputTokens = options.maxTokens;
  }
  const config = {
    ...Object.keys(generationConfig).length > 0 && generationConfig,
    ...context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) },
    ...context.tools && context.tools.length > 0 && { tools: convertTools(context.tools) }
  };
  if (context.tools && context.tools.length > 0 && options.toolChoice) {
    config.toolConfig = {
      functionCallingConfig: {
        mode: mapToolChoice(options.toolChoice)
      }
    };
  } else {
    config.toolConfig = void 0;
  }
  if (options.thinking?.enabled && model.reasoning) {
    const thinkingConfig = { includeThoughts: true };
    if (options.thinking.level !== void 0) {
      thinkingConfig.thinkingLevel = options.thinking.level;
    } else if (options.thinking.budgetTokens !== void 0) {
      thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
    }
    config.thinkingConfig = thinkingConfig;
  }
  if (options.signal) {
    if (options.signal.aborted) {
      throw new Error("Request aborted");
    }
    config.abortSignal = options.signal;
  }
  const params = {
    model: model.id,
    contents,
    config
  };
  return params;
}
function isGemini3ProModel(model) {
  return /gemini-3(?:\.\d+)?-pro/.test(model.id.toLowerCase());
}
function isGemini3FlashModel(model) {
  return /gemini-3(?:\.\d+)?-flash/.test(model.id.toLowerCase());
}
function getGemini3ThinkingLevel(effort, model) {
  if (isGemini3ProModel(model)) {
    switch (effort) {
      case "minimal":
      case "low":
        return "LOW";
      case "medium":
      case "high":
        return "HIGH";
    }
  }
  switch (effort) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
      return "HIGH";
  }
}
function getGoogleBudget(model, effort, customBudgets) {
  if (customBudgets?.[effort] !== void 0) {
    return customBudgets[effort];
  }
  if (model.id.includes("2.5-pro")) {
    const budgets = {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 32768
    };
    return budgets[effort];
  }
  if (model.id.includes("2.5-flash")) {
    const budgets = {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 24576
    };
    return budgets[effort];
  }
  return -1;
}
export {
  streamGoogle,
  streamSimpleGoogle
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy9nb29nbGUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIExhenktbG9hZGVkOiBHb29nbGUgR2VuQUkgU0RLICh+MTg2bXMpIGlzIGltcG9ydGVkIG9uIGZpcnN0IHVzZSwgbm90IGF0IHN0YXJ0dXAuXG4vLyBUaGlzIGF2b2lkcyBwZW5hbGl6aW5nIHVzZXJzIHdobyBkb24ndCB1c2UgR29vZ2xlIG1vZGVscy5cbmltcG9ydCB0eXBlIHtcblx0R2VuZXJhdGVDb250ZW50Q29uZmlnLFxuXHRHZW5lcmF0ZUNvbnRlbnRQYXJhbWV0ZXJzLFxuXHRHb29nbGVHZW5BSSxcblx0VGhpbmtpbmdDb25maWcsXG59IGZyb20gXCJAZ29vZ2xlL2dlbmFpXCI7XG5cbmxldCBfR29vZ2xlR2VuQUlDbGFzczogdHlwZW9mIEdvb2dsZUdlbkFJIHwgdW5kZWZpbmVkO1xuYXN5bmMgZnVuY3Rpb24gZ2V0R29vZ2xlR2VuQUlDbGFzcygpOiBQcm9taXNlPHR5cGVvZiBHb29nbGVHZW5BST4ge1xuXHRpZiAoIV9Hb29nbGVHZW5BSUNsYXNzKSB7XG5cdFx0Y29uc3QgbW9kID0gYXdhaXQgaW1wb3J0KFwiQGdvb2dsZS9nZW5haVwiKTtcblx0XHRfR29vZ2xlR2VuQUlDbGFzcyA9IG1vZC5Hb29nbGVHZW5BSTtcblx0fVxuXHRyZXR1cm4gX0dvb2dsZUdlbkFJQ2xhc3M7XG59XG5pbXBvcnQgeyBnZXRFbnZBcGlLZXkgfSBmcm9tIFwiLi4vZW52LWFwaS1rZXlzLmpzXCI7XG5pbXBvcnQgeyBjYWxjdWxhdGVDb3N0IH0gZnJvbSBcIi4uL21vZGVscy5qc1wiO1xuaW1wb3J0IHR5cGUge1xuXHRBcGksXG5cdEFzc2lzdGFudE1lc3NhZ2UsXG5cdENvbnRleHQsXG5cdE1vZGVsLFxuXHRTaW1wbGVTdHJlYW1PcHRpb25zLFxuXHRTdHJlYW1GdW5jdGlvbixcblx0U3RyZWFtT3B0aW9ucyxcblx0VGV4dENvbnRlbnQsXG5cdFRoaW5raW5nQnVkZ2V0cyxcblx0VGhpbmtpbmdDb250ZW50LFxuXHRUaGlua2luZ0xldmVsLFxuXHRUb29sQ2FsbCxcbn0gZnJvbSBcIi4uL3R5cGVzLmpzXCI7XG5pbXBvcnQgeyBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0gfSBmcm9tIFwiLi4vdXRpbHMvZXZlbnQtc3RyZWFtLmpzXCI7XG5pbXBvcnQgeyBzYW5pdGl6ZVN1cnJvZ2F0ZXMgfSBmcm9tIFwiLi4vdXRpbHMvc2FuaXRpemUtdW5pY29kZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBHb29nbGVUaGlua2luZ0xldmVsIH0gZnJvbSBcIi4vZ29vZ2xlLWdlbWluaS1jbGkuanNcIjtcbmltcG9ydCB7XG5cdGNvbnZlcnRNZXNzYWdlcyxcblx0Y29udmVydFRvb2xzLFxuXHRpc1RoaW5raW5nUGFydCxcblx0bWFwU3RvcFJlYXNvbixcblx0bWFwVG9vbENob2ljZSxcblx0cmV0YWluVGhvdWdodFNpZ25hdHVyZSxcbn0gZnJvbSBcIi4vZ29vZ2xlLXNoYXJlZC5qc1wiO1xuaW1wb3J0IHsgYnVpbGRCYXNlT3B0aW9ucywgY2xhbXBSZWFzb25pbmcgfSBmcm9tIFwiLi9zaW1wbGUtb3B0aW9ucy5qc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEdvb2dsZU9wdGlvbnMgZXh0ZW5kcyBTdHJlYW1PcHRpb25zIHtcblx0dG9vbENob2ljZT86IFwiYXV0b1wiIHwgXCJub25lXCIgfCBcImFueVwiO1xuXHR0aGlua2luZz86IHtcblx0XHRlbmFibGVkOiBib29sZWFuO1xuXHRcdGJ1ZGdldFRva2Vucz86IG51bWJlcjsgLy8gLTEgZm9yIGR5bmFtaWMsIDAgdG8gZGlzYWJsZVxuXHRcdGxldmVsPzogR29vZ2xlVGhpbmtpbmdMZXZlbDtcblx0fTtcbn1cblxuLy8gQ291bnRlciBmb3IgZ2VuZXJhdGluZyB1bmlxdWUgdG9vbCBjYWxsIElEc1xubGV0IHRvb2xDYWxsQ291bnRlciA9IDA7XG5cbmV4cG9ydCBjb25zdCBzdHJlYW1Hb29nbGU6IFN0cmVhbUZ1bmN0aW9uPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIiwgR29vZ2xlT3B0aW9ucz4gPSAoXG5cdG1vZGVsOiBNb2RlbDxcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCI+LFxuXHRjb250ZXh0OiBDb250ZXh0LFxuXHRvcHRpb25zPzogR29vZ2xlT3B0aW9ucyxcbik6IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSA9PiB7XG5cdGNvbnN0IHN0cmVhbSA9IG5ldyBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0oKTtcblxuXHQoYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IG91dHB1dDogQXNzaXN0YW50TWVzc2FnZSA9IHtcblx0XHRcdHJvbGU6IFwiYXNzaXN0YW50XCIsXG5cdFx0XHRjb250ZW50OiBbXSxcblx0XHRcdGFwaTogXCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiIGFzIEFwaSxcblx0XHRcdHByb3ZpZGVyOiBtb2RlbC5wcm92aWRlcixcblx0XHRcdG1vZGVsOiBtb2RlbC5pZCxcblx0XHRcdHVzYWdlOiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdFx0dG90YWxUb2tlbnM6IDAsXG5cdFx0XHRcdGNvc3Q6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbDogMCB9LFxuXHRcdFx0fSxcblx0XHRcdHN0b3BSZWFzb246IFwic3RvcFwiLFxuXHRcdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHRcdH07XG5cblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgYXBpS2V5ID0gb3B0aW9ucz8uYXBpS2V5IHx8IGdldEVudkFwaUtleShtb2RlbC5wcm92aWRlcikgfHwgXCJcIjtcblx0XHRcdGNvbnN0IGNsaWVudCA9IGF3YWl0IGNyZWF0ZUNsaWVudChtb2RlbCwgYXBpS2V5LCBvcHRpb25zPy5oZWFkZXJzKTtcblx0XHRcdGxldCBwYXJhbXMgPSBidWlsZFBhcmFtcyhtb2RlbCwgY29udGV4dCwgb3B0aW9ucyk7XG5cdFx0XHRjb25zdCBuZXh0UGFyYW1zID0gYXdhaXQgb3B0aW9ucz8ub25QYXlsb2FkPy4ocGFyYW1zLCBtb2RlbCk7XG5cdFx0XHRpZiAobmV4dFBhcmFtcyAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdHBhcmFtcyA9IG5leHRQYXJhbXMgYXMgR2VuZXJhdGVDb250ZW50UGFyYW1ldGVycztcblx0XHRcdH1cblx0XHRcdGNvbnN0IGdvb2dsZVN0cmVhbSA9IGF3YWl0IGNsaWVudC5tb2RlbHMuZ2VuZXJhdGVDb250ZW50U3RyZWFtKHBhcmFtcyk7XG5cblx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJzdGFydFwiLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHRsZXQgY3VycmVudEJsb2NrOiBUZXh0Q29udGVudCB8IFRoaW5raW5nQ29udGVudCB8IG51bGwgPSBudWxsO1xuXHRcdFx0Y29uc3QgYmxvY2tzID0gb3V0cHV0LmNvbnRlbnQ7XG5cdFx0XHRjb25zdCBibG9ja0luZGV4ID0gKCkgPT4gYmxvY2tzLmxlbmd0aCAtIDE7XG5cdFx0XHRmb3IgYXdhaXQgKGNvbnN0IGNodW5rIG9mIGdvb2dsZVN0cmVhbSkge1xuXHRcdFx0XHRjb25zdCBjYW5kaWRhdGUgPSBjaHVuay5jYW5kaWRhdGVzPy5bMF07XG5cdFx0XHRcdGlmIChjYW5kaWRhdGU/LmNvbnRlbnQ/LnBhcnRzKSB7XG5cdFx0XHRcdFx0Zm9yIChjb25zdCBwYXJ0IG9mIGNhbmRpZGF0ZS5jb250ZW50LnBhcnRzKSB7XG5cdFx0XHRcdFx0XHRpZiAocGFydC50ZXh0ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgaXNUaGlua2luZyA9IGlzVGhpbmtpbmdQYXJ0KHBhcnQpO1xuXHRcdFx0XHRcdFx0XHRpZiAoXG5cdFx0XHRcdFx0XHRcdFx0IWN1cnJlbnRCbG9jayB8fFxuXHRcdFx0XHRcdFx0XHRcdChpc1RoaW5raW5nICYmIGN1cnJlbnRCbG9jay50eXBlICE9PSBcInRoaW5raW5nXCIpIHx8XG5cdFx0XHRcdFx0XHRcdFx0KCFpc1RoaW5raW5nICYmIGN1cnJlbnRCbG9jay50eXBlICE9PSBcInRleHRcIilcblx0XHRcdFx0XHRcdFx0KSB7XG5cdFx0XHRcdFx0XHRcdFx0aWYgKGN1cnJlbnRCbG9jaykge1xuXHRcdFx0XHRcdFx0XHRcdFx0aWYgKGN1cnJlbnRCbG9jay50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0X2VuZFwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdGNvbnRlbnRJbmRleDogYmxvY2tzLmxlbmd0aCAtIDEsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudDogY3VycmVudEJsb2NrLnRleHQsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHR0eXBlOiBcInRoaW5raW5nX2VuZFwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IGN1cnJlbnRCbG9jay50aGlua2luZyxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHRpZiAoaXNUaGlua2luZykge1xuXHRcdFx0XHRcdFx0XHRcdFx0Y3VycmVudEJsb2NrID0geyB0eXBlOiBcInRoaW5raW5nXCIsIHRoaW5raW5nOiBcIlwiLCB0aGlua2luZ1NpZ25hdHVyZTogdW5kZWZpbmVkIH07XG5cdFx0XHRcdFx0XHRcdFx0XHRvdXRwdXQuY29udGVudC5wdXNoKGN1cnJlbnRCbG9jayk7XG5cdFx0XHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwidGhpbmtpbmdfc3RhcnRcIiwgY29udGVudEluZGV4OiBibG9ja0luZGV4KCksIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHRcdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRcdFx0Y3VycmVudEJsb2NrID0geyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJcIiB9O1xuXHRcdFx0XHRcdFx0XHRcdFx0b3V0cHV0LmNvbnRlbnQucHVzaChjdXJyZW50QmxvY2spO1xuXHRcdFx0XHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInRleHRfc3RhcnRcIiwgY29udGVudEluZGV4OiBibG9ja0luZGV4KCksIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0aWYgKGN1cnJlbnRCbG9jay50eXBlID09PSBcInRoaW5raW5nXCIpIHtcblx0XHRcdFx0XHRcdFx0XHRjdXJyZW50QmxvY2sudGhpbmtpbmcgKz0gcGFydC50ZXh0O1xuXHRcdFx0XHRcdFx0XHRcdGN1cnJlbnRCbG9jay50aGlua2luZ1NpZ25hdHVyZSA9IHJldGFpblRob3VnaHRTaWduYXR1cmUoXG5cdFx0XHRcdFx0XHRcdFx0XHRjdXJyZW50QmxvY2sudGhpbmtpbmdTaWduYXR1cmUsXG5cdFx0XHRcdFx0XHRcdFx0XHRwYXJ0LnRob3VnaHRTaWduYXR1cmUsXG5cdFx0XHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHRcdFx0XHR0eXBlOiBcInRoaW5raW5nX2RlbHRhXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdFx0XHRcdGRlbHRhOiBwYXJ0LnRleHQsXG5cdFx0XHRcdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0Y3VycmVudEJsb2NrLnRleHQgKz0gcGFydC50ZXh0O1xuXHRcdFx0XHRcdFx0XHRcdGN1cnJlbnRCbG9jay50ZXh0U2lnbmF0dXJlID0gcmV0YWluVGhvdWdodFNpZ25hdHVyZShcblx0XHRcdFx0XHRcdFx0XHRcdGN1cnJlbnRCbG9jay50ZXh0U2lnbmF0dXJlLFxuXHRcdFx0XHRcdFx0XHRcdFx0cGFydC50aG91Z2h0U2lnbmF0dXJlLFxuXHRcdFx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0X2RlbHRhXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdFx0XHRcdGRlbHRhOiBwYXJ0LnRleHQsXG5cdFx0XHRcdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0aWYgKHBhcnQuZnVuY3Rpb25DYWxsKSB7XG5cdFx0XHRcdFx0XHRcdGlmIChjdXJyZW50QmxvY2spIHtcblx0XHRcdFx0XHRcdFx0XHRpZiAoY3VycmVudEJsb2NrLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dF9lbmRcIixcblx0XHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IGN1cnJlbnRCbG9jay50ZXh0LFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdFx0XHR0eXBlOiBcInRoaW5raW5nX2VuZFwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudDogY3VycmVudEJsb2NrLnRoaW5raW5nLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0Y3VycmVudEJsb2NrID0gbnVsbDtcblx0XHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRcdC8vIEdlbmVyYXRlIHVuaXF1ZSBJRCBpZiBub3QgcHJvdmlkZWQgb3IgaWYgaXQncyBhIGR1cGxpY2F0ZVxuXHRcdFx0XHRcdFx0XHRjb25zdCBwcm92aWRlZElkID0gcGFydC5mdW5jdGlvbkNhbGwuaWQ7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IG5lZWRzTmV3SWQgPVxuXHRcdFx0XHRcdFx0XHRcdCFwcm92aWRlZElkIHx8IG91dHB1dC5jb250ZW50LnNvbWUoKGIpID0+IGIudHlwZSA9PT0gXCJ0b29sQ2FsbFwiICYmIGIuaWQgPT09IHByb3ZpZGVkSWQpO1xuXHRcdFx0XHRcdFx0XHRjb25zdCB0b29sQ2FsbElkID0gbmVlZHNOZXdJZFxuXHRcdFx0XHRcdFx0XHRcdD8gYCR7cGFydC5mdW5jdGlvbkNhbGwubmFtZX1fJHtEYXRlLm5vdygpfV8keysrdG9vbENhbGxDb3VudGVyfWBcblx0XHRcdFx0XHRcdFx0XHQ6IHByb3ZpZGVkSWQ7XG5cblx0XHRcdFx0XHRcdFx0Y29uc3QgdG9vbENhbGw6IFRvb2xDYWxsID0ge1xuXHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidG9vbENhbGxcIixcblx0XHRcdFx0XHRcdFx0XHRpZDogdG9vbENhbGxJZCxcblx0XHRcdFx0XHRcdFx0XHRuYW1lOiBwYXJ0LmZ1bmN0aW9uQ2FsbC5uYW1lIHx8IFwiXCIsXG5cdFx0XHRcdFx0XHRcdFx0YXJndW1lbnRzOiAocGFydC5mdW5jdGlvbkNhbGwuYXJncyBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+KSA/PyB7fSxcblx0XHRcdFx0XHRcdFx0XHQuLi4ocGFydC50aG91Z2h0U2lnbmF0dXJlICYmIHsgdGhvdWdodFNpZ25hdHVyZTogcGFydC50aG91Z2h0U2lnbmF0dXJlIH0pLFxuXHRcdFx0XHRcdFx0XHR9O1xuXG5cdFx0XHRcdFx0XHRcdG91dHB1dC5jb250ZW50LnB1c2godG9vbENhbGwpO1xuXHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwidG9vbGNhbGxfc3RhcnRcIiwgY29udGVudEluZGV4OiBibG9ja0luZGV4KCksIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidG9vbGNhbGxfZGVsdGFcIixcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdFx0XHRkZWx0YTogSlNPTi5zdHJpbmdpZnkodG9vbENhbGwuYXJndW1lbnRzKSxcblx0XHRcdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwidG9vbGNhbGxfZW5kXCIsIGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLCB0b29sQ2FsbCwgcGFydGlhbDogb3V0cHV0IH0pO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChjYW5kaWRhdGU/LmZpbmlzaFJlYXNvbikge1xuXHRcdFx0XHRcdG91dHB1dC5zdG9wUmVhc29uID0gbWFwU3RvcFJlYXNvbihjYW5kaWRhdGUuZmluaXNoUmVhc29uKTtcblx0XHRcdFx0XHRpZiAob3V0cHV0LmNvbnRlbnQuc29tZSgoYikgPT4gYi50eXBlID09PSBcInRvb2xDYWxsXCIpKSB7XG5cdFx0XHRcdFx0XHRvdXRwdXQuc3RvcFJlYXNvbiA9IFwidG9vbFVzZVwiO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChjaHVuay51c2FnZU1ldGFkYXRhKSB7XG5cdFx0XHRcdFx0b3V0cHV0LnVzYWdlID0ge1xuXHRcdFx0XHRcdFx0aW5wdXQ6IGNodW5rLnVzYWdlTWV0YWRhdGEucHJvbXB0VG9rZW5Db3VudCB8fCAwLFxuXHRcdFx0XHRcdFx0b3V0cHV0OlxuXHRcdFx0XHRcdFx0XHQoY2h1bmsudXNhZ2VNZXRhZGF0YS5jYW5kaWRhdGVzVG9rZW5Db3VudCB8fCAwKSArIChjaHVuay51c2FnZU1ldGFkYXRhLnRob3VnaHRzVG9rZW5Db3VudCB8fCAwKSxcblx0XHRcdFx0XHRcdGNhY2hlUmVhZDogY2h1bmsudXNhZ2VNZXRhZGF0YS5jYWNoZWRDb250ZW50VG9rZW5Db3VudCB8fCAwLFxuXHRcdFx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdFx0XHRcdHRvdGFsVG9rZW5zOiBjaHVuay51c2FnZU1ldGFkYXRhLnRvdGFsVG9rZW5Db3VudCB8fCAwLFxuXHRcdFx0XHRcdFx0Y29zdDoge1xuXHRcdFx0XHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHRcdFx0XHRcdHRvdGFsOiAwLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdGNhbGN1bGF0ZUNvc3QobW9kZWwsIG91dHB1dC51c2FnZSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0aWYgKGN1cnJlbnRCbG9jaykge1xuXHRcdFx0XHRpZiAoY3VycmVudEJsb2NrLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0X2VuZFwiLFxuXHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0XHRjb250ZW50OiBjdXJyZW50QmxvY2sudGV4dCxcblx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRoaW5raW5nX2VuZFwiLFxuXHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0XHRjb250ZW50OiBjdXJyZW50QmxvY2sudGhpbmtpbmcsXG5cdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0aWYgKG9wdGlvbnM/LnNpZ25hbD8uYWJvcnRlZCkge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJSZXF1ZXN0IHdhcyBhYm9ydGVkXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAob3V0cHV0LnN0b3BSZWFzb24gPT09IFwiYWJvcnRlZFwiIHx8IG91dHB1dC5zdG9wUmVhc29uID09PSBcImVycm9yXCIpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiQW4gdW5rbm93biBlcnJvciBvY2N1cnJlZFwiKTtcblx0XHRcdH1cblxuXHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcImRvbmVcIiwgcmVhc29uOiBvdXRwdXQuc3RvcFJlYXNvbiwgbWVzc2FnZTogb3V0cHV0IH0pO1xuXHRcdFx0c3RyZWFtLmVuZCgpO1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHQvLyBSZW1vdmUgaW50ZXJuYWwgaW5kZXggcHJvcGVydHkgdXNlZCBkdXJpbmcgc3RyZWFtaW5nXG5cdFx0XHRmb3IgKGNvbnN0IGJsb2NrIG9mIG91dHB1dC5jb250ZW50KSB7XG5cdFx0XHRcdGlmIChcImluZGV4XCIgaW4gYmxvY2spIHtcblx0XHRcdFx0XHRkZWxldGUgKGJsb2NrIGFzIHsgaW5kZXg/OiBudW1iZXIgfSkuaW5kZXg7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdG91dHB1dC5zdG9wUmVhc29uID0gb3B0aW9ucz8uc2lnbmFsPy5hYm9ydGVkID8gXCJhYm9ydGVkXCIgOiBcImVycm9yXCI7XG5cdFx0XHRvdXRwdXQuZXJyb3JNZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBKU09OLnN0cmluZ2lmeShlcnJvcik7XG5cdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwiZXJyb3JcIiwgcmVhc29uOiBvdXRwdXQuc3RvcFJlYXNvbiwgZXJyb3I6IG91dHB1dCB9KTtcblx0XHRcdHN0cmVhbS5lbmQoKTtcblx0XHR9XG5cdH0pKCk7XG5cblx0cmV0dXJuIHN0cmVhbTtcbn07XG5cbmV4cG9ydCBjb25zdCBzdHJlYW1TaW1wbGVHb29nbGU6IFN0cmVhbUZ1bmN0aW9uPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIiwgU2ltcGxlU3RyZWFtT3B0aW9ucz4gPSAoXG5cdG1vZGVsOiBNb2RlbDxcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCI+LFxuXHRjb250ZXh0OiBDb250ZXh0LFxuXHRvcHRpb25zPzogU2ltcGxlU3RyZWFtT3B0aW9ucyxcbik6IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSA9PiB7XG5cdGNvbnN0IGFwaUtleSA9IG9wdGlvbnM/LmFwaUtleSB8fCBnZXRFbnZBcGlLZXkobW9kZWwucHJvdmlkZXIpO1xuXHRpZiAoIWFwaUtleSkge1xuXHRcdHRocm93IG5ldyBFcnJvcihgTm8gQVBJIGtleSBmb3IgcHJvdmlkZXI6ICR7bW9kZWwucHJvdmlkZXJ9YCk7XG5cdH1cblxuXHRjb25zdCBiYXNlID0gYnVpbGRCYXNlT3B0aW9ucyhtb2RlbCwgb3B0aW9ucywgYXBpS2V5KTtcblx0aWYgKCFvcHRpb25zPy5yZWFzb25pbmcpIHtcblx0XHRyZXR1cm4gc3RyZWFtR29vZ2xlKG1vZGVsLCBjb250ZXh0LCB7IC4uLmJhc2UsIHRoaW5raW5nOiB7IGVuYWJsZWQ6IGZhbHNlIH0gfSBzYXRpc2ZpZXMgR29vZ2xlT3B0aW9ucyk7XG5cdH1cblxuXHRjb25zdCBlZmZvcnQgPSBjbGFtcFJlYXNvbmluZyhvcHRpb25zLnJlYXNvbmluZykhO1xuXHRjb25zdCBnb29nbGVNb2RlbCA9IG1vZGVsIGFzIE1vZGVsPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIj47XG5cblx0aWYgKGlzR2VtaW5pM1Byb01vZGVsKGdvb2dsZU1vZGVsKSB8fCBpc0dlbWluaTNGbGFzaE1vZGVsKGdvb2dsZU1vZGVsKSkge1xuXHRcdHJldHVybiBzdHJlYW1Hb29nbGUobW9kZWwsIGNvbnRleHQsIHtcblx0XHRcdC4uLmJhc2UsXG5cdFx0XHR0aGlua2luZzoge1xuXHRcdFx0XHRlbmFibGVkOiB0cnVlLFxuXHRcdFx0XHRsZXZlbDogZ2V0R2VtaW5pM1RoaW5raW5nTGV2ZWwoZWZmb3J0LCBnb29nbGVNb2RlbCksXG5cdFx0XHR9LFxuXHRcdH0gc2F0aXNmaWVzIEdvb2dsZU9wdGlvbnMpO1xuXHR9XG5cblx0cmV0dXJuIHN0cmVhbUdvb2dsZShtb2RlbCwgY29udGV4dCwge1xuXHRcdC4uLmJhc2UsXG5cdFx0dGhpbmtpbmc6IHtcblx0XHRcdGVuYWJsZWQ6IHRydWUsXG5cdFx0XHRidWRnZXRUb2tlbnM6IGdldEdvb2dsZUJ1ZGdldChnb29nbGVNb2RlbCwgZWZmb3J0LCBvcHRpb25zLnRoaW5raW5nQnVkZ2V0cyksXG5cdFx0fSxcblx0fSBzYXRpc2ZpZXMgR29vZ2xlT3B0aW9ucyk7XG59O1xuXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVDbGllbnQoXG5cdG1vZGVsOiBNb2RlbDxcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCI+LFxuXHRhcGlLZXk/OiBzdHJpbmcsXG5cdG9wdGlvbnNIZWFkZXJzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcbik6IFByb21pc2U8R29vZ2xlR2VuQUk+IHtcblx0Y29uc3QgaHR0cE9wdGlvbnM6IHsgYmFzZVVybD86IHN0cmluZzsgYXBpVmVyc2lvbj86IHN0cmluZzsgaGVhZGVycz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfSA9IHt9O1xuXHRpZiAobW9kZWwuYmFzZVVybCkge1xuXHRcdGh0dHBPcHRpb25zLmJhc2VVcmwgPSBtb2RlbC5iYXNlVXJsO1xuXHRcdGh0dHBPcHRpb25zLmFwaVZlcnNpb24gPSBcIlwiOyAvLyBiYXNlVXJsIGFscmVhZHkgaW5jbHVkZXMgdmVyc2lvbiBwYXRoLCBkb24ndCBhcHBlbmRcblx0fVxuXHRpZiAobW9kZWwuaGVhZGVycyB8fCBvcHRpb25zSGVhZGVycykge1xuXHRcdGh0dHBPcHRpb25zLmhlYWRlcnMgPSB7IC4uLm1vZGVsLmhlYWRlcnMsIC4uLm9wdGlvbnNIZWFkZXJzIH07XG5cdH1cblxuXHRjb25zdCBHb29nbGVHZW5BSUNsYXNzID0gYXdhaXQgZ2V0R29vZ2xlR2VuQUlDbGFzcygpO1xuXHRyZXR1cm4gbmV3IEdvb2dsZUdlbkFJQ2xhc3Moe1xuXHRcdGFwaUtleSxcblx0XHRodHRwT3B0aW9uczogT2JqZWN0LmtleXMoaHR0cE9wdGlvbnMpLmxlbmd0aCA+IDAgPyBodHRwT3B0aW9ucyA6IHVuZGVmaW5lZCxcblx0fSk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkUGFyYW1zKFxuXHRtb2RlbDogTW9kZWw8XCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiPixcblx0Y29udGV4dDogQ29udGV4dCxcblx0b3B0aW9uczogR29vZ2xlT3B0aW9ucyA9IHt9LFxuKTogR2VuZXJhdGVDb250ZW50UGFyYW1ldGVycyB7XG5cdGNvbnN0IGNvbnRlbnRzID0gY29udmVydE1lc3NhZ2VzKG1vZGVsLCBjb250ZXh0KTtcblxuXHRjb25zdCBnZW5lcmF0aW9uQ29uZmlnOiBHZW5lcmF0ZUNvbnRlbnRDb25maWcgPSB7fTtcblx0aWYgKG9wdGlvbnMudGVtcGVyYXR1cmUgIT09IHVuZGVmaW5lZCkge1xuXHRcdGdlbmVyYXRpb25Db25maWcudGVtcGVyYXR1cmUgPSBvcHRpb25zLnRlbXBlcmF0dXJlO1xuXHR9XG5cdGlmIChvcHRpb25zLm1heFRva2VucyAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0Z2VuZXJhdGlvbkNvbmZpZy5tYXhPdXRwdXRUb2tlbnMgPSBvcHRpb25zLm1heFRva2Vucztcblx0fVxuXG5cdGNvbnN0IGNvbmZpZzogR2VuZXJhdGVDb250ZW50Q29uZmlnID0ge1xuXHRcdC4uLihPYmplY3Qua2V5cyhnZW5lcmF0aW9uQ29uZmlnKS5sZW5ndGggPiAwICYmIGdlbmVyYXRpb25Db25maWcpLFxuXHRcdC4uLihjb250ZXh0LnN5c3RlbVByb21wdCAmJiB7IHN5c3RlbUluc3RydWN0aW9uOiBzYW5pdGl6ZVN1cnJvZ2F0ZXMoY29udGV4dC5zeXN0ZW1Qcm9tcHQpIH0pLFxuXHRcdC4uLihjb250ZXh0LnRvb2xzICYmIGNvbnRleHQudG9vbHMubGVuZ3RoID4gMCAmJiB7IHRvb2xzOiBjb252ZXJ0VG9vbHMoY29udGV4dC50b29scykgfSksXG5cdH07XG5cblx0aWYgKGNvbnRleHQudG9vbHMgJiYgY29udGV4dC50b29scy5sZW5ndGggPiAwICYmIG9wdGlvbnMudG9vbENob2ljZSkge1xuXHRcdGNvbmZpZy50b29sQ29uZmlnID0ge1xuXHRcdFx0ZnVuY3Rpb25DYWxsaW5nQ29uZmlnOiB7XG5cdFx0XHRcdG1vZGU6IG1hcFRvb2xDaG9pY2Uob3B0aW9ucy50b29sQ2hvaWNlKSxcblx0XHRcdH0sXG5cdFx0fTtcblx0fSBlbHNlIHtcblx0XHRjb25maWcudG9vbENvbmZpZyA9IHVuZGVmaW5lZDtcblx0fVxuXG5cdGlmIChvcHRpb25zLnRoaW5raW5nPy5lbmFibGVkICYmIG1vZGVsLnJlYXNvbmluZykge1xuXHRcdGNvbnN0IHRoaW5raW5nQ29uZmlnOiBUaGlua2luZ0NvbmZpZyA9IHsgaW5jbHVkZVRob3VnaHRzOiB0cnVlIH07XG5cdFx0aWYgKG9wdGlvbnMudGhpbmtpbmcubGV2ZWwgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0Ly8gQ2FzdCB0byBhbnkgc2luY2Ugb3VyIEdvb2dsZVRoaW5raW5nTGV2ZWwgbWlycm9ycyBHb29nbGUncyBUaGlua2luZ0xldmVsIGVudW0gdmFsdWVzXG5cdFx0XHR0aGlua2luZ0NvbmZpZy50aGlua2luZ0xldmVsID0gb3B0aW9ucy50aGlua2luZy5sZXZlbCBhcyBhbnk7XG5cdFx0fSBlbHNlIGlmIChvcHRpb25zLnRoaW5raW5nLmJ1ZGdldFRva2VucyAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHR0aGlua2luZ0NvbmZpZy50aGlua2luZ0J1ZGdldCA9IG9wdGlvbnMudGhpbmtpbmcuYnVkZ2V0VG9rZW5zO1xuXHRcdH1cblx0XHRjb25maWcudGhpbmtpbmdDb25maWcgPSB0aGlua2luZ0NvbmZpZztcblx0fVxuXG5cdGlmIChvcHRpb25zLnNpZ25hbCkge1xuXHRcdGlmIChvcHRpb25zLnNpZ25hbC5hYm9ydGVkKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJSZXF1ZXN0IGFib3J0ZWRcIik7XG5cdFx0fVxuXHRcdGNvbmZpZy5hYm9ydFNpZ25hbCA9IG9wdGlvbnMuc2lnbmFsO1xuXHR9XG5cblx0Y29uc3QgcGFyYW1zOiBHZW5lcmF0ZUNvbnRlbnRQYXJhbWV0ZXJzID0ge1xuXHRcdG1vZGVsOiBtb2RlbC5pZCxcblx0XHRjb250ZW50cyxcblx0XHRjb25maWcsXG5cdH07XG5cblx0cmV0dXJuIHBhcmFtcztcbn1cblxudHlwZSBDbGFtcGVkVGhpbmtpbmdMZXZlbCA9IEV4Y2x1ZGU8VGhpbmtpbmdMZXZlbCwgXCJ4aGlnaFwiPjtcblxuZnVuY3Rpb24gaXNHZW1pbmkzUHJvTW9kZWwobW9kZWw6IE1vZGVsPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIj4pOiBib29sZWFuIHtcblx0cmV0dXJuIC9nZW1pbmktMyg/OlxcLlxcZCspPy1wcm8vLnRlc3QobW9kZWwuaWQudG9Mb3dlckNhc2UoKSk7XG59XG5cbmZ1bmN0aW9uIGlzR2VtaW5pM0ZsYXNoTW9kZWwobW9kZWw6IE1vZGVsPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIj4pOiBib29sZWFuIHtcblx0cmV0dXJuIC9nZW1pbmktMyg/OlxcLlxcZCspPy1mbGFzaC8udGVzdChtb2RlbC5pZC50b0xvd2VyQ2FzZSgpKTtcbn1cblxuZnVuY3Rpb24gZ2V0R2VtaW5pM1RoaW5raW5nTGV2ZWwoXG5cdGVmZm9ydDogQ2xhbXBlZFRoaW5raW5nTGV2ZWwsXG5cdG1vZGVsOiBNb2RlbDxcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCI+LFxuKTogR29vZ2xlVGhpbmtpbmdMZXZlbCB7XG5cdGlmIChpc0dlbWluaTNQcm9Nb2RlbChtb2RlbCkpIHtcblx0XHRzd2l0Y2ggKGVmZm9ydCkge1xuXHRcdFx0Y2FzZSBcIm1pbmltYWxcIjpcblx0XHRcdGNhc2UgXCJsb3dcIjpcblx0XHRcdFx0cmV0dXJuIFwiTE9XXCI7XG5cdFx0XHRjYXNlIFwibWVkaXVtXCI6XG5cdFx0XHRjYXNlIFwiaGlnaFwiOlxuXHRcdFx0XHRyZXR1cm4gXCJISUdIXCI7XG5cdFx0fVxuXHR9XG5cdHN3aXRjaCAoZWZmb3J0KSB7XG5cdFx0Y2FzZSBcIm1pbmltYWxcIjpcblx0XHRcdHJldHVybiBcIk1JTklNQUxcIjtcblx0XHRjYXNlIFwibG93XCI6XG5cdFx0XHRyZXR1cm4gXCJMT1dcIjtcblx0XHRjYXNlIFwibWVkaXVtXCI6XG5cdFx0XHRyZXR1cm4gXCJNRURJVU1cIjtcblx0XHRjYXNlIFwiaGlnaFwiOlxuXHRcdFx0cmV0dXJuIFwiSElHSFwiO1xuXHR9XG59XG5cbmZ1bmN0aW9uIGdldEdvb2dsZUJ1ZGdldChcblx0bW9kZWw6IE1vZGVsPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIj4sXG5cdGVmZm9ydDogQ2xhbXBlZFRoaW5raW5nTGV2ZWwsXG5cdGN1c3RvbUJ1ZGdldHM/OiBUaGlua2luZ0J1ZGdldHMsXG4pOiBudW1iZXIge1xuXHRpZiAoY3VzdG9tQnVkZ2V0cz8uW2VmZm9ydF0gIT09IHVuZGVmaW5lZCkge1xuXHRcdHJldHVybiBjdXN0b21CdWRnZXRzW2VmZm9ydF0hO1xuXHR9XG5cblx0aWYgKG1vZGVsLmlkLmluY2x1ZGVzKFwiMi41LXByb1wiKSkge1xuXHRcdGNvbnN0IGJ1ZGdldHM6IFJlY29yZDxDbGFtcGVkVGhpbmtpbmdMZXZlbCwgbnVtYmVyPiA9IHtcblx0XHRcdG1pbmltYWw6IDEyOCxcblx0XHRcdGxvdzogMjA0OCxcblx0XHRcdG1lZGl1bTogODE5Mixcblx0XHRcdGhpZ2g6IDMyNzY4LFxuXHRcdH07XG5cdFx0cmV0dXJuIGJ1ZGdldHNbZWZmb3J0XTtcblx0fVxuXG5cdGlmIChtb2RlbC5pZC5pbmNsdWRlcyhcIjIuNS1mbGFzaFwiKSkge1xuXHRcdGNvbnN0IGJ1ZGdldHM6IFJlY29yZDxDbGFtcGVkVGhpbmtpbmdMZXZlbCwgbnVtYmVyPiA9IHtcblx0XHRcdG1pbmltYWw6IDEyOCxcblx0XHRcdGxvdzogMjA0OCxcblx0XHRcdG1lZGl1bTogODE5Mixcblx0XHRcdGhpZ2g6IDI0NTc2LFxuXHRcdH07XG5cdFx0cmV0dXJuIGJ1ZGdldHNbZWZmb3J0XTtcblx0fVxuXG5cdHJldHVybiAtMTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVNBLElBQUk7QUFDSixlQUFlLHNCQUFtRDtBQUNqRSxNQUFJLENBQUMsbUJBQW1CO0FBQ3ZCLFVBQU0sTUFBTSxNQUFNLE9BQU8sZUFBZTtBQUN4Qyx3QkFBb0IsSUFBSTtBQUFBLEVBQ3pCO0FBQ0EsU0FBTztBQUNSO0FBQ0EsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxxQkFBcUI7QUFlOUIsU0FBUyxtQ0FBbUM7QUFDNUMsU0FBUywwQkFBMEI7QUFFbkM7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBQ1AsU0FB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
