import { hasXmlParameterTags, repairToolJson } from "@gsd/pi-ai";
function parseMcpToolName(name) {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const delim = rest.indexOf("__");
  if (delim <= 0 || delim === rest.length - 2) return null;
  return { server: rest.slice(0, delim), tool: rest.slice(delim + 2) };
}
function toolCallFromBlock(id, rawName, input) {
  const parsed = parseMcpToolName(rawName);
  const toolCall = {
    type: "toolCall",
    id,
    name: parsed ? parsed.tool : rawName,
    arguments: input
  };
  if (parsed) {
    toolCall.mcpServer = parsed.server;
  }
  return toolCall;
}
function mapContentBlock(block) {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        ...block.signature ? { thinkingSignature: block.signature } : {}
      };
    case "tool_use":
      return toolCallFromBlock(block.id, block.name, block.input);
    case "server_tool_use":
      return {
        type: "serverToolUse",
        id: block.id,
        name: block.name,
        input: block.input
      };
    case "web_search_tool_result":
      return {
        type: "webSearchResult",
        toolUseId: block.tool_use_id,
        content: block.content
      };
    default: {
      const unknown = block;
      return { type: "text", text: `[unknown content block: ${JSON.stringify(unknown)}]` };
    }
  }
}
function mapStopReason(reason) {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return "stop";
  }
}
function mapUsage(sdkUsage, totalCostUsd) {
  return {
    input: sdkUsage.input_tokens,
    output: sdkUsage.output_tokens,
    cacheRead: sdkUsage.cache_read_input_tokens,
    cacheWrite: sdkUsage.cache_creation_input_tokens,
    // Claude Agent SDK result usage is cumulative across its internal loop;
    // repeated cache reads do not represent additional live context.
    totalTokens: sdkUsage.input_tokens + sdkUsage.output_tokens + sdkUsage.cache_creation_input_tokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: totalCostUsd
    }
  };
}
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};
class PartialMessageBuilder {
  partial;
  /** Map from stream-event `index` to our content array index. */
  indexMap = /* @__PURE__ */ new Map();
  /** Accumulated JSON input string per tool_use block (keyed by stream index). */
  toolJsonAccum = /* @__PURE__ */ new Map();
  constructor(model) {
    this.partial = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "claude-code",
      model,
      usage: { ...ZERO_USAGE },
      stopReason: "stop",
      timestamp: Date.now()
    };
  }
  get message() {
    return this.partial;
  }
  /**
   * Feed a BetaRawMessageStreamEvent and return the corresponding
   * AssistantMessageEvent (or null if the event is not mapped).
   */
  handleEvent(event) {
    const streamIndex = event.index ?? 0;
    switch (event.type) {
      // ---- Block start ----
      case "content_block_start": {
        const block = event.content_block;
        if (!block) return null;
        const contentIndex = this.partial.content.length;
        this.indexMap.set(streamIndex, contentIndex);
        if (block.type === "text") {
          this.partial.content.push({ type: "text", text: "" });
          return { type: "text_start", contentIndex, partial: this.partial };
        }
        if (block.type === "thinking") {
          this.partial.content.push({ type: "thinking", thinking: "" });
          return { type: "thinking_start", contentIndex, partial: this.partial };
        }
        if (block.type === "tool_use") {
          this.toolJsonAccum.set(streamIndex, "");
          this.partial.content.push(toolCallFromBlock(block.id, block.name, {}));
          return { type: "toolcall_start", contentIndex, partial: this.partial };
        }
        if (block.type === "server_tool_use") {
          this.partial.content.push({
            type: "serverToolUse",
            id: block.id,
            name: block.name,
            input: block.input
          });
          return { type: "server_tool_use", contentIndex, partial: this.partial };
        }
        return null;
      }
      // ---- Block delta ----
      case "content_block_delta": {
        const contentIndex = this.indexMap.get(streamIndex);
        if (contentIndex === void 0) return null;
        const delta = event.delta;
        if (!delta) return null;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          const existing = this.partial.content[contentIndex];
          existing.text += delta.text;
          return { type: "text_delta", contentIndex, delta: delta.text, partial: this.partial };
        }
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          const existing = this.partial.content[contentIndex];
          existing.thinking += delta.thinking;
          return { type: "thinking_delta", contentIndex, delta: delta.thinking, partial: this.partial };
        }
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const accum = (this.toolJsonAccum.get(streamIndex) ?? "") + delta.partial_json;
          this.toolJsonAccum.set(streamIndex, accum);
          return { type: "toolcall_delta", contentIndex, delta: delta.partial_json, partial: this.partial };
        }
        return null;
      }
      // ---- Block stop ----
      case "content_block_stop": {
        const contentIndex = this.indexMap.get(streamIndex);
        if (contentIndex === void 0) return null;
        const block = this.partial.content[contentIndex];
        if (block.type === "text") {
          return { type: "text_end", contentIndex, content: block.text, partial: this.partial };
        }
        if (block.type === "thinking") {
          return { type: "thinking_end", contentIndex, content: block.thinking, partial: this.partial };
        }
        if (block.type === "toolCall") {
          const jsonStr = this.toolJsonAccum.get(streamIndex) ?? "{}";
          const jsonForParse = hasXmlParameterTags(jsonStr) ? repairToolJson(jsonStr) : jsonStr;
          try {
            block.arguments = JSON.parse(jsonForParse);
          } catch {
            try {
              block.arguments = JSON.parse(repairToolJson(jsonForParse));
            } catch {
              block.arguments = { _raw: jsonStr };
              return { type: "toolcall_end", contentIndex, toolCall: block, partial: this.partial, malformedArguments: true };
            }
          }
          return { type: "toolcall_end", contentIndex, toolCall: block, partial: this.partial };
        }
        return null;
      }
      default:
        return null;
    }
  }
}
export {
  PartialMessageBuilder,
  ZERO_USAGE,
  mapContentBlock,
  mapStopReason,
  mapUsage,
  parseMcpToolName
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2NsYXVkZS1jb2RlLWNsaS9wYXJ0aWFsLWJ1aWxkZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogQ29udGVudC1ibG9jayBtYXBwaW5nIGhlbHBlcnMgYW5kIHN0cmVhbWluZyBzdGF0ZSB0cmFja2VyLlxuICpcbiAqIFRyYW5zbGF0ZXMgdGhlIENsYXVkZSBBZ2VudCBTREsncyBgQmV0YVJhd01lc3NhZ2VTdHJlYW1FdmVudGAgc2VxdWVuY2VcbiAqIGludG8gR1NEJ3MgYEFzc2lzdGFudE1lc3NhZ2VFdmVudGAgZGVsdGFzIGZvciBpbmNyZW1lbnRhbCBUVUkgcmVuZGVyaW5nLlxuICovXG5cbmltcG9ydCB0eXBlIHtcblx0QXNzaXN0YW50TWVzc2FnZSxcblx0QXNzaXN0YW50TWVzc2FnZUV2ZW50LFxuXHRTZXJ2ZXJUb29sVXNlQ29udGVudCxcblx0U3RvcFJlYXNvbixcblx0VGV4dENvbnRlbnQsXG5cdFRoaW5raW5nQ29udGVudCxcblx0VG9vbENhbGwsXG5cdFVzYWdlLFxuXHRXZWJTZWFyY2hSZXN1bHRDb250ZW50LFxufSBmcm9tIFwiQGdzZC9waS1haVwiO1xuaW1wb3J0IHsgaGFzWG1sUGFyYW1ldGVyVGFncywgcmVwYWlyVG9vbEpzb24gfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuaW1wb3J0IHR5cGUgeyBCZXRhQ29udGVudEJsb2NrLCBCZXRhUmF3TWVzc2FnZVN0cmVhbUV2ZW50LCBOb25OdWxsYWJsZVVzYWdlIH0gZnJvbSBcIi4vc2RrLXR5cGVzLmpzXCI7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gTUNQIHRvb2wgbmFtZSBwYXJzaW5nXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBTcGxpdCBhIENsYXVkZSBDb2RlIE1DUCB0b29sIG5hbWUgKGBtY3BfXzxzZXJ2ZXI+X188dG9vbD5gKSBpbnRvIGl0cyBwYXJ0cy5cbiAqIFJldHVybnMgbnVsbCBmb3Igbm9uLXByZWZpeGVkIG5hbWVzIHNvIGNhbGxlcnMgY2FuIGZhbGwgdGhyb3VnaCB1bmNoYW5nZWQuXG4gKlxuICogU2VydmVyIG5hbWVzIG1heSBjb250YWluIGh5cGhlbnMgKGBnc2Qtd29ya2Zsb3dgKTsgdGhlIFNESyB1c2VzIHRoZSBsaXRlcmFsXG4gKiBgX19gIGRlbGltaXRlciBiZXR3ZWVuIHRoZSBzZXJ2ZXIgbmFtZSBhbmQgdGhlIHRvb2wgbmFtZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlTWNwVG9vbE5hbWUobmFtZTogc3RyaW5nKTogeyBzZXJ2ZXI6IHN0cmluZzsgdG9vbDogc3RyaW5nIH0gfCBudWxsIHtcblx0aWYgKCFuYW1lLnN0YXJ0c1dpdGgoXCJtY3BfX1wiKSkgcmV0dXJuIG51bGw7XG5cdGNvbnN0IHJlc3QgPSBuYW1lLnNsaWNlKFwibWNwX19cIi5sZW5ndGgpO1xuXHRjb25zdCBkZWxpbSA9IHJlc3QuaW5kZXhPZihcIl9fXCIpO1xuXHRpZiAoZGVsaW0gPD0gMCB8fCBkZWxpbSA9PT0gcmVzdC5sZW5ndGggLSAyKSByZXR1cm4gbnVsbDtcblx0cmV0dXJuIHsgc2VydmVyOiByZXN0LnNsaWNlKDAsIGRlbGltKSwgdG9vbDogcmVzdC5zbGljZShkZWxpbSArIDIpIH07XG59XG5cbi8qKlxuICogQnVpbGQgYSBHU0QgVG9vbENhbGwgYmxvY2sgZnJvbSBhIENsYXVkZSBDb2RlIFNESyB0b29sX3VzZSBibG9jaywgc3RyaXBwaW5nXG4gKiB0aGUgYG1jcF9fPHNlcnZlcj5fX2AgcHJlZml4IGZyb20gdGhlIG5hbWUgc28gcmVnaXN0ZXJlZCBleHRlbnNpb24gcmVuZGVyZXJzXG4gKiAod2hpY2ggdXNlIHRoZSB1bnByZWZpeGVkIGNhbm9uaWNhbCBuYW1lcykgY2FuIG1hdGNoLiBUaGUgb3JpZ2luYWwgc2VydmVyXG4gKiBuYW1lIGlzIHByZXNlcnZlZCBvbiB0aGUgYmxvY2sgZm9yIGRpYWdub3N0aWNzIGFuZCByZW5kZXJpbmcuXG4gKi9cbmZ1bmN0aW9uIHRvb2xDYWxsRnJvbUJsb2NrKFxuXHRpZDogc3RyaW5nLFxuXHRyYXdOYW1lOiBzdHJpbmcsXG5cdGlucHV0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbik6IFRvb2xDYWxsIHtcblx0Y29uc3QgcGFyc2VkID0gcGFyc2VNY3BUb29sTmFtZShyYXdOYW1lKTtcblx0Y29uc3QgdG9vbENhbGw6IFRvb2xDYWxsID0ge1xuXHRcdHR5cGU6IFwidG9vbENhbGxcIixcblx0XHRpZCxcblx0XHRuYW1lOiBwYXJzZWQgPyBwYXJzZWQudG9vbCA6IHJhd05hbWUsXG5cdFx0YXJndW1lbnRzOiBpbnB1dCxcblx0fTtcblx0aWYgKHBhcnNlZCkge1xuXHRcdCh0b29sQ2FsbCBhcyBUb29sQ2FsbCAmIHsgbWNwU2VydmVyPzogc3RyaW5nIH0pLm1jcFNlcnZlciA9IHBhcnNlZC5zZXJ2ZXI7XG5cdH1cblx0cmV0dXJuIHRvb2xDYWxsO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIENvbnRlbnQtYmxvY2sgbWFwcGluZyBoZWxwZXJzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBDb252ZXJ0IGEgc2luZ2xlIEJldGFDb250ZW50QmxvY2sgdG8gdGhlIGNvcnJlc3BvbmRpbmcgR1NEIGNvbnRlbnQgdHlwZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1hcENvbnRlbnRCbG9jayhcblx0YmxvY2s6IEJldGFDb250ZW50QmxvY2ssXG4pOiBUZXh0Q29udGVudCB8IFRoaW5raW5nQ29udGVudCB8IFRvb2xDYWxsIHwgU2VydmVyVG9vbFVzZUNvbnRlbnQgfCBXZWJTZWFyY2hSZXN1bHRDb250ZW50IHtcblx0c3dpdGNoIChibG9jay50eXBlKSB7XG5cdFx0Y2FzZSBcInRleHRcIjpcblx0XHRcdHJldHVybiB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBibG9jay50ZXh0IH0gc2F0aXNmaWVzIFRleHRDb250ZW50O1xuXG5cdFx0Y2FzZSBcInRoaW5raW5nXCI6XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHR0eXBlOiBcInRoaW5raW5nXCIsXG5cdFx0XHRcdHRoaW5raW5nOiBibG9jay50aGlua2luZyxcblx0XHRcdFx0Li4uKGJsb2NrLnNpZ25hdHVyZSA/IHsgdGhpbmtpbmdTaWduYXR1cmU6IGJsb2NrLnNpZ25hdHVyZSB9IDoge30pLFxuXHRcdFx0fSBzYXRpc2ZpZXMgVGhpbmtpbmdDb250ZW50O1xuXG5cdFx0Y2FzZSBcInRvb2xfdXNlXCI6XG5cdFx0XHRyZXR1cm4gdG9vbENhbGxGcm9tQmxvY2soYmxvY2suaWQsIGJsb2NrLm5hbWUsIGJsb2NrLmlucHV0KTtcblxuXHRcdGNhc2UgXCJzZXJ2ZXJfdG9vbF91c2VcIjpcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdHR5cGU6IFwic2VydmVyVG9vbFVzZVwiLFxuXHRcdFx0XHRpZDogYmxvY2suaWQsXG5cdFx0XHRcdG5hbWU6IGJsb2NrLm5hbWUsXG5cdFx0XHRcdGlucHV0OiBibG9jay5pbnB1dCxcblx0XHRcdH0gc2F0aXNmaWVzIFNlcnZlclRvb2xVc2VDb250ZW50O1xuXG5cdFx0Y2FzZSBcIndlYl9zZWFyY2hfdG9vbF9yZXN1bHRcIjpcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdHR5cGU6IFwid2ViU2VhcmNoUmVzdWx0XCIsXG5cdFx0XHRcdHRvb2xVc2VJZDogYmxvY2sudG9vbF91c2VfaWQsXG5cdFx0XHRcdGNvbnRlbnQ6IGJsb2NrLmNvbnRlbnQsXG5cdFx0XHR9IHNhdGlzZmllcyBXZWJTZWFyY2hSZXN1bHRDb250ZW50O1xuXG5cdFx0ZGVmYXVsdDoge1xuXHRcdFx0Y29uc3QgdW5rbm93biA9IGJsb2NrIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXHRcdFx0cmV0dXJuIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBbdW5rbm93biBjb250ZW50IGJsb2NrOiAke0pTT04uc3RyaW5naWZ5KHVua25vd24pfV1gIH07XG5cdFx0fVxuXHR9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXBTdG9wUmVhc29uKHJlYXNvbjogc3RyaW5nIHwgbnVsbCk6IFN0b3BSZWFzb24ge1xuXHRzd2l0Y2ggKHJlYXNvbikge1xuXHRcdGNhc2UgXCJlbmRfdHVyblwiOlxuXHRcdGNhc2UgXCJzdG9wX3NlcXVlbmNlXCI6XG5cdFx0XHRyZXR1cm4gXCJzdG9wXCI7XG5cdFx0Y2FzZSBcIm1heF90b2tlbnNcIjpcblx0XHRcdHJldHVybiBcImxlbmd0aFwiO1xuXHRcdGNhc2UgXCJ0b29sX3VzZVwiOlxuXHRcdFx0cmV0dXJuIFwidG9vbFVzZVwiO1xuXHRcdGRlZmF1bHQ6XG5cdFx0XHRyZXR1cm4gXCJzdG9wXCI7XG5cdH1cbn1cblxuLyoqXG4gKiBDb252ZXJ0IFNESyB1c2FnZSArIHRvdGFsX2Nvc3RfdXNkIGludG8gR1NEJ3MgVXNhZ2Ugc2hhcGUuXG4gKlxuICogVGhlIFNESyBkb2VzIG5vdCBicmVhayBjb3N0IGRvd24gcGVyLWJ1Y2tldCwgc28gYWxsIGNvc3QgaXNcbiAqIGF0dHJpYnV0ZWQgdG8gYGNvc3QudG90YWxgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWFwVXNhZ2Uoc2RrVXNhZ2U6IE5vbk51bGxhYmxlVXNhZ2UsIHRvdGFsQ29zdFVzZDogbnVtYmVyKTogVXNhZ2Uge1xuXHRyZXR1cm4ge1xuXHRcdGlucHV0OiBzZGtVc2FnZS5pbnB1dF90b2tlbnMsXG5cdFx0b3V0cHV0OiBzZGtVc2FnZS5vdXRwdXRfdG9rZW5zLFxuXHRcdGNhY2hlUmVhZDogc2RrVXNhZ2UuY2FjaGVfcmVhZF9pbnB1dF90b2tlbnMsXG5cdFx0Y2FjaGVXcml0ZTogc2RrVXNhZ2UuY2FjaGVfY3JlYXRpb25faW5wdXRfdG9rZW5zLFxuXHRcdC8vIENsYXVkZSBBZ2VudCBTREsgcmVzdWx0IHVzYWdlIGlzIGN1bXVsYXRpdmUgYWNyb3NzIGl0cyBpbnRlcm5hbCBsb29wO1xuXHRcdC8vIHJlcGVhdGVkIGNhY2hlIHJlYWRzIGRvIG5vdCByZXByZXNlbnQgYWRkaXRpb25hbCBsaXZlIGNvbnRleHQuXG5cdFx0dG90YWxUb2tlbnM6XG5cdFx0XHRzZGtVc2FnZS5pbnB1dF90b2tlbnMgK1xuXHRcdFx0c2RrVXNhZ2Uub3V0cHV0X3Rva2VucyArXG5cdFx0XHRzZGtVc2FnZS5jYWNoZV9jcmVhdGlvbl9pbnB1dF90b2tlbnMsXG5cdFx0Y29zdDoge1xuXHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0dG90YWw6IHRvdGFsQ29zdFVzZCxcblx0XHR9LFxuXHR9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFplcm8tY29zdCB1c2FnZSBjb25zdGFudFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBjb25zdCBaRVJPX1VTQUdFOiBVc2FnZSA9IHtcblx0aW5wdXQ6IDAsXG5cdG91dHB1dDogMCxcblx0Y2FjaGVSZWFkOiAwLFxuXHRjYWNoZVdyaXRlOiAwLFxuXHR0b3RhbFRva2VuczogMCxcblx0Y29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsOiAwIH0sXG59O1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFN0cmVhbWluZyBwYXJ0aWFsLW1lc3NhZ2Ugc3RhdGUgdHJhY2tlclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogTXV0YWJsZSBhY2N1bXVsYXRvciB0aGF0IHRyYWNrcyB0aGUgcGFydGlhbCBBc3Npc3RhbnRNZXNzYWdlIGJlaW5nIGJ1aWx0XG4gKiBmcm9tIGEgc2VxdWVuY2Ugb2Ygc3RyZWFtX2V2ZW50IG1lc3NhZ2VzLiBQcm9kdWNlcyBBc3Npc3RhbnRNZXNzYWdlRXZlbnRcbiAqIGRlbHRhcyB0aGF0IHRoZSBUVUkgY2FuIHJlbmRlciBpbmNyZW1lbnRhbGx5LlxuICovXG5leHBvcnQgY2xhc3MgUGFydGlhbE1lc3NhZ2VCdWlsZGVyIHtcblx0cHJpdmF0ZSBwYXJ0aWFsOiBBc3Npc3RhbnRNZXNzYWdlO1xuXHQvKiogTWFwIGZyb20gc3RyZWFtLWV2ZW50IGBpbmRleGAgdG8gb3VyIGNvbnRlbnQgYXJyYXkgaW5kZXguICovXG5cdHByaXZhdGUgaW5kZXhNYXAgPSBuZXcgTWFwPG51bWJlciwgbnVtYmVyPigpO1xuXHQvKiogQWNjdW11bGF0ZWQgSlNPTiBpbnB1dCBzdHJpbmcgcGVyIHRvb2xfdXNlIGJsb2NrIChrZXllZCBieSBzdHJlYW0gaW5kZXgpLiAqL1xuXHRwcml2YXRlIHRvb2xKc29uQWNjdW0gPSBuZXcgTWFwPG51bWJlciwgc3RyaW5nPigpO1xuXG5cdGNvbnN0cnVjdG9yKG1vZGVsOiBzdHJpbmcpIHtcblx0XHR0aGlzLnBhcnRpYWwgPSB7XG5cdFx0XHRyb2xlOiBcImFzc2lzdGFudFwiLFxuXHRcdFx0Y29udGVudDogW10sXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJjbGF1ZGUtY29kZVwiLFxuXHRcdFx0bW9kZWwsXG5cdFx0XHR1c2FnZTogeyAuLi5aRVJPX1VTQUdFIH0sXG5cdFx0XHRzdG9wUmVhc29uOiBcInN0b3BcIixcblx0XHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0XHR9O1xuXHR9XG5cblx0Z2V0IG1lc3NhZ2UoKTogQXNzaXN0YW50TWVzc2FnZSB7XG5cdFx0cmV0dXJuIHRoaXMucGFydGlhbDtcblx0fVxuXG5cdC8qKlxuXHQgKiBGZWVkIGEgQmV0YVJhd01lc3NhZ2VTdHJlYW1FdmVudCBhbmQgcmV0dXJuIHRoZSBjb3JyZXNwb25kaW5nXG5cdCAqIEFzc2lzdGFudE1lc3NhZ2VFdmVudCAob3IgbnVsbCBpZiB0aGUgZXZlbnQgaXMgbm90IG1hcHBlZCkuXG5cdCAqL1xuXHRoYW5kbGVFdmVudChldmVudDogQmV0YVJhd01lc3NhZ2VTdHJlYW1FdmVudCk6IEFzc2lzdGFudE1lc3NhZ2VFdmVudCB8IG51bGwge1xuXHRcdGNvbnN0IHN0cmVhbUluZGV4ID0gZXZlbnQuaW5kZXggPz8gMDtcblxuXHRcdHN3aXRjaCAoZXZlbnQudHlwZSkge1xuXHRcdFx0Ly8gLS0tLSBCbG9jayBzdGFydCAtLS0tXG5cdFx0XHRjYXNlIFwiY29udGVudF9ibG9ja19zdGFydFwiOiB7XG5cdFx0XHRcdGNvbnN0IGJsb2NrID0gZXZlbnQuY29udGVudF9ibG9jaztcblx0XHRcdFx0aWYgKCFibG9jaykgcmV0dXJuIG51bGw7XG5cblx0XHRcdFx0Y29uc3QgY29udGVudEluZGV4ID0gdGhpcy5wYXJ0aWFsLmNvbnRlbnQubGVuZ3RoO1xuXHRcdFx0XHR0aGlzLmluZGV4TWFwLnNldChzdHJlYW1JbmRleCwgY29udGVudEluZGV4KTtcblxuXHRcdFx0XHRpZiAoYmxvY2sudHlwZSA9PT0gXCJ0ZXh0XCIpIHtcblx0XHRcdFx0XHR0aGlzLnBhcnRpYWwuY29udGVudC5wdXNoKHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiXCIgfSk7XG5cdFx0XHRcdFx0cmV0dXJuIHsgdHlwZTogXCJ0ZXh0X3N0YXJ0XCIsIGNvbnRlbnRJbmRleCwgcGFydGlhbDogdGhpcy5wYXJ0aWFsIH07XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKGJsb2NrLnR5cGUgPT09IFwidGhpbmtpbmdcIikge1xuXHRcdFx0XHRcdHRoaXMucGFydGlhbC5jb250ZW50LnB1c2goeyB0eXBlOiBcInRoaW5raW5nXCIsIHRoaW5raW5nOiBcIlwiIH0pO1xuXHRcdFx0XHRcdHJldHVybiB7IHR5cGU6IFwidGhpbmtpbmdfc3RhcnRcIiwgY29udGVudEluZGV4LCBwYXJ0aWFsOiB0aGlzLnBhcnRpYWwgfTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoYmxvY2sudHlwZSA9PT0gXCJ0b29sX3VzZVwiKSB7XG5cdFx0XHRcdFx0dGhpcy50b29sSnNvbkFjY3VtLnNldChzdHJlYW1JbmRleCwgXCJcIik7XG5cdFx0XHRcdFx0dGhpcy5wYXJ0aWFsLmNvbnRlbnQucHVzaCh0b29sQ2FsbEZyb21CbG9jayhibG9jay5pZCwgYmxvY2submFtZSwge30pKTtcblx0XHRcdFx0XHRyZXR1cm4geyB0eXBlOiBcInRvb2xjYWxsX3N0YXJ0XCIsIGNvbnRlbnRJbmRleCwgcGFydGlhbDogdGhpcy5wYXJ0aWFsIH07XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKGJsb2NrLnR5cGUgPT09IFwic2VydmVyX3Rvb2xfdXNlXCIpIHtcblx0XHRcdFx0XHR0aGlzLnBhcnRpYWwuY29udGVudC5wdXNoKHtcblx0XHRcdFx0XHRcdHR5cGU6IFwic2VydmVyVG9vbFVzZVwiLFxuXHRcdFx0XHRcdFx0aWQ6IGJsb2NrLmlkLFxuXHRcdFx0XHRcdFx0bmFtZTogYmxvY2submFtZSxcblx0XHRcdFx0XHRcdGlucHV0OiBibG9jay5pbnB1dCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRyZXR1cm4geyB0eXBlOiBcInNlcnZlcl90b29sX3VzZVwiLCBjb250ZW50SW5kZXgsIHBhcnRpYWw6IHRoaXMucGFydGlhbCB9O1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiBudWxsO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyAtLS0tIEJsb2NrIGRlbHRhIC0tLS1cblx0XHRcdGNhc2UgXCJjb250ZW50X2Jsb2NrX2RlbHRhXCI6IHtcblx0XHRcdFx0Y29uc3QgY29udGVudEluZGV4ID0gdGhpcy5pbmRleE1hcC5nZXQoc3RyZWFtSW5kZXgpO1xuXHRcdFx0XHRpZiAoY29udGVudEluZGV4ID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuXHRcdFx0XHRjb25zdCBkZWx0YSA9IGV2ZW50LmRlbHRhO1xuXHRcdFx0XHRpZiAoIWRlbHRhKSByZXR1cm4gbnVsbDtcblxuXHRcdFx0XHRpZiAoZGVsdGEudHlwZSA9PT0gXCJ0ZXh0X2RlbHRhXCIgJiYgdHlwZW9mIGRlbHRhLnRleHQgPT09IFwic3RyaW5nXCIpIHtcblx0XHRcdFx0XHRjb25zdCBleGlzdGluZyA9IHRoaXMucGFydGlhbC5jb250ZW50W2NvbnRlbnRJbmRleF0gYXMgVGV4dENvbnRlbnQ7XG5cdFx0XHRcdFx0ZXhpc3RpbmcudGV4dCArPSBkZWx0YS50ZXh0O1xuXHRcdFx0XHRcdHJldHVybiB7IHR5cGU6IFwidGV4dF9kZWx0YVwiLCBjb250ZW50SW5kZXgsIGRlbHRhOiBkZWx0YS50ZXh0LCBwYXJ0aWFsOiB0aGlzLnBhcnRpYWwgfTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoZGVsdGEudHlwZSA9PT0gXCJ0aGlua2luZ19kZWx0YVwiICYmIHR5cGVvZiBkZWx0YS50aGlua2luZyA9PT0gXCJzdHJpbmdcIikge1xuXHRcdFx0XHRcdGNvbnN0IGV4aXN0aW5nID0gdGhpcy5wYXJ0aWFsLmNvbnRlbnRbY29udGVudEluZGV4XSBhcyBUaGlua2luZ0NvbnRlbnQ7XG5cdFx0XHRcdFx0ZXhpc3RpbmcudGhpbmtpbmcgKz0gZGVsdGEudGhpbmtpbmc7XG5cdFx0XHRcdFx0cmV0dXJuIHsgdHlwZTogXCJ0aGlua2luZ19kZWx0YVwiLCBjb250ZW50SW5kZXgsIGRlbHRhOiBkZWx0YS50aGlua2luZywgcGFydGlhbDogdGhpcy5wYXJ0aWFsIH07XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKGRlbHRhLnR5cGUgPT09IFwiaW5wdXRfanNvbl9kZWx0YVwiICYmIHR5cGVvZiBkZWx0YS5wYXJ0aWFsX2pzb24gPT09IFwic3RyaW5nXCIpIHtcblx0XHRcdFx0XHRjb25zdCBhY2N1bSA9ICh0aGlzLnRvb2xKc29uQWNjdW0uZ2V0KHN0cmVhbUluZGV4KSA/PyBcIlwiKSArIGRlbHRhLnBhcnRpYWxfanNvbjtcblx0XHRcdFx0XHR0aGlzLnRvb2xKc29uQWNjdW0uc2V0KHN0cmVhbUluZGV4LCBhY2N1bSk7XG5cdFx0XHRcdFx0cmV0dXJuIHsgdHlwZTogXCJ0b29sY2FsbF9kZWx0YVwiLCBjb250ZW50SW5kZXgsIGRlbHRhOiBkZWx0YS5wYXJ0aWFsX2pzb24sIHBhcnRpYWw6IHRoaXMucGFydGlhbCB9O1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiBudWxsO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyAtLS0tIEJsb2NrIHN0b3AgLS0tLVxuXHRcdFx0Y2FzZSBcImNvbnRlbnRfYmxvY2tfc3RvcFwiOiB7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnRJbmRleCA9IHRoaXMuaW5kZXhNYXAuZ2V0KHN0cmVhbUluZGV4KTtcblx0XHRcdFx0aWYgKGNvbnRlbnRJbmRleCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbnVsbDtcblx0XHRcdFx0Y29uc3QgYmxvY2sgPSB0aGlzLnBhcnRpYWwuY29udGVudFtjb250ZW50SW5kZXhdO1xuXG5cdFx0XHRcdGlmIChibG9jay50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHRcdHJldHVybiB7IHR5cGU6IFwidGV4dF9lbmRcIiwgY29udGVudEluZGV4LCBjb250ZW50OiBibG9jay50ZXh0LCBwYXJ0aWFsOiB0aGlzLnBhcnRpYWwgfTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoYmxvY2sudHlwZSA9PT0gXCJ0aGlua2luZ1wiKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHsgdHlwZTogXCJ0aGlua2luZ19lbmRcIiwgY29udGVudEluZGV4LCBjb250ZW50OiBibG9jay50aGlua2luZywgcGFydGlhbDogdGhpcy5wYXJ0aWFsIH07XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKGJsb2NrLnR5cGUgPT09IFwidG9vbENhbGxcIikge1xuXHRcdFx0XHRcdGNvbnN0IGpzb25TdHIgPSB0aGlzLnRvb2xKc29uQWNjdW0uZ2V0KHN0cmVhbUluZGV4KSA/PyBcInt9XCI7XG5cdFx0XHRcdFx0Y29uc3QganNvbkZvclBhcnNlID0gaGFzWG1sUGFyYW1ldGVyVGFncyhqc29uU3RyKSA/IHJlcGFpclRvb2xKc29uKGpzb25TdHIpIDoganNvblN0cjtcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0YmxvY2suYXJndW1lbnRzID0gSlNPTi5wYXJzZShqc29uRm9yUGFyc2UpO1xuXHRcdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdFx0Ly8gSlNPTi5wYXJzZSBmYWlsZWQgXHUyMDE0IGF0dGVtcHQgcmVwYWlyIGZvciBZQU1MLXN0eWxlIGJ1bGxldFxuXHRcdFx0XHRcdFx0Ly8gbGlzdHMgdGhhdCBMTE1zIGNvcHkgZnJvbSB0ZW1wbGF0ZSBmb3JtYXR0aW5nICgjMjY2MCkuXG5cdFx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0XHRibG9jay5hcmd1bWVudHMgPSBKU09OLnBhcnNlKHJlcGFpclRvb2xKc29uKGpzb25Gb3JQYXJzZSkpO1xuXHRcdFx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0XHRcdC8vIFJlcGFpciBhbHNvIGZhaWxlZCBcdTIwMTQgc3RyZWFtIHdhcyB0cnVuY2F0ZWQgb3IgZ2FyYmFnZS5cblx0XHRcdFx0XHRcdFx0Ly8gUHJlc2VydmUgdGhlIHJhdyBzdHJpbmcgZm9yIGRpYWdub3N0aWNzIGJ1dCBzaWduYWwgdGhlXG5cdFx0XHRcdFx0XHRcdC8vIG1hbGZvcm1hdGlvbiBleHBsaWNpdGx5IHNvIGRvd25zdHJlYW0gY29uc3VtZXJzIGNhblxuXHRcdFx0XHRcdFx0XHQvLyBkaXN0aW5ndWlzaCB0aGlzIGZyb20gYSBoZWFsdGh5IHRvb2wgY29tcGxldGlvbiAoIzI1NzQpLlxuXHRcdFx0XHRcdFx0XHRibG9jay5hcmd1bWVudHMgPSB7IF9yYXc6IGpzb25TdHIgfTtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHsgdHlwZTogXCJ0b29sY2FsbF9lbmRcIiwgY29udGVudEluZGV4LCB0b29sQ2FsbDogYmxvY2ssIHBhcnRpYWw6IHRoaXMucGFydGlhbCwgbWFsZm9ybWVkQXJndW1lbnRzOiB0cnVlIH07XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdHJldHVybiB7IHR5cGU6IFwidG9vbGNhbGxfZW5kXCIsIGNvbnRlbnRJbmRleCwgdG9vbENhbGw6IGJsb2NrLCBwYXJ0aWFsOiB0aGlzLnBhcnRpYWwgfTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4gbnVsbDtcblx0XHRcdH1cblxuXHRcdFx0ZGVmYXVsdDpcblx0XHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0fVxuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFrQkEsU0FBUyxxQkFBcUIsc0JBQXNCO0FBYzdDLFNBQVMsaUJBQWlCLE1BQXVEO0FBQ3ZGLE1BQUksQ0FBQyxLQUFLLFdBQVcsT0FBTyxFQUFHLFFBQU87QUFDdEMsUUFBTSxPQUFPLEtBQUssTUFBTSxRQUFRLE1BQU07QUFDdEMsUUFBTSxRQUFRLEtBQUssUUFBUSxJQUFJO0FBQy9CLE1BQUksU0FBUyxLQUFLLFVBQVUsS0FBSyxTQUFTLEVBQUcsUUFBTztBQUNwRCxTQUFPLEVBQUUsUUFBUSxLQUFLLE1BQU0sR0FBRyxLQUFLLEdBQUcsTUFBTSxLQUFLLE1BQU0sUUFBUSxDQUFDLEVBQUU7QUFDcEU7QUFRQSxTQUFTLGtCQUNSLElBQ0EsU0FDQSxPQUNXO0FBQ1gsUUFBTSxTQUFTLGlCQUFpQixPQUFPO0FBQ3ZDLFFBQU0sV0FBcUI7QUFBQSxJQUMxQixNQUFNO0FBQUEsSUFDTjtBQUFBLElBQ0Es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
