import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, closeDatabase, _getAdapter } from "../gsd-db.js";
import {
  setRuntimeKv,
  getRuntimeKv,
  deleteRuntimeKv,
  listRuntimeKv
} from "../db/runtime-kv.js";
function makeBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-runtime-kv-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}
function cleanup(base) {
  try {
    closeDatabase();
  } catch {
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
  }
}
test("set + get round-trip preserves the value", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  setRuntimeKv("global", "", "ui_cursor", { row: 5, col: 10 });
  const got = getRuntimeKv("global", "", "ui_cursor");
  assert.deepEqual(got, { row: 5, col: 10 });
});
test("get returns null for missing keys", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  assert.equal(getRuntimeKv("global", "", "missing"), null);
});
test("set on existing key updates the value (idempotent upsert)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  setRuntimeKv("worker", "w1", "counter", 1);
  setRuntimeKv("worker", "w1", "counter", 42);
  assert.equal(getRuntimeKv("worker", "w1", "counter"), 42);
});
test("scope partitioning: same key under different scopes is independent", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  setRuntimeKv("global", "", "k", "global-value");
  setRuntimeKv("worker", "w1", "k", "worker-value");
  setRuntimeKv("milestone", "M001", "k", "milestone-value");
  assert.equal(getRuntimeKv("global", "", "k"), "global-value");
  assert.equal(getRuntimeKv("worker", "w1", "k"), "worker-value");
  assert.equal(getRuntimeKv("milestone", "M001", "k"), "milestone-value");
});
test("scope_id partitioning: same scope+key under different scope_ids is independent", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  setRuntimeKv("worker", "w1", "k", "v1");
  setRuntimeKv("worker", "w2", "k", "v2");
  assert.equal(getRuntimeKv("worker", "w1", "k"), "v1");
  assert.equal(getRuntimeKv("worker", "w2", "k"), "v2");
});
test("delete removes the row; subsequent get returns null", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  setRuntimeKv("worker", "w1", "k", "value");
  deleteRuntimeKv("worker", "w1", "k");
  assert.equal(getRuntimeKv("worker", "w1", "k"), null);
});
test("list returns all rows for a scope+scope_id, ordered by key", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  setRuntimeKv("milestone", "M001", "alpha", 1);
  setRuntimeKv("milestone", "M001", "gamma", 3);
  setRuntimeKv("milestone", "M001", "beta", 2);
  setRuntimeKv("milestone", "M002", "ignored", "different-scope");
  const rows = listRuntimeKv("milestone", "M001");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.key), ["alpha", "beta", "gamma"]);
});
test("malformed JSON in storage returns null without throwing", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  openDatabase(join(base, ".gsd", "gsd.db"));
  setRuntimeKv("global", "", "k", "valid");
  const db = _getAdapter();
  db.prepare(
    `UPDATE runtime_kv SET value_json = '{not json' WHERE scope = 'global' AND scope_id = '' AND key = 'k'`
  ).run();
  assert.equal(getRuntimeKv("global", "", "k"), null);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9ydW50aW1lLWt2LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIGdzZC0yICsgcnVudGltZV9rdiBub24tY29ycmVjdG5lc3MtY3JpdGljYWwga2V5LXZhbHVlIHN0b3JhZ2UgdGVzdHMgKFBoYXNlIEMpXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBvcGVuRGF0YWJhc2UsIGNsb3NlRGF0YWJhc2UsIF9nZXRBZGFwdGVyIH0gZnJvbSBcIi4uL2dzZC1kYi50c1wiO1xuaW1wb3J0IHtcbiAgc2V0UnVudGltZUt2LFxuICBnZXRSdW50aW1lS3YsXG4gIGRlbGV0ZVJ1bnRpbWVLdixcbiAgbGlzdFJ1bnRpbWVLdixcbn0gZnJvbSBcIi4uL2RiL3J1bnRpbWUta3YudHNcIjtcblxuZnVuY3Rpb24gbWFrZUJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXJ1bnRpbWUta3YtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoYmFzZTogc3RyaW5nKTogdm9pZCB7XG4gIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfVxuICB0cnkgeyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9XG59XG5cbnRlc3QoXCJzZXQgKyBnZXQgcm91bmQtdHJpcCBwcmVzZXJ2ZXMgdGhlIHZhbHVlXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuXG4gIHNldFJ1bnRpbWVLdihcImdsb2JhbFwiLCBcIlwiLCBcInVpX2N1cnNvclwiLCB7IHJvdzogNSwgY29sOiAxMCB9KTtcbiAgY29uc3QgZ290ID0gZ2V0UnVudGltZUt2PHsgcm93OiBudW1iZXI7IGNvbDogbnVtYmVyIH0+KFwiZ2xvYmFsXCIsIFwiXCIsIFwidWlfY3Vyc29yXCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGdvdCwgeyByb3c6IDUsIGNvbDogMTAgfSk7XG59KTtcblxudGVzdChcImdldCByZXR1cm5zIG51bGwgZm9yIG1pc3Npbmcga2V5c1wiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGJhc2UpKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcblxuICBhc3NlcnQuZXF1YWwoZ2V0UnVudGltZUt2KFwiZ2xvYmFsXCIsIFwiXCIsIFwibWlzc2luZ1wiKSwgbnVsbCk7XG59KTtcblxudGVzdChcInNldCBvbiBleGlzdGluZyBrZXkgdXBkYXRlcyB0aGUgdmFsdWUgKGlkZW1wb3RlbnQgdXBzZXJ0KVwiLCAodCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWFrZUJhc2UoKTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGJhc2UpKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcblxuICBzZXRSdW50aW1lS3YoXCJ3b3JrZXJcIiwgXCJ3MVwiLCBcImNvdW50ZXJcIiwgMSk7XG4gIHNldFJ1bnRpbWVLdihcIndvcmtlclwiLCBcIncxXCIsIFwiY291bnRlclwiLCA0Mik7XG4gIGFzc2VydC5lcXVhbChnZXRSdW50aW1lS3YoXCJ3b3JrZXJcIiwgXCJ3MVwiLCBcImNvdW50ZXJcIiksIDQyKTtcbn0pO1xuXG50ZXN0KFwic2NvcGUgcGFydGl0aW9uaW5nOiBzYW1lIGtleSB1bmRlciBkaWZmZXJlbnQgc2NvcGVzIGlzIGluZGVwZW5kZW50XCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuXG4gIHNldFJ1bnRpbWVLdihcImdsb2JhbFwiLCBcIlwiLCBcImtcIiwgXCJnbG9iYWwtdmFsdWVcIik7XG4gIHNldFJ1bnRpbWVLdihcIndvcmtlclwiLCBcIncxXCIsIFwia1wiLCBcIndvcmtlci12YWx1ZVwiKTtcbiAgc2V0UnVudGltZUt2KFwibWlsZXN0b25lXCIsIFwiTTAwMVwiLCBcImtcIiwgXCJtaWxlc3RvbmUtdmFsdWVcIik7XG5cbiAgYXNzZXJ0LmVxdWFsKGdldFJ1bnRpbWVLdihcImdsb2JhbFwiLCBcIlwiLCBcImtcIiksIFwiZ2xvYmFsLXZhbHVlXCIpO1xuICBhc3NlcnQuZXF1YWwoZ2V0UnVudGltZUt2KFwid29ya2VyXCIsIFwidzFcIiwgXCJrXCIpLCBcIndvcmtlci12YWx1ZVwiKTtcbiAgYXNzZXJ0LmVxdWFsKGdldFJ1bnRpbWVLdihcIm1pbGVzdG9uZVwiLCBcIk0wMDFcIiwgXCJrXCIpLCBcIm1pbGVzdG9uZS12YWx1ZVwiKTtcbn0pO1xuXG50ZXN0KFwic2NvcGVfaWQgcGFydGl0aW9uaW5nOiBzYW1lIHNjb3BlK2tleSB1bmRlciBkaWZmZXJlbnQgc2NvcGVfaWRzIGlzIGluZGVwZW5kZW50XCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuXG4gIHNldFJ1bnRpbWVLdihcIndvcmtlclwiLCBcIncxXCIsIFwia1wiLCBcInYxXCIpO1xuICBzZXRSdW50aW1lS3YoXCJ3b3JrZXJcIiwgXCJ3MlwiLCBcImtcIiwgXCJ2MlwiKTtcbiAgYXNzZXJ0LmVxdWFsKGdldFJ1bnRpbWVLdihcIndvcmtlclwiLCBcIncxXCIsIFwia1wiKSwgXCJ2MVwiKTtcbiAgYXNzZXJ0LmVxdWFsKGdldFJ1bnRpbWVLdihcIndvcmtlclwiLCBcIncyXCIsIFwia1wiKSwgXCJ2MlwiKTtcbn0pO1xuXG50ZXN0KFwiZGVsZXRlIHJlbW92ZXMgdGhlIHJvdzsgc3Vic2VxdWVudCBnZXQgcmV0dXJucyBudWxsXCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuXG4gIHNldFJ1bnRpbWVLdihcIndvcmtlclwiLCBcIncxXCIsIFwia1wiLCBcInZhbHVlXCIpO1xuICBkZWxldGVSdW50aW1lS3YoXCJ3b3JrZXJcIiwgXCJ3MVwiLCBcImtcIik7XG4gIGFzc2VydC5lcXVhbChnZXRSdW50aW1lS3YoXCJ3b3JrZXJcIiwgXCJ3MVwiLCBcImtcIiksIG51bGwpO1xufSk7XG5cbnRlc3QoXCJsaXN0IHJldHVybnMgYWxsIHJvd3MgZm9yIGEgc2NvcGUrc2NvcGVfaWQsIG9yZGVyZWQgYnkga2V5XCIsICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICB0LmFmdGVyKCgpID0+IGNsZWFudXAoYmFzZSkpO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuXG4gIHNldFJ1bnRpbWVLdihcIm1pbGVzdG9uZVwiLCBcIk0wMDFcIiwgXCJhbHBoYVwiLCAxKTtcbiAgc2V0UnVudGltZUt2KFwibWlsZXN0b25lXCIsIFwiTTAwMVwiLCBcImdhbW1hXCIsIDMpO1xuICBzZXRSdW50aW1lS3YoXCJtaWxlc3RvbmVcIiwgXCJNMDAxXCIsIFwiYmV0YVwiLCAyKTtcbiAgc2V0UnVudGltZUt2KFwibWlsZXN0b25lXCIsIFwiTTAwMlwiLCBcImlnbm9yZWRcIiwgXCJkaWZmZXJlbnQtc2NvcGVcIik7XG5cbiAgY29uc3Qgcm93cyA9IGxpc3RSdW50aW1lS3YoXCJtaWxlc3RvbmVcIiwgXCJNMDAxXCIpO1xuICBhc3NlcnQuZXF1YWwocm93cy5sZW5ndGgsIDMpO1xuICBhc3NlcnQuZGVlcEVxdWFsKHJvd3MubWFwKHIgPT4gci5rZXkpLCBbXCJhbHBoYVwiLCBcImJldGFcIiwgXCJnYW1tYVwiXSk7XG59KTtcblxudGVzdChcIm1hbGZvcm1lZCBKU09OIGluIHN0b3JhZ2UgcmV0dXJucyBudWxsIHdpdGhvdXQgdGhyb3dpbmdcIiwgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1ha2VCYXNlKCk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChiYXNlKSk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG5cbiAgLy8gSW5qZWN0IGEgbWFsZm9ybWVkIHZhbHVlIGRpcmVjdGx5IChieXBhc3Npbmcgc2V0UnVudGltZUt2J3MgSlNPTi5zdHJpbmdpZnkpLlxuICBzZXRSdW50aW1lS3YoXCJnbG9iYWxcIiwgXCJcIiwgXCJrXCIsIFwidmFsaWRcIik7XG4gIC8vIFRoZW4gcG9pc29uIHRoZSByb3cgdmlhIHJhdyBTUUwuXG4gIGNvbnN0IGRiID0gX2dldEFkYXB0ZXIoKSE7XG4gIGRiLnByZXBhcmUoXG4gICAgYFVQREFURSBydW50aW1lX2t2IFNFVCB2YWx1ZV9qc29uID0gJ3tub3QganNvbicgV0hFUkUgc2NvcGUgPSAnZ2xvYmFsJyBBTkQgc2NvcGVfaWQgPSAnJyBBTkQga2V5ID0gJ2snYCxcbiAgKS5ydW4oKTtcblxuICBhc3NlcnQuZXF1YWwoZ2V0UnVudGltZUt2KFwiZ2xvYmFsXCIsIFwiXCIsIFwia1wiKSwgbnVsbCk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsY0FBYztBQUMvQyxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMsY0FBYyxlQUFlLG1CQUFtQjtBQUN6RDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBRVAsU0FBUyxXQUFtQjtBQUMxQixRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyxpQkFBaUIsQ0FBQztBQUMxRCxZQUFVLEtBQUssTUFBTSxNQUFNLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNqRCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLFFBQVEsTUFBb0I7QUFDbkMsTUFBSTtBQUFFLGtCQUFjO0FBQUEsRUFBRyxRQUFRO0FBQUEsRUFBYTtBQUM1QyxNQUFJO0FBQUUsV0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFBRyxRQUFRO0FBQUEsRUFBYTtBQUM3RTtBQUVBLEtBQUssNENBQTRDLENBQUMsTUFBTTtBQUN0RCxRQUFNLE9BQU8sU0FBUztBQUN0QixJQUFFLE1BQU0sTUFBTSxRQUFRLElBQUksQ0FBQztBQUMzQixlQUFhLEtBQUssTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUV6QyxlQUFhLFVBQVUsSUFBSSxhQUFhLEVBQUUsS0FBSyxHQUFHLEtBQUssR0FBRyxDQUFDO0FBQzNELFFBQU0sTUFBTSxhQUEyQyxVQUFVLElBQUksV0FBVztBQUNoRixTQUFPLFVBQVUsS0FBSyxFQUFFLEtBQUssR0FBRyxLQUFLLEdBQUcsQ0FBQztBQUMzQyxDQUFDO0FBRUQsS0FBSyxxQ0FBcUMsQ0FBQyxNQUFNO0FBQy9DLFFBQU0sT0FBTyxTQUFTO0FBQ3RCLElBQUUsTUFBTSxNQUFNLFFBQVEsSUFBSSxDQUFDO0FBQzNCLGVBQWEsS0FBSyxNQUFNLFFBQVEsUUFBUSxDQUFDO0FBRXpDLFNBQU8sTUFBTSxhQUFhLFVBQVUsSUFBSSxTQUFTLEdBQUcsSUFBSTtBQUMxRCxDQUFDO0FBRUQsS0FBSyw2REFBNkQsQ0FBQyxNQUFNO0FBQ3ZFLFFBQU0sT0FBTyxTQUFTO0FBQ3RCLElBQUUsTUFBTSxNQUFNLFFBQVEsSUFBSSxDQUFDO0FBQzNCLGVBQWEsS0FBSyxNQUFNLFFBQVEsUUFBUSxDQUFDO0FBRXpDLGVBQWEsVUFBVSxNQUFNLFdBQVcsQ0FBQztBQUN6QyxlQUFhLFVBQVUsTUFBTSxXQUFXLEVBQUU7QUFDMUMsU0FBTyxNQUFNLGFBQWEsVUFBVSxNQUFNLFNBQVMsR0FBRyxFQUFFO0FBQzFELENBQUM7QUFFRCxLQUFLLHNFQUFzRSxDQUFDLE1BQU07QUFDaEYsUUFBTSxPQUFPLFNBQVM7QUFDdEIsSUFBRSxNQUFNLE1BQU0sUUFBUSxJQUFJLENBQUM7QUFDM0IsZUFBYSxLQUFLLE1BQU0sUUFBUSxRQUFRLENBQUM7QUFFekMsZUFBYSxVQUFVLElBQUksS0FBSyxjQUFjO0FBQzlDLGVBQWEsVUFBVSxNQUFNLEtBQUssY0FBYztBQUNoRCxlQUFhLGFBQWEsUUFBUSxLQUFLLGlCQUFpQjtBQUV4RCxTQUFPLE1BQU0sYUFBYSxVQUFVLElBQUksR0FBRyxHQUFHLGNBQWM7QUFDNUQsU0FBTyxNQUFNLGFBQWEsVUFBVSxNQUFNLEdBQUcsR0FBRyxjQUFjO0FBQzlELFNBQU8sTUFBTSxhQUFhLGFBQWEsUUFBUSxHQUFHLEdBQUcsaUJBQWlCO0FBQ3hFLENBQUM7QUFFRCxLQUFLLGtGQUFrRixDQUFDLE1BQU07QUFDNUYsUUFBTSxPQUFPLFNBQVM7QUFDdEIsSUFBRSxNQUFNLE1BQU0sUUFBUSxJQUFJLENBQUM7QUFDM0IsZUFBYSxLQUFLLE1BQU0sUUFBUSxRQUFRLENBQUM7QUFFekMsZUFBYSxVQUFVLE1BQU0sS0FBSyxJQUFJO0FBQ3RDLGVBQWEsVUFBVSxNQUFNLEtBQUssSUFBSTtBQUN0QyxTQUFPLE1BQU0sYUFBYSxVQUFVLE1BQU0sR0FBRyxHQUFHLElBQUk7QUFDcEQsU0FBTyxNQUFNLGFBQWEsVUFBVSxNQUFNLEdBQUcsR0FBRyxJQUFJO0FBQ3RELENBQUM7QUFFRCxLQUFLLHVEQUF1RCxDQUFDLE1BQU07QUFDakUsUUFBTSxPQUFPLFNBQVM7QUFDdEIsSUFBRSxNQUFNLE1BQU0sUUFBUSxJQUFJLENBQUM7QUFDM0IsZUFBYSxLQUFLLE1BQU0sUUFBUSxRQUFRLENBQUM7QUFFekMsZUFBYSxVQUFVLE1BQU0sS0FBSyxPQUFPO0FBQ3pDLGtCQUFnQixVQUFVLE1BQU0sR0FBRztBQUNuQyxTQUFPLE1BQU0sYUFBYSxVQUFVLE1BQU0sR0FBRyxHQUFHLElBQUk7QUFDdEQsQ0FBQztBQUVELEtBQUssOERBQThELENBQUMsTUFBTTtBQUN4RSxRQUFNLE9BQU8sU0FBUztBQUN0QixJQUFFLE1BQU0sTUFBTSxRQUFRLElBQUksQ0FBQztBQUMzQixlQUFhLEtBQUssTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUV6QyxlQUFhLGFBQWEsUUFBUSxTQUFTLENBQUM7QUFDNUMsZUFBYSxhQUFhLFFBQVEsU0FBUyxDQUFDO0FBQzVDLGVBQWEsYUFBYSxRQUFRLFFBQVEsQ0FBQztBQUMzQyxlQUFhLGFBQWEsUUFBUSxXQUFXLGlCQUFpQjtBQUU5RCxRQUFNLE9BQU8sY0FBYyxhQUFhLE1BQU07QUFDOUMsU0FBTyxNQUFNLEtBQUssUUFBUSxDQUFDO0FBQzNCLFNBQU8sVUFBVSxLQUFLLElBQUksT0FBSyxFQUFFLEdBQUcsR0FBRyxDQUFDLFNBQVMsUUFBUSxPQUFPLENBQUM7QUFDbkUsQ0FBQztBQUVELEtBQUssMkRBQTJELENBQUMsTUFBTTtBQUNyRSxRQUFNLE9BQU8sU0FBUztBQUN0QixJQUFFLE1BQU0sTUFBTSxRQUFRLElBQUksQ0FBQztBQUMzQixlQUFhLEtBQUssTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUd6QyxlQUFhLFVBQVUsSUFBSSxLQUFLLE9BQU87QUFFdkMsUUFBTSxLQUFLLFlBQVk7QUFDdkIsS0FBRztBQUFBLElBQ0Q7QUFBQSxFQUNGLEVBQUUsSUFBSTtBQUVOLFNBQU8sTUFBTSxhQUFhLFVBQVUsSUFBSSxHQUFHLEdBQUcsSUFBSTtBQUNwRCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
