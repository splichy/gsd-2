import {
  assertValidDebugSessionSlug,
  createDebugSession,
  listDebugSessions,
  loadDebugSession,
  updateDebugSession
} from "./debug-session-store.js";
import { loadPrompt } from "./prompt-loader.js";
const SUBCOMMANDS = /* @__PURE__ */ new Set(["list", "status", "continue", "--diagnose"]);
function isValidSlugCandidate(input) {
  try {
    assertValidDebugSessionSlug(input);
    return true;
  } catch {
    return false;
  }
}
function formatSessionLine(prefix, session) {
  return `${prefix} ${session.slug} [mode=${session.mode} status=${session.status} phase=${session.phase}] \u2014 ${session.issue} (updated ${new Date(session.updatedAt).toISOString()})`;
}
function usageText() {
  return [
    "Usage: /gsd debug <issue-text>",
    "       /gsd debug list",
    "       /gsd debug status <slug>",
    "       /gsd debug continue <slug>",
    "       /gsd debug --diagnose [<slug> | <issue text>]"
  ].join("\n");
}
function parseDebugCommand(args) {
  const raw = args.trim();
  if (!raw) return { type: "usage" };
  const parts = raw.split(/\s+/).filter(Boolean);
  const head = parts[0] ?? "";
  if (head === "list") {
    if (parts.length === 1) return { type: "list" };
    return { type: "issue-start", issue: raw };
  }
  if (head === "status") {
    if (parts.length === 1) return { type: "error", message: "Missing slug. Usage: /gsd debug status <slug>" };
    if (parts.length === 2 && isValidSlugCandidate(parts[1])) return { type: "status", slug: parts[1] };
    return { type: "issue-start", issue: raw };
  }
  if (head === "continue") {
    if (parts.length === 1) return { type: "error", message: "Missing slug. Usage: /gsd debug continue <slug>" };
    if (parts.length === 2 && isValidSlugCandidate(parts[1])) return { type: "continue", slug: parts[1] };
    return { type: "issue-start", issue: raw };
  }
  if (head === "--diagnose") {
    if (parts.length === 1) return { type: "diagnose" };
    if (parts.length === 2 && isValidSlugCandidate(parts[1])) return { type: "diagnose", slug: parts[1] };
    if (parts.length >= 3) return { type: "diagnose-issue", issue: parts.slice(1).join(" ") };
    return { type: "error", message: "Invalid diagnose target. Usage: /gsd debug --diagnose [<slug> | <issue text>]" };
  }
  if (head.startsWith("-") && !SUBCOMMANDS.has(head)) {
    return { type: "error", message: `Unknown debug flag: ${head}.
${usageText()}` };
  }
  return { type: "issue-start", issue: raw };
}
async function handleDebug(args, ctx, pi) {
  const parsed = parseDebugCommand(args);
  const basePath = process.cwd();
  if (parsed.type === "usage") {
    ctx.ui.notify(usageText(), "info");
    return;
  }
  if (parsed.type === "error") {
    ctx.ui.notify(parsed.message, "warning");
    return;
  }
  if (parsed.type === "issue-start") {
    const issue = parsed.issue.trim();
    if (!issue) {
      ctx.ui.notify(`Issue text is required.
${usageText()}`, "warning");
      return;
    }
    try {
      const created = createDebugSession(basePath, { issue });
      const s = created.session;
      const canDispatch = pi != null && typeof pi.sendMessage === "function";
      const dispatchNote = canDispatch ? `
dispatchMode=find_and_fix` : "";
      ctx.ui.notify(
        [
          `Debug session started: ${s.slug}`,
          formatSessionLine("Session:", s),
          `Artifact: ${created.artifactPath}`,
          `Log: ${s.logPath}`,
          `Next: /gsd debug status ${s.slug} or /gsd debug continue ${s.slug}`
        ].join("\n") + dispatchNote,
        "info"
      );
      if (canDispatch) {
        try {
          const prompt = loadPrompt("debug-session-manager", {
            goal: "find_and_fix",
            issue: s.issue,
            slug: s.slug,
            mode: s.mode,
            workingDirectory: basePath,
            checkpointContext: "",
            tddContext: "",
            specialistContext: ""
          });
          pi.sendMessage(
            { customType: "gsd-debug-start", content: prompt, display: false },
            { triggerTurn: true }
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(
            `Debug dispatch failed: ${msg}
Session '${s.slug}' is persisted; retry with /gsd debug continue ${s.slug}`,
            "warning"
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Unable to create debug session: ${message}
Try /gsd debug --diagnose for artifact health details.`,
        "error"
      );
    }
    return;
  }
  if (parsed.type === "list") {
    try {
      const listed = listDebugSessions(basePath);
      if (listed.sessions.length === 0 && listed.malformed.length === 0) {
        ctx.ui.notify("No debug sessions found. Start one with: /gsd debug <issue-text>", "info");
        return;
      }
      const lines = [];
      if (listed.sessions.length > 0) {
        lines.push("Debug sessions:");
        for (const record of listed.sessions) {
          lines.push(formatSessionLine("  -", record.session));
        }
      }
      if (listed.malformed.length > 0) {
        lines.push("");
        lines.push(`Malformed artifacts: ${listed.malformed.length}`);
        for (const bad of listed.malformed.slice(0, 5)) {
          lines.push(`  - ${bad.artifactPath} :: ${bad.message}`);
        }
        if (listed.malformed.length > 5) {
          lines.push(`  ... and ${listed.malformed.length - 5} more`);
        }
        lines.push("Run /gsd debug --diagnose for remediation guidance.");
      }
      ctx.ui.notify(lines.join("\n"), "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Unable to list debug sessions: ${message}
Run /gsd debug --diagnose for details.`,
        "warning"
      );
    }
    return;
  }
  if (parsed.type === "status") {
    try {
      const loaded = loadDebugSession(basePath, parsed.slug);
      if (!loaded) {
        ctx.ui.notify(
          `Unknown debug session slug '${parsed.slug}'. Run /gsd debug list to see available sessions.`,
          "warning"
        );
        return;
      }
      const s = loaded.session;
      ctx.ui.notify(
        [
          `Debug session status: ${s.slug}`,
          `mode=${s.mode}`,
          `status=${s.status}`,
          `phase=${s.phase}`,
          `issue=${s.issue}`,
          `artifact=${loaded.artifactPath}`,
          `log=${s.logPath}`,
          `updated=${new Date(s.updatedAt).toISOString()}`,
          `lastError=${s.lastError ?? "none"}`
        ].join("\n"),
        "info"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Unable to load debug session '${parsed.slug}': ${message}
Try /gsd debug --diagnose ${parsed.slug}`,
        "warning"
      );
    }
    return;
  }
  if (parsed.type === "continue") {
    try {
      const loaded = loadDebugSession(basePath, parsed.slug);
      if (!loaded) {
        ctx.ui.notify(
          `Unknown debug session slug '${parsed.slug}'. Run /gsd debug list to see available sessions.`,
          "warning"
        );
        return;
      }
      if (loaded.session.status === "resolved") {
        ctx.ui.notify(
          `Session '${parsed.slug}' is resolved. Open a new session with /gsd debug <issue-text> for follow-up work.`,
          "warning"
        );
        return;
      }
      const checkpoint = loaded.session.checkpoint;
      const tddGate = loaded.session.tddGate;
      const specialistReview = loaded.session.specialistReview;
      const hasCheckpoint = checkpoint != null && checkpoint.awaitingResponse;
      const hasTddGate = tddGate != null && tddGate.enabled;
      let dispatchTemplate = "debug-diagnose";
      let goal = "find_and_fix";
      let dispatchModeLabel = "find_and_fix";
      let checkpointContext = "";
      let tddContext = "";
      let specialistContext = "";
      let tddGateUpdate;
      if (hasCheckpoint || hasTddGate) {
        dispatchTemplate = "debug-session-manager";
        if (hasCheckpoint) {
          const cpLines = [
            `## Active Checkpoint`,
            `- type: ${checkpoint.type}`,
            `- summary: ${checkpoint.summary}`
          ];
          if (checkpoint.userResponse) {
            cpLines.push(`- userResponse:

DATA_START
${checkpoint.userResponse}
DATA_END`);
          } else {
            cpLines.push(`- awaitingResponse: true`);
          }
          checkpointContext = cpLines.join("\n");
          dispatchModeLabel = `checkpointType=${checkpoint.type}`;
        }
        if (hasTddGate) {
          if (tddGate.phase === "red") {
            goal = "find_and_fix";
            const tddLines = [
              `## TDD Gate`,
              `- phase: red \u2192 green`
            ];
            if (tddGate.testFile) tddLines.push(`- testFile: ${tddGate.testFile}`);
            if (tddGate.testName) tddLines.push(`- testName: ${tddGate.testName}`);
            if (tddGate.failureOutput) tddLines.push(`- failureOutput:
${tddGate.failureOutput}`);
            tddLines.push(`The failing test has been confirmed. Proceed to implement the fix that makes this test pass.`);
            tddContext = tddLines.join("\n");
            tddGateUpdate = { ...tddGate, phase: "green" };
            dispatchModeLabel = "tddPhase=red\u2192green";
          } else if (tddGate.phase === "green") {
            goal = "find_and_fix";
            const tddLines = [
              `## TDD Gate`,
              `- phase: green`
            ];
            if (tddGate.testFile) tddLines.push(`- testFile: ${tddGate.testFile}`);
            if (tddGate.testName) tddLines.push(`- testName: ${tddGate.testName}`);
            tddLines.push(`The test is now passing. Continue verifying the fix.`);
            tddContext = tddLines.join("\n");
            dispatchModeLabel = "tddPhase=green";
          } else {
            goal = "find_root_cause_only";
            const tddLines = [
              `## TDD Gate`,
              `- phase: pending`,
              `TDD mode is active. Write a failing test that captures this bug first. Do NOT fix the issue yet.`
            ];
            if (tddGate.testFile) tddLines.push(`- testFile: ${tddGate.testFile}`);
            tddContext = tddLines.join("\n");
            dispatchModeLabel = "tddPhase=pending";
          }
        } else {
          goal = "find_and_fix";
        }
      }
      if (specialistReview != null) {
        specialistContext = [
          `## Prior Specialist Review`,
          `- hint: ${specialistReview.hint}`,
          `- skill: ${specialistReview.skill ?? ""}`,
          `- verdict: ${specialistReview.verdict}`,
          `- detail: ${specialistReview.detail}`
        ].join("\n");
        dispatchModeLabel += ` specialistHint=${specialistReview.hint}`;
      }
      const resumed = updateDebugSession(basePath, parsed.slug, {
        status: "active",
        phase: "continued",
        lastError: null,
        ...tddGateUpdate !== void 0 ? { tddGate: tddGateUpdate } : {}
      });
      const canDispatch = pi != null && typeof pi.sendMessage === "function";
      const dispatchNote = canDispatch ? `
dispatchMode=${dispatchModeLabel}` : "";
      ctx.ui.notify(
        [
          `Resumed debug session: ${resumed.session.slug}`,
          formatSessionLine("Session:", resumed.session),
          `Log: ${resumed.session.logPath}`,
          `Next: /gsd debug status ${resumed.session.slug}`
        ].join("\n") + dispatchNote,
        "info"
      );
      if (canDispatch) {
        try {
          const promptVars = {
            goal,
            issue: resumed.session.issue,
            slug: resumed.session.slug,
            mode: resumed.session.mode,
            workingDirectory: basePath
          };
          if (dispatchTemplate === "debug-session-manager") {
            promptVars.checkpointContext = checkpointContext;
            promptVars.tddContext = tddContext;
            promptVars.specialistContext = specialistContext;
          }
          const prompt = loadPrompt(dispatchTemplate, promptVars);
          pi.sendMessage(
            { customType: "gsd-debug-continue", content: prompt, display: false },
            { triggerTurn: true }
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(
            `Continue dispatch failed: ${msg}
Session '${resumed.session.slug}' is persisted; retry with /gsd debug continue ${resumed.session.slug}`,
            "warning"
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Unable to continue debug session '${parsed.slug}': ${message}
Try /gsd debug --diagnose ${parsed.slug}`,
        "warning"
      );
    }
    return;
  }
  if (parsed.type === "diagnose-issue") {
    const issue = parsed.issue.trim();
    if (!issue) {
      ctx.ui.notify(`Issue text is required.
${usageText()}`, "warning");
      return;
    }
    try {
      const created = createDebugSession(basePath, { issue, mode: "diagnose" });
      const s = created.session;
      ctx.ui.notify(
        [
          `Diagnose session started: ${s.slug}`,
          formatSessionLine("Session:", s),
          `Artifact: ${created.artifactPath}`,
          `Log: ${s.logPath}`,
          `dispatchMode=find_root_cause_only`,
          `Next: /gsd debug status ${s.slug} or /gsd debug --diagnose ${s.slug}`
        ].join("\n"),
        "info"
      );
      if (pi && typeof pi.sendMessage === "function") {
        try {
          const prompt = loadPrompt("debug-diagnose", {
            goal: "find_root_cause_only",
            issue: s.issue,
            slug: s.slug,
            mode: s.mode,
            workingDirectory: basePath
          });
          pi.sendMessage(
            { customType: "gsd-debug-diagnose", content: prompt, display: false },
            { triggerTurn: true }
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(
            `Diagnose dispatch failed: ${msg}
Session '${s.slug}' is persisted; continue manually with /gsd debug continue ${s.slug}`,
            "warning"
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Unable to create diagnose session: ${message}
Try /gsd debug --diagnose for artifact health details.`,
        "error"
      );
    }
    return;
  }
  if (parsed.type === "diagnose") {
    try {
      const listed = listDebugSessions(basePath);
      if (parsed.slug) {
        const loaded = loadDebugSession(basePath, parsed.slug);
        if (!loaded) {
          ctx.ui.notify(
            `Diagnose: session '${parsed.slug}' not found.
Run /gsd debug list to discover valid slugs.`,
            "warning"
          );
          return;
        }
        const s = loaded.session;
        ctx.ui.notify(
          [
            `Diagnose session: ${s.slug}`,
            `mode=${s.mode}`,
            `status=${s.status}`,
            `phase=${s.phase}`,
            `artifact=${loaded.artifactPath}`,
            `log=${s.logPath}`,
            `lastError=${s.lastError ?? "none"}`,
            `malformedArtifactsInStore=${listed.malformed.length}`
          ].join("\n"),
          "info"
        );
        return;
      }
      const lines = [
        "Debug session diagnostics:",
        `healthySessions=${listed.sessions.length}`,
        `malformedArtifacts=${listed.malformed.length}`
      ];
      if (listed.malformed.length > 0) {
        lines.push("");
        lines.push("Malformed artifacts (first 10):");
        for (const malformed of listed.malformed.slice(0, 10)) {
          lines.push(`  - ${malformed.artifactPath}`);
          lines.push(`    ${malformed.message}`);
        }
        lines.push("Remediation: repair/remove malformed JSON artifacts under .gsd/debug/sessions/.");
      }
      ctx.ui.notify(lines.join("\n"), listed.malformed.length > 0 ? "warning" : "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Diagnose failed: ${message}`, "error");
    }
  }
}
export {
  handleDebug,
  parseDebugCommand
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy1kZWJ1Zy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEksIEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5cbmltcG9ydCB7XG4gIGFzc2VydFZhbGlkRGVidWdTZXNzaW9uU2x1ZyxcbiAgY3JlYXRlRGVidWdTZXNzaW9uLFxuICBsaXN0RGVidWdTZXNzaW9ucyxcbiAgbG9hZERlYnVnU2Vzc2lvbixcbiAgdXBkYXRlRGVidWdTZXNzaW9uLFxuICB0eXBlIERlYnVnVGRkR2F0ZSxcbiAgdHlwZSBEZWJ1Z1NwZWNpYWxpc3RSZXZpZXcsXG59IGZyb20gXCIuL2RlYnVnLXNlc3Npb24tc3RvcmUuanNcIjtcbmltcG9ydCB7IGxvYWRQcm9tcHQgfSBmcm9tIFwiLi9wcm9tcHQtbG9hZGVyLmpzXCI7XG5cbmV4cG9ydCB0eXBlIERlYnVnQ29tbWFuZEludGVudFxuICA9IHsgdHlwZTogXCJ1c2FnZVwiIH1cbiAgfCB7IHR5cGU6IFwiaXNzdWUtc3RhcnRcIjsgaXNzdWU6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcImxpc3RcIiB9XG4gIHwgeyB0eXBlOiBcInN0YXR1c1wiOyBzbHVnOiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJjb250aW51ZVwiOyBzbHVnOiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJkaWFnbm9zZVwiOyBzbHVnPzogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwiZGlhZ25vc2UtaXNzdWVcIjsgaXNzdWU6IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcImVycm9yXCI7IG1lc3NhZ2U6IHN0cmluZyB9O1xuXG5jb25zdCBTVUJDT01NQU5EUyA9IG5ldyBTZXQoW1wibGlzdFwiLCBcInN0YXR1c1wiLCBcImNvbnRpbnVlXCIsIFwiLS1kaWFnbm9zZVwiXSk7XG5cbmZ1bmN0aW9uIGlzVmFsaWRTbHVnQ2FuZGlkYXRlKGlucHV0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBhc3NlcnRWYWxpZERlYnVnU2Vzc2lvblNsdWcoaW5wdXQpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuZnVuY3Rpb24gZm9ybWF0U2Vzc2lvbkxpbmUocHJlZml4OiBzdHJpbmcsIHNlc3Npb246IHtcbiAgc2x1Zzogc3RyaW5nO1xuICBtb2RlOiBzdHJpbmc7XG4gIHN0YXR1czogc3RyaW5nO1xuICBwaGFzZTogc3RyaW5nO1xuICBpc3N1ZTogc3RyaW5nO1xuICB1cGRhdGVkQXQ6IG51bWJlcjtcbn0pOiBzdHJpbmcge1xuICByZXR1cm4gYCR7cHJlZml4fSAke3Nlc3Npb24uc2x1Z30gW21vZGU9JHtzZXNzaW9uLm1vZGV9IHN0YXR1cz0ke3Nlc3Npb24uc3RhdHVzfSBwaGFzZT0ke3Nlc3Npb24ucGhhc2V9XSBcdTIwMTQgJHtzZXNzaW9uLmlzc3VlfSAodXBkYXRlZCAke25ldyBEYXRlKHNlc3Npb24udXBkYXRlZEF0KS50b0lTT1N0cmluZygpfSlgO1xufVxuXG5mdW5jdGlvbiB1c2FnZVRleHQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBcIlVzYWdlOiAvZ3NkIGRlYnVnIDxpc3N1ZS10ZXh0PlwiLFxuICAgIFwiICAgICAgIC9nc2QgZGVidWcgbGlzdFwiLFxuICAgIFwiICAgICAgIC9nc2QgZGVidWcgc3RhdHVzIDxzbHVnPlwiLFxuICAgIFwiICAgICAgIC9nc2QgZGVidWcgY29udGludWUgPHNsdWc+XCIsXG4gICAgXCIgICAgICAgL2dzZCBkZWJ1ZyAtLWRpYWdub3NlIFs8c2x1Zz4gfCA8aXNzdWUgdGV4dD5dXCIsXG4gIF0uam9pbihcIlxcblwiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlRGVidWdDb21tYW5kKGFyZ3M6IHN0cmluZyk6IERlYnVnQ29tbWFuZEludGVudCB7XG4gIGNvbnN0IHJhdyA9IGFyZ3MudHJpbSgpO1xuICBpZiAoIXJhdykgcmV0dXJuIHsgdHlwZTogXCJ1c2FnZVwiIH07XG5cbiAgY29uc3QgcGFydHMgPSByYXcuc3BsaXQoL1xccysvKS5maWx0ZXIoQm9vbGVhbik7XG4gIGNvbnN0IGhlYWQgPSBwYXJ0c1swXSA/PyBcIlwiO1xuXG4gIGlmIChoZWFkID09PSBcImxpc3RcIikge1xuICAgIC8vIFN0cmljdCBtYXRjaCBvbmx5OyBvdGhlcndpc2UgdHJlYXQgYXMgaXNzdWUgdGV4dCBmb3IgZGV0ZXJtaW5pc3RpYyBmYWxsYmFjayBiZWhhdmlvci5cbiAgICBpZiAocGFydHMubGVuZ3RoID09PSAxKSByZXR1cm4geyB0eXBlOiBcImxpc3RcIiB9O1xuICAgIHJldHVybiB7IHR5cGU6IFwiaXNzdWUtc3RhcnRcIiwgaXNzdWU6IHJhdyB9O1xuICB9XG5cbiAgaWYgKGhlYWQgPT09IFwic3RhdHVzXCIpIHtcbiAgICBpZiAocGFydHMubGVuZ3RoID09PSAxKSByZXR1cm4geyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IFwiTWlzc2luZyBzbHVnLiBVc2FnZTogL2dzZCBkZWJ1ZyBzdGF0dXMgPHNsdWc+XCIgfTtcbiAgICBpZiAocGFydHMubGVuZ3RoID09PSAyICYmIGlzVmFsaWRTbHVnQ2FuZGlkYXRlKHBhcnRzWzFdKSkgcmV0dXJuIHsgdHlwZTogXCJzdGF0dXNcIiwgc2x1ZzogcGFydHNbMV0gfTtcbiAgICByZXR1cm4geyB0eXBlOiBcImlzc3VlLXN0YXJ0XCIsIGlzc3VlOiByYXcgfTtcbiAgfVxuXG4gIGlmIChoZWFkID09PSBcImNvbnRpbnVlXCIpIHtcbiAgICBpZiAocGFydHMubGVuZ3RoID09PSAxKSByZXR1cm4geyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IFwiTWlzc2luZyBzbHVnLiBVc2FnZTogL2dzZCBkZWJ1ZyBjb250aW51ZSA8c2x1Zz5cIiB9O1xuICAgIGlmIChwYXJ0cy5sZW5ndGggPT09IDIgJiYgaXNWYWxpZFNsdWdDYW5kaWRhdGUocGFydHNbMV0pKSByZXR1cm4geyB0eXBlOiBcImNvbnRpbnVlXCIsIHNsdWc6IHBhcnRzWzFdIH07XG4gICAgcmV0dXJuIHsgdHlwZTogXCJpc3N1ZS1zdGFydFwiLCBpc3N1ZTogcmF3IH07XG4gIH1cblxuICBpZiAoaGVhZCA9PT0gXCItLWRpYWdub3NlXCIpIHtcbiAgICBpZiAocGFydHMubGVuZ3RoID09PSAxKSByZXR1cm4geyB0eXBlOiBcImRpYWdub3NlXCIgfTtcbiAgICBpZiAocGFydHMubGVuZ3RoID09PSAyICYmIGlzVmFsaWRTbHVnQ2FuZGlkYXRlKHBhcnRzWzFdKSkgcmV0dXJuIHsgdHlwZTogXCJkaWFnbm9zZVwiLCBzbHVnOiBwYXJ0c1sxXSB9O1xuICAgIGlmIChwYXJ0cy5sZW5ndGggPj0gMykgcmV0dXJuIHsgdHlwZTogXCJkaWFnbm9zZS1pc3N1ZVwiLCBpc3N1ZTogcGFydHMuc2xpY2UoMSkuam9pbihcIiBcIikgfTtcbiAgICByZXR1cm4geyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IFwiSW52YWxpZCBkaWFnbm9zZSB0YXJnZXQuIFVzYWdlOiAvZ3NkIGRlYnVnIC0tZGlhZ25vc2UgWzxzbHVnPiB8IDxpc3N1ZSB0ZXh0Pl1cIiB9O1xuICB9XG5cbiAgaWYgKGhlYWQuc3RhcnRzV2l0aChcIi1cIikgJiYgIVNVQkNPTU1BTkRTLmhhcyhoZWFkKSkge1xuICAgIHJldHVybiB7IHR5cGU6IFwiZXJyb3JcIiwgbWVzc2FnZTogYFVua25vd24gZGVidWcgZmxhZzogJHtoZWFkfS5cXG4ke3VzYWdlVGV4dCgpfWAgfTtcbiAgfVxuXG4gIHJldHVybiB7IHR5cGU6IFwiaXNzdWUtc3RhcnRcIiwgaXNzdWU6IHJhdyB9O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlRGVidWcoYXJnczogc3RyaW5nLCBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LCBwaT86IEV4dGVuc2lvbkFQSSk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBwYXJzZWQgPSBwYXJzZURlYnVnQ29tbWFuZChhcmdzKTtcbiAgY29uc3QgYmFzZVBhdGggPSBwcm9jZXNzLmN3ZCgpO1xuXG4gIGlmIChwYXJzZWQudHlwZSA9PT0gXCJ1c2FnZVwiKSB7XG4gICAgY3R4LnVpLm5vdGlmeSh1c2FnZVRleHQoKSwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChwYXJzZWQudHlwZSA9PT0gXCJlcnJvclwiKSB7XG4gICAgY3R4LnVpLm5vdGlmeShwYXJzZWQubWVzc2FnZSwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChwYXJzZWQudHlwZSA9PT0gXCJpc3N1ZS1zdGFydFwiKSB7XG4gICAgY29uc3QgaXNzdWUgPSBwYXJzZWQuaXNzdWUudHJpbSgpO1xuICAgIGlmICghaXNzdWUpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoYElzc3VlIHRleHQgaXMgcmVxdWlyZWQuXFxuJHt1c2FnZVRleHQoKX1gLCBcIndhcm5pbmdcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNyZWF0ZWQgPSBjcmVhdGVEZWJ1Z1Nlc3Npb24oYmFzZVBhdGgsIHsgaXNzdWUgfSk7XG4gICAgICBjb25zdCBzID0gY3JlYXRlZC5zZXNzaW9uO1xuICAgICAgY29uc3QgY2FuRGlzcGF0Y2ggPSBwaSAhPSBudWxsICYmIHR5cGVvZiAocGkgYXMgRXh0ZW5zaW9uQVBJKS5zZW5kTWVzc2FnZSA9PT0gXCJmdW5jdGlvblwiO1xuICAgICAgY29uc3QgZGlzcGF0Y2hOb3RlID0gY2FuRGlzcGF0Y2ggPyBgXFxuZGlzcGF0Y2hNb2RlPWZpbmRfYW5kX2ZpeGAgOiBcIlwiO1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgW1xuICAgICAgICAgIGBEZWJ1ZyBzZXNzaW9uIHN0YXJ0ZWQ6ICR7cy5zbHVnfWAsXG4gICAgICAgICAgZm9ybWF0U2Vzc2lvbkxpbmUoXCJTZXNzaW9uOlwiLCBzKSxcbiAgICAgICAgICBgQXJ0aWZhY3Q6ICR7Y3JlYXRlZC5hcnRpZmFjdFBhdGh9YCxcbiAgICAgICAgICBgTG9nOiAke3MubG9nUGF0aH1gLFxuICAgICAgICAgIGBOZXh0OiAvZ3NkIGRlYnVnIHN0YXR1cyAke3Muc2x1Z30gb3IgL2dzZCBkZWJ1ZyBjb250aW51ZSAke3Muc2x1Z31gLFxuICAgICAgICBdLmpvaW4oXCJcXG5cIikgKyBkaXNwYXRjaE5vdGUsXG4gICAgICAgIFwiaW5mb1wiLFxuICAgICAgKTtcbiAgICAgIGlmIChjYW5EaXNwYXRjaCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHByb21wdCA9IGxvYWRQcm9tcHQoXCJkZWJ1Zy1zZXNzaW9uLW1hbmFnZXJcIiwge1xuICAgICAgICAgICAgZ29hbDogXCJmaW5kX2FuZF9maXhcIixcbiAgICAgICAgICAgIGlzc3VlOiBzLmlzc3VlLFxuICAgICAgICAgICAgc2x1Zzogcy5zbHVnLFxuICAgICAgICAgICAgbW9kZTogcy5tb2RlLFxuICAgICAgICAgICAgd29ya2luZ0RpcmVjdG9yeTogYmFzZVBhdGgsXG4gICAgICAgICAgICBjaGVja3BvaW50Q29udGV4dDogXCJcIixcbiAgICAgICAgICAgIHRkZENvbnRleHQ6IFwiXCIsXG4gICAgICAgICAgICBzcGVjaWFsaXN0Q29udGV4dDogXCJcIixcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBwaS5zZW5kTWVzc2FnZShcbiAgICAgICAgICAgIHsgY3VzdG9tVHlwZTogXCJnc2QtZGVidWctc3RhcnRcIiwgY29udGVudDogcHJvbXB0LCBkaXNwbGF5OiBmYWxzZSB9LFxuICAgICAgICAgICAgeyB0cmlnZ2VyVHVybjogdHJ1ZSB9LFxuICAgICAgICAgICk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgYERlYnVnIGRpc3BhdGNoIGZhaWxlZDogJHttc2d9XFxuU2Vzc2lvbiAnJHtzLnNsdWd9JyBpcyBwZXJzaXN0ZWQ7IHJldHJ5IHdpdGggL2dzZCBkZWJ1ZyBjb250aW51ZSAke3Muc2x1Z31gLFxuICAgICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgYFVuYWJsZSB0byBjcmVhdGUgZGVidWcgc2Vzc2lvbjogJHttZXNzYWdlfVxcblRyeSAvZ3NkIGRlYnVnIC0tZGlhZ25vc2UgZm9yIGFydGlmYWN0IGhlYWx0aCBkZXRhaWxzLmAsXG4gICAgICAgIFwiZXJyb3JcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChwYXJzZWQudHlwZSA9PT0gXCJsaXN0XCIpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgbGlzdGVkID0gbGlzdERlYnVnU2Vzc2lvbnMoYmFzZVBhdGgpO1xuICAgICAgaWYgKGxpc3RlZC5zZXNzaW9ucy5sZW5ndGggPT09IDAgJiYgbGlzdGVkLm1hbGZvcm1lZC5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcIk5vIGRlYnVnIHNlc3Npb25zIGZvdW5kLiBTdGFydCBvbmUgd2l0aDogL2dzZCBkZWJ1ZyA8aXNzdWUtdGV4dD5cIiwgXCJpbmZvXCIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgaWYgKGxpc3RlZC5zZXNzaW9ucy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGxpbmVzLnB1c2goXCJEZWJ1ZyBzZXNzaW9uczpcIik7XG4gICAgICAgIGZvciAoY29uc3QgcmVjb3JkIG9mIGxpc3RlZC5zZXNzaW9ucykge1xuICAgICAgICAgIGxpbmVzLnB1c2goZm9ybWF0U2Vzc2lvbkxpbmUoXCIgIC1cIiwgcmVjb3JkLnNlc3Npb24pKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAobGlzdGVkLm1hbGZvcm1lZC5sZW5ndGggPiAwKSB7XG4gICAgICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgICAgIGxpbmVzLnB1c2goYE1hbGZvcm1lZCBhcnRpZmFjdHM6ICR7bGlzdGVkLm1hbGZvcm1lZC5sZW5ndGh9YCk7XG4gICAgICAgIGZvciAoY29uc3QgYmFkIG9mIGxpc3RlZC5tYWxmb3JtZWQuc2xpY2UoMCwgNSkpIHtcbiAgICAgICAgICBsaW5lcy5wdXNoKGAgIC0gJHtiYWQuYXJ0aWZhY3RQYXRofSA6OiAke2JhZC5tZXNzYWdlfWApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChsaXN0ZWQubWFsZm9ybWVkLmxlbmd0aCA+IDUpIHtcbiAgICAgICAgICBsaW5lcy5wdXNoKGAgIC4uLiBhbmQgJHtsaXN0ZWQubWFsZm9ybWVkLmxlbmd0aCAtIDV9IG1vcmVgKTtcbiAgICAgICAgfVxuICAgICAgICBsaW5lcy5wdXNoKFwiUnVuIC9nc2QgZGVidWcgLS1kaWFnbm9zZSBmb3IgcmVtZWRpYXRpb24gZ3VpZGFuY2UuXCIpO1xuICAgICAgfVxuXG4gICAgICBjdHgudWkubm90aWZ5KGxpbmVzLmpvaW4oXCJcXG5cIiksIFwiaW5mb1wiKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBVbmFibGUgdG8gbGlzdCBkZWJ1ZyBzZXNzaW9uczogJHttZXNzYWdlfVxcblJ1biAvZ3NkIGRlYnVnIC0tZGlhZ25vc2UgZm9yIGRldGFpbHMuYCxcbiAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAocGFyc2VkLnR5cGUgPT09IFwic3RhdHVzXCIpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgbG9hZGVkID0gbG9hZERlYnVnU2Vzc2lvbihiYXNlUGF0aCwgcGFyc2VkLnNsdWcpO1xuICAgICAgaWYgKCFsb2FkZWQpIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBgVW5rbm93biBkZWJ1ZyBzZXNzaW9uIHNsdWcgJyR7cGFyc2VkLnNsdWd9Jy4gUnVuIC9nc2QgZGVidWcgbGlzdCB0byBzZWUgYXZhaWxhYmxlIHNlc3Npb25zLmAsXG4gICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcyA9IGxvYWRlZC5zZXNzaW9uO1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgW1xuICAgICAgICAgIGBEZWJ1ZyBzZXNzaW9uIHN0YXR1czogJHtzLnNsdWd9YCxcbiAgICAgICAgICBgbW9kZT0ke3MubW9kZX1gLFxuICAgICAgICAgIGBzdGF0dXM9JHtzLnN0YXR1c31gLFxuICAgICAgICAgIGBwaGFzZT0ke3MucGhhc2V9YCxcbiAgICAgICAgICBgaXNzdWU9JHtzLmlzc3VlfWAsXG4gICAgICAgICAgYGFydGlmYWN0PSR7bG9hZGVkLmFydGlmYWN0UGF0aH1gLFxuICAgICAgICAgIGBsb2c9JHtzLmxvZ1BhdGh9YCxcbiAgICAgICAgICBgdXBkYXRlZD0ke25ldyBEYXRlKHMudXBkYXRlZEF0KS50b0lTT1N0cmluZygpfWAsXG4gICAgICAgICAgYGxhc3RFcnJvcj0ke3MubGFzdEVycm9yID8/IFwibm9uZVwifWAsXG4gICAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICAgICAgXCJpbmZvXCIsXG4gICAgICApO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgYFVuYWJsZSB0byBsb2FkIGRlYnVnIHNlc3Npb24gJyR7cGFyc2VkLnNsdWd9JzogJHttZXNzYWdlfVxcblRyeSAvZ3NkIGRlYnVnIC0tZGlhZ25vc2UgJHtwYXJzZWQuc2x1Z31gLFxuICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChwYXJzZWQudHlwZSA9PT0gXCJjb250aW51ZVwiKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGxvYWRlZCA9IGxvYWREZWJ1Z1Nlc3Npb24oYmFzZVBhdGgsIHBhcnNlZC5zbHVnKTtcbiAgICAgIGlmICghbG9hZGVkKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgYFVua25vd24gZGVidWcgc2Vzc2lvbiBzbHVnICcke3BhcnNlZC5zbHVnfScuIFJ1biAvZ3NkIGRlYnVnIGxpc3QgdG8gc2VlIGF2YWlsYWJsZSBzZXNzaW9ucy5gLFxuICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGlmIChsb2FkZWQuc2Vzc2lvbi5zdGF0dXMgPT09IFwicmVzb2x2ZWRcIikge1xuICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgIGBTZXNzaW9uICcke3BhcnNlZC5zbHVnfScgaXMgcmVzb2x2ZWQuIE9wZW4gYSBuZXcgc2Vzc2lvbiB3aXRoIC9nc2QgZGVidWcgPGlzc3VlLXRleHQ+IGZvciBmb2xsb3ctdXAgd29yay5gLFxuICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIC8vIERldGVybWluZSBjaGVja3BvaW50L1RERC9zcGVjaWFsaXN0IGRpc3BhdGNoIGNvbnRleHQgYmVmb3JlIHVwZGF0aW5nIHNlc3Npb24gc3RhdGUuXG4gICAgICBjb25zdCBjaGVja3BvaW50ID0gbG9hZGVkLnNlc3Npb24uY2hlY2twb2ludDtcbiAgICAgIGNvbnN0IHRkZEdhdGUgPSBsb2FkZWQuc2Vzc2lvbi50ZGRHYXRlO1xuICAgICAgY29uc3Qgc3BlY2lhbGlzdFJldmlldzogRGVidWdTcGVjaWFsaXN0UmV2aWV3IHwgbnVsbCB8IHVuZGVmaW5lZCA9IGxvYWRlZC5zZXNzaW9uLnNwZWNpYWxpc3RSZXZpZXc7XG4gICAgICBjb25zdCBoYXNDaGVja3BvaW50ID0gY2hlY2twb2ludCAhPSBudWxsICYmIGNoZWNrcG9pbnQuYXdhaXRpbmdSZXNwb25zZTtcbiAgICAgIGNvbnN0IGhhc1RkZEdhdGUgPSB0ZGRHYXRlICE9IG51bGwgJiYgdGRkR2F0ZS5lbmFibGVkO1xuXG4gICAgICBsZXQgZGlzcGF0Y2hUZW1wbGF0ZSA9IFwiZGVidWctZGlhZ25vc2VcIjtcbiAgICAgIGxldCBnb2FsID0gXCJmaW5kX2FuZF9maXhcIjtcbiAgICAgIGxldCBkaXNwYXRjaE1vZGVMYWJlbCA9IFwiZmluZF9hbmRfZml4XCI7XG4gICAgICBsZXQgY2hlY2twb2ludENvbnRleHQgPSBcIlwiO1xuICAgICAgbGV0IHRkZENvbnRleHQgPSBcIlwiO1xuICAgICAgbGV0IHNwZWNpYWxpc3RDb250ZXh0ID0gXCJcIjtcbiAgICAgIGxldCB0ZGRHYXRlVXBkYXRlOiBEZWJ1Z1RkZEdhdGUgfCB1bmRlZmluZWQ7XG5cbiAgICAgIGlmIChoYXNDaGVja3BvaW50IHx8IGhhc1RkZEdhdGUpIHtcbiAgICAgICAgZGlzcGF0Y2hUZW1wbGF0ZSA9IFwiZGVidWctc2Vzc2lvbi1tYW5hZ2VyXCI7XG5cbiAgICAgICAgaWYgKGhhc0NoZWNrcG9pbnQpIHtcbiAgICAgICAgICBjb25zdCBjcExpbmVzID0gW1xuICAgICAgICAgICAgYCMjIEFjdGl2ZSBDaGVja3BvaW50YCxcbiAgICAgICAgICAgIGAtIHR5cGU6ICR7Y2hlY2twb2ludC50eXBlfWAsXG4gICAgICAgICAgICBgLSBzdW1tYXJ5OiAke2NoZWNrcG9pbnQuc3VtbWFyeX1gLFxuICAgICAgICAgIF07XG4gICAgICAgICAgaWYgKGNoZWNrcG9pbnQudXNlclJlc3BvbnNlKSB7XG4gICAgICAgICAgICBjcExpbmVzLnB1c2goYC0gdXNlclJlc3BvbnNlOlxcblxcbkRBVEFfU1RBUlRcXG4ke2NoZWNrcG9pbnQudXNlclJlc3BvbnNlfVxcbkRBVEFfRU5EYCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNwTGluZXMucHVzaChgLSBhd2FpdGluZ1Jlc3BvbnNlOiB0cnVlYCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNoZWNrcG9pbnRDb250ZXh0ID0gY3BMaW5lcy5qb2luKFwiXFxuXCIpO1xuICAgICAgICAgIGRpc3BhdGNoTW9kZUxhYmVsID0gYGNoZWNrcG9pbnRUeXBlPSR7Y2hlY2twb2ludC50eXBlfWA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaGFzVGRkR2F0ZSkge1xuICAgICAgICAgIGlmICh0ZGRHYXRlLnBoYXNlID09PSBcInJlZFwiKSB7XG4gICAgICAgICAgICBnb2FsID0gXCJmaW5kX2FuZF9maXhcIjtcbiAgICAgICAgICAgIGNvbnN0IHRkZExpbmVzID0gW1xuICAgICAgICAgICAgICBgIyMgVEREIEdhdGVgLFxuICAgICAgICAgICAgICBgLSBwaGFzZTogcmVkIFx1MjE5MiBncmVlbmAsXG4gICAgICAgICAgICBdO1xuICAgICAgICAgICAgaWYgKHRkZEdhdGUudGVzdEZpbGUpIHRkZExpbmVzLnB1c2goYC0gdGVzdEZpbGU6ICR7dGRkR2F0ZS50ZXN0RmlsZX1gKTtcbiAgICAgICAgICAgIGlmICh0ZGRHYXRlLnRlc3ROYW1lKSB0ZGRMaW5lcy5wdXNoKGAtIHRlc3ROYW1lOiAke3RkZEdhdGUudGVzdE5hbWV9YCk7XG4gICAgICAgICAgICBpZiAodGRkR2F0ZS5mYWlsdXJlT3V0cHV0KSB0ZGRMaW5lcy5wdXNoKGAtIGZhaWx1cmVPdXRwdXQ6XFxuJHt0ZGRHYXRlLmZhaWx1cmVPdXRwdXR9YCk7XG4gICAgICAgICAgICB0ZGRMaW5lcy5wdXNoKGBUaGUgZmFpbGluZyB0ZXN0IGhhcyBiZWVuIGNvbmZpcm1lZC4gUHJvY2VlZCB0byBpbXBsZW1lbnQgdGhlIGZpeCB0aGF0IG1ha2VzIHRoaXMgdGVzdCBwYXNzLmApO1xuICAgICAgICAgICAgdGRkQ29udGV4dCA9IHRkZExpbmVzLmpvaW4oXCJcXG5cIik7XG4gICAgICAgICAgICB0ZGRHYXRlVXBkYXRlID0geyAuLi50ZGRHYXRlLCBwaGFzZTogXCJncmVlblwiIH07XG4gICAgICAgICAgICBkaXNwYXRjaE1vZGVMYWJlbCA9IFwidGRkUGhhc2U9cmVkXHUyMTkyZ3JlZW5cIjtcbiAgICAgICAgICB9IGVsc2UgaWYgKHRkZEdhdGUucGhhc2UgPT09IFwiZ3JlZW5cIikge1xuICAgICAgICAgICAgZ29hbCA9IFwiZmluZF9hbmRfZml4XCI7XG4gICAgICAgICAgICBjb25zdCB0ZGRMaW5lcyA9IFtcbiAgICAgICAgICAgICAgYCMjIFRERCBHYXRlYCxcbiAgICAgICAgICAgICAgYC0gcGhhc2U6IGdyZWVuYCxcbiAgICAgICAgICAgIF07XG4gICAgICAgICAgICBpZiAodGRkR2F0ZS50ZXN0RmlsZSkgdGRkTGluZXMucHVzaChgLSB0ZXN0RmlsZTogJHt0ZGRHYXRlLnRlc3RGaWxlfWApO1xuICAgICAgICAgICAgaWYgKHRkZEdhdGUudGVzdE5hbWUpIHRkZExpbmVzLnB1c2goYC0gdGVzdE5hbWU6ICR7dGRkR2F0ZS50ZXN0TmFtZX1gKTtcbiAgICAgICAgICAgIHRkZExpbmVzLnB1c2goYFRoZSB0ZXN0IGlzIG5vdyBwYXNzaW5nLiBDb250aW51ZSB2ZXJpZnlpbmcgdGhlIGZpeC5gKTtcbiAgICAgICAgICAgIHRkZENvbnRleHQgPSB0ZGRMaW5lcy5qb2luKFwiXFxuXCIpO1xuICAgICAgICAgICAgZGlzcGF0Y2hNb2RlTGFiZWwgPSBcInRkZFBoYXNlPWdyZWVuXCI7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIHBoYXNlID09PSBcInBlbmRpbmdcIjogaW52ZXN0aWdhdGUgb25seSwgZG8gbm90IGZpeCB5ZXRcbiAgICAgICAgICAgIGdvYWwgPSBcImZpbmRfcm9vdF9jYXVzZV9vbmx5XCI7XG4gICAgICAgICAgICBjb25zdCB0ZGRMaW5lcyA9IFtcbiAgICAgICAgICAgICAgYCMjIFRERCBHYXRlYCxcbiAgICAgICAgICAgICAgYC0gcGhhc2U6IHBlbmRpbmdgLFxuICAgICAgICAgICAgICBgVEREIG1vZGUgaXMgYWN0aXZlLiBXcml0ZSBhIGZhaWxpbmcgdGVzdCB0aGF0IGNhcHR1cmVzIHRoaXMgYnVnIGZpcnN0LiBEbyBOT1QgZml4IHRoZSBpc3N1ZSB5ZXQuYCxcbiAgICAgICAgICAgIF07XG4gICAgICAgICAgICBpZiAodGRkR2F0ZS50ZXN0RmlsZSkgdGRkTGluZXMucHVzaChgLSB0ZXN0RmlsZTogJHt0ZGRHYXRlLnRlc3RGaWxlfWApO1xuICAgICAgICAgICAgdGRkQ29udGV4dCA9IHRkZExpbmVzLmpvaW4oXCJcXG5cIik7XG4gICAgICAgICAgICBkaXNwYXRjaE1vZGVMYWJlbCA9IFwidGRkUGhhc2U9cGVuZGluZ1wiO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBDaGVja3BvaW50IG9ubHksIG5vIFRERCBnYXRlIFx1MjAxNCBhcHBseSBmaXggYWZ0ZXIgaHVtYW4gcmVzcG9uc2VcbiAgICAgICAgICBnb2FsID0gXCJmaW5kX2FuZF9maXhcIjtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBCdWlsZCBzcGVjaWFsaXN0Q29udGV4dCBmcm9tIHNlc3Npb24ncyBzcGVjaWFsaXN0UmV2aWV3IGZpZWxkIChudWxsL3VuZGVmaW5lZCBcdTIxOTIgZW1wdHkgc3RyaW5nKS5cbiAgICAgIGlmIChzcGVjaWFsaXN0UmV2aWV3ICE9IG51bGwpIHtcbiAgICAgICAgc3BlY2lhbGlzdENvbnRleHQgPSBbXG4gICAgICAgICAgYCMjIFByaW9yIFNwZWNpYWxpc3QgUmV2aWV3YCxcbiAgICAgICAgICBgLSBoaW50OiAke3NwZWNpYWxpc3RSZXZpZXcuaGludH1gLFxuICAgICAgICAgIGAtIHNraWxsOiAke3NwZWNpYWxpc3RSZXZpZXcuc2tpbGwgPz8gXCJcIn1gLFxuICAgICAgICAgIGAtIHZlcmRpY3Q6ICR7c3BlY2lhbGlzdFJldmlldy52ZXJkaWN0fWAsXG4gICAgICAgICAgYC0gZGV0YWlsOiAke3NwZWNpYWxpc3RSZXZpZXcuZGV0YWlsfWAsXG4gICAgICAgIF0uam9pbihcIlxcblwiKTtcbiAgICAgICAgZGlzcGF0Y2hNb2RlTGFiZWwgKz0gYCBzcGVjaWFsaXN0SGludD0ke3NwZWNpYWxpc3RSZXZpZXcuaGludH1gO1xuICAgICAgfVxuXG4gICAgICAvLyBVcGRhdGUgc2Vzc2lvbiBzdGF0ZSBCRUZPUkUgZGlzcGF0Y2ggXHUyMDE0IGhhbmRsZXIgcmV0dXJucyBhZnRlciBzZW5kTWVzc2FnZS5cbiAgICAgIGNvbnN0IHJlc3VtZWQgPSB1cGRhdGVEZWJ1Z1Nlc3Npb24oYmFzZVBhdGgsIHBhcnNlZC5zbHVnLCB7XG4gICAgICAgIHN0YXR1czogXCJhY3RpdmVcIixcbiAgICAgICAgcGhhc2U6IFwiY29udGludWVkXCIsXG4gICAgICAgIGxhc3RFcnJvcjogbnVsbCxcbiAgICAgICAgLi4uKHRkZEdhdGVVcGRhdGUgIT09IHVuZGVmaW5lZCA/IHsgdGRkR2F0ZTogdGRkR2F0ZVVwZGF0ZSB9IDoge30pLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IGNhbkRpc3BhdGNoID0gcGkgIT0gbnVsbCAmJiB0eXBlb2YgKHBpIGFzIEV4dGVuc2lvbkFQSSkuc2VuZE1lc3NhZ2UgPT09IFwiZnVuY3Rpb25cIjtcbiAgICAgIGNvbnN0IGRpc3BhdGNoTm90ZSA9IGNhbkRpc3BhdGNoID8gYFxcbmRpc3BhdGNoTW9kZT0ke2Rpc3BhdGNoTW9kZUxhYmVsfWAgOiBcIlwiO1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgW1xuICAgICAgICAgIGBSZXN1bWVkIGRlYnVnIHNlc3Npb246ICR7cmVzdW1lZC5zZXNzaW9uLnNsdWd9YCxcbiAgICAgICAgICBmb3JtYXRTZXNzaW9uTGluZShcIlNlc3Npb246XCIsIHJlc3VtZWQuc2Vzc2lvbiksXG4gICAgICAgICAgYExvZzogJHtyZXN1bWVkLnNlc3Npb24ubG9nUGF0aH1gLFxuICAgICAgICAgIGBOZXh0OiAvZ3NkIGRlYnVnIHN0YXR1cyAke3Jlc3VtZWQuc2Vzc2lvbi5zbHVnfWAsXG4gICAgICAgIF0uam9pbihcIlxcblwiKSArIGRpc3BhdGNoTm90ZSxcbiAgICAgICAgXCJpbmZvXCIsXG4gICAgICApO1xuXG4gICAgICBpZiAoY2FuRGlzcGF0Y2gpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBwcm9tcHRWYXJzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgICAgICAgICAgZ29hbCxcbiAgICAgICAgICAgIGlzc3VlOiByZXN1bWVkLnNlc3Npb24uaXNzdWUsXG4gICAgICAgICAgICBzbHVnOiByZXN1bWVkLnNlc3Npb24uc2x1ZyxcbiAgICAgICAgICAgIG1vZGU6IHJlc3VtZWQuc2Vzc2lvbi5tb2RlLFxuICAgICAgICAgICAgd29ya2luZ0RpcmVjdG9yeTogYmFzZVBhdGgsXG4gICAgICAgICAgfTtcbiAgICAgICAgICBpZiAoZGlzcGF0Y2hUZW1wbGF0ZSA9PT0gXCJkZWJ1Zy1zZXNzaW9uLW1hbmFnZXJcIikge1xuICAgICAgICAgICAgcHJvbXB0VmFycy5jaGVja3BvaW50Q29udGV4dCA9IGNoZWNrcG9pbnRDb250ZXh0O1xuICAgICAgICAgICAgcHJvbXB0VmFycy50ZGRDb250ZXh0ID0gdGRkQ29udGV4dDtcbiAgICAgICAgICAgIHByb21wdFZhcnMuc3BlY2lhbGlzdENvbnRleHQgPSBzcGVjaWFsaXN0Q29udGV4dDtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgcHJvbXB0ID0gbG9hZFByb21wdChkaXNwYXRjaFRlbXBsYXRlLCBwcm9tcHRWYXJzKTtcbiAgICAgICAgICBwaS5zZW5kTWVzc2FnZShcbiAgICAgICAgICAgIHsgY3VzdG9tVHlwZTogXCJnc2QtZGVidWctY29udGludWVcIiwgY29udGVudDogcHJvbXB0LCBkaXNwbGF5OiBmYWxzZSB9LFxuICAgICAgICAgICAgeyB0cmlnZ2VyVHVybjogdHJ1ZSB9LFxuICAgICAgICAgICk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgYENvbnRpbnVlIGRpc3BhdGNoIGZhaWxlZDogJHttc2d9XFxuU2Vzc2lvbiAnJHtyZXN1bWVkLnNlc3Npb24uc2x1Z30nIGlzIHBlcnNpc3RlZDsgcmV0cnkgd2l0aCAvZ3NkIGRlYnVnIGNvbnRpbnVlICR7cmVzdW1lZC5zZXNzaW9uLnNsdWd9YCxcbiAgICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBVbmFibGUgdG8gY29udGludWUgZGVidWcgc2Vzc2lvbiAnJHtwYXJzZWQuc2x1Z30nOiAke21lc3NhZ2V9XFxuVHJ5IC9nc2QgZGVidWcgLS1kaWFnbm9zZSAke3BhcnNlZC5zbHVnfWAsXG4gICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHBhcnNlZC50eXBlID09PSBcImRpYWdub3NlLWlzc3VlXCIpIHtcbiAgICBjb25zdCBpc3N1ZSA9IHBhcnNlZC5pc3N1ZS50cmltKCk7XG4gICAgaWYgKCFpc3N1ZSkge1xuICAgICAgY3R4LnVpLm5vdGlmeShgSXNzdWUgdGV4dCBpcyByZXF1aXJlZC5cXG4ke3VzYWdlVGV4dCgpfWAsIFwid2FybmluZ1wiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgY3JlYXRlZCA9IGNyZWF0ZURlYnVnU2Vzc2lvbihiYXNlUGF0aCwgeyBpc3N1ZSwgbW9kZTogXCJkaWFnbm9zZVwiIH0pO1xuICAgICAgY29uc3QgcyA9IGNyZWF0ZWQuc2Vzc2lvbjtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIFtcbiAgICAgICAgICBgRGlhZ25vc2Ugc2Vzc2lvbiBzdGFydGVkOiAke3Muc2x1Z31gLFxuICAgICAgICAgIGZvcm1hdFNlc3Npb25MaW5lKFwiU2Vzc2lvbjpcIiwgcyksXG4gICAgICAgICAgYEFydGlmYWN0OiAke2NyZWF0ZWQuYXJ0aWZhY3RQYXRofWAsXG4gICAgICAgICAgYExvZzogJHtzLmxvZ1BhdGh9YCxcbiAgICAgICAgICBgZGlzcGF0Y2hNb2RlPWZpbmRfcm9vdF9jYXVzZV9vbmx5YCxcbiAgICAgICAgICBgTmV4dDogL2dzZCBkZWJ1ZyBzdGF0dXMgJHtzLnNsdWd9IG9yIC9nc2QgZGVidWcgLS1kaWFnbm9zZSAke3Muc2x1Z31gLFxuICAgICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgICAgIFwiaW5mb1wiLFxuICAgICAgKTtcblxuICAgICAgaWYgKHBpICYmIHR5cGVvZiBwaS5zZW5kTWVzc2FnZSA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgcHJvbXB0ID0gbG9hZFByb21wdChcImRlYnVnLWRpYWdub3NlXCIsIHtcbiAgICAgICAgICAgIGdvYWw6IFwiZmluZF9yb290X2NhdXNlX29ubHlcIixcbiAgICAgICAgICAgIGlzc3VlOiBzLmlzc3VlLFxuICAgICAgICAgICAgc2x1Zzogcy5zbHVnLFxuICAgICAgICAgICAgbW9kZTogcy5tb2RlLFxuICAgICAgICAgICAgd29ya2luZ0RpcmVjdG9yeTogYmFzZVBhdGgsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgcGkuc2VuZE1lc3NhZ2UoXG4gICAgICAgICAgICB7IGN1c3RvbVR5cGU6IFwiZ3NkLWRlYnVnLWRpYWdub3NlXCIsIGNvbnRlbnQ6IHByb21wdCwgZGlzcGxheTogZmFsc2UgfSxcbiAgICAgICAgICAgIHsgdHJpZ2dlclR1cm46IHRydWUgfSxcbiAgICAgICAgICApO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgIGBEaWFnbm9zZSBkaXNwYXRjaCBmYWlsZWQ6ICR7bXNnfVxcblNlc3Npb24gJyR7cy5zbHVnfScgaXMgcGVyc2lzdGVkOyBjb250aW51ZSBtYW51YWxseSB3aXRoIC9nc2QgZGVidWcgY29udGludWUgJHtzLnNsdWd9YCxcbiAgICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBVbmFibGUgdG8gY3JlYXRlIGRpYWdub3NlIHNlc3Npb246ICR7bWVzc2FnZX1cXG5UcnkgL2dzZCBkZWJ1ZyAtLWRpYWdub3NlIGZvciBhcnRpZmFjdCBoZWFsdGggZGV0YWlscy5gLFxuICAgICAgICBcImVycm9yXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAocGFyc2VkLnR5cGUgPT09IFwiZGlhZ25vc2VcIikge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBsaXN0ZWQgPSBsaXN0RGVidWdTZXNzaW9ucyhiYXNlUGF0aCk7XG5cbiAgICAgIGlmIChwYXJzZWQuc2x1Zykge1xuICAgICAgICBjb25zdCBsb2FkZWQgPSBsb2FkRGVidWdTZXNzaW9uKGJhc2VQYXRoLCBwYXJzZWQuc2x1Zyk7XG4gICAgICAgIGlmICghbG9hZGVkKSB7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgIGBEaWFnbm9zZTogc2Vzc2lvbiAnJHtwYXJzZWQuc2x1Z30nIG5vdCBmb3VuZC5cXG5SdW4gL2dzZCBkZWJ1ZyBsaXN0IHRvIGRpc2NvdmVyIHZhbGlkIHNsdWdzLmAsXG4gICAgICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICAgICApO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHMgPSBsb2FkZWQuc2Vzc2lvbjtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBbXG4gICAgICAgICAgICBgRGlhZ25vc2Ugc2Vzc2lvbjogJHtzLnNsdWd9YCxcbiAgICAgICAgICAgIGBtb2RlPSR7cy5tb2RlfWAsXG4gICAgICAgICAgICBgc3RhdHVzPSR7cy5zdGF0dXN9YCxcbiAgICAgICAgICAgIGBwaGFzZT0ke3MucGhhc2V9YCxcbiAgICAgICAgICAgIGBhcnRpZmFjdD0ke2xvYWRlZC5hcnRpZmFjdFBhdGh9YCxcbiAgICAgICAgICAgIGBsb2c9JHtzLmxvZ1BhdGh9YCxcbiAgICAgICAgICAgIGBsYXN0RXJyb3I9JHtzLmxhc3RFcnJvciA/PyBcIm5vbmVcIn1gLFxuICAgICAgICAgICAgYG1hbGZvcm1lZEFydGlmYWN0c0luU3RvcmU9JHtsaXN0ZWQubWFsZm9ybWVkLmxlbmd0aH1gLFxuICAgICAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICAgICAgICBcImluZm9cIixcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBsaW5lcyA9IFtcbiAgICAgICAgXCJEZWJ1ZyBzZXNzaW9uIGRpYWdub3N0aWNzOlwiLFxuICAgICAgICBgaGVhbHRoeVNlc3Npb25zPSR7bGlzdGVkLnNlc3Npb25zLmxlbmd0aH1gLFxuICAgICAgICBgbWFsZm9ybWVkQXJ0aWZhY3RzPSR7bGlzdGVkLm1hbGZvcm1lZC5sZW5ndGh9YCxcbiAgICAgIF07XG5cbiAgICAgIGlmIChsaXN0ZWQubWFsZm9ybWVkLmxlbmd0aCA+IDApIHtcbiAgICAgICAgbGluZXMucHVzaChcIlwiKTtcbiAgICAgICAgbGluZXMucHVzaChcIk1hbGZvcm1lZCBhcnRpZmFjdHMgKGZpcnN0IDEwKTpcIik7XG4gICAgICAgIGZvciAoY29uc3QgbWFsZm9ybWVkIG9mIGxpc3RlZC5tYWxmb3JtZWQuc2xpY2UoMCwgMTApKSB7XG4gICAgICAgICAgbGluZXMucHVzaChgICAtICR7bWFsZm9ybWVkLmFydGlmYWN0UGF0aH1gKTtcbiAgICAgICAgICBsaW5lcy5wdXNoKGAgICAgJHttYWxmb3JtZWQubWVzc2FnZX1gKTtcbiAgICAgICAgfVxuICAgICAgICBsaW5lcy5wdXNoKFwiUmVtZWRpYXRpb246IHJlcGFpci9yZW1vdmUgbWFsZm9ybWVkIEpTT04gYXJ0aWZhY3RzIHVuZGVyIC5nc2QvZGVidWcvc2Vzc2lvbnMvLlwiKTtcbiAgICAgIH1cblxuICAgICAgY3R4LnVpLm5vdGlmeShsaW5lcy5qb2luKFwiXFxuXCIpLCBsaXN0ZWQubWFsZm9ybWVkLmxlbmd0aCA+IDAgPyBcIndhcm5pbmdcIiA6IFwiaW5mb1wiKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICAgIGN0eC51aS5ub3RpZnkoYERpYWdub3NlIGZhaWxlZDogJHtt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WTtBQUM5QixRQUFJO0FBQ0YsWUFBTSxTQUFTLGtCQUFrQixRQUFRO0FBRXpDLFVBQUksT0FBTyxNQUFNO0FBQ2YsY0FBTSxTQUFTLGlCQUFpQixVQUFVLE9BQU8sSUFBSTtBQUNyRCxZQUFJLENBQUMsUUFBUTtBQUNYLGNBQUksR0FBRztBQUFBLFlBQ0wsc0JBQXNCLE9BQU8sSUFBSTtBQUFBO0FBQUEsWUFDakM7QUFBQSxVQUNGO0FBQ0E7QUFBQSxRQUNGO0FBRUEsY0FBTSxJQUFJLE9BQU87QUFDakIsWUFBSSxHQUFHO0FBQUEsVUFDTDtBQUFBLFlBQ0UscUJBQXFCLEVBQUUsSUFBSTtBQUFBLFlBQzNCLFFBQVEsRUFBRSxJQUFJO0FBQUEsWUFDZCxVQUFVLEVBQUUsTUFBTTtBQUFBLFlBQ2xCLFNBQVMsRUFBRSxLQUFLO0FBQUEsWUFDaEIsWUFBWSxPQUFPLFlBQVk7QUFBQSxZQUMvQixPQUFPLEVBQUUsT0FBTztBQUFBLFlBQ2hCLGFBQWEsRUFBRSxhQUFhLE1BQU07QUFBQSxZQUNsQyw2QkFBNkIsT0FBTyxVQUFVLE1BQU07QUFBQSxVQUN0RCxFQUFFLEtBQUssSUFBSTtBQUFBLFVBQ1g7QUFBQSxRQUNGO0FBQ0E7QUFBQSxNQUNGO0FBRUEsWUFBTSxRQUFRO0FBQUEsUUFDWjtBQUFBLFFBQ0EsbUJBQW1CLE9BQU8sU0FBUyxNQUFNO0FBQUEsUUFDekMsc0JBQXNCLE9BQU8sVUFBVSxNQUFNO0FBQUEsTUFDL0M7QUFFQSxVQUFJLE9BQU8sVUFBVSxTQUFTLEdBQUc7QUFDL0IsY0FBTSxLQUFLLEVBQUU7QUFDYixjQUFNLEtBQUssaUNBQWlDO0FBQzVDLG1CQUFXLGFBQWEsT0FBTyxVQUFVLE1BQU0sR0FBRyxFQUFFLEdBQUc7QUFDckQsZ0JBQU0sS0FBSyxPQUFPLFVBQVUsWUFBWSxFQUFFO0FBQzFDLGdCQUFNLEtBQUssT0FBTyxVQUFVLE9BQU8sRUFBRTtBQUFBLFFBQ3ZDO0FBQ0EsY0FBTSxLQUFLLGlGQUFpRjtBQUFBLE1BQzlGO0FBRUEsVUFBSSxHQUFHLE9BQU8sTUFBTSxLQUFLLElBQUksR0FBRyxPQUFPLFVBQVUsU0FBUyxJQUFJLFlBQVksTUFBTTtBQUFBLElBQ2xGLFNBQVMsT0FBTztBQUNkLFlBQU0sVUFBVSxpQkFBaUIsUUFBUSxNQUFNLFVBQVUsT0FBTyxLQUFLO0FBQ3JFLFVBQUksR0FBRyxPQUFPLG9CQUFvQixPQUFPLElBQUksT0FBTztBQUFBLElBQ3REO0FBQUEsRUFDRjtBQUNGOyIsCiAgIm5hbWVzIjogW10KfQo=
