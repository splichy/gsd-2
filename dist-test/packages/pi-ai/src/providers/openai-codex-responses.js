let _os = null;
const dynamicImport = (specifier) => import(specifier);
const NODE_OS_SPECIFIER = "node:os";
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
  dynamicImport(NODE_OS_SPECIFIER).then((m) => {
    _os = m;
  });
}
import { getEnvApiKey } from "../env-api-keys.js";
import { supportsXhigh } from "../models.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.js";
import { buildBaseOptions, clampReasoning } from "./simple-options.js";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1e3;
const CODEX_TOOL_CALL_PROVIDERS = /* @__PURE__ */ new Set(["openai", "openai-codex", "opencode"]);
const CODEX_RESPONSE_STATUSES = /* @__PURE__ */ new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "queued",
  "in_progress"
]);
function isRetryableError(status, errorText) {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}
function extractRetryDelay(errorText, response) {
  const normalizeDelay = (ms) => ms > 0 ? Math.ceil(ms) : void 0;
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
      const retryAfterDate = new Date(retryAfter).getTime();
      if (!Number.isNaN(retryAfterDate)) {
        const delay = normalizeDelay(retryAfterDate - Date.now());
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
const streamOpenAICodexResponses = (model, context, options) => {
  const stream = new AssistantMessageEventStream();
  (async () => {
    const output = {
      role: "assistant",
      content: [],
      api: "openai-codex-responses",
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
      if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }
      const accountId = extractAccountId(apiKey);
      let body = buildRequestBody(model, context, options);
      const nextBody = await options?.onPayload?.(body, model);
      if (nextBody !== void 0) {
        body = nextBody;
      }
      const headers = buildHeaders(model.headers, options?.headers, accountId, apiKey, options?.sessionId);
      const bodyJson = JSON.stringify(body);
      const transport = options?.transport || "sse";
      if (transport !== "sse") {
        let websocketStarted = false;
        try {
          await processWebSocketStream(
            resolveCodexWebSocketUrl(model.baseUrl),
            body,
            headers,
            output,
            stream,
            model,
            () => {
              websocketStarted = true;
            },
            options
          );
          if (options?.signal?.aborted) {
            throw new Error("Request was aborted");
          }
          stream.push({
            type: "done",
            reason: output.stopReason,
            message: output
          });
          stream.end();
          return;
        } catch (error) {
          if (transport === "websocket" || websocketStarted) {
            throw error;
          }
        }
      }
      let response;
      let lastError;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        try {
          response = await fetch(resolveCodexUrl(model.baseUrl), {
            method: "POST",
            headers,
            body: bodyJson,
            signal: options?.signal
          });
          if (response.ok) {
            break;
          }
          const errorText = await response.text();
          if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
            const backoffMs = BASE_DELAY_MS * 2 ** attempt;
            const serverDelayMs = extractRetryDelay(errorText, response);
            const delayMs = Math.max(backoffMs, serverDelayMs ?? 0);
            await sleep(delayMs, options?.signal);
            continue;
          }
          const fakeResponse = new Response(errorText, {
            status: response.status,
            statusText: response.statusText
          });
          const info = await parseErrorResponse(fakeResponse);
          throw new Error(info.friendlyMessage || info.message);
        } catch (error) {
          if (error instanceof Error) {
            if (error.name === "AbortError" || error.message === "Request was aborted") {
              throw new Error("Request was aborted");
            }
          }
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt < MAX_RETRIES && !lastError.message.includes("usage limit")) {
            const delayMs = BASE_DELAY_MS * 2 ** attempt;
            await sleep(delayMs, options?.signal);
            continue;
          }
          throw lastError;
        }
      }
      if (!response?.ok) {
        throw lastError ?? new Error("Failed after retries");
      }
      if (!response.body) {
        throw new Error("No response body");
      }
      stream.push({ type: "start", partial: output });
      await processStream(response, output, stream, model);
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
};
const streamSimpleOpenAICodexResponses = (model, context, options) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const base = buildBaseOptions(model, options, apiKey);
  const reasoningEffort = supportsXhigh(model) ? options?.reasoning : clampReasoning(options?.reasoning);
  return streamOpenAICodexResponses(model, context, {
    ...base,
    reasoningEffort
  });
};
function buildRequestBody(model, context, options) {
  const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false
  });
  const body = {
    model: model.id,
    store: false,
    stream: true,
    instructions: context.systemPrompt,
    input: messages,
    text: { verbosity: options?.textVerbosity || "medium" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: options?.sessionId,
    tool_choice: "auto",
    parallel_tool_calls: true
  };
  if (options?.temperature !== void 0) {
    body.temperature = options.temperature;
  }
  if (context.tools) {
    body.tools = convertResponsesTools(context.tools, { strict: null });
  }
  if (options?.reasoningEffort !== void 0) {
    body.reasoning = {
      effort: clampReasoningEffort(model.id, options.reasoningEffort),
      summary: options.reasoningSummary ?? "auto"
    };
  }
  return body;
}
function clampReasoningEffort(modelId, effort) {
  const id = modelId.includes("/") ? modelId.split("/").pop() : modelId;
  if ((id.startsWith("gpt-5.2") || id.startsWith("gpt-5.3") || id.startsWith("gpt-5.4")) && effort === "minimal")
    return "low";
  if (id === "gpt-5.1" && effort === "xhigh") return "high";
  if (id === "gpt-5.1-codex-mini") return effort === "high" || effort === "xhigh" ? "high" : "medium";
  return effort;
}
function resolveCodexUrl(baseUrl) {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}
function resolveCodexWebSocketUrl(baseUrl) {
  const url = new URL(resolveCodexUrl(baseUrl));
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}
async function processStream(response, output, stream, model) {
  await processResponsesStream(mapCodexEvents(parseSSE(response)), output, stream, model);
}
async function* mapCodexEvents(events) {
  for await (const event of events) {
    const type = typeof event.type === "string" ? event.type : void 0;
    if (!type) continue;
    if (type === "error") {
      const errorObj = event.error;
      const code = errorObj?.code || event.code || "";
      const errorType = errorObj?.type || "";
      const message = errorObj?.message || event.message || "";
      const prefix = errorType ? `Codex ${errorType}` : "Codex error";
      throw new Error(`${prefix}: ${message || code || JSON.stringify(event)}`);
    }
    if (type === "response.failed") {
      const msg = event.response?.error?.message;
      throw new Error(msg || "Codex response failed");
    }
    if (type === "response.done" || type === "response.completed") {
      const response = event.response;
      const normalizedResponse = response ? { ...response, status: normalizeCodexStatus(response.status) } : response;
      yield { ...event, type: "response.completed", response: normalizedResponse };
      continue;
    }
    yield event;
  }
}
function normalizeCodexStatus(status) {
  if (typeof status !== "string") return void 0;
  return CODEX_RESPONSE_STATUSES.has(status) ? status : void 0;
}
async function* parseSSE(response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const decoded = decoder.decode(value, { stream: true });
    buffer = buffer ? buffer + decoded : decoded;
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLines = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      if (dataLines.length > 0) {
        const data = dataLines.join("\n").trim();
        if (data && data !== "[DONE]") {
          try {
            yield JSON.parse(data);
          } catch {
          }
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  }
}
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1e3;
const MAX_WEBSOCKET_CACHE_SIZE = 10;
const websocketSessionCache = /* @__PURE__ */ new Map();
function getWebSocketConstructor() {
  const ctor = globalThis.WebSocket;
  if (typeof ctor !== "function") return null;
  return ctor;
}
function headersToRecord(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) {
    out[key] = value;
  }
  return out;
}
function getWebSocketReadyState(socket) {
  const readyState = socket.readyState;
  return typeof readyState === "number" ? readyState : void 0;
}
function isWebSocketReusable(socket) {
  const readyState = getWebSocketReadyState(socket);
  return readyState === void 0 || readyState === 1;
}
function closeWebSocketSilently(socket, code = 1e3, reason = "done") {
  try {
    socket.close(code, reason);
  } catch {
  }
}
function scheduleSessionWebSocketExpiry(sessionId, entry) {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
  }
  entry.idleTimer = setTimeout(() => {
    if (entry.busy) return;
    closeWebSocketSilently(entry.socket, 1e3, "idle_timeout");
    websocketSessionCache.delete(sessionId);
  }, SESSION_WEBSOCKET_CACHE_TTL_MS);
}
async function connectWebSocket(url, headers, signal) {
  const WebSocketCtor = getWebSocketConstructor();
  if (!WebSocketCtor) {
    throw new Error("WebSocket transport is not available in this runtime");
  }
  const wsHeaders = headersToRecord(headers);
  wsHeaders["OpenAI-Beta"] = OPENAI_BETA_RESPONSES_WEBSOCKETS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    try {
      socket = new WebSocketCtor(url, { headers: wsHeaders });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = (event) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(extractWebSocketError(event));
    };
    const onClose = (event) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(extractWebSocketCloseError(event));
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.close(1e3, "aborted");
      reject(new Error("Request was aborted"));
    };
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);
  });
}
async function acquireWebSocket(url, headers, sessionId, signal) {
  if (!sessionId) {
    const socket2 = await connectWebSocket(url, headers, signal);
    return {
      socket: socket2,
      release: ({ keep } = {}) => {
        if (keep === false) {
          closeWebSocketSilently(socket2);
          return;
        }
        closeWebSocketSilently(socket2);
      }
    };
  }
  const cached = websocketSessionCache.get(sessionId);
  if (cached) {
    if (cached.idleTimer) {
      clearTimeout(cached.idleTimer);
      cached.idleTimer = void 0;
    }
    if (!cached.busy && isWebSocketReusable(cached.socket)) {
      cached.busy = true;
      return {
        socket: cached.socket,
        release: ({ keep } = {}) => {
          if (!keep || !isWebSocketReusable(cached.socket)) {
            closeWebSocketSilently(cached.socket);
            websocketSessionCache.delete(sessionId);
            return;
          }
          cached.busy = false;
          scheduleSessionWebSocketExpiry(sessionId, cached);
        }
      };
    }
    if (cached.busy) {
      const socket2 = await connectWebSocket(url, headers, signal);
      return {
        socket: socket2,
        release: () => {
          closeWebSocketSilently(socket2);
        }
      };
    }
    if (!isWebSocketReusable(cached.socket)) {
      closeWebSocketSilently(cached.socket);
      websocketSessionCache.delete(sessionId);
    }
  }
  const socket = await connectWebSocket(url, headers, signal);
  const entry = { socket, busy: true };
  if (websocketSessionCache.size >= MAX_WEBSOCKET_CACHE_SIZE) {
    const oldestKey = websocketSessionCache.keys().next().value;
    if (oldestKey) {
      const oldEntry = websocketSessionCache.get(oldestKey);
      websocketSessionCache.delete(oldestKey);
      if (oldEntry) {
        if (oldEntry.idleTimer) clearTimeout(oldEntry.idleTimer);
        closeWebSocketSilently(oldEntry.socket);
      }
    }
  }
  websocketSessionCache.set(sessionId, entry);
  return {
    socket,
    release: ({ keep } = {}) => {
      if (!keep || !isWebSocketReusable(entry.socket)) {
        closeWebSocketSilently(entry.socket);
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        if (websocketSessionCache.get(sessionId) === entry) {
          websocketSessionCache.delete(sessionId);
        }
        return;
      }
      entry.busy = false;
      scheduleSessionWebSocketExpiry(sessionId, entry);
    }
  };
}
function extractWebSocketError(event) {
  if (event && typeof event === "object" && "message" in event) {
    const message = event.message;
    if (typeof message === "string" && message.length > 0) {
      return new Error(message);
    }
  }
  return new Error("WebSocket error");
}
function extractWebSocketCloseError(event) {
  if (event && typeof event === "object") {
    const code = "code" in event ? event.code : void 0;
    const reason = "reason" in event ? event.reason : void 0;
    const codeText = typeof code === "number" ? ` ${code}` : "";
    const reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
    return new Error(`WebSocket closed${codeText}${reasonText}`.trim());
  }
  return new Error("WebSocket closed");
}
async function decodeWebSocketData(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    const view = data;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (data && typeof data === "object" && "arrayBuffer" in data) {
    const blobLike = data;
    const arrayBuffer = await blobLike.arrayBuffer();
    return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }
  return null;
}
async function* parseWebSocket(socket, signal) {
  const queue = [];
  let pending = null;
  let done = false;
  let failed = null;
  let sawCompletion = false;
  const wake = () => {
    if (!pending) return;
    const resolve = pending;
    pending = null;
    resolve();
  };
  const cleanup = () => {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  };
  const onMessage = (event) => {
    void (async () => {
      try {
        if (!event || typeof event !== "object" || !("data" in event)) return;
        const text = await decodeWebSocketData(event.data);
        if (!text) return;
        const parsed = JSON.parse(text);
        const type = typeof parsed.type === "string" ? parsed.type : "";
        if (type === "response.completed" || type === "response.done") {
          sawCompletion = true;
          done = true;
        }
        queue.push(parsed);
        wake();
      } catch (err) {
        if (err instanceof SyntaxError) {
          return;
        }
        failed = err instanceof Error ? err : new Error(String(err));
        done = true;
        cleanup();
        wake();
      }
    })();
  };
  const onError = (event) => {
    failed = extractWebSocketError(event);
    done = true;
    wake();
  };
  const onClose = (event) => {
    if (sawCompletion) {
      done = true;
      wake();
      return;
    }
    if (!failed) {
      failed = extractWebSocketCloseError(event);
    }
    done = true;
    wake();
  };
  const onAbort = () => {
    failed = new Error("Request was aborted");
    done = true;
    wake();
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort);
  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (queue.length > 0) {
        yield queue.shift();
        continue;
      }
      if (done) break;
      await new Promise((resolve) => {
        pending = resolve;
      });
    }
    if (failed) {
      throw failed;
    }
    if (!sawCompletion) {
      throw new Error("WebSocket stream closed before response.completed");
    }
  } finally {
    cleanup();
  }
}
async function processWebSocketStream(url, body, headers, output, stream, model, onStart, options) {
  const { socket, release } = await acquireWebSocket(url, headers, options?.sessionId, options?.signal);
  let keepConnection = true;
  try {
    socket.send(JSON.stringify({ type: "response.create", ...body }));
    onStart();
    stream.push({ type: "start", partial: output });
    await processResponsesStream(mapCodexEvents(parseWebSocket(socket, options?.signal)), output, stream, model);
    if (options?.signal?.aborted) {
      keepConnection = false;
    }
  } catch (error) {
    keepConnection = false;
    throw error;
  } finally {
    release({ keep: keepConnection });
  }
}
async function parseErrorResponse(response) {
  const raw = await response.text();
  let message = raw || response.statusText || "Request failed";
  let friendlyMessage;
  try {
    const parsed = JSON.parse(raw);
    const err = parsed?.error;
    if (err) {
      const code = err.code || err.type || "";
      if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
        const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
        const mins = err.resets_at ? Math.max(0, Math.round((err.resets_at * 1e3 - Date.now()) / 6e4)) : void 0;
        const when = mins !== void 0 ? ` Try again in ~${mins} min.` : "";
        friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
      }
      message = err.message || friendlyMessage || message;
    }
  } catch {
  }
  return { message, friendlyMessage };
}
function extractAccountId(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const payload = JSON.parse(atob(parts[1]));
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    if (!accountId) throw new Error("No account ID in token");
    return accountId;
  } catch {
    throw new Error("Failed to extract accountId from token");
  }
}
function buildHeaders(initHeaders, additionalHeaders, accountId, token, sessionId) {
  const headers = new Headers(initHeaders);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("originator", "pi");
  const userAgent = _os ? `pi (${_os.platform()} ${_os.release()}; ${_os.arch()})` : "pi (browser)";
  headers.set("User-Agent", userAgent);
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  for (const [key, value] of Object.entries(additionalHeaders || {})) {
    headers.set(key, value);
  }
  if (sessionId) {
    headers.set("session_id", sessionId);
  }
  return headers;
}
export {
  streamOpenAICodexResponses,
  streamSimpleOpenAICodexResponses
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy9vcGVuYWktY29kZXgtcmVzcG9uc2VzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSAqIGFzIE5vZGVPcyBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHR5cGUgeyBUb29sIGFzIE9wZW5BSVRvb2wsIFJlc3BvbnNlSW5wdXQsIFJlc3BvbnNlU3RyZWFtRXZlbnQgfSBmcm9tIFwib3BlbmFpL3Jlc291cmNlcy9yZXNwb25zZXMvcmVzcG9uc2VzLmpzXCI7XG5cbi8vIE5FVkVSIGNvbnZlcnQgdG8gdG9wLWxldmVsIHJ1bnRpbWUgaW1wb3J0cyAtIGJyZWFrcyBicm93c2VyL1ZpdGUgYnVpbGRzICh3ZWItdWkpXG5sZXQgX29zOiB0eXBlb2YgTm9kZU9zIHwgbnVsbCA9IG51bGw7XG5cbnR5cGUgRHluYW1pY0ltcG9ydCA9IChzcGVjaWZpZXI6IHN0cmluZykgPT4gUHJvbWlzZTx1bmtub3duPjtcblxuY29uc3QgZHluYW1pY0ltcG9ydDogRHluYW1pY0ltcG9ydCA9IChzcGVjaWZpZXIpID0+IGltcG9ydChzcGVjaWZpZXIpO1xuY29uc3QgTk9ERV9PU19TUEVDSUZJRVIgPSBcIm5vZGU6XCIgKyBcIm9zXCI7XG5cbmlmICh0eXBlb2YgcHJvY2VzcyAhPT0gXCJ1bmRlZmluZWRcIiAmJiAocHJvY2Vzcy52ZXJzaW9ucz8ubm9kZSB8fCBwcm9jZXNzLnZlcnNpb25zPy5idW4pKSB7XG5cdGR5bmFtaWNJbXBvcnQoTk9ERV9PU19TUEVDSUZJRVIpLnRoZW4oKG0pID0+IHtcblx0XHRfb3MgPSBtIGFzIHR5cGVvZiBOb2RlT3M7XG5cdH0pO1xufVxuXG5pbXBvcnQgeyBnZXRFbnZBcGlLZXkgfSBmcm9tIFwiLi4vZW52LWFwaS1rZXlzLmpzXCI7XG5pbXBvcnQgeyBzdXBwb3J0c1hoaWdoIH0gZnJvbSBcIi4uL21vZGVscy5qc1wiO1xuaW1wb3J0IHR5cGUge1xuXHRBcGksXG5cdEFzc2lzdGFudE1lc3NhZ2UsXG5cdENvbnRleHQsXG5cdE1vZGVsLFxuXHRTaW1wbGVTdHJlYW1PcHRpb25zLFxuXHRTdHJlYW1GdW5jdGlvbixcblx0U3RyZWFtT3B0aW9ucyxcbn0gZnJvbSBcIi4uL3R5cGVzLmpzXCI7XG5pbXBvcnQgeyBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0gfSBmcm9tIFwiLi4vdXRpbHMvZXZlbnQtc3RyZWFtLmpzXCI7XG5pbXBvcnQgeyBjb252ZXJ0UmVzcG9uc2VzTWVzc2FnZXMsIGNvbnZlcnRSZXNwb25zZXNUb29scywgcHJvY2Vzc1Jlc3BvbnNlc1N0cmVhbSB9IGZyb20gXCIuL29wZW5haS1yZXNwb25zZXMtc2hhcmVkLmpzXCI7XG5pbXBvcnQgeyBidWlsZEJhc2VPcHRpb25zLCBjbGFtcFJlYXNvbmluZyB9IGZyb20gXCIuL3NpbXBsZS1vcHRpb25zLmpzXCI7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIENvbmZpZ3VyYXRpb25cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuY29uc3QgREVGQVVMVF9DT0RFWF9CQVNFX1VSTCA9IFwiaHR0cHM6Ly9jaGF0Z3B0LmNvbS9iYWNrZW5kLWFwaVwiO1xuY29uc3QgSldUX0NMQUlNX1BBVEggPSBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aFwiIGFzIGNvbnN0O1xuY29uc3QgTUFYX1JFVFJJRVMgPSAzO1xuY29uc3QgQkFTRV9ERUxBWV9NUyA9IDEwMDA7XG5jb25zdCBDT0RFWF9UT09MX0NBTExfUFJPVklERVJTID0gbmV3IFNldChbXCJvcGVuYWlcIiwgXCJvcGVuYWktY29kZXhcIiwgXCJvcGVuY29kZVwiXSk7XG5cbmNvbnN0IENPREVYX1JFU1BPTlNFX1NUQVRVU0VTID0gbmV3IFNldDxDb2RleFJlc3BvbnNlU3RhdHVzPihbXG5cdFwiY29tcGxldGVkXCIsXG5cdFwiaW5jb21wbGV0ZVwiLFxuXHRcImZhaWxlZFwiLFxuXHRcImNhbmNlbGxlZFwiLFxuXHRcInF1ZXVlZFwiLFxuXHRcImluX3Byb2dyZXNzXCIsXG5dKTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gVHlwZXNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGludGVyZmFjZSBPcGVuQUlDb2RleFJlc3BvbnNlc09wdGlvbnMgZXh0ZW5kcyBTdHJlYW1PcHRpb25zIHtcblx0cmVhc29uaW5nRWZmb3J0PzogXCJub25lXCIgfCBcIm1pbmltYWxcIiB8IFwibG93XCIgfCBcIm1lZGl1bVwiIHwgXCJoaWdoXCIgfCBcInhoaWdoXCI7XG5cdHJlYXNvbmluZ1N1bW1hcnk/OiBcImF1dG9cIiB8IFwiY29uY2lzZVwiIHwgXCJkZXRhaWxlZFwiIHwgXCJvZmZcIiB8IFwib25cIiB8IG51bGw7XG5cdHRleHRWZXJib3NpdHk/OiBcImxvd1wiIHwgXCJtZWRpdW1cIiB8IFwiaGlnaFwiO1xufVxuXG50eXBlIENvZGV4UmVzcG9uc2VTdGF0dXMgPSBcImNvbXBsZXRlZFwiIHwgXCJpbmNvbXBsZXRlXCIgfCBcImZhaWxlZFwiIHwgXCJjYW5jZWxsZWRcIiB8IFwicXVldWVkXCIgfCBcImluX3Byb2dyZXNzXCI7XG5cbmludGVyZmFjZSBSZXF1ZXN0Qm9keSB7XG5cdG1vZGVsOiBzdHJpbmc7XG5cdHN0b3JlPzogYm9vbGVhbjtcblx0c3RyZWFtPzogYm9vbGVhbjtcblx0aW5zdHJ1Y3Rpb25zPzogc3RyaW5nO1xuXHRpbnB1dD86IFJlc3BvbnNlSW5wdXQ7XG5cdHRvb2xzPzogT3BlbkFJVG9vbFtdO1xuXHR0b29sX2Nob2ljZT86IFwiYXV0b1wiO1xuXHRwYXJhbGxlbF90b29sX2NhbGxzPzogYm9vbGVhbjtcblx0dGVtcGVyYXR1cmU/OiBudW1iZXI7XG5cdHJlYXNvbmluZz86IHsgZWZmb3J0Pzogc3RyaW5nOyBzdW1tYXJ5Pzogc3RyaW5nIH07XG5cdHRleHQ/OiB7IHZlcmJvc2l0eT86IHN0cmluZyB9O1xuXHRpbmNsdWRlPzogc3RyaW5nW107XG5cdHByb21wdF9jYWNoZV9rZXk/OiBzdHJpbmc7XG5cdFtrZXk6IHN0cmluZ106IHVua25vd247XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFJldHJ5IEhlbHBlcnNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZnVuY3Rpb24gaXNSZXRyeWFibGVFcnJvcihzdGF0dXM6IG51bWJlciwgZXJyb3JUZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcblx0aWYgKHN0YXR1cyA9PT0gNDI5IHx8IHN0YXR1cyA9PT0gNTAwIHx8IHN0YXR1cyA9PT0gNTAyIHx8IHN0YXR1cyA9PT0gNTAzIHx8IHN0YXR1cyA9PT0gNTA0KSB7XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblx0cmV0dXJuIC9yYXRlLj9saW1pdHxvdmVybG9hZGVkfHNlcnZpY2UuP3VuYXZhaWxhYmxlfHVwc3RyZWFtLj9jb25uZWN0fGNvbm5lY3Rpb24uP3JlZnVzZWQvaS50ZXN0KGVycm9yVGV4dCk7XG59XG5cbmZ1bmN0aW9uIGV4dHJhY3RSZXRyeURlbGF5KGVycm9yVGV4dDogc3RyaW5nLCByZXNwb25zZT86IFJlc3BvbnNlIHwgSGVhZGVycyk6IG51bWJlciB8IHVuZGVmaW5lZCB7XG5cdGNvbnN0IG5vcm1hbGl6ZURlbGF5ID0gKG1zOiBudW1iZXIpOiBudW1iZXIgfCB1bmRlZmluZWQgPT4gKG1zID4gMCA/IE1hdGguY2VpbChtcykgOiB1bmRlZmluZWQpO1xuXG5cdGNvbnN0IGhlYWRlcnMgPSByZXNwb25zZSBpbnN0YW5jZW9mIEhlYWRlcnMgPyByZXNwb25zZSA6IHJlc3BvbnNlPy5oZWFkZXJzO1xuXHRpZiAoaGVhZGVycykge1xuXHRcdGNvbnN0IHJldHJ5QWZ0ZXIgPSBoZWFkZXJzLmdldChcInJldHJ5LWFmdGVyXCIpO1xuXHRcdGlmIChyZXRyeUFmdGVyKSB7XG5cdFx0XHRjb25zdCByZXRyeUFmdGVyU2Vjb25kcyA9IE51bWJlcihyZXRyeUFmdGVyKTtcblx0XHRcdGlmIChOdW1iZXIuaXNGaW5pdGUocmV0cnlBZnRlclNlY29uZHMpKSB7XG5cdFx0XHRcdGNvbnN0IGRlbGF5ID0gbm9ybWFsaXplRGVsYXkocmV0cnlBZnRlclNlY29uZHMgKiAxMDAwKTtcblx0XHRcdFx0aWYgKGRlbGF5ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0XHRyZXR1cm4gZGVsYXk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgcmV0cnlBZnRlckRhdGUgPSBuZXcgRGF0ZShyZXRyeUFmdGVyKS5nZXRUaW1lKCk7XG5cdFx0XHRpZiAoIU51bWJlci5pc05hTihyZXRyeUFmdGVyRGF0ZSkpIHtcblx0XHRcdFx0Y29uc3QgZGVsYXkgPSBub3JtYWxpemVEZWxheShyZXRyeUFmdGVyRGF0ZSAtIERhdGUubm93KCkpO1xuXHRcdFx0XHRpZiAoZGVsYXkgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRcdHJldHVybiBkZWxheTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGNvbnN0IHJhdGVMaW1pdFJlc2V0ID0gaGVhZGVycy5nZXQoXCJ4LXJhdGVsaW1pdC1yZXNldFwiKTtcblx0XHRpZiAocmF0ZUxpbWl0UmVzZXQpIHtcblx0XHRcdGNvbnN0IHJlc2V0U2Vjb25kcyA9IE51bWJlci5wYXJzZUludChyYXRlTGltaXRSZXNldCwgMTApO1xuXHRcdFx0aWYgKCFOdW1iZXIuaXNOYU4ocmVzZXRTZWNvbmRzKSkge1xuXHRcdFx0XHRjb25zdCBkZWxheSA9IG5vcm1hbGl6ZURlbGF5KHJlc2V0U2Vjb25kcyAqIDEwMDAgLSBEYXRlLm5vdygpKTtcblx0XHRcdFx0aWYgKGRlbGF5ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0XHRyZXR1cm4gZGVsYXk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHRjb25zdCByYXRlTGltaXRSZXNldEFmdGVyID0gaGVhZGVycy5nZXQoXCJ4LXJhdGVsaW1pdC1yZXNldC1hZnRlclwiKTtcblx0XHRpZiAocmF0ZUxpbWl0UmVzZXRBZnRlcikge1xuXHRcdFx0Y29uc3QgcmVzZXRBZnRlclNlY29uZHMgPSBOdW1iZXIocmF0ZUxpbWl0UmVzZXRBZnRlcik7XG5cdFx0XHRpZiAoTnVtYmVyLmlzRmluaXRlKHJlc2V0QWZ0ZXJTZWNvbmRzKSkge1xuXHRcdFx0XHRjb25zdCBkZWxheSA9IG5vcm1hbGl6ZURlbGF5KHJlc2V0QWZ0ZXJTZWNvbmRzICogMTAwMCk7XG5cdFx0XHRcdGlmIChkZWxheSAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0cmV0dXJuIGRlbGF5O1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0Y29uc3QgZHVyYXRpb25NYXRjaCA9IGVycm9yVGV4dC5tYXRjaCgvcmVzZXQgYWZ0ZXIgKD86KFxcZCspaCk/KD86KFxcZCspbSk/KFxcZCsoPzpcXC5cXGQrKT8pcy9pKTtcblx0aWYgKGR1cmF0aW9uTWF0Y2gpIHtcblx0XHRjb25zdCBob3VycyA9IGR1cmF0aW9uTWF0Y2hbMV0gPyBwYXJzZUludChkdXJhdGlvbk1hdGNoWzFdLCAxMCkgOiAwO1xuXHRcdGNvbnN0IG1pbnV0ZXMgPSBkdXJhdGlvbk1hdGNoWzJdID8gcGFyc2VJbnQoZHVyYXRpb25NYXRjaFsyXSwgMTApIDogMDtcblx0XHRjb25zdCBzZWNvbmRzID0gcGFyc2VGbG9hdChkdXJhdGlvbk1hdGNoWzNdKTtcblx0XHRpZiAoIU51bWJlci5pc05hTihzZWNvbmRzKSkge1xuXHRcdFx0Y29uc3QgdG90YWxNcyA9ICgoaG91cnMgKiA2MCArIG1pbnV0ZXMpICogNjAgKyBzZWNvbmRzKSAqIDEwMDA7XG5cdFx0XHRjb25zdCBkZWxheSA9IG5vcm1hbGl6ZURlbGF5KHRvdGFsTXMpO1xuXHRcdFx0aWYgKGRlbGF5ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0cmV0dXJuIGRlbGF5O1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdGNvbnN0IHJldHJ5SW5NYXRjaCA9IGVycm9yVGV4dC5tYXRjaCgvUGxlYXNlIHJldHJ5IGluIChbMC05Ll0rKShtc3xzKS9pKTtcblx0aWYgKHJldHJ5SW5NYXRjaD8uWzFdKSB7XG5cdFx0Y29uc3QgdmFsdWUgPSBwYXJzZUZsb2F0KHJldHJ5SW5NYXRjaFsxXSk7XG5cdFx0aWYgKCFOdW1iZXIuaXNOYU4odmFsdWUpICYmIHZhbHVlID4gMCkge1xuXHRcdFx0Y29uc3QgbXMgPSByZXRyeUluTWF0Y2hbMl0udG9Mb3dlckNhc2UoKSA9PT0gXCJtc1wiID8gdmFsdWUgOiB2YWx1ZSAqIDEwMDA7XG5cdFx0XHRjb25zdCBkZWxheSA9IG5vcm1hbGl6ZURlbGF5KG1zKTtcblx0XHRcdGlmIChkZWxheSAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdHJldHVybiBkZWxheTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRjb25zdCByZXRyeURlbGF5TWF0Y2ggPSBlcnJvclRleHQubWF0Y2goL1wicmV0cnlEZWxheVwiOlxccypcIihbMC05Ll0rKShtc3xzKVwiL2kpO1xuXHRpZiAocmV0cnlEZWxheU1hdGNoPy5bMV0pIHtcblx0XHRjb25zdCB2YWx1ZSA9IHBhcnNlRmxvYXQocmV0cnlEZWxheU1hdGNoWzFdKTtcblx0XHRpZiAoIU51bWJlci5pc05hTih2YWx1ZSkgJiYgdmFsdWUgPiAwKSB7XG5cdFx0XHRjb25zdCBtcyA9IHJldHJ5RGVsYXlNYXRjaFsyXS50b0xvd2VyQ2FzZSgpID09PSBcIm1zXCIgPyB2YWx1ZSA6IHZhbHVlICogMTAwMDtcblx0XHRcdGNvbnN0IGRlbGF5ID0gbm9ybWFsaXplRGVsYXkobXMpO1xuXHRcdFx0aWYgKGRlbGF5ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0cmV0dXJuIGRlbGF5O1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIHNsZWVwKG1zOiBudW1iZXIsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogUHJvbWlzZTx2b2lkPiB7XG5cdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0aWYgKHNpZ25hbD8uYWJvcnRlZCkge1xuXHRcdFx0cmVqZWN0KG5ldyBFcnJvcihcIlJlcXVlc3Qgd2FzIGFib3J0ZWRcIikpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dChyZXNvbHZlLCBtcyk7XG5cdFx0c2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgKCkgPT4ge1xuXHRcdFx0Y2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuXHRcdFx0cmVqZWN0KG5ldyBFcnJvcihcIlJlcXVlc3Qgd2FzIGFib3J0ZWRcIikpO1xuXHRcdH0pO1xuXHR9KTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gTWFpbiBTdHJlYW0gRnVuY3Rpb25cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGNvbnN0IHN0cmVhbU9wZW5BSUNvZGV4UmVzcG9uc2VzOiBTdHJlYW1GdW5jdGlvbjxcIm9wZW5haS1jb2RleC1yZXNwb25zZXNcIiwgT3BlbkFJQ29kZXhSZXNwb25zZXNPcHRpb25zPiA9IChcblx0bW9kZWw6IE1vZGVsPFwib3BlbmFpLWNvZGV4LXJlc3BvbnNlc1wiPixcblx0Y29udGV4dDogQ29udGV4dCxcblx0b3B0aW9ucz86IE9wZW5BSUNvZGV4UmVzcG9uc2VzT3B0aW9ucyxcbik6IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSA9PiB7XG5cdGNvbnN0IHN0cmVhbSA9IG5ldyBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0oKTtcblxuXHQoYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IG91dHB1dDogQXNzaXN0YW50TWVzc2FnZSA9IHtcblx0XHRcdHJvbGU6IFwiYXNzaXN0YW50XCIsXG5cdFx0XHRjb250ZW50OiBbXSxcblx0XHRcdGFwaTogXCJvcGVuYWktY29kZXgtcmVzcG9uc2VzXCIgYXMgQXBpLFxuXHRcdFx0cHJvdmlkZXI6IG1vZGVsLnByb3ZpZGVyLFxuXHRcdFx0bW9kZWw6IG1vZGVsLmlkLFxuXHRcdFx0dXNhZ2U6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0XHR0b3RhbFRva2VuczogMCxcblx0XHRcdFx0Y29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsOiAwIH0sXG5cdFx0XHR9LFxuXHRcdFx0c3RvcFJlYXNvbjogXCJzdG9wXCIsXG5cdFx0XHR0aW1lc3RhbXA6IERhdGUubm93KCksXG5cdFx0fTtcblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBhcGlLZXkgPSBvcHRpb25zPy5hcGlLZXkgfHwgZ2V0RW52QXBpS2V5KG1vZGVsLnByb3ZpZGVyKSB8fCBcIlwiO1xuXHRcdFx0aWYgKCFhcGlLZXkpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBObyBBUEkga2V5IGZvciBwcm92aWRlcjogJHttb2RlbC5wcm92aWRlcn1gKTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgYWNjb3VudElkID0gZXh0cmFjdEFjY291bnRJZChhcGlLZXkpO1xuXHRcdFx0bGV0IGJvZHkgPSBidWlsZFJlcXVlc3RCb2R5KG1vZGVsLCBjb250ZXh0LCBvcHRpb25zKTtcblx0XHRcdGNvbnN0IG5leHRCb2R5ID0gYXdhaXQgb3B0aW9ucz8ub25QYXlsb2FkPy4oYm9keSwgbW9kZWwpO1xuXHRcdFx0aWYgKG5leHRCb2R5ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0Ym9keSA9IG5leHRCb2R5IGFzIFJlcXVlc3RCb2R5O1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgaGVhZGVycyA9IGJ1aWxkSGVhZGVycyhtb2RlbC5oZWFkZXJzLCBvcHRpb25zPy5oZWFkZXJzLCBhY2NvdW50SWQsIGFwaUtleSwgb3B0aW9ucz8uc2Vzc2lvbklkKTtcblx0XHRcdGNvbnN0IGJvZHlKc29uID0gSlNPTi5zdHJpbmdpZnkoYm9keSk7XG5cdFx0XHRjb25zdCB0cmFuc3BvcnQgPSBvcHRpb25zPy50cmFuc3BvcnQgfHwgXCJzc2VcIjtcblxuXHRcdFx0aWYgKHRyYW5zcG9ydCAhPT0gXCJzc2VcIikge1xuXHRcdFx0XHRsZXQgd2Vic29ja2V0U3RhcnRlZCA9IGZhbHNlO1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGF3YWl0IHByb2Nlc3NXZWJTb2NrZXRTdHJlYW0oXG5cdFx0XHRcdFx0XHRyZXNvbHZlQ29kZXhXZWJTb2NrZXRVcmwobW9kZWwuYmFzZVVybCksXG5cdFx0XHRcdFx0XHRib2R5LFxuXHRcdFx0XHRcdFx0aGVhZGVycyxcblx0XHRcdFx0XHRcdG91dHB1dCxcblx0XHRcdFx0XHRcdHN0cmVhbSxcblx0XHRcdFx0XHRcdG1vZGVsLFxuXHRcdFx0XHRcdFx0KCkgPT4ge1xuXHRcdFx0XHRcdFx0XHR3ZWJzb2NrZXRTdGFydGVkID0gdHJ1ZTtcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRvcHRpb25zLFxuXHRcdFx0XHRcdCk7XG5cblx0XHRcdFx0XHRpZiAob3B0aW9ucz8uc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJSZXF1ZXN0IHdhcyBhYm9ydGVkXCIpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHR0eXBlOiBcImRvbmVcIixcblx0XHRcdFx0XHRcdHJlYXNvbjogb3V0cHV0LnN0b3BSZWFzb24gYXMgXCJzdG9wXCIgfCBcImxlbmd0aFwiIHwgXCJ0b29sVXNlXCIsXG5cdFx0XHRcdFx0XHRtZXNzYWdlOiBvdXRwdXQsXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0c3RyZWFtLmVuZCgpO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdFx0XHRpZiAodHJhbnNwb3J0ID09PSBcIndlYnNvY2tldFwiIHx8IHdlYnNvY2tldFN0YXJ0ZWQpIHtcblx0XHRcdFx0XHRcdHRocm93IGVycm9yO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQvLyBGZXRjaCB3aXRoIHJldHJ5IGxvZ2ljIGZvciByYXRlIGxpbWl0cyBhbmQgdHJhbnNpZW50IGVycm9yc1xuXHRcdFx0bGV0IHJlc3BvbnNlOiBSZXNwb25zZSB8IHVuZGVmaW5lZDtcblx0XHRcdGxldCBsYXN0RXJyb3I6IEVycm9yIHwgdW5kZWZpbmVkO1xuXG5cdFx0XHRmb3IgKGxldCBhdHRlbXB0ID0gMDsgYXR0ZW1wdCA8PSBNQVhfUkVUUklFUzsgYXR0ZW1wdCsrKSB7XG5cdFx0XHRcdGlmIChvcHRpb25zPy5zaWduYWw/LmFib3J0ZWQpIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJSZXF1ZXN0IHdhcyBhYm9ydGVkXCIpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRyZXNwb25zZSA9IGF3YWl0IGZldGNoKHJlc29sdmVDb2RleFVybChtb2RlbC5iYXNlVXJsKSwge1xuXHRcdFx0XHRcdFx0bWV0aG9kOiBcIlBPU1RcIixcblx0XHRcdFx0XHRcdGhlYWRlcnMsXG5cdFx0XHRcdFx0XHRib2R5OiBib2R5SnNvbixcblx0XHRcdFx0XHRcdHNpZ25hbDogb3B0aW9ucz8uc2lnbmFsLFxuXHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0aWYgKHJlc3BvbnNlLm9rKSB7XG5cdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjb25zdCBlcnJvclRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG5cdFx0XHRcdFx0aWYgKGF0dGVtcHQgPCBNQVhfUkVUUklFUyAmJiBpc1JldHJ5YWJsZUVycm9yKHJlc3BvbnNlLnN0YXR1cywgZXJyb3JUZXh0KSkge1xuXHRcdFx0XHRcdFx0Y29uc3QgYmFja29mZk1zID0gQkFTRV9ERUxBWV9NUyAqIDIgKiogYXR0ZW1wdDtcblx0XHRcdFx0XHRcdGNvbnN0IHNlcnZlckRlbGF5TXMgPSBleHRyYWN0UmV0cnlEZWxheShlcnJvclRleHQsIHJlc3BvbnNlKTtcblx0XHRcdFx0XHRcdGNvbnN0IGRlbGF5TXMgPSBNYXRoLm1heChiYWNrb2ZmTXMsIHNlcnZlckRlbGF5TXMgPz8gMCk7XG5cdFx0XHRcdFx0XHRhd2FpdCBzbGVlcChkZWxheU1zLCBvcHRpb25zPy5zaWduYWwpO1xuXHRcdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gUGFyc2UgZXJyb3IgZm9yIGZyaWVuZGx5IG1lc3NhZ2Ugb24gZmluYWwgYXR0ZW1wdCBvciBub24tcmV0cnlhYmxlIGVycm9yXG5cdFx0XHRcdFx0Y29uc3QgZmFrZVJlc3BvbnNlID0gbmV3IFJlc3BvbnNlKGVycm9yVGV4dCwge1xuXHRcdFx0XHRcdFx0c3RhdHVzOiByZXNwb25zZS5zdGF0dXMsXG5cdFx0XHRcdFx0XHRzdGF0dXNUZXh0OiByZXNwb25zZS5zdGF0dXNUZXh0LFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdGNvbnN0IGluZm8gPSBhd2FpdCBwYXJzZUVycm9yUmVzcG9uc2UoZmFrZVJlc3BvbnNlKTtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoaW5mby5mcmllbmRseU1lc3NhZ2UgfHwgaW5mby5tZXNzYWdlKTtcblx0XHRcdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdFx0XHRpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvcikge1xuXHRcdFx0XHRcdFx0aWYgKGVycm9yLm5hbWUgPT09IFwiQWJvcnRFcnJvclwiIHx8IGVycm9yLm1lc3NhZ2UgPT09IFwiUmVxdWVzdCB3YXMgYWJvcnRlZFwiKSB7XG5cdFx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIlJlcXVlc3Qgd2FzIGFib3J0ZWRcIik7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGxhc3RFcnJvciA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKTtcblx0XHRcdFx0XHQvLyBOZXR3b3JrIGVycm9ycyBhcmUgcmV0cnlhYmxlXG5cdFx0XHRcdFx0aWYgKGF0dGVtcHQgPCBNQVhfUkVUUklFUyAmJiAhbGFzdEVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoXCJ1c2FnZSBsaW1pdFwiKSkge1xuXHRcdFx0XHRcdFx0Y29uc3QgZGVsYXlNcyA9IEJBU0VfREVMQVlfTVMgKiAyICoqIGF0dGVtcHQ7XG5cdFx0XHRcdFx0XHRhd2FpdCBzbGVlcChkZWxheU1zLCBvcHRpb25zPy5zaWduYWwpO1xuXHRcdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdHRocm93IGxhc3RFcnJvcjtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRpZiAoIXJlc3BvbnNlPy5vaykge1xuXHRcdFx0XHR0aHJvdyBsYXN0RXJyb3IgPz8gbmV3IEVycm9yKFwiRmFpbGVkIGFmdGVyIHJldHJpZXNcIik7XG5cdFx0XHR9XG5cblx0XHRcdGlmICghcmVzcG9uc2UuYm9keSkge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJObyByZXNwb25zZSBib2R5XCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwic3RhcnRcIiwgcGFydGlhbDogb3V0cHV0IH0pO1xuXHRcdFx0YXdhaXQgcHJvY2Vzc1N0cmVhbShyZXNwb25zZSwgb3V0cHV0LCBzdHJlYW0sIG1vZGVsKTtcblxuXHRcdFx0aWYgKG9wdGlvbnM/LnNpZ25hbD8uYWJvcnRlZCkge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJSZXF1ZXN0IHdhcyBhYm9ydGVkXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwiZG9uZVwiLCByZWFzb246IG91dHB1dC5zdG9wUmVhc29uIGFzIFwic3RvcFwiIHwgXCJsZW5ndGhcIiB8IFwidG9vbFVzZVwiLCBtZXNzYWdlOiBvdXRwdXQgfSk7XG5cdFx0XHRzdHJlYW0uZW5kKCk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdG91dHB1dC5zdG9wUmVhc29uID0gb3B0aW9ucz8uc2lnbmFsPy5hYm9ydGVkID8gXCJhYm9ydGVkXCIgOiBcImVycm9yXCI7XG5cdFx0XHRvdXRwdXQuZXJyb3JNZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuXHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcImVycm9yXCIsIHJlYXNvbjogb3V0cHV0LnN0b3BSZWFzb24sIGVycm9yOiBvdXRwdXQgfSk7XG5cdFx0XHRzdHJlYW0uZW5kKCk7XG5cdFx0fVxuXHR9KSgpO1xuXG5cdHJldHVybiBzdHJlYW07XG59O1xuXG5leHBvcnQgY29uc3Qgc3RyZWFtU2ltcGxlT3BlbkFJQ29kZXhSZXNwb25zZXM6IFN0cmVhbUZ1bmN0aW9uPFwib3BlbmFpLWNvZGV4LXJlc3BvbnNlc1wiLCBTaW1wbGVTdHJlYW1PcHRpb25zPiA9IChcblx0bW9kZWw6IE1vZGVsPFwib3BlbmFpLWNvZGV4LXJlc3BvbnNlc1wiPixcblx0Y29udGV4dDogQ29udGV4dCxcblx0b3B0aW9ucz86IFNpbXBsZVN0cmVhbU9wdGlvbnMsXG4pOiBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0gPT4ge1xuXHRjb25zdCBhcGlLZXkgPSBvcHRpb25zPy5hcGlLZXkgfHwgZ2V0RW52QXBpS2V5KG1vZGVsLnByb3ZpZGVyKTtcblx0aWYgKCFhcGlLZXkpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoYE5vIEFQSSBrZXkgZm9yIHByb3ZpZGVyOiAke21vZGVsLnByb3ZpZGVyfWApO1xuXHR9XG5cblx0Y29uc3QgYmFzZSA9IGJ1aWxkQmFzZU9wdGlvbnMobW9kZWwsIG9wdGlvbnMsIGFwaUtleSk7XG5cdGNvbnN0IHJlYXNvbmluZ0VmZm9ydCA9IHN1cHBvcnRzWGhpZ2gobW9kZWwpID8gb3B0aW9ucz8ucmVhc29uaW5nIDogY2xhbXBSZWFzb25pbmcob3B0aW9ucz8ucmVhc29uaW5nKTtcblxuXHRyZXR1cm4gc3RyZWFtT3BlbkFJQ29kZXhSZXNwb25zZXMobW9kZWwsIGNvbnRleHQsIHtcblx0XHQuLi5iYXNlLFxuXHRcdHJlYXNvbmluZ0VmZm9ydCxcblx0fSBzYXRpc2ZpZXMgT3BlbkFJQ29kZXhSZXNwb25zZXNPcHRpb25zKTtcbn07XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFJlcXVlc3QgQnVpbGRpbmdcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZnVuY3Rpb24gYnVpbGRSZXF1ZXN0Qm9keShcblx0bW9kZWw6IE1vZGVsPFwib3BlbmFpLWNvZGV4LXJlc3BvbnNlc1wiPixcblx0Y29udGV4dDogQ29udGV4dCxcblx0b3B0aW9ucz86IE9wZW5BSUNvZGV4UmVzcG9uc2VzT3B0aW9ucyxcbik6IFJlcXVlc3RCb2R5IHtcblx0Y29uc3QgbWVzc2FnZXMgPSBjb252ZXJ0UmVzcG9uc2VzTWVzc2FnZXMobW9kZWwsIGNvbnRleHQsIENPREVYX1RPT0xfQ0FMTF9QUk9WSURFUlMsIHtcblx0XHRpbmNsdWRlU3lzdGVtUHJvbXB0OiBmYWxzZSxcblx0fSk7XG5cblx0Y29uc3QgYm9keTogUmVxdWVzdEJvZHkgPSB7XG5cdFx0bW9kZWw6IG1vZGVsLmlkLFxuXHRcdHN0b3JlOiBmYWxzZSxcblx0XHRzdHJlYW06IHRydWUsXG5cdFx0aW5zdHJ1Y3Rpb25zOiBjb250ZXh0LnN5c3RlbVByb21wdCxcblx0XHRpbnB1dDogbWVzc2FnZXMsXG5cdFx0dGV4dDogeyB2ZXJib3NpdHk6IG9wdGlvbnM/LnRleHRWZXJib3NpdHkgfHwgXCJtZWRpdW1cIiB9LFxuXHRcdGluY2x1ZGU6IFtcInJlYXNvbmluZy5lbmNyeXB0ZWRfY29udGVudFwiXSxcblx0XHRwcm9tcHRfY2FjaGVfa2V5OiBvcHRpb25zPy5zZXNzaW9uSWQsXG5cdFx0dG9vbF9jaG9pY2U6IFwiYXV0b1wiLFxuXHRcdHBhcmFsbGVsX3Rvb2xfY2FsbHM6IHRydWUsXG5cdH07XG5cblx0aWYgKG9wdGlvbnM/LnRlbXBlcmF0dXJlICE9PSB1bmRlZmluZWQpIHtcblx0XHRib2R5LnRlbXBlcmF0dXJlID0gb3B0aW9ucy50ZW1wZXJhdHVyZTtcblx0fVxuXG5cdGlmIChjb250ZXh0LnRvb2xzKSB7XG5cdFx0Ym9keS50b29scyA9IGNvbnZlcnRSZXNwb25zZXNUb29scyhjb250ZXh0LnRvb2xzLCB7IHN0cmljdDogbnVsbCB9KTtcblx0fVxuXG5cdGlmIChvcHRpb25zPy5yZWFzb25pbmdFZmZvcnQgIT09IHVuZGVmaW5lZCkge1xuXHRcdGJvZHkucmVhc29uaW5nID0ge1xuXHRcdFx0ZWZmb3J0OiBjbGFtcFJlYXNvbmluZ0VmZm9ydChtb2RlbC5pZCwgb3B0aW9ucy5yZWFzb25pbmdFZmZvcnQpLFxuXHRcdFx0c3VtbWFyeTogb3B0aW9ucy5yZWFzb25pbmdTdW1tYXJ5ID8/IFwiYXV0b1wiLFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4gYm9keTtcbn1cblxuZnVuY3Rpb24gY2xhbXBSZWFzb25pbmdFZmZvcnQobW9kZWxJZDogc3RyaW5nLCBlZmZvcnQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdGNvbnN0IGlkID0gbW9kZWxJZC5pbmNsdWRlcyhcIi9cIikgPyBtb2RlbElkLnNwbGl0KFwiL1wiKS5wb3AoKSEgOiBtb2RlbElkO1xuXHRpZiAoKGlkLnN0YXJ0c1dpdGgoXCJncHQtNS4yXCIpIHx8IGlkLnN0YXJ0c1dpdGgoXCJncHQtNS4zXCIpIHx8IGlkLnN0YXJ0c1dpdGgoXCJncHQtNS40XCIpKSAmJiBlZmZvcnQgPT09IFwibWluaW1hbFwiKVxuXHRcdHJldHVybiBcImxvd1wiO1xuXHRpZiAoaWQgPT09IFwiZ3B0LTUuMVwiICYmIGVmZm9ydCA9PT0gXCJ4aGlnaFwiKSByZXR1cm4gXCJoaWdoXCI7XG5cdGlmIChpZCA9PT0gXCJncHQtNS4xLWNvZGV4LW1pbmlcIikgcmV0dXJuIGVmZm9ydCA9PT0gXCJoaWdoXCIgfHwgZWZmb3J0ID09PSBcInhoaWdoXCIgPyBcImhpZ2hcIiA6IFwibWVkaXVtXCI7XG5cdHJldHVybiBlZmZvcnQ7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVDb2RleFVybChiYXNlVXJsPzogc3RyaW5nKTogc3RyaW5nIHtcblx0Y29uc3QgcmF3ID0gYmFzZVVybCAmJiBiYXNlVXJsLnRyaW0oKS5sZW5ndGggPiAwID8gYmFzZVVybCA6IERFRkFVTFRfQ09ERVhfQkFTRV9VUkw7XG5cdGNvbnN0IG5vcm1hbGl6ZWQgPSByYXcucmVwbGFjZSgvXFwvKyQvLCBcIlwiKTtcblx0aWYgKG5vcm1hbGl6ZWQuZW5kc1dpdGgoXCIvY29kZXgvcmVzcG9uc2VzXCIpKSByZXR1cm4gbm9ybWFsaXplZDtcblx0aWYgKG5vcm1hbGl6ZWQuZW5kc1dpdGgoXCIvY29kZXhcIikpIHJldHVybiBgJHtub3JtYWxpemVkfS9yZXNwb25zZXNgO1xuXHRyZXR1cm4gYCR7bm9ybWFsaXplZH0vY29kZXgvcmVzcG9uc2VzYDtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZUNvZGV4V2ViU29ja2V0VXJsKGJhc2VVcmw/OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCB1cmwgPSBuZXcgVVJMKHJlc29sdmVDb2RleFVybChiYXNlVXJsKSk7XG5cdGlmICh1cmwucHJvdG9jb2wgPT09IFwiaHR0cHM6XCIpIHVybC5wcm90b2NvbCA9IFwid3NzOlwiO1xuXHRpZiAodXJsLnByb3RvY29sID09PSBcImh0dHA6XCIpIHVybC5wcm90b2NvbCA9IFwid3M6XCI7XG5cdHJldHVybiB1cmwudG9TdHJpbmcoKTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gUmVzcG9uc2UgUHJvY2Vzc2luZ1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5hc3luYyBmdW5jdGlvbiBwcm9jZXNzU3RyZWFtKFxuXHRyZXNwb25zZTogUmVzcG9uc2UsXG5cdG91dHB1dDogQXNzaXN0YW50TWVzc2FnZSxcblx0c3RyZWFtOiBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0sXG5cdG1vZGVsOiBNb2RlbDxcIm9wZW5haS1jb2RleC1yZXNwb25zZXNcIj4sXG4pOiBQcm9taXNlPHZvaWQ+IHtcblx0YXdhaXQgcHJvY2Vzc1Jlc3BvbnNlc1N0cmVhbShtYXBDb2RleEV2ZW50cyhwYXJzZVNTRShyZXNwb25zZSkpLCBvdXRwdXQsIHN0cmVhbSwgbW9kZWwpO1xufVxuXG5hc3luYyBmdW5jdGlvbiogbWFwQ29kZXhFdmVudHMoZXZlbnRzOiBBc3luY0l0ZXJhYmxlPFJlY29yZDxzdHJpbmcsIHVua25vd24+Pik6IEFzeW5jR2VuZXJhdG9yPFJlc3BvbnNlU3RyZWFtRXZlbnQ+IHtcblx0Zm9yIGF3YWl0IChjb25zdCBldmVudCBvZiBldmVudHMpIHtcblx0XHRjb25zdCB0eXBlID0gdHlwZW9mIGV2ZW50LnR5cGUgPT09IFwic3RyaW5nXCIgPyBldmVudC50eXBlIDogdW5kZWZpbmVkO1xuXHRcdGlmICghdHlwZSkgY29udGludWU7XG5cblx0XHRpZiAodHlwZSA9PT0gXCJlcnJvclwiKSB7XG5cdFx0XHQvLyBDb2RleCBlcnJvciBldmVudHMgbmVzdCBkZXRhaWxzIHVuZGVyIGV2ZW50LmVycm9yIChlLmcuXG5cdFx0XHQvLyB7IHR5cGU6IFwiZXJyb3JcIiwgZXJyb3I6IHsgdHlwZTogXCJzZXJ2ZXJfZXJyb3JcIiwgY29kZTogXCJzZXJ2ZXJfZXJyb3JcIiwgbWVzc2FnZTogXCIuLi5cIiB9IH0pXG5cdFx0XHRjb25zdCBlcnJvck9iaiA9IChldmVudCBhcyB7IGVycm9yPzogeyBjb2RlPzogc3RyaW5nOyB0eXBlPzogc3RyaW5nOyBtZXNzYWdlPzogc3RyaW5nIH0gfSkuZXJyb3I7XG5cdFx0XHRjb25zdCBjb2RlID0gZXJyb3JPYmo/LmNvZGUgfHwgKGV2ZW50IGFzIHsgY29kZT86IHN0cmluZyB9KS5jb2RlIHx8IFwiXCI7XG5cdFx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnJvck9iaj8udHlwZSB8fCBcIlwiO1xuXHRcdFx0Y29uc3QgbWVzc2FnZSA9IGVycm9yT2JqPy5tZXNzYWdlIHx8IChldmVudCBhcyB7IG1lc3NhZ2U/OiBzdHJpbmcgfSkubWVzc2FnZSB8fCBcIlwiO1xuXHRcdFx0Y29uc3QgcHJlZml4ID0gZXJyb3JUeXBlID8gYENvZGV4ICR7ZXJyb3JUeXBlfWAgOiBcIkNvZGV4IGVycm9yXCI7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoYCR7cHJlZml4fTogJHttZXNzYWdlIHx8IGNvZGUgfHwgSlNPTi5zdHJpbmdpZnkoZXZlbnQpfWApO1xuXHRcdH1cblxuXHRcdGlmICh0eXBlID09PSBcInJlc3BvbnNlLmZhaWxlZFwiKSB7XG5cdFx0XHRjb25zdCBtc2cgPSAoZXZlbnQgYXMgeyByZXNwb25zZT86IHsgZXJyb3I/OiB7IG1lc3NhZ2U/OiBzdHJpbmcgfSB9IH0pLnJlc3BvbnNlPy5lcnJvcj8ubWVzc2FnZTtcblx0XHRcdHRocm93IG5ldyBFcnJvcihtc2cgfHwgXCJDb2RleCByZXNwb25zZSBmYWlsZWRcIik7XG5cdFx0fVxuXG5cdFx0aWYgKHR5cGUgPT09IFwicmVzcG9uc2UuZG9uZVwiIHx8IHR5cGUgPT09IFwicmVzcG9uc2UuY29tcGxldGVkXCIpIHtcblx0XHRcdGNvbnN0IHJlc3BvbnNlID0gKGV2ZW50IGFzIHsgcmVzcG9uc2U/OiB7IHN0YXR1cz86IHVua25vd24gfSB9KS5yZXNwb25zZTtcblx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRSZXNwb25zZSA9IHJlc3BvbnNlXG5cdFx0XHRcdD8geyAuLi5yZXNwb25zZSwgc3RhdHVzOiBub3JtYWxpemVDb2RleFN0YXR1cyhyZXNwb25zZS5zdGF0dXMpIH1cblx0XHRcdFx0OiByZXNwb25zZTtcblx0XHRcdHlpZWxkIHsgLi4uZXZlbnQsIHR5cGU6IFwicmVzcG9uc2UuY29tcGxldGVkXCIsIHJlc3BvbnNlOiBub3JtYWxpemVkUmVzcG9uc2UgfSBhcyBSZXNwb25zZVN0cmVhbUV2ZW50O1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0eWllbGQgZXZlbnQgYXMgdW5rbm93biBhcyBSZXNwb25zZVN0cmVhbUV2ZW50O1xuXHR9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUNvZGV4U3RhdHVzKHN0YXR1czogdW5rbm93bik6IENvZGV4UmVzcG9uc2VTdGF0dXMgfCB1bmRlZmluZWQge1xuXHRpZiAodHlwZW9mIHN0YXR1cyAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIHVuZGVmaW5lZDtcblx0cmV0dXJuIENPREVYX1JFU1BPTlNFX1NUQVRVU0VTLmhhcyhzdGF0dXMgYXMgQ29kZXhSZXNwb25zZVN0YXR1cykgPyAoc3RhdHVzIGFzIENvZGV4UmVzcG9uc2VTdGF0dXMpIDogdW5kZWZpbmVkO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBTU0UgUGFyc2luZ1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5hc3luYyBmdW5jdGlvbiogcGFyc2VTU0UocmVzcG9uc2U6IFJlc3BvbnNlKTogQXN5bmNHZW5lcmF0b3I8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcblx0aWYgKCFyZXNwb25zZS5ib2R5KSByZXR1cm47XG5cblx0Y29uc3QgcmVhZGVyID0gcmVzcG9uc2UuYm9keS5nZXRSZWFkZXIoKTtcblx0Y29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuXHRsZXQgYnVmZmVyID0gXCJcIjtcblxuXHR3aGlsZSAodHJ1ZSkge1xuXHRcdGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG5cdFx0aWYgKGRvbmUpIGJyZWFrO1xuXG5cdFx0Y29uc3QgZGVjb2RlZCA9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblx0XHQvLyBBdm9pZCBhcHBlbmRpbmcgdG8gYW4gZW1wdHkgYnVmZmVyIFx1MjAxNCBhc3NpZ24gZGlyZWN0bHkgdG8gc2tpcCB0aGVcblx0XHQvLyBzdHJpbmcgY29uY2F0ZW5hdGlvbiBhbmQgaXRzIGludGVybWVkaWF0ZSBhbGxvY2F0aW9uLlxuXHRcdGJ1ZmZlciA9IGJ1ZmZlciA/IGJ1ZmZlciArIGRlY29kZWQgOiBkZWNvZGVkO1xuXG5cdFx0Ly8gQ29uc3VtZSBhbGwgY29tcGxldGUgU1NFIG1lc3NhZ2VzIChkZWxpbWl0ZWQgYnkgXFxuXFxuKSBzbyB0aGVcblx0XHQvLyBidWZmZXIgb25seSBldmVyIGhvbGRzIG9uZSBwYXJ0aWFsIG1lc3NhZ2UgYmV0d2VlbiByZWFkcy5cblx0XHRsZXQgaWR4ID0gYnVmZmVyLmluZGV4T2YoXCJcXG5cXG5cIik7XG5cdFx0d2hpbGUgKGlkeCAhPT0gLTEpIHtcblx0XHRcdGNvbnN0IGNodW5rID0gYnVmZmVyLnNsaWNlKDAsIGlkeCk7XG5cdFx0XHRidWZmZXIgPSBidWZmZXIuc2xpY2UoaWR4ICsgMik7XG5cblx0XHRcdGNvbnN0IGRhdGFMaW5lcyA9IGNodW5rXG5cdFx0XHRcdC5zcGxpdChcIlxcblwiKVxuXHRcdFx0XHQuZmlsdGVyKChsKSA9PiBsLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSlcblx0XHRcdFx0Lm1hcCgobCkgPT4gbC5zbGljZSg1KS50cmltKCkpO1xuXHRcdFx0aWYgKGRhdGFMaW5lcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdGNvbnN0IGRhdGEgPSBkYXRhTGluZXMuam9pbihcIlxcblwiKS50cmltKCk7XG5cdFx0XHRcdGlmIChkYXRhICYmIGRhdGEgIT09IFwiW0RPTkVdXCIpIHtcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0eWllbGQgSlNPTi5wYXJzZShkYXRhKTtcblx0XHRcdFx0XHR9IGNhdGNoIHt9XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdGlkeCA9IGJ1ZmZlci5pbmRleE9mKFwiXFxuXFxuXCIpO1xuXHRcdH1cblx0fVxufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBXZWJTb2NrZXQgUGFyc2luZ1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5jb25zdCBPUEVOQUlfQkVUQV9SRVNQT05TRVNfV0VCU09DS0VUUyA9IFwicmVzcG9uc2VzX3dlYnNvY2tldHM9MjAyNi0wMi0wNlwiO1xuY29uc3QgU0VTU0lPTl9XRUJTT0NLRVRfQ0FDSEVfVFRMX01TID0gNSAqIDYwICogMTAwMDtcbmNvbnN0IE1BWF9XRUJTT0NLRVRfQ0FDSEVfU0laRSA9IDEwO1xuXG50eXBlIFdlYlNvY2tldEV2ZW50VHlwZSA9IFwib3BlblwiIHwgXCJtZXNzYWdlXCIgfCBcImVycm9yXCIgfCBcImNsb3NlXCI7XG50eXBlIFdlYlNvY2tldExpc3RlbmVyID0gKGV2ZW50OiB1bmtub3duKSA9PiB2b2lkO1xuXG5pbnRlcmZhY2UgV2ViU29ja2V0TGlrZSB7XG5cdGNsb3NlKGNvZGU/OiBudW1iZXIsIHJlYXNvbj86IHN0cmluZyk6IHZvaWQ7XG5cdHNlbmQoZGF0YTogc3RyaW5nKTogdm9pZDtcblx0YWRkRXZlbnRMaXN0ZW5lcih0eXBlOiBXZWJTb2NrZXRFdmVudFR5cGUsIGxpc3RlbmVyOiBXZWJTb2NrZXRMaXN0ZW5lcik6IHZvaWQ7XG5cdHJlbW92ZUV2ZW50TGlzdGVuZXIodHlwZTogV2ViU29ja2V0RXZlbnRUeXBlLCBsaXN0ZW5lcjogV2ViU29ja2V0TGlzdGVuZXIpOiB2b2lkO1xufVxuXG5pbnRlcmZhY2UgQ2FjaGVkV2ViU29ja2V0Q29ubmVjdGlvbiB7XG5cdHNvY2tldDogV2ViU29ja2V0TGlrZTtcblx0YnVzeTogYm9vbGVhbjtcblx0aWRsZVRpbWVyPzogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD47XG59XG5cbmNvbnN0IHdlYnNvY2tldFNlc3Npb25DYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBDYWNoZWRXZWJTb2NrZXRDb25uZWN0aW9uPigpO1xuXG50eXBlIFdlYlNvY2tldENvbnN0cnVjdG9yID0gbmV3IChcblx0dXJsOiBzdHJpbmcsXG5cdHByb3RvY29scz86IHN0cmluZyB8IHN0cmluZ1tdIHwgeyBoZWFkZXJzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB9LFxuKSA9PiBXZWJTb2NrZXRMaWtlO1xuXG5mdW5jdGlvbiBnZXRXZWJTb2NrZXRDb25zdHJ1Y3RvcigpOiBXZWJTb2NrZXRDb25zdHJ1Y3RvciB8IG51bGwge1xuXHRjb25zdCBjdG9yID0gKGdsb2JhbFRoaXMgYXMgeyBXZWJTb2NrZXQ/OiB1bmtub3duIH0pLldlYlNvY2tldDtcblx0aWYgKHR5cGVvZiBjdG9yICE9PSBcImZ1bmN0aW9uXCIpIHJldHVybiBudWxsO1xuXHRyZXR1cm4gY3RvciBhcyB1bmtub3duIGFzIFdlYlNvY2tldENvbnN0cnVjdG9yO1xufVxuXG5mdW5jdGlvbiBoZWFkZXJzVG9SZWNvcmQoaGVhZGVyczogSGVhZGVycyk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuXHRjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcblx0Zm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgaGVhZGVycy5lbnRyaWVzKCkpIHtcblx0XHRvdXRba2V5XSA9IHZhbHVlO1xuXHR9XG5cdHJldHVybiBvdXQ7XG59XG5cbmZ1bmN0aW9uIGdldFdlYlNvY2tldFJlYWR5U3RhdGUoc29ja2V0OiBXZWJTb2NrZXRMaWtlKTogbnVtYmVyIHwgdW5kZWZpbmVkIHtcblx0Y29uc3QgcmVhZHlTdGF0ZSA9IChzb2NrZXQgYXMgeyByZWFkeVN0YXRlPzogdW5rbm93biB9KS5yZWFkeVN0YXRlO1xuXHRyZXR1cm4gdHlwZW9mIHJlYWR5U3RhdGUgPT09IFwibnVtYmVyXCIgPyByZWFkeVN0YXRlIDogdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBpc1dlYlNvY2tldFJldXNhYmxlKHNvY2tldDogV2ViU29ja2V0TGlrZSk6IGJvb2xlYW4ge1xuXHRjb25zdCByZWFkeVN0YXRlID0gZ2V0V2ViU29ja2V0UmVhZHlTdGF0ZShzb2NrZXQpO1xuXHQvLyBJZiByZWFkeVN0YXRlIGlzIHVuYXZhaWxhYmxlLCBhc3N1bWUgdGhlIHJ1bnRpbWUga2VlcHMgaXQgb3Blbi9yZXVzYWJsZS5cblx0cmV0dXJuIHJlYWR5U3RhdGUgPT09IHVuZGVmaW5lZCB8fCByZWFkeVN0YXRlID09PSAxO1xufVxuXG5mdW5jdGlvbiBjbG9zZVdlYlNvY2tldFNpbGVudGx5KHNvY2tldDogV2ViU29ja2V0TGlrZSwgY29kZSA9IDEwMDAsIHJlYXNvbiA9IFwiZG9uZVwiKTogdm9pZCB7XG5cdHRyeSB7XG5cdFx0c29ja2V0LmNsb3NlKGNvZGUsIHJlYXNvbik7XG5cdH0gY2F0Y2gge31cbn1cblxuZnVuY3Rpb24gc2NoZWR1bGVTZXNzaW9uV2ViU29ja2V0RXhwaXJ5KHNlc3Npb25JZDogc3RyaW5nLCBlbnRyeTogQ2FjaGVkV2ViU29ja2V0Q29ubmVjdGlvbik6IHZvaWQge1xuXHRpZiAoZW50cnkuaWRsZVRpbWVyKSB7XG5cdFx0Y2xlYXJUaW1lb3V0KGVudHJ5LmlkbGVUaW1lcik7XG5cdH1cblx0ZW50cnkuaWRsZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0aWYgKGVudHJ5LmJ1c3kpIHJldHVybjtcblx0XHRjbG9zZVdlYlNvY2tldFNpbGVudGx5KGVudHJ5LnNvY2tldCwgMTAwMCwgXCJpZGxlX3RpbWVvdXRcIik7XG5cdFx0d2Vic29ja2V0U2Vzc2lvbkNhY2hlLmRlbGV0ZShzZXNzaW9uSWQpO1xuXHR9LCBTRVNTSU9OX1dFQlNPQ0tFVF9DQUNIRV9UVExfTVMpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjb25uZWN0V2ViU29ja2V0KHVybDogc3RyaW5nLCBoZWFkZXJzOiBIZWFkZXJzLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IFByb21pc2U8V2ViU29ja2V0TGlrZT4ge1xuXHRjb25zdCBXZWJTb2NrZXRDdG9yID0gZ2V0V2ViU29ja2V0Q29uc3RydWN0b3IoKTtcblx0aWYgKCFXZWJTb2NrZXRDdG9yKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKFwiV2ViU29ja2V0IHRyYW5zcG9ydCBpcyBub3QgYXZhaWxhYmxlIGluIHRoaXMgcnVudGltZVwiKTtcblx0fVxuXG5cdGNvbnN0IHdzSGVhZGVycyA9IGhlYWRlcnNUb1JlY29yZChoZWFkZXJzKTtcblx0d3NIZWFkZXJzW1wiT3BlbkFJLUJldGFcIl0gPSBPUEVOQUlfQkVUQV9SRVNQT05TRVNfV0VCU09DS0VUUztcblxuXHRyZXR1cm4gbmV3IFByb21pc2U8V2ViU29ja2V0TGlrZT4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdGxldCBzZXR0bGVkID0gZmFsc2U7XG5cdFx0bGV0IHNvY2tldDogV2ViU29ja2V0TGlrZTtcblxuXHRcdHRyeSB7XG5cdFx0XHRzb2NrZXQgPSBuZXcgV2ViU29ja2V0Q3Rvcih1cmwsIHsgaGVhZGVyczogd3NIZWFkZXJzIH0pO1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRyZWplY3QoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFN0cmluZyhlcnJvcikpKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBvbk9wZW46IFdlYlNvY2tldExpc3RlbmVyID0gKCkgPT4ge1xuXHRcdFx0aWYgKHNldHRsZWQpIHJldHVybjtcblx0XHRcdHNldHRsZWQgPSB0cnVlO1xuXHRcdFx0Y2xlYW51cCgpO1xuXHRcdFx0cmVzb2x2ZShzb2NrZXQpO1xuXHRcdH07XG5cdFx0Y29uc3Qgb25FcnJvcjogV2ViU29ja2V0TGlzdGVuZXIgPSAoZXZlbnQpID0+IHtcblx0XHRcdGlmIChzZXR0bGVkKSByZXR1cm47XG5cdFx0XHRzZXR0bGVkID0gdHJ1ZTtcblx0XHRcdGNsZWFudXAoKTtcblx0XHRcdHJlamVjdChleHRyYWN0V2ViU29ja2V0RXJyb3IoZXZlbnQpKTtcblx0XHR9O1xuXHRcdGNvbnN0IG9uQ2xvc2U6IFdlYlNvY2tldExpc3RlbmVyID0gKGV2ZW50KSA9PiB7XG5cdFx0XHRpZiAoc2V0dGxlZCkgcmV0dXJuO1xuXHRcdFx0c2V0dGxlZCA9IHRydWU7XG5cdFx0XHRjbGVhbnVwKCk7XG5cdFx0XHRyZWplY3QoZXh0cmFjdFdlYlNvY2tldENsb3NlRXJyb3IoZXZlbnQpKTtcblx0XHR9O1xuXHRcdGNvbnN0IG9uQWJvcnQgPSAoKSA9PiB7XG5cdFx0XHRpZiAoc2V0dGxlZCkgcmV0dXJuO1xuXHRcdFx0c2V0dGxlZCA9IHRydWU7XG5cdFx0XHRjbGVhbnVwKCk7XG5cdFx0XHRzb2NrZXQuY2xvc2UoMTAwMCwgXCJhYm9ydGVkXCIpO1xuXHRcdFx0cmVqZWN0KG5ldyBFcnJvcihcIlJlcXVlc3Qgd2FzIGFib3J0ZWRcIikpO1xuXHRcdH07XG5cblx0XHRjb25zdCBjbGVhbnVwID0gKCkgPT4ge1xuXHRcdFx0c29ja2V0LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJvcGVuXCIsIG9uT3Blbik7XG5cdFx0XHRzb2NrZXQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImVycm9yXCIsIG9uRXJyb3IpO1xuXHRcdFx0c29ja2V0LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJjbG9zZVwiLCBvbkNsb3NlKTtcblx0XHRcdHNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXHRcdH07XG5cblx0XHRzb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcihcIm9wZW5cIiwgb25PcGVuKTtcblx0XHRzb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcihcImVycm9yXCIsIG9uRXJyb3IpO1xuXHRcdHNvY2tldC5hZGRFdmVudExpc3RlbmVyKFwiY2xvc2VcIiwgb25DbG9zZSk7XG5cdFx0c2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCk7XG5cdH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBhY3F1aXJlV2ViU29ja2V0KFxuXHR1cmw6IHN0cmluZyxcblx0aGVhZGVyczogSGVhZGVycyxcblx0c2Vzc2lvbklkOiBzdHJpbmcgfCB1bmRlZmluZWQsXG5cdHNpZ25hbD86IEFib3J0U2lnbmFsLFxuKTogUHJvbWlzZTx7IHNvY2tldDogV2ViU29ja2V0TGlrZTsgcmVsZWFzZTogKG9wdGlvbnM/OiB7IGtlZXA/OiBib29sZWFuIH0pID0+IHZvaWQgfT4ge1xuXHRpZiAoIXNlc3Npb25JZCkge1xuXHRcdGNvbnN0IHNvY2tldCA9IGF3YWl0IGNvbm5lY3RXZWJTb2NrZXQodXJsLCBoZWFkZXJzLCBzaWduYWwpO1xuXHRcdHJldHVybiB7XG5cdFx0XHRzb2NrZXQsXG5cdFx0XHRyZWxlYXNlOiAoeyBrZWVwIH0gPSB7fSkgPT4ge1xuXHRcdFx0XHRpZiAoa2VlcCA9PT0gZmFsc2UpIHtcblx0XHRcdFx0XHRjbG9zZVdlYlNvY2tldFNpbGVudGx5KHNvY2tldCk7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNsb3NlV2ViU29ja2V0U2lsZW50bHkoc29ja2V0KTtcblx0XHRcdH0sXG5cdFx0fTtcblx0fVxuXG5cdGNvbnN0IGNhY2hlZCA9IHdlYnNvY2tldFNlc3Npb25DYWNoZS5nZXQoc2Vzc2lvbklkKTtcblx0aWYgKGNhY2hlZCkge1xuXHRcdGlmIChjYWNoZWQuaWRsZVRpbWVyKSB7XG5cdFx0XHRjbGVhclRpbWVvdXQoY2FjaGVkLmlkbGVUaW1lcik7XG5cdFx0XHRjYWNoZWQuaWRsZVRpbWVyID0gdW5kZWZpbmVkO1xuXHRcdH1cblx0XHRpZiAoIWNhY2hlZC5idXN5ICYmIGlzV2ViU29ja2V0UmV1c2FibGUoY2FjaGVkLnNvY2tldCkpIHtcblx0XHRcdGNhY2hlZC5idXN5ID0gdHJ1ZTtcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdHNvY2tldDogY2FjaGVkLnNvY2tldCxcblx0XHRcdFx0cmVsZWFzZTogKHsga2VlcCB9ID0ge30pID0+IHtcblx0XHRcdFx0XHRpZiAoIWtlZXAgfHwgIWlzV2ViU29ja2V0UmV1c2FibGUoY2FjaGVkLnNvY2tldCkpIHtcblx0XHRcdFx0XHRcdGNsb3NlV2ViU29ja2V0U2lsZW50bHkoY2FjaGVkLnNvY2tldCk7XG5cdFx0XHRcdFx0XHR3ZWJzb2NrZXRTZXNzaW9uQ2FjaGUuZGVsZXRlKHNlc3Npb25JZCk7XG5cdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGNhY2hlZC5idXN5ID0gZmFsc2U7XG5cdFx0XHRcdFx0c2NoZWR1bGVTZXNzaW9uV2ViU29ja2V0RXhwaXJ5KHNlc3Npb25JZCwgY2FjaGVkKTtcblx0XHRcdFx0fSxcblx0XHRcdH07XG5cdFx0fVxuXHRcdGlmIChjYWNoZWQuYnVzeSkge1xuXHRcdFx0Y29uc3Qgc29ja2V0ID0gYXdhaXQgY29ubmVjdFdlYlNvY2tldCh1cmwsIGhlYWRlcnMsIHNpZ25hbCk7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRzb2NrZXQsXG5cdFx0XHRcdHJlbGVhc2U6ICgpID0+IHtcblx0XHRcdFx0XHRjbG9zZVdlYlNvY2tldFNpbGVudGx5KHNvY2tldCk7XG5cdFx0XHRcdH0sXG5cdFx0XHR9O1xuXHRcdH1cblx0XHRpZiAoIWlzV2ViU29ja2V0UmV1c2FibGUoY2FjaGVkLnNvY2tldCkpIHtcblx0XHRcdGNsb3NlV2ViU29ja2V0U2lsZW50bHkoY2FjaGVkLnNvY2tldCk7XG5cdFx0XHR3ZWJzb2NrZXRTZXNzaW9uQ2FjaGUuZGVsZXRlKHNlc3Npb25JZCk7XG5cdFx0fVxuXHR9XG5cblx0Y29uc3Qgc29ja2V0ID0gYXdhaXQgY29ubmVjdFdlYlNvY2tldCh1cmwsIGhlYWRlcnMsIHNpZ25hbCk7XG5cdGNvbnN0IGVudHJ5OiBDYWNoZWRXZWJTb2NrZXRDb25uZWN0aW9uID0geyBzb2NrZXQsIGJ1c3k6IHRydWUgfTtcblxuXHQvLyBFdmljdCB0aGUgb2xkZXN0IGVudHJ5IGlmIHRoZSBjYWNoZSBpcyBhdCBjYXBhY2l0eSAoTFJVIGV2aWN0aW9uKS5cblx0aWYgKHdlYnNvY2tldFNlc3Npb25DYWNoZS5zaXplID49IE1BWF9XRUJTT0NLRVRfQ0FDSEVfU0laRSkge1xuXHRcdGNvbnN0IG9sZGVzdEtleSA9IHdlYnNvY2tldFNlc3Npb25DYWNoZS5rZXlzKCkubmV4dCgpLnZhbHVlO1xuXHRcdGlmIChvbGRlc3RLZXkpIHtcblx0XHRcdGNvbnN0IG9sZEVudHJ5ID0gd2Vic29ja2V0U2Vzc2lvbkNhY2hlLmdldChvbGRlc3RLZXkpO1xuXHRcdFx0d2Vic29ja2V0U2Vzc2lvbkNhY2hlLmRlbGV0ZShvbGRlc3RLZXkpO1xuXHRcdFx0aWYgKG9sZEVudHJ5KSB7XG5cdFx0XHRcdGlmIChvbGRFbnRyeS5pZGxlVGltZXIpIGNsZWFyVGltZW91dChvbGRFbnRyeS5pZGxlVGltZXIpO1xuXHRcdFx0XHRjbG9zZVdlYlNvY2tldFNpbGVudGx5KG9sZEVudHJ5LnNvY2tldCk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0d2Vic29ja2V0U2Vzc2lvbkNhY2hlLnNldChzZXNzaW9uSWQsIGVudHJ5KTtcblx0cmV0dXJuIHtcblx0XHRzb2NrZXQsXG5cdFx0cmVsZWFzZTogKHsga2VlcCB9ID0ge30pID0+IHtcblx0XHRcdGlmICgha2VlcCB8fCAhaXNXZWJTb2NrZXRSZXVzYWJsZShlbnRyeS5zb2NrZXQpKSB7XG5cdFx0XHRcdGNsb3NlV2ViU29ja2V0U2lsZW50bHkoZW50cnkuc29ja2V0KTtcblx0XHRcdFx0aWYgKGVudHJ5LmlkbGVUaW1lcikgY2xlYXJUaW1lb3V0KGVudHJ5LmlkbGVUaW1lcik7XG5cdFx0XHRcdGlmICh3ZWJzb2NrZXRTZXNzaW9uQ2FjaGUuZ2V0KHNlc3Npb25JZCkgPT09IGVudHJ5KSB7XG5cdFx0XHRcdFx0d2Vic29ja2V0U2Vzc2lvbkNhY2hlLmRlbGV0ZShzZXNzaW9uSWQpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGVudHJ5LmJ1c3kgPSBmYWxzZTtcblx0XHRcdHNjaGVkdWxlU2Vzc2lvbldlYlNvY2tldEV4cGlyeShzZXNzaW9uSWQsIGVudHJ5KTtcblx0XHR9LFxuXHR9O1xufVxuXG5mdW5jdGlvbiBleHRyYWN0V2ViU29ja2V0RXJyb3IoZXZlbnQ6IHVua25vd24pOiBFcnJvciB7XG5cdGlmIChldmVudCAmJiB0eXBlb2YgZXZlbnQgPT09IFwib2JqZWN0XCIgJiYgXCJtZXNzYWdlXCIgaW4gZXZlbnQpIHtcblx0XHRjb25zdCBtZXNzYWdlID0gKGV2ZW50IGFzIHsgbWVzc2FnZT86IHVua25vd24gfSkubWVzc2FnZTtcblx0XHRpZiAodHlwZW9mIG1lc3NhZ2UgPT09IFwic3RyaW5nXCIgJiYgbWVzc2FnZS5sZW5ndGggPiAwKSB7XG5cdFx0XHRyZXR1cm4gbmV3IEVycm9yKG1lc3NhZ2UpO1xuXHRcdH1cblx0fVxuXHRyZXR1cm4gbmV3IEVycm9yKFwiV2ViU29ja2V0IGVycm9yXCIpO1xufVxuXG5mdW5jdGlvbiBleHRyYWN0V2ViU29ja2V0Q2xvc2VFcnJvcihldmVudDogdW5rbm93bik6IEVycm9yIHtcblx0aWYgKGV2ZW50ICYmIHR5cGVvZiBldmVudCA9PT0gXCJvYmplY3RcIikge1xuXHRcdGNvbnN0IGNvZGUgPSBcImNvZGVcIiBpbiBldmVudCA/IChldmVudCBhcyB7IGNvZGU/OiB1bmtub3duIH0pLmNvZGUgOiB1bmRlZmluZWQ7XG5cdFx0Y29uc3QgcmVhc29uID0gXCJyZWFzb25cIiBpbiBldmVudCA/IChldmVudCBhcyB7IHJlYXNvbj86IHVua25vd24gfSkucmVhc29uIDogdW5kZWZpbmVkO1xuXHRcdGNvbnN0IGNvZGVUZXh0ID0gdHlwZW9mIGNvZGUgPT09IFwibnVtYmVyXCIgPyBgICR7Y29kZX1gIDogXCJcIjtcblx0XHRjb25zdCByZWFzb25UZXh0ID0gdHlwZW9mIHJlYXNvbiA9PT0gXCJzdHJpbmdcIiAmJiByZWFzb24ubGVuZ3RoID4gMCA/IGAgJHtyZWFzb259YCA6IFwiXCI7XG5cdFx0cmV0dXJuIG5ldyBFcnJvcihgV2ViU29ja2V0IGNsb3NlZCR7Y29kZVRleHR9JHtyZWFzb25UZXh0fWAudHJpbSgpKTtcblx0fVxuXHRyZXR1cm4gbmV3IEVycm9yKFwiV2ViU29ja2V0IGNsb3NlZFwiKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZGVjb2RlV2ViU29ja2V0RGF0YShkYXRhOiB1bmtub3duKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG5cdGlmICh0eXBlb2YgZGF0YSA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIGRhdGE7XG5cdGlmIChkYXRhIGluc3RhbmNlb2YgQXJyYXlCdWZmZXIpIHtcblx0XHRyZXR1cm4gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKG5ldyBVaW50OEFycmF5KGRhdGEpKTtcblx0fVxuXHRpZiAoQXJyYXlCdWZmZXIuaXNWaWV3KGRhdGEpKSB7XG5cdFx0Y29uc3QgdmlldyA9IGRhdGEgYXMgQXJyYXlCdWZmZXJWaWV3O1xuXHRcdHJldHVybiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUobmV3IFVpbnQ4QXJyYXkodmlldy5idWZmZXIsIHZpZXcuYnl0ZU9mZnNldCwgdmlldy5ieXRlTGVuZ3RoKSk7XG5cdH1cblx0aWYgKGRhdGEgJiYgdHlwZW9mIGRhdGEgPT09IFwib2JqZWN0XCIgJiYgXCJhcnJheUJ1ZmZlclwiIGluIGRhdGEpIHtcblx0XHRjb25zdCBibG9iTGlrZSA9IGRhdGEgYXMgeyBhcnJheUJ1ZmZlcjogKCkgPT4gUHJvbWlzZTxBcnJheUJ1ZmZlcj4gfTtcblx0XHRjb25zdCBhcnJheUJ1ZmZlciA9IGF3YWl0IGJsb2JMaWtlLmFycmF5QnVmZmVyKCk7XG5cdFx0cmV0dXJuIG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShuZXcgVWludDhBcnJheShhcnJheUJ1ZmZlcikpO1xuXHR9XG5cdHJldHVybiBudWxsO1xufVxuXG5hc3luYyBmdW5jdGlvbiogcGFyc2VXZWJTb2NrZXQoc29ja2V0OiBXZWJTb2NrZXRMaWtlLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG5cdGNvbnN0IHF1ZXVlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdID0gW107XG5cdGxldCBwZW5kaW5nOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblx0bGV0IGRvbmUgPSBmYWxzZTtcblx0bGV0IGZhaWxlZDogRXJyb3IgfCBudWxsID0gbnVsbDtcblx0bGV0IHNhd0NvbXBsZXRpb24gPSBmYWxzZTtcblxuXHRjb25zdCB3YWtlID0gKCkgPT4ge1xuXHRcdGlmICghcGVuZGluZykgcmV0dXJuO1xuXHRcdGNvbnN0IHJlc29sdmUgPSBwZW5kaW5nO1xuXHRcdHBlbmRpbmcgPSBudWxsO1xuXHRcdHJlc29sdmUoKTtcblx0fTtcblxuXHRjb25zdCBjbGVhbnVwID0gKCkgPT4ge1xuXHRcdHNvY2tldC5yZW1vdmVFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBvbk1lc3NhZ2UpO1xuXHRcdHNvY2tldC5yZW1vdmVFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgb25FcnJvcik7XG5cdFx0c29ja2V0LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJjbG9zZVwiLCBvbkNsb3NlKTtcblx0XHRzaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0KTtcblx0fTtcblxuXHRjb25zdCBvbk1lc3NhZ2U6IFdlYlNvY2tldExpc3RlbmVyID0gKGV2ZW50KSA9PiB7XG5cdFx0dm9pZCAoYXN5bmMgKCkgPT4ge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0aWYgKCFldmVudCB8fCB0eXBlb2YgZXZlbnQgIT09IFwib2JqZWN0XCIgfHwgIShcImRhdGFcIiBpbiBldmVudCkpIHJldHVybjtcblx0XHRcdFx0Y29uc3QgdGV4dCA9IGF3YWl0IGRlY29kZVdlYlNvY2tldERhdGEoKGV2ZW50IGFzIHsgZGF0YT86IHVua25vd24gfSkuZGF0YSk7XG5cdFx0XHRcdGlmICghdGV4dCkgcmV0dXJuO1xuXHRcdFx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHRleHQpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXHRcdFx0XHRjb25zdCB0eXBlID0gdHlwZW9mIHBhcnNlZC50eXBlID09PSBcInN0cmluZ1wiID8gcGFyc2VkLnR5cGUgOiBcIlwiO1xuXHRcdFx0XHRpZiAodHlwZSA9PT0gXCJyZXNwb25zZS5jb21wbGV0ZWRcIiB8fCB0eXBlID09PSBcInJlc3BvbnNlLmRvbmVcIikge1xuXHRcdFx0XHRcdHNhd0NvbXBsZXRpb24gPSB0cnVlO1xuXHRcdFx0XHRcdGRvbmUgPSB0cnVlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHF1ZXVlLnB1c2gocGFyc2VkKTtcblx0XHRcdFx0d2FrZSgpO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdC8vIEVuc3VyZSBsaXN0ZW5lcnMgYXJlIGNsZWFuZWQgdXAgaWYgdGhlIGFzeW5jIGhhbmRsZXIgZXJyb3JzLlxuXHRcdFx0XHQvLyBXaXRob3V0IHRoaXMsIHRoZSBmaXJlLWFuZC1mb3JnZXQgcHJvbWlzZSB3b3VsZCBzd2FsbG93IHRoZVxuXHRcdFx0XHQvLyBlcnJvciB3aGlsZSBsZWF2aW5nIGxpc3RlbmVycyBhdHRhY2hlZCB0byB0aGUgc29ja2V0LlxuXHRcdFx0XHRpZiAoZXJyIGluc3RhbmNlb2YgU3ludGF4RXJyb3IpIHtcblx0XHRcdFx0XHQvLyBKU09OIHBhcnNlIGZhaWx1cmUgXHUyMDE0IHNraXAgdGhlIG1hbGZvcm1lZCBtZXNzYWdlLlxuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXHRcdFx0XHRmYWlsZWQgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyKSk7XG5cdFx0XHRcdGRvbmUgPSB0cnVlO1xuXHRcdFx0XHRjbGVhbnVwKCk7XG5cdFx0XHRcdHdha2UoKTtcblx0XHRcdH1cblx0XHR9KSgpO1xuXHR9O1xuXG5cdGNvbnN0IG9uRXJyb3I6IFdlYlNvY2tldExpc3RlbmVyID0gKGV2ZW50KSA9PiB7XG5cdFx0ZmFpbGVkID0gZXh0cmFjdFdlYlNvY2tldEVycm9yKGV2ZW50KTtcblx0XHRkb25lID0gdHJ1ZTtcblx0XHR3YWtlKCk7XG5cdH07XG5cblx0Y29uc3Qgb25DbG9zZTogV2ViU29ja2V0TGlzdGVuZXIgPSAoZXZlbnQpID0+IHtcblx0XHRpZiAoc2F3Q29tcGxldGlvbikge1xuXHRcdFx0ZG9uZSA9IHRydWU7XG5cdFx0XHR3YWtlKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGlmICghZmFpbGVkKSB7XG5cdFx0XHRmYWlsZWQgPSBleHRyYWN0V2ViU29ja2V0Q2xvc2VFcnJvcihldmVudCk7XG5cdFx0fVxuXHRcdGRvbmUgPSB0cnVlO1xuXHRcdHdha2UoKTtcblx0fTtcblxuXHRjb25zdCBvbkFib3J0ID0gKCkgPT4ge1xuXHRcdGZhaWxlZCA9IG5ldyBFcnJvcihcIlJlcXVlc3Qgd2FzIGFib3J0ZWRcIik7XG5cdFx0ZG9uZSA9IHRydWU7XG5cdFx0d2FrZSgpO1xuXHR9O1xuXG5cdHNvY2tldC5hZGRFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCBvbk1lc3NhZ2UpO1xuXHRzb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcihcImVycm9yXCIsIG9uRXJyb3IpO1xuXHRzb2NrZXQuYWRkRXZlbnRMaXN0ZW5lcihcImNsb3NlXCIsIG9uQ2xvc2UpO1xuXHRzaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0KTtcblxuXHR0cnkge1xuXHRcdHdoaWxlICh0cnVlKSB7XG5cdFx0XHRpZiAoc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIlJlcXVlc3Qgd2FzIGFib3J0ZWRcIik7XG5cdFx0XHR9XG5cdFx0XHRpZiAocXVldWUubGVuZ3RoID4gMCkge1xuXHRcdFx0XHR5aWVsZCBxdWV1ZS5zaGlmdCgpITtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cdFx0XHRpZiAoZG9uZSkgYnJlYWs7XG5cdFx0XHRhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuXHRcdFx0XHRwZW5kaW5nID0gcmVzb2x2ZTtcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdGlmIChmYWlsZWQpIHtcblx0XHRcdHRocm93IGZhaWxlZDtcblx0XHR9XG5cdFx0aWYgKCFzYXdDb21wbGV0aW9uKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJXZWJTb2NrZXQgc3RyZWFtIGNsb3NlZCBiZWZvcmUgcmVzcG9uc2UuY29tcGxldGVkXCIpO1xuXHRcdH1cblx0fSBmaW5hbGx5IHtcblx0XHRjbGVhbnVwKCk7XG5cdH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gcHJvY2Vzc1dlYlNvY2tldFN0cmVhbShcblx0dXJsOiBzdHJpbmcsXG5cdGJvZHk6IFJlcXVlc3RCb2R5LFxuXHRoZWFkZXJzOiBIZWFkZXJzLFxuXHRvdXRwdXQ6IEFzc2lzdGFudE1lc3NhZ2UsXG5cdHN0cmVhbTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtLFxuXHRtb2RlbDogTW9kZWw8XCJvcGVuYWktY29kZXgtcmVzcG9uc2VzXCI+LFxuXHRvblN0YXJ0OiAoKSA9PiB2b2lkLFxuXHRvcHRpb25zPzogT3BlbkFJQ29kZXhSZXNwb25zZXNPcHRpb25zLFxuKTogUHJvbWlzZTx2b2lkPiB7XG5cdGNvbnN0IHsgc29ja2V0LCByZWxlYXNlIH0gPSBhd2FpdCBhY3F1aXJlV2ViU29ja2V0KHVybCwgaGVhZGVycywgb3B0aW9ucz8uc2Vzc2lvbklkLCBvcHRpb25zPy5zaWduYWwpO1xuXHRsZXQga2VlcENvbm5lY3Rpb24gPSB0cnVlO1xuXHR0cnkge1xuXHRcdHNvY2tldC5zZW5kKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJyZXNwb25zZS5jcmVhdGVcIiwgLi4uYm9keSB9KSk7XG5cdFx0b25TdGFydCgpO1xuXHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJzdGFydFwiLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0YXdhaXQgcHJvY2Vzc1Jlc3BvbnNlc1N0cmVhbShtYXBDb2RleEV2ZW50cyhwYXJzZVdlYlNvY2tldChzb2NrZXQsIG9wdGlvbnM/LnNpZ25hbCkpLCBvdXRwdXQsIHN0cmVhbSwgbW9kZWwpO1xuXHRcdGlmIChvcHRpb25zPy5zaWduYWw/LmFib3J0ZWQpIHtcblx0XHRcdGtlZXBDb25uZWN0aW9uID0gZmFsc2U7XG5cdFx0fVxuXHR9IGNhdGNoIChlcnJvcikge1xuXHRcdGtlZXBDb25uZWN0aW9uID0gZmFsc2U7XG5cdFx0dGhyb3cgZXJyb3I7XG5cdH0gZmluYWxseSB7XG5cdFx0cmVsZWFzZSh7IGtlZXA6IGtlZXBDb25uZWN0aW9uIH0pO1xuXHR9XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEVycm9yIEhhbmRsaW5nXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmFzeW5jIGZ1bmN0aW9uIHBhcnNlRXJyb3JSZXNwb25zZShyZXNwb25zZTogUmVzcG9uc2UpOiBQcm9taXNlPHsgbWVzc2FnZTogc3RyaW5nOyBmcmllbmRseU1lc3NhZ2U/OiBzdHJpbmcgfT4ge1xuXHRjb25zdCByYXcgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG5cdGxldCBtZXNzYWdlID0gcmF3IHx8IHJlc3BvbnNlLnN0YXR1c1RleHQgfHwgXCJSZXF1ZXN0IGZhaWxlZFwiO1xuXHRsZXQgZnJpZW5kbHlNZXNzYWdlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cblx0dHJ5IHtcblx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMge1xuXHRcdFx0ZXJyb3I/OiB7IGNvZGU/OiBzdHJpbmc7IHR5cGU/OiBzdHJpbmc7IG1lc3NhZ2U/OiBzdHJpbmc7IHBsYW5fdHlwZT86IHN0cmluZzsgcmVzZXRzX2F0PzogbnVtYmVyIH07XG5cdFx0fTtcblx0XHRjb25zdCBlcnIgPSBwYXJzZWQ/LmVycm9yO1xuXHRcdGlmIChlcnIpIHtcblx0XHRcdGNvbnN0IGNvZGUgPSBlcnIuY29kZSB8fCBlcnIudHlwZSB8fCBcIlwiO1xuXHRcdFx0aWYgKC91c2FnZV9saW1pdF9yZWFjaGVkfHVzYWdlX25vdF9pbmNsdWRlZHxyYXRlX2xpbWl0X2V4Y2VlZGVkL2kudGVzdChjb2RlKSB8fCByZXNwb25zZS5zdGF0dXMgPT09IDQyOSkge1xuXHRcdFx0XHRjb25zdCBwbGFuID0gZXJyLnBsYW5fdHlwZSA/IGAgKCR7ZXJyLnBsYW5fdHlwZS50b0xvd2VyQ2FzZSgpfSBwbGFuKWAgOiBcIlwiO1xuXHRcdFx0XHRjb25zdCBtaW5zID0gZXJyLnJlc2V0c19hdFxuXHRcdFx0XHRcdD8gTWF0aC5tYXgoMCwgTWF0aC5yb3VuZCgoZXJyLnJlc2V0c19hdCAqIDEwMDAgLSBEYXRlLm5vdygpKSAvIDYwMDAwKSlcblx0XHRcdFx0XHQ6IHVuZGVmaW5lZDtcblx0XHRcdFx0Y29uc3Qgd2hlbiA9IG1pbnMgIT09IHVuZGVmaW5lZCA/IGAgVHJ5IGFnYWluIGluIH4ke21pbnN9IG1pbi5gIDogXCJcIjtcblx0XHRcdFx0ZnJpZW5kbHlNZXNzYWdlID0gYFlvdSBoYXZlIGhpdCB5b3VyIENoYXRHUFQgdXNhZ2UgbGltaXQke3BsYW59LiR7d2hlbn1gLnRyaW0oKTtcblx0XHRcdH1cblx0XHRcdG1lc3NhZ2UgPSBlcnIubWVzc2FnZSB8fCBmcmllbmRseU1lc3NhZ2UgfHwgbWVzc2FnZTtcblx0XHR9XG5cdH0gY2F0Y2gge31cblxuXHRyZXR1cm4geyBtZXNzYWdlLCBmcmllbmRseU1lc3NhZ2UgfTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gQXV0aCAmIEhlYWRlcnNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZnVuY3Rpb24gZXh0cmFjdEFjY291bnRJZCh0b2tlbjogc3RyaW5nKTogc3RyaW5nIHtcblx0dHJ5IHtcblx0XHRjb25zdCBwYXJ0cyA9IHRva2VuLnNwbGl0KFwiLlwiKTtcblx0XHRpZiAocGFydHMubGVuZ3RoICE9PSAzKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIHRva2VuXCIpO1xuXHRcdGNvbnN0IHBheWxvYWQgPSBKU09OLnBhcnNlKGF0b2IocGFydHNbMV0pKTtcblx0XHRjb25zdCBhY2NvdW50SWQgPSBwYXlsb2FkPy5bSldUX0NMQUlNX1BBVEhdPy5jaGF0Z3B0X2FjY291bnRfaWQ7XG5cdFx0aWYgKCFhY2NvdW50SWQpIHRocm93IG5ldyBFcnJvcihcIk5vIGFjY291bnQgSUQgaW4gdG9rZW5cIik7XG5cdFx0cmV0dXJuIGFjY291bnRJZDtcblx0fSBjYXRjaCB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKFwiRmFpbGVkIHRvIGV4dHJhY3QgYWNjb3VudElkIGZyb20gdG9rZW5cIik7XG5cdH1cbn1cblxuZnVuY3Rpb24gYnVpbGRIZWFkZXJzKFxuXHRpbml0SGVhZGVyczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZCxcblx0YWRkaXRpb25hbEhlYWRlcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWQsXG5cdGFjY291bnRJZDogc3RyaW5nLFxuXHR0b2tlbjogc3RyaW5nLFxuXHRzZXNzaW9uSWQ/OiBzdHJpbmcsXG4pOiBIZWFkZXJzIHtcblx0Y29uc3QgaGVhZGVycyA9IG5ldyBIZWFkZXJzKGluaXRIZWFkZXJzKTtcblx0aGVhZGVycy5zZXQoXCJBdXRob3JpemF0aW9uXCIsIGBCZWFyZXIgJHt0b2tlbn1gKTtcblx0aGVhZGVycy5zZXQoXCJjaGF0Z3B0LWFjY291bnQtaWRcIiwgYWNjb3VudElkKTtcblx0aGVhZGVycy5zZXQoXCJPcGVuQUktQmV0YVwiLCBcInJlc3BvbnNlcz1leHBlcmltZW50YWxcIik7XG5cdGhlYWRlcnMuc2V0KFwib3JpZ2luYXRvclwiLCBcInBpXCIpO1xuXHRjb25zdCB1c2VyQWdlbnQgPSBfb3MgPyBgcGkgKCR7X29zLnBsYXRmb3JtKCl9ICR7X29zLnJlbGVhc2UoKX07ICR7X29zLmFyY2goKX0pYCA6IFwicGkgKGJyb3dzZXIpXCI7XG5cdGhlYWRlcnMuc2V0KFwiVXNlci1BZ2VudFwiLCB1c2VyQWdlbnQpO1xuXHRoZWFkZXJzLnNldChcImFjY2VwdFwiLCBcInRleHQvZXZlbnQtc3RyZWFtXCIpO1xuXHRoZWFkZXJzLnNldChcImNvbnRlbnQtdHlwZVwiLCBcImFwcGxpY2F0aW9uL2pzb25cIik7XG5cdGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGFkZGl0aW9uYWxIZWFkZXJzIHx8IHt9KSkge1xuXHRcdGhlYWRlcnMuc2V0KGtleSwgdmFsdWUpO1xuXHR9XG5cblx0aWYgKHNlc3Npb25JZCkge1xuXHRcdGhlYWRlcnMuc2V0KFwic2Vzc2lvbl9pZFwiLCBzZXNzaW9uSWQpO1xuXHR9XG5cblx0cmV0dXJuIGhlYWRlcnM7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFJQSxJQUFJLE1BQTRCO0FBSWhDLE1BQU0sZ0JBQStCLENBQUMsY0FBYyxPQUFPO0FBQzNELE1BQU0sb0JBQW9CO0FBRTFCLElBQUksT0FBTyxZQUFZLGdCQUFnQixRQUFRLFVBQVUsUUFBUSxRQUFRLFVBQVUsTUFBTTtBQUN4RixnQkFBYyxpQkFBaUIsRUFBRSxLQUFLLENBQUMsTUFBTTtBQUM1QyxVQUFNO0FBQUEsRUFDUCxDQUFDO0FBQ0Y7QUFFQSxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLHFCQUFxQjtBQVU5QixTQUFTLG1DQUFtQztBQUM1QyxTQUFTLDBCQUEwQix1QkFBdUIsOEJBQThCO0FBQ3hGLFNBQVMsa0JBQWtCLHNCQUFzQjtBQU1qRCxNQUFNLHlCQUF5QjtBQUMvQixNQUFNLGlCQUFpQjtBQUN2QixNQUFNLGNBQWM7QUFDcEIsTUFBTSxnQkFBZ0I7QUFDdEIsTUFBTSw0QkFBNEIsb0JBQUksSUFBSSxDQUFDLFVBQVUsZ0JBQWdCLFVBQVUsQ0FBQztBQUVoRixNQUFNLDBCQUEwQixvQkFBSSxJQUF5QjtBQUFBLEVBQzVEO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRCxDQUFDO0FBbUNELFNBQVMsaUJBQWlCLFFBQWdCLFdBQTRCO0FBQ3JFLE1BQUksV0FBVyxPQUFPLFdBQVcsT0FBTyxXQUFXLE9BQU8sV0FBVyxPQUFPLFdBQVcsS0FBSztBQUMzRixXQUFPO0FBQUEsRUFDUjtBQUNBLFNBQU8scUZBQXFGLEtBQUssU0FBUztBQUMzRztBQUVBLFNB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QUFJLFVBQVUsWUFBWSxDQUFDLFdBQVc7QUFDeEUsY0FBTSxPQUFPLElBQUksWUFDZCxLQUFLLElBQUksR0FBRyxLQUFLLE9BQU8sSUFBSSxZQUFZLE1BQU8sS0FBSyxJQUFJLEtBQUssR0FBSyxDQUFDLElBQ25FO0FBQ0gsY0FBTSxPQUFPLFNBQVMsU0FBWSxrQkFBa0IsSUFBSSxVQUFVO0FBQ2xFLDBCQUFrQix3Q0FBd0MsSUFBSSxJQUFJLElBQUksR0FBRyxLQUFLO0FBQUEsTUFDL0U7QUFDQSxnQkFBVSxJQUFJLFdBQVcsbUJBQW1CO0FBQUEsSUFDN0M7QUFBQSxFQUNELFFBQVE7QUFBQSxFQUFDO0FBRVQsU0FBTyxFQUFFLFNBQVMsZ0JBQWdCO0FBQ25DO0FBTUEsU0FBUyxpQkFBaUIsT0FBdUI7QUFDaEQsTUFBSTtBQUNILFVBQU0sUUFBUSxNQUFNLE1BQU0sR0FBRztBQUM3QixRQUFJLE1BQU0sV0FBVyxFQUFHLE9BQU0sSUFBSSxNQUFNLGVBQWU7QUFDdkQsVUFBTSxVQUFVLEtBQUssTUFBTSxLQUFLLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFDekMsVUFBTSxZQUFZLFVBQVUsY0FBYyxHQUFHO0FBQzdDLFFBQUksQ0FBQyxVQUFXLE9BQU0sSUFBSSxNQUFNLHdCQUF3QjtBQUN4RCxXQUFPO0FBQUEsRUFDUixRQUFRO0FBQ1AsVUFBTSxJQUFJLE1BQU0sd0NBQXdDO0FBQUEsRUFDekQ7QUFDRDtBQUVBLFNBQVMsYUFDUixhQUNBLG1CQUNBLFdBQ0EsT0FDQSxXQUNVO0FBQ1YsUUFBTSxVQUFVLElBQUksUUFBUSxXQUFXO0FBQ3ZDLFVBQVEsSUFBSSxpQkFBaUIsVUFBVSxLQUFLLEVBQUU7QUFDOUMsVUFBUSxJQUFJLHNCQUFzQixTQUFTO0FBQzNDLFVBQVEsSUFBSSxlQUFlLHdCQUF3QjtBQUNuRCxVQUFRLElBQUksY0FBYyxJQUFJO0FBQzlCLFFBQU0sWUFBWSxNQUFNLE9BQU8sSUFBSSxTQUFTLENBQUMsSUFBSSxJQUFJLFFBQVEsQ0FBQyxLQUFLLElBQUksS0FBSyxDQUFDLE1BQU07QUFDbkYsVUFBUSxJQUFJLGNBQWMsU0FBUztBQUNuQyxVQUFRLElBQUksVUFBVSxtQkFBbUI7QUFDekMsVUFBUSxJQUFJLGdCQUFnQixrQkFBa0I7QUFDOUMsYUFBVyxDQUFDLEtBQUssS0FBSyxLQUFLLE9BQU8sUUFBUSxxQkFBcUIsQ0FBQyxDQUFDLEdBQUc7QUFDbkUsWUFBUSxJQUFJLEtBQUssS0FBSztBQUFBLEVBQ3ZCO0FBRUEsTUFBSSxXQUFXO0FBQ2QsWUFBUSxJQUFJLGNBQWMsU0FBUztBQUFBLEVBQ3BDO0FBRUEsU0FBTztBQUNSOyIsCiAgIm5hbWVzIjogWyJzb2NrZXQiXQp9Cg==
