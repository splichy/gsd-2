import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  logWarning,
  logError,
  setLogBasePath,
  _resetLogs,
  peekLogs,
  drainLogs
} from "../workflow-logger.js";
function createTempProject() {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-wflog-test-"));
  mkdirSync(join(tmp, ".gsd"), { recursive: true });
  return tmp;
}
function readAuditLines(basePath) {
  const auditPath = join(basePath, ".gsd", "audit-log.jsonl");
  if (!existsSync(auditPath)) return [];
  const content = readFileSync(auditPath, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line));
}
describe("workflow-logger audit persistence", () => {
  let tmp;
  beforeEach(() => {
    tmp = createTempProject();
    _resetLogs();
    setLogBasePath(tmp);
  });
  afterEach(() => {
    _resetLogs();
    setLogBasePath(null);
    rmSync(tmp, { recursive: true, force: true });
  });
  test("logError persists to audit-log.jsonl", () => {
    logError("engine", "something broke");
    const lines = readAuditLines(tmp);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].severity, "error");
    assert.equal(lines[0].component, "engine");
  });
  test("logWarning does NOT persist to audit-log.jsonl", () => {
    logWarning("engine", "something fishy");
    const lines = readAuditLines(tmp);
    assert.equal(lines.length, 0, "warnings must not be persisted to audit log");
  });
  test("logWarning still appears in in-memory buffer", () => {
    logWarning("recovery", "probe miss");
    const entries = peekLogs();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].severity, "warn");
    assert.equal(entries[0].component, "recovery");
  });
  test("persisted error messages are truncated at 200 chars", () => {
    const longMessage = "x".repeat(300);
    logError("engine", longMessage);
    const lines = readAuditLines(tmp);
    assert.equal(lines.length, 1);
    const msg = lines[0].message;
    assert.ok(msg.length <= 215, `message should be truncated, got ${msg.length} chars`);
    assert.ok(msg.endsWith("\u2026[truncated]"));
  });
  test("persisted errors have context filtered to safe allowlist", () => {
    logError("tool", "tool failed", {
      fn: "saveDecisionToDb",
      tool: "gsd_decision_save",
      error: "SQLITE_BUSY: database is locked",
      file: "/home/user/project/gsd.db"
    });
    const lines = readAuditLines(tmp);
    assert.equal(lines.length, 1);
    const ctx = lines[0].context;
    assert.ok(ctx, "context should exist");
    assert.equal(ctx.fn, "saveDecisionToDb");
    assert.equal(ctx.tool, "gsd_decision_save");
    assert.equal(ctx.error, "SQLITE_BUSY: database is locked", "error key should be preserved in persisted context");
    assert.equal(ctx.file, void 0, "file key must be stripped from persisted context");
  });
  test("persisted errors preserve error key but strip other unsafe keys", () => {
    logError("bootstrap", "ensureDbOpen failed", {
      error: "ENOENT",
      cwd: "/home/user/project"
    });
    const lines = readAuditLines(tmp);
    assert.equal(lines.length, 1);
    const ctx = lines[0].context;
    assert.ok(ctx, "context should exist when error key is present");
    assert.equal(ctx.error, "ENOENT", "error key should be preserved");
    assert.equal(ctx.cwd, void 0, "cwd key must be stripped");
  });
  test("mixed warnings and errors only persist errors", () => {
    logWarning("recovery", "main not found");
    logWarning("recovery", "master not found");
    logError("engine", "fatal failure");
    logWarning("prompt", "cache miss");
    const lines = readAuditLines(tmp);
    assert.equal(lines.length, 1, "only the error should be persisted");
    assert.equal(lines[0].severity, "error");
    const buffered = drainLogs();
    assert.equal(buffered.length, 4, "all entries should be in the in-memory buffer");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrZmxvdy1sb2dnZXItYXVkaXQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIEV4dGVuc2lvbiBcdTIwMTQgV29ya2Zsb3cgTG9nZ2VyIEF1ZGl0IFBlcnNpc3RlbmNlIFRlc3RzXG4vLyBWYWxpZGF0ZXMgZXJyb3Itb25seSBwZXJzaXN0ZW5jZSwgc2FuaXRpemF0aW9uLCBhbmQgd2FybmluZyBlcGhlbWVyYWwgYmVoYXZpb3IuXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0LCBiZWZvcmVFYWNoLCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgZXhpc3RzU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQge1xuICBsb2dXYXJuaW5nLFxuICBsb2dFcnJvcixcbiAgc2V0TG9nQmFzZVBhdGgsXG4gIF9yZXNldExvZ3MsXG4gIHBlZWtMb2dzLFxuICBkcmFpbkxvZ3MsXG59IGZyb20gXCIuLi93b3JrZmxvdy1sb2dnZXIudHNcIjtcblxuZnVuY3Rpb24gY3JlYXRlVGVtcFByb2plY3QoKTogc3RyaW5nIHtcbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtd2Zsb2ctdGVzdC1cIikpO1xuICBta2RpclN5bmMoam9pbih0bXAsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiB0bXA7XG59XG5cbmZ1bmN0aW9uIHJlYWRBdWRpdExpbmVzKGJhc2VQYXRoOiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPltdIHtcbiAgY29uc3QgYXVkaXRQYXRoID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwiYXVkaXQtbG9nLmpzb25sXCIpO1xuICBpZiAoIWV4aXN0c1N5bmMoYXVkaXRQYXRoKSkgcmV0dXJuIFtdO1xuICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGF1ZGl0UGF0aCwgXCJ1dGYtOFwiKS50cmltKCk7XG4gIGlmICghY29udGVudCkgcmV0dXJuIFtdO1xuICByZXR1cm4gY29udGVudC5zcGxpdChcIlxcblwiKS5tYXAoKGxpbmUpID0+IEpTT04ucGFyc2UobGluZSkpO1xufVxuXG5kZXNjcmliZShcIndvcmtmbG93LWxvZ2dlciBhdWRpdCBwZXJzaXN0ZW5jZVwiLCAoKSA9PiB7XG4gIGxldCB0bXA6IHN0cmluZztcblxuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICB0bXAgPSBjcmVhdGVUZW1wUHJvamVjdCgpO1xuICAgIF9yZXNldExvZ3MoKTtcbiAgICBzZXRMb2dCYXNlUGF0aCh0bXApO1xuICB9KTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIF9yZXNldExvZ3MoKTtcbiAgICBzZXRMb2dCYXNlUGF0aChudWxsIGFzIHVua25vd24gYXMgc3RyaW5nKTtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJsb2dFcnJvciBwZXJzaXN0cyB0byBhdWRpdC1sb2cuanNvbmxcIiwgKCkgPT4ge1xuICAgIGxvZ0Vycm9yKFwiZW5naW5lXCIsIFwic29tZXRoaW5nIGJyb2tlXCIpO1xuICAgIGNvbnN0IGxpbmVzID0gcmVhZEF1ZGl0TGluZXModG1wKTtcbiAgICBhc3NlcnQuZXF1YWwobGluZXMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwobGluZXNbMF0uc2V2ZXJpdHksIFwiZXJyb3JcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGxpbmVzWzBdLmNvbXBvbmVudCwgXCJlbmdpbmVcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJsb2dXYXJuaW5nIGRvZXMgTk9UIHBlcnNpc3QgdG8gYXVkaXQtbG9nLmpzb25sXCIsICgpID0+IHtcbiAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIFwic29tZXRoaW5nIGZpc2h5XCIpO1xuICAgIGNvbnN0IGxpbmVzID0gcmVhZEF1ZGl0TGluZXModG1wKTtcbiAgICBhc3NlcnQuZXF1YWwobGluZXMubGVuZ3RoLCAwLCBcIndhcm5pbmdzIG11c3Qgbm90IGJlIHBlcnNpc3RlZCB0byBhdWRpdCBsb2dcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJsb2dXYXJuaW5nIHN0aWxsIGFwcGVhcnMgaW4gaW4tbWVtb3J5IGJ1ZmZlclwiLCAoKSA9PiB7XG4gICAgbG9nV2FybmluZyhcInJlY292ZXJ5XCIsIFwicHJvYmUgbWlzc1wiKTtcbiAgICBjb25zdCBlbnRyaWVzID0gcGVla0xvZ3MoKTtcbiAgICBhc3NlcnQuZXF1YWwoZW50cmllcy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChlbnRyaWVzWzBdLnNldmVyaXR5LCBcIndhcm5cIik7XG4gICAgYXNzZXJ0LmVxdWFsKGVudHJpZXNbMF0uY29tcG9uZW50LCBcInJlY292ZXJ5XCIpO1xuICB9KTtcblxuICB0ZXN0KFwicGVyc2lzdGVkIGVycm9yIG1lc3NhZ2VzIGFyZSB0cnVuY2F0ZWQgYXQgMjAwIGNoYXJzXCIsICgpID0+IHtcbiAgICBjb25zdCBsb25nTWVzc2FnZSA9IFwieFwiLnJlcGVhdCgzMDApO1xuICAgIGxvZ0Vycm9yKFwiZW5naW5lXCIsIGxvbmdNZXNzYWdlKTtcbiAgICBjb25zdCBsaW5lcyA9IHJlYWRBdWRpdExpbmVzKHRtcCk7XG4gICAgYXNzZXJ0LmVxdWFsKGxpbmVzLmxlbmd0aCwgMSk7XG4gICAgY29uc3QgbXNnID0gbGluZXNbMF0ubWVzc2FnZSBhcyBzdHJpbmc7XG4gICAgYXNzZXJ0Lm9rKG1zZy5sZW5ndGggPD0gMjE1LCBgbWVzc2FnZSBzaG91bGQgYmUgdHJ1bmNhdGVkLCBnb3QgJHttc2cubGVuZ3RofSBjaGFyc2ApO1xuICAgIGFzc2VydC5vayhtc2cuZW5kc1dpdGgoXCJcdTIwMjZbdHJ1bmNhdGVkXVwiKSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJwZXJzaXN0ZWQgZXJyb3JzIGhhdmUgY29udGV4dCBmaWx0ZXJlZCB0byBzYWZlIGFsbG93bGlzdFwiLCAoKSA9PiB7XG4gICAgbG9nRXJyb3IoXCJ0b29sXCIsIFwidG9vbCBmYWlsZWRcIiwge1xuICAgICAgZm46IFwic2F2ZURlY2lzaW9uVG9EYlwiLFxuICAgICAgdG9vbDogXCJnc2RfZGVjaXNpb25fc2F2ZVwiLFxuICAgICAgZXJyb3I6IFwiU1FMSVRFX0JVU1k6IGRhdGFiYXNlIGlzIGxvY2tlZFwiLFxuICAgICAgZmlsZTogXCIvaG9tZS91c2VyL3Byb2plY3QvZ3NkLmRiXCIsXG4gICAgfSk7XG4gICAgY29uc3QgbGluZXMgPSByZWFkQXVkaXRMaW5lcyh0bXApO1xuICAgIGFzc2VydC5lcXVhbChsaW5lcy5sZW5ndGgsIDEpO1xuICAgIGNvbnN0IGN0eCA9IGxpbmVzWzBdLmNvbnRleHQgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgICBhc3NlcnQub2soY3R4LCBcImNvbnRleHQgc2hvdWxkIGV4aXN0XCIpO1xuICAgIGFzc2VydC5lcXVhbChjdHguZm4sIFwic2F2ZURlY2lzaW9uVG9EYlwiKTtcbiAgICBhc3NlcnQuZXF1YWwoY3R4LnRvb2wsIFwiZ3NkX2RlY2lzaW9uX3NhdmVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGN0eC5lcnJvciwgXCJTUUxJVEVfQlVTWTogZGF0YWJhc2UgaXMgbG9ja2VkXCIsIFwiZXJyb3Iga2V5IHNob3VsZCBiZSBwcmVzZXJ2ZWQgaW4gcGVyc2lzdGVkIGNvbnRleHRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGN0eC5maWxlLCB1bmRlZmluZWQsIFwiZmlsZSBrZXkgbXVzdCBiZSBzdHJpcHBlZCBmcm9tIHBlcnNpc3RlZCBjb250ZXh0XCIpO1xuICB9KTtcblxuICB0ZXN0KFwicGVyc2lzdGVkIGVycm9ycyBwcmVzZXJ2ZSBlcnJvciBrZXkgYnV0IHN0cmlwIG90aGVyIHVuc2FmZSBrZXlzXCIsICgpID0+IHtcbiAgICBsb2dFcnJvcihcImJvb3RzdHJhcFwiLCBcImVuc3VyZURiT3BlbiBmYWlsZWRcIiwge1xuICAgICAgZXJyb3I6IFwiRU5PRU5UXCIsXG4gICAgICBjd2Q6IFwiL2hvbWUvdXNlci9wcm9qZWN0XCIsXG4gICAgfSk7XG4gICAgY29uc3QgbGluZXMgPSByZWFkQXVkaXRMaW5lcyh0bXApO1xuICAgIGFzc2VydC5lcXVhbChsaW5lcy5sZW5ndGgsIDEpO1xuICAgIGNvbnN0IGN0eCA9IGxpbmVzWzBdLmNvbnRleHQgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgICBhc3NlcnQub2soY3R4LCBcImNvbnRleHQgc2hvdWxkIGV4aXN0IHdoZW4gZXJyb3Iga2V5IGlzIHByZXNlbnRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGN0eC5lcnJvciwgXCJFTk9FTlRcIiwgXCJlcnJvciBrZXkgc2hvdWxkIGJlIHByZXNlcnZlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoY3R4LmN3ZCwgdW5kZWZpbmVkLCBcImN3ZCBrZXkgbXVzdCBiZSBzdHJpcHBlZFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcIm1peGVkIHdhcm5pbmdzIGFuZCBlcnJvcnMgb25seSBwZXJzaXN0IGVycm9yc1wiLCAoKSA9PiB7XG4gICAgbG9nV2FybmluZyhcInJlY292ZXJ5XCIsIFwibWFpbiBub3QgZm91bmRcIik7XG4gICAgbG9nV2FybmluZyhcInJlY292ZXJ5XCIsIFwibWFzdGVyIG5vdCBmb3VuZFwiKTtcbiAgICBsb2dFcnJvcihcImVuZ2luZVwiLCBcImZhdGFsIGZhaWx1cmVcIik7XG4gICAgbG9nV2FybmluZyhcInByb21wdFwiLCBcImNhY2hlIG1pc3NcIik7XG5cbiAgICBjb25zdCBsaW5lcyA9IHJlYWRBdWRpdExpbmVzKHRtcCk7XG4gICAgYXNzZXJ0LmVxdWFsKGxpbmVzLmxlbmd0aCwgMSwgXCJvbmx5IHRoZSBlcnJvciBzaG91bGQgYmUgcGVyc2lzdGVkXCIpO1xuICAgIGFzc2VydC5lcXVhbChsaW5lc1swXS5zZXZlcml0eSwgXCJlcnJvclwiKTtcblxuICAgIGNvbnN0IGJ1ZmZlcmVkID0gZHJhaW5Mb2dzKCk7XG4gICAgYXNzZXJ0LmVxdWFsKGJ1ZmZlcmVkLmxlbmd0aCwgNCwgXCJhbGwgZW50cmllcyBzaG91bGQgYmUgaW4gdGhlIGluLW1lbW9yeSBidWZmZXJcIik7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxTQUFTLFVBQVUsTUFBTSxZQUFZLGlCQUFpQjtBQUN0RCxPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsY0FBYyxZQUFZLGNBQWM7QUFDekUsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFFUCxTQUFTLG9CQUE0QjtBQUNuQyxRQUFNLE1BQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyxpQkFBaUIsQ0FBQztBQUN6RCxZQUFVLEtBQUssS0FBSyxNQUFNLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNoRCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGVBQWUsVUFBNkM7QUFDbkUsUUFBTSxZQUFZLEtBQUssVUFBVSxRQUFRLGlCQUFpQjtBQUMxRCxNQUFJLENBQUMsV0FBVyxTQUFTLEVBQUcsUUFBTyxDQUFDO0FBQ3BDLFFBQU0sVUFBVSxhQUFhLFdBQVcsT0FBTyxFQUFFLEtBQUs7QUFDdEQsTUFBSSxDQUFDLFFBQVMsUUFBTyxDQUFDO0FBQ3RCLFNBQU8sUUFBUSxNQUFNLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxLQUFLLE1BQU0sSUFBSSxDQUFDO0FBQzNEO0FBRUEsU0FBUyxxQ0FBcUMsTUFBTTtBQUNsRCxNQUFJO0FBRUosYUFBVyxNQUFNO0FBQ2YsVUFBTSxrQkFBa0I7QUFDeEIsZUFBVztBQUNYLG1CQUFlLEdBQUc7QUFBQSxFQUNwQixDQUFDO0FBRUQsWUFBVSxNQUFNO0FBQ2QsZUFBVztBQUNYLG1CQUFlLElBQXlCO0FBQ3hDLFdBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQzlDLENBQUM7QUFFRCxPQUFLLHdDQUF3QyxNQUFNO0FBQ2pELGFBQVMsVUFBVSxpQkFBaUI7QUFDcEMsVUFBTSxRQUFRLGVBQWUsR0FBRztBQUNoQyxXQUFPLE1BQU0sTUFBTSxRQUFRLENBQUM7QUFDNUIsV0FBTyxNQUFNLE1BQU0sQ0FBQyxFQUFFLFVBQVUsT0FBTztBQUN2QyxXQUFPLE1BQU0sTUFBTSxDQUFDLEVBQUUsV0FBVyxRQUFRO0FBQUEsRUFDM0MsQ0FBQztBQUVELE9BQUssa0RBQWtELE1BQU07QUFDM0QsZUFBVyxVQUFVLGlCQUFpQjtBQUN0QyxVQUFNLFFBQVEsZUFBZSxHQUFHO0FBQ2hDLFdBQU8sTUFBTSxNQUFNLFFBQVEsR0FBRyw2Q0FBNkM7QUFBQSxFQUM3RSxDQUFDO0FBRUQsT0FBSyxnREFBZ0QsTUFBTTtBQUN6RCxlQUFXLFlBQVksWUFBWTtBQUNuQyxVQUFNLFVBQVUsU0FBUztBQUN6QixXQUFPLE1BQU0sUUFBUSxRQUFRLENBQUM7QUFDOUIsV0FBTyxNQUFNLFFBQVEsQ0FBQyxFQUFFLFVBQVUsTUFBTTtBQUN4QyxXQUFPLE1BQU0sUUFBUSxDQUFDLEVBQUUsV0FBVyxVQUFVO0FBQUEsRUFDL0MsQ0FBQztBQUVELE9BQUssdURBQXVELE1BQU07QUFDaEUsVUFBTSxjQUFjLElBQUksT0FBTyxHQUFHO0FBQ2xDLGFBQVMsVUFBVSxXQUFXO0FBQzlCLFVBQU0sUUFBUSxlQUFlLEdBQUc7QUFDaEMsV0FBTyxNQUFNLE1BQU0sUUFBUSxDQUFDO0FBQzVCLFVBQU0sTUFBTSxNQUFNLENBQUMsRUFBRTtBQUNyQixXQUFPLEdBQUcsSUFBSSxVQUFVLEtBQUssb0NBQW9DLElBQUksTUFBTSxRQUFRO0FBQ25GLFdBQU8sR0FBRyxJQUFJLFNBQVMsbUJBQWMsQ0FBQztBQUFBLEVBQ3hDLENBQUM7QUFFRCxPQUFLLDREQUE0RCxNQUFNO0FBQ3JFLGFBQVMsUUFBUSxlQUFlO0FBQUEsTUFDOUIsSUFBSTtBQUFBLE1BQ0osTUFBTTtBQUFBLE1BQ04sT0FBTztBQUFBLE1BQ1AsTUFBTTtBQUFBLElBQ1IsQ0FBQztBQUNELFVBQU0sUUFBUSxlQUFlLEdBQUc7QUFDaEMsV0FBTyxNQUFNLE1BQU0sUUFBUSxDQUFDO0FBQzVCLFVBQU0sTUFBTSxNQUFNLENBQUMsRUFBRTtBQUNyQixXQUFPLEdBQUcsS0FBSyxzQkFBc0I7QUFDckMsV0FBTyxNQUFNLElBQUksSUFBSSxrQkFBa0I7QUFDdkMsV0FBTyxNQUFNLElBQUksTUFBTSxtQkFBbUI7QUFDMUMsV0FBTyxNQUFNLElBQUksT0FBTyxtQ0FBbUMsb0RBQW9EO0FBQy9HLFdBQU8sTUFBTSxJQUFJLE1BQU0sUUFBVyxrREFBa0Q7QUFBQSxFQUN0RixDQUFDO0FBRUQsT0FBSyxtRUFBbUUsTUFBTTtBQUM1RSxhQUFTLGFBQWEsdUJBQXVCO0FBQUEsTUFDM0MsT0FBTztBQUFBLE1BQ1AsS0FBSztBQUFBLElBQ1AsQ0FBQztBQUNELFVBQU0sUUFBUSxlQUFlLEdBQUc7QUFDaEMsV0FBTyxNQUFNLE1BQU0sUUFBUSxDQUFDO0FBQzVCLFVBQU0sTUFBTSxNQUFNLENBQUMsRUFBRTtBQUNyQixXQUFPLEdBQUcsS0FBSyxnREFBZ0Q7QUFDL0QsV0FBTyxNQUFNLElBQUksT0FBTyxVQUFVLCtCQUErQjtBQUNqRSxXQUFPLE1BQU0sSUFBSSxLQUFLLFFBQVcsMEJBQTBCO0FBQUEsRUFDN0QsQ0FBQztBQUVELE9BQUssaURBQWlELE1BQU07QUFDMUQsZUFBVyxZQUFZLGdCQUFnQjtBQUN2QyxlQUFXLFlBQVksa0JBQWtCO0FBQ3pDLGFBQVMsVUFBVSxlQUFlO0FBQ2xDLGVBQVcsVUFBVSxZQUFZO0FBRWpDLFVBQU0sUUFBUSxlQUFlLEdBQUc7QUFDaEMsV0FBTyxNQUFNLE1BQU0sUUFBUSxHQUFHLG9DQUFvQztBQUNsRSxXQUFPLE1BQU0sTUFBTSxDQUFDLEVBQUUsVUFBVSxPQUFPO0FBRXZDLFVBQU0sV0FBVyxVQUFVO0FBQzNCLFdBQU8sTUFBTSxTQUFTLFFBQVEsR0FBRywrQ0FBK0M7QUFBQSxFQUNsRixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
