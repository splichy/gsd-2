import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  SubagentRunStore,
  createInitialRunRecord,
  createSubagentTrackingName,
  deriveRunStatus
} from "../run-store.js";
describe("SubagentRunStore", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = void 0;
  });
  it("persists launch and successful completion evidence", () => {
    dir = mkdtempSync(join(tmpdir(), "gsd-subagent-runs-"));
    const store = new SubagentRunStore(dir);
    store.create(createInitialRunRecord({
      runId: "run-1",
      mode: "single",
      contextMode: "fresh",
      cwd: "/repo",
      children: [{ agent: "scout", trackingName: "clear-beacon", task: "inspect" }],
      now: "2026-01-01T00:00:00.000Z"
    }));
    store.update("run-1", (record) => ({
      ...record,
      status: "succeeded",
      completedAt: "2026-01-01T00:00:01.000Z",
      children: [{
        ...record.children[0],
        status: "succeeded",
        exitCode: 0,
        output: "done"
      }]
    }));
    const loaded = store.get("run-1");
    assert.equal(loaded?.status, "succeeded");
    assert.equal(loaded?.children[0]?.trackingName, "clear-beacon");
    assert.equal(loaded?.children[0]?.output, "done");
    assert.equal(store.list()[0]?.runId, "run-1");
  });
  it("generates unique tracking names for child agents", () => {
    const names = /* @__PURE__ */ new Set();
    for (let i = 0; i < 24; i++) {
      const name = createSubagentTrackingName(names);
      assert.match(name, /^[a-z]+-[a-z]+$|^agent-\d+$/);
      assert.equal(names.has(name), false);
      names.add(name);
    }
  });
  it("persists failed and interrupted child evidence", () => {
    dir = mkdtempSync(join(tmpdir(), "gsd-subagent-runs-"));
    const store = new SubagentRunStore(dir);
    store.create(createInitialRunRecord({
      runId: "run-2",
      mode: "parallel",
      contextMode: "fork",
      cwd: "/repo",
      children: [
        { agent: "tester", task: "verify" },
        { agent: "reviewer", task: "review" }
      ]
    }));
    store.update("run-2", (record) => ({
      ...record,
      status: "interrupted",
      children: [
        {
          ...record.children[0],
          status: "failed",
          exitCode: 1,
          errorMessage: "verification failed"
        },
        {
          ...record.children[1],
          status: "interrupted",
          exitCode: 1,
          stopReason: "aborted"
        }
      ],
      failure: { type: "interrupted", message: "run aborted" }
    }));
    const loaded = store.get("run-2");
    assert.equal(loaded?.status, "interrupted");
    assert.equal(loaded?.children[0]?.errorMessage, "verification failed");
    assert.equal(loaded?.children[1]?.stopReason, "aborted");
    assert.equal(loaded?.failure?.type, "interrupted");
  });
  it("derives failed and interrupted status from child artifacts", () => {
    assert.equal(deriveRunStatus([{ index: 0, agent: "a", task: "t", status: "failed" }]), "failed");
    assert.equal(deriveRunStatus([{ index: 0, agent: "a", task: "t", status: "interrupted" }]), "interrupted");
    assert.equal(deriveRunStatus([{ index: 0, agent: "a", task: "t", status: "succeeded" }]), "succeeded");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3N1YmFnZW50L3Rlc3RzL3J1bi1zdG9yZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QtMiArIFN1YmFnZW50IGR1cmFibGUgcnVuLXN0b3JlIHRlc3RzLlxuXG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBhZnRlckVhY2gsIGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcblxuaW1wb3J0IHtcblx0U3ViYWdlbnRSdW5TdG9yZSxcblx0Y3JlYXRlSW5pdGlhbFJ1blJlY29yZCxcblx0Y3JlYXRlU3ViYWdlbnRUcmFja2luZ05hbWUsXG5cdGRlcml2ZVJ1blN0YXR1cyxcbn0gZnJvbSBcIi4uL3J1bi1zdG9yZS5qc1wiO1xuXG5kZXNjcmliZShcIlN1YmFnZW50UnVuU3RvcmVcIiwgKCkgPT4ge1xuXHRsZXQgZGlyOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cblx0YWZ0ZXJFYWNoKCgpID0+IHtcblx0XHRpZiAoZGlyKSBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cdFx0ZGlyID0gdW5kZWZpbmVkO1xuXHR9KTtcblxuXHRpdChcInBlcnNpc3RzIGxhdW5jaCBhbmQgc3VjY2Vzc2Z1bCBjb21wbGV0aW9uIGV2aWRlbmNlXCIsICgpID0+IHtcblx0XHRkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1zdWJhZ2VudC1ydW5zLVwiKSk7XG5cdFx0Y29uc3Qgc3RvcmUgPSBuZXcgU3ViYWdlbnRSdW5TdG9yZShkaXIpO1xuXHRcdHN0b3JlLmNyZWF0ZShjcmVhdGVJbml0aWFsUnVuUmVjb3JkKHtcblx0XHRcdHJ1bklkOiBcInJ1bi0xXCIsXG5cdFx0XHRtb2RlOiBcInNpbmdsZVwiLFxuXHRcdFx0Y29udGV4dE1vZGU6IFwiZnJlc2hcIixcblx0XHRcdGN3ZDogXCIvcmVwb1wiLFxuXHRcdFx0Y2hpbGRyZW46IFt7IGFnZW50OiBcInNjb3V0XCIsIHRyYWNraW5nTmFtZTogXCJjbGVhci1iZWFjb25cIiwgdGFzazogXCJpbnNwZWN0XCIgfV0sXG5cdFx0XHRub3c6IFwiMjAyNi0wMS0wMVQwMDowMDowMC4wMDBaXCIsXG5cdFx0fSkpO1xuXG5cdFx0c3RvcmUudXBkYXRlKFwicnVuLTFcIiwgKHJlY29yZCkgPT4gKHtcblx0XHRcdC4uLnJlY29yZCxcblx0XHRcdHN0YXR1czogXCJzdWNjZWVkZWRcIixcblx0XHRcdGNvbXBsZXRlZEF0OiBcIjIwMjYtMDEtMDFUMDA6MDA6MDEuMDAwWlwiLFxuXHRcdFx0Y2hpbGRyZW46IFt7XG5cdFx0XHRcdC4uLnJlY29yZC5jaGlsZHJlblswXSxcblx0XHRcdFx0c3RhdHVzOiBcInN1Y2NlZWRlZFwiLFxuXHRcdFx0XHRleGl0Q29kZTogMCxcblx0XHRcdFx0b3V0cHV0OiBcImRvbmVcIixcblx0XHRcdH1dLFxuXHRcdH0pKTtcblxuXHRcdGNvbnN0IGxvYWRlZCA9IHN0b3JlLmdldChcInJ1bi0xXCIpO1xuXHRcdGFzc2VydC5lcXVhbChsb2FkZWQ/LnN0YXR1cywgXCJzdWNjZWVkZWRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGxvYWRlZD8uY2hpbGRyZW5bMF0/LnRyYWNraW5nTmFtZSwgXCJjbGVhci1iZWFjb25cIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGxvYWRlZD8uY2hpbGRyZW5bMF0/Lm91dHB1dCwgXCJkb25lXCIpO1xuXHRcdGFzc2VydC5lcXVhbChzdG9yZS5saXN0KClbMF0/LnJ1bklkLCBcInJ1bi0xXCIpO1xuXHR9KTtcblxuXHRpdChcImdlbmVyYXRlcyB1bmlxdWUgdHJhY2tpbmcgbmFtZXMgZm9yIGNoaWxkIGFnZW50c1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgbmFtZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IDI0OyBpKyspIHtcblx0XHRcdGNvbnN0IG5hbWUgPSBjcmVhdGVTdWJhZ2VudFRyYWNraW5nTmFtZShuYW1lcyk7XG5cdFx0XHRhc3NlcnQubWF0Y2gobmFtZSwgL15bYS16XSstW2Etel0rJHxeYWdlbnQtXFxkKyQvKTtcblx0XHRcdGFzc2VydC5lcXVhbChuYW1lcy5oYXMobmFtZSksIGZhbHNlKTtcblx0XHRcdG5hbWVzLmFkZChuYW1lKTtcblx0XHR9XG5cdH0pO1xuXG5cdGl0KFwicGVyc2lzdHMgZmFpbGVkIGFuZCBpbnRlcnJ1cHRlZCBjaGlsZCBldmlkZW5jZVwiLCAoKSA9PiB7XG5cdFx0ZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtc3ViYWdlbnQtcnVucy1cIikpO1xuXHRcdGNvbnN0IHN0b3JlID0gbmV3IFN1YmFnZW50UnVuU3RvcmUoZGlyKTtcblx0XHRzdG9yZS5jcmVhdGUoY3JlYXRlSW5pdGlhbFJ1blJlY29yZCh7XG5cdFx0XHRydW5JZDogXCJydW4tMlwiLFxuXHRcdFx0bW9kZTogXCJwYXJhbGxlbFwiLFxuXHRcdFx0Y29udGV4dE1vZGU6IFwiZm9ya1wiLFxuXHRcdFx0Y3dkOiBcIi9yZXBvXCIsXG5cdFx0XHRjaGlsZHJlbjogW1xuXHRcdFx0XHR7IGFnZW50OiBcInRlc3RlclwiLCB0YXNrOiBcInZlcmlmeVwiIH0sXG5cdFx0XHRcdHsgYWdlbnQ6IFwicmV2aWV3ZXJcIiwgdGFzazogXCJyZXZpZXdcIiB9LFxuXHRcdFx0XSxcblx0XHR9KSk7XG5cblx0XHRzdG9yZS51cGRhdGUoXCJydW4tMlwiLCAocmVjb3JkKSA9PiAoe1xuXHRcdFx0Li4ucmVjb3JkLFxuXHRcdFx0c3RhdHVzOiBcImludGVycnVwdGVkXCIsXG5cdFx0XHRjaGlsZHJlbjogW1xuXHRcdFx0XHR7XG5cdFx0XHRcdFx0Li4ucmVjb3JkLmNoaWxkcmVuWzBdLFxuXHRcdFx0XHRcdHN0YXR1czogXCJmYWlsZWRcIixcblx0XHRcdFx0XHRleGl0Q29kZTogMSxcblx0XHRcdFx0XHRlcnJvck1lc3NhZ2U6IFwidmVyaWZpY2F0aW9uIGZhaWxlZFwiLFxuXHRcdFx0XHR9LFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0Li4ucmVjb3JkLmNoaWxkcmVuWzFdLFxuXHRcdFx0XHRcdHN0YXR1czogXCJpbnRlcnJ1cHRlZFwiLFxuXHRcdFx0XHRcdGV4aXRDb2RlOiAxLFxuXHRcdFx0XHRcdHN0b3BSZWFzb246IFwiYWJvcnRlZFwiLFxuXHRcdFx0XHR9LFxuXHRcdFx0XSxcblx0XHRcdGZhaWx1cmU6IHsgdHlwZTogXCJpbnRlcnJ1cHRlZFwiLCBtZXNzYWdlOiBcInJ1biBhYm9ydGVkXCIgfSxcblx0XHR9KSk7XG5cblx0XHRjb25zdCBsb2FkZWQgPSBzdG9yZS5nZXQoXCJydW4tMlwiKTtcblx0XHRhc3NlcnQuZXF1YWwobG9hZGVkPy5zdGF0dXMsIFwiaW50ZXJydXB0ZWRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGxvYWRlZD8uY2hpbGRyZW5bMF0/LmVycm9yTWVzc2FnZSwgXCJ2ZXJpZmljYXRpb24gZmFpbGVkXCIpO1xuXHRcdGFzc2VydC5lcXVhbChsb2FkZWQ/LmNoaWxkcmVuWzFdPy5zdG9wUmVhc29uLCBcImFib3J0ZWRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGxvYWRlZD8uZmFpbHVyZT8udHlwZSwgXCJpbnRlcnJ1cHRlZFwiKTtcblx0fSk7XG5cblx0aXQoXCJkZXJpdmVzIGZhaWxlZCBhbmQgaW50ZXJydXB0ZWQgc3RhdHVzIGZyb20gY2hpbGQgYXJ0aWZhY3RzXCIsICgpID0+IHtcblx0XHRhc3NlcnQuZXF1YWwoZGVyaXZlUnVuU3RhdHVzKFt7IGluZGV4OiAwLCBhZ2VudDogXCJhXCIsIHRhc2s6IFwidFwiLCBzdGF0dXM6IFwiZmFpbGVkXCIgfV0pLCBcImZhaWxlZFwiKTtcblx0XHRhc3NlcnQuZXF1YWwoZGVyaXZlUnVuU3RhdHVzKFt7IGluZGV4OiAwLCBhZ2VudDogXCJhXCIsIHRhc2s6IFwidFwiLCBzdGF0dXM6IFwiaW50ZXJydXB0ZWRcIiB9XSksIFwiaW50ZXJydXB0ZWRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGRlcml2ZVJ1blN0YXR1cyhbeyBpbmRleDogMCwgYWdlbnQ6IFwiYVwiLCB0YXNrOiBcInRcIiwgc3RhdHVzOiBcInN1Y2NlZWRlZFwiIH1dKSwgXCJzdWNjZWVkZWRcIik7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLGNBQWM7QUFDcEMsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsWUFBWTtBQUNyQixTQUFTLFdBQVcsVUFBVSxVQUFVO0FBRXhDO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFFUCxTQUFTLG9CQUFvQixNQUFNO0FBQ2xDLE1BQUk7QUFFSixZQUFVLE1BQU07QUFDZixRQUFJLElBQUssUUFBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQ3JELFVBQU07QUFBQSxFQUNQLENBQUM7QUFFRCxLQUFHLHNEQUFzRCxNQUFNO0FBQzlELFVBQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyxvQkFBb0IsQ0FBQztBQUN0RCxVQUFNLFFBQVEsSUFBSSxpQkFBaUIsR0FBRztBQUN0QyxVQUFNLE9BQU8sdUJBQXVCO0FBQUEsTUFDbkMsT0FBTztBQUFBLE1BQ1AsTUFBTTtBQUFBLE1BQ04sYUFBYTtBQUFBLE1BQ2IsS0FBSztBQUFBLE1BQ0wsVUFBVSxDQUFDLEVBQUUsT0FBTyxTQUFTLGNBQWMsZ0JBQWdCLE1BQU0sVUFBVSxDQUFDO0FBQUEsTUFDNUUsS0FBSztBQUFBLElBQ04sQ0FBQyxDQUFDO0FBRUYsVUFBTSxPQUFPLFNBQVMsQ0FBQyxZQUFZO0FBQUEsTUFDbEMsR0FBRztBQUFBLE1BQ0gsUUFB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
