import { mkdirSync, writeFileSync } from "node:fs";
import { resolveSlicePath, resolveMilestoneFile } from "./paths.js";
import { parseUnitId } from "./unit-id.js";
import { isDbAvailable, getTask, getSliceTasks, getMilestoneSlices } from "./gsd-db.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { extractVerdict } from "./verdict-parser.js";
import { isClosedStatus } from "./status-guards.js";
import { loadFile } from "./files.js";
import { parseRoadmap } from "./parsers-legacy.js";
import { isMilestoneComplete } from "./state.js";
import {
  runVerificationGate,
  formatFailureContext,
  captureRuntimeErrors,
  runDependencyAudit
} from "./verification-gate.js";
import { writeVerificationJSON } from "./verification-evidence.js";
import { logWarning } from "./workflow-logger.js";
import { runPostExecutionChecks } from "./post-execution-checks.js";
import { join } from "node:path";
import { resolveUokFlags } from "./uok/flags.js";
import { UokGateRunner } from "./uok/gate-runner.js";
import { verificationRetryKey } from "./auto/verification-retry-policy.js";
import { decideVerificationVerdict } from "./verification-verdict.js";
async function runValidateMilestonePostCheck(vctx, pauseAuto) {
  const { s, ctx, pi } = vctx;
  const prefs = loadEffectiveGSDPreferences()?.preferences;
  const uokFlags = resolveUokFlags(prefs);
  const persistMilestoneValidationGate = async (outcome, failureClass, rationale, findings = "", milestoneId) => {
    if (!uokFlags.gates || !s.currentUnit) return;
    const gateRunner = new UokGateRunner();
    gateRunner.register({
      id: "milestone-validation-post-check",
      type: "verification",
      execute: async () => ({
        outcome,
        failureClass,
        rationale,
        findings
      })
    });
    await gateRunner.run("milestone-validation-post-check", {
      basePath: s.basePath,
      traceId: `validation-post-check:${s.currentUnit.id}`,
      turnId: s.currentUnit.id,
      milestoneId,
      unitType: s.currentUnit.type,
      unitId: s.currentUnit.id
    });
  };
  if (!s.currentUnit) return "continue";
  const { milestone: mid } = parseUnitId(s.currentUnit.id);
  if (!mid) return "continue";
  const validationFile = resolveMilestoneFile(s.basePath, mid, "VALIDATION");
  if (!validationFile) return "continue";
  const validationContent = await loadFile(validationFile);
  if (!validationContent) return "continue";
  const verdict = extractVerdict(validationContent);
  if (verdict !== "needs-remediation") {
    await persistMilestoneValidationGate(
      "pass",
      "none",
      `milestone validation verdict is ${verdict}; no remediation loop risk`,
      "",
      mid
    );
    return "continue";
  }
  const incompleteSliceCount = await countIncompleteSlices(s.basePath, mid);
  if (incompleteSliceCount > 0) {
    await persistMilestoneValidationGate(
      "pass",
      "none",
      `remediation slices present (${incompleteSliceCount}); validation can continue`,
      "",
      mid
    );
    return "continue";
  }
  ctx.ui.notify(
    `Milestone ${mid} validation returned verdict=needs-remediation but no remediation slices were added. Pausing for human review.`,
    "error"
  );
  process.stderr.write(
    `validate-milestone: pausing \u2014 verdict=needs-remediation with no incomplete slices for ${mid}. The agent must call gsd_reassess_roadmap to add remediation slices before re-validation.
`
  );
  await persistMilestoneValidationGate(
    "manual-attention",
    "manual-attention",
    "needs-remediation verdict without queued remediation slices",
    `No incomplete slices found for ${mid} while verdict=needs-remediation`,
    mid
  );
  await pauseAuto(ctx, pi);
  return "pause";
}
async function countIncompleteSlices(basePath, milestoneId) {
  if (isDbAvailable()) {
    const slices = getMilestoneSlices(milestoneId);
    if (slices.length === 0) {
      return 1;
    }
    return slices.filter((slice) => !isClosedStatus(slice.status)).length;
  }
  try {
    const roadmapFile = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
    if (!roadmapFile) return 1;
    const roadmapContent = await loadFile(roadmapFile);
    if (!roadmapContent) return 1;
    const roadmap = parseRoadmap(roadmapContent);
    if (roadmap.slices.length === 0) return 1;
    return isMilestoneComplete(roadmap) ? 0 : 1;
  } catch {
    return 1;
  }
}
async function runPostUnitVerification(vctx, pauseAuto) {
  const { s, ctx, pi } = vctx;
  if (!s.currentUnit) {
    return "continue";
  }
  if (s.currentUnit.type === "validate-milestone") {
    return await runValidateMilestonePostCheck(vctx, pauseAuto);
  }
  if (s.currentUnit.type !== "execute-task") {
    return "continue";
  }
  try {
    const effectivePrefs = loadEffectiveGSDPreferences();
    const prefs = effectivePrefs?.preferences;
    const uokFlags = resolveUokFlags(prefs);
    const { milestone: mid, slice: sid, task: tid } = parseUnitId(s.currentUnit.id);
    let taskPlanVerify;
    if (mid && sid && tid) {
      if (isDbAvailable()) {
        taskPlanVerify = getTask(mid, sid, tid)?.verify;
      }
    }
    const result = runVerificationGate({
      cwd: s.basePath,
      preferenceCommands: prefs?.verification_commands,
      taskPlanVerify
    });
    const runtimeErrors = await captureRuntimeErrors();
    if (runtimeErrors.length > 0) {
      result.runtimeErrors = runtimeErrors;
      if (runtimeErrors.some((e) => e.blocking)) {
        result.passed = false;
      }
    }
    const auditWarnings = runDependencyAudit(s.basePath);
    if (auditWarnings.length > 0) {
      result.auditWarnings = auditWarnings;
      process.stderr.write(
        `verification-gate: ${auditWarnings.length} audit warning(s)
`
      );
      for (const w of auditWarnings) {
        process.stderr.write(`  [${w.severity}] ${w.name}: ${w.title}
`);
      }
    }
    const verdict = decideVerificationVerdict(s.currentUnit.type, result);
    if (!verdict.passed) {
      result.passed = false;
    }
    if (uokFlags.gates) {
      const gateRunner = new UokGateRunner();
      gateRunner.register({
        id: "verification-gate",
        type: "verification",
        execute: async () => ({
          outcome: result.passed ? "pass" : "fail",
          failureClass: result.runtimeErrors?.some((e) => e.blocking) ? "execution" : "verification",
          rationale: result.passed ? "verification checks passed" : verdict.reason === "no-host-checks" ? "no runnable host-owned verification checks discovered" : "verification checks failed",
          findings: result.passed ? "" : verdict.failureContext || formatFailureContext(result)
        })
      });
      await gateRunner.run("verification-gate", {
        basePath: s.basePath,
        traceId: `verification:${s.currentUnit.id}`,
        turnId: s.currentUnit.id,
        milestoneId: mid ?? void 0,
        sliceId: sid ?? void 0,
        taskId: tid ?? void 0,
        unitType: s.currentUnit.type,
        unitId: s.currentUnit.id
      });
    }
    const autoFixEnabled = prefs?.verification_auto_fix !== false;
    const maxRetries = typeof prefs?.verification_max_retries === "number" ? prefs.verification_max_retries : 2;
    if (result.checks.length > 0) {
      const passCount = result.checks.filter((c) => c.exitCode === 0).length;
      const total = result.checks.length;
      if (result.passed) {
        ctx.ui.notify(`Verification gate: ${passCount}/${total} checks passed`);
      } else {
        const failures = result.checks.filter((c) => c.exitCode !== 0);
        const failNames = failures.map((f) => f.command).join(", ");
        ctx.ui.notify(`Verification gate: FAILED \u2014 ${failNames}`);
        process.stderr.write(
          `verification-gate: ${total - passCount}/${total} checks failed
`
        );
        for (const f of failures) {
          process.stderr.write(`  ${f.command} exited ${f.exitCode}
`);
          if (f.stderr)
            process.stderr.write(`  stderr: ${f.stderr.slice(0, 500)}
`);
        }
      }
    }
    if (result.runtimeErrors?.some((e) => e.blocking)) {
      const blockingErrors = result.runtimeErrors.filter((e) => e.blocking);
      process.stderr.write(
        `verification-gate: ${blockingErrors.length} blocking runtime error(s) detected
`
      );
      for (const err of blockingErrors) {
        process.stderr.write(
          `  [${err.source}] ${err.severity}: ${err.message.slice(0, 200)}
`
        );
      }
    }
    const retryKey = verificationRetryKey(s.currentUnit.type, s.currentUnit.id);
    const attempt = s.verificationRetryCount.get(retryKey) ?? 0;
    if (mid && sid && tid) {
      try {
        const sDir = resolveSlicePath(s.basePath, mid, sid);
        if (sDir) {
          const tasksDir = join(sDir, "tasks");
          if (result.passed) {
            writeVerificationJSON(result, tasksDir, tid, s.currentUnit.id);
          } else {
            const nextAttempt = attempt + 1;
            const includeRetryMetadata = !result.passed && verdict.retryable && autoFixEnabled && nextAttempt <= maxRetries;
            writeVerificationJSON(
              result,
              tasksDir,
              tid,
              s.currentUnit.id,
              includeRetryMetadata ? nextAttempt : void 0,
              includeRetryMetadata ? maxRetries : void 0
            );
          }
        }
      } catch (evidenceErr) {
        logWarning("engine", `verification-evidence write error: ${evidenceErr.message}`);
      }
    }
    let postExecChecks;
    let postExecBlockingFailure = false;
    if (result.passed && mid && sid && tid) {
      const enhancedEnabled = prefs?.enhanced_verification !== false;
      const postEnabled = prefs?.enhanced_verification_post !== false;
      if (enhancedEnabled && postEnabled && isDbAvailable()) {
        try {
          const taskRow = getTask(mid, sid, tid);
          if (taskRow && taskRow.key_files && taskRow.key_files.length > 0) {
            const allTasks = getSliceTasks(mid, sid);
            const priorTasks = allTasks.filter(
              (t) => (t.status === "complete" || t.status === "done") && t.id !== tid && t.sequence < taskRow.sequence
            );
            const postExecResult = runPostExecutionChecks(
              taskRow,
              priorTasks,
              s.basePath
            );
            postExecChecks = postExecResult.checks;
            const emoji = postExecResult.status === "pass" ? "\u2705" : postExecResult.status === "warn" ? "\u26A0\uFE0F" : "\u274C";
            process.stderr.write(
              `gsd-post-exec: ${emoji} Post-execution checks ${postExecResult.status} for ${mid}/${sid}/${tid} (${postExecResult.durationMs}ms)
`
            );
            for (const check of postExecResult.checks) {
              const checkEmoji = check.passed ? "\u2713" : check.blocking ? "\u2717" : "\u26A0";
              process.stderr.write(
                `gsd-post-exec:   ${checkEmoji} [${check.category}] ${check.target}: ${check.message}
`
              );
            }
            if (uokFlags.gates) {
              const strictMode = prefs?.enhanced_verification_strict === true;
              const warnEscalated = postExecResult.status === "warn" && strictMode;
              const blockingFailure = postExecResult.status === "fail" || warnEscalated;
              const findings = postExecResult.checks.filter((check) => !check.passed).map((check) => `[${check.category}] ${check.target}: ${check.message}`).join("\n");
              const gateRunner = new UokGateRunner();
              gateRunner.register({
                id: "post-execution-checks",
                type: "artifact",
                execute: async () => ({
                  outcome: blockingFailure ? "fail" : "pass",
                  failureClass: postExecResult.status === "fail" ? "artifact" : warnEscalated ? "policy" : "none",
                  rationale: blockingFailure ? `post-execution checks ${postExecResult.status}${warnEscalated ? " (strict)" : ""}` : "post-execution checks passed",
                  findings
                })
              });
              await gateRunner.run("post-execution-checks", {
                basePath: s.basePath,
                traceId: `verification:${s.currentUnit.id}`,
                turnId: s.currentUnit.id,
                milestoneId: mid,
                sliceId: sid,
                taskId: tid,
                unitType: s.currentUnit.type,
                unitId: s.currentUnit.id
              });
            }
            if (postExecResult.status === "fail") {
              postExecBlockingFailure = true;
              const blockingCount = postExecResult.checks.filter(
                (c) => !c.passed && c.blocking
              ).length;
              ctx.ui.notify(
                `Post-execution checks failed: ${blockingCount} blocking issue${blockingCount === 1 ? "" : "s"} found`,
                "error"
              );
            } else if (postExecResult.status === "warn") {
              ctx.ui.notify(
                `Post-execution checks passed with warnings`,
                "warning"
              );
              if (prefs?.enhanced_verification_strict === true) {
                postExecBlockingFailure = true;
              }
            }
          }
        } catch (postExecErr) {
          logWarning("engine", `gsd-post-exec: error \u2014 ${postExecErr.message}`);
        }
      }
    }
    if (postExecChecks && postExecChecks.length > 0 && mid && sid && tid) {
      try {
        const sDir = resolveSlicePath(s.basePath, mid, sid);
        if (sDir) {
          const tasksDir = join(sDir, "tasks");
          const resultWithPostExec = {
            ...result,
            // Mark as failed if there was a blocking post-exec failure
            passed: result.passed && !postExecBlockingFailure
          };
          writeVerificationJSONWithPostExec(
            resultWithPostExec,
            tasksDir,
            tid,
            s.currentUnit.id,
            postExecChecks,
            postExecBlockingFailure ? attempt + 1 : void 0,
            postExecBlockingFailure ? maxRetries : void 0
          );
        }
      } catch (evidenceErr) {
        logWarning("engine", `verification-evidence: post-exec write error \u2014 ${evidenceErr.message}`);
      }
    }
    if (postExecBlockingFailure) {
      result.passed = false;
    }
    try {
      const { emitVerifyResult } = await import("./hook-emitter.js");
      const checkFailures = result.checks.filter((c) => c.exitCode !== 0).map((c) => ({
        kind: "gate",
        message: `${c.command} exited ${c.exitCode}${c.stderr ? `: ${c.stderr.slice(0, 200)}` : ""}`
      }));
      const runtimeFailures = (result.runtimeErrors ?? []).filter((e) => e.blocking).map((e) => ({
        kind: "other",
        message: `[${e.source}] ${e.message.slice(0, 200)}`
      }));
      const postExecFailures = (postExecChecks ?? []).filter((c) => !c.passed).map((c) => ({
        kind: "other",
        message: `[${c.category}] ${c.target}: ${c.message}`
      }));
      await emitVerifyResult({
        passed: result.passed,
        failures: [...checkFailures, ...runtimeFailures, ...postExecFailures],
        unitType: s.currentUnit.type,
        unitId: s.currentUnit.id,
        cwd: s.basePath
      });
    } catch (hookErr) {
      logWarning("engine", `verify_result hook emission failed: ${hookErr.message}`);
    }
    if (result.passed) {
      s.verificationRetryCount.delete(retryKey);
      s.verificationRetryFailureHashes.delete(retryKey);
      s.pendingVerificationRetry = null;
      return "continue";
    } else if (verdict.reason === "no-host-checks") {
      s.verificationRetryCount.delete(retryKey);
      s.verificationRetryFailureHashes.delete(retryKey);
      s.pendingVerificationRetry = null;
      ctx.ui.notify(
        "Verification gate FAILED \u2014 no runnable host-owned verification checks were discovered. Pausing for human review.",
        "error"
      );
      process.stderr.write(`verification-gate: ${verdict.failureContext}
`);
      await pauseAuto(ctx, pi);
      return "pause";
    } else if (postExecBlockingFailure) {
      s.verificationRetryCount.delete(retryKey);
      s.verificationRetryFailureHashes.delete(retryKey);
      s.pendingVerificationRetry = null;
      ctx.ui.notify(
        `Post-execution checks failed \u2014 cross-task consistency issue detected, pausing for human review`,
        "error"
      );
      await pauseAuto(ctx, pi);
      return "pause";
    } else if (autoFixEnabled && attempt + 1 <= maxRetries) {
      const nextAttempt = attempt + 1;
      s.verificationRetryCount.set(retryKey, nextAttempt);
      s.pendingVerificationRetry = {
        unitId: s.currentUnit.id,
        failureContext: verdict.failureContext || formatFailureContext(result),
        attempt: nextAttempt
      };
      const failedCmds = result.checks.filter((c) => c.exitCode !== 0).map((c) => c.command);
      const cmdSummary = failedCmds.length <= 3 ? failedCmds.join(", ") : `${failedCmds.slice(0, 3).join(", ")}... and ${failedCmds.length - 3} more`;
      ctx.ui.notify(
        `Verification failed (${cmdSummary}) \u2014 auto-fix attempt ${nextAttempt}/${maxRetries}`,
        "warning"
      );
      return "retry";
    } else {
      s.verificationRetryCount.delete(retryKey);
      s.verificationRetryFailureHashes.delete(retryKey);
      s.pendingVerificationRetry = null;
      const exhaustedFails = result.checks.filter((c) => c.exitCode !== 0).map((c) => c.command);
      const exhaustedSummary = exhaustedFails.length <= 3 ? exhaustedFails.join(", ") : `${exhaustedFails.slice(0, 3).join(", ")}... and ${exhaustedFails.length - 3} more`;
      ctx.ui.notify(
        `Verification gate FAILED after ${attempt} ${attempt === 1 ? "retry" : "retries"} (${exhaustedSummary}) \u2014 pausing for human review`,
        "error"
      );
      await pauseAuto(ctx, pi);
      return "pause";
    }
  } catch (err) {
    logWarning("engine", `verification-gate error: ${err.message}`);
    ctx.ui.notify(
      `Verification gate errored before producing an authoritative verdict: ${err.message}`,
      "error"
    );
    await pauseAuto(ctx, pi);
    return "pause";
  }
}
function writeVerificationJSONWithPostExec(result, tasksDir, taskId, unitId, postExecutionChecks, retryAttempt, maxRetries) {
  mkdirSync(tasksDir, { recursive: true });
  const evidence = {
    schemaVersion: 1,
    taskId,
    unitId: unitId ?? taskId,
    timestamp: result.timestamp,
    passed: result.passed,
    discoverySource: result.discoverySource,
    checks: result.checks.map((check) => ({
      command: check.command,
      exitCode: check.exitCode,
      durationMs: check.durationMs,
      verdict: check.exitCode === 0 ? "pass" : "fail"
    })),
    ...retryAttempt !== void 0 ? { retryAttempt } : {},
    ...maxRetries !== void 0 ? { maxRetries } : {},
    postExecutionChecks
  };
  if (result.runtimeErrors && result.runtimeErrors.length > 0) {
    evidence.runtimeErrors = result.runtimeErrors.map((e) => ({
      source: e.source,
      severity: e.severity,
      message: e.message,
      blocking: e.blocking
    }));
  }
  if (result.auditWarnings && result.auditWarnings.length > 0) {
    evidence.auditWarnings = result.auditWarnings.map((w) => ({
      name: w.name,
      severity: w.severity,
      title: w.title,
      url: w.url,
      fixAvailable: w.fixAvailable
    }));
  }
  const filePath = join(tasksDir, `${taskId}-VERIFY.json`);
  writeFileSync(filePath, JSON.stringify(evidence, null, 2) + "\n", "utf-8");
}
export {
  runPostUnitVerification
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLXZlcmlmaWNhdGlvbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFBvc3QtdW5pdCB2ZXJpZmljYXRpb24gZ2F0ZSBmb3IgR1NEIGF1dG8tbW9kZSB1bml0cy5cblxuLyoqXG4gKiBQb3N0LXVuaXQgdmVyaWZpY2F0aW9uIGdhdGUgZm9yIGF1dG8tbW9kZS5cbiAqXG4gKiBSdW5zIHR5cGVjaGVjay9saW50L3Rlc3QgY2hlY2tzLCBjYXB0dXJlcyBydW50aW1lIGVycm9ycywgcGVyZm9ybXNcbiAqIGRlcGVuZGVuY3kgYXVkaXRzLCBoYW5kbGVzIGF1dG8tZml4IHJldHJ5IGxvZ2ljLCBhbmQgd3JpdGVzXG4gKiB2ZXJpZmljYXRpb24gZXZpZGVuY2UgSlNPTi5cbiAqXG4gKiBFeHRyYWN0ZWQgZnJvbSB0aGUgcHJlLWxvb3AgYWdlbnRfZW5kIGhhbmRsZXIgaW4gYXV0by50cy4gUmV0dXJucyBhXG4gKiBzZW50aW5lbCB2YWx1ZSBpbnN0ZWFkIG9mIGNhbGxpbmcgcmV0dXJuL3BhdXNlQXV0byBkaXJlY3RseSBcdTIwMTQgdGhlXG4gKiBjYWxsZXIgY2hlY2tzIHRoZSByZXN1bHQgYW5kIGhhbmRsZXMgY29udHJvbCBmbG93LlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQ29udGV4dCwgRXh0ZW5zaW9uQVBJIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVNsaWNlRmlsZSwgcmVzb2x2ZVNsaWNlUGF0aCwgcmVzb2x2ZU1pbGVzdG9uZUZpbGUgfSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuaW1wb3J0IHsgcGFyc2VVbml0SWQgfSBmcm9tIFwiLi91bml0LWlkLmpzXCI7XG5pbXBvcnQgeyBpc0RiQXZhaWxhYmxlLCBnZXRUYXNrLCBnZXRTbGljZVRhc2tzLCBnZXRNaWxlc3RvbmVTbGljZXMgfSBmcm9tIFwiLi9nc2QtZGIuanNcIjtcbmltcG9ydCB0eXBlIHsgVGFza1JvdyB9IGZyb20gXCIuL2RiLXRhc2stc2xpY2Utcm93cy5qc1wiO1xuaW1wb3J0IHsgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzIH0gZnJvbSBcIi4vcHJlZmVyZW5jZXMuanNcIjtcbmltcG9ydCB7IGV4dHJhY3RWZXJkaWN0IH0gZnJvbSBcIi4vdmVyZGljdC1wYXJzZXIuanNcIjtcbmltcG9ydCB7IGlzQ2xvc2VkU3RhdHVzIH0gZnJvbSBcIi4vc3RhdHVzLWd1YXJkcy5qc1wiO1xuaW1wb3J0IHsgbG9hZEZpbGUgfSBmcm9tIFwiLi9maWxlcy5qc1wiO1xuaW1wb3J0IHsgcGFyc2VSb2FkbWFwIH0gZnJvbSBcIi4vcGFyc2Vycy1sZWdhY3kuanNcIjtcbmltcG9ydCB7IGlzTWlsZXN0b25lQ29tcGxldGUgfSBmcm9tIFwiLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHtcbiAgcnVuVmVyaWZpY2F0aW9uR2F0ZSxcbiAgZm9ybWF0RmFpbHVyZUNvbnRleHQsXG4gIGNhcHR1cmVSdW50aW1lRXJyb3JzLFxuICBydW5EZXBlbmRlbmN5QXVkaXQsXG59IGZyb20gXCIuL3ZlcmlmaWNhdGlvbi1nYXRlLmpzXCI7XG5pbXBvcnQgeyB3cml0ZVZlcmlmaWNhdGlvbkpTT04sIHR5cGUgUG9zdEV4ZWN1dGlvbkNoZWNrSlNPTiwgdHlwZSBFdmlkZW5jZUpTT04gfSBmcm9tIFwiLi92ZXJpZmljYXRpb24tZXZpZGVuY2UuanNcIjtcbmltcG9ydCB7IGxvZ1dhcm5pbmcgfSBmcm9tIFwiLi93b3JrZmxvdy1sb2dnZXIuanNcIjtcbmltcG9ydCB7IHJ1blBvc3RFeGVjdXRpb25DaGVja3MsIHR5cGUgUG9zdEV4ZWN1dGlvblJlc3VsdCB9IGZyb20gXCIuL3Bvc3QtZXhlY3V0aW9uLWNoZWNrcy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBBdXRvU2Vzc2lvbiB9IGZyb20gXCIuL2F1dG8vc2Vzc2lvbi5qc1wiO1xuaW1wb3J0IHR5cGUgeyBWZXJpZmljYXRpb25SZXN1bHQgYXMgVmVyaWZpY2F0aW9uR2F0ZVJlc3VsdCB9IGZyb20gXCIuL3R5cGVzLmpzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcmVzb2x2ZVVva0ZsYWdzIH0gZnJvbSBcIi4vdW9rL2ZsYWdzLmpzXCI7XG5pbXBvcnQgeyBVb2tHYXRlUnVubmVyIH0gZnJvbSBcIi4vdW9rL2dhdGUtcnVubmVyLmpzXCI7XG5pbXBvcnQgeyB2ZXJpZmljYXRpb25SZXRyeUtleSB9IGZyb20gXCIuL2F1dG8vdmVyaWZpY2F0aW9uLXJldHJ5LXBvbGljeS5qc1wiO1xuaW1wb3J0IHsgZGVjaWRlVmVyaWZpY2F0aW9uVmVyZGljdCB9IGZyb20gXCIuL3ZlcmlmaWNhdGlvbi12ZXJkaWN0LmpzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVmVyaWZpY2F0aW9uQ29udGV4dCB7XG4gIHM6IEF1dG9TZXNzaW9uO1xuICBjdHg6IEV4dGVuc2lvbkNvbnRleHQ7XG4gIHBpOiBFeHRlbnNpb25BUEk7XG59XG5cbmV4cG9ydCB0eXBlIFZlcmlmaWNhdGlvblJlc3VsdCA9IFwiY29udGludWVcIiB8IFwicmV0cnlcIiB8IFwicGF1c2VcIjtcblxuLyoqXG4gKiBQb3N0LXVuaXQgZ3VhcmQgZm9yIGB2YWxpZGF0ZS1taWxlc3RvbmVgIHVuaXRzICgjNDA5NCkuXG4gKlxuICogV2hlbiB2YWxpZGF0ZS1taWxlc3RvbmUgd3JpdGVzIHZlcmRpY3Q9bmVlZHMtcmVtZWRpYXRpb24sIHRoZSBhZ2VudCBpc1xuICogZXhwZWN0ZWQgdG8gYWxzbyBjYWxsIGdzZF9yZWFzc2Vzc19yb2FkbWFwIGluIHRoZSBzYW1lIHR1cm4gdG8gYWRkXG4gKiByZW1lZGlhdGlvbiBzbGljZXMuIElmIHRoZXkgZG9uJ3QsIHRoZSBzdGF0ZSBtYWNoaW5lIHJlLWRlcml2ZXNcbiAqIGBwaGFzZTogdmFsaWRhdGluZy1taWxlc3RvbmVgIGluZGVmaW5pdGVseSAoYWxsIHNsaWNlcyBzdGlsbCBjb21wbGV0ZSArXG4gKiB2ZXJkaWN0IHN0aWxsIG5lZWRzLXJlbWVkaWF0aW9uKSwgd2FzdGluZyB+MyBkaXNwYXRjaGVzIGJlZm9yZSB0aGUgc3R1Y2tcbiAqIGRldGVjdG9yIGZpcmVzLlxuICpcbiAqIFRoaXMgZ3VhcmQgZmlyZXMgaW1tZWRpYXRlbHkgb24gdGhlIGZpcnN0IG9jY3VycmVuY2U6IGlmIFZBTElEQVRJT04ubWRcbiAqIHZlcmRpY3QgaXMgbmVlZHMtcmVtZWRpYXRpb24gYW5kIG5vIGluY29tcGxldGUgc2xpY2VzIGV4aXN0IGZvciB0aGVcbiAqIG1pbGVzdG9uZSwgcGF1c2UgdGhlIGF1dG8tbG9vcCB3aXRoIGEgY2xlYXIgYmxvY2tlci5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcnVuVmFsaWRhdGVNaWxlc3RvbmVQb3N0Q2hlY2soXG4gIHZjdHg6IFZlcmlmaWNhdGlvbkNvbnRleHQsXG4gIHBhdXNlQXV0bzogKGN0eD86IEV4dGVuc2lvbkNvbnRleHQsIHBpPzogRXh0ZW5zaW9uQVBJKSA9PiBQcm9taXNlPHZvaWQ+LFxuKTogUHJvbWlzZTxWZXJpZmljYXRpb25SZXN1bHQ+IHtcbiAgY29uc3QgeyBzLCBjdHgsIHBpIH0gPSB2Y3R4O1xuICBjb25zdCBwcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcygpPy5wcmVmZXJlbmNlcztcbiAgY29uc3QgdW9rRmxhZ3MgPSByZXNvbHZlVW9rRmxhZ3MocHJlZnMpO1xuICBjb25zdCBwZXJzaXN0TWlsZXN0b25lVmFsaWRhdGlvbkdhdGUgPSBhc3luYyAoXG4gICAgb3V0Y29tZTogXCJwYXNzXCIgfCBcImZhaWxcIiB8IFwicmV0cnlcIiB8IFwibWFudWFsLWF0dGVudGlvblwiLFxuICAgIGZhaWx1cmVDbGFzczogXCJub25lXCIgfCBcInZlcmlmaWNhdGlvblwiIHwgXCJtYW51YWwtYXR0ZW50aW9uXCIsXG4gICAgcmF0aW9uYWxlOiBzdHJpbmcsXG4gICAgZmluZGluZ3MgPSBcIlwiLFxuICAgIG1pbGVzdG9uZUlkPzogc3RyaW5nLFxuICApOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICBpZiAoIXVva0ZsYWdzLmdhdGVzIHx8ICFzLmN1cnJlbnRVbml0KSByZXR1cm47XG4gICAgY29uc3QgZ2F0ZVJ1bm5lciA9IG5ldyBVb2tHYXRlUnVubmVyKCk7XG4gICAgZ2F0ZVJ1bm5lci5yZWdpc3Rlcih7XG4gICAgICBpZDogXCJtaWxlc3RvbmUtdmFsaWRhdGlvbi1wb3N0LWNoZWNrXCIsXG4gICAgICB0eXBlOiBcInZlcmlmaWNhdGlvblwiLFxuICAgICAgZXhlY3V0ZTogYXN5bmMgKCkgPT4gKHtcbiAgICAgICAgb3V0Y29tZSxcbiAgICAgICAgZmFpbHVyZUNsYXNzLFxuICAgICAgICByYXRpb25hbGUsXG4gICAgICAgIGZpbmRpbmdzLFxuICAgICAgfSksXG4gICAgfSk7XG4gICAgYXdhaXQgZ2F0ZVJ1bm5lci5ydW4oXCJtaWxlc3RvbmUtdmFsaWRhdGlvbi1wb3N0LWNoZWNrXCIsIHtcbiAgICAgIGJhc2VQYXRoOiBzLmJhc2VQYXRoLFxuICAgICAgdHJhY2VJZDogYHZhbGlkYXRpb24tcG9zdC1jaGVjazoke3MuY3VycmVudFVuaXQuaWR9YCxcbiAgICAgIHR1cm5JZDogcy5jdXJyZW50VW5pdC5pZCxcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgdW5pdFR5cGU6IHMuY3VycmVudFVuaXQudHlwZSxcbiAgICAgIHVuaXRJZDogcy5jdXJyZW50VW5pdC5pZCxcbiAgICB9KTtcbiAgfTtcblxuICBpZiAoIXMuY3VycmVudFVuaXQpIHJldHVybiBcImNvbnRpbnVlXCI7XG5cbiAgY29uc3QgeyBtaWxlc3RvbmU6IG1pZCB9ID0gcGFyc2VVbml0SWQocy5jdXJyZW50VW5pdC5pZCk7XG4gIGlmICghbWlkKSByZXR1cm4gXCJjb250aW51ZVwiO1xuXG4gIGNvbnN0IHZhbGlkYXRpb25GaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUocy5iYXNlUGF0aCwgbWlkLCBcIlZBTElEQVRJT05cIik7XG4gIGlmICghdmFsaWRhdGlvbkZpbGUpIHJldHVybiBcImNvbnRpbnVlXCI7XG5cbiAgY29uc3QgdmFsaWRhdGlvbkNvbnRlbnQgPSBhd2FpdCBsb2FkRmlsZSh2YWxpZGF0aW9uRmlsZSk7XG4gIGlmICghdmFsaWRhdGlvbkNvbnRlbnQpIHJldHVybiBcImNvbnRpbnVlXCI7XG5cbiAgY29uc3QgdmVyZGljdCA9IGV4dHJhY3RWZXJkaWN0KHZhbGlkYXRpb25Db250ZW50KTtcbiAgaWYgKHZlcmRpY3QgIT09IFwibmVlZHMtcmVtZWRpYXRpb25cIikge1xuICAgIGF3YWl0IHBlcnNpc3RNaWxlc3RvbmVWYWxpZGF0aW9uR2F0ZShcbiAgICAgIFwicGFzc1wiLFxuICAgICAgXCJub25lXCIsXG4gICAgICBgbWlsZXN0b25lIHZhbGlkYXRpb24gdmVyZGljdCBpcyAke3ZlcmRpY3R9OyBubyByZW1lZGlhdGlvbiBsb29wIHJpc2tgLFxuICAgICAgXCJcIixcbiAgICAgIG1pZCxcbiAgICApO1xuICAgIHJldHVybiBcImNvbnRpbnVlXCI7XG4gIH1cblxuICBjb25zdCBpbmNvbXBsZXRlU2xpY2VDb3VudCA9IGF3YWl0IGNvdW50SW5jb21wbGV0ZVNsaWNlcyhzLmJhc2VQYXRoLCBtaWQpO1xuXG4gIC8vIElmIGFueSBub24tY2xvc2VkIHNsaWNlcyBleGlzdCwgdGhlIGFnZW50IHN1Y2Nlc3NmdWxseSBxdWV1ZWQgcmVtZWRpYXRpb25cbiAgLy8gd29yayBcdTIwMTQgcHJvY2VlZCBub3JtYWxseS4gVGhlIHN0YXRlIG1hY2hpbmUgd2lsbCBleGVjdXRlIHRob3NlIHNsaWNlcyBhbmRcbiAgLy8gcmUtdmFsaWRhdGUgcGVyIHRoZSAjMzU5Ni8jMzY3MCBmaXguXG4gIGlmIChpbmNvbXBsZXRlU2xpY2VDb3VudCA+IDApIHtcbiAgICBhd2FpdCBwZXJzaXN0TWlsZXN0b25lVmFsaWRhdGlvbkdhdGUoXG4gICAgICBcInBhc3NcIixcbiAgICAgIFwibm9uZVwiLFxuICAgICAgYHJlbWVkaWF0aW9uIHNsaWNlcyBwcmVzZW50ICgke2luY29tcGxldGVTbGljZUNvdW50fSk7IHZhbGlkYXRpb24gY2FuIGNvbnRpbnVlYCxcbiAgICAgIFwiXCIsXG4gICAgICBtaWQsXG4gICAgKTtcbiAgICByZXR1cm4gXCJjb250aW51ZVwiO1xuICB9XG5cbiAgY3R4LnVpLm5vdGlmeShcbiAgICBgTWlsZXN0b25lICR7bWlkfSB2YWxpZGF0aW9uIHJldHVybmVkIHZlcmRpY3Q9bmVlZHMtcmVtZWRpYXRpb24gYnV0IG5vIHJlbWVkaWF0aW9uIHNsaWNlcyB3ZXJlIGFkZGVkLiBQYXVzaW5nIGZvciBodW1hbiByZXZpZXcuYCxcbiAgICBcImVycm9yXCIsXG4gICk7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgIGB2YWxpZGF0ZS1taWxlc3RvbmU6IHBhdXNpbmcgXHUyMDE0IHZlcmRpY3Q9bmVlZHMtcmVtZWRpYXRpb24gd2l0aCBubyBpbmNvbXBsZXRlIHNsaWNlcyBmb3IgJHttaWR9LiBgICtcbiAgICAgIGBUaGUgYWdlbnQgbXVzdCBjYWxsIGdzZF9yZWFzc2Vzc19yb2FkbWFwIHRvIGFkZCByZW1lZGlhdGlvbiBzbGljZXMgYmVmb3JlIHJlLXZhbGlkYXRpb24uXFxuYCxcbiAgKTtcbiAgYXdhaXQgcGVyc2lzdE1pbGVzdG9uZVZhbGlkYXRpb25HYXRlKFxuICAgIFwibWFudWFsLWF0dGVudGlvblwiLFxuICAgIFwibWFudWFsLWF0dGVudGlvblwiLFxuICAgIFwibmVlZHMtcmVtZWRpYXRpb24gdmVyZGljdCB3aXRob3V0IHF1ZXVlZCByZW1lZGlhdGlvbiBzbGljZXNcIixcbiAgICBgTm8gaW5jb21wbGV0ZSBzbGljZXMgZm91bmQgZm9yICR7bWlkfSB3aGlsZSB2ZXJkaWN0PW5lZWRzLXJlbWVkaWF0aW9uYCxcbiAgICBtaWQsXG4gICk7XG4gIGF3YWl0IHBhdXNlQXV0byhjdHgsIHBpKTtcbiAgcmV0dXJuIFwicGF1c2VcIjtcbn1cblxuLyoqXG4gKiBDb3VudCBzbGljZXMgZm9yIGEgbWlsZXN0b25lIHRoYXQgYXJlIG5vdCBpbiBhIGNsb3NlZCBzdGF0dXMuXG4gKiBEQi1iYWNrZWQgcHJvamVjdHMgYXJlIGF1dGhvcml0YXRpdmUgKCM0MDk0IHBlZXIgcmV2aWV3KTsgZmFsbHMgYmFjayB0b1xuICogcm9hZG1hcCBwYXJzaW5nIG9ubHkgd2hlbiB0aGUgREIgaXMgdW5hdmFpbGFibGUuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNvdW50SW5jb21wbGV0ZVNsaWNlcyhiYXNlUGF0aDogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgIGNvbnN0IHNsaWNlcyA9IGdldE1pbGVzdG9uZVNsaWNlcyhtaWxlc3RvbmVJZCk7XG4gICAgaWYgKHNsaWNlcy5sZW5ndGggPT09IDApIHtcbiAgICAgIC8vIE5vIERCIHJvd3MgXHUyMDE0IHRyZWF0IGFzIFwidW5rbm93blwiLCBkbyBub3QgcGF1c2UuXG4gICAgICByZXR1cm4gMTtcbiAgICB9XG4gICAgcmV0dXJuIHNsaWNlcy5maWx0ZXIoKHNsaWNlKSA9PiAhaXNDbG9zZWRTdGF0dXMoc2xpY2Uuc3RhdHVzKSkubGVuZ3RoO1xuICB9XG5cbiAgLy8gRmlsZXN5c3RlbSBmYWxsYmFjazogcGFyc2UgdGhlIHJvYWRtYXAgbWFya2Rvd24uXG4gIHRyeSB7XG4gICAgY29uc3Qgcm9hZG1hcEZpbGUgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIFwiUk9BRE1BUFwiKTtcbiAgICBpZiAoIXJvYWRtYXBGaWxlKSByZXR1cm4gMTtcbiAgICBjb25zdCByb2FkbWFwQ29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHJvYWRtYXBGaWxlKTtcbiAgICBpZiAoIXJvYWRtYXBDb250ZW50KSByZXR1cm4gMTtcbiAgICBjb25zdCByb2FkbWFwID0gcGFyc2VSb2FkbWFwKHJvYWRtYXBDb250ZW50KTtcbiAgICBpZiAocm9hZG1hcC5zbGljZXMubGVuZ3RoID09PSAwKSByZXR1cm4gMTtcbiAgICByZXR1cm4gaXNNaWxlc3RvbmVDb21wbGV0ZShyb2FkbWFwKSA/IDAgOiAxO1xuICB9IGNhdGNoIHtcbiAgICAvLyBQYXJzaW5nIGZhaWx1cmVzIHNob3VsZCBub3QgY2F1c2UgZmFsc2UtcG9zaXRpdmUgcGF1c2VzLlxuICAgIHJldHVybiAxO1xuICB9XG59XG5cbi8qKlxuICogUnVuIHRoZSB2ZXJpZmljYXRpb24gZ2F0ZSBmb3IgdGhlIGN1cnJlbnQgZXhlY3V0ZS10YXNrIHVuaXQuXG4gKiBSZXR1cm5zOlxuICogLSBcImNvbnRpbnVlXCIgXHUyMDE0IGhvc3Qtb3duZWQgdmVyaWZpY2F0aW9uIHBhc3NlZCwgcHJvY2VlZCBub3JtYWxseVxuICogLSBcInJldHJ5XCIgXHUyMDE0IGdhdGUgZmFpbGVkIHdpdGggcmV0cmllcyByZW1haW5pbmcsIHMucGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5IHNldCBmb3IgbG9vcCByZS1pdGVyYXRpb25cbiAqIC0gXCJwYXVzZVwiIFx1MjAxNCBnYXRlIGZhaWxlZCB3aXRoIHJldHJpZXMgZXhoYXVzdGVkLCBwYXVzZUF1dG8gYWxyZWFkeSBjYWxsZWRcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1blBvc3RVbml0VmVyaWZpY2F0aW9uKFxuICB2Y3R4OiBWZXJpZmljYXRpb25Db250ZXh0LFxuICBwYXVzZUF1dG86IChjdHg/OiBFeHRlbnNpb25Db250ZXh0LCBwaT86IEV4dGVuc2lvbkFQSSkgPT4gUHJvbWlzZTx2b2lkPixcbik6IFByb21pc2U8VmVyaWZpY2F0aW9uUmVzdWx0PiB7XG4gIGNvbnN0IHsgcywgY3R4LCBwaSB9ID0gdmN0eDtcblxuICBpZiAoIXMuY3VycmVudFVuaXQpIHtcbiAgICByZXR1cm4gXCJjb250aW51ZVwiO1xuICB9XG5cbiAgaWYgKHMuY3VycmVudFVuaXQudHlwZSA9PT0gXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIikge1xuICAgIHJldHVybiBhd2FpdCBydW5WYWxpZGF0ZU1pbGVzdG9uZVBvc3RDaGVjayh2Y3R4LCBwYXVzZUF1dG8pO1xuICB9XG5cbiAgaWYgKHMuY3VycmVudFVuaXQudHlwZSAhPT0gXCJleGVjdXRlLXRhc2tcIikge1xuICAgIHJldHVybiBcImNvbnRpbnVlXCI7XG4gIH1cblxuICB0cnkge1xuICAgIGNvbnN0IGVmZmVjdGl2ZVByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk7XG4gICAgY29uc3QgcHJlZnMgPSBlZmZlY3RpdmVQcmVmcz8ucHJlZmVyZW5jZXM7XG4gICAgY29uc3QgdW9rRmxhZ3MgPSByZXNvbHZlVW9rRmxhZ3MocHJlZnMpO1xuXG4gICAgLy8gUmVhZCB0YXNrIHBsYW4gdmVyaWZ5IGZpZWxkXG4gICAgY29uc3QgeyBtaWxlc3RvbmU6IG1pZCwgc2xpY2U6IHNpZCwgdGFzazogdGlkIH0gPSBwYXJzZVVuaXRJZChzLmN1cnJlbnRVbml0LmlkKTtcbiAgICBsZXQgdGFza1BsYW5WZXJpZnk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBpZiAobWlkICYmIHNpZCAmJiB0aWQpIHtcbiAgICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgICAgdGFza1BsYW5WZXJpZnkgPSBnZXRUYXNrKG1pZCwgc2lkLCB0aWQpPy52ZXJpZnk7XG4gICAgICB9XG4gICAgICAvLyBXaGVuIERCIHVuYXZhaWxhYmxlLCB0YXNrUGxhblZlcmlmeSBzdGF5cyB1bmRlZmluZWQgXHUyMDE0IGdhdGUgcnVucyB3aXRob3V0IHRhc2stc3BlY2lmaWMgY2hlY2tzXG4gICAgfVxuXG4gICAgY29uc3QgcmVzdWx0ID0gcnVuVmVyaWZpY2F0aW9uR2F0ZSh7XG4gICAgICBjd2Q6IHMuYmFzZVBhdGgsXG4gICAgICBwcmVmZXJlbmNlQ29tbWFuZHM6IHByZWZzPy52ZXJpZmljYXRpb25fY29tbWFuZHMsXG4gICAgICB0YXNrUGxhblZlcmlmeSxcbiAgICB9KTtcblxuICAgIC8vIENhcHR1cmUgcnVudGltZSBlcnJvcnNcbiAgICBjb25zdCBydW50aW1lRXJyb3JzID0gYXdhaXQgY2FwdHVyZVJ1bnRpbWVFcnJvcnMoKTtcbiAgICBpZiAocnVudGltZUVycm9ycy5sZW5ndGggPiAwKSB7XG4gICAgICByZXN1bHQucnVudGltZUVycm9ycyA9IHJ1bnRpbWVFcnJvcnM7XG4gICAgICBpZiAocnVudGltZUVycm9ycy5zb21lKChlKSA9PiBlLmJsb2NraW5nKSkge1xuICAgICAgICByZXN1bHQucGFzc2VkID0gZmFsc2U7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gRGVwZW5kZW5jeSBhdWRpdFxuICAgIGNvbnN0IGF1ZGl0V2FybmluZ3MgPSBydW5EZXBlbmRlbmN5QXVkaXQocy5iYXNlUGF0aCk7XG4gICAgaWYgKGF1ZGl0V2FybmluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgcmVzdWx0LmF1ZGl0V2FybmluZ3MgPSBhdWRpdFdhcm5pbmdzO1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGB2ZXJpZmljYXRpb24tZ2F0ZTogJHthdWRpdFdhcm5pbmdzLmxlbmd0aH0gYXVkaXQgd2FybmluZyhzKVxcbmAsXG4gICAgICApO1xuICAgICAgZm9yIChjb25zdCB3IG9mIGF1ZGl0V2FybmluZ3MpIHtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCAgWyR7dy5zZXZlcml0eX1dICR7dy5uYW1lfTogJHt3LnRpdGxlfVxcbmApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHZlcmRpY3QgPSBkZWNpZGVWZXJpZmljYXRpb25WZXJkaWN0KHMuY3VycmVudFVuaXQudHlwZSwgcmVzdWx0KTtcbiAgICBpZiAoIXZlcmRpY3QucGFzc2VkKSB7XG4gICAgICByZXN1bHQucGFzc2VkID0gZmFsc2U7XG4gICAgfVxuXG4gICAgaWYgKHVva0ZsYWdzLmdhdGVzKSB7XG4gICAgICBjb25zdCBnYXRlUnVubmVyID0gbmV3IFVva0dhdGVSdW5uZXIoKTtcbiAgICAgIGdhdGVSdW5uZXIucmVnaXN0ZXIoe1xuICAgICAgICBpZDogXCJ2ZXJpZmljYXRpb24tZ2F0ZVwiLFxuICAgICAgICB0eXBlOiBcInZlcmlmaWNhdGlvblwiLFxuICAgICAgICBleGVjdXRlOiBhc3luYyAoKSA9PiAoe1xuICAgICAgICAgIG91dGNvbWU6IHJlc3VsdC5wYXNzZWQgPyBcInBhc3NcIiA6IFwiZmFpbFwiLFxuICAgICAgICAgIGZhaWx1cmVDbGFzczogcmVzdWx0LnJ1bnRpbWVFcnJvcnM/LnNvbWUoKGUpID0+IGUuYmxvY2tpbmcpXG4gICAgICAgICAgICA/IFwiZXhlY3V0aW9uXCJcbiAgICAgICAgICAgIDogXCJ2ZXJpZmljYXRpb25cIixcbiAgICAgICAgICByYXRpb25hbGU6IHJlc3VsdC5wYXNzZWRcbiAgICAgICAgICAgID8gXCJ2ZXJpZmljYXRpb24gY2hlY2tzIHBhc3NlZFwiXG4gICAgICAgICAgICA6IHZlcmRpY3QucmVhc29uID09PSBcIm5vLWhvc3QtY2hlY2tzXCJcbiAgICAgICAgICAgICAgPyBcIm5vIHJ1bm5hYmxlIGhvc3Qtb3duZWQgdmVyaWZpY2F0aW9uIGNoZWNrcyBkaXNjb3ZlcmVkXCJcbiAgICAgICAgICAgICAgOiBcInZlcmlmaWNhdGlvbiBjaGVja3MgZmFpbGVkXCIsXG4gICAgICAgICAgZmluZGluZ3M6IHJlc3VsdC5wYXNzZWRcbiAgICAgICAgICAgID8gXCJcIlxuICAgICAgICAgICAgOiB2ZXJkaWN0LmZhaWx1cmVDb250ZXh0IHx8IGZvcm1hdEZhaWx1cmVDb250ZXh0KHJlc3VsdCksXG4gICAgICAgIH0pLFxuICAgICAgfSk7XG5cbiAgICAgIGF3YWl0IGdhdGVSdW5uZXIucnVuKFwidmVyaWZpY2F0aW9uLWdhdGVcIiwge1xuICAgICAgICBiYXNlUGF0aDogcy5iYXNlUGF0aCxcbiAgICAgICAgdHJhY2VJZDogYHZlcmlmaWNhdGlvbjoke3MuY3VycmVudFVuaXQuaWR9YCxcbiAgICAgICAgdHVybklkOiBzLmN1cnJlbnRVbml0LmlkLFxuICAgICAgICBtaWxlc3RvbmVJZDogbWlkID8/IHVuZGVmaW5lZCxcbiAgICAgICAgc2xpY2VJZDogc2lkID8/IHVuZGVmaW5lZCxcbiAgICAgICAgdGFza0lkOiB0aWQgPz8gdW5kZWZpbmVkLFxuICAgICAgICB1bml0VHlwZTogcy5jdXJyZW50VW5pdC50eXBlLFxuICAgICAgICB1bml0SWQ6IHMuY3VycmVudFVuaXQuaWQsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBBdXRvLWZpeCByZXRyeSBwcmVmZXJlbmNlc1xuICAgIGNvbnN0IGF1dG9GaXhFbmFibGVkID0gcHJlZnM/LnZlcmlmaWNhdGlvbl9hdXRvX2ZpeCAhPT0gZmFsc2U7XG4gICAgY29uc3QgbWF4UmV0cmllcyA9XG4gICAgICB0eXBlb2YgcHJlZnM/LnZlcmlmaWNhdGlvbl9tYXhfcmV0cmllcyA9PT0gXCJudW1iZXJcIlxuICAgICAgICA/IHByZWZzLnZlcmlmaWNhdGlvbl9tYXhfcmV0cmllc1xuICAgICAgICA6IDI7XG5cbiAgICBpZiAocmVzdWx0LmNoZWNrcy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBwYXNzQ291bnQgPSByZXN1bHQuY2hlY2tzLmZpbHRlcigoYykgPT4gYy5leGl0Q29kZSA9PT0gMCkubGVuZ3RoO1xuICAgICAgY29uc3QgdG90YWwgPSByZXN1bHQuY2hlY2tzLmxlbmd0aDtcbiAgICAgIGlmIChyZXN1bHQucGFzc2VkKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoYFZlcmlmaWNhdGlvbiBnYXRlOiAke3Bhc3NDb3VudH0vJHt0b3RhbH0gY2hlY2tzIHBhc3NlZGApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgZmFpbHVyZXMgPSByZXN1bHQuY2hlY2tzLmZpbHRlcigoYykgPT4gYy5leGl0Q29kZSAhPT0gMCk7XG4gICAgICAgIGNvbnN0IGZhaWxOYW1lcyA9IGZhaWx1cmVzLm1hcCgoZikgPT4gZi5jb21tYW5kKS5qb2luKFwiLCBcIik7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoYFZlcmlmaWNhdGlvbiBnYXRlOiBGQUlMRUQgXHUyMDE0ICR7ZmFpbE5hbWVzfWApO1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICBgdmVyaWZpY2F0aW9uLWdhdGU6ICR7dG90YWwgLSBwYXNzQ291bnR9LyR7dG90YWx9IGNoZWNrcyBmYWlsZWRcXG5gLFxuICAgICAgICApO1xuICAgICAgICBmb3IgKGNvbnN0IGYgb2YgZmFpbHVyZXMpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgICAke2YuY29tbWFuZH0gZXhpdGVkICR7Zi5leGl0Q29kZX1cXG5gKTtcbiAgICAgICAgICBpZiAoZi5zdGRlcnIpXG4gICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgICBzdGRlcnI6ICR7Zi5zdGRlcnIuc2xpY2UoMCwgNTAwKX1cXG5gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIExvZyBibG9ja2luZyBydW50aW1lIGVycm9yc1xuICAgIGlmIChyZXN1bHQucnVudGltZUVycm9ycz8uc29tZSgoZSkgPT4gZS5ibG9ja2luZykpIHtcbiAgICAgIGNvbnN0IGJsb2NraW5nRXJyb3JzID0gcmVzdWx0LnJ1bnRpbWVFcnJvcnMuZmlsdGVyKChlKSA9PiBlLmJsb2NraW5nKTtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgdmVyaWZpY2F0aW9uLWdhdGU6ICR7YmxvY2tpbmdFcnJvcnMubGVuZ3RofSBibG9ja2luZyBydW50aW1lIGVycm9yKHMpIGRldGVjdGVkXFxuYCxcbiAgICAgICk7XG4gICAgICBmb3IgKGNvbnN0IGVyciBvZiBibG9ja2luZ0Vycm9ycykge1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICBgICBbJHtlcnIuc291cmNlfV0gJHtlcnIuc2V2ZXJpdHl9OiAke2Vyci5tZXNzYWdlLnNsaWNlKDAsIDIwMCl9XFxuYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBXcml0ZSB2ZXJpZmljYXRpb24gZXZpZGVuY2UgSlNPTlxuICAgIGNvbnN0IHJldHJ5S2V5ID0gdmVyaWZpY2F0aW9uUmV0cnlLZXkocy5jdXJyZW50VW5pdC50eXBlLCBzLmN1cnJlbnRVbml0LmlkKTtcbiAgICBjb25zdCBhdHRlbXB0ID0gcy52ZXJpZmljYXRpb25SZXRyeUNvdW50LmdldChyZXRyeUtleSkgPz8gMDtcbiAgICBpZiAobWlkICYmIHNpZCAmJiB0aWQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHNEaXIgPSByZXNvbHZlU2xpY2VQYXRoKHMuYmFzZVBhdGgsIG1pZCwgc2lkKTtcbiAgICAgICAgaWYgKHNEaXIpIHtcbiAgICAgICAgICBjb25zdCB0YXNrc0RpciA9IGpvaW4oc0RpciwgXCJ0YXNrc1wiKTtcbiAgICAgICAgICBpZiAocmVzdWx0LnBhc3NlZCkge1xuICAgICAgICAgICAgd3JpdGVWZXJpZmljYXRpb25KU09OKHJlc3VsdCwgdGFza3NEaXIsIHRpZCwgcy5jdXJyZW50VW5pdC5pZCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnN0IG5leHRBdHRlbXB0ID0gYXR0ZW1wdCArIDE7XG4gICAgICAgICAgICBjb25zdCBpbmNsdWRlUmV0cnlNZXRhZGF0YSA9XG4gICAgICAgICAgICAgICFyZXN1bHQucGFzc2VkICYmXG4gICAgICAgICAgICAgIHZlcmRpY3QucmV0cnlhYmxlICYmXG4gICAgICAgICAgICAgIGF1dG9GaXhFbmFibGVkICYmXG4gICAgICAgICAgICAgIG5leHRBdHRlbXB0IDw9IG1heFJldHJpZXM7XG4gICAgICAgICAgICB3cml0ZVZlcmlmaWNhdGlvbkpTT04oXG4gICAgICAgICAgICAgIHJlc3VsdCxcbiAgICAgICAgICAgICAgdGFza3NEaXIsXG4gICAgICAgICAgICAgIHRpZCxcbiAgICAgICAgICAgICAgcy5jdXJyZW50VW5pdC5pZCxcbiAgICAgICAgICAgICAgaW5jbHVkZVJldHJ5TWV0YWRhdGEgPyBuZXh0QXR0ZW1wdCA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgaW5jbHVkZVJldHJ5TWV0YWRhdGEgPyBtYXhSZXRyaWVzIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGV2aWRlbmNlRXJyKSB7XG4gICAgICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgYHZlcmlmaWNhdGlvbi1ldmlkZW5jZSB3cml0ZSBlcnJvcjogJHsoZXZpZGVuY2VFcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFBvc3QtZXhlY3V0aW9uIGNoZWNrcyAocnVuIGFmdGVyIG1haW4gdmVyaWZpY2F0aW9uIHBhc3NlcyBmb3IgZXhlY3V0ZS10YXNrIHVuaXRzKSBcdTI1MDBcdTI1MDBcbiAgICBsZXQgcG9zdEV4ZWNDaGVja3M6IFBvc3RFeGVjdXRpb25DaGVja0pTT05bXSB8IHVuZGVmaW5lZDtcbiAgICBsZXQgcG9zdEV4ZWNCbG9ja2luZ0ZhaWx1cmUgPSBmYWxzZTtcblxuICAgIGlmIChyZXN1bHQucGFzc2VkICYmIG1pZCAmJiBzaWQgJiYgdGlkKSB7XG4gICAgICAvLyBDaGVjayBwcmVmZXJlbmNlcyBcdTIwMTQgcmVzcGVjdCBlbmhhbmNlZF92ZXJpZmljYXRpb24gYW5kIGVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9wb3N0XG4gICAgICBjb25zdCBlbmhhbmNlZEVuYWJsZWQgPSBwcmVmcz8uZW5oYW5jZWRfdmVyaWZpY2F0aW9uICE9PSBmYWxzZTsgLy8gZGVmYXVsdCB0cnVlXG4gICAgICBjb25zdCBwb3N0RW5hYmxlZCA9IHByZWZzPy5lbmhhbmNlZF92ZXJpZmljYXRpb25fcG9zdCAhPT0gZmFsc2U7IC8vIGRlZmF1bHQgdHJ1ZVxuXG4gICAgICBpZiAoZW5oYW5jZWRFbmFibGVkICYmIHBvc3RFbmFibGVkICYmIGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIC8vIEdldCB0aGUgY29tcGxldGVkIHRhc2sgZnJvbSBEQlxuICAgICAgICAgIGNvbnN0IHRhc2tSb3cgPSBnZXRUYXNrKG1pZCwgc2lkLCB0aWQpO1xuICAgICAgICAgIGlmICh0YXNrUm93ICYmIHRhc2tSb3cua2V5X2ZpbGVzICYmIHRhc2tSb3cua2V5X2ZpbGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIC8vIEdldCBhbGwgdGFza3MgaW4gdGhlIHNsaWNlXG4gICAgICAgICAgICBjb25zdCBhbGxUYXNrcyA9IGdldFNsaWNlVGFza3MobWlkLCBzaWQpO1xuICAgICAgICAgICAgLy8gRmlsdGVyIHRvIHByaW9yIGNvbXBsZXRlZCB0YXNrcyAoc3RhdHVzID0gJ2NvbXBsZXRlJyBvciAnZG9uZScsIGJlZm9yZSBjdXJyZW50IHRhc2spXG4gICAgICAgICAgICBjb25zdCBwcmlvclRhc2tzID0gYWxsVGFza3MuZmlsdGVyKFxuICAgICAgICAgICAgICAodDogVGFza1JvdykgPT5cbiAgICAgICAgICAgICAgICAodC5zdGF0dXMgPT09IFwiY29tcGxldGVcIiB8fCB0LnN0YXR1cyA9PT0gXCJkb25lXCIpICYmXG4gICAgICAgICAgICAgICAgdC5pZCAhPT0gdGlkICYmXG4gICAgICAgICAgICAgICAgdC5zZXF1ZW5jZSA8IHRhc2tSb3cuc2VxdWVuY2VcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIC8vIFJ1biBwb3N0LWV4ZWN1dGlvbiBjaGVja3NcbiAgICAgICAgICAgIGNvbnN0IHBvc3RFeGVjUmVzdWx0OiBQb3N0RXhlY3V0aW9uUmVzdWx0ID0gcnVuUG9zdEV4ZWN1dGlvbkNoZWNrcyhcbiAgICAgICAgICAgICAgdGFza1JvdyxcbiAgICAgICAgICAgICAgcHJpb3JUYXNrcyxcbiAgICAgICAgICAgICAgcy5iYXNlUGF0aFxuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgLy8gU3RvcmUgY2hlY2tzIGZvciBldmlkZW5jZSBKU09OXG4gICAgICAgICAgICBwb3N0RXhlY0NoZWNrcyA9IHBvc3RFeGVjUmVzdWx0LmNoZWNrcztcblxuICAgICAgICAgICAgLy8gTG9nIHN1bW1hcnkgdG8gc3RkZXJyIHdpdGggZ3NkLXBvc3QtZXhlYzogcHJlZml4XG4gICAgICAgICAgICBjb25zdCBlbW9qaSA9XG4gICAgICAgICAgICAgIHBvc3RFeGVjUmVzdWx0LnN0YXR1cyA9PT0gXCJwYXNzXCJcbiAgICAgICAgICAgICAgICA/IFwiXHUyNzA1XCJcbiAgICAgICAgICAgICAgICA6IHBvc3RFeGVjUmVzdWx0LnN0YXR1cyA9PT0gXCJ3YXJuXCJcbiAgICAgICAgICAgICAgICAgID8gXCJcdTI2QTBcdUZFMEZcIlxuICAgICAgICAgICAgICAgICAgOiBcIlx1Mjc0Q1wiO1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICAgIGBnc2QtcG9zdC1leGVjOiAke2Vtb2ppfSBQb3N0LWV4ZWN1dGlvbiBjaGVja3MgJHtwb3N0RXhlY1Jlc3VsdC5zdGF0dXN9IGZvciAke21pZH0vJHtzaWR9LyR7dGlkfSAoJHtwb3N0RXhlY1Jlc3VsdC5kdXJhdGlvbk1zfW1zKVxcbmBcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIC8vIExvZyBpbmRpdmlkdWFsIGNoZWNrIHJlc3VsdHNcbiAgICAgICAgICAgIGZvciAoY29uc3QgY2hlY2sgb2YgcG9zdEV4ZWNSZXN1bHQuY2hlY2tzKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGNoZWNrRW1vamkgPSBjaGVjay5wYXNzZWRcbiAgICAgICAgICAgICAgICA/IFwiXHUyNzEzXCJcbiAgICAgICAgICAgICAgICA6IGNoZWNrLmJsb2NraW5nXG4gICAgICAgICAgICAgICAgICA/IFwiXHUyNzE3XCJcbiAgICAgICAgICAgICAgICAgIDogXCJcdTI2QTBcIjtcbiAgICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICAgICAgYGdzZC1wb3N0LWV4ZWM6ICAgJHtjaGVja0Vtb2ppfSBbJHtjaGVjay5jYXRlZ29yeX1dICR7Y2hlY2sudGFyZ2V0fTogJHtjaGVjay5tZXNzYWdlfVxcbmBcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHVva0ZsYWdzLmdhdGVzKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHN0cmljdE1vZGUgPSBwcmVmcz8uZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3N0cmljdCA9PT0gdHJ1ZTtcbiAgICAgICAgICAgICAgY29uc3Qgd2FybkVzY2FsYXRlZCA9IHBvc3RFeGVjUmVzdWx0LnN0YXR1cyA9PT0gXCJ3YXJuXCIgJiYgc3RyaWN0TW9kZTtcbiAgICAgICAgICAgICAgY29uc3QgYmxvY2tpbmdGYWlsdXJlID0gcG9zdEV4ZWNSZXN1bHQuc3RhdHVzID09PSBcImZhaWxcIiB8fCB3YXJuRXNjYWxhdGVkO1xuICAgICAgICAgICAgICBjb25zdCBmaW5kaW5ncyA9IHBvc3RFeGVjUmVzdWx0LmNoZWNrc1xuICAgICAgICAgICAgICAgIC5maWx0ZXIoKGNoZWNrKSA9PiAhY2hlY2sucGFzc2VkKVxuICAgICAgICAgICAgICAgIC5tYXAoKGNoZWNrKSA9PiBgWyR7Y2hlY2suY2F0ZWdvcnl9XSAke2NoZWNrLnRhcmdldH06ICR7Y2hlY2subWVzc2FnZX1gKVxuICAgICAgICAgICAgICAgIC5qb2luKFwiXFxuXCIpO1xuICAgICAgICAgICAgICBjb25zdCBnYXRlUnVubmVyID0gbmV3IFVva0dhdGVSdW5uZXIoKTtcbiAgICAgICAgICAgICAgZ2F0ZVJ1bm5lci5yZWdpc3Rlcih7XG4gICAgICAgICAgICAgICAgaWQ6IFwicG9zdC1leGVjdXRpb24tY2hlY2tzXCIsXG4gICAgICAgICAgICAgICAgdHlwZTogXCJhcnRpZmFjdFwiLFxuICAgICAgICAgICAgICAgIGV4ZWN1dGU6IGFzeW5jICgpID0+ICh7XG4gICAgICAgICAgICAgICAgICBvdXRjb21lOiBibG9ja2luZ0ZhaWx1cmUgPyBcImZhaWxcIiA6IFwicGFzc1wiLFxuICAgICAgICAgICAgICAgICAgZmFpbHVyZUNsYXNzOiBwb3N0RXhlY1Jlc3VsdC5zdGF0dXMgPT09IFwiZmFpbFwiXG4gICAgICAgICAgICAgICAgICAgID8gXCJhcnRpZmFjdFwiXG4gICAgICAgICAgICAgICAgICAgIDogd2FybkVzY2FsYXRlZFxuICAgICAgICAgICAgICAgICAgICAgID8gXCJwb2xpY3lcIlxuICAgICAgICAgICAgICAgICAgICAgIDogXCJub25lXCIsXG4gICAgICAgICAgICAgICAgICByYXRpb25hbGU6IGJsb2NraW5nRmFpbHVyZVxuICAgICAgICAgICAgICAgICAgICA/IGBwb3N0LWV4ZWN1dGlvbiBjaGVja3MgJHtwb3N0RXhlY1Jlc3VsdC5zdGF0dXN9JHt3YXJuRXNjYWxhdGVkID8gXCIgKHN0cmljdClcIiA6IFwiXCJ9YFxuICAgICAgICAgICAgICAgICAgICA6IFwicG9zdC1leGVjdXRpb24gY2hlY2tzIHBhc3NlZFwiLFxuICAgICAgICAgICAgICAgICAgZmluZGluZ3MsXG4gICAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICBhd2FpdCBnYXRlUnVubmVyLnJ1bihcInBvc3QtZXhlY3V0aW9uLWNoZWNrc1wiLCB7XG4gICAgICAgICAgICAgICAgYmFzZVBhdGg6IHMuYmFzZVBhdGgsXG4gICAgICAgICAgICAgICAgdHJhY2VJZDogYHZlcmlmaWNhdGlvbjoke3MuY3VycmVudFVuaXQuaWR9YCxcbiAgICAgICAgICAgICAgICB0dXJuSWQ6IHMuY3VycmVudFVuaXQuaWQsXG4gICAgICAgICAgICAgICAgbWlsZXN0b25lSWQ6IG1pZCxcbiAgICAgICAgICAgICAgICBzbGljZUlkOiBzaWQsXG4gICAgICAgICAgICAgICAgdGFza0lkOiB0aWQsXG4gICAgICAgICAgICAgICAgdW5pdFR5cGU6IHMuY3VycmVudFVuaXQudHlwZSxcbiAgICAgICAgICAgICAgICB1bml0SWQ6IHMuY3VycmVudFVuaXQuaWQsXG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBDaGVjayBmb3IgYmxvY2tpbmcgZmFpbHVyZXNcbiAgICAgICAgICAgIGlmIChwb3N0RXhlY1Jlc3VsdC5zdGF0dXMgPT09IFwiZmFpbFwiKSB7XG4gICAgICAgICAgICAgIHBvc3RFeGVjQmxvY2tpbmdGYWlsdXJlID0gdHJ1ZTtcbiAgICAgICAgICAgICAgY29uc3QgYmxvY2tpbmdDb3VudCA9IHBvc3RFeGVjUmVzdWx0LmNoZWNrcy5maWx0ZXIoXG4gICAgICAgICAgICAgICAgKGMpID0+ICFjLnBhc3NlZCAmJiBjLmJsb2NraW5nXG4gICAgICAgICAgICAgICkubGVuZ3RoO1xuICAgICAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgICAgIGBQb3N0LWV4ZWN1dGlvbiBjaGVja3MgZmFpbGVkOiAke2Jsb2NraW5nQ291bnR9IGJsb2NraW5nIGlzc3VlJHtibG9ja2luZ0NvdW50ID09PSAxID8gXCJcIiA6IFwic1wifSBmb3VuZGAsXG4gICAgICAgICAgICAgICAgXCJlcnJvclwiXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHBvc3RFeGVjUmVzdWx0LnN0YXR1cyA9PT0gXCJ3YXJuXCIpIHtcbiAgICAgICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgICAgICBgUG9zdC1leGVjdXRpb24gY2hlY2tzIHBhc3NlZCB3aXRoIHdhcm5pbmdzYCxcbiAgICAgICAgICAgICAgICBcIndhcm5pbmdcIlxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAvLyBTdHJpY3QgbW9kZTogdHJlYXQgd2FybmluZ3MgYXMgYmxvY2tpbmdcbiAgICAgICAgICAgICAgaWYgKHByZWZzPy5lbmhhbmNlZF92ZXJpZmljYXRpb25fc3RyaWN0ID09PSB0cnVlKSB7XG4gICAgICAgICAgICAgICAgcG9zdEV4ZWNCbG9ja2luZ0ZhaWx1cmUgPSB0cnVlO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChwb3N0RXhlY0Vycikge1xuICAgICAgICAgIC8vIFBvc3QtZXhlY3V0aW9uIGNoZWNrIGVycm9ycyBhcmUgbm9uLWZhdGFsIFx1MjAxNCBsb2cgYW5kIGNvbnRpbnVlXG4gICAgICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBgZ3NkLXBvc3QtZXhlYzogZXJyb3IgXHUyMDE0ICR7KHBvc3RFeGVjRXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gUmUtd3JpdGUgdmVyaWZpY2F0aW9uIGV2aWRlbmNlIEpTT04gd2l0aCBwb3N0LWV4ZWN1dGlvbiBjaGVja3NcbiAgICBpZiAocG9zdEV4ZWNDaGVja3MgJiYgcG9zdEV4ZWNDaGVja3MubGVuZ3RoID4gMCAmJiBtaWQgJiYgc2lkICYmIHRpZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc0RpciA9IHJlc29sdmVTbGljZVBhdGgocy5iYXNlUGF0aCwgbWlkLCBzaWQpO1xuICAgICAgICBpZiAoc0Rpcikge1xuICAgICAgICAgIGNvbnN0IHRhc2tzRGlyID0gam9pbihzRGlyLCBcInRhc2tzXCIpO1xuICAgICAgICAgIC8vIEFkZCBwb3N0RXhlY3V0aW9uQ2hlY2tzIHRvIHRoZSByZXN1bHQgZm9yIHRoZSBKU09OIHdyaXRlXG4gICAgICAgICAgY29uc3QgcmVzdWx0V2l0aFBvc3RFeGVjID0ge1xuICAgICAgICAgICAgLi4ucmVzdWx0LFxuICAgICAgICAgICAgLy8gTWFyayBhcyBmYWlsZWQgaWYgdGhlcmUgd2FzIGEgYmxvY2tpbmcgcG9zdC1leGVjIGZhaWx1cmVcbiAgICAgICAgICAgIHBhc3NlZDogcmVzdWx0LnBhc3NlZCAmJiAhcG9zdEV4ZWNCbG9ja2luZ0ZhaWx1cmUsXG4gICAgICAgICAgfTtcbiAgICAgICAgICAvLyBNYW51YWxseSB3cml0ZSB3aXRoIHBvc3RFeGVjdXRpb25DaGVja3MgZmllbGRcbiAgICAgICAgICB3cml0ZVZlcmlmaWNhdGlvbkpTT05XaXRoUG9zdEV4ZWMoXG4gICAgICAgICAgICByZXN1bHRXaXRoUG9zdEV4ZWMsXG4gICAgICAgICAgICB0YXNrc0RpcixcbiAgICAgICAgICAgIHRpZCxcbiAgICAgICAgICAgIHMuY3VycmVudFVuaXQuaWQsXG4gICAgICAgICAgICBwb3N0RXhlY0NoZWNrcyxcbiAgICAgICAgICAgIHBvc3RFeGVjQmxvY2tpbmdGYWlsdXJlID8gYXR0ZW1wdCArIDEgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICBwb3N0RXhlY0Jsb2NraW5nRmFpbHVyZSA/IG1heFJldHJpZXMgOiB1bmRlZmluZWRcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChldmlkZW5jZUVycikge1xuICAgICAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIGB2ZXJpZmljYXRpb24tZXZpZGVuY2U6IHBvc3QtZXhlYyB3cml0ZSBlcnJvciBcdTIwMTQgJHsoZXZpZGVuY2VFcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gVXBkYXRlIHJlc3VsdC5wYXNzZWQgYmFzZWQgb24gcG9zdC1leGVjdXRpb24gY2hlY2tzXG4gICAgaWYgKHBvc3RFeGVjQmxvY2tpbmdGYWlsdXJlKSB7XG4gICAgICByZXN1bHQucGFzc2VkID0gZmFsc2U7XG4gICAgfVxuXG4gICAgLy8gRW1pdCBMYXllciAyIHZlcmlmeV9yZXN1bHQgZXZlbnQgd2l0aCB0aGUgZmluYWwsIHBvc3QtZXhlYyB2ZXJkaWN0IHNvIGhvb2tzXG4gICAgLy8gc2VlIHRoZSBhdXRob3JpdGF0aXZlIHBhc3MvZmFpbCBhbmQgdGhlIGNvbXBsZXRlIHNldCBvZiBmYWlsdXJlcy5cbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBlbWl0VmVyaWZ5UmVzdWx0IH0gPSBhd2FpdCBpbXBvcnQoXCIuL2hvb2stZW1pdHRlci5qc1wiKTtcbiAgICAgIGNvbnN0IGNoZWNrRmFpbHVyZXMgPSByZXN1bHQuY2hlY2tzXG4gICAgICAgIC5maWx0ZXIoKGMpID0+IGMuZXhpdENvZGUgIT09IDApXG4gICAgICAgIC5tYXAoKGMpID0+ICh7XG4gICAgICAgICAga2luZDogXCJnYXRlXCIgYXMgY29uc3QsXG4gICAgICAgICAgbWVzc2FnZTogYCR7Yy5jb21tYW5kfSBleGl0ZWQgJHtjLmV4aXRDb2RlfSR7Yy5zdGRlcnIgPyBgOiAke2Muc3RkZXJyLnNsaWNlKDAsIDIwMCl9YCA6IFwiXCJ9YCxcbiAgICAgICAgfSkpO1xuICAgICAgY29uc3QgcnVudGltZUZhaWx1cmVzID0gKHJlc3VsdC5ydW50aW1lRXJyb3JzID8/IFtdKVxuICAgICAgICAuZmlsdGVyKChlKSA9PiBlLmJsb2NraW5nKVxuICAgICAgICAubWFwKChlKSA9PiAoe1xuICAgICAgICAgIGtpbmQ6IFwib3RoZXJcIiBhcyBjb25zdCxcbiAgICAgICAgICBtZXNzYWdlOiBgWyR7ZS5zb3VyY2V9XSAke2UubWVzc2FnZS5zbGljZSgwLCAyMDApfWAsXG4gICAgICAgIH0pKTtcbiAgICAgIGNvbnN0IHBvc3RFeGVjRmFpbHVyZXMgPSAocG9zdEV4ZWNDaGVja3MgPz8gW10pXG4gICAgICAgIC5maWx0ZXIoKGMpID0+ICFjLnBhc3NlZClcbiAgICAgICAgLm1hcCgoYykgPT4gKHtcbiAgICAgICAgICBraW5kOiBcIm90aGVyXCIgYXMgY29uc3QsXG4gICAgICAgICAgbWVzc2FnZTogYFske2MuY2F0ZWdvcnl9XSAke2MudGFyZ2V0fTogJHtjLm1lc3NhZ2V9YCxcbiAgICAgICAgfSkpO1xuICAgICAgYXdhaXQgZW1pdFZlcmlmeVJlc3VsdCh7XG4gICAgICAgIHBhc3NlZDogcmVzdWx0LnBhc3NlZCxcbiAgICAgICAgZmFpbHVyZXM6IFsuLi5jaGVja0ZhaWx1cmVzLCAuLi5ydW50aW1lRmFpbHVyZXMsIC4uLnBvc3RFeGVjRmFpbHVyZXNdLFxuICAgICAgICB1bml0VHlwZTogcy5jdXJyZW50VW5pdC50eXBlLFxuICAgICAgICB1bml0SWQ6IHMuY3VycmVudFVuaXQuaWQsXG4gICAgICAgIGN3ZDogcy5iYXNlUGF0aCxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGhvb2tFcnIpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgYHZlcmlmeV9yZXN1bHQgaG9vayBlbWlzc2lvbiBmYWlsZWQ6ICR7KGhvb2tFcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIEF1dG8tZml4IHJldHJ5IGxvZ2ljIFx1MjUwMFx1MjUwMFxuICAgIGlmIChyZXN1bHQucGFzc2VkKSB7XG4gICAgICBzLnZlcmlmaWNhdGlvblJldHJ5Q291bnQuZGVsZXRlKHJldHJ5S2V5KTtcbiAgICAgIHMudmVyaWZpY2F0aW9uUmV0cnlGYWlsdXJlSGFzaGVzLmRlbGV0ZShyZXRyeUtleSk7XG4gICAgICBzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSA9IG51bGw7XG4gICAgICByZXR1cm4gXCJjb250aW51ZVwiO1xuICAgIH0gZWxzZSBpZiAodmVyZGljdC5yZWFzb24gPT09IFwibm8taG9zdC1jaGVja3NcIikge1xuICAgICAgcy52ZXJpZmljYXRpb25SZXRyeUNvdW50LmRlbGV0ZShyZXRyeUtleSk7XG4gICAgICBzLnZlcmlmaWNhdGlvblJldHJ5RmFpbHVyZUhhc2hlcy5kZWxldGUocmV0cnlLZXkpO1xuICAgICAgcy5wZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnkgPSBudWxsO1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgXCJWZXJpZmljYXRpb24gZ2F0ZSBGQUlMRUQgXHUyMDE0IG5vIHJ1bm5hYmxlIGhvc3Qtb3duZWQgdmVyaWZpY2F0aW9uIGNoZWNrcyB3ZXJlIGRpc2NvdmVyZWQuIFBhdXNpbmcgZm9yIGh1bWFuIHJldmlldy5cIixcbiAgICAgICAgXCJlcnJvclwiLFxuICAgICAgKTtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGB2ZXJpZmljYXRpb24tZ2F0ZTogJHt2ZXJkaWN0LmZhaWx1cmVDb250ZXh0fVxcbmApO1xuICAgICAgYXdhaXQgcGF1c2VBdXRvKGN0eCwgcGkpO1xuICAgICAgcmV0dXJuIFwicGF1c2VcIjtcbiAgICB9IGVsc2UgaWYgKHBvc3RFeGVjQmxvY2tpbmdGYWlsdXJlKSB7XG4gICAgICAvLyBQb3N0LWV4ZWN1dGlvbiBmYWlsdXJlcyBhcmUgY3Jvc3MtdGFzayBjb25zaXN0ZW5jeSBpc3N1ZXMgXHUyMDE0IHJldHJ5aW5nIHRoZSBzYW1lIHRhc2sgd29uJ3QgZml4IHRoZW0uXG4gICAgICAvLyBTa2lwIHJldHJ5IGFuZCBwYXVzZSBpbW1lZGlhdGVseSBmb3IgaHVtYW4gcmV2aWV3LlxuICAgICAgcy52ZXJpZmljYXRpb25SZXRyeUNvdW50LmRlbGV0ZShyZXRyeUtleSk7XG4gICAgICBzLnZlcmlmaWNhdGlvblJldHJ5RmFpbHVyZUhhc2hlcy5kZWxldGUocmV0cnlLZXkpO1xuICAgICAgcy5wZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnkgPSBudWxsO1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgYFBvc3QtZXhlY3V0aW9uIGNoZWNrcyBmYWlsZWQgXHUyMDE0IGNyb3NzLXRhc2sgY29uc2lzdGVuY3kgaXNzdWUgZGV0ZWN0ZWQsIHBhdXNpbmcgZm9yIGh1bWFuIHJldmlld2AsXG4gICAgICAgIFwiZXJyb3JcIixcbiAgICAgICk7XG4gICAgICBhd2FpdCBwYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgICByZXR1cm4gXCJwYXVzZVwiO1xuICAgIH0gZWxzZSBpZiAoYXV0b0ZpeEVuYWJsZWQgJiYgYXR0ZW1wdCArIDEgPD0gbWF4UmV0cmllcykge1xuICAgICAgY29uc3QgbmV4dEF0dGVtcHQgPSBhdHRlbXB0ICsgMTtcbiAgICAgIHMudmVyaWZpY2F0aW9uUmV0cnlDb3VudC5zZXQocmV0cnlLZXksIG5leHRBdHRlbXB0KTtcbiAgICAgIHMucGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5ID0ge1xuICAgICAgICB1bml0SWQ6IHMuY3VycmVudFVuaXQuaWQsXG4gICAgICAgIGZhaWx1cmVDb250ZXh0OiB2ZXJkaWN0LmZhaWx1cmVDb250ZXh0IHx8IGZvcm1hdEZhaWx1cmVDb250ZXh0KHJlc3VsdCksXG4gICAgICAgIGF0dGVtcHQ6IG5leHRBdHRlbXB0LFxuICAgICAgfTtcbiAgICAgIGNvbnN0IGZhaWxlZENtZHMgPSByZXN1bHQuY2hlY2tzXG4gICAgICAgIC5maWx0ZXIoKGMpID0+IGMuZXhpdENvZGUgIT09IDApXG4gICAgICAgIC5tYXAoKGMpID0+IGMuY29tbWFuZCk7XG4gICAgICBjb25zdCBjbWRTdW1tYXJ5ID0gZmFpbGVkQ21kcy5sZW5ndGggPD0gM1xuICAgICAgICA/IGZhaWxlZENtZHMuam9pbihcIiwgXCIpXG4gICAgICAgIDogYCR7ZmFpbGVkQ21kcy5zbGljZSgwLCAzKS5qb2luKFwiLCBcIil9Li4uIGFuZCAke2ZhaWxlZENtZHMubGVuZ3RoIC0gM30gbW9yZWA7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgVmVyaWZpY2F0aW9uIGZhaWxlZCAoJHtjbWRTdW1tYXJ5fSkgXHUyMDE0IGF1dG8tZml4IGF0dGVtcHQgJHtuZXh0QXR0ZW1wdH0vJHttYXhSZXRyaWVzfWAsXG4gICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgKTtcbiAgICAgIC8vIFJldHVybiBcInJldHJ5XCIgXHUyMDE0IHRoZSBhdXRvTG9vcCB3aGlsZSBsb29wIHdpbGwgcmUtaXRlcmF0ZSB3aXRoIHRoZSByZXRyeSBjb250ZXh0XG4gICAgICByZXR1cm4gXCJyZXRyeVwiO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBHYXRlIGZhaWxlZCwgcmV0cmllcyBleGhhdXN0ZWRcbiAgICAgIHMudmVyaWZpY2F0aW9uUmV0cnlDb3VudC5kZWxldGUocmV0cnlLZXkpO1xuICAgICAgcy52ZXJpZmljYXRpb25SZXRyeUZhaWx1cmVIYXNoZXMuZGVsZXRlKHJldHJ5S2V5KTtcbiAgICAgIHMucGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5ID0gbnVsbDtcbiAgICAgIGNvbnN0IGV4aGF1c3RlZEZhaWxzID0gcmVzdWx0LmNoZWNrc1xuICAgICAgICAuZmlsdGVyKChjKSA9PiBjLmV4aXRDb2RlICE9PSAwKVxuICAgICAgICAubWFwKChjKSA9PiBjLmNvbW1hbmQpO1xuICAgICAgY29uc3QgZXhoYXVzdGVkU3VtbWFyeSA9IGV4aGF1c3RlZEZhaWxzLmxlbmd0aCA8PSAzXG4gICAgICAgID8gZXhoYXVzdGVkRmFpbHMuam9pbihcIiwgXCIpXG4gICAgICAgIDogYCR7ZXhoYXVzdGVkRmFpbHMuc2xpY2UoMCwgMykuam9pbihcIiwgXCIpfS4uLiBhbmQgJHtleGhhdXN0ZWRGYWlscy5sZW5ndGggLSAzfSBtb3JlYDtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBWZXJpZmljYXRpb24gZ2F0ZSBGQUlMRUQgYWZ0ZXIgJHthdHRlbXB0fSAke2F0dGVtcHQgPT09IDEgPyBcInJldHJ5XCIgOiBcInJldHJpZXNcIn0gKCR7ZXhoYXVzdGVkU3VtbWFyeX0pIFx1MjAxNCBwYXVzaW5nIGZvciBodW1hbiByZXZpZXdgLFxuICAgICAgICBcImVycm9yXCIsXG4gICAgICApO1xuICAgICAgYXdhaXQgcGF1c2VBdXRvKGN0eCwgcGkpO1xuICAgICAgcmV0dXJuIFwicGF1c2VcIjtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgYHZlcmlmaWNhdGlvbi1nYXRlIGVycm9yOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGBWZXJpZmljYXRpb24gZ2F0ZSBlcnJvcmVkIGJlZm9yZSBwcm9kdWNpbmcgYW4gYXV0aG9yaXRhdGl2ZSB2ZXJkaWN0OiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCxcbiAgICAgIFwiZXJyb3JcIixcbiAgICApO1xuICAgIGF3YWl0IHBhdXNlQXV0byhjdHgsIHBpKTtcbiAgICByZXR1cm4gXCJwYXVzZVwiO1xuICB9XG59XG5cbi8qKlxuICogV3JpdGUgdmVyaWZpY2F0aW9uIGV2aWRlbmNlIEpTT04gd2l0aCBwb3N0LWV4ZWN1dGlvbiBjaGVja3MgaW5jbHVkZWQuXG4gKiBUaGlzIGlzIGEgdmFyaWFudCBvZiB3cml0ZVZlcmlmaWNhdGlvbkpTT04gdGhhdCBhZGRzIHRoZSBwb3N0RXhlY3V0aW9uQ2hlY2tzIGZpZWxkLlxuICovXG5mdW5jdGlvbiB3cml0ZVZlcmlmaWNhdGlvbkpTT05XaXRoUG9zdEV4ZWMoXG4gIHJlc3VsdDogVmVyaWZpY2F0aW9uR2F0ZVJlc3VsdCxcbiAgdGFza3NEaXI6IHN0cmluZyxcbiAgdGFza0lkOiBzdHJpbmcsXG4gIHVuaXRJZDogc3RyaW5nLFxuICBwb3N0RXhlY3V0aW9uQ2hlY2tzOiBQb3N0RXhlY3V0aW9uQ2hlY2tKU09OW10sXG4gIHJldHJ5QXR0ZW1wdD86IG51bWJlcixcbiAgbWF4UmV0cmllcz86IG51bWJlcixcbik6IHZvaWQge1xuICBta2RpclN5bmModGFza3NEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIGNvbnN0IGV2aWRlbmNlOiBFdmlkZW5jZUpTT04gPSB7XG4gICAgc2NoZW1hVmVyc2lvbjogMSxcbiAgICB0YXNrSWQsXG4gICAgdW5pdElkOiB1bml0SWQgPz8gdGFza0lkLFxuICAgIHRpbWVzdGFtcDogcmVzdWx0LnRpbWVzdGFtcCxcbiAgICBwYXNzZWQ6IHJlc3VsdC5wYXNzZWQsXG4gICAgZGlzY292ZXJ5U291cmNlOiByZXN1bHQuZGlzY292ZXJ5U291cmNlLFxuICAgIGNoZWNrczogcmVzdWx0LmNoZWNrcy5tYXAoKGNoZWNrKSA9PiAoe1xuICAgICAgY29tbWFuZDogY2hlY2suY29tbWFuZCxcbiAgICAgIGV4aXRDb2RlOiBjaGVjay5leGl0Q29kZSxcbiAgICAgIGR1cmF0aW9uTXM6IGNoZWNrLmR1cmF0aW9uTXMsXG4gICAgICB2ZXJkaWN0OiBjaGVjay5leGl0Q29kZSA9PT0gMCA/IFwicGFzc1wiIDogXCJmYWlsXCIsXG4gICAgfSkpLFxuICAgIC4uLihyZXRyeUF0dGVtcHQgIT09IHVuZGVmaW5lZCA/IHsgcmV0cnlBdHRlbXB0IH0gOiB7fSksXG4gICAgLi4uKG1heFJldHJpZXMgIT09IHVuZGVmaW5lZCA/IHsgbWF4UmV0cmllcyB9IDoge30pLFxuICAgIHBvc3RFeGVjdXRpb25DaGVja3MsXG4gIH07XG5cbiAgaWYgKHJlc3VsdC5ydW50aW1lRXJyb3JzICYmIHJlc3VsdC5ydW50aW1lRXJyb3JzLmxlbmd0aCA+IDApIHtcbiAgICBldmlkZW5jZS5ydW50aW1lRXJyb3JzID0gcmVzdWx0LnJ1bnRpbWVFcnJvcnMubWFwKGUgPT4gKHtcbiAgICAgIHNvdXJjZTogZS5zb3VyY2UsXG4gICAgICBzZXZlcml0eTogZS5zZXZlcml0eSxcbiAgICAgIG1lc3NhZ2U6IGUubWVzc2FnZSxcbiAgICAgIGJsb2NraW5nOiBlLmJsb2NraW5nLFxuICAgIH0pKTtcbiAgfVxuXG4gIGlmIChyZXN1bHQuYXVkaXRXYXJuaW5ncyAmJiByZXN1bHQuYXVkaXRXYXJuaW5ncy5sZW5ndGggPiAwKSB7XG4gICAgZXZpZGVuY2UuYXVkaXRXYXJuaW5ncyA9IHJlc3VsdC5hdWRpdFdhcm5pbmdzLm1hcCh3ID0+ICh7XG4gICAgICBuYW1lOiB3Lm5hbWUsXG4gICAgICBzZXZlcml0eTogdy5zZXZlcml0eSxcbiAgICAgIHRpdGxlOiB3LnRpdGxlLFxuICAgICAgdXJsOiB3LnVybCxcbiAgICAgIGZpeEF2YWlsYWJsZTogdy5maXhBdmFpbGFibGUsXG4gICAgfSkpO1xuICB9XG5cbiAgY29uc3QgZmlsZVBhdGggPSBqb2luKHRhc2tzRGlyLCBgJHt0YXNrSWR9LVZFUklGWS5qc29uYCk7XG4gIHdyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIEpTT04uc3RyaW5naWZ5KGV2aWRlbmNlLCBudWxsLCAyKSArIFwiXFxu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
