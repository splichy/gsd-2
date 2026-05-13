import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readGraph,
  writeGraph,
  getNextPendingStep,
  markStepActive,
  markStepComplete,
  expandIteration,
  isTerminalStepStatus
} from "./graph.js";
import { injectContext } from "./context-injector.js";
import { readFrozenDefinition } from "./definition-io.js";
import { parseUnitId } from "./unit-id.js";
import { withFileLock } from "./file-lock.js";
import { readFrozenDefinition as readFrozenDefinition2 } from "./definition-io.js";
function formatBlockedWorkflowReason(graph) {
  const statusById = new Map(graph.steps.map((step) => [step.id, step.status]));
  const blockedSteps = graph.steps.filter((step) => step.status === "pending").map((step) => {
    const blockers = step.dependsOn.filter((depId) => !isTerminalStepStatus(statusById.get(depId))).map((depId) => `${depId} (${statusById.get(depId) ?? "missing"})`);
    return blockers.length > 0 ? `${step.id} waiting on ${blockers.join(", ")}` : `${step.id} has no runnable dependency path`;
  });
  return blockedSteps.length > 0 ? `Workflow blocked: no pending steps are ready. Blocked steps: ${blockedSteps.join("; ")}` : "Workflow blocked: no pending steps are ready.";
}
class CustomWorkflowEngine {
  engineId = "custom";
  runDir;
  constructor(runDir) {
    this.runDir = runDir;
  }
  /**
   * Derive engine state from GRAPH.yaml on disk.
   *
   * Phase is "complete" when all steps are complete or expanded,
   * "running" otherwise (any pending or active steps remain).
   */
  async deriveState(_basePath) {
    const graph = readGraph(this.runDir);
    const allDone = graph.steps.every(
      (s) => s.status === "complete" || s.status === "expanded"
    );
    const phase = allDone ? "complete" : "running";
    return {
      phase,
      currentMilestoneId: null,
      activeSliceId: null,
      activeTaskId: null,
      isComplete: allDone,
      raw: graph
    };
  }
  /**
   * Resolve the next dispatch action from graph state.
   *
   * Uses getNextPendingStep to find the first step whose dependencies
   * are all satisfied. If the step has an `iterate` config in the frozen
   * DEFINITION.yaml, expands it into instance steps before dispatching.
   *
   * Returns a dispatch with unitType "custom-step" and unitId in
   * "<workflowName>/<stepId>" format.
   *
   * Observability:
   * - Iterate expansion is logged to stderr with item count and parent step ID.
   * - Missing source artifacts throw with the full resolved path for diagnosis.
   * - Zero-match expansions return a stop action with level "info".
   * - Expanded GRAPH.yaml is written to disk before dispatch — inspectable on disk.
   */
  async resolveDispatch(state, _context) {
    const graphPath = join(this.runDir, "GRAPH.yaml");
    return await withFileLock(graphPath, () => {
      let graph = readGraph(this.runDir);
      const active = graph.steps.find((step) => step.status === "active");
      if (active) {
        return {
          action: "dispatch",
          step: {
            unitType: "custom-step",
            unitId: `${graph.metadata.name}/${active.id}`,
            prompt: injectContext(this.runDir, active.id, active.prompt)
          }
        };
      }
      let next = getNextPendingStep(graph);
      if (!next) {
        const allDone = graph.steps.every(
          (step) => step.status === "complete" || step.status === "expanded"
        );
        if (!allDone) {
          return {
            action: "stop",
            reason: formatBlockedWorkflowReason(graph),
            level: "error"
          };
        }
        return {
          action: "stop",
          reason: "All steps complete",
          level: "info"
        };
      }
      const def = readFrozenDefinition(this.runDir);
      const stepDef = def.steps.find((s) => s.id === next.id);
      if (stepDef?.iterate) {
        const iterate = stepDef.iterate;
        const sourcePath = join(this.runDir, iterate.source);
        let sourceContent;
        try {
          sourceContent = readFileSync(sourcePath, "utf-8");
        } catch {
          throw new Error(
            `Iterate source artifact not found: ${sourcePath} (step "${next.id}", source: "${iterate.source}")`
          );
        }
        const regex = new RegExp(iterate.pattern, "gm");
        const items = [];
        const matchStart = Date.now();
        let match;
        while ((match = regex.exec(sourceContent)) !== null) {
          if (match[1] !== void 0) items.push(match[1]);
          if (Date.now() - matchStart > 5e3) {
            throw new Error(
              `Iterate pattern "${iterate.pattern}" exceeded 5s timeout on step "${next.id}" \u2014 possible ReDoS`
            );
          }
        }
        const expandedGraph = expandIteration(graph, next.id, items, next.prompt);
        writeGraph(this.runDir, expandedGraph);
        graph = expandedGraph;
        next = getNextPendingStep(expandedGraph);
        if (!next) {
          return {
            action: "stop",
            reason: "Iterate expansion produced no instances",
            level: "info"
          };
        }
      }
      const activeGraph = markStepActive(graph, next.id);
      writeGraph(this.runDir, activeGraph);
      const activeStep = activeGraph.steps.find((s) => s.id === next.id);
      if (!activeStep) {
        throw new Error(`Active step not found after GRAPH.yaml update: ${next.id}`);
      }
      const enrichedPrompt = injectContext(this.runDir, activeStep.id, activeStep.prompt);
      return {
        action: "dispatch",
        step: {
          unitType: "custom-step",
          unitId: `${activeGraph.metadata.name}/${activeStep.id}`,
          prompt: enrichedPrompt
        }
      };
    });
  }
  /**
   * Reconcile state after a step completes.
   *
   * Extracts the stepId from the completedStep's unitId (last segment after `/`),
   * marks it complete in the graph, and writes the updated GRAPH.yaml to disk.
   *
   * Returns "milestone-complete" when all steps are now done, "continue" otherwise.
   */
  async reconcile(state, completedStep) {
    const graphPath = join(this.runDir, "GRAPH.yaml");
    return await withFileLock(graphPath, () => {
      const graph = readGraph(this.runDir);
      const { milestone, slice, task } = parseUnitId(completedStep.unitId);
      const stepId = task ?? slice ?? milestone;
      const updatedGraph = markStepComplete(graph, stepId);
      writeGraph(this.runDir, updatedGraph);
      const allDone = updatedGraph.steps.every(
        (s) => s.status === "complete" || s.status === "expanded"
      );
      return {
        outcome: allDone ? "milestone-complete" : "continue"
      };
    });
  }
  /**
   * Return UI-facing metadata for progress display.
   *
   * Shows "Step N/M" progress where N = completed count and M = total.
   */
  getDisplayMetadata(state) {
    const graph = state.raw;
    const total = graph.steps.length;
    const completed = graph.steps.filter((s) => s.status === "complete").length;
    return {
      engineLabel: "WORKFLOW",
      currentPhase: state.phase,
      progressSummary: `Step ${completed}/${total}`,
      stepCount: { completed, total }
    };
  }
}
export {
  CustomWorkflowEngine,
  readFrozenDefinition2 as readFrozenDefinition
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jdXN0b20td29ya2Zsb3ctZW5naW5lLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIGN1c3RvbS13b3JrZmxvdy1lbmdpbmUudHMgXHUyMDE0IFdvcmtmbG93RW5naW5lIGltcGxlbWVudGF0aW9uIGZvciBjdXN0b20gd29ya2Zsb3dzLlxuICpcbiAqIERyaXZlcyB0aGUgYXV0by1sb29wIHVzaW5nIEdSQVBILnlhbWwgc3RlcCBzdGF0ZSBmcm9tIGEgcnVuIGRpcmVjdG9yeS5cbiAqIEVhY2ggaXRlcmF0aW9uOiBkZXJpdmVTdGF0ZSByZWFkcyB0aGUgZ3JhcGgsIHJlc29sdmVEaXNwYXRjaCBwaWNrcyB0aGVcbiAqIG5leHQgZWxpZ2libGUgc3RlcCwgcmVjb25jaWxlIG1hcmtzIGl0IGNvbXBsZXRlIGFuZCBwZXJzaXN0cy5cbiAqXG4gKiBPYnNlcnZhYmlsaXR5OlxuICogLSBBbGwgc3RhdGUgcmVhZHMvd3JpdGVzIGdvIHRocm91Z2ggZ3JhcGgudHMgWUFNTCBJL08gXHUyMDE0IGluc3BlY3RhYmxlIG9uIGRpc2suXG4gKiAtIGByZXNvbHZlRGlzcGF0Y2hgIHJldHVybnMgdW5pdFR5cGUgXCJjdXN0b20tc3RlcFwiIHdpdGggdW5pdElkIFwiPG5hbWU+LzxzdGVwSWQ+XCIuXG4gKiAtIGBnZXREaXNwbGF5TWV0YWRhdGFgIHByb3ZpZGVzIHN0ZXAgTi9NIHByb2dyZXNzIGZvciBkYXNoYm9hcmQgcmVuZGVyaW5nLlxuICogLSBQaGFzZSB0cmFuc2l0aW9ucyBhcmUgZGVyaXZhYmxlIGZyb20gR1JBUEgueWFtbCBzdGVwIHN0YXR1c2VzLlxuICovXG5cbmltcG9ydCB0eXBlIHsgV29ya2Zsb3dFbmdpbmUgfSBmcm9tIFwiLi93b3JrZmxvdy1lbmdpbmUuanNcIjtcbmltcG9ydCB0eXBlIHtcbiAgRW5naW5lU3RhdGUsXG4gIEVuZ2luZURpc3BhdGNoQWN0aW9uLFxuICBDb21wbGV0ZWRTdGVwLFxuICBSZWNvbmNpbGVSZXN1bHQsXG4gIERpc3BsYXlNZXRhZGF0YSxcbn0gZnJvbSBcIi4vZW5naW5lLXR5cGVzLmpzXCI7XG5pbXBvcnQgeyByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7XG4gIHJlYWRHcmFwaCxcbiAgd3JpdGVHcmFwaCxcbiAgZ2V0TmV4dFBlbmRpbmdTdGVwLFxuICBtYXJrU3RlcEFjdGl2ZSxcbiAgbWFya1N0ZXBDb21wbGV0ZSxcbiAgZXhwYW5kSXRlcmF0aW9uLFxuICBpc1Rlcm1pbmFsU3RlcFN0YXR1cyxcbiAgdHlwZSBXb3JrZmxvd0dyYXBoLFxufSBmcm9tIFwiLi9ncmFwaC5qc1wiO1xuaW1wb3J0IHsgaW5qZWN0Q29udGV4dCB9IGZyb20gXCIuL2NvbnRleHQtaW5qZWN0b3IuanNcIjtcbmltcG9ydCB0eXBlIHsgU3RlcERlZmluaXRpb24gfSBmcm9tIFwiLi9kZWZpbml0aW9uLWxvYWRlci5qc1wiO1xuaW1wb3J0IHsgcmVhZEZyb3plbkRlZmluaXRpb24gfSBmcm9tIFwiLi9kZWZpbml0aW9uLWlvLmpzXCI7XG5pbXBvcnQgeyBwYXJzZVVuaXRJZCB9IGZyb20gXCIuL3VuaXQtaWQuanNcIjtcbmltcG9ydCB7IHdpdGhGaWxlTG9jayB9IGZyb20gXCIuL2ZpbGUtbG9jay5qc1wiO1xuXG4vLyBSZS1leHBvcnQgZm9yIGRvd25zdHJlYW0gY29uc3VtZXJzXG5leHBvcnQgeyByZWFkRnJvemVuRGVmaW5pdGlvbiB9IGZyb20gXCIuL2RlZmluaXRpb24taW8uanNcIjtcblxuZnVuY3Rpb24gZm9ybWF0QmxvY2tlZFdvcmtmbG93UmVhc29uKGdyYXBoOiBXb3JrZmxvd0dyYXBoKTogc3RyaW5nIHtcbiAgY29uc3Qgc3RhdHVzQnlJZCA9IG5ldyBNYXAoZ3JhcGguc3RlcHMubWFwKChzdGVwKSA9PiBbc3RlcC5pZCwgc3RlcC5zdGF0dXNdKSk7XG4gIGNvbnN0IGJsb2NrZWRTdGVwcyA9IGdyYXBoLnN0ZXBzXG4gICAgLmZpbHRlcigoc3RlcCkgPT4gc3RlcC5zdGF0dXMgPT09IFwicGVuZGluZ1wiKVxuICAgIC5tYXAoKHN0ZXApID0+IHtcbiAgICAgIGNvbnN0IGJsb2NrZXJzID0gc3RlcC5kZXBlbmRzT25cbiAgICAgICAgLmZpbHRlcigoZGVwSWQpID0+ICFpc1Rlcm1pbmFsU3RlcFN0YXR1cyhzdGF0dXNCeUlkLmdldChkZXBJZCkpKVxuICAgICAgICAubWFwKChkZXBJZCkgPT4gYCR7ZGVwSWR9ICgke3N0YXR1c0J5SWQuZ2V0KGRlcElkKSA/PyBcIm1pc3NpbmdcIn0pYCk7XG4gICAgICByZXR1cm4gYmxvY2tlcnMubGVuZ3RoID4gMFxuICAgICAgICA/IGAke3N0ZXAuaWR9IHdhaXRpbmcgb24gJHtibG9ja2Vycy5qb2luKFwiLCBcIil9YFxuICAgICAgICA6IGAke3N0ZXAuaWR9IGhhcyBubyBydW5uYWJsZSBkZXBlbmRlbmN5IHBhdGhgO1xuICAgIH0pO1xuXG4gIHJldHVybiBibG9ja2VkU3RlcHMubGVuZ3RoID4gMFxuICAgID8gYFdvcmtmbG93IGJsb2NrZWQ6IG5vIHBlbmRpbmcgc3RlcHMgYXJlIHJlYWR5LiBCbG9ja2VkIHN0ZXBzOiAke2Jsb2NrZWRTdGVwcy5qb2luKFwiOyBcIil9YFxuICAgIDogXCJXb3JrZmxvdyBibG9ja2VkOiBubyBwZW5kaW5nIHN0ZXBzIGFyZSByZWFkeS5cIjtcbn1cblxuZXhwb3J0IGNsYXNzIEN1c3RvbVdvcmtmbG93RW5naW5lIGltcGxlbWVudHMgV29ya2Zsb3dFbmdpbmUge1xuICByZWFkb25seSBlbmdpbmVJZCA9IFwiY3VzdG9tXCI7XG4gIHByaXZhdGUgcmVhZG9ubHkgcnVuRGlyOiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3IocnVuRGlyOiBzdHJpbmcpIHtcbiAgICB0aGlzLnJ1bkRpciA9IHJ1bkRpcjtcbiAgfVxuXG4gIC8qKlxuICAgKiBEZXJpdmUgZW5naW5lIHN0YXRlIGZyb20gR1JBUEgueWFtbCBvbiBkaXNrLlxuICAgKlxuICAgKiBQaGFzZSBpcyBcImNvbXBsZXRlXCIgd2hlbiBhbGwgc3RlcHMgYXJlIGNvbXBsZXRlIG9yIGV4cGFuZGVkLFxuICAgKiBcInJ1bm5pbmdcIiBvdGhlcndpc2UgKGFueSBwZW5kaW5nIG9yIGFjdGl2ZSBzdGVwcyByZW1haW4pLlxuICAgKi9cbiAgYXN5bmMgZGVyaXZlU3RhdGUoX2Jhc2VQYXRoOiBzdHJpbmcpOiBQcm9taXNlPEVuZ2luZVN0YXRlPiB7XG4gICAgY29uc3QgZ3JhcGggPSByZWFkR3JhcGgodGhpcy5ydW5EaXIpO1xuICAgIGNvbnN0IGFsbERvbmUgPSBncmFwaC5zdGVwcy5ldmVyeShcbiAgICAgIChzKSA9PiBzLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiIHx8IHMuc3RhdHVzID09PSBcImV4cGFuZGVkXCIsXG4gICAgKTtcbiAgICBjb25zdCBwaGFzZSA9IGFsbERvbmUgPyBcImNvbXBsZXRlXCIgOiBcInJ1bm5pbmdcIjtcblxuICAgIHJldHVybiB7XG4gICAgICBwaGFzZSxcbiAgICAgIGN1cnJlbnRNaWxlc3RvbmVJZDogbnVsbCxcbiAgICAgIGFjdGl2ZVNsaWNlSWQ6IG51bGwsXG4gICAgICBhY3RpdmVUYXNrSWQ6IG51bGwsXG4gICAgICBpc0NvbXBsZXRlOiBhbGxEb25lLFxuICAgICAgcmF3OiBncmFwaCxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFJlc29sdmUgdGhlIG5leHQgZGlzcGF0Y2ggYWN0aW9uIGZyb20gZ3JhcGggc3RhdGUuXG4gICAqXG4gICAqIFVzZXMgZ2V0TmV4dFBlbmRpbmdTdGVwIHRvIGZpbmQgdGhlIGZpcnN0IHN0ZXAgd2hvc2UgZGVwZW5kZW5jaWVzXG4gICAqIGFyZSBhbGwgc2F0aXNmaWVkLiBJZiB0aGUgc3RlcCBoYXMgYW4gYGl0ZXJhdGVgIGNvbmZpZyBpbiB0aGUgZnJvemVuXG4gICAqIERFRklOSVRJT04ueWFtbCwgZXhwYW5kcyBpdCBpbnRvIGluc3RhbmNlIHN0ZXBzIGJlZm9yZSBkaXNwYXRjaGluZy5cbiAgICpcbiAgICogUmV0dXJucyBhIGRpc3BhdGNoIHdpdGggdW5pdFR5cGUgXCJjdXN0b20tc3RlcFwiIGFuZCB1bml0SWQgaW5cbiAgICogXCI8d29ya2Zsb3dOYW1lPi88c3RlcElkPlwiIGZvcm1hdC5cbiAgICpcbiAgICogT2JzZXJ2YWJpbGl0eTpcbiAgICogLSBJdGVyYXRlIGV4cGFuc2lvbiBpcyBsb2dnZWQgdG8gc3RkZXJyIHdpdGggaXRlbSBjb3VudCBhbmQgcGFyZW50IHN0ZXAgSUQuXG4gICAqIC0gTWlzc2luZyBzb3VyY2UgYXJ0aWZhY3RzIHRocm93IHdpdGggdGhlIGZ1bGwgcmVzb2x2ZWQgcGF0aCBmb3IgZGlhZ25vc2lzLlxuICAgKiAtIFplcm8tbWF0Y2ggZXhwYW5zaW9ucyByZXR1cm4gYSBzdG9wIGFjdGlvbiB3aXRoIGxldmVsIFwiaW5mb1wiLlxuICAgKiAtIEV4cGFuZGVkIEdSQVBILnlhbWwgaXMgd3JpdHRlbiB0byBkaXNrIGJlZm9yZSBkaXNwYXRjaCBcdTIwMTQgaW5zcGVjdGFibGUgb24gZGlzay5cbiAgICovXG4gIGFzeW5jIHJlc29sdmVEaXNwYXRjaChcbiAgICBzdGF0ZTogRW5naW5lU3RhdGUsXG4gICAgX2NvbnRleHQ6IHsgYmFzZVBhdGg6IHN0cmluZyB9LFxuICApOiBQcm9taXNlPEVuZ2luZURpc3BhdGNoQWN0aW9uPiB7XG4gICAgY29uc3QgZ3JhcGhQYXRoID0gam9pbih0aGlzLnJ1bkRpciwgXCJHUkFQSC55YW1sXCIpO1xuXG4gICAgcmV0dXJuIGF3YWl0IHdpdGhGaWxlTG9jayhncmFwaFBhdGgsICgpID0+IHtcbiAgICAgIGxldCBncmFwaCA9IHJlYWRHcmFwaCh0aGlzLnJ1bkRpcik7XG4gICAgICBjb25zdCBhY3RpdmUgPSBncmFwaC5zdGVwcy5maW5kKChzdGVwKSA9PiBzdGVwLnN0YXR1cyA9PT0gXCJhY3RpdmVcIik7XG4gICAgICBpZiAoYWN0aXZlKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsXG4gICAgICAgICAgc3RlcDoge1xuICAgICAgICAgICAgdW5pdFR5cGU6IFwiY3VzdG9tLXN0ZXBcIixcbiAgICAgICAgICAgIHVuaXRJZDogYCR7Z3JhcGgubWV0YWRhdGEubmFtZX0vJHthY3RpdmUuaWR9YCxcbiAgICAgICAgICAgIHByb21wdDogaW5qZWN0Q29udGV4dCh0aGlzLnJ1bkRpciwgYWN0aXZlLmlkLCBhY3RpdmUucHJvbXB0KSxcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBsZXQgbmV4dCA9IGdldE5leHRQZW5kaW5nU3RlcChncmFwaCk7XG5cbiAgICAgIGlmICghbmV4dCkge1xuICAgICAgICBjb25zdCBhbGxEb25lID0gZ3JhcGguc3RlcHMuZXZlcnkoXG4gICAgICAgICAgKHN0ZXApID0+IHN0ZXAuc3RhdHVzID09PSBcImNvbXBsZXRlXCIgfHwgc3RlcC5zdGF0dXMgPT09IFwiZXhwYW5kZWRcIixcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKCFhbGxEb25lKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGFjdGlvbjogXCJzdG9wXCIsXG4gICAgICAgICAgICByZWFzb246IGZvcm1hdEJsb2NrZWRXb3JrZmxvd1JlYXNvbihncmFwaCksXG4gICAgICAgICAgICBsZXZlbDogXCJlcnJvclwiLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBhY3Rpb246IFwic3RvcFwiLFxuICAgICAgICAgIHJlYXNvbjogXCJBbGwgc3RlcHMgY29tcGxldGVcIixcbiAgICAgICAgICBsZXZlbDogXCJpbmZvXCIsXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vIENoZWNrIGZyb3plbiBERUZJTklUSU9OLnlhbWwgZm9yIGl0ZXJhdGUgY29uZmlnIG9uIHRoaXMgc3RlcFxuICAgICAgY29uc3QgZGVmID0gcmVhZEZyb3plbkRlZmluaXRpb24odGhpcy5ydW5EaXIpO1xuICAgICAgY29uc3Qgc3RlcERlZiA9IGRlZi5zdGVwcy5maW5kKChzOiBTdGVwRGVmaW5pdGlvbikgPT4gcy5pZCA9PT0gbmV4dCEuaWQpO1xuXG4gICAgICBpZiAoc3RlcERlZj8uaXRlcmF0ZSkge1xuICAgICAgICBjb25zdCBpdGVyYXRlID0gc3RlcERlZi5pdGVyYXRlO1xuXG4gICAgICAgIC8vIFJlYWQgc291cmNlIGFydGlmYWN0XG4gICAgICAgIGNvbnN0IHNvdXJjZVBhdGggPSBqb2luKHRoaXMucnVuRGlyLCBpdGVyYXRlLnNvdXJjZSk7XG4gICAgICAgIGxldCBzb3VyY2VDb250ZW50OiBzdHJpbmc7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgc291cmNlQ29udGVudCA9IHJlYWRGaWxlU3luYyhzb3VyY2VQYXRoLCBcInV0Zi04XCIpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgSXRlcmF0ZSBzb3VyY2UgYXJ0aWZhY3Qgbm90IGZvdW5kOiAke3NvdXJjZVBhdGh9IChzdGVwIFwiJHtuZXh0LmlkfVwiLCBzb3VyY2U6IFwiJHtpdGVyYXRlLnNvdXJjZX1cIilgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBFeHRyYWN0IGl0ZW1zIHZpYSByZWdleCB3aXRoIGdsb2JhbCttdWx0aWxpbmUgZmxhZ3MuXG4gICAgICAgIC8vIEd1YXJkIGFnYWluc3QgUmVEb1M6IGlmIG1hdGNoaW5nIHRha2VzIHRvbyBsb25nIG9uIGxhcmdlIGlucHV0cywgYmFpbC5cbiAgICAgICAgY29uc3QgcmVnZXggPSBuZXcgUmVnRXhwKGl0ZXJhdGUucGF0dGVybiwgXCJnbVwiKTtcbiAgICAgICAgY29uc3QgaXRlbXM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGNvbnN0IG1hdGNoU3RhcnQgPSBEYXRlLm5vdygpO1xuICAgICAgICBsZXQgbWF0Y2g6IFJlZ0V4cEV4ZWNBcnJheSB8IG51bGw7XG4gICAgICAgIHdoaWxlICgobWF0Y2ggPSByZWdleC5leGVjKHNvdXJjZUNvbnRlbnQpKSAhPT0gbnVsbCkge1xuICAgICAgICAgIGlmIChtYXRjaFsxXSAhPT0gdW5kZWZpbmVkKSBpdGVtcy5wdXNoKG1hdGNoWzFdKTtcbiAgICAgICAgICBpZiAoRGF0ZS5ub3coKSAtIG1hdGNoU3RhcnQgPiA1XzAwMCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICBgSXRlcmF0ZSBwYXR0ZXJuIFwiJHtpdGVyYXRlLnBhdHRlcm59XCIgZXhjZWVkZWQgNXMgdGltZW91dCBvbiBzdGVwIFwiJHtuZXh0LmlkfVwiIFx1MjAxNCBwb3NzaWJsZSBSZURvU2AsXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEV4cGFuZCB0aGUgZ3JhcGhcbiAgICAgICAgY29uc3QgZXhwYW5kZWRHcmFwaCA9IGV4cGFuZEl0ZXJhdGlvbihncmFwaCwgbmV4dC5pZCwgaXRlbXMsIG5leHQucHJvbXB0KTtcbiAgICAgICAgd3JpdGVHcmFwaCh0aGlzLnJ1bkRpciwgZXhwYW5kZWRHcmFwaCk7XG4gICAgICAgIGdyYXBoID0gZXhwYW5kZWRHcmFwaDtcblxuICAgICAgICAvLyBSZS1xdWVyeSBmb3IgZmlyc3QgaW5zdGFuY2Ugc3RlcFxuICAgICAgICBuZXh0ID0gZ2V0TmV4dFBlbmRpbmdTdGVwKGV4cGFuZGVkR3JhcGgpO1xuXG4gICAgICAgIGlmICghbmV4dCkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBhY3Rpb246IFwic3RvcFwiLFxuICAgICAgICAgICAgcmVhc29uOiBcIkl0ZXJhdGUgZXhwYW5zaW9uIHByb2R1Y2VkIG5vIGluc3RhbmNlc1wiLFxuICAgICAgICAgICAgbGV2ZWw6IFwiaW5mb1wiLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgY29uc3QgYWN0aXZlR3JhcGggPSBtYXJrU3RlcEFjdGl2ZShncmFwaCwgbmV4dC5pZCk7XG4gICAgICB3cml0ZUdyYXBoKHRoaXMucnVuRGlyLCBhY3RpdmVHcmFwaCk7XG5cbiAgICAgIGNvbnN0IGFjdGl2ZVN0ZXAgPSBhY3RpdmVHcmFwaC5zdGVwcy5maW5kKChzKSA9PiBzLmlkID09PSBuZXh0LmlkKTtcbiAgICAgIGlmICghYWN0aXZlU3RlcCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFjdGl2ZSBzdGVwIG5vdCBmb3VuZCBhZnRlciBHUkFQSC55YW1sIHVwZGF0ZTogJHtuZXh0LmlkfWApO1xuICAgICAgfVxuXG4gICAgICAvLyBFbnJpY2ggcHJvbXB0IHdpdGggY29udGV4dCBmcm9tIHByaW9yIHN0ZXAgYXJ0aWZhY3RzXG4gICAgICBjb25zdCBlbnJpY2hlZFByb21wdCA9IGluamVjdENvbnRleHQodGhpcy5ydW5EaXIsIGFjdGl2ZVN0ZXAuaWQsIGFjdGl2ZVN0ZXAucHJvbXB0KTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsXG4gICAgICAgIHN0ZXA6IHtcbiAgICAgICAgICB1bml0VHlwZTogXCJjdXN0b20tc3RlcFwiLFxuICAgICAgICAgIHVuaXRJZDogYCR7YWN0aXZlR3JhcGgubWV0YWRhdGEubmFtZX0vJHthY3RpdmVTdGVwLmlkfWAsXG4gICAgICAgICAgcHJvbXB0OiBlbnJpY2hlZFByb21wdCxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogUmVjb25jaWxlIHN0YXRlIGFmdGVyIGEgc3RlcCBjb21wbGV0ZXMuXG4gICAqXG4gICAqIEV4dHJhY3RzIHRoZSBzdGVwSWQgZnJvbSB0aGUgY29tcGxldGVkU3RlcCdzIHVuaXRJZCAobGFzdCBzZWdtZW50IGFmdGVyIGAvYCksXG4gICAqIG1hcmtzIGl0IGNvbXBsZXRlIGluIHRoZSBncmFwaCwgYW5kIHdyaXRlcyB0aGUgdXBkYXRlZCBHUkFQSC55YW1sIHRvIGRpc2suXG4gICAqXG4gICAqIFJldHVybnMgXCJtaWxlc3RvbmUtY29tcGxldGVcIiB3aGVuIGFsbCBzdGVwcyBhcmUgbm93IGRvbmUsIFwiY29udGludWVcIiBvdGhlcndpc2UuXG4gICAqL1xuICBhc3luYyByZWNvbmNpbGUoXG4gICAgc3RhdGU6IEVuZ2luZVN0YXRlLFxuICAgIGNvbXBsZXRlZFN0ZXA6IENvbXBsZXRlZFN0ZXAsXG4gICk6IFByb21pc2U8UmVjb25jaWxlUmVzdWx0PiB7XG4gICAgY29uc3QgZ3JhcGhQYXRoID0gam9pbih0aGlzLnJ1bkRpciwgXCJHUkFQSC55YW1sXCIpO1xuXG4gICAgcmV0dXJuIGF3YWl0IHdpdGhGaWxlTG9jayhncmFwaFBhdGgsICgpID0+IHtcbiAgICAgIC8vIFJlLXJlYWQgdGhlIGdyYXBoIGZyb20gZGlzayBzbyB3ZSBkbyBub3Qgb3ZlcndyaXRlIGNvbmN1cnJlbnRcbiAgICAgIC8vIHdvcmtmbG93IGVkaXRzIHdpdGggYSBzdGFsZSBpbi1tZW1vcnkgc25hcHNob3QgZnJvbSBkZXJpdmVTdGF0ZSgpLlxuICAgICAgY29uc3QgZ3JhcGggPSByZWFkR3JhcGgodGhpcy5ydW5EaXIpO1xuXG4gICAgICAvLyBFeHRyYWN0IHN0ZXBJZCBmcm9tIFwiPHdvcmtmbG93TmFtZT4vPHN0ZXBJZD5cIlxuICAgICAgY29uc3QgeyBtaWxlc3RvbmUsIHNsaWNlLCB0YXNrIH0gPSBwYXJzZVVuaXRJZChjb21wbGV0ZWRTdGVwLnVuaXRJZCk7XG4gICAgICBjb25zdCBzdGVwSWQgPSB0YXNrID8/IHNsaWNlID8/IG1pbGVzdG9uZTtcblxuICAgICAgY29uc3QgdXBkYXRlZEdyYXBoID0gbWFya1N0ZXBDb21wbGV0ZShncmFwaCwgc3RlcElkKTtcbiAgICAgIHdyaXRlR3JhcGgodGhpcy5ydW5EaXIsIHVwZGF0ZWRHcmFwaCk7XG5cbiAgICAgIGNvbnN0IGFsbERvbmUgPSB1cGRhdGVkR3JhcGguc3RlcHMuZXZlcnkoXG4gICAgICAgIChzKSA9PiBzLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiIHx8IHMuc3RhdHVzID09PSBcImV4cGFuZGVkXCIsXG4gICAgICApO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBvdXRjb21lOiBhbGxEb25lID8gXCJtaWxlc3RvbmUtY29tcGxldGVcIiA6IFwiY29udGludWVcIixcbiAgICAgIH07XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJuIFVJLWZhY2luZyBtZXRhZGF0YSBmb3IgcHJvZ3Jlc3MgZGlzcGxheS5cbiAgICpcbiAgICogU2hvd3MgXCJTdGVwIE4vTVwiIHByb2dyZXNzIHdoZXJlIE4gPSBjb21wbGV0ZWQgY291bnQgYW5kIE0gPSB0b3RhbC5cbiAgICovXG4gIGdldERpc3BsYXlNZXRhZGF0YShzdGF0ZTogRW5naW5lU3RhdGUpOiBEaXNwbGF5TWV0YWRhdGEge1xuICAgIGNvbnN0IGdyYXBoID0gc3RhdGUucmF3IGFzIFdvcmtmbG93R3JhcGg7XG4gICAgY29uc3QgdG90YWwgPSBncmFwaC5zdGVwcy5sZW5ndGg7XG4gICAgY29uc3QgY29tcGxldGVkID0gZ3JhcGguc3RlcHMuZmlsdGVyKChzKSA9PiBzLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiKS5sZW5ndGg7XG5cbiAgICByZXR1cm4ge1xuICAgICAgZW5naW5lTGFiZWw6IFwiV09SS0ZMT1dcIixcbiAgICAgIGN1cnJlbnRQaGFzZTogc3RhdGUucGhhc2UsXG4gICAgICBwcm9ncmVzc1N1bW1hcnk6IGBTdGVwICR7Y29tcGxldGVkfS8ke3RvdGFsfWAsXG4gICAgICBzdGVwQ291bnQ6IHsgY29tcGxldGVkLCB0b3RhbCB9LFxuICAgIH07XG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQXNCQSxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLFlBQVk7QUFDckI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFB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QUFPLEtBQUssRUFBRTtBQUNqRCxpQkFBVyxLQUFLLFFBQVEsV0FBVztBQUVuQyxZQUFNLGFBQWEsWUFBWSxNQUFNLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxLQUFLLEVBQUU7QUFDakUsVUFBSSxDQUFDLFlBQVk7QUFDZixjQUFNLElBQUksTUFBTSxrREFBa0QsS0FBSyxFQUFFLEVBQUU7QUFBQSxNQUM3RTtBQUdBLFlBQU0saUJBQWlCLGNBQWMsS0FBSyxRQUFRLFdBQVcsSUFBSSxXQUFXLE1BQU07QUFFbEYsYUFBTztBQUFBLFFBQ0wsUUFBUTtBQUFBLFFBQ1IsTUFBTTtBQUFBLFVBQ0osVUFBVTtBQUFBLFVBQ1YsUUFBUSxHQUFHLFlBQVksU0FBUyxJQUFJLElBQUksV0FBVyxFQUFFO0FBQUEsVUFDckQsUUFBUTtBQUFBLFFBQ1Y7QUFBQSxNQUNGO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSDtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQVVBLE1BQU0sVUFDSixPQUNBLGVBQzBCO0FBQzFCLFVBQU0sWUFBWSxLQUFLLEtBQUssUUFBUSxZQUFZO0FBRWhELFdBQU8sTUFBTSxhQUFhLFdBQVcsTUFBTTtBQUd6QyxZQUFNLFFBQVEsVUFBVSxLQUFLLE1BQU07QUFHbkMsWUFBTSxFQUFFLFdBQVcsT0FBTyxLQUFLLElBQUksWUFBWSxjQUFjLE1BQU07QUFDbkUsWUFBTSxTQUFTLFFBQVEsU0FBUztBQUVoQyxZQUFNLGVBQWUsaUJBQWlCLE9BQU8sTUFBTTtBQUNuRCxpQkFBVyxLQUFLLFFBQVEsWUFBWTtBQUVwQyxZQUFNLFVBQVUsYUFBYSxNQUFNO0FBQUEsUUFDakMsQ0FBQyxNQUFNLEVBQUUsV0FBVyxjQUFjLEVBQUUsV0FBVztBQUFBLE1BQ2pEO0FBRUEsYUFBTztBQUFBLFFBQ0wsU0FBUyxVQUFVLHVCQUF1QjtBQUFBLE1BQzVDO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSDtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU9BLG1CQUFtQixPQUFxQztBQUN0RCxVQUFNLFFBQVEsTUFBTTtBQUNwQixVQUFNLFFBQVEsTUFBTSxNQUFNO0FBQzFCLFVBQU0sWUFBWSxNQUFNLE1BQU0sT0FBTyxDQUFDLE1BQU0sRUFBRSxXQUFXLFVBQVUsRUFBRTtBQUVyRSxXQUFPO0FBQUEsTUFDTCxhQUFhO0FBQUEsTUFDYixjQUFjLE1BQU07QUFBQSxNQUNwQixpQkFBaUIsUUFBUSxTQUFTLElBQUksS0FBSztBQUFBLE1BQzNDLFdBQVcsRUFBRSxXQUFXLE1BQU07QUFBQSxJQUNoQztBQUFBLEVBQ0Y7QUFDRjsiLAogICJuYW1lcyI6IFsicmVhZEZyb3plbkRlZmluaXRpb24iXQp9Cg==
