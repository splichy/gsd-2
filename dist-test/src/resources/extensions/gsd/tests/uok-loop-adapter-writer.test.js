import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnObserver } from "../uok/loop-adapter.js";
import { hasActiveWriterToken, resetWriterTokensForTests } from "../uok/writer.js";
function readAuditPayloads(basePath) {
  const path = join(basePath, ".gsd", "audit", "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((event) => event.payload ?? {});
}
test("uok turn observer adds writer sequence metadata to audit events", (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-uok-loop-writer-"));
  resetWriterTokensForTests();
  t.after(() => {
    resetWriterTokensForTests();
    rmSync(basePath, { recursive: true, force: true });
  });
  const observer = createTurnObserver({
    basePath,
    gitAction: "status-only",
    gitPush: false,
    enableAudit: true,
    enableGitops: false
  });
  observer.onTurnStart({
    basePath,
    traceId: "trace-1",
    turnId: "turn-1",
    iteration: 1,
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    startedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  assert.equal(hasActiveWriterToken(basePath, "turn-1"), true);
  observer.onTurnResult({
    traceId: "trace-1",
    turnId: "turn-1",
    iteration: 1,
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    status: "completed",
    failureClass: "none",
    phaseResults: [],
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    finishedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  assert.equal(hasActiveWriterToken(basePath, "turn-1"), false);
  const payloads = readAuditPayloads(basePath);
  assert.equal(payloads[0]?.writeSequence, 1);
  assert.equal(payloads[1]?.writeSequence, 2);
  assert.equal(typeof payloads[0]?.writerTokenId, "string");
});
test("uok turn observer releases writer token when validation throws", (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-uok-loop-writer-throw-"));
  resetWriterTokensForTests();
  t.after(() => {
    resetWriterTokensForTests();
    rmSync(basePath, { recursive: true, force: true });
  });
  const observer = createTurnObserver({
    basePath,
    gitAction: "status-only",
    gitPush: false,
    enableAudit: false,
    enableGitops: false
  });
  observer.onTurnStart({
    basePath,
    traceId: "trace-throw",
    turnId: "turn-throw",
    iteration: 1,
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    startedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  assert.equal(hasActiveWriterToken(basePath, "turn-throw"), true);
  assert.throws(() => {
    observer.onTurnResult({
      traceId: "trace-throw",
      turnId: "turn-throw",
      // @ts-expect-error intentionally invalid for test
      iteration: "not-a-number",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      status: "completed",
      failureClass: "none",
      phaseResults: [],
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      finishedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  }, /Invalid UOK turn result/);
  assert.equal(hasActiveWriterToken(basePath, "turn-throw"), false);
});
test("uok turn observer falls back to cached phaseResults when result.phaseResults is missing", (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-uok-loop-writer-missing-"));
  resetWriterTokensForTests();
  t.after(() => {
    resetWriterTokensForTests();
    rmSync(basePath, { recursive: true, force: true });
  });
  const observer = createTurnObserver({
    basePath,
    gitAction: "status-only",
    gitPush: false,
    enableAudit: false,
    enableGitops: false
  });
  observer.onTurnStart({
    basePath,
    traceId: "trace-missing",
    turnId: "turn-missing",
    iteration: 1,
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    startedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  assert.doesNotThrow(() => {
    observer.onTurnResult({
      traceId: "trace-missing",
      turnId: "turn-missing",
      iteration: 1,
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      status: "completed",
      failureClass: "none",
      // @ts-expect-error intentionally missing for test
      phaseResults: void 0,
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      finishedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  });
  assert.equal(hasActiveWriterToken(basePath, "turn-missing"), false);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy91b2stbG9vcC1hZGFwdGVyLXdyaXRlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZHRlbXBTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuaW1wb3J0IHsgY3JlYXRlVHVybk9ic2VydmVyIH0gZnJvbSBcIi4uL3Vvay9sb29wLWFkYXB0ZXIudHNcIjtcbmltcG9ydCB7IGhhc0FjdGl2ZVdyaXRlclRva2VuLCByZXNldFdyaXRlclRva2Vuc0ZvclRlc3RzIH0gZnJvbSBcIi4uL3Vvay93cml0ZXIudHNcIjtcblxuZnVuY3Rpb24gcmVhZEF1ZGl0UGF5bG9hZHMoYmFzZVBhdGg6IHN0cmluZyk6IEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gIGNvbnN0IHBhdGggPSBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJhdWRpdFwiLCBcImV2ZW50cy5qc29ubFwiKTtcbiAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gW107XG4gIHJldHVybiByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKVxuICAgIC5zcGxpdChcIlxcblwiKVxuICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAubWFwKChsaW5lKSA9PiBKU09OLnBhcnNlKGxpbmUpIGFzIHsgcGF5bG9hZD86IFJlY29yZDxzdHJpbmcsIHVua25vd24+IH0pXG4gICAgLm1hcCgoZXZlbnQpID0+IGV2ZW50LnBheWxvYWQgPz8ge30pO1xufVxuXG50ZXN0KFwidW9rIHR1cm4gb2JzZXJ2ZXIgYWRkcyB3cml0ZXIgc2VxdWVuY2UgbWV0YWRhdGEgdG8gYXVkaXQgZXZlbnRzXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2VQYXRoID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtdW9rLWxvb3Atd3JpdGVyLVwiKSk7XG4gIHJlc2V0V3JpdGVyVG9rZW5zRm9yVGVzdHMoKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgcmVzZXRXcml0ZXJUb2tlbnNGb3JUZXN0cygpO1xuICAgIHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBjb25zdCBvYnNlcnZlciA9IGNyZWF0ZVR1cm5PYnNlcnZlcih7XG4gICAgYmFzZVBhdGgsXG4gICAgZ2l0QWN0aW9uOiBcInN0YXR1cy1vbmx5XCIsXG4gICAgZ2l0UHVzaDogZmFsc2UsXG4gICAgZW5hYmxlQXVkaXQ6IHRydWUsXG4gICAgZW5hYmxlR2l0b3BzOiBmYWxzZSxcbiAgfSk7XG5cbiAgb2JzZXJ2ZXIub25UdXJuU3RhcnQoe1xuICAgIGJhc2VQYXRoLFxuICAgIHRyYWNlSWQ6IFwidHJhY2UtMVwiLFxuICAgIHR1cm5JZDogXCJ0dXJuLTFcIixcbiAgICBpdGVyYXRpb246IDEsXG4gICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIHN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKGhhc0FjdGl2ZVdyaXRlclRva2VuKGJhc2VQYXRoLCBcInR1cm4tMVwiKSwgdHJ1ZSk7XG5cbiAgb2JzZXJ2ZXIub25UdXJuUmVzdWx0KHtcbiAgICB0cmFjZUlkOiBcInRyYWNlLTFcIixcbiAgICB0dXJuSWQ6IFwidHVybi0xXCIsXG4gICAgaXRlcmF0aW9uOiAxLFxuICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICBzdGF0dXM6IFwiY29tcGxldGVkXCIsXG4gICAgZmFpbHVyZUNsYXNzOiBcIm5vbmVcIixcbiAgICBwaGFzZVJlc3VsdHM6IFtdLFxuICAgIHN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIGZpbmlzaGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKGhhc0FjdGl2ZVdyaXRlclRva2VuKGJhc2VQYXRoLCBcInR1cm4tMVwiKSwgZmFsc2UpO1xuICBjb25zdCBwYXlsb2FkcyA9IHJlYWRBdWRpdFBheWxvYWRzKGJhc2VQYXRoKTtcbiAgYXNzZXJ0LmVxdWFsKHBheWxvYWRzWzBdPy53cml0ZVNlcXVlbmNlLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKHBheWxvYWRzWzFdPy53cml0ZVNlcXVlbmNlLCAyKTtcbiAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBwYXlsb2Fkc1swXT8ud3JpdGVyVG9rZW5JZCwgXCJzdHJpbmdcIik7XG59KTtcblxudGVzdChcInVvayB0dXJuIG9ic2VydmVyIHJlbGVhc2VzIHdyaXRlciB0b2tlbiB3aGVuIHZhbGlkYXRpb24gdGhyb3dzXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2VQYXRoID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtdW9rLWxvb3Atd3JpdGVyLXRocm93LVwiKSk7XG4gIHJlc2V0V3JpdGVyVG9rZW5zRm9yVGVzdHMoKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgcmVzZXRXcml0ZXJUb2tlbnNGb3JUZXN0cygpO1xuICAgIHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBjb25zdCBvYnNlcnZlciA9IGNyZWF0ZVR1cm5PYnNlcnZlcih7XG4gICAgYmFzZVBhdGgsXG4gICAgZ2l0QWN0aW9uOiBcInN0YXR1cy1vbmx5XCIsXG4gICAgZ2l0UHVzaDogZmFsc2UsXG4gICAgZW5hYmxlQXVkaXQ6IGZhbHNlLFxuICAgIGVuYWJsZUdpdG9wczogZmFsc2UsXG4gIH0pO1xuXG4gIG9ic2VydmVyLm9uVHVyblN0YXJ0KHtcbiAgICBiYXNlUGF0aCxcbiAgICB0cmFjZUlkOiBcInRyYWNlLXRocm93XCIsXG4gICAgdHVybklkOiBcInR1cm4tdGhyb3dcIixcbiAgICBpdGVyYXRpb246IDEsXG4gICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIHN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICB9KTtcbiAgYXNzZXJ0LmVxdWFsKGhhc0FjdGl2ZVdyaXRlclRva2VuKGJhc2VQYXRoLCBcInR1cm4tdGhyb3dcIiksIHRydWUpO1xuXG4gIC8vIEludmFsaWQgcGF5bG9hZCAobWlzc2luZyByZXF1aXJlZCBmaWVsZHMgbGlrZSBzdGF0dXMvZmluaXNoZWRBdCkgc2hvdWxkXG4gIC8vIHRyaWdnZXIgdmFsaWRhdGVUdXJuUmVzdWx0IHRvIGZhaWwgYW5kIHRocm93LlxuICBhc3NlcnQudGhyb3dzKCgpID0+IHtcbiAgICBvYnNlcnZlci5vblR1cm5SZXN1bHQoe1xuICAgICAgdHJhY2VJZDogXCJ0cmFjZS10aHJvd1wiLFxuICAgICAgdHVybklkOiBcInR1cm4tdGhyb3dcIixcbiAgICAgIC8vIEB0cy1leHBlY3QtZXJyb3IgaW50ZW50aW9uYWxseSBpbnZhbGlkIGZvciB0ZXN0XG4gICAgICBpdGVyYXRpb246IFwibm90LWEtbnVtYmVyXCIsXG4gICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgIHN0YXR1czogXCJjb21wbGV0ZWRcIixcbiAgICAgIGZhaWx1cmVDbGFzczogXCJub25lXCIsXG4gICAgICBwaGFzZVJlc3VsdHM6IFtdLFxuICAgICAgc3RhcnRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBmaW5pc2hlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgfSk7XG4gIH0sIC9JbnZhbGlkIFVPSyB0dXJuIHJlc3VsdC8pO1xuXG4gIC8vIENsZWFudXAgbXVzdCBydW4gaW4gZmluYWxseSBcdTIwMTQgdG9rZW4gcmVsZWFzZWQsIG5vIGxlYWtlZCBzdGF0ZS5cbiAgYXNzZXJ0LmVxdWFsKGhhc0FjdGl2ZVdyaXRlclRva2VuKGJhc2VQYXRoLCBcInR1cm4tdGhyb3dcIiksIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwidW9rIHR1cm4gb2JzZXJ2ZXIgZmFsbHMgYmFjayB0byBjYWNoZWQgcGhhc2VSZXN1bHRzIHdoZW4gcmVzdWx0LnBoYXNlUmVzdWx0cyBpcyBtaXNzaW5nXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2VQYXRoID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtdW9rLWxvb3Atd3JpdGVyLW1pc3NpbmctXCIpKTtcbiAgcmVzZXRXcml0ZXJUb2tlbnNGb3JUZXN0cygpO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICByZXNldFdyaXRlclRva2Vuc0ZvclRlc3RzKCk7XG4gICAgcm1TeW5jKGJhc2VQYXRoLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIGNvbnN0IG9ic2VydmVyID0gY3JlYXRlVHVybk9ic2VydmVyKHtcbiAgICBiYXNlUGF0aCxcbiAgICBnaXRBY3Rpb246IFwic3RhdHVzLW9ubHlcIixcbiAgICBnaXRQdXNoOiBmYWxzZSxcbiAgICBlbmFibGVBdWRpdDogZmFsc2UsXG4gICAgZW5hYmxlR2l0b3BzOiBmYWxzZSxcbiAgfSk7XG5cbiAgb2JzZXJ2ZXIub25UdXJuU3RhcnQoe1xuICAgIGJhc2VQYXRoLFxuICAgIHRyYWNlSWQ6IFwidHJhY2UtbWlzc2luZ1wiLFxuICAgIHR1cm5JZDogXCJ0dXJuLW1pc3NpbmdcIixcbiAgICBpdGVyYXRpb246IDEsXG4gICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIHN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICB9KTtcblxuICAvLyBXaXRob3V0IHRoZSBBcnJheS5pc0FycmF5IGd1YXJkLCBhY2Nlc3NpbmcgcmVzdWx0LnBoYXNlUmVzdWx0cy5sZW5ndGggb24gYVxuICAvLyBwYXlsb2FkIHdoZXJlIHBoYXNlUmVzdWx0cyBpcyB1bmRlZmluZWQgd291bGQgdGhyb3cgVHlwZUVycm9yIGJlZm9yZVxuICAvLyB2YWxpZGF0ZVR1cm5SZXN1bHQgY291bGQgc3VyZmFjZSBhIHN0cnVjdHVyZWQgZXJyb3IuIFRoZSBndWFyZCBtdXN0IGRlZmVyXG4gIC8vIHRvIHRoZSBjYWNoZWQgcGhhc2VSZXN1bHRzIGZhbGxiYWNrIHNvIHRoZSB0dXJuIGNvbXBsZXRlcyBjbGVhbmx5LlxuICBhc3NlcnQuZG9lc05vdFRocm93KCgpID0+IHtcbiAgICBvYnNlcnZlci5vblR1cm5SZXN1bHQoe1xuICAgICAgdHJhY2VJZDogXCJ0cmFjZS1taXNzaW5nXCIsXG4gICAgICB0dXJuSWQ6IFwidHVybi1taXNzaW5nXCIsXG4gICAgICBpdGVyYXRpb246IDEsXG4gICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgIHN0YXR1czogXCJjb21wbGV0ZWRcIixcbiAgICAgIGZhaWx1cmVDbGFzczogXCJub25lXCIsXG4gICAgICAvLyBAdHMtZXhwZWN0LWVycm9yIGludGVudGlvbmFsbHkgbWlzc2luZyBmb3IgdGVzdFxuICAgICAgcGhhc2VSZXN1bHRzOiB1bmRlZmluZWQsXG4gICAgICBzdGFydGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIGZpbmlzaGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICB9KTtcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKGhhc0FjdGl2ZVdyaXRlclRva2VuKGJhc2VQYXRoLCBcInR1cm4tbWlzc2luZ1wiKSwgZmFsc2UpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsWUFBWSxhQUFhLGNBQWMsY0FBYztBQUM5RCxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBRXJCLFNBQVMsMEJBQTBCO0FBQ25DLFNBQVMsc0JBQXNCLGlDQUFpQztBQUVoRSxTQUFTLGtCQUFrQixVQUFrRDtBQUMzRSxRQUFNLE9BQU8sS0FBSyxVQUFVLFFBQVEsU0FBUyxjQUFjO0FBQzNELE1BQUksQ0FBQyxXQUFXLElBQUksRUFBRyxRQUFPLENBQUM7QUFDL0IsU0FBTyxhQUFhLE1BQU0sT0FBTyxFQUM5QixNQUFNLElBQUksRUFDVixPQUFPLE9BQU8sRUFDZCxJQUFJLENBQUMsU0FBUyxLQUFLLE1BQU0sSUFBSSxDQUEwQyxFQUN2RSxJQUFJLENBQUMsVUFBVSxNQUFNLFdBQVcsQ0FBQyxDQUFDO0FBQ3ZDO0FBRUEsS0FBSyxtRUFBbUUsQ0FBQyxNQUFNO0FBQzdFLFFBQU0sV0FBVyxZQUFZLEtBQUssT0FBTyxHQUFHLHNCQUFzQixDQUFDO0FBQ25FLDRCQUEwQjtBQUMxQixJQUFFLE1BQU0sTUFBTTtBQUNaLDhCQUEwQjtBQUMxQixXQUFPLFVBQVUsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUNuRCxDQUFDO0FBRUQsUUFBTSxXQUFXLG1CQUFtQjtBQUFBLElBQ2xDO0FBQUEsSUFDQSxXQUFXO0FBQUEsSUFDWCxTQUFTO0FBQUEsSUFDVCxhQUFhO0FBQUEsSUFDYixjQUFjO0FBQUEsRUFDaEIsQ0FBQztBQUVELFdBQVMsWUFBWTtBQUFBLElBQ25CO0FBQUEsSUFDQSxTQUFTO0FBQUEsSUFDVCxRQUFRO0FBQUEsSUFDUixXQUFXO0FBQUEsSUFDWCxVQUFVO0FBQUEsSUFDVixR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
