import { Type } from "@sinclair/typebox";
import { Text } from "@gsd/pi-tui";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { ensureDbOpen, resolveCtxCwd } from "./dynamic-tools.js";
import { loadWriteGateSnapshot, shouldBlockRootArtifactSaveInSnapshot } from "./write-gate.js";
import { StringEnum } from "@gsd/pi-ai";
import { logError } from "../workflow-logger.js";
import { incrementLegacyTelemetry } from "../legacy-telemetry.js";
async function loadWorkflowExecutors() {
  return import("../tools/workflow-tool-executors.js");
}
function registerAlias(pi, toolDef, aliasName, canonicalName) {
  const execute = typeof toolDef.execute === "function" ? async (...args) => {
    incrementLegacyTelemetry("legacy.mcpAliasUsed");
    return toolDef.execute(...args);
  } : toolDef.execute;
  pi.registerTool({
    ...toolDef,
    name: aliasName,
    description: toolDef.description + ` (alias for ${canonicalName} \u2014 prefer the canonical name)`,
    promptGuidelines: [`Alias for ${canonicalName} \u2014 prefer the canonical name.`],
    execute
  });
}
function requirementRootWriteGuard(operation, basePath) {
  const guard = shouldBlockRootArtifactSaveInSnapshot(loadWriteGateSnapshot(basePath), "REQUIREMENTS");
  if (!guard.block) return null;
  return {
    content: [{ type: "text", text: `Error ${operation} requirement: ${guard.reason ?? "requirements write blocked"}` }],
    details: { operation, error: "root_artifact_write_blocked" },
    isError: true
  };
}
function readDetails(result) {
  return result?.details ?? result?.structuredContent;
}
function registerDbTools(pi) {
  const decisionSaveExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const basePath = resolveCtxCwd(_ctx);
    const dbAvailable = await ensureDbOpen(basePath);
    if (!dbAvailable) {
      return {
        content: [{ type: "text", text: "Error: GSD database is not available. Cannot save decision." }],
        details: { operation: "save_decision", error: "db_unavailable" }
      };
    }
    try {
      const { saveDecisionToDb } = await import("../db-writer.js");
      const { id } = await saveDecisionToDb(
        {
          scope: params.scope,
          decision: params.decision,
          choice: params.choice,
          rationale: params.rationale,
          revisable: params.revisable,
          when_context: params.when_context,
          made_by: params.made_by
        },
        basePath
      );
      return {
        content: [{ type: "text", text: `Saved decision ${id}` }],
        details: { operation: "save_decision", id }
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `gsd_decision_save tool failed: ${msg}`, { tool: "gsd_decision_save", error: String(err) });
      return {
        content: [{ type: "text", text: `Error saving decision: ${msg}` }],
        details: { operation: "save_decision", error: msg }
      };
    }
  };
  const decisionSaveTool = {
    name: "gsd_decision_save",
    label: "Save Decision",
    description: "Record a project decision to the GSD database and regenerate DECISIONS.md. Decision IDs are auto-assigned \u2014 never provide an ID manually.",
    promptSnippet: "Record a project decision to the GSD database (auto-assigns ID, regenerates DECISIONS.md)",
    promptGuidelines: [
      "Use gsd_decision_save when recording an architectural, pattern, library, or observability decision.",
      "Decision IDs are auto-assigned (D001, D002, ...) \u2014 never guess or provide an ID.",
      "All fields except revisable, when_context, and made_by are required.",
      "The tool writes to the DB and regenerates .gsd/DECISIONS.md automatically.",
      "Set made_by to 'human' when the user explicitly directed the decision, 'agent' when the LLM chose autonomously (default), or 'collaborative' when it was discussed and agreed together."
    ],
    parameters: Type.Object({
      scope: Type.String({ description: "Scope of the decision (e.g. 'architecture', 'library', 'observability')" }),
      decision: Type.String({ description: "What is being decided" }),
      choice: Type.String({ description: "The choice made" }),
      rationale: Type.String({ description: "Why this choice was made" }),
      revisable: Type.Optional(Type.String({ description: "Whether this can be revisited (default: 'Yes')" })),
      when_context: Type.Optional(Type.String({ description: "When/context for the decision (e.g. milestone ID)" })),
      made_by: Type.Optional(Type.Union([
        Type.Literal("human"),
        Type.Literal("agent"),
        Type.Literal("collaborative")
      ], { description: "Who made this decision: 'human' (user directed), 'agent' (LLM decided autonomously), or 'collaborative' (discussed and agreed). Default: 'agent'" }))
    }),
    execute: decisionSaveExecute,
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("decision_save "));
      if (args.scope) text += theme.fg("accent", `[${args.scope}] `);
      if (args.decision) text += theme.fg("muted", args.decision);
      if (args.choice) text += theme.fg("dim", ` \u2014 ${args.choice}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const d = readDetails(result);
      if (result.isError || d?.error) {
        return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
      }
      let text = theme.fg("success", `Decision ${d?.id ?? ""} saved`);
      if (d?.id) text += theme.fg("dim", ` \u2192 DECISIONS.md`);
      return new Text(text, 0, 0);
    }
  };
  pi.registerTool(decisionSaveTool);
  registerAlias(pi, decisionSaveTool, "gsd_save_decision", "gsd_decision_save");
  const requirementUpdateExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const basePath = resolveCtxCwd(_ctx);
    const gateBlock = requirementRootWriteGuard("update_requirement", basePath);
    if (gateBlock) return gateBlock;
    const dbAvailable = await ensureDbOpen(basePath);
    if (!dbAvailable) {
      return {
        content: [{ type: "text", text: "Error: GSD database is not available. Cannot update requirement." }],
        details: { operation: "update_requirement", id: params.id, error: "db_unavailable" }
      };
    }
    try {
      const { updateRequirementInDb } = await import("../db-writer.js");
      const updates = {};
      if (params.status !== void 0) updates.status = params.status;
      if (params.validation !== void 0) updates.validation = params.validation;
      if (params.notes !== void 0) updates.notes = params.notes;
      if (params.description !== void 0) updates.description = params.description;
      if (params.primary_owner !== void 0) updates.primary_owner = params.primary_owner;
      if (params.supporting_slices !== void 0) updates.supporting_slices = params.supporting_slices;
      await updateRequirementInDb(params.id, updates, basePath);
      return {
        content: [{ type: "text", text: `Updated requirement ${params.id}` }],
        details: { operation: "update_requirement", id: params.id }
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `gsd_requirement_update tool failed: ${msg}`, { tool: "gsd_requirement_update", error: String(err) });
      return {
        content: [{ type: "text", text: `Error updating requirement: ${msg}` }],
        details: { operation: "update_requirement", id: params.id, error: msg }
      };
    }
  };
  const requirementUpdateTool = {
    name: "gsd_requirement_update",
    label: "Update Requirement",
    description: "Update an existing requirement in the GSD database and regenerate REQUIREMENTS.md. Provide the requirement ID (e.g. R001) and any fields to update.",
    promptSnippet: "Update an existing GSD requirement by ID (regenerates REQUIREMENTS.md)",
    promptGuidelines: [
      "Use gsd_requirement_update to change status, validation, notes, or other fields on an existing requirement.",
      "The id parameter is required \u2014 it must be an existing RXXX identifier.",
      "All other fields are optional \u2014 only provided fields are updated.",
      "The tool verifies the requirement exists before updating."
    ],
    parameters: Type.Object({
      id: Type.String({ description: "The requirement ID (e.g. R001, R014)" }),
      status: Type.Optional(Type.String({ description: "New status (e.g. 'active', 'validated', 'deferred')" })),
      validation: Type.Optional(Type.String({ description: "Validation criteria or proof" })),
      notes: Type.Optional(Type.String({ description: "Additional notes" })),
      description: Type.Optional(Type.String({ description: "Updated description" })),
      primary_owner: Type.Optional(Type.String({ description: "Primary owning slice" })),
      supporting_slices: Type.Optional(Type.String({ description: "Supporting slices" }))
    }),
    execute: requirementUpdateExecute,
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("requirement_update "));
      if (args.id) text += theme.fg("accent", args.id);
      const fields = ["status", "validation", "notes", "description"].filter((f) => args[f]);
      if (fields.length > 0) text += theme.fg("dim", ` (${fields.join(", ")})`);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const d = readDetails(result);
      if (result.isError || d?.error) {
        return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
      }
      let text = theme.fg("success", `Requirement ${d?.id ?? ""} updated`);
      text += theme.fg("dim", ` \u2192 REQUIREMENTS.md`);
      return new Text(text, 0, 0);
    }
  };
  pi.registerTool(requirementUpdateTool);
  registerAlias(pi, requirementUpdateTool, "gsd_update_requirement", "gsd_requirement_update");
  const requirementSaveExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const basePath = resolveCtxCwd(_ctx);
    const gateBlock = requirementRootWriteGuard("save_requirement", basePath);
    if (gateBlock) return gateBlock;
    const dbAvailable = await ensureDbOpen(basePath);
    if (!dbAvailable) {
      return {
        content: [{ type: "text", text: "Error: GSD database is not available. Cannot save requirement." }],
        details: { operation: "save_requirement", error: "db_unavailable" }
      };
    }
    try {
      const { saveRequirementToDb } = await import("../db-writer.js");
      const result = await saveRequirementToDb(
        {
          class: params.class,
          status: params.status,
          description: params.description,
          why: params.why,
          source: params.source,
          primary_owner: params.primary_owner,
          supporting_slices: params.supporting_slices,
          validation: params.validation,
          notes: params.notes
        },
        basePath
      );
      return {
        content: [{ type: "text", text: `Saved requirement ${result.id}` }],
        details: { operation: "save_requirement", id: result.id }
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `gsd_requirement_save tool failed: ${msg}`, { tool: "gsd_requirement_save", error: String(err) });
      return {
        content: [{ type: "text", text: `Error saving requirement: ${msg}` }],
        details: { operation: "save_requirement", error: msg }
      };
    }
  };
  const requirementSaveTool = {
    name: "gsd_requirement_save",
    label: "Save Requirement",
    description: "Record a new requirement to the GSD database and regenerate REQUIREMENTS.md. Requirement IDs are auto-assigned \u2014 never provide an ID manually.",
    promptSnippet: "Record a new GSD requirement to the database (auto-assigns ID, regenerates REQUIREMENTS.md)",
    promptGuidelines: [
      "Use gsd_requirement_save when recording a new capability, quality attribute, constraint, or anti-feature requirement.",
      "Use one of these classes: core-capability, primary-user-loop, launchability, continuity, failure-visibility, integration, quality-attribute, operability, admin/support, compliance/security, differentiator, constraint, anti-feature.",
      "Requirement IDs are auto-assigned (R001, R002, ...) \u2014 never guess or provide an ID.",
      "class, description, why, and source are required. All other fields are optional.",
      "The tool writes to the DB and regenerates .gsd/REQUIREMENTS.md automatically."
    ],
    parameters: Type.Object({
      class: StringEnum([
        "core-capability",
        "primary-user-loop",
        "launchability",
        "continuity",
        "failure-visibility",
        "integration",
        "quality-attribute",
        "operability",
        "admin/support",
        "compliance/security",
        "differentiator",
        "constraint",
        "anti-feature"
      ], { description: "Requirement class" }),
      description: Type.String({ description: "Short description of the requirement" }),
      why: Type.String({ description: "Why this requirement matters" }),
      source: Type.String({ description: "Origin of the requirement (e.g. 'user-research', 'design', 'M001')" }),
      status: Type.Optional(Type.String({ description: "Status (default: 'active')" })),
      primary_owner: Type.Optional(Type.String({ description: "Primary owning slice" })),
      supporting_slices: Type.Optional(Type.String({ description: "Supporting slices" })),
      validation: Type.Optional(Type.String({ description: "Validation criteria" })),
      notes: Type.Optional(Type.String({ description: "Additional notes" }))
    }),
    execute: requirementSaveExecute,
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("requirement_save "));
      if (args.class) text += theme.fg("accent", `[${args.class}] `);
      if (args.description) text += theme.fg("muted", args.description);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const d = readDetails(result);
      if (result.isError || d?.error) {
        return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
      }
      let text = theme.fg("success", `Requirement ${d?.id ?? ""} saved`);
      text += theme.fg("dim", ` \u2192 REQUIREMENTS.md`);
      return new Text(text, 0, 0);
    }
  };
  pi.registerTool(requirementSaveTool);
  registerAlias(pi, requirementSaveTool, "gsd_save_requirement", "gsd_requirement_save");
  const summarySaveExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const { executeSummarySave } = await loadWorkflowExecutors();
    return executeSummarySave(params, resolveCtxCwd(_ctx));
  };
  const summarySaveTool = {
    name: "gsd_summary_save",
    label: "Save Summary",
    description: "Save a summary, research, context, or assessment artifact to the GSD database and write it to disk. Computes the file path from milestone/slice/task IDs automatically.",
    promptSnippet: "Save a GSD artifact (summary/research/context/assessment) to DB and disk",
    promptGuidelines: [
      "Use gsd_summary_save to persist structured artifacts (SUMMARY, RESEARCH, CONTEXT, ASSESSMENT, CONTEXT-DRAFT, PROJECT, PROJECT-DRAFT, REQUIREMENTS, REQUIREMENTS-DRAFT).",
      "milestone_id is required for milestone/slice/task artifacts. Omit milestone_id only for root-level PROJECT/PROJECT-DRAFT/REQUIREMENTS/REQUIREMENTS-DRAFT.",
      "The tool computes the relative path automatically: milestones/M001/M001-SUMMARY.md, milestones/M001/slices/S01/S01-SUMMARY.md, etc.",
      "Root-level artifact paths are PROJECT.md, PROJECT-DRAFT.md, REQUIREMENTS.md, and REQUIREMENTS-DRAFT.md.",
      "artifact_type must be one of: SUMMARY, RESEARCH, CONTEXT, ASSESSMENT, CONTEXT-DRAFT, PROJECT, PROJECT-DRAFT, REQUIREMENTS, REQUIREMENTS-DRAFT.",
      "Use CONTEXT-DRAFT for incremental draft persistence; use CONTEXT for the final milestone context after depth verification."
    ],
    parameters: Type.Object({
      milestone_id: Type.Optional(Type.String({ description: "Milestone ID (e.g. M001). Omit only for root-level PROJECT/PROJECT-DRAFT/REQUIREMENTS/REQUIREMENTS-DRAFT artifacts." })),
      slice_id: Type.Optional(Type.String({ description: "Slice ID (e.g. S01)" })),
      task_id: Type.Optional(Type.String({ description: "Task ID (e.g. T01)" })),
      artifact_type: StringEnum(["SUMMARY", "RESEARCH", "CONTEXT", "ASSESSMENT", "CONTEXT-DRAFT", "PROJECT", "PROJECT-DRAFT", "REQUIREMENTS", "REQUIREMENTS-DRAFT"], { description: "Artifact type to save" }),
      content: Type.String({ description: "The full markdown content of the artifact" })
    }),
    execute: summarySaveExecute,
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("summary_save "));
      if (args.artifact_type) text += theme.fg("accent", args.artifact_type);
      const path = [args.milestone_id, args.slice_id, args.task_id].filter(Boolean).join("/");
      if (path) text += theme.fg("dim", ` ${path}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const d = readDetails(result);
      if (result.isError || d?.error) {
        return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
      }
      let text = theme.fg("success", `${d?.artifact_type ?? "Artifact"} saved`);
      if (d?.path) text += theme.fg("dim", ` \u2192 ${d.path}`);
      return new Text(text, 0, 0);
    }
  };
  pi.registerTool(summarySaveTool);
  registerAlias(pi, summarySaveTool, "gsd_save_summary", "gsd_summary_save");
  const milestoneGenerateIdExecute = async (_toolCallId, _params, _signal, _onUpdate, _ctx) => {
    try {
      const basePath = resolveCtxCwd(_ctx);
      const { claimReservedId, findMilestoneIds, getReservedMilestoneIds, nextMilestoneId } = await import("../guided-flow.js");
      const reserved = claimReservedId();
      if (reserved) {
        await ensureMilestoneDbRow(reserved, basePath);
        return {
          content: [{ type: "text", text: reserved }],
          details: { operation: "generate_milestone_id", id: reserved, source: "reserved" }
        };
      }
      const existingIds = findMilestoneIds(basePath);
      const uniqueEnabled = !!loadEffectiveGSDPreferences(basePath)?.preferences?.unique_milestone_ids;
      const allIds = [.../* @__PURE__ */ new Set([...existingIds, ...getReservedMilestoneIds()])];
      const newId = nextMilestoneId(allIds, uniqueEnabled);
      await ensureMilestoneDbRow(newId, basePath);
      return {
        content: [{ type: "text", text: newId }],
        details: { operation: "generate_milestone_id", id: newId, existingCount: existingIds.length, uniqueEnabled }
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error generating milestone ID: ${msg}` }],
        details: { operation: "generate_milestone_id", error: msg }
      };
    }
  };
  async function ensureMilestoneDbRow(milestoneId, basePath) {
    const dbAvailable = await ensureDbOpen(basePath);
    if (!dbAvailable) return;
    try {
      const { insertMilestone } = await import("../gsd-db.js");
      insertMilestone({ id: milestoneId, status: "queued" });
    } catch (e) {
      logError("tool", `insertMilestone failed for ${milestoneId}: ${e.message}`);
    }
  }
  const milestoneGenerateIdTool = {
    name: "gsd_milestone_generate_id",
    label: "Generate Milestone ID",
    description: "Generate the next milestone ID for a new GSD milestone. Scans existing milestones on disk and respects the unique_milestone_ids preference. Always use this tool when creating a new milestone \u2014 never invent milestone IDs manually.",
    promptSnippet: "Generate a valid milestone ID (respects unique_milestone_ids preference)",
    promptGuidelines: [
      "ALWAYS call gsd_milestone_generate_id before creating a new milestone directory or writing milestone files.",
      "Never invent or hardcode milestone IDs like M001, M002 \u2014 always use this tool.",
      "Call it once per milestone you need to create. For multi-milestone projects, call it once for each milestone in sequence.",
      "The tool returns the correct format based on project preferences (e.g. M001 or M001-r5jzab)."
    ],
    parameters: Type.Object({}),
    execute: milestoneGenerateIdExecute,
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("milestone_generate_id")), 0, 0);
    },
    renderResult(result, _options, theme) {
      const d = readDetails(result);
      if (result.isError || d?.error) {
        return new Text(theme.fg("error", `Error: ${d?.error ?? "unknown"}`), 0, 0);
      }
      let text = theme.fg("success", `Generated ${d?.id ?? "ID"}`);
      if (d?.source === "reserved") text += theme.fg("dim", " (reserved)");
      return new Text(text, 0, 0);
    }
  };
  pi.registerTool(milestoneGenerateIdTool);
  registerAlias(pi, milestoneGenerateIdTool, "gsd_generate_milestone_id", "gsd_milestone_generate_id");
  const planMilestoneExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const { executePlanMilestone } = await loadWorkflowExecutors();
    return executePlanMilestone(params, resolveCtxCwd(_ctx));
  };
  const planMilestoneTool = {
    name: "gsd_plan_milestone",
    label: "Plan Milestone",
    description: "Write milestone planning state to the GSD database, render ROADMAP.md from DB, and clear caches after a successful render.",
    promptSnippet: "Plan a milestone via DB write + roadmap render + cache invalidation",
    promptGuidelines: [
      "Use gsd_plan_milestone for milestone planning instead of writing ROADMAP.md directly.",
      "Keep parameters flat and provide the full milestone planning payload, including slices.",
      "Milestone and slice titles must not contain forward slash (/), en dash, or em dash characters.",
      "The tool validates input, writes milestone and slice planning data transactionally, renders ROADMAP.md from DB, and clears both state and parse caches after success.",
      "Use the canonical name gsd_plan_milestone; gsd_milestone_plan is only an alias."
    ],
    parameters: Type.Object({
      // ── Core identification + content (required) ──────────────────────
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      title: Type.String({ description: "Milestone title; must not contain forward slash (/), en dash, or em dash characters" }),
      vision: Type.String({ description: "Milestone vision" }),
      slices: Type.Array(Type.Object({
        sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
        title: Type.String({ description: "Slice title; must not contain forward slash (/), en dash, or em dash characters" }),
        risk: Type.String({ description: "Slice risk" }),
        depends: Type.Array(Type.String(), { description: "Slice dependency IDs" }),
        demo: Type.String({ description: "Roadmap demo text / After this" }),
        goal: Type.String({ description: "Slice goal" }),
        // ADR-011: heavy planning fields are optional for sketch slices; required for full slices.
        successCriteria: Type.Optional(Type.String({ description: "Slice success criteria block (required for full slices; omit for sketches)" })),
        proofLevel: Type.Optional(Type.String({ description: "Slice proof level (required for full slices; omit for sketches)" })),
        integrationClosure: Type.Optional(Type.String({ description: "Slice integration closure (required for full slices; omit for sketches)" })),
        observabilityImpact: Type.Optional(Type.String({ description: "Slice observability impact (required for full slices; omit for sketches)" })),
        // ADR-011 sketch-then-refine fields.
        isSketch: Type.Optional(Type.Boolean({ description: "ADR-011: true marks this slice as a sketch awaiting refine-slice expansion" })),
        sketchScope: Type.Optional(Type.String({ description: "ADR-011: 2\u20133 sentence scope boundary, required when isSketch=true" }))
      }), { description: "Planned slices for the milestone" }),
      // ── Enrichment metadata (optional — defaults to empty) ────────────
      status: Type.Optional(Type.String({ description: "Milestone status (defaults to active)" })),
      dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Milestone dependencies" })),
      successCriteria: Type.Optional(Type.Array(Type.String(), { description: "Top-level success criteria bullets" })),
      keyRisks: Type.Optional(Type.Array(Type.Object({
        risk: Type.String({ description: "Risk statement" }),
        whyItMatters: Type.String({ description: "Why the risk matters" })
      }), { description: "Structured risk entries" })),
      proofStrategy: Type.Optional(Type.Array(Type.Object({
        riskOrUnknown: Type.String({ description: "Risk or unknown to retire" }),
        retireIn: Type.String({ description: "Where it will be retired" }),
        whatWillBeProven: Type.String({ description: "What proof will be produced" })
      }), { description: "Structured proof strategy entries" })),
      verificationContract: Type.Optional(Type.String({ description: "Verification contract text" })),
      verificationIntegration: Type.Optional(Type.String({ description: "Integration verification text" })),
      verificationOperational: Type.Optional(Type.String({ description: "Operational verification text" })),
      verificationUat: Type.Optional(Type.String({ description: "UAT verification text" })),
      definitionOfDone: Type.Optional(Type.Array(Type.String(), { description: "Definition of done bullets" })),
      requirementCoverage: Type.Optional(Type.String({ description: "Requirement coverage text" })),
      boundaryMapMarkdown: Type.Optional(Type.String({ description: "Boundary map markdown block" })),
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'plan-phase complete')" }))
    }),
    execute: planMilestoneExecute
  };
  pi.registerTool(planMilestoneTool);
  registerAlias(pi, planMilestoneTool, "gsd_milestone_plan", "gsd_plan_milestone");
  const planSliceExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const { executePlanSlice } = await loadWorkflowExecutors();
    return executePlanSlice(params, resolveCtxCwd(_ctx));
  };
  const planSliceTool = {
    name: "gsd_plan_slice",
    label: "Plan Slice",
    description: "Write slice planning state to the GSD database, render S##-PLAN.md plus task PLAN artifacts from DB, and clear caches after a successful render.",
    promptSnippet: "Plan a slice via DB write + PLAN render + cache invalidation",
    promptGuidelines: [
      "Use gsd_plan_slice for slice planning instead of writing S##-PLAN.md or task PLAN files directly.",
      "Keep parameters flat and provide the full slice planning payload, including tasks.",
      "The tool validates input, requires an existing parent slice, writes slice/task planning data, renders PLAN.md and task plan files from DB, and clears both state and parse caches after success.",
      "Use the canonical name gsd_plan_slice; gsd_slice_plan is only an alias."
    ],
    parameters: Type.Object({
      // ── Core identification + content (required) ──────────────────────
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      goal: Type.String({ description: "Slice goal" }),
      tasks: Type.Array(Type.Object({
        taskId: Type.String({ description: "Task ID (e.g. T01)" }),
        title: Type.String({ description: "Task title" }),
        description: Type.String({ description: "Task description / steps block" }),
        estimate: Type.String({ description: "Task estimate string" }),
        files: Type.Array(Type.String(), { description: 'Array<string> of files likely touched; pass ["path"] or [], never a single string' }),
        verify: Type.String({ description: "Verification command or block" }),
        inputs: Type.Array(Type.String(), { description: 'Array<string> of input files or references; pass ["path"] or [], never a single string' }),
        expectedOutput: Type.Array(Type.String(), { description: 'Array<string> of expected output files or artifacts; pass ["path"] or [], never a single string' }),
        observabilityImpact: Type.Optional(Type.String({ description: "Task observability impact" }))
      }), { description: "Planned tasks for the slice" }),
      // ── Enrichment metadata (optional — defaults to empty) ────────────
      successCriteria: Type.Optional(Type.String({ description: "Slice success criteria block" })),
      proofLevel: Type.Optional(Type.String({ description: "Slice proof level" })),
      integrationClosure: Type.Optional(Type.String({ description: "Slice integration closure" })),
      observabilityImpact: Type.Optional(Type.String({ description: "Slice observability impact" })),
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'plan-phase complete')" }))
    }),
    execute: planSliceExecute
  };
  pi.registerTool(planSliceTool);
  registerAlias(pi, planSliceTool, "gsd_slice_plan", "gsd_plan_slice");
  const planTaskExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const basePath = resolveCtxCwd(_ctx);
    const dbAvailable = await ensureDbOpen(basePath);
    if (!dbAvailable) {
      return {
        content: [{ type: "text", text: "Error: GSD database is not available. Cannot plan task." }],
        details: { operation: "plan_task", error: "db_unavailable" }
      };
    }
    try {
      const { handlePlanTask } = await import("../tools/plan-task.js");
      const result = await handlePlanTask(params, basePath);
      if ("error" in result) {
        return {
          content: [{ type: "text", text: `Error planning task: ${result.error}` }],
          details: { operation: "plan_task", error: result.error }
        };
      }
      return {
        content: [{ type: "text", text: `Planned task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }],
        details: {
          operation: "plan_task",
          milestoneId: result.milestoneId,
          sliceId: result.sliceId,
          taskId: result.taskId,
          taskPlanPath: result.taskPlanPath
        }
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `plan_task tool failed: ${msg}`, { tool: "gsd_plan_task", error: String(err) });
      return {
        content: [{ type: "text", text: `Error planning task: ${msg}` }],
        details: { operation: "plan_task", error: msg }
      };
    }
  };
  const planTaskTool = {
    name: "gsd_plan_task",
    label: "Plan Task",
    description: "Write task planning state to the GSD database, render tasks/T##-PLAN.md from DB, and clear caches after a successful render.",
    promptSnippet: "Plan a task via DB write + task PLAN render + cache invalidation",
    promptGuidelines: [
      "Use gsd_plan_task for task planning instead of writing tasks/T##-PLAN.md directly.",
      "Keep parameters flat and provide the full task planning payload.",
      "The tool validates input, requires an existing parent slice, writes task planning data, renders the task PLAN file from DB, and clears both state and parse caches after success.",
      "Use the canonical name gsd_plan_task; gsd_task_plan is only an alias."
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      taskId: Type.String({ description: "Task ID (e.g. T01)" }),
      title: Type.String({ description: "Task title" }),
      description: Type.String({ description: "Task description / steps block" }),
      estimate: Type.String({ description: "Task estimate string" }),
      files: Type.Array(Type.String(), { description: 'Array<string> of files likely touched; pass ["path"] or [], never a single string' }),
      verify: Type.String({ description: "Verification command or block" }),
      inputs: Type.Array(Type.String(), { description: 'Array<string> of input files or references; pass ["path"] or [], never a single string' }),
      expectedOutput: Type.Array(Type.String(), { description: 'Array<string> of expected output files or artifacts; pass ["path"] or [], never a single string' }),
      observabilityImpact: Type.Optional(Type.String({ description: "Task observability impact" })),
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'plan-phase complete')" }))
    }),
    execute: planTaskExecute
  };
  pi.registerTool(planTaskTool);
  registerAlias(pi, planTaskTool, "gsd_task_plan", "gsd_plan_task");
  const taskCompleteExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const { executeTaskComplete } = await loadWorkflowExecutors();
    return executeTaskComplete(params, resolveCtxCwd(_ctx));
  };
  const taskCompleteTool = {
    name: "gsd_task_complete",
    label: "Complete Task",
    description: "Record a completed task to the GSD database, render a SUMMARY.md to disk, and toggle the plan checkbox \u2014 all in one atomic operation. Writes the task row inside a transaction, then performs filesystem writes outside the transaction.",
    promptSnippet: "Complete a GSD task (DB write + summary render + checkbox toggle)",
    promptGuidelines: [
      "Use gsd_task_complete (or gsd_complete_task) when a task is finished and needs to be recorded.",
      "All string fields are required. verificationEvidence is an array of objects with command, exitCode, verdict, durationMs.",
      "The tool validates required fields and returns an error message if any are missing.",
      "On success, returns the summaryPath where the SUMMARY.md was written.",
      "Idempotent \u2014 calling with the same params twice will upsert (INSERT OR REPLACE) without error."
    ],
    parameters: Type.Object({
      // ── Core identification + content (required) ──────────────────────
      taskId: Type.String({ description: "Task ID (e.g. T01)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      oneLiner: Type.String({ description: "One-line summary of what was accomplished" }),
      narrative: Type.String({ description: "Detailed narrative of what happened during the task" }),
      verification: Type.String({ description: "What was verified and how \u2014 commands run, tests passed, behavior confirmed" }),
      // ── Enrichment metadata (optional — defaults to empty) ────────────
      deviations: Type.Optional(Type.String({ description: "Deviations from the task plan, or 'None.'" })),
      knownIssues: Type.Optional(Type.String({ description: "Known issues discovered but not fixed, or 'None.'" })),
      keyFiles: Type.Optional(Type.Array(Type.String(), { description: "List of key files created or modified" })),
      keyDecisions: Type.Optional(Type.Array(Type.String(), { description: "List of key decisions made during this task" })),
      blockerDiscovered: Type.Optional(Type.Boolean({ description: "Whether a plan-invalidating blocker was discovered" })),
      // ADR-011 Phase 2: mid-execution escalation — agent asks the user to resolve an ambiguity.
      escalation: Type.Optional(Type.Object({
        question: Type.String({ description: "The question the user needs to answer \u2014 one clear sentence." }),
        options: Type.Array(Type.Object({
          id: Type.String({ description: "Short id (e.g. 'A', 'B') used by /gsd escalate resolve." }),
          label: Type.String({ description: "One-line label." }),
          tradeoffs: Type.String({ description: "1-2 sentences on the tradeoffs of this option." })
        }), { minItems: 2, maxItems: 4, description: "2\u20134 options the user can choose between." }),
        recommendation: Type.String({ description: "Option id the executor recommends." }),
        recommendationRationale: Type.String({ description: "Why the recommendation \u2014 1\u20132 sentences." }),
        continueWithDefault: Type.Boolean({
          description: "When true, loop continues (artifact logged for later review). When false, auto-mode pauses until the user resolves via /gsd escalate resolve."
        })
      }, { description: "ADR-011 Phase 2: optional escalation payload. Only honored when phases.mid_execution_escalation is true." })),
      verificationEvidence: Type.Optional(Type.Array(
        Type.Union([
          Type.Object({
            command: Type.String({ description: "Verification command that was run" }),
            exitCode: Type.Number({ description: "Exit code of the command" }),
            verdict: Type.String({ description: "Pass/fail verdict (e.g. '\u2705 pass', '\u274C fail')" }),
            durationMs: Type.Number({ description: "Duration of the command in milliseconds" })
          }),
          Type.String({ description: "Fallback: verification summary string" })
        ]),
        { description: "Array of verification evidence entries" }
      )),
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'task verified after retry')" }))
    }),
    execute: taskCompleteExecute
  };
  pi.registerTool(taskCompleteTool);
  registerAlias(pi, taskCompleteTool, "gsd_complete_task", "gsd_task_complete");
  const sliceCompleteExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const { executeSliceComplete } = await loadWorkflowExecutors();
    return executeSliceComplete(params, resolveCtxCwd(_ctx));
  };
  const sliceCompleteTool = {
    name: "gsd_slice_complete",
    label: "Complete Slice",
    description: "Record a completed slice to the GSD database, render SUMMARY.md + UAT.md to disk, and toggle the roadmap checkbox \u2014 all in one atomic operation. Validates all tasks are complete before proceeding. Writes the slice row inside a transaction, then performs filesystem writes outside the transaction.",
    promptSnippet: "Complete a GSD slice (DB write + summary/UAT render + roadmap checkbox toggle)",
    promptGuidelines: [
      "Use gsd_slice_complete (or gsd_complete_slice) when all tasks in a slice are finished and the slice needs to be recorded.",
      "All tasks in the slice must have status 'complete' \u2014 the handler validates this before proceeding.",
      "On success, returns summaryPath and uatPath where the files were written.",
      "Idempotent \u2014 calling with the same params twice will not crash."
    ],
    parameters: Type.Object({
      // ── Core identification + content (required) ──────────────────────
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceTitle: Type.String({ description: "Title of the slice" }),
      oneLiner: Type.String({ description: "One-line summary of what the slice accomplished" }),
      narrative: Type.String({ description: "Detailed narrative of what happened across all tasks" }),
      verification: Type.String({ description: "What was verified across all tasks" }),
      uatContent: Type.String({ description: "UAT test content (markdown body)" }),
      // ── Enrichment metadata (optional — defaults to empty) ────────────
      deviations: Type.Optional(Type.String({ description: "Deviations from the slice plan, or 'None.'" })),
      knownLimitations: Type.Optional(Type.String({ description: "Known limitations or gaps, or 'None.'" })),
      followUps: Type.Optional(Type.String({ description: "Follow-up work discovered during execution, or 'None.'" })),
      keyFiles: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Key files created or modified" })),
      keyDecisions: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Key decisions made during this slice" })),
      patternsEstablished: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Patterns established by this slice" })),
      observabilitySurfaces: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Observability surfaces added" })),
      provides: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "What this slice provides to downstream slices" })),
      requirementsSurfaced: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "New requirements surfaced" })),
      drillDownPaths: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Paths to task summaries for drill-down" })),
      affects: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Downstream slices affected" })),
      requirementsAdvanced: Type.Optional(Type.Array(
        Type.Union([
          Type.Object({
            id: Type.String({ description: "Requirement ID" }),
            how: Type.String({ description: "How it was advanced" })
          }),
          Type.String({ description: "Fallback: 'ID \u2014 how' string" })
        ]),
        { description: "Requirements advanced by this slice" }
      )),
      requirementsValidated: Type.Optional(Type.Array(
        Type.Union([
          Type.Object({
            id: Type.String({ description: "Requirement ID" }),
            proof: Type.String({ description: "What proof validates it" })
          }),
          Type.String({ description: "Fallback: 'ID \u2014 proof' string" })
        ]),
        { description: "Requirements validated by this slice" }
      )),
      requirementsInvalidated: Type.Optional(Type.Array(
        Type.Union([
          Type.Object({
            id: Type.String({ description: "Requirement ID" }),
            what: Type.String({ description: "What changed" })
          }),
          Type.String({ description: "Fallback: 'ID \u2014 what' string" })
        ]),
        { description: "Requirements invalidated or re-scoped" }
      )),
      filesModified: Type.Optional(Type.Array(
        Type.Union([
          Type.Object({
            path: Type.String({ description: "File path" }),
            description: Type.String({ description: "What changed" })
          }),
          Type.String({ description: "Fallback: file path string" })
        ]),
        { description: "Files modified with descriptions" }
      )),
      requires: Type.Optional(Type.Array(
        Type.Union([
          Type.Object({
            slice: Type.String({ description: "Dependency slice ID" }),
            provides: Type.String({ description: "What was consumed from it" })
          }),
          Type.String({ description: "Fallback: slice ID string" })
        ]),
        { description: "Upstream slice dependencies consumed" }
      )),
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'all tasks verified')" }))
    }),
    execute: sliceCompleteExecute
  };
  pi.registerTool(sliceCompleteTool);
  registerAlias(pi, sliceCompleteTool, "gsd_complete_slice", "gsd_slice_complete");
  const skipSliceExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const basePath = resolveCtxCwd(_ctx);
    const dbAvailable = await ensureDbOpen(basePath);
    if (!dbAvailable) {
      return {
        content: [{ type: "text", text: "Error: GSD database is not available. Cannot skip slice." }],
        details: { operation: "skip_slice", error: "db_unavailable" }
      };
    }
    try {
      const { handleSkipSlice } = await import("../tools/skip-slice.js");
      const { invalidateStateCache } = await import("../state.js");
      const result = handleSkipSlice({
        milestoneId: params.milestoneId,
        sliceId: params.sliceId,
        reason: params.reason
      });
      if (result.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          details: {
            operation: "skip_slice",
            error: result.error,
            errorCode: result.errorCode ?? "skip_failed"
          }
        };
      }
      invalidateStateCache();
      try {
        const { rebuildState } = await import("../doctor.js");
        await rebuildState(basePath);
      } catch (err) {
        logError("tool", `skip_slice rebuildState failed: ${err.message}`, { tool: "gsd_skip_slice" });
      }
      const suffix = result.wasAlreadySkipped ? result.tasksSkipped > 0 ? ` (already skipped; cascaded ${result.tasksSkipped} leftover task(s) to skipped).` : " (already skipped; no pending tasks to cascade)." : ` Cascaded ${result.tasksSkipped} task(s) to skipped. Auto-mode will advance past this slice.`;
      return {
        content: [{ type: "text", text: `Skipped slice ${params.sliceId} (${params.milestoneId}). Reason: ${params.reason ?? "User-directed skip"}.${suffix}` }],
        details: {
          operation: "skip_slice",
          sliceId: params.sliceId,
          milestoneId: params.milestoneId,
          reason: params.reason,
          tasksSkipped: result.tasksSkipped,
          wasAlreadySkipped: result.wasAlreadySkipped
        }
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `skip_slice tool failed: ${msg}`, { tool: "gsd_skip_slice", error: String(err) });
      return {
        content: [{ type: "text", text: `Error skipping slice: ${msg}` }],
        details: { operation: "skip_slice", error: msg }
      };
    }
  };
  pi.registerTool({
    name: "gsd_skip_slice",
    label: "Skip Slice",
    description: "Mark a slice as skipped so auto-mode advances past it without executing. Non-closed tasks within the slice are cascaded to skipped so milestone completion is not blocked by leftover pending tasks (#4375). The slice data is preserved for reference. The state machine treats skipped slices like completed ones for dependency satisfaction.",
    promptSnippet: "Skip a GSD slice (mark as skipped, auto-mode will advance past it)",
    promptGuidelines: [
      "Use gsd_skip_slice when a slice should be bypassed \u2014 descoped, superseded, or no longer relevant.",
      "Cannot skip a slice that is already complete.",
      "Skipped slices satisfy downstream dependencies just like completed slices.",
      "All pending/active tasks in the slice are cascaded to skipped; completed tasks are never downgraded."
    ],
    parameters: Type.Object({
      sliceId: Type.String({ description: "Slice ID (e.g. S02)" }),
      milestoneId: Type.String({ description: "Milestone ID (e.g. M003)" }),
      reason: Type.Optional(Type.String({ description: "Reason for skipping this slice" }))
    }),
    execute: skipSliceExecute
  });
  const milestoneCompleteExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const { executeCompleteMilestone } = await loadWorkflowExecutors();
    return executeCompleteMilestone(params, resolveCtxCwd(_ctx));
  };
  const milestoneCompleteTool = {
    name: "gsd_complete_milestone",
    label: "Complete Milestone",
    description: "Record a completed milestone to the GSD database, render MILESTONE-SUMMARY.md to disk \u2014 all in one atomic operation. Validates all slices are complete before proceeding.",
    promptSnippet: "Complete a GSD milestone (DB write + summary render)",
    promptGuidelines: [
      "Use gsd_complete_milestone when all slices in a milestone are finished and the milestone needs to be recorded.",
      "All slices in the milestone must have status 'complete' \u2014 the handler validates this before proceeding.",
      "verificationPassed must be explicitly set to true \u2014 the handler rejects completion if verification did not pass.",
      "On success, returns summaryPath where the MILESTONE-SUMMARY.md was written."
    ],
    parameters: Type.Object({
      // ── Core identification + content (required) ──────────────────────
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      title: Type.String({ description: "Milestone title" }),
      oneLiner: Type.String({ description: "One-sentence summary of what the milestone achieved" }),
      narrative: Type.String({ description: "Detailed narrative of what happened during the milestone" }),
      verificationPassed: Type.Boolean({ description: "Must be true \u2014 confirms that code change verification, success criteria, and definition of done checks all passed before completion" }),
      // ── Enrichment metadata (optional — defaults to empty) ────────────
      successCriteriaResults: Type.Optional(Type.String({ description: "Markdown detailing how each success criterion was met or not met" })),
      definitionOfDoneResults: Type.Optional(Type.String({ description: "Markdown detailing how each definition-of-done item was met" })),
      requirementOutcomes: Type.Optional(Type.String({ description: "Markdown detailing requirement status transitions with evidence" })),
      keyDecisions: Type.Optional(Type.Array(Type.String(), { description: "Key architectural/pattern decisions made during the milestone" })),
      keyFiles: Type.Optional(Type.Array(Type.String(), { description: "Key files created or modified during the milestone" })),
      lessonsLearned: Type.Optional(Type.Array(Type.String(), { description: "Lessons learned during the milestone" })),
      followUps: Type.Optional(Type.String({ description: "Follow-up items for future milestones" })),
      deviations: Type.Optional(Type.String({ description: "Deviations from the original plan" })),
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'milestone validation passed')" }))
    }),
    execute: milestoneCompleteExecute
  };
  pi.registerTool(milestoneCompleteTool);
  registerAlias(pi, milestoneCompleteTool, "gsd_milestone_complete", "gsd_complete_milestone");
  const milestoneValidateExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const { executeValidateMilestone } = await loadWorkflowExecutors();
    return executeValidateMilestone(params, resolveCtxCwd(_ctx));
  };
  const milestoneValidateTool = {
    name: "gsd_validate_milestone",
    label: "Validate Milestone",
    description: "Validate a milestone before completion \u2014 persist validation results to the DB, render VALIDATION.md to disk. Records verdict (pass/needs-attention/needs-remediation) and rationale.",
    promptSnippet: "Validate a GSD milestone (DB write + VALIDATION.md render)",
    promptGuidelines: [
      "Use gsd_validate_milestone when all slices are done and the milestone needs validation before completion.",
      "Parameters: milestoneId, verdict, remediationRound, successCriteriaChecklist, sliceDeliveryAudit, crossSliceIntegration, requirementCoverage, verificationClasses (optional), verdictRationale, remediationPlan (optional).",
      "If verdict is 'needs-remediation', also provide remediationPlan and use gsd_reassess_roadmap to add remediation slices to the roadmap.",
      "On success, returns validationPath where VALIDATION.md was written."
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      verdict: StringEnum(["pass", "needs-attention", "needs-remediation"], { description: "Validation verdict" }),
      remediationRound: Type.Number({ description: "Remediation round (0 for first validation)" }),
      successCriteriaChecklist: Type.String({ description: "Markdown checklist of success criteria with pass/fail and evidence" }),
      sliceDeliveryAudit: Type.String({ description: "Markdown table auditing each slice's claimed vs delivered output" }),
      crossSliceIntegration: Type.String({ description: "Markdown describing any cross-slice boundary mismatches" }),
      requirementCoverage: Type.String({ description: "Markdown describing any unaddressed requirements" }),
      verificationClasses: Type.Optional(Type.String({ description: "Markdown describing verification class compliance and gaps" })),
      verdictRationale: Type.String({ description: "Why this verdict was chosen" }),
      remediationPlan: Type.Optional(Type.String({ description: "Remediation plan (required if verdict is needs-remediation)" }))
    }),
    execute: milestoneValidateExecute
  };
  pi.registerTool(milestoneValidateTool);
  registerAlias(pi, milestoneValidateTool, "gsd_milestone_validate", "gsd_validate_milestone");
  const replanSliceExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const { executeReplanSlice } = await loadWorkflowExecutors();
    return executeReplanSlice(params, resolveCtxCwd(_ctx));
  };
  const replanSliceTool = {
    name: "gsd_replan_slice",
    label: "Replan Slice",
    description: "Replan a slice after a blocker is discovered. Structurally enforces preservation of completed tasks \u2014 mutations to completed task IDs are rejected with actionable error payloads. Writes replan history to DB, applies task mutations, re-renders PLAN.md, and renders REPLAN.md.",
    promptSnippet: "Replan a GSD slice with structural enforcement of completed tasks",
    promptGuidelines: [
      "Use gsd_replan_slice (canonical) or gsd_slice_replan (alias) when a blocker is discovered and the slice plan needs rewriting.",
      "The tool structurally enforces that completed tasks cannot be updated or removed \u2014 violations return specific error payloads naming the blocked task ID.",
      "Parameters: milestoneId, sliceId, blockerTaskId, blockerDescription, whatChanged, updatedTasks (array), removedTaskIds (array).",
      "updatedTasks items: taskId, title, description, estimate, files, verify, inputs, expectedOutput."
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      blockerTaskId: Type.String({ description: "Task ID that discovered the blocker" }),
      blockerDescription: Type.String({ description: "Description of the blocker" }),
      whatChanged: Type.String({ description: "Summary of what changed in the plan" }),
      updatedTasks: Type.Array(
        Type.Object({
          taskId: Type.String({ description: "Task ID (e.g. T01)" }),
          title: Type.String({ description: "Task title" }),
          description: Type.String({ description: "Task description / steps block" }),
          estimate: Type.String({ description: "Task estimate string" }),
          files: Type.Array(Type.String(), { description: "Files likely touched" }),
          verify: Type.String({ description: "Verification command or block" }),
          inputs: Type.Array(Type.String(), { description: "Input files or references" }),
          expectedOutput: Type.Array(Type.String(), { description: "Expected output files or artifacts" })
        }),
        { description: "Tasks to upsert (update existing or insert new)" }
      ),
      removedTaskIds: Type.Array(Type.String(), { description: "Task IDs to remove from the slice" }),
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'blocker discovered during execution')" }))
    }),
    execute: replanSliceExecute
  };
  pi.registerTool(replanSliceTool);
  registerAlias(pi, replanSliceTool, "gsd_slice_replan", "gsd_replan_slice");
  const reassessRoadmapExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const { executeReassessRoadmap } = await loadWorkflowExecutors();
    return executeReassessRoadmap(params, resolveCtxCwd(_ctx));
  };
  const reassessRoadmapTool = {
    name: "gsd_reassess_roadmap",
    label: "Reassess Roadmap",
    description: "Reassess the milestone roadmap after a slice completes. Structurally enforces preservation of completed slices \u2014 mutations to completed slice IDs are rejected with actionable error payloads. Writes assessment to DB, applies slice mutations, re-renders ROADMAP.md, and renders ASSESSMENT.md.",
    promptSnippet: "Reassess a GSD roadmap with structural enforcement of completed slices",
    promptGuidelines: [
      "Use gsd_reassess_roadmap (canonical) or gsd_roadmap_reassess (alias) after a slice completes to reassess the roadmap.",
      "The tool structurally enforces that completed slices cannot be modified or removed \u2014 violations return specific error payloads naming the blocked slice ID.",
      "Parameters: milestoneId, completedSliceId, verdict, assessment, sliceChanges (object with modified, added, removed arrays).",
      "sliceChanges.modified items: sliceId, title, risk (optional), depends (optional), demo (optional)."
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      completedSliceId: Type.String({ description: "Slice ID that just completed" }),
      verdict: Type.String({ description: "Assessment verdict (e.g. 'roadmap-confirmed', 'roadmap-adjusted')" }),
      assessment: Type.String({ description: "Assessment text explaining the decision" }),
      sliceChanges: Type.Object({
        modified: Type.Array(
          Type.Object({
            sliceId: Type.String({ description: "Slice ID to modify" }),
            title: Type.String({ description: "Updated slice title" }),
            risk: Type.Optional(Type.String({ description: "Updated risk level" })),
            depends: Type.Optional(Type.Array(Type.String(), { description: "Updated dependencies" })),
            demo: Type.Optional(Type.String({ description: "Updated demo text" }))
          }),
          { description: "Slices to modify" }
        ),
        added: Type.Array(
          Type.Object({
            sliceId: Type.String({ description: "New slice ID" }),
            title: Type.String({ description: "New slice title" }),
            risk: Type.Optional(Type.String({ description: "Risk level" })),
            depends: Type.Optional(Type.Array(Type.String(), { description: "Dependencies" })),
            demo: Type.Optional(Type.String({ description: "Demo text" }))
          }),
          { description: "New slices to add" }
        ),
        removed: Type.Array(Type.String(), { description: "Slice IDs to remove" })
      }, { description: "Slice changes to apply" }),
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'slice S01 completed, reassessing remaining roadmap')" }))
    }),
    execute: reassessRoadmapExecute
  };
  pi.registerTool(reassessRoadmapTool);
  registerAlias(pi, reassessRoadmapTool, "gsd_roadmap_reassess", "gsd_reassess_roadmap");
  const reopenTaskExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const basePath = resolveCtxCwd(_ctx);
    const dbAvailable = await ensureDbOpen(basePath);
    if (!dbAvailable) {
      return {
        content: [{ type: "text", text: "Error: GSD database is not available. Cannot reopen task." }],
        details: { operation: "reopen_task", error: "db_unavailable" }
      };
    }
    try {
      const { handleReopenTask } = await import("../tools/reopen-task.js");
      const result = await handleReopenTask(params, basePath);
      if ("error" in result) {
        return {
          content: [{ type: "text", text: `Error reopening task: ${result.error}` }],
          details: { operation: "reopen_task", error: result.error }
        };
      }
      return {
        content: [{ type: "text", text: `Reopened task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }],
        details: {
          operation: "reopen_task",
          milestoneId: result.milestoneId,
          sliceId: result.sliceId,
          taskId: result.taskId
        }
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `reopen_task tool failed: ${msg}`, { tool: "gsd_task_reopen", error: String(err) });
      return {
        content: [{ type: "text", text: `Error reopening task: ${msg}` }],
        details: { operation: "reopen_task", error: msg }
      };
    }
  };
  const reopenTaskTool = {
    name: "gsd_task_reopen",
    label: "Reopen Task",
    description: "Reset a completed task back to 'pending' so it can be re-done. Cleans up SUMMARY.md so the DB-filesystem reconciler does not auto-correct the task back to complete. Both the parent slice and milestone must still be open \u2014 use gsd_slice_reopen first if the slice has been closed.",
    promptSnippet: "Reopen a completed GSD task (resets status to pending, removes SUMMARY.md)",
    promptGuidelines: [
      "Use gsd_task_reopen when a completed task needs to be re-done (e.g. verification missed a regression, requirements changed).",
      "Will fail if the parent slice or milestone is already closed \u2014 reopen those first.",
      "Will fail if the task is not currently 'complete' \u2014 there is nothing to reopen.",
      "Use the canonical name gsd_task_reopen; gsd_reopen_task is only an alias."
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      taskId: Type.String({ description: "Task ID (e.g. T01)" }),
      reason: Type.Optional(Type.String({ description: "Why the task is being reopened (recorded in the audit trail)" })),
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'regression discovered post-completion')" }))
    }),
    execute: reopenTaskExecute
  };
  pi.registerTool(reopenTaskTool);
  registerAlias(pi, reopenTaskTool, "gsd_reopen_task", "gsd_task_reopen");
  const reopenSliceExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const basePath = resolveCtxCwd(_ctx);
    const dbAvailable = await ensureDbOpen(basePath);
    if (!dbAvailable) {
      return {
        content: [{ type: "text", text: "Error: GSD database is not available. Cannot reopen slice." }],
        details: { operation: "reopen_slice", error: "db_unavailable" }
      };
    }
    try {
      const { handleReopenSlice } = await import("../tools/reopen-slice.js");
      const result = await handleReopenSlice(params, basePath);
      if ("error" in result) {
        return {
          content: [{ type: "text", text: `Error reopening slice: ${result.error}` }],
          details: { operation: "reopen_slice", error: result.error }
        };
      }
      return {
        content: [{ type: "text", text: `Reopened slice ${result.sliceId} (${result.milestoneId}); reset ${result.tasksReset} task(s) to pending.` }],
        details: {
          operation: "reopen_slice",
          milestoneId: result.milestoneId,
          sliceId: result.sliceId,
          tasksReset: result.tasksReset
        }
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `reopen_slice tool failed: ${msg}`, { tool: "gsd_slice_reopen", error: String(err) });
      return {
        content: [{ type: "text", text: `Error reopening slice: ${msg}` }],
        details: { operation: "reopen_slice", error: msg }
      };
    }
  };
  const reopenSliceTool = {
    name: "gsd_slice_reopen",
    label: "Reopen Slice",
    description: "Reset a completed slice back to 'in_progress' and reset ALL of its tasks back to 'pending'. Cleans up SUMMARY.md / UAT.md and per-task summaries. Reopening a slice means re-doing the work \u2014 partial resets create ambiguous state, so all tasks are reset.",
    promptSnippet: "Reopen a completed GSD slice (resets all tasks to pending, removes summaries)",
    promptGuidelines: [
      "Use gsd_slice_reopen when a completed slice needs to be re-done (e.g. integration issue surfaced, requirements changed).",
      "All tasks within the slice are reset to 'pending' \u2014 there is no partial-reopen.",
      "Will fail if the parent milestone is already closed \u2014 reopen the milestone first.",
      "Will fail if the slice is not currently 'complete' \u2014 there is nothing to reopen.",
      "Use the canonical name gsd_slice_reopen; gsd_reopen_slice is only an alias."
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      reason: Type.Optional(Type.String({ description: "Why the slice is being reopened (recorded in the audit trail)" })),
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'cross-slice regression discovered')" }))
    }),
    execute: reopenSliceExecute
  };
  pi.registerTool(reopenSliceTool);
  registerAlias(pi, reopenSliceTool, "gsd_reopen_slice", "gsd_slice_reopen");
  const reopenMilestoneExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const basePath = resolveCtxCwd(_ctx);
    const dbAvailable = await ensureDbOpen(basePath);
    if (!dbAvailable) {
      return {
        content: [{ type: "text", text: "Error: GSD database is not available. Cannot reopen milestone." }],
        details: { operation: "reopen_milestone", error: "db_unavailable" }
      };
    }
    try {
      const { handleReopenMilestone } = await import("../tools/reopen-milestone.js");
      const result = await handleReopenMilestone(params, basePath);
      if ("error" in result) {
        return {
          content: [{ type: "text", text: `Error reopening milestone: ${result.error}` }],
          details: { operation: "reopen_milestone", error: result.error }
        };
      }
      return {
        content: [{ type: "text", text: `Reopened milestone ${result.milestoneId}; reset ${result.slicesReset} slice(s) and ${result.tasksReset} task(s).` }],
        details: {
          operation: "reopen_milestone",
          milestoneId: result.milestoneId,
          slicesReset: result.slicesReset,
          tasksReset: result.tasksReset
        }
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("tool", `reopen_milestone tool failed: ${msg}`, { tool: "gsd_milestone_reopen", error: String(err) });
      return {
        content: [{ type: "text", text: `Error reopening milestone: ${msg}` }],
        details: { operation: "reopen_milestone", error: msg }
      };
    }
  };
  const reopenMilestoneTool = {
    name: "gsd_milestone_reopen",
    label: "Reopen Milestone",
    description: "Reset a closed milestone back to 'active', all of its slices to 'in_progress', and all tasks to 'pending'. Cleans up MILESTONE-SUMMARY.md, slice summaries, and task summaries so the DB-filesystem reconciler does not auto-correct status back to complete.",
    promptSnippet: "Reopen a closed GSD milestone (resets slices and tasks, removes summaries)",
    promptGuidelines: [
      "Use gsd_milestone_reopen when a closed milestone needs to be re-done (e.g. validation failure surfaced after closure).",
      "All slices reset to 'in_progress' and all tasks reset to 'pending' \u2014 no partial reopen.",
      "Will fail if the milestone is not currently closed \u2014 there is nothing to reopen.",
      "Use the canonical name gsd_milestone_reopen; gsd_reopen_milestone is only an alias."
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      reason: Type.Optional(Type.String({ description: "Why the milestone is being reopened (recorded in the audit trail)" })),
      // Single-writer v3 audit trail (Stream 2): caller-provided actor identity + causation.
      actorName: Type.Optional(Type.String({ description: "Caller-provided actor identity for the audit trail (e.g. 'executor-01', 'gsd-orchestrator')" })),
      triggerReason: Type.Optional(Type.String({ description: "Caller-provided reason this action was triggered (e.g. 'post-closure validation failure')" }))
    }),
    execute: reopenMilestoneExecute
  };
  pi.registerTool(reopenMilestoneTool);
  registerAlias(pi, reopenMilestoneTool, "gsd_reopen_milestone", "gsd_milestone_reopen");
  const saveGateResultExecute = async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const { executeSaveGateResult } = await loadWorkflowExecutors();
    return executeSaveGateResult(params, resolveCtxCwd(_ctx));
  };
  const saveGateResultTool = {
    name: "gsd_save_gate_result",
    label: "Save Gate Result",
    description: "Save the result of a quality gate evaluation (Q3-Q8 or MV01-MV04) to the GSD database. Called by gate evaluation sub-agents after analyzing a specific quality question.",
    promptSnippet: "Save quality gate evaluation result (verdict, rationale, findings)",
    promptGuidelines: [
      "Use gsd_save_gate_result after evaluating a quality gate question.",
      "gateId must be one of: Q3, Q4, Q5, Q6, Q7, Q8, MV01, MV02, MV03, MV04.",
      "verdict must be: pass (no concerns), flag (concerns found), or omitted (not applicable).",
      "rationale should be a one-sentence justification for the verdict.",
      "findings should contain detailed markdown analysis (or empty string if omitted)."
    ],
    parameters: Type.Object({
      milestoneId: Type.String({ description: "Milestone ID (e.g. M001)" }),
      sliceId: Type.String({ description: "Slice ID (e.g. S01)" }),
      gateId: Type.String({ description: "Gate ID: Q3, Q4, Q5, Q6, Q7, Q8, MV01, MV02, MV03, or MV04" }),
      taskId: Type.Optional(Type.String({ description: "Task ID for task-scoped gates (Q5/Q6/Q7)" })),
      verdict: Type.String({ description: "pass, flag, or omitted" }),
      rationale: Type.String({ description: "One-sentence justification" }),
      findings: Type.Optional(Type.String({ description: "Detailed markdown findings" }))
    }),
    execute: saveGateResultExecute,
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("save_gate_result "));
      text += theme.fg("accent", args.gateId ?? "");
      text += theme.fg("dim", ` \u2192 ${args.verdict ?? ""}`);
      return new Text(text, 0, 0);
    },
    /**
     * Render the save_gate_result tool output for the TUI.
     *
     * Prefers structured fields, but falls back to `content[0].text` when the
     * structured payload is empty. Defensive: the structural fix on this
     * branch plumbs `details` through MCP via `structuredContent`, but older
     * hosts, a future handler that forgets `structuredContent`, or any drop
     * of non-standard return fields would otherwise render as
     * "undefined: undefined". Same fallback applies to error rendering, and
     * we strip a leading `Error:` from the fallback text to avoid producing
     * `Error: Error: ...`.
     */
    renderResult(result, _options, theme) {
      const d = readDetails(result);
      if (result.isError || d?.error) {
        const rawMsg = d?.error ?? result.content?.[0]?.text ?? "unknown";
        const msg = rawMsg.replace(/^\s*Error:\s*/i, "");
        return new Text(theme.fg("error", `Error: ${msg}`), 0, 0);
      }
      if (!d?.gateId || !d?.verdict) {
        const text = result.content?.[0]?.text ?? "Gate result saved";
        return new Text(theme.fg("success", text), 0, 0);
      }
      const color = d.verdict === "flag" ? "warning" : "success";
      return new Text(theme.fg(color, `${d.gateId}: ${d.verdict}`), 0, 0);
    }
  };
  pi.registerTool(saveGateResultTool);
}
export {
  registerDbTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9ib290c3RyYXAvZGItdG9vbHMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBSZWdpc3RlcnMgREItYmFja2VkIEdTRCB3b3JrZmxvdyB0b29scyBhbmQgY29tcGF0aWJpbGl0eSBhbGlhc2VzLlxuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFRleHQgfSBmcm9tIFwiQGdzZC9waS10dWlcIjtcblxuaW1wb3J0IHsgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzIH0gZnJvbSBcIi4uL3ByZWZlcmVuY2VzLmpzXCI7XG5pbXBvcnQgeyBlbnN1cmVEYk9wZW4sIHJlc29sdmVDdHhDd2QgfSBmcm9tIFwiLi9keW5hbWljLXRvb2xzLmpzXCI7XG5pbXBvcnQgeyBsb2FkV3JpdGVHYXRlU25hcHNob3QsIHNob3VsZEJsb2NrUm9vdEFydGlmYWN0U2F2ZUluU25hcHNob3QgfSBmcm9tIFwiLi93cml0ZS1nYXRlLmpzXCI7XG5pbXBvcnQgeyBTdHJpbmdFbnVtIH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB7IGxvZ0Vycm9yIH0gZnJvbSBcIi4uL3dvcmtmbG93LWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgZ2V0RXJyb3JNZXNzYWdlIH0gZnJvbSBcIi4uL2Vycm9yLXV0aWxzLmpzXCI7XG5pbXBvcnQgeyBpbmNyZW1lbnRMZWdhY3lUZWxlbWV0cnkgfSBmcm9tIFwiLi4vbGVnYWN5LXRlbGVtZXRyeS5qc1wiO1xuXG5hc3luYyBmdW5jdGlvbiBsb2FkV29ya2Zsb3dFeGVjdXRvcnMoKTogUHJvbWlzZTx0eXBlb2YgaW1wb3J0KFwiLi4vdG9vbHMvd29ya2Zsb3ctdG9vbC1leGVjdXRvcnMuanNcIik+IHtcbiAgcmV0dXJuIGltcG9ydChcIi4uL3Rvb2xzL3dvcmtmbG93LXRvb2wtZXhlY3V0b3JzLmpzXCIpO1xufVxuXG5cbi8qKlxuICogUmVnaXN0ZXIgYW4gYWxpYXMgdG9vbCB0aGF0IHNoYXJlcyB0aGUgc2FtZSBleGVjdXRlIGZ1bmN0aW9uIGFzIGl0cyBjYW5vbmljYWwgY291bnRlcnBhcnQuXG4gKiBUaGUgYWxpYXMgZGVzY3JpcHRpb24gYW5kIHByb21wdEd1aWRlbGluZXMgZGlyZWN0IHRoZSBMTE0gdG8gcHJlZmVyIHRoZSBjYW5vbmljYWwgbmFtZS5cbiAqL1xuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1leHBsaWNpdC1hbnkgLS0gdG9vbERlZiBzaGFwZSBtYXRjaGVzIFRvb2xEZWZpbml0aW9uIGJ1dCB0eXBpbmcgaXQgZnVsbHkgcmVxdWlyZXMgZ2VuZXJpY3NcbmZ1bmN0aW9uIHJlZ2lzdGVyQWxpYXMocGk6IEV4dGVuc2lvbkFQSSwgdG9vbERlZjogYW55LCBhbGlhc05hbWU6IHN0cmluZywgY2Fub25pY2FsTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGV4ZWN1dGUgPSB0eXBlb2YgdG9vbERlZi5leGVjdXRlID09PSBcImZ1bmN0aW9uXCJcbiAgICA/IGFzeW5jICguLi5hcmdzOiBhbnlbXSkgPT4ge1xuICAgICAgICBpbmNyZW1lbnRMZWdhY3lUZWxlbWV0cnkoXCJsZWdhY3kubWNwQWxpYXNVc2VkXCIpO1xuICAgICAgICByZXR1cm4gdG9vbERlZi5leGVjdXRlKC4uLmFyZ3MpO1xuICAgICAgfVxuICAgIDogdG9vbERlZi5leGVjdXRlO1xuXG4gIHBpLnJlZ2lzdGVyVG9vbCh7XG4gICAgLi4udG9vbERlZixcbiAgICBuYW1lOiBhbGlhc05hbWUsXG4gICAgZGVzY3JpcHRpb246IHRvb2xEZWYuZGVzY3JpcHRpb24gKyBgIChhbGlhcyBmb3IgJHtjYW5vbmljYWxOYW1lfSBcdTIwMTQgcHJlZmVyIHRoZSBjYW5vbmljYWwgbmFtZSlgLFxuICAgIHByb21wdEd1aWRlbGluZXM6IFtgQWxpYXMgZm9yICR7Y2Fub25pY2FsTmFtZX0gXHUyMDE0IHByZWZlciB0aGUgY2Fub25pY2FsIG5hbWUuYF0sXG4gICAgZXhlY3V0ZSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVtZW50Um9vdFdyaXRlR3VhcmQob3BlcmF0aW9uOiBzdHJpbmcsIGJhc2VQYXRoOiBzdHJpbmcpOiB7IGNvbnRlbnQ6IEFycmF5PHsgdHlwZTogXCJ0ZXh0XCI7IHRleHQ6IHN0cmluZyB9PjsgZGV0YWlsczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47IGlzRXJyb3I6IHRydWUgfSB8IG51bGwge1xuICBjb25zdCBndWFyZCA9IHNob3VsZEJsb2NrUm9vdEFydGlmYWN0U2F2ZUluU25hcHNob3QobG9hZFdyaXRlR2F0ZVNuYXBzaG90KGJhc2VQYXRoKSwgXCJSRVFVSVJFTUVOVFNcIik7XG4gIGlmICghZ3VhcmQuYmxvY2spIHJldHVybiBudWxsO1xuICByZXR1cm4ge1xuICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRXJyb3IgJHtvcGVyYXRpb259IHJlcXVpcmVtZW50OiAke2d1YXJkLnJlYXNvbiA/PyBcInJlcXVpcmVtZW50cyB3cml0ZSBibG9ja2VkXCJ9YCB9XSxcbiAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbiwgZXJyb3I6IFwicm9vdF9hcnRpZmFjdF93cml0ZV9ibG9ja2VkXCIgfSxcbiAgICBpc0Vycm9yOiB0cnVlLFxuICB9O1xufVxuXG4vKipcbiAqIFJlYWQgYSB0b29sIHJlc3VsdCdzIHN0cnVjdHVyZWQgcGF5bG9hZCwgYWNjb21tb2RhdGluZyBNQ1AncyBgZGV0YWlsc2AgXHUyMTkyXG4gKiBgc3RydWN0dXJlZENvbnRlbnRgIHJlbmFtZSAoIzQ0NzIsICM0NDc3KS4gSW4tcHJvY2VzcyBleGVjdXRpb25zIHN0aWxsXG4gKiBkZWxpdmVyIHRoZSBwYXlsb2FkIG9uIGByZXN1bHQuZGV0YWlsc2A7IE1DUC1yb3V0ZWQgZXhlY3V0aW9ucyBkZWxpdmVyIGl0XG4gKiBvbiBgcmVzdWx0LnN0cnVjdHVyZWRDb250ZW50YCAocG9zdCBgYWRhcHRFeGVjdXRvclJlc3VsdGAgdHJhbnNmb3JtKS4gQWxsXG4gKiBgcmVuZGVyUmVzdWx0YCBjYWxsYmFja3MgaW4gdGhpcyBmaWxlIHJvdXRlIHRocm91Z2ggdGhpcyBoZWxwZXIgc28gYSBmdXR1cmVcbiAqIGZpZWxkIHJlbmFtZSBvbmx5IG5lZWRzIHRvIGJlIGFwcGxpZWQgaW4gb25lIHBsYWNlLlxuICovXG4vLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueSAtLSByZXN1bHQgc2hhcGUgdmFyaWVzIGJ5IHRvb2xcbmZ1bmN0aW9uIHJlYWREZXRhaWxzKHJlc3VsdDogYW55KTogYW55IHtcbiAgcmV0dXJuIHJlc3VsdD8uZGV0YWlscyA/PyByZXN1bHQ/LnN0cnVjdHVyZWRDb250ZW50O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJEYlRvb2xzKHBpOiBFeHRlbnNpb25BUEkpOiB2b2lkIHtcbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGdzZF9kZWNpc2lvbl9zYXZlIChmb3JtZXJseSBnc2Rfc2F2ZV9kZWNpc2lvbikgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgY29uc3QgZGVjaXNpb25TYXZlRXhlY3V0ZSA9IGFzeW5jIChfdG9vbENhbGxJZDogc3RyaW5nLCBwYXJhbXM6IGFueSwgX3NpZ25hbDogQWJvcnRTaWduYWwgfCB1bmRlZmluZWQsIF9vblVwZGF0ZTogdW5rbm93biwgX2N0eDogdW5rbm93bikgPT4ge1xuICAgIGNvbnN0IGJhc2VQYXRoID0gcmVzb2x2ZUN0eEN3ZChfY3R4KTtcbiAgICBjb25zdCBkYkF2YWlsYWJsZSA9IGF3YWl0IGVuc3VyZURiT3BlbihiYXNlUGF0aCk7XG4gICAgaWYgKCFkYkF2YWlsYWJsZSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IFwiRXJyb3I6IEdTRCBkYXRhYmFzZSBpcyBub3QgYXZhaWxhYmxlLiBDYW5ub3Qgc2F2ZSBkZWNpc2lvbi5cIiB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwic2F2ZV9kZWNpc2lvblwiLCBlcnJvcjogXCJkYl91bmF2YWlsYWJsZVwiIH0gYXMgYW55LFxuICAgICAgfTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgc2F2ZURlY2lzaW9uVG9EYiB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vZGItd3JpdGVyLmpzXCIpO1xuICAgICAgY29uc3QgeyBpZCB9ID0gYXdhaXQgc2F2ZURlY2lzaW9uVG9EYihcbiAgICAgICAge1xuICAgICAgICAgIHNjb3BlOiBwYXJhbXMuc2NvcGUsXG4gICAgICAgICAgZGVjaXNpb246IHBhcmFtcy5kZWNpc2lvbixcbiAgICAgICAgICBjaG9pY2U6IHBhcmFtcy5jaG9pY2UsXG4gICAgICAgICAgcmF0aW9uYWxlOiBwYXJhbXMucmF0aW9uYWxlLFxuICAgICAgICAgIHJldmlzYWJsZTogcGFyYW1zLnJldmlzYWJsZSxcbiAgICAgICAgICB3aGVuX2NvbnRleHQ6IHBhcmFtcy53aGVuX2NvbnRleHQsXG4gICAgICAgICAgbWFkZV9ieTogcGFyYW1zLm1hZGVfYnksXG4gICAgICAgIH0sXG4gICAgICAgIGJhc2VQYXRoLFxuICAgICAgKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgU2F2ZWQgZGVjaXNpb24gJHtpZH1gIH1dLFxuICAgICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJzYXZlX2RlY2lzaW9uXCIsIGlkIH0gYXMgYW55LFxuICAgICAgfTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgIGxvZ0Vycm9yKFwidG9vbFwiLCBgZ3NkX2RlY2lzaW9uX3NhdmUgdG9vbCBmYWlsZWQ6ICR7bXNnfWAsIHsgdG9vbDogXCJnc2RfZGVjaXNpb25fc2F2ZVwiLCBlcnJvcjogU3RyaW5nKGVycikgfSk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYEVycm9yIHNhdmluZyBkZWNpc2lvbjogJHttc2d9YCB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwic2F2ZV9kZWNpc2lvblwiLCBlcnJvcjogbXNnIH0gYXMgYW55LFxuICAgICAgfTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgZGVjaXNpb25TYXZlVG9vbCA9IHtcbiAgICBuYW1lOiBcImdzZF9kZWNpc2lvbl9zYXZlXCIsXG4gICAgbGFiZWw6IFwiU2F2ZSBEZWNpc2lvblwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJSZWNvcmQgYSBwcm9qZWN0IGRlY2lzaW9uIHRvIHRoZSBHU0QgZGF0YWJhc2UgYW5kIHJlZ2VuZXJhdGUgREVDSVNJT05TLm1kLiBcIiArXG4gICAgICBcIkRlY2lzaW9uIElEcyBhcmUgYXV0by1hc3NpZ25lZCBcdTIwMTQgbmV2ZXIgcHJvdmlkZSBhbiBJRCBtYW51YWxseS5cIixcbiAgICBwcm9tcHRTbmlwcGV0OiBcIlJlY29yZCBhIHByb2plY3QgZGVjaXNpb24gdG8gdGhlIEdTRCBkYXRhYmFzZSAoYXV0by1hc3NpZ25zIElELCByZWdlbmVyYXRlcyBERUNJU0lPTlMubWQpXCIsXG4gICAgcHJvbXB0R3VpZGVsaW5lczogW1xuICAgICAgXCJVc2UgZ3NkX2RlY2lzaW9uX3NhdmUgd2hlbiByZWNvcmRpbmcgYW4gYXJjaGl0ZWN0dXJhbCwgcGF0dGVybiwgbGlicmFyeSwgb3Igb2JzZXJ2YWJpbGl0eSBkZWNpc2lvbi5cIixcbiAgICAgIFwiRGVjaXNpb24gSURzIGFyZSBhdXRvLWFzc2lnbmVkIChEMDAxLCBEMDAyLCAuLi4pIFx1MjAxNCBuZXZlciBndWVzcyBvciBwcm92aWRlIGFuIElELlwiLFxuICAgICAgXCJBbGwgZmllbGRzIGV4Y2VwdCByZXZpc2FibGUsIHdoZW5fY29udGV4dCwgYW5kIG1hZGVfYnkgYXJlIHJlcXVpcmVkLlwiLFxuICAgICAgXCJUaGUgdG9vbCB3cml0ZXMgdG8gdGhlIERCIGFuZCByZWdlbmVyYXRlcyAuZ3NkL0RFQ0lTSU9OUy5tZCBhdXRvbWF0aWNhbGx5LlwiLFxuICAgICAgXCJTZXQgbWFkZV9ieSB0byAnaHVtYW4nIHdoZW4gdGhlIHVzZXIgZXhwbGljaXRseSBkaXJlY3RlZCB0aGUgZGVjaXNpb24sICdhZ2VudCcgd2hlbiB0aGUgTExNIGNob3NlIGF1dG9ub21vdXNseSAoZGVmYXVsdCksIG9yICdjb2xsYWJvcmF0aXZlJyB3aGVuIGl0IHdhcyBkaXNjdXNzZWQgYW5kIGFncmVlZCB0b2dldGhlci5cIixcbiAgICBdLFxuICAgIHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcbiAgICAgIHNjb3BlOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlNjb3BlIG9mIHRoZSBkZWNpc2lvbiAoZS5nLiAnYXJjaGl0ZWN0dXJlJywgJ2xpYnJhcnknLCAnb2JzZXJ2YWJpbGl0eScpXCIgfSksXG4gICAgICBkZWNpc2lvbjogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJXaGF0IGlzIGJlaW5nIGRlY2lkZWRcIiB9KSxcbiAgICAgIGNob2ljZTogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJUaGUgY2hvaWNlIG1hZGVcIiB9KSxcbiAgICAgIHJhdGlvbmFsZTogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJXaHkgdGhpcyBjaG9pY2Ugd2FzIG1hZGVcIiB9KSxcbiAgICAgIHJldmlzYWJsZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIldoZXRoZXIgdGhpcyBjYW4gYmUgcmV2aXNpdGVkIChkZWZhdWx0OiAnWWVzJylcIiB9KSksXG4gICAgICB3aGVuX2NvbnRleHQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJXaGVuL2NvbnRleHQgZm9yIHRoZSBkZWNpc2lvbiAoZS5nLiBtaWxlc3RvbmUgSUQpXCIgfSkpLFxuICAgICAgbWFkZV9ieTogVHlwZS5PcHRpb25hbChUeXBlLlVuaW9uKFtcbiAgICAgICAgVHlwZS5MaXRlcmFsKFwiaHVtYW5cIiksXG4gICAgICAgIFR5cGUuTGl0ZXJhbChcImFnZW50XCIpLFxuICAgICAgICBUeXBlLkxpdGVyYWwoXCJjb2xsYWJvcmF0aXZlXCIpLFxuICAgICAgXSwgeyBkZXNjcmlwdGlvbjogXCJXaG8gbWFkZSB0aGlzIGRlY2lzaW9uOiAnaHVtYW4nICh1c2VyIGRpcmVjdGVkKSwgJ2FnZW50JyAoTExNIGRlY2lkZWQgYXV0b25vbW91c2x5KSwgb3IgJ2NvbGxhYm9yYXRpdmUnIChkaXNjdXNzZWQgYW5kIGFncmVlZCkuIERlZmF1bHQ6ICdhZ2VudCdcIiB9KSksXG4gICAgfSksXG4gICAgZXhlY3V0ZTogZGVjaXNpb25TYXZlRXhlY3V0ZSxcbiAgICByZW5kZXJDYWxsKGFyZ3M6IGFueSwgdGhlbWU6IGFueSkge1xuICAgICAgbGV0IHRleHQgPSB0aGVtZS5mZyhcInRvb2xUaXRsZVwiLCB0aGVtZS5ib2xkKFwiZGVjaXNpb25fc2F2ZSBcIikpO1xuICAgICAgaWYgKGFyZ3Muc2NvcGUpIHRleHQgKz0gdGhlbWUuZmcoXCJhY2NlbnRcIiwgYFske2FyZ3Muc2NvcGV9XSBgKTtcbiAgICAgIGlmIChhcmdzLmRlY2lzaW9uKSB0ZXh0ICs9IHRoZW1lLmZnKFwibXV0ZWRcIiwgYXJncy5kZWNpc2lvbik7XG4gICAgICBpZiAoYXJncy5jaG9pY2UpIHRleHQgKz0gdGhlbWUuZmcoXCJkaW1cIiwgYCBcdTIwMTQgJHthcmdzLmNob2ljZX1gKTtcbiAgICAgIHJldHVybiBuZXcgVGV4dCh0ZXh0LCAwLCAwKTtcbiAgICB9LFxuICAgIHJlbmRlclJlc3VsdChyZXN1bHQ6IGFueSwgX29wdGlvbnM6IGFueSwgdGhlbWU6IGFueSkge1xuICAgICAgY29uc3QgZCA9IHJlYWREZXRhaWxzKHJlc3VsdCk7XG4gICAgICBpZiAocmVzdWx0LmlzRXJyb3IgfHwgZD8uZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIG5ldyBUZXh0KHRoZW1lLmZnKFwiZXJyb3JcIiwgYEVycm9yOiAke2Q/LmVycm9yID8/IFwidW5rbm93blwifWApLCAwLCAwKTtcbiAgICAgIH1cbiAgICAgIGxldCB0ZXh0ID0gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIGBEZWNpc2lvbiAke2Q/LmlkID8/IFwiXCJ9IHNhdmVkYCk7XG4gICAgICBpZiAoZD8uaWQpIHRleHQgKz0gdGhlbWUuZmcoXCJkaW1cIiwgYCBcdTIxOTIgREVDSVNJT05TLm1kYCk7XG4gICAgICByZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7XG4gICAgfSxcbiAgfTtcblxuICBwaS5yZWdpc3RlclRvb2woZGVjaXNpb25TYXZlVG9vbCk7XG4gIHJlZ2lzdGVyQWxpYXMocGksIGRlY2lzaW9uU2F2ZVRvb2wsIFwiZ3NkX3NhdmVfZGVjaXNpb25cIiwgXCJnc2RfZGVjaXNpb25fc2F2ZVwiKTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ3NkX3JlcXVpcmVtZW50X3VwZGF0ZSAoZm9ybWVybHkgZ3NkX3VwZGF0ZV9yZXF1aXJlbWVudCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgY29uc3QgcmVxdWlyZW1lbnRVcGRhdGVFeGVjdXRlID0gYXN5bmMgKF90b29sQ2FsbElkOiBzdHJpbmcsIHBhcmFtczogYW55LCBfc2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCwgX29uVXBkYXRlOiB1bmtub3duLCBfY3R4OiB1bmtub3duKSA9PiB7XG4gICAgY29uc3QgYmFzZVBhdGggPSByZXNvbHZlQ3R4Q3dkKF9jdHgpO1xuICAgIGNvbnN0IGdhdGVCbG9jayA9IHJlcXVpcmVtZW50Um9vdFdyaXRlR3VhcmQoXCJ1cGRhdGVfcmVxdWlyZW1lbnRcIiwgYmFzZVBhdGgpO1xuICAgIGlmIChnYXRlQmxvY2spIHJldHVybiBnYXRlQmxvY2s7XG4gICAgY29uc3QgZGJBdmFpbGFibGUgPSBhd2FpdCBlbnN1cmVEYk9wZW4oYmFzZVBhdGgpO1xuICAgIGlmICghZGJBdmFpbGFibGUpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBcIkVycm9yOiBHU0QgZGF0YWJhc2UgaXMgbm90IGF2YWlsYWJsZS4gQ2Fubm90IHVwZGF0ZSByZXF1aXJlbWVudC5cIiB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwidXBkYXRlX3JlcXVpcmVtZW50XCIsIGlkOiBwYXJhbXMuaWQsIGVycm9yOiBcImRiX3VuYXZhaWxhYmxlXCIgfSBhcyBhbnksXG4gICAgICB9O1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgY29uc3QgeyB1cGRhdGVSZXF1aXJlbWVudEluRGIgfSA9IGF3YWl0IGltcG9ydChcIi4uL2RiLXdyaXRlci5qc1wiKTtcbiAgICAgIGNvbnN0IHVwZGF0ZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4gPSB7fTtcbiAgICAgIGlmIChwYXJhbXMuc3RhdHVzICE9PSB1bmRlZmluZWQpIHVwZGF0ZXMuc3RhdHVzID0gcGFyYW1zLnN0YXR1cztcbiAgICAgIGlmIChwYXJhbXMudmFsaWRhdGlvbiAhPT0gdW5kZWZpbmVkKSB1cGRhdGVzLnZhbGlkYXRpb24gPSBwYXJhbXMudmFsaWRhdGlvbjtcbiAgICAgIGlmIChwYXJhbXMubm90ZXMgIT09IHVuZGVmaW5lZCkgdXBkYXRlcy5ub3RlcyA9IHBhcmFtcy5ub3RlcztcbiAgICAgIGlmIChwYXJhbXMuZGVzY3JpcHRpb24gIT09IHVuZGVmaW5lZCkgdXBkYXRlcy5kZXNjcmlwdGlvbiA9IHBhcmFtcy5kZXNjcmlwdGlvbjtcbiAgICAgIGlmIChwYXJhbXMucHJpbWFyeV9vd25lciAhPT0gdW5kZWZpbmVkKSB1cGRhdGVzLnByaW1hcnlfb3duZXIgPSBwYXJhbXMucHJpbWFyeV9vd25lcjtcbiAgICAgIGlmIChwYXJhbXMuc3VwcG9ydGluZ19zbGljZXMgIT09IHVuZGVmaW5lZCkgdXBkYXRlcy5zdXBwb3J0aW5nX3NsaWNlcyA9IHBhcmFtcy5zdXBwb3J0aW5nX3NsaWNlcztcbiAgICAgIGF3YWl0IHVwZGF0ZVJlcXVpcmVtZW50SW5EYihwYXJhbXMuaWQsIHVwZGF0ZXMsIGJhc2VQYXRoKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgVXBkYXRlZCByZXF1aXJlbWVudCAke3BhcmFtcy5pZH1gIH1dLFxuICAgICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJ1cGRhdGVfcmVxdWlyZW1lbnRcIiwgaWQ6IHBhcmFtcy5pZCB9IGFzIGFueSxcbiAgICAgIH07XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICBsb2dFcnJvcihcInRvb2xcIiwgYGdzZF9yZXF1aXJlbWVudF91cGRhdGUgdG9vbCBmYWlsZWQ6ICR7bXNnfWAsIHsgdG9vbDogXCJnc2RfcmVxdWlyZW1lbnRfdXBkYXRlXCIsIGVycm9yOiBTdHJpbmcoZXJyKSB9KTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgRXJyb3IgdXBkYXRpbmcgcmVxdWlyZW1lbnQ6ICR7bXNnfWAgfV0sXG4gICAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInVwZGF0ZV9yZXF1aXJlbWVudFwiLCBpZDogcGFyYW1zLmlkLCBlcnJvcjogbXNnIH0gYXMgYW55LFxuICAgICAgfTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgcmVxdWlyZW1lbnRVcGRhdGVUb29sID0ge1xuICAgIG5hbWU6IFwiZ3NkX3JlcXVpcmVtZW50X3VwZGF0ZVwiLFxuICAgIGxhYmVsOiBcIlVwZGF0ZSBSZXF1aXJlbWVudFwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJVcGRhdGUgYW4gZXhpc3RpbmcgcmVxdWlyZW1lbnQgaW4gdGhlIEdTRCBkYXRhYmFzZSBhbmQgcmVnZW5lcmF0ZSBSRVFVSVJFTUVOVFMubWQuIFwiICtcbiAgICAgIFwiUHJvdmlkZSB0aGUgcmVxdWlyZW1lbnQgSUQgKGUuZy4gUjAwMSkgYW5kIGFueSBmaWVsZHMgdG8gdXBkYXRlLlwiLFxuICAgIHByb21wdFNuaXBwZXQ6IFwiVXBkYXRlIGFuIGV4aXN0aW5nIEdTRCByZXF1aXJlbWVudCBieSBJRCAocmVnZW5lcmF0ZXMgUkVRVUlSRU1FTlRTLm1kKVwiLFxuICAgIHByb21wdEd1aWRlbGluZXM6IFtcbiAgICAgIFwiVXNlIGdzZF9yZXF1aXJlbWVudF91cGRhdGUgdG8gY2hhbmdlIHN0YXR1cywgdmFsaWRhdGlvbiwgbm90ZXMsIG9yIG90aGVyIGZpZWxkcyBvbiBhbiBleGlzdGluZyByZXF1aXJlbWVudC5cIixcbiAgICAgIFwiVGhlIGlkIHBhcmFtZXRlciBpcyByZXF1aXJlZCBcdTIwMTQgaXQgbXVzdCBiZSBhbiBleGlzdGluZyBSWFhYIGlkZW50aWZpZXIuXCIsXG4gICAgICBcIkFsbCBvdGhlciBmaWVsZHMgYXJlIG9wdGlvbmFsIFx1MjAxNCBvbmx5IHByb3ZpZGVkIGZpZWxkcyBhcmUgdXBkYXRlZC5cIixcbiAgICAgIFwiVGhlIHRvb2wgdmVyaWZpZXMgdGhlIHJlcXVpcmVtZW50IGV4aXN0cyBiZWZvcmUgdXBkYXRpbmcuXCIsXG4gICAgXSxcbiAgICBwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG4gICAgICBpZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJUaGUgcmVxdWlyZW1lbnQgSUQgKGUuZy4gUjAwMSwgUjAxNClcIiB9KSxcbiAgICAgIHN0YXR1czogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk5ldyBzdGF0dXMgKGUuZy4gJ2FjdGl2ZScsICd2YWxpZGF0ZWQnLCAnZGVmZXJyZWQnKVwiIH0pKSxcbiAgICAgIHZhbGlkYXRpb246IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJWYWxpZGF0aW9uIGNyaXRlcmlhIG9yIHByb29mXCIgfSkpLFxuICAgICAgbm90ZXM6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJBZGRpdGlvbmFsIG5vdGVzXCIgfSkpLFxuICAgICAgZGVzY3JpcHRpb246IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJVcGRhdGVkIGRlc2NyaXB0aW9uXCIgfSkpLFxuICAgICAgcHJpbWFyeV9vd25lcjogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlByaW1hcnkgb3duaW5nIHNsaWNlXCIgfSkpLFxuICAgICAgc3VwcG9ydGluZ19zbGljZXM6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTdXBwb3J0aW5nIHNsaWNlc1wiIH0pKSxcbiAgICB9KSxcbiAgICBleGVjdXRlOiByZXF1aXJlbWVudFVwZGF0ZUV4ZWN1dGUsXG4gICAgcmVuZGVyQ2FsbChhcmdzOiBhbnksIHRoZW1lOiBhbnkpIHtcbiAgICAgIGxldCB0ZXh0ID0gdGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChcInJlcXVpcmVtZW50X3VwZGF0ZSBcIikpO1xuICAgICAgaWYgKGFyZ3MuaWQpIHRleHQgKz0gdGhlbWUuZmcoXCJhY2NlbnRcIiwgYXJncy5pZCk7XG4gICAgICBjb25zdCBmaWVsZHMgPSBbXCJzdGF0dXNcIiwgXCJ2YWxpZGF0aW9uXCIsIFwibm90ZXNcIiwgXCJkZXNjcmlwdGlvblwiXS5maWx0ZXIoKGYpID0+IGFyZ3NbZl0pO1xuICAgICAgaWYgKGZpZWxkcy5sZW5ndGggPiAwKSB0ZXh0ICs9IHRoZW1lLmZnKFwiZGltXCIsIGAgKCR7ZmllbGRzLmpvaW4oXCIsIFwiKX0pYCk7XG4gICAgICByZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7XG4gICAgfSxcbiAgICByZW5kZXJSZXN1bHQocmVzdWx0OiBhbnksIF9vcHRpb25zOiBhbnksIHRoZW1lOiBhbnkpIHtcbiAgICAgIGNvbnN0IGQgPSByZWFkRGV0YWlscyhyZXN1bHQpO1xuICAgICAgaWYgKHJlc3VsdC5pc0Vycm9yIHx8IGQ/LmVycm9yKSB7XG4gICAgICAgIHJldHVybiBuZXcgVGV4dCh0aGVtZS5mZyhcImVycm9yXCIsIGBFcnJvcjogJHtkPy5lcnJvciA/PyBcInVua25vd25cIn1gKSwgMCwgMCk7XG4gICAgICB9XG4gICAgICBsZXQgdGV4dCA9IHRoZW1lLmZnKFwic3VjY2Vzc1wiLCBgUmVxdWlyZW1lbnQgJHtkPy5pZCA/PyBcIlwifSB1cGRhdGVkYCk7XG4gICAgICB0ZXh0ICs9IHRoZW1lLmZnKFwiZGltXCIsIGAgXHUyMTkyIFJFUVVJUkVNRU5UUy5tZGApO1xuICAgICAgcmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuICAgIH0sXG4gIH07XG5cbiAgcGkucmVnaXN0ZXJUb29sKHJlcXVpcmVtZW50VXBkYXRlVG9vbCk7XG4gIHJlZ2lzdGVyQWxpYXMocGksIHJlcXVpcmVtZW50VXBkYXRlVG9vbCwgXCJnc2RfdXBkYXRlX3JlcXVpcmVtZW50XCIsIFwiZ3NkX3JlcXVpcmVtZW50X3VwZGF0ZVwiKTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ3NkX3JlcXVpcmVtZW50X3NhdmUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgY29uc3QgcmVxdWlyZW1lbnRTYXZlRXhlY3V0ZSA9IGFzeW5jIChfdG9vbENhbGxJZDogc3RyaW5nLCBwYXJhbXM6IGFueSwgX3NpZ25hbDogQWJvcnRTaWduYWwgfCB1bmRlZmluZWQsIF9vblVwZGF0ZTogdW5rbm93biwgX2N0eDogdW5rbm93bikgPT4ge1xuICAgIGNvbnN0IGJhc2VQYXRoID0gcmVzb2x2ZUN0eEN3ZChfY3R4KTtcbiAgICBjb25zdCBnYXRlQmxvY2sgPSByZXF1aXJlbWVudFJvb3RXcml0ZUd1YXJkKFwic2F2ZV9yZXF1aXJlbWVudFwiLCBiYXNlUGF0aCk7XG4gICAgaWYgKGdhdGVCbG9jaykgcmV0dXJuIGdhdGVCbG9jaztcbiAgICBjb25zdCBkYkF2YWlsYWJsZSA9IGF3YWl0IGVuc3VyZURiT3BlbihiYXNlUGF0aCk7XG4gICAgaWYgKCFkYkF2YWlsYWJsZSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IFwiRXJyb3I6IEdTRCBkYXRhYmFzZSBpcyBub3QgYXZhaWxhYmxlLiBDYW5ub3Qgc2F2ZSByZXF1aXJlbWVudC5cIiB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwic2F2ZV9yZXF1aXJlbWVudFwiLCBlcnJvcjogXCJkYl91bmF2YWlsYWJsZVwiIH0gYXMgYW55LFxuICAgICAgfTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgc2F2ZVJlcXVpcmVtZW50VG9EYiB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vZGItd3JpdGVyLmpzXCIpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc2F2ZVJlcXVpcmVtZW50VG9EYihcbiAgICAgICAge1xuICAgICAgICAgIGNsYXNzOiBwYXJhbXMuY2xhc3MsXG4gICAgICAgICAgc3RhdHVzOiBwYXJhbXMuc3RhdHVzLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBwYXJhbXMuZGVzY3JpcHRpb24sXG4gICAgICAgICAgd2h5OiBwYXJhbXMud2h5LFxuICAgICAgICAgIHNvdXJjZTogcGFyYW1zLnNvdXJjZSxcbiAgICAgICAgICBwcmltYXJ5X293bmVyOiBwYXJhbXMucHJpbWFyeV9vd25lcixcbiAgICAgICAgICBzdXBwb3J0aW5nX3NsaWNlczogcGFyYW1zLnN1cHBvcnRpbmdfc2xpY2VzLFxuICAgICAgICAgIHZhbGlkYXRpb246IHBhcmFtcy52YWxpZGF0aW9uLFxuICAgICAgICAgIG5vdGVzOiBwYXJhbXMubm90ZXMsXG4gICAgICAgIH0sXG4gICAgICAgIGJhc2VQYXRoLFxuICAgICAgKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgU2F2ZWQgcmVxdWlyZW1lbnQgJHtyZXN1bHQuaWR9YCB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwic2F2ZV9yZXF1aXJlbWVudFwiLCBpZDogcmVzdWx0LmlkIH0gYXMgYW55LFxuICAgICAgfTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgIGxvZ0Vycm9yKFwidG9vbFwiLCBgZ3NkX3JlcXVpcmVtZW50X3NhdmUgdG9vbCBmYWlsZWQ6ICR7bXNnfWAsIHsgdG9vbDogXCJnc2RfcmVxdWlyZW1lbnRfc2F2ZVwiLCBlcnJvcjogU3RyaW5nKGVycikgfSk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYEVycm9yIHNhdmluZyByZXF1aXJlbWVudDogJHttc2d9YCB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwic2F2ZV9yZXF1aXJlbWVudFwiLCBlcnJvcjogbXNnIH0gYXMgYW55LFxuICAgICAgfTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgcmVxdWlyZW1lbnRTYXZlVG9vbCA9IHtcbiAgICBuYW1lOiBcImdzZF9yZXF1aXJlbWVudF9zYXZlXCIsXG4gICAgbGFiZWw6IFwiU2F2ZSBSZXF1aXJlbWVudFwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJSZWNvcmQgYSBuZXcgcmVxdWlyZW1lbnQgdG8gdGhlIEdTRCBkYXRhYmFzZSBhbmQgcmVnZW5lcmF0ZSBSRVFVSVJFTUVOVFMubWQuIFwiICtcbiAgICAgIFwiUmVxdWlyZW1lbnQgSURzIGFyZSBhdXRvLWFzc2lnbmVkIFx1MjAxNCBuZXZlciBwcm92aWRlIGFuIElEIG1hbnVhbGx5LlwiLFxuICAgIHByb21wdFNuaXBwZXQ6IFwiUmVjb3JkIGEgbmV3IEdTRCByZXF1aXJlbWVudCB0byB0aGUgZGF0YWJhc2UgKGF1dG8tYXNzaWducyBJRCwgcmVnZW5lcmF0ZXMgUkVRVUlSRU1FTlRTLm1kKVwiLFxuICAgIHByb21wdEd1aWRlbGluZXM6IFtcbiAgICAgIFwiVXNlIGdzZF9yZXF1aXJlbWVudF9zYXZlIHdoZW4gcmVjb3JkaW5nIGEgbmV3IGNhcGFiaWxpdHksIHF1YWxpdHkgYXR0cmlidXRlLCBjb25zdHJhaW50LCBvciBhbnRpLWZlYXR1cmUgcmVxdWlyZW1lbnQuXCIsXG4gICAgICBcIlVzZSBvbmUgb2YgdGhlc2UgY2xhc3NlczogY29yZS1jYXBhYmlsaXR5LCBwcmltYXJ5LXVzZXItbG9vcCwgbGF1bmNoYWJpbGl0eSwgY29udGludWl0eSwgZmFpbHVyZS12aXNpYmlsaXR5LCBpbnRlZ3JhdGlvbiwgcXVhbGl0eS1hdHRyaWJ1dGUsIG9wZXJhYmlsaXR5LCBhZG1pbi9zdXBwb3J0LCBjb21wbGlhbmNlL3NlY3VyaXR5LCBkaWZmZXJlbnRpYXRvciwgY29uc3RyYWludCwgYW50aS1mZWF0dXJlLlwiLFxuICAgICAgXCJSZXF1aXJlbWVudCBJRHMgYXJlIGF1dG8tYXNzaWduZWQgKFIwMDEsIFIwMDIsIC4uLikgXHUyMDE0IG5ldmVyIGd1ZXNzIG9yIHByb3ZpZGUgYW4gSUQuXCIsXG4gICAgICBcImNsYXNzLCBkZXNjcmlwdGlvbiwgd2h5LCBhbmQgc291cmNlIGFyZSByZXF1aXJlZC4gQWxsIG90aGVyIGZpZWxkcyBhcmUgb3B0aW9uYWwuXCIsXG4gICAgICBcIlRoZSB0b29sIHdyaXRlcyB0byB0aGUgREIgYW5kIHJlZ2VuZXJhdGVzIC5nc2QvUkVRVUlSRU1FTlRTLm1kIGF1dG9tYXRpY2FsbHkuXCIsXG4gICAgXSxcbiAgICBwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG4gICAgICBjbGFzczogU3RyaW5nRW51bShbXG4gICAgICAgIFwiY29yZS1jYXBhYmlsaXR5XCIsXG4gICAgICAgIFwicHJpbWFyeS11c2VyLWxvb3BcIixcbiAgICAgICAgXCJsYXVuY2hhYmlsaXR5XCIsXG4gICAgICAgIFwiY29udGludWl0eVwiLFxuICAgICAgICBcImZhaWx1cmUtdmlzaWJpbGl0eVwiLFxuICAgICAgICBcImludGVncmF0aW9uXCIsXG4gICAgICAgIFwicXVhbGl0eS1hdHRyaWJ1dGVcIixcbiAgICAgICAgXCJvcGVyYWJpbGl0eVwiLFxuICAgICAgICBcImFkbWluL3N1cHBvcnRcIixcbiAgICAgICAgXCJjb21wbGlhbmNlL3NlY3VyaXR5XCIsXG4gICAgICAgIFwiZGlmZmVyZW50aWF0b3JcIixcbiAgICAgICAgXCJjb25zdHJhaW50XCIsXG4gICAgICAgIFwiYW50aS1mZWF0dXJlXCIsXG4gICAgICBdLCB7IGRlc2NyaXB0aW9uOiBcIlJlcXVpcmVtZW50IGNsYXNzXCIgfSksXG4gICAgICBkZXNjcmlwdGlvbjogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTaG9ydCBkZXNjcmlwdGlvbiBvZiB0aGUgcmVxdWlyZW1lbnRcIiB9KSxcbiAgICAgIHdoeTogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJXaHkgdGhpcyByZXF1aXJlbWVudCBtYXR0ZXJzXCIgfSksXG4gICAgICBzb3VyY2U6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiT3JpZ2luIG9mIHRoZSByZXF1aXJlbWVudCAoZS5nLiAndXNlci1yZXNlYXJjaCcsICdkZXNpZ24nLCAnTTAwMScpXCIgfSksXG4gICAgICBzdGF0dXM6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTdGF0dXMgKGRlZmF1bHQ6ICdhY3RpdmUnKVwiIH0pKSxcbiAgICAgIHByaW1hcnlfb3duZXI6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJQcmltYXJ5IG93bmluZyBzbGljZVwiIH0pKSxcbiAgICAgIHN1cHBvcnRpbmdfc2xpY2VzOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiU3VwcG9ydGluZyBzbGljZXNcIiB9KSksXG4gICAgICB2YWxpZGF0aW9uOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVmFsaWRhdGlvbiBjcml0ZXJpYVwiIH0pKSxcbiAgICAgIG5vdGVzOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQWRkaXRpb25hbCBub3Rlc1wiIH0pKSxcbiAgICB9KSxcbiAgICBleGVjdXRlOiByZXF1aXJlbWVudFNhdmVFeGVjdXRlLFxuICAgIHJlbmRlckNhbGwoYXJnczogYW55LCB0aGVtZTogYW55KSB7XG4gICAgICBsZXQgdGV4dCA9IHRoZW1lLmZnKFwidG9vbFRpdGxlXCIsIHRoZW1lLmJvbGQoXCJyZXF1aXJlbWVudF9zYXZlIFwiKSk7XG4gICAgICBpZiAoYXJncy5jbGFzcykgdGV4dCArPSB0aGVtZS5mZyhcImFjY2VudFwiLCBgWyR7YXJncy5jbGFzc31dIGApO1xuICAgICAgaWYgKGFyZ3MuZGVzY3JpcHRpb24pIHRleHQgKz0gdGhlbWUuZmcoXCJtdXRlZFwiLCBhcmdzLmRlc2NyaXB0aW9uKTtcbiAgICAgIHJldHVybiBuZXcgVGV4dCh0ZXh0LCAwLCAwKTtcbiAgICB9LFxuICAgIHJlbmRlclJlc3VsdChyZXN1bHQ6IGFueSwgX29wdGlvbnM6IGFueSwgdGhlbWU6IGFueSkge1xuICAgICAgY29uc3QgZCA9IHJlYWREZXRhaWxzKHJlc3VsdCk7XG4gICAgICBpZiAocmVzdWx0LmlzRXJyb3IgfHwgZD8uZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIG5ldyBUZXh0KHRoZW1lLmZnKFwiZXJyb3JcIiwgYEVycm9yOiAke2Q/LmVycm9yID8/IFwidW5rbm93blwifWApLCAwLCAwKTtcbiAgICAgIH1cbiAgICAgIGxldCB0ZXh0ID0gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIGBSZXF1aXJlbWVudCAke2Q/LmlkID8/IFwiXCJ9IHNhdmVkYCk7XG4gICAgICB0ZXh0ICs9IHRoZW1lLmZnKFwiZGltXCIsIGAgXHUyMTkyIFJFUVVJUkVNRU5UUy5tZGApO1xuICAgICAgcmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuICAgIH0sXG4gIH07XG5cbiAgcGkucmVnaXN0ZXJUb29sKHJlcXVpcmVtZW50U2F2ZVRvb2wpO1xuICByZWdpc3RlckFsaWFzKHBpLCByZXF1aXJlbWVudFNhdmVUb29sLCBcImdzZF9zYXZlX3JlcXVpcmVtZW50XCIsIFwiZ3NkX3JlcXVpcmVtZW50X3NhdmVcIik7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGdzZF9zdW1tYXJ5X3NhdmUgKGZvcm1lcmx5IGdzZF9zYXZlX3N1bW1hcnkpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIGNvbnN0IHN1bW1hcnlTYXZlRXhlY3V0ZSA9IGFzeW5jIChfdG9vbENhbGxJZDogc3RyaW5nLCBwYXJhbXM6IGFueSwgX3NpZ25hbDogQWJvcnRTaWduYWwgfCB1bmRlZmluZWQsIF9vblVwZGF0ZTogdW5rbm93biwgX2N0eDogdW5rbm93bikgPT4ge1xuICAgIGNvbnN0IHsgZXhlY3V0ZVN1bW1hcnlTYXZlIH0gPSBhd2FpdCBsb2FkV29ya2Zsb3dFeGVjdXRvcnMoKTtcbiAgICByZXR1cm4gZXhlY3V0ZVN1bW1hcnlTYXZlKHBhcmFtcywgcmVzb2x2ZUN0eEN3ZChfY3R4KSk7XG4gIH07XG5cbiAgY29uc3Qgc3VtbWFyeVNhdmVUb29sID0ge1xuICAgIG5hbWU6IFwiZ3NkX3N1bW1hcnlfc2F2ZVwiLFxuICAgIGxhYmVsOiBcIlNhdmUgU3VtbWFyeVwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJTYXZlIGEgc3VtbWFyeSwgcmVzZWFyY2gsIGNvbnRleHQsIG9yIGFzc2Vzc21lbnQgYXJ0aWZhY3QgdG8gdGhlIEdTRCBkYXRhYmFzZSBhbmQgd3JpdGUgaXQgdG8gZGlzay4gXCIgK1xuICAgICAgXCJDb21wdXRlcyB0aGUgZmlsZSBwYXRoIGZyb20gbWlsZXN0b25lL3NsaWNlL3Rhc2sgSURzIGF1dG9tYXRpY2FsbHkuXCIsXG4gICAgcHJvbXB0U25pcHBldDogXCJTYXZlIGEgR1NEIGFydGlmYWN0IChzdW1tYXJ5L3Jlc2VhcmNoL2NvbnRleHQvYXNzZXNzbWVudCkgdG8gREIgYW5kIGRpc2tcIixcbiAgICBwcm9tcHRHdWlkZWxpbmVzOiBbXG4gICAgICBcIlVzZSBnc2Rfc3VtbWFyeV9zYXZlIHRvIHBlcnNpc3Qgc3RydWN0dXJlZCBhcnRpZmFjdHMgKFNVTU1BUlksIFJFU0VBUkNILCBDT05URVhULCBBU1NFU1NNRU5ULCBDT05URVhULURSQUZULCBQUk9KRUNULCBQUk9KRUNULURSQUZULCBSRVFVSVJFTUVOVFMsIFJFUVVJUkVNRU5UUy1EUkFGVCkuXCIsXG4gICAgICBcIm1pbGVzdG9uZV9pZCBpcyByZXF1aXJlZCBmb3IgbWlsZXN0b25lL3NsaWNlL3Rhc2sgYXJ0aWZhY3RzLiBPbWl0IG1pbGVzdG9uZV9pZCBvbmx5IGZvciByb290LWxldmVsIFBST0pFQ1QvUFJPSkVDVC1EUkFGVC9SRVFVSVJFTUVOVFMvUkVRVUlSRU1FTlRTLURSQUZULlwiLFxuICAgICAgXCJUaGUgdG9vbCBjb21wdXRlcyB0aGUgcmVsYXRpdmUgcGF0aCBhdXRvbWF0aWNhbGx5OiBtaWxlc3RvbmVzL00wMDEvTTAwMS1TVU1NQVJZLm1kLCBtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS9TMDEtU1VNTUFSWS5tZCwgZXRjLlwiLFxuICAgICAgXCJSb290LWxldmVsIGFydGlmYWN0IHBhdGhzIGFyZSBQUk9KRUNULm1kLCBQUk9KRUNULURSQUZULm1kLCBSRVFVSVJFTUVOVFMubWQsIGFuZCBSRVFVSVJFTUVOVFMtRFJBRlQubWQuXCIsXG4gICAgICBcImFydGlmYWN0X3R5cGUgbXVzdCBiZSBvbmUgb2Y6IFNVTU1BUlksIFJFU0VBUkNILCBDT05URVhULCBBU1NFU1NNRU5ULCBDT05URVhULURSQUZULCBQUk9KRUNULCBQUk9KRUNULURSQUZULCBSRVFVSVJFTUVOVFMsIFJFUVVJUkVNRU5UUy1EUkFGVC5cIixcbiAgICAgIFwiVXNlIENPTlRFWFQtRFJBRlQgZm9yIGluY3JlbWVudGFsIGRyYWZ0IHBlcnNpc3RlbmNlOyB1c2UgQ09OVEVYVCBmb3IgdGhlIGZpbmFsIG1pbGVzdG9uZSBjb250ZXh0IGFmdGVyIGRlcHRoIHZlcmlmaWNhdGlvbi5cIixcbiAgICBdLFxuICAgIHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcbiAgICAgIG1pbGVzdG9uZV9pZDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk1pbGVzdG9uZSBJRCAoZS5nLiBNMDAxKS4gT21pdCBvbmx5IGZvciByb290LWxldmVsIFBST0pFQ1QvUFJPSkVDVC1EUkFGVC9SRVFVSVJFTUVOVFMvUkVRVUlSRU1FTlRTLURSQUZUIGFydGlmYWN0cy5cIiB9KSksXG4gICAgICBzbGljZV9pZDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlNsaWNlIElEIChlLmcuIFMwMSlcIiB9KSksXG4gICAgICB0YXNrX2lkOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVGFzayBJRCAoZS5nLiBUMDEpXCIgfSkpLFxuICAgICAgYXJ0aWZhY3RfdHlwZTogU3RyaW5nRW51bShbXCJTVU1NQVJZXCIsIFwiUkVTRUFSQ0hcIiwgXCJDT05URVhUXCIsIFwiQVNTRVNTTUVOVFwiLCBcIkNPTlRFWFQtRFJBRlRcIiwgXCJQUk9KRUNUXCIsIFwiUFJPSkVDVC1EUkFGVFwiLCBcIlJFUVVJUkVNRU5UU1wiLCBcIlJFUVVJUkVNRU5UUy1EUkFGVFwiXSwgeyBkZXNjcmlwdGlvbjogXCJBcnRpZmFjdCB0eXBlIHRvIHNhdmVcIiB9KSxcbiAgICAgIGNvbnRlbnQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVGhlIGZ1bGwgbWFya2Rvd24gY29udGVudCBvZiB0aGUgYXJ0aWZhY3RcIiB9KSxcbiAgICB9KSxcbiAgICBleGVjdXRlOiBzdW1tYXJ5U2F2ZUV4ZWN1dGUsXG4gICAgcmVuZGVyQ2FsbChhcmdzOiBhbnksIHRoZW1lOiBhbnkpIHtcbiAgICAgIGxldCB0ZXh0ID0gdGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChcInN1bW1hcnlfc2F2ZSBcIikpO1xuICAgICAgaWYgKGFyZ3MuYXJ0aWZhY3RfdHlwZSkgdGV4dCArPSB0aGVtZS5mZyhcImFjY2VudFwiLCBhcmdzLmFydGlmYWN0X3R5cGUpO1xuICAgICAgY29uc3QgcGF0aCA9IFthcmdzLm1pbGVzdG9uZV9pZCwgYXJncy5zbGljZV9pZCwgYXJncy50YXNrX2lkXS5maWx0ZXIoQm9vbGVhbikuam9pbihcIi9cIik7XG4gICAgICBpZiAocGF0aCkgdGV4dCArPSB0aGVtZS5mZyhcImRpbVwiLCBgICR7cGF0aH1gKTtcbiAgICAgIHJldHVybiBuZXcgVGV4dCh0ZXh0LCAwLCAwKTtcbiAgICB9LFxuICAgIHJlbmRlclJlc3VsdChyZXN1bHQ6IGFueSwgX29wdGlvbnM6IGFueSwgdGhlbWU6IGFueSkge1xuICAgICAgY29uc3QgZCA9IHJlYWREZXRhaWxzKHJlc3VsdCk7XG4gICAgICBpZiAocmVzdWx0LmlzRXJyb3IgfHwgZD8uZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIG5ldyBUZXh0KHRoZW1lLmZnKFwiZXJyb3JcIiwgYEVycm9yOiAke2Q/LmVycm9yID8/IFwidW5rbm93blwifWApLCAwLCAwKTtcbiAgICAgIH1cbiAgICAgIGxldCB0ZXh0ID0gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIGAke2Q/LmFydGlmYWN0X3R5cGUgPz8gXCJBcnRpZmFjdFwifSBzYXZlZGApO1xuICAgICAgaWYgKGQ/LnBhdGgpIHRleHQgKz0gdGhlbWUuZmcoXCJkaW1cIiwgYCBcdTIxOTIgJHtkLnBhdGh9YCk7XG4gICAgICByZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7XG4gICAgfSxcbiAgfTtcblxuICBwaS5yZWdpc3RlclRvb2woc3VtbWFyeVNhdmVUb29sKTtcbiAgcmVnaXN0ZXJBbGlhcyhwaSwgc3VtbWFyeVNhdmVUb29sLCBcImdzZF9zYXZlX3N1bW1hcnlcIiwgXCJnc2Rfc3VtbWFyeV9zYXZlXCIpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBnc2RfbWlsZXN0b25lX2dlbmVyYXRlX2lkIChmb3JtZXJseSBnc2RfZ2VuZXJhdGVfbWlsZXN0b25lX2lkKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBjb25zdCBtaWxlc3RvbmVHZW5lcmF0ZUlkRXhlY3V0ZSA9IGFzeW5jIChfdG9vbENhbGxJZDogc3RyaW5nLCBfcGFyYW1zOiBhbnksIF9zaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkLCBfb25VcGRhdGU6IHVua25vd24sIF9jdHg6IHVua25vd24pID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgYmFzZVBhdGggPSByZXNvbHZlQ3R4Q3dkKF9jdHgpO1xuICAgICAgLy8gQ2xhaW0gYSByZXNlcnZlZCBJRCBpZiB0aGUgZ3VpZGVkLWZsb3cgYWxyZWFkeSBwcmV2aWV3ZWQgb25lIHRvIHRoZSB1c2VyLlxuICAgICAgLy8gVGhpcyBndWFyYW50ZWVzIHRoZSBJRCBzaG93biBpbiB0aGUgVUkgbWF0Y2hlcyB0aGUgb25lIG1hdGVyaWFsaXNlZCBvbiBkaXNrLlxuICAgICAgY29uc3QgeyBjbGFpbVJlc2VydmVkSWQsIGZpbmRNaWxlc3RvbmVJZHMsIGdldFJlc2VydmVkTWlsZXN0b25lSWRzLCBuZXh0TWlsZXN0b25lSWQgfSA9IGF3YWl0IGltcG9ydChcIi4uL2d1aWRlZC1mbG93LmpzXCIpO1xuICAgICAgY29uc3QgcmVzZXJ2ZWQgPSBjbGFpbVJlc2VydmVkSWQoKTtcbiAgICAgIGlmIChyZXNlcnZlZCkge1xuICAgICAgICBhd2FpdCBlbnN1cmVNaWxlc3RvbmVEYlJvdyhyZXNlcnZlZCwgYmFzZVBhdGgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiByZXNlcnZlZCB9XSxcbiAgICAgICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJnZW5lcmF0ZV9taWxlc3RvbmVfaWRcIiwgaWQ6IHJlc2VydmVkLCBzb3VyY2U6IFwicmVzZXJ2ZWRcIiB9IGFzIGFueSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgZXhpc3RpbmdJZHMgPSBmaW5kTWlsZXN0b25lSWRzKGJhc2VQYXRoKTtcbiAgICAgIGNvbnN0IHVuaXF1ZUVuYWJsZWQgPSAhIWxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyhiYXNlUGF0aCk/LnByZWZlcmVuY2VzPy51bmlxdWVfbWlsZXN0b25lX2lkcztcbiAgICAgIGNvbnN0IGFsbElkcyA9IFsuLi5uZXcgU2V0KFsuLi5leGlzdGluZ0lkcywgLi4uZ2V0UmVzZXJ2ZWRNaWxlc3RvbmVJZHMoKV0pXTtcbiAgICAgIGNvbnN0IG5ld0lkID0gbmV4dE1pbGVzdG9uZUlkKGFsbElkcywgdW5pcXVlRW5hYmxlZCk7XG4gICAgICBhd2FpdCBlbnN1cmVNaWxlc3RvbmVEYlJvdyhuZXdJZCwgYmFzZVBhdGgpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IG5ld0lkIH1dLFxuICAgICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJnZW5lcmF0ZV9taWxlc3RvbmVfaWRcIiwgaWQ6IG5ld0lkLCBleGlzdGluZ0NvdW50OiBleGlzdGluZ0lkcy5sZW5ndGgsIHVuaXF1ZUVuYWJsZWQgfSBhcyBhbnksXG4gICAgICB9O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBFcnJvciBnZW5lcmF0aW5nIG1pbGVzdG9uZSBJRDogJHttc2d9YCB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwiZ2VuZXJhdGVfbWlsZXN0b25lX2lkXCIsIGVycm9yOiBtc2cgfSBhcyBhbnksXG4gICAgICB9O1xuICAgIH1cbiAgfTtcblxuICAvKipcbiAgICogSW5zZXJ0IGEgbWluaW1hbCBEQiByb3cgZm9yIGEgbWlsZXN0b25lIElEIHNvIGl0J3MgdmlzaWJsZSB0byB0aGUgc3RhdGVcbiAgICogbWFjaGluZS4gVXNlcyBJTlNFUlQgT1IgSUdOT1JFIFx1MjAxNCBzYWZlIHRvIGNhbGwgZXZlbiBpZiBnc2RfcGxhbl9taWxlc3RvbmVcbiAgICogbGF0ZXIgd3JpdGVzIHRoZSBmdWxsIHJvdy4gU2lsZW50bHkgc2tpcHMgaWYgdGhlIERCIGlzbid0IGF2YWlsYWJsZSB5ZXRcbiAgICogKHByZS1taWdyYXRpb24pLlxuICAgKi9cbiAgYXN5bmMgZnVuY3Rpb24gZW5zdXJlTWlsZXN0b25lRGJSb3cobWlsZXN0b25lSWQ6IHN0cmluZywgYmFzZVBhdGg6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGRiQXZhaWxhYmxlID0gYXdhaXQgZW5zdXJlRGJPcGVuKGJhc2VQYXRoKTtcbiAgICBpZiAoIWRiQXZhaWxhYmxlKSByZXR1cm47XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgaW5zZXJ0TWlsZXN0b25lIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9nc2QtZGIuanNcIik7XG4gICAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogbWlsZXN0b25lSWQsIHN0YXR1czogXCJxdWV1ZWRcIiB9KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2dFcnJvcihcInRvb2xcIiwgYGluc2VydE1pbGVzdG9uZSBmYWlsZWQgZm9yICR7bWlsZXN0b25lSWR9OiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IG1pbGVzdG9uZUdlbmVyYXRlSWRUb29sID0ge1xuICAgIG5hbWU6IFwiZ3NkX21pbGVzdG9uZV9nZW5lcmF0ZV9pZFwiLFxuICAgIGxhYmVsOiBcIkdlbmVyYXRlIE1pbGVzdG9uZSBJRFwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJHZW5lcmF0ZSB0aGUgbmV4dCBtaWxlc3RvbmUgSUQgZm9yIGEgbmV3IEdTRCBtaWxlc3RvbmUuIFwiICtcbiAgICAgIFwiU2NhbnMgZXhpc3RpbmcgbWlsZXN0b25lcyBvbiBkaXNrIGFuZCByZXNwZWN0cyB0aGUgdW5pcXVlX21pbGVzdG9uZV9pZHMgcHJlZmVyZW5jZS4gXCIgK1xuICAgICAgXCJBbHdheXMgdXNlIHRoaXMgdG9vbCB3aGVuIGNyZWF0aW5nIGEgbmV3IG1pbGVzdG9uZSBcdTIwMTQgbmV2ZXIgaW52ZW50IG1pbGVzdG9uZSBJRHMgbWFudWFsbHkuXCIsXG4gICAgcHJvbXB0U25pcHBldDogXCJHZW5lcmF0ZSBhIHZhbGlkIG1pbGVzdG9uZSBJRCAocmVzcGVjdHMgdW5pcXVlX21pbGVzdG9uZV9pZHMgcHJlZmVyZW5jZSlcIixcbiAgICBwcm9tcHRHdWlkZWxpbmVzOiBbXG4gICAgICBcIkFMV0FZUyBjYWxsIGdzZF9taWxlc3RvbmVfZ2VuZXJhdGVfaWQgYmVmb3JlIGNyZWF0aW5nIGEgbmV3IG1pbGVzdG9uZSBkaXJlY3Rvcnkgb3Igd3JpdGluZyBtaWxlc3RvbmUgZmlsZXMuXCIsXG4gICAgICBcIk5ldmVyIGludmVudCBvciBoYXJkY29kZSBtaWxlc3RvbmUgSURzIGxpa2UgTTAwMSwgTTAwMiBcdTIwMTQgYWx3YXlzIHVzZSB0aGlzIHRvb2wuXCIsXG4gICAgICBcIkNhbGwgaXQgb25jZSBwZXIgbWlsZXN0b25lIHlvdSBuZWVkIHRvIGNyZWF0ZS4gRm9yIG11bHRpLW1pbGVzdG9uZSBwcm9qZWN0cywgY2FsbCBpdCBvbmNlIGZvciBlYWNoIG1pbGVzdG9uZSBpbiBzZXF1ZW5jZS5cIixcbiAgICAgIFwiVGhlIHRvb2wgcmV0dXJucyB0aGUgY29ycmVjdCBmb3JtYXQgYmFzZWQgb24gcHJvamVjdCBwcmVmZXJlbmNlcyAoZS5nLiBNMDAxIG9yIE0wMDEtcjVqemFiKS5cIixcbiAgICBdLFxuICAgIHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHt9KSxcbiAgICBleGVjdXRlOiBtaWxlc3RvbmVHZW5lcmF0ZUlkRXhlY3V0ZSxcbiAgICByZW5kZXJDYWxsKF9hcmdzOiBhbnksIHRoZW1lOiBhbnkpIHtcbiAgICAgIHJldHVybiBuZXcgVGV4dCh0aGVtZS5mZyhcInRvb2xUaXRsZVwiLCB0aGVtZS5ib2xkKFwibWlsZXN0b25lX2dlbmVyYXRlX2lkXCIpKSwgMCwgMCk7XG4gICAgfSxcbiAgICByZW5kZXJSZXN1bHQocmVzdWx0OiBhbnksIF9vcHRpb25zOiBhbnksIHRoZW1lOiBhbnkpIHtcbiAgICAgIGNvbnN0IGQgPSByZWFkRGV0YWlscyhyZXN1bHQpO1xuICAgICAgaWYgKHJlc3VsdC5pc0Vycm9yIHx8IGQ/LmVycm9yKSB7XG4gICAgICAgIHJldHVybiBuZXcgVGV4dCh0aGVtZS5mZyhcImVycm9yXCIsIGBFcnJvcjogJHtkPy5lcnJvciA/PyBcInVua25vd25cIn1gKSwgMCwgMCk7XG4gICAgICB9XG4gICAgICBsZXQgdGV4dCA9IHRoZW1lLmZnKFwic3VjY2Vzc1wiLCBgR2VuZXJhdGVkICR7ZD8uaWQgPz8gXCJJRFwifWApO1xuICAgICAgaWYgKGQ/LnNvdXJjZSA9PT0gXCJyZXNlcnZlZFwiKSB0ZXh0ICs9IHRoZW1lLmZnKFwiZGltXCIsIFwiIChyZXNlcnZlZClcIik7XG4gICAgICByZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7XG4gICAgfSxcbiAgfTtcblxuICBwaS5yZWdpc3RlclRvb2wobWlsZXN0b25lR2VuZXJhdGVJZFRvb2wpO1xuICByZWdpc3RlckFsaWFzKHBpLCBtaWxlc3RvbmVHZW5lcmF0ZUlkVG9vbCwgXCJnc2RfZ2VuZXJhdGVfbWlsZXN0b25lX2lkXCIsIFwiZ3NkX21pbGVzdG9uZV9nZW5lcmF0ZV9pZFwiKTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ3NkX3BsYW5fbWlsZXN0b25lIChnc2RfbWlsZXN0b25lX3BsYW4gYWxpYXMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIGNvbnN0IHBsYW5NaWxlc3RvbmVFeGVjdXRlID0gYXN5bmMgKF90b29sQ2FsbElkOiBzdHJpbmcsIHBhcmFtczogYW55LCBfc2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCwgX29uVXBkYXRlOiB1bmtub3duLCBfY3R4OiB1bmtub3duKSA9PiB7XG4gICAgY29uc3QgeyBleGVjdXRlUGxhbk1pbGVzdG9uZSB9ID0gYXdhaXQgbG9hZFdvcmtmbG93RXhlY3V0b3JzKCk7XG4gICAgcmV0dXJuIGV4ZWN1dGVQbGFuTWlsZXN0b25lKHBhcmFtcywgcmVzb2x2ZUN0eEN3ZChfY3R4KSk7XG4gIH07XG5cbiAgY29uc3QgcGxhbk1pbGVzdG9uZVRvb2wgPSB7XG4gICAgbmFtZTogXCJnc2RfcGxhbl9taWxlc3RvbmVcIixcbiAgICBsYWJlbDogXCJQbGFuIE1pbGVzdG9uZVwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJXcml0ZSBtaWxlc3RvbmUgcGxhbm5pbmcgc3RhdGUgdG8gdGhlIEdTRCBkYXRhYmFzZSwgcmVuZGVyIFJPQURNQVAubWQgZnJvbSBEQiwgYW5kIGNsZWFyIGNhY2hlcyBhZnRlciBhIHN1Y2Nlc3NmdWwgcmVuZGVyLlwiLFxuICAgIHByb21wdFNuaXBwZXQ6IFwiUGxhbiBhIG1pbGVzdG9uZSB2aWEgREIgd3JpdGUgKyByb2FkbWFwIHJlbmRlciArIGNhY2hlIGludmFsaWRhdGlvblwiLFxuICAgIHByb21wdEd1aWRlbGluZXM6IFtcbiAgICAgIFwiVXNlIGdzZF9wbGFuX21pbGVzdG9uZSBmb3IgbWlsZXN0b25lIHBsYW5uaW5nIGluc3RlYWQgb2Ygd3JpdGluZyBST0FETUFQLm1kIGRpcmVjdGx5LlwiLFxuICAgICAgXCJLZWVwIHBhcmFtZXRlcnMgZmxhdCBhbmQgcHJvdmlkZSB0aGUgZnVsbCBtaWxlc3RvbmUgcGxhbm5pbmcgcGF5bG9hZCwgaW5jbHVkaW5nIHNsaWNlcy5cIixcbiAgICAgIFwiTWlsZXN0b25lIGFuZCBzbGljZSB0aXRsZXMgbXVzdCBub3QgY29udGFpbiBmb3J3YXJkIHNsYXNoICgvKSwgZW4gZGFzaCwgb3IgZW0gZGFzaCBjaGFyYWN0ZXJzLlwiLFxuICAgICAgXCJUaGUgdG9vbCB2YWxpZGF0ZXMgaW5wdXQsIHdyaXRlcyBtaWxlc3RvbmUgYW5kIHNsaWNlIHBsYW5uaW5nIGRhdGEgdHJhbnNhY3Rpb25hbGx5LCByZW5kZXJzIFJPQURNQVAubWQgZnJvbSBEQiwgYW5kIGNsZWFycyBib3RoIHN0YXRlIGFuZCBwYXJzZSBjYWNoZXMgYWZ0ZXIgc3VjY2Vzcy5cIixcbiAgICAgIFwiVXNlIHRoZSBjYW5vbmljYWwgbmFtZSBnc2RfcGxhbl9taWxlc3RvbmU7IGdzZF9taWxlc3RvbmVfcGxhbiBpcyBvbmx5IGFuIGFsaWFzLlwiLFxuICAgIF0sXG4gICAgcGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuICAgICAgLy8gXHUyNTAwXHUyNTAwIENvcmUgaWRlbnRpZmljYXRpb24gKyBjb250ZW50IChyZXF1aXJlZCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBtaWxlc3RvbmVJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJNaWxlc3RvbmUgSUQgKGUuZy4gTTAwMSlcIiB9KSxcbiAgICAgIHRpdGxlOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk1pbGVzdG9uZSB0aXRsZTsgbXVzdCBub3QgY29udGFpbiBmb3J3YXJkIHNsYXNoICgvKSwgZW4gZGFzaCwgb3IgZW0gZGFzaCBjaGFyYWN0ZXJzXCIgfSksXG4gICAgICB2aXNpb246IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiTWlsZXN0b25lIHZpc2lvblwiIH0pLFxuICAgICAgc2xpY2VzOiBUeXBlLkFycmF5KFR5cGUuT2JqZWN0KHtcbiAgICAgICAgc2xpY2VJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTbGljZSBJRCAoZS5nLiBTMDEpXCIgfSksXG4gICAgICAgIHRpdGxlOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlNsaWNlIHRpdGxlOyBtdXN0IG5vdCBjb250YWluIGZvcndhcmQgc2xhc2ggKC8pLCBlbiBkYXNoLCBvciBlbSBkYXNoIGNoYXJhY3RlcnNcIiB9KSxcbiAgICAgICAgcmlzazogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTbGljZSByaXNrXCIgfSksXG4gICAgICAgIGRlcGVuZHM6IFR5cGUuQXJyYXkoVHlwZS5TdHJpbmcoKSwgeyBkZXNjcmlwdGlvbjogXCJTbGljZSBkZXBlbmRlbmN5IElEc1wiIH0pLFxuICAgICAgICBkZW1vOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlJvYWRtYXAgZGVtbyB0ZXh0IC8gQWZ0ZXIgdGhpc1wiIH0pLFxuICAgICAgICBnb2FsOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlNsaWNlIGdvYWxcIiB9KSxcbiAgICAgICAgLy8gQURSLTAxMTogaGVhdnkgcGxhbm5pbmcgZmllbGRzIGFyZSBvcHRpb25hbCBmb3Igc2tldGNoIHNsaWNlczsgcmVxdWlyZWQgZm9yIGZ1bGwgc2xpY2VzLlxuICAgICAgICBzdWNjZXNzQ3JpdGVyaWE6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTbGljZSBzdWNjZXNzIGNyaXRlcmlhIGJsb2NrIChyZXF1aXJlZCBmb3IgZnVsbCBzbGljZXM7IG9taXQgZm9yIHNrZXRjaGVzKVwiIH0pKSxcbiAgICAgICAgcHJvb2ZMZXZlbDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlNsaWNlIHByb29mIGxldmVsIChyZXF1aXJlZCBmb3IgZnVsbCBzbGljZXM7IG9taXQgZm9yIHNrZXRjaGVzKVwiIH0pKSxcbiAgICAgICAgaW50ZWdyYXRpb25DbG9zdXJlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiU2xpY2UgaW50ZWdyYXRpb24gY2xvc3VyZSAocmVxdWlyZWQgZm9yIGZ1bGwgc2xpY2VzOyBvbWl0IGZvciBza2V0Y2hlcylcIiB9KSksXG4gICAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTbGljZSBvYnNlcnZhYmlsaXR5IGltcGFjdCAocmVxdWlyZWQgZm9yIGZ1bGwgc2xpY2VzOyBvbWl0IGZvciBza2V0Y2hlcylcIiB9KSksXG4gICAgICAgIC8vIEFEUi0wMTEgc2tldGNoLXRoZW4tcmVmaW5lIGZpZWxkcy5cbiAgICAgICAgaXNTa2V0Y2g6IFR5cGUuT3B0aW9uYWwoVHlwZS5Cb29sZWFuKHsgZGVzY3JpcHRpb246IFwiQURSLTAxMTogdHJ1ZSBtYXJrcyB0aGlzIHNsaWNlIGFzIGEgc2tldGNoIGF3YWl0aW5nIHJlZmluZS1zbGljZSBleHBhbnNpb25cIiB9KSksXG4gICAgICAgIHNrZXRjaFNjb3BlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQURSLTAxMTogMlx1MjAxMzMgc2VudGVuY2Ugc2NvcGUgYm91bmRhcnksIHJlcXVpcmVkIHdoZW4gaXNTa2V0Y2g9dHJ1ZVwiIH0pKSxcbiAgICAgIH0pLCB7IGRlc2NyaXB0aW9uOiBcIlBsYW5uZWQgc2xpY2VzIGZvciB0aGUgbWlsZXN0b25lXCIgfSksXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgRW5yaWNobWVudCBtZXRhZGF0YSAob3B0aW9uYWwgXHUyMDE0IGRlZmF1bHRzIHRvIGVtcHR5KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgIHN0YXR1czogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk1pbGVzdG9uZSBzdGF0dXMgKGRlZmF1bHRzIHRvIGFjdGl2ZSlcIiB9KSksXG4gICAgICBkZXBlbmRzT246IFR5cGUuT3B0aW9uYWwoVHlwZS5BcnJheShUeXBlLlN0cmluZygpLCB7IGRlc2NyaXB0aW9uOiBcIk1pbGVzdG9uZSBkZXBlbmRlbmNpZXNcIiB9KSksXG4gICAgICBzdWNjZXNzQ3JpdGVyaWE6IFR5cGUuT3B0aW9uYWwoVHlwZS5BcnJheShUeXBlLlN0cmluZygpLCB7IGRlc2NyaXB0aW9uOiBcIlRvcC1sZXZlbCBzdWNjZXNzIGNyaXRlcmlhIGJ1bGxldHNcIiB9KSksXG4gICAgICBrZXlSaXNrczogVHlwZS5PcHRpb25hbChUeXBlLkFycmF5KFR5cGUuT2JqZWN0KHtcbiAgICAgICAgcmlzazogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJSaXNrIHN0YXRlbWVudFwiIH0pLFxuICAgICAgICB3aHlJdE1hdHRlcnM6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiV2h5IHRoZSByaXNrIG1hdHRlcnNcIiB9KSxcbiAgICAgIH0pLCB7IGRlc2NyaXB0aW9uOiBcIlN0cnVjdHVyZWQgcmlzayBlbnRyaWVzXCIgfSkpLFxuICAgICAgcHJvb2ZTdHJhdGVneTogVHlwZS5PcHRpb25hbChUeXBlLkFycmF5KFR5cGUuT2JqZWN0KHtcbiAgICAgICAgcmlza09yVW5rbm93bjogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJSaXNrIG9yIHVua25vd24gdG8gcmV0aXJlXCIgfSksXG4gICAgICAgIHJldGlyZUluOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIldoZXJlIGl0IHdpbGwgYmUgcmV0aXJlZFwiIH0pLFxuICAgICAgICB3aGF0V2lsbEJlUHJvdmVuOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIldoYXQgcHJvb2Ygd2lsbCBiZSBwcm9kdWNlZFwiIH0pLFxuICAgICAgfSksIHsgZGVzY3JpcHRpb246IFwiU3RydWN0dXJlZCBwcm9vZiBzdHJhdGVneSBlbnRyaWVzXCIgfSkpLFxuICAgICAgdmVyaWZpY2F0aW9uQ29udHJhY3Q6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJWZXJpZmljYXRpb24gY29udHJhY3QgdGV4dFwiIH0pKSxcbiAgICAgIHZlcmlmaWNhdGlvbkludGVncmF0aW9uOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiSW50ZWdyYXRpb24gdmVyaWZpY2F0aW9uIHRleHRcIiB9KSksXG4gICAgICB2ZXJpZmljYXRpb25PcGVyYXRpb25hbDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk9wZXJhdGlvbmFsIHZlcmlmaWNhdGlvbiB0ZXh0XCIgfSkpLFxuICAgICAgdmVyaWZpY2F0aW9uVWF0OiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVUFUIHZlcmlmaWNhdGlvbiB0ZXh0XCIgfSkpLFxuICAgICAgZGVmaW5pdGlvbk9mRG9uZTogVHlwZS5PcHRpb25hbChUeXBlLkFycmF5KFR5cGUuU3RyaW5nKCksIHsgZGVzY3JpcHRpb246IFwiRGVmaW5pdGlvbiBvZiBkb25lIGJ1bGxldHNcIiB9KSksXG4gICAgICByZXF1aXJlbWVudENvdmVyYWdlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiUmVxdWlyZW1lbnQgY292ZXJhZ2UgdGV4dFwiIH0pKSxcbiAgICAgIGJvdW5kYXJ5TWFwTWFya2Rvd246IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJCb3VuZGFyeSBtYXAgbWFya2Rvd24gYmxvY2tcIiB9KSksXG4gICAgICAvLyBTaW5nbGUtd3JpdGVyIHYzIGF1ZGl0IHRyYWlsIChTdHJlYW0gMik6IGNhbGxlci1wcm92aWRlZCBhY3RvciBpZGVudGl0eSArIGNhdXNhdGlvbi5cbiAgICAgIGFjdG9yTmFtZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkNhbGxlci1wcm92aWRlZCBhY3RvciBpZGVudGl0eSBmb3IgdGhlIGF1ZGl0IHRyYWlsIChlLmcuICdleGVjdXRvci0wMScsICdnc2Qtb3JjaGVzdHJhdG9yJylcIiB9KSksXG4gICAgICB0cmlnZ2VyUmVhc29uOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQ2FsbGVyLXByb3ZpZGVkIHJlYXNvbiB0aGlzIGFjdGlvbiB3YXMgdHJpZ2dlcmVkIChlLmcuICdwbGFuLXBoYXNlIGNvbXBsZXRlJylcIiB9KSksXG4gICAgfSksXG4gICAgZXhlY3V0ZTogcGxhbk1pbGVzdG9uZUV4ZWN1dGUsXG4gIH07XG5cbiAgcGkucmVnaXN0ZXJUb29sKHBsYW5NaWxlc3RvbmVUb29sKTtcbiAgcmVnaXN0ZXJBbGlhcyhwaSwgcGxhbk1pbGVzdG9uZVRvb2wsIFwiZ3NkX21pbGVzdG9uZV9wbGFuXCIsIFwiZ3NkX3BsYW5fbWlsZXN0b25lXCIpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBnc2RfcGxhbl9zbGljZSAoZ3NkX3NsaWNlX3BsYW4gYWxpYXMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIGNvbnN0IHBsYW5TbGljZUV4ZWN1dGUgPSBhc3luYyAoX3Rvb2xDYWxsSWQ6IHN0cmluZywgcGFyYW1zOiBhbnksIF9zaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkLCBfb25VcGRhdGU6IHVua25vd24sIF9jdHg6IHVua25vd24pID0+IHtcbiAgICBjb25zdCB7IGV4ZWN1dGVQbGFuU2xpY2UgfSA9IGF3YWl0IGxvYWRXb3JrZmxvd0V4ZWN1dG9ycygpO1xuICAgIHJldHVybiBleGVjdXRlUGxhblNsaWNlKHBhcmFtcywgcmVzb2x2ZUN0eEN3ZChfY3R4KSk7XG4gIH07XG5cbiAgY29uc3QgcGxhblNsaWNlVG9vbCA9IHtcbiAgICBuYW1lOiBcImdzZF9wbGFuX3NsaWNlXCIsXG4gICAgbGFiZWw6IFwiUGxhbiBTbGljZVwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJXcml0ZSBzbGljZSBwbGFubmluZyBzdGF0ZSB0byB0aGUgR1NEIGRhdGFiYXNlLCByZW5kZXIgUyMjLVBMQU4ubWQgcGx1cyB0YXNrIFBMQU4gYXJ0aWZhY3RzIGZyb20gREIsIGFuZCBjbGVhciBjYWNoZXMgYWZ0ZXIgYSBzdWNjZXNzZnVsIHJlbmRlci5cIixcbiAgICBwcm9tcHRTbmlwcGV0OiBcIlBsYW4gYSBzbGljZSB2aWEgREIgd3JpdGUgKyBQTEFOIHJlbmRlciArIGNhY2hlIGludmFsaWRhdGlvblwiLFxuICAgIHByb21wdEd1aWRlbGluZXM6IFtcbiAgICAgIFwiVXNlIGdzZF9wbGFuX3NsaWNlIGZvciBzbGljZSBwbGFubmluZyBpbnN0ZWFkIG9mIHdyaXRpbmcgUyMjLVBMQU4ubWQgb3IgdGFzayBQTEFOIGZpbGVzIGRpcmVjdGx5LlwiLFxuICAgICAgXCJLZWVwIHBhcmFtZXRlcnMgZmxhdCBhbmQgcHJvdmlkZSB0aGUgZnVsbCBzbGljZSBwbGFubmluZyBwYXlsb2FkLCBpbmNsdWRpbmcgdGFza3MuXCIsXG4gICAgICBcIlRoZSB0b29sIHZhbGlkYXRlcyBpbnB1dCwgcmVxdWlyZXMgYW4gZXhpc3RpbmcgcGFyZW50IHNsaWNlLCB3cml0ZXMgc2xpY2UvdGFzayBwbGFubmluZyBkYXRhLCByZW5kZXJzIFBMQU4ubWQgYW5kIHRhc2sgcGxhbiBmaWxlcyBmcm9tIERCLCBhbmQgY2xlYXJzIGJvdGggc3RhdGUgYW5kIHBhcnNlIGNhY2hlcyBhZnRlciBzdWNjZXNzLlwiLFxuICAgICAgXCJVc2UgdGhlIGNhbm9uaWNhbCBuYW1lIGdzZF9wbGFuX3NsaWNlOyBnc2Rfc2xpY2VfcGxhbiBpcyBvbmx5IGFuIGFsaWFzLlwiLFxuICAgIF0sXG4gICAgcGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuICAgICAgLy8gXHUyNTAwXHUyNTAwIENvcmUgaWRlbnRpZmljYXRpb24gKyBjb250ZW50IChyZXF1aXJlZCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBtaWxlc3RvbmVJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJNaWxlc3RvbmUgSUQgKGUuZy4gTTAwMSlcIiB9KSxcbiAgICAgIHNsaWNlSWQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiU2xpY2UgSUQgKGUuZy4gUzAxKVwiIH0pLFxuICAgICAgZ29hbDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTbGljZSBnb2FsXCIgfSksXG4gICAgICB0YXNrczogVHlwZS5BcnJheShUeXBlLk9iamVjdCh7XG4gICAgICAgIHRhc2tJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJUYXNrIElEIChlLmcuIFQwMSlcIiB9KSxcbiAgICAgICAgdGl0bGU6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVGFzayB0aXRsZVwiIH0pLFxuICAgICAgICBkZXNjcmlwdGlvbjogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJUYXNrIGRlc2NyaXB0aW9uIC8gc3RlcHMgYmxvY2tcIiB9KSxcbiAgICAgICAgZXN0aW1hdGU6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVGFzayBlc3RpbWF0ZSBzdHJpbmdcIiB9KSxcbiAgICAgICAgZmlsZXM6IFR5cGUuQXJyYXkoVHlwZS5TdHJpbmcoKSwgeyBkZXNjcmlwdGlvbjogXCJBcnJheTxzdHJpbmc+IG9mIGZpbGVzIGxpa2VseSB0b3VjaGVkOyBwYXNzIFtcXFwicGF0aFxcXCJdIG9yIFtdLCBuZXZlciBhIHNpbmdsZSBzdHJpbmdcIiB9KSxcbiAgICAgICAgdmVyaWZ5OiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlZlcmlmaWNhdGlvbiBjb21tYW5kIG9yIGJsb2NrXCIgfSksXG4gICAgICAgIGlucHV0czogVHlwZS5BcnJheShUeXBlLlN0cmluZygpLCB7IGRlc2NyaXB0aW9uOiBcIkFycmF5PHN0cmluZz4gb2YgaW5wdXQgZmlsZXMgb3IgcmVmZXJlbmNlczsgcGFzcyBbXFxcInBhdGhcXFwiXSBvciBbXSwgbmV2ZXIgYSBzaW5nbGUgc3RyaW5nXCIgfSksXG4gICAgICAgIGV4cGVjdGVkT3V0cHV0OiBUeXBlLkFycmF5KFR5cGUuU3RyaW5nKCksIHsgZGVzY3JpcHRpb246IFwiQXJyYXk8c3RyaW5nPiBvZiBleHBlY3RlZCBvdXRwdXQgZmlsZXMgb3IgYXJ0aWZhY3RzOyBwYXNzIFtcXFwicGF0aFxcXCJdIG9yIFtdLCBuZXZlciBhIHNpbmdsZSBzdHJpbmdcIiB9KSxcbiAgICAgICAgb2JzZXJ2YWJpbGl0eUltcGFjdDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlRhc2sgb2JzZXJ2YWJpbGl0eSBpbXBhY3RcIiB9KSksXG4gICAgICB9KSwgeyBkZXNjcmlwdGlvbjogXCJQbGFubmVkIHRhc2tzIGZvciB0aGUgc2xpY2VcIiB9KSxcbiAgICAgIC8vIFx1MjUwMFx1MjUwMCBFbnJpY2htZW50IG1ldGFkYXRhIChvcHRpb25hbCBcdTIwMTQgZGVmYXVsdHMgdG8gZW1wdHkpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgc3VjY2Vzc0NyaXRlcmlhOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiU2xpY2Ugc3VjY2VzcyBjcml0ZXJpYSBibG9ja1wiIH0pKSxcbiAgICAgIHByb29mTGV2ZWw6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTbGljZSBwcm9vZiBsZXZlbFwiIH0pKSxcbiAgICAgIGludGVncmF0aW9uQ2xvc3VyZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlNsaWNlIGludGVncmF0aW9uIGNsb3N1cmVcIiB9KSksXG4gICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiU2xpY2Ugb2JzZXJ2YWJpbGl0eSBpbXBhY3RcIiB9KSksXG4gICAgICAvLyBTaW5nbGUtd3JpdGVyIHYzIGF1ZGl0IHRyYWlsIChTdHJlYW0gMik6IGNhbGxlci1wcm92aWRlZCBhY3RvciBpZGVudGl0eSArIGNhdXNhdGlvbi5cbiAgICAgIGFjdG9yTmFtZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkNhbGxlci1wcm92aWRlZCBhY3RvciBpZGVudGl0eSBmb3IgdGhlIGF1ZGl0IHRyYWlsIChlLmcuICdleGVjdXRvci0wMScsICdnc2Qtb3JjaGVzdHJhdG9yJylcIiB9KSksXG4gICAgICB0cmlnZ2VyUmVhc29uOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQ2FsbGVyLXByb3ZpZGVkIHJlYXNvbiB0aGlzIGFjdGlvbiB3YXMgdHJpZ2dlcmVkIChlLmcuICdwbGFuLXBoYXNlIGNvbXBsZXRlJylcIiB9KSksXG4gICAgfSksXG4gICAgZXhlY3V0ZTogcGxhblNsaWNlRXhlY3V0ZSxcbiAgfTtcblxuICBwaS5yZWdpc3RlclRvb2wocGxhblNsaWNlVG9vbCk7XG4gIHJlZ2lzdGVyQWxpYXMocGksIHBsYW5TbGljZVRvb2wsIFwiZ3NkX3NsaWNlX3BsYW5cIiwgXCJnc2RfcGxhbl9zbGljZVwiKTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ3NkX3BsYW5fdGFzayAoZ3NkX3Rhc2tfcGxhbiBhbGlhcykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgY29uc3QgcGxhblRhc2tFeGVjdXRlID0gYXN5bmMgKF90b29sQ2FsbElkOiBzdHJpbmcsIHBhcmFtczogYW55LCBfc2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCwgX29uVXBkYXRlOiB1bmtub3duLCBfY3R4OiB1bmtub3duKSA9PiB7XG4gICAgY29uc3QgYmFzZVBhdGggPSByZXNvbHZlQ3R4Q3dkKF9jdHgpO1xuICAgIGNvbnN0IGRiQXZhaWxhYmxlID0gYXdhaXQgZW5zdXJlRGJPcGVuKGJhc2VQYXRoKTtcbiAgICBpZiAoIWRiQXZhaWxhYmxlKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogXCJFcnJvcjogR1NEIGRhdGFiYXNlIGlzIG5vdCBhdmFpbGFibGUuIENhbm5vdCBwbGFuIHRhc2suXCIgfV0sXG4gICAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInBsYW5fdGFza1wiLCBlcnJvcjogXCJkYl91bmF2YWlsYWJsZVwiIH0gYXMgYW55LFxuICAgICAgfTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgaGFuZGxlUGxhblRhc2sgfSA9IGF3YWl0IGltcG9ydChcIi4uL3Rvb2xzL3BsYW4tdGFzay5qc1wiKTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVBsYW5UYXNrKHBhcmFtcywgYmFzZVBhdGgpO1xuICAgICAgaWYgKFwiZXJyb3JcIiBpbiByZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYEVycm9yIHBsYW5uaW5nIHRhc2s6ICR7cmVzdWx0LmVycm9yfWAgfV0sXG4gICAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwicGxhbl90YXNrXCIsIGVycm9yOiByZXN1bHQuZXJyb3IgfSBhcyBhbnksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYFBsYW5uZWQgdGFzayAke3Jlc3VsdC50YXNrSWR9ICgke3Jlc3VsdC5zbGljZUlkfS8ke3Jlc3VsdC5taWxlc3RvbmVJZH0pYCB9XSxcbiAgICAgICAgZGV0YWlsczoge1xuICAgICAgICAgIG9wZXJhdGlvbjogXCJwbGFuX3Rhc2tcIixcbiAgICAgICAgICBtaWxlc3RvbmVJZDogcmVzdWx0Lm1pbGVzdG9uZUlkLFxuICAgICAgICAgIHNsaWNlSWQ6IHJlc3VsdC5zbGljZUlkLFxuICAgICAgICAgIHRhc2tJZDogcmVzdWx0LnRhc2tJZCxcbiAgICAgICAgICB0YXNrUGxhblBhdGg6IHJlc3VsdC50YXNrUGxhblBhdGgsXG4gICAgICAgIH0gYXMgYW55LFxuICAgICAgfTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgIGxvZ0Vycm9yKFwidG9vbFwiLCBgcGxhbl90YXNrIHRvb2wgZmFpbGVkOiAke21zZ31gLCB7IHRvb2w6IFwiZ3NkX3BsYW5fdGFza1wiLCBlcnJvcjogU3RyaW5nKGVycikgfSk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYEVycm9yIHBsYW5uaW5nIHRhc2s6ICR7bXNnfWAgfV0sXG4gICAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInBsYW5fdGFza1wiLCBlcnJvcjogbXNnIH0gYXMgYW55LFxuICAgICAgfTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgcGxhblRhc2tUb29sID0ge1xuICAgIG5hbWU6IFwiZ3NkX3BsYW5fdGFza1wiLFxuICAgIGxhYmVsOiBcIlBsYW4gVGFza1wiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJXcml0ZSB0YXNrIHBsYW5uaW5nIHN0YXRlIHRvIHRoZSBHU0QgZGF0YWJhc2UsIHJlbmRlciB0YXNrcy9UIyMtUExBTi5tZCBmcm9tIERCLCBhbmQgY2xlYXIgY2FjaGVzIGFmdGVyIGEgc3VjY2Vzc2Z1bCByZW5kZXIuXCIsXG4gICAgcHJvbXB0U25pcHBldDogXCJQbGFuIGEgdGFzayB2aWEgREIgd3JpdGUgKyB0YXNrIFBMQU4gcmVuZGVyICsgY2FjaGUgaW52YWxpZGF0aW9uXCIsXG4gICAgcHJvbXB0R3VpZGVsaW5lczogW1xuICAgICAgXCJVc2UgZ3NkX3BsYW5fdGFzayBmb3IgdGFzayBwbGFubmluZyBpbnN0ZWFkIG9mIHdyaXRpbmcgdGFza3MvVCMjLVBMQU4ubWQgZGlyZWN0bHkuXCIsXG4gICAgICBcIktlZXAgcGFyYW1ldGVycyBmbGF0IGFuZCBwcm92aWRlIHRoZSBmdWxsIHRhc2sgcGxhbm5pbmcgcGF5bG9hZC5cIixcbiAgICAgIFwiVGhlIHRvb2wgdmFsaWRhdGVzIGlucHV0LCByZXF1aXJlcyBhbiBleGlzdGluZyBwYXJlbnQgc2xpY2UsIHdyaXRlcyB0YXNrIHBsYW5uaW5nIGRhdGEsIHJlbmRlcnMgdGhlIHRhc2sgUExBTiBmaWxlIGZyb20gREIsIGFuZCBjbGVhcnMgYm90aCBzdGF0ZSBhbmQgcGFyc2UgY2FjaGVzIGFmdGVyIHN1Y2Nlc3MuXCIsXG4gICAgICBcIlVzZSB0aGUgY2Fub25pY2FsIG5hbWUgZ3NkX3BsYW5fdGFzazsgZ3NkX3Rhc2tfcGxhbiBpcyBvbmx5IGFuIGFsaWFzLlwiLFxuICAgIF0sXG4gICAgcGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuICAgICAgbWlsZXN0b25lSWQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiTWlsZXN0b25lIElEIChlLmcuIE0wMDEpXCIgfSksXG4gICAgICBzbGljZUlkOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlNsaWNlIElEIChlLmcuIFMwMSlcIiB9KSxcbiAgICAgIHRhc2tJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJUYXNrIElEIChlLmcuIFQwMSlcIiB9KSxcbiAgICAgIHRpdGxlOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlRhc2sgdGl0bGVcIiB9KSxcbiAgICAgIGRlc2NyaXB0aW9uOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlRhc2sgZGVzY3JpcHRpb24gLyBzdGVwcyBibG9ja1wiIH0pLFxuICAgICAgZXN0aW1hdGU6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVGFzayBlc3RpbWF0ZSBzdHJpbmdcIiB9KSxcbiAgICAgIGZpbGVzOiBUeXBlLkFycmF5KFR5cGUuU3RyaW5nKCksIHsgZGVzY3JpcHRpb246IFwiQXJyYXk8c3RyaW5nPiBvZiBmaWxlcyBsaWtlbHkgdG91Y2hlZDsgcGFzcyBbXFxcInBhdGhcXFwiXSBvciBbXSwgbmV2ZXIgYSBzaW5nbGUgc3RyaW5nXCIgfSksXG4gICAgICB2ZXJpZnk6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVmVyaWZpY2F0aW9uIGNvbW1hbmQgb3IgYmxvY2tcIiB9KSxcbiAgICAgIGlucHV0czogVHlwZS5BcnJheShUeXBlLlN0cmluZygpLCB7IGRlc2NyaXB0aW9uOiBcIkFycmF5PHN0cmluZz4gb2YgaW5wdXQgZmlsZXMgb3IgcmVmZXJlbmNlczsgcGFzcyBbXFxcInBhdGhcXFwiXSBvciBbXSwgbmV2ZXIgYSBzaW5nbGUgc3RyaW5nXCIgfSksXG4gICAgICBleHBlY3RlZE91dHB1dDogVHlwZS5BcnJheShUeXBlLlN0cmluZygpLCB7IGRlc2NyaXB0aW9uOiBcIkFycmF5PHN0cmluZz4gb2YgZXhwZWN0ZWQgb3V0cHV0IGZpbGVzIG9yIGFydGlmYWN0czsgcGFzcyBbXFxcInBhdGhcXFwiXSBvciBbXSwgbmV2ZXIgYSBzaW5nbGUgc3RyaW5nXCIgfSksXG4gICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0OiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVGFzayBvYnNlcnZhYmlsaXR5IGltcGFjdFwiIH0pKSxcbiAgICAgIC8vIFNpbmdsZS13cml0ZXIgdjMgYXVkaXQgdHJhaWwgKFN0cmVhbSAyKTogY2FsbGVyLXByb3ZpZGVkIGFjdG9yIGlkZW50aXR5ICsgY2F1c2F0aW9uLlxuICAgICAgYWN0b3JOYW1lOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQ2FsbGVyLXByb3ZpZGVkIGFjdG9yIGlkZW50aXR5IGZvciB0aGUgYXVkaXQgdHJhaWwgKGUuZy4gJ2V4ZWN1dG9yLTAxJywgJ2dzZC1vcmNoZXN0cmF0b3InKVwiIH0pKSxcbiAgICAgIHRyaWdnZXJSZWFzb246IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJDYWxsZXItcHJvdmlkZWQgcmVhc29uIHRoaXMgYWN0aW9uIHdhcyB0cmlnZ2VyZWQgKGUuZy4gJ3BsYW4tcGhhc2UgY29tcGxldGUnKVwiIH0pKSxcbiAgICB9KSxcbiAgICBleGVjdXRlOiBwbGFuVGFza0V4ZWN1dGUsXG4gIH07XG5cbiAgcGkucmVnaXN0ZXJUb29sKHBsYW5UYXNrVG9vbCk7XG4gIHJlZ2lzdGVyQWxpYXMocGksIHBsYW5UYXNrVG9vbCwgXCJnc2RfdGFza19wbGFuXCIsIFwiZ3NkX3BsYW5fdGFza1wiKTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ3NkX3Rhc2tfY29tcGxldGUgKGdzZF9jb21wbGV0ZV90YXNrIGFsaWFzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBjb25zdCB0YXNrQ29tcGxldGVFeGVjdXRlID0gYXN5bmMgKF90b29sQ2FsbElkOiBzdHJpbmcsIHBhcmFtczogYW55LCBfc2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCwgX29uVXBkYXRlOiB1bmtub3duLCBfY3R4OiB1bmtub3duKSA9PiB7XG4gICAgY29uc3QgeyBleGVjdXRlVGFza0NvbXBsZXRlIH0gPSBhd2FpdCBsb2FkV29ya2Zsb3dFeGVjdXRvcnMoKTtcbiAgICByZXR1cm4gZXhlY3V0ZVRhc2tDb21wbGV0ZShwYXJhbXMsIHJlc29sdmVDdHhDd2QoX2N0eCkpO1xuICB9O1xuXG4gIGNvbnN0IHRhc2tDb21wbGV0ZVRvb2wgPSB7XG4gICAgbmFtZTogXCJnc2RfdGFza19jb21wbGV0ZVwiLFxuICAgIGxhYmVsOiBcIkNvbXBsZXRlIFRhc2tcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiUmVjb3JkIGEgY29tcGxldGVkIHRhc2sgdG8gdGhlIEdTRCBkYXRhYmFzZSwgcmVuZGVyIGEgU1VNTUFSWS5tZCB0byBkaXNrLCBhbmQgdG9nZ2xlIHRoZSBwbGFuIGNoZWNrYm94IFx1MjAxNCBhbGwgaW4gb25lIGF0b21pYyBvcGVyYXRpb24uIFwiICtcbiAgICAgIFwiV3JpdGVzIHRoZSB0YXNrIHJvdyBpbnNpZGUgYSB0cmFuc2FjdGlvbiwgdGhlbiBwZXJmb3JtcyBmaWxlc3lzdGVtIHdyaXRlcyBvdXRzaWRlIHRoZSB0cmFuc2FjdGlvbi5cIixcbiAgICBwcm9tcHRTbmlwcGV0OiBcIkNvbXBsZXRlIGEgR1NEIHRhc2sgKERCIHdyaXRlICsgc3VtbWFyeSByZW5kZXIgKyBjaGVja2JveCB0b2dnbGUpXCIsXG4gICAgcHJvbXB0R3VpZGVsaW5lczogW1xuICAgICAgXCJVc2UgZ3NkX3Rhc2tfY29tcGxldGUgKG9yIGdzZF9jb21wbGV0ZV90YXNrKSB3aGVuIGEgdGFzayBpcyBmaW5pc2hlZCBhbmQgbmVlZHMgdG8gYmUgcmVjb3JkZWQuXCIsXG4gICAgICBcIkFsbCBzdHJpbmcgZmllbGRzIGFyZSByZXF1aXJlZC4gdmVyaWZpY2F0aW9uRXZpZGVuY2UgaXMgYW4gYXJyYXkgb2Ygb2JqZWN0cyB3aXRoIGNvbW1hbmQsIGV4aXRDb2RlLCB2ZXJkaWN0LCBkdXJhdGlvbk1zLlwiLFxuICAgICAgXCJUaGUgdG9vbCB2YWxpZGF0ZXMgcmVxdWlyZWQgZmllbGRzIGFuZCByZXR1cm5zIGFuIGVycm9yIG1lc3NhZ2UgaWYgYW55IGFyZSBtaXNzaW5nLlwiLFxuICAgICAgXCJPbiBzdWNjZXNzLCByZXR1cm5zIHRoZSBzdW1tYXJ5UGF0aCB3aGVyZSB0aGUgU1VNTUFSWS5tZCB3YXMgd3JpdHRlbi5cIixcbiAgICAgIFwiSWRlbXBvdGVudCBcdTIwMTQgY2FsbGluZyB3aXRoIHRoZSBzYW1lIHBhcmFtcyB0d2ljZSB3aWxsIHVwc2VydCAoSU5TRVJUIE9SIFJFUExBQ0UpIHdpdGhvdXQgZXJyb3IuXCIsXG4gICAgXSxcbiAgICBwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG4gICAgICAvLyBcdTI1MDBcdTI1MDAgQ29yZSBpZGVudGlmaWNhdGlvbiArIGNvbnRlbnQgKHJlcXVpcmVkKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgIHRhc2tJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJUYXNrIElEIChlLmcuIFQwMSlcIiB9KSxcbiAgICAgIHNsaWNlSWQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiU2xpY2UgSUQgKGUuZy4gUzAxKVwiIH0pLFxuICAgICAgbWlsZXN0b25lSWQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiTWlsZXN0b25lIElEIChlLmcuIE0wMDEpXCIgfSksXG4gICAgICBvbmVMaW5lcjogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJPbmUtbGluZSBzdW1tYXJ5IG9mIHdoYXQgd2FzIGFjY29tcGxpc2hlZFwiIH0pLFxuICAgICAgbmFycmF0aXZlOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkRldGFpbGVkIG5hcnJhdGl2ZSBvZiB3aGF0IGhhcHBlbmVkIGR1cmluZyB0aGUgdGFza1wiIH0pLFxuICAgICAgdmVyaWZpY2F0aW9uOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIldoYXQgd2FzIHZlcmlmaWVkIGFuZCBob3cgXHUyMDE0IGNvbW1hbmRzIHJ1biwgdGVzdHMgcGFzc2VkLCBiZWhhdmlvciBjb25maXJtZWRcIiB9KSxcbiAgICAgIC8vIFx1MjUwMFx1MjUwMCBFbnJpY2htZW50IG1ldGFkYXRhIChvcHRpb25hbCBcdTIwMTQgZGVmYXVsdHMgdG8gZW1wdHkpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgZGV2aWF0aW9uczogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkRldmlhdGlvbnMgZnJvbSB0aGUgdGFzayBwbGFuLCBvciAnTm9uZS4nXCIgfSkpLFxuICAgICAga25vd25Jc3N1ZXM6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJLbm93biBpc3N1ZXMgZGlzY292ZXJlZCBidXQgbm90IGZpeGVkLCBvciAnTm9uZS4nXCIgfSkpLFxuICAgICAga2V5RmlsZXM6IFR5cGUuT3B0aW9uYWwoVHlwZS5BcnJheShUeXBlLlN0cmluZygpLCB7IGRlc2NyaXB0aW9uOiBcIkxpc3Qgb2Yga2V5IGZpbGVzIGNyZWF0ZWQgb3IgbW9kaWZpZWRcIiB9KSksXG4gICAgICBrZXlEZWNpc2lvbnM6IFR5cGUuT3B0aW9uYWwoVHlwZS5BcnJheShUeXBlLlN0cmluZygpLCB7IGRlc2NyaXB0aW9uOiBcIkxpc3Qgb2Yga2V5IGRlY2lzaW9ucyBtYWRlIGR1cmluZyB0aGlzIHRhc2tcIiB9KSksXG4gICAgICBibG9ja2VyRGlzY292ZXJlZDogVHlwZS5PcHRpb25hbChUeXBlLkJvb2xlYW4oeyBkZXNjcmlwdGlvbjogXCJXaGV0aGVyIGEgcGxhbi1pbnZhbGlkYXRpbmcgYmxvY2tlciB3YXMgZGlzY292ZXJlZFwiIH0pKSxcbiAgICAgIC8vIEFEUi0wMTEgUGhhc2UgMjogbWlkLWV4ZWN1dGlvbiBlc2NhbGF0aW9uIFx1MjAxNCBhZ2VudCBhc2tzIHRoZSB1c2VyIHRvIHJlc29sdmUgYW4gYW1iaWd1aXR5LlxuICAgICAgZXNjYWxhdGlvbjogVHlwZS5PcHRpb25hbChUeXBlLk9iamVjdCh7XG4gICAgICAgIHF1ZXN0aW9uOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlRoZSBxdWVzdGlvbiB0aGUgdXNlciBuZWVkcyB0byBhbnN3ZXIgXHUyMDE0IG9uZSBjbGVhciBzZW50ZW5jZS5cIiB9KSxcbiAgICAgICAgb3B0aW9uczogVHlwZS5BcnJheShUeXBlLk9iamVjdCh7XG4gICAgICAgICAgaWQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiU2hvcnQgaWQgKGUuZy4gJ0EnLCAnQicpIHVzZWQgYnkgL2dzZCBlc2NhbGF0ZSByZXNvbHZlLlwiIH0pLFxuICAgICAgICAgIGxhYmVsOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk9uZS1saW5lIGxhYmVsLlwiIH0pLFxuICAgICAgICAgIHRyYWRlb2ZmczogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCIxLTIgc2VudGVuY2VzIG9uIHRoZSB0cmFkZW9mZnMgb2YgdGhpcyBvcHRpb24uXCIgfSksXG4gICAgICAgIH0pLCB7IG1pbkl0ZW1zOiAyLCBtYXhJdGVtczogNCwgZGVzY3JpcHRpb246IFwiMlx1MjAxMzQgb3B0aW9ucyB0aGUgdXNlciBjYW4gY2hvb3NlIGJldHdlZW4uXCIgfSksXG4gICAgICAgIHJlY29tbWVuZGF0aW9uOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk9wdGlvbiBpZCB0aGUgZXhlY3V0b3IgcmVjb21tZW5kcy5cIiB9KSxcbiAgICAgICAgcmVjb21tZW5kYXRpb25SYXRpb25hbGU6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiV2h5IHRoZSByZWNvbW1lbmRhdGlvbiBcdTIwMTQgMVx1MjAxMzIgc2VudGVuY2VzLlwiIH0pLFxuICAgICAgICBjb250aW51ZVdpdGhEZWZhdWx0OiBUeXBlLkJvb2xlYW4oe1xuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIldoZW4gdHJ1ZSwgbG9vcCBjb250aW51ZXMgKGFydGlmYWN0IGxvZ2dlZCBmb3IgbGF0ZXIgcmV2aWV3KS4gV2hlbiBmYWxzZSwgYXV0by1tb2RlIHBhdXNlcyB1bnRpbCB0aGUgdXNlciByZXNvbHZlcyB2aWEgL2dzZCBlc2NhbGF0ZSByZXNvbHZlLlwiLFxuICAgICAgICB9KSxcbiAgICAgIH0sIHsgZGVzY3JpcHRpb246IFwiQURSLTAxMSBQaGFzZSAyOiBvcHRpb25hbCBlc2NhbGF0aW9uIHBheWxvYWQuIE9ubHkgaG9ub3JlZCB3aGVuIHBoYXNlcy5taWRfZXhlY3V0aW9uX2VzY2FsYXRpb24gaXMgdHJ1ZS5cIiB9KSksXG4gICAgICB2ZXJpZmljYXRpb25FdmlkZW5jZTogVHlwZS5PcHRpb25hbChUeXBlLkFycmF5KFxuICAgICAgICBUeXBlLlVuaW9uKFtcbiAgICAgICAgICBUeXBlLk9iamVjdCh7XG4gICAgICAgICAgICBjb21tYW5kOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlZlcmlmaWNhdGlvbiBjb21tYW5kIHRoYXQgd2FzIHJ1blwiIH0pLFxuICAgICAgICAgICAgZXhpdENvZGU6IFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiRXhpdCBjb2RlIG9mIHRoZSBjb21tYW5kXCIgfSksXG4gICAgICAgICAgICB2ZXJkaWN0OiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlBhc3MvZmFpbCB2ZXJkaWN0IChlLmcuICdcdTI3MDUgcGFzcycsICdcdTI3NEMgZmFpbCcpXCIgfSksXG4gICAgICAgICAgICBkdXJhdGlvbk1zOiBUeXBlLk51bWJlcih7IGRlc2NyaXB0aW9uOiBcIkR1cmF0aW9uIG9mIHRoZSBjb21tYW5kIGluIG1pbGxpc2Vjb25kc1wiIH0pLFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiRmFsbGJhY2s6IHZlcmlmaWNhdGlvbiBzdW1tYXJ5IHN0cmluZ1wiIH0pLFxuICAgICAgICBdKSxcbiAgICAgICAgeyBkZXNjcmlwdGlvbjogXCJBcnJheSBvZiB2ZXJpZmljYXRpb24gZXZpZGVuY2UgZW50cmllc1wiIH0sXG4gICAgICApKSxcbiAgICAgIC8vIFNpbmdsZS13cml0ZXIgdjMgYXVkaXQgdHJhaWwgKFN0cmVhbSAyKTogY2FsbGVyLXByb3ZpZGVkIGFjdG9yIGlkZW50aXR5ICsgY2F1c2F0aW9uLlxuICAgICAgYWN0b3JOYW1lOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQ2FsbGVyLXByb3ZpZGVkIGFjdG9yIGlkZW50aXR5IGZvciB0aGUgYXVkaXQgdHJhaWwgKGUuZy4gJ2V4ZWN1dG9yLTAxJywgJ2dzZC1vcmNoZXN0cmF0b3InKVwiIH0pKSxcbiAgICAgIHRyaWdnZXJSZWFzb246IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJDYWxsZXItcHJvdmlkZWQgcmVhc29uIHRoaXMgYWN0aW9uIHdhcyB0cmlnZ2VyZWQgKGUuZy4gJ3Rhc2sgdmVyaWZpZWQgYWZ0ZXIgcmV0cnknKVwiIH0pKSxcbiAgICB9KSxcbiAgICBleGVjdXRlOiB0YXNrQ29tcGxldGVFeGVjdXRlLFxuICB9O1xuXG4gIHBpLnJlZ2lzdGVyVG9vbCh0YXNrQ29tcGxldGVUb29sKTtcbiAgcmVnaXN0ZXJBbGlhcyhwaSwgdGFza0NvbXBsZXRlVG9vbCwgXCJnc2RfY29tcGxldGVfdGFza1wiLCBcImdzZF90YXNrX2NvbXBsZXRlXCIpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBnc2Rfc2xpY2VfY29tcGxldGUgKGdzZF9jb21wbGV0ZV9zbGljZSBhbGlhcykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgY29uc3Qgc2xpY2VDb21wbGV0ZUV4ZWN1dGUgPSBhc3luYyAoX3Rvb2xDYWxsSWQ6IHN0cmluZywgcGFyYW1zOiBhbnksIF9zaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkLCBfb25VcGRhdGU6IHVua25vd24sIF9jdHg6IHVua25vd24pID0+IHtcbiAgICBjb25zdCB7IGV4ZWN1dGVTbGljZUNvbXBsZXRlIH0gPSBhd2FpdCBsb2FkV29ya2Zsb3dFeGVjdXRvcnMoKTtcbiAgICByZXR1cm4gZXhlY3V0ZVNsaWNlQ29tcGxldGUocGFyYW1zLCByZXNvbHZlQ3R4Q3dkKF9jdHgpKTtcbiAgfTtcblxuICBjb25zdCBzbGljZUNvbXBsZXRlVG9vbCA9IHtcbiAgICBuYW1lOiBcImdzZF9zbGljZV9jb21wbGV0ZVwiLFxuICAgIGxhYmVsOiBcIkNvbXBsZXRlIFNsaWNlXCIsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICBcIlJlY29yZCBhIGNvbXBsZXRlZCBzbGljZSB0byB0aGUgR1NEIGRhdGFiYXNlLCByZW5kZXIgU1VNTUFSWS5tZCArIFVBVC5tZCB0byBkaXNrLCBhbmQgdG9nZ2xlIHRoZSByb2FkbWFwIGNoZWNrYm94IFx1MjAxNCBhbGwgaW4gb25lIGF0b21pYyBvcGVyYXRpb24uIFwiICtcbiAgICAgIFwiVmFsaWRhdGVzIGFsbCB0YXNrcyBhcmUgY29tcGxldGUgYmVmb3JlIHByb2NlZWRpbmcuIFdyaXRlcyB0aGUgc2xpY2Ugcm93IGluc2lkZSBhIHRyYW5zYWN0aW9uLCB0aGVuIHBlcmZvcm1zIGZpbGVzeXN0ZW0gd3JpdGVzIG91dHNpZGUgdGhlIHRyYW5zYWN0aW9uLlwiLFxuICAgIHByb21wdFNuaXBwZXQ6IFwiQ29tcGxldGUgYSBHU0Qgc2xpY2UgKERCIHdyaXRlICsgc3VtbWFyeS9VQVQgcmVuZGVyICsgcm9hZG1hcCBjaGVja2JveCB0b2dnbGUpXCIsXG4gICAgcHJvbXB0R3VpZGVsaW5lczogW1xuICAgICAgXCJVc2UgZ3NkX3NsaWNlX2NvbXBsZXRlIChvciBnc2RfY29tcGxldGVfc2xpY2UpIHdoZW4gYWxsIHRhc2tzIGluIGEgc2xpY2UgYXJlIGZpbmlzaGVkIGFuZCB0aGUgc2xpY2UgbmVlZHMgdG8gYmUgcmVjb3JkZWQuXCIsXG4gICAgICBcIkFsbCB0YXNrcyBpbiB0aGUgc2xpY2UgbXVzdCBoYXZlIHN0YXR1cyAnY29tcGxldGUnIFx1MjAxNCB0aGUgaGFuZGxlciB2YWxpZGF0ZXMgdGhpcyBiZWZvcmUgcHJvY2VlZGluZy5cIixcbiAgICAgIFwiT24gc3VjY2VzcywgcmV0dXJucyBzdW1tYXJ5UGF0aCBhbmQgdWF0UGF0aCB3aGVyZSB0aGUgZmlsZXMgd2VyZSB3cml0dGVuLlwiLFxuICAgICAgXCJJZGVtcG90ZW50IFx1MjAxNCBjYWxsaW5nIHdpdGggdGhlIHNhbWUgcGFyYW1zIHR3aWNlIHdpbGwgbm90IGNyYXNoLlwiLFxuICAgIF0sXG4gICAgcGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuICAgICAgLy8gXHUyNTAwXHUyNTAwIENvcmUgaWRlbnRpZmljYXRpb24gKyBjb250ZW50IChyZXF1aXJlZCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBzbGljZUlkOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlNsaWNlIElEIChlLmcuIFMwMSlcIiB9KSxcbiAgICAgIG1pbGVzdG9uZUlkOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk1pbGVzdG9uZSBJRCAoZS5nLiBNMDAxKVwiIH0pLFxuICAgICAgc2xpY2VUaXRsZTogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJUaXRsZSBvZiB0aGUgc2xpY2VcIiB9KSxcbiAgICAgIG9uZUxpbmVyOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk9uZS1saW5lIHN1bW1hcnkgb2Ygd2hhdCB0aGUgc2xpY2UgYWNjb21wbGlzaGVkXCIgfSksXG4gICAgICBuYXJyYXRpdmU6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiRGV0YWlsZWQgbmFycmF0aXZlIG9mIHdoYXQgaGFwcGVuZWQgYWNyb3NzIGFsbCB0YXNrc1wiIH0pLFxuICAgICAgdmVyaWZpY2F0aW9uOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIldoYXQgd2FzIHZlcmlmaWVkIGFjcm9zcyBhbGwgdGFza3NcIiB9KSxcbiAgICAgIHVhdENvbnRlbnQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVUFUIHRlc3QgY29udGVudCAobWFya2Rvd24gYm9keSlcIiB9KSxcbiAgICAgIC8vIFx1MjUwMFx1MjUwMCBFbnJpY2htZW50IG1ldGFkYXRhIChvcHRpb25hbCBcdTIwMTQgZGVmYXVsdHMgdG8gZW1wdHkpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgZGV2aWF0aW9uczogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkRldmlhdGlvbnMgZnJvbSB0aGUgc2xpY2UgcGxhbiwgb3IgJ05vbmUuJ1wiIH0pKSxcbiAgICAgIGtub3duTGltaXRhdGlvbnM6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJLbm93biBsaW1pdGF0aW9ucyBvciBnYXBzLCBvciAnTm9uZS4nXCIgfSkpLFxuICAgICAgZm9sbG93VXBzOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiRm9sbG93LXVwIHdvcmsgZGlzY292ZXJlZCBkdXJpbmcgZXhlY3V0aW9uLCBvciAnTm9uZS4nXCIgfSkpLFxuICAgICAga2V5RmlsZXM6IFR5cGUuT3B0aW9uYWwoVHlwZS5VbmlvbihbVHlwZS5BcnJheShUeXBlLlN0cmluZygpKSwgVHlwZS5TdHJpbmcoKV0sIHsgZGVzY3JpcHRpb246IFwiS2V5IGZpbGVzIGNyZWF0ZWQgb3IgbW9kaWZpZWRcIiB9KSksXG4gICAgICBrZXlEZWNpc2lvbnM6IFR5cGUuT3B0aW9uYWwoVHlwZS5VbmlvbihbVHlwZS5BcnJheShUeXBlLlN0cmluZygpKSwgVHlwZS5TdHJpbmcoKV0sIHsgZGVzY3JpcHRpb246IFwiS2V5IGRlY2lzaW9ucyBtYWRlIGR1cmluZyB0aGlzIHNsaWNlXCIgfSkpLFxuICAgICAgcGF0dGVybnNFc3RhYmxpc2hlZDogVHlwZS5PcHRpb25hbChUeXBlLlVuaW9uKFtUeXBlLkFycmF5KFR5cGUuU3RyaW5nKCkpLCBUeXBlLlN0cmluZygpXSwgeyBkZXNjcmlwdGlvbjogXCJQYXR0ZXJucyBlc3RhYmxpc2hlZCBieSB0aGlzIHNsaWNlXCIgfSkpLFxuICAgICAgb2JzZXJ2YWJpbGl0eVN1cmZhY2VzOiBUeXBlLk9wdGlvbmFsKFR5cGUuVW5pb24oW1R5cGUuQXJyYXkoVHlwZS5TdHJpbmcoKSksIFR5cGUuU3RyaW5nKCldLCB7IGRlc2NyaXB0aW9uOiBcIk9ic2VydmFiaWxpdHkgc3VyZmFjZXMgYWRkZWRcIiB9KSksXG4gICAgICBwcm92aWRlczogVHlwZS5PcHRpb25hbChUeXBlLlVuaW9uKFtUeXBlLkFycmF5KFR5cGUuU3RyaW5nKCkpLCBUeXBlLlN0cmluZygpXSwgeyBkZXNjcmlwdGlvbjogXCJXaGF0IHRoaXMgc2xpY2UgcHJvdmlkZXMgdG8gZG93bnN0cmVhbSBzbGljZXNcIiB9KSksXG4gICAgICByZXF1aXJlbWVudHNTdXJmYWNlZDogVHlwZS5PcHRpb25hbChUeXBlLlVuaW9uKFtUeXBlLkFycmF5KFR5cGUuU3RyaW5nKCkpLCBUeXBlLlN0cmluZygpXSwgeyBkZXNjcmlwdGlvbjogXCJOZXcgcmVxdWlyZW1lbnRzIHN1cmZhY2VkXCIgfSkpLFxuICAgICAgZHJpbGxEb3duUGF0aHM6IFR5cGUuT3B0aW9uYWwoVHlwZS5VbmlvbihbVHlwZS5BcnJheShUeXBlLlN0cmluZygpKSwgVHlwZS5TdHJpbmcoKV0sIHsgZGVzY3JpcHRpb246IFwiUGF0aHMgdG8gdGFzayBzdW1tYXJpZXMgZm9yIGRyaWxsLWRvd25cIiB9KSksXG4gICAgICBhZmZlY3RzOiBUeXBlLk9wdGlvbmFsKFR5cGUuVW5pb24oW1R5cGUuQXJyYXkoVHlwZS5TdHJpbmcoKSksIFR5cGUuU3RyaW5nKCldLCB7IGRlc2NyaXB0aW9uOiBcIkRvd25zdHJlYW0gc2xpY2VzIGFmZmVjdGVkXCIgfSkpLFxuICAgICAgcmVxdWlyZW1lbnRzQWR2YW5jZWQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5BcnJheShcbiAgICAgICAgVHlwZS5VbmlvbihbXG4gICAgICAgICAgVHlwZS5PYmplY3Qoe1xuICAgICAgICAgICAgaWQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiUmVxdWlyZW1lbnQgSURcIiB9KSxcbiAgICAgICAgICAgIGhvdzogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJIb3cgaXQgd2FzIGFkdmFuY2VkXCIgfSksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJGYWxsYmFjazogJ0lEIFx1MjAxNCBob3cnIHN0cmluZ1wiIH0pLFxuICAgICAgICBdKSxcbiAgICAgICAgeyBkZXNjcmlwdGlvbjogXCJSZXF1aXJlbWVudHMgYWR2YW5jZWQgYnkgdGhpcyBzbGljZVwiIH0sXG4gICAgICApKSxcbiAgICAgIHJlcXVpcmVtZW50c1ZhbGlkYXRlZDogVHlwZS5PcHRpb25hbChUeXBlLkFycmF5KFxuICAgICAgICBUeXBlLlVuaW9uKFtcbiAgICAgICAgICBUeXBlLk9iamVjdCh7XG4gICAgICAgICAgICBpZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJSZXF1aXJlbWVudCBJRFwiIH0pLFxuICAgICAgICAgICAgcHJvb2Y6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiV2hhdCBwcm9vZiB2YWxpZGF0ZXMgaXRcIiB9KSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkZhbGxiYWNrOiAnSUQgXHUyMDE0IHByb29mJyBzdHJpbmdcIiB9KSxcbiAgICAgICAgXSksXG4gICAgICAgIHsgZGVzY3JpcHRpb246IFwiUmVxdWlyZW1lbnRzIHZhbGlkYXRlZCBieSB0aGlzIHNsaWNlXCIgfSxcbiAgICAgICkpLFxuICAgICAgcmVxdWlyZW1lbnRzSW52YWxpZGF0ZWQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5BcnJheShcbiAgICAgICAgVHlwZS5VbmlvbihbXG4gICAgICAgICAgVHlwZS5PYmplY3Qoe1xuICAgICAgICAgICAgaWQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiUmVxdWlyZW1lbnQgSURcIiB9KSxcbiAgICAgICAgICAgIHdoYXQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiV2hhdCBjaGFuZ2VkXCIgfSksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJGYWxsYmFjazogJ0lEIFx1MjAxNCB3aGF0JyBzdHJpbmdcIiB9KSxcbiAgICAgICAgXSksXG4gICAgICAgIHsgZGVzY3JpcHRpb246IFwiUmVxdWlyZW1lbnRzIGludmFsaWRhdGVkIG9yIHJlLXNjb3BlZFwiIH0sXG4gICAgICApKSxcbiAgICAgIGZpbGVzTW9kaWZpZWQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5BcnJheShcbiAgICAgICAgVHlwZS5VbmlvbihbXG4gICAgICAgICAgVHlwZS5PYmplY3Qoe1xuICAgICAgICAgICAgcGF0aDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJGaWxlIHBhdGhcIiB9KSxcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIldoYXQgY2hhbmdlZFwiIH0pLFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiRmFsbGJhY2s6IGZpbGUgcGF0aCBzdHJpbmdcIiB9KSxcbiAgICAgICAgXSksXG4gICAgICAgIHsgZGVzY3JpcHRpb246IFwiRmlsZXMgbW9kaWZpZWQgd2l0aCBkZXNjcmlwdGlvbnNcIiB9LFxuICAgICAgKSksXG4gICAgICByZXF1aXJlczogVHlwZS5PcHRpb25hbChUeXBlLkFycmF5KFxuICAgICAgICBUeXBlLlVuaW9uKFtcbiAgICAgICAgICBUeXBlLk9iamVjdCh7XG4gICAgICAgICAgICBzbGljZTogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJEZXBlbmRlbmN5IHNsaWNlIElEXCIgfSksXG4gICAgICAgICAgICBwcm92aWRlczogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJXaGF0IHdhcyBjb25zdW1lZCBmcm9tIGl0XCIgfSksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJGYWxsYmFjazogc2xpY2UgSUQgc3RyaW5nXCIgfSksXG4gICAgICAgIF0pLFxuICAgICAgICB7IGRlc2NyaXB0aW9uOiBcIlVwc3RyZWFtIHNsaWNlIGRlcGVuZGVuY2llcyBjb25zdW1lZFwiIH0sXG4gICAgICApKSxcbiAgICAgIC8vIFNpbmdsZS13cml0ZXIgdjMgYXVkaXQgdHJhaWwgKFN0cmVhbSAyKTogY2FsbGVyLXByb3ZpZGVkIGFjdG9yIGlkZW50aXR5ICsgY2F1c2F0aW9uLlxuICAgICAgYWN0b3JOYW1lOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQ2FsbGVyLXByb3ZpZGVkIGFjdG9yIGlkZW50aXR5IGZvciB0aGUgYXVkaXQgdHJhaWwgKGUuZy4gJ2V4ZWN1dG9yLTAxJywgJ2dzZC1vcmNoZXN0cmF0b3InKVwiIH0pKSxcbiAgICAgIHRyaWdnZXJSZWFzb246IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJDYWxsZXItcHJvdmlkZWQgcmVhc29uIHRoaXMgYWN0aW9uIHdhcyB0cmlnZ2VyZWQgKGUuZy4gJ2FsbCB0YXNrcyB2ZXJpZmllZCcpXCIgfSkpLFxuICAgIH0pLFxuICAgIGV4ZWN1dGU6IHNsaWNlQ29tcGxldGVFeGVjdXRlLFxuICB9O1xuXG4gIHBpLnJlZ2lzdGVyVG9vbChzbGljZUNvbXBsZXRlVG9vbCk7XG4gIHJlZ2lzdGVyQWxpYXMocGksIHNsaWNlQ29tcGxldGVUb29sLCBcImdzZF9jb21wbGV0ZV9zbGljZVwiLCBcImdzZF9zbGljZV9jb21wbGV0ZVwiKTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ3NkX3NraXBfc2xpY2UgKCMzNDc3IC8gIzM0ODcpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIGNvbnN0IHNraXBTbGljZUV4ZWN1dGUgPSBhc3luYyAoX3Rvb2xDYWxsSWQ6IHN0cmluZywgcGFyYW1zOiBhbnksIF9zaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkLCBfb25VcGRhdGU6IHVua25vd24sIF9jdHg6IHVua25vd24pID0+IHtcbiAgICBjb25zdCBiYXNlUGF0aCA9IHJlc29sdmVDdHhDd2QoX2N0eCk7XG4gICAgY29uc3QgZGJBdmFpbGFibGUgPSBhd2FpdCBlbnN1cmVEYk9wZW4oYmFzZVBhdGgpO1xuICAgIGlmICghZGJBdmFpbGFibGUpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBcIkVycm9yOiBHU0QgZGF0YWJhc2UgaXMgbm90IGF2YWlsYWJsZS4gQ2Fubm90IHNraXAgc2xpY2UuXCIgfV0sXG4gICAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInNraXBfc2xpY2VcIiwgZXJyb3I6IFwiZGJfdW5hdmFpbGFibGVcIiB9IGFzIGFueSxcbiAgICAgIH07XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGhhbmRsZVNraXBTbGljZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vdG9vbHMvc2tpcC1zbGljZS5qc1wiKTtcbiAgICAgIGNvbnN0IHsgaW52YWxpZGF0ZVN0YXRlQ2FjaGUgfSA9IGF3YWl0IGltcG9ydChcIi4uL3N0YXRlLmpzXCIpO1xuXG4gICAgICBjb25zdCByZXN1bHQgPSBoYW5kbGVTa2lwU2xpY2Uoe1xuICAgICAgICBtaWxlc3RvbmVJZDogcGFyYW1zLm1pbGVzdG9uZUlkLFxuICAgICAgICBzbGljZUlkOiBwYXJhbXMuc2xpY2VJZCxcbiAgICAgICAgcmVhc29uOiBwYXJhbXMucmVhc29uLFxuICAgICAgfSk7XG5cbiAgICAgIGlmIChyZXN1bHQuZXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYEVycm9yOiAke3Jlc3VsdC5lcnJvcn1gIH1dLFxuICAgICAgICAgIGRldGFpbHM6IHtcbiAgICAgICAgICAgIG9wZXJhdGlvbjogXCJza2lwX3NsaWNlXCIsXG4gICAgICAgICAgICBlcnJvcjogcmVzdWx0LmVycm9yLFxuICAgICAgICAgICAgZXJyb3JDb2RlOiByZXN1bHQuZXJyb3JDb2RlID8/IFwic2tpcF9mYWlsZWRcIixcbiAgICAgICAgICB9IGFzIGFueSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgaW52YWxpZGF0ZVN0YXRlQ2FjaGUoKTtcblxuICAgICAgLy8gUmVidWlsZCBTVEFURS5tZCBzbyBpdCByZWZsZWN0cyB0aGUgc2tpcCBpbW1lZGlhdGVseSAoIzM0NzcpLlxuICAgICAgLy8gV2l0aG91dCB0aGlzLCAvZ3NkIGF1dG8gcmVhZHMgc3RhbGUgU1RBVEUubWQgYW5kIHJlc3VtZXMgdGhlIHNraXBwZWQgc2xpY2UuXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCB7IHJlYnVpbGRTdGF0ZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vZG9jdG9yLmpzXCIpO1xuICAgICAgICBhd2FpdCByZWJ1aWxkU3RhdGUoYmFzZVBhdGgpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGxvZ0Vycm9yKFwidG9vbFwiLCBgc2tpcF9zbGljZSByZWJ1aWxkU3RhdGUgZmFpbGVkOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCwgeyB0b29sOiBcImdzZF9za2lwX3NsaWNlXCIgfSk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHN1ZmZpeCA9IHJlc3VsdC53YXNBbHJlYWR5U2tpcHBlZFxuICAgICAgICA/IHJlc3VsdC50YXNrc1NraXBwZWQgPiAwXG4gICAgICAgICAgPyBgIChhbHJlYWR5IHNraXBwZWQ7IGNhc2NhZGVkICR7cmVzdWx0LnRhc2tzU2tpcHBlZH0gbGVmdG92ZXIgdGFzayhzKSB0byBza2lwcGVkKS5gXG4gICAgICAgICAgOiBcIiAoYWxyZWFkeSBza2lwcGVkOyBubyBwZW5kaW5nIHRhc2tzIHRvIGNhc2NhZGUpLlwiXG4gICAgICAgIDogYCBDYXNjYWRlZCAke3Jlc3VsdC50YXNrc1NraXBwZWR9IHRhc2socykgdG8gc2tpcHBlZC4gQXV0by1tb2RlIHdpbGwgYWR2YW5jZSBwYXN0IHRoaXMgc2xpY2UuYDtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBTa2lwcGVkIHNsaWNlICR7cGFyYW1zLnNsaWNlSWR9ICgke3BhcmFtcy5taWxlc3RvbmVJZH0pLiBSZWFzb246ICR7cGFyYW1zLnJlYXNvbiA/PyBcIlVzZXItZGlyZWN0ZWQgc2tpcFwifS4ke3N1ZmZpeH1gIH1dLFxuICAgICAgICBkZXRhaWxzOiB7XG4gICAgICAgICAgb3BlcmF0aW9uOiBcInNraXBfc2xpY2VcIixcbiAgICAgICAgICBzbGljZUlkOiBwYXJhbXMuc2xpY2VJZCxcbiAgICAgICAgICBtaWxlc3RvbmVJZDogcGFyYW1zLm1pbGVzdG9uZUlkLFxuICAgICAgICAgIHJlYXNvbjogcGFyYW1zLnJlYXNvbixcbiAgICAgICAgICB0YXNrc1NraXBwZWQ6IHJlc3VsdC50YXNrc1NraXBwZWQsXG4gICAgICAgICAgd2FzQWxyZWFkeVNraXBwZWQ6IHJlc3VsdC53YXNBbHJlYWR5U2tpcHBlZCxcbiAgICAgICAgfSBhcyBhbnksXG4gICAgICB9O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgbG9nRXJyb3IoXCJ0b29sXCIsIGBza2lwX3NsaWNlIHRvb2wgZmFpbGVkOiAke21zZ31gLCB7IHRvb2w6IFwiZ3NkX3NraXBfc2xpY2VcIiwgZXJyb3I6IFN0cmluZyhlcnIpIH0pO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBFcnJvciBza2lwcGluZyBzbGljZTogJHttc2d9YCB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwic2tpcF9zbGljZVwiLCBlcnJvcjogbXNnIH0gYXMgYW55LFxuICAgICAgfTtcbiAgICB9XG4gIH07XG5cbiAgcGkucmVnaXN0ZXJUb29sKHtcbiAgICBuYW1lOiBcImdzZF9za2lwX3NsaWNlXCIsXG4gICAgbGFiZWw6IFwiU2tpcCBTbGljZVwiLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJNYXJrIGEgc2xpY2UgYXMgc2tpcHBlZCBzbyBhdXRvLW1vZGUgYWR2YW5jZXMgcGFzdCBpdCB3aXRob3V0IGV4ZWN1dGluZy4gXCIgK1xuICAgICAgXCJOb24tY2xvc2VkIHRhc2tzIHdpdGhpbiB0aGUgc2xpY2UgYXJlIGNhc2NhZGVkIHRvIHNraXBwZWQgc28gbWlsZXN0b25lIGNvbXBsZXRpb24gaXMgbm90IGJsb2NrZWQgYnkgbGVmdG92ZXIgcGVuZGluZyB0YXNrcyAoIzQzNzUpLiBcIiArXG4gICAgICBcIlRoZSBzbGljZSBkYXRhIGlzIHByZXNlcnZlZCBmb3IgcmVmZXJlbmNlLiBUaGUgc3RhdGUgbWFjaGluZSB0cmVhdHMgc2tpcHBlZCBzbGljZXMgbGlrZSBjb21wbGV0ZWQgb25lcyBmb3IgZGVwZW5kZW5jeSBzYXRpc2ZhY3Rpb24uXCIsXG4gICAgcHJvbXB0U25pcHBldDogXCJTa2lwIGEgR1NEIHNsaWNlIChtYXJrIGFzIHNraXBwZWQsIGF1dG8tbW9kZSB3aWxsIGFkdmFuY2UgcGFzdCBpdClcIixcbiAgICBwcm9tcHRHdWlkZWxpbmVzOiBbXG4gICAgICBcIlVzZSBnc2Rfc2tpcF9zbGljZSB3aGVuIGEgc2xpY2Ugc2hvdWxkIGJlIGJ5cGFzc2VkIFx1MjAxNCBkZXNjb3BlZCwgc3VwZXJzZWRlZCwgb3Igbm8gbG9uZ2VyIHJlbGV2YW50LlwiLFxuICAgICAgXCJDYW5ub3Qgc2tpcCBhIHNsaWNlIHRoYXQgaXMgYWxyZWFkeSBjb21wbGV0ZS5cIixcbiAgICAgIFwiU2tpcHBlZCBzbGljZXMgc2F0aXNmeSBkb3duc3RyZWFtIGRlcGVuZGVuY2llcyBqdXN0IGxpa2UgY29tcGxldGVkIHNsaWNlcy5cIixcbiAgICAgIFwiQWxsIHBlbmRpbmcvYWN0aXZlIHRhc2tzIGluIHRoZSBzbGljZSBhcmUgY2FzY2FkZWQgdG8gc2tpcHBlZDsgY29tcGxldGVkIHRhc2tzIGFyZSBuZXZlciBkb3duZ3JhZGVkLlwiLFxuICAgIF0sXG4gICAgcGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuICAgICAgc2xpY2VJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTbGljZSBJRCAoZS5nLiBTMDIpXCIgfSksXG4gICAgICBtaWxlc3RvbmVJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJNaWxlc3RvbmUgSUQgKGUuZy4gTTAwMylcIiB9KSxcbiAgICAgIHJlYXNvbjogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlJlYXNvbiBmb3Igc2tpcHBpbmcgdGhpcyBzbGljZVwiIH0pKSxcbiAgICB9KSxcbiAgICBleGVjdXRlOiBza2lwU2xpY2VFeGVjdXRlLFxuICB9KTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ3NkX2NvbXBsZXRlX21pbGVzdG9uZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBjb25zdCBtaWxlc3RvbmVDb21wbGV0ZUV4ZWN1dGUgPSBhc3luYyAoX3Rvb2xDYWxsSWQ6IHN0cmluZywgcGFyYW1zOiBhbnksIF9zaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkLCBfb25VcGRhdGU6IHVua25vd24sIF9jdHg6IHVua25vd24pID0+IHtcbiAgICBjb25zdCB7IGV4ZWN1dGVDb21wbGV0ZU1pbGVzdG9uZSB9ID0gYXdhaXQgbG9hZFdvcmtmbG93RXhlY3V0b3JzKCk7XG4gICAgcmV0dXJuIGV4ZWN1dGVDb21wbGV0ZU1pbGVzdG9uZShwYXJhbXMsIHJlc29sdmVDdHhDd2QoX2N0eCkpO1xuICB9O1xuXG4gIGNvbnN0IG1pbGVzdG9uZUNvbXBsZXRlVG9vbCA9IHtcbiAgICBuYW1lOiBcImdzZF9jb21wbGV0ZV9taWxlc3RvbmVcIixcbiAgICBsYWJlbDogXCJDb21wbGV0ZSBNaWxlc3RvbmVcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiUmVjb3JkIGEgY29tcGxldGVkIG1pbGVzdG9uZSB0byB0aGUgR1NEIGRhdGFiYXNlLCByZW5kZXIgTUlMRVNUT05FLVNVTU1BUlkubWQgdG8gZGlzayBcdTIwMTQgYWxsIGluIG9uZSBhdG9taWMgb3BlcmF0aW9uLiBcIiArXG4gICAgICBcIlZhbGlkYXRlcyBhbGwgc2xpY2VzIGFyZSBjb21wbGV0ZSBiZWZvcmUgcHJvY2VlZGluZy5cIixcbiAgICBwcm9tcHRTbmlwcGV0OiBcIkNvbXBsZXRlIGEgR1NEIG1pbGVzdG9uZSAoREIgd3JpdGUgKyBzdW1tYXJ5IHJlbmRlcilcIixcbiAgICBwcm9tcHRHdWlkZWxpbmVzOiBbXG4gICAgICBcIlVzZSBnc2RfY29tcGxldGVfbWlsZXN0b25lIHdoZW4gYWxsIHNsaWNlcyBpbiBhIG1pbGVzdG9uZSBhcmUgZmluaXNoZWQgYW5kIHRoZSBtaWxlc3RvbmUgbmVlZHMgdG8gYmUgcmVjb3JkZWQuXCIsXG4gICAgICBcIkFsbCBzbGljZXMgaW4gdGhlIG1pbGVzdG9uZSBtdXN0IGhhdmUgc3RhdHVzICdjb21wbGV0ZScgXHUyMDE0IHRoZSBoYW5kbGVyIHZhbGlkYXRlcyB0aGlzIGJlZm9yZSBwcm9jZWVkaW5nLlwiLFxuICAgICAgXCJ2ZXJpZmljYXRpb25QYXNzZWQgbXVzdCBiZSBleHBsaWNpdGx5IHNldCB0byB0cnVlIFx1MjAxNCB0aGUgaGFuZGxlciByZWplY3RzIGNvbXBsZXRpb24gaWYgdmVyaWZpY2F0aW9uIGRpZCBub3QgcGFzcy5cIixcbiAgICAgIFwiT24gc3VjY2VzcywgcmV0dXJucyBzdW1tYXJ5UGF0aCB3aGVyZSB0aGUgTUlMRVNUT05FLVNVTU1BUlkubWQgd2FzIHdyaXR0ZW4uXCIsXG4gICAgXSxcbiAgICBwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG4gICAgICAvLyBcdTI1MDBcdTI1MDAgQ29yZSBpZGVudGlmaWNhdGlvbiArIGNvbnRlbnQgKHJlcXVpcmVkKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgIG1pbGVzdG9uZUlkOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk1pbGVzdG9uZSBJRCAoZS5nLiBNMDAxKVwiIH0pLFxuICAgICAgdGl0bGU6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiTWlsZXN0b25lIHRpdGxlXCIgfSksXG4gICAgICBvbmVMaW5lcjogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJPbmUtc2VudGVuY2Ugc3VtbWFyeSBvZiB3aGF0IHRoZSBtaWxlc3RvbmUgYWNoaWV2ZWRcIiB9KSxcbiAgICAgIG5hcnJhdGl2ZTogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJEZXRhaWxlZCBuYXJyYXRpdmUgb2Ygd2hhdCBoYXBwZW5lZCBkdXJpbmcgdGhlIG1pbGVzdG9uZVwiIH0pLFxuICAgICAgdmVyaWZpY2F0aW9uUGFzc2VkOiBUeXBlLkJvb2xlYW4oeyBkZXNjcmlwdGlvbjogXCJNdXN0IGJlIHRydWUgXHUyMDE0IGNvbmZpcm1zIHRoYXQgY29kZSBjaGFuZ2UgdmVyaWZpY2F0aW9uLCBzdWNjZXNzIGNyaXRlcmlhLCBhbmQgZGVmaW5pdGlvbiBvZiBkb25lIGNoZWNrcyBhbGwgcGFzc2VkIGJlZm9yZSBjb21wbGV0aW9uXCIgfSksXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgRW5yaWNobWVudCBtZXRhZGF0YSAob3B0aW9uYWwgXHUyMDE0IGRlZmF1bHRzIHRvIGVtcHR5KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgIHN1Y2Nlc3NDcml0ZXJpYVJlc3VsdHM6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJNYXJrZG93biBkZXRhaWxpbmcgaG93IGVhY2ggc3VjY2VzcyBjcml0ZXJpb24gd2FzIG1ldCBvciBub3QgbWV0XCIgfSkpLFxuICAgICAgZGVmaW5pdGlvbk9mRG9uZVJlc3VsdHM6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJNYXJrZG93biBkZXRhaWxpbmcgaG93IGVhY2ggZGVmaW5pdGlvbi1vZi1kb25lIGl0ZW0gd2FzIG1ldFwiIH0pKSxcbiAgICAgIHJlcXVpcmVtZW50T3V0Y29tZXM6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJNYXJrZG93biBkZXRhaWxpbmcgcmVxdWlyZW1lbnQgc3RhdHVzIHRyYW5zaXRpb25zIHdpdGggZXZpZGVuY2VcIiB9KSksXG4gICAgICBrZXlEZWNpc2lvbnM6IFR5cGUuT3B0aW9uYWwoVHlwZS5BcnJheShUeXBlLlN0cmluZygpLCB7IGRlc2NyaXB0aW9uOiBcIktleSBhcmNoaXRlY3R1cmFsL3BhdHRlcm4gZGVjaXNpb25zIG1hZGUgZHVyaW5nIHRoZSBtaWxlc3RvbmVcIiB9KSksXG4gICAgICBrZXlGaWxlczogVHlwZS5PcHRpb25hbChUeXBlLkFycmF5KFR5cGUuU3RyaW5nKCksIHsgZGVzY3JpcHRpb246IFwiS2V5IGZpbGVzIGNyZWF0ZWQgb3IgbW9kaWZpZWQgZHVyaW5nIHRoZSBtaWxlc3RvbmVcIiB9KSksXG4gICAgICBsZXNzb25zTGVhcm5lZDogVHlwZS5PcHRpb25hbChUeXBlLkFycmF5KFR5cGUuU3RyaW5nKCksIHsgZGVzY3JpcHRpb246IFwiTGVzc29ucyBsZWFybmVkIGR1cmluZyB0aGUgbWlsZXN0b25lXCIgfSkpLFxuICAgICAgZm9sbG93VXBzOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiRm9sbG93LXVwIGl0ZW1zIGZvciBmdXR1cmUgbWlsZXN0b25lc1wiIH0pKSxcbiAgICAgIGRldmlhdGlvbnM6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJEZXZpYXRpb25zIGZyb20gdGhlIG9yaWdpbmFsIHBsYW5cIiB9KSksXG4gICAgICAvLyBTaW5nbGUtd3JpdGVyIHYzIGF1ZGl0IHRyYWlsIChTdHJlYW0gMik6IGNhbGxlci1wcm92aWRlZCBhY3RvciBpZGVudGl0eSArIGNhdXNhdGlvbi5cbiAgICAgIGFjdG9yTmFtZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkNhbGxlci1wcm92aWRlZCBhY3RvciBpZGVudGl0eSBmb3IgdGhlIGF1ZGl0IHRyYWlsIChlLmcuICdleGVjdXRvci0wMScsICdnc2Qtb3JjaGVzdHJhdG9yJylcIiB9KSksXG4gICAgICB0cmlnZ2VyUmVhc29uOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQ2FsbGVyLXByb3ZpZGVkIHJlYXNvbiB0aGlzIGFjdGlvbiB3YXMgdHJpZ2dlcmVkIChlLmcuICdtaWxlc3RvbmUgdmFsaWRhdGlvbiBwYXNzZWQnKVwiIH0pKSxcbiAgICB9KSxcbiAgICBleGVjdXRlOiBtaWxlc3RvbmVDb21wbGV0ZUV4ZWN1dGUsXG4gIH07XG5cbiAgcGkucmVnaXN0ZXJUb29sKG1pbGVzdG9uZUNvbXBsZXRlVG9vbCk7XG4gIHJlZ2lzdGVyQWxpYXMocGksIG1pbGVzdG9uZUNvbXBsZXRlVG9vbCwgXCJnc2RfbWlsZXN0b25lX2NvbXBsZXRlXCIsIFwiZ3NkX2NvbXBsZXRlX21pbGVzdG9uZVwiKTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ3NkX3ZhbGlkYXRlX21pbGVzdG9uZSAoZ3NkX21pbGVzdG9uZV92YWxpZGF0ZSBhbGlhcykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgY29uc3QgbWlsZXN0b25lVmFsaWRhdGVFeGVjdXRlID0gYXN5bmMgKF90b29sQ2FsbElkOiBzdHJpbmcsIHBhcmFtczogYW55LCBfc2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCwgX29uVXBkYXRlOiB1bmtub3duLCBfY3R4OiB1bmtub3duKSA9PiB7XG4gICAgY29uc3QgeyBleGVjdXRlVmFsaWRhdGVNaWxlc3RvbmUgfSA9IGF3YWl0IGxvYWRXb3JrZmxvd0V4ZWN1dG9ycygpO1xuICAgIHJldHVybiBleGVjdXRlVmFsaWRhdGVNaWxlc3RvbmUocGFyYW1zLCByZXNvbHZlQ3R4Q3dkKF9jdHgpKTtcbiAgfTtcblxuICBjb25zdCBtaWxlc3RvbmVWYWxpZGF0ZVRvb2wgPSB7XG4gICAgbmFtZTogXCJnc2RfdmFsaWRhdGVfbWlsZXN0b25lXCIsXG4gICAgbGFiZWw6IFwiVmFsaWRhdGUgTWlsZXN0b25lXCIsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICBcIlZhbGlkYXRlIGEgbWlsZXN0b25lIGJlZm9yZSBjb21wbGV0aW9uIFx1MjAxNCBwZXJzaXN0IHZhbGlkYXRpb24gcmVzdWx0cyB0byB0aGUgREIsIHJlbmRlciBWQUxJREFUSU9OLm1kIHRvIGRpc2suIFwiICtcbiAgICAgIFwiUmVjb3JkcyB2ZXJkaWN0IChwYXNzL25lZWRzLWF0dGVudGlvbi9uZWVkcy1yZW1lZGlhdGlvbikgYW5kIHJhdGlvbmFsZS5cIixcbiAgICBwcm9tcHRTbmlwcGV0OiBcIlZhbGlkYXRlIGEgR1NEIG1pbGVzdG9uZSAoREIgd3JpdGUgKyBWQUxJREFUSU9OLm1kIHJlbmRlcilcIixcbiAgICBwcm9tcHRHdWlkZWxpbmVzOiBbXG4gICAgICBcIlVzZSBnc2RfdmFsaWRhdGVfbWlsZXN0b25lIHdoZW4gYWxsIHNsaWNlcyBhcmUgZG9uZSBhbmQgdGhlIG1pbGVzdG9uZSBuZWVkcyB2YWxpZGF0aW9uIGJlZm9yZSBjb21wbGV0aW9uLlwiLFxuICAgICAgXCJQYXJhbWV0ZXJzOiBtaWxlc3RvbmVJZCwgdmVyZGljdCwgcmVtZWRpYXRpb25Sb3VuZCwgc3VjY2Vzc0NyaXRlcmlhQ2hlY2tsaXN0LCBzbGljZURlbGl2ZXJ5QXVkaXQsIGNyb3NzU2xpY2VJbnRlZ3JhdGlvbiwgcmVxdWlyZW1lbnRDb3ZlcmFnZSwgdmVyaWZpY2F0aW9uQ2xhc3NlcyAob3B0aW9uYWwpLCB2ZXJkaWN0UmF0aW9uYWxlLCByZW1lZGlhdGlvblBsYW4gKG9wdGlvbmFsKS5cIixcbiAgICAgIFwiSWYgdmVyZGljdCBpcyAnbmVlZHMtcmVtZWRpYXRpb24nLCBhbHNvIHByb3ZpZGUgcmVtZWRpYXRpb25QbGFuIGFuZCB1c2UgZ3NkX3JlYXNzZXNzX3JvYWRtYXAgdG8gYWRkIHJlbWVkaWF0aW9uIHNsaWNlcyB0byB0aGUgcm9hZG1hcC5cIixcbiAgICAgIFwiT24gc3VjY2VzcywgcmV0dXJucyB2YWxpZGF0aW9uUGF0aCB3aGVyZSBWQUxJREFUSU9OLm1kIHdhcyB3cml0dGVuLlwiLFxuICAgIF0sXG4gICAgcGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuICAgICAgbWlsZXN0b25lSWQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiTWlsZXN0b25lIElEIChlLmcuIE0wMDEpXCIgfSksXG4gICAgICB2ZXJkaWN0OiBTdHJpbmdFbnVtKFtcInBhc3NcIiwgXCJuZWVkcy1hdHRlbnRpb25cIiwgXCJuZWVkcy1yZW1lZGlhdGlvblwiXSwgeyBkZXNjcmlwdGlvbjogXCJWYWxpZGF0aW9uIHZlcmRpY3RcIiB9KSxcbiAgICAgIHJlbWVkaWF0aW9uUm91bmQ6IFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiUmVtZWRpYXRpb24gcm91bmQgKDAgZm9yIGZpcnN0IHZhbGlkYXRpb24pXCIgfSksXG4gICAgICBzdWNjZXNzQ3JpdGVyaWFDaGVja2xpc3Q6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiTWFya2Rvd24gY2hlY2tsaXN0IG9mIHN1Y2Nlc3MgY3JpdGVyaWEgd2l0aCBwYXNzL2ZhaWwgYW5kIGV2aWRlbmNlXCIgfSksXG4gICAgICBzbGljZURlbGl2ZXJ5QXVkaXQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiTWFya2Rvd24gdGFibGUgYXVkaXRpbmcgZWFjaCBzbGljZSdzIGNsYWltZWQgdnMgZGVsaXZlcmVkIG91dHB1dFwiIH0pLFxuICAgICAgY3Jvc3NTbGljZUludGVncmF0aW9uOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk1hcmtkb3duIGRlc2NyaWJpbmcgYW55IGNyb3NzLXNsaWNlIGJvdW5kYXJ5IG1pc21hdGNoZXNcIiB9KSxcbiAgICAgIHJlcXVpcmVtZW50Q292ZXJhZ2U6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiTWFya2Rvd24gZGVzY3JpYmluZyBhbnkgdW5hZGRyZXNzZWQgcmVxdWlyZW1lbnRzXCIgfSksXG4gICAgICB2ZXJpZmljYXRpb25DbGFzc2VzOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiTWFya2Rvd24gZGVzY3JpYmluZyB2ZXJpZmljYXRpb24gY2xhc3MgY29tcGxpYW5jZSBhbmQgZ2Fwc1wiIH0pKSxcbiAgICAgIHZlcmRpY3RSYXRpb25hbGU6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiV2h5IHRoaXMgdmVyZGljdCB3YXMgY2hvc2VuXCIgfSksXG4gICAgICByZW1lZGlhdGlvblBsYW46IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJSZW1lZGlhdGlvbiBwbGFuIChyZXF1aXJlZCBpZiB2ZXJkaWN0IGlzIG5lZWRzLXJlbWVkaWF0aW9uKVwiIH0pKSxcbiAgICB9KSxcbiAgICBleGVjdXRlOiBtaWxlc3RvbmVWYWxpZGF0ZUV4ZWN1dGUsXG4gIH07XG5cbiAgcGkucmVnaXN0ZXJUb29sKG1pbGVzdG9uZVZhbGlkYXRlVG9vbCk7XG4gIHJlZ2lzdGVyQWxpYXMocGksIG1pbGVzdG9uZVZhbGlkYXRlVG9vbCwgXCJnc2RfbWlsZXN0b25lX3ZhbGlkYXRlXCIsIFwiZ3NkX3ZhbGlkYXRlX21pbGVzdG9uZVwiKTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ3NkX3JlcGxhbl9zbGljZSAoZ3NkX3NsaWNlX3JlcGxhbiBhbGlhcykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgY29uc3QgcmVwbGFuU2xpY2VFeGVjdXRlID0gYXN5bmMgKF90b29sQ2FsbElkOiBzdHJpbmcsIHBhcmFtczogYW55LCBfc2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCwgX29uVXBkYXRlOiB1bmtub3duLCBfY3R4OiB1bmtub3duKSA9PiB7XG4gICAgY29uc3QgeyBleGVjdXRlUmVwbGFuU2xpY2UgfSA9IGF3YWl0IGxvYWRXb3JrZmxvd0V4ZWN1dG9ycygpO1xuICAgIHJldHVybiBleGVjdXRlUmVwbGFuU2xpY2UocGFyYW1zLCByZXNvbHZlQ3R4Q3dkKF9jdHgpKTtcbiAgfTtcblxuICBjb25zdCByZXBsYW5TbGljZVRvb2wgPSB7XG4gICAgbmFtZTogXCJnc2RfcmVwbGFuX3NsaWNlXCIsXG4gICAgbGFiZWw6IFwiUmVwbGFuIFNsaWNlXCIsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICBcIlJlcGxhbiBhIHNsaWNlIGFmdGVyIGEgYmxvY2tlciBpcyBkaXNjb3ZlcmVkLiBTdHJ1Y3R1cmFsbHkgZW5mb3JjZXMgcHJlc2VydmF0aW9uIG9mIGNvbXBsZXRlZCB0YXNrcyBcdTIwMTQgXCIgK1xuICAgICAgXCJtdXRhdGlvbnMgdG8gY29tcGxldGVkIHRhc2sgSURzIGFyZSByZWplY3RlZCB3aXRoIGFjdGlvbmFibGUgZXJyb3IgcGF5bG9hZHMuIFdyaXRlcyByZXBsYW4gaGlzdG9yeSB0byBEQiwgXCIgK1xuICAgICAgXCJhcHBsaWVzIHRhc2sgbXV0YXRpb25zLCByZS1yZW5kZXJzIFBMQU4ubWQsIGFuZCByZW5kZXJzIFJFUExBTi5tZC5cIixcbiAgICBwcm9tcHRTbmlwcGV0OiBcIlJlcGxhbiBhIEdTRCBzbGljZSB3aXRoIHN0cnVjdHVyYWwgZW5mb3JjZW1lbnQgb2YgY29tcGxldGVkIHRhc2tzXCIsXG4gICAgcHJvbXB0R3VpZGVsaW5lczogW1xuICAgICAgXCJVc2UgZ3NkX3JlcGxhbl9zbGljZSAoY2Fub25pY2FsKSBvciBnc2Rfc2xpY2VfcmVwbGFuIChhbGlhcykgd2hlbiBhIGJsb2NrZXIgaXMgZGlzY292ZXJlZCBhbmQgdGhlIHNsaWNlIHBsYW4gbmVlZHMgcmV3cml0aW5nLlwiLFxuICAgICAgXCJUaGUgdG9vbCBzdHJ1Y3R1cmFsbHkgZW5mb3JjZXMgdGhhdCBjb21wbGV0ZWQgdGFza3MgY2Fubm90IGJlIHVwZGF0ZWQgb3IgcmVtb3ZlZCBcdTIwMTQgdmlvbGF0aW9ucyByZXR1cm4gc3BlY2lmaWMgZXJyb3IgcGF5bG9hZHMgbmFtaW5nIHRoZSBibG9ja2VkIHRhc2sgSUQuXCIsXG4gICAgICBcIlBhcmFtZXRlcnM6IG1pbGVzdG9uZUlkLCBzbGljZUlkLCBibG9ja2VyVGFza0lkLCBibG9ja2VyRGVzY3JpcHRpb24sIHdoYXRDaGFuZ2VkLCB1cGRhdGVkVGFza3MgKGFycmF5KSwgcmVtb3ZlZFRhc2tJZHMgKGFycmF5KS5cIixcbiAgICAgIFwidXBkYXRlZFRhc2tzIGl0ZW1zOiB0YXNrSWQsIHRpdGxlLCBkZXNjcmlwdGlvbiwgZXN0aW1hdGUsIGZpbGVzLCB2ZXJpZnksIGlucHV0cywgZXhwZWN0ZWRPdXRwdXQuXCIsXG4gICAgXSxcbiAgICBwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG4gICAgICBtaWxlc3RvbmVJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJNaWxlc3RvbmUgSUQgKGUuZy4gTTAwMSlcIiB9KSxcbiAgICAgIHNsaWNlSWQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiU2xpY2UgSUQgKGUuZy4gUzAxKVwiIH0pLFxuICAgICAgYmxvY2tlclRhc2tJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJUYXNrIElEIHRoYXQgZGlzY292ZXJlZCB0aGUgYmxvY2tlclwiIH0pLFxuICAgICAgYmxvY2tlckRlc2NyaXB0aW9uOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkRlc2NyaXB0aW9uIG9mIHRoZSBibG9ja2VyXCIgfSksXG4gICAgICB3aGF0Q2hhbmdlZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTdW1tYXJ5IG9mIHdoYXQgY2hhbmdlZCBpbiB0aGUgcGxhblwiIH0pLFxuICAgICAgdXBkYXRlZFRhc2tzOiBUeXBlLkFycmF5KFxuICAgICAgICBUeXBlLk9iamVjdCh7XG4gICAgICAgICAgdGFza0lkOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlRhc2sgSUQgKGUuZy4gVDAxKVwiIH0pLFxuICAgICAgICAgIHRpdGxlOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlRhc2sgdGl0bGVcIiB9KSxcbiAgICAgICAgICBkZXNjcmlwdGlvbjogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJUYXNrIGRlc2NyaXB0aW9uIC8gc3RlcHMgYmxvY2tcIiB9KSxcbiAgICAgICAgICBlc3RpbWF0ZTogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJUYXNrIGVzdGltYXRlIHN0cmluZ1wiIH0pLFxuICAgICAgICAgIGZpbGVzOiBUeXBlLkFycmF5KFR5cGUuU3RyaW5nKCksIHsgZGVzY3JpcHRpb246IFwiRmlsZXMgbGlrZWx5IHRvdWNoZWRcIiB9KSxcbiAgICAgICAgICB2ZXJpZnk6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVmVyaWZpY2F0aW9uIGNvbW1hbmQgb3IgYmxvY2tcIiB9KSxcbiAgICAgICAgICBpbnB1dHM6IFR5cGUuQXJyYXkoVHlwZS5TdHJpbmcoKSwgeyBkZXNjcmlwdGlvbjogXCJJbnB1dCBmaWxlcyBvciByZWZlcmVuY2VzXCIgfSksXG4gICAgICAgICAgZXhwZWN0ZWRPdXRwdXQ6IFR5cGUuQXJyYXkoVHlwZS5TdHJpbmcoKSwgeyBkZXNjcmlwdGlvbjogXCJFeHBlY3RlZCBvdXRwdXQgZmlsZXMgb3IgYXJ0aWZhY3RzXCIgfSksXG4gICAgICAgIH0pLFxuICAgICAgICB7IGRlc2NyaXB0aW9uOiBcIlRhc2tzIHRvIHVwc2VydCAodXBkYXRlIGV4aXN0aW5nIG9yIGluc2VydCBuZXcpXCIgfSxcbiAgICAgICksXG4gICAgICByZW1vdmVkVGFza0lkczogVHlwZS5BcnJheShUeXBlLlN0cmluZygpLCB7IGRlc2NyaXB0aW9uOiBcIlRhc2sgSURzIHRvIHJlbW92ZSBmcm9tIHRoZSBzbGljZVwiIH0pLFxuICAgICAgLy8gU2luZ2xlLXdyaXRlciB2MyBhdWRpdCB0cmFpbCAoU3RyZWFtIDIpOiBjYWxsZXItcHJvdmlkZWQgYWN0b3IgaWRlbnRpdHkgKyBjYXVzYXRpb24uXG4gICAgICBhY3Rvck5hbWU6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJDYWxsZXItcHJvdmlkZWQgYWN0b3IgaWRlbnRpdHkgZm9yIHRoZSBhdWRpdCB0cmFpbCAoZS5nLiAnZXhlY3V0b3ItMDEnLCAnZ3NkLW9yY2hlc3RyYXRvcicpXCIgfSkpLFxuICAgICAgdHJpZ2dlclJlYXNvbjogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkNhbGxlci1wcm92aWRlZCByZWFzb24gdGhpcyBhY3Rpb24gd2FzIHRyaWdnZXJlZCAoZS5nLiAnYmxvY2tlciBkaXNjb3ZlcmVkIGR1cmluZyBleGVjdXRpb24nKVwiIH0pKSxcbiAgICB9KSxcbiAgICBleGVjdXRlOiByZXBsYW5TbGljZUV4ZWN1dGUsXG4gIH07XG5cbiAgcGkucmVnaXN0ZXJUb29sKHJlcGxhblNsaWNlVG9vbCk7XG4gIHJlZ2lzdGVyQWxpYXMocGksIHJlcGxhblNsaWNlVG9vbCwgXCJnc2Rfc2xpY2VfcmVwbGFuXCIsIFwiZ3NkX3JlcGxhbl9zbGljZVwiKTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ3NkX3JlYXNzZXNzX3JvYWRtYXAgKGdzZF9yb2FkbWFwX3JlYXNzZXNzIGFsaWFzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBjb25zdCByZWFzc2Vzc1JvYWRtYXBFeGVjdXRlID0gYXN5bmMgKF90b29sQ2FsbElkOiBzdHJpbmcsIHBhcmFtczogYW55LCBfc2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCwgX29uVXBkYXRlOiB1bmtub3duLCBfY3R4OiB1bmtub3duKSA9PiB7XG4gICAgY29uc3QgeyBleGVjdXRlUmVhc3Nlc3NSb2FkbWFwIH0gPSBhd2FpdCBsb2FkV29ya2Zsb3dFeGVjdXRvcnMoKTtcbiAgICByZXR1cm4gZXhlY3V0ZVJlYXNzZXNzUm9hZG1hcChwYXJhbXMsIHJlc29sdmVDdHhDd2QoX2N0eCkpO1xuICB9O1xuXG4gIGNvbnN0IHJlYXNzZXNzUm9hZG1hcFRvb2wgPSB7XG4gICAgbmFtZTogXCJnc2RfcmVhc3Nlc3Nfcm9hZG1hcFwiLFxuICAgIGxhYmVsOiBcIlJlYXNzZXNzIFJvYWRtYXBcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiUmVhc3Nlc3MgdGhlIG1pbGVzdG9uZSByb2FkbWFwIGFmdGVyIGEgc2xpY2UgY29tcGxldGVzLiBTdHJ1Y3R1cmFsbHkgZW5mb3JjZXMgcHJlc2VydmF0aW9uIG9mIGNvbXBsZXRlZCBzbGljZXMgXHUyMDE0IFwiICtcbiAgICAgIFwibXV0YXRpb25zIHRvIGNvbXBsZXRlZCBzbGljZSBJRHMgYXJlIHJlamVjdGVkIHdpdGggYWN0aW9uYWJsZSBlcnJvciBwYXlsb2Fkcy4gV3JpdGVzIGFzc2Vzc21lbnQgdG8gREIsIFwiICtcbiAgICAgIFwiYXBwbGllcyBzbGljZSBtdXRhdGlvbnMsIHJlLXJlbmRlcnMgUk9BRE1BUC5tZCwgYW5kIHJlbmRlcnMgQVNTRVNTTUVOVC5tZC5cIixcbiAgICBwcm9tcHRTbmlwcGV0OiBcIlJlYXNzZXNzIGEgR1NEIHJvYWRtYXAgd2l0aCBzdHJ1Y3R1cmFsIGVuZm9yY2VtZW50IG9mIGNvbXBsZXRlZCBzbGljZXNcIixcbiAgICBwcm9tcHRHdWlkZWxpbmVzOiBbXG4gICAgICBcIlVzZSBnc2RfcmVhc3Nlc3Nfcm9hZG1hcCAoY2Fub25pY2FsKSBvciBnc2Rfcm9hZG1hcF9yZWFzc2VzcyAoYWxpYXMpIGFmdGVyIGEgc2xpY2UgY29tcGxldGVzIHRvIHJlYXNzZXNzIHRoZSByb2FkbWFwLlwiLFxuICAgICAgXCJUaGUgdG9vbCBzdHJ1Y3R1cmFsbHkgZW5mb3JjZXMgdGhhdCBjb21wbGV0ZWQgc2xpY2VzIGNhbm5vdCBiZSBtb2RpZmllZCBvciByZW1vdmVkIFx1MjAxNCB2aW9sYXRpb25zIHJldHVybiBzcGVjaWZpYyBlcnJvciBwYXlsb2FkcyBuYW1pbmcgdGhlIGJsb2NrZWQgc2xpY2UgSUQuXCIsXG4gICAgICBcIlBhcmFtZXRlcnM6IG1pbGVzdG9uZUlkLCBjb21wbGV0ZWRTbGljZUlkLCB2ZXJkaWN0LCBhc3Nlc3NtZW50LCBzbGljZUNoYW5nZXMgKG9iamVjdCB3aXRoIG1vZGlmaWVkLCBhZGRlZCwgcmVtb3ZlZCBhcnJheXMpLlwiLFxuICAgICAgXCJzbGljZUNoYW5nZXMubW9kaWZpZWQgaXRlbXM6IHNsaWNlSWQsIHRpdGxlLCByaXNrIChvcHRpb25hbCksIGRlcGVuZHMgKG9wdGlvbmFsKSwgZGVtbyAob3B0aW9uYWwpLlwiLFxuICAgIF0sXG4gICAgcGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuICAgICAgbWlsZXN0b25lSWQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiTWlsZXN0b25lIElEIChlLmcuIE0wMDEpXCIgfSksXG4gICAgICBjb21wbGV0ZWRTbGljZUlkOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlNsaWNlIElEIHRoYXQganVzdCBjb21wbGV0ZWRcIiB9KSxcbiAgICAgIHZlcmRpY3Q6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQXNzZXNzbWVudCB2ZXJkaWN0IChlLmcuICdyb2FkbWFwLWNvbmZpcm1lZCcsICdyb2FkbWFwLWFkanVzdGVkJylcIiB9KSxcbiAgICAgIGFzc2Vzc21lbnQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQXNzZXNzbWVudCB0ZXh0IGV4cGxhaW5pbmcgdGhlIGRlY2lzaW9uXCIgfSksXG4gICAgICBzbGljZUNoYW5nZXM6IFR5cGUuT2JqZWN0KHtcbiAgICAgICAgbW9kaWZpZWQ6IFR5cGUuQXJyYXkoXG4gICAgICAgICAgVHlwZS5PYmplY3Qoe1xuICAgICAgICAgICAgc2xpY2VJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTbGljZSBJRCB0byBtb2RpZnlcIiB9KSxcbiAgICAgICAgICAgIHRpdGxlOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlVwZGF0ZWQgc2xpY2UgdGl0bGVcIiB9KSxcbiAgICAgICAgICAgIHJpc2s6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJVcGRhdGVkIHJpc2sgbGV2ZWxcIiB9KSksXG4gICAgICAgICAgICBkZXBlbmRzOiBUeXBlLk9wdGlvbmFsKFR5cGUuQXJyYXkoVHlwZS5TdHJpbmcoKSwgeyBkZXNjcmlwdGlvbjogXCJVcGRhdGVkIGRlcGVuZGVuY2llc1wiIH0pKSxcbiAgICAgICAgICAgIGRlbW86IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJVcGRhdGVkIGRlbW8gdGV4dFwiIH0pKSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICB7IGRlc2NyaXB0aW9uOiBcIlNsaWNlcyB0byBtb2RpZnlcIiB9LFxuICAgICAgICApLFxuICAgICAgICBhZGRlZDogVHlwZS5BcnJheShcbiAgICAgICAgICBUeXBlLk9iamVjdCh7XG4gICAgICAgICAgICBzbGljZUlkOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk5ldyBzbGljZSBJRFwiIH0pLFxuICAgICAgICAgICAgdGl0bGU6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiTmV3IHNsaWNlIHRpdGxlXCIgfSksXG4gICAgICAgICAgICByaXNrOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiUmlzayBsZXZlbFwiIH0pKSxcbiAgICAgICAgICAgIGRlcGVuZHM6IFR5cGUuT3B0aW9uYWwoVHlwZS5BcnJheShUeXBlLlN0cmluZygpLCB7IGRlc2NyaXB0aW9uOiBcIkRlcGVuZGVuY2llc1wiIH0pKSxcbiAgICAgICAgICAgIGRlbW86IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJEZW1vIHRleHRcIiB9KSksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgeyBkZXNjcmlwdGlvbjogXCJOZXcgc2xpY2VzIHRvIGFkZFwiIH0sXG4gICAgICAgICksXG4gICAgICAgIHJlbW92ZWQ6IFR5cGUuQXJyYXkoVHlwZS5TdHJpbmcoKSwgeyBkZXNjcmlwdGlvbjogXCJTbGljZSBJRHMgdG8gcmVtb3ZlXCIgfSksXG4gICAgICB9LCB7IGRlc2NyaXB0aW9uOiBcIlNsaWNlIGNoYW5nZXMgdG8gYXBwbHlcIiB9KSxcbiAgICAgIC8vIFNpbmdsZS13cml0ZXIgdjMgYXVkaXQgdHJhaWwgKFN0cmVhbSAyKTogY2FsbGVyLXByb3ZpZGVkIGFjdG9yIGlkZW50aXR5ICsgY2F1c2F0aW9uLlxuICAgICAgYWN0b3JOYW1lOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQ2FsbGVyLXByb3ZpZGVkIGFjdG9yIGlkZW50aXR5IGZvciB0aGUgYXVkaXQgdHJhaWwgKGUuZy4gJ2V4ZWN1dG9yLTAxJywgJ2dzZC1vcmNoZXN0cmF0b3InKVwiIH0pKSxcbiAgICAgIHRyaWdnZXJSZWFzb246IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJDYWxsZXItcHJvdmlkZWQgcmVhc29uIHRoaXMgYWN0aW9uIHdhcyB0cmlnZ2VyZWQgKGUuZy4gJ3NsaWNlIFMwMSBjb21wbGV0ZWQsIHJlYXNzZXNzaW5nIHJlbWFpbmluZyByb2FkbWFwJylcIiB9KSksXG4gICAgfSksXG4gICAgZXhlY3V0ZTogcmVhc3Nlc3NSb2FkbWFwRXhlY3V0ZSxcbiAgfTtcblxuICBwaS5yZWdpc3RlclRvb2wocmVhc3Nlc3NSb2FkbWFwVG9vbCk7XG4gIHJlZ2lzdGVyQWxpYXMocGksIHJlYXNzZXNzUm9hZG1hcFRvb2wsIFwiZ3NkX3JvYWRtYXBfcmVhc3Nlc3NcIiwgXCJnc2RfcmVhc3Nlc3Nfcm9hZG1hcFwiKTtcblxuICAvLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ3NkX3Rhc2tfcmVvcGVuIChnc2RfcmVvcGVuX3Rhc2sgYWxpYXMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBTaW5nbGUtd3JpdGVyIHYzLCBTdHJlYW0gMzogcmV2ZXJzaWJpbGl0eSB0b29scyBmb3IgY2xvc2VkIHVuaXRzLlxuXG4gIGNvbnN0IHJlb3BlblRhc2tFeGVjdXRlID0gYXN5bmMgKF90b29sQ2FsbElkOiBzdHJpbmcsIHBhcmFtczogYW55LCBfc2lnbmFsOiBBYm9ydFNpZ25hbCB8IHVuZGVmaW5lZCwgX29uVXBkYXRlOiB1bmtub3duLCBfY3R4OiB1bmtub3duKSA9PiB7XG4gICAgY29uc3QgYmFzZVBhdGggPSByZXNvbHZlQ3R4Q3dkKF9jdHgpO1xuICAgIGNvbnN0IGRiQXZhaWxhYmxlID0gYXdhaXQgZW5zdXJlRGJPcGVuKGJhc2VQYXRoKTtcbiAgICBpZiAoIWRiQXZhaWxhYmxlKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogXCJFcnJvcjogR1NEIGRhdGFiYXNlIGlzIG5vdCBhdmFpbGFibGUuIENhbm5vdCByZW9wZW4gdGFzay5cIiB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwicmVvcGVuX3Rhc2tcIiwgZXJyb3I6IFwiZGJfdW5hdmFpbGFibGVcIiB9IGFzIGFueSxcbiAgICAgIH07XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGhhbmRsZVJlb3BlblRhc2sgfSA9IGF3YWl0IGltcG9ydChcIi4uL3Rvb2xzL3Jlb3Blbi10YXNrLmpzXCIpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUmVvcGVuVGFzayhwYXJhbXMsIGJhc2VQYXRoKTtcbiAgICAgIGlmIChcImVycm9yXCIgaW4gcmVzdWx0KSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBFcnJvciByZW9wZW5pbmcgdGFzazogJHtyZXN1bHQuZXJyb3J9YCB9XSxcbiAgICAgICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJyZW9wZW5fdGFza1wiLCBlcnJvcjogcmVzdWx0LmVycm9yIH0gYXMgYW55LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBSZW9wZW5lZCB0YXNrICR7cmVzdWx0LnRhc2tJZH0gKCR7cmVzdWx0LnNsaWNlSWR9LyR7cmVzdWx0Lm1pbGVzdG9uZUlkfSlgIH1dLFxuICAgICAgICBkZXRhaWxzOiB7XG4gICAgICAgICAgb3BlcmF0aW9uOiBcInJlb3Blbl90YXNrXCIsXG4gICAgICAgICAgbWlsZXN0b25lSWQ6IHJlc3VsdC5taWxlc3RvbmVJZCxcbiAgICAgICAgICBzbGljZUlkOiByZXN1bHQuc2xpY2VJZCxcbiAgICAgICAgICB0YXNrSWQ6IHJlc3VsdC50YXNrSWQsXG4gICAgICAgIH0gYXMgYW55LFxuICAgICAgfTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgIGxvZ0Vycm9yKFwidG9vbFwiLCBgcmVvcGVuX3Rhc2sgdG9vbCBmYWlsZWQ6ICR7bXNnfWAsIHsgdG9vbDogXCJnc2RfdGFza19yZW9wZW5cIiwgZXJyb3I6IFN0cmluZyhlcnIpIH0pO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBFcnJvciByZW9wZW5pbmcgdGFzazogJHttc2d9YCB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwicmVvcGVuX3Rhc2tcIiwgZXJyb3I6IG1zZyB9IGFzIGFueSxcbiAgICAgIH07XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IHJlb3BlblRhc2tUb29sID0ge1xuICAgIG5hbWU6IFwiZ3NkX3Rhc2tfcmVvcGVuXCIsXG4gICAgbGFiZWw6IFwiUmVvcGVuIFRhc2tcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiUmVzZXQgYSBjb21wbGV0ZWQgdGFzayBiYWNrIHRvICdwZW5kaW5nJyBzbyBpdCBjYW4gYmUgcmUtZG9uZS4gQ2xlYW5zIHVwIFNVTU1BUlkubWQgc28gdGhlIERCLWZpbGVzeXN0ZW0gcmVjb25jaWxlciBkb2VzIG5vdCBhdXRvLWNvcnJlY3QgdGhlIHRhc2sgYmFjayB0byBjb21wbGV0ZS4gXCIgK1xuICAgICAgXCJCb3RoIHRoZSBwYXJlbnQgc2xpY2UgYW5kIG1pbGVzdG9uZSBtdXN0IHN0aWxsIGJlIG9wZW4gXHUyMDE0IHVzZSBnc2Rfc2xpY2VfcmVvcGVuIGZpcnN0IGlmIHRoZSBzbGljZSBoYXMgYmVlbiBjbG9zZWQuXCIsXG4gICAgcHJvbXB0U25pcHBldDogXCJSZW9wZW4gYSBjb21wbGV0ZWQgR1NEIHRhc2sgKHJlc2V0cyBzdGF0dXMgdG8gcGVuZGluZywgcmVtb3ZlcyBTVU1NQVJZLm1kKVwiLFxuICAgIHByb21wdEd1aWRlbGluZXM6IFtcbiAgICAgIFwiVXNlIGdzZF90YXNrX3Jlb3BlbiB3aGVuIGEgY29tcGxldGVkIHRhc2sgbmVlZHMgdG8gYmUgcmUtZG9uZSAoZS5nLiB2ZXJpZmljYXRpb24gbWlzc2VkIGEgcmVncmVzc2lvbiwgcmVxdWlyZW1lbnRzIGNoYW5nZWQpLlwiLFxuICAgICAgXCJXaWxsIGZhaWwgaWYgdGhlIHBhcmVudCBzbGljZSBvciBtaWxlc3RvbmUgaXMgYWxyZWFkeSBjbG9zZWQgXHUyMDE0IHJlb3BlbiB0aG9zZSBmaXJzdC5cIixcbiAgICAgIFwiV2lsbCBmYWlsIGlmIHRoZSB0YXNrIGlzIG5vdCBjdXJyZW50bHkgJ2NvbXBsZXRlJyBcdTIwMTQgdGhlcmUgaXMgbm90aGluZyB0byByZW9wZW4uXCIsXG4gICAgICBcIlVzZSB0aGUgY2Fub25pY2FsIG5hbWUgZ3NkX3Rhc2tfcmVvcGVuOyBnc2RfcmVvcGVuX3Rhc2sgaXMgb25seSBhbiBhbGlhcy5cIixcbiAgICBdLFxuICAgIHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcbiAgICAgIG1pbGVzdG9uZUlkOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk1pbGVzdG9uZSBJRCAoZS5nLiBNMDAxKVwiIH0pLFxuICAgICAgc2xpY2VJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTbGljZSBJRCAoZS5nLiBTMDEpXCIgfSksXG4gICAgICB0YXNrSWQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVGFzayBJRCAoZS5nLiBUMDEpXCIgfSksXG4gICAgICByZWFzb246IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJXaHkgdGhlIHRhc2sgaXMgYmVpbmcgcmVvcGVuZWQgKHJlY29yZGVkIGluIHRoZSBhdWRpdCB0cmFpbClcIiB9KSksXG4gICAgICAvLyBTaW5nbGUtd3JpdGVyIHYzIGF1ZGl0IHRyYWlsIChTdHJlYW0gMik6IGNhbGxlci1wcm92aWRlZCBhY3RvciBpZGVudGl0eSArIGNhdXNhdGlvbi5cbiAgICAgIGFjdG9yTmFtZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkNhbGxlci1wcm92aWRlZCBhY3RvciBpZGVudGl0eSBmb3IgdGhlIGF1ZGl0IHRyYWlsIChlLmcuICdleGVjdXRvci0wMScsICdnc2Qtb3JjaGVzdHJhdG9yJylcIiB9KSksXG4gICAgICB0cmlnZ2VyUmVhc29uOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQ2FsbGVyLXByb3ZpZGVkIHJlYXNvbiB0aGlzIGFjdGlvbiB3YXMgdHJpZ2dlcmVkIChlLmcuICdyZWdyZXNzaW9uIGRpc2NvdmVyZWQgcG9zdC1jb21wbGV0aW9uJylcIiB9KSksXG4gICAgfSksXG4gICAgZXhlY3V0ZTogcmVvcGVuVGFza0V4ZWN1dGUsXG4gIH07XG5cbiAgcGkucmVnaXN0ZXJUb29sKHJlb3BlblRhc2tUb29sKTtcbiAgcmVnaXN0ZXJBbGlhcyhwaSwgcmVvcGVuVGFza1Rvb2wsIFwiZ3NkX3Jlb3Blbl90YXNrXCIsIFwiZ3NkX3Rhc2tfcmVvcGVuXCIpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBnc2Rfc2xpY2VfcmVvcGVuIChnc2RfcmVvcGVuX3NsaWNlIGFsaWFzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICBjb25zdCByZW9wZW5TbGljZUV4ZWN1dGUgPSBhc3luYyAoX3Rvb2xDYWxsSWQ6IHN0cmluZywgcGFyYW1zOiBhbnksIF9zaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkLCBfb25VcGRhdGU6IHVua25vd24sIF9jdHg6IHVua25vd24pID0+IHtcbiAgICBjb25zdCBiYXNlUGF0aCA9IHJlc29sdmVDdHhDd2QoX2N0eCk7XG4gICAgY29uc3QgZGJBdmFpbGFibGUgPSBhd2FpdCBlbnN1cmVEYk9wZW4oYmFzZVBhdGgpO1xuICAgIGlmICghZGJBdmFpbGFibGUpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBcIkVycm9yOiBHU0QgZGF0YWJhc2UgaXMgbm90IGF2YWlsYWJsZS4gQ2Fubm90IHJlb3BlbiBzbGljZS5cIiB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwicmVvcGVuX3NsaWNlXCIsIGVycm9yOiBcImRiX3VuYXZhaWxhYmxlXCIgfSBhcyBhbnksXG4gICAgICB9O1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBoYW5kbGVSZW9wZW5TbGljZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vdG9vbHMvcmVvcGVuLXNsaWNlLmpzXCIpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUmVvcGVuU2xpY2UocGFyYW1zLCBiYXNlUGF0aCk7XG4gICAgICBpZiAoXCJlcnJvclwiIGluIHJlc3VsdCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgRXJyb3IgcmVvcGVuaW5nIHNsaWNlOiAke3Jlc3VsdC5lcnJvcn1gIH1dLFxuICAgICAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInJlb3Blbl9zbGljZVwiLCBlcnJvcjogcmVzdWx0LmVycm9yIH0gYXMgYW55LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBSZW9wZW5lZCBzbGljZSAke3Jlc3VsdC5zbGljZUlkfSAoJHtyZXN1bHQubWlsZXN0b25lSWR9KTsgcmVzZXQgJHtyZXN1bHQudGFza3NSZXNldH0gdGFzayhzKSB0byBwZW5kaW5nLmAgfV0sXG4gICAgICAgIGRldGFpbHM6IHtcbiAgICAgICAgICBvcGVyYXRpb246IFwicmVvcGVuX3NsaWNlXCIsXG4gICAgICAgICAgbWlsZXN0b25lSWQ6IHJlc3VsdC5taWxlc3RvbmVJZCxcbiAgICAgICAgICBzbGljZUlkOiByZXN1bHQuc2xpY2VJZCxcbiAgICAgICAgICB0YXNrc1Jlc2V0OiByZXN1bHQudGFza3NSZXNldCxcbiAgICAgICAgfSBhcyBhbnksXG4gICAgICB9O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgbG9nRXJyb3IoXCJ0b29sXCIsIGByZW9wZW5fc2xpY2UgdG9vbCBmYWlsZWQ6ICR7bXNnfWAsIHsgdG9vbDogXCJnc2Rfc2xpY2VfcmVvcGVuXCIsIGVycm9yOiBTdHJpbmcoZXJyKSB9KTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgRXJyb3IgcmVvcGVuaW5nIHNsaWNlOiAke21zZ31gIH1dLFxuICAgICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJyZW9wZW5fc2xpY2VcIiwgZXJyb3I6IG1zZyB9IGFzIGFueSxcbiAgICAgIH07XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IHJlb3BlblNsaWNlVG9vbCA9IHtcbiAgICBuYW1lOiBcImdzZF9zbGljZV9yZW9wZW5cIixcbiAgICBsYWJlbDogXCJSZW9wZW4gU2xpY2VcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiUmVzZXQgYSBjb21wbGV0ZWQgc2xpY2UgYmFjayB0byAnaW5fcHJvZ3Jlc3MnIGFuZCByZXNldCBBTEwgb2YgaXRzIHRhc2tzIGJhY2sgdG8gJ3BlbmRpbmcnLiBDbGVhbnMgdXAgU1VNTUFSWS5tZCAvIFVBVC5tZCBhbmQgcGVyLXRhc2sgc3VtbWFyaWVzLiBcIiArXG4gICAgICBcIlJlb3BlbmluZyBhIHNsaWNlIG1lYW5zIHJlLWRvaW5nIHRoZSB3b3JrIFx1MjAxNCBwYXJ0aWFsIHJlc2V0cyBjcmVhdGUgYW1iaWd1b3VzIHN0YXRlLCBzbyBhbGwgdGFza3MgYXJlIHJlc2V0LlwiLFxuICAgIHByb21wdFNuaXBwZXQ6IFwiUmVvcGVuIGEgY29tcGxldGVkIEdTRCBzbGljZSAocmVzZXRzIGFsbCB0YXNrcyB0byBwZW5kaW5nLCByZW1vdmVzIHN1bW1hcmllcylcIixcbiAgICBwcm9tcHRHdWlkZWxpbmVzOiBbXG4gICAgICBcIlVzZSBnc2Rfc2xpY2VfcmVvcGVuIHdoZW4gYSBjb21wbGV0ZWQgc2xpY2UgbmVlZHMgdG8gYmUgcmUtZG9uZSAoZS5nLiBpbnRlZ3JhdGlvbiBpc3N1ZSBzdXJmYWNlZCwgcmVxdWlyZW1lbnRzIGNoYW5nZWQpLlwiLFxuICAgICAgXCJBbGwgdGFza3Mgd2l0aGluIHRoZSBzbGljZSBhcmUgcmVzZXQgdG8gJ3BlbmRpbmcnIFx1MjAxNCB0aGVyZSBpcyBubyBwYXJ0aWFsLXJlb3Blbi5cIixcbiAgICAgIFwiV2lsbCBmYWlsIGlmIHRoZSBwYXJlbnQgbWlsZXN0b25lIGlzIGFscmVhZHkgY2xvc2VkIFx1MjAxNCByZW9wZW4gdGhlIG1pbGVzdG9uZSBmaXJzdC5cIixcbiAgICAgIFwiV2lsbCBmYWlsIGlmIHRoZSBzbGljZSBpcyBub3QgY3VycmVudGx5ICdjb21wbGV0ZScgXHUyMDE0IHRoZXJlIGlzIG5vdGhpbmcgdG8gcmVvcGVuLlwiLFxuICAgICAgXCJVc2UgdGhlIGNhbm9uaWNhbCBuYW1lIGdzZF9zbGljZV9yZW9wZW47IGdzZF9yZW9wZW5fc2xpY2UgaXMgb25seSBhbiBhbGlhcy5cIixcbiAgICBdLFxuICAgIHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcbiAgICAgIG1pbGVzdG9uZUlkOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk1pbGVzdG9uZSBJRCAoZS5nLiBNMDAxKVwiIH0pLFxuICAgICAgc2xpY2VJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTbGljZSBJRCAoZS5nLiBTMDEpXCIgfSksXG4gICAgICByZWFzb246IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJXaHkgdGhlIHNsaWNlIGlzIGJlaW5nIHJlb3BlbmVkIChyZWNvcmRlZCBpbiB0aGUgYXVkaXQgdHJhaWwpXCIgfSkpLFxuICAgICAgLy8gU2luZ2xlLXdyaXRlciB2MyBhdWRpdCB0cmFpbCAoU3RyZWFtIDIpOiBjYWxsZXItcHJvdmlkZWQgYWN0b3IgaWRlbnRpdHkgKyBjYXVzYXRpb24uXG4gICAgICBhY3Rvck5hbWU6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJDYWxsZXItcHJvdmlkZWQgYWN0b3IgaWRlbnRpdHkgZm9yIHRoZSBhdWRpdCB0cmFpbCAoZS5nLiAnZXhlY3V0b3ItMDEnLCAnZ3NkLW9yY2hlc3RyYXRvcicpXCIgfSkpLFxuICAgICAgdHJpZ2dlclJlYXNvbjogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkNhbGxlci1wcm92aWRlZCByZWFzb24gdGhpcyBhY3Rpb24gd2FzIHRyaWdnZXJlZCAoZS5nLiAnY3Jvc3Mtc2xpY2UgcmVncmVzc2lvbiBkaXNjb3ZlcmVkJylcIiB9KSksXG4gICAgfSksXG4gICAgZXhlY3V0ZTogcmVvcGVuU2xpY2VFeGVjdXRlLFxuICB9O1xuXG4gIHBpLnJlZ2lzdGVyVG9vbChyZW9wZW5TbGljZVRvb2wpO1xuICByZWdpc3RlckFsaWFzKHBpLCByZW9wZW5TbGljZVRvb2wsIFwiZ3NkX3Jlb3Blbl9zbGljZVwiLCBcImdzZF9zbGljZV9yZW9wZW5cIik7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGdzZF9taWxlc3RvbmVfcmVvcGVuIChnc2RfcmVvcGVuX21pbGVzdG9uZSBhbGlhcykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgY29uc3QgcmVvcGVuTWlsZXN0b25lRXhlY3V0ZSA9IGFzeW5jIChfdG9vbENhbGxJZDogc3RyaW5nLCBwYXJhbXM6IGFueSwgX3NpZ25hbDogQWJvcnRTaWduYWwgfCB1bmRlZmluZWQsIF9vblVwZGF0ZTogdW5rbm93biwgX2N0eDogdW5rbm93bikgPT4ge1xuICAgIGNvbnN0IGJhc2VQYXRoID0gcmVzb2x2ZUN0eEN3ZChfY3R4KTtcbiAgICBjb25zdCBkYkF2YWlsYWJsZSA9IGF3YWl0IGVuc3VyZURiT3BlbihiYXNlUGF0aCk7XG4gICAgaWYgKCFkYkF2YWlsYWJsZSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IFwiRXJyb3I6IEdTRCBkYXRhYmFzZSBpcyBub3QgYXZhaWxhYmxlLiBDYW5ub3QgcmVvcGVuIG1pbGVzdG9uZS5cIiB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwicmVvcGVuX21pbGVzdG9uZVwiLCBlcnJvcjogXCJkYl91bmF2YWlsYWJsZVwiIH0gYXMgYW55LFxuICAgICAgfTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgaGFuZGxlUmVvcGVuTWlsZXN0b25lIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi90b29scy9yZW9wZW4tbWlsZXN0b25lLmpzXCIpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUmVvcGVuTWlsZXN0b25lKHBhcmFtcywgYmFzZVBhdGgpO1xuICAgICAgaWYgKFwiZXJyb3JcIiBpbiByZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYEVycm9yIHJlb3BlbmluZyBtaWxlc3RvbmU6ICR7cmVzdWx0LmVycm9yfWAgfV0sXG4gICAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwicmVvcGVuX21pbGVzdG9uZVwiLCBlcnJvcjogcmVzdWx0LmVycm9yIH0gYXMgYW55LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBSZW9wZW5lZCBtaWxlc3RvbmUgJHtyZXN1bHQubWlsZXN0b25lSWR9OyByZXNldCAke3Jlc3VsdC5zbGljZXNSZXNldH0gc2xpY2UocykgYW5kICR7cmVzdWx0LnRhc2tzUmVzZXR9IHRhc2socykuYCB9XSxcbiAgICAgICAgZGV0YWlsczoge1xuICAgICAgICAgIG9wZXJhdGlvbjogXCJyZW9wZW5fbWlsZXN0b25lXCIsXG4gICAgICAgICAgbWlsZXN0b25lSWQ6IHJlc3VsdC5taWxlc3RvbmVJZCxcbiAgICAgICAgICBzbGljZXNSZXNldDogcmVzdWx0LnNsaWNlc1Jlc2V0LFxuICAgICAgICAgIHRhc2tzUmVzZXQ6IHJlc3VsdC50YXNrc1Jlc2V0LFxuICAgICAgICB9IGFzIGFueSxcbiAgICAgIH07XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICBsb2dFcnJvcihcInRvb2xcIiwgYHJlb3Blbl9taWxlc3RvbmUgdG9vbCBmYWlsZWQ6ICR7bXNnfWAsIHsgdG9vbDogXCJnc2RfbWlsZXN0b25lX3Jlb3BlblwiLCBlcnJvcjogU3RyaW5nKGVycikgfSk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYEVycm9yIHJlb3BlbmluZyBtaWxlc3RvbmU6ICR7bXNnfWAgfV0sXG4gICAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInJlb3Blbl9taWxlc3RvbmVcIiwgZXJyb3I6IG1zZyB9IGFzIGFueSxcbiAgICAgIH07XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IHJlb3Blbk1pbGVzdG9uZVRvb2wgPSB7XG4gICAgbmFtZTogXCJnc2RfbWlsZXN0b25lX3Jlb3BlblwiLFxuICAgIGxhYmVsOiBcIlJlb3BlbiBNaWxlc3RvbmVcIixcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgIFwiUmVzZXQgYSBjbG9zZWQgbWlsZXN0b25lIGJhY2sgdG8gJ2FjdGl2ZScsIGFsbCBvZiBpdHMgc2xpY2VzIHRvICdpbl9wcm9ncmVzcycsIGFuZCBhbGwgdGFza3MgdG8gJ3BlbmRpbmcnLiBcIiArXG4gICAgICBcIkNsZWFucyB1cCBNSUxFU1RPTkUtU1VNTUFSWS5tZCwgc2xpY2Ugc3VtbWFyaWVzLCBhbmQgdGFzayBzdW1tYXJpZXMgc28gdGhlIERCLWZpbGVzeXN0ZW0gcmVjb25jaWxlciBkb2VzIG5vdCBhdXRvLWNvcnJlY3Qgc3RhdHVzIGJhY2sgdG8gY29tcGxldGUuXCIsXG4gICAgcHJvbXB0U25pcHBldDogXCJSZW9wZW4gYSBjbG9zZWQgR1NEIG1pbGVzdG9uZSAocmVzZXRzIHNsaWNlcyBhbmQgdGFza3MsIHJlbW92ZXMgc3VtbWFyaWVzKVwiLFxuICAgIHByb21wdEd1aWRlbGluZXM6IFtcbiAgICAgIFwiVXNlIGdzZF9taWxlc3RvbmVfcmVvcGVuIHdoZW4gYSBjbG9zZWQgbWlsZXN0b25lIG5lZWRzIHRvIGJlIHJlLWRvbmUgKGUuZy4gdmFsaWRhdGlvbiBmYWlsdXJlIHN1cmZhY2VkIGFmdGVyIGNsb3N1cmUpLlwiLFxuICAgICAgXCJBbGwgc2xpY2VzIHJlc2V0IHRvICdpbl9wcm9ncmVzcycgYW5kIGFsbCB0YXNrcyByZXNldCB0byAncGVuZGluZycgXHUyMDE0IG5vIHBhcnRpYWwgcmVvcGVuLlwiLFxuICAgICAgXCJXaWxsIGZhaWwgaWYgdGhlIG1pbGVzdG9uZSBpcyBub3QgY3VycmVudGx5IGNsb3NlZCBcdTIwMTQgdGhlcmUgaXMgbm90aGluZyB0byByZW9wZW4uXCIsXG4gICAgICBcIlVzZSB0aGUgY2Fub25pY2FsIG5hbWUgZ3NkX21pbGVzdG9uZV9yZW9wZW47IGdzZF9yZW9wZW5fbWlsZXN0b25lIGlzIG9ubHkgYW4gYWxpYXMuXCIsXG4gICAgXSxcbiAgICBwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG4gICAgICBtaWxlc3RvbmVJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJNaWxlc3RvbmUgSUQgKGUuZy4gTTAwMSlcIiB9KSxcbiAgICAgIHJlYXNvbjogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIldoeSB0aGUgbWlsZXN0b25lIGlzIGJlaW5nIHJlb3BlbmVkIChyZWNvcmRlZCBpbiB0aGUgYXVkaXQgdHJhaWwpXCIgfSkpLFxuICAgICAgLy8gU2luZ2xlLXdyaXRlciB2MyBhdWRpdCB0cmFpbCAoU3RyZWFtIDIpOiBjYWxsZXItcHJvdmlkZWQgYWN0b3IgaWRlbnRpdHkgKyBjYXVzYXRpb24uXG4gICAgICBhY3Rvck5hbWU6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJDYWxsZXItcHJvdmlkZWQgYWN0b3IgaWRlbnRpdHkgZm9yIHRoZSBhdWRpdCB0cmFpbCAoZS5nLiAnZXhlY3V0b3ItMDEnLCAnZ3NkLW9yY2hlc3RyYXRvcicpXCIgfSkpLFxuICAgICAgdHJpZ2dlclJlYXNvbjogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkNhbGxlci1wcm92aWRlZCByZWFzb24gdGhpcyBhY3Rpb24gd2FzIHRyaWdnZXJlZCAoZS5nLiAncG9zdC1jbG9zdXJlIHZhbGlkYXRpb24gZmFpbHVyZScpXCIgfSkpLFxuICAgIH0pLFxuICAgIGV4ZWN1dGU6IHJlb3Blbk1pbGVzdG9uZUV4ZWN1dGUsXG4gIH07XG5cbiAgcGkucmVnaXN0ZXJUb29sKHJlb3Blbk1pbGVzdG9uZVRvb2wpO1xuICByZWdpc3RlckFsaWFzKHBpLCByZW9wZW5NaWxlc3RvbmVUb29sLCBcImdzZF9yZW9wZW5fbWlsZXN0b25lXCIsIFwiZ3NkX21pbGVzdG9uZV9yZW9wZW5cIik7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGdzZF9zYXZlX2dhdGVfcmVzdWx0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIGNvbnN0IHNhdmVHYXRlUmVzdWx0RXhlY3V0ZSA9IGFzeW5jIChfdG9vbENhbGxJZDogc3RyaW5nLCBwYXJhbXM6IGFueSwgX3NpZ25hbDogQWJvcnRTaWduYWwgfCB1bmRlZmluZWQsIF9vblVwZGF0ZTogdW5rbm93biwgX2N0eDogdW5rbm93bikgPT4ge1xuICAgIGNvbnN0IHsgZXhlY3V0ZVNhdmVHYXRlUmVzdWx0IH0gPSBhd2FpdCBsb2FkV29ya2Zsb3dFeGVjdXRvcnMoKTtcbiAgICByZXR1cm4gZXhlY3V0ZVNhdmVHYXRlUmVzdWx0KHBhcmFtcywgcmVzb2x2ZUN0eEN3ZChfY3R4KSk7XG4gIH07XG5cbiAgY29uc3Qgc2F2ZUdhdGVSZXN1bHRUb29sID0ge1xuICAgIG5hbWU6IFwiZ3NkX3NhdmVfZ2F0ZV9yZXN1bHRcIixcbiAgICBsYWJlbDogXCJTYXZlIEdhdGUgUmVzdWx0XCIsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICBcIlNhdmUgdGhlIHJlc3VsdCBvZiBhIHF1YWxpdHkgZ2F0ZSBldmFsdWF0aW9uIChRMy1ROCBvciBNVjAxLU1WMDQpIHRvIHRoZSBHU0QgZGF0YWJhc2UuIFwiICtcbiAgICAgIFwiQ2FsbGVkIGJ5IGdhdGUgZXZhbHVhdGlvbiBzdWItYWdlbnRzIGFmdGVyIGFuYWx5emluZyBhIHNwZWNpZmljIHF1YWxpdHkgcXVlc3Rpb24uXCIsXG4gICAgcHJvbXB0U25pcHBldDogXCJTYXZlIHF1YWxpdHkgZ2F0ZSBldmFsdWF0aW9uIHJlc3VsdCAodmVyZGljdCwgcmF0aW9uYWxlLCBmaW5kaW5ncylcIixcbiAgICBwcm9tcHRHdWlkZWxpbmVzOiBbXG4gICAgICBcIlVzZSBnc2Rfc2F2ZV9nYXRlX3Jlc3VsdCBhZnRlciBldmFsdWF0aW5nIGEgcXVhbGl0eSBnYXRlIHF1ZXN0aW9uLlwiLFxuICAgICAgXCJnYXRlSWQgbXVzdCBiZSBvbmUgb2Y6IFEzLCBRNCwgUTUsIFE2LCBRNywgUTgsIE1WMDEsIE1WMDIsIE1WMDMsIE1WMDQuXCIsXG4gICAgICBcInZlcmRpY3QgbXVzdCBiZTogcGFzcyAobm8gY29uY2VybnMpLCBmbGFnIChjb25jZXJucyBmb3VuZCksIG9yIG9taXR0ZWQgKG5vdCBhcHBsaWNhYmxlKS5cIixcbiAgICAgIFwicmF0aW9uYWxlIHNob3VsZCBiZSBhIG9uZS1zZW50ZW5jZSBqdXN0aWZpY2F0aW9uIGZvciB0aGUgdmVyZGljdC5cIixcbiAgICAgIFwiZmluZGluZ3Mgc2hvdWxkIGNvbnRhaW4gZGV0YWlsZWQgbWFya2Rvd24gYW5hbHlzaXMgKG9yIGVtcHR5IHN0cmluZyBpZiBvbWl0dGVkKS5cIixcbiAgICBdLFxuICAgIHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcbiAgICAgIG1pbGVzdG9uZUlkOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk1pbGVzdG9uZSBJRCAoZS5nLiBNMDAxKVwiIH0pLFxuICAgICAgc2xpY2VJZDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTbGljZSBJRCAoZS5nLiBTMDEpXCIgfSksXG4gICAgICBnYXRlSWQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiR2F0ZSBJRDogUTMsIFE0LCBRNSwgUTYsIFE3LCBROCwgTVYwMSwgTVYwMiwgTVYwMywgb3IgTVYwNFwiIH0pLFxuICAgICAgdGFza0lkOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVGFzayBJRCBmb3IgdGFzay1zY29wZWQgZ2F0ZXMgKFE1L1E2L1E3KVwiIH0pKSxcbiAgICAgIHZlcmRpY3Q6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwicGFzcywgZmxhZywgb3Igb21pdHRlZFwiIH0pLFxuICAgICAgcmF0aW9uYWxlOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk9uZS1zZW50ZW5jZSBqdXN0aWZpY2F0aW9uXCIgfSksXG4gICAgICBmaW5kaW5nczogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkRldGFpbGVkIG1hcmtkb3duIGZpbmRpbmdzXCIgfSkpLFxuICAgIH0pLFxuICAgIGV4ZWN1dGU6IHNhdmVHYXRlUmVzdWx0RXhlY3V0ZSxcbiAgICByZW5kZXJDYWxsKGFyZ3M6IGFueSwgdGhlbWU6IGFueSkge1xuICAgICAgbGV0IHRleHQgPSB0aGVtZS5mZyhcInRvb2xUaXRsZVwiLCB0aGVtZS5ib2xkKFwic2F2ZV9nYXRlX3Jlc3VsdCBcIikpO1xuICAgICAgdGV4dCArPSB0aGVtZS5mZyhcImFjY2VudFwiLCBhcmdzLmdhdGVJZCA/PyBcIlwiKTtcbiAgICAgIHRleHQgKz0gdGhlbWUuZmcoXCJkaW1cIiwgYCBcdTIxOTIgJHthcmdzLnZlcmRpY3QgPz8gXCJcIn1gKTtcbiAgICAgIHJldHVybiBuZXcgVGV4dCh0ZXh0LCAwLCAwKTtcbiAgICB9LFxuICAgIC8qKlxuICAgICAqIFJlbmRlciB0aGUgc2F2ZV9nYXRlX3Jlc3VsdCB0b29sIG91dHB1dCBmb3IgdGhlIFRVSS5cbiAgICAgKlxuICAgICAqIFByZWZlcnMgc3RydWN0dXJlZCBmaWVsZHMsIGJ1dCBmYWxscyBiYWNrIHRvIGBjb250ZW50WzBdLnRleHRgIHdoZW4gdGhlXG4gICAgICogc3RydWN0dXJlZCBwYXlsb2FkIGlzIGVtcHR5LiBEZWZlbnNpdmU6IHRoZSBzdHJ1Y3R1cmFsIGZpeCBvbiB0aGlzXG4gICAgICogYnJhbmNoIHBsdW1icyBgZGV0YWlsc2AgdGhyb3VnaCBNQ1AgdmlhIGBzdHJ1Y3R1cmVkQ29udGVudGAsIGJ1dCBvbGRlclxuICAgICAqIGhvc3RzLCBhIGZ1dHVyZSBoYW5kbGVyIHRoYXQgZm9yZ2V0cyBgc3RydWN0dXJlZENvbnRlbnRgLCBvciBhbnkgZHJvcFxuICAgICAqIG9mIG5vbi1zdGFuZGFyZCByZXR1cm4gZmllbGRzIHdvdWxkIG90aGVyd2lzZSByZW5kZXIgYXNcbiAgICAgKiBcInVuZGVmaW5lZDogdW5kZWZpbmVkXCIuIFNhbWUgZmFsbGJhY2sgYXBwbGllcyB0byBlcnJvciByZW5kZXJpbmcsIGFuZFxuICAgICAqIHdlIHN0cmlwIGEgbGVhZGluZyBgRXJyb3I6YCBmcm9tIHRoZSBmYWxsYmFjayB0ZXh0IHRvIGF2b2lkIHByb2R1Y2luZ1xuICAgICAqIGBFcnJvcjogRXJyb3I6IC4uLmAuXG4gICAgICovXG4gICAgcmVuZGVyUmVzdWx0KHJlc3VsdDogYW55LCBfb3B0aW9uczogYW55LCB0aGVtZTogYW55KSB7XG4gICAgICBjb25zdCBkID0gcmVhZERldGFpbHMocmVzdWx0KTtcbiAgICAgIGlmIChyZXN1bHQuaXNFcnJvciB8fCBkPy5lcnJvcikge1xuICAgICAgICBjb25zdCByYXdNc2cgPSBkPy5lcnJvciA/PyByZXN1bHQuY29udGVudD8uWzBdPy50ZXh0ID8/IFwidW5rbm93blwiO1xuICAgICAgICBjb25zdCBtc2cgPSByYXdNc2cucmVwbGFjZSgvXlxccypFcnJvcjpcXHMqL2ksIFwiXCIpO1xuICAgICAgICByZXR1cm4gbmV3IFRleHQodGhlbWUuZmcoXCJlcnJvclwiLCBgRXJyb3I6ICR7bXNnfWApLCAwLCAwKTtcbiAgICAgIH1cbiAgICAgIGlmICghZD8uZ2F0ZUlkIHx8ICFkPy52ZXJkaWN0KSB7XG4gICAgICAgIGNvbnN0IHRleHQgPSByZXN1bHQuY29udGVudD8uWzBdPy50ZXh0ID8/IFwiR2F0ZSByZXN1bHQgc2F2ZWRcIjtcbiAgICAgICAgcmV0dXJuIG5ldyBUZXh0KHRoZW1lLmZnKFwic3VjY2Vzc1wiLCB0ZXh0KSwgMCwgMCk7XG4gICAgICB9XG4gICAgICBjb25zdCBjb2xvciA9IGQudmVyZGljdCA9PT0gXCJmbGFnXCIgPyBcIndhcm5pbmdcIiA6IFwic3VjY2Vzc1wiO1xuICAgICAgcmV0dXJuIG5ldyBUZXh0KHRoZW1lLmZnKGNvbG9yLCBgJHtkLmdhdGVJZH06ICR7ZC52ZXJkaWN0fWApLCAwLCAwKTtcbiAgICB9LFxuICB9O1xuXG4gIHBpLnJlZ2lzdGVyVG9vbChzYXZlR2F0ZVJlc3VsdFRvb2wpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsU0FBUyxZQUFZO0FBRXJCLFNBQVMsWUFBWTtBQUVyQixTQUFTLG1DQUFtQztBQUM1QyxTQUFTLGNBQWMscUJBQXFCO0FBQzVDLFNBQVMsdUJBQXVCLDZDQUE2QztBQUM3RSxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLGdCQUFnQjtBQUV6QixTQUFTLGdDQUFnQztBQUV6QyxlQUFlLHdCQUF1RjtBQUNwRyxTQUFPLE9BQU8scUNBQXFDO0FBQ3JEO0FBUUEsU0FBUyxjQUFjLElBQWtCLFNBQWMsV0FBbUIsZUFBNkI7QUFDckcsUUFBTSxVQUFVLE9BQU8sUUFBUSxZQUFZLGFBQ3ZDLFVBQVUsU0FBZ0I7QUFDeEIsNkJBQXlCLHFCQUFxQjtBQUM5QyxXQUFPLFFBQVEsUUFBUSxHQUFHLElBQUk7QUFBQSxFQUNoQyxJQUNBLFFBQVE7QUFFWixLQUFHLGFBQWE7QUFBQSxJQUNkLEdBQUc7QUFBQSxJQUNILE1BQU07QUFBQSxJQUNOLGFBQWEsUUFBUSxjQUFjLGVBQWUsYUFBYTtBQUFBLElBQy9ELGtCQUFrQixDQUFDLGFBQWEsYUFBYSxvQ0FBK0I7QUFBQSxJQUM1RTtBQUFBLEVBQ0YsQ0FBQztBQUNIO0FBRUEsU0FBUywwQkFBMEIsV0FBbUIsVUFBOEg7QUFDbEwsUUFBTSxRQUFRLHNDQUFzQyxzQkFBc0IsUUFBUSxHQUFHLGNBQWM7QUFDbkcsTUFBSSxDQUFDLE1BQU0sTUFBTyxRQUFPO0FBQ3pCLFNBQU87QUFBQSxJQUNMLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLFNBQVMsU0FBUyxpQkFBaUIsTUFBTSxVQUFVLDRCQUE0QixHQUFHLENBQUM7QUFBQSxJQUNuSCxTQUFTLEVBQUUsV0FBVyxPQUFPLDhCQUE4QjtBQUFBLElBQzNELFNBQVM7QUFBQSxFQUNYO0FBQ0Y7QUFXQSxTQUFTLFlBQVksUUFBa0I7QUFDckMsU0FBTyxRQUFRLFdBQVcsUUFBUTtBQUNwQztBQUVPLFNBQVMsZ0JBQWdCLElBQXdCO0FBR3RELFFBQU0sc0JBQXNCLE9BQU8sYUFBcUIsUUFBYSxTQUFrQyxXQUFvQixTQUFrQjtBQUMzSSxVQUFNLFdBQVcsY0FBYyxJQUFJO0FBQ25DLFVBQU0sY0FBYyxNQUFNLGFBQWEsUUFBUTtBQUMvQyxRQUFJLENBQUMsYUFBYTtBQUNoQixhQUFPO0FBQUEsUUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0sOERBQThELENBQUM7QUFBQSxRQUN4RyxTQUFTLEVBQUUsV0FBVyxpQkFBaUIsT0FBTyxpQkFBaUI7QUFBQSxNQUNqRTtBQUFBLElBQ0Y7QUFDQSxRQUFJO0FBQ0YsWUFBTSxFQUFFLGlCQUFpQixJQUFJLE1BQU0sT0FBTyxpQkFBaUI7QUFDM0QsWUFBTSxFQUFFLEdBQUcsSUFBSSxNQUFNO0FBQUEsUUFDbkI7QUFBQSxVQUNFLE9BQU8sT0FBTztBQUFBLFVBQ2QsVUFBVSxPQUFPO0FBQUEsVUFDakIsUUFBUSxPQUFPO0FBQUEsVUFDZixXQUFXLE9BQU87QUFBQSxVQUNsQixXQUFXLE9BQU87QUFBQSxVQUNsQixjQUFjLE9BQU87QUFBQSxVQUNyQixTQUFTLE9BQU87QUFBQSxRQUNsQjtBQUFBLFFBQ0E7QUFBQSxNQUNGO0FBQ0EsYUFBTztBQUFBLFFBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLGtCQUFrQixFQUFFLEdBQUcsQ0FBQztBQUFBLFFBQ2pFLFNBQVMsRUFBRSxXQUFXLGlCQUFpQixHQUFHO0FBQUEsTUFDNUM7QUFBQSxJQUNGLFNBQVMsS0FBSztBQUNaLFlBQU0sTUFBTSxlQUFlLFFBQVEsSUFBSSxVQUFVLE9BQU8sR0FBRztBQUMzRCxlQUFTLFFBQVEsa0NBQWtDLEdBQUcsSUFBSSxFQUFFLE1BQU0scUJBQXFCLE9BQU8sT0FBTyxHQUFHLEVBQUUsQ0FBQztBQUMzRyxhQUFPO0FBQUEsUUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0sMEJBQTBCLEdBQUcsR0FBRyxDQUFDO0FBQUEsUUFDMUUsU0FBUyxFQUFFLFdBQVcsaUJBQWlCLE9BQU8sSUFBSTtBQUFBLE1BQ3BEO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxRQUFNLG1CQUFtQjtBQUFBLElBQ3ZCLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0U7QUFBQSxJQUVGLGVBQWU7QUFBQSxJQUNmLGtCQUFrQjtBQUFBLE1BQ2hCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxJQUNBLFlBQVksS0FBSyxPQUFPO0FBQUEsTUFDdEIsT0FBTyxLQUFLLE9BQU8sRUFBRSxhQUFhLDBFQUEwRSxDQUFDO0FBQUEsTUFDN0csVUFBVSxLQUFLLE9BQU8sRUFBRSxhQUFhLHdCQUF3QixDQUFDO0FBQUEsTUFDOUQsUUFBUSxLQUFLLE9BQU8sRUFBRSxhQUFhLGtCQUFrQixDQUFDO0FBQUEsTUFDdEQsV0FBVyxLQUFLLE9BQU8sRUFBRSxhQUFhLDJCQUEyQixDQUFDO0FBQUEsTUFDbEUsV0FBVyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxpREFBaUQsQ0FBQyxDQUFDO0FBQUEsTUFDdkcsY0FBYyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxvREFBb0QsQ0FBQyxDQUFDO0FBQUEsTUFDN0csU0FBUyxLQUFLLFNBQVMsS0FBSyxNQUFNO0FBQUEsUUFDaEMsS0FBSyxRQUFRLE9BQU87QUFBQSxRQUNwQixLQUFLLFFBQVEsT0FBTztBQUFBLFFBQ3BCLEtBQUssUUFBUSxlQUFlO0FBQUEsTUFDOUIsR0FBRyxFQUFFLGFBQWEsbUpBQW1KLENBQUMsQ0FBQztBQUFBLElBQ3pLLENBQUM7QUFBQSxJQUNELFNBQVM7QUFBQSxJQUNULFdBQVcsTUFBVyxPQUFZO0FBQ2hDLFVBQUksT0FBTyxNQUFNLEdBQUcsYUFBYSxNQUFNLEtBQUssZ0JBQWdCLENBQUM7QUFDN0QsVUFBSSxLQUFLLE1BQU8sU0FBUSxNQUFNLEdBQUcsVUFBVSxJQUFJLEtBQUssS0FBSyxJQUFJO0FBQzdELFVBQUksS0FBSyxTQUFVLFNBQVEsTUFBTSxHQUFHLFNBQVMsS0FBSyxRQUFRO0FBQzFELFVBQUksS0FBSyxPQUFRLFNBQVEsTUFBTSxHQUFHLE9BQU8sV0FBTSxLQUFLLE1BQU0sRUFBRTtBQUM1RCxhQUFPLElBQUksS0FBSyxNQUFNLEdBQUcsQ0FBQztBQUFBLElBQzVCO0FBQUEsSUFDQSxhQUFhLFFBQWEsVUFBZSxPQUFZO0FBQ25ELFlBQU0sSUFBSSxZQUFZLE1BQU07QUFDNUIsVUFBSSxPQUFPLFdBQVcsR0FBRyxPQUFPO0FBQzlCLGVBQU8sSUFBSSxLQUFLLE1BQU0sR0FBRyxTQUFTLFVBQVUsR0FBRyxTQUFTLFNBQVMsRUFBRSxHQUFHLEdBQUcsQ0FBQztBQUFBLE1BQzVFO0FBQ0EsVUFBSSxPQUFPLE1BQU0sR0FBRyxXQUFXLFlBQVksR0FBRyxNQUFNLEVBQUUsUUFBUTtBQUM5RCxVQUFJLEdBQUcsR0FBSSxTQUFRLE1BQU0sR0FBRyxPQUFPLHNCQUFpQjtBQUNwRCxhQUFPLElBQUksS0FBSyxNQUFNLEdBQUcsQ0FBQztBQUFBLElBQzVCO0FBQUEsRUFDRjtBQUVBLEtBQUcsYUFBYSxnQkFBZ0I7QUFDaEMsZ0JBQWMsSUFBSSxrQkFBa0IscUJBQXFCLG1CQUFtQjtBQUk1RSxRQUFNLDJCQUEyQixPQUFPLGFBQXFCLFFBQWEsU0FBa0MsV0FBb0IsU0FBa0I7QUFDaEosVUFBTSxXQUFXLGNBQWMsSUFBSTtBQUNuQyxVQUFNLFlBQVksMEJBQTBCLHNCQUFzQixRQUFRO0FBQzFFLFFBQUksVUFBVyxRQUFPO0FBQ3RCLFVBQU0sY0FBYyxNQUFNLGFBQWEsUUFBUTtBQUMvQyxRQUFJLENBQUMsYUFBYTtBQUNoQixhQUFPO0FBQUEsUUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0sbUVBQW1FLENBQUM7QUFBQSxRQUM3RyxTQUFTLEVBQUUsV0FBVyxzQkFBc0IsSUFBSSxPQUFPLElBQUksT0FBTyxpQkFBaUI7QUFBQSxNQUNyRjtBQUFBLElBQ0Y7QUFDQSxRQUFJO0FBQ0YsWUFBTSxFQUFFLHNCQUFzQixJQUFJLE1BQU0sT0FBTyxpQkFBaUI7QUFDaEUsWUFBTSxVQUE4QyxDQUFDO0FBQ3JELFVBQUksT0FBTyxXQUFXLE9BQVcsU0FBUSxTQUFTLE9BQU87QUFDekQsVUFBSSxPQUFPLGVBQWUsT0FBVyxTQUFRLGFBQWEsT0FBTztBQUNqRSxVQUFJLE9BQU8sVUFBVSxPQUFXLFNBQVEsUUFBUSxPQUFPO0FBQ3ZELFVBQUksT0FBTyxnQkFBZ0IsT0FBVyxTQUFRLGNBQWMsT0FBTztBQUNuRSxVQUFJLE9BQU8sa0JBQWtCLE9BQVcsU0FBUSxnQkFBZ0IsT0FBTztBQUN2RSxVQUFJLE9BQU8sc0JBQXNCLE9BQVcsU0FBUSxvQkFBb0IsT0FBTztBQUMvRSxZQUFNLHNCQUFzQixPQUFPLElBQUksU0FBUyxRQUFRO0FBQ3hELGFBQU87QUFBQSxRQUNMLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSx1QkFBdUIsT0FBTyxFQUFFLEdBQUcsQ0FBQztBQUFBLFFBQzdFLFNBQVMsRUFBRSxXQUFXLHNCQUFzQixJQUFJLE9BQU8sR0FBRztBQUFBLE1BQzVEO0FBQUEsSUFDRixTQUFTLEtBQUs7QUFDWixZQUFNLE1BQU0sZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUc7QUFDM0QsZUFBUyxRQUFRLHVDQUF1QyxHQUFHLElBQUksRUFBRSxNQUFNLDBCQUEwQixPQUFPLE9BQU8sR0FBRyxFQUFFLENBQUM7QUFDckgsYUFBTztBQUFBLFFBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLCtCQUErQixHQUFHLEdBQUcsQ0FBQztBQUFBLFFBQy9FLFNBQVMsRUFBRSxXQUFXLHNCQUFzQixJQUFJLE9BQU8sSUFBSSxPQUFPLElBQUk7QUFBQSxNQUN4RTtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBRUEsUUFBTSx3QkFBd0I7QUFBQSxJQUM1QixNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUNFO0FBQUEsSUFFRixlQUFlO0FBQUEsSUFDZixrQkFBa0I7QUFBQSxNQUNoQjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxJQUNBLFlBQVksS0FBSyxPQUFPO0FBQUEsTUFDdEIsSUFBSSxLQUFLLE9BQU8sRUFBRSxhQUFhLHVDQUF1QyxDQUFDO0FBQUEsTUFDdkUsUUFBUSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxzREFBc0QsQ0FBQyxDQUFDO0FBQUEsTUFDekcsWUFBWSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSwrQkFBK0IsQ0FBQyxDQUFDO0FBQUEsTUFDdEYsT0FBTyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxtQkFBbUIsQ0FBQyxDQUFDO0FBQUEsTUFDckUsYUFBYSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxzQkFBc0IsQ0FBQyxDQUFDO0FBQUEsTUFDOUUsZUFBZSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSx1QkFBdUIsQ0FBQyxDQUFDO0FBQUEsTUFDakYsbUJBQW1CLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLG9CQUFvQixDQUFDLENBQUM7QUFBQSxJQUNwRixDQUFDO0FBQUEsSUFDRCxTQUFTO0FBQUEsSUFDVCxXQUFXLE1BQVcsT0FBWTtBQUNoQyxVQUFJLE9BQU8sTUFBTSxHQUFHLGFBQWEsTUFBTSxLQUFLLHFCQUFxQixDQUFDO0FBQ2xFLFVBQUksS0FBSyxHQUFJLFNBQVEsTUFBTSxHQUFHLFVBQVUsS0FBSyxFQUFFO0FBQy9DLFlBQU0sU0FBUyxDQUFDLFVBQVUsY0FBYyxTQUFTLGFBQWEsRUFBRSxPQUFPLENBQUMsTUFBTSxLQUFLLENBQUMsQ0FBQztBQUNyRixVQUFJLE9BQU8sU0FBUyxFQUFHLFNBQVEsTUFBTSxHQUFHLE9BQU8sS0FBSyxPQUFPLEtBQUssSUFBSSxDQUFDLEdBQUc7QUFDeEUsYUFBTyxJQUFJLEtBQUssTUFBTSxHQUFHLENBQUM7QUFBQSxJQUM1QjtBQUFBLElBQ0EsYUFBYSxRQUFhLFVBQWUsT0FBWTtBQUNuRCxZQUFNLElBQUksWUFBWSxNQUFNO0FBQzVCLFVBQUksT0FBTyxXQUFXLEdBQUcsT0FBTztBQUM5QixlQUFPLElBQUksS0FBSyxNQUFNLEdBQUcsU0FBUyxVQUFVLEdBQUcsU0FBUyxTQUFTLEVBQUUsR0FBRyxHQUFHLENBQUM7QUFBQSxNQUM1RTtBQUNBLFVBQUksT0FBTyxNQUFNLEdBQUcsV0FBVyxlQUFlLEdBQUcsTUFBTSxFQUFFLFVBQVU7QUFDbkUsY0FBUSxNQUFNLEdBQUcsT0FBTyx5QkFBb0I7QUFDNUMsYUFBTyxJQUFJLEtBQUssTUFBTSxHQUFHLENBQUM7QUFBQSxJQUM1QjtBQUFBLEVBQ0Y7QUFFQSxLQUFHLGFBQWEscUJBQXFCO0FBQ3JDLGdCQUFjLElBQUksdUJBQXVCLDBCQUEwQix3QkFBd0I7QUFJM0YsUUFBTSx5QkFBeUIsT0FBTyxhQUFxQixRQUFhLFNBQWtDLFdBQW9CLFNBQWtCO0FBQzlJLFVBQU0sV0FBVyxjQUFjLElBQUk7QUFDbkMsVUFBTSxZQUFZLDBCQUEwQixvQkFBb0IsUUFBUTtBQUN4RSxRQUFJLFVBQVcsUUFBTztBQUN0QixVQUFNLGNBQWMsTUFBTSxhQUFhLFFBQVE7QUFDL0MsUUFBSSxDQUFDLGFBQWE7QUFDaEIsYUFBTztBQUFBLFFBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLGlFQUFpRSxDQUFDO0FBQUEsUUFDM0csU0FBUyxFQUFFLFdBQVcsb0JBQW9CLE9BQU8saUJBQWlCO0FBQUEsTUFDcEU7QUFBQSxJQUNGO0FBQ0EsUUFBSTtBQUNGLFlBQU0sRUFBRSxvQkFBb0IsSUFBSSxNQUFNLE9BQU8saUJBQWlCO0FBQzlELFlBQU0sU0FBUyxNQUFNO0FBQUEsUUFDbkI7QUFBQSxVQUNFLE9BQU8sT0FBTztBQUFBLFVBQ2QsUUFBUSxPQUFPO0FBQUEsVUFDZixhQUFhLE9BQU87QUFBQSxVQUNwQixLQUFLLE9BQU87QUFBQSxVQUNaLFFBQVEsT0FBTztBQUFBLFVBQ2YsZUFBZSxPQUFPO0FBQUEsVUFDdEIsbUJBQW1CLE9BQU87QUFBQSxVQUMxQixZQUFZLE9BQU87QUFBQSxVQUNuQixPQUFPLE9BQU87QUFBQSxRQUNoQjtBQUFBLFFBQ0E7QUFBQSxNQUNGO0FBQ0EsYUFBTztBQUFBLFFBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLHFCQUFxQixPQUFPLEVBQUUsR0FBRyxDQUFDO0FBQUEsUUFDM0UsU0FBUyxFQUFFLFdBQVcsb0JBQW9CLElBQUksT0FBTyxHQUFHO0FBQUEsTUFDMUQ7QUFBQSxJQUNGLFNBQVMsS0FBSztBQUNaLFlBQU0sTUFBTSxlQUFlLFFBQVEsSUFBSSxVQUFVLE9BQU8sR0FBRztBQUMzRCxlQUFTLFFBQVEscUNBQXFDLEdBQUcsSUFBSSxFQUFFLE1BQU0sd0JBQXdCLE9BQU8sT0FBTyxHQUFHLEVBQUUsQ0FBQztBQUNqSCxhQUFPO0FBQUEsUUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0sNkJBQTZCLEdBQUcsR0FBRyxDQUFDO0FBQUEsUUFDN0UsU0FBUyxFQUFFLFdBQVcsb0JBQW9CLE9BQU8sSUFBSTtBQUFBLE1BQ3ZEO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxRQUFNLHNCQUFzQjtBQUFBLElBQzFCLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0U7QUFBQSxJQUVGLGVBQWU7QUFBQSxJQUNmLGtCQUFrQjtBQUFBLE1BQ2hCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxJQUNBLFlBQVksS0FBSyxPQUFPO0FBQUEsTUFDdEIsT0FBTyxXQUFXO0FBQUEsUUFDaEI7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGLEdBQUcsRUFBRSxhQUFhLG9CQUFvQixDQUFDO0FBQUEsTUFDdkMsYUFBYSxLQUFLLE9BQU8sRUFBRSxhQUFhLHVDQUF1QyxDQUFDO0FBQUEsTUFDaEYsS0FBSyxLQUFLLE9BQU8sRUFBRSxhQUFhLCtCQUErQixDQUFDO0FBQUEsTUFDaEUsUUFBUSxLQUFLLE9BQU8sRUFBRSxhQUFhLHFFQUFxRSxDQUFDO0FBQUEsTUFDekcsUUFBUSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSw2QkFBNkIsQ0FBQyxDQUFDO0FBQUEsTUFDaEYsZUFBZSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSx1QkFBdUIsQ0FBQyxDQUFDO0FBQUEsTUFDakYsbUJBQW1CLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLG9CQUFvQixDQUFDLENBQUM7QUFBQSxNQUNsRixZQUFZLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLHNCQUFzQixDQUFDLENBQUM7QUFBQSxNQUM3RSxPQUFPLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLG1CQUFtQixDQUFDLENBQUM7QUFBQSxJQUN2RSxDQUFDO0FBQUEsSUFDRCxTQUFTO0FBQUEsSUFDVCxXQUFXLE1BQVcsT0FBWTtBQUNoQyxVQUFJLE9BQU8sTUFBTSxHQUFHLGFBQWEsTUFBTSxLQUFLLG1CQUFtQixDQUFDO0FBQ2hFLFVBQUksS0FBSyxNQUFPLFNBQVEsTUFBTSxHQUFHLFVBQVUsSUFBSSxLQUFLLEtBQUssSUFBSTtBQUM3RCxVQUFJLEtBQUssWUFBYSxTQUFRLE1BQU0sR0FBRyxTQUFTLEtBQUssV0FBVztBQUNoRSxhQUFPLElBQUksS0FBSyxNQUFNLEdBQUcsQ0FBQztBQUFBLElBQzVCO0FBQUEsSUFDQSxhQUFhLFFBQWEsVUFBZSxPQUFZO0FBQ25ELFlBQU0sSUFBSSxZQUFZLE1BQU07QUFDNUIsVUFBSSxPQUFPLFdBQVcsR0FBRyxPQUFPO0FBQzlCLGVBQU8sSUFBSSxLQUFLLE1BQU0sR0FBRyxTQUFTLFVBQVUsR0FBRyxTQUFTLFNBQVMsRUFBRSxHQUFHLEdBQUcsQ0FBQztBQUFBLE1BQzVFO0FBQ0EsVUFBSSxPQUFPLE1BQU0sR0FBRyxXQUFXLGVBQWUsR0FBRyxNQUFNLEVBQUUsUUFBUTtBQUNqRSxjQUFRLE1BQU0sR0FBRyxPQUFPLHlCQUFvQjtBQUM1QyxhQUFPLElBQUksS0FBSyxNQUFNLEdBQUcsQ0FBQztBQUFBLElBQzVCO0FBQUEsRUFDRjtBQUVBLEtBQUcsYUFBYSxtQkFBbUI7QUFDbkMsZ0JBQWMsSUFBSSxxQkFBcUIsd0JBQXdCLHNCQUFzQjtBQUlyRixRQUFNLHFCQUFxQixPQUFPLGFBQXFCLFFBQWEsU0FBa0MsV0FBb0IsU0FBa0I7QUFDMUksVUFBTSxFQUFFLG1CQUFtQixJQUFJLE1BQU0sc0JBQXNCO0FBQzNELFdBQU8sbUJBQW1CLFFBQVEsY0FBYyxJQUFJLENBQUM7QUFBQSxFQUN2RDtBQUVBLFFBQU0sa0JBQWtCO0FBQUEsSUFDdEIsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDRTtBQUFBLElBRUYsZUFBZTtBQUFBLElBQ2Ysa0JBQWtCO0FBQUEsTUFDaEI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxJQUNBLFlBQVksS0FBSyxPQUFPO0FBQUEsTUFDdEIsY0FBYyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxzSEFBc0gsQ0FBQyxDQUFDO0FBQUEsTUFDL0ssVUFBVSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxzQkFBc0IsQ0FBQyxDQUFDO0FBQUEsTUFDM0UsU0FBUyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxxQkFBcUIsQ0FBQyxDQUFDO0FBQUEsTUFDekUsZUFBZSxXQUFXLENBQUMsV0FBVyxZQUFZLFdBQVcsY0FBYyxpQkFBaUIsV0FBVyxpQkFBaUIsZ0JBQWdCLG9CQUFvQixHQUFHLEVBQUUsYUFBYSx3QkFBd0IsQ0FBQztBQUFBLE1BQ3ZNLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSw0Q0FBNEMsQ0FBQztBQUFBLElBQ25GLENBQUM7QUFBQSxJQUNELFNBQVM7QUFBQSxJQUNULFdBQVcsTUFBVyxPQUFZO0FBQ2hDLFVBQUksT0FBTyxNQUFNLEdBQUcsYUFBYSxNQUFNLEtBQUssZUFBZSxDQUFDO0FBQzVELFVBQUksS0FBSyxjQUFlLFNBQVEsTUFBTSxHQUFHLFVBQVUsS0FBSyxhQUFhO0FBQ3JFLFlBQU0sT0FBTyxDQUFDLEtBQUssY0FBYyxLQUFLLFVBQVUsS0FBSyxPQUFPLEVBQUUsT0FBTyxPQUFPLEVBQUUsS0FBSyxHQUFHO0FBQ3RGLFVBQUksS0FBTSxTQUFRLE1BQU0sR0FBRyxPQUFPLElBQUksSUFBSSxFQUFFO0FBQzVDLGFBQU8sSUFBSSxLQUFLLE1BQU0sR0FBRyxDQUFDO0FBQUEsSUFDNUI7QUFBQSxJQUNBLGFBQWEsUUFBYSxVQUFlLE9BQVk7QUFDbkQsWUFBTSxJQUFJLFlBQVksTUFBTTtBQUM1QixVQUFJLE9BQU8sV0FBVyxHQUFHLE9BQU87QUFDOUIsZUFBTyxJQUFJLEtBQUssTUFBTSxHQUFHLFNBQVMsVUFBVSxHQUFHLFNBQVMsU0FBUyxFQUFFLEdBQUcsR0FBRyxDQUFDO0FBQUEsTUFDNUU7QUFDQSxVQUFJLE9BQU8sTUFBTSxHQUFHLFdBQVcsR0FBRyxHQUFHLGlCQUFpQixVQUFVLFFBQVE7QUFDeEUsVUFBSSxHQUFHLEtBQU0sU0FBUSxNQUFNLEdBQUcsT0FBTyxXQUFNLEVBQUUsSUFBSSxFQUFFO0FBQ25ELGFBQU8sSUFBSSxLQUFLLE1BQU0sR0FBRyxDQUFDO0FBQUEsSUFDNUI7QUFBQSxFQUNGO0FBRUEsS0FBRyxhQUFhLGVBQWU7QUFDL0IsZ0JBQWMsSUFBSSxpQkFBaUIsb0JBQW9CLGtCQUFrQjtBQUl6RSxRQUFNLDZCQUE2QixPQUFPLGFBQXFCLFNBQWMsU0FBa0MsV0FBb0IsU0FBa0I7QUFDbkosUUFBSTtBQUNGLFlBQU0sV0FBVyxjQUFjLElBQUk7QUFHbkMsWUFBTSxFQUFFLGlCQUFpQixrQkFBa0IseUJBQXlCLGdCQUFnQixJQUFJLE1BQU0sT0FBTyxtQkFBbUI7QUFDeEgsWUFBTSxXQUFXLGdCQUFnQjtBQUNqQyxVQUFJLFVBQVU7QUFDWixjQUFNLHFCQUFxQixVQUFVLFFBQVE7QUFDN0MsZUFBTztBQUFBLFVBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLFNBQVMsQ0FBQztBQUFBLFVBQ25ELFNBQVMsRUFBRSxXQUFXLHlCQUF5QixJQUFJLFVBQVUsUUFBUSxXQUFXO0FBQUEsUUFDbEY7QUFBQSxNQUNGO0FBRUEsWUFBTSxjQUFjLGlCQUFpQixRQUFRO0FBQzdDLFlBQU0sZ0JBQWdCLENBQUMsQ0FBQyw0QkFBNEIsUUFBUSxHQUFHLGFBQWE7QUFDNUUsWUFBTSxTQUFTLENBQUMsR0FBRyxvQkFBSSxJQUFJLENBQUMsR0FBRyxhQUFhLEdBQUcsd0JBQXdCLENBQUMsQ0FBQyxDQUFDO0FBQzFFLFlBQU0sUUFBUSxnQkFBZ0IsUUFBUSxhQUFhO0FBQ25ELFlBQU0scUJBQXFCLE9BQU8sUUFBUTtBQUMxQyxhQUFPO0FBQUEsUUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0sTUFBTSxDQUFDO0FBQUEsUUFDaEQsU0FBUyxFQUFFLFdBQVcseUJBQXlCLElBQUksT0FBTyxlQUFlLFlBQVksUUFBUSxjQUFjO0FBQUEsTUFDN0c7QUFBQSxJQUNGLFNBQVMsS0FBSztBQUNaLFlBQU0sTUFBTSxlQUFlLFFBQVEsSUFBSSxVQUFVLE9BQU8sR0FBRztBQUMzRCxhQUFPO0FBQUEsUUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0sa0NBQWtDLEdBQUcsR0FBRyxDQUFDO0FBQUEsUUFDbEYsU0FBUyxFQUFFLFdBQVcseUJBQXlCLE9BQU8sSUFBSTtBQUFBLE1BQzVEO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFRQSxpQkFBZSxxQkFBcUIsYUFBcUIsVUFBaUM7QUFDeEYsVUFBTSxjQUFjLE1BQU0sYUFBYSxRQUFRO0FBQy9DLFFBQUksQ0FBQyxZQUFhO0FBQ2xCLFFBQUk7QUFDRixZQUFNLEVBQUUsZ0JBQWdCLElBQUksTUFBTSxPQUFPLGNBQWM7QUFDdkQsc0JBQWdCLEVBQUUsSUFBSSxhQUFhLFFBQVEsU0FBUyxDQUFDO0FBQUEsSUFDdkQsU0FBUyxHQUFHO0FBQ1YsZUFBUyxRQUFRLDhCQUE4QixXQUFXLEtBQU0sRUFBWSxPQUFPLEVBQUU7QUFBQSxJQUN2RjtBQUFBLEVBQ0Y7QUFFQSxRQUFNLDBCQUEwQjtBQUFBLElBQzlCLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0U7QUFBQSxJQUdGLGVBQWU7QUFBQSxJQUNmLGtCQUFrQjtBQUFBLE1BQ2hCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLElBQ0EsWUFBWSxLQUFLLE9BQU8sQ0FBQyxDQUFDO0FBQUEsSUFDMUIsU0FBUztBQUFBLElBQ1QsV0FBVyxPQUFZLE9BQVk7QUFDakMsYUFBTyxJQUFJLEtBQUssTUFBTSxHQUFHLGFBQWEsTUFBTSxLQUFLLHVCQUF1QixDQUFDLEdBQUcsR0FBRyxDQUFDO0FBQUEsSUFDbEY7QUFBQSxJQUNBLGFBQWEsUUFBYSxVQUFlLE9BQVk7QUFDbkQsWUFBTSxJQUFJLFlBQVksTUFBTTtBQUM1QixVQUFJLE9BQU8sV0FBVyxHQUFHLE9BQU87QUFDOUIsZUFBTyxJQUFJLEtBQUssTUFBTSxHQUFHLFNBQVMsVUFBVSxHQUFHLFNBQVMsU0FBUyxFQUFFLEdBQUcsR0FBRyxDQUFDO0FBQUEsTUFDNUU7QUFDQSxVQUFJLE9BQU8sTUFBTSxHQUFHLFdBQVcsYUFBYSxHQUFHLE1BQU0sSUFBSSxFQUFFO0FBQzNELFVBQUksR0FBRyxXQUFXLFdBQVksU0FBUSxNQUFNLEdBQUcsT0FBTyxhQUFhO0FBQ25FLGFBQU8sSUFBSSxLQUFLLE1BQU0sR0FBRyxDQUFDO0FBQUEsSUFDNUI7QUFBQSxFQUNGO0FBRUEsS0FBRyxhQUFhLHVCQUF1QjtBQUN2QyxnQkFBYyxJQUFJLHlCQUF5Qiw2QkFBNkIsMkJBQTJCO0FBSW5HLFFBQU0sdUJBQXVCLE9BQU8sYUFBcUIsUUFBYSxTQUFrQyxXQUFvQixTQUFrQjtBQUM1SSxVQUFNLEVBQUUscUJBQXFCLElBQUksTUFBTSxzQkFBc0I7QUFDN0QsV0FBTyxxQkFBcUIsUUFBUSxjQUFjLElBQUksQ0FBQztBQUFBLEVBQ3pEO0FBRUEsUUFBTSxvQkFBb0I7QUFBQSxJQUN4QixNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUNFO0FBQUEsSUFDRixlQUFlO0FBQUEsSUFDZixrQkFBa0I7QUFBQSxNQUNoQjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsSUFDQSxZQUFZLEtBQUssT0FBTztBQUFBO0FBQUEsTUFFdEIsYUFBYSxLQUFLLE9BQU8sRUFBRSxhQUFhLDJCQUEyQixDQUFDO0FBQUEsTUFDcEUsT0FBTyxLQUFLLE9BQU8sRUFBRSxhQUFhLHNGQUFzRixDQUFDO0FBQUEsTUFDekgsUUFBUSxLQUFLLE9BQU8sRUFBRSxhQUFhLG1CQUFtQixDQUFDO0FBQUEsTUFDdkQsUUFBUSxLQUFLLE1BQU0sS0FBSyxPQUFPO0FBQUEsUUFDN0IsU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLHNCQUFzQixDQUFDO0FBQUEsUUFDM0QsT0FBTyxLQUFLLE9BQU8sRUFBRSxhQUFhLGtGQUFrRixDQUFDO0FBQUEsUUFDckgsTUFBTSxLQUFLLE9BQU8sRUFBRSxhQUFhLGFBQWEsQ0FBQztBQUFBLFFBQy9DLFNBQVMsS0FBSyxNQUFNLEtBQUssT0FBTyxHQUFHLEVBQUUsYUFBYSx1QkFBdUIsQ0FBQztBQUFBLFFBQzFFLE1BQU0sS0FBSyxPQUFPLEVBQUUsYUFBYSxpQ0FBaUMsQ0FBQztBQUFBLFFBQ25FLE1BQU0sS0FBSyxPQUFPLEVBQUUsYUFBYSxhQUFhLENBQUM7QUFBQTtBQUFBLFFBRS9DLGlCQUFpQixLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSw2RUFBNkUsQ0FBQyxDQUFDO0FBQUEsUUFDekksWUFBWSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxrRUFBa0UsQ0FBQyxDQUFDO0FBQUEsUUFDekgsb0JBQW9CLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLDBFQUEwRSxDQUFDLENBQUM7QUFBQSxRQUN6SSxxQkFBcUIsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsMkVBQTJFLENBQUMsQ0FBQztBQUFBO0FBQUEsUUFFM0ksVUFBVSxLQUFLLFNBQVMsS0FBSyxRQUFRLEVBQUUsYUFBYSw2RUFBNkUsQ0FBQyxDQUFDO0FBQUEsUUFDbkksYUFBYSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSx5RUFBb0UsQ0FBQyxDQUFDO0FBQUEsTUFDOUgsQ0FBQyxHQUFHLEVBQUUsYUFBYSxtQ0FBbUMsQ0FBQztBQUFBO0FBQUEsTUFFdkQsUUFBUSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSx3Q0FBd0MsQ0FBQyxDQUFDO0FBQUEsTUFDM0YsV0FBVyxLQUFLLFNBQVMsS0FBSyxNQUFNLEtBQUssT0FBTyxHQUFHLEVBQUUsYUFBYSx5QkFBeUIsQ0FBQyxDQUFDO0FBQUEsTUFDN0YsaUJBQWlCLEtBQUssU0FBUyxLQUFLLE1BQU0sS0FBSyxPQUFPLEdBQUcsRUFBRSxhQUFhLHFDQUFxQyxDQUFDLENBQUM7QUFBQSxNQUMvRyxVQUFVLEtBQUssU0FBUyxLQUFLLE1BQU0sS0FBSyxPQUFPO0FBQUEsUUFDN0MsTUFBTSxLQUFLLE9BQU8sRUFBRSxhQUFhLGlCQUFpQixDQUFDO0FBQUEsUUFDbkQsY0FBYyxLQUFLLE9BQU8sRUFBRSxhQUFhLHVCQUF1QixDQUFDO0FBQUEsTUFDbkUsQ0FBQyxHQUFHLEVBQUUsYUFBYSwwQkFBMEIsQ0FBQyxDQUFDO0FBQUEsTUFDL0MsZUFBZSxLQUFLLFNBQVMsS0FBSyxNQUFNLEtBQUssT0FBTztBQUFBLFFBQ2xELGVBQWUsS0FBSyxPQUFPLEVBQUUsYUFBYSw0QkFBNEIsQ0FBQztBQUFBLFFBQ3ZFLFVBQVUsS0FBSyxPQUFPLEVBQUUsYUFBYSwyQkFBMkIsQ0FBQztBQUFBLFFBQ2pFLGtCQUFrQixLQUFLLE9BQU8sRUFBRSxhQUFhLDhCQUE4QixDQUFDO0FBQUEsTUFDOUUsQ0FBQyxHQUFHLEVBQUUsYUFBYSxvQ0FBb0MsQ0FBQyxDQUFDO0FBQUEsTUFDekQsc0JBQXNCLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLDZCQUE2QixDQUFDLENBQUM7QUFBQSxNQUM5Rix5QkFBeUIsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsZ0NBQWdDLENBQUMsQ0FBQztBQUFBLE1BQ3BHLHlCQUF5QixLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxnQ0FBZ0MsQ0FBQyxDQUFDO0FBQUEsTUFDcEcsaUJBQWlCLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLHdCQUF3QixDQUFDLENBQUM7QUFBQSxNQUNwRixrQkFBa0IsS0FBSyxTQUFTLEtBQUssTUFBTSxLQUFLLE9BQU8sR0FBRyxFQUFFLGFBQWEsNkJBQTZCLENBQUMsQ0FBQztBQUFBLE1BQ3hHLHFCQUFxQixLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSw0QkFBNEIsQ0FBQyxDQUFDO0FBQUEsTUFDNUYscUJBQXFCLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLDhCQUE4QixDQUFDLENBQUM7QUFBQTtBQUFBLE1BRTlGLFdBQVcsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsOEZBQThGLENBQUMsQ0FBQztBQUFBLE1BQ3BKLGVBQWUsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsZ0ZBQWdGLENBQUMsQ0FBQztBQUFBLElBQzVJLENBQUM7QUFBQSxJQUNELFNBQVM7QUFBQSxFQUNYO0FBRUEsS0FBRyxhQUFhLGlCQUFpQjtBQUNqQyxnQkFBYyxJQUFJLG1CQUFtQixzQkFBc0Isb0JBQW9CO0FBSS9FLFFBQU0sbUJBQW1CLE9BQU8sYUFBcUIsUUFBYSxTQUFrQyxXQUFvQixTQUFrQjtBQUN4SSxVQUFNLEVBQUUsaUJBQWlCLElBQUksTUFBTSxzQkFBc0I7QUFDekQsV0FBTyxpQkFBaUIsUUFBUSxjQUFjLElBQUksQ0FBQztBQUFBLEVBQ3JEO0FBRUEsUUFBTSxnQkFBZ0I7QUFBQSxJQUNwQixNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUNFO0FBQUEsSUFDRixlQUFlO0FBQUEsSUFDZixrQkFBa0I7QUFBQSxNQUNoQjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxJQUNBLFlBQVksS0FBSyxPQUFPO0FBQUE7QUFBQSxNQUV0QixhQUFhLEtBQUssT0FBTyxFQUFFLGFBQWEsMkJBQTJCLENBQUM7QUFBQSxNQUNwRSxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsc0JBQXNCLENBQUM7QUFBQSxNQUMzRCxNQUFNLEtBQUssT0FBTyxFQUFFLGFBQWEsYUFBYSxDQUFDO0FBQUEsTUFDL0MsT0FBTyxLQUFLLE1BQU0sS0FBSyxPQUFPO0FBQUEsUUFDNUIsUUFBUSxLQUFLLE9BQU8sRUFBRSxhQUFhLHFCQUFxQixDQUFDO0FBQUEsUUFDekQsT0FBTyxLQUFLLE9BQU8sRUFBRSxhQUFhLGFBQWEsQ0FBQztBQUFBLFFBQ2hELGFBQWEsS0FBSyxPQUFPLEVBQUUsYUFBYSxpQ0FBaUMsQ0FBQztBQUFBLFFBQzFFLFVBQVUsS0FBSyxPQUFPLEVBQUUsYUFBYSx1QkFBdUIsQ0FBQztBQUFBLFFBQzdELE9BQU8sS0FBSyxNQUFNLEtBQUssT0FBTyxHQUFHLEVBQUUsYUFBYSxvRkFBc0YsQ0FBQztBQUFBLFFBQ3ZJLFFBQVEsS0FBSyxPQUFPLEVBQUUsYUFBYSxnQ0FBZ0MsQ0FBQztBQUFBLFFBQ3BFLFFBQVEsS0FBSyxNQUFNLEtBQUssT0FBTyxHQUFHLEVBQUUsYUFBYSx5RkFBMkYsQ0FBQztBQUFBLFFBQzdJLGdCQUFnQixLQUFLLE1BQU0sS0FBSyxPQUFPLEdBQUcsRUFBRSxhQUFhLGtHQUFvRyxDQUFDO0FBQUEsUUFDOUoscUJBQXFCLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLDRCQUE0QixDQUFDLENBQUM7QUFBQSxNQUM5RixDQUFDLEdBQUcsRUFBRSxhQUFhLDhCQUE4QixDQUFDO0FBQUE7QUFBQSxNQUVsRCxpQkFBaUIsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsK0JBQStCLENBQUMsQ0FBQztBQUFBLE1BQzNGLFlBQVksS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsb0JBQW9CLENBQUMsQ0FBQztBQUFBLE1BQzNFLG9CQUFvQixLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSw0QkFBNEIsQ0FBQyxDQUFDO0FBQUEsTUFDM0YscUJBQXFCLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLDZCQUE2QixDQUFDLENBQUM7QUFBQTtBQUFBLE1BRTdGLFdBQVcsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsOEZBQThGLENBQUMsQ0FBQztBQUFBLE1BQ3BKLGVBQWUsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsZ0ZBQWdGLENBQUMsQ0FBQztBQUFBLElBQzVJLENBQUM7QUFBQSxJQUNELFNBQVM7QUFBQSxFQUNYO0FBRUEsS0FBRyxhQUFhLGFBQWE7QUFDN0IsZ0JBQWMsSUFBSSxlQUFlLGtCQUFrQixnQkFBZ0I7QUFJbkUsUUFBTSxrQkFBa0IsT0FBTyxhQUFxQixRQUFhLFNBQWtDLFdBQW9CLFNBQWtCO0FBQ3ZJLFVBQU0sV0FBVyxjQUFjLElBQUk7QUFDbkMsVUFBTSxjQUFjLE1BQU0sYUFBYSxRQUFRO0FBQy9DLFFBQUksQ0FBQyxhQUFhO0FBQ2hCLGFBQU87QUFBQSxRQUNMLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSwwREFBMEQsQ0FBQztBQUFBLFFBQ3BHLFNBQVMsRUFBRSxXQUFXLGFBQWEsT0FBTyxpQkFBaUI7QUFBQSxNQUM3RDtBQUFBLElBQ0Y7QUFDQSxRQUFJO0FBQ0YsWUFBTSxFQUFFLGVBQWUsSUFBSSxNQUFNLE9BQU8sdUJBQXVCO0FBQy9ELFlBQU0sU0FBUyxNQUFNLGVBQWUsUUFBUSxRQUFRO0FBQ3BELFVBQUksV0FBVyxRQUFRO0FBQ3JCLGVBQU87QUFBQSxVQUNMLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSx3QkFBd0IsT0FBTyxLQUFLLEdBQUcsQ0FBQztBQUFBLFVBQ2pGLFNBQVMsRUFBRSxXQUFXLGFBQWEsT0FBTyxPQUFPLE1BQU07QUFBQSxRQUN6RDtBQUFBLE1BQ0Y7QUFDQSxhQUFPO0FBQUEsUUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0sZ0JBQWdCLE9BQU8sTUFBTSxLQUFLLE9BQU8sT0FBTyxJQUFJLE9BQU8sV0FBVyxJQUFJLENBQUM7QUFBQSxRQUNwSCxTQUFTO0FBQUEsVUFDUCxXQUFXO0FBQUEsVUFDWCxhQUFhLE9BQU87QUFBQSxVQUNwQixTQUFTLE9BQU87QUFBQSxVQUNoQixRQUFRLE9BQU87QUFBQSxVQUNmLGNBQWMsT0FBTztBQUFBLFFBQ3ZCO0FBQUEsTUFDRjtBQUFBLElBQ0YsU0FBUyxLQUFLO0FBQ1osWUFBTSxNQUFNLGVBQWUsUUFBUSxJQUFJLFVBQVUsT0FBTyxHQUFHO0FBQzNELGVBQVMsUUFBUSwwQkFBMEIsR0FBRyxJQUFJLEVBQUUsTUFBTSxpQkFBaUIsT0FBTyxPQUFPLEdBQUcsRUFBRSxDQUFDO0FBQy9GLGFBQU87QUFBQSxRQUNMLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSx3QkFBd0IsR0FBRyxHQUFHLENBQUM7QUFBQSxRQUN4RSxTQUFTLEVBQUUsV0FBVyxhQUFhLE9BQU8sSUFBSTtBQUFBLE1BQ2hEO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxRQUFNLGVBQWU7QUFBQSxJQUNuQixNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUNFO0FBQUEsSUFDRixlQUFlO0FBQUEsSUFDZixrQkFBa0I7QUFBQSxNQUNoQjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxJQUNBLFlBQVksS0FBSyxPQUFPO0FBQUEsTUFDdEIsYUFBYSxLQUFLLE9BQU8sRUFBRSxhQUFhLDJCQUEyQixDQUFDO0FBQUEsTUFDcEUsU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLHNCQUFzQixDQUFDO0FBQUEsTUFDM0QsUUFBUSxLQUFLLE9BQU8sRUFBRSxhQUFhLHFCQUFxQixDQUFDO0FBQUEsTUFDekQsT0FBTyxLQUFLLE9BQU8sRUFBRSxhQUFhLGFBQWEsQ0FBQztBQUFBLE1BQ2hELGFBQWEsS0FBSyxPQUFPLEVBQUUsYUFBYSxpQ0FBaUMsQ0FBQztBQUFBLE1BQzFFLFVBQVUsS0FBSyxPQUFPLEVBQUUsYUFBYSx1QkFBdUIsQ0FBQztBQUFBLE1BQzdELE9BQU8sS0FBSyxNQUFNLEtBQUssT0FBTyxHQUFHLEVBQUUsYUFBYSxvRkFBc0YsQ0FBQztBQUFBLE1BQ3ZJLFFBQVEsS0FBSyxPQUFPLEVBQUUsYUFBYSxnQ0FBZ0MsQ0FBQztBQUFBLE1BQ3BFLFFBQVEsS0FBSyxNQUFNLEtBQUssT0FBTyxHQUFHLEVBQUUsYUFBYSx5RkFBMkYsQ0FBQztBQUFBLE1BQzdJLGdCQUFnQixLQUFLLE1BQU0sS0FBSyxPQUFPLEdBQUcsRUFBRSxhQUFhLGtHQUFvRyxDQUFDO0FBQUEsTUFDOUoscUJBQXFCLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLDRCQUE0QixDQUFDLENBQUM7QUFBQTtBQUFBLE1BRTVGLFdBQVcsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsOEZBQThGLENBQUMsQ0FBQztBQUFBLE1BQ3BKLGVBQWUsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsZ0ZBQWdGLENBQUMsQ0FBQztBQUFBLElBQzVJLENBQUM7QUFBQSxJQUNELFNBQVM7QUFBQSxFQUNYO0FBRUEsS0FBRyxhQUFhLFlBQVk7QUFDNUIsZ0JBQWMsSUFBSSxjQUFjLGlCQUFpQixlQUFlO0FBSWhFLFFBQU0sc0JBQXNCLE9BQU8sYUFBcUIsUUFBYSxTQUFrQyxXQUFvQixTQUFrQjtBQUMzSSxVQUFNLEVBQUUsb0JBQW9CLElBQUksTUFBTSxzQkFBc0I7QUFDNUQsV0FBTyxvQkFBb0IsUUFBUSxjQUFjLElBQUksQ0FBQztBQUFBLEVBQ3hEO0FBRUEsUUFBTSxtQkFBbUI7QUFBQSxJQUN2QixNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUNFO0FBQUEsSUFFRixlQUFlO0FBQUEsSUFDZixrQkFBa0I7QUFBQSxNQUNoQjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsSUFDQSxZQUFZLEtBQUssT0FBTztBQUFBO0FBQUEsTUFFdEIsUUFBUSxLQUFLLE9BQU8sRUFBRSxhQUFhLHFCQUFxQixDQUFDO0FBQUEsTUFDekQsU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLHNCQUFzQixDQUFDO0FBQUEsTUFDM0QsYUFBYSxLQUFLLE9BQU8sRUFBRSxhQUFhLDJCQUEyQixDQUFDO0FBQUEsTUFDcEUsVUFBVSxLQUFLLE9BQU8sRUFBRSxhQUFhLDRDQUE0QyxDQUFDO0FBQUEsTUFDbEYsV0FBVyxLQUFLLE9BQU8sRUFBRSxhQUFhLHNEQUFzRCxDQUFDO0FBQUEsTUFDN0YsY0FBYyxLQUFLLE9BQU8sRUFBRSxhQUFhLGtGQUE2RSxDQUFDO0FBQUE7QUFBQSxNQUV2SCxZQUFZLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLDRDQUE0QyxDQUFDLENBQUM7QUFBQSxNQUNuRyxhQUFhLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLG9EQUFvRCxDQUFDLENBQUM7QUFBQSxNQUM1RyxVQUFVLEtBQUssU0FBUyxLQUFLLE1BQU0sS0FBSyxPQUFPLEdBQUcsRUFBRSxhQUFhLHdDQUF3QyxDQUFDLENBQUM7QUFBQSxNQUMzRyxjQUFjLEtBQUssU0FBUyxLQUFLLE1BQU0sS0FBSyxPQUFPLEdBQUcsRUFBRSxhQUFhLDhDQUE4QyxDQUFDLENBQUM7QUFBQSxNQUNySCxtQkFBbUIsS0FBSyxTQUFTLEtBQUssUUFBUSxFQUFFLGFBQWEscURBQXFELENBQUMsQ0FBQztBQUFBO0FBQUEsTUFFcEgsWUFBWSxLQUFLLFNBQVMsS0FBSyxPQUFPO0FBQUEsUUFDcEMsVUFBVSxLQUFLLE9BQU8sRUFBRSxhQUFhLG1FQUE4RCxDQUFDO0FBQUEsUUFDcEcsU0FBUyxLQUFLLE1BQU0sS0FBSyxPQUFPO0FBQUEsVUFDOUIsSUFBSSxLQUFLLE9BQU8sRUFBRSxhQUFhLDBEQUEwRCxDQUFDO0FBQUEsVUFDMUYsT0FBTyxLQUFLLE9BQU8sRUFBRSxhQUFhLGtCQUFrQixDQUFDO0FBQUEsVUFDckQsV0FBVyxLQUFLLE9BQU8sRUFBRSxhQUFhLGlEQUFpRCxDQUFDO0FBQUEsUUFDMUYsQ0FBQyxHQUFHLEVBQUUsVUFBVSxHQUFHLFVBQVUsR0FBRyxhQUFhLGdEQUEyQyxDQUFDO0FBQUEsUUFDekYsZ0JBQWdCLEtBQUssT0FBTyxFQUFFLGFBQWEscUNBQXFDLENBQUM7QUFBQSxRQUNqRix5QkFBeUIsS0FBSyxPQUFPLEVBQUUsYUFBYSxvREFBMEMsQ0FBQztBQUFBLFFBQy9GLHFCQUFxQixLQUFLLFFBQVE7QUFBQSxVQUNoQyxhQUFhO0FBQUEsUUFDZixDQUFDO0FBQUEsTUFDSCxHQUFHLEVBQUUsYUFBYSwyR0FBMkcsQ0FBQyxDQUFDO0FBQUEsTUFDL0gsc0JBQXNCLEtBQUssU0FBUyxLQUFLO0FBQUEsUUFDdkMsS0FBSyxNQUFNO0FBQUEsVUFDVCxLQUFLLE9BQU87QUFBQSxZQUNWLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxvQ0FBb0MsQ0FBQztBQUFBLFlBQ3pFLFVBQVUsS0FBSyxPQUFPLEVBQUUsYUFBYSwyQkFBMkIsQ0FBQztBQUFBLFlBQ2pFLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSx3REFBOEMsQ0FBQztBQUFBLFlBQ25GLFlBQVksS0FBSyxPQUFPLEVBQUUsYUFBYSwwQ0FBMEMsQ0FBQztBQUFBLFVBQ3BGLENBQUM7QUFBQSxVQUNELEtBQUssT0FBTyxFQUFFLGFBQWEsd0NBQXdDLENBQUM7QUFBQSxRQUN0RSxDQUFDO0FBQUEsUUFDRCxFQUFFLGFBQWEseUNBQXlDO0FBQUEsTUFDMUQsQ0FBQztBQUFBO0FBQUEsTUFFRCxXQUFXLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLDhGQUE4RixDQUFDLENBQUM7QUFBQSxNQUNwSixlQUFlLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLHNGQUFzRixDQUFDLENBQUM7QUFBQSxJQUNsSixDQUFDO0FBQUEsSUFDRCxTQUFTO0FBQUEsRUFDWDtBQUVBLEtBQUcsYUFBYSxnQkFBZ0I7QUFDaEMsZ0JBQWMsSUFBSSxrQkFBa0IscUJBQXFCLG1CQUFtQjtBQUk1RSxRQUFNLHVCQUF1QixPQUFPLGFBQXFCLFFBQWEsU0FBa0MsV0FBb0IsU0FBa0I7QUFDNUksVUFBTSxFQUFFLHFCQUFxQixJQUFJLE1BQU0sc0JBQXNCO0FBQzdELFdBQU8scUJBQXFCLFFBQVEsY0FBYyxJQUFJLENBQUM7QUFBQSxFQUN6RDtBQUVBLFFBQU0sb0JBQW9CO0FBQUEsSUFDeEIsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDRTtBQUFBLElBRUYsZUFBZTtBQUFBLElBQ2Ysa0JBQWtCO0FBQUEsTUFDaEI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsSUFDQSxZQUFZLEtBQUssT0FBTztBQUFBO0FBQUEsTUFFdEIsU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLHNCQUFzQixDQUFDO0FBQUEsTUFDM0QsYUFBYSxLQUFLLE9BQU8sRUFBRSxhQUFhLDJCQUEyQixDQUFDO0FBQUEsTUFDcEUsWUFBWSxLQUFLLE9BQU8sRUFBRSxhQUFhLHFCQUFxQixDQUFDO0FBQUEsTUFDN0QsVUFBVSxLQUFLLE9BQU8sRUFBRSxhQUFhLGtEQUFrRCxDQUFDO0FBQUEsTUFDeEYsV0FBVyxLQUFLLE9BQU8sRUFBRSxhQUFhLHVEQUF1RCxDQUFDO0FBQUEsTUFDOUYsY0FBYyxLQUFLLE9BQU8sRUFBRSxhQUFhLHFDQUFxQyxDQUFDO0FBQUEsTUFDL0UsWUFBWSxLQUFLLE9BQU8sRUFBRSxhQUFhLG1DQUFtQyxDQUFDO0FBQUE7QUFBQSxNQUUzRSxZQUFZLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLDZDQUE2QyxDQUFDLENBQUM7QUFBQSxNQUNwRyxrQkFBa0IsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsd0NBQXdDLENBQUMsQ0FBQztBQUFBLE1BQ3JHLFdBQVcsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEseURBQXlELENBQUMsQ0FBQztBQUFBLE1BQy9HLFVBQVUsS0FBSyxTQUFTLEtBQUssTUFBTSxDQUFDLEtBQUssTUFBTSxLQUFLLE9BQU8sQ0FBQyxHQUFHLEtBQUssT0FBTyxDQUFDLEdBQUcsRUFBRSxhQUFhLGdDQUFnQyxDQUFDLENBQUM7QUFBQSxNQUNoSSxjQUFjLEtBQUssU0FBUyxLQUFLLE1BQU0sQ0FBQyxLQUFLLE1BQU0sS0FBSyxPQUFPLENBQUMsR0FBRyxLQUFLLE9BQU8sQ0FBQyxHQUFHLEVBQUUsYUFBYSx1Q0FBdUMsQ0FBQyxDQUFDO0FBQUEsTUFDM0kscUJBQXFCLEtBQUssU0FBUyxLQUFLLE1BQU0sQ0FBQyxLQUFLLE1BQU0sS0FBSyxPQUFPLENBQUMsR0FBRyxLQUFLLE9BQU8sQ0FBQyxHQUFHLEVBQUUsYUFBYSxxQ0FBcUMsQ0FBQyxDQUFDO0FBQUEsTUFDaEosdUJBQXVCLEtBQUssU0FBUyxLQUFLLE1BQU0sQ0FBQyxLQUFLLE1BQU0sS0FBSyxPQUFPLENBQUMsR0FBRyxLQUFLLE9BQU8sQ0FBQyxHQUFHLEVBQUUsYUFBYSwrQkFBK0IsQ0FBQyxDQUFDO0FBQUEsTUFDNUksVUFBVSxLQUFLLFNBQVMsS0FBSyxNQUFNLENBQUMsS0FBSyxNQUFNLEtBQUssT0FBTyxDQUFDLEdBQUcsS0FBSyxPQUFPLENBQUMsR0FBRyxFQUFFLGFBQWEsZ0RBQWdELENBQUMsQ0FBQztBQUFBLE1BQ2hKLHNCQUFzQixLQUFLLFNBQVMsS0FBSyxNQUFNLENBQUMsS0FBSyxNQUFNLEtBQUssT0FBTyxDQUFDLEdBQUcsS0FBSyxPQUFPLENBQUMsR0FBRyxFQUFFLGFBQWEsNEJBQTRCLENBQUMsQ0FBQztBQUFBLE1BQ3hJLGdCQUFnQixLQUFLLFNBQVMsS0FBSyxNQUFNLENBQUMsS0FBSyxNQUFNLEtBQUssT0FBTyxDQUFDLEdBQUcsS0FBSyxPQUFPLENBQUMsR0FBRyxFQUFFLGFBQWEseUNBQXlDLENBQUMsQ0FBQztBQUFBLE1BQy9JLFNBQVMsS0FBSyxTQUFTLEtBQUssTUFBTSxDQUFDLEtBQUssTUFBTSxLQUFLLE9BQU8sQ0FBQyxHQUFHLEtBQUssT0FBTyxDQUFDLEdBQUcsRUFBRSxhQUFhLDZCQUE2QixDQUFDLENBQUM7QUFBQSxNQUM1SCxzQkFBc0IsS0FBSyxTQUFTLEtBQUs7QUFBQSxRQUN2QyxLQUFLLE1BQU07QUFBQSxVQUNULEtBQUssT0FBTztBQUFBLFlBQ1YsSUFBSSxLQUFLLE9BQU8sRUFBRSxhQUFhLGlCQUFpQixDQUFDO0FBQUEsWUFDakQsS0FBSyxLQUFLLE9BQU8sRUFBRSxhQUFhLHNCQUFzQixDQUFDO0FBQUEsVUFDekQsQ0FBQztBQUFBLFVBQ0QsS0FBSyxPQUFPLEVBQUUsYUFBYSxtQ0FBOEIsQ0FBQztBQUFBLFFBQzVELENBQUM7QUFBQSxRQUNELEVBQUUsYUFBYSxzQ0FBc0M7QUFBQSxNQUN2RCxDQUFDO0FBQUEsTUFDRCx1QkFBdUIsS0FBSyxTQUFTLEtBQUs7QUFBQSxRQUN4QyxLQUFLLE1BQU07QUFBQSxVQUNULEtBQUssT0FBTztBQUFBLFlBQ1YsSUFBSSxLQUFLLE9BQU8sRUFBRSxhQUFhLGlCQUFpQixDQUFDO0FBQUEsWUFDakQsT0FBTyxLQUFLLE9BQU8sRUFBRSxhQUFhLDBCQUEwQixDQUFDO0FBQUEsVUFDL0QsQ0FBQztBQUFBLFVBQ0QsS0FBSyxPQUFPLEVBQUUsYUFBYSxxQ0FBZ0MsQ0FBQztBQUFBLFFBQzlELENBQUM7QUFBQSxRQUNELEVBQUUsYUFBYSx1Q0FBdUM7QUFBQSxNQUN4RCxDQUFDO0FBQUEsTUFDRCx5QkFBeUIsS0FBSyxTQUFTLEtBQUs7QUFBQSxRQUMxQyxLQUFLLE1BQU07QUFBQSxVQUNULEtBQUssT0FBTztBQUFBLFlBQ1YsSUFBSSxLQUFLLE9BQU8sRUFBRSxhQUFhLGlCQUFpQixDQUFDO0FBQUEsWUFDakQsTUFBTSxLQUFLLE9BQU8sRUFBRSxhQUFhLGVBQWUsQ0FBQztBQUFBLFVBQ25ELENBQUM7QUFBQSxVQUNELEtBQUssT0FBTyxFQUFFLGFBQWEsb0NBQStCLENBQUM7QUFBQSxRQUM3RCxDQUFDO0FBQUEsUUFDRCxFQUFFLGFBQWEsd0NBQXdDO0FBQUEsTUFDekQsQ0FBQztBQUFBLE1BQ0QsZUFBZSxLQUFLLFNBQVMsS0FBSztBQUFBLFFBQ2hDLEtBQUssTUFBTTtBQUFBLFVBQ1QsS0FBSyxPQUFPO0FBQUEsWUFDVixNQUFNLEtBQUssT0FBTyxFQUFFLGFBQWEsWUFBWSxDQUFDO0FBQUEsWUFDOUMsYUFBYSxLQUFLLE9BQU8sRUFBRSxhQUFhLGVBQWUsQ0FBQztBQUFBLFVBQzFELENBQUM7QUFBQSxVQUNELEtBQUssT0FBTyxFQUFFLGFBQWEsNkJBQTZCLENBQUM7QUFBQSxRQUMzRCxDQUFDO0FBQUEsUUFDRCxFQUFFLGFBQWEsbUNBQW1DO0FBQUEsTUFDcEQsQ0FBQztBQUFBLE1BQ0QsVUFBVSxLQUFLLFNBQVMsS0FBSztBQUFBLFFBQzNCLEtBQUssTUFBTTtBQUFBLFVBQ1QsS0FBSyxPQUFPO0FBQUEsWUFDVixPQUFPLEtBQUssT0FBTyxFQUFFLGFBQWEsc0JBQXNCLENBQUM7QUFBQSxZQUN6RCxVQUFVLEtBQUssT0FBTyxFQUFFLGFBQWEsNEJBQTRCLENBQUM7QUFBQSxVQUNwRSxDQUFDO0FBQUEsVUFDRCxLQUFLLE9BQU8sRUFBRSxhQUFhLDRCQUE0QixDQUFDO0FBQUEsUUFDMUQsQ0FBQztBQUFBLFFBQ0QsRUFBRSxhQUFhLHVDQUF1QztBQUFBLE1BQ3hELENBQUM7QUFBQTtBQUFBLE1BRUQsV0FBVyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSw4RkFBOEYsQ0FBQyxDQUFDO0FBQUEsTUFDcEosZUFBZSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSwrRUFBK0UsQ0FBQyxDQUFDO0FBQUEsSUFDM0ksQ0FBQztBQUFBLElBQ0QsU0FBUztBQUFBLEVBQ1g7QUFFQSxLQUFHLGFBQWEsaUJBQWlCO0FBQ2pDLGdCQUFjLElBQUksbUJBQW1CLHNCQUFzQixvQkFBb0I7QUFJL0UsUUFBTSxtQkFBbUIsT0FBTyxhQUFxQixRQUFhLFNBQWtDLFdBQW9CLFNBQWtCO0FBQ3hJLFVBQU0sV0FBVyxjQUFjLElBQUk7QUFDbkMsVUFBTSxjQUFjLE1BQU0sYUFBYSxRQUFRO0FBQy9DLFFBQUksQ0FBQyxhQUFhO0FBQ2hCLGFBQU87QUFBQSxRQUNMLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSwyREFBMkQsQ0FBQztBQUFBLFFBQ3JHLFNBQVMsRUFBRSxXQUFXLGNBQWMsT0FBTyxpQkFBaUI7QUFBQSxNQUM5RDtBQUFBLElBQ0Y7QUFDQSxRQUFJO0FBQ0YsWUFBTSxFQUFFLGdCQUFnQixJQUFJLE1BQU0sT0FBTyx3QkFBd0I7QUFDakUsWUFBTSxFQUFFLHFCQUFxQixJQUFJLE1BQU0sT0FBTyxhQUFhO0FBRTNELFlBQU0sU0FBUyxnQkFBZ0I7QUFBQSxRQUM3QixhQUFhLE9BQU87QUFBQSxRQUNwQixTQUFTLE9BQU87QUFBQSxRQUNoQixRQUFRLE9BQU87QUFBQSxNQUNqQixDQUFDO0FBRUQsVUFBSSxPQUFPLE9BQU87QUFDaEIsZUFBTztBQUFBLFVBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLFVBQVUsT0FBTyxLQUFLLEdBQUcsQ0FBQztBQUFBLFVBQ25FLFNBQVM7QUFBQSxZQUNQLFdBQVc7QUFBQSxZQUNYLE9BQU8sT0FBTztBQUFBLFlBQ2QsV0FBVyxPQUFPLGFBQWE7QUFBQSxVQUNqQztBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBRUEsMkJBQXFCO0FBSXJCLFVBQUk7QUFDRixjQUFNLEVBQUUsYUFBYSxJQUFJLE1BQU0sT0FBTyxjQUFjO0FBQ3BELGNBQU0sYUFBYSxRQUFRO0FBQUEsTUFDN0IsU0FBUyxLQUFLO0FBQ1osaUJBQVMsUUFBUSxtQ0FBb0MsSUFBYyxPQUFPLElBQUksRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBQUEsTUFDMUc7QUFFQSxZQUFNLFNBQVMsT0FBTyxvQkFDbEIsT0FBTyxlQUFlLElBQ3BCLCtCQUErQixPQUFPLFlBQVksbUNBQ2xELHFEQUNGLGFBQWEsT0FBTyxZQUFZO0FBRXBDLGFBQU87QUFBQSxRQUNMLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSxpQkFBaUIsT0FBTyxPQUFPLEtBQUssT0FBTyxXQUFXLGNBQWMsT0FBTyxVQUFVLG9CQUFvQixJQUFJLE1BQU0sR0FBRyxDQUFDO0FBQUEsUUFDaEssU0FBUztBQUFBLFVBQ1AsV0FBVztBQUFBLFVBQ1gsU0FBUyxPQUFPO0FBQUEsVUFDaEIsYUFBYSxPQUFPO0FBQUEsVUFDcEIsUUFBUSxPQUFPO0FBQUEsVUFDZixjQUFjLE9BQU87QUFBQSxVQUNyQixtQkFBbUIsT0FBTztBQUFBLFFBQzVCO0FBQUEsTUFDRjtBQUFBLElBQ0YsU0FBUyxLQUFLO0FBQ1osWUFBTSxNQUFNLGVBQWUsUUFBUSxJQUFJLFVBQVUsT0FBTyxHQUFHO0FBQzNELGVBQVMsUUFBUSwyQkFBMkIsR0FBRyxJQUFJLEVBQUUsTUFBTSxrQkFBa0IsT0FBTyxPQUFPLEdBQUcsRUFBRSxDQUFDO0FBQ2pHLGFBQU87QUFBQSxRQUNMLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSx5QkFBeUIsR0FBRyxHQUFHLENBQUM7QUFBQSxRQUN6RSxTQUFTLEVBQUUsV0FBVyxjQUFjLE9BQU8sSUFBSTtBQUFBLE1BQ2pEO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxLQUFHLGFBQWE7QUFBQSxJQUNkLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0U7QUFBQSxJQUdGLGVBQWU7QUFBQSxJQUNmLGtCQUFrQjtBQUFBLE1BQ2hCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLElBQ0EsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN0QixTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsc0JBQXNCLENBQUM7QUFBQSxNQUMzRCxhQUFhLEtBQUssT0FBTyxFQUFFLGFBQWEsMkJBQTJCLENBQUM7QUFBQSxNQUNwRSxRQUFRLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLGlDQUFpQyxDQUFDLENBQUM7QUFBQSxJQUN0RixDQUFDO0FBQUEsSUFDRCxTQUFTO0FBQUEsRUFDWCxDQUFDO0FBSUQsUUFBTSwyQkFBMkIsT0FBTyxhQUFxQixRQUFhLFNBQWtDLFdBQW9CLFNBQWtCO0FBQ2hKLFVBQU0sRUFBRSx5QkFBeUIsSUFBSSxNQUFNLHNCQUFzQjtBQUNqRSxXQUFPLHlCQUF5QixRQUFRLGNBQWMsSUFBSSxDQUFDO0FBQUEsRUFDN0Q7QUFFQSxRQUFNLHdCQUF3QjtBQUFBLElBQzVCLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0U7QUFBQSxJQUVGLGVBQWU7QUFBQSxJQUNmLGtCQUFrQjtBQUFBLE1BQ2hCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLElBQ0EsWUFBWSxLQUFLLE9BQU87QUFBQTtBQUFBLE1BRXRCLGFBQWEsS0FBSyxPQUFPLEVBQUUsYUFBYSwyQkFBMkIsQ0FBQztBQUFBLE1BQ3BFLE9BQU8sS0FBSyxPQUFPLEVBQUUsYUFBYSxrQkFBa0IsQ0FBQztBQUFBLE1BQ3JELFVBQVUsS0FBSyxPQUFPLEVBQUUsYUFBYSxzREFBc0QsQ0FBQztBQUFBLE1BQzVGLFdBQVcsS0FBSyxPQUFPLEVBQUUsYUFBYSwyREFBMkQsQ0FBQztBQUFBLE1BQ2xHLG9CQUFvQixLQUFLLFFBQVEsRUFBRSxhQUFhLDJJQUFzSSxDQUFDO0FBQUE7QUFBQSxNQUV2TCx3QkFBd0IsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsbUVBQW1FLENBQUMsQ0FBQztBQUFBLE1BQ3RJLHlCQUF5QixLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSw4REFBOEQsQ0FBQyxDQUFDO0FBQUEsTUFDbEkscUJBQXFCLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLGtFQUFrRSxDQUFDLENBQUM7QUFBQSxNQUNsSSxjQUFjLEtBQUssU0FBUyxLQUFLLE1BQU0sS0FBSyxPQUFPLEdBQUcsRUFBRSxhQUFhLGdFQUFnRSxDQUFDLENBQUM7QUFBQSxNQUN2SSxVQUFVLEtBQUssU0FBUyxLQUFLLE1BQU0sS0FBSyxPQUFPLEdBQUcsRUFBRSxhQUFhLHFEQUFxRCxDQUFDLENBQUM7QUFBQSxNQUN4SCxnQkFBZ0IsS0FBSyxTQUFTLEtBQUssTUFBTSxLQUFLLE9BQU8sR0FBRyxFQUFFLGFBQWEsdUNBQXVDLENBQUMsQ0FBQztBQUFBLE1BQ2hILFdBQVcsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsd0NBQXdDLENBQUMsQ0FBQztBQUFBLE1BQzlGLFlBQVksS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsb0NBQW9DLENBQUMsQ0FBQztBQUFBO0FBQUEsTUFFM0YsV0FBVyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSw4RkFBOEYsQ0FBQyxDQUFDO0FBQUEsTUFDcEosZUFBZSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSx3RkFBd0YsQ0FBQyxDQUFDO0FBQUEsSUFDcEosQ0FBQztBQUFBLElBQ0QsU0FBUztBQUFBLEVBQ1g7QUFFQSxLQUFHLGFBQWEscUJBQXFCO0FBQ3JDLGdCQUFjLElBQUksdUJBQXVCLDBCQUEwQix3QkFBd0I7QUFJM0YsUUFBTSwyQkFBMkIsT0FBTyxhQUFxQixRQUFhLFNBQWtDLFdBQW9CLFNBQWtCO0FBQ2hKLFVBQU0sRUFBRSx5QkFBeUIsSUFBSSxNQUFNLHNCQUFzQjtBQUNqRSxXQUFPLHlCQUF5QixRQUFRLGNBQWMsSUFBSSxDQUFDO0FBQUEsRUFDN0Q7QUFFQSxRQUFNLHdCQUF3QjtBQUFBLElBQzVCLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0U7QUFBQSxJQUVGLGVBQWU7QUFBQSxJQUNmLGtCQUFrQjtBQUFBLE1BQ2hCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLElBQ0EsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN0QixhQUFhLEtBQUssT0FBTyxFQUFFLGFBQWEsMkJBQTJCLENBQUM7QUFBQSxNQUNwRSxTQUFTLFdBQVcsQ0FBQyxRQUFRLG1CQUFtQixtQkFBbUIsR0FBRyxFQUFFLGFBQWEscUJBQXFCLENBQUM7QUFBQSxNQUMzRyxrQkFBa0IsS0FBSyxPQUFPLEVBQUUsYUFBYSw2Q0FBNkMsQ0FBQztBQUFBLE1BQzNGLDBCQUEwQixLQUFLLE9BQU8sRUFBRSxhQUFhLHFFQUFxRSxDQUFDO0FBQUEsTUFDM0gsb0JBQW9CLEtBQUssT0FBTyxFQUFFLGFBQWEsbUVBQW1FLENBQUM7QUFBQSxNQUNuSCx1QkFBdUIsS0FBSyxPQUFPLEVBQUUsYUFBYSwwREFBMEQsQ0FBQztBQUFBLE1BQzdHLHFCQUFxQixLQUFLLE9BQU8sRUFBRSxhQUFhLG1EQUFtRCxDQUFDO0FBQUEsTUFDcEcscUJBQXFCLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLDZEQUE2RCxDQUFDLENBQUM7QUFBQSxNQUM3SCxrQkFBa0IsS0FBSyxPQUFPLEVBQUUsYUFBYSw4QkFBOEIsQ0FBQztBQUFBLE1BQzVFLGlCQUFpQixLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSw4REFBOEQsQ0FBQyxDQUFDO0FBQUEsSUFDNUgsQ0FBQztBQUFBLElBQ0QsU0FBUztBQUFBLEVBQ1g7QUFFQSxLQUFHLGFBQWEscUJBQXFCO0FBQ3JDLGdCQUFjLElBQUksdUJBQXVCLDBCQUEwQix3QkFBd0I7QUFJM0YsUUFBTSxxQkFBcUIsT0FBTyxhQUFxQixRQUFhLFNBQWtDLFdBQW9CLFNBQWtCO0FBQzFJLFVBQU0sRUFBRSxtQkFBbUIsSUFBSSxNQUFNLHNCQUFzQjtBQUMzRCxXQUFPLG1CQUFtQixRQUFRLGNBQWMsSUFBSSxDQUFDO0FBQUEsRUFDdkQ7QUFFQSxRQUFNLGtCQUFrQjtBQUFBLElBQ3RCLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0U7QUFBQSxJQUdGLGVBQWU7QUFBQSxJQUNmLGtCQUFrQjtBQUFBLE1BQ2hCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLElBQ0EsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN0QixhQUFhLEtBQUssT0FBTyxFQUFFLGFBQWEsMkJBQTJCLENBQUM7QUFBQSxNQUNwRSxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsc0JBQXNCLENBQUM7QUFBQSxNQUMzRCxlQUFlLEtBQUssT0FBTyxFQUFFLGFBQWEsc0NBQXNDLENBQUM7QUFBQSxNQUNqRixvQkFBb0IsS0FBSyxPQUFPLEVBQUUsYUFBYSw2QkFBNkIsQ0FBQztBQUFBLE1BQzdFLGFBQWEsS0FBSyxPQUFPLEVBQUUsYUFBYSxzQ0FBc0MsQ0FBQztBQUFBLE1BQy9FLGNBQWMsS0FBSztBQUFBLFFBQ2pCLEtBQUssT0FBTztBQUFBLFVBQ1YsUUFBUSxLQUFLLE9BQU8sRUFBRSxhQUFhLHFCQUFxQixDQUFDO0FBQUEsVUFDekQsT0FBTyxLQUFLLE9BQU8sRUFBRSxhQUFhLGFBQWEsQ0FBQztBQUFBLFVBQ2hELGFBQWEsS0FBSyxPQUFPLEVBQUUsYUFBYSxpQ0FBaUMsQ0FBQztBQUFBLFVBQzFFLFVBQVUsS0FBSyxPQUFPLEVBQUUsYUFBYSx1QkFBdUIsQ0FBQztBQUFBLFVBQzdELE9BQU8sS0FBSyxNQUFNLEtBQUssT0FBTyxHQUFHLEVBQUUsYUFBYSx1QkFBdUIsQ0FBQztBQUFBLFVBQ3hFLFFBQVEsS0FBSyxPQUFPLEVBQUUsYUFBYSxnQ0FBZ0MsQ0FBQztBQUFBLFVBQ3BFLFFBQVEsS0FBSyxNQUFNLEtBQUssT0FBTyxHQUFHLEVBQUUsYUFBYSw0QkFBNEIsQ0FBQztBQUFBLFVBQzlFLGdCQUFnQixLQUFLLE1BQU0sS0FBSyxPQUFPLEdBQUcsRUFBRSxhQUFhLHFDQUFxQyxDQUFDO0FBQUEsUUFDakcsQ0FBQztBQUFBLFFBQ0QsRUFBRSxhQUFhLGtEQUFrRDtBQUFBLE1BQ25FO0FBQUEsTUFDQSxnQkFBZ0IsS0FBSyxNQUFNLEtBQUssT0FBTyxHQUFHLEVBQUUsYUFBYSxvQ0FBb0MsQ0FBQztBQUFBO0FBQUEsTUFFOUYsV0FBVyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSw4RkFBOEYsQ0FBQyxDQUFDO0FBQUEsTUFDcEosZUFBZSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxnR0FBZ0csQ0FBQyxDQUFDO0FBQUEsSUFDNUosQ0FBQztBQUFBLElBQ0QsU0FBUztBQUFBLEVBQ1g7QUFFQSxLQUFHLGFBQWEsZUFBZTtBQUMvQixnQkFBYyxJQUFJLGlCQUFpQixvQkFBb0Isa0JBQWtCO0FBSXpFLFFBQU0seUJBQXlCLE9BQU8sYUFBcUIsUUFBYSxTQUFrQyxXQUFvQixTQUFrQjtBQUM5SSxVQUFNLEVBQUUsdUJBQXVCLElBQUksTUFBTSxzQkFBc0I7QUFDL0QsV0FBTyx1QkFBdUIsUUFBUSxjQUFjLElBQUksQ0FBQztBQUFBLEVBQzNEO0FBRUEsUUFBTSxzQkFBc0I7QUFBQSxJQUMxQixNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUNFO0FBQUEsSUFHRixlQUFlO0FBQUEsSUFDZixrQkFBa0I7QUFBQSxNQUNoQjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxJQUNBLFlBQVksS0FBSyxPQUFPO0FBQUEsTUFDdEIsYUFBYSxLQUFLLE9BQU8sRUFBRSxhQUFhLDJCQUEyQixDQUFDO0FBQUEsTUFDcEUsa0JBQWtCLEtBQUssT0FBTyxFQUFFLGFBQWEsK0JBQStCLENBQUM7QUFBQSxNQUM3RSxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsb0VBQW9FLENBQUM7QUFBQSxNQUN6RyxZQUFZLEtBQUssT0FBTyxFQUFFLGFBQWEsMENBQTBDLENBQUM7QUFBQSxNQUNsRixjQUFjLEtBQUssT0FBTztBQUFBLFFBQ3hCLFVBQVUsS0FBSztBQUFBLFVBQ2IsS0FBSyxPQUFPO0FBQUEsWUFDVixTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEscUJBQXFCLENBQUM7QUFBQSxZQUMxRCxPQUFPLEtBQUssT0FBTyxFQUFFLGFBQWEsc0JBQXNCLENBQUM7QUFBQSxZQUN6RCxNQUFNLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLHFCQUFxQixDQUFDLENBQUM7QUFBQSxZQUN0RSxTQUFTLEtBQUssU0FBUyxLQUFLLE1BQU0sS0FBSyxPQUFPLEdBQUcsRUFBRSxhQUFhLHVCQUF1QixDQUFDLENBQUM7QUFBQSxZQUN6RixNQUFNLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLG9CQUFvQixDQUFDLENBQUM7QUFBQSxVQUN2RSxDQUFDO0FBQUEsVUFDRCxFQUFFLGFBQWEsbUJBQW1CO0FBQUEsUUFDcEM7QUFBQSxRQUNBLE9BQU8sS0FBSztBQUFBLFVBQ1YsS0FBSyxPQUFPO0FBQUEsWUFDVixTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsZUFBZSxDQUFDO0FBQUEsWUFDcEQsT0FBTyxLQUFLLE9BQU8sRUFBRSxhQUFhLGtCQUFrQixDQUFDO0FBQUEsWUFDckQsTUFBTSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxhQUFhLENBQUMsQ0FBQztBQUFBLFlBQzlELFNBQVMsS0FBSyxTQUFTLEtBQUssTUFBTSxLQUFLLE9BQU8sR0FBRyxFQUFFLGFBQWEsZUFBZSxDQUFDLENBQUM7QUFBQSxZQUNqRixNQUFNLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLFlBQVksQ0FBQyxDQUFDO0FBQUEsVUFDL0QsQ0FBQztBQUFBLFVBQ0QsRUFBRSxhQUFhLG9CQUFvQjtBQUFBLFFBQ3JDO0FBQUEsUUFDQSxTQUFTLEtBQUssTUFBTSxLQUFLLE9BQU8sR0FBRyxFQUFFLGFBQWEsc0JBQXNCLENBQUM7QUFBQSxNQUMzRSxHQUFHLEVBQUUsYUFBYSx5QkFBeUIsQ0FBQztBQUFBO0FBQUEsTUFFNUMsV0FBVyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSw4RkFBOEYsQ0FBQyxDQUFDO0FBQUEsTUFDcEosZUFBZSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSwrR0FBK0csQ0FBQyxDQUFDO0FBQUEsSUFDM0ssQ0FBQztBQUFBLElBQ0QsU0FBUztBQUFBLEVBQ1g7QUFFQSxLQUFHLGFBQWEsbUJBQW1CO0FBQ25DLGdCQUFjLElBQUkscUJBQXFCLHdCQUF3QixzQkFBc0I7QUFLckYsUUFBTSxvQkFBb0IsT0FBTyxhQUFxQixRQUFhLFNBQWtDLFdBQW9CLFNBQWtCO0FBQ3pJLFVBQU0sV0FBVyxjQUFjLElBQUk7QUFDbkMsVUFBTSxjQUFjLE1BQU0sYUFBYSxRQUFRO0FBQy9DLFFBQUksQ0FBQyxhQUFhO0FBQ2hCLGFBQU87QUFBQSxRQUNMLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSw0REFBNEQsQ0FBQztBQUFBLFFBQ3RHLFNBQVMsRUFBRSxXQUFXLGVBQWUsT0FBTyxpQkFBaUI7QUFBQSxNQUMvRDtBQUFBLElBQ0Y7QUFDQSxRQUFJO0FBQ0YsWUFBTSxFQUFFLGlCQUFpQixJQUFJLE1BQU0sT0FBTyx5QkFBeUI7QUFDbkUsWUFBTSxTQUFTLE1BQU0saUJBQWlCLFFBQVEsUUFBUTtBQUN0RCxVQUFJLFdBQVcsUUFBUTtBQUNyQixlQUFPO0FBQUEsVUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0seUJBQXlCLE9BQU8sS0FBSyxHQUFHLENBQUM7QUFBQSxVQUNsRixTQUFTLEVBQUUsV0FBVyxlQUFlLE9BQU8sT0FBTyxNQUFNO0FBQUEsUUFDM0Q7QUFBQSxNQUNGO0FBQ0EsYUFBTztBQUFBLFFBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLGlCQUFpQixPQUFPLE1BQU0sS0FBSyxPQUFPLE9BQU8sSUFBSSxPQUFPLFdBQVcsSUFBSSxDQUFDO0FBQUEsUUFDckgsU0FBUztBQUFBLFVBQ1AsV0FBVztBQUFBLFVBQ1gsYUFBYSxPQUFPO0FBQUEsVUFDcEIsU0FBUyxPQUFPO0FBQUEsVUFDaEIsUUFBUSxPQUFPO0FBQUEsUUFDakI7QUFBQSxNQUNGO0FBQUEsSUFDRixTQUFTLEtBQUs7QUFDWixZQUFNLE1BQU0sZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUc7QUFDM0QsZUFBUyxRQUFRLDRCQUE0QixHQUFHLElBQUksRUFBRSxNQUFNLG1CQUFtQixPQUFPLE9BQU8sR0FBRyxFQUFFLENBQUM7QUFDbkcsYUFBTztBQUFBLFFBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLHlCQUF5QixHQUFHLEdBQUcsQ0FBQztBQUFBLFFBQ3pFLFNBQVMsRUFBRSxXQUFXLGVBQWUsT0FBTyxJQUFJO0FBQUEsTUFDbEQ7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFFBQU0saUJBQWlCO0FBQUEsSUFDckIsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDRTtBQUFBLElBRUYsZUFBZTtBQUFBLElBQ2Ysa0JBQWtCO0FBQUEsTUFDaEI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsSUFDQSxZQUFZLEtBQUssT0FBTztBQUFBLE1BQ3RCLGFBQWEsS0FBSyxPQUFPLEVBQUUsYUFBYSwyQkFBMkIsQ0FBQztBQUFBLE1BQ3BFLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxzQkFBc0IsQ0FBQztBQUFBLE1BQzNELFFBQVEsS0FBSyxPQUFPLEVBQUUsYUFBYSxxQkFBcUIsQ0FBQztBQUFBLE1BQ3pELFFBQVEsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsK0RBQStELENBQUMsQ0FBQztBQUFBO0FBQUEsTUFFbEgsV0FBVyxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSw4RkFBOEYsQ0FBQyxDQUFDO0FBQUEsTUFDcEosZUFBZSxLQUFLLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxrR0FBa0csQ0FBQyxDQUFDO0FBQUEsSUFDOUosQ0FBQztBQUFBLElBQ0QsU0FBUztBQUFBLEVBQ1g7QUFFQSxLQUFHLGFBQWEsY0FBYztBQUM5QixnQkFBYyxJQUFJLGdCQUFnQixtQkFBbUIsaUJBQWlCO0FBSXRFLFFBQU0scUJBQXFCLE9BQU8sYUFBcUIsUUFBYSxTQUFrQyxXQUFvQixTQUFrQjtBQUMxSSxVQUFNLFdBQVcsY0FBYyxJQUFJO0FBQ25DLFVBQU0sY0FBYyxNQUFNLGFBQWEsUUFBUTtBQUMvQyxRQUFJLENBQUMsYUFBYTtBQUNoQixhQUFPO0FBQUEsUUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0sNkRBQTZELENBQUM7QUFBQSxRQUN2RyxTQUFTLEVBQUUsV0FBVyxnQkFBZ0IsT0FBTyxpQkFBaUI7QUFBQSxNQUNoRTtBQUFBLElBQ0Y7QUFDQSxRQUFJO0FBQ0YsWUFBTSxFQUFFLGtCQUFrQixJQUFJLE1BQU0sT0FBTywwQkFBMEI7QUFDckUsWUFBTSxTQUFTLE1BQU0sa0JBQWtCLFFBQVEsUUFBUTtBQUN2RCxVQUFJLFdBQVcsUUFBUTtBQUNyQixlQUFPO0FBQUEsVUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0sMEJBQTBCLE9BQU8sS0FBSyxHQUFHLENBQUM7QUFBQSxVQUNuRixTQUFTLEVBQUUsV0FBVyxnQkFBZ0IsT0FBTyxPQUFPLE1BQU07QUFBQSxRQUM1RDtBQUFBLE1BQ0Y7QUFDQSxhQUFPO0FBQUEsUUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0sa0JBQWtCLE9BQU8sT0FBTyxLQUFLLE9BQU8sV0FBVyxZQUFZLE9BQU8sVUFBVSx1QkFBdUIsQ0FBQztBQUFBLFFBQ3JKLFNBQVM7QUFBQSxVQUNQLFdBQVc7QUFBQSxVQUNYLGFBQWEsT0FBTztBQUFBLFVBQ3BCLFNBQVMsT0FBTztBQUFBLFVBQ2hCLFlBQVksT0FBTztBQUFBLFFBQ3JCO0FBQUEsTUFDRjtBQUFBLElBQ0YsU0FBUyxLQUFLO0FBQ1osWUFBTSxNQUFNLGVBQWUsUUFBUSxJQUFJLFVBQVUsT0FBTyxHQUFHO0FBQzNELGVBQVMsUUFBUSw2QkFBNkIsR0FBRyxJQUFJLEVBQUUsTUFBTSxvQkFBb0IsT0FBTyxPQUFPLEdBQUcsRUFBRSxDQUFDO0FBQ3JHLGFBQU87QUFBQSxRQUNMLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSwwQkFBMEIsR0FBRyxHQUFHLENBQUM7QUFBQSxRQUMxRSxTQUFTLEVBQUUsV0FBVyxnQkFBZ0IsT0FBTyxJQUFJO0FBQUEsTUFDbkQ7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFFBQU0sa0JBQWtCO0FBQUEsSUFDdEIsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDRTtBQUFBLElBRUYsZUFBZTtBQUFBLElBQ2Ysa0JBQWtCO0FBQUEsTUFDaEI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLElBQ0EsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN0QixhQUFhLEtBQUssT0FBTyxFQUFFLGFBQWEsMkJBQTJCLENBQUM7QUFBQSxNQUNwRSxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsc0JBQXNCLENBQUM7QUFBQSxNQUMzRCxRQUFRLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLGdFQUFnRSxDQUFDLENBQUM7QUFBQTtBQUFBLE1BRW5ILFdBQVcsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsOEZBQThGLENBQUMsQ0FBQztBQUFBLE1BQ3BKLGVBQWUsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsOEZBQThGLENBQUMsQ0FBQztBQUFBLElBQzFKLENBQUM7QUFBQSxJQUNELFNBQVM7QUFBQSxFQUNYO0FBRUEsS0FBRyxhQUFhLGVBQWU7QUFDL0IsZ0JBQWMsSUFBSSxpQkFBaUIsb0JBQW9CLGtCQUFrQjtBQUl6RSxRQUFNLHlCQUF5QixPQUFPLGFBQXFCLFFBQWEsU0FBa0MsV0FBb0IsU0FBa0I7QUFDOUksVUFBTSxXQUFXLGNBQWMsSUFBSTtBQUNuQyxVQUFNLGNBQWMsTUFBTSxhQUFhLFFBQVE7QUFDL0MsUUFBSSxDQUFDLGFBQWE7QUFDaEIsYUFBTztBQUFBLFFBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLGlFQUFpRSxDQUFDO0FBQUEsUUFDM0csU0FBUyxFQUFFLFdBQVcsb0JBQW9CLE9BQU8saUJBQWlCO0FBQUEsTUFDcEU7QUFBQSxJQUNGO0FBQ0EsUUFBSTtBQUNGLFlBQU0sRUFBRSxzQkFBc0IsSUFBSSxNQUFNLE9BQU8sOEJBQThCO0FBQzdFLFlBQU0sU0FBUyxNQUFNLHNCQUFzQixRQUFRLFFBQVE7QUFDM0QsVUFBSSxXQUFXLFFBQVE7QUFDckIsZUFBTztBQUFBLFVBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLDhCQUE4QixPQUFPLEtBQUssR0FBRyxDQUFDO0FBQUEsVUFDdkYsU0FBUyxFQUFFLFdBQVcsb0JBQW9CLE9BQU8sT0FBTyxNQUFNO0FBQUEsUUFDaEU7QUFBQSxNQUNGO0FBQ0EsYUFBTztBQUFBLFFBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLHNCQUFzQixPQUFPLFdBQVcsV0FBVyxPQUFPLFdBQVcsaUJBQWlCLE9BQU8sVUFBVSxZQUFZLENBQUM7QUFBQSxRQUM3SixTQUFTO0FBQUEsVUFDUCxXQUFXO0FBQUEsVUFDWCxhQUFhLE9BQU87QUFBQSxVQUNwQixhQUFhLE9BQU87QUFBQSxVQUNwQixZQUFZLE9BQU87QUFBQSxRQUNyQjtBQUFBLE1BQ0Y7QUFBQSxJQUNGLFNBQVMsS0FBSztBQUNaLFlBQU0sTUFBTSxlQUFlLFFBQVEsSUFBSSxVQUFVLE9BQU8sR0FBRztBQUMzRCxlQUFTLFFBQVEsaUNBQWlDLEdBQUcsSUFBSSxFQUFFLE1BQU0sd0JBQXdCLE9BQU8sT0FBTyxHQUFHLEVBQUUsQ0FBQztBQUM3RyxhQUFPO0FBQUEsUUFDTCxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0sOEJBQThCLEdBQUcsR0FBRyxDQUFDO0FBQUEsUUFDOUUsU0FBUyxFQUFFLFdBQVcsb0JBQW9CLE9BQU8sSUFBSTtBQUFBLE1BQ3ZEO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxRQUFNLHNCQUFzQjtBQUFBLElBQzFCLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQ0U7QUFBQSxJQUVGLGVBQWU7QUFBQSxJQUNmLGtCQUFrQjtBQUFBLE1BQ2hCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLElBQ0EsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN0QixhQUFhLEtBQUssT0FBTyxFQUFFLGFBQWEsMkJBQTJCLENBQUM7QUFBQSxNQUNwRSxRQUFRLEtBQUssU0FBUyxLQUFLLE9BQU8sRUFBRSxhQUFhLG9FQUFvRSxDQUFDLENBQUM7QUFBQTtBQUFBLE1BRXZILFdBQVcsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsOEZBQThGLENBQUMsQ0FBQztBQUFBLE1BQ3BKLGVBQWUsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsNEZBQTRGLENBQUMsQ0FBQztBQUFBLElBQ3hKLENBQUM7QUFBQSxJQUNELFNBQVM7QUFBQSxFQUNYO0FBRUEsS0FBRyxhQUFhLG1CQUFtQjtBQUNuQyxnQkFBYyxJQUFJLHFCQUFxQix3QkFBd0Isc0JBQXNCO0FBSXJGLFFBQU0sd0JBQXdCLE9BQU8sYUFBcUIsUUFBYSxTQUFrQyxXQUFvQixTQUFrQjtBQUM3SSxVQUFNLEVBQUUsc0JBQXNCLElBQUksTUFBTSxzQkFBc0I7QUFDOUQsV0FBTyxzQkFBc0IsUUFBUSxjQUFjLElBQUksQ0FBQztBQUFBLEVBQzFEO0FBRUEsUUFBTSxxQkFBcUI7QUFBQSxJQUN6QixNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUNFO0FBQUEsSUFFRixlQUFlO0FBQUEsSUFDZixrQkFBa0I7QUFBQSxNQUNoQjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsSUFDQSxZQUFZLEtBQUssT0FBTztBQUFBLE1BQ3RCLGFBQWEsS0FBSyxPQUFPLEVBQUUsYUFBYSwyQkFBMkIsQ0FBQztBQUFBLE1BQ3BFLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSxzQkFBc0IsQ0FBQztBQUFBLE1BQzNELFFBQVEsS0FBSyxPQUFPLEVBQUUsYUFBYSw2REFBNkQsQ0FBQztBQUFBLE1BQ2pHLFFBQVEsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsMkNBQTJDLENBQUMsQ0FBQztBQUFBLE1BQzlGLFNBQVMsS0FBSyxPQUFPLEVBQUUsYUFBYSx5QkFBeUIsQ0FBQztBQUFBLE1BQzlELFdBQVcsS0FBSyxPQUFPLEVBQUUsYUFBYSw2QkFBNkIsQ0FBQztBQUFBLE1BQ3BFLFVBQVUsS0FBSyxTQUFTLEtBQUssT0FBTyxFQUFFLGFBQWEsNkJBQTZCLENBQUMsQ0FBQztBQUFBLElBQ3BGLENBQUM7QUFBQSxJQUNELFNBQVM7QUFBQSxJQUNULFdBQVcsTUFBVyxPQUFZO0FBQ2hDLFVBQUksT0FBTyxNQUFNLEdBQUcsYUFBYSxNQUFNLEtBQUssbUJBQW1CLENBQUM7QUFDaEUsY0FBUSxNQUFNLEdBQUcsVUFBVSxLQUFLLFVBQVUsRUFBRTtBQUM1QyxjQUFRLE1BQU0sR0FBRyxPQUFPLFdBQU0sS0FBSyxXQUFXLEVBQUUsRUFBRTtBQUNsRCxhQUFPLElBQUksS0FBSyxNQUFNLEdBQUcsQ0FBQztBQUFBLElBQzVCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFhQSxhQUFhLFFBQWEsVUFBZSxPQUFZO0FBQ25ELFlBQU0sSUFBSSxZQUFZLE1BQU07QUFDNUIsVUFBSSxPQUFPLFdBQVcsR0FBRyxPQUFPO0FBQzlCLGNBQU0sU0FBUyxHQUFHLFNBQVMsT0FBTyxVQUFVLENBQUMsR0FBRyxRQUFRO0FBQ3hELGNBQU0sTUFBTSxPQUFPLFFBQVEsa0JBQWtCLEVBQUU7QUFDL0MsZUFBTyxJQUFJLEtBQUssTUFBTSxHQUFHLFNBQVMsVUFBVSxHQUFHLEVBQUUsR0FBRyxHQUFHLENBQUM7QUFBQSxNQUMxRDtBQUNBLFVBQUksQ0FBQyxHQUFHLFVBQVUsQ0FBQyxHQUFHLFNBQVM7QUFDN0IsY0FBTSxPQUFPLE9BQU8sVUFBVSxDQUFDLEdBQUcsUUFBUTtBQUMxQyxlQUFPLElBQUksS0FBSyxNQUFNLEdBQUcsV0FBVyxJQUFJLEdBQUcsR0FBRyxDQUFDO0FBQUEsTUFDakQ7QUFDQSxZQUFNLFFBQVEsRUFBRSxZQUFZLFNBQVMsWUFBWTtBQUNqRCxhQUFPLElBQUksS0FBSyxNQUFNLEdBQUcsT0FBTyxHQUFHLEVBQUUsTUFBTSxLQUFLLEVBQUUsT0FBTyxFQUFFLEdBQUcsR0FBRyxDQUFDO0FBQUEsSUFDcEU7QUFBQSxFQUNGO0FBRUEsS0FBRyxhQUFhLGtCQUFrQjtBQUNwQzsiLAogICJuYW1lcyI6IFtdCn0K
