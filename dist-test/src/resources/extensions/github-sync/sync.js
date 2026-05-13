import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadFile, parseSummary } from "../gsd/files.js";
import { parseRoadmap, parsePlan } from "../gsd/parsers-legacy.js";
import {
  resolveMilestoneFile,
  resolveSliceFile,
  resolveTaskFile
} from "../gsd/paths.js";
import { debugLog } from "../gsd/debug-logger.js";
import { loadEffectiveGSDPreferences } from "../gsd/preferences.js";
import {
  loadSyncMapping,
  saveSyncMapping,
  createEmptyMapping,
  getMilestoneRecord,
  getSliceRecord,
  getTaskRecord,
  setMilestoneRecord,
  setSliceRecord,
  setTaskRecord
} from "./mapping.js";
import {
  ghIsAvailable,
  ghHasRateLimit,
  ghDetectRepo,
  ghCreateIssue,
  ghCloseIssue,
  ghAddComment,
  ghCreateMilestone,
  ghCloseMilestone,
  ghCreatePR,
  ghMarkPRReady,
  ghMergePR,
  ghCreateBranch,
  ghPushBranch,
  ghAddToProject
} from "./cli.js";
import {
  formatMilestoneIssueBody,
  formatSlicePRBody,
  formatTaskIssueBody,
  formatSummaryComment
} from "./templates.js";
async function runGitHubSync(basePath, unitType, unitId) {
  try {
    const config = loadGitHubSyncConfig(basePath);
    if (!config?.enabled) return;
    if (!ghIsAvailable()) {
      debugLog("github-sync", { skip: "gh CLI not available" });
      return;
    }
    const repo = config.repo ?? resolveRepo(basePath);
    if (!repo) {
      debugLog("github-sync", { skip: "could not detect repo" });
      return;
    }
    if (!ghHasRateLimit(basePath)) {
      debugLog("github-sync", { skip: "rate limit low" });
      return;
    }
    let mapping = loadSyncMapping(basePath) ?? createEmptyMapping(repo);
    mapping.repo = repo;
    const parts = unitId.split("/");
    const [mid, sid, tid] = parts;
    switch (unitType) {
      case "plan-milestone":
        if (mid) await syncMilestonePlan(basePath, mapping, config, mid);
        break;
      case "plan-slice":
      case "research-slice":
        if (mid && sid) await syncSlicePlan(basePath, mapping, config, mid, sid);
        break;
      case "execute-task":
      case "reactive-execute":
        if (mid && sid && tid) await syncTaskComplete(basePath, mapping, config, mid, sid, tid);
        break;
      case "complete-slice":
        if (mid && sid) await syncSliceComplete(basePath, mapping, config, mid, sid);
        break;
      case "complete-milestone":
        if (mid) await syncMilestoneComplete(basePath, mapping, config, mid);
        break;
    }
    saveSyncMapping(basePath, mapping);
  } catch (err) {
    debugLog("github-sync", { error: String(err) });
  }
}
function shouldCreateSlicePrForSyncEvent(unitType, config) {
  return unitType === "complete-slice" && config.slice_prs !== false;
}
async function syncMilestonePlan(basePath, mapping, config, mid) {
  if (getMilestoneRecord(mapping, mid)) return;
  const roadmapPath = resolveMilestoneFile(basePath, mid, "ROADMAP");
  if (!roadmapPath) return;
  const content = await loadFile(roadmapPath);
  if (!content) return;
  const roadmap = parseRoadmap(content);
  const title = `${mid}: ${roadmap.title || "Milestone"}`;
  const milestoneResult = ghCreateMilestone(
    basePath,
    mapping.repo,
    title,
    roadmap.vision || ""
  );
  if (!milestoneResult.ok) {
    debugLog("github-sync", { phase: "create-milestone", error: milestoneResult.error });
    return;
  }
  const ghMilestoneNumber = milestoneResult.data;
  const issueBody = formatMilestoneIssueBody({
    id: mid,
    title: roadmap.title || "Milestone",
    vision: roadmap.vision,
    successCriteria: roadmap.successCriteria,
    slices: roadmap.slices?.map((s) => ({
      id: s.id,
      title: s.title
    }))
  });
  const issueResult = ghCreateIssue(basePath, {
    repo: mapping.repo,
    title: `${mid}: ${roadmap.title || "Milestone"} \u2014 Tracking`,
    body: issueBody,
    labels: config.labels,
    milestone: ghMilestoneNumber
  });
  if (!issueResult.ok) {
    debugLog("github-sync", { phase: "create-tracking-issue", error: issueResult.error });
    return;
  }
  if (config.project) {
    ghAddToProject(basePath, mapping.repo, config.project, issueResult.data);
  }
  setMilestoneRecord(mapping, mid, {
    issueNumber: issueResult.data,
    ghMilestoneNumber,
    lastSyncedAt: (/* @__PURE__ */ new Date()).toISOString(),
    state: "open"
  });
  debugLog("github-sync", {
    phase: "milestone-synced",
    mid,
    milestone: ghMilestoneNumber,
    issue: issueResult.data
  });
}
async function syncSlicePlan(basePath, mapping, config, mid, sid) {
  const existingSlice = getSliceRecord(mapping, mid, sid);
  if (existingSlice) return;
  if (!getMilestoneRecord(mapping, mid)) {
    await syncMilestonePlan(basePath, mapping, config, mid);
  }
  const milestoneRecord = getMilestoneRecord(mapping, mid);
  const planPath = resolveSliceFile(basePath, mid, sid, "PLAN");
  if (!planPath) return;
  const content = await loadFile(planPath);
  if (!content) return;
  const plan = parsePlan(content);
  const sliceBranch = `milestone/${mid}/${sid}`;
  const taskIssueNumbers = [];
  if (plan.tasks) {
    for (const task of plan.tasks) {
      if (getTaskRecord(mapping, mid, sid, task.id)) {
        const existing = getTaskRecord(mapping, mid, sid, task.id);
        taskIssueNumbers.push({ id: task.id, title: task.title, issueNumber: existing.issueNumber });
        continue;
      }
      const taskBody = formatTaskIssueBody({
        id: task.id,
        title: task.title,
        description: task.description,
        files: task.files,
        verifyCriteria: task.verify ? [task.verify] : void 0
      });
      const taskResult = ghCreateIssue(basePath, {
        repo: mapping.repo,
        title: `${mid}/${sid}/${task.id}: ${task.title}`,
        body: taskBody,
        labels: config.labels,
        milestone: milestoneRecord?.ghMilestoneNumber,
        parentIssue: milestoneRecord?.issueNumber
      });
      if (taskResult.ok) {
        setTaskRecord(mapping, mid, sid, task.id, {
          issueNumber: taskResult.data,
          lastSyncedAt: (/* @__PURE__ */ new Date()).toISOString(),
          state: "open"
        });
        taskIssueNumbers.push({ id: task.id, title: task.title, issueNumber: taskResult.data });
        if (config.project) {
          ghAddToProject(basePath, mapping.repo, config.project, taskResult.data);
        }
      } else {
        taskIssueNumbers.push({ id: task.id, title: task.title });
      }
    }
  }
  setSliceRecord(mapping, mid, sid, {
    issueNumber: 0,
    prNumber: 0,
    branch: sliceBranch,
    lastSyncedAt: (/* @__PURE__ */ new Date()).toISOString(),
    state: "open"
  });
  debugLog("github-sync", {
    phase: "slice-synced",
    mid,
    sid,
    pr: 0,
    taskIssues: taskIssueNumbers.filter((t) => t.issueNumber).length
  });
}
async function ensureSlicePullRequest(basePath, mapping, mid, sid) {
  const sliceRecord = getSliceRecord(mapping, mid, sid);
  if (!sliceRecord) return null;
  if (sliceRecord.prNumber) return sliceRecord.prNumber;
  const planPath = resolveSliceFile(basePath, mid, sid, "PLAN");
  if (!planPath) return null;
  const content = await loadFile(planPath);
  if (!content) return null;
  const plan = parsePlan(content);
  const sliceBranch = sliceRecord.branch || `milestone/${mid}/${sid}`;
  const milestoneBranch = `milestone/${mid}`;
  const branchResult = ghCreateBranch(basePath, sliceBranch, milestoneBranch);
  if (!branchResult.ok) {
    debugLog("github-sync", { phase: "create-slice-branch", error: branchResult.error });
  }
  const pushResult = ghPushBranch(basePath, sliceBranch);
  if (!pushResult.ok) {
    debugLog("github-sync", { phase: "push-slice-branch", error: pushResult.error });
    return null;
  }
  const tasks = (plan.tasks ?? []).map((task) => ({
    id: task.id,
    title: task.title,
    issueNumber: getTaskRecord(mapping, mid, sid, task.id)?.issueNumber
  }));
  const prResult = ghCreatePR(basePath, {
    repo: mapping.repo,
    base: milestoneBranch,
    head: sliceBranch,
    title: `${sid}: ${plan.title || sid}`,
    body: formatSlicePRBody({
      id: sid,
      title: plan.title || sid,
      goal: plan.goal,
      mustHaves: plan.mustHaves,
      demoCriterion: plan.demo,
      tasks
    }),
    draft: true
  });
  if (!prResult.ok) {
    debugLog("github-sync", { phase: "create-slice-pr", error: prResult.error });
    return null;
  }
  sliceRecord.prNumber = prResult.data;
  sliceRecord.lastSyncedAt = (/* @__PURE__ */ new Date()).toISOString();
  setSliceRecord(mapping, mid, sid, sliceRecord);
  return sliceRecord.prNumber;
}
async function syncTaskComplete(basePath, mapping, config, mid, sid, tid) {
  const taskRecord = getTaskRecord(mapping, mid, sid, tid);
  if (!taskRecord || taskRecord.state === "closed") return;
  let commentOk = true;
  const summaryPath = resolveTaskFile(basePath, mid, sid, tid, "SUMMARY");
  if (summaryPath) {
    const content = await loadFile(summaryPath);
    if (content) {
      const summary = parseSummary(content);
      const comment = formatSummaryComment({
        oneLiner: summary.oneLiner,
        body: summary.whatHappened,
        frontmatter: summary.frontmatter
      });
      const commentResult = ghAddComment(basePath, mapping.repo, taskRecord.issueNumber, comment);
      commentOk = commentResult.ok;
      if (!commentResult.ok) {
        debugLog("github-sync", { phase: "task-comment-failed", mid, sid, tid, error: commentResult.error });
      }
    }
  }
  if (!commentOk) return;
  taskRecord.state = "open";
  taskRecord.lastSyncedAt = (/* @__PURE__ */ new Date()).toISOString();
  setTaskRecord(mapping, mid, sid, tid, taskRecord);
  debugLog("github-sync", { phase: "task-complete-commented", mid, sid, tid, issue: taskRecord.issueNumber });
}
async function syncSliceComplete(basePath, mapping, config, mid, sid) {
  let sliceRecord = getSliceRecord(mapping, mid, sid);
  if (!sliceRecord) {
    await syncSlicePlan(basePath, mapping, config, mid, sid);
    sliceRecord = getSliceRecord(mapping, mid, sid);
  }
  if (!sliceRecord || sliceRecord.state === "closed") return;
  if (!sliceRecord.prNumber && shouldCreateSlicePrForSyncEvent("complete-slice", config)) {
    await ensureSlicePullRequest(basePath, mapping, mid, sid);
    sliceRecord = getSliceRecord(mapping, mid, sid);
    if (!sliceRecord || !sliceRecord.prNumber) return;
  }
  const summaryPath = resolveSliceFile(basePath, mid, sid, "SUMMARY");
  if (summaryPath && sliceRecord.prNumber) {
    const content = await loadFile(summaryPath);
    if (content) {
      const summary = parseSummary(content);
      const comment = formatSummaryComment({
        oneLiner: summary.oneLiner,
        body: summary.whatHappened,
        frontmatter: summary.frontmatter
      });
      ghAddComment(basePath, mapping.repo, sliceRecord.prNumber, comment);
    }
  }
  if (sliceRecord.prNumber) {
    ghMarkPRReady(basePath, mapping.repo, sliceRecord.prNumber);
    ghMergePR(basePath, mapping.repo, sliceRecord.prNumber, "squash");
  }
  sliceRecord.state = "closed";
  sliceRecord.lastSyncedAt = (/* @__PURE__ */ new Date()).toISOString();
  setSliceRecord(mapping, mid, sid, sliceRecord);
  debugLog("github-sync", { phase: "slice-completed", mid, sid, pr: sliceRecord.prNumber });
}
async function syncMilestoneComplete(basePath, mapping, config, mid) {
  const record = getMilestoneRecord(mapping, mid);
  if (!record || record.state === "closed") return;
  ghCloseIssue(
    basePath,
    mapping.repo,
    record.issueNumber,
    `Milestone ${mid} completed.`
  );
  ghCloseMilestone(basePath, mapping.repo, record.ghMilestoneNumber);
  record.state = "closed";
  record.lastSyncedAt = (/* @__PURE__ */ new Date()).toISOString();
  setMilestoneRecord(mapping, mid, record);
  debugLog("github-sync", { phase: "milestone-completed", mid });
}
async function bootstrapSync(basePath) {
  const config = loadGitHubSyncConfig(basePath);
  if (!config?.enabled) return { milestones: 0, slices: 0, tasks: 0 };
  if (!ghIsAvailable()) return { milestones: 0, slices: 0, tasks: 0 };
  const repo = config.repo ?? resolveRepo(basePath);
  if (!repo) return { milestones: 0, slices: 0, tasks: 0 };
  let mapping = loadSyncMapping(basePath) ?? createEmptyMapping(repo);
  mapping.repo = repo;
  const taskCountBefore = Object.keys(mapping.tasks).length;
  const counts = { milestones: 0, slices: 0, tasks: 0 };
  const milestonesDir = join(basePath, ".gsd", "milestones");
  if (!existsSync(milestonesDir)) return counts;
  const milestoneIds = readdirSync(milestonesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const mid of milestoneIds) {
    if (!getMilestoneRecord(mapping, mid)) {
      await syncMilestonePlan(basePath, mapping, config, mid);
      counts.milestones++;
    }
    const slicesDir = join(milestonesDir, mid, "slices");
    if (!existsSync(slicesDir)) continue;
    const sliceIds = readdirSync(slicesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const sid of sliceIds) {
      if (!getSliceRecord(mapping, mid, sid)) {
        await syncSlicePlan(basePath, mapping, config, mid, sid);
        counts.slices++;
      }
    }
  }
  counts.tasks = Object.keys(mapping.tasks).length - taskCountBefore;
  saveSyncMapping(basePath, mapping);
  return counts;
}
const _cachedConfigByBasePath = /* @__PURE__ */ new Map();
function loadGitHubSyncConfig(basePath) {
  if (_cachedConfigByBasePath.has(basePath)) return _cachedConfigByBasePath.get(basePath);
  try {
    const prefs = loadEffectiveGSDPreferences(basePath);
    const github = prefs?.preferences?.github;
    if (!github || typeof github !== "object") {
      _cachedConfigByBasePath.set(basePath, null);
      return null;
    }
    const config = github;
    _cachedConfigByBasePath.set(basePath, config);
    return config;
  } catch {
    _cachedConfigByBasePath.set(basePath, null);
    return null;
  }
}
function _resetConfigCache() {
  _cachedConfigByBasePath.clear();
}
function resolveRepo(basePath) {
  const result = ghDetectRepo(basePath);
  return result.ok ? result.data : null;
}
function getTaskIssueNumberForCommit(basePath, mid, sid, tid) {
  try {
    const config = loadGitHubSyncConfig(basePath);
    if (!config?.enabled) return null;
    if (config.auto_link_commits === false) return null;
    const mapping = loadSyncMapping(basePath);
    if (!mapping) return null;
    const record = getTaskRecord(mapping, mid, sid, tid);
    return record?.issueNumber ?? null;
  } catch {
    return null;
  }
}
export {
  _resetConfigCache,
  bootstrapSync,
  getTaskIssueNumberForCommit,
  runGitHubSync,
  shouldCreateSlicePrForSyncEvent
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dpdGh1Yi1zeW5jL3N5bmMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogQ29yZSBHaXRIdWIgc3luYyBlbmdpbmUuXG4gKlxuICogRW50cnkgcG9pbnQ6IGBydW5HaXRIdWJTeW5jKClgIFx1MjAxNCBjYWxsZWQgZnJvbSB0aGUgR1NEIHBvc3QtdW5pdCBwaXBlbGluZS5cbiAqIFJvdXRlcyB0byBwZXItZXZlbnQgc3luYyBmdW5jdGlvbnMgYmFzZWQgb24gdGhlIHVuaXQgdHlwZSwgcmVhZHMgR1NEXG4gKiBmaWxlcyB0byBidWlsZCBHaXRIdWIgZW50aXRpZXMsIGFuZCBwZXJzaXN0cyB0aGUgc3luYyBtYXBwaW5nLlxuICpcbiAqIEFsbCBlcnJvcnMgYXJlIGNhdWdodCBpbnRlcm5hbGx5IFx1MjAxNCBzeW5jIGZhaWx1cmVzIG5ldmVyIGJsb2NrIGV4ZWN1dGlvbi5cbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkZGlyU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgbG9hZEZpbGUsIHBhcnNlU3VtbWFyeSB9IGZyb20gXCIuLi9nc2QvZmlsZXMuanNcIjtcbmltcG9ydCB7IHBhcnNlUm9hZG1hcCwgcGFyc2VQbGFuIH0gZnJvbSBcIi4uL2dzZC9wYXJzZXJzLWxlZ2FjeS5qc1wiO1xuaW1wb3J0IHtcbiAgcmVzb2x2ZU1pbGVzdG9uZUZpbGUsXG4gIHJlc29sdmVTbGljZUZpbGUsXG4gIHJlc29sdmVUYXNrRmlsZSxcbn0gZnJvbSBcIi4uL2dzZC9wYXRocy5qc1wiO1xuaW1wb3J0IHsgZGVidWdMb2cgfSBmcm9tIFwiLi4vZ3NkL2RlYnVnLWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzIH0gZnJvbSBcIi4uL2dzZC9wcmVmZXJlbmNlcy5qc1wiO1xuXG5pbXBvcnQgdHlwZSB7IEdpdEh1YlN5bmNDb25maWcsIFN5bmNNYXBwaW5nIH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB7XG4gIGxvYWRTeW5jTWFwcGluZyxcbiAgc2F2ZVN5bmNNYXBwaW5nLFxuICBjcmVhdGVFbXB0eU1hcHBpbmcsXG4gIGdldE1pbGVzdG9uZVJlY29yZCxcbiAgZ2V0U2xpY2VSZWNvcmQsXG4gIGdldFRhc2tSZWNvcmQsXG4gIHNldE1pbGVzdG9uZVJlY29yZCxcbiAgc2V0U2xpY2VSZWNvcmQsXG4gIHNldFRhc2tSZWNvcmQsXG59IGZyb20gXCIuL21hcHBpbmcuanNcIjtcbmltcG9ydCB7XG4gIGdoSXNBdmFpbGFibGUsXG4gIGdoSGFzUmF0ZUxpbWl0LFxuICBnaERldGVjdFJlcG8sXG4gIGdoQ3JlYXRlSXNzdWUsXG4gIGdoQ2xvc2VJc3N1ZSxcbiAgZ2hBZGRDb21tZW50LFxuICBnaENyZWF0ZU1pbGVzdG9uZSxcbiAgZ2hDbG9zZU1pbGVzdG9uZSxcbiAgZ2hDcmVhdGVQUixcbiAgZ2hNYXJrUFJSZWFkeSxcbiAgZ2hNZXJnZVBSLFxuICBnaENyZWF0ZUJyYW5jaCxcbiAgZ2hQdXNoQnJhbmNoLFxuICBnaEFkZFRvUHJvamVjdCxcbn0gZnJvbSBcIi4vY2xpLmpzXCI7XG5pbXBvcnQge1xuICBmb3JtYXRNaWxlc3RvbmVJc3N1ZUJvZHksXG4gIGZvcm1hdFNsaWNlUFJCb2R5LFxuICBmb3JtYXRUYXNrSXNzdWVCb2R5LFxuICBmb3JtYXRTdW1tYXJ5Q29tbWVudCxcbn0gZnJvbSBcIi4vdGVtcGxhdGVzLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBFbnRyeSBQb2ludCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBNYWluIHN5bmMgZW50cnkgcG9pbnQgXHUyMDE0IGNhbGxlZCBmcm9tIEdTRCBwb3N0LXVuaXQgcGlwZWxpbmUuXG4gKiBSb3V0ZXMgdG8gdGhlIGFwcHJvcHJpYXRlIHN5bmMgZnVuY3Rpb24gYmFzZWQgb24gdW5pdCB0eXBlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuR2l0SHViU3luYyhcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgdW5pdFR5cGU6IHN0cmluZyxcbiAgdW5pdElkOiBzdHJpbmcsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjb25maWcgPSBsb2FkR2l0SHViU3luY0NvbmZpZyhiYXNlUGF0aCk7XG4gICAgaWYgKCFjb25maWc/LmVuYWJsZWQpIHJldHVybjtcbiAgICBpZiAoIWdoSXNBdmFpbGFibGUoKSkge1xuICAgICAgZGVidWdMb2coXCJnaXRodWItc3luY1wiLCB7IHNraXA6IFwiZ2ggQ0xJIG5vdCBhdmFpbGFibGVcIiB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBSZXNvbHZlIHJlcG9cbiAgICBjb25zdCByZXBvID0gY29uZmlnLnJlcG8gPz8gcmVzb2x2ZVJlcG8oYmFzZVBhdGgpO1xuICAgIGlmICghcmVwbykge1xuICAgICAgZGVidWdMb2coXCJnaXRodWItc3luY1wiLCB7IHNraXA6IFwiY291bGQgbm90IGRldGVjdCByZXBvXCIgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gUmF0ZSBsaW1pdCBjaGVja1xuICAgIGlmICghZ2hIYXNSYXRlTGltaXQoYmFzZVBhdGgpKSB7XG4gICAgICBkZWJ1Z0xvZyhcImdpdGh1Yi1zeW5jXCIsIHsgc2tpcDogXCJyYXRlIGxpbWl0IGxvd1wiIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIExvYWQgb3IgaW5pdCBtYXBwaW5nXG4gICAgbGV0IG1hcHBpbmcgPSBsb2FkU3luY01hcHBpbmcoYmFzZVBhdGgpID8/IGNyZWF0ZUVtcHR5TWFwcGluZyhyZXBvKTtcbiAgICBtYXBwaW5nLnJlcG8gPSByZXBvO1xuXG4gICAgLy8gUGFyc2UgdW5pdCBJRCBwYXJ0c1xuICAgIGNvbnN0IHBhcnRzID0gdW5pdElkLnNwbGl0KFwiL1wiKTtcbiAgICBjb25zdCBbbWlkLCBzaWQsIHRpZF0gPSBwYXJ0cztcblxuICAgIC8vIFJvdXRlIGJ5IHVuaXQgdHlwZVxuICAgIHN3aXRjaCAodW5pdFR5cGUpIHtcbiAgICAgIGNhc2UgXCJwbGFuLW1pbGVzdG9uZVwiOlxuICAgICAgICBpZiAobWlkKSBhd2FpdCBzeW5jTWlsZXN0b25lUGxhbihiYXNlUGF0aCwgbWFwcGluZywgY29uZmlnLCBtaWQpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJwbGFuLXNsaWNlXCI6XG4gICAgICBjYXNlIFwicmVzZWFyY2gtc2xpY2VcIjpcbiAgICAgICAgaWYgKG1pZCAmJiBzaWQpIGF3YWl0IHN5bmNTbGljZVBsYW4oYmFzZVBhdGgsIG1hcHBpbmcsIGNvbmZpZywgbWlkLCBzaWQpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJleGVjdXRlLXRhc2tcIjpcbiAgICAgIGNhc2UgXCJyZWFjdGl2ZS1leGVjdXRlXCI6XG4gICAgICAgIGlmIChtaWQgJiYgc2lkICYmIHRpZCkgYXdhaXQgc3luY1Rhc2tDb21wbGV0ZShiYXNlUGF0aCwgbWFwcGluZywgY29uZmlnLCBtaWQsIHNpZCwgdGlkKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiY29tcGxldGUtc2xpY2VcIjpcbiAgICAgICAgaWYgKG1pZCAmJiBzaWQpIGF3YWl0IHN5bmNTbGljZUNvbXBsZXRlKGJhc2VQYXRoLCBtYXBwaW5nLCBjb25maWcsIG1pZCwgc2lkKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiY29tcGxldGUtbWlsZXN0b25lXCI6XG4gICAgICAgIGlmIChtaWQpIGF3YWl0IHN5bmNNaWxlc3RvbmVDb21wbGV0ZShiYXNlUGF0aCwgbWFwcGluZywgY29uZmlnLCBtaWQpO1xuICAgICAgICBicmVhaztcbiAgICB9XG5cbiAgICBzYXZlU3luY01hcHBpbmcoYmFzZVBhdGgsIG1hcHBpbmcpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBkZWJ1Z0xvZyhcImdpdGh1Yi1zeW5jXCIsIHsgZXJyb3I6IFN0cmluZyhlcnIpIH0pO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRDcmVhdGVTbGljZVByRm9yU3luY0V2ZW50KFxuICB1bml0VHlwZTogc3RyaW5nLFxuICBjb25maWc6IFBpY2s8R2l0SHViU3luY0NvbmZpZywgXCJzbGljZV9wcnNcIj4sXG4pOiBib29sZWFuIHtcbiAgcmV0dXJuIHVuaXRUeXBlID09PSBcImNvbXBsZXRlLXNsaWNlXCIgJiYgY29uZmlnLnNsaWNlX3BycyAhPT0gZmFsc2U7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQZXItRXZlbnQgU3luYyBGdW5jdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmFzeW5jIGZ1bmN0aW9uIHN5bmNNaWxlc3RvbmVQbGFuKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtYXBwaW5nOiBTeW5jTWFwcGluZyxcbiAgY29uZmlnOiBHaXRIdWJTeW5jQ29uZmlnLFxuICBtaWQ6IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICAvLyBTa2lwIGlmIGFscmVhZHkgc3luY2VkXG4gIGlmIChnZXRNaWxlc3RvbmVSZWNvcmQobWFwcGluZywgbWlkKSkgcmV0dXJuO1xuXG4gIC8vIExvYWQgcm9hZG1hcCBkYXRhXG4gIGNvbnN0IHJvYWRtYXBQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJST0FETUFQXCIpO1xuICBpZiAoIXJvYWRtYXBQYXRoKSByZXR1cm47XG4gIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZShyb2FkbWFwUGF0aCk7XG4gIGlmICghY29udGVudCkgcmV0dXJuO1xuXG4gIGNvbnN0IHJvYWRtYXAgPSBwYXJzZVJvYWRtYXAoY29udGVudCk7XG4gIGNvbnN0IHRpdGxlID0gYCR7bWlkfTogJHtyb2FkbWFwLnRpdGxlIHx8IFwiTWlsZXN0b25lXCJ9YDtcblxuICAvLyBDcmVhdGUgR2l0SHViIE1pbGVzdG9uZVxuICBjb25zdCBtaWxlc3RvbmVSZXN1bHQgPSBnaENyZWF0ZU1pbGVzdG9uZShcbiAgICBiYXNlUGF0aCxcbiAgICBtYXBwaW5nLnJlcG8sXG4gICAgdGl0bGUsXG4gICAgcm9hZG1hcC52aXNpb24gfHwgXCJcIixcbiAgKTtcbiAgaWYgKCFtaWxlc3RvbmVSZXN1bHQub2spIHtcbiAgICBkZWJ1Z0xvZyhcImdpdGh1Yi1zeW5jXCIsIHsgcGhhc2U6IFwiY3JlYXRlLW1pbGVzdG9uZVwiLCBlcnJvcjogbWlsZXN0b25lUmVzdWx0LmVycm9yIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBnaE1pbGVzdG9uZU51bWJlciA9IG1pbGVzdG9uZVJlc3VsdC5kYXRhITtcblxuICAvLyBDcmVhdGUgdHJhY2tpbmcgaXNzdWVcbiAgY29uc3QgaXNzdWVCb2R5ID0gZm9ybWF0TWlsZXN0b25lSXNzdWVCb2R5KHtcbiAgICBpZDogbWlkLFxuICAgIHRpdGxlOiByb2FkbWFwLnRpdGxlIHx8IFwiTWlsZXN0b25lXCIsXG4gICAgdmlzaW9uOiByb2FkbWFwLnZpc2lvbixcbiAgICBzdWNjZXNzQ3JpdGVyaWE6IHJvYWRtYXAuc3VjY2Vzc0NyaXRlcmlhLFxuICAgIHNsaWNlczogcm9hZG1hcC5zbGljZXM/Lm1hcChzID0+ICh7XG4gICAgICBpZDogcy5pZCxcbiAgICAgIHRpdGxlOiBzLnRpdGxlLFxuICAgIH0pKSxcbiAgfSk7XG5cbiAgY29uc3QgaXNzdWVSZXN1bHQgPSBnaENyZWF0ZUlzc3VlKGJhc2VQYXRoLCB7XG4gICAgcmVwbzogbWFwcGluZy5yZXBvLFxuICAgIHRpdGxlOiBgJHttaWR9OiAke3JvYWRtYXAudGl0bGUgfHwgXCJNaWxlc3RvbmVcIn0gXHUyMDE0IFRyYWNraW5nYCxcbiAgICBib2R5OiBpc3N1ZUJvZHksXG4gICAgbGFiZWxzOiBjb25maWcubGFiZWxzLFxuICAgIG1pbGVzdG9uZTogZ2hNaWxlc3RvbmVOdW1iZXIsXG4gIH0pO1xuICBpZiAoIWlzc3VlUmVzdWx0Lm9rKSB7XG4gICAgZGVidWdMb2coXCJnaXRodWItc3luY1wiLCB7IHBoYXNlOiBcImNyZWF0ZS10cmFja2luZy1pc3N1ZVwiLCBlcnJvcjogaXNzdWVSZXN1bHQuZXJyb3IgfSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQWRkIHRvIHByb2plY3QgaWYgY29uZmlndXJlZFxuICBpZiAoY29uZmlnLnByb2plY3QpIHtcbiAgICBnaEFkZFRvUHJvamVjdChiYXNlUGF0aCwgbWFwcGluZy5yZXBvLCBjb25maWcucHJvamVjdCwgaXNzdWVSZXN1bHQuZGF0YSEpO1xuICB9XG5cbiAgc2V0TWlsZXN0b25lUmVjb3JkKG1hcHBpbmcsIG1pZCwge1xuICAgIGlzc3VlTnVtYmVyOiBpc3N1ZVJlc3VsdC5kYXRhISxcbiAgICBnaE1pbGVzdG9uZU51bWJlcixcbiAgICBsYXN0U3luY2VkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICBzdGF0ZTogXCJvcGVuXCIsXG4gIH0pO1xuXG4gIGRlYnVnTG9nKFwiZ2l0aHViLXN5bmNcIiwge1xuICAgIHBoYXNlOiBcIm1pbGVzdG9uZS1zeW5jZWRcIixcbiAgICBtaWQsXG4gICAgbWlsZXN0b25lOiBnaE1pbGVzdG9uZU51bWJlcixcbiAgICBpc3N1ZTogaXNzdWVSZXN1bHQuZGF0YSxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN5bmNTbGljZVBsYW4oXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1hcHBpbmc6IFN5bmNNYXBwaW5nLFxuICBjb25maWc6IEdpdEh1YlN5bmNDb25maWcsXG4gIG1pZDogc3RyaW5nLFxuICBzaWQ6IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBleGlzdGluZ1NsaWNlID0gZ2V0U2xpY2VSZWNvcmQobWFwcGluZywgbWlkLCBzaWQpO1xuICBpZiAoZXhpc3RpbmdTbGljZSkgcmV0dXJuO1xuXG4gIC8vIEVuc3VyZSBtaWxlc3RvbmUgaXMgc3luY2VkIGZpcnN0XG4gIGlmICghZ2V0TWlsZXN0b25lUmVjb3JkKG1hcHBpbmcsIG1pZCkpIHtcbiAgICBhd2FpdCBzeW5jTWlsZXN0b25lUGxhbihiYXNlUGF0aCwgbWFwcGluZywgY29uZmlnLCBtaWQpO1xuICB9XG4gIGNvbnN0IG1pbGVzdG9uZVJlY29yZCA9IGdldE1pbGVzdG9uZVJlY29yZChtYXBwaW5nLCBtaWQpO1xuXG4gIC8vIExvYWQgc2xpY2UgcGxhblxuICBjb25zdCBwbGFuUGF0aCA9IHJlc29sdmVTbGljZUZpbGUoYmFzZVBhdGgsIG1pZCwgc2lkLCBcIlBMQU5cIik7XG4gIGlmICghcGxhblBhdGgpIHJldHVybjtcbiAgY29uc3QgY29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHBsYW5QYXRoKTtcbiAgaWYgKCFjb250ZW50KSByZXR1cm47XG5cbiAgY29uc3QgcGxhbiA9IHBhcnNlUGxhbihjb250ZW50KTtcbiAgY29uc3Qgc2xpY2VCcmFuY2ggPSBgbWlsZXN0b25lLyR7bWlkfS8ke3NpZH1gO1xuXG4gIC8vIENyZWF0ZSB0YXNrIHN1Yi1pc3N1ZXMgZmlyc3QgKHNvIHdlIGNhbiBsaW5rIHRoZW0gaW4gdGhlIFBSIGJvZHkpXG4gIGNvbnN0IHRhc2tJc3N1ZU51bWJlcnM6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgaXNzdWVOdW1iZXI/OiBudW1iZXIgfT4gPSBbXTtcblxuICBpZiAocGxhbi50YXNrcykge1xuICAgIGZvciAoY29uc3QgdGFzayBvZiBwbGFuLnRhc2tzKSB7XG4gICAgICAvLyBTa2lwIGlmIGFscmVhZHkgc3luY2VkXG4gICAgICBpZiAoZ2V0VGFza1JlY29yZChtYXBwaW5nLCBtaWQsIHNpZCwgdGFzay5pZCkpIHtcbiAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBnZXRUYXNrUmVjb3JkKG1hcHBpbmcsIG1pZCwgc2lkLCB0YXNrLmlkKSE7XG4gICAgICAgIHRhc2tJc3N1ZU51bWJlcnMucHVzaCh7IGlkOiB0YXNrLmlkLCB0aXRsZTogdGFzay50aXRsZSwgaXNzdWVOdW1iZXI6IGV4aXN0aW5nLmlzc3VlTnVtYmVyIH0pO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgdGFza0JvZHkgPSBmb3JtYXRUYXNrSXNzdWVCb2R5KHtcbiAgICAgICAgaWQ6IHRhc2suaWQsXG4gICAgICAgIHRpdGxlOiB0YXNrLnRpdGxlLFxuICAgICAgICBkZXNjcmlwdGlvbjogdGFzay5kZXNjcmlwdGlvbixcbiAgICAgICAgZmlsZXM6IHRhc2suZmlsZXMsXG4gICAgICAgIHZlcmlmeUNyaXRlcmlhOiB0YXNrLnZlcmlmeSA/IFt0YXNrLnZlcmlmeV0gOiB1bmRlZmluZWQsXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgdGFza1Jlc3VsdCA9IGdoQ3JlYXRlSXNzdWUoYmFzZVBhdGgsIHtcbiAgICAgICAgcmVwbzogbWFwcGluZy5yZXBvLFxuICAgICAgICB0aXRsZTogYCR7bWlkfS8ke3NpZH0vJHt0YXNrLmlkfTogJHt0YXNrLnRpdGxlfWAsXG4gICAgICAgIGJvZHk6IHRhc2tCb2R5LFxuICAgICAgICBsYWJlbHM6IGNvbmZpZy5sYWJlbHMsXG4gICAgICAgIG1pbGVzdG9uZTogbWlsZXN0b25lUmVjb3JkPy5naE1pbGVzdG9uZU51bWJlcixcbiAgICAgICAgcGFyZW50SXNzdWU6IG1pbGVzdG9uZVJlY29yZD8uaXNzdWVOdW1iZXIsXG4gICAgICB9KTtcblxuICAgICAgaWYgKHRhc2tSZXN1bHQub2spIHtcbiAgICAgICAgc2V0VGFza1JlY29yZChtYXBwaW5nLCBtaWQsIHNpZCwgdGFzay5pZCwge1xuICAgICAgICAgIGlzc3VlTnVtYmVyOiB0YXNrUmVzdWx0LmRhdGEhLFxuICAgICAgICAgIGxhc3RTeW5jZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICAgIHN0YXRlOiBcIm9wZW5cIixcbiAgICAgICAgfSk7XG4gICAgICAgIHRhc2tJc3N1ZU51bWJlcnMucHVzaCh7IGlkOiB0YXNrLmlkLCB0aXRsZTogdGFzay50aXRsZSwgaXNzdWVOdW1iZXI6IHRhc2tSZXN1bHQuZGF0YSEgfSk7XG5cbiAgICAgICAgaWYgKGNvbmZpZy5wcm9qZWN0KSB7XG4gICAgICAgICAgZ2hBZGRUb1Byb2plY3QoYmFzZVBhdGgsIG1hcHBpbmcucmVwbywgY29uZmlnLnByb2plY3QsIHRhc2tSZXN1bHQuZGF0YSEpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0YXNrSXNzdWVOdW1iZXJzLnB1c2goeyBpZDogdGFzay5pZCwgdGl0bGU6IHRhc2sudGl0bGUgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgc2V0U2xpY2VSZWNvcmQobWFwcGluZywgbWlkLCBzaWQsIHtcbiAgICBpc3N1ZU51bWJlcjogMCxcbiAgICBwck51bWJlcjogMCxcbiAgICBicmFuY2g6IHNsaWNlQnJhbmNoLFxuICAgIGxhc3RTeW5jZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIHN0YXRlOiBcIm9wZW5cIixcbiAgfSk7XG5cbiAgZGVidWdMb2coXCJnaXRodWItc3luY1wiLCB7XG4gICAgcGhhc2U6IFwic2xpY2Utc3luY2VkXCIsXG4gICAgbWlkLFxuICAgIHNpZCxcbiAgICBwcjogMCxcbiAgICB0YXNrSXNzdWVzOiB0YXNrSXNzdWVOdW1iZXJzLmZpbHRlcih0ID0+IHQuaXNzdWVOdW1iZXIpLmxlbmd0aCxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZVNsaWNlUHVsbFJlcXVlc3QoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1hcHBpbmc6IFN5bmNNYXBwaW5nLFxuICBtaWQ6IHN0cmluZyxcbiAgc2lkOiBzdHJpbmcsXG4pOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgY29uc3Qgc2xpY2VSZWNvcmQgPSBnZXRTbGljZVJlY29yZChtYXBwaW5nLCBtaWQsIHNpZCk7XG4gIGlmICghc2xpY2VSZWNvcmQpIHJldHVybiBudWxsO1xuICBpZiAoc2xpY2VSZWNvcmQucHJOdW1iZXIpIHJldHVybiBzbGljZVJlY29yZC5wck51bWJlcjtcblxuICBjb25zdCBwbGFuUGF0aCA9IHJlc29sdmVTbGljZUZpbGUoYmFzZVBhdGgsIG1pZCwgc2lkLCBcIlBMQU5cIik7XG4gIGlmICghcGxhblBhdGgpIHJldHVybiBudWxsO1xuICBjb25zdCBjb250ZW50ID0gYXdhaXQgbG9hZEZpbGUocGxhblBhdGgpO1xuICBpZiAoIWNvbnRlbnQpIHJldHVybiBudWxsO1xuICBjb25zdCBwbGFuID0gcGFyc2VQbGFuKGNvbnRlbnQpO1xuXG4gIGNvbnN0IHNsaWNlQnJhbmNoID0gc2xpY2VSZWNvcmQuYnJhbmNoIHx8IGBtaWxlc3RvbmUvJHttaWR9LyR7c2lkfWA7XG4gIGNvbnN0IG1pbGVzdG9uZUJyYW5jaCA9IGBtaWxlc3RvbmUvJHttaWR9YDtcblxuICBjb25zdCBicmFuY2hSZXN1bHQgPSBnaENyZWF0ZUJyYW5jaChiYXNlUGF0aCwgc2xpY2VCcmFuY2gsIG1pbGVzdG9uZUJyYW5jaCk7XG4gIGlmICghYnJhbmNoUmVzdWx0Lm9rKSB7XG4gICAgZGVidWdMb2coXCJnaXRodWItc3luY1wiLCB7IHBoYXNlOiBcImNyZWF0ZS1zbGljZS1icmFuY2hcIiwgZXJyb3I6IGJyYW5jaFJlc3VsdC5lcnJvciB9KTtcbiAgfVxuXG4gIGNvbnN0IHB1c2hSZXN1bHQgPSBnaFB1c2hCcmFuY2goYmFzZVBhdGgsIHNsaWNlQnJhbmNoKTtcbiAgaWYgKCFwdXNoUmVzdWx0Lm9rKSB7XG4gICAgZGVidWdMb2coXCJnaXRodWItc3luY1wiLCB7IHBoYXNlOiBcInB1c2gtc2xpY2UtYnJhbmNoXCIsIGVycm9yOiBwdXNoUmVzdWx0LmVycm9yIH0pO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgY29uc3QgdGFza3MgPSAocGxhbi50YXNrcyA/PyBbXSkubWFwKCh0YXNrKSA9PiAoe1xuICAgIGlkOiB0YXNrLmlkLFxuICAgIHRpdGxlOiB0YXNrLnRpdGxlLFxuICAgIGlzc3VlTnVtYmVyOiBnZXRUYXNrUmVjb3JkKG1hcHBpbmcsIG1pZCwgc2lkLCB0YXNrLmlkKT8uaXNzdWVOdW1iZXIsXG4gIH0pKTtcblxuICBjb25zdCBwclJlc3VsdCA9IGdoQ3JlYXRlUFIoYmFzZVBhdGgsIHtcbiAgICByZXBvOiBtYXBwaW5nLnJlcG8sXG4gICAgYmFzZTogbWlsZXN0b25lQnJhbmNoLFxuICAgIGhlYWQ6IHNsaWNlQnJhbmNoLFxuICAgIHRpdGxlOiBgJHtzaWR9OiAke3BsYW4udGl0bGUgfHwgc2lkfWAsXG4gICAgYm9keTogZm9ybWF0U2xpY2VQUkJvZHkoe1xuICAgICAgaWQ6IHNpZCxcbiAgICAgIHRpdGxlOiBwbGFuLnRpdGxlIHx8IHNpZCxcbiAgICAgIGdvYWw6IHBsYW4uZ29hbCxcbiAgICAgIG11c3RIYXZlczogcGxhbi5tdXN0SGF2ZXMsXG4gICAgICBkZW1vQ3JpdGVyaW9uOiBwbGFuLmRlbW8sXG4gICAgICB0YXNrcyxcbiAgICB9KSxcbiAgICBkcmFmdDogdHJ1ZSxcbiAgfSk7XG5cbiAgaWYgKCFwclJlc3VsdC5vaykge1xuICAgIGRlYnVnTG9nKFwiZ2l0aHViLXN5bmNcIiwgeyBwaGFzZTogXCJjcmVhdGUtc2xpY2UtcHJcIiwgZXJyb3I6IHByUmVzdWx0LmVycm9yIH0pO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgc2xpY2VSZWNvcmQucHJOdW1iZXIgPSBwclJlc3VsdC5kYXRhITtcbiAgc2xpY2VSZWNvcmQubGFzdFN5bmNlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICBzZXRTbGljZVJlY29yZChtYXBwaW5nLCBtaWQsIHNpZCwgc2xpY2VSZWNvcmQpO1xuICByZXR1cm4gc2xpY2VSZWNvcmQucHJOdW1iZXI7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN5bmNUYXNrQ29tcGxldGUoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1hcHBpbmc6IFN5bmNNYXBwaW5nLFxuICBjb25maWc6IEdpdEh1YlN5bmNDb25maWcsXG4gIG1pZDogc3RyaW5nLFxuICBzaWQ6IHN0cmluZyxcbiAgdGlkOiBzdHJpbmcsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGFza1JlY29yZCA9IGdldFRhc2tSZWNvcmQobWFwcGluZywgbWlkLCBzaWQsIHRpZCk7XG4gIGlmICghdGFza1JlY29yZCB8fCB0YXNrUmVjb3JkLnN0YXRlID09PSBcImNsb3NlZFwiKSByZXR1cm47XG5cbiAgLy8gTG9hZCB0YXNrIHN1bW1hcnlcbiAgbGV0IGNvbW1lbnRPayA9IHRydWU7XG4gIGNvbnN0IHN1bW1hcnlQYXRoID0gcmVzb2x2ZVRhc2tGaWxlKGJhc2VQYXRoLCBtaWQsIHNpZCwgdGlkLCBcIlNVTU1BUllcIik7XG4gIGlmIChzdW1tYXJ5UGF0aCkge1xuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZShzdW1tYXJ5UGF0aCk7XG4gICAgaWYgKGNvbnRlbnQpIHtcbiAgICAgIGNvbnN0IHN1bW1hcnkgPSBwYXJzZVN1bW1hcnkoY29udGVudCk7XG4gICAgICBjb25zdCBjb21tZW50ID0gZm9ybWF0U3VtbWFyeUNvbW1lbnQoe1xuICAgICAgICBvbmVMaW5lcjogc3VtbWFyeS5vbmVMaW5lcixcbiAgICAgICAgYm9keTogc3VtbWFyeS53aGF0SGFwcGVuZWQsXG4gICAgICAgIGZyb250bWF0dGVyOiBzdW1tYXJ5LmZyb250bWF0dGVyIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IGNvbW1lbnRSZXN1bHQgPSBnaEFkZENvbW1lbnQoYmFzZVBhdGgsIG1hcHBpbmcucmVwbywgdGFza1JlY29yZC5pc3N1ZU51bWJlciwgY29tbWVudCk7XG4gICAgICBjb21tZW50T2sgPSBjb21tZW50UmVzdWx0Lm9rO1xuICAgICAgaWYgKCFjb21tZW50UmVzdWx0Lm9rKSB7XG4gICAgICAgIGRlYnVnTG9nKFwiZ2l0aHViLXN5bmNcIiwgeyBwaGFzZTogXCJ0YXNrLWNvbW1lbnQtZmFpbGVkXCIsIG1pZCwgc2lkLCB0aWQsIGVycm9yOiBjb21tZW50UmVzdWx0LmVycm9yIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGlmICghY29tbWVudE9rKSByZXR1cm47XG5cbiAgLy8gRG8gbm90IGNsb3NlIHRoZSBHaXRIdWIgaXNzdWUgaGVyZS4gVGhlIHRhc2sgY29tbWl0IG1heSBzdGlsbCBiZSBsb2NhbC1vbmx5O1xuICAvLyBjbG9zaW5nIGJlZm9yZSB0aGUgY29tbWl0L1BSIHJlYWNoZXMgR2l0SHViIGJyZWFrcyB0aGUgcmVtb3RlIGF1ZGl0IHRyYWlsLlxuICAvLyBDb21taXQgdHJhaWxlcnMgLyBQUiBtZXJnZSBzaG91bGQgY2xvc2UgbGlua2VkIGlzc3VlcyBvbmNlIGNvZGUgaXMgZGVsaXZlcmVkLlxuICB0YXNrUmVjb3JkLnN0YXRlID0gXCJvcGVuXCI7XG4gIHRhc2tSZWNvcmQubGFzdFN5bmNlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICBzZXRUYXNrUmVjb3JkKG1hcHBpbmcsIG1pZCwgc2lkLCB0aWQsIHRhc2tSZWNvcmQpO1xuXG4gIGRlYnVnTG9nKFwiZ2l0aHViLXN5bmNcIiwgeyBwaGFzZTogXCJ0YXNrLWNvbXBsZXRlLWNvbW1lbnRlZFwiLCBtaWQsIHNpZCwgdGlkLCBpc3N1ZTogdGFza1JlY29yZC5pc3N1ZU51bWJlciB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc3luY1NsaWNlQ29tcGxldGUoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1hcHBpbmc6IFN5bmNNYXBwaW5nLFxuICBjb25maWc6IEdpdEh1YlN5bmNDb25maWcsXG4gIG1pZDogc3RyaW5nLFxuICBzaWQ6IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBsZXQgc2xpY2VSZWNvcmQgPSBnZXRTbGljZVJlY29yZChtYXBwaW5nLCBtaWQsIHNpZCk7XG4gIGlmICghc2xpY2VSZWNvcmQpIHtcbiAgICBhd2FpdCBzeW5jU2xpY2VQbGFuKGJhc2VQYXRoLCBtYXBwaW5nLCBjb25maWcsIG1pZCwgc2lkKTtcbiAgICBzbGljZVJlY29yZCA9IGdldFNsaWNlUmVjb3JkKG1hcHBpbmcsIG1pZCwgc2lkKTtcbiAgfVxuICBpZiAoIXNsaWNlUmVjb3JkIHx8IHNsaWNlUmVjb3JkLnN0YXRlID09PSBcImNsb3NlZFwiKSByZXR1cm47XG4gIGlmICghc2xpY2VSZWNvcmQucHJOdW1iZXIgJiYgc2hvdWxkQ3JlYXRlU2xpY2VQckZvclN5bmNFdmVudChcImNvbXBsZXRlLXNsaWNlXCIsIGNvbmZpZykpIHtcbiAgICBhd2FpdCBlbnN1cmVTbGljZVB1bGxSZXF1ZXN0KGJhc2VQYXRoLCBtYXBwaW5nLCBtaWQsIHNpZCk7XG4gICAgc2xpY2VSZWNvcmQgPSBnZXRTbGljZVJlY29yZChtYXBwaW5nLCBtaWQsIHNpZCk7XG4gICAgaWYgKCFzbGljZVJlY29yZCB8fCAhc2xpY2VSZWNvcmQucHJOdW1iZXIpIHJldHVybjtcbiAgfVxuXG4gIC8vIFBvc3Qgc2xpY2Ugc3VtbWFyeSBhcyBQUiBjb21tZW50XG4gIGNvbnN0IHN1bW1hcnlQYXRoID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlUGF0aCwgbWlkLCBzaWQsIFwiU1VNTUFSWVwiKTtcbiAgaWYgKHN1bW1hcnlQYXRoICYmIHNsaWNlUmVjb3JkLnByTnVtYmVyKSB7XG4gICAgY29uc3QgY29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHN1bW1hcnlQYXRoKTtcbiAgICBpZiAoY29udGVudCkge1xuICAgICAgY29uc3Qgc3VtbWFyeSA9IHBhcnNlU3VtbWFyeShjb250ZW50KTtcbiAgICAgIGNvbnN0IGNvbW1lbnQgPSBmb3JtYXRTdW1tYXJ5Q29tbWVudCh7XG4gICAgICAgIG9uZUxpbmVyOiBzdW1tYXJ5Lm9uZUxpbmVyLFxuICAgICAgICBib2R5OiBzdW1tYXJ5LndoYXRIYXBwZW5lZCxcbiAgICAgICAgZnJvbnRtYXR0ZXI6IHN1bW1hcnkuZnJvbnRtYXR0ZXIgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICAgIH0pO1xuICAgICAgZ2hBZGRDb21tZW50KGJhc2VQYXRoLCBtYXBwaW5nLnJlcG8sIHNsaWNlUmVjb3JkLnByTnVtYmVyLCBjb21tZW50KTtcbiAgICB9XG4gIH1cblxuICAvLyBNYXJrIFBSIHJlYWR5IGZvciByZXZpZXcsIHRoZW4gbWVyZ2VcbiAgaWYgKHNsaWNlUmVjb3JkLnByTnVtYmVyKSB7XG4gICAgZ2hNYXJrUFJSZWFkeShiYXNlUGF0aCwgbWFwcGluZy5yZXBvLCBzbGljZVJlY29yZC5wck51bWJlcik7XG4gICAgLy8gU3F1YXNoLW1lcmdlIGludG8gbWlsZXN0b25lIGJyYW5jaFxuICAgIGdoTWVyZ2VQUihiYXNlUGF0aCwgbWFwcGluZy5yZXBvLCBzbGljZVJlY29yZC5wck51bWJlciwgXCJzcXVhc2hcIik7XG4gIH1cblxuICBzbGljZVJlY29yZC5zdGF0ZSA9IFwiY2xvc2VkXCI7XG4gIHNsaWNlUmVjb3JkLmxhc3RTeW5jZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgc2V0U2xpY2VSZWNvcmQobWFwcGluZywgbWlkLCBzaWQsIHNsaWNlUmVjb3JkKTtcblxuICBkZWJ1Z0xvZyhcImdpdGh1Yi1zeW5jXCIsIHsgcGhhc2U6IFwic2xpY2UtY29tcGxldGVkXCIsIG1pZCwgc2lkLCBwcjogc2xpY2VSZWNvcmQucHJOdW1iZXIgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN5bmNNaWxlc3RvbmVDb21wbGV0ZShcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWFwcGluZzogU3luY01hcHBpbmcsXG4gIGNvbmZpZzogR2l0SHViU3luY0NvbmZpZyxcbiAgbWlkOiBzdHJpbmcsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcmVjb3JkID0gZ2V0TWlsZXN0b25lUmVjb3JkKG1hcHBpbmcsIG1pZCk7XG4gIGlmICghcmVjb3JkIHx8IHJlY29yZC5zdGF0ZSA9PT0gXCJjbG9zZWRcIikgcmV0dXJuO1xuXG4gIC8vIENsb3NlIHRyYWNraW5nIGlzc3VlXG4gIGdoQ2xvc2VJc3N1ZShcbiAgICBiYXNlUGF0aCxcbiAgICBtYXBwaW5nLnJlcG8sXG4gICAgcmVjb3JkLmlzc3VlTnVtYmVyLFxuICAgIGBNaWxlc3RvbmUgJHttaWR9IGNvbXBsZXRlZC5gLFxuICApO1xuXG4gIC8vIENsb3NlIEdpdEh1YiBtaWxlc3RvbmVcbiAgZ2hDbG9zZU1pbGVzdG9uZShiYXNlUGF0aCwgbWFwcGluZy5yZXBvLCByZWNvcmQuZ2hNaWxlc3RvbmVOdW1iZXIpO1xuXG4gIHJlY29yZC5zdGF0ZSA9IFwiY2xvc2VkXCI7XG4gIHJlY29yZC5sYXN0U3luY2VkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG4gIHNldE1pbGVzdG9uZVJlY29yZChtYXBwaW5nLCBtaWQsIHJlY29yZCk7XG5cbiAgZGVidWdMb2coXCJnaXRodWItc3luY1wiLCB7IHBoYXNlOiBcIm1pbGVzdG9uZS1jb21wbGV0ZWRcIiwgbWlkIH0pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQm9vdHN0cmFwIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFdhbGsgdGhlIGAuZ3NkL21pbGVzdG9uZXMvYCB0cmVlIGFuZCBjcmVhdGUgR2l0SHViIGVudGl0aWVzIGZvciBhbnlcbiAqIHRoYXQgYXJlIG1pc3NpbmcgZnJvbSB0aGUgc3luYyBtYXBwaW5nLiBTYWZlIHRvIHJ1biBtdWx0aXBsZSB0aW1lcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJvb3RzdHJhcFN5bmMoYmFzZVBhdGg6IHN0cmluZyk6IFByb21pc2U8e1xuICBtaWxlc3RvbmVzOiBudW1iZXI7XG4gIHNsaWNlczogbnVtYmVyO1xuICB0YXNrczogbnVtYmVyO1xufT4ge1xuICBjb25zdCBjb25maWcgPSBsb2FkR2l0SHViU3luY0NvbmZpZyhiYXNlUGF0aCk7XG4gIGlmICghY29uZmlnPy5lbmFibGVkKSByZXR1cm4geyBtaWxlc3RvbmVzOiAwLCBzbGljZXM6IDAsIHRhc2tzOiAwIH07XG4gIGlmICghZ2hJc0F2YWlsYWJsZSgpKSByZXR1cm4geyBtaWxlc3RvbmVzOiAwLCBzbGljZXM6IDAsIHRhc2tzOiAwIH07XG5cbiAgY29uc3QgcmVwbyA9IGNvbmZpZy5yZXBvID8/IHJlc29sdmVSZXBvKGJhc2VQYXRoKTtcbiAgaWYgKCFyZXBvKSByZXR1cm4geyBtaWxlc3RvbmVzOiAwLCBzbGljZXM6IDAsIHRhc2tzOiAwIH07XG5cbiAgbGV0IG1hcHBpbmcgPSBsb2FkU3luY01hcHBpbmcoYmFzZVBhdGgpID8/IGNyZWF0ZUVtcHR5TWFwcGluZyhyZXBvKTtcbiAgbWFwcGluZy5yZXBvID0gcmVwbztcblxuICBjb25zdCB0YXNrQ291bnRCZWZvcmUgPSBPYmplY3Qua2V5cyhtYXBwaW5nLnRhc2tzKS5sZW5ndGg7XG4gIGNvbnN0IGNvdW50cyA9IHsgbWlsZXN0b25lczogMCwgc2xpY2VzOiAwLCB0YXNrczogMCB9O1xuICBjb25zdCBtaWxlc3RvbmVzRGlyID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiKTtcbiAgaWYgKCFleGlzdHNTeW5jKG1pbGVzdG9uZXNEaXIpKSByZXR1cm4gY291bnRzO1xuXG4gIGNvbnN0IG1pbGVzdG9uZUlkcyA9IHJlYWRkaXJTeW5jKG1pbGVzdG9uZXNEaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KVxuICAgIC5maWx0ZXIoZCA9PiBkLmlzRGlyZWN0b3J5KCkpXG4gICAgLm1hcChkID0+IGQubmFtZSlcbiAgICAuc29ydCgpO1xuXG4gIGZvciAoY29uc3QgbWlkIG9mIG1pbGVzdG9uZUlkcykge1xuICAgIGlmICghZ2V0TWlsZXN0b25lUmVjb3JkKG1hcHBpbmcsIG1pZCkpIHtcbiAgICAgIGF3YWl0IHN5bmNNaWxlc3RvbmVQbGFuKGJhc2VQYXRoLCBtYXBwaW5nLCBjb25maWcsIG1pZCk7XG4gICAgICBjb3VudHMubWlsZXN0b25lcysrO1xuICAgIH1cblxuICAgIC8vIEZpbmQgc2xpY2VzXG4gICAgY29uc3Qgc2xpY2VzRGlyID0gam9pbihtaWxlc3RvbmVzRGlyLCBtaWQsIFwic2xpY2VzXCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhzbGljZXNEaXIpKSBjb250aW51ZTtcblxuICAgIGNvbnN0IHNsaWNlSWRzID0gcmVhZGRpclN5bmMoc2xpY2VzRGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSlcbiAgICAgIC5maWx0ZXIoZCA9PiBkLmlzRGlyZWN0b3J5KCkpXG4gICAgICAubWFwKGQgPT4gZC5uYW1lKVxuICAgICAgLnNvcnQoKTtcblxuICAgIGZvciAoY29uc3Qgc2lkIG9mIHNsaWNlSWRzKSB7XG4gICAgICBpZiAoIWdldFNsaWNlUmVjb3JkKG1hcHBpbmcsIG1pZCwgc2lkKSkge1xuICAgICAgICBhd2FpdCBzeW5jU2xpY2VQbGFuKGJhc2VQYXRoLCBtYXBwaW5nLCBjb25maWcsIG1pZCwgc2lkKTtcbiAgICAgICAgY291bnRzLnNsaWNlcysrO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGNvdW50cy50YXNrcyA9IE9iamVjdC5rZXlzKG1hcHBpbmcudGFza3MpLmxlbmd0aCAtIHRhc2tDb3VudEJlZm9yZTtcbiAgc2F2ZVN5bmNNYXBwaW5nKGJhc2VQYXRoLCBtYXBwaW5nKTtcbiAgcmV0dXJuIGNvdW50cztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENvbmZpZyBMb2FkaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBfY2FjaGVkQ29uZmlnQnlCYXNlUGF0aCA9IG5ldyBNYXA8c3RyaW5nLCBHaXRIdWJTeW5jQ29uZmlnIHwgbnVsbD4oKTtcblxuZnVuY3Rpb24gbG9hZEdpdEh1YlN5bmNDb25maWcoYmFzZVBhdGg6IHN0cmluZyk6IEdpdEh1YlN5bmNDb25maWcgfCBudWxsIHtcbiAgaWYgKF9jYWNoZWRDb25maWdCeUJhc2VQYXRoLmhhcyhiYXNlUGF0aCkpIHJldHVybiBfY2FjaGVkQ29uZmlnQnlCYXNlUGF0aC5nZXQoYmFzZVBhdGgpITtcbiAgdHJ5IHtcbiAgICBjb25zdCBwcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyhiYXNlUGF0aCk7XG4gICAgY29uc3QgZ2l0aHViID0gKHByZWZzPy5wcmVmZXJlbmNlcyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik/LmdpdGh1YjtcbiAgICBpZiAoIWdpdGh1YiB8fCB0eXBlb2YgZ2l0aHViICE9PSBcIm9iamVjdFwiKSB7XG4gICAgICBfY2FjaGVkQ29uZmlnQnlCYXNlUGF0aC5zZXQoYmFzZVBhdGgsIG51bGwpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGNvbnN0IGNvbmZpZyA9IGdpdGh1YiBhcyBHaXRIdWJTeW5jQ29uZmlnO1xuICAgIF9jYWNoZWRDb25maWdCeUJhc2VQYXRoLnNldChiYXNlUGF0aCwgY29uZmlnKTtcbiAgICByZXR1cm4gY29uZmlnO1xuICB9IGNhdGNoIHtcbiAgICBfY2FjaGVkQ29uZmlnQnlCYXNlUGF0aC5zZXQoYmFzZVBhdGgsIG51bGwpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKiBSZXNldCBjb25maWcgY2FjaGUgKGZvciB0ZXN0aW5nKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBfcmVzZXRDb25maWdDYWNoZSgpOiB2b2lkIHtcbiAgX2NhY2hlZENvbmZpZ0J5QmFzZVBhdGguY2xlYXIoKTtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVJlcG8oYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCByZXN1bHQgPSBnaERldGVjdFJlcG8oYmFzZVBhdGgpO1xuICByZXR1cm4gcmVzdWx0Lm9rID8gcmVzdWx0LmRhdGEhIDogbnVsbDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENvbW1pdCBMaW5raW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIExvb2sgdXAgdGhlIEdpdEh1YiBpc3N1ZSBudW1iZXIgZm9yIGEgdGFzayBzbyB0aGUgY29tbWl0IG1lc3NhZ2VcbiAqIGNhbiBpbmNsdWRlIGBSZXNvbHZlcyAjTmAuIENhbGxlZCBmcm9tIGdpdC1zZXJ2aWNlIGNvbW1pdCBidWlsZGluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFRhc2tJc3N1ZU51bWJlckZvckNvbW1pdChcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlkOiBzdHJpbmcsXG4gIHNpZDogc3RyaW5nLFxuICB0aWQ6IHN0cmluZyxcbik6IG51bWJlciB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IGNvbmZpZyA9IGxvYWRHaXRIdWJTeW5jQ29uZmlnKGJhc2VQYXRoKTtcbiAgICBpZiAoIWNvbmZpZz8uZW5hYmxlZCkgcmV0dXJuIG51bGw7XG4gICAgaWYgKGNvbmZpZy5hdXRvX2xpbmtfY29tbWl0cyA9PT0gZmFsc2UpIHJldHVybiBudWxsO1xuXG4gICAgY29uc3QgbWFwcGluZyA9IGxvYWRTeW5jTWFwcGluZyhiYXNlUGF0aCk7XG4gICAgaWYgKCFtYXBwaW5nKSByZXR1cm4gbnVsbDtcblxuICAgIGNvbnN0IHJlY29yZCA9IGdldFRhc2tSZWNvcmQobWFwcGluZywgbWlkLCBzaWQsIHRpZCk7XG4gICAgcmV0dXJuIHJlY29yZD8uaXNzdWVOdW1iZXIgPz8gbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVVBLFNBQVMsWUFBWSxtQkFBbUI7QUFDeEMsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsVUFBVSxvQkFBb0I7QUFDdkMsU0FBUyxjQUFjLGlCQUFpQjtBQUN4QztBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLGdCQUFnQjtBQUN6QixTQUFTLG1DQUFtQztBQUc1QztBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFRUCxlQUFzQixjQUNwQixVQUNBLFVBQ0EsUUFDZTtBQUNmLE1BQUk7QUFDRixVQUFNLFNBQVMscUJBQXFCLFFBQVE7QUFDNUMsUUFBSSxDQUFDLFFBQVEsUUFBUztBQUN0QixRQUFJLENBQUMsY0FBYyxHQUFHO0FBQ3BCLGVBQVMsZUFBZSxFQUFFLE1BQU0sdUJBQXVCLENBQUM7QUFDeEQ7QUFBQSxJQUNGO0FBR0EsVUFBTSxPQUFPLE9BQU8sUUFBUSxZQUFZLFFBQVE7QUFDaEQsUUFBSSxDQUFDLE1BQU07QUFDVCxlQUFTLGVBQWUsRUFBRSxNQUFNLHdCQUF3QixDQUFDO0FBQ3pEO0FBQUEsSUFDRjtBQUdBLFFBQUksQ0FBQyxlQUFlLFFBQVEsR0FBRztBQUM3QixlQUFTLGVBQWUsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBQ2xEO0FBQUEsSUFDRjtBQUdBLFFBQUksVUFBVSxnQkFBZ0IsUUFBUSxLQUFLLG1CQUFtQixJQUFJO0FBQ2xFLFlBQVEsT0FBTztBQUdmLFVBQU0sUUFBUSxPQUFPLE1BQU0sR0FBRztBQUM5QixVQUFNLENBQUMsS0FBSyxLQUFLLEdBQUcsSUFBSTtBQUd4QixZQUFRLFVBQVU7QUFBQSxNQUNoQixLQUFLO0FBQ0gsWUFBSSxJQUFLLE9BQU0sa0JBQWtCLFVBQVUsU0FBUyxRQUFRLEdBQUc7QUFDL0Q7QUFBQSxNQUNGLEtBQUs7QUFBQSxNQUNMLEtBQUs7QUFDSCxZQUFJLE9BQU8sSUFBSyxPQUFNLGNBQWMsVUFBVSxTQUFTLFFBQVEsS0FBSyxHQUFHO0FBQ3ZFO0FBQUEsTUFDRixLQUFLO0FBQUEsTUFDTCxLQUFLO0FBQ0gsWUFBSSxPQUFPLE9BQU8sSUFBSyxPQUFNLGlCQUFpQixVQUFVLFNBQVMsUUFBUSxLQUFLLEtBQUssR0FBRztBQUN0RjtBQUFBLE1BQ0YsS0FBSztBQUNILFlBQUksT0FBTyxJQUFLLE9BQU0sa0JBQWtCLFVBQVUsU0FBUyxRQUFRLEtBQUssR0FBRztBQUMzRTtBQUFBLE1BQ0YsS0FBSztBQUNILFlBQUksSUFBSyxPQUFNLHNCQUFzQixVQUFVLFNBQVMsUUFBUSxHQUFHO0FBQ25FO0FBQUEsSUFDSjtBQUVBLG9CQUFnQixVQUFVLE9BQU87QUFBQSxFQUNuQyxTQUFTLEtBQUs7QUFDWixhQUFTLGVBQWUsRUFBRSxPQUFPLE9BQU8sR0FBRyxFQUFFLENBQUM7QUFBQSxFQUNoRDtBQUNGO0FBRU8sU0FBUyxnQ0FDZCxVQUNBLFFBQ1M7QUFDVCxTQUFPLGFBQWEsb0JBQW9CLE9BQU8sY0FBYztBQUMvRDtBQUlBLGVBQWUsa0JBQ2IsVUFDQSxTQUNBLFFBQ0EsS0FDZTtBQUVmLE1BQUksbUJBQW1CLFNBQVMsR0FBRyxFQUFHO0FBR3RDLFFBQU0sY0FBYyxxQkFBcUIsVUFBVSxLQUFLLFNBQVM7QUFDakUsTUFBSSxDQUFDLFlBQWE7QUFDbEIsUUFBTSxVQUFVLE1BQU0sU0FBUyxXQUFXO0FBQzFDLE1BQUksQ0FBQyxRQUFTO0FBRWQsUUFBTSxVQUFVLGFBQWEsT0FBTztBQUNwQyxRQUFNLFFBQVEsR0FBRyxHQUFHLEtBQUssUUFBUSxTQUFTLFdBQVc7QUFHckQsUUFBTSxrQkFBa0I7QUFBQSxJQUN0QjtBQUFBLElBQ0EsUUFBUTtBQUFBLElBQ1I7QUFBQSxJQUNBLFFBQVEsVUFBVTtBQUFBLEVBQ3BCO0FBQ0EsTUFBSSxDQUFDLGdCQUFnQixJQUFJO0FBQ3ZCLGFBQVMsZUFBZSxFQUFFLE9BQU8sb0JBQW9CLE9BQU8sZ0JBQWdCLE1BQU0sQ0FBQztBQUNuRjtBQUFBLEVBQ0Y7QUFDQSxRQUFNLG9CQUFvQixnQkFBZ0I7QUFHMUMsUUFBTSxZQUFZLHlCQUF5QjtBQUFBLElBQ3pDLElBQUk7QUFBQSxJQUNKLE9BQU8sUUFBUSxTQUFTO0FBQUEsSUFDeEIsUUFBUSxRQUFRO0FBQUEsSUFDaEIsaUJBQWlCLFFBQVE7QUFBQSxJQUN6QixRQUFRLFFBQVEsUUFBUSxJQUFJLFFBQU07QUFBQSxNQUNoQyxJQUFJLEVBQUU7QUFBQSxNQUNOLE9BQU8sRUFBRTtBQUFBLElBQ1gsRUFBRTtBQUFBLEVBQ0osQ0FBQztBQUVELFFBQU0sY0FBYyxjQUFjLFVBQVU7QUFBQSxJQUMxQyxNQUFNLFFBQVE7QUFBQSxJQUNkLE9BQU8sR0FBRyxHQUFHLEtBQUssUUFBUSxTQUFTLFdBQVc7QUFBQSxJQUM5QyxNQUFNO0FBQUEsSUFDTixRQUFRLE9BQU87QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNiLENBQUM7QUFDRCxNQUFJLENBQUMsWUFBWSxJQUFJO0FBQ25CLGFBQVMsZUFBZSxFQUFFLE9BQU8seUJBQXlCLE9BQU8sWUFBWSxNQUFNLENBQUM7QUFDcEY7QUFBQSxFQUNGO0FBR0EsTUFBSSxPQUFPLFNBQVM7QUFDbEIsbUJBQWUsVUFBVSxRQUFRLE1BQU0sT0FBTyxTQUFTLFlBQVksSUFBSztBQUFBLEVBQzFFO0FBRUEscUJBQW1CLFNBQVMsS0FBSztBQUFBLElBQy9CLGFBQWEsWUFBWTtBQUFBLElBQ3pCO0FBQUEsSUFDQSxlQUFjLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQUEsSUFDckMsT0FBTztBQUFBLEVBQ1QsQ0FBQztBQUVELFdBQVMsZUFBZTtBQUFBLElBQ3RCLE9BQU87QUFBQSxJQUNQO0FBQUEsSUFDQSxXQUFXO0FBQUEsSUFDWCxPQUFPLFlBQVk7QUFBQSxFQUNyQixDQUFDO0FBQ0g7QUFFQSxlQUFlLGNBQ2IsVUFDQSxTQUNBLFFBQ0EsS0FDQSxLQUNlO0FBQ2YsUUFBTSxnQkFBZ0IsZUFBZSxTQUFTLEtBQUssR0FBRztBQUN0RCxNQUFJLGNBQWU7QUFHbkIsTUFBSSxDQUFDLG1CQUFtQixTQUFTLEdBQUcsR0FBRztBQUNyQyxVQUFNLGtCQUFrQixVQUFVLFNBQVMsUUFBUSxHQUFHO0FBQUEsRUFDeEQ7QUFDQSxRQUFNLGtCQUFrQixtQkFBbUIsU0FBUyxHQUFHO0FBR3ZELFFBQU0sV0FBVyxpQkFBaUIsVUFBVSxLQUFLLEtBQUssTUFBTTtBQUM1RCxNQUFJLENBQUMsU0FBVTtBQUNmLFFBQU0sVUFBVSxNQUFNLFNBQVMsUUFBUTtBQUN2QyxNQUFJLENBQUMsUUFBUztBQUVkLFFBQU0sT0FBTyxVQUFVLE9BQU87QUFDOUIsUUFBTSxjQUFjLGFBQWEsR0FBRyxJQUFJLEdBQUc7QUFHM0MsUUFBTSxtQkFBK0UsQ0FBQztBQUV0RixNQUFJLEtBQUssT0FBTztBQUNkLGVBQVcsUUFBUSxLQUFLLE9BQU87QUFFN0IsVUFBSSxjQUFjLFNBQVMsS0FBSyxLQUFLLEtBQUssRUFBRSxHQUFHO0FBQzdDLGNBQU0sV0FBVyxjQUFjLFNBQVMsS0FBSyxLQUFLLEtBQUssRUFBRTtBQUN6RCx5QkFBaUIsS0FBSyxFQUFFLElBQUksS0FBSyxJQUFJLE9BQU8sS0FBSyxPQUFPLGFBQWEsU0FBUyxZQUFZLENBQUM7QUFDM0Y7QUFBQSxNQUNGO0FBRUEsWUFBTSxXQUFXLG9CQUFvQjtBQUFBLFFBQ25DLElBQUksS0FBSztBQUFBLFFBQ1QsT0FBTyxLQUFLO0FBQUEsUUFDWixhQUFhLEtBQUs7QUFBQSxRQUNsQixPQUFPLEtBQUs7QUFBQSxRQUNaLGdCQUFnQixLQUFLLFNBQVMsQ0FBQyxLQUFLLE1BQU0sSUFBSTtBQUFBLE1BQ2hELENBQUM7QUFFRCxZQUFNLGFBQWEsY0FBYyxVQUFVO0FBQUEsUUFDekMsTUFBTSxRQUFRO0FBQUEsUUFDZCxPQUFPLEdBQUcsR0FBRyxJQUFJLEdBQUcsSUFBSSxLQUFLLEVBQUUsS0FBSyxLQUFLLEtBQUs7QUFBQSxRQUM5QyxNQUFNO0FBQUEsUUFDTixRQUFRLE9BQU87QUFBQSxRQUNmLFdBQVcsaUJBQWlCO0FBQUEsUUFDNUIsYUFBYSxpQkFBaUI7QUFBQSxNQUNoQyxDQUFDO0FBRUQsVUFBSSxXQUFXLElBQUk7QUFDakIsc0JBQWMsU0FBUyxLQUFLLEtBQUssS0FBSyxJQUFJO0FBQUEsVUFDeEMsYUFBYSxXQUFXO0FBQUEsVUFDeEIsZUFBYyxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLFVBQ3JDLE9BQU87QUFBQSxRQUNULENBQUM7QUFDRCx5QkFBaUIsS0FBSyxFQUFFLElBQUksS0FBSyxJQUFJLE9BQU8sS0FBSyxPQUFPLGFBQWEsV0FBVyxLQUFNLENBQUM7QUFFdkYsWUFBSSxPQUFPLFNBQVM7QUFDbEIseUJBQWUsVUFBVSxRQUFRLE1BQU0sT0FBTyxTQUFTLFdBQVcsSUFBSztBQUFBLFFBQ3pFO0FBQUEsTUFDRixPQUFPO0FBQ0wseUJBQWlCLEtBQUssRUFBRSxJQUFJLEtBQUssSUFBSSxPQUFPLEtBQUssTUFBTSxDQUFDO0FBQUEsTUFDMUQ7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLGlCQUFlLFNBQVMsS0FBSyxLQUFLO0FBQUEsSUFDaEMsYUFBYTtBQUFBLElBQ2IsVUFBVTtBQUFBLElBQ1YsUUFBUTtBQUFBLElBQ1IsZUFBYyxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLElBQ3JDLE9BQU87QUFBQSxFQUNULENBQUM7QUFFRCxXQUFTLGVBQWU7QUFBQSxJQUN0QixPQUFPO0FBQUEsSUFDUDtBQUFBLElBQ0E7QUFBQSxJQUNBLElBQUk7QUFBQSxJQUNKLFlBQVksaUJBQWlCLE9BQU8sT0FBSyxFQUFFLFdBQVcsRUFBRTtBQUFBLEVBQzFELENBQUM7QUFDSDtBQUVBLGVBQWUsdUJBQ2IsVUFDQSxTQUNBLEtBQ0EsS0FDd0I7QUFDeEIsUUFBTSxjQUFjLGVBQWUsU0FBUyxLQUFLLEdBQUc7QUFDcEQsTUFBSSxDQUFDLFlBQWEsUUFBTztBQUN6QixNQUFJLFlBQVksU0FBVSxRQUFPLFlBQVk7QUFFN0MsUUFBTSxXQUFXLGlCQUFpQixVQUFVLEtBQUssS0FBSyxNQUFNO0FBQzVELE1BQUksQ0FBQyxTQUFVLFFBQU87QUFDdEIsUUFBTSxVQUFVLE1BQU0sU0FBUyxRQUFRO0FBQ3ZDLE1BQUksQ0FBQyxRQUFTLFFBQU87QUFDckIsUUFBTSxPQUFPLFVBQVUsT0FBTztBQUU5QixRQUFNLGNBQWMsWUFBWSxVQUFVLGFBQWEsR0FBRyxJQUFJLEdBQUc7QUFDakUsUUFBTSxrQkFBa0IsYUFBYSxHQUFHO0FBRXhDLFFBQU0sZUFBZSxlQUFlLFVBQVUsYUFBYSxlQUFlO0FBQzFFLE1BQUksQ0FBQyxhQUFhLElBQUk7QUFDcEIsYUFBUyxlQUFlLEVBQUUsT0FBTyx1QkFBdUIsT0FBTyxhQUFhLE1BQU0sQ0FBQztBQUFBLEVBQ3JGO0FBRUEsUUFBTSxhQUFhLGFBQWEsVUFBVSxXQUFXO0FBQ3JELE1BQUksQ0FBQyxXQUFXLElBQUk7QUFDbEIsYUFBUyxlQUFlLEVBQUUsT0FBTyxxQkFBcUIsT0FBTyxXQUFXLE1BQU0sQ0FBQztBQUMvRSxXQUFPO0FBQUEsRUFDVDtBQUVBLFFBQU0sU0FBUyxLQUFLLFNBQVMsQ0FBQyxHQUFHLElBQUksQ0FBQyxVQUFVO0FBQUEsSUFDOUMsSUFBSSxLQUFLO0FBQUEsSUFDVCxPQUFPLEtBQUs7QUFBQSxJQUNaLGFBQWEsY0FBYyxTQUFTLEtBQUssS0FBSyxLQUFLLEVBQUUsR0FBRztBQUFBLEVBQzFELEVBQUU7QUFFRixRQUFNLFdBQVcsV0FBVyxVQUFVO0FBQUEsSUFDcEMsTUFBTSxRQUFRO0FBQUEsSUFDZCxNQUFNO0FBQUEsSUFDTixNQUFNO0FBQUEsSUFDTixPQUFPLEdBQUcsR0FBRyxLQUFLLEtBQUssU0FBUyxHQUFHO0FBQUEsSUFDbkMsTUFBTSxrQkFBa0I7QUFBQSxNQUN0QixJQUFJO0FBQUEsTUFDSixPQUFPLEtBQUssU0FBUztBQUFBLE1BQ3JCLE1BQU0sS0FBSztBQUFBLE1BQ1gsV0FBVyxLQUFLO0FBQUEsTUFDaEIsZUFBZSxLQUFLO0FBQUEsTUFDcEI7QUFBQSxJQUNGLENBQUM7QUFBQSxJQUNELE9BQU87QUFBQSxFQUNULENBQUM7QUFFRCxNQUFJLENBQUMsU0FBUyxJQUFJO0FBQ2hCLGFBQVMsZUFBZSxFQUFFLE9BQU8sbUJBQW1CLE9BQU8sU0FBUyxNQUFNLENBQUM7QUFDM0UsV0FBTztBQUFBLEVBQ1Q7QUFFQSxjQUFZLFdBQVcsU0FBUztBQUNoQyxjQUFZLGdCQUFlLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQ2xELGlCQUFlLFNBQVMsS0FBSyxLQUFLLFdBQVc7QUFDN0MsU0FBTyxZQUFZO0FBQ3JCO0FBRUEsZUFBZSxpQkFDYixVQUNBLFNBQ0EsUUFDQSxLQUNBLEtBQ0EsS0FDZTtBQUNmLFFBQU0sYUFBYSxjQUFjLFNBQVMsS0FBSyxLQUFLLEdBQUc7QUFDdkQsTUFBSSxDQUFDLGNBQWMsV0FBVyxVQUFVLFNBQVU7QUFHbEQsTUFBSSxZQUFZO0FBQ2hCLFFBQU0sY0FBYyxnQkFBZ0IsVUFBVSxLQUFLLEtBQUssS0FBSyxTQUFTO0FBQ3RFLE1BQUksYUFBYTtBQUNmLFVBQU0sVUFBVSxNQUFNLFNBQVMsV0FBVztBQUMxQyxRQUFJLFNBQVM7QUFDWCxZQUFNLFVBQVUsYUFBYSxPQUFPO0FBQ3BDLFlBQU0sVUFBVSxxQkFBcUI7QUFBQSxRQUNuQyxVQUFVLFFBQVE7QUFBQSxRQUNsQixNQUFNLFFBQVE7QUFBQSxRQUNkLGFBQWEsUUFBUTtBQUFBLE1BQ3ZCLENBQUM7QUFDRCxZQUFNLGdCQUFnQixhQUFhLFVBQVUsUUFBUSxNQUFNLFdBQVcsYUFBYSxPQUFPO0FBQzFGLGtCQUFZLGNBQWM7QUFDMUIsVUFBSSxDQUFDLGNBQWMsSUFBSTtBQUNyQixpQkFBUyxlQUFlLEVBQUUsT0FBTyx1QkFBdUIsS0FBSyxLQUFLLEtBQUssT0FBTyxjQUFjLE1BQU0sQ0FBQztBQUFBLE1BQ3JHO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxNQUFJLENBQUMsVUFBVztBQUtoQixhQUFXLFFBQVE7QUFDbkIsYUFBVyxnQkFBZSxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUNqRCxnQkFBYyxTQUFTLEtBQUssS0FBSyxLQUFLLFVBQVU7QUFFaEQsV0FBUyxlQUFlLEVBQUUsT0FBTywyQkFBMkIsS0FBSyxLQUFLLEtBQUssT0FBTyxXQUFXLFlBQVksQ0FBQztBQUM1RztBQUVBLGVBQWUsa0JBQ2IsVUFDQSxTQUNBLFFBQ0EsS0FDQSxLQUNlO0FBQ2YsTUFBSSxjQUFjLGVBQWUsU0FBUyxLQUFLLEdBQUc7QUFDbEQsTUFBSSxDQUFDLGFBQWE7QUFDaEIsVUFBTSxjQUFjLFVBQVUsU0FBUyxRQUFRLEtBQUssR0FBRztBQUN2RCxrQkFBYyxlQUFlLFNBQVMsS0FBSyxHQUFHO0FBQUEsRUFDaEQ7QUFDQSxNQUFJLENBQUMsZUFBZSxZQUFZLFVBQVUsU0FBVTtBQUNwRCxNQUFJLENBQUMsWUFBWSxZQUFZLGdDQUFnQyxrQkFBa0IsTUFBTSxHQUFHO0FBQ3RGLFVBQU0sdUJBQXVCLFVBQVUsU0FBUyxLQUFLLEdBQUc7QUFDeEQsa0JBQWMsZUFBZSxTQUFTLEtBQUssR0FBRztBQUM5QyxRQUFJLENBQUMsZUFBZSxDQUFDLFlBQVksU0FBVTtBQUFBLEVBQzdDO0FBR0EsUUFBTSxjQUFjLGlCQUFpQixVQUFVLEtBQUssS0FBSyxTQUFTO0FBQ2xFLE1BQUksZUFBZSxZQUFZLFVBQVU7QUFDdkMsVUFBTSxVQUFVLE1BQU0sU0FBUyxXQUFXO0FBQzFDLFFBQUksU0FBUztBQUNYLFlBQU0sVUFBVSxhQUFhLE9BQU87QUFDcEMsWUFBTSxVQUFVLHFCQUFxQjtBQUFBLFFBQ25DLFVBQVUsUUFBUTtBQUFBLFFBQ2xCLE1BQU0sUUFBUTtBQUFBLFFBQ2QsYUFBYSxRQUFRO0FBQUEsTUFDdkIsQ0FBQztBQUNELG1CQUFhLFVBQVUsUUFBUSxNQUFNLFlBQVksVUFBVSxPQUFPO0FBQUEsSUFDcEU7QUFBQSxFQUNGO0FBR0EsTUFBSSxZQUFZLFVBQVU7QUFDeEIsa0JBQWMsVUFBVSxRQUFRLE1BQU0sWUFBWSxRQUFRO0FBRTFELGNBQVUsVUFBVSxRQUFRLE1BQU0sWUFBWSxVQUFVLFFBQVE7QUFBQSxFQUNsRTtBQUVBLGNBQVksUUFBUTtBQUNwQixjQUFZLGdCQUFlLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQ2xELGlCQUFlLFNBQVMsS0FBSyxLQUFLLFdBQVc7QUFFN0MsV0FBUyxlQUFlLEVBQUUsT0FBTyxtQkFBbUIsS0FBSyxLQUFLLElBQUksWUFBWSxTQUFTLENBQUM7QUFDMUY7QUFFQSxlQUFlLHNCQUNiLFVBQ0EsU0FDQSxRQUNBLEtBQ2U7QUFDZixRQUFNLFNBQVMsbUJBQW1CLFNBQVMsR0FBRztBQUM5QyxNQUFJLENBQUMsVUFBVSxPQUFPLFVBQVUsU0FBVTtBQUcxQztBQUFBLElBQ0U7QUFBQSxJQUNBLFFBQVE7QUFBQSxJQUNSLE9BQU87QUFBQSxJQUNQLGFBQWEsR0FBRztBQUFBLEVBQ2xCO0FBR0EsbUJBQWlCLFVBQVUsUUFBUSxNQUFNLE9BQU8saUJBQWlCO0FBRWpFLFNBQU8sUUFBUTtBQUNmLFNBQU8sZ0JBQWUsb0JBQUksS0FBSyxHQUFFLFlBQVk7QUFDN0MscUJBQW1CLFNBQVMsS0FBSyxNQUFNO0FBRXZDLFdBQVMsZUFBZSxFQUFFLE9BQU8sdUJBQXVCLElBQUksQ0FBQztBQUMvRDtBQVFBLGVBQXNCLGNBQWMsVUFJakM7QUFDRCxRQUFNLFNBQVMscUJBQXFCLFFBQVE7QUFDNUMsTUFBSSxDQUFDLFFBQVEsUUFBUyxRQUFPLEVBQUUsWUFBWSxHQUFHLFFBQVEsR0FBRyxPQUFPLEVBQUU7QUFDbEUsTUFBSSxDQUFDLGNBQWMsRUFBRyxRQUFPLEVBQUUsWUFBWSxHQUFHLFFBQVEsR0FBRyxPQUFPLEVBQUU7QUFFbEUsUUFBTSxPQUFPLE9BQU8sUUFBUSxZQUFZLFFBQVE7QUFDaEQsTUFBSSxDQUFDLEtBQU0sUUFBTyxFQUFFLFlBQVksR0FBRyxRQUFRLEdBQUcsT0FBTyxFQUFFO0FBRXZELE1BQUksVUFBVSxnQkFBZ0IsUUFBUSxLQUFLLG1CQUFtQixJQUFJO0FBQ2xFLFVBQVEsT0FBTztBQUVmLFFBQU0sa0JBQWtCLE9BQU8sS0FBSyxRQUFRLEtBQUssRUFBRTtBQUNuRCxRQUFNLFNBQVMsRUFBRSxZQUFZLEdBQUcsUUFBUSxHQUFHLE9BQU8sRUFBRTtBQUNwRCxRQUFNLGdCQUFnQixLQUFLLFVBQVUsUUFBUSxZQUFZO0FBQ3pELE1BQUksQ0FBQyxXQUFXLGFBQWEsRUFBRyxRQUFPO0FBRXZDLFFBQU0sZUFBZSxZQUFZLGVBQWUsRUFBRSxlQUFlLEtBQUssQ0FBQyxFQUNwRSxPQUFPLE9BQUssRUFBRSxZQUFZLENBQUMsRUFDM0IsSUFBSSxPQUFLLEVBQUUsSUFBSSxFQUNmLEtBQUs7QUFFUixhQUFXLE9BQU8sY0FBYztBQUM5QixRQUFJLENBQUMsbUJBQW1CLFNBQVMsR0FBRyxHQUFHO0FBQ3JDLFlBQU0sa0JBQWtCLFVBQVUsU0FBUyxRQUFRLEdBQUc7QUFDdEQsYUFBTztBQUFBLElBQ1Q7QUFHQSxVQUFNLFlBQVksS0FBSyxlQUFlLEtBQUssUUFBUTtBQUNuRCxRQUFJLENBQUMsV0FBVyxTQUFTLEVBQUc7QUFFNUIsVUFBTSxXQUFXLFlBQVksV0FBVyxFQUFFLGVBQWUsS0FBSyxDQUFDLEVBQzVELE9BQU8sT0FBSyxFQUFFLFlBQVksQ0FBQyxFQUMzQixJQUFJLE9BQUssRUFBRSxJQUFJLEVBQ2YsS0FBSztBQUVSLGVBQVcsT0FBTyxVQUFVO0FBQzFCLFVBQUksQ0FBQyxlQUFlLFNBQVMsS0FBSyxHQUFHLEdBQUc7QUFDdEMsY0FBTSxjQUFjLFVBQVUsU0FBUyxRQUFRLEtBQUssR0FBRztBQUN2RCxlQUFPO0FBQUEsTUFDVDtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBRUEsU0FBTyxRQUFRLE9BQU8sS0FBSyxRQUFRLEtBQUssRUFBRSxTQUFTO0FBQ25ELGtCQUFnQixVQUFVLE9BQU87QUFDakMsU0FBTztBQUNUO0FBSUEsTUFBTSwwQkFBMEIsb0JBQUksSUFBcUM7QUFFekUsU0FBUyxxQkFBcUIsVUFBMkM7QUFDdkUsTUFBSSx3QkFBd0IsSUFBSSxRQUFRLEVBQUcsUUFBTyx3QkFBd0IsSUFBSSxRQUFRO0FBQ3RGLE1BQUk7QUFDRixVQUFNLFFBQVEsNEJBQTRCLFFBQVE7QUFDbEQsVUFBTSxTQUFVLE9BQU8sYUFBeUM7QUFDaEUsUUFBSSxDQUFDLFVBQVUsT0FBTyxXQUFXLFVBQVU7QUFDekMsOEJBQXdCLElBQUksVUFBVSxJQUFJO0FBQzFDLGFBQU87QUFBQSxJQUNUO0FBQ0EsVUFBTSxTQUFTO0FBQ2YsNEJBQXdCLElBQUksVUFBVSxNQUFNO0FBQzVDLFdBQU87QUFBQSxFQUNULFFBQVE7QUFDTiw0QkFBd0IsSUFBSSxVQUFVLElBQUk7QUFDMUMsV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUdPLFNBQVMsb0JBQTBCO0FBQ3hDLDBCQUF3QixNQUFNO0FBQ2hDO0FBRUEsU0FBUyxZQUFZLFVBQWlDO0FBQ3BELFFBQU0sU0FBUyxhQUFhLFFBQVE7QUFDcEMsU0FBTyxPQUFPLEtBQUssT0FBTyxPQUFRO0FBQ3BDO0FBUU8sU0FBUyw0QkFDZCxVQUNBLEtBQ0EsS0FDQSxLQUNlO0FBQ2YsTUFBSTtBQUNGLFVBQU0sU0FBUyxxQkFBcUIsUUFBUTtBQUM1QyxRQUFJLENBQUMsUUFBUSxRQUFTLFFBQU87QUFDN0IsUUFBSSxPQUFPLHNCQUFzQixNQUFPLFFBQU87QUFFL0MsVUFBTSxVQUFVLGdCQUFnQixRQUFRO0FBQ3hDLFFBQUksQ0FBQyxRQUFTLFFBQU87QUFFckIsVUFBTSxTQUFTLGNBQWMsU0FBUyxLQUFLLEtBQUssR0FBRztBQUNuRCxXQUFPLFFBQVEsZUFBZTtBQUFBLEVBQ2hDLFFBQVE7QUFDTixXQUFPO0FBQUEsRUFDVDtBQUNGOyIsCiAgIm5hbWVzIjogW10KfQo=
