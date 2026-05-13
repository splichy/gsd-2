import assert from "node:assert/strict";
import test from "node:test";
import {
  measureMemoryPressure,
  shouldCheckMemoryPressure
} from "../auto/workflow-memory-pressure.js";
const mb = 1024 * 1024;
test("measureMemoryPressure reports heap usage against the injected heap limit", () => {
  const snapshot = measureMemoryPressure({
    threshold: 0.85,
    deps: {
      memoryUsage: () => ({ heapUsed: 512 * mb }),
      heapLimitBytes: () => 1024 * mb
    }
  });
  assert.deepEqual(snapshot, {
    pressured: false,
    heapMB: 512,
    limitMB: 1024,
    pct: 0.5
  });
});
test("measureMemoryPressure marks pressure only above the threshold", () => {
  const snapshot = measureMemoryPressure({
    threshold: 0.85,
    deps: {
      memoryUsage: () => ({ heapUsed: 900 * mb }),
      heapLimitBytes: () => 1e3 * mb
    }
  });
  assert.equal(snapshot.pressured, true);
  assert.equal(snapshot.pct, 0.9);
});
test("measureMemoryPressure treats exact threshold as not pressured", () => {
  const snapshot = measureMemoryPressure({
    threshold: 0.85,
    deps: {
      memoryUsage: () => ({ heapUsed: 850 * mb }),
      heapLimitBytes: () => 1e3 * mb
    }
  });
  assert.equal(snapshot.pressured, false);
  assert.equal(snapshot.pct, 0.85);
});
test("measureMemoryPressure falls back when heap limit cannot be read", () => {
  const snapshot = measureMemoryPressure({
    fallbackLimitMB: 4096,
    deps: {
      memoryUsage: () => ({ heapUsed: 1024 * mb }),
      heapLimitBytes: () => {
        throw new Error("v8 unavailable");
      }
    }
  });
  assert.deepEqual(snapshot, {
    pressured: false,
    heapMB: 1024,
    limitMB: 4096,
    pct: 0.25
  });
});
test("shouldCheckMemoryPressure covers the first auto-mode iteration", () => {
  assert.equal(shouldCheckMemoryPressure(1, 5), true);
  assert.equal(shouldCheckMemoryPressure(2, 5), false);
  assert.equal(shouldCheckMemoryPressure(5, 5), true);
});
test("shouldCheckMemoryPressure rejects invalid intervals", () => {
  assert.throws(
    () => shouldCheckMemoryPressure(1, 0),
    /positive integer/
  );
  assert.throws(
    () => shouldCheckMemoryPressure(1, 1.5),
    /positive integer/
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrZmxvdy1tZW1vcnktcHJlc3N1cmUudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFVuaXQgdGVzdHMgZm9yIGF1dG8tbW9kZSBtZW1vcnktcHJlc3N1cmUgbWVhc3VyZW1lbnQgYWRhcHRlci5cblxuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5cbmltcG9ydCB7XG4gIG1lYXN1cmVNZW1vcnlQcmVzc3VyZSxcbiAgc2hvdWxkQ2hlY2tNZW1vcnlQcmVzc3VyZSxcbn0gZnJvbSBcIi4uL2F1dG8vd29ya2Zsb3ctbWVtb3J5LXByZXNzdXJlLnRzXCI7XG5cbmNvbnN0IG1iID0gMTAyNCAqIDEwMjQ7XG5cbnRlc3QoXCJtZWFzdXJlTWVtb3J5UHJlc3N1cmUgcmVwb3J0cyBoZWFwIHVzYWdlIGFnYWluc3QgdGhlIGluamVjdGVkIGhlYXAgbGltaXRcIiwgKCkgPT4ge1xuICBjb25zdCBzbmFwc2hvdCA9IG1lYXN1cmVNZW1vcnlQcmVzc3VyZSh7XG4gICAgdGhyZXNob2xkOiAwLjg1LFxuICAgIGRlcHM6IHtcbiAgICAgIG1lbW9yeVVzYWdlOiAoKSA9PiAoeyBoZWFwVXNlZDogNTEyICogbWIgfSksXG4gICAgICBoZWFwTGltaXRCeXRlczogKCkgPT4gMTAyNCAqIG1iLFxuICAgIH0sXG4gIH0pO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwoc25hcHNob3QsIHtcbiAgICBwcmVzc3VyZWQ6IGZhbHNlLFxuICAgIGhlYXBNQjogNTEyLFxuICAgIGxpbWl0TUI6IDEwMjQsXG4gICAgcGN0OiAwLjUsXG4gIH0pO1xufSk7XG5cbnRlc3QoXCJtZWFzdXJlTWVtb3J5UHJlc3N1cmUgbWFya3MgcHJlc3N1cmUgb25seSBhYm92ZSB0aGUgdGhyZXNob2xkXCIsICgpID0+IHtcbiAgY29uc3Qgc25hcHNob3QgPSBtZWFzdXJlTWVtb3J5UHJlc3N1cmUoe1xuICAgIHRocmVzaG9sZDogMC44NSxcbiAgICBkZXBzOiB7XG4gICAgICBtZW1vcnlVc2FnZTogKCkgPT4gKHsgaGVhcFVzZWQ6IDkwMCAqIG1iIH0pLFxuICAgICAgaGVhcExpbWl0Qnl0ZXM6ICgpID0+IDEwMDAgKiBtYixcbiAgICB9LFxuICB9KTtcblxuICBhc3NlcnQuZXF1YWwoc25hcHNob3QucHJlc3N1cmVkLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHNuYXBzaG90LnBjdCwgMC45KTtcbn0pO1xuXG50ZXN0KFwibWVhc3VyZU1lbW9yeVByZXNzdXJlIHRyZWF0cyBleGFjdCB0aHJlc2hvbGQgYXMgbm90IHByZXNzdXJlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHNuYXBzaG90ID0gbWVhc3VyZU1lbW9yeVByZXNzdXJlKHtcbiAgICB0aHJlc2hvbGQ6IDAuODUsXG4gICAgZGVwczoge1xuICAgICAgbWVtb3J5VXNhZ2U6ICgpID0+ICh7IGhlYXBVc2VkOiA4NTAgKiBtYiB9KSxcbiAgICAgIGhlYXBMaW1pdEJ5dGVzOiAoKSA9PiAxMDAwICogbWIsXG4gICAgfSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHNuYXBzaG90LnByZXNzdXJlZCwgZmFsc2UpO1xuICBhc3NlcnQuZXF1YWwoc25hcHNob3QucGN0LCAwLjg1KTtcbn0pO1xuXG50ZXN0KFwibWVhc3VyZU1lbW9yeVByZXNzdXJlIGZhbGxzIGJhY2sgd2hlbiBoZWFwIGxpbWl0IGNhbm5vdCBiZSByZWFkXCIsICgpID0+IHtcbiAgY29uc3Qgc25hcHNob3QgPSBtZWFzdXJlTWVtb3J5UHJlc3N1cmUoe1xuICAgIGZhbGxiYWNrTGltaXRNQjogNDA5NixcbiAgICBkZXBzOiB7XG4gICAgICBtZW1vcnlVc2FnZTogKCkgPT4gKHsgaGVhcFVzZWQ6IDEwMjQgKiBtYiB9KSxcbiAgICAgIGhlYXBMaW1pdEJ5dGVzOiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcInY4IHVuYXZhaWxhYmxlXCIpO1xuICAgICAgfSxcbiAgICB9LFxuICB9KTtcblxuICBhc3NlcnQuZGVlcEVxdWFsKHNuYXBzaG90LCB7XG4gICAgcHJlc3N1cmVkOiBmYWxzZSxcbiAgICBoZWFwTUI6IDEwMjQsXG4gICAgbGltaXRNQjogNDA5NixcbiAgICBwY3Q6IDAuMjUsXG4gIH0pO1xufSk7XG5cbnRlc3QoXCJzaG91bGRDaGVja01lbW9yeVByZXNzdXJlIGNvdmVycyB0aGUgZmlyc3QgYXV0by1tb2RlIGl0ZXJhdGlvblwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChzaG91bGRDaGVja01lbW9yeVByZXNzdXJlKDEsIDUpLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKHNob3VsZENoZWNrTWVtb3J5UHJlc3N1cmUoMiwgNSksIGZhbHNlKTtcbiAgYXNzZXJ0LmVxdWFsKHNob3VsZENoZWNrTWVtb3J5UHJlc3N1cmUoNSwgNSksIHRydWUpO1xufSk7XG5cbnRlc3QoXCJzaG91bGRDaGVja01lbW9yeVByZXNzdXJlIHJlamVjdHMgaW52YWxpZCBpbnRlcnZhbHNcIiwgKCkgPT4ge1xuICBhc3NlcnQudGhyb3dzKFxuICAgICgpID0+IHNob3VsZENoZWNrTWVtb3J5UHJlc3N1cmUoMSwgMCksXG4gICAgL3Bvc2l0aXZlIGludGVnZXIvLFxuICApO1xuICBhc3NlcnQudGhyb3dzKFxuICAgICgpID0+IHNob3VsZENoZWNrTWVtb3J5UHJlc3N1cmUoMSwgMS41KSxcbiAgICAvcG9zaXRpdmUgaW50ZWdlci8sXG4gICk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLE9BQU8sWUFBWTtBQUNuQixPQUFPLFVBQVU7QUFFakI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFFUCxNQUFNLEtBQUssT0FBTztBQUVsQixLQUFLLDRFQUE0RSxNQUFNO0FBQ3JGLFFBQU0sV0FBVyxzQkFBc0I7QUFBQSxJQUNyQyxXQUFXO0FBQUEsSUFDWCxNQUFNO0FBQUEsTUFDSixhQUFhLE9BQU8sRUFBRSxVQUFVLE1BQU0sR0FBRztBQUFBLE1BQ3pDLGdCQUFnQixNQUFNLE9BQU87QUFBQSxJQUMvQjtBQUFBLEVBQ0YsQ0FBQztBQUVELFNBQU8sVUFBVSxVQUFVO0FBQUEsSUFDekIsV0FBVztBQUFBLElBQ1gsUUFBUTtBQUFBLElBQ1IsU0FBUztBQUFBLElBQ1QsS0FBSztBQUFBLEVBQ1AsQ0FBQztBQUNILENBQUM7QUFFRCxLQUFLLGlFQUFpRSxNQUFNO0FBQzFFLFFBQU0sV0FBVyxzQkFBc0I7QUFBQSxJQUNyQyxXQUFXO0FBQUEsSUFDWCxNQUFNO0FBQUEsTUFDSixhQUFhLE9BQU8sRUFBRSxVQUFVLE1BQU0sR0FBRztBQUFBLE1BQ3pDLGdCQUFnQixNQUFNLE1BQU87QUFBQSxJQUMvQjtBQUFBLEVBQ0YsQ0FBQztBQUVELFNBQU8sTUFBTSxTQUFTLFdBQVcsSUFBSTtBQUNyQyxTQUFPLE1BQU0sU0FBUyxLQUFLLEdBQUc7QUFDaEMsQ0FBQztBQUVELEtBQUssaUVBQWlFLE1BQU07QUFDMUUsUUFBTSxXQUFXLHNCQUFzQjtBQUFBLElBQ3JDLFdBQVc7QUFBQSxJQUNYLE1BQU07QUFBQSxNQUNKLGFBQWEsT0FBTyxFQUFFLFVBQVUsTUFBTSxHQUFHO0FBQUEsTUFDekMsZ0JBQWdCLE1BQU0sTUFBTztBQUFBLElBQy9CO0FBQUEsRUFDRixDQUFDO0FBRUQsU0FBTyxNQUFNLFNBQVMsV0FBVyxLQUFLO0FBQ3RDLFNBQU8sTUFBTSxTQUFTLEtBQUssSUFBSTtBQUNqQyxDQUFDO0FBRUQsS0FBSyxtRUFBbUUsTUFBTTtBQUM1RSxRQUFNLFdBQVcsc0JBQXNCO0FBQUEsSUFDckMsaUJBQWlCO0FBQUEsSUFDakIsTUFBTTtBQUFBLE1BQ0osYUFBYSxPQUFPLEVBQUUsVUFBVSxPQUFPLEdBQUc7QUFBQSxNQUMxQyxnQkFBZ0IsTUFBTTtBQUNwQixjQUFNLElBQUksTUFBTSxnQkFBZ0I7QUFBQSxNQUNsQztBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxTQUFPLFVBQVUsVUFBVTtBQUFBLElBQ3pCLFdBQVc7QUFBQSxJQUNYLFFBQVE7QUFBQSxJQUNSLFNBQVM7QUFBQSxJQUNULEtBQUs7QUFBQSxFQUNQLENBQUM7QUFDSCxDQUFDO0FBRUQsS0FBSyxrRUFBa0UsTUFBTTtBQUMzRSxTQUFPLE1BQU0sMEJBQTBCLEdBQUcsQ0FBQyxHQUFHLElBQUk7QUFDbEQsU0FBTyxNQUFNLDBCQUEwQixHQUFHLENBQUMsR0FBRyxLQUFLO0FBQ25ELFNBQU8sTUFBTSwwQkFBMEIsR0FBRyxDQUFDLEdBQUcsSUFBSTtBQUNwRCxDQUFDO0FBRUQsS0FBSyx1REFBdUQsTUFBTTtBQUNoRSxTQUFPO0FBQUEsSUFDTCxNQUFNLDBCQUEwQixHQUFHLENBQUM7QUFBQSxJQUNwQztBQUFBLEVBQ0Y7QUFDQSxTQUFPO0FBQUEsSUFDTCxNQUFNLDBCQUEwQixHQUFHLEdBQUc7QUFBQSxJQUN0QztBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
