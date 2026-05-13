import test from "node:test";
import assert from "node:assert/strict";
import { validatePreferences } from "../preferences-validation.js";
test("uok preferences validate nested flags and turn_action", () => {
  const input = {
    uok: {
      enabled: true,
      legacy_fallback: { enabled: false },
      gates: { enabled: true },
      model_policy: { enabled: true },
      execution_graph: { enabled: false },
      gitops: {
        enabled: true,
        turn_action: "status-only",
        turn_push: false
      },
      audit_unified: { enabled: true },
      plan_v2: { enabled: true }
    }
  };
  const result = validatePreferences(input);
  assert.equal(result.errors.length, 0);
  assert.equal(result.preferences.uok?.enabled, true);
  assert.equal(result.preferences.uok?.legacy_fallback?.enabled, false);
  assert.equal(result.preferences.uok?.gitops?.turn_action, "status-only");
  assert.equal(result.preferences.uok?.plan_v2?.enabled, true);
});
test("uok preferences reject invalid turn_action", () => {
  const result = validatePreferences({
    uok: {
      gitops: {
        turn_action: "push-everything"
      }
    }
  });
  assert.ok(result.errors.some((e) => e.includes("uok.gitops.turn_action")));
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy91b2stcHJlZmVyZW5jZXMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbmltcG9ydCB7IHZhbGlkYXRlUHJlZmVyZW5jZXMgfSBmcm9tIFwiLi4vcHJlZmVyZW5jZXMtdmFsaWRhdGlvbi50c1wiO1xuXG50ZXN0KFwidW9rIHByZWZlcmVuY2VzIHZhbGlkYXRlIG5lc3RlZCBmbGFncyBhbmQgdHVybl9hY3Rpb25cIiwgKCkgPT4ge1xuICBjb25zdCBpbnB1dCA9IHtcbiAgICB1b2s6IHtcbiAgICAgIGVuYWJsZWQ6IHRydWUsXG4gICAgICBsZWdhY3lfZmFsbGJhY2s6IHsgZW5hYmxlZDogZmFsc2UgfSxcbiAgICAgIGdhdGVzOiB7IGVuYWJsZWQ6IHRydWUgfSxcbiAgICAgIG1vZGVsX3BvbGljeTogeyBlbmFibGVkOiB0cnVlIH0sXG4gICAgICBleGVjdXRpb25fZ3JhcGg6IHsgZW5hYmxlZDogZmFsc2UgfSxcbiAgICAgIGdpdG9wczoge1xuICAgICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgICB0dXJuX2FjdGlvbjogXCJzdGF0dXMtb25seVwiLFxuICAgICAgICB0dXJuX3B1c2g6IGZhbHNlLFxuICAgICAgfSxcbiAgICAgIGF1ZGl0X3VuaWZpZWQ6IHsgZW5hYmxlZDogdHJ1ZSB9LFxuICAgICAgcGxhbl92MjogeyBlbmFibGVkOiB0cnVlIH0sXG4gICAgfSxcbiAgfTtcblxuICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZVByZWZlcmVuY2VzKGlucHV0IGFzIG5ldmVyKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5lcnJvcnMubGVuZ3RoLCAwKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5wcmVmZXJlbmNlcy51b2s/LmVuYWJsZWQsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnByZWZlcmVuY2VzLnVvaz8ubGVnYWN5X2ZhbGxiYWNrPy5lbmFibGVkLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucHJlZmVyZW5jZXMudW9rPy5naXRvcHM/LnR1cm5fYWN0aW9uLCBcInN0YXR1cy1vbmx5XCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnByZWZlcmVuY2VzLnVvaz8ucGxhbl92Mj8uZW5hYmxlZCwgdHJ1ZSk7XG59KTtcblxudGVzdChcInVvayBwcmVmZXJlbmNlcyByZWplY3QgaW52YWxpZCB0dXJuX2FjdGlvblwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHZhbGlkYXRlUHJlZmVyZW5jZXMoe1xuICAgIHVvazoge1xuICAgICAgZ2l0b3BzOiB7XG4gICAgICAgIHR1cm5fYWN0aW9uOiBcInB1c2gtZXZlcnl0aGluZ1wiLFxuICAgICAgfSxcbiAgICB9LFxuICB9IGFzIG5ldmVyKTtcblxuICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5zb21lKChlKSA9PiBlLmluY2x1ZGVzKFwidW9rLmdpdG9wcy50dXJuX2FjdGlvblwiKSkpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBRW5CLFNBQVMsMkJBQTJCO0FBRXBDLEtBQUsseURBQXlELE1BQU07QUFDbEUsUUFBTSxRQUFRO0FBQUEsSUFDWixLQUFLO0FBQUEsTUFDSCxTQUFTO0FBQUEsTUFDVCxpQkFBaUIsRUFBRSxTQUFTLE1BQU07QUFBQSxNQUNsQyxPQUFPLEVBQUUsU0FBUyxLQUFLO0FBQUEsTUFDdkIsY0FBYyxFQUFFLFNBQVMsS0FBSztBQUFBLE1BQzlCLGlCQUFpQixFQUFFLFNBQVMsTUFBTTtBQUFBLE1BQ2xDLFFBQVE7QUFBQSxRQUNOLFNBQVM7QUFBQSxRQUNULGFBQWE7QUFBQSxRQUNiLFdBQVc7QUFBQSxNQUNiO0FBQUEsTUFDQSxlQUFlLEVBQUUsU0FBUyxLQUFLO0FBQUEsTUFDL0IsU0FBUyxFQUFFLFNBQVMsS0FBSztBQUFBLElBQzNCO0FBQUEsRUFDRjtBQUVBLFFBQU0sU0FBUyxvQkFBb0IsS0FBYztBQUNqRCxTQUFPLE1BQU0sT0FBTyxPQUFPLFFBQVEsQ0FBQztBQUNwQyxTQUFPLE1BQU0sT0FBTyxZQUFZLEtBQUssU0FBUyxJQUFJO0FBQ2xELFNBQU8sTUFBTSxPQUFPLFlBQVksS0FBSyxpQkFBaUIsU0FBUyxLQUFLO0FBQ3BFLFNBQU8sTUFBTSxPQUFPLFlBQVksS0FBSyxRQUFRLGFBQWEsYUFBYTtBQUN2RSxTQUFPLE1BQU0sT0FBTyxZQUFZLEtBQUssU0FBUyxTQUFTLElBQUk7QUFDN0QsQ0FBQztBQUVELEtBQUssOENBQThDLE1BQU07QUFDdkQsUUFBTSxTQUFTLG9CQUFvQjtBQUFBLElBQ2pDLEtBQUs7QUFBQSxNQUNILFFBQVE7QUFBQSxRQUNOLGFBQWE7QUFBQSxNQUNmO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBVTtBQUVWLFNBQU8sR0FBRyxPQUFPLE9BQU8sS0FBSyxDQUFDLE1BQU0sRUFBRSxTQUFTLHdCQUF3QixDQUFDLENBQUM7QUFDM0UsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
