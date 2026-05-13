import { existsSync, readFileSync } from "node:fs";
import { parseProject, parseRequirements, parseRoadmap } from "./parsers.js";
const REQUIRED_PROJECT_SECTIONS = [
  "What This Is",
  "Core Value",
  "Current State",
  "Architecture / Key Patterns",
  "Capability Contract",
  "Milestone Sequence"
];
const REQUIRED_REQUIREMENTS_SECTIONS = [
  "Active",
  "Validated",
  "Deferred",
  "Out of Scope",
  "Traceability",
  "Coverage Summary"
];
const REQUIRED_ROADMAP_SECTIONS = ["Definition of Done"];
const ROADMAP_SLICE_SECTIONS = ["Slices", "Slice Overview"];
const ALLOWED_REQUIREMENT_CLASSES = /* @__PURE__ */ new Set([
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
]);
const STATUS_TO_SECTION = {
  active: "Active",
  validated: "Validated",
  deferred: "Deferred",
  "out-of-scope": "Out of Scope"
};
function loadFile(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
function err(code, message, location) {
  return location ? { code, message, location } : { code, message };
}
function validateProjectContent(content) {
  const errors = [];
  const warnings = [];
  const parsed = parseProject(content);
  for (const required of REQUIRED_PROJECT_SECTIONS) {
    if (!(required in parsed.sections)) {
      errors.push(err("missing-section", `Missing required section "## ${required}"`, required));
    }
  }
  for (const sectionName of parsed.sectionsWithTokens) {
    errors.push(err("template-token", `Section "${sectionName}" contains unsubstituted {{...}} template tokens`, sectionName));
  }
  for (const required of REQUIRED_PROJECT_SECTIONS) {
    const body = parsed.sections[required];
    if (body !== void 0 && body.trim() === "") {
      errors.push(err("empty-section", `Section "## ${required}" is empty`, required));
    }
  }
  if (parsed.milestones.length === 0 && "Milestone Sequence" in parsed.sections) {
    errors.push(err("no-milestones", "Milestone Sequence has no entries", "Milestone Sequence"));
  }
  const seen = /* @__PURE__ */ new Set();
  let prevNum = 0;
  for (const m of parsed.milestones) {
    if (seen.has(m.id)) {
      errors.push(err("duplicate-milestone", `Duplicate milestone ID ${m.id}`, "Milestone Sequence"));
    }
    seen.add(m.id);
    const num = parseInt(m.id.slice(1), 10);
    if (num !== prevNum + 1) {
      warnings.push(err("non-monotonic-milestone", `Milestone ${m.id} is not monotonically numbered (expected M${String(prevNum + 1).padStart(3, "0")})`, "Milestone Sequence"));
    }
    prevNum = num;
    if (!m.title || !m.oneLiner) {
      errors.push(err("incomplete-milestone", `Milestone ${m.id} is missing title or one-liner`, "Milestone Sequence"));
    }
  }
  const capabilityBody = parsed.sections["Capability Contract"] ?? "";
  if (capabilityBody && !capabilityBody.includes("REQUIREMENTS.md")) {
    warnings.push(err("missing-requirements-ref", "Capability Contract section should reference .gsd/REQUIREMENTS.md", "Capability Contract"));
  }
  return { ok: errors.length === 0, errors, warnings };
}
function parseSliceList(raw) {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "\u2014" || trimmed === "-" || trimmed.toLowerCase() === "none") return [];
  return trimmed.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}
