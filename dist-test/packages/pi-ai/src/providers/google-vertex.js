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
let _GoogleVertexClass;
async function getGoogleVertexClass() {
  if (!_GoogleVertexClass) {
    const mod = await import("@google/genai");
    _GoogleVertexClass = mod.GoogleGenAI;
  }
  return _GoogleVertexClass;
}
const API_VERSION = "v1";
const THINKING_LEVEL_MAP = {
  THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
  MINIMAL: "MINIMAL",
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH"
};
let toolCallCounter = 0;
const streamGoogleVertex = (model, context, options) => {
  const stream = new AssistantMessageEventStream();
  (async () => {
    const output = {
      role: "assistant",
      content: [],
      api: "google-vertex",
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
      const project = resolveProject(options);
      const location = resolveLocation(options);
      const client = await createClient(model, project, location, options?.headers);
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
const streamSimpleGoogleVertex = (model, context, options) => {
  const base = buildBaseOptions(model, options, void 0);
  if (!options?.reasoning) {
    return streamGoogleVertex(model, context, {
      ...base,
      thinking: { enabled: false }
    });
  }
  const effort = clampReasoning(options.reasoning);
  const geminiModel = model;
  if (isGemini3ProModel(geminiModel) || isGemini3FlashModel(geminiModel)) {
    return streamGoogleVertex(model, context, {
      ...base,
      thinking: {
        enabled: true,
        level: getGemini3ThinkingLevel(effort, geminiModel)
      }
    });
  }
  return streamGoogleVertex(model, context, {
    ...base,
    thinking: {
      enabled: true,
      budgetTokens: getGoogleBudget(geminiModel, effort, options.thinkingBudgets)
    }
  });
};
async function createClient(model, project, location, optionsHeaders) {
  const httpOptions = {};
  if (model.headers || optionsHeaders) {
    httpOptions.headers = { ...model.headers, ...optionsHeaders };
  }
  const hasHttpOptions = Object.values(httpOptions).some(Boolean);
  const GoogleGenAIClass = await getGoogleVertexClass();
  return new GoogleGenAIClass({
    vertexai: true,
    project,
    location,
    apiVersion: API_VERSION,
    httpOptions: hasHttpOptions ? httpOptions : void 0
  });
}
function resolveProject(options) {
  const project = options?.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (!project) {
    throw new Error(
      "Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options."
    );
  }
  return project;
}
function resolveLocation(options) {
  const location = options?.location || process.env.GOOGLE_CLOUD_LOCATION;
  if (!location) {
    throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
  }
  return location;
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
      thinkingConfig.thinkingLevel = THINKING_LEVEL_MAP[options.thinking.level];
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
  streamGoogleVertex,
  streamSimpleGoogleVertex
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy9nb29nbGUtdmVydGV4LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBMYXp5LWxvYWRlZDogR29vZ2xlIEdlbkFJIFNESyBpcyBpbXBvcnRlZCBvbiBmaXJzdCB1c2UsIG5vdCBhdCBzdGFydHVwLlxuLy8gVGhpcyBhdm9pZHMgcGVuYWxpemluZyB1c2VycyB3aG8gZG9uJ3QgdXNlIEdvb2dsZSBWZXJ0ZXggbW9kZWxzLlxuaW1wb3J0IHR5cGUgeyBHb29nbGVHZW5BSSB9IGZyb20gXCJAZ29vZ2xlL2dlbmFpXCI7XG5pbXBvcnQgdHlwZSB7XG5cdEdlbmVyYXRlQ29udGVudENvbmZpZyxcblx0R2VuZXJhdGVDb250ZW50UGFyYW1ldGVycyxcblx0VGhpbmtpbmdDb25maWcsXG59IGZyb20gXCJAZ29vZ2xlL2dlbmFpXCI7XG5pbXBvcnQgeyBjYWxjdWxhdGVDb3N0IH0gZnJvbSBcIi4uL21vZGVscy5qc1wiO1xuaW1wb3J0IHR5cGUge1xuXHRBcGksXG5cdEFzc2lzdGFudE1lc3NhZ2UsXG5cdENvbnRleHQsXG5cdE1vZGVsLFxuXHRUaGlua2luZ0xldmVsIGFzIFBpVGhpbmtpbmdMZXZlbCxcblx0U2ltcGxlU3RyZWFtT3B0aW9ucyxcblx0U3RyZWFtRnVuY3Rpb24sXG5cdFN0cmVhbU9wdGlvbnMsXG5cdFRleHRDb250ZW50LFxuXHRUaGlua2luZ0J1ZGdldHMsXG5cdFRoaW5raW5nQ29udGVudCxcblx0VG9vbENhbGwsXG59IGZyb20gXCIuLi90eXBlcy5qc1wiO1xuaW1wb3J0IHsgQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtIH0gZnJvbSBcIi4uL3V0aWxzL2V2ZW50LXN0cmVhbS5qc1wiO1xuaW1wb3J0IHsgc2FuaXRpemVTdXJyb2dhdGVzIH0gZnJvbSBcIi4uL3V0aWxzL3Nhbml0aXplLXVuaWNvZGUuanNcIjtcbmltcG9ydCB0eXBlIHsgR29vZ2xlVGhpbmtpbmdMZXZlbCB9IGZyb20gXCIuL2dvb2dsZS1nZW1pbmktY2xpLmpzXCI7XG5pbXBvcnQge1xuXHRjb252ZXJ0TWVzc2FnZXMsXG5cdGNvbnZlcnRUb29scyxcblx0aXNUaGlua2luZ1BhcnQsXG5cdG1hcFN0b3BSZWFzb24sXG5cdG1hcFRvb2xDaG9pY2UsXG5cdHJldGFpblRob3VnaHRTaWduYXR1cmUsXG59IGZyb20gXCIuL2dvb2dsZS1zaGFyZWQuanNcIjtcbmltcG9ydCB7IGJ1aWxkQmFzZU9wdGlvbnMsIGNsYW1wUmVhc29uaW5nIH0gZnJvbSBcIi4vc2ltcGxlLW9wdGlvbnMuanNcIjtcblxubGV0IF9Hb29nbGVWZXJ0ZXhDbGFzczogdHlwZW9mIEdvb2dsZUdlbkFJIHwgdW5kZWZpbmVkO1xuYXN5bmMgZnVuY3Rpb24gZ2V0R29vZ2xlVmVydGV4Q2xhc3MoKTogUHJvbWlzZTx0eXBlb2YgR29vZ2xlR2VuQUk+IHtcblx0aWYgKCFfR29vZ2xlVmVydGV4Q2xhc3MpIHtcblx0XHRjb25zdCBtb2QgPSBhd2FpdCBpbXBvcnQoXCJAZ29vZ2xlL2dlbmFpXCIpO1xuXHRcdF9Hb29nbGVWZXJ0ZXhDbGFzcyA9IG1vZC5Hb29nbGVHZW5BSTtcblx0fVxuXHRyZXR1cm4gX0dvb2dsZVZlcnRleENsYXNzO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEdvb2dsZVZlcnRleE9wdGlvbnMgZXh0ZW5kcyBTdHJlYW1PcHRpb25zIHtcblx0dG9vbENob2ljZT86IFwiYXV0b1wiIHwgXCJub25lXCIgfCBcImFueVwiO1xuXHR0aGlua2luZz86IHtcblx0XHRlbmFibGVkOiBib29sZWFuO1xuXHRcdGJ1ZGdldFRva2Vucz86IG51bWJlcjsgLy8gLTEgZm9yIGR5bmFtaWMsIDAgdG8gZGlzYWJsZVxuXHRcdGxldmVsPzogR29vZ2xlVGhpbmtpbmdMZXZlbDtcblx0fTtcblx0cHJvamVjdD86IHN0cmluZztcblx0bG9jYXRpb24/OiBzdHJpbmc7XG59XG5cbmNvbnN0IEFQSV9WRVJTSU9OID0gXCJ2MVwiO1xuXG4vLyBUaGlua2luZ0xldmVsIGlzIGEgc3RyaW5nIGVudW0gd2hlcmUgZWFjaCB2YWx1ZSBlcXVhbHMgaXRzIGtleSBuYW1lLlxuLy8gVXNpbmcgc3RyaW5nIGxpdGVyYWxzIGF2b2lkcyBpbXBvcnRpbmcgdGhlIFNESyBhdCBtb2R1bGUgbG9hZCB0aW1lLlxuY29uc3QgVEhJTktJTkdfTEVWRUxfTUFQOiBSZWNvcmQ8R29vZ2xlVGhpbmtpbmdMZXZlbCwgc3RyaW5nPiA9IHtcblx0VEhJTktJTkdfTEVWRUxfVU5TUEVDSUZJRUQ6IFwiVEhJTktJTkdfTEVWRUxfVU5TUEVDSUZJRURcIixcblx0TUlOSU1BTDogXCJNSU5JTUFMXCIsXG5cdExPVzogXCJMT1dcIixcblx0TUVESVVNOiBcIk1FRElVTVwiLFxuXHRISUdIOiBcIkhJR0hcIixcbn07XG5cbi8vIENvdW50ZXIgZm9yIGdlbmVyYXRpbmcgdW5pcXVlIHRvb2wgY2FsbCBJRHNcbmxldCB0b29sQ2FsbENvdW50ZXIgPSAwO1xuXG5leHBvcnQgY29uc3Qgc3RyZWFtR29vZ2xlVmVydGV4OiBTdHJlYW1GdW5jdGlvbjxcImdvb2dsZS12ZXJ0ZXhcIiwgR29vZ2xlVmVydGV4T3B0aW9ucz4gPSAoXG5cdG1vZGVsOiBNb2RlbDxcImdvb2dsZS12ZXJ0ZXhcIj4sXG5cdGNvbnRleHQ6IENvbnRleHQsXG5cdG9wdGlvbnM/OiBHb29nbGVWZXJ0ZXhPcHRpb25zLFxuKTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtID0+IHtcblx0Y29uc3Qgc3RyZWFtID0gbmV3IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSgpO1xuXG5cdChhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgb3V0cHV0OiBBc3Npc3RhbnRNZXNzYWdlID0ge1xuXHRcdFx0cm9sZTogXCJhc3Npc3RhbnRcIixcblx0XHRcdGNvbnRlbnQ6IFtdLFxuXHRcdFx0YXBpOiBcImdvb2dsZS12ZXJ0ZXhcIiBhcyBBcGksXG5cdFx0XHRwcm92aWRlcjogbW9kZWwucHJvdmlkZXIsXG5cdFx0XHRtb2RlbDogbW9kZWwuaWQsXG5cdFx0XHR1c2FnZToge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHRcdHRvdGFsVG9rZW5zOiAwLFxuXHRcdFx0XHRjb3N0OiB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgdG90YWw6IDAgfSxcblx0XHRcdH0sXG5cdFx0XHRzdG9wUmVhc29uOiBcInN0b3BcIixcblx0XHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0XHR9O1xuXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IHByb2plY3QgPSByZXNvbHZlUHJvamVjdChvcHRpb25zKTtcblx0XHRcdGNvbnN0IGxvY2F0aW9uID0gcmVzb2x2ZUxvY2F0aW9uKG9wdGlvbnMpO1xuXHRcdFx0Y29uc3QgY2xpZW50ID0gYXdhaXQgY3JlYXRlQ2xpZW50KG1vZGVsLCBwcm9qZWN0LCBsb2NhdGlvbiwgb3B0aW9ucz8uaGVhZGVycyk7XG5cdFx0XHRsZXQgcGFyYW1zID0gYnVpbGRQYXJhbXMobW9kZWwsIGNvbnRleHQsIG9wdGlvbnMpO1xuXHRcdFx0Y29uc3QgbmV4dFBhcmFtcyA9IGF3YWl0IG9wdGlvbnM/Lm9uUGF5bG9hZD8uKHBhcmFtcywgbW9kZWwpO1xuXHRcdFx0aWYgKG5leHRQYXJhbXMgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRwYXJhbXMgPSBuZXh0UGFyYW1zIGFzIEdlbmVyYXRlQ29udGVudFBhcmFtZXRlcnM7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBnb29nbGVTdHJlYW0gPSBhd2FpdCBjbGllbnQubW9kZWxzLmdlbmVyYXRlQ29udGVudFN0cmVhbShwYXJhbXMpO1xuXG5cdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwic3RhcnRcIiwgcGFydGlhbDogb3V0cHV0IH0pO1xuXHRcdFx0bGV0IGN1cnJlbnRCbG9jazogVGV4dENvbnRlbnQgfCBUaGlua2luZ0NvbnRlbnQgfCBudWxsID0gbnVsbDtcblx0XHRcdGNvbnN0IGJsb2NrcyA9IG91dHB1dC5jb250ZW50O1xuXHRcdFx0Y29uc3QgYmxvY2tJbmRleCA9ICgpID0+IGJsb2Nrcy5sZW5ndGggLSAxO1xuXHRcdFx0Zm9yIGF3YWl0IChjb25zdCBjaHVuayBvZiBnb29nbGVTdHJlYW0pIHtcblx0XHRcdFx0Y29uc3QgY2FuZGlkYXRlID0gY2h1bmsuY2FuZGlkYXRlcz8uWzBdO1xuXHRcdFx0XHRpZiAoY2FuZGlkYXRlPy5jb250ZW50Py5wYXJ0cykge1xuXHRcdFx0XHRcdGZvciAoY29uc3QgcGFydCBvZiBjYW5kaWRhdGUuY29udGVudC5wYXJ0cykge1xuXHRcdFx0XHRcdFx0aWYgKHBhcnQudGV4dCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGlzVGhpbmtpbmcgPSBpc1RoaW5raW5nUGFydChwYXJ0KTtcblx0XHRcdFx0XHRcdFx0aWYgKFxuXHRcdFx0XHRcdFx0XHRcdCFjdXJyZW50QmxvY2sgfHxcblx0XHRcdFx0XHRcdFx0XHQoaXNUaGlua2luZyAmJiBjdXJyZW50QmxvY2sudHlwZSAhPT0gXCJ0aGlua2luZ1wiKSB8fFxuXHRcdFx0XHRcdFx0XHRcdCghaXNUaGlua2luZyAmJiBjdXJyZW50QmxvY2sudHlwZSAhPT0gXCJ0ZXh0XCIpXG5cdFx0XHRcdFx0XHRcdCkge1xuXHRcdFx0XHRcdFx0XHRcdGlmIChjdXJyZW50QmxvY2spIHtcblx0XHRcdFx0XHRcdFx0XHRcdGlmIChjdXJyZW50QmxvY2sudHlwZSA9PT0gXCJ0ZXh0XCIpIHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dF9lbmRcIixcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2Nrcy5sZW5ndGggLSAxLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IGN1cnJlbnRCbG9jay50ZXh0LFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0aGlua2luZ19lbmRcIixcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBjdXJyZW50QmxvY2sudGhpbmtpbmcsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0aWYgKGlzVGhpbmtpbmcpIHtcblx0XHRcdFx0XHRcdFx0XHRcdGN1cnJlbnRCbG9jayA9IHsgdHlwZTogXCJ0aGlua2luZ1wiLCB0aGlua2luZzogXCJcIiwgdGhpbmtpbmdTaWduYXR1cmU6IHVuZGVmaW5lZCB9O1xuXHRcdFx0XHRcdFx0XHRcdFx0b3V0cHV0LmNvbnRlbnQucHVzaChjdXJyZW50QmxvY2spO1xuXHRcdFx0XHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInRoaW5raW5nX3N0YXJ0XCIsIGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0XHRcdGN1cnJlbnRCbG9jayA9IHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiXCIgfTtcblx0XHRcdFx0XHRcdFx0XHRcdG91dHB1dC5jb250ZW50LnB1c2goY3VycmVudEJsb2NrKTtcblx0XHRcdFx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0ZXh0X3N0YXJ0XCIsIGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdGlmIChjdXJyZW50QmxvY2sudHlwZSA9PT0gXCJ0aGlua2luZ1wiKSB7XG5cdFx0XHRcdFx0XHRcdFx0Y3VycmVudEJsb2NrLnRoaW5raW5nICs9IHBhcnQudGV4dDtcblx0XHRcdFx0XHRcdFx0XHRjdXJyZW50QmxvY2sudGhpbmtpbmdTaWduYXR1cmUgPSByZXRhaW5UaG91Z2h0U2lnbmF0dXJlKFxuXHRcdFx0XHRcdFx0XHRcdFx0Y3VycmVudEJsb2NrLnRoaW5raW5nU2lnbmF0dXJlLFxuXHRcdFx0XHRcdFx0XHRcdFx0cGFydC50aG91Z2h0U2lnbmF0dXJlLFxuXHRcdFx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0aGlua2luZ19kZWx0YVwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0XHRcdFx0XHRkZWx0YTogcGFydC50ZXh0LFxuXHRcdFx0XHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRcdGN1cnJlbnRCbG9jay50ZXh0ICs9IHBhcnQudGV4dDtcblx0XHRcdFx0XHRcdFx0XHRjdXJyZW50QmxvY2sudGV4dFNpZ25hdHVyZSA9IHJldGFpblRob3VnaHRTaWduYXR1cmUoXG5cdFx0XHRcdFx0XHRcdFx0XHRjdXJyZW50QmxvY2sudGV4dFNpZ25hdHVyZSxcblx0XHRcdFx0XHRcdFx0XHRcdHBhcnQudGhvdWdodFNpZ25hdHVyZSxcblx0XHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dF9kZWx0YVwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0XHRcdFx0XHRkZWx0YTogcGFydC50ZXh0LFxuXHRcdFx0XHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGlmIChwYXJ0LmZ1bmN0aW9uQ2FsbCkge1xuXHRcdFx0XHRcdFx0XHRpZiAoY3VycmVudEJsb2NrKSB7XG5cdFx0XHRcdFx0XHRcdFx0aWYgKGN1cnJlbnRCbG9jay50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdFx0XHR0eXBlOiBcInRleHRfZW5kXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBjdXJyZW50QmxvY2sudGV4dCxcblx0XHRcdFx0XHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0aGlua2luZ19lbmRcIixcblx0XHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IGN1cnJlbnRCbG9jay50aGlua2luZyxcblx0XHRcdFx0XHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRcdGN1cnJlbnRCbG9jayA9IG51bGw7XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRjb25zdCBwcm92aWRlZElkID0gcGFydC5mdW5jdGlvbkNhbGwuaWQ7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IG5lZWRzTmV3SWQgPVxuXHRcdFx0XHRcdFx0XHRcdCFwcm92aWRlZElkIHx8IG91dHB1dC5jb250ZW50LnNvbWUoKGIpID0+IGIudHlwZSA9PT0gXCJ0b29sQ2FsbFwiICYmIGIuaWQgPT09IHByb3ZpZGVkSWQpO1xuXHRcdFx0XHRcdFx0XHRjb25zdCB0b29sQ2FsbElkID0gbmVlZHNOZXdJZFxuXHRcdFx0XHRcdFx0XHRcdD8gYCR7cGFydC5mdW5jdGlvbkNhbGwubmFtZX1fJHtEYXRlLm5vdygpfV8keysrdG9vbENhbGxDb3VudGVyfWBcblx0XHRcdFx0XHRcdFx0XHQ6IHByb3ZpZGVkSWQ7XG5cblx0XHRcdFx0XHRcdFx0Y29uc3QgdG9vbENhbGw6IFRvb2xDYWxsID0ge1xuXHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidG9vbENhbGxcIixcblx0XHRcdFx0XHRcdFx0XHRpZDogdG9vbENhbGxJZCxcblx0XHRcdFx0XHRcdFx0XHRuYW1lOiBwYXJ0LmZ1bmN0aW9uQ2FsbC5uYW1lIHx8IFwiXCIsXG5cdFx0XHRcdFx0XHRcdFx0YXJndW1lbnRzOiAocGFydC5mdW5jdGlvbkNhbGwuYXJncyBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+KSA/PyB7fSxcblx0XHRcdFx0XHRcdFx0XHQuLi4ocGFydC50aG91Z2h0U2lnbmF0dXJlICYmIHsgdGhvdWdodFNpZ25hdHVyZTogcGFydC50aG91Z2h0U2lnbmF0dXJlIH0pLFxuXHRcdFx0XHRcdFx0XHR9O1xuXG5cdFx0XHRcdFx0XHRcdG91dHB1dC5jb250ZW50LnB1c2godG9vbENhbGwpO1xuXHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwidG9vbGNhbGxfc3RhcnRcIiwgY29udGVudEluZGV4OiBibG9ja0luZGV4KCksIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidG9vbGNhbGxfZGVsdGFcIixcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdFx0XHRkZWx0YTogSlNPTi5zdHJpbmdpZnkodG9vbENhbGwuYXJndW1lbnRzKSxcblx0XHRcdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwidG9vbGNhbGxfZW5kXCIsIGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLCB0b29sQ2FsbCwgcGFydGlhbDogb3V0cHV0IH0pO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChjYW5kaWRhdGU/LmZpbmlzaFJlYXNvbikge1xuXHRcdFx0XHRcdG91dHB1dC5zdG9wUmVhc29uID0gbWFwU3RvcFJlYXNvbihjYW5kaWRhdGUuZmluaXNoUmVhc29uKTtcblx0XHRcdFx0XHRpZiAob3V0cHV0LmNvbnRlbnQuc29tZSgoYikgPT4gYi50eXBlID09PSBcInRvb2xDYWxsXCIpKSB7XG5cdFx0XHRcdFx0XHRvdXRwdXQuc3RvcFJlYXNvbiA9IFwidG9vbFVzZVwiO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChjaHVuay51c2FnZU1ldGFkYXRhKSB7XG5cdFx0XHRcdFx0b3V0cHV0LnVzYWdlID0ge1xuXHRcdFx0XHRcdFx0aW5wdXQ6IGNodW5rLnVzYWdlTWV0YWRhdGEucHJvbXB0VG9rZW5Db3VudCB8fCAwLFxuXHRcdFx0XHRcdFx0b3V0cHV0OlxuXHRcdFx0XHRcdFx0XHQoY2h1bmsudXNhZ2VNZXRhZGF0YS5jYW5kaWRhdGVzVG9rZW5Db3VudCB8fCAwKSArIChjaHVuay51c2FnZU1ldGFkYXRhLnRob3VnaHRzVG9rZW5Db3VudCB8fCAwKSxcblx0XHRcdFx0XHRcdGNhY2hlUmVhZDogY2h1bmsudXNhZ2VNZXRhZGF0YS5jYWNoZWRDb250ZW50VG9rZW5Db3VudCB8fCAwLFxuXHRcdFx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdFx0XHRcdHRvdGFsVG9rZW5zOiBjaHVuay51c2FnZU1ldGFkYXRhLnRvdGFsVG9rZW5Db3VudCB8fCAwLFxuXHRcdFx0XHRcdFx0Y29zdDoge1xuXHRcdFx0XHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHRcdFx0XHRcdHRvdGFsOiAwLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdGNhbGN1bGF0ZUNvc3QobW9kZWwsIG91dHB1dC51c2FnZSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0aWYgKGN1cnJlbnRCbG9jaykge1xuXHRcdFx0XHRpZiAoY3VycmVudEJsb2NrLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0X2VuZFwiLFxuXHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0XHRjb250ZW50OiBjdXJyZW50QmxvY2sudGV4dCxcblx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRoaW5raW5nX2VuZFwiLFxuXHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0XHRjb250ZW50OiBjdXJyZW50QmxvY2sudGhpbmtpbmcsXG5cdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0aWYgKG9wdGlvbnM/LnNpZ25hbD8uYWJvcnRlZCkge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJSZXF1ZXN0IHdhcyBhYm9ydGVkXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAob3V0cHV0LnN0b3BSZWFzb24gPT09IFwiYWJvcnRlZFwiIHx8IG91dHB1dC5zdG9wUmVhc29uID09PSBcImVycm9yXCIpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiQW4gdW5rbm93biBlcnJvciBvY2N1cnJlZFwiKTtcblx0XHRcdH1cblxuXHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcImRvbmVcIiwgcmVhc29uOiBvdXRwdXQuc3RvcFJlYXNvbiwgbWVzc2FnZTogb3V0cHV0IH0pO1xuXHRcdFx0c3RyZWFtLmVuZCgpO1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHQvLyBSZW1vdmUgaW50ZXJuYWwgaW5kZXggcHJvcGVydHkgdXNlZCBkdXJpbmcgc3RyZWFtaW5nXG5cdFx0XHRmb3IgKGNvbnN0IGJsb2NrIG9mIG91dHB1dC5jb250ZW50KSB7XG5cdFx0XHRcdGlmIChcImluZGV4XCIgaW4gYmxvY2spIHtcblx0XHRcdFx0XHRkZWxldGUgKGJsb2NrIGFzIHsgaW5kZXg/OiBudW1iZXIgfSkuaW5kZXg7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdG91dHB1dC5zdG9wUmVhc29uID0gb3B0aW9ucz8uc2lnbmFsPy5hYm9ydGVkID8gXCJhYm9ydGVkXCIgOiBcImVycm9yXCI7XG5cdFx0XHRvdXRwdXQuZXJyb3JNZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBKU09OLnN0cmluZ2lmeShlcnJvcik7XG5cdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwiZXJyb3JcIiwgcmVhc29uOiBvdXRwdXQuc3RvcFJlYXNvbiwgZXJyb3I6IG91dHB1dCB9KTtcblx0XHRcdHN0cmVhbS5lbmQoKTtcblx0XHR9XG5cdH0pKCk7XG5cblx0cmV0dXJuIHN0cmVhbTtcbn07XG5cbmV4cG9ydCBjb25zdCBzdHJlYW1TaW1wbGVHb29nbGVWZXJ0ZXg6IFN0cmVhbUZ1bmN0aW9uPFwiZ29vZ2xlLXZlcnRleFwiLCBTaW1wbGVTdHJlYW1PcHRpb25zPiA9IChcblx0bW9kZWw6IE1vZGVsPFwiZ29vZ2xlLXZlcnRleFwiPixcblx0Y29udGV4dDogQ29udGV4dCxcblx0b3B0aW9ucz86IFNpbXBsZVN0cmVhbU9wdGlvbnMsXG4pOiBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0gPT4ge1xuXHRjb25zdCBiYXNlID0gYnVpbGRCYXNlT3B0aW9ucyhtb2RlbCwgb3B0aW9ucywgdW5kZWZpbmVkKTtcblx0aWYgKCFvcHRpb25zPy5yZWFzb25pbmcpIHtcblx0XHRyZXR1cm4gc3RyZWFtR29vZ2xlVmVydGV4KG1vZGVsLCBjb250ZXh0LCB7XG5cdFx0XHQuLi5iYXNlLFxuXHRcdFx0dGhpbmtpbmc6IHsgZW5hYmxlZDogZmFsc2UgfSxcblx0XHR9IHNhdGlzZmllcyBHb29nbGVWZXJ0ZXhPcHRpb25zKTtcblx0fVxuXG5cdGNvbnN0IGVmZm9ydCA9IGNsYW1wUmVhc29uaW5nKG9wdGlvbnMucmVhc29uaW5nKSE7XG5cdGNvbnN0IGdlbWluaU1vZGVsID0gbW9kZWwgYXMgdW5rbm93biBhcyBNb2RlbDxcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCI+O1xuXG5cdGlmIChpc0dlbWluaTNQcm9Nb2RlbChnZW1pbmlNb2RlbCkgfHwgaXNHZW1pbmkzRmxhc2hNb2RlbChnZW1pbmlNb2RlbCkpIHtcblx0XHRyZXR1cm4gc3RyZWFtR29vZ2xlVmVydGV4KG1vZGVsLCBjb250ZXh0LCB7XG5cdFx0XHQuLi5iYXNlLFxuXHRcdFx0dGhpbmtpbmc6IHtcblx0XHRcdFx0ZW5hYmxlZDogdHJ1ZSxcblx0XHRcdFx0bGV2ZWw6IGdldEdlbWluaTNUaGlua2luZ0xldmVsKGVmZm9ydCwgZ2VtaW5pTW9kZWwpLFxuXHRcdFx0fSxcblx0XHR9IHNhdGlzZmllcyBHb29nbGVWZXJ0ZXhPcHRpb25zKTtcblx0fVxuXG5cdHJldHVybiBzdHJlYW1Hb29nbGVWZXJ0ZXgobW9kZWwsIGNvbnRleHQsIHtcblx0XHQuLi5iYXNlLFxuXHRcdHRoaW5raW5nOiB7XG5cdFx0XHRlbmFibGVkOiB0cnVlLFxuXHRcdFx0YnVkZ2V0VG9rZW5zOiBnZXRHb29nbGVCdWRnZXQoZ2VtaW5pTW9kZWwsIGVmZm9ydCwgb3B0aW9ucy50aGlua2luZ0J1ZGdldHMpLFxuXHRcdH0sXG5cdH0gc2F0aXNmaWVzIEdvb2dsZVZlcnRleE9wdGlvbnMpO1xufTtcblxuYXN5bmMgZnVuY3Rpb24gY3JlYXRlQ2xpZW50KFxuXHRtb2RlbDogTW9kZWw8XCJnb29nbGUtdmVydGV4XCI+LFxuXHRwcm9qZWN0OiBzdHJpbmcsXG5cdGxvY2F0aW9uOiBzdHJpbmcsXG5cdG9wdGlvbnNIZWFkZXJzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcbik6IFByb21pc2U8R29vZ2xlR2VuQUk+IHtcblx0Y29uc3QgaHR0cE9wdGlvbnM6IHsgaGVhZGVycz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfSA9IHt9O1xuXG5cdGlmIChtb2RlbC5oZWFkZXJzIHx8IG9wdGlvbnNIZWFkZXJzKSB7XG5cdFx0aHR0cE9wdGlvbnMuaGVhZGVycyA9IHsgLi4ubW9kZWwuaGVhZGVycywgLi4ub3B0aW9uc0hlYWRlcnMgfTtcblx0fVxuXG5cdGNvbnN0IGhhc0h0dHBPcHRpb25zID0gT2JqZWN0LnZhbHVlcyhodHRwT3B0aW9ucykuc29tZShCb29sZWFuKTtcblx0Y29uc3QgR29vZ2xlR2VuQUlDbGFzcyA9IGF3YWl0IGdldEdvb2dsZVZlcnRleENsYXNzKCk7XG5cblx0cmV0dXJuIG5ldyBHb29nbGVHZW5BSUNsYXNzKHtcblx0XHR2ZXJ0ZXhhaTogdHJ1ZSxcblx0XHRwcm9qZWN0LFxuXHRcdGxvY2F0aW9uLFxuXHRcdGFwaVZlcnNpb246IEFQSV9WRVJTSU9OLFxuXHRcdGh0dHBPcHRpb25zOiBoYXNIdHRwT3B0aW9ucyA/IGh0dHBPcHRpb25zIDogdW5kZWZpbmVkLFxuXHR9KTtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVByb2plY3Qob3B0aW9ucz86IEdvb2dsZVZlcnRleE9wdGlvbnMpOiBzdHJpbmcge1xuXHRjb25zdCBwcm9qZWN0ID0gb3B0aW9ucz8ucHJvamVjdCB8fCBwcm9jZXNzLmVudi5HT09HTEVfQ0xPVURfUFJPSkVDVCB8fCBwcm9jZXNzLmVudi5HQ0xPVURfUFJPSkVDVDtcblx0aWYgKCFwcm9qZWN0KSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKFxuXHRcdFx0XCJWZXJ0ZXggQUkgcmVxdWlyZXMgYSBwcm9qZWN0IElELiBTZXQgR09PR0xFX0NMT1VEX1BST0pFQ1QvR0NMT1VEX1BST0pFQ1Qgb3IgcGFzcyBwcm9qZWN0IGluIG9wdGlvbnMuXCIsXG5cdFx0KTtcblx0fVxuXHRyZXR1cm4gcHJvamVjdDtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZUxvY2F0aW9uKG9wdGlvbnM/OiBHb29nbGVWZXJ0ZXhPcHRpb25zKTogc3RyaW5nIHtcblx0Y29uc3QgbG9jYXRpb24gPSBvcHRpb25zPy5sb2NhdGlvbiB8fCBwcm9jZXNzLmVudi5HT09HTEVfQ0xPVURfTE9DQVRJT047XG5cdGlmICghbG9jYXRpb24pIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoXCJWZXJ0ZXggQUkgcmVxdWlyZXMgYSBsb2NhdGlvbi4gU2V0IEdPT0dMRV9DTE9VRF9MT0NBVElPTiBvciBwYXNzIGxvY2F0aW9uIGluIG9wdGlvbnMuXCIpO1xuXHR9XG5cdHJldHVybiBsb2NhdGlvbjtcbn1cblxuZnVuY3Rpb24gYnVpbGRQYXJhbXMoXG5cdG1vZGVsOiBNb2RlbDxcImdvb2dsZS12ZXJ0ZXhcIj4sXG5cdGNvbnRleHQ6IENvbnRleHQsXG5cdG9wdGlvbnM6IEdvb2dsZVZlcnRleE9wdGlvbnMgPSB7fSxcbik6IEdlbmVyYXRlQ29udGVudFBhcmFtZXRlcnMge1xuXHRjb25zdCBjb250ZW50cyA9IGNvbnZlcnRNZXNzYWdlcyhtb2RlbCwgY29udGV4dCk7XG5cblx0Y29uc3QgZ2VuZXJhdGlvbkNvbmZpZzogR2VuZXJhdGVDb250ZW50Q29uZmlnID0ge307XG5cdGlmIChvcHRpb25zLnRlbXBlcmF0dXJlICE9PSB1bmRlZmluZWQpIHtcblx0XHRnZW5lcmF0aW9uQ29uZmlnLnRlbXBlcmF0dXJlID0gb3B0aW9ucy50ZW1wZXJhdHVyZTtcblx0fVxuXHRpZiAob3B0aW9ucy5tYXhUb2tlbnMgIT09IHVuZGVmaW5lZCkge1xuXHRcdGdlbmVyYXRpb25Db25maWcubWF4T3V0cHV0VG9rZW5zID0gb3B0aW9ucy5tYXhUb2tlbnM7XG5cdH1cblxuXHRjb25zdCBjb25maWc6IEdlbmVyYXRlQ29udGVudENvbmZpZyA9IHtcblx0XHQuLi4oT2JqZWN0LmtleXMoZ2VuZXJhdGlvbkNvbmZpZykubGVuZ3RoID4gMCAmJiBnZW5lcmF0aW9uQ29uZmlnKSxcblx0XHQuLi4oY29udGV4dC5zeXN0ZW1Qcm9tcHQgJiYgeyBzeXN0ZW1JbnN0cnVjdGlvbjogc2FuaXRpemVTdXJyb2dhdGVzKGNvbnRleHQuc3lzdGVtUHJvbXB0KSB9KSxcblx0XHQuLi4oY29udGV4dC50b29scyAmJiBjb250ZXh0LnRvb2xzLmxlbmd0aCA+IDAgJiYgeyB0b29sczogY29udmVydFRvb2xzKGNvbnRleHQudG9vbHMpIH0pLFxuXHR9O1xuXG5cdGlmIChjb250ZXh0LnRvb2xzICYmIGNvbnRleHQudG9vbHMubGVuZ3RoID4gMCAmJiBvcHRpb25zLnRvb2xDaG9pY2UpIHtcblx0XHRjb25maWcudG9vbENvbmZpZyA9IHtcblx0XHRcdGZ1bmN0aW9uQ2FsbGluZ0NvbmZpZzoge1xuXHRcdFx0XHRtb2RlOiBtYXBUb29sQ2hvaWNlKG9wdGlvbnMudG9vbENob2ljZSksXG5cdFx0XHR9LFxuXHRcdH07XG5cdH0gZWxzZSB7XG5cdFx0Y29uZmlnLnRvb2xDb25maWcgPSB1bmRlZmluZWQ7XG5cdH1cblxuXHRpZiAob3B0aW9ucy50aGlua2luZz8uZW5hYmxlZCAmJiBtb2RlbC5yZWFzb25pbmcpIHtcblx0XHRjb25zdCB0aGlua2luZ0NvbmZpZzogVGhpbmtpbmdDb25maWcgPSB7IGluY2x1ZGVUaG91Z2h0czogdHJ1ZSB9O1xuXHRcdGlmIChvcHRpb25zLnRoaW5raW5nLmxldmVsICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdC8vIENhc3Qgc2FmZTogc3RyaW5nIHZhbHVlcyBtYXRjaCBUaGlua2luZ0xldmVsIGVudW0gdmFsdWVzIGV4YWN0bHlcblx0XHRcdC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tZXhwbGljaXQtYW55XG5cdFx0XHR0aGlua2luZ0NvbmZpZy50aGlua2luZ0xldmVsID0gVEhJTktJTkdfTEVWRUxfTUFQW29wdGlvbnMudGhpbmtpbmcubGV2ZWxdIGFzIGFueTtcblx0XHR9IGVsc2UgaWYgKG9wdGlvbnMudGhpbmtpbmcuYnVkZ2V0VG9rZW5zICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdHRoaW5raW5nQ29uZmlnLnRoaW5raW5nQnVkZ2V0ID0gb3B0aW9ucy50aGlua2luZy5idWRnZXRUb2tlbnM7XG5cdFx0fVxuXHRcdGNvbmZpZy50aGlua2luZ0NvbmZpZyA9IHRoaW5raW5nQ29uZmlnO1xuXHR9XG5cblx0aWYgKG9wdGlvbnMuc2lnbmFsKSB7XG5cdFx0aWYgKG9wdGlvbnMuc2lnbmFsLmFib3J0ZWQpIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihcIlJlcXVlc3QgYWJvcnRlZFwiKTtcblx0XHR9XG5cdFx0Y29uZmlnLmFib3J0U2lnbmFsID0gb3B0aW9ucy5zaWduYWw7XG5cdH1cblxuXHRjb25zdCBwYXJhbXM6IEdlbmVyYXRlQ29udGVudFBhcmFtZXRlcnMgPSB7XG5cdFx0bW9kZWw6IG1vZGVsLmlkLFxuXHRcdGNvbnRlbnRzLFxuXHRcdGNvbmZpZyxcblx0fTtcblxuXHRyZXR1cm4gcGFyYW1zO1xufVxuXG50eXBlIENsYW1wZWRUaGlua2luZ0xldmVsID0gRXhjbHVkZTxQaVRoaW5raW5nTGV2ZWwsIFwieGhpZ2hcIj47XG5cbmZ1bmN0aW9uIGlzR2VtaW5pM1Byb01vZGVsKG1vZGVsOiBNb2RlbDxcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCI+KTogYm9vbGVhbiB7XG5cdHJldHVybiAvZ2VtaW5pLTMoPzpcXC5cXGQrKT8tcHJvLy50ZXN0KG1vZGVsLmlkLnRvTG93ZXJDYXNlKCkpO1xufVxuXG5mdW5jdGlvbiBpc0dlbWluaTNGbGFzaE1vZGVsKG1vZGVsOiBNb2RlbDxcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCI+KTogYm9vbGVhbiB7XG5cdHJldHVybiAvZ2VtaW5pLTMoPzpcXC5cXGQrKT8tZmxhc2gvLnRlc3QobW9kZWwuaWQudG9Mb3dlckNhc2UoKSk7XG59XG5cbmZ1bmN0aW9uIGdldEdlbWluaTNUaGlua2luZ0xldmVsKFxuXHRlZmZvcnQ6IENsYW1wZWRUaGlua2luZ0xldmVsLFxuXHRtb2RlbDogTW9kZWw8XCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiPixcbik6IEdvb2dsZVRoaW5raW5nTGV2ZWwge1xuXHRpZiAoaXNHZW1pbmkzUHJvTW9kZWwobW9kZWwpKSB7XG5cdFx0c3dpdGNoIChlZmZvcnQpIHtcblx0XHRcdGNhc2UgXCJtaW5pbWFsXCI6XG5cdFx0XHRjYXNlIFwibG93XCI6XG5cdFx0XHRcdHJldHVybiBcIkxPV1wiO1xuXHRcdFx0Y2FzZSBcIm1lZGl1bVwiOlxuXHRcdFx0Y2FzZSBcImhpZ2hcIjpcblx0XHRcdFx0cmV0dXJuIFwiSElHSFwiO1xuXHRcdH1cblx0fVxuXHRzd2l0Y2ggKGVmZm9ydCkge1xuXHRcdGNhc2UgXCJtaW5pbWFsXCI6XG5cdFx0XHRyZXR1cm4gXCJNSU5JTUFMXCI7XG5cdFx0Y2FzZSBcImxvd1wiOlxuXHRcdFx0cmV0dXJuIFwiTE9XXCI7XG5cdFx0Y2FzZSBcIm1lZGl1bVwiOlxuXHRcdFx0cmV0dXJuIFwiTUVESVVNXCI7XG5cdFx0Y2FzZSBcImhpZ2hcIjpcblx0XHRcdHJldHVybiBcIkhJR0hcIjtcblx0fVxufVxuXG5mdW5jdGlvbiBnZXRHb29nbGVCdWRnZXQoXG5cdG1vZGVsOiBNb2RlbDxcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCI+LFxuXHRlZmZvcnQ6IENsYW1wZWRUaGlua2luZ0xldmVsLFxuXHRjdXN0b21CdWRnZXRzPzogVGhpbmtpbmdCdWRnZXRzLFxuKTogbnVtYmVyIHtcblx0aWYgKGN1c3RvbUJ1ZGdldHM/LltlZmZvcnRdICE9PSB1bmRlZmluZWQpIHtcblx0XHRyZXR1cm4gY3VzdG9tQnVkZ2V0c1tlZmZvcnRdITtcblx0fVxuXG5cdGlmIChtb2RlbC5pZC5pbmNsdWRlcyhcIjIuNS1wcm9cIikpIHtcblx0XHRjb25zdCBidWRnZXRzOiBSZWNvcmQ8Q2xhbXBlZFRoaW5raW5nTGV2ZWwsIG51bWJlcj4gPSB7XG5cdFx0XHRtaW5pbWFsOiAxMjgsXG5cdFx0XHRsb3c6IDIwNDgsXG5cdFx0XHRtZWRpdW06IDgxOTIsXG5cdFx0XHRoaWdoOiAzMjc2OCxcblx0XHR9O1xuXHRcdHJldHVybiBidWRnZXRzW2VmZm9ydF07XG5cdH1cblxuXHRpZiAobW9kZWwuaWQuaW5jbHVkZXMoXCIyLjUtZmxhc2hcIikpIHtcblx0XHRjb25zdCBidWRnZXRzOiBSZWNvcmQ8Q2xhbXBlZFRoaW5raW5nTGV2ZWwsIG51bWJlcj4gPSB7XG5cdFx0XHRtaW5pbWFsOiAxMjgsXG5cdFx0XHRsb3c6IDIwNDgsXG5cdFx0XHRtZWRpdW06IDgxOTIsXG5cdFx0XHRoaWdoOiAyNDU3Nixcblx0XHR9O1xuXHRcdHJldHVybiBidWRnZXRzW2VmZm9ydF07XG5cdH1cblxuXHRyZXR1cm4gLTE7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFRQSxTQUFTLHFCQUFxQjtBQWU5QixTQUFTLG1DQUFtQztBQUM1QyxTQUFTLDBCQUEwQjtBQUVuQztBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFDUCxTQUFTLGtCQUFrQixzQkFBc0I7QUFFakQsSUFBSTtBQUNKLGVBQWUsdUJBQW9EO0FBQ2xFLE1BQUksQ0FBQyxvQkFB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
