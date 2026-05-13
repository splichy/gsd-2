import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decideMemoryPressure } from "../auto/workflow-kernel.js";
import { completeWorkflowIteration } from "../auto/workflow-iteration-completion.js";
import { measureMemoryPressure } from "../auto/workflow-memory-pressure.js";
describe("memory pressure monitoring (#3331)", () => {
  test("measureMemoryPressure reports pressure above threshold", () => {
    const snapshot = measureMemoryPressure({
      threshold: 0.5,
      deps: {
        memoryUsage: () => ({ heapUsed: 768 * 1024 * 1024 }),
        heapLimitBytes: () => 1024 * 1024 * 1024
      }
    });
    assert.equal(snapshot.pressured, true);
    assert.equal(snapshot.heapMB, 768);
    assert.equal(snapshot.limitMB, 1024);
  });
  test("measureMemoryPressure defaults to a sub-100-percent threshold", () => {
    const snapshot = measureMemoryPressure({
      deps: {
        memoryUsage: () => ({ heapUsed: 3584 * 1024 * 1024 }),
        heapLimitBytes: () => 4096 * 1024 * 1024
      }
    });
    assert.equal(snapshot.pressured, true);
  });
  test("memory pressure triggers graceful stopAuto", () => {
    const decision = decideMemoryPressure({
      pressured: true,
      heapMB: 3900,
      limitMB: 4096,
      pct: 0.95,
      iteration: 10
    });
    assert.equal(decision.action, "stop");
    assert.match(decision.stopMessage, /Stopping gracefully to prevent OOM/);
  });
});
describe("stuck detection persistence (#3704)", () => {
  test("completeWorkflowIteration saves stuck state while clearing recovery counters (#4382)", () => {
    const calls = [];
    const state = {
      consecutiveErrors: 2,
      consecutiveCooldowns: 1,
      recentErrorMessages: ["boom"]
    };
    completeWorkflowIteration(state, {
      emitIterationEnd: () => calls.push("emit"),
      saveStuckState: () => calls.push("save"),
      logIterationComplete: () => calls.push("log")
    });
    assert.deepEqual(calls, ["emit", "save", "log"]);
    assert.deepEqual(state, {
      consecutiveErrors: 0,
      consecutiveCooldowns: 0,
      recentErrorMessages: []
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9tZW1vcnktcHJlc3N1cmUtc3R1Y2stc3RhdGUudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSZWdyZXNzaW9uIHRlc3RzIGZvciBtZW1vcnkgcHJlc3N1cmUgbW9uaXRvcmluZyAoIzMzMzEpIGFuZFxuICogc3R1Y2sgZGV0ZWN0aW9uIHBlcnNpc3RlbmNlICgjMzcwNCkgaW4gYXV0by9sb29wLnRzLlxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbmltcG9ydCB7IGRlY2lkZU1lbW9yeVByZXNzdXJlIH0gZnJvbSBcIi4uL2F1dG8vd29ya2Zsb3cta2VybmVsLnRzXCI7XG5pbXBvcnQgeyBjb21wbGV0ZVdvcmtmbG93SXRlcmF0aW9uIH0gZnJvbSBcIi4uL2F1dG8vd29ya2Zsb3ctaXRlcmF0aW9uLWNvbXBsZXRpb24udHNcIjtcbmltcG9ydCB7IG1lYXN1cmVNZW1vcnlQcmVzc3VyZSB9IGZyb20gXCIuLi9hdXRvL3dvcmtmbG93LW1lbW9yeS1wcmVzc3VyZS50c1wiO1xuXG5kZXNjcmliZShcIm1lbW9yeSBwcmVzc3VyZSBtb25pdG9yaW5nICgjMzMzMSlcIiwgKCkgPT4ge1xuICB0ZXN0KFwibWVhc3VyZU1lbW9yeVByZXNzdXJlIHJlcG9ydHMgcHJlc3N1cmUgYWJvdmUgdGhyZXNob2xkXCIsICgpID0+IHtcbiAgICBjb25zdCBzbmFwc2hvdCA9IG1lYXN1cmVNZW1vcnlQcmVzc3VyZSh7XG4gICAgICB0aHJlc2hvbGQ6IDAuNSxcbiAgICAgIGRlcHM6IHtcbiAgICAgICAgbWVtb3J5VXNhZ2U6ICgpID0+ICh7IGhlYXBVc2VkOiA3NjggKiAxMDI0ICogMTAyNCB9KSxcbiAgICAgICAgaGVhcExpbWl0Qnl0ZXM6ICgpID0+IDEwMjQgKiAxMDI0ICogMTAyNCxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwoc25hcHNob3QucHJlc3N1cmVkLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoc25hcHNob3QuaGVhcE1CLCA3NjgpO1xuICAgIGFzc2VydC5lcXVhbChzbmFwc2hvdC5saW1pdE1CLCAxMDI0KTtcbiAgfSk7XG5cbiAgdGVzdChcIm1lYXN1cmVNZW1vcnlQcmVzc3VyZSBkZWZhdWx0cyB0byBhIHN1Yi0xMDAtcGVyY2VudCB0aHJlc2hvbGRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHNuYXBzaG90ID0gbWVhc3VyZU1lbW9yeVByZXNzdXJlKHtcbiAgICAgIGRlcHM6IHtcbiAgICAgICAgbWVtb3J5VXNhZ2U6ICgpID0+ICh7IGhlYXBVc2VkOiAzNTg0ICogMTAyNCAqIDEwMjQgfSksXG4gICAgICAgIGhlYXBMaW1pdEJ5dGVzOiAoKSA9PiA0MDk2ICogMTAyNCAqIDEwMjQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHNuYXBzaG90LnByZXNzdXJlZCwgdHJ1ZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJtZW1vcnkgcHJlc3N1cmUgdHJpZ2dlcnMgZ3JhY2VmdWwgc3RvcEF1dG9cIiwgKCkgPT4ge1xuICAgIGNvbnN0IGRlY2lzaW9uID0gZGVjaWRlTWVtb3J5UHJlc3N1cmUoe1xuICAgICAgcHJlc3N1cmVkOiB0cnVlLFxuICAgICAgaGVhcE1COiAzOTAwLFxuICAgICAgbGltaXRNQjogNDA5NixcbiAgICAgIHBjdDogMC45NSxcbiAgICAgIGl0ZXJhdGlvbjogMTAsXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwoZGVjaXNpb24uYWN0aW9uLCBcInN0b3BcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKGRlY2lzaW9uLnN0b3BNZXNzYWdlLCAvU3RvcHBpbmcgZ3JhY2VmdWxseSB0byBwcmV2ZW50IE9PTS8pO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcInN0dWNrIGRldGVjdGlvbiBwZXJzaXN0ZW5jZSAoIzM3MDQpXCIsICgpID0+IHtcbiAgLy8gUGhhc2UgQzogc3R1Y2stc3RhdGUuanNvbiBmaWxlIElPIGRlbGV0ZWQ7IHBlcnNpc3RlbmNlIG1vdmVkIHRvXG4gIC8vIHVuaXRfZGlzcGF0Y2hlcyAocmVjZW50VW5pdHMpICsgcnVudGltZV9rdiAoc3R1Y2tSZWNvdmVyeUF0dGVtcHRzKS5cbiAgLy8gVGhlIHN0dWNrLXN0YXRlLXZpYS1kYi50ZXN0LnRzIHN1aXRlIGNvdmVycyB0aGUgcm91bmQtdHJpcC5cblxuICB0ZXN0KFwiY29tcGxldGVXb3JrZmxvd0l0ZXJhdGlvbiBzYXZlcyBzdHVjayBzdGF0ZSB3aGlsZSBjbGVhcmluZyByZWNvdmVyeSBjb3VudGVycyAoIzQzODIpXCIsICgpID0+IHtcbiAgICBjb25zdCBjYWxsczogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBzdGF0ZSA9IHtcbiAgICAgIGNvbnNlY3V0aXZlRXJyb3JzOiAyLFxuICAgICAgY29uc2VjdXRpdmVDb29sZG93bnM6IDEsXG4gICAgICByZWNlbnRFcnJvck1lc3NhZ2VzOiBbXCJib29tXCJdLFxuICAgIH07XG5cbiAgICBjb21wbGV0ZVdvcmtmbG93SXRlcmF0aW9uKHN0YXRlLCB7XG4gICAgICBlbWl0SXRlcmF0aW9uRW5kOiAoKSA9PiBjYWxscy5wdXNoKFwiZW1pdFwiKSxcbiAgICAgIHNhdmVTdHVja1N0YXRlOiAoKSA9PiBjYWxscy5wdXNoKFwic2F2ZVwiKSxcbiAgICAgIGxvZ0l0ZXJhdGlvbkNvbXBsZXRlOiAoKSA9PiBjYWxscy5wdXNoKFwibG9nXCIpLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChjYWxscywgW1wiZW1pdFwiLCBcInNhdmVcIiwgXCJsb2dcIl0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoc3RhdGUsIHtcbiAgICAgIGNvbnNlY3V0aXZlRXJyb3JzOiAwLFxuICAgICAgY29uc2VjdXRpdmVDb29sZG93bnM6IDAsXG4gICAgICByZWNlbnRFcnJvck1lc3NhZ2VzOiBbXSxcbiAgICB9KTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUtBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUVuQixTQUFTLDRCQUE0QjtBQUNyQyxTQUFTLGlDQUFpQztBQUMxQyxTQUFTLDZCQUE2QjtBQUV0QyxTQUFTLHNDQUFzQyxNQUFNO0FBQ25ELE9BQUssMERBQTBELE1BQU07QUFDbkUsVUFBTSxXQUFXLHNCQUFzQjtBQUFBLE1BQ3JDLFdBQVc7QUFBQSxNQUNYLE1BQU07QUFBQSxRQUNKLGFBQWEsT0FBTyxFQUFFLFVBQVUsTUFBTSxPQUFPLEtBQUs7QUFBQSxRQUNsRCxnQkFBZ0IsTUFBTSxPQUFPLE9BQU87QUFBQSxNQUN0QztBQUFBLElBQ0YsQ0FBQztBQUVELFdBQU8sTUFBTSxTQUFTLFdBQVcsSUFBSTtBQUNyQyxXQUFPLE1BQU0sU0FBUyxRQUFRLEdBQUc7QUFDakMsV0FBTyxNQUFNLFNBQVMsU0FBUyxJQUFJO0FBQUEsRUFDckMsQ0FBQztBQUVELE9BQUssaUVBQWlFLE1BQU07QUFDMUUsVUFBTSxXQUFXLHNCQUFzQjtBQUFBLE1BQ3JDLE1BQU07QUFBQSxRQUNKLGFBQWEsT0FBTyxFQUFFLFVBQVUsT0FBTyxPQUFPLEtBQUs7QUFBQSxRQUNuRCxnQkFBZ0IsTUFBTSxPQUFPLE9BQU87QUFBQSxNQUN0QztBQUFBLElBQ0YsQ0FBQztBQUVELFdBQU8sTUFBTSxTQUFTLFdBQVcsSUFBSTtBQUFBLEVBQ3ZDLENBQUM7QUFFRCxPQUFLLDhDQUE4QyxNQUFNO0FBQ3ZELFVBQU0sV0FBVyxxQkFBcUI7QUFBQSxNQUNwQyxXQUFXO0FBQUEsTUFDWCxRQUFRO0FBQUEsTUFDUixTQUFTO0FBQUEsTUFDVCxLQUFLO0FBQUEsTUFDTCxXQUFXO0FBQUEsSUFDYixDQUFDO0FBRUQsV0FBTyxNQUFNLFNBQVMsUUFBUSxNQUFNO0FBQ3BDLFdBQU8sTUFBTSxTQUFTLGFBQWEsb0NBQW9DO0FBQUEsRUFDekUsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLHVDQUF1QyxNQUFNO0FBS3BELE9BQUssd0ZBQXdGLE1BQU07QUFDakcsVUFBTSxRQUFrQixDQUFDO0FBQ3pCLFVBQU0sUUFBUTtBQUFBLE1BQ1osbUJBQW1CO0FBQUEsTUFDbkIsc0JBQXNCO0FBQUEsTUFDdEIscUJBQXFCLENBQUMsTUFBTTtBQUFBLElBQzlCO0FBRUEsOEJBQTBCLE9BQU87QUFBQSxNQUMvQixrQkFBa0IsTUFBTSxNQUFNLEtBQUssTUFBTTtBQUFBLE1BQ3pDLGdCQUFnQixNQUFNLE1BQU0sS0FBSyxNQUFNO0FBQUEsTUFDdkMsc0JBQXNCLE1BQU0sTUFBTSxLQUFLLEtBQUs7QUFBQSxJQUM5QyxDQUFDO0FBRUQsV0FBTyxVQUFVLE9BQU8sQ0FBQyxRQUFRLFFBQVEsS0FBSyxDQUFDO0FBQy9DLFdBQU8sVUFBVSxPQUFPO0FBQUEsTUFDdEIsbUJBQW1CO0FBQUEsTUFDbkIsc0JBQXNCO0FBQUEsTUFDdEIscUJBQXFCLENBQUM7QUFBQSxJQUN4QixDQUFDO0FBQUEsRUFDSCxDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