function validateRequirementsContent(content, projectContent, roadmapsByMilestone) {
  const errors = [];
  const warnings = [];
  const parsed = parseRequirements(content);
  for (const required of REQUIRED_REQUIREMENTS_SECTIONS) {
    if (!(required in parsed.sections)) {
      errors.push(err("missing-section", `Missing required section "## ${required}"`, required));
    }
  }
  for (const sectionName of Object.keys(parsed.sections)) {
    const body = parsed.sections[sectionName];
    if (/\{\{[^}]+\}\}/.test(body)) {
      errors.push(err("template-token", `Section "${sectionName}" contains unsubstituted {{...}} template tokens`, sectionName));
    }
  }
  const seenIds = /* @__PURE__ */ new Set();
  let prevNum = 0;
  for (const r of parsed.requirements) {
    if (seenIds.has(r.id)) {
      errors.push(err("duplicate-requirement", `Duplicate requirement ID ${r.id}`, r.id));
    }
    seenIds.add(r.id);
    const num = parseInt(r.id.slice(1), 10);
    if (num <= prevNum) {
      warnings.push(err("non-monotonic-requirement", `Requirement ${r.id} is not monotonically numbered`, r.id));
    }
    prevNum = num;
    validateRequirementShape(r, errors, warnings);
  }
  const milestoneIds = projectContent ? new Set(parseProject(projectContent).milestones.map((m) => m.id)) : new Set(Array.from(roadmapsByMilestone.keys()));
  const canValidateMilestones = projectContent !== null || roadmapsByMilestone.size > 0;
  const checkRef = (requirementId, ref, field) => {
    if (field === "primaryOwner" && /^(none yet|none)$/.test(ref)) return;
    const milestoneOnly = ref.match(/^(M\d{3})$/);
    if (milestoneOnly) {
      if (canValidateMilestones && !milestoneIds.has(milestoneOnly[1])) {
        errors.push(err("dangling-owner", `Requirement ${requirementId} ${field} references non-existent milestone ${milestoneOnly[1]}`, requirementId));
      }
      return;
    }
    const m = ref.match(/^(M\d{3})\/(S\d{2}|none yet)$/);
    if (!m) {
      warnings.push(err("malformed-slice-ref", `Requirement ${requirementId} ${field} value "${ref}" does not match expected M###/S## format`, requirementId));
      return;
    }
    const [, milestoneId, sliceHalf] = m;
    if (canValidateMilestones && !milestoneIds.has(milestoneId)) {
      errors.push(err("dangling-owner", `Requirement ${requirementId} ${field} references non-existent milestone ${milestoneId}`, requirementId));
      return;
    }
    if (sliceHalf === "none yet") return;
    const roadmap = roadmapsByMilestone.get(milestoneId);
    if (!roadmap) return;
    const sliceExists = roadmap.slices.some((s) => s.id === sliceHalf);
    if (!sliceExists) {
      errors.push(err(
        "dangling-slice-ref",
        `Requirement ${requirementId} ${field} references slice ${milestoneId}/${sliceHalf} which does not exist in that milestone's roadmap`,
        requirementId
      ));
    }
  };
  for (const r of parsed.requirements) {
    if (r.primaryOwner) checkRef(r.id, r.primaryOwner, "primaryOwner");
    for (const ref of parseSliceList(r.supportingSlices)) {
      checkRef(r.id, ref, "supportingSlices");
    }
  }
  const sectionCounts = { Active: 0, Validated: 0, Deferred: 0, "Out of Scope": 0 };
  for (const r of parsed.requirements) sectionCounts[r.parentSection] = (sectionCounts[r.parentSection] ?? 0) + 1;
  const expectedActive = sectionCounts.Active;
  const reportedActive = parsed.coverageSummary["Active requirements"];
  if (reportedActive !== void 0 && parseInt(reportedActive, 10) !== expectedActive) {
    warnings.push(err("coverage-mismatch", `Coverage Summary says Active=${reportedActive} but ${expectedActive} entries found in ## Active`, "Coverage Summary"));
  }
  return { ok: errors.length === 0, errors, warnings };
}
function validateRequirementShape(r, errors, warnings) {
  const required = [
    "class",
    "status",
    "description",
    "whyItMatters",
    "source",
    "primaryOwner",
    "validation"
  ];
  for (const field of required) {
    if (!r[field] || r[field].trim() === "") {
      errors.push(err("missing-field", `Requirement ${r.id} is missing field "${field}"`, r.id));
    }
  }
  if (r.class && !ALLOWED_REQUIREMENT_CLASSES.has(r.class)) {
    errors.push(err("invalid-class", `Requirement ${r.id} has invalid class "${r.class}"`, r.id));
  }
  const expectedSection = STATUS_TO_SECTION[r.status];
  if (expectedSection && expectedSection !== r.parentSection) {
    errors.push(err("status-section-mismatch", `Requirement ${r.id} has Status "${r.status}" but lives under "## ${r.parentSection}" (expected "## ${expectedSection}")`, r.id));
  }
  if (r.primaryOwner && !/^(M\d{3}(\/(S\d{2}|none yet))?|none yet|none)$/.test(r.primaryOwner)) {
    warnings.push(err("malformed-owner", `Requirement ${r.id} owner "${r.primaryOwner}" does not match expected formats (M### | M###/S## | M###/none yet | none yet | none)`, r.id));
  }
}
function validateRoadmapContent(content, requirementsContent, currentMilestoneId = null) {
  const errors = [];
  const warnings = [];
  const parsed = parseRoadmap(content);
  for (const required of REQUIRED_ROADMAP_SECTIONS) {
    if (!(required in parsed.sections)) {
      errors.push(err("missing-section", `Missing required section "## ${required}"`, required));
    }
  }
  const hasSliceSection = ROADMAP_SLICE_SECTIONS.some((name) => name in parsed.sections);
  if (!hasSliceSection) {
    errors.push(err("missing-section", `Missing slice section \u2014 expected "## Slices" or "## Slice Overview"`));
  }
  for (const sectionName of Object.keys(parsed.sections)) {
    const body = parsed.sections[sectionName];
    if (/\{\{[^}]+\}\}/.test(body)) {
      errors.push(err("template-token", `Section "${sectionName}" contains unsubstituted {{...}} template tokens`, sectionName));
    }
  }
  if (parsed.slices.length === 0 && hasSliceSection) {
    const sliceSection = ROADMAP_SLICE_SECTIONS.find((name) => name in parsed.sections) ?? "Slices";
    errors.push(err("no-slices", `${sliceSection} section has no entries`, sliceSection));
  }
  for (const m of parsed.malformedDepends) {
    warnings.push(err(
      "malformed-depends",
      `Slice ${m.sliceId} has malformed Depends value(s) that were dropped from the graph: ${m.values.join(", ")}`,
      m.sliceId
    ));
  }
  if (parsed.definitionOfDone.length === 0 && "Definition of Done" in parsed.sections) {
    errors.push(err("no-definition-of-done", "Definition of Done has no items", "Definition of Done"));
  }
  const seenIds = /* @__PURE__ */ new Set();
  let prevNum = 0;
  for (const s of parsed.slices) {
    if (seenIds.has(s.id)) {
      errors.push(err("duplicate-slice", `Duplicate slice ID ${s.id}`, s.id));
    }
    seenIds.add(s.id);
    const num = parseInt(s.id.slice(1), 10);
    if (num !== prevNum + 1) {
      warnings.push(err("non-monotonic-slice", `Slice ${s.id} is not monotonically numbered (expected S${String(prevNum + 1).padStart(2, "0")})`, s.id));
    }
    prevNum = num;
    if (!s.risk || !s.demo) {
      errors.push(err("missing-slice-field", `Slice ${s.id} is missing required field (risk and demo are required)`, s.id));
    }
  }
  const sliceIds = new Set(parsed.slices.map((s) => s.id));
  for (const s of parsed.slices) {
    for (const dep of s.depends) {
      if (!sliceIds.has(dep)) {
        errors.push(err("dangling-dependency", `Slice ${s.id} depends on non-existent slice ${dep}`, s.id));
      }
    }
  }
  if (hasCycle(parsed.slices)) {
    errors.push(err("circular-dependency", "Slice depends graph contains a cycle"));
  }
  if (requirementsContent) {
    const reqs = parseRequirements(requirementsContent);
    for (const s of parsed.slices) {
      const ownsAnyRequirement = reqs.requirements.some((r) => {
        if (r.parentSection !== "Active") return false;
        const m = r.primaryOwner.match(/^(M\d{3})\/(S\d{2})$/);
        if (!m) return false;
        if (currentMilestoneId !== null && m[1] !== currentMilestoneId) return false;
        return m[2] === s.id;
      });
      if (!ownsAnyRequirement) {
        warnings.push(err("orphan-slice", `Slice ${s.id} owns no Active requirements`, s.id));
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
function hasCycle(slices) {
  const map = new Map(slices.map((s) => [s.id, s.depends]));
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  function dfs(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of map.get(id) ?? []) {
      if (dfs(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  for (const s of slices) {
    if (dfs(s.id)) return true;
  }
  return false;
}
function validateArtifact(filePath, kind, opts = {}) {
  const content = loadFile(filePath);
  if (content === null) {
    return {
      ok: false,
      errors: [err("file-missing", `Artifact file not found: ${filePath}`, filePath)],
      warnings: []
    };
  }
  switch (kind) {
    case "project":
      return validateProjectContent(content);
    case "requirements": {
      const projectContent = opts.crossRefs?.projectPath ? loadFile(opts.crossRefs.projectPath) : null;
      const roadmapsByMilestone = /* @__PURE__ */ new Map();
      const roadmapPaths = opts.crossRefs?.roadmapPaths ?? {};
      for (const [mid, path] of Object.entries(roadmapPaths)) {
        const c = loadFile(path);
        if (c) roadmapsByMilestone.set(mid, parseRoadmap(c));
      }
      return validateRequirementsContent(content, projectContent, roadmapsByMilestone);
    }
    case "roadmap":
      return validateRoadmapContent(
        content,
        opts.crossRefs?.requirementsPath ? loadFile(opts.crossRefs.requirementsPath) : null,
        opts.milestoneId ?? filePath.match(/(?:^|[\\/])(M\d{3})(?:[\\/]|-)/)?.[1] ?? null
      );
  }
}
export {
  validateArtifact
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9zY2hlbWFzL3ZhbGlkYXRlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBnc2QtMiAvIERlZXAgcGxhbm5pbmcgbW9kZSBcdTIwMTQgQXJ0aWZhY3QgdmFsaWRhdG9yIGVudHJ5IHBvaW50LlxuLy9cbi8vIFZhbGlkYXRlcyBQUk9KRUNULm1kLCBSRVFVSVJFTUVOVFMubWQsIGFuZCBwZXItbWlsZXN0b25lIFJPQURNQVAubWRcbi8vIGFnYWluc3QgdGhlIGNvbnRyYWN0IHNwZWMgaW4gLnBsYW5uaW5nL3BoYXNlcy8xMS1kZWVwLXBsYW5uaW5nLW1vZGUvMTEtQ09OVFJBQ1RTLm1kLlxuLy8gVXNlZCBieSBkZWVwLW1vZGUgZGlzcGF0Y2ggcnVsZXMgdG8gZ2F0ZSBzdGFnZSBjb21wbGV0aW9uIGFuZCBieSBsaWdodCBtb2RlXG4vLyBhdXRvLXN0YXJ0IHRvIGNhdGNoIG1hbGZvcm1lZCBhcnRpZmFjdHMgZWFybHkuXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBwYXJzZVByb2plY3QsIHBhcnNlUmVxdWlyZW1lbnRzLCBwYXJzZVJvYWRtYXAgfSBmcm9tIFwiLi9wYXJzZXJzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFBhcnNlZFJlcXVpcmVtZW50IH0gZnJvbSBcIi4vcGFyc2Vycy5qc1wiO1xuXG5leHBvcnQgdHlwZSBBcnRpZmFjdEtpbmQgPSBcInByb2plY3RcIiB8IFwicmVxdWlyZW1lbnRzXCIgfCBcInJvYWRtYXBcIjtcblxuZXhwb3J0IGludGVyZmFjZSBWYWxpZGF0aW9uRXJyb3Ige1xuICBjb2RlOiBzdHJpbmc7XG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgbG9jYXRpb24/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVmFsaWRhdGlvblJlc3VsdCB7XG4gIG9rOiBib29sZWFuO1xuICBlcnJvcnM6IFZhbGlkYXRpb25FcnJvcltdO1xuICB3YXJuaW5nczogVmFsaWRhdGlvbkVycm9yW107XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVmFsaWRhdGVPcHRpb25zIHtcbiAgLyoqIE1pbGVzdG9uZSBJRCAoZm9yIGV4YW1wbGUgXCJNMDAxXCIpIGZvciB0aGUgcm9hZG1hcCBiZWluZyB2YWxpZGF0ZWQuICovXG4gIG1pbGVzdG9uZUlkPzogc3RyaW5nO1xuICBjcm9zc1JlZnM/OiB7XG4gICAgcHJvamVjdFBhdGg/OiBzdHJpbmc7XG4gICAgcmVxdWlyZW1lbnRzUGF0aD86IHN0cmluZztcbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBwZXItbWlsZXN0b25lIHJvYWRtYXAgcGF0aHMuIFdoZW4gc3VwcGxpZWQsIHJlcXVpcmVtZW50XG4gICAgICogcHJpbWFyeU93bmVyIC8gc3VwcG9ydGluZ1NsaWNlcyBlbnRyaWVzIGFyZSBjaGVja2VkIGZvciBzbGljZS1oYWxmXG4gICAgICogKFMjIykgZXhpc3RlbmNlIGluIHRoZSBuYW1lZCBtaWxlc3RvbmUncyByb2FkbWFwLiBXaXRob3V0IHRoaXMsXG4gICAgICogb25seSB0aGUgbWlsZXN0b25lIGhhbGYgKE0jIyMpIGlzIHZhbGlkYXRlZC5cbiAgICAgKi9cbiAgICByb2FkbWFwUGF0aHM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICB9O1xufVxuXG5jb25zdCBSRVFVSVJFRF9QUk9KRUNUX1NFQ1RJT05TID0gW1xuICBcIldoYXQgVGhpcyBJc1wiLFxuICBcIkNvcmUgVmFsdWVcIixcbiAgXCJDdXJyZW50IFN0YXRlXCIsXG4gIFwiQXJjaGl0ZWN0dXJlIC8gS2V5IFBhdHRlcm5zXCIsXG4gIFwiQ2FwYWJpbGl0eSBDb250cmFjdFwiLFxuICBcIk1pbGVzdG9uZSBTZXF1ZW5jZVwiLFxuXTtcblxuY29uc3QgUkVRVUlSRURfUkVRVUlSRU1FTlRTX1NFQ1RJT05TID0gW1xuICBcIkFjdGl2ZVwiLFxuICBcIlZhbGlkYXRlZFwiLFxuICBcIkRlZmVycmVkXCIsXG4gIFwiT3V0IG9mIFNjb3BlXCIsXG4gIFwiVHJhY2VhYmlsaXR5XCIsXG4gIFwiQ292ZXJhZ2UgU3VtbWFyeVwiLFxuXTtcblxuLy8gUm9hZG1hcCBzZWN0aW9uIHJlcXVpcmVtZW50czpcbi8vICAgLSBcIlNsaWNlc1wiIChsZWdhY3kgSDMgZm9ybWF0KSBPUiBcIlNsaWNlIE92ZXJ2aWV3XCIgKHRhYmxlIGZvcm1hdFxuLy8gICAgIGVtaXR0ZWQgYnkgd29ya2Zsb3ctcHJvamVjdGlvbnMudHMpIFx1MjAxNCBhdCBsZWFzdCBvbmUgbXVzdCBiZSBwcmVzZW50LlxuLy8gICAtIFwiRGVmaW5pdGlvbiBvZiBEb25lXCIgXHUyMDE0IGFsd2F5cyByZXF1aXJlZC5cbi8vIERlZmVuc2l2ZSBwYXJzaW5nIGFjY2VwdHMgYm90aCBzaGFwZXM7IHRoZSB2YWxpZGF0b3IgZG9lcyB0aGUgc2FtZS5cbmNvbnN0IFJFUVVJUkVEX1JPQURNQVBfU0VDVElPTlMgPSBbXCJEZWZpbml0aW9uIG9mIERvbmVcIl07XG5jb25zdCBST0FETUFQX1NMSUNFX1NFQ1RJT05TID0gW1wiU2xpY2VzXCIsIFwiU2xpY2UgT3ZlcnZpZXdcIl07XG5cbmNvbnN0IEFMTE9XRURfUkVRVUlSRU1FTlRfQ0xBU1NFUyA9IG5ldyBTZXQoW1xuICBcImNvcmUtY2FwYWJpbGl0eVwiLFxuICBcInByaW1hcnktdXNlci1sb29wXCIsXG4gIFwibGF1bmNoYWJpbGl0eVwiLFxuICBcImNvbnRpbnVpdHlcIixcbiAgXCJmYWlsdXJlLXZpc2liaWxpdHlcIixcbiAgXCJpbnRlZ3JhdGlvblwiLFxuICBcInF1YWxpdHktYXR0cmlidXRlXCIsXG4gIFwib3BlcmFiaWxpdHlcIixcbiAgXCJhZG1pbi9zdXBwb3J0XCIsXG4gIFwiY29tcGxpYW5jZS9zZWN1cml0eVwiLFxuICBcImRpZmZlcmVudGlhdG9yXCIsXG4gIFwiY29uc3RyYWludFwiLFxuICBcImFudGktZmVhdHVyZVwiLFxuXSk7XG5cbmNvbnN0IFNUQVRVU19UT19TRUNUSU9OOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBhY3RpdmU6IFwiQWN0aXZlXCIsXG4gIHZhbGlkYXRlZDogXCJWYWxpZGF0ZWRcIixcbiAgZGVmZXJyZWQ6IFwiRGVmZXJyZWRcIixcbiAgXCJvdXQtb2Ytc2NvcGVcIjogXCJPdXQgb2YgU2NvcGVcIixcbn07XG5cbmZ1bmN0aW9uIGxvYWRGaWxlKHBhdGg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIHJldHVybiByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gZXJyKGNvZGU6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nLCBsb2NhdGlvbj86IHN0cmluZyk6IFZhbGlkYXRpb25FcnJvciB7XG4gIHJldHVybiBsb2NhdGlvbiA/IHsgY29kZSwgbWVzc2FnZSwgbG9jYXRpb24gfSA6IHsgY29kZSwgbWVzc2FnZSB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUFJPSkVDVC5tZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gdmFsaWRhdGVQcm9qZWN0Q29udGVudChjb250ZW50OiBzdHJpbmcpOiBWYWxpZGF0aW9uUmVzdWx0IHtcbiAgY29uc3QgZXJyb3JzOiBWYWxpZGF0aW9uRXJyb3JbXSA9IFtdO1xuICBjb25zdCB3YXJuaW5nczogVmFsaWRhdGlvbkVycm9yW10gPSBbXTtcbiAgY29uc3QgcGFyc2VkID0gcGFyc2VQcm9qZWN0KGNvbnRlbnQpO1xuXG4gIGZvciAoY29uc3QgcmVxdWlyZWQgb2YgUkVRVUlSRURfUFJPSkVDVF9TRUNUSU9OUykge1xuICAgIGlmICghKHJlcXVpcmVkIGluIHBhcnNlZC5zZWN0aW9ucykpIHtcbiAgICAgIGVycm9ycy5wdXNoKGVycihcIm1pc3Npbmctc2VjdGlvblwiLCBgTWlzc2luZyByZXF1aXJlZCBzZWN0aW9uIFwiIyMgJHtyZXF1aXJlZH1cImAsIHJlcXVpcmVkKSk7XG4gICAgfVxuICB9XG5cbiAgZm9yIChjb25zdCBzZWN0aW9uTmFtZSBvZiBwYXJzZWQuc2VjdGlvbnNXaXRoVG9rZW5zKSB7XG4gICAgZXJyb3JzLnB1c2goZXJyKFwidGVtcGxhdGUtdG9rZW5cIiwgYFNlY3Rpb24gXCIke3NlY3Rpb25OYW1lfVwiIGNvbnRhaW5zIHVuc3Vic3RpdHV0ZWQge3suLi59fSB0ZW1wbGF0ZSB0b2tlbnNgLCBzZWN0aW9uTmFtZSkpO1xuICB9XG5cbiAgZm9yIChjb25zdCByZXF1aXJlZCBvZiBSRVFVSVJFRF9QUk9KRUNUX1NFQ1RJT05TKSB7XG4gICAgY29uc3QgYm9keSA9IHBhcnNlZC5zZWN0aW9uc1tyZXF1aXJlZF07XG4gICAgaWYgKGJvZHkgIT09IHVuZGVmaW5lZCAmJiBib2R5LnRyaW0oKSA9PT0gXCJcIikge1xuICAgICAgZXJyb3JzLnB1c2goZXJyKFwiZW1wdHktc2VjdGlvblwiLCBgU2VjdGlvbiBcIiMjICR7cmVxdWlyZWR9XCIgaXMgZW1wdHlgLCByZXF1aXJlZCkpO1xuICAgIH1cbiAgfVxuXG4gIGlmIChwYXJzZWQubWlsZXN0b25lcy5sZW5ndGggPT09IDAgJiYgXCJNaWxlc3RvbmUgU2VxdWVuY2VcIiBpbiBwYXJzZWQuc2VjdGlvbnMpIHtcbiAgICBlcnJvcnMucHVzaChlcnIoXCJuby1taWxlc3RvbmVzXCIsIFwiTWlsZXN0b25lIFNlcXVlbmNlIGhhcyBubyBlbnRyaWVzXCIsIFwiTWlsZXN0b25lIFNlcXVlbmNlXCIpKTtcbiAgfVxuXG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgbGV0IHByZXZOdW0gPSAwO1xuICBmb3IgKGNvbnN0IG0gb2YgcGFyc2VkLm1pbGVzdG9uZXMpIHtcbiAgICBpZiAoc2Vlbi5oYXMobS5pZCkpIHtcbiAgICAgIGVycm9ycy5wdXNoKGVycihcImR1cGxpY2F0ZS1taWxlc3RvbmVcIiwgYER1cGxpY2F0ZSBtaWxlc3RvbmUgSUQgJHttLmlkfWAsIFwiTWlsZXN0b25lIFNlcXVlbmNlXCIpKTtcbiAgICB9XG4gICAgc2Vlbi5hZGQobS5pZCk7XG4gICAgY29uc3QgbnVtID0gcGFyc2VJbnQobS5pZC5zbGljZSgxKSwgMTApO1xuICAgIGlmIChudW0gIT09IHByZXZOdW0gKyAxKSB7XG4gICAgICB3YXJuaW5ncy5wdXNoKGVycihcIm5vbi1tb25vdG9uaWMtbWlsZXN0b25lXCIsIGBNaWxlc3RvbmUgJHttLmlkfSBpcyBub3QgbW9ub3RvbmljYWxseSBudW1iZXJlZCAoZXhwZWN0ZWQgTSR7U3RyaW5nKHByZXZOdW0gKyAxKS5wYWRTdGFydCgzLCBcIjBcIil9KWAsIFwiTWlsZXN0b25lIFNlcXVlbmNlXCIpKTtcbiAgICB9XG4gICAgcHJldk51bSA9IG51bTtcbiAgICBpZiAoIW0udGl0bGUgfHwgIW0ub25lTGluZXIpIHtcbiAgICAgIGVycm9ycy5wdXNoKGVycihcImluY29tcGxldGUtbWlsZXN0b25lXCIsIGBNaWxlc3RvbmUgJHttLmlkfSBpcyBtaXNzaW5nIHRpdGxlIG9yIG9uZS1saW5lcmAsIFwiTWlsZXN0b25lIFNlcXVlbmNlXCIpKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBjYXBhYmlsaXR5Qm9keSA9IHBhcnNlZC5zZWN0aW9uc1tcIkNhcGFiaWxpdHkgQ29udHJhY3RcIl0gPz8gXCJcIjtcbiAgaWYgKGNhcGFiaWxpdHlCb2R5ICYmICFjYXBhYmlsaXR5Qm9keS5pbmNsdWRlcyhcIlJFUVVJUkVNRU5UUy5tZFwiKSkge1xuICAgIHdhcm5pbmdzLnB1c2goZXJyKFwibWlzc2luZy1yZXF1aXJlbWVudHMtcmVmXCIsIFwiQ2FwYWJpbGl0eSBDb250cmFjdCBzZWN0aW9uIHNob3VsZCByZWZlcmVuY2UgLmdzZC9SRVFVSVJFTUVOVFMubWRcIiwgXCJDYXBhYmlsaXR5IENvbnRyYWN0XCIpKTtcbiAgfVxuXG4gIHJldHVybiB7IG9rOiBlcnJvcnMubGVuZ3RoID09PSAwLCBlcnJvcnMsIHdhcm5pbmdzIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSRVFVSVJFTUVOVFMubWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHBhcnNlU2xpY2VMaXN0KHJhdzogc3RyaW5nKTogc3RyaW5nW10ge1xuICAvLyBlLmcuIFwiTTAwMS9TMDIsIE0wMDIvUzAzXCIgb3IgXCJcdTIwMTRcIiBvciBcIm5vbmVcIlxuICBpZiAoIXJhdykgcmV0dXJuIFtdO1xuICBjb25zdCB0cmltbWVkID0gcmF3LnRyaW0oKTtcbiAgaWYgKCF0cmltbWVkIHx8IHRyaW1tZWQgPT09IFwiXHUyMDE0XCIgfHwgdHJpbW1lZCA9PT0gXCItXCIgfHwgdHJpbW1lZC50b0xvd2VyQ2FzZSgpID09PSBcIm5vbmVcIikgcmV0dXJuIFtdO1xuICByZXR1cm4gdHJpbW1lZC5zcGxpdCgvWyxcXHNdKy8pLm1hcChzID0+IHMudHJpbSgpKS5maWx0ZXIoQm9vbGVhbik7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUmVxdWlyZW1lbnRzQ29udGVudChcbiAgY29udGVudDogc3RyaW5nLFxuICBwcm9qZWN0Q29udGVudDogc3RyaW5nIHwgbnVsbCxcbiAgcm9hZG1hcHNCeU1pbGVzdG9uZTogTWFwPHN0cmluZywgUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VSb2FkbWFwPj4sXG4pOiBWYWxpZGF0aW9uUmVzdWx0IHtcbiAgY29uc3QgZXJyb3JzOiBWYWxpZGF0aW9uRXJyb3JbXSA9IFtdO1xuICBjb25zdCB3YXJuaW5nczogVmFsaWRhdGlvbkVycm9yW10gPSBbXTtcbiAgY29uc3QgcGFyc2VkID0gcGFyc2VSZXF1aXJlbWVudHMoY29udGVudCk7XG5cbiAgZm9yIChjb25zdCByZXF1aXJlZCBvZiBSRVFVSVJFRF9SRVFVSVJFTUVOVFNfU0VDVElPTlMpIHtcbiAgICBpZiAoIShyZXF1aXJlZCBpbiBwYXJzZWQuc2VjdGlvbnMpKSB7XG4gICAgICBlcnJvcnMucHVzaChlcnIoXCJtaXNzaW5nLXNlY3Rpb25cIiwgYE1pc3NpbmcgcmVxdWlyZWQgc2VjdGlvbiBcIiMjICR7cmVxdWlyZWR9XCJgLCByZXF1aXJlZCkpO1xuICAgIH1cbiAgfVxuXG4gIGZvciAoY29uc3Qgc2VjdGlvbk5hbWUgb2YgT2JqZWN0LmtleXMocGFyc2VkLnNlY3Rpb25zKSkge1xuICAgIGNvbnN0IGJvZHkgPSBwYXJzZWQuc2VjdGlvbnNbc2VjdGlvbk5hbWVdO1xuICAgIGlmICgvXFx7XFx7W159XStcXH1cXH0vLnRlc3QoYm9keSkpIHtcbiAgICAgIGVycm9ycy5wdXNoKGVycihcInRlbXBsYXRlLXRva2VuXCIsIGBTZWN0aW9uIFwiJHtzZWN0aW9uTmFtZX1cIiBjb250YWlucyB1bnN1YnN0aXR1dGVkIHt7Li4ufX0gdGVtcGxhdGUgdG9rZW5zYCwgc2VjdGlvbk5hbWUpKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBzZWVuSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGxldCBwcmV2TnVtID0gMDtcbiAgZm9yIChjb25zdCByIG9mIHBhcnNlZC5yZXF1aXJlbWVudHMpIHtcbiAgICBpZiAoc2Vlbklkcy5oYXMoci5pZCkpIHtcbiAgICAgIGVycm9ycy5wdXNoKGVycihcImR1cGxpY2F0ZS1yZXF1aXJlbWVudFwiLCBgRHVwbGljYXRlIHJlcXVpcmVtZW50IElEICR7ci5pZH1gLCByLmlkKSk7XG4gICAgfVxuICAgIHNlZW5JZHMuYWRkKHIuaWQpO1xuICAgIGNvbnN0IG51bSA9IHBhcnNlSW50KHIuaWQuc2xpY2UoMSksIDEwKTtcbiAgICBpZiAobnVtIDw9IHByZXZOdW0pIHtcbiAgICAgIHdhcm5pbmdzLnB1c2goZXJyKFwibm9uLW1vbm90b25pYy1yZXF1aXJlbWVudFwiLCBgUmVxdWlyZW1lbnQgJHtyLmlkfSBpcyBub3QgbW9ub3RvbmljYWxseSBudW1iZXJlZGAsIHIuaWQpKTtcbiAgICB9XG4gICAgcHJldk51bSA9IG51bTtcbiAgICB2YWxpZGF0ZVJlcXVpcmVtZW50U2hhcGUociwgZXJyb3JzLCB3YXJuaW5ncyk7XG4gIH1cblxuICBjb25zdCBtaWxlc3RvbmVJZHMgPSBwcm9qZWN0Q29udGVudFxuICAgID8gbmV3IFNldChwYXJzZVByb2plY3QocHJvamVjdENvbnRlbnQpLm1pbGVzdG9uZXMubWFwKG0gPT4gbS5pZCkpXG4gICAgOiBuZXcgU2V0KEFycmF5LmZyb20ocm9hZG1hcHNCeU1pbGVzdG9uZS5rZXlzKCkpKTtcbiAgY29uc3QgY2FuVmFsaWRhdGVNaWxlc3RvbmVzID0gcHJvamVjdENvbnRlbnQgIT09IG51bGwgfHwgcm9hZG1hcHNCeU1pbGVzdG9uZS5zaXplID4gMDtcblxuICAvKipcbiAgICogVmFsaWRhdGUgb25lIFwiTSMjIy9TIyNcIiByZWZlcmVuY2UgKG9yIHBhcnRpYWwpLiBQdXNoZXMgYW4gZXJyb3IgaWZcbiAgICogdGhlIG1pbGVzdG9uZSBpcyBrbm93biB0byBiZSBtaXNzaW5nOyBwdXNoZXMgYW4gZXJyb3IgaWYgYSByb2FkbWFwIGlzIGxvYWRlZFxuICAgKiBmb3IgdGhlIG1pbGVzdG9uZSBhbmQgdGhlIHNsaWNlIGhhbGYgaXMgbWlzc2luZy5cbiAgICovXG4gIGNvbnN0IGNoZWNrUmVmID0gKFxuICAgIHJlcXVpcmVtZW50SWQ6IHN0cmluZyxcbiAgICByZWY6IHN0cmluZyxcbiAgICBmaWVsZDogXCJwcmltYXJ5T3duZXJcIiB8IFwic3VwcG9ydGluZ1NsaWNlc1wiLFxuICApOiB2b2lkID0+IHtcbiAgICAvLyBUb2xlcmF0ZSB0aGUgZG9jdW1lbnRlZCBcIm5vbmUgeWV0XCIgLyBcIm5vbmVcIiBzZW50aW5lbHMgZm9yIHByaW1hcnlPd25lci5cbiAgICBpZiAoZmllbGQgPT09IFwicHJpbWFyeU93bmVyXCIgJiYgL14obm9uZSB5ZXR8bm9uZSkkLy50ZXN0KHJlZikpIHJldHVybjtcbiAgICAvLyBcIk0jIyNcIiBhbG9uZSAobm8gc2xhc2gpIGlzIGFsbG93ZWQgZm9yIHByaW1hcnlPd25lciBzaGFwZTsgc3RpbGwgd2FudFxuICAgIC8vIHRvIGNoZWNrIG1pbGVzdG9uZSBleGlzdGVuY2Ugd2hlbiBwcm9qZWN0L3JvYWRtYXAgY29udGV4dCBpcyBhdmFpbGFibGUuXG4gICAgY29uc3QgbWlsZXN0b25lT25seSA9IHJlZi5tYXRjaCgvXihNXFxkezN9KSQvKTtcbiAgICBpZiAobWlsZXN0b25lT25seSkge1xuICAgICAgaWYgKGNhblZhbGlkYXRlTWlsZXN0b25lcyAmJiAhbWlsZXN0b25lSWRzLmhhcyhtaWxlc3RvbmVPbmx5WzFdKSkge1xuICAgICAgICBlcnJvcnMucHVzaChlcnIoXCJkYW5nbGluZy1vd25lclwiLCBgUmVxdWlyZW1lbnQgJHtyZXF1aXJlbWVudElkfSAke2ZpZWxkfSByZWZlcmVuY2VzIG5vbi1leGlzdGVudCBtaWxlc3RvbmUgJHttaWxlc3RvbmVPbmx5WzFdfWAsIHJlcXVpcmVtZW50SWQpKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgbSA9IHJlZi5tYXRjaCgvXihNXFxkezN9KVxcLyhTXFxkezJ9fG5vbmUgeWV0KSQvKTtcbiAgICBpZiAoIW0pIHtcbiAgICAgIHdhcm5pbmdzLnB1c2goZXJyKFwibWFsZm9ybWVkLXNsaWNlLXJlZlwiLCBgUmVxdWlyZW1lbnQgJHtyZXF1aXJlbWVudElkfSAke2ZpZWxkfSB2YWx1ZSBcIiR7cmVmfVwiIGRvZXMgbm90IG1hdGNoIGV4cGVjdGVkIE0jIyMvUyMjIGZvcm1hdGAsIHJlcXVpcmVtZW50SWQpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgWywgbWlsZXN0b25lSWQsIHNsaWNlSGFsZl0gPSBtO1xuICAgIGlmIChjYW5WYWxpZGF0ZU1pbGVzdG9uZXMgJiYgIW1pbGVzdG9uZUlkcy5oYXMobWlsZXN0b25lSWQpKSB7XG4gICAgICBlcnJvcnMucHVzaChlcnIoXCJkYW5nbGluZy1vd25lclwiLCBgUmVxdWlyZW1lbnQgJHtyZXF1aXJlbWVudElkfSAke2ZpZWxkfSByZWZlcmVuY2VzIG5vbi1leGlzdGVudCBtaWxlc3RvbmUgJHttaWxlc3RvbmVJZH1gLCByZXF1aXJlbWVudElkKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIC8vIFNsaWNlLWhhbGYgY3Jvc3MtcmVmOiBvbmx5IGVuZm9yY2VkIHdoZW4gd2UgaGF2ZSBhIHJvYWRtYXAgZm9yIHRoZSBtaWxlc3RvbmUuXG4gICAgaWYgKHNsaWNlSGFsZiA9PT0gXCJub25lIHlldFwiKSByZXR1cm47XG4gICAgY29uc3Qgcm9hZG1hcCA9IHJvYWRtYXBzQnlNaWxlc3RvbmUuZ2V0KG1pbGVzdG9uZUlkKTtcbiAgICBpZiAoIXJvYWRtYXApIHJldHVybjtcbiAgICBjb25zdCBzbGljZUV4aXN0cyA9IHJvYWRtYXAuc2xpY2VzLnNvbWUocyA9PiBzLmlkID09PSBzbGljZUhhbGYpO1xuICAgIGlmICghc2xpY2VFeGlzdHMpIHtcbiAgICAgIGVycm9ycy5wdXNoKGVycihcbiAgICAgICAgXCJkYW5nbGluZy1zbGljZS1yZWZcIixcbiAgICAgICAgYFJlcXVpcmVtZW50ICR7cmVxdWlyZW1lbnRJZH0gJHtmaWVsZH0gcmVmZXJlbmNlcyBzbGljZSAke21pbGVzdG9uZUlkfS8ke3NsaWNlSGFsZn0gd2hpY2ggZG9lcyBub3QgZXhpc3QgaW4gdGhhdCBtaWxlc3RvbmUncyByb2FkbWFwYCxcbiAgICAgICAgcmVxdWlyZW1lbnRJZCxcbiAgICAgICkpO1xuICAgIH1cbiAgfTtcblxuICBmb3IgKGNvbnN0IHIgb2YgcGFyc2VkLnJlcXVpcmVtZW50cykge1xuICAgIC8vIHByaW1hcnlPd25lcjogc2luZ2xlIHJlZmVyZW5jZS5cbiAgICBpZiAoci5wcmltYXJ5T3duZXIpIGNoZWNrUmVmKHIuaWQsIHIucHJpbWFyeU93bmVyLCBcInByaW1hcnlPd25lclwiKTtcbiAgICAvLyBzdXBwb3J0aW5nU2xpY2VzOiBjb21tYS9zcGFjZS1zZXBhcmF0ZWQgbGlzdC5cbiAgICBmb3IgKGNvbnN0IHJlZiBvZiBwYXJzZVNsaWNlTGlzdChyLnN1cHBvcnRpbmdTbGljZXMpKSB7XG4gICAgICBjaGVja1JlZihyLmlkLCByZWYsIFwic3VwcG9ydGluZ1NsaWNlc1wiKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBzZWN0aW9uQ291bnRzOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0geyBBY3RpdmU6IDAsIFZhbGlkYXRlZDogMCwgRGVmZXJyZWQ6IDAsIFwiT3V0IG9mIFNjb3BlXCI6IDAgfTtcbiAgZm9yIChjb25zdCByIG9mIHBhcnNlZC5yZXF1aXJlbWVudHMpIHNlY3Rpb25Db3VudHNbci5wYXJlbnRTZWN0aW9uXSA9IChzZWN0aW9uQ291bnRzW3IucGFyZW50U2VjdGlvbl0gPz8gMCkgKyAxO1xuXG4gIGNvbnN0IGV4cGVjdGVkQWN0aXZlID0gc2VjdGlvbkNvdW50cy5BY3RpdmU7XG4gIGNvbnN0IHJlcG9ydGVkQWN0aXZlID0gcGFyc2VkLmNvdmVyYWdlU3VtbWFyeVtcIkFjdGl2ZSByZXF1aXJlbWVudHNcIl07XG4gIGlmIChyZXBvcnRlZEFjdGl2ZSAhPT0gdW5kZWZpbmVkICYmIHBhcnNlSW50KHJlcG9ydGVkQWN0aXZlLCAxMCkgIT09IGV4cGVjdGVkQWN0aXZlKSB7XG4gICAgd2FybmluZ3MucHVzaChlcnIoXCJjb3ZlcmFnZS1taXNtYXRjaFwiLCBgQ292ZXJhZ2UgU3VtbWFyeSBzYXlzIEFjdGl2ZT0ke3JlcG9ydGVkQWN0aXZlfSBidXQgJHtleHBlY3RlZEFjdGl2ZX0gZW50cmllcyBmb3VuZCBpbiAjIyBBY3RpdmVgLCBcIkNvdmVyYWdlIFN1bW1hcnlcIikpO1xuICB9XG5cbiAgcmV0dXJuIHsgb2s6IGVycm9ycy5sZW5ndGggPT09IDAsIGVycm9ycywgd2FybmluZ3MgfTtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVSZXF1aXJlbWVudFNoYXBlKHI6IFBhcnNlZFJlcXVpcmVtZW50LCBlcnJvcnM6IFZhbGlkYXRpb25FcnJvcltdLCB3YXJuaW5nczogVmFsaWRhdGlvbkVycm9yW10pOiB2b2lkIHtcbiAgY29uc3QgcmVxdWlyZWQ6IEFycmF5PGtleW9mIFBhcnNlZFJlcXVpcmVtZW50PiA9IFtcbiAgICBcImNsYXNzXCIsIFwic3RhdHVzXCIsIFwiZGVzY3JpcHRpb25cIiwgXCJ3aHlJdE1hdHRlcnNcIiwgXCJzb3VyY2VcIiwgXCJwcmltYXJ5T3duZXJcIiwgXCJ2YWxpZGF0aW9uXCIsXG4gIF07XG4gIGZvciAoY29uc3QgZmllbGQgb2YgcmVxdWlyZWQpIHtcbiAgICBpZiAoIXJbZmllbGRdIHx8IChyW2ZpZWxkXSBhcyBzdHJpbmcpLnRyaW0oKSA9PT0gXCJcIikge1xuICAgICAgZXJyb3JzLnB1c2goZXJyKFwibWlzc2luZy1maWVsZFwiLCBgUmVxdWlyZW1lbnQgJHtyLmlkfSBpcyBtaXNzaW5nIGZpZWxkIFwiJHtmaWVsZH1cImAsIHIuaWQpKTtcbiAgICB9XG4gIH1cblxuICBpZiAoci5jbGFzcyAmJiAhQUxMT1dFRF9SRVFVSVJFTUVOVF9DTEFTU0VTLmhhcyhyLmNsYXNzKSkge1xuICAgIGVycm9ycy5wdXNoKGVycihcImludmFsaWQtY2xhc3NcIiwgYFJlcXVpcmVtZW50ICR7ci5pZH0gaGFzIGludmFsaWQgY2xhc3MgXCIke3IuY2xhc3N9XCJgLCByLmlkKSk7XG4gIH1cblxuICBjb25zdCBleHBlY3RlZFNlY3Rpb24gPSBTVEFUVVNfVE9fU0VDVElPTltyLnN0YXR1c107XG4gIGlmIChleHBlY3RlZFNlY3Rpb24gJiYgZXhwZWN0ZWRTZWN0aW9uICE9PSByLnBhcmVudFNlY3Rpb24pIHtcbiAgICBlcnJvcnMucHVzaChlcnIoXCJzdGF0dXMtc2VjdGlvbi1taXNtYXRjaFwiLCBgUmVxdWlyZW1lbnQgJHtyLmlkfSBoYXMgU3RhdHVzIFwiJHtyLnN0YXR1c31cIiBidXQgbGl2ZXMgdW5kZXIgXCIjIyAke3IucGFyZW50U2VjdGlvbn1cIiAoZXhwZWN0ZWQgXCIjIyAke2V4cGVjdGVkU2VjdGlvbn1cIilgLCByLmlkKSk7XG4gIH1cblxuICBpZiAoci5wcmltYXJ5T3duZXIgJiYgIS9eKE1cXGR7M30oXFwvKFNcXGR7Mn18bm9uZSB5ZXQpKT98bm9uZSB5ZXR8bm9uZSkkLy50ZXN0KHIucHJpbWFyeU93bmVyKSkge1xuICAgIHdhcm5pbmdzLnB1c2goZXJyKFwibWFsZm9ybWVkLW93bmVyXCIsIGBSZXF1aXJlbWVudCAke3IuaWR9IG93bmVyIFwiJHtyLnByaW1hcnlPd25lcn1cIiBkb2VzIG5vdCBtYXRjaCBleHBlY3RlZCBmb3JtYXRzIChNIyMjIHwgTSMjIy9TIyMgfCBNIyMjL25vbmUgeWV0IHwgbm9uZSB5ZXQgfCBub25lKWAsIHIuaWQpKTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUk9BRE1BUC5tZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gdmFsaWRhdGVSb2FkbWFwQ29udGVudChjb250ZW50OiBzdHJpbmcsIHJlcXVpcmVtZW50c0NvbnRlbnQ6IHN0cmluZyB8IG51bGwsIGN1cnJlbnRNaWxlc3RvbmVJZDogc3RyaW5nIHwgbnVsbCA9IG51bGwpOiBWYWxpZGF0aW9uUmVzdWx0IHtcbiAgY29uc3QgZXJyb3JzOiBWYWxpZGF0aW9uRXJyb3JbXSA9IFtdO1xuICBjb25zdCB3YXJuaW5nczogVmFsaWRhdGlvbkVycm9yW10gPSBbXTtcbiAgY29uc3QgcGFyc2VkID0gcGFyc2VSb2FkbWFwKGNvbnRlbnQpO1xuXG4gIGZvciAoY29uc3QgcmVxdWlyZWQgb2YgUkVRVUlSRURfUk9BRE1BUF9TRUNUSU9OUykge1xuICAgIGlmICghKHJlcXVpcmVkIGluIHBhcnNlZC5zZWN0aW9ucykpIHtcbiAgICAgIGVycm9ycy5wdXNoKGVycihcIm1pc3Npbmctc2VjdGlvblwiLCBgTWlzc2luZyByZXF1aXJlZCBzZWN0aW9uIFwiIyMgJHtyZXF1aXJlZH1cImAsIHJlcXVpcmVkKSk7XG4gICAgfVxuICB9XG4gIC8vIFNsaWNlIHNlY3Rpb246IGFjY2VwdCBlaXRoZXIgXCIjIyBTbGljZXNcIiBvciBcIiMjIFNsaWNlIE92ZXJ2aWV3XCIuXG4gIGNvbnN0IGhhc1NsaWNlU2VjdGlvbiA9IFJPQURNQVBfU0xJQ0VfU0VDVElPTlMuc29tZShuYW1lID0+IG5hbWUgaW4gcGFyc2VkLnNlY3Rpb25zKTtcbiAgaWYgKCFoYXNTbGljZVNlY3Rpb24pIHtcbiAgICBlcnJvcnMucHVzaChlcnIoXCJtaXNzaW5nLXNlY3Rpb25cIiwgYE1pc3Npbmcgc2xpY2Ugc2VjdGlvbiBcdTIwMTQgZXhwZWN0ZWQgXCIjIyBTbGljZXNcIiBvciBcIiMjIFNsaWNlIE92ZXJ2aWV3XCJgKSk7XG4gIH1cblxuICBmb3IgKGNvbnN0IHNlY3Rpb25OYW1lIG9mIE9iamVjdC5rZXlzKHBhcnNlZC5zZWN0aW9ucykpIHtcbiAgICBjb25zdCBib2R5ID0gcGFyc2VkLnNlY3Rpb25zW3NlY3Rpb25OYW1lXTtcbiAgICBpZiAoL1xce1xce1tefV0rXFx9XFx9Ly50ZXN0KGJvZHkpKSB7XG4gICAgICBlcnJvcnMucHVzaChlcnIoXCJ0ZW1wbGF0ZS10b2tlblwiLCBgU2VjdGlvbiBcIiR7c2VjdGlvbk5hbWV9XCIgY29udGFpbnMgdW5zdWJzdGl0dXRlZCB7ey4uLn19IHRlbXBsYXRlIHRva2Vuc2AsIHNlY3Rpb25OYW1lKSk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHBhcnNlZC5zbGljZXMubGVuZ3RoID09PSAwICYmIGhhc1NsaWNlU2VjdGlvbikge1xuICAgIGNvbnN0IHNsaWNlU2VjdGlvbiA9IFJPQURNQVBfU0xJQ0VfU0VDVElPTlMuZmluZChuYW1lID0+IG5hbWUgaW4gcGFyc2VkLnNlY3Rpb25zKSA/PyBcIlNsaWNlc1wiO1xuICAgIGVycm9ycy5wdXNoKGVycihcIm5vLXNsaWNlc1wiLCBgJHtzbGljZVNlY3Rpb259IHNlY3Rpb24gaGFzIG5vIGVudHJpZXNgLCBzbGljZVNlY3Rpb24pKTtcbiAgfVxuXG4gIC8vIEk1OiBzdXJmYWNlIG1hbGZvcm1lZCBEZXBlbmRzIHRva2VucyAoZS5nLiBcIlM5OTtcIiBvciBcIlMwMS1TMDNcIikgdGhhdCB0aGVcbiAgLy8gcGFyc2VyIGRyb3BwZWQgZnJvbSB0aGUgZGVwZW5kZW5jeSBncmFwaC4gV2FybmluZywgbm90IGVycm9yIFx1MjAxNCB0aGUgcmVzdFxuICAvLyBvZiB0aGUgZ3JhcGggaXMgc3RpbGwgdXNhYmxlLlxuICBmb3IgKGNvbnN0IG0gb2YgcGFyc2VkLm1hbGZvcm1lZERlcGVuZHMpIHtcbiAgICB3YXJuaW5ncy5wdXNoKGVycihcbiAgICAgIFwibWFsZm9ybWVkLWRlcGVuZHNcIixcbiAgICAgIGBTbGljZSAke20uc2xpY2VJZH0gaGFzIG1hbGZvcm1lZCBEZXBlbmRzIHZhbHVlKHMpIHRoYXQgd2VyZSBkcm9wcGVkIGZyb20gdGhlIGdyYXBoOiAke20udmFsdWVzLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgbS5zbGljZUlkLFxuICAgICkpO1xuICB9XG5cbiAgaWYgKHBhcnNlZC5kZWZpbml0aW9uT2ZEb25lLmxlbmd0aCA9PT0gMCAmJiBcIkRlZmluaXRpb24gb2YgRG9uZVwiIGluIHBhcnNlZC5zZWN0aW9ucykge1xuICAgIGVycm9ycy5wdXNoKGVycihcIm5vLWRlZmluaXRpb24tb2YtZG9uZVwiLCBcIkRlZmluaXRpb24gb2YgRG9uZSBoYXMgbm8gaXRlbXNcIiwgXCJEZWZpbml0aW9uIG9mIERvbmVcIikpO1xuICB9XG5cbiAgY29uc3Qgc2VlbklkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBsZXQgcHJldk51bSA9IDA7XG4gIGZvciAoY29uc3QgcyBvZiBwYXJzZWQuc2xpY2VzKSB7XG4gICAgaWYgKHNlZW5JZHMuaGFzKHMuaWQpKSB7XG4gICAgICBlcnJvcnMucHVzaChlcnIoXCJkdXBsaWNhdGUtc2xpY2VcIiwgYER1cGxpY2F0ZSBzbGljZSBJRCAke3MuaWR9YCwgcy5pZCkpO1xuICAgIH1cbiAgICBzZWVuSWRzLmFkZChzLmlkKTtcbiAgICBjb25zdCBudW0gPSBwYXJzZUludChzLmlkLnNsaWNlKDEpLCAxMCk7XG4gICAgaWYgKG51bSAhPT0gcHJldk51bSArIDEpIHtcbiAgICAgIHdhcm5pbmdzLnB1c2goZXJyKFwibm9uLW1vbm90b25pYy1zbGljZVwiLCBgU2xpY2UgJHtzLmlkfSBpcyBub3QgbW9ub3RvbmljYWxseSBudW1iZXJlZCAoZXhwZWN0ZWQgUyR7U3RyaW5nKHByZXZOdW0gKyAxKS5wYWRTdGFydCgyLCBcIjBcIil9KWAsIHMuaWQpKTtcbiAgICB9XG4gICAgcHJldk51bSA9IG51bTtcbiAgICBpZiAoIXMucmlzayB8fCAhcy5kZW1vKSB7XG4gICAgICBlcnJvcnMucHVzaChlcnIoXCJtaXNzaW5nLXNsaWNlLWZpZWxkXCIsIGBTbGljZSAke3MuaWR9IGlzIG1pc3NpbmcgcmVxdWlyZWQgZmllbGQgKHJpc2sgYW5kIGRlbW8gYXJlIHJlcXVpcmVkKWAsIHMuaWQpKTtcbiAgICB9XG4gIH1cblxuICAvLyBEZXBlbmRzIGdyYXBoOiBkYW5nbGluZyByZWZzICsgY3ljbGUgZGV0ZWN0aW9uXG4gIGNvbnN0IHNsaWNlSWRzID0gbmV3IFNldChwYXJzZWQuc2xpY2VzLm1hcChzID0+IHMuaWQpKTtcbiAgZm9yIChjb25zdCBzIG9mIHBhcnNlZC5zbGljZXMpIHtcbiAgICBmb3IgKGNvbnN0IGRlcCBvZiBzLmRlcGVuZHMpIHtcbiAgICAgIGlmICghc2xpY2VJZHMuaGFzKGRlcCkpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goZXJyKFwiZGFuZ2xpbmctZGVwZW5kZW5jeVwiLCBgU2xpY2UgJHtzLmlkfSBkZXBlbmRzIG9uIG5vbi1leGlzdGVudCBzbGljZSAke2RlcH1gLCBzLmlkKSk7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIGlmIChoYXNDeWNsZShwYXJzZWQuc2xpY2VzKSkge1xuICAgIGVycm9ycy5wdXNoKGVycihcImNpcmN1bGFyLWRlcGVuZGVuY3lcIiwgXCJTbGljZSBkZXBlbmRzIGdyYXBoIGNvbnRhaW5zIGEgY3ljbGVcIikpO1xuICB9XG5cbiAgaWYgKHJlcXVpcmVtZW50c0NvbnRlbnQpIHtcbiAgICBjb25zdCByZXFzID0gcGFyc2VSZXF1aXJlbWVudHMocmVxdWlyZW1lbnRzQ29udGVudCk7XG4gICAgZm9yIChjb25zdCBzIG9mIHBhcnNlZC5zbGljZXMpIHtcbiAgICAgIGNvbnN0IG93bnNBbnlSZXF1aXJlbWVudCA9IHJlcXMucmVxdWlyZW1lbnRzLnNvbWUociA9PiB7XG4gICAgICAgIGlmIChyLnBhcmVudFNlY3Rpb24gIT09IFwiQWN0aXZlXCIpIHJldHVybiBmYWxzZTtcbiAgICAgICAgY29uc3QgbSA9IHIucHJpbWFyeU93bmVyLm1hdGNoKC9eKE1cXGR7M30pXFwvKFNcXGR7Mn0pJC8pO1xuICAgICAgICBpZiAoIW0pIHJldHVybiBmYWxzZTtcbiAgICAgICAgaWYgKGN1cnJlbnRNaWxlc3RvbmVJZCAhPT0gbnVsbCAmJiBtWzFdICE9PSBjdXJyZW50TWlsZXN0b25lSWQpIHJldHVybiBmYWxzZTtcbiAgICAgICAgcmV0dXJuIG1bMl0gPT09IHMuaWQ7XG4gICAgICB9KTtcbiAgICAgIGlmICghb3duc0FueVJlcXVpcmVtZW50KSB7XG4gICAgICAgIHdhcm5pbmdzLnB1c2goZXJyKFwib3JwaGFuLXNsaWNlXCIsIGBTbGljZSAke3MuaWR9IG93bnMgbm8gQWN0aXZlIHJlcXVpcmVtZW50c2AsIHMuaWQpKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4geyBvazogZXJyb3JzLmxlbmd0aCA9PT0gMCwgZXJyb3JzLCB3YXJuaW5ncyB9O1xufVxuXG5mdW5jdGlvbiBoYXNDeWNsZShzbGljZXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgZGVwZW5kczogc3RyaW5nW10gfT4pOiBib29sZWFuIHtcbiAgY29uc3QgbWFwID0gbmV3IE1hcChzbGljZXMubWFwKHMgPT4gW3MuaWQsIHMuZGVwZW5kc10pKTtcbiAgY29uc3QgdmlzaXRpbmcgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgdmlzaXRlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGZ1bmN0aW9uIGRmcyhpZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgaWYgKHZpc2l0aW5nLmhhcyhpZCkpIHJldHVybiB0cnVlO1xuICAgIGlmICh2aXNpdGVkLmhhcyhpZCkpIHJldHVybiBmYWxzZTtcbiAgICB2aXNpdGluZy5hZGQoaWQpO1xuICAgIGZvciAoY29uc3QgZGVwIG9mIG1hcC5nZXQoaWQpID8/IFtdKSB7XG4gICAgICBpZiAoZGZzKGRlcCkpIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICB2aXNpdGluZy5kZWxldGUoaWQpO1xuICAgIHZpc2l0ZWQuYWRkKGlkKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBmb3IgKGNvbnN0IHMgb2Ygc2xpY2VzKSB7XG4gICAgaWYgKGRmcyhzLmlkKSkgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRW50cnkgcG9pbnQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUFydGlmYWN0KFxuICBmaWxlUGF0aDogc3RyaW5nLFxuICBraW5kOiBBcnRpZmFjdEtpbmQsXG4gIG9wdHM6IFZhbGlkYXRlT3B0aW9ucyA9IHt9LFxuKTogVmFsaWRhdGlvblJlc3VsdCB7XG4gIGNvbnN0IGNvbnRlbnQgPSBsb2FkRmlsZShmaWxlUGF0aCk7XG4gIGlmIChjb250ZW50ID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yczogW2VycihcImZpbGUtbWlzc2luZ1wiLCBgQXJ0aWZhY3QgZmlsZSBub3QgZm91bmQ6ICR7ZmlsZVBhdGh9YCwgZmlsZVBhdGgpXSxcbiAgICAgIHdhcm5pbmdzOiBbXSxcbiAgICB9O1xuICB9XG5cbiAgc3dpdGNoIChraW5kKSB7XG4gICAgY2FzZSBcInByb2plY3RcIjpcbiAgICAgIHJldHVybiB2YWxpZGF0ZVByb2plY3RDb250ZW50KGNvbnRlbnQpO1xuICAgIGNhc2UgXCJyZXF1aXJlbWVudHNcIjoge1xuICAgICAgY29uc3QgcHJvamVjdENvbnRlbnQgPSBvcHRzLmNyb3NzUmVmcz8ucHJvamVjdFBhdGggPyBsb2FkRmlsZShvcHRzLmNyb3NzUmVmcy5wcm9qZWN0UGF0aCkgOiBudWxsO1xuICAgICAgY29uc3Qgcm9hZG1hcHNCeU1pbGVzdG9uZSA9IG5ldyBNYXA8c3RyaW5nLCBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZVJvYWRtYXA+PigpO1xuICAgICAgY29uc3Qgcm9hZG1hcFBhdGhzID0gb3B0cy5jcm9zc1JlZnM/LnJvYWRtYXBQYXRocyA/PyB7fTtcbiAgICAgIGZvciAoY29uc3QgW21pZCwgcGF0aF0gb2YgT2JqZWN0LmVudHJpZXMocm9hZG1hcFBhdGhzKSkge1xuICAgICAgICBjb25zdCBjID0gbG9hZEZpbGUocGF0aCk7XG4gICAgICAgIGlmIChjKSByb2FkbWFwc0J5TWlsZXN0b25lLnNldChtaWQsIHBhcnNlUm9hZG1hcChjKSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gdmFsaWRhdGVSZXF1aXJlbWVudHNDb250ZW50KGNvbnRlbnQsIHByb2plY3RDb250ZW50LCByb2FkbWFwc0J5TWlsZXN0b25lKTtcbiAgICB9XG4gICAgY2FzZSBcInJvYWRtYXBcIjpcbiAgICAgIHJldHVybiB2YWxpZGF0ZVJvYWRtYXBDb250ZW50KFxuICAgICAgICBjb250ZW50LFxuICAgICAgICBvcHRzLmNyb3NzUmVmcz8ucmVxdWlyZW1lbnRzUGF0aCA/IGxvYWRGaWxlKG9wdHMuY3Jvc3NSZWZzLnJlcXVpcmVtZW50c1BhdGgpIDogbnVsbCxcbiAgICAgICAgb3B0cy5taWxlc3RvbmVJZCA/PyBmaWxlUGF0aC5tYXRjaCgvKD86XnxbXFxcXC9dKShNXFxkezN9KSg/OltcXFxcL118LSkvKT8uWzFdID8/IG51bGwsXG4gICAgICApO1xuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFPQSxTQUFTLFlBQVksb0JBQW9CO0FBQ3pDLFNBQVMsY0FBYyxtQkFBbUIsb0JBQW9CO0FBaUM5RCxNQUFNLDRCQUE0QjtBQUFBLEVBQ2hDO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRjtBQUVBLE1BQU0saUNBQWlDO0FBQUEsRUFDckM7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGO0FBT0EsTUFBTSw0QkFBNEIsQ0FBQyxvQkFBb0I7QUFDdkQsTUFBTSx5QkFBeUIsQ0FBQyxVQUFVLGdCQUFnQjtBQUUxRCxNQUFNLDhCQUE4QixvQkFBSSxJQUFJO0FBQUEsRUFDMUM7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRixDQUFDO0FBRUQsTUFBTSxvQkFBNEM7QUFBQSxFQUNoRCxRQUFRO0FBQUEsRUFDUixXQUFXO0FBQUEsRUFDWCxVQUFVO0FBQUEsRUFDVixnQkFBZ0I7QUFDbEI7QUFFQSxTQUFTLFNBQVMsTUFBNkI7QUFDN0MsTUFBSSxDQUFDLFdBQVcsSUFBSSxFQUFHLFFBQU87QUFDOUIsTUFBSTtBQUNGLFdBQU8sYUFBYSxNQUFNLE9BQU87QUFBQSxFQUNuQyxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUVBLFNBQVMsSUFBSSxNQUFjLFNBQWlC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
