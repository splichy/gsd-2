import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isReusableGhostMilestone } from "../state.js";
import { nextMilestoneIdReserved } from "../milestone-id-reservation.js";
import { clearReservedMilestoneIds, findMilestoneIds } from "../milestone-ids.js";
import { invalidateAllCaches } from "../cache.js";
import { closeDatabase, openDatabase } from "../gsd-db.js";
function makeBase(prefix = "gsd-deferred-dir-") {
  const base = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
describe("deferred milestone dir creation (#4996)", () => {
  let base;
  beforeEach(() => {
    clearReservedMilestoneIds();
  });
  afterEach(() => {
    try {
      closeDatabase();
    } catch {
    }
    try {
      invalidateAllCaches();
    } catch {
    }
    try {
      clearReservedMilestoneIds();
    } catch {
    }
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  it("(a) fresh project: milestones dir has no M001 entry before any discuss flow", () => {
    base = makeBase();
    const nextId = nextMilestoneIdReserved(findMilestoneIds(base), false, base);
    assert.equal(nextId, "M001");
    const ids = findMilestoneIds(base);
    assert.equal(ids.length, 0);
    assert.ok(!existsSync(join(base, ".gsd", "milestones", "M001")));
  });
  it("(b) abandoned discuss flow leaves no orphan", () => {
    base = makeBase();
    const nextId = nextMilestoneIdReserved(findMilestoneIds(base), false, base);
    assert.equal(nextId, "M001");
    const m001Dir = join(base, ".gsd", "milestones", "M001");
    assert.ok(!existsSync(m001Dir));
    assert.equal(isReusableGhostMilestone(base, "M001"), false);
    assert.ok(!findMilestoneIds(base).includes("M001"));
  });
  it("(c) a stub dir left from a previous bug is reusable", () => {
    base = makeBase();
    openDatabase(join(base, ".gsd", "gsd.db"));
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices"), { recursive: true });
    assert.equal(isReusableGhostMilestone(base, "M001"), true);
    assert.equal(nextMilestoneIdReserved(findMilestoneIds(base), false, base), "M001");
    assert.ok(!existsSync(join(base, ".gsd", "milestones", "M002")));
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZWZlcnJlZC1taWxlc3RvbmUtZGlyLTQ5OTYudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIEV4dGVuc2lvbiBcdTIwMTQgUmVncmVzc2lvbiB0ZXN0IGZvciAjNDk5NjogZGVmZXJyZWQgbWlsZXN0b25lIGRpciBjcmVhdGlvblxuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgZXhpc3RzU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBpc1JldXNhYmxlR2hvc3RNaWxlc3RvbmUgfSBmcm9tIFwiLi4vc3RhdGUudHNcIjtcbmltcG9ydCB7IG5leHRNaWxlc3RvbmVJZFJlc2VydmVkIH0gZnJvbSBcIi4uL21pbGVzdG9uZS1pZC1yZXNlcnZhdGlvbi50c1wiO1xuaW1wb3J0IHsgY2xlYXJSZXNlcnZlZE1pbGVzdG9uZUlkcywgZmluZE1pbGVzdG9uZUlkcyB9IGZyb20gXCIuLi9taWxlc3RvbmUtaWRzLnRzXCI7XG5pbXBvcnQgeyBpbnZhbGlkYXRlQWxsQ2FjaGVzIH0gZnJvbSBcIi4uL2NhY2hlLnRzXCI7XG5pbXBvcnQgeyBjbG9zZURhdGFiYXNlLCBvcGVuRGF0YWJhc2UgfSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VCYXNlKHByZWZpeCA9IFwiZ3NkLWRlZmVycmVkLWRpci1cIik6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBwcmVmaXgpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5kZXNjcmliZShcImRlZmVycmVkIG1pbGVzdG9uZSBkaXIgY3JlYXRpb24gKCM0OTk2KVwiLCAoKSA9PiB7XG4gIGxldCBiYXNlOiBzdHJpbmc7XG5cbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgY2xlYXJSZXNlcnZlZE1pbGVzdG9uZUlkcygpO1xuICB9KTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gICAgdHJ5IHsgaW52YWxpZGF0ZUFsbENhY2hlcygpOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgICB0cnkgeyBjbGVhclJlc2VydmVkTWlsZXN0b25lSWRzKCk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICAgIHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICB9KTtcblxuICBpdChcIihhKSBmcmVzaCBwcm9qZWN0OiBtaWxlc3RvbmVzIGRpciBoYXMgbm8gTTAwMSBlbnRyeSBiZWZvcmUgYW55IGRpc2N1c3MgZmxvd1wiLCAoKSA9PiB7XG4gICAgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgY29uc3QgbmV4dElkID0gbmV4dE1pbGVzdG9uZUlkUmVzZXJ2ZWQoZmluZE1pbGVzdG9uZUlkcyhiYXNlKSwgZmFsc2UsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChuZXh0SWQsIFwiTTAwMVwiKTtcblxuICAgIGNvbnN0IGlkcyA9IGZpbmRNaWxlc3RvbmVJZHMoYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGlkcy5sZW5ndGgsIDApO1xuICAgIGFzc2VydC5vayghZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpKSk7XG4gIH0pO1xuXG4gIGl0KFwiKGIpIGFiYW5kb25lZCBkaXNjdXNzIGZsb3cgbGVhdmVzIG5vIG9ycGhhblwiLCAoKSA9PiB7XG4gICAgYmFzZSA9IG1ha2VCYXNlKCk7XG4gICAgY29uc3QgbmV4dElkID0gbmV4dE1pbGVzdG9uZUlkUmVzZXJ2ZWQoZmluZE1pbGVzdG9uZUlkcyhiYXNlKSwgZmFsc2UsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChuZXh0SWQsIFwiTTAwMVwiKTtcblxuICAgIGNvbnN0IG0wMDFEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5vayghZXhpc3RzU3luYyhtMDAxRGlyKSk7XG4gICAgYXNzZXJ0LmVxdWFsKGlzUmV1c2FibGVHaG9zdE1pbGVzdG9uZShiYXNlLCBcIk0wMDFcIiksIGZhbHNlKTtcbiAgICBhc3NlcnQub2soIWZpbmRNaWxlc3RvbmVJZHMoYmFzZSkuaW5jbHVkZXMoXCJNMDAxXCIpKTtcbiAgfSk7XG5cbiAgaXQoXCIoYykgYSBzdHViIGRpciBsZWZ0IGZyb20gYSBwcmV2aW91cyBidWcgaXMgcmV1c2FibGVcIiwgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gICAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKGlzUmV1c2FibGVHaG9zdE1pbGVzdG9uZShiYXNlLCBcIk0wMDFcIiksIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChuZXh0TWlsZXN0b25lSWRSZXNlcnZlZChmaW5kTWlsZXN0b25lSWRzKGJhc2UpLCBmYWxzZSwgYmFzZSksIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQub2soIWV4aXN0c1N5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMlwiKSkpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsU0FBUyxVQUFVLElBQUksWUFBWSxpQkFBaUI7QUFDcEQsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFlBQVksY0FBYztBQUMzRCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBRXZCLFNBQVMsZ0NBQWdDO0FBQ3pDLFNBQVMsK0JBQStCO0FBQ3hDLFNBQVMsMkJBQTJCLHdCQUF3QjtBQUM1RCxTQUFTLDJCQUEyQjtBQUNwQyxTQUFTLGVBQWUsb0JBQW9CO0FBRTVDLFNBQVMsU0FBUyxTQUFTLHFCQUE2QjtBQUN0RCxRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyxNQUFNLENBQUM7QUFDL0MsWUFBVSxLQUFLLE1BQU0sUUFBUSxZQUFZLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUMvRCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLDJDQUEyQyxNQUFNO0FBQ3hELE1BQUk7QUFFSixhQUFXLE1BQU07QUFDZiw4QkFBMEI7QUFBQSxFQUM1QixDQUFDO0FBRUQsWUFBVSxNQUFNO0FBQ2QsUUFBSTtBQUFFLG9CQUFjO0FBQUEsSUFBRyxRQUFRO0FBQUEsSUFBZTtBQUM5QyxRQUFJO0FBQUUsMEJBQW9CO0FBQUEsSUFBRyxRQUFRO0FBQUEsSUFBZTtBQUNwRCxRQUFJO0FBQUUsZ0NBQTBCO0FBQUEsSUFBRyxRQUFRO0FBQUEsSUFBZTtBQUMxRCxRQUFJO0FBQUUsYUFBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFBRyxRQUFRO0FBQUEsSUFBZTtBQUFBLEVBQy9FLENBQUM7QUFFRCxLQUFHLCtFQUErRSxNQUFNO0FBQ3RGLFdBQU8sU0FBUztBQUNoQixVQUFNLFNBQVMsd0JBQXdCLGlCQUFpQixJQUFJLEdBQUcsT0FBTyxJQUFJO0FBQzFFLFdBQU8sTUFBTSxRQUFRLE1BQU07QUFFM0IsVUFBTSxNQUFNLGlCQUFpQixJQUFJO0FBQ2pDLFdBQU8sTUFBTSxJQUFJLFFBQVEsQ0FBQztBQUMxQixXQUFPLEdBQUcsQ0FBQyxXQUFXLEtBQUssTUFBTSxRQUFRLGNBQWMsTUFBTSxDQUFDLENBQUM7QUFBQSxFQUNqRSxDQUFDO0FBRUQsS0FBRywrQ0FBK0MsTUFBTTtBQUN0RCxXQUFPLFNBQVM7QUFDaEIsVUFBTSxTQUFTLHdCQUF3QixpQkFBaUIsSUFBSSxHQUFHLE9BQU8sSUFBSTtBQUMxRSxXQUFPLE1BQU0sUUFBUSxNQUFNO0FBRTNCLFVBQU0sVUFBVSxLQUFLLE1BQU0sUUFBUSxjQUFjLE1BQU07QUFDdkQsV0FBTyxHQUFHLENBQUMsV0FBVyxPQUFPLENBQUM7QUFDOUIsV0FBTyxNQUFNLHlCQUF5QixNQUFNLE1BQU0sR0FBRyxLQUFLO0FBQzFELFdBQU8sR0FBRyxDQUFDLGlCQUFpQixJQUFJLEVBQUUsU0FBUyxNQUFNLENBQUM7QUFBQSxFQUNwRCxDQUFDO0FBRUQsS0FBRyx1REFBdUQsTUFBTTtBQUM5RCxXQUFPLFNBQVM7QUFDaEIsaUJBQWEsS0FBSyxNQUFNLFFBQVEsUUFBUSxDQUFDO0FBQ3pDLGNBQVUsS0FBSyxNQUFNLFFBQVEsY0FBYyxRQUFRLFFBQVEsR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBRWpGLFdBQU8sTUFBTSx5QkFBeUIsTUFBTSxNQUFNLEdBQUcsSUFBSTtBQUN6RCxXQUFPLE1BQU0sd0JBQXdCLGlCQUFpQixJQUFJLEdBQUcsT0FBTyxJQUFJLEdBQUcsTUFBTTtBQUNqRixXQUFPLEdBQUcsQ0FBQyxXQUFXLEtBQUssTUFBTSxRQUFRLGNBQWMsTUFBTSxDQUFDLENBQUM7QUFBQSxFQUNqRSxDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
