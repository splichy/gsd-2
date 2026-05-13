import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
  formatMcpInitResult,
  formatMcpStatusReport,
  formatMcpServerDetail
} from "../commands-mcp-status.js";
describe("formatMcpStatusReport", () => {
  test("returns no-servers message when list is empty", () => {
    const result = formatMcpStatusReport([]);
    assert.match(result, /no mcp servers configured/i);
  });
  test("lists all servers with connection status", () => {
    const servers = [
      { name: "railway", transport: "stdio", connected: true, toolCount: 5, error: void 0 },
      { name: "linear", transport: "http", connected: false, toolCount: 0, error: void 0 }
    ];
    const result = formatMcpStatusReport(servers);
    assert.match(result, /railway/);
    assert.match(result, /linear/);
    assert.match(result, /connected/i);
    assert.match(result, /disconnected/i);
    assert.match(result, /5 tools/);
  });
  test("shows error state for servers with errors", () => {
    const servers = [
      { name: "broken", transport: "stdio", connected: false, toolCount: 0, error: "Connection refused" }
    ];
    const result = formatMcpStatusReport(servers);
    assert.match(result, /error/i);
    assert.match(result, /Connection refused/);
  });
  test("includes server count in header", () => {
    const servers = [
      { name: "a", transport: "stdio", connected: true, toolCount: 3, error: void 0 },
      { name: "b", transport: "http", connected: true, toolCount: 2, error: void 0 }
    ];
    const result = formatMcpStatusReport(servers);
    assert.match(result, /2/);
  });
});
describe("formatMcpServerDetail", () => {
  test("shows server name and transport", () => {
    const result = formatMcpServerDetail({
      name: "railway",
      transport: "stdio",
      connected: true,
      toolCount: 3,
      tools: ["railway_list_projects", "railway_deploy", "railway_logs"],
      error: void 0
    });
    assert.match(result, /railway/);
    assert.match(result, /stdio/);
  });
  test("lists individual tools when available", () => {
    const result = formatMcpServerDetail({
      name: "railway",
      transport: "stdio",
      connected: true,
      toolCount: 2,
      tools: ["railway_list_projects", "railway_deploy"],
      error: void 0
    });
    assert.match(result, /railway_list_projects/);
    assert.match(result, /railway_deploy/);
  });
  test("shows error message for failed servers", () => {
    const result = formatMcpServerDetail({
      name: "broken",
      transport: "stdio",
      connected: false,
      toolCount: 0,
      tools: [],
      error: "spawn ENOENT"
    });
    assert.match(result, /error/i);
    assert.match(result, /spawn ENOENT/);
  });
  test("shows disconnected status with no tools", () => {
    const result = formatMcpServerDetail({
      name: "offline",
      transport: "http",
      connected: false,
      toolCount: 0,
      tools: [],
      error: void 0
    });
    assert.match(result, /disconnected/i);
  });
});
describe("formatMcpInitResult", () => {
  test("shows created message with config path", () => {
    const result = formatMcpInitResult("created", "/tmp/project/.mcp.json", "/tmp/project");
    assert.match(result, /created project mcp config/i);
    assert.match(result, /\/tmp\/project\/\.mcp\.json/);
    assert.match(result, /claude code/i);
  });
  test("shows unchanged message when config is current", () => {
    const result = formatMcpInitResult("unchanged", "/tmp/project/.mcp.json", "/tmp/project");
    assert.match(result, /already up to date/i);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9tY3Atc3RhdHVzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0LCB7IGRlc2NyaWJlIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbmltcG9ydCB7XG4gIGZvcm1hdE1jcEluaXRSZXN1bHQsXG4gIGZvcm1hdE1jcFN0YXR1c1JlcG9ydCxcbiAgZm9ybWF0TWNwU2VydmVyRGV0YWlsLFxuICB0eXBlIE1jcFNlcnZlclN0YXR1cyxcbn0gZnJvbSBcIi4uL2NvbW1hbmRzLW1jcC1zdGF0dXMudHNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGZvcm1hdE1jcFN0YXR1c1JlcG9ydCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJmb3JtYXRNY3BTdGF0dXNSZXBvcnRcIiwgKCkgPT4ge1xuICB0ZXN0KFwicmV0dXJucyBuby1zZXJ2ZXJzIG1lc3NhZ2Ugd2hlbiBsaXN0IGlzIGVtcHR5XCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRNY3BTdGF0dXNSZXBvcnQoW10pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9ubyBtY3Agc2VydmVycyBjb25maWd1cmVkL2kpO1xuICB9KTtcblxuICB0ZXN0KFwibGlzdHMgYWxsIHNlcnZlcnMgd2l0aCBjb25uZWN0aW9uIHN0YXR1c1wiLCAoKSA9PiB7XG4gICAgY29uc3Qgc2VydmVyczogTWNwU2VydmVyU3RhdHVzW10gPSBbXG4gICAgICB7IG5hbWU6IFwicmFpbHdheVwiLCB0cmFuc3BvcnQ6IFwic3RkaW9cIiwgY29ubmVjdGVkOiB0cnVlLCB0b29sQ291bnQ6IDUsIGVycm9yOiB1bmRlZmluZWQgfSxcbiAgICAgIHsgbmFtZTogXCJsaW5lYXJcIiwgdHJhbnNwb3J0OiBcImh0dHBcIiwgY29ubmVjdGVkOiBmYWxzZSwgdG9vbENvdW50OiAwLCBlcnJvcjogdW5kZWZpbmVkIH0sXG4gICAgXTtcbiAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRNY3BTdGF0dXNSZXBvcnQoc2VydmVycyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdCwgL3JhaWx3YXkvKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvbGluZWFyLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdCwgL2Nvbm5lY3RlZC9pKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvZGlzY29ubmVjdGVkL2kpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC81IHRvb2xzLyk7XG4gIH0pO1xuXG4gIHRlc3QoXCJzaG93cyBlcnJvciBzdGF0ZSBmb3Igc2VydmVycyB3aXRoIGVycm9yc1wiLCAoKSA9PiB7XG4gICAgY29uc3Qgc2VydmVyczogTWNwU2VydmVyU3RhdHVzW10gPSBbXG4gICAgICB7IG5hbWU6IFwiYnJva2VuXCIsIHRyYW5zcG9ydDogXCJzdGRpb1wiLCBjb25uZWN0ZWQ6IGZhbHNlLCB0b29sQ291bnQ6IDAsIGVycm9yOiBcIkNvbm5lY3Rpb24gcmVmdXNlZFwiIH0sXG4gICAgXTtcbiAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRNY3BTdGF0dXNSZXBvcnQoc2VydmVycyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdCwgL2Vycm9yL2kpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9Db25uZWN0aW9uIHJlZnVzZWQvKTtcbiAgfSk7XG5cbiAgdGVzdChcImluY2x1ZGVzIHNlcnZlciBjb3VudCBpbiBoZWFkZXJcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHNlcnZlcnM6IE1jcFNlcnZlclN0YXR1c1tdID0gW1xuICAgICAgeyBuYW1lOiBcImFcIiwgdHJhbnNwb3J0OiBcInN0ZGlvXCIsIGNvbm5lY3RlZDogdHJ1ZSwgdG9vbENvdW50OiAzLCBlcnJvcjogdW5kZWZpbmVkIH0sXG4gICAgICB7IG5hbWU6IFwiYlwiLCB0cmFuc3BvcnQ6IFwiaHR0cFwiLCBjb25uZWN0ZWQ6IHRydWUsIHRvb2xDb3VudDogMiwgZXJyb3I6IHVuZGVmaW5lZCB9LFxuICAgIF07XG4gICAgY29uc3QgcmVzdWx0ID0gZm9ybWF0TWNwU3RhdHVzUmVwb3J0KHNlcnZlcnMpO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC8yLyk7XG4gIH0pO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBmb3JtYXRNY3BTZXJ2ZXJEZXRhaWwgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiZm9ybWF0TWNwU2VydmVyRGV0YWlsXCIsICgpID0+IHtcbiAgdGVzdChcInNob3dzIHNlcnZlciBuYW1lIGFuZCB0cmFuc3BvcnRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdE1jcFNlcnZlckRldGFpbCh7XG4gICAgICBuYW1lOiBcInJhaWx3YXlcIixcbiAgICAgIHRyYW5zcG9ydDogXCJzdGRpb1wiLFxuICAgICAgY29ubmVjdGVkOiB0cnVlLFxuICAgICAgdG9vbENvdW50OiAzLFxuICAgICAgdG9vbHM6IFtcInJhaWx3YXlfbGlzdF9wcm9qZWN0c1wiLCBcInJhaWx3YXlfZGVwbG95XCIsIFwicmFpbHdheV9sb2dzXCJdLFxuICAgICAgZXJyb3I6IHVuZGVmaW5lZCxcbiAgICB9KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvcmFpbHdheS8pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9zdGRpby8pO1xuICB9KTtcblxuICB0ZXN0KFwibGlzdHMgaW5kaXZpZHVhbCB0b29scyB3aGVuIGF2YWlsYWJsZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gZm9ybWF0TWNwU2VydmVyRGV0YWlsKHtcbiAgICAgIG5hbWU6IFwicmFpbHdheVwiLFxuICAgICAgdHJhbnNwb3J0OiBcInN0ZGlvXCIsXG4gICAgICBjb25uZWN0ZWQ6IHRydWUsXG4gICAgICB0b29sQ291bnQ6IDIsXG4gICAgICB0b29sczogW1wicmFpbHdheV9saXN0X3Byb2plY3RzXCIsIFwicmFpbHdheV9kZXBsb3lcIl0sXG4gICAgICBlcnJvcjogdW5kZWZpbmVkLFxuICAgIH0pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9yYWlsd2F5X2xpc3RfcHJvamVjdHMvKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvcmFpbHdheV9kZXBsb3kvKTtcbiAgfSk7XG5cbiAgdGVzdChcInNob3dzIGVycm9yIG1lc3NhZ2UgZm9yIGZhaWxlZCBzZXJ2ZXJzXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBmb3JtYXRNY3BTZXJ2ZXJEZXRhaWwoe1xuICAgICAgbmFtZTogXCJicm9rZW5cIixcbiAgICAgIHRyYW5zcG9ydDogXCJzdGRpb1wiLFxuICAgICAgY29ubmVjdGVkOiBmYWxzZSxcbiAgICAgIHRvb2xDb3VudDogMCxcbiAgICAgIHRvb2xzOiBbXSxcbiAgICAgIGVycm9yOiBcInNwYXduIEVOT0VOVFwiLFxuICAgIH0pO1xuICAgIGFzc2VydC5tYXRjaChyZXN1bHQsIC9lcnJvci9pKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvc3Bhd24gRU5PRU5ULyk7XG4gIH0pO1xuXG4gIHRlc3QoXCJzaG93cyBkaXNjb25uZWN0ZWQgc3RhdHVzIHdpdGggbm8gdG9vbHNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdE1jcFNlcnZlckRldGFpbCh7XG4gICAgICBuYW1lOiBcIm9mZmxpbmVcIixcbiAgICAgIHRyYW5zcG9ydDogXCJodHRwXCIsXG4gICAgICBjb25uZWN0ZWQ6IGZhbHNlLFxuICAgICAgdG9vbENvdW50OiAwLFxuICAgICAgdG9vbHM6IFtdLFxuICAgICAgZXJyb3I6IHVuZGVmaW5lZCxcbiAgICB9KTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvZGlzY29ubmVjdGVkL2kpO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcImZvcm1hdE1jcEluaXRSZXN1bHRcIiwgKCkgPT4ge1xuICB0ZXN0KFwic2hvd3MgY3JlYXRlZCBtZXNzYWdlIHdpdGggY29uZmlnIHBhdGhcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGZvcm1hdE1jcEluaXRSZXN1bHQoXCJjcmVhdGVkXCIsIFwiL3RtcC9wcm9qZWN0Ly5tY3AuanNvblwiLCBcIi90bXAvcHJvamVjdFwiKTtcbiAgICBhc3NlcnQubWF0Y2gocmVzdWx0LCAvY3JlYXRlZCBwcm9qZWN0IG1jcCBjb25maWcvaSk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdCwgL1xcL3RtcFxcL3Byb2plY3RcXC9cXC5tY3BcXC5qc29uLyk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdCwgL2NsYXVkZSBjb2RlL2kpO1xuICB9KTtcblxuICB0ZXN0KFwic2hvd3MgdW5jaGFuZ2VkIG1lc3NhZ2Ugd2hlbiBjb25maWcgaXMgY3VycmVudFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gZm9ybWF0TWNwSW5pdFJlc3VsdChcInVuY2hhbmdlZFwiLCBcIi90bXAvcHJvamVjdC8ubWNwLmpzb25cIiwgXCIvdG1wL3Byb2plY3RcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdCwgL2FscmVhZHkgdXAgdG8gZGF0ZS9pKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sUUFBUSxnQkFBZ0I7QUFDL0IsT0FBTyxZQUFZO0FBRW5CO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FFSztBQUlQLFNBQVMseUJBQXlCLE1BQU07QUFDdEMsT0FBSyxpREFBaUQsTUFBTTtBQUMxRCxVQUFNLFNBQVMsc0JBQXNCLENBQUMsQ0FBQztBQUN2QyxXQUFPLE1BQU0sUUFBUSw0QkFBNEI7QUFBQSxFQUNuRCxDQUFDO0FBRUQsT0FBSyw0Q0FBNEMsTUFBTTtBQUNyRCxVQUFNLFVBQTZCO0FBQUEsTUFDakMsRUFBRSxNQUFNLFdBQVcsV0FBVyxTQUFTLFdBQVcsTUFBTSxXQUFXLEdBQUcsT0FBTyxPQUFVO0FBQUEsTUFDdkYsRUFBRSxNQUFNLFVBQVUsV0FBVyxRQUFRLFdBQVcsT0FBTyxXQUFXLEdBQUcsT0FBTyxPQUFVO0FBQUEsSUFDeEY7QUFDQSxVQUFNLFNBQVMsc0JBQXNCLE9BQU87QUFDNUMsV0FBTyxNQUFNLFFBQVEsU0FBUztBQUM5QixXQUFPLE1BQU0sUUFBUSxRQUFRO0FBQzdCLFdBQU8sTUFBTSxRQUFRLFlBQVk7QUFDakMsV0FBTyxNQUFNLFFBQVEsZUFBZTtBQUNwQyxXQUFPLE1BQU0sUUFBUSxTQUFTO0FBQUEsRUFDaEMsQ0FBQztBQUVELE9BQUssNkNBQTZDLE1BQU07QUFDdEQsVUFBTSxVQUE2QjtBQUFBLE1BQ2pDLEVBQUUsTUFBTSxVQUFVLFdB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
