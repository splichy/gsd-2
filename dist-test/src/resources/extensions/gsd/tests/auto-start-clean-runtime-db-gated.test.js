import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { cleanStaleRuntimeUnits } from "../auto-worktree.js";
function makeBase() {
  return join(tmpdir(), `gsd-clean-runtime-${randomUUID()}`);
}
describe("auto-start cleanStaleRuntimeUnits DB gating (#4663)", () => {
  test("predicate controls whether milestone runtime units are removed", () => {
    const base = makeBase();
    const unitsDir = join(base, ".gsd", "runtime", "units");
    try {
      mkdirSync(unitsDir, { recursive: true });
      const unitFile = join(unitsDir, "execute-task-M001-S01-T01.json");
      writeFileSync(unitFile, "{}\n", "utf-8");
      assert.equal(cleanStaleRuntimeUnits(join(base, ".gsd"), () => false), 0);
      assert.equal(existsSync(unitFile), true);
      assert.equal(cleanStaleRuntimeUnits(join(base, ".gsd"), (mid) => mid === "M001"), 1);
      assert.equal(existsSync(unitFile), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
  test("cleanStaleRuntimeUnits removes legacy pseudo deep-setup runtime files", () => {
    const base = makeBase();
    const gsdRoot = join(base, ".gsd");
    const unitsDir = join(gsdRoot, "runtime", "units");
    try {
      mkdirSync(unitsDir, { recursive: true });
      const staleFiles = [
        "discuss-milestone-PROJECT.json",
        "workflow-preferences-WORKFLOW-PREFS.json",
        "discuss-project-PROJECT.json",
        "discuss-requirements-REQUIREMENTS.json",
        "research-decision-RESEARCH-DECISION.json",
        "research-project-RESEARCH-PROJECT.json"
      ];
      const valid = join(unitsDir, "discuss-milestone-M001.json");
      for (const file of staleFiles) writeFileSync(join(unitsDir, file), "{}\n", "utf-8");
      writeFileSync(valid, "{}\n", "utf-8");
      const cleaned = cleanStaleRuntimeUnits(gsdRoot, () => false);
      assert.equal(cleaned, staleFiles.length);
      for (const file of staleFiles) assert.equal(existsSync(join(unitsDir, file)), false);
      assert.equal(existsSync(valid), true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLXN0YXJ0LWNsZWFuLXJ1bnRpbWUtZGItZ2F0ZWQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgYXV0by1zdGFydCByZWdyZXNzaW9uIHRlc3Q6IGNsZWFuU3RhbGVSdW50aW1lVW5pdHMgaXMgREItZ2F0ZWQgKCM0NjYzKVxuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBjbGVhblN0YWxlUnVudGltZVVuaXRzIH0gZnJvbSBcIi4uL2F1dG8td29ya3RyZWUudHNcIjtcblxuZnVuY3Rpb24gbWFrZUJhc2UoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4odG1wZGlyKCksIGBnc2QtY2xlYW4tcnVudGltZS0ke3JhbmRvbVVVSUQoKX1gKTtcbn1cblxuZGVzY3JpYmUoXCJhdXRvLXN0YXJ0IGNsZWFuU3RhbGVSdW50aW1lVW5pdHMgREIgZ2F0aW5nICgjNDY2MylcIiwgKCkgPT4ge1xuICB0ZXN0KFwicHJlZGljYXRlIGNvbnRyb2xzIHdoZXRoZXIgbWlsZXN0b25lIHJ1bnRpbWUgdW5pdHMgYXJlIHJlbW92ZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IHVuaXRzRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwidW5pdHNcIik7XG4gICAgdHJ5IHtcbiAgICAgIG1rZGlyU3luYyh1bml0c0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBjb25zdCB1bml0RmlsZSA9IGpvaW4odW5pdHNEaXIsIFwiZXhlY3V0ZS10YXNrLU0wMDEtUzAxLVQwMS5qc29uXCIpO1xuICAgICAgd3JpdGVGaWxlU3luYyh1bml0RmlsZSwgXCJ7fVxcblwiLCBcInV0Zi04XCIpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoY2xlYW5TdGFsZVJ1bnRpbWVVbml0cyhqb2luKGJhc2UsIFwiLmdzZFwiKSwgKCkgPT4gZmFsc2UpLCAwKTtcbiAgICAgIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKHVuaXRGaWxlKSwgdHJ1ZSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChjbGVhblN0YWxlUnVudGltZVVuaXRzKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCAobWlkKSA9PiBtaWQgPT09IFwiTTAwMVwiKSwgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwoZXhpc3RzU3luYyh1bml0RmlsZSksIGZhbHNlKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIHRlc3QoXCJjbGVhblN0YWxlUnVudGltZVVuaXRzIHJlbW92ZXMgbGVnYWN5IHBzZXVkbyBkZWVwLXNldHVwIHJ1bnRpbWUgZmlsZXNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IGdzZFJvb3QgPSBqb2luKGJhc2UsIFwiLmdzZFwiKTtcbiAgICBjb25zdCB1bml0c0RpciA9IGpvaW4oZ3NkUm9vdCwgXCJydW50aW1lXCIsIFwidW5pdHNcIik7XG4gICAgdHJ5IHtcbiAgICAgIG1rZGlyU3luYyh1bml0c0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBjb25zdCBzdGFsZUZpbGVzID0gW1xuICAgICAgICBcImRpc2N1c3MtbWlsZXN0b25lLVBST0pFQ1QuanNvblwiLFxuICAgICAgICBcIndvcmtmbG93LXByZWZlcmVuY2VzLVdPUktGTE9XLVBSRUZTLmpzb25cIixcbiAgICAgICAgXCJkaXNjdXNzLXByb2plY3QtUFJPSkVDVC5qc29uXCIsXG4gICAgICAgIFwiZGlzY3Vzcy1yZXF1aXJlbWVudHMtUkVRVUlSRU1FTlRTLmpzb25cIixcbiAgICAgICAgXCJyZXNlYXJjaC1kZWNpc2lvbi1SRVNFQVJDSC1ERUNJU0lPTi5qc29uXCIsXG4gICAgICAgIFwicmVzZWFyY2gtcHJvamVjdC1SRVNFQVJDSC1QUk9KRUNULmpzb25cIixcbiAgICAgIF07XG4gICAgICBjb25zdCB2YWxpZCA9IGpvaW4odW5pdHNEaXIsIFwiZGlzY3Vzcy1taWxlc3RvbmUtTTAwMS5qc29uXCIpO1xuICAgICAgZm9yIChjb25zdCBmaWxlIG9mIHN0YWxlRmlsZXMpIHdyaXRlRmlsZVN5bmMoam9pbih1bml0c0RpciwgZmlsZSksIFwie31cXG5cIiwgXCJ1dGYtOFwiKTtcbiAgICAgIHdyaXRlRmlsZVN5bmModmFsaWQsIFwie31cXG5cIiwgXCJ1dGYtOFwiKTtcblxuICAgICAgY29uc3QgY2xlYW5lZCA9IGNsZWFuU3RhbGVSdW50aW1lVW5pdHMoZ3NkUm9vdCwgKCkgPT4gZmFsc2UpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoY2xlYW5lZCwgc3RhbGVGaWxlcy5sZW5ndGgpO1xuICAgICAgZm9yIChjb25zdCBmaWxlIG9mIHN0YWxlRmlsZXMpIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKGpvaW4odW5pdHNEaXIsIGZpbGUpKSwgZmFsc2UpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGV4aXN0c1N5bmModmFsaWQpLCB0cnVlKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxZQUFZLFdBQVcsUUFBUSxxQkFBcUI7QUFDN0QsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLGtCQUFrQjtBQUMzQixTQUFTLDhCQUE4QjtBQUV2QyxTQUFTLFdBQW1CO0FBQzFCLFNBQU8sS0FBSyxPQUFPLEdBQUcscUJBQXFCLFdBQVcsQ0FBQyxFQUFFO0FBQzNEO0FBRUEsU0FBUyx1REFBdUQsTUFBTTtBQUNwRSxPQUFLLGtFQUFrRSxNQUFNO0FBQzNFLFVBQU0sT0FBTyxTQUFTO0FBQ3RCLFVBQU0sV0FBVyxLQUFLLE1BQU0sUUFBUSxXQUFXLE9BQU87QUFDdEQsUUFBSTtBQUNGLGdCQUFVLFVBQVUsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN2QyxZQUFNLFdBQVcsS0FBSyxVQUFVLGdDQUFnQztBQUNoRSxvQkFBYyxVQUFVLFFBQVEsT0FBTztBQUV2QyxhQUFPLE1BQU0sdUJBQXVCLEtBQUssTUFBTSxNQUFNLEdBQUcsTUFBTSxLQUFLLEdBQUcsQ0FBQztBQUN2RSxhQUFPLE1BQU0sV0FBVyxRQUFRLEdBQUcsSUFBSTtBQUV2QyxhQUFPLE1BQU0sdUJBQXVCLEtBQUssTUFBTSxNQUFNLEdBQUcsQ0FBQyxRQUFRLFFBQVEsTUFBTSxHQUFHLENBQUM7QUFDbkYsYUFBTyxNQUFNLFdBQVcsUUFBUSxHQUFHLEtBQUs7QUFBQSxJQUMxQyxVQUFFO0FBQ0EsYUFBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDL0M7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHlFQUF5RSxNQUFNO0FBQ2xGLFVBQU0sT0FBTyxTQUFTO0FBQ3RCLFVBQU0sVUFBVSxLQUFLLE1BQU0sTUFBTTtBQUNqQyxVQUFNLFdBQVcsS0FBSyxTQUFTLFdBQVcsT0FBTztBQUNqRCxRQUFJO0FBQ0YsZ0JBQVUsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3ZDLFlBQU0sYUFBYTtBQUFBLFFBQ2pCO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGO0FBQ0EsWUFBTSxRQUFRLEtBQUssVUFBVSw2QkFBNkI7QUFDMUQsaUJBQVcsUUFBUSxXQUFZLGVBQWMsS0FBSyxVQUFVLElBQUksR0FBRyxRQUFRLE9BQU87QUFDbEYsb0JBQWMsT0FBTyxRQUFRLE9BQU87QUFFcEMsWUFBTSxVQUFVLHVCQUF1QixTQUFTLE1BQU0sS0FBSztBQUUzRCxhQUFPLE1BQU0sU0FBUyxXQUFXLE1BQU07QUFDdkMsaUJBQVcsUUFBUSxXQUFZLFFBQU8sTUFBTSxXQUFXLEtBQUssVUFBVSxJQUFJLENBQUMsR0FBRyxLQUFLO0FBQ25GLGFBQU8sTUFBTSxXQUFXLEtBQUssR0FBRyxJQUFJO0FBQUEsSUFDdEMsVUFBRTtBQUNBLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
