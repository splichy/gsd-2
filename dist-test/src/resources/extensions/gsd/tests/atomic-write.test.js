import test from "node:test";
import assert from "node:assert/strict";
import {
  atomicWriteAsyncWithOps,
  atomicWriteSyncWithOps
} from "../atomic-write.js";
function makeError(code, message = code) {
  const err = new Error(message);
  err.code = code;
  return err;
}
function createAsyncHarness(plan) {
  const files = /* @__PURE__ */ new Map();
  const renameCalls = [];
  const unlinkCalls = [];
  const sleepCalls = [];
  let tempCounter = 0;
  const ops = {
    mkdir: async () => {
    },
    writeFile: async (path, content) => {
      files.set(path, String(content));
    },
    rename: async (from, to) => {
      renameCalls.push({ from, to });
      const outcome = plan.shift() ?? null;
      if (outcome) throw outcome;
      const content = files.get(from);
      if (content === void 0) throw makeError("ENOENT", "temp missing");
      files.set(to, content);
      files.delete(from);
    },
    unlink: async (path) => {
      unlinkCalls.push(path);
      files.delete(path);
    },
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    createTempPath: (filePath) => `${filePath}.tmp.test-${++tempCounter}`
  };
  return { ops, files, renameCalls, unlinkCalls, sleepCalls };
}
function createSyncHarness(plan) {
  const files = /* @__PURE__ */ new Map();
  const renameCalls = [];
  const unlinkCalls = [];
  const sleepCalls = [];
  let tempCounter = 0;
  const ops = {
    mkdir: () => {
    },
    writeFile: (path, content) => {
      files.set(path, String(content));
    },
    rename: (from, to) => {
      renameCalls.push({ from, to });
      const outcome = plan.shift() ?? null;
      if (outcome) throw outcome;
      const content = files.get(from);
      if (content === void 0) throw makeError("ENOENT", "temp missing");
      files.set(to, content);
      files.delete(from);
    },
    unlink: (path) => {
      unlinkCalls.push(path);
      files.delete(path);
    },
    sleep: (ms) => {
      sleepCalls.push(ms);
    },
    createTempPath: (filePath) => `${filePath}.tmp.test-${++tempCounter}`
  };
  return { ops, files, renameCalls, unlinkCalls, sleepCalls };
}
test("atomicWriteAsync retries transient rename failures and preserves atomicity", async () => {
  const harness = createAsyncHarness([makeError("EBUSY"), makeError("EPERM"), null]);
  harness.files.set("C:/tmp/output.txt", "old-content");
  await atomicWriteAsyncWithOps("C:/tmp/output.txt", "new-content", "utf-8", harness.ops);
  assert.equal(harness.renameCalls.length, 3);
  assert.equal(harness.files.get("C:/tmp/output.txt"), "new-content");
  assert.equal(harness.unlinkCalls.length, 0);
  assert.equal(harness.sleepCalls.length, 2);
});
test("atomicWriteAsync cleans up temp file and reports attempts after repeated transient failures", async () => {
  const harness = createAsyncHarness([
    makeError("EACCES"),
    makeError("EBUSY"),
    makeError("EPERM"),
    makeError("EACCES"),
    makeError("EBUSY")
  ]);
  harness.files.set("C:/tmp/output.txt", "old-content");
  await assert.rejects(
    atomicWriteAsyncWithOps("C:/tmp/output.txt", "new-content", "utf-8", harness.ops),
    (error) => {
      assert.match(String(error), /C:\\\/tmp\/output\.txt|C:\/tmp\/output\.txt/);
      assert.match(String(error), /attempt/i);
      assert.match(String(error), /EBUSY|EPERM|EACCES/);
      return true;
    }
  );
  assert.equal(harness.renameCalls.length, 5);
  assert.equal(harness.files.get("C:/tmp/output.txt"), "old-content");
  assert.equal(harness.unlinkCalls.length, 1);
});
test("atomicWriteAsync does not retry non-transient rename failures", async () => {
  const harness = createAsyncHarness([makeError("ENOENT")]);
  harness.files.set("C:/tmp/output.txt", "old-content");
  await assert.rejects(() => atomicWriteAsyncWithOps("C:/tmp/output.txt", "new-content", "utf-8", harness.ops));
  assert.equal(harness.renameCalls.length, 1);
  assert.equal(harness.sleepCalls.length, 0);
  assert.equal(harness.unlinkCalls.length, 1);
  assert.equal(harness.files.get("C:/tmp/output.txt"), "old-content");
});
test("atomicWriteSync retries transient rename failures and succeeds", () => {
  const harness = createSyncHarness([makeError("EACCES"), makeError("EBUSY"), null]);
  harness.files.set("C:/tmp/output.txt", "old-content");
  atomicWriteSyncWithOps("C:/tmp/output.txt", "new-content", "utf-8", harness.ops);
  assert.equal(harness.renameCalls.length, 3);
  assert.equal(harness.sleepCalls.length, 2);
  assert.equal(harness.unlinkCalls.length, 0);
  assert.equal(harness.files.get("C:/tmp/output.txt"), "new-content");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdG9taWMtd3JpdGUudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbmltcG9ydCB7XG4gIGF0b21pY1dyaXRlQXN5bmNXaXRoT3BzLFxuICBhdG9taWNXcml0ZVN5bmNXaXRoT3BzLFxuICB0eXBlIEF0b21pY1dyaXRlQXN5bmNPcHMsXG4gIHR5cGUgQXRvbWljV3JpdGVTeW5jT3BzLFxufSBmcm9tIFwiLi4vYXRvbWljLXdyaXRlLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VFcnJvcihjb2RlOiBzdHJpbmcsIG1lc3NhZ2UgPSBjb2RlKTogTm9kZUpTLkVycm5vRXhjZXB0aW9uIHtcbiAgY29uc3QgZXJyID0gbmV3IEVycm9yKG1lc3NhZ2UpIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbjtcbiAgZXJyLmNvZGUgPSBjb2RlO1xuICByZXR1cm4gZXJyO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVBc3luY0hhcm5lc3MocGxhbjogQXJyYXk8RXJyb3IgfCBudWxsPikge1xuICBjb25zdCBmaWxlcyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIGNvbnN0IHJlbmFtZUNhbGxzOiBBcnJheTx7IGZyb206IHN0cmluZzsgdG86IHN0cmluZyB9PiA9IFtdO1xuICBjb25zdCB1bmxpbmtDYWxsczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgc2xlZXBDYWxsczogbnVtYmVyW10gPSBbXTtcbiAgbGV0IHRlbXBDb3VudGVyID0gMDtcblxuICBjb25zdCBvcHM6IEF0b21pY1dyaXRlQXN5bmNPcHMgPSB7XG4gICAgbWtkaXI6IGFzeW5jICgpID0+IHt9LFxuICAgIHdyaXRlRmlsZTogYXN5bmMgKHBhdGgsIGNvbnRlbnQpID0+IHtcbiAgICAgIGZpbGVzLnNldChwYXRoLCBTdHJpbmcoY29udGVudCkpO1xuICAgIH0sXG4gICAgcmVuYW1lOiBhc3luYyAoZnJvbSwgdG8pID0+IHtcbiAgICAgIHJlbmFtZUNhbGxzLnB1c2goeyBmcm9tLCB0byB9KTtcbiAgICAgIGNvbnN0IG91dGNvbWUgPSBwbGFuLnNoaWZ0KCkgPz8gbnVsbDtcbiAgICAgIGlmIChvdXRjb21lKSB0aHJvdyBvdXRjb21lO1xuICAgICAgY29uc3QgY29udGVudCA9IGZpbGVzLmdldChmcm9tKTtcbiAgICAgIGlmIChjb250ZW50ID09PSB1bmRlZmluZWQpIHRocm93IG1ha2VFcnJvcihcIkVOT0VOVFwiLCBcInRlbXAgbWlzc2luZ1wiKTtcbiAgICAgIGZpbGVzLnNldCh0bywgY29udGVudCk7XG4gICAgICBmaWxlcy5kZWxldGUoZnJvbSk7XG4gICAgfSxcbiAgICB1bmxpbms6IGFzeW5jIChwYXRoKSA9PiB7XG4gICAgICB1bmxpbmtDYWxscy5wdXNoKHBhdGgpO1xuICAgICAgZmlsZXMuZGVsZXRlKHBhdGgpO1xuICAgIH0sXG4gICAgc2xlZXA6IGFzeW5jIChtcykgPT4ge1xuICAgICAgc2xlZXBDYWxscy5wdXNoKG1zKTtcbiAgICB9LFxuICAgIGNyZWF0ZVRlbXBQYXRoOiAoZmlsZVBhdGgpID0+IGAke2ZpbGVQYXRofS50bXAudGVzdC0keysrdGVtcENvdW50ZXJ9YCxcbiAgfTtcblxuICByZXR1cm4geyBvcHMsIGZpbGVzLCByZW5hbWVDYWxscywgdW5saW5rQ2FsbHMsIHNsZWVwQ2FsbHMgfTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlU3luY0hhcm5lc3MocGxhbjogQXJyYXk8RXJyb3IgfCBudWxsPikge1xuICBjb25zdCBmaWxlcyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIGNvbnN0IHJlbmFtZUNhbGxzOiBBcnJheTx7IGZyb206IHN0cmluZzsgdG86IHN0cmluZyB9PiA9IFtdO1xuICBjb25zdCB1bmxpbmtDYWxsczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgc2xlZXBDYWxsczogbnVtYmVyW10gPSBbXTtcbiAgbGV0IHRlbXBDb3VudGVyID0gMDtcblxuICBjb25zdCBvcHM6IEF0b21pY1dyaXRlU3luY09wcyA9IHtcbiAgICBta2RpcjogKCkgPT4ge30sXG4gICAgd3JpdGVGaWxlOiAocGF0aCwgY29udGVudCkgPT4ge1xuICAgICAgZmlsZXMuc2V0KHBhdGgsIFN0cmluZyhjb250ZW50KSk7XG4gICAgfSxcbiAgICByZW5hbWU6IChmcm9tLCB0bykgPT4ge1xuICAgICAgcmVuYW1lQ2FsbHMucHVzaCh7IGZyb20sIHRvIH0pO1xuICAgICAgY29uc3Qgb3V0Y29tZSA9IHBsYW4uc2hpZnQoKSA/PyBudWxsO1xuICAgICAgaWYgKG91dGNvbWUpIHRocm93IG91dGNvbWU7XG4gICAgICBjb25zdCBjb250ZW50ID0gZmlsZXMuZ2V0KGZyb20pO1xuICAgICAgaWYgKGNvbnRlbnQgPT09IHVuZGVmaW5lZCkgdGhyb3cgbWFrZUVycm9yKFwiRU5PRU5UXCIsIFwidGVtcCBtaXNzaW5nXCIpO1xuICAgICAgZmlsZXMuc2V0KHRvLCBjb250ZW50KTtcbiAgICAgIGZpbGVzLmRlbGV0ZShmcm9tKTtcbiAgICB9LFxuICAgIHVubGluazogKHBhdGgpID0+IHtcbiAgICAgIHVubGlua0NhbGxzLnB1c2gocGF0aCk7XG4gICAgICBmaWxlcy5kZWxldGUocGF0aCk7XG4gICAgfSxcbiAgICBzbGVlcDogKG1zKSA9PiB7XG4gICAgICBzbGVlcENhbGxzLnB1c2gobXMpO1xuICAgIH0sXG4gICAgY3JlYXRlVGVtcFBhdGg6IChmaWxlUGF0aCkgPT4gYCR7ZmlsZVBhdGh9LnRtcC50ZXN0LSR7Kyt0ZW1wQ291bnRlcn1gLFxuICB9O1xuXG4gIHJldHVybiB7IG9wcywgZmlsZXMsIHJlbmFtZUNhbGxzLCB1bmxpbmtDYWxscywgc2xlZXBDYWxscyB9O1xufVxuXG50ZXN0KFwiYXRvbWljV3JpdGVBc3luYyByZXRyaWVzIHRyYW5zaWVudCByZW5hbWUgZmFpbHVyZXMgYW5kIHByZXNlcnZlcyBhdG9taWNpdHlcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBoYXJuZXNzID0gY3JlYXRlQXN5bmNIYXJuZXNzKFttYWtlRXJyb3IoXCJFQlVTWVwiKSwgbWFrZUVycm9yKFwiRVBFUk1cIiksIG51bGxdKTtcbiAgaGFybmVzcy5maWxlcy5zZXQoXCJDOi90bXAvb3V0cHV0LnR4dFwiLCBcIm9sZC1jb250ZW50XCIpO1xuXG4gIGF3YWl0IGF0b21pY1dyaXRlQXN5bmNXaXRoT3BzKFwiQzovdG1wL291dHB1dC50eHRcIiwgXCJuZXctY29udGVudFwiLCBcInV0Zi04XCIsIGhhcm5lc3Mub3BzKTtcblxuICBhc3NlcnQuZXF1YWwoaGFybmVzcy5yZW5hbWVDYWxscy5sZW5ndGgsIDMpO1xuICBhc3NlcnQuZXF1YWwoaGFybmVzcy5maWxlcy5nZXQoXCJDOi90bXAvb3V0cHV0LnR4dFwiKSwgXCJuZXctY29udGVudFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGhhcm5lc3MudW5saW5rQ2FsbHMubGVuZ3RoLCAwKTtcbiAgYXNzZXJ0LmVxdWFsKGhhcm5lc3Muc2xlZXBDYWxscy5sZW5ndGgsIDIpO1xufSk7XG5cbnRlc3QoXCJhdG9taWNXcml0ZUFzeW5jIGNsZWFucyB1cCB0ZW1wIGZpbGUgYW5kIHJlcG9ydHMgYXR0ZW1wdHMgYWZ0ZXIgcmVwZWF0ZWQgdHJhbnNpZW50IGZhaWx1cmVzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgaGFybmVzcyA9IGNyZWF0ZUFzeW5jSGFybmVzcyhbXG4gICAgbWFrZUVycm9yKFwiRUFDQ0VTXCIpLFxuICAgIG1ha2VFcnJvcihcIkVCVVNZXCIpLFxuICAgIG1ha2VFcnJvcihcIkVQRVJNXCIpLFxuICAgIG1ha2VFcnJvcihcIkVBQ0NFU1wiKSxcbiAgICBtYWtlRXJyb3IoXCJFQlVTWVwiKSxcbiAgXSk7XG4gIGhhcm5lc3MuZmlsZXMuc2V0KFwiQzovdG1wL291dHB1dC50eHRcIiwgXCJvbGQtY29udGVudFwiKTtcblxuICBhd2FpdCBhc3NlcnQucmVqZWN0cyhcbiAgICBhdG9taWNXcml0ZUFzeW5jV2l0aE9wcyhcIkM6L3RtcC9vdXRwdXQudHh0XCIsIFwibmV3LWNvbnRlbnRcIiwgXCJ1dGYtOFwiLCBoYXJuZXNzLm9wcyksXG4gICAgKGVycm9yOiB1bmtub3duKSA9PiB7XG4gICAgICBhc3NlcnQubWF0Y2goU3RyaW5nKGVycm9yKSwgL0M6XFxcXFxcL3RtcFxcL291dHB1dFxcLnR4dHxDOlxcL3RtcFxcL291dHB1dFxcLnR4dC8pO1xuICAgICAgYXNzZXJ0Lm1hdGNoKFN0cmluZyhlcnJvciksIC9hdHRlbXB0L2kpO1xuICAgICAgYXNzZXJ0Lm1hdGNoKFN0cmluZyhlcnJvciksIC9FQlVTWXxFUEVSTXxFQUNDRVMvKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKGhhcm5lc3MucmVuYW1lQ2FsbHMubGVuZ3RoLCA1KTtcbiAgYXNzZXJ0LmVxdWFsKGhhcm5lc3MuZmlsZXMuZ2V0KFwiQzovdG1wL291dHB1dC50eHRcIiksIFwib2xkLWNvbnRlbnRcIik7XG4gIGFzc2VydC5lcXVhbChoYXJuZXNzLnVubGlua0NhbGxzLmxlbmd0aCwgMSk7XG59KTtcblxudGVzdChcImF0b21pY1dyaXRlQXN5bmMgZG9lcyBub3QgcmV0cnkgbm9uLXRyYW5zaWVudCByZW5hbWUgZmFpbHVyZXNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBoYXJuZXNzID0gY3JlYXRlQXN5bmNIYXJuZXNzKFttYWtlRXJyb3IoXCJFTk9FTlRcIildKTtcbiAgaGFybmVzcy5maWxlcy5zZXQoXCJDOi90bXAvb3V0cHV0LnR4dFwiLCBcIm9sZC1jb250ZW50XCIpO1xuXG4gIGF3YWl0IGFzc2VydC5yZWplY3RzKCgpID0+IGF0b21pY1dyaXRlQXN5bmNXaXRoT3BzKFwiQzovdG1wL291dHB1dC50eHRcIiwgXCJuZXctY29udGVudFwiLCBcInV0Zi04XCIsIGhhcm5lc3Mub3BzKSk7XG5cbiAgYXNzZXJ0LmVxdWFsKGhhcm5lc3MucmVuYW1lQ2FsbHMubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKGhhcm5lc3Muc2xlZXBDYWxscy5sZW5ndGgsIDApO1xuICBhc3NlcnQuZXF1YWwoaGFybmVzcy51bmxpbmtDYWxscy5sZW5ndGgsIDEpO1xuICBhc3NlcnQuZXF1YWwoaGFybmVzcy5maWxlcy5nZXQoXCJDOi90bXAvb3V0cHV0LnR4dFwiKSwgXCJvbGQtY29udGVudFwiKTtcbn0pO1xuXG50ZXN0KFwiYXRvbWljV3JpdGVTeW5jIHJldHJpZXMgdHJhbnNpZW50IHJlbmFtZSBmYWlsdXJlcyBhbmQgc3VjY2VlZHNcIiwgKCkgPT4ge1xuICBjb25zdCBoYXJuZXNzID0gY3JlYXRlU3luY0hhcm5lc3MoW21ha2VFcnJvcihcIkVBQ0NFU1wiKSwgbWFrZUVycm9yKFwiRUJVU1lcIiksIG51bGxdKTtcbiAgaGFybmVzcy5maWxlcy5zZXQoXCJDOi90bXAvb3V0cHV0LnR4dFwiLCBcIm9sZC1jb250ZW50XCIpO1xuXG4gIGF0b21pY1dyaXRlU3luY1dpdGhPcHMoXCJDOi90bXAvb3V0cHV0LnR4dFwiLCBcIm5ldy1jb250ZW50XCIsIFwidXRmLThcIiwgaGFybmVzcy5vcHMpO1xuXG4gIGFzc2VydC5lcXVhbChoYXJuZXNzLnJlbmFtZUNhbGxzLmxlbmd0aCwgMyk7XG4gIGFzc2VydC5lcXVhbChoYXJuZXNzLnNsZWVwQ2FsbHMubGVuZ3RoLCAyKTtcbiAgYXNzZXJ0LmVxdWFsKGhhcm5lc3MudW5saW5rQ2FsbHMubGVuZ3RoLCAwKTtcbiAgYXNzZXJ0LmVxdWFsKGhhcm5lc3MuZmlsZXMuZ2V0KFwiQzovdG1wL291dHB1dC50eHRcIiksIFwibmV3LWNvbnRlbnRcIik7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFFbkI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLE9BR0s7QUFFUCxTQUFTLFVBQVUsTUFBYyxVQUFVLE1B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
