import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _setAutoActiveForTest } from "../auto.js";
import { handleWorkflowCommand } from "../commands/handlers/workflow.js";
describe("/gsd quick auto-mode guard (#2417)", () => {
  it("returns handled and notifies when auto-mode is active", async () => {
    const notifications = [];
    _setAutoActiveForTest(true);
    try {
      const handled = await handleWorkflowCommand("quick fix the docs", {
        ui: {
          notify(message, level) {
            notifications.push({ message, level });
          }
        }
      }, {});
      assert.equal(handled, true);
      assert.deepEqual(notifications, [{
        message: "/gsd quick cannot run while auto-mode is active.\nStop auto-mode first with /gsd stop, then run /gsd quick.",
        level: "error"
      }]);
    } finally {
      _setAutoActiveForTest(false);
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9xdWljay1hdXRvLWd1YXJkLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVGVzdHMgdGhhdCAvZ3NkIHF1aWNrIGlzIGJsb2NrZWQgd2hlbiBhdXRvLW1vZGUgaXMgYWN0aXZlLlxuICpcbiAqIFJlbGF0ZXMgdG8gIzI0MTc6IC9nc2QgcXVpY2sgZnJlZXplcyB0ZXJtaW5hbCB3aGVuIGF1dG8tbW9kZSBpcyBhY3RpdmUuXG4gKiBUaGUgZml4IGFkZHMgYW4gaXNBdXRvQWN0aXZlKCkgZ3VhcmQgaW4gaGFuZGxlV29ya2Zsb3dDb21tYW5kIGJlZm9yZVxuICogZGVsZWdhdGluZyB0byBoYW5kbGVRdWljay5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IF9zZXRBdXRvQWN0aXZlRm9yVGVzdCB9IGZyb20gXCIuLi9hdXRvLnRzXCI7XG5pbXBvcnQgeyBoYW5kbGVXb3JrZmxvd0NvbW1hbmQgfSBmcm9tIFwiLi4vY29tbWFuZHMvaGFuZGxlcnMvd29ya2Zsb3cudHNcIjtcblxuZGVzY3JpYmUoXCIvZ3NkIHF1aWNrIGF1dG8tbW9kZSBndWFyZCAoIzI0MTcpXCIsICgpID0+IHtcbiAgaXQoXCJyZXR1cm5zIGhhbmRsZWQgYW5kIG5vdGlmaWVzIHdoZW4gYXV0by1tb2RlIGlzIGFjdGl2ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3Qgbm90aWZpY2F0aW9uczogQXJyYXk8eyBtZXNzYWdlOiBzdHJpbmc7IGxldmVsPzogc3RyaW5nIH0+ID0gW107XG4gICAgX3NldEF1dG9BY3RpdmVGb3JUZXN0KHRydWUpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBoYW5kbGVkID0gYXdhaXQgaGFuZGxlV29ya2Zsb3dDb21tYW5kKFwicXVpY2sgZml4IHRoZSBkb2NzXCIsIHtcbiAgICAgICAgdWk6IHtcbiAgICAgICAgICBub3RpZnkobWVzc2FnZTogc3RyaW5nLCBsZXZlbD86IHN0cmluZykge1xuICAgICAgICAgICAgbm90aWZpY2F0aW9ucy5wdXNoKHsgbWVzc2FnZSwgbGV2ZWwgfSk7XG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0gYXMgYW55LCB7fSBhcyBhbnkpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoaGFuZGxlZCwgdHJ1ZSk7XG4gICAgICBhc3NlcnQuZGVlcEVxdWFsKG5vdGlmaWNhdGlvbnMsIFt7XG4gICAgICAgIG1lc3NhZ2U6IFwiL2dzZCBxdWljayBjYW5ub3QgcnVuIHdoaWxlIGF1dG8tbW9kZSBpcyBhY3RpdmUuXFxuU3RvcCBhdXRvLW1vZGUgZmlyc3Qgd2l0aCAvZ3NkIHN0b3AsIHRoZW4gcnVuIC9nc2QgcXVpY2suXCIsXG4gICAgICAgIGxldmVsOiBcImVycm9yXCIsXG4gICAgICB9XSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIF9zZXRBdXRvQWN0aXZlRm9yVGVzdChmYWxzZSk7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBUUEsU0FBUyxVQUFVLFVBQVU7QUFDN0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsNkJBQTZCO0FBQ3RDLFNBQVMsNkJBQTZCO0FBRXRDLFNBQVMsc0NBQXNDLE1BQU07QUFDbkQsS0FBRyx5REFBeUQsWUFBWTtBQUN0RSxVQUFNLGdCQUE0RCxDQUFDO0FBQ25FLDBCQUFzQixJQUFJO0FBQzFCLFFBQUk7QUFDRixZQUFNLFVBQVUsTUFBTSxzQkFBc0Isc0JBQXNCO0FBQUEsUUFDaEUsSUFBSTtBQUFBLFVBQ0YsT0FBTyxTQUFpQixPQUFnQjtBQUN0QywwQkFBYyxLQUFLLEVBQUUsU0FBUyxNQUFNLENBQUM7QUFBQSxVQUN2QztBQUFBLFFBQ0Y7QUFBQSxNQUNGLEdBQVUsQ0FBQyxDQUFRO0FBRW5CLGFBQU8sTUFBTSxTQUFTLElBQUk7QUFDMUIsYUFBTyxVQUFVLGVBQWUsQ0FBQztBQUFBLFFBQy9CLFNBQVM7QUFBQSxRQUNULE9BQU87QUFBQSxNQUNULENBQUMsQ0FBQztBQUFBLElBQ0osVUFBRTtBQUNBLDRCQUFzQixLQUFLO0FBQUEsSUFDN0I7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
