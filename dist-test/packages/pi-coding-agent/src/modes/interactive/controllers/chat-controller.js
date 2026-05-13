import { Loader, Markdown, Spacer, Text } from "@gsd/pi-tui";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "../components/assistant-message.js";
import {
  ToolExecutionComponent,
  ToolPhaseSummaryComponent
} from "../components/tool-execution.js";
import { DynamicBorder } from "../components/dynamic-border.js";
import { appKey } from "../components/keybinding-hints.js";
let lastProcessedContentIndex = 0;
let lastContentLength = 0;
let renderedSegments = [];
let orphanedSegments = [];
function hasVisibleAssistantContent(message) {
  return message.content.some(
    (c) => c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0 || c.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim().length > 0
  );
}
function hasAssistantToolBlocks(message) {
  return message.content.some((c) => c.type === "toolCall" || c.type === "serverToolUse");
}
function findLatestPinnableCandidates(contentBlocks) {
  let lastToolIdx = -1;
  for (let i = contentBlocks.length - 1; i >= 0; i--) {
    const c = contentBlocks[i];
    if (c?.type === "toolCall" || c?.type === "serverToolUse") {
      lastToolIdx = i;
      break;
    }
  }
  const out = [];
  for (let i = lastToolIdx - 1; i >= 0; i--) {
    const c = contentBlocks[i];
    if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
      out.push({ text: c.text.trim(), contentIndex: i });
    }
  }
  return out;
}
function findLatestPinnableText(contentBlocks) {
  return findLatestPinnableCandidates(contentBlocks)[0]?.text ?? "";
}
function rowsRenderedAfterContentIndex(contentIndex, width) {
  let rows = 0;
  for (const seg of renderedSegments) {
    try {
      if (seg.kind === "text-run" && seg.startIndex > contentIndex) {
        rows += seg.component.render(width).length;
      } else if (seg.kind === "tool" && seg.contentIndex > contentIndex) {
        rows += seg.component.render(width).length;
      }
    } catch {
    }
  }
  return rows;
}
let lastPinnedText = "";
let hasToolsInTurn = false;
let pinnedBorder;
let pinnedTextComponent;
function mergeToolPhases(phases) {
  const merged = [];
  for (const phase of phases) {
    const previous = merged[merged.length - 1];
    if (previous?.label === phase.label) {
      previous.count += phase.count;
      previous.durationMs += phase.durationMs;
      previous.targets = mergeTargets(previous.targets, phase.targets);
      if (previous.actionLabel !== phase.actionLabel) {
        previous.actionLabel = void 0;
      }
    } else {
      merged.push({ ...phase, targets: phase.targets ? [...phase.targets] : void 0 });
    }
  }
  return merged;
}
function mergeTargets(existing, incoming) {
  if (!existing && !incoming) return void 0;
  const seen = /* @__PURE__ */ new Set();
  const merged = [];
  for (const target of [...existing ?? [], ...incoming ?? []]) {
    if (!target || seen.has(target)) continue;
    seen.add(target);
    merged.push(target);
  }
  return merged;
}
function replaceCompactToolRowsWithPhaseSummary(host) {
  let changed = false;
  const nextRenderedSegments = [];
  let rollupRun = [];
  const flushRollupRun = () => {
    const actionCount = rollupRun.reduce(
      (total, item) => total + item.phases.reduce((sum, phase) => sum + phase.count, 0),
      0
    );
    if (actionCount < 2) {
      nextRenderedSegments.push(...rollupRun.map((item) => item.seg));
      rollupRun = [];
      return;
    }
    const firstIndex = Math.max(0, host.chatContainer.children.indexOf(rollupRun[0].seg.component));
    const phases = mergeToolPhases(rollupRun.flatMap((item) => item.phases));
    const summary = new ToolPhaseSummaryComponent(phases);
    for (const { seg } of rollupRun) {
      host.chatContainer.removeChild(seg.component);
    }
    host.chatContainer.addChild(summary);
    const summaryIndex = host.chatContainer.children.indexOf(summary);
    if (summaryIndex !== -1 && summaryIndex !== firstIndex) {
      host.chatContainer.children.splice(summaryIndex, 1);
      host.chatContainer.children.splice(firstIndex, 0, summary);
      host.chatContainer._prevRender = null;
    }
    changed = true;
    nextRenderedSegments.push({ kind: "tool-summary", component: summary, phases });
    rollupRun = [];
  };
  for (const seg of renderedSegments) {
    const phase = seg.kind === "tool" ? seg.component.getRollupPhase() : null;
    if (seg.kind === "tool" && phase) {
      rollupRun.push({ seg, phases: [phase] });
      continue;
    }
    if (seg.kind === "tool-summary") {
      rollupRun.push({ seg, phases: seg.component.getPhases() });
      continue;
    }
    flushRollupRun();
    nextRenderedSegments.push(seg);
  }
  flushRollupRun();
  if (changed) {
    renderedSegments = nextRenderedSegments;
    host.ui.requestRender();
  }
}
async function handleAgentEvent(host, event) {
  if (!host.isInitialized) {
    await host.init();
  }
  host.footer.invalidate();
  const timestampFormat = host.settingsManager.getTimestampFormat();
  if (event.type === "message_start" && event.message.role === "assistant") {
    lastProcessedContentIndex = 0;
    lastContentLength = 0;
    lastPinnedText = "";
    hasToolsInTurn = false;
    renderedSegments = [];
    orphanedSegments = [];
    if (pinnedBorder) pinnedBorder.stopSpinner();
    pinnedBorder = void 0;
    pinnedTextComponent = void 0;
    host.pinnedMessageContainer.clear();
  }
  switch (event.type) {
    case "session_state_changed":
      switch (event.reason) {
        case "new_session":
        case "switch_session":
        case "fork":
          host.streamingComponent = void 0;
          host.streamingMessage = void 0;
          host.pendingTools.clear();
          host.pendingMessagesContainer.clear();
          host.pinnedMessageContainer.clear();
          lastPinnedText = "";
          hasToolsInTurn = false;
          renderedSegments = [];
          orphanedSegments = [];
          lastContentLength = 0;
          if (pinnedBorder) pinnedBorder.stopSpinner();
          pinnedBorder = void 0;
          pinnedTextComponent = void 0;
          host.compactionQueuedMessages = [];
          host.rebuildChatFromMessages();
          host.updatePendingMessagesDisplay();
          host.updateTerminalTitle();
          host.updateEditorBorderColor();
          host.ui.requestRender();
          return;
        case "set_session_name":
          host.updateTerminalTitle();
          host.ui.requestRender();
          return;
        case "set_model":
        case "set_thinking_level":
          host.updateEditorBorderColor();
          host.ui.requestRender();
          return;
        default:
          host.ui.requestRender();
          return;
      }
    case "agent_start":
      host.clearBlockingError();
      if (host.retryEscapeHandler) {
        host.defaultEditor.onEscape = host.retryEscapeHandler;
        host.retryEscapeHandler = void 0;
      }
      if (host.retryLoader) {
        host.retryLoader.stop();
        host.retryLoader = void 0;
      }
      if (host.loadingAnimation) {
        host.loadingAnimation.stop();
      }
      host.statusContainer.clear();
      host.loadingAnimation = new Loader(
        host.ui,
        (spinner) => theme.fg("accent", spinner),
        (text) => theme.fg("muted", text),
        host.defaultWorkingMessage
      );
      host.statusContainer.addChild(host.loadingAnimation);
      if (host.pendingWorkingMessage !== void 0) {
        if (host.pendingWorkingMessage) {
          host.loadingAnimation.setMessage(host.pendingWorkingMessage);
        }
        host.pendingWorkingMessage = void 0;
      }
      host.ui.requestRender();
      break;
    case "message_start":
      if (event.message.role === "custom") {
        host.addMessageToChat(event.message);
        host.ui.requestRender();
      } else if (event.message.role === "user") {
        host.addMessageToChat(event.message);
        host.updatePendingMessagesDisplay();
        host.ui.requestRender();
      } else if (event.message.role === "assistant") {
        host.streamingMessage = event.message;
        host.ui.requestRender();
      }
      break;
    case "message_update":
      if (event.message.role === "assistant") {
        host.streamingMessage = event.message;
        const innerEvent = event.assistantMessageEvent;
        let externalToolResult;
        if (innerEvent.type === "toolcall_end" && innerEvent.toolCall) {
          const tc = innerEvent.toolCall;
          const ext = tc.externalResult;
          if (ext) {
            externalToolResult = {
              toolCallId: tc.id,
              content: ext.content ?? [{ type: "text", text: "" }],
              details: ext.details ?? {},
              isError: ext.isError ?? false
            };
          }
        } else if (innerEvent.type === "server_tool_use") {
          const idx = typeof innerEvent.contentIndex === "number" ? innerEvent.contentIndex : -1;
          const block = idx >= 0 ? host.streamingMessage.content[idx] : void 0;
          const ext = block?.externalResult;
          if (block?.id && ext) {
            externalToolResult = {
              toolCallId: block.id,
              content: ext.content ?? [{ type: "text", text: "" }],
              details: ext.details ?? {},
              isError: ext.isError ?? false
            };
          }
        }
        const contentBlocks = host.streamingMessage.content;
        if (contentBlocks.length < lastContentLength) {
          orphanedSegments = [...orphanedSegments, ...renderedSegments];
          renderedSegments = [];
          lastPinnedText = "";
          lastProcessedContentIndex = 0;
        } else if (lastProcessedContentIndex >= contentBlocks.length) {
          lastProcessedContentIndex = 0;
        }
        lastContentLength = contentBlocks.length;
        for (let i = lastProcessedContentIndex; i < contentBlocks.length; i++) {
          const content = contentBlocks[i];
          if (content.type === "toolCall") {
            if (!host.pendingTools.has(content.id)) {
              const component = new ToolExecutionComponent(
                content.name,
                content.arguments,
                { showImages: host.settingsManager.getShowImages() },
                host.getRegisteredToolDefinition(content.name),
                host.ui
              );
              component.setExpanded(host.toolOutputExpanded);
              host.chatContainer.addChild(component);
              host.pendingTools.set(content.id, component);
            } else {
              host.pendingTools.get(content.id)?.updateArgs(content.arguments);
            }
          } else if (content.type === "serverToolUse") {
            if (!host.pendingTools.has(content.id)) {
              const component = new ToolExecutionComponent(
                content.name,
                content.input ?? {},
                { showImages: host.settingsManager.getShowImages() },
                void 0,
                host.ui
              );
              component.setExpanded(host.toolOutputExpanded);
              host.chatContainer.addChild(component);
              host.pendingTools.set(content.id, component);
            }
          } else if (content.type === "webSearchResult") {
            const component = host.pendingTools.get(content.toolUseId);
            if (component) {
              if (process.env.PI_OFFLINE === "1") {
                component.updateResult({
                  content: [{ type: "text", text: "Web search disabled (offline mode)" }],
                  isError: false
                });
              } else {
                const searchContent = content.content;
                const isError = searchContent && typeof searchContent === "object" && "type" in searchContent && searchContent.type === "web_search_tool_result_error";
                component.updateResult({
                  content: [{ type: "text", text: host.formatWebSearchResult(searchContent) }],
                  isError: !!isError
                });
              }
            }
          }
        }
        if (externalToolResult) {
          const component = host.pendingTools.get(externalToolResult.toolCallId);
          if (component) {
            component.updateResult({
              content: externalToolResult.content,
              details: externalToolResult.details,
              isError: externalToolResult.isError
            });
            replaceCompactToolRowsWithPhaseSummary(host);
          }
        }
        {
          const blocks = host.streamingMessage.content;
          const isClaudeCodeProvider = host.streamingMessage.provider === "claude-code";
          const hasMcpToolBlock = blocks.some((b) => {
            if (b?.type === "toolCall") {
              return typeof b?.mcpServer === "string" || String(b?.name ?? "").startsWith("mcp__");
            }
            if (b?.type === "serverToolUse") {
              return typeof b?.mcpServer === "string" || String(b?.name ?? "").startsWith("mcp__");
            }
            return false;
          });
          const firstToolIdx = blocks.findIndex((b) => b.type === "toolCall" || b.type === "serverToolUse");
          const hasPostToolText = firstToolIdx >= 0 && blocks.some(
            (b, idx) => idx > firstToolIdx && b?.type === "text" && typeof b?.text === "string" && b.text.trim().length > 0
          );
          const shouldDropPreToolProse = isClaudeCodeProvider && hasMcpToolBlock && hasPostToolText;
          const desired = [];
          let runStart = -1;
          let runEnd = -1;
          let runType;
          const closeRun = () => {
            if (runStart !== -1 && runType) {
              desired.push({ kind: "text-run", startIndex: runStart, endIndex: runEnd, contentType: runType });
              runStart = -1;
              runEnd = -1;
              runType = void 0;
            }
          };
          for (let i = 0; i < blocks.length; i++) {
            const b = blocks[i];
            const blockType = b.type === "text" || b.type === "thinking" ? b.type : void 0;
            const isTextLike = blockType === "text" || blockType === "thinking";
            const isTool = b.type === "toolCall" || b.type === "serverToolUse";
            const textValue = blockType === "text" && typeof b?.text === "string" ? b.text : "";
            const isLikelyQuestion = blockType === "text" && typeof textValue === "string" && /\?\s*$/.test(textValue.trim());
            const shouldSkipProse = shouldDropPreToolProse && firstToolIdx >= 0 && i < firstToolIdx && blockType === "text" && !isLikelyQuestion;
            if (shouldSkipProse) {
              closeRun();
              continue;
            }
            if (isTextLike) {
              if (runStart === -1) {
                runStart = i;
                runEnd = i;
                runType = blockType;
              } else if (runType !== blockType) {
                closeRun();
                runStart = i;
                runEnd = i;
                runType = blockType;
              } else {
                runEnd = i;
              }
            } else {
              closeRun();
              if (isTool) {
                desired.push({ kind: "tool", contentIndex: i, toolId: b.id });
              }
            }
          }
          closeRun();
          if (shouldDropPreToolProse && firstToolIdx >= 0) {
            if (orphanedSegments.length > 0) {
              const remainingOrphans = [];
              for (const orphan of orphanedSegments) {
                if (orphan.kind === "text-run" && orphan.contentType === "text") {
                  host.chatContainer.removeChild(orphan.component);
                  if (host.streamingComponent === orphan.component) {
                    host.streamingComponent = void 0;
                  }
                  continue;
                }
                remainingOrphans.push(orphan);
              }
              orphanedSegments = remainingOrphans;
            }
            const desiredTextKeys = new Set(
              desired.filter((seg) => seg.kind === "text-run").map((seg) => `${seg.contentType}:${seg.startIndex}`)
            );
            const desiredToolIndices = new Set(
              desired.filter((seg) => seg.kind === "tool").map((seg) => seg.contentIndex)
            );
            const nextRendered = [];
            for (const seg of renderedSegments) {
              if (seg.kind === "text-run" && seg.contentType === "text" && !desiredTextKeys.has(`${seg.contentType}:${seg.startIndex}`)) {
                host.chatContainer.removeChild(seg.component);
                if (host.streamingComponent === seg.component) {
                  host.streamingComponent = void 0;
                }
                continue;
              }
              if (seg.kind === "tool" && !desiredToolIndices.has(seg.contentIndex)) {
                continue;
              }
              nextRendered.push(seg);
            }
            renderedSegments = nextRendered;
          }
          for (const seg of desired) {
            if (seg.kind === "tool") {
              const existing = renderedSegments.find(
                (s) => s.kind === "tool" && s.contentIndex === seg.contentIndex
              );
              if (!existing) {
                const comp = host.pendingTools.get(seg.toolId);
                if (comp) {
                  renderedSegments.push({ kind: "tool", contentIndex: seg.contentIndex, component: comp });
                }
              }
            } else {
              const existing = renderedSegments.find(
                (s) => s.kind === "text-run" && s.startIndex === seg.startIndex && s.contentType === seg.contentType
              );
              if (!existing) {
                const comp = new AssistantMessageComponent(
                  void 0,
                  host.hideThinkingBlock,
                  host.getMarkdownThemeWithSettings(),
                  timestampFormat,
                  { startIndex: seg.startIndex, endIndex: seg.endIndex }
                );
                host.chatContainer.addChild(comp);
                renderedSegments.push({
                  kind: "text-run",
                  startIndex: seg.startIndex,
                  endIndex: seg.endIndex,
                  contentType: seg.contentType,
                  component: comp
                });
                host.streamingComponent = comp;
              }
            }
          }
          for (const seg of renderedSegments) {
            if (seg.kind === "text-run") {
              const d = desired.find(
                (ds) => ds.kind === "text-run" && ds.startIndex === seg.startIndex && ds.contentType === seg.contentType
              );
              if (d && d.kind === "text-run" && d.endIndex !== seg.endIndex) {
                seg.endIndex = d.endIndex;
                seg.component.setRange({ startIndex: seg.startIndex, endIndex: seg.endIndex });
              }
              seg.component.updateContent(host.streamingMessage);
            }
          }
          const lastTextSeg = [...renderedSegments].reverse().find((s) => s.kind === "text-run");
          if (lastTextSeg && lastTextSeg.kind === "text-run") {
            host.streamingComponent = lastTextSeg.component;
          }
        }
        if (contentBlocks.length > 0) {
          lastProcessedContentIndex = Math.max(0, contentBlocks.length - 1);
        }
        const hasTools = contentBlocks.some(
          (c) => c.type === "toolCall" || c.type === "serverToolUse"
        );
        if (hasTools) hasToolsInTurn = true;
        if (hasToolsInTurn) {
          const candidates = findLatestPinnableCandidates(contentBlocks);
          const termRows = host.ui.terminal.rows;
          const termCols = host.ui.terminal.columns;
          const pinnedMax = Math.max(3, Math.floor(termRows * 0.4));
          const offscreenThreshold = Math.max(1, termRows - pinnedMax - 8);
          let picked;
          for (const c of candidates) {
            if (rowsRenderedAfterContentIndex(c.contentIndex, termCols) >= offscreenThreshold) {
              picked = c;
              break;
            }
          }
          if (picked) {
            if (picked.text !== lastPinnedText) {
              lastPinnedText = picked.text;
              if (!pinnedBorder) {
                host.pinnedMessageContainer.clear();
                pinnedBorder = new DynamicBorder(
                  (str) => theme.fg("dim", str),
                  "Working \xB7 Latest Output"
                );
                pinnedBorder.startSpinner(host.ui, (str) => theme.fg("accent", str));
                host.pinnedMessageContainer.addChild(pinnedBorder);
                pinnedTextComponent = new Markdown(picked.text, 1, 0, host.getMarkdownThemeWithSettings());
                pinnedTextComponent.maxLines = pinnedMax;
                host.pinnedMessageContainer.addChild(pinnedTextComponent);
                if (host.loadingAnimation) {
                  host.loadingAnimation.stop();
                  host.loadingAnimation = void 0;
                }
                host.statusContainer.clear();
              } else {
                pinnedTextComponent?.setText(picked.text);
                if (pinnedTextComponent) {
                  pinnedTextComponent.maxLines = pinnedMax;
                }
              }
            }
          } else if (pinnedBorder) {
            pinnedBorder.stopSpinner();
            pinnedBorder = void 0;
            pinnedTextComponent = void 0;
            host.pinnedMessageContainer.clear();
            lastPinnedText = "";
          }
        }
        host.ui.requestRender();
      }
      break;
    case "message_end":
      if (event.message.role === "user") break;
      if (event.message.role === "assistant") {
        host.streamingMessage = event.message;
        let errorMessage;
        if (host.streamingMessage.stopReason === "aborted") {
          const retryAttempt = host.session.retryAttempt;
          errorMessage = retryAttempt > 0 ? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}` : "Operation aborted";
          host.streamingMessage.errorMessage = errorMessage;
        }
        const shouldRenderAssistant = hasVisibleAssistantContent(host.streamingMessage) || (host.streamingMessage.stopReason === "aborted" || host.streamingMessage.stopReason === "error") && !hasAssistantToolBlocks(host.streamingMessage);
        if (renderedSegments.length > 0) {
          const finalBlocks = host.streamingMessage.content;
          const desired = [];
          let runStart = -1;
          let runEnd = -1;
          let runType;
          const closeRun = () => {
            if (runStart !== -1 && runType) {
              desired.push({ kind: "text-run", startIndex: runStart, endIndex: runEnd, contentType: runType });
              runStart = -1;
              runEnd = -1;
              runType = void 0;
            }
          };
          for (let i = 0; i < finalBlocks.length; i++) {
            const block = finalBlocks[i];
            const blockType = block?.type === "text" || block?.type === "thinking" ? block.type : void 0;
            const isTextLike = blockType === "text" || blockType === "thinking";
            const isTool = block?.type === "toolCall" || block?.type === "serverToolUse";
            if (isTextLike) {
              if (runStart === -1) {
                runStart = i;
                runEnd = i;
                runType = blockType;
              } else if (runType !== blockType) {
                closeRun();
                runStart = i;
                runEnd = i;
                runType = blockType;
              } else {
                runEnd = i;
              }
            } else {
              closeRun();
              if (isTool) {
                desired.push({ kind: "tool", contentIndex: i, toolId: block.id });
              }
            }
          }
          closeRun();
          const toolComponentsById = /* @__PURE__ */ new Map();
          for (const [toolId, component] of host.pendingTools.entries()) {
            toolComponentsById.set(toolId, component);
          }
          for (const seg of renderedSegments) {
            host.chatContainer.removeChild(seg.component);
            if (seg.kind === "tool") {
              const priorBlocks = host.streamingMessage.content;
              const priorBlock = priorBlocks[seg.contentIndex];
              if (priorBlock?.id && !toolComponentsById.has(priorBlock.id)) {
                toolComponentsById.set(priorBlock.id, seg.component);
              }
            }
          }
          renderedSegments = [];
          host.streamingComponent = void 0;
          for (const seg of desired) {
            if (seg.kind === "tool") {
              const finalBlock = finalBlocks[seg.contentIndex];
              let component = toolComponentsById.get(seg.toolId);
              if (!component && finalBlock?.id) {
                component = host.pendingTools.get(finalBlock.id);
              }
              if (!component && finalBlock?.type === "toolCall") {
                component = new ToolExecutionComponent(
                  finalBlock.name,
                  finalBlock.arguments,
                  { showImages: host.settingsManager.getShowImages() },
                  host.getRegisteredToolDefinition(finalBlock.name),
                  host.ui
                );
                component.setExpanded(host.toolOutputExpanded);
                host.pendingTools.set(finalBlock.id, component);
                toolComponentsById.set(finalBlock.id, component);
              } else if (!component && finalBlock?.type === "serverToolUse") {
                component = new ToolExecutionComponent(
                  finalBlock.name,
                  finalBlock.input ?? {},
                  { showImages: host.settingsManager.getShowImages() },
                  void 0,
                  host.ui
                );
                component.setExpanded(host.toolOutputExpanded);
                host.pendingTools.set(finalBlock.id, component);
                toolComponentsById.set(finalBlock.id, component);
              }
              if (component) {
                host.chatContainer.addChild(component);
                renderedSegments.push({ kind: "tool", contentIndex: seg.contentIndex, component });
              }
              continue;
            }
            const comp = new AssistantMessageComponent(
              void 0,
              host.hideThinkingBlock,
              host.getMarkdownThemeWithSettings(),
              timestampFormat,
              { startIndex: seg.startIndex, endIndex: seg.endIndex }
            );
            comp.updateContent(host.streamingMessage);
            host.chatContainer.addChild(comp);
            renderedSegments.push({
              kind: "text-run",
              startIndex: seg.startIndex,
              endIndex: seg.endIndex,
              contentType: seg.contentType,
              component: comp
            });
            host.streamingComponent = comp;
          }
        }
        if (!host.streamingComponent && shouldRenderAssistant) {
          host.streamingComponent = new AssistantMessageComponent(
            void 0,
            host.hideThinkingBlock,
            host.getMarkdownThemeWithSettings(),
            timestampFormat
          );
          host.chatContainer.addChild(host.streamingComponent);
        }
        if (host.streamingComponent) {
          host.streamingComponent.setShowMetadata(true);
          host.streamingComponent.updateContent(host.streamingMessage);
        }
        if (host.streamingMessage.stopReason === "aborted" || host.streamingMessage.stopReason === "error") {
          if (!errorMessage) {
            errorMessage = host.streamingMessage.errorMessage || "Error";
          }
          const pendingComponents = Array.from(host.pendingTools.values());
          if (pendingComponents.length > 0) {
            const [first, ...rest] = pendingComponents;
            first.completeWithError(errorMessage);
            for (const component of rest) {
              component.completeWithError();
            }
          }
          host.pendingTools.clear();
        } else {
          for (const [, component] of host.pendingTools.entries()) {
            component.setArgsComplete();
          }
          replaceCompactToolRowsWithPhaseSummary(host);
        }
        host.streamingComponent = void 0;
        host.streamingMessage = void 0;
        renderedSegments = [];
        orphanedSegments = [];
        lastContentLength = 0;
        if (pinnedBorder) pinnedBorder.stopSpinner();
        host.pinnedMessageContainer.clear();
        lastPinnedText = "";
        hasToolsInTurn = false;
        pinnedBorder = void 0;
        pinnedTextComponent = void 0;
        host.footer.invalidate();
      }
      host.ui.requestRender();
      break;
    case "tool_execution_start":
      if (!host.pendingTools.has(event.toolCallId)) {
        const component = new ToolExecutionComponent(
          event.toolName,
          event.args,
          { showImages: host.settingsManager.getShowImages() },
          host.getRegisteredToolDefinition(event.toolName),
          host.ui
        );
        component.setExpanded(host.toolOutputExpanded);
        host.chatContainer.addChild(component);
        host.pendingTools.set(event.toolCallId, component);
        renderedSegments.push({ kind: "tool", contentIndex: Number.MAX_SAFE_INTEGER, component });
        host.ui.requestRender();
      }
      break;
    case "tool_execution_update": {
      const component = host.pendingTools.get(event.toolCallId);
      if (component) {
        component.updateResult({ ...event.partialResult, isError: false }, true);
        host.ui.requestRender();
      }
      break;
    }
    case "tool_execution_end": {
      const component = host.pendingTools.get(event.toolCallId);
      if (component) {
        component.updateResult({ ...event.result, isError: event.isError });
        replaceCompactToolRowsWithPhaseSummary(host);
        host.ui.requestRender();
      }
      break;
    }
    case "agent_end":
      if (host.loadingAnimation) {
        host.loadingAnimation.stop();
        host.loadingAnimation = void 0;
        host.statusContainer.clear();
      }
      if (host.streamingComponent && host.streamingMessage) {
        host.streamingComponent.setShowMetadata(true);
        host.streamingComponent.updateContent(host.streamingMessage);
      }
      replaceCompactToolRowsWithPhaseSummary(host);
      host.streamingComponent = void 0;
      host.streamingMessage = void 0;
      renderedSegments = [];
      orphanedSegments = [];
      lastContentLength = 0;
      host.pendingTools.clear();
      if (pinnedBorder) {
        pinnedBorder.stopSpinner();
      }
      host.pinnedMessageContainer.clear();
      lastPinnedText = "";
      hasToolsInTurn = false;
      pinnedBorder = void 0;
      pinnedTextComponent = void 0;
      await host.checkShutdownRequested();
      host.ui.requestRender();
      break;
    case "auto_compaction_start":
      host.autoCompactionEscapeHandler = host.defaultEditor.onEscape;
      host.defaultEditor.onEscape = () => host.session.abortCompaction();
      host.statusContainer.clear();
      host.autoCompactionLoader = new Loader(
        host.ui,
        (spinner) => theme.fg("accent", spinner),
        (text) => theme.fg("muted", text),
        `${event.reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... (${appKey(host.keybindings, "interrupt")} to cancel)`
      );
      host.statusContainer.addChild(host.autoCompactionLoader);
      host.ui.requestRender();
      break;
    case "auto_compaction_end":
      if (host.autoCompactionEscapeHandler) {
        host.defaultEditor.onEscape = host.autoCompactionEscapeHandler;
        host.autoCompactionEscapeHandler = void 0;
      }
      if (host.autoCompactionLoader) {
        host.autoCompactionLoader.stop();
        host.autoCompactionLoader = void 0;
        host.statusContainer.clear();
      }
      if (event.aborted) {
        host.showStatus("Auto-compaction cancelled");
      } else if (event.result) {
        host.chatContainer.clear();
        host.rebuildChatFromMessages();
        host.addMessageToChat({
          role: "compactionSummary",
          tokensBefore: event.result.tokensBefore,
          summary: event.result.summary,
          timestamp: Date.now()
        });
        host.footer.invalidate();
      } else if (event.errorMessage) {
        host.chatContainer.addChild(new Spacer(1));
        host.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
      }
      void host.flushCompactionQueue({ willRetry: event.willRetry });
      host.ui.requestRender();
      break;
    case "auto_retry_start":
      host.retryEscapeHandler = host.defaultEditor.onEscape;
      host.defaultEditor.onEscape = () => host.session.abortRetry();
      host.statusContainer.clear();
      host.retryLoader = new Loader(
        host.ui,
        (spinner) => theme.fg("warning", spinner),
        (text) => theme.fg("muted", text),
        `Retrying (${event.attempt}/${event.maxAttempts}) in ${Math.round(event.delayMs / 1e3)}s... (${appKey(host.keybindings, "interrupt")} to cancel)`
      );
      host.statusContainer.addChild(host.retryLoader);
      host.ui.requestRender();
      break;
    case "auto_retry_end":
      if (host.retryEscapeHandler) {
        host.defaultEditor.onEscape = host.retryEscapeHandler;
        host.retryEscapeHandler = void 0;
      }
      if (host.retryLoader) {
        host.retryLoader.stop();
        host.retryLoader = void 0;
        host.statusContainer.clear();
      }
      if (!event.success) {
        host.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
      }
      host.ui.requestRender();
      break;
    case "fallback_provider_switch":
      host.showStatus(`Switched from ${event.from} \u2192 ${event.to} (${event.reason})`);
      host.ui.requestRender();
      break;
    case "fallback_provider_restored":
      host.showStatus(`Restored to ${event.provider}`);
      host.ui.requestRender();
      break;
    case "fallback_chain_exhausted":
      host.showError(event.reason);
      host.ui.requestRender();
      break;
    case "image_overflow_recovery":
      host.showStatus(
        `Removed ${event.strippedCount} older image(s) to comply with API limits. Retrying...`
      );
      host.ui.requestRender();
      break;
  }
}
export {
  findLatestPinnableCandidates,
  findLatestPinnableText,
  handleAgentEvent
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb250cm9sbGVycy9jaGF0LWNvbnRyb2xsZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yIEludGVyYWN0aXZlIENoYXQgQ29udHJvbGxlclxuaW1wb3J0IHsgTG9hZGVyLCBNYXJrZG93biwgU3BhY2VyLCBUZXh0IH0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5cbmltcG9ydCB0eXBlIHsgSW50ZXJhY3RpdmVNb2RlRXZlbnQsIEludGVyYWN0aXZlTW9kZVN0YXRlSG9zdCB9IGZyb20gXCIuLi9pbnRlcmFjdGl2ZS1tb2RlLXN0YXRlLmpzXCI7XG5pbXBvcnQgeyB0aGVtZSB9IGZyb20gXCIuLi90aGVtZS90aGVtZS5qc1wiO1xuaW1wb3J0IHsgQXNzaXN0YW50TWVzc2FnZUNvbXBvbmVudCB9IGZyb20gXCIuLi9jb21wb25lbnRzL2Fzc2lzdGFudC1tZXNzYWdlLmpzXCI7XG5pbXBvcnQge1xuXHRUb29sRXhlY3V0aW9uQ29tcG9uZW50LFxuXHRUb29sUGhhc2VTdW1tYXJ5Q29tcG9uZW50LFxuXHR0eXBlIFRvb2xFeGVjdXRpb25QaGFzZSxcbn0gZnJvbSBcIi4uL2NvbXBvbmVudHMvdG9vbC1leGVjdXRpb24uanNcIjtcbmltcG9ydCB7IER5bmFtaWNCb3JkZXIgfSBmcm9tIFwiLi4vY29tcG9uZW50cy9keW5hbWljLWJvcmRlci5qc1wiO1xuaW1wb3J0IHsgYXBwS2V5IH0gZnJvbSBcIi4uL2NvbXBvbmVudHMva2V5YmluZGluZy1oaW50cy5qc1wiO1xuXG4vLyBUcmFja3MgdGhlIGxhc3QgcHJvY2Vzc2VkIGNvbnRlbnQgaW5kZXggdG8gYXZvaWQgcmUtc2Nhbm5pbmcgYWxsIGJsb2NrcyBvbiBldmVyeSBtZXNzYWdlX3VwZGF0ZVxubGV0IGxhc3RQcm9jZXNzZWRDb250ZW50SW5kZXggPSAwO1xuXG4vLyBUcmFja3MgdGhlIHByZXZpb3VzIGNvbnRlbnRbXSBsZW5ndGggc28gd2UgY2FuIGRldGVjdCB3aGVuIGFuIGFkYXB0ZXIgcmVzZXRzXG4vLyB0aGUgYXNzaXN0YW50IGNvbnRlbnQgYXJyYXkgZm9yIGEgbmV3IHByb3ZpZGVyIHN1Yi10dXJuIHdpdGhpbiBvbmUgbGlmZWN5Y2xlLlxubGV0IGxhc3RDb250ZW50TGVuZ3RoID0gMDtcblxuLy8gLS0tIFNlZ21lbnQgd2Fsa2VyIHN0YXRlIChwZXIgc3RyZWFtaW5nIGFzc2lzdGFudCB0dXJuKSAtLS1cbnR5cGUgUmVuZGVyZWRTZWdtZW50ID1cblx0fCB7XG5cdFx0a2luZDogXCJ0ZXh0LXJ1blwiO1xuXHRcdHN0YXJ0SW5kZXg6IG51bWJlcjtcblx0XHRlbmRJbmRleDogbnVtYmVyO1xuXHRcdGNvbnRlbnRUeXBlOiBcInRleHRcIiB8IFwidGhpbmtpbmdcIjtcblx0XHRjb21wb25lbnQ6IEFzc2lzdGFudE1lc3NhZ2VDb21wb25lbnQ7XG5cdH1cblx0fCB7IGtpbmQ6IFwidG9vbFwiOyBjb250ZW50SW5kZXg6IG51bWJlcjsgY29tcG9uZW50OiBUb29sRXhlY3V0aW9uQ29tcG9uZW50IH1cblx0fCB7IGtpbmQ6IFwidG9vbC1zdW1tYXJ5XCI7IGNvbXBvbmVudDogVG9vbFBoYXNlU3VtbWFyeUNvbXBvbmVudDsgcGhhc2VzOiBUb29sRXhlY3V0aW9uUGhhc2VbXSB9O1xuXG5sZXQgcmVuZGVyZWRTZWdtZW50czogUmVuZGVyZWRTZWdtZW50W10gPSBbXTtcbi8vIFdoZW4gcHJvdmlkZXJzIHJldXNlIG9uZSBhc3Npc3RhbnQgbGlmZWN5Y2xlIGFjcm9zcyBpbnRlcm5hbCBzdWItdHVybnMsXG4vLyBhIGNvbnRlbnRbXSBzaHJpbmsgcmVzZXRzIHJlbmRlcmVkU2VnbWVudHMuIEtlZXAgdGhlIGRpc3BsYWNlZCBzZWdtZW50cyBzb1xuLy8gY2xhdWRlLWNvZGUgTUNQIHBydW5pbmcgY2FuIHJlbW92ZSBzdGFsZSBwcm92aXNpb25hbCB0ZXh0IGxhdGVyLlxubGV0IG9ycGhhbmVkU2VnbWVudHM6IFJlbmRlcmVkU2VnbWVudFtdID0gW107XG5cbmZ1bmN0aW9uIGhhc1Zpc2libGVBc3Npc3RhbnRDb250ZW50KG1lc3NhZ2U6IHsgY29udGVudDogQXJyYXk8YW55PiB9KTogYm9vbGVhbiB7XG5cdHJldHVybiBtZXNzYWdlLmNvbnRlbnQuc29tZShcblx0XHQoYykgPT5cblx0XHRcdChjLnR5cGUgPT09IFwidGV4dFwiICYmIHR5cGVvZiBjLnRleHQgPT09IFwic3RyaW5nXCIgJiYgYy50ZXh0LnRyaW0oKS5sZW5ndGggPiAwKVxuXHRcdFx0fHwgKGMudHlwZSA9PT0gXCJ0aGlua2luZ1wiICYmIHR5cGVvZiBjLnRoaW5raW5nID09PSBcInN0cmluZ1wiICYmIGMudGhpbmtpbmcudHJpbSgpLmxlbmd0aCA+IDApLFxuXHQpO1xufVxuXG5mdW5jdGlvbiBoYXNBc3Npc3RhbnRUb29sQmxvY2tzKG1lc3NhZ2U6IHsgY29udGVudDogQXJyYXk8YW55PiB9KTogYm9vbGVhbiB7XG5cdHJldHVybiBtZXNzYWdlLmNvbnRlbnQuc29tZSgoYykgPT4gYy50eXBlID09PSBcInRvb2xDYWxsXCIgfHwgYy50eXBlID09PSBcInNlcnZlclRvb2xVc2VcIik7XG59XG5cbi8vIFBpbm5hYmxlIHRleHQgY2FuZGlkYXRlczogbm9uLWVtcHR5IHRleHQgYmxvY2tzIHRoYXQgYXBwZWFyIHN0cmljdGx5IGJlZm9yZVxuLy8gdGhlIG1vc3QgcmVjZW50IHRvb2wgY2FsbCwgcmV0dXJuZWQgbmV3ZXN0LWZpcnN0LiBUZXh0IGJsb2NrcyBhZnRlciB0aGUgbGFzdFxuLy8gdG9vbCBjYWxsIGFyZSBzdGlsbCBzdHJlYW1pbmcgbGl2ZSBpbnRvIHRoZSBjaGF0IGNvbnRhaW5lci5cbmV4cG9ydCBmdW5jdGlvbiBmaW5kTGF0ZXN0UGlubmFibGVDYW5kaWRhdGVzKFxuXHRjb250ZW50QmxvY2tzOiBBcnJheTxhbnk+LFxuKTogQXJyYXk8eyB0ZXh0OiBzdHJpbmc7IGNvbnRlbnRJbmRleDogbnVtYmVyIH0+IHtcblx0bGV0IGxhc3RUb29sSWR4ID0gLTE7XG5cdGZvciAobGV0IGkgPSBjb250ZW50QmxvY2tzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG5cdFx0Y29uc3QgYyA9IGNvbnRlbnRCbG9ja3NbaV07XG5cdFx0aWYgKGM/LnR5cGUgPT09IFwidG9vbENhbGxcIiB8fCBjPy50eXBlID09PSBcInNlcnZlclRvb2xVc2VcIikge1xuXHRcdFx0bGFzdFRvb2xJZHggPSBpO1xuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXHR9XG5cdGNvbnN0IG91dDogQXJyYXk8eyB0ZXh0OiBzdHJpbmc7IGNvbnRlbnRJbmRleDogbnVtYmVyIH0+ID0gW107XG5cdGZvciAobGV0IGkgPSBsYXN0VG9vbElkeCAtIDE7IGkgPj0gMDsgaS0tKSB7XG5cdFx0Y29uc3QgYyA9IGNvbnRlbnRCbG9ja3NbaV07XG5cdFx0aWYgKGM/LnR5cGUgPT09IFwidGV4dFwiICYmIHR5cGVvZiBjLnRleHQgPT09IFwic3RyaW5nXCIgJiYgYy50ZXh0LnRyaW0oKSkge1xuXHRcdFx0b3V0LnB1c2goeyB0ZXh0OiBjLnRleHQudHJpbSgpLCBjb250ZW50SW5kZXg6IGkgfSk7XG5cdFx0fVxuXHR9XG5cdHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmaW5kTGF0ZXN0UGlubmFibGVUZXh0KGNvbnRlbnRCbG9ja3M6IEFycmF5PGFueT4pOiBzdHJpbmcge1xuXHRyZXR1cm4gZmluZExhdGVzdFBpbm5hYmxlQ2FuZGlkYXRlcyhjb250ZW50QmxvY2tzKVswXT8udGV4dCA/PyBcIlwiO1xufVxuXG4vLyBTdW0gcmVuZGVyZWQgbGluZSBjb3VudHMgb2Ygc2VnbWVudHMgdGhhdCBhcHBlYXIgc3RyaWN0bHkgYWZ0ZXIgdGhlIGdpdmVuXG4vLyBjb250ZW50LWJsb2NrIGluZGV4LiBVc2VkIHRvIGRlY2lkZSB3aGV0aGVyIGEgcGlubmFibGUgdGV4dCBibG9jayBoYXNcbi8vIHNjcm9sbGVkIG91dCBvZiB0aGUgdmlld3BvcnQgYW5kIHRoZXJlZm9yZSB3YXJyYW50cyBtaXJyb3JpbmcuXG5mdW5jdGlvbiByb3dzUmVuZGVyZWRBZnRlckNvbnRlbnRJbmRleChjb250ZW50SW5kZXg6IG51bWJlciwgd2lkdGg6IG51bWJlcik6IG51bWJlciB7XG5cdGxldCByb3dzID0gMDtcblx0Zm9yIChjb25zdCBzZWcgb2YgcmVuZGVyZWRTZWdtZW50cykge1xuXHRcdHRyeSB7XG5cdFx0XHRpZiAoc2VnLmtpbmQgPT09IFwidGV4dC1ydW5cIiAmJiBzZWcuc3RhcnRJbmRleCA+IGNvbnRlbnRJbmRleCkge1xuXHRcdFx0XHRyb3dzICs9IHNlZy5jb21wb25lbnQucmVuZGVyKHdpZHRoKS5sZW5ndGg7XG5cdFx0XHR9IGVsc2UgaWYgKHNlZy5raW5kID09PSBcInRvb2xcIiAmJiBzZWcuY29udGVudEluZGV4ID4gY29udGVudEluZGV4KSB7XG5cdFx0XHRcdHJvd3MgKz0gc2VnLmNvbXBvbmVudC5yZW5kZXIod2lkdGgpLmxlbmd0aDtcblx0XHRcdH1cblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIERlZmVuc2l2ZTogYSBjb21wb25lbnQgdGhhdCB0aHJvd3MgZHVyaW5nIG1lYXN1cmVtZW50IHNob3VsZG4ndFxuXHRcdFx0Ly8gZGVzdGFiaWxpemUgcGlubmVkLXpvbmUgbG9naWMuIFNraXAgaXQuXG5cdFx0fVxuXHR9XG5cdHJldHVybiByb3dzO1xufVxuXG4vLyBUcmFja3MgdGhlIGxhdGVzdCBhc3Npc3RhbnQgdGV4dCBmb3IgdGhlIHBpbm5lZCBtZXNzYWdlIHpvbmVcbmxldCBsYXN0UGlubmVkVGV4dCA9IFwiXCI7XG4vLyBXaGV0aGVyIGFueSB0b29sIGV4ZWN1dGlvbiBoYXMgYmVlbiBhZGRlZCBpbiB0aGlzIGFzc2lzdGFudCB0dXJuICh0cmlnZ2VycyBwaW5uZWQgZGlzcGxheSlcbmxldCBoYXNUb29sc0luVHVybiA9IGZhbHNlO1xuLy8gUmVmZXJlbmNlIHRvIHRoZSBwaW5uZWQgYm9yZGVyIHNvIHdlIGNhbiB0b2dnbGUgaXRzIGxhYmVsIGJldHdlZW4gd29ya2luZy9pZGxlXG5sZXQgcGlubmVkQm9yZGVyOiBEeW5hbWljQm9yZGVyIHwgdW5kZWZpbmVkO1xuLy8gUmVmZXJlbmNlIHRvIHRoZSBwaW5uZWQgbWFya2Rvd24gY29tcG9uZW50IGJlbG93IHRoZSBib3JkZXJcbmxldCBwaW5uZWRUZXh0Q29tcG9uZW50OiBNYXJrZG93biB8IHVuZGVmaW5lZDtcblxuZnVuY3Rpb24gbWVyZ2VUb29sUGhhc2VzKHBoYXNlczogVG9vbEV4ZWN1dGlvblBoYXNlW10pOiBUb29sRXhlY3V0aW9uUGhhc2VbXSB7XG5cdGNvbnN0IG1lcmdlZDogVG9vbEV4ZWN1dGlvblBoYXNlW10gPSBbXTtcblx0Zm9yIChjb25zdCBwaGFzZSBvZiBwaGFzZXMpIHtcblx0XHRjb25zdCBwcmV2aW91cyA9IG1lcmdlZFttZXJnZWQubGVuZ3RoIC0gMV07XG5cdFx0aWYgKHByZXZpb3VzPy5sYWJlbCA9PT0gcGhhc2UubGFiZWwpIHtcblx0XHRcdHByZXZpb3VzLmNvdW50ICs9IHBoYXNlLmNvdW50O1xuXHRcdFx0cHJldmlvdXMuZHVyYXRpb25NcyArPSBwaGFzZS5kdXJhdGlvbk1zO1xuXHRcdFx0cHJldmlvdXMudGFyZ2V0cyA9IG1lcmdlVGFyZ2V0cyhwcmV2aW91cy50YXJnZXRzLCBwaGFzZS50YXJnZXRzKTtcblx0XHRcdGlmIChwcmV2aW91cy5hY3Rpb25MYWJlbCAhPT0gcGhhc2UuYWN0aW9uTGFiZWwpIHtcblx0XHRcdFx0cHJldmlvdXMuYWN0aW9uTGFiZWwgPSB1bmRlZmluZWQ7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIHtcblx0XHRcdG1lcmdlZC5wdXNoKHsgLi4ucGhhc2UsIHRhcmdldHM6IHBoYXNlLnRhcmdldHMgPyBbLi4ucGhhc2UudGFyZ2V0c10gOiB1bmRlZmluZWQgfSk7XG5cdFx0fVxuXHR9XG5cdHJldHVybiBtZXJnZWQ7XG59XG5cbmZ1bmN0aW9uIG1lcmdlVGFyZ2V0cyhleGlzdGluZzogc3RyaW5nW10gfCB1bmRlZmluZWQsIGluY29taW5nOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdIHwgdW5kZWZpbmVkIHtcblx0aWYgKCFleGlzdGluZyAmJiAhaW5jb21pbmcpIHJldHVybiB1bmRlZmluZWQ7XG5cdGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0Y29uc3QgbWVyZ2VkOiBzdHJpbmdbXSA9IFtdO1xuXHRmb3IgKGNvbnN0IHRhcmdldCBvZiBbLi4uKGV4aXN0aW5nID8/IFtdKSwgLi4uKGluY29taW5nID8/IFtdKV0pIHtcblx0XHRpZiAoIXRhcmdldCB8fCBzZWVuLmhhcyh0YXJnZXQpKSBjb250aW51ZTtcblx0XHRzZWVuLmFkZCh0YXJnZXQpO1xuXHRcdG1lcmdlZC5wdXNoKHRhcmdldCk7XG5cdH1cblx0cmV0dXJuIG1lcmdlZDtcbn1cblxuZnVuY3Rpb24gcmVwbGFjZUNvbXBhY3RUb29sUm93c1dpdGhQaGFzZVN1bW1hcnkoXG5cdGhvc3Q6IEludGVyYWN0aXZlTW9kZVN0YXRlSG9zdCAmIHsgdWk6IHsgcmVxdWVzdFJlbmRlcjogKCkgPT4gdm9pZCB9IH0sXG4pOiB2b2lkIHtcblx0bGV0IGNoYW5nZWQgPSBmYWxzZTtcblx0Y29uc3QgbmV4dFJlbmRlcmVkU2VnbWVudHM6IFJlbmRlcmVkU2VnbWVudFtdID0gW107XG5cdGxldCByb2xsdXBSdW46IEFycmF5PHtcblx0XHRzZWc6IEV4dHJhY3Q8UmVuZGVyZWRTZWdtZW50LCB7IGtpbmQ6IFwidG9vbFwiIHwgXCJ0b29sLXN1bW1hcnlcIiB9Pjtcblx0XHRwaGFzZXM6IFRvb2xFeGVjdXRpb25QaGFzZVtdO1xuXHR9PiA9IFtdO1xuXG5cdGNvbnN0IGZsdXNoUm9sbHVwUnVuID0gKCkgPT4ge1xuXHRcdGNvbnN0IGFjdGlvbkNvdW50ID0gcm9sbHVwUnVuLnJlZHVjZShcblx0XHRcdCh0b3RhbCwgaXRlbSkgPT4gdG90YWwgKyBpdGVtLnBoYXNlcy5yZWR1Y2UoKHN1bSwgcGhhc2UpID0+IHN1bSArIHBoYXNlLmNvdW50LCAwKSxcblx0XHRcdDAsXG5cdFx0KTtcblx0XHRpZiAoYWN0aW9uQ291bnQgPCAyKSB7XG5cdFx0XHRuZXh0UmVuZGVyZWRTZWdtZW50cy5wdXNoKC4uLnJvbGx1cFJ1bi5tYXAoKGl0ZW0pID0+IGl0ZW0uc2VnKSk7XG5cdFx0XHRyb2xsdXBSdW4gPSBbXTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBmaXJzdEluZGV4ID0gTWF0aC5tYXgoMCwgaG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLmluZGV4T2Yocm9sbHVwUnVuWzBdLnNlZy5jb21wb25lbnQpKTtcblx0XHRjb25zdCBwaGFzZXMgPSBtZXJnZVRvb2xQaGFzZXMocm9sbHVwUnVuLmZsYXRNYXAoKGl0ZW0pID0+IGl0ZW0ucGhhc2VzKSk7XG5cdFx0Y29uc3Qgc3VtbWFyeSA9IG5ldyBUb29sUGhhc2VTdW1tYXJ5Q29tcG9uZW50KHBoYXNlcyk7XG5cblx0XHRmb3IgKGNvbnN0IHsgc2VnIH0gb2Ygcm9sbHVwUnVuKSB7XG5cdFx0XHRob3N0LmNoYXRDb250YWluZXIucmVtb3ZlQ2hpbGQoc2VnLmNvbXBvbmVudCk7XG5cdFx0fVxuXG5cdFx0aG9zdC5jaGF0Q29udGFpbmVyLmFkZENoaWxkKHN1bW1hcnkpO1xuXHRcdGNvbnN0IHN1bW1hcnlJbmRleCA9IGhvc3QuY2hhdENvbnRhaW5lci5jaGlsZHJlbi5pbmRleE9mKHN1bW1hcnkpO1xuXHRcdGlmIChzdW1tYXJ5SW5kZXggIT09IC0xICYmIHN1bW1hcnlJbmRleCAhPT0gZmlyc3RJbmRleCkge1xuXHRcdFx0aG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLnNwbGljZShzdW1tYXJ5SW5kZXgsIDEpO1xuXHRcdFx0aG9zdC5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLnNwbGljZShmaXJzdEluZGV4LCAwLCBzdW1tYXJ5KTtcblx0XHRcdChob3N0LmNoYXRDb250YWluZXIgYXMgdW5rbm93biBhcyB7IF9wcmV2UmVuZGVyOiBzdHJpbmdbXSB8IG51bGwgfSkuX3ByZXZSZW5kZXIgPSBudWxsO1xuXHRcdH1cblxuXHRcdGNoYW5nZWQgPSB0cnVlO1xuXHRcdG5leHRSZW5kZXJlZFNlZ21lbnRzLnB1c2goeyBraW5kOiBcInRvb2wtc3VtbWFyeVwiLCBjb21wb25lbnQ6IHN1bW1hcnksIHBoYXNlcyB9KTtcblx0XHRyb2xsdXBSdW4gPSBbXTtcblx0fTtcblxuXHRmb3IgKGNvbnN0IHNlZyBvZiByZW5kZXJlZFNlZ21lbnRzKSB7XG5cdFx0Y29uc3QgcGhhc2UgPSBzZWcua2luZCA9PT0gXCJ0b29sXCIgPyBzZWcuY29tcG9uZW50LmdldFJvbGx1cFBoYXNlKCkgOiBudWxsO1xuXHRcdGlmIChzZWcua2luZCA9PT0gXCJ0b29sXCIgJiYgcGhhc2UpIHtcblx0XHRcdHJvbGx1cFJ1bi5wdXNoKHsgc2VnLCBwaGFzZXM6IFtwaGFzZV0gfSk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cdFx0aWYgKHNlZy5raW5kID09PSBcInRvb2wtc3VtbWFyeVwiKSB7XG5cdFx0XHRyb2xsdXBSdW4ucHVzaCh7IHNlZywgcGhhc2VzOiBzZWcuY29tcG9uZW50LmdldFBoYXNlcygpIH0pO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Zmx1c2hSb2xsdXBSdW4oKTtcblx0XHRuZXh0UmVuZGVyZWRTZWdtZW50cy5wdXNoKHNlZyk7XG5cdH1cblx0Zmx1c2hSb2xsdXBSdW4oKTtcblxuXHRpZiAoY2hhbmdlZCkge1xuXHRcdHJlbmRlcmVkU2VnbWVudHMgPSBuZXh0UmVuZGVyZWRTZWdtZW50cztcblx0XHRob3N0LnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0fVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlQWdlbnRFdmVudChob3N0OiBJbnRlcmFjdGl2ZU1vZGVTdGF0ZUhvc3QgJiB7XG5cdGluaXQ6ICgpID0+IFByb21pc2U8dm9pZD47XG5cdGdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3M6ICgpID0+IGFueTtcblx0YWRkTWVzc2FnZVRvQ2hhdDogKG1lc3NhZ2U6IGFueSwgb3B0aW9ucz86IGFueSkgPT4gdm9pZDtcblx0Zm9ybWF0V2ViU2VhcmNoUmVzdWx0OiAoY29udGVudDogdW5rbm93bikgPT4gc3RyaW5nO1xuXHRnZXRSZWdpc3RlcmVkVG9vbERlZmluaXRpb246ICh0b29sTmFtZTogc3RyaW5nKSA9PiBhbnk7XG5cdGNoZWNrU2h1dGRvd25SZXF1ZXN0ZWQ6ICgpID0+IFByb21pc2U8dm9pZD47XG5cdHJlYnVpbGRDaGF0RnJvbU1lc3NhZ2VzOiAoKSA9PiB2b2lkO1xuXHRmbHVzaENvbXBhY3Rpb25RdWV1ZTogKG9wdGlvbnM/OiB7IHdpbGxSZXRyeT86IGJvb2xlYW4gfSkgPT4gUHJvbWlzZTx2b2lkPjtcblx0c2hvd1N0YXR1czogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZDtcblx0c2hvd0Vycm9yOiAobWVzc2FnZTogc3RyaW5nKSA9PiB2b2lkO1xuXHR1cGRhdGVQZW5kaW5nTWVzc2FnZXNEaXNwbGF5OiAoKSA9PiB2b2lkO1xuXHR1cGRhdGVUZXJtaW5hbFRpdGxlOiAoKSA9PiB2b2lkO1xuXHR1cGRhdGVFZGl0b3JCb3JkZXJDb2xvcjogKCkgPT4gdm9pZDtcblx0cGVuZGluZ01lc3NhZ2VzQ29udGFpbmVyOiB7IGNsZWFyOiAoKSA9PiB2b2lkIH07XG59LCBldmVudDogSW50ZXJhY3RpdmVNb2RlRXZlbnQpOiBQcm9taXNlPHZvaWQ+IHtcblx0aWYgKCFob3N0LmlzSW5pdGlhbGl6ZWQpIHtcblx0XHRhd2FpdCBob3N0LmluaXQoKTtcblx0fVxuXG5cdGhvc3QuZm9vdGVyLmludmFsaWRhdGUoKTtcblx0Y29uc3QgdGltZXN0YW1wRm9ybWF0ID0gaG9zdC5zZXR0aW5nc01hbmFnZXIuZ2V0VGltZXN0YW1wRm9ybWF0KCk7XG5cblx0Ly8gUmVzZXQgY29udGVudCBpbmRleCB0cmFja2VyIGFuZCBwaW5uZWQgc3RhdGUgd2hlbiBhIG5ldyBhc3Npc3RhbnQgbWVzc2FnZSBzdGFydHNcblx0aWYgKGV2ZW50LnR5cGUgPT09IFwibWVzc2FnZV9zdGFydFwiICYmIGV2ZW50Lm1lc3NhZ2Uucm9sZSA9PT0gXCJhc3Npc3RhbnRcIikge1xuXHRcdGxhc3RQcm9jZXNzZWRDb250ZW50SW5kZXggPSAwO1xuXHRcdGxhc3RDb250ZW50TGVuZ3RoID0gMDtcblx0XHRsYXN0UGlubmVkVGV4dCA9IFwiXCI7XG5cdFx0aGFzVG9vbHNJblR1cm4gPSBmYWxzZTtcblx0XHRyZW5kZXJlZFNlZ21lbnRzID0gW107XG5cdFx0b3JwaGFuZWRTZWdtZW50cyA9IFtdO1xuXHRcdGlmIChwaW5uZWRCb3JkZXIpIHBpbm5lZEJvcmRlci5zdG9wU3Bpbm5lcigpO1xuXHRcdHBpbm5lZEJvcmRlciA9IHVuZGVmaW5lZDtcblx0XHRwaW5uZWRUZXh0Q29tcG9uZW50ID0gdW5kZWZpbmVkO1xuXHRcdGhvc3QucGlubmVkTWVzc2FnZUNvbnRhaW5lci5jbGVhcigpO1xuXHR9XG5cblx0c3dpdGNoIChldmVudC50eXBlKSB7XG5cdFx0Y2FzZSBcInNlc3Npb25fc3RhdGVfY2hhbmdlZFwiOlxuXHRcdFx0c3dpdGNoIChldmVudC5yZWFzb24pIHtcblx0XHRcdFx0Y2FzZSBcIm5ld19zZXNzaW9uXCI6XG5cdFx0XHRcdGNhc2UgXCJzd2l0Y2hfc2Vzc2lvblwiOlxuXHRcdFx0XHRjYXNlIFwiZm9ya1wiOlxuXHRcdFx0XHRcdGhvc3Quc3RyZWFtaW5nQ29tcG9uZW50ID0gdW5kZWZpbmVkO1xuXHRcdFx0XHRcdGhvc3Quc3RyZWFtaW5nTWVzc2FnZSA9IHVuZGVmaW5lZDtcblx0XHRcdFx0XHRob3N0LnBlbmRpbmdUb29scy5jbGVhcigpO1xuXHRcdFx0XHRcdGhvc3QucGVuZGluZ01lc3NhZ2VzQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0XHRcdFx0aG9zdC5waW5uZWRNZXNzYWdlQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0XHRcdFx0bGFzdFBpbm5lZFRleHQgPSBcIlwiO1xuXHRcdFx0XHRcdGhhc1Rvb2xzSW5UdXJuID0gZmFsc2U7XG5cdFx0XHRcdFx0cmVuZGVyZWRTZWdtZW50cyA9IFtdO1xuXHRcdFx0XHRcdG9ycGhhbmVkU2VnbWVudHMgPSBbXTtcblx0XHRcdFx0XHRsYXN0Q29udGVudExlbmd0aCA9IDA7XG5cdFx0XHRcdFx0aWYgKHBpbm5lZEJvcmRlcikgcGlubmVkQm9yZGVyLnN0b3BTcGlubmVyKCk7XG5cdFx0XHRcdFx0cGlubmVkQm9yZGVyID0gdW5kZWZpbmVkO1xuXHRcdFx0XHRcdHBpbm5lZFRleHRDb21wb25lbnQgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0aG9zdC5jb21wYWN0aW9uUXVldWVkTWVzc2FnZXMgPSBbXTtcblx0XHRcdFx0XHRob3N0LnJlYnVpbGRDaGF0RnJvbU1lc3NhZ2VzKCk7XG5cdFx0XHRcdFx0aG9zdC51cGRhdGVQZW5kaW5nTWVzc2FnZXNEaXNwbGF5KCk7XG5cdFx0XHRcdFx0aG9zdC51cGRhdGVUZXJtaW5hbFRpdGxlKCk7XG5cdFx0XHRcdFx0aG9zdC51cGRhdGVFZGl0b3JCb3JkZXJDb2xvcigpO1xuXHRcdFx0XHRcdGhvc3QudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0Y2FzZSBcInNldF9zZXNzaW9uX25hbWVcIjpcblx0XHRcdFx0XHRob3N0LnVwZGF0ZVRlcm1pbmFsVGl0bGUoKTtcblx0XHRcdFx0XHRob3N0LnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdGNhc2UgXCJzZXRfbW9kZWxcIjpcblx0XHRcdFx0Y2FzZSBcInNldF90aGlua2luZ19sZXZlbFwiOlxuXHRcdFx0XHRcdGhvc3QudXBkYXRlRWRpdG9yQm9yZGVyQ29sb3IoKTtcblx0XHRcdFx0XHRob3N0LnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdGRlZmF1bHQ6XG5cdFx0XHRcdFx0aG9zdC51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdGNhc2UgXCJhZ2VudF9zdGFydFwiOlxuXHRcdFx0aG9zdC5jbGVhckJsb2NraW5nRXJyb3IoKTtcblx0XHRcdGlmIChob3N0LnJldHJ5RXNjYXBlSGFuZGxlcikge1xuXHRcdFx0XHRob3N0LmRlZmF1bHRFZGl0b3Iub25Fc2NhcGUgPSBob3N0LnJldHJ5RXNjYXBlSGFuZGxlcjtcblx0XHRcdFx0aG9zdC5yZXRyeUVzY2FwZUhhbmRsZXIgPSB1bmRlZmluZWQ7XG5cdFx0XHR9XG5cdFx0XHRpZiAoaG9zdC5yZXRyeUxvYWRlcikge1xuXHRcdFx0XHRob3N0LnJldHJ5TG9hZGVyLnN0b3AoKTtcblx0XHRcdFx0aG9zdC5yZXRyeUxvYWRlciA9IHVuZGVmaW5lZDtcblx0XHRcdH1cblx0XHRcdGlmIChob3N0LmxvYWRpbmdBbmltYXRpb24pIHtcblx0XHRcdFx0aG9zdC5sb2FkaW5nQW5pbWF0aW9uLnN0b3AoKTtcblx0XHRcdH1cblx0XHRcdGhvc3Quc3RhdHVzQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0XHRob3N0LmxvYWRpbmdBbmltYXRpb24gPSBuZXcgTG9hZGVyKFxuXHRcdFx0XHRob3N0LnVpLFxuXHRcdFx0XHQoc3Bpbm5lcikgPT4gdGhlbWUuZmcoXCJhY2NlbnRcIiwgc3Bpbm5lciksXG5cdFx0XHRcdCh0ZXh0KSA9PiB0aGVtZS5mZyhcIm11dGVkXCIsIHRleHQpLFxuXHRcdFx0XHRob3N0LmRlZmF1bHRXb3JraW5nTWVzc2FnZSxcblx0XHRcdCk7XG5cdFx0XHRob3N0LnN0YXR1c0NvbnRhaW5lci5hZGRDaGlsZChob3N0LmxvYWRpbmdBbmltYXRpb24pO1xuXHRcdFx0aWYgKGhvc3QucGVuZGluZ1dvcmtpbmdNZXNzYWdlICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0aWYgKGhvc3QucGVuZGluZ1dvcmtpbmdNZXNzYWdlKSB7XG5cdFx0XHRcdFx0aG9zdC5sb2FkaW5nQW5pbWF0aW9uLnNldE1lc3NhZ2UoaG9zdC5wZW5kaW5nV29ya2luZ01lc3NhZ2UpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGhvc3QucGVuZGluZ1dvcmtpbmdNZXNzYWdlID0gdW5kZWZpbmVkO1xuXHRcdFx0fVxuXHRcdFx0aG9zdC51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHRicmVhaztcblxuXHRcdGNhc2UgXCJtZXNzYWdlX3N0YXJ0XCI6XG5cdFx0XHRpZiAoZXZlbnQubWVzc2FnZS5yb2xlID09PSBcImN1c3RvbVwiKSB7XG5cdFx0XHRcdGhvc3QuYWRkTWVzc2FnZVRvQ2hhdChldmVudC5tZXNzYWdlKTtcblx0XHRcdFx0aG9zdC51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHR9IGVsc2UgaWYgKGV2ZW50Lm1lc3NhZ2Uucm9sZSA9PT0gXCJ1c2VyXCIpIHtcblx0XHRcdFx0aG9zdC5hZGRNZXNzYWdlVG9DaGF0KGV2ZW50Lm1lc3NhZ2UpO1xuXHRcdFx0XHRob3N0LnVwZGF0ZVBlbmRpbmdNZXNzYWdlc0Rpc3BsYXkoKTtcblx0XHRcdFx0aG9zdC51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHR9IGVsc2UgaWYgKGV2ZW50Lm1lc3NhZ2Uucm9sZSA9PT0gXCJhc3Npc3RhbnRcIikge1xuXHRcdFx0XHRob3N0LnN0cmVhbWluZ01lc3NhZ2UgPSBldmVudC5tZXNzYWdlO1xuXHRcdFx0XHQvLyBFeHRlcm5hbC10b29sIHByb3ZpZGVycyBjYW4gc3RyZWFtIG11bHRpcGxlIGFzc2lzdGFudCB0dXJucyB0aHJvdWdoXG5cdFx0XHRcdC8vIG9uZSByZXNwb25zZS4gRGVsYXkgY29tcG9uZW50IGNyZWF0aW9uIHVudGlsIHZpc2libGUgYXNzaXN0YW50IHRleHRcblx0XHRcdFx0Ly8gYXJyaXZlcyBzbyB0b29sIG91dHB1dHMga2VlcCBjaHJvbm9sb2dpY2FsIG9yZGVyaW5nLlxuXHRcdFx0XHRob3N0LnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdH1cblx0XHRcdGJyZWFrO1xuXG5cdFx0Y2FzZSBcIm1lc3NhZ2VfdXBkYXRlXCI6XG5cdFx0XHRpZiAoZXZlbnQubWVzc2FnZS5yb2xlID09PSBcImFzc2lzdGFudFwiKSB7XG5cdFx0XHRcdGhvc3Quc3RyZWFtaW5nTWVzc2FnZSA9IGV2ZW50Lm1lc3NhZ2U7XG5cdFx0XHRcdGNvbnN0IGlubmVyRXZlbnQgPSBldmVudC5hc3Npc3RhbnRNZXNzYWdlRXZlbnQ7XG5cblx0XHRcdFx0bGV0IGV4dGVybmFsVG9vbFJlc3VsdDpcblx0XHRcdFx0XHR8IHsgdG9vbENhbGxJZDogc3RyaW5nOyBjb250ZW50OiBBcnJheTx7IHR5cGU6IHN0cmluZzsgdGV4dD86IHN0cmluZzsgZGF0YT86IHN0cmluZzsgbWltZVR5cGU/OiBzdHJpbmcgfT47IGRldGFpbHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+OyBpc0Vycm9yOiBib29sZWFuIH1cblx0XHRcdFx0XHR8IHVuZGVmaW5lZDtcblx0XHRcdFx0aWYgKGlubmVyRXZlbnQudHlwZSA9PT0gXCJ0b29sY2FsbF9lbmRcIiAmJiBpbm5lckV2ZW50LnRvb2xDYWxsKSB7XG5cdFx0XHRcdFx0Y29uc3QgdGMgPSBpbm5lckV2ZW50LnRvb2xDYWxsIGFzIGFueTtcblx0XHRcdFx0XHRjb25zdCBleHQgPSB0Yy5leHRlcm5hbFJlc3VsdDtcblx0XHRcdFx0XHRpZiAoZXh0KSB7XG5cdFx0XHRcdFx0XHRleHRlcm5hbFRvb2xSZXN1bHQgPSB7XG5cdFx0XHRcdFx0XHRcdHRvb2xDYWxsSWQ6IHRjLmlkLFxuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBleHQuY29udGVudCA/PyBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJcIiB9XSxcblx0XHRcdFx0XHRcdFx0ZGV0YWlsczogZXh0LmRldGFpbHMgPz8ge30sXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IGV4dC5pc0Vycm9yID8/IGZhbHNlLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0gZWxzZSBpZiAoaW5uZXJFdmVudC50eXBlID09PSBcInNlcnZlcl90b29sX3VzZVwiKSB7XG5cdFx0XHRcdFx0Y29uc3QgaWR4ID0gdHlwZW9mIGlubmVyRXZlbnQuY29udGVudEluZGV4ID09PSBcIm51bWJlclwiID8gaW5uZXJFdmVudC5jb250ZW50SW5kZXggOiAtMTtcblx0XHRcdFx0XHRjb25zdCBibG9jayA9IGlkeCA+PSAwID8gKGhvc3Quc3RyZWFtaW5nTWVzc2FnZS5jb250ZW50W2lkeF0gYXMgYW55KSA6IHVuZGVmaW5lZDtcblx0XHRcdFx0XHRjb25zdCBleHQgPSBibG9jaz8uZXh0ZXJuYWxSZXN1bHQ7XG5cdFx0XHRcdFx0aWYgKGJsb2NrPy5pZCAmJiBleHQpIHtcblx0XHRcdFx0XHRcdGV4dGVybmFsVG9vbFJlc3VsdCA9IHtcblx0XHRcdFx0XHRcdFx0dG9vbENhbGxJZDogYmxvY2suaWQsXG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IGV4dC5jb250ZW50ID8/IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIlwiIH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiBleHQuZGV0YWlscyA/PyB7fSxcblx0XHRcdFx0XHRcdFx0aXNFcnJvcjogZXh0LmlzRXJyb3IgPz8gZmFsc2UsXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGNvbnRlbnRCbG9ja3MgPSBob3N0LnN0cmVhbWluZ01lc3NhZ2UuY29udGVudDtcblx0XHRcdFx0Ly8gU29tZSBhZGFwdGVycyAobm90YWJseSBjbGF1ZGUtY29kZSkgcmV1c2UgYSBzaW5nbGUgYXNzaXN0YW50XG5cdFx0XHRcdC8vIGxpZmVjeWNsZSB3aGlsZSBpbnRlcm5hbGx5IHNwYW5uaW5nIG11bHRpcGxlIHByb3ZpZGVyIHN1Yi10dXJucy5cblx0XHRcdFx0Ly8gV2hlbiBhIG5ldyBzdWItdHVybiBzdGFydHMsIGNvbnRlbnRbXSBsZW5ndGggc2hyaW5rcyBiYWNrIHRvIDAvMS5cblx0XHRcdFx0Ly8gVGhlIHNjYW4gbG9vcCBuZWVkcyBpdHMgaW5kZXggcmVzZXQsIEFORCB0aGUgc2VnbWVudCB3YWxrZXInc1xuXHRcdFx0XHQvLyByZW5kZXJlZFNlZ21lbnRzIG1hcCBtdXN0IGJlIGNsZWFyZWQgc28gZXhpc3RpbmcgdGV4dC1ydW5cblx0XHRcdFx0Ly8gY29tcG9uZW50cyBkb24ndCBnZXQgb3ZlcndyaXR0ZW4gaW4gcGxhY2Ugd2l0aCBuZXcgc3ViLXR1cm5cblx0XHRcdFx0Ly8gY29udGVudCAoIzQxNDQgcmVncmVzc2lvbikuIFByaW9yIHN1Yi10dXJuIGNoaWxkcmVuIHN0YXkgaW5cblx0XHRcdFx0Ly8gY2hhdENvbnRhaW5lciBhcyBmcm96ZW4gaGlzdG9yeTsgbmV3IHNlZ21lbnRzIGFwcGVuZCBhZnRlciB0aGVtLlxuXHRcdFx0XHRpZiAoY29udGVudEJsb2Nrcy5sZW5ndGggPCBsYXN0Q29udGVudExlbmd0aCkge1xuXHRcdFx0XHRcdC8vIEFjY3VtdWxhdGUgYWNyb3NzIHN1Y2Nlc3NpdmUgc2hyaW5rcyBcdTIwMTQgb3ZlcndyaXRpbmcgd291bGQgZHJvcFxuXHRcdFx0XHRcdC8vIHNlZ21lbnRzIGRpc3BsYWNlZCBieSBhbiBlYXJsaWVyIHNocmluaywgbGVhdmluZyB0aGVtIHN0cmFuZGVkXG5cdFx0XHRcdFx0Ly8gaW4gY2hhdENvbnRhaW5lciBvbmNlIHRoZSBwcnVuZSBwYXNzIGZpbmFsbHkgcnVucy5cblx0XHRcdFx0XHRvcnBoYW5lZFNlZ21lbnRzID0gWy4uLm9ycGhhbmVkU2VnbWVudHMsIC4uLnJlbmRlcmVkU2VnbWVudHNdO1xuXHRcdFx0XHRcdHJlbmRlcmVkU2VnbWVudHMgPSBbXTtcblx0XHRcdFx0XHRsYXN0UGlubmVkVGV4dCA9IFwiXCI7XG5cdFx0XHRcdFx0bGFzdFByb2Nlc3NlZENvbnRlbnRJbmRleCA9IDA7XG5cdFx0XHRcdH0gZWxzZSBpZiAobGFzdFByb2Nlc3NlZENvbnRlbnRJbmRleCA+PSBjb250ZW50QmxvY2tzLmxlbmd0aCkge1xuXHRcdFx0XHRcdGxhc3RQcm9jZXNzZWRDb250ZW50SW5kZXggPSAwO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGxhc3RDb250ZW50TGVuZ3RoID0gY29udGVudEJsb2Nrcy5sZW5ndGg7XG5cdFx0XHRcdGZvciAobGV0IGkgPSBsYXN0UHJvY2Vzc2VkQ29udGVudEluZGV4OyBpIDwgY29udGVudEJsb2Nrcy5sZW5ndGg7IGkrKykge1xuXHRcdFx0XHRcdGNvbnN0IGNvbnRlbnQgPSBjb250ZW50QmxvY2tzW2ldO1xuXHRcdFx0XHRcdGlmIChjb250ZW50LnR5cGUgPT09IFwidG9vbENhbGxcIikge1xuXHRcdFx0XHRcdFx0aWYgKCFob3N0LnBlbmRpbmdUb29scy5oYXMoY29udGVudC5pZCkpIHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgY29tcG9uZW50ID0gbmV3IFRvb2xFeGVjdXRpb25Db21wb25lbnQoXG5cdFx0XHRcdFx0XHRcdFx0Y29udGVudC5uYW1lLFxuXHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQuYXJndW1lbnRzLFxuXHRcdFx0XHRcdFx0XHRcdHsgc2hvd0ltYWdlczogaG9zdC5zZXR0aW5nc01hbmFnZXIuZ2V0U2hvd0ltYWdlcygpIH0sXG5cdFx0XHRcdFx0XHRcdFx0aG9zdC5nZXRSZWdpc3RlcmVkVG9vbERlZmluaXRpb24oY29udGVudC5uYW1lKSxcblx0XHRcdFx0XHRcdFx0XHRob3N0LnVpLFxuXHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0XHRjb21wb25lbnQuc2V0RXhwYW5kZWQoaG9zdC50b29sT3V0cHV0RXhwYW5kZWQpO1xuXHRcdFx0XHRcdFx0XHRob3N0LmNoYXRDb250YWluZXIuYWRkQ2hpbGQoY29tcG9uZW50KTtcblx0XHRcdFx0XHRcdFx0aG9zdC5wZW5kaW5nVG9vbHMuc2V0KGNvbnRlbnQuaWQsIGNvbXBvbmVudCk7XG5cdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRob3N0LnBlbmRpbmdUb29scy5nZXQoY29udGVudC5pZCk/LnVwZGF0ZUFyZ3MoY29udGVudC5hcmd1bWVudHMpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH0gZWxzZSBpZiAoY29udGVudC50eXBlID09PSBcInNlcnZlclRvb2xVc2VcIikge1xuXHRcdFx0XHRcdFx0aWYgKCFob3N0LnBlbmRpbmdUb29scy5oYXMoY29udGVudC5pZCkpIHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgY29tcG9uZW50ID0gbmV3IFRvb2xFeGVjdXRpb25Db21wb25lbnQoXG5cdFx0XHRcdFx0XHRcdFx0Y29udGVudC5uYW1lLFxuXHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQuaW5wdXQgPz8ge30sXG5cdFx0XHRcdFx0XHRcdFx0eyBzaG93SW1hZ2VzOiBob3N0LnNldHRpbmdzTWFuYWdlci5nZXRTaG93SW1hZ2VzKCkgfSxcblx0XHRcdFx0XHRcdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRcdFx0XHRcdFx0aG9zdC51aSxcblx0XHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdFx0Y29tcG9uZW50LnNldEV4cGFuZGVkKGhvc3QudG9vbE91dHB1dEV4cGFuZGVkKTtcblx0XHRcdFx0XHRcdFx0aG9zdC5jaGF0Q29udGFpbmVyLmFkZENoaWxkKGNvbXBvbmVudCk7XG5cdFx0XHRcdFx0XHRcdGhvc3QucGVuZGluZ1Rvb2xzLnNldChjb250ZW50LmlkLCBjb21wb25lbnQpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH0gZWxzZSBpZiAoY29udGVudC50eXBlID09PSBcIndlYlNlYXJjaFJlc3VsdFwiKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBjb21wb25lbnQgPSBob3N0LnBlbmRpbmdUb29scy5nZXQoY29udGVudC50b29sVXNlSWQpO1xuXHRcdFx0XHRcdFx0aWYgKGNvbXBvbmVudCkge1xuXHRcdFx0XHRcdFx0XHRpZiAocHJvY2Vzcy5lbnYuUElfT0ZGTElORSA9PT0gXCIxXCIpIHtcblx0XHRcdFx0XHRcdFx0XHRjb21wb25lbnQudXBkYXRlUmVzdWx0KHtcblx0XHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIldlYiBzZWFyY2ggZGlzYWJsZWQgKG9mZmxpbmUgbW9kZSlcIiB9XSxcblx0XHRcdFx0XHRcdFx0XHRcdGlzRXJyb3I6IGZhbHNlLFxuXHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IHNlYXJjaENvbnRlbnQgPSBjb250ZW50LmNvbnRlbnQ7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgaXNFcnJvciA9IHNlYXJjaENvbnRlbnQgJiYgdHlwZW9mIHNlYXJjaENvbnRlbnQgPT09IFwib2JqZWN0XCIgJiYgXCJ0eXBlXCIgaW4gKHNlYXJjaENvbnRlbnQgYXMgYW55KSAmJiAoc2VhcmNoQ29udGVudCBhcyBhbnkpLnR5cGUgPT09IFwid2ViX3NlYXJjaF90b29sX3Jlc3VsdF9lcnJvclwiO1xuXHRcdFx0XHRcdFx0XHRcdGNvbXBvbmVudC51cGRhdGVSZXN1bHQoe1xuXHRcdFx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGhvc3QuZm9ybWF0V2ViU2VhcmNoUmVzdWx0KHNlYXJjaENvbnRlbnQpIH1dLFxuXHRcdFx0XHRcdFx0XHRcdFx0aXNFcnJvcjogISFpc0Vycm9yLFxuXHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gV2hlbiB0aGUgc3RyZWFtIGFkYXB0ZXIgc2lnbmFscyBhIGNvbXBsZXRlZCB0b29sIGNhbGwgd2l0aCBhblxuXHRcdFx0XHQvLyBleHRlcm5hbCByZXN1bHQgKGZyb20gQ2xhdWRlIENvZGUgU0RLKSwgdXBkYXRlIHRoZSBwZW5kaW5nXG5cdFx0XHRcdC8vIFRvb2xFeGVjdXRpb25Db21wb25lbnQgaW1tZWRpYXRlbHkgc28gb3V0cHV0IGlzIHZpc2libGUgaW5cblx0XHRcdFx0Ly8gcmVhbC10aW1lIGluc3RlYWQgb2Ygd2FpdGluZyBmb3IgdGhlIHNlc3Npb24gdG8gZW5kLlxuXHRcdFx0XHRpZiAoZXh0ZXJuYWxUb29sUmVzdWx0KSB7XG5cdFx0XHRcdFx0Y29uc3QgY29tcG9uZW50ID0gaG9zdC5wZW5kaW5nVG9vbHMuZ2V0KGV4dGVybmFsVG9vbFJlc3VsdC50b29sQ2FsbElkKTtcblx0XHRcdFx0XHRpZiAoY29tcG9uZW50KSB7XG5cdFx0XHRcdFx0XHRjb21wb25lbnQudXBkYXRlUmVzdWx0KHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogZXh0ZXJuYWxUb29sUmVzdWx0LmNvbnRlbnQsXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IGV4dGVybmFsVG9vbFJlc3VsdC5kZXRhaWxzLFxuXHRcdFx0XHRcdFx0XHRpc0Vycm9yOiBleHRlcm5hbFRvb2xSZXN1bHQuaXNFcnJvcixcblx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0cmVwbGFjZUNvbXBhY3RUb29sUm93c1dpdGhQaGFzZVN1bW1hcnkoaG9zdCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gU2VnbWVudCB3YWxrZXI6IHJlbmRlciBjb250ZW50IGJsb2NrcyBpbiBzdHJlYW0gb3JkZXIsIGFwcGVuZC1vbmx5LlxuXHRcdFx0XHQvLyBCdWlsZCBkZXNpcmVkIHNlZ21lbnQgcGxhbiBmcm9tIGNvbnRlbnRbXS5cblx0XHRcdFx0e1xuXHRcdFx0XHRcdGNvbnN0IGJsb2NrcyA9IGhvc3Quc3RyZWFtaW5nTWVzc2FnZS5jb250ZW50O1xuXHRcdFx0XHRcdGNvbnN0IGlzQ2xhdWRlQ29kZVByb3ZpZGVyID0gaG9zdC5zdHJlYW1pbmdNZXNzYWdlLnByb3ZpZGVyID09PSBcImNsYXVkZS1jb2RlXCI7XG5cdFx0XHRcdFx0Y29uc3QgaGFzTWNwVG9vbEJsb2NrID0gYmxvY2tzLnNvbWUoKGI6IGFueSkgPT4ge1xuXHRcdFx0XHRcdFx0aWYgKGI/LnR5cGUgPT09IFwidG9vbENhbGxcIikge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4gdHlwZW9mIGI/Lm1jcFNlcnZlciA9PT0gXCJzdHJpbmdcIiB8fCBTdHJpbmcoYj8ubmFtZSA/PyBcIlwiKS5zdGFydHNXaXRoKFwibWNwX19cIik7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRpZiAoYj8udHlwZSA9PT0gXCJzZXJ2ZXJUb29sVXNlXCIpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHR5cGVvZiBiPy5tY3BTZXJ2ZXIgPT09IFwic3RyaW5nXCIgfHwgU3RyaW5nKGI/Lm5hbWUgPz8gXCJcIikuc3RhcnRzV2l0aChcIm1jcF9fXCIpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdGNvbnN0IGZpcnN0VG9vbElkeCA9IGJsb2Nrcy5maW5kSW5kZXgoKGI6IGFueSkgPT4gYi50eXBlID09PSBcInRvb2xDYWxsXCIgfHwgYi50eXBlID09PSBcInNlcnZlclRvb2xVc2VcIik7XG5cdFx0XHRcdFx0Y29uc3QgaGFzUG9zdFRvb2xUZXh0ID0gZmlyc3RUb29sSWR4ID49IDBcblx0XHRcdFx0XHRcdCYmIGJsb2Nrcy5zb21lKFxuXHRcdFx0XHRcdFx0XHQoYjogYW55LCBpZHg6IG51bWJlcikgPT4gKFxuXHRcdFx0XHRcdFx0XHRcdGlkeCA+IGZpcnN0VG9vbElkeFxuXHRcdFx0XHRcdFx0XHRcdCYmIGI/LnR5cGUgPT09IFwidGV4dFwiXG5cdFx0XHRcdFx0XHRcdFx0JiYgdHlwZW9mIGI/LnRleHQgPT09IFwic3RyaW5nXCJcblx0XHRcdFx0XHRcdFx0XHQmJiBiLnRleHQudHJpbSgpLmxlbmd0aCA+IDBcblx0XHRcdFx0XHRcdFx0KSxcblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0Ly8gT25seSBwcnVuZSBwcm92aXNpb25hbCBwcmUtdG9vbCBwcm9zZSBhZnRlciBwb3N0LXRvb2wgcHJvc2UgZXhpc3RzLFxuXHRcdFx0XHRcdC8vIHNvIE1DUCB0b29sLW9ubHkgd2luZG93cyBkbyBub3QgYmxhbmsgdGhlIGFzc2lzdGFudCBjb250ZW50LlxuXHRcdFx0XHRcdGNvbnN0IHNob3VsZERyb3BQcmVUb29sUHJvc2UgPSBpc0NsYXVkZUNvZGVQcm92aWRlciAmJiBoYXNNY3BUb29sQmxvY2sgJiYgaGFzUG9zdFRvb2xUZXh0O1xuXHRcdFx0XHRcdHR5cGUgRGVzaXJlZFNlZ21lbnQgPVxuXHRcdFx0XHRcdFx0fCB7IGtpbmQ6IFwidGV4dC1ydW5cIjsgc3RhcnRJbmRleDogbnVtYmVyOyBlbmRJbmRleDogbnVtYmVyOyBjb250ZW50VHlwZTogXCJ0ZXh0XCIgfCBcInRoaW5raW5nXCIgfVxuXHRcdFx0XHRcdFx0fCB7IGtpbmQ6IFwidG9vbFwiOyBjb250ZW50SW5kZXg6IG51bWJlcjsgdG9vbElkOiBzdHJpbmcgfTtcblx0XHRcdFx0Y29uc3QgZGVzaXJlZDogRGVzaXJlZFNlZ21lbnRbXSA9IFtdO1xuXHRcdFx0XHRsZXQgcnVuU3RhcnQgPSAtMTtcblx0XHRcdFx0bGV0IHJ1bkVuZCA9IC0xO1xuXHRcdFx0XHRsZXQgcnVuVHlwZTogXCJ0ZXh0XCIgfCBcInRoaW5raW5nXCIgfCB1bmRlZmluZWQ7XG5cdFx0XHRcdGNvbnN0IGNsb3NlUnVuID0gKCkgPT4ge1xuXHRcdFx0XHRcdGlmIChydW5TdGFydCAhPT0gLTEgJiYgcnVuVHlwZSkge1xuXHRcdFx0XHRcdFx0ZGVzaXJlZC5wdXNoKHsga2luZDogXCJ0ZXh0LXJ1blwiLCBzdGFydEluZGV4OiBydW5TdGFydCwgZW5kSW5kZXg6IHJ1bkVuZCwgY29udGVudFR5cGU6IHJ1blR5cGUgfSk7XG5cdFx0XHRcdFx0XHRydW5TdGFydCA9IC0xO1xuXHRcdFx0XHRcdFx0cnVuRW5kID0gLTE7XG5cdFx0XHRcdFx0XHRydW5UeXBlID0gdW5kZWZpbmVkO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdGZvciAobGV0IGkgPSAwOyBpIDwgYmxvY2tzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRcdFx0Y29uc3QgYiA9IGJsb2Nrc1tpXTtcblx0XHRcdFx0XHRjb25zdCBibG9ja1R5cGUgPSBiLnR5cGUgPT09IFwidGV4dFwiIHx8IGIudHlwZSA9PT0gXCJ0aGlua2luZ1wiID8gYi50eXBlIDogdW5kZWZpbmVkO1xuXHRcdFx0XHRcdGNvbnN0IGlzVGV4dExpa2UgPSBibG9ja1R5cGUgPT09IFwidGV4dFwiIHx8IGJsb2NrVHlwZSA9PT0gXCJ0aGlua2luZ1wiO1xuXHRcdFx0XHRcdGNvbnN0IGlzVG9vbCA9IGIudHlwZSA9PT0gXCJ0b29sQ2FsbFwiIHx8IGIudHlwZSA9PT0gXCJzZXJ2ZXJUb29sVXNlXCI7XG5cdFx0XHRcdFx0Ly8gRm9yIENsYXVkZSBDb2RlIE1DUCB0dXJucywgcHJ1bmUgb25seSBwcmUtdG9vbCBwcm9zZSwgbmV2ZXIgdGhpbmtpbmcuXG5cdFx0XHRcdFx0Y29uc3QgdGV4dFZhbHVlID0gYmxvY2tUeXBlID09PSBcInRleHRcIiAmJiB0eXBlb2YgYj8udGV4dCA9PT0gXCJzdHJpbmdcIiA/IGIudGV4dCA6IFwiXCI7XG5cdFx0XHRcdFx0Y29uc3QgaXNMaWtlbHlRdWVzdGlvbiA9IGJsb2NrVHlwZSA9PT0gXCJ0ZXh0XCIgJiYgdHlwZW9mIHRleHRWYWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiAvXFw/XFxzKiQvLnRlc3QodGV4dFZhbHVlLnRyaW0oKSk7XG5cdFx0XHRcdFx0Y29uc3Qgc2hvdWxkU2tpcFByb3NlID0gc2hvdWxkRHJvcFByZVRvb2xQcm9zZVxuXHRcdFx0XHRcdFx0JiYgZmlyc3RUb29sSWR4ID49IDBcblx0XHRcdFx0XHRcdCYmIGkgPCBmaXJzdFRvb2xJZHhcblx0XHRcdFx0XHRcdCYmIGJsb2NrVHlwZSA9PT0gXCJ0ZXh0XCJcblx0XHRcdFx0XHRcdCYmICFpc0xpa2VseVF1ZXN0aW9uO1xuXHRcdFx0XHRcdGlmIChzaG91bGRTa2lwUHJvc2UpIHtcblx0XHRcdFx0XHRcdGNsb3NlUnVuKCk7XG5cdFx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRpZiAoaXNUZXh0TGlrZSkge1xuXHRcdFx0XHRcdFx0XHRpZiAocnVuU3RhcnQgPT09IC0xKSB7XG5cdFx0XHRcdFx0XHRcdFx0cnVuU3RhcnQgPSBpO1xuXHRcdFx0XHRcdFx0XHRcdHJ1bkVuZCA9IGk7XG5cdFx0XHRcdFx0XHRcdFx0cnVuVHlwZSA9IGJsb2NrVHlwZTtcblx0XHRcdFx0XHRcdFx0fSBlbHNlIGlmIChydW5UeXBlICE9PSBibG9ja1R5cGUpIHtcblx0XHRcdFx0XHRcdFx0XHRjbG9zZVJ1bigpO1xuXHRcdFx0XHRcdFx0XHRcdHJ1blN0YXJ0ID0gaTtcblx0XHRcdFx0XHRcdFx0XHRydW5FbmQgPSBpO1xuXHRcdFx0XHRcdFx0XHRcdHJ1blR5cGUgPSBibG9ja1R5cGU7XG5cdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0cnVuRW5kID0gaTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0Y2xvc2VSdW4oKTtcblx0XHRcdFx0XHRcdFx0aWYgKGlzVG9vbCkge1xuXHRcdFx0XHRcdFx0XHRcdGRlc2lyZWQucHVzaCh7IGtpbmQ6IFwidG9vbFwiLCBjb250ZW50SW5kZXg6IGksIHRvb2xJZDogYi5pZCB9KTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRjbG9zZVJ1bigpO1xuXG5cdFx0XHRcdFx0Ly8gQ2xhdWRlIENvZGUgTUNQIGNhbiBlbWl0IHByb3Zpc2lvbmFsIHByZS10b29sIHByb3NlIHRoYXQgZ2V0c1xuXHRcdFx0XHRcdC8vIHN1cGVyc2VkZWQgYnkgcG9zdC10b29sIG91dHB1dC4gUHJ1bmUgc3RhbGUgdGV4dC1ydW4gc2VnbWVudHMgc29cblx0XHRcdFx0XHQvLyB0aGUgZmluYWwgYXNzaXN0YW50IG91dHB1dCByZW1haW5zIGJlbG93IHRvb2wgb3V0cHV0LlxuXHRcdFx0XHRcdGlmIChzaG91bGREcm9wUHJlVG9vbFByb3NlICYmIGZpcnN0VG9vbElkeCA+PSAwKSB7XG5cdFx0XHRcdFx0XHRpZiAob3JwaGFuZWRTZWdtZW50cy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHJlbWFpbmluZ09ycGhhbnM6IFJlbmRlcmVkU2VnbWVudFtdID0gW107XG5cdFx0XHRcdFx0XHRcdGZvciAoY29uc3Qgb3JwaGFuIG9mIG9ycGhhbmVkU2VnbWVudHMpIHtcblx0XHRcdFx0XHRcdFx0XHRpZiAob3JwaGFuLmtpbmQgPT09IFwidGV4dC1ydW5cIiAmJiBvcnBoYW4uY29udGVudFR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRob3N0LmNoYXRDb250YWluZXIucmVtb3ZlQ2hpbGQob3JwaGFuLmNvbXBvbmVudCk7XG5cdFx0XHRcdFx0XHRcdFx0XHRpZiAoaG9zdC5zdHJlYW1pbmdDb21wb25lbnQgPT09IG9ycGhhbi5jb21wb25lbnQpIHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0aG9zdC5zdHJlYW1pbmdDb21wb25lbnQgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0cmVtYWluaW5nT3JwaGFucy5wdXNoKG9ycGhhbik7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0b3JwaGFuZWRTZWdtZW50cyA9IHJlbWFpbmluZ09ycGhhbnM7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRjb25zdCBkZXNpcmVkVGV4dEtleXMgPSBuZXcgU2V0KFxuXHRcdFx0XHRcdFx0XHRkZXNpcmVkXG5cdFx0XHRcdFx0XHRcdFx0LmZpbHRlcigoc2VnKTogc2VnIGlzIEV4dHJhY3Q8RGVzaXJlZFNlZ21lbnQsIHsga2luZDogXCJ0ZXh0LXJ1blwiIH0+ID0+IHNlZy5raW5kID09PSBcInRleHQtcnVuXCIpXG5cdFx0XHRcdFx0XHRcdFx0Lm1hcCgoc2VnKSA9PiBgJHtzZWcuY29udGVudFR5cGV9OiR7c2VnLnN0YXJ0SW5kZXh9YCksXG5cdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0Y29uc3QgZGVzaXJlZFRvb2xJbmRpY2VzID0gbmV3IFNldChcblx0XHRcdFx0XHRcdFx0ZGVzaXJlZFxuXHRcdFx0XHRcdFx0XHRcdC5maWx0ZXIoKHNlZyk6IHNlZyBpcyBFeHRyYWN0PERlc2lyZWRTZWdtZW50LCB7IGtpbmQ6IFwidG9vbFwiIH0+ID0+IHNlZy5raW5kID09PSBcInRvb2xcIilcblx0XHRcdFx0XHRcdFx0XHQubWFwKChzZWcpID0+IHNlZy5jb250ZW50SW5kZXgpLFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdGNvbnN0IG5leHRSZW5kZXJlZDogUmVuZGVyZWRTZWdtZW50W10gPSBbXTtcblx0XHRcdFx0XHRcdGZvciAoY29uc3Qgc2VnIG9mIHJlbmRlcmVkU2VnbWVudHMpIHtcblx0XHRcdFx0XHRcdFx0aWYgKFxuXHRcdFx0XHRcdFx0XHRcdHNlZy5raW5kID09PSBcInRleHQtcnVuXCJcblx0XHRcdFx0XHRcdFx0XHQmJiBzZWcuY29udGVudFR5cGUgPT09IFwidGV4dFwiXG5cdFx0XHRcdFx0XHRcdFx0JiYgIWRlc2lyZWRUZXh0S2V5cy5oYXMoYCR7c2VnLmNvbnRlbnRUeXBlfToke3NlZy5zdGFydEluZGV4fWApXG5cdFx0XHRcdFx0XHRcdCkge1xuXHRcdFx0XHRcdFx0XHRcdGhvc3QuY2hhdENvbnRhaW5lci5yZW1vdmVDaGlsZChzZWcuY29tcG9uZW50KTtcblx0XHRcdFx0XHRcdFx0XHRpZiAoaG9zdC5zdHJlYW1pbmdDb21wb25lbnQgPT09IHNlZy5jb21wb25lbnQpIHtcblx0XHRcdFx0XHRcdFx0XHRcdGhvc3Quc3RyZWFtaW5nQ29tcG9uZW50ID0gdW5kZWZpbmVkO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRpZiAoc2VnLmtpbmQgPT09IFwidG9vbFwiICYmICFkZXNpcmVkVG9vbEluZGljZXMuaGFzKHNlZy5jb250ZW50SW5kZXgpKSB7XG5cdFx0XHRcdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0bmV4dFJlbmRlcmVkLnB1c2goc2VnKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdHJlbmRlcmVkU2VnbWVudHMgPSBuZXh0UmVuZGVyZWQ7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gQXBwZW5kIGFueSBuZXdseSBuZWVkZWQgc2VnbWVudHMgKG5ldmVyIHJlb3JkZXIgZXhpc3Rpbmcgb25lcykuXG5cdFx0XHRcdFx0Zm9yIChjb25zdCBzZWcgb2YgZGVzaXJlZCkge1xuXHRcdFx0XHRcdFx0aWYgKHNlZy5raW5kID09PSBcInRvb2xcIikge1xuXHRcdFx0XHRcdFx0XHQvLyBUb29sIHNlZ21lbnRzIGFyZSBhbHJlYWR5IGhhbmRsZWQgYWJvdmUgdmlhIHBlbmRpbmdUb29sczsganVzdFxuXHRcdFx0XHRcdFx0XHQvLyByZWdpc3RlciB0aGVtIGluIHJlbmRlcmVkU2VnbWVudHMgaWYgbm90IHlldCB0cmFja2VkLlxuXHRcdFx0XHRcdFx0XHRjb25zdCBleGlzdGluZyA9IHJlbmRlcmVkU2VnbWVudHMuZmluZChcblx0XHRcdFx0XHRcdFx0XHQocykgPT4gcy5raW5kID09PSBcInRvb2xcIiAmJiBzLmNvbnRlbnRJbmRleCA9PT0gc2VnLmNvbnRlbnRJbmRleCxcblx0XHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdFx0aWYgKCFleGlzdGluZykge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IGNvbXAgPSBob3N0LnBlbmRpbmdUb29scy5nZXQoc2VnLnRvb2xJZCk7XG5cdFx0XHRcdFx0XHRcdFx0aWYgKGNvbXApIHtcblx0XHRcdFx0XHRcdFx0XHRcdHJlbmRlcmVkU2VnbWVudHMucHVzaCh7IGtpbmQ6IFwidG9vbFwiLCBjb250ZW50SW5kZXg6IHNlZy5jb250ZW50SW5kZXgsIGNvbXBvbmVudDogY29tcCB9KTtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdC8vIHRleHQtcnVuIHNlZ21lbnRcblx0XHRcdFx0XHRcdFx0Y29uc3QgZXhpc3RpbmcgPSByZW5kZXJlZFNlZ21lbnRzLmZpbmQoXG5cdFx0XHRcdFx0XHRcdFx0KHMpID0+IHMua2luZCA9PT0gXCJ0ZXh0LXJ1blwiICYmIHMuc3RhcnRJbmRleCA9PT0gc2VnLnN0YXJ0SW5kZXggJiYgcy5jb250ZW50VHlwZSA9PT0gc2VnLmNvbnRlbnRUeXBlLFxuXHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0XHRpZiAoIWV4aXN0aW5nKSB7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgY29tcCA9IG5ldyBBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50KFxuXHRcdFx0XHRcdFx0XHRcdFx0dW5kZWZpbmVkLFxuXHRcdFx0XHRcdFx0XHRcdFx0aG9zdC5oaWRlVGhpbmtpbmdCbG9jayxcblx0XHRcdFx0XHRcdFx0XHRcdGhvc3QuZ2V0TWFya2Rvd25UaGVtZVdpdGhTZXR0aW5ncygpLFxuXHRcdFx0XHRcdFx0XHRcdFx0dGltZXN0YW1wRm9ybWF0LFxuXHRcdFx0XHRcdFx0XHRcdFx0eyBzdGFydEluZGV4OiBzZWcuc3RhcnRJbmRleCwgZW5kSW5kZXg6IHNlZy5lbmRJbmRleCB9LFxuXHRcdFx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRcdFx0aG9zdC5jaGF0Q29udGFpbmVyLmFkZENoaWxkKGNvbXApO1xuXHRcdFx0XHRcdFx0XHRcdHJlbmRlcmVkU2VnbWVudHMucHVzaCh7XG5cdFx0XHRcdFx0XHRcdFx0XHRraW5kOiBcInRleHQtcnVuXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRzdGFydEluZGV4OiBzZWcuc3RhcnRJbmRleCxcblx0XHRcdFx0XHRcdFx0XHRcdGVuZEluZGV4OiBzZWcuZW5kSW5kZXgsXG5cdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50VHlwZTogc2VnLmNvbnRlbnRUeXBlLFxuXHRcdFx0XHRcdFx0XHRcdFx0Y29tcG9uZW50OiBjb21wLFxuXHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRcdGhvc3Quc3RyZWFtaW5nQ29tcG9uZW50ID0gY29tcDtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdC8vIFVwZGF0ZSBhbGwgdHJhaWxpbmcgdGV4dC1ydW4gc2VnbWVudHMgd2l0aCB0aGUgbGF0ZXN0IG1lc3NhZ2Ugc29cblx0XHRcdFx0XHQvLyBzdHJlYW1pbmcgdGV4dCBncm93cyBpbiBwbGFjZS5cblx0XHRcdFx0XHRmb3IgKGNvbnN0IHNlZyBvZiByZW5kZXJlZFNlZ21lbnRzKSB7XG5cdFx0XHRcdFx0XHRpZiAoc2VnLmtpbmQgPT09IFwidGV4dC1ydW5cIikge1xuXHRcdFx0XHRcdFx0XHQvLyBGaW5kIGNvcnJlc3BvbmRpbmcgZGVzaXJlZCBzZWdtZW50IHRvIGdldCBjdXJyZW50IGVuZEluZGV4XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGQgPSBkZXNpcmVkLmZpbmQoXG5cdFx0XHRcdFx0XHRcdFx0KGRzKSA9PiBkcy5raW5kID09PSBcInRleHQtcnVuXCIgJiYgZHMuc3RhcnRJbmRleCA9PT0gc2VnLnN0YXJ0SW5kZXggJiYgZHMuY29udGVudFR5cGUgPT09IHNlZy5jb250ZW50VHlwZSxcblx0XHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdFx0aWYgKGQgJiYgZC5raW5kID09PSBcInRleHQtcnVuXCIgJiYgZC5lbmRJbmRleCAhPT0gc2VnLmVuZEluZGV4KSB7XG5cdFx0XHRcdFx0XHRcdFx0c2VnLmVuZEluZGV4ID0gZC5lbmRJbmRleDtcblx0XHRcdFx0XHRcdFx0XHRzZWcuY29tcG9uZW50LnNldFJhbmdlKHsgc3RhcnRJbmRleDogc2VnLnN0YXJ0SW5kZXgsIGVuZEluZGV4OiBzZWcuZW5kSW5kZXggfSk7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0c2VnLmNvbXBvbmVudC51cGRhdGVDb250ZW50KGhvc3Quc3RyZWFtaW5nTWVzc2FnZSk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gS2VlcCBzdHJlYW1pbmdDb21wb25lbnQgcG9pbnRpbmcgYXQgdGhlIGxhc3QgdGV4dC1ydW4gZm9yIG1lc3NhZ2VfZW5kIGNvbXBhdGliaWxpdHkuXG5cdFx0XHRcdFx0Y29uc3QgbGFzdFRleHRTZWcgPSBbLi4ucmVuZGVyZWRTZWdtZW50c10ucmV2ZXJzZSgpLmZpbmQoKHMpID0+IHMua2luZCA9PT0gXCJ0ZXh0LXJ1blwiKTtcblx0XHRcdFx0XHRpZiAobGFzdFRleHRTZWcgJiYgbGFzdFRleHRTZWcua2luZCA9PT0gXCJ0ZXh0LXJ1blwiKSB7XG5cdFx0XHRcdFx0XHRob3N0LnN0cmVhbWluZ0NvbXBvbmVudCA9IGxhc3RUZXh0U2VnLmNvbXBvbmVudDtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBVcGRhdGUgaW5kZXg6IGZ1bGx5IHByb2Nlc3NlZCBibG9ja3Mgd29uJ3QgbmVlZCByZS1zY2FubmluZy5cblx0XHRcdFx0Ly8gS2VlcCB0aGUgbGFzdCBibG9jaydzIGluZGV4IChpdCBtYXkgc3RpbGwgYmUgYWNjdW11bGF0aW5nIGRhdGEpLFxuXHRcdFx0XHQvLyBzbyB3ZSByZS1jaGVjayBpdCBuZXh0IHRpbWUgYnV0IHNraXAgYWxsIGVhcmxpZXIgb25lcy5cblx0XHRcdFx0aWYgKGNvbnRlbnRCbG9ja3MubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRcdGxhc3RQcm9jZXNzZWRDb250ZW50SW5kZXggPSBNYXRoLm1heCgwLCBjb250ZW50QmxvY2tzLmxlbmd0aCAtIDEpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gUGlubmVkIG1lc3NhZ2U6IG1pcnJvciB0aGUgbGF0ZXN0IGFzc2lzdGFudCB0ZXh0IGFib3ZlIHRoZSBlZGl0b3Jcblx0XHRcdFx0Ly8gd2hlbiB0b29sIGV4ZWN1dGlvbnMgcHVzaCBpdCBvdXQgb2YgdGhlIHZpZXdwb3J0LlxuXHRcdFx0XHRjb25zdCBoYXNUb29scyA9IGNvbnRlbnRCbG9ja3Muc29tZShcblx0XHRcdFx0XHQoYzogYW55KSA9PiBjLnR5cGUgPT09IFwidG9vbENhbGxcIiB8fCBjLnR5cGUgPT09IFwic2VydmVyVG9vbFVzZVwiLFxuXHRcdFx0XHQpO1xuXHRcdFx0XHRpZiAoaGFzVG9vbHMpIGhhc1Rvb2xzSW5UdXJuID0gdHJ1ZTtcblxuXHRcdFx0XHRpZiAoaGFzVG9vbHNJblR1cm4pIHtcblx0XHRcdFx0XHRjb25zdCBjYW5kaWRhdGVzID0gZmluZExhdGVzdFBpbm5hYmxlQ2FuZGlkYXRlcyhjb250ZW50QmxvY2tzKTtcblx0XHRcdFx0XHRjb25zdCB0ZXJtUm93cyA9IGhvc3QudWkudGVybWluYWwucm93cztcblx0XHRcdFx0XHRjb25zdCB0ZXJtQ29scyA9IGhvc3QudWkudGVybWluYWwuY29sdW1ucztcblx0XHRcdFx0XHRjb25zdCBwaW5uZWRNYXggPSBNYXRoLm1heCgzLCBNYXRoLmZsb29yKHRlcm1Sb3dzICogMC40KSk7XG5cdFx0XHRcdFx0Ly8gUmVzZXJ2ZSByb3dzIGZvciBwaW5uZWQgem9uZSArIGl0cyBib3JkZXIgKyBlZGl0b3IgKyBmb290ZXIgY2hyb21lLlxuXHRcdFx0XHRcdC8vIEFueXRoaW5nIGJlbG93IHRoaXMgcm93IGJ1ZGdldCBpcyBzdGlsbCBpbiB0aGUgdmlld3BvcnQuXG5cdFx0XHRcdFx0Y29uc3Qgb2Zmc2NyZWVuVGhyZXNob2xkID0gTWF0aC5tYXgoMSwgdGVybVJvd3MgLSBwaW5uZWRNYXggLSA4KTtcblxuXHRcdFx0XHRcdC8vIFdhbGsgY2FuZGlkYXRlcyBuZXdlc3RcdTIxOTJvbGRlc3Q7IHBpY2sgdGhlIGZpcnN0IHdob3NlIGZvbGxvd2luZ1xuXHRcdFx0XHRcdC8vIHNlZ21lbnRzIGhhdmUgcHVzaGVkIGVub3VnaCByb3dzIHRvIHNjcm9sbCBpdCBvZmYtc2NyZWVuLlxuXHRcdFx0XHRcdGxldCBwaWNrZWQ6IHsgdGV4dDogc3RyaW5nOyBjb250ZW50SW5kZXg6IG51bWJlciB9IHwgdW5kZWZpbmVkO1xuXHRcdFx0XHRcdGZvciAoY29uc3QgYyBvZiBjYW5kaWRhdGVzKSB7XG5cdFx0XHRcdFx0XHRpZiAocm93c1JlbmRlcmVkQWZ0ZXJDb250ZW50SW5kZXgoYy5jb250ZW50SW5kZXgsIHRlcm1Db2xzKSA+PSBvZmZzY3JlZW5UaHJlc2hvbGQpIHtcblx0XHRcdFx0XHRcdFx0cGlja2VkID0gYztcblx0XHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0aWYgKHBpY2tlZCkge1xuXHRcdFx0XHRcdFx0aWYgKHBpY2tlZC50ZXh0ICE9PSBsYXN0UGlubmVkVGV4dCkge1xuXHRcdFx0XHRcdFx0XHRsYXN0UGlubmVkVGV4dCA9IHBpY2tlZC50ZXh0O1xuXG5cdFx0XHRcdFx0XHRcdGlmICghcGlubmVkQm9yZGVyKSB7XG5cdFx0XHRcdFx0XHRcdFx0Ly8gRmlyc3QgdGltZTogY3JlYXRlIGJvcmRlciArIHRleHQgY29tcG9uZW50XG5cdFx0XHRcdFx0XHRcdFx0aG9zdC5waW5uZWRNZXNzYWdlQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0XHRcdFx0XHRcdFx0cGlubmVkQm9yZGVyID0gbmV3IER5bmFtaWNCb3JkZXIoXG5cdFx0XHRcdFx0XHRcdFx0XHQoc3RyOiBzdHJpbmcpID0+IHRoZW1lLmZnKFwiZGltXCIsIHN0ciksXG5cdFx0XHRcdFx0XHRcdFx0XHRcIldvcmtpbmcgXHUwMEI3IExhdGVzdCBPdXRwdXRcIixcblx0XHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0XHRcdHBpbm5lZEJvcmRlci5zdGFydFNwaW5uZXIoaG9zdC51aSwgKHN0cjogc3RyaW5nKSA9PiB0aGVtZS5mZyhcImFjY2VudFwiLCBzdHIpKTtcblx0XHRcdFx0XHRcdFx0XHRob3N0LnBpbm5lZE1lc3NhZ2VDb250YWluZXIuYWRkQ2hpbGQocGlubmVkQm9yZGVyKTtcblx0XHRcdFx0XHRcdFx0XHRwaW5uZWRUZXh0Q29tcG9uZW50ID0gbmV3IE1hcmtkb3duKHBpY2tlZC50ZXh0LCAxLCAwLCBob3N0LmdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3MoKSk7XG5cdFx0XHRcdFx0XHRcdFx0Ly8gQ2FwIHBpbm5lZCBjb250ZW50IHRvIH40MCUgb2YgdGVybWluYWwgaGVpZ2h0IHNvIHRhbGwgb3V0cHV0XG5cdFx0XHRcdFx0XHRcdFx0Ly8gZG9lc24ndCBleGNlZWQgdGhlIHZpZXdwb3J0IGFuZCBjYXVzZSByZW5kZXIgZmxhc2hpbmcuXG5cdFx0XHRcdFx0XHRcdFx0cGlubmVkVGV4dENvbXBvbmVudC5tYXhMaW5lcyA9IHBpbm5lZE1heDtcblx0XHRcdFx0XHRcdFx0XHRob3N0LnBpbm5lZE1lc3NhZ2VDb250YWluZXIuYWRkQ2hpbGQocGlubmVkVGV4dENvbXBvbmVudCk7XG5cdFx0XHRcdFx0XHRcdFx0Ly8gSGlkZSB0aGUgc2VwYXJhdGUgc3RhdHVzIGxvYWRlciBcdTIwMTQgdGhlIHBpbm5lZCB6b25lIHJlcGxhY2VzIGl0XG5cdFx0XHRcdFx0XHRcdFx0aWYgKGhvc3QubG9hZGluZ0FuaW1hdGlvbikge1xuXHRcdFx0XHRcdFx0XHRcdFx0aG9zdC5sb2FkaW5nQW5pbWF0aW9uLnN0b3AoKTtcblx0XHRcdFx0XHRcdFx0XHRcdGhvc3QubG9hZGluZ0FuaW1hdGlvbiA9IHVuZGVmaW5lZDtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0aG9zdC5zdGF0dXNDb250YWluZXIuY2xlYXIoKTtcblx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0XHQvLyBVcGRhdGUgZXhpc3RpbmcgbWFya2Rvd24gY29tcG9uZW50IGluLXBsYWNlXG5cdFx0XHRcdFx0XHRcdFx0cGlubmVkVGV4dENvbXBvbmVudD8uc2V0VGV4dChwaWNrZWQudGV4dCk7XG5cdFx0XHRcdFx0XHRcdFx0Ly8gUmVmcmVzaCBtYXhMaW5lcyBpbiBjYXNlIHRlcm1pbmFsIHdhcyByZXNpemVkXG5cdFx0XHRcdFx0XHRcdFx0aWYgKHBpbm5lZFRleHRDb21wb25lbnQpIHtcblx0XHRcdFx0XHRcdFx0XHRcdHBpbm5lZFRleHRDb21wb25lbnQubWF4TGluZXMgPSBwaW5uZWRNYXg7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fSBlbHNlIGlmIChwaW5uZWRCb3JkZXIpIHtcblx0XHRcdFx0XHRcdC8vIEV2ZXJ5IGNhbmRpZGF0ZSBpcyBzdGlsbCB2aXNpYmxlIGluIHRoZSBjaGF0IHNjcm9sbGJhY2sgXHUyMDE0XG5cdFx0XHRcdFx0XHQvLyB0ZWFyIGRvd24gdGhlIHBpbm5lZCB6b25lIHNvIHdlIGRvbid0IGR1cGxpY2F0ZSBvbi1zY3JlZW4gdGV4dC5cblx0XHRcdFx0XHRcdHBpbm5lZEJvcmRlci5zdG9wU3Bpbm5lcigpO1xuXHRcdFx0XHRcdFx0cGlubmVkQm9yZGVyID0gdW5kZWZpbmVkO1xuXHRcdFx0XHRcdFx0cGlubmVkVGV4dENvbXBvbmVudCA9IHVuZGVmaW5lZDtcblx0XHRcdFx0XHRcdGhvc3QucGlubmVkTWVzc2FnZUNvbnRhaW5lci5jbGVhcigpO1xuXHRcdFx0XHRcdFx0bGFzdFBpbm5lZFRleHQgPSBcIlwiO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGhvc3QudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0fVxuXHRcdFx0YnJlYWs7XG5cblx0XHRcdGNhc2UgXCJtZXNzYWdlX2VuZFwiOlxuXHRcdFx0XHRpZiAoZXZlbnQubWVzc2FnZS5yb2xlID09PSBcInVzZXJcIikgYnJlYWs7XG5cdFx0XHRcdGlmIChldmVudC5tZXNzYWdlLnJvbGUgPT09IFwiYXNzaXN0YW50XCIpIHtcblx0XHRcdFx0XHRob3N0LnN0cmVhbWluZ01lc3NhZ2UgPSBldmVudC5tZXNzYWdlO1xuXHRcdFx0XHRcdGxldCBlcnJvck1lc3NhZ2U6IHN0cmluZyB8IHVuZGVmaW5lZDtcblx0XHRcdFx0aWYgKGhvc3Quc3RyZWFtaW5nTWVzc2FnZS5zdG9wUmVhc29uID09PSBcImFib3J0ZWRcIikge1xuXHRcdFx0XHRcdGNvbnN0IHJldHJ5QXR0ZW1wdCA9IGhvc3Quc2Vzc2lvbi5yZXRyeUF0dGVtcHQ7XG5cdFx0XHRcdFx0ZXJyb3JNZXNzYWdlID0gcmV0cnlBdHRlbXB0ID4gMFxuXHRcdFx0XHRcdFx0PyBgQWJvcnRlZCBhZnRlciAke3JldHJ5QXR0ZW1wdH0gcmV0cnkgYXR0ZW1wdCR7cmV0cnlBdHRlbXB0ID4gMSA/IFwic1wiIDogXCJcIn1gXG5cdFx0XHRcdFx0XHQ6IFwiT3BlcmF0aW9uIGFib3J0ZWRcIjtcblx0XHRcdFx0XHRob3N0LnN0cmVhbWluZ01lc3NhZ2UuZXJyb3JNZXNzYWdlID0gZXJyb3JNZXNzYWdlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjb25zdCBzaG91bGRSZW5kZXJBc3Npc3RhbnQgPSBoYXNWaXNpYmxlQXNzaXN0YW50Q29udGVudChob3N0LnN0cmVhbWluZ01lc3NhZ2UpXG5cdFx0XHRcdFx0XHR8fCAoXG5cdFx0XHRcdFx0XHRcdChob3N0LnN0cmVhbWluZ01lc3NhZ2Uuc3RvcFJlYXNvbiA9PT0gXCJhYm9ydGVkXCIgfHwgaG9zdC5zdHJlYW1pbmdNZXNzYWdlLnN0b3BSZWFzb24gPT09IFwiZXJyb3JcIilcblx0XHRcdFx0XHRcdFx0JiYgIWhhc0Fzc2lzdGFudFRvb2xCbG9ja3MoaG9zdC5zdHJlYW1pbmdNZXNzYWdlKVxuXHRcdFx0XHRcdFx0KTtcblxuXHRcdFx0XHRcdC8vIFRoZSBmaW5hbCBtZXNzYWdlX2VuZCBwYXlsb2FkIGNhbiBjb250YWluIGFkZGl0aW9uYWwgdGV4dC90aGlua2luZ1xuXHRcdFx0XHRcdC8vIGJsb2NrcyB0aGF0IG5ldmVyIGFycml2ZWQgdmlhIG1lc3NhZ2VfdXBkYXRlIChlLmcuIFNESyByZXN1bHRcblx0XHRcdFx0XHQvLyBhZ2dyZWdhdGlvbikuIFJlYnVpbGQgdGhpcyBpbi1mbGlnaHQgdHVybiBmcm9tIGZpbmFsIGNvbnRlbnQgc29cblx0XHRcdFx0XHQvLyByYW5nZXMvY29tcG9uZW50cyBkb24ndCBrZWVwIHN0YWxlIHBhcnRpYWwgaW5kaWNlcy5cblx0XHRcdFx0XHRpZiAocmVuZGVyZWRTZWdtZW50cy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBmaW5hbEJsb2NrcyA9IGhvc3Quc3RyZWFtaW5nTWVzc2FnZS5jb250ZW50O1xuXHRcdFx0XHRcdFx0dHlwZSBEZXNpcmVkU2VnbWVudCA9XG5cdFx0XHRcdFx0XHRcdHwgeyBraW5kOiBcInRleHQtcnVuXCI7IHN0YXJ0SW5kZXg6IG51bWJlcjsgZW5kSW5kZXg6IG51bWJlcjsgY29udGVudFR5cGU6IFwidGV4dFwiIHwgXCJ0aGlua2luZ1wiIH1cblx0XHRcdFx0XHRcdFx0fCB7IGtpbmQ6IFwidG9vbFwiOyBjb250ZW50SW5kZXg6IG51bWJlcjsgdG9vbElkOiBzdHJpbmcgfTtcblx0XHRcdFx0XHRcdGNvbnN0IGRlc2lyZWQ6IERlc2lyZWRTZWdtZW50W10gPSBbXTtcblx0XHRcdFx0XHRcdGxldCBydW5TdGFydCA9IC0xO1xuXHRcdFx0XHRcdFx0bGV0IHJ1bkVuZCA9IC0xO1xuXHRcdFx0XHRcdFx0bGV0IHJ1blR5cGU6IFwidGV4dFwiIHwgXCJ0aGlua2luZ1wiIHwgdW5kZWZpbmVkO1xuXHRcdFx0XHRcdFx0Y29uc3QgY2xvc2VSdW4gPSAoKSA9PiB7XG5cdFx0XHRcdFx0XHRcdGlmIChydW5TdGFydCAhPT0gLTEgJiYgcnVuVHlwZSkge1xuXHRcdFx0XHRcdFx0XHRcdGRlc2lyZWQucHVzaCh7IGtpbmQ6IFwidGV4dC1ydW5cIiwgc3RhcnRJbmRleDogcnVuU3RhcnQsIGVuZEluZGV4OiBydW5FbmQsIGNvbnRlbnRUeXBlOiBydW5UeXBlIH0pO1xuXHRcdFx0XHRcdFx0XHRcdHJ1blN0YXJ0ID0gLTE7XG5cdFx0XHRcdFx0XHRcdFx0cnVuRW5kID0gLTE7XG5cdFx0XHRcdFx0XHRcdFx0cnVuVHlwZSA9IHVuZGVmaW5lZDtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fTtcblxuXHRcdFx0XHRcdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBmaW5hbEJsb2Nrcy5sZW5ndGg7IGkrKykge1xuXHRcdFx0XHRcdFx0XHRjb25zdCBibG9jayA9IGZpbmFsQmxvY2tzW2ldIGFzIGFueTtcblx0XHRcdFx0XHRcdFx0Y29uc3QgYmxvY2tUeXBlID0gYmxvY2s/LnR5cGUgPT09IFwidGV4dFwiIHx8IGJsb2NrPy50eXBlID09PSBcInRoaW5raW5nXCIgPyBibG9jay50eXBlIDogdW5kZWZpbmVkO1xuXHRcdFx0XHRcdFx0XHRjb25zdCBpc1RleHRMaWtlID0gYmxvY2tUeXBlID09PSBcInRleHRcIiB8fCBibG9ja1R5cGUgPT09IFwidGhpbmtpbmdcIjtcblx0XHRcdFx0XHRcdFx0Y29uc3QgaXNUb29sID0gYmxvY2s/LnR5cGUgPT09IFwidG9vbENhbGxcIiB8fCBibG9jaz8udHlwZSA9PT0gXCJzZXJ2ZXJUb29sVXNlXCI7XG5cblx0XHRcdFx0XHRcdFx0aWYgKGlzVGV4dExpa2UpIHtcblx0XHRcdFx0XHRcdFx0XHRpZiAocnVuU3RhcnQgPT09IC0xKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRydW5TdGFydCA9IGk7XG5cdFx0XHRcdFx0XHRcdFx0XHRydW5FbmQgPSBpO1xuXHRcdFx0XHRcdFx0XHRcdFx0cnVuVHlwZSA9IGJsb2NrVHlwZTtcblx0XHRcdFx0XHRcdFx0XHR9IGVsc2UgaWYgKHJ1blR5cGUgIT09IGJsb2NrVHlwZSkge1xuXHRcdFx0XHRcdFx0XHRcdFx0Y2xvc2VSdW4oKTtcblx0XHRcdFx0XHRcdFx0XHRcdHJ1blN0YXJ0ID0gaTtcblx0XHRcdFx0XHRcdFx0XHRcdHJ1bkVuZCA9IGk7XG5cdFx0XHRcdFx0XHRcdFx0XHRydW5UeXBlID0gYmxvY2tUeXBlO1xuXHRcdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRydW5FbmQgPSBpO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0XHRjbG9zZVJ1bigpO1xuXHRcdFx0XHRcdFx0XHRcdGlmIChpc1Rvb2wpIHtcblx0XHRcdFx0XHRcdFx0XHRcdGRlc2lyZWQucHVzaCh7IGtpbmQ6IFwidG9vbFwiLCBjb250ZW50SW5kZXg6IGksIHRvb2xJZDogYmxvY2suaWQgfSk7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRjbG9zZVJ1bigpO1xuXG5cdFx0XHRcdFx0XHRjb25zdCB0b29sQ29tcG9uZW50c0J5SWQgPSBuZXcgTWFwPHN0cmluZywgVG9vbEV4ZWN1dGlvbkNvbXBvbmVudD4oKTtcblx0XHRcdFx0XHRcdGZvciAoY29uc3QgW3Rvb2xJZCwgY29tcG9uZW50XSBvZiBob3N0LnBlbmRpbmdUb29scy5lbnRyaWVzKCkpIHtcblx0XHRcdFx0XHRcdFx0dG9vbENvbXBvbmVudHNCeUlkLnNldCh0b29sSWQsIGNvbXBvbmVudCk7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGZvciAoY29uc3Qgc2VnIG9mIHJlbmRlcmVkU2VnbWVudHMpIHtcblx0XHRcdFx0XHRcdFx0aG9zdC5jaGF0Q29udGFpbmVyLnJlbW92ZUNoaWxkKHNlZy5jb21wb25lbnQpO1xuXHRcdFx0XHRcdFx0XHRpZiAoc2VnLmtpbmQgPT09IFwidG9vbFwiKSB7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgcHJpb3JCbG9ja3MgPSBob3N0LnN0cmVhbWluZ01lc3NhZ2UuY29udGVudDtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBwcmlvckJsb2NrID0gcHJpb3JCbG9ja3Nbc2VnLmNvbnRlbnRJbmRleF0gYXMgYW55O1xuXHRcdFx0XHRcdFx0XHRcdGlmIChwcmlvckJsb2NrPy5pZCAmJiAhdG9vbENvbXBvbmVudHNCeUlkLmhhcyhwcmlvckJsb2NrLmlkKSkge1xuXHRcdFx0XHRcdFx0XHRcdFx0dG9vbENvbXBvbmVudHNCeUlkLnNldChwcmlvckJsb2NrLmlkLCBzZWcuY29tcG9uZW50KTtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdHJlbmRlcmVkU2VnbWVudHMgPSBbXTtcblx0XHRcdFx0XHRcdGhvc3Quc3RyZWFtaW5nQ29tcG9uZW50ID0gdW5kZWZpbmVkO1xuXG5cdFx0XHRcdFx0XHRmb3IgKGNvbnN0IHNlZyBvZiBkZXNpcmVkKSB7XG5cdFx0XHRcdFx0XHRcdGlmIChzZWcua2luZCA9PT0gXCJ0b29sXCIpIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBmaW5hbEJsb2NrID0gZmluYWxCbG9ja3Nbc2VnLmNvbnRlbnRJbmRleF0gYXMgYW55O1xuXHRcdFx0XHRcdFx0XHRcdGxldCBjb21wb25lbnQgPSB0b29sQ29tcG9uZW50c0J5SWQuZ2V0KHNlZy50b29sSWQpO1xuXHRcdFx0XHRcdFx0XHRcdGlmICghY29tcG9uZW50ICYmIGZpbmFsQmxvY2s/LmlkKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb21wb25lbnQgPSBob3N0LnBlbmRpbmdUb29scy5nZXQoZmluYWxCbG9jay5pZCk7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRcdGlmICghY29tcG9uZW50ICYmIGZpbmFsQmxvY2s/LnR5cGUgPT09IFwidG9vbENhbGxcIikge1xuXHRcdFx0XHRcdFx0XHRcdFx0Y29tcG9uZW50ID0gbmV3IFRvb2xFeGVjdXRpb25Db21wb25lbnQoXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGZpbmFsQmxvY2submFtZSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0ZmluYWxCbG9jay5hcmd1bWVudHMsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdHsgc2hvd0ltYWdlczogaG9zdC5zZXR0aW5nc01hbmFnZXIuZ2V0U2hvd0ltYWdlcygpIH0sXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGhvc3QuZ2V0UmVnaXN0ZXJlZFRvb2xEZWZpbml0aW9uKGZpbmFsQmxvY2submFtZSksXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGhvc3QudWksXG5cdFx0XHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0XHRcdFx0Y29tcG9uZW50LnNldEV4cGFuZGVkKGhvc3QudG9vbE91dHB1dEV4cGFuZGVkKTtcblx0XHRcdFx0XHRcdFx0XHRcdGhvc3QucGVuZGluZ1Rvb2xzLnNldChmaW5hbEJsb2NrLmlkLCBjb21wb25lbnQpO1xuXHRcdFx0XHRcdFx0XHRcdFx0dG9vbENvbXBvbmVudHNCeUlkLnNldChmaW5hbEJsb2NrLmlkLCBjb21wb25lbnQpO1xuXHRcdFx0XHRcdFx0XHRcdH0gZWxzZSBpZiAoIWNvbXBvbmVudCAmJiBmaW5hbEJsb2NrPy50eXBlID09PSBcInNlcnZlclRvb2xVc2VcIikge1xuXHRcdFx0XHRcdFx0XHRcdFx0Y29tcG9uZW50ID0gbmV3IFRvb2xFeGVjdXRpb25Db21wb25lbnQoXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGZpbmFsQmxvY2submFtZSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0ZmluYWxCbG9jay5pbnB1dCA/PyB7fSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0eyBzaG93SW1hZ2VzOiBob3N0LnNldHRpbmdzTWFuYWdlci5nZXRTaG93SW1hZ2VzKCkgfSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0dW5kZWZpbmVkLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRob3N0LnVpLFxuXHRcdFx0XHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdFx0XHRcdGNvbXBvbmVudC5zZXRFeHBhbmRlZChob3N0LnRvb2xPdXRwdXRFeHBhbmRlZCk7XG5cdFx0XHRcdFx0XHRcdFx0XHRob3N0LnBlbmRpbmdUb29scy5zZXQoZmluYWxCbG9jay5pZCwgY29tcG9uZW50KTtcblx0XHRcdFx0XHRcdFx0XHRcdHRvb2xDb21wb25lbnRzQnlJZC5zZXQoZmluYWxCbG9jay5pZCwgY29tcG9uZW50KTtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0aWYgKGNvbXBvbmVudCkge1xuXHRcdFx0XHRcdFx0XHRcdFx0aG9zdC5jaGF0Q29udGFpbmVyLmFkZENoaWxkKGNvbXBvbmVudCk7XG5cdFx0XHRcdFx0XHRcdFx0XHRyZW5kZXJlZFNlZ21lbnRzLnB1c2goeyBraW5kOiBcInRvb2xcIiwgY29udGVudEluZGV4OiBzZWcuY29udGVudEluZGV4LCBjb21wb25lbnQgfSk7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0Y29uc3QgY29tcCA9IG5ldyBBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50KFxuXHRcdFx0XHRcdFx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdFx0XHRcdFx0XHRob3N0LmhpZGVUaGlua2luZ0Jsb2NrLFxuXHRcdFx0XHRcdFx0XHRcdGhvc3QuZ2V0TWFya2Rvd25UaGVtZVdpdGhTZXR0aW5ncygpLFxuXHRcdFx0XHRcdFx0XHRcdHRpbWVzdGFtcEZvcm1hdCxcblx0XHRcdFx0XHRcdFx0XHR7IHN0YXJ0SW5kZXg6IHNlZy5zdGFydEluZGV4LCBlbmRJbmRleDogc2VnLmVuZEluZGV4IH0sXG5cdFx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRcdGNvbXAudXBkYXRlQ29udGVudChob3N0LnN0cmVhbWluZ01lc3NhZ2UpO1xuXHRcdFx0XHRcdFx0XHRob3N0LmNoYXRDb250YWluZXIuYWRkQ2hpbGQoY29tcCk7XG5cdFx0XHRcdFx0XHRcdHJlbmRlcmVkU2VnbWVudHMucHVzaCh7XG5cdFx0XHRcdFx0XHRcdFx0a2luZDogXCJ0ZXh0LXJ1blwiLFxuXHRcdFx0XHRcdFx0XHRcdHN0YXJ0SW5kZXg6IHNlZy5zdGFydEluZGV4LFxuXHRcdFx0XHRcdFx0XHRcdGVuZEluZGV4OiBzZWcuZW5kSW5kZXgsXG5cdFx0XHRcdFx0XHRcdFx0Y29udGVudFR5cGU6IHNlZy5jb250ZW50VHlwZSxcblx0XHRcdFx0XHRcdFx0XHRjb21wb25lbnQ6IGNvbXAsXG5cdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHRob3N0LnN0cmVhbWluZ0NvbXBvbmVudCA9IGNvbXA7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0aWYgKCFob3N0LnN0cmVhbWluZ0NvbXBvbmVudCAmJiBzaG91bGRSZW5kZXJBc3Npc3RhbnQpIHtcblx0XHRcdFx0XHRcdGhvc3Quc3RyZWFtaW5nQ29tcG9uZW50ID0gbmV3IEFzc2lzdGFudE1lc3NhZ2VDb21wb25lbnQoXG5cdFx0XHRcdFx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdFx0XHRcdFx0aG9zdC5oaWRlVGhpbmtpbmdCbG9jayxcblx0XHRcdFx0XHRcdFx0aG9zdC5nZXRNYXJrZG93blRoZW1lV2l0aFNldHRpbmdzKCksXG5cdFx0XHRcdFx0XHRcdHRpbWVzdGFtcEZvcm1hdCxcblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0aG9zdC5jaGF0Q29udGFpbmVyLmFkZENoaWxkKGhvc3Quc3RyZWFtaW5nQ29tcG9uZW50KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoaG9zdC5zdHJlYW1pbmdDb21wb25lbnQpIHtcblx0XHRcdFx0XHRob3N0LnN0cmVhbWluZ0NvbXBvbmVudC5zZXRTaG93TWV0YWRhdGEodHJ1ZSk7XG5cdFx0XHRcdFx0aG9zdC5zdHJlYW1pbmdDb21wb25lbnQudXBkYXRlQ29udGVudChob3N0LnN0cmVhbWluZ01lc3NhZ2UpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKGhvc3Quc3RyZWFtaW5nTWVzc2FnZS5zdG9wUmVhc29uID09PSBcImFib3J0ZWRcIiB8fCBob3N0LnN0cmVhbWluZ01lc3NhZ2Uuc3RvcFJlYXNvbiA9PT0gXCJlcnJvclwiKSB7XG5cdFx0XHRcdFx0aWYgKCFlcnJvck1lc3NhZ2UpIHtcblx0XHRcdFx0XHRcdGVycm9yTWVzc2FnZSA9IGhvc3Quc3RyZWFtaW5nTWVzc2FnZS5lcnJvck1lc3NhZ2UgfHwgXCJFcnJvclwiO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRjb25zdCBwZW5kaW5nQ29tcG9uZW50cyA9IEFycmF5LmZyb20oaG9zdC5wZW5kaW5nVG9vbHMudmFsdWVzKCkpO1xuXHRcdFx0XHRcdGlmIChwZW5kaW5nQ29tcG9uZW50cy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBbZmlyc3QsIC4uLnJlc3RdID0gcGVuZGluZ0NvbXBvbmVudHM7XG5cdFx0XHRcdFx0XHRmaXJzdC5jb21wbGV0ZVdpdGhFcnJvcihlcnJvck1lc3NhZ2UpO1xuXHRcdFx0XHRcdFx0Zm9yIChjb25zdCBjb21wb25lbnQgb2YgcmVzdCkge1xuXHRcdFx0XHRcdFx0XHRjb21wb25lbnQuY29tcGxldGVXaXRoRXJyb3IoKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0aG9zdC5wZW5kaW5nVG9vbHMuY2xlYXIoKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRmb3IgKGNvbnN0IFssIGNvbXBvbmVudF0gb2YgaG9zdC5wZW5kaW5nVG9vbHMuZW50cmllcygpKSB7XG5cdFx0XHRcdFx0XHRjb21wb25lbnQuc2V0QXJnc0NvbXBsZXRlKCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdHJlcGxhY2VDb21wYWN0VG9vbFJvd3NXaXRoUGhhc2VTdW1tYXJ5KGhvc3QpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGhvc3Quc3RyZWFtaW5nQ29tcG9uZW50ID0gdW5kZWZpbmVkO1xuXHRcdFx0XHRob3N0LnN0cmVhbWluZ01lc3NhZ2UgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdHJlbmRlcmVkU2VnbWVudHMgPSBbXTtcblx0XHRcdFx0b3JwaGFuZWRTZWdtZW50cyA9IFtdO1xuXHRcdFx0XHRsYXN0Q29udGVudExlbmd0aCA9IDA7XG5cdFx0XHRcdC8vIENsZWFyIHBpbm5lZCBvdXRwdXQgb25jZSB0aGUgbWVzc2FnZSBpcyBmaW5hbGl6ZWQgaW4gdGhlIGNoYXRcblx0XHRcdFx0Ly8gY29udGFpbmVyIFx1MjAxNCBwcmV2ZW50cyBkdXBsaWNhdGUgZGlzcGxheSB3aGVuIHRoZSBhZ2VudCBjb250aW51ZXNcblx0XHRcdFx0Ly8gKGUuZy4gZm9ybSBlbGljaXRhdGlvbikgYWZ0ZXIgdGhlIGFzc2lzdGFudCBtZXNzYWdlIGVuZHMuXG5cdFx0XHRcdGlmIChwaW5uZWRCb3JkZXIpIHBpbm5lZEJvcmRlci5zdG9wU3Bpbm5lcigpO1xuXHRcdFx0XHRob3N0LnBpbm5lZE1lc3NhZ2VDb250YWluZXIuY2xlYXIoKTtcblx0XHRcdFx0bGFzdFBpbm5lZFRleHQgPSBcIlwiO1xuXHRcdFx0XHRoYXNUb29sc0luVHVybiA9IGZhbHNlO1xuXHRcdFx0XHRwaW5uZWRCb3JkZXIgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdHBpbm5lZFRleHRDb21wb25lbnQgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdGhvc3QuZm9vdGVyLmludmFsaWRhdGUoKTtcblx0XHRcdH1cblx0XHRcdGhvc3QudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0YnJlYWs7XG5cblx0XHRjYXNlIFwidG9vbF9leGVjdXRpb25fc3RhcnRcIjpcblx0XHRcdGlmICghaG9zdC5wZW5kaW5nVG9vbHMuaGFzKGV2ZW50LnRvb2xDYWxsSWQpKSB7XG5cdFx0XHRcdGNvbnN0IGNvbXBvbmVudCA9IG5ldyBUb29sRXhlY3V0aW9uQ29tcG9uZW50KFxuXHRcdFx0XHRcdGV2ZW50LnRvb2xOYW1lLFxuXHRcdFx0XHRcdGV2ZW50LmFyZ3MsXG5cdFx0XHRcdFx0eyBzaG93SW1hZ2VzOiBob3N0LnNldHRpbmdzTWFuYWdlci5nZXRTaG93SW1hZ2VzKCkgfSxcblx0XHRcdFx0XHRob3N0LmdldFJlZ2lzdGVyZWRUb29sRGVmaW5pdGlvbihldmVudC50b29sTmFtZSksXG5cdFx0XHRcdFx0aG9zdC51aSxcblx0XHRcdFx0KTtcblx0XHRcdFx0Y29tcG9uZW50LnNldEV4cGFuZGVkKGhvc3QudG9vbE91dHB1dEV4cGFuZGVkKTtcblx0XHRcdFx0aG9zdC5jaGF0Q29udGFpbmVyLmFkZENoaWxkKGNvbXBvbmVudCk7XG5cdFx0XHRcdGhvc3QucGVuZGluZ1Rvb2xzLnNldChldmVudC50b29sQ2FsbElkLCBjb21wb25lbnQpO1xuXHRcdFx0XHRyZW5kZXJlZFNlZ21lbnRzLnB1c2goeyBraW5kOiBcInRvb2xcIiwgY29udGVudEluZGV4OiBOdW1iZXIuTUFYX1NBRkVfSU5URUdFUiwgY29tcG9uZW50IH0pO1xuXHRcdFx0XHRob3N0LnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdH1cblx0XHRcdGJyZWFrO1xuXG5cdFx0Y2FzZSBcInRvb2xfZXhlY3V0aW9uX3VwZGF0ZVwiOiB7XG5cdFx0XHRjb25zdCBjb21wb25lbnQgPSBob3N0LnBlbmRpbmdUb29scy5nZXQoZXZlbnQudG9vbENhbGxJZCk7XG5cdFx0XHRpZiAoY29tcG9uZW50KSB7XG5cdFx0XHRcdGNvbXBvbmVudC51cGRhdGVSZXN1bHQoeyAuLi5ldmVudC5wYXJ0aWFsUmVzdWx0LCBpc0Vycm9yOiBmYWxzZSB9LCB0cnVlKTtcblx0XHRcdFx0aG9zdC51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHR9XG5cdFx0XHRicmVhaztcblx0XHR9XG5cblx0XHRjYXNlIFwidG9vbF9leGVjdXRpb25fZW5kXCI6IHtcblx0XHRcdGNvbnN0IGNvbXBvbmVudCA9IGhvc3QucGVuZGluZ1Rvb2xzLmdldChldmVudC50b29sQ2FsbElkKTtcblx0XHRcdGlmIChjb21wb25lbnQpIHtcblx0XHRcdFx0Y29tcG9uZW50LnVwZGF0ZVJlc3VsdCh7IC4uLmV2ZW50LnJlc3VsdCwgaXNFcnJvcjogZXZlbnQuaXNFcnJvciB9KTtcblx0XHRcdFx0cmVwbGFjZUNvbXBhY3RUb29sUm93c1dpdGhQaGFzZVN1bW1hcnkoaG9zdCk7XG5cdFx0XHRcdGhvc3QudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0fVxuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXG5cdFx0Y2FzZSBcImFnZW50X2VuZFwiOlxuXHRcdFx0aWYgKGhvc3QubG9hZGluZ0FuaW1hdGlvbikge1xuXHRcdFx0XHRob3N0LmxvYWRpbmdBbmltYXRpb24uc3RvcCgpO1xuXHRcdFx0XHRob3N0LmxvYWRpbmdBbmltYXRpb24gPSB1bmRlZmluZWQ7XG5cdFx0XHRcdGhvc3Quc3RhdHVzQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0XHR9XG5cdFx0XHRpZiAoaG9zdC5zdHJlYW1pbmdDb21wb25lbnQgJiYgaG9zdC5zdHJlYW1pbmdNZXNzYWdlKSB7XG5cdFx0XHRcdGhvc3Quc3RyZWFtaW5nQ29tcG9uZW50LnNldFNob3dNZXRhZGF0YSh0cnVlKTtcblx0XHRcdFx0aG9zdC5zdHJlYW1pbmdDb21wb25lbnQudXBkYXRlQ29udGVudChob3N0LnN0cmVhbWluZ01lc3NhZ2UpO1xuXHRcdFx0fVxuXHRcdFx0cmVwbGFjZUNvbXBhY3RUb29sUm93c1dpdGhQaGFzZVN1bW1hcnkoaG9zdCk7XG5cdFx0XHRob3N0LnN0cmVhbWluZ0NvbXBvbmVudCA9IHVuZGVmaW5lZDtcblx0XHRcdGhvc3Quc3RyZWFtaW5nTWVzc2FnZSA9IHVuZGVmaW5lZDtcblx0XHRcdHJlbmRlcmVkU2VnbWVudHMgPSBbXTtcblx0XHRcdG9ycGhhbmVkU2VnbWVudHMgPSBbXTtcblx0XHRcdGxhc3RDb250ZW50TGVuZ3RoID0gMDtcblx0XHRcdGhvc3QucGVuZGluZ1Rvb2xzLmNsZWFyKCk7XG5cdFx0XHQvLyBQaW5uZWQgb3V0cHV0IGlzIG9ubHkgdXNlZnVsIHdoaWxlIHdvcmsgaXMgYWN0aXZlbHkgc3RyZWFtaW5nLlxuXHRcdFx0Ly8gS2VlcCBjaGF0IGhpc3RvcnkgYXMgdGhlIHNpbmdsZSBzb3VyY2UgYWZ0ZXIgY29tcGxldGlvbi5cblx0XHRcdGlmIChwaW5uZWRCb3JkZXIpIHtcblx0XHRcdFx0cGlubmVkQm9yZGVyLnN0b3BTcGlubmVyKCk7XG5cdFx0XHR9XG5cdFx0XHRob3N0LnBpbm5lZE1lc3NhZ2VDb250YWluZXIuY2xlYXIoKTtcblx0XHRcdGxhc3RQaW5uZWRUZXh0ID0gXCJcIjtcblx0XHRcdGhhc1Rvb2xzSW5UdXJuID0gZmFsc2U7XG5cdFx0XHRwaW5uZWRCb3JkZXIgPSB1bmRlZmluZWQ7XG5cdFx0XHRwaW5uZWRUZXh0Q29tcG9uZW50ID0gdW5kZWZpbmVkO1xuXHRcdFx0YXdhaXQgaG9zdC5jaGVja1NodXRkb3duUmVxdWVzdGVkKCk7XG5cdFx0XHRob3N0LnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdGJyZWFrO1xuXG5cdFx0Y2FzZSBcImF1dG9fY29tcGFjdGlvbl9zdGFydFwiOlxuXHRcdFx0aG9zdC5hdXRvQ29tcGFjdGlvbkVzY2FwZUhhbmRsZXIgPSBob3N0LmRlZmF1bHRFZGl0b3Iub25Fc2NhcGU7XG5cdFx0XHRob3N0LmRlZmF1bHRFZGl0b3Iub25Fc2NhcGUgPSAoKSA9PiBob3N0LnNlc3Npb24uYWJvcnRDb21wYWN0aW9uKCk7XG5cdFx0XHRob3N0LnN0YXR1c0NvbnRhaW5lci5jbGVhcigpO1xuXHRcdFx0aG9zdC5hdXRvQ29tcGFjdGlvbkxvYWRlciA9IG5ldyBMb2FkZXIoXG5cdFx0XHRcdGhvc3QudWksXG5cdFx0XHRcdChzcGlubmVyKSA9PiB0aGVtZS5mZyhcImFjY2VudFwiLCBzcGlubmVyKSxcblx0XHRcdFx0KHRleHQpID0+IHRoZW1lLmZnKFwibXV0ZWRcIiwgdGV4dCksXG5cdFx0XHRcdGAke2V2ZW50LnJlYXNvbiA9PT0gXCJvdmVyZmxvd1wiID8gXCJDb250ZXh0IG92ZXJmbG93IGRldGVjdGVkLCBcIiA6IFwiXCJ9QXV0by1jb21wYWN0aW5nLi4uICgke2FwcEtleShob3N0LmtleWJpbmRpbmdzLCBcImludGVycnVwdFwiKX0gdG8gY2FuY2VsKWAsXG5cdFx0XHQpO1xuXHRcdFx0aG9zdC5zdGF0dXNDb250YWluZXIuYWRkQ2hpbGQoaG9zdC5hdXRvQ29tcGFjdGlvbkxvYWRlcik7XG5cdFx0XHRob3N0LnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdGJyZWFrO1xuXG5cdFx0Y2FzZSBcImF1dG9fY29tcGFjdGlvbl9lbmRcIjpcblx0XHRcdGlmIChob3N0LmF1dG9Db21wYWN0aW9uRXNjYXBlSGFuZGxlcikge1xuXHRcdFx0XHRob3N0LmRlZmF1bHRFZGl0b3Iub25Fc2NhcGUgPSBob3N0LmF1dG9Db21wYWN0aW9uRXNjYXBlSGFuZGxlcjtcblx0XHRcdFx0aG9zdC5hdXRvQ29tcGFjdGlvbkVzY2FwZUhhbmRsZXIgPSB1bmRlZmluZWQ7XG5cdFx0XHR9XG5cdFx0XHRpZiAoaG9zdC5hdXRvQ29tcGFjdGlvbkxvYWRlcikge1xuXHRcdFx0XHRob3N0LmF1dG9Db21wYWN0aW9uTG9hZGVyLnN0b3AoKTtcblx0XHRcdFx0aG9zdC5hdXRvQ29tcGFjdGlvbkxvYWRlciA9IHVuZGVmaW5lZDtcblx0XHRcdFx0aG9zdC5zdGF0dXNDb250YWluZXIuY2xlYXIoKTtcblx0XHRcdH1cblx0XHRcdGlmIChldmVudC5hYm9ydGVkKSB7XG5cdFx0XHRcdGhvc3Quc2hvd1N0YXR1cyhcIkF1dG8tY29tcGFjdGlvbiBjYW5jZWxsZWRcIik7XG5cdFx0XHR9IGVsc2UgaWYgKGV2ZW50LnJlc3VsdCkge1xuXHRcdFx0XHRob3N0LmNoYXRDb250YWluZXIuY2xlYXIoKTtcblx0XHRcdFx0aG9zdC5yZWJ1aWxkQ2hhdEZyb21NZXNzYWdlcygpO1xuXHRcdFx0XHRob3N0LmFkZE1lc3NhZ2VUb0NoYXQoe1xuXHRcdFx0XHRcdHJvbGU6IFwiY29tcGFjdGlvblN1bW1hcnlcIixcblx0XHRcdFx0XHR0b2tlbnNCZWZvcmU6IGV2ZW50LnJlc3VsdC50b2tlbnNCZWZvcmUsXG5cdFx0XHRcdFx0c3VtbWFyeTogZXZlbnQucmVzdWx0LnN1bW1hcnksXG5cdFx0XHRcdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0aG9zdC5mb290ZXIuaW52YWxpZGF0ZSgpO1xuXHRcdFx0fSBlbHNlIGlmIChldmVudC5lcnJvck1lc3NhZ2UpIHtcblx0XHRcdFx0aG9zdC5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdFx0XHRob3N0LmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQodGhlbWUuZmcoXCJlcnJvclwiLCBldmVudC5lcnJvck1lc3NhZ2UpLCAxLCAwKSk7XG5cdFx0XHR9XG5cdFx0XHR2b2lkIGhvc3QuZmx1c2hDb21wYWN0aW9uUXVldWUoeyB3aWxsUmV0cnk6IGV2ZW50LndpbGxSZXRyeSB9KTtcblx0XHRcdGhvc3QudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0YnJlYWs7XG5cblx0XHRjYXNlIFwiYXV0b19yZXRyeV9zdGFydFwiOlxuXHRcdFx0aG9zdC5yZXRyeUVzY2FwZUhhbmRsZXIgPSBob3N0LmRlZmF1bHRFZGl0b3Iub25Fc2NhcGU7XG5cdFx0XHRob3N0LmRlZmF1bHRFZGl0b3Iub25Fc2NhcGUgPSAoKSA9PiBob3N0LnNlc3Npb24uYWJvcnRSZXRyeSgpO1xuXHRcdFx0aG9zdC5zdGF0dXNDb250YWluZXIuY2xlYXIoKTtcblx0XHRcdGhvc3QucmV0cnlMb2FkZXIgPSBuZXcgTG9hZGVyKFxuXHRcdFx0XHRob3N0LnVpLFxuXHRcdFx0XHQoc3Bpbm5lcikgPT4gdGhlbWUuZmcoXCJ3YXJuaW5nXCIsIHNwaW5uZXIpLFxuXHRcdFx0XHQodGV4dCkgPT4gdGhlbWUuZmcoXCJtdXRlZFwiLCB0ZXh0KSxcblx0XHRcdFx0YFJldHJ5aW5nICgke2V2ZW50LmF0dGVtcHR9LyR7ZXZlbnQubWF4QXR0ZW1wdHN9KSBpbiAke01hdGgucm91bmQoZXZlbnQuZGVsYXlNcyAvIDEwMDApfXMuLi4gKCR7YXBwS2V5KGhvc3Qua2V5YmluZGluZ3MsIFwiaW50ZXJydXB0XCIpfSB0byBjYW5jZWwpYCxcblx0XHRcdCk7XG5cdFx0XHRob3N0LnN0YXR1c0NvbnRhaW5lci5hZGRDaGlsZChob3N0LnJldHJ5TG9hZGVyKTtcblx0XHRcdGhvc3QudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0YnJlYWs7XG5cblx0XHRjYXNlIFwiYXV0b19yZXRyeV9lbmRcIjpcblx0XHRcdGlmIChob3N0LnJldHJ5RXNjYXBlSGFuZGxlcikge1xuXHRcdFx0XHRob3N0LmRlZmF1bHRFZGl0b3Iub25Fc2NhcGUgPSBob3N0LnJldHJ5RXNjYXBlSGFuZGxlcjtcblx0XHRcdFx0aG9zdC5yZXRyeUVzY2FwZUhhbmRsZXIgPSB1bmRlZmluZWQ7XG5cdFx0XHR9XG5cdFx0XHRpZiAoaG9zdC5yZXRyeUxvYWRlcikge1xuXHRcdFx0XHRob3N0LnJldHJ5TG9hZGVyLnN0b3AoKTtcblx0XHRcdFx0aG9zdC5yZXRyeUxvYWRlciA9IHVuZGVmaW5lZDtcblx0XHRcdFx0aG9zdC5zdGF0dXNDb250YWluZXIuY2xlYXIoKTtcblx0XHRcdH1cblx0XHRcdGlmICghZXZlbnQuc3VjY2Vzcykge1xuXHRcdFx0XHRob3N0LnNob3dFcnJvcihgUmV0cnkgZmFpbGVkIGFmdGVyICR7ZXZlbnQuYXR0ZW1wdH0gYXR0ZW1wdHM6ICR7ZXZlbnQuZmluYWxFcnJvciB8fCBcIlVua25vd24gZXJyb3JcIn1gKTtcblx0XHRcdH1cblx0XHRcdGhvc3QudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0YnJlYWs7XG5cblx0XHRjYXNlIFwiZmFsbGJhY2tfcHJvdmlkZXJfc3dpdGNoXCI6XG5cdFx0XHRob3N0LnNob3dTdGF0dXMoYFN3aXRjaGVkIGZyb20gJHtldmVudC5mcm9tfSBcdTIxOTIgJHtldmVudC50b30gKCR7ZXZlbnQucmVhc29ufSlgKTtcblx0XHRcdGhvc3QudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0YnJlYWs7XG5cblx0XHRjYXNlIFwiZmFsbGJhY2tfcHJvdmlkZXJfcmVzdG9yZWRcIjpcblx0XHRcdGhvc3Quc2hvd1N0YXR1cyhgUmVzdG9yZWQgdG8gJHtldmVudC5wcm92aWRlcn1gKTtcblx0XHRcdGhvc3QudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0YnJlYWs7XG5cblx0XHRjYXNlIFwiZmFsbGJhY2tfY2hhaW5fZXhoYXVzdGVkXCI6XG5cdFx0XHRob3N0LnNob3dFcnJvcihldmVudC5yZWFzb24pO1xuXHRcdFx0aG9zdC51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHRicmVhaztcblxuXHRcdGNhc2UgXCJpbWFnZV9vdmVyZmxvd19yZWNvdmVyeVwiOlxuXHRcdFx0aG9zdC5zaG93U3RhdHVzKFxuXHRcdFx0XHRgUmVtb3ZlZCAke2V2ZW50LnN0cmlwcGVkQ291bnR9IG9sZGVyIGltYWdlKHMpIHRvIGNvbXBseSB3aXRoIEFQSSBsaW1pdHMuIFJldHJ5aW5nLi4uYCxcblx0XHRcdCk7XG5cdFx0XHRob3N0LnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdGJyZWFrO1xuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLFFBQVEsVUFBVSxRQUFRLFlBQVk7QUFHL0MsU0FBUyxhQUFhO0FBQ3RCLFNBQVMsaUNBQWlDO0FBQzFDO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxPQUVNO0FBQ1AsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxjQUFjO0FBR3ZCLElBQUksNEJBQTRCO0FBSWhDLElBQUksb0JBQW9CO0FBY3hCLElBQUksbUJBQXNDLENBQUM7QUFJM0MsSUFBSSxtQkFBc0MsQ0FBQztBQUUzQyxTQUFTLDJCQUEyQixTQUEyQztBQUM5RSxTQUFPLFFBQVEsUUFBUTtBQUFBLElBQ3RCLENBQUMsTUFDQyxFQUFFLFNBQVMsVUFBVSxPQUFPLEVBQUUsU0FBUyxZQUFZLEVBQUUsS0FBSyxLQUFLLEVBQUUsU0FBUyxLQUN2RSxFQUFFLFNBQVMsY0FBYyxPQUFPLEVBQUUsYUFBYSxZQUFZLEVBQUUsU0FBUyxLQUFLLEVBQUUsU0FBUztBQUFBLEVBQzVGO0FBQ0Q7QUFFQSxTQUFTLHVCQUF1QixTQUEyQztBQUMxRSxTQUFPLFFBQVEsUUFBUSxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsY0FBYyxFQUFFLFNBQVMsZUFBZTtBQUN2RjtBQUtPLFNBQVMsNkJBQ2YsZUFDZ0Q7QUFDaEQsTUFBSSxjQUFjO0FBQ2xCLFdBQVMsSUFBSSxjQUFjLFNBQVMsR0FBRyxLQUFLLEdBQUcsS0FBSztBQUNuRCxVQUFNLElBQUksY0FBYyxDQUFDO0FBQ3pCLFFBQUksR0FBRyxTQUFTLGNBQWMsR0FBRyxTQUFTLGlCQUFpQjtBQUMxRCxvQkFBYztBQUNkO0FBQUEsSUFDRDtBQUFBLEVBQ0Q7QUFDQSxRQUFNLE1BQXFELENBQUM7QUFDNUQsV0FBUyxJQUFJLGNBQWMsR0FB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
