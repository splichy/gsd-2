import {
  EventStream,
  parseStreamingJson
} from "@gsd/pi-ai";
import { ZERO_USAGE } from "./agent-loop.js";
class ProxyMessageEventStream extends EventStream {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event type");
      }
    );
  }
}
function streamProxy(model, context, options) {
  const stream = new ProxyMessageEventStream();
  (async () => {
    const partial = {
      role: "assistant",
      stopReason: "stop",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
      timestamp: Date.now()
    };
    let reader;
    const abortHandler = () => {
      if (reader) {
        reader.cancel("Request aborted by user").catch(() => {
        });
      }
    };
    if (options.signal) {
      options.signal.addEventListener("abort", abortHandler);
    }
    try {
      const response = await fetch(`${options.proxyUrl}/api/stream`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.authToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          context,
          options: {
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            reasoning: options.reasoning
          }
        }),
        signal: options.signal
      });
      if (!response.ok) {
        let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          if (errorData.error) {
            errorMessage = `Proxy error: ${errorData.error}`;
          }
        } catch {
        }
        throw new Error(errorMessage);
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (options.signal?.aborted) {
          throw new Error("Request aborted by user");
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data) {
              const proxyEvent = JSON.parse(data);
              const event = processProxyEvent(proxyEvent, partial);
              if (event) {
                stream.push(event);
              }
            }
          }
        }
      }
      if (options.signal?.aborted) {
        throw new Error("Request aborted by user");
      }
      stream.end();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const reason = options.signal?.aborted ? "aborted" : "error";
      partial.stopReason = reason;
      partial.errorMessage = errorMessage;
      stream.push({
        type: "error",
        reason,
        error: partial
      });
      stream.end();
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }
  })();
  return stream;
}
function processProxyEvent(proxyEvent, partial) {
  switch (proxyEvent.type) {
    case "start":
      return { type: "start", partial };
    case "text_start":
      partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
      return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };
    case "text_delta": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type === "text") {
        content.text += proxyEvent.delta;
        return {
          type: "text_delta",
          contentIndex: proxyEvent.contentIndex,
          delta: proxyEvent.delta,
          partial
        };
      }
      throw new Error("Received text_delta for non-text content");
    }
    case "text_end": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type === "text") {
        content.textSignature = proxyEvent.contentSignature;
        return {
          type: "text_end",
          contentIndex: proxyEvent.contentIndex,
          content: content.text,
          partial
        };
      }
      throw new Error("Received text_end for non-text content");
    }
    case "thinking_start":
      partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
      return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };
    case "thinking_delta": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type === "thinking") {
        content.thinking += proxyEvent.delta;
        return {
          type: "thinking_delta",
          contentIndex: proxyEvent.contentIndex,
          delta: proxyEvent.delta,
          partial
        };
      }
      throw new Error("Received thinking_delta for non-thinking content");
    }
    case "thinking_end": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type === "thinking") {
        content.thinkingSignature = proxyEvent.contentSignature;
        return {
          type: "thinking_end",
          contentIndex: proxyEvent.contentIndex,
          content: content.thinking,
          partial
        };
      }
      throw new Error("Received thinking_end for non-thinking content");
    }
    case "toolcall_start":
      partial.content[proxyEvent.contentIndex] = {
        type: "toolCall",
        id: proxyEvent.id,
        name: proxyEvent.toolName,
        arguments: {},
        partialJson: ""
      };
      return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };
    case "toolcall_delta": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type === "toolCall") {
        content.partialJson += proxyEvent.delta;
        content.arguments = parseStreamingJson(content.partialJson) || {};
        partial.content[proxyEvent.contentIndex] = { ...content };
        return {
          type: "toolcall_delta",
          contentIndex: proxyEvent.contentIndex,
          delta: proxyEvent.delta,
          partial
        };
      }
      throw new Error("Received toolcall_delta for non-toolCall content");
    }
    case "toolcall_end": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type === "toolCall") {
        delete content.partialJson;
        return {
          type: "toolcall_end",
          contentIndex: proxyEvent.contentIndex,
          toolCall: content,
          partial
        };
      }
      return void 0;
    }
    case "done":
      partial.stopReason = proxyEvent.reason;
      partial.usage = proxyEvent.usage;
      return { type: "done", reason: proxyEvent.reason, message: partial };
    case "error":
      partial.stopReason = proxyEvent.reason;
      partial.errorMessage = proxyEvent.errorMessage;
      partial.usage = proxyEvent.usage;
      return { type: "error", reason: proxyEvent.reason, error: partial };
    default: {
      const _exhaustiveCheck = proxyEvent;
      console.warn(`Unhandled proxy event type: ${proxyEvent.type}`);
      return void 0;
    }
  }
}
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWdlbnQtY29yZS9zcmMvcHJveHkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUHJveHkgc3RyZWFtIGZ1bmN0aW9uIGZvciBhcHBzIHRoYXQgcm91dGUgTExNIGNhbGxzIHRocm91Z2ggYSBzZXJ2ZXIuXG4gKiBUaGUgc2VydmVyIG1hbmFnZXMgYXV0aCBhbmQgcHJveGllcyByZXF1ZXN0cyB0byBMTE0gcHJvdmlkZXJzLlxuICovXG5cbi8vIEludGVybmFsIGltcG9ydCBmb3IgSlNPTiBwYXJzaW5nIHV0aWxpdHlcbmltcG9ydCB7XG5cdHR5cGUgQXNzaXN0YW50TWVzc2FnZSxcblx0dHlwZSBBc3Npc3RhbnRNZXNzYWdlRXZlbnQsXG5cdHR5cGUgQ29udGV4dCxcblx0RXZlbnRTdHJlYW0sXG5cdHR5cGUgTW9kZWwsXG5cdHBhcnNlU3RyZWFtaW5nSnNvbixcblx0dHlwZSBTaW1wbGVTdHJlYW1PcHRpb25zLFxuXHR0eXBlIFN0b3BSZWFzb24sXG5cdHR5cGUgVG9vbENhbGwsXG59IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgeyBaRVJPX1VTQUdFIH0gZnJvbSBcIi4vYWdlbnQtbG9vcC5qc1wiO1xuXG4vLyBDcmVhdGUgc3RyZWFtIGNsYXNzIG1hdGNoaW5nIFByb3h5TWVzc2FnZUV2ZW50U3RyZWFtXG5jbGFzcyBQcm94eU1lc3NhZ2VFdmVudFN0cmVhbSBleHRlbmRzIEV2ZW50U3RyZWFtPEFzc2lzdGFudE1lc3NhZ2VFdmVudCwgQXNzaXN0YW50TWVzc2FnZT4ge1xuXHRjb25zdHJ1Y3RvcigpIHtcblx0XHRzdXBlcihcblx0XHRcdChldmVudCkgPT4gZXZlbnQudHlwZSA9PT0gXCJkb25lXCIgfHwgZXZlbnQudHlwZSA9PT0gXCJlcnJvclwiLFxuXHRcdFx0KGV2ZW50KSA9PiB7XG5cdFx0XHRcdGlmIChldmVudC50eXBlID09PSBcImRvbmVcIikgcmV0dXJuIGV2ZW50Lm1lc3NhZ2U7XG5cdFx0XHRcdGlmIChldmVudC50eXBlID09PSBcImVycm9yXCIpIHJldHVybiBldmVudC5lcnJvcjtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiVW5leHBlY3RlZCBldmVudCB0eXBlXCIpO1xuXHRcdFx0fSxcblx0XHQpO1xuXHR9XG59XG5cbi8qKlxuICogUHJveHkgZXZlbnQgdHlwZXMgLSBzZXJ2ZXIgc2VuZHMgdGhlc2Ugd2l0aCBwYXJ0aWFsIGZpZWxkIHN0cmlwcGVkIHRvIHJlZHVjZSBiYW5kd2lkdGguXG4gKi9cbmV4cG9ydCB0eXBlIFByb3h5QXNzaXN0YW50TWVzc2FnZUV2ZW50ID1cblx0fCB7IHR5cGU6IFwic3RhcnRcIiB9XG5cdHwgeyB0eXBlOiBcInRleHRfc3RhcnRcIjsgY29udGVudEluZGV4OiBudW1iZXIgfVxuXHR8IHsgdHlwZTogXCJ0ZXh0X2RlbHRhXCI7IGNvbnRlbnRJbmRleDogbnVtYmVyOyBkZWx0YTogc3RyaW5nIH1cblx0fCB7IHR5cGU6IFwidGV4dF9lbmRcIjsgY29udGVudEluZGV4OiBudW1iZXI7IGNvbnRlbnRTaWduYXR1cmU/OiBzdHJpbmcgfVxuXHR8IHsgdHlwZTogXCJ0aGlua2luZ19zdGFydFwiOyBjb250ZW50SW5kZXg6IG51bWJlciB9XG5cdHwgeyB0eXBlOiBcInRoaW5raW5nX2RlbHRhXCI7IGNvbnRlbnRJbmRleDogbnVtYmVyOyBkZWx0YTogc3RyaW5nIH1cblx0fCB7IHR5cGU6IFwidGhpbmtpbmdfZW5kXCI7IGNvbnRlbnRJbmRleDogbnVtYmVyOyBjb250ZW50U2lnbmF0dXJlPzogc3RyaW5nIH1cblx0fCB7IHR5cGU6IFwidG9vbGNhbGxfc3RhcnRcIjsgY29udGVudEluZGV4OiBudW1iZXI7IGlkOiBzdHJpbmc7IHRvb2xOYW1lOiBzdHJpbmcgfVxuXHR8IHsgdHlwZTogXCJ0b29sY2FsbF9kZWx0YVwiOyBjb250ZW50SW5kZXg6IG51bWJlcjsgZGVsdGE6IHN0cmluZyB9XG5cdHwgeyB0eXBlOiBcInRvb2xjYWxsX2VuZFwiOyBjb250ZW50SW5kZXg6IG51bWJlciB9XG5cdHwge1xuXHRcdFx0dHlwZTogXCJkb25lXCI7XG5cdFx0XHRyZWFzb246IEV4dHJhY3Q8U3RvcFJlYXNvbiwgXCJzdG9wXCIgfCBcImxlbmd0aFwiIHwgXCJ0b29sVXNlXCIgfCBcInBhdXNlVHVyblwiPjtcblx0XHRcdHVzYWdlOiBBc3Npc3RhbnRNZXNzYWdlW1widXNhZ2VcIl07XG5cdCAgfVxuXHR8IHtcblx0XHRcdHR5cGU6IFwiZXJyb3JcIjtcblx0XHRcdHJlYXNvbjogRXh0cmFjdDxTdG9wUmVhc29uLCBcImFib3J0ZWRcIiB8IFwiZXJyb3JcIj47XG5cdFx0XHRlcnJvck1lc3NhZ2U/OiBzdHJpbmc7XG5cdFx0XHR1c2FnZTogQXNzaXN0YW50TWVzc2FnZVtcInVzYWdlXCJdO1xuXHQgIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJveHlTdHJlYW1PcHRpb25zIGV4dGVuZHMgU2ltcGxlU3RyZWFtT3B0aW9ucyB7XG5cdC8qKiBBdXRoIHRva2VuIGZvciB0aGUgcHJveHkgc2VydmVyICovXG5cdGF1dGhUb2tlbjogc3RyaW5nO1xuXHQvKiogUHJveHkgc2VydmVyIFVSTCAoZS5nLiwgXCJodHRwczovL2dlbmFpLmV4YW1wbGUuY29tXCIpICovXG5cdHByb3h5VXJsOiBzdHJpbmc7XG59XG5cbi8qKlxuICogU3RyZWFtIGZ1bmN0aW9uIHRoYXQgcHJveGllcyB0aHJvdWdoIGEgc2VydmVyIGluc3RlYWQgb2YgY2FsbGluZyBMTE0gcHJvdmlkZXJzIGRpcmVjdGx5LlxuICogVGhlIHNlcnZlciBzdHJpcHMgdGhlIHBhcnRpYWwgZmllbGQgZnJvbSBkZWx0YSBldmVudHMgdG8gcmVkdWNlIGJhbmR3aWR0aC5cbiAqIFdlIHJlY29uc3RydWN0IHRoZSBwYXJ0aWFsIG1lc3NhZ2UgY2xpZW50LXNpZGUuXG4gKlxuICogVXNlIHRoaXMgYXMgdGhlIGBzdHJlYW1GbmAgb3B0aW9uIHdoZW4gY3JlYXRpbmcgYW4gQWdlbnQgdGhhdCBuZWVkcyB0byBnbyB0aHJvdWdoIGEgcHJveHkuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIGNvbnN0IGFnZW50ID0gbmV3IEFnZW50KHtcbiAqICAgc3RyZWFtRm46IChtb2RlbCwgY29udGV4dCwgb3B0aW9ucykgPT5cbiAqICAgICBzdHJlYW1Qcm94eShtb2RlbCwgY29udGV4dCwge1xuICogICAgICAgLi4ub3B0aW9ucyxcbiAqICAgICAgIGF1dGhUb2tlbjogYXdhaXQgZ2V0QXV0aFRva2VuKCksXG4gKiAgICAgICBwcm94eVVybDogXCJodHRwczovL2dlbmFpLmV4YW1wbGUuY29tXCIsXG4gKiAgICAgfSksXG4gKiB9KTtcbiAqIGBgYFxuICovXG5mdW5jdGlvbiBzdHJlYW1Qcm94eShtb2RlbDogTW9kZWw8YW55PiwgY29udGV4dDogQ29udGV4dCwgb3B0aW9uczogUHJveHlTdHJlYW1PcHRpb25zKTogUHJveHlNZXNzYWdlRXZlbnRTdHJlYW0ge1xuXHRjb25zdCBzdHJlYW0gPSBuZXcgUHJveHlNZXNzYWdlRXZlbnRTdHJlYW0oKTtcblxuXHQoYXN5bmMgKCkgPT4ge1xuXHRcdC8vIEluaXRpYWxpemUgdGhlIHBhcnRpYWwgbWVzc2FnZSB0aGF0IHdlJ2xsIGJ1aWxkIHVwIGZyb20gZXZlbnRzXG5cdFx0Y29uc3QgcGFydGlhbDogQXNzaXN0YW50TWVzc2FnZSA9IHtcblx0XHRcdHJvbGU6IFwiYXNzaXN0YW50XCIsXG5cdFx0XHRzdG9wUmVhc29uOiBcInN0b3BcIixcblx0XHRcdGNvbnRlbnQ6IFtdLFxuXHRcdFx0YXBpOiBtb2RlbC5hcGksXG5cdFx0XHRwcm92aWRlcjogbW9kZWwucHJvdmlkZXIsXG5cdFx0XHRtb2RlbDogbW9kZWwuaWQsXG5cdFx0XHR1c2FnZTogeyAuLi5aRVJPX1VTQUdFLCBjb3N0OiB7IC4uLlpFUk9fVVNBR0UuY29zdCB9IH0sXG5cdFx0XHR0aW1lc3RhbXA6IERhdGUubm93KCksXG5cdFx0fTtcblxuXHRcdGxldCByZWFkZXI6IFJlYWRhYmxlU3RyZWFtRGVmYXVsdFJlYWRlcjxVaW50OEFycmF5PiB8IHVuZGVmaW5lZDtcblxuXHRcdGNvbnN0IGFib3J0SGFuZGxlciA9ICgpID0+IHtcblx0XHRcdGlmIChyZWFkZXIpIHtcblx0XHRcdFx0cmVhZGVyLmNhbmNlbChcIlJlcXVlc3QgYWJvcnRlZCBieSB1c2VyXCIpLmNhdGNoKCgpID0+IHt9KTtcblx0XHRcdH1cblx0XHR9O1xuXG5cdFx0aWYgKG9wdGlvbnMuc2lnbmFsKSB7XG5cdFx0XHRvcHRpb25zLnNpZ25hbC5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgYWJvcnRIYW5kbGVyKTtcblx0XHR9XG5cblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgJHtvcHRpb25zLnByb3h5VXJsfS9hcGkvc3RyZWFtYCwge1xuXHRcdFx0XHRtZXRob2Q6IFwiUE9TVFwiLFxuXHRcdFx0XHRoZWFkZXJzOiB7XG5cdFx0XHRcdFx0QXV0aG9yaXphdGlvbjogYEJlYXJlciAke29wdGlvbnMuYXV0aFRva2VufWAsXG5cdFx0XHRcdFx0XCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG5cdFx0XHRcdH0sXG5cdFx0XHRcdGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcblx0XHRcdFx0XHRtb2RlbCxcblx0XHRcdFx0XHRjb250ZXh0LFxuXHRcdFx0XHRcdG9wdGlvbnM6IHtcblx0XHRcdFx0XHRcdHRlbXBlcmF0dXJlOiBvcHRpb25zLnRlbXBlcmF0dXJlLFxuXHRcdFx0XHRcdFx0bWF4VG9rZW5zOiBvcHRpb25zLm1heFRva2Vucyxcblx0XHRcdFx0XHRcdHJlYXNvbmluZzogb3B0aW9ucy5yZWFzb25pbmcsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSksXG5cdFx0XHRcdHNpZ25hbDogb3B0aW9ucy5zaWduYWwsXG5cdFx0XHR9KTtcblxuXHRcdFx0aWYgKCFyZXNwb25zZS5vaykge1xuXHRcdFx0XHRsZXQgZXJyb3JNZXNzYWdlID0gYFByb3h5IGVycm9yOiAke3Jlc3BvbnNlLnN0YXR1c30gJHtyZXNwb25zZS5zdGF0dXNUZXh0fWA7XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0Y29uc3QgZXJyb3JEYXRhID0gKGF3YWl0IHJlc3BvbnNlLmpzb24oKSkgYXMgeyBlcnJvcj86IHN0cmluZyB9O1xuXHRcdFx0XHRcdGlmIChlcnJvckRhdGEuZXJyb3IpIHtcblx0XHRcdFx0XHRcdGVycm9yTWVzc2FnZSA9IGBQcm94eSBlcnJvcjogJHtlcnJvckRhdGEuZXJyb3J9YDtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdC8vIENvdWxkbid0IHBhcnNlIGVycm9yIHJlc3BvbnNlXG5cdFx0XHRcdH1cblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGVycm9yTWVzc2FnZSk7XG5cdFx0XHR9XG5cblx0XHRcdHJlYWRlciA9IHJlc3BvbnNlLmJvZHkhLmdldFJlYWRlcigpO1xuXHRcdFx0Y29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuXHRcdFx0bGV0IGJ1ZmZlciA9IFwiXCI7XG5cblx0XHRcdHdoaWxlICh0cnVlKSB7XG5cdFx0XHRcdGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG5cdFx0XHRcdGlmIChkb25lKSBicmVhaztcblxuXHRcdFx0XHRpZiAob3B0aW9ucy5zaWduYWw/LmFib3J0ZWQpIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJSZXF1ZXN0IGFib3J0ZWQgYnkgdXNlclwiKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGJ1ZmZlciArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cdFx0XHRcdGNvbnN0IGxpbmVzID0gYnVmZmVyLnNwbGl0KFwiXFxuXCIpO1xuXHRcdFx0XHRidWZmZXIgPSBsaW5lcy5wb3AoKSB8fCBcIlwiO1xuXG5cdFx0XHRcdGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuXHRcdFx0XHRcdGlmIChsaW5lLnN0YXJ0c1dpdGgoXCJkYXRhOiBcIikpIHtcblx0XHRcdFx0XHRcdGNvbnN0IGRhdGEgPSBsaW5lLnNsaWNlKDYpLnRyaW0oKTtcblx0XHRcdFx0XHRcdGlmIChkYXRhKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHByb3h5RXZlbnQgPSBKU09OLnBhcnNlKGRhdGEpIGFzIFByb3h5QXNzaXN0YW50TWVzc2FnZUV2ZW50O1xuXHRcdFx0XHRcdFx0XHRjb25zdCBldmVudCA9IHByb2Nlc3NQcm94eUV2ZW50KHByb3h5RXZlbnQsIHBhcnRpYWwpO1xuXHRcdFx0XHRcdFx0XHRpZiAoZXZlbnQpIHtcblx0XHRcdFx0XHRcdFx0XHRzdHJlYW0ucHVzaChldmVudCk7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0aWYgKG9wdGlvbnMuc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIlJlcXVlc3QgYWJvcnRlZCBieSB1c2VyXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRzdHJlYW0uZW5kKCk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGNvbnN0IGVycm9yTWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcblx0XHRcdGNvbnN0IHJlYXNvbiA9IG9wdGlvbnMuc2lnbmFsPy5hYm9ydGVkID8gXCJhYm9ydGVkXCIgOiBcImVycm9yXCI7XG5cdFx0XHRwYXJ0aWFsLnN0b3BSZWFzb24gPSByZWFzb247XG5cdFx0XHRwYXJ0aWFsLmVycm9yTWVzc2FnZSA9IGVycm9yTWVzc2FnZTtcblx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0dHlwZTogXCJlcnJvclwiLFxuXHRcdFx0XHRyZWFzb24sXG5cdFx0XHRcdGVycm9yOiBwYXJ0aWFsLFxuXHRcdFx0fSk7XG5cdFx0XHRzdHJlYW0uZW5kKCk7XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdGlmIChvcHRpb25zLnNpZ25hbCkge1xuXHRcdFx0XHRvcHRpb25zLnNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgYWJvcnRIYW5kbGVyKTtcblx0XHRcdH1cblx0XHR9XG5cdH0pKCk7XG5cblx0cmV0dXJuIHN0cmVhbTtcbn1cblxuLyoqXG4gKiBQcm9jZXNzIGEgcHJveHkgZXZlbnQgYW5kIHVwZGF0ZSB0aGUgcGFydGlhbCBtZXNzYWdlLlxuICovXG5mdW5jdGlvbiBwcm9jZXNzUHJveHlFdmVudChcblx0cHJveHlFdmVudDogUHJveHlBc3Npc3RhbnRNZXNzYWdlRXZlbnQsXG5cdHBhcnRpYWw6IEFzc2lzdGFudE1lc3NhZ2UsXG4pOiBBc3Npc3RhbnRNZXNzYWdlRXZlbnQgfCB1bmRlZmluZWQge1xuXHRzd2l0Y2ggKHByb3h5RXZlbnQudHlwZSkge1xuXHRcdGNhc2UgXCJzdGFydFwiOlxuXHRcdFx0cmV0dXJuIHsgdHlwZTogXCJzdGFydFwiLCBwYXJ0aWFsIH07XG5cblx0XHRjYXNlIFwidGV4dF9zdGFydFwiOlxuXHRcdFx0cGFydGlhbC5jb250ZW50W3Byb3h5RXZlbnQuY29udGVudEluZGV4XSA9IHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiXCIgfTtcblx0XHRcdHJldHVybiB7IHR5cGU6IFwidGV4dF9zdGFydFwiLCBjb250ZW50SW5kZXg6IHByb3h5RXZlbnQuY29udGVudEluZGV4LCBwYXJ0aWFsIH07XG5cblx0XHRjYXNlIFwidGV4dF9kZWx0YVwiOiB7XG5cdFx0XHRjb25zdCBjb250ZW50ID0gcGFydGlhbC5jb250ZW50W3Byb3h5RXZlbnQuY29udGVudEluZGV4XTtcblx0XHRcdGlmIChjb250ZW50Py50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHRjb250ZW50LnRleHQgKz0gcHJveHlFdmVudC5kZWx0YTtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHR0eXBlOiBcInRleHRfZGVsdGFcIixcblx0XHRcdFx0XHRjb250ZW50SW5kZXg6IHByb3h5RXZlbnQuY29udGVudEluZGV4LFxuXHRcdFx0XHRcdGRlbHRhOiBwcm94eUV2ZW50LmRlbHRhLFxuXHRcdFx0XHRcdHBhcnRpYWwsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJSZWNlaXZlZCB0ZXh0X2RlbHRhIGZvciBub24tdGV4dCBjb250ZW50XCIpO1xuXHRcdH1cblxuXHRcdGNhc2UgXCJ0ZXh0X2VuZFwiOiB7XG5cdFx0XHRjb25zdCBjb250ZW50ID0gcGFydGlhbC5jb250ZW50W3Byb3h5RXZlbnQuY29udGVudEluZGV4XTtcblx0XHRcdGlmIChjb250ZW50Py50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHRjb250ZW50LnRleHRTaWduYXR1cmUgPSBwcm94eUV2ZW50LmNvbnRlbnRTaWduYXR1cmU7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0dHlwZTogXCJ0ZXh0X2VuZFwiLFxuXHRcdFx0XHRcdGNvbnRlbnRJbmRleDogcHJveHlFdmVudC5jb250ZW50SW5kZXgsXG5cdFx0XHRcdFx0Y29udGVudDogY29udGVudC50ZXh0LFxuXHRcdFx0XHRcdHBhcnRpYWwsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJSZWNlaXZlZCB0ZXh0X2VuZCBmb3Igbm9uLXRleHQgY29udGVudFwiKTtcblx0XHR9XG5cblx0XHRjYXNlIFwidGhpbmtpbmdfc3RhcnRcIjpcblx0XHRcdHBhcnRpYWwuY29udGVudFtwcm94eUV2ZW50LmNvbnRlbnRJbmRleF0gPSB7IHR5cGU6IFwidGhpbmtpbmdcIiwgdGhpbmtpbmc6IFwiXCIgfTtcblx0XHRcdHJldHVybiB7IHR5cGU6IFwidGhpbmtpbmdfc3RhcnRcIiwgY29udGVudEluZGV4OiBwcm94eUV2ZW50LmNvbnRlbnRJbmRleCwgcGFydGlhbCB9O1xuXG5cdFx0Y2FzZSBcInRoaW5raW5nX2RlbHRhXCI6IHtcblx0XHRcdGNvbnN0IGNvbnRlbnQgPSBwYXJ0aWFsLmNvbnRlbnRbcHJveHlFdmVudC5jb250ZW50SW5kZXhdO1xuXHRcdFx0aWYgKGNvbnRlbnQ/LnR5cGUgPT09IFwidGhpbmtpbmdcIikge1xuXHRcdFx0XHRjb250ZW50LnRoaW5raW5nICs9IHByb3h5RXZlbnQuZGVsdGE7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0dHlwZTogXCJ0aGlua2luZ19kZWx0YVwiLFxuXHRcdFx0XHRcdGNvbnRlbnRJbmRleDogcHJveHlFdmVudC5jb250ZW50SW5kZXgsXG5cdFx0XHRcdFx0ZGVsdGE6IHByb3h5RXZlbnQuZGVsdGEsXG5cdFx0XHRcdFx0cGFydGlhbCxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHRcdHRocm93IG5ldyBFcnJvcihcIlJlY2VpdmVkIHRoaW5raW5nX2RlbHRhIGZvciBub24tdGhpbmtpbmcgY29udGVudFwiKTtcblx0XHR9XG5cblx0XHRjYXNlIFwidGhpbmtpbmdfZW5kXCI6IHtcblx0XHRcdGNvbnN0IGNvbnRlbnQgPSBwYXJ0aWFsLmNvbnRlbnRbcHJveHlFdmVudC5jb250ZW50SW5kZXhdO1xuXHRcdFx0aWYgKGNvbnRlbnQ/LnR5cGUgPT09IFwidGhpbmtpbmdcIikge1xuXHRcdFx0XHRjb250ZW50LnRoaW5raW5nU2lnbmF0dXJlID0gcHJveHlFdmVudC5jb250ZW50U2lnbmF0dXJlO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdHR5cGU6IFwidGhpbmtpbmdfZW5kXCIsXG5cdFx0XHRcdFx0Y29udGVudEluZGV4OiBwcm94eUV2ZW50LmNvbnRlbnRJbmRleCxcblx0XHRcdFx0XHRjb250ZW50OiBjb250ZW50LnRoaW5raW5nLFxuXHRcdFx0XHRcdHBhcnRpYWwsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJSZWNlaXZlZCB0aGlua2luZ19lbmQgZm9yIG5vbi10aGlua2luZyBjb250ZW50XCIpO1xuXHRcdH1cblxuXHRcdGNhc2UgXCJ0b29sY2FsbF9zdGFydFwiOlxuXHRcdFx0cGFydGlhbC5jb250ZW50W3Byb3h5RXZlbnQuY29udGVudEluZGV4XSA9IHtcblx0XHRcdFx0dHlwZTogXCJ0b29sQ2FsbFwiLFxuXHRcdFx0XHRpZDogcHJveHlFdmVudC5pZCxcblx0XHRcdFx0bmFtZTogcHJveHlFdmVudC50b29sTmFtZSxcblx0XHRcdFx0YXJndW1lbnRzOiB7fSxcblx0XHRcdFx0cGFydGlhbEpzb246IFwiXCIsXG5cdFx0XHR9IHNhdGlzZmllcyBUb29sQ2FsbCAmIHsgcGFydGlhbEpzb246IHN0cmluZyB9IGFzIFRvb2xDYWxsO1xuXHRcdFx0cmV0dXJuIHsgdHlwZTogXCJ0b29sY2FsbF9zdGFydFwiLCBjb250ZW50SW5kZXg6IHByb3h5RXZlbnQuY29udGVudEluZGV4LCBwYXJ0aWFsIH07XG5cblx0XHRjYXNlIFwidG9vbGNhbGxfZGVsdGFcIjoge1xuXHRcdFx0Y29uc3QgY29udGVudCA9IHBhcnRpYWwuY29udGVudFtwcm94eUV2ZW50LmNvbnRlbnRJbmRleF07XG5cdFx0XHRpZiAoY29udGVudD8udHlwZSA9PT0gXCJ0b29sQ2FsbFwiKSB7XG5cdFx0XHRcdChjb250ZW50IGFzIGFueSkucGFydGlhbEpzb24gKz0gcHJveHlFdmVudC5kZWx0YTtcblx0XHRcdFx0Y29udGVudC5hcmd1bWVudHMgPSBwYXJzZVN0cmVhbWluZ0pzb24oKGNvbnRlbnQgYXMgYW55KS5wYXJ0aWFsSnNvbikgfHwge307XG5cdFx0XHRcdHBhcnRpYWwuY29udGVudFtwcm94eUV2ZW50LmNvbnRlbnRJbmRleF0gPSB7IC4uLmNvbnRlbnQgfTsgLy8gVHJpZ2dlciByZWFjdGl2aXR5XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0dHlwZTogXCJ0b29sY2FsbF9kZWx0YVwiLFxuXHRcdFx0XHRcdGNvbnRlbnRJbmRleDogcHJveHlFdmVudC5jb250ZW50SW5kZXgsXG5cdFx0XHRcdFx0ZGVsdGE6IHByb3h5RXZlbnQuZGVsdGEsXG5cdFx0XHRcdFx0cGFydGlhbCxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHRcdHRocm93IG5ldyBFcnJvcihcIlJlY2VpdmVkIHRvb2xjYWxsX2RlbHRhIGZvciBub24tdG9vbENhbGwgY29udGVudFwiKTtcblx0XHR9XG5cblx0XHRjYXNlIFwidG9vbGNhbGxfZW5kXCI6IHtcblx0XHRcdGNvbnN0IGNvbnRlbnQgPSBwYXJ0aWFsLmNvbnRlbnRbcHJveHlFdmVudC5jb250ZW50SW5kZXhdO1xuXHRcdFx0aWYgKGNvbnRlbnQ/LnR5cGUgPT09IFwidG9vbENhbGxcIikge1xuXHRcdFx0XHRkZWxldGUgKGNvbnRlbnQgYXMgYW55KS5wYXJ0aWFsSnNvbjtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHR0eXBlOiBcInRvb2xjYWxsX2VuZFwiLFxuXHRcdFx0XHRcdGNvbnRlbnRJbmRleDogcHJveHlFdmVudC5jb250ZW50SW5kZXgsXG5cdFx0XHRcdFx0dG9vbENhbGw6IGNvbnRlbnQsXG5cdFx0XHRcdFx0cGFydGlhbCxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdFx0fVxuXG5cdFx0Y2FzZSBcImRvbmVcIjpcblx0XHRcdHBhcnRpYWwuc3RvcFJlYXNvbiA9IHByb3h5RXZlbnQucmVhc29uO1xuXHRcdFx0cGFydGlhbC51c2FnZSA9IHByb3h5RXZlbnQudXNhZ2U7XG5cdFx0XHRyZXR1cm4geyB0eXBlOiBcImRvbmVcIiwgcmVhc29uOiBwcm94eUV2ZW50LnJlYXNvbiwgbWVzc2FnZTogcGFydGlhbCB9O1xuXG5cdFx0Y2FzZSBcImVycm9yXCI6XG5cdFx0XHRwYXJ0aWFsLnN0b3BSZWFzb24gPSBwcm94eUV2ZW50LnJlYXNvbjtcblx0XHRcdHBhcnRpYWwuZXJyb3JNZXNzYWdlID0gcHJveHlFdmVudC5lcnJvck1lc3NhZ2U7XG5cdFx0XHRwYXJ0aWFsLnVzYWdlID0gcHJveHlFdmVudC51c2FnZTtcblx0XHRcdHJldHVybiB7IHR5cGU6IFwiZXJyb3JcIiwgcmVhc29uOiBwcm94eUV2ZW50LnJlYXNvbiwgZXJyb3I6IHBhcnRpYWwgfTtcblxuXHRcdGRlZmF1bHQ6IHtcblx0XHRcdGNvbnN0IF9leGhhdXN0aXZlQ2hlY2s6IG5ldmVyID0gcHJveHlFdmVudDtcblx0XHRcdGNvbnNvbGUud2FybihgVW5oYW5kbGVkIHByb3h5IGV2ZW50IHR5cGU6ICR7KHByb3h5RXZlbnQgYXMgYW55KS50eXBlfWApO1xuXHRcdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0XHR9XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQU1BO0FBQUEsRUFJQztBQUFBLEVBRUE7QUFBQSxPQUlNO0FBQ1AsU0FBUyxrQkFBa0I7QUFHM0IsTUFBTSxnQ0FBZ0MsWUFBcUQ7QUFBQSxFQUMxRixjQUFjO0FBQ2I7QUFBQSxNQUNDLENBQUMsVUFBVSxNQUFNLFNBQVMsVUFBVSxNQUFNLFNBQVM7QUFBQSxNQUNuRCxDQUFDLFVBQVU7QUFDVixZQUFJLE1BQU0sU0FBUyxPQUFRLFFBQU8sTUFBTTtBQUN4QyxZQUFJLE1BQU0sU0FBUyxRQUFTLFFBQU8sTUFBTTtBQUN6QyxjQUFNLElBQUksTUFBTSx1QkFBdUI7QUFBQSxNQUN4QztBQUFBLElBQ0Q7QUFBQSxFQUNEO0FBQ0Q7QUFzREEsU0FBUyxZQUFZLE9BQW1CLFNBQWtCLFNBQXNEO0FBQy9HLFFBQU0sU0FBUyxJQUFJLHdCQUF3QjtBQUUzQyxHQUFDLFlBQVk7QUFFWixVQUFNLFVBQTRCO0FBQUEsTUFDakMsTUFBTTtBQUFBLE1BQ04sWUFBWTtBQUFBLE1BQ1osU0FBUyxDQUFDO0FBQUEsTUFDVixLQUFLLE1BQU07QUFBQSxNQUNYLFVBQVUsTUFBTTtBQUFBLE1BQ2hCLE9BQU8sTUFBTTtBQUFBLE1BQ2IsT0FBTyxFQUFFLEdBQUcsWUFBWSxNQUFNLEVBQUUsR0FBRyxXQUFXLEtBQUssRUFBRTtBQUFBLE1BQ3JELFdBQVcsS0FBSyxJQUFJO0FBQUEsSUFDckI7QUFFQSxRQUFJO0FBRUosVUFBTSxlQUFlLE1B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
