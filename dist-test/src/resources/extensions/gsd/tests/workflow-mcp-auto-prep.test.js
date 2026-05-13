import test from "node:test";
import assert from "node:assert/strict";
import { prepareWorkflowMcpForProject, shouldAutoPrepareWorkflowMcp } from "../workflow-mcp-auto-prep.js";
test("shouldAutoPrepareWorkflowMcp enables prep for externalCli local transport", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "claude-code", baseUrl: "local://claude-code" },
    modelRegistry: {
      getProviderAuthMode: () => "externalCli",
      isProviderRequestReady: () => false
    }
  });
  assert.equal(result, true);
});
test("shouldAutoPrepareWorkflowMcp stays disabled for non-Claude active provider even when claude-code is ready", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "openai", baseUrl: "https://api.openai.com" },
    modelRegistry: {
      getProviderAuthMode: () => "apiKey",
      isProviderRequestReady: (provider) => provider === "claude-code"
    }
  });
  assert.equal(result, false);
});
test("shouldAutoPrepareWorkflowMcp stays disabled for non-Claude active provider even when claude-code is registered", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "openai", baseUrl: "https://api.openai.com" },
    modelRegistry: {
      getProviderAuthMode: (provider) => provider === "claude-code" ? "externalCli" : "apiKey",
      isProviderRequestReady: () => false
    }
  });
  assert.equal(result, false);
});
test("shouldAutoPrepareWorkflowMcp stays disabled when neither transport nor provider readiness match", () => {
  const result = shouldAutoPrepareWorkflowMcp({
    model: { provider: "openai", baseUrl: "https://api.openai.com" },
    modelRegistry: {
      getProviderAuthMode: () => "apiKey",
      isProviderRequestReady: () => false
    }
  });
  assert.equal(result, false);
});
test("prepareWorkflowMcpForProject warns with /gsd mcp init guidance when prep fails", () => {
  const notifications = [];
  const result = prepareWorkflowMcpForProject(
    {
      model: { provider: "claude-code", baseUrl: "local://claude-code" },
      modelRegistry: {
        getProviderAuthMode: () => "externalCli",
        isProviderRequestReady: () => true
      },
      ui: {
        notify: (message, level) => {
          notifications.push({ message, level: level ?? "info" });
        }
      }
    },
    "/"
  );
  assert.equal(result, null);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /Please run \/gsd mcp init \./);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrZmxvdy1tY3AtYXV0by1wcmVwLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQgeyBwcmVwYXJlV29ya2Zsb3dNY3BGb3JQcm9qZWN0LCBzaG91bGRBdXRvUHJlcGFyZVdvcmtmbG93TWNwIH0gZnJvbSBcIi4uL3dvcmtmbG93LW1jcC1hdXRvLXByZXAudHNcIjtcblxudGVzdChcInNob3VsZEF1dG9QcmVwYXJlV29ya2Zsb3dNY3AgZW5hYmxlcyBwcmVwIGZvciBleHRlcm5hbENsaSBsb2NhbCB0cmFuc3BvcnRcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBzaG91bGRBdXRvUHJlcGFyZVdvcmtmbG93TWNwKHtcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJjbGF1ZGUtY29kZVwiLCBiYXNlVXJsOiBcImxvY2FsOi8vY2xhdWRlLWNvZGVcIiB9LFxuICAgIG1vZGVsUmVnaXN0cnk6IHtcbiAgICAgIGdldFByb3ZpZGVyQXV0aE1vZGU6ICgpID0+IFwiZXh0ZXJuYWxDbGlcIixcbiAgICAgIGlzUHJvdmlkZXJSZXF1ZXN0UmVhZHk6ICgpID0+IGZhbHNlLFxuICAgIH0sXG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQsIHRydWUpO1xufSk7XG5cbnRlc3QoXCJzaG91bGRBdXRvUHJlcGFyZVdvcmtmbG93TWNwIHN0YXlzIGRpc2FibGVkIGZvciBub24tQ2xhdWRlIGFjdGl2ZSBwcm92aWRlciBldmVuIHdoZW4gY2xhdWRlLWNvZGUgaXMgcmVhZHlcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBzaG91bGRBdXRvUHJlcGFyZVdvcmtmbG93TWNwKHtcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJvcGVuYWlcIiwgYmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tXCIgfSxcbiAgICBtb2RlbFJlZ2lzdHJ5OiB7XG4gICAgICBnZXRQcm92aWRlckF1dGhNb2RlOiAoKSA9PiBcImFwaUtleVwiLFxuICAgICAgaXNQcm92aWRlclJlcXVlc3RSZWFkeTogKHByb3ZpZGVyOiBzdHJpbmcpID0+IHByb3ZpZGVyID09PSBcImNsYXVkZS1jb2RlXCIsXG4gICAgfSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJzaG91bGRBdXRvUHJlcGFyZVdvcmtmbG93TWNwIHN0YXlzIGRpc2FibGVkIGZvciBub24tQ2xhdWRlIGFjdGl2ZSBwcm92aWRlciBldmVuIHdoZW4gY2xhdWRlLWNvZGUgaXMgcmVnaXN0ZXJlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHNob3VsZEF1dG9QcmVwYXJlV29ya2Zsb3dNY3Aoe1xuICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcIm9wZW5haVwiLCBiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb21cIiB9LFxuICAgIG1vZGVsUmVnaXN0cnk6IHtcbiAgICAgIGdldFByb3ZpZGVyQXV0aE1vZGU6IChwcm92aWRlcjogc3RyaW5nKSA9PiBwcm92aWRlciA9PT0gXCJjbGF1ZGUtY29kZVwiID8gXCJleHRlcm5hbENsaVwiIDogXCJhcGlLZXlcIixcbiAgICAgIGlzUHJvdmlkZXJSZXF1ZXN0UmVhZHk6ICgpID0+IGZhbHNlLFxuICAgIH0sXG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQsIGZhbHNlKTtcbn0pO1xuXG50ZXN0KFwic2hvdWxkQXV0b1ByZXBhcmVXb3JrZmxvd01jcCBzdGF5cyBkaXNhYmxlZCB3aGVuIG5laXRoZXIgdHJhbnNwb3J0IG5vciBwcm92aWRlciByZWFkaW5lc3MgbWF0Y2hcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBzaG91bGRBdXRvUHJlcGFyZVdvcmtmbG93TWNwKHtcbiAgICBtb2RlbDogeyBwcm92aWRlcjogXCJvcGVuYWlcIiwgYmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tXCIgfSxcbiAgICBtb2RlbFJlZ2lzdHJ5OiB7XG4gICAgICBnZXRQcm92aWRlckF1dGhNb2RlOiAoKSA9PiBcImFwaUtleVwiLFxuICAgICAgaXNQcm92aWRlclJlcXVlc3RSZWFkeTogKCkgPT4gZmFsc2UsXG4gICAgfSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgZmFsc2UpO1xufSk7XG5cbnRlc3QoXCJwcmVwYXJlV29ya2Zsb3dNY3BGb3JQcm9qZWN0IHdhcm5zIHdpdGggL2dzZCBtY3AgaW5pdCBndWlkYW5jZSB3aGVuIHByZXAgZmFpbHNcIiwgKCkgPT4ge1xuICBjb25zdCBub3RpZmljYXRpb25zOiBBcnJheTx7IG1lc3NhZ2U6IHN0cmluZzsgbGV2ZWw6IFwiaW5mb1wiIHwgXCJ3YXJuaW5nXCIgfCBcImVycm9yXCIgfCBcInN1Y2Nlc3NcIiB9PiA9IFtdO1xuICBjb25zdCByZXN1bHQgPSBwcmVwYXJlV29ya2Zsb3dNY3BGb3JQcm9qZWN0KFxuICAgIHtcbiAgICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcImNsYXVkZS1jb2RlXCIsIGJhc2VVcmw6IFwibG9jYWw6Ly9jbGF1ZGUtY29kZVwiIH0sXG4gICAgICBtb2RlbFJlZ2lzdHJ5OiB7XG4gICAgICAgIGdldFByb3ZpZGVyQXV0aE1vZGU6ICgpID0+IFwiZXh0ZXJuYWxDbGlcIixcbiAgICAgICAgaXNQcm92aWRlclJlcXVlc3RSZWFkeTogKCkgPT4gdHJ1ZSxcbiAgICAgIH0sXG4gICAgICB1aToge1xuICAgICAgICBub3RpZnk6IChtZXNzYWdlOiBzdHJpbmcsIGxldmVsPzogXCJpbmZvXCIgfCBcIndhcm5pbmdcIiB8IFwiZXJyb3JcIiB8IFwic3VjY2Vzc1wiKSA9PiB7XG4gICAgICAgICAgbm90aWZpY2F0aW9ucy5wdXNoKHsgbWVzc2FnZSwgbGV2ZWw6IGxldmVsID8/IFwiaW5mb1wiIH0pO1xuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9LFxuICAgIFwiL1wiLFxuICApO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuICBhc3NlcnQuZXF1YWwobm90aWZpY2F0aW9ucy5sZW5ndGgsIDEpO1xuICBhc3NlcnQuZXF1YWwobm90aWZpY2F0aW9uc1swXS5sZXZlbCwgXCJ3YXJuaW5nXCIpO1xuICBhc3NlcnQubWF0Y2gobm90aWZpY2F0aW9uc1swXS5tZXNzYWdlLCAvUGxlYXNlIHJ1biBcXC9nc2QgbWNwIGluaXQgXFwuLyk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFFbkIsU0FBUyw4QkFBOEIsb0NBQW9DO0FBRTNFLEtBQUssNkVBQTZFLE1BQU07QUFDdEYsUUFBTSxTQUFTLDZCQUE2QjtBQUFBLElBQzFDLE9BQU8sRUFBRSxVQUFVLGVBQWUsU0FBUyxzQkFBc0I7QUFBQSxJQUNqRSxlQUFlO0FBQUEsTUFDYixxQkFBcUIsTUFBTTtBQUFBLE1BQzNCLHdCQUF3QixNQUFNO0FBQUEsSUFDaEM7QUFBQSxFQUNGLENBQUM7QUFFRCxTQUFPLE1BQU0sUUFBUSxJQUFJO0FBQzNCLENBQUM7QUFFRCxLQUFLLDZHQUE2RyxNQUFNO0FBQ3RILFFBQU0sU0FBUyw2QkFBNkI7QUFBQSxJQUMxQyxPQUFPLEVBQUUsVUFBVSxVQUFVLFNBQVMseUJBQXlCO0FBQUEsSUFDL0QsZUFBZTtBQUFBLE1BQ2IscUJBQXFCLE1BQU07QUFBQSxNQUMzQix3QkFBd0IsQ0FBQyxhQUFxQixhQUFhO0FBQUEsSUFDN0Q7QUFBQSxFQUNGLENBQUM7QUFFRCxTQUFPLE1BQU0sUUFBUSxLQUFLO0FBQzVCLENBQUM7QUFFRCxLQUFLLGtIQUFrSCxNQUFNO0FBQzNILFFBQU0sU0FBUyw2QkFBNkI7QUFBQSxJQUMxQyxPQUFPLEVBQUUsVUFBVSxVQUFVLFNBQVMseUJBQXlCO0FBQUEsSUFDL0QsZUFBZTtBQUFBLE1BQ2IscUJBQXFCLENBQUMsYUFBcUIsYUFBYSxnQkFBZ0IsZ0JBQWdCO0FBQUEsTUFDeEYsd0JBQXdCLE1BQU07QUFBQSxJQUNoQztBQUFBLEVBQ0YsQ0FBQztBQUVELFNBQU8sTUFBTSxRQUFRLEtBQUs7QUFDNUIsQ0FBQztBQUVELEtBQUssbUdBQW1HLE1BQU07QUFDNUcsUUFBTSxTQUFTLDZCQUE2QjtBQUFBLElBQzFDLE9BQU8sRUFBRSxVQUFVLFVBQVUsU0FBUyx5QkFBeUI7QUFBQSxJQUMvRCxlQUFlO0FBQUEsTUFDYixxQkFBcUIsTUFBTTtBQUFBLE1BQzNCLHdCQUF3QixNQUFNO0FBQUEsSUFDaEM7QUFBQSxFQUNGLENBQUM7QUFFRCxTQUFPLE1BQU0sUUFBUSxLQUFLO0FBQzVCLENBQUM7QUFFRCxLQUFLLGtGQUFrRixNQUFNO0FBQzNGLFFBQU0sZ0JBQTZGLENBQUM7QUFDcEcsUUFBTSxTQUFTO0FBQUEsSUFDYjtBQUFBLE1BQ0UsT0FBTyxFQUFFLFVBQVUsZUFBZSxTQUFTLHNCQUFzQjtBQUFBLE1BQ2pFLGVBQWU7QUFBQSxRQUNiLHFCQUFxQixNQUFNO0FBQUEsUUFDM0Isd0JBQXdCLE1BQU07QUFBQSxNQUNoQztBQUFBLE1BQ0EsSUFBSTtBQUFBLFFBQ0YsUUFBUSxDQUFDLFNBQWlCLFVBQXFEO0FBQzdFLHdCQUFjLEtBQUssRUFBRSxTQUFTLE9BQU8sU0FBUyxPQUFPLENBQUM7QUFBQSxRQUN4RDtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsSUFDQTtBQUFBLEVBQ0Y7QUFFQSxTQUFPLE1BQU0sUUFBUSxJQUFJO0FBQ3pCLFNBQU8sTUFBTSxjQUFjLFFBQVEsQ0FBQztBQUNwQyxTQUFPLE1BQU0sY0FBYyxDQUFDLEVBQUUsT0FBTyxTQUFTO0FBQzlDLFNBQU8sTUFBTSxjQUFjLENBQUMsRUFBRSxTQUFTLDhCQUE4QjtBQUN2RSxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
