import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const resolveTsPath = join(process.cwd(), "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
test("onboarding claude-cli path persists defaultProvider to settings.json", (t) => {
  const gsdHome = mkdtempSync(join(tmpdir(), "gsd-onboarding-claude-cli-"));
  t.after(() => rmSync(gsdHome, { recursive: true, force: true }));
  execFileSync(
    process.execPath,
    [
      "--import",
      resolveTsPath,
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `
        const { runLlmStep } = await import(${JSON.stringify(join(process.cwd(), "src", "onboarding.ts"))});
        const p = {
          select: async () => "claude-cli",
          isCancel: () => false,
          log: { success() {}, info() {}, warn() {}, step() {} },
          spinner: () => ({ start() {}, stop() {} }),
        };
        const pc = new Proxy({}, { get: () => (value) => value });
        const authStorage = {
          getOAuthProviders: () => [],
          hasAuth: () => false,
          set(provider, value) {
            if (provider !== "claude-code" || value.key !== "cli") throw new Error("claude-code auth sentinel not stored");
          },
        };
        const configured = await runLlmStep(p, pc, authStorage);
        if (!configured) throw new Error("claude-cli onboarding did not complete");
      `
    ],
    { env: { ...process.env, GSD_HOME: gsdHome }, stdio: "pipe" }
  );
  const settings = JSON.parse(readFileSync(join(gsdHome, "agent", "settings.json"), "utf-8"));
  assert.equal(settings.defaultProvider, "claude-code");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL29uYm9hcmRpbmctY2xhdWRlLWNsaS1wcm92aWRlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCJcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiXG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCJcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCJcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCJcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCJcblxuY29uc3QgcmVzb2x2ZVRzUGF0aCA9IGpvaW4ocHJvY2Vzcy5jd2QoKSwgXCJzcmNcIiwgXCJyZXNvdXJjZXNcIiwgXCJleHRlbnNpb25zXCIsIFwiZ3NkXCIsIFwidGVzdHNcIiwgXCJyZXNvbHZlLXRzLm1qc1wiKVxuXG50ZXN0KFwib25ib2FyZGluZyBjbGF1ZGUtY2xpIHBhdGggcGVyc2lzdHMgZGVmYXVsdFByb3ZpZGVyIHRvIHNldHRpbmdzLmpzb25cIiwgKHQpID0+IHtcbiAgY29uc3QgZ3NkSG9tZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLW9uYm9hcmRpbmctY2xhdWRlLWNsaS1cIikpXG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGdzZEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSlcblxuICBleGVjRmlsZVN5bmMoXG4gICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICBbXG4gICAgICBcIi0taW1wb3J0XCIsXG4gICAgICByZXNvbHZlVHNQYXRoLFxuICAgICAgXCItLWV4cGVyaW1lbnRhbC1zdHJpcC10eXBlc1wiLFxuICAgICAgXCItLWlucHV0LXR5cGU9bW9kdWxlXCIsXG4gICAgICBcIi0tZXZhbFwiLFxuICAgICAgYFxuICAgICAgICBjb25zdCB7IHJ1bkxsbVN0ZXAgfSA9IGF3YWl0IGltcG9ydCgke0pTT04uc3RyaW5naWZ5KGpvaW4ocHJvY2Vzcy5jd2QoKSwgXCJzcmNcIiwgXCJvbmJvYXJkaW5nLnRzXCIpKX0pO1xuICAgICAgICBjb25zdCBwID0ge1xuICAgICAgICAgIHNlbGVjdDogYXN5bmMgKCkgPT4gXCJjbGF1ZGUtY2xpXCIsXG4gICAgICAgICAgaXNDYW5jZWw6ICgpID0+IGZhbHNlLFxuICAgICAgICAgIGxvZzogeyBzdWNjZXNzKCkge30sIGluZm8oKSB7fSwgd2FybigpIHt9LCBzdGVwKCkge30gfSxcbiAgICAgICAgICBzcGlubmVyOiAoKSA9PiAoeyBzdGFydCgpIHt9LCBzdG9wKCkge30gfSksXG4gICAgICAgIH07XG4gICAgICAgIGNvbnN0IHBjID0gbmV3IFByb3h5KHt9LCB7IGdldDogKCkgPT4gKHZhbHVlKSA9PiB2YWx1ZSB9KTtcbiAgICAgICAgY29uc3QgYXV0aFN0b3JhZ2UgPSB7XG4gICAgICAgICAgZ2V0T0F1dGhQcm92aWRlcnM6ICgpID0+IFtdLFxuICAgICAgICAgIGhhc0F1dGg6ICgpID0+IGZhbHNlLFxuICAgICAgICAgIHNldChwcm92aWRlciwgdmFsdWUpIHtcbiAgICAgICAgICAgIGlmIChwcm92aWRlciAhPT0gXCJjbGF1ZGUtY29kZVwiIHx8IHZhbHVlLmtleSAhPT0gXCJjbGlcIikgdGhyb3cgbmV3IEVycm9yKFwiY2xhdWRlLWNvZGUgYXV0aCBzZW50aW5lbCBub3Qgc3RvcmVkXCIpO1xuICAgICAgICAgIH0sXG4gICAgICAgIH07XG4gICAgICAgIGNvbnN0IGNvbmZpZ3VyZWQgPSBhd2FpdCBydW5MbG1TdGVwKHAsIHBjLCBhdXRoU3RvcmFnZSk7XG4gICAgICAgIGlmICghY29uZmlndXJlZCkgdGhyb3cgbmV3IEVycm9yKFwiY2xhdWRlLWNsaSBvbmJvYXJkaW5nIGRpZCBub3QgY29tcGxldGVcIik7XG4gICAgICBgLFxuICAgIF0sXG4gICAgeyBlbnY6IHsgLi4ucHJvY2Vzcy5lbnYsIEdTRF9IT01FOiBnc2RIb21lIH0sIHN0ZGlvOiBcInBpcGVcIiB9LFxuICApXG5cbiAgY29uc3Qgc2V0dGluZ3MgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGdzZEhvbWUsIFwiYWdlbnRcIiwgXCJzZXR0aW5ncy5qc29uXCIpLCBcInV0Zi04XCIpKVxuICBhc3NlcnQuZXF1YWwoc2V0dGluZ3MuZGVmYXVsdFByb3ZpZGVyLCBcImNsYXVkZS1jb2RlXCIpXG59KVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLG9CQUFvQjtBQUM3QixTQUFTLGFBQWEsY0FBYyxjQUFjO0FBQ2xELFNBQVMsY0FBYztBQUN2QixTQUFTLFlBQVk7QUFFckIsTUFBTSxnQkFBZ0IsS0FBSyxRQUFRLElBQUksR0FBRyxPQUFPLGFBQWEsY0FBYyxPQUFPLFNBQVMsZ0JBQWdCO0FBRTVHLEtBQUssd0VBQXdFLENBQUMsTUFBTTtBQUNsRixRQUFNLFVBQVUsWUFBWSxLQUFLLE9BQU8sR0FBRyw0QkFBNEIsQ0FBQztBQUN4RSxJQUFFLE1BQU0sTUFBTSxPQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUMsQ0FBQztBQUUvRDtBQUFBLElBQ0UsUUFBUTtBQUFBLElBQ1I7QUFBQSxNQUNFO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSw4Q0FDd0MsS0FBSyxVQUFVLEtBQUssUUFBUSxJQUFJLEdBQUcsT0FBTyxlQUFlLENBQUMsQ0FBQztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQWtCckc7QUFBQSxJQUNBLEVBQUUsS0FBSyxFQUFFLEdBQUcsUUFBUSxLQUFLLFVBQVUsUUFBUSxHQUFHLE9BQU8sT0FBTztBQUFBLEVBQzlEO0FBRUEsUUFBTSxXQUFXLEtBQUssTUFBTSxhQUFhLEtBQUssU0FBUyxTQUFTLGVBQWUsR0FBRyxPQUFPLENBQUM7QUFDMUYsU0FBTyxNQUFNLFNBQVMsaUJBQWlCLGFBQWE7QUFDdEQsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
