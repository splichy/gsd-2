import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveJsonFile, loadJsonFile } from "../json-persistence.js";
describe("saveJsonFile atomic write", () => {
  test("writes JSON file correctly", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gsd-json-test-"));
    try {
      const file = join(tmp, "test.json");
      saveJsonFile(file, { key: "value" });
      const content = JSON.parse(readFileSync(file, "utf-8"));
      assert.deepStrictEqual(content, { key: "value" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  test("no .tmp file left after successful write", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gsd-json-test-"));
    try {
      const file = join(tmp, "test.json");
      saveJsonFile(file, { data: 123 });
      const files = readdirSync(tmp);
      const tmpFiles = files.filter((f) => f.includes(".tmp"));
      assert.strictEqual(tmpFiles.length, 0, "No .tmp files should remain after write");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  test("concurrent writes don't corrupt data", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gsd-json-test-"));
    try {
      const file = join(tmp, "shared.json");
      saveJsonFile(file, { writer: "first" });
      saveJsonFile(file, { writer: "second" });
      const content = JSON.parse(readFileSync(file, "utf-8"));
      assert.strictEqual(content.writer, "second");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  test("round-trip through loadJsonFile", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gsd-json-test-"));
    try {
      const file = join(tmp, "roundtrip.json");
      const data = { items: [1, 2, 3], name: "test" };
      saveJsonFile(file, data);
      const loaded = loadJsonFile(
        file,
        (d) => typeof d === "object" && d !== null && "items" in d,
        () => ({ items: [], name: "" })
      );
      assert.deepStrictEqual(loaded.items, [1, 2, 3]);
      assert.strictEqual(loaded.name, "test");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93YXZlNC13cml0ZS1zYWZldHktcmVncmVzc2lvbnMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIFN0YXRlIE1hY2hpbmUgXHUyMDE0IFdhdmUgNCBXcml0ZSBTYWZldHkgUmVncmVzc2lvbiBUZXN0c1xuLy8gVmFsaWRhdGVzIHJhbmRvbWl6ZWQgdG1wIHN1ZmZpeCBpbiBqc29uLXBlcnNpc3RlbmNlIGFuZCBhdG9taWMgd3JpdGVzLlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIHJlYWRGaWxlU3luYywgcmVhZGRpclN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IHNhdmVKc29uRmlsZSwgbG9hZEpzb25GaWxlIH0gZnJvbSBcIi4uL2pzb24tcGVyc2lzdGVuY2UuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwIEZpeCAxNToganNvbi1wZXJzaXN0ZW5jZSB1c2VzIHJhbmRvbWl6ZWQgdG1wIHN1ZmZpeCBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJzYXZlSnNvbkZpbGUgYXRvbWljIHdyaXRlXCIsICgpID0+IHtcbiAgdGVzdChcIndyaXRlcyBKU09OIGZpbGUgY29ycmVjdGx5XCIsICgpID0+IHtcbiAgICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1qc29uLXRlc3QtXCIpKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZmlsZSA9IGpvaW4odG1wLCBcInRlc3QuanNvblwiKTtcbiAgICAgIHNhdmVKc29uRmlsZShmaWxlLCB7IGtleTogXCJ2YWx1ZVwiIH0pO1xuICAgICAgY29uc3QgY29udGVudCA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGZpbGUsIFwidXRmLThcIikpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChjb250ZW50LCB7IGtleTogXCJ2YWx1ZVwiIH0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwibm8gLnRtcCBmaWxlIGxlZnQgYWZ0ZXIgc3VjY2Vzc2Z1bCB3cml0ZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtanNvbi10ZXN0LVwiKSk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGZpbGUgPSBqb2luKHRtcCwgXCJ0ZXN0Lmpzb25cIik7XG4gICAgICBzYXZlSnNvbkZpbGUoZmlsZSwgeyBkYXRhOiAxMjMgfSk7XG4gICAgICBjb25zdCBmaWxlcyA9IHJlYWRkaXJTeW5jKHRtcCk7XG4gICAgICBjb25zdCB0bXBGaWxlcyA9IGZpbGVzLmZpbHRlcigoZjogc3RyaW5nKSA9PiBmLmluY2x1ZGVzKFwiLnRtcFwiKSk7XG4gICAgICBhc3NlcnQuc3RyaWN0RXF1YWwodG1wRmlsZXMubGVuZ3RoLCAwLCBcIk5vIC50bXAgZmlsZXMgc2hvdWxkIHJlbWFpbiBhZnRlciB3cml0ZVwiKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcImNvbmN1cnJlbnQgd3JpdGVzIGRvbid0IGNvcnJ1cHQgZGF0YVwiLCAoKSA9PiB7XG4gICAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtanNvbi10ZXN0LVwiKSk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGZpbGUgPSBqb2luKHRtcCwgXCJzaGFyZWQuanNvblwiKTtcbiAgICAgIC8vIFdyaXRlIHR3byBkaWZmZXJlbnQgdmFsdWVzIHJhcGlkbHkgXHUyMDE0IGJvdGggc2hvdWxkIHN1Y2NlZWQgd2l0aG91dCBjb3JydXB0aW9uXG4gICAgICBzYXZlSnNvbkZpbGUoZmlsZSwgeyB3cml0ZXI6IFwiZmlyc3RcIiB9KTtcbiAgICAgIHNhdmVKc29uRmlsZShmaWxlLCB7IHdyaXRlcjogXCJzZWNvbmRcIiB9KTtcbiAgICAgIGNvbnN0IGNvbnRlbnQgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhmaWxlLCBcInV0Zi04XCIpKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChjb250ZW50LndyaXRlciwgXCJzZWNvbmRcIik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJyb3VuZC10cmlwIHRocm91Z2ggbG9hZEpzb25GaWxlXCIsICgpID0+IHtcbiAgICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1qc29uLXRlc3QtXCIpKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZmlsZSA9IGpvaW4odG1wLCBcInJvdW5kdHJpcC5qc29uXCIpO1xuICAgICAgY29uc3QgZGF0YSA9IHsgaXRlbXM6IFsxLCAyLCAzXSwgbmFtZTogXCJ0ZXN0XCIgfTtcbiAgICAgIHNhdmVKc29uRmlsZShmaWxlLCBkYXRhKTtcbiAgICAgIGNvbnN0IGxvYWRlZCA9IGxvYWRKc29uRmlsZShcbiAgICAgICAgZmlsZSxcbiAgICAgICAgKGQpOiBkIGlzIHR5cGVvZiBkYXRhID0+IHR5cGVvZiBkID09PSBcIm9iamVjdFwiICYmIGQgIT09IG51bGwgJiYgXCJpdGVtc1wiIGluIGQsXG4gICAgICAgICgpID0+ICh7IGl0ZW1zOiBbXSwgbmFtZTogXCJcIiB9KSxcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGxvYWRlZC5pdGVtcywgWzEsIDIsIDNdKTtcbiAgICAgIGFzc2VydC5zdHJpY3RFcXVhbChsb2FkZWQubmFtZSwgXCJ0ZXN0XCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxjQUFjLGFBQWEsY0FBYztBQUMvRCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsY0FBYyxvQkFBb0I7QUFJM0MsU0FBUyw2QkFBNkIsTUFBTTtBQUMxQyxPQUFLLDhCQUE4QixNQUFNO0FBQ3ZDLFVBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGdCQUFnQixDQUFDO0FBQ3hELFFBQUk7QUFDRixZQUFNLE9BQU8sS0FBSyxLQUFLLFdBQVc7QUFDbEMsbUJBQWEsTUFBTSxFQUFFLEtBQUssUUFBUSxDQUFDO0FBQ25DLFlBQU0sVUFBVSxLQUFLLE1BQU0sYUFBYSxNQUFNLE9BQU8sQ0FBQztBQUN0RCxhQUFPLGdCQUFnQixTQUFTLEVBQUUsS0FBSyxRQUFRLENBQUM7QUFBQSxJQUNsRCxVQUFFO0FBQ0EsYUFBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDOUM7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLDRDQUE0QyxNQUFNO0FBQ3JELFVBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGdCQUFnQixDQUFDO0FBQ3hELFFBQUk7QUFDRixZQUFNLE9BQU8sS0FBSyxLQUFLLFdBQVc7QUFDbEMsbUJBQWEsTUFBTSxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBQ2hDLFlBQU0sUUFBUSxZQUFZLEdBQUc7QUFDN0IsWUFBTSxXQUFXLE1BQU0sT0FBTyxDQUFDLE1BQWMsRUFBRSxTQUFTLE1BQU0sQ0FBQztBQUMvRCxhQUFPLFlBQVksU0FBUyxRQUFRLEdBQUcseUNBQXlDO0FBQUEsSUFDbEYsVUFBRTtBQUNBLGFBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzlDO0FBQUEsRUFDRixDQUFDO0FBRUQsT0FBSyx3Q0FBd0MsTUFBTTtBQUNqRCxVQUFNLE1BQU0sWUFBWSxLQUFLLE9BQU8sR0FBRyxnQkFBZ0IsQ0FBQztBQUN4RCxRQUFJO0FBQ0YsWUFBTSxPQUFPLEtBQUssS0FBSyxhQUFhO0FBRXBDLG1CQUFhLE1BQU0sRUFBRSxRQUFRLFFBQVEsQ0FBQztBQUN0QyxtQkFBYSxNQUFNLEVBQUUsUUFBUSxTQUFTLENBQUM7QUFDdkMsWUFBTSxVQUFVLEtBQUssTUFBTSxhQUFhLE1BQU0sT0FBTyxDQUFDO0FBQ3RELGFBQU8sWUFBWSxRQUFRLFFBQVEsUUFBUTtBQUFBLElBQzdDLFVBQUU7QUFDQSxhQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUM5QztBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssbUNBQW1DLE1BQU07QUFDNUMsVUFBTSxNQUFNLFlBQVksS0FBSyxPQUFPLEdBQUcsZ0JBQWdCLENBQUM7QUFDeEQsUUFBSTtBQUNGLFlBQU0sT0FBTyxLQUFLLEtBQUssZ0JBQWdCO0FBQ3ZDLFlBQU0sT0FBTyxFQUFFLE9BQU8sQ0FBQyxHQUFHLEdBQUcsQ0FBQyxHQUFHLE1BQU0sT0FBTztBQUM5QyxtQkFBYSxNQUFNLElBQUk7QUFDdkIsWUFBTSxTQUFTO0FBQUEsUUFDYjtBQUFBLFFBQ0EsQ0FBQyxNQUF3QixPQUFPLE1BQU0sWUFBWSxNQUFNLFFBQVEsV0FBVztBQUFBLFFBQzNFLE9BQU8sRUFBRSxPQUFPLENBQUMsR0FBRyxNQUFNLEdBQUc7QUFBQSxNQUMvQjtBQUNBLGFBQU8sZ0JBQWdCLE9BQU8sT0FBTyxDQUFDLEdBQUcsR0FBRyxDQUFDLENBQUM7QUFDOUMsYUFBTyxZQUFZLE9BQU8sTUFBTSxNQUFNO0FBQUEsSUFDeEMsVUFBRTtBQUNBLGFBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzlDO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
