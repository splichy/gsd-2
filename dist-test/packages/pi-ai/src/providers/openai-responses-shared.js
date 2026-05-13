import { calculateCost } from "../models.js";
import { shortHash } from "../utils/hash.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessagesWithReport } from "./transform-messages.js";
function encodeTextSignatureV1(id, phase) {
  const payload = { v: 1, id };
  if (phase) payload.phase = phase;
  return JSON.stringify(payload);
}
function parseTextSignature(signature) {
  if (!signature) return void 0;
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature);
      if (parsed.v === 1 && typeof parsed.id === "string") {
        if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
          return { id: parsed.id, phase: parsed.phase };
        }
        return { id: parsed.id };
      }
    } catch {
    }
  }
  return { id: signature };
}
function convertResponsesMessages(model, context, allowedToolCallProviders, options) {
  const messages = [];
  const normalizeToolCallId = (id) => {
    if (!allowedToolCallProviders.has(model.provider)) return id;
    if (!id.includes("|")) return id;
    const [callId, itemId] = id.split("|");
    const sanitizedCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
    let sanitizedItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!sanitizedItemId.startsWith("fc")) {
      sanitizedItemId = `fc_${sanitizedItemId}`;
    }
    let normalizedCallId = sanitizedCallId.length > 64 ? sanitizedCallId.slice(0, 64) : sanitizedCallId;
    let normalizedItemId = sanitizedItemId.length > 64 ? sanitizedItemId.slice(0, 64) : sanitizedItemId;
    normalizedCallId = normalizedCallId.replace(/_+$/, "");
    normalizedItemId = normalizedItemId.replace(/_+$/, "");
    return `${normalizedCallId}|${normalizedItemId}`;
  };
  const transformedMessages = transformMessagesWithReport(context.messages, model, normalizeToolCallId, "openai-responses");
  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    const role = model.reasoning ? "developer" : "system";
    messages.push({
      role,
      content: sanitizeSurrogates(context.systemPrompt)
    });
  }
  let msgIndex = 0;
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({
          role: "user",
          content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }]
        });
      } else {
        const content = msg.content.map((item) => {
          if (item.type === "text") {
            return {
              type: "input_text",
              text: sanitizeSurrogates(item.text)
            };
          }
          return {
            type: "input_image",
            detail: "auto",
            image_url: `data:${item.mimeType};base64,${item.data}`
          };
        });
        const filteredContent = !model.input.includes("image") ? content.filter((c) => c.type !== "input_image") : content;
        if (filteredContent.length === 0) continue;
        messages.push({
          role: "user",
          content: filteredContent
        });
      }
    } else if (msg.role === "assistant") {
      const output = [];
      const assistantMsg = msg;
      const isDifferentModel = assistantMsg.model !== model.id && assistantMsg.provider === model.provider && assistantMsg.api === model.api;
      for (const block of msg.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            const reasoningItem = JSON.parse(block.thinkingSignature);
            output.push(reasoningItem);
          }
        } else if (block.type === "text") {
          const textBlock = block;
          const parsedSignature = parseTextSignature(textBlock.textSignature);
          let msgId = parsedSignature?.id;
          if (!msgId) {
            msgId = `msg_${msgIndex}`;
          } else if (msgId.length > 64) {
            msgId = `msg_${shortHash(msgId)}`;
          }
          output.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
            status: "completed",
            id: msgId,
            phase: parsedSignature?.phase
          });
        } else if (block.type === "toolCall") {
          const toolCall = block;
          const [callId, itemIdRaw] = toolCall.id.split("|");
          let itemId = itemIdRaw;
          if (isDifferentModel && itemId?.startsWith("fc_")) {
            itemId = void 0;
          }
          output.push({
            type: "function_call",
            id: itemId,
            call_id: callId,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments)
          });
        }
      }
      if (output.length === 0) continue;
      messages.push(...output);
    } else if (msg.role === "toolResult") {
      const textResult = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const hasImages = msg.content.some((c) => c.type === "image");
      const hasText = textResult.length > 0;
      const [callId] = msg.toolCallId.split("|");
      messages.push({
        type: "function_call_output",
        call_id: callId,
        output: sanitizeSurrogates(hasText ? textResult : "(see attached image)")
      });
      if (hasImages && model.input.includes("image")) {
        const contentParts = [];
        contentParts.push({
          type: "input_text",
          text: "Attached image(s) from tool result:"
        });
        for (const block of msg.content) {
          if (block.type === "image") {
            contentParts.push({
              type: "input_image",
              detail: "auto",
              image_url: `data:${block.mimeType};base64,${block.data}`
            });
          }
        }
        messages.push({
          role: "user",
          content: contentParts
        });
      }
    }
    msgIndex++;
  }
  return messages;
}
function convertResponsesTools(tools, options) {
  const strict = options?.strict === void 0 ? false : options.strict;
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    // TypeBox already generates JSON Schema
    strict
  }));
}
async function processResponsesStream(openaiStream, output, stream, model, options) {
  let currentItem = null;
  let currentBlock = null;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;
  for await (const event of openaiStream) {
    if (event.type === "response.output_item.added") {
      const item = event.item;
      if (item.type === "reasoning") {
        currentItem = item;
        currentBlock = { type: "thinking", thinking: "" };
        output.content.push(currentBlock);
        stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "message") {
        currentItem = item;
        currentBlock = { type: "text", text: "" };
        output.content.push(currentBlock);
        stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
      } else if (item.type === "function_call") {
        currentItem = item;
        currentBlock = {
          type: "toolCall",
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: {},
          partialJson: item.arguments || ""
        };
        output.content.push(currentBlock);
        stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
      }
    } else if (event.type === "response.reasoning_summary_part.added") {
      if (currentItem && currentItem.type === "reasoning") {
        currentItem.summary = currentItem.summary || [];
        currentItem.summary.push(event.part);
      }
    } else if (event.type === "response.reasoning_summary_text.delta") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += event.delta;
          lastPart.text += event.delta;
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output
          });
        }
      }
    } else if (event.type === "response.reasoning_summary_part.done") {
      if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
        currentItem.summary = currentItem.summary || [];
        const lastPart = currentItem.summary[currentItem.summary.length - 1];
        if (lastPart) {
          currentBlock.thinking += "\n\n";
          lastPart.text += "\n\n";
          stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: "\n\n",
            partial: output
          });
        }
      }
    } else if (event.type === "response.content_part.added") {
      if (currentItem?.type === "message") {
        currentItem.content = currentItem.content || [];
        if (event.part.type === "output_text" || event.part.type === "refusal") {
          currentItem.content.push(event.part);
        }
      }
    } else if (event.type === "response.output_text.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        if (!currentItem.content || currentItem.content.length === 0) {
          continue;
        }
        const lastPart = currentItem.content[currentItem.content.length - 1];
        if (lastPart?.type === "output_text") {
          currentBlock.text += event.delta;
          lastPart.text += event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output
          });
        }
      }
    } else if (event.type === "response.refusal.delta") {
      if (currentItem?.type === "message" && currentBlock?.type === "text") {
        if (!currentItem.content || currentItem.content.length === 0) {
          continue;
        }
        const lastPart = currentItem.content[currentItem.content.length - 1];
        if (lastPart?.type === "refusal") {
          currentBlock.text += event.delta;
          lastPart.refusal += event.delta;
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: event.delta,
            partial: output
          });
        }
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson += event.delta;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
        stream.push({
          type: "toolcall_delta",
          contentIndex: blockIndex(),
          delta: event.delta,
          partial: output
        });
      }
    } else if (event.type === "response.function_call_arguments.done") {
      if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
        currentBlock.partialJson = event.arguments;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);
      }
    } else if (event.type === "response.output_item.done") {
      const item = event.item;
      if (item.type === "reasoning" && currentBlock?.type === "thinking") {
        currentBlock.thinking = item.summary?.map((s) => s.text).join("\n\n") || "";
        currentBlock.thinkingSignature = JSON.stringify(item);
        stream.push({
          type: "thinking_end",
          contentIndex: blockIndex(),
          content: currentBlock.thinking,
          partial: output
        });
        currentBlock = null;
      } else if (item.type === "message" && currentBlock?.type === "text") {
        currentBlock.text = item.content.map((c) => c.type === "output_text" ? c.text : c.refusal).join("");
        currentBlock.textSignature = encodeTextSignatureV1(item.id, item.phase ?? void 0);
        stream.push({
          type: "text_end",
          contentIndex: blockIndex(),
          content: currentBlock.text,
          partial: output
        });
        currentBlock = null;
      } else if (item.type === "function_call") {
        const args = currentBlock?.type === "toolCall" && currentBlock.partialJson ? parseStreamingJson(currentBlock.partialJson) : parseStreamingJson(item.arguments || "{}");
        const toolCall = {
          type: "toolCall",
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: args
        };
        currentBlock = null;
        stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
      }
    } else if (event.type === "response.completed") {
      const response = event.response;
      if (response?.usage) {
        const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
        output.usage = {
          // OpenAI includes cached tokens in input_tokens, so subtract to get non-cached input
          input: (response.usage.input_tokens || 0) - cachedTokens,
          output: response.usage.output_tokens || 0,
          cacheRead: cachedTokens,
          cacheWrite: 0,
          totalTokens: response.usage.total_tokens || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        };
      }
      calculateCost(model, output.usage);
      if (options?.applyServiceTierPricing) {
        const serviceTier = response?.service_tier ?? options.serviceTier;
        options.applyServiceTierPricing(output.usage, serviceTier);
      }
      output.stopReason = mapStopReason(response?.status);
      if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
        output.stopReason = "toolUse";
      }
    } else if (event.type === "error") {
      throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
    } else if (event.type === "response.failed") {
      throw new Error("Unknown error");
    }
  }
}
function mapStopReason(status) {
  if (!status) return "stop";
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
    case "cancelled":
      return "error";
    // These two are wonky ...
    case "in_progress":
    case "queued":
      return "stop";
    default: {
      const _exhaustive = status;
      throw new Error(`Unhandled stop reason: ${_exhaustive}`);
    }
  }
}
export {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3Byb3ZpZGVycy9vcGVuYWktcmVzcG9uc2VzLXNoYXJlZC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgT3BlbkFJIGZyb20gXCJvcGVuYWlcIjtcbmltcG9ydCB0eXBlIHtcblx0VG9vbCBhcyBPcGVuQUlUb29sLFxuXHRSZXNwb25zZUNyZWF0ZVBhcmFtc1N0cmVhbWluZyxcblx0UmVzcG9uc2VGdW5jdGlvblRvb2xDYWxsLFxuXHRSZXNwb25zZUlucHV0LFxuXHRSZXNwb25zZUlucHV0Q29udGVudCxcblx0UmVzcG9uc2VJbnB1dEltYWdlLFxuXHRSZXNwb25zZUlucHV0VGV4dCxcblx0UmVzcG9uc2VPdXRwdXRNZXNzYWdlLFxuXHRSZXNwb25zZVJlYXNvbmluZ0l0ZW0sXG5cdFJlc3BvbnNlU3RyZWFtRXZlbnQsXG59IGZyb20gXCJvcGVuYWkvcmVzb3VyY2VzL3Jlc3BvbnNlcy9yZXNwb25zZXMuanNcIjtcbmltcG9ydCB7IGNhbGN1bGF0ZUNvc3QgfSBmcm9tIFwiLi4vbW9kZWxzLmpzXCI7XG5pbXBvcnQgdHlwZSB7XG5cdEFwaSxcblx0QXNzaXN0YW50TWVzc2FnZSxcblx0Q29udGV4dCxcblx0SW1hZ2VDb250ZW50LFxuXHRNb2RlbCxcblx0U3RvcFJlYXNvbixcblx0VGV4dENvbnRlbnQsXG5cdFRleHRTaWduYXR1cmVWMSxcblx0VGhpbmtpbmdDb250ZW50LFxuXHRUb29sLFxuXHRUb29sQ2FsbCxcblx0VXNhZ2UsXG59IGZyb20gXCIuLi90eXBlcy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0gfSBmcm9tIFwiLi4vdXRpbHMvZXZlbnQtc3RyZWFtLmpzXCI7XG5pbXBvcnQgeyBzaG9ydEhhc2ggfSBmcm9tIFwiLi4vdXRpbHMvaGFzaC5qc1wiO1xuaW1wb3J0IHsgcGFyc2VTdHJlYW1pbmdKc29uIH0gZnJvbSBcIi4uL3V0aWxzL2pzb24tcGFyc2UuanNcIjtcbmltcG9ydCB7IHNhbml0aXplU3Vycm9nYXRlcyB9IGZyb20gXCIuLi91dGlscy9zYW5pdGl6ZS11bmljb2RlLmpzXCI7XG5pbXBvcnQgeyB0cmFuc2Zvcm1NZXNzYWdlc1dpdGhSZXBvcnQgfSBmcm9tIFwiLi90cmFuc2Zvcm0tbWVzc2FnZXMuanNcIjtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFV0aWxpdGllc1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZnVuY3Rpb24gZW5jb2RlVGV4dFNpZ25hdHVyZVYxKGlkOiBzdHJpbmcsIHBoYXNlPzogVGV4dFNpZ25hdHVyZVYxW1wicGhhc2VcIl0pOiBzdHJpbmcge1xuXHRjb25zdCBwYXlsb2FkOiBUZXh0U2lnbmF0dXJlVjEgPSB7IHY6IDEsIGlkIH07XG5cdGlmIChwaGFzZSkgcGF5bG9hZC5waGFzZSA9IHBoYXNlO1xuXHRyZXR1cm4gSlNPTi5zdHJpbmdpZnkocGF5bG9hZCk7XG59XG5cbmZ1bmN0aW9uIHBhcnNlVGV4dFNpZ25hdHVyZShcblx0c2lnbmF0dXJlOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4pOiB7IGlkOiBzdHJpbmc7IHBoYXNlPzogVGV4dFNpZ25hdHVyZVYxW1wicGhhc2VcIl0gfSB8IHVuZGVmaW5lZCB7XG5cdGlmICghc2lnbmF0dXJlKSByZXR1cm4gdW5kZWZpbmVkO1xuXHRpZiAoc2lnbmF0dXJlLnN0YXJ0c1dpdGgoXCJ7XCIpKSB7XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2Uoc2lnbmF0dXJlKSBhcyBQYXJ0aWFsPFRleHRTaWduYXR1cmVWMT47XG5cdFx0XHRpZiAocGFyc2VkLnYgPT09IDEgJiYgdHlwZW9mIHBhcnNlZC5pZCA9PT0gXCJzdHJpbmdcIikge1xuXHRcdFx0XHRpZiAocGFyc2VkLnBoYXNlID09PSBcImNvbW1lbnRhcnlcIiB8fCBwYXJzZWQucGhhc2UgPT09IFwiZmluYWxfYW5zd2VyXCIpIHtcblx0XHRcdFx0XHRyZXR1cm4geyBpZDogcGFyc2VkLmlkLCBwaGFzZTogcGFyc2VkLnBoYXNlIH07XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIHsgaWQ6IHBhcnNlZC5pZCB9O1xuXHRcdFx0fVxuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gRmFsbCB0aHJvdWdoIHRvIGxlZ2FjeSBwbGFpbi1zdHJpbmcgaGFuZGxpbmcuXG5cdFx0fVxuXHR9XG5cdHJldHVybiB7IGlkOiBzaWduYXR1cmUgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBPcGVuQUlSZXNwb25zZXNTdHJlYW1PcHRpb25zIHtcblx0c2VydmljZVRpZXI/OiBSZXNwb25zZUNyZWF0ZVBhcmFtc1N0cmVhbWluZ1tcInNlcnZpY2VfdGllclwiXTtcblx0YXBwbHlTZXJ2aWNlVGllclByaWNpbmc/OiAoXG5cdFx0dXNhZ2U6IFVzYWdlLFxuXHRcdHNlcnZpY2VUaWVyOiBSZXNwb25zZUNyZWF0ZVBhcmFtc1N0cmVhbWluZ1tcInNlcnZpY2VfdGllclwiXSB8IHVuZGVmaW5lZCxcblx0KSA9PiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbnZlcnRSZXNwb25zZXNNZXNzYWdlc09wdGlvbnMge1xuXHRpbmNsdWRlU3lzdGVtUHJvbXB0PzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb252ZXJ0UmVzcG9uc2VzVG9vbHNPcHRpb25zIHtcblx0c3RyaWN0PzogYm9vbGVhbiB8IG51bGw7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBNZXNzYWdlIGNvbnZlcnNpb25cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmV4cG9ydCBmdW5jdGlvbiBjb252ZXJ0UmVzcG9uc2VzTWVzc2FnZXM8VEFwaSBleHRlbmRzIEFwaT4oXG5cdG1vZGVsOiBNb2RlbDxUQXBpPixcblx0Y29udGV4dDogQ29udGV4dCxcblx0YWxsb3dlZFRvb2xDYWxsUHJvdmlkZXJzOiBSZWFkb25seVNldDxzdHJpbmc+LFxuXHRvcHRpb25zPzogQ29udmVydFJlc3BvbnNlc01lc3NhZ2VzT3B0aW9ucyxcbik6IFJlc3BvbnNlSW5wdXQge1xuXHRjb25zdCBtZXNzYWdlczogUmVzcG9uc2VJbnB1dCA9IFtdO1xuXG5cdGNvbnN0IG5vcm1hbGl6ZVRvb2xDYWxsSWQgPSAoaWQ6IHN0cmluZyk6IHN0cmluZyA9PiB7XG5cdFx0aWYgKCFhbGxvd2VkVG9vbENhbGxQcm92aWRlcnMuaGFzKG1vZGVsLnByb3ZpZGVyKSkgcmV0dXJuIGlkO1xuXHRcdGlmICghaWQuaW5jbHVkZXMoXCJ8XCIpKSByZXR1cm4gaWQ7XG5cdFx0Y29uc3QgW2NhbGxJZCwgaXRlbUlkXSA9IGlkLnNwbGl0KFwifFwiKTtcblx0XHRjb25zdCBzYW5pdGl6ZWRDYWxsSWQgPSBjYWxsSWQucmVwbGFjZSgvW15hLXpBLVowLTlfLV0vZywgXCJfXCIpO1xuXHRcdGxldCBzYW5pdGl6ZWRJdGVtSWQgPSBpdGVtSWQucmVwbGFjZSgvW15hLXpBLVowLTlfLV0vZywgXCJfXCIpO1xuXHRcdC8vIE9wZW5BSSBSZXNwb25zZXMgQVBJIHJlcXVpcmVzIGl0ZW0gaWQgdG8gc3RhcnQgd2l0aCBcImZjXCJcblx0XHRpZiAoIXNhbml0aXplZEl0ZW1JZC5zdGFydHNXaXRoKFwiZmNcIikpIHtcblx0XHRcdHNhbml0aXplZEl0ZW1JZCA9IGBmY18ke3Nhbml0aXplZEl0ZW1JZH1gO1xuXHRcdH1cblx0XHQvLyBUcnVuY2F0ZSB0byA2NCBjaGFycyBhbmQgc3RyaXAgdHJhaWxpbmcgdW5kZXJzY29yZXMgKE9wZW5BSSBDb2RleCByZWplY3RzIHRoZW0pXG5cdFx0bGV0IG5vcm1hbGl6ZWRDYWxsSWQgPSBzYW5pdGl6ZWRDYWxsSWQubGVuZ3RoID4gNjQgPyBzYW5pdGl6ZWRDYWxsSWQuc2xpY2UoMCwgNjQpIDogc2FuaXRpemVkQ2FsbElkO1xuXHRcdGxldCBub3JtYWxpemVkSXRlbUlkID0gc2FuaXRpemVkSXRlbUlkLmxlbmd0aCA+IDY0ID8gc2FuaXRpemVkSXRlbUlkLnNsaWNlKDAsIDY0KSA6IHNhbml0aXplZEl0ZW1JZDtcblx0XHRub3JtYWxpemVkQ2FsbElkID0gbm9ybWFsaXplZENhbGxJZC5yZXBsYWNlKC9fKyQvLCBcIlwiKTtcblx0XHRub3JtYWxpemVkSXRlbUlkID0gbm9ybWFsaXplZEl0ZW1JZC5yZXBsYWNlKC9fKyQvLCBcIlwiKTtcblx0XHRyZXR1cm4gYCR7bm9ybWFsaXplZENhbGxJZH18JHtub3JtYWxpemVkSXRlbUlkfWA7XG5cdH07XG5cblx0Y29uc3QgdHJhbnNmb3JtZWRNZXNzYWdlcyA9IHRyYW5zZm9ybU1lc3NhZ2VzV2l0aFJlcG9ydChjb250ZXh0Lm1lc3NhZ2VzLCBtb2RlbCwgbm9ybWFsaXplVG9vbENhbGxJZCwgXCJvcGVuYWktcmVzcG9uc2VzXCIpO1xuXG5cdGNvbnN0IGluY2x1ZGVTeXN0ZW1Qcm9tcHQgPSBvcHRpb25zPy5pbmNsdWRlU3lzdGVtUHJvbXB0ID8/IHRydWU7XG5cdGlmIChpbmNsdWRlU3lzdGVtUHJvbXB0ICYmIGNvbnRleHQuc3lzdGVtUHJvbXB0KSB7XG5cdFx0Y29uc3Qgcm9sZSA9IG1vZGVsLnJlYXNvbmluZyA/IFwiZGV2ZWxvcGVyXCIgOiBcInN5c3RlbVwiO1xuXHRcdG1lc3NhZ2VzLnB1c2goe1xuXHRcdFx0cm9sZSxcblx0XHRcdGNvbnRlbnQ6IHNhbml0aXplU3Vycm9nYXRlcyhjb250ZXh0LnN5c3RlbVByb21wdCksXG5cdFx0fSk7XG5cdH1cblxuXHRsZXQgbXNnSW5kZXggPSAwO1xuXHRmb3IgKGNvbnN0IG1zZyBvZiB0cmFuc2Zvcm1lZE1lc3NhZ2VzKSB7XG5cdFx0aWYgKG1zZy5yb2xlID09PSBcInVzZXJcIikge1xuXHRcdFx0aWYgKHR5cGVvZiBtc2cuY29udGVudCA9PT0gXCJzdHJpbmdcIikge1xuXHRcdFx0XHRtZXNzYWdlcy5wdXNoKHtcblx0XHRcdFx0XHRyb2xlOiBcInVzZXJcIixcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcImlucHV0X3RleHRcIiwgdGV4dDogc2FuaXRpemVTdXJyb2dhdGVzKG1zZy5jb250ZW50KSB9XSxcblx0XHRcdFx0fSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRjb25zdCBjb250ZW50OiBSZXNwb25zZUlucHV0Q29udGVudFtdID0gbXNnLmNvbnRlbnQubWFwKChpdGVtKTogUmVzcG9uc2VJbnB1dENvbnRlbnQgPT4ge1xuXHRcdFx0XHRcdGlmIChpdGVtLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHR0eXBlOiBcImlucHV0X3RleHRcIixcblx0XHRcdFx0XHRcdFx0dGV4dDogc2FuaXRpemVTdXJyb2dhdGVzKGl0ZW0udGV4dCksXG5cdFx0XHRcdFx0XHR9IHNhdGlzZmllcyBSZXNwb25zZUlucHV0VGV4dDtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdHR5cGU6IFwiaW5wdXRfaW1hZ2VcIixcblx0XHRcdFx0XHRcdGRldGFpbDogXCJhdXRvXCIsXG5cdFx0XHRcdFx0XHRpbWFnZV91cmw6IGBkYXRhOiR7aXRlbS5taW1lVHlwZX07YmFzZTY0LCR7aXRlbS5kYXRhfWAsXG5cdFx0XHRcdFx0fSBzYXRpc2ZpZXMgUmVzcG9uc2VJbnB1dEltYWdlO1xuXHRcdFx0XHR9KTtcblx0XHRcdFx0Y29uc3QgZmlsdGVyZWRDb250ZW50ID0gIW1vZGVsLmlucHV0LmluY2x1ZGVzKFwiaW1hZ2VcIilcblx0XHRcdFx0XHQ/IGNvbnRlbnQuZmlsdGVyKChjKSA9PiBjLnR5cGUgIT09IFwiaW5wdXRfaW1hZ2VcIilcblx0XHRcdFx0XHQ6IGNvbnRlbnQ7XG5cdFx0XHRcdGlmIChmaWx0ZXJlZENvbnRlbnQubGVuZ3RoID09PSAwKSBjb250aW51ZTtcblx0XHRcdFx0bWVzc2FnZXMucHVzaCh7XG5cdFx0XHRcdFx0cm9sZTogXCJ1c2VyXCIsXG5cdFx0XHRcdFx0Y29udGVudDogZmlsdGVyZWRDb250ZW50LFxuXHRcdFx0XHR9KTtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKG1zZy5yb2xlID09PSBcImFzc2lzdGFudFwiKSB7XG5cdFx0XHRjb25zdCBvdXRwdXQ6IFJlc3BvbnNlSW5wdXQgPSBbXTtcblx0XHRcdGNvbnN0IGFzc2lzdGFudE1zZyA9IG1zZyBhcyBBc3Npc3RhbnRNZXNzYWdlO1xuXHRcdFx0Y29uc3QgaXNEaWZmZXJlbnRNb2RlbCA9XG5cdFx0XHRcdGFzc2lzdGFudE1zZy5tb2RlbCAhPT0gbW9kZWwuaWQgJiZcblx0XHRcdFx0YXNzaXN0YW50TXNnLnByb3ZpZGVyID09PSBtb2RlbC5wcm92aWRlciAmJlxuXHRcdFx0XHRhc3Npc3RhbnRNc2cuYXBpID09PSBtb2RlbC5hcGk7XG5cblx0XHRcdGZvciAoY29uc3QgYmxvY2sgb2YgbXNnLmNvbnRlbnQpIHtcblx0XHRcdFx0aWYgKGJsb2NrLnR5cGUgPT09IFwidGhpbmtpbmdcIikge1xuXHRcdFx0XHRcdGlmIChibG9jay50aGlua2luZ1NpZ25hdHVyZSkge1xuXHRcdFx0XHRcdFx0Y29uc3QgcmVhc29uaW5nSXRlbSA9IEpTT04ucGFyc2UoYmxvY2sudGhpbmtpbmdTaWduYXR1cmUpIGFzIFJlc3BvbnNlUmVhc29uaW5nSXRlbTtcblx0XHRcdFx0XHRcdG91dHB1dC5wdXNoKHJlYXNvbmluZ0l0ZW0pO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBlbHNlIGlmIChibG9jay50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHRcdGNvbnN0IHRleHRCbG9jayA9IGJsb2NrIGFzIFRleHRDb250ZW50O1xuXHRcdFx0XHRcdGNvbnN0IHBhcnNlZFNpZ25hdHVyZSA9IHBhcnNlVGV4dFNpZ25hdHVyZSh0ZXh0QmxvY2sudGV4dFNpZ25hdHVyZSk7XG5cdFx0XHRcdFx0Ly8gT3BlbkFJIHJlcXVpcmVzIGlkIHRvIGJlIG1heCA2NCBjaGFyYWN0ZXJzXG5cdFx0XHRcdFx0bGV0IG1zZ0lkID0gcGFyc2VkU2lnbmF0dXJlPy5pZDtcblx0XHRcdFx0XHRpZiAoIW1zZ0lkKSB7XG5cdFx0XHRcdFx0XHRtc2dJZCA9IGBtc2dfJHttc2dJbmRleH1gO1xuXHRcdFx0XHRcdH0gZWxzZSBpZiAobXNnSWQubGVuZ3RoID4gNjQpIHtcblx0XHRcdFx0XHRcdG1zZ0lkID0gYG1zZ18ke3Nob3J0SGFzaChtc2dJZCl9YDtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0b3V0cHV0LnB1c2goe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJtZXNzYWdlXCIsXG5cdFx0XHRcdFx0XHRyb2xlOiBcImFzc2lzdGFudFwiLFxuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJvdXRwdXRfdGV4dFwiLCB0ZXh0OiBzYW5pdGl6ZVN1cnJvZ2F0ZXModGV4dEJsb2NrLnRleHQpLCBhbm5vdGF0aW9uczogW10gfV0sXG5cdFx0XHRcdFx0XHRzdGF0dXM6IFwiY29tcGxldGVkXCIsXG5cdFx0XHRcdFx0XHRpZDogbXNnSWQsXG5cdFx0XHRcdFx0XHRwaGFzZTogcGFyc2VkU2lnbmF0dXJlPy5waGFzZSxcblx0XHRcdFx0XHR9IHNhdGlzZmllcyBSZXNwb25zZU91dHB1dE1lc3NhZ2UpO1xuXHRcdFx0XHR9IGVsc2UgaWYgKGJsb2NrLnR5cGUgPT09IFwidG9vbENhbGxcIikge1xuXHRcdFx0XHRcdGNvbnN0IHRvb2xDYWxsID0gYmxvY2sgYXMgVG9vbENhbGw7XG5cdFx0XHRcdFx0Y29uc3QgW2NhbGxJZCwgaXRlbUlkUmF3XSA9IHRvb2xDYWxsLmlkLnNwbGl0KFwifFwiKTtcblx0XHRcdFx0XHRsZXQgaXRlbUlkOiBzdHJpbmcgfCB1bmRlZmluZWQgPSBpdGVtSWRSYXc7XG5cblx0XHRcdFx0XHQvLyBGb3IgZGlmZmVyZW50LW1vZGVsIG1lc3NhZ2VzLCBzZXQgaWQgdG8gdW5kZWZpbmVkIHRvIGF2b2lkIHBhaXJpbmcgdmFsaWRhdGlvbi5cblx0XHRcdFx0XHQvLyBPcGVuQUkgdHJhY2tzIHdoaWNoIGZjX3h4eCBJRHMgd2VyZSBwYWlyZWQgd2l0aCByc194eHggcmVhc29uaW5nIGl0ZW1zLlxuXHRcdFx0XHRcdC8vIEJ5IG9taXR0aW5nIHRoZSBpZCwgd2UgYXZvaWQgdHJpZ2dlcmluZyB0aGF0IHZhbGlkYXRpb24gKGxpa2UgY3Jvc3MtcHJvdmlkZXIgZG9lcykuXG5cdFx0XHRcdFx0aWYgKGlzRGlmZmVyZW50TW9kZWwgJiYgaXRlbUlkPy5zdGFydHNXaXRoKFwiZmNfXCIpKSB7XG5cdFx0XHRcdFx0XHRpdGVtSWQgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0b3V0cHV0LnB1c2goe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJmdW5jdGlvbl9jYWxsXCIsXG5cdFx0XHRcdFx0XHRpZDogaXRlbUlkLFxuXHRcdFx0XHRcdFx0Y2FsbF9pZDogY2FsbElkLFxuXHRcdFx0XHRcdFx0bmFtZTogdG9vbENhbGwubmFtZSxcblx0XHRcdFx0XHRcdGFyZ3VtZW50czogSlNPTi5zdHJpbmdpZnkodG9vbENhbGwuYXJndW1lbnRzKSxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0aWYgKG91dHB1dC5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuXHRcdFx0bWVzc2FnZXMucHVzaCguLi5vdXRwdXQpO1xuXHRcdH0gZWxzZSBpZiAobXNnLnJvbGUgPT09IFwidG9vbFJlc3VsdFwiKSB7XG5cdFx0XHQvLyBFeHRyYWN0IHRleHQgYW5kIGltYWdlIGNvbnRlbnRcblx0XHRcdGNvbnN0IHRleHRSZXN1bHQgPSBtc2cuY29udGVudFxuXHRcdFx0XHQuZmlsdGVyKChjKTogYyBpcyBUZXh0Q29udGVudCA9PiBjLnR5cGUgPT09IFwidGV4dFwiKVxuXHRcdFx0XHQubWFwKChjKSA9PiBjLnRleHQpXG5cdFx0XHRcdC5qb2luKFwiXFxuXCIpO1xuXHRcdFx0Y29uc3QgaGFzSW1hZ2VzID0gbXNnLmNvbnRlbnQuc29tZSgoYyk6IGMgaXMgSW1hZ2VDb250ZW50ID0+IGMudHlwZSA9PT0gXCJpbWFnZVwiKTtcblxuXHRcdFx0Ly8gQWx3YXlzIHNlbmQgZnVuY3Rpb25fY2FsbF9vdXRwdXQgd2l0aCB0ZXh0IChvciBwbGFjZWhvbGRlciBpZiBvbmx5IGltYWdlcylcblx0XHRcdGNvbnN0IGhhc1RleHQgPSB0ZXh0UmVzdWx0Lmxlbmd0aCA+IDA7XG5cdFx0XHRjb25zdCBbY2FsbElkXSA9IG1zZy50b29sQ2FsbElkLnNwbGl0KFwifFwiKTtcblx0XHRcdG1lc3NhZ2VzLnB1c2goe1xuXHRcdFx0XHR0eXBlOiBcImZ1bmN0aW9uX2NhbGxfb3V0cHV0XCIsXG5cdFx0XHRcdGNhbGxfaWQ6IGNhbGxJZCxcblx0XHRcdFx0b3V0cHV0OiBzYW5pdGl6ZVN1cnJvZ2F0ZXMoaGFzVGV4dCA/IHRleHRSZXN1bHQgOiBcIihzZWUgYXR0YWNoZWQgaW1hZ2UpXCIpLFxuXHRcdFx0fSk7XG5cblx0XHRcdC8vIElmIHRoZXJlIGFyZSBpbWFnZXMgYW5kIG1vZGVsIHN1cHBvcnRzIHRoZW0sIHNlbmQgYSBmb2xsb3ctdXAgdXNlciBtZXNzYWdlIHdpdGggaW1hZ2VzXG5cdFx0XHRpZiAoaGFzSW1hZ2VzICYmIG1vZGVsLmlucHV0LmluY2x1ZGVzKFwiaW1hZ2VcIikpIHtcblx0XHRcdFx0Y29uc3QgY29udGVudFBhcnRzOiBSZXNwb25zZUlucHV0Q29udGVudFtdID0gW107XG5cblx0XHRcdFx0Ly8gQWRkIHRleHQgcHJlZml4XG5cdFx0XHRcdGNvbnRlbnRQYXJ0cy5wdXNoKHtcblx0XHRcdFx0XHR0eXBlOiBcImlucHV0X3RleHRcIixcblx0XHRcdFx0XHR0ZXh0OiBcIkF0dGFjaGVkIGltYWdlKHMpIGZyb20gdG9vbCByZXN1bHQ6XCIsXG5cdFx0XHRcdH0gc2F0aXNmaWVzIFJlc3BvbnNlSW5wdXRUZXh0KTtcblxuXHRcdFx0XHQvLyBBZGQgaW1hZ2VzXG5cdFx0XHRcdGZvciAoY29uc3QgYmxvY2sgb2YgbXNnLmNvbnRlbnQpIHtcblx0XHRcdFx0XHRpZiAoYmxvY2sudHlwZSA9PT0gXCJpbWFnZVwiKSB7XG5cdFx0XHRcdFx0XHRjb250ZW50UGFydHMucHVzaCh7XG5cdFx0XHRcdFx0XHRcdHR5cGU6IFwiaW5wdXRfaW1hZ2VcIixcblx0XHRcdFx0XHRcdFx0ZGV0YWlsOiBcImF1dG9cIixcblx0XHRcdFx0XHRcdFx0aW1hZ2VfdXJsOiBgZGF0YToke2Jsb2NrLm1pbWVUeXBlfTtiYXNlNjQsJHtibG9jay5kYXRhfWAsXG5cdFx0XHRcdFx0XHR9IHNhdGlzZmllcyBSZXNwb25zZUlucHV0SW1hZ2UpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdG1lc3NhZ2VzLnB1c2goe1xuXHRcdFx0XHRcdHJvbGU6IFwidXNlclwiLFxuXHRcdFx0XHRcdGNvbnRlbnQ6IGNvbnRlbnRQYXJ0cyxcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdG1zZ0luZGV4Kys7XG5cdH1cblxuXHRyZXR1cm4gbWVzc2FnZXM7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBUb29sIGNvbnZlcnNpb25cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmV4cG9ydCBmdW5jdGlvbiBjb252ZXJ0UmVzcG9uc2VzVG9vbHModG9vbHM6IFRvb2xbXSwgb3B0aW9ucz86IENvbnZlcnRSZXNwb25zZXNUb29sc09wdGlvbnMpOiBPcGVuQUlUb29sW10ge1xuXHRjb25zdCBzdHJpY3QgPSBvcHRpb25zPy5zdHJpY3QgPT09IHVuZGVmaW5lZCA/IGZhbHNlIDogb3B0aW9ucy5zdHJpY3Q7XG5cdHJldHVybiB0b29scy5tYXAoKHRvb2wpID0+ICh7XG5cdFx0dHlwZTogXCJmdW5jdGlvblwiLFxuXHRcdG5hbWU6IHRvb2wubmFtZSxcblx0XHRkZXNjcmlwdGlvbjogdG9vbC5kZXNjcmlwdGlvbixcblx0XHRwYXJhbWV0ZXJzOiB0b29sLnBhcmFtZXRlcnMgYXMgYW55LCAvLyBUeXBlQm94IGFscmVhZHkgZ2VuZXJhdGVzIEpTT04gU2NoZW1hXG5cdFx0c3RyaWN0LFxuXHR9KSk7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBTdHJlYW0gcHJvY2Vzc2luZ1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHByb2Nlc3NSZXNwb25zZXNTdHJlYW08VEFwaSBleHRlbmRzIEFwaT4oXG5cdG9wZW5haVN0cmVhbTogQXN5bmNJdGVyYWJsZTxSZXNwb25zZVN0cmVhbUV2ZW50Pixcblx0b3V0cHV0OiBBc3Npc3RhbnRNZXNzYWdlLFxuXHRzdHJlYW06IEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSxcblx0bW9kZWw6IE1vZGVsPFRBcGk+LFxuXHRvcHRpb25zPzogT3BlbkFJUmVzcG9uc2VzU3RyZWFtT3B0aW9ucyxcbik6IFByb21pc2U8dm9pZD4ge1xuXHRsZXQgY3VycmVudEl0ZW06IFJlc3BvbnNlUmVhc29uaW5nSXRlbSB8IFJlc3BvbnNlT3V0cHV0TWVzc2FnZSB8IFJlc3BvbnNlRnVuY3Rpb25Ub29sQ2FsbCB8IG51bGwgPSBudWxsO1xuXHRsZXQgY3VycmVudEJsb2NrOiBUaGlua2luZ0NvbnRlbnQgfCBUZXh0Q29udGVudCB8IChUb29sQ2FsbCAmIHsgcGFydGlhbEpzb246IHN0cmluZyB9KSB8IG51bGwgPSBudWxsO1xuXHRjb25zdCBibG9ja3MgPSBvdXRwdXQuY29udGVudDtcblx0Y29uc3QgYmxvY2tJbmRleCA9ICgpID0+IGJsb2Nrcy5sZW5ndGggLSAxO1xuXG5cdGZvciBhd2FpdCAoY29uc3QgZXZlbnQgb2Ygb3BlbmFpU3RyZWFtKSB7XG5cdFx0aWYgKGV2ZW50LnR5cGUgPT09IFwicmVzcG9uc2Uub3V0cHV0X2l0ZW0uYWRkZWRcIikge1xuXHRcdFx0Y29uc3QgaXRlbSA9IGV2ZW50Lml0ZW07XG5cdFx0XHRpZiAoaXRlbS50eXBlID09PSBcInJlYXNvbmluZ1wiKSB7XG5cdFx0XHRcdGN1cnJlbnRJdGVtID0gaXRlbTtcblx0XHRcdFx0Y3VycmVudEJsb2NrID0geyB0eXBlOiBcInRoaW5raW5nXCIsIHRoaW5raW5nOiBcIlwiIH07XG5cdFx0XHRcdG91dHB1dC5jb250ZW50LnB1c2goY3VycmVudEJsb2NrKTtcblx0XHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInRoaW5raW5nX3N0YXJ0XCIsIGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHR9IGVsc2UgaWYgKGl0ZW0udHlwZSA9PT0gXCJtZXNzYWdlXCIpIHtcblx0XHRcdFx0Y3VycmVudEl0ZW0gPSBpdGVtO1xuXHRcdFx0XHRjdXJyZW50QmxvY2sgPSB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlwiIH07XG5cdFx0XHRcdG91dHB1dC5jb250ZW50LnB1c2goY3VycmVudEJsb2NrKTtcblx0XHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInRleHRfc3RhcnRcIiwgY29udGVudEluZGV4OiBibG9ja0luZGV4KCksIHBhcnRpYWw6IG91dHB1dCB9KTtcblx0XHRcdH0gZWxzZSBpZiAoaXRlbS50eXBlID09PSBcImZ1bmN0aW9uX2NhbGxcIikge1xuXHRcdFx0XHRjdXJyZW50SXRlbSA9IGl0ZW07XG5cdFx0XHRcdGN1cnJlbnRCbG9jayA9IHtcblx0XHRcdFx0XHR0eXBlOiBcInRvb2xDYWxsXCIsXG5cdFx0XHRcdFx0aWQ6IGAke2l0ZW0uY2FsbF9pZH18JHtpdGVtLmlkfWAsXG5cdFx0XHRcdFx0bmFtZTogaXRlbS5uYW1lLFxuXHRcdFx0XHRcdGFyZ3VtZW50czoge30sXG5cdFx0XHRcdFx0cGFydGlhbEpzb246IGl0ZW0uYXJndW1lbnRzIHx8IFwiXCIsXG5cdFx0XHRcdH07XG5cdFx0XHRcdG91dHB1dC5jb250ZW50LnB1c2goY3VycmVudEJsb2NrKTtcblx0XHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInRvb2xjYWxsX3N0YXJ0XCIsIGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIGlmIChldmVudC50eXBlID09PSBcInJlc3BvbnNlLnJlYXNvbmluZ19zdW1tYXJ5X3BhcnQuYWRkZWRcIikge1xuXHRcdFx0aWYgKGN1cnJlbnRJdGVtICYmIGN1cnJlbnRJdGVtLnR5cGUgPT09IFwicmVhc29uaW5nXCIpIHtcblx0XHRcdFx0Y3VycmVudEl0ZW0uc3VtbWFyeSA9IGN1cnJlbnRJdGVtLnN1bW1hcnkgfHwgW107XG5cdFx0XHRcdGN1cnJlbnRJdGVtLnN1bW1hcnkucHVzaChldmVudC5wYXJ0KTtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKGV2ZW50LnR5cGUgPT09IFwicmVzcG9uc2UucmVhc29uaW5nX3N1bW1hcnlfdGV4dC5kZWx0YVwiKSB7XG5cdFx0XHRpZiAoY3VycmVudEl0ZW0/LnR5cGUgPT09IFwicmVhc29uaW5nXCIgJiYgY3VycmVudEJsb2NrPy50eXBlID09PSBcInRoaW5raW5nXCIpIHtcblx0XHRcdFx0Y3VycmVudEl0ZW0uc3VtbWFyeSA9IGN1cnJlbnRJdGVtLnN1bW1hcnkgfHwgW107XG5cdFx0XHRcdGNvbnN0IGxhc3RQYXJ0ID0gY3VycmVudEl0ZW0uc3VtbWFyeVtjdXJyZW50SXRlbS5zdW1tYXJ5Lmxlbmd0aCAtIDFdO1xuXHRcdFx0XHRpZiAobGFzdFBhcnQpIHtcblx0XHRcdFx0XHRjdXJyZW50QmxvY2sudGhpbmtpbmcgKz0gZXZlbnQuZGVsdGE7XG5cdFx0XHRcdFx0bGFzdFBhcnQudGV4dCArPSBldmVudC5kZWx0YTtcblx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRoaW5raW5nX2RlbHRhXCIsXG5cdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdGRlbHRhOiBldmVudC5kZWx0YSxcblx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAoZXZlbnQudHlwZSA9PT0gXCJyZXNwb25zZS5yZWFzb25pbmdfc3VtbWFyeV9wYXJ0LmRvbmVcIikge1xuXHRcdFx0aWYgKGN1cnJlbnRJdGVtPy50eXBlID09PSBcInJlYXNvbmluZ1wiICYmIGN1cnJlbnRCbG9jaz8udHlwZSA9PT0gXCJ0aGlua2luZ1wiKSB7XG5cdFx0XHRcdGN1cnJlbnRJdGVtLnN1bW1hcnkgPSBjdXJyZW50SXRlbS5zdW1tYXJ5IHx8IFtdO1xuXHRcdFx0XHRjb25zdCBsYXN0UGFydCA9IGN1cnJlbnRJdGVtLnN1bW1hcnlbY3VycmVudEl0ZW0uc3VtbWFyeS5sZW5ndGggLSAxXTtcblx0XHRcdFx0aWYgKGxhc3RQYXJ0KSB7XG5cdFx0XHRcdFx0Y3VycmVudEJsb2NrLnRoaW5raW5nICs9IFwiXFxuXFxuXCI7XG5cdFx0XHRcdFx0bGFzdFBhcnQudGV4dCArPSBcIlxcblxcblwiO1xuXHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdHR5cGU6IFwidGhpbmtpbmdfZGVsdGFcIixcblx0XHRcdFx0XHRcdGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLFxuXHRcdFx0XHRcdFx0ZGVsdGE6IFwiXFxuXFxuXCIsXG5cdFx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKGV2ZW50LnR5cGUgPT09IFwicmVzcG9uc2UuY29udGVudF9wYXJ0LmFkZGVkXCIpIHtcblx0XHRcdGlmIChjdXJyZW50SXRlbT8udHlwZSA9PT0gXCJtZXNzYWdlXCIpIHtcblx0XHRcdFx0Y3VycmVudEl0ZW0uY29udGVudCA9IGN1cnJlbnRJdGVtLmNvbnRlbnQgfHwgW107XG5cdFx0XHRcdC8vIEZpbHRlciBvdXQgUmVhc29uaW5nVGV4dCwgb25seSBhY2NlcHQgb3V0cHV0X3RleHQgYW5kIHJlZnVzYWxcblx0XHRcdFx0aWYgKGV2ZW50LnBhcnQudHlwZSA9PT0gXCJvdXRwdXRfdGV4dFwiIHx8IGV2ZW50LnBhcnQudHlwZSA9PT0gXCJyZWZ1c2FsXCIpIHtcblx0XHRcdFx0XHRjdXJyZW50SXRlbS5jb250ZW50LnB1c2goZXZlbnQucGFydCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKGV2ZW50LnR5cGUgPT09IFwicmVzcG9uc2Uub3V0cHV0X3RleHQuZGVsdGFcIikge1xuXHRcdFx0aWYgKGN1cnJlbnRJdGVtPy50eXBlID09PSBcIm1lc3NhZ2VcIiAmJiBjdXJyZW50QmxvY2s/LnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdGlmICghY3VycmVudEl0ZW0uY29udGVudCB8fCBjdXJyZW50SXRlbS5jb250ZW50Lmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IGxhc3RQYXJ0ID0gY3VycmVudEl0ZW0uY29udGVudFtjdXJyZW50SXRlbS5jb250ZW50Lmxlbmd0aCAtIDFdO1xuXHRcdFx0XHRpZiAobGFzdFBhcnQ/LnR5cGUgPT09IFwib3V0cHV0X3RleHRcIikge1xuXHRcdFx0XHRcdGN1cnJlbnRCbG9jay50ZXh0ICs9IGV2ZW50LmRlbHRhO1xuXHRcdFx0XHRcdGxhc3RQYXJ0LnRleHQgKz0gZXZlbnQuZGVsdGE7XG5cdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0X2RlbHRhXCIsXG5cdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdGRlbHRhOiBldmVudC5kZWx0YSxcblx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAoZXZlbnQudHlwZSA9PT0gXCJyZXNwb25zZS5yZWZ1c2FsLmRlbHRhXCIpIHtcblx0XHRcdGlmIChjdXJyZW50SXRlbT8udHlwZSA9PT0gXCJtZXNzYWdlXCIgJiYgY3VycmVudEJsb2NrPy50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHRpZiAoIWN1cnJlbnRJdGVtLmNvbnRlbnQgfHwgY3VycmVudEl0ZW0uY29udGVudC5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBsYXN0UGFydCA9IGN1cnJlbnRJdGVtLmNvbnRlbnRbY3VycmVudEl0ZW0uY29udGVudC5sZW5ndGggLSAxXTtcblx0XHRcdFx0aWYgKGxhc3RQYXJ0Py50eXBlID09PSBcInJlZnVzYWxcIikge1xuXHRcdFx0XHRcdGN1cnJlbnRCbG9jay50ZXh0ICs9IGV2ZW50LmRlbHRhO1xuXHRcdFx0XHRcdGxhc3RQYXJ0LnJlZnVzYWwgKz0gZXZlbnQuZGVsdGE7XG5cdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0X2RlbHRhXCIsXG5cdFx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRcdGRlbHRhOiBldmVudC5kZWx0YSxcblx0XHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAoZXZlbnQudHlwZSA9PT0gXCJyZXNwb25zZS5mdW5jdGlvbl9jYWxsX2FyZ3VtZW50cy5kZWx0YVwiKSB7XG5cdFx0XHRpZiAoY3VycmVudEl0ZW0/LnR5cGUgPT09IFwiZnVuY3Rpb25fY2FsbFwiICYmIGN1cnJlbnRCbG9jaz8udHlwZSA9PT0gXCJ0b29sQ2FsbFwiKSB7XG5cdFx0XHRcdGN1cnJlbnRCbG9jay5wYXJ0aWFsSnNvbiArPSBldmVudC5kZWx0YTtcblx0XHRcdFx0Y3VycmVudEJsb2NrLmFyZ3VtZW50cyA9IHBhcnNlU3RyZWFtaW5nSnNvbihjdXJyZW50QmxvY2sucGFydGlhbEpzb24pO1xuXHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0dHlwZTogXCJ0b29sY2FsbF9kZWx0YVwiLFxuXHRcdFx0XHRcdGNvbnRlbnRJbmRleDogYmxvY2tJbmRleCgpLFxuXHRcdFx0XHRcdGRlbHRhOiBldmVudC5kZWx0YSxcblx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdH0pO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAoZXZlbnQudHlwZSA9PT0gXCJyZXNwb25zZS5mdW5jdGlvbl9jYWxsX2FyZ3VtZW50cy5kb25lXCIpIHtcblx0XHRcdGlmIChjdXJyZW50SXRlbT8udHlwZSA9PT0gXCJmdW5jdGlvbl9jYWxsXCIgJiYgY3VycmVudEJsb2NrPy50eXBlID09PSBcInRvb2xDYWxsXCIpIHtcblx0XHRcdFx0Y3VycmVudEJsb2NrLnBhcnRpYWxKc29uID0gZXZlbnQuYXJndW1lbnRzO1xuXHRcdFx0XHRjdXJyZW50QmxvY2suYXJndW1lbnRzID0gcGFyc2VTdHJlYW1pbmdKc29uKGN1cnJlbnRCbG9jay5wYXJ0aWFsSnNvbik7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIGlmIChldmVudC50eXBlID09PSBcInJlc3BvbnNlLm91dHB1dF9pdGVtLmRvbmVcIikge1xuXHRcdFx0Y29uc3QgaXRlbSA9IGV2ZW50Lml0ZW07XG5cblx0XHRcdGlmIChpdGVtLnR5cGUgPT09IFwicmVhc29uaW5nXCIgJiYgY3VycmVudEJsb2NrPy50eXBlID09PSBcInRoaW5raW5nXCIpIHtcblx0XHRcdFx0Y3VycmVudEJsb2NrLnRoaW5raW5nID0gaXRlbS5zdW1tYXJ5Py5tYXAoKHMpID0+IHMudGV4dCkuam9pbihcIlxcblxcblwiKSB8fCBcIlwiO1xuXHRcdFx0XHRjdXJyZW50QmxvY2sudGhpbmtpbmdTaWduYXR1cmUgPSBKU09OLnN0cmluZ2lmeShpdGVtKTtcblx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdHR5cGU6IFwidGhpbmtpbmdfZW5kXCIsXG5cdFx0XHRcdFx0Y29udGVudEluZGV4OiBibG9ja0luZGV4KCksXG5cdFx0XHRcdFx0Y29udGVudDogY3VycmVudEJsb2NrLnRoaW5raW5nLFxuXHRcdFx0XHRcdHBhcnRpYWw6IG91dHB1dCxcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGN1cnJlbnRCbG9jayA9IG51bGw7XG5cdFx0XHR9IGVsc2UgaWYgKGl0ZW0udHlwZSA9PT0gXCJtZXNzYWdlXCIgJiYgY3VycmVudEJsb2NrPy50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHRjdXJyZW50QmxvY2sudGV4dCA9IGl0ZW0uY29udGVudC5tYXAoKGMpID0+IChjLnR5cGUgPT09IFwib3V0cHV0X3RleHRcIiA/IGMudGV4dCA6IGMucmVmdXNhbCkpLmpvaW4oXCJcIik7XG5cdFx0XHRcdGN1cnJlbnRCbG9jay50ZXh0U2lnbmF0dXJlID0gZW5jb2RlVGV4dFNpZ25hdHVyZVYxKGl0ZW0uaWQsIGl0ZW0ucGhhc2UgPz8gdW5kZWZpbmVkKTtcblx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdHR5cGU6IFwidGV4dF9lbmRcIixcblx0XHRcdFx0XHRjb250ZW50SW5kZXg6IGJsb2NrSW5kZXgoKSxcblx0XHRcdFx0XHRjb250ZW50OiBjdXJyZW50QmxvY2sudGV4dCxcblx0XHRcdFx0XHRwYXJ0aWFsOiBvdXRwdXQsXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRjdXJyZW50QmxvY2sgPSBudWxsO1xuXHRcdFx0fSBlbHNlIGlmIChpdGVtLnR5cGUgPT09IFwiZnVuY3Rpb25fY2FsbFwiKSB7XG5cdFx0XHRcdGNvbnN0IGFyZ3MgPVxuXHRcdFx0XHRcdGN1cnJlbnRCbG9jaz8udHlwZSA9PT0gXCJ0b29sQ2FsbFwiICYmIGN1cnJlbnRCbG9jay5wYXJ0aWFsSnNvblxuXHRcdFx0XHRcdFx0PyBwYXJzZVN0cmVhbWluZ0pzb24oY3VycmVudEJsb2NrLnBhcnRpYWxKc29uKVxuXHRcdFx0XHRcdFx0OiBwYXJzZVN0cmVhbWluZ0pzb24oaXRlbS5hcmd1bWVudHMgfHwgXCJ7fVwiKTtcblx0XHRcdFx0Y29uc3QgdG9vbENhbGw6IFRvb2xDYWxsID0ge1xuXHRcdFx0XHRcdHR5cGU6IFwidG9vbENhbGxcIixcblx0XHRcdFx0XHRpZDogYCR7aXRlbS5jYWxsX2lkfXwke2l0ZW0uaWR9YCxcblx0XHRcdFx0XHRuYW1lOiBpdGVtLm5hbWUsXG5cdFx0XHRcdFx0YXJndW1lbnRzOiBhcmdzLFxuXHRcdFx0XHR9O1xuXG5cdFx0XHRcdGN1cnJlbnRCbG9jayA9IG51bGw7XG5cdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0b29sY2FsbF9lbmRcIiwgY29udGVudEluZGV4OiBibG9ja0luZGV4KCksIHRvb2xDYWxsLCBwYXJ0aWFsOiBvdXRwdXQgfSk7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIGlmIChldmVudC50eXBlID09PSBcInJlc3BvbnNlLmNvbXBsZXRlZFwiKSB7XG5cdFx0XHRjb25zdCByZXNwb25zZSA9IGV2ZW50LnJlc3BvbnNlO1xuXHRcdFx0aWYgKHJlc3BvbnNlPy51c2FnZSkge1xuXHRcdFx0XHRjb25zdCBjYWNoZWRUb2tlbnMgPSByZXNwb25zZS51c2FnZS5pbnB1dF90b2tlbnNfZGV0YWlscz8uY2FjaGVkX3Rva2VucyB8fCAwO1xuXHRcdFx0XHRvdXRwdXQudXNhZ2UgPSB7XG5cdFx0XHRcdFx0Ly8gT3BlbkFJIGluY2x1ZGVzIGNhY2hlZCB0b2tlbnMgaW4gaW5wdXRfdG9rZW5zLCBzbyBzdWJ0cmFjdCB0byBnZXQgbm9uLWNhY2hlZCBpbnB1dFxuXHRcdFx0XHRcdGlucHV0OiAocmVzcG9uc2UudXNhZ2UuaW5wdXRfdG9rZW5zIHx8IDApIC0gY2FjaGVkVG9rZW5zLFxuXHRcdFx0XHRcdG91dHB1dDogcmVzcG9uc2UudXNhZ2Uub3V0cHV0X3Rva2VucyB8fCAwLFxuXHRcdFx0XHRcdGNhY2hlUmVhZDogY2FjaGVkVG9rZW5zLFxuXHRcdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHRcdFx0dG90YWxUb2tlbnM6IHJlc3BvbnNlLnVzYWdlLnRvdGFsX3Rva2VucyB8fCAwLFxuXHRcdFx0XHRcdGNvc3Q6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCB0b3RhbDogMCB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdFx0Y2FsY3VsYXRlQ29zdChtb2RlbCwgb3V0cHV0LnVzYWdlKTtcblx0XHRcdGlmIChvcHRpb25zPy5hcHBseVNlcnZpY2VUaWVyUHJpY2luZykge1xuXHRcdFx0XHRjb25zdCBzZXJ2aWNlVGllciA9IHJlc3BvbnNlPy5zZXJ2aWNlX3RpZXIgPz8gb3B0aW9ucy5zZXJ2aWNlVGllcjtcblx0XHRcdFx0b3B0aW9ucy5hcHBseVNlcnZpY2VUaWVyUHJpY2luZyhvdXRwdXQudXNhZ2UsIHNlcnZpY2VUaWVyKTtcblx0XHRcdH1cblx0XHRcdC8vIE1hcCBzdGF0dXMgdG8gc3RvcCByZWFzb25cblx0XHRcdG91dHB1dC5zdG9wUmVhc29uID0gbWFwU3RvcFJlYXNvbihyZXNwb25zZT8uc3RhdHVzKTtcblx0XHRcdGlmIChvdXRwdXQuY29udGVudC5zb21lKChiKSA9PiBiLnR5cGUgPT09IFwidG9vbENhbGxcIikgJiYgb3V0cHV0LnN0b3BSZWFzb24gPT09IFwic3RvcFwiKSB7XG5cdFx0XHRcdG91dHB1dC5zdG9wUmVhc29uID0gXCJ0b29sVXNlXCI7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIGlmIChldmVudC50eXBlID09PSBcImVycm9yXCIpIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihgRXJyb3IgQ29kZSAke2V2ZW50LmNvZGV9OiAke2V2ZW50Lm1lc3NhZ2V9YCB8fCBcIlVua25vd24gZXJyb3JcIik7XG5cdFx0fSBlbHNlIGlmIChldmVudC50eXBlID09PSBcInJlc3BvbnNlLmZhaWxlZFwiKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJVbmtub3duIGVycm9yXCIpO1xuXHRcdH1cblx0fVxufVxuXG5mdW5jdGlvbiBtYXBTdG9wUmVhc29uKHN0YXR1czogT3BlbkFJLlJlc3BvbnNlcy5SZXNwb25zZVN0YXR1cyB8IHVuZGVmaW5lZCk6IFN0b3BSZWFzb24ge1xuXHRpZiAoIXN0YXR1cykgcmV0dXJuIFwic3RvcFwiO1xuXHRzd2l0Y2ggKHN0YXR1cykge1xuXHRcdGNhc2UgXCJjb21wbGV0ZWRcIjpcblx0XHRcdHJldHVybiBcInN0b3BcIjtcblx0XHRjYXNlIFwiaW5jb21wbGV0ZVwiOlxuXHRcdFx0cmV0dXJuIFwibGVuZ3RoXCI7XG5cdFx0Y2FzZSBcImZhaWxlZFwiOlxuXHRcdGNhc2UgXCJjYW5jZWxsZWRcIjpcblx0XHRcdHJldHVybiBcImVycm9yXCI7XG5cdFx0Ly8gVGhlc2UgdHdvIGFyZSB3b25reSAuLi5cblx0XHRjYXNlIFwiaW5fcHJvZ3Jlc3NcIjpcblx0XHRjYXNlIFwicXVldWVkXCI6XG5cdFx0XHRyZXR1cm4gXCJzdG9wXCI7XG5cdFx0ZGVmYXVsdDoge1xuXHRcdFx0Y29uc3QgX2V4aGF1c3RpdmU6IG5ldmVyID0gc3RhdHVzO1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGBVbmhhbmRsZWQgc3RvcCByZWFzb246ICR7X2V4aGF1c3RpdmV9YCk7XG5cdFx0fVxuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFhQSxTQUFTLHFCQUFxQjtBQWdCOUIsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUywwQkFBMEI7QUFDbkMsU0FBUywwQkFBMEI7QUFD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
