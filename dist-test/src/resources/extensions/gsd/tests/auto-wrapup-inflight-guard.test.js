import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { autoSession } from "../auto-runtime-state.js";
import { dispatchHookUnit } from "../auto.js";
import { registerHooks } from "../bootstrap/register-hooks.js";
import { clearDiscussionFlowState, getPendingGate } from "../bootstrap/write-gate.js";
function makeHookHarness() {
  const handlers = /* @__PURE__ */ new Map();
  const pi = {
    on(name, handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    }
  };
  const ctx = {
    ui: {
      notify: () => {
      },
      setStatus: () => {
      },
      setWidget: () => {
      }
    },
    modelRegistry: {
      setDisabledModelProviders: () => {
      }
    },
    setCompactionThresholdOverride: () => {
    }
  };
  async function emit(name, event) {
    for (const handler of handlers.get(name) ?? []) {
      const result = await handler(event, ctx);
      if (result?.block) return result;
    }
    return void 0;
  }
  registerHooks(pi, []);
  return { emit };
}
describe("hook dispatch session workspace root", () => {
  test("dispatchHookUnit passes basePath explicitly to newSession", async (t) => {
    const originalCwd = process.cwd();
    const basePath = mkdtempSync(join(tmpdir(), "gsd-hook-cwd-"));
    mkdirSync(join(basePath, ".gsd"), { recursive: true });
    autoSession.reset();
    t.after(() => {
      try {
        process.chdir(originalCwd);
      } catch {
      }
      autoSession.reset();
      rmSync(basePath, { recursive: true, force: true });
    });
    let newSessionOptions;
    const ctx = {
      ui: {
        notify: () => {
        },
        setStatus: () => {
        },
        setWidget: () => {
        }
      },
      modelRegistry: {
        getAvailable: () => []
      },
      sessionManager: {
        getSessionFile: () => join(basePath, "session.jsonl")
      },
      newSession: async (options) => {
        newSessionOptions = options;
        return { cancelled: false };
      }
    };
    const pi = {
      sendMessage: () => {
      },
      setModel: async () => true
    };
    const dispatched = await dispatchHookUnit(
      ctx,
      pi,
      "review",
      "execute-task",
      "M001/S01/T01",
      "review the completed unit",
      void 0,
      basePath
    );
    assert.equal(dispatched, true);
    assert.deepEqual(newSessionOptions, { workspaceRoot: basePath });
  });
});
describe("deep setup approval questions pause immediately", () => {
  test("plain-text approval boundary defers durable gate until same-turn CONTEXT-DRAFT can save", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-deferred-approval-")));
    const previousCwd = process.cwd();
    try {
      mkdirSync(join(base, ".gsd", "milestones", "M003"), { recursive: true });
      process.chdir(base);
      clearDiscussionFlowState(base);
      autoSession.reset();
      autoSession.basePath = base;
      autoSession.currentUnit = {
        type: "discuss-milestone",
        id: "M003",
        startedAt: Date.now()
      };
      const { emit } = makeHookHarness();
      await emit("message_update", {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Did I capture that correctly? If not, tell me what I missed." }]
        }
      });
      assert.equal(
        getPendingGate(base),
        null,
        "approval text should not install the durable pending gate until the assistant turn ends"
      );
      const draftResult = await emit("tool_call", {
        toolCallId: "draft-save",
        toolName: "gsd_summary_save",
        input: {
          milestone_id: "M003",
          artifact_type: "CONTEXT-DRAFT",
          content: "# M003 Draft\n"
        }
      });
      assert.equal(
        draftResult?.block,
        void 0,
        "same-turn CONTEXT-DRAFT persistence should remain allowed after the approval text streams"
      );
      const finalContextResult = await emit("tool_call", {
        toolCallId: "final-context",
        toolName: "gsd_summary_save",
        input: {
          milestone_id: "M003",
          artifact_type: "CONTEXT",
          content: "# M003 Context\n"
        }
      });
      assert.equal(finalContextResult?.block, true, "final CONTEXT must still wait for approval");
      assert.match(finalContextResult.reason, /Approval question "depth_verification_M003_confirm"/);
      await emit("agent_end", { messages: [] });
      assert.equal(
        getPendingGate(base),
        "depth_verification_M003_confirm",
        "agent_end should activate the durable pending gate for the next turn"
      );
    } finally {
      process.chdir(previousCwd);
      autoSession.reset();
      clearDiscussionFlowState(base);
      rmSync(base, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLXdyYXB1cC1pbmZsaWdodC1ndWFyZC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QtMiBcdTIwMTQgUmVncmVzc2lvbiB0ZXN0cyBmb3IgIzM1MTI6IGdzZC1hdXRvLXdyYXB1cCBtaWQtdHVybiBpbnRlcnJ1cHRpb25cbi8vIENvcHlyaWdodCAoYykgMjAyNiBKZXJlbXkgTWNTcGFkZGVuIDxqZXJlbXlAZmx1eGxhYnMubmV0PlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcmVhbHBhdGhTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7IGF1dG9TZXNzaW9uIH0gZnJvbSBcIi4uL2F1dG8tcnVudGltZS1zdGF0ZS50c1wiO1xuaW1wb3J0IHsgZGlzcGF0Y2hIb29rVW5pdCB9IGZyb20gXCIuLi9hdXRvLnRzXCI7XG5pbXBvcnQgeyByZWdpc3Rlckhvb2tzIH0gZnJvbSBcIi4uL2Jvb3RzdHJhcC9yZWdpc3Rlci1ob29rcy50c1wiO1xuaW1wb3J0IHsgY2xlYXJEaXNjdXNzaW9uRmxvd1N0YXRlLCBnZXRQZW5kaW5nR2F0ZSB9IGZyb20gXCIuLi9ib290c3RyYXAvd3JpdGUtZ2F0ZS50c1wiO1xuXG5mdW5jdGlvbiBtYWtlSG9va0hhcm5lc3MoKSB7XG4gIGNvbnN0IGhhbmRsZXJzID0gbmV3IE1hcDxzdHJpbmcsIEFycmF5PChldmVudDogYW55LCBjdHg6IGFueSkgPT4gUHJvbWlzZTxhbnk+Pj4oKTtcbiAgY29uc3QgcGkgPSB7XG4gICAgb24obmFtZTogc3RyaW5nLCBoYW5kbGVyOiAoZXZlbnQ6IGFueSwgY3R4OiBhbnkpID0+IFByb21pc2U8YW55Pikge1xuICAgICAgY29uc3QgY3VycmVudCA9IGhhbmRsZXJzLmdldChuYW1lKSA/PyBbXTtcbiAgICAgIGN1cnJlbnQucHVzaChoYW5kbGVyKTtcbiAgICAgIGhhbmRsZXJzLnNldChuYW1lLCBjdXJyZW50KTtcbiAgICB9LFxuICB9O1xuICBjb25zdCBjdHggPSB7XG4gICAgdWk6IHtcbiAgICAgIG5vdGlmeTogKCkgPT4ge30sXG4gICAgICBzZXRTdGF0dXM6ICgpID0+IHt9LFxuICAgICAgc2V0V2lkZ2V0OiAoKSA9PiB7fSxcbiAgICB9LFxuICAgIG1vZGVsUmVnaXN0cnk6IHtcbiAgICAgIHNldERpc2FibGVkTW9kZWxQcm92aWRlcnM6ICgpID0+IHt9LFxuICAgIH0sXG4gICAgc2V0Q29tcGFjdGlvblRocmVzaG9sZE92ZXJyaWRlOiAoKSA9PiB7fSxcbiAgfTtcbiAgYXN5bmMgZnVuY3Rpb24gZW1pdChuYW1lOiBzdHJpbmcsIGV2ZW50OiBhbnkpOiBQcm9taXNlPGFueT4ge1xuICAgIGZvciAoY29uc3QgaGFuZGxlciBvZiBoYW5kbGVycy5nZXQobmFtZSkgPz8gW10pIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZXIoZXZlbnQsIGN0eCk7XG4gICAgICBpZiAocmVzdWx0Py5ibG9jaykgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICByZWdpc3Rlckhvb2tzKHBpIGFzIGFueSwgW10pO1xuICByZXR1cm4geyBlbWl0IH07XG59XG5cbmRlc2NyaWJlKFwiaG9vayBkaXNwYXRjaCBzZXNzaW9uIHdvcmtzcGFjZSByb290XCIsICgpID0+IHtcbiAgdGVzdChcImRpc3BhdGNoSG9va1VuaXQgcGFzc2VzIGJhc2VQYXRoIGV4cGxpY2l0bHkgdG8gbmV3U2Vzc2lvblwiLCBhc3luYyAodCkgPT4ge1xuICAgIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICBjb25zdCBiYXNlUGF0aCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWhvb2stY3dkLVwiKSk7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgYXV0b1Nlc3Npb24ucmVzZXQoKTtcbiAgICB0LmFmdGVyKCgpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHByb2Nlc3MuY2hkaXIob3JpZ2luYWxDd2QpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIGJlc3QgZWZmb3J0IGNsZWFudXAgYWZ0ZXIgY3dkLXNlbnNpdGl2ZSBkaXNwYXRjaCB0ZXN0c1xuICAgICAgfVxuICAgICAgYXV0b1Nlc3Npb24ucmVzZXQoKTtcbiAgICAgIHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH0pO1xuXG4gICAgbGV0IG5ld1Nlc3Npb25PcHRpb25zOiB1bmtub3duO1xuICAgIGNvbnN0IGN0eCA9IHtcbiAgICAgIHVpOiB7XG4gICAgICAgIG5vdGlmeTogKCkgPT4ge30sXG4gICAgICAgIHNldFN0YXR1czogKCkgPT4ge30sXG4gICAgICAgIHNldFdpZGdldDogKCkgPT4ge30sXG4gICAgICB9LFxuICAgICAgbW9kZWxSZWdpc3RyeToge1xuICAgICAgICBnZXRBdmFpbGFibGU6ICgpID0+IFtdLFxuICAgICAgfSxcbiAgICAgIHNlc3Npb25NYW5hZ2VyOiB7XG4gICAgICAgIGdldFNlc3Npb25GaWxlOiAoKSA9PiBqb2luKGJhc2VQYXRoLCBcInNlc3Npb24uanNvbmxcIiksXG4gICAgICB9LFxuICAgICAgbmV3U2Vzc2lvbjogYXN5bmMgKG9wdGlvbnM/OiB1bmtub3duKSA9PiB7XG4gICAgICAgIG5ld1Nlc3Npb25PcHRpb25zID0gb3B0aW9ucztcbiAgICAgICAgcmV0dXJuIHsgY2FuY2VsbGVkOiBmYWxzZSB9O1xuICAgICAgfSxcbiAgICB9O1xuICAgIGNvbnN0IHBpID0ge1xuICAgICAgc2VuZE1lc3NhZ2U6ICgpID0+IHt9LFxuICAgICAgc2V0TW9kZWw6IGFzeW5jICgpID0+IHRydWUsXG4gICAgfTtcblxuICAgIGNvbnN0IGRpc3BhdGNoZWQgPSBhd2FpdCBkaXNwYXRjaEhvb2tVbml0KFxuICAgICAgY3R4IGFzIGFueSxcbiAgICAgIHBpIGFzIGFueSxcbiAgICAgIFwicmV2aWV3XCIsXG4gICAgICBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgIFwicmV2aWV3IHRoZSBjb21wbGV0ZWQgdW5pdFwiLFxuICAgICAgdW5kZWZpbmVkLFxuICAgICAgYmFzZVBhdGgsXG4gICAgKTtcblxuICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaGVkLCB0cnVlKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKG5ld1Nlc3Npb25PcHRpb25zLCB7IHdvcmtzcGFjZVJvb3Q6IGJhc2VQYXRoIH0pO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcImRlZXAgc2V0dXAgYXBwcm92YWwgcXVlc3Rpb25zIHBhdXNlIGltbWVkaWF0ZWx5XCIsICgpID0+IHtcbiAgdGVzdChcInBsYWluLXRleHQgYXBwcm92YWwgYm91bmRhcnkgZGVmZXJzIGR1cmFibGUgZ2F0ZSB1bnRpbCBzYW1lLXR1cm4gQ09OVEVYVC1EUkFGVCBjYW4gc2F2ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IHJlYWxwYXRoU3luYyhta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1kZWZlcnJlZC1hcHByb3ZhbC1cIikpKTtcbiAgICBjb25zdCBwcmV2aW91c0N3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gICAgdHJ5IHtcbiAgICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG4gICAgICBjbGVhckRpc2N1c3Npb25GbG93U3RhdGUoYmFzZSk7XG4gICAgICBhdXRvU2Vzc2lvbi5yZXNldCgpO1xuICAgICAgYXV0b1Nlc3Npb24uYmFzZVBhdGggPSBiYXNlO1xuICAgICAgYXV0b1Nlc3Npb24uY3VycmVudFVuaXQgPSB7XG4gICAgICAgIHR5cGU6IFwiZGlzY3Vzcy1taWxlc3RvbmVcIixcbiAgICAgICAgaWQ6IFwiTTAwM1wiLFxuICAgICAgICBzdGFydGVkQXQ6IERhdGUubm93KCksXG4gICAgICB9O1xuXG4gICAgICBjb25zdCB7IGVtaXQgfSA9IG1ha2VIb29rSGFybmVzcygpO1xuICAgICAgYXdhaXQgZW1pdChcIm1lc3NhZ2VfdXBkYXRlXCIsIHtcbiAgICAgICAgbWVzc2FnZToge1xuICAgICAgICAgIHJvbGU6IFwiYXNzaXN0YW50XCIsXG4gICAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRGlkIEkgY2FwdHVyZSB0aGF0IGNvcnJlY3RseT8gSWYgbm90LCB0ZWxsIG1lIHdoYXQgSSBtaXNzZWQuXCIgfV0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgICBnZXRQZW5kaW5nR2F0ZShiYXNlKSxcbiAgICAgICAgbnVsbCxcbiAgICAgICAgXCJhcHByb3ZhbCB0ZXh0IHNob3VsZCBub3QgaW5zdGFsbCB0aGUgZHVyYWJsZSBwZW5kaW5nIGdhdGUgdW50aWwgdGhlIGFzc2lzdGFudCB0dXJuIGVuZHNcIixcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IGRyYWZ0UmVzdWx0ID0gYXdhaXQgZW1pdChcInRvb2xfY2FsbFwiLCB7XG4gICAgICAgIHRvb2xDYWxsSWQ6IFwiZHJhZnQtc2F2ZVwiLFxuICAgICAgICB0b29sTmFtZTogXCJnc2Rfc3VtbWFyeV9zYXZlXCIsXG4gICAgICAgIGlucHV0OiB7XG4gICAgICAgICAgbWlsZXN0b25lX2lkOiBcIk0wMDNcIixcbiAgICAgICAgICBhcnRpZmFjdF90eXBlOiBcIkNPTlRFWFQtRFJBRlRcIixcbiAgICAgICAgICBjb250ZW50OiBcIiMgTTAwMyBEcmFmdFxcblwiLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgICBhc3NlcnQuZXF1YWwoXG4gICAgICAgIGRyYWZ0UmVzdWx0Py5ibG9jayxcbiAgICAgICAgdW5kZWZpbmVkLFxuICAgICAgICBcInNhbWUtdHVybiBDT05URVhULURSQUZUIHBlcnNpc3RlbmNlIHNob3VsZCByZW1haW4gYWxsb3dlZCBhZnRlciB0aGUgYXBwcm92YWwgdGV4dCBzdHJlYW1zXCIsXG4gICAgICApO1xuXG4gICAgICBjb25zdCBmaW5hbENvbnRleHRSZXN1bHQgPSBhd2FpdCBlbWl0KFwidG9vbF9jYWxsXCIsIHtcbiAgICAgICAgdG9vbENhbGxJZDogXCJmaW5hbC1jb250ZXh0XCIsXG4gICAgICAgIHRvb2xOYW1lOiBcImdzZF9zdW1tYXJ5X3NhdmVcIixcbiAgICAgICAgaW5wdXQ6IHtcbiAgICAgICAgICBtaWxlc3RvbmVfaWQ6IFwiTTAwM1wiLFxuICAgICAgICAgIGFydGlmYWN0X3R5cGU6IFwiQ09OVEVYVFwiLFxuICAgICAgICAgIGNvbnRlbnQ6IFwiIyBNMDAzIENvbnRleHRcXG5cIixcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgYXNzZXJ0LmVxdWFsKGZpbmFsQ29udGV4dFJlc3VsdD8uYmxvY2ssIHRydWUsIFwiZmluYWwgQ09OVEVYVCBtdXN0IHN0aWxsIHdhaXQgZm9yIGFwcHJvdmFsXCIpO1xuICAgICAgYXNzZXJ0Lm1hdGNoKGZpbmFsQ29udGV4dFJlc3VsdC5yZWFzb24sIC9BcHByb3ZhbCBxdWVzdGlvbiBcImRlcHRoX3ZlcmlmaWNhdGlvbl9NMDAzX2NvbmZpcm1cIi8pO1xuXG4gICAgICBhd2FpdCBlbWl0KFwiYWdlbnRfZW5kXCIsIHsgbWVzc2FnZXM6IFtdIH0pO1xuICAgICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgICBnZXRQZW5kaW5nR2F0ZShiYXNlKSxcbiAgICAgICAgXCJkZXB0aF92ZXJpZmljYXRpb25fTTAwM19jb25maXJtXCIsXG4gICAgICAgIFwiYWdlbnRfZW5kIHNob3VsZCBhY3RpdmF0ZSB0aGUgZHVyYWJsZSBwZW5kaW5nIGdhdGUgZm9yIHRoZSBuZXh0IHR1cm5cIixcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIocHJldmlvdXNDd2QpO1xuICAgICAgYXV0b1Nlc3Npb24ucmVzZXQoKTtcbiAgICAgIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZShiYXNlKTtcbiAgICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLGNBQWMsY0FBYztBQUM3RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMsd0JBQXdCO0FBQ2pDLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsMEJBQTBCLHNCQUFzQjtBQUV6RCxTQUFTLGtCQUFrQjtBQUN6QixRQUFNLFdBQVcsb0JBQUksSUFBMkQ7QUFDaEYsUUFBTSxLQUFLO0FBQUEsSUFDVCxHQUFHLE1BQWMsU0FBaUQ7QUFDaEUsWUFBTSxVQUFVLFNBQVMsSUFBSSxJQUFJLEtBQUssQ0FBQztBQUN2QyxjQUFRLEtBQUssT0FBTztBQUNwQixlQUFTLElBQUksTUFBTSxPQUFPO0FBQUEsSUFDNUI7QUFBQSxFQUNGO0FBQ0EsUUFBTSxNQUFNO0FBQUEsSUFDVixJQUFJO0FBQUEsTUFDRixRQUFRLE1BQU07QUFBQSxNQUFDO0FBQUEsTUFDZixXQUFXLE1BQU07QUFBQSxNQUFDO0FBQUEsTUFDbEIsV0FBVyxNQUFNO0FBQUEsTUFB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
