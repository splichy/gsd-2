import { isAbsolute, relative, resolve } from "node:path";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolveGsdRootFile } from "./paths.js";
import { saveFile } from "./files.js";
import { GSDError, GSD_STALE_STATE, GSD_IO_ERROR } from "./errors.js";
import { logWarning, logError } from "./workflow-logger.js";
import { invalidateStateCache } from "./state.js";
import { clearPathCache } from "./paths.js";
import { clearParseCache } from "./files.js";
import { createWorkspace, scopeMilestone } from "./workspace.js";
function isDecisionsTableFormat(content) {
  const firstLine = content.split("\n")[0]?.trim() ?? "";
  if (firstLine !== "# Decisions Register") return false;
  return content.includes("| # | When | Scope | Decision | Choice | Rationale | Revisable?");
}
function generateDecisionsAppendBlock(decisions) {
  const lines = [];
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Decisions Table");
  lines.push("");
  lines.push("| # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |");
  lines.push("|---|------|-------|----------|--------|-----------|------------|---------|");
  for (const d of decisions) {
    const cells = [
      d.id,
      d.when_context,
      d.scope,
      d.decision,
      d.choice,
      d.rationale,
      d.revisable,
      d.made_by ?? "agent"
    ].map((cell) => (cell ?? "").replace(/\|/g, "\\|"));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}
function generateDecisionsMd(decisions) {
  const lines = [];
  lines.push("# Decisions Register");
  lines.push("");
  lines.push("<!-- Append-only. Never edit or remove existing rows.");
  lines.push("     To reverse a decision, add a new row that supersedes it.");
  lines.push("     Read this file at the start of any planning or research phase. -->");
  lines.push("");
  lines.push("| # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |");
  lines.push("|---|------|-------|----------|--------|-----------|------------|---------|");
  for (const d of decisions) {
    const cells = [
      d.id,
      d.when_context,
      d.scope,
      d.decision,
      d.choice,
      d.rationale,
      d.revisable,
      d.made_by ?? "agent"
    ].map((cell) => (cell ?? "").replace(/\|/g, "\\|"));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}
const STATUS_SECTION_MAP = [
  { status: "active", heading: "Active" },
  { status: "validated", heading: "Validated" },
  { status: "deferred", heading: "Deferred" },
  { status: "out-of-scope", heading: "Out of Scope" }
];
function generateRequirementsMd(requirements) {
  const lines = [];
  lines.push("# Requirements");
  lines.push("");
  lines.push("This file is the explicit capability and coverage contract for the project.");
  lines.push("");
  const byStatus = /* @__PURE__ */ new Map();
  for (const r of requirements) {
    const status = (r.status || "active").toLowerCase();
    if (!byStatus.has(status)) byStatus.set(status, []);
    byStatus.get(status).push(r);
  }
  for (const { status, heading } of STATUS_SECTION_MAP) {
    const reqs = byStatus.get(status);
    lines.push(`## ${heading}`);
    lines.push("");
    for (const r of reqs ?? []) {
      lines.push(`### ${r.id} \u2014 ${r.description || "Untitled"}`);
      if (r.class) lines.push(`- Class: ${r.class}`);
      if (r.status) lines.push(`- Status: ${r.status}`);
      if (r.description) lines.push(`- Description: ${r.description}`);
      if (r.why) lines.push(`- Why it matters: ${r.why}`);
      if (r.source) lines.push(`- Source: ${r.source}`);
      if (r.primary_owner) lines.push(`- Primary owning slice: ${r.primary_owner}`);
      if (r.supporting_slices) lines.push(`- Supporting slices: ${r.supporting_slices}`);
      if (r.validation) lines.push(`- Validation: ${r.validation}`);
      if (r.notes) lines.push(`- Notes: ${r.notes}`);
      lines.push("");
    }
  }
  lines.push("## Traceability");
  lines.push("");
  lines.push("| ID | Class | Status | Primary owner | Supporting | Proof |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of requirements) {
    const proof = r.validation || "unmapped";
    lines.push(
      `| ${r.id} | ${r.class || ""} | ${r.status || ""} | ${r.primary_owner || "none"} | ${r.supporting_slices || "none"} | ${proof} |`
    );
  }
  lines.push("");
  const activeCount = byStatus.get("active")?.length ?? 0;
  const validatedReqs = byStatus.get("validated") ?? [];
  const validatedIds = validatedReqs.map((r) => r.id).join(", ");
  lines.push("## Coverage Summary");
  lines.push("");
  lines.push(`- Active requirements: ${activeCount}`);
  lines.push(`- Mapped to slices: ${activeCount}`);
  lines.push(`- Validated: ${validatedReqs.length}${validatedIds ? ` (${validatedIds})` : ""}`);
  lines.push(`- Unmapped active requirements: 0`);
  return lines.join("\n") + "\n";
}
function isRootCanonicalArtifact(opts) {
  if (opts.milestone_id || opts.slice_id || opts.task_id) return false;
  return opts.artifact_type === "PROJECT" || opts.artifact_type === "REQUIREMENTS";
}
async function nextDecisionId() {
  try {
    const db = await import("./gsd-db.js");
    const adapter = db._getAdapter();
    if (!adapter) return "D001";
    const row = adapter.prepare("SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) as max_num FROM decisions").get();
    const maxNum = row ? row["max_num"] : null;
    if (maxNum == null || isNaN(maxNum)) return "D001";
    const next = maxNum + 1;
    return `D${String(next).padStart(3, "0")}`;
  } catch (err) {
    logError("manifest", "nextDecisionId failed", { fn: "nextDecisionId", error: String(err.message) });
    return "D001";
  }
}
function nextDecisionIdAcrossSurfaces(adapter) {
  if (!adapter) return "D001";
  let maxNum = 0;
  try {
    const row = adapter.prepare("SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) as max_num FROM decisions").get();
    const candidate = row ? row["max_num"] : null;
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      maxNum = Math.max(maxNum, candidate);
    }
  } catch {
  }
  try {
    const rows = adapter.prepare(
      `SELECT structured_fields FROM memories WHERE structured_fields LIKE '%"sourceDecisionId":"D%'`
    ).all();
    for (const row of rows) {
      if (!row.structured_fields) continue;
      let sf;
      try {
        sf = JSON.parse(row.structured_fields);
      } catch {
        continue;
      }
      const sourceId = sf["sourceDecisionId"];
      if (typeof sourceId !== "string" || !sourceId.startsWith("D")) continue;
      const num = parseInt(sourceId.slice(1), 10);
      if (Number.isFinite(num) && num > maxNum) maxNum = num;
    }
  } catch {
  }
  const next = maxNum + 1;
  return `D${String(next).padStart(3, "0")}`;
}
async function nextRequirementId() {
  try {
    const db = await import("./gsd-db.js");
    const adapter = db._getAdapter();
    if (!adapter) return "R001";
    const row = adapter.prepare("SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) as max_num FROM requirements").get();
    const maxNum = row ? row["max_num"] : null;
    if (maxNum == null || isNaN(maxNum)) return "R001";
    const next = maxNum + 1;
    return `R${String(next).padStart(3, "0")}`;
  } catch (err) {
    logError("manifest", "nextRequirementId failed", { fn: "nextRequirementId", error: String(err.message) });
    return "R001";
  }
}
async function saveRequirementToDb(fields, basePath) {
  try {
    const db = await import("./gsd-db.js");
    const txResult = db.transaction(() => {
      const adapter2 = db._getAdapter();
      if (!adapter2) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
      const existingRow = adapter2.prepare(
        `SELECT * FROM requirements
           WHERE LOWER(TRIM(description)) = LOWER(TRIM(:description))
             AND LOWER(COALESCE(status, 'active')) = 'active'
             AND superseded_by IS NULL
           ORDER BY id
           LIMIT 1`
      ).get({ ":description": fields.description });
      const row = adapter2.prepare("SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) as max_num FROM requirements").get();
      const maxNum = row ? row["max_num"] : null;
      const nextId = existingRow ? String(existingRow["id"]) : maxNum == null || isNaN(maxNum) ? "R001" : `R${String(maxNum + 1).padStart(3, "0")}`;
      const requirement = {
        id: nextId,
        class: fields.class || existingRow?.["class"] || "",
        status: fields.status ?? existingRow?.["status"] ?? "active",
        description: fields.description,
        why: fields.why,
        source: fields.source,
        primary_owner: fields.primary_owner ?? existingRow?.["primary_owner"] ?? "",
        supporting_slices: fields.supporting_slices ?? existingRow?.["supporting_slices"] ?? "",
        validation: fields.validation ?? existingRow?.["validation"] ?? "",
        notes: fields.notes ?? existingRow?.["notes"] ?? "",
        full_content: existingRow?.["full_content"] ?? "",
        superseded_by: existingRow?.["superseded_by"] ?? null
      };
      db.upsertRequirement(requirement);
      return { id: nextId };
    });
    const { id } = txResult;
    const adapter = db._getAdapter();
    let allRequirements = [];
    if (adapter) {
      const rows = adapter.prepare("SELECT * FROM requirements ORDER BY id").all();
      allRequirements = rows.map((row) => ({
        id: row["id"],
        class: row["class"],
        status: row["status"],
        description: row["description"],
        why: row["why"],
        source: row["source"],
        primary_owner: row["primary_owner"],
        supporting_slices: row["supporting_slices"],
        validation: row["validation"],
        notes: row["notes"],
        full_content: row["full_content"],
        superseded_by: row["superseded_by"] ?? null
      }));
    }
    const nonSuperseded = allRequirements.filter((r) => r.superseded_by == null);
    const md = generateRequirementsMd(nonSuperseded);
    const filePath = resolveGsdRootFile(basePath, "REQUIREMENTS");
    try {
      await saveFile(filePath, md);
    } catch (diskErr) {
      logWarning("projection", "REQUIREMENTS.md projection write failed; DB requirement remains committed", { fn: "saveRequirementToDb", id, error: String(diskErr.message) });
    }
    invalidateStateCache();
    clearPathCache();
    clearParseCache();
    return { id };
  } catch (err) {
    logError("manifest", "saveRequirementToDb failed", { fn: "saveRequirementToDb", error: String(err.message) });
    throw err;
  }
}
let _decisionSaveLock = Promise.resolve();
function _resetDecisionSaveLock() {
  _decisionSaveLock = Promise.resolve();
}
async function saveDecisionToDb(fields, basePath) {
  let release;
  const prev = _decisionSaveLock;
  _decisionSaveLock = new Promise((r) => {
    release = r;
  });
  try {
    await prev;
  } catch {
  }
  try {
    const db = await import("./gsd-db.js");
    const adapter = db._getAdapter();
    const normalized = {
      ...fields,
      when_context: fields.when_context ?? "",
      revisable: fields.revisable ?? "Yes",
      made_by: fields.made_by ?? "agent",
      source: fields.source ?? "discussion"
    };
    const id = nextDecisionIdAcrossSurfaces(adapter);
    await mirrorDecisionToMemory(id, normalized);
    const { getAllDecisionsFromMemories } = await import("./context-store.js");
    let allDecisions = getAllDecisionsFromMemories();
    if (!allDecisions.some((d) => d.id === id)) {
      logWarning("projection", "just-saved decision missing from memories after mirror; injecting fallback for projection", {
        fn: "saveDecisionToDb",
        decisionId: id
      });
      const nextSeq = allDecisions.reduce((max, d) => Math.max(max, d.seq ?? 0), 0) + 1;
      const fallback = {
        seq: nextSeq,
        id,
        when_context: normalized.when_context,
        scope: normalized.scope,
        decision: normalized.decision,
        choice: normalized.choice,
        rationale: normalized.rationale,
        revisable: normalized.revisable,
        made_by: normalized.made_by,
        superseded_by: null
      };
      allDecisions = [...allDecisions, fallback];
    }
    const filePath = resolveGsdRootFile(basePath, "DECISIONS");
    let existingContent = null;
    if (existsSync(filePath)) {
      existingContent = readFileSync(filePath, "utf-8");
    }
    let md;
    if (existingContent && !isDecisionsTableFormat(existingContent)) {
      const marker = "---\n\n## Decisions Table";
      const markerIdx = existingContent.indexOf(marker);
      const freeformPart = markerIdx >= 0 ? existingContent.substring(0, markerIdx).trimEnd() : existingContent.trimEnd();
      md = freeformPart + "\n" + generateDecisionsAppendBlock(allDecisions);
    } else {
      md = generateDecisionsMd(allDecisions);
    }
    try {
      await saveFile(filePath, md);
    } catch (diskErr) {
      logWarning("projection", "DECISIONS.md projection write failed; DB decision remains committed", { fn: "saveDecisionToDb", id, error: String(diskErr.message) });
    }
    try {
      const sliceRef = extractDeferredSliceRef(fields);
      if (sliceRef) {
        db.updateSliceStatus(sliceRef.milestoneId, sliceRef.sliceId, "deferred");
      }
    } catch (deferErr) {
      logError("manifest", "failed to update deferred slice status", {
        fn: "saveDecisionToDb",
        error: String(deferErr.message)
      });
    }
    invalidateStateCache();
    clearPathCache();
    clearParseCache();
    return { id };
  } catch (err) {
    logError("manifest", "saveDecisionToDb failed", { fn: "saveDecisionToDb", error: String(err.message) });
    throw err;
  } finally {
    release();
  }
}
async function mirrorDecisionToMemory(id, normalizedFields) {
  try {
    const { createMemory } = await import("./memory-store.js");
    const { synthesizeDecisionMemoryContent } = await import("./memory-backfill.js");
    const content = synthesizeDecisionMemoryContent(normalizedFields);
    if (!content) return false;
    createMemory({
      category: "architecture",
      content,
      scope: normalizedFields.scope || "project",
      confidence: 0.85,
      structuredFields: {
        sourceDecisionId: id,
        when_context: normalizedFields.when_context,
        scope: normalizedFields.scope,
        decision: normalizedFields.decision,
        choice: normalizedFields.choice,
        rationale: normalizedFields.rationale,
        made_by: normalizedFields.made_by,
        revisable: normalizedFields.revisable,
        // New decisions are always written as active; md-importer can later
        // set superseded_by on the source decision row, and the backfill's
        // drift auto-heal pass propagates that update to this memory.
        superseded_by: null
      }
    });
    return true;
  } catch (mirrorErr) {
    logError("manifest", "memory-store mirror write failed", {
      fn: "saveDecisionToDb",
      decisionId: id,
      error: String(mirrorErr.message)
    });
    return false;
  }
}
function extractDeferredSliceRef(fields) {
  const isDeferral = /\bdefer(?:ral|red|ring|s)?\b/i.test(fields.scope) || /\bdefer(?:ral|red|ring|s)?\b/i.test(fields.choice) || /\bdefer(?:ral|red|ring|s)?\b/i.test(fields.decision);
  if (!isDeferral) return null;
  const slicePattern = /\b(M\d{3,4})\/(S\d{2,3})\b/;
  const choiceMatch = fields.choice.match(slicePattern);
  if (choiceMatch) {
    return { milestoneId: choiceMatch[1], sliceId: choiceMatch[2] };
  }
  const decisionMatch = fields.decision.match(slicePattern);
  if (decisionMatch) {
    return { milestoneId: decisionMatch[1], sliceId: decisionMatch[2] };
  }
  return null;
}
async function updateRequirementInDb(id, updates, basePath) {
  try {
    const db = await import("./gsd-db.js");
    const existing = db.getRequirementById(id);
    const base = existing ?? {
      id,
      class: "",
      status: "active",
      description: "",
      why: "",
      source: "",
      primary_owner: "",
      supporting_slices: "",
      validation: "",
      notes: "",
      full_content: "",
      superseded_by: null
    };
    const merged = {
      ...base,
      ...updates,
      id: base.id
      // ID cannot be changed
    };
    db.upsertRequirement(merged);
    const adapter = db._getAdapter();
    let allRequirements = [];
    if (adapter) {
      const rows = adapter.prepare("SELECT * FROM requirements ORDER BY id").all();
      allRequirements = rows.map((row) => ({
        id: row["id"],
        class: row["class"],
        status: row["status"],
        description: row["description"],
        why: row["why"],
        source: row["source"],
        primary_owner: row["primary_owner"],
        supporting_slices: row["supporting_slices"],
        validation: row["validation"],
        notes: row["notes"],
        full_content: row["full_content"],
        superseded_by: row["superseded_by"] ?? null
      }));
    }
    const nonSuperseded = allRequirements.filter((r) => r.superseded_by == null);
    const md = generateRequirementsMd(nonSuperseded);
    const filePath = resolveGsdRootFile(basePath, "REQUIREMENTS");
    try {
      await saveFile(filePath, md);
    } catch (diskErr) {
      logWarning("projection", "REQUIREMENTS.md projection write failed; DB requirement update remains committed", { fn: "updateRequirementInDb", id, error: String(diskErr.message) });
    }
    invalidateStateCache();
    clearPathCache();
    clearParseCache();
  } catch (err) {
    logError("manifest", "updateRequirementInDb failed", { fn: "updateRequirementInDb", error: String(err.message) });
    throw err;
  }
}
async function saveArtifactToDbForWorkspace(workspace, opts) {
  try {
    const db = await import("./gsd-db.js");
    const gsdDir = workspace.contract.projectGsd;
    const fullPath = resolve(gsdDir, opts.path);
    const rel0 = relative(gsdDir, fullPath);
    if (rel0.startsWith("..") || isAbsolute(rel0)) {
      throw new GSDError(GSD_IO_ERROR, `saveArtifactToDbForWorkspace: path escapes .gsd/ directory: ${opts.path}`);
    }
    let contentToPersist = opts.content;
    if (opts.artifact_type === "REQUIREMENTS" && opts.path === "REQUIREMENTS.md") {
      const activeRequirements = db.getActiveRequirements();
      if (activeRequirements.length === 0) {
        throw new GSDError(GSD_STALE_STATE, "saveArtifactToDbForWorkspace: REQUIREMENTS final save requires active DB-backed requirements");
      }
      contentToPersist = generateRequirementsMd(activeRequirements);
    }
    let skipDiskWrite = false;
    if (!isRootCanonicalArtifact(opts) && existsSync(fullPath)) {
      const existingSize = statSync(fullPath).size;
      const newSize = Buffer.byteLength(contentToPersist, "utf-8");
      if (existingSize > 0 && newSize < existingSize * 0.5) {
        logWarning("projection", `new content (${newSize}B) is <50% of existing projection (${existingSize}B), preserving disk file while DB remains authoritative`, { fn: "saveArtifactToDbForWorkspace", path: opts.path });
        skipDiskWrite = true;
      }
    }
    db.insertArtifact({
      path: opts.path,
      artifact_type: opts.artifact_type,
      milestone_id: null,
      slice_id: null,
      task_id: null,
      full_content: contentToPersist
    });
    if (!skipDiskWrite) {
      try {
        await saveFile(fullPath, contentToPersist);
      } catch (diskErr) {
        logWarning("projection", "artifact projection write failed; DB artifact remains committed", { fn: "saveArtifactToDbForWorkspace", path: opts.path, error: String(diskErr.message) });
      }
    }
    invalidateStateCache();
    clearPathCache();
    clearParseCache();
  } catch (err) {
    logError("manifest", "saveArtifactToDbForWorkspace failed", { fn: "saveArtifactToDbForWorkspace", error: String(err.message) });
    throw err;
  }
}
async function saveArtifactToDbByScope(scope, opts) {
  if (!scope.milestoneId) {
    throw new GSDError(GSD_IO_ERROR, `saveArtifactToDbByScope: milestoneId is empty \u2014 use saveArtifactToDbForWorkspace for root artifacts`);
  }
  try {
    const db = await import("./gsd-db.js");
    const gsdDir = scope.workspace.contract.projectGsd;
    const fullPath = resolve(gsdDir, opts.path);
    const rel1 = relative(gsdDir, fullPath);
    if (rel1.startsWith("..") || isAbsolute(rel1)) {
      throw new GSDError(GSD_IO_ERROR, `saveArtifactToDbByScope: path escapes .gsd/ directory: ${opts.path}`);
    }
    let contentToPersist = opts.content;
    if (opts.artifact_type === "REQUIREMENTS" && opts.path === "REQUIREMENTS.md") {
      const activeRequirements = db.getActiveRequirements();
      if (activeRequirements.length === 0) {
        throw new GSDError(GSD_STALE_STATE, "saveArtifactToDbByScope: REQUIREMENTS final save requires active DB-backed requirements");
      }
      contentToPersist = generateRequirementsMd(activeRequirements);
    }
    let skipDiskWrite = false;
    if (!isRootCanonicalArtifact(opts) && existsSync(fullPath)) {
      const existingSize = statSync(fullPath).size;
      const newSize = Buffer.byteLength(contentToPersist, "utf-8");
      if (existingSize > 0 && newSize < existingSize * 0.5) {
        logWarning("projection", `new content (${newSize}B) is <50% of existing projection (${existingSize}B), preserving disk file while DB remains authoritative`, { fn: "saveArtifactToDbByScope", path: opts.path });
        skipDiskWrite = true;
      }
    }
    db.insertArtifact({
      path: opts.path,
      artifact_type: opts.artifact_type,
      milestone_id: opts.milestone_id ?? null,
      slice_id: opts.slice_id ?? null,
      task_id: opts.task_id ?? null,
      full_content: contentToPersist
    });
    if (!skipDiskWrite) {
      try {
        await saveFile(fullPath, contentToPersist);
      } catch (diskErr) {
        logWarning("projection", "artifact projection write failed; DB artifact remains committed", { fn: "saveArtifactToDbByScope", path: opts.path, error: String(diskErr.message) });
      }
    }
    invalidateStateCache();
    clearPathCache();
    clearParseCache();
  } catch (err) {
    logError("manifest", "saveArtifactToDbByScope failed", { fn: "saveArtifactToDbByScope", error: String(err.message) });
    throw err;
  }
}
async function saveArtifactToDb(opts, basePath) {
  const workspace = createWorkspace(basePath);
  const milestoneId = opts.milestone_id;
  if (milestoneId) {
    return saveArtifactToDbByScope(scopeMilestone(workspace, milestoneId), opts);
  }
  return saveArtifactToDbForWorkspace(workspace, opts);
}
export {
  _resetDecisionSaveLock,
  extractDeferredSliceRef,
  generateDecisionsMd,
  generateRequirementsMd,
  isDecisionsTableFormat,
  nextDecisionId,
  nextRequirementId,
  saveArtifactToDb,
  saveArtifactToDbByScope,
  saveArtifactToDbForWorkspace,
  saveDecisionToDb,
  saveRequirementToDb,
  updateRequirementInDb
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kYi13cml0ZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRCBEQiBXcml0ZXIgXHUyMDE0IE1hcmtkb3duIGdlbmVyYXRvcnMgKyBEQi1maXJzdCB3cml0ZSBoZWxwZXJzXG4vL1xuLy8gVGhlIG1pc3NpbmcgREJcdTIxOTJtYXJrZG93biBkaXJlY3Rpb24uIFMwMyBlc3RhYmxpc2hlZCBtYXJrZG93blx1MjE5MkRCIChtZC1pbXBvcnRlci50cykuXG4vLyBUaGlzIG1vZHVsZSBnZW5lcmF0ZXMgREVDSVNJT05TLm1kIGFuZCBSRVFVSVJFTUVOVFMubWQgZnJvbSBEQiBzdGF0ZSxcbi8vIGNvbXB1dGVzIG5leHQgZGVjaXNpb24gSURzLCBhbmQgcHJvdmlkZXMgd3JpdGUgaGVscGVycyB0aGF0IHVwc2VydCB0byBEQlxuLy8gdGhlbiByZWdlbmVyYXRlIHRoZSBjb3JyZXNwb25kaW5nIG1hcmtkb3duIGZpbGUuXG4vL1xuLy8gQ3JpdGljYWwgaW52YXJpYW50OiBnZW5lcmF0ZWQgbWFya2Rvd24gbXVzdCByb3VuZC10cmlwIHRocm91Z2hcbi8vIHBhcnNlRGVjaXNpb25zVGFibGUoKSBhbmQgcGFyc2VSZXF1aXJlbWVudHNTZWN0aW9ucygpIHdpdGggZmllbGQgZmlkZWxpdHkuXG5cbmltcG9ydCB7IGlzQWJzb2x1dGUsIGpvaW4sIHJlbGF0aXZlLCByZXNvbHZlIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHJlYWRGaWxlU3luYywgZXhpc3RzU3luYywgc3RhdFN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB0eXBlIHsgRGVjaXNpb24sIFJlcXVpcmVtZW50IH0gZnJvbSAnLi90eXBlcy5qcyc7XG5pbXBvcnQgeyByZXNvbHZlR3NkUm9vdEZpbGUgfSBmcm9tICcuL3BhdGhzLmpzJztcbmltcG9ydCB7IHNhdmVGaWxlIH0gZnJvbSAnLi9maWxlcy5qcyc7XG5pbXBvcnQgeyBHU0RFcnJvciwgR1NEX1NUQUxFX1NUQVRFLCBHU0RfSU9fRVJST1IgfSBmcm9tICcuL2Vycm9ycy5qcyc7XG5pbXBvcnQgeyBsb2dXYXJuaW5nLCBsb2dFcnJvciB9IGZyb20gJy4vd29ya2Zsb3ctbG9nZ2VyLmpzJztcbmltcG9ydCB7IGludmFsaWRhdGVTdGF0ZUNhY2hlIH0gZnJvbSAnLi9zdGF0ZS5qcyc7XG5pbXBvcnQgeyBjbGVhclBhdGhDYWNoZSB9IGZyb20gJy4vcGF0aHMuanMnO1xuaW1wb3J0IHsgY2xlYXJQYXJzZUNhY2hlIH0gZnJvbSAnLi9maWxlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IE1pbGVzdG9uZVNjb3BlLCBHc2RXb3Jrc3BhY2UgfSBmcm9tICcuL3dvcmtzcGFjZS5qcyc7XG5pbXBvcnQgeyBjcmVhdGVXb3Jrc3BhY2UsIHNjb3BlTWlsZXN0b25lIH0gZnJvbSAnLi93b3Jrc3BhY2UuanMnO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRnJlZWZvcm0gRGV0ZWN0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIERldGVjdCB3aGV0aGVyIGEgREVDSVNJT05TLm1kIGZpbGUgaXMgaW4gY2Fub25pY2FsIHRhYmxlIGZvcm1hdFxuICogKGdlbmVyYXRlZCBieSBnZW5lcmF0ZURlY2lzaW9uc01kKS5cbiAqXG4gKiBSZXR1cm5zIHRydWUgb25seSBpZiB0aGUgZmlsZSBzdGFydHMgd2l0aCB0aGUgY2Fub25pY2FsIGhlYWRlclxuICogKFwiIyBEZWNpc2lvbnMgUmVnaXN0ZXJcIikgdGhhdCBnZW5lcmF0ZURlY2lzaW9uc01kIHByb2R1Y2VzLlxuICogRmlsZXMgd2l0aCBmcmVlZm9ybSBjb250ZW50IFx1MjAxNCBldmVuIGlmIHRoZXkgY29udGFpbiBhbiBhcHBlbmRlZFxuICogZGVjaXNpb25zIHRhYmxlIHNlY3Rpb24gXHUyMDE0IHJldHVybiBmYWxzZSBzbyB0aGUgZnJlZWZvcm0gY29udGVudFxuICogaXMgcHJlc2VydmVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNEZWNpc2lvbnNUYWJsZUZvcm1hdChjb250ZW50OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgLy8gVGhlIGNhbm9uaWNhbCBmb3JtYXQgYWx3YXlzIHN0YXJ0cyB3aXRoIFwiIyBEZWNpc2lvbnMgUmVnaXN0ZXJcIlxuICBjb25zdCBmaXJzdExpbmUgPSBjb250ZW50LnNwbGl0KCdcXG4nKVswXT8udHJpbSgpID8/ICcnO1xuICBpZiAoZmlyc3RMaW5lICE9PSAnIyBEZWNpc2lvbnMgUmVnaXN0ZXInKSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gQWRkaXRpb25hbGx5IHZlcmlmeSB0aGUgZmlsZSBoYXMgdGhlIGNhbm9uaWNhbCB0YWJsZSBoZWFkZXJcbiAgcmV0dXJuIGNvbnRlbnQuaW5jbHVkZXMoJ3wgIyB8IFdoZW4gfCBTY29wZSB8IERlY2lzaW9uIHwgQ2hvaWNlIHwgUmF0aW9uYWxlIHwgUmV2aXNhYmxlPycpO1xufVxuXG4vKipcbiAqIEdlbmVyYXRlIGEgbWluaW1hbCBkZWNpc2lvbnMgdGFibGUgc2VjdGlvbiAoaGVhZGVyICsgcm93cykgZm9yIGFwcGVuZGluZ1xuICogdG8gYSBmcmVlZm9ybSBERUNJU0lPTlMubWQgZmlsZS5cbiAqL1xuZnVuY3Rpb24gZ2VuZXJhdGVEZWNpc2lvbnNBcHBlbmRCbG9jayhkZWNpc2lvbnM6IERlY2lzaW9uW10pOiBzdHJpbmcge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGluZXMucHVzaCgnJyk7XG4gIGxpbmVzLnB1c2goJy0tLScpO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgbGluZXMucHVzaCgnIyMgRGVjaXNpb25zIFRhYmxlJyk7XG4gIGxpbmVzLnB1c2goJycpO1xuICBsaW5lcy5wdXNoKCd8ICMgfCBXaGVuIHwgU2NvcGUgfCBEZWNpc2lvbiB8IENob2ljZSB8IFJhdGlvbmFsZSB8IFJldmlzYWJsZT8gfCBNYWRlIEJ5IHwnKTtcbiAgbGluZXMucHVzaCgnfC0tLXwtLS0tLS18LS0tLS0tLXwtLS0tLS0tLS0tfC0tLS0tLS0tfC0tLS0tLS0tLS0tfC0tLS0tLS0tLS0tLXwtLS0tLS0tLS18Jyk7XG5cbiAgZm9yIChjb25zdCBkIG9mIGRlY2lzaW9ucykge1xuICAgIGNvbnN0IGNlbGxzID0gW1xuICAgICAgZC5pZCxcbiAgICAgIGQud2hlbl9jb250ZXh0LFxuICAgICAgZC5zY29wZSxcbiAgICAgIGQuZGVjaXNpb24sXG4gICAgICBkLmNob2ljZSxcbiAgICAgIGQucmF0aW9uYWxlLFxuICAgICAgZC5yZXZpc2FibGUsXG4gICAgICBkLm1hZGVfYnkgPz8gJ2FnZW50JyxcbiAgICBdLm1hcChjZWxsID0+IChjZWxsID8/ICcnKS5yZXBsYWNlKC9cXHwvZywgJ1xcXFx8JykpO1xuICAgIGxpbmVzLnB1c2goYHwgJHtjZWxscy5qb2luKCcgfCAnKX0gfGApO1xuICB9XG5cbiAgcmV0dXJuIGxpbmVzLmpvaW4oJ1xcbicpICsgJ1xcbic7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBNYXJrZG93biBHZW5lcmF0b3JzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEdlbmVyYXRlIGZ1bGwgREVDSVNJT05TLm1kIGNvbnRlbnQgZnJvbSBhbiBhcnJheSBvZiBEZWNpc2lvbiBvYmplY3RzLlxuICogUHJvZHVjZXMgdGhlIGNhbm9uaWNhbCBmb3JtYXQ6IEgxIGhlYWRlciwgSFRNTCBjb21tZW50IGJsb2NrLCB0YWJsZSBoZWFkZXIsXG4gKiBzZXBhcmF0b3IsIGFuZCBvbmUgZGF0YSByb3cgcGVyIGRlY2lzaW9uLlxuICpcbiAqIENvbHVtbiBvcmRlcjogIywgV2hlbiwgU2NvcGUsIERlY2lzaW9uLCBDaG9pY2UsIFJhdGlvbmFsZSwgUmV2aXNhYmxlP1xuICovXG5leHBvcnQgZnVuY3Rpb24gZ2VuZXJhdGVEZWNpc2lvbnNNZChkZWNpc2lvbnM6IERlY2lzaW9uW10pOiBzdHJpbmcge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblxuICBsaW5lcy5wdXNoKCcjIERlY2lzaW9ucyBSZWdpc3RlcicpO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgbGluZXMucHVzaCgnPCEtLSBBcHBlbmQtb25seS4gTmV2ZXIgZWRpdCBvciByZW1vdmUgZXhpc3Rpbmcgcm93cy4nKTtcbiAgbGluZXMucHVzaCgnICAgICBUbyByZXZlcnNlIGEgZGVjaXNpb24sIGFkZCBhIG5ldyByb3cgdGhhdCBzdXBlcnNlZGVzIGl0LicpO1xuICBsaW5lcy5wdXNoKCcgICAgIFJlYWQgdGhpcyBmaWxlIGF0IHRoZSBzdGFydCBvZiBhbnkgcGxhbm5pbmcgb3IgcmVzZWFyY2ggcGhhc2UuIC0tPicpO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgbGluZXMucHVzaCgnfCAjIHwgV2hlbiB8IFNjb3BlIHwgRGVjaXNpb24gfCBDaG9pY2UgfCBSYXRpb25hbGUgfCBSZXZpc2FibGU/IHwgTWFkZSBCeSB8Jyk7XG4gIGxpbmVzLnB1c2goJ3wtLS18LS0tLS0tfC0tLS0tLS18LS0tLS0tLS0tLXwtLS0tLS0tLXwtLS0tLS0tLS0tLXwtLS0tLS0tLS0tLS18LS0tLS0tLS0tfCcpO1xuXG4gIGZvciAoY29uc3QgZCBvZiBkZWNpc2lvbnMpIHtcbiAgICAvLyBFc2NhcGUgcGlwZSBjaGFyYWN0ZXJzIHdpdGhpbiBjZWxsIHZhbHVlcyB0byBwcmVzZXJ2ZSB0YWJsZSBzdHJ1Y3R1cmVcbiAgICBjb25zdCBjZWxscyA9IFtcbiAgICAgIGQuaWQsXG4gICAgICBkLndoZW5fY29udGV4dCxcbiAgICAgIGQuc2NvcGUsXG4gICAgICBkLmRlY2lzaW9uLFxuICAgICAgZC5jaG9pY2UsXG4gICAgICBkLnJhdGlvbmFsZSxcbiAgICAgIGQucmV2aXNhYmxlLFxuICAgICAgZC5tYWRlX2J5ID8/ICdhZ2VudCcsXG4gICAgXS5tYXAoY2VsbCA9PiAoY2VsbCA/PyAnJykucmVwbGFjZSgvXFx8L2csICdcXFxcfCcpKTtcblxuICAgIGxpbmVzLnB1c2goYHwgJHtjZWxscy5qb2luKCcgfCAnKX0gfGApO1xuICB9XG5cbiAgcmV0dXJuIGxpbmVzLmpvaW4oJ1xcbicpICsgJ1xcbic7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZXF1aXJlbWVudHMgTWFya2Rvd24gR2VuZXJhdG9yIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogU3RhdHVzIHZhbHVlcyB0aGF0IG1hcCB0byBzcGVjaWZpYyBzZWN0aW9ucywgaW4gZGlzcGxheSBvcmRlci4gKi9cbmNvbnN0IFNUQVRVU19TRUNUSU9OX01BUDogQXJyYXk8eyBzdGF0dXM6IHN0cmluZzsgaGVhZGluZzogc3RyaW5nIH0+ID0gW1xuICB7IHN0YXR1czogJ2FjdGl2ZScsIGhlYWRpbmc6ICdBY3RpdmUnIH0sXG4gIHsgc3RhdHVzOiAndmFsaWRhdGVkJywgaGVhZGluZzogJ1ZhbGlkYXRlZCcgfSxcbiAgeyBzdGF0dXM6ICdkZWZlcnJlZCcsIGhlYWRpbmc6ICdEZWZlcnJlZCcgfSxcbiAgeyBzdGF0dXM6ICdvdXQtb2Ytc2NvcGUnLCBoZWFkaW5nOiAnT3V0IG9mIFNjb3BlJyB9LFxuXTtcblxuLyoqXG4gKiBHZW5lcmF0ZSBmdWxsIFJFUVVJUkVNRU5UUy5tZCBjb250ZW50IGZyb20gYW4gYXJyYXkgb2YgUmVxdWlyZW1lbnQgb2JqZWN0cy5cbiAqIEdyb3VwcyByZXF1aXJlbWVudHMgYnkgc3RhdHVzIGludG8gc2VjdGlvbnMgKCMjIEFjdGl2ZSwgIyMgVmFsaWRhdGVkLCBldGMuKSxcbiAqIGVhY2ggY29udGFpbmluZyAjIyMgUlhYWCBcdTIwMTQgRGVzY3JpcHRpb24gaGVhZGluZ3Mgd2l0aCBidWxsZXQgZmllbGRzLiBFbXB0eVxuICogc3RhdHVzIHNlY3Rpb25zIGFyZSBlbWl0dGVkIHRvbyBiZWNhdXNlIHRoZSBkZWVwLW1vZGUgdmFsaWRhdG9yIHRyZWF0cyB0aGVpclxuICogcHJlc2VuY2UgYXMgcGFydCBvZiB0aGUgY2Fub25pY2FsIGNvbnRyYWN0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2VuZXJhdGVSZXF1aXJlbWVudHNNZChyZXF1aXJlbWVudHM6IFJlcXVpcmVtZW50W10pOiBzdHJpbmcge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblxuICBsaW5lcy5wdXNoKCcjIFJlcXVpcmVtZW50cycpO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgbGluZXMucHVzaCgnVGhpcyBmaWxlIGlzIHRoZSBleHBsaWNpdCBjYXBhYmlsaXR5IGFuZCBjb3ZlcmFnZSBjb250cmFjdCBmb3IgdGhlIHByb2plY3QuJyk7XG4gIGxpbmVzLnB1c2goJycpO1xuXG4gIC8vIEdyb3VwIGJ5IHN0YXR1c1xuICBjb25zdCBieVN0YXR1cyA9IG5ldyBNYXA8c3RyaW5nLCBSZXF1aXJlbWVudFtdPigpO1xuICBmb3IgKGNvbnN0IHIgb2YgcmVxdWlyZW1lbnRzKSB7XG4gICAgY29uc3Qgc3RhdHVzID0gKHIuc3RhdHVzIHx8ICdhY3RpdmUnKS50b0xvd2VyQ2FzZSgpO1xuICAgIGlmICghYnlTdGF0dXMuaGFzKHN0YXR1cykpIGJ5U3RhdHVzLnNldChzdGF0dXMsIFtdKTtcbiAgICBieVN0YXR1cy5nZXQoc3RhdHVzKSEucHVzaChyKTtcbiAgfVxuXG4gIC8vIEVtaXQgc2VjdGlvbnMgaW4gY2Fub25pY2FsIG9yZGVyXG4gIGZvciAoY29uc3QgeyBzdGF0dXMsIGhlYWRpbmcgfSBvZiBTVEFUVVNfU0VDVElPTl9NQVApIHtcbiAgICBjb25zdCByZXFzID0gYnlTdGF0dXMuZ2V0KHN0YXR1cyk7XG4gICAgbGluZXMucHVzaChgIyMgJHtoZWFkaW5nfWApO1xuICAgIGxpbmVzLnB1c2goJycpO1xuXG4gICAgZm9yIChjb25zdCByIG9mIHJlcXMgPz8gW10pIHtcbiAgICAgIGxpbmVzLnB1c2goYCMjIyAke3IuaWR9IFx1MjAxNCAke3IuZGVzY3JpcHRpb24gfHwgJ1VudGl0bGVkJ31gKTtcblxuICAgICAgLy8gRW1pdCBidWxsZXQgZmllbGRzIFx1MjAxNCBvbmx5IHRob3NlIHdpdGggY29udGVudFxuICAgICAgaWYgKHIuY2xhc3MpIGxpbmVzLnB1c2goYC0gQ2xhc3M6ICR7ci5jbGFzc31gKTtcbiAgICAgIGlmIChyLnN0YXR1cykgbGluZXMucHVzaChgLSBTdGF0dXM6ICR7ci5zdGF0dXN9YCk7XG4gICAgICBpZiAoci5kZXNjcmlwdGlvbikgbGluZXMucHVzaChgLSBEZXNjcmlwdGlvbjogJHtyLmRlc2NyaXB0aW9ufWApO1xuICAgICAgaWYgKHIud2h5KSBsaW5lcy5wdXNoKGAtIFdoeSBpdCBtYXR0ZXJzOiAke3Iud2h5fWApO1xuICAgICAgaWYgKHIuc291cmNlKSBsaW5lcy5wdXNoKGAtIFNvdXJjZTogJHtyLnNvdXJjZX1gKTtcbiAgICAgIGlmIChyLnByaW1hcnlfb3duZXIpIGxpbmVzLnB1c2goYC0gUHJpbWFyeSBvd25pbmcgc2xpY2U6ICR7ci5wcmltYXJ5X293bmVyfWApO1xuICAgICAgaWYgKHIuc3VwcG9ydGluZ19zbGljZXMpIGxpbmVzLnB1c2goYC0gU3VwcG9ydGluZyBzbGljZXM6ICR7ci5zdXBwb3J0aW5nX3NsaWNlc31gKTtcbiAgICAgIGlmIChyLnZhbGlkYXRpb24pIGxpbmVzLnB1c2goYC0gVmFsaWRhdGlvbjogJHtyLnZhbGlkYXRpb259YCk7XG4gICAgICBpZiAoci5ub3RlcykgbGluZXMucHVzaChgLSBOb3RlczogJHtyLm5vdGVzfWApO1xuICAgICAgbGluZXMucHVzaCgnJyk7XG4gICAgfVxuICB9XG5cbiAgLy8gVHJhY2VhYmlsaXR5IHRhYmxlXG4gIGxpbmVzLnB1c2goJyMjIFRyYWNlYWJpbGl0eScpO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgbGluZXMucHVzaCgnfCBJRCB8IENsYXNzIHwgU3RhdHVzIHwgUHJpbWFyeSBvd25lciB8IFN1cHBvcnRpbmcgfCBQcm9vZiB8Jyk7XG4gIGxpbmVzLnB1c2goJ3wtLS18LS0tfC0tLXwtLS18LS0tfC0tLXwnKTtcblxuICBmb3IgKGNvbnN0IHIgb2YgcmVxdWlyZW1lbnRzKSB7XG4gICAgY29uc3QgcHJvb2YgPSByLnZhbGlkYXRpb24gfHwgJ3VubWFwcGVkJztcbiAgICBsaW5lcy5wdXNoKFxuICAgICAgYHwgJHtyLmlkfSB8ICR7ci5jbGFzcyB8fCAnJ30gfCAke3Iuc3RhdHVzIHx8ICcnfSB8ICR7ci5wcmltYXJ5X293bmVyIHx8ICdub25lJ30gfCAke3Iuc3VwcG9ydGluZ19zbGljZXMgfHwgJ25vbmUnfSB8ICR7cHJvb2Z9IHxgLFxuICAgICk7XG4gIH1cblxuICBsaW5lcy5wdXNoKCcnKTtcblxuICAvLyBDb3ZlcmFnZSBTdW1tYXJ5XG4gIGNvbnN0IGFjdGl2ZUNvdW50ID0gYnlTdGF0dXMuZ2V0KCdhY3RpdmUnKT8ubGVuZ3RoID8/IDA7XG4gIGNvbnN0IHZhbGlkYXRlZFJlcXMgPSBieVN0YXR1cy5nZXQoJ3ZhbGlkYXRlZCcpID8/IFtdO1xuICBjb25zdCB2YWxpZGF0ZWRJZHMgPSB2YWxpZGF0ZWRSZXFzLm1hcChyID0+IHIuaWQpLmpvaW4oJywgJyk7XG5cbiAgbGluZXMucHVzaCgnIyMgQ292ZXJhZ2UgU3VtbWFyeScpO1xuICBsaW5lcy5wdXNoKCcnKTtcbiAgbGluZXMucHVzaChgLSBBY3RpdmUgcmVxdWlyZW1lbnRzOiAke2FjdGl2ZUNvdW50fWApO1xuICBsaW5lcy5wdXNoKGAtIE1hcHBlZCB0byBzbGljZXM6ICR7YWN0aXZlQ291bnR9YCk7XG4gIGxpbmVzLnB1c2goYC0gVmFsaWRhdGVkOiAke3ZhbGlkYXRlZFJlcXMubGVuZ3RofSR7dmFsaWRhdGVkSWRzID8gYCAoJHt2YWxpZGF0ZWRJZHN9KWAgOiAnJ31gKTtcbiAgbGluZXMucHVzaChgLSBVbm1hcHBlZCBhY3RpdmUgcmVxdWlyZW1lbnRzOiAwYCk7XG5cbiAgcmV0dXJuIGxpbmVzLmpvaW4oJ1xcbicpICsgJ1xcbic7XG59XG5cbmZ1bmN0aW9uIGlzUm9vdENhbm9uaWNhbEFydGlmYWN0KG9wdHM6IFNhdmVBcnRpZmFjdE9wdHMpOiBib29sZWFuIHtcbiAgaWYgKG9wdHMubWlsZXN0b25lX2lkIHx8IG9wdHMuc2xpY2VfaWQgfHwgb3B0cy50YXNrX2lkKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiAoXG4gICAgb3B0cy5hcnRpZmFjdF90eXBlID09PSAnUFJPSkVDVCcgfHxcbiAgICBvcHRzLmFydGlmYWN0X3R5cGUgPT09ICdSRVFVSVJFTUVOVFMnXG4gICk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBOZXh0IERlY2lzaW9uIElEIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIENvbXB1dGUgdGhlIG5leHQgZGVjaXNpb24gSUQgZnJvbSB0aGUgY3VycmVudCBEQiBzdGF0ZS5cbiAqIFF1ZXJpZXMgTUFYKENBU1QoU1VCU1RSKGlkLCAyKSBBUyBJTlRFR0VSKSkgZnJvbSBkZWNpc2lvbnMgdGFibGUuXG4gKiBSZXR1cm5zIEQwMDEgaWYgbm8gZGVjaXNpb25zIGV4aXN0LiBaZXJvLXBhZHMgdG8gMyBkaWdpdHMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBuZXh0RGVjaXNpb25JZCgpOiBQcm9taXNlPHN0cmluZz4ge1xuICB0cnkge1xuICAgIGNvbnN0IGRiID0gYXdhaXQgaW1wb3J0KCcuL2dzZC1kYi5qcycpO1xuICAgIGNvbnN0IGFkYXB0ZXIgPSBkYi5fZ2V0QWRhcHRlcigpO1xuICAgIGlmICghYWRhcHRlcikgcmV0dXJuICdEMDAxJztcblxuICAgIGNvbnN0IHJvdyA9IGFkYXB0ZXJcbiAgICAgIC5wcmVwYXJlKCdTRUxFQ1QgTUFYKENBU1QoU1VCU1RSKGlkLCAyKSBBUyBJTlRFR0VSKSkgYXMgbWF4X251bSBGUk9NIGRlY2lzaW9ucycpXG4gICAgICAuZ2V0KCk7XG5cbiAgICBjb25zdCBtYXhOdW0gPSByb3cgPyAocm93WydtYXhfbnVtJ10gYXMgbnVtYmVyIHwgbnVsbCkgOiBudWxsO1xuICAgIGlmIChtYXhOdW0gPT0gbnVsbCB8fCBpc05hTihtYXhOdW0pKSByZXR1cm4gJ0QwMDEnO1xuXG4gICAgY29uc3QgbmV4dCA9IG1heE51bSArIDE7XG4gICAgcmV0dXJuIGBEJHtTdHJpbmcobmV4dCkucGFkU3RhcnQoMywgJzAnKX1gO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2dFcnJvcignbWFuaWZlc3QnLCAnbmV4dERlY2lzaW9uSWQgZmFpbGVkJywgeyBmbjogJ25leHREZWNpc2lvbklkJywgZXJyb3I6IFN0cmluZygoZXJyIGFzIEVycm9yKS5tZXNzYWdlKSB9KTtcbiAgICByZXR1cm4gJ0QwMDEnO1xuICB9XG59XG5cbi8qKlxuICogQURSLTAxMyBTdGFnZSAzOiBjb21wdXRlIHRoZSBuZXh0IGBEIyMjYCBpZGVudGlmaWVyIGFjcm9zcyBib3RoIHRoZSBsZWdhY3lcbiAqIGBkZWNpc2lvbnNgIHRhYmxlIEFORCB0aGUgYG1lbW9yaWVzLnN0cnVjdHVyZWRfZmllbGRzLnNvdXJjZURlY2lzaW9uSWRgXG4gKiBzdXJmYWNlLiBSZXR1cm5zIHRoZSBtYXggbnVtZXJpYyBzdWZmaXggZnJvbSBlaXRoZXIgc2lkZSArIDEsIHRocmVlLWRpZ2l0XG4gKiBwYWRkZWQuXG4gKlxuICogVXNlZCBieSBgc2F2ZURlY2lzaW9uVG9EYmAgb25jZSB3cml0ZXMgdG8gdGhlIGBkZWNpc2lvbnNgIHRhYmxlIHN0b3AgXHUyMDE0XG4gKiBuZXcgZGVjaXNpb25zIGxpdmUgb25seSBpbiBtZW1vcmllcywgYnV0IGhpc3RvcmljYWwgSURzIHNpdCBpbiBib3RoXG4gKiBwbGFjZXMgZHVyaW5nIHRoZSBjdXRvdmVyIGJha2UuIFRoZSBjcm9zcy1zdXJmYWNlIG1heCBrZWVwcyBJRHNcbiAqIG1vbm90b25pYyBhbmQgYXZvaWRzIGNvbGxpc2lvbnMgb24gdGhlIG5leHQgc2F2ZS5cbiAqL1xuZnVuY3Rpb24gbmV4dERlY2lzaW9uSWRBY3Jvc3NTdXJmYWNlcyhcbiAgYWRhcHRlcjogUmV0dXJuVHlwZTx0eXBlb2YgaW1wb3J0KCcuL2dzZC1kYi5qcycpLl9nZXRBZGFwdGVyPixcbik6IHN0cmluZyB7XG4gIGlmICghYWRhcHRlcikgcmV0dXJuICdEMDAxJztcblxuICBsZXQgbWF4TnVtID0gMDtcblxuICAvLyBMZWdhY3kgdGFibGUgXHUyMDE0IGJlc3QtZWZmb3J0LlxuICB0cnkge1xuICAgIGNvbnN0IHJvdyA9IGFkYXB0ZXJcbiAgICAgIC5wcmVwYXJlKCdTRUxFQ1QgTUFYKENBU1QoU1VCU1RSKGlkLCAyKSBBUyBJTlRFR0VSKSkgYXMgbWF4X251bSBGUk9NIGRlY2lzaW9ucycpXG4gICAgICAuZ2V0KCk7XG4gICAgY29uc3QgY2FuZGlkYXRlID0gcm93ID8gKHJvd1snbWF4X251bSddIGFzIG51bWJlciB8IG51bGwpIDogbnVsbDtcbiAgICBpZiAodHlwZW9mIGNhbmRpZGF0ZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKGNhbmRpZGF0ZSkpIHtcbiAgICAgIG1heE51bSA9IE1hdGgubWF4KG1heE51bSwgY2FuZGlkYXRlKTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIGZhbGwgdGhyb3VnaCB0byBtZW1vcnktb25seVxuICB9XG5cbiAgLy8gTWVtb3J5IHN1cmZhY2U6IHNjYW4gc3RydWN0dXJlZEZpZWxkcy5zb3VyY2VEZWNpc2lvbklkIGZvciBEIyMjIHZhbHVlcy5cbiAgLy8gU1FMaXRlIExJS0Ugb24gdGhlIEpTT04tc3RyaW5naWZpZWQgZmllbGQgaXMgc3VmZmljaWVudCBcdTIwMTQgcm93cyB0YWdnZWRcbiAgLy8gd2l0aCBzb3VyY2VEZWNpc2lvbklkIGFyZSBib3VuZGVkIGJ5IHRoZSBkZWNpc2lvbnMgY291bnQuXG4gIHRyeSB7XG4gICAgY29uc3Qgcm93cyA9IGFkYXB0ZXJcbiAgICAgIC5wcmVwYXJlKFxuICAgICAgICBcIlNFTEVDVCBzdHJ1Y3R1cmVkX2ZpZWxkcyBGUk9NIG1lbW9yaWVzIFdIRVJFIHN0cnVjdHVyZWRfZmllbGRzIExJS0UgJyVcXFwic291cmNlRGVjaXNpb25JZFxcXCI6XFxcIkQlJ1wiLFxuICAgICAgKVxuICAgICAgLmFsbCgpIGFzIEFycmF5PHsgc3RydWN0dXJlZF9maWVsZHM6IHN0cmluZyB8IG51bGwgfT47XG4gICAgZm9yIChjb25zdCByb3cgb2Ygcm93cykge1xuICAgICAgaWYgKCFyb3cuc3RydWN0dXJlZF9maWVsZHMpIGNvbnRpbnVlO1xuICAgICAgbGV0IHNmOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHNmID0gSlNPTi5wYXJzZShyb3cuc3RydWN0dXJlZF9maWVsZHMpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3Qgc291cmNlSWQgPSBzZlsnc291cmNlRGVjaXNpb25JZCddO1xuICAgICAgaWYgKHR5cGVvZiBzb3VyY2VJZCAhPT0gJ3N0cmluZycgfHwgIXNvdXJjZUlkLnN0YXJ0c1dpdGgoJ0QnKSkgY29udGludWU7XG4gICAgICBjb25zdCBudW0gPSBwYXJzZUludChzb3VyY2VJZC5zbGljZSgxKSwgMTApO1xuICAgICAgaWYgKE51bWJlci5pc0Zpbml0ZShudW0pICYmIG51bSA+IG1heE51bSkgbWF4TnVtID0gbnVtO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gYmVzdC1lZmZvcnRcbiAgfVxuXG4gIGNvbnN0IG5leHQgPSBtYXhOdW0gKyAxO1xuICByZXR1cm4gYEQke1N0cmluZyhuZXh0KS5wYWRTdGFydCgzLCAnMCcpfWA7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBOZXh0IFJlcXVpcmVtZW50IElEIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIENvbXB1dGUgdGhlIG5leHQgcmVxdWlyZW1lbnQgSUQgZnJvbSB0aGUgY3VycmVudCBEQiBzdGF0ZS5cbiAqIFF1ZXJpZXMgTUFYKENBU1QoU1VCU1RSKGlkLCAyKSBBUyBJTlRFR0VSKSkgZnJvbSByZXF1aXJlbWVudHMgdGFibGUuXG4gKiBSZXR1cm5zIFIwMDEgaWYgbm8gcmVxdWlyZW1lbnRzIGV4aXN0LiBaZXJvLXBhZHMgdG8gMyBkaWdpdHMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBuZXh0UmVxdWlyZW1lbnRJZCgpOiBQcm9taXNlPHN0cmluZz4ge1xuICB0cnkge1xuICAgIGNvbnN0IGRiID0gYXdhaXQgaW1wb3J0KCcuL2dzZC1kYi5qcycpO1xuICAgIGNvbnN0IGFkYXB0ZXIgPSBkYi5fZ2V0QWRhcHRlcigpO1xuICAgIGlmICghYWRhcHRlcikgcmV0dXJuICdSMDAxJztcblxuICAgIGNvbnN0IHJvdyA9IGFkYXB0ZXJcbiAgICAgIC5wcmVwYXJlKCdTRUxFQ1QgTUFYKENBU1QoU1VCU1RSKGlkLCAyKSBBUyBJTlRFR0VSKSkgYXMgbWF4X251bSBGUk9NIHJlcXVpcmVtZW50cycpXG4gICAgICAuZ2V0KCk7XG5cbiAgICBjb25zdCBtYXhOdW0gPSByb3cgPyAocm93WydtYXhfbnVtJ10gYXMgbnVtYmVyIHwgbnVsbCkgOiBudWxsO1xuICAgIGlmIChtYXhOdW0gPT0gbnVsbCB8fCBpc05hTihtYXhOdW0pKSByZXR1cm4gJ1IwMDEnO1xuXG4gICAgY29uc3QgbmV4dCA9IG1heE51bSArIDE7XG4gICAgcmV0dXJuIGBSJHtTdHJpbmcobmV4dCkucGFkU3RhcnQoMywgJzAnKX1gO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2dFcnJvcignbWFuaWZlc3QnLCAnbmV4dFJlcXVpcmVtZW50SWQgZmFpbGVkJywgeyBmbjogJ25leHRSZXF1aXJlbWVudElkJywgZXJyb3I6IFN0cmluZygoZXJyIGFzIEVycm9yKS5tZXNzYWdlKSB9KTtcbiAgICByZXR1cm4gJ1IwMDEnO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTYXZlIFJlcXVpcmVtZW50IHRvIERCICsgUmVnZW5lcmF0ZSBNYXJrZG93biBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBTYXZlUmVxdWlyZW1lbnRGaWVsZHMge1xuICBjbGFzczogc3RyaW5nO1xuICBzdGF0dXM/OiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIHdoeTogc3RyaW5nO1xuICBzb3VyY2U6IHN0cmluZztcbiAgcHJpbWFyeV9vd25lcj86IHN0cmluZztcbiAgc3VwcG9ydGluZ19zbGljZXM/OiBzdHJpbmc7XG4gIHZhbGlkYXRpb24/OiBzdHJpbmc7XG4gIG5vdGVzPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIFNhdmUgYSBuZXcgcmVxdWlyZW1lbnQgdG8gREIgYW5kIHJlZ2VuZXJhdGUgUkVRVUlSRU1FTlRTLm1kLlxuICogQXV0by1hc3NpZ25zIHRoZSBuZXh0IElEIHZpYSBuZXh0UmVxdWlyZW1lbnRJZCgpLlxuICpcbiAqIFRoZSBJRCBjb21wdXRhdGlvbiBhbmQgaW5zZXJ0IGFyZSB3cmFwcGVkIGluIGEgc2luZ2xlIHRyYW5zYWN0aW9uXG4gKiB0byBwcmV2ZW50IHBhcmFsbGVsIHJhY2UgY29uZGl0aW9ucyAoc2FtZSBwYXR0ZXJuIGFzIHNhdmVEZWNpc2lvblRvRGIpLlxuICpcbiAqIFJldHVybnMgdGhlIGFzc2lnbmVkIElELlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2F2ZVJlcXVpcmVtZW50VG9EYihcbiAgZmllbGRzOiBTYXZlUmVxdWlyZW1lbnRGaWVsZHMsXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgaWQ6IHN0cmluZyB9PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgZGIgPSBhd2FpdCBpbXBvcnQoJy4vZ3NkLWRiLmpzJyk7XG5cbiAgICAvLyBBdG9taWMgSUQgYXNzaWdubWVudCArIGluc2VydCBpbnNpZGUgYSB0cmFuc2FjdGlvbi5cbiAgICBjb25zdCB0eFJlc3VsdCA9IGRiLnRyYW5zYWN0aW9uKCgpID0+IHtcbiAgICAgIGNvbnN0IGFkYXB0ZXIgPSBkYi5fZ2V0QWRhcHRlcigpO1xuICAgICAgaWYgKCFhZGFwdGVyKSB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBcImdzZC1kYjogTm8gZGF0YWJhc2Ugb3BlblwiKTtcblxuICAgICAgY29uc3QgZXhpc3RpbmdSb3cgPSBhZGFwdGVyXG4gICAgICAgIC5wcmVwYXJlKFxuICAgICAgICAgIGBTRUxFQ1QgKiBGUk9NIHJlcXVpcmVtZW50c1xuICAgICAgICAgICBXSEVSRSBMT1dFUihUUklNKGRlc2NyaXB0aW9uKSkgPSBMT1dFUihUUklNKDpkZXNjcmlwdGlvbikpXG4gICAgICAgICAgICAgQU5EIExPV0VSKENPQUxFU0NFKHN0YXR1cywgJ2FjdGl2ZScpKSA9ICdhY3RpdmUnXG4gICAgICAgICAgICAgQU5EIHN1cGVyc2VkZWRfYnkgSVMgTlVMTFxuICAgICAgICAgICBPUkRFUiBCWSBpZFxuICAgICAgICAgICBMSU1JVCAxYCxcbiAgICAgICAgKVxuICAgICAgICAuZ2V0KHsgJzpkZXNjcmlwdGlvbic6IGZpZWxkcy5kZXNjcmlwdGlvbiB9KTtcbiAgICAgIGNvbnN0IHJvdyA9IGFkYXB0ZXJcbiAgICAgICAgLnByZXBhcmUoJ1NFTEVDVCBNQVgoQ0FTVChTVUJTVFIoaWQsIDIpIEFTIElOVEVHRVIpKSBhcyBtYXhfbnVtIEZST00gcmVxdWlyZW1lbnRzJylcbiAgICAgICAgLmdldCgpO1xuICAgICAgY29uc3QgbWF4TnVtID0gcm93ID8gKHJvd1snbWF4X251bSddIGFzIG51bWJlciB8IG51bGwpIDogbnVsbDtcbiAgICAgIGNvbnN0IG5leHRJZCA9IGV4aXN0aW5nUm93XG4gICAgICAgID8gU3RyaW5nKGV4aXN0aW5nUm93WydpZCddKVxuICAgICAgICA6IChtYXhOdW0gPT0gbnVsbCB8fCBpc05hTihtYXhOdW0pKVxuICAgICAgICA/ICdSMDAxJ1xuICAgICAgICA6IGBSJHtTdHJpbmcobWF4TnVtICsgMSkucGFkU3RhcnQoMywgJzAnKX1gO1xuXG4gICAgICBjb25zdCByZXF1aXJlbWVudDogUmVxdWlyZW1lbnQgPSB7XG4gICAgICAgIGlkOiBuZXh0SWQsXG4gICAgICAgIGNsYXNzOiBmaWVsZHMuY2xhc3MgfHwgKGV4aXN0aW5nUm93Py5bJ2NsYXNzJ10gYXMgc3RyaW5nIHwgdW5kZWZpbmVkKSB8fCAnJyxcbiAgICAgICAgc3RhdHVzOiBmaWVsZHMuc3RhdHVzID8/IChleGlzdGluZ1Jvdz8uWydzdGF0dXMnXSBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/ICdhY3RpdmUnLFxuICAgICAgICBkZXNjcmlwdGlvbjogZmllbGRzLmRlc2NyaXB0aW9uLFxuICAgICAgICB3aHk6IGZpZWxkcy53aHksXG4gICAgICAgIHNvdXJjZTogZmllbGRzLnNvdXJjZSxcbiAgICAgICAgcHJpbWFyeV9vd25lcjogZmllbGRzLnByaW1hcnlfb3duZXIgPz8gKGV4aXN0aW5nUm93Py5bJ3ByaW1hcnlfb3duZXInXSBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/ICcnLFxuICAgICAgICBzdXBwb3J0aW5nX3NsaWNlczogZmllbGRzLnN1cHBvcnRpbmdfc2xpY2VzID8/IChleGlzdGluZ1Jvdz8uWydzdXBwb3J0aW5nX3NsaWNlcyddIGFzIHN0cmluZyB8IHVuZGVmaW5lZCkgPz8gJycsXG4gICAgICAgIHZhbGlkYXRpb246IGZpZWxkcy52YWxpZGF0aW9uID8/IChleGlzdGluZ1Jvdz8uWyd2YWxpZGF0aW9uJ10gYXMgc3RyaW5nIHwgdW5kZWZpbmVkKSA/PyAnJyxcbiAgICAgICAgbm90ZXM6IGZpZWxkcy5ub3RlcyA/PyAoZXhpc3RpbmdSb3c/Llsnbm90ZXMnXSBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/ICcnLFxuICAgICAgICBmdWxsX2NvbnRlbnQ6IChleGlzdGluZ1Jvdz8uWydmdWxsX2NvbnRlbnQnXSBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/ICcnLFxuICAgICAgICBzdXBlcnNlZGVkX2J5OiAoZXhpc3RpbmdSb3c/Llsnc3VwZXJzZWRlZF9ieSddIGFzIHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpID8/IG51bGwsXG4gICAgICB9O1xuXG4gICAgICBkYi51cHNlcnRSZXF1aXJlbWVudChyZXF1aXJlbWVudCk7XG4gICAgICByZXR1cm4geyBpZDogbmV4dElkIH07XG4gICAgfSk7XG4gICAgY29uc3QgeyBpZCB9ID0gdHhSZXN1bHQ7XG5cbiAgICAvLyBGZXRjaCBhbGwgcmVxdWlyZW1lbnRzIGZvciBmdWxsIGZpbGUgcmVnZW5lcmF0aW9uXG4gICAgY29uc3QgYWRhcHRlciA9IGRiLl9nZXRBZGFwdGVyKCk7XG4gICAgbGV0IGFsbFJlcXVpcmVtZW50czogUmVxdWlyZW1lbnRbXSA9IFtdO1xuICAgIGlmIChhZGFwdGVyKSB7XG4gICAgICBjb25zdCByb3dzID0gYWRhcHRlci5wcmVwYXJlKCdTRUxFQ1QgKiBGUk9NIHJlcXVpcmVtZW50cyBPUkRFUiBCWSBpZCcpLmFsbCgpO1xuICAgICAgYWxsUmVxdWlyZW1lbnRzID0gcm93cy5tYXAocm93ID0+ICh7XG4gICAgICAgIGlkOiByb3dbJ2lkJ10gYXMgc3RyaW5nLFxuICAgICAgICBjbGFzczogcm93WydjbGFzcyddIGFzIHN0cmluZyxcbiAgICAgICAgc3RhdHVzOiByb3dbJ3N0YXR1cyddIGFzIHN0cmluZyxcbiAgICAgICAgZGVzY3JpcHRpb246IHJvd1snZGVzY3JpcHRpb24nXSBhcyBzdHJpbmcsXG4gICAgICAgIHdoeTogcm93Wyd3aHknXSBhcyBzdHJpbmcsXG4gICAgICAgIHNvdXJjZTogcm93Wydzb3VyY2UnXSBhcyBzdHJpbmcsXG4gICAgICAgIHByaW1hcnlfb3duZXI6IHJvd1sncHJpbWFyeV9vd25lciddIGFzIHN0cmluZyxcbiAgICAgICAgc3VwcG9ydGluZ19zbGljZXM6IHJvd1snc3VwcG9ydGluZ19zbGljZXMnXSBhcyBzdHJpbmcsXG4gICAgICAgIHZhbGlkYXRpb246IHJvd1sndmFsaWRhdGlvbiddIGFzIHN0cmluZyxcbiAgICAgICAgbm90ZXM6IHJvd1snbm90ZXMnXSBhcyBzdHJpbmcsXG4gICAgICAgIGZ1bGxfY29udGVudDogcm93WydmdWxsX2NvbnRlbnQnXSBhcyBzdHJpbmcsXG4gICAgICAgIHN1cGVyc2VkZWRfYnk6IChyb3dbJ3N1cGVyc2VkZWRfYnknXSBhcyBzdHJpbmcpID8/IG51bGwsXG4gICAgICB9KSk7XG4gICAgfVxuXG4gICAgY29uc3Qgbm9uU3VwZXJzZWRlZCA9IGFsbFJlcXVpcmVtZW50cy5maWx0ZXIociA9PiByLnN1cGVyc2VkZWRfYnkgPT0gbnVsbCk7XG4gICAgY29uc3QgbWQgPSBnZW5lcmF0ZVJlcXVpcmVtZW50c01kKG5vblN1cGVyc2VkZWQpO1xuICAgIGNvbnN0IGZpbGVQYXRoID0gcmVzb2x2ZUdzZFJvb3RGaWxlKGJhc2VQYXRoLCAnUkVRVUlSRU1FTlRTJyk7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHNhdmVGaWxlKGZpbGVQYXRoLCBtZCk7XG4gICAgfSBjYXRjaCAoZGlza0Vycikge1xuICAgICAgbG9nV2FybmluZygncHJvamVjdGlvbicsICdSRVFVSVJFTUVOVFMubWQgcHJvamVjdGlvbiB3cml0ZSBmYWlsZWQ7IERCIHJlcXVpcmVtZW50IHJlbWFpbnMgY29tbWl0dGVkJywgeyBmbjogJ3NhdmVSZXF1aXJlbWVudFRvRGInLCBpZCwgZXJyb3I6IFN0cmluZygoZGlza0VyciBhcyBFcnJvcikubWVzc2FnZSkgfSk7XG4gICAgfVxuICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICBjbGVhclBhcnNlQ2FjaGUoKTtcblxuICAgIHJldHVybiB7IGlkIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ0Vycm9yKCdtYW5pZmVzdCcsICdzYXZlUmVxdWlyZW1lbnRUb0RiIGZhaWxlZCcsIHsgZm46ICdzYXZlUmVxdWlyZW1lbnRUb0RiJywgZXJyb3I6IFN0cmluZygoZXJyIGFzIEVycm9yKS5tZXNzYWdlKSB9KTtcbiAgICB0aHJvdyBlcnI7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEFzeW5jIE11dGV4IGZvciBEZWNpc2lvbiBTYXZlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vXG4vLyBTZXJpYWxpemVzIHRoZSBlbnRpcmUgc2F2ZURlY2lzaW9uVG9EYiBvcGVyYXRpb24gKElEIGdlbmVyYXRpb24gKyBEQiB1cHNlcnRcbi8vICsgZmlsZSByZWFkICsgbWFya2Rvd24gcmVnZW5lcmF0aW9uICsgZmlsZSB3cml0ZSkgc28gdGhhdCBwYXJhbGxlbCBjYWxsZXJzXG4vLyBjYW5ub3QgaW50ZXJsZWF2ZSBhbmQgcHJvZHVjZSBhIGxhc3Qtd3JpdGVyLXdpbnMgcmFjZSBvbiBERUNJU0lPTlMubWQuXG5sZXQgX2RlY2lzaW9uU2F2ZUxvY2s6IFByb21pc2U8dW5rbm93bj4gPSBQcm9taXNlLnJlc29sdmUoKTtcblxuLyoqIFJlc2V0IHRoZSBtdXRleCBcdTIwMTQgb25seSBmb3IgdGVzdHMuICovXG5leHBvcnQgZnVuY3Rpb24gX3Jlc2V0RGVjaXNpb25TYXZlTG9jaygpOiB2b2lkIHtcbiAgX2RlY2lzaW9uU2F2ZUxvY2sgPSBQcm9taXNlLnJlc29sdmUoKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNhdmUgRGVjaXNpb24gdG8gREIgKyBSZWdlbmVyYXRlIE1hcmtkb3duIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIFNhdmVEZWNpc2lvbkZpZWxkcyB7XG4gIHNjb3BlOiBzdHJpbmc7XG4gIGRlY2lzaW9uOiBzdHJpbmc7XG4gIGNob2ljZTogc3RyaW5nO1xuICByYXRpb25hbGU6IHN0cmluZztcbiAgcmV2aXNhYmxlPzogc3RyaW5nO1xuICB3aGVuX2NvbnRleHQ/OiBzdHJpbmc7XG4gIG1hZGVfYnk/OiBpbXBvcnQoJy4vdHlwZXMuanMnKS5EZWNpc2lvbk1hZGVCeTtcbiAgLyoqIEFEUi0wMTEgUGhhc2UgMjogb3JpZ2luIG9mIHRoZSBkZWNpc2lvbiBcdTIwMTQgXCJkaXNjdXNzaW9uXCIgKGRlZmF1bHQpLCBcInBsYW5uaW5nXCIsIFwiZXNjYWxhdGlvblwiLiAqL1xuICBzb3VyY2U/OiBzdHJpbmc7XG59XG5cbnR5cGUgTm9ybWFsaXplZFNhdmVEZWNpc2lvbkZpZWxkcyA9IE9taXQ8XG4gIFNhdmVEZWNpc2lvbkZpZWxkcyxcbiAgJ3doZW5fY29udGV4dCcgfCAncmV2aXNhYmxlJyB8ICdtYWRlX2J5JyB8ICdzb3VyY2UnXG4+ICYge1xuICB3aGVuX2NvbnRleHQ6IHN0cmluZztcbiAgcmV2aXNhYmxlOiBzdHJpbmc7XG4gIG1hZGVfYnk6IE5vbk51bGxhYmxlPFNhdmVEZWNpc2lvbkZpZWxkc1snbWFkZV9ieSddPjtcbiAgc291cmNlOiBzdHJpbmc7XG59O1xuXG4vKipcbiAqIFNhdmUgYSBuZXcgZGVjaXNpb24gdG8gREIgYW5kIHJlZ2VuZXJhdGUgREVDSVNJT05TLm1kLlxuICogQXV0by1hc3NpZ25zIHRoZSBuZXh0IElEIHZpYSBuZXh0RGVjaXNpb25JZCgpLlxuICpcbiAqIENvbmN1cnJlbmN5OiB1c2VzIGFuIGFzeW5jIG11dGV4IChwcm9taXNlIGNoYWluKSB0byBzZXJpYWxpemUgdGhlIGVudGlyZVxuICogb3BlcmF0aW9uIFx1MjAxNCBJRCBnZW5lcmF0aW9uLCBEQiB1cHNlcnQsIGZpbGUgcmVhZCwgbWFya2Rvd24gcmVnZW5lcmF0aW9uLFxuICogYW5kIGZpbGUgd3JpdGUgXHUyMDE0IHByZXZlbnRpbmcgcGFyYWxsZWwgY2FsbGVycyBmcm9tIG92ZXJ3cml0aW5nIGVhY2ggb3RoZXInc1xuICogb3V0cHV0IChsYXN0LXdyaXRlci13aW5zIHJhY2UgY29uZGl0aW9uKS5cbiAqXG4gKiBSZXR1cm5zIHRoZSBhc3NpZ25lZCBJRC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNhdmVEZWNpc2lvblRvRGIoXG4gIGZpZWxkczogU2F2ZURlY2lzaW9uRmllbGRzLFxuICBiYXNlUGF0aDogc3RyaW5nLFxuKTogUHJvbWlzZTx7IGlkOiBzdHJpbmcgfT4ge1xuICAvLyBTZXJpYWxpemUgdmlhIGFzeW5jIG11dGV4OiBlYWNoIGNhbGwgd2FpdHMgZm9yIHRoZSBwcmV2aW91cyBvbmUgdG9cbiAgLy8gY29tcGxldGUgYmVmb3JlIHN0YXJ0aW5nLCBwcmV2ZW50aW5nIGludGVybGVhdmVkIERCICsgZmlsZSB3cml0ZXMuXG4gIGxldCByZWxlYXNlOiAoKSA9PiB2b2lkO1xuICBjb25zdCBwcmV2ID0gX2RlY2lzaW9uU2F2ZUxvY2s7XG4gIF9kZWNpc2lvblNhdmVMb2NrID0gbmV3IFByb21pc2U8dm9pZD4ociA9PiB7IHJlbGVhc2UgPSByOyB9KTtcblxuICB0cnkge1xuICAgIGF3YWl0IHByZXY7XG4gIH0gY2F0Y2gge1xuICAgIC8vIFByZXZpb3VzIGNhbGwgZmFpbGVkIFx1MjAxNCBwcm9jZWVkIHJlZ2FyZGxlc3M7IHRoZSBsb2NrIGNoYWluIG11c3QgY29udGludWUuXG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IGRiID0gYXdhaXQgaW1wb3J0KCcuL2dzZC1kYi5qcycpO1xuICAgIGNvbnN0IGFkYXB0ZXIgPSBkYi5fZ2V0QWRhcHRlcigpO1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQ6IE5vcm1hbGl6ZWRTYXZlRGVjaXNpb25GaWVsZHMgPSB7XG4gICAgICAuLi5maWVsZHMsXG4gICAgICB3aGVuX2NvbnRleHQ6IGZpZWxkcy53aGVuX2NvbnRleHQgPz8gJycsXG4gICAgICByZXZpc2FibGU6IGZpZWxkcy5yZXZpc2FibGUgPz8gJ1llcycsXG4gICAgICBtYWRlX2J5OiBmaWVsZHMubWFkZV9ieSA/PyAnYWdlbnQnLFxuICAgICAgc291cmNlOiBmaWVsZHMuc291cmNlID8/ICdkaXNjdXNzaW9uJyxcbiAgICB9O1xuXG4gICAgLy8gQURSLTAxMyBTdGFnZSAzIChkZXN0cnVjdGl2ZSk6IHdyaXRlcyB0byB0aGUgYGRlY2lzaW9uc2AgdGFibGUgc3RvcFxuICAgIC8vIGhlcmUuIE5ldyBkZWNpc2lvbnMgbGl2ZSBvbmx5IGluIHRoZSBgbWVtb3JpZXNgIHRhYmxlOyB0aGUgcHJvamVjdGlvblxuICAgIC8vIHJlZ2VuIGJlbG93IHNvdXJjZXMgZnJvbSBtZW1vcmllcyAoU3RhZ2UgMmEpLiBUaGUgZGVjaXNpb25zIHRhYmxlXG4gICAgLy8gcmVtYWlucyBmb3IgYmFja3dhcmRzLWNvbXBhdCByZWFkcyAocXVlcnlEZWNpc2lvbnMsIG1kLWltcG9ydGVyLFxuICAgIC8vIGNvbW1hbmRzLWluc3BlY3QsIHdvcmtmbG93LW1hbmlmZXN0KSB1bnRpbCAjNTc1NiBkcm9wcyBpdC5cbiAgICAvL1xuICAgIC8vIFJldmVyc2FsOiBhIGNvZGUgcmV2ZXJ0IG9mIHRoaXMgY2hhbmdlIHJlc3RvcmVzIHRoZSB1cHNlcnREZWNpc2lvblxuICAgIC8vIGNhbGwuIE1lbW9yeSByb3dzIHdyaXR0ZW4gYmV0d2VlbiBtZXJnZSBhbmQgcmV2ZXJ0IHN0YXkgZHVyYWJsZTsgdGhlXG4gICAgLy8gbGVnYWN5IHRhYmxlIHNpbXBseSBkb2Vzbid0IGdyb3cgZHVyaW5nIHRoZSBjdXRvdmVyIHdpbmRvdy5cbiAgICBjb25zdCBpZCA9IG5leHREZWNpc2lvbklkQWNyb3NzU3VyZmFjZXMoYWRhcHRlcik7XG5cbiAgICAvLyBUaGUgbWlycm9yLXRvLW1lbW9yaWVzIHdyaXRlIGlzIHdoYXQgcGVyc2lzdHMgdGhlIG5ldyBkZWNpc2lvbi4gTXVzdFxuICAgIC8vIHJ1biBiZWZvcmUgdGhlIHByb2plY3Rpb24gcmVnZW4gXHUyMDE0IHRoZSByZWdlbiBzb3VyY2VzIGZyb20gbWVtb3JpZXNcbiAgICAvLyAoU3RhZ2UgMmEpIGFuZCB3b3VsZCBvdGhlcndpc2UgbWlzcyB0aGUganVzdC1zYXZlZCBkZWNpc2lvbi4gUGFzc1xuICAgIC8vIHRoZSBub3JtYWxpemVkIGZpZWxkIHNldCBzbyBkZWZhdWx0cyAocmV2aXNhYmxlLCBtYWRlX2J5LCBzb3VyY2UpXG4gICAgLy8gYXJlIHJlY29yZGVkIG9uIHRoZSBtZW1vcnkgcm93LlxuICAgIGF3YWl0IG1pcnJvckRlY2lzaW9uVG9NZW1vcnkoaWQsIG5vcm1hbGl6ZWQpO1xuXG4gICAgLy8gRmV0Y2ggYWxsIGRlY2lzaW9ucyAoaW5jbHVkaW5nIHN1cGVyc2VkZWQgZm9yIHRoZSBmdWxsIHJlZ2lzdGVyKS5cbiAgICAvLyBBRFItMDEzIFN0YWdlIDJhOiBzb3VyY2UgZnJvbSB0aGUgYG1lbW9yaWVzYCB0YWJsZS4gVGhlIFBoYXNlIDVcbiAgICAvLyBkdWFsLXdyaXRlIGtlZXBzIG1lbW9yaWVzIGluIHN5bmMgd2l0aCBlYWNoIGRlY2lzaW9uIHNhdmU7IHRoZSBiYWNrZmlsbFxuICAgIC8vIChtZW1vcnktYmFja2ZpbGwudHMpIGFic29yYnMgdGhlIGhpc3RvcmljYWwgY2hhaW4gYW5kIGRyaWZ0LWhlYWxzXG4gICAgLy8gc3VwZXJzZWRlZF9ieSBvbiBldmVyeSBzZXNzaW9uIHN0YXJ0LlxuICAgIGNvbnN0IHsgZ2V0QWxsRGVjaXNpb25zRnJvbU1lbW9yaWVzIH0gPSBhd2FpdCBpbXBvcnQoJy4vY29udGV4dC1zdG9yZS5qcycpO1xuICAgIGxldCBhbGxEZWNpc2lvbnM6IERlY2lzaW9uW10gPSBnZXRBbGxEZWNpc2lvbnNGcm9tTWVtb3JpZXMoKTtcbiAgICBpZiAoIWFsbERlY2lzaW9ucy5zb21lKGQgPT4gZC5pZCA9PT0gaWQpKSB7XG4gICAgICBsb2dXYXJuaW5nKCdwcm9qZWN0aW9uJywgJ2p1c3Qtc2F2ZWQgZGVjaXNpb24gbWlzc2luZyBmcm9tIG1lbW9yaWVzIGFmdGVyIG1pcnJvcjsgaW5qZWN0aW5nIGZhbGxiYWNrIGZvciBwcm9qZWN0aW9uJywge1xuICAgICAgICBmbjogJ3NhdmVEZWNpc2lvblRvRGInLFxuICAgICAgICBkZWNpc2lvbklkOiBpZCxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgbmV4dFNlcSA9IGFsbERlY2lzaW9ucy5yZWR1Y2UoKG1heCwgZCkgPT4gTWF0aC5tYXgobWF4LCBkLnNlcSA/PyAwKSwgMCkgKyAxO1xuICAgICAgY29uc3QgZmFsbGJhY2s6IERlY2lzaW9uID0ge1xuICAgICAgICBzZXE6IG5leHRTZXEsXG4gICAgICAgIGlkLFxuICAgICAgICB3aGVuX2NvbnRleHQ6IG5vcm1hbGl6ZWQud2hlbl9jb250ZXh0LFxuICAgICAgICBzY29wZTogbm9ybWFsaXplZC5zY29wZSxcbiAgICAgICAgZGVjaXNpb246IG5vcm1hbGl6ZWQuZGVjaXNpb24sXG4gICAgICAgIGNob2ljZTogbm9ybWFsaXplZC5jaG9pY2UsXG4gICAgICAgIHJhdGlvbmFsZTogbm9ybWFsaXplZC5yYXRpb25hbGUsXG4gICAgICAgIHJldmlzYWJsZTogbm9ybWFsaXplZC5yZXZpc2FibGUsXG4gICAgICAgIG1hZGVfYnk6IG5vcm1hbGl6ZWQubWFkZV9ieSxcbiAgICAgICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICAgIH07XG4gICAgICBhbGxEZWNpc2lvbnMgPSBbLi4uYWxsRGVjaXNpb25zLCBmYWxsYmFja107XG4gICAgfVxuXG4gICAgY29uc3QgZmlsZVBhdGggPSByZXNvbHZlR3NkUm9vdEZpbGUoYmFzZVBhdGgsICdERUNJU0lPTlMnKTtcblxuICAgIC8vIENoZWNrIGlmIGV4aXN0aW5nIERFQ0lTSU9OUy5tZCBoYXMgZnJlZWZvcm0gKG5vbi10YWJsZSkgY29udGVudC5cbiAgICAvLyBJZiBzbywgcHJlc2VydmUgdGhhdCBjb250ZW50IGFuZCBhcHBlbmQvdXBkYXRlIHRoZSBkZWNpc2lvbnMgdGFibGVcbiAgICAvLyBhdCB0aGUgZW5kIGluc3RlYWQgb2Ygb3ZlcndyaXRpbmcgdGhlIGVudGlyZSBmaWxlLlxuICAgIGxldCBleGlzdGluZ0NvbnRlbnQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIGlmIChleGlzdHNTeW5jKGZpbGVQYXRoKSkge1xuICAgICAgZXhpc3RpbmdDb250ZW50ID0gcmVhZEZpbGVTeW5jKGZpbGVQYXRoLCAndXRmLTgnKTtcbiAgICB9XG5cbiAgICBsZXQgbWQ6IHN0cmluZztcbiAgICBpZiAoZXhpc3RpbmdDb250ZW50ICYmICFpc0RlY2lzaW9uc1RhYmxlRm9ybWF0KGV4aXN0aW5nQ29udGVudCkpIHtcbiAgICAgIC8vIEZyZWVmb3JtIGNvbnRlbnQgZGV0ZWN0ZWQgXHUyMDE0IHByZXNlcnZlIGl0IGFuZCBhcHBlbmQgZGVjaXNpb25zIHRhYmxlLlxuICAgICAgLy8gU3RyaXAgYW55IHByZXZpb3VzbHkgYXBwZW5kZWQgZGVjaXNpb25zIHRhYmxlIHNlY3Rpb24gdG8gYXZvaWQgZHVwbGljYXRpb24uXG4gICAgICBjb25zdCBtYXJrZXIgPSAnLS0tXFxuXFxuIyMgRGVjaXNpb25zIFRhYmxlJztcbiAgICAgIGNvbnN0IG1hcmtlcklkeCA9IGV4aXN0aW5nQ29udGVudC5pbmRleE9mKG1hcmtlcik7XG4gICAgICBjb25zdCBmcmVlZm9ybVBhcnQgPSBtYXJrZXJJZHggPj0gMFxuICAgICAgICA/IGV4aXN0aW5nQ29udGVudC5zdWJzdHJpbmcoMCwgbWFya2VySWR4KS50cmltRW5kKClcbiAgICAgICAgOiBleGlzdGluZ0NvbnRlbnQudHJpbUVuZCgpO1xuICAgICAgbWQgPSBmcmVlZm9ybVBhcnQgKyAnXFxuJyArIGdlbmVyYXRlRGVjaXNpb25zQXBwZW5kQmxvY2soYWxsRGVjaXNpb25zKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gVGFibGUgZm9ybWF0IG9yIG5vIGV4aXN0aW5nIGZpbGUgXHUyMDE0IGZ1bGwgcmVnZW5lcmF0aW9uIChvcmlnaW5hbCBiZWhhdmlvcilcbiAgICAgIG1kID0gZ2VuZXJhdGVEZWNpc2lvbnNNZChhbGxEZWNpc2lvbnMpO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBzYXZlRmlsZShmaWxlUGF0aCwgbWQpO1xuICAgIH0gY2F0Y2ggKGRpc2tFcnIpIHtcbiAgICAgIGxvZ1dhcm5pbmcoJ3Byb2plY3Rpb24nLCAnREVDSVNJT05TLm1kIHByb2plY3Rpb24gd3JpdGUgZmFpbGVkOyBEQiBkZWNpc2lvbiByZW1haW5zIGNvbW1pdHRlZCcsIHsgZm46ICdzYXZlRGVjaXNpb25Ub0RiJywgaWQsIGVycm9yOiBTdHJpbmcoKGRpc2tFcnIgYXMgRXJyb3IpLm1lc3NhZ2UpIH0pO1xuICAgIH1cbiAgICAvLyAjMjY2MTogV2hlbiBhIGRlY2lzaW9uIGRlZmVycyBhIHNsaWNlLCB1cGRhdGUgdGhlIHNsaWNlIHN0YXR1cyBpbiB0aGUgREJcbiAgICAvLyBzbyB0aGUgZGlzcGF0Y2hlciBza2lwcyBpdC4gV2l0aG91dCB0aGlzLCBTVEFURS5tZCBhbmQgREVDSVNJT05TLm1kIGFyZVxuICAgIC8vIGluIHNwbGl0LWJyYWluOiB0aGUgZGVjaXNpb24gc2F5cyBcImRlZmVycmVkXCIgYnV0IHRoZSBzdGF0ZSBzdGlsbCBzYXlzXG4gICAgLy8gXCJhY3RpdmVcIiwgY2F1c2luZyBhdXRvLW1vZGUgdG8ga2VlcCBkaXNwYXRjaGluZyB0aGUgZGVmZXJyZWQgd29yay5cbiAgICB0cnkge1xuICAgICAgY29uc3Qgc2xpY2VSZWYgPSBleHRyYWN0RGVmZXJyZWRTbGljZVJlZihmaWVsZHMpO1xuICAgICAgaWYgKHNsaWNlUmVmKSB7XG4gICAgICAgIGRiLnVwZGF0ZVNsaWNlU3RhdHVzKHNsaWNlUmVmLm1pbGVzdG9uZUlkLCBzbGljZVJlZi5zbGljZUlkLCAnZGVmZXJyZWQnKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChkZWZlckVycikge1xuICAgICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBsb2cgYnV0IGRvbid0IGZhaWwgdGhlIGRlY2lzaW9uIHNhdmVcbiAgICAgIGxvZ0Vycm9yKCdtYW5pZmVzdCcsICdmYWlsZWQgdG8gdXBkYXRlIGRlZmVycmVkIHNsaWNlIHN0YXR1cycsIHtcbiAgICAgICAgZm46ICdzYXZlRGVjaXNpb25Ub0RiJyxcbiAgICAgICAgZXJyb3I6IFN0cmluZygoZGVmZXJFcnIgYXMgRXJyb3IpLm1lc3NhZ2UpLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gSW52YWxpZGF0ZSBmaWxlLXJlYWQgY2FjaGVzIHNvIGRlcml2ZVN0YXRlKCkgc2VlcyB0aGUgdXBkYXRlZCBtYXJrZG93bi5cbiAgICAvLyBEbyBOT1QgY2xlYXIgdGhlIGFydGlmYWN0cyB0YWJsZSBcdTIwMTQgd2UganVzdCB3cm90ZSB0byBpdCBpbnRlbnRpb25hbGx5LlxuICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICBjbGVhclBhcnNlQ2FjaGUoKTtcblxuICAgIHJldHVybiB7IGlkIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ0Vycm9yKCdtYW5pZmVzdCcsICdzYXZlRGVjaXNpb25Ub0RiIGZhaWxlZCcsIHsgZm46ICdzYXZlRGVjaXNpb25Ub0RiJywgZXJyb3I6IFN0cmluZygoZXJyIGFzIEVycm9yKS5tZXNzYWdlKSB9KTtcbiAgICB0aHJvdyBlcnI7XG4gIH0gZmluYWxseSB7XG4gICAgcmVsZWFzZSEoKTtcbiAgfVxufVxuXG4vKipcbiAqIEFEUi0wMTMgZHVhbC13cml0ZSBcdTIwMTQgbWlycm9yIGEgZnJlc2hseS1zYXZlZCBkZWNpc2lvbiBpbnRvIHRoZSBgbWVtb3JpZXNgXG4gKiB0YWJsZSBzbyB0aGUgbWVtb3J5IHN0b3JlIHJlbWFpbnMgdGhlIHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGggZm9yIHRoZVxuICogREVDSVNJT05TLm1kIHByb2plY3Rpb24gKFN0YWdlIDJhKSBhbmQgZm9yIHByb21wdC1pbmxpbmUgcmVhZHMgKFN0YWdlIDEpLlxuICpcbiAqIEJlc3QtZWZmb3J0IG1pcnJvcjogbG9ncyBmYWlsdXJlcyB3aXRob3V0IHRocm93aW5nIHRvIGF2b2lkIGJsb2NraW5nIHNhdmVzLlxuICogQ2FsbGVyIGludm9rZXMgdGhpcyBBRlRFUiB0aGUgZGVjaXNpb25zLXRhYmxlIHdyaXRlIGNvbXBsZXRlcyBhbmRcbiAqIEJFRk9SRSB0aGUgcHJvamVjdGlvbiByZWdlbiBcdTIwMTQgdGhlIHJlZ2VuIHNvdXJjZXMgZnJvbSBtZW1vcmllcyBhbmQgd291bGRcbiAqIG90aGVyd2lzZSBtaXNzIHRoZSBqdXN0LXNhdmVkIGRlY2lzaW9uLlxuICovXG5hc3luYyBmdW5jdGlvbiBtaXJyb3JEZWNpc2lvblRvTWVtb3J5KFxuICBpZDogc3RyaW5nLFxuICBub3JtYWxpemVkRmllbGRzOiBOb3JtYWxpemVkU2F2ZURlY2lzaW9uRmllbGRzLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBjcmVhdGVNZW1vcnkgfSA9IGF3YWl0IGltcG9ydCgnLi9tZW1vcnktc3RvcmUuanMnKTtcbiAgICBjb25zdCB7IHN5bnRoZXNpemVEZWNpc2lvbk1lbW9yeUNvbnRlbnQgfSA9IGF3YWl0IGltcG9ydCgnLi9tZW1vcnktYmFja2ZpbGwuanMnKTtcbiAgICBjb25zdCBjb250ZW50ID0gc3ludGhlc2l6ZURlY2lzaW9uTWVtb3J5Q29udGVudChub3JtYWxpemVkRmllbGRzKTtcbiAgICBpZiAoIWNvbnRlbnQpIHJldHVybiBmYWxzZTtcblxuICAgIGNyZWF0ZU1lbW9yeSh7XG4gICAgICBjYXRlZ29yeTogJ2FyY2hpdGVjdHVyZScsXG4gICAgICBjb250ZW50LFxuICAgICAgc2NvcGU6IG5vcm1hbGl6ZWRGaWVsZHMuc2NvcGUgfHwgJ3Byb2plY3QnLFxuICAgICAgY29uZmlkZW5jZTogMC44NSxcbiAgICAgIHN0cnVjdHVyZWRGaWVsZHM6IHtcbiAgICAgICAgc291cmNlRGVjaXNpb25JZDogaWQsXG4gICAgICAgIHdoZW5fY29udGV4dDogbm9ybWFsaXplZEZpZWxkcy53aGVuX2NvbnRleHQsXG4gICAgICAgIHNjb3BlOiBub3JtYWxpemVkRmllbGRzLnNjb3BlLFxuICAgICAgICBkZWNpc2lvbjogbm9ybWFsaXplZEZpZWxkcy5kZWNpc2lvbixcbiAgICAgICAgY2hvaWNlOiBub3JtYWxpemVkRmllbGRzLmNob2ljZSxcbiAgICAgICAgcmF0aW9uYWxlOiBub3JtYWxpemVkRmllbGRzLnJhdGlvbmFsZSxcbiAgICAgICAgbWFkZV9ieTogbm9ybWFsaXplZEZpZWxkcy5tYWRlX2J5LFxuICAgICAgICByZXZpc2FibGU6IG5vcm1hbGl6ZWRGaWVsZHMucmV2aXNhYmxlLFxuICAgICAgICAvLyBOZXcgZGVjaXNpb25zIGFyZSBhbHdheXMgd3JpdHRlbiBhcyBhY3RpdmU7IG1kLWltcG9ydGVyIGNhbiBsYXRlclxuICAgICAgICAvLyBzZXQgc3VwZXJzZWRlZF9ieSBvbiB0aGUgc291cmNlIGRlY2lzaW9uIHJvdywgYW5kIHRoZSBiYWNrZmlsbCdzXG4gICAgICAgIC8vIGRyaWZ0IGF1dG8taGVhbCBwYXNzIHByb3BhZ2F0ZXMgdGhhdCB1cGRhdGUgdG8gdGhpcyBtZW1vcnkuXG4gICAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsXG4gICAgICB9LFxuICAgIH0pO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIChtaXJyb3JFcnIpIHtcbiAgICBsb2dFcnJvcignbWFuaWZlc3QnLCAnbWVtb3J5LXN0b3JlIG1pcnJvciB3cml0ZSBmYWlsZWQnLCB7XG4gICAgICBmbjogJ3NhdmVEZWNpc2lvblRvRGInLFxuICAgICAgZGVjaXNpb25JZDogaWQsXG4gICAgICBlcnJvcjogU3RyaW5nKChtaXJyb3JFcnIgYXMgRXJyb3IpLm1lc3NhZ2UpLFxuICAgIH0pO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIEV4dHJhY3QgYSBtaWxlc3RvbmUvc2xpY2UgcmVmZXJlbmNlIGZyb20gYSBkZWZlcnJhbCBkZWNpc2lvbi5cbiAqXG4gKiBEZXRlY3RzIGRlZmVycmFscyBieSBjaGVja2luZzpcbiAqICAgLSBzY29wZSBjb250YWlucyBcImRlZmVyXCIgKGUuZy4sIFwiZGVmZXJyYWxcIiwgXCJkZWZlclwiKVxuICogICAtIGNob2ljZSBvciBkZWNpc2lvbiBjb250YWlucyBcImRlZmVyXCIgKyBhbiBNIyMjL1MjIyBwYXR0ZXJuXG4gKlxuICogUmV0dXJucyB7IG1pbGVzdG9uZUlkLCBzbGljZUlkIH0gaWYgZm91bmQsIG51bGwgb3RoZXJ3aXNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdERlZmVycmVkU2xpY2VSZWYoXG4gIGZpZWxkczogUGljazxTYXZlRGVjaXNpb25GaWVsZHMsICdzY29wZScgfCAnZGVjaXNpb24nIHwgJ2Nob2ljZSc+LFxuKTogeyBtaWxlc3RvbmVJZDogc3RyaW5nOyBzbGljZUlkOiBzdHJpbmcgfSB8IG51bGwge1xuICBjb25zdCBpc0RlZmVycmFsID1cbiAgICAvXFxiZGVmZXIoPzpyYWx8cmVkfHJpbmd8cyk/XFxiL2kudGVzdChmaWVsZHMuc2NvcGUpIHx8XG4gICAgL1xcYmRlZmVyKD86cmFsfHJlZHxyaW5nfHMpP1xcYi9pLnRlc3QoZmllbGRzLmNob2ljZSkgfHxcbiAgICAvXFxiZGVmZXIoPzpyYWx8cmVkfHJpbmd8cyk/XFxiL2kudGVzdChmaWVsZHMuZGVjaXNpb24pO1xuXG4gIGlmICghaXNEZWZlcnJhbCkgcmV0dXJuIG51bGw7XG5cbiAgLy8gTG9vayBmb3IgTSMjIy9TIyMgcGF0dGVybiBpbiBjaG9pY2UgZmlyc3QsIHRoZW4gZGVjaXNpb25cbiAgY29uc3Qgc2xpY2VQYXR0ZXJuID0gL1xcYihNXFxkezMsNH0pXFwvKFNcXGR7MiwzfSlcXGIvO1xuICBjb25zdCBjaG9pY2VNYXRjaCA9IGZpZWxkcy5jaG9pY2UubWF0Y2goc2xpY2VQYXR0ZXJuKTtcbiAgaWYgKGNob2ljZU1hdGNoKSB7XG4gICAgcmV0dXJuIHsgbWlsZXN0b25lSWQ6IGNob2ljZU1hdGNoWzFdLCBzbGljZUlkOiBjaG9pY2VNYXRjaFsyXSB9O1xuICB9XG4gIGNvbnN0IGRlY2lzaW9uTWF0Y2ggPSBmaWVsZHMuZGVjaXNpb24ubWF0Y2goc2xpY2VQYXR0ZXJuKTtcbiAgaWYgKGRlY2lzaW9uTWF0Y2gpIHtcbiAgICByZXR1cm4geyBtaWxlc3RvbmVJZDogZGVjaXNpb25NYXRjaFsxXSwgc2xpY2VJZDogZGVjaXNpb25NYXRjaFsyXSB9O1xuICB9XG5cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBVcGRhdGUgUmVxdWlyZW1lbnQgaW4gREIgKyBSZWdlbmVyYXRlIE1hcmtkb3duIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFVwZGF0ZSBhIHJlcXVpcmVtZW50IGluIERCIGFuZCByZWdlbmVyYXRlIFJFUVVJUkVNRU5UUy5tZC5cbiAqIEZldGNoZXMgZXhpc3RpbmcgcmVxdWlyZW1lbnQsIG1lcmdlcyB1cGRhdGVzLCB1cHNlcnRzLCB0aGVuIHJlZ2VuZXJhdGVzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdXBkYXRlUmVxdWlyZW1lbnRJbkRiKFxuICBpZDogc3RyaW5nLFxuICB1cGRhdGVzOiBQYXJ0aWFsPFJlcXVpcmVtZW50PixcbiAgYmFzZVBhdGg6IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGNvbnN0IGRiID0gYXdhaXQgaW1wb3J0KCcuL2dzZC1kYi5qcycpO1xuXG4gICAgY29uc3QgZXhpc3RpbmcgPSBkYi5nZXRSZXF1aXJlbWVudEJ5SWQoaWQpO1xuXG4gICAgY29uc3QgYmFzZTogUmVxdWlyZW1lbnQgPSBleGlzdGluZyA/PyB7XG4gICAgICBpZCxcbiAgICAgIGNsYXNzOiAnJyxcbiAgICAgIHN0YXR1czogJ2FjdGl2ZScsXG4gICAgICBkZXNjcmlwdGlvbjogJycsXG4gICAgICB3aHk6ICcnLFxuICAgICAgc291cmNlOiAnJyxcbiAgICAgIHByaW1hcnlfb3duZXI6ICcnLFxuICAgICAgc3VwcG9ydGluZ19zbGljZXM6ICcnLFxuICAgICAgdmFsaWRhdGlvbjogJycsXG4gICAgICBub3RlczogJycsXG4gICAgICBmdWxsX2NvbnRlbnQ6ICcnLFxuICAgICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICB9O1xuXG4gICAgLy8gTWVyZ2UgdXBkYXRlcyBpbnRvIGV4aXN0aW5nIChvciBza2VsZXRvbilcbiAgICBjb25zdCBtZXJnZWQ6IFJlcXVpcmVtZW50ID0ge1xuICAgICAgLi4uYmFzZSxcbiAgICAgIC4uLnVwZGF0ZXMsXG4gICAgICBpZDogYmFzZS5pZCwgLy8gSUQgY2Fubm90IGJlIGNoYW5nZWRcbiAgICB9O1xuXG4gICAgZGIudXBzZXJ0UmVxdWlyZW1lbnQobWVyZ2VkKTtcblxuICAgIC8vIEZldGNoIEFMTCByZXF1aXJlbWVudHMgKGluY2x1ZGluZyBzdXBlcnNlZGVkKSBmb3IgZnVsbCBmaWxlIHJlZ2VuZXJhdGlvblxuICAgIGNvbnN0IGFkYXB0ZXIgPSBkYi5fZ2V0QWRhcHRlcigpO1xuICAgIGxldCBhbGxSZXF1aXJlbWVudHM6IFJlcXVpcmVtZW50W10gPSBbXTtcbiAgICBpZiAoYWRhcHRlcikge1xuICAgICAgY29uc3Qgcm93cyA9IGFkYXB0ZXIucHJlcGFyZSgnU0VMRUNUICogRlJPTSByZXF1aXJlbWVudHMgT1JERVIgQlkgaWQnKS5hbGwoKTtcbiAgICAgIGFsbFJlcXVpcmVtZW50cyA9IHJvd3MubWFwKHJvdyA9PiAoe1xuICAgICAgICBpZDogcm93WydpZCddIGFzIHN0cmluZyxcbiAgICAgICAgY2xhc3M6IHJvd1snY2xhc3MnXSBhcyBzdHJpbmcsXG4gICAgICAgIHN0YXR1czogcm93WydzdGF0dXMnXSBhcyBzdHJpbmcsXG4gICAgICAgIGRlc2NyaXB0aW9uOiByb3dbJ2Rlc2NyaXB0aW9uJ10gYXMgc3RyaW5nLFxuICAgICAgICB3aHk6IHJvd1snd2h5J10gYXMgc3RyaW5nLFxuICAgICAgICBzb3VyY2U6IHJvd1snc291cmNlJ10gYXMgc3RyaW5nLFxuICAgICAgICBwcmltYXJ5X293bmVyOiByb3dbJ3ByaW1hcnlfb3duZXInXSBhcyBzdHJpbmcsXG4gICAgICAgIHN1cHBvcnRpbmdfc2xpY2VzOiByb3dbJ3N1cHBvcnRpbmdfc2xpY2VzJ10gYXMgc3RyaW5nLFxuICAgICAgICB2YWxpZGF0aW9uOiByb3dbJ3ZhbGlkYXRpb24nXSBhcyBzdHJpbmcsXG4gICAgICAgIG5vdGVzOiByb3dbJ25vdGVzJ10gYXMgc3RyaW5nLFxuICAgICAgICBmdWxsX2NvbnRlbnQ6IHJvd1snZnVsbF9jb250ZW50J10gYXMgc3RyaW5nLFxuICAgICAgICBzdXBlcnNlZGVkX2J5OiAocm93WydzdXBlcnNlZGVkX2J5J10gYXMgc3RyaW5nKSA/PyBudWxsLFxuICAgICAgfSkpO1xuICAgIH1cblxuICAgIC8vIEZpbHRlciB0byBub24tc3VwZXJzZWRlZCBmb3IgdGhlIG1hcmtkb3duIGZpbGVcbiAgICAvLyAoc3VwZXJzZWRlZCByZXF1aXJlbWVudHMgZG9uJ3QgYXBwZWFyIGluIHNlY3Rpb24gaGVhZGluZ3MpXG4gICAgY29uc3Qgbm9uU3VwZXJzZWRlZCA9IGFsbFJlcXVpcmVtZW50cy5maWx0ZXIociA9PiByLnN1cGVyc2VkZWRfYnkgPT0gbnVsbCk7XG5cbiAgICBjb25zdCBtZCA9IGdlbmVyYXRlUmVxdWlyZW1lbnRzTWQobm9uU3VwZXJzZWRlZCk7XG4gICAgY29uc3QgZmlsZVBhdGggPSByZXNvbHZlR3NkUm9vdEZpbGUoYmFzZVBhdGgsICdSRVFVSVJFTUVOVFMnKTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgc2F2ZUZpbGUoZmlsZVBhdGgsIG1kKTtcbiAgICB9IGNhdGNoIChkaXNrRXJyKSB7XG4gICAgICBsb2dXYXJuaW5nKCdwcm9qZWN0aW9uJywgJ1JFUVVJUkVNRU5UUy5tZCBwcm9qZWN0aW9uIHdyaXRlIGZhaWxlZDsgREIgcmVxdWlyZW1lbnQgdXBkYXRlIHJlbWFpbnMgY29tbWl0dGVkJywgeyBmbjogJ3VwZGF0ZVJlcXVpcmVtZW50SW5EYicsIGlkLCBlcnJvcjogU3RyaW5nKChkaXNrRXJyIGFzIEVycm9yKS5tZXNzYWdlKSB9KTtcbiAgICB9XG4gICAgLy8gSW52YWxpZGF0ZSBmaWxlLXJlYWQgY2FjaGVzIHNvIGRlcml2ZVN0YXRlKCkgc2VlcyB0aGUgdXBkYXRlZCBtYXJrZG93bi5cbiAgICAvLyBEbyBOT1QgY2xlYXIgdGhlIGFydGlmYWN0cyB0YWJsZSBcdTIwMTQgd2UganVzdCB3cm90ZSB0byBpdCBpbnRlbnRpb25hbGx5LlxuICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICBjbGVhclBhcnNlQ2FjaGUoKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nRXJyb3IoJ21hbmlmZXN0JywgJ3VwZGF0ZVJlcXVpcmVtZW50SW5EYiBmYWlsZWQnLCB7IGZuOiAndXBkYXRlUmVxdWlyZW1lbnRJbkRiJywgZXJyb3I6IFN0cmluZygoZXJyIGFzIEVycm9yKS5tZXNzYWdlKSB9KTtcbiAgICB0aHJvdyBlcnI7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNhdmUgQXJ0aWZhY3QgdG8gREIgKyBEaXNrIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIFNhdmVBcnRpZmFjdE9wdHMge1xuICBwYXRoOiBzdHJpbmc7XG4gIGFydGlmYWN0X3R5cGU6IHN0cmluZztcbiAgY29udGVudDogc3RyaW5nO1xuICBtaWxlc3RvbmVfaWQ/OiBzdHJpbmc7XG4gIHNsaWNlX2lkPzogc3RyaW5nO1xuICB0YXNrX2lkPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIFNhdmUgYSByb290LWxldmVsIGFydGlmYWN0IChubyBtaWxlc3RvbmUpIHRvIERCIGFuZCB3cml0ZSB0byBkaXNrLFxuICogcm91dGluZyBwYXRoIGNvbnN0cnVjdGlvbiB0aHJvdWdoIHdvcmtzcGFjZS5jb250cmFjdC5wcm9qZWN0R3NkIGRpcmVjdGx5LlxuICogVXNlIHRoaXMgaW5zdGVhZCBvZiBzYXZlQXJ0aWZhY3RUb0RiQnlTY29wZSB3aGVuIG1pbGVzdG9uZV9pZCBpcyBhYnNlbnQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzYXZlQXJ0aWZhY3RUb0RiRm9yV29ya3NwYWNlKFxuICB3b3Jrc3BhY2U6IEdzZFdvcmtzcGFjZSxcbiAgb3B0czogU2F2ZUFydGlmYWN0T3B0cyxcbik6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGNvbnN0IGRiID0gYXdhaXQgaW1wb3J0KCcuL2dzZC1kYi5qcycpO1xuXG4gICAgY29uc3QgZ3NkRGlyID0gd29ya3NwYWNlLmNvbnRyYWN0LnByb2plY3RHc2Q7XG4gICAgY29uc3QgZnVsbFBhdGggPSByZXNvbHZlKGdzZERpciwgb3B0cy5wYXRoKTtcblxuICAgIGNvbnN0IHJlbDAgPSByZWxhdGl2ZShnc2REaXIsIGZ1bGxQYXRoKTtcbiAgICBpZiAocmVsMC5zdGFydHNXaXRoKCcuLicpIHx8IGlzQWJzb2x1dGUocmVsMCkpIHtcbiAgICAgIHRocm93IG5ldyBHU0RFcnJvcihHU0RfSU9fRVJST1IsIGBzYXZlQXJ0aWZhY3RUb0RiRm9yV29ya3NwYWNlOiBwYXRoIGVzY2FwZXMgLmdzZC8gZGlyZWN0b3J5OiAke29wdHMucGF0aH1gKTtcbiAgICB9XG5cbiAgICBsZXQgY29udGVudFRvUGVyc2lzdCA9IG9wdHMuY29udGVudDtcbiAgICBpZiAob3B0cy5hcnRpZmFjdF90eXBlID09PSAnUkVRVUlSRU1FTlRTJyAmJiBvcHRzLnBhdGggPT09ICdSRVFVSVJFTUVOVFMubWQnKSB7XG4gICAgICBjb25zdCBhY3RpdmVSZXF1aXJlbWVudHMgPSBkYi5nZXRBY3RpdmVSZXF1aXJlbWVudHMoKTtcbiAgICAgIGlmIChhY3RpdmVSZXF1aXJlbWVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsICdzYXZlQXJ0aWZhY3RUb0RiRm9yV29ya3NwYWNlOiBSRVFVSVJFTUVOVFMgZmluYWwgc2F2ZSByZXF1aXJlcyBhY3RpdmUgREItYmFja2VkIHJlcXVpcmVtZW50cycpO1xuICAgICAgfVxuICAgICAgY29udGVudFRvUGVyc2lzdCA9IGdlbmVyYXRlUmVxdWlyZW1lbnRzTWQoYWN0aXZlUmVxdWlyZW1lbnRzKTtcbiAgICB9XG5cbiAgICBsZXQgc2tpcERpc2tXcml0ZSA9IGZhbHNlO1xuICAgIGlmICghaXNSb290Q2Fub25pY2FsQXJ0aWZhY3Qob3B0cykgJiYgZXhpc3RzU3luYyhmdWxsUGF0aCkpIHtcbiAgICAgIGNvbnN0IGV4aXN0aW5nU2l6ZSA9IHN0YXRTeW5jKGZ1bGxQYXRoKS5zaXplO1xuICAgICAgY29uc3QgbmV3U2l6ZSA9IEJ1ZmZlci5ieXRlTGVuZ3RoKGNvbnRlbnRUb1BlcnNpc3QsICd1dGYtOCcpO1xuICAgICAgaWYgKGV4aXN0aW5nU2l6ZSA+IDAgJiYgbmV3U2l6ZSA8IGV4aXN0aW5nU2l6ZSAqIDAuNSkge1xuICAgICAgICBsb2dXYXJuaW5nKCdwcm9qZWN0aW9uJywgYG5ldyBjb250ZW50ICgke25ld1NpemV9QikgaXMgPDUwJSBvZiBleGlzdGluZyBwcm9qZWN0aW9uICgke2V4aXN0aW5nU2l6ZX1CKSwgcHJlc2VydmluZyBkaXNrIGZpbGUgd2hpbGUgREIgcmVtYWlucyBhdXRob3JpdGF0aXZlYCwgeyBmbjogJ3NhdmVBcnRpZmFjdFRvRGJGb3JXb3Jrc3BhY2UnLCBwYXRoOiBvcHRzLnBhdGggfSk7XG4gICAgICAgIHNraXBEaXNrV3JpdGUgPSB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGRiLmluc2VydEFydGlmYWN0KHtcbiAgICAgIHBhdGg6IG9wdHMucGF0aCxcbiAgICAgIGFydGlmYWN0X3R5cGU6IG9wdHMuYXJ0aWZhY3RfdHlwZSxcbiAgICAgIG1pbGVzdG9uZV9pZDogbnVsbCxcbiAgICAgIHNsaWNlX2lkOiBudWxsLFxuICAgICAgdGFza19pZDogbnVsbCxcbiAgICAgIGZ1bGxfY29udGVudDogY29udGVudFRvUGVyc2lzdCxcbiAgICB9KTtcblxuICAgIGlmICghc2tpcERpc2tXcml0ZSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgc2F2ZUZpbGUoZnVsbFBhdGgsIGNvbnRlbnRUb1BlcnNpc3QpO1xuICAgICAgfSBjYXRjaCAoZGlza0Vycikge1xuICAgICAgICBsb2dXYXJuaW5nKCdwcm9qZWN0aW9uJywgJ2FydGlmYWN0IHByb2plY3Rpb24gd3JpdGUgZmFpbGVkOyBEQiBhcnRpZmFjdCByZW1haW5zIGNvbW1pdHRlZCcsIHsgZm46ICdzYXZlQXJ0aWZhY3RUb0RiRm9yV29ya3NwYWNlJywgcGF0aDogb3B0cy5wYXRoLCBlcnJvcjogU3RyaW5nKChkaXNrRXJyIGFzIEVycm9yKS5tZXNzYWdlKSB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcbiAgICBjbGVhclBhdGhDYWNoZSgpO1xuICAgIGNsZWFyUGFyc2VDYWNoZSgpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2dFcnJvcignbWFuaWZlc3QnLCAnc2F2ZUFydGlmYWN0VG9EYkZvcldvcmtzcGFjZSBmYWlsZWQnLCB7IGZuOiAnc2F2ZUFydGlmYWN0VG9EYkZvcldvcmtzcGFjZScsIGVycm9yOiBTdHJpbmcoKGVyciBhcyBFcnJvcikubWVzc2FnZSkgfSk7XG4gICAgdGhyb3cgZXJyO1xuICB9XG59XG5cbi8qKlxuICogU2F2ZSBhbiBhcnRpZmFjdCB0byBEQiBhbmQgd3JpdGUgdGhlIGNvcnJlc3BvbmRpbmcgbWFya2Rvd24gZmlsZSB0byBkaXNrLFxuICogcm91dGluZyBhbGwgcGF0aCBjb25zdHJ1Y3Rpb24gdGhyb3VnaCB0aGUgd29ya3NwYWNlIGNvbnRyYWN0LlxuICpcbiAqIFRoZSBwYXRoIGlzIHJlbGF0aXZlIHRvIC5nc2QvIChlLmcuIFwibWlsZXN0b25lcy9NMDAxL3NsaWNlcy9TMDYvdGFza3MvVDAxLVNVTU1BUlkubWRcIikuXG4gKiBUaGUgZnVsbCBmaWxlIHBhdGggaXMgY29tcHV0ZWQgYXMgc2NvcGUud29ya3NwYWNlLmNvbnRyYWN0LnByb2plY3RHc2QgKyAnLycgKyBwYXRoLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2F2ZUFydGlmYWN0VG9EYkJ5U2NvcGUoXG4gIHNjb3BlOiBNaWxlc3RvbmVTY29wZSxcbiAgb3B0czogU2F2ZUFydGlmYWN0T3B0cyxcbik6IFByb21pc2U8dm9pZD4ge1xuICAvLyBHdWFyZDogYW4gZW1wdHkgbWlsZXN0b25lSWQgcHJvZHVjZXMgbWFsZm9ybWVkIHBhdGhzIChtaWxlc3RvbmVEaXIgPSBqb2luKGdzZCwgXCJtaWxlc3RvbmVzXCIsIFwiXCIpKS5cbiAgLy8gQ2FsbGVycyB0aGF0IGhhdmUgbm8gbWlsZXN0b25lIHNob3VsZCB1c2Ugc2F2ZUFydGlmYWN0VG9EYkZvcldvcmtzcGFjZSBpbnN0ZWFkLlxuICBpZiAoIXNjb3BlLm1pbGVzdG9uZUlkKSB7XG4gICAgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9JT19FUlJPUiwgYHNhdmVBcnRpZmFjdFRvRGJCeVNjb3BlOiBtaWxlc3RvbmVJZCBpcyBlbXB0eSBcdTIwMTQgdXNlIHNhdmVBcnRpZmFjdFRvRGJGb3JXb3Jrc3BhY2UgZm9yIHJvb3QgYXJ0aWZhY3RzYCk7XG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IGRiID0gYXdhaXQgaW1wb3J0KCcuL2dzZC1kYi5qcycpO1xuXG4gICAgLy8gVXNlIGNvbnRyYWN0LnByb2plY3RHc2QgYXMgdGhlIGNhbm9uaWNhbCAuZ3NkIGRpcmVjdG9yeSBcdTIwMTQgbmV2ZXIgYSBoYW5kLXJvbGxlZCBiYXNlUGF0aCBqb2luLlxuICAgIGNvbnN0IGdzZERpciA9IHNjb3BlLndvcmtzcGFjZS5jb250cmFjdC5wcm9qZWN0R3NkO1xuICAgIGNvbnN0IGZ1bGxQYXRoID0gcmVzb2x2ZShnc2REaXIsIG9wdHMucGF0aCk7XG5cbiAgICAvLyBHdWFyZCBhZ2FpbnN0IHBhdGggdHJhdmVyc2FsIGJlZm9yZSBhbnkgcmVhZHMvd3JpdGVzXG4gICAgY29uc3QgcmVsMSA9IHJlbGF0aXZlKGdzZERpciwgZnVsbFBhdGgpO1xuICAgIGlmIChyZWwxLnN0YXJ0c1dpdGgoJy4uJykgfHwgaXNBYnNvbHV0ZShyZWwxKSkge1xuICAgICAgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9JT19FUlJPUiwgYHNhdmVBcnRpZmFjdFRvRGJCeVNjb3BlOiBwYXRoIGVzY2FwZXMgLmdzZC8gZGlyZWN0b3J5OiAke29wdHMucGF0aH1gKTtcbiAgICB9XG5cbiAgICBsZXQgY29udGVudFRvUGVyc2lzdCA9IG9wdHMuY29udGVudDtcbiAgICBpZiAob3B0cy5hcnRpZmFjdF90eXBlID09PSAnUkVRVUlSRU1FTlRTJyAmJiBvcHRzLnBhdGggPT09ICdSRVFVSVJFTUVOVFMubWQnKSB7XG4gICAgICBjb25zdCBhY3RpdmVSZXF1aXJlbWVudHMgPSBkYi5nZXRBY3RpdmVSZXF1aXJlbWVudHMoKTtcbiAgICAgIGlmIChhY3RpdmVSZXF1aXJlbWVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IG5ldyBHU0RFcnJvcihHU0RfU1RBTEVfU1RBVEUsICdzYXZlQXJ0aWZhY3RUb0RiQnlTY29wZTogUkVRVUlSRU1FTlRTIGZpbmFsIHNhdmUgcmVxdWlyZXMgYWN0aXZlIERCLWJhY2tlZCByZXF1aXJlbWVudHMnKTtcbiAgICAgIH1cbiAgICAgIGNvbnRlbnRUb1BlcnNpc3QgPSBnZW5lcmF0ZVJlcXVpcmVtZW50c01kKGFjdGl2ZVJlcXVpcmVtZW50cyk7XG4gICAgfVxuXG4gICAgLy8gU2hyaW5rYWdlIGd1YXJkOiBpZiB0aGUgcHJvamVjdGlvbiBmaWxlIGFscmVhZHkgZXhpc3RzIGFuZCB0aGUgbmV3XG4gICAgLy8gY29udGVudCBpcyBzaWduaWZpY2FudGx5IHNtYWxsZXIgKDw1MCUpLCBwcmVzZXJ2ZSB0aGUgcmljaGVyIGZpbGUgb25cbiAgICAvLyBkaXNrLCBidXQga2VlcCB0aGUgREIgcm93IGF1dGhvcml0YXRpdmUgd2l0aCB0aGUgY2FsbGVyLXByb3ZpZGVkIGNvbnRlbnQuXG4gICAgLy8gUm9vdCBjYW5vbmljYWwgYXJ0aWZhY3RzIGFyZSBleGVtcHQgKHJlbmRlcmVkIGZyb20gY2Fub25pY2FsIERCIHN0YXRlKS5cbiAgICBsZXQgc2tpcERpc2tXcml0ZSA9IGZhbHNlO1xuICAgIGlmICghaXNSb290Q2Fub25pY2FsQXJ0aWZhY3Qob3B0cykgJiYgZXhpc3RzU3luYyhmdWxsUGF0aCkpIHtcbiAgICAgIGNvbnN0IGV4aXN0aW5nU2l6ZSA9IHN0YXRTeW5jKGZ1bGxQYXRoKS5zaXplO1xuICAgICAgY29uc3QgbmV3U2l6ZSA9IEJ1ZmZlci5ieXRlTGVuZ3RoKGNvbnRlbnRUb1BlcnNpc3QsICd1dGYtOCcpO1xuICAgICAgaWYgKGV4aXN0aW5nU2l6ZSA+IDAgJiYgbmV3U2l6ZSA8IGV4aXN0aW5nU2l6ZSAqIDAuNSkge1xuICAgICAgICBsb2dXYXJuaW5nKCdwcm9qZWN0aW9uJywgYG5ldyBjb250ZW50ICgke25ld1NpemV9QikgaXMgPDUwJSBvZiBleGlzdGluZyBwcm9qZWN0aW9uICgke2V4aXN0aW5nU2l6ZX1CKSwgcHJlc2VydmluZyBkaXNrIGZpbGUgd2hpbGUgREIgcmVtYWlucyBhdXRob3JpdGF0aXZlYCwgeyBmbjogJ3NhdmVBcnRpZmFjdFRvRGJCeVNjb3BlJywgcGF0aDogb3B0cy5wYXRoIH0pO1xuICAgICAgICBza2lwRGlza1dyaXRlID0gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBkYi5pbnNlcnRBcnRpZmFjdCh7XG4gICAgICBwYXRoOiBvcHRzLnBhdGgsXG4gICAgICBhcnRpZmFjdF90eXBlOiBvcHRzLmFydGlmYWN0X3R5cGUsXG4gICAgICBtaWxlc3RvbmVfaWQ6IG9wdHMubWlsZXN0b25lX2lkID8/IG51bGwsXG4gICAgICBzbGljZV9pZDogb3B0cy5zbGljZV9pZCA/PyBudWxsLFxuICAgICAgdGFza19pZDogb3B0cy50YXNrX2lkID8/IG51bGwsXG4gICAgICBmdWxsX2NvbnRlbnQ6IGNvbnRlbnRUb1BlcnNpc3QsXG4gICAgfSk7XG5cbiAgICAvLyBXcml0ZSB0aGUgZmlsZSB0byBkaXNrIChvbmx5IGlmIHdlJ3JlIG5vdCBwcmVzZXJ2aW5nIGEgcmljaGVyIGV4aXN0aW5nIGZpbGUpXG4gICAgaWYgKCFza2lwRGlza1dyaXRlKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBzYXZlRmlsZShmdWxsUGF0aCwgY29udGVudFRvUGVyc2lzdCk7XG4gICAgICB9IGNhdGNoIChkaXNrRXJyKSB7XG4gICAgICAgIGxvZ1dhcm5pbmcoJ3Byb2plY3Rpb24nLCAnYXJ0aWZhY3QgcHJvamVjdGlvbiB3cml0ZSBmYWlsZWQ7IERCIGFydGlmYWN0IHJlbWFpbnMgY29tbWl0dGVkJywgeyBmbjogJ3NhdmVBcnRpZmFjdFRvRGJCeVNjb3BlJywgcGF0aDogb3B0cy5wYXRoLCBlcnJvcjogU3RyaW5nKChkaXNrRXJyIGFzIEVycm9yKS5tZXNzYWdlKSB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgLy8gSW52YWxpZGF0ZSBmaWxlLXJlYWQgY2FjaGVzIHNvIGRlcml2ZVN0YXRlKCkgc2VlcyB0aGUgdXBkYXRlZCBtYXJrZG93bi5cbiAgICAvLyBEbyBOT1QgY2xlYXIgdGhlIGFydGlmYWN0cyB0YWJsZSBcdTIwMTQgd2UganVzdCB3cm90ZSB0byBpdCBpbnRlbnRpb25hbGx5LlxuICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgY2xlYXJQYXRoQ2FjaGUoKTtcbiAgICBjbGVhclBhcnNlQ2FjaGUoKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nRXJyb3IoJ21hbmlmZXN0JywgJ3NhdmVBcnRpZmFjdFRvRGJCeVNjb3BlIGZhaWxlZCcsIHsgZm46ICdzYXZlQXJ0aWZhY3RUb0RiQnlTY29wZScsIGVycm9yOiBTdHJpbmcoKGVyciBhcyBFcnJvcikubWVzc2FnZSkgfSk7XG4gICAgdGhyb3cgZXJyO1xuICB9XG59XG5cbi8qKlxuICogU2F2ZSBhbiBhcnRpZmFjdCB0byBEQiBhbmQgd3JpdGUgdGhlIGNvcnJlc3BvbmRpbmcgbWFya2Rvd24gZmlsZSB0byBkaXNrLlxuICogVGhlIHBhdGggaXMgcmVsYXRpdmUgdG8gLmdzZC8gKGUuZy4gXCJtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwNi90YXNrcy9UMDEtU1VNTUFSWS5tZFwiKS5cbiAqIFRoZSBmdWxsIGZpbGUgcGF0aCBpcyBjb21wdXRlZCBhcyBiYXNlUGF0aCArICcuZ3NkLycgKyBwYXRoLlxuICpcbiAqIEBkZXByZWNhdGVkIFVzZSBzYXZlQXJ0aWZhY3RUb0RiQnlTY29wZSBpbnN0ZWFkLCB3aGljaCByb3V0ZXMgdGhyb3VnaCB0aGVcbiAqIHdvcmtzcGFjZSBjb250cmFjdCBmb3IgY2Fub25pY2FsIHBhdGggcmVzb2x1dGlvbi5cbiAqIFRPRE8oQy1mdXR1cmUpOiByZW1vdmUgdGhpcyBsZWdhY3kgd3JhcHBlciBvbmNlIGFsbCBjYWxsZXJzIGFyZSBtaWdyYXRlZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNhdmVBcnRpZmFjdFRvRGIoXG4gIG9wdHM6IFNhdmVBcnRpZmFjdE9wdHMsXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgd29ya3NwYWNlID0gY3JlYXRlV29ya3NwYWNlKGJhc2VQYXRoKTtcbiAgY29uc3QgbWlsZXN0b25lSWQgPSBvcHRzLm1pbGVzdG9uZV9pZDtcbiAgaWYgKG1pbGVzdG9uZUlkKSB7XG4gICAgcmV0dXJuIHNhdmVBcnRpZmFjdFRvRGJCeVNjb3BlKHNjb3BlTWlsZXN0b25lKHdvcmtzcGFjZSwgbWlsZXN0b25lSWQpLCBvcHRzKTtcbiAgfVxuICByZXR1cm4gc2F2ZUFydGlmYWN0VG9EYkZvcldvcmtzcGFjZSh3b3Jrc3BhY2UsIG9wdHMpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBVUEsU0FBUyxZQUFrQixVQUFVLGVBQWU7QUFDcEQsU0FBUyxjQUFjLFlBQVksZ0JBQWdCO0FBRW5ELFNBQVMsMEJBQTBCO0FBQ25DLFNBQVMsZ0JBQWdCO0FBQ3pCLFNBQVMsVUFBVSxpQkFBaUIsb0JBQW9CO0FBQ3hELFNBQVMsWUFBWSxnQkFBZ0I7QUFDckMsU0FBUyw0QkFBNEI7QUFDckMsU0FBUyxzQkFBc0I7QUFDL0IsU0FBUyx1QkFBdUI7QUFFaEMsU0FBUyxpQkFBaUIsc0JBQXNCO0FBY3pDLFNBQVMsdUJBQXVCLFNBQTBCO0FB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O0FBRUEsUUFBSSxtQkFBbUIsS0FBSztBQUM1QixRQUFJLEtBQUssa0JBQWtCLGtCQUFrQixLQUFLLFNBQVMsbUJBQW1CO0FBQzVFLFlBQU0scUJBQXFCLEdBQUcsc0JBQXNCO0FBQ3BELFVBQUksbUJBQW1CLFdBQVcsR0FBRztBQUNuQyxjQUFNLElBQUksU0FBUyxpQkFBaUIseUZBQXlGO0FBQUEsTUFDL0g7QUFDQSx5QkFBbUIsdUJBQXVCLGtCQUFrQjtBQUFBLElBQzlEO0FBTUEsUUFBSSxnQkFBZ0I7QUFDcEIsUUFBSSxDQUFDLHdCQUF3QixJQUFJLEtBQUssV0FBVyxRQUFRLEdBQUc7QUFDMUQsWUFBTSxlQUFlLFNBQVMsUUFBUSxFQUFFO0FBQ3hDLFlBQU0sVUFBVSxPQUFPLFdBQVcsa0JBQWtCLE9BQU87QUFDM0QsVUFBSSxlQUFlLEtBQUssVUFBVSxlQUFlLEtBQUs7QUFDcEQsbUJBQVcsY0FBYyxnQkFBZ0IsT0FBTyxzQ0FBc0MsWUFBWSwyREFBMkQsRUFBRSxJQUFJLDJCQUEyQixNQUFNLEtBQUssS0FBSyxDQUFDO0FBQy9NLHdCQUFnQjtBQUFBLE1BQ2xCO0FBQUEsSUFDRjtBQUVBLE9BQUcsZUFBZTtBQUFBLE1BQ2hCLE1BQU0sS0FBSztBQUFBLE1BQ1gsZUFBZSxLQUFLO0FBQUEsTUFDcEIsY0FBYyxLQUFLLGdCQUFnQjtBQUFBLE1BQ25DLFVBQVUsS0FBSyxZQUFZO0FBQUEsTUFDM0IsU0FBUyxLQUFLLFdBQVc7QUFBQSxNQUN6QixjQUFjO0FBQUEsSUFDaEIsQ0FBQztBQUdELFFBQUksQ0FBQyxlQUFlO0FBQ2xCLFVBQUk7QUFDRixjQUFNLFNBQVMsVUFBVSxnQkFBZ0I7QUFBQSxNQUMzQyxTQUFTLFNBQVM7QUFDaEIsbUJBQVcsY0FBYyxtRUFBbUUsRUFBRSxJQUFJLDJCQUEyQixNQUFNLEtBQUssTUFBTSxPQUFPLE9BQVEsUUFBa0IsT0FBTyxFQUFFLENBQUM7QUFBQSxNQUMzTDtBQUFBLElBQ0Y7QUFHQSx5QkFBcUI7QUFDckIsbUJBQWU7QUFDZixvQkFBZ0I7QUFBQSxFQUNsQixTQUFTLEtBQUs7QUFDWixhQUFTLFlBQVksa0NBQWtDLEVBQUUsSUFBSSwyQkFBMkIsT0FBTyxPQUFRLElBQWMsT0FBTyxFQUFFLENBQUM7QUFDL0gsVUFBTTtBQUFBLEVBQ1I7QUFDRjtBQVdBLGVBQXNCLGlCQUNwQixNQUNBLFVBQ2U7QUFDZixRQUFNLFlBQVksZ0JBQWdCLFFBQVE7QUFDMUMsUUFBTSxjQUFjLEtBQUs7QUFDekIsTUFBSSxhQUFhO0FBQ2YsV0FBTyx3QkFBd0IsZUFBZSxXQUFXLFdBQVcsR0FBRyxJQUFJO0FBQUEsRUFDN0U7QUFDQSxTQUFPLDZCQUE2QixXQUFXLElBQUk7QUFDckQ7IiwKICAibmFtZXMiOiBbImFkYXB0ZXIiXQp9Cg==
