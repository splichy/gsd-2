import { calculateCost } from "../models.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
  convertMessages,
  convertTools,
  isThinkingPart,
  mapStopReasonString,
  mapToolChoice,
  retainThoughtSignature
} from "./google-shared.js";
import { buildBaseOptions, clampReasoning } from "./simple-options.js";
const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_AUTOPUSH_ENDPOINT = "https://autopush-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
  ANTIGRAVITY_DAILY_ENDPOINT,
  ANTIGRAVITY_AUTOPUSH_ENDPOINT,
  DEFAULT_ENDPOINT
];
const GEMINI_CLI_HEADERS = {
  "User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "X-Goog-Api-Client": "gl-node/22.17.0",
  "Client-Metadata": JSON.stringify({
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI"
  })
};
const DEFAULT_ANTIGRAVITY_VERSION = "1.18.4";
function getAntigravityHeaders() {
  const version = process.env.PI_AI_ANTIGRAVITY_VERSION || DEFAULT_ANTIGRAVITY_VERSION;
  return {
    "User-Agent": `antigravity/${version} darwin/arm64`
  };
}
const ANTIGRAVITY_SYSTEM_INSTRUCTION = "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";
let toolCallCounter = 0;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1e3;
const MAX_EMPTY_STREAM_RETRIES = 2;
const EMPTY_STREAM_BASE_DELAY_MS = 500;
const CLAUDE_THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";
function extractRetryDelay(errorText, response) {
  const normalizeDelay = (ms) => ms > 0 ? Math.ceil(ms + 1e3) : void 0;
  const headers = response instanceof Headers ? response : response?.headers;
  if (headers) {
    const retryAfter = headers.get("retry-after");
    if (retryAfter) {
      const retryAfterSeconds = Number(retryAfter);
      if (Number.isFinite(retryAfterSeconds)) {
        const delay = normalizeDelay(retryAfterSeconds * 1e3);
        if (delay !== void 0) {
          return delay;
        }
      }
      const retryAfterDate = new Date(retryAfter);
      const retryAfterMs = retryAfterDate.getTime();
      if (!Number.isNaN(retryAfterMs)) {
        const delay = normalizeDelay(retryAfterMs - Date.now());
        if (delay !== void 0) {
          return delay;
        }
      }
    }
    const rateLimitReset = headers.get("x-ratelimit-reset");
    if (rateLimitReset) {
      const resetSeconds = Number.parseInt(rateLimitReset, 10);
      if (!Number.isNaN(resetSeconds)) {
        const delay = normalizeDelay(resetSeconds * 1e3 - Date.now());
        if (delay !== void 0) {
          return delay;
        }
      }
    }
    const rateLimitResetAfter = headers.get("x-ratelimit-reset-after");
    if (rateLimitResetAfter) {
      const resetAfterSeconds = Number(rateLimitResetAfter);
      if (Number.isFinite(resetAfterSeconds)) {
        const delay = normalizeDelay(resetAfterSeconds * 1e3);
        if (delay !== void 0) {
          return delay;
        }
      }
    }
  }
  const durationMatch = errorText.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
  if (durationMatch) {
    const hours = durationMatch[1] ? parseInt(durationMatch[1], 10) : 0;
    const minutes = durationMatch[2] ? parseInt(durationMatch[2], 10) : 0;
    const seconds = parseFloat(durationMatch[3]);
    if (!Number.isNaN(seconds)) {
      const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1e3;
      const delay = normalizeDelay(totalMs);
      if (delay !== void 0) {
        return delay;
      }
    }
  }
  const retryInMatch = errorText.match(/Please retry in ([0-9.]+)(ms|s)/i);
  if (retryInMatch?.[1]) {
    const value = parseFloat(retryInMatch[1]);
    if (!Number.isNaN(value) && value > 0) {
      const ms = retryInMatch[2].toLowerCase() === "ms" ? value : value * 1e3;
      const delay = normalizeDelay(ms);
      if (delay !== void 0) {
        return delay;
      }
    }
  }
  const retryDelayMatch = errorText.match(/"retryDelay":\s*"([0-9.]+)(ms|s)"/i);
  if (retryDelayMatch?.[1]) {
    const value = parseFloat(retryDelayMatch[1]);
    if (!Number.isNaN(value) && value > 0) {
      const ms = retryDelayMatch[2].toLowerCase() === "ms" ? value : value * 1e3;
      const delay = normalizeDelay(ms);
      if (delay !== void 0) {
        return delay;
      }
    }
  }
  return void 0;
}
function needsClaudeThinkingBetaHeader(model) {
  return model.provider === "google-antigravity" && model.id.startsWith("claude-") && model.reasoning;
}
function isGemini3ProModel(modelId) {
  return /gemini-3(?:\.1)?-pro/.test(modelId.toLowerCase());
}
function isGemini3FlashModel(modelId) {
  return /gemini-3(?:\.1)?-flash/.test(modelId.toLowerCase());
}
function isGemini3Model(modelId) {
  return isGemini3ProModel(modelId) || isGemini3FlashModel(modelId);
}
function isRetryableError(status, errorText) {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return /resource.?exhausted|rate.?limit|overloaded|service.?unavailable|other.?side.?closed/i.test(errorText);
}
function extractErrorMessage(errorText) {
  try {
    const parsed = JSON.parse(errorText);
    if (parsed.error?.message) {
      return parsed.error.message;
    }
  } catch {
  }
  return errorText;
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request was aborted"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("Request was aborted"));
    });
  });
}
const streamGoogleGeminiCli = (model, context, options) => {
  const stream = new AssistantMessageEventStream();
  (async () => {
    const output = {
      role: "assistant",
      content: [],
      api: "google-gemini-cli",
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
      const apiKeyRaw = options?.apiKey;
      if (!apiKeyRaw) {
        throw new Error("Google Cloud Code Assist requires OAuth authentication. Use /login to authenticate.");
      }
      let accessToken;
      let projectId;
      try {
        const parsed = JSON.parse(apiKeyRaw);
        accessToken = parsed.token;
        projectId = parsed.projectId;
      } catch {
        throw new Error("Invalid Google Cloud Code Assist credentials. Use /login to re-authenticate.");
      }
      if (!accessToken || !projectId) {
        throw new Error("Missing token or projectId in Google Cloud credentials. Use /login to re-authenticate.");
      }
      const isAntigravity = model.provider === "google-antigravity";
      const baseUrl = model.baseUrl?.trim();
      const endpoints = baseUrl ? [baseUrl] : isAntigravity ? ANTIGRAVITY_ENDPOINT_FALLBACKS : [DEFAULT_ENDPOINT];
      let requestBody = buildRequest(model, context, projectId, options, isAntigravity);
      const nextRequestBody = await options?.onPayload?.(requestBody, model);
      if (nextRequestBody !== void 0) {
        requestBody = nextRequestBody;
      }
      const headers = isAntigravity ? getAntigravityHeaders() : GEMINI_CLI_HEADERS;
      const requestHeaders = {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...headers,
        ...needsClaudeThinkingBetaHeader(model) ? { "anthropic-beta": CLAUDE_THINKING_BETA_HEADER } : {},
        ...options?.headers
      };
      const requestBodyJson = JSON.stringify(requestBody);
      let response;
      let lastError;
      let requestUrl;
      let endpointIndex = 0;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        try {
          const endpoint = endpoints[endpointIndex];
          requestUrl = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;
          response = await fetch(requestUrl, {
            method: "POST",
            headers: requestHeaders,
            body: requestBodyJson,
            signal: options?.signal
          });
          if (response.ok) {
            break;
          }
          const errorText = await response.text();
          if ((response.status === 403 || response.status === 404) && endpointIndex < endpoints.length - 1) {
            endpointIndex++;
            continue;
          }
          if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
            if (endpointIndex < endpoints.length - 1) {
              endpointIndex++;
            }
            const serverDelay = extractRetryDelay(errorText, response);
            const delayMs = serverDelay ?? BASE_DELAY_MS * 2 ** attempt;
            const maxDelayMs = options?.maxRetryDelayMs ?? 6e4;
            if (maxDelayMs > 0 && serverDelay && serverDelay > maxDelayMs) {
              const delaySeconds = Math.ceil(serverDelay / 1e3);
              throw new Error(
                `Server requested ${delaySeconds}s retry delay (max: ${Math.ceil(maxDelayMs / 1e3)}s). ${extractErrorMessage(errorText)}`
              );
            }
            await sleep(delayMs, options?.signal);
            continue;
          }
          if (response.status === 404) {
            throw new Error(
              `Cloud Code Assist API error (404): Model "${model.id}" was not found. This model may not be available via Cloud Code Assist. Try using the "google" provider with a GOOGLE_API_KEY instead, or switch to a supported model (e.g., gemini-2.5-pro).`
            );
          }
          throw new Error(`Cloud Code Assist API error (${response.status}): ${extractErrorMessage(errorText)}`);
        } catch (error) {
          if (error instanceof Error) {
            if (error.name === "AbortError" || error.message === "Request was aborted") {
              throw new Error("Request was aborted");
            }
          }
          lastError = error instanceof Error ? error : new Error(String(error));
          if (lastError.message === "fetch failed" && lastError.cause instanceof Error) {
            lastError = new Error(`Network error: ${lastError.cause.message}`);
          }
          if (attempt < MAX_RETRIES) {
            const delayMs = BASE_DELAY_MS * 2 ** attempt;
            await sleep(delayMs, options?.signal);
            continue;
          }
          throw lastError;
        }
      }
      if (!response || !response.ok) {
        throw lastError ?? new Error("Failed to get response after retries");
      }
      let started = false;
      const ensureStarted = () => {
        if (!started) {
          stream.push({ type: "start", partial: output });
          started = true;
        }
      };
      const resetOutput = () => {
        output.content = [];
        output.usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        };
        output.stopReason = "stop";
        output.errorMessage = void 0;
        output.timestamp = Date.now();
        started = false;
      };
      const streamResponse = async (activeResponse) => {
        if (!activeResponse.body) {
          throw new Error("No response body");
        }
        let hasContent = false;
        let currentBlock = null;
        const blocks = output.content;
        const blockIndex = () => blocks.length - 1;
        const reader = activeResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const abortHandler = () => {
          void reader.cancel().catch(() => {
          });
        };
        options?.signal?.addEventListener("abort", abortHandler);
        try {
          while (true) {
            if (options?.signal?.aborted) {
              throw new Error("Request was aborted");
            }
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const jsonStr = line.slice(5).trim();
              if (!jsonStr) continue;
              let chunk;
              try {
                chunk = JSON.parse(jsonStr);
              } catch {
                continue;
              }
              const responseData = chunk.response;
              if (!responseData) continue;
              const candidate = responseData.candidates?.[0];
              if (candidate?.content?.parts) {
                for (const part of candidate.content.parts) {
                  if (part.text !== void 0) {
                    hasContent = true;
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
                        ensureStarted();
                        stream.push({
                          type: "thinking_start",
                          contentIndex: blockIndex(),
                          partial: output
                        });
                      } else {
                        currentBlock = { type: "text", text: "" };
                        output.content.push(currentBlock);
                        ensureStarted();
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
                    hasContent = true;
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
                    ensureStarted();
                    stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
                    stream.push({
                      type: "toolcall_delta",
                      contentIndex: blockIndex(),
                      delta: JSON.stringify(toolCall.arguments),
                      partial: output
                    });
                    stream.push({
                      type: "toolcall_end",
                      contentIndex: blockIndex(),
                      toolCall,
                      partial: output
                    });
                  }
                }
              }
              if (candidate?.finishReason) {
                output.stopReason = mapStopReasonString(candidate.finishReason);
                if (output.content.some((b) => b.type === "toolCall")) {
                  output.stopReason = "toolUse";
                }
              }
              if (responseData.usageMetadata) {
                const promptTokens = responseData.usageMetadata.promptTokenCount || 0;
                const cacheReadTokens = responseData.usageMetadata.cachedContentTokenCount || 0;
                output.usage = {
                  input: promptTokens - cacheReadTokens,
                  output: (responseData.usageMetadata.candidatesTokenCount || 0) + (responseData.usageMetadata.thoughtsTokenCount || 0),
                  cacheRead: cacheReadTokens,
                  cacheWrite: 0,
                  totalTokens: responseData.usageMetadata.totalTokenCount || 0,
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
          }
        } finally {
          options?.signal?.removeEventListener("abort", abortHandler);
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
        return hasContent;
      };
      let receivedContent = false;
      let currentResponse = response;
      for (let emptyAttempt = 0; emptyAttempt <= MAX_EMPTY_STREAM_RETRIES; emptyAttempt++) {
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (emptyAttempt > 0) {
          const backoffMs = EMPTY_STREAM_BASE_DELAY_MS * 2 ** (emptyAttempt - 1);
          await sleep(backoffMs, options?.signal);
          if (!requestUrl) {
            throw new Error("Missing request URL");
          }
          currentResponse = await fetch(requestUrl, {
            method: "POST",
            headers: requestHeaders,
            body: requestBodyJson,
            signal: options?.signal
          });
          if (!currentResponse.ok) {
            const retryErrorText = await currentResponse.text();
            throw new Error(`Cloud Code Assist API error (${currentResponse.status}): ${retryErrorText}`);
          }
        }
        const streamed = await streamResponse(currentResponse);
        if (streamed) {
          receivedContent = true;
          break;
        }
        if (emptyAttempt < MAX_EMPTY_STREAM_RETRIES) {
          resetOutput();
        }
      }
      if (!receivedContent) {
        throw new Error("Cloud Code Assist API returned an empty response");
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
const streamSimpleGoogleGeminiCli = (model, context, options) => {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error("Google Cloud Code Assist requires OAuth authentication. Use /login to authenticate.");
  }
  const base = buildBaseOptions(model, options, apiKey);
  if (!options?.reasoning) {
    return streamGoogleGeminiCli(model, context, {
      ...base,
      thinking: { enabled: false }
    });
  }
  const effort = clampReasoning(options.reasoning);
  if (isGemini3Model(model.id)) {
    return streamGoogleGeminiCli(model, context, {
      ...base,
      thinking: {
        enabled: true,
        level: getGeminiCliThinkingLevel(effort, model.id)
      }
    });
  }
  const defaultBudgets = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384
  };
  const budgets = { ...defaultBudgets, ...options.thinkingBudgets };
  const minOutputTokens = 1024;
  let thinkingBudget = budgets[effort];
  const maxTokens = Math.min((base.maxTokens || 0) + thinkingBudget, model.maxTokens);
  if (maxTokens <= thinkingBudget) {
    thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
  }
  return streamGoogleGeminiCli(model, context, {
    ...base,
    maxTokens,
    thinking: {
      enabled: true,
      budgetTokens: thinkingBudget
    }
  });
};
function buildRequest(model, context, projectId, options = {}, isAntigravity = false) {
  const contents = convertMessages(model, context);
  const generationConfig = {};
  if (options.temperature !== void 0) {
    generationConfig.temperature = options.temperature;
  }
  if (options.maxTokens !== void 0) {
    generationConfig.maxOutputTokens = options.maxTokens;
  }
  if (options.thinking?.enabled && model.reasoning) {
    generationConfig.thinkingConfig = {
      includeThoughts: true
    };
    if (options.thinking.level !== void 0) {
      generationConfig.thinkingConfig.thinkingLevel = options.thinking.level;
    } else if (options.thinking.budgetTokens !== void 0) {
      generationConfig.thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
    }
  }
  const request = {
    contents
  };
  request.sessionId = options.sessionId;
  if (context.systemPrompt) {
    request.systemInstruction = {
      parts: [{ text: sanitizeSurrogates(context.systemPrompt) }]
    };
  }
  if (Object.keys(generationConfig).length > 0) {
    request.generationConfig = generationConfig;
  }
  if (context.tools && context.tools.length > 0) {
    const useParameters = model.id.startsWith("claude-");
    request.tools = convertTools(context.tools, useParameters);
    if (options.toolChoice) {
      request.toolConfig = {
        functionCallingConfig: {
          mode: mapToolChoice(options.toolChoice)
        }
      };
    }
  }
  if (isAntigravity) {
    const existingParts = request.systemInstruction?.parts ?? [];
    request.systemInstruction = {
      role: "user",
      parts: [
        { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
        { text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
        ...existingParts
      ]
    };
  }
  return {
    project: projectId,
    model: model.id,
    request,
    ...isAntigravity ? { requestType: "agent" } : {},
    userAgent: isAntigravity ? "antigravity" : "pi-coding-agent",
    requestId: `${isAntigravity ? "agent" : "pi"}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  };
}
function getGeminiCliThinkingLevel(effort, modelId) {
  if (isGemini3ProModel(modelId)) {
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
export {
  streamGoogleGeminiCli,
  streamSimpleGoogleGeminiCli
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy9nb29nbGUtZ2VtaW5pLWNsaS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHb29nbGUgR2VtaW5pIENMSSAvIEFudGlncmF2aXR5IHByb3ZpZGVyLlxuICogU2hhcmVkIGltcGxlbWVudGF0aW9uIGZvciBib3RoIGdvb2dsZS1nZW1pbmktY2xpIGFuZCBnb29nbGUtYW50aWdyYXZpdHkgcHJvdmlkZXJzLlxuICogVXNlcyB0aGUgQ2xvdWQgQ29kZSBBc3Npc3QgQVBJIGVuZHBvaW50IHRvIGFjY2VzcyBHZW1pbmkgYW5kIENsYXVkZSBtb2RlbHMuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBDb250ZW50LCBUaGlua2luZ0NvbmZpZyB9IGZyb20gXCJAZ29vZ2xlL2dlbmFpXCI7XG5pbXBvcnQgeyBjYWxjdWxhdGVDb3N0IH0gZnJvbSBcIi4uL21vZGVscy5qc1wiO1xuaW1wb3J0IHR5cGUge1xuXHRBcGksXG5cdEFzc2lzdGFudE1lc3NhZ2UsXG5cdENvbnRleHQsXG5cdE1vZGVsLFxuXHRTaW1wbGVTdHJlYW1PcHRpb25zLFxuXHRTdHJlYW1GdW5jdGlvbixcblx0U3RyZWFtT3B0aW9ucyxcblx0VGV4dENvbnRlbnQsXG5cdFRoaW5raW5nQnVkZ2V0cyxcblx0VGhpbmtpbmdDb250ZW50LFxuXHRUaGlua2luZ0xldmVsLFxuXHRUb29sQ2FsbCxcbn0gZnJvbSBcIi4uL3R5cGVzLmpzXCI7XG5pbXBvcnQgeyBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0gfSBmcm9tIFwiLi4vdXRpbHMvZXZlbnQtc3RyZWFtLmpzXCI7XG5pbXBvcnQgeyBzYW5pdGl6ZVN1cnJvZ2F0ZXMgfSBmcm9tIFwiLi4vdXRpbHMvc2FuaXRpemUtdW5pY29kZS5qc1wiO1xuaW1wb3J0IHtcblx0Y29udmVydE1lc3NhZ2VzLFxuXHRjb252ZXJ0VG9vbHMsXG5cdGlzVGhpbmtpbmdQYXJ0LFxuXHRtYXBTdG9wUmVhc29uU3RyaW5nLFxuXHRtYXBUb29sQ2hvaWNlLFxuXHRyZXRhaW5UaG91Z2h0U2lnbmF0dXJlLFxufSBmcm9tIFwiLi9nb29nbGUtc2hhcmVkLmpzXCI7XG5pbXBvcnQgeyBidWlsZEJhc2VPcHRpb25zLCBjbGFtcFJlYXNvbmluZyB9IGZyb20gXCIuL3NpbXBsZS1vcHRpb25zLmpzXCI7XG5cbi8qKlxuICogVGhpbmtpbmcgbGV2ZWwgZm9yIEdlbWluaSAzIG1vZGVscy5cbiAqIE1pcnJvcnMgR29vZ2xlJ3MgVGhpbmtpbmdMZXZlbCBlbnVtIHZhbHVlcy5cbiAqL1xuZXhwb3J0IHR5cGUgR29vZ2xlVGhpbmtpbmdMZXZlbCA9IFwiVEhJTktJTkdfTEVWRUxfVU5TUEVDSUZJRURcIiB8IFwiTUlOSU1BTFwiIHwgXCJMT1dcIiB8IFwiTUVESVVNXCIgfCBcIkhJR0hcIjtcblxuZXhwb3J0IGludGVyZmFjZSBHb29nbGVHZW1pbmlDbGlPcHRpb25zIGV4dGVuZHMgU3RyZWFtT3B0aW9ucyB7XG5cdHRvb2xDaG9pY2U/OiBcImF1dG9cIiB8IFwibm9uZVwiIHwgXCJhbnlcIjtcblx0LyoqXG5cdCAqIFRoaW5raW5nL3JlYXNvbmluZyBjb25maWd1cmF0aW9uLlxuXHQgKiAtIEdlbWluaSAyLnggbW9kZWxzOiB1c2UgYGJ1ZGdldFRva2Vuc2AgdG8gc2V0IHRoZSB0aGlua2luZyBidWRnZXRcblx0ICogLSBHZW1pbmkgMyBtb2RlbHMgKGdlbWluaS0zLXByby0qLCBnZW1pbmktMy1mbGFzaC0qKTogdXNlIGBsZXZlbGAgaW5zdGVhZFxuXHQgKlxuXHQgKiBXaGVuIHVzaW5nIGBzdHJlYW1TaW1wbGVgLCB0aGlzIGlzIGhhbmRsZWQgYXV0b21hdGljYWxseSBiYXNlZCBvbiB0aGUgbW9kZWwuXG5cdCAqL1xuXHR0aGlua2luZz86IHtcblx0XHRlbmFibGVkOiBib29sZWFuO1xuXHRcdC8qKiBUaGlua2luZyBidWRnZXQgaW4gdG9rZW5zLiBVc2UgZm9yIEdlbWluaSAyLnggbW9kZWxzLiAqL1xuXHRcdGJ1ZGdldFRva2Vucz86IG51bWJlcjtcblx0XHQvKiogVGhpbmtpbmcgbGV2ZWwuIFVzZSBmb3IgR2VtaW5pIDMgbW9kZWxzIChMT1cvSElHSCBmb3IgUHJvLCBNSU5JTUFML0xPVy9NRURJVU0vSElHSCBmb3IgRmxhc2gpLiAqL1xuXHRcdGxldmVsPzogR29vZ2xlVGhpbmtpbmdMZXZlbDtcblx0fTtcblx0cHJvamVjdElkPzogc3RyaW5nO1xufVxuXG5jb25zdCBERUZBVUxUX0VORFBPSU5UID0gXCJodHRwczovL2Nsb3VkY29kZS1wYS5nb29nbGVhcGlzLmNvbVwiO1xuY29uc3QgQU5USUdSQVZJVFlfREFJTFlfRU5EUE9JTlQgPSBcImh0dHBzOi8vZGFpbHktY2xvdWRjb2RlLXBhLnNhbmRib3guZ29vZ2xlYXBpcy5jb21cIjtcbmNvbnN0IEFOVElHUkFWSVRZX0FVVE9QVVNIX0VORFBPSU5UID0gXCJodHRwczovL2F1dG9wdXNoLWNsb3VkY29kZS1wYS5zYW5kYm94Lmdvb2dsZWFwaXMuY29tXCI7XG5jb25zdCBBTlRJR1JBVklUWV9FTkRQT0lOVF9GQUxMQkFDS1MgPSBbXG5cdEFOVElHUkFWSVRZX0RBSUxZX0VORFBPSU5ULFxuXHRBTlRJR1JBVklUWV9BVVRPUFVTSF9FTkRQT0lOVCxcblx0REVGQVVMVF9FTkRQT0lOVCxcbl0gYXMgY29uc3Q7XG4vLyBIZWFkZXJzIGZvciBHZW1pbmkgQ0xJIChwcm9kIGVuZHBvaW50KVxuY29uc3QgR0VNSU5JX0NMSV9IRUFERVJTID0ge1xuXHRcIlVzZXItQWdlbnRcIjogXCJnb29nbGUtY2xvdWQtc2RrIHZzY29kZV9jbG91ZHNoZWxsZWRpdG9yLzAuMVwiLFxuXHRcIlgtR29vZy1BcGktQ2xpZW50XCI6IFwiZ2wtbm9kZS8yMi4xNy4wXCIsXG5cdFwiQ2xpZW50LU1ldGFkYXRhXCI6IEpTT04uc3RyaW5naWZ5KHtcblx0XHRpZGVUeXBlOiBcIklERV9VTlNQRUNJRklFRFwiLFxuXHRcdHBsYXRmb3JtOiBcIlBMQVRGT1JNX1VOU1BFQ0lGSUVEXCIsXG5cdFx0cGx1Z2luVHlwZTogXCJHRU1JTklcIixcblx0fSksXG59O1xuXG4vLyBIZWFkZXJzIGZvciBBbnRpZ3Jhdml0eSAoc2FuZGJveCBlbmRwb2ludCkgLSByZXF1aXJlcyBzcGVjaWZpYyBVc2VyLUFnZW50XG5jb25zdCBERUZBVUxUX0FOVElHUkFWSVRZX1ZFUlNJT04gPSBcIjEuMTguNFwiO1xuXG5mdW5jdGlvbiBnZXRBbnRpZ3Jhdml0eUhlYWRlcnMoKSB7XG5cdGNvbnN0IHZlcnNpb24gPSBwcm9jZXNzLmVudi5QSV9BSV9BTlRJR1JBVklUWV9WRVJTSU9OIHx8IERFRkFVTFRfQU5USUdSQVZJVFlfVkVSU0lPTjtcblx0cmV0dXJuIHtcblx0XHRcIlVzZXItQWdlbnRcIjogYGFudGlncmF2aXR5LyR7dmVyc2lvbn0gZGFyd2luL2FybTY0YCxcblx0fTtcbn1cblxuLy8gQW50aWdyYXZpdHkgc3lzdGVtIGluc3RydWN0aW9uIChjb21wYWN0IHZlcnNpb24gZnJvbSBDTElQcm94eUFQSSkuXG5jb25zdCBBTlRJR1JBVklUWV9TWVNURU1fSU5TVFJVQ1RJT04gPVxuXHRcIllvdSBhcmUgQW50aWdyYXZpdHksIGEgcG93ZXJmdWwgYWdlbnRpYyBBSSBjb2RpbmcgYXNzaXN0YW50IGRlc2lnbmVkIGJ5IHRoZSBHb29nbGUgRGVlcG1pbmQgdGVhbSB3b3JraW5nIG9uIEFkdmFuY2VkIEFnZW50aWMgQ29kaW5nLlwiICtcblx0XCJZb3UgYXJlIHBhaXIgcHJvZ3JhbW1pbmcgd2l0aCBhIFVTRVIgdG8gc29sdmUgdGhlaXIgY29kaW5nIHRhc2suIFRoZSB0YXNrIG1heSByZXF1aXJlIGNyZWF0aW5nIGEgbmV3IGNvZGViYXNlLCBtb2RpZnlpbmcgb3IgZGVidWdnaW5nIGFuIGV4aXN0aW5nIGNvZGViYXNlLCBvciBzaW1wbHkgYW5zd2VyaW5nIGEgcXVlc3Rpb24uXCIgK1xuXHRcIioqQWJzb2x1dGUgcGF0aHMgb25seSoqXCIgK1xuXHRcIioqUHJvYWN0aXZlbmVzcyoqXCI7XG5cbi8vIENvdW50ZXIgZm9yIGdlbmVyYXRpbmcgdW5pcXVlIHRvb2wgY2FsbCBJRHNcbmxldCB0b29sQ2FsbENvdW50ZXIgPSAwO1xuXG4vLyBSZXRyeSBjb25maWd1cmF0aW9uXG5jb25zdCBNQVhfUkVUUklFUyA9IDM7XG5jb25zdCBCQVNFX0RFTEFZX01TID0gMTAwMDtcbmNvbnN0IE1BWF9FTVBUWV9TVFJFQU1fUkVUUklFUyA9IDI7XG5jb25zdCBFTVBUWV9TVFJFQU1fQkFTRV9ERUxBWV9NUyA9IDUwMDtcbmNvbnN0IENMQVVERV9USElOS0lOR19CRVRBX0hFQURFUiA9IFwiaW50ZXJsZWF2ZWQtdGhpbmtpbmctMjAyNS0wNS0xNFwiO1xuXG4vKipcbiAqIEV4dHJhY3QgcmV0cnkgZGVsYXkgZnJvbSBHZW1pbmkgZXJyb3IgcmVzcG9uc2UgKGluIG1pbGxpc2Vjb25kcykuXG4gKiBDaGVja3MgaGVhZGVycyBmaXJzdCAoUmV0cnktQWZ0ZXIsIHgtcmF0ZWxpbWl0LXJlc2V0LCB4LXJhdGVsaW1pdC1yZXNldC1hZnRlciksXG4gKiB0aGVuIHBhcnNlcyBib2R5IHBhdHRlcm5zIGxpa2U6XG4gKiAtIFwiWW91ciBxdW90YSB3aWxsIHJlc2V0IGFmdGVyIDM5c1wiXG4gKiAtIFwiWW91ciBxdW90YSB3aWxsIHJlc2V0IGFmdGVyIDE4aDMxbTEwc1wiXG4gKiAtIFwiUGxlYXNlIHJldHJ5IGluIFhzXCIgb3IgXCJQbGVhc2UgcmV0cnkgaW4gWG1zXCJcbiAqIC0gXCJyZXRyeURlbGF5XCI6IFwiMzQuMDc0ODI0MjI0c1wiIChKU09OIGZpZWxkKVxuICovXG5mdW5jdGlvbiBleHRyYWN0UmV0cnlEZWxheShlcnJvclRleHQ6IHN0cmluZywgcmVzcG9uc2U/OiBSZXNwb25zZSB8IEhlYWRlcnMpOiBudW1iZXIgfCB1bmRlZmluZWQge1xuXHRjb25zdCBub3JtYWxpemVEZWxheSA9IChtczogbnVtYmVyKTogbnVtYmVyIHwgdW5kZWZpbmVkID0+IChtcyA+IDAgPyBNYXRoLmNlaWwobXMgKyAxMDAwKSA6IHVuZGVmaW5lZCk7XG5cblx0Y29uc3QgaGVhZGVycyA9IHJlc3BvbnNlIGluc3RhbmNlb2YgSGVhZGVycyA/IHJlc3BvbnNlIDogcmVzcG9uc2U/LmhlYWRlcnM7XG5cdGlmIChoZWFkZXJzKSB7XG5cdFx0Y29uc3QgcmV0cnlBZnRlciA9IGhlYWRlcnMuZ2V0KFwicmV0cnktYWZ0ZXJcIik7XG5cdFx0aWYgKHJldHJ5QWZ0ZXIpIHtcblx0XHRcdGNvbnN0IHJldHJ5QWZ0ZXJTZWNvbmRzID0gTnVtYmVyKHJldHJ5QWZ0ZXIpO1xuXHRcdFx0aWYgKE51bWJlci5pc0Zpbml0ZShyZXRyeUFmdGVyU2Vjb25kcykpIHtcblx0XHRcdFx0Y29uc3QgZGVsYXkgPSBub3JtYWxpemVEZWxheShyZXRyeUFmdGVyU2Vjb25kcyAqIDEwMDApO1xuXHRcdFx0XHRpZiAoZGVsYXkgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRcdHJldHVybiBkZWxheTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0Y29uc3QgcmV0cnlBZnRlckRhdGUgPSBuZXcgRGF0ZShyZXRyeUFmdGVyKTtcblx0XHRcdGNvbnN0IHJldHJ5QWZ0ZXJNcyA9IHJldHJ5QWZ0ZXJEYXRlLmdldFRpbWUoKTtcblx0XHRcdGlmICghTnVtYmVyLmlzTmFOKHJldHJ5QWZ0ZXJNcykpIHtcblx0XHRcdFx0Y29uc3QgZGVsYXkgPSBub3JtYWxpemVEZWxheShyZXRyeUFmdGVyTXMgLSBEYXRlLm5vdygpKTtcblx0XHRcdFx0aWYgKGRlbGF5ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0XHRyZXR1cm4gZGVsYXk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHRjb25zdCByYXRlTGltaXRSZXNldCA9IGhlYWRlcnMuZ2V0KFwieC1yYXRlbGltaXQtcmVzZXRcIik7XG5cdFx0aWYgKHJhdGVMaW1pdFJlc2V0KSB7XG5cdFx0XHRjb25zdCByZXNldFNlY29uZHMgPSBOdW1iZXIucGFyc2VJbnQocmF0ZUxpbWl0UmVzZXQsIDEwKTtcblx0XHRcdGlmICghTnVtYmVyLmlzTmFOKHJlc2V0U2Vjb25kcykpIHtcblx0XHRcdFx0Y29uc3QgZGVsYXkgPSBub3JtYWxpemVEZWxheShyZXNldFNlY29uZHMgKiAxMDAwIC0gRGF0ZS5ub3coKSk7XG5cdFx0XHRcdGlmIChkZWxheSAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0cmV0dXJuIGRlbGF5O1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Y29uc3QgcmF0ZUxpbWl0UmVzZXRBZnRlciA9IGhlYWRlcnMuZ2V0KFwieC1yYXRlbGltaXQtcmVzZXQtYWZ0ZXJcIik7XG5cdFx0aWYgKHJhdGVMaW1pdFJlc2V0QWZ0ZXIpIHtcblx0XHRcdGNvbnN0IHJlc2V0QWZ0ZXJTZWNvbmRzID0gTnVtYmVyKHJhdGVMaW1pdFJlc2V0QWZ0ZXIpO1xuXHRcdFx0aWYgKE51bWJlci5pc0Zpbml0ZShyZXNldEFmdGVyU2Vjb25kcykpIHtcblx0XHRcdFx0Y29uc3QgZGVsYXkgPSBub3JtYWxpemVEZWxheShyZXNldEFmdGVyU2Vjb25kcyAqIDEwMDApO1xuXHRcdFx0XHRpZiAoZGVsYXkgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRcdHJldHVybiBkZWxheTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdC8vIFBhdHRlcm4gMTogXCJZb3VyIHF1b3RhIHdpbGwgcmVzZXQgYWZ0ZXIgLi4uXCIgKGZvcm1hdHM6IFwiMThoMzFtMTBzXCIsIFwiMTBtMTVzXCIsIFwiNnNcIiwgXCIzOXNcIilcblx0Y29uc3QgZHVyYXRpb25NYXRjaCA9IGVycm9yVGV4dC5tYXRjaCgvcmVzZXQgYWZ0ZXIgKD86KFxcZCspaCk/KD86KFxcZCspbSk/KFxcZCsoPzpcXC5cXGQrKT8pcy9pKTtcblx0aWYgKGR1cmF0aW9uTWF0Y2gpIHtcblx0XHRjb25zdCBob3VycyA9IGR1cmF0aW9uTWF0Y2hbMV0gPyBwYXJzZUludChkdXJhdGlvbk1hdGNoWzFdLCAxMCkgOiAwO1xuXHRcdGNvbnN0IG1pbnV0ZXMgPSBkdXJhdGlvbk1hdGNoWzJdID8gcGFyc2VJbnQoZHVyYXRpb25NYXRjaFsyXSwgMTApIDogMDtcblx0XHRjb25zdCBzZWNvbmRzID0gcGFyc2VGbG9hdChkdXJhdGlvbk1hdGNoWzNdKTtcblx0XHRpZiAoIU51bWJlci5pc05hTihzZWNvbmRzKSkge1xuXHRcdFx0Y29uc3QgdG90YWxNcyA9ICgoaG91cnMgKiA2MCArIG1pbnV0ZXMpICogNjAgKyBzZWNvbmRzKSAqIDEwMDA7XG5cdFx0XHRjb25zdCBkZWxheSA9IG5vcm1hbGl6ZURlbGF5KHRvdGFsTXMpO1xuXHRcdFx0aWYgKGRlbGF5ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0cmV0dXJuIGRlbGF5O1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdC8vIFBhdHRlcm4gMjogXCJQbGVhc2UgcmV0cnkgaW4gWFttc3xzXVwiXG5cdGNvbnN0IHJldHJ5SW5NYXRjaCA9IGVycm9yVGV4dC5tYXRjaCgvUGxlYXNlIHJldHJ5IGluIChbMC05Ll0rKShtc3xzKS9pKTtcblx0aWYgKHJldHJ5SW5NYXRjaD8uWzFdKSB7XG5cdFx0Y29uc3QgdmFsdWUgPSBwYXJzZUZsb2F0KHJldHJ5SW5NYXRjaFsxXSk7XG5cdFx0aWYgKCFOdW1iZXIuaXNOYU4odmFsdWUpICYmIHZhbHVlID4gMCkge1xuXHRcdFx0Y29uc3QgbXMgPSByZXRyeUluTWF0Y2hbMl0udG9Mb3dlckNhc2UoKSA9PT0gXCJtc1wiID8gdmFsdWUgOiB2YWx1ZSAqIDEwMDA7XG5cdFx0XHRjb25zdCBkZWxheSA9IG5vcm1hbGl6ZURlbGF5KG1zKTtcblx0XHRcdGlmIChkZWxheSAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdHJldHVybiBkZWxheTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHQvLyBQYXR0ZXJuIDM6IFwicmV0cnlEZWxheVwiOiBcIjM0LjA3NDgyNDIyNHNcIiAoSlNPTiBmaWVsZCBpbiBlcnJvciBkZXRhaWxzKVxuXHRjb25zdCByZXRyeURlbGF5TWF0Y2ggPSBlcnJvclRleHQubWF0Y2goL1wicmV0cnlEZWxheVwiOlxccypcIihbMC05Ll0rKShtc3xzKVwiL2kpO1xuXHRpZiAocmV0cnlEZWxheU1hdGNoPy5bMV0pIHtcblx0XHRjb25zdCB2YWx1ZSA9IHBhcnNlRmxvYXQocmV0cnlEZWxheU1hdGNoWzFdKTtcblx0XHRpZiAoIU51bWJlci5pc05hTih2YWx1ZSkgJiYgdmFsdWUgPiAwKSB7XG5cdFx0XHRjb25zdCBtcyA9IHJldHJ5RGVsYXlNYXRjaFsyXS50b0xvd2VyQ2FzZSgpID09PSBcIm1zXCIgPyB2YWx1ZSA6IHZhbHVlICogMTAwMDtcblx0XHRcdGNvbnN0IGRlbGF5ID0gbm9ybWFsaXplRGVsYXkobXMpO1xuXHRcdFx0aWYgKGRlbGF5ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0cmV0dXJuIGRlbGF5O1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIG5lZWRzQ2xhdWRlVGhpbmtpbmdCZXRhSGVhZGVyKG1vZGVsOiBNb2RlbDxcImdvb2dsZS1nZW1pbmktY2xpXCI+KTogYm9vbGVhbiB7XG5cdHJldHVybiBtb2RlbC5wcm92aWRlciA9PT0gXCJnb29nbGUtYW50aWdyYXZpdHlcIiAmJiBtb2RlbC5pZC5zdGFydHNXaXRoKFwiY2xhdWRlLVwiKSAmJiBtb2RlbC5yZWFzb25pbmc7XG59XG5cbmZ1bmN0aW9uIGlzR2VtaW5pM1Byb01vZGVsKG1vZGVsSWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRyZXR1cm4gL2dlbWluaS0zKD86XFwuMSk/LXByby8udGVzdChtb2RlbElkLnRvTG93ZXJDYXNlKCkpO1xufVxuXG5mdW5jdGlvbiBpc0dlbWluaTNGbGFzaE1vZGVsKG1vZGVsSWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRyZXR1cm4gL2dlbWluaS0zKD86XFwuMSk/LWZsYXNoLy50ZXN0KG1vZGVsSWQudG9Mb3dlckNhc2UoKSk7XG59XG5cbmZ1bmN0aW9uIGlzR2VtaW5pM01vZGVsKG1vZGVsSWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRyZXR1cm4gaXNHZW1pbmkzUHJvTW9kZWwobW9kZWxJZCkgfHwgaXNHZW1pbmkzRmxhc2hNb2RlbChtb2RlbElkKTtcbn1cblxuLyoqXG4gKiBDaGVjayBpZiBhbiBlcnJvciBpcyByZXRyeWFibGUgKHJhdGUgbGltaXQsIHNlcnZlciBlcnJvciwgbmV0d29yayBlcnJvciwgZXRjLilcbiAqL1xuZnVuY3Rpb24gaXNSZXRyeWFibGVFcnJvcihzdGF0dXM6IG51bWJlciwgZXJyb3JUZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcblx0aWYgKHN0YXR1cyA9PT0gNDI5IHx8IHN0YXR1cyA9PT0gNTAwIHx8IHN0YXR1cyA9PT0gNTAyIHx8IHN0YXR1cyA9PT0gNTAzIHx8IHN0YXR1cyA9PT0gNTA0KSB7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblx0cmV0dXJuIC9yZXNvdXJjZS4/ZXhoYXVzdGVkfHJhdGUuP2xpbWl0fG92ZXJsb2FkZWR8c2VydmljZS4/dW5hdmFpbGFibGV8b3RoZXIuP3NpZGUuP2Nsb3NlZC9pLnRlc3QoZXJyb3JUZXh0KTtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IGEgY2xlYW4sIHVzZXItZnJpZW5kbHkgZXJyb3IgbWVzc2FnZSBmcm9tIEdvb2dsZSBBUEkgZXJyb3IgcmVzcG9uc2UuXG4gKiBQYXJzZXMgSlNPTiBlcnJvciByZXNwb25zZXMgYW5kIHJldHVybnMganVzdCB0aGUgbWVzc2FnZSBmaWVsZC5cbiAqL1xuZnVuY3Rpb24gZXh0cmFjdEVycm9yTWVzc2FnZShlcnJvclRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdHRyeSB7XG5cdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShlcnJvclRleHQpIGFzIHsgZXJyb3I/OiB7IG1lc3NhZ2U/OiBzdHJpbmcgfSB9O1xuXHRcdGlmIChwYXJzZWQuZXJyb3I/Lm1lc3NhZ2UpIHtcblx0XHRcdHJldHVybiBwYXJzZWQuZXJyb3IubWVzc2FnZTtcblx0XHR9XG5cdH0gY2F0Y2gge1xuXHRcdC8vIE5vdCBKU09OLCByZXR1cm4gYXMtaXNcblx0fVxuXHRyZXR1cm4gZXJyb3JUZXh0O1xufVxuXG4vKipcbiAqIFNsZWVwIGZvciBhIGdpdmVuIG51bWJlciBvZiBtaWxsaXNlY29uZHMsIHJlc3BlY3RpbmcgYWJvcnQgc2lnbmFsLlxuICovXG5mdW5jdGlvbiBzbGVlcChtczogbnVtYmVyLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IFByb21pc2U8dm9pZD4ge1xuXHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdGlmIChzaWduYWw/LmFib3J0ZWQpIHtcblx0XHRcdHJlamVjdChuZXcgRXJyb3IoXCJSZXF1ZXN0IHdhcyBhYm9ydGVkXCIpKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0Y29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQocmVzb2x2ZSwgbXMpO1xuXHRcdHNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsICgpID0+IHtcblx0XHRcdGNsZWFyVGltZW91dCh0aW1lb3V0KTtcblx0XHRcdHJlamVjdChuZXcgRXJyb3IoXCJSZXF1ZXN0IHdhcyBhYm9ydGVkXCIpKTtcblx0XHR9KTtcblx0fSk7XG59XG5cbmludGVyZmFjZSBDbG91ZENvZGVBc3Npc3RSZXF1ZXN0IHtcblx0cHJvamVjdDogc3RyaW5nO1xuXHRtb2RlbDogc3RyaW5nO1xuXHRyZXF1ZXN0OiB7XG5cdFx0Y29udGVudHM6IENvbnRlbnRbXTtcblx0XHRzZXNzaW9uSWQ/OiBzdHJpbmc7XG5cdFx0c3lzdGVtSW5zdHJ1Y3Rpb24/OiB7IHJvbGU/OiBzdHJpbmc7IHBhcnRzOiB7IHRleHQ6IHN0cmluZyB9W10gfTtcblx0XHRnZW5lcmF0aW9uQ29uZmlnPzoge1xuXHRcdFx0bWF4T3V0cHV0VG9rZW5zPzogbnVtYmVyO1xuXHRcdFx0dGVtcGVyYXR1cmU/OiBudW1iZXI7XG5cdFx0XHR0aGlua2luZ0NvbmZpZz86IFRoaW5raW5nQ29uZmlnO1xuXHRcdH07XG5cdFx0dG9vbHM/OiBSZXR1cm5UeXBlPHR5cGVvZiBjb252ZXJ0VG9vbHM+O1xuXHRcdHRvb2xDb25maWc/OiB7XG5cdFx0XHRmdW5jdGlvbkNhbGxpbmdDb25maWc6IHtcblx0XHRcdFx0bW9kZTogUmV0dXJuVHlwZTx0eXBlb2YgbWFwVG9vbENob2ljZT47XG5cdFx0XHR9O1xuXHRcdH07XG5cdH07XG5cdHJlcXVlc3RUeXBlPzogc3RyaW5nO1xuXHR1c2VyQWdlbnQ/OiBzdHJpbmc7XG5cdHJlcXVlc3RJZD86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIENsb3VkQ29kZUFzc2lzdFJlc3BvbnNlQ2h1bmsge1xuXHRyZXNwb25zZT86IHtcblx0XHRjYW5kaWRhdGVzPzogQXJyYXk8e1xuXHRcdFx0Y29udGVudD86IHtcblx0XHRcdFx0cm9sZTogc3RyaW5nO1xuXHRcdFx0XHRwYXJ0cz86IEFycmF5PHtcblx0XHRcdFx0XHR0ZXh0Pzogc3RyaW5nO1xuXHRcdFx0XHRcdHRob3VnaHQ/OiBib29sZWFuO1xuXHRcdFx0XHRcdHRob3VnaHRTaWduYXR1cmU/OiBzdHJpbmc7XG5cdFx0XHRcdFx0ZnVuY3Rpb25DYWxsPzoge1xuXHRcdFx0XHRcdFx0bmFtZTogc3RyaW5nO1xuXHRcdFx0XHRcdFx0YXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cdFx0XHRcdFx0XHRpZD86IHN0cmluZztcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9Pjtcblx0XHRcdH07XG5cdFx0XHRmaW5pc2hSZWFzb24/OiBzdHJpbmc7XG5cdFx0fT47XG5cdFx0dXNhZ2VNZXRhZGF0YT86IHtcblx0XHRcdHByb21wdFRva2VuQ291bnQ/OiBudW1iZXI7XG5cdFx0XHRjYW5kaWRhdGVzVG9rZW5Db3VudD86IG51bWJlcjtcblx0XHRcdHRob3VnaHRzVG9rZW5Db3VudD86IG51bWJlcjtcblx0XHRcdHRvdGFsVG9rZW5Db3VudD86IG51bWJlcjtcblx0XHRcdGNhY2hlZENvbnRlbnRUb2tlbkNvdW50PzogbnVtYmVyO1xuXHRcdH07XG5cdFx0bW9kZWxWZXJzaW9uPzogc3RyaW5nO1xuXHRcdHJlc3BvbnNlSWQ/OiBzdHJpbmc7XG5cdH07XG5cdHRyYWNlSWQ/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjb25zdCBzdHJlYW1Hb29nbGVHZW1pbmlDbGk6IFN0cmVhbUZ1bmN0aW9uPFwiZ29vZ2xlLWdlbWluaS1jbGlcIiwgR29vZ2xlR2VtaW5pQ2xpT3B0aW9ucz4gPSAoXG5cdG1vZGVsOiBNb2RlbDxcImdvb2dsZS1nZW1pbmktY2xpXCI+LFxuXHRjb250ZXh0OiBDb250ZXh0LFxuXHRvcHRpb25zPzogR29vZ2xlR2VtaW5pQ2xpT3B0aW9ucyxcbik6IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSA9PiB7XG5cdGNvbnN0IHN0cmVhbSA9IG5ldyBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0oKTtcblxuXHQoYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IG91dHB1dDogQXNzaXN0YW50TWVzc2FnZSA9IHtcblx0XHRcdHJvbGU6IFwiYXNzaXN0YW50XCIsXG5cdFx0XHRjb250ZW50OiBbXSxcblx0XHRcdGFwaTogXCJnb29nbGUtZ2VtaW5pLWNsaVwiIGFzIEFwaSxcblx0XHRcdHByb3ZpZGVyOiBtb2RlbC5wcm92aWRlcixcblx0XHRcdG1vZGVsOiBtb2RlbC5pZCxcblx0XHRcdHVzYWdlOiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdFx0dG90YWxUb2tlbnM6IDAsXG5cdFx0XHRcdGNvc3Q6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbDogMCB9LFxuXHRcdFx0fSxcblx0XHRcdHN0b3BSZWFzb246IFwic3RvcFwiLFxuXHRcdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHRcdH07XG5cblx0XHR0cnkge1xuXHRcdFx0Ly8gYXBpS2V5IGlzIEpTT04tZW5jb2RlZDogeyB0b2tlbiwgcHJvamVjdElkIH1cblx0XHRcdGNvbnN0IGFwaUtleVJhdyA9IG9wdGlvbnM/LmFwaUtleTtcblx0XHRcdGlmICghYXBpS2V5UmF3KSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIkdvb2dsZSBDbG91ZCBDb2RlIEFzc2lzdCByZXF1aXJlcyBPQXV0aCBhdXRoZW50aWNhdGlvbi4gVXNlIC9sb2dpbiB0byBhdXRoZW50aWNhdGUuXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRsZXQgYWNjZXNzVG9rZW46IHN0cmluZztcblx0XHRcdGxldCBwcm9qZWN0SWQ6IHN0cmluZztcblxuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShhcGlLZXlSYXcpIGFzIHsgdG9rZW46IHN0cmluZzsgcHJvamVjdElkOiBzdHJpbmcgfTtcblx0XHRcdFx0YWNjZXNzVG9rZW4gPSBwYXJzZWQudG9rZW47XG5cdFx0XHRcdHByb2plY3RJZCA9IHBhcnNlZC5wcm9qZWN0SWQ7XG5cdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBHb29nbGUgQ2xvdWQgQ29kZSBBc3Npc3QgY3JlZGVudGlhbHMuIFVzZSAvbG9naW4gdG8gcmUtYXV0aGVudGljYXRlLlwiKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKCFhY2Nlc3NUb2tlbiB8fCAhcHJvamVjdElkKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIk1pc3NpbmcgdG9rZW4gb3IgcHJvamVjdElkIGluIEdvb2dsZSBDbG91ZCBjcmVkZW50aWFscy4gVXNlIC9sb2dpbiB0byByZS1hdXRoZW50aWNhdGUuXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBpc0FudGlncmF2aXR5ID0gbW9kZWwucHJvdmlkZXIgPT09IFwiZ29vZ2xlLWFudGlncmF2aXR5XCI7XG5cdFx0XHRjb25zdCBiYXNlVXJsID0gbW9kZWwuYmFzZVVybD8udHJpbSgpO1xuXHRcdFx0Y29uc3QgZW5kcG9pbnRzID0gYmFzZVVybCA/IFtiYXNlVXJsXSA6IGlzQW50aWdyYXZpdHkgPyBBTlRJR1JBVklUWV9FTkRQT0lOVF9GQUxMQkFDS1MgOiBbREVGQVVMVF9FTkRQT0lOVF07XG5cblx0XHRcdGxldCByZXF1ZXN0Qm9keSA9IGJ1aWxkUmVxdWVzdChtb2RlbCwgY29udGV4dCwgcHJvamVjdElkLCBvcHRpb25zLCBpc0FudGlncmF2aXR5KTtcblx0XHRcdGNvbnN0IG5leHRSZXF1ZXN0Qm9keSA9IGF3YWl0IG9wdGlvbnM/Lm9uUGF5bG9hZD8uKHJlcXVlc3RCb2R5LCBtb2RlbCk7XG5cdFx0XHRpZiAobmV4dFJlcXVlc3RCb2R5ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0cmVxdWVzdEJvZHkgPSBuZXh0UmVxdWVzdEJvZHkgYXMgQ2xvdWRDb2RlQXNzaXN0UmVxdWVzdDtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGhlYWRlcnMgPSBpc0FudGlncmF2aXR5ID8gZ2V0QW50aWdyYXZpdHlIZWFkZXJzKCkgOiBHRU1JTklfQ0xJX0hFQURFUlM7XG5cblx0XHRcdGNvbnN0IHJlcXVlc3RIZWFkZXJzID0ge1xuXHRcdFx0XHRBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7YWNjZXNzVG9rZW59YCxcblx0XHRcdFx0XCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG5cdFx0XHRcdEFjY2VwdDogXCJ0ZXh0L2V2ZW50LXN0cmVhbVwiLFxuXHRcdFx0XHQuLi5oZWFkZXJzLFxuXHRcdFx0XHQuLi4obmVlZHNDbGF1ZGVUaGlua2luZ0JldGFIZWFkZXIobW9kZWwpID8geyBcImFudGhyb3BpYy1iZXRhXCI6IENMQVVERV9USElOS0lOR19CRVRBX0hFQURFUiB9IDoge30pLFxuXHRcdFx0XHQuLi5vcHRpb25zPy5oZWFkZXJzLFxuXHRcdFx0fTtcblx0XHRcdGNvbnN0IHJlcXVlc3RCb2R5SnNvbiA9IEpTT04uc3RyaW5naWZ5KHJlcXVlc3RCb2R5KTtcblxuXHRcdFx0Ly8gRmV0Y2ggd2l0aCByZXRyeSBsb2dpYyBmb3IgcmF0ZSBsaW1pdHMsIHRyYW5zaWVudCBlcnJvcnMsIGFuZCBlbmRwb2ludCBmYWxsYmFja3MuXG5cdFx0XHQvLyBPbiA0MDMvNDA0LCBpbW1lZGlhdGVseSB0cnkgdGhlIG5leHQgZW5kcG9pbnQgKG5vIGRlbGF5KS5cblx0XHRcdC8vIE9uIDQyOS81eHgsIHJldHJ5IHdpdGggYmFja29mZiBvbiB0aGUgc2FtZSBvciBuZXh0IGVuZHBvaW50LlxuXHRcdFx0bGV0IHJlc3BvbnNlOiBSZXNwb25zZSB8IHVuZGVmaW5lZDtcblx0XHRcdGxldCBsYXN0RXJyb3I6IEVycm9yIHwgdW5kZWZpbmVkO1xuXHRcdFx0bGV0IHJlcXVlc3RVcmw6IHN0cmluZyB8IHVuZGVmaW5lZDtcblx0XHRcdGxldCBlbmRwb2ludEluZGV4ID0gMDtcblxuXHRcdFx0Zm9yIChsZXQgYXR0ZW1wdCA9IDA7IGF0dGVtcHQgPD0gTUFYX1JFVFJJRVM7IGF0dGVtcHQrKykge1xuXHRcdFx0XHRpZiAob3B0aW9ucz8uc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiUmVxdWVzdCB3YXMgYWJvcnRlZFwiKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0Y29uc3QgZW5kcG9pbnQgPSBlbmRwb2ludHNbZW5kcG9pbnRJbmRleF07XG5cdFx0XHRcdFx0cmVxdWVzdFVybCA9IGAke2VuZHBvaW50fS92MWludGVybmFsOnN0cmVhbUdlbmVyYXRlQ29udGVudD9hbHQ9c3NlYDtcblx0XHRcdFx0XHRyZXNwb25zZSA9IGF3YWl0IGZldGNoKHJlcXVlc3RVcmwsIHtcblx0XHRcdFx0XHRcdG1ldGhvZDogXCJQT1NUXCIsXG5cdFx0XHRcdFx0XHRoZWFkZXJzOiByZXF1ZXN0SGVhZGVycyxcblx0XHRcdFx0XHRcdGJvZHk6IHJlcXVlc3RCb2R5SnNvbixcblx0XHRcdFx0XHRcdHNpZ25hbDogb3B0aW9ucz8uc2lnbmFsLFxuXHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0aWYgKHJlc3BvbnNlLm9rKSB7XG5cdFx0XHRcdFx0XHRicmVhazsgLy8gU3VjY2VzcywgZXhpdCByZXRyeSBsb29wXG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y29uc3QgZXJyb3JUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpO1xuXG5cdFx0XHRcdFx0Ly8gT24gNDAzLzQwNCwgY2FzY2FkZSB0byB0aGUgbmV4dCBlbmRwb2ludCBpbW1lZGlhdGVseSAobm8gZGVsYXkpXG5cdFx0XHRcdFx0aWYgKChyZXNwb25zZS5zdGF0dXMgPT09IDQwMyB8fCByZXNwb25zZS5zdGF0dXMgPT09IDQwNCkgJiYgZW5kcG9pbnRJbmRleCA8IGVuZHBvaW50cy5sZW5ndGggLSAxKSB7XG5cdFx0XHRcdFx0XHRlbmRwb2ludEluZGV4Kys7XG5cdFx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHQvLyBDaGVjayBpZiByZXRyeWFibGUgKDQyOSwgNXh4LCBuZXR3b3JrIHBhdHRlcm5zKVxuXHRcdFx0XHRcdGlmIChhdHRlbXB0IDwgTUFYX1JFVFJJRVMgJiYgaXNSZXRyeWFibGVFcnJvcihyZXNwb25zZS5zdGF0dXMsIGVycm9yVGV4dCkpIHtcblx0XHRcdFx0XHRcdC8vIEFkdmFuY2UgZW5kcG9pbnQgaWYgcG9zc2libGVcblx0XHRcdFx0XHRcdGlmIChlbmRwb2ludEluZGV4IDwgZW5kcG9pbnRzLmxlbmd0aCAtIDEpIHtcblx0XHRcdFx0XHRcdFx0ZW5kcG9pbnRJbmRleCsrO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHQvLyBVc2Ugc2VydmVyLXByb3ZpZGVkIGRlbGF5IG9yIGV4cG9uZW50aWFsIGJhY2tvZmZcblx0XHRcdFx0XHRcdGNvbnN0IHNlcnZlckRlbGF5ID0gZXh0cmFjdFJldHJ5RGVsYXkoZXJyb3JUZXh0LCByZXNwb25zZSk7XG5cdFx0XHRcdFx0XHRjb25zdCBkZWxheU1zID0gc2VydmVyRGVsYXkgPz8gQkFTRV9ERUxBWV9NUyAqIDIgKiogYXR0ZW1wdDtcblxuXHRcdFx0XHRcdFx0Ly8gQ2hlY2sgaWYgc2VydmVyIGRlbGF5IGV4Y2VlZHMgbWF4IGFsbG93ZWQgKGRlZmF1bHQ6IDYwcylcblx0XHRcdFx0XHRcdGNvbnN0IG1heERlbGF5TXMgPSBvcHRpb25zPy5tYXhSZXRyeURlbGF5TXMgPz8gNjAwMDA7XG5cdFx0XHRcdFx0XHRpZiAobWF4RGVsYXlNcyA+IDAgJiYgc2VydmVyRGVsYXkgJiYgc2VydmVyRGVsYXkgPiBtYXhEZWxheU1zKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGRlbGF5U2Vjb25kcyA9IE1hdGguY2VpbChzZXJ2ZXJEZWxheSAvIDEwMDApO1xuXHRcdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXG5cdFx0XHRcdFx0XHRcdFx0YFNlcnZlciByZXF1ZXN0ZWQgJHtkZWxheVNlY29uZHN9cyByZXRyeSBkZWxheSAobWF4OiAke01hdGguY2VpbChtYXhEZWxheU1zIC8gMTAwMCl9cykuICR7ZXh0cmFjdEVycm9yTWVzc2FnZShlcnJvclRleHQpfWAsXG5cdFx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGF3YWl0IHNsZWVwKGRlbGF5TXMsIG9wdGlvbnM/LnNpZ25hbCk7XG5cdFx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHQvLyBOb3QgcmV0cnlhYmxlIG9yIG1heCByZXRyaWVzIGV4Y2VlZGVkXG5cdFx0XHRcdFx0aWYgKHJlc3BvbnNlLnN0YXR1cyA9PT0gNDA0KSB7XG5cdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXG5cdFx0XHRcdFx0XHRcdGBDbG91ZCBDb2RlIEFzc2lzdCBBUEkgZXJyb3IgKDQwNCk6IE1vZGVsIFwiJHttb2RlbC5pZH1cIiB3YXMgbm90IGZvdW5kLiBgICtcblx0XHRcdFx0XHRcdFx0YFRoaXMgbW9kZWwgbWF5IG5vdCBiZSBhdmFpbGFibGUgdmlhIENsb3VkIENvZGUgQXNzaXN0LiBgICtcblx0XHRcdFx0XHRcdFx0YFRyeSB1c2luZyB0aGUgXCJnb29nbGVcIiBwcm92aWRlciB3aXRoIGEgR09PR0xFX0FQSV9LRVkgaW5zdGVhZCwgYCArXG5cdFx0XHRcdFx0XHRcdGBvciBzd2l0Y2ggdG8gYSBzdXBwb3J0ZWQgbW9kZWwgKGUuZy4sIGdlbWluaS0yLjUtcHJvKS5gLFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBDbG91ZCBDb2RlIEFzc2lzdCBBUEkgZXJyb3IgKCR7cmVzcG9uc2Uuc3RhdHVzfSk6ICR7ZXh0cmFjdEVycm9yTWVzc2FnZShlcnJvclRleHQpfWApO1xuXHRcdFx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0XHRcdC8vIENoZWNrIGZvciBhYm9ydCAtIGZldGNoIHRocm93cyBBYm9ydEVycm9yLCBvdXIgY29kZSB0aHJvd3MgXCJSZXF1ZXN0IHdhcyBhYm9ydGVkXCJcblx0XHRcdFx0XHRpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvcikge1xuXHRcdFx0XHRcdFx0aWYgKGVycm9yLm5hbWUgPT09IFwiQWJvcnRFcnJvclwiIHx8IGVycm9yLm1lc3NhZ2UgPT09IFwiUmVxdWVzdCB3YXMgYWJvcnRlZFwiKSB7XG5cdFx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIlJlcXVlc3Qgd2FzIGFib3J0ZWRcIik7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdC8vIEV4dHJhY3QgZGV0YWlsZWQgZXJyb3IgbWVzc2FnZSBmcm9tIGZldGNoIGVycm9ycyAoTm9kZSBpbmNsdWRlcyBjYXVzZSlcblx0XHRcdFx0XHRsYXN0RXJyb3IgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSk7XG5cdFx0XHRcdFx0aWYgKGxhc3RFcnJvci5tZXNzYWdlID09PSBcImZldGNoIGZhaWxlZFwiICYmIGxhc3RFcnJvci5jYXVzZSBpbnN0YW5jZW9mIEVycm9yKSB7XG5cdFx0XHRcdFx0XHRsYXN0RXJyb3IgPSBuZXcgRXJyb3IoYE5ldHdvcmsgZXJyb3I6ICR7bGFzdEVycm9yLmNhdXNlLm1lc3NhZ2V9YCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdC8vIE5ldHdvcmsgZXJyb3JzIGFyZSByZXRyeWFibGVcblx0XHRcdFx0XHRpZiAoYXR0ZW1wdCA8IE1BWF9SRVRSSUVTKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBkZWxheU1zID0gQkFTRV9ERUxBWV9NUyAqIDIgKiogYXR0ZW1wdDtcblx0XHRcdFx0XHRcdGF3YWl0IHNsZWVwKGRlbGF5TXMsIG9wdGlvbnM/LnNpZ25hbCk7XG5cdFx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0dGhyb3cgbGFzdEVycm9yO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGlmICghcmVzcG9uc2UgfHwgIXJlc3BvbnNlLm9rKSB7XG5cdFx0XHRcdHRocm93IGxhc3RFcnJvciA/PyBuZXcgRXJyb3IoXCJGYWlsZWQgdG8gZ2V0IHJlc3BvbnNlIGFmdGVyIHJldHJpZXNcIik7XG5cdFx0XHR9XG5cblx0XHRcdGxldCBzdGFydGVkID0gZmFsc2U7XG5cdFx0XHRjb25zdCBlbnN1cmVTdGFydGVkID0gKCkgPT4ge1xuXHRcdFx0XHRpZiAoIXN0YXJ0ZWQpIHtcblx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwic3RhcnRcIiwgcGFydGlhbDogb3V0cHV0IH0pO1xuXHRcdFx0XHRcdHN0YXJ0ZWQgPSB0cnVlO1xuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXG5cdFx0XHRjb25zdCByZXNldE91dHB1dCA9ICgpID0+IHtcblx0XHRcdFx0b3V0cHV0LmNvbnRlbnQgPSBbXTtcblx0XHRcdFx0b3V0cHV0LnVzYWdlID0ge1xuXHRcdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdFx0XHR0b3RhbFRva2VuczogMCxcblx0XHRcdFx0XHRjb3N0OiB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgdG90YWw6IDAgfSxcblx0XHRcdFx0fTtcblx0XHRcdFx0b3V0cHV0LnN0b3BSZWFzb24gPSBcInN0b3BcIjtcblx0XHRcdFx0b3V0cHV0LmVycm9yTWVzc2FnZSA9IHVuZGVmaW5lZDtcblx0XHRcdFx0b3V0cHV0LnRpbWVzdGFtcCA9IERhdGUubm93KCk7XG5cdFx0XHRcdHN0YXJ0ZWQgPSBmYWxzZTtcblx0XHRcdH07XG5cblx0XHRcdGNvbnN0IHN0cmVhbVJlc3BvbnNlID0gYXN5bmMgKGFjdGl2ZVJlc3BvbnNlOiBSZXNwb25zZSk6IFByb21pc2U8Ym9vbGVhbj4gPT4ge1xuXHRcdFx0XHRpZiAoIWFjdGl2ZVJlc3BvbnNlLmJvZHkpIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJObyByZXNwb25zZSBib2R5XCIpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0bGV0IGhhc0NvbnRlbnQgPSBmYWxzZTtcblx0XHRcdFx0bGV0IGN1cnJlbnRCbG9jazogVGV4dENvbnRlbnQgfCBUaGlua2luZ0NvbnRlbnQgfCBudWxsID0gbnVsbDtcblx0XHRcdFx0Y29uc3QgYmxvY2tzID0gb3V0cHV0LmNvbnRlbnQ7XG5cdFx0XHRcdGNvbnN0IGJsb2NrSW5kZXggPSAoKSA9PiBibG9ja3MubGVuZ3RoIC0gMTtcblxuXHRcdFx0XHQvLyBSZWFkIFNTRSBzdHJlYW1cblx0XHRcdFx0Y29uc3QgcmVhZGVyID0gYWN0aXZlUmVzcG9uc2UuYm9keS5nZXRSZWFkZXIoKTtcblx0XHRcdFx0Y29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuXHRcdFx0XHRsZXQgYnVmZmVyID0gXCJcIjtcblxuXHRcdFx0XHQvLyBTZXQgdXAgYWJvcnQgaGFuZGxlciB0byBjYW5jZWwgcmVhZGVyIHdoZW4gc2lnbmFsIGZpcmVzXG5cdFx0XHRcdGNvbnN0IGFib3J0SGFuZGxlciA9ICgpID0+IHtcblx0XHRcdFx0XHR2b2lkIHJlYWRlci5jYW5jZWwoKS5jYXRjaCgoKSA9PiB7fSk7XG5cdFx0XHRcdH07XG5cdFx0XHRcdG9wdGlvbnM/LnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGFib3J0SGFuZGxlcik7XG5cblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHR3aGlsZSAodHJ1ZSkge1xuXHRcdFx0XHRcdFx0Ly8gQ2hlY2sgYWJvcnQgc2lnbmFsIGJlZm9yZSBlYWNoIHJlYWRcblx0XHRcdFx0XHRcdGlmIChvcHRpb25zPy5zaWduYWw/LmFib3J0ZWQpIHtcblx0XHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiUmVxdWVzdCB3YXMgYWJvcnRlZFwiKTtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Y29uc3QgeyBkb25lLCB2YWx1ZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcblx0XHRcdFx0XHRcdGlmIChkb25lKSBicmVhaztcblxuXHRcdFx0XHRcdFx0YnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblx0XHRcdFx0XHRcdGNvbnN0IGxpbmVzID0gYnVmZmVyLnNwbGl0KFwiXFxuXCIpO1xuXHRcdFx0XHRcdFx0YnVmZmVyID0gbGluZXMucG9wKCkgfHwgXCJcIjtcblxuXHRcdFx0XHRcdFx0Zm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG5cdFx0XHRcdFx0XHRcdGlmICghbGluZS5zdGFydHNXaXRoKFwiZGF0YTpcIikpIGNvbnRpbnVlO1xuXG5cdFx0XHRcdFx0XHRcdGNvbnN0IGpzb25TdHIgPSBsaW5lLnNsaWNlKDUpLnRyaW0oKTtcblx0XHRcdFx0XHRcdFx0aWYgKCFqc29uU3RyKSBjb250aW51ZTtcblxuXHRcdFx0XHRcdFx0XHRsZXQgY2h1bms6IENsb3VkQ29kZUFzc2lzdFJlc3BvbnNlQ2h1bms7XG5cdFx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdFx0Y2h1bmsgPSBKU09OLnBhcnNlKGpzb25TdHIpO1xuXHRcdFx0XHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRcdC8vIFVud3JhcCB0aGUgcmVzcG9uc2Vcblx0XHRcdFx0XHRcdFx0Y29uc3QgcmVzcG9uc2VEYXRhID0gY2h1bmsucmVzcG9uc2U7XG5cdFx0XHRcdFx0XHRcdGlmICghcmVzcG9uc2VEYXRhKSBjb250aW51ZTtcblxuXHRcdFx0XHRcdFx0XHRjb25zdCBjYW5kaWRhdGUgPSByZXNwb25zZURhdGEuY2FuZGlkYXRlcz8uWzBdO1xuXHRcdFx0XHRcdFx0XHRpZiAoY2FuZGlkYXRlPy5jb250ZW50Py5wYXJ0cykge1xuXHRcdFx0XHRcdFx0XHRcdGZvciAoY29uc3QgcGFydCBvZiBjYW5kaWRhdGUuY29udGVudC5wYXJ0cykge1xuXHRcdFx0XHRcdFx0XHRcdFx0aWYgKHBhcnQudGV4dCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdGhhc0NvbnRlbnQgPSB0cnVlO1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRjb25zdCBpc1RoaW5raW5nID0gaXNUaGlua2luZ1BhcnQocGFydCk7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdGlmIChcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHQhY3VycmVudEJsb2NrIHx8XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0KGlzVGhpbmtpbmcgJiYgY3VycmVudEJsb2NrLnR5cGUgIT09IFwidGhpbmtpbmdcIikgfHxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHQoIWlzVGhpbmtpbmcgJiYgY3VycmVudEJsb2NrLnR5cGUgIT09IFwidGV4dFwiKVxuXHRcdFx0XHRcdFx0XHRcdFx0XHQpIHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRpZiAoY3VycmVudEJsb2NrKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRpZiAoY3VycmVudEJsb2NrLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHR0eXBlOiBcInRleHRfZW5kXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja3MubGVuZ3RoIC0gMSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBjdXJyZW50QmxvY2sudGV4dCxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidGhpbmtpbmdfZW5kXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudDogY3VycmVudEJsb2NrLnRoaW5raW5nLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdGlmIChpc1RoaW5raW5nKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjdXJyZW50QmxvY2sgPSB7IHR5cGU6IFwidGhpbmtpbmdcIiwgdGhpbmtpbmc6IFwiXCIsIHRoaW5raW5nU2lnbmF0dXJlOiB1bmRlZmluZWQgfTtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdG91dHB1dC5jb250ZW50LnB1c2goY3VycmVudEJsb2NrKTtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdGVuc3VyZVN0YXJ0ZWQoKTtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0aGlua2luZ19zdGFydFwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdGN1cnJlbnRCbG9jayA9IHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiXCIgfTtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdG91dHB1dC5jb250ZW50LnB1c2goY3VycmVudEJsb2NrKTtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdGVuc3VyZVN0YXJ0ZWQoKTtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0ZXh0X3N0YXJ0XCIsIGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0XHRcdGlmIChjdXJyZW50QmxvY2sudHlwZSA9PT0gXCJ0aGlua2luZ1wiKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0Y3VycmVudEJsb2NrLnRoaW5raW5nICs9IHBhcnQudGV4dDtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjdXJyZW50QmxvY2sudGhpbmtpbmdTaWduYXR1cmUgPSByZXRhaW5UaG91Z2h0U2lnbmF0dXJlKFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0Y3VycmVudEJsb2NrLnRoaW5raW5nU2lnbmF0dXJlLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0cGFydC50aG91Z2h0U2lnbmF0dXJlLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0aGlua2luZ19kZWx0YVwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRkZWx0YTogcGFydC50ZXh0LFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdGN1cnJlbnRCbG9jay50ZXh0ICs9IHBhcnQudGV4dDtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjdXJyZW50QmxvY2sudGV4dFNpZ25hdHVyZSA9IHJldGFpblRob3VnaHRTaWduYXR1cmUoXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjdXJyZW50QmxvY2sudGV4dFNpZ25hdHVyZSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdHBhcnQudGhvdWdodFNpZ25hdHVyZSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dF9kZWx0YVwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRkZWx0YTogcGFydC50ZXh0LFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0XHRcdGlmIChwYXJ0LmZ1bmN0aW9uQ2FsbCkge1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRoYXNDb250ZW50ID0gdHJ1ZTtcblx0XHRcdFx0XHRcdFx0XHRcdFx0aWYgKGN1cnJlbnRCbG9jaykge1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdGlmIChjdXJyZW50QmxvY2sudHlwZSA9PT0gXCJ0ZXh0XCIpIHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0X2VuZFwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudDogY3VycmVudEJsb2NrLnRleHQsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidGhpbmtpbmdfZW5kXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBjdXJyZW50QmxvY2sudGhpbmtpbmcsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjdXJyZW50QmxvY2sgPSBudWxsO1xuXHRcdFx0XHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0XHRcdFx0Y29uc3QgcHJvdmlkZWRJZCA9IHBhcnQuZnVuY3Rpb25DYWxsLmlkO1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRjb25zdCBuZWVkc05ld0lkID1cblx0XHRcdFx0XHRcdFx0XHRcdFx0XHQhcHJvdmlkZWRJZCB8fFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdG91dHB1dC5jb250ZW50LnNvbWUoKGIpID0+IGIudHlwZSA9PT0gXCJ0b29sQ2FsbFwiICYmIGIuaWQgPT09IHByb3ZpZGVkSWQpO1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRjb25zdCB0b29sQ2FsbElkID0gbmVlZHNOZXdJZFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdD8gYCR7cGFydC5mdW5jdGlvbkNhbGwubmFtZX1fJHtEYXRlLm5vdygpfV8keysrdG9vbENhbGxDb3VudGVyfWBcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHQ6IHByb3ZpZGVkSWQ7XG5cblx0XHRcdFx0XHRcdFx0XHRcdFx0Y29uc3QgdG9vbENhbGw6IFRvb2xDYWxsID0ge1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidG9vbENhbGxcIixcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRpZDogdG9vbENhbGxJZCxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRuYW1lOiBwYXJ0LmZ1bmN0aW9uQ2FsbC5uYW1lIHx8IFwiXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0YXJndW1lbnRzOiAocGFydC5mdW5jdGlvbkNhbGwuYXJncyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPz8ge30sXG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0Li4uKHBhcnQudGhvdWdodFNpZ25hdHVyZSAmJiB7IHRob3VnaHRTaWduYXR1cmU6IHBhcnQudGhvdWdodFNpZ25hdHVyZSB9KSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0fTtcblxuXHRcdFx0XHRcdFx0XHRcdFx0XHRvdXRwdXQuY29udGVudC5wdXNoKHRvb2xDYWxsKTtcblx0XHRcdFx0XHRcdFx0XHRcdFx0ZW5zdXJlU3RhcnRlZCgpO1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwidG9vbGNhbGxfc3RhcnRcIiwgY29udGVudEluZGV4OiBibG9ja0luZGV4KCksIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHRcdFx0XHRcdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRcdHR5cGU6IFwidG9vbGNhbGxfZGVsdGFcIixcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRkZWx0YTogSlNPTi5zdHJpbmdpZnkodG9vbENhbGwuYXJndW1lbnRzKSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0b29sY2FsbF9lbmRcIixcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHR0b29sQ2FsbCxcblx0XHRcdFx0XHRcdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRcdGlmIChjYW5kaWRhdGU/LmZpbmlzaFJlYXNvbikge1xuXHRcdFx0XHRcdFx0XHRcdG91dHB1dC5zdG9wUmVhc29uID0gbWFwU3RvcFJlYXNvblN0cmluZyhjYW5kaWRhdGUuZmluaXNoUmVhc29uKTtcblx0XHRcdFx0XHRcdFx0XHRpZiAob3V0cHV0LmNvbnRlbnQuc29tZSgoYikgPT4gYi50eXBlID09PSBcInRvb2xDYWxsXCIpKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRvdXRwdXQuc3RvcFJlYXNvbiA9IFwidG9vbFVzZVwiO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRcdGlmIChyZXNwb25zZURhdGEudXNhZ2VNZXRhZGF0YSkge1xuXHRcdFx0XHRcdFx0XHRcdC8vIHByb21wdFRva2VuQ291bnQgaW5jbHVkZXMgY2FjaGVkQ29udGVudFRva2VuQ291bnQsIHNvIHN1YnRyYWN0IHRvIGdldCBmcmVzaCBpbnB1dFxuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IHByb21wdFRva2VucyA9IHJlc3BvbnNlRGF0YS51c2FnZU1ldGFkYXRhLnByb21wdFRva2VuQ291bnQgfHwgMDtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBjYWNoZVJlYWRUb2tlbnMgPSByZXNwb25zZURhdGEudXNhZ2VNZXRhZGF0YS5jYWNoZWRDb250ZW50VG9rZW5Db3VudCB8fCAwO1xuXHRcdFx0XHRcdFx0XHRcdG91dHB1dC51c2FnZSA9IHtcblx0XHRcdFx0XHRcdFx0XHRcdGlucHV0OiBwcm9tcHRUb2tlbnMgLSBjYWNoZVJlYWRUb2tlbnMsXG5cdFx0XHRcdFx0XHRcdFx0XHRvdXRwdXQ6XG5cdFx0XHRcdFx0XHRcdFx0XHRcdChyZXNwb25zZURhdGEudXNhZ2VNZXRhZGF0YS5jYW5kaWRhdGVzVG9rZW5Db3VudCB8fCAwKSArXG5cdFx0XHRcdFx0XHRcdFx0XHRcdChyZXNwb25zZURhdGEudXNhZ2VNZXRhZGF0YS50aG91Z2h0c1Rva2VuQ291bnQgfHwgMCksXG5cdFx0XHRcdFx0XHRcdFx0XHRjYWNoZVJlYWQ6IGNhY2hlUmVhZFRva2Vucyxcblx0XHRcdFx0XHRcdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHRcdFx0XHRcdFx0XHR0b3RhbFRva2VuczogcmVzcG9uc2VEYXRhLnVzYWdlTWV0YWRhdGEudG90YWxUb2tlbkNvdW50IHx8IDAsXG5cdFx0XHRcdFx0XHRcdFx0XHRjb3N0OiB7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0XHRcdFx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdFx0XHRcdFx0XHRcdFx0dG90YWw6IDAsXG5cdFx0XHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHRcdFx0Y2FsY3VsYXRlQ29zdChtb2RlbCwgb3V0cHV0LnVzYWdlKTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBmaW5hbGx5IHtcblx0XHRcdFx0XHRvcHRpb25zPy5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBhYm9ydEhhbmRsZXIpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKGN1cnJlbnRCbG9jaykge1xuXHRcdFx0XHRcdGlmIChjdXJyZW50QmxvY2sudHlwZSA9PT0gXCJ0ZXh0XCIpIHtcblx0XHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0X2VuZFwiLFxuXHRcdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdFx0Y29udGVudDogY3VycmVudEJsb2NrLnRleHQsXG5cdFx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHRcdHR5cGU6IFwidGhpbmtpbmdfZW5kXCIsXG5cdFx0XHRcdFx0XHRcdGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLFxuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBjdXJyZW50QmxvY2sudGhpbmtpbmcsXG5cdFx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdHJldHVybiBoYXNDb250ZW50O1xuXHRcdFx0fTtcblxuXHRcdFx0bGV0IHJlY2VpdmVkQ29udGVudCA9IGZhbHNlO1xuXHRcdFx0bGV0IGN1cnJlbnRSZXNwb25zZSA9IHJlc3BvbnNlO1xuXG5cdFx0XHRmb3IgKGxldCBlbXB0eUF0dGVtcHQgPSAwOyBlbXB0eUF0dGVtcHQgPD0gTUFYX0VNUFRZX1NUUkVBTV9SRVRSSUVTOyBlbXB0eUF0dGVtcHQrKykge1xuXHRcdFx0XHRpZiAob3B0aW9ucz8uc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiUmVxdWVzdCB3YXMgYWJvcnRlZFwiKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChlbXB0eUF0dGVtcHQgPiAwKSB7XG5cdFx0XHRcdFx0Y29uc3QgYmFja29mZk1zID0gRU1QVFlfU1RSRUFNX0JBU0VfREVMQVlfTVMgKiAyICoqIChlbXB0eUF0dGVtcHQgLSAxKTtcblx0XHRcdFx0XHRhd2FpdCBzbGVlcChiYWNrb2ZmTXMsIG9wdGlvbnM/LnNpZ25hbCk7XG5cblx0XHRcdFx0XHRpZiAoIXJlcXVlc3RVcmwpIHtcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIk1pc3NpbmcgcmVxdWVzdCBVUkxcIik7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y3VycmVudFJlc3BvbnNlID0gYXdhaXQgZmV0Y2gocmVxdWVzdFVybCwge1xuXHRcdFx0XHRcdFx0bWV0aG9kOiBcIlBPU1RcIixcblx0XHRcdFx0XHRcdGhlYWRlcnM6IHJlcXVlc3RIZWFkZXJzLFxuXHRcdFx0XHRcdFx0Ym9keTogcmVxdWVzdEJvZHlKc29uLFxuXHRcdFx0XHRcdFx0c2lnbmFsOiBvcHRpb25zPy5zaWduYWwsXG5cdFx0XHRcdFx0fSk7XG5cblx0XHRcdFx0XHRpZiAoIWN1cnJlbnRSZXNwb25zZS5vaykge1xuXHRcdFx0XHRcdFx0Y29uc3QgcmV0cnlFcnJvclRleHQgPSBhd2FpdCBjdXJyZW50UmVzcG9uc2UudGV4dCgpO1xuXHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBDbG91ZCBDb2RlIEFzc2lzdCBBUEkgZXJyb3IgKCR7Y3VycmVudFJlc3BvbnNlLnN0YXR1c30pOiAke3JldHJ5RXJyb3JUZXh0fWApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IHN0cmVhbWVkID0gYXdhaXQgc3RyZWFtUmVzcG9uc2UoY3VycmVudFJlc3BvbnNlKTtcblx0XHRcdFx0aWYgKHN0cmVhbWVkKSB7XG5cdFx0XHRcdFx0cmVjZWl2ZWRDb250ZW50ID0gdHJ1ZTtcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChlbXB0eUF0dGVtcHQgPCBNQVhfRU1QVFlfU1RSRUFNX1JFVFJJRVMpIHtcblx0XHRcdFx0XHRyZXNldE91dHB1dCgpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGlmICghcmVjZWl2ZWRDb250ZW50KSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIkNsb3VkIENvZGUgQXNzaXN0IEFQSSByZXR1cm5lZCBhbiBlbXB0eSByZXNwb25zZVwiKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKG9wdGlvbnM/LnNpZ25hbD8uYWJvcnRlZCkge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJSZXF1ZXN0IHdhcyBhYm9ydGVkXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAob3V0cHV0LnN0b3BSZWFzb24gPT09IFwiYWJvcnRlZFwiIHx8IG91dHB1dC5zdG9wUmVhc29uID09PSBcImVycm9yXCIpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiQW4gdW5rbm93biBlcnJvciBvY2N1cnJlZFwiKTtcblx0XHRcdH1cblxuXHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcImRvbmVcIiwgcmVhc29uOiBvdXRwdXQuc3RvcFJlYXNvbiwgbWVzc2FnZTogb3V0cHV0IH0pO1xuXHRcdFx0c3RyZWFtLmVuZCgpO1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRmb3IgKGNvbnN0IGJsb2NrIG9mIG91dHB1dC5jb250ZW50KSB7XG5cdFx0XHRcdGlmIChcImluZGV4XCIgaW4gYmxvY2spIHtcblx0XHRcdFx0XHRkZWxldGUgKGJsb2NrIGFzIHsgaW5kZXg/OiBudW1iZXIgfSkuaW5kZXg7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdG91dHB1dC5zdG9wUmVhc29uID0gb3B0aW9ucz8uc2lnbmFsPy5hYm9ydGVkID8gXCJhYm9ydGVkXCIgOiBcImVycm9yXCI7XG5cdFx0XHRvdXRwdXQuZXJyb3JNZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBKU09OLnN0cmluZ2lmeShlcnJvcik7XG5cdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwiZXJyb3JcIiwgcmVhc29uOiBvdXRwdXQuc3RvcFJlYXNvbiwgZXJyb3I6IG91dHB1dCB9KTtcblx0XHRcdHN0cmVhbS5lbmQoKTtcblx0XHR9XG5cdH0pKCk7XG5cblx0cmV0dXJuIHN0cmVhbTtcbn07XG5cbmV4cG9ydCBjb25zdCBzdHJlYW1TaW1wbGVHb29nbGVHZW1pbmlDbGk6IFN0cmVhbUZ1bmN0aW9uPFwiZ29vZ2xlLWdlbWluaS1jbGlcIiwgU2ltcGxlU3RyZWFtT3B0aW9ucz4gPSAoXG5cdG1vZGVsOiBNb2RlbDxcImdvb2dsZS1nZW1pbmktY2xpXCI+LFxuXHRjb250ZXh0OiBDb250ZXh0LFxuXHRvcHRpb25zPzogU2ltcGxlU3RyZWFtT3B0aW9ucyxcbik6IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSA9PiB7XG5cdGNvbnN0IGFwaUtleSA9IG9wdGlvbnM/LmFwaUtleTtcblx0aWYgKCFhcGlLZXkpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoXCJHb29nbGUgQ2xvdWQgQ29kZSBBc3Npc3QgcmVxdWlyZXMgT0F1dGggYXV0aGVudGljYXRpb24uIFVzZSAvbG9naW4gdG8gYXV0aGVudGljYXRlLlwiKTtcblx0fVxuXG5cdGNvbnN0IGJhc2UgPSBidWlsZEJhc2VPcHRpb25zKG1vZGVsLCBvcHRpb25zLCBhcGlLZXkpO1xuXHRpZiAoIW9wdGlvbnM/LnJlYXNvbmluZykge1xuXHRcdHJldHVybiBzdHJlYW1Hb29nbGVHZW1pbmlDbGkobW9kZWwsIGNvbnRleHQsIHtcblx0XHRcdC4uLmJhc2UsXG5cdFx0XHR0aGlua2luZzogeyBlbmFibGVkOiBmYWxzZSB9LFxuXHRcdH0gc2F0aXNmaWVzIEdvb2dsZUdlbWluaUNsaU9wdGlvbnMpO1xuXHR9XG5cblx0Y29uc3QgZWZmb3J0ID0gY2xhbXBSZWFzb25pbmcob3B0aW9ucy5yZWFzb25pbmcpITtcblx0aWYgKGlzR2VtaW5pM01vZGVsKG1vZGVsLmlkKSkge1xuXHRcdHJldHVybiBzdHJlYW1Hb29nbGVHZW1pbmlDbGkobW9kZWwsIGNvbnRleHQsIHtcblx0XHRcdC4uLmJhc2UsXG5cdFx0XHR0aGlua2luZzoge1xuXHRcdFx0XHRlbmFibGVkOiB0cnVlLFxuXHRcdFx0XHRsZXZlbDogZ2V0R2VtaW5pQ2xpVGhpbmtpbmdMZXZlbChlZmZvcnQsIG1vZGVsLmlkKSxcblx0XHRcdH0sXG5cdFx0fSBzYXRpc2ZpZXMgR29vZ2xlR2VtaW5pQ2xpT3B0aW9ucyk7XG5cdH1cblxuXHRjb25zdCBkZWZhdWx0QnVkZ2V0czogVGhpbmtpbmdCdWRnZXRzID0ge1xuXHRcdG1pbmltYWw6IDEwMjQsXG5cdFx0bG93OiAyMDQ4LFxuXHRcdG1lZGl1bTogODE5Mixcblx0XHRoaWdoOiAxNjM4NCxcblx0fTtcblx0Y29uc3QgYnVkZ2V0cyA9IHsgLi4uZGVmYXVsdEJ1ZGdldHMsIC4uLm9wdGlvbnMudGhpbmtpbmdCdWRnZXRzIH07XG5cblx0Y29uc3QgbWluT3V0cHV0VG9rZW5zID0gMTAyNDtcblx0bGV0IHRoaW5raW5nQnVkZ2V0ID0gYnVkZ2V0c1tlZmZvcnRdITtcblx0Y29uc3QgbWF4VG9rZW5zID0gTWF0aC5taW4oKGJhc2UubWF4VG9rZW5zIHx8IDApICsgdGhpbmtpbmdCdWRnZXQsIG1vZGVsLm1heFRva2Vucyk7XG5cblx0aWYgKG1heFRva2VucyA8PSB0aGlua2luZ0J1ZGdldCkge1xuXHRcdHRoaW5raW5nQnVkZ2V0ID0gTWF0aC5tYXgoMCwgbWF4VG9rZW5zIC0gbWluT3V0cHV0VG9rZW5zKTtcblx0fVxuXG5cdHJldHVybiBzdHJlYW1Hb29nbGVHZW1pbmlDbGkobW9kZWwsIGNvbnRleHQsIHtcblx0XHQuLi5iYXNlLFxuXHRcdG1heFRva2Vucyxcblx0XHR0aGlua2luZzoge1xuXHRcdFx0ZW5hYmxlZDogdHJ1ZSxcblx0XHRcdGJ1ZGdldFRva2VuczogdGhpbmtpbmdCdWRnZXQsXG5cdFx0fSxcblx0fSBzYXRpc2ZpZXMgR29vZ2xlR2VtaW5pQ2xpT3B0aW9ucyk7XG59O1xuXG5mdW5jdGlvbiBidWlsZFJlcXVlc3QoXG5cdG1vZGVsOiBNb2RlbDxcImdvb2dsZS1nZW1pbmktY2xpXCI+LFxuXHRjb250ZXh0OiBDb250ZXh0LFxuXHRwcm9qZWN0SWQ6IHN0cmluZyxcblx0b3B0aW9uczogR29vZ2xlR2VtaW5pQ2xpT3B0aW9ucyA9IHt9LFxuXHRpc0FudGlncmF2aXR5ID0gZmFsc2UsXG4pOiBDbG91ZENvZGVBc3Npc3RSZXF1ZXN0IHtcblx0Y29uc3QgY29udGVudHMgPSBjb252ZXJ0TWVzc2FnZXMobW9kZWwsIGNvbnRleHQpO1xuXG5cdGNvbnN0IGdlbmVyYXRpb25Db25maWc6IENsb3VkQ29kZUFzc2lzdFJlcXVlc3RbXCJyZXF1ZXN0XCJdW1wiZ2VuZXJhdGlvbkNvbmZpZ1wiXSA9IHt9O1xuXHRpZiAob3B0aW9ucy50ZW1wZXJhdHVyZSAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0Z2VuZXJhdGlvbkNvbmZpZy50ZW1wZXJhdHVyZSA9IG9wdGlvbnMudGVtcGVyYXR1cmU7XG5cdH1cblx0aWYgKG9wdGlvbnMubWF4VG9rZW5zICE9PSB1bmRlZmluZWQpIHtcblx0XHRnZW5lcmF0aW9uQ29uZmlnLm1heE91dHB1dFRva2VucyA9IG9wdGlvbnMubWF4VG9rZW5zO1xuXHR9XG5cblx0Ly8gVGhpbmtpbmcgY29uZmlnXG5cdGlmIChvcHRpb25zLnRoaW5raW5nPy5lbmFibGVkICYmIG1vZGVsLnJlYXNvbmluZykge1xuXHRcdGdlbmVyYXRpb25Db25maWcudGhpbmtpbmdDb25maWcgPSB7XG5cdFx0XHRpbmNsdWRlVGhvdWdodHM6IHRydWUsXG5cdFx0fTtcblx0XHQvLyBHZW1pbmkgMyBtb2RlbHMgdXNlIHRoaW5raW5nTGV2ZWwsIG9sZGVyIG1vZGVscyB1c2UgdGhpbmtpbmdCdWRnZXRcblx0XHRpZiAob3B0aW9ucy50aGlua2luZy5sZXZlbCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHQvLyBDYXN0IHRvIGFueSBzaW5jZSBvdXIgR29vZ2xlVGhpbmtpbmdMZXZlbCBtaXJyb3JzIEdvb2dsZSdzIFRoaW5raW5nTGV2ZWwgZW51bSB2YWx1ZXNcblx0XHRcdGdlbmVyYXRpb25Db25maWcudGhpbmtpbmdDb25maWcudGhpbmtpbmdMZXZlbCA9IG9wdGlvbnMudGhpbmtpbmcubGV2ZWwgYXMgYW55O1xuXHRcdH0gZWxzZSBpZiAob3B0aW9ucy50aGlua2luZy5idWRnZXRUb2tlbnMgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0Z2VuZXJhdGlvbkNvbmZpZy50aGlua2luZ0NvbmZpZy50aGlua2luZ0J1ZGdldCA9IG9wdGlvbnMudGhpbmtpbmcuYnVkZ2V0VG9rZW5zO1xuXHRcdH1cblx0fVxuXG5cdGNvbnN0IHJlcXVlc3Q6IENsb3VkQ29kZUFzc2lzdFJlcXVlc3RbXCJyZXF1ZXN0XCJdID0ge1xuXHRcdGNvbnRlbnRzLFxuXHR9O1xuXG5cdHJlcXVlc3Quc2Vzc2lvbklkID0gb3B0aW9ucy5zZXNzaW9uSWQ7XG5cblx0Ly8gU3lzdGVtIGluc3RydWN0aW9uIG11c3QgYmUgb2JqZWN0IHdpdGggcGFydHMsIG5vdCBwbGFpbiBzdHJpbmdcblx0aWYgKGNvbnRleHQuc3lzdGVtUHJvbXB0KSB7XG5cdFx0cmVxdWVzdC5zeXN0ZW1JbnN0cnVjdGlvbiA9IHtcblx0XHRcdHBhcnRzOiBbeyB0ZXh0OiBzYW5pdGl6ZVN1cnJvZ2F0ZXMoY29udGV4dC5zeXN0ZW1Qcm9tcHQpIH1dLFxuXHRcdH07XG5cdH1cblxuXHRpZiAoT2JqZWN0LmtleXMoZ2VuZXJhdGlvbkNvbmZpZykubGVuZ3RoID4gMCkge1xuXHRcdHJlcXVlc3QuZ2VuZXJhdGlvbkNvbmZpZyA9IGdlbmVyYXRpb25Db25maWc7XG5cdH1cblxuXHRpZiAoY29udGV4dC50b29scyAmJiBjb250ZXh0LnRvb2xzLmxlbmd0aCA+IDApIHtcblx0XHQvLyBDbGF1ZGUgbW9kZWxzIG9uIENsb3VkIENvZGUgQXNzaXN0IG5lZWQgdGhlIGxlZ2FjeSBgcGFyYW1ldGVyc2AgZmllbGQ7XG5cdFx0Ly8gdGhlIEFQSSB0cmFuc2xhdGVzIGl0IGludG8gQW50aHJvcGljJ3MgYGlucHV0X3NjaGVtYWAuXG5cdFx0Y29uc3QgdXNlUGFyYW1ldGVycyA9IG1vZGVsLmlkLnN0YXJ0c1dpdGgoXCJjbGF1ZGUtXCIpO1xuXHRcdHJlcXVlc3QudG9vbHMgPSBjb252ZXJ0VG9vbHMoY29udGV4dC50b29scywgdXNlUGFyYW1ldGVycyk7XG5cdFx0aWYgKG9wdGlvbnMudG9vbENob2ljZSkge1xuXHRcdFx0cmVxdWVzdC50b29sQ29uZmlnID0ge1xuXHRcdFx0XHRmdW5jdGlvbkNhbGxpbmdDb25maWc6IHtcblx0XHRcdFx0XHRtb2RlOiBtYXBUb29sQ2hvaWNlKG9wdGlvbnMudG9vbENob2ljZSksXG5cdFx0XHRcdH0sXG5cdFx0XHR9O1xuXHRcdH1cblx0fVxuXG5cdGlmIChpc0FudGlncmF2aXR5KSB7XG5cdFx0Y29uc3QgZXhpc3RpbmdQYXJ0cyA9IHJlcXVlc3Quc3lzdGVtSW5zdHJ1Y3Rpb24/LnBhcnRzID8/IFtdO1xuXHRcdHJlcXVlc3Quc3lzdGVtSW5zdHJ1Y3Rpb24gPSB7XG5cdFx0XHRyb2xlOiBcInVzZXJcIixcblx0XHRcdHBhcnRzOiBbXG5cdFx0XHRcdHsgdGV4dDogQU5USUdSQVZJVFlfU1lTVEVNX0lOU1RSVUNUSU9OIH0sXG5cdFx0XHRcdHsgdGV4dDogYFBsZWFzZSBpZ25vcmUgZm9sbG93aW5nIFtpZ25vcmVdJHtBTlRJR1JBVklUWV9TWVNURU1fSU5TVFJVQ1RJT059Wy9pZ25vcmVdYCB9LFxuXHRcdFx0XHQuLi5leGlzdGluZ1BhcnRzLFxuXHRcdFx0XSxcblx0XHR9O1xuXHR9XG5cblx0cmV0dXJuIHtcblx0XHRwcm9qZWN0OiBwcm9qZWN0SWQsXG5cdFx0bW9kZWw6IG1vZGVsLmlkLFxuXHRcdHJlcXVlc3QsXG5cdFx0Li4uKGlzQW50aWdyYXZpdHkgPyB7IHJlcXVlc3RUeXBlOiBcImFnZW50XCIgfSA6IHt9KSxcblx0XHR1c2VyQWdlbnQ6IGlzQW50aWdyYXZpdHkgPyBcImFudGlncmF2aXR5XCIgOiBcInBpLWNvZGluZy1hZ2VudFwiLFxuXHRcdHJlcXVlc3RJZDogYCR7aXNBbnRpZ3Jhdml0eSA/IFwiYWdlbnRcIiA6IFwicGlcIn0tJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDExKX1gLFxuXHR9O1xufVxuXG50eXBlIENsYW1wZWRUaGlua2luZ0xldmVsID0gRXhjbHVkZTxUaGlua2luZ0xldmVsLCBcInhoaWdoXCI+O1xuXG5mdW5jdGlvbiBnZXRHZW1pbmlDbGlUaGlua2luZ0xldmVsKGVmZm9ydDogQ2xhbXBlZFRoaW5raW5nTGV2ZWwsIG1vZGVsSWQ6IHN0cmluZyk6IEdvb2dsZVRoaW5raW5nTGV2ZWwge1xuXHRpZiAoaXNHZW1pbmkzUHJvTW9kZWwobW9kZWxJZCkpIHtcblx0XHRzd2l0Y2ggKGVmZm9ydCkge1xuXHRcdFx0Y2FzZSBcIm1pbmltYWxcIjpcblx0XHRcdGNhc2UgXCJsb3dcIjpcblx0XHRcdFx0cmV0dXJuIFwiTE9XXCI7XG5cdFx0XHRjYXNlIFwibWVkaXVtXCI6XG5cdFx0XHRjYXNlIFwiaGlnaFwiOlxuXHRcdFx0XHRyZXR1cm4gXCJISUdIXCI7XG5cdFx0fVxuXHR9XG5cdHN3aXRjaCAoZWZmb3J0KSB7XG5cdFx0Y2FzZSBcIm1pbmltYWxcIjpcblx0XHRcdHJldHVybiBcIk1JTklNQUxcIjtcblx0XHRjYXNlIFwibG93XCI6XG5cdFx0XHRyZXR1cm4gXCJMT1dcIjtcblx0XHRjYXNlIFwibWVkaXVtXCI6XG5cdFx0XHRyZXR1cm4gXCJNRURJVU1cIjtcblx0XHRjYXNlIFwiaGlnaFwiOlxuXHRcdFx0cmV0dXJuIFwiSElHSFwiO1xuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFPQSxTQUFTLHFCQUFxQjtBQWU5QixTQUFTLG1DQUFtQztBQUM1QyxTQUFTLDBCQUEwQjtBQUNuQztBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFDUCxTQUFTLGtCQUFrQixzQkFBc0I7QUEyQmpELE1BQU0sbUJBQW1CO0FBQ3pCLE1BQU0sNkJBQTZCO0FBQ25DLE1BQU0sZ0NBQWdDO0FBQ3RDLE1BQU0saUNBQWlDO0FBQUEsRUFDdEM7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNEO0FBRUEsTUFBTSxxQkFBcUI7QUFBQSxFQUMxQixjQUFjO0FBQUEsRUFDZCxxQkFBcUI7QUFBQSxFQUNyQixtQkFBbUIsS0FBSyxVQUFVO0FBQUEsSUFDakMsU0FBUztBQUFBLElBQ1QsVUFBVTtBQUFBLElBQ1YsWUFBWTtBQUFBLEVBQ2IsQ0FBQztBQUNGO0FBR0EsTUFBTSw4QkFBOEI7QUFFcEMsU0FBUyx3QkFBd0I7QUFDaEMsUUFBTSxVQUFVLFFBQVEsSUFBSSw2QkFBNkI7QUFDekQsU0FBTztBQUFBLElBQ04sY0FBYyxlQUFlLE9BQU87QUFBQSxFQUNyQztBQUNEO0FBR0EsTUFBTSxpQ0FDTDtBQU1ELElBQUksa0JBQWtCO0FBR3RCLE1BQU0sY0FBYztBQUNwQixNQUFNLGdCQUFnQjtBQUN0QixNQUFNLDJCQUEyQjtBQUNqQyxNQUFNLDZCQUE2QjtBQUNuQyxNQUFNLDhCQUE4QjtBQVdwQyxTQUFTLGtCQUFrQixXQUFtQixVQUFtRDtBQUNoRyxRQUFNLGlCQUFpQixDQUFDLE9BQW9DLEtBQUssSUFBSSxLQUFLLEtBQUssS0FBSyxHQUFJLElB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
