function wrapRegisteredTool(registeredTool, runner) {
  const { definition } = registeredTool;
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    execute: (toolCallId, params, signal, onUpdate) => definition.execute(toolCallId, params, signal, onUpdate, runner.createContext())
  };
}
function wrapRegisteredTools(registeredTools, runner) {
  return registeredTools.map((rt) => wrapRegisteredTool(rt, runner));
}
function wrapToolWithExtensions(tool, runner) {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      if (tool.name === "bash" && runner.hasHandlers("bash_transform")) {
        const input = params;
        if (typeof input.command === "string") {
          const transformed = await runner.emitBashTransform(input.command, input.cwd ?? "");
          params = { ...params, command: transformed };
        }
      }
      if (runner.hasHandlers("tool_call")) {
        try {
          const callResult = await runner.emitToolCall({
            type: "tool_call",
            toolName: tool.name,
            toolCallId,
            input: params
          });
          if (callResult?.block) {
            const reason = callResult.reason || "Tool execution was blocked by an extension";
            throw new Error(reason);
          }
        } catch (err) {
          if (err instanceof Error) {
            throw err;
          }
          throw new Error(`Extension failed, blocking execution: ${String(err)}`);
        }
      }
      try {
        const result = await tool.execute(toolCallId, params, signal, onUpdate);
        if (runner.hasHandlers("tool_result")) {
          const resultResult = await runner.emitToolResult({
            type: "tool_result",
            toolName: tool.name,
            toolCallId,
            input: params,
            content: result.content,
            details: result.details,
            isError: false
          });
          if (resultResult) {
            return {
              content: resultResult.content ?? result.content,
              details: resultResult.details ?? result.details
            };
          }
        }
        return result;
      } catch (err) {
        if (runner.hasHandlers("tool_result")) {
          await runner.emitToolResult({
            type: "tool_result",
            toolName: tool.name,
            toolCallId,
            input: params,
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            details: void 0,
            isError: true
          });
        }
        throw err;
      }
    }
  };
}
function wrapToolsWithExtensions(tools, runner) {
  return tools.map((tool) => wrapToolWithExtensions(tool, runner));
}
export {
  wrapRegisteredTool,
  wrapRegisteredTools,
  wrapToolWithExtensions,
  wrapToolsWithExtensions
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2V4dGVuc2lvbnMvd3JhcHBlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBUb29sIHdyYXBwZXJzIGZvciBleHRlbnNpb25zLlxuICovXG5cbmltcG9ydCB0eXBlIHsgQWdlbnRUb29sLCBBZ2VudFRvb2xVcGRhdGVDYWxsYmFjayB9IGZyb20gXCJAZ3NkL3BpLWFnZW50LWNvcmVcIjtcbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uUnVubmVyIH0gZnJvbSBcIi4vcnVubmVyLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFJlZ2lzdGVyZWRUb29sLCBUb29sQ2FsbEV2ZW50UmVzdWx0IH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcblxuLyoqXG4gKiBXcmFwIGEgUmVnaXN0ZXJlZFRvb2wgaW50byBhbiBBZ2VudFRvb2wuXG4gKiBVc2VzIHRoZSBydW5uZXIncyBjcmVhdGVDb250ZXh0KCkgZm9yIGNvbnNpc3RlbnQgY29udGV4dCBhY3Jvc3MgdG9vbHMgYW5kIGV2ZW50IGhhbmRsZXJzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd3JhcFJlZ2lzdGVyZWRUb29sKHJlZ2lzdGVyZWRUb29sOiBSZWdpc3RlcmVkVG9vbCwgcnVubmVyOiBFeHRlbnNpb25SdW5uZXIpOiBBZ2VudFRvb2wge1xuXHRjb25zdCB7IGRlZmluaXRpb24gfSA9IHJlZ2lzdGVyZWRUb29sO1xuXHRyZXR1cm4ge1xuXHRcdG5hbWU6IGRlZmluaXRpb24ubmFtZSxcblx0XHRsYWJlbDogZGVmaW5pdGlvbi5sYWJlbCxcblx0XHRkZXNjcmlwdGlvbjogZGVmaW5pdGlvbi5kZXNjcmlwdGlvbixcblx0XHRwYXJhbWV0ZXJzOiBkZWZpbml0aW9uLnBhcmFtZXRlcnMsXG5cdFx0ZXhlY3V0ZTogKHRvb2xDYWxsSWQsIHBhcmFtcywgc2lnbmFsLCBvblVwZGF0ZSkgPT5cblx0XHRcdGRlZmluaXRpb24uZXhlY3V0ZSh0b29sQ2FsbElkLCBwYXJhbXMsIHNpZ25hbCwgb25VcGRhdGUsIHJ1bm5lci5jcmVhdGVDb250ZXh0KCkpLFxuXHR9O1xufVxuXG4vKipcbiAqIFdyYXAgYWxsIHJlZ2lzdGVyZWQgdG9vbHMgaW50byBBZ2VudFRvb2xzLlxuICogVXNlcyB0aGUgcnVubmVyJ3MgY3JlYXRlQ29udGV4dCgpIGZvciBjb25zaXN0ZW50IGNvbnRleHQgYWNyb3NzIHRvb2xzIGFuZCBldmVudCBoYW5kbGVycy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyYXBSZWdpc3RlcmVkVG9vbHMocmVnaXN0ZXJlZFRvb2xzOiBSZWdpc3RlcmVkVG9vbFtdLCBydW5uZXI6IEV4dGVuc2lvblJ1bm5lcik6IEFnZW50VG9vbFtdIHtcblx0cmV0dXJuIHJlZ2lzdGVyZWRUb29scy5tYXAoKHJ0KSA9PiB3cmFwUmVnaXN0ZXJlZFRvb2wocnQsIHJ1bm5lcikpO1xufVxuXG4vKipcbiAqIFdyYXAgYSB0b29sIHdpdGggZXh0ZW5zaW9uIGNhbGxiYWNrcyBmb3IgaW50ZXJjZXB0aW9uLlxuICogLSBFbWl0cyB0b29sX2NhbGwgZXZlbnQgYmVmb3JlIGV4ZWN1dGlvbiAoY2FuIGJsb2NrKVxuICogLSBFbWl0cyB0b29sX3Jlc3VsdCBldmVudCBhZnRlciBleGVjdXRpb24gKGNhbiBtb2RpZnkgcmVzdWx0KVxuICovXG5leHBvcnQgZnVuY3Rpb24gd3JhcFRvb2xXaXRoRXh0ZW5zaW9uczxUPih0b29sOiBBZ2VudFRvb2w8YW55LCBUPiwgcnVubmVyOiBFeHRlbnNpb25SdW5uZXIpOiBBZ2VudFRvb2w8YW55LCBUPiB7XG5cdHJldHVybiB7XG5cdFx0Li4udG9vbCxcblx0XHRleGVjdXRlOiBhc3luYyAoXG5cdFx0XHR0b29sQ2FsbElkOiBzdHJpbmcsXG5cdFx0XHRwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuXHRcdFx0c2lnbmFsPzogQWJvcnRTaWduYWwsXG5cdFx0XHRvblVwZGF0ZT86IEFnZW50VG9vbFVwZGF0ZUNhbGxiYWNrPFQ+LFxuXHRcdCkgPT4ge1xuXHRcdFx0Ly8gRm9yIGJhc2ggdG9vbCBjYWxscywgbGV0IGV4dGVuc2lvbnMgdHJhbnNmb3JtIHRoZSBjb21tYW5kIGJlZm9yZSBleGVjdXRpb25cblx0XHRcdGlmICh0b29sLm5hbWUgPT09IFwiYmFzaFwiICYmIHJ1bm5lci5oYXNIYW5kbGVycyhcImJhc2hfdHJhbnNmb3JtXCIpKSB7XG5cdFx0XHRcdGNvbnN0IGlucHV0ID0gcGFyYW1zIGFzIHsgY29tbWFuZD86IHN0cmluZzsgY3dkPzogc3RyaW5nIH07XG5cdFx0XHRcdGlmICh0eXBlb2YgaW5wdXQuY29tbWFuZCA9PT0gXCJzdHJpbmdcIikge1xuXHRcdFx0XHRcdGNvbnN0IHRyYW5zZm9ybWVkID0gYXdhaXQgcnVubmVyLmVtaXRCYXNoVHJhbnNmb3JtKGlucHV0LmNvbW1hbmQsIGlucHV0LmN3ZCA/PyBcIlwiKTtcblx0XHRcdFx0XHRwYXJhbXMgPSB7IC4uLnBhcmFtcywgY29tbWFuZDogdHJhbnNmb3JtZWQgfTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQvLyBFbWl0IHRvb2xfY2FsbCBldmVudCAtIGV4dGVuc2lvbnMgY2FuIGJsb2NrIGV4ZWN1dGlvblxuXHRcdFx0aWYgKHJ1bm5lci5oYXNIYW5kbGVycyhcInRvb2xfY2FsbFwiKSkge1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGNvbnN0IGNhbGxSZXN1bHQgPSAoYXdhaXQgcnVubmVyLmVtaXRUb29sQ2FsbCh7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRvb2xfY2FsbFwiLFxuXHRcdFx0XHRcdFx0dG9vbE5hbWU6IHRvb2wubmFtZSxcblx0XHRcdFx0XHRcdHRvb2xDYWxsSWQsXG5cdFx0XHRcdFx0XHRpbnB1dDogcGFyYW1zLFxuXHRcdFx0XHRcdH0pKSBhcyBUb29sQ2FsbEV2ZW50UmVzdWx0IHwgdW5kZWZpbmVkO1xuXG5cdFx0XHRcdFx0aWYgKGNhbGxSZXN1bHQ/LmJsb2NrKSB7XG5cdFx0XHRcdFx0XHRjb25zdCByZWFzb24gPSBjYWxsUmVzdWx0LnJlYXNvbiB8fCBcIlRvb2wgZXhlY3V0aW9uIHdhcyBibG9ja2VkIGJ5IGFuIGV4dGVuc2lvblwiO1xuXHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKHJlYXNvbik7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0XHRpZiAoZXJyIGluc3RhbmNlb2YgRXJyb3IpIHtcblx0XHRcdFx0XHRcdHRocm93IGVycjtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBFeHRlbnNpb24gZmFpbGVkLCBibG9ja2luZyBleGVjdXRpb246ICR7U3RyaW5nKGVycil9YCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Ly8gRXhlY3V0ZSB0aGUgYWN0dWFsIHRvb2xcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRvb2wuZXhlY3V0ZSh0b29sQ2FsbElkLCBwYXJhbXMsIHNpZ25hbCwgb25VcGRhdGUpO1xuXG5cdFx0XHRcdC8vIEVtaXQgdG9vbF9yZXN1bHQgZXZlbnQgLSBleHRlbnNpb25zIGNhbiBtb2RpZnkgdGhlIHJlc3VsdFxuXHRcdFx0XHRpZiAocnVubmVyLmhhc0hhbmRsZXJzKFwidG9vbF9yZXN1bHRcIikpIHtcblx0XHRcdFx0XHRjb25zdCByZXN1bHRSZXN1bHQgPSBhd2FpdCBydW5uZXIuZW1pdFRvb2xSZXN1bHQoe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJ0b29sX3Jlc3VsdFwiLFxuXHRcdFx0XHRcdFx0dG9vbE5hbWU6IHRvb2wubmFtZSxcblx0XHRcdFx0XHRcdHRvb2xDYWxsSWQsXG5cdFx0XHRcdFx0XHRpbnB1dDogcGFyYW1zLFxuXHRcdFx0XHRcdFx0Y29udGVudDogcmVzdWx0LmNvbnRlbnQsXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiByZXN1bHQuZGV0YWlscyxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IGZhbHNlLFxuXHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0aWYgKHJlc3VsdFJlc3VsdCkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogcmVzdWx0UmVzdWx0LmNvbnRlbnQgPz8gcmVzdWx0LmNvbnRlbnQsXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IChyZXN1bHRSZXN1bHQuZGV0YWlscyA/PyByZXN1bHQuZGV0YWlscykgYXMgVCxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cblx0XHRcdFx0cmV0dXJuIHJlc3VsdDtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHQvLyBFbWl0IHRvb2xfcmVzdWx0IGV2ZW50IGZvciBlcnJvcnNcblx0XHRcdFx0aWYgKHJ1bm5lci5oYXNIYW5kbGVycyhcInRvb2xfcmVzdWx0XCIpKSB7XG5cdFx0XHRcdFx0YXdhaXQgcnVubmVyLmVtaXRUb29sUmVzdWx0KHtcblx0XHRcdFx0XHRcdHR5cGU6IFwidG9vbF9yZXN1bHRcIixcblx0XHRcdFx0XHRcdHRvb2xOYW1lOiB0b29sLm5hbWUsXG5cdFx0XHRcdFx0XHR0b29sQ2FsbElkLFxuXHRcdFx0XHRcdFx0aW5wdXQ6IHBhcmFtcyxcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycikgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHRocm93IGVycjtcblx0XHRcdH1cblx0XHR9LFxuXHR9O1xufVxuXG4vKipcbiAqIFdyYXAgYWxsIHRvb2xzIHdpdGggZXh0ZW5zaW9uIGNhbGxiYWNrcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdyYXBUb29sc1dpdGhFeHRlbnNpb25zPFQ+KHRvb2xzOiBBZ2VudFRvb2w8YW55LCBUPltdLCBydW5uZXI6IEV4dGVuc2lvblJ1bm5lcik6IEFnZW50VG9vbDxhbnksIFQ+W10ge1xuXHRyZXR1cm4gdG9vbHMubWFwKCh0b29sKSA9PiB3cmFwVG9vbFdpdGhFeHRlbnNpb25zKHRvb2wsIHJ1bm5lcikpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBWU8sU0FBUyxtQkFBbUIsZ0JBQWdDLFFBQW9DO0FBQ3RHLFFBQU0sRUFBRSxXQUFXLElBQUk7QUFDdkIsU0FBTztBQUFBLElBQ04sTUFBTSxXQUFXO0FBQUEsSUFDakIsT0FBTyxXQUFXO0FBQUEsSUFDbEIsYUFBYSxXQUFXO0FBQUEsSUFDeEIsWUFBWSxXQUFXO0FBQUEsSUFDdkIsU0FBUyxDQUFDLFlBQVksUUFBUSxRQUFRLGFBQ3JDLFdBQVcsUUFBUSxZQUFZLFFBQVEsUUFBUSxVQUFVLE9BQU8sY0FBYyxDQUFDO0FBQUEsRUFDakY7QUFDRDtBQU1PLFNBQVMsb0JBQW9CLGlCQUFtQyxRQUFzQztBQUM1RyxTQUFPLGdCQUFnQixJQUFJLENBQUMsT0FBTyxtQkFBbUIsSUFBSSxNQUFNLENBQUM7QUFDbEU7QUFPTyxTQUFTLHVCQUEwQixNQUF5QixRQUE0QztBQUM5RyxTQUFPO0FBQUEsSUFDTixHQUFHO0FBQUEsSUFDSCxTQUFTLE9BQ1IsWUFDQSxRQUNBLFFBQ0EsYUFDSTtBQUVKLFVBQUksS0FBSyxTQUFTLFVBQVUsT0FBTyxZQUFZLGdCQUFnQixHQUFHO0FBQ2pFLGNBQU0sUUFBUTtBQUNkLFlBQUksT0FBTyxNQUFNLFlBQVksVUFBVTtBQUN0QyxnQkFBTSxjQUFjLE1BQU0sT0FBTyxrQkFBa0IsTUFBTSxTQUFTLE1BQU0sT0FBTyxFQUFFO0FBQ2pGLG1CQUFTLEVBQUUsR0FBRyxRQUFRLFNBQVMsWUFBWTtBQUFBLFFBQzVDO0FBQUEsTUFDRDtBQUdBLFVBQUksT0FBTyxZQUFZLFdBQVcsR0FBRztBQUNwQyxZQUFJO0FBQ0gsZ0JBQU0sYUFBYyxNQUFNLE9BQU8sYUFBYTtBQUFBLFlBQzdDLE1BQU07QUFBQSxZQUNOLFVBQVUsS0FBSztBQUFBLFlBQ2Y7QUFBQSxZQUNBLE9BQU87QUFBQSxVQUNSLENBQUM7QUFFRCxjQUFJLFlBQVksT0FBTztBQUN0QixrQkFBTSxTQUFTLFdBQVcsVUFBVTtBQUNwQyxrQkFBTSxJQUFJLE1BQU0sTUFBTTtBQUFBLFVBQ3ZCO0FBQUEsUUFDRCxTQUFTLEtBQUs7QUFDYixjQUFJLGVBQWUsT0FBTztBQUN6QixrQkFBTTtBQUFBLFVBQ1A7QUFDQSxnQkFBTSxJQUFJLE1BQU0seUNBQXlDLE9BQU8sR0FBRyxDQUFDLEVBQUU7QUFBQSxRQUN2RTtBQUFBLE1BQ0Q7QUFHQSxVQUFJO0FBQ0gsY0FBTSxTQUFTLE1BQU0sS0FBSyxRQUFRLFlBQVksUUFBUSxRQUFRLFFBQVE7QUFHdEUsWUFBSSxPQUFPLFlBQVksYUFBYSxHQUFHO0FBQ3RDLGdCQUFNLGVBQWUsTUFBTSxPQUFPLGVBQWU7QUFBQSxZQUNoRCxNQUFNO0FBQUEsWUFDTixVQUFVLEtBQUs7QUFBQSxZQUNmO0FBQUEsWUFDQSxPQUFPO0FBQUEsWUFDUCxTQUFTLE9BQU87QUFBQSxZQUNoQixTQUFTLE9BQU87QUFBQSxZQUNoQixTQUFTO0FBQUEsVUFDVixDQUFDO0FBRUQsY0FBSSxjQUFjO0FBQ2pCLG1CQUFPO0FBQUEsY0FDTixTQUFTLGFBQWEsV0FBVyxPQUFPO0FBQUEsY0FDeEMsU0FBVSxhQUFhLFdBQVcsT0FBTztBQUFBLFlBQzFDO0FBQUEsVUFDRDtBQUFBLFFBQ0Q7QUFFQSxlQUFPO0FBQUEsTUFDUixTQUFTLEtBQUs7QUFFYixZQUFJLE9BQU8sWUFBWSxhQUFhLEdBQUc7QUFDdEMsZ0JBQU0sT0FBTyxlQUFlO0FBQUEsWUFDM0IsTUFBTTtBQUFBLFlBQ04sVUFBVSxLQUFLO0FBQUEsWUFDZjtBQUFBLFlBQ0EsT0FBTztBQUFBLFlBQ1AsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUcsRUFBRSxDQUFDO0FBQUEsWUFDbEYsU0FBUztBQUFBLFlBQ1QsU0FBUztBQUFBLFVBQ1YsQ0FBQztBQUFBLFFBQ0Y7QUFDQSxjQUFNO0FBQUEsTUFDUDtBQUFBLElBQ0Q7QUFBQSxFQUNEO0FBQ0Q7QUFLTyxTQUFTLHdCQUEyQixPQUE0QixRQUE4QztBQUNwSCxTQUFPLE1BQU0sSUFBSSxDQUFDLFNBQVMsdUJBQXVCLE1BQU0sTUFBTSxDQUFDO0FBQ2hFOyIsCiAgIm5hbWVzIjogW10KfQo=
