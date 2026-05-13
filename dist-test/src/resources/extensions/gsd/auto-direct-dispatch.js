import { deriveState } from "./state.js";
import { loadFile } from "./files.js";
import { isDbAvailable, getMilestoneSlices } from "./gsd-db.js";
import { parseRoadmap } from "./parsers-legacy.js";
import {
  resolveMilestoneFile,
  resolveSliceFile,
  relSliceFile
} from "./paths.js";
import {
  buildResearchSlicePrompt,
  buildResearchMilestonePrompt,
  buildPlanSlicePrompt,
  buildPlanMilestonePrompt,
  buildExecuteTaskPrompt,
  buildCompleteSlicePrompt,
  buildCompleteMilestonePrompt,
  buildReassessRoadmapPrompt,
  buildRunUatPrompt,
  buildReplanSlicePrompt
} from "./auto-prompts.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { pauseAuto } from "./auto.js";
import { resolveCanonicalMilestoneRoot } from "./worktree-manager.js";
import {
  getWorkflowTransportSupportError,
  getRequiredWorkflowToolsForAutoUnit
} from "./workflow-mcp.js";
async function dispatchDirectPhase(ctx, pi, phase, base) {
  const state = await deriveState(base);
  const mid = state.activeMilestone?.id;
  const midTitle = state.activeMilestone?.title ?? "";
  if (!mid) {
    ctx.ui.notify("Cannot dispatch: no active milestone.", "warning");
    return;
  }
  const projectRoot = base;
  const dispatchBase = resolveCanonicalMilestoneRoot(base, mid);
  const normalized = phase.toLowerCase();
  let unitType;
  let unitId;
  let prompt;
  switch (normalized) {
    case "research":
    case "research-milestone":
    case "research-slice": {
      const isSlice = normalized === "research-slice" || normalized === "research" && state.phase !== "pre-planning";
      if (isSlice) {
        const sid = state.activeSlice?.id;
        const sTitle = state.activeSlice?.title ?? "";
        if (!sid) {
          ctx.ui.notify("Cannot dispatch research-slice: no active slice.", "warning");
          return;
        }
        const sliceContextFile = resolveSliceFile(dispatchBase, mid, sid, "CONTEXT");
        const requireDiscussion = loadEffectiveGSDPreferences()?.preferences?.phases?.require_slice_discussion;
        if (requireDiscussion && !sliceContextFile) {
          ctx.ui.notify(
            `Slice ${sid} requires discussion before planning. Run /gsd discuss to discuss this slice, then /gsd auto to resume.`,
            "info"
          );
          await pauseAuto(ctx, pi);
          return;
        }
        unitType = "research-slice";
        unitId = `${mid}/${sid}`;
        prompt = await buildResearchSlicePrompt(mid, midTitle, sid, sTitle, dispatchBase);
      } else {
        unitType = "research-milestone";
        unitId = mid;
        prompt = await buildResearchMilestonePrompt(mid, midTitle, dispatchBase);
      }
      break;
    }
    case "plan":
    case "plan-milestone":
    case "plan-slice": {
      const isSlice = normalized === "plan-slice" || normalized === "plan" && state.phase !== "pre-planning";
      if (isSlice) {
        const sid = state.activeSlice?.id;
        const sTitle = state.activeSlice?.title ?? "";
        if (!sid) {
          ctx.ui.notify("Cannot dispatch plan-slice: no active slice.", "warning");
          return;
        }
        unitType = "plan-slice";
        unitId = `${mid}/${sid}`;
        prompt = await buildPlanSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          dispatchBase,
          void 0,
          {
            sessionContextWindow: ctx.model?.contextWindow,
            modelRegistry: ctx.modelRegistry,
            sessionProvider: ctx.model?.provider
          }
        );
      } else {
        unitType = "plan-milestone";
        unitId = mid;
        prompt = await buildPlanMilestonePrompt(mid, midTitle, dispatchBase);
      }
      break;
    }
    case "execute":
    case "execute-task": {
      const sid = state.activeSlice?.id;
      const sTitle = state.activeSlice?.title ?? "";
      const tid = state.activeTask?.id;
      const tTitle = state.activeTask?.title ?? "";
      if (!sid) {
        ctx.ui.notify("Cannot dispatch execute-task: no active slice.", "warning");
        return;
      }
      if (!tid) {
        ctx.ui.notify("Cannot dispatch execute-task: no active task.", "warning");
        return;
      }
      unitType = "execute-task";
      unitId = `${mid}/${sid}/${tid}`;
      prompt = await buildExecuteTaskPrompt(
        mid,
        sid,
        sTitle,
        tid,
        tTitle,
        dispatchBase,
        {
          sessionContextWindow: ctx.model?.contextWindow,
          modelRegistry: ctx.modelRegistry,
          sessionProvider: ctx.model?.provider
        }
      );
      break;
    }
    case "complete":
    case "complete-slice":
    case "complete-milestone": {
      const isSlice = normalized === "complete-slice" || normalized === "complete" && state.phase === "summarizing";
      if (isSlice) {
        const sid = state.activeSlice?.id;
        const sTitle = state.activeSlice?.title ?? "";
        if (!sid) {
          ctx.ui.notify("Cannot dispatch complete-slice: no active slice.", "warning");
          return;
        }
        unitType = "complete-slice";
        unitId = `${mid}/${sid}`;
        prompt = await buildCompleteSlicePrompt(mid, midTitle, sid, sTitle, dispatchBase);
      } else {
        unitType = "complete-milestone";
        unitId = mid;
        prompt = await buildCompleteMilestonePrompt(mid, midTitle, dispatchBase);
      }
      break;
    }
    case "reassess":
    case "reassess-roadmap": {
      let completedSliceIds = [];
      if (isDbAvailable()) {
        completedSliceIds = getMilestoneSlices(mid).filter((s) => s.status === "complete").map((s) => s.id);
      }
      if (completedSliceIds.length === 0) {
        const roadmapPath = resolveMilestoneFile(dispatchBase, mid, "ROADMAP");
        if (roadmapPath) {
          const roadmapContent = await loadFile(roadmapPath);
          if (roadmapContent) {
            completedSliceIds = parseRoadmap(roadmapContent).slices.filter((s) => s.done).map((s) => s.id);
          }
        }
      }
      if (completedSliceIds.length === 0) {
        ctx.ui.notify("Cannot dispatch reassess-roadmap: no completed slices.", "warning");
        return;
      }
      const completedSliceId = completedSliceIds[completedSliceIds.length - 1];
      unitType = "reassess-roadmap";
      unitId = `${mid}/${completedSliceId}`;
      prompt = await buildReassessRoadmapPrompt(mid, midTitle, completedSliceId, dispatchBase);
      break;
    }
    case "uat":
    case "run-uat": {
      let uatCompletedSliceIds = [];
      if (isDbAvailable()) {
        uatCompletedSliceIds = getMilestoneSlices(mid).filter((s) => s.status === "complete").map((s) => s.id);
      }
      if (uatCompletedSliceIds.length === 0) {
        const roadmapPath = resolveMilestoneFile(dispatchBase, mid, "ROADMAP");
        if (roadmapPath) {
          const roadmapContent = await loadFile(roadmapPath);
          if (roadmapContent) {
            uatCompletedSliceIds = parseRoadmap(roadmapContent).slices.filter((s) => s.done).map((s) => s.id);
          }
        }
      }
      if (uatCompletedSliceIds.length === 0) {
        ctx.ui.notify("Cannot dispatch run-uat: no completed slices.", "warning");
        return;
      }
      const sid = uatCompletedSliceIds[uatCompletedSliceIds.length - 1];
      const uatFile = resolveSliceFile(dispatchBase, mid, sid, "UAT");
      if (!uatFile) {
        ctx.ui.notify("Cannot dispatch run-uat: no UAT file found.", "warning");
        return;
      }
      const uatContent = await loadFile(uatFile);
      if (!uatContent) {
        ctx.ui.notify("Cannot dispatch run-uat: UAT file is empty.", "warning");
        return;
      }
      const uatPath = relSliceFile(dispatchBase, mid, sid, "UAT");
      unitType = "run-uat";
      unitId = `${mid}/${sid}`;
      prompt = await buildRunUatPrompt(mid, sid, uatPath, uatContent, dispatchBase);
      break;
    }
    case "replan":
    case "replan-slice": {
      const sid = state.activeSlice?.id;
      const sTitle = state.activeSlice?.title ?? "";
      if (!sid) {
        ctx.ui.notify("Cannot dispatch replan-slice: no active slice.", "warning");
        return;
      }
      unitType = "replan-slice";
      unitId = `${mid}/${sid}`;
      prompt = await buildReplanSlicePrompt(mid, midTitle, sid, sTitle, dispatchBase);
      break;
    }
    default:
      ctx.ui.notify(
        `Unknown phase "${phase}". Valid phases: research, plan, execute, complete, reassess, uat, replan.`,
        "warning"
      );
      return;
  }
  const compatibilityError = getWorkflowTransportSupportError(
    ctx.model?.provider,
    getRequiredWorkflowToolsForAutoUnit(unitType),
    {
      projectRoot,
      surface: "direct phase dispatch",
      unitType,
      authMode: ctx.model?.provider ? ctx.modelRegistry.getProviderAuthMode(ctx.model.provider) : void 0,
      baseUrl: ctx.model?.baseUrl
    }
  );
  if (compatibilityError) {
    ctx.ui.notify(compatibilityError, "error");
    return;
  }
  ctx.ui.notify(`Dispatching ${unitType} for ${unitId}...`, "info");
  const result = await ctx.newSession({ workspaceRoot: dispatchBase });
  if (result.cancelled) {
    ctx.ui.notify("Session creation cancelled.", "warning");
    return;
  }
  pi.sendMessage(
    { customType: "gsd-dispatch", content: prompt, display: false },
    { triggerTurn: true }
  );
}
export {
  dispatchDirectPhase
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLWRpcmVjdC1kaXNwYXRjaC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBEaXJlY3QgcGhhc2UgZGlzcGF0Y2ggXHUyMDE0IGhhbmRsZXMgbWFudWFsIC9nc2QgZGlzcGF0Y2ggY29tbWFuZHMuXG4gKiBSZXNvbHZlcyBwaGFzZSBuYW1lIFx1MjE5MiB1bml0IHR5cGUgKyBwcm9tcHQsIGNyZWF0ZXMgYSBzZXNzaW9uLCBhbmQgc2VuZHMgdGhlIG1lc3NhZ2UuXG4gKi9cblxuaW1wb3J0IHR5cGUge1xuICBFeHRlbnNpb25BUEksXG4gIEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxufSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcblxuaW1wb3J0IHsgZGVyaXZlU3RhdGUgfSBmcm9tIFwiLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHsgbG9hZEZpbGUgfSBmcm9tIFwiLi9maWxlcy5qc1wiO1xuaW1wb3J0IHsgaXNEYkF2YWlsYWJsZSwgZ2V0TWlsZXN0b25lU2xpY2VzIH0gZnJvbSBcIi4vZ3NkLWRiLmpzXCI7XG5pbXBvcnQgeyBwYXJzZVJvYWRtYXAgfSBmcm9tIFwiLi9wYXJzZXJzLWxlZ2FjeS5qc1wiO1xuaW1wb3J0IHtcbiAgcmVzb2x2ZU1pbGVzdG9uZUZpbGUsIHJlc29sdmVTbGljZUZpbGUsIHJlbFNsaWNlRmlsZSxcbn0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB7XG4gIGJ1aWxkUmVzZWFyY2hTbGljZVByb21wdCxcbiAgYnVpbGRSZXNlYXJjaE1pbGVzdG9uZVByb21wdCxcbiAgYnVpbGRQbGFuU2xpY2VQcm9tcHQsXG4gIGJ1aWxkUGxhbk1pbGVzdG9uZVByb21wdCxcbiAgYnVpbGRFeGVjdXRlVGFza1Byb21wdCxcbiAgYnVpbGRDb21wbGV0ZVNsaWNlUHJvbXB0LFxuICBidWlsZENvbXBsZXRlTWlsZXN0b25lUHJvbXB0LFxuICBidWlsZFJlYXNzZXNzUm9hZG1hcFByb21wdCxcbiAgYnVpbGRSdW5VYXRQcm9tcHQsXG4gIGJ1aWxkUmVwbGFuU2xpY2VQcm9tcHQsXG59IGZyb20gXCIuL2F1dG8tcHJvbXB0cy5qc1wiO1xuaW1wb3J0IHsgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzIH0gZnJvbSBcIi4vcHJlZmVyZW5jZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgTWluaW1hbE1vZGVsUmVnaXN0cnkgfSBmcm9tIFwiLi9jb250ZXh0LWJ1ZGdldC5qc1wiO1xuaW1wb3J0IHsgcGF1c2VBdXRvIH0gZnJvbSBcIi4vYXV0by5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZUNhbm9uaWNhbE1pbGVzdG9uZVJvb3QgfSBmcm9tIFwiLi93b3JrdHJlZS1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQge1xuICBnZXRXb3JrZmxvd1RyYW5zcG9ydFN1cHBvcnRFcnJvcixcbiAgZ2V0UmVxdWlyZWRXb3JrZmxvd1Rvb2xzRm9yQXV0b1VuaXQsXG59IGZyb20gXCIuL3dvcmtmbG93LW1jcC5qc1wiO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZGlzcGF0Y2hEaXJlY3RQaGFzZShcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbiAgcGk6IEV4dGVuc2lvbkFQSSxcbiAgcGhhc2U6IHN0cmluZyxcbiAgYmFzZTogc3RyaW5nLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gIGNvbnN0IG1pZCA9IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQ7XG4gIGNvbnN0IG1pZFRpdGxlID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lPy50aXRsZSA/PyBcIlwiO1xuXG4gIGlmICghbWlkKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIkNhbm5vdCBkaXNwYXRjaDogbm8gYWN0aXZlIG1pbGVzdG9uZS5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHByb2plY3RSb290ID0gYmFzZTtcblxuICAvLyBTd2l0Y2ggdGhlIGRpc3BhdGNoIGJhc2UgdG8gdGhlIGNhbm9uaWNhbCBtaWxlc3RvbmUgd29ya3RyZWUgaWYgb25lXG4gIC8vIGV4aXN0cy4gV2l0aG91dCB0aGlzLCAvZ3NkIGRpc3BhdGNoIGludm9rZWQgZnJvbSB0aGUgcHJvamVjdCByb290IHdvdWxkXG4gIC8vIGJ1aWxkIHByb21wdHMgYW5kIGNyZWF0ZSBhIHNlc3Npb24gYW5jaG9yZWQgdG8gdGhlIHByb2plY3Qgcm9vdCBldmVuXG4gIC8vIHRob3VnaCB0aGUgbWlsZXN0b25lJ3MgYWN0dWFsIGNvZGUgbGl2ZXMgaW4gdGhlIHdvcmt0cmVlLlxuICBjb25zdCBkaXNwYXRjaEJhc2UgPSByZXNvbHZlQ2Fub25pY2FsTWlsZXN0b25lUm9vdChiYXNlLCBtaWQpO1xuXG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBwaGFzZS50b0xvd2VyQ2FzZSgpO1xuICBsZXQgdW5pdFR5cGU6IHN0cmluZztcbiAgbGV0IHVuaXRJZDogc3RyaW5nO1xuICBsZXQgcHJvbXB0OiBzdHJpbmc7XG5cbiAgc3dpdGNoIChub3JtYWxpemVkKSB7XG4gICAgY2FzZSBcInJlc2VhcmNoXCI6XG4gICAgY2FzZSBcInJlc2VhcmNoLW1pbGVzdG9uZVwiOlxuICAgIGNhc2UgXCJyZXNlYXJjaC1zbGljZVwiOiB7XG4gICAgICBjb25zdCBpc1NsaWNlID0gbm9ybWFsaXplZCA9PT0gXCJyZXNlYXJjaC1zbGljZVwiIHx8IChub3JtYWxpemVkID09PSBcInJlc2VhcmNoXCIgJiYgc3RhdGUucGhhc2UgIT09IFwicHJlLXBsYW5uaW5nXCIpO1xuICAgICAgaWYgKGlzU2xpY2UpIHtcbiAgICAgICAgY29uc3Qgc2lkID0gc3RhdGUuYWN0aXZlU2xpY2U/LmlkO1xuICAgICAgICBjb25zdCBzVGl0bGUgPSBzdGF0ZS5hY3RpdmVTbGljZT8udGl0bGUgPz8gXCJcIjtcbiAgICAgICAgaWYgKCFzaWQpIHtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KFwiQ2Fubm90IGRpc3BhdGNoIHJlc2VhcmNoLXNsaWNlOiBubyBhY3RpdmUgc2xpY2UuXCIsIFwid2FybmluZ1wiKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICAvLyBXaGVuIHJlcXVpcmVfc2xpY2VfZGlzY3Vzc2lvbiBpcyBlbmFibGVkLCBwYXVzZSBhdXRvLW1vZGUgYmVmb3JlXG4gICAgICAgIC8vIGVhY2ggbmV3IHNsaWNlIHNvIHRoZSB1c2VyIGNhbiBkaXNjdXNzIHJlcXVpcmVtZW50cyBmaXJzdCAoIzc4OSkuXG4gICAgICAgIGNvbnN0IHNsaWNlQ29udGV4dEZpbGUgPSByZXNvbHZlU2xpY2VGaWxlKGRpc3BhdGNoQmFzZSwgbWlkLCBzaWQsIFwiQ09OVEVYVFwiKTtcbiAgICAgICAgY29uc3QgcmVxdWlyZURpc2N1c3Npb24gPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKT8ucHJlZmVyZW5jZXM/LnBoYXNlcz8ucmVxdWlyZV9zbGljZV9kaXNjdXNzaW9uO1xuICAgICAgICBpZiAocmVxdWlyZURpc2N1c3Npb24gJiYgIXNsaWNlQ29udGV4dEZpbGUpIHtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgYFNsaWNlICR7c2lkfSByZXF1aXJlcyBkaXNjdXNzaW9uIGJlZm9yZSBwbGFubmluZy4gUnVuIC9nc2QgZGlzY3VzcyB0byBkaXNjdXNzIHRoaXMgc2xpY2UsIHRoZW4gL2dzZCBhdXRvIHRvIHJlc3VtZS5gLFxuICAgICAgICAgICAgXCJpbmZvXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBhd2FpdCBwYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgdW5pdFR5cGUgPSBcInJlc2VhcmNoLXNsaWNlXCI7XG4gICAgICAgIHVuaXRJZCA9IGAke21pZH0vJHtzaWR9YDtcbiAgICAgICAgcHJvbXB0ID0gYXdhaXQgYnVpbGRSZXNlYXJjaFNsaWNlUHJvbXB0KG1pZCwgbWlkVGl0bGUsIHNpZCwgc1RpdGxlLCBkaXNwYXRjaEJhc2UpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdW5pdFR5cGUgPSBcInJlc2VhcmNoLW1pbGVzdG9uZVwiO1xuICAgICAgICB1bml0SWQgPSBtaWQ7XG4gICAgICAgIHByb21wdCA9IGF3YWl0IGJ1aWxkUmVzZWFyY2hNaWxlc3RvbmVQcm9tcHQobWlkLCBtaWRUaXRsZSwgZGlzcGF0Y2hCYXNlKTtcbiAgICAgIH1cbiAgICAgIGJyZWFrO1xuICAgIH1cblxuICAgIGNhc2UgXCJwbGFuXCI6XG4gICAgY2FzZSBcInBsYW4tbWlsZXN0b25lXCI6XG4gICAgY2FzZSBcInBsYW4tc2xpY2VcIjoge1xuICAgICAgY29uc3QgaXNTbGljZSA9IG5vcm1hbGl6ZWQgPT09IFwicGxhbi1zbGljZVwiIHx8IChub3JtYWxpemVkID09PSBcInBsYW5cIiAmJiBzdGF0ZS5waGFzZSAhPT0gXCJwcmUtcGxhbm5pbmdcIik7XG4gICAgICBpZiAoaXNTbGljZSkge1xuICAgICAgICBjb25zdCBzaWQgPSBzdGF0ZS5hY3RpdmVTbGljZT8uaWQ7XG4gICAgICAgIGNvbnN0IHNUaXRsZSA9IHN0YXRlLmFjdGl2ZVNsaWNlPy50aXRsZSA/PyBcIlwiO1xuICAgICAgICBpZiAoIXNpZCkge1xuICAgICAgICAgIGN0eC51aS5ub3RpZnkoXCJDYW5ub3QgZGlzcGF0Y2ggcGxhbi1zbGljZTogbm8gYWN0aXZlIHNsaWNlLlwiLCBcIndhcm5pbmdcIik7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHVuaXRUeXBlID0gXCJwbGFuLXNsaWNlXCI7XG4gICAgICAgIHVuaXRJZCA9IGAke21pZH0vJHtzaWR9YDtcbiAgICAgICAgcHJvbXB0ID0gYXdhaXQgYnVpbGRQbGFuU2xpY2VQcm9tcHQoXG4gICAgICAgICAgbWlkLCBtaWRUaXRsZSwgc2lkLCBzVGl0bGUsIGRpc3BhdGNoQmFzZSwgdW5kZWZpbmVkLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIHNlc3Npb25Db250ZXh0V2luZG93OiBjdHgubW9kZWw/LmNvbnRleHRXaW5kb3csXG4gICAgICAgICAgICBtb2RlbFJlZ2lzdHJ5OiBjdHgubW9kZWxSZWdpc3RyeSBhcyBNaW5pbWFsTW9kZWxSZWdpc3RyeSB8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHNlc3Npb25Qcm92aWRlcjogY3R4Lm1vZGVsPy5wcm92aWRlcixcbiAgICAgICAgICB9LFxuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdW5pdFR5cGUgPSBcInBsYW4tbWlsZXN0b25lXCI7XG4gICAgICAgIHVuaXRJZCA9IG1pZDtcbiAgICAgICAgcHJvbXB0ID0gYXdhaXQgYnVpbGRQbGFuTWlsZXN0b25lUHJvbXB0KG1pZCwgbWlkVGl0bGUsIGRpc3BhdGNoQmFzZSk7XG4gICAgICB9XG4gICAgICBicmVhaztcbiAgICB9XG5cbiAgICBjYXNlIFwiZXhlY3V0ZVwiOlxuICAgIGNhc2UgXCJleGVjdXRlLXRhc2tcIjoge1xuICAgICAgY29uc3Qgc2lkID0gc3RhdGUuYWN0aXZlU2xpY2U/LmlkO1xuICAgICAgY29uc3Qgc1RpdGxlID0gc3RhdGUuYWN0aXZlU2xpY2U/LnRpdGxlID8/IFwiXCI7XG4gICAgICBjb25zdCB0aWQgPSBzdGF0ZS5hY3RpdmVUYXNrPy5pZDtcbiAgICAgIGNvbnN0IHRUaXRsZSA9IHN0YXRlLmFjdGl2ZVRhc2s/LnRpdGxlID8/IFwiXCI7XG4gICAgICBpZiAoIXNpZCkge1xuICAgICAgICBjdHgudWkubm90aWZ5KFwiQ2Fubm90IGRpc3BhdGNoIGV4ZWN1dGUtdGFzazogbm8gYWN0aXZlIHNsaWNlLlwiLCBcIndhcm5pbmdcIik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmICghdGlkKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXCJDYW5ub3QgZGlzcGF0Y2ggZXhlY3V0ZS10YXNrOiBubyBhY3RpdmUgdGFzay5cIiwgXCJ3YXJuaW5nXCIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB1bml0VHlwZSA9IFwiZXhlY3V0ZS10YXNrXCI7XG4gICAgICB1bml0SWQgPSBgJHttaWR9LyR7c2lkfS8ke3RpZH1gO1xuICAgICAgcHJvbXB0ID0gYXdhaXQgYnVpbGRFeGVjdXRlVGFza1Byb21wdChcbiAgICAgICAgbWlkLCBzaWQsIHNUaXRsZSwgdGlkLCB0VGl0bGUsIGRpc3BhdGNoQmFzZSxcbiAgICAgICAge1xuICAgICAgICAgIHNlc3Npb25Db250ZXh0V2luZG93OiBjdHgubW9kZWw/LmNvbnRleHRXaW5kb3csXG4gICAgICAgICAgbW9kZWxSZWdpc3RyeTogY3R4Lm1vZGVsUmVnaXN0cnkgYXMgTWluaW1hbE1vZGVsUmVnaXN0cnkgfCB1bmRlZmluZWQsXG4gICAgICAgICAgc2Vzc2lvblByb3ZpZGVyOiBjdHgubW9kZWw/LnByb3ZpZGVyLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICAgIGJyZWFrO1xuICAgIH1cblxuICAgIGNhc2UgXCJjb21wbGV0ZVwiOlxuICAgIGNhc2UgXCJjb21wbGV0ZS1zbGljZVwiOlxuICAgIGNhc2UgXCJjb21wbGV0ZS1taWxlc3RvbmVcIjoge1xuICAgICAgY29uc3QgaXNTbGljZSA9IG5vcm1hbGl6ZWQgPT09IFwiY29tcGxldGUtc2xpY2VcIiB8fCAobm9ybWFsaXplZCA9PT0gXCJjb21wbGV0ZVwiICYmIHN0YXRlLnBoYXNlID09PSBcInN1bW1hcml6aW5nXCIpO1xuICAgICAgaWYgKGlzU2xpY2UpIHtcbiAgICAgICAgY29uc3Qgc2lkID0gc3RhdGUuYWN0aXZlU2xpY2U/LmlkO1xuICAgICAgICBjb25zdCBzVGl0bGUgPSBzdGF0ZS5hY3RpdmVTbGljZT8udGl0bGUgPz8gXCJcIjtcbiAgICAgICAgaWYgKCFzaWQpIHtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KFwiQ2Fubm90IGRpc3BhdGNoIGNvbXBsZXRlLXNsaWNlOiBubyBhY3RpdmUgc2xpY2UuXCIsIFwid2FybmluZ1wiKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdW5pdFR5cGUgPSBcImNvbXBsZXRlLXNsaWNlXCI7XG4gICAgICAgIHVuaXRJZCA9IGAke21pZH0vJHtzaWR9YDtcbiAgICAgICAgcHJvbXB0ID0gYXdhaXQgYnVpbGRDb21wbGV0ZVNsaWNlUHJvbXB0KG1pZCwgbWlkVGl0bGUsIHNpZCwgc1RpdGxlLCBkaXNwYXRjaEJhc2UpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdW5pdFR5cGUgPSBcImNvbXBsZXRlLW1pbGVzdG9uZVwiO1xuICAgICAgICB1bml0SWQgPSBtaWQ7XG4gICAgICAgIHByb21wdCA9IGF3YWl0IGJ1aWxkQ29tcGxldGVNaWxlc3RvbmVQcm9tcHQobWlkLCBtaWRUaXRsZSwgZGlzcGF0Y2hCYXNlKTtcbiAgICAgIH1cbiAgICAgIGJyZWFrO1xuICAgIH1cblxuICAgIGNhc2UgXCJyZWFzc2Vzc1wiOlxuICAgIGNhc2UgXCJyZWFzc2Vzcy1yb2FkbWFwXCI6IHtcbiAgICAgIC8vIERCIHByaW1hcnkgcGF0aCBcdTIwMTQgZ2V0IGNvbXBsZXRlZCBzbGljZXMsIGZhbGwgYmFjayB0byBmaWxlIHBhcnNpbmcgd2hlbiBEQiBoYXMgbm8gZGF0YVxuICAgICAgbGV0IGNvbXBsZXRlZFNsaWNlSWRzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgICBjb21wbGV0ZWRTbGljZUlkcyA9IGdldE1pbGVzdG9uZVNsaWNlcyhtaWQpLmZpbHRlcihzID0+IHMuc3RhdHVzID09PSBcImNvbXBsZXRlXCIpLm1hcChzID0+IHMuaWQpO1xuICAgICAgfVxuICAgICAgaWYgKGNvbXBsZXRlZFNsaWNlSWRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAvLyBGaWxlLWJhc2VkIGZhbGxiYWNrOiBwYXJzZSByb2FkbWFwIGNoZWNrYm94ZXNcbiAgICAgICAgY29uc3Qgcm9hZG1hcFBhdGggPSByZXNvbHZlTWlsZXN0b25lRmlsZShkaXNwYXRjaEJhc2UsIG1pZCwgXCJST0FETUFQXCIpO1xuICAgICAgICBpZiAocm9hZG1hcFBhdGgpIHtcbiAgICAgICAgICBjb25zdCByb2FkbWFwQ29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHJvYWRtYXBQYXRoKTtcbiAgICAgICAgICBpZiAocm9hZG1hcENvbnRlbnQpIHtcbiAgICAgICAgICAgIGNvbXBsZXRlZFNsaWNlSWRzID0gcGFyc2VSb2FkbWFwKHJvYWRtYXBDb250ZW50KS5zbGljZXMuZmlsdGVyKHMgPT4gcy5kb25lKS5tYXAocyA9PiBzLmlkKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChjb21wbGV0ZWRTbGljZUlkcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcIkNhbm5vdCBkaXNwYXRjaCByZWFzc2Vzcy1yb2FkbWFwOiBubyBjb21wbGV0ZWQgc2xpY2VzLlwiLCBcIndhcm5pbmdcIik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGNvbXBsZXRlZFNsaWNlSWQgPSBjb21wbGV0ZWRTbGljZUlkc1tjb21wbGV0ZWRTbGljZUlkcy5sZW5ndGggLSAxXTtcbiAgICAgIHVuaXRUeXBlID0gXCJyZWFzc2Vzcy1yb2FkbWFwXCI7XG4gICAgICB1bml0SWQgPSBgJHttaWR9LyR7Y29tcGxldGVkU2xpY2VJZH1gO1xuICAgICAgcHJvbXB0ID0gYXdhaXQgYnVpbGRSZWFzc2Vzc1JvYWRtYXBQcm9tcHQobWlkLCBtaWRUaXRsZSwgY29tcGxldGVkU2xpY2VJZCwgZGlzcGF0Y2hCYXNlKTtcbiAgICAgIGJyZWFrO1xuICAgIH1cblxuICAgIGNhc2UgXCJ1YXRcIjpcbiAgICBjYXNlIFwicnVuLXVhdFwiOiB7XG4gICAgICAvLyBVQVQgdGFyZ2V0cyB0aGUgbW9zdCByZWNlbnRseSBjb21wbGV0ZWQgc2xpY2UsIG5vdCB0aGUgYWN0aXZlIChuZXh0XG4gICAgICAvLyBpbmNvbXBsZXRlKSBzbGljZS4gQWZ0ZXIgc2xpY2UgY29tcGxldGlvbiwgc3RhdGUuYWN0aXZlU2xpY2UgYWR2YW5jZXNcbiAgICAgIC8vIHRvIHRoZSBuZXh0IGluY29tcGxldGUgc2xpY2UsIHNvIHdlIGZpbmQgdGhlIGxhc3QgZG9uZSBzbGljZSBmcm9tIHRoZVxuICAgICAgLy8gcm9hZG1hcCBpbnN0ZWFkICgjMTY5MykuXG4gICAgICBsZXQgdWF0Q29tcGxldGVkU2xpY2VJZHM6IHN0cmluZ1tdID0gW107XG4gICAgICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICAgIHVhdENvbXBsZXRlZFNsaWNlSWRzID0gZ2V0TWlsZXN0b25lU2xpY2VzKG1pZCkuZmlsdGVyKHMgPT4gcy5zdGF0dXMgPT09IFwiY29tcGxldGVcIikubWFwKHMgPT4gcy5pZCk7XG4gICAgICB9XG4gICAgICBpZiAodWF0Q29tcGxldGVkU2xpY2VJZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIC8vIEZpbGUtYmFzZWQgZmFsbGJhY2s6IHBhcnNlIHJvYWRtYXAgY2hlY2tib3hlc1xuICAgICAgICBjb25zdCByb2FkbWFwUGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGRpc3BhdGNoQmFzZSwgbWlkLCBcIlJPQURNQVBcIik7XG4gICAgICAgIGlmIChyb2FkbWFwUGF0aCkge1xuICAgICAgICAgIGNvbnN0IHJvYWRtYXBDb250ZW50ID0gYXdhaXQgbG9hZEZpbGUocm9hZG1hcFBhdGgpO1xuICAgICAgICAgIGlmIChyb2FkbWFwQ29udGVudCkge1xuICAgICAgICAgICAgdWF0Q29tcGxldGVkU2xpY2VJZHMgPSBwYXJzZVJvYWRtYXAocm9hZG1hcENvbnRlbnQpLnNsaWNlcy5maWx0ZXIocyA9PiBzLmRvbmUpLm1hcChzID0+IHMuaWQpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHVhdENvbXBsZXRlZFNsaWNlSWRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBjdHgudWkubm90aWZ5KFwiQ2Fubm90IGRpc3BhdGNoIHJ1bi11YXQ6IG5vIGNvbXBsZXRlZCBzbGljZXMuXCIsIFwid2FybmluZ1wiKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY29uc3Qgc2lkID0gdWF0Q29tcGxldGVkU2xpY2VJZHNbdWF0Q29tcGxldGVkU2xpY2VJZHMubGVuZ3RoIC0gMV07XG4gICAgICBjb25zdCB1YXRGaWxlID0gcmVzb2x2ZVNsaWNlRmlsZShkaXNwYXRjaEJhc2UsIG1pZCwgc2lkLCBcIlVBVFwiKTtcbiAgICAgIGlmICghdWF0RmlsZSkge1xuICAgICAgICBjdHgudWkubm90aWZ5KFwiQ2Fubm90IGRpc3BhdGNoIHJ1bi11YXQ6IG5vIFVBVCBmaWxlIGZvdW5kLlwiLCBcIndhcm5pbmdcIik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHVhdENvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZSh1YXRGaWxlKTtcbiAgICAgIGlmICghdWF0Q29udGVudCkge1xuICAgICAgICBjdHgudWkubm90aWZ5KFwiQ2Fubm90IGRpc3BhdGNoIHJ1bi11YXQ6IFVBVCBmaWxlIGlzIGVtcHR5LlwiLCBcIndhcm5pbmdcIik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHVhdFBhdGggPSByZWxTbGljZUZpbGUoZGlzcGF0Y2hCYXNlLCBtaWQsIHNpZCwgXCJVQVRcIik7XG4gICAgICB1bml0VHlwZSA9IFwicnVuLXVhdFwiO1xuICAgICAgdW5pdElkID0gYCR7bWlkfS8ke3NpZH1gO1xuICAgICAgcHJvbXB0ID0gYXdhaXQgYnVpbGRSdW5VYXRQcm9tcHQobWlkLCBzaWQsIHVhdFBhdGgsIHVhdENvbnRlbnQsIGRpc3BhdGNoQmFzZSk7XG4gICAgICBicmVhaztcbiAgICB9XG5cbiAgICBjYXNlIFwicmVwbGFuXCI6XG4gICAgY2FzZSBcInJlcGxhbi1zbGljZVwiOiB7XG4gICAgICBjb25zdCBzaWQgPSBzdGF0ZS5hY3RpdmVTbGljZT8uaWQ7XG4gICAgICBjb25zdCBzVGl0bGUgPSBzdGF0ZS5hY3RpdmVTbGljZT8udGl0bGUgPz8gXCJcIjtcbiAgICAgIGlmICghc2lkKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXCJDYW5ub3QgZGlzcGF0Y2ggcmVwbGFuLXNsaWNlOiBubyBhY3RpdmUgc2xpY2UuXCIsIFwid2FybmluZ1wiKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdW5pdFR5cGUgPSBcInJlcGxhbi1zbGljZVwiO1xuICAgICAgdW5pdElkID0gYCR7bWlkfS8ke3NpZH1gO1xuICAgICAgcHJvbXB0ID0gYXdhaXQgYnVpbGRSZXBsYW5TbGljZVByb21wdChtaWQsIG1pZFRpdGxlLCBzaWQsIHNUaXRsZSwgZGlzcGF0Y2hCYXNlKTtcbiAgICAgIGJyZWFrO1xuICAgIH1cblxuICAgIGRlZmF1bHQ6XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgVW5rbm93biBwaGFzZSBcIiR7cGhhc2V9XCIuIFZhbGlkIHBoYXNlczogcmVzZWFyY2gsIHBsYW4sIGV4ZWN1dGUsIGNvbXBsZXRlLCByZWFzc2VzcywgdWF0LCByZXBsYW4uYCxcbiAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgY29tcGF0aWJpbGl0eUVycm9yID0gZ2V0V29ya2Zsb3dUcmFuc3BvcnRTdXBwb3J0RXJyb3IoXG4gICAgY3R4Lm1vZGVsPy5wcm92aWRlcixcbiAgICBnZXRSZXF1aXJlZFdvcmtmbG93VG9vbHNGb3JBdXRvVW5pdCh1bml0VHlwZSksXG4gICAge1xuICAgICAgcHJvamVjdFJvb3QsXG4gICAgICBzdXJmYWNlOiBcImRpcmVjdCBwaGFzZSBkaXNwYXRjaFwiLFxuICAgICAgdW5pdFR5cGUsXG4gICAgICBhdXRoTW9kZTogY3R4Lm1vZGVsPy5wcm92aWRlciA/IGN0eC5tb2RlbFJlZ2lzdHJ5LmdldFByb3ZpZGVyQXV0aE1vZGUoY3R4Lm1vZGVsLnByb3ZpZGVyKSA6IHVuZGVmaW5lZCxcbiAgICAgIGJhc2VVcmw6IGN0eC5tb2RlbD8uYmFzZVVybCxcbiAgICB9LFxuICApO1xuICBpZiAoY29tcGF0aWJpbGl0eUVycm9yKSB7XG4gICAgY3R4LnVpLm5vdGlmeShjb21wYXRpYmlsaXR5RXJyb3IsIFwiZXJyb3JcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY3R4LnVpLm5vdGlmeShgRGlzcGF0Y2hpbmcgJHt1bml0VHlwZX0gZm9yICR7dW5pdElkfS4uLmAsIFwiaW5mb1wiKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBjdHgubmV3U2Vzc2lvbih7IHdvcmtzcGFjZVJvb3Q6IGRpc3BhdGNoQmFzZSB9KTtcbiAgaWYgKHJlc3VsdC5jYW5jZWxsZWQpIHtcbiAgICBjdHgudWkubm90aWZ5KFwiU2Vzc2lvbiBjcmVhdGlvbiBjYW5jZWxsZWQuXCIsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcGkuc2VuZE1lc3NhZ2UoXG4gICAgeyBjdXN0b21UeXBlOiBcImdzZC1kaXNwYXRjaFwiLCBjb250ZW50OiBwcm9tcHQsIGRpc3BsYXk6IGZhbHNlIH0sXG4gICAgeyB0cmlnZ2VyVHVybjogdHJ1ZSB9LFxuICApO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBVUEsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyxnQkFBZ0I7QUFDekIsU0FBUyxlQUFlLDBCQUEwQjtBQUNsRCxTQUFTLG9CQUFvQjtBQUM3QjtBQUFBLEVBQ0U7QUFBQSxFQUFzQjtBQUFBLEVBQWtCO0FBQUEsT0FDbkM7QUFDUDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxtQ0FBbUM7QUFFNUMsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxxQ0FBcUM7QUFDOUM7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLE9B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
