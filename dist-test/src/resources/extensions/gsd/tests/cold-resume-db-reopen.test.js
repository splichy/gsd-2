import test from "node:test";
import assert from "node:assert/strict";
import { refreshResumeResourcesAndDb } from "../auto.js";
test("resume refreshes managed resources and opens DB before state rebuild", async () => {
  const calls = [];
  await refreshResumeResourcesAndDb("/tmp/project", {
    env: {
      GSD_CODING_AGENT_DIR: "/tmp/agent",
      GSD_PKG_ROOT: "/tmp/pkg"
    },
    importModule: async (specifier) => {
      calls.push(`import:${specifier}`);
      if (specifier.endsWith("/dist/resource-loader.js")) {
        return {
          initResources: (agentDir) => calls.push(`initResources:${agentDir}`)
        };
      }
      if (specifier === "./prompt-loader.js") {
        return {
          primeCache: () => calls.push("primeCache")
        };
      }
      throw new Error(`unexpected import: ${specifier}`);
    },
    openProjectDb: async (basePath) => {
      calls.push(`openDb:${basePath}`);
    }
  });
  assert.deepEqual(calls, [
    "import:file:///tmp/pkg/dist/resource-loader.js",
    "initResources:/tmp/agent",
    "import:./prompt-loader.js",
    "primeCache",
    "openDb:/tmp/project"
  ]);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb2xkLXJlc3VtZS1kYi1yZW9wZW4udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBjb2xkLXJlc3VtZS1kYi1yZW9wZW4udGVzdC50cyBcdTIwMTQgUmVncmVzc2lvbiB0ZXN0IGZvciAjMjk0MC5cbiAqL1xuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IHJlZnJlc2hSZXN1bWVSZXNvdXJjZXNBbmREYiB9IGZyb20gXCIuLi9hdXRvLnRzXCI7XG5cbnRlc3QoXCJyZXN1bWUgcmVmcmVzaGVzIG1hbmFnZWQgcmVzb3VyY2VzIGFuZCBvcGVucyBEQiBiZWZvcmUgc3RhdGUgcmVidWlsZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGNhbGxzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGF3YWl0IHJlZnJlc2hSZXN1bWVSZXNvdXJjZXNBbmREYihcIi90bXAvcHJvamVjdFwiLCB7XG4gICAgZW52OiB7XG4gICAgICBHU0RfQ09ESU5HX0FHRU5UX0RJUjogXCIvdG1wL2FnZW50XCIsXG4gICAgICBHU0RfUEtHX1JPT1Q6IFwiL3RtcC9wa2dcIixcbiAgICB9IGFzIE5vZGVKUy5Qcm9jZXNzRW52LFxuICAgIGltcG9ydE1vZHVsZTogYXN5bmMgKHNwZWNpZmllcjogc3RyaW5nKSA9PiB7XG4gICAgICBjYWxscy5wdXNoKGBpbXBvcnQ6JHtzcGVjaWZpZXJ9YCk7XG4gICAgICBpZiAoc3BlY2lmaWVyLmVuZHNXaXRoKFwiL2Rpc3QvcmVzb3VyY2UtbG9hZGVyLmpzXCIpKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgaW5pdFJlc291cmNlczogKGFnZW50RGlyOiBzdHJpbmcpID0+IGNhbGxzLnB1c2goYGluaXRSZXNvdXJjZXM6JHthZ2VudERpcn1gKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGlmIChzcGVjaWZpZXIgPT09IFwiLi9wcm9tcHQtbG9hZGVyLmpzXCIpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBwcmltZUNhY2hlOiAoKSA9PiBjYWxscy5wdXNoKFwicHJpbWVDYWNoZVwiKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIHRocm93IG5ldyBFcnJvcihgdW5leHBlY3RlZCBpbXBvcnQ6ICR7c3BlY2lmaWVyfWApO1xuICAgIH0sXG4gICAgb3BlblByb2plY3REYjogYXN5bmMgKGJhc2VQYXRoOiBzdHJpbmcpID0+IHtcbiAgICAgIGNhbGxzLnB1c2goYG9wZW5EYjoke2Jhc2VQYXRofWApO1xuICAgIH0sXG4gIH0pO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwoY2FsbHMsIFtcbiAgICBcImltcG9ydDpmaWxlOi8vL3RtcC9wa2cvZGlzdC9yZXNvdXJjZS1sb2FkZXIuanNcIixcbiAgICBcImluaXRSZXNvdXJjZXM6L3RtcC9hZ2VudFwiLFxuICAgIFwiaW1wb3J0Oi4vcHJvbXB0LWxvYWRlci5qc1wiLFxuICAgIFwicHJpbWVDYWNoZVwiLFxuICAgIFwib3BlbkRiOi90bXAvcHJvamVjdFwiLFxuICBdKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBSUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLG1DQUFtQztBQUU1QyxLQUFLLHdFQUF3RSxZQUFZO0FBQ3ZGLFFBQU0sUUFBa0IsQ0FBQztBQUV6QixRQUFNLDRCQUE0QixnQkFBZ0I7QUFBQSxJQUNoRCxLQUFLO0FBQUEsTUFDSCxzQkFBc0I7QUFBQSxNQUN0QixjQUFjO0FBQUEsSUFDaEI7QUFBQSxJQUNBLGNBQWMsT0FBTyxjQUFzQjtBQUN6QyxZQUFNLEtBQUssVUFBVSxTQUFTLEVBQUU7QUFDaEMsVUFBSSxVQUFVLFNBQVMsMEJBQTBCLEdBQUc7QUFDbEQsZUFBTztBQUFBLFVBQ0wsZUFBZSxDQUFDLGFBQXFCLE1BQU0sS0FBSyxpQkFBaUIsUUFBUSxFQUFFO0FBQUEsUUFDN0U7QUFBQSxNQUNGO0FBQ0EsVUFBSSxjQUFjLHNCQUFzQjtBQUN0QyxlQUFPO0FBQUEsVUFDTCxZQUFZLE1BQU0sTUFBTSxLQUFLLFlBQVk7QUFBQSxRQUMzQztBQUFBLE1BQ0Y7QUFDQSxZQUFNLElBQUksTUFBTSxzQkFBc0IsU0FBUyxFQUFFO0FBQUEsSUFDbkQ7QUFBQSxJQUNBLGVBQWUsT0FBTyxhQUFxQjtBQUN6QyxZQUFNLEtBQUssVUFBVSxRQUFRLEVBQUU7QUFBQSxJQUNqQztBQUFBLEVBQ0YsQ0FBQztBQUVELFNBQU8sVUFBVSxPQUFPO0FBQUEsSUFDdEI7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
