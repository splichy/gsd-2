import * as vscode from "vscode";
function registerChatParticipant(context, client) {
  const participant = vscode.chat.createChatParticipant("gsd.agent", async (request, _chatContext, response, token) => {
    if (!client.isConnected) {
      response.progress("Starting GSD agent...");
      try {
        await client.start();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        response.markdown(`**Failed to start GSD agent:** ${msg}

Make sure \`gsd\` is installed (\`npm install -g gsd-pi\`) and try again.`);
        return;
      }
    }
    let message = request.prompt.trim();
    if (!message) {
      response.markdown("Please provide a message.");
      return;
    }
    const fileContext = await buildFileContext(request);
    if (fileContext) {
      message = `${fileContext}

${message}`;
    }
    const selectionContext = getSelectionContext();
    if (selectionContext) {
      message = `${selectionContext}

${message}`;
    }
    const fixKeywords = /\b(fix|error|problem|warning|issue|bug|lint|diagnos)/i;
    if (fixKeywords.test(message)) {
      const diagContext = getActiveDiagnosticsContext();
      if (diagContext) {
        message = `${message}

${diagContext}`;
      }
    }
    let agentDone = false;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const filesWritten = [];
    const filesRead = [];
    const eventHandler = (event) => {
      switch (event.type) {
        case "agent_start":
          response.progress("GSD is working...");
          break;
        case "tool_execution_start": {
          const toolName = event.toolName;
          const toolInput = event.toolInput;
          const detail = describeToolCall(toolName, toolInput);
          response.progress(detail);
          if (toolInput?.file_path) {
            const fp = String(toolInput.file_path);
            if (toolName === "Write" || toolName === "Edit") {
              if (!filesWritten.includes(fp)) filesWritten.push(fp);
            } else if (toolName === "Read") {
              if (!filesRead.includes(fp)) filesRead.push(fp);
            }
          }
          break;
        }
        case "message_update": {
          const assistantEvent = event.assistantMessageEvent;
          if (!assistantEvent) break;
          if (assistantEvent.type === "text_delta") {
            const delta = assistantEvent.delta;
            if (delta) {
              response.markdown(delta);
            }
          } else if (assistantEvent.type === "thinking_delta") {
            const delta = assistantEvent.delta;
            if (delta) {
              response.markdown(`*${delta}*`);
            }
          }
          break;
        }
        case "message_end": {
          const usage = event.usage;
          if (usage) {
            if (usage.inputTokens) totalInputTokens += usage.inputTokens;
            if (usage.outputTokens) totalOutputTokens += usage.outputTokens;
          }
          break;
        }
        case "agent_end":
          agentDone = true;
          break;
      }
    };
    const subscription = client.onEvent(eventHandler);
    token.onCancellationRequested(() => {
      client.abort().catch(() => {
      });
    });
    try {
      await client.sendPrompt(message);
      await new Promise((resolve) => {
        if (agentDone) {
          resolve();
          return;
        }
        const checkDone = client.onEvent((evt) => {
          if (evt.type === "agent_end") {
            checkDone.dispose();
            resolve();
          }
        });
        token.onCancellationRequested(() => {
          checkDone.dispose();
          resolve();
        });
      });
      if (filesWritten.length > 0) {
        response.markdown("\n\n**Files changed:**");
        for (const fp of filesWritten) {
          const uri = resolveFileUri(fp);
          if (uri) {
            response.anchor(uri, fp);
            response.markdown(" ");
          }
        }
      }
      if (totalInputTokens > 0 || totalOutputTokens > 0) {
        response.markdown(
          `

---
*${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out tokens*`
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      response.markdown(`
**Error:** ${errorMessage}`);
    } finally {
      subscription.dispose();
    }
  });
  participant.iconPath = new vscode.ThemeIcon("hubot");
  participant.followupProvider = {
    provideFollowups: (_result, _context, _token) => {
      return [
        {
          prompt: "/gsd status",
          label: "$(info) Check status",
          title: "Check project status"
        },
        {
          prompt: "/gsd auto",
          label: "$(rocket) Run auto mode",
          title: "Run autonomous mode"
        },
        {
          prompt: "/gsd capture",
          label: "$(note) Capture a thought",
          title: "Capture a thought mid-session"
        }
      ];
    }
  };
  return participant;
}
async function buildFileContext(request) {
  if (!request.references || request.references.length === 0) {
    return null;
  }
  const parts = [];
  for (const ref of request.references) {
    if (ref.value instanceof vscode.Uri) {
      try {
        const bytes = await vscode.workspace.fs.readFile(ref.value);
        const content = Buffer.from(bytes).toString("utf-8");
        const relativePath = vscode.workspace.asRelativePath(ref.value);
        parts.push(`File: ${relativePath}
\`\`\`
${content}
\`\`\``);
      } catch {
      }
    } else if (ref.value instanceof vscode.Location) {
      try {
        const doc = await vscode.workspace.openTextDocument(ref.value.uri);
        const text = doc.getText(ref.value.range);
        const relativePath = vscode.workspace.asRelativePath(ref.value.uri);
        const { start, end } = ref.value.range;
        parts.push(`File: ${relativePath} (lines ${start.line + 1}\u2013${end.line + 1})
\`\`\`
${text}
\`\`\``);
      } catch {
      }
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
function describeToolCall(toolName, input) {
  if (!input) {
    return `Running: ${toolName}`;
  }
  switch (toolName) {
    case "Read":
      return `Reading: ${shortenPath(String(input.file_path ?? ""))}`;
    case "Write":
      return `Writing: ${shortenPath(String(input.file_path ?? ""))}`;
    case "Edit":
      return `Editing: ${shortenPath(String(input.file_path ?? ""))}`;
    case "Bash": {
      const cmd = String(input.command ?? "");
      return `$ ${cmd.length > 80 ? cmd.slice(0, 77) + "\u2026" : cmd}`;
    }
    case "Glob":
      return `Searching: ${input.pattern ?? ""}`;
    case "Grep":
      return `Grep: ${input.pattern ?? ""}`;
    case "WebSearch":
      return `Searching web: ${String(input.query ?? "").slice(0, 60)}`;
    case "WebFetch":
      return `Fetching: ${String(input.url ?? "").slice(0, 60)}`;
    default:
      return `Running: ${toolName}`;
  }
}
function shortenPath(fp) {
  const parts = fp.replace(/\\/g, "/").split("/");
  return parts.slice(-3).join("/");
}
function resolveFileUri(fp) {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }
    if (fp.startsWith("/") || /^[A-Za-z]:[\\/]/.test(fp)) {
      return vscode.Uri.file(fp);
    }
    return vscode.Uri.joinPath(workspaceFolders[0].uri, fp);
  } catch {
    return null;
  }
}
function getSelectionContext() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return null;
  const selection = editor.document.getText(editor.selection);
  if (!selection.trim()) return null;
  const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
  const { start, end } = editor.selection;
  return `Selected code in \`${relativePath}\` (lines ${start.line + 1}-${end.line + 1}):
\`\`\`
${selection}
\`\`\``;
}
function getActiveDiagnosticsContext() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
  const significant = diagnostics.filter(
    (d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning
  );
  if (significant.length === 0) return null;
  const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
  const lines = [`Current diagnostics in \`${relativePath}\`:`];
  for (const d of significant) {
    const sev = d.severity === vscode.DiagnosticSeverity.Error ? "Error" : "Warning";
    const line = d.range.start.line + 1;
    const source = d.source ? ` [${d.source}]` : "";
    lines.push(`- ${sev} (line ${line}): ${d.message}${source}`);
  }
  return lines.join("\n");
}
export {
  registerChatParticipant
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvY2hhdC1wYXJ0aWNpcGFudC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0ICogYXMgdnNjb2RlIGZyb20gXCJ2c2NvZGVcIjtcbmltcG9ydCB0eXBlIHsgQWdlbnRFdmVudCwgR3NkQ2xpZW50IH0gZnJvbSBcIi4vZ3NkLWNsaWVudC5qc1wiO1xuXG4vKipcbiAqIFJlZ2lzdGVycyB0aGUgQGdzZCBjaGF0IHBhcnRpY2lwYW50IHRoYXQgZm9yd2FyZHMgbWVzc2FnZXMgdG8gdGhlXG4gKiBHU0QgUlBDIGNsaWVudCBhbmQgc3RyZWFtcyB0b29sIGV4ZWN1dGlvbiBldmVudHMgYmFjayB0byB0aGUgY2hhdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyQ2hhdFBhcnRpY2lwYW50KFxuXHRjb250ZXh0OiB2c2NvZGUuRXh0ZW5zaW9uQ29udGV4dCxcblx0Y2xpZW50OiBHc2RDbGllbnQsXG4pOiB2c2NvZGUuRGlzcG9zYWJsZSB7XG5cdGNvbnN0IHBhcnRpY2lwYW50ID0gdnNjb2RlLmNoYXQuY3JlYXRlQ2hhdFBhcnRpY2lwYW50KFwiZ3NkLmFnZW50XCIsIGFzeW5jIChcblx0XHRyZXF1ZXN0OiB2c2NvZGUuQ2hhdFJlcXVlc3QsXG5cdFx0X2NoYXRDb250ZXh0OiB2c2NvZGUuQ2hhdENvbnRleHQsXG5cdFx0cmVzcG9uc2U6IHZzY29kZS5DaGF0UmVzcG9uc2VTdHJlYW0sXG5cdFx0dG9rZW46IHZzY29kZS5DYW5jZWxsYXRpb25Ub2tlbixcblx0KSA9PiB7XG5cdFx0Ly8gQXV0by1zdGFydCB0aGUgYWdlbnQgaWYgbm90IGNvbm5lY3RlZFxuXHRcdGlmICghY2xpZW50LmlzQ29ubmVjdGVkKSB7XG5cdFx0XHRyZXNwb25zZS5wcm9ncmVzcyhcIlN0YXJ0aW5nIEdTRCBhZ2VudC4uLlwiKTtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGNsaWVudC5zdGFydCgpO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcblx0XHRcdFx0cmVzcG9uc2UubWFya2Rvd24oYCoqRmFpbGVkIHRvIHN0YXJ0IEdTRCBhZ2VudDoqKiAke21zZ31cXG5cXG5NYWtlIHN1cmUgXFxgZ3NkXFxgIGlzIGluc3RhbGxlZCAoXFxgbnBtIGluc3RhbGwgLWcgZ3NkLXBpXFxgKSBhbmQgdHJ5IGFnYWluLmApO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gQnVpbGQgdGhlIGZ1bGwgbWVzc2FnZSwgaW5qZWN0aW5nIGFueSAjZmlsZSByZWZlcmVuY2VzXG5cdFx0bGV0IG1lc3NhZ2UgPSByZXF1ZXN0LnByb21wdC50cmltKCk7XG5cdFx0aWYgKCFtZXNzYWdlKSB7XG5cdFx0XHRyZXNwb25zZS5tYXJrZG93bihcIlBsZWFzZSBwcm92aWRlIGEgbWVzc2FnZS5cIik7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3QgZmlsZUNvbnRleHQgPSBhd2FpdCBidWlsZEZpbGVDb250ZXh0KHJlcXVlc3QpO1xuXHRcdGlmIChmaWxlQ29udGV4dCkge1xuXHRcdFx0bWVzc2FnZSA9IGAke2ZpbGVDb250ZXh0fVxcblxcbiR7bWVzc2FnZX1gO1xuXHRcdH1cblxuXHRcdC8vIEF1dG8taW5jbHVkZSBlZGl0b3Igc2VsZWN0aW9uIGlmIHByZXNlbnQgYW5kIG5vdCBhbHJlYWR5IHJlZmVyZW5jZWRcblx0XHRjb25zdCBzZWxlY3Rpb25Db250ZXh0ID0gZ2V0U2VsZWN0aW9uQ29udGV4dCgpO1xuXHRcdGlmIChzZWxlY3Rpb25Db250ZXh0KSB7XG5cdFx0XHRtZXNzYWdlID0gYCR7c2VsZWN0aW9uQ29udGV4dH1cXG5cXG4ke21lc3NhZ2V9YDtcblx0XHR9XG5cblx0XHQvLyBBdXRvLWluY2x1ZGUgZGlhZ25vc3RpY3MgZm9yIHRoZSBhY3RpdmUgZmlsZSBpZiB0aGUgcHJvbXB0IG1lbnRpb25zIFwiZml4XCIsIFwiZXJyb3JcIiwgXCJwcm9ibGVtXCIsIFwid2FybmluZ1wiXG5cdFx0Y29uc3QgZml4S2V5d29yZHMgPSAvXFxiKGZpeHxlcnJvcnxwcm9ibGVtfHdhcm5pbmd8aXNzdWV8YnVnfGxpbnR8ZGlhZ25vcykvaTtcblx0XHRpZiAoZml4S2V5d29yZHMudGVzdChtZXNzYWdlKSkge1xuXHRcdFx0Y29uc3QgZGlhZ0NvbnRleHQgPSBnZXRBY3RpdmVEaWFnbm9zdGljc0NvbnRleHQoKTtcblx0XHRcdGlmIChkaWFnQ29udGV4dCkge1xuXHRcdFx0XHRtZXNzYWdlID0gYCR7bWVzc2FnZX1cXG5cXG4ke2RpYWdDb250ZXh0fWA7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gVHJhY2sgc3RyZWFtaW5nIHN0YXRlXG5cdFx0bGV0IGFnZW50RG9uZSA9IGZhbHNlO1xuXHRcdGxldCB0b3RhbElucHV0VG9rZW5zID0gMDtcblx0XHRsZXQgdG90YWxPdXRwdXRUb2tlbnMgPSAwO1xuXHRcdGNvbnN0IGZpbGVzV3JpdHRlbjogc3RyaW5nW10gPSBbXTtcblx0XHRjb25zdCBmaWxlc1JlYWQ6IHN0cmluZ1tdID0gW107XG5cblx0XHRjb25zdCBldmVudEhhbmRsZXIgPSAoZXZlbnQ6IEFnZW50RXZlbnQpID0+IHtcblx0XHRcdHN3aXRjaCAoZXZlbnQudHlwZSkge1xuXHRcdFx0XHRjYXNlIFwiYWdlbnRfc3RhcnRcIjpcblx0XHRcdFx0XHRyZXNwb25zZS5wcm9ncmVzcyhcIkdTRCBpcyB3b3JraW5nLi4uXCIpO1xuXHRcdFx0XHRcdGJyZWFrO1xuXG5cdFx0XHRcdGNhc2UgXCJ0b29sX2V4ZWN1dGlvbl9zdGFydFwiOiB7XG5cdFx0XHRcdFx0Y29uc3QgdG9vbE5hbWUgPSBldmVudC50b29sTmFtZSBhcyBzdHJpbmc7XG5cdFx0XHRcdFx0Y29uc3QgdG9vbElucHV0ID0gZXZlbnQudG9vbElucHV0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuXHRcdFx0XHRcdGNvbnN0IGRldGFpbCA9IGRlc2NyaWJlVG9vbENhbGwodG9vbE5hbWUsIHRvb2xJbnB1dCk7XG5cdFx0XHRcdFx0cmVzcG9uc2UucHJvZ3Jlc3MoZGV0YWlsKTtcblxuXHRcdFx0XHRcdC8vIFRyYWNrIGZpbGUgcGF0aHMgZm9yIGFuY2hvcnNcblx0XHRcdFx0XHRpZiAodG9vbElucHV0Py5maWxlX3BhdGgpIHtcblx0XHRcdFx0XHRcdGNvbnN0IGZwID0gU3RyaW5nKHRvb2xJbnB1dC5maWxlX3BhdGgpO1xuXHRcdFx0XHRcdFx0aWYgKHRvb2xOYW1lID09PSBcIldyaXRlXCIgfHwgdG9vbE5hbWUgPT09IFwiRWRpdFwiKSB7XG5cdFx0XHRcdFx0XHRcdGlmICghZmlsZXNXcml0dGVuLmluY2x1ZGVzKGZwKSkgZmlsZXNXcml0dGVuLnB1c2goZnApO1xuXHRcdFx0XHRcdFx0fSBlbHNlIGlmICh0b29sTmFtZSA9PT0gXCJSZWFkXCIpIHtcblx0XHRcdFx0XHRcdFx0aWYgKCFmaWxlc1JlYWQuaW5jbHVkZXMoZnApKSBmaWxlc1JlYWQucHVzaChmcCk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y2FzZSBcIm1lc3NhZ2VfdXBkYXRlXCI6IHtcblx0XHRcdFx0XHRjb25zdCBhc3Npc3RhbnRFdmVudCA9IGV2ZW50LmFzc2lzdGFudE1lc3NhZ2VFdmVudCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcblx0XHRcdFx0XHRpZiAoIWFzc2lzdGFudEV2ZW50KSBicmVhaztcblxuXHRcdFx0XHRcdGlmIChhc3Npc3RhbnRFdmVudC50eXBlID09PSBcInRleHRfZGVsdGFcIikge1xuXHRcdFx0XHRcdFx0Y29uc3QgZGVsdGEgPSBhc3Npc3RhbnRFdmVudC5kZWx0YSBhcyBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0XHRpZiAoZGVsdGEpIHtcblx0XHRcdFx0XHRcdFx0cmVzcG9uc2UubWFya2Rvd24oZGVsdGEpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH0gZWxzZSBpZiAoYXNzaXN0YW50RXZlbnQudHlwZSA9PT0gXCJ0aGlua2luZ19kZWx0YVwiKSB7XG5cdFx0XHRcdFx0XHQvLyBUaGlua2luZyBzaG93biBpbmxpbmUgXHUyMDE0IHByZWZpeCB3aXRoIGl0YWxpYyBzbyBpdCdzIHZpc3VhbGx5IGRpc3RpbmN0XG5cdFx0XHRcdFx0XHRjb25zdCBkZWx0YSA9IGFzc2lzdGFudEV2ZW50LmRlbHRhIGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcblx0XHRcdFx0XHRcdGlmIChkZWx0YSkge1xuXHRcdFx0XHRcdFx0XHRyZXNwb25zZS5tYXJrZG93bihgKiR7ZGVsdGF9KmApO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNhc2UgXCJtZXNzYWdlX2VuZFwiOiB7XG5cdFx0XHRcdFx0Y29uc3QgdXNhZ2UgPSBldmVudC51c2FnZSBhcyB7IGlucHV0VG9rZW5zPzogbnVtYmVyOyBvdXRwdXRUb2tlbnM/OiBudW1iZXIgfSB8IHVuZGVmaW5lZDtcblx0XHRcdFx0XHRpZiAodXNhZ2UpIHtcblx0XHRcdFx0XHRcdGlmICh1c2FnZS5pbnB1dFRva2VucykgdG90YWxJbnB1dFRva2VucyArPSB1c2FnZS5pbnB1dFRva2Vucztcblx0XHRcdFx0XHRcdGlmICh1c2FnZS5vdXRwdXRUb2tlbnMpIHRvdGFsT3V0cHV0VG9rZW5zICs9IHVzYWdlLm91dHB1dFRva2Vucztcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjYXNlIFwiYWdlbnRfZW5kXCI6XG5cdFx0XHRcdFx0YWdlbnREb25lID0gdHJ1ZTtcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHR9O1xuXG5cdFx0Y29uc3Qgc3Vic2NyaXB0aW9uID0gY2xpZW50Lm9uRXZlbnQoZXZlbnRIYW5kbGVyKTtcblxuXHRcdHRva2VuLm9uQ2FuY2VsbGF0aW9uUmVxdWVzdGVkKCgpID0+IHtcblx0XHRcdGNsaWVudC5hYm9ydCgpLmNhdGNoKCgpID0+IHt9KTtcblx0XHR9KTtcblxuXHRcdHRyeSB7XG5cdFx0XHRhd2FpdCBjbGllbnQuc2VuZFByb21wdChtZXNzYWdlKTtcblxuXHRcdFx0Ly8gV2FpdCBmb3IgYWdlbnRfZW5kIG9yIGNhbmNlbGxhdGlvblxuXHRcdFx0YXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcblx0XHRcdFx0aWYgKGFnZW50RG9uZSkge1xuXHRcdFx0XHRcdHJlc29sdmUoKTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgY2hlY2tEb25lID0gY2xpZW50Lm9uRXZlbnQoKGV2dCkgPT4ge1xuXHRcdFx0XHRcdGlmIChldnQudHlwZSA9PT0gXCJhZ2VudF9lbmRcIikge1xuXHRcdFx0XHRcdFx0Y2hlY2tEb25lLmRpc3Bvc2UoKTtcblx0XHRcdFx0XHRcdHJlc29sdmUoKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0pO1xuXHRcdFx0XHR0b2tlbi5vbkNhbmNlbGxhdGlvblJlcXVlc3RlZCgoKSA9PiB7XG5cdFx0XHRcdFx0Y2hlY2tEb25lLmRpc3Bvc2UoKTtcblx0XHRcdFx0XHRyZXNvbHZlKCk7XG5cdFx0XHRcdH0pO1xuXHRcdFx0fSk7XG5cblx0XHRcdC8vIFNob3cgY2xpY2thYmxlIGZpbGUgYW5jaG9ycyBmb3Igd3JpdHRlbiBmaWxlc1xuXHRcdFx0aWYgKGZpbGVzV3JpdHRlbi5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdHJlc3BvbnNlLm1hcmtkb3duKFwiXFxuXFxuKipGaWxlcyBjaGFuZ2VkOioqXCIpO1xuXHRcdFx0XHRmb3IgKGNvbnN0IGZwIG9mIGZpbGVzV3JpdHRlbikge1xuXHRcdFx0XHRcdGNvbnN0IHVyaSA9IHJlc29sdmVGaWxlVXJpKGZwKTtcblx0XHRcdFx0XHRpZiAodXJpKSB7XG5cdFx0XHRcdFx0XHRyZXNwb25zZS5hbmNob3IodXJpLCBmcCk7XG5cdFx0XHRcdFx0XHRyZXNwb25zZS5tYXJrZG93bihcIiBcIik7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIFRva2VuIHVzYWdlIHN1bW1hcnlcblx0XHRcdGlmICh0b3RhbElucHV0VG9rZW5zID4gMCB8fCB0b3RhbE91dHB1dFRva2VucyA+IDApIHtcblx0XHRcdFx0cmVzcG9uc2UubWFya2Rvd24oXG5cdFx0XHRcdFx0YFxcblxcbi0tLVxcbioke3RvdGFsSW5wdXRUb2tlbnMudG9Mb2NhbGVTdHJpbmcoKX0gaW4gLyAke3RvdGFsT3V0cHV0VG9rZW5zLnRvTG9jYWxlU3RyaW5nKCl9IG91dCB0b2tlbnMqYCxcblx0XHRcdFx0KTtcblx0XHRcdH1cblx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdGNvbnN0IGVycm9yTWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcblx0XHRcdHJlc3BvbnNlLm1hcmtkb3duKGBcXG4qKkVycm9yOioqICR7ZXJyb3JNZXNzYWdlfWApO1xuXHRcdH0gZmluYWxseSB7XG5cdFx0XHRzdWJzY3JpcHRpb24uZGlzcG9zZSgpO1xuXHRcdH1cblx0fSk7XG5cblx0cGFydGljaXBhbnQuaWNvblBhdGggPSBuZXcgdnNjb2RlLlRoZW1lSWNvbihcImh1Ym90XCIpO1xuXG5cdC8vIEZvbGxvdy11cCBzdWdnZXN0aW9ucyBhZnRlciBlYWNoIHJlc3BvbnNlXG5cdHBhcnRpY2lwYW50LmZvbGxvd3VwUHJvdmlkZXIgPSB7XG5cdFx0cHJvdmlkZUZvbGxvd3VwczogKF9yZXN1bHQsIF9jb250ZXh0LCBfdG9rZW4pID0+IHtcblx0XHRcdHJldHVybiBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRwcm9tcHQ6IFwiL2dzZCBzdGF0dXNcIixcblx0XHRcdFx0XHRsYWJlbDogXCIkKGluZm8pIENoZWNrIHN0YXR1c1wiLFxuXHRcdFx0XHRcdHRpdGxlOiBcIkNoZWNrIHByb2plY3Qgc3RhdHVzXCIsXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRwcm9tcHQ6IFwiL2dzZCBhdXRvXCIsXG5cdFx0XHRcdFx0bGFiZWw6IFwiJChyb2NrZXQpIFJ1biBhdXRvIG1vZGVcIixcblx0XHRcdFx0XHR0aXRsZTogXCJSdW4gYXV0b25vbW91cyBtb2RlXCIsXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRwcm9tcHQ6IFwiL2dzZCBjYXB0dXJlXCIsXG5cdFx0XHRcdFx0bGFiZWw6IFwiJChub3RlKSBDYXB0dXJlIGEgdGhvdWdodFwiLFxuXHRcdFx0XHRcdHRpdGxlOiBcIkNhcHR1cmUgYSB0aG91Z2h0IG1pZC1zZXNzaW9uXCIsXG5cdFx0XHRcdH0sXG5cdFx0XHRdO1xuXHRcdH0sXG5cdH07XG5cblx0cmV0dXJuIHBhcnRpY2lwYW50O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBCdWlsZCBhIGZpbGUgY29udGV4dCBibG9jayBmcm9tIGFueSAjZmlsZSByZWZlcmVuY2VzIGluIHRoZSBjaGF0IHJlcXVlc3QuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGJ1aWxkRmlsZUNvbnRleHQocmVxdWVzdDogdnNjb2RlLkNoYXRSZXF1ZXN0KTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG5cdGlmICghcmVxdWVzdC5yZWZlcmVuY2VzIHx8IHJlcXVlc3QucmVmZXJlbmNlcy5sZW5ndGggPT09IDApIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxuXG5cdGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdGZvciAoY29uc3QgcmVmIG9mIHJlcXVlc3QucmVmZXJlbmNlcykge1xuXHRcdGlmIChyZWYudmFsdWUgaW5zdGFuY2VvZiB2c2NvZGUuVXJpKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBieXRlcyA9IGF3YWl0IHZzY29kZS53b3Jrc3BhY2UuZnMucmVhZEZpbGUocmVmLnZhbHVlKTtcblx0XHRcdFx0Y29uc3QgY29udGVudCA9IEJ1ZmZlci5mcm9tKGJ5dGVzKS50b1N0cmluZyhcInV0Zi04XCIpO1xuXHRcdFx0XHRjb25zdCByZWxhdGl2ZVBhdGggPSB2c2NvZGUud29ya3NwYWNlLmFzUmVsYXRpdmVQYXRoKHJlZi52YWx1ZSk7XG5cdFx0XHRcdHBhcnRzLnB1c2goYEZpbGU6ICR7cmVsYXRpdmVQYXRofVxcblxcYFxcYFxcYFxcbiR7Y29udGVudH1cXG5cXGBcXGBcXGBgKTtcblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHQvLyBTa2lwIHVucmVhZGFibGUgZmlsZXNcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKHJlZi52YWx1ZSBpbnN0YW5jZW9mIHZzY29kZS5Mb2NhdGlvbikge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgZG9jID0gYXdhaXQgdnNjb2RlLndvcmtzcGFjZS5vcGVuVGV4dERvY3VtZW50KHJlZi52YWx1ZS51cmkpO1xuXHRcdFx0XHRjb25zdCB0ZXh0ID0gZG9jLmdldFRleHQocmVmLnZhbHVlLnJhbmdlKTtcblx0XHRcdFx0Y29uc3QgcmVsYXRpdmVQYXRoID0gdnNjb2RlLndvcmtzcGFjZS5hc1JlbGF0aXZlUGF0aChyZWYudmFsdWUudXJpKTtcblx0XHRcdFx0Y29uc3QgeyBzdGFydCwgZW5kIH0gPSByZWYudmFsdWUucmFuZ2U7XG5cdFx0XHRcdHBhcnRzLnB1c2goYEZpbGU6ICR7cmVsYXRpdmVQYXRofSAobGluZXMgJHtzdGFydC5saW5lICsgMX1cdTIwMTMke2VuZC5saW5lICsgMX0pXFxuXFxgXFxgXFxgXFxuJHt0ZXh0fVxcblxcYFxcYFxcYGApO1xuXHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdC8vIFNraXAgdW5yZWFkYWJsZSByYW5nZXNcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gcGFydHMubGVuZ3RoID4gMCA/IHBhcnRzLmpvaW4oXCJcXG5cXG5cIikgOiBudWxsO1xufVxuXG4vKipcbiAqIFByb2R1Y2UgYSBodW1hbi1yZWFkYWJsZSBwcm9ncmVzcyBsYWJlbCBmb3IgYSB0b29sIGNhbGwuXG4gKi9cbmZ1bmN0aW9uIGRlc2NyaWJlVG9vbENhbGwodG9vbE5hbWU6IHN0cmluZywgaW5wdXQ/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHN0cmluZyB7XG5cdGlmICghaW5wdXQpIHtcblx0XHRyZXR1cm4gYFJ1bm5pbmc6ICR7dG9vbE5hbWV9YDtcblx0fVxuXHRzd2l0Y2ggKHRvb2xOYW1lKSB7XG5cdFx0Y2FzZSBcIlJlYWRcIjpcblx0XHRcdHJldHVybiBgUmVhZGluZzogJHtzaG9ydGVuUGF0aChTdHJpbmcoaW5wdXQuZmlsZV9wYXRoID8/IFwiXCIpKX1gO1xuXHRcdGNhc2UgXCJXcml0ZVwiOlxuXHRcdFx0cmV0dXJuIGBXcml0aW5nOiAke3Nob3J0ZW5QYXRoKFN0cmluZyhpbnB1dC5maWxlX3BhdGggPz8gXCJcIikpfWA7XG5cdFx0Y2FzZSBcIkVkaXRcIjpcblx0XHRcdHJldHVybiBgRWRpdGluZzogJHtzaG9ydGVuUGF0aChTdHJpbmcoaW5wdXQuZmlsZV9wYXRoID8/IFwiXCIpKX1gO1xuXHRcdGNhc2UgXCJCYXNoXCI6IHtcblx0XHRcdGNvbnN0IGNtZCA9IFN0cmluZyhpbnB1dC5jb21tYW5kID8/IFwiXCIpO1xuXHRcdFx0cmV0dXJuIGAkICR7Y21kLmxlbmd0aCA+IDgwID8gY21kLnNsaWNlKDAsIDc3KSArIFwiXHUyMDI2XCIgOiBjbWR9YDtcblx0XHR9XG5cdFx0Y2FzZSBcIkdsb2JcIjpcblx0XHRcdHJldHVybiBgU2VhcmNoaW5nOiAke2lucHV0LnBhdHRlcm4gPz8gXCJcIn1gO1xuXHRcdGNhc2UgXCJHcmVwXCI6XG5cdFx0XHRyZXR1cm4gYEdyZXA6ICR7aW5wdXQucGF0dGVybiA/PyBcIlwifWA7XG5cdFx0Y2FzZSBcIldlYlNlYXJjaFwiOlxuXHRcdFx0cmV0dXJuIGBTZWFyY2hpbmcgd2ViOiAke1N0cmluZyhpbnB1dC5xdWVyeSA/PyBcIlwiKS5zbGljZSgwLCA2MCl9YDtcblx0XHRjYXNlIFwiV2ViRmV0Y2hcIjpcblx0XHRcdHJldHVybiBgRmV0Y2hpbmc6ICR7U3RyaW5nKGlucHV0LnVybCA/PyBcIlwiKS5zbGljZSgwLCA2MCl9YDtcblx0XHRkZWZhdWx0OlxuXHRcdFx0cmV0dXJuIGBSdW5uaW5nOiAke3Rvb2xOYW1lfWA7XG5cdH1cbn1cblxuLyoqXG4gKiBTaG9ydGVuIGFuIGFic29sdXRlIHBhdGggdG8ganVzdCB0aGUgbGFzdCAyXHUyMDEzMyBzZWdtZW50cyBmb3IgZGlzcGxheS5cbiAqL1xuZnVuY3Rpb24gc2hvcnRlblBhdGgoZnA6IHN0cmluZyk6IHN0cmluZyB7XG5cdGNvbnN0IHBhcnRzID0gZnAucmVwbGFjZSgvXFxcXC9nLCBcIi9cIikuc3BsaXQoXCIvXCIpO1xuXHRyZXR1cm4gcGFydHMuc2xpY2UoLTMpLmpvaW4oXCIvXCIpO1xufVxuXG4vKipcbiAqIEF0dGVtcHQgdG8gcmVzb2x2ZSBhIGZpbGUgcGF0aCBzdHJpbmcgdG8gYSBWUyBDb2RlIFVSSS5cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZUZpbGVVcmkoZnA6IHN0cmluZyk6IHZzY29kZS5VcmkgfCBudWxsIHtcblx0dHJ5IHtcblx0XHRjb25zdCB3b3Jrc3BhY2VGb2xkZXJzID0gdnNjb2RlLndvcmtzcGFjZS53b3Jrc3BhY2VGb2xkZXJzO1xuXHRcdGlmICghd29ya3NwYWNlRm9sZGVycyB8fCB3b3Jrc3BhY2VGb2xkZXJzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0fVxuXHRcdC8vIEFic29sdXRlIHBhdGhcblx0XHRpZiAoZnAuc3RhcnRzV2l0aChcIi9cIikgfHwgL15bQS1aYS16XTpbXFxcXC9dLy50ZXN0KGZwKSkge1xuXHRcdFx0cmV0dXJuIHZzY29kZS5VcmkuZmlsZShmcCk7XG5cdFx0fVxuXHRcdC8vIFJlbGF0aXZlIHBhdGggXHUyMDE0IHJlc29sdmUgYWdhaW5zdCBmaXJzdCB3b3Jrc3BhY2UgZm9sZGVyXG5cdFx0cmV0dXJuIHZzY29kZS5Vcmkuam9pblBhdGgod29ya3NwYWNlRm9sZGVyc1swXS51cmksIGZwKTtcblx0fSBjYXRjaCB7XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cbn1cblxuLyoqXG4gKiBHZXQgdGhlIGN1cnJlbnQgZWRpdG9yIHNlbGVjdGlvbiBhcyBjb250ZXh0LCBpZiBhbnkgdGV4dCBpcyBzZWxlY3RlZC5cbiAqL1xuZnVuY3Rpb24gZ2V0U2VsZWN0aW9uQ29udGV4dCgpOiBzdHJpbmcgfCBudWxsIHtcblx0Y29uc3QgZWRpdG9yID0gdnNjb2RlLndpbmRvdy5hY3RpdmVUZXh0RWRpdG9yO1xuXHRpZiAoIWVkaXRvciB8fCBlZGl0b3Iuc2VsZWN0aW9uLmlzRW1wdHkpIHJldHVybiBudWxsO1xuXG5cdGNvbnN0IHNlbGVjdGlvbiA9IGVkaXRvci5kb2N1bWVudC5nZXRUZXh0KGVkaXRvci5zZWxlY3Rpb24pO1xuXHRpZiAoIXNlbGVjdGlvbi50cmltKCkpIHJldHVybiBudWxsO1xuXG5cdGNvbnN0IHJlbGF0aXZlUGF0aCA9IHZzY29kZS53b3Jrc3BhY2UuYXNSZWxhdGl2ZVBhdGgoZWRpdG9yLmRvY3VtZW50LnVyaSk7XG5cdGNvbnN0IHsgc3RhcnQsIGVuZCB9ID0gZWRpdG9yLnNlbGVjdGlvbjtcblx0cmV0dXJuIGBTZWxlY3RlZCBjb2RlIGluIFxcYCR7cmVsYXRpdmVQYXRofVxcYCAobGluZXMgJHtzdGFydC5saW5lICsgMX0tJHtlbmQubGluZSArIDF9KTpcXG5cXGBcXGBcXGBcXG4ke3NlbGVjdGlvbn1cXG5cXGBcXGBcXGBgO1xufVxuXG4vKipcbiAqIEdldCBkaWFnbm9zdGljcyAoZXJyb3JzL3dhcm5pbmdzKSBmb3IgdGhlIGFjdGl2ZSBlZGl0b3IgZmlsZS5cbiAqL1xuZnVuY3Rpb24gZ2V0QWN0aXZlRGlhZ25vc3RpY3NDb250ZXh0KCk6IHN0cmluZyB8IG51bGwge1xuXHRjb25zdCBlZGl0b3IgPSB2c2NvZGUud2luZG93LmFjdGl2ZVRleHRFZGl0b3I7XG5cdGlmICghZWRpdG9yKSByZXR1cm4gbnVsbDtcblxuXHRjb25zdCBkaWFnbm9zdGljcyA9IHZzY29kZS5sYW5ndWFnZXMuZ2V0RGlhZ25vc3RpY3MoZWRpdG9yLmRvY3VtZW50LnVyaSk7XG5cdGNvbnN0IHNpZ25pZmljYW50ID0gZGlhZ25vc3RpY3MuZmlsdGVyKFxuXHRcdChkKSA9PiBkLnNldmVyaXR5ID09PSB2c2NvZGUuRGlhZ25vc3RpY1NldmVyaXR5LkVycm9yIHx8IGQuc2V2ZXJpdHkgPT09IHZzY29kZS5EaWFnbm9zdGljU2V2ZXJpdHkuV2FybmluZyxcblx0KTtcblx0aWYgKHNpZ25pZmljYW50Lmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cblx0Y29uc3QgcmVsYXRpdmVQYXRoID0gdnNjb2RlLndvcmtzcGFjZS5hc1JlbGF0aXZlUGF0aChlZGl0b3IuZG9jdW1lbnQudXJpKTtcblx0Y29uc3QgbGluZXMgPSBbYEN1cnJlbnQgZGlhZ25vc3RpY3MgaW4gXFxgJHtyZWxhdGl2ZVBhdGh9XFxgOmBdO1xuXHRmb3IgKGNvbnN0IGQgb2Ygc2lnbmlmaWNhbnQpIHtcblx0XHRjb25zdCBzZXYgPSBkLnNldmVyaXR5ID09PSB2c2NvZGUuRGlhZ25vc3RpY1NldmVyaXR5LkVycm9yID8gXCJFcnJvclwiIDogXCJXYXJuaW5nXCI7XG5cdFx0Y29uc3QgbGluZSA9IGQucmFuZ2Uuc3RhcnQubGluZSArIDE7XG5cdFx0Y29uc3Qgc291cmNlID0gZC5zb3VyY2UgPyBgIFske2Quc291cmNlfV1gIDogXCJcIjtcblx0XHRsaW5lcy5wdXNoKGAtICR7c2V2fSAobGluZSAke2xpbmV9KTogJHtkLm1lc3NhZ2V9JHtzb3VyY2V9YCk7XG5cdH1cblx0cmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxZQUFZLFlBQVk7QUFPakIsU0FBUyx3QkFDZixTQUNBLFFBQ29CO0FBQ3BCLFFBQU0sY0FBYyxPQUFPLEtBQUssc0JBQXNCLGFBQWEsT0FDbEUsU0FDQSxjQUNBLFVBQ0EsVUFDSTtBQUVKLFFBQUksQ0FBQyxPQUFPLGFBQWE7QUFDeEIsZUFBUyxTQUFTLHVCQUF1QjtBQUN6QyxVQUFJO0FBQ0gsY0FBTSxPQUFPLE1BQU07QUFBQSxNQUNwQixTQUFTLEtBQUs7QUFDYixjQUFNLE1BQU0sZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUc7QUFDM0QsaUJBQVMsU0FBUyxrQ0FBa0MsR0FBRztBQUFBO0FBQUEsMEVBQStFO0FBQ3RJO0FBQUEsTUFDRDtBQUFBLElBQ0Q7QUFHQSxRQUFJLFVBQVUsUUFBUSxPQUFPLEtBQUs7QUFDbEMsUUFBSSxDQUFDLFNBQVM7QUFDYixlQUFTLFNBQVMsMkJBQTJCO0FBQzdDO0FBQUEsSUFDRDtBQUVBLFVBQU0sY0FBYyxNQUFNLGlCQUFpQixPQUFPO0FBQ2xELFFBQUksYUFBYTtBQUNoQixnQkFBVSxHQUFHLFdBQVc7QUFBQTtBQUFBLEVBQU8sT0FBTztBQUFBLElBQ3ZDO0FBR0EsVUFBTSxtQkFBbUIsb0JBQW9CO0FBQzdDLFFBQUksa0JBQWtCO0FBQ3JCLGdCQUFVLEdBQUcsZ0JBQWdCO0FBQUE7QUFBQSxFQUFPLE9B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
