import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import * as client from "./ollama-client.js";
import { discoverModels, formatModelForDisplay } from "./ollama-discovery.js";
import { formatModelSize } from "./model-capabilities.js";
function registerOllamaTool(pi) {
  pi.registerTool({
    name: "ollama_manage",
    label: "Ollama",
    description: "Manage local Ollama models. List available models, pull new ones, check Ollama status, or see running models and resource usage. Use this when you need a specific local model that isn't available yet.",
    promptSnippet: "Manage local Ollama models (list, pull, status, ps)",
    promptGuidelines: [
      "Use 'list' to see what models are available locally before trying to use one.",
      "Use 'pull' to download a model that isn't available yet.",
      "Use 'remove' to delete a local model that is no longer needed.",
      "Use 'show' to get detailed info about a model (parameters, quantization, families).",
      "Use 'status' to check if Ollama is running.",
      "Use 'ps' to see which models are loaded in memory and VRAM usage.",
      "Common models: llama3.1:8b, qwen2.5-coder:7b, deepseek-r1:8b, codestral:22b"
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("list"),
          Type.Literal("pull"),
          Type.Literal("remove"),
          Type.Literal("show"),
          Type.Literal("status"),
          Type.Literal("ps")
        ],
        { description: "Action to perform" }
      ),
      model: Type.Optional(
        Type.String({ description: "Model name (required for pull)" })
      )
    }),
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const startTime = Date.now();
      const { action, model } = params;
      try {
        switch (action) {
          case "status": {
            const running = await client.isRunning();
            if (!running) {
              return {
                content: [{ type: "text", text: "Ollama is not running. It needs to be started with 'ollama serve'." }],
                details: { action, durationMs: Date.now() - startTime }
              };
            }
            const version = await client.getVersion();
            return {
              content: [{ type: "text", text: `Ollama${version ? ` v${version}` : ""} is running at ${client.getOllamaHost()}` }],
              details: { action, durationMs: Date.now() - startTime }
            };
          }
          case "list": {
            const running = await client.isRunning();
            if (!running) {
              return {
                content: [{ type: "text", text: "Ollama is not running." }],
                isError: true,
                details: { action, durationMs: Date.now() - startTime, error: "not_running" }
              };
            }
            const models = await discoverModels();
            if (models.length === 0) {
              return {
                content: [{ type: "text", text: "No models available. Pull one with action='pull'." }],
                details: { action, modelCount: 0, durationMs: Date.now() - startTime }
              };
            }
            const lines = models.map((m) => formatModelForDisplay(m));
            return {
              content: [{ type: "text", text: `Available models:
${lines.join("\n")}` }],
              details: { action, modelCount: models.length, durationMs: Date.now() - startTime }
            };
          }
          case "pull": {
            if (!model) {
              return {
                content: [{ type: "text", text: "Error: 'model' parameter is required for pull action." }],
                isError: true,
                details: { action, durationMs: Date.now() - startTime, error: "missing_model" }
              };
            }
            const running = await client.isRunning();
            if (!running) {
              return {
                content: [{ type: "text", text: "Ollama is not running." }],
                isError: true,
                details: { action, model, durationMs: Date.now() - startTime, error: "not_running" }
              };
            }
            let lastStatus = "";
            await client.pullModel(model, (progress) => {
              if (progress.total && progress.completed) {
                const pct = Math.floor(progress.completed / progress.total * 100);
                const status = `Pulling ${model}... ${pct}%`;
                if (status !== lastStatus) {
                  lastStatus = status;
                  onUpdate?.({ content: [{ type: "text", text: status }], details: { action, model, durationMs: Date.now() - startTime } });
                }
              } else if (progress.status && progress.status !== lastStatus) {
                lastStatus = progress.status;
                onUpdate?.({ content: [{ type: "text", text: `${model}: ${progress.status}` }], details: { action, model, durationMs: Date.now() - startTime } });
              }
            }, signal);
            return {
              content: [{ type: "text", text: `Successfully pulled ${model}` }],
              details: { action, model, durationMs: Date.now() - startTime }
            };
          }
          case "ps": {
            const running = await client.isRunning();
            if (!running) {
              return {
                content: [{ type: "text", text: "Ollama is not running." }],
                isError: true,
                details: { action, durationMs: Date.now() - startTime, error: "not_running" }
              };
            }
            const ps = await client.getRunningModels();
            if (!ps.models || ps.models.length === 0) {
              return {
                content: [{ type: "text", text: "No models currently loaded in memory." }],
                details: { action, modelCount: 0, durationMs: Date.now() - startTime }
              };
            }
            const lines = ps.models.map((m) => {
              const vram = m.size_vram > 0 ? `${formatModelSize(m.size_vram)} VRAM` : "CPU";
              return `${m.name} \u2014 ${formatModelSize(m.size)} total, ${vram}`;
            });
            return {
              content: [{ type: "text", text: `Loaded models:
${lines.join("\n")}` }],
              details: { action, modelCount: ps.models.length, durationMs: Date.now() - startTime }
            };
          }
          case "remove": {
            if (!model) {
              return {
                content: [{ type: "text", text: "Error: 'model' parameter is required for remove action." }],
                isError: true,
                details: { action, durationMs: Date.now() - startTime, error: "missing_model" }
              };
            }
            const running = await client.isRunning();
            if (!running) {
              return {
                content: [{ type: "text", text: "Ollama is not running." }],
                isError: true,
                details: { action, model, durationMs: Date.now() - startTime, error: "not_running" }
              };
            }
            await client.deleteModel(model);
            return {
              content: [{ type: "text", text: `Successfully removed ${model}` }],
              details: { action, model, durationMs: Date.now() - startTime }
            };
          }
          case "show": {
            if (!model) {
              return {
                content: [{ type: "text", text: "Error: 'model' parameter is required for show action." }],
                isError: true,
                details: { action, durationMs: Date.now() - startTime, error: "missing_model" }
              };
            }
            const running = await client.isRunning();
            if (!running) {
              return {
                content: [{ type: "text", text: "Ollama is not running." }],
                isError: true,
                details: { action, model, durationMs: Date.now() - startTime, error: "not_running" }
              };
            }
            const info = await client.showModel(model);
            const details = info.details;
            const infoLines = [
              `Model: ${model}`,
              `Family: ${details.family}`,
              `Parameters: ${details.parameter_size}`,
              `Quantization: ${details.quantization_level}`,
              `Format: ${details.format}`
            ];
            if (details.families?.length) {
              infoLines.push(`Families: ${details.families.join(", ")}`);
            }
            if (info.parameters) {
              infoLines.push(`
Modelfile parameters:
${info.parameters}`);
            }
            return {
              content: [{ type: "text", text: infoLines.join("\n") }],
              details: { action, model, durationMs: Date.now() - startTime }
            };
          }
          default:
            return {
              content: [{ type: "text", text: `Unknown action: ${action}` }],
              isError: true,
              details: { action, durationMs: Date.now() - startTime, error: "unknown_action" }
            };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Ollama error: ${msg}` }],
          isError: true,
          details: { action, model, durationMs: Date.now() - startTime, error: msg }
        };
      }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("ollama "));
      text += theme.fg("accent", args.action);
      if (args.model) {
        text += theme.fg("dim", ` ${args.model}`);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme) {
      const d = result.details;
      if (isPartial) return new Text(theme.fg("warning", "Working..."), 0, 0);
      if (result.isError || d?.error) {
        return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
      }
      let text = theme.fg("success", d?.action ?? "done");
      if (d?.modelCount !== void 0) {
        text += theme.fg("dim", ` (${d.modelCount} models)`);
      }
      text += theme.fg("dim", ` ${d?.durationMs ?? 0}ms`);
      if (expanded) {
        const content = result.content[0];
        if (content?.type === "text") {
          const preview = content.text.split("\n").slice(0, 10).join("\n");
          text += "\n\n" + theme.fg("dim", preview);
        }
      }
      return new Text(text, 0, 0);
    }
  });
}
export {
  registerOllamaTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL29sbGFtYS9vbGxhbWEtdG9vbC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEMiBcdTIwMTQgTExNLWNhbGxhYmxlIE9sbGFtYSBtYW5hZ2VtZW50IHRvb2xcbi8qKlxuICogUmVnaXN0ZXJzIGFuIG9sbGFtYV9tYW5hZ2UgdG9vbCB0aGF0IHRoZSBMTE0gY2FuIGNhbGwgdG8gaW50ZXJhY3RcbiAqIHdpdGggdGhlIGxvY2FsIE9sbGFtYSBpbnN0YW5jZSBcdTIwMTQgbGlzdCBtb2RlbHMsIHB1bGwgbmV3IG9uZXMsIGNoZWNrIHN0YXR1cy5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgVGV4dCB9IGZyb20gXCJAZ3NkL3BpLXR1aVwiO1xuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0ICogYXMgY2xpZW50IGZyb20gXCIuL29sbGFtYS1jbGllbnQuanNcIjtcbmltcG9ydCB7IGRpc2NvdmVyTW9kZWxzLCBmb3JtYXRNb2RlbEZvckRpc3BsYXkgfSBmcm9tIFwiLi9vbGxhbWEtZGlzY292ZXJ5LmpzXCI7XG5pbXBvcnQgeyBmb3JtYXRNb2RlbFNpemUgfSBmcm9tIFwiLi9tb2RlbC1jYXBhYmlsaXRpZXMuanNcIjtcblxuaW50ZXJmYWNlIE9sbGFtYVRvb2xEZXRhaWxzIHtcblx0YWN0aW9uOiBzdHJpbmc7XG5cdG1vZGVsPzogc3RyaW5nO1xuXHRtb2RlbENvdW50PzogbnVtYmVyO1xuXHRkdXJhdGlvbk1zOiBudW1iZXI7XG5cdGVycm9yPzogc3RyaW5nO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJPbGxhbWFUb29sKHBpOiBFeHRlbnNpb25BUEkpOiB2b2lkIHtcblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcIm9sbGFtYV9tYW5hZ2VcIixcblx0XHRsYWJlbDogXCJPbGxhbWFcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiTWFuYWdlIGxvY2FsIE9sbGFtYSBtb2RlbHMuIExpc3QgYXZhaWxhYmxlIG1vZGVscywgcHVsbCBuZXcgb25lcywgXCIgK1xuXHRcdFx0XCJjaGVjayBPbGxhbWEgc3RhdHVzLCBvciBzZWUgcnVubmluZyBtb2RlbHMgYW5kIHJlc291cmNlIHVzYWdlLiBcIiArXG5cdFx0XHRcIlVzZSB0aGlzIHdoZW4geW91IG5lZWQgYSBzcGVjaWZpYyBsb2NhbCBtb2RlbCB0aGF0IGlzbid0IGF2YWlsYWJsZSB5ZXQuXCIsXG5cdFx0cHJvbXB0U25pcHBldDogXCJNYW5hZ2UgbG9jYWwgT2xsYW1hIG1vZGVscyAobGlzdCwgcHVsbCwgc3RhdHVzLCBwcylcIixcblx0XHRwcm9tcHRHdWlkZWxpbmVzOiBbXG5cdFx0XHRcIlVzZSAnbGlzdCcgdG8gc2VlIHdoYXQgbW9kZWxzIGFyZSBhdmFpbGFibGUgbG9jYWxseSBiZWZvcmUgdHJ5aW5nIHRvIHVzZSBvbmUuXCIsXG5cdFx0XHRcIlVzZSAncHVsbCcgdG8gZG93bmxvYWQgYSBtb2RlbCB0aGF0IGlzbid0IGF2YWlsYWJsZSB5ZXQuXCIsXG5cdFx0XHRcIlVzZSAncmVtb3ZlJyB0byBkZWxldGUgYSBsb2NhbCBtb2RlbCB0aGF0IGlzIG5vIGxvbmdlciBuZWVkZWQuXCIsXG5cdFx0XHRcIlVzZSAnc2hvdycgdG8gZ2V0IGRldGFpbGVkIGluZm8gYWJvdXQgYSBtb2RlbCAocGFyYW1ldGVycywgcXVhbnRpemF0aW9uLCBmYW1pbGllcykuXCIsXG5cdFx0XHRcIlVzZSAnc3RhdHVzJyB0byBjaGVjayBpZiBPbGxhbWEgaXMgcnVubmluZy5cIixcblx0XHRcdFwiVXNlICdwcycgdG8gc2VlIHdoaWNoIG1vZGVscyBhcmUgbG9hZGVkIGluIG1lbW9yeSBhbmQgVlJBTSB1c2FnZS5cIixcblx0XHRcdFwiQ29tbW9uIG1vZGVsczogbGxhbWEzLjE6OGIsIHF3ZW4yLjUtY29kZXI6N2IsIGRlZXBzZWVrLXIxOjhiLCBjb2Rlc3RyYWw6MjJiXCIsXG5cdFx0XSxcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRhY3Rpb246IFR5cGUuVW5pb24oXG5cdFx0XHRcdFtcblx0XHRcdFx0XHRUeXBlLkxpdGVyYWwoXCJsaXN0XCIpLFxuXHRcdFx0XHRcdFR5cGUuTGl0ZXJhbChcInB1bGxcIiksXG5cdFx0XHRcdFx0VHlwZS5MaXRlcmFsKFwicmVtb3ZlXCIpLFxuXHRcdFx0XHRcdFR5cGUuTGl0ZXJhbChcInNob3dcIiksXG5cdFx0XHRcdFx0VHlwZS5MaXRlcmFsKFwic3RhdHVzXCIpLFxuXHRcdFx0XHRcdFR5cGUuTGl0ZXJhbChcInBzXCIpLFxuXHRcdFx0XHRdLFxuXHRcdFx0XHR7IGRlc2NyaXB0aW9uOiBcIkFjdGlvbiB0byBwZXJmb3JtXCIgfSxcblx0XHRcdCksXG5cdFx0XHRtb2RlbDogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJNb2RlbCBuYW1lIChyZXF1aXJlZCBmb3IgcHVsbClcIiB9KSxcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIHNpZ25hbCwgb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG5cdFx0XHRjb25zdCB7IGFjdGlvbiwgbW9kZWwgfSA9IHBhcmFtcztcblxuXHRcdFx0dHJ5IHtcblx0XHRcdFx0c3dpdGNoIChhY3Rpb24pIHtcblx0XHRcdFx0XHRjYXNlIFwic3RhdHVzXCI6IHtcblx0XHRcdFx0XHRcdGNvbnN0IHJ1bm5pbmcgPSBhd2FpdCBjbGllbnQuaXNSdW5uaW5nKCk7XG5cdFx0XHRcdFx0XHRpZiAoIXJ1bm5pbmcpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJPbGxhbWEgaXMgbm90IHJ1bm5pbmcuIEl0IG5lZWRzIHRvIGJlIHN0YXJ0ZWQgd2l0aCAnb2xsYW1hIHNlcnZlJy5cIiB9XSxcblx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbiwgZHVyYXRpb25NczogRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSB9IGFzIE9sbGFtYVRvb2xEZXRhaWxzLFxuXHRcdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0Y29uc3QgdmVyc2lvbiA9IGF3YWl0IGNsaWVudC5nZXRWZXJzaW9uKCk7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYE9sbGFtYSR7dmVyc2lvbiA/IGAgdiR7dmVyc2lvbn1gIDogXCJcIn0gaXMgcnVubmluZyBhdCAke2NsaWVudC5nZXRPbGxhbWFIb3N0KCl9YCB9XSxcblx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb24sIGR1cmF0aW9uTXM6IERhdGUubm93KCkgLSBzdGFydFRpbWUgfSBhcyBPbGxhbWFUb29sRGV0YWlscyxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y2FzZSBcImxpc3RcIjoge1xuXHRcdFx0XHRcdFx0Y29uc3QgcnVubmluZyA9IGF3YWl0IGNsaWVudC5pc1J1bm5pbmcoKTtcblx0XHRcdFx0XHRcdGlmICghcnVubmluZykge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIk9sbGFtYSBpcyBub3QgcnVubmluZy5cIiB9XSxcblx0XHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aW9uLCBkdXJhdGlvbk1zOiBEYXRlLm5vdygpIC0gc3RhcnRUaW1lLCBlcnJvcjogXCJub3RfcnVubmluZ1wiIH0gYXMgT2xsYW1hVG9vbERldGFpbHMsXG5cdFx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGNvbnN0IG1vZGVscyA9IGF3YWl0IGRpc2NvdmVyTW9kZWxzKCk7XG5cdFx0XHRcdFx0XHRpZiAobW9kZWxzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIk5vIG1vZGVscyBhdmFpbGFibGUuIFB1bGwgb25lIHdpdGggYWN0aW9uPSdwdWxsJy5cIiB9XSxcblx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbiwgbW9kZWxDb3VudDogMCwgZHVyYXRpb25NczogRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSB9IGFzIE9sbGFtYVRvb2xEZXRhaWxzLFxuXHRcdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRjb25zdCBsaW5lcyA9IG1vZGVscy5tYXAoKG0pID0+IGZvcm1hdE1vZGVsRm9yRGlzcGxheShtKSk7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEF2YWlsYWJsZSBtb2RlbHM6XFxuJHtsaW5lcy5qb2luKFwiXFxuXCIpfWAgfV0sXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aW9uLCBtb2RlbENvdW50OiBtb2RlbHMubGVuZ3RoLCBkdXJhdGlvbk1zOiBEYXRlLm5vdygpIC0gc3RhcnRUaW1lIH0gYXMgT2xsYW1hVG9vbERldGFpbHMsXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNhc2UgXCJwdWxsXCI6IHtcblx0XHRcdFx0XHRcdGlmICghbW9kZWwpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJFcnJvcjogJ21vZGVsJyBwYXJhbWV0ZXIgaXMgcmVxdWlyZWQgZm9yIHB1bGwgYWN0aW9uLlwiIH1dLFxuXHRcdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb24sIGR1cmF0aW9uTXM6IERhdGUubm93KCkgLSBzdGFydFRpbWUsIGVycm9yOiBcIm1pc3NpbmdfbW9kZWxcIiB9IGFzIE9sbGFtYVRvb2xEZXRhaWxzLFxuXHRcdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRjb25zdCBydW5uaW5nID0gYXdhaXQgY2xpZW50LmlzUnVubmluZygpO1xuXHRcdFx0XHRcdFx0aWYgKCFydW5uaW5nKSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiT2xsYW1hIGlzIG5vdCBydW5uaW5nLlwiIH1dLFxuXHRcdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb24sIG1vZGVsLCBkdXJhdGlvbk1zOiBEYXRlLm5vdygpIC0gc3RhcnRUaW1lLCBlcnJvcjogXCJub3RfcnVubmluZ1wiIH0gYXMgT2xsYW1hVG9vbERldGFpbHMsXG5cdFx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGxldCBsYXN0U3RhdHVzID0gXCJcIjtcblx0XHRcdFx0XHRcdGF3YWl0IGNsaWVudC5wdWxsTW9kZWwobW9kZWwsIChwcm9ncmVzcykgPT4ge1xuXHRcdFx0XHRcdFx0XHRpZiAocHJvZ3Jlc3MudG90YWwgJiYgcHJvZ3Jlc3MuY29tcGxldGVkKSB7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgcGN0ID0gTWF0aC5mbG9vcigocHJvZ3Jlc3MuY29tcGxldGVkIC8gcHJvZ3Jlc3MudG90YWwpICogMTAwKTtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBzdGF0dXMgPSBgUHVsbGluZyAke21vZGVsfS4uLiAke3BjdH0lYDtcblx0XHRcdFx0XHRcdFx0XHRpZiAoc3RhdHVzICE9PSBsYXN0U3RhdHVzKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRsYXN0U3RhdHVzID0gc3RhdHVzO1xuXHRcdFx0XHRcdFx0XHRcdFx0b25VcGRhdGU/Lih7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBzdGF0dXMgfV0sIGRldGFpbHM6IHsgYWN0aW9uLCBtb2RlbCwgZHVyYXRpb25NczogRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSB9IGFzIE9sbGFtYVRvb2xEZXRhaWxzIH0pO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0fSBlbHNlIGlmIChwcm9ncmVzcy5zdGF0dXMgJiYgcHJvZ3Jlc3Muc3RhdHVzICE9PSBsYXN0U3RhdHVzKSB7XG5cdFx0XHRcdFx0XHRcdFx0bGFzdFN0YXR1cyA9IHByb2dyZXNzLnN0YXR1cztcblx0XHRcdFx0XHRcdFx0XHRvblVwZGF0ZT8uKHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGAke21vZGVsfTogJHtwcm9ncmVzcy5zdGF0dXN9YCB9XSwgZGV0YWlsczogeyBhY3Rpb24sIG1vZGVsLCBkdXJhdGlvbk1zOiBEYXRlLm5vdygpIC0gc3RhcnRUaW1lIH0gYXMgT2xsYW1hVG9vbERldGFpbHMgfSk7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH0sIHNpZ25hbCk7XG5cblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgU3VjY2Vzc2Z1bGx5IHB1bGxlZCAke21vZGVsfWAgfV0sXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aW9uLCBtb2RlbCwgZHVyYXRpb25NczogRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSB9IGFzIE9sbGFtYVRvb2xEZXRhaWxzLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjYXNlIFwicHNcIjoge1xuXHRcdFx0XHRcdFx0Y29uc3QgcnVubmluZyA9IGF3YWl0IGNsaWVudC5pc1J1bm5pbmcoKTtcblx0XHRcdFx0XHRcdGlmICghcnVubmluZykge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIk9sbGFtYSBpcyBub3QgcnVubmluZy5cIiB9XSxcblx0XHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aW9uLCBkdXJhdGlvbk1zOiBEYXRlLm5vdygpIC0gc3RhcnRUaW1lLCBlcnJvcjogXCJub3RfcnVubmluZ1wiIH0gYXMgT2xsYW1hVG9vbERldGFpbHMsXG5cdFx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGNvbnN0IHBzID0gYXdhaXQgY2xpZW50LmdldFJ1bm5pbmdNb2RlbHMoKTtcblx0XHRcdFx0XHRcdGlmICghcHMubW9kZWxzIHx8IHBzLm1vZGVscy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJObyBtb2RlbHMgY3VycmVudGx5IGxvYWRlZCBpbiBtZW1vcnkuXCIgfV0sXG5cdFx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb24sIG1vZGVsQ291bnQ6IDAsIGR1cmF0aW9uTXM6IERhdGUubm93KCkgLSBzdGFydFRpbWUgfSBhcyBPbGxhbWFUb29sRGV0YWlscyxcblx0XHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Y29uc3QgbGluZXMgPSBwcy5tb2RlbHMubWFwKChtKSA9PiB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IHZyYW0gPSBtLnNpemVfdnJhbSA+IDAgPyBgJHtmb3JtYXRNb2RlbFNpemUobS5zaXplX3ZyYW0pfSBWUkFNYCA6IFwiQ1BVXCI7XG5cdFx0XHRcdFx0XHRcdHJldHVybiBgJHttLm5hbWV9IFx1MjAxNCAke2Zvcm1hdE1vZGVsU2l6ZShtLnNpemUpfSB0b3RhbCwgJHt2cmFtfWA7XG5cdFx0XHRcdFx0XHR9KTtcblxuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBMb2FkZWQgbW9kZWxzOlxcbiR7bGluZXMuam9pbihcIlxcblwiKX1gIH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbiwgbW9kZWxDb3VudDogcHMubW9kZWxzLmxlbmd0aCwgZHVyYXRpb25NczogRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSB9IGFzIE9sbGFtYVRvb2xEZXRhaWxzLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjYXNlIFwicmVtb3ZlXCI6IHtcblx0XHRcdFx0XHRcdGlmICghbW9kZWwpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJFcnJvcjogJ21vZGVsJyBwYXJhbWV0ZXIgaXMgcmVxdWlyZWQgZm9yIHJlbW92ZSBhY3Rpb24uXCIgfV0sXG5cdFx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbiwgZHVyYXRpb25NczogRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSwgZXJyb3I6IFwibWlzc2luZ19tb2RlbFwiIH0gYXMgT2xsYW1hVG9vbERldGFpbHMsXG5cdFx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGNvbnN0IHJ1bm5pbmcgPSBhd2FpdCBjbGllbnQuaXNSdW5uaW5nKCk7XG5cdFx0XHRcdFx0XHRpZiAoIXJ1bm5pbmcpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJPbGxhbWEgaXMgbm90IHJ1bm5pbmcuXCIgfV0sXG5cdFx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbiwgbW9kZWwsIGR1cmF0aW9uTXM6IERhdGUubm93KCkgLSBzdGFydFRpbWUsIGVycm9yOiBcIm5vdF9ydW5uaW5nXCIgfSBhcyBPbGxhbWFUb29sRGV0YWlscyxcblx0XHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0YXdhaXQgY2xpZW50LmRlbGV0ZU1vZGVsKG1vZGVsKTtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgU3VjY2Vzc2Z1bGx5IHJlbW92ZWQgJHttb2RlbH1gIH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbiwgbW9kZWwsIGR1cmF0aW9uTXM6IERhdGUubm93KCkgLSBzdGFydFRpbWUgfSBhcyBPbGxhbWFUb29sRGV0YWlscyxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y2FzZSBcInNob3dcIjoge1xuXHRcdFx0XHRcdFx0aWYgKCFtb2RlbCkge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkVycm9yOiAnbW9kZWwnIHBhcmFtZXRlciBpcyByZXF1aXJlZCBmb3Igc2hvdyBhY3Rpb24uXCIgfV0sXG5cdFx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbiwgZHVyYXRpb25NczogRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSwgZXJyb3I6IFwibWlzc2luZ19tb2RlbFwiIH0gYXMgT2xsYW1hVG9vbERldGFpbHMsXG5cdFx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGNvbnN0IHJ1bm5pbmcgPSBhd2FpdCBjbGllbnQuaXNSdW5uaW5nKCk7XG5cdFx0XHRcdFx0XHRpZiAoIXJ1bm5pbmcpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJPbGxhbWEgaXMgbm90IHJ1bm5pbmcuXCIgfV0sXG5cdFx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbiwgbW9kZWwsIGR1cmF0aW9uTXM6IERhdGUubm93KCkgLSBzdGFydFRpbWUsIGVycm9yOiBcIm5vdF9ydW5uaW5nXCIgfSBhcyBPbGxhbWFUb29sRGV0YWlscyxcblx0XHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Y29uc3QgaW5mbyA9IGF3YWl0IGNsaWVudC5zaG93TW9kZWwobW9kZWwpO1xuXHRcdFx0XHRcdFx0Y29uc3QgZGV0YWlscyA9IGluZm8uZGV0YWlscztcblx0XHRcdFx0XHRcdGNvbnN0IGluZm9MaW5lcyA9IFtcblx0XHRcdFx0XHRcdFx0YE1vZGVsOiAke21vZGVsfWAsXG5cdFx0XHRcdFx0XHRcdGBGYW1pbHk6ICR7ZGV0YWlscy5mYW1pbHl9YCxcblx0XHRcdFx0XHRcdFx0YFBhcmFtZXRlcnM6ICR7ZGV0YWlscy5wYXJhbWV0ZXJfc2l6ZX1gLFxuXHRcdFx0XHRcdFx0XHRgUXVhbnRpemF0aW9uOiAke2RldGFpbHMucXVhbnRpemF0aW9uX2xldmVsfWAsXG5cdFx0XHRcdFx0XHRcdGBGb3JtYXQ6ICR7ZGV0YWlscy5mb3JtYXR9YCxcblx0XHRcdFx0XHRcdF07XG5cdFx0XHRcdFx0XHRpZiAoZGV0YWlscy5mYW1pbGllcz8ubGVuZ3RoKSB7XG5cdFx0XHRcdFx0XHRcdGluZm9MaW5lcy5wdXNoKGBGYW1pbGllczogJHtkZXRhaWxzLmZhbWlsaWVzLmpvaW4oXCIsIFwiKX1gKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGlmIChpbmZvLnBhcmFtZXRlcnMpIHtcblx0XHRcdFx0XHRcdFx0aW5mb0xpbmVzLnB1c2goYFxcbk1vZGVsZmlsZSBwYXJhbWV0ZXJzOlxcbiR7aW5mby5wYXJhbWV0ZXJzfWApO1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogaW5mb0xpbmVzLmpvaW4oXCJcXG5cIikgfV0sXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aW9uLCBtb2RlbCwgZHVyYXRpb25NczogRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSB9IGFzIE9sbGFtYVRvb2xEZXRhaWxzLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRkZWZhdWx0OlxuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBVbmtub3duIGFjdGlvbjogJHthY3Rpb259YCB9XSxcblx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb24sIGR1cmF0aW9uTXM6IERhdGUubm93KCkgLSBzdGFydFRpbWUsIGVycm9yOiBcInVua25vd25fYWN0aW9uXCIgfSBhcyBPbGxhbWFUb29sRGV0YWlscyxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBPbGxhbWEgZXJyb3I6ICR7bXNnfWAgfV0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbiwgbW9kZWwsIGR1cmF0aW9uTXM6IERhdGUubm93KCkgLSBzdGFydFRpbWUsIGVycm9yOiBtc2cgfSBhcyBPbGxhbWFUb29sRGV0YWlscyxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXG5cdFx0cmVuZGVyQ2FsbChhcmdzLCB0aGVtZSkge1xuXHRcdFx0bGV0IHRleHQgPSB0aGVtZS5mZyhcInRvb2xUaXRsZVwiLCB0aGVtZS5ib2xkKFwib2xsYW1hIFwiKSk7XG5cdFx0XHR0ZXh0ICs9IHRoZW1lLmZnKFwiYWNjZW50XCIsIGFyZ3MuYWN0aW9uKTtcblx0XHRcdGlmIChhcmdzLm1vZGVsKSB7XG5cdFx0XHRcdHRleHQgKz0gdGhlbWUuZmcoXCJkaW1cIiwgYCAke2FyZ3MubW9kZWx9YCk7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7XG5cdFx0fSxcblxuXHRcdHJlbmRlclJlc3VsdChyZXN1bHQsIHsgaXNQYXJ0aWFsLCBleHBhbmRlZCB9LCB0aGVtZSkge1xuXHRcdFx0Y29uc3QgZCA9IHJlc3VsdC5kZXRhaWxzIGFzIE9sbGFtYVRvb2xEZXRhaWxzIHwgdW5kZWZpbmVkO1xuXG5cdFx0XHRpZiAoaXNQYXJ0aWFsKSByZXR1cm4gbmV3IFRleHQodGhlbWUuZmcoXCJ3YXJuaW5nXCIsIFwiV29ya2luZy4uLlwiKSwgMCwgMCk7XG5cdFx0XHRpZiAoKHJlc3VsdCBhcyBhbnkpLmlzRXJyb3IgfHwgZD8uZXJyb3IpIHtcblx0XHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRoZW1lLmZnKFwiZXJyb3JcIiwgYEVycm9yOiAke2Q/LmVycm9yID8/IFwidW5rbm93blwifWApLCAwLCAwKTtcblx0XHRcdH1cblxuXHRcdFx0bGV0IHRleHQgPSB0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgZD8uYWN0aW9uID8/IFwiZG9uZVwiKTtcblx0XHRcdGlmIChkPy5tb2RlbENvdW50ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0dGV4dCArPSB0aGVtZS5mZyhcImRpbVwiLCBgICgke2QubW9kZWxDb3VudH0gbW9kZWxzKWApO1xuXHRcdFx0fVxuXHRcdFx0dGV4dCArPSB0aGVtZS5mZyhcImRpbVwiLCBgICR7ZD8uZHVyYXRpb25NcyA/PyAwfW1zYCk7XG5cblx0XHRcdGlmIChleHBhbmRlZCkge1xuXHRcdFx0XHRjb25zdCBjb250ZW50ID0gcmVzdWx0LmNvbnRlbnRbMF07XG5cdFx0XHRcdGlmIChjb250ZW50Py50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHRcdGNvbnN0IHByZXZpZXcgPSBjb250ZW50LnRleHQuc3BsaXQoXCJcXG5cIikuc2xpY2UoMCwgMTApLmpvaW4oXCJcXG5cIik7XG5cdFx0XHRcdFx0dGV4dCArPSBcIlxcblxcblwiICsgdGhlbWUuZmcoXCJkaW1cIiwgcHJldmlldyk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuXHRcdH0sXG5cdH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBT0EsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsWUFBWTtBQUNyQixZQUFZLFlBQVk7QUFDeEIsU0FBUyxnQkFBZ0IsNkJBQTZCO0FBQ3RELFNBQVMsdUJBQXVCO0FBVXpCLFNBQVMsbUJBQW1CLElBQXdCO0FBQzFELEtBQUcsYUFBYTtBQUFBLElBQ2YsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDQztBQUFBLElBR0QsZUFBZTtBQUFBLElBQ2Ysa0JBQWtCO0FBQUEsTUFDakI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBQUEsSUFDQSxZQUFZLEtBQUssT0FBTztBQUFBLE1BQ3ZCLFFBQVEsS0FBSztBQUFBLFFBQ1o7QUFBQSxVQUNDLEtBQUssUUFBUSxNQUFNO0FBQUEsVUFDbkIsS0FBSyxRQUFRLE1B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
