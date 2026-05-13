import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireSessionLock, releaseSessionLock } from "../session-lock.js";
let tempBase = null;
afterEach(() => {
  if (tempBase) {
    releaseSessionLock(tempBase);
    rmSync(tempBase, { recursive: true, force: true });
  }
  tempBase = null;
});
describe("stale lockfile auto-recovery (#3668)", () => {
  test("acquireSessionLock removes an orphan proper-lockfile directory before acquiring", () => {
    tempBase = mkdtempSync(join(tmpdir(), "gsd-stale-lock-"));
    const gsdDir = join(tempBase, ".gsd");
    mkdirSync(join(gsdDir, "auto.lock.lock"), { recursive: true });
    writeFileSync(
      join(gsdDir, "auto.lock"),
      JSON.stringify({
        pid: 999999999,
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        unitStartedAt: (/* @__PURE__ */ new Date()).toISOString()
      }),
      "utf-8"
    );
    const result = acquireSessionLock(tempBase);
    assert.equal(result.acquired, true);
    assert.equal(existsSync(join(gsdDir, "auto.lock.lock")), true, "new active lock directory is present");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zdGFsZS1sb2NrZmlsZS1yZWNvdmVyeS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIHN0YWxlLWxvY2tmaWxlLXJlY292ZXJ5LnRlc3QudHMgXHUyMDE0ICMzNjY4LlxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0LCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgbWtkdGVtcFN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgYWNxdWlyZVNlc3Npb25Mb2NrLCByZWxlYXNlU2Vzc2lvbkxvY2sgfSBmcm9tIFwiLi4vc2Vzc2lvbi1sb2NrLnRzXCI7XG5cbmxldCB0ZW1wQmFzZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbmFmdGVyRWFjaCgoKSA9PiB7XG4gIGlmICh0ZW1wQmFzZSkge1xuICAgIHJlbGVhc2VTZXNzaW9uTG9jayh0ZW1wQmFzZSk7XG4gICAgcm1TeW5jKHRlbXBCYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbiAgdGVtcEJhc2UgPSBudWxsO1xufSk7XG5cbmRlc2NyaWJlKFwic3RhbGUgbG9ja2ZpbGUgYXV0by1yZWNvdmVyeSAoIzM2NjgpXCIsICgpID0+IHtcbiAgdGVzdChcImFjcXVpcmVTZXNzaW9uTG9jayByZW1vdmVzIGFuIG9ycGhhbiBwcm9wZXItbG9ja2ZpbGUgZGlyZWN0b3J5IGJlZm9yZSBhY3F1aXJpbmdcIiwgKCkgPT4ge1xuICAgIHRlbXBCYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtc3RhbGUtbG9jay1cIikpO1xuICAgIGNvbnN0IGdzZERpciA9IGpvaW4odGVtcEJhc2UsIFwiLmdzZFwiKTtcbiAgICBta2RpclN5bmMoam9pbihnc2REaXIsIFwiYXV0by5sb2NrLmxvY2tcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICBqb2luKGdzZERpciwgXCJhdXRvLmxvY2tcIiksXG4gICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHBpZDogOTk5Xzk5OV85OTksXG4gICAgICAgIHN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgICAgICB1bml0U3RhcnRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICB9KSxcbiAgICAgIFwidXRmLThcIixcbiAgICApO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYWNxdWlyZVNlc3Npb25Mb2NrKHRlbXBCYXNlKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWNxdWlyZWQsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKGpvaW4oZ3NkRGlyLCBcImF1dG8ubG9jay5sb2NrXCIpKSwgdHJ1ZSwgXCJuZXcgYWN0aXZlIGxvY2sgZGlyZWN0b3J5IGlzIHByZXNlbnRcIik7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFJQSxTQUFTLFVBQVUsTUFBTSxpQkFBaUI7QUFDMUMsT0FBTyxZQUFZO0FBQ25CLFNBQVMsWUFBWSxXQUFXLGFBQWEsUUFBUSxxQkFBcUI7QUFDMUUsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLG9CQUFvQiwwQkFBMEI7QUFFdkQsSUFBSSxXQUEwQjtBQUU5QixVQUFVLE1BQU07QUFDZCxNQUFJLFVBQVU7QUFDWix1QkFBbUIsUUFBUTtBQUMzQixXQUFPLFVBQVUsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUNuRDtBQUNBLGFBQVc7QUFDYixDQUFDO0FBRUQsU0FBUyx3Q0FBd0MsTUFBTTtBQUNyRCxPQUFLLG1GQUFtRixNQUFNO0FBQzVGLGVBQVcsWUFBWSxLQUFLLE9BQU8sR0FBRyxpQkFBaUIsQ0FBQztBQUN4RCxVQUFNLFNBQVMsS0FBSyxVQUFVLE1BQU07QUFDcEMsY0FBVSxLQUFLLFFBQVEsZ0JBQWdCLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUM3RDtBQUFBLE1BQ0UsS0FBSyxRQUFRLFdBQVc7QUFBQSxNQUN4QixLQUFLLFVBQVU7QUFBQSxRQUNiLEtBQUs7QUFBQSxRQUNMLFlBQVcsb0JBQUksS0FBSyxHQUFFLFlBQVk7QUFBQSxRQUNsQyxVQUFVO0FBQUEsUUFDVixRQUFRO0FBQUEsUUFDUixnQkFBZSxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLE1BQ3hDLENBQUM7QUFBQSxNQUNEO0FBQUEsSUFDRjtBQUVBLFVBQU0sU0FBUyxtQkFBbUIsUUFBUTtBQUUxQyxXQUFPLE1BQU0sT0FBTyxVQUFVLElBQUk7QUFDbEMsV0FBTyxNQUFNLFdBQVcsS0FBSyxRQUFRLGdCQUFnQixDQUFDLEdBQUcsTUFBTSxzQ0FBc0M7QUFBQSxFQUN2RyxDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
