import { showNextAction } from "../shared/tui.js";
import { setQueuePhaseActive } from "./index.js";
import { loadFile } from "./files.js";
import { loadPrompt, inlineTemplate } from "./prompt-loader.js";
import { deriveState } from "./state.js";
import { invalidateAllCaches } from "./cache.js";
import {
  gsdRoot,
  resolveMilestoneFile,
  resolveGsdRootFile,
  relGsdRootFile
} from "./paths.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { atomicWriteSync } from "./atomic-write.js";
import { nativeAddPaths, nativeCommit } from "./native-git-bridge.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { saveQueueOrder } from "./queue-order.js";
import { findMilestoneIds, nextMilestoneId } from "./milestone-ids.js";
async function showQueue(ctx, pi, basePath) {
  const gsd = gsdRoot(basePath);
  if (!existsSync(gsd)) {
    ctx.ui.notify("No GSD project found. Run /gsd to start one first.", "warning");
    return;
  }
  const state = await deriveState(basePath);
  const milestoneIds = findMilestoneIds(basePath);
  if (milestoneIds.length === 0) {
    ctx.ui.notify("No milestones exist yet. Run /gsd to create the first one.", "warning");
    return;
  }
  const pendingMilestones = state.registry.filter(
    (m) => m.status === "pending" || m.status === "active"
  );
  const completeCount = state.registry.filter((m) => m.status === "complete").length;
  const parkedCount = state.registry.filter((m) => m.status === "parked").length;
  if (pendingMilestones.length > 1) {
    const summaryParts = [`${completeCount} complete, ${pendingMilestones.length} pending.`];
    if (parkedCount > 0) summaryParts.push(`${parkedCount} parked.`);
    const choice = await showNextAction(ctx, {
      title: "GSD \u2014 Queue Management",
      summary: summaryParts,
      actions: [
        {
          id: "reorder",
          label: "Reorder queue",
          description: `Change execution order of ${pendingMilestones.length} pending milestones.`,
          recommended: true
        },
        {
          id: "add",
          label: "Add new work",
          description: "Queue new milestones via discussion."
        }
      ],
      notYetMessage: "Run /gsd queue when ready."
    });
    if (choice === "reorder") {
      await handleQueueReorder(ctx, basePath, state);
      return;
    }
    if (choice === "not_yet") return;
  }
  await showQueueAdd(ctx, pi, basePath, state);
}
async function handleQueueReorder(ctx, basePath, state) {
  const { showQueueReorder: showReorderUI } = await import("./queue-reorder-ui.js");
  const completed = state.registry.filter((m) => m.status === "complete").map((m) => ({ id: m.id, title: m.title, dependsOn: m.dependsOn }));
  const pending = state.registry.filter((m) => m.status !== "complete" && m.status !== "parked").map((m) => ({ id: m.id, title: m.title, dependsOn: m.dependsOn }));
  const result = await showReorderUI(ctx, completed, pending);
  if (!result) {
    ctx.ui.notify("Queue reorder cancelled.", "info");
    return;
  }
  saveQueueOrder(basePath, result.order);
  invalidateAllCaches();
  if (result.depsToRemove.length > 0) {
    removeDependsOnFromContextFiles(basePath, result.depsToRemove);
  }
  syncProjectMdSequence(basePath, state.registry, result.order);
  const filesToAdd = [".gsd/QUEUE-ORDER.json", ".gsd/PROJECT.md"];
  for (const r of result.depsToRemove) {
    filesToAdd.push(`.gsd/milestones/${r.milestone}/${r.milestone}-CONTEXT.md`);
  }
  try {
    nativeAddPaths(basePath, filesToAdd);
    nativeCommit(basePath, "docs: reorder queue");
  } catch {
  }
  const depInfo = result.depsToRemove.length > 0 ? ` (removed ${result.depsToRemove.length} depends_on)` : "";
  ctx.ui.notify(`Queue reordered: ${result.order.join(" \u2192 ")}${depInfo}`, "info");
}
async function showQueueAdd(ctx, pi, basePath, state) {
  const milestoneIds = findMilestoneIds(basePath);
  const existingContext = await buildExistingMilestonesContext(basePath, milestoneIds, state);
  const uniqueEnabled = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
  const nextId = nextMilestoneId(milestoneIds, uniqueEnabled);
  const activePart = state.activeMilestone ? `Currently executing: ${state.activeMilestone.id} \u2014 ${state.activeMilestone.title} (phase: ${state.phase}).` : "No milestone currently active.";
  const pendingCount = state.registry.filter((m) => m.status === "pending").length;
  const completeCount = state.registry.filter((m) => m.status === "complete").length;
  const preamble = [
    `Queuing new work onto an existing GSD project.`,
    activePart,
    `${completeCount} milestone(s) complete, ${pendingCount} pending.`,
    `Next available milestone ID: ${nextId}.`
  ].join(" ");
  setQueuePhaseActive(true, basePath);
  const queueInlinedTemplates = inlineTemplate("context", "Context");
  const prompt = loadPrompt("queue", {
    preamble,
    existingMilestonesContext: existingContext,
    inlinedTemplates: queueInlinedTemplates,
    commitInstruction: "Do not commit planning artifacts \u2014 .gsd/ is managed externally."
  });
  pi.sendMessage(
    {
      customType: "gsd-queue",
      content: prompt,
      display: false
    },
    { triggerTurn: true }
  );
}
async function buildExistingMilestonesContext(basePath, milestoneIds, state) {
  const sections = [];
  const projectPath = resolveGsdRootFile(basePath, "PROJECT");
  if (existsSync(projectPath)) {
    const projectContent = await loadFile(projectPath);
    if (projectContent) {
      sections.push(`### Project Overview
Source: \`${relGsdRootFile("PROJECT")}\`

${projectContent.trim()}`);
    }
  }
  const decisionsPath = resolveGsdRootFile(basePath, "DECISIONS");
  if (existsSync(decisionsPath)) {
    const decisionsContent = await loadFile(decisionsPath);
    if (decisionsContent) {
      sections.push(`### Decisions Register
Source: \`${relGsdRootFile("DECISIONS")}\`

${decisionsContent.trim()}`);
    }
  }
  for (const mid of milestoneIds) {
    const registryEntry = state.registry.find((m) => m.id === mid);
    const status = registryEntry?.status ?? "unknown";
    const title = registryEntry?.title ?? mid;
    if (status === "complete") {
      sections.push(`### ${mid}: ${title}
**Status:** complete`);
      continue;
    }
    const parts = [];
    parts.push(`### ${mid}: ${title}
**Status:** ${status}`);
    const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
    if (contextFile) {
      const content = await loadFile(contextFile);
      if (content) {
        parts.push(`
**Context:**
${content.trim()}`);
      }
    } else {
      const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
      if (draftFile) {
        const draftContent = await loadFile(draftFile);
        if (draftContent) {
          parts.push(`
**Draft context available:**
${draftContent.trim()}`);
        }
      }
    }
    if (status === "active" || status === "pending" || status === "parked") {
      const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
      if (roadmapFile) {
        const content = await loadFile(roadmapFile);
        if (content) {
          parts.push(`
**Roadmap:**
${content.trim()}`);
        }
      }
    }
    sections.push(parts.join("\n"));
  }
  const queuePath = resolveGsdRootFile(basePath, "QUEUE");
  if (existsSync(queuePath)) {
    const queueContent = await loadFile(queuePath);
    if (queueContent) {
      sections.push(`### Previous Queue Entries
Source: \`${relGsdRootFile("QUEUE")}\`

${queueContent.trim()}`);
    }
  }
  return sections.join("\n\n---\n\n");
}
function removeDependsOnFromContextFiles(basePath, depsToRemove) {
  const byMilestone = /* @__PURE__ */ new Map();
  for (const { milestone, dep } of depsToRemove) {
    const existing = byMilestone.get(milestone) ?? [];
    existing.push(dep);
    byMilestone.set(milestone, existing);
  }
  for (const [mid, depsToRemoveForMid] of byMilestone) {
    const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
    if (!contextFile || !existsSync(contextFile)) continue;
    const content = readFileSync(contextFile, "utf-8");
    const trimmed = content.trimStart();
    if (!trimmed.startsWith("---")) continue;
    const afterFirst = trimmed.indexOf("\n");
    if (afterFirst === -1) continue;
    const rest = trimmed.slice(afterFirst + 1);
    const endIdx = rest.indexOf("\n---");
    if (endIdx === -1) continue;
    const fmText = rest.slice(0, endIdx);
    const body = rest.slice(endIdx + 4);
    const fmLines = fmText.split("\n");
    const removeSet = new Set(depsToRemoveForMid.map((d) => d.toUpperCase()));
    const inlineMatch = fmLines.findIndex((l) => /^depends_on:\s*\[/.test(l));
    if (inlineMatch >= 0) {
      const line = fmLines[inlineMatch];
      const inner = line.match(/\[([^\]]*)\]/);
      if (inner) {
        const remaining = inner[1].split(",").map((s) => s.trim()).filter((s) => s && !removeSet.has(s.toUpperCase()));
        if (remaining.length === 0) {
          fmLines.splice(inlineMatch, 1);
        } else {
          fmLines[inlineMatch] = `depends_on: [${remaining.join(", ")}]`;
        }
      }
    } else {
      const keyIdx = fmLines.findIndex((l) => /^depends_on:\s*$/.test(l));
      if (keyIdx >= 0) {
        let end = keyIdx + 1;
        while (end < fmLines.length && /^\s+-\s/.test(fmLines[end])) {
          const val = fmLines[end].replace(/^\s+-\s*/, "").trim().toUpperCase();
          if (removeSet.has(val)) {
            fmLines.splice(end, 1);
          } else {
            end++;
          }
        }
        if (end === keyIdx + 1 || end <= fmLines.length && !/^\s+-\s/.test(fmLines[keyIdx + 1] ?? "")) {
          fmLines.splice(keyIdx, 1);
        }
      }
    }
    const newFm = fmLines.filter((l) => l !== void 0).join("\n");
    const newContent = newFm.trim() ? `---
${newFm}
---${body}` : body.replace(/^\n+/, "");
    writeFileSync(contextFile, newContent, "utf-8");
  }
}
function syncProjectMdSequence(basePath, registry, newOrder) {
  const projectPath = resolveGsdRootFile(basePath, "PROJECT");
  if (!projectPath || !existsSync(projectPath)) return;
  const content = readFileSync(projectPath, "utf-8");
  const lines = content.split("\n");
  const headerIdx = lines.findIndex((l) => /^##\s+Milestone Sequence/.test(l));
  if (headerIdx < 0) return;
  let tableStart = headerIdx + 1;
  while (tableStart < lines.length && !lines[tableStart].startsWith("|")) tableStart++;
  if (tableStart >= lines.length) return;
  let tableEnd = tableStart + 1;
  while (tableEnd < lines.length && lines[tableEnd].startsWith("|")) tableEnd++;
  const registryMap = new Map(registry.map((m) => [m.id, m]));
  const completedSet = new Set(registry.filter((m) => m.status === "complete").map((m) => m.id));
  const newRows = [];
  for (const m of registry) {
    if (m.status === "complete") {
      newRows.push(`| ${m.id} | ${m.title} | \u2705 Complete |`);
    }
  }
  let isFirst = true;
  for (const id of newOrder) {
    if (completedSet.has(id)) continue;
    const m = registryMap.get(id);
    if (!m) continue;
    const status = isFirst ? "\u{1F4CB} Next" : "\u{1F4CB} Queued";
    newRows.push(`| ${m.id} | ${m.title} | ${status} |`);
    isFirst = false;
  }
  const headerLine = lines[tableStart];
  const separatorLine = lines[tableStart + 1];
  const newTable = [headerLine, separatorLine, ...newRows];
  lines.splice(tableStart, tableEnd - tableStart, ...newTable);
  atomicWriteSync(projectPath, lines.join("\n"), "utf-8");
}
export {
  buildExistingMilestonesContext,
  handleQueueReorder,
  showQueue,
  showQueueAdd
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9ndWlkZWQtZmxvdy1xdWV1ZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHU0QgUXVldWUgTWFuYWdlbWVudCBcdTIwMTQgc2hvd1F1ZXVlLCByZW9yZGVyLCBhZGQsIGFuZCBjb250ZXh0IGJ1aWxkZXIuXG4gKlxuICogU2VsZi1jb250YWluZWQgcXVldWUgVUkgZXh0cmFjdGVkIGZyb20gZ3VpZGVkLWZsb3cudHMuXG4gKiBTYWZlIHRvIHJ1biB3aGlsZSBhdXRvLW1vZGUgaXMgZXhlY3V0aW5nIFx1MjAxNCBvbmx5IHdyaXRlcyB0byBmdXR1cmUgbWlsZXN0b25lXG4gKiBkaXJlY3RvcmllcyAod2hpY2ggYXV0by1tb2RlIHdvbid0IHRvdWNoIHVudGlsIGl0IHJlYWNoZXMgdGhlbSkuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEksIEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBzaG93TmV4dEFjdGlvbiB9IGZyb20gXCIuLi9zaGFyZWQvdHVpLmpzXCI7XG5pbXBvcnQgeyBzZXRRdWV1ZVBoYXNlQWN0aXZlIH0gZnJvbSBcIi4vaW5kZXguanNcIjtcbmltcG9ydCB7IGxvYWRGaWxlIH0gZnJvbSBcIi4vZmlsZXMuanNcIjtcbmltcG9ydCB7IGxvYWRQcm9tcHQsIGlubGluZVRlbXBsYXRlIH0gZnJvbSBcIi4vcHJvbXB0LWxvYWRlci5qc1wiO1xuaW1wb3J0IHsgZGVyaXZlU3RhdGUgfSBmcm9tIFwiLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHsgaW52YWxpZGF0ZUFsbENhY2hlcyB9IGZyb20gXCIuL2NhY2hlLmpzXCI7XG5pbXBvcnQge1xuICBnc2RSb290LCByZXNvbHZlTWlsZXN0b25lRmlsZSwgcmVzb2x2ZVNsaWNlRmlsZSxcbiAgcmVzb2x2ZUdzZFJvb3RGaWxlLCByZWxHc2RSb290RmlsZSwgcmVsU2xpY2VGaWxlLFxufSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuaW1wb3J0IHsgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jLCBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGF0b21pY1dyaXRlU3luYyB9IGZyb20gXCIuL2F0b21pYy13cml0ZS5qc1wiO1xuaW1wb3J0IHsgbmF0aXZlQWRkUGF0aHMsIG5hdGl2ZUNvbW1pdCB9IGZyb20gXCIuL25hdGl2ZS1naXQtYnJpZGdlLmpzXCI7XG5pbXBvcnQgeyBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMgfSBmcm9tIFwiLi9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHsgbG9hZFF1ZXVlT3JkZXIsIHNvcnRCeVF1ZXVlT3JkZXIsIHNhdmVRdWV1ZU9yZGVyIH0gZnJvbSBcIi4vcXVldWUtb3JkZXIuanNcIjtcbmltcG9ydCB7IGZpbmRNaWxlc3RvbmVJZHMsIG5leHRNaWxlc3RvbmVJZCB9IGZyb20gXCIuL21pbGVzdG9uZS1pZHMuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFF1ZXVlIEVudHJ5IFBvaW50IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFF1ZXVlIGZ1dHVyZSBtaWxlc3RvbmVzIHZpYSBjb252ZXJzYXRpb25hbCBpbnRha2UuXG4gKlxuICogU2FmZSB0byBydW4gd2hpbGUgYXV0by1tb2RlIGlzIGV4ZWN1dGluZyBcdTIwMTQgb25seSB3cml0ZXMgdG8gZnV0dXJlIG1pbGVzdG9uZVxuICogZGlyZWN0b3JpZXMgKHdoaWNoIGF1dG8tbW9kZSB3b24ndCB0b3VjaCB1bnRpbCBpdCByZWFjaGVzIHRoZW0pIGFuZCBhcHBlbmRzXG4gKiB0byBwcm9qZWN0Lm1kIC8gcXVldWUubWQuXG4gKlxuICogVGhlIGZsb3c6XG4gKiAxLiBCdWlsZCBjb250ZXh0IGFib3V0IGFsbCBleGlzdGluZyBtaWxlc3RvbmVzIChjb21wbGV0ZSwgYWN0aXZlLCBwZW5kaW5nKVxuICogMi4gRGlzcGF0Y2ggdGhlIHF1ZXVlIHByb21wdCBcdTIwMTQgTExNIGRpc2N1c3NlcyB3aXRoIHRoZSB1c2VyLCBhc3Nlc3NlcyBzY29wZVxuICogMy4gTExNIHdyaXRlcyBDT05URVhULm1kIGZpbGVzIGZvciBuZXcgbWlsZXN0b25lcyAobm8gcm9hZG1hcHMgXHUyMDE0IEpJVClcbiAqIDQuIEF1dG8tbW9kZSBwaWNrcyB0aGVtIHVwIG5hdHVyYWxseSB3aGVuIGl0IGFkdmFuY2VzIHBhc3QgY3VycmVudCB3b3JrXG4gKlxuICogUm9vdCBkdXJhYmxlIGFydGlmYWN0cyB1c2UgdXBwZXJjYXNlIG5hbWVzIGxpa2UgUFJPSkVDVC5tZCBhbmQgUVVFVUUubWQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzaG93UXVldWUoXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIHBpOiBFeHRlbnNpb25BUEksXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgLy8gXHUyNTAwXHUyNTAwIEVuc3VyZSAuZ3NkLyBleGlzdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IGdzZCA9IGdzZFJvb3QoYmFzZVBhdGgpO1xuICBpZiAoIWV4aXN0c1N5bmMoZ3NkKSkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJObyBHU0QgcHJvamVjdCBmb3VuZC4gUnVuIC9nc2QgdG8gc3RhcnQgb25lIGZpcnN0LlwiLCBcIndhcm5pbmdcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlUGF0aCk7XG4gIGNvbnN0IG1pbGVzdG9uZUlkcyA9IGZpbmRNaWxlc3RvbmVJZHMoYmFzZVBhdGgpO1xuXG4gIGlmIChtaWxlc3RvbmVJZHMubGVuZ3RoID09PSAwKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIk5vIG1pbGVzdG9uZXMgZXhpc3QgeWV0LiBSdW4gL2dzZCB0byBjcmVhdGUgdGhlIGZpcnN0IG9uZS5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBDb3VudCBwZW5kaW5nIG1pbGVzdG9uZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IHBlbmRpbmdNaWxlc3RvbmVzID0gc3RhdGUucmVnaXN0cnkuZmlsdGVyKFxuICAgIG0gPT4gbS5zdGF0dXMgPT09IFwicGVuZGluZ1wiIHx8IG0uc3RhdHVzID09PSBcImFjdGl2ZVwiLFxuICApO1xuICBjb25zdCBjb21wbGV0ZUNvdW50ID0gc3RhdGUucmVnaXN0cnkuZmlsdGVyKG0gPT4gbS5zdGF0dXMgPT09IFwiY29tcGxldGVcIikubGVuZ3RoO1xuICBjb25zdCBwYXJrZWRDb3VudCA9IHN0YXRlLnJlZ2lzdHJ5LmZpbHRlcihtID0+IG0uc3RhdHVzID09PSBcInBhcmtlZFwiKS5sZW5ndGg7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIElmIG11bHRpcGxlIHBlbmRpbmcgbWlsZXN0b25lcywgc2hvdyBxdWV1ZSBtYW5hZ2VtZW50IGh1YiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHBlbmRpbmdNaWxlc3RvbmVzLmxlbmd0aCA+IDEpIHtcbiAgICBjb25zdCBzdW1tYXJ5UGFydHMgPSBbYCR7Y29tcGxldGVDb3VudH0gY29tcGxldGUsICR7cGVuZGluZ01pbGVzdG9uZXMubGVuZ3RofSBwZW5kaW5nLmBdO1xuICAgIGlmIChwYXJrZWRDb3VudCA+IDApIHN1bW1hcnlQYXJ0cy5wdXNoKGAke3BhcmtlZENvdW50fSBwYXJrZWQuYCk7XG5cbiAgICBjb25zdCBjaG9pY2UgPSBhd2FpdCBzaG93TmV4dEFjdGlvbihjdHgsIHtcbiAgICAgIHRpdGxlOiBcIkdTRCBcdTIwMTQgUXVldWUgTWFuYWdlbWVudFwiLFxuICAgICAgc3VtbWFyeTogc3VtbWFyeVBhcnRzLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwicmVvcmRlclwiLFxuICAgICAgICAgIGxhYmVsOiBcIlJlb3JkZXIgcXVldWVcIixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogYENoYW5nZSBleGVjdXRpb24gb3JkZXIgb2YgJHtwZW5kaW5nTWlsZXN0b25lcy5sZW5ndGh9IHBlbmRpbmcgbWlsZXN0b25lcy5gLFxuICAgICAgICAgIHJlY29tbWVuZGVkOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiYWRkXCIsXG4gICAgICAgICAgbGFiZWw6IFwiQWRkIG5ldyB3b3JrXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiUXVldWUgbmV3IG1pbGVzdG9uZXMgdmlhIGRpc2N1c3Npb24uXCIsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgbm90WWV0TWVzc2FnZTogXCJSdW4gL2dzZCBxdWV1ZSB3aGVuIHJlYWR5LlwiLFxuICAgIH0pO1xuXG4gICAgaWYgKGNob2ljZSA9PT0gXCJyZW9yZGVyXCIpIHtcbiAgICAgIGF3YWl0IGhhbmRsZVF1ZXVlUmVvcmRlcihjdHgsIGJhc2VQYXRoLCBzdGF0ZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChjaG9pY2UgPT09IFwibm90X3lldFwiKSByZXR1cm47XG4gICAgLy8gXCJhZGRcIiBmYWxscyB0aHJvdWdoIHRvIGV4aXN0aW5nIHF1ZXVlLWFkZCBsb2dpYyBiZWxvd1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEV4aXN0aW5nIHF1ZXVlLWFkZCBmbG93IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBhd2FpdCBzaG93UXVldWVBZGQoY3R4LCBwaSwgYmFzZVBhdGgsIHN0YXRlKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJlb3JkZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVRdWV1ZVJlb3JkZXIoXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIHN0YXRlOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIGRlcml2ZVN0YXRlPj4sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgeyBzaG93UXVldWVSZW9yZGVyOiBzaG93UmVvcmRlclVJIH0gPSBhd2FpdCBpbXBvcnQoXCIuL3F1ZXVlLXJlb3JkZXItdWkuanNcIik7XG5cbiAgY29uc3QgY29tcGxldGVkID0gc3RhdGUucmVnaXN0cnlcbiAgICAuZmlsdGVyKG0gPT4gbS5zdGF0dXMgPT09IFwiY29tcGxldGVcIilcbiAgICAubWFwKG0gPT4gKHsgaWQ6IG0uaWQsIHRpdGxlOiBtLnRpdGxlLCBkZXBlbmRzT246IG0uZGVwZW5kc09uIH0pKTtcblxuICBjb25zdCBwZW5kaW5nID0gc3RhdGUucmVnaXN0cnlcbiAgICAuZmlsdGVyKG0gPT4gbS5zdGF0dXMgIT09IFwiY29tcGxldGVcIiAmJiBtLnN0YXR1cyAhPT0gXCJwYXJrZWRcIilcbiAgICAubWFwKG0gPT4gKHsgaWQ6IG0uaWQsIHRpdGxlOiBtLnRpdGxlLCBkZXBlbmRzT246IG0uZGVwZW5kc09uIH0pKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBzaG93UmVvcmRlclVJKGN0eCwgY29tcGxldGVkLCBwZW5kaW5nKTtcbiAgaWYgKCFyZXN1bHQpIHtcbiAgICBjdHgudWkubm90aWZ5KFwiUXVldWUgcmVvcmRlciBjYW5jZWxsZWQuXCIsIFwiaW5mb1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBTYXZlIHRoZSBuZXcgb3JkZXJcbiAgc2F2ZVF1ZXVlT3JkZXIoYmFzZVBhdGgsIHJlc3VsdC5vcmRlcik7XG4gIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcblxuICAvLyBSZW1vdmUgY29uZmxpY3RpbmcgZGVwZW5kc19vbiBlbnRyaWVzIGZyb20gQ09OVEVYVC5tZCBmaWxlc1xuICBpZiAocmVzdWx0LmRlcHNUb1JlbW92ZS5sZW5ndGggPiAwKSB7XG4gICAgcmVtb3ZlRGVwZW5kc09uRnJvbUNvbnRleHRGaWxlcyhiYXNlUGF0aCwgcmVzdWx0LmRlcHNUb1JlbW92ZSk7XG4gIH1cblxuICAvLyBTeW5jIFBST0pFQ1QubWQgbWlsZXN0b25lIHNlcXVlbmNlIHRhYmxlXG4gIHN5bmNQcm9qZWN0TWRTZXF1ZW5jZShiYXNlUGF0aCwgc3RhdGUucmVnaXN0cnksIHJlc3VsdC5vcmRlcik7XG5cbiAgLy8gQ29tbWl0IHRoZSBjaGFuZ2VcbiAgY29uc3QgZmlsZXNUb0FkZCA9IFtcIi5nc2QvUVVFVUUtT1JERVIuanNvblwiLCBcIi5nc2QvUFJPSkVDVC5tZFwiXTtcbiAgZm9yIChjb25zdCByIG9mIHJlc3VsdC5kZXBzVG9SZW1vdmUpIHtcbiAgICBmaWxlc1RvQWRkLnB1c2goYC5nc2QvbWlsZXN0b25lcy8ke3IubWlsZXN0b25lfS8ke3IubWlsZXN0b25lfS1DT05URVhULm1kYCk7XG4gIH1cbiAgdHJ5IHtcbiAgICBuYXRpdmVBZGRQYXRocyhiYXNlUGF0aCwgZmlsZXNUb0FkZCk7XG4gICAgbmF0aXZlQ29tbWl0KGJhc2VQYXRoLCBcImRvY3M6IHJlb3JkZXIgcXVldWVcIik7XG4gIH0gY2F0Y2gge1xuICAgIC8vIENvbW1pdCBtYXkgZmFpbCBpZiBub3RoaW5nIGNoYW5nZWQgb3IgZ2l0IGhvb2tzIGJsb2NrIFx1MjAxNCBub24tZmF0YWxcbiAgfVxuXG4gIGNvbnN0IGRlcEluZm8gPSByZXN1bHQuZGVwc1RvUmVtb3ZlLmxlbmd0aCA+IDBcbiAgICA/IGAgKHJlbW92ZWQgJHtyZXN1bHQuZGVwc1RvUmVtb3ZlLmxlbmd0aH0gZGVwZW5kc19vbilgXG4gICAgOiBcIlwiO1xuICBjdHgudWkubm90aWZ5KGBRdWV1ZSByZW9yZGVyZWQ6ICR7cmVzdWx0Lm9yZGVyLmpvaW4oXCIgXHUyMTkyIFwiKX0ke2RlcEluZm99YCwgXCJpbmZvXCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUXVldWUgQWRkIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2hvd1F1ZXVlQWRkKFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBwaTogRXh0ZW5zaW9uQVBJLFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBzdGF0ZTogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBkZXJpdmVTdGF0ZT4+LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IG1pbGVzdG9uZUlkcyA9IGZpbmRNaWxlc3RvbmVJZHMoYmFzZVBhdGgpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBCdWlsZCBleGlzdGluZyBtaWxlc3RvbmVzIGNvbnRleHQgZm9yIHRoZSBwcm9tcHQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IGV4aXN0aW5nQ29udGV4dCA9IGF3YWl0IGJ1aWxkRXhpc3RpbmdNaWxlc3RvbmVzQ29udGV4dChiYXNlUGF0aCwgbWlsZXN0b25lSWRzLCBzdGF0ZSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIERldGVybWluZSBuZXh0IG1pbGVzdG9uZSBJRCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gTm90ZTogdGhlIExMTSB3aWxsIHVzZSB0aGUgZ3NkX21pbGVzdG9uZV9nZW5lcmF0ZV9pZCB0b29sIHRvIGdldCBJRHNcbiAgLy8gYXQgY3JlYXRpb24gdGltZSwgYnV0IHdlIHN0aWxsIG1lbnRpb24gdGhlIG5leHQgSUQgaW4gdGhlIHByZWFtYmxlXG4gIC8vIGZvciBjb250ZXh0IGFib3V0IHdoZXJlIHRoZSBzZXF1ZW5jZSBpcy5cbiAgY29uc3QgdW5pcXVlRW5hYmxlZCA9ICEhbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk/LnByZWZlcmVuY2VzPy51bmlxdWVfbWlsZXN0b25lX2lkcztcbiAgY29uc3QgbmV4dElkID0gbmV4dE1pbGVzdG9uZUlkKG1pbGVzdG9uZUlkcywgdW5pcXVlRW5hYmxlZCk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEJ1aWxkIHByZWFtYmxlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBhY3RpdmVQYXJ0ID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lXG4gICAgPyBgQ3VycmVudGx5IGV4ZWN1dGluZzogJHtzdGF0ZS5hY3RpdmVNaWxlc3RvbmUuaWR9IFx1MjAxNCAke3N0YXRlLmFjdGl2ZU1pbGVzdG9uZS50aXRsZX0gKHBoYXNlOiAke3N0YXRlLnBoYXNlfSkuYFxuICAgIDogXCJObyBtaWxlc3RvbmUgY3VycmVudGx5IGFjdGl2ZS5cIjtcblxuICBjb25zdCBwZW5kaW5nQ291bnQgPSBzdGF0ZS5yZWdpc3RyeS5maWx0ZXIobSA9PiBtLnN0YXR1cyA9PT0gXCJwZW5kaW5nXCIpLmxlbmd0aDtcbiAgY29uc3QgY29tcGxldGVDb3VudCA9IHN0YXRlLnJlZ2lzdHJ5LmZpbHRlcihtID0+IG0uc3RhdHVzID09PSBcImNvbXBsZXRlXCIpLmxlbmd0aDtcblxuICBjb25zdCBwcmVhbWJsZSA9IFtcbiAgICBgUXVldWluZyBuZXcgd29yayBvbnRvIGFuIGV4aXN0aW5nIEdTRCBwcm9qZWN0LmAsXG4gICAgYWN0aXZlUGFydCxcbiAgICBgJHtjb21wbGV0ZUNvdW50fSBtaWxlc3RvbmUocykgY29tcGxldGUsICR7cGVuZGluZ0NvdW50fSBwZW5kaW5nLmAsXG4gICAgYE5leHQgYXZhaWxhYmxlIG1pbGVzdG9uZSBJRDogJHtuZXh0SWR9LmAsXG4gIF0uam9pbihcIiBcIik7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIERpc3BhdGNoIHRoZSBxdWV1ZSBwcm9tcHQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIEFjdGl2YXRlIHRoZSBxdWV1ZSBwaGFzZSBzbyB0aGUgd3JpdGUtZ2F0ZSBhcHBsaWVzIHRvIENPTlRFWFQubWQgd3JpdGVzXG4gIHNldFF1ZXVlUGhhc2VBY3RpdmUodHJ1ZSwgYmFzZVBhdGgpO1xuXG4gIGNvbnN0IHF1ZXVlSW5saW5lZFRlbXBsYXRlcyA9IGlubGluZVRlbXBsYXRlKFwiY29udGV4dFwiLCBcIkNvbnRleHRcIik7XG4gIGNvbnN0IHByb21wdCA9IGxvYWRQcm9tcHQoXCJxdWV1ZVwiLCB7XG4gICAgcHJlYW1ibGUsXG4gICAgZXhpc3RpbmdNaWxlc3RvbmVzQ29udGV4dDogZXhpc3RpbmdDb250ZXh0LFxuICAgIGlubGluZWRUZW1wbGF0ZXM6IHF1ZXVlSW5saW5lZFRlbXBsYXRlcyxcbiAgICBjb21taXRJbnN0cnVjdGlvbjogXCJEbyBub3QgY29tbWl0IHBsYW5uaW5nIGFydGlmYWN0cyBcdTIwMTQgLmdzZC8gaXMgbWFuYWdlZCBleHRlcm5hbGx5LlwiLFxuICB9KTtcblxuICBwaS5zZW5kTWVzc2FnZShcbiAgICB7XG4gICAgICBjdXN0b21UeXBlOiBcImdzZC1xdWV1ZVwiLFxuICAgICAgY29udGVudDogcHJvbXB0LFxuICAgICAgZGlzcGxheTogZmFsc2UsXG4gICAgfSxcbiAgICB7IHRyaWdnZXJUdXJuOiB0cnVlIH0sXG4gICk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBFeGlzdGluZyBNaWxlc3RvbmVzIENvbnRleHQgQnVpbGRlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBCdWlsZCBhIGNvbnRleHQgYmxvY2sgZGVzY3JpYmluZyBhbGwgZXhpc3RpbmcgbWlsZXN0b25lcyBmb3IgdGhlIHF1ZXVlIHByb21wdC5cbiAqIEdpdmVzIHRoZSBMTE0gZW5vdWdoIGluZm9ybWF0aW9uIHRvIGRlZHVwLCBzZXF1ZW5jZSwgYW5kIGRlcGVuZGVuY3ktY2hlY2suXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBidWlsZEV4aXN0aW5nTWlsZXN0b25lc0NvbnRleHQoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkczogc3RyaW5nW10sXG4gIHN0YXRlOiBpbXBvcnQoXCIuL3R5cGVzLmpzXCIpLkdTRFN0YXRlLFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3Qgc2VjdGlvbnM6IHN0cmluZ1tdID0gW107XG5cbiAgLy8gSW5jbHVkZSBQUk9KRUNULm1kIGlmIGl0IGV4aXN0cyBcdTIwMTQgaXQgaGFzIHRoZSBtaWxlc3RvbmUgc2VxdWVuY2UgYW5kIHByb2plY3QgZGVzY3JpcHRpb25cbiAgY29uc3QgcHJvamVjdFBhdGggPSByZXNvbHZlR3NkUm9vdEZpbGUoYmFzZVBhdGgsIFwiUFJPSkVDVFwiKTtcbiAgaWYgKGV4aXN0c1N5bmMocHJvamVjdFBhdGgpKSB7XG4gICAgY29uc3QgcHJvamVjdENvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZShwcm9qZWN0UGF0aCk7XG4gICAgaWYgKHByb2plY3RDb250ZW50KSB7XG4gICAgICBzZWN0aW9ucy5wdXNoKGAjIyMgUHJvamVjdCBPdmVydmlld1xcblNvdXJjZTogXFxgJHtyZWxHc2RSb290RmlsZShcIlBST0pFQ1RcIil9XFxgXFxuXFxuJHtwcm9qZWN0Q29udGVudC50cmltKCl9YCk7XG4gICAgfVxuICB9XG5cbiAgLy8gSW5jbHVkZSBERUNJU0lPTlMubWQgaWYgaXQgZXhpc3RzIFx1MjAxNCBhcmNoaXRlY3R1cmFsIGRlY2lzaW9ucyBpbmZvcm0gbmV3IG1pbGVzdG9uZSBzY29waW5nXG4gIGNvbnN0IGRlY2lzaW9uc1BhdGggPSByZXNvbHZlR3NkUm9vdEZpbGUoYmFzZVBhdGgsIFwiREVDSVNJT05TXCIpO1xuICBpZiAoZXhpc3RzU3luYyhkZWNpc2lvbnNQYXRoKSkge1xuICAgIGNvbnN0IGRlY2lzaW9uc0NvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZShkZWNpc2lvbnNQYXRoKTtcbiAgICBpZiAoZGVjaXNpb25zQ29udGVudCkge1xuICAgICAgc2VjdGlvbnMucHVzaChgIyMjIERlY2lzaW9ucyBSZWdpc3RlclxcblNvdXJjZTogXFxgJHtyZWxHc2RSb290RmlsZShcIkRFQ0lTSU9OU1wiKX1cXGBcXG5cXG4ke2RlY2lzaW9uc0NvbnRlbnQudHJpbSgpfWApO1xuICAgIH1cbiAgfVxuXG4gIC8vIEZvciBlYWNoIG1pbGVzdG9uZSwgaW5jbHVkZSBjb250ZXh0IGFuZCBzdGF0dXMuXG4gIC8vIENvbXBsZXRlZCBtaWxlc3RvbmVzIGdldCBhIGNvbXBhY3Qgc3VtbWFyeSBsaW5lIG9ubHkgXHUyMDE0IGxvYWRpbmcgdGhlaXIgZnVsbFxuICAvLyBDT05URVhULm1kICsgU1VNTUFSWS5tZCBmaWxlcyBpcyBleHBlbnNpdmUgYW5kIHRyaWdnZXJzIDQyOSByYXRlIGxpbWl0cyBvblxuICAvLyBwcm9qZWN0cyB3aXRoIG1hbnkgY29tcGxldGVkIG1pbGVzdG9uZXMgKCMyMzc5KS5cbiAgZm9yIChjb25zdCBtaWQgb2YgbWlsZXN0b25lSWRzKSB7XG4gICAgY29uc3QgcmVnaXN0cnlFbnRyeSA9IHN0YXRlLnJlZ2lzdHJ5LmZpbmQobSA9PiBtLmlkID09PSBtaWQpO1xuICAgIGNvbnN0IHN0YXR1cyA9IHJlZ2lzdHJ5RW50cnk/LnN0YXR1cyA/PyBcInVua25vd25cIjtcbiAgICBjb25zdCB0aXRsZSA9IHJlZ2lzdHJ5RW50cnk/LnRpdGxlID8/IG1pZDtcblxuICAgIC8vIENvbXBsZXRlZCBtaWxlc3RvbmVzOiBlbWl0IGEgb25lLWxpbmVyIFx1MjAxNCB0aGUgTExNIG9ubHkgbmVlZHMgdG8ga25vd1xuICAgIC8vIHRoZXkgZXhpc3QgZm9yIGRlZHVwL2RlcGVuZGVuY3kgcHVycG9zZXMsIG5vdCB0aGVpciBmdWxsIGNvbnRlbnQuXG4gICAgaWYgKHN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiKSB7XG4gICAgICBzZWN0aW9ucy5wdXNoKGAjIyMgJHttaWR9OiAke3RpdGxlfVxcbioqU3RhdHVzOioqIGNvbXBsZXRlYCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICBwYXJ0cy5wdXNoKGAjIyMgJHttaWR9OiAke3RpdGxlfVxcbioqU3RhdHVzOioqICR7c3RhdHVzfWApO1xuXG4gICAgLy8gSW5jbHVkZSBjb250ZXh0IGZpbGUgXHUyMDE0IHRoaXMgaXMgdGhlIHByaW1hcnkgY29udGVudCBmb3IgdW5kZXJzdGFuZGluZyBzY29wZVxuICAgIGNvbnN0IGNvbnRleHRGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJDT05URVhUXCIpO1xuICAgIGlmIChjb250ZXh0RmlsZSkge1xuICAgICAgY29uc3QgY29udGVudCA9IGF3YWl0IGxvYWRGaWxlKGNvbnRleHRGaWxlKTtcbiAgICAgIGlmIChjb250ZW50KSB7XG4gICAgICAgIHBhcnRzLnB1c2goYFxcbioqQ29udGV4dDoqKlxcbiR7Y29udGVudC50cmltKCl9YCk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIE5vIGZ1bGwgQ09OVEVYVC5tZCBcdTIwMTQgY2hlY2sgZm9yIENPTlRFWFQtRFJBRlQubWQgKGRyYWZ0IHNlZWQgZnJvbSBwcmlvciBkaXNjdXNzaW9uKVxuICAgICAgY29uc3QgZHJhZnRGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJDT05URVhULURSQUZUXCIpO1xuICAgICAgaWYgKGRyYWZ0RmlsZSkge1xuICAgICAgICBjb25zdCBkcmFmdENvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZShkcmFmdEZpbGUpO1xuICAgICAgICBpZiAoZHJhZnRDb250ZW50KSB7XG4gICAgICAgICAgcGFydHMucHVzaChgXFxuKipEcmFmdCBjb250ZXh0IGF2YWlsYWJsZToqKlxcbiR7ZHJhZnRDb250ZW50LnRyaW0oKX1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIEZvciBhY3RpdmUvcGVuZGluZy9wYXJrZWQgbWlsZXN0b25lcywgaW5jbHVkZSB0aGUgcm9hZG1hcCBpZiBpdCBleGlzdHNcbiAgICAvLyAoc2hvd3Mgd2hhdCdzIHBsYW5uZWQgYnV0IG5vdCB5ZXQgYnVpbHQpXG4gICAgaWYgKHN0YXR1cyA9PT0gXCJhY3RpdmVcIiB8fCBzdGF0dXMgPT09IFwicGVuZGluZ1wiIHx8IHN0YXR1cyA9PT0gXCJwYXJrZWRcIikge1xuICAgICAgY29uc3Qgcm9hZG1hcEZpbGUgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlkLCBcIlJPQURNQVBcIik7XG4gICAgICBpZiAocm9hZG1hcEZpbGUpIHtcbiAgICAgICAgY29uc3QgY29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHJvYWRtYXBGaWxlKTtcbiAgICAgICAgaWYgKGNvbnRlbnQpIHtcbiAgICAgICAgICBwYXJ0cy5wdXNoKGBcXG4qKlJvYWRtYXA6KipcXG4ke2NvbnRlbnQudHJpbSgpfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgc2VjdGlvbnMucHVzaChwYXJ0cy5qb2luKFwiXFxuXCIpKTtcbiAgfVxuXG4gIC8vIEluY2x1ZGUgcXVldWUgbG9nIGlmIGl0IGV4aXN0cyBcdTIwMTQgc2hvd3Mgd2hhdCdzIGJlZW4gcXVldWVkIGJlZm9yZVxuICBjb25zdCBxdWV1ZVBhdGggPSByZXNvbHZlR3NkUm9vdEZpbGUoYmFzZVBhdGgsIFwiUVVFVUVcIik7XG4gIGlmIChleGlzdHNTeW5jKHF1ZXVlUGF0aCkpIHtcbiAgICBjb25zdCBxdWV1ZUNvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZShxdWV1ZVBhdGgpO1xuICAgIGlmIChxdWV1ZUNvbnRlbnQpIHtcbiAgICAgIHNlY3Rpb25zLnB1c2goYCMjIyBQcmV2aW91cyBRdWV1ZSBFbnRyaWVzXFxuU291cmNlOiBcXGAke3JlbEdzZFJvb3RGaWxlKFwiUVVFVUVcIil9XFxgXFxuXFxuJHtxdWV1ZUNvbnRlbnQudHJpbSgpfWApO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBzZWN0aW9ucy5qb2luKFwiXFxuXFxuLS0tXFxuXFxuXCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSW50ZXJuYWwgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSZW1vdmUgc3BlY2lmaWMgZGVwZW5kc19vbiBlbnRyaWVzIGZyb20gbWlsZXN0b25lIENPTlRFWFQubWQgZnJvbnRtYXR0ZXIuXG4gKi9cbmZ1bmN0aW9uIHJlbW92ZURlcGVuZHNPbkZyb21Db250ZXh0RmlsZXMoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIGRlcHNUb1JlbW92ZTogQXJyYXk8eyBtaWxlc3RvbmU6IHN0cmluZzsgZGVwOiBzdHJpbmcgfT4sXG4pOiB2b2lkIHtcbiAgLy8gR3JvdXAgcmVtb3ZhbHMgYnkgbWlsZXN0b25lXG4gIGNvbnN0IGJ5TWlsZXN0b25lID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZ1tdPigpO1xuICBmb3IgKGNvbnN0IHsgbWlsZXN0b25lLCBkZXAgfSBvZiBkZXBzVG9SZW1vdmUpIHtcbiAgICBjb25zdCBleGlzdGluZyA9IGJ5TWlsZXN0b25lLmdldChtaWxlc3RvbmUpID8/IFtdO1xuICAgIGV4aXN0aW5nLnB1c2goZGVwKTtcbiAgICBieU1pbGVzdG9uZS5zZXQobWlsZXN0b25lLCBleGlzdGluZyk7XG4gIH1cblxuICBmb3IgKGNvbnN0IFttaWQsIGRlcHNUb1JlbW92ZUZvck1pZF0gb2YgYnlNaWxlc3RvbmUpIHtcbiAgICBjb25zdCBjb250ZXh0RmlsZSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiQ09OVEVYVFwiKTtcbiAgICBpZiAoIWNvbnRleHRGaWxlIHx8ICFleGlzdHNTeW5jKGNvbnRleHRGaWxlKSkgY29udGludWU7XG5cbiAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGNvbnRleHRGaWxlLCBcInV0Zi04XCIpO1xuXG4gICAgLy8gUGFyc2UgZnJvbnRtYXR0ZXJcbiAgICBjb25zdCB0cmltbWVkID0gY29udGVudC50cmltU3RhcnQoKTtcbiAgICBpZiAoIXRyaW1tZWQuc3RhcnRzV2l0aChcIi0tLVwiKSkgY29udGludWU7XG4gICAgY29uc3QgYWZ0ZXJGaXJzdCA9IHRyaW1tZWQuaW5kZXhPZihcIlxcblwiKTtcbiAgICBpZiAoYWZ0ZXJGaXJzdCA9PT0gLTEpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHJlc3QgPSB0cmltbWVkLnNsaWNlKGFmdGVyRmlyc3QgKyAxKTtcbiAgICBjb25zdCBlbmRJZHggPSByZXN0LmluZGV4T2YoXCJcXG4tLS1cIik7XG4gICAgaWYgKGVuZElkeCA9PT0gLTEpIGNvbnRpbnVlO1xuXG4gICAgY29uc3QgZm1UZXh0ID0gcmVzdC5zbGljZSgwLCBlbmRJZHgpO1xuICAgIGNvbnN0IGJvZHkgPSByZXN0LnNsaWNlKGVuZElkeCArIDQpO1xuXG4gICAgLy8gUGFyc2UgZGVwZW5kc19vbiBsaW5lKHMpXG4gICAgY29uc3QgZm1MaW5lcyA9IGZtVGV4dC5zcGxpdChcIlxcblwiKTtcbiAgICBjb25zdCByZW1vdmVTZXQgPSBuZXcgU2V0KGRlcHNUb1JlbW92ZUZvck1pZC5tYXAoZCA9PiBkLnRvVXBwZXJDYXNlKCkpKTtcblxuICAgIC8vIEhhbmRsZSBpbmxpbmUgZm9ybWF0OiBkZXBlbmRzX29uOiBbTTAwOSwgTTAxMF1cbiAgICBjb25zdCBpbmxpbmVNYXRjaCA9IGZtTGluZXMuZmluZEluZGV4KGwgPT4gL15kZXBlbmRzX29uOlxccypcXFsvLnRlc3QobCkpO1xuICAgIGlmIChpbmxpbmVNYXRjaCA+PSAwKSB7XG4gICAgICBjb25zdCBsaW5lID0gZm1MaW5lc1tpbmxpbmVNYXRjaF07XG4gICAgICBjb25zdCBpbm5lciA9IGxpbmUubWF0Y2goL1xcWyhbXlxcXV0qKVxcXS8pO1xuICAgICAgaWYgKGlubmVyKSB7XG4gICAgICAgIGNvbnN0IHJlbWFpbmluZyA9IGlubmVyWzFdXG4gICAgICAgICAgLnNwbGl0KFwiLFwiKVxuICAgICAgICAgIC5tYXAocyA9PiBzLnRyaW0oKSlcbiAgICAgICAgICAuZmlsdGVyKHMgPT4gcyAmJiAhcmVtb3ZlU2V0LmhhcyhzLnRvVXBwZXJDYXNlKCkpKTtcbiAgICAgICAgaWYgKHJlbWFpbmluZy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICBmbUxpbmVzLnNwbGljZShpbmxpbmVNYXRjaCwgMSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgZm1MaW5lc1tpbmxpbmVNYXRjaF0gPSBgZGVwZW5kc19vbjogWyR7cmVtYWluaW5nLmpvaW4oXCIsIFwiKX1dYDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBIYW5kbGUgbXVsdGktbGluZSBmb3JtYXRcbiAgICAgIGNvbnN0IGtleUlkeCA9IGZtTGluZXMuZmluZEluZGV4KGwgPT4gL15kZXBlbmRzX29uOlxccyokLy50ZXN0KGwpKTtcbiAgICAgIGlmIChrZXlJZHggPj0gMCkge1xuICAgICAgICBsZXQgZW5kID0ga2V5SWR4ICsgMTtcbiAgICAgICAgd2hpbGUgKGVuZCA8IGZtTGluZXMubGVuZ3RoICYmIC9eXFxzKy1cXHMvLnRlc3QoZm1MaW5lc1tlbmRdKSkge1xuICAgICAgICAgIGNvbnN0IHZhbCA9IGZtTGluZXNbZW5kXS5yZXBsYWNlKC9eXFxzKy1cXHMqLywgXCJcIikudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgICAgaWYgKHJlbW92ZVNldC5oYXModmFsKSkge1xuICAgICAgICAgICAgZm1MaW5lcy5zcGxpY2UoZW5kLCAxKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZW5kKys7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChlbmQgPT09IGtleUlkeCArIDEgfHwgKGVuZCA8PSBmbUxpbmVzLmxlbmd0aCAmJiAhL15cXHMrLVxccy8udGVzdChmbUxpbmVzW2tleUlkeCArIDFdID8/IFwiXCIpKSkge1xuICAgICAgICAgIGZtTGluZXMuc3BsaWNlKGtleUlkeCwgMSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSZWJ1aWxkIGZpbGVcbiAgICBjb25zdCBuZXdGbSA9IGZtTGluZXMuZmlsdGVyKGwgPT4gbCAhPT0gdW5kZWZpbmVkKS5qb2luKFwiXFxuXCIpO1xuICAgIGNvbnN0IG5ld0NvbnRlbnQgPSBuZXdGbS50cmltKClcbiAgICAgID8gYC0tLVxcbiR7bmV3Rm19XFxuLS0tJHtib2R5fWBcbiAgICAgIDogYm9keS5yZXBsYWNlKC9eXFxuKy8sIFwiXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoY29udGV4dEZpbGUsIG5ld0NvbnRlbnQsIFwidXRmLThcIik7XG4gIH1cbn1cblxuZnVuY3Rpb24gc3luY1Byb2plY3RNZFNlcXVlbmNlKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICByZWdpc3RyeTogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBzdGF0dXM6IHN0cmluZyB9PixcbiAgbmV3T3JkZXI6IHN0cmluZ1tdLFxuKTogdm9pZCB7XG4gIGNvbnN0IHByb2plY3RQYXRoID0gcmVzb2x2ZUdzZFJvb3RGaWxlKGJhc2VQYXRoLCBcIlBST0pFQ1RcIik7XG4gIGlmICghcHJvamVjdFBhdGggfHwgIWV4aXN0c1N5bmMocHJvamVjdFBhdGgpKSByZXR1cm47XG5cbiAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhwcm9qZWN0UGF0aCwgXCJ1dGYtOFwiKTtcbiAgY29uc3QgbGluZXMgPSBjb250ZW50LnNwbGl0KFwiXFxuXCIpO1xuXG4gIGNvbnN0IGhlYWRlcklkeCA9IGxpbmVzLmZpbmRJbmRleChsID0+IC9eIyNcXHMrTWlsZXN0b25lIFNlcXVlbmNlLy50ZXN0KGwpKTtcbiAgaWYgKGhlYWRlcklkeCA8IDApIHJldHVybjtcblxuICBsZXQgdGFibGVTdGFydCA9IGhlYWRlcklkeCArIDE7XG4gIHdoaWxlICh0YWJsZVN0YXJ0IDwgbGluZXMubGVuZ3RoICYmICFsaW5lc1t0YWJsZVN0YXJ0XS5zdGFydHNXaXRoKFwifFwiKSkgdGFibGVTdGFydCsrO1xuICBpZiAodGFibGVTdGFydCA+PSBsaW5lcy5sZW5ndGgpIHJldHVybjtcblxuICBsZXQgdGFibGVFbmQgPSB0YWJsZVN0YXJ0ICsgMTtcbiAgd2hpbGUgKHRhYmxlRW5kIDwgbGluZXMubGVuZ3RoICYmIGxpbmVzW3RhYmxlRW5kXS5zdGFydHNXaXRoKFwifFwiKSkgdGFibGVFbmQrKztcblxuICBjb25zdCByZWdpc3RyeU1hcCA9IG5ldyBNYXAocmVnaXN0cnkubWFwKG0gPT4gW20uaWQsIG1dKSk7XG4gIGNvbnN0IGNvbXBsZXRlZFNldCA9IG5ldyBTZXQocmVnaXN0cnkuZmlsdGVyKG0gPT4gbS5zdGF0dXMgPT09IFwiY29tcGxldGVcIikubWFwKG0gPT4gbS5pZCkpO1xuXG4gIGNvbnN0IG5ld1Jvd3M6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgbSBvZiByZWdpc3RyeSkge1xuICAgIGlmIChtLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiKSB7XG4gICAgICBuZXdSb3dzLnB1c2goYHwgJHttLmlkfSB8ICR7bS50aXRsZX0gfCBcdTI3MDUgQ29tcGxldGUgfGApO1xuICAgIH1cbiAgfVxuICBsZXQgaXNGaXJzdCA9IHRydWU7XG4gIGZvciAoY29uc3QgaWQgb2YgbmV3T3JkZXIpIHtcbiAgICBpZiAoY29tcGxldGVkU2V0LmhhcyhpZCkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IG0gPSByZWdpc3RyeU1hcC5nZXQoaWQpO1xuICAgIGlmICghbSkgY29udGludWU7XG4gICAgY29uc3Qgc3RhdHVzID0gaXNGaXJzdCA/IFwiXHVEODNEXHVEQ0NCIE5leHRcIiA6IFwiXHVEODNEXHVEQ0NCIFF1ZXVlZFwiO1xuICAgIG5ld1Jvd3MucHVzaChgfCAke20uaWR9IHwgJHttLnRpdGxlfSB8ICR7c3RhdHVzfSB8YCk7XG4gICAgaXNGaXJzdCA9IGZhbHNlO1xuICB9XG5cbiAgY29uc3QgaGVhZGVyTGluZSA9IGxpbmVzW3RhYmxlU3RhcnRdO1xuICBjb25zdCBzZXBhcmF0b3JMaW5lID0gbGluZXNbdGFibGVTdGFydCArIDFdO1xuICBjb25zdCBuZXdUYWJsZSA9IFtoZWFkZXJMaW5lLCBzZXBhcmF0b3JMaW5lLCAuLi5uZXdSb3dzXTtcbiAgbGluZXMuc3BsaWNlKHRhYmxlU3RhcnQsIHRhYmxlRW5kIC0gdGFibGVTdGFydCwgLi4ubmV3VGFibGUpO1xuICAvLyBBdG9taWMgd3JpdGU6IHRtcCtyZW5hbWUgYXZvaWRzIGEgdG9ybiBQUk9KRUNULm1kIGFwcGVhcmluZyBkaXJ0eSBpblxuICAvLyBhbm90aGVyIHdvcmt0cmVlJ3Mgd29ya2luZyB0cmVlIGR1cmluZyBhIGNvbmN1cnJlbnQgL2dzZCBhdXRvIG1lcmdlLlxuICBhdG9taWNXcml0ZVN5bmMocHJvamVjdFBhdGgsIGxpbmVzLmpvaW4oXCJcXG5cIiksIFwidXRmLThcIik7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFTQSxTQUFTLHNCQUFzQjtBQUMvQixTQUFTLDJCQUEyQjtBQUNwQyxTQUFTLGdCQUFnQjtBQUN6QixTQUFTLFlBQVksc0JBQXNCO0FBQzNDLFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMsMkJBQTJCO0FBQ3BDO0FBQUEsRUFDRTtBQUFBLEVBQVM7QUFBQSxFQUNUO0FBQUEsRUFBb0I7QUFBQSxPQUNmO0FBQ1AsU0FBUyxjQUFjLGVBQWUsa0JBQWtCO0FBQ3hELFNBQVMsdUJBQXVCO0FBQ2hDLFNBQVMsZ0JBQWdCLG9CQUFvQjtBQUM3QyxTQUFTLG1DQUFtQztBQUM1QyxTQUEyQyxzQkFBc0I7QUFDakUsU0FBUyxrQkFBa0IsdUJBQXVCO0FBbUJsRCxlQUFzQixVQUNwQixLQUNBLElBQ0EsVUFDZTtBQUVmLFFBQU0sTUFBTSxRQUFRLFFBQVE7QUFDNUIsTUFBSSxDQUFDLFdBQVcsR0FBRyxHQUFHO0FBQ3BCLFFBQUksR0FBRyxPQUFPLHNEQUFzRCxTQUFTO0FBQzdFO0FBQUEsRUFDRjtBQUVBLFFBQU0sUUFBUSxNQUFNLFlBQVksUUFBUTtBQUN4QyxRQUFN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
