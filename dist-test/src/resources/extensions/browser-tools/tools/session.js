import { Type } from "@sinclair/typebox";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  formatTimelineEntries,
  buildFailureHypothesis,
  summarizeBrowserSession
} from "../core.js";
import {
  ARTIFACT_ROOT,
  HAR_FILENAME,
  getPageRegistry,
  getConsoleLogs,
  getNetworkLogs,
  getDialogLogs,
  getActionTimeline,
  getActiveTraceSession,
  setActiveTraceSession,
  getHarState,
  setHarState,
  getSessionStartedAt,
  getSessionArtifactDir
} from "../state.js";
import {
  getActiveFrameMetadata,
  ensureDir
} from "../utils.js";
function registerSessionTools(pi, deps) {
  pi.registerTool({
    name: "browser_close",
    label: "Browser Close",
    description: "Close the browser and clean up all resources.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        await deps.closeBrowser();
        return {
          content: [{ type: "text", text: "Browser closed." }],
          details: {}
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Close failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_trace_start",
    label: "Browser Trace Start",
    description: "Start a Playwright trace for the current browser session and persist trace metadata under the session artifact directory.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Optional short trace session name for artifact filenames." })),
      title: Type.Optional(Type.String({ description: "Optional trace title recorded in metadata." }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { context: browserContext } = await deps.ensureBrowser();
        const activeTrace = getActiveTraceSession();
        if (activeTrace) {
          return {
            content: [{ type: "text", text: `Trace already active: ${activeTrace.name}` }],
            details: { error: "trace_already_active", activeTraceSession: activeTrace, ...deps.getSessionArtifactMetadata() },
            isError: true
          };
        }
        const startedAt = Date.now();
        const name = (params.name?.trim() || `trace-${deps.formatArtifactTimestamp(startedAt)}`).replace(/[^a-zA-Z0-9._-]+/g, "-");
        await browserContext.tracing.start({ screenshots: true, snapshots: true, sources: true, title: params.title ?? name });
        setActiveTraceSession({ startedAt, name, title: params.title ?? name });
        return {
          content: [{ type: "text", text: `Trace started: ${name}
Session dir: ${getSessionArtifactDir()}` }],
          details: { activeTraceSession: getActiveTraceSession(), ...deps.getSessionArtifactMetadata() }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Trace start failed: ${err.message}` }],
          details: { error: err.message, ...deps.getSessionArtifactMetadata() },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_trace_stop",
    label: "Browser Trace Stop",
    description: "Stop the active Playwright trace and write the trace zip to disk under the session artifact directory.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Optional artifact basename override for the trace zip." }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { context: browserContext } = await deps.ensureBrowser();
        const activeTrace = getActiveTraceSession();
        if (!activeTrace) {
          return {
            content: [{ type: "text", text: "No active trace session to stop." }],
            details: { error: "trace_not_active", ...deps.getSessionArtifactMetadata() },
            isError: true
          };
        }
        const traceSession = activeTrace;
        const traceName = (params.name?.trim() || traceSession.name).replace(/[^a-zA-Z0-9._-]+/g, "-");
        const tracePath = deps.buildSessionArtifactPath(`${traceName}.trace.zip`);
        await browserContext.tracing.stop({ path: tracePath });
        const fileStat = await stat(tracePath);
        setActiveTraceSession(null);
        return {
          content: [{ type: "text", text: `Trace stopped: ${tracePath}` }],
          details: {
            path: tracePath,
            bytes: fileStat.size,
            elapsedMs: Date.now() - traceSession.startedAt,
            traceName,
            ...deps.getSessionArtifactMetadata()
          }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Trace stop failed: ${err.message}` }],
          details: { error: err.message, ...deps.getSessionArtifactMetadata() },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_export_har",
    label: "Browser Export HAR",
    description: "Export the truthfully recorded session HAR from disk to a stable artifact path and return compact metadata.",
    parameters: Type.Object({
      filename: Type.Optional(Type.String({ description: "Optional destination filename within the session artifact directory." }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        await deps.ensureBrowser();
        const harState = getHarState();
        if (!harState.enabled || !harState.configuredAtContextCreation || !harState.path) {
          return {
            content: [{ type: "text", text: "HAR export unavailable: HAR recording was not enabled at browser context creation." }],
            details: { error: "har_not_enabled", ...deps.getSessionArtifactMetadata() },
            isError: true
          };
        }
        const sourcePath = harState.path;
        const destinationName = (params.filename?.trim() || `export-${HAR_FILENAME}`).replace(/[^a-zA-Z0-9._-]+/g, "-");
        const destinationPath = deps.buildSessionArtifactPath(destinationName);
        const exportResult = sourcePath === destinationPath ? { path: sourcePath, bytes: (await stat(sourcePath)).size } : await deps.copyArtifactFile(sourcePath, destinationPath);
        setHarState({
          ...harState,
          exportCount: harState.exportCount + 1,
          lastExportedPath: exportResult.path,
          lastExportedAt: Date.now()
        });
        return {
          content: [{ type: "text", text: `HAR exported: ${exportResult.path}` }],
          details: { path: exportResult.path, bytes: exportResult.bytes, ...deps.getSessionArtifactMetadata() }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `HAR export failed: ${err.message}` }],
          details: { error: err.message, ...deps.getSessionArtifactMetadata() },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_timeline",
    label: "Browser Timeline",
    description: "Return a compact structured summary of the tracked browser action timeline and optional on-disk export path.",
    parameters: Type.Object({
      writeToDisk: Type.Optional(Type.Boolean({ description: "Write the timeline JSON to disk under the session artifact directory." })),
      filename: Type.Optional(Type.String({ description: "Optional JSON filename when writeToDisk is true." }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        await deps.ensureBrowser();
        const actionTimeline = getActionTimeline();
        const timeline = formatTimelineEntries(actionTimeline.entries, {
          limit: actionTimeline.limit,
          totalActions: actionTimeline.nextId - 1
        });
        let artifact = null;
        if (params.writeToDisk) {
          const filename = (params.filename?.trim() || "timeline.json").replace(/[^a-zA-Z0-9._-]+/g, "-");
          artifact = await deps.writeArtifactFile(deps.buildSessionArtifactPath(filename), JSON.stringify(timeline, null, 2));
        }
        return {
          content: [{ type: "text", text: artifact ? `${timeline.summary}
Artifact: ${artifact.path}` : timeline.summary }],
          details: { ...timeline, artifact, ...deps.getSessionArtifactMetadata() }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Timeline failed: ${err.message}` }],
          details: { error: err.message, ...deps.getSessionArtifactMetadata() },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_session_summary",
    label: "Browser Session Summary",
    description: "Return a compact structured summary of the current browser session, including pages, actions, waits/assertions, bounded-history caveats, and trace/HAR state.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      try {
        await deps.ensureBrowser();
        const pages = await deps.getLivePagesSnapshot();
        const actionTimeline = getActionTimeline();
        const pageRegistry = getPageRegistry();
        const consoleLogs = getConsoleLogs();
        const networkLogs = getNetworkLogs();
        const dialogLogs = getDialogLogs();
        const baseSummary = summarizeBrowserSession({
          timeline: actionTimeline,
          totalActions: actionTimeline.nextId - 1,
          pages,
          activePageId: pageRegistry.activePageId,
          activeFrame: getActiveFrameMetadata(),
          consoleEntries: consoleLogs,
          networkEntries: networkLogs,
          dialogEntries: dialogLogs,
          consoleLimit: 1e3,
          networkLimit: 1e3,
          dialogLimit: 1e3,
          sessionStartedAt: getSessionStartedAt(),
          now: Date.now()
        });
        const failureHypothesis = buildFailureHypothesis({
          timeline: actionTimeline,
          consoleEntries: consoleLogs,
          networkEntries: networkLogs,
          dialogEntries: dialogLogs
        });
        const activeTrace = getActiveTraceSession();
        const traceState = activeTrace ? { status: "active", ...activeTrace } : { status: "inactive", lastTracePath: getSessionArtifactDir() ? deps.buildSessionArtifactPath("*.trace.zip") : null };
        const harState = getHarState();
        const harSummary = {
          enabled: harState.enabled,
          configuredAtContextCreation: harState.configuredAtContextCreation,
          path: harState.path,
          exportCount: harState.exportCount,
          lastExportedPath: harState.lastExportedPath,
          lastExportedAt: harState.lastExportedAt
        };
        return {
          content: [{ type: "text", text: `${baseSummary.summary}
Failure hypothesis: ${failureHypothesis}` }],
          details: {
            ...baseSummary,
            failureHypothesis,
            trace: traceState,
            har: harSummary,
            ...deps.getSessionArtifactMetadata()
          }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Session summary failed: ${err.message}` }],
          details: { error: err.message, ...deps.getSessionArtifactMetadata() },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_debug_bundle",
    label: "Browser Debug Bundle",
    description: "Write a timestamped debug bundle to disk with screenshot, logs, timeline, pages, session summary, and accessibility output, then return compact paths and counts.",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "Optional CSS selector to scope the accessibility snapshot before fallback behavior applies." })),
      name: Type.Optional(Type.String({ description: "Optional short bundle name suffix for the output directory." }))
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const startedAt = Date.now();
        const sessionDir = await deps.ensureSessionArtifactDir();
        const bundleDir = path.join(ARTIFACT_ROOT, `${deps.formatArtifactTimestamp(startedAt)}-${deps.sanitizeArtifactName(params.name ?? "debug-bundle", "debug-bundle")}`);
        await ensureDir(bundleDir);
        const pages = await deps.getLivePagesSnapshot();
        const actionTimeline = getActionTimeline();
        const pageRegistry = getPageRegistry();
        const consoleLogs = getConsoleLogs();
        const networkLogs = getNetworkLogs();
        const dialogLogs = getDialogLogs();
        const timeline = formatTimelineEntries(actionTimeline.entries, {
          limit: actionTimeline.limit,
          totalActions: actionTimeline.nextId - 1
        });
        const sessionSummary = summarizeBrowserSession({
          timeline: actionTimeline,
          totalActions: actionTimeline.nextId - 1,
          pages,
          activePageId: pageRegistry.activePageId,
          activeFrame: getActiveFrameMetadata(),
          consoleEntries: consoleLogs,
          networkEntries: networkLogs,
          dialogEntries: dialogLogs,
          consoleLimit: 1e3,
          networkLimit: 1e3,
          dialogLimit: 1e3,
          sessionStartedAt: getSessionStartedAt(),
          now: Date.now()
        });
        const failureHypothesis = buildFailureHypothesis({
          timeline: actionTimeline,
          consoleEntries: consoleLogs,
          networkEntries: networkLogs,
          dialogEntries: dialogLogs
        });
        const accessibility = await deps.captureAccessibilityMarkdown(params.selector);
        const screenshotPath = path.join(bundleDir, "screenshot.jpg");
        await p.screenshot({ path: screenshotPath, type: "jpeg", quality: 80, fullPage: false });
        const screenshotStat = await stat(screenshotPath);
        const artifacts = {
          screenshot: { path: screenshotPath, bytes: screenshotStat.size },
          console: await deps.writeArtifactFile(path.join(bundleDir, "console.json"), JSON.stringify(consoleLogs, null, 2)),
          network: await deps.writeArtifactFile(path.join(bundleDir, "network.json"), JSON.stringify(networkLogs, null, 2)),
          dialog: await deps.writeArtifactFile(path.join(bundleDir, "dialog.json"), JSON.stringify(dialogLogs, null, 2)),
          timeline: await deps.writeArtifactFile(path.join(bundleDir, "timeline.json"), JSON.stringify(timeline, null, 2)),
          summary: await deps.writeArtifactFile(path.join(bundleDir, "summary.json"), JSON.stringify({
            ...sessionSummary,
            failureHypothesis,
            trace: getActiveTraceSession(),
            har: getHarState(),
            sessionArtifactDir: sessionDir
          }, null, 2)),
          pages: await deps.writeArtifactFile(path.join(bundleDir, "pages.json"), JSON.stringify(pages, null, 2)),
          accessibility: await deps.writeArtifactFile(path.join(bundleDir, "accessibility.md"), accessibility.snapshot)
        };
        return {
          content: [{ type: "text", text: `Debug bundle written: ${bundleDir}
${sessionSummary.summary}
Failure hypothesis: ${failureHypothesis}` }],
          details: {
            bundleDir,
            artifacts,
            accessibilityScope: accessibility.scope,
            accessibilitySource: accessibility.source,
            counts: {
              console: consoleLogs.length,
              network: networkLogs.length,
              dialog: dialogLogs.length,
              actions: timeline.retained,
              pages: pages.length
            },
            elapsedMs: Date.now() - startedAt,
            summary: sessionSummary,
            failureHypothesis,
            ...deps.getSessionArtifactMetadata()
          }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Debug bundle failed: ${err.message}` }],
          details: { error: err.message, ...deps.getSessionArtifactMetadata() },
          isError: true
        };
      }
    }
  });
}
export {
  registerSessionTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvc2Vzc2lvbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB7IHN0YXQgfSBmcm9tIFwibm9kZTpmcy9wcm9taXNlc1wiO1xuaW1wb3J0IHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHtcblx0Zm9ybWF0VGltZWxpbmVFbnRyaWVzLFxuXHRidWlsZEZhaWx1cmVIeXBvdGhlc2lzLFxuXHRzdW1tYXJpemVCcm93c2VyU2Vzc2lvbixcbn0gZnJvbSBcIi4uL2NvcmUuanNcIjtcbmltcG9ydCB0eXBlIHsgVG9vbERlcHMgfSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcbmltcG9ydCB7XG5cdEFSVElGQUNUX1JPT1QsXG5cdEhBUl9GSUxFTkFNRSxcblx0Z2V0UGFnZVJlZ2lzdHJ5LFxuXHRnZXRBY3RpdmVGcmFtZSxcblx0Z2V0Q29uc29sZUxvZ3MsXG5cdGdldE5ldHdvcmtMb2dzLFxuXHRnZXREaWFsb2dMb2dzLFxuXHRnZXRBY3Rpb25UaW1lbGluZSxcblx0Z2V0QWN0aXZlVHJhY2VTZXNzaW9uLFxuXHRzZXRBY3RpdmVUcmFjZVNlc3Npb24sXG5cdGdldEhhclN0YXRlLFxuXHRzZXRIYXJTdGF0ZSxcblx0Z2V0U2Vzc2lvblN0YXJ0ZWRBdCxcblx0Z2V0U2Vzc2lvbkFydGlmYWN0RGlyLFxufSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcbmltcG9ydCB7XG5cdGdldEFjdGl2ZUZyYW1lTWV0YWRhdGEsXG5cdGVuc3VyZURpcixcbn0gZnJvbSBcIi4uL3V0aWxzLmpzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlclNlc3Npb25Ub29scyhwaTogRXh0ZW5zaW9uQVBJLCBkZXBzOiBUb29sRGVwcyk6IHZvaWQge1xuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfY2xvc2Vcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9jbG9zZVwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgQ2xvc2VcIixcblx0XHRkZXNjcmlwdGlvbjogXCJDbG9zZSB0aGUgYnJvd3NlciBhbmQgY2xlYW4gdXAgYWxsIHJlc291cmNlcy5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBfcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGRlcHMuY2xvc2VCcm93c2VyKCk7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiQnJvd3NlciBjbG9zZWQuXCIgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczoge30sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgQ2xvc2UgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gYnJvd3Nlcl90cmFjZV9zdGFydFxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX3RyYWNlX3N0YXJ0XCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBUcmFjZSBTdGFydFwiLFxuXHRcdGRlc2NyaXB0aW9uOiBcIlN0YXJ0IGEgUGxheXdyaWdodCB0cmFjZSBmb3IgdGhlIGN1cnJlbnQgYnJvd3NlciBzZXNzaW9uIGFuZCBwZXJzaXN0IHRyYWNlIG1ldGFkYXRhIHVuZGVyIHRoZSBzZXNzaW9uIGFydGlmYWN0IGRpcmVjdG9yeS5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRuYW1lOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiT3B0aW9uYWwgc2hvcnQgdHJhY2Ugc2Vzc2lvbiBuYW1lIGZvciBhcnRpZmFjdCBmaWxlbmFtZXMuXCIgfSkpLFxuXHRcdFx0dGl0bGU6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJPcHRpb25hbCB0cmFjZSB0aXRsZSByZWNvcmRlZCBpbiBtZXRhZGF0YS5cIiB9KSksXG5cdFx0fSksXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHsgY29udGV4dDogYnJvd3NlckNvbnRleHQgfSA9IGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCBhY3RpdmVUcmFjZSA9IGdldEFjdGl2ZVRyYWNlU2Vzc2lvbigpO1xuXHRcdFx0XHRpZiAoYWN0aXZlVHJhY2UpIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBUcmFjZSBhbHJlYWR5IGFjdGl2ZTogJHthY3RpdmVUcmFjZS5uYW1lfWAgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBcInRyYWNlX2FscmVhZHlfYWN0aXZlXCIsIGFjdGl2ZVRyYWNlU2Vzc2lvbjogYWN0aXZlVHJhY2UsIC4uLmRlcHMuZ2V0U2Vzc2lvbkFydGlmYWN0TWV0YWRhdGEoKSB9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IHN0YXJ0ZWRBdCA9IERhdGUubm93KCk7XG5cdFx0XHRcdGNvbnN0IG5hbWUgPSAocGFyYW1zLm5hbWU/LnRyaW0oKSB8fCBgdHJhY2UtJHtkZXBzLmZvcm1hdEFydGlmYWN0VGltZXN0YW1wKHN0YXJ0ZWRBdCl9YCkucmVwbGFjZSgvW15hLXpBLVowLTkuXy1dKy9nLCBcIi1cIik7XG5cdFx0XHRcdGF3YWl0IGJyb3dzZXJDb250ZXh0LnRyYWNpbmcuc3RhcnQoeyBzY3JlZW5zaG90czogdHJ1ZSwgc25hcHNob3RzOiB0cnVlLCBzb3VyY2VzOiB0cnVlLCB0aXRsZTogcGFyYW1zLnRpdGxlID8/IG5hbWUgfSk7XG5cdFx0XHRcdHNldEFjdGl2ZVRyYWNlU2Vzc2lvbih7IHN0YXJ0ZWRBdCwgbmFtZSwgdGl0bGU6IHBhcmFtcy50aXRsZSA/PyBuYW1lIH0pO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgVHJhY2Ugc3RhcnRlZDogJHtuYW1lfVxcblNlc3Npb24gZGlyOiAke2dldFNlc3Npb25BcnRpZmFjdERpcigpfWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBhY3RpdmVUcmFjZVNlc3Npb246IGdldEFjdGl2ZVRyYWNlU2Vzc2lvbigpLCAuLi5kZXBzLmdldFNlc3Npb25BcnRpZmFjdE1ldGFkYXRhKCkgfSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBUcmFjZSBzdGFydCBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSwgLi4uZGVwcy5nZXRTZXNzaW9uQXJ0aWZhY3RNZXRhZGF0YSgpIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfdHJhY2Vfc3RvcFxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX3RyYWNlX3N0b3BcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIFRyYWNlIFN0b3BcIixcblx0XHRkZXNjcmlwdGlvbjogXCJTdG9wIHRoZSBhY3RpdmUgUGxheXdyaWdodCB0cmFjZSBhbmQgd3JpdGUgdGhlIHRyYWNlIHppcCB0byBkaXNrIHVuZGVyIHRoZSBzZXNzaW9uIGFydGlmYWN0IGRpcmVjdG9yeS5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRuYW1lOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiT3B0aW9uYWwgYXJ0aWZhY3QgYmFzZW5hbWUgb3ZlcnJpZGUgZm9yIHRoZSB0cmFjZSB6aXAuXCIgfSkpLFxuXHRcdH0pLFxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCB7IGNvbnRleHQ6IGJyb3dzZXJDb250ZXh0IH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblx0XHRcdFx0Y29uc3QgYWN0aXZlVHJhY2UgPSBnZXRBY3RpdmVUcmFjZVNlc3Npb24oKTtcblx0XHRcdFx0aWYgKCFhY3RpdmVUcmFjZSkge1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJObyBhY3RpdmUgdHJhY2Ugc2Vzc2lvbiB0byBzdG9wLlwiIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogXCJ0cmFjZV9ub3RfYWN0aXZlXCIsIC4uLmRlcHMuZ2V0U2Vzc2lvbkFydGlmYWN0TWV0YWRhdGEoKSB9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IHRyYWNlU2Vzc2lvbiA9IGFjdGl2ZVRyYWNlO1xuXHRcdFx0XHRjb25zdCB0cmFjZU5hbWUgPSAocGFyYW1zLm5hbWU/LnRyaW0oKSB8fCB0cmFjZVNlc3Npb24ubmFtZSkucmVwbGFjZSgvW15hLXpBLVowLTkuXy1dKy9nLCBcIi1cIik7XG5cdFx0XHRcdGNvbnN0IHRyYWNlUGF0aCA9IGRlcHMuYnVpbGRTZXNzaW9uQXJ0aWZhY3RQYXRoKGAke3RyYWNlTmFtZX0udHJhY2UuemlwYCk7XG5cdFx0XHRcdGF3YWl0IGJyb3dzZXJDb250ZXh0LnRyYWNpbmcuc3RvcCh7IHBhdGg6IHRyYWNlUGF0aCB9KTtcblx0XHRcdFx0Y29uc3QgZmlsZVN0YXQgPSBhd2FpdCBzdGF0KHRyYWNlUGF0aCk7XG5cdFx0XHRcdHNldEFjdGl2ZVRyYWNlU2Vzc2lvbihudWxsKTtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFRyYWNlIHN0b3BwZWQ6ICR7dHJhY2VQYXRofWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczoge1xuXHRcdFx0XHRcdFx0cGF0aDogdHJhY2VQYXRoLFxuXHRcdFx0XHRcdFx0Ynl0ZXM6IGZpbGVTdGF0LnNpemUsXG5cdFx0XHRcdFx0XHRlbGFwc2VkTXM6IERhdGUubm93KCkgLSB0cmFjZVNlc3Npb24uc3RhcnRlZEF0LFxuXHRcdFx0XHRcdFx0dHJhY2VOYW1lLFxuXHRcdFx0XHRcdFx0Li4uZGVwcy5nZXRTZXNzaW9uQXJ0aWZhY3RNZXRhZGF0YSgpLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgVHJhY2Ugc3RvcCBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSwgLi4uZGVwcy5nZXRTZXNzaW9uQXJ0aWZhY3RNZXRhZGF0YSgpIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfZXhwb3J0X2hhclxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX2V4cG9ydF9oYXJcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIEV4cG9ydCBIQVJcIixcblx0XHRkZXNjcmlwdGlvbjogXCJFeHBvcnQgdGhlIHRydXRoZnVsbHkgcmVjb3JkZWQgc2Vzc2lvbiBIQVIgZnJvbSBkaXNrIHRvIGEgc3RhYmxlIGFydGlmYWN0IHBhdGggYW5kIHJldHVybiBjb21wYWN0IG1ldGFkYXRhLlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdGZpbGVuYW1lOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiT3B0aW9uYWwgZGVzdGluYXRpb24gZmlsZW5hbWUgd2l0aGluIHRoZSBzZXNzaW9uIGFydGlmYWN0IGRpcmVjdG9yeS5cIiB9KSksXG5cdFx0fSksXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCBoYXJTdGF0ZSA9IGdldEhhclN0YXRlKCk7XG5cdFx0XHRcdGlmICghaGFyU3RhdGUuZW5hYmxlZCB8fCAhaGFyU3RhdGUuY29uZmlndXJlZEF0Q29udGV4dENyZWF0aW9uIHx8ICFoYXJTdGF0ZS5wYXRoKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkhBUiBleHBvcnQgdW5hdmFpbGFibGU6IEhBUiByZWNvcmRpbmcgd2FzIG5vdCBlbmFibGVkIGF0IGJyb3dzZXIgY29udGV4dCBjcmVhdGlvbi5cIiB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IFwiaGFyX25vdF9lbmFibGVkXCIsIC4uLmRlcHMuZ2V0U2Vzc2lvbkFydGlmYWN0TWV0YWRhdGEoKSB9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IHNvdXJjZVBhdGggPSBoYXJTdGF0ZS5wYXRoO1xuXHRcdFx0XHRjb25zdCBkZXN0aW5hdGlvbk5hbWUgPSAocGFyYW1zLmZpbGVuYW1lPy50cmltKCkgfHwgYGV4cG9ydC0ke0hBUl9GSUxFTkFNRX1gKS5yZXBsYWNlKC9bXmEtekEtWjAtOS5fLV0rL2csIFwiLVwiKTtcblx0XHRcdFx0Y29uc3QgZGVzdGluYXRpb25QYXRoID0gZGVwcy5idWlsZFNlc3Npb25BcnRpZmFjdFBhdGgoZGVzdGluYXRpb25OYW1lKTtcblx0XHRcdFx0Y29uc3QgZXhwb3J0UmVzdWx0ID0gc291cmNlUGF0aCA9PT0gZGVzdGluYXRpb25QYXRoXG5cdFx0XHRcdFx0PyB7IHBhdGg6IHNvdXJjZVBhdGgsIGJ5dGVzOiAoYXdhaXQgc3RhdChzb3VyY2VQYXRoKSkuc2l6ZSB9XG5cdFx0XHRcdFx0OiBhd2FpdCBkZXBzLmNvcHlBcnRpZmFjdEZpbGUoc291cmNlUGF0aCwgZGVzdGluYXRpb25QYXRoKTtcblx0XHRcdFx0c2V0SGFyU3RhdGUoe1xuXHRcdFx0XHRcdC4uLmhhclN0YXRlLFxuXHRcdFx0XHRcdGV4cG9ydENvdW50OiBoYXJTdGF0ZS5leHBvcnRDb3VudCArIDEsXG5cdFx0XHRcdFx0bGFzdEV4cG9ydGVkUGF0aDogZXhwb3J0UmVzdWx0LnBhdGgsXG5cdFx0XHRcdFx0bGFzdEV4cG9ydGVkQXQ6IERhdGUubm93KCksXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgSEFSIGV4cG9ydGVkOiAke2V4cG9ydFJlc3VsdC5wYXRofWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBwYXRoOiBleHBvcnRSZXN1bHQucGF0aCwgYnl0ZXM6IGV4cG9ydFJlc3VsdC5ieXRlcywgLi4uZGVwcy5nZXRTZXNzaW9uQXJ0aWZhY3RNZXRhZGF0YSgpIH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgSEFSIGV4cG9ydCBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSwgLi4uZGVwcy5nZXRTZXNzaW9uQXJ0aWZhY3RNZXRhZGF0YSgpIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfdGltZWxpbmVcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl90aW1lbGluZVwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgVGltZWxpbmVcIixcblx0XHRkZXNjcmlwdGlvbjogXCJSZXR1cm4gYSBjb21wYWN0IHN0cnVjdHVyZWQgc3VtbWFyeSBvZiB0aGUgdHJhY2tlZCBicm93c2VyIGFjdGlvbiB0aW1lbGluZSBhbmQgb3B0aW9uYWwgb24tZGlzayBleHBvcnQgcGF0aC5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHR3cml0ZVRvRGlzazogVHlwZS5PcHRpb25hbChUeXBlLkJvb2xlYW4oeyBkZXNjcmlwdGlvbjogXCJXcml0ZSB0aGUgdGltZWxpbmUgSlNPTiB0byBkaXNrIHVuZGVyIHRoZSBzZXNzaW9uIGFydGlmYWN0IGRpcmVjdG9yeS5cIiB9KSksXG5cdFx0XHRmaWxlbmFtZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk9wdGlvbmFsIEpTT04gZmlsZW5hbWUgd2hlbiB3cml0ZVRvRGlzayBpcyB0cnVlLlwiIH0pKSxcblx0XHR9KSxcblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0YXdhaXQgZGVwcy5lbnN1cmVCcm93c2VyKCk7XG5cdFx0XHRcdGNvbnN0IGFjdGlvblRpbWVsaW5lID0gZ2V0QWN0aW9uVGltZWxpbmUoKTtcblx0XHRcdFx0Y29uc3QgdGltZWxpbmUgPSBmb3JtYXRUaW1lbGluZUVudHJpZXMoYWN0aW9uVGltZWxpbmUuZW50cmllcywge1xuXHRcdFx0XHRcdGxpbWl0OiBhY3Rpb25UaW1lbGluZS5saW1pdCxcblx0XHRcdFx0XHR0b3RhbEFjdGlvbnM6IGFjdGlvblRpbWVsaW5lLm5leHRJZCAtIDEsXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRsZXQgYXJ0aWZhY3Q6IHsgcGF0aDogc3RyaW5nOyBieXRlczogbnVtYmVyIH0gfCBudWxsID0gbnVsbDtcblx0XHRcdFx0aWYgKHBhcmFtcy53cml0ZVRvRGlzaykge1xuXHRcdFx0XHRcdGNvbnN0IGZpbGVuYW1lID0gKHBhcmFtcy5maWxlbmFtZT8udHJpbSgpIHx8IFwidGltZWxpbmUuanNvblwiKS5yZXBsYWNlKC9bXmEtekEtWjAtOS5fLV0rL2csIFwiLVwiKTtcblx0XHRcdFx0XHRhcnRpZmFjdCA9IGF3YWl0IGRlcHMud3JpdGVBcnRpZmFjdEZpbGUoZGVwcy5idWlsZFNlc3Npb25BcnRpZmFjdFBhdGgoZmlsZW5hbWUpLCBKU09OLnN0cmluZ2lmeSh0aW1lbGluZSwgbnVsbCwgMikpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGFydGlmYWN0ID8gYCR7dGltZWxpbmUuc3VtbWFyeX1cXG5BcnRpZmFjdDogJHthcnRpZmFjdC5wYXRofWAgOiB0aW1lbGluZS5zdW1tYXJ5IH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgLi4udGltZWxpbmUsIGFydGlmYWN0LCAuLi5kZXBzLmdldFNlc3Npb25BcnRpZmFjdE1ldGFkYXRhKCkgfSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBUaW1lbGluZSBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSwgLi4uZGVwcy5nZXRTZXNzaW9uQXJ0aWZhY3RNZXRhZGF0YSgpIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfc2Vzc2lvbl9zdW1tYXJ5XG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfc2Vzc2lvbl9zdW1tYXJ5XCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBTZXNzaW9uIFN1bW1hcnlcIixcblx0XHRkZXNjcmlwdGlvbjogXCJSZXR1cm4gYSBjb21wYWN0IHN0cnVjdHVyZWQgc3VtbWFyeSBvZiB0aGUgY3VycmVudCBicm93c2VyIHNlc3Npb24sIGluY2x1ZGluZyBwYWdlcywgYWN0aW9ucywgd2FpdHMvYXNzZXJ0aW9ucywgYm91bmRlZC1oaXN0b3J5IGNhdmVhdHMsIGFuZCB0cmFjZS9IQVIgc3RhdGUuXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe30pLFxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIF9wYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0YXdhaXQgZGVwcy5lbnN1cmVCcm93c2VyKCk7XG5cdFx0XHRcdGNvbnN0IHBhZ2VzID0gYXdhaXQgZGVwcy5nZXRMaXZlUGFnZXNTbmFwc2hvdCgpO1xuXHRcdFx0XHRjb25zdCBhY3Rpb25UaW1lbGluZSA9IGdldEFjdGlvblRpbWVsaW5lKCk7XG5cdFx0XHRcdGNvbnN0IHBhZ2VSZWdpc3RyeSA9IGdldFBhZ2VSZWdpc3RyeSgpO1xuXHRcdFx0XHRjb25zdCBjb25zb2xlTG9ncyA9IGdldENvbnNvbGVMb2dzKCk7XG5cdFx0XHRcdGNvbnN0IG5ldHdvcmtMb2dzID0gZ2V0TmV0d29ya0xvZ3MoKTtcblx0XHRcdFx0Y29uc3QgZGlhbG9nTG9ncyA9IGdldERpYWxvZ0xvZ3MoKTtcblx0XHRcdFx0Y29uc3QgYmFzZVN1bW1hcnkgPSBzdW1tYXJpemVCcm93c2VyU2Vzc2lvbih7XG5cdFx0XHRcdFx0dGltZWxpbmU6IGFjdGlvblRpbWVsaW5lLFxuXHRcdFx0XHRcdHRvdGFsQWN0aW9uczogYWN0aW9uVGltZWxpbmUubmV4dElkIC0gMSxcblx0XHRcdFx0XHRwYWdlcyxcblx0XHRcdFx0XHRhY3RpdmVQYWdlSWQ6IHBhZ2VSZWdpc3RyeS5hY3RpdmVQYWdlSWQsXG5cdFx0XHRcdFx0YWN0aXZlRnJhbWU6IGdldEFjdGl2ZUZyYW1lTWV0YWRhdGEoKSxcblx0XHRcdFx0XHRjb25zb2xlRW50cmllczogY29uc29sZUxvZ3MsXG5cdFx0XHRcdFx0bmV0d29ya0VudHJpZXM6IG5ldHdvcmtMb2dzLFxuXHRcdFx0XHRcdGRpYWxvZ0VudHJpZXM6IGRpYWxvZ0xvZ3MsXG5cdFx0XHRcdFx0Y29uc29sZUxpbWl0OiAxMDAwLFxuXHRcdFx0XHRcdG5ldHdvcmtMaW1pdDogMTAwMCxcblx0XHRcdFx0XHRkaWFsb2dMaW1pdDogMTAwMCxcblx0XHRcdFx0XHRzZXNzaW9uU3RhcnRlZEF0OiBnZXRTZXNzaW9uU3RhcnRlZEF0KCksXG5cdFx0XHRcdFx0bm93OiBEYXRlLm5vdygpLFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0Y29uc3QgZmFpbHVyZUh5cG90aGVzaXMgPSBidWlsZEZhaWx1cmVIeXBvdGhlc2lzKHtcblx0XHRcdFx0XHR0aW1lbGluZTogYWN0aW9uVGltZWxpbmUsXG5cdFx0XHRcdFx0Y29uc29sZUVudHJpZXM6IGNvbnNvbGVMb2dzLFxuXHRcdFx0XHRcdG5ldHdvcmtFbnRyaWVzOiBuZXR3b3JrTG9ncyxcblx0XHRcdFx0XHRkaWFsb2dFbnRyaWVzOiBkaWFsb2dMb2dzLFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0Y29uc3QgYWN0aXZlVHJhY2UgPSBnZXRBY3RpdmVUcmFjZVNlc3Npb24oKTtcblx0XHRcdFx0Y29uc3QgdHJhY2VTdGF0ZSA9IGFjdGl2ZVRyYWNlXG5cdFx0XHRcdFx0PyB7IHN0YXR1czogXCJhY3RpdmVcIiwgLi4uYWN0aXZlVHJhY2UgfVxuXHRcdFx0XHRcdDogeyBzdGF0dXM6IFwiaW5hY3RpdmVcIiwgbGFzdFRyYWNlUGF0aDogZ2V0U2Vzc2lvbkFydGlmYWN0RGlyKCkgPyBkZXBzLmJ1aWxkU2Vzc2lvbkFydGlmYWN0UGF0aChcIioudHJhY2UuemlwXCIpIDogbnVsbCB9O1xuXHRcdFx0XHRjb25zdCBoYXJTdGF0ZSA9IGdldEhhclN0YXRlKCk7XG5cdFx0XHRcdGNvbnN0IGhhclN1bW1hcnkgPSB7XG5cdFx0XHRcdFx0ZW5hYmxlZDogaGFyU3RhdGUuZW5hYmxlZCxcblx0XHRcdFx0XHRjb25maWd1cmVkQXRDb250ZXh0Q3JlYXRpb246IGhhclN0YXRlLmNvbmZpZ3VyZWRBdENvbnRleHRDcmVhdGlvbixcblx0XHRcdFx0XHRwYXRoOiBoYXJTdGF0ZS5wYXRoLFxuXHRcdFx0XHRcdGV4cG9ydENvdW50OiBoYXJTdGF0ZS5leHBvcnRDb3VudCxcblx0XHRcdFx0XHRsYXN0RXhwb3J0ZWRQYXRoOiBoYXJTdGF0ZS5sYXN0RXhwb3J0ZWRQYXRoLFxuXHRcdFx0XHRcdGxhc3RFeHBvcnRlZEF0OiBoYXJTdGF0ZS5sYXN0RXhwb3J0ZWRBdCxcblx0XHRcdFx0fTtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYCR7YmFzZVN1bW1hcnkuc3VtbWFyeX1cXG5GYWlsdXJlIGh5cG90aGVzaXM6ICR7ZmFpbHVyZUh5cG90aGVzaXN9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7XG5cdFx0XHRcdFx0XHQuLi5iYXNlU3VtbWFyeSxcblx0XHRcdFx0XHRcdGZhaWx1cmVIeXBvdGhlc2lzLFxuXHRcdFx0XHRcdFx0dHJhY2U6IHRyYWNlU3RhdGUsXG5cdFx0XHRcdFx0XHRoYXI6IGhhclN1bW1hcnksXG5cdFx0XHRcdFx0XHQuLi5kZXBzLmdldFNlc3Npb25BcnRpZmFjdE1ldGFkYXRhKCksXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBTZXNzaW9uIHN1bW1hcnkgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UsIC4uLmRlcHMuZ2V0U2Vzc2lvbkFydGlmYWN0TWV0YWRhdGEoKSB9LFxuXHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG5cblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBicm93c2VyX2RlYnVnX2J1bmRsZVxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX2RlYnVnX2J1bmRsZVwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgRGVidWcgQnVuZGxlXCIsXG5cdFx0ZGVzY3JpcHRpb246IFwiV3JpdGUgYSB0aW1lc3RhbXBlZCBkZWJ1ZyBidW5kbGUgdG8gZGlzayB3aXRoIHNjcmVlbnNob3QsIGxvZ3MsIHRpbWVsaW5lLCBwYWdlcywgc2Vzc2lvbiBzdW1tYXJ5LCBhbmQgYWNjZXNzaWJpbGl0eSBvdXRwdXQsIHRoZW4gcmV0dXJuIGNvbXBhY3QgcGF0aHMgYW5kIGNvdW50cy5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRzZWxlY3RvcjogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk9wdGlvbmFsIENTUyBzZWxlY3RvciB0byBzY29wZSB0aGUgYWNjZXNzaWJpbGl0eSBzbmFwc2hvdCBiZWZvcmUgZmFsbGJhY2sgYmVoYXZpb3IgYXBwbGllcy5cIiB9KSksXG5cdFx0XHRuYW1lOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiT3B0aW9uYWwgc2hvcnQgYnVuZGxlIG5hbWUgc3VmZml4IGZvciB0aGUgb3V0cHV0IGRpcmVjdG9yeS5cIiB9KSksXG5cdFx0fSksXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHsgcGFnZTogcCB9ID0gYXdhaXQgZGVwcy5lbnN1cmVCcm93c2VyKCk7XG5cdFx0XHRcdGNvbnN0IHN0YXJ0ZWRBdCA9IERhdGUubm93KCk7XG5cdFx0XHRcdGNvbnN0IHNlc3Npb25EaXIgPSBhd2FpdCBkZXBzLmVuc3VyZVNlc3Npb25BcnRpZmFjdERpcigpO1xuXHRcdFx0XHRjb25zdCBidW5kbGVEaXIgPSBwYXRoLmpvaW4oQVJUSUZBQ1RfUk9PVCwgYCR7ZGVwcy5mb3JtYXRBcnRpZmFjdFRpbWVzdGFtcChzdGFydGVkQXQpfS0ke2RlcHMuc2FuaXRpemVBcnRpZmFjdE5hbWUocGFyYW1zLm5hbWUgPz8gXCJkZWJ1Zy1idW5kbGVcIiwgXCJkZWJ1Zy1idW5kbGVcIil9YCk7XG5cdFx0XHRcdGF3YWl0IGVuc3VyZURpcihidW5kbGVEaXIpO1xuXHRcdFx0XHRjb25zdCBwYWdlcyA9IGF3YWl0IGRlcHMuZ2V0TGl2ZVBhZ2VzU25hcHNob3QoKTtcblx0XHRcdFx0Y29uc3QgYWN0aW9uVGltZWxpbmUgPSBnZXRBY3Rpb25UaW1lbGluZSgpO1xuXHRcdFx0XHRjb25zdCBwYWdlUmVnaXN0cnkgPSBnZXRQYWdlUmVnaXN0cnkoKTtcblx0XHRcdFx0Y29uc3QgY29uc29sZUxvZ3MgPSBnZXRDb25zb2xlTG9ncygpO1xuXHRcdFx0XHRjb25zdCBuZXR3b3JrTG9ncyA9IGdldE5ldHdvcmtMb2dzKCk7XG5cdFx0XHRcdGNvbnN0IGRpYWxvZ0xvZ3MgPSBnZXREaWFsb2dMb2dzKCk7XG5cdFx0XHRcdGNvbnN0IHRpbWVsaW5lID0gZm9ybWF0VGltZWxpbmVFbnRyaWVzKGFjdGlvblRpbWVsaW5lLmVudHJpZXMsIHtcblx0XHRcdFx0XHRsaW1pdDogYWN0aW9uVGltZWxpbmUubGltaXQsXG5cdFx0XHRcdFx0dG90YWxBY3Rpb25zOiBhY3Rpb25UaW1lbGluZS5uZXh0SWQgLSAxLFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0Y29uc3Qgc2Vzc2lvblN1bW1hcnkgPSBzdW1tYXJpemVCcm93c2VyU2Vzc2lvbih7XG5cdFx0XHRcdFx0dGltZWxpbmU6IGFjdGlvblRpbWVsaW5lLFxuXHRcdFx0XHRcdHRvdGFsQWN0aW9uczogYWN0aW9uVGltZWxpbmUubmV4dElkIC0gMSxcblx0XHRcdFx0XHRwYWdlcyxcblx0XHRcdFx0XHRhY3RpdmVQYWdlSWQ6IHBhZ2VSZWdpc3RyeS5hY3RpdmVQYWdlSWQsXG5cdFx0XHRcdFx0YWN0aXZlRnJhbWU6IGdldEFjdGl2ZUZyYW1lTWV0YWRhdGEoKSxcblx0XHRcdFx0XHRjb25zb2xlRW50cmllczogY29uc29sZUxvZ3MsXG5cdFx0XHRcdFx0bmV0d29ya0VudHJpZXM6IG5ldHdvcmtMb2dzLFxuXHRcdFx0XHRcdGRpYWxvZ0VudHJpZXM6IGRpYWxvZ0xvZ3MsXG5cdFx0XHRcdFx0Y29uc29sZUxpbWl0OiAxMDAwLFxuXHRcdFx0XHRcdG5ldHdvcmtMaW1pdDogMTAwMCxcblx0XHRcdFx0XHRkaWFsb2dMaW1pdDogMTAwMCxcblx0XHRcdFx0XHRzZXNzaW9uU3RhcnRlZEF0OiBnZXRTZXNzaW9uU3RhcnRlZEF0KCksXG5cdFx0XHRcdFx0bm93OiBEYXRlLm5vdygpLFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0Y29uc3QgZmFpbHVyZUh5cG90aGVzaXMgPSBidWlsZEZhaWx1cmVIeXBvdGhlc2lzKHtcblx0XHRcdFx0XHR0aW1lbGluZTogYWN0aW9uVGltZWxpbmUsXG5cdFx0XHRcdFx0Y29uc29sZUVudHJpZXM6IGNvbnNvbGVMb2dzLFxuXHRcdFx0XHRcdG5ldHdvcmtFbnRyaWVzOiBuZXR3b3JrTG9ncyxcblx0XHRcdFx0XHRkaWFsb2dFbnRyaWVzOiBkaWFsb2dMb2dzLFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0Y29uc3QgYWNjZXNzaWJpbGl0eSA9IGF3YWl0IGRlcHMuY2FwdHVyZUFjY2Vzc2liaWxpdHlNYXJrZG93bihwYXJhbXMuc2VsZWN0b3IpO1xuXHRcdFx0XHRjb25zdCBzY3JlZW5zaG90UGF0aCA9IHBhdGguam9pbihidW5kbGVEaXIsIFwic2NyZWVuc2hvdC5qcGdcIik7XG5cdFx0XHRcdGF3YWl0IHAuc2NyZWVuc2hvdCh7IHBhdGg6IHNjcmVlbnNob3RQYXRoLCB0eXBlOiBcImpwZWdcIiwgcXVhbGl0eTogODAsIGZ1bGxQYWdlOiBmYWxzZSB9KTtcblx0XHRcdFx0Y29uc3Qgc2NyZWVuc2hvdFN0YXQgPSBhd2FpdCBzdGF0KHNjcmVlbnNob3RQYXRoKTtcblx0XHRcdFx0Y29uc3QgYXJ0aWZhY3RzID0ge1xuXHRcdFx0XHRcdHNjcmVlbnNob3Q6IHsgcGF0aDogc2NyZWVuc2hvdFBhdGgsIGJ5dGVzOiBzY3JlZW5zaG90U3RhdC5zaXplIH0sXG5cdFx0XHRcdFx0Y29uc29sZTogYXdhaXQgZGVwcy53cml0ZUFydGlmYWN0RmlsZShwYXRoLmpvaW4oYnVuZGxlRGlyLCBcImNvbnNvbGUuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkoY29uc29sZUxvZ3MsIG51bGwsIDIpKSxcblx0XHRcdFx0XHRuZXR3b3JrOiBhd2FpdCBkZXBzLndyaXRlQXJ0aWZhY3RGaWxlKHBhdGguam9pbihidW5kbGVEaXIsIFwibmV0d29yay5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShuZXR3b3JrTG9ncywgbnVsbCwgMikpLFxuXHRcdFx0XHRcdGRpYWxvZzogYXdhaXQgZGVwcy53cml0ZUFydGlmYWN0RmlsZShwYXRoLmpvaW4oYnVuZGxlRGlyLCBcImRpYWxvZy5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShkaWFsb2dMb2dzLCBudWxsLCAyKSksXG5cdFx0XHRcdFx0dGltZWxpbmU6IGF3YWl0IGRlcHMud3JpdGVBcnRpZmFjdEZpbGUocGF0aC5qb2luKGJ1bmRsZURpciwgXCJ0aW1lbGluZS5qc29uXCIpLCBKU09OLnN0cmluZ2lmeSh0aW1lbGluZSwgbnVsbCwgMikpLFxuXHRcdFx0XHRcdHN1bW1hcnk6IGF3YWl0IGRlcHMud3JpdGVBcnRpZmFjdEZpbGUocGF0aC5qb2luKGJ1bmRsZURpciwgXCJzdW1tYXJ5Lmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHtcblx0XHRcdFx0XHRcdC4uLnNlc3Npb25TdW1tYXJ5LFxuXHRcdFx0XHRcdFx0ZmFpbHVyZUh5cG90aGVzaXMsXG5cdFx0XHRcdFx0XHR0cmFjZTogZ2V0QWN0aXZlVHJhY2VTZXNzaW9uKCksXG5cdFx0XHRcdFx0XHRoYXI6IGdldEhhclN0YXRlKCksXG5cdFx0XHRcdFx0XHRzZXNzaW9uQXJ0aWZhY3REaXI6IHNlc3Npb25EaXIsXG5cdFx0XHRcdFx0fSwgbnVsbCwgMikpLFxuXHRcdFx0XHRcdHBhZ2VzOiBhd2FpdCBkZXBzLndyaXRlQXJ0aWZhY3RGaWxlKHBhdGguam9pbihidW5kbGVEaXIsIFwicGFnZXMuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkocGFnZXMsIG51bGwsIDIpKSxcblx0XHRcdFx0XHRhY2Nlc3NpYmlsaXR5OiBhd2FpdCBkZXBzLndyaXRlQXJ0aWZhY3RGaWxlKHBhdGguam9pbihidW5kbGVEaXIsIFwiYWNjZXNzaWJpbGl0eS5tZFwiKSwgYWNjZXNzaWJpbGl0eS5zbmFwc2hvdCksXG5cdFx0XHRcdH07XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBEZWJ1ZyBidW5kbGUgd3JpdHRlbjogJHtidW5kbGVEaXJ9XFxuJHtzZXNzaW9uU3VtbWFyeS5zdW1tYXJ5fVxcbkZhaWx1cmUgaHlwb3RoZXNpczogJHtmYWlsdXJlSHlwb3RoZXNpc31gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHRcdGJ1bmRsZURpcixcblx0XHRcdFx0XHRcdGFydGlmYWN0cyxcblx0XHRcdFx0XHRcdGFjY2Vzc2liaWxpdHlTY29wZTogYWNjZXNzaWJpbGl0eS5zY29wZSxcblx0XHRcdFx0XHRcdGFjY2Vzc2liaWxpdHlTb3VyY2U6IGFjY2Vzc2liaWxpdHkuc291cmNlLFxuXHRcdFx0XHRcdFx0Y291bnRzOiB7XG5cdFx0XHRcdFx0XHRcdGNvbnNvbGU6IGNvbnNvbGVMb2dzLmxlbmd0aCxcblx0XHRcdFx0XHRcdFx0bmV0d29yazogbmV0d29ya0xvZ3MubGVuZ3RoLFxuXHRcdFx0XHRcdFx0XHRkaWFsb2c6IGRpYWxvZ0xvZ3MubGVuZ3RoLFxuXHRcdFx0XHRcdFx0XHRhY3Rpb25zOiB0aW1lbGluZS5yZXRhaW5lZCxcblx0XHRcdFx0XHRcdFx0cGFnZXM6IHBhZ2VzLmxlbmd0aCxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRlbGFwc2VkTXM6IERhdGUubm93KCkgLSBzdGFydGVkQXQsXG5cdFx0XHRcdFx0XHRzdW1tYXJ5OiBzZXNzaW9uU3VtbWFyeSxcblx0XHRcdFx0XHRcdGZhaWx1cmVIeXBvdGhlc2lzLFxuXHRcdFx0XHRcdFx0Li4uZGVwcy5nZXRTZXNzaW9uQXJ0aWZhY3RNZXRhZGF0YSgpLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRGVidWcgYnVuZGxlIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlLCAuLi5kZXBzLmdldFNlc3Npb25BcnRpZmFjdE1ldGFkYXRhKCkgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsWUFBWTtBQUNyQixPQUFPLFVBQVU7QUFDakI7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBRVA7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUVBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUNQO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBRUEsU0FBUyxxQkFBcUIsSUFBa0IsTUFBc0I7QUFJNUUsS0FBRyxhQUFhO0FBQUEsSUFDZixNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUFhO0FBQUEsSUFDYixZQUFZLEtBQUssT0FBTyxDQUFDLENBQUM7QUFBQSxJQUUxQixNQUFNLFFBQVEsYUFBYSxTQUFTLFNBQVMsV0FBVyxNQUFNO0FBQzdELFVBQUk7QUFDSCxjQUFNLEtBQUssYUFBYTtBQUN4QixlQUFPO0FBQUEsVUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFB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
