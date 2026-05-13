import { CURRENT_UOK_CONTRACT_VERSION, validateTurnResult } from "./contracts.js";
import { buildAuditEnvelope, emitUokAuditEvent } from "./audit.js";
import { writeTurnCloseoutGitRecord, writeTurnGitTransaction } from "./gitops.js";
import { acquireWriterToken, nextWriteRecord, releaseWriterToken } from "./writer.js";
function createTurnObserver(options) {
  let current = null;
  let writerToken = null;
  const phaseResults = [];
  function nextSequenceMetadata(category, operation, metadata) {
    if (!writerToken) return metadata ?? {};
    const record = nextWriteRecord({
      basePath: options.basePath,
      token: writerToken,
      category,
      operation,
      metadata
    });
    return {
      ...metadata ?? {},
      writeSequence: record.sequence.sequence,
      writerTokenId: record.writerToken.tokenId
    };
  }
  return {
    onTurnStart(contract) {
      current = contract;
      phaseResults.length = 0;
      writerToken = acquireWriterToken({
        basePath: options.basePath,
        traceId: contract.traceId,
        turnId: contract.turnId
      });
      if (options.enableGitops) {
        writeTurnGitTransaction({
          basePath: options.basePath,
          traceId: contract.traceId,
          turnId: contract.turnId,
          unitType: contract.unitType,
          unitId: contract.unitId,
          stage: "turn-start",
          action: options.gitAction,
          push: options.gitPush,
          status: "ok",
          metadata: nextSequenceMetadata("gitops", "insert", {
            iteration: contract.iteration,
            sidecarKind: contract.sidecarKind
          })
        });
      }
      if (options.enableAudit) {
        emitUokAuditEvent(
          options.basePath,
          buildAuditEnvelope({
            traceId: contract.traceId,
            turnId: contract.turnId,
            category: "orchestration",
            type: "turn-start",
            payload: nextSequenceMetadata("audit", "append", {
              iteration: contract.iteration,
              unitType: contract.unitType,
              unitId: contract.unitId,
              sidecarKind: contract.sidecarKind
            })
          })
        );
      }
    },
    onPhaseResult(phase, action, data) {
      phaseResults.push({
        phase,
        action,
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        data
      });
      if (!current || !options.enableGitops) return;
      if (phase === "dispatch") {
        writeTurnGitTransaction({
          basePath: options.basePath,
          traceId: current.traceId,
          turnId: current.turnId,
          unitType: data?.unitType,
          unitId: data?.unitId,
          stage: "stage",
          action: options.gitAction,
          push: options.gitPush,
          status: "ok",
          metadata: nextSequenceMetadata("gitops", "update", { action })
        });
      }
      if (phase === "unit") {
        writeTurnGitTransaction({
          basePath: options.basePath,
          traceId: current.traceId,
          turnId: current.turnId,
          unitType: data?.unitType,
          unitId: data?.unitId,
          stage: "checkpoint",
          action: options.gitAction,
          push: options.gitPush,
          status: "ok",
          metadata: nextSequenceMetadata("gitops", "update", { action })
        });
      }
      if (phase === "finalize") {
        writeTurnGitTransaction({
          basePath: options.basePath,
          traceId: current.traceId,
          turnId: current.turnId,
          unitType: data?.unitType,
          unitId: data?.unitId,
          stage: "publish",
          action: options.gitAction,
          push: options.gitPush,
          status: "ok",
          metadata: nextSequenceMetadata("gitops", "update", { action })
        });
      }
    },
    onTurnResult(result) {
      const cleanup = () => {
        if (writerToken) {
          releaseWriterToken(options.basePath, writerToken);
        }
        writerToken = null;
        current = null;
        phaseResults.length = 0;
      };
      try {
        const merged = {
          ...result,
          version: CURRENT_UOK_CONTRACT_VERSION,
          phaseResults: Array.isArray(result.phaseResults) && result.phaseResults.length > 0 ? result.phaseResults : [...phaseResults]
        };
        const validation = validateTurnResult(merged);
        if (!validation.ok) {
          throw new Error(`Invalid UOK turn result: ${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
        }
        if (options.enableAudit) {
          emitUokAuditEvent(
            options.basePath,
            buildAuditEnvelope({
              traceId: validation.value.traceId,
              turnId: validation.value.turnId,
              category: "orchestration",
              type: "turn-result",
              payload: nextSequenceMetadata("audit", "append", {
                contractVersion: validation.value.version,
                unitType: validation.value.unitType,
                unitId: validation.value.unitId,
                status: validation.value.status,
                failureClass: validation.value.failureClass,
                error: validation.value.error,
                phaseCount: validation.value.phaseResults.length
              })
            })
          );
        }
        if (options.enableGitops) {
          const closeout = merged.closeout ?? {
            traceId: merged.traceId,
            turnId: merged.turnId,
            unitType: merged.unitType,
            unitId: merged.unitId,
            status: merged.status,
            failureClass: merged.failureClass,
            gitAction: options.gitAction,
            gitPushed: options.gitPush,
            finishedAt: merged.finishedAt
          };
          writeTurnCloseoutGitRecord(
            options.basePath,
            closeout,
            nextSequenceMetadata("gitops", "update", { action: "record" })
          );
        }
      } finally {
        cleanup();
      }
    }
  };
}
export {
  createTurnObserver
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC91b2svbG9vcC1hZGFwdGVyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QyIFVPSyBUdXJuIE9ic2VydmVyIGFuZCBEQi1CYWNrZWQgTGlmZWN5Y2xlIEVtaXNzaW9uXG5cbmltcG9ydCB0eXBlIHtcbiAgVHVybkNsb3Nlb3V0UmVjb3JkLFxuICBUdXJuQ29udHJhY3QsXG4gIFR1cm5SZXN1bHQsXG4gIFVva1R1cm5PYnNlcnZlcixcbn0gZnJvbSBcIi4vY29udHJhY3RzLmpzXCI7XG5pbXBvcnQgeyBDVVJSRU5UX1VPS19DT05UUkFDVF9WRVJTSU9OLCB2YWxpZGF0ZVR1cm5SZXN1bHQgfSBmcm9tIFwiLi9jb250cmFjdHMuanNcIjtcbmltcG9ydCB7IGJ1aWxkQXVkaXRFbnZlbG9wZSwgZW1pdFVva0F1ZGl0RXZlbnQgfSBmcm9tIFwiLi9hdWRpdC5qc1wiO1xuaW1wb3J0IHsgd3JpdGVUdXJuQ2xvc2VvdXRHaXRSZWNvcmQsIHdyaXRlVHVybkdpdFRyYW5zYWN0aW9uIH0gZnJvbSBcIi4vZ2l0b3BzLmpzXCI7XG5pbXBvcnQgeyBhY3F1aXJlV3JpdGVyVG9rZW4sIG5leHRXcml0ZVJlY29yZCwgcmVsZWFzZVdyaXRlclRva2VuIH0gZnJvbSBcIi4vd3JpdGVyLmpzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ3JlYXRlVHVybk9ic2VydmVyT3B0aW9ucyB7XG4gIGJhc2VQYXRoOiBzdHJpbmc7XG4gIGdpdEFjdGlvbjogXCJjb21taXRcIiB8IFwic25hcHNob3RcIiB8IFwic3RhdHVzLW9ubHlcIjtcbiAgZ2l0UHVzaDogYm9vbGVhbjtcbiAgZW5hYmxlQXVkaXQ6IGJvb2xlYW47XG4gIGVuYWJsZUdpdG9wczogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVR1cm5PYnNlcnZlcihvcHRpb25zOiBDcmVhdGVUdXJuT2JzZXJ2ZXJPcHRpb25zKTogVW9rVHVybk9ic2VydmVyIHtcbiAgbGV0IGN1cnJlbnQ6IFR1cm5Db250cmFjdCB8IG51bGwgPSBudWxsO1xuICBsZXQgd3JpdGVyVG9rZW46IFJldHVyblR5cGU8dHlwZW9mIGFjcXVpcmVXcml0ZXJUb2tlbj4gfCBudWxsID0gbnVsbDtcbiAgY29uc3QgcGhhc2VSZXN1bHRzOiBUdXJuUmVzdWx0W1wicGhhc2VSZXN1bHRzXCJdID0gW107XG5cbiAgZnVuY3Rpb24gbmV4dFNlcXVlbmNlTWV0YWRhdGEoXG4gICAgY2F0ZWdvcnk6IFwiYXVkaXRcIiB8IFwiZ2l0b3BzXCIsXG4gICAgb3BlcmF0aW9uOiBcImFwcGVuZFwiIHwgXCJpbnNlcnRcIiB8IFwidXBkYXRlXCIsXG4gICAgbWV0YWRhdGE/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICAgIGlmICghd3JpdGVyVG9rZW4pIHJldHVybiBtZXRhZGF0YSA/PyB7fTtcbiAgICBjb25zdCByZWNvcmQgPSBuZXh0V3JpdGVSZWNvcmQoe1xuICAgICAgYmFzZVBhdGg6IG9wdGlvbnMuYmFzZVBhdGgsXG4gICAgICB0b2tlbjogd3JpdGVyVG9rZW4sXG4gICAgICBjYXRlZ29yeSxcbiAgICAgIG9wZXJhdGlvbixcbiAgICAgIG1ldGFkYXRhLFxuICAgIH0pO1xuICAgIHJldHVybiB7XG4gICAgICAuLi4obWV0YWRhdGEgPz8ge30pLFxuICAgICAgd3JpdGVTZXF1ZW5jZTogcmVjb3JkLnNlcXVlbmNlLnNlcXVlbmNlLFxuICAgICAgd3JpdGVyVG9rZW5JZDogcmVjb3JkLndyaXRlclRva2VuLnRva2VuSWQsXG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgb25UdXJuU3RhcnQoY29udHJhY3QpOiB2b2lkIHtcbiAgICAgIGN1cnJlbnQgPSBjb250cmFjdDtcbiAgICAgIHBoYXNlUmVzdWx0cy5sZW5ndGggPSAwO1xuICAgICAgd3JpdGVyVG9rZW4gPSBhY3F1aXJlV3JpdGVyVG9rZW4oe1xuICAgICAgICBiYXNlUGF0aDogb3B0aW9ucy5iYXNlUGF0aCxcbiAgICAgICAgdHJhY2VJZDogY29udHJhY3QudHJhY2VJZCxcbiAgICAgICAgdHVybklkOiBjb250cmFjdC50dXJuSWQsXG4gICAgICB9KTtcblxuICAgICAgaWYgKG9wdGlvbnMuZW5hYmxlR2l0b3BzKSB7XG4gICAgICAgIHdyaXRlVHVybkdpdFRyYW5zYWN0aW9uKHtcbiAgICAgICAgICBiYXNlUGF0aDogb3B0aW9ucy5iYXNlUGF0aCxcbiAgICAgICAgICB0cmFjZUlkOiBjb250cmFjdC50cmFjZUlkLFxuICAgICAgICAgIHR1cm5JZDogY29udHJhY3QudHVybklkLFxuICAgICAgICAgIHVuaXRUeXBlOiBjb250cmFjdC51bml0VHlwZSxcbiAgICAgICAgICB1bml0SWQ6IGNvbnRyYWN0LnVuaXRJZCxcbiAgICAgICAgICBzdGFnZTogXCJ0dXJuLXN0YXJ0XCIsXG4gICAgICAgICAgYWN0aW9uOiBvcHRpb25zLmdpdEFjdGlvbixcbiAgICAgICAgICBwdXNoOiBvcHRpb25zLmdpdFB1c2gsXG4gICAgICAgICAgc3RhdHVzOiBcIm9rXCIsXG4gICAgICAgICAgbWV0YWRhdGE6IG5leHRTZXF1ZW5jZU1ldGFkYXRhKFwiZ2l0b3BzXCIsIFwiaW5zZXJ0XCIsIHtcbiAgICAgICAgICAgIGl0ZXJhdGlvbjogY29udHJhY3QuaXRlcmF0aW9uLFxuICAgICAgICAgICAgc2lkZWNhcktpbmQ6IGNvbnRyYWN0LnNpZGVjYXJLaW5kLFxuICAgICAgICAgIH0pLFxuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgaWYgKG9wdGlvbnMuZW5hYmxlQXVkaXQpIHtcbiAgICAgICAgZW1pdFVva0F1ZGl0RXZlbnQoXG4gICAgICAgICAgb3B0aW9ucy5iYXNlUGF0aCxcbiAgICAgICAgICBidWlsZEF1ZGl0RW52ZWxvcGUoe1xuICAgICAgICAgICAgdHJhY2VJZDogY29udHJhY3QudHJhY2VJZCxcbiAgICAgICAgICAgIHR1cm5JZDogY29udHJhY3QudHVybklkLFxuICAgICAgICAgICAgY2F0ZWdvcnk6IFwib3JjaGVzdHJhdGlvblwiLFxuICAgICAgICAgICAgdHlwZTogXCJ0dXJuLXN0YXJ0XCIsXG4gICAgICAgICAgICBwYXlsb2FkOiBuZXh0U2VxdWVuY2VNZXRhZGF0YShcImF1ZGl0XCIsIFwiYXBwZW5kXCIsIHtcbiAgICAgICAgICAgICAgaXRlcmF0aW9uOiBjb250cmFjdC5pdGVyYXRpb24sXG4gICAgICAgICAgICAgIHVuaXRUeXBlOiBjb250cmFjdC51bml0VHlwZSxcbiAgICAgICAgICAgICAgdW5pdElkOiBjb250cmFjdC51bml0SWQsXG4gICAgICAgICAgICAgIHNpZGVjYXJLaW5kOiBjb250cmFjdC5zaWRlY2FyS2luZCxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgIH0pLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0sXG5cbiAgICBvblBoYXNlUmVzdWx0KHBoYXNlLCBhY3Rpb24sIGRhdGEpOiB2b2lkIHtcbiAgICAgIHBoYXNlUmVzdWx0cy5wdXNoKHtcbiAgICAgICAgcGhhc2UsXG4gICAgICAgIGFjdGlvbixcbiAgICAgICAgdHM6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgZGF0YSxcbiAgICAgIH0pO1xuXG4gICAgICBpZiAoIWN1cnJlbnQgfHwgIW9wdGlvbnMuZW5hYmxlR2l0b3BzKSByZXR1cm47XG4gICAgICBpZiAocGhhc2UgPT09IFwiZGlzcGF0Y2hcIikge1xuICAgICAgICB3cml0ZVR1cm5HaXRUcmFuc2FjdGlvbih7XG4gICAgICAgICAgYmFzZVBhdGg6IG9wdGlvbnMuYmFzZVBhdGgsXG4gICAgICAgICAgdHJhY2VJZDogY3VycmVudC50cmFjZUlkLFxuICAgICAgICAgIHR1cm5JZDogY3VycmVudC50dXJuSWQsXG4gICAgICAgICAgdW5pdFR5cGU6IGRhdGE/LnVuaXRUeXBlIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgICAgICB1bml0SWQ6IGRhdGE/LnVuaXRJZCBhcyBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgICAgICAgc3RhZ2U6IFwic3RhZ2VcIixcbiAgICAgICAgICBhY3Rpb246IG9wdGlvbnMuZ2l0QWN0aW9uLFxuICAgICAgICAgIHB1c2g6IG9wdGlvbnMuZ2l0UHVzaCxcbiAgICAgICAgICBzdGF0dXM6IFwib2tcIixcbiAgICAgICAgICBtZXRhZGF0YTogbmV4dFNlcXVlbmNlTWV0YWRhdGEoXCJnaXRvcHNcIiwgXCJ1cGRhdGVcIiwgeyBhY3Rpb24gfSksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgaWYgKHBoYXNlID09PSBcInVuaXRcIikge1xuICAgICAgICB3cml0ZVR1cm5HaXRUcmFuc2FjdGlvbih7XG4gICAgICAgICAgYmFzZVBhdGg6IG9wdGlvbnMuYmFzZVBhdGgsXG4gICAgICAgICAgdHJhY2VJZDogY3VycmVudC50cmFjZUlkLFxuICAgICAgICAgIHR1cm5JZDogY3VycmVudC50dXJuSWQsXG4gICAgICAgICAgdW5pdFR5cGU6IGRhdGE/LnVuaXRUeXBlIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgICAgICB1bml0SWQ6IGRhdGE/LnVuaXRJZCBhcyBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgICAgICAgc3RhZ2U6IFwiY2hlY2twb2ludFwiLFxuICAgICAgICAgIGFjdGlvbjogb3B0aW9ucy5naXRBY3Rpb24sXG4gICAgICAgICAgcHVzaDogb3B0aW9ucy5naXRQdXNoLFxuICAgICAgICAgIHN0YXR1czogXCJva1wiLFxuICAgICAgICAgIG1ldGFkYXRhOiBuZXh0U2VxdWVuY2VNZXRhZGF0YShcImdpdG9wc1wiLCBcInVwZGF0ZVwiLCB7IGFjdGlvbiB9KSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBpZiAocGhhc2UgPT09IFwiZmluYWxpemVcIikge1xuICAgICAgICB3cml0ZVR1cm5HaXRUcmFuc2FjdGlvbih7XG4gICAgICAgICAgYmFzZVBhdGg6IG9wdGlvbnMuYmFzZVBhdGgsXG4gICAgICAgICAgdHJhY2VJZDogY3VycmVudC50cmFjZUlkLFxuICAgICAgICAgIHR1cm5JZDogY3VycmVudC50dXJuSWQsXG4gICAgICAgICAgdW5pdFR5cGU6IGRhdGE/LnVuaXRUeXBlIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgICAgICB1bml0SWQ6IGRhdGE/LnVuaXRJZCBhcyBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgICAgICAgc3RhZ2U6IFwicHVibGlzaFwiLFxuICAgICAgICAgIGFjdGlvbjogb3B0aW9ucy5naXRBY3Rpb24sXG4gICAgICAgICAgcHVzaDogb3B0aW9ucy5naXRQdXNoLFxuICAgICAgICAgIHN0YXR1czogXCJva1wiLFxuICAgICAgICAgIG1ldGFkYXRhOiBuZXh0U2VxdWVuY2VNZXRhZGF0YShcImdpdG9wc1wiLCBcInVwZGF0ZVwiLCB7IGFjdGlvbiB9KSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSxcblxuICAgIG9uVHVyblJlc3VsdChyZXN1bHQpOiB2b2lkIHtcbiAgICAgIGNvbnN0IGNsZWFudXAgPSAoKTogdm9pZCA9PiB7XG4gICAgICAgIGlmICh3cml0ZXJUb2tlbikge1xuICAgICAgICAgIHJlbGVhc2VXcml0ZXJUb2tlbihvcHRpb25zLmJhc2VQYXRoLCB3cml0ZXJUb2tlbik7XG4gICAgICAgIH1cbiAgICAgICAgd3JpdGVyVG9rZW4gPSBudWxsO1xuICAgICAgICBjdXJyZW50ID0gbnVsbDtcbiAgICAgICAgcGhhc2VSZXN1bHRzLmxlbmd0aCA9IDA7XG4gICAgICB9O1xuXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBtZXJnZWQ6IFR1cm5SZXN1bHQgPSB7XG4gICAgICAgICAgLi4ucmVzdWx0LFxuICAgICAgICAgIHZlcnNpb246IENVUlJFTlRfVU9LX0NPTlRSQUNUX1ZFUlNJT04sXG4gICAgICAgICAgcGhhc2VSZXN1bHRzOiBBcnJheS5pc0FycmF5KHJlc3VsdC5waGFzZVJlc3VsdHMpICYmIHJlc3VsdC5waGFzZVJlc3VsdHMubGVuZ3RoID4gMCA/IHJlc3VsdC5waGFzZVJlc3VsdHMgOiBbLi4ucGhhc2VSZXN1bHRzXSxcbiAgICAgICAgfTtcbiAgICAgICAgY29uc3QgdmFsaWRhdGlvbiA9IHZhbGlkYXRlVHVyblJlc3VsdChtZXJnZWQpO1xuICAgICAgICBpZiAoIXZhbGlkYXRpb24ub2spIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgVU9LIHR1cm4gcmVzdWx0OiAke3ZhbGlkYXRpb24uaXNzdWVzLm1hcCgoaXNzdWUpID0+IGAke2lzc3VlLnBhdGh9OiAke2lzc3VlLm1lc3NhZ2V9YCkuam9pbihcIjsgXCIpfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuZW5hYmxlQXVkaXQpIHtcbiAgICAgICAgICBlbWl0VW9rQXVkaXRFdmVudChcbiAgICAgICAgICAgIG9wdGlvbnMuYmFzZVBhdGgsXG4gICAgICAgICAgICBidWlsZEF1ZGl0RW52ZWxvcGUoe1xuICAgICAgICAgICAgICB0cmFjZUlkOiB2YWxpZGF0aW9uLnZhbHVlLnRyYWNlSWQsXG4gICAgICAgICAgICAgIHR1cm5JZDogdmFsaWRhdGlvbi52YWx1ZS50dXJuSWQsXG4gICAgICAgICAgICAgIGNhdGVnb3J5OiBcIm9yY2hlc3RyYXRpb25cIixcbiAgICAgICAgICAgICAgdHlwZTogXCJ0dXJuLXJlc3VsdFwiLFxuICAgICAgICAgICAgICBwYXlsb2FkOiBuZXh0U2VxdWVuY2VNZXRhZGF0YShcImF1ZGl0XCIsIFwiYXBwZW5kXCIsIHtcbiAgICAgICAgICAgICAgICBjb250cmFjdFZlcnNpb246IHZhbGlkYXRpb24udmFsdWUudmVyc2lvbixcbiAgICAgICAgICAgICAgICB1bml0VHlwZTogdmFsaWRhdGlvbi52YWx1ZS51bml0VHlwZSxcbiAgICAgICAgICAgICAgICB1bml0SWQ6IHZhbGlkYXRpb24udmFsdWUudW5pdElkLFxuICAgICAgICAgICAgICAgIHN0YXR1czogdmFsaWRhdGlvbi52YWx1ZS5zdGF0dXMsXG4gICAgICAgICAgICAgICAgZmFpbHVyZUNsYXNzOiB2YWxpZGF0aW9uLnZhbHVlLmZhaWx1cmVDbGFzcyxcbiAgICAgICAgICAgICAgICBlcnJvcjogdmFsaWRhdGlvbi52YWx1ZS5lcnJvcixcbiAgICAgICAgICAgICAgICBwaGFzZUNvdW50OiB2YWxpZGF0aW9uLnZhbHVlLnBoYXNlUmVzdWx0cy5sZW5ndGgsXG4gICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvcHRpb25zLmVuYWJsZUdpdG9wcykge1xuICAgICAgICAgIGNvbnN0IGNsb3Nlb3V0OiBUdXJuQ2xvc2VvdXRSZWNvcmQgPSBtZXJnZWQuY2xvc2VvdXQgPz8ge1xuICAgICAgICAgICAgdHJhY2VJZDogbWVyZ2VkLnRyYWNlSWQsXG4gICAgICAgICAgICB0dXJuSWQ6IG1lcmdlZC50dXJuSWQsXG4gICAgICAgICAgICB1bml0VHlwZTogbWVyZ2VkLnVuaXRUeXBlLFxuICAgICAgICAgICAgdW5pdElkOiBtZXJnZWQudW5pdElkLFxuICAgICAgICAgICAgc3RhdHVzOiBtZXJnZWQuc3RhdHVzLFxuICAgICAgICAgICAgZmFpbHVyZUNsYXNzOiBtZXJnZWQuZmFpbHVyZUNsYXNzLFxuICAgICAgICAgICAgZ2l0QWN0aW9uOiBvcHRpb25zLmdpdEFjdGlvbixcbiAgICAgICAgICAgIGdpdFB1c2hlZDogb3B0aW9ucy5naXRQdXNoLFxuICAgICAgICAgICAgZmluaXNoZWRBdDogbWVyZ2VkLmZpbmlzaGVkQXQsXG4gICAgICAgICAgfTtcbiAgICAgICAgICB3cml0ZVR1cm5DbG9zZW91dEdpdFJlY29yZChcbiAgICAgICAgICAgIG9wdGlvbnMuYmFzZVBhdGgsXG4gICAgICAgICAgICBjbG9zZW91dCxcbiAgICAgICAgICAgIG5leHRTZXF1ZW5jZU1ldGFkYXRhKFwiZ2l0b3BzXCIsIFwidXBkYXRlXCIsIHsgYWN0aW9uOiBcInJlY29yZFwiIH0pLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGNsZWFudXAoKTtcbiAgICAgIH1cbiAgICB9LFxuICB9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBUUEsU0FBUyw4QkFBOEIsMEJBQTBCO0FBQ2pFLFNBQVMsb0JBQW9CLHlCQUF5QjtBQUN0RCxTQUFTLDRCQUE0QiwrQkFBK0I7QUFDcEUsU0FBUyxvQkFBb0IsaUJBQWlCLDBCQUEwQjtBQVVqRSxTQUFTLG1CQUFtQixTQUFxRDtBQUN0RixNQUFJLFVBQStCO0FBQ25DLE1BQUksY0FBNEQ7QUFDaEUsUUFBTSxlQUEyQyxDQUFDO0FBRWxELFdBQVMscUJBQ1AsVUFDQSxXQUNBLFVBQ3lCO0FBQ3pCLFFBQUksQ0FBQyxZQUFhLFFBQU8sWUFBWSxDQUFDO0FBQ3RDLFVBQU0sU0FBUyxnQkFBZ0I7QUFBQSxNQUM3QixVQUFVLFFBQVE7QUFBQSxNQUNsQixPQUFPO0FBQUEsTUFDUDtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRixDQUFDO0FBQ0QsV0FBTztBQUFBLE1BQ0wsR0FBSSxZQUFZLENBQUM7QUFBQSxNQUNqQixlQUFlLE9BQU8sU0FBUztBQUFBLE1BQy9CLGVBQWUsT0FBTyxZQUFZO0FBQUEsSUFDcEM7QUFBQSxFQUNGO0FBRUEsU0FBTztBQUFBLElBQ0wsWUFBWSxVQUFnQjtBQUMxQixnQkFBVTtBQUNWLG1CQUFhLFNBQVM7QUFDdEIsb0JBQWMsbUJBQW1CO0FBQUEsUUFDL0IsVUFBVSxRQUFRO0FBQUEsUUFDbEIsU0FBUyxTQUFTO0FBQUEsUUFDbEIsUUFBUSxTQUFTO0FBQUEsTUFDbkIsQ0FBQztBQUVELFVBQUksUUFBUSxjQUFjO0FBQ3hCLGdDQUF3QjtBQUFBLFVBQ3RCLFVBQVUsUUFBUTtBQUFBLFVBQ2xCLFNBQVMsU0FBUztBQUFBLFVBQ2xCLFFBQVEsU0FBUztBQUFBLFVBQ2pCLFVBQVUsU0FBUztBQUFBLFVBQ25CLFFBQVEsU0FBUztBQUFBLFVBQ2pC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
