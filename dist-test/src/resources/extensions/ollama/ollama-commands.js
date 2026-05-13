import { Text } from "@gsd/pi-tui";
import * as client from "./ollama-client.js";
import { discoverModels, formatModelForDisplay } from "./ollama-discovery.js";
import { formatModelSize } from "./model-capabilities.js";
function registerOllamaCommands(pi) {
  pi.registerCommand("ollama", {
    description: "Manage local Ollama models \u2014 list | pull | remove | ps",
    async handler(args, ctx) {
      const parts = (args ?? "").trim().split(/\s+/);
      const subcommand = parts[0] || "status";
      const modelArg = parts.slice(1).join(" ");
      switch (subcommand) {
        case "status":
          return await handleStatus(ctx);
        case "list":
        case "ls":
          return await handleList(ctx);
        case "pull":
          return await handlePull(modelArg, ctx);
        case "remove":
        case "rm":
        case "delete":
          return await handleRemove(modelArg, ctx);
        case "ps":
          return await handlePs(ctx);
        default:
          ctx.ui.notify(
            `Unknown subcommand: ${subcommand}. Use: status, list, pull, remove, ps`,
            "warning"
          );
      }
    }
  });
}
async function handleStatus(ctx) {
  const running = await client.isRunning();
  if (!running) {
    ctx.ui.notify(
      "Ollama is not running. Install from https://ollama.com and run 'ollama serve'",
      "warning"
    );
    return;
  }
  const version = await client.getVersion();
  const lines = [];
  lines.push(`Ollama${version ? ` v${version}` : ""} \u2014 running (${client.getOllamaHost()})`);
  try {
    const ps = await client.getRunningModels();
    if (ps.models && ps.models.length > 0) {
      lines.push("");
      lines.push("Loaded:");
      for (const m of ps.models) {
        const vram = m.size_vram > 0 ? formatModelSize(m.size_vram) + " VRAM" : "CPU";
        const expiresAt = new Date(m.expires_at);
        const idleMs = expiresAt.getTime() - Date.now();
        const idleMin = Math.max(0, Math.floor(idleMs / 6e4));
        lines.push(`  ${m.name}  ${vram}  expires in ${idleMin}m`);
      }
    }
  } catch {
  }
  try {
    const models = await discoverModels();
    if (models.length > 0) {
      lines.push("");
      lines.push("Available:");
      for (const m of models) {
        lines.push(`  ${formatModelForDisplay(m)}`);
      }
    } else {
      lines.push("");
      lines.push("No models pulled. Use /ollama pull <model> to get started.");
    }
  } catch (err) {
    lines.push("");
    lines.push(`Error listing models: ${err instanceof Error ? err.message : String(err)}`);
  }
  await ctx.ui.custom(
    (tui, theme, _kb, done) => {
      const text = new Text(lines.map((l) => theme.fg("fg", l)).join("\n"), 0, 0);
      setTimeout(() => done(void 0), 0);
      return text;
    }
  );
}
async function handleList(ctx) {
  const running = await client.isRunning();
  if (!running) {
    ctx.ui.notify("Ollama is not running", "warning");
    return;
  }
  const models = await discoverModels();
  if (models.length === 0) {
    ctx.ui.notify("No models available. Use /ollama pull <model> to download one.", "info");
    return;
  }
  const lines = ["Local Ollama models:", ""];
  for (const m of models) {
    lines.push(`  ${formatModelForDisplay(m)}`);
  }
  await ctx.ui.custom(
    (tui, theme, _kb, done) => {
      const text = new Text(lines.map((l) => theme.fg("fg", l)).join("\n"), 0, 0);
      setTimeout(() => done(void 0), 0);
      return text;
    }
  );
}
async function handlePull(modelName, ctx) {
  if (!modelName) {
    ctx.ui.notify("Usage: /ollama pull <model> (e.g. /ollama pull llama3.1:8b)", "warning");
    return;
  }
  const running = await client.isRunning();
  if (!running) {
    ctx.ui.notify("Ollama is not running", "warning");
    return;
  }
  ctx.ui.setWidget("ollama-pull", [`Pulling ${modelName}...`]);
  try {
    let lastPercent = -1;
    await client.pullModel(modelName, (progress) => {
      if (progress.total && progress.completed) {
        const percent = Math.floor(progress.completed / progress.total * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          const completed = formatModelSize(progress.completed);
          const total = formatModelSize(progress.total);
          ctx.ui.setWidget("ollama-pull", [
            `Pulling ${modelName}... ${percent}% (${completed} / ${total})`
          ]);
        }
      } else if (progress.status) {
        ctx.ui.setWidget("ollama-pull", [`${modelName}: ${progress.status}`]);
      }
    });
    ctx.ui.setWidget("ollama-pull", void 0);
    ctx.ui.notify(`${modelName} pulled successfully`, "success");
  } catch (err) {
    ctx.ui.setWidget("ollama-pull", void 0);
    ctx.ui.notify(
      `Failed to pull ${modelName}: ${err instanceof Error ? err.message : String(err)}`,
      "error"
    );
  }
}
async function handleRemove(modelName, ctx) {
  if (!modelName) {
    ctx.ui.notify("Usage: /ollama remove <model>", "warning");
    return;
  }
  const running = await client.isRunning();
  if (!running) {
    ctx.ui.notify("Ollama is not running", "warning");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    "Delete model",
    `Are you sure you want to delete ${modelName}?`
  );
  if (!confirmed) return;
  try {
    await client.deleteModel(modelName);
    ctx.ui.notify(`${modelName} deleted`, "success");
  } catch (err) {
    ctx.ui.notify(
      `Failed to delete ${modelName}: ${err instanceof Error ? err.message : String(err)}`,
      "error"
    );
  }
}
async function handlePs(ctx) {
  const running = await client.isRunning();
  if (!running) {
    ctx.ui.notify("Ollama is not running", "warning");
    return;
  }
  try {
    const ps = await client.getRunningModels();
    if (!ps.models || ps.models.length === 0) {
      ctx.ui.notify("No models currently loaded in memory", "info");
      return;
    }
    const lines = ["Running models:", ""];
    for (const m of ps.models) {
      const vram = m.size_vram > 0 ? formatModelSize(m.size_vram) + " VRAM" : "CPU only";
      const totalSize = formatModelSize(m.size);
      const expiresAt = new Date(m.expires_at);
      const idleMs = expiresAt.getTime() - Date.now();
      const idleMin = Math.max(0, Math.floor(idleMs / 6e4));
      lines.push(`  ${m.name}  ${totalSize}  ${vram}  expires in ${idleMin}m`);
    }
    await ctx.ui.custom(
      (tui, theme, _kb, done) => {
        const text = new Text(lines.map((l) => theme.fg("fg", l)).join("\n"), 0, 0);
        setTimeout(() => done(void 0), 0);
        return text;
      }
    );
  } catch (err) {
    ctx.ui.notify(
      `Failed to get running models: ${err instanceof Error ? err.message : String(err)}`,
      "error"
    );
  }
}
export {
  registerOllamaCommands
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL29sbGFtYS9vbGxhbWEtY29tbWFuZHMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRDIgXHUyMDE0IE9sbGFtYSBzbGFzaCBjb21tYW5kc1xuXG4vKipcbiAqIFJlZ2lzdGVycyAvb2xsYW1hIHNsYXNoIGNvbW1hbmRzIGZvciBtYW5hZ2luZyBsb2NhbCBPbGxhbWEgbW9kZWxzLlxuICpcbiAqIENvbW1hbmRzOlxuICogICAvb2xsYW1hICAgICAgICAgIFx1MjAxNCBTaG93IHN0YXR1cyAocnVubmluZz8sIHZlcnNpb24sIGxvYWRlZCBtb2RlbHMpXG4gKiAgIC9vbGxhbWEgbGlzdCAgICAgXHUyMDE0IExpc3QgYWxsIGF2YWlsYWJsZSBsb2NhbCBtb2RlbHMgd2l0aCBzaXplc1xuICogICAvb2xsYW1hIHB1bGwgICAgIFx1MjAxNCBQdWxsIGEgbW9kZWwgd2l0aCBwcm9ncmVzc1xuICogICAvb2xsYW1hIHJlbW92ZSAgIFx1MjAxNCBEZWxldGUgYSBsb2NhbCBtb2RlbFxuICogICAvb2xsYW1hIHBzICAgICAgIFx1MjAxNCBTaG93IHJ1bm5pbmcgbW9kZWxzIGFuZCByZXNvdXJjZSB1c2FnZVxuICovXG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBUZXh0IH0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5pbXBvcnQgKiBhcyBjbGllbnQgZnJvbSBcIi4vb2xsYW1hLWNsaWVudC5qc1wiO1xuaW1wb3J0IHsgZGlzY292ZXJNb2RlbHMsIGZvcm1hdE1vZGVsRm9yRGlzcGxheSB9IGZyb20gXCIuL29sbGFtYS1kaXNjb3ZlcnkuanNcIjtcbmltcG9ydCB7IGZvcm1hdE1vZGVsU2l6ZSB9IGZyb20gXCIuL21vZGVsLWNhcGFiaWxpdGllcy5qc1wiO1xuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJPbGxhbWFDb21tYW5kcyhwaTogRXh0ZW5zaW9uQVBJKTogdm9pZCB7XG5cdHBpLnJlZ2lzdGVyQ29tbWFuZChcIm9sbGFtYVwiLCB7XG5cdFx0ZGVzY3JpcHRpb246IFwiTWFuYWdlIGxvY2FsIE9sbGFtYSBtb2RlbHMgXHUyMDE0IGxpc3QgfCBwdWxsIHwgcmVtb3ZlIHwgcHNcIixcblx0XHRhc3luYyBoYW5kbGVyKGFyZ3MsIGN0eCkge1xuXHRcdFx0Y29uc3QgcGFydHMgPSAoYXJncyA/PyBcIlwiKS50cmltKCkuc3BsaXQoL1xccysvKTtcblx0XHRcdGNvbnN0IHN1YmNvbW1hbmQgPSBwYXJ0c1swXSB8fCBcInN0YXR1c1wiO1xuXHRcdFx0Y29uc3QgbW9kZWxBcmcgPSBwYXJ0cy5zbGljZSgxKS5qb2luKFwiIFwiKTtcblxuXHRcdFx0c3dpdGNoIChzdWJjb21tYW5kKSB7XG5cdFx0XHRcdGNhc2UgXCJzdGF0dXNcIjpcblx0XHRcdFx0XHRyZXR1cm4gYXdhaXQgaGFuZGxlU3RhdHVzKGN0eCk7XG5cdFx0XHRcdGNhc2UgXCJsaXN0XCI6XG5cdFx0XHRcdGNhc2UgXCJsc1wiOlxuXHRcdFx0XHRcdHJldHVybiBhd2FpdCBoYW5kbGVMaXN0KGN0eCk7XG5cdFx0XHRcdGNhc2UgXCJwdWxsXCI6XG5cdFx0XHRcdFx0cmV0dXJuIGF3YWl0IGhhbmRsZVB1bGwobW9kZWxBcmcsIGN0eCk7XG5cdFx0XHRcdGNhc2UgXCJyZW1vdmVcIjpcblx0XHRcdFx0Y2FzZSBcInJtXCI6XG5cdFx0XHRcdGNhc2UgXCJkZWxldGVcIjpcblx0XHRcdFx0XHRyZXR1cm4gYXdhaXQgaGFuZGxlUmVtb3ZlKG1vZGVsQXJnLCBjdHgpO1xuXHRcdFx0XHRjYXNlIFwicHNcIjpcblx0XHRcdFx0XHRyZXR1cm4gYXdhaXQgaGFuZGxlUHMoY3R4KTtcblx0XHRcdFx0ZGVmYXVsdDpcblx0XHRcdFx0XHRjdHgudWkubm90aWZ5KFxuXHRcdFx0XHRcdFx0YFVua25vd24gc3ViY29tbWFuZDogJHtzdWJjb21tYW5kfS4gVXNlOiBzdGF0dXMsIGxpc3QsIHB1bGwsIHJlbW92ZSwgcHNgLFxuXHRcdFx0XHRcdFx0XCJ3YXJuaW5nXCIsXG5cdFx0XHRcdFx0KTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlU3RhdHVzKGN0eDogYW55KTogUHJvbWlzZTx2b2lkPiB7XG5cdGNvbnN0IHJ1bm5pbmcgPSBhd2FpdCBjbGllbnQuaXNSdW5uaW5nKCk7XG5cdGlmICghcnVubmluZykge1xuXHRcdGN0eC51aS5ub3RpZnkoXG5cdFx0XHRcIk9sbGFtYSBpcyBub3QgcnVubmluZy4gSW5zdGFsbCBmcm9tIGh0dHBzOi8vb2xsYW1hLmNvbSBhbmQgcnVuICdvbGxhbWEgc2VydmUnXCIsXG5cdFx0XHRcIndhcm5pbmdcIixcblx0XHQpO1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGNvbnN0IHZlcnNpb24gPSBhd2FpdCBjbGllbnQuZ2V0VmVyc2lvbigpO1xuXHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblx0bGluZXMucHVzaChgT2xsYW1hJHt2ZXJzaW9uID8gYCB2JHt2ZXJzaW9ufWAgOiBcIlwifSBcdTIwMTQgcnVubmluZyAoJHtjbGllbnQuZ2V0T2xsYW1hSG9zdCgpfSlgKTtcblxuXHQvLyBTaG93IGxvYWRlZCBtb2RlbHNcblx0dHJ5IHtcblx0XHRjb25zdCBwcyA9IGF3YWl0IGNsaWVudC5nZXRSdW5uaW5nTW9kZWxzKCk7XG5cdFx0aWYgKHBzLm1vZGVscyAmJiBwcy5tb2RlbHMubGVuZ3RoID4gMCkge1xuXHRcdFx0bGluZXMucHVzaChcIlwiKTtcblx0XHRcdGxpbmVzLnB1c2goXCJMb2FkZWQ6XCIpO1xuXHRcdFx0Zm9yIChjb25zdCBtIG9mIHBzLm1vZGVscykge1xuXHRcdFx0XHRjb25zdCB2cmFtID0gbS5zaXplX3ZyYW0gPiAwID8gZm9ybWF0TW9kZWxTaXplKG0uc2l6ZV92cmFtKSArIFwiIFZSQU1cIiA6IFwiQ1BVXCI7XG5cdFx0XHRcdGNvbnN0IGV4cGlyZXNBdCA9IG5ldyBEYXRlKG0uZXhwaXJlc19hdCk7XG5cdFx0XHRcdGNvbnN0IGlkbGVNcyA9IGV4cGlyZXNBdC5nZXRUaW1lKCkgLSBEYXRlLm5vdygpO1xuXHRcdFx0XHRjb25zdCBpZGxlTWluID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcihpZGxlTXMgLyA2MDAwMCkpO1xuXHRcdFx0XHRsaW5lcy5wdXNoKGAgICR7bS5uYW1lfSAgJHt2cmFtfSAgZXhwaXJlcyBpbiAke2lkbGVNaW59bWApO1xuXHRcdFx0fVxuXHRcdH1cblx0fSBjYXRjaCB7XG5cdFx0Ly8gcHMgZW5kcG9pbnQgbWF5IG5vdCBiZSBhdmFpbGFibGUgb24gb2xkZXIgdmVyc2lvbnNcblx0fVxuXG5cdC8vIFNob3cgYXZhaWxhYmxlIG1vZGVsc1xuXHR0cnkge1xuXHRcdGNvbnN0IG1vZGVscyA9IGF3YWl0IGRpc2NvdmVyTW9kZWxzKCk7XG5cdFx0aWYgKG1vZGVscy5sZW5ndGggPiAwKSB7XG5cdFx0XHRsaW5lcy5wdXNoKFwiXCIpO1xuXHRcdFx0bGluZXMucHVzaChcIkF2YWlsYWJsZTpcIik7XG5cdFx0XHRmb3IgKGNvbnN0IG0gb2YgbW9kZWxzKSB7XG5cdFx0XHRcdGxpbmVzLnB1c2goYCAgJHtmb3JtYXRNb2RlbEZvckRpc3BsYXkobSl9YCk7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIHtcblx0XHRcdGxpbmVzLnB1c2goXCJcIik7XG5cdFx0XHRsaW5lcy5wdXNoKFwiTm8gbW9kZWxzIHB1bGxlZC4gVXNlIC9vbGxhbWEgcHVsbCA8bW9kZWw+IHRvIGdldCBzdGFydGVkLlwiKTtcblx0XHR9XG5cdH0gY2F0Y2ggKGVycikge1xuXHRcdGxpbmVzLnB1c2goXCJcIik7XG5cdFx0bGluZXMucHVzaChgRXJyb3IgbGlzdGluZyBtb2RlbHM6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuXHR9XG5cblx0YXdhaXQgY3R4LnVpLmN1c3RvbShcblx0XHQodHVpOiBhbnksIHRoZW1lOiBhbnksIF9rYjogYW55LCBkb25lOiAocjogdW5kZWZpbmVkKSA9PiB2b2lkKSA9PiB7XG5cdFx0XHRjb25zdCB0ZXh0ID0gbmV3IFRleHQobGluZXMubWFwKChsKSA9PiB0aGVtZS5mZyhcImZnXCIsIGwpKS5qb2luKFwiXFxuXCIpLCAwLCAwKTtcblx0XHRcdHNldFRpbWVvdXQoKCkgPT4gZG9uZSh1bmRlZmluZWQpLCAwKTtcblx0XHRcdHJldHVybiB0ZXh0O1xuXHRcdH0sXG5cdCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUxpc3QoY3R4OiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcblx0Y29uc3QgcnVubmluZyA9IGF3YWl0IGNsaWVudC5pc1J1bm5pbmcoKTtcblx0aWYgKCFydW5uaW5nKSB7XG5cdFx0Y3R4LnVpLm5vdGlmeShcIk9sbGFtYSBpcyBub3QgcnVubmluZ1wiLCBcIndhcm5pbmdcIik7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0Y29uc3QgbW9kZWxzID0gYXdhaXQgZGlzY292ZXJNb2RlbHMoKTtcblx0aWYgKG1vZGVscy5sZW5ndGggPT09IDApIHtcblx0XHRjdHgudWkubm90aWZ5KFwiTm8gbW9kZWxzIGF2YWlsYWJsZS4gVXNlIC9vbGxhbWEgcHVsbCA8bW9kZWw+IHRvIGRvd25sb2FkIG9uZS5cIiwgXCJpbmZvXCIpO1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGNvbnN0IGxpbmVzID0gW1wiTG9jYWwgT2xsYW1hIG1vZGVsczpcIiwgXCJcIl07XG5cdGZvciAoY29uc3QgbSBvZiBtb2RlbHMpIHtcblx0XHRsaW5lcy5wdXNoKGAgICR7Zm9ybWF0TW9kZWxGb3JEaXNwbGF5KG0pfWApO1xuXHR9XG5cblx0YXdhaXQgY3R4LnVpLmN1c3RvbShcblx0XHQodHVpOiBhbnksIHRoZW1lOiBhbnksIF9rYjogYW55LCBkb25lOiAocjogdW5kZWZpbmVkKSA9PiB2b2lkKSA9PiB7XG5cdFx0XHRjb25zdCB0ZXh0ID0gbmV3IFRleHQobGluZXMubWFwKChsKSA9PiB0aGVtZS5mZyhcImZnXCIsIGwpKS5qb2luKFwiXFxuXCIpLCAwLCAwKTtcblx0XHRcdHNldFRpbWVvdXQoKCkgPT4gZG9uZSh1bmRlZmluZWQpLCAwKTtcblx0XHRcdHJldHVybiB0ZXh0O1xuXHRcdH0sXG5cdCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVB1bGwobW9kZWxOYW1lOiBzdHJpbmcsIGN0eDogYW55KTogUHJvbWlzZTx2b2lkPiB7XG5cdGlmICghbW9kZWxOYW1lKSB7XG5cdFx0Y3R4LnVpLm5vdGlmeShcIlVzYWdlOiAvb2xsYW1hIHB1bGwgPG1vZGVsPiAoZS5nLiAvb2xsYW1hIHB1bGwgbGxhbWEzLjE6OGIpXCIsIFwid2FybmluZ1wiKTtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRjb25zdCBydW5uaW5nID0gYXdhaXQgY2xpZW50LmlzUnVubmluZygpO1xuXHRpZiAoIXJ1bm5pbmcpIHtcblx0XHRjdHgudWkubm90aWZ5KFwiT2xsYW1hIGlzIG5vdCBydW5uaW5nXCIsIFwid2FybmluZ1wiKTtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRjdHgudWkuc2V0V2lkZ2V0KFwib2xsYW1hLXB1bGxcIiwgW2BQdWxsaW5nICR7bW9kZWxOYW1lfS4uLmBdKTtcblxuXHR0cnkge1xuXHRcdGxldCBsYXN0UGVyY2VudCA9IC0xO1xuXHRcdGF3YWl0IGNsaWVudC5wdWxsTW9kZWwobW9kZWxOYW1lLCAocHJvZ3Jlc3MpID0+IHtcblx0XHRcdGlmIChwcm9ncmVzcy50b3RhbCAmJiBwcm9ncmVzcy5jb21wbGV0ZWQpIHtcblx0XHRcdFx0Y29uc3QgcGVyY2VudCA9IE1hdGguZmxvb3IoKHByb2dyZXNzLmNvbXBsZXRlZCAvIHByb2dyZXNzLnRvdGFsKSAqIDEwMCk7XG5cdFx0XHRcdGlmIChwZXJjZW50ICE9PSBsYXN0UGVyY2VudCkge1xuXHRcdFx0XHRcdGxhc3RQZXJjZW50ID0gcGVyY2VudDtcblx0XHRcdFx0XHRjb25zdCBjb21wbGV0ZWQgPSBmb3JtYXRNb2RlbFNpemUocHJvZ3Jlc3MuY29tcGxldGVkKTtcblx0XHRcdFx0XHRjb25zdCB0b3RhbCA9IGZvcm1hdE1vZGVsU2l6ZShwcm9ncmVzcy50b3RhbCk7XG5cdFx0XHRcdFx0Y3R4LnVpLnNldFdpZGdldChcIm9sbGFtYS1wdWxsXCIsIFtcblx0XHRcdFx0XHRcdGBQdWxsaW5nICR7bW9kZWxOYW1lfS4uLiAke3BlcmNlbnR9JSAoJHtjb21wbGV0ZWR9IC8gJHt0b3RhbH0pYCxcblx0XHRcdFx0XHRdKTtcblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIGlmIChwcm9ncmVzcy5zdGF0dXMpIHtcblx0XHRcdFx0Y3R4LnVpLnNldFdpZGdldChcIm9sbGFtYS1wdWxsXCIsIFtgJHttb2RlbE5hbWV9OiAke3Byb2dyZXNzLnN0YXR1c31gXSk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cblx0XHRjdHgudWkuc2V0V2lkZ2V0KFwib2xsYW1hLXB1bGxcIiwgdW5kZWZpbmVkKTtcblx0XHRjdHgudWkubm90aWZ5KGAke21vZGVsTmFtZX0gcHVsbGVkIHN1Y2Nlc3NmdWxseWAsIFwic3VjY2Vzc1wiKTtcblx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0Y3R4LnVpLnNldFdpZGdldChcIm9sbGFtYS1wdWxsXCIsIHVuZGVmaW5lZCk7XG5cdFx0Y3R4LnVpLm5vdGlmeShcblx0XHRcdGBGYWlsZWQgdG8gcHVsbCAke21vZGVsTmFtZX06ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG5cdFx0XHRcImVycm9yXCIsXG5cdFx0KTtcblx0fVxufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVSZW1vdmUobW9kZWxOYW1lOiBzdHJpbmcsIGN0eDogYW55KTogUHJvbWlzZTx2b2lkPiB7XG5cdGlmICghbW9kZWxOYW1lKSB7XG5cdFx0Y3R4LnVpLm5vdGlmeShcIlVzYWdlOiAvb2xsYW1hIHJlbW92ZSA8bW9kZWw+XCIsIFwid2FybmluZ1wiKTtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRjb25zdCBydW5uaW5nID0gYXdhaXQgY2xpZW50LmlzUnVubmluZygpO1xuXHRpZiAoIXJ1bm5pbmcpIHtcblx0XHRjdHgudWkubm90aWZ5KFwiT2xsYW1hIGlzIG5vdCBydW5uaW5nXCIsIFwid2FybmluZ1wiKTtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRjb25zdCBjb25maXJtZWQgPSBhd2FpdCBjdHgudWkuY29uZmlybShcblx0XHRcIkRlbGV0ZSBtb2RlbFwiLFxuXHRcdGBBcmUgeW91IHN1cmUgeW91IHdhbnQgdG8gZGVsZXRlICR7bW9kZWxOYW1lfT9gLFxuXHQpO1xuXG5cdGlmICghY29uZmlybWVkKSByZXR1cm47XG5cblx0dHJ5IHtcblx0XHRhd2FpdCBjbGllbnQuZGVsZXRlTW9kZWwobW9kZWxOYW1lKTtcblx0XHRjdHgudWkubm90aWZ5KGAke21vZGVsTmFtZX0gZGVsZXRlZGAsIFwic3VjY2Vzc1wiKTtcblx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0Y3R4LnVpLm5vdGlmeShcblx0XHRcdGBGYWlsZWQgdG8gZGVsZXRlICR7bW9kZWxOYW1lfTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCxcblx0XHRcdFwiZXJyb3JcIixcblx0XHQpO1xuXHR9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVBzKGN0eDogYW55KTogUHJvbWlzZTx2b2lkPiB7XG5cdGNvbnN0IHJ1bm5pbmcgPSBhd2FpdCBjbGllbnQuaXNSdW5uaW5nKCk7XG5cdGlmICghcnVubmluZykge1xuXHRcdGN0eC51aS5ub3RpZnkoXCJPbGxhbWEgaXMgbm90IHJ1bm5pbmdcIiwgXCJ3YXJuaW5nXCIpO1xuXHRcdHJldHVybjtcblx0fVxuXG5cdHRyeSB7XG5cdFx0Y29uc3QgcHMgPSBhd2FpdCBjbGllbnQuZ2V0UnVubmluZ01vZGVscygpO1xuXHRcdGlmICghcHMubW9kZWxzIHx8IHBzLm1vZGVscy5sZW5ndGggPT09IDApIHtcblx0XHRcdGN0eC51aS5ub3RpZnkoXCJObyBtb2RlbHMgY3VycmVudGx5IGxvYWRlZCBpbiBtZW1vcnlcIiwgXCJpbmZvXCIpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IGxpbmVzID0gW1wiUnVubmluZyBtb2RlbHM6XCIsIFwiXCJdO1xuXHRcdGZvciAoY29uc3QgbSBvZiBwcy5tb2RlbHMpIHtcblx0XHRcdGNvbnN0IHZyYW0gPSBtLnNpemVfdnJhbSA+IDAgPyBmb3JtYXRNb2RlbFNpemUobS5zaXplX3ZyYW0pICsgXCIgVlJBTVwiIDogXCJDUFUgb25seVwiO1xuXHRcdFx0Y29uc3QgdG90YWxTaXplID0gZm9ybWF0TW9kZWxTaXplKG0uc2l6ZSk7XG5cdFx0XHRjb25zdCBleHBpcmVzQXQgPSBuZXcgRGF0ZShtLmV4cGlyZXNfYXQpO1xuXHRcdFx0Y29uc3QgaWRsZU1zID0gZXhwaXJlc0F0LmdldFRpbWUoKSAtIERhdGUubm93KCk7XG5cdFx0XHRjb25zdCBpZGxlTWluID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcihpZGxlTXMgLyA2MDAwMCkpO1xuXHRcdFx0bGluZXMucHVzaChgICAke20ubmFtZX0gICR7dG90YWxTaXplfSAgJHt2cmFtfSAgZXhwaXJlcyBpbiAke2lkbGVNaW59bWApO1xuXHRcdH1cblxuXHRcdGF3YWl0IGN0eC51aS5jdXN0b20oXG5cdFx0XHQodHVpOiBhbnksIHRoZW1lOiBhbnksIF9rYjogYW55LCBkb25lOiAocjogdW5kZWZpbmVkKSA9PiB2b2lkKSA9PiB7XG5cdFx0XHRcdGNvbnN0IHRleHQgPSBuZXcgVGV4dChsaW5lcy5tYXAoKGwpID0+IHRoZW1lLmZnKFwiZmdcIiwgbCkpLmpvaW4oXCJcXG5cIiksIDAsIDApO1xuXHRcdFx0XHRzZXRUaW1lb3V0KCgpID0+IGRvbmUodW5kZWZpbmVkKSwgMCk7XG5cdFx0XHRcdHJldHVybiB0ZXh0O1xuXHRcdFx0fSxcblx0XHQpO1xuXHR9IGNhdGNoIChlcnIpIHtcblx0XHRjdHgudWkubm90aWZ5KFxuXHRcdFx0YEZhaWxlZCB0byBnZXQgcnVubmluZyBtb2RlbHM6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG5cdFx0XHRcImVycm9yXCIsXG5cdFx0KTtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBY0EsU0FBUyxZQUFZO0FBQ3JCLFlBQVksWUFBWTtBQUN4QixTQUFTLGdCQUFnQiw2QkFBNkI7QUFDdEQsU0FBUyx1QkFBdUI7QUFFekIsU0FBUyx1QkFBdUIsSUFBd0I7QUFDOUQsS0FBRyxnQkFBZ0IsVUFBVTtBQUFBLElBQzVCLGFBQWE7QUFBQSxJQUNiLE1BQU0sUUFBUSxNQUFNLEtBQUs7QUFDeEIsWUFBTSxTQUFTLFFBQVEsSUFBSSxLQUFLLEVBQUUsTUFBTSxLQUFLO0FBQzdDLFlBQU0sYUFBYSxNQUFNLENBQUMsS0FBSztBQUMvQixZQUFNLFdBQVcsTUFBTSxNQUFNLENBQUMsRUFBRSxLQUFLLEdBQUc7QUFFeEMsY0FBUSxZQUFZO0FBQUEsUUFDbkIsS0FBSztBQUNKLGlCQUFPLE1BQU0sYUFBYSxHQUFHO0FBQUEsUUFDOUIsS0FBSztBQUFBLFFBQ0wsS0FBSztBQUNKLGlCQUFPLE1BQU0sV0FBVyxHQUFHO0FBQUEsUUFDNUIsS0FBSztBQUNKLGlCQUFPLE1BQU0sV0FBVyxVQUFVLEdBQUc7QUFBQSxRQUN0QyxLQUFLO0FBQUEsUUFDTCxLQUFLO0FBQUEsUUFDTCxLQUFLO0FBQ0osaUJBQU8sTUFBTSxhQUFhLFVBQVUsR0FBRztBQUFBLFFBQ3hDLEtBQUs7QUFDSixpQkFBTyxNQUFNLFNBQVMsR0FBRztBQUFBLFFBQzFCO0FBQ0MsY0FBSSxHQUFHO0FBQUEsWUFDTix1QkFBdUIsVUFBVTtBQUFBLFlBQ2pDO0FBQUEsVUFDRDtBQUFBLE1BQ0Y7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBQ0Y7QUFFQSxlQUFlLGFBQWEsS0FBeUI7QUFDcEQsUUFBTSxVQUFVLE1BQU0sT0FBTyxVQUFVO0FBQ3ZDLE1BQUksQ0FBQyxTQUFTO0FBQ2IsUUFBSSxHQUFHO0FBQUEsTUFDTjtBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBQ0E7QUFBQSxFQUNEO0FBRUEsUUFBTSxVQUFVLE1BQU0sT0FBTyxXQUFXO0FBQ3hDLFFBQU0sUUFBa0IsQ0FBQztBQUN6QixRQUFNLEtBQUssU0FBUyxVQUFVLEtBQUssT0FBTyxLQUFLLEVBQUUsb0JBQWUsT0FBTyxjQUFjLENBQUMsR0FBRztBQUd6RixNQUFJO0FBQ0gsVUFBTSxLQUFLLE1BQU0sT0FBTyxpQkFBaUI7QUFDekMsUUFBSSxHQUFHLFVBQVUsR0FBRyxPQUFPLFNBQVMsR0FBRztBQUN0QyxZQUFNLEtBQUssRUFBRTtBQUNiLFlBQU0sS0FBSyxTQUFTO0FBQ3BCLGlCQUFXLEtBQUssR0FBRyxRQUFRO0FBQzFCLGNBQU0sT0FBTyxFQUFFLFlBQVksSUFBSSxnQkFBZ0IsRUFBRSxTQUFTLElBQUksVUFBVTtBQUN4RSxjQUFNLFlBQVksSUFBSSxLQUFLLEVBQUUsVUFBVTtBQUN2QyxjQUFNLFNBQVMsVUFBVSxRQUFRLElBQUksS0FBSyxJQUFJO0FBQzlDLGNBQU0sVUFBVSxLQUFLLElBQUksR0FBRyxLQUFLLE1BQU0sU0FBUyxHQUFLLENBQUM7QUFDdEQsY0FBTSxLQUFLLEtBQUssRUFBRSxJQUFJLEtBQUssSUFBSSxnQkFBZ0IsT0FBTyxHQUFHO0FBQUEsTUFDMUQ7QUFBQSxJQUNEO0FBQUEsRUFDRCxRQUFRO0FBQUEsRUFFUjtBQUdBLE1BQUk7QUFDSCxVQUFNLFNBQVMsTUFBTSxlQUFlO0FBQ3BDLFFBQUksT0FBTyxTQUFTLEdBQUc7QUFDdEIsWUFBTSxLQUFLLEVBQUU7QUFDYixZQUFNLEtBQUssWUFBWTtBQUN2QixpQkFBVyxLQUFLLFFBQVE7QUFDdkIsY0FBTSxLQUFLLEtBQUssc0JBQXNCLENBQUMsQ0FBQyxFQUFFO0FBQUEsTUFDM0M7QUFBQSxJQUNELE9BQU87QUFDTixZQUFNLEtBQUssRUFBRTtBQUNiLFlBQU0sS0FBSyw0REFBNEQ7QUFBQSxJQUN4RTtBQUFBLEVBQ0QsU0FBUyxLQUFLO0FBQ2IsVUFBTSxLQUFLLEVBQUU7QUFDYixVQUFNLEtBQUsseUJBQXlCLGVBQWUsUUFBUSxJQUFJLFVBQVUsT0FBTyxHQUFHLENBQUMsRUFBRTtBQUFBLEVBQ3ZGO0FBRUEsUUFBTSxJQUFJLEdBQUc7QUFBQSxJQUNaLENBQUMsS0FBVSxPQUFZLEtBQVUsU0FBaUM7QUFDakUsWUFBTSxPQUFPLElBQUksS0FBSyxNQUFNLElBQUksQ0FBQyxNQUFNLE1BQU0sR0FBRyxNQUFNLENBQUMsQ0FBQyxFQUFFLEtBQUssSUFBSSxHQUFHLEdBQUcsQ0FBQztBQUMxRSxpQkFBVyxNQUFNLEtBQUssTUFBUyxHQUFHLENBQUM7QUFDbkMsYUFBTztBQUFBLElBQ1I7QUFBQSxFQUNEO0FBQ0Q7QUFFQSxlQUFlLFdBQVcsS0FBeUI7QUFDbEQsUUFBTSxVQUFVLE1BQU0sT0FBTyxVQUFVO0FBQ3ZDLE1BQUksQ0FBQyxTQUFTO0FBQ2IsUUFBSSxHQUFHLE9BQU8seUJBQXlCLFNBQVM7QUFDaEQ7QUFBQSxFQUNEO0FBRUEsUUFBTSxTQUFTLE1BQU0sZUFBZTtBQUNwQyxNQUFJLE9BQU8sV0FBVyxHQUFHO0FBQ3hCLFFBQUksR0FBRyxPQUFPLGtFQUFrRSxNQUFNO0FBQ3RGO0FBQUEsRUFDRDtBQUVBLFFBQU0sUUFBUSxDQUFDLHdCQUF3QixFQUFFO0FBQ3pDLGFBQVcsS0FBSyxRQUFRO0FBQ3ZCLFVBQU0sS0FBSyxLQUFLLHNCQUFzQixDQUFDLENBQUMsRUFBRTtBQUFBLEVBQzNDO0FBRUEsUUFBTSxJQUFJLEdBQUc7QUFBQSxJQUNaLENBQUMsS0FBVSxPQUFZLEtBQVUsU0FBaUM7QUFDakUsWUFBTSxPQUFPLElBQUksS0FBSyxNQUFNLElBQUksQ0FBQyxNQUFNLE1BQU0sR0FBRyxNQUFNLENBQUMsQ0FBQyxFQUFFLEtBQUssSUFBSSxHQUFHLEdBQUcsQ0FBQztBQUMxRSxpQkFBVyxNQUFNLEtBQUssTUFBUyxHQUFHLENBQUM7QUFDbkMsYUFBTztBQUFBLElBQ1I7QUFBQSxFQUNEO0FBQ0Q7QUFFQSxlQUFlLFdBQVcsV0FBbUIsS0FBeUI7QUFDckUsTUFBSSxDQUFDLFdBQVc7QUFDZixRQUFJLEdBQUcsT0FBTywrREFBK0QsU0FBUztBQUN0RjtBQUFBLEVBQ0Q7QUFFQSxRQUFNLFVBQVUsTUFBTSxPQUFPLFVBQVU7QUFDdkMsTUFBSSxDQUFDLFNBQVM7QUFDYixRQUFJLEdBQUcsT0FBTyx5QkFBeUIsU0FBUztBQUNoRDtBQUFBLEVBQ0Q7QUFFQSxNQUFJLEdBQUcsVUFBVSxlQUFlLENBQUMsV0FBVyxTQUFTLEtBQUssQ0FBQztBQUUzRCxNQUFJO0FBQ0gsUUFBSSxjQUFjO0FBQ2xCLFVBQU0sT0FBTyxVQUFVLFdBQVcsQ0FBQyxhQUFhO0FBQy9DLFVBQUksU0FBUyxTQUFTLFNBQVMsV0FBVztBQUN6QyxjQUFNLFVBQVUsS0FBSyxNQUFPLFNBQVMsWUFBWSxTQUFTLFFBQVMsR0FBRztBQUN0RSxZQUFJLFlBQVksYUFBYTtBQUM1Qix3QkFBYztBQUNkLGdCQUFNLFlBQVksZ0JBQWdCLFNBQVMsU0FBUztBQUNwRCxnQkFBTSxRQUFRLGdCQUFnQixTQUFTLEtBQUs7QUFDNUMsY0FBSSxHQUFHLFVBQVUsZUFBZTtBQUFBLFlBQy9CLFdBQVcsU0FBUyxPQUFPLE9BQU8sTUFBTSxTQUFTLE1BQU0sS0FBSztBQUFBLFVBQzdELENBQUM7QUFBQSxRQUNGO0FBQUEsTUFDRCxXQUFXLFNBQVMsUUFBUTtBQUMzQixZQUFJLEdBQUcsVUFBVSxlQUFlLENBQUMsR0FBRyxTQUFTLEtBQUssU0FBUyxNQUFNLEVBQUUsQ0FBQztBQUFBLE1BQ3JFO0FBQUEsSUFDRCxDQUFDO0FBRUQsUUFBSSxHQUFHLFVBQVUsZUFBZSxNQUFTO0FBQ3pDLFFBQUksR0FBRyxPQUFPLEdBQUcsU0FBUyx3QkFBd0IsU0FBUztBQUFBLEVBQzVELFNBQVMsS0FBSztBQUNiLFFBQUksR0FBRyxVQUFVLGVBQWUsTUFBUztBQUN6QyxRQUFJLEdBQUc7QUFBQSxNQUNOLGtCQUFrQixTQUFTLEtBQUssZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUcsQ0FBQztBQUFBLE1BQ2hGO0FBQUEsSUFDRDtBQUFBLEVBQ0Q7QUFDRDtBQUVBLGVBQWUsYUFBYSxXQUFtQixLQUF5QjtBQUN2RSxNQUFJLENBQUMsV0FBVztBQUNmLFFBQUksR0FBRyxPQUFPLGlDQUFpQyxTQUFTO0FBQ3hEO0FBQUEsRUFDRDtBQUVBLFFBQU0sVUFBVSxNQUFNLE9BQU8sVUFBVTtBQUN2QyxNQUFJLENBQUMsU0FBUztBQUNiLFFBQUksR0FBRyxPQUFPLHlCQUF5QixTQUFTO0FBQ2hEO0FBQUEsRUFDRDtBQUVBLFFBQU0sWUFBWSxNQUFNLElBQUksR0FBRztBQUFBLElBQzlCO0FBQUEsSUFDQSxtQ0FBbUMsU0FBUztBQUFBLEVBQzdDO0FBRUEsTUFBSSxDQUFDLFVBQVc7QUFFaEIsTUFBSTtBQUNILFVBQU0sT0FBTyxZQUFZLFNBQVM7QUFDbEMsUUFBSSxHQUFHLE9BQU8sR0FBRyxTQUFTLFlBQVksU0FBUztBQUFBLEVBQ2hELFNBQVMsS0FBSztBQUNiLFFBQUksR0FBRztBQUFBLE1BQ04sb0JBQW9CLFNBQVMsS0FBSyxlQUFlLFFBQVEsSUFBSSxVQUFVLE9BQU8sR0FBRyxDQUFDO0FBQUEsTUFDbEY7QUFBQSxJQUNEO0FBQUEsRUFDRDtBQUNEO0FBRUEsZUFBZSxTQUFTLEtBQXlCO0FBQ2hELFFBQU0sVUFBVSxNQUFNLE9BQU8sVUFBVTtBQUN2QyxNQUFJLENBQUMsU0FBUztBQUNiLFFBQUksR0FBRyxPQUFPLHlCQUF5QixTQUFTO0FBQ2hEO0FBQUEsRUFDRDtBQUVBLE1BQUk7QUFDSCxVQUFNLEtBQUssTUFBTSxPQUFPLGlCQUFpQjtBQUN6QyxRQUFJLENBQUMsR0FBRyxVQUFVLEdBQUcsT0FBTyxXQUFXLEdBQUc7QUFDekMsVUFBSSxHQUFHLE9BQU8sd0NBQXdDLE1BQU07QUFDNUQ7QUFBQSxJQUNEO0FBRUEsVUFBTSxRQUFRLENBQUMsbUJBQW1CLEVBQUU7QUFDcEMsZUFBVyxLQUFLLEdBQUcsUUFBUTtBQUMxQixZQUFNLE9BQU8sRUFBRSxZQUFZLElBQUksZ0JBQWdCLEVBQUUsU0FBUyxJQUFJLFVBQVU7QUFDeEUsWUFBTSxZQUFZLGdCQUFnQixFQUFFLElBQUk7QUFDeEMsWUFBTSxZQUFZLElBQUksS0FBSyxFQUFFLFVBQVU7QUFDdkMsWUFBTSxTQUFTLFVBQVUsUUFBUSxJQUFJLEtBQUssSUFBSTtBQUM5QyxZQUFNLFVBQVUsS0FBSyxJQUFJLEdBQUcsS0FBSyxNQUFNLFNBQVMsR0FBSyxDQUFDO0FBQ3RELFlBQU0sS0FBSyxLQUFLLEVBQUUsSUFBSSxLQUFLLFNBQVMsS0FBSyxJQUFJLGdCQUFnQixPQUFPLEdBQUc7QUFBQSxJQUN4RTtBQUVBLFVBQU0sSUFBSSxHQUFHO0FBQUEsTUFDWixDQUFDLEtBQVUsT0FBWSxLQUFVLFNBQWlDO0FBQ2pFLGNBQU0sT0FBTyxJQUFJLEtBQUssTUFBTSxJQUFJLENBQUMsTUFBTSxNQUFNLEdBQUcsTUFBTSxDQUFDLENBQUMsRUFBRSxLQUFLLElBQUksR0FBRyxHQUFHLENBQUM7QUFDMUUsbUJBQVcsTUFBTSxLQUFLLE1BQVMsR0FBRyxDQUFDO0FBQ25DLGVBQU87QUFBQSxNQUNSO0FBQUEsSUFDRDtBQUFBLEVBQ0QsU0FBUyxLQUFLO0FBQ2IsUUFBSSxHQUFHO0FBQUEsTUFDTixpQ0FBaUMsZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUcsQ0FBQztBQUFBLE1BQ2pGO0FBQUEsSUFDRDtBQUFBLEVBQ0Q7QUFDRDsiLAogICJuYW1lcyI6IFtdCn0K
