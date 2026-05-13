import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const resolveTsPath = join(process.cwd(), "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
function runOnboardingFlow(gsdHome, answers) {
  execFileSync(
    process.execPath,
    [
      "--import",
      resolveTsPath,
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `
        const answers = ${JSON.stringify(answers)};
        const { runLlmStep } = await import(${JSON.stringify(join(process.cwd(), "src", "onboarding.ts"))});
        const p = {
          select: async () => answers.shift(),
          password: async () => answers.shift(),
          text: async () => answers.shift() ?? "",
          isCancel: () => false,
          log: { success() {}, info() {}, warn() {}, step() {} },
          spinner: () => ({ start() {}, stop() {} }),
        };
        const pc = new Proxy({}, { get: () => (value) => value });
        const authStorage = {
          getOAuthProviders: () => [{ id: "openai-codex", name: "OpenAI Codex", usesCallbackServer: false }],
          hasAuth: () => false,
          async login(providerId) {
            if (providerId !== "openai-codex") throw new Error("unexpected OAuth provider " + providerId);
          },
          set(providerId, value) {
            if (!providerId || !value?.key) throw new Error("api-key auth not stored");
          },
        };
        const configured = await runLlmStep(p, pc, authStorage);
        if (!configured) throw new Error("onboarding flow did not complete");
      `
    ],
    { env: { ...process.env, GSD_HOME: gsdHome }, stdio: "pipe" }
  );
}
test("onboarding persists defaultProvider for OAuth flow", (t) => {
  const gsdHome = mkdtempSync(join(tmpdir(), "gsd-onboarding-oauth-"));
  t.after(() => rmSync(gsdHome, { recursive: true, force: true }));
  runOnboardingFlow(gsdHome, ["browser", "openai-codex"]);
  const settings = JSON.parse(readFileSync(join(gsdHome, "agent", "settings.json"), "utf-8"));
  assert.equal(settings.defaultProvider, "openai-codex");
});
test("onboarding persists defaultProvider for API-key flow", (t) => {
  const gsdHome = mkdtempSync(join(tmpdir(), "gsd-onboarding-api-key-"));
  t.after(() => rmSync(gsdHome, { recursive: true, force: true }));
  runOnboardingFlow(gsdHome, ["api-key", "openai", "sk-test"]);
  const settings = JSON.parse(readFileSync(join(gsdHome, "agent", "settings.json"), "utf-8"));
  assert.equal(settings.defaultProvider, "openai");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL29uYm9hcmRpbmctZGVmYXVsdC1wcm92aWRlci1wZXJzaXN0ZW5jZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCJcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiXG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCJcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCJcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCJcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCJcblxuY29uc3QgcmVzb2x2ZVRzUGF0aCA9IGpvaW4ocHJvY2Vzcy5jd2QoKSwgXCJzcmNcIiwgXCJyZXNvdXJjZXNcIiwgXCJleHRlbnNpb25zXCIsIFwiZ3NkXCIsIFwidGVzdHNcIiwgXCJyZXNvbHZlLXRzLm1qc1wiKVxuXG5mdW5jdGlvbiBydW5PbmJvYXJkaW5nRmxvdyhnc2RIb21lOiBzdHJpbmcsIGFuc3dlcnM6IHN0cmluZ1tdKTogdm9pZCB7XG4gIGV4ZWNGaWxlU3luYyhcbiAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgIFtcbiAgICAgIFwiLS1pbXBvcnRcIixcbiAgICAgIHJlc29sdmVUc1BhdGgsXG4gICAgICBcIi0tZXhwZXJpbWVudGFsLXN0cmlwLXR5cGVzXCIsXG4gICAgICBcIi0taW5wdXQtdHlwZT1tb2R1bGVcIixcbiAgICAgIFwiLS1ldmFsXCIsXG4gICAgICBgXG4gICAgICAgIGNvbnN0IGFuc3dlcnMgPSAke0pTT04uc3RyaW5naWZ5KGFuc3dlcnMpfTtcbiAgICAgICAgY29uc3QgeyBydW5MbG1TdGVwIH0gPSBhd2FpdCBpbXBvcnQoJHtKU09OLnN0cmluZ2lmeShqb2luKHByb2Nlc3MuY3dkKCksIFwic3JjXCIsIFwib25ib2FyZGluZy50c1wiKSl9KTtcbiAgICAgICAgY29uc3QgcCA9IHtcbiAgICAgICAgICBzZWxlY3Q6IGFzeW5jICgpID0+IGFuc3dlcnMuc2hpZnQoKSxcbiAgICAgICAgICBwYXNzd29yZDogYXN5bmMgKCkgPT4gYW5zd2Vycy5zaGlmdCgpLFxuICAgICAgICAgIHRleHQ6IGFzeW5jICgpID0+IGFuc3dlcnMuc2hpZnQoKSA/PyBcIlwiLFxuICAgICAgICAgIGlzQ2FuY2VsOiAoKSA9PiBmYWxzZSxcbiAgICAgICAgICBsb2c6IHsgc3VjY2VzcygpIHt9LCBpbmZvKCkge30sIHdhcm4oKSB7fSwgc3RlcCgpIHt9IH0sXG4gICAgICAgICAgc3Bpbm5lcjogKCkgPT4gKHsgc3RhcnQoKSB7fSwgc3RvcCgpIHt9IH0pLFxuICAgICAgICB9O1xuICAgICAgICBjb25zdCBwYyA9IG5ldyBQcm94eSh7fSwgeyBnZXQ6ICgpID0+ICh2YWx1ZSkgPT4gdmFsdWUgfSk7XG4gICAgICAgIGNvbnN0IGF1dGhTdG9yYWdlID0ge1xuICAgICAgICAgIGdldE9BdXRoUHJvdmlkZXJzOiAoKSA9PiBbeyBpZDogXCJvcGVuYWktY29kZXhcIiwgbmFtZTogXCJPcGVuQUkgQ29kZXhcIiwgdXNlc0NhbGxiYWNrU2VydmVyOiBmYWxzZSB9XSxcbiAgICAgICAgICBoYXNBdXRoOiAoKSA9PiBmYWxzZSxcbiAgICAgICAgICBhc3luYyBsb2dpbihwcm92aWRlcklkKSB7XG4gICAgICAgICAgICBpZiAocHJvdmlkZXJJZCAhPT0gXCJvcGVuYWktY29kZXhcIikgdGhyb3cgbmV3IEVycm9yKFwidW5leHBlY3RlZCBPQXV0aCBwcm92aWRlciBcIiArIHByb3ZpZGVySWQpO1xuICAgICAgICAgIH0sXG4gICAgICAgICAgc2V0KHByb3ZpZGVySWQsIHZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoIXByb3ZpZGVySWQgfHwgIXZhbHVlPy5rZXkpIHRocm93IG5ldyBFcnJvcihcImFwaS1rZXkgYXV0aCBub3Qgc3RvcmVkXCIpO1xuICAgICAgICAgIH0sXG4gICAgICAgIH07XG4gICAgICAgIGNvbnN0IGNvbmZpZ3VyZWQgPSBhd2FpdCBydW5MbG1TdGVwKHAsIHBjLCBhdXRoU3RvcmFnZSk7XG4gICAgICAgIGlmICghY29uZmlndXJlZCkgdGhyb3cgbmV3IEVycm9yKFwib25ib2FyZGluZyBmbG93IGRpZCBub3QgY29tcGxldGVcIik7XG4gICAgICBgLFxuICAgIF0sXG4gICAgeyBlbnY6IHsgLi4ucHJvY2Vzcy5lbnYsIEdTRF9IT01FOiBnc2RIb21lIH0sIHN0ZGlvOiBcInBpcGVcIiB9LFxuICApXG59XG5cbnRlc3QoXCJvbmJvYXJkaW5nIHBlcnNpc3RzIGRlZmF1bHRQcm92aWRlciBmb3IgT0F1dGggZmxvd1wiLCAodCkgPT4ge1xuICBjb25zdCBnc2RIb21lID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtb25ib2FyZGluZy1vYXV0aC1cIikpXG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGdzZEhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSlcblxuICBydW5PbmJvYXJkaW5nRmxvdyhnc2RIb21lLCBbXCJicm93c2VyXCIsIFwib3BlbmFpLWNvZGV4XCJdKVxuXG4gIGNvbnN0IHNldHRpbmdzID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihnc2RIb21lLCBcImFnZW50XCIsIFwic2V0dGluZ3MuanNvblwiKSwgXCJ1dGYtOFwiKSlcbiAgYXNzZXJ0LmVxdWFsKHNldHRpbmdzLmRlZmF1bHRQcm92aWRlciwgXCJvcGVuYWktY29kZXhcIilcbn0pXG5cbnRlc3QoXCJvbmJvYXJkaW5nIHBlcnNpc3RzIGRlZmF1bHRQcm92aWRlciBmb3IgQVBJLWtleSBmbG93XCIsICh0KSA9PiB7XG4gIGNvbnN0IGdzZEhvbWUgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1vbmJvYXJkaW5nLWFwaS1rZXktXCIpKVxuICB0LmFmdGVyKCgpID0+IHJtU3luYyhnc2RIb21lLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpXG5cbiAgcnVuT25ib2FyZGluZ0Zsb3coZ3NkSG9tZSwgW1wiYXBpLWtleVwiLCBcIm9wZW5haVwiLCBcInNrLXRlc3RcIl0pXG5cbiAgY29uc3Qgc2V0dGluZ3MgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGdzZEhvbWUsIFwiYWdlbnRcIiwgXCJzZXR0aW5ncy5qc29uXCIpLCBcInV0Zi04XCIpKVxuICBhc3NlcnQuZXF1YWwoc2V0dGluZ3MuZGVmYXVsdFByb3ZpZGVyLCBcIm9wZW5haVwiKVxufSlcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxhQUFhLGNBQWMsY0FBYztBQUNsRCxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBRXJCLE1BQU0sZ0JBQWdCLEtBQUssUUFBUSxJQUFJLEdBQUcsT0FBTyxhQUFhLGNBQWMsT0FBTyxTQUFTLGdCQUFnQjtBQUU1RyxTQUFTLGtCQUFrQixTQUFpQixTQUF5QjtBQUNuRTtBQUFBLElBQ0UsUUFBUTtBQUFBLElBQ1I7QUFBQSxNQUNFO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSwwQkFDb0IsS0FBSyxVQUFVLE9BQU8sQ0FBQztBQUFBLDhDQUNILEtBQUssVUFBVSxLQUFLLFFBQVEsSUFBSSxHQUFHLE9BQU8sZUFBZSxDQUFDLENBQUM7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBdUJyRztBQUFBLElBQ0EsRUFBRSxLQUFLLEVBQUUsR0FBRyxRQUFRLEtBQUssVUFBVSxRQUFRLEdBQUcsT0FBTyxPQUFPO0FBQUEsRUFDOUQ7QUFDRjtBQUVBLEtBQUssc0RBQXNELENBQUMsTUFBTTtBQUNoRSxRQUFNLFVBQVUsWUFBWSxLQUFLLE9BQU8sR0FBRyx1QkFBdUIsQ0FBQztBQUNuRSxJQUFFLE1BQU0sTUFBTSxPQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUMsQ0FBQztBQUUvRCxvQkFBa0IsU0FBUyxDQUFDLFdBQVcsY0FBYyxDQUFDO0FBRXRELFFBQU0sV0FBVyxLQUFLLE1BQU0sYUFBYSxLQUFLLFNBQVMsU0FBUyxlQUFlLEdBQUcsT0FBTyxDQUFDO0FBQzFGLFNBQU8sTUFBTSxTQUFTLGlCQUFpQixjQUFjO0FBQ3ZELENBQUM7QUFFRCxLQUFLLHdEQUF3RCxDQUFDLE1BQU07QUFDbEUsUUFBTSxVQUFVLFlBQVksS0FBSyxPQUFPLEdBQUcseUJBQXlCLENBQUM7QUFDckUsSUFBRSxNQUFNLE1BQU0sT0FBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDLENBQUM7QUFFL0Qsb0JBQWtCLFNBQVMsQ0FBQyxXQUFXLFVBQVUsU0FBUyxDQUFDO0FBRTNELFFBQU0sV0FBVyxLQUFLLE1BQU0sYUFBYSxLQUFLLFNBQVMsU0FBUyxlQUFlLEdBQUcsT0FBTyxDQUFDO0FBQzFGLFNBQU8sTUFBTSxTQUFTLGlCQUFpQixRQUFRO0FBQ2pELENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
