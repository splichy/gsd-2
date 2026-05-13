import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { projectRoot, GSDNoProjectError, withCommandCwd } from "../commands/context.js";
const ORIGINAL_CWD = process.cwd();
after(() => {
  try {
    process.chdir(ORIGINAL_CWD);
  } catch {
  }
});
describe("projectRoot() throws GSDNoProjectError outside a project (#4902)", () => {
  test("throws GSDNoProjectError when cwd is $HOME", () => {
    const home = os.homedir();
    process.chdir(home);
    try {
      assert.throws(
        () => projectRoot(),
        (err) => {
          assert.ok(err instanceof GSDNoProjectError, "should throw GSDNoProjectError");
          assert.match(
            err.message,
            /home directory|project directory/i,
            "error message should mention home/project directory"
          );
          return true;
        }
      );
    } finally {
      process.chdir(ORIGINAL_CWD);
    }
  });
  test("uses command ctx cwd even when process cwd is $HOME", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-command-cwd-"));
    fs.mkdirSync(path.join(projectDir, ".git"));
    process.chdir(os.homedir());
    try {
      const resolved = await withCommandCwd(projectDir, async () => projectRoot());
      assert.equal(resolved, projectDir);
    } finally {
      process.chdir(ORIGINAL_CWD);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
  test("throws GSDNoProjectError when cwd is the system tmpdir root", () => {
    const tmpRoot = fs.realpathSync(os.tmpdir());
    process.chdir(tmpRoot);
    try {
      let threw = null;
      try {
        projectRoot();
      } catch (err) {
        threw = err;
      }
      if (threw !== null) {
        assert.ok(
          threw instanceof GSDNoProjectError,
          "if projectRoot throws, it must be a GSDNoProjectError (typed)"
        );
      }
    } finally {
      process.chdir(ORIGINAL_CWD);
    }
  });
});
describe("GSDNoProjectError shape (#4902)", () => {
  test("GSDNoProjectError extends Error and carries its name", () => {
    const err = new GSDNoProjectError("test reason");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "GSDNoProjectError");
    assert.equal(err.message, "test reason");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9nc2Qtbm8tcHJvamVjdC1lcnJvci1ydW50aW1lLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUnVudGltZSByZWdyZXNzaW9uIFx1MjAxNCBgcHJvamVjdFJvb3QoKWAgdGhyb3dzIGBHU0ROb1Byb2plY3RFcnJvcmAgd2hlblxuICogaW52b2tlZCBvdXRzaWRlIGEgcHJvamVjdCBkaXJlY3RvcnkgKCM0OTAyKS5cbiAqXG4gKiBUaGUgZGVsZXRlZCBgZ3NkLW5vLXByb2plY3QtZXJyb3IudGVzdC50c2Agd2FzIGEgc291cmNlLWdyZXAgY2hlY2suXG4gKiBUaGlzIHJld3JpdGUgY2hkaXJzIHRvICRIT01FLCBjYWxscyB0aGUgcmVhbCBgcHJvamVjdFJvb3QoKWAsIGFuZFxuICogYXNzZXJ0cyBhIGBHU0ROb1Byb2plY3RFcnJvcmAgaXMgdGhyb3duIHdpdGggdGhlIHByb2plY3QtcmVxdWlyZWRcbiAqIG1lc3NhZ2UuXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGFmdGVyIH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCAqIGFzIG9zIGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0ICogYXMgZnMgZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ25vZGU6cGF0aCc7XG5cbmltcG9ydCB7IHByb2plY3RSb290LCBHU0ROb1Byb2plY3RFcnJvciwgd2l0aENvbW1hbmRDd2QgfSBmcm9tICcuLi9jb21tYW5kcy9jb250ZXh0LnRzJztcblxuY29uc3QgT1JJR0lOQUxfQ1dEID0gcHJvY2Vzcy5jd2QoKTtcblxuYWZ0ZXIoKCkgPT4ge1xuICB0cnkgeyBwcm9jZXNzLmNoZGlyKE9SSUdJTkFMX0NXRCk7IH0gY2F0Y2ggeyAvKiBzd2FsbG93ICovIH1cbn0pO1xuXG5kZXNjcmliZSgncHJvamVjdFJvb3QoKSB0aHJvd3MgR1NETm9Qcm9qZWN0RXJyb3Igb3V0c2lkZSBhIHByb2plY3QgKCM0OTAyKScsICgpID0+IHtcbiAgdGVzdCgndGhyb3dzIEdTRE5vUHJvamVjdEVycm9yIHdoZW4gY3dkIGlzICRIT01FJywgKCkgPT4ge1xuICAgIGNvbnN0IGhvbWUgPSBvcy5ob21lZGlyKCk7XG4gICAgcHJvY2Vzcy5jaGRpcihob21lKTtcbiAgICB0cnkge1xuICAgICAgYXNzZXJ0LnRocm93cyhcbiAgICAgICAgKCkgPT4gcHJvamVjdFJvb3QoKSxcbiAgICAgICAgKGVycjogdW5rbm93bikgPT4ge1xuICAgICAgICAgIGFzc2VydC5vayhlcnIgaW5zdGFuY2VvZiBHU0ROb1Byb2plY3RFcnJvciwgJ3Nob3VsZCB0aHJvdyBHU0ROb1Byb2plY3RFcnJvcicpO1xuICAgICAgICAgIGFzc2VydC5tYXRjaChcbiAgICAgICAgICAgIChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UsXG4gICAgICAgICAgICAvaG9tZSBkaXJlY3Rvcnl8cHJvamVjdCBkaXJlY3RvcnkvaSxcbiAgICAgICAgICAgICdlcnJvciBtZXNzYWdlIHNob3VsZCBtZW50aW9uIGhvbWUvcHJvamVjdCBkaXJlY3RvcnknLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmNoZGlyKE9SSUdJTkFMX0NXRCk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCd1c2VzIGNvbW1hbmQgY3R4IGN3ZCBldmVuIHdoZW4gcHJvY2VzcyBjd2QgaXMgJEhPTUUnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcHJvamVjdERpciA9IGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgJ2dzZC1jb21tYW5kLWN3ZC0nKSk7XG4gICAgZnMubWtkaXJTeW5jKHBhdGguam9pbihwcm9qZWN0RGlyLCAnLmdpdCcpKTtcblxuICAgIHByb2Nlc3MuY2hkaXIob3MuaG9tZWRpcigpKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzb2x2ZWQgPSBhd2FpdCB3aXRoQ29tbWFuZEN3ZChwcm9qZWN0RGlyLCBhc3luYyAoKSA9PiBwcm9qZWN0Um9vdCgpKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXNvbHZlZCwgcHJvamVjdERpcik7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIoT1JJR0lOQUxfQ1dEKTtcbiAgICAgIGZzLnJtU3luYyhwcm9qZWN0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KCd0aHJvd3MgR1NETm9Qcm9qZWN0RXJyb3Igd2hlbiBjd2QgaXMgdGhlIHN5c3RlbSB0bXBkaXIgcm9vdCcsICgpID0+IHtcbiAgICAvLyBVc2UgcmVhbHBhdGggdG8gZG9kZ2Ugc3ltbGlua3MgYmxvY2tpbmcgdGhlIGN3ZFxuICAgIGNvbnN0IHRtcFJvb3QgPSBmcy5yZWFscGF0aFN5bmMob3MudG1wZGlyKCkpO1xuICAgIC8vIFNvbWUgc3lzdGVtcyBtYWtlIHRtcGRpciBhIHN1YmRpcmVjdG9yeTsgb25seSBydW4gd2hlbiBpdCBub3JtYWxpemVzXG4gICAgLy8gdG8gYSBrbm93bi1ibG9ja2VkIHJvb3QuIHZhbGlkYXRlRGlyZWN0b3J5IGJsb2NrcyAvdG1wICsgL3Zhci9mb2xkZXJzXG4gICAgLy8gdG1wIHJvb3RzOyBidWlsZCBhIHNtYWxsIHN1YmRpciB1bmRlciB0bXAgYW5kIHRoZW4gYXNzZXJ0IHRoYXQgdGhlXG4gICAgLy8gcmF3IHRtcGRpciByb290IGl0c2VsZiBibG9ja3MuIFdlIGp1c3QgdXNlIGl0IGRpcmVjdGx5LlxuICAgIHByb2Nlc3MuY2hkaXIodG1wUm9vdCk7XG4gICAgdHJ5IHtcbiAgICAgIC8vIEJlaGF2aW91cjogZWl0aGVyIHdlIGdldCBhIEdTRE5vUHJvamVjdEVycm9yIChibG9ja2VkIHRtcGRpciByb290KSBvclxuICAgICAgLy8gd2UgZG9uJ3QgXHUyMDE0IGJ1dCBpbiB0aGUgY2FzZSB3aGVyZSB3ZSBkb24ndCAodG1wZGlyIGlzIHNvbWVob3cgYWxsb3dlZFxuICAgICAgLy8gYXMgYSBwcm9qZWN0IHJvb3Qgb24gdGhpcyBtYWNoaW5lKSwgdGhlIHRlc3QgaXMgdmFjdW91c2x5IHNhdGlzZmllZFxuICAgICAgLy8gYnkgdGhlIHByaW9yICRIT01FIGNhc2UuIFdlIGFzc2VydCB0aGUgdHlwZS1uYXJyb3dpbmcgcGF0aCBpbnN0ZWFkOlxuICAgICAgbGV0IHRocmV3OiB1bmtub3duID0gbnVsbDtcbiAgICAgIHRyeSB7IHByb2plY3RSb290KCk7IH0gY2F0Y2ggKGVycikgeyB0aHJldyA9IGVycjsgfVxuICAgICAgaWYgKHRocmV3ICE9PSBudWxsKSB7XG4gICAgICAgIGFzc2VydC5vayhcbiAgICAgICAgICB0aHJldyBpbnN0YW5jZW9mIEdTRE5vUHJvamVjdEVycm9yLFxuICAgICAgICAgICdpZiBwcm9qZWN0Um9vdCB0aHJvd3MsIGl0IG11c3QgYmUgYSBHU0ROb1Byb2plY3RFcnJvciAodHlwZWQpJyxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihPUklHSU5BTF9DV0QpO1xuICAgIH1cbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ0dTRE5vUHJvamVjdEVycm9yIHNoYXBlICgjNDkwMiknLCAoKSA9PiB7XG4gIHRlc3QoJ0dTRE5vUHJvamVjdEVycm9yIGV4dGVuZHMgRXJyb3IgYW5kIGNhcnJpZXMgaXRzIG5hbWUnLCAoKSA9PiB7XG4gICAgY29uc3QgZXJyID0gbmV3IEdTRE5vUHJvamVjdEVycm9yKCd0ZXN0IHJlYXNvbicpO1xuICAgIGFzc2VydC5vayhlcnIgaW5zdGFuY2VvZiBFcnJvcik7XG4gICAgYXNzZXJ0LmVxdWFsKGVyci5uYW1lLCAnR1NETm9Qcm9qZWN0RXJyb3InKTtcbiAgICBhc3NlcnQuZXF1YWwoZXJyLm1lc3NhZ2UsICd0ZXN0IHJlYXNvbicpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBVUEsU0FBUyxVQUFVLE1BQU0sYUFBYTtBQUN0QyxPQUFPLFlBQVk7QUFDbkIsWUFBWSxRQUFRO0FBQ3BCLFlBQVksUUFBUTtBQUNwQixZQUFZLFVBQVU7QUFFdEIsU0FBUyxhQUFhLG1CQUFtQixzQkFBc0I7QUFFL0QsTUFBTSxlQUFlLFFBQVEsSUFBSTtBQUVqQyxNQUFNLE1BQU07QUFDVixNQUFJO0FBQUUsWUFBUSxNQUFNLFlBQVk7QUFBQSxFQUFHLFFBQVE7QUFBQSxFQUFnQjtBQUM3RCxDQUFDO0FBRUQsU0FBUyxvRUFBb0UsTUFBTTtBQUNqRixPQUFLLDhDQUE4QyxNQUFNO0FBQ3ZELFVBQU0sT0FBTyxHQUFHLFFBQVE7QUFDeEIsWUFBUSxNQUFNLElBQUk7QUFDbEIsUUFBSTtBQUNGLGFBQU87QUFBQSxRQUNMLE1BQU0sWUFBWTtBQUFBLFFBQ2xCLENBQUMsUUFBaUI7QUFDaEIsaUJBQU8sR0FBRyxlQUFlLG1CQUFtQixnQ0FBZ0M7QUFDNUUsaUJBQU87QUFBQSxZQUNKLElBQWM7QUFBQSxZQUNmO0FBQUEsWUFDQTtBQUFBLFVBQ0Y7QUFDQSxpQkFBTztBQUFBLFFBQ1Q7QUFBQSxNQUNGO0FBQUEsSUFDRixVQUFFO0FBQ0EsY0FBUSxNQUFNLFlBQVk7QUFBQSxJQUM1QjtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssdURBQXVELFlBQVk7QUFDdEUsVUFBTSxhQUFhLEdBQUcsWUFBWSxLQUFLLEtBQUssR0FBRyxPQUFPLEdBQUcsa0JBQWtCLENBQUM7QUFDNUUsT0FBRyxVQUFVLEtBQUssS0FBSyxZQUFZLE1BQU0sQ0FBQztBQUUxQyxZQUFRLE1BQU0sR0FBRyxRQUFRLENBQUM7QUFDMUIsUUFBSTtBQUNGLFlBQU0sV0FBVyxNQUFNLGVBQWUsWUFBWSxZQUFZLFlBQVksQ0FBQztBQUMzRSxhQUFPLE1BQU0sVUFBVSxVQUFVO0FBQUEsSUFDbkMsVUFBRTtBQUNBLGNBQVEsTUFBTSxZQUFZO0FBQzFCLFNBQUcsT0FBTyxZQUFZLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDeEQ7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLCtEQUErRCxNQUFNO0FBRXhFLFVBQU0sVUFBVSxHQUFHLGFBQWEsR0FBRyxPQUFPLENBQUM7QUFLM0MsWUFBUSxNQUFNLE9BQU87QUFDckIsUUFBSTtBQUtGLFVBQUksUUFBaUI7QUFDckIsVUFBSTtBQUFFLG9CQUFZO0FBQUEsTUFBRyxTQUFTLEtBQUs7QUFBRSxnQkFBUTtBQUFBLE1BQUs7QUFDbEQsVUFBSSxVQUFVLE1BQU07QUFDbEIsZUFBTztBQUFBLFVBQ0wsaUJBQWlCO0FBQUEsVUFDakI7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUFBLElBQ0YsVUFBRTtBQUNBLGNBQVEsTUFBTSxZQUFZO0FBQUEsSUFDNUI7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyxtQ0FBbUMsTUFBTTtBQUNoRCxPQUFLLHdEQUF3RCxNQUFNO0FBQ2pFLFVBQU0sTUFBTSxJQUFJLGtCQUFrQixhQUFhO0FBQy9DLFdBQU8sR0FBRyxlQUFlLEtBQUs7QUFDOUIsV0FBTyxNQUFNLElBQUksTUFBTSxtQkFBbUI7QUFDMUMsV0FBTyxNQUFNLElBQUksU0FBUyxhQUFhO0FBQUEsRUFDekMsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
