import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { refreshResumeResourcesAndDb } from "../auto.js";
describe("resource-loader import path", () => {
  test("refreshResumeResourcesAndDb resolves resource-loader from GSD_PKG_ROOT", async () => {
    const pkgRoot = "/tmp/gsd-pkg-root";
    const agentDir = "/tmp/gsd-agent";
    const basePath = "/tmp/project-root";
    const imports = [];
    const initializedDirs = [];
    const openedProjectRoots = [];
    let primed = false;
    await refreshResumeResourcesAndDb(basePath, {
      env: {
        GSD_PKG_ROOT: pkgRoot,
        GSD_CODING_AGENT_DIR: agentDir
      },
      importModule: async (specifier) => {
        imports.push(specifier);
        if (specifier.endsWith("resource-loader.js")) {
          return {
            initResources: (dir) => initializedDirs.push(dir)
          };
        }
        if (specifier === "./prompt-loader.js") {
          return {
            primeCache: () => {
              primed = true;
            }
          };
        }
        throw new Error(`Unexpected import ${specifier}`);
      },
      openProjectDb: async (projectRoot) => {
        openedProjectRoots.push(projectRoot);
      }
    });
    assert.equal(imports[0], pathToFileURL(join(pkgRoot, "dist", "resource-loader.js")).href);
    assert.deepEqual(initializedDirs, [agentDir]);
    assert.equal(primed, true);
    assert.deepEqual(openedProjectRoots, [basePath]);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZXNvdXJjZS1sb2FkZXItaW1wb3J0LXBhdGgudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEMiBcdTIwMTQgUmVncmVzc2lvbiB0ZXN0IGZvciBkZXBsb3llZCByZXNvdXJjZS1sb2FkZXIgcmVzb2x1dGlvbiBiZWhhdmlvclxuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHJlZnJlc2hSZXN1bWVSZXNvdXJjZXNBbmREYiB9IGZyb20gXCIuLi9hdXRvLnRzXCI7XG5cbmRlc2NyaWJlKFwicmVzb3VyY2UtbG9hZGVyIGltcG9ydCBwYXRoXCIsICgpID0+IHtcbiAgdGVzdChcInJlZnJlc2hSZXN1bWVSZXNvdXJjZXNBbmREYiByZXNvbHZlcyByZXNvdXJjZS1sb2FkZXIgZnJvbSBHU0RfUEtHX1JPT1RcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHBrZ1Jvb3QgPSBcIi90bXAvZ3NkLXBrZy1yb290XCI7XG4gICAgY29uc3QgYWdlbnREaXIgPSBcIi90bXAvZ3NkLWFnZW50XCI7XG4gICAgY29uc3QgYmFzZVBhdGggPSBcIi90bXAvcHJvamVjdC1yb290XCI7XG4gICAgY29uc3QgaW1wb3J0czogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBpbml0aWFsaXplZERpcnM6IHN0cmluZ1tdID0gW107XG4gICAgY29uc3Qgb3BlbmVkUHJvamVjdFJvb3RzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGxldCBwcmltZWQgPSBmYWxzZTtcblxuICAgIGF3YWl0IHJlZnJlc2hSZXN1bWVSZXNvdXJjZXNBbmREYihiYXNlUGF0aCwge1xuICAgICAgZW52OiB7XG4gICAgICAgIEdTRF9QS0dfUk9PVDogcGtnUm9vdCxcbiAgICAgICAgR1NEX0NPRElOR19BR0VOVF9ESVI6IGFnZW50RGlyLFxuICAgICAgfSBhcyBOb2RlSlMuUHJvY2Vzc0VudixcbiAgICAgIGltcG9ydE1vZHVsZTogYXN5bmMgKHNwZWNpZmllcjogc3RyaW5nKSA9PiB7XG4gICAgICAgIGltcG9ydHMucHVzaChzcGVjaWZpZXIpO1xuICAgICAgICBpZiAoc3BlY2lmaWVyLmVuZHNXaXRoKFwicmVzb3VyY2UtbG9hZGVyLmpzXCIpKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGluaXRSZXNvdXJjZXM6IChkaXI6IHN0cmluZykgPT4gaW5pdGlhbGl6ZWREaXJzLnB1c2goZGlyKSxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIGlmIChzcGVjaWZpZXIgPT09IFwiLi9wcm9tcHQtbG9hZGVyLmpzXCIpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgcHJpbWVDYWNoZTogKCkgPT4ge1xuICAgICAgICAgICAgICBwcmltZWQgPSB0cnVlO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5leHBlY3RlZCBpbXBvcnQgJHtzcGVjaWZpZXJ9YCk7XG4gICAgICB9LFxuICAgICAgb3BlblByb2plY3REYjogYXN5bmMgKHByb2plY3RSb290OiBzdHJpbmcpID0+IHtcbiAgICAgICAgb3BlbmVkUHJvamVjdFJvb3RzLnB1c2gocHJvamVjdFJvb3QpO1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChpbXBvcnRzWzBdLCBwYXRoVG9GaWxlVVJMKGpvaW4ocGtnUm9vdCwgXCJkaXN0XCIsIFwicmVzb3VyY2UtbG9hZGVyLmpzXCIpKS5ocmVmKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGluaXRpYWxpemVkRGlycywgW2FnZW50RGlyXSk7XG4gICAgYXNzZXJ0LmVxdWFsKHByaW1lZCwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChvcGVuZWRQcm9qZWN0Um9vdHMsIFtiYXNlUGF0aF0pO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsWUFBWTtBQUNyQixTQUFTLHFCQUFxQjtBQUM5QixTQUFTLG1DQUFtQztBQUU1QyxTQUFTLCtCQUErQixNQUFNO0FBQzVDLE9BQUssMEVBQTBFLFlBQVk7QUFDekYsVUFBTSxVQUFVO0FBQ2hCLFVBQU0sV0FBVztBQUNqQixVQUFNLFdBQVc7QUFDakIsVUFBTSxVQUFvQixDQUFDO0FBQzNCLFVBQU0sa0JBQTRCLENBQUM7QUFDbkMsVUFBTSxxQkFBK0IsQ0FBQztBQUN0QyxRQUFJLFNBQVM7QUFFYixVQUFNLDRCQUE0QixVQUFVO0FBQUEsTUFDMUMsS0FBSztBQUFBLFFBQ0gsY0FBYztBQUFBLFFBQ2Qsc0JBQXNCO0FBQUEsTUFDeEI7QUFBQSxNQUNBLGNBQWMsT0FBTyxjQUFzQjtBQUN6QyxnQkFBUSxLQUFLLFNBQVM7QUFDdEIsWUFBSSxVQUFVLFNBQVMsb0JBQW9CLEdBQUc7QUFDNUMsaUJBQU87QUFBQSxZQUNMLGVBQWUsQ0FBQyxRQUFnQixnQkFBZ0IsS0FBSyxHQUFHO0FBQUEsVUFDMUQ7QUFBQSxRQUNGO0FBQ0EsWUFBSSxjQUFjLHNCQUFzQjtBQUN0QyxpQkFBTztBQUFBLFlBQ0wsWUFBWSxNQUFNO0FBQ2hCLHVCQUFTO0FBQUEsWUFDWDtBQUFBLFVBQ0Y7QUFBQSxRQUNGO0FBQ0EsY0FBTSxJQUFJLE1BQU0scUJBQXFCLFNBQVMsRUFBRTtBQUFBLE1BQ2xEO0FBQUEsTUFDQSxlQUFlLE9BQU8sZ0JBQXdCO0FBQzVDLDJCQUFtQixLQUFLLFdBQVc7QUFBQSxNQUNyQztBQUFBLElBQ0YsQ0FBQztBQUVELFdBQU8sTUFBTSxRQUFRLENBQUMsR0FBRyxjQUFjLEtBQUssU0FBUyxRQUFRLG9CQUFvQixDQUFDLEVBQUUsSUFBSTtBQUN4RixXQUFPLFVBQVUsaUJBQWlCLENBQUMsUUFBUSxDQUFDO0FBQzVDLFdBQU8sTUFBTSxRQUFRLElBQUk7QUFDekIsV0FBTyxVQUFVLG9CQUFvQixDQUFDLFFBQVEsQ0FBQztBQUFBLEVBQ2pELENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
