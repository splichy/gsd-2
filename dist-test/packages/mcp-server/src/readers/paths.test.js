import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetReaderCaches,
  findMilestoneIds,
  findSliceIds,
  findTaskFiles
} from "./paths.js";
function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}
function writeFixture(base, relPath, content) {
  const full = join(base, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}
describe("reader path caches", () => {
  beforeEach(() => {
    _resetReaderCaches();
  });
  it("returns defensive copies of cached milestone and slice ids", () => {
    const tmp = makeTempDir("gsd-path-cache");
    try {
      const gsdRoot = join(tmp, ".gsd");
      mkdirSync(join(gsdRoot, "milestones", "M001", "slices", "S01"), { recursive: true });
      mkdirSync(join(gsdRoot, "milestones", "M002"), { recursive: true });
      const milestoneIds = findMilestoneIds(gsdRoot);
      milestoneIds.push("M999");
      assert.deepEqual(findMilestoneIds(gsdRoot), ["M001", "M002"]);
      const sliceIds = findSliceIds(gsdRoot, "M001");
      sliceIds.push("S99");
      assert.deepEqual(findSliceIds(gsdRoot, "M001"), ["S01"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("returns defensive copies of cached task file objects", () => {
    const tmp = makeTempDir("gsd-path-task-cache");
    try {
      const gsdRoot = join(tmp, ".gsd");
      writeFixture(gsdRoot, "milestones/M001/slices/S01/tasks/T01-PLAN.md", "# T01");
      const taskFiles = findTaskFiles(gsdRoot, "M001", "S01");
      taskFiles[0].hasSummary = true;
      taskFiles.push({ id: "T99", hasPlan: true, hasSummary: true });
      assert.deepEqual(findTaskFiles(gsdRoot, "M001", "S01"), [
        { id: "T01", hasPlan: true, hasSummary: false }
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvbWNwLXNlcnZlci9zcmMvcmVhZGVycy9wYXRocy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QgTUNQIFNlcnZlciBcdTIwMTQgLmdzZC8gcGF0aCBjYWNoZSB0ZXN0c1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGJlZm9yZUVhY2ggfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tICdub2RlOm9zJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuXG5pbXBvcnQge1xuICBfcmVzZXRSZWFkZXJDYWNoZXMsXG4gIGZpbmRNaWxlc3RvbmVJZHMsXG4gIGZpbmRTbGljZUlkcyxcbiAgZmluZFRhc2tGaWxlcyxcbn0gZnJvbSAnLi9wYXRocy5qcyc7XG5cbmZ1bmN0aW9uIG1ha2VUZW1wRGlyKHByZWZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIGAke3ByZWZpeH0tYCkpO1xufVxuXG5mdW5jdGlvbiB3cml0ZUZpeHR1cmUoYmFzZTogc3RyaW5nLCByZWxQYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBmdWxsID0gam9pbihiYXNlLCByZWxQYXRoKTtcbiAgbWtkaXJTeW5jKGpvaW4oZnVsbCwgJy4uJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGZ1bGwsIGNvbnRlbnQsICd1dGY4Jyk7XG59XG5cbmRlc2NyaWJlKCdyZWFkZXIgcGF0aCBjYWNoZXMnLCAoKSA9PiB7XG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIF9yZXNldFJlYWRlckNhY2hlcygpO1xuICB9KTtcblxuICBpdCgncmV0dXJucyBkZWZlbnNpdmUgY29waWVzIG9mIGNhY2hlZCBtaWxlc3RvbmUgYW5kIHNsaWNlIGlkcycsICgpID0+IHtcbiAgICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcignZ3NkLXBhdGgtY2FjaGUnKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZ3NkUm9vdCA9IGpvaW4odG1wLCAnLmdzZCcpO1xuICAgICAgbWtkaXJTeW5jKGpvaW4oZ3NkUm9vdCwgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgbWtkaXJTeW5jKGpvaW4oZ3NkUm9vdCwgJ21pbGVzdG9uZXMnLCAnTTAwMicpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgICAgY29uc3QgbWlsZXN0b25lSWRzID0gZmluZE1pbGVzdG9uZUlkcyhnc2RSb290KTtcbiAgICAgIG1pbGVzdG9uZUlkcy5wdXNoKCdNOTk5Jyk7XG4gICAgICBhc3NlcnQuZGVlcEVxdWFsKGZpbmRNaWxlc3RvbmVJZHMoZ3NkUm9vdCksIFsnTTAwMScsICdNMDAyJ10pO1xuXG4gICAgICBjb25zdCBzbGljZUlkcyA9IGZpbmRTbGljZUlkcyhnc2RSb290LCAnTTAwMScpO1xuICAgICAgc2xpY2VJZHMucHVzaCgnUzk5Jyk7XG4gICAgICBhc3NlcnQuZGVlcEVxdWFsKGZpbmRTbGljZUlkcyhnc2RSb290LCAnTTAwMScpLCBbJ1MwMSddKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoJ3JldHVybnMgZGVmZW5zaXZlIGNvcGllcyBvZiBjYWNoZWQgdGFzayBmaWxlIG9iamVjdHMnLCAoKSA9PiB7XG4gICAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoJ2dzZC1wYXRoLXRhc2stY2FjaGUnKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZ3NkUm9vdCA9IGpvaW4odG1wLCAnLmdzZCcpO1xuICAgICAgd3JpdGVGaXh0dXJlKGdzZFJvb3QsICdtaWxlc3RvbmVzL00wMDEvc2xpY2VzL1MwMS90YXNrcy9UMDEtUExBTi5tZCcsICcjIFQwMScpO1xuXG4gICAgICBjb25zdCB0YXNrRmlsZXMgPSBmaW5kVGFza0ZpbGVzKGdzZFJvb3QsICdNMDAxJywgJ1MwMScpO1xuICAgICAgdGFza0ZpbGVzWzBdLmhhc1N1bW1hcnkgPSB0cnVlO1xuICAgICAgdGFza0ZpbGVzLnB1c2goeyBpZDogJ1Q5OScsIGhhc1BsYW46IHRydWUsIGhhc1N1bW1hcnk6IHRydWUgfSk7XG5cbiAgICAgIGFzc2VydC5kZWVwRXF1YWwoZmluZFRhc2tGaWxlcyhnc2RSb290LCAnTTAwMScsICdTMDEnKSwgW1xuICAgICAgICB7IGlkOiAnVDAxJywgaGFzUGxhbjogdHJ1ZSwgaGFzU3VtbWFyeTogZmFsc2UgfSxcbiAgICAgIF0pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsU0FBUyxVQUFVLElBQUksa0JBQWtCO0FBQ3pDLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBRXJCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFFUCxTQUFTLFlBQVksUUFBd0I7QUFDM0MsU0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLEdBQUcsTUFBTSxHQUFHLENBQUM7QUFDakQ7QUFFQSxTQUFTLGFBQWEsTUFBYyxTQUFpQixTQUF1QjtBQUMxRSxRQUFNLE9BQU8sS0FBSyxNQUFNLE9BQU87QUFDL0IsWUFBVSxLQUFLLE1BQU0sSUFBSSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDL0MsZ0JBQWMsTUFBTSxTQUFTLE1BQU07QUFDckM7QUFFQSxTQUFTLHNCQUFzQixNQUFNO0FBQ25DLGFBQVcsTUFBTTtBQUNmLHVCQUFtQjtBQUFBLEVBQ3JCLENBQUM7QUFFRCxLQUFHLDhEQUE4RCxNQUFNO0FBQ3JFLFVBQU0sTUFBTSxZQUFZLGdCQUFnQjtBQUN4QyxRQUFJO0FBQ0YsWUFBTSxVQUFVLEtBQUssS0FBSyxNQUFNO0FBQ2hDLGdCQUFVLEtBQUssU0FBUyxjQUFjLFFBQVEsVUFBVSxLQUFLLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNuRixnQkFBVSxLQUFLLFNBQVMsY0FBYyxNQUFNLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUVsRSxZQUFNLGVBQWUsaUJBQWlCLE9BQU87QUFDN0MsbUJBQWEsS0FBSyxNQUFNO0FBQ3hCLGFBQU8sVUFBVSxpQkFBaUIsT0FBTyxHQUFHLENBQUMsUUFBUSxNQUFNLENBQUM7QUFFNUQsWUFBTSxXQUFXLGFBQWEsU0FBUyxNQUFNO0FBQzdDLGVBQVMsS0FBSyxLQUFLO0FBQ25CLGFBQU8sVUFBVSxhQUFhLFNBQVMsTUFBTSxHQUFHLENBQUMsS0FBSyxDQUFDO0FBQUEsSUFDekQsVUFBRTtBQUNBLGFBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzlDO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyx3REFBd0QsTUFBTTtBQUMvRCxVQUFNLE1BQU0sWUFBWSxxQkFBcUI7QUFDN0MsUUFBSTtBQUNGLFlBQU0sVUFBVSxLQUFLLEtBQUssTUFBTTtBQUNoQyxtQkFBYSxTQUFTLGdEQUFnRCxPQUFPO0FBRTdFLFlBQU0sWUFBWSxjQUFjLFNBQVMsUUFBUSxLQUFLO0FBQ3RELGdCQUFVLENBQUMsRUFBRSxhQUFhO0FBQzFCLGdCQUFVLEtBQUssRUFBRSxJQUFJLE9BQU8sU0FBUyxNQUFNLFlBQVksS0FBSyxDQUFDO0FBRTdELGFBQU8sVUFBVSxjQUFjLFNBQVMsUUFBUSxLQUFLLEdBQUc7QUFBQSxRQUN0RCxFQUFFLElBQUksT0FBTyxTQUFTLE1BQU0sWUFBWSxNQUFNO0FBQUEsTUFDaEQsQ0FBQztBQUFBLElBQ0gsVUFBRTtBQUNBLGFBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzlDO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
