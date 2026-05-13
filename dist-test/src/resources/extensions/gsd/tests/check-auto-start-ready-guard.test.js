import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkAutoStartAfterDiscuss,
  setPendingAutoStart,
  clearPendingAutoStart
} from "../guided-flow.js";
import { drainLogs } from "../workflow-logger.js";
import {
  openDatabase,
  closeDatabase,
  insertMilestone
} from "../gsd-db.js";
import {
  clearDiscussionFlowState,
  clearPendingGate
} from "../bootstrap/write-gate.js";
function mkCapture() {
  return { notifies: [], messages: [] };
}
function mkCtx(cap) {
  return {
    ui: {
      notify: (msg, level) => {
        cap.notifies.push({ msg, level });
      }
    }
  };
}
function mkPi(cap) {
  return {
    sendMessage: (payload, options) => {
      cap.messages.push({ payload, options });
    },
    setActiveTools: () => void 0,
    getActiveTools: () => []
  };
}
function mkBase() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-ready-guard-")));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
    "# M001: Ready Guard Test\n\nContext.\n"
  );
  writeFileSync(
    join(base, ".gsd", "STATE.md"),
    "# State\n\nactive: M001\n"
  );
  return base;
}
describe("checkAutoStartAfterDiscuss ready-notify DB guard (R3b)", () => {
  let base;
  let cap;
  beforeEach(() => {
    clearPendingAutoStart();
    drainLogs();
  });
  afterEach(() => {
    closeDatabase();
    clearPendingAutoStart();
    if (base) {
      try {
        clearDiscussionFlowState(base);
      } catch {
      }
      try {
        clearPendingGate(base);
      } catch {
      }
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("does not announce 'ready' when the milestone DB row is absent", () => {
    base = mkBase();
    openDatabase(":memory:");
    cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      ctx: mkCtx(cap),
      pi: mkPi(cap)
    });
    const result = checkAutoStartAfterDiscuss();
    assert.equal(result, false, "must return false when DB row missing");
    const successReady = cap.notifies.find(
      (n) => n.level === "success" && /ready\.?$/i.test(n.msg)
    );
    assert.equal(successReady, void 0, "must not announce 'ready' when DB row missing");
    const errorNotify = cap.notifies.find((n) => n.level === "error");
    assert.ok(errorNotify, "must emit an error notify when the DB row is missing");
    assert.match(
      errorNotify.msg,
      /no DB row exists/i,
      "error notify must mention the missing DB row"
    );
    assert.match(errorNotify.msg, /M001/, "error notify must mention the milestone id");
  });
  test("announces 'ready' when DB row exists", () => {
    base = mkBase();
    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Ready Guard Test", status: "active" });
    cap = mkCapture();
    setPendingAutoStart(base, {
      basePath: base,
      milestoneId: "M001",
      ctx: mkCtx(cap),
      pi: mkPi(cap)
    });
    const result = checkAutoStartAfterDiscuss();
    assert.equal(result, true, "must return true on the happy path");
    const successReady = cap.notifies.find(
      (n) => n.level === "success" && /Milestone\s+M001\s+ready/i.test(n.msg)
    );
    assert.ok(successReady, "must announce 'Milestone M001 ready.' on success");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jaGVjay1hdXRvLXN0YXJ0LXJlYWR5LWd1YXJkLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yICsgUmVncmVzc2lvbiB0ZXN0cyBmb3IgY2hlY2tBdXRvU3RhcnRBZnRlckRpc2N1c3MgXCJyZWFkeVwiIG5vdGlmeSBndWFyZCAoUjNiKVxuLy9cbi8vIEJlbHQtYW5kLXN1c3BlbmRlcnM6IGV2ZW4gd2hlbiBDT05URVhULm1kIGFuZCBTVEFURS5tZCBleGlzdCBvbiBkaXNrLCB0aGVcbi8vIFwiTWlsZXN0b25lIFggcmVhZHkuXCIgc3VjY2VzcyBub3RpZnkgbXVzdCBub3QgZmlyZSB3aGVuIHRoZSBtaWxlc3RvbmUgREIgcm93XG4vLyBpcyBhYnNlbnQuIE90aGVyd2lzZSB0aGUgdXNlciBzZWVzIFwicmVhZHlcIiBhbmQgdGhlbiAvZ3NkIHJlcG9ydHNcbi8vIFwiTm8gQWN0aXZlIE1pbGVzdG9uZVwiIGJlY2F1c2UgdGhlIG1pbGVzdG9uZSB3YXMgbmV2ZXIgcmVnaXN0ZXJlZC5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jLCByZWFscGF0aFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7XG4gIGNoZWNrQXV0b1N0YXJ0QWZ0ZXJEaXNjdXNzLFxuICBzZXRQZW5kaW5nQXV0b1N0YXJ0LFxuICBjbGVhclBlbmRpbmdBdXRvU3RhcnQsXG59IGZyb20gXCIuLi9ndWlkZWQtZmxvdy50c1wiO1xuaW1wb3J0IHsgZHJhaW5Mb2dzIH0gZnJvbSBcIi4uL3dvcmtmbG93LWxvZ2dlci50c1wiO1xuaW1wb3J0IHtcbiAgb3BlbkRhdGFiYXNlLFxuICBjbG9zZURhdGFiYXNlLFxuICBpbnNlcnRNaWxlc3RvbmUsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7XG4gIGNsZWFyRGlzY3Vzc2lvbkZsb3dTdGF0ZSxcbiAgY2xlYXJQZW5kaW5nR2F0ZSxcbn0gZnJvbSBcIi4uL2Jvb3RzdHJhcC93cml0ZS1nYXRlLnRzXCI7XG5cbmludGVyZmFjZSBNb2NrQ2FwdHVyZSB7XG4gIG5vdGlmaWVzOiBBcnJheTx7IG1zZzogc3RyaW5nOyBsZXZlbDogc3RyaW5nIH0+O1xuICBtZXNzYWdlczogQXJyYXk8eyBwYXlsb2FkOiBhbnk7IG9wdGlvbnM6IGFueSB9Pjtcbn1cblxuZnVuY3Rpb24gbWtDYXB0dXJlKCk6IE1vY2tDYXB0dXJlIHtcbiAgcmV0dXJuIHsgbm90aWZpZXM6IFtdLCBtZXNzYWdlczogW10gfTtcbn1cblxuZnVuY3Rpb24gbWtDdHgoY2FwOiBNb2NrQ2FwdHVyZSk6IGFueSB7XG4gIHJldHVybiB7XG4gICAgdWk6IHtcbiAgICAgIG5vdGlmeTogKG1zZzogc3RyaW5nLCBsZXZlbDogc3RyaW5nKSA9PiB7XG4gICAgICAgIGNhcC5ub3RpZmllcy5wdXNoKHsgbXNnLCBsZXZlbCB9KTtcbiAgICAgIH0sXG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWtQaShjYXA6IE1vY2tDYXB0dXJlKTogYW55IHtcbiAgcmV0dXJuIHtcbiAgICBzZW5kTWVzc2FnZTogKHBheWxvYWQ6IGFueSwgb3B0aW9uczogYW55KSA9PiB7XG4gICAgICBjYXAubWVzc2FnZXMucHVzaCh7IHBheWxvYWQsIG9wdGlvbnMgfSk7XG4gICAgfSxcbiAgICBzZXRBY3RpdmVUb29sczogKCkgPT4gdW5kZWZpbmVkLFxuICAgIGdldEFjdGl2ZVRvb2xzOiAoKSA9PiBbXSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWtCYXNlKCk6IHN0cmluZyB7XG4gIC8vIHJlYWxwYXRoU3luYyB0byBub3JtYWxpemUgdGhlIG1hY09TIC92YXIgXHUyMTkyIC9wcml2YXRlL3ZhciBzeW1saW5rIHNvIHRoZVxuICAvLyBiYXNlUGF0aCB3ZSBwYXNzIG1hdGNoZXMgd2hhdCB0aGUgd29ya3NwYWNlIHByb2plY3RSb290IHJlc29sdmVzIHRvLlxuICBjb25zdCBiYXNlID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXJlYWR5LWd1YXJkLVwiKSkpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtQ09OVEVYVC5tZFwiKSxcbiAgICBcIiMgTTAwMTogUmVhZHkgR3VhcmQgVGVzdFxcblxcbkNvbnRleHQuXFxuXCIsXG4gICk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlLCBcIi5nc2RcIiwgXCJTVEFURS5tZFwiKSxcbiAgICBcIiMgU3RhdGVcXG5cXG5hY3RpdmU6IE0wMDFcXG5cIixcbiAgKTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmRlc2NyaWJlKFwiY2hlY2tBdXRvU3RhcnRBZnRlckRpc2N1c3MgcmVhZHktbm90aWZ5IERCIGd1YXJkIChSM2IpXCIsICgpID0+IHtcbiAgbGV0IGJhc2U6IHN0cmluZztcbiAgbGV0IGNhcDogTW9ja0NhcHR1cmU7XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgY2xlYXJQZW5kaW5nQXV0b1N0YXJ0KCk7XG4gICAgZHJhaW5Mb2dzKCk7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIGNsZWFyUGVuZGluZ0F1dG9TdGFydCgpO1xuICAgIGlmIChiYXNlKSB7XG4gICAgICB0cnkgeyBjbGVhckRpc2N1c3Npb25GbG93U3RhdGUoYmFzZSk7IH0gY2F0Y2ggeyAvKiAqLyB9XG4gICAgICB0cnkgeyBjbGVhclBlbmRpbmdHYXRlKGJhc2UpOyB9IGNhdGNoIHsgLyogKi8gfVxuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJkb2VzIG5vdCBhbm5vdW5jZSAncmVhZHknIHdoZW4gdGhlIG1pbGVzdG9uZSBEQiByb3cgaXMgYWJzZW50XCIsICgpID0+IHtcbiAgICBiYXNlID0gbWtCYXNlKCk7XG4gICAgLy8gT3BlbiBhIGZyZXNoIGluLW1lbW9yeSBEQiBidXQgRE8gTk9UIGluc2VydE1pbGVzdG9uZSBmb3IgTTAwMS5cbiAgICBvcGVuRGF0YWJhc2UoXCI6bWVtb3J5OlwiKTtcblxuICAgIGNhcCA9IG1rQ2FwdHVyZSgpO1xuICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZSwge1xuICAgICAgYmFzZVBhdGg6IGJhc2UsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBjdHg6IG1rQ3R4KGNhcCksXG4gICAgICBwaTogbWtQaShjYXApLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gY2hlY2tBdXRvU3RhcnRBZnRlckRpc2N1c3MoKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBmYWxzZSwgXCJtdXN0IHJldHVybiBmYWxzZSB3aGVuIERCIHJvdyBtaXNzaW5nXCIpO1xuXG4gICAgLy8gTm8gc3VjY2VzcyBcInJlYWR5XCIgbm90aWZ5XG4gICAgY29uc3Qgc3VjY2Vzc1JlYWR5ID0gY2FwLm5vdGlmaWVzLmZpbmQoXG4gICAgICAobikgPT4gbi5sZXZlbCA9PT0gXCJzdWNjZXNzXCIgJiYgL3JlYWR5XFwuPyQvaS50ZXN0KG4ubXNnKSxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChzdWNjZXNzUmVhZHksIHVuZGVmaW5lZCwgXCJtdXN0IG5vdCBhbm5vdW5jZSAncmVhZHknIHdoZW4gREIgcm93IG1pc3NpbmdcIik7XG5cbiAgICAvLyBBbiBlcnJvciBub3RpZnkgbXVzdCBleHBsYWluIHRoZSBtaXNzaW5nIERCIHJvd1xuICAgIGNvbnN0IGVycm9yTm90aWZ5ID0gY2FwLm5vdGlmaWVzLmZpbmQoKG4pID0+IG4ubGV2ZWwgPT09IFwiZXJyb3JcIik7XG4gICAgYXNzZXJ0Lm9rKGVycm9yTm90aWZ5LCBcIm11c3QgZW1pdCBhbiBlcnJvciBub3RpZnkgd2hlbiB0aGUgREIgcm93IGlzIG1pc3NpbmdcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKFxuICAgICAgZXJyb3JOb3RpZnkhLm1zZyxcbiAgICAgIC9ubyBEQiByb3cgZXhpc3RzL2ksXG4gICAgICBcImVycm9yIG5vdGlmeSBtdXN0IG1lbnRpb24gdGhlIG1pc3NpbmcgREIgcm93XCIsXG4gICAgKTtcbiAgICBhc3NlcnQubWF0Y2goZXJyb3JOb3RpZnkhLm1zZywgL00wMDEvLCBcImVycm9yIG5vdGlmeSBtdXN0IG1lbnRpb24gdGhlIG1pbGVzdG9uZSBpZFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImFubm91bmNlcyAncmVhZHknIHdoZW4gREIgcm93IGV4aXN0c1wiLCAoKSA9PiB7XG4gICAgYmFzZSA9IG1rQmFzZSgpO1xuICAgIG9wZW5EYXRhYmFzZShcIjptZW1vcnk6XCIpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiUmVhZHkgR3VhcmQgVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG5cbiAgICBjYXAgPSBta0NhcHR1cmUoKTtcbiAgICBzZXRQZW5kaW5nQXV0b1N0YXJ0KGJhc2UsIHtcbiAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgY3R4OiBta0N0eChjYXApLFxuICAgICAgcGk6IG1rUGkoY2FwKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGNoZWNrQXV0b1N0YXJ0QWZ0ZXJEaXNjdXNzKCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgdHJ1ZSwgXCJtdXN0IHJldHVybiB0cnVlIG9uIHRoZSBoYXBweSBwYXRoXCIpO1xuXG4gICAgY29uc3Qgc3VjY2Vzc1JlYWR5ID0gY2FwLm5vdGlmaWVzLmZpbmQoXG4gICAgICAobikgPT4gbi5sZXZlbCA9PT0gXCJzdWNjZXNzXCIgJiYgL01pbGVzdG9uZVxccytNMDAxXFxzK3JlYWR5L2kudGVzdChuLm1zZyksXG4gICAgKTtcbiAgICBhc3NlcnQub2soc3VjY2Vzc1JlYWR5LCBcIm11c3QgYW5ub3VuY2UgJ01pbGVzdG9uZSBNMDAxIHJlYWR5Licgb24gc3VjY2Vzc1wiKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQU9BLFNBQVMsVUFBVSxNQUFNLFlBQVksaUJBQWlCO0FBQ3RELE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxRQUFRLGVBQWUsb0JBQW9CO0FBQzVFLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxpQkFBaUI7QUFDMUI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1A7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFPUCxTQUFTLFlBQXlCO0FBQ2hDLFNBQU8sRUFBRSxVQUFVLENBQUMsR0FBRyxVQUFVLENBQUMsRUFBRTtBQUN0QztBQUVBLFNBQVMsTUFBTSxLQUF1QjtBQUNwQyxTQUFPO0FBQUEsSUFDTCxJQUFJO0FBQUEsTUFDRixRQUFRLENBQUMsS0FBYSxVQUFrQjtBQUN0QyxZQUFJLFNBQVMsS0FBSyxFQUFFLEtBQUssTUFBTSxDQUFDO0FBQUEsTUFDbEM7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNGO0FB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
