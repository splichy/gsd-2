import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteDbSnapshotSync } from "./db-snapshot.js";
describe("atomicWriteDbSnapshotSync", () => {
  let dir;
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("writes the full snapshot and leaves no temp file after success", () => {
    dir = mkdtempSync(join(tmpdir(), "gsd-db-snapshot-test-"));
    const dbPath = join(dir, "agent.db");
    const snapshot = new Uint8Array([83, 81, 76, 105, 116, 101]);
    atomicWriteDbSnapshotSync(dbPath, snapshot);
    assert.deepEqual(readFileSync(dbPath), Buffer.from(snapshot));
    assert.equal(existsSync(`${dbPath}.tmp`), false);
    assert.deepEqual(
      readdirSync(dir).filter((entry) => entry.includes("agent.db") && entry.includes(".tmp")),
      []
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2RiLXNuYXBzaG90LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2R0ZW1wU3luYywgcmVhZEZpbGVTeW5jLCByZWFkZGlyU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBhdG9taWNXcml0ZURiU25hcHNob3RTeW5jIH0gZnJvbSBcIi4vZGItc25hcHNob3QuanNcIjtcblxuZGVzY3JpYmUoXCJhdG9taWNXcml0ZURiU25hcHNob3RTeW5jXCIsICgpID0+IHtcblx0bGV0IGRpcjogc3RyaW5nO1xuXG5cdGFmdGVyRWFjaCgoKSA9PiB7XG5cdFx0aWYgKGRpcikge1xuXHRcdFx0cm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdH1cblx0fSk7XG5cblx0aXQoXCJ3cml0ZXMgdGhlIGZ1bGwgc25hcHNob3QgYW5kIGxlYXZlcyBubyB0ZW1wIGZpbGUgYWZ0ZXIgc3VjY2Vzc1wiLCAoKSA9PiB7XG5cdFx0ZGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZGItc25hcHNob3QtdGVzdC1cIikpO1xuXHRcdGNvbnN0IGRiUGF0aCA9IGpvaW4oZGlyLCBcImFnZW50LmRiXCIpO1xuXHRcdGNvbnN0IHNuYXBzaG90ID0gbmV3IFVpbnQ4QXJyYXkoWzB4NTMsIDB4NTEsIDB4NGMsIDB4NjksIDB4NzQsIDB4NjVdKTtcblxuXHRcdGF0b21pY1dyaXRlRGJTbmFwc2hvdFN5bmMoZGJQYXRoLCBzbmFwc2hvdCk7XG5cblx0XHRhc3NlcnQuZGVlcEVxdWFsKHJlYWRGaWxlU3luYyhkYlBhdGgpLCBCdWZmZXIuZnJvbShzbmFwc2hvdCkpO1xuXHRcdGFzc2VydC5lcXVhbChleGlzdHNTeW5jKGAke2RiUGF0aH0udG1wYCksIGZhbHNlKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKFxuXHRcdFx0cmVhZGRpclN5bmMoZGlyKS5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeS5pbmNsdWRlcyhcImFnZW50LmRiXCIpICYmIGVudHJ5LmluY2x1ZGVzKFwiLnRtcFwiKSksXG5cdFx0XHRbXSxcblx0XHQpO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxZQUFZO0FBQ25CLFNBQVMsVUFBVSxJQUFJLGlCQUFpQjtBQUN4QyxTQUFTLFlBQVksYUFBYSxjQUFjLGFBQWEsY0FBYztBQUMzRSxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMsaUNBQWlDO0FBRTFDLFNBQVMsNkJBQTZCLE1BQU07QUFDM0MsTUFBSTtBQUVKLFlBQVUsTUFBTTtBQUNmLFFBQUksS0FBSztBQUNSLGFBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzdDO0FBQUEsRUFDRCxDQUFDO0FBRUQsS0FBRyxrRUFBa0UsTUFBTTtBQUMxRSxVQUFNLFlBQVksS0FBSyxPQUFPLEdBQUcsdUJBQXVCLENBQUM7QUFDekQsVUFBTSxTQUFTLEtBQUssS0FBSyxVQUFVO0FBQ25DLFVBQU0sV0FBVyxJQUFJLFdBQVcsQ0FBQyxJQUFNLElBQU0sSUFBTSxLQUFNLEtBQU0sR0FBSSxDQUFDO0FBRXBFLDhCQUEwQixRQUFRLFFBQVE7QUFFMUMsV0FBTyxVQUFVLGFBQWEsTUFBTSxHQUFHLE9BQU8sS0FBSyxRQUFRLENBQUM7QUFDNUQsV0FBTyxNQUFNLFdBQVcsR0FBRyxNQUFNLE1BQU0sR0FBRyxLQUFLO0FBQy9DLFdBQU87QUFBQSxNQUNOLFlBQVksR0FBRyxFQUFFLE9BQU8sQ0FBQyxVQUFVLE1BQU0sU0FBUyxVQUFVLEtBQUssTUFBTSxTQUFTLE1BQU0sQ0FBQztBQUFBLE1BQ3ZGLENBQUM7QUFBQSxJQUNGO0FBQUEsRUFDRCxDQUFDO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
