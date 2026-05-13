import { Key } from "@gsd/pi-tui";
import { shortcutDesc } from "../shared/terminal.js";
import {
  processes,
  killProcess,
  getGroupStatus,
  cleanupAll
} from "./process-manager.js";
import {
  generateDigest,
  getOutput,
  formatDigestText
} from "./output-formatter.js";
import { formatUptime } from "./utilities.js";
import { BgManagerOverlay } from "./overlay.js";
function registerBgShellCommand(pi, state) {
  pi.registerCommand("bg", {
    description: "Manage background processes: /bg [list|output|kill|killall|groups] [id]",
    getArgumentCompletions: (prefix) => {
      const subcommands = ["list", "output", "kill", "killall", "groups", "digest"];
      const parts = prefix.trim().split(/\s+/);
      if (parts.length <= 1) {
        return subcommands.filter((cmd) => cmd.startsWith(parts[0] ?? "")).map((cmd) => ({ value: cmd, label: cmd }));
      }
      if (parts[0] === "output" || parts[0] === "kill" || parts[0] === "digest") {
        const idPrefix = parts[1] ?? "";
        return Array.from(processes.values()).filter((p) => p.id.startsWith(idPrefix)).map((p) => ({
          value: `${parts[0]} ${p.id}`,
          label: `${p.id} \u2014 ${p.label}`
        }));
      }
      return [];
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] || "list";
      if (sub === "list" || sub === "") {
        if (processes.size === 0) {
          ctx.ui.notify("No background processes.", "info");
          return;
        }
        if (!ctx.hasUI) {
          const lines = Array.from(processes.values()).map((p) => {
            const statusIcon = p.alive ? p.status === "ready" ? "\u2713" : p.status === "error" ? "\u2717" : "\u22EF" : "\u25CB";
            const uptime = formatUptime(Date.now() - p.startedAt);
            const portInfo = p.ports.length > 0 ? ` :${p.ports.join(",")}` : "";
            return `${p.id}  ${statusIcon} ${p.status}  ${uptime}  ${p.label}  [${p.processType}]${portInfo}`;
          });
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        await ctx.ui.custom(
          (tui, theme, _kb, done) => {
            return new BgManagerOverlay(tui, theme, () => {
              done();
              state.refreshWidget();
            });
          },
          {
            overlay: true,
            overlayOptions: {
              width: "60%",
              minWidth: 50,
              maxHeight: "70%",
              anchor: "center"
            }
          }
        );
        return;
      }
      if (sub === "output" || sub === "digest") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify(`Usage: /bg ${sub} <id>`, "error");
          return;
        }
        const bg = processes.get(id);
        if (!bg) {
          ctx.ui.notify(`No process with id '${id}'`, "error");
          return;
        }
        if (!ctx.hasUI) {
          if (sub === "digest") {
            const digest = generateDigest(bg);
            ctx.ui.notify(formatDigestText(bg, digest), "info");
          } else {
            const output = getOutput(bg, { stream: "both", tail: 50 });
            ctx.ui.notify(output || "(no output)", "info");
          }
          return;
        }
        await ctx.ui.custom(
          (tui, theme, _kb, done) => {
            const overlay = new BgManagerOverlay(tui, theme, () => {
              done();
              state.refreshWidget();
            });
            const procs = Array.from(processes.values());
            const idx = procs.findIndex((p) => p.id === id);
            if (idx >= 0) overlay.selectAndView(idx);
            return overlay;
          },
          {
            overlay: true,
            overlayOptions: {
              width: "60%",
              minWidth: 50,
              maxHeight: "70%",
              anchor: "center"
            }
          }
        );
        return;
      }
      if (sub === "kill") {
        const id = parts[1];
        if (!id) {
          ctx.ui.notify("Usage: /bg kill <id>", "error");
          return;
        }
        const bg = processes.get(id);
        if (!bg) {
          ctx.ui.notify(`No process with id '${id}'`, "error");
          return;
        }
        killProcess(id, "SIGTERM");
        await new Promise((r) => setTimeout(r, 300));
        if (bg.alive) {
          killProcess(id, "SIGKILL");
          await new Promise((r) => setTimeout(r, 200));
        }
        if (!bg.alive) processes.delete(id);
        ctx.ui.notify(`Killed process ${id} (${bg.label})`, "info");
        return;
      }
      if (sub === "killall") {
        const count = processes.size;
        cleanupAll();
        ctx.ui.notify(`Killed ${count} background process(es)`, "info");
        return;
      }
      if (sub === "groups") {
        const groups = /* @__PURE__ */ new Set();
        for (const p of processes.values()) {
          if (p.group) groups.add(p.group);
        }
        if (groups.size === 0) {
          ctx.ui.notify("No process groups defined.", "info");
          return;
        }
        const lines = Array.from(groups).map((g) => {
          const gs = getGroupStatus(g);
          const icon = gs.healthy ? "\u2713" : "\u2717";
          const procs = gs.processes.map((p) => `${p.id}(${p.status})`).join(", ");
          return `${icon} ${g}: ${procs}`;
        });
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      ctx.ui.notify("Usage: /bg [list|output|digest|kill|killall|groups] [id]", "info");
    }
  });
  pi.registerShortcut(Key.ctrlAlt("b"), {
    description: shortcutDesc("Open background process manager", "/bg"),
    handler: async (ctx) => {
      state.latestCtx = ctx;
      await ctx.ui.custom(
        (tui, theme, _kb, done) => {
          return new BgManagerOverlay(tui, theme, () => {
            done();
            state.refreshWidget();
          });
        },
        {
          overlay: true,
          overlayOptions: {
            width: "60%",
            minWidth: 50,
            maxHeight: "70%",
            anchor: "center"
          }
        }
      );
    }
  });
}
export {
  registerBgShellCommand
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2JnLXNoZWxsL2JnLXNoZWxsLWNvbW1hbmQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogL2JnIHNsYXNoIGNvbW1hbmQgcmVnaXN0cmF0aW9uIFx1MjAxNCBpbnRlcmFjdGl2ZSBwcm9jZXNzIG1hbmFnZXIgb3ZlcmxheSBhbmQgQ0xJIHN1YmNvbW1hbmRzLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBLZXkgfSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB7IHNob3J0Y3V0RGVzYyB9IGZyb20gXCIuLi9zaGFyZWQvdGVybWluYWwuanNcIjtcblxuaW1wb3J0IHtcblx0cHJvY2Vzc2VzLFxuXHRraWxsUHJvY2Vzcyxcblx0Z2V0R3JvdXBTdGF0dXMsXG5cdGNsZWFudXBBbGwsXG59IGZyb20gXCIuL3Byb2Nlc3MtbWFuYWdlci5qc1wiO1xuaW1wb3J0IHtcblx0Z2VuZXJhdGVEaWdlc3QsXG5cdGdldE91dHB1dCxcblx0Zm9ybWF0RGlnZXN0VGV4dCxcbn0gZnJvbSBcIi4vb3V0cHV0LWZvcm1hdHRlci5qc1wiO1xuaW1wb3J0IHsgZm9ybWF0VXB0aW1lIH0gZnJvbSBcIi4vdXRpbGl0aWVzLmpzXCI7XG5pbXBvcnQgeyBCZ01hbmFnZXJPdmVybGF5IH0gZnJvbSBcIi4vb3ZlcmxheS5qc1wiO1xuXG5pbXBvcnQgdHlwZSB7IEJnU2hlbGxTaGFyZWRTdGF0ZSB9IGZyb20gXCIuL2luZGV4LmpzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlckJnU2hlbGxDb21tYW5kKHBpOiBFeHRlbnNpb25BUEksIHN0YXRlOiBCZ1NoZWxsU2hhcmVkU3RhdGUpOiB2b2lkIHtcblx0cGkucmVnaXN0ZXJDb21tYW5kKFwiYmdcIiwge1xuXHRcdGRlc2NyaXB0aW9uOiBcIk1hbmFnZSBiYWNrZ3JvdW5kIHByb2Nlc3NlczogL2JnIFtsaXN0fG91dHB1dHxraWxsfGtpbGxhbGx8Z3JvdXBzXSBbaWRdXCIsXG5cblx0XHRnZXRBcmd1bWVudENvbXBsZXRpb25zOiAocHJlZml4OiBzdHJpbmcpID0+IHtcblx0XHRcdGNvbnN0IHN1YmNvbW1hbmRzID0gW1wibGlzdFwiLCBcIm91dHB1dFwiLCBcImtpbGxcIiwgXCJraWxsYWxsXCIsIFwiZ3JvdXBzXCIsIFwiZGlnZXN0XCJdO1xuXHRcdFx0Y29uc3QgcGFydHMgPSBwcmVmaXgudHJpbSgpLnNwbGl0KC9cXHMrLyk7XG5cblx0XHRcdGlmIChwYXJ0cy5sZW5ndGggPD0gMSkge1xuXHRcdFx0XHRyZXR1cm4gc3ViY29tbWFuZHNcblx0XHRcdFx0XHQuZmlsdGVyKGNtZCA9PiBjbWQuc3RhcnRzV2l0aChwYXJ0c1swXSA/PyBcIlwiKSlcblx0XHRcdFx0XHQubWFwKGNtZCA9PiAoeyB2YWx1ZTogY21kLCBsYWJlbDogY21kIH0pKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKHBhcnRzWzBdID09PSBcIm91dHB1dFwiIHx8IHBhcnRzWzBdID09PSBcImtpbGxcIiB8fCBwYXJ0c1swXSA9PT0gXCJkaWdlc3RcIikge1xuXHRcdFx0XHRjb25zdCBpZFByZWZpeCA9IHBhcnRzWzFdID8/IFwiXCI7XG5cdFx0XHRcdHJldHVybiBBcnJheS5mcm9tKHByb2Nlc3Nlcy52YWx1ZXMoKSlcblx0XHRcdFx0XHQuZmlsdGVyKHAgPT4gcC5pZC5zdGFydHNXaXRoKGlkUHJlZml4KSlcblx0XHRcdFx0XHQubWFwKHAgPT4gKHtcblx0XHRcdFx0XHRcdHZhbHVlOiBgJHtwYXJ0c1swXX0gJHtwLmlkfWAsXG5cdFx0XHRcdFx0XHRsYWJlbDogYCR7cC5pZH0gXHUyMDE0ICR7cC5sYWJlbH1gLFxuXHRcdFx0XHRcdH0pKTtcblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIFtdO1xuXHRcdH0sXG5cblx0XHRoYW5kbGVyOiBhc3luYyAoYXJncywgY3R4KSA9PiB7XG5cdFx0XHRjb25zdCBwYXJ0cyA9IGFyZ3MudHJpbSgpLnNwbGl0KC9cXHMrLyk7XG5cdFx0XHRjb25zdCBzdWIgPSBwYXJ0c1swXSB8fCBcImxpc3RcIjtcblxuXHRcdFx0aWYgKHN1YiA9PT0gXCJsaXN0XCIgfHwgc3ViID09PSBcIlwiKSB7XG5cdFx0XHRcdGlmIChwcm9jZXNzZXMuc2l6ZSA9PT0gMCkge1xuXHRcdFx0XHRcdGN0eC51aS5ub3RpZnkoXCJObyBiYWNrZ3JvdW5kIHByb2Nlc3Nlcy5cIiwgXCJpbmZvXCIpO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmICghY3R4Lmhhc1VJKSB7XG5cdFx0XHRcdFx0Y29uc3QgbGluZXMgPSBBcnJheS5mcm9tKHByb2Nlc3Nlcy52YWx1ZXMoKSkubWFwKHAgPT4ge1xuXHRcdFx0XHRcdFx0Y29uc3Qgc3RhdHVzSWNvbiA9IHAuYWxpdmVcblx0XHRcdFx0XHRcdFx0PyAocC5zdGF0dXMgPT09IFwicmVhZHlcIiA/IFwiXHUyNzEzXCIgOiBwLnN0YXR1cyA9PT0gXCJlcnJvclwiID8gXCJcdTI3MTdcIiA6IFwiXHUyMkVGXCIpXG5cdFx0XHRcdFx0XHRcdDogXCJcdTI1Q0JcIjtcblx0XHRcdFx0XHRcdGNvbnN0IHVwdGltZSA9IGZvcm1hdFVwdGltZShEYXRlLm5vdygpIC0gcC5zdGFydGVkQXQpO1xuXHRcdFx0XHRcdFx0Y29uc3QgcG9ydEluZm8gPSBwLnBvcnRzLmxlbmd0aCA+IDAgPyBgIDoke3AucG9ydHMuam9pbihcIixcIil9YCA6IFwiXCI7XG5cdFx0XHRcdFx0XHRyZXR1cm4gYCR7cC5pZH0gICR7c3RhdHVzSWNvbn0gJHtwLnN0YXR1c30gICR7dXB0aW1lfSAgJHtwLmxhYmVsfSAgWyR7cC5wcm9jZXNzVHlwZX1dJHtwb3J0SW5mb31gO1xuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdGN0eC51aS5ub3RpZnkobGluZXMuam9pbihcIlxcblwiKSwgXCJpbmZvXCIpO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGF3YWl0IGN0eC51aS5jdXN0b208dm9pZD4oXG5cdFx0XHRcdFx0KHR1aSwgdGhlbWUsIF9rYiwgZG9uZSkgPT4ge1xuXHRcdFx0XHRcdFx0cmV0dXJuIG5ldyBCZ01hbmFnZXJPdmVybGF5KHR1aSwgdGhlbWUsICgpID0+IHtcblx0XHRcdFx0XHRcdFx0ZG9uZSgpO1xuXHRcdFx0XHRcdFx0XHRzdGF0ZS5yZWZyZXNoV2lkZ2V0KCk7XG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdG92ZXJsYXk6IHRydWUsXG5cdFx0XHRcdFx0XHRvdmVybGF5T3B0aW9uczoge1xuXHRcdFx0XHRcdFx0XHR3aWR0aDogXCI2MCVcIixcblx0XHRcdFx0XHRcdFx0bWluV2lkdGg6IDUwLFxuXHRcdFx0XHRcdFx0XHRtYXhIZWlnaHQ6IFwiNzAlXCIsXG5cdFx0XHRcdFx0XHRcdGFuY2hvcjogXCJjZW50ZXJcIixcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0KTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoc3ViID09PSBcIm91dHB1dFwiIHx8IHN1YiA9PT0gXCJkaWdlc3RcIikge1xuXHRcdFx0XHRjb25zdCBpZCA9IHBhcnRzWzFdO1xuXHRcdFx0XHRpZiAoIWlkKSB7XG5cdFx0XHRcdFx0Y3R4LnVpLm5vdGlmeShgVXNhZ2U6IC9iZyAke3N1Yn0gPGlkPmAsIFwiZXJyb3JcIik7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IGJnID0gcHJvY2Vzc2VzLmdldChpZCk7XG5cdFx0XHRcdGlmICghYmcpIHtcblx0XHRcdFx0XHRjdHgudWkubm90aWZ5KGBObyBwcm9jZXNzIHdpdGggaWQgJyR7aWR9J2AsIFwiZXJyb3JcIik7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKCFjdHguaGFzVUkpIHtcblx0XHRcdFx0XHRpZiAoc3ViID09PSBcImRpZ2VzdFwiKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBkaWdlc3QgPSBnZW5lcmF0ZURpZ2VzdChiZyk7XG5cdFx0XHRcdFx0XHRjdHgudWkubm90aWZ5KGZvcm1hdERpZ2VzdFRleHQoYmcsIGRpZ2VzdCksIFwiaW5mb1wiKTtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0Y29uc3Qgb3V0cHV0ID0gZ2V0T3V0cHV0KGJnLCB7IHN0cmVhbTogXCJib3RoXCIsIHRhaWw6IDUwIH0pO1xuXHRcdFx0XHRcdFx0Y3R4LnVpLm5vdGlmeShvdXRwdXQgfHwgXCIobm8gb3V0cHV0KVwiLCBcImluZm9cIik7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGF3YWl0IGN0eC51aS5jdXN0b208dm9pZD4oXG5cdFx0XHRcdFx0KHR1aSwgdGhlbWUsIF9rYiwgZG9uZSkgPT4ge1xuXHRcdFx0XHRcdFx0Y29uc3Qgb3ZlcmxheSA9IG5ldyBCZ01hbmFnZXJPdmVybGF5KHR1aSwgdGhlbWUsICgpID0+IHtcblx0XHRcdFx0XHRcdFx0ZG9uZSgpO1xuXHRcdFx0XHRcdFx0XHRzdGF0ZS5yZWZyZXNoV2lkZ2V0KCk7XG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdGNvbnN0IHByb2NzID0gQXJyYXkuZnJvbShwcm9jZXNzZXMudmFsdWVzKCkpO1xuXHRcdFx0XHRcdFx0Y29uc3QgaWR4ID0gcHJvY3MuZmluZEluZGV4KHAgPT4gcC5pZCA9PT0gaWQpO1xuXHRcdFx0XHRcdFx0aWYgKGlkeCA+PSAwKSBvdmVybGF5LnNlbGVjdEFuZFZpZXcoaWR4KTtcblx0XHRcdFx0XHRcdHJldHVybiBvdmVybGF5O1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0b3ZlcmxheTogdHJ1ZSxcblx0XHRcdFx0XHRcdG92ZXJsYXlPcHRpb25zOiB7XG5cdFx0XHRcdFx0XHRcdHdpZHRoOiBcIjYwJVwiLFxuXHRcdFx0XHRcdFx0XHRtaW5XaWR0aDogNTAsXG5cdFx0XHRcdFx0XHRcdG1heEhlaWdodDogXCI3MCVcIixcblx0XHRcdFx0XHRcdFx0YW5jaG9yOiBcImNlbnRlclwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHQpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGlmIChzdWIgPT09IFwia2lsbFwiKSB7XG5cdFx0XHRcdGNvbnN0IGlkID0gcGFydHNbMV07XG5cdFx0XHRcdGlmICghaWQpIHtcblx0XHRcdFx0XHRjdHgudWkubm90aWZ5KFwiVXNhZ2U6IC9iZyBraWxsIDxpZD5cIiwgXCJlcnJvclwiKTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgYmcgPSBwcm9jZXNzZXMuZ2V0KGlkKTtcblx0XHRcdFx0aWYgKCFiZykge1xuXHRcdFx0XHRcdGN0eC51aS5ub3RpZnkoYE5vIHByb2Nlc3Mgd2l0aCBpZCAnJHtpZH0nYCwgXCJlcnJvclwiKTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblx0XHRcdFx0a2lsbFByb2Nlc3MoaWQsIFwiU0lHVEVSTVwiKTtcblx0XHRcdFx0YXdhaXQgbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIDMwMCkpO1xuXHRcdFx0XHRpZiAoYmcuYWxpdmUpIHtcblx0XHRcdFx0XHRraWxsUHJvY2VzcyhpZCwgXCJTSUdLSUxMXCIpO1xuXHRcdFx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCAyMDApKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoIWJnLmFsaXZlKSBwcm9jZXNzZXMuZGVsZXRlKGlkKTtcblx0XHRcdFx0Y3R4LnVpLm5vdGlmeShgS2lsbGVkIHByb2Nlc3MgJHtpZH0gKCR7YmcubGFiZWx9KWAsIFwiaW5mb1wiKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoc3ViID09PSBcImtpbGxhbGxcIikge1xuXHRcdFx0XHRjb25zdCBjb3VudCA9IHByb2Nlc3Nlcy5zaXplO1xuXHRcdFx0XHRjbGVhbnVwQWxsKCk7XG5cdFx0XHRcdGN0eC51aS5ub3RpZnkoYEtpbGxlZCAke2NvdW50fSBiYWNrZ3JvdW5kIHByb2Nlc3MoZXMpYCwgXCJpbmZvXCIpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGlmIChzdWIgPT09IFwiZ3JvdXBzXCIpIHtcblx0XHRcdFx0Y29uc3QgZ3JvdXBzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cdFx0XHRcdGZvciAoY29uc3QgcCBvZiBwcm9jZXNzZXMudmFsdWVzKCkpIHtcblx0XHRcdFx0XHRpZiAocC5ncm91cCkgZ3JvdXBzLmFkZChwLmdyb3VwKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoZ3JvdXBzLnNpemUgPT09IDApIHtcblx0XHRcdFx0XHRjdHgudWkubm90aWZ5KFwiTm8gcHJvY2VzcyBncm91cHMgZGVmaW5lZC5cIiwgXCJpbmZvXCIpO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBsaW5lcyA9IEFycmF5LmZyb20oZ3JvdXBzKS5tYXAoZyA9PiB7XG5cdFx0XHRcdFx0Y29uc3QgZ3MgPSBnZXRHcm91cFN0YXR1cyhnKTtcblx0XHRcdFx0XHRjb25zdCBpY29uID0gZ3MuaGVhbHRoeSA/IFwiXHUyNzEzXCIgOiBcIlx1MjcxN1wiO1xuXHRcdFx0XHRcdGNvbnN0IHByb2NzID0gZ3MucHJvY2Vzc2VzLm1hcChwID0+IGAke3AuaWR9KCR7cC5zdGF0dXN9KWApLmpvaW4oXCIsIFwiKTtcblx0XHRcdFx0XHRyZXR1cm4gYCR7aWNvbn0gJHtnfTogJHtwcm9jc31gO1xuXHRcdFx0XHR9KTtcblx0XHRcdFx0Y3R4LnVpLm5vdGlmeShsaW5lcy5qb2luKFwiXFxuXCIpLCBcImluZm9cIik7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0Y3R4LnVpLm5vdGlmeShcIlVzYWdlOiAvYmcgW2xpc3R8b3V0cHV0fGRpZ2VzdHxraWxsfGtpbGxhbGx8Z3JvdXBzXSBbaWRdXCIsIFwiaW5mb1wiKTtcblx0XHR9LFxuXHR9KTtcblxuXHQvLyBcdTI1MDBcdTI1MDAgQ3RybCtBbHQrQiBzaG9ydGN1dCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuXHRwaS5yZWdpc3RlclNob3J0Y3V0KEtleS5jdHJsQWx0KFwiYlwiKSwge1xuXHRcdGRlc2NyaXB0aW9uOiBzaG9ydGN1dERlc2MoXCJPcGVuIGJhY2tncm91bmQgcHJvY2VzcyBtYW5hZ2VyXCIsIFwiL2JnXCIpLFxuXHRcdGhhbmRsZXI6IGFzeW5jIChjdHgpID0+IHtcblx0XHRcdHN0YXRlLmxhdGVzdEN0eCA9IGN0eDtcblx0XHRcdGF3YWl0IGN0eC51aS5jdXN0b208dm9pZD4oXG5cdFx0XHRcdCh0dWksIHRoZW1lLCBfa2IsIGRvbmUpID0+IHtcblx0XHRcdFx0XHRyZXR1cm4gbmV3IEJnTWFuYWdlck92ZXJsYXkodHVpLCB0aGVtZSwgKCkgPT4ge1xuXHRcdFx0XHRcdFx0ZG9uZSgpO1xuXHRcdFx0XHRcdFx0c3RhdGUucmVmcmVzaFdpZGdldCgpO1xuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0b3ZlcmxheTogdHJ1ZSxcblx0XHRcdFx0XHRvdmVybGF5T3B0aW9uczoge1xuXHRcdFx0XHRcdFx0d2lkdGg6IFwiNjAlXCIsXG5cdFx0XHRcdFx0XHRtaW5XaWR0aDogNTAsXG5cdFx0XHRcdFx0XHRtYXhIZWlnaHQ6IFwiNzAlXCIsXG5cdFx0XHRcdFx0XHRhbmNob3I6IFwiY2VudGVyXCIsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSxcblx0XHRcdCk7XG5cdFx0fSxcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFLQSxTQUFTLFdBQVc7QUFDcEIsU0FBUyxvQkFBb0I7QUFFN0I7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUNQO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUNQLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsd0JBQXdCO0FBSTFCLFNBQVMsdUJBQXVCLElBQWtCLE9BQWlDO0FBQ3pGLEtBQUcsZ0JBQWdCLE1BQU07QUFBQSxJQUN4QixhQUFhO0FBQUEsSUFFYix3QkFBd0IsQ0FBQyxXQUFtQjtBQUMzQyxZQUFNLGNBQWMsQ0FBQyxRQUFRLFVBQVUsUUFBUSxXQUFXLFVBQVUsUUFBUTtBQUM1RSxZQUFNLFFBQVEsT0FBTyxLQUFLLEVBQUUsTUFBTSxLQUFLO0FBRXZDLFVBQUksTUFBTSxVQUFVLEdBQUc7QUFDdEIsZUFBTyxZQUNMLE9BQU8sU0FBTyxJQUFJLFdBQVcsTUFBTSxDQUFDLEtBQUssRUFBRSxDQUFDLEVBQzVDLElBQUksVUFBUSxFQUFFLE9BQU8sS0FBSyxPQUFPLElBQUksRUFBRTtBQUFBLE1BQzFDO0FBRUEsVUFBSSxNQUFNLENBQUMsTUFBTSxZQUFZLE1BQU0sQ0FBQyxNQUFNLFVBQVUsTUFBTSxDQUFDLE1BQU0sVUFBVTtBQUMxRSxjQUFNLFdBQVcsTUFBTSxDQUFDLEtBQUs7QUFDN0IsZUFBTyxNQUFNLEtBQUssVUFBVSxPQUFPLENBQUMsRUFDbEMsT0FBTyxPQUFLLEVBQUUsR0FBRyxXQUFXLFFBQVEsQ0FBQyxFQUNyQyxJQUFJLFFBQU07QUFBQSxVQUNWLE9BQU8sR0FBRyxNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRTtBQUFBLFVBQzFCLE9BQU8sR0FBRyxFQUFFLEVBQUUsV0FBTSxFQUFFLEtBQUs7QUFBQSxRQUM1QixFQUFFO0FBQUEsTUFDSjtBQUVBLGFBQU8sQ0FBQztBQUFBLElBQ1Q7QUFBQSxJQUVBLFNBQVMsT0FBTyxNQUFNLFFBQVE7QUFDN0IsWUFBTSxRQUFRLEtBQUssS0FBSyxFQUFFLE1BQU0sS0FBSztBQUNyQyxZQUFNLE1BQU0sTUFBTSxDQUFDLEtBQUs7QUFFeEIsVUFBSSxRQUFRLFVBQVUsUUFBUSxJQUFJO0FBQ2pDLFlBQUksVUFBVSxTQUFTLEdBQUc7QUFDekIsY0FBSSxHQUFHLE9BQU8sNEJBQTRCLE1BQU07QUFDaEQ7QUFBQSxRQUNEO0FBRUEsWUFBSSxDQUFDLElBQUksT0FBTztBQUNmLGdCQUFNLFFBQVEsTUFBTSxLQUFLLFVBQVUsT0FBTyxDQUFDLEVBQUUsSUFBSSxPQUFLO0FBQ3JELGtCQUFNLGFBQWEsRUFBRSxRQUNqQixFQUFFLFdBQVcsVUFBVSxXQUFNLEVBQUUsV0FBVyxVQUFVLFdBQU0sV0FDM0Q7QUFDSCxrQkFBTSxTQUFTLGFBQWEsS0FBSyxJQUFJLElBQUksRUFBRSxTQUFTO0FBQ3BELGtCQUFNLFdBQVcsRUFBRSxNQUFNLFNBQVMsSUFBSSxLQUFLLEVBQUUsTUFBTSxLQUFLLEdBQUcsQ0FBQyxLQUFLO0FBQ2pFLG1CQUFPLEdBQUcsRUFBRSxFQUFFLEtBQUssVUFBVSxJQUFJLEVBQUUsTUFBTSxLQUFLLE1BQU0sS0FBSyxFQUFFLEtBQUssTUFBTSxFQUFFLFdBQVcsSUFBSSxRQUFRO0FBQUEsVUFDaEcsQ0FBQztBQUNELGNBQUksR0FBRyxPQUFPLE1BQU0sS0FBSyxJQUFJLEdBQUcsTUFBTTtBQUN0QztBQUFBLFFBQ0Q7QUFFQSxjQUFNLElBQUksR0FBRztBQUFBLFVBQ1osQ0FBQyxLQUFLLE9BQU8sS0FBSyxTQUFTO0FBQzFCLG1CQUFPLElBQUksaUJBQWlCLEtBQUssT0FBTyxNQUFNO0FBQzdDLG1CQUFLO0FBQ0wsb0JBQU0sY0FBYztBQUFBLFlBQ3JCLENBQUM7QUFBQSxVQUNGO0FBQUEsVUFDQTtBQUFBLFlBQ0MsU0FBUztBQUFBLFlBQ1QsZ0JBQWdCO0FBQUEsY0FDZixPQUFPO0FBQUEsY0FDUCxVQUFVO0FBQUEsY0FDVixXQUFXO0FBQUEsY0FDWCxRQUFRO0FBQUEsWUFDVDtBQUFBLFVBQ0Q7QUFBQSxRQUNEO0FBQ0E7QUFBQSxNQUNEO0FBRUEsVUFBSSxRQUFRLFlBQVksUUFBUSxVQUFVO0FBQ3pDLGNBQU0sS0FBSyxNQUFNLENBQUM7QUFDbEIsWUFBSSxDQUFDLElBQUk7QUFDUixjQUFJLEdBQUcsT0FBTyxjQUFjLEdBQUcsU0FBUyxPQUFPO0FBQy9DO0FBQUEsUUFDRDtBQUNBLGNBQU0sS0FBSyxVQUFVLElBQUksRUFBRTtBQUMzQixZQUFJLENBQUMsSUFBSTtBQUNSLGNBQUksR0FBRyxPQUFPLHVCQUF1QixFQUFFLEtBQUssT0FBTztBQUNuRDtBQUFBLFFBQ0Q7QUFFQSxZQUFJLENBQUMsSUFBSSxPQUFPO0FBQ2YsY0FBSSxRQUFRLFVBQVU7QUFDckIsa0JBQU0sU0FBUyxlQUFlLEVBQUU7QUFDaEMsZ0JBQUksR0FBRyxPQUFPLGlCQUFpQixJQUFJLE1BQU0sR0FBRyxNQUFNO0FBQUEsVUFDbkQsT0FBTztBQUNOLGtCQUFNLFNBQVMsVUFBVSxJQUFJLEVBQUUsUUFBUSxRQUFRLE1BQU0sR0FBRyxDQUFDO0FBQ3pELGdCQUFJLEdBQUcsT0FBTyxVQUFVLGVBQWUsTUFBTTtBQUFBLFVBQzlDO0FBQ0E7QUFBQSxRQUNEO0FBRUEsY0FBTSxJQUFJLEdBQUc7QUFBQSxVQUNaLENBQUMsS0FBSyxPQUFPLEtBQUssU0FBUztBQUMxQixrQkFBTSxVQUFVLElBQUksaUJBQWlCLEtBQUssT0FBTyxNQUFNO0FBQ3RELG1CQUFLO0FBQ0wsb0JBQU0sY0FBYztBQUFBLFlBQ3JCLENBQUM7QUFDRCxrQkFBTSxRQUFRLE1BQU0sS0FBSyxVQUFVLE9BQU8sQ0FBQztBQUMzQyxrQkFBTSxNQUFNLE1BQU0sVUFBVSxPQUFLLEVBQUUsT0FBTyxFQUFFO0FBQzVDLGdCQUFJLE9BQU8sRUFBRyxTQUFRLGNBQWMsR0FBRztBQUN2QyxtQkFBTztBQUFBLFVBQ1I7QUFBQSxVQUNBO0FBQUEsWUFDQyxTQUFTO0FBQUEsWUFDVCxnQkFBZ0I7QUFBQSxjQUNmLE9BQU87QUFBQSxjQUNQLFVBQVU7QUFBQSxjQUNWLFdBQVc7QUFBQSxjQUNYLFFBQVE7QUFBQSxZQUNUO0FBQUEsVUFDRDtBQUFBLFFBQ0Q7QUFDQTtBQUFBLE1BQ0Q7QUFFQSxVQUFJLFFBQVEsUUFBUTtBQUNuQixjQUFNLEtBQUssTUFBTSxDQUFDO0FBQ2xCLFlBQUksQ0FBQyxJQUFJO0FBQ1IsY0FBSSxHQUFHLE9BQU8sd0JBQXdCLE9BQU87QUFDN0M7QUFBQSxRQUNEO0FBQ0EsY0FBTSxLQUFLLFVBQVUsSUFBSSxFQUFFO0FBQzNCLFlBQUksQ0FBQyxJQUFJO0FBQ1IsY0FBSSxHQUFHLE9BQU8sdUJBQXVCLEVBQUUsS0FBSyxPQUFPO0FBQ25EO0FBQUEsUUFDRDtBQUNBLG9CQUFZLElBQUksU0FBUztBQUN6QixjQUFNLElBQUksUUFBUSxPQUFLLFdBQVcsR0FBRyxHQUFHLENBQUM7QUFDekMsWUFBSSxHQUFHLE9BQU87QUFDYixzQkFBWSxJQUFJLFNBQVM7QUFDekIsZ0JBQU0sSUFBSSxRQUFRLE9BQUssV0FBVyxHQUFHLEdBQUcsQ0FBQztBQUFBLFFBQzFDO0FBQ0EsWUFBSSxDQUFDLEdBQUcsTUFBTyxXQUFVLE9BQU8sRUFBRTtBQUNsQyxZQUFJLEdBQUcsT0FBTyxrQkFBa0IsRUFBRSxLQUFLLEdBQUcsS0FBSyxLQUFLLE1BQU07QUFDMUQ7QUFBQSxNQUNEO0FBRUEsVUFBSSxRQUFRLFdBQVc7QUFDdEIsY0FBTSxRQUFRLFVBQVU7QUFDeEIsbUJBQVc7QUFDWCxZQUFJLEdBQUcsT0FBTyxVQUFVLEtBQUssMkJBQTJCLE1BQU07QUFDOUQ7QUFBQSxNQUNEO0FBRUEsVUFBSSxRQUFRLFVBQVU7QUFDckIsY0FBTSxTQUFTLG9CQUFJLElBQVk7QUFDL0IsbUJBQVcsS0FBSyxVQUFVLE9BQU8sR0FBRztBQUNuQyxjQUFJLEVBQUUsTUFBTyxRQUFPLElBQUksRUFBRSxLQUFLO0FBQUEsUUFDaEM7QUFDQSxZQUFJLE9BQU8sU0FBUyxHQUFHO0FBQ3RCLGNBQUksR0FBRyxPQUFPLDhCQUE4QixNQUFNO0FBQ2xEO0FBQUEsUUFDRDtBQUNBLGNBQU0sUUFBUSxNQUFNLEtBQUssTUFBTSxFQUFFLElBQUksT0FBSztBQUN6QyxnQkFBTSxLQUFLLGVBQWUsQ0FBQztBQUMzQixnQkFBTSxPQUFPLEdBQUcsVUFBVSxXQUFNO0FBQ2hDLGdCQUFNLFFBQVEsR0FBRyxVQUFVLElBQUksT0FBSyxHQUFHLEVBQUUsRUFBRSxJQUFJLEVBQUUsTUFBTSxHQUFHLEVBQUUsS0FBSyxJQUFJO0FBQ3JFLGlCQUFPLEdBQUcsSUFBSSxJQUFJLENBQUMsS0FBSyxLQUFLO0FBQUEsUUFDOUIsQ0FBQztBQUNELFlBQUksR0FBRyxPQUFPLE1BQU0sS0FBSyxJQUFJLEdBQUcsTUFBTTtBQUN0QztBQUFBLE1BQ0Q7QUFFQSxVQUFJLEdBQUcsT0FBTyw0REFBNEQsTUFBTTtBQUFBLElBQ2pGO0FBQUEsRUFDRCxDQUFDO0FBSUQsS0FBRyxpQkFBaUIsSUFBSSxRQUFRLEdBQUcsR0FBRztBQUFBLElBQ3JDLGFBQWEsYUFBYSxtQ0FBbUMsS0FBSztBQUFBLElBQ2xFLFNBQVMsT0FBTyxRQUFRO0FBQ3ZCLFlBQU0sWUFBWTtBQUNsQixZQUFNLElBQUksR0FBRztBQUFBLFFBQ1osQ0FBQyxLQUFLLE9BQU8sS0FBSyxTQUFTO0FBQzFCLGlCQUFPLElBQUksaUJBQWlCLEtBQUssT0FBTyxNQUFNO0FBQzdDLGlCQUFLO0FBQ0wsa0JBQU0sY0FBYztBQUFBLFVBQ3JCLENBQUM7QUFBQSxRQUNGO0FBQUEsUUFDQTtBQUFBLFVBQ0MsU0FBUztBQUFBLFVBQ1QsZ0JBQWdCO0FBQUEsWUFDZixPQUFPO0FBQUEsWUFDUCxVQUFVO0FBQUEsWUFDVixXQUFXO0FBQUEsWUFDWCxRQUFRO0FBQUEsVUFDVDtBQUFBLFFBQ0Q7QUFBQSxNQUNEO0FBQUEsSUFDRDtBQUFBLEVBQ0QsQ0FBQztBQUNGOyIsCiAgIm5hbWVzIjogW10KfQo=
