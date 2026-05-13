import {
  EventStream
} from "@gsd/pi-ai";
import { chat } from "./ollama-client.js";
import { ThinkingTagParser } from "./thinking-parser.js";
function createStream() {
  return new EventStream(
    (event) => event.type === "done" || event.type === "error",
    (event) => {
      if (event.type === "done") return event.message;
      if (event.type === "error") return event.error;
      throw new Error("Unexpected event type for final result");
    }
  );
}
function streamOllamaChat(model, context, options) {
  const stream = createStream();
  (async () => {
    const output = buildInitialOutput(model);
    try {
      let startBlock2 = function(type) {
        contentIndex++;
        currentBlockType = type;
        if (type === "text") {
          output.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex, partial: output });
        } else {
          output.content.push({ type: "thinking", thinking: "" });
          stream.push({ type: "thinking_start", contentIndex, partial: output });
        }
      }, endBlock2 = function() {
        if (currentBlockType === null) return;
        if (currentBlockType === "text") {
          const block = output.content[contentIndex];
          stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
        } else {
          const block = output.content[contentIndex];
          stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
        }
        currentBlockType = null;
      }, emitDelta2 = function(type, text) {
        if (!text) return;
        if (currentBlockType !== type) {
          endBlock2();
          startBlock2(type);
        }
        if (type === "text") {
          output.content[contentIndex].text += text;
          stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
        } else {
          output.content[contentIndex].thinking += text;
          stream.push({ type: "thinking_delta", contentIndex, delta: text, partial: output });
        }
      }, processChunks2 = function(chunks) {
        for (const chunk of chunks) {
          emitDelta2(chunk.type, chunk.text);
        }
      }, processToolCalls2 = function(toolCalls) {
        endBlock2();
        for (const tc of toolCalls) {
          contentIndex++;
          const toolCall = {
            type: "toolCall",
            id: `ollama_tc_${contentIndex}`,
            name: tc.function.name,
            arguments: tc.function.arguments
          };
          output.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
          stream.push({
            type: "toolcall_delta",
            contentIndex,
            delta: JSON.stringify(tc.function.arguments),
            partial: output
          });
          stream.push({
            type: "toolcall_end",
            contentIndex,
            toolCall,
            partial: output
          });
        }
        output.stopReason = "toolUse";
      };
      var startBlock = startBlock2, endBlock = endBlock2, emitDelta = emitDelta2, processChunks = processChunks2, processToolCalls = processToolCalls2;
      const request = buildRequest(model, context, options);
      stream.push({ type: "start", partial: output });
      const useThinkingParser = model.reasoning;
      const thinkParser = useThinkingParser ? new ThinkingTagParser() : null;
      let contentIndex = -1;
      let currentBlockType = null;
      for await (const chunk of chat(request, options?.signal)) {
        const content = chunk.message?.content ?? "";
        if (content) {
          if (thinkParser) {
            processChunks2(thinkParser.push(content));
          } else {
            emitDelta2("text", content);
          }
        }
        if (chunk.message?.tool_calls?.length) {
          processToolCalls2(chunk.message.tool_calls);
        }
        if (chunk.done) {
          if (thinkParser) processChunks2(thinkParser.flush());
          endBlock2();
          output.usage = buildUsage(chunk);
          output.inferenceMetrics = extractMetrics(chunk);
          if (output.stopReason !== "toolUse") {
            output.stopReason = mapStopReason(chunk.done_reason);
          }
          break;
        }
      }
      assertStreamSuccess(output, options?.signal);
      finalizeStream(stream, output);
    } catch (error) {
      handleStreamError(stream, output, error, options?.signal);
    }
  })();
  return stream;
}
function buildRequest(model, context, options) {
  const ollamaOpts = model.providerOptions ?? {};
  const request = {
    model: model.id,
    messages: convertMessages(context),
    stream: true
  };
  const reqOptions = {};
  if (ollamaOpts.num_ctx !== void 0 && ollamaOpts.num_ctx > 0) {
    reqOptions.num_ctx = ollamaOpts.num_ctx;
  }
  const maxTokens = options?.maxTokens ?? model.maxTokens;
  if (maxTokens > 0) {
    reqOptions.num_predict = maxTokens;
  }
  if (options?.temperature !== void 0) {
    reqOptions.temperature = options.temperature;
  }
  if (ollamaOpts.top_p !== void 0) reqOptions.top_p = ollamaOpts.top_p;
  if (ollamaOpts.top_k !== void 0) reqOptions.top_k = ollamaOpts.top_k;
  if (ollamaOpts.repeat_penalty !== void 0) reqOptions.repeat_penalty = ollamaOpts.repeat_penalty;
  if (ollamaOpts.seed !== void 0) reqOptions.seed = ollamaOpts.seed;
  if (ollamaOpts.num_gpu !== void 0) reqOptions.num_gpu = ollamaOpts.num_gpu;
  if (Object.keys(reqOptions).length > 0) {
    request.options = reqOptions;
  }
  if (ollamaOpts.keep_alive !== void 0) {
    request.keep_alive = ollamaOpts.keep_alive;
  }
  if (context.tools?.length) {
    request.tools = convertTools(context.tools);
  }
  return request;
}
function convertMessages(context) {
  const messages = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  for (const msg of context.messages) {
    switch (msg.role) {
      case "user":
        messages.push(convertUserMessage(msg));
        break;
      case "assistant":
        messages.push(convertAssistantMessage(msg));
        break;
      case "toolResult":
        messages.push({
          role: "tool",
          content: msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
          name: msg.toolName
        });
        break;
    }
  }
  return messages;
}
function convertUserMessage(msg) {
  if (typeof msg.content === "string") {
    return { role: "user", content: msg.content };
  }
  const textParts = [];
  const images = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      textParts.push(part.text);
    } else if (part.type === "image") {
      let data = part.data;
      const commaIdx = data.indexOf(",");
      if (commaIdx !== -1 && data.startsWith("data:")) {
        data = data.slice(commaIdx + 1);
      }
      images.push(data);
    }
  }
  const result = {
    role: "user",
    content: textParts.join("\n")
  };
  if (images.length > 0) {
    result.images = images;
  }
  return result;
}
function convertAssistantMessage(msg) {
  let content = "";
  const toolCalls = [];
  for (const block of msg.content) {
    if (block.type === "thinking") {
      content += `<think>${block.thinking}</think>`;
    } else if (block.type === "text") {
      content += block.text;
    } else if (block.type === "toolCall") {
      const tc = block;
      toolCalls.push({
        function: {
          name: tc.name,
          arguments: tc.arguments
        }
      });
    }
  }
  const result = { role: "assistant", content };
  if (toolCalls.length > 0) {
    result.tool_calls = toolCalls;
  }
  return result;
}
function convertTools(tools) {
  return tools.map((tool) => {
    const params = tool.parameters;
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          required: params.required,
          properties: params.properties ?? {}
        }
      }
    };
  });
}
function mapStopReason(doneReason) {
  switch (doneReason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    default:
      return "stop";
  }
}
function buildUsage(chunk) {
  const input = chunk.prompt_eval_count ?? 0;
  const outputTokens = chunk.eval_count ?? 0;
  return {
    input,
    output: outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + outputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}
function extractMetrics(chunk) {
  if (!chunk.eval_duration && !chunk.total_duration) return void 0;
  const evalCount = chunk.eval_count ?? 0;
  const evalDurationNs = chunk.eval_duration ?? 0;
  const evalDurationMs = evalDurationNs / 1e6;
  const tokensPerSecond = evalDurationNs > 0 ? evalCount / (evalDurationNs / 1e9) : 0;
  return {
    tokensPerSecond,
    totalDurationMs: (chunk.total_duration ?? 0) / 1e6,
    evalDurationMs,
    promptEvalDurationMs: (chunk.prompt_eval_duration ?? 0) / 1e6
  };
}
function buildInitialOutput(model) {
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
function assertStreamSuccess(output, signal) {
  if (signal?.aborted) {
    throw new Error("Request was aborted");
  }
  if (output.stopReason === "aborted" || output.stopReason === "error") {
    throw new Error("An unknown error occurred");
  }
}
function finalizeStream(stream, output) {
  stream.push({
    type: "done",
    reason: output.stopReason,
    message: output
  });
  stream.end();
}
function handleStreamError(stream, output, error, signal) {
  for (const block of output.content) delete block.index;
  output.stopReason = signal?.aborted ? "aborted" : "error";
  output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
  stream.push({ type: "error", reason: output.stopReason, error: output });
  stream.end();
}
export {
  streamOllamaChat
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL29sbGFtYS9vbGxhbWEtY2hhdC1wcm92aWRlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEMiBcdTIwMTQgT2xsYW1hIEV4dGVuc2lvbjogTmF0aXZlIC9hcGkvY2hhdCBzdHJlYW0gcHJvdmlkZXJcblxuLyoqXG4gKiBJbXBsZW1lbnRzIHRoZSBcIm9sbGFtYS1jaGF0XCIgQVBJIHByb3ZpZGVyLCBzdHJlYW1pbmcgcmVzcG9uc2VzIGRpcmVjdGx5XG4gKiBmcm9tIE9sbGFtYSdzIG5hdGl2ZSAvYXBpL2NoYXQgZW5kcG9pbnQgaW5zdGVhZCBvZiB0aGUgT3BlbkFJIGNvbXBhdGliaWxpdHlcbiAqIHNoaW0uIFRoaXMgZXhwb3NlcyBPbGxhbWEtc3BlY2lmaWMgb3B0aW9ucyAobnVtX2N0eCwga2VlcF9hbGl2ZSwgbnVtX2dwdSxcbiAqIHNhbXBsaW5nIHBhcmFtZXRlcnMpIGFuZCBzdXJmYWNlcyBpbmZlcmVuY2UgcGVyZm9ybWFuY2UgbWV0cmljcy5cbiAqL1xuXG5pbXBvcnQge1xuXHR0eXBlIEFwaSxcblx0dHlwZSBBc3Npc3RhbnRNZXNzYWdlLFxuXHR0eXBlIEFzc2lzdGFudE1lc3NhZ2VFdmVudCxcblx0dHlwZSBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0sXG5cdHR5cGUgQ29udGV4dCxcblx0dHlwZSBJbWFnZUNvbnRlbnQsXG5cdHR5cGUgSW5mZXJlbmNlTWV0cmljcyxcblx0dHlwZSBNZXNzYWdlLFxuXHR0eXBlIE1vZGVsLFxuXHR0eXBlIFNpbXBsZVN0cmVhbU9wdGlvbnMsXG5cdHR5cGUgU3RvcFJlYXNvbixcblx0dHlwZSBUZXh0Q29udGVudCxcblx0dHlwZSBUaGlua2luZ0NvbnRlbnQsXG5cdHR5cGUgVG9vbCxcblx0dHlwZSBUb29sQ2FsbCxcblx0dHlwZSBVc2FnZSxcblx0RXZlbnRTdHJlYW0sXG59IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgeyBjaGF0IH0gZnJvbSBcIi4vb2xsYW1hLWNsaWVudC5qc1wiO1xuaW1wb3J0IHR5cGUge1xuXHRPbGxhbWFDaGF0TWVzc2FnZSxcblx0T2xsYW1hQ2hhdE9wdGlvbnMsXG5cdE9sbGFtYUNoYXRSZXF1ZXN0LFxuXHRPbGxhbWFDaGF0UmVzcG9uc2UsXG5cdE9sbGFtYVRvb2wsXG5cdE9sbGFtYVRvb2xDYWxsLFxufSBmcm9tIFwiLi90eXBlcy5qc1wiO1xuaW1wb3J0IHsgVGhpbmtpbmdUYWdQYXJzZXIsIHR5cGUgUGFyc2VkQ2h1bmsgfSBmcm9tIFwiLi90aGlua2luZy1wYXJzZXIuanNcIjtcblxuLyoqIENyZWF0ZSBhbiBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0gdXNpbmcgdGhlIGJhc2UgRXZlbnRTdHJlYW0gY2xhc3MuICovXG5mdW5jdGlvbiBjcmVhdGVTdHJlYW0oKTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtIHtcblx0cmV0dXJuIG5ldyBFdmVudFN0cmVhbTxBc3Npc3RhbnRNZXNzYWdlRXZlbnQsIEFzc2lzdGFudE1lc3NhZ2U+KFxuXHRcdChldmVudCkgPT4gZXZlbnQudHlwZSA9PT0gXCJkb25lXCIgfHwgZXZlbnQudHlwZSA9PT0gXCJlcnJvclwiLFxuXHRcdChldmVudCkgPT4ge1xuXHRcdFx0aWYgKGV2ZW50LnR5cGUgPT09IFwiZG9uZVwiKSByZXR1cm4gZXZlbnQubWVzc2FnZTtcblx0XHRcdGlmIChldmVudC50eXBlID09PSBcImVycm9yXCIpIHJldHVybiBldmVudC5lcnJvcjtcblx0XHRcdHRocm93IG5ldyBFcnJvcihcIlVuZXhwZWN0ZWQgZXZlbnQgdHlwZSBmb3IgZmluYWwgcmVzdWx0XCIpO1xuXHRcdH0sXG5cdCkgYXMgQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU3RyZWFtIGhhbmRsZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiBzdHJlYW1PbGxhbWFDaGF0KFxuXHRtb2RlbDogTW9kZWw8QXBpPixcblx0Y29udGV4dDogQ29udGV4dCxcblx0b3B0aW9ucz86IFNpbXBsZVN0cmVhbU9wdGlvbnMsXG4pOiBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0ge1xuXHRjb25zdCBzdHJlYW0gPSBjcmVhdGVTdHJlYW0oKTtcblxuXHQoYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IG91dHB1dCA9IGJ1aWxkSW5pdGlhbE91dHB1dChtb2RlbCk7XG5cblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgcmVxdWVzdCA9IGJ1aWxkUmVxdWVzdChtb2RlbCwgY29udGV4dCwgb3B0aW9ucyk7XG5cdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwic3RhcnRcIiwgcGFydGlhbDogb3V0cHV0IH0pO1xuXG5cdFx0XHRjb25zdCB1c2VUaGlua2luZ1BhcnNlciA9IG1vZGVsLnJlYXNvbmluZztcblx0XHRcdGNvbnN0IHRoaW5rUGFyc2VyID0gdXNlVGhpbmtpbmdQYXJzZXIgPyBuZXcgVGhpbmtpbmdUYWdQYXJzZXIoKSA6IG51bGw7XG5cblx0XHRcdGxldCBjb250ZW50SW5kZXggPSAtMTtcblx0XHRcdGxldCBjdXJyZW50QmxvY2tUeXBlOiBcInRleHRcIiB8IFwidGhpbmtpbmdcIiB8IG51bGwgPSBudWxsO1xuXG5cdFx0XHRmdW5jdGlvbiBzdGFydEJsb2NrKHR5cGU6IFwidGV4dFwiIHwgXCJ0aGlua2luZ1wiKSB7XG5cdFx0XHRcdGNvbnRlbnRJbmRleCsrO1xuXHRcdFx0XHRjdXJyZW50QmxvY2tUeXBlID0gdHlwZTtcblx0XHRcdFx0aWYgKHR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0b3V0cHV0LmNvbnRlbnQucHVzaCh7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlwiIH0pO1xuXHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0ZXh0X3N0YXJ0XCIsIGNvbnRlbnRJbmRleCwgcGFydGlhbDogb3V0cHV0IH0pO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdG91dHB1dC5jb250ZW50LnB1c2goeyB0eXBlOiBcInRoaW5raW5nXCIsIHRoaW5raW5nOiBcIlwiIH0pO1xuXHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0aGlua2luZ19zdGFydFwiLCBjb250ZW50SW5kZXgsIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRmdW5jdGlvbiBlbmRCbG9jaygpIHtcblx0XHRcdFx0aWYgKGN1cnJlbnRCbG9ja1R5cGUgPT09IG51bGwpIHJldHVybjtcblx0XHRcdFx0aWYgKGN1cnJlbnRCbG9ja1R5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0Y29uc3QgYmxvY2sgPSBvdXRwdXQuY29udGVudFtjb250ZW50SW5kZXhdIGFzIFRleHRDb250ZW50O1xuXHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0ZXh0X2VuZFwiLCBjb250ZW50SW5kZXgsIGNvbnRlbnQ6IGJsb2NrLnRleHQsIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRjb25zdCBibG9jayA9IG91dHB1dC5jb250ZW50W2NvbnRlbnRJbmRleF0gYXMgVGhpbmtpbmdDb250ZW50O1xuXHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0aGlua2luZ19lbmRcIiwgY29udGVudEluZGV4LCBjb250ZW50OiBibG9jay50aGlua2luZywgcGFydGlhbDogb3V0cHV0IH0pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGN1cnJlbnRCbG9ja1R5cGUgPSBudWxsO1xuXHRcdFx0fVxuXG5cdFx0XHRmdW5jdGlvbiBlbWl0RGVsdGEodHlwZTogXCJ0ZXh0XCIgfCBcInRoaW5raW5nXCIsIHRleHQ6IHN0cmluZykge1xuXHRcdFx0XHRpZiAoIXRleHQpIHJldHVybjtcblx0XHRcdFx0aWYgKGN1cnJlbnRCbG9ja1R5cGUgIT09IHR5cGUpIHtcblx0XHRcdFx0XHRlbmRCbG9jaygpO1xuXHRcdFx0XHRcdHN0YXJ0QmxvY2sodHlwZSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKHR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0KG91dHB1dC5jb250ZW50W2NvbnRlbnRJbmRleF0gYXMgVGV4dENvbnRlbnQpLnRleHQgKz0gdGV4dDtcblx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwidGV4dF9kZWx0YVwiLCBjb250ZW50SW5kZXgsIGRlbHRhOiB0ZXh0LCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0KG91dHB1dC5jb250ZW50W2NvbnRlbnRJbmRleF0gYXMgVGhpbmtpbmdDb250ZW50KS50aGlua2luZyArPSB0ZXh0O1xuXHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0aGlua2luZ19kZWx0YVwiLCBjb250ZW50SW5kZXgsIGRlbHRhOiB0ZXh0LCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0ZnVuY3Rpb24gcHJvY2Vzc0NodW5rcyhjaHVua3M6IFBhcnNlZENodW5rW10pIHtcblx0XHRcdFx0Zm9yIChjb25zdCBjaHVuayBvZiBjaHVua3MpIHtcblx0XHRcdFx0XHRlbWl0RGVsdGEoY2h1bmsudHlwZSwgY2h1bmsudGV4dCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0ZnVuY3Rpb24gcHJvY2Vzc1Rvb2xDYWxscyh0b29sQ2FsbHM6IE9sbGFtYVRvb2xDYWxsW10pIHtcblx0XHRcdFx0ZW5kQmxvY2soKTtcblx0XHRcdFx0Zm9yIChjb25zdCB0YyBvZiB0b29sQ2FsbHMpIHtcblx0XHRcdFx0XHRjb250ZW50SW5kZXgrKztcblx0XHRcdFx0XHRjb25zdCB0b29sQ2FsbDogVG9vbENhbGwgPSB7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRvb2xDYWxsXCIsXG5cdFx0XHRcdFx0XHRpZDogYG9sbGFtYV90Y18ke2NvbnRlbnRJbmRleH1gLFxuXHRcdFx0XHRcdFx0bmFtZTogdGMuZnVuY3Rpb24ubmFtZSxcblx0XHRcdFx0XHRcdGFyZ3VtZW50czogdGMuZnVuY3Rpb24uYXJndW1lbnRzLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0b3V0cHV0LmNvbnRlbnQucHVzaCh0b29sQ2FsbCk7XG5cdFx0XHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInRvb2xjYWxsX3N0YXJ0XCIsIGNvbnRlbnRJbmRleCwgcGFydGlhbDogb3V0cHV0IH0pO1xuXHRcdFx0XHRcdC8vIEVtaXQgYSBkZWx0YSB3aXRoIHRoZSBzZXJpYWxpemVkIGFyZ3VtZW50cyAoY29udmVudGlvbjogc3RhcnQvZGVsdGEvZW5kKVxuXHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdHR5cGU6IFwidG9vbGNhbGxfZGVsdGFcIixcblx0XHRcdFx0XHRcdGNvbnRlbnRJbmRleCxcblx0XHRcdFx0XHRcdGRlbHRhOiBKU09OLnN0cmluZ2lmeSh0Yy5mdW5jdGlvbi5hcmd1bWVudHMpLFxuXHRcdFx0XHRcdFx0cGFydGlhbDogb3V0cHV0LFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdHR5cGU6IFwidG9vbGNhbGxfZW5kXCIsXG5cdFx0XHRcdFx0XHRjb250ZW50SW5kZXgsXG5cdFx0XHRcdFx0XHR0b29sQ2FsbCxcblx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRvdXRwdXQuc3RvcFJlYXNvbiA9IFwidG9vbFVzZVwiO1xuXHRcdFx0fVxuXG5cdFx0XHRmb3IgYXdhaXQgKGNvbnN0IGNodW5rIG9mIGNoYXQocmVxdWVzdCwgb3B0aW9ucz8uc2lnbmFsKSkge1xuXHRcdFx0XHQvLyBIYW5kbGUgdGV4dCBjb250ZW50IFx1MjAxNCBwcm9jZXNzIGluZGVwZW5kZW50bHkgb2YgdG9vbF9jYWxsc1xuXHRcdFx0XHQvLyAoYSBjaHVuayBtYXkgY29udGFpbiBib3RoIGNvbnRlbnQgYW5kIHRvb2xfY2FsbHMpXG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQgPSBjaHVuay5tZXNzYWdlPy5jb250ZW50ID8/IFwiXCI7XG5cdFx0XHRcdGlmIChjb250ZW50KSB7XG5cdFx0XHRcdFx0aWYgKHRoaW5rUGFyc2VyKSB7XG5cdFx0XHRcdFx0XHRwcm9jZXNzQ2h1bmtzKHRoaW5rUGFyc2VyLnB1c2goY29udGVudCkpO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRlbWl0RGVsdGEoXCJ0ZXh0XCIsIGNvbnRlbnQpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIEhhbmRsZSB0b29sIGNhbGxzIChPbGxhbWEgc2VuZHMgdGhlbSBjb21wbGV0ZSwgbWF5IGJlIG9uIGRvbmU6dHJ1ZSBjaHVuaylcblx0XHRcdFx0aWYgKGNodW5rLm1lc3NhZ2U/LnRvb2xfY2FsbHM/Lmxlbmd0aCkge1xuXHRcdFx0XHRcdHByb2Nlc3NUb29sQ2FsbHMoY2h1bmsubWVzc2FnZS50b29sX2NhbGxzKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChjaHVuay5kb25lKSB7XG5cdFx0XHRcdFx0Ly8gRmluYWwgY2h1bmsgXHUyMDE0IGV4dHJhY3QgbWV0cmljcyBhbmQgdXNhZ2Vcblx0XHRcdFx0XHRpZiAodGhpbmtQYXJzZXIpIHByb2Nlc3NDaHVua3ModGhpbmtQYXJzZXIuZmx1c2goKSk7XG5cdFx0XHRcdFx0ZW5kQmxvY2soKTtcblxuXHRcdFx0XHRcdG91dHB1dC51c2FnZSA9IGJ1aWxkVXNhZ2UoY2h1bmspO1xuXHRcdFx0XHRcdG91dHB1dC5pbmZlcmVuY2VNZXRyaWNzID0gZXh0cmFjdE1ldHJpY3MoY2h1bmspO1xuXHRcdFx0XHRcdC8vIFByZXNlcnZlIFwidG9vbFVzZVwiIGlmIHRvb2wgY2FsbHMgd2VyZSBwcm9jZXNzZWRcblx0XHRcdFx0XHRpZiAob3V0cHV0LnN0b3BSZWFzb24gIT09IFwidG9vbFVzZVwiKSB7XG5cdFx0XHRcdFx0XHRvdXRwdXQuc3RvcFJlYXNvbiA9IG1hcFN0b3BSZWFzb24oY2h1bmsuZG9uZV9yZWFzb24pO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRhc3NlcnRTdHJlYW1TdWNjZXNzKG91dHB1dCwgb3B0aW9ucz8uc2lnbmFsKTtcblx0XHRcdGZpbmFsaXplU3RyZWFtKHN0cmVhbSwgb3V0cHV0KTtcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0aGFuZGxlU3RyZWFtRXJyb3Ioc3RyZWFtLCBvdXRwdXQsIGVycm9yLCBvcHRpb25zPy5zaWduYWwpO1xuXHRcdH1cblx0fSkoKTtcblxuXHRyZXR1cm4gc3RyZWFtO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVxdWVzdCBidWlsZGluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gYnVpbGRSZXF1ZXN0KFxuXHRtb2RlbDogTW9kZWw8QXBpPixcblx0Y29udGV4dDogQ29udGV4dCxcblx0b3B0aW9ucz86IFNpbXBsZVN0cmVhbU9wdGlvbnMsXG4pOiBPbGxhbWFDaGF0UmVxdWVzdCB7XG5cdGNvbnN0IG9sbGFtYU9wdHMgPSAobW9kZWwucHJvdmlkZXJPcHRpb25zID8/IHt9KSBhcyBPbGxhbWFDaGF0T3B0aW9ucztcblxuXHRjb25zdCByZXF1ZXN0OiBPbGxhbWFDaGF0UmVxdWVzdCA9IHtcblx0XHRtb2RlbDogbW9kZWwuaWQsXG5cdFx0bWVzc2FnZXM6IGNvbnZlcnRNZXNzYWdlcyhjb250ZXh0KSxcblx0XHRzdHJlYW06IHRydWUsXG5cdH07XG5cblx0Ly8gQnVpbGQgb3B0aW9ucyBibG9jayB3aXRoIGFsbCBPbGxhbWEtc3BlY2lmaWMgcGFyYW1ldGVyc1xuXHRjb25zdCByZXFPcHRpb25zOiBOb25OdWxsYWJsZTxPbGxhbWFDaGF0UmVxdWVzdFtcIm9wdGlvbnNcIl0+ID0ge307XG5cblx0Ly8gQ29udGV4dCB3aW5kb3cgXHUyMDE0IG9ubHkgc2VudCB3aGVuIGV4cGxpY2l0bHkgY29uZmlndXJlZCB2aWEgcHJvdmlkZXJPcHRpb25zLlxuXHQvLyBTZW5kaW5nIGluZmVycmVkL2VzdGltYXRlZCB2YWx1ZXMgcmlza3MgT09NIG9uIGNvbnN0cmFpbmVkIGhvc3RzLlxuXHQvLyBVc2VycyBjYW4gc2V0IG51bV9jdHggcGVyLW1vZGVsIGluIG1vZGVscy5qc29uIG9sbGFtYU9wdGlvbnMgb3IgdGhlXG5cdC8vIGNhcGFiaWxpdHkgdGFibGUgY2FuIHByb3ZpZGUgaXQgZm9yIGtub3duIG1vZGVsIGZhbWlsaWVzLlxuXHRpZiAob2xsYW1hT3B0cy5udW1fY3R4ICE9PSB1bmRlZmluZWQgJiYgb2xsYW1hT3B0cy5udW1fY3R4ID4gMCkge1xuXHRcdHJlcU9wdGlvbnMubnVtX2N0eCA9IG9sbGFtYU9wdHMubnVtX2N0eDtcblx0fVxuXG5cdC8vIE1heCBvdXRwdXQgdG9rZW5zXG5cdGNvbnN0IG1heFRva2VucyA9IG9wdGlvbnM/Lm1heFRva2VucyA/PyBtb2RlbC5tYXhUb2tlbnM7XG5cdGlmIChtYXhUb2tlbnMgPiAwKSB7XG5cdFx0cmVxT3B0aW9ucy5udW1fcHJlZGljdCA9IG1heFRva2Vucztcblx0fVxuXG5cdC8vIFRlbXBlcmF0dXJlXG5cdGlmIChvcHRpb25zPy50ZW1wZXJhdHVyZSAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0cmVxT3B0aW9ucy50ZW1wZXJhdHVyZSA9IG9wdGlvbnMudGVtcGVyYXR1cmU7XG5cdH1cblxuXHQvLyBQZXItbW9kZWwgc2FtcGxpbmcgb3B0aW9ucyBmcm9tIHByb3ZpZGVyT3B0aW9uc1xuXHRpZiAob2xsYW1hT3B0cy50b3BfcCAhPT0gdW5kZWZpbmVkKSByZXFPcHRpb25zLnRvcF9wID0gb2xsYW1hT3B0cy50b3BfcDtcblx0aWYgKG9sbGFtYU9wdHMudG9wX2sgIT09IHVuZGVmaW5lZCkgcmVxT3B0aW9ucy50b3BfayA9IG9sbGFtYU9wdHMudG9wX2s7XG5cdGlmIChvbGxhbWFPcHRzLnJlcGVhdF9wZW5hbHR5ICE9PSB1bmRlZmluZWQpIHJlcU9wdGlvbnMucmVwZWF0X3BlbmFsdHkgPSBvbGxhbWFPcHRzLnJlcGVhdF9wZW5hbHR5O1xuXHRpZiAob2xsYW1hT3B0cy5zZWVkICE9PSB1bmRlZmluZWQpIHJlcU9wdGlvbnMuc2VlZCA9IG9sbGFtYU9wdHMuc2VlZDtcblx0aWYgKG9sbGFtYU9wdHMubnVtX2dwdSAhPT0gdW5kZWZpbmVkKSByZXFPcHRpb25zLm51bV9ncHUgPSBvbGxhbWFPcHRzLm51bV9ncHU7XG5cblx0aWYgKE9iamVjdC5rZXlzKHJlcU9wdGlvbnMpLmxlbmd0aCA+IDApIHtcblx0XHRyZXF1ZXN0Lm9wdGlvbnMgPSByZXFPcHRpb25zO1xuXHR9XG5cblx0Ly8gS2VlcCBhbGl2ZVxuXHRpZiAob2xsYW1hT3B0cy5rZWVwX2FsaXZlICE9PSB1bmRlZmluZWQpIHtcblx0XHRyZXF1ZXN0LmtlZXBfYWxpdmUgPSBvbGxhbWFPcHRzLmtlZXBfYWxpdmU7XG5cdH1cblxuXHQvLyBUb29sc1xuXHRpZiAoY29udGV4dC50b29scz8ubGVuZ3RoKSB7XG5cdFx0cmVxdWVzdC50b29scyA9IGNvbnZlcnRUb29scyhjb250ZXh0LnRvb2xzKTtcblx0fVxuXG5cdHJldHVybiByZXF1ZXN0O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgTWVzc2FnZSBjb252ZXJzaW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBjb252ZXJ0TWVzc2FnZXMoY29udGV4dDogQ29udGV4dCk6IE9sbGFtYUNoYXRNZXNzYWdlW10ge1xuXHRjb25zdCBtZXNzYWdlczogT2xsYW1hQ2hhdE1lc3NhZ2VbXSA9IFtdO1xuXG5cdC8vIFN5c3RlbSBwcm9tcHRcblx0aWYgKGNvbnRleHQuc3lzdGVtUHJvbXB0KSB7XG5cdFx0bWVzc2FnZXMucHVzaCh7IHJvbGU6IFwic3lzdGVtXCIsIGNvbnRlbnQ6IGNvbnRleHQuc3lzdGVtUHJvbXB0IH0pO1xuXHR9XG5cblx0Zm9yIChjb25zdCBtc2cgb2YgY29udGV4dC5tZXNzYWdlcykge1xuXHRcdHN3aXRjaCAobXNnLnJvbGUpIHtcblx0XHRcdGNhc2UgXCJ1c2VyXCI6XG5cdFx0XHRcdG1lc3NhZ2VzLnB1c2goY29udmVydFVzZXJNZXNzYWdlKG1zZykpO1xuXHRcdFx0XHRicmVhaztcblx0XHRcdGNhc2UgXCJhc3Npc3RhbnRcIjpcblx0XHRcdFx0bWVzc2FnZXMucHVzaChjb252ZXJ0QXNzaXN0YW50TWVzc2FnZShtc2cpKTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHRjYXNlIFwidG9vbFJlc3VsdFwiOlxuXHRcdFx0XHRtZXNzYWdlcy5wdXNoKHtcblx0XHRcdFx0XHRyb2xlOiBcInRvb2xcIixcblx0XHRcdFx0XHRjb250ZW50OiBtc2cuY29udGVudFxuXHRcdFx0XHRcdFx0LmZpbHRlcigoYyk6IGMgaXMgVGV4dENvbnRlbnQgPT4gYy50eXBlID09PSBcInRleHRcIilcblx0XHRcdFx0XHRcdC5tYXAoKGMpID0+IGMudGV4dClcblx0XHRcdFx0XHRcdC5qb2luKFwiXFxuXCIpLFxuXHRcdFx0XHRcdG5hbWU6IG1zZy50b29sTmFtZSxcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBtZXNzYWdlcztcbn1cblxuZnVuY3Rpb24gY29udmVydFVzZXJNZXNzYWdlKG1zZzogTWVzc2FnZSAmIHsgcm9sZTogXCJ1c2VyXCIgfSk6IE9sbGFtYUNoYXRNZXNzYWdlIHtcblx0aWYgKHR5cGVvZiBtc2cuY29udGVudCA9PT0gXCJzdHJpbmdcIikge1xuXHRcdHJldHVybiB7IHJvbGU6IFwidXNlclwiLCBjb250ZW50OiBtc2cuY29udGVudCB9O1xuXHR9XG5cblx0Y29uc3QgdGV4dFBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXHRjb25zdCBpbWFnZXM6IHN0cmluZ1tdID0gW107XG5cblx0Zm9yIChjb25zdCBwYXJ0IG9mIG1zZy5jb250ZW50KSB7XG5cdFx0aWYgKHBhcnQudHlwZSA9PT0gXCJ0ZXh0XCIpIHtcblx0XHRcdHRleHRQYXJ0cy5wdXNoKHBhcnQudGV4dCk7XG5cdFx0fSBlbHNlIGlmIChwYXJ0LnR5cGUgPT09IFwiaW1hZ2VcIikge1xuXHRcdFx0Ly8gU3RyaXAgZGF0YSBVUkkgcHJlZml4IGlmIHByZXNlbnRcblx0XHRcdGxldCBkYXRhID0gKHBhcnQgYXMgSW1hZ2VDb250ZW50KS5kYXRhO1xuXHRcdFx0Y29uc3QgY29tbWFJZHggPSBkYXRhLmluZGV4T2YoXCIsXCIpO1xuXHRcdFx0aWYgKGNvbW1hSWR4ICE9PSAtMSAmJiBkYXRhLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkge1xuXHRcdFx0XHRkYXRhID0gZGF0YS5zbGljZShjb21tYUlkeCArIDEpO1xuXHRcdFx0fVxuXHRcdFx0aW1hZ2VzLnB1c2goZGF0YSk7XG5cdFx0fVxuXHR9XG5cblx0Y29uc3QgcmVzdWx0OiBPbGxhbWFDaGF0TWVzc2FnZSA9IHtcblx0XHRyb2xlOiBcInVzZXJcIixcblx0XHRjb250ZW50OiB0ZXh0UGFydHMuam9pbihcIlxcblwiKSxcblx0fTtcblx0aWYgKGltYWdlcy5sZW5ndGggPiAwKSB7XG5cdFx0cmVzdWx0LmltYWdlcyA9IGltYWdlcztcblx0fVxuXHRyZXR1cm4gcmVzdWx0O1xufVxuXG5mdW5jdGlvbiBjb252ZXJ0QXNzaXN0YW50TWVzc2FnZShtc2c6IE1lc3NhZ2UgJiB7IHJvbGU6IFwiYXNzaXN0YW50XCIgfSk6IE9sbGFtYUNoYXRNZXNzYWdlIHtcblx0bGV0IGNvbnRlbnQgPSBcIlwiO1xuXHRjb25zdCB0b29sQ2FsbHM6IE9sbGFtYUNoYXRNZXNzYWdlW1widG9vbF9jYWxsc1wiXSA9IFtdO1xuXG5cdGZvciAoY29uc3QgYmxvY2sgb2YgbXNnLmNvbnRlbnQpIHtcblx0XHRpZiAoYmxvY2sudHlwZSA9PT0gXCJ0aGlua2luZ1wiKSB7XG5cdFx0XHQvLyBTZXJpYWxpemUgdGhpbmtpbmcgYmFjayBpbmxpbmUgZm9yIHJvdW5kLXRyaXAgd2l0aCBPbGxhbWFcblx0XHRcdGNvbnRlbnQgKz0gYDx0aGluaz4keyhibG9jayBhcyBUaGlua2luZ0NvbnRlbnQpLnRoaW5raW5nfTwvdGhpbms+YDtcblx0XHR9IGVsc2UgaWYgKGJsb2NrLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRjb250ZW50ICs9IChibG9jayBhcyBUZXh0Q29udGVudCkudGV4dDtcblx0XHR9IGVsc2UgaWYgKGJsb2NrLnR5cGUgPT09IFwidG9vbENhbGxcIikge1xuXHRcdFx0Y29uc3QgdGMgPSBibG9jayBhcyBUb29sQ2FsbDtcblx0XHRcdHRvb2xDYWxscy5wdXNoKHtcblx0XHRcdFx0ZnVuY3Rpb246IHtcblx0XHRcdFx0XHRuYW1lOiB0Yy5uYW1lLFxuXHRcdFx0XHRcdGFyZ3VtZW50czogdGMuYXJndW1lbnRzLFxuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cdFx0fVxuXHR9XG5cblx0Y29uc3QgcmVzdWx0OiBPbGxhbWFDaGF0TWVzc2FnZSA9IHsgcm9sZTogXCJhc3Npc3RhbnRcIiwgY29udGVudCB9O1xuXHRpZiAodG9vbENhbGxzLmxlbmd0aCA+IDApIHtcblx0XHRyZXN1bHQudG9vbF9jYWxscyA9IHRvb2xDYWxscztcblx0fVxuXHRyZXR1cm4gcmVzdWx0O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVG9vbCBjb252ZXJzaW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBjb252ZXJ0VG9vbHModG9vbHM6IFRvb2xbXSk6IE9sbGFtYVRvb2xbXSB7XG5cdHJldHVybiB0b29scy5tYXAoKHRvb2wpID0+IHtcblx0XHRjb25zdCBwYXJhbXMgPSB0b29sLnBhcmFtZXRlcnMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cdFx0cmV0dXJuIHtcblx0XHRcdHR5cGU6IFwiZnVuY3Rpb25cIiBhcyBjb25zdCxcblx0XHRcdGZ1bmN0aW9uOiB7XG5cdFx0XHRcdG5hbWU6IHRvb2wubmFtZSxcblx0XHRcdFx0ZGVzY3JpcHRpb246IHRvb2wuZGVzY3JpcHRpb24sXG5cdFx0XHRcdHBhcmFtZXRlcnM6IHtcblx0XHRcdFx0XHR0eXBlOiBcIm9iamVjdFwiIGFzIGNvbnN0LFxuXHRcdFx0XHRcdHJlcXVpcmVkOiBwYXJhbXMucmVxdWlyZWQgYXMgc3RyaW5nW10gfCB1bmRlZmluZWQsXG5cdFx0XHRcdFx0cHJvcGVydGllczogKHBhcmFtcy5wcm9wZXJ0aWVzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA/PyB7fSxcblx0XHRcdFx0fSxcblx0XHRcdH0sXG5cdFx0fTtcblx0fSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZXNwb25zZSBtYXBwaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBtYXBTdG9wUmVhc29uKGRvbmVSZWFzb24/OiBzdHJpbmcpOiBTdG9wUmVhc29uIHtcblx0c3dpdGNoIChkb25lUmVhc29uKSB7XG5cdFx0Y2FzZSBcInN0b3BcIjpcblx0XHRcdHJldHVybiBcInN0b3BcIjtcblx0XHRjYXNlIFwibGVuZ3RoXCI6XG5cdFx0XHRyZXR1cm4gXCJsZW5ndGhcIjtcblx0XHRkZWZhdWx0OlxuXHRcdFx0cmV0dXJuIFwic3RvcFwiO1xuXHR9XG59XG5cbmZ1bmN0aW9uIGJ1aWxkVXNhZ2UoY2h1bms6IE9sbGFtYUNoYXRSZXNwb25zZSk6IFVzYWdlIHtcblx0Y29uc3QgaW5wdXQgPSBjaHVuay5wcm9tcHRfZXZhbF9jb3VudCA/PyAwO1xuXHRjb25zdCBvdXRwdXRUb2tlbnMgPSBjaHVuay5ldmFsX2NvdW50ID8/IDA7XG5cdHJldHVybiB7XG5cdFx0aW5wdXQsXG5cdFx0b3V0cHV0OiBvdXRwdXRUb2tlbnMsXG5cdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0dG90YWxUb2tlbnM6IGlucHV0ICsgb3V0cHV0VG9rZW5zLFxuXHRcdGNvc3Q6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbDogMCB9LFxuXHR9O1xufVxuXG5mdW5jdGlvbiBleHRyYWN0TWV0cmljcyhjaHVuazogT2xsYW1hQ2hhdFJlc3BvbnNlKTogSW5mZXJlbmNlTWV0cmljcyB8IHVuZGVmaW5lZCB7XG5cdGlmICghY2h1bmsuZXZhbF9kdXJhdGlvbiAmJiAhY2h1bmsudG90YWxfZHVyYXRpb24pIHJldHVybiB1bmRlZmluZWQ7XG5cblx0Y29uc3QgZXZhbENvdW50ID0gY2h1bmsuZXZhbF9jb3VudCA/PyAwO1xuXHRjb25zdCBldmFsRHVyYXRpb25OcyA9IGNodW5rLmV2YWxfZHVyYXRpb24gPz8gMDtcblx0Y29uc3QgZXZhbER1cmF0aW9uTXMgPSBldmFsRHVyYXRpb25OcyAvIDFlNjtcblx0Y29uc3QgdG9rZW5zUGVyU2Vjb25kID0gZXZhbER1cmF0aW9uTnMgPiAwID8gZXZhbENvdW50IC8gKGV2YWxEdXJhdGlvbk5zIC8gMWU5KSA6IDA7XG5cblx0cmV0dXJuIHtcblx0XHR0b2tlbnNQZXJTZWNvbmQsXG5cdFx0dG90YWxEdXJhdGlvbk1zOiAoY2h1bmsudG90YWxfZHVyYXRpb24gPz8gMCkgLyAxZTYsXG5cdFx0ZXZhbER1cmF0aW9uTXMsXG5cdFx0cHJvbXB0RXZhbER1cmF0aW9uTXM6IChjaHVuay5wcm9tcHRfZXZhbF9kdXJhdGlvbiA/PyAwKSAvIDFlNixcblx0fTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN0cmVhbSBsaWZlY3ljbGUgaGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIFJlcGxpY2F0ZWQgZnJvbSBvcGVuYWktc2hhcmVkLnRzIChub3QgZXhwb3J0ZWQgZnJvbSBAZ3NkL3BpLWFpKVxuXG5mdW5jdGlvbiBidWlsZEluaXRpYWxPdXRwdXQobW9kZWw6IE1vZGVsPEFwaT4pOiBBc3Npc3RhbnRNZXNzYWdlIHtcblx0cmV0dXJuIHtcblx0XHRyb2xlOiBcImFzc2lzdGFudFwiLFxuXHRcdGNvbnRlbnQ6IFtdLFxuXHRcdGFwaTogbW9kZWwuYXBpIGFzIEFwaSxcblx0XHRwcm92aWRlcjogbW9kZWwucHJvdmlkZXIsXG5cdFx0bW9kZWw6IG1vZGVsLmlkLFxuXHRcdHVzYWdlOiB7XG5cdFx0XHRpbnB1dDogMCxcblx0XHRcdG91dHB1dDogMCxcblx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR0b3RhbFRva2VuczogMCxcblx0XHRcdGNvc3Q6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbDogMCB9LFxuXHRcdH0sXG5cdFx0c3RvcFJlYXNvbjogXCJzdG9wXCIsXG5cdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHR9O1xufVxuXG5mdW5jdGlvbiBhc3NlcnRTdHJlYW1TdWNjZXNzKG91dHB1dDogQXNzaXN0YW50TWVzc2FnZSwgc2lnbmFsPzogQWJvcnRTaWduYWwpOiB2b2lkIHtcblx0aWYgKHNpZ25hbD8uYWJvcnRlZCkge1xuXHRcdHRocm93IG5ldyBFcnJvcihcIlJlcXVlc3Qgd2FzIGFib3J0ZWRcIik7XG5cdH1cblx0aWYgKG91dHB1dC5zdG9wUmVhc29uID09PSBcImFib3J0ZWRcIiB8fCBvdXRwdXQuc3RvcFJlYXNvbiA9PT0gXCJlcnJvclwiKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKFwiQW4gdW5rbm93biBlcnJvciBvY2N1cnJlZFwiKTtcblx0fVxufVxuXG5mdW5jdGlvbiBmaW5hbGl6ZVN0cmVhbShzdHJlYW06IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSwgb3V0cHV0OiBBc3Npc3RhbnRNZXNzYWdlKTogdm9pZCB7XG5cdHN0cmVhbS5wdXNoKHtcblx0XHR0eXBlOiBcImRvbmVcIixcblx0XHRyZWFzb246IG91dHB1dC5zdG9wUmVhc29uIGFzIEV4dHJhY3Q8U3RvcFJlYXNvbiwgXCJzdG9wXCIgfCBcImxlbmd0aFwiIHwgXCJ0b29sVXNlXCIgfCBcInBhdXNlVHVyblwiPixcblx0XHRtZXNzYWdlOiBvdXRwdXQsXG5cdH0pO1xuXHRzdHJlYW0uZW5kKCk7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZVN0cmVhbUVycm9yKFxuXHRzdHJlYW06IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSxcblx0b3V0cHV0OiBBc3Npc3RhbnRNZXNzYWdlLFxuXHRlcnJvcjogdW5rbm93bixcblx0c2lnbmFsPzogQWJvcnRTaWduYWwsXG4pOiB2b2lkIHtcblx0Zm9yIChjb25zdCBibG9jayBvZiBvdXRwdXQuY29udGVudCkgZGVsZXRlIChibG9jayBhcyB7IGluZGV4PzogbnVtYmVyIH0pLmluZGV4O1xuXHRvdXRwdXQuc3RvcFJlYXNvbiA9IHNpZ25hbD8uYWJvcnRlZCA/IFwiYWJvcnRlZFwiIDogXCJlcnJvclwiO1xuXHRvdXRwdXQuZXJyb3JNZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBKU09OLnN0cmluZ2lmeShlcnJvcik7XG5cdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJlcnJvclwiLCByZWFzb246IG91dHB1dC5zdG9wUmVhc29uLCBlcnJvcjogb3V0cHV0IH0pO1xuXHRzdHJlYW0uZW5kKCk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFTQTtBQUFBLEVBaUJDO0FBQUEsT0FDTTtBQUNQLFNBQVMsWUFBWTtBQVNyQixTQUFTLHlCQUEyQztBQUdwRCxTQUFTLGVBQTRDO0FBQ3BELFNBQU8sSUFBSTtBQUFBLElBQ1YsQ0FBQyxVQUFVLE1BQU0sU0FBUyxVQUFVLE1BQU0sU0FBUztBQUFBLElBQ25ELENBQUMsVUFBVTtBQUNWLFVBQUksTUFBTSxTQUFTLE9BQVEsUUFBTyxNQUFNO0FBQ3hDLFVBQUksTUFBTSxTQUFTLFFBQVMsUUFBTyxNQUFNO0FBQ3pDLFlBQU0sSUFBSSxNQUFNLHdDQUF3QztBQUFBLElBQ3pEO0FBQUEsRUFDRDtBQUNEO0FBSU8sU0FBUyxpQkFDZixPQUNBLFNBQ0EsU0FDOEI7QUFDOUIsUUFBTSxTQUFTLGFBQWE7QUFFNUIsR0FBQyxZQUFZO0FBQ1osVUFBTSxTQUFTLG1CQUFtQixLQUFLO0FBRXZDLFFBQUk7QUFVSCxVQUFTQSxjQUFULFNBQW9CLE1BQTJCO0FBQzlD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QzVDO0FBQ0Q7QUFFQSxTQUFTLGVBQWUsUUFBcUMsUUFBZ0M7QUFDNUYsU0FBTyxLQUFLO0FBQUEsSUFDWCxNQUFNO0FBQUEsSUFDTixRQUFRLE9BQU87QUFBQSxJQUNmLFNBQVM7QUFBQSxFQUNWLENBQUM7QUFDRCxTQUFPLElBQUk7QUFDWjtBQUVBLFNBQVMsa0JBQ1IsUUFDQSxRQUNBLE9BQ0EsUUFDTztBQUNQLGFBQVcsU0FBUyxPQUFPLFFBQVMsUUFBUSxNQUE2QjtBQUN6RSxTQUFPLGFBQWEsUUFBUSxVQUFVLFlBQVk7QUFDbEQsU0FBTyxlQUFlLGlCQUFpQixRQUFRLE1BQU0sVUFBVSxLQUFLLFVBQVUsS0FBSztBQUNuRixTQUFPLEtBQUssRUFBRSxNQUFNLFNBQVMsUUFBUSxPQUFPLFlBQVksT0FBTyxPQUFPLENBQUM7QUFDdkUsU0FBTyxJQUFJO0FBQ1o7IiwKICAibmFtZXMiOiBbInN0YXJ0QmxvY2siLCAiZW5kQmxvY2siLCAiZW1pdERlbHRhIiwgInByb2Nlc3NDaHVua3MiLCAicHJvY2Vzc1Rvb2xDYWxscyJdCn0K
