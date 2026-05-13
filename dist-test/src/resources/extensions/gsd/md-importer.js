import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  upsertDecision,
  upsertRequirement,
  insertArtifact,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  transaction,
  updateSliceStatus,
  _getAdapter
} from "./gsd-db.js";
import {
  resolveGsdRootFile,
  resolveMilestoneFile,
  resolveSliceFile,
  resolveTasksDir,
  milestonesDir,
  gsdRoot,
  resolveTaskFiles
} from "./paths.js";
import { findMilestoneIds } from "./guided-flow.js";
import { parseRoadmap, parsePlan } from "./parsers-legacy.js";
import { parseContextDependsOn } from "./files.js";
import { logWarning } from "./workflow-logger.js";
const VALID_MADE_BY = /* @__PURE__ */ new Set(["human", "agent", "collaborative"]);
function parseDecisionsTable(content) {
  const lines = content.split("\n");
  const results = [];
  const amendsMap = /* @__PURE__ */ new Map();
  for (const line of lines) {
    if (!line.trim().startsWith("|")) continue;
    const trimmed = line.trim();
    if (/^\|[\s-|]+\|$/.test(trimmed)) continue;
    const cells = trimmed.split("|").map((c) => c.trim());
    if (cells.length > 0 && cells[0] === "") cells.shift();
    if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
    if (cells.length < 7) continue;
    const id = cells[0].trim();
    if (id === "#" || id.toLowerCase() === "id") continue;
    if (!/^D\d+/.test(id)) continue;
    const when_context = cells[1].trim();
    const scope = cells[2].trim();
    const decisionText = cells[3].trim();
    const choice = cells[4].trim();
    const rationale = cells[5].trim();
    const revisable = cells[6].trim();
    const rawMadeBy = cells.length >= 8 ? cells[7].trim().toLowerCase() : "agent";
    const made_by = VALID_MADE_BY.has(rawMadeBy) ? rawMadeBy : "agent";
    const amendsMatch = decisionText.match(/\(amends\s+(D\d+)\)/i);
    if (amendsMatch) {
      amendsMap.set(amendsMatch[1], id);
    }
    results.push({
      id,
      when_context,
      scope,
      decision: decisionText,
      choice,
      rationale,
      revisable,
      made_by,
      superseded_by: null
    });
  }
  for (const row of results) {
    if (amendsMap.has(row.id)) {
      row.superseded_by = amendsMap.get(row.id);
    }
  }
  return results;
}
const STATUS_SECTIONS = {
  "## active": "active",
  "## validated": "validated",
  "## deferred": "deferred",
  "## out of scope": "out-of-scope"
};
function parseRequirementsSections(content) {
  const lines = content.split("\n");
  const results = [];
  let currentSectionStatus = null;
  let currentReq = null;
  let currentFullContentLines = [];
  function flushReq() {
    if (currentReq && currentReq.id) {
      currentReq.full_content = currentFullContentLines.join("\n").trim();
      results.push({
        id: currentReq.id,
        class: currentReq.class ?? "",
        status: currentReq.status ?? currentSectionStatus ?? "",
        description: currentReq.description ?? "",
        why: currentReq.why ?? "",
        source: currentReq.source ?? "",
        primary_owner: currentReq.primary_owner ?? "",
        supporting_slices: currentReq.supporting_slices ?? "",
        validation: currentReq.validation ?? "",
        notes: currentReq.notes ?? "",
        full_content: currentReq.full_content ?? "",
        superseded_by: currentReq.superseded_by ?? null
      });
    }
    currentReq = null;
    currentFullContentLines = [];
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.trim().toLowerCase();
    if (lineLower.startsWith("## ")) {
      flushReq();
      const matchedSection = Object.entries(STATUS_SECTIONS).find(
        ([prefix]) => lineLower === prefix || lineLower.startsWith(prefix + " ")
      );
      if (matchedSection) {
        currentSectionStatus = matchedSection[1];
      } else {
        currentSectionStatus = null;
      }
      continue;
    }
    const reqMatch = line.match(/^###\s+(R\d+)\s*[—–-]\s*(.+)/);
    if (reqMatch) {
      flushReq();
      if (currentSectionStatus !== null) {
        currentReq = {
          id: reqMatch[1],
          status: currentSectionStatus
        };
        currentFullContentLines = [line];
      }
      continue;
    }
    if (currentReq && currentSectionStatus !== null) {
      currentFullContentLines.push(line);
      const bulletMatch = line.match(/^-\s+(.+?):\s+(.*)/);
      if (bulletMatch) {
        const fieldName = bulletMatch[1].trim().toLowerCase();
        const value = bulletMatch[2].trim();
        switch (fieldName) {
          case "class":
            currentReq.class = value;
            break;
          case "status":
            currentReq.status = value;
            break;
          case "description":
            currentReq.description = value;
            break;
          case "why it matters":
          case "why":
            currentReq.why = value;
            break;
          case "source":
            currentReq.source = value;
            break;
          case "primary owning slice":
          case "primary owner":
          case "primary_owner":
            currentReq.primary_owner = value;
            break;
          case "supporting slices":
          case "supporting_slices":
            currentReq.supporting_slices = value;
            break;
          case "validation":
          case "validated by":
            currentReq.validation = value;
            break;
          case "notes":
            currentReq.notes = value;
            break;
          case "proof":
            currentReq.notes = value;
            break;
        }
      }
    }
  }
  flushReq();
  const deduped = /* @__PURE__ */ new Map();
  for (const req of results) {
    const existing = deduped.get(req.id);
    if (!existing) {
      deduped.set(req.id, req);
    } else {
      for (const key of Object.keys(req)) {
        if (key === "id" || key === "superseded_by") continue;
        const val = req[key];
        if (val && val !== "" && (!existing[key] || existing[key] === "")) {
          existing[key] = val;
        }
      }
    }
  }
  return Array.from(deduped.values());
}
function importDecisions(gsdDir) {
  const filePath = resolveGsdRootFile(gsdDir, "DECISIONS");
  if (!existsSync(filePath)) return 0;
  const content = readFileSync(filePath, "utf-8");
  const decisions = parseDecisionsTable(content);
  for (const d of decisions) {
    upsertDecision(d);
  }
  return decisions.length;
}
function importRequirements(gsdDir) {
  const filePath = resolveGsdRootFile(gsdDir, "REQUIREMENTS");
  if (!existsSync(filePath)) return 0;
  const content = readFileSync(filePath, "utf-8");
  const requirements = parseRequirementsSections(content);
  for (const r of requirements) {
    upsertRequirement(r);
  }
  return requirements.length;
}
const MILESTONE_SUFFIXES = ["ROADMAP", "CONTEXT", "RESEARCH", "ASSESSMENT", "SUMMARY", "VALIDATION"];
const SLICE_SUFFIXES = ["PLAN", "SUMMARY", "RESEARCH", "CONTEXT", "ASSESSMENT", "UAT"];
const TASK_SUFFIXES = ["PLAN", "SUMMARY", "CONTINUE", "CONTEXT", "RESEARCH"];
function importHierarchyArtifacts(gsdDir) {
  let count = 0;
  const gsdPath = gsdRoot(gsdDir);
  const rootFiles = ["PROJECT.md", "QUEUE.md", "SECRETS-MANIFEST.md"];
  for (const fileName of rootFiles) {
    const filePath = join(gsdPath, fileName);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      const artifactType = fileName.replace(".md", "").replace("-", "_");
      insertArtifact({
        path: fileName,
        artifact_type: artifactType,
        milestone_id: null,
        slice_id: null,
        task_id: null,
        full_content: content
      });
      count++;
    }
  }
  const milestoneIds = findMilestoneIds(gsdDir);
  const msDir = milestonesDir(gsdDir);
  for (const milestoneId of milestoneIds) {
    const milestoneDirName = findDirByPrefix(msDir, milestoneId);
    if (!milestoneDirName) continue;
    const milestoneFullPath = join(msDir, milestoneDirName);
    count += importFilesAtLevel(
      milestoneFullPath,
      milestoneId,
      MILESTONE_SUFFIXES,
      `milestones/${milestoneDirName}`,
      milestoneId,
      null,
      null
    );
    const slicesDir = join(milestoneFullPath, "slices");
    if (!existsSync(slicesDir)) continue;
    const sliceDirs = readdirSync(slicesDir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^S\d+/.test(d.name)).map((d) => d.name).sort();
    for (const sliceDirName of sliceDirs) {
      const sliceId = sliceDirName.match(/^(S\d+)/)?.[1] ?? sliceDirName;
      const sliceFullPath = join(slicesDir, sliceDirName);
      count += importFilesAtLevel(
        sliceFullPath,
        sliceId,
        SLICE_SUFFIXES,
        `milestones/${milestoneDirName}/slices/${sliceDirName}`,
        milestoneId,
        sliceId,
        null
      );
      const tasksDir = join(sliceFullPath, "tasks");
      if (!existsSync(tasksDir)) continue;
      for (const suffix of TASK_SUFFIXES) {
        const taskFiles = resolveTaskFiles(tasksDir, suffix);
        for (const taskFileName of taskFiles) {
          const taskId = taskFileName.match(/^(T\d+)/)?.[1] ?? null;
          const taskFilePath = join(tasksDir, taskFileName);
          if (!existsSync(taskFilePath)) continue;
          const content = readFileSync(taskFilePath, "utf-8");
          const relPath = `milestones/${milestoneDirName}/slices/${sliceDirName}/tasks/${taskFileName}`;
          insertArtifact({
            path: relPath,
            artifact_type: suffix,
            milestone_id: milestoneId,
            slice_id: sliceId,
            task_id: taskId,
            full_content: content
          });
          count++;
        }
      }
    }
  }
  return count;
}
function importFilesAtLevel(dirPath, idPrefix, suffixes, relativeBase, milestoneId, sliceId, taskId) {
  let count = 0;
  for (const suffix of suffixes) {
    const fileName = findFileByPrefixAndSuffix(dirPath, idPrefix, suffix);
    if (!fileName) continue;
    const filePath = join(dirPath, fileName);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf-8");
    const relPath = `${relativeBase}/${fileName}`;
    insertArtifact({
      path: relPath,
      artifact_type: suffix,
      milestone_id: milestoneId,
      slice_id: sliceId,
      task_id: taskId,
      full_content: content
    });
    count++;
  }
  return count;
}
function findDirByPrefix(parentDir, idPrefix) {
  if (!existsSync(parentDir)) return null;
  try {
    const entries = readdirSync(parentDir, { withFileTypes: true });
    const exact = entries.find((e) => e.isDirectory() && e.name === idPrefix);
    if (exact) return exact.name;
    const prefixed = entries.find((e) => e.isDirectory() && e.name.startsWith(idPrefix + "-"));
    return prefixed ? prefixed.name : null;
  } catch {
    return null;
  }
}
function findFileByPrefixAndSuffix(dir, idPrefix, suffix) {
  if (!existsSync(dir)) return null;
  try {
    const entries = readdirSync(dir);
    const target = `${idPrefix}-${suffix}.md`.toUpperCase();
    const direct = entries.find((e) => e.toUpperCase() === target);
    if (direct) return direct;
    const pattern = new RegExp(`^${idPrefix}-.*-${suffix}\\.md$`, "i");
    const match = entries.find((e) => pattern.test(e));
    return match ?? null;
  } catch {
    return null;
  }
}
function migrateHierarchyToDb(basePath) {
  const counts = { milestones: 0, slices: 0, tasks: 0 };
  const milestoneIds = findMilestoneIds(basePath);
  for (const milestoneId of milestoneIds) {
    const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
    const contextPath = resolveMilestoneFile(basePath, milestoneId, "CONTEXT");
    const summaryPath = resolveMilestoneFile(basePath, milestoneId, "SUMMARY");
    const parkedPath = resolveMilestoneFile(basePath, milestoneId, "PARKED");
    const hasRoadmap = roadmapPath !== null && existsSync(roadmapPath);
    const hasContext = contextPath !== null && existsSync(contextPath);
    const hasSummary = summaryPath !== null && existsSync(summaryPath);
    const hasParked = parkedPath !== null && existsSync(parkedPath);
    if (!hasRoadmap && !hasContext && !hasSummary) continue;
    let milestoneTitle = "";
    let roadmapContent = null;
    let roadmap = null;
    if (hasRoadmap) {
      roadmapContent = readFileSync(roadmapPath, "utf-8");
      roadmap = parseRoadmap(roadmapContent);
      milestoneTitle = roadmap.title;
    }
    let milestoneStatus = "active";
    if (hasSummary) milestoneStatus = "complete";
    else if (hasParked) milestoneStatus = "parked";
    else if (roadmap && roadmap.slices.length > 0 && roadmap.slices.every((s) => s.done)) {
      milestoneStatus = "complete";
    }
    if (!milestoneTitle && hasContext) {
      const contextContent = readFileSync(contextPath, "utf-8");
      const h1Match = contextContent.match(/^#\s+(.+)/m);
      if (h1Match) milestoneTitle = h1Match[1].trim();
    }
    let dependsOn = [];
    if (hasContext) {
      const contextContent = readFileSync(contextPath, "utf-8");
      dependsOn = parseContextDependsOn(contextContent);
    }
    let boundaryMapSection = "";
    if (roadmapContent) {
      const bmIdx = roadmapContent.indexOf("## Boundary Map");
      if (bmIdx >= 0) {
        const afterBm = roadmapContent.slice(bmIdx);
        const nextHeading = afterBm.indexOf("\n## ", 1);
        boundaryMapSection = nextHeading >= 0 ? afterBm.slice(0, nextHeading).trim() : afterBm.trim();
      }
    }
    insertMilestone({
      id: milestoneId,
      title: milestoneTitle,
      status: milestoneStatus,
      depends_on: dependsOn,
      planning: {
        vision: roadmap?.vision ?? "",
        successCriteria: roadmap?.successCriteria ?? [],
        boundaryMapMarkdown: boundaryMapSection
      }
    });
    counts.milestones++;
    if (!roadmap) continue;
    for (let si = 0; si < roadmap.slices.length; si++) {
      const sliceEntry = roadmap.slices[si];
      const sliceStatus = sliceEntry.done ? "complete" : "pending";
      const planPath = resolveSliceFile(basePath, milestoneId, sliceEntry.id, "PLAN");
      let plan = null;
      if (planPath && existsSync(planPath)) {
        const planContent = readFileSync(planPath, "utf-8");
        plan = parsePlan(planContent);
      }
      insertSlice({
        id: sliceEntry.id,
        milestoneId,
        title: sliceEntry.title,
        status: sliceStatus,
        risk: sliceEntry.risk,
        depends: sliceEntry.depends,
        demo: sliceEntry.demo,
        sequence: si + 1,
        // Preserve roadmap parse order (#3356)
        planning: {
          goal: plan?.goal ?? ""
        }
      });
      counts.slices++;
      if (!plan) continue;
      for (const taskEntry of plan.tasks) {
        let taskStatus = taskEntry.done ? "complete" : "pending";
        if (taskStatus === "complete") {
          const tDir = resolveTasksDir(basePath, milestoneId, sliceEntry.id);
          if (tDir) {
            const summaryFile = join(tDir, `${taskEntry.id}-SUMMARY.md`);
            if (!existsSync(summaryFile)) {
              taskStatus = "pending";
              process.stderr.write(
                `gsd-migrate: ${milestoneId}/${sliceEntry.id}/${taskEntry.id} marked done but missing summary \u2014 importing as pending
`
              );
            }
          }
        }
        insertTask({
          id: taskEntry.id,
          sliceId: sliceEntry.id,
          milestoneId,
          title: taskEntry.title,
          status: taskStatus,
          planning: {
            files: taskEntry.files ?? [],
            verify: taskEntry.verify ?? ""
          }
        });
        counts.tasks++;
      }
      if (!sliceEntry.done) {
        const sliceSummaryPath = resolveSliceFile(basePath, milestoneId, sliceEntry.id, "SUMMARY");
        const hasSliceSummary = sliceSummaryPath !== null && existsSync(sliceSummaryPath);
        const allTasksDone = plan.tasks.length > 0 && plan.tasks.every((t) => {
          const tDir = resolveTasksDir(basePath, milestoneId, sliceEntry.id);
          if (!tDir) return t.done;
          const summaryFile = join(tDir, `${t.id}-SUMMARY.md`);
          return t.done && existsSync(summaryFile);
        });
        if (allTasksDone && hasSliceSummary) {
          if (_getAdapter()) {
            updateSliceStatus(milestoneId, sliceEntry.id, "complete");
            process.stderr.write(
              `gsd-migrate: ${milestoneId}/${sliceEntry.id} all tasks + slice summary complete \u2014 upgrading slice to complete
`
            );
          }
        }
      }
    }
  }
  return counts;
}
function migrateFromMarkdown(gsdDir) {
  const dbPath = join(gsdRoot(gsdDir), "gsd.db");
  if (!_getAdapter()) {
    openDatabase(dbPath);
  }
  let decisions = 0;
  let requirements = 0;
  let artifacts = 0;
  let hierarchy = { milestones: 0, slices: 0, tasks: 0 };
  transaction(() => {
    try {
      decisions = importDecisions(gsdDir);
    } catch (err) {
      logWarning("migration", `skipping decisions import: ${err.message}`);
    }
    try {
      requirements = importRequirements(gsdDir);
    } catch (err) {
      logWarning("migration", `skipping requirements import: ${err.message}`);
    }
    try {
      artifacts = importHierarchyArtifacts(gsdDir);
    } catch (err) {
      logWarning("migration", `skipping artifacts import: ${err.message}`);
    }
    try {
      hierarchy = migrateHierarchyToDb(gsdDir);
    } catch (err) {
      logWarning("migration", `skipping hierarchy migration: ${err.message}`);
    }
  });
  process.stderr.write(
    `gsd-migrate: imported ${decisions} decisions, ${requirements} requirements, ${artifacts} artifacts, ${hierarchy.milestones}M/${hierarchy.slices}S/${hierarchy.tasks}T hierarchy
`
  );
  return { decisions, requirements, artifacts, hierarchy };
}
export {
  migrateFromMarkdown,
  migrateHierarchyToDb,
  parseDecisionsTable,
  parseRequirementsSections
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9tZC1pbXBvcnRlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIE1hcmtkb3duIEltcG9ydGVyXG4vLyBQYXJzZXMgREVDSVNJT05TLm1kLCBSRVFVSVJFTUVOVFMubWQsIGFuZCBoaWVyYXJjaHkgYXJ0aWZhY3RzIGZyb20gYSAuZ3NkLyB0cmVlLFxuLy8gdGhlbiB1cHNlcnRzIGV2ZXJ5dGhpbmcgaW50byB0aGUgU1FMaXRlIGRhdGFiYXNlLlxuLy9cbi8vIEV4cG9ydHM6IHBhcnNlRGVjaXNpb25zVGFibGUsIHBhcnNlUmVxdWlyZW1lbnRzU2VjdGlvbnMsIG1pZ3JhdGVGcm9tTWFya2Rvd25cblxuaW1wb3J0IHsgcmVhZEZpbGVTeW5jLCByZWFkZGlyU3luYywgZXhpc3RzU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgam9pbiwgcmVsYXRpdmUgfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHR5cGUgeyBEZWNpc2lvbiwgUmVxdWlyZW1lbnQgfSBmcm9tICcuL3R5cGVzLmpzJztcbmltcG9ydCB7XG4gIHVwc2VydERlY2lzaW9uLFxuICB1cHNlcnRSZXF1aXJlbWVudCxcbiAgaW5zZXJ0QXJ0aWZhY3QsXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgaW5zZXJ0U2xpY2UsXG4gIGluc2VydFRhc2ssXG4gIG9wZW5EYXRhYmFzZSxcbiAgdHJhbnNhY3Rpb24sXG4gIHVwZGF0ZVNsaWNlU3RhdHVzLFxuICBfZ2V0QWRhcHRlcixcbn0gZnJvbSAnLi9nc2QtZGIuanMnO1xuaW1wb3J0IHtcbiAgcmVzb2x2ZUdzZFJvb3RGaWxlLFxuICByZXNvbHZlTWlsZXN0b25lRmlsZSxcbiAgcmVzb2x2ZVNsaWNlRmlsZSxcbiAgcmVzb2x2ZVNsaWNlUGF0aCxcbiAgcmVzb2x2ZVRhc2tzRGlyLFxuICBtaWxlc3RvbmVzRGlyLFxuICBnc2RSb290LFxuICByZXNvbHZlVGFza0ZpbGVzLFxufSBmcm9tICcuL3BhdGhzLmpzJztcbmltcG9ydCB7IGZpbmRNaWxlc3RvbmVJZHMgfSBmcm9tICcuL2d1aWRlZC1mbG93LmpzJztcbmltcG9ydCB7IHBhcnNlUm9hZG1hcCwgcGFyc2VQbGFuIH0gZnJvbSAnLi9wYXJzZXJzLWxlZ2FjeS5qcyc7XG5pbXBvcnQgeyBwYXJzZUNvbnRleHREZXBlbmRzT24gfSBmcm9tICcuL2ZpbGVzLmpzJztcbmltcG9ydCB7IGxvZ1dhcm5pbmcgfSBmcm9tICcuL3dvcmtmbG93LWxvZ2dlci5qcyc7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBERUNJU0lPTlMubWQgUGFyc2VyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBWQUxJRF9NQURFX0JZID0gbmV3IFNldChbJ2h1bWFuJywgJ2FnZW50JywgJ2NvbGxhYm9yYXRpdmUnXSk7XG5cbi8qKlxuICogUGFyc2UgYSBERUNJU0lPTlMubWQgbWFya2Rvd24gdGFibGUgaW50byBEZWNpc2lvbiBvYmplY3RzICh3aXRob3V0IHNlcSkuXG4gKiBEZXRlY3RzIGAoYW1lbmRzIERYWFgpYCBpbiB0aGUgRGVjaXNpb24gY29sdW1uIHRvIGJ1aWxkIHN1cGVyc2Vzc2lvbiBpbmZvLlxuICogUmV0dXJucyBwYXJzZWQgcm93cyB3aXRoIHN1cGVyc2VkZWRfYnkgc2V0IHRvIG51bGw7IGNhbGxlcnMgaGFuZGxlIGNoYWluaW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VEZWNpc2lvbnNUYWJsZShjb250ZW50OiBzdHJpbmcpOiBPbWl0PERlY2lzaW9uLCAnc2VxJz5bXSB7XG4gIGNvbnN0IGxpbmVzID0gY29udGVudC5zcGxpdCgnXFxuJyk7XG4gIGNvbnN0IHJlc3VsdHM6IE9taXQ8RGVjaXNpb24sICdzZXEnPltdID0gW107XG5cbiAgLy8gTWFwIGZyb20gYW1lbmRlZCBJRCBcdTIxOTIgYW1lbmRpbmcgSUQgZm9yIHN1cGVyc2Vzc2lvblxuICBjb25zdCBhbWVuZHNNYXAgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIC8vIFNraXAgbm9uLXRhYmxlIGxpbmVzLCBoZWFkZXIsIGFuZCBzZXBhcmF0b3JcbiAgICBpZiAoIWxpbmUudHJpbSgpLnN0YXJ0c1dpdGgoJ3wnKSkgY29udGludWU7XG4gICAgY29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpO1xuICAgIC8vIFNraXAgc2VwYXJhdG9yIHJvd3MgbGlrZSB8LS0tfC0tLXwuLi58XG4gICAgaWYgKC9eXFx8W1xccy18XStcXHwkLy50ZXN0KHRyaW1tZWQpKSBjb250aW51ZTtcblxuICAgIC8vIFNwbGl0IG9uIHwgYW5kIHN0cmlwIGxlYWRpbmcvdHJhaWxpbmcgZW1wdHkgY2VsbHNcbiAgICBjb25zdCBjZWxscyA9IHRyaW1tZWQuc3BsaXQoJ3wnKS5tYXAoYyA9PiBjLnRyaW0oKSk7XG4gICAgLy8gUmVtb3ZlIGZpcnN0IGFuZCBsYXN0IGVtcHR5IHN0cmluZ3MgZnJvbSBsZWFkaW5nL3RyYWlsaW5nIHxcbiAgICBpZiAoY2VsbHMubGVuZ3RoID4gMCAmJiBjZWxsc1swXSA9PT0gJycpIGNlbGxzLnNoaWZ0KCk7XG4gICAgaWYgKGNlbGxzLmxlbmd0aCA+IDAgJiYgY2VsbHNbY2VsbHMubGVuZ3RoIC0gMV0gPT09ICcnKSBjZWxscy5wb3AoKTtcblxuICAgIGlmIChjZWxscy5sZW5ndGggPCA3KSBjb250aW51ZTtcblxuICAgIGNvbnN0IGlkID0gY2VsbHNbMF0udHJpbSgpO1xuICAgIC8vIFNraXAgaGVhZGVyIHJvd1xuICAgIGlmIChpZCA9PT0gJyMnIHx8IGlkLnRvTG93ZXJDYXNlKCkgPT09ICdpZCcpIGNvbnRpbnVlO1xuICAgIC8vIE11c3QgbG9vayBsaWtlIGEgZGVjaXNpb24gSUQgKEQgZm9sbG93ZWQgYnkgZGlnaXRzKVxuICAgIGlmICghL15EXFxkKy8udGVzdChpZCkpIGNvbnRpbnVlO1xuXG4gICAgY29uc3Qgd2hlbl9jb250ZXh0ID0gY2VsbHNbMV0udHJpbSgpO1xuICAgIGNvbnN0IHNjb3BlID0gY2VsbHNbMl0udHJpbSgpO1xuICAgIGNvbnN0IGRlY2lzaW9uVGV4dCA9IGNlbGxzWzNdLnRyaW0oKTtcbiAgICBjb25zdCBjaG9pY2UgPSBjZWxsc1s0XS50cmltKCk7XG4gICAgY29uc3QgcmF0aW9uYWxlID0gY2VsbHNbNV0udHJpbSgpO1xuICAgIGNvbnN0IHJldmlzYWJsZSA9IGNlbGxzWzZdLnRyaW0oKTtcbiAgICAvLyBNYWRlIEJ5IGNvbHVtbiBpcyBvcHRpb25hbCBmb3IgYmFja3dhcmQgY29tcGF0aWJpbGl0eSBcdTIwMTQgZGVmYXVsdHMgdG8gJ2FnZW50J1xuICAgIGNvbnN0IHJhd01hZGVCeSA9IGNlbGxzLmxlbmd0aCA+PSA4ID8gY2VsbHNbN10udHJpbSgpLnRvTG93ZXJDYXNlKCkgOiAnYWdlbnQnO1xuICAgIGNvbnN0IG1hZGVfYnkgPSAoVkFMSURfTUFERV9CWS5oYXMocmF3TWFkZUJ5KSA/IHJhd01hZGVCeSA6ICdhZ2VudCcpIGFzIGltcG9ydCgnLi90eXBlcy5qcycpLkRlY2lzaW9uTWFkZUJ5O1xuXG4gICAgLy8gRGV0ZWN0IChhbWVuZHMgRFhYWCkgaW4gdGhlIERlY2lzaW9uIGNvbHVtblxuICAgIGNvbnN0IGFtZW5kc01hdGNoID0gZGVjaXNpb25UZXh0Lm1hdGNoKC9cXChhbWVuZHNcXHMrKERcXGQrKVxcKS9pKTtcbiAgICBpZiAoYW1lbmRzTWF0Y2gpIHtcbiAgICAgIGFtZW5kc01hcC5zZXQoYW1lbmRzTWF0Y2hbMV0sIGlkKTtcbiAgICB9XG5cbiAgICByZXN1bHRzLnB1c2goe1xuICAgICAgaWQsXG4gICAgICB3aGVuX2NvbnRleHQsXG4gICAgICBzY29wZSxcbiAgICAgIGRlY2lzaW9uOiBkZWNpc2lvblRleHQsXG4gICAgICBjaG9pY2UsXG4gICAgICByYXRpb25hbGUsXG4gICAgICByZXZpc2FibGUsXG4gICAgICBtYWRlX2J5LFxuICAgICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIEFwcGx5IHN1cGVyc2Vzc2lvbjogaWYgRDAxMCBhbWVuZHMgRDAwMSwgc2V0IEQwMDEuc3VwZXJzZWRlZF9ieSA9IEQwMTBcbiAgLy8gSGFuZGxlIGNoYWluczogaWYgRDAyMCBhbWVuZHMgRDAxMCBhbmQgRDAxMCBhbWVuZHMgRDAwMSxcbiAgLy8gRDAwMS5zdXBlcnNlZGVkX2J5ID0gRDAxMCwgRDAxMC5zdXBlcnNlZGVkX2J5ID0gRDAyMFxuICBmb3IgKGNvbnN0IHJvdyBvZiByZXN1bHRzKSB7XG4gICAgaWYgKGFtZW5kc01hcC5oYXMocm93LmlkKSkge1xuICAgICAgcm93LnN1cGVyc2VkZWRfYnkgPSBhbWVuZHNNYXAuZ2V0KHJvdy5pZCkhO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiByZXN1bHRzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUkVRVUlSRU1FTlRTLm1kIFBhcnNlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgU1RBVFVTX1NFQ1RJT05TOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAnIyMgYWN0aXZlJzogJ2FjdGl2ZScsXG4gICcjIyB2YWxpZGF0ZWQnOiAndmFsaWRhdGVkJyxcbiAgJyMjIGRlZmVycmVkJzogJ2RlZmVycmVkJyxcbiAgJyMjIG91dCBvZiBzY29wZSc6ICdvdXQtb2Ytc2NvcGUnLFxufTtcblxuLyoqXG4gKiBQYXJzZSBSRVFVSVJFTUVOVFMubWQgaW50byBSZXF1aXJlbWVudCBvYmplY3RzLlxuICogRmluZHMgc2VjdGlvbiBoZWFkaW5ncyAoIyMgQWN0aXZlLCAjIyBWYWxpZGF0ZWQsICMjIERlZmVycmVkLCAjIyBPdXQgb2YgU2NvcGUpLFxuICogdGhlbiB3aXRoaW4gZWFjaCBzZWN0aW9uIGZpbmRzICMjIyBSWFhYIFx1MjAxNCBUaXRsZSBibG9ja3MgYW5kIGV4dHJhY3RzIGJ1bGxldCBmaWVsZHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVJlcXVpcmVtZW50c1NlY3Rpb25zKGNvbnRlbnQ6IHN0cmluZyk6IFJlcXVpcmVtZW50W10ge1xuICBjb25zdCBsaW5lcyA9IGNvbnRlbnQuc3BsaXQoJ1xcbicpO1xuICBjb25zdCByZXN1bHRzOiBSZXF1aXJlbWVudFtdID0gW107XG5cbiAgbGV0IGN1cnJlbnRTZWN0aW9uU3RhdHVzOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgbGV0IGN1cnJlbnRSZXE6IFBhcnRpYWw8UmVxdWlyZW1lbnQ+IHwgbnVsbCA9IG51bGw7XG4gIGxldCBjdXJyZW50RnVsbENvbnRlbnRMaW5lczogc3RyaW5nW10gPSBbXTtcblxuICBmdW5jdGlvbiBmbHVzaFJlcSgpOiB2b2lkIHtcbiAgICBpZiAoY3VycmVudFJlcSAmJiBjdXJyZW50UmVxLmlkKSB7XG4gICAgICBjdXJyZW50UmVxLmZ1bGxfY29udGVudCA9IGN1cnJlbnRGdWxsQ29udGVudExpbmVzLmpvaW4oJ1xcbicpLnRyaW0oKTtcbiAgICAgIHJlc3VsdHMucHVzaCh7XG4gICAgICAgIGlkOiBjdXJyZW50UmVxLmlkISxcbiAgICAgICAgY2xhc3M6IGN1cnJlbnRSZXEuY2xhc3MgPz8gJycsXG4gICAgICAgIHN0YXR1czogY3VycmVudFJlcS5zdGF0dXMgPz8gY3VycmVudFNlY3Rpb25TdGF0dXMgPz8gJycsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBjdXJyZW50UmVxLmRlc2NyaXB0aW9uID8/ICcnLFxuICAgICAgICB3aHk6IGN1cnJlbnRSZXEud2h5ID8/ICcnLFxuICAgICAgICBzb3VyY2U6IGN1cnJlbnRSZXEuc291cmNlID8/ICcnLFxuICAgICAgICBwcmltYXJ5X293bmVyOiBjdXJyZW50UmVxLnByaW1hcnlfb3duZXIgPz8gJycsXG4gICAgICAgIHN1cHBvcnRpbmdfc2xpY2VzOiBjdXJyZW50UmVxLnN1cHBvcnRpbmdfc2xpY2VzID8/ICcnLFxuICAgICAgICB2YWxpZGF0aW9uOiBjdXJyZW50UmVxLnZhbGlkYXRpb24gPz8gJycsXG4gICAgICAgIG5vdGVzOiBjdXJyZW50UmVxLm5vdGVzID8/ICcnLFxuICAgICAgICBmdWxsX2NvbnRlbnQ6IGN1cnJlbnRSZXEuZnVsbF9jb250ZW50ID8/ICcnLFxuICAgICAgICBzdXBlcnNlZGVkX2J5OiBjdXJyZW50UmVxLnN1cGVyc2VkZWRfYnkgPz8gbnVsbCxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBjdXJyZW50UmVxID0gbnVsbDtcbiAgICBjdXJyZW50RnVsbENvbnRlbnRMaW5lcyA9IFtdO1xuICB9XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGxpbmUgPSBsaW5lc1tpXTtcbiAgICBjb25zdCBsaW5lTG93ZXIgPSBsaW5lLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuXG4gICAgLy8gQ2hlY2sgZm9yIHNlY3Rpb24gaGVhZGluZyAoIyMgQWN0aXZlLCAjIyBWYWxpZGF0ZWQsIGV0Yy4pXG4gICAgaWYgKGxpbmVMb3dlci5zdGFydHNXaXRoKCcjIyAnKSkge1xuICAgICAgZmx1c2hSZXEoKTtcbiAgICAgIGNvbnN0IG1hdGNoZWRTZWN0aW9uID0gT2JqZWN0LmVudHJpZXMoU1RBVFVTX1NFQ1RJT05TKS5maW5kKFxuICAgICAgICAoW3ByZWZpeF0pID0+IGxpbmVMb3dlciA9PT0gcHJlZml4IHx8IGxpbmVMb3dlci5zdGFydHNXaXRoKHByZWZpeCArICcgJylcbiAgICAgICk7XG4gICAgICBpZiAobWF0Y2hlZFNlY3Rpb24pIHtcbiAgICAgICAgY3VycmVudFNlY3Rpb25TdGF0dXMgPSBtYXRjaGVkU2VjdGlvblsxXTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFNlY3Rpb25zIGxpa2UgIyMgVHJhY2VhYmlsaXR5LCAjIyBDb3ZlcmFnZSBTdW1tYXJ5IFx1MjAxNCBzdG9wIHBhcnNpbmcgcmVxdWlyZW1lbnRzXG4gICAgICAgIGN1cnJlbnRTZWN0aW9uU3RhdHVzID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIENoZWNrIGZvciByZXF1aXJlbWVudCBoZWFkaW5nICgjIyMgUlhYWCBcdTIwMTQgVGl0bGUpXG4gICAgY29uc3QgcmVxTWF0Y2ggPSBsaW5lLm1hdGNoKC9eIyMjXFxzKyhSXFxkKylcXHMqW1x1MjAxNFx1MjAxMy1dXFxzKiguKykvKTtcbiAgICBpZiAocmVxTWF0Y2gpIHtcbiAgICAgIGZsdXNoUmVxKCk7XG4gICAgICBpZiAoY3VycmVudFNlY3Rpb25TdGF0dXMgIT09IG51bGwpIHtcbiAgICAgICAgY3VycmVudFJlcSA9IHtcbiAgICAgICAgICBpZDogcmVxTWF0Y2hbMV0sXG4gICAgICAgICAgc3RhdHVzOiBjdXJyZW50U2VjdGlvblN0YXR1cyxcbiAgICAgICAgfTtcbiAgICAgICAgY3VycmVudEZ1bGxDb250ZW50TGluZXMgPSBbbGluZV07XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBJZiB3ZSdyZSBpbnNpZGUgYSByZXF1aXJlbWVudCBibG9jaywgY29sbGVjdCBjb250ZW50IGFuZCBleHRyYWN0IGJ1bGxldHNcbiAgICBpZiAoY3VycmVudFJlcSAmJiBjdXJyZW50U2VjdGlvblN0YXR1cyAhPT0gbnVsbCkge1xuICAgICAgY3VycmVudEZ1bGxDb250ZW50TGluZXMucHVzaChsaW5lKTtcblxuICAgICAgLy8gRXh0cmFjdCBmaWVsZCBidWxsZXRzOiBcIi0gRmllbGQ6IHZhbHVlXCIgb3IgXCItIEZpZWxkIG5hbWU6IHZhbHVlXCJcbiAgICAgIGNvbnN0IGJ1bGxldE1hdGNoID0gbGluZS5tYXRjaCgvXi1cXHMrKC4rPyk6XFxzKyguKikvKTtcbiAgICAgIGlmIChidWxsZXRNYXRjaCkge1xuICAgICAgICBjb25zdCBmaWVsZE5hbWUgPSBidWxsZXRNYXRjaFsxXS50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgY29uc3QgdmFsdWUgPSBidWxsZXRNYXRjaFsyXS50cmltKCk7XG5cbiAgICAgICAgc3dpdGNoIChmaWVsZE5hbWUpIHtcbiAgICAgICAgICBjYXNlICdjbGFzcyc6XG4gICAgICAgICAgICBjdXJyZW50UmVxLmNsYXNzID0gdmFsdWU7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBjYXNlICdzdGF0dXMnOlxuICAgICAgICAgICAgLy8gQnVsbGV0IHN0YXR1cyB0YWtlcyBwcmVjZWRlbmNlIG92ZXIgc2VjdGlvbiBoZWFkaW5nXG4gICAgICAgICAgICBjdXJyZW50UmVxLnN0YXR1cyA9IHZhbHVlO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgY2FzZSAnZGVzY3JpcHRpb24nOlxuICAgICAgICAgICAgY3VycmVudFJlcS5kZXNjcmlwdGlvbiA9IHZhbHVlO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgY2FzZSAnd2h5IGl0IG1hdHRlcnMnOlxuICAgICAgICAgIGNhc2UgJ3doeSc6XG4gICAgICAgICAgICBjdXJyZW50UmVxLndoeSA9IHZhbHVlO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgY2FzZSAnc291cmNlJzpcbiAgICAgICAgICAgIGN1cnJlbnRSZXEuc291cmNlID0gdmFsdWU7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBjYXNlICdwcmltYXJ5IG93bmluZyBzbGljZSc6XG4gICAgICAgICAgY2FzZSAncHJpbWFyeSBvd25lcic6XG4gICAgICAgICAgY2FzZSAncHJpbWFyeV9vd25lcic6XG4gICAgICAgICAgICBjdXJyZW50UmVxLnByaW1hcnlfb3duZXIgPSB2YWx1ZTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIGNhc2UgJ3N1cHBvcnRpbmcgc2xpY2VzJzpcbiAgICAgICAgICBjYXNlICdzdXBwb3J0aW5nX3NsaWNlcyc6XG4gICAgICAgICAgICBjdXJyZW50UmVxLnN1cHBvcnRpbmdfc2xpY2VzID0gdmFsdWU7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBjYXNlICd2YWxpZGF0aW9uJzpcbiAgICAgICAgICBjYXNlICd2YWxpZGF0ZWQgYnknOlxuICAgICAgICAgICAgY3VycmVudFJlcS52YWxpZGF0aW9uID0gdmFsdWU7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBjYXNlICdub3Rlcyc6XG4gICAgICAgICAgICBjdXJyZW50UmVxLm5vdGVzID0gdmFsdWU7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICBjYXNlICdwcm9vZic6XG4gICAgICAgICAgICAvLyBJbiB2YWxpZGF0ZWQgc2VjdGlvbiwgXCJQcm9vZjpcIiBzZXJ2ZXMgYXMgbm90ZXNcbiAgICAgICAgICAgIGN1cnJlbnRSZXEubm90ZXMgPSB2YWx1ZTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZmx1c2hSZXEoKTtcblxuICAvLyBEZWR1cGxpY2F0ZSBieSBJRDogaWYgYSByZXF1aXJlbWVudCBhcHBlYXJzIGluIGJvdGggQWN0aXZlIGFuZCBWYWxpZGF0ZWQgc2VjdGlvbnMsXG4gIC8vIGtlZXAgdGhlIGZ1bGxlciBlbnRyeSAodHlwaWNhbGx5IEFjdGl2ZSkgYW5kIG1lcmdlIGluIGFueSBub24tZW1wdHkgZmllbGRzIGZyb20gbGF0ZXIgZW50cmllcy5cbiAgY29uc3QgZGVkdXBlZCA9IG5ldyBNYXA8c3RyaW5nLCBSZXF1aXJlbWVudD4oKTtcbiAgZm9yIChjb25zdCByZXEgb2YgcmVzdWx0cykge1xuICAgIGNvbnN0IGV4aXN0aW5nID0gZGVkdXBlZC5nZXQocmVxLmlkKTtcbiAgICBpZiAoIWV4aXN0aW5nKSB7XG4gICAgICBkZWR1cGVkLnNldChyZXEuaWQsIHJlcSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIE1lcmdlOiBub24tZW1wdHkgZmllbGRzIGZyb20gbGF0ZXIgZW50cnkgb3ZlcnJpZGUgZW1wdHkgZmllbGRzIGluIGV4aXN0aW5nXG4gICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhyZXEpIGFzIChrZXlvZiBSZXF1aXJlbWVudClbXSkge1xuICAgICAgICBpZiAoa2V5ID09PSAnaWQnIHx8IGtleSA9PT0gJ3N1cGVyc2VkZWRfYnknKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgdmFsID0gcmVxW2tleV07XG4gICAgICAgIGlmICh2YWwgJiYgdmFsICE9PSAnJyAmJiAoIWV4aXN0aW5nW2tleV0gfHwgZXhpc3Rpbmdba2V5XSA9PT0gJycpKSB7XG4gICAgICAgICAgKGV4aXN0aW5nIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW2tleV0gPSB2YWw7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gQXJyYXkuZnJvbShkZWR1cGVkLnZhbHVlcygpKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEltcG9ydCBGdW5jdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogSW1wb3J0IGRlY2lzaW9ucyBmcm9tIERFQ0lTSU9OUy5tZCBpbnRvIHRoZSBkYXRhYmFzZS5cbiAqIEhhbmRsZXMgc3VwZXJzZXNzaW9uIGNoYWlucy5cbiAqL1xuZnVuY3Rpb24gaW1wb3J0RGVjaXNpb25zKGdzZERpcjogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgZmlsZVBhdGggPSByZXNvbHZlR3NkUm9vdEZpbGUoZ3NkRGlyLCAnREVDSVNJT05TJyk7XG4gIGlmICghZXhpc3RzU3luYyhmaWxlUGF0aCkpIHJldHVybiAwO1xuXG4gIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoZmlsZVBhdGgsICd1dGYtOCcpO1xuICBjb25zdCBkZWNpc2lvbnMgPSBwYXJzZURlY2lzaW9uc1RhYmxlKGNvbnRlbnQpO1xuXG4gIGZvciAoY29uc3QgZCBvZiBkZWNpc2lvbnMpIHtcbiAgICB1cHNlcnREZWNpc2lvbihkKTtcbiAgfVxuXG4gIHJldHVybiBkZWNpc2lvbnMubGVuZ3RoO1xufVxuXG4vKipcbiAqIEltcG9ydCByZXF1aXJlbWVudHMgZnJvbSBSRVFVSVJFTUVOVFMubWQgaW50byB0aGUgZGF0YWJhc2UuXG4gKi9cbmZ1bmN0aW9uIGltcG9ydFJlcXVpcmVtZW50cyhnc2REaXI6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IGZpbGVQYXRoID0gcmVzb2x2ZUdzZFJvb3RGaWxlKGdzZERpciwgJ1JFUVVJUkVNRU5UUycpO1xuICBpZiAoIWV4aXN0c1N5bmMoZmlsZVBhdGgpKSByZXR1cm4gMDtcblxuICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGZpbGVQYXRoLCAndXRmLTgnKTtcbiAgY29uc3QgcmVxdWlyZW1lbnRzID0gcGFyc2VSZXF1aXJlbWVudHNTZWN0aW9ucyhjb250ZW50KTtcblxuICBmb3IgKGNvbnN0IHIgb2YgcmVxdWlyZW1lbnRzKSB7XG4gICAgdXBzZXJ0UmVxdWlyZW1lbnQocik7XG4gIH1cblxuICByZXR1cm4gcmVxdWlyZW1lbnRzLmxlbmd0aDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEhpZXJhcmNoeSBBcnRpZmFjdCBXYWxrZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBBcnRpZmFjdCBzdWZmaXhlcyB0byBsb29rIGZvciBhdCBlYWNoIGhpZXJhcmNoeSBsZXZlbCAqL1xuY29uc3QgTUlMRVNUT05FX1NVRkZJWEVTID0gWydST0FETUFQJywgJ0NPTlRFWFQnLCAnUkVTRUFSQ0gnLCAnQVNTRVNTTUVOVCcsICdTVU1NQVJZJywgJ1ZBTElEQVRJT04nXTtcbmNvbnN0IFNMSUNFX1NVRkZJWEVTID0gWydQTEFOJywgJ1NVTU1BUlknLCAnUkVTRUFSQ0gnLCAnQ09OVEVYVCcsICdBU1NFU1NNRU5UJywgJ1VBVCddO1xuY29uc3QgVEFTS19TVUZGSVhFUyA9IFsnUExBTicsICdTVU1NQVJZJywgJ0NPTlRJTlVFJywgJ0NPTlRFWFQnLCAnUkVTRUFSQ0gnXTtcblxuLyoqXG4gKiBJbXBvcnQgaGllcmFyY2h5IGFydGlmYWN0cyAocm9hZG1hcHMsIHBsYW5zLCBzdW1tYXJpZXMsIGV0Yy4pIGZyb20gdGhlIC5nc2QvIHRyZWUuXG4gKiBXYWxrcyBtaWxlc3RvbmVzIFx1MjE5MiBzbGljZXMgXHUyMTkyIHRhc2tzIGRpcmVjdG9yaWVzLlxuICovXG5mdW5jdGlvbiBpbXBvcnRIaWVyYXJjaHlBcnRpZmFjdHMoZ3NkRGlyOiBzdHJpbmcpOiBudW1iZXIge1xuICBsZXQgY291bnQgPSAwO1xuICBjb25zdCBnc2RQYXRoID0gZ3NkUm9vdChnc2REaXIpO1xuXG4gIC8vIFJvb3QtbGV2ZWwgYXJ0aWZhY3RzOiBQUk9KRUNULm1kLCBRVUVVRS5tZFxuICBjb25zdCByb290RmlsZXMgPSBbJ1BST0pFQ1QubWQnLCAnUVVFVUUubWQnLCAnU0VDUkVUUy1NQU5JRkVTVC5tZCddO1xuICBmb3IgKGNvbnN0IGZpbGVOYW1lIG9mIHJvb3RGaWxlcykge1xuICAgIGNvbnN0IGZpbGVQYXRoID0gam9pbihnc2RQYXRoLCBmaWxlTmFtZSk7XG4gICAgaWYgKGV4aXN0c1N5bmMoZmlsZVBhdGgpKSB7XG4gICAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGZpbGVQYXRoLCAndXRmLTgnKTtcbiAgICAgIGNvbnN0IGFydGlmYWN0VHlwZSA9IGZpbGVOYW1lLnJlcGxhY2UoJy5tZCcsICcnKS5yZXBsYWNlKCctJywgJ18nKTtcbiAgICAgIGluc2VydEFydGlmYWN0KHtcbiAgICAgICAgcGF0aDogZmlsZU5hbWUsXG4gICAgICAgIGFydGlmYWN0X3R5cGU6IGFydGlmYWN0VHlwZSxcbiAgICAgICAgbWlsZXN0b25lX2lkOiBudWxsLFxuICAgICAgICBzbGljZV9pZDogbnVsbCxcbiAgICAgICAgdGFza19pZDogbnVsbCxcbiAgICAgICAgZnVsbF9jb250ZW50OiBjb250ZW50LFxuICAgICAgfSk7XG4gICAgICBjb3VudCsrO1xuICAgIH1cbiAgfVxuXG4gIC8vIFdhbGsgbWlsZXN0b25lc1xuICBjb25zdCBtaWxlc3RvbmVJZHMgPSBmaW5kTWlsZXN0b25lSWRzKGdzZERpcik7XG4gIGNvbnN0IG1zRGlyID0gbWlsZXN0b25lc0Rpcihnc2REaXIpO1xuXG4gIGZvciAoY29uc3QgbWlsZXN0b25lSWQgb2YgbWlsZXN0b25lSWRzKSB7XG4gICAgLy8gRmluZCB0aGUgYWN0dWFsIG1pbGVzdG9uZSBkaXJlY3RvcnkgbmFtZSAoaGFuZGxlcyBsZWdhY3kgbmFtaW5nKVxuICAgIGNvbnN0IG1pbGVzdG9uZURpck5hbWUgPSBmaW5kRGlyQnlQcmVmaXgobXNEaXIsIG1pbGVzdG9uZUlkKTtcbiAgICBpZiAoIW1pbGVzdG9uZURpck5hbWUpIGNvbnRpbnVlO1xuICAgIGNvbnN0IG1pbGVzdG9uZUZ1bGxQYXRoID0gam9pbihtc0RpciwgbWlsZXN0b25lRGlyTmFtZSk7XG5cbiAgICAvLyBNaWxlc3RvbmUtbGV2ZWwgZmlsZXNcbiAgICBjb3VudCArPSBpbXBvcnRGaWxlc0F0TGV2ZWwoXG4gICAgICBtaWxlc3RvbmVGdWxsUGF0aCxcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgTUlMRVNUT05FX1NVRkZJWEVTLFxuICAgICAgYG1pbGVzdG9uZXMvJHttaWxlc3RvbmVEaXJOYW1lfWAsXG4gICAgICBtaWxlc3RvbmVJZCxcbiAgICAgIG51bGwsXG4gICAgICBudWxsLFxuICAgICk7XG5cbiAgICAvLyBXYWxrIHNsaWNlc1xuICAgIGNvbnN0IHNsaWNlc0RpciA9IGpvaW4obWlsZXN0b25lRnVsbFBhdGgsICdzbGljZXMnKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMoc2xpY2VzRGlyKSkgY29udGludWU7XG5cbiAgICBjb25zdCBzbGljZURpcnMgPSByZWFkZGlyU3luYyhzbGljZXNEaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KVxuICAgICAgLmZpbHRlcihkID0+IGQuaXNEaXJlY3RvcnkoKSAmJiAvXlNcXGQrLy50ZXN0KGQubmFtZSkpXG4gICAgICAubWFwKGQgPT4gZC5uYW1lKVxuICAgICAgLnNvcnQoKTtcblxuICAgIGZvciAoY29uc3Qgc2xpY2VEaXJOYW1lIG9mIHNsaWNlRGlycykge1xuICAgICAgY29uc3Qgc2xpY2VJZCA9IHNsaWNlRGlyTmFtZS5tYXRjaCgvXihTXFxkKykvKT8uWzFdID8/IHNsaWNlRGlyTmFtZTtcbiAgICAgIGNvbnN0IHNsaWNlRnVsbFBhdGggPSBqb2luKHNsaWNlc0Rpciwgc2xpY2VEaXJOYW1lKTtcblxuICAgICAgLy8gU2xpY2UtbGV2ZWwgZmlsZXNcbiAgICAgIGNvdW50ICs9IGltcG9ydEZpbGVzQXRMZXZlbChcbiAgICAgICAgc2xpY2VGdWxsUGF0aCxcbiAgICAgICAgc2xpY2VJZCxcbiAgICAgICAgU0xJQ0VfU1VGRklYRVMsXG4gICAgICAgIGBtaWxlc3RvbmVzLyR7bWlsZXN0b25lRGlyTmFtZX0vc2xpY2VzLyR7c2xpY2VEaXJOYW1lfWAsXG4gICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICBzbGljZUlkLFxuICAgICAgICBudWxsLFxuICAgICAgKTtcblxuICAgICAgLy8gV2FsayB0YXNrc1xuICAgICAgY29uc3QgdGFza3NEaXIgPSBqb2luKHNsaWNlRnVsbFBhdGgsICd0YXNrcycpO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKHRhc2tzRGlyKSkgY29udGludWU7XG5cbiAgICAgIGZvciAoY29uc3Qgc3VmZml4IG9mIFRBU0tfU1VGRklYRVMpIHtcbiAgICAgICAgY29uc3QgdGFza0ZpbGVzID0gcmVzb2x2ZVRhc2tGaWxlcyh0YXNrc0Rpciwgc3VmZml4KTtcbiAgICAgICAgZm9yIChjb25zdCB0YXNrRmlsZU5hbWUgb2YgdGFza0ZpbGVzKSB7XG4gICAgICAgICAgY29uc3QgdGFza0lkID0gdGFza0ZpbGVOYW1lLm1hdGNoKC9eKFRcXGQrKS8pPy5bMV0gPz8gbnVsbDtcbiAgICAgICAgICBjb25zdCB0YXNrRmlsZVBhdGggPSBqb2luKHRhc2tzRGlyLCB0YXNrRmlsZU5hbWUpO1xuICAgICAgICAgIGlmICghZXhpc3RzU3luYyh0YXNrRmlsZVBhdGgpKSBjb250aW51ZTtcblxuICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmModGFza0ZpbGVQYXRoLCAndXRmLTgnKTtcbiAgICAgICAgICBjb25zdCByZWxQYXRoID0gYG1pbGVzdG9uZXMvJHttaWxlc3RvbmVEaXJOYW1lfS9zbGljZXMvJHtzbGljZURpck5hbWV9L3Rhc2tzLyR7dGFza0ZpbGVOYW1lfWA7XG5cbiAgICAgICAgICBpbnNlcnRBcnRpZmFjdCh7XG4gICAgICAgICAgICBwYXRoOiByZWxQYXRoLFxuICAgICAgICAgICAgYXJ0aWZhY3RfdHlwZTogc3VmZml4LFxuICAgICAgICAgICAgbWlsZXN0b25lX2lkOiBtaWxlc3RvbmVJZCxcbiAgICAgICAgICAgIHNsaWNlX2lkOiBzbGljZUlkLFxuICAgICAgICAgICAgdGFza19pZDogdGFza0lkLFxuICAgICAgICAgICAgZnVsbF9jb250ZW50OiBjb250ZW50LFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGNvdW50Kys7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gY291bnQ7XG59XG5cbi8qKlxuICogSW1wb3J0IGZpbGVzIGF0IGEgc3BlY2lmaWMgaGllcmFyY2h5IGxldmVsIChtaWxlc3RvbmUgb3Igc2xpY2UpLlxuICovXG5mdW5jdGlvbiBpbXBvcnRGaWxlc0F0TGV2ZWwoXG4gIGRpclBhdGg6IHN0cmluZyxcbiAgaWRQcmVmaXg6IHN0cmluZyxcbiAgc3VmZml4ZXM6IHN0cmluZ1tdLFxuICByZWxhdGl2ZUJhc2U6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgc2xpY2VJZDogc3RyaW5nIHwgbnVsbCxcbiAgdGFza0lkOiBzdHJpbmcgfCBudWxsLFxuKTogbnVtYmVyIHtcbiAgbGV0IGNvdW50ID0gMDtcblxuICBmb3IgKGNvbnN0IHN1ZmZpeCBvZiBzdWZmaXhlcykge1xuICAgIC8vIFRyeSBJRC1TVUZGSVgubWQgcGF0dGVybiAoZS5nLiwgTTAwMS1ST0FETUFQLm1kLCBTMDEtUExBTi5tZClcbiAgICBjb25zdCBmaWxlTmFtZSA9IGZpbmRGaWxlQnlQcmVmaXhBbmRTdWZmaXgoZGlyUGF0aCwgaWRQcmVmaXgsIHN1ZmZpeCk7XG4gICAgaWYgKCFmaWxlTmFtZSkgY29udGludWU7XG5cbiAgICBjb25zdCBmaWxlUGF0aCA9IGpvaW4oZGlyUGF0aCwgZmlsZU5hbWUpO1xuICAgIGlmICghZXhpc3RzU3luYyhmaWxlUGF0aCkpIGNvbnRpbnVlO1xuXG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgJ3V0Zi04Jyk7XG4gICAgY29uc3QgcmVsUGF0aCA9IGAke3JlbGF0aXZlQmFzZX0vJHtmaWxlTmFtZX1gO1xuXG4gICAgaW5zZXJ0QXJ0aWZhY3Qoe1xuICAgICAgcGF0aDogcmVsUGF0aCxcbiAgICAgIGFydGlmYWN0X3R5cGU6IHN1ZmZpeCxcbiAgICAgIG1pbGVzdG9uZV9pZDogbWlsZXN0b25lSWQsXG4gICAgICBzbGljZV9pZDogc2xpY2VJZCxcbiAgICAgIHRhc2tfaWQ6IHRhc2tJZCxcbiAgICAgIGZ1bGxfY29udGVudDogY29udGVudCxcbiAgICB9KTtcbiAgICBjb3VudCsrO1xuICB9XG5cbiAgcmV0dXJuIGNvdW50O1xufVxuXG4vKipcbiAqIEZpbmQgYSBkaXJlY3RvcnkgYnkgSUQgcHJlZml4IHdpdGhpbiBhIHBhcmVudCBkaXJlY3RvcnkuXG4gKi9cbmZ1bmN0aW9uIGZpbmREaXJCeVByZWZpeChwYXJlbnREaXI6IHN0cmluZywgaWRQcmVmaXg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIWV4aXN0c1N5bmMocGFyZW50RGlyKSkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgZW50cmllcyA9IHJlYWRkaXJTeW5jKHBhcmVudERpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xuICAgIC8vIEV4YWN0IG1hdGNoIGZpcnN0XG4gICAgY29uc3QgZXhhY3QgPSBlbnRyaWVzLmZpbmQoZSA9PiBlLmlzRGlyZWN0b3J5KCkgJiYgZS5uYW1lID09PSBpZFByZWZpeCk7XG4gICAgaWYgKGV4YWN0KSByZXR1cm4gZXhhY3QubmFtZTtcbiAgICAvLyBQcmVmaXggbWF0Y2ggZm9yIGxlZ2FjeVxuICAgIGNvbnN0IHByZWZpeGVkID0gZW50cmllcy5maW5kKGUgPT4gZS5pc0RpcmVjdG9yeSgpICYmIGUubmFtZS5zdGFydHNXaXRoKGlkUHJlZml4ICsgJy0nKSk7XG4gICAgcmV0dXJuIHByZWZpeGVkID8gcHJlZml4ZWQubmFtZSA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogRmluZCBhIGZpbGUgYnkgSUQgcHJlZml4IGFuZCBzdWZmaXggd2l0aGluIGEgZGlyZWN0b3J5LlxuICogTWF0Y2hlcyBJRC1TVUZGSVgubWQgb3IgSUQtKi1TVUZGSVgubWQgcGF0dGVybnMuXG4gKi9cbmZ1bmN0aW9uIGZpbmRGaWxlQnlQcmVmaXhBbmRTdWZmaXgoZGlyOiBzdHJpbmcsIGlkUHJlZml4OiBzdHJpbmcsIHN1ZmZpeDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICghZXhpc3RzU3luYyhkaXIpKSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCBlbnRyaWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgICAvLyBEaXJlY3Q6IElELVNVRkZJWC5tZFxuICAgIGNvbnN0IHRhcmdldCA9IGAke2lkUHJlZml4fS0ke3N1ZmZpeH0ubWRgLnRvVXBwZXJDYXNlKCk7XG4gICAgY29uc3QgZGlyZWN0ID0gZW50cmllcy5maW5kKGUgPT4gZS50b1VwcGVyQ2FzZSgpID09PSB0YXJnZXQpO1xuICAgIGlmIChkaXJlY3QpIHJldHVybiBkaXJlY3Q7XG4gICAgLy8gTGVnYWN5OiBJRC1ERVNDUklQVE9SLVNVRkZJWC5tZFxuICAgIGNvbnN0IHBhdHRlcm4gPSBuZXcgUmVnRXhwKGBeJHtpZFByZWZpeH0tLiotJHtzdWZmaXh9XFxcXC5tZCRgLCAnaScpO1xuICAgIGNvbnN0IG1hdGNoID0gZW50cmllcy5maW5kKGUgPT4gcGF0dGVybi50ZXN0KGUpKTtcbiAgICByZXR1cm4gbWF0Y2ggPz8gbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEhpZXJhcmNoeSBNaWdyYXRpb24gKG1pbGVzdG9uZXMvc2xpY2VzL3Rhc2tzIGZyb20gcm9hZG1hcHMrcGxhbnMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFdhbGsgLmdzZC9taWxlc3RvbmVzLyBkaXJzLCBwYXJzZSByb2FkbWFwcyBhbmQgcGxhbnMsIGFuZCBwb3B1bGF0ZVxuICogdGhlIG1pbGVzdG9uZXMvc2xpY2VzL3Rhc2tzIERCIHRhYmxlcy5cbiAqXG4gKiAtIE1pbGVzdG9uZSB0aXRsZTogZnJvbSByb2FkbWFwIEgxIChlLmcuIFwiIyBNMDAxOiBUaXRsZVwiKSBvciBDT05URVhULm1kXG4gKiAtIE1pbGVzdG9uZSBzdGF0dXM6ICdjb21wbGV0ZScgaWYgU1VNTUFSWSBleGlzdHMsICdwYXJrZWQnIGlmIFBBUktFRCBleGlzdHMsIGVsc2UgJ2FjdGl2ZSdcbiAqIC0gTWlsZXN0b25lIGRlcGVuZHNfb246IGZyb20gQ09OVEVYVC5tZCBmcm9udG1hdHRlclxuICogLSBTbGljZSBtZXRhZGF0YTogZnJvbSBwYXJzZVJvYWRtYXAoKSBcdTIwMTQgaWQsIHRpdGxlLCByaXNrLCBkZXBlbmRzLCBkb25lLCBkZW1vXG4gKiAtIFRhc2sgbWV0YWRhdGE6IGZyb20gcGFyc2VQbGFuKCkgXHUyMDE0IGlkLCB0aXRsZSwgZG9uZSwgZXN0aW1hdGVcbiAqXG4gKiBVc2VzIElOU0VSVCBPUiBJR05PUkUgZm9yIGlkZW1wb3RlbmN5LiBJbnNlcnQgb3JkZXI6IG1pbGVzdG9uZXMgXHUyMTkyIHNsaWNlcyBcdTIxOTIgdGFza3MuXG4gKiBHaG9zdCBtaWxlc3RvbmVzIChkaXJzIHdpdGggbm8gQ09OVEVYVCwgUk9BRE1BUCwgb3IgU1VNTUFSWSkgYXJlIHNraXBwZWQuXG4gKlxuICogUmV0dXJucyBjb3VudCBvZiBpbnNlcnRlZCBoaWVyYXJjaHkgaXRlbXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtaWdyYXRlSGllcmFyY2h5VG9EYihiYXNlUGF0aDogc3RyaW5nKToge1xuICBtaWxlc3RvbmVzOiBudW1iZXI7XG4gIHNsaWNlczogbnVtYmVyO1xuICB0YXNrczogbnVtYmVyO1xufSB7XG4gIGNvbnN0IGNvdW50cyA9IHsgbWlsZXN0b25lczogMCwgc2xpY2VzOiAwLCB0YXNrczogMCB9O1xuICBjb25zdCBtaWxlc3RvbmVJZHMgPSBmaW5kTWlsZXN0b25lSWRzKGJhc2VQYXRoKTtcblxuICBmb3IgKGNvbnN0IG1pbGVzdG9uZUlkIG9mIG1pbGVzdG9uZUlkcykge1xuICAgIC8vIENoZWNrIGZvciBnaG9zdCBtaWxlc3RvbmVzIFx1MjAxNCBza2lwIGRpcnMgd2l0aCBubyBtZWFuaW5nZnVsIGNvbnRlbnRcbiAgICBjb25zdCByb2FkbWFwUGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgJ1JPQURNQVAnKTtcbiAgICBjb25zdCBjb250ZXh0UGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgJ0NPTlRFWFQnKTtcbiAgICBjb25zdCBzdW1tYXJ5UGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgJ1NVTU1BUlknKTtcbiAgICBjb25zdCBwYXJrZWRQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCAnUEFSS0VEJyk7XG5cbiAgICBjb25zdCBoYXNSb2FkbWFwID0gcm9hZG1hcFBhdGggIT09IG51bGwgJiYgZXhpc3RzU3luYyhyb2FkbWFwUGF0aCk7XG4gICAgY29uc3QgaGFzQ29udGV4dCA9IGNvbnRleHRQYXRoICE9PSBudWxsICYmIGV4aXN0c1N5bmMoY29udGV4dFBhdGgpO1xuICAgIGNvbnN0IGhhc1N1bW1hcnkgPSBzdW1tYXJ5UGF0aCAhPT0gbnVsbCAmJiBleGlzdHNTeW5jKHN1bW1hcnlQYXRoKTtcbiAgICBjb25zdCBoYXNQYXJrZWQgPSBwYXJrZWRQYXRoICE9PSBudWxsICYmIGV4aXN0c1N5bmMocGFya2VkUGF0aCk7XG5cbiAgICAvLyBHaG9zdCBtaWxlc3RvbmU6IG5vIENPTlRFWFQsIFJPQURNQVAsIG9yIFNVTU1BUlkgXHUyMTkyIHNraXBcbiAgICBpZiAoIWhhc1JvYWRtYXAgJiYgIWhhc0NvbnRleHQgJiYgIWhhc1N1bW1hcnkpIGNvbnRpbnVlO1xuXG4gICAgLy8gRGV0ZXJtaW5lIG1pbGVzdG9uZSB0aXRsZSBmcm9tIHJvYWRtYXAgSDEgb3IgQ09OVEVYVCBoZWFkaW5nXG4gICAgbGV0IG1pbGVzdG9uZVRpdGxlID0gJyc7XG4gICAgbGV0IHJvYWRtYXBDb250ZW50OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgcm9hZG1hcDogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VSb2FkbWFwPiB8IG51bGwgPSBudWxsO1xuICAgIGlmIChoYXNSb2FkbWFwKSB7XG4gICAgICByb2FkbWFwQ29udGVudCA9IHJlYWRGaWxlU3luYyhyb2FkbWFwUGF0aCEsICd1dGYtOCcpO1xuICAgICAgcm9hZG1hcCA9IHBhcnNlUm9hZG1hcChyb2FkbWFwQ29udGVudCk7XG4gICAgICBtaWxlc3RvbmVUaXRsZSA9IHJvYWRtYXAudGl0bGU7XG4gICAgfVxuXG4gICAgLy8gRGV0ZXJtaW5lIG1pbGVzdG9uZSBzdGF0dXNcbiAgICBsZXQgbWlsZXN0b25lU3RhdHVzID0gJ2FjdGl2ZSc7XG4gICAgaWYgKGhhc1N1bW1hcnkpIG1pbGVzdG9uZVN0YXR1cyA9ICdjb21wbGV0ZSc7XG4gICAgZWxzZSBpZiAoaGFzUGFya2VkKSBtaWxlc3RvbmVTdGF0dXMgPSAncGFya2VkJztcbiAgICAvLyBJbXBvcnQgbWlsZXN0b25lcyB3aXRoIGFsbC1kb25lIHJvYWRtYXAgc2xpY2VzIGFzIGNvbXBsZXRlICgjMzM5MCwgIzMzNzkpXG4gICAgLy8gZXZlbiB3aGVuIFNVTU1BUlkubWQgaXMgbWlzc2luZyBcdTIwMTQgdGhlIHJvYWRtYXAgY2hlY2tib3hlcyBhcmUgYXV0aG9yaXRhdGl2ZS5cbiAgICBlbHNlIGlmIChyb2FkbWFwICYmIHJvYWRtYXAuc2xpY2VzLmxlbmd0aCA+IDAgJiYgcm9hZG1hcC5zbGljZXMuZXZlcnkocyA9PiBzLmRvbmUpKSB7XG4gICAgICBtaWxlc3RvbmVTdGF0dXMgPSAnY29tcGxldGUnO1xuICAgIH1cbiAgICBpZiAoIW1pbGVzdG9uZVRpdGxlICYmIGhhc0NvbnRleHQpIHtcbiAgICAgIGNvbnN0IGNvbnRleHRDb250ZW50ID0gcmVhZEZpbGVTeW5jKGNvbnRleHRQYXRoISwgJ3V0Zi04Jyk7XG4gICAgICBjb25zdCBoMU1hdGNoID0gY29udGV4dENvbnRlbnQubWF0Y2goL14jXFxzKyguKykvbSk7XG4gICAgICBpZiAoaDFNYXRjaCkgbWlsZXN0b25lVGl0bGUgPSBoMU1hdGNoWzFdLnRyaW0oKTtcbiAgICB9XG5cbiAgICAvLyBEZXRlcm1pbmUgZGVwZW5kc19vbiBmcm9tIENPTlRFWFQgZnJvbnRtYXR0ZXJcbiAgICBsZXQgZGVwZW5kc09uOiBzdHJpbmdbXSA9IFtdO1xuICAgIGlmIChoYXNDb250ZXh0KSB7XG4gICAgICBjb25zdCBjb250ZXh0Q29udGVudCA9IHJlYWRGaWxlU3luYyhjb250ZXh0UGF0aCEsICd1dGYtOCcpO1xuICAgICAgZGVwZW5kc09uID0gcGFyc2VDb250ZXh0RGVwZW5kc09uKGNvbnRleHRDb250ZW50KTtcbiAgICB9XG5cbiAgICAvLyBFeHRyYWN0IHJhdyBcIiMjIEJvdW5kYXJ5IE1hcFwiIHNlY3Rpb24gZnJvbSByb2FkbWFwIG1hcmtkb3duIGZvciBwbGFubmluZyBjb2x1bW5cbiAgICBsZXQgYm91bmRhcnlNYXBTZWN0aW9uID0gJyc7XG4gICAgaWYgKHJvYWRtYXBDb250ZW50KSB7XG4gICAgICBjb25zdCBibUlkeCA9IHJvYWRtYXBDb250ZW50LmluZGV4T2YoJyMjIEJvdW5kYXJ5IE1hcCcpO1xuICAgICAgaWYgKGJtSWR4ID49IDApIHtcbiAgICAgICAgY29uc3QgYWZ0ZXJCbSA9IHJvYWRtYXBDb250ZW50LnNsaWNlKGJtSWR4KTtcbiAgICAgICAgLy8gVGFrZSBjb250ZW50IHVudGlsIG5leHQgIyMgaGVhZGluZyBvciBFT0ZcbiAgICAgICAgY29uc3QgbmV4dEhlYWRpbmcgPSBhZnRlckJtLmluZGV4T2YoJ1xcbiMjICcsIDEpO1xuICAgICAgICBib3VuZGFyeU1hcFNlY3Rpb24gPSBuZXh0SGVhZGluZyA+PSAwID8gYWZ0ZXJCbS5zbGljZSgwLCBuZXh0SGVhZGluZykudHJpbSgpIDogYWZ0ZXJCbS50cmltKCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gSW5zZXJ0IG1pbGVzdG9uZSAoRksgcGFyZW50IFx1MjAxNCBtdXN0IGNvbWUgZmlyc3QpXG4gICAgaW5zZXJ0TWlsZXN0b25lKHtcbiAgICAgIGlkOiBtaWxlc3RvbmVJZCxcbiAgICAgIHRpdGxlOiBtaWxlc3RvbmVUaXRsZSxcbiAgICAgIHN0YXR1czogbWlsZXN0b25lU3RhdHVzLFxuICAgICAgZGVwZW5kc19vbjogZGVwZW5kc09uLFxuICAgICAgcGxhbm5pbmc6IHtcbiAgICAgICAgdmlzaW9uOiByb2FkbWFwPy52aXNpb24gPz8gJycsXG4gICAgICAgIHN1Y2Nlc3NDcml0ZXJpYTogcm9hZG1hcD8uc3VjY2Vzc0NyaXRlcmlhID8/IFtdLFxuICAgICAgICBib3VuZGFyeU1hcE1hcmtkb3duOiBib3VuZGFyeU1hcFNlY3Rpb24sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIGNvdW50cy5taWxlc3RvbmVzKys7XG5cbiAgICAvLyBQYXJzZSByb2FkbWFwIGZvciBzbGljZXNcbiAgICBpZiAoIXJvYWRtYXApIGNvbnRpbnVlO1xuXG4gICAgZm9yIChsZXQgc2kgPSAwOyBzaSA8IHJvYWRtYXAuc2xpY2VzLmxlbmd0aDsgc2krKykge1xuICAgICAgY29uc3Qgc2xpY2VFbnRyeSA9IHJvYWRtYXAuc2xpY2VzW3NpXSE7XG4gICAgICAvLyBQZXIgSzAwMjogdXNlICdjb21wbGV0ZScgbm90ICdkb25lJ1xuICAgICAgY29uc3Qgc2xpY2VTdGF0dXMgPSBzbGljZUVudHJ5LmRvbmUgPyAnY29tcGxldGUnIDogJ3BlbmRpbmcnO1xuXG4gICAgICAvLyBQYXJzZSBzbGljZSBwbGFuIGVhcmx5IHNvIGdvYWwgaXMgYXZhaWxhYmxlIGZvciBpbnNlcnRTbGljZSBwbGFubmluZyBjb2x1bW5cbiAgICAgIGNvbnN0IHBsYW5QYXRoID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlRW50cnkuaWQsICdQTEFOJyk7XG4gICAgICBsZXQgcGxhbjogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VQbGFuPiB8IG51bGwgPSBudWxsO1xuICAgICAgaWYgKHBsYW5QYXRoICYmIGV4aXN0c1N5bmMocGxhblBhdGgpKSB7XG4gICAgICAgIGNvbnN0IHBsYW5Db250ZW50ID0gcmVhZEZpbGVTeW5jKHBsYW5QYXRoLCAndXRmLTgnKTtcbiAgICAgICAgcGxhbiA9IHBhcnNlUGxhbihwbGFuQ29udGVudCk7XG4gICAgICB9XG5cbiAgICAgIGluc2VydFNsaWNlKHtcbiAgICAgICAgaWQ6IHNsaWNlRW50cnkuaWQsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBtaWxlc3RvbmVJZCxcbiAgICAgICAgdGl0bGU6IHNsaWNlRW50cnkudGl0bGUsXG4gICAgICAgIHN0YXR1czogc2xpY2VTdGF0dXMsXG4gICAgICAgIHJpc2s6IHNsaWNlRW50cnkucmlzayxcbiAgICAgICAgZGVwZW5kczogc2xpY2VFbnRyeS5kZXBlbmRzLFxuICAgICAgICBkZW1vOiBzbGljZUVudHJ5LmRlbW8sXG4gICAgICAgIHNlcXVlbmNlOiBzaSArIDEsIC8vIFByZXNlcnZlIHJvYWRtYXAgcGFyc2Ugb3JkZXIgKCMzMzU2KVxuICAgICAgICBwbGFubmluZzoge1xuICAgICAgICAgIGdvYWw6IHBsYW4/LmdvYWwgPz8gJycsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIGNvdW50cy5zbGljZXMrKztcblxuICAgICAgLy8gSW5zZXJ0IHRhc2tzIGZyb20gcGFyc2VkIHBsYW5cbiAgICAgIGlmICghcGxhbikgY29udGludWU7XG5cbiAgICAgIGZvciAoY29uc3QgdGFza0VudHJ5IG9mIHBsYW4udGFza3MpIHtcbiAgICAgICAgLy8gUGVyIEswMDI6IHVzZSAnY29tcGxldGUnIG5vdCAnZG9uZSdcbiAgICAgICAgbGV0IHRhc2tTdGF0dXM6IHN0cmluZyA9IHRhc2tFbnRyeS5kb25lID8gJ2NvbXBsZXRlJyA6ICdwZW5kaW5nJztcblxuICAgICAgICAvLyBQcmUtbWlncmF0aW9uIGNvbnNpc3RlbmN5OiBpZiB0YXNrIGlzIG1hcmtlZCBkb25lIGluIHRoZSBwbGFuIGJ1dCBoYXNcbiAgICAgICAgLy8gbm8gc3VtbWFyeSBmaWxlIG9uIGRpc2ssIGltcG9ydCBhcyAncGVuZGluZycgc28gaXQgZ2V0cyByZS1leGVjdXRlZFxuICAgICAgICAvLyByYXRoZXIgdGhhbiBzaWxlbnRseSBpbXBvcnRpbmcgYmFkIHN0YXRlIGFzIHRoZSBuZXcgREIgYXV0aG9yaXR5LlxuICAgICAgICBpZiAodGFza1N0YXR1cyA9PT0gJ2NvbXBsZXRlJykge1xuICAgICAgICAgIGNvbnN0IHREaXIgPSByZXNvbHZlVGFza3NEaXIoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZUVudHJ5LmlkKTtcbiAgICAgICAgICBpZiAodERpcikge1xuICAgICAgICAgICAgY29uc3Qgc3VtbWFyeUZpbGUgPSBqb2luKHREaXIsIGAke3Rhc2tFbnRyeS5pZH0tU1VNTUFSWS5tZGApO1xuICAgICAgICAgICAgaWYgKCFleGlzdHNTeW5jKHN1bW1hcnlGaWxlKSkge1xuICAgICAgICAgICAgICB0YXNrU3RhdHVzID0gJ3BlbmRpbmcnO1xuICAgICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgICAgICBgZ3NkLW1pZ3JhdGU6ICR7bWlsZXN0b25lSWR9LyR7c2xpY2VFbnRyeS5pZH0vJHt0YXNrRW50cnkuaWR9IG1hcmtlZCBkb25lIGJ1dCBtaXNzaW5nIHN1bW1hcnkgXHUyMDE0IGltcG9ydGluZyBhcyBwZW5kaW5nXFxuYCxcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpbnNlcnRUYXNrKHtcbiAgICAgICAgICBpZDogdGFza0VudHJ5LmlkLFxuICAgICAgICAgIHNsaWNlSWQ6IHNsaWNlRW50cnkuaWQsXG4gICAgICAgICAgbWlsZXN0b25lSWQ6IG1pbGVzdG9uZUlkLFxuICAgICAgICAgIHRpdGxlOiB0YXNrRW50cnkudGl0bGUsXG4gICAgICAgICAgc3RhdHVzOiB0YXNrU3RhdHVzLFxuICAgICAgICAgIHBsYW5uaW5nOiB7XG4gICAgICAgICAgICBmaWxlczogdGFza0VudHJ5LmZpbGVzID8/IFtdLFxuICAgICAgICAgICAgdmVyaWZ5OiB0YXNrRW50cnkudmVyaWZ5ID8/ICcnLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0pO1xuICAgICAgICBjb3VudHMudGFza3MrKztcbiAgICAgIH1cblxuICAgICAgLy8gUHJlLW1pZ3JhdGlvbiBjb25zaXN0ZW5jeTogaWYgYWxsIHRhc2tzIGFyZSBkb25lIGFuZCB0aGUgc2xpY2VcbiAgICAgIC8vIHN1bW1hcnkgZXhpc3RzIGJ1dCB0aGUgcm9hZG1hcCBjaGVja2JveCBpcyB1bmNoZWNrZWQsIHVwZ3JhZGUgdGhlXG4gICAgICAvLyBzbGljZSB0byBjb21wbGV0ZS4gVGhpcyBoYW5kbGVzIHRoZSBjb21tb25cbiAgICAgIC8vIFwiYWxsX3Rhc2tzX2RvbmVfcm9hZG1hcF9ub3RfY2hlY2tlZFwiIGluY29uc2lzdGVuY3kgdGhhdCB0aGUgb2xkXG4gICAgICAvLyBkb2N0b3Igd291bGQgaGF2ZSBhdXRvLWZpeGVkLiBXaXRob3V0IGEgc2xpY2Ugc3VtbWFyeSwgdGhlIHNsaWNlXG4gICAgICAvLyBpcyBpbiB0aGUgXCJzdW1tYXJpemluZ1wiIHBoYXNlLCBub3QgY29tcGxldGUuXG4gICAgICBpZiAoIXNsaWNlRW50cnkuZG9uZSkge1xuICAgICAgICBjb25zdCBzbGljZVN1bW1hcnlQYXRoID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlRW50cnkuaWQsICdTVU1NQVJZJyk7XG4gICAgICAgIGNvbnN0IGhhc1NsaWNlU3VtbWFyeSA9IHNsaWNlU3VtbWFyeVBhdGggIT09IG51bGwgJiYgZXhpc3RzU3luYyhzbGljZVN1bW1hcnlQYXRoKTtcbiAgICAgICAgY29uc3QgYWxsVGFza3NEb25lID0gcGxhbi50YXNrcy5sZW5ndGggPiAwICYmIHBsYW4udGFza3MuZXZlcnkodCA9PiB7XG4gICAgICAgICAgY29uc3QgdERpciA9IHJlc29sdmVUYXNrc0RpcihiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlRW50cnkuaWQpO1xuICAgICAgICAgIGlmICghdERpcikgcmV0dXJuIHQuZG9uZTtcbiAgICAgICAgICBjb25zdCBzdW1tYXJ5RmlsZSA9IGpvaW4odERpciwgYCR7dC5pZH0tU1VNTUFSWS5tZGApO1xuICAgICAgICAgIHJldHVybiB0LmRvbmUgJiYgZXhpc3RzU3luYyhzdW1tYXJ5RmlsZSk7XG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoYWxsVGFza3NEb25lICYmIGhhc1NsaWNlU3VtbWFyeSkge1xuICAgICAgICAgIGlmIChfZ2V0QWRhcHRlcigpKSB7XG4gICAgICAgICAgICB1cGRhdGVTbGljZVN0YXR1cyhtaWxlc3RvbmVJZCwgc2xpY2VFbnRyeS5pZCwgJ2NvbXBsZXRlJyk7XG4gICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgICAgYGdzZC1taWdyYXRlOiAke21pbGVzdG9uZUlkfS8ke3NsaWNlRW50cnkuaWR9IGFsbCB0YXNrcyArIHNsaWNlIHN1bW1hcnkgY29tcGxldGUgXHUyMDE0IHVwZ3JhZGluZyBzbGljZSB0byBjb21wbGV0ZVxcbmAsXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBjb3VudHM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBPcmNoZXN0cmF0b3IgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogSW1wb3J0IGFsbCBtYXJrZG93biBhcnRpZmFjdHMgZnJvbSBhIC5nc2QvIGRpcmVjdG9yeSBpbnRvIHRoZSBkYXRhYmFzZS5cbiAqIE9wZW5zIHRoZSBEQiBpZiBub3QgYWxyZWFkeSBvcGVuLiBXcmFwcyBhbGwgaW1wb3J0cyBpbiBhIHNpbmdsZSB0cmFuc2FjdGlvbi5cbiAqIFJldHVybnMgY291bnRzIG9mIGltcG9ydGVkIGl0ZW1zIGZvciBsb2dnaW5nLlxuICpcbiAqIE1pc3NpbmcgZmlsZXMgYXJlIHNraXBwZWQgZ3JhY2VmdWxseSBcdTIwMTQgbm8gZXJyb3JzIHByb2R1Y2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWlncmF0ZUZyb21NYXJrZG93bihnc2REaXI6IHN0cmluZyk6IHtcbiAgZGVjaXNpb25zOiBudW1iZXI7XG4gIHJlcXVpcmVtZW50czogbnVtYmVyO1xuICBhcnRpZmFjdHM6IG51bWJlcjtcbiAgaGllcmFyY2h5OiB7IG1pbGVzdG9uZXM6IG51bWJlcjsgc2xpY2VzOiBudW1iZXI7IHRhc2tzOiBudW1iZXIgfTtcbn0ge1xuICBjb25zdCBkYlBhdGggPSBqb2luKGdzZFJvb3QoZ3NkRGlyKSwgJ2dzZC5kYicpO1xuXG4gIC8vIE9wZW4gREIgaWYgbm90IGFscmVhZHkgb3BlblxuICBpZiAoIV9nZXRBZGFwdGVyKCkpIHtcbiAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgfVxuXG4gIGxldCBkZWNpc2lvbnMgPSAwO1xuICBsZXQgcmVxdWlyZW1lbnRzID0gMDtcbiAgbGV0IGFydGlmYWN0cyA9IDA7XG4gIGxldCBoaWVyYXJjaHkgPSB7IG1pbGVzdG9uZXM6IDAsIHNsaWNlczogMCwgdGFza3M6IDAgfTtcblxuICB0cmFuc2FjdGlvbigoKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGRlY2lzaW9ucyA9IGltcG9ydERlY2lzaW9ucyhnc2REaXIpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgbG9nV2FybmluZyhcIm1pZ3JhdGlvblwiLCBgc2tpcHBpbmcgZGVjaXNpb25zIGltcG9ydDogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICByZXF1aXJlbWVudHMgPSBpbXBvcnRSZXF1aXJlbWVudHMoZ3NkRGlyKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJtaWdyYXRpb25cIiwgYHNraXBwaW5nIHJlcXVpcmVtZW50cyBpbXBvcnQ6ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgYXJ0aWZhY3RzID0gaW1wb3J0SGllcmFyY2h5QXJ0aWZhY3RzKGdzZERpcik7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBsb2dXYXJuaW5nKFwibWlncmF0aW9uXCIsIGBza2lwcGluZyBhcnRpZmFjdHMgaW1wb3J0OiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIGhpZXJhcmNoeSA9IG1pZ3JhdGVIaWVyYXJjaHlUb0RiKGdzZERpcik7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBsb2dXYXJuaW5nKFwibWlncmF0aW9uXCIsIGBza2lwcGluZyBoaWVyYXJjaHkgbWlncmF0aW9uOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgfVxuICB9KTtcblxuICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICBgZ3NkLW1pZ3JhdGU6IGltcG9ydGVkICR7ZGVjaXNpb25zfSBkZWNpc2lvbnMsICR7cmVxdWlyZW1lbnRzfSByZXF1aXJlbWVudHMsICR7YXJ0aWZhY3RzfSBhcnRpZmFjdHMsICR7aGllcmFyY2h5Lm1pbGVzdG9uZXN9TS8ke2hpZXJhcmNoeS5zbGljZXN9Uy8ke2hpZXJhcmNoeS50YXNrc31UIGhpZXJhcmNoeVxcbmAsXG4gICk7XG5cbiAgcmV0dXJuIHsgZGVjaXNpb25zLCByZXF1aXJlbWVudHMsIGFydGlmYWN0cywgaGllcmFyY2h5IH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFNQSxTQUFTLGNBQWMsYUFBYSxrQkFBa0I7QUFDdEQsU0FBUyxZQUFzQjtBQUUvQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1A7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUVBO0FBQUEsRUFDQTtBQUFB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
