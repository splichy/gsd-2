import { Type } from "@sinclair/typebox";
import {
  getSnapshotModeConfig,
  SNAPSHOT_MODES
} from "../core.js";
import {
  getActiveFrame,
  getCurrentRefMap,
  setCurrentRefMap,
  getRefVersion,
  setRefVersion,
  getRefMetadata,
  setRefMetadata
} from "../state.js";
function registerRefTools(pi, deps) {
  pi.registerTool({
    name: "browser_snapshot_refs",
    label: "Browser Snapshot Refs",
    description: "Capture a compact inventory of interactive elements and assign deterministic versioned refs (@vN:e1, @vN:e2, ...). Use these refs with browser_click_ref, browser_fill_ref, and browser_hover_ref.",
    parameters: Type.Object({
      selector: Type.Optional(
        Type.String({
          description: "Optional CSS selector scope for the snapshot (e.g. 'main', 'form', '#modal')."
        })
      ),
      interactiveOnly: Type.Optional(
        Type.Boolean({
          description: "Include only interactive elements (default: true)."
        })
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum number of elements to include (default: 40)."
        })
      ),
      mode: Type.Optional(
        Type.String({
          description: "Semantic snapshot mode that pre-filters elements by category. When set, overrides interactiveOnly. Modes: interactive, form, dialog, navigation, errors, headings, visible_only."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        const mode = params.mode;
        if (mode !== void 0) {
          const modeConfig = getSnapshotModeConfig(mode);
          if (!modeConfig) {
            const validModes = Object.keys(SNAPSHOT_MODES).join(", ");
            return {
              content: [{ type: "text", text: `Unknown snapshot mode: "${mode}". Valid modes: ${validModes}` }],
              details: { error: `Unknown mode: ${mode}`, validModes: Object.keys(SNAPSHOT_MODES) },
              isError: true
            };
          }
        }
        const interactiveOnly = params.interactiveOnly !== false;
        const limit = Math.max(1, Math.min(200, Math.floor(params.limit ?? 40)));
        const rawNodes = await deps.buildRefSnapshot(target, {
          selector: params.selector,
          interactiveOnly,
          limit,
          mode
        });
        const newVersion = getRefVersion() + 1;
        setRefVersion(newVersion);
        const nextMap = {};
        for (let i = 0; i < rawNodes.length; i += 1) {
          const ref = `e${i + 1}`;
          nextMap[ref] = { ref, ...rawNodes[i] };
        }
        setCurrentRefMap(nextMap);
        const activeFrame = getActiveFrame();
        const frameCtx = activeFrame ? activeFrame.name() || activeFrame.url() : void 0;
        setRefMetadata({
          url: p.url(),
          timestamp: Date.now(),
          selectorScope: params.selector,
          interactiveOnly,
          limit,
          version: newVersion,
          frameContext: frameCtx,
          mode
        });
        if (rawNodes.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No elements found for ref snapshot (try interactiveOnly=false or a wider selector scope)."
            }],
            details: {
              count: 0,
              version: newVersion,
              metadata: getRefMetadata(),
              refs: {}
            }
          };
        }
        const versionedRefs = {};
        const lines = Object.values(nextMap).map((node) => {
          const versionedRef = deps.formatVersionedRef(newVersion, node.ref);
          versionedRefs[versionedRef] = node;
          const parts = [versionedRef, node.role || node.tag];
          if (node.name) parts.push(`"${node.name}"`);
          if (node.href) parts.push(`href="${node.href.slice(0, 80)}"`);
          if (!node.isVisible) parts.push("(hidden)");
          if (!node.isEnabled) parts.push("(disabled)");
          return parts.join(" ");
        });
        const modeLabel = mode ? `Mode: ${mode}
` : "";
        return {
          content: [{
            type: "text",
            text: `Ref snapshot v${newVersion} (${rawNodes.length} element(s))
URL: ${p.url()}
Scope: ${params.selector ?? "body"}
` + modeLabel + `Use versioned refs exactly as shown (e.g. @v${newVersion}:e1).

` + lines.join("\n")
          }],
          details: {
            count: rawNodes.length,
            version: newVersion,
            metadata: getRefMetadata(),
            refs: nextMap,
            versionedRefs
          }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Snapshot refs failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_get_ref",
    label: "Browser Get Ref",
    description: "Inspect stored metadata for one deterministic element ref (prefer versioned format, e.g. @v3:e1).",
    parameters: Type.Object({
      ref: Type.String({ description: "Reference id, preferably versioned (e.g. '@v3:e1')." })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const parsedRef = deps.parseRef(params.ref);
      const refMetadata = getRefMetadata();
      const refVersion = getRefVersion();
      if (parsedRef.version !== null && refMetadata && parsedRef.version !== refMetadata.version) {
        return {
          content: [{ type: "text", text: deps.staleRefGuidance(parsedRef.display, `snapshot version mismatch (have v${refMetadata.version})`) }],
          details: { error: "ref_stale", ref: parsedRef.display, expectedVersion: refMetadata.version, receivedVersion: parsedRef.version },
          isError: true
        };
      }
      const currentRefMap = getCurrentRefMap();
      const node = currentRefMap[parsedRef.key];
      if (!node) {
        return {
          content: [{ type: "text", text: deps.staleRefGuidance(parsedRef.display, "ref not found") }],
          details: { error: "ref_not_found", ref: parsedRef.display, metadata: refMetadata },
          isError: true
        };
      }
      const versionedRef = deps.formatVersionedRef(refMetadata?.version ?? refVersion, node.ref);
      return {
        content: [{
          type: "text",
          text: `${versionedRef}: ${node.role || node.tag}${node.name ? ` "${node.name}"` : ""}
Visible: ${node.isVisible}
Enabled: ${node.isEnabled}
Path: ${node.xpathOrPath}`
        }],
        details: { ref: versionedRef, node, metadata: refMetadata }
      };
    }
  });
  pi.registerTool({
    name: "browser_click_ref",
    label: "Browser Click Ref",
    description: "Click a previously snapshotted element by deterministic versioned ref (e.g. @v3:e2).",
    parameters: Type.Object({
      ref: Type.String({ description: "Reference id in versioned format, e.g. '@v3:e2'." })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const parsedRef = deps.parseRef(params.ref);
      const requestedRef = parsedRef.display;
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        const refMetadata = getRefMetadata();
        const refVersion = getRefVersion();
        if (parsedRef.version === null) {
          return {
            content: [{ type: "text", text: `Unversioned ref ${requestedRef} is ambiguous. Use a versioned ref (e.g. @v${refMetadata?.version ?? refVersion}:e1) from browser_snapshot_refs.` }],
            details: { error: "ref_unversioned", ref: requestedRef, metadata: refMetadata },
            isError: true
          };
        }
        if (refMetadata && parsedRef.version !== refMetadata.version) {
          return {
            content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, `snapshot version mismatch (have v${refMetadata.version})`) }],
            details: { error: "ref_stale", ref: requestedRef, expectedVersion: refMetadata.version, receivedVersion: parsedRef.version },
            isError: true
          };
        }
        const currentRefMap = getCurrentRefMap();
        const ref = parsedRef.key;
        const node = currentRefMap[ref];
        if (!node) {
          return {
            content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, "ref not found") }],
            details: { error: "ref_not_found", ref: requestedRef, metadata: refMetadata },
            isError: true
          };
        }
        if (refMetadata?.url && refMetadata.url !== p.url()) {
          return {
            content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, "URL changed since snapshot") }],
            details: { error: "ref_stale", ref: requestedRef, snapshotUrl: refMetadata.url, currentUrl: p.url() },
            isError: true
          };
        }
        const resolved = await deps.resolveRefTarget(target, node);
        if (!resolved.ok) {
          const reason = resolved.reason;
          return {
            content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, reason) }],
            details: { error: "ref_stale", ref: requestedRef, reason },
            isError: true
          };
        }
        const beforeState = await deps.captureCompactPageState(p, { includeBodyText: true, target });
        const beforeUrl = beforeState.url;
        const beforeHash = deps.getUrlHash(beforeUrl);
        const beforeTargetState = await deps.captureClickTargetState(target, resolved.selector);
        await target.locator(resolved.selector).first().click({ timeout: 8e3 });
        const settle = await deps.settleAfterActionAdaptive(p);
        const afterState = await deps.captureCompactPageState(p, { includeBodyText: true, target });
        const afterUrl = afterState.url;
        const afterHash = deps.getUrlHash(afterUrl);
        const afterTargetState = await deps.captureClickTargetState(target, resolved.selector);
        const targetStateChanged = beforeTargetState.exists !== afterTargetState.exists || beforeTargetState.ariaExpanded !== afterTargetState.ariaExpanded || beforeTargetState.ariaPressed !== afterTargetState.ariaPressed || beforeTargetState.ariaSelected !== afterTargetState.ariaSelected || beforeTargetState.open !== afterTargetState.open;
        const verification = deps.verificationFromChecks(
          [
            { name: "url_changed", passed: afterUrl !== beforeUrl, value: afterUrl, expected: `!= ${beforeUrl}` },
            { name: "hash_changed", passed: afterHash !== beforeHash, value: afterHash, expected: `!= ${beforeHash}` },
            { name: "target_state_changed", passed: targetStateChanged, value: afterTargetState, expected: beforeTargetState },
            { name: "dialog_open", passed: afterState.dialog.count > beforeState.dialog.count, value: afterState.dialog.count, expected: `> ${beforeState.dialog.count}` }
          ],
          "Ref may now point to an inert element. Refresh refs with browser_snapshot_refs and retry."
        );
        const summary = deps.formatCompactStateSummary(afterState);
        const jsErrors = deps.getRecentErrors(p.url());
        const versionedRef = deps.formatVersionedRef(refMetadata?.version ?? refVersion, node.ref);
        return {
          content: [{
            type: "text",
            text: `Clicked ${versionedRef} (${node.role || node.tag}${node.name ? ` "${node.name}"` : ""})
${deps.verificationLine(verification)}${jsErrors}

Page summary:
${summary}`
          }],
          details: { ref: versionedRef, selector: resolved.selector, url: p.url(), ...settle, ...verification }
        };
      } catch (err) {
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const reason = deps.firstErrorLine(err);
        const content = [
          { type: "text", text: deps.staleRefGuidance(requestedRef, `action failed: ${reason}`) },
          { type: "text", text: `Click ref failed: ${err.message}` }
        ];
        if (errorShot) {
          content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        }
        return {
          content,
          details: { error: err.message, ref: requestedRef, hint: "Run browser_snapshot_refs to refresh refs." },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_hover_ref",
    label: "Browser Hover Ref",
    description: "Hover a previously snapshotted element by deterministic versioned ref (e.g. @v3:e4).",
    parameters: Type.Object({
      ref: Type.String({ description: "Reference id in versioned format, e.g. '@v3:e4'." })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const parsedRef = deps.parseRef(params.ref);
      const requestedRef = parsedRef.display;
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        const refMetadata = getRefMetadata();
        const refVersion = getRefVersion();
        if (parsedRef.version === null) {
          return {
            content: [{ type: "text", text: `Unversioned ref ${requestedRef} is ambiguous. Use a versioned ref (e.g. @v${refMetadata?.version ?? refVersion}:e1) from browser_snapshot_refs.` }],
            details: { error: "ref_unversioned", ref: requestedRef, metadata: refMetadata },
            isError: true
          };
        }
        if (refMetadata && parsedRef.version !== refMetadata.version) {
          return {
            content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, `snapshot version mismatch (have v${refMetadata.version})`) }],
            details: { error: "ref_stale", ref: requestedRef, expectedVersion: refMetadata.version, receivedVersion: parsedRef.version },
            isError: true
          };
        }
        const currentRefMap = getCurrentRefMap();
        const ref = parsedRef.key;
        const node = currentRefMap[ref];
        if (!node) {
          return {
            content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, "ref not found") }],
            details: { error: "ref_not_found", ref: requestedRef, metadata: refMetadata },
            isError: true
          };
        }
        if (refMetadata?.url && refMetadata.url !== p.url()) {
          return {
            content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, "URL changed since snapshot") }],
            details: { error: "ref_stale", ref: requestedRef, snapshotUrl: refMetadata.url, currentUrl: p.url() },
            isError: true
          };
        }
        const resolved = await deps.resolveRefTarget(target, node);
        if (!resolved.ok) {
          const reason = resolved.reason;
          return {
            content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, reason) }],
            details: { error: "ref_stale", ref: requestedRef, reason },
            isError: true
          };
        }
        await target.locator(resolved.selector).first().hover({ timeout: 8e3 });
        const settle = await deps.settleAfterActionAdaptive(p);
        const afterState = await deps.captureCompactPageState(p, { includeBodyText: false, target });
        const summary = deps.formatCompactStateSummary(afterState);
        const jsErrors = deps.getRecentErrors(p.url());
        const versionedRef = deps.formatVersionedRef(refMetadata?.version ?? refVersion, node.ref);
        return {
          content: [{
            type: "text",
            text: `Hovered ${versionedRef} (${node.role || node.tag}${node.name ? ` "${node.name}"` : ""})${jsErrors}

Page summary:
${summary}`
          }],
          details: { ref: versionedRef, selector: resolved.selector, url: p.url(), ...settle }
        };
      } catch (err) {
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const reason = deps.firstErrorLine(err);
        const content = [
          { type: "text", text: deps.staleRefGuidance(requestedRef, `action failed: ${reason}`) },
          { type: "text", text: `Hover ref failed: ${err.message}` }
        ];
        if (errorShot) {
          content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        }
        return {
          content,
          details: { error: err.message, ref: requestedRef, hint: "Run browser_snapshot_refs to refresh refs." },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_fill_ref",
    label: "Browser Fill Ref",
    description: "Fill/type text into an input-like element by deterministic versioned ref (e.g. @v3:e1).",
    parameters: Type.Object({
      ref: Type.String({ description: "Reference id in versioned format, e.g. '@v3:e1'." }),
      text: Type.String({ description: "Text to enter." }),
      clearFirst: Type.Optional(
        Type.Boolean({ description: "Clear existing value first (default: false)." })
      ),
      submit: Type.Optional(
        Type.Boolean({ description: "Press Enter after typing (default: false)." })
      ),
      slowly: Type.Optional(
        Type.Boolean({ description: "Type character-by-character (default: false)." })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const parsedRef = deps.parseRef(params.ref);
      const requestedRef = parsedRef.display;
      try {
        const { page: p } = await deps.ensureBrowser();
        const target = deps.getActiveTarget();
        const refMetadata = getRefMetadata();
        const refVersion = getRefVersion();
        if (parsedRef.version === null) {
          return {
            content: [{ type: "text", text: `Unversioned ref ${requestedRef} is ambiguous. Use a versioned ref (e.g. @v${refMetadata?.version ?? refVersion}:e1) from browser_snapshot_refs.` }],
            details: { error: "ref_unversioned", ref: requestedRef, metadata: refMetadata },
            isError: true
          };
        }
        if (refMetadata && parsedRef.version !== refMetadata.version) {
          return {
            content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, `snapshot version mismatch (have v${refMetadata.version})`) }],
            details: { error: "ref_stale", ref: requestedRef, expectedVersion: refMetadata.version, receivedVersion: parsedRef.version },
            isError: true
          };
        }
        const currentRefMap = getCurrentRefMap();
        const ref = parsedRef.key;
        const node = currentRefMap[ref];
        if (!node) {
          return {
            content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, "ref not found") }],
            details: { error: "ref_not_found", ref: requestedRef, metadata: refMetadata },
            isError: true
          };
        }
        if (refMetadata?.url && refMetadata.url !== p.url()) {
          return {
            content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, "URL changed since snapshot") }],
            details: { error: "ref_stale", ref: requestedRef, snapshotUrl: refMetadata.url, currentUrl: p.url() },
            isError: true
          };
        }
        const resolved = await deps.resolveRefTarget(target, node);
        if (!resolved.ok) {
          const reason = resolved.reason;
          return {
            content: [{ type: "text", text: deps.staleRefGuidance(requestedRef, reason) }],
            details: { error: "ref_stale", ref: requestedRef, reason },
            isError: true
          };
        }
        const locator = target.locator(resolved.selector).first();
        const beforeUrl = p.url();
        if (params.slowly) {
          await locator.click({ timeout: 8e3 });
          if (params.clearFirst) {
            await p.keyboard.press("Control+A");
            await p.keyboard.press("Delete");
          }
          await p.keyboard.type(params.text);
        } else {
          if (params.clearFirst) {
            await locator.fill("");
          }
          await locator.fill(params.text, { timeout: 8e3 });
        }
        if (params.submit) {
          await p.keyboard.press("Enter");
        }
        const settle = await deps.settleAfterActionAdaptive(p);
        const filledValue = await deps.readInputLikeValue(target, resolved.selector);
        const afterUrl = p.url();
        const verification = deps.verificationFromChecks(
          [
            { name: "value_equals_expected", passed: filledValue === params.text, value: filledValue, expected: params.text },
            { name: "value_contains_expected", passed: typeof filledValue === "string" && filledValue.includes(params.text), value: filledValue, expected: params.text },
            { name: "url_changed_after_submit", passed: !!params.submit && afterUrl !== beforeUrl, value: afterUrl, expected: `!= ${beforeUrl}` }
          ],
          "Try refreshing refs and confirm this ref still targets an input-like element."
        );
        const afterState = await deps.captureCompactPageState(p, { includeBodyText: true, target });
        const summary = deps.formatCompactStateSummary(afterState);
        const jsErrors = deps.getRecentErrors(p.url());
        const versionedRef = deps.formatVersionedRef(refMetadata?.version ?? refVersion, node.ref);
        return {
          content: [{
            type: "text",
            text: `Filled ${versionedRef} (${node.role || node.tag}${node.name ? ` "${node.name}"` : ""}) with "${params.text}"
${deps.verificationLine(verification)}${jsErrors}

Page summary:
${summary}`
          }],
          details: { ref: versionedRef, selector: resolved.selector, url: p.url(), filledValue, ...settle, ...verification }
        };
      } catch (err) {
        const errorShot = await deps.captureErrorScreenshot(deps.getActivePageOrNull());
        const reason = deps.firstErrorLine(err);
        const content = [
          { type: "text", text: deps.staleRefGuidance(requestedRef, `action failed: ${reason}`) },
          { type: "text", text: `Fill ref failed: ${err.message}` }
        ];
        if (errorShot) {
          content.push({ type: "image", data: errorShot.data, mimeType: errorShot.mimeType });
        }
        return {
          content,
          details: { error: err.message, ref: requestedRef, hint: "Run browser_snapshot_refs to refresh refs." },
          isError: true
        };
      }
    }
  });
}
export {
  registerRefTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvcmVmcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB7XG5cdGdldFNuYXBzaG90TW9kZUNvbmZpZyxcblx0U05BUFNIT1RfTU9ERVMsXG59IGZyb20gXCIuLi9jb3JlLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFRvb2xEZXBzLCBSZWZOb2RlIH0gZnJvbSBcIi4uL3N0YXRlLmpzXCI7XG5pbXBvcnQge1xuXHRnZXRBY3RpdmVGcmFtZSxcblx0Z2V0Q3VycmVudFJlZk1hcCxcblx0c2V0Q3VycmVudFJlZk1hcCxcblx0Z2V0UmVmVmVyc2lvbixcblx0c2V0UmVmVmVyc2lvbixcblx0Z2V0UmVmTWV0YWRhdGEsXG5cdHNldFJlZk1ldGFkYXRhLFxufSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyUmVmVG9vbHMocGk6IEV4dGVuc2lvbkFQSSwgZGVwczogVG9vbERlcHMpOiB2b2lkIHtcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBicm93c2VyX3NuYXBzaG90X3JlZnNcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9zbmFwc2hvdF9yZWZzXCIsXG5cdFx0bGFiZWw6IFwiQnJvd3NlciBTbmFwc2hvdCBSZWZzXCIsXG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcIkNhcHR1cmUgYSBjb21wYWN0IGludmVudG9yeSBvZiBpbnRlcmFjdGl2ZSBlbGVtZW50cyBhbmQgYXNzaWduIGRldGVybWluaXN0aWMgdmVyc2lvbmVkIHJlZnMgKEB2TjplMSwgQHZOOmUyLCAuLi4pLiBVc2UgdGhlc2UgcmVmcyB3aXRoIGJyb3dzZXJfY2xpY2tfcmVmLCBicm93c2VyX2ZpbGxfcmVmLCBhbmQgYnJvd3Nlcl9ob3Zlcl9yZWYuXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0c2VsZWN0b3I6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJPcHRpb25hbCBDU1Mgc2VsZWN0b3Igc2NvcGUgZm9yIHRoZSBzbmFwc2hvdCAoZS5nLiAnbWFpbicsICdmb3JtJywgJyNtb2RhbCcpLlwiLFxuXHRcdFx0XHR9KVxuXHRcdFx0KSxcblx0XHRcdGludGVyYWN0aXZlT25seTogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5Cb29sZWFuKHtcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJJbmNsdWRlIG9ubHkgaW50ZXJhY3RpdmUgZWxlbWVudHMgKGRlZmF1bHQ6IHRydWUpLlwiLFxuXHRcdFx0XHR9KVxuXHRcdFx0KSxcblx0XHRcdGxpbWl0OiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLk51bWJlcih7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiTWF4aW11bSBudW1iZXIgb2YgZWxlbWVudHMgdG8gaW5jbHVkZSAoZGVmYXVsdDogNDApLlwiLFxuXHRcdFx0XHR9KVxuXHRcdFx0KSxcblx0XHRcdG1vZGU6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuU3RyaW5nKHtcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJTZW1hbnRpYyBzbmFwc2hvdCBtb2RlIHRoYXQgcHJlLWZpbHRlcnMgZWxlbWVudHMgYnkgY2F0ZWdvcnkuIFdoZW4gc2V0LCBvdmVycmlkZXMgaW50ZXJhY3RpdmVPbmx5LiBNb2RlczogaW50ZXJhY3RpdmUsIGZvcm0sIGRpYWxvZywgbmF2aWdhdGlvbiwgZXJyb3JzLCBoZWFkaW5ncywgdmlzaWJsZV9vbmx5LlwiLFxuXHRcdFx0XHR9KVxuXHRcdFx0KSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCB7IHBhZ2U6IHAgfSA9IGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCB0YXJnZXQgPSBkZXBzLmdldEFjdGl2ZVRhcmdldCgpO1xuXG5cdFx0XHRcdGNvbnN0IG1vZGUgPSBwYXJhbXMubW9kZTtcblx0XHRcdFx0aWYgKG1vZGUgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRcdGNvbnN0IG1vZGVDb25maWcgPSBnZXRTbmFwc2hvdE1vZGVDb25maWcobW9kZSk7XG5cdFx0XHRcdFx0aWYgKCFtb2RlQ29uZmlnKSB7XG5cdFx0XHRcdFx0XHRjb25zdCB2YWxpZE1vZGVzID0gT2JqZWN0LmtleXMoU05BUFNIT1RfTU9ERVMpLmpvaW4oXCIsIFwiKTtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgVW5rbm93biBzbmFwc2hvdCBtb2RlOiBcIiR7bW9kZX1cIi4gVmFsaWQgbW9kZXM6ICR7dmFsaWRNb2Rlc31gIH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBgVW5rbm93biBtb2RlOiAke21vZGV9YCwgdmFsaWRNb2RlczogT2JqZWN0LmtleXMoU05BUFNIT1RfTU9ERVMpIH0sXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGludGVyYWN0aXZlT25seSA9IHBhcmFtcy5pbnRlcmFjdGl2ZU9ubHkgIT09IGZhbHNlO1xuXHRcdFx0XHRjb25zdCBsaW1pdCA9IE1hdGgubWF4KDEsIE1hdGgubWluKDIwMCwgTWF0aC5mbG9vcihwYXJhbXMubGltaXQgPz8gNDApKSk7XG5cdFx0XHRcdGNvbnN0IHJhd05vZGVzID0gYXdhaXQgZGVwcy5idWlsZFJlZlNuYXBzaG90KHRhcmdldCwge1xuXHRcdFx0XHRcdHNlbGVjdG9yOiBwYXJhbXMuc2VsZWN0b3IsXG5cdFx0XHRcdFx0aW50ZXJhY3RpdmVPbmx5LFxuXHRcdFx0XHRcdGxpbWl0LFxuXHRcdFx0XHRcdG1vZGUsXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdGNvbnN0IG5ld1ZlcnNpb24gPSBnZXRSZWZWZXJzaW9uKCkgKyAxO1xuXHRcdFx0XHRzZXRSZWZWZXJzaW9uKG5ld1ZlcnNpb24pO1xuXHRcdFx0XHRjb25zdCBuZXh0TWFwOiBSZWNvcmQ8c3RyaW5nLCBSZWZOb2RlPiA9IHt9O1xuXHRcdFx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHJhd05vZGVzLmxlbmd0aDsgaSArPSAxKSB7XG5cdFx0XHRcdFx0Y29uc3QgcmVmID0gYGUke2kgKyAxfWA7XG5cdFx0XHRcdFx0bmV4dE1hcFtyZWZdID0geyByZWYsIC4uLnJhd05vZGVzW2ldIH07XG5cdFx0XHRcdH1cblx0XHRcdFx0c2V0Q3VycmVudFJlZk1hcChuZXh0TWFwKTtcblx0XHRcdFx0Y29uc3QgYWN0aXZlRnJhbWUgPSBnZXRBY3RpdmVGcmFtZSgpO1xuXHRcdFx0XHRjb25zdCBmcmFtZUN0eCA9IGFjdGl2ZUZyYW1lID8gKGFjdGl2ZUZyYW1lLm5hbWUoKSB8fCBhY3RpdmVGcmFtZS51cmwoKSkgOiB1bmRlZmluZWQ7XG5cdFx0XHRcdHNldFJlZk1ldGFkYXRhKHtcblx0XHRcdFx0XHR1cmw6IHAudXJsKCksXG5cdFx0XHRcdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHRcdFx0XHRcdHNlbGVjdG9yU2NvcGU6IHBhcmFtcy5zZWxlY3Rvcixcblx0XHRcdFx0XHRpbnRlcmFjdGl2ZU9ubHksXG5cdFx0XHRcdFx0bGltaXQsXG5cdFx0XHRcdFx0dmVyc2lvbjogbmV3VmVyc2lvbixcblx0XHRcdFx0XHRmcmFtZUNvbnRleHQ6IGZyYW1lQ3R4LFxuXHRcdFx0XHRcdG1vZGUsXG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdGlmIChyYXdOb2Rlcy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3tcblx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHRcdHRleHQ6IFwiTm8gZWxlbWVudHMgZm91bmQgZm9yIHJlZiBzbmFwc2hvdCAodHJ5IGludGVyYWN0aXZlT25seT1mYWxzZSBvciBhIHdpZGVyIHNlbGVjdG9yIHNjb3BlKS5cIixcblx0XHRcdFx0XHRcdH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczoge1xuXHRcdFx0XHRcdFx0XHRjb3VudDogMCxcblx0XHRcdFx0XHRcdFx0dmVyc2lvbjogbmV3VmVyc2lvbixcblx0XHRcdFx0XHRcdFx0bWV0YWRhdGE6IGdldFJlZk1ldGFkYXRhKCksXG5cdFx0XHRcdFx0XHRcdHJlZnM6IHt9LFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgdmVyc2lvbmVkUmVmczogUmVjb3JkPHN0cmluZywgUmVmTm9kZT4gPSB7fTtcblx0XHRcdFx0Y29uc3QgbGluZXMgPSBPYmplY3QudmFsdWVzKG5leHRNYXApLm1hcCgobm9kZSkgPT4ge1xuXHRcdFx0XHRcdGNvbnN0IHZlcnNpb25lZFJlZiA9IGRlcHMuZm9ybWF0VmVyc2lvbmVkUmVmKG5ld1ZlcnNpb24sIG5vZGUucmVmKTtcblx0XHRcdFx0XHR2ZXJzaW9uZWRSZWZzW3ZlcnNpb25lZFJlZl0gPSBub2RlO1xuXHRcdFx0XHRcdGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFt2ZXJzaW9uZWRSZWYsIG5vZGUucm9sZSB8fCBub2RlLnRhZ107XG5cdFx0XHRcdFx0aWYgKG5vZGUubmFtZSkgcGFydHMucHVzaChgXCIke25vZGUubmFtZX1cImApO1xuXHRcdFx0XHRcdGlmIChub2RlLmhyZWYpIHBhcnRzLnB1c2goYGhyZWY9XCIke25vZGUuaHJlZi5zbGljZSgwLCA4MCl9XCJgKTtcblx0XHRcdFx0XHRpZiAoIW5vZGUuaXNWaXNpYmxlKSBwYXJ0cy5wdXNoKFwiKGhpZGRlbilcIik7XG5cdFx0XHRcdFx0aWYgKCFub2RlLmlzRW5hYmxlZCkgcGFydHMucHVzaChcIihkaXNhYmxlZClcIik7XG5cdFx0XHRcdFx0cmV0dXJuIHBhcnRzLmpvaW4oXCIgXCIpO1xuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHRjb25zdCBtb2RlTGFiZWwgPSBtb2RlID8gYE1vZGU6ICR7bW9kZX1cXG5gIDogXCJcIjtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHR0ZXh0OlxuXHRcdFx0XHRcdFx0XHRgUmVmIHNuYXBzaG90IHYke25ld1ZlcnNpb259ICgke3Jhd05vZGVzLmxlbmd0aH0gZWxlbWVudChzKSlcXG5gICtcblx0XHRcdFx0XHRcdFx0YFVSTDogJHtwLnVybCgpfVxcbmAgK1xuXHRcdFx0XHRcdFx0XHRgU2NvcGU6ICR7cGFyYW1zLnNlbGVjdG9yID8/IFwiYm9keVwifVxcbmAgK1xuXHRcdFx0XHRcdFx0XHRtb2RlTGFiZWwgK1xuXHRcdFx0XHRcdFx0XHRgVXNlIHZlcnNpb25lZCByZWZzIGV4YWN0bHkgYXMgc2hvd24gKGUuZy4gQHYke25ld1ZlcnNpb259OmUxKS5cXG5cXG5gICtcblx0XHRcdFx0XHRcdFx0bGluZXMuam9pbihcIlxcblwiKSxcblx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7XG5cdFx0XHRcdFx0XHRjb3VudDogcmF3Tm9kZXMubGVuZ3RoLFxuXHRcdFx0XHRcdFx0dmVyc2lvbjogbmV3VmVyc2lvbixcblx0XHRcdFx0XHRcdG1ldGFkYXRhOiBnZXRSZWZNZXRhZGF0YSgpLFxuXHRcdFx0XHRcdFx0cmVmczogbmV4dE1hcCxcblx0XHRcdFx0XHRcdHZlcnNpb25lZFJlZnMsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fTtcblx0XHRcdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBTbmFwc2hvdCByZWZzIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfZ2V0X3JlZlxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX2dldF9yZWZcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIEdldCBSZWZcIixcblx0XHRkZXNjcmlwdGlvbjogXCJJbnNwZWN0IHN0b3JlZCBtZXRhZGF0YSBmb3Igb25lIGRldGVybWluaXN0aWMgZWxlbWVudCByZWYgKHByZWZlciB2ZXJzaW9uZWQgZm9ybWF0LCBlLmcuIEB2MzplMSkuXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0cmVmOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlJlZmVyZW5jZSBpZCwgcHJlZmVyYWJseSB2ZXJzaW9uZWQgKGUuZy4gJ0B2MzplMScpLlwiIH0pLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdGNvbnN0IHBhcnNlZFJlZiA9IGRlcHMucGFyc2VSZWYocGFyYW1zLnJlZik7XG5cdFx0XHRjb25zdCByZWZNZXRhZGF0YSA9IGdldFJlZk1ldGFkYXRhKCk7XG5cdFx0XHRjb25zdCByZWZWZXJzaW9uID0gZ2V0UmVmVmVyc2lvbigpO1xuXHRcdFx0aWYgKHBhcnNlZFJlZi52ZXJzaW9uICE9PSBudWxsICYmIHJlZk1ldGFkYXRhICYmIHBhcnNlZFJlZi52ZXJzaW9uICE9PSByZWZNZXRhZGF0YS52ZXJzaW9uKSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGRlcHMuc3RhbGVSZWZHdWlkYW5jZShwYXJzZWRSZWYuZGlzcGxheSwgYHNuYXBzaG90IHZlcnNpb24gbWlzbWF0Y2ggKGhhdmUgdiR7cmVmTWV0YWRhdGEudmVyc2lvbn0pYCkgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogXCJyZWZfc3RhbGVcIiwgcmVmOiBwYXJzZWRSZWYuZGlzcGxheSwgZXhwZWN0ZWRWZXJzaW9uOiByZWZNZXRhZGF0YS52ZXJzaW9uLCByZWNlaXZlZFZlcnNpb246IHBhcnNlZFJlZi52ZXJzaW9uIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgY3VycmVudFJlZk1hcCA9IGdldEN1cnJlbnRSZWZNYXAoKTtcblx0XHRcdGNvbnN0IG5vZGUgPSBjdXJyZW50UmVmTWFwW3BhcnNlZFJlZi5rZXldO1xuXHRcdFx0aWYgKCFub2RlKSB7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGRlcHMuc3RhbGVSZWZHdWlkYW5jZShwYXJzZWRSZWYuZGlzcGxheSwgXCJyZWYgbm90IGZvdW5kXCIpIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IFwicmVmX25vdF9mb3VuZFwiLCByZWY6IHBhcnNlZFJlZi5kaXNwbGF5LCBtZXRhZGF0YTogcmVmTWV0YWRhdGEgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCB2ZXJzaW9uZWRSZWYgPSBkZXBzLmZvcm1hdFZlcnNpb25lZFJlZihyZWZNZXRhZGF0YT8udmVyc2lvbiA/PyByZWZWZXJzaW9uLCBub2RlLnJlZik7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRjb250ZW50OiBbe1xuXHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdHRleHQ6IGAke3ZlcnNpb25lZFJlZn06ICR7bm9kZS5yb2xlIHx8IG5vZGUudGFnfSR7bm9kZS5uYW1lID8gYCBcIiR7bm9kZS5uYW1lfVwiYCA6IFwiXCJ9XFxuVmlzaWJsZTogJHtub2RlLmlzVmlzaWJsZX1cXG5FbmFibGVkOiAke25vZGUuaXNFbmFibGVkfVxcblBhdGg6ICR7bm9kZS54cGF0aE9yUGF0aH1gLFxuXHRcdFx0XHR9XSxcblx0XHRcdFx0ZGV0YWlsczogeyByZWY6IHZlcnNpb25lZFJlZiwgbm9kZSwgbWV0YWRhdGE6IHJlZk1ldGFkYXRhIH0sXG5cdFx0XHR9O1xuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gYnJvd3Nlcl9jbGlja19yZWZcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9jbGlja19yZWZcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIENsaWNrIFJlZlwiLFxuXHRcdGRlc2NyaXB0aW9uOiBcIkNsaWNrIGEgcHJldmlvdXNseSBzbmFwc2hvdHRlZCBlbGVtZW50IGJ5IGRldGVybWluaXN0aWMgdmVyc2lvbmVkIHJlZiAoZS5nLiBAdjM6ZTIpLlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdHJlZjogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJSZWZlcmVuY2UgaWQgaW4gdmVyc2lvbmVkIGZvcm1hdCwgZS5nLiAnQHYzOmUyJy5cIiB9KSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHRjb25zdCBwYXJzZWRSZWYgPSBkZXBzLnBhcnNlUmVmKHBhcmFtcy5yZWYpO1xuXHRcdFx0Y29uc3QgcmVxdWVzdGVkUmVmID0gcGFyc2VkUmVmLmRpc3BsYXk7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCB7IHBhZ2U6IHAgfSA9IGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCB0YXJnZXQgPSBkZXBzLmdldEFjdGl2ZVRhcmdldCgpO1xuXHRcdFx0XHRjb25zdCByZWZNZXRhZGF0YSA9IGdldFJlZk1ldGFkYXRhKCk7XG5cdFx0XHRcdGNvbnN0IHJlZlZlcnNpb24gPSBnZXRSZWZWZXJzaW9uKCk7XG5cdFx0XHRcdGlmIChwYXJzZWRSZWYudmVyc2lvbiA9PT0gbnVsbCkge1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFVudmVyc2lvbmVkIHJlZiAke3JlcXVlc3RlZFJlZn0gaXMgYW1iaWd1b3VzLiBVc2UgYSB2ZXJzaW9uZWQgcmVmIChlLmcuIEB2JHtyZWZNZXRhZGF0YT8udmVyc2lvbiA/PyByZWZWZXJzaW9ufTplMSkgZnJvbSBicm93c2VyX3NuYXBzaG90X3JlZnMuYCB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IFwicmVmX3VudmVyc2lvbmVkXCIsIHJlZjogcmVxdWVzdGVkUmVmLCBtZXRhZGF0YTogcmVmTWV0YWRhdGEgfSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAocmVmTWV0YWRhdGEgJiYgcGFyc2VkUmVmLnZlcnNpb24gIT09IHJlZk1ldGFkYXRhLnZlcnNpb24pIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGRlcHMuc3RhbGVSZWZHdWlkYW5jZShyZXF1ZXN0ZWRSZWYsIGBzbmFwc2hvdCB2ZXJzaW9uIG1pc21hdGNoIChoYXZlIHYke3JlZk1ldGFkYXRhLnZlcnNpb259KWApIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogXCJyZWZfc3RhbGVcIiwgcmVmOiByZXF1ZXN0ZWRSZWYsIGV4cGVjdGVkVmVyc2lvbjogcmVmTWV0YWRhdGEudmVyc2lvbiwgcmVjZWl2ZWRWZXJzaW9uOiBwYXJzZWRSZWYudmVyc2lvbiB9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IGN1cnJlbnRSZWZNYXAgPSBnZXRDdXJyZW50UmVmTWFwKCk7XG5cdFx0XHRcdGNvbnN0IHJlZiA9IHBhcnNlZFJlZi5rZXk7XG5cdFx0XHRcdGNvbnN0IG5vZGUgPSBjdXJyZW50UmVmTWFwW3JlZl07XG5cdFx0XHRcdGlmICghbm9kZSkge1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogZGVwcy5zdGFsZVJlZkd1aWRhbmNlKHJlcXVlc3RlZFJlZiwgXCJyZWYgbm90IGZvdW5kXCIpIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogXCJyZWZfbm90X2ZvdW5kXCIsIHJlZjogcmVxdWVzdGVkUmVmLCBtZXRhZGF0YTogcmVmTWV0YWRhdGEgfSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAocmVmTWV0YWRhdGE/LnVybCAmJiByZWZNZXRhZGF0YS51cmwgIT09IHAudXJsKCkpIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGRlcHMuc3RhbGVSZWZHdWlkYW5jZShyZXF1ZXN0ZWRSZWYsIFwiVVJMIGNoYW5nZWQgc2luY2Ugc25hcHNob3RcIikgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBcInJlZl9zdGFsZVwiLCByZWY6IHJlcXVlc3RlZFJlZiwgc25hcHNob3RVcmw6IHJlZk1ldGFkYXRhLnVybCwgY3VycmVudFVybDogcC51cmwoKSB9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgcmVzb2x2ZWQgPSBhd2FpdCBkZXBzLnJlc29sdmVSZWZUYXJnZXQodGFyZ2V0LCBub2RlKTtcblx0XHRcdFx0aWYgKCFyZXNvbHZlZC5vaykge1xuXHRcdFx0XHRcdGNvbnN0IHJlYXNvbiA9IChyZXNvbHZlZCBhcyB7IG9rOiBmYWxzZTsgcmVhc29uOiBzdHJpbmcgfSkucmVhc29uO1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogZGVwcy5zdGFsZVJlZkd1aWRhbmNlKHJlcXVlc3RlZFJlZiwgcmVhc29uKSB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IFwicmVmX3N0YWxlXCIsIHJlZjogcmVxdWVzdGVkUmVmLCByZWFzb24gfSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGJlZm9yZVN0YXRlID0gYXdhaXQgZGVwcy5jYXB0dXJlQ29tcGFjdFBhZ2VTdGF0ZShwLCB7IGluY2x1ZGVCb2R5VGV4dDogdHJ1ZSwgdGFyZ2V0IH0pO1xuXHRcdFx0XHRjb25zdCBiZWZvcmVVcmwgPSBiZWZvcmVTdGF0ZS51cmw7XG5cdFx0XHRcdGNvbnN0IGJlZm9yZUhhc2ggPSBkZXBzLmdldFVybEhhc2goYmVmb3JlVXJsKTtcblx0XHRcdFx0Y29uc3QgYmVmb3JlVGFyZ2V0U3RhdGUgPSBhd2FpdCBkZXBzLmNhcHR1cmVDbGlja1RhcmdldFN0YXRlKHRhcmdldCwgcmVzb2x2ZWQuc2VsZWN0b3IpO1xuXHRcdFx0XHRhd2FpdCB0YXJnZXQubG9jYXRvcihyZXNvbHZlZC5zZWxlY3RvcikuZmlyc3QoKS5jbGljayh7IHRpbWVvdXQ6IDgwMDAgfSk7XG5cdFx0XHRcdGNvbnN0IHNldHRsZSA9IGF3YWl0IGRlcHMuc2V0dGxlQWZ0ZXJBY3Rpb25BZGFwdGl2ZShwKTtcblxuXHRcdFx0XHRjb25zdCBhZnRlclN0YXRlID0gYXdhaXQgZGVwcy5jYXB0dXJlQ29tcGFjdFBhZ2VTdGF0ZShwLCB7IGluY2x1ZGVCb2R5VGV4dDogdHJ1ZSwgdGFyZ2V0IH0pO1xuXHRcdFx0XHRjb25zdCBhZnRlclVybCA9IGFmdGVyU3RhdGUudXJsO1xuXHRcdFx0XHRjb25zdCBhZnRlckhhc2ggPSBkZXBzLmdldFVybEhhc2goYWZ0ZXJVcmwpO1xuXHRcdFx0XHRjb25zdCBhZnRlclRhcmdldFN0YXRlID0gYXdhaXQgZGVwcy5jYXB0dXJlQ2xpY2tUYXJnZXRTdGF0ZSh0YXJnZXQsIHJlc29sdmVkLnNlbGVjdG9yKTtcblx0XHRcdFx0Y29uc3QgdGFyZ2V0U3RhdGVDaGFuZ2VkID1cblx0XHRcdFx0XHRiZWZvcmVUYXJnZXRTdGF0ZS5leGlzdHMgIT09IGFmdGVyVGFyZ2V0U3RhdGUuZXhpc3RzIHx8XG5cdFx0XHRcdFx0YmVmb3JlVGFyZ2V0U3RhdGUuYXJpYUV4cGFuZGVkICE9PSBhZnRlclRhcmdldFN0YXRlLmFyaWFFeHBhbmRlZCB8fFxuXHRcdFx0XHRcdGJlZm9yZVRhcmdldFN0YXRlLmFyaWFQcmVzc2VkICE9PSBhZnRlclRhcmdldFN0YXRlLmFyaWFQcmVzc2VkIHx8XG5cdFx0XHRcdFx0YmVmb3JlVGFyZ2V0U3RhdGUuYXJpYVNlbGVjdGVkICE9PSBhZnRlclRhcmdldFN0YXRlLmFyaWFTZWxlY3RlZCB8fFxuXHRcdFx0XHRcdGJlZm9yZVRhcmdldFN0YXRlLm9wZW4gIT09IGFmdGVyVGFyZ2V0U3RhdGUub3Blbjtcblx0XHRcdFx0Y29uc3QgdmVyaWZpY2F0aW9uID0gZGVwcy52ZXJpZmljYXRpb25Gcm9tQ2hlY2tzKFxuXHRcdFx0XHRcdFtcblx0XHRcdFx0XHRcdHsgbmFtZTogXCJ1cmxfY2hhbmdlZFwiLCBwYXNzZWQ6IGFmdGVyVXJsICE9PSBiZWZvcmVVcmwsIHZhbHVlOiBhZnRlclVybCwgZXhwZWN0ZWQ6IGAhPSAke2JlZm9yZVVybH1gIH0sXG5cdFx0XHRcdFx0XHR7IG5hbWU6IFwiaGFzaF9jaGFuZ2VkXCIsIHBhc3NlZDogYWZ0ZXJIYXNoICE9PSBiZWZvcmVIYXNoLCB2YWx1ZTogYWZ0ZXJIYXNoLCBleHBlY3RlZDogYCE9ICR7YmVmb3JlSGFzaH1gIH0sXG5cdFx0XHRcdFx0XHR7IG5hbWU6IFwidGFyZ2V0X3N0YXRlX2NoYW5nZWRcIiwgcGFzc2VkOiB0YXJnZXRTdGF0ZUNoYW5nZWQsIHZhbHVlOiBhZnRlclRhcmdldFN0YXRlLCBleHBlY3RlZDogYmVmb3JlVGFyZ2V0U3RhdGUgfSxcblx0XHRcdFx0XHRcdHsgbmFtZTogXCJkaWFsb2dfb3BlblwiLCBwYXNzZWQ6IGFmdGVyU3RhdGUuZGlhbG9nLmNvdW50ID4gYmVmb3JlU3RhdGUuZGlhbG9nLmNvdW50LCB2YWx1ZTogYWZ0ZXJTdGF0ZS5kaWFsb2cuY291bnQsIGV4cGVjdGVkOiBgPiAke2JlZm9yZVN0YXRlLmRpYWxvZy5jb3VudH1gIH0sXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRcIlJlZiBtYXkgbm93IHBvaW50IHRvIGFuIGluZXJ0IGVsZW1lbnQuIFJlZnJlc2ggcmVmcyB3aXRoIGJyb3dzZXJfc25hcHNob3RfcmVmcyBhbmQgcmV0cnkuXCJcblx0XHRcdFx0KTtcblxuXHRcdFx0XHRjb25zdCBzdW1tYXJ5ID0gZGVwcy5mb3JtYXRDb21wYWN0U3RhdGVTdW1tYXJ5KGFmdGVyU3RhdGUpO1xuXHRcdFx0XHRjb25zdCBqc0Vycm9ycyA9IGRlcHMuZ2V0UmVjZW50RXJyb3JzKHAudXJsKCkpO1xuXHRcdFx0XHRjb25zdCB2ZXJzaW9uZWRSZWYgPSBkZXBzLmZvcm1hdFZlcnNpb25lZFJlZihyZWZNZXRhZGF0YT8udmVyc2lvbiA/PyByZWZWZXJzaW9uLCBub2RlLnJlZik7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3tcblx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0dGV4dDogYENsaWNrZWQgJHt2ZXJzaW9uZWRSZWZ9ICgke25vZGUucm9sZSB8fCBub2RlLnRhZ30ke25vZGUubmFtZSA/IGAgXCIke25vZGUubmFtZX1cImAgOiBcIlwifSlcXG4ke2RlcHMudmVyaWZpY2F0aW9uTGluZSh2ZXJpZmljYXRpb24pfSR7anNFcnJvcnN9XFxuXFxuUGFnZSBzdW1tYXJ5OlxcbiR7c3VtbWFyeX1gLFxuXHRcdFx0XHRcdH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgcmVmOiB2ZXJzaW9uZWRSZWYsIHNlbGVjdG9yOiByZXNvbHZlZC5zZWxlY3RvciwgdXJsOiBwLnVybCgpLCAuLi5zZXR0bGUsIC4uLnZlcmlmaWNhdGlvbiB9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0Y29uc3QgZXJyb3JTaG90ID0gYXdhaXQgZGVwcy5jYXB0dXJlRXJyb3JTY3JlZW5zaG90KGRlcHMuZ2V0QWN0aXZlUGFnZU9yTnVsbCgpKTtcblx0XHRcdFx0Y29uc3QgcmVhc29uID0gZGVwcy5maXJzdEVycm9yTGluZShlcnIpO1xuXHRcdFx0XHRjb25zdCBjb250ZW50OiBhbnlbXSA9IFtcblx0XHRcdFx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBkZXBzLnN0YWxlUmVmR3VpZGFuY2UocmVxdWVzdGVkUmVmLCBgYWN0aW9uIGZhaWxlZDogJHtyZWFzb259YCkgfSxcblx0XHRcdFx0XHR7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgQ2xpY2sgcmVmIGZhaWxlZDogJHtlcnIubWVzc2FnZX1gIH0sXG5cdFx0XHRcdF07XG5cdFx0XHRcdGlmIChlcnJvclNob3QpIHtcblx0XHRcdFx0XHRjb250ZW50LnB1c2goeyB0eXBlOiBcImltYWdlXCIsIGRhdGE6IGVycm9yU2hvdC5kYXRhLCBtaW1lVHlwZTogZXJyb3JTaG90Lm1pbWVUeXBlIH0pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudCxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSwgcmVmOiByZXF1ZXN0ZWRSZWYsIGhpbnQ6IFwiUnVuIGJyb3dzZXJfc25hcHNob3RfcmVmcyB0byByZWZyZXNoIHJlZnMuXCIgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gYnJvd3Nlcl9ob3Zlcl9yZWZcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwiYnJvd3Nlcl9ob3Zlcl9yZWZcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIEhvdmVyIFJlZlwiLFxuXHRcdGRlc2NyaXB0aW9uOiBcIkhvdmVyIGEgcHJldmlvdXNseSBzbmFwc2hvdHRlZCBlbGVtZW50IGJ5IGRldGVybWluaXN0aWMgdmVyc2lvbmVkIHJlZiAoZS5nLiBAdjM6ZTQpLlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdHJlZjogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJSZWZlcmVuY2UgaWQgaW4gdmVyc2lvbmVkIGZvcm1hdCwgZS5nLiAnQHYzOmU0Jy5cIiB9KSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgX3NpZ25hbCwgX29uVXBkYXRlLCBfY3R4KSB7XG5cdFx0XHRjb25zdCBwYXJzZWRSZWYgPSBkZXBzLnBhcnNlUmVmKHBhcmFtcy5yZWYpO1xuXHRcdFx0Y29uc3QgcmVxdWVzdGVkUmVmID0gcGFyc2VkUmVmLmRpc3BsYXk7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCB7IHBhZ2U6IHAgfSA9IGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCB0YXJnZXQgPSBkZXBzLmdldEFjdGl2ZVRhcmdldCgpO1xuXHRcdFx0XHRjb25zdCByZWZNZXRhZGF0YSA9IGdldFJlZk1ldGFkYXRhKCk7XG5cdFx0XHRcdGNvbnN0IHJlZlZlcnNpb24gPSBnZXRSZWZWZXJzaW9uKCk7XG5cdFx0XHRcdGlmIChwYXJzZWRSZWYudmVyc2lvbiA9PT0gbnVsbCkge1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFVudmVyc2lvbmVkIHJlZiAke3JlcXVlc3RlZFJlZn0gaXMgYW1iaWd1b3VzLiBVc2UgYSB2ZXJzaW9uZWQgcmVmIChlLmcuIEB2JHtyZWZNZXRhZGF0YT8udmVyc2lvbiA/PyByZWZWZXJzaW9ufTplMSkgZnJvbSBicm93c2VyX3NuYXBzaG90X3JlZnMuYCB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IFwicmVmX3VudmVyc2lvbmVkXCIsIHJlZjogcmVxdWVzdGVkUmVmLCBtZXRhZGF0YTogcmVmTWV0YWRhdGEgfSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAocmVmTWV0YWRhdGEgJiYgcGFyc2VkUmVmLnZlcnNpb24gIT09IHJlZk1ldGFkYXRhLnZlcnNpb24pIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGRlcHMuc3RhbGVSZWZHdWlkYW5jZShyZXF1ZXN0ZWRSZWYsIGBzbmFwc2hvdCB2ZXJzaW9uIG1pc21hdGNoIChoYXZlIHYke3JlZk1ldGFkYXRhLnZlcnNpb259KWApIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogXCJyZWZfc3RhbGVcIiwgcmVmOiByZXF1ZXN0ZWRSZWYsIGV4cGVjdGVkVmVyc2lvbjogcmVmTWV0YWRhdGEudmVyc2lvbiwgcmVjZWl2ZWRWZXJzaW9uOiBwYXJzZWRSZWYudmVyc2lvbiB9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IGN1cnJlbnRSZWZNYXAgPSBnZXRDdXJyZW50UmVmTWFwKCk7XG5cdFx0XHRcdGNvbnN0IHJlZiA9IHBhcnNlZFJlZi5rZXk7XG5cdFx0XHRcdGNvbnN0IG5vZGUgPSBjdXJyZW50UmVmTWFwW3JlZl07XG5cdFx0XHRcdGlmICghbm9kZSkge1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogZGVwcy5zdGFsZVJlZkd1aWRhbmNlKHJlcXVlc3RlZFJlZiwgXCJyZWYgbm90IGZvdW5kXCIpIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogXCJyZWZfbm90X2ZvdW5kXCIsIHJlZjogcmVxdWVzdGVkUmVmLCBtZXRhZGF0YTogcmVmTWV0YWRhdGEgfSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAocmVmTWV0YWRhdGE/LnVybCAmJiByZWZNZXRhZGF0YS51cmwgIT09IHAudXJsKCkpIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGRlcHMuc3RhbGVSZWZHdWlkYW5jZShyZXF1ZXN0ZWRSZWYsIFwiVVJMIGNoYW5nZWQgc2luY2Ugc25hcHNob3RcIikgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBcInJlZl9zdGFsZVwiLCByZWY6IHJlcXVlc3RlZFJlZiwgc25hcHNob3RVcmw6IHJlZk1ldGFkYXRhLnVybCwgY3VycmVudFVybDogcC51cmwoKSB9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgcmVzb2x2ZWQgPSBhd2FpdCBkZXBzLnJlc29sdmVSZWZUYXJnZXQodGFyZ2V0LCBub2RlKTtcblx0XHRcdFx0aWYgKCFyZXNvbHZlZC5vaykge1xuXHRcdFx0XHRcdGNvbnN0IHJlYXNvbiA9IChyZXNvbHZlZCBhcyB7IG9rOiBmYWxzZTsgcmVhc29uOiBzdHJpbmcgfSkucmVhc29uO1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogZGVwcy5zdGFsZVJlZkd1aWRhbmNlKHJlcXVlc3RlZFJlZiwgcmVhc29uKSB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IFwicmVmX3N0YWxlXCIsIHJlZjogcmVxdWVzdGVkUmVmLCByZWFzb24gfSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGF3YWl0IHRhcmdldC5sb2NhdG9yKHJlc29sdmVkLnNlbGVjdG9yKS5maXJzdCgpLmhvdmVyKHsgdGltZW91dDogODAwMCB9KTtcblx0XHRcdFx0Y29uc3Qgc2V0dGxlID0gYXdhaXQgZGVwcy5zZXR0bGVBZnRlckFjdGlvbkFkYXB0aXZlKHApO1xuXG5cdFx0XHRcdGNvbnN0IGFmdGVyU3RhdGUgPSBhd2FpdCBkZXBzLmNhcHR1cmVDb21wYWN0UGFnZVN0YXRlKHAsIHsgaW5jbHVkZUJvZHlUZXh0OiBmYWxzZSwgdGFyZ2V0IH0pO1xuXHRcdFx0XHRjb25zdCBzdW1tYXJ5ID0gZGVwcy5mb3JtYXRDb21wYWN0U3RhdGVTdW1tYXJ5KGFmdGVyU3RhdGUpO1xuXHRcdFx0XHRjb25zdCBqc0Vycm9ycyA9IGRlcHMuZ2V0UmVjZW50RXJyb3JzKHAudXJsKCkpO1xuXHRcdFx0XHRjb25zdCB2ZXJzaW9uZWRSZWYgPSBkZXBzLmZvcm1hdFZlcnNpb25lZFJlZihyZWZNZXRhZGF0YT8udmVyc2lvbiA/PyByZWZWZXJzaW9uLCBub2RlLnJlZik7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3tcblx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0dGV4dDogYEhvdmVyZWQgJHt2ZXJzaW9uZWRSZWZ9ICgke25vZGUucm9sZSB8fCBub2RlLnRhZ30ke25vZGUubmFtZSA/IGAgXCIke25vZGUubmFtZX1cImAgOiBcIlwifSkke2pzRXJyb3JzfVxcblxcblBhZ2Ugc3VtbWFyeTpcXG4ke3N1bW1hcnl9YCxcblx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IHJlZjogdmVyc2lvbmVkUmVmLCBzZWxlY3RvcjogcmVzb2x2ZWQuc2VsZWN0b3IsIHVybDogcC51cmwoKSwgLi4uc2V0dGxlIH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRjb25zdCBlcnJvclNob3QgPSBhd2FpdCBkZXBzLmNhcHR1cmVFcnJvclNjcmVlbnNob3QoZGVwcy5nZXRBY3RpdmVQYWdlT3JOdWxsKCkpO1xuXHRcdFx0XHRjb25zdCByZWFzb24gPSBkZXBzLmZpcnN0RXJyb3JMaW5lKGVycik7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQ6IGFueVtdID0gW1xuXHRcdFx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGRlcHMuc3RhbGVSZWZHdWlkYW5jZShyZXF1ZXN0ZWRSZWYsIGBhY3Rpb24gZmFpbGVkOiAke3JlYXNvbn1gKSB9LFxuXHRcdFx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBIb3ZlciByZWYgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfSxcblx0XHRcdFx0XTtcblx0XHRcdFx0aWYgKGVycm9yU2hvdCkge1xuXHRcdFx0XHRcdGNvbnRlbnQucHVzaCh7IHR5cGU6IFwiaW1hZ2VcIiwgZGF0YTogZXJyb3JTaG90LmRhdGEsIG1pbWVUeXBlOiBlcnJvclNob3QubWltZVR5cGUgfSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50LFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IGVyci5tZXNzYWdlLCByZWY6IHJlcXVlc3RlZFJlZiwgaGludDogXCJSdW4gYnJvd3Nlcl9zbmFwc2hvdF9yZWZzIHRvIHJlZnJlc2ggcmVmcy5cIiB9LFxuXHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG5cblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBicm93c2VyX2ZpbGxfcmVmXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfZmlsbF9yZWZcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIEZpbGwgUmVmXCIsXG5cdFx0ZGVzY3JpcHRpb246IFwiRmlsbC90eXBlIHRleHQgaW50byBhbiBpbnB1dC1saWtlIGVsZW1lbnQgYnkgZGV0ZXJtaW5pc3RpYyB2ZXJzaW9uZWQgcmVmIChlLmcuIEB2MzplMSkuXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0cmVmOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlJlZmVyZW5jZSBpZCBpbiB2ZXJzaW9uZWQgZm9ybWF0LCBlLmcuICdAdjM6ZTEnLlwiIH0pLFxuXHRcdFx0dGV4dDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJUZXh0IHRvIGVudGVyLlwiIH0pLFxuXHRcdFx0Y2xlYXJGaXJzdDogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5Cb29sZWFuKHsgZGVzY3JpcHRpb246IFwiQ2xlYXIgZXhpc3RpbmcgdmFsdWUgZmlyc3QgKGRlZmF1bHQ6IGZhbHNlKS5cIiB9KVxuXHRcdFx0KSxcblx0XHRcdHN1Ym1pdDogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5Cb29sZWFuKHsgZGVzY3JpcHRpb246IFwiUHJlc3MgRW50ZXIgYWZ0ZXIgdHlwaW5nIChkZWZhdWx0OiBmYWxzZSkuXCIgfSlcblx0XHRcdCksXG5cdFx0XHRzbG93bHk6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuQm9vbGVhbih7IGRlc2NyaXB0aW9uOiBcIlR5cGUgY2hhcmFjdGVyLWJ5LWNoYXJhY3RlciAoZGVmYXVsdDogZmFsc2UpLlwiIH0pXG5cdFx0XHQpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBfc2lnbmFsLCBfb25VcGRhdGUsIF9jdHgpIHtcblx0XHRcdGNvbnN0IHBhcnNlZFJlZiA9IGRlcHMucGFyc2VSZWYocGFyYW1zLnJlZik7XG5cdFx0XHRjb25zdCByZXF1ZXN0ZWRSZWYgPSBwYXJzZWRSZWYuZGlzcGxheTtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHsgcGFnZTogcCB9ID0gYXdhaXQgZGVwcy5lbnN1cmVCcm93c2VyKCk7XG5cdFx0XHRcdGNvbnN0IHRhcmdldCA9IGRlcHMuZ2V0QWN0aXZlVGFyZ2V0KCk7XG5cdFx0XHRcdGNvbnN0IHJlZk1ldGFkYXRhID0gZ2V0UmVmTWV0YWRhdGEoKTtcblx0XHRcdFx0Y29uc3QgcmVmVmVyc2lvbiA9IGdldFJlZlZlcnNpb24oKTtcblx0XHRcdFx0aWYgKHBhcnNlZFJlZi52ZXJzaW9uID09PSBudWxsKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgVW52ZXJzaW9uZWQgcmVmICR7cmVxdWVzdGVkUmVmfSBpcyBhbWJpZ3VvdXMuIFVzZSBhIHZlcnNpb25lZCByZWYgKGUuZy4gQHYke3JlZk1ldGFkYXRhPy52ZXJzaW9uID8/IHJlZlZlcnNpb259OmUxKSBmcm9tIGJyb3dzZXJfc25hcHNob3RfcmVmcy5gIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogXCJyZWZfdW52ZXJzaW9uZWRcIiwgcmVmOiByZXF1ZXN0ZWRSZWYsIG1ldGFkYXRhOiByZWZNZXRhZGF0YSB9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmIChyZWZNZXRhZGF0YSAmJiBwYXJzZWRSZWYudmVyc2lvbiAhPT0gcmVmTWV0YWRhdGEudmVyc2lvbikge1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogZGVwcy5zdGFsZVJlZkd1aWRhbmNlKHJlcXVlc3RlZFJlZiwgYHNuYXBzaG90IHZlcnNpb24gbWlzbWF0Y2ggKGhhdmUgdiR7cmVmTWV0YWRhdGEudmVyc2lvbn0pYCkgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBcInJlZl9zdGFsZVwiLCByZWY6IHJlcXVlc3RlZFJlZiwgZXhwZWN0ZWRWZXJzaW9uOiByZWZNZXRhZGF0YS52ZXJzaW9uLCByZWNlaXZlZFZlcnNpb246IHBhcnNlZFJlZi52ZXJzaW9uIH0sXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgY3VycmVudFJlZk1hcCA9IGdldEN1cnJlbnRSZWZNYXAoKTtcblx0XHRcdFx0Y29uc3QgcmVmID0gcGFyc2VkUmVmLmtleTtcblx0XHRcdFx0Y29uc3Qgbm9kZSA9IGN1cnJlbnRSZWZNYXBbcmVmXTtcblx0XHRcdFx0aWYgKCFub2RlKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBkZXBzLnN0YWxlUmVmR3VpZGFuY2UocmVxdWVzdGVkUmVmLCBcInJlZiBub3QgZm91bmRcIikgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBcInJlZl9ub3RfZm91bmRcIiwgcmVmOiByZXF1ZXN0ZWRSZWYsIG1ldGFkYXRhOiByZWZNZXRhZGF0YSB9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmIChyZWZNZXRhZGF0YT8udXJsICYmIHJlZk1ldGFkYXRhLnVybCAhPT0gcC51cmwoKSkge1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogZGVwcy5zdGFsZVJlZkd1aWRhbmNlKHJlcXVlc3RlZFJlZiwgXCJVUkwgY2hhbmdlZCBzaW5jZSBzbmFwc2hvdFwiKSB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IFwicmVmX3N0YWxlXCIsIHJlZjogcmVxdWVzdGVkUmVmLCBzbmFwc2hvdFVybDogcmVmTWV0YWRhdGEudXJsLCBjdXJyZW50VXJsOiBwLnVybCgpIH0sXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCByZXNvbHZlZCA9IGF3YWl0IGRlcHMucmVzb2x2ZVJlZlRhcmdldCh0YXJnZXQsIG5vZGUpO1xuXHRcdFx0XHRpZiAoIXJlc29sdmVkLm9rKSB7XG5cdFx0XHRcdFx0Y29uc3QgcmVhc29uID0gKHJlc29sdmVkIGFzIHsgb2s6IGZhbHNlOyByZWFzb246IHN0cmluZyB9KS5yZWFzb247XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBkZXBzLnN0YWxlUmVmR3VpZGFuY2UocmVxdWVzdGVkUmVmLCByZWFzb24pIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogXCJyZWZfc3RhbGVcIiwgcmVmOiByZXF1ZXN0ZWRSZWYsIHJlYXNvbiB9LFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgbG9jYXRvciA9IHRhcmdldC5sb2NhdG9yKHJlc29sdmVkLnNlbGVjdG9yKS5maXJzdCgpO1xuXHRcdFx0XHRjb25zdCBiZWZvcmVVcmwgPSBwLnVybCgpO1xuXHRcdFx0XHRpZiAocGFyYW1zLnNsb3dseSkge1xuXHRcdFx0XHRcdGF3YWl0IGxvY2F0b3IuY2xpY2soeyB0aW1lb3V0OiA4MDAwIH0pO1xuXHRcdFx0XHRcdGlmIChwYXJhbXMuY2xlYXJGaXJzdCkge1xuXHRcdFx0XHRcdFx0YXdhaXQgcC5rZXlib2FyZC5wcmVzcyhcIkNvbnRyb2wrQVwiKTtcblx0XHRcdFx0XHRcdGF3YWl0IHAua2V5Ym9hcmQucHJlc3MoXCJEZWxldGVcIik7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGF3YWl0IHAua2V5Ym9hcmQudHlwZShwYXJhbXMudGV4dCk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0aWYgKHBhcmFtcy5jbGVhckZpcnN0KSB7XG5cdFx0XHRcdFx0XHRhd2FpdCBsb2NhdG9yLmZpbGwoXCJcIik7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGF3YWl0IGxvY2F0b3IuZmlsbChwYXJhbXMudGV4dCwgeyB0aW1lb3V0OiA4MDAwIH0pO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmIChwYXJhbXMuc3VibWl0KSB7XG5cdFx0XHRcdFx0YXdhaXQgcC5rZXlib2FyZC5wcmVzcyhcIkVudGVyXCIpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IHNldHRsZSA9IGF3YWl0IGRlcHMuc2V0dGxlQWZ0ZXJBY3Rpb25BZGFwdGl2ZShwKTtcblxuXHRcdFx0XHRjb25zdCBmaWxsZWRWYWx1ZSA9IGF3YWl0IGRlcHMucmVhZElucHV0TGlrZVZhbHVlKHRhcmdldCwgcmVzb2x2ZWQuc2VsZWN0b3IpO1xuXHRcdFx0XHRjb25zdCBhZnRlclVybCA9IHAudXJsKCk7XG5cdFx0XHRcdGNvbnN0IHZlcmlmaWNhdGlvbiA9IGRlcHMudmVyaWZpY2F0aW9uRnJvbUNoZWNrcyhcblx0XHRcdFx0XHRbXG5cdFx0XHRcdFx0XHR7IG5hbWU6IFwidmFsdWVfZXF1YWxzX2V4cGVjdGVkXCIsIHBhc3NlZDogZmlsbGVkVmFsdWUgPT09IHBhcmFtcy50ZXh0LCB2YWx1ZTogZmlsbGVkVmFsdWUsIGV4cGVjdGVkOiBwYXJhbXMudGV4dCB9LFxuXHRcdFx0XHRcdFx0eyBuYW1lOiBcInZhbHVlX2NvbnRhaW5zX2V4cGVjdGVkXCIsIHBhc3NlZDogdHlwZW9mIGZpbGxlZFZhbHVlID09PSBcInN0cmluZ1wiICYmIGZpbGxlZFZhbHVlLmluY2x1ZGVzKHBhcmFtcy50ZXh0KSwgdmFsdWU6IGZpbGxlZFZhbHVlLCBleHBlY3RlZDogcGFyYW1zLnRleHQgfSxcblx0XHRcdFx0XHRcdHsgbmFtZTogXCJ1cmxfY2hhbmdlZF9hZnRlcl9zdWJtaXRcIiwgcGFzc2VkOiAhIXBhcmFtcy5zdWJtaXQgJiYgYWZ0ZXJVcmwgIT09IGJlZm9yZVVybCwgdmFsdWU6IGFmdGVyVXJsLCBleHBlY3RlZDogYCE9ICR7YmVmb3JlVXJsfWAgfSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdFwiVHJ5IHJlZnJlc2hpbmcgcmVmcyBhbmQgY29uZmlybSB0aGlzIHJlZiBzdGlsbCB0YXJnZXRzIGFuIGlucHV0LWxpa2UgZWxlbWVudC5cIlxuXHRcdFx0XHQpO1xuXG5cdFx0XHRcdGNvbnN0IGFmdGVyU3RhdGUgPSBhd2FpdCBkZXBzLmNhcHR1cmVDb21wYWN0UGFnZVN0YXRlKHAsIHsgaW5jbHVkZUJvZHlUZXh0OiB0cnVlLCB0YXJnZXQgfSk7XG5cdFx0XHRcdGNvbnN0IHN1bW1hcnkgPSBkZXBzLmZvcm1hdENvbXBhY3RTdGF0ZVN1bW1hcnkoYWZ0ZXJTdGF0ZSk7XG5cdFx0XHRcdGNvbnN0IGpzRXJyb3JzID0gZGVwcy5nZXRSZWNlbnRFcnJvcnMocC51cmwoKSk7XG5cdFx0XHRcdGNvbnN0IHZlcnNpb25lZFJlZiA9IGRlcHMuZm9ybWF0VmVyc2lvbmVkUmVmKHJlZk1ldGFkYXRhPy52ZXJzaW9uID8/IHJlZlZlcnNpb24sIG5vZGUucmVmKTtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHR0ZXh0OiBgRmlsbGVkICR7dmVyc2lvbmVkUmVmfSAoJHtub2RlLnJvbGUgfHwgbm9kZS50YWd9JHtub2RlLm5hbWUgPyBgIFwiJHtub2RlLm5hbWV9XCJgIDogXCJcIn0pIHdpdGggXCIke3BhcmFtcy50ZXh0fVwiXFxuJHtkZXBzLnZlcmlmaWNhdGlvbkxpbmUodmVyaWZpY2F0aW9uKX0ke2pzRXJyb3JzfVxcblxcblBhZ2Ugc3VtbWFyeTpcXG4ke3N1bW1hcnl9YCxcblx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IHJlZjogdmVyc2lvbmVkUmVmLCBzZWxlY3RvcjogcmVzb2x2ZWQuc2VsZWN0b3IsIHVybDogcC51cmwoKSwgZmlsbGVkVmFsdWUsIC4uLnNldHRsZSwgLi4udmVyaWZpY2F0aW9uIH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRjb25zdCBlcnJvclNob3QgPSBhd2FpdCBkZXBzLmNhcHR1cmVFcnJvclNjcmVlbnNob3QoZGVwcy5nZXRBY3RpdmVQYWdlT3JOdWxsKCkpO1xuXHRcdFx0XHRjb25zdCByZWFzb24gPSBkZXBzLmZpcnN0RXJyb3JMaW5lKGVycik7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQ6IGFueVtdID0gW1xuXHRcdFx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGRlcHMuc3RhbGVSZWZHdWlkYW5jZShyZXF1ZXN0ZWRSZWYsIGBhY3Rpb24gZmFpbGVkOiAke3JlYXNvbn1gKSB9LFxuXHRcdFx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBGaWxsIHJlZiBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9LFxuXHRcdFx0XHRdO1xuXHRcdFx0XHRpZiAoZXJyb3JTaG90KSB7XG5cdFx0XHRcdFx0Y29udGVudC5wdXNoKHsgdHlwZTogXCJpbWFnZVwiLCBkYXRhOiBlcnJvclNob3QuZGF0YSwgbWltZVR5cGU6IGVycm9yU2hvdC5taW1lVHlwZSB9KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQsXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UsIHJlZjogcmVxdWVzdGVkUmVmLCBoaW50OiBcIlJ1biBicm93c2VyX3NuYXBzaG90X3JlZnMgdG8gcmVmcmVzaCByZWZzLlwiIH0sXG5cdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblx0XHR9LFxuXHR9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUNBLFNBQVMsWUFBWTtBQUNyQjtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUVQO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFFQSxTQUFTLGlCQUFpQixJQUFrQixNQUFzQjtBQUl4RSxLQUFHLGFBQWE7QUFBQSxJQUNmLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0M7QUFBQSxJQUNELFlBQVksS0FBSyxPQUFPO0FBQUEsTUFDdkIsVUFBVSxLQUFLO0FBQUEsUUFDZCxLQUFLLE9BQU87QUFBQSxVQUNYLGFBQWE7QUFBQSxRQUNkLENBQUM7QUFBQSxNQUNGO0FBQUEsTUFDQSxpQkFBaUIsS0FBSztBQUFBLFFBQ3JCLEtBQUssUUFBUTtBQUFBLFVBQ1osYUFBYTtBQUFBLFFBQ2QsQ0FBQztBQUFBLE1BQ0Y7QUFBQSxNQUNBLE9BQU8sS0FBSztBQUFBLFFBQ1gsS0FBSyxPQUFPO0FBQUEsVUFDWCxhQUFhO0FBQUEsUUFDZCxDQUFDO0FBQUEsTUFDRjtBQUFBLE1BQ0EsTUFBTSxLQUFLO0FBQUEsUUFDVixLQUFLLE9BQU87QUFBQSxVQUNYLGFBQWE7QUFBQSxRQUNkLENBQUM7QUFBQSxNQUNGO0FBQUEsSUFDRCxDQUFDO0FBQUEsSUFFRCxNQUFNLFFBQVEsYUFBYSxRQUFRLFNBQVMsV0FBVyxNQUFNO0FBQzVELFVBQUk7QUFDSCxjQUFNLEVBQUUsTUFBTSxFQUFFLElBQUksTUFBTSxLQUFLLGNBQWM7QUFDN0MsY0FBTSxTQUFTLEtBQUssZ0JBQWdCO0FBRXBDLGNBQU0sT0FBTyxPQUFPO0FBQ3BCLFlBQUksU0FBUyxRQUFXO0FBQ3ZCLGdCQUFNLGFBQWEsc0JBQXNCLElBQUk7QUFDN0MsY0FBSSxDQUFDLFlBQVk7QUFDaEIsa0JBQU0sYUFBYSxPQUFPLEtBQUssY0FBYyxFQUFFLEtBQUssSUFBSTtBQUN4RCxtQkFBTztBQUFBLGNBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sMkJBQTJCLElBQUksbUJBQW1CLFVBQVUsR0FBRyxDQUFDO0FBQUEsY0FDaEcsU0FBUyxFQUFFLE9BQU8saUJBQWlCLElBQUksSUFBSSxZQUFZLE9BQU8sS0FBSyxjQUFjLEVBQUU7QUFBQSxjQUNuRixTQUFTO0FBQUEsWUFDVjtBQUFBLFVBQ0Q7QUFBQSxRQUNEO0FBRUEsY0FBTSxrQkFBa0IsT0FBTyxvQkFBb0I7QUFDbkQsY0FBTSxRQUFRLEtBQUssSUFBSSxHQUFHLEtBQUssSUFBSSxLQUFLLEtBQUssTUFBTSxPQUFPLFNBQVMsRUFBRSxDQUFDLENBQUM7QUFDdkUsY0FBTSxXQUFXLE1BQU0sS0FBSyxpQkFBaUIsUUFBUTtBQUFBLFVBQ3BELFVBQVUsT0FBTztBQUFBLFVBQ2pCO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxRQUNELENBQUM7QUFFRCxjQUFNLGFBQWEsY0FBYyxJQUFJO0FBQ3JDLHNCQUFjLFVBQVU7QUFDeEIsY0FBTSxVQUFtQyxDQUFDO0FBQzFDLGlCQUFTLElBQUksR0FBRyxJQUFJLFNBQVMsUUFBUSxLQUFLLEdBQUc7QUFDNUMsZ0JBQU0sTUFBTSxJQUFJLElBQUksQ0FBQztBQUNyQixrQkFBUSxHQUFHLElBQUksRUFBRSxLQUFLLEdBQUcsU0FBUyxDQUFDLEVBQUU7QUFBQSxRQUN0QztBQUNBLHlCQUFpQixPQUFPO0FBQ3hCLGNBQU0sY0FBYyxlQUFlO0FBQ25DLGNBQU0sV0FBVyxjQUFlLFlBQVksS0FBSyxLQUFLLFlBQVksSUFBSSxJQUFLO0FBQzNFLHVCQUFlO0FBQUEsVUFDZCxLQUFLLEVBQUUsSUFBSTtBQUFBLFVBQ1gsV0FBVyxLQUFLLElBQUk7QUFBQSxVQUNwQixlQUFlLE9BQU87QUFBQSxVQUN0QjtBQUFBLFVBQ0E7QUFBQSxVQUNBLFNBQVM7QUFBQSxVQUNULGNBQWM7QUFBQSxVQUNkO0FBQUEsUUFDRCxDQUFDO0FBRUQsWUFBSSxTQUFTLFdBQVcsR0FBRztBQUMxQixpQkFBTztBQUFBLFlBQ04sU0FBUyxDQUFDO0FBQUEsY0FDVCxNQUFNO0FBQUEsY0FDTixNQUFNO0FBQUEsWUFDUCxDQUFDO0FBQUEsWUFDRCxTQUFTO0FBQUEsY0FDUixPQUFPO0FBQUEsY0FDUCxTQUFTO0FBQUEsY0FDVCxVQUFVLGVBQWU7QUFBQSxjQUN6QixNQUFNLENBQUM7QUFBQSxZQUNSO0FBQUEsVUFDRDtBQUFBLFFBQ0Q7QUFFQSxjQUFNLGdCQUF5QyxDQUFDO0FBQ2hELGNBQU0sUUFBUSxPQUFPLE9BQU8sT0FBTyxFQUFFLElBQUksQ0FBQyxTQUFTO0FBQ2xELGdCQUFNLGVBQWUsS0FBSyxtQkFBbUIsWUFBWSxLQUFLLEdBQUc7QUFDakUsd0JBQWMsWUFBWSxJQUFJO0FBQzlCLGdCQUFNLFFBQWtCLENBQUMsY0FBYyxLQUFLLFFBQVEsS0FBSyxHQUFHO0FBQzVELGNBQUksS0FBSyxLQUFNLE9BQU0sS0FBSyxJQUFJLEtBQUssSUFBSSxHQUFHO0FBQzFDLGNBQUksS0FBSyxLQUFNLE9BQU0sS0FBSyxTQUFTLEtBQUssS0FBSyxNQUFNLEdBQUcsRUFBRSxDQUFDLEdBQUc7QUFDNUQsY0FBSSxDQUFDLEtBQUssVUFBVyxPQUFNLEtBQUssVUFBVTtBQUMxQyxjQUFJLENBQUMsS0FBSyxVQUFXLE9BQU0sS0FBSyxZQUFZO0FBQzVDLGlCQUFPLE1BQU0sS0FBSyxHQUFHO0FBQUEsUUFDdEIsQ0FBQztBQUVELGNBQU0sWUFBWSxPQUFPLFNBQVMsSUFBSTtBQUFBLElBQU87QUFDN0MsZUFBTztBQUFBLFVBQ04sU0FBUyxDQUFDO0FBQUEsWUFDVCxNQUFNO0FBQUEsWUFDTixNQUNDLGlCQUFpQixVQUFVLEtBQUssU0FBUyxNQUFNO0FBQUEsT0FDdkMsRUFBRSxJQUFJLENBQUM7QUFBQSxTQUNMLE9BQU8sWUFBWSxNQUFNO0FBQUEsSUFDbkMsWUFDQSwrQ0FBK0MsVUFBVTtBQUFBO0FBQUEsSUFDekQsTUFBTSxLQUFLLElBQUk7QUFBQSxVQUNqQixDQUFDO0FBQUEsVUFDRCxTQUFTO0FBQUEsWUFDUixPQUFPLFNBQVM7QUFBQSxZQUNoQixTQUFTO0FBQUEsWUFDVCxVQUFVLGVBQWU7QUFBQSxZQUN6QixNQUFNO0FBQUEsWUFDTjtBQUFBLFVBQ0Q7QUFBQSxRQUNEO0FBQUEsTUFDRCxTQUFTLEtBQVU7QUFDbEIsZUFBTztBQUFBLFVBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0seUJBQXlCLElBQUksT0FBTyxHQUFHLENBQUM7QUFBQSxVQUN4RSxTQUFTLEVBQUUsT0FBTyxJQUFJLFFBQVE7QUFBQSxVQUM5QixTQUFTO0FBQUEsUUFDVjtBQUFBLE1BQ0Q7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBS0QsS0FBRyxhQUFhO0FBQUEsSUFDZixNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUFhO0FBQUEsSUFDYixZQUFZLEtBQUssT0FBTztBQUFBLE1BQ3ZCLEtBQUssS0FBSyxPQUFPLEVBQUUsYUFBYSxzREFBc0QsQ0FBQztBQUFBLElBQ3hGLENBQUM7QUFBQSxJQUVELE1BQU0sUUFBUSxhQUFhLFFBQVEsU0FBUyxXQUFXLE1BQU07QUFDNUQsWUFBTSxZQUFZLEtBQUssU0FBUyxPQUFPLEdBQUc7QUFDMUMsWUFBTSxjQUFjLGVBQWU7QUFDbkMsWUFBTSxhQUFhLGNBQWM7QUFDakMsVUFBSSxVQUFVLFlBQVksUUFBUSxlQUFlLFVBQVUsWUFBWSxZQUFZLFNBQVM7QUFDM0YsZUFBTztBQUFBLFVBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sS0FBSyxpQkFBaUIsVUFBVSxTQUFTLG9DQUFvQyxZQUFZLE9BQU8sR0FBRyxFQUFFLENBQUM7QUFBQSxVQUN0SSxTQUFTLEVBQUUsT0FBTyxhQUFhLEtBQUssVUFBVSxTQUFTLGlCQUFpQixZQUFZLFNBQVMsaUJBQWlCLFVBQVUsUUFBUTtBQUFBLFVBQ2hJLFNBQVM7QUFBQSxRQUNWO0FBQUEsTUFDRDtBQUVBLFlBQU0sZ0JBQWdCLGlCQUFpQjtBQUN2QyxZQUFNLE9BQU8sY0FBYyxVQUFVLEdBQUc7QUFDeEMsVUFBSSxDQUFDLE1BQU07QUFDVixlQUFPO0FBQUEsVUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxLQUFLLGlCQUFpQixVQUFVLFNBQVMsZUFBZSxFQUFFLENBQUM7QUFBQSxVQUMzRixTQUFTLEVBQUUsT0FBTyxpQkFBaUIsS0FBSyxVQUFVLFNBQVMsVUFBVSxZQUFZO0FBQUEsVUFDakYsU0FBUztBQUFBLFFBQ1Y7QUFBQSxNQUNEO0FBRUEsWUFBTSxlQUFlLEtBQUssbUJBQW1CLGFBQWEsV0FBVyxZQUFZLEtBQUssR0FBRztBQUN6RixhQUFPO0FBQUEsUUFDTixTQUFTLENBQUM7QUFBQSxVQUNULE1BQU07QUFBQSxVQUNOLE1BQU0sR0FBRyxZQUFZLEtBQUssS0FBSyxRQUFRLEtBQUssR0FBRyxHQUFHLEtBQUssT0FBTyxLQUFLLEtBQUssSUFBSSxNQUFNLEVBQUU7QUFBQSxXQUFjLEtBQUssU0FBUztBQUFBLFdBQWMsS0FBSyxTQUFTO0FBQUEsUUFBVyxLQUFLLFdBQVc7QUFBQSxRQUN4SyxDQUFDO0FBQUEsUUFDRCxTQUFTLEVBQUUsS0FBSyxjQUFjLE1BQU0sVUFBVSxZQUFZO0FBQUEsTUFDM0Q7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBS0QsS0FBRyxhQUFhO0FBQUEsSUFDZixNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUFhO0FBQUEsSUFDYixZQUFZLEtBQUssT0FBTztBQUFBLE1BQ3ZCLEtBQUssS0FBSyxPQUFPLEVBQUUsYUFBYSxtREFBbUQsQ0FBQztBQUFBLElBQ3JGLENBQUM7QUFBQSxJQUVELE1BQU0sUUFBUSxhQUFhLFFBQVEsU0FBUyxXQUFXLE1BQU07QUFDNUQsWUFBTSxZQUFZLEtBQUssU0FBUyxPQUFPLEdBQUc7QUFDMUMsWUFBTSxlQUFlLFVBQVU7QUFDL0IsVUFBSTtBQUNILGNBQU0sRUFBRSxNQUFNLEVBQUUsSUFBSSxNQUFNLEtBQUssY0FBYztBQUM3QyxjQUFNLFNBQVMsS0FBSyxnQkFBZ0I7QUFDcEMsY0FBTSxjQUFjLGVBQWU7QUFDbkMsY0FBTSxhQUFhLGNBQWM7QUFDakMsWUFBSSxVQUFVLFlBQVksTUFBTTtBQUMvQixpQkFBTztBQUFBLFlBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sbUJBQW1CLFlBQVksOENBQThDLGFBQWEsV0FBVyxVQUFVLG1DQUFtQyxDQUFDO0FBQUEsWUFDbkwsU0FBUyxFQUFFLE9BQU8sbUJBQW1CLEtBQUssY0FBYyxVQUFVLFlBQVk7QUFBQSxZQUM5RSxTQUFTO0FBQUEsVUFDVjtBQUFBLFFBQ0Q7QUFDQSxZQUFJLGVBQWUsVUFBVSxZQUFZLFlBQVksU0FBUztBQUM3RCxpQkFBTztBQUFBLFlBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sS0FBSyxpQkFBaUIsY0FBYyxvQ0FBb0MsWUFBWSxPQUFPLEdBQUcsRUFBRSxDQUFDO0FBQUEsWUFDakksU0FBUyxFQUFFLE9BQU8sYUFBYSxLQUFLLGNBQWMsaUJBQWlCLFlBQVksU0FBUyxpQkFBaUIsVUFBVSxRQUFRO0FBQUEsWUFDM0gsU0FBUztBQUFBLFVBQ1Y7QUFBQSxRQUNEO0FBQ0EsY0FBTSxnQkFBZ0IsaUJBQWlCO0FBQ3ZDLGNBQU0sTUFBTSxVQUFVO0FBQ3RCLGNBQU0sT0FBTyxjQUFjLEdBQUc7QUFDOUIsWUFBSSxDQUFDLE1BQU07QUFDVixpQkFBTztBQUFBLFlBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sS0FBSyxpQkFBaUIsY0FBYyxlQUFlLEVBQUUsQ0FBQztBQUFBLFlBQ3RGLFNBQVMsRUFBRSxPQUFPLGlCQUFpQixLQUFLLGNBQWMsVUFBVSxZQUFZO0FBQUEsWUFDNUUsU0FBUztBQUFBLFVBQ1Y7QUFBQSxRQUNEO0FBQ0EsWUFBSSxhQUFhLE9BQU8sWUFBWSxRQUFRLEVBQUUsSUFBSSxHQUFHO0FBQ3BELGlCQUFPO0FBQUEsWUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxLQUFLLGlCQUFpQixjQUFjLDRCQUE0QixFQUFFLENBQUM7QUFBQSxZQUNuRyxTQUFTLEVBQUUsT0FBTyxhQUFhLEtBQUssY0FBYyxhQUFhLFlBQVksS0FBSyxZQUFZLEVBQUUsSUFBSSxFQUFFO0FBQUEsWUFDcEcsU0FBUztBQUFBLFVBQ1Y7QUFBQSxRQUNEO0FBRUEsY0FBTSxXQUFXLE1BQU0sS0FBSyxpQkFBaUIsUUFBUSxJQUFJO0FBQ3pELFlBQUksQ0FBQyxTQUFTLElBQUk7QUFDakIsZ0JBQU0sU0FBVSxTQUEyQztBQUMzRCxpQkFBTztBQUFBLFlBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sS0FBSyxpQkFBaUIsY0FBYyxNQUFNLEVBQUUsQ0FBQztBQUFBLFlBQzdFLFNBQVMsRUFBRSxPQUFPLGFBQWEsS0FBSyxjQUFjLE9BQU87QUFBQSxZQUN6RCxTQUFTO0FBQUEsVUFDVjtBQUFBLFFBQ0Q7QUFFQSxjQUFNLGNBQWMsTUFBTSxLQUFLLHdCQUF3QixHQUFHLEVBQUUsaUJBQWlCLE1BQU0sT0FBTyxDQUFDO0FBQzNGLGNBQU0sWUFBWSxZQUFZO0FBQzlCLGNBQU0sYUFBYSxLQUFLLFdBQVcsU0FBUztBQUM1QyxjQUFNLG9CQUFvQixNQUFNLEtBQUssd0JBQXdCLFFBQVEsU0FBUyxRQUFRO0FBQ3RGLGNBQU0sT0FBTyxRQUFRLFNBQVMsUUFBUSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsU0FBUyxJQUFLLENBQUM7QUFDdkUsY0FBTSxTQUFTLE1BQU0sS0FBSywwQkFBMEIsQ0FBQztBQUVyRCxjQUFNLGFBQWEsTUFBTSxLQUFLLHdCQUF3QixHQUFHLEVBQUUsaUJBQWlCLE1BQU0sT0FBTyxDQUFDO0FBQzFGLGNBQU0sV0FBVyxXQUFXO0FBQzVCLGNBQU0sWUFBWSxLQUFLLFdBQVcsUUFBUTtBQUMxQyxjQUFNLG1CQUFtQixNQUFNLEtBQUssd0JBQXdCLFFBQVEsU0FBUyxRQUFRO0FBQ3JGLGNBQU0scUJBQ0wsa0JBQWtCLFdBQVcsaUJBQWlCLFVBQzlDLGtCQUFrQixpQkFBaUIsaUJBQWlCLGdCQUNwRCxrQkFBa0IsZ0JBQWdCLGlCQUFpQixlQUNuRCxrQkFBa0IsaUJBQWlCLGlCQUFpQixnQkFDcEQsa0JBQWtCLFNBQVMsaUJBQWlCO0FBQzdDLGNBQU0sZUFBZSxLQUFLO0FBQUEsVUFDekI7QUFBQSxZQUNDLEVBQUUsTUFBTSxlQUFlLFFBQVEsYUFBYSxXQUFXLE9BQU8sVUFBVSxVQUFVLE1BQU0sU0FBUyxHQUFHO0FBQUEsWUFDcEcsRUFBRSxNQUFNLGdCQUFnQixRQUFRLGNBQWMsWUFBWSxPQUFPLFdBQVcsVUFBVSxNQUFNLFVBQVUsR0FBRztBQUFBLFlBQ3pHLEVBQUUsTUFBTSx3QkFBd0IsUUFBUSxvQkFBb0IsT0FBTyxrQkFBa0IsVUFBVSxrQkFBa0I7QUFBQSxZQUNqSCxFQUFFLE1BQU0sZUFBZSxRQUFRLFdBQVcsT0FBTyxRQUFRLFlBQVksT0FBTyxPQUFPLE9BQU8sV0FBVyxPQUFPLE9BQU8sVUFBVSxLQUFLLFlBQVksT0FBTyxLQUFLLEdBQUc7QUFBQSxVQUM5SjtBQUFBLFVBQ0E7QUFBQSxRQUNEO0FBRUEsY0FBTSxVQUFVLEtBQUssMEJBQTBCLFVBQVU7QUFDekQsY0FBTSxXQUFXLEtBQUssZ0JBQWdCLEVBQUUsSUFBSSxDQUFDO0FBQzdDLGNBQU0sZUFBZSxLQUFLLG1CQUFtQixhQUFhLFdBQVcsWUFBWSxLQUFLLEdBQUc7QUFDekYsZUFBTztBQUFBLFVBQ04sU0FBUyxDQUFDO0FBQUEsWUFDVCxNQUFNO0FBQUEsWUFDTixNQUFNLFdBQVcsWUFBWSxLQUFLLEtBQUssUUFBUSxLQUFLLEdBQUcsR0FBRyxLQUFLLE9BQU8sS0FBSyxLQUFLLElBQUksTUFBTSxFQUFFO0FBQUEsRUFBTSxLQUFLLGlCQUFpQixZQUFZLENBQUMsR0FBRyxRQUFRO0FBQUE7QUFBQTtBQUFBLEVBQXNCLE9BQU87QUFBQSxVQUM5SyxDQUFDO0FBQUEsVUFDRCxTQUFTLEVBQUUsS0FBSyxjQUFjLFVBQVUsU0FBUyxVQUFVLEtBQUssRUFBRSxJQUFJLEdBQUcsR0FBRyxRQUFRLEdBQUcsYUFBYTtBQUFBLFFBQ3JHO0FBQUEsTUFDRCxTQUFTLEtBQVU7QUFDbEIsY0FBTSxZQUFZLE1BQU0sS0FBSyx1QkFBdUIsS0FBSyxvQkFBb0IsQ0FBQztBQUM5RSxjQUFNLFNBQVMsS0FBSyxlQUFlLEdBQUc7QUFDdEMsY0FBTSxVQUFpQjtBQUFBLFVBQ3RCLEVBQUUsTUFBTSxRQUFRLE1BQU0sS0FBSyxpQkFBaUIsY0FBYyxrQkFBa0IsTUFBTSxFQUFFLEVBQUU7QUFBQSxVQUN0RixFQUFFLE1BQU0sUUFBUSxNQUFNLHFCQUFxQixJQUFJLE9BQU8sR0FBRztBQUFBLFFBQzFEO0FBQ0EsWUFBSSxXQUFXO0FBQ2Qsa0JBQVEsS0FBSyxFQUFFLE1BQU0sU0FBUyxNQUFNLFVBQVUsTUFBTSxVQUFVLFVBQVUsU0FBUyxDQUFDO0FBQUEsUUFDbkY7QUFDQSxlQUFPO0FBQUEsVUFDTjtBQUFBLFVBQ0EsU0FBUyxFQUFFLE9BQU8sSUFBSSxTQUFTLEtBQUssY0FBYyxNQUFNLDZDQUE2QztBQUFBLFVBQ3JHLFNBQVM7QUFBQSxRQUNWO0FBQUEsTUFDRDtBQUFBLElBQ0Q7QUFBQSxFQUNELENBQUM7QUFLRCxLQUFHLGFBQWE7QUFBQSxJQUNmLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQWE7QUFBQSxJQUNiLFlBQVksS0FBSyxPQUFPO0FBQUEsTUFDdkIsS0FBSyxLQUFLLE9BQU8sRUFBRSxhQUFhLG1EQUFtRCxDQUFDO0FBQUEsSUFDckYsQ0FBQztBQUFBLElBRUQsTUFBTSxRQUFRLGFBQWEsUUFBUSxTQUFTLFdBQVcsTUFBTTtBQUM1RCxZQUFNLFlBQVksS0FBSyxTQUFTLE9BQU8sR0FBRztBQUMxQyxZQUFNLGVBQWUsVUFBVTtBQUMvQixVQUFJO0FBQ0gsY0FBTSxFQUFFLE1BQU0sRUFBRSxJQUFJLE1BQU0sS0FBSyxjQUFjO0FBQzdDLGNBQU0sU0FBUyxLQUFLLGdCQUFnQjtBQUNwQyxjQUFNLGNBQWMsZUFBZTtBQUNuQyxjQUFNLGFBQWEsY0FBYztBQUNqQyxZQUFJLFVBQVUsWUFBWSxNQUFNO0FBQy9CLGlCQUFPO0FBQUEsWUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxtQkFBbUIsWUFBWSw4Q0FBOEMsYUFBYSxXQUFXLFVBQVUsbUNBQW1DLENBQUM7QUFBQSxZQUNuTCxTQUFTLEVBQUUsT0FBTyxtQkFBbUIsS0FBSyxjQUFjLFVBQVUsWUFBWTtBQUFBLFlBQzlFLFNBQVM7QUFBQSxVQUNWO0FBQUEsUUFDRDtBQUNBLFlBQUksZUFBZSxVQUFVLFlBQVksWUFBWSxTQUFTO0FBQzdELGlCQUFPO0FBQUEsWUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxLQUFLLGlCQUFpQixjQUFjLG9DQUFvQyxZQUFZLE9BQU8sR0FBRyxFQUFFLENBQUM7QUFBQSxZQUNqSSxTQUFTLEVBQUUsT0FBTyxhQUFhLEtBQUssY0FBYyxpQkFBaUIsWUFBWSxTQUFTLGlCQUFpQixVQUFVLFFBQVE7QUFBQSxZQUMzSCxTQUFTO0FBQUEsVUFDVjtBQUFBLFFBQ0Q7QUFDQSxjQUFNLGdCQUFnQixpQkFBaUI7QUFDdkMsY0FBTSxNQUFNLFVBQVU7QUFDdEIsY0FBTSxPQUFPLGNBQWMsR0FBRztBQUM5QixZQUFJLENBQUMsTUFBTTtBQUNWLGlCQUFPO0FBQUEsWUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxLQUFLLGlCQUFpQixjQUFjLGVBQWUsRUFBRSxDQUFDO0FBQUEsWUFDdEYsU0FBUyxFQUFFLE9BQU8saUJBQWlCLEtBQUssY0FBYyxVQUFVLFlBQVk7QUFBQSxZQUM1RSxTQUFTO0FBQUEsVUFDVjtBQUFBLFFBQ0Q7QUFDQSxZQUFJLGFBQWEsT0FBTyxZQUFZLFFBQVEsRUFBRSxJQUFJLEdBQUc7QUFDcEQsaUJBQU87QUFBQSxZQUNOLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLEtBQUssaUJBQWlCLGNBQWMsNEJBQTRCLEVBQUUsQ0FBQztBQUFBLFlBQ25HLFNBQVMsRUFBRSxPQUFPLGFBQWEsS0FBSyxjQUFjLGFBQWEsWUFBWSxLQUFLLFlBQVksRUFBRSxJQUFJLEVBQUU7QUFBQSxZQUNwRyxTQUFTO0FBQUEsVUFDVjtBQUFBLFFBQ0Q7QUFFQSxjQUFNLFdBQVcsTUFBTSxLQUFLLGlCQUFpQixRQUFRLElBQUk7QUFDekQsWUFBSSxDQUFDLFNBQVMsSUFBSTtBQUNqQixnQkFBTSxTQUFVLFNBQTJDO0FBQzNELGlCQUFPO0FBQUEsWUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQVEsTUFBTSxLQUFLLGlCQUFpQixjQUFjLE1BQU0sRUFBRSxDQUFDO0FBQUEsWUFDN0UsU0FBUyxFQUFFLE9BQU8sYUFBYSxLQUFLLGNBQWMsT0FBTztBQUFBLFlBQ3pELFNBQVM7QUFBQSxVQUNWO0FBQUEsUUFDRDtBQUVBLGNBQU0sT0FBTyxRQUFRLFNBQVMsUUFBUSxFQUFFLE1BQU0sRUFBRSxNQUFNLEVBQUUsU0FBUyxJQUFLLENBQUM7QUFDdkUsY0FBTSxTQUFTLE1BQU0sS0FBSywwQkFBMEIsQ0FBQztBQUVyRCxjQUFNLGFBQWEsTUFBTSxLQUFLLHdCQUF3QixHQUFHLEVBQUUsaUJBQWlCLE9BQU8sT0FBTyxDQUFDO0FBQzNGLGNBQU0sVUFBVSxLQUFLLDBCQUEwQixVQUFVO0FBQ3pELGNBQU0sV0FBVyxLQUFLLGdCQUFnQixFQUFFLElBQUksQ0FBQztBQUM3QyxjQUFNLGVBQWUsS0FBSyxtQkFBbUIsYUFBYSxXQUFXLFlBQVksS0FBSyxHQUFHO0FBQ3pGLGVBQU87QUFBQSxVQUNOLFNBQVMsQ0FBQztBQUFBLFlBQ1QsTUFBTTtBQUFBLFlBQ04sTUFBTSxXQUFXLFlBQVksS0FBSyxLQUFLLFFBQVEsS0FBSyxHQUFHLEdBQUcsS0FBSyxPQUFPLEtBQUssS0FBSyxJQUFJLE1BQU0sRUFBRSxJQUFJLFFBQVE7QUFBQTtBQUFBO0FBQUEsRUFBc0IsT0FBTztBQUFBLFVBQ3RJLENBQUM7QUFBQSxVQUNELFNBQVMsRUFBRSxLQUFLLGNBQWMsVUFBVSxTQUFTLFVBQVUsS0FBSyxFQUFFLElBQUksR0FBRyxHQUFHLE9BQU87QUFBQSxRQUNwRjtBQUFBLE1BQ0QsU0FBUyxLQUFVO0FBQ2xCLGNBQU0sWUFBWSxNQUFNLEtBQUssdUJBQXVCLEtBQUssb0JBQW9CLENBQUM7QUFDOUUsY0FBTSxTQUFTLEtBQUssZUFBZSxHQUFHO0FBQ3RDLGNBQU0sVUFBaUI7QUFBQSxVQUN0QixFQUFFLE1BQU0sUUFBUSxNQUFNLEtBQUssaUJBQWlCLGNBQWMsa0JBQWtCLE1BQU0sRUFBRSxFQUFFO0FBQUEsVUFDdEYsRUFBRSxNQUFNLFFBQVEsTUFBTSxxQkFBcUIsSUFBSSxPQUFPLEdBQUc7QUFBQSxRQUMxRDtBQUNBLFlBQUksV0FBVztBQUNkLGtCQUFRLEtBQUssRUFBRSxNQUFNLFNBQVMsTUFBTSxVQUFVLE1BQU0sVUFBVSxVQUFVLFNBQVMsQ0FBQztBQUFBLFFBQ25GO0FBQ0EsZUFBTztBQUFBLFVBQ047QUFBQSxVQUNBLFNBQVMsRUFBRSxPQUFPLElBQUksU0FBUyxLQUFLLGNBQWMsTUFBTSw2Q0FBNkM7QUFBQSxVQUNyRyxTQUFTO0FBQUEsUUFDVjtBQUFBLE1BQ0Q7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBS0QsS0FBRyxhQUFhO0FBQUEsSUFDZixNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUFhO0FBQUEsSUFDYixZQUFZLEtBQUssT0FBTztBQUFBLE1BQ3ZCLEtBQUssS0FBSyxPQUFPLEVBQUUsYUFBYSxtREFBbUQsQ0FBQztBQUFBLE1BQ3BGLE1BQU0sS0FBSyxPQUFPLEVBQUUsYUFBYSxpQkFBaUIsQ0FBQztBQUFBLE1BQ25ELFlBQVksS0FBSztBQUFBLFFBQ2hCLEtBQUssUUFBUSxFQUFFLGFBQWEsK0NBQStDLENBQUM7QUFBQSxNQUM3RTtBQUFBLE1BQ0EsUUFBUSxLQUFLO0FBQUEsUUFDWixLQUFLLFFBQVEsRUFBRSxhQUFhLDZDQUE2QyxDQUFDO0FBQUEsTUFDM0U7QUFBQSxNQUNBLFFBQVEsS0FBSztBQUFBLFFBQ1osS0FBSyxRQUFRLEVBQUUsYUFBYSxnREFBZ0QsQ0FBQztBQUFBLE1BQzlFO0FBQUEsSUFDRCxDQUFDO0FBQUEsSUFFRCxNQUFNLFFBQVEsYUFBYSxRQUFRLFNBQVMsV0FBVyxNQUFNO0FBQzVELFlBQU0sWUFBWSxLQUFLLFNBQVMsT0FBTyxHQUFHO0FBQzFDLFlBQU0sZUFBZSxVQUFVO0FBQy9CLFVBQUk7QUFDSCxjQUFNLEVBQUUsTUFBTSxFQUFFLElBQUksTUFBTSxLQUFLLGNBQWM7QUFDN0MsY0FBTSxTQUFTLEtBQUssZ0JBQWdCO0FBQ3BDLGNBQU0sY0FBYyxlQUFlO0FBQ25DLGNBQU0sYUFBYSxjQUFjO0FBQ2pDLFlBQUksVUFBVSxZQUFZLE1BQU07QUFDL0IsaUJBQU87QUFBQSxZQUNOLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLG1CQUFtQixZQUFZLDhDQUE4QyxhQUFhLFdBQVcsVUFBVSxtQ0FBbUMsQ0FBQztBQUFBLFlBQ25MLFNBQVMsRUFBRSxPQUFPLG1CQUFtQixLQUFLLGNBQWMsVUFBVSxZQUFZO0FBQUEsWUFDOUUsU0FBUztBQUFBLFVBQ1Y7QUFBQSxRQUNEO0FBQ0EsWUFBSSxlQUFlLFVBQVUsWUFBWSxZQUFZLFNBQVM7QUFDN0QsaUJBQU87QUFBQSxZQUNOLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLEtBQUssaUJBQWlCLGNBQWMsb0NBQW9DLFlBQVksT0FBTyxHQUFHLEVBQUUsQ0FBQztBQUFBLFlBQ2pJLFNBQVMsRUFBRSxPQUFPLGFBQWEsS0FBSyxjQUFjLGlCQUFpQixZQUFZLFNBQVMsaUJBQWlCLFVBQVUsUUFBUTtBQUFBLFlBQzNILFNBQVM7QUFBQSxVQUNWO0FBQUEsUUFDRDtBQUNBLGNBQU0sZ0JBQWdCLGlCQUFpQjtBQUN2QyxjQUFNLE1BQU0sVUFBVTtBQUN0QixjQUFNLE9BQU8sY0FBYyxHQUFHO0FBQzlCLFlBQUksQ0FBQyxNQUFNO0FBQ1YsaUJBQU87QUFBQSxZQUNOLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLEtBQUssaUJBQWlCLGNBQWMsZUFBZSxFQUFFLENBQUM7QUFBQSxZQUN0RixTQUFTLEVBQUUsT0FBTyxpQkFBaUIsS0FBSyxjQUFjLFVBQVUsWUFBWTtBQUFBLFlBQzVFLFNBQVM7QUFBQSxVQUNWO0FBQUEsUUFDRDtBQUNBLFlBQUksYUFBYSxPQUFPLFlBQVksUUFBUSxFQUFFLElBQUksR0FBRztBQUNwRCxpQkFBTztBQUFBLFlBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0sS0FBSyxpQkFBaUIsY0FBYyw0QkFBNEIsRUFBRSxDQUFDO0FBQUEsWUFDbkcsU0FBUyxFQUFFLE9BQU8sYUFBYSxLQUFLLGNBQWMsYUFBYSxZQUFZLEtBQUssWUFBWSxFQUFFLElBQUksRUFBRTtBQUFBLFlBQ3BHLFNBQVM7QUFBQSxVQUNWO0FBQUEsUUFDRDtBQUVBLGNBQU0sV0FBVyxNQUFNLEtBQUssaUJBQWlCLFFBQVEsSUFBSTtBQUN6RCxZQUFJLENBQUMsU0FBUyxJQUFJO0FBQ2pCLGdCQUFNLFNBQVUsU0FBMkM7QUFDM0QsaUJBQU87QUFBQSxZQUNOLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLEtBQUssaUJBQWlCLGNBQWMsTUFBTSxFQUFFLENBQUM7QUFBQSxZQUM3RSxTQUFTLEVBQUUsT0FBTyxhQUFhLEtBQUssY0FBYyxPQUFPO0FBQUEsWUFDekQsU0FBUztBQUFBLFVBQ1Y7QUFBQSxRQUNEO0FBRUEsY0FBTSxVQUFVLE9BQU8sUUFBUSxTQUFTLFFBQVEsRUFBRSxNQUFNO0FBQ3hELGNBQU0sWUFBWSxFQUFFLElBQUk7QUFDeEIsWUFBSSxPQUFPLFFBQVE7QUFDbEIsZ0JBQU0sUUFBUSxNQUFNLEVBQUUsU0FBUyxJQUFLLENBQUM7QUFDckMsY0FBSSxPQUFPLFlBQVk7QUFDdEIsa0JBQU0sRUFBRSxTQUFTLE1BQU0sV0FBVztBQUNsQyxrQkFBTSxFQUFFLFNBQVMsTUFBTSxRQUFRO0FBQUEsVUFDaEM7QUFDQSxnQkFBTSxFQUFFLFNBQVMsS0FBSyxPQUFPLElBQUk7QUFBQSxRQUNsQyxPQUFPO0FBQ04sY0FBSSxPQUFPLFlBQVk7QUFDdEIsa0JBQU0sUUFBUSxLQUFLLEVBQUU7QUFBQSxVQUN0QjtBQUNBLGdCQUFNLFFBQVEsS0FBSyxPQUFPLE1BQU0sRUFBRSxTQUFTLElBQUssQ0FBQztBQUFBLFFBQ2xEO0FBQ0EsWUFBSSxPQUFPLFFBQVE7QUFDbEIsZ0JBQU0sRUFBRSxTQUFTLE1BQU0sT0FBTztBQUFBLFFBQy9CO0FBQ0EsY0FBTSxTQUFTLE1BQU0sS0FBSywwQkFBMEIsQ0FBQztBQUVyRCxjQUFNLGNBQWMsTUFBTSxLQUFLLG1CQUFtQixRQUFRLFNBQVMsUUFBUTtBQUMzRSxjQUFNLFdBQVcsRUFBRSxJQUFJO0FBQ3ZCLGNBQU0sZUFBZSxLQUFLO0FBQUEsVUFDekI7QUFBQSxZQUNDLEVBQUUsTUFBTSx5QkFBeUIsUUFBUSxnQkFBZ0IsT0FBTyxNQUFNLE9BQU8sYUFBYSxVQUFVLE9BQU8sS0FBSztBQUFBLFlBQ2hILEVBQUUsTUFBTSwyQkFBMkIsUUFBUSxPQUFPLGdCQUFnQixZQUFZLFlBQVksU0FBUyxPQUFPLElBQUksR0FBRyxPQUFPLGFBQWEsVUFBVSxPQUFPLEtBQUs7QUFBQSxZQUMzSixFQUFFLE1BQU0sNEJBQTRCLFFBQVEsQ0FBQyxDQUFDLE9BQU8sVUFBVSxhQUFhLFdBQVcsT0FBTyxVQUFVLFVBQVUsTUFBTSxTQUFTLEdBQUc7QUFBQSxVQUNySTtBQUFBLFVBQ0E7QUFBQSxRQUNEO0FBRUEsY0FBTSxhQUFhLE1BQU0sS0FBSyx3QkFBd0IsR0FBRyxFQUFFLGlCQUFpQixNQUFNLE9BQU8sQ0FBQztBQUMxRixjQUFNLFVBQVUsS0FBSywwQkFBMEIsVUFBVTtBQUN6RCxjQUFNLFdBQVcsS0FBSyxnQkFBZ0IsRUFBRSxJQUFJLENBQUM7QUFDN0MsY0FBTSxlQUFlLEtBQUssbUJBQW1CLGFBQWEsV0FBVyxZQUFZLEtBQUssR0FBRztBQUN6RixlQUFPO0FBQUEsVUFDTixTQUFTLENBQUM7QUFBQSxZQUNULE1BQU07QUFBQSxZQUNOLE1BQU0sVUFBVSxZQUFZLEtBQUssS0FBSyxRQUFRLEtBQUssR0FBRyxHQUFHLEtBQUssT0FBTyxLQUFLLEtBQUssSUFBSSxNQUFNLEVBQUUsV0FBVyxPQUFPLElBQUk7QUFBQSxFQUFNLEtBQUssaUJBQWlCLFlBQVksQ0FBQyxHQUFHLFFBQVE7QUFBQTtBQUFBO0FBQUEsRUFBc0IsT0FBTztBQUFBLFVBQ25NLENBQUM7QUFBQSxVQUNELFNBQVMsRUFBRSxLQUFLLGNBQWMsVUFBVSxTQUFTLFVBQVUsS0FBSyxFQUFFLElBQUksR0FBRyxhQUFhLEdBQUcsUUFBUSxHQUFHLGFBQWE7QUFBQSxRQUNsSDtBQUFBLE1BQ0QsU0FBUyxLQUFVO0FBQ2xCLGNBQU0sWUFBWSxNQUFNLEtBQUssdUJBQXVCLEtBQUssb0JBQW9CLENBQUM7QUFDOUUsY0FBTSxTQUFTLEtBQUssZUFBZSxHQUFHO0FBQ3RDLGNBQU0sVUFBaUI7QUFBQSxVQUN0QixFQUFFLE1BQU0sUUFBUSxNQUFNLEtBQUssaUJBQWlCLGNBQWMsa0JBQWtCLE1BQU0sRUFBRSxFQUFFO0FBQUEsVUFDdEYsRUFBRSxNQUFNLFFBQVEsTUFBTSxvQkFBb0IsSUFBSSxPQUFPLEdBQUc7QUFBQSxRQUN6RDtBQUNBLFlBQUksV0FBVztBQUNkLGtCQUFRLEtBQUssRUFBRSxNQUFNLFNBQVMsTUFBTSxVQUFVLE1BQU0sVUFBVSxVQUFVLFNBQVMsQ0FBQztBQUFBLFFBQ25GO0FBQ0EsZUFBTztBQUFBLFVBQ047QUFBQSxVQUNBLFNBQVMsRUFBRSxPQUFPLElBQUksU0FBUyxLQUFLLGNBQWMsTUFBTSw2Q0FBNkM7QUFBQSxVQUNyRyxTQUFTO0FBQUEsUUFDVjtBQUFBLE1BQ0Q7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBQ0Y7IiwKICAibmFtZXMiOiBbXQp9Cg==
