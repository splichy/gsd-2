import {
  EventStream,
  streamSimple,
  validateToolArguments
} from "@gsd/pi-ai";
import { maybeLogTokenAudit } from "./token-audit.js";
const MAX_CONSECUTIVE_VALIDATION_FAILURES = 3;
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};
function createErrorMessage(error, config) {
  const msg = error instanceof Error ? error.message : String(error);
  return {
    role: "assistant",
    content: [{ type: "text", text: msg }],
    api: config.model.api,
    provider: config.model.provider,
    model: config.model.id,
    usage: ZERO_USAGE,
    stopReason: "error",
    errorMessage: msg,
    timestamp: Date.now()
  };
}
function emitMessagePair(stream, message) {
  stream.push({ type: "message_start", message });
  stream.push({ type: "message_end", message });
}
function emitErrorSequence(stream, errMsg, newMessages) {
  emitMessagePair(stream, errMsg);
  stream.push({ type: "turn_end", message: errMsg, toolResults: [] });
  stream.push({ type: "agent_end", messages: [...newMessages, errMsg] });
  stream.end([...newMessages, errMsg]);
}
function agentLoop(prompts, context, config, signal, streamFn) {
  const stream = createAgentStream();
  (async () => {
    const newMessages = [...prompts];
    const currentContext = {
      ...context,
      messages: [...context.messages, ...prompts]
    };
    stream.push({ type: "agent_start" });
    stream.push({ type: "turn_start" });
    for (const prompt of prompts) {
      emitMessagePair(stream, prompt);
    }
    try {
      await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
    } catch (error) {
      emitErrorSequence(stream, createErrorMessage(error, config), newMessages);
    }
  })();
  return stream;
}
function agentLoopContinue(context, config, signal, streamFn) {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }
  if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }
  const stream = createAgentStream();
  (async () => {
    const newMessages = [];
    const currentContext = {
      ...context,
      messages: [...context.messages]
    };
    stream.push({ type: "agent_start" });
    stream.push({ type: "turn_start" });
    try {
      await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
    } catch (error) {
      emitErrorSequence(stream, createErrorMessage(error, config), newMessages);
    }
  })();
  return stream;
}
function createAgentStream() {
  return new EventStream(
    (event) => event.type === "agent_end",
    (event) => event.type === "agent_end" ? event.messages : []
  );
}
async function runLoop(currentContext, newMessages, config, signal, stream, streamFn) {
  let firstTurn = true;
  let pendingMessages = await config.getSteeringMessages?.() || [];
  let consecutiveAllToolErrorTurns = 0;
  while (true) {
    let hasMoreToolCalls = true;
    let steeringAfterTools = null;
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        stream.push({ type: "turn_start" });
      } else {
        firstTurn = false;
      }
      if (pendingMessages.length > 0) {
        for (const message2 of pendingMessages) {
          emitMessagePair(stream, message2);
          currentContext.messages.push(message2);
          newMessages.push(message2);
        }
        pendingMessages = [];
      }
      let message;
      try {
        message = await streamAssistantResponse(currentContext, config, signal, stream, streamFn);
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        if (config.onStreamError) {
          try {
            await config.onStreamError(
              {
                error: error instanceof Error ? error : new Error(errorText),
                partialText: "",
                willRetry: false
              },
              signal
            );
          } catch {
          }
        }
        message = {
          role: "assistant",
          content: [],
          api: config.model.api,
          provider: config.model.provider,
          model: config.model.id,
          usage: ZERO_USAGE,
          stopReason: signal?.aborted ? "aborted" : "error",
          errorMessage: errorText,
          timestamp: Date.now()
        };
        stream.push({ type: "message_start", message: { ...message } });
        stream.push({ type: "message_end", message });
        currentContext.messages.push(message);
      }
      newMessages.push(message);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "turn_end", message, toolResults: [] });
        stream.push({ type: "agent_end", messages: newMessages });
        stream.end(newMessages);
        return;
      }
      const toolCalls = message.content.filter((c) => c.type === "toolCall");
      hasMoreToolCalls = toolCalls.length > 0 || message.stopReason === "pauseTurn";
      const toolResults = [];
      if (hasMoreToolCalls && config.externalToolExecution) {
        for (const tc of toolCalls) {
          const externalResult = tc.externalResult;
          stream.push({
            type: "tool_execution_start",
            toolCallId: tc.id,
            toolName: tc.name,
            args: tc.arguments
          });
          stream.push({
            type: "tool_execution_end",
            toolCallId: tc.id,
            toolName: tc.name,
            result: externalResult ? {
              content: externalResult.content ?? [{ type: "text", text: "" }],
              details: externalResult.details ?? {}
            } : {
              content: [{ type: "text", text: "(executed by Claude Code)" }],
              details: {}
            },
            isError: externalResult?.isError ?? false
          });
        }
        hasMoreToolCalls = false;
      } else if (hasMoreToolCalls) {
        const toolExecution = await executeToolCalls(
          currentContext,
          message,
          config,
          signal,
          stream
        );
        toolResults.push(...toolExecution.toolResults);
        steeringAfterTools = toolExecution.steeringMessages ?? null;
        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
        const hasPreparationErrors = toolExecution.preparationErrorCount > 0;
        const allToolsFailedPreparation = toolResults.length > 0 && toolExecution.preparationErrorCount === toolResults.length;
        if (allToolsFailedPreparation) {
          consecutiveAllToolErrorTurns++;
        } else if (!hasPreparationErrors) {
          consecutiveAllToolErrorTurns = 0;
        }
        if (consecutiveAllToolErrorTurns >= MAX_CONSECUTIVE_VALIDATION_FAILURES) {
          stream.push({ type: "turn_end", message, toolResults });
          const stopMessage = {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `Agent stopped: ${consecutiveAllToolErrorTurns} consecutive turns with all tool calls failing. This usually means the model is repeatedly sending arguments that do not match the tool schema.`
              }
            ],
            api: config.model.api,
            provider: config.model.provider,
            model: config.model.id,
            usage: ZERO_USAGE,
            stopReason: "error",
            errorMessage: "Schema overload: consecutive tool validation failures exceeded cap",
            timestamp: Date.now()
          };
          emitMessagePair(stream, stopMessage);
          newMessages.push(stopMessage);
          stream.push({ type: "turn_end", message: stopMessage, toolResults: [] });
          stream.push({ type: "agent_end", messages: newMessages });
          stream.end(newMessages);
          return;
        }
      }
      stream.push({ type: "turn_end", message, toolResults });
      if (steeringAfterTools && steeringAfterTools.length > 0) {
        pendingMessages = steeringAfterTools;
        steeringAfterTools = null;
      } else {
        pendingMessages = await config.getSteeringMessages?.() || [];
      }
    }
    const followUpMessages = await config.getFollowUpMessages?.() || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }
    break;
  }
  stream.push({ type: "agent_end", messages: newMessages });
  stream.end(newMessages);
}
async function streamAssistantResponse(context, config, signal, stream, streamFn) {
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }
  const llmMessages = await config.convertToLlm(messages);
  const tools = config.filterTools ? await config.filterTools(context.tools ?? [], signal, messages) : context.tools;
  const llmContext = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools
  };
  maybeLogTokenAudit(llmContext, messages);
  const streamFunction = streamFn || streamSimple;
  const resolvedApiKey = (config.getApiKey ? await config.getApiKey(config.model.provider) : void 0) || config.apiKey;
  const response = await streamFunction(config.model, llmContext, {
    ...config,
    apiKey: resolvedApiKey,
    signal
  });
  let partialMessage = null;
  let addedPartial = false;
  for await (const event of response) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        stream.push({ type: "message_start", message: { ...partialMessage } });
        break;
      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
      case "server_tool_use":
      case "web_search_result":
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          stream.push({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...partialMessage }
          });
        }
        break;
      case "done":
      case "error": {
        const finalMessage = await response.result();
        if (addedPartial) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
        }
        if (!addedPartial) {
          stream.push({ type: "message_start", message: { ...finalMessage } });
        }
        stream.push({ type: "message_end", message: finalMessage });
        return finalMessage;
      }
    }
  }
  return await response.result();
}
async function executeToolCalls(currentContext, assistantMessage, config, signal, stream) {
  const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
  if (config.toolExecution === "sequential") {
    return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, stream);
  }
  return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, stream);
}
async function executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, stream) {
  const results = [];
  let steeringMessages;
  let preparationErrorCount = 0;
  for (let index = 0; index < toolCalls.length; index++) {
    const toolCall = toolCalls[index];
    stream.push({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments
    });
    const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
    if (preparation.kind === "immediate") {
      if (preparation.isError) {
        preparationErrorCount++;
      }
      results.push(emitToolCallOutcome(toolCall, preparation.result, preparation.isError, stream));
    } else {
      const executed = await executePreparedToolCall(preparation, signal, stream);
      results.push(
        await finalizeExecutedToolCall(
          currentContext,
          assistantMessage,
          preparation,
          executed,
          config,
          signal,
          stream
        )
      );
    }
    if (config.getSteeringMessages) {
      const steering = await config.getSteeringMessages();
      if (steering.length > 0) {
        steeringMessages = steering;
        const remainingCalls = toolCalls.slice(index + 1);
        for (const skipped of remainingCalls) {
          results.push(skipToolCall(skipped, stream));
        }
        break;
      }
    }
  }
  return { toolResults: results, steeringMessages, preparationErrorCount };
}
async function executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, stream) {
  const results = [];
  const runnableCalls = [];
  let steeringMessages;
  let preparationErrorCount = 0;
  for (let index = 0; index < toolCalls.length; index++) {
    const toolCall = toolCalls[index];
    stream.push({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments
    });
    const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
    if (preparation.kind === "immediate") {
      if (preparation.isError) {
        preparationErrorCount++;
      }
      results.push(emitToolCallOutcome(toolCall, preparation.result, preparation.isError, stream));
    } else {
      runnableCalls.push(preparation);
    }
    if (config.getSteeringMessages) {
      const steering = await config.getSteeringMessages();
      if (steering.length > 0) {
        steeringMessages = steering;
        for (const runnable of runnableCalls) {
          results.push(skipToolCall(runnable.toolCall, stream, { emitStart: false }));
        }
        const remainingCalls = toolCalls.slice(index + 1);
        for (const skipped of remainingCalls) {
          results.push(skipToolCall(skipped, stream));
        }
        return { toolResults: results, steeringMessages, preparationErrorCount };
      }
    }
  }
  const runningCalls = runnableCalls.map((prepared) => ({
    prepared,
    execution: executePreparedToolCall(prepared, signal, stream)
  }));
  for (const running of runningCalls) {
    const executed = await running.execution;
    results.push(
      await finalizeExecutedToolCall(
        currentContext,
        assistantMessage,
        running.prepared,
        executed,
        config,
        signal,
        stream
      )
    );
  }
  if (!steeringMessages && config.getSteeringMessages) {
    const steering = await config.getSteeringMessages();
    if (steering.length > 0) {
      steeringMessages = steering;
    }
  }
  return { toolResults: results, steeringMessages, preparationErrorCount };
}
async function prepareToolCall(currentContext, assistantMessage, toolCall, config, signal) {
  const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
  if (!tool) {
    return {
      kind: "immediate",
      result: createErrorToolResult(`Tool ${toolCall.name} not found`),
      isError: true
    };
  }
  try {
    const validatedArgs = validateToolArguments(tool, toolCall);
    if (config.beforeToolCall) {
      const beforeResult = await config.beforeToolCall(
        {
          assistantMessage,
          toolCall,
          args: validatedArgs,
          context: currentContext
        },
        signal
      );
      if (beforeResult?.block) {
        return {
          kind: "immediate",
          result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
          isError: true
        };
      }
    }
    return {
      kind: "prepared",
      toolCall,
      tool,
      args: validatedArgs
    };
  } catch (error) {
    return {
      kind: "immediate",
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true
    };
  }
}
async function executePreparedToolCall(prepared, signal, stream) {
  try {
    const result = await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.args,
      signal,
      (partialResult) => {
        stream.push({
          type: "tool_execution_update",
          toolCallId: prepared.toolCall.id,
          toolName: prepared.toolCall.name,
          args: prepared.toolCall.arguments,
          partialResult
        });
      }
    );
    return { result, isError: false };
  } catch (error) {
    return {
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true
    };
  }
}
async function finalizeExecutedToolCall(currentContext, assistantMessage, prepared, executed, config, signal, stream) {
  let result = executed.result;
  let isError = executed.isError;
  if (config.afterToolCall) {
    const afterResult = await config.afterToolCall(
      {
        assistantMessage,
        toolCall: prepared.toolCall,
        args: prepared.args,
        result,
        isError,
        context: currentContext
      },
      signal
    );
    if (afterResult) {
      result = {
        content: afterResult.content !== void 0 ? afterResult.content : result.content,
        details: afterResult.details !== void 0 ? afterResult.details : result.details
      };
      isError = afterResult.isError !== void 0 ? afterResult.isError : isError;
    }
  }
  return emitToolCallOutcome(prepared.toolCall, result, isError, stream);
}
function createErrorToolResult(message) {
  return {
    content: [{ type: "text", text: message }],
    details: {}
  };
}
function emitToolCallOutcome(toolCall, result, isError, stream) {
  stream.push({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    isError
  });
  const toolResultMessage = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: result.details,
    isError,
    timestamp: Date.now()
  };
  emitMessagePair(stream, toolResultMessage);
  return toolResultMessage;
}
function skipToolCall(toolCall, stream, options) {
  const result = {
    content: [{ type: "text", text: "Skipped due to queued user message." }],
    details: {}
  };
  if (options?.emitStart !== false) {
    stream.push({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments
    });
  }
  return emitToolCallOutcome(toolCall, result, true, stream);
}
export {
  MAX_CONSECUTIVE_VALIDATION_FAILURES,
  ZERO_USAGE,
  agentLoop,
  agentLoopContinue
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWdlbnQtY29yZS9zcmMvYWdlbnQtbG9vcC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBBZ2VudCBsb29wIHRoYXQgd29ya3Mgd2l0aCBBZ2VudE1lc3NhZ2UgdGhyb3VnaG91dC5cbiAqIFRyYW5zZm9ybXMgdG8gTWVzc2FnZVtdIG9ubHkgYXQgdGhlIExMTSBjYWxsIGJvdW5kYXJ5LlxuICovXG5cbmltcG9ydCB7XG5cdHR5cGUgQXNzaXN0YW50TWVzc2FnZSxcblx0dHlwZSBDb250ZXh0LFxuXHRFdmVudFN0cmVhbSxcblx0c3RyZWFtU2ltcGxlLFxuXHR0eXBlIFRvb2xSZXN1bHRNZXNzYWdlLFxuXHR2YWxpZGF0ZVRvb2xBcmd1bWVudHMsXG59IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgdHlwZSB7XG5cdEFnZW50Q29udGV4dCxcblx0QWdlbnRFdmVudCxcblx0QWdlbnRMb29wQ29uZmlnLFxuXHRBZ2VudE1lc3NhZ2UsXG5cdEFnZW50VG9vbCxcblx0QWdlbnRUb29sQ2FsbCxcblx0QWdlbnRUb29sUmVzdWx0LFxuXHRTdHJlYW1Gbixcbn0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB7IG1heWJlTG9nVG9rZW5BdWRpdCB9IGZyb20gXCIuL3Rva2VuLWF1ZGl0LmpzXCI7XG5cbi8qKlxuICogTWF4aW11bSBudW1iZXIgb2YgY29uc2VjdXRpdmUgdHVybnMgd2hlcmUgQUxMIHRvb2wgY2FsbHMgaW4gdGhlIHR1cm4gZmFpbFxuICogc2NoZW1hIHZhbGlkYXRpb24gYmVmb3JlIHRoZSBsb29wIHRlcm1pbmF0ZXMuIFRoaXMgcHJldmVudHMgdW5ib3VuZGVkIHJldHJ5XG4gKiBsb29wcyB3aGVuIHRoZSBMTE0gcmVwZWF0ZWRseSBlbWl0cyB0b29sIGNhbGxzIHdpdGggYXJndW1lbnRzIHRoYXQgY2Fubm90XG4gKiBwYXNzIHZhbGlkYXRpb24gKGUuZy4sIHNjaGVtYSBvdmVybG9hZCwgdHJ1bmNhdGVkIEpTT04sIG1pc3NpbmcgcmVxdWlyZWRcbiAqIGZpZWxkcykuIFNlZTogaHR0cHM6Ly9naXRodWIuY29tL2dzZC1idWlsZC9nc2QtMi9pc3N1ZXMvMjc4M1xuICovXG5leHBvcnQgY29uc3QgTUFYX0NPTlNFQ1VUSVZFX1ZBTElEQVRJT05fRkFJTFVSRVMgPSAzO1xuXG5leHBvcnQgY29uc3QgWkVST19VU0FHRSA9IHtcblx0aW5wdXQ6IDAsXG5cdG91dHB1dDogMCxcblx0Y2FjaGVSZWFkOiAwLFxuXHRjYWNoZVdyaXRlOiAwLFxuXHR0b3RhbFRva2VuczogMCxcblx0Y29zdDogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIHRvdGFsOiAwIH0sXG59IGFzIGNvbnN0O1xuXG4vKipcbiAqIEJ1aWxkIGFuIEFzc2lzdGFudE1lc3NhZ2UgZm9yIGFuIHVuaGFuZGxlZCBlcnJvciBjYXVnaHQgb3V0c2lkZSBydW5Mb29wLlxuICogVXNlcyB0aGUgbW9kZWwgZnJvbSBjb25maWcgc28gdGhlIG1lc3NhZ2Ugc2F0aXNmaWVzIHRoZSBmdWxsIGludGVyZmFjZS5cbiAqL1xuZnVuY3Rpb24gY3JlYXRlRXJyb3JNZXNzYWdlKGVycm9yOiB1bmtub3duLCBjb25maWc6IEFnZW50TG9vcENvbmZpZyk6IEFzc2lzdGFudE1lc3NhZ2Uge1xuXHRjb25zdCBtc2cgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG5cdHJldHVybiB7XG5cdFx0cm9sZTogXCJhc3Npc3RhbnRcIixcblx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogbXNnIH1dLFxuXHRcdGFwaTogY29uZmlnLm1vZGVsLmFwaSxcblx0XHRwcm92aWRlcjogY29uZmlnLm1vZGVsLnByb3ZpZGVyLFxuXHRcdG1vZGVsOiBjb25maWcubW9kZWwuaWQsXG5cdFx0dXNhZ2U6IFpFUk9fVVNBR0UsXG5cdFx0c3RvcFJlYXNvbjogXCJlcnJvclwiLFxuXHRcdGVycm9yTWVzc2FnZTogbXNnLFxuXHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0fTtcbn1cblxuLyoqXG4gKiBFbWl0IGEgbWVzc2FnZV9zdGFydCArIG1lc3NhZ2VfZW5kIHBhaXIgZm9yIGEgc2luZ2xlIG1lc3NhZ2UuXG4gKi9cbmZ1bmN0aW9uIGVtaXRNZXNzYWdlUGFpcihzdHJlYW06IEV2ZW50U3RyZWFtPEFnZW50RXZlbnQsIEFnZW50TWVzc2FnZVtdPiwgbWVzc2FnZTogQWdlbnRNZXNzYWdlKTogdm9pZCB7XG5cdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJtZXNzYWdlX3N0YXJ0XCIsIG1lc3NhZ2UgfSk7XG5cdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJtZXNzYWdlX2VuZFwiLCBtZXNzYWdlIH0pO1xufVxuXG4vKipcbiAqIEVtaXQgdGhlIHN0YW5kYXJkIGVycm9yIHNlcXVlbmNlIHdoZW4gdGhlIG91dGVyIGFnZW50IGxvb3AgY2F0Y2hlcyBhbiBlcnJvci5cbiAqIFB1c2hlcyBtZXNzYWdlX3N0YXJ0L2VuZCwgdHVybl9lbmQsIGFnZW50X2VuZCwgdGhlbiBjbG9zZXMgdGhlIHN0cmVhbS5cbiAqL1xuZnVuY3Rpb24gZW1pdEVycm9yU2VxdWVuY2UoXG5cdHN0cmVhbTogRXZlbnRTdHJlYW08QWdlbnRFdmVudCwgQWdlbnRNZXNzYWdlW10+LFxuXHRlcnJNc2c6IEFzc2lzdGFudE1lc3NhZ2UsXG5cdG5ld01lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSxcbik6IHZvaWQge1xuXHRlbWl0TWVzc2FnZVBhaXIoc3RyZWFtLCBlcnJNc2cpO1xuXHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwidHVybl9lbmRcIiwgbWVzc2FnZTogZXJyTXNnLCB0b29sUmVzdWx0czogW10gfSk7XG5cdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJhZ2VudF9lbmRcIiwgbWVzc2FnZXM6IFsuLi5uZXdNZXNzYWdlcywgZXJyTXNnXSB9KTtcblx0c3RyZWFtLmVuZChbLi4ubmV3TWVzc2FnZXMsIGVyck1zZ10pO1xufVxuXG4vKipcbiAqIFN0YXJ0IGFuIGFnZW50IGxvb3Agd2l0aCBhIG5ldyBwcm9tcHQgbWVzc2FnZS5cbiAqIFRoZSBwcm9tcHQgaXMgYWRkZWQgdG8gdGhlIGNvbnRleHQgYW5kIGV2ZW50cyBhcmUgZW1pdHRlZCBmb3IgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhZ2VudExvb3AoXG5cdHByb21wdHM6IEFnZW50TWVzc2FnZVtdLFxuXHRjb250ZXh0OiBBZ2VudENvbnRleHQsXG5cdGNvbmZpZzogQWdlbnRMb29wQ29uZmlnLFxuXHRzaWduYWw/OiBBYm9ydFNpZ25hbCxcblx0c3RyZWFtRm4/OiBTdHJlYW1Gbixcbik6IEV2ZW50U3RyZWFtPEFnZW50RXZlbnQsIEFnZW50TWVzc2FnZVtdPiB7XG5cdGNvbnN0IHN0cmVhbSA9IGNyZWF0ZUFnZW50U3RyZWFtKCk7XG5cblx0KGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBuZXdNZXNzYWdlczogQWdlbnRNZXNzYWdlW10gPSBbLi4ucHJvbXB0c107XG5cdFx0Y29uc3QgY3VycmVudENvbnRleHQ6IEFnZW50Q29udGV4dCA9IHtcblx0XHRcdC4uLmNvbnRleHQsXG5cdFx0XHRtZXNzYWdlczogWy4uLmNvbnRleHQubWVzc2FnZXMsIC4uLnByb21wdHNdLFxuXHRcdH07XG5cblx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwiYWdlbnRfc3RhcnRcIiB9KTtcblx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwidHVybl9zdGFydFwiIH0pO1xuXHRcdGZvciAoY29uc3QgcHJvbXB0IG9mIHByb21wdHMpIHtcblx0XHRcdGVtaXRNZXNzYWdlUGFpcihzdHJlYW0sIHByb21wdCk7XG5cdFx0fVxuXG5cdFx0dHJ5IHtcblx0XHRcdGF3YWl0IHJ1bkxvb3AoY3VycmVudENvbnRleHQsIG5ld01lc3NhZ2VzLCBjb25maWcsIHNpZ25hbCwgc3RyZWFtLCBzdHJlYW1Gbik7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGVtaXRFcnJvclNlcXVlbmNlKHN0cmVhbSwgY3JlYXRlRXJyb3JNZXNzYWdlKGVycm9yLCBjb25maWcpLCBuZXdNZXNzYWdlcyk7XG5cdFx0fVxuXHR9KSgpO1xuXG5cdHJldHVybiBzdHJlYW07XG59XG5cbi8qKlxuICogQ29udGludWUgYW4gYWdlbnQgbG9vcCBmcm9tIHRoZSBjdXJyZW50IGNvbnRleHQgd2l0aG91dCBhZGRpbmcgYSBuZXcgbWVzc2FnZS5cbiAqIFVzZWQgZm9yIHJldHJpZXMgLSBjb250ZXh0IGFscmVhZHkgaGFzIHVzZXIgbWVzc2FnZSBvciB0b29sIHJlc3VsdHMuXG4gKlxuICogKipJbXBvcnRhbnQ6KiogVGhlIGxhc3QgbWVzc2FnZSBpbiBjb250ZXh0IG11c3QgY29udmVydCB0byBhIGB1c2VyYCBvciBgdG9vbFJlc3VsdGAgbWVzc2FnZVxuICogdmlhIGBjb252ZXJ0VG9MbG1gLiBJZiBpdCBkb2Vzbid0LCB0aGUgTExNIHByb3ZpZGVyIHdpbGwgcmVqZWN0IHRoZSByZXF1ZXN0LlxuICogVGhpcyBjYW5ub3QgYmUgdmFsaWRhdGVkIGhlcmUgc2luY2UgYGNvbnZlcnRUb0xsbWAgaXMgb25seSBjYWxsZWQgb25jZSBwZXIgdHVybi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFnZW50TG9vcENvbnRpbnVlKFxuXHRjb250ZXh0OiBBZ2VudENvbnRleHQsXG5cdGNvbmZpZzogQWdlbnRMb29wQ29uZmlnLFxuXHRzaWduYWw/OiBBYm9ydFNpZ25hbCxcblx0c3RyZWFtRm4/OiBTdHJlYW1Gbixcbik6IEV2ZW50U3RyZWFtPEFnZW50RXZlbnQsIEFnZW50TWVzc2FnZVtdPiB7XG5cdGlmIChjb250ZXh0Lm1lc3NhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHRocm93IG5ldyBFcnJvcihcIkNhbm5vdCBjb250aW51ZTogbm8gbWVzc2FnZXMgaW4gY29udGV4dFwiKTtcblx0fVxuXG5cdGlmIChjb250ZXh0Lm1lc3NhZ2VzW2NvbnRleHQubWVzc2FnZXMubGVuZ3RoIC0gMV0ucm9sZSA9PT0gXCJhc3Npc3RhbnRcIikge1xuXHRcdHRocm93IG5ldyBFcnJvcihcIkNhbm5vdCBjb250aW51ZSBmcm9tIG1lc3NhZ2Ugcm9sZTogYXNzaXN0YW50XCIpO1xuXHR9XG5cblx0Y29uc3Qgc3RyZWFtID0gY3JlYXRlQWdlbnRTdHJlYW0oKTtcblxuXHQoYXN5bmMgKCkgPT4ge1xuXHRcdGNvbnN0IG5ld01lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSA9IFtdO1xuXHRcdGNvbnN0IGN1cnJlbnRDb250ZXh0OiBBZ2VudENvbnRleHQgPSB7XG5cdFx0XHQuLi5jb250ZXh0LFxuXHRcdFx0bWVzc2FnZXM6IFsuLi5jb250ZXh0Lm1lc3NhZ2VzXSxcblx0XHR9O1xuXG5cdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcImFnZW50X3N0YXJ0XCIgfSk7XG5cdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcInR1cm5fc3RhcnRcIiB9KTtcblxuXHRcdHRyeSB7XG5cdFx0XHRhd2FpdCBydW5Mb29wKGN1cnJlbnRDb250ZXh0LCBuZXdNZXNzYWdlcywgY29uZmlnLCBzaWduYWwsIHN0cmVhbSwgc3RyZWFtRm4pO1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRlbWl0RXJyb3JTZXF1ZW5jZShzdHJlYW0sIGNyZWF0ZUVycm9yTWVzc2FnZShlcnJvciwgY29uZmlnKSwgbmV3TWVzc2FnZXMpO1xuXHRcdH1cblx0fSkoKTtcblxuXHRyZXR1cm4gc3RyZWFtO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVBZ2VudFN0cmVhbSgpOiBFdmVudFN0cmVhbTxBZ2VudEV2ZW50LCBBZ2VudE1lc3NhZ2VbXT4ge1xuXHRyZXR1cm4gbmV3IEV2ZW50U3RyZWFtPEFnZW50RXZlbnQsIEFnZW50TWVzc2FnZVtdPihcblx0XHQoZXZlbnQ6IEFnZW50RXZlbnQpID0+IGV2ZW50LnR5cGUgPT09IFwiYWdlbnRfZW5kXCIsXG5cdFx0KGV2ZW50OiBBZ2VudEV2ZW50KSA9PiAoZXZlbnQudHlwZSA9PT0gXCJhZ2VudF9lbmRcIiA/IGV2ZW50Lm1lc3NhZ2VzIDogW10pLFxuXHQpO1xufVxuXG4vKipcbiAqIE1haW4gbG9vcCBsb2dpYyBzaGFyZWQgYnkgYWdlbnRMb29wIGFuZCBhZ2VudExvb3BDb250aW51ZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcnVuTG9vcChcblx0Y3VycmVudENvbnRleHQ6IEFnZW50Q29udGV4dCxcblx0bmV3TWVzc2FnZXM6IEFnZW50TWVzc2FnZVtdLFxuXHRjb25maWc6IEFnZW50TG9vcENvbmZpZyxcblx0c2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCxcblx0c3RyZWFtOiBFdmVudFN0cmVhbTxBZ2VudEV2ZW50LCBBZ2VudE1lc3NhZ2VbXT4sXG5cdHN0cmVhbUZuPzogU3RyZWFtRm4sXG4pOiBQcm9taXNlPHZvaWQ+IHtcblx0bGV0IGZpcnN0VHVybiA9IHRydWU7XG5cdC8vIENoZWNrIGZvciBzdGVlcmluZyBtZXNzYWdlcyBhdCBzdGFydCAodXNlciBtYXkgaGF2ZSB0eXBlZCB3aGlsZSB3YWl0aW5nKVxuXHRsZXQgcGVuZGluZ01lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSA9IChhd2FpdCBjb25maWcuZ2V0U3RlZXJpbmdNZXNzYWdlcz8uKCkpIHx8IFtdO1xuXG5cdC8vIFRyYWNrIGNvbnNlY3V0aXZlIHR1cm5zIHdoZXJlIEFMTCB0b29sIGNhbGxzIGZhaWwgdmFsaWRhdGlvbi5cblx0Ly8gV2hlbiB0aGUgTExNIHJlcGVhdGVkbHkgZW1pdHMgdG9vbCBjYWxscyB3aXRoIHNjaGVtYS1vdmVybG9hZGVkIG9yIG1hbGZvcm1lZFxuXHQvLyBhcmd1bWVudHMsIGVhY2ggdHVybiBwcm9kdWNlcyBvbmx5IGVycm9yIHRvb2wgcmVzdWx0cy4gV2l0aG91dCBhIGNhcCwgdGhpc1xuXHQvLyBjcmVhdGVzIGFuIHVuYm91bmRlZCByZXRyeSBsb29wIHRoYXQgYnVybnMgYnVkZ2V0LiAoIzI3ODMpXG5cdGxldCBjb25zZWN1dGl2ZUFsbFRvb2xFcnJvclR1cm5zID0gMDtcblxuXHQvLyBPdXRlciBsb29wOiBjb250aW51ZXMgd2hlbiBxdWV1ZWQgZm9sbG93LXVwIG1lc3NhZ2VzIGFycml2ZSBhZnRlciBhZ2VudCB3b3VsZCBzdG9wXG5cdHdoaWxlICh0cnVlKSB7XG5cdFx0bGV0IGhhc01vcmVUb29sQ2FsbHMgPSB0cnVlO1xuXHRcdGxldCBzdGVlcmluZ0FmdGVyVG9vbHM6IEFnZW50TWVzc2FnZVtdIHwgbnVsbCA9IG51bGw7XG5cblx0XHQvLyBJbm5lciBsb29wOiBwcm9jZXNzIHRvb2wgY2FsbHMgYW5kIHN0ZWVyaW5nIG1lc3NhZ2VzXG5cdFx0d2hpbGUgKGhhc01vcmVUb29sQ2FsbHMgfHwgcGVuZGluZ01lc3NhZ2VzLmxlbmd0aCA+IDApIHtcblx0XHRcdGlmICghZmlyc3RUdXJuKSB7XG5cdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0dXJuX3N0YXJ0XCIgfSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRmaXJzdFR1cm4gPSBmYWxzZTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gUHJvY2VzcyBwZW5kaW5nIG1lc3NhZ2VzIChpbmplY3QgYmVmb3JlIG5leHQgYXNzaXN0YW50IHJlc3BvbnNlKVxuXHRcdFx0aWYgKHBlbmRpbmdNZXNzYWdlcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdGZvciAoY29uc3QgbWVzc2FnZSBvZiBwZW5kaW5nTWVzc2FnZXMpIHtcblx0XHRcdFx0XHRlbWl0TWVzc2FnZVBhaXIoc3RyZWFtLCBtZXNzYWdlKTtcblx0XHRcdFx0XHRjdXJyZW50Q29udGV4dC5tZXNzYWdlcy5wdXNoKG1lc3NhZ2UpO1xuXHRcdFx0XHRcdG5ld01lc3NhZ2VzLnB1c2gobWVzc2FnZSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0cGVuZGluZ01lc3NhZ2VzID0gW107XG5cdFx0XHR9XG5cblx0XHRcdC8vIFN0cmVhbSBhc3Npc3RhbnQgcmVzcG9uc2Vcblx0XHRcdGxldCBtZXNzYWdlOiBBc3Npc3RhbnRNZXNzYWdlO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0bWVzc2FnZSA9IGF3YWl0IHN0cmVhbUFzc2lzdGFudFJlc3BvbnNlKGN1cnJlbnRDb250ZXh0LCBjb25maWcsIHNpZ25hbCwgc3RyZWFtLCBzdHJlYW1Gbik7XG5cdFx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0XHQvLyBDcml0aWNhbCBmYWlsdXJlIGJlZm9yZSBzdHJlYW0gc3RhcnRlZCAoZS5nLiBnZXRBcGlLZXkgdGhyZXcsIGNyZWRlbnRpYWxzIGluXG5cdFx0XHRcdC8vIGJhY2tvZmYsIG5ldHdvcmsgdW5hdmFpbGFibGUpLiBDb252ZXJ0IHRvIGEgZ3JhY2VmdWwgZXJyb3IgbWVzc2FnZSBzbyB0aGVcblx0XHRcdFx0Ly8gYWdlbnQgbG9vcCBjYW4gZW5kIGNsZWFubHkgaW5zdGVhZCBvZiBjcmFzaGluZyB3aXRoIGFuIHVuaGFuZGxlZCByZWplY3Rpb24uXG5cdFx0XHRcdGNvbnN0IGVycm9yVGV4dCA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcblx0XHRcdFx0aWYgKGNvbmZpZy5vblN0cmVhbUVycm9yKSB7XG5cdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdGF3YWl0IGNvbmZpZy5vblN0cmVhbUVycm9yKFxuXHRcdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdFx0ZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihlcnJvclRleHQpLFxuXHRcdFx0XHRcdFx0XHRcdHBhcnRpYWxUZXh0OiBcIlwiLFxuXHRcdFx0XHRcdFx0XHRcdHdpbGxSZXRyeTogZmFsc2UsXG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdHNpZ25hbCxcblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0XHQvLyBIb29rIGZhaWx1cmVzIG11c3Qgbm90IGNyYXNoIHRoZSBsb29wLlxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHRtZXNzYWdlID0ge1xuXHRcdFx0XHRcdHJvbGU6IFwiYXNzaXN0YW50XCIsXG5cdFx0XHRcdFx0Y29udGVudDogW10sXG5cdFx0XHRcdFx0YXBpOiBjb25maWcubW9kZWwuYXBpLFxuXHRcdFx0XHRcdHByb3ZpZGVyOiBjb25maWcubW9kZWwucHJvdmlkZXIsXG5cdFx0XHRcdFx0bW9kZWw6IGNvbmZpZy5tb2RlbC5pZCxcblx0XHRcdFx0XHR1c2FnZTogWkVST19VU0FHRSxcblx0XHRcdFx0XHRzdG9wUmVhc29uOiBzaWduYWw/LmFib3J0ZWQgPyBcImFib3J0ZWRcIiA6IFwiZXJyb3JcIixcblx0XHRcdFx0XHRlcnJvck1lc3NhZ2U6IGVycm9yVGV4dCxcblx0XHRcdFx0XHR0aW1lc3RhbXA6IERhdGUubm93KCksXG5cdFx0XHRcdH07XG5cdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJtZXNzYWdlX3N0YXJ0XCIsIG1lc3NhZ2U6IHsgLi4ubWVzc2FnZSB9IH0pO1xuXHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwibWVzc2FnZV9lbmRcIiwgbWVzc2FnZSB9KTtcblx0XHRcdFx0Y3VycmVudENvbnRleHQubWVzc2FnZXMucHVzaChtZXNzYWdlKTtcblx0XHRcdH1cblx0XHRcdG5ld01lc3NhZ2VzLnB1c2gobWVzc2FnZSk7XG5cblx0XHRcdGlmIChtZXNzYWdlLnN0b3BSZWFzb24gPT09IFwiZXJyb3JcIiB8fCBtZXNzYWdlLnN0b3BSZWFzb24gPT09IFwiYWJvcnRlZFwiKSB7XG5cdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0dXJuX2VuZFwiLCBtZXNzYWdlLCB0b29sUmVzdWx0czogW10gfSk7XG5cdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJhZ2VudF9lbmRcIiwgbWVzc2FnZXM6IG5ld01lc3NhZ2VzIH0pO1xuXHRcdFx0XHRzdHJlYW0uZW5kKG5ld01lc3NhZ2VzKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBDaGVjayBmb3IgdG9vbCBjYWxscyBvciBwYXVzZWQgc2VydmVyIHR1cm5cblx0XHRcdGNvbnN0IHRvb2xDYWxscyA9IG1lc3NhZ2UuY29udGVudC5maWx0ZXIoKGMpID0+IGMudHlwZSA9PT0gXCJ0b29sQ2FsbFwiKTtcblx0XHRcdGhhc01vcmVUb29sQ2FsbHMgPVxuXHRcdFx0XHR0b29sQ2FsbHMubGVuZ3RoID4gMCB8fCBtZXNzYWdlLnN0b3BSZWFzb24gPT09IFwicGF1c2VUdXJuXCI7XG5cblx0XHRcdGNvbnN0IHRvb2xSZXN1bHRzOiBUb29sUmVzdWx0TWVzc2FnZVtdID0gW107XG5cdFx0XHRpZiAoaGFzTW9yZVRvb2xDYWxscyAmJiBjb25maWcuZXh0ZXJuYWxUb29sRXhlY3V0aW9uKSB7XG5cdFx0XHRcdC8vIEV4dGVybmFsIGV4ZWN1dGlvbiBtb2RlOiB0b29scyB3ZXJlIGhhbmRsZWQgYnkgdGhlIHByb3ZpZGVyXG5cdFx0XHRcdC8vIChlLmcuLCBDbGF1ZGUgQ29kZSBTREspLiBFbWl0IHRvb2xfZXhlY3V0aW9uIGV2ZW50cyBmb3IgZWFjaFxuXHRcdFx0XHQvLyB0b29sIGNhbGwuIFByZWZlciBhbnkgcHJvdmlkZXItc3VwcGxpZWQgZXh0ZXJuYWxSZXN1bHQgYXR0YWNoZWRcblx0XHRcdFx0Ly8gdG8gdGhlIHRvb2wgY2FsbCBzbyB0aGUgVUkgY2FuIHNob3cgdGhlIHJlYWwgc3Rkb3V0L3N0ZGVyclxuXHRcdFx0XHQvLyBpbnN0ZWFkIG9mIGEgZ2VuZXJpYyBwbGFjZWhvbGRlci5cblx0XHRcdFx0Zm9yIChjb25zdCB0YyBvZiB0b29sQ2FsbHMgYXMgQWdlbnRUb29sQ2FsbFtdKSB7XG5cdFx0XHRcdFx0Y29uc3QgZXh0ZXJuYWxSZXN1bHQgPSAodGMgYXMgQWdlbnRUb29sQ2FsbCAmIHtcblx0XHRcdFx0XHRcdGV4dGVybmFsUmVzdWx0Pzoge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50PzogQXJyYXk8eyB0eXBlOiBzdHJpbmc7IHRleHQ/OiBzdHJpbmc7IGRhdGE/OiBzdHJpbmc7IG1pbWVUeXBlPzogc3RyaW5nIH0+O1xuXHRcdFx0XHRcdFx0XHRkZXRhaWxzPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I/OiBib29sZWFuO1xuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9KS5leHRlcm5hbFJlc3VsdDtcblx0XHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRvb2xfZXhlY3V0aW9uX3N0YXJ0XCIsXG5cdFx0XHRcdFx0XHR0b29sQ2FsbElkOiB0Yy5pZCxcblx0XHRcdFx0XHRcdHRvb2xOYW1lOiB0Yy5uYW1lLFxuXHRcdFx0XHRcdFx0YXJnczogdGMuYXJndW1lbnRzLFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdHN0cmVhbS5wdXNoKHtcblx0XHRcdFx0XHRcdHR5cGU6IFwidG9vbF9leGVjdXRpb25fZW5kXCIsXG5cdFx0XHRcdFx0XHR0b29sQ2FsbElkOiB0Yy5pZCxcblx0XHRcdFx0XHRcdHRvb2xOYW1lOiB0Yy5uYW1lLFxuXHRcdFx0XHRcdFx0cmVzdWx0OiBleHRlcm5hbFJlc3VsdFxuXHRcdFx0XHRcdFx0XHQ/IHtcblx0XHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IGV4dGVybmFsUmVzdWx0LmNvbnRlbnQgPz8gW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiXCIgfV0sXG5cdFx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzOiBleHRlcm5hbFJlc3VsdC5kZXRhaWxzID8/IHt9LFxuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0OiB7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCIoZXhlY3V0ZWQgYnkgQ2xhdWRlIENvZGUpXCIgfV0sXG5cdFx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7fSxcblx0XHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogZXh0ZXJuYWxSZXN1bHQ/LmlzRXJyb3IgPz8gZmFsc2UsXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gRG9uJ3QgYWRkIHRvb2wgcmVzdWx0cyB0byBjb250ZXh0IG9yIGxvb3AgYmFjayBcdTIwMTQgdGhlIHN0cmVhbVNpbXBsZVxuXHRcdFx0XHQvLyBjYWxsIGFscmVhZHkgcmFuIHRoZSBmdWxsIG11bHRpLXR1cm4gYWdlbnRpYyBsb29wLlxuXHRcdFx0XHRoYXNNb3JlVG9vbENhbGxzID0gZmFsc2U7XG5cdFx0XHR9IGVsc2UgaWYgKGhhc01vcmVUb29sQ2FsbHMpIHtcblx0XHRcdFx0Y29uc3QgdG9vbEV4ZWN1dGlvbiA9IGF3YWl0IGV4ZWN1dGVUb29sQ2FsbHMoXG5cdFx0XHRcdFx0Y3VycmVudENvbnRleHQsXG5cdFx0XHRcdFx0bWVzc2FnZSxcblx0XHRcdFx0XHRjb25maWcsXG5cdFx0XHRcdFx0c2lnbmFsLFxuXHRcdFx0XHRcdHN0cmVhbSxcblx0XHRcdFx0KTtcblx0XHRcdFx0dG9vbFJlc3VsdHMucHVzaCguLi50b29sRXhlY3V0aW9uLnRvb2xSZXN1bHRzKTtcblx0XHRcdFx0c3RlZXJpbmdBZnRlclRvb2xzID0gdG9vbEV4ZWN1dGlvbi5zdGVlcmluZ01lc3NhZ2VzID8/IG51bGw7XG5cblx0XHRcdFx0Zm9yIChjb25zdCByZXN1bHQgb2YgdG9vbFJlc3VsdHMpIHtcblx0XHRcdFx0XHRjdXJyZW50Q29udGV4dC5tZXNzYWdlcy5wdXNoKHJlc3VsdCk7XG5cdFx0XHRcdFx0bmV3TWVzc2FnZXMucHVzaChyZXN1bHQpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gU2NoZW1hIG92ZXJsb2FkIGRldGVjdGlvbiAoIzI3ODMpOiBjb3VudCBvbmx5IHByZXBhcmF0aW9uLXBoYXNlXG5cdFx0XHRcdC8vIGVycm9ycyAoc2NoZW1hIHZhbGlkYXRpb24sIHRvb2wtbm90LWZvdW5kLCB0b29sLWJsb2NrZWQpIHRvd2FyZCB0aGVcblx0XHRcdFx0Ly8gY29uc2VjdXRpdmUgZmFpbHVyZSBjYXAuIFRvb2wgZXhlY3V0aW9uIGVycm9ycyBcdTIwMTQgc3VjaCBhcyBiYXNoXG5cdFx0XHRcdC8vIGNvbW1hbmRzIHJldHVybmluZyBub24temVybyBleGl0IGNvZGVzIChlLmcuIGdyZXAvcmcgZXhpdCAxIGZvclxuXHRcdFx0XHQvLyBcIm5vIG1hdGNoZXNcIikgXHUyMDE0IGFyZSB2YWxpZCB0b29sIHVzYWdlIGFuZCBtdXN0IE5PVCB0cmlnZ2VyIHRoZSBjYXAuXG5cdFx0XHRcdC8vIFNlZTogIzM2MThcblx0XHRcdFx0Y29uc3QgaGFzUHJlcGFyYXRpb25FcnJvcnMgPSB0b29sRXhlY3V0aW9uLnByZXBhcmF0aW9uRXJyb3JDb3VudCA+IDA7XG5cdFx0XHRcdGNvbnN0IGFsbFRvb2xzRmFpbGVkUHJlcGFyYXRpb24gPVxuXHRcdFx0XHRcdHRvb2xSZXN1bHRzLmxlbmd0aCA+IDAgJiZcblx0XHRcdFx0XHR0b29sRXhlY3V0aW9uLnByZXBhcmF0aW9uRXJyb3JDb3VudCA9PT0gdG9vbFJlc3VsdHMubGVuZ3RoO1xuXHRcdFx0XHRpZiAoYWxsVG9vbHNGYWlsZWRQcmVwYXJhdGlvbikge1xuXHRcdFx0XHRcdGNvbnNlY3V0aXZlQWxsVG9vbEVycm9yVHVybnMrKztcblx0XHRcdFx0fSBlbHNlIGlmICghaGFzUHJlcGFyYXRpb25FcnJvcnMpIHtcblx0XHRcdFx0XHQvLyBSZXNldCBvbmx5IHdoZW4gdGhlcmUgYXJlIHplcm8gcHJlcGFyYXRpb24gZXJyb3JzIHRoaXMgdHVybi5cblx0XHRcdFx0XHQvLyBNaXhlZCB0dXJucyAoc29tZSBwcmVwIGVycm9ycywgc29tZSBzdWNjZXNzZXMpIGRvbid0IHJlc2V0LFxuXHRcdFx0XHRcdC8vIGJ1dCB0aGV5IGFsc28gZG9uJ3QgaW5jcmVtZW50IFx1MjAxNCB0aGlzIGF2b2lkcyBtYXNraW5nIGFcblx0XHRcdFx0XHQvLyBwYXR0ZXJuIG9mIGFsdGVybmF0aW5nIHNjaGVtYSBmYWlsdXJlcyB3aXRoIG9uZSB3b3JraW5nIGNhbGwuXG5cdFx0XHRcdFx0Y29uc2VjdXRpdmVBbGxUb29sRXJyb3JUdXJucyA9IDA7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoY29uc2VjdXRpdmVBbGxUb29sRXJyb3JUdXJucyA+PSBNQVhfQ09OU0VDVVRJVkVfVkFMSURBVElPTl9GQUlMVVJFUykge1xuXHRcdFx0XHRcdC8vIEZvcmNlLXN0b3A6IHRoZSBMTE0gaXMgc3R1Y2sgcmV0cnlpbmcgYnJva2VuIHRvb2wgY2FsbHMuXG5cdFx0XHRcdFx0Ly8gRW1pdCB0aGUgdHVybl9lbmQgYW5kIHRlcm1pbmF0ZSB0aGUgYWdlbnQgbG9vcCBjbGVhbmx5LlxuXHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0dXJuX2VuZFwiLCBtZXNzYWdlLCB0b29sUmVzdWx0cyB9KTtcblx0XHRcdFx0XHRjb25zdCBzdG9wTWVzc2FnZTogQXNzaXN0YW50TWVzc2FnZSA9IHtcblx0XHRcdFx0XHRcdHJvbGU6IFwiYXNzaXN0YW50XCIsXG5cdFx0XHRcdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdFx0XHR0ZXh0OiBgQWdlbnQgc3RvcHBlZDogJHtjb25zZWN1dGl2ZUFsbFRvb2xFcnJvclR1cm5zfSBjb25zZWN1dGl2ZSB0dXJucyB3aXRoIGFsbCB0b29sIGNhbGxzIGZhaWxpbmcuIFRoaXMgdXN1YWxseSBtZWFucyB0aGUgbW9kZWwgaXMgcmVwZWF0ZWRseSBzZW5kaW5nIGFyZ3VtZW50cyB0aGF0IGRvIG5vdCBtYXRjaCB0aGUgdG9vbCBzY2hlbWEuYCxcblx0XHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdF0sXG5cdFx0XHRcdFx0XHRhcGk6IGNvbmZpZy5tb2RlbC5hcGksXG5cdFx0XHRcdFx0XHRwcm92aWRlcjogY29uZmlnLm1vZGVsLnByb3ZpZGVyLFxuXHRcdFx0XHRcdFx0bW9kZWw6IGNvbmZpZy5tb2RlbC5pZCxcblx0XHRcdFx0XHRcdHVzYWdlOiBaRVJPX1VTQUdFLFxuXHRcdFx0XHRcdFx0c3RvcFJlYXNvbjogXCJlcnJvclwiLFxuXHRcdFx0XHRcdFx0ZXJyb3JNZXNzYWdlOiBcIlNjaGVtYSBvdmVybG9hZDogY29uc2VjdXRpdmUgdG9vbCB2YWxpZGF0aW9uIGZhaWx1cmVzIGV4Y2VlZGVkIGNhcFwiLFxuXHRcdFx0XHRcdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0ZW1pdE1lc3NhZ2VQYWlyKHN0cmVhbSwgc3RvcE1lc3NhZ2UpO1xuXHRcdFx0XHRcdG5ld01lc3NhZ2VzLnB1c2goc3RvcE1lc3NhZ2UpO1xuXHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJ0dXJuX2VuZFwiLCBtZXNzYWdlOiBzdG9wTWVzc2FnZSwgdG9vbFJlc3VsdHM6IFtdIH0pO1xuXHRcdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJhZ2VudF9lbmRcIiwgbWVzc2FnZXM6IG5ld01lc3NhZ2VzIH0pO1xuXHRcdFx0XHRcdHN0cmVhbS5lbmQobmV3TWVzc2FnZXMpO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwidHVybl9lbmRcIiwgbWVzc2FnZSwgdG9vbFJlc3VsdHMgfSk7XG5cblx0XHRcdC8vIEdldCBzdGVlcmluZyBtZXNzYWdlcyBhZnRlciB0dXJuIGNvbXBsZXRlc1xuXHRcdFx0aWYgKHN0ZWVyaW5nQWZ0ZXJUb29scyAmJiBzdGVlcmluZ0FmdGVyVG9vbHMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRwZW5kaW5nTWVzc2FnZXMgPSBzdGVlcmluZ0FmdGVyVG9vbHM7XG5cdFx0XHRcdHN0ZWVyaW5nQWZ0ZXJUb29scyA9IG51bGw7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRwZW5kaW5nTWVzc2FnZXMgPSAoYXdhaXQgY29uZmlnLmdldFN0ZWVyaW5nTWVzc2FnZXM/LigpKSB8fCBbXTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBBZ2VudCB3b3VsZCBzdG9wIGhlcmUuIENoZWNrIGZvciBmb2xsb3ctdXAgbWVzc2FnZXMuXG5cdFx0Y29uc3QgZm9sbG93VXBNZXNzYWdlcyA9IChhd2FpdCBjb25maWcuZ2V0Rm9sbG93VXBNZXNzYWdlcz8uKCkpIHx8IFtdO1xuXHRcdGlmIChmb2xsb3dVcE1lc3NhZ2VzLmxlbmd0aCA+IDApIHtcblx0XHRcdC8vIFNldCBhcyBwZW5kaW5nIHNvIGlubmVyIGxvb3AgcHJvY2Vzc2VzIHRoZW1cblx0XHRcdHBlbmRpbmdNZXNzYWdlcyA9IGZvbGxvd1VwTWVzc2FnZXM7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHQvLyBObyBtb3JlIG1lc3NhZ2VzLCBleGl0XG5cdFx0YnJlYWs7XG5cdH1cblxuXHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwiYWdlbnRfZW5kXCIsIG1lc3NhZ2VzOiBuZXdNZXNzYWdlcyB9KTtcblx0c3RyZWFtLmVuZChuZXdNZXNzYWdlcyk7XG59XG5cbi8qKlxuICogU3RyZWFtIGFuIGFzc2lzdGFudCByZXNwb25zZSBmcm9tIHRoZSBMTE0uXG4gKiBUaGlzIGlzIHdoZXJlIEFnZW50TWVzc2FnZVtdIGdldHMgdHJhbnNmb3JtZWQgdG8gTWVzc2FnZVtdIGZvciB0aGUgTExNLlxuICovXG5hc3luYyBmdW5jdGlvbiBzdHJlYW1Bc3Npc3RhbnRSZXNwb25zZShcblx0Y29udGV4dDogQWdlbnRDb250ZXh0LFxuXHRjb25maWc6IEFnZW50TG9vcENvbmZpZyxcblx0c2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCxcblx0c3RyZWFtOiBFdmVudFN0cmVhbTxBZ2VudEV2ZW50LCBBZ2VudE1lc3NhZ2VbXT4sXG5cdHN0cmVhbUZuPzogU3RyZWFtRm4sXG4pOiBQcm9taXNlPEFzc2lzdGFudE1lc3NhZ2U+IHtcblx0Ly8gQXBwbHkgY29udGV4dCB0cmFuc2Zvcm0gaWYgY29uZmlndXJlZCAoQWdlbnRNZXNzYWdlW10gXHUyMTkyIEFnZW50TWVzc2FnZVtdKVxuXHRsZXQgbWVzc2FnZXMgPSBjb250ZXh0Lm1lc3NhZ2VzO1xuXHRpZiAoY29uZmlnLnRyYW5zZm9ybUNvbnRleHQpIHtcblx0XHRtZXNzYWdlcyA9IGF3YWl0IGNvbmZpZy50cmFuc2Zvcm1Db250ZXh0KG1lc3NhZ2VzLCBzaWduYWwpO1xuXHR9XG5cblx0Ly8gQ29udmVydCB0byBMTE0tY29tcGF0aWJsZSBtZXNzYWdlcyAoQWdlbnRNZXNzYWdlW10gXHUyMTkyIE1lc3NhZ2VbXSlcblx0Y29uc3QgbGxtTWVzc2FnZXMgPSBhd2FpdCBjb25maWcuY29udmVydFRvTGxtKG1lc3NhZ2VzKTtcblx0Y29uc3QgdG9vbHMgPSBjb25maWcuZmlsdGVyVG9vbHMgPyBhd2FpdCBjb25maWcuZmlsdGVyVG9vbHMoY29udGV4dC50b29scyA/PyBbXSwgc2lnbmFsLCBtZXNzYWdlcykgOiBjb250ZXh0LnRvb2xzO1xuXG5cdC8vIEJ1aWxkIExMTSBjb250ZXh0XG5cdGNvbnN0IGxsbUNvbnRleHQ6IENvbnRleHQgPSB7XG5cdFx0c3lzdGVtUHJvbXB0OiBjb250ZXh0LnN5c3RlbVByb21wdCxcblx0XHRtZXNzYWdlczogbGxtTWVzc2FnZXMsXG5cdFx0dG9vbHMsXG5cdH07XG5cdG1heWJlTG9nVG9rZW5BdWRpdChsbG1Db250ZXh0LCBtZXNzYWdlcyk7XG5cblx0Y29uc3Qgc3RyZWFtRnVuY3Rpb24gPSBzdHJlYW1GbiB8fCBzdHJlYW1TaW1wbGU7XG5cblx0Ly8gUmVzb2x2ZSBBUEkga2V5IChpbXBvcnRhbnQgZm9yIGV4cGlyaW5nIHRva2Vucylcblx0Y29uc3QgcmVzb2x2ZWRBcGlLZXkgPVxuXHRcdChjb25maWcuZ2V0QXBpS2V5ID8gYXdhaXQgY29uZmlnLmdldEFwaUtleShjb25maWcubW9kZWwucHJvdmlkZXIpIDogdW5kZWZpbmVkKSB8fCBjb25maWcuYXBpS2V5O1xuXG5cdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgc3RyZWFtRnVuY3Rpb24oY29uZmlnLm1vZGVsLCBsbG1Db250ZXh0LCB7XG5cdFx0Li4uY29uZmlnLFxuXHRcdGFwaUtleTogcmVzb2x2ZWRBcGlLZXksXG5cdFx0c2lnbmFsLFxuXHR9KTtcblxuXHRsZXQgcGFydGlhbE1lc3NhZ2U6IEFzc2lzdGFudE1lc3NhZ2UgfCBudWxsID0gbnVsbDtcblx0bGV0IGFkZGVkUGFydGlhbCA9IGZhbHNlO1xuXG5cdGZvciBhd2FpdCAoY29uc3QgZXZlbnQgb2YgcmVzcG9uc2UpIHtcblx0XHRzd2l0Y2ggKGV2ZW50LnR5cGUpIHtcblx0XHRcdGNhc2UgXCJzdGFydFwiOlxuXHRcdFx0XHRwYXJ0aWFsTWVzc2FnZSA9IGV2ZW50LnBhcnRpYWw7XG5cdFx0XHRcdGNvbnRleHQubWVzc2FnZXMucHVzaChwYXJ0aWFsTWVzc2FnZSk7XG5cdFx0XHRcdGFkZGVkUGFydGlhbCA9IHRydWU7XG5cdFx0XHRcdHN0cmVhbS5wdXNoKHsgdHlwZTogXCJtZXNzYWdlX3N0YXJ0XCIsIG1lc3NhZ2U6IHsgLi4ucGFydGlhbE1lc3NhZ2UgfSB9KTtcblx0XHRcdFx0YnJlYWs7XG5cblx0XHRcdGNhc2UgXCJ0ZXh0X3N0YXJ0XCI6XG5cdFx0XHRjYXNlIFwidGV4dF9kZWx0YVwiOlxuXHRcdFx0Y2FzZSBcInRleHRfZW5kXCI6XG5cdFx0XHRjYXNlIFwidGhpbmtpbmdfc3RhcnRcIjpcblx0XHRcdGNhc2UgXCJ0aGlua2luZ19kZWx0YVwiOlxuXHRcdFx0Y2FzZSBcInRoaW5raW5nX2VuZFwiOlxuXHRcdFx0Y2FzZSBcInRvb2xjYWxsX3N0YXJ0XCI6XG5cdFx0XHRjYXNlIFwidG9vbGNhbGxfZGVsdGFcIjpcblx0XHRcdGNhc2UgXCJ0b29sY2FsbF9lbmRcIjpcblx0XHRcdGNhc2UgXCJzZXJ2ZXJfdG9vbF91c2VcIjpcblx0XHRcdGNhc2UgXCJ3ZWJfc2VhcmNoX3Jlc3VsdFwiOlxuXHRcdFx0XHRpZiAocGFydGlhbE1lc3NhZ2UpIHtcblx0XHRcdFx0XHRwYXJ0aWFsTWVzc2FnZSA9IGV2ZW50LnBhcnRpYWw7XG5cdFx0XHRcdFx0Y29udGV4dC5tZXNzYWdlc1tjb250ZXh0Lm1lc3NhZ2VzLmxlbmd0aCAtIDFdID0gcGFydGlhbE1lc3NhZ2U7XG5cdFx0XHRcdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJtZXNzYWdlX3VwZGF0ZVwiLFxuXHRcdFx0XHRcdFx0YXNzaXN0YW50TWVzc2FnZUV2ZW50OiBldmVudCxcblx0XHRcdFx0XHRcdG1lc3NhZ2U6IHsgLi4ucGFydGlhbE1lc3NhZ2UgfSxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRicmVhaztcblxuXHRcdFx0Y2FzZSBcImRvbmVcIjpcblx0XHRcdGNhc2UgXCJlcnJvclwiOiB7XG5cdFx0XHRcdGNvbnN0IGZpbmFsTWVzc2FnZSA9IGF3YWl0IHJlc3BvbnNlLnJlc3VsdCgpO1xuXHRcdFx0XHRpZiAoYWRkZWRQYXJ0aWFsKSB7XG5cdFx0XHRcdFx0Y29udGV4dC5tZXNzYWdlc1tjb250ZXh0Lm1lc3NhZ2VzLmxlbmd0aCAtIDFdID0gZmluYWxNZXNzYWdlO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGNvbnRleHQubWVzc2FnZXMucHVzaChmaW5hbE1lc3NhZ2UpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmICghYWRkZWRQYXJ0aWFsKSB7XG5cdFx0XHRcdFx0c3RyZWFtLnB1c2goeyB0eXBlOiBcIm1lc3NhZ2Vfc3RhcnRcIiwgbWVzc2FnZTogeyAuLi5maW5hbE1lc3NhZ2UgfSB9KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRzdHJlYW0ucHVzaCh7IHR5cGU6IFwibWVzc2FnZV9lbmRcIiwgbWVzc2FnZTogZmluYWxNZXNzYWdlIH0pO1xuXHRcdFx0XHRyZXR1cm4gZmluYWxNZXNzYWdlO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHJldHVybiBhd2FpdCByZXNwb25zZS5yZXN1bHQoKTtcbn1cblxuLyoqXG4gKiBSZXN1bHQgZnJvbSBleGVjdXRpbmcgdG9vbCBjYWxscyBpbiBhIHR1cm4uIEluY2x1ZGVzIG1ldGFkYXRhIGFib3V0XG4gKiBlcnJvciBwcm92ZW5hbmNlIHNvIHRoZSBzY2hlbWEgb3ZlcmxvYWQgZGV0ZWN0b3IgY2FuIGRpc3Rpbmd1aXNoXG4gKiBwcmVwYXJhdGlvbiBmYWlsdXJlcyAoc2NoZW1hIHZhbGlkYXRpb24sIHRvb2wtbm90LWZvdW5kLCB0b29sLWJsb2NrZWQpXG4gKiBmcm9tIGV4ZWN1dGlvbiBmYWlsdXJlcyAodGhlIHRvb2wgcmFuIGJ1dCB0aHJldywgZS5nLiBiYXNoIGV4aXQgY29kZSAxKS5cbiAqL1xuaW50ZXJmYWNlIFRvb2xFeGVjdXRpb25SZXN1bHQge1xuXHR0b29sUmVzdWx0czogVG9vbFJlc3VsdE1lc3NhZ2VbXTtcblx0c3RlZXJpbmdNZXNzYWdlcz86IEFnZW50TWVzc2FnZVtdO1xuXHQvKiogTnVtYmVyIG9mIHRvb2wgcmVzdWx0cyB0aGF0IGZhaWxlZCBkdXJpbmcgcHJlcGFyYXRpb24gKHZhbGlkYXRpb24vc2NoZW1hKS4gKi9cblx0cHJlcGFyYXRpb25FcnJvckNvdW50OiBudW1iZXI7XG59XG5cbi8qKlxuICogRXhlY3V0ZSB0b29sIGNhbGxzIGZyb20gYW4gYXNzaXN0YW50IG1lc3NhZ2UuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVUb29sQ2FsbHMoXG5cdGN1cnJlbnRDb250ZXh0OiBBZ2VudENvbnRleHQsXG5cdGFzc2lzdGFudE1lc3NhZ2U6IEFzc2lzdGFudE1lc3NhZ2UsXG5cdGNvbmZpZzogQWdlbnRMb29wQ29uZmlnLFxuXHRzaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkLFxuXHRzdHJlYW06IEV2ZW50U3RyZWFtPEFnZW50RXZlbnQsIEFnZW50TWVzc2FnZVtdPixcbik6IFByb21pc2U8VG9vbEV4ZWN1dGlvblJlc3VsdD4ge1xuXHRjb25zdCB0b29sQ2FsbHMgPSBhc3Npc3RhbnRNZXNzYWdlLmNvbnRlbnQuZmlsdGVyKChjKSA9PiBjLnR5cGUgPT09IFwidG9vbENhbGxcIikgYXMgQWdlbnRUb29sQ2FsbFtdO1xuXHRpZiAoY29uZmlnLnRvb2xFeGVjdXRpb24gPT09IFwic2VxdWVudGlhbFwiKSB7XG5cdFx0cmV0dXJuIGV4ZWN1dGVUb29sQ2FsbHNTZXF1ZW50aWFsKGN1cnJlbnRDb250ZXh0LCBhc3Npc3RhbnRNZXNzYWdlLCB0b29sQ2FsbHMsIGNvbmZpZywgc2lnbmFsLCBzdHJlYW0pO1xuXHR9XG5cdHJldHVybiBleGVjdXRlVG9vbENhbGxzUGFyYWxsZWwoY3VycmVudENvbnRleHQsIGFzc2lzdGFudE1lc3NhZ2UsIHRvb2xDYWxscywgY29uZmlnLCBzaWduYWwsIHN0cmVhbSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVUb29sQ2FsbHNTZXF1ZW50aWFsKFxuXHRjdXJyZW50Q29udGV4dDogQWdlbnRDb250ZXh0LFxuXHRhc3Npc3RhbnRNZXNzYWdlOiBBc3Npc3RhbnRNZXNzYWdlLFxuXHR0b29sQ2FsbHM6IEFnZW50VG9vbENhbGxbXSxcblx0Y29uZmlnOiBBZ2VudExvb3BDb25maWcsXG5cdHNpZ25hbDogQWJvcnRTaWduYWwgfCB1bmRlZmluZWQsXG5cdHN0cmVhbTogRXZlbnRTdHJlYW08QWdlbnRFdmVudCwgQWdlbnRNZXNzYWdlW10+LFxuKTogUHJvbWlzZTxUb29sRXhlY3V0aW9uUmVzdWx0PiB7XG5cdGNvbnN0IHJlc3VsdHM6IFRvb2xSZXN1bHRNZXNzYWdlW10gPSBbXTtcblx0bGV0IHN0ZWVyaW5nTWVzc2FnZXM6IEFnZW50TWVzc2FnZVtdIHwgdW5kZWZpbmVkO1xuXHRsZXQgcHJlcGFyYXRpb25FcnJvckNvdW50ID0gMDtcblxuXHRmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgdG9vbENhbGxzLmxlbmd0aDsgaW5kZXgrKykge1xuXHRcdGNvbnN0IHRvb2xDYWxsID0gdG9vbENhbGxzW2luZGV4XTtcblx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHR0eXBlOiBcInRvb2xfZXhlY3V0aW9uX3N0YXJ0XCIsXG5cdFx0XHR0b29sQ2FsbElkOiB0b29sQ2FsbC5pZCxcblx0XHRcdHRvb2xOYW1lOiB0b29sQ2FsbC5uYW1lLFxuXHRcdFx0YXJnczogdG9vbENhbGwuYXJndW1lbnRzLFxuXHRcdH0pO1xuXG5cdFx0Y29uc3QgcHJlcGFyYXRpb24gPSBhd2FpdCBwcmVwYXJlVG9vbENhbGwoY3VycmVudENvbnRleHQsIGFzc2lzdGFudE1lc3NhZ2UsIHRvb2xDYWxsLCBjb25maWcsIHNpZ25hbCk7XG5cdFx0aWYgKHByZXBhcmF0aW9uLmtpbmQgPT09IFwiaW1tZWRpYXRlXCIpIHtcblx0XHRcdGlmIChwcmVwYXJhdGlvbi5pc0Vycm9yKSB7XG5cdFx0XHRcdHByZXBhcmF0aW9uRXJyb3JDb3VudCsrO1xuXHRcdFx0fVxuXHRcdFx0cmVzdWx0cy5wdXNoKGVtaXRUb29sQ2FsbE91dGNvbWUodG9vbENhbGwsIHByZXBhcmF0aW9uLnJlc3VsdCwgcHJlcGFyYXRpb24uaXNFcnJvciwgc3RyZWFtKSk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGNvbnN0IGV4ZWN1dGVkID0gYXdhaXQgZXhlY3V0ZVByZXBhcmVkVG9vbENhbGwocHJlcGFyYXRpb24sIHNpZ25hbCwgc3RyZWFtKTtcblx0XHRcdHJlc3VsdHMucHVzaChcblx0XHRcdFx0YXdhaXQgZmluYWxpemVFeGVjdXRlZFRvb2xDYWxsKFxuXHRcdFx0XHRcdGN1cnJlbnRDb250ZXh0LFxuXHRcdFx0XHRcdGFzc2lzdGFudE1lc3NhZ2UsXG5cdFx0XHRcdFx0cHJlcGFyYXRpb24sXG5cdFx0XHRcdFx0ZXhlY3V0ZWQsXG5cdFx0XHRcdFx0Y29uZmlnLFxuXHRcdFx0XHRcdHNpZ25hbCxcblx0XHRcdFx0XHRzdHJlYW0sXG5cdFx0XHRcdCksXG5cdFx0XHQpO1xuXHRcdH1cblxuXHRcdGlmIChjb25maWcuZ2V0U3RlZXJpbmdNZXNzYWdlcykge1xuXHRcdFx0Y29uc3Qgc3RlZXJpbmcgPSBhd2FpdCBjb25maWcuZ2V0U3RlZXJpbmdNZXNzYWdlcygpO1xuXHRcdFx0aWYgKHN0ZWVyaW5nLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0c3RlZXJpbmdNZXNzYWdlcyA9IHN0ZWVyaW5nO1xuXHRcdFx0XHRjb25zdCByZW1haW5pbmdDYWxscyA9IHRvb2xDYWxscy5zbGljZShpbmRleCArIDEpO1xuXHRcdFx0XHRmb3IgKGNvbnN0IHNraXBwZWQgb2YgcmVtYWluaW5nQ2FsbHMpIHtcblx0XHRcdFx0XHRyZXN1bHRzLnB1c2goc2tpcFRvb2xDYWxsKHNraXBwZWQsIHN0cmVhbSkpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHJldHVybiB7IHRvb2xSZXN1bHRzOiByZXN1bHRzLCBzdGVlcmluZ01lc3NhZ2VzLCBwcmVwYXJhdGlvbkVycm9yQ291bnQgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZVRvb2xDYWxsc1BhcmFsbGVsKFxuXHRjdXJyZW50Q29udGV4dDogQWdlbnRDb250ZXh0LFxuXHRhc3Npc3RhbnRNZXNzYWdlOiBBc3Npc3RhbnRNZXNzYWdlLFxuXHR0b29sQ2FsbHM6IEFnZW50VG9vbENhbGxbXSxcblx0Y29uZmlnOiBBZ2VudExvb3BDb25maWcsXG5cdHNpZ25hbDogQWJvcnRTaWduYWwgfCB1bmRlZmluZWQsXG5cdHN0cmVhbTogRXZlbnRTdHJlYW08QWdlbnRFdmVudCwgQWdlbnRNZXNzYWdlW10+LFxuKTogUHJvbWlzZTxUb29sRXhlY3V0aW9uUmVzdWx0PiB7XG5cdGNvbnN0IHJlc3VsdHM6IFRvb2xSZXN1bHRNZXNzYWdlW10gPSBbXTtcblx0Y29uc3QgcnVubmFibGVDYWxsczogUHJlcGFyZWRUb29sQ2FsbFtdID0gW107XG5cdGxldCBzdGVlcmluZ01lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSB8IHVuZGVmaW5lZDtcblx0bGV0IHByZXBhcmF0aW9uRXJyb3JDb3VudCA9IDA7XG5cblx0Zm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHRvb2xDYWxscy5sZW5ndGg7IGluZGV4KyspIHtcblx0XHRjb25zdCB0b29sQ2FsbCA9IHRvb2xDYWxsc1tpbmRleF07XG5cdFx0c3RyZWFtLnB1c2goe1xuXHRcdFx0dHlwZTogXCJ0b29sX2V4ZWN1dGlvbl9zdGFydFwiLFxuXHRcdFx0dG9vbENhbGxJZDogdG9vbENhbGwuaWQsXG5cdFx0XHR0b29sTmFtZTogdG9vbENhbGwubmFtZSxcblx0XHRcdGFyZ3M6IHRvb2xDYWxsLmFyZ3VtZW50cyxcblx0XHR9KTtcblxuXHRcdGNvbnN0IHByZXBhcmF0aW9uID0gYXdhaXQgcHJlcGFyZVRvb2xDYWxsKGN1cnJlbnRDb250ZXh0LCBhc3Npc3RhbnRNZXNzYWdlLCB0b29sQ2FsbCwgY29uZmlnLCBzaWduYWwpO1xuXHRcdGlmIChwcmVwYXJhdGlvbi5raW5kID09PSBcImltbWVkaWF0ZVwiKSB7XG5cdFx0XHRpZiAocHJlcGFyYXRpb24uaXNFcnJvcikge1xuXHRcdFx0XHRwcmVwYXJhdGlvbkVycm9yQ291bnQrKztcblx0XHRcdH1cblx0XHRcdHJlc3VsdHMucHVzaChlbWl0VG9vbENhbGxPdXRjb21lKHRvb2xDYWxsLCBwcmVwYXJhdGlvbi5yZXN1bHQsIHByZXBhcmF0aW9uLmlzRXJyb3IsIHN0cmVhbSkpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRydW5uYWJsZUNhbGxzLnB1c2gocHJlcGFyYXRpb24pO1xuXHRcdH1cblxuXHRcdGlmIChjb25maWcuZ2V0U3RlZXJpbmdNZXNzYWdlcykge1xuXHRcdFx0Y29uc3Qgc3RlZXJpbmcgPSBhd2FpdCBjb25maWcuZ2V0U3RlZXJpbmdNZXNzYWdlcygpO1xuXHRcdFx0aWYgKHN0ZWVyaW5nLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0c3RlZXJpbmdNZXNzYWdlcyA9IHN0ZWVyaW5nO1xuXHRcdFx0XHRmb3IgKGNvbnN0IHJ1bm5hYmxlIG9mIHJ1bm5hYmxlQ2FsbHMpIHtcblx0XHRcdFx0XHRyZXN1bHRzLnB1c2goc2tpcFRvb2xDYWxsKHJ1bm5hYmxlLnRvb2xDYWxsLCBzdHJlYW0sIHsgZW1pdFN0YXJ0OiBmYWxzZSB9KSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgcmVtYWluaW5nQ2FsbHMgPSB0b29sQ2FsbHMuc2xpY2UoaW5kZXggKyAxKTtcblx0XHRcdFx0Zm9yIChjb25zdCBza2lwcGVkIG9mIHJlbWFpbmluZ0NhbGxzKSB7XG5cdFx0XHRcdFx0cmVzdWx0cy5wdXNoKHNraXBUb29sQ2FsbChza2lwcGVkLCBzdHJlYW0pKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4geyB0b29sUmVzdWx0czogcmVzdWx0cywgc3RlZXJpbmdNZXNzYWdlcywgcHJlcGFyYXRpb25FcnJvckNvdW50IH07XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0Y29uc3QgcnVubmluZ0NhbGxzID0gcnVubmFibGVDYWxscy5tYXAoKHByZXBhcmVkKSA9PiAoe1xuXHRcdHByZXBhcmVkLFxuXHRcdGV4ZWN1dGlvbjogZXhlY3V0ZVByZXBhcmVkVG9vbENhbGwocHJlcGFyZWQsIHNpZ25hbCwgc3RyZWFtKSxcblx0fSkpO1xuXG5cdGZvciAoY29uc3QgcnVubmluZyBvZiBydW5uaW5nQ2FsbHMpIHtcblx0XHRjb25zdCBleGVjdXRlZCA9IGF3YWl0IHJ1bm5pbmcuZXhlY3V0aW9uO1xuXHRcdHJlc3VsdHMucHVzaChcblx0XHRcdGF3YWl0IGZpbmFsaXplRXhlY3V0ZWRUb29sQ2FsbChcblx0XHRcdFx0Y3VycmVudENvbnRleHQsXG5cdFx0XHRcdGFzc2lzdGFudE1lc3NhZ2UsXG5cdFx0XHRcdHJ1bm5pbmcucHJlcGFyZWQsXG5cdFx0XHRcdGV4ZWN1dGVkLFxuXHRcdFx0XHRjb25maWcsXG5cdFx0XHRcdHNpZ25hbCxcblx0XHRcdFx0c3RyZWFtLFxuXHRcdFx0KSxcblx0XHQpO1xuXHR9XG5cblx0aWYgKCFzdGVlcmluZ01lc3NhZ2VzICYmIGNvbmZpZy5nZXRTdGVlcmluZ01lc3NhZ2VzKSB7XG5cdFx0Y29uc3Qgc3RlZXJpbmcgPSBhd2FpdCBjb25maWcuZ2V0U3RlZXJpbmdNZXNzYWdlcygpO1xuXHRcdGlmIChzdGVlcmluZy5sZW5ndGggPiAwKSB7XG5cdFx0XHRzdGVlcmluZ01lc3NhZ2VzID0gc3RlZXJpbmc7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIHsgdG9vbFJlc3VsdHM6IHJlc3VsdHMsIHN0ZWVyaW5nTWVzc2FnZXMsIHByZXBhcmF0aW9uRXJyb3JDb3VudCB9O1xufVxuXG50eXBlIFByZXBhcmVkVG9vbENhbGwgPSB7XG5cdGtpbmQ6IFwicHJlcGFyZWRcIjtcblx0dG9vbENhbGw6IEFnZW50VG9vbENhbGw7XG5cdHRvb2w6IEFnZW50VG9vbDxhbnk+O1xuXHRhcmdzOiB1bmtub3duO1xufTtcblxudHlwZSBJbW1lZGlhdGVUb29sQ2FsbE91dGNvbWUgPSB7XG5cdGtpbmQ6IFwiaW1tZWRpYXRlXCI7XG5cdHJlc3VsdDogQWdlbnRUb29sUmVzdWx0PGFueT47XG5cdGlzRXJyb3I6IGJvb2xlYW47XG59O1xuXG50eXBlIEV4ZWN1dGVkVG9vbENhbGxPdXRjb21lID0ge1xuXHRyZXN1bHQ6IEFnZW50VG9vbFJlc3VsdDxhbnk+O1xuXHRpc0Vycm9yOiBib29sZWFuO1xufTtcblxuYXN5bmMgZnVuY3Rpb24gcHJlcGFyZVRvb2xDYWxsKFxuXHRjdXJyZW50Q29udGV4dDogQWdlbnRDb250ZXh0LFxuXHRhc3Npc3RhbnRNZXNzYWdlOiBBc3Npc3RhbnRNZXNzYWdlLFxuXHR0b29sQ2FsbDogQWdlbnRUb29sQ2FsbCxcblx0Y29uZmlnOiBBZ2VudExvb3BDb25maWcsXG5cdHNpZ25hbDogQWJvcnRTaWduYWwgfCB1bmRlZmluZWQsXG4pOiBQcm9taXNlPFByZXBhcmVkVG9vbENhbGwgfCBJbW1lZGlhdGVUb29sQ2FsbE91dGNvbWU+IHtcblx0Y29uc3QgdG9vbCA9IGN1cnJlbnRDb250ZXh0LnRvb2xzPy5maW5kKCh0KSA9PiB0Lm5hbWUgPT09IHRvb2xDYWxsLm5hbWUpO1xuXHRpZiAoIXRvb2wpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0a2luZDogXCJpbW1lZGlhdGVcIixcblx0XHRcdHJlc3VsdDogY3JlYXRlRXJyb3JUb29sUmVzdWx0KGBUb29sICR7dG9vbENhbGwubmFtZX0gbm90IGZvdW5kYCksXG5cdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdH07XG5cdH1cblxuXHR0cnkge1xuXHRcdGNvbnN0IHZhbGlkYXRlZEFyZ3MgPSB2YWxpZGF0ZVRvb2xBcmd1bWVudHModG9vbCwgdG9vbENhbGwpO1xuXHRcdGlmIChjb25maWcuYmVmb3JlVG9vbENhbGwpIHtcblx0XHRcdGNvbnN0IGJlZm9yZVJlc3VsdCA9IGF3YWl0IGNvbmZpZy5iZWZvcmVUb29sQ2FsbChcblx0XHRcdFx0e1xuXHRcdFx0XHRcdGFzc2lzdGFudE1lc3NhZ2UsXG5cdFx0XHRcdFx0dG9vbENhbGwsXG5cdFx0XHRcdFx0YXJnczogdmFsaWRhdGVkQXJncyxcblx0XHRcdFx0XHRjb250ZXh0OiBjdXJyZW50Q29udGV4dCxcblx0XHRcdFx0fSxcblx0XHRcdFx0c2lnbmFsLFxuXHRcdFx0KTtcblx0XHRcdGlmIChiZWZvcmVSZXN1bHQ/LmJsb2NrKSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0a2luZDogXCJpbW1lZGlhdGVcIixcblx0XHRcdFx0XHRyZXN1bHQ6IGNyZWF0ZUVycm9yVG9vbFJlc3VsdChiZWZvcmVSZXN1bHQucmVhc29uIHx8IFwiVG9vbCBleGVjdXRpb24gd2FzIGJsb2NrZWRcIiksXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9XG5cdFx0cmV0dXJuIHtcblx0XHRcdGtpbmQ6IFwicHJlcGFyZWRcIixcblx0XHRcdHRvb2xDYWxsLFxuXHRcdFx0dG9vbCxcblx0XHRcdGFyZ3M6IHZhbGlkYXRlZEFyZ3MsXG5cdFx0fTtcblx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0a2luZDogXCJpbW1lZGlhdGVcIixcblx0XHRcdHJlc3VsdDogY3JlYXRlRXJyb3JUb29sUmVzdWx0KGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSksXG5cdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdH07XG5cdH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZVByZXBhcmVkVG9vbENhbGwoXG5cdHByZXBhcmVkOiBQcmVwYXJlZFRvb2xDYWxsLFxuXHRzaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkLFxuXHRzdHJlYW06IEV2ZW50U3RyZWFtPEFnZW50RXZlbnQsIEFnZW50TWVzc2FnZVtdPixcbik6IFByb21pc2U8RXhlY3V0ZWRUb29sQ2FsbE91dGNvbWU+IHtcblx0dHJ5IHtcblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBwcmVwYXJlZC50b29sLmV4ZWN1dGUoXG5cdFx0XHRwcmVwYXJlZC50b29sQ2FsbC5pZCxcblx0XHRcdHByZXBhcmVkLmFyZ3MgYXMgbmV2ZXIsXG5cdFx0XHRzaWduYWwsXG5cdFx0XHQocGFydGlhbFJlc3VsdCkgPT4ge1xuXHRcdFx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHRcdFx0dHlwZTogXCJ0b29sX2V4ZWN1dGlvbl91cGRhdGVcIixcblx0XHRcdFx0XHR0b29sQ2FsbElkOiBwcmVwYXJlZC50b29sQ2FsbC5pZCxcblx0XHRcdFx0XHR0b29sTmFtZTogcHJlcGFyZWQudG9vbENhbGwubmFtZSxcblx0XHRcdFx0XHRhcmdzOiBwcmVwYXJlZC50b29sQ2FsbC5hcmd1bWVudHMsXG5cdFx0XHRcdFx0cGFydGlhbFJlc3VsdCxcblx0XHRcdFx0fSk7XG5cdFx0XHR9LFxuXHRcdCk7XG5cdFx0cmV0dXJuIHsgcmVzdWx0LCBpc0Vycm9yOiBmYWxzZSB9O1xuXHR9IGNhdGNoIChlcnJvcikge1xuXHRcdHJldHVybiB7XG5cdFx0XHRyZXN1bHQ6IGNyZWF0ZUVycm9yVG9vbFJlc3VsdChlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcikpLFxuXHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHR9O1xuXHR9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZpbmFsaXplRXhlY3V0ZWRUb29sQ2FsbChcblx0Y3VycmVudENvbnRleHQ6IEFnZW50Q29udGV4dCxcblx0YXNzaXN0YW50TWVzc2FnZTogQXNzaXN0YW50TWVzc2FnZSxcblx0cHJlcGFyZWQ6IFByZXBhcmVkVG9vbENhbGwsXG5cdGV4ZWN1dGVkOiBFeGVjdXRlZFRvb2xDYWxsT3V0Y29tZSxcblx0Y29uZmlnOiBBZ2VudExvb3BDb25maWcsXG5cdHNpZ25hbDogQWJvcnRTaWduYWwgfCB1bmRlZmluZWQsXG5cdHN0cmVhbTogRXZlbnRTdHJlYW08QWdlbnRFdmVudCwgQWdlbnRNZXNzYWdlW10+LFxuKTogUHJvbWlzZTxUb29sUmVzdWx0TWVzc2FnZT4ge1xuXHRsZXQgcmVzdWx0ID0gZXhlY3V0ZWQucmVzdWx0O1xuXHRsZXQgaXNFcnJvciA9IGV4ZWN1dGVkLmlzRXJyb3I7XG5cblx0aWYgKGNvbmZpZy5hZnRlclRvb2xDYWxsKSB7XG5cdFx0Y29uc3QgYWZ0ZXJSZXN1bHQgPSBhd2FpdCBjb25maWcuYWZ0ZXJUb29sQ2FsbChcblx0XHRcdHtcblx0XHRcdFx0YXNzaXN0YW50TWVzc2FnZSxcblx0XHRcdFx0dG9vbENhbGw6IHByZXBhcmVkLnRvb2xDYWxsLFxuXHRcdFx0XHRhcmdzOiBwcmVwYXJlZC5hcmdzLFxuXHRcdFx0XHRyZXN1bHQsXG5cdFx0XHRcdGlzRXJyb3IsXG5cdFx0XHRcdGNvbnRleHQ6IGN1cnJlbnRDb250ZXh0LFxuXHRcdFx0fSxcblx0XHRcdHNpZ25hbCxcblx0XHQpO1xuXHRcdGlmIChhZnRlclJlc3VsdCkge1xuXHRcdFx0cmVzdWx0ID0ge1xuXHRcdFx0XHRjb250ZW50OiBhZnRlclJlc3VsdC5jb250ZW50ICE9PSB1bmRlZmluZWQgPyBhZnRlclJlc3VsdC5jb250ZW50IDogcmVzdWx0LmNvbnRlbnQsXG5cdFx0XHRcdGRldGFpbHM6IGFmdGVyUmVzdWx0LmRldGFpbHMgIT09IHVuZGVmaW5lZCA/IGFmdGVyUmVzdWx0LmRldGFpbHMgOiByZXN1bHQuZGV0YWlscyxcblx0XHRcdH07XG5cdFx0XHRpc0Vycm9yID0gYWZ0ZXJSZXN1bHQuaXNFcnJvciAhPT0gdW5kZWZpbmVkID8gYWZ0ZXJSZXN1bHQuaXNFcnJvciA6IGlzRXJyb3I7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIGVtaXRUb29sQ2FsbE91dGNvbWUocHJlcGFyZWQudG9vbENhbGwsIHJlc3VsdCwgaXNFcnJvciwgc3RyZWFtKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlRXJyb3JUb29sUmVzdWx0KG1lc3NhZ2U6IHN0cmluZyk6IEFnZW50VG9vbFJlc3VsdDxhbnk+IHtcblx0cmV0dXJuIHtcblx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogbWVzc2FnZSB9XSxcblx0XHRkZXRhaWxzOiB7fSxcblx0fTtcbn1cblxuZnVuY3Rpb24gZW1pdFRvb2xDYWxsT3V0Y29tZShcblx0dG9vbENhbGw6IEFnZW50VG9vbENhbGwsXG5cdHJlc3VsdDogQWdlbnRUb29sUmVzdWx0PGFueT4sXG5cdGlzRXJyb3I6IGJvb2xlYW4sXG5cdHN0cmVhbTogRXZlbnRTdHJlYW08QWdlbnRFdmVudCwgQWdlbnRNZXNzYWdlW10+LFxuKTogVG9vbFJlc3VsdE1lc3NhZ2Uge1xuXHRzdHJlYW0ucHVzaCh7XG5cdFx0dHlwZTogXCJ0b29sX2V4ZWN1dGlvbl9lbmRcIixcblx0XHR0b29sQ2FsbElkOiB0b29sQ2FsbC5pZCxcblx0XHR0b29sTmFtZTogdG9vbENhbGwubmFtZSxcblx0XHRyZXN1bHQsXG5cdFx0aXNFcnJvcixcblx0fSk7XG5cblx0Y29uc3QgdG9vbFJlc3VsdE1lc3NhZ2U6IFRvb2xSZXN1bHRNZXNzYWdlID0ge1xuXHRcdHJvbGU6IFwidG9vbFJlc3VsdFwiLFxuXHRcdHRvb2xDYWxsSWQ6IHRvb2xDYWxsLmlkLFxuXHRcdHRvb2xOYW1lOiB0b29sQ2FsbC5uYW1lLFxuXHRcdGNvbnRlbnQ6IHJlc3VsdC5jb250ZW50LFxuXHRcdGRldGFpbHM6IHJlc3VsdC5kZXRhaWxzLFxuXHRcdGlzRXJyb3IsXG5cdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHR9O1xuXG5cdGVtaXRNZXNzYWdlUGFpcihzdHJlYW0sIHRvb2xSZXN1bHRNZXNzYWdlKTtcblx0cmV0dXJuIHRvb2xSZXN1bHRNZXNzYWdlO1xufVxuXG5mdW5jdGlvbiBza2lwVG9vbENhbGwoXG5cdHRvb2xDYWxsOiBBZ2VudFRvb2xDYWxsLFxuXHRzdHJlYW06IEV2ZW50U3RyZWFtPEFnZW50RXZlbnQsIEFnZW50TWVzc2FnZVtdPixcblx0b3B0aW9ucz86IHsgZW1pdFN0YXJ0PzogYm9vbGVhbiB9LFxuKTogVG9vbFJlc3VsdE1lc3NhZ2Uge1xuXHRjb25zdCByZXN1bHQ6IEFnZW50VG9vbFJlc3VsdDxhbnk+ID0ge1xuXHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlNraXBwZWQgZHVlIHRvIHF1ZXVlZCB1c2VyIG1lc3NhZ2UuXCIgfV0sXG5cdFx0ZGV0YWlsczoge30sXG5cdH07XG5cblx0aWYgKG9wdGlvbnM/LmVtaXRTdGFydCAhPT0gZmFsc2UpIHtcblx0XHRzdHJlYW0ucHVzaCh7XG5cdFx0XHR0eXBlOiBcInRvb2xfZXhlY3V0aW9uX3N0YXJ0XCIsXG5cdFx0XHR0b29sQ2FsbElkOiB0b29sQ2FsbC5pZCxcblx0XHRcdHRvb2xOYW1lOiB0b29sQ2FsbC5uYW1lLFxuXHRcdFx0YXJnczogdG9vbENhbGwuYXJndW1lbnRzLFxuXHRcdH0pO1xuXHR9XG5cblx0cmV0dXJuIGVtaXRUb29sQ2FsbE91dGNvbWUodG9vbENhbGwsIHJlc3VsdCwgdHJ1ZSwgc3RyZWFtKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUtBO0FBQUEsRUFHQztBQUFBLEVBQ0E7QUFBQSxFQUVBO0FBQUEsT0FDTTtBQVdQLFNBQVMsMEJBQTBCO0FBUzVCLE1BQU0sc0NBQXNDO0FBRTVDLE1BQU0sYUFBYTtBQUFBLEVBQ3pCLE9BQU87QUFBQSxFQUNQLFFBQVE7QUFBQSxFQUNSLFdBQVc7QUFBQSxFQUNYLFlBQVk7QUFBQSxFQUNaLGFBQWE7QUFBQSxFQUNiLE1BQU0sRUFBRSxPQUFPLEdBQUcsUUFBUSxHQUFHLFdBQVcsR0FBRyxZQUFZLEdBQUcsT0FBTyxFQUFFO0FBQ3BFO0FBTUEsU0FBUyxtQkFBbUIsT0FBZ0Is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
