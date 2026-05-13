import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { isClosedStatus } from "../status-guards.js";
import {
  transaction,
  insertMilestone,
  insertSlice,
  getSlice,
  getSliceTasks,
  getMilestone,
  updateSliceStatus,
  setSliceSummaryMd,
  saveGateResult,
  getPendingGatesForTurn
} from "../gsd-db.js";
import { getGatesForTurn } from "../gate-registry.js";
import { resolveSlicePath, clearPathCache } from "../paths.js";
import { checkOwnership, sliceUnitKey } from "../unit-ownership.js";
import { saveFile, clearParseCache } from "../files.js";
import { invalidateStateCache } from "../state.js";
import { renderRoadmapCheckboxes } from "../markdown-renderer.js";
import { isStaleWrite } from "../auto/turn-epoch.js";
import { renderAllProjections } from "../workflow-projections.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning, logError } from "../workflow-logger.js";
function sliceGateFieldForId(id, params) {
  switch (id) {
    case "Q8":
      return params.operationalReadiness;
    default:
      return void 0;
  }
}
function renderSliceSummaryMarkdown(params) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const provides = params.provides ?? [];
  const requires = params.requires ?? [];
  const affects = params.affects ?? [];
  const keyFiles = params.keyFiles ?? [];
  const keyDecisions = params.keyDecisions ?? [];
  const patternsEstablished = params.patternsEstablished ?? [];
  const observabilitySurfaces = params.observabilitySurfaces ?? [];
  const drillDownPaths = params.drillDownPaths ?? [];
  const requirementsAdvanced = params.requirementsAdvanced ?? [];
  const requirementsValidated = params.requirementsValidated ?? [];
  const requirementsSurfaced = params.requirementsSurfaced ?? [];
  const requirementsInvalidated = params.requirementsInvalidated ?? [];
  const filesModified = params.filesModified ?? [];
  const providesYaml = provides.length > 0 ? provides.map((p) => `  - ${p}`).join("\n") : "  - (none)";
  const requiresYaml = requires.length > 0 ? requires.map((r) => `  - slice: ${r.slice}
    provides: ${r.provides}`).join("\n") : "  []";
  const affectsYaml = affects.length > 0 ? affects.map((a) => `  - ${a}`).join("\n") : "  []";
  const keyFilesYaml = keyFiles.length > 0 ? `
${keyFiles.map((f) => `  - ${f}`).join("\n")}` : " []";
  const keyDecisionsYaml = keyDecisions.length > 0 ? `
${keyDecisions.map((d) => `  - ${d}`).join("\n")}` : " []";
  const patternsYaml = patternsEstablished.length > 0 ? patternsEstablished.map((p) => `  - ${p}`).join("\n") : "  - (none)";
  const observabilityYaml = observabilitySurfaces.length > 0 ? observabilitySurfaces.map((o) => `  - ${o}`).join("\n") : "  - none";
  const drillDownYaml = drillDownPaths.length > 0 ? drillDownPaths.map((d) => `  - ${d}`).join("\n") : "  []";
  const reqAdvanced = requirementsAdvanced.length > 0 ? requirementsAdvanced.map((r) => `- ${r.id} \u2014 ${r.how}`).join("\n") : "None.";
  const reqValidated = requirementsValidated.length > 0 ? requirementsValidated.map((r) => `- ${r.id} \u2014 ${r.proof}`).join("\n") : "None.";
  const reqSurfaced = requirementsSurfaced.length > 0 ? requirementsSurfaced.map((r) => `- ${r}`).join("\n") : "None.";
  const reqInvalidated = requirementsInvalidated.length > 0 ? requirementsInvalidated.map((r) => `- ${r.id} \u2014 ${r.what}`).join("\n") : "None.";
  const filesMod = filesModified.length > 0 ? filesModified.map((f) => `- \`${f.path}\` \u2014 ${f.description}`).join("\n") : "None.";
  return `---
id: ${params.sliceId}
parent: ${params.milestoneId}
milestone: ${params.milestoneId}
provides:
${providesYaml}
requires:
${requiresYaml}
affects:
${affectsYaml}
key_files:${keyFilesYaml}
key_decisions:${keyDecisionsYaml}
patterns_established:
${patternsYaml}
observability_surfaces:
${observabilityYaml}
drill_down_paths:
${drillDownYaml}
duration: ""
verification_result: passed
completed_at: ${now}
blocker_discovered: false
---

# ${params.sliceId}: ${params.sliceTitle}

**${params.oneLiner}**

## What Happened

${params.narrative}

## Verification

${params.verification}

## Requirements Advanced

${reqAdvanced}

## Requirements Validated

${reqValidated}

## New Requirements Surfaced

${reqSurfaced}

## Requirements Invalidated or Re-scoped

${reqInvalidated}

## Operational Readiness

${params.operationalReadiness?.trim() || "None."}

## Deviations

${params.deviations || "None."}

## Known Limitations

${params.knownLimitations || "None."}

## Follow-ups

${params.followUps || "None."}

## Files Created/Modified

${filesMod}
`;
}
function renderUatMarkdown(params) {
  return `# ${params.sliceId}: ${params.sliceTitle} \u2014 UAT

**Milestone:** ${params.milestoneId}
**Written:** ${(/* @__PURE__ */ new Date()).toISOString()}

${params.uatContent}
`;
}
async function handleCompleteSlice(params, basePath) {
  if (!params.sliceId || typeof params.sliceId !== "string" || params.sliceId.trim() === "") {
    return { error: "sliceId is required and must be a non-empty string" };
  }
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }
  const ownershipErr = checkOwnership(
    basePath,
    sliceUnitKey(params.milestoneId, params.sliceId),
    params.actorName
  );
  if (ownershipErr) {
    return { error: ownershipErr };
  }
  const BLOCKED_SIGNALS = /\b(status:\s*blocked|verification_result:\s*failed|slice is blocked|cannot complete|verification failed)\b/i;
  if (BLOCKED_SIGNALS.test(params.verification || "") || BLOCKED_SIGNALS.test(params.uatContent || "")) {
    return { error: `slice verification indicates blocked/failed state \u2014 do not complete a slice that has not passed verification. Address the blockers and re-verify first.` };
  }
  const completedAt = (/* @__PURE__ */ new Date()).toISOString();
  let guardError = null;
  transaction(() => {
    const milestone = getMilestone(params.milestoneId);
    if (milestone && isClosedStatus(milestone.status)) {
      guardError = `cannot complete slice in a closed milestone: ${params.milestoneId} (status: ${milestone.status})`;
      return;
    }
    const slice = getSlice(params.milestoneId, params.sliceId);
    if (slice && isClosedStatus(slice.status)) {
      if (isStaleWrite("complete-slice")) {
        guardError = "__stale_duplicate__";
        return;
      }
      guardError = `slice ${params.sliceId} is already complete \u2014 use gsd_slice_reopen first if you need to redo it`;
      return;
    }
    const tasks = getSliceTasks(params.milestoneId, params.sliceId);
    if (tasks.length === 0) {
      guardError = `no tasks found for slice ${params.sliceId} in milestone ${params.milestoneId}`;
      return;
    }
    const incompleteTasks = tasks.filter((t) => !isClosedStatus(t.status));
    if (incompleteTasks.length > 0) {
      const incompleteIds = incompleteTasks.map((t) => `${t.id} (status: ${t.status})`).join(", ");
      guardError = `incomplete tasks: ${incompleteIds}`;
      return;
    }
    insertMilestone({ id: params.milestoneId, title: params.milestoneId });
    insertSlice({ id: params.sliceId, milestoneId: params.milestoneId, title: params.sliceId });
    updateSliceStatus(params.milestoneId, params.sliceId, "complete", completedAt);
  });
  if (guardError === "__stale_duplicate__") {
    const sliceDir2 = resolveSlicePath(basePath, params.milestoneId, params.sliceId);
    const staleSummaryPath = sliceDir2 ? join(sliceDir2, `${params.sliceId}-SUMMARY.md`) : join(
      basePath,
      ".gsd",
      "milestones",
      params.milestoneId,
      "slices",
      params.sliceId,
      `${params.sliceId}-SUMMARY.md`
    );
    return {
      sliceId: params.sliceId,
      milestoneId: params.milestoneId,
      summaryPath: staleSummaryPath,
      uatPath: staleSummaryPath.replace(/-SUMMARY\.md$/, "-UAT.md"),
      duplicate: true,
      stale: true
    };
  }
  if (guardError) {
    return { error: guardError };
  }
  const summaryMd = renderSliceSummaryMarkdown(params);
  let summaryPath;
  const sliceDir = resolveSlicePath(basePath, params.milestoneId, params.sliceId);
  if (sliceDir) {
    summaryPath = join(sliceDir, `${params.sliceId}-SUMMARY.md`);
  } else {
    const gsdDir = join(basePath, ".gsd");
    const manualSliceDir = join(gsdDir, "milestones", params.milestoneId, "slices", params.sliceId);
    mkdirSync(manualSliceDir, { recursive: true });
    summaryPath = join(manualSliceDir, `${params.sliceId}-SUMMARY.md`);
  }
  const uatMd = renderUatMarkdown(params);
  const uatPath = summaryPath.replace(/-SUMMARY\.md$/, "-UAT.md");
  setSliceSummaryMd(params.milestoneId, params.sliceId, summaryMd, uatMd);
  let projectionStale = false;
  try {
    await saveFile(summaryPath, summaryMd);
    await saveFile(uatPath, uatMd);
    const roadmapToggled = await renderRoadmapCheckboxes(basePath, params.milestoneId);
    if (!roadmapToggled) {
      logWarning("tool", `complete_slice \u2014 could not find roadmap for ${params.milestoneId}, skipping checkbox toggle`);
    }
  } catch (renderErr) {
    projectionStale = true;
    logWarning("projection", `complete_slice projection write failed for ${params.milestoneId}/${params.sliceId}; DB completion remains committed`, { error: renderErr.message });
  }
  try {
    const pendingGates = getPendingGatesForTurn(
      params.milestoneId,
      params.sliceId,
      "complete-slice"
    );
    if (pendingGates.length > 0) {
      const ownedDefs = new Map(getGatesForTurn("complete-slice").map((g) => [g.id, g]));
      for (const row of pendingGates) {
        const def = ownedDefs.get(row.gate_id);
        if (!def) continue;
        const field = sliceGateFieldForId(def.id, params);
        const hasContent = typeof field === "string" && field.trim().length > 0;
        saveGateResult({
          milestoneId: params.milestoneId,
          sliceId: params.sliceId,
          gateId: def.id,
          verdict: hasContent ? "pass" : "omitted",
          rationale: hasContent ? `${def.promptSection} section populated in slice summary` : `${def.promptSection} section left empty \u2014 recorded as omitted`,
          findings: hasContent ? field.trim() : ""
        });
      }
    }
  } catch (gateErr) {
    logWarning(
      "tool",
      `complete-slice gate close warning for ${params.milestoneId}/${params.sliceId}: ${gateErr.message}`
    );
  }
  invalidateStateCache();
  clearPathCache();
  clearParseCache();
  try {
    await renderAllProjections(basePath, params.milestoneId);
  } catch (projErr) {
    logWarning("tool", `complete-slice projection warning for ${params.milestoneId}/${params.sliceId}: ${projErr.message}`);
  }
  try {
    writeManifest(basePath);
  } catch (mfErr) {
    logWarning("tool", `complete-slice manifest warning: ${mfErr.message}`);
  }
  try {
    appendEvent(basePath, {
      cmd: "complete-slice",
      params: { milestoneId: params.milestoneId, sliceId: params.sliceId },
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      actor: "agent",
      actor_name: params.actorName,
      trigger_reason: params.triggerReason
    });
  } catch (eventErr) {
    logError("tool", `complete-slice event log FAILED \u2014 completion invisible to reconciliation`, { error: eventErr.message });
  }
  (async () => {
    try {
      const graphMod = await import("@gsd-build/mcp-server");
      if (typeof graphMod.buildGraph !== "function" || typeof graphMod.writeGraph !== "function" || typeof graphMod.resolveGsdRoot !== "function") {
        throw new Error("graph helpers unavailable from @gsd-build/mcp-server");
      }
      const g = await graphMod.buildGraph(basePath);
      await graphMod.writeGraph(graphMod.resolveGsdRoot(basePath), g);
    } catch (graphErr) {
      logWarning("tool", `complete-slice graph rebuild failed (non-fatal): ${graphErr.message ?? String(graphErr)}`);
    }
  })();
  return {
    sliceId: params.sliceId,
    milestoneId: params.milestoneId,
    summaryPath,
    uatPath,
    ...projectionStale ? { stale: true } : {}
  };
}
export {
  handleCompleteSlice
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy9jb21wbGV0ZS1zbGljZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBjb21wbGV0ZS1zbGljZSBoYW5kbGVyIFx1MjAxNCB0aGUgY29yZSBvcGVyYXRpb24gYmVoaW5kIGdzZF9zbGljZV9jb21wbGV0ZS5cbiAqXG4gKiBWYWxpZGF0ZXMgaW5wdXRzLCBjaGVja3MgYWxsIHRhc2tzIGFyZSBjb21wbGV0ZSwgd3JpdGVzIHNsaWNlIHJvdyB0byBEQiBpblxuICogYSB0cmFuc2FjdGlvbiwgdGhlbiAob3V0c2lkZSB0aGUgdHJhbnNhY3Rpb24pIHJlbmRlcnMgU1VNTUFSWS5tZCArIFVBVC5tZFxuICogdG8gZGlzaywgdG9nZ2xlcyB0aGUgcm9hZG1hcCBjaGVja2JveCwgc3RvcmVzIHJlbmRlcmVkIG1hcmtkb3duIGluIERCIGZvclxuICogRDAwNCByZWNvdmVyeSwgYW5kIGludmFsaWRhdGVzIGNhY2hlcy4gUHJvamVjdGlvbiB3cml0ZSBmYWlsdXJlcyBhcmUgc3RhbGVcbiAqIHByb2plY3Rpb24gZGlhZ25vc3RpY3MgYW5kIGRvIG5vdCByb2xsIGJhY2sgY29tbWl0dGVkIERCIHN0YXRlLlxuICovXG5cbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBta2RpclN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuXG5pbXBvcnQgdHlwZSB7IENvbXBsZXRlU2xpY2VQYXJhbXMgfSBmcm9tIFwiLi4vdHlwZXMuanNcIjtcbmltcG9ydCB7IGlzQ2xvc2VkU3RhdHVzIH0gZnJvbSBcIi4uL3N0YXR1cy1ndWFyZHMuanNcIjtcbmltcG9ydCB7XG4gIHRyYW5zYWN0aW9uLFxuICBpbnNlcnRNaWxlc3RvbmUsXG4gIGluc2VydFNsaWNlLFxuICBnZXRTbGljZSxcbiAgZ2V0U2xpY2VUYXNrcyxcbiAgZ2V0TWlsZXN0b25lLFxuICB1cGRhdGVTbGljZVN0YXR1cyxcbiAgc2V0U2xpY2VTdW1tYXJ5TWQsXG4gIHNhdmVHYXRlUmVzdWx0LFxuICBnZXRQZW5kaW5nR2F0ZXNGb3JUdXJuLFxufSBmcm9tIFwiLi4vZ3NkLWRiLmpzXCI7XG5pbXBvcnQgeyBnZXRHYXRlc0ZvclR1cm4gfSBmcm9tIFwiLi4vZ2F0ZS1yZWdpc3RyeS5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVNsaWNlRmlsZSwgcmVzb2x2ZVNsaWNlUGF0aCwgY2xlYXJQYXRoQ2FjaGUgfSBmcm9tIFwiLi4vcGF0aHMuanNcIjtcbmltcG9ydCB7IGNoZWNrT3duZXJzaGlwLCBzbGljZVVuaXRLZXkgfSBmcm9tIFwiLi4vdW5pdC1vd25lcnNoaXAuanNcIjtcbmltcG9ydCB7IHNhdmVGaWxlLCBjbGVhclBhcnNlQ2FjaGUgfSBmcm9tIFwiLi4vZmlsZXMuanNcIjtcbmltcG9ydCB7IGludmFsaWRhdGVTdGF0ZUNhY2hlIH0gZnJvbSBcIi4uL3N0YXRlLmpzXCI7XG5pbXBvcnQgeyByZW5kZXJSb2FkbWFwQ2hlY2tib3hlcyB9IGZyb20gXCIuLi9tYXJrZG93bi1yZW5kZXJlci5qc1wiO1xuaW1wb3J0IHsgaXNTdGFsZVdyaXRlIH0gZnJvbSBcIi4uL2F1dG8vdHVybi1lcG9jaC5qc1wiO1xuaW1wb3J0IHsgcmVuZGVyQWxsUHJvamVjdGlvbnMgfSBmcm9tIFwiLi4vd29ya2Zsb3ctcHJvamVjdGlvbnMuanNcIjtcbmltcG9ydCB7IHdyaXRlTWFuaWZlc3QgfSBmcm9tIFwiLi4vd29ya2Zsb3ctbWFuaWZlc3QuanNcIjtcbmltcG9ydCB7IGFwcGVuZEV2ZW50IH0gZnJvbSBcIi4uL3dvcmtmbG93LWV2ZW50cy5qc1wiO1xuaW1wb3J0IHsgbG9nV2FybmluZywgbG9nRXJyb3IgfSBmcm9tIFwiLi4vd29ya2Zsb3ctbG9nZ2VyLmpzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tcGxldGVTbGljZVJlc3VsdCB7XG4gIHNsaWNlSWQ6IHN0cmluZztcbiAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgc3VtbWFyeVBhdGg6IHN0cmluZztcbiAgdWF0UGF0aDogc3RyaW5nO1xuICAvKipcbiAgICogVHJ1ZSB3aGVuIHRoaXMgY2FsbCByZS1jb21wbGV0ZWQgYW4gYWxyZWFkeS1jbG9zZWQgc2xpY2UgZnJvbSBhIHR1cm5cbiAgICogc3VwZXJzZWRlZCBieSB0aW1lb3V0IHJlY292ZXJ5IG9yIGNhbmNlbGxhdGlvbi4gUmVzcG9uc2UgaXMgc2hhcGVkIGxpa2VcbiAgICogc3VjY2VzcyBzbyB0aGUgb3JwaGFuZWQgTExNIHRvb2wgY2FsbCB1bndpbmRzIGNsZWFubHkgd2l0aG91dCBtdXRhdGluZ1xuICAgKiBzdGF0ZS5cbiAgICovXG4gIGR1cGxpY2F0ZT86IGJvb2xlYW47XG4gIHN0YWxlPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBNYXAgYSBjb21wbGV0ZS1zbGljZS1vd25lZCBnYXRlIGlkIHRvIHRoZSBDb21wbGV0ZVNsaWNlUGFyYW1zIGZpZWxkXG4gKiB3aG9zZSBwcmVzZW5jZSBkcml2ZXMgYHBhc3NgIHZzLiBgb21pdHRlZGAuIEtlZXAgdGhpcyBpbiBsb2Nrc3RlcCB3aXRoXG4gKiB0aGUgZ2F0ZXMgZGVjbGFyZWQgaW4gZ2F0ZS1yZWdpc3RyeS50cyB1bmRlciBvd25lclR1cm4gXCJjb21wbGV0ZS1zbGljZVwiLlxuICovXG5mdW5jdGlvbiBzbGljZUdhdGVGaWVsZEZvcklkKFxuICBpZDogc3RyaW5nLFxuICBwYXJhbXM6IENvbXBsZXRlU2xpY2VQYXJhbXMsXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBzd2l0Y2ggKGlkKSB7XG4gICAgY2FzZSBcIlE4XCI6XG4gICAgICByZXR1cm4gcGFyYW1zLm9wZXJhdGlvbmFsUmVhZGluZXNzO1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG59XG5cbi8qKlxuICogUmVuZGVyIHNsaWNlIHN1bW1hcnkgbWFya2Rvd24gbWF0Y2hpbmcgdGhlIHRlbXBsYXRlIGZvcm1hdC5cbiAqIFlBTUwgZnJvbnRtYXR0ZXIgdXNlcyBzbmFrZV9jYXNlIGtleXMgZm9yIHBhcnNlU3VtbWFyeSgpIGNvbXBhdGliaWxpdHkuXG4gKi9cbmZ1bmN0aW9uIHJlbmRlclNsaWNlU3VtbWFyeU1hcmtkb3duKHBhcmFtczogQ29tcGxldGVTbGljZVBhcmFtcyk6IHN0cmluZyB7XG4gIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcblxuICAvLyBBcHBseSBkZWZhdWx0cyBmb3Igb3B0aW9uYWwgZW5yaWNobWVudCBhcnJheXMgKCMyNzcxKVxuICBjb25zdCBwcm92aWRlcyA9IHBhcmFtcy5wcm92aWRlcyA/PyBbXTtcbiAgY29uc3QgcmVxdWlyZXMgPSBwYXJhbXMucmVxdWlyZXMgPz8gW107XG4gIGNvbnN0IGFmZmVjdHMgPSBwYXJhbXMuYWZmZWN0cyA/PyBbXTtcbiAgY29uc3Qga2V5RmlsZXMgPSBwYXJhbXMua2V5RmlsZXMgPz8gW107XG4gIGNvbnN0IGtleURlY2lzaW9ucyA9IHBhcmFtcy5rZXlEZWNpc2lvbnMgPz8gW107XG4gIGNvbnN0IHBhdHRlcm5zRXN0YWJsaXNoZWQgPSBwYXJhbXMucGF0dGVybnNFc3RhYmxpc2hlZCA/PyBbXTtcbiAgY29uc3Qgb2JzZXJ2YWJpbGl0eVN1cmZhY2VzID0gcGFyYW1zLm9ic2VydmFiaWxpdHlTdXJmYWNlcyA/PyBbXTtcbiAgY29uc3QgZHJpbGxEb3duUGF0aHMgPSBwYXJhbXMuZHJpbGxEb3duUGF0aHMgPz8gW107XG4gIGNvbnN0IHJlcXVpcmVtZW50c0FkdmFuY2VkID0gcGFyYW1zLnJlcXVpcmVtZW50c0FkdmFuY2VkID8/IFtdO1xuICBjb25zdCByZXF1aXJlbWVudHNWYWxpZGF0ZWQgPSBwYXJhbXMucmVxdWlyZW1lbnRzVmFsaWRhdGVkID8/IFtdO1xuICBjb25zdCByZXF1aXJlbWVudHNTdXJmYWNlZCA9IHBhcmFtcy5yZXF1aXJlbWVudHNTdXJmYWNlZCA/PyBbXTtcbiAgY29uc3QgcmVxdWlyZW1lbnRzSW52YWxpZGF0ZWQgPSBwYXJhbXMucmVxdWlyZW1lbnRzSW52YWxpZGF0ZWQgPz8gW107XG4gIGNvbnN0IGZpbGVzTW9kaWZpZWQgPSBwYXJhbXMuZmlsZXNNb2RpZmllZCA/PyBbXTtcblxuICBjb25zdCBwcm92aWRlc1lhbWwgPSBwcm92aWRlcy5sZW5ndGggPiAwXG4gICAgPyBwcm92aWRlcy5tYXAocCA9PiBgICAtICR7cH1gKS5qb2luKFwiXFxuXCIpXG4gICAgOiBcIiAgLSAobm9uZSlcIjtcblxuICBjb25zdCByZXF1aXJlc1lhbWwgPSByZXF1aXJlcy5sZW5ndGggPiAwXG4gICAgPyByZXF1aXJlcy5tYXAociA9PiBgICAtIHNsaWNlOiAke3Iuc2xpY2V9XFxuICAgIHByb3ZpZGVzOiAke3IucHJvdmlkZXN9YCkuam9pbihcIlxcblwiKVxuICAgIDogXCIgIFtdXCI7XG5cbiAgY29uc3QgYWZmZWN0c1lhbWwgPSBhZmZlY3RzLmxlbmd0aCA+IDBcbiAgICA/IGFmZmVjdHMubWFwKGEgPT4gYCAgLSAke2F9YCkuam9pbihcIlxcblwiKVxuICAgIDogXCIgIFtdXCI7XG5cbiAgY29uc3Qga2V5RmlsZXNZYW1sID0ga2V5RmlsZXMubGVuZ3RoID4gMFxuICAgID8gYFxcbiR7a2V5RmlsZXMubWFwKGYgPT4gYCAgLSAke2Z9YCkuam9pbihcIlxcblwiKX1gXG4gICAgOiBcIiBbXVwiO1xuXG4gIGNvbnN0IGtleURlY2lzaW9uc1lhbWwgPSBrZXlEZWNpc2lvbnMubGVuZ3RoID4gMFxuICAgID8gYFxcbiR7a2V5RGVjaXNpb25zLm1hcChkID0+IGAgIC0gJHtkfWApLmpvaW4oXCJcXG5cIil9YFxuICAgIDogXCIgW11cIjtcblxuICBjb25zdCBwYXR0ZXJuc1lhbWwgPSBwYXR0ZXJuc0VzdGFibGlzaGVkLmxlbmd0aCA+IDBcbiAgICA/IHBhdHRlcm5zRXN0YWJsaXNoZWQubWFwKHAgPT4gYCAgLSAke3B9YCkuam9pbihcIlxcblwiKVxuICAgIDogXCIgIC0gKG5vbmUpXCI7XG5cbiAgY29uc3Qgb2JzZXJ2YWJpbGl0eVlhbWwgPSBvYnNlcnZhYmlsaXR5U3VyZmFjZXMubGVuZ3RoID4gMFxuICAgID8gb2JzZXJ2YWJpbGl0eVN1cmZhY2VzLm1hcChvID0+IGAgIC0gJHtvfWApLmpvaW4oXCJcXG5cIilcbiAgICA6IFwiICAtIG5vbmVcIjtcblxuICBjb25zdCBkcmlsbERvd25ZYW1sID0gZHJpbGxEb3duUGF0aHMubGVuZ3RoID4gMFxuICAgID8gZHJpbGxEb3duUGF0aHMubWFwKGQgPT4gYCAgLSAke2R9YCkuam9pbihcIlxcblwiKVxuICAgIDogXCIgIFtdXCI7XG5cbiAgLy8gUmVxdWlyZW1lbnRzIHNlY3Rpb25zXG4gIGNvbnN0IHJlcUFkdmFuY2VkID0gcmVxdWlyZW1lbnRzQWR2YW5jZWQubGVuZ3RoID4gMFxuICAgID8gcmVxdWlyZW1lbnRzQWR2YW5jZWQubWFwKHIgPT4gYC0gJHtyLmlkfSBcdTIwMTQgJHtyLmhvd31gKS5qb2luKFwiXFxuXCIpXG4gICAgOiBcIk5vbmUuXCI7XG5cbiAgY29uc3QgcmVxVmFsaWRhdGVkID0gcmVxdWlyZW1lbnRzVmFsaWRhdGVkLmxlbmd0aCA+IDBcbiAgICA/IHJlcXVpcmVtZW50c1ZhbGlkYXRlZC5tYXAociA9PiBgLSAke3IuaWR9IFx1MjAxNCAke3IucHJvb2Z9YCkuam9pbihcIlxcblwiKVxuICAgIDogXCJOb25lLlwiO1xuXG4gIGNvbnN0IHJlcVN1cmZhY2VkID0gcmVxdWlyZW1lbnRzU3VyZmFjZWQubGVuZ3RoID4gMFxuICAgID8gcmVxdWlyZW1lbnRzU3VyZmFjZWQubWFwKHIgPT4gYC0gJHtyfWApLmpvaW4oXCJcXG5cIilcbiAgICA6IFwiTm9uZS5cIjtcblxuICBjb25zdCByZXFJbnZhbGlkYXRlZCA9IHJlcXVpcmVtZW50c0ludmFsaWRhdGVkLmxlbmd0aCA+IDBcbiAgICA/IHJlcXVpcmVtZW50c0ludmFsaWRhdGVkLm1hcChyID0+IGAtICR7ci5pZH0gXHUyMDE0ICR7ci53aGF0fWApLmpvaW4oXCJcXG5cIilcbiAgICA6IFwiTm9uZS5cIjtcblxuICAvLyBGaWxlcyBtb2RpZmllZFxuICBjb25zdCBmaWxlc01vZCA9IGZpbGVzTW9kaWZpZWQubGVuZ3RoID4gMFxuICAgID8gZmlsZXNNb2RpZmllZC5tYXAoZiA9PiBgLSBcXGAke2YucGF0aH1cXGAgXHUyMDE0ICR7Zi5kZXNjcmlwdGlvbn1gKS5qb2luKFwiXFxuXCIpXG4gICAgOiBcIk5vbmUuXCI7XG5cbiAgcmV0dXJuIGAtLS1cbmlkOiAke3BhcmFtcy5zbGljZUlkfVxucGFyZW50OiAke3BhcmFtcy5taWxlc3RvbmVJZH1cbm1pbGVzdG9uZTogJHtwYXJhbXMubWlsZXN0b25lSWR9XG5wcm92aWRlczpcbiR7cHJvdmlkZXNZYW1sfVxucmVxdWlyZXM6XG4ke3JlcXVpcmVzWWFtbH1cbmFmZmVjdHM6XG4ke2FmZmVjdHNZYW1sfVxua2V5X2ZpbGVzOiR7a2V5RmlsZXNZYW1sfVxua2V5X2RlY2lzaW9uczoke2tleURlY2lzaW9uc1lhbWx9XG5wYXR0ZXJuc19lc3RhYmxpc2hlZDpcbiR7cGF0dGVybnNZYW1sfVxub2JzZXJ2YWJpbGl0eV9zdXJmYWNlczpcbiR7b2JzZXJ2YWJpbGl0eVlhbWx9XG5kcmlsbF9kb3duX3BhdGhzOlxuJHtkcmlsbERvd25ZYW1sfVxuZHVyYXRpb246IFwiXCJcbnZlcmlmaWNhdGlvbl9yZXN1bHQ6IHBhc3NlZFxuY29tcGxldGVkX2F0OiAke25vd31cbmJsb2NrZXJfZGlzY292ZXJlZDogZmFsc2Vcbi0tLVxuXG4jICR7cGFyYW1zLnNsaWNlSWR9OiAke3BhcmFtcy5zbGljZVRpdGxlfVxuXG4qKiR7cGFyYW1zLm9uZUxpbmVyfSoqXG5cbiMjIFdoYXQgSGFwcGVuZWRcblxuJHtwYXJhbXMubmFycmF0aXZlfVxuXG4jIyBWZXJpZmljYXRpb25cblxuJHtwYXJhbXMudmVyaWZpY2F0aW9ufVxuXG4jIyBSZXF1aXJlbWVudHMgQWR2YW5jZWRcblxuJHtyZXFBZHZhbmNlZH1cblxuIyMgUmVxdWlyZW1lbnRzIFZhbGlkYXRlZFxuXG4ke3JlcVZhbGlkYXRlZH1cblxuIyMgTmV3IFJlcXVpcmVtZW50cyBTdXJmYWNlZFxuXG4ke3JlcVN1cmZhY2VkfVxuXG4jIyBSZXF1aXJlbWVudHMgSW52YWxpZGF0ZWQgb3IgUmUtc2NvcGVkXG5cbiR7cmVxSW52YWxpZGF0ZWR9XG5cbiMjIE9wZXJhdGlvbmFsIFJlYWRpbmVzc1xuXG4ke3BhcmFtcy5vcGVyYXRpb25hbFJlYWRpbmVzcz8udHJpbSgpIHx8IFwiTm9uZS5cIn1cblxuIyMgRGV2aWF0aW9uc1xuXG4ke3BhcmFtcy5kZXZpYXRpb25zIHx8IFwiTm9uZS5cIn1cblxuIyMgS25vd24gTGltaXRhdGlvbnNcblxuJHtwYXJhbXMua25vd25MaW1pdGF0aW9ucyB8fCBcIk5vbmUuXCJ9XG5cbiMjIEZvbGxvdy11cHNcblxuJHtwYXJhbXMuZm9sbG93VXBzIHx8IFwiTm9uZS5cIn1cblxuIyMgRmlsZXMgQ3JlYXRlZC9Nb2RpZmllZFxuXG4ke2ZpbGVzTW9kfVxuYDtcbn1cblxuLyoqXG4gKiBSZW5kZXIgVUFUIG1hcmtkb3duIG1hdGNoaW5nIHRoZSB0ZW1wbGF0ZSBmb3JtYXQuXG4gKi9cbmZ1bmN0aW9uIHJlbmRlclVhdE1hcmtkb3duKHBhcmFtczogQ29tcGxldGVTbGljZVBhcmFtcyk6IHN0cmluZyB7XG4gIHJldHVybiBgIyAke3BhcmFtcy5zbGljZUlkfTogJHtwYXJhbXMuc2xpY2VUaXRsZX0gXHUyMDE0IFVBVFxuXG4qKk1pbGVzdG9uZToqKiAke3BhcmFtcy5taWxlc3RvbmVJZH1cbioqV3JpdHRlbjoqKiAke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKX1cblxuJHtwYXJhbXMudWF0Q29udGVudH1cbmA7XG59XG5cbi8qKlxuICogSGFuZGxlIHRoZSBjb21wbGV0ZV9zbGljZSBvcGVyYXRpb24gZW5kLXRvLWVuZC5cbiAqXG4gKiAxLiBWYWxpZGF0ZSByZXF1aXJlZCBmaWVsZHNcbiAqIDIuIFZlcmlmeSBhbGwgdGFza3MgYXJlIGNvbXBsZXRlXG4gKiAzLiBXcml0ZSBEQiBpbiBhIHRyYW5zYWN0aW9uIChtaWxlc3RvbmUsIHNsaWNlIHVwc2VydCwgc3RhdHVzIHVwZGF0ZSlcbiAqIDQuIFJlbmRlciBTVU1NQVJZLm1kICsgVUFULm1kIHRvIGRpc2tcbiAqIDUuIFRvZ2dsZSByb2FkbWFwIGNoZWNrYm94XG4gKiA2LiBTdG9yZSByZW5kZXJlZCBtYXJrZG93biBiYWNrIGluIERCIChmb3IgRDAwNCByZWNvdmVyeSlcbiAqIDcuIEludmFsaWRhdGUgY2FjaGVzXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVDb21wbGV0ZVNsaWNlKFxuICBwYXJhbXM6IENvbXBsZXRlU2xpY2VQYXJhbXMsXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPENvbXBsZXRlU2xpY2VSZXN1bHQgfCB7IGVycm9yOiBzdHJpbmcgfT4ge1xuICAvLyBcdTI1MDBcdTI1MDAgVmFsaWRhdGUgcmVxdWlyZWQgZmllbGRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAoIXBhcmFtcy5zbGljZUlkIHx8IHR5cGVvZiBwYXJhbXMuc2xpY2VJZCAhPT0gXCJzdHJpbmdcIiB8fCBwYXJhbXMuc2xpY2VJZC50cmltKCkgPT09IFwiXCIpIHtcbiAgICByZXR1cm4geyBlcnJvcjogXCJzbGljZUlkIGlzIHJlcXVpcmVkIGFuZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZ1wiIH07XG4gIH1cbiAgaWYgKCFwYXJhbXMubWlsZXN0b25lSWQgfHwgdHlwZW9mIHBhcmFtcy5taWxlc3RvbmVJZCAhPT0gXCJzdHJpbmdcIiB8fCBwYXJhbXMubWlsZXN0b25lSWQudHJpbSgpID09PSBcIlwiKSB7XG4gICAgcmV0dXJuIHsgZXJyb3I6IFwibWlsZXN0b25lSWQgaXMgcmVxdWlyZWQgYW5kIG11c3QgYmUgYSBub24tZW1wdHkgc3RyaW5nXCIgfTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBPd25lcnNoaXAgY2hlY2sgKG9wdC1pbjogb25seSBlbmZvcmNlZCB3aGVuIGNsYWltIGZpbGUgZXhpc3RzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3Qgb3duZXJzaGlwRXJyID0gY2hlY2tPd25lcnNoaXAoXG4gICAgYmFzZVBhdGgsXG4gICAgc2xpY2VVbml0S2V5KHBhcmFtcy5taWxlc3RvbmVJZCwgcGFyYW1zLnNsaWNlSWQpLFxuICAgIHBhcmFtcy5hY3Rvck5hbWUsXG4gICk7XG4gIGlmIChvd25lcnNoaXBFcnIpIHtcbiAgICByZXR1cm4geyBlcnJvcjogb3duZXJzaGlwRXJyIH07XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgVmVyaWZpY2F0aW9uIGNvbnRlbnQgZ2F0ZSAoIzM1ODApIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBSZWplY3QgY29tcGxldGlvbiB3aGVuIHRoZSBwcm92aWRlZCB2ZXJpZmljYXRpb24vVUFUIGNsZWFybHkgaW5kaWNhdGVzXG4gIC8vIHRoZSBzbGljZSBpcyBibG9ja2VkIG9yIGZhaWxlZC4gUHJldmVudHMgcHJvbXB0IHJlZ3Jlc3Npb25zIGZyb21cbiAgLy8gc2lsZW50bHkgYWR2YW5jaW5nIGJsb2NrZWQgc2xpY2VzLlxuICBjb25zdCBCTE9DS0VEX1NJR05BTFMgPSAvXFxiKHN0YXR1czpcXHMqYmxvY2tlZHx2ZXJpZmljYXRpb25fcmVzdWx0OlxccypmYWlsZWR8c2xpY2UgaXMgYmxvY2tlZHxjYW5ub3QgY29tcGxldGV8dmVyaWZpY2F0aW9uIGZhaWxlZClcXGIvaTtcbiAgaWYgKEJMT0NLRURfU0lHTkFMUy50ZXN0KHBhcmFtcy52ZXJpZmljYXRpb24gfHwgXCJcIikgfHwgQkxPQ0tFRF9TSUdOQUxTLnRlc3QocGFyYW1zLnVhdENvbnRlbnQgfHwgXCJcIikpIHtcbiAgICByZXR1cm4geyBlcnJvcjogYHNsaWNlIHZlcmlmaWNhdGlvbiBpbmRpY2F0ZXMgYmxvY2tlZC9mYWlsZWQgc3RhdGUgXHUyMDE0IGRvIG5vdCBjb21wbGV0ZSBhIHNsaWNlIHRoYXQgaGFzIG5vdCBwYXNzZWQgdmVyaWZpY2F0aW9uLiBBZGRyZXNzIHRoZSBibG9ja2VycyBhbmQgcmUtdmVyaWZ5IGZpcnN0LmAgfTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBHdWFyZHMgKyBEQiB3cml0ZXMgaW5zaWRlIGEgc2luZ2xlIHRyYW5zYWN0aW9uIChwcmV2ZW50cyBUT0NUT1UpIFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBjb21wbGV0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgbGV0IGd1YXJkRXJyb3I6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4gIHRyYW5zYWN0aW9uKCgpID0+IHtcbiAgICAvLyBTdGF0ZSBtYWNoaW5lIHByZWNvbmRpdGlvbnMgKGluc2lkZSB0eG4gZm9yIGF0b21pY2l0eSkuXG4gICAgLy8gTWlsZXN0b25lL3NsaWNlIG5vdCBleGlzdGluZyBpcyBPSyBcdTIwMTQgaW5zZXJ0TWlsZXN0b25lL2luc2VydFNsaWNlIGJlbG93IHdpbGwgYXV0by1jcmVhdGUuXG4gICAgLy8gT25seSBibG9jayBpZiB0aGV5IGV4aXN0IGFuZCBhcmUgY2xvc2VkLlxuICAgIGNvbnN0IG1pbGVzdG9uZSA9IGdldE1pbGVzdG9uZShwYXJhbXMubWlsZXN0b25lSWQpO1xuICAgIGlmIChtaWxlc3RvbmUgJiYgaXNDbG9zZWRTdGF0dXMobWlsZXN0b25lLnN0YXR1cykpIHtcbiAgICAgIGd1YXJkRXJyb3IgPSBgY2Fubm90IGNvbXBsZXRlIHNsaWNlIGluIGEgY2xvc2VkIG1pbGVzdG9uZTogJHtwYXJhbXMubWlsZXN0b25lSWR9IChzdGF0dXM6ICR7bWlsZXN0b25lLnN0YXR1c30pYDtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBzbGljZSA9IGdldFNsaWNlKHBhcmFtcy5taWxlc3RvbmVJZCwgcGFyYW1zLnNsaWNlSWQpO1xuICAgIGlmIChzbGljZSAmJiBpc0Nsb3NlZFN0YXR1cyhzbGljZS5zdGF0dXMpKSB7XG4gICAgICBpZiAoaXNTdGFsZVdyaXRlKFwiY29tcGxldGUtc2xpY2VcIikpIHtcbiAgICAgICAgZ3VhcmRFcnJvciA9IFwiX19zdGFsZV9kdXBsaWNhdGVfX1wiO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBndWFyZEVycm9yID0gYHNsaWNlICR7cGFyYW1zLnNsaWNlSWR9IGlzIGFscmVhZHkgY29tcGxldGUgXHUyMDE0IHVzZSBnc2Rfc2xpY2VfcmVvcGVuIGZpcnN0IGlmIHlvdSBuZWVkIHRvIHJlZG8gaXRgO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFZlcmlmeSBhbGwgdGFza3MgYXJlIGNvbXBsZXRlXG4gICAgY29uc3QgdGFza3MgPSBnZXRTbGljZVRhc2tzKHBhcmFtcy5taWxlc3RvbmVJZCwgcGFyYW1zLnNsaWNlSWQpO1xuICAgIGlmICh0YXNrcy5sZW5ndGggPT09IDApIHtcbiAgICAgIGd1YXJkRXJyb3IgPSBgbm8gdGFza3MgZm91bmQgZm9yIHNsaWNlICR7cGFyYW1zLnNsaWNlSWR9IGluIG1pbGVzdG9uZSAke3BhcmFtcy5taWxlc3RvbmVJZH1gO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGluY29tcGxldGVUYXNrcyA9IHRhc2tzLmZpbHRlcih0ID0+ICFpc0Nsb3NlZFN0YXR1cyh0LnN0YXR1cykpO1xuICAgIGlmIChpbmNvbXBsZXRlVGFza3MubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgaW5jb21wbGV0ZUlkcyA9IGluY29tcGxldGVUYXNrcy5tYXAodCA9PiBgJHt0LmlkfSAoc3RhdHVzOiAke3Quc3RhdHVzfSlgKS5qb2luKFwiLCBcIik7XG4gICAgICBndWFyZEVycm9yID0gYGluY29tcGxldGUgdGFza3M6ICR7aW5jb21wbGV0ZUlkc31gO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEFsbCBndWFyZHMgcGFzc2VkIFx1MjAxNCBwZXJmb3JtIHdyaXRlc1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBwYXJhbXMubWlsZXN0b25lSWQsIHRpdGxlOiBwYXJhbXMubWlsZXN0b25lSWQgfSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogcGFyYW1zLnNsaWNlSWQsIG1pbGVzdG9uZUlkOiBwYXJhbXMubWlsZXN0b25lSWQsIHRpdGxlOiBwYXJhbXMuc2xpY2VJZCB9KTtcbiAgICB1cGRhdGVTbGljZVN0YXR1cyhwYXJhbXMubWlsZXN0b25lSWQsIHBhcmFtcy5zbGljZUlkLCBcImNvbXBsZXRlXCIsIGNvbXBsZXRlZEF0KTtcbiAgfSk7XG5cbiAgaWYgKGd1YXJkRXJyb3IgPT09IFwiX19zdGFsZV9kdXBsaWNhdGVfX1wiKSB7XG4gICAgLy8gU3RhbGUgZHVwbGljYXRlIGZyb20gYSB0dXJuIHN1cGVyc2VkZWQgYnkgdGltZW91dCByZWNvdmVyeS4gUmV0dXJuIGFcbiAgICAvLyBub24tbXV0YXRpbmcgc3VjY2VzcyBzbyB0aGUgb3JwaGFuZWQgTExNIHRvb2wgY2FsbCB1bndpbmRzIHF1aWV0bHkuXG4gICAgY29uc3Qgc2xpY2VEaXIgPSByZXNvbHZlU2xpY2VQYXRoKGJhc2VQYXRoLCBwYXJhbXMubWlsZXN0b25lSWQsIHBhcmFtcy5zbGljZUlkKTtcbiAgICBjb25zdCBzdGFsZVN1bW1hcnlQYXRoID0gc2xpY2VEaXJcbiAgICAgID8gam9pbihzbGljZURpciwgYCR7cGFyYW1zLnNsaWNlSWR9LVNVTU1BUlkubWRgKVxuICAgICAgOiBqb2luKFxuICAgICAgICAgIGJhc2VQYXRoLFxuICAgICAgICAgIFwiLmdzZFwiLFxuICAgICAgICAgIFwibWlsZXN0b25lc1wiLFxuICAgICAgICAgIHBhcmFtcy5taWxlc3RvbmVJZCxcbiAgICAgICAgICBcInNsaWNlc1wiLFxuICAgICAgICAgIHBhcmFtcy5zbGljZUlkLFxuICAgICAgICAgIGAke3BhcmFtcy5zbGljZUlkfS1TVU1NQVJZLm1kYCxcbiAgICAgICAgKTtcbiAgICByZXR1cm4ge1xuICAgICAgc2xpY2VJZDogcGFyYW1zLnNsaWNlSWQsXG4gICAgICBtaWxlc3RvbmVJZDogcGFyYW1zLm1pbGVzdG9uZUlkLFxuICAgICAgc3VtbWFyeVBhdGg6IHN0YWxlU3VtbWFyeVBhdGgsXG4gICAgICB1YXRQYXRoOiBzdGFsZVN1bW1hcnlQYXRoLnJlcGxhY2UoLy1TVU1NQVJZXFwubWQkLywgXCItVUFULm1kXCIpLFxuICAgICAgZHVwbGljYXRlOiB0cnVlLFxuICAgICAgc3RhbGU6IHRydWUsXG4gICAgfTtcbiAgfVxuXG4gIGlmIChndWFyZEVycm9yKSB7XG4gICAgcmV0dXJuIHsgZXJyb3I6IGd1YXJkRXJyb3IgfTtcbiAgfVxuXG4gIC8vIFJlbmRlciBzdW1tYXJ5IG1hcmtkb3duXG4gIGNvbnN0IHN1bW1hcnlNZCA9IHJlbmRlclNsaWNlU3VtbWFyeU1hcmtkb3duKHBhcmFtcyk7XG5cbiAgLy8gUmVzb2x2ZSBhbmQgd3JpdGUgc3VtbWFyeSB0byBkaXNrXG4gIGxldCBzdW1tYXJ5UGF0aDogc3RyaW5nO1xuICBjb25zdCBzbGljZURpciA9IHJlc29sdmVTbGljZVBhdGgoYmFzZVBhdGgsIHBhcmFtcy5taWxlc3RvbmVJZCwgcGFyYW1zLnNsaWNlSWQpO1xuICBpZiAoc2xpY2VEaXIpIHtcbiAgICBzdW1tYXJ5UGF0aCA9IGpvaW4oc2xpY2VEaXIsIGAke3BhcmFtcy5zbGljZUlkfS1TVU1NQVJZLm1kYCk7XG4gIH0gZWxzZSB7XG4gICAgLy8gU2xpY2UgZGlyIGRvZXNuJ3QgZXhpc3Qgb24gZGlzayB5ZXQgXHUyMDE0IGJ1aWxkIHBhdGggbWFudWFsbHkgYW5kIGVuc3VyZSBkaXJzXG4gICAgY29uc3QgZ3NkRGlyID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIpO1xuICAgIGNvbnN0IG1hbnVhbFNsaWNlRGlyID0gam9pbihnc2REaXIsIFwibWlsZXN0b25lc1wiLCBwYXJhbXMubWlsZXN0b25lSWQsIFwic2xpY2VzXCIsIHBhcmFtcy5zbGljZUlkKTtcbiAgICBta2RpclN5bmMobWFudWFsU2xpY2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHN1bW1hcnlQYXRoID0gam9pbihtYW51YWxTbGljZURpciwgYCR7cGFyYW1zLnNsaWNlSWR9LVNVTU1BUlkubWRgKTtcbiAgfVxuXG4gIGNvbnN0IHVhdE1kID0gcmVuZGVyVWF0TWFya2Rvd24ocGFyYW1zKTtcbiAgY29uc3QgdWF0UGF0aCA9IHN1bW1hcnlQYXRoLnJlcGxhY2UoLy1TVU1NQVJZXFwubWQkLywgXCItVUFULm1kXCIpO1xuICBzZXRTbGljZVN1bW1hcnlNZChwYXJhbXMubWlsZXN0b25lSWQsIHBhcmFtcy5zbGljZUlkLCBzdW1tYXJ5TWQsIHVhdE1kKTtcbiAgbGV0IHByb2plY3Rpb25TdGFsZSA9IGZhbHNlO1xuXG4gIHRyeSB7XG4gICAgYXdhaXQgc2F2ZUZpbGUoc3VtbWFyeVBhdGgsIHN1bW1hcnlNZCk7XG4gICAgYXdhaXQgc2F2ZUZpbGUodWF0UGF0aCwgdWF0TWQpO1xuXG4gICAgLy8gVG9nZ2xlIHJvYWRtYXAgY2hlY2tib3ggdmlhIHJlbmRlcmVyIG1vZHVsZVxuICAgIGNvbnN0IHJvYWRtYXBUb2dnbGVkID0gYXdhaXQgcmVuZGVyUm9hZG1hcENoZWNrYm94ZXMoYmFzZVBhdGgsIHBhcmFtcy5taWxlc3RvbmVJZCk7XG4gICAgaWYgKCFyb2FkbWFwVG9nZ2xlZCkge1xuICAgICAgbG9nV2FybmluZyhcInRvb2xcIiwgYGNvbXBsZXRlX3NsaWNlIFx1MjAxNCBjb3VsZCBub3QgZmluZCByb2FkbWFwIGZvciAke3BhcmFtcy5taWxlc3RvbmVJZH0sIHNraXBwaW5nIGNoZWNrYm94IHRvZ2dsZWApO1xuICAgIH1cbiAgfSBjYXRjaCAocmVuZGVyRXJyKSB7XG4gICAgcHJvamVjdGlvblN0YWxlID0gdHJ1ZTtcbiAgICBsb2dXYXJuaW5nKFwicHJvamVjdGlvblwiLCBgY29tcGxldGVfc2xpY2UgcHJvamVjdGlvbiB3cml0ZSBmYWlsZWQgZm9yICR7cGFyYW1zLm1pbGVzdG9uZUlkfS8ke3BhcmFtcy5zbGljZUlkfTsgREIgY29tcGxldGlvbiByZW1haW5zIGNvbW1pdHRlZGAsIHsgZXJyb3I6IChyZW5kZXJFcnIgYXMgRXJyb3IpLm1lc3NhZ2UgfSk7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgQ2xvc2UgZ2F0ZXMgb3duZWQgYnkgY29tcGxldGUtc2xpY2UgKFE4KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gRWFjaCBvd25lZCBnYXRlIG1hcHMgdG8gYSBzcGVjaWZpYyBzdW1tYXJ5IHNlY3Rpb24gdmlhIHRoZSByZWdpc3RyeS5cbiAgLy8gSWYgdGhlIGNhbGxlciBwb3B1bGF0ZWQgdGhlIGNvcnJlc3BvbmRpbmcgZmllbGQsIHJlY29yZCBgcGFzc2A7IGlmIHRoZVxuICAvLyBmaWVsZCBpcyBlbXB0eSwgcmVjb3JkIGBvbWl0dGVkYC4gV2l0aG91dCB0aGlzIGxvb3AsIFE4IHdvdWxkIHN0YXlcbiAgLy8gcGVuZGluZyBmb3JldmVyIGFuZCBibG9jayBmdXR1cmUgc3RhdGUgZGVyaXZhdGlvbiAoc2VlIGdhdGUtcmVnaXN0cnkpLlxuICB0cnkge1xuICAgIGNvbnN0IHBlbmRpbmdHYXRlcyA9IGdldFBlbmRpbmdHYXRlc0ZvclR1cm4oXG4gICAgICBwYXJhbXMubWlsZXN0b25lSWQsXG4gICAgICBwYXJhbXMuc2xpY2VJZCxcbiAgICAgIFwiY29tcGxldGUtc2xpY2VcIixcbiAgICApO1xuICAgIGlmIChwZW5kaW5nR2F0ZXMubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3Qgb3duZWREZWZzID0gbmV3IE1hcChnZXRHYXRlc0ZvclR1cm4oXCJjb21wbGV0ZS1zbGljZVwiKS5tYXAoKGcpID0+IFtnLmlkLCBnXSBhcyBjb25zdCkpO1xuICAgICAgZm9yIChjb25zdCByb3cgb2YgcGVuZGluZ0dhdGVzKSB7XG4gICAgICAgIGNvbnN0IGRlZiA9IG93bmVkRGVmcy5nZXQocm93LmdhdGVfaWQpO1xuICAgICAgICBpZiAoIWRlZikgY29udGludWU7XG4gICAgICAgIC8vIE1hcCBnYXRlIGlkIFx1MjE5MiBwYXJhbSBmaWVsZCBpdCBtYXBzIHRvLiBLZWVwIHRoZSBtYXAgbG9jYWwgc29cbiAgICAgICAgLy8gYWRkaW5nIGEgbmV3IGNvbXBsZXRlLXNsaWNlIGdhdGUgaXMgYSBzaW5nbGUgcGxhY2UgY2hhbmdlLlxuICAgICAgICBjb25zdCBmaWVsZCA9IHNsaWNlR2F0ZUZpZWxkRm9ySWQoZGVmLmlkLCBwYXJhbXMpO1xuICAgICAgICBjb25zdCBoYXNDb250ZW50ID0gdHlwZW9mIGZpZWxkID09PSBcInN0cmluZ1wiICYmIGZpZWxkLnRyaW0oKS5sZW5ndGggPiAwO1xuICAgICAgICBzYXZlR2F0ZVJlc3VsdCh7XG4gICAgICAgICAgbWlsZXN0b25lSWQ6IHBhcmFtcy5taWxlc3RvbmVJZCxcbiAgICAgICAgICBzbGljZUlkOiBwYXJhbXMuc2xpY2VJZCxcbiAgICAgICAgICBnYXRlSWQ6IGRlZi5pZCxcbiAgICAgICAgICB2ZXJkaWN0OiBoYXNDb250ZW50ID8gXCJwYXNzXCIgOiBcIm9taXR0ZWRcIixcbiAgICAgICAgICByYXRpb25hbGU6IGhhc0NvbnRlbnRcbiAgICAgICAgICAgID8gYCR7ZGVmLnByb21wdFNlY3Rpb259IHNlY3Rpb24gcG9wdWxhdGVkIGluIHNsaWNlIHN1bW1hcnlgXG4gICAgICAgICAgICA6IGAke2RlZi5wcm9tcHRTZWN0aW9ufSBzZWN0aW9uIGxlZnQgZW1wdHkgXHUyMDE0IHJlY29yZGVkIGFzIG9taXR0ZWRgLFxuICAgICAgICAgIGZpbmRpbmdzOiBoYXNDb250ZW50ID8gKGZpZWxkIGFzIHN0cmluZykudHJpbSgpIDogXCJcIixcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIChnYXRlRXJyKSB7XG4gICAgbG9nV2FybmluZyhcbiAgICAgIFwidG9vbFwiLFxuICAgICAgYGNvbXBsZXRlLXNsaWNlIGdhdGUgY2xvc2Ugd2FybmluZyBmb3IgJHtwYXJhbXMubWlsZXN0b25lSWR9LyR7cGFyYW1zLnNsaWNlSWR9OiAkeyhnYXRlRXJyIGFzIEVycm9yKS5tZXNzYWdlfWAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIEludmFsaWRhdGUgYWxsIGNhY2hlc1xuICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICBjbGVhclBhdGhDYWNoZSgpO1xuICBjbGVhclBhcnNlQ2FjaGUoKTtcblxuICAvLyBcdTI1MDBcdTI1MDAgUG9zdC1tdXRhdGlvbiBob29rOiBwcm9qZWN0aW9ucywgbWFuaWZlc3QsIGV2ZW50IGxvZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gU2VwYXJhdGUgdHJ5L2NhdGNoIHBlciBzdGVwIHNvIGEgcHJvamVjdGlvbiBmYWlsdXJlIGRvZXNuJ3QgcHJldmVudFxuICAvLyB0aGUgZXZlbnQgbG9nIGVudHJ5IChjcml0aWNhbCBmb3Igd29ya3RyZWUgcmVjb25jaWxpYXRpb24pLlxuICB0cnkge1xuICAgIGF3YWl0IHJlbmRlckFsbFByb2plY3Rpb25zKGJhc2VQYXRoLCBwYXJhbXMubWlsZXN0b25lSWQpO1xuICB9IGNhdGNoIChwcm9qRXJyKSB7XG4gICAgbG9nV2FybmluZyhcInRvb2xcIiwgYGNvbXBsZXRlLXNsaWNlIHByb2plY3Rpb24gd2FybmluZyBmb3IgJHtwYXJhbXMubWlsZXN0b25lSWR9LyR7cGFyYW1zLnNsaWNlSWR9OiAkeyhwcm9qRXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICB9XG4gIHRyeSB7XG4gICAgd3JpdGVNYW5pZmVzdChiYXNlUGF0aCk7XG4gIH0gY2F0Y2ggKG1mRXJyKSB7XG4gICAgbG9nV2FybmluZyhcInRvb2xcIiwgYGNvbXBsZXRlLXNsaWNlIG1hbmlmZXN0IHdhcm5pbmc6ICR7KG1mRXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICB9XG4gIHRyeSB7XG4gICAgYXBwZW5kRXZlbnQoYmFzZVBhdGgsIHtcbiAgICAgIGNtZDogXCJjb21wbGV0ZS1zbGljZVwiLFxuICAgICAgcGFyYW1zOiB7IG1pbGVzdG9uZUlkOiBwYXJhbXMubWlsZXN0b25lSWQsIHNsaWNlSWQ6IHBhcmFtcy5zbGljZUlkIH0sXG4gICAgICB0czogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgYWN0b3I6IFwiYWdlbnRcIixcbiAgICAgIGFjdG9yX25hbWU6IHBhcmFtcy5hY3Rvck5hbWUsXG4gICAgICB0cmlnZ2VyX3JlYXNvbjogcGFyYW1zLnRyaWdnZXJSZWFzb24sXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGV2ZW50RXJyKSB7XG4gICAgbG9nRXJyb3IoXCJ0b29sXCIsIGBjb21wbGV0ZS1zbGljZSBldmVudCBsb2cgRkFJTEVEIFx1MjAxNCBjb21wbGV0aW9uIGludmlzaWJsZSB0byByZWNvbmNpbGlhdGlvbmAsIHsgZXJyb3I6IChldmVudEVyciBhcyBFcnJvcikubWVzc2FnZSB9KTtcbiAgfVxuXG4gIC8vIEZpcmUtYW5kLWZvcmdldCBncmFwaCByZWJ1aWxkIFx1MjAxNCBtdXN0IE5PVCBhd2FpdCwgbXVzdCBOT1QgY3Jhc2ggc2xpY2UgY29tcGxldGlvbi5cbiAgLy8gRHluYW1pYyBpbXBvcnQgb2YgdGhlIHBhY2thZ2UgbmFtZSAobm90IGEgcmVsYXRpdmUgcGF0aCkgc28gaXQgcmVzb2x2ZXNcbiAgLy8gY29ycmVjdGx5IHZpYSBwYWNrYWdlLmpzb24jZXhwb3J0cyBpbiBib3RoIGRldmVsb3BtZW50IGFuZCBwcm9kdWN0aW9uLlxuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWZsb2F0aW5nLXByb21pc2VzXG4gIChhc3luYyAoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGdyYXBoTW9kID0gYXdhaXQgaW1wb3J0KFwiQGdzZC1idWlsZC9tY3Atc2VydmVyXCIpIGFzIHVua25vd24gYXMgUGFydGlhbDx7XG4gICAgICAgIGJ1aWxkR3JhcGg6IChkaXI6IHN0cmluZykgPT4gUHJvbWlzZTx7IG5vZGVzOiB1bmtub3duW107IGVkZ2VzOiB1bmtub3duW107IGJ1aWx0QXQ6IHN0cmluZyB9PjtcbiAgICAgICAgd3JpdGVHcmFwaDogKGdzZFJvb3Q6IHN0cmluZywgZ3JhcGg6IHVua25vd24pID0+IFByb21pc2U8dm9pZD47XG4gICAgICAgIHJlc29sdmVHc2RSb290OiAoYmFzZVBhdGg6IHN0cmluZykgPT4gc3RyaW5nO1xuICAgICAgfT47XG4gICAgICBpZiAoXG4gICAgICAgIHR5cGVvZiBncmFwaE1vZC5idWlsZEdyYXBoICE9PSBcImZ1bmN0aW9uXCJcbiAgICAgICAgfHwgdHlwZW9mIGdyYXBoTW9kLndyaXRlR3JhcGggIT09IFwiZnVuY3Rpb25cIlxuICAgICAgICB8fCB0eXBlb2YgZ3JhcGhNb2QucmVzb2x2ZUdzZFJvb3QgIT09IFwiZnVuY3Rpb25cIlxuICAgICAgKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImdyYXBoIGhlbHBlcnMgdW5hdmFpbGFibGUgZnJvbSBAZ3NkLWJ1aWxkL21jcC1zZXJ2ZXJcIik7XG4gICAgICB9XG4gICAgICBjb25zdCBnID0gYXdhaXQgZ3JhcGhNb2QuYnVpbGRHcmFwaChiYXNlUGF0aCk7XG4gICAgICBhd2FpdCBncmFwaE1vZC53cml0ZUdyYXBoKGdyYXBoTW9kLnJlc29sdmVHc2RSb290KGJhc2VQYXRoKSwgZyk7XG4gICAgfSBjYXRjaCAoZ3JhcGhFcnIpIHtcbiAgICAgIC8vIEdyYXBoIHJlYnVpbGQgaXMgYmVzdC1lZmZvcnQgXHUyMDE0IGxvZyBhdCB3YXJuaW5nIGxldmVsIGJ1dCBuZXZlciBwcm9wYWdhdGVcbiAgICAgIGxvZ1dhcm5pbmcoXCJ0b29sXCIsIGBjb21wbGV0ZS1zbGljZSBncmFwaCByZWJ1aWxkIGZhaWxlZCAobm9uLWZhdGFsKTogJHsoZ3JhcGhFcnIgYXMgRXJyb3IpLm1lc3NhZ2UgPz8gU3RyaW5nKGdyYXBoRXJyKX1gKTtcbiAgICB9XG4gIH0pKCk7XG5cbiAgcmV0dXJuIHtcbiAgICBzbGljZUlkOiBwYXJhbXMuc2xpY2VJZCxcbiAgICBtaWxlc3RvbmVJZDogcGFyYW1zLm1pbGVzdG9uZUlkLFxuICAgIHN1bW1hcnlQYXRoLFxuICAgIHVhdFBhdGgsXG4gICAgLi4uKHByb2plY3Rpb25TdGFsZSA/IHsgc3RhbGU6IHRydWUgfSA6IHt9KSxcbiAgfTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVVBLFNBQVMsWUFBWTtBQUNyQixTQUFTLGlCQUFpQjtBQUcxQixTQUFTLHNCQUFzQjtBQUMvQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyx1QkFBdUI7QUFDaEMsU0FBMkIsa0JBQWtCLHNCQUFzQjtBQUNuRSxTQUFTLGdCQUFnQixvQkFBb0I7QUFDN0MsU0FBUyxVQUFVLHVCQUF1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
