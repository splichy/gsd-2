import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const projectRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");
function assertExtensionIndexExists(agentDir, extensionName) {
  assert.ok(
    existsSync(join(agentDir, "extensions", extensionName, "index.js")) || existsSync(join(agentDir, "extensions", extensionName, "index.ts")),
    `${extensionName} extension synced`
  );
}
test("app-paths resolve to ~/.gsd/", async () => {
  const { appRoot, agentDir, sessionsDir, authFilePath } = await import("../app-paths.js");
  const { homedir } = await import("node:os");
  const home = homedir();
  assert.equal(appRoot, join(home, ".gsd"), "appRoot is ~/.gsd/");
  assert.equal(agentDir, join(home, ".gsd", "agent"), "agentDir is ~/.gsd/agent/");
  assert.equal(sessionsDir, join(home, ".gsd", "sessions"), "sessionsDir is ~/.gsd/sessions/");
  assert.equal(authFilePath, join(home, ".gsd", "agent", "auth.json"), "authFilePath is ~/.gsd/agent/auth.json");
});
test("loader sets all 4 GSD_ env vars and PI_PACKAGE_DIR", async (t) => {
  const script = `
    import { fileURLToPath } from 'url';
    import { dirname, resolve, join, delimiter } from 'path';
    import { agentDir } from './app-paths.js';

    const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pkg');
    process.env.PI_PACKAGE_DIR = pkgDir;
    process.env.GSD_CODING_AGENT_DIR = agentDir;
    process.env.GSD_BIN_PATH = process.argv[1];
    const resourcesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'resources');
    process.env.GSD_WORKFLOW_PATH = join(resourcesDir, 'GSD-WORKFLOW.md');
    const exts = ['extensions/gsd/index.ts'].map(r => join(resourcesDir, r));
    process.env.GSD_BUNDLED_EXTENSION_PATHS = exts.join(delimiter);

    // Print for verification
    console.log('PI_PACKAGE_DIR=' + process.env.PI_PACKAGE_DIR);
    console.log('GSD_CODING_AGENT_DIR=' + process.env.GSD_CODING_AGENT_DIR);
    console.log('GSD_BIN_PATH=' + process.env.GSD_BIN_PATH);
    console.log('GSD_WORKFLOW_PATH=' + process.env.GSD_WORKFLOW_PATH);
    console.log('GSD_BUNDLED_EXTENSION_PATHS=' + process.env.GSD_BUNDLED_EXTENSION_PATHS);
    process.exit(0);
  `;
  const tmp = mkdtempSync(join(tmpdir(), "gsd-loader-test-"));
  const scriptPath = join(tmp, "check-env.ts");
  writeFileSync(scriptPath, script);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  try {
    const output = execSync(
      `node --experimental-strip-types -e "
      process.chdir('${projectRoot}');
      await import('./src/app-paths.js');
    " 2>&1`,
      { encoding: "utf-8", cwd: projectRoot }
    );
  } catch {
  }
  const { agentDir: ad } = await import("../app-paths.js");
  assert.ok(ad.endsWith(join(".gsd", "agent")), "agentDir ends with .gsd/agent");
  const { discoverExtensionEntryPaths } = await import("../extension-discovery.js");
  const bundledExtensionsDir = join(projectRoot, existsSync(join(projectRoot, "dist", "resources")) ? "dist" : "src", "resources", "extensions");
  const discovered = discoverExtensionEntryPaths(bundledExtensionsDir);
  assert.ok(discovered.length >= 10, `expected >=10 extensions, found ${discovered.length}`);
  const discoveredNames = discovered.map((p) => {
    const rel = p.slice(bundledExtensionsDir.length + 1);
    return rel.split(/[\\/]/)[0].replace(/\.(?:ts|js)$/, "");
  });
  for (const core of ["gsd", "bg-shell", "browser-tools", "subagent", "search-the-web"]) {
    assert.ok(discoveredNames.includes(core), `core extension '${core}' is discoverable`);
  }
  rmSync(tmp, { recursive: true, force: true });
});
test("checkNodeVersion rejects below-minimum versions and accepts at-or-above", async () => {
  const { checkNodeVersion, MIN_NODE_MAJOR } = await import("../runtime-checks.js");
  const tooOld = checkNodeVersion("18.19.0", MIN_NODE_MAJOR);
  assert.strictEqual(tooOld.ok, false, "Node 18 must be rejected when min is 22+");
  if (tooOld.ok === false) {
    assert.strictEqual(tooOld.actualMajor, 18, "reports actual major from input");
  }
  const exactlyMin = checkNodeVersion(`${MIN_NODE_MAJOR}.0.0`, MIN_NODE_MAJOR);
  assert.strictEqual(exactlyMin.ok, true, "version equal to minimum must be accepted");
  const above = checkNodeVersion(`${MIN_NODE_MAJOR + 5}.10.2`, MIN_NODE_MAJOR);
  assert.strictEqual(above.ok, true, "version above minimum must be accepted");
  assert.throws(() => checkNodeVersion("not-a-version", MIN_NODE_MAJOR), /cannot parse major/);
});
test("requireGit returns false when exec throws and true when it succeeds", async () => {
  const { requireGit } = await import("../runtime-checks.js");
  let calls = [];
  const throwingExec = (cmd, args) => {
    calls.push({ cmd, args });
    throw new Error("ENOENT: git not found");
  };
  assert.strictEqual(requireGit(throwingExec), false, "must return false when exec throws");
  assert.strictEqual(calls.length, 1, "exec invoked exactly once");
  assert.strictEqual(calls[0].cmd, "git", "invokes 'git' specifically");
  assert.deepStrictEqual([...calls[0].args], ["--version"], "passes ['--version']");
  calls = [];
  const okExec = (cmd, args) => {
    calls.push({ cmd, args });
    return Buffer.from("git version 2.40.0\n");
  };
  assert.strictEqual(requireGit(okExec), true, "must return true when exec succeeds");
  assert.strictEqual(calls.length, 1, "success path also invokes exec exactly once");
});
test("loader MIN_NODE_MAJOR matches package.json engines field exactly", async () => {
  const { MIN_NODE_MAJOR } = await import("../runtime-checks.js");
  const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
  const engineRange = pkg.engines?.node ?? "";
  const match = engineRange.match(/(\d+)/);
  assert.ok(match, `package.json engines.node must declare a major version, got: ${JSON.stringify(engineRange)}`);
  const engineMajor = parseInt(match[1], 10);
  assert.strictEqual(
    MIN_NODE_MAJOR,
    engineMajor,
    `runtime-checks MIN_NODE_MAJOR (${MIN_NODE_MAJOR}) must equal package.json engines.node major (${engineMajor})`
  );
});
test("gsd update bypasses the managed-resource-mismatch gate; non-update commands trigger it", async (t) => {
  const { getNewerManagedResourceVersion } = await import("../resource-loader.js");
  const { shouldBypassManagedResourceMismatchGate } = await import("../cli-policy.js");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-update-bypass-"));
  const fakeAgentDir = join(tmp, "agent");
  mkdirSync(fakeAgentDir, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const futureVersion = "999.0.0";
  const currentVersion = "1.0.0";
  writeFileSync(
    join(fakeAgentDir, "managed-resources.json"),
    JSON.stringify({ gsdVersion: futureVersion, syncedAt: Date.now() })
  );
  const newer = getNewerManagedResourceVersion(fakeAgentDir, currentVersion);
  assert.strictEqual(newer, futureVersion, "gate must surface a newer version when manifest is ahead");
  for (const nonUpdate of [
    void 0,
    "auto",
    "config",
    "doctor",
    "web",
    "headless",
    "updates"
    /* near-miss */
  ]) {
    assert.strictEqual(
      shouldBypassManagedResourceMismatchGate(nonUpdate),
      false,
      `non-update command ${JSON.stringify(nonUpdate)} must NOT bypass the gate`
    );
  }
  assert.strictEqual(
    shouldBypassManagedResourceMismatchGate("update"),
    true,
    "'update' must bypass the gate so the user can escape a version-mismatched install"
  );
});
test("managed resource skew ignores dev/build suffixes on the same release line", async (t) => {
  const { getNewerManagedResourceVersion } = await import("../resource-loader.js");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-version-normalize-"));
  const fakeAgentDir = join(tmp, "agent");
  mkdirSync(fakeAgentDir, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(
    join(fakeAgentDir, "managed-resources.json"),
    JSON.stringify({ gsdVersion: "2.78.1", syncedAt: Date.now() })
  );
  assert.strictEqual(
    getNewerManagedResourceVersion(fakeAgentDir, "2.78.1-dev.84c045fd2"),
    null,
    "same core version must not trip the skew gate just because the binary is a dev build"
  );
  assert.strictEqual(
    getNewerManagedResourceVersion(fakeAgentDir, "2.78.1+local"),
    null,
    "build metadata on the running binary must not trip the skew gate"
  );
  assert.strictEqual(
    getNewerManagedResourceVersion(fakeAgentDir, "2.78.0-dev.84c045fd2"),
    "2.78.1",
    "older core versions must still be blocked even when they carry a dev suffix"
  );
});
test("initResources syncs extensions, agents, and skills to target dir", async (t) => {
  const { initResources, readManagedResourceVersion } = await import("../resource-loader.js");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resources-test-"));
  const fakeAgentDir = join(tmp, "agent");
  initResources(fakeAgentDir);
  assertExtensionIndexExists(fakeAgentDir, "gsd");
  assertExtensionIndexExists(fakeAgentDir, "browser-tools");
  assertExtensionIndexExists(fakeAgentDir, "search-the-web");
  assertExtensionIndexExists(fakeAgentDir, "context7");
  assertExtensionIndexExists(fakeAgentDir, "subagent");
  assert.ok(existsSync(join(fakeAgentDir, "agents", "scout.md")), "scout agent synced");
  const managedVersion = readManagedResourceVersion(fakeAgentDir);
  assert.ok(managedVersion, "managed resource version written");
  initResources(fakeAgentDir);
  assertExtensionIndexExists(fakeAgentDir, "gsd");
});
test("initResources skips copy when managed version matches current version", async (t) => {
  const { initResources, readManagedResourceVersion } = await import("../resource-loader.js");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-resources-skip-"));
  const fakeAgentDir = join(tmp, "agent");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  initResources(fakeAgentDir);
  const version = readManagedResourceVersion(fakeAgentDir);
  assert.ok(version, "manifest written after first sync");
  const markerPath = join(fakeAgentDir, "extensions", "gsd", "_marker.txt");
  writeFileSync(markerPath, "test-marker");
  initResources(fakeAgentDir);
  assert.ok(existsSync(markerPath), "marker file survives when version matches (sync skipped)");
  const manifestPath = join(fakeAgentDir, "managed-resources.json");
  writeFileSync(manifestPath, JSON.stringify({ gsdVersion: "0.0.1", syncedAt: Date.now() }));
  initResources(fakeAgentDir);
  assert.ok(!existsSync(markerPath), "marker file removed after version-mismatch sync");
  const updatedVersion = readManagedResourceVersion(fakeAgentDir);
  assert.strictEqual(updatedVersion, version, "manifest updated to current version after sync");
});
test("loadStoredEnvKeys hydrates process.env from auth.json", async (t) => {
  const { loadStoredEnvKeys } = await import("../wizard.js");
  const { AuthStorage } = await import("@gsd/pi-coding-agent");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-wizard-test-"));
  const authPath = join(tmp, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    brave: { type: "api_key", key: "test-brave-key" },
    brave_answers: { type: "api_key", key: "test-answers-key" },
    context7: { type: "api_key", key: "test-ctx7-key" },
    tavily: { type: "api_key", key: "test-tavily-key" },
    telegram_bot: { type: "api_key", key: "test-telegram-key" },
    "custom-openai": { type: "api_key", key: "test-custom-openai-key" }
  }));
  const envVarsToRestore = [
    "BRAVE_API_KEY",
    "BRAVE_ANSWERS_KEY",
    "CONTEXT7_API_KEY",
    "JINA_API_KEY",
    "TAVILY_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "CUSTOM_OPENAI_API_KEY"
  ];
  const origValues = {};
  for (const v of envVarsToRestore) {
    origValues[v] = process.env[v];
    delete process.env[v];
  }
  t.after(() => {
    for (const v of envVarsToRestore) {
      if (origValues[v]) process.env[v] = origValues[v];
      else delete process.env[v];
    }
    rmSync(tmp, { recursive: true, force: true });
  });
  const auth = AuthStorage.create(authPath);
  loadStoredEnvKeys(auth);
  assert.equal(process.env.BRAVE_API_KEY, "test-brave-key", "BRAVE_API_KEY hydrated");
  assert.equal(process.env.BRAVE_ANSWERS_KEY, "test-answers-key", "BRAVE_ANSWERS_KEY hydrated");
  assert.equal(process.env.CONTEXT7_API_KEY, "test-ctx7-key", "CONTEXT7_API_KEY hydrated");
  assert.equal(process.env.JINA_API_KEY, void 0, "JINA_API_KEY not set (not in auth)");
  assert.equal(process.env.TAVILY_API_KEY, "test-tavily-key", "TAVILY_API_KEY hydrated");
  assert.equal(process.env.TELEGRAM_BOT_TOKEN, "test-telegram-key", "TELEGRAM_BOT_TOKEN hydrated");
  assert.equal(process.env.CUSTOM_OPENAI_API_KEY, "test-custom-openai-key", "CUSTOM_OPENAI_API_KEY hydrated");
});
test("loadStoredEnvKeys does not overwrite existing env vars", async (t) => {
  const { loadStoredEnvKeys } = await import("../wizard.js");
  const { AuthStorage } = await import("@gsd/pi-coding-agent");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-wizard-nooverwrite-"));
  const authPath = join(tmp, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    brave: { type: "api_key", key: "stored-key" }
  }));
  const origBrave = process.env.BRAVE_API_KEY;
  process.env.BRAVE_API_KEY = "existing-env-key";
  t.after(() => {
    if (origBrave) process.env.BRAVE_API_KEY = origBrave;
    else delete process.env.BRAVE_API_KEY;
    rmSync(tmp, { recursive: true, force: true });
  });
  const auth = AuthStorage.create(authPath);
  loadStoredEnvKeys(auth);
  assert.equal(process.env.BRAVE_API_KEY, "existing-env-key", "existing env var not overwritten");
});
test("deriveState returns pre-planning phase for empty .gsd/ directory", async (t) => {
  const { deriveState } = await import("../resources/extensions/gsd/state.js");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-state-smoke-"));
  mkdirSync(join(tmp, ".gsd"), { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const state = await deriveState(tmp);
  assert.equal(
    state.phase,
    "pre-planning",
    `expected pre-planning phase for empty .gsd/, got: ${state.phase}`
  );
  assert.equal(state.activeMilestone, null, "no active milestone");
  assert.equal(state.activeSlice, null, "no active slice");
  assert.equal(state.activeTask, null, "no active task");
  assert.ok(Array.isArray(state.blockers), "blockers is an array");
  assert.ok(Array.isArray(state.registry), "registry is an array");
  assert.equal(state.registry.length, 0, "empty registry");
  assert.ok(typeof state.nextAction === "string", "nextAction is a string");
  assert.ok(state.nextAction.length > 0, "nextAction is non-empty");
});
test("deriveState returns pre-planning phase when no .gsd/ directory exists", async (t) => {
  const { deriveState } = await import("../resources/extensions/gsd/state.js");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-state-nogsd-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const state = await deriveState(tmp);
  assert.equal(
    state.phase,
    "pre-planning",
    `expected pre-planning phase when .gsd/ absent, got: ${state.phase}`
  );
  assert.equal(state.activeMilestone, null, "no active milestone");
});
test("deriveState shape is structurally complete", async (t) => {
  const { deriveState } = await import("../resources/extensions/gsd/state.js");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-state-shape-"));
  mkdirSync(join(tmp, ".gsd"), { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const state = await deriveState(tmp);
  const requiredFields = [
    "phase",
    "activeMilestone",
    "activeSlice",
    "activeTask",
    "recentDecisions",
    "blockers",
    "nextAction",
    "registry"
  ];
  for (const field of requiredFields) {
    assert.ok(field in state, `state.${field} should be present`);
  }
  const validPhases = [
    "pre-planning",
    "needs-discussion",
    "researching",
    "planning",
    "executing",
    "summarizing",
    "replanning-slice",
    "validating-milestone",
    "completing-milestone",
    "complete",
    "blocked"
  ];
  assert.ok(
    validPhases.includes(state.phase),
    `state.phase '${state.phase}' should be a known phase`
  );
});
test("runGSDDoctor completes without throwing on empty .gsd/ directory", async (t) => {
  const { runGSDDoctor } = await import("../resources/extensions/gsd/doctor.js");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-doctor-smoke-"));
  mkdirSync(join(tmp, ".gsd"), { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const report = await runGSDDoctor(tmp, { fix: false });
  assert.ok(typeof report === "object" && report !== null, "report is an object");
  assert.ok("ok" in report, "report has ok field");
  assert.ok("issues" in report, "report has issues field");
  assert.ok("fixesApplied" in report, "report has fixesApplied field");
  assert.ok("basePath" in report, "report has basePath field");
  assert.ok(Array.isArray(report.issues), "report.issues is an array");
  assert.ok(Array.isArray(report.fixesApplied), "report.fixesApplied is an array");
  assert.equal(typeof report.ok, "boolean", "report.ok is a boolean");
  assert.equal(report.fixesApplied.length, 0, "no fixes applied in audit mode");
});
test("runGSDDoctor issue objects have required fields", async (t) => {
  const { runGSDDoctor } = await import("../resources/extensions/gsd/doctor.js");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-doctor-fields-"));
  mkdirSync(join(tmp, ".gsd"), { recursive: true });
  const mDir = join(tmp, ".gsd", "milestones", "M001");
  mkdirSync(mDir, { recursive: true });
  writeFileSync(join(mDir, "M001-CONTEXT.md"), "# Context\n");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const report = await runGSDDoctor(tmp, { fix: false });
  assert.ok(report.issues.length > 0, "expected at least one issue for milestone missing ROADMAP.md");
  for (const issue of report.issues) {
    assert.ok(typeof issue.severity === "string", "issue.severity is a string");
    assert.ok(
      ["info", "warning", "error"].includes(issue.severity),
      `issue.severity '${issue.severity}' should be info|warning|error`
    );
    assert.ok(typeof issue.code === "string", "issue.code is a string");
    assert.ok(typeof issue.message === "string", "issue.message is a string");
    assert.ok(issue.message.length > 0, "issue.message is non-empty");
    assert.ok(typeof issue.fixable === "boolean", "issue.fixable is a boolean");
  }
});
test("runGSDDoctor with fix:false never modifies the filesystem", async (t) => {
  const { runGSDDoctor } = await import("../resources/extensions/gsd/doctor.js");
  const tmp = mkdtempSync(join(tmpdir(), "gsd-doctor-readonly-"));
  const gsdDir = join(tmp, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  const sentinelPath = join(gsdDir, "SENTINEL.md");
  writeFileSync(sentinelPath, "# sentinel\n");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  await runGSDDoctor(tmp, { fix: false });
  assert.ok(existsSync(sentinelPath), "sentinel file still exists after audit-only run");
  const content = readFileSync(sentinelPath, "utf-8");
  assert.equal(content, "# sentinel\n", "sentinel file content unchanged");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL2FwcC1zbW9rZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFVuaXQgdGVzdHMgZm9yIHRoZSBnc2QgQ0xJIHBhY2thZ2UuXG4gKlxuICogVGVzdHMgdGhlIGdsdWUgY29kZSB0aGF0IElTIHRoZSBwcm9kdWN0OlxuICogLSBhcHAtcGF0aHMgcmVzb2x2ZSB0byB+Ly5nc2QvXG4gKiAtIGxvYWRlciBzZXRzIGFsbCByZXF1aXJlZCBlbnYgdmFyc1xuICogLSByZXNvdXJjZS1sb2FkZXIgc3luY3MgYnVuZGxlZCByZXNvdXJjZXNcbiAqIC0gd2l6YXJkIGxvYWRTdG9yZWRFbnZLZXlzIGh5ZHJhdGVzIGVudlxuICpcbiAqIEludGVncmF0aW9uIHRlc3RzIChucG0gcGFjaywgaW5zdGFsbCwgbGF1bmNoKSBhcmUgaW4gLi9pbnRlZ3JhdGlvbi9wYWNrLWluc3RhbGwudGVzdC50c1xuICovXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZXhlY1N5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIG1rZHRlbXBTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBkZWxpbWl0ZXIsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuXG5jb25zdCBwcm9qZWN0Um9vdCA9IGpvaW4oZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiKTtcblxuZnVuY3Rpb24gYXNzZXJ0RXh0ZW5zaW9uSW5kZXhFeGlzdHMoYWdlbnREaXI6IHN0cmluZywgZXh0ZW5zaW9uTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGFzc2VydC5vayhcbiAgICBleGlzdHNTeW5jKGpvaW4oYWdlbnREaXIsIFwiZXh0ZW5zaW9uc1wiLCBleHRlbnNpb25OYW1lLCBcImluZGV4LmpzXCIpKVxuICAgICAgfHwgZXhpc3RzU3luYyhqb2luKGFnZW50RGlyLCBcImV4dGVuc2lvbnNcIiwgZXh0ZW5zaW9uTmFtZSwgXCJpbmRleC50c1wiKSksXG4gICAgYCR7ZXh0ZW5zaW9uTmFtZX0gZXh0ZW5zaW9uIHN5bmNlZGAsXG4gICk7XG59XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gMS4gYXBwLXBhdGhzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxudGVzdChcImFwcC1wYXRocyByZXNvbHZlIHRvIH4vLmdzZC9cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGFwcFJvb3QsIGFnZW50RGlyLCBzZXNzaW9uc0RpciwgYXV0aEZpbGVQYXRoIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9hcHAtcGF0aHMudHNcIik7XG4gIC8vIFVzZSBob21lZGlyKCkgXHUyMDE0IHByb2Nlc3MuZW52LkhPTUUgaXMgdW5kZWZpbmVkIG9uIFdpbmRvd3MgKHVzZXMgVVNFUlBST0ZJTEUgaW5zdGVhZClcbiAgY29uc3QgeyBob21lZGlyIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOm9zXCIpO1xuICBjb25zdCBob21lID0gaG9tZWRpcigpO1xuXG4gIGFzc2VydC5lcXVhbChhcHBSb290LCBqb2luKGhvbWUsIFwiLmdzZFwiKSwgXCJhcHBSb290IGlzIH4vLmdzZC9cIik7XG4gIGFzc2VydC5lcXVhbChhZ2VudERpciwgam9pbihob21lLCBcIi5nc2RcIiwgXCJhZ2VudFwiKSwgXCJhZ2VudERpciBpcyB+Ly5nc2QvYWdlbnQvXCIpO1xuICBhc3NlcnQuZXF1YWwoc2Vzc2lvbnNEaXIsIGpvaW4oaG9tZSwgXCIuZ3NkXCIsIFwic2Vzc2lvbnNcIiksIFwic2Vzc2lvbnNEaXIgaXMgfi8uZ3NkL3Nlc3Npb25zL1wiKTtcbiAgYXNzZXJ0LmVxdWFsKGF1dGhGaWxlUGF0aCwgam9pbihob21lLCBcIi5nc2RcIiwgXCJhZ2VudFwiLCBcImF1dGguanNvblwiKSwgXCJhdXRoRmlsZVBhdGggaXMgfi8uZ3NkL2FnZW50L2F1dGguanNvblwiKTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIDIuIGxvYWRlciBlbnYgdmFyc1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoXCJsb2FkZXIgc2V0cyBhbGwgNCBHU0RfIGVudiB2YXJzIGFuZCBQSV9QQUNLQUdFX0RJUlwiLCBhc3luYyAodCkgPT4ge1xuICAvLyBSdW4gbG9hZGVyIGluIGEgc3VicHJvY2VzcyB0aGF0IHByaW50cyBlbnYgdmFycyBhbmQgZXhpdHMgYmVmb3JlIFRVSSBzdGFydHNcbiAgY29uc3Qgc2NyaXB0ID0gYFxuICAgIGltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tICd1cmwnO1xuICAgIGltcG9ydCB7IGRpcm5hbWUsIHJlc29sdmUsIGpvaW4sIGRlbGltaXRlciB9IGZyb20gJ3BhdGgnO1xuICAgIGltcG9ydCB7IGFnZW50RGlyIH0gZnJvbSAnLi9hcHAtcGF0aHMuanMnO1xuXG4gICAgY29uc3QgcGtnRGlyID0gcmVzb2x2ZShkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSksICcuLicsICdwa2cnKTtcbiAgICBwcm9jZXNzLmVudi5QSV9QQUNLQUdFX0RJUiA9IHBrZ0RpcjtcbiAgICBwcm9jZXNzLmVudi5HU0RfQ09ESU5HX0FHRU5UX0RJUiA9IGFnZW50RGlyO1xuICAgIHByb2Nlc3MuZW52LkdTRF9CSU5fUEFUSCA9IHByb2Nlc3MuYXJndlsxXTtcbiAgICBjb25zdCByZXNvdXJjZXNEaXIgPSByZXNvbHZlKGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKSwgJy4uJywgJ3NyYycsICdyZXNvdXJjZXMnKTtcbiAgICBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUEFUSCA9IGpvaW4ocmVzb3VyY2VzRGlyLCAnR1NELVdPUktGTE9XLm1kJyk7XG4gICAgY29uc3QgZXh0cyA9IFsnZXh0ZW5zaW9ucy9nc2QvaW5kZXgudHMnXS5tYXAociA9PiBqb2luKHJlc291cmNlc0RpciwgcikpO1xuICAgIHByb2Nlc3MuZW52LkdTRF9CVU5ETEVEX0VYVEVOU0lPTl9QQVRIUyA9IGV4dHMuam9pbihkZWxpbWl0ZXIpO1xuXG4gICAgLy8gUHJpbnQgZm9yIHZlcmlmaWNhdGlvblxuICAgIGNvbnNvbGUubG9nKCdQSV9QQUNLQUdFX0RJUj0nICsgcHJvY2Vzcy5lbnYuUElfUEFDS0FHRV9ESVIpO1xuICAgIGNvbnNvbGUubG9nKCdHU0RfQ09ESU5HX0FHRU5UX0RJUj0nICsgcHJvY2Vzcy5lbnYuR1NEX0NPRElOR19BR0VOVF9ESVIpO1xuICAgIGNvbnNvbGUubG9nKCdHU0RfQklOX1BBVEg9JyArIHByb2Nlc3MuZW52LkdTRF9CSU5fUEFUSCk7XG4gICAgY29uc29sZS5sb2coJ0dTRF9XT1JLRkxPV19QQVRIPScgKyBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUEFUSCk7XG4gICAgY29uc29sZS5sb2coJ0dTRF9CVU5ETEVEX0VYVEVOU0lPTl9QQVRIUz0nICsgcHJvY2Vzcy5lbnYuR1NEX0JVTkRMRURfRVhURU5TSU9OX1BBVEhTKTtcbiAgICBwcm9jZXNzLmV4aXQoMCk7XG4gIGA7XG5cbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtbG9hZGVyLXRlc3QtXCIpKTtcbiAgY29uc3Qgc2NyaXB0UGF0aCA9IGpvaW4odG1wLCBcImNoZWNrLWVudi50c1wiKTtcbiAgd3JpdGVGaWxlU3luYyhzY3JpcHRQYXRoLCBzY3JpcHQpO1xuXG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcbiAgdHJ5IHtcbiAgY29uc3Qgb3V0cHV0ID0gZXhlY1N5bmMoXG4gICAgYG5vZGUgLS1leHBlcmltZW50YWwtc3RyaXAtdHlwZXMgLWUgXCJcbiAgICAgIHByb2Nlc3MuY2hkaXIoJyR7cHJvamVjdFJvb3R9Jyk7XG4gICAgICBhd2FpdCBpbXBvcnQoJy4vc3JjL2FwcC1wYXRocy50cycpO1xuICAgIFwiIDI+JjFgLFxuICAgIHsgZW5jb2Rpbmc6IFwidXRmLThcIiwgY3dkOiBwcm9qZWN0Um9vdCB9LFxuICApO1xuICAvLyBJZiB3ZSBnb3QgaGVyZSB3aXRob3V0IGVycm9yLCB0aGUgaW1wb3J0IHdvcmtzXG4gIH0gY2F0Y2gge1xuICAvLyBGaW5lIFx1MjAxNCB3ZSB0ZXN0IHRoZSBsb2dpYyBpbmxpbmUgYmVsb3dcbiAgfVxuXG4gIC8vIERpcmVjdCBsb2dpYyB2ZXJpZmljYXRpb24gKG5vIHN1YnByb2Nlc3MgbmVlZGVkKVxuICBjb25zdCB7IGFnZW50RGlyOiBhZCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYXBwLXBhdGhzLnRzXCIpO1xuICBhc3NlcnQub2soYWQuZW5kc1dpdGgoam9pbihcIi5nc2RcIiwgXCJhZ2VudFwiKSksIFwiYWdlbnREaXIgZW5kcyB3aXRoIC5nc2QvYWdlbnRcIik7XG5cbiAgLy8gVmVyaWZ5IHRoYXQgdGhlIGVudiB2YXIgaXMgcG9wdWxhdGVkIGF0IHJ1bnRpbWUgYnkgY2hlY2tpbmcgdGhlIGFjdHVhbFxuICAvLyBleHRlbnNpb25zIGRpcmVjdG9yeSBoYXMgZGlzY292ZXJhYmxlIGVudHJ5IHBvaW50c1xuICBjb25zdCB7IGRpc2NvdmVyRXh0ZW5zaW9uRW50cnlQYXRocyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vZXh0ZW5zaW9uLWRpc2NvdmVyeS50c1wiKTtcbiAgY29uc3QgYnVuZGxlZEV4dGVuc2lvbnNEaXIgPSBqb2luKHByb2plY3RSb290LCBleGlzdHNTeW5jKGpvaW4ocHJvamVjdFJvb3QsIFwiZGlzdFwiLCBcInJlc291cmNlc1wiKSlcbiAgPyBcImRpc3RcIiA6IFwic3JjXCIsIFwicmVzb3VyY2VzXCIsIFwiZXh0ZW5zaW9uc1wiKTtcbiAgY29uc3QgZGlzY292ZXJlZCA9IGRpc2NvdmVyRXh0ZW5zaW9uRW50cnlQYXRocyhidW5kbGVkRXh0ZW5zaW9uc0Rpcik7XG4gIGFzc2VydC5vayhkaXNjb3ZlcmVkLmxlbmd0aCA+PSAxMCwgYGV4cGVjdGVkID49MTAgZXh0ZW5zaW9ucywgZm91bmQgJHtkaXNjb3ZlcmVkLmxlbmd0aH1gKTtcblxuICAvLyBTcG90LWNoZWNrIHRoYXQgY29yZSBleHRlbnNpb25zIGFyZSBkaXNjb3ZlcmFibGVcbiAgY29uc3QgZGlzY292ZXJlZE5hbWVzID0gZGlzY292ZXJlZC5tYXAocCA9PiB7XG4gIGNvbnN0IHJlbCA9IHAuc2xpY2UoYnVuZGxlZEV4dGVuc2lvbnNEaXIubGVuZ3RoICsgMSk7XG4gIHJldHVybiByZWwuc3BsaXQoL1tcXFxcL10vKVswXS5yZXBsYWNlKC9cXC4oPzp0c3xqcykkLywgXCJcIik7XG4gIH0pO1xuICBmb3IgKGNvbnN0IGNvcmUgb2YgW1wiZ3NkXCIsIFwiYmctc2hlbGxcIiwgXCJicm93c2VyLXRvb2xzXCIsIFwic3ViYWdlbnRcIiwgXCJzZWFyY2gtdGhlLXdlYlwiXSkge1xuICBhc3NlcnQub2soZGlzY292ZXJlZE5hbWVzLmluY2x1ZGVzKGNvcmUpLCBgY29yZSBleHRlbnNpb24gJyR7Y29yZX0nIGlzIGRpc2NvdmVyYWJsZWApO1xuICB9XG5cbiAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gMmIuIGxvYWRlciBydW50aW1lIGRlcGVuZGVuY3kgY2hlY2tzXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxudGVzdChcImNoZWNrTm9kZVZlcnNpb24gcmVqZWN0cyBiZWxvdy1taW5pbXVtIHZlcnNpb25zIGFuZCBhY2NlcHRzIGF0LW9yLWFib3ZlXCIsIGFzeW5jICgpID0+IHtcbiAgLy8gQ2FsbHMgdGhlIGFjdHVhbCBwdXJlIGZ1bmN0aW9uIHRoZSBsb2FkZXIgaW52b2tlcy4gSWYgbG9hZGVyLnRzIGV2ZXJcbiAgLy8gd2Vha2VucyB0aGUgbWluaW11bSAoZS5nLiBkcm9wcyB0aGUgPCBjaGVjayksIHRoaXMgdGVzdCBmYWlscyBiZWNhdXNlXG4gIC8vIGFuIG9sZCBOb2RlIHZlcnNpb24gd291bGQgYmUgaW5jb3JyZWN0bHkgYWNjZXB0ZWQuXG4gIGNvbnN0IHsgY2hlY2tOb2RlVmVyc2lvbiwgTUlOX05PREVfTUFKT1IgfSA9IGF3YWl0IGltcG9ydChcIi4uL3J1bnRpbWUtY2hlY2tzLnRzXCIpO1xuXG4gIC8vIEJlbG93IG1pbmltdW0gXHUyMTkyIG5vdCBvaywgc3VyZmFjZXMgdGhlIGFjdHVhbCBtYWpvclxuICBjb25zdCB0b29PbGQgPSBjaGVja05vZGVWZXJzaW9uKFwiMTguMTkuMFwiLCBNSU5fTk9ERV9NQUpPUik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbCh0b29PbGQub2ssIGZhbHNlLCBcIk5vZGUgMTggbXVzdCBiZSByZWplY3RlZCB3aGVuIG1pbiBpcyAyMitcIik7XG4gIGlmICh0b29PbGQub2sgPT09IGZhbHNlKSB7XG4gICAgYXNzZXJ0LnN0cmljdEVxdWFsKHRvb09sZC5hY3R1YWxNYWpvciwgMTgsIFwicmVwb3J0cyBhY3R1YWwgbWFqb3IgZnJvbSBpbnB1dFwiKTtcbiAgfVxuXG4gIC8vIEV4YWN0bHkgbWluaW11bSBcdTIxOTIgb2tcbiAgY29uc3QgZXhhY3RseU1pbiA9IGNoZWNrTm9kZVZlcnNpb24oYCR7TUlOX05PREVfTUFKT1J9LjAuMGAsIE1JTl9OT0RFX01BSk9SKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGV4YWN0bHlNaW4ub2ssIHRydWUsIFwidmVyc2lvbiBlcXVhbCB0byBtaW5pbXVtIG11c3QgYmUgYWNjZXB0ZWRcIik7XG5cbiAgLy8gQWJvdmUgbWluaW11bSBcdTIxOTIgb2tcbiAgY29uc3QgYWJvdmUgPSBjaGVja05vZGVWZXJzaW9uKGAke01JTl9OT0RFX01BSk9SICsgNX0uMTAuMmAsIE1JTl9OT0RFX01BSk9SKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGFib3ZlLm9rLCB0cnVlLCBcInZlcnNpb24gYWJvdmUgbWluaW11bSBtdXN0IGJlIGFjY2VwdGVkXCIpO1xuXG4gIC8vIE1hbGZvcm1lZCB2ZXJzaW9uIHN0cmluZyBpcyBhIHByZWNvbmRpdGlvbiB2aW9sYXRpb24gXHUyMDE0IG11c3QgdGhyb3dcbiAgYXNzZXJ0LnRocm93cygoKSA9PiBjaGVja05vZGVWZXJzaW9uKFwibm90LWEtdmVyc2lvblwiLCBNSU5fTk9ERV9NQUpPUiksIC9jYW5ub3QgcGFyc2UgbWFqb3IvKTtcbn0pO1xuXG50ZXN0KFwicmVxdWlyZUdpdCByZXR1cm5zIGZhbHNlIHdoZW4gZXhlYyB0aHJvd3MgYW5kIHRydWUgd2hlbiBpdCBzdWNjZWVkc1wiLCBhc3luYyAoKSA9PiB7XG4gIC8vIENhbGxzIHRoZSBhY3R1YWwgcHVyZSBmdW5jdGlvbiB0aGUgbG9hZGVyIHVzZXMuIFN0dWJzIHRoZSBleGVjIGZ1bmN0aW9uXG4gIC8vIHNvIHdlIHRlc3QgdGhlIGxvYWRlcidzIHJlYWwgYmVoYXZpb3Igd2l0aCBubyBzdWJwcm9jZXNzIGZsYWtpbmVzcy5cbiAgY29uc3QgeyByZXF1aXJlR2l0IH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9ydW50aW1lLWNoZWNrcy50c1wiKTtcblxuICAvLyBGYWlsdXJlIHBhdGg6IGV4ZWMgdGhyb3dzIFx1MjE5MiBsb2FkZXIgdHJlYXRzIGdpdCBhcyBtaXNzaW5nXG4gIGxldCBjYWxsczogQXJyYXk8eyBjbWQ6IHN0cmluZzsgYXJnczogUmVhZG9ubHlBcnJheTxzdHJpbmc+IH0+ID0gW107XG4gIGNvbnN0IHRocm93aW5nRXhlYyA9IChjbWQ6IHN0cmluZywgYXJnczogUmVhZG9ubHlBcnJheTxzdHJpbmc+KSA9PiB7XG4gICAgY2FsbHMucHVzaCh7IGNtZCwgYXJncyB9KTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJFTk9FTlQ6IGdpdCBub3QgZm91bmRcIik7XG4gIH07XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXF1aXJlR2l0KHRocm93aW5nRXhlYyksIGZhbHNlLCBcIm11c3QgcmV0dXJuIGZhbHNlIHdoZW4gZXhlYyB0aHJvd3NcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChjYWxscy5sZW5ndGgsIDEsIFwiZXhlYyBpbnZva2VkIGV4YWN0bHkgb25jZVwiKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKGNhbGxzWzBdLmNtZCwgXCJnaXRcIiwgXCJpbnZva2VzICdnaXQnIHNwZWNpZmljYWxseVwiKTtcbiAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChbLi4uY2FsbHNbMF0uYXJnc10sIFtcIi0tdmVyc2lvblwiXSwgXCJwYXNzZXMgWyctLXZlcnNpb24nXVwiKTtcblxuICAvLyBTdWNjZXNzIHBhdGg6IGV4ZWMgcmV0dXJucyBcdTIxOTIgbG9hZGVyIHRyZWF0cyBnaXQgYXMgYXZhaWxhYmxlXG4gIGNhbGxzID0gW107XG4gIGNvbnN0IG9rRXhlYyA9IChjbWQ6IHN0cmluZywgYXJnczogUmVhZG9ubHlBcnJheTxzdHJpbmc+KSA9PiB7XG4gICAgY2FsbHMucHVzaCh7IGNtZCwgYXJncyB9KTtcbiAgICByZXR1cm4gQnVmZmVyLmZyb20oXCJnaXQgdmVyc2lvbiAyLjQwLjBcXG5cIik7XG4gIH07XG4gIGFzc2VydC5zdHJpY3RFcXVhbChyZXF1aXJlR2l0KG9rRXhlYyksIHRydWUsIFwibXVzdCByZXR1cm4gdHJ1ZSB3aGVuIGV4ZWMgc3VjY2VlZHNcIik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChjYWxscy5sZW5ndGgsIDEsIFwic3VjY2VzcyBwYXRoIGFsc28gaW52b2tlcyBleGVjIGV4YWN0bHkgb25jZVwiKTtcbn0pO1xuXG50ZXN0KFwibG9hZGVyIE1JTl9OT0RFX01BSk9SIG1hdGNoZXMgcGFja2FnZS5qc29uIGVuZ2luZXMgZmllbGQgZXhhY3RseVwiLCBhc3luYyAoKSA9PiB7XG4gIC8vIEltcG9ydHMgdGhlIGFjdHVhbCBleHBvcnRlZCBjb25zdGFudCBmcm9tIHJ1bnRpbWUtY2hlY2tzLnRzICh0aGUgc2FtZVxuICAvLyBtb2R1bGUgbG9hZGVyLnRzIGNvbnN1bWVzKSBhbmQgYXNzZXJ0cyBTVFJJQ1QgZXF1YWxpdHkgd2l0aCB0aGUgbWFqb3JcbiAgLy8gdmVyc2lvbiBwYXJzZWQgZnJvbSBwYWNrYWdlLmpzb24ncyBlbmdpbmVzLm5vZGUgcmFuZ2UuXG4gIGNvbnN0IHsgTUlOX05PREVfTUFKT1IgfSA9IGF3YWl0IGltcG9ydChcIi4uL3J1bnRpbWUtY2hlY2tzLnRzXCIpO1xuXG4gIGNvbnN0IHBrZyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4ocHJvamVjdFJvb3QsIFwicGFja2FnZS5qc29uXCIpLCBcInV0Zi04XCIpKTtcbiAgY29uc3QgZW5naW5lUmFuZ2U6IHN0cmluZyA9IHBrZy5lbmdpbmVzPy5ub2RlID8/IFwiXCI7XG4gIGNvbnN0IG1hdGNoID0gZW5naW5lUmFuZ2UubWF0Y2goLyhcXGQrKS8pO1xuICBhc3NlcnQub2sobWF0Y2gsIGBwYWNrYWdlLmpzb24gZW5naW5lcy5ub2RlIG11c3QgZGVjbGFyZSBhIG1ham9yIHZlcnNpb24sIGdvdDogJHtKU09OLnN0cmluZ2lmeShlbmdpbmVSYW5nZSl9YCk7XG4gIGNvbnN0IGVuZ2luZU1ham9yID0gcGFyc2VJbnQobWF0Y2hbMV0sIDEwKTtcblxuICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgTUlOX05PREVfTUFKT1IsXG4gICAgZW5naW5lTWFqb3IsXG4gICAgYHJ1bnRpbWUtY2hlY2tzIE1JTl9OT0RFX01BSk9SICgke01JTl9OT0RFX01BSk9SfSkgbXVzdCBlcXVhbCBwYWNrYWdlLmpzb24gZW5naW5lcy5ub2RlIG1ham9yICgke2VuZ2luZU1ham9yfSlgLFxuICApO1xufSk7XG5cbnRlc3QoXCJnc2QgdXBkYXRlIGJ5cGFzc2VzIHRoZSBtYW5hZ2VkLXJlc291cmNlLW1pc21hdGNoIGdhdGU7IG5vbi11cGRhdGUgY29tbWFuZHMgdHJpZ2dlciBpdFwiLCBhc3luYyAodCkgPT4ge1xuICAvLyBSZWFsIGZpeHR1cmU6IHdyaXRlIGFuIGFnZW50RGlyIHdob3NlIG1hbmFnZWQtcmVzb3VyY2VzLmpzb24gY2xhaW1zIGFcbiAgLy8gdmVyc2lvbiBuZXdlciB0aGFuIHRoZSBydW5uaW5nIGJpbmFyeS4gVGhlIG1pc21hdGNoIGdhdGVcbiAgLy8gKGdldE5ld2VyTWFuYWdlZFJlc291cmNlVmVyc2lvbikgbXVzdCBmaXJlIFx1MjAxNCBwcm92aW5nIHRoZSBnYXRlIGlzIFwiYXJtZWRcIi5cbiAgLy8gc2hvdWxkQnlwYXNzTWFuYWdlZFJlc291cmNlTWlzbWF0Y2hHYXRlKCd1cGRhdGUnKSBtdXN0IHJldHVybiB0cnVlLFxuICAvLyBwcm92aW5nICd1cGRhdGUnIGJ5cGFzc2VzIGl0LiBjbGkudHMgd2lyZXMgdGhlIHByZWRpY2F0ZSBiZWZvcmUgdGhlIGdhdGVcbiAgLy8gY2FsbCwgc28gdXBkYXRlIGVzY2FwZXMgdGhlIGdhdGUuXG4gIGNvbnN0IHsgZ2V0TmV3ZXJNYW5hZ2VkUmVzb3VyY2VWZXJzaW9uIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9yZXNvdXJjZS1sb2FkZXIudHNcIik7XG4gIGNvbnN0IHsgc2hvdWxkQnlwYXNzTWFuYWdlZFJlc291cmNlTWlzbWF0Y2hHYXRlIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9jbGktcG9saWN5LnRzXCIpO1xuXG4gIGNvbnN0IHRtcCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXVwZGF0ZS1ieXBhc3MtXCIpKTtcbiAgY29uc3QgZmFrZUFnZW50RGlyID0gam9pbih0bXAsIFwiYWdlbnRcIik7XG4gIG1rZGlyU3luYyhmYWtlQWdlbnREaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICAvLyBGaXh0dXJlOiBtYW5pZmVzdCBjbGFpbXMgYSBmYXItZnV0dXJlIHZlcnNpb24gXHUyMTkyIGdhdGUgbXVzdCBmaXJlIGZvciBldmVyeW9uZVxuICBjb25zdCBmdXR1cmVWZXJzaW9uID0gXCI5OTkuMC4wXCI7XG4gIGNvbnN0IGN1cnJlbnRWZXJzaW9uID0gXCIxLjAuMFwiO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oZmFrZUFnZW50RGlyLCBcIm1hbmFnZWQtcmVzb3VyY2VzLmpzb25cIiksXG4gICAgSlNPTi5zdHJpbmdpZnkoeyBnc2RWZXJzaW9uOiBmdXR1cmVWZXJzaW9uLCBzeW5jZWRBdDogRGF0ZS5ub3coKSB9KSxcbiAgKTtcblxuICAvLyBHYXRlIGlzIGFybWVkOiByZXR1cm5zIHRoZSBuZXdlciB2ZXJzaW9uIChjbGkudHMgd291bGQgcHJpbnQgbWlzbWF0Y2ggKyBleGl0IDEpXG4gIGNvbnN0IG5ld2VyID0gZ2V0TmV3ZXJNYW5hZ2VkUmVzb3VyY2VWZXJzaW9uKGZha2VBZ2VudERpciwgY3VycmVudFZlcnNpb24pO1xuICBhc3NlcnQuc3RyaWN0RXF1YWwobmV3ZXIsIGZ1dHVyZVZlcnNpb24sIFwiZ2F0ZSBtdXN0IHN1cmZhY2UgYSBuZXdlciB2ZXJzaW9uIHdoZW4gbWFuaWZlc3QgaXMgYWhlYWRcIik7XG5cbiAgLy8gRm9yIG5vbi11cGRhdGUgY29tbWFuZHMgdGhlIHByZWRpY2F0ZSBpcyBmYWxzZSBcdTIxOTIgY2xpLnRzIGZhbGxzIHRocm91Z2ggdG8gdGhlIGdhdGUuXG4gIGZvciAoY29uc3Qgbm9uVXBkYXRlIG9mIFt1bmRlZmluZWQsIFwiYXV0b1wiLCBcImNvbmZpZ1wiLCBcImRvY3RvclwiLCBcIndlYlwiLCBcImhlYWRsZXNzXCIsIFwidXBkYXRlc1wiIC8qIG5lYXItbWlzcyAqL10pIHtcbiAgICBhc3NlcnQuc3RyaWN0RXF1YWwoXG4gICAgICBzaG91bGRCeXBhc3NNYW5hZ2VkUmVzb3VyY2VNaXNtYXRjaEdhdGUobm9uVXBkYXRlKSxcbiAgICAgIGZhbHNlLFxuICAgICAgYG5vbi11cGRhdGUgY29tbWFuZCAke0pTT04uc3RyaW5naWZ5KG5vblVwZGF0ZSl9IG11c3QgTk9UIGJ5cGFzcyB0aGUgZ2F0ZWAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIEZvciAndXBkYXRlJyB0aGUgcHJlZGljYXRlIGlzIHRydWUgXHUyMTkyIGNsaS50cyBkaXNwYXRjaGVzIHJ1blVwZGF0ZSgpIGJlZm9yZSB0aGUgZ2F0ZS5cbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIHNob3VsZEJ5cGFzc01hbmFnZWRSZXNvdXJjZU1pc21hdGNoR2F0ZShcInVwZGF0ZVwiKSxcbiAgICB0cnVlLFxuICAgIFwiJ3VwZGF0ZScgbXVzdCBieXBhc3MgdGhlIGdhdGUgc28gdGhlIHVzZXIgY2FuIGVzY2FwZSBhIHZlcnNpb24tbWlzbWF0Y2hlZCBpbnN0YWxsXCIsXG4gICk7XG59KTtcblxudGVzdChcIm1hbmFnZWQgcmVzb3VyY2Ugc2tldyBpZ25vcmVzIGRldi9idWlsZCBzdWZmaXhlcyBvbiB0aGUgc2FtZSByZWxlYXNlIGxpbmVcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgeyBnZXROZXdlck1hbmFnZWRSZXNvdXJjZVZlcnNpb24gfSA9IGF3YWl0IGltcG9ydChcIi4uL3Jlc291cmNlLWxvYWRlci50c1wiKTtcblxuICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC12ZXJzaW9uLW5vcm1hbGl6ZS1cIikpO1xuICBjb25zdCBmYWtlQWdlbnREaXIgPSBqb2luKHRtcCwgXCJhZ2VudFwiKTtcbiAgbWtkaXJTeW5jKGZha2VBZ2VudERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgdC5hZnRlcigoKSA9PiBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihmYWtlQWdlbnREaXIsIFwibWFuYWdlZC1yZXNvdXJjZXMuanNvblwiKSxcbiAgICBKU09OLnN0cmluZ2lmeSh7IGdzZFZlcnNpb246IFwiMi43OC4xXCIsIHN5bmNlZEF0OiBEYXRlLm5vdygpIH0pLFxuICApO1xuXG4gIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICBnZXROZXdlck1hbmFnZWRSZXNvdXJjZVZlcnNpb24oZmFrZUFnZW50RGlyLCBcIjIuNzguMS1kZXYuODRjMDQ1ZmQyXCIpLFxuICAgIG51bGwsXG4gICAgXCJzYW1lIGNvcmUgdmVyc2lvbiBtdXN0IG5vdCB0cmlwIHRoZSBza2V3IGdhdGUganVzdCBiZWNhdXNlIHRoZSBiaW5hcnkgaXMgYSBkZXYgYnVpbGRcIixcbiAgKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIGdldE5ld2VyTWFuYWdlZFJlc291cmNlVmVyc2lvbihmYWtlQWdlbnREaXIsIFwiMi43OC4xK2xvY2FsXCIpLFxuICAgIG51bGwsXG4gICAgXCJidWlsZCBtZXRhZGF0YSBvbiB0aGUgcnVubmluZyBiaW5hcnkgbXVzdCBub3QgdHJpcCB0aGUgc2tldyBnYXRlXCIsXG4gICk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICBnZXROZXdlck1hbmFnZWRSZXNvdXJjZVZlcnNpb24oZmFrZUFnZW50RGlyLCBcIjIuNzguMC1kZXYuODRjMDQ1ZmQyXCIpLFxuICAgIFwiMi43OC4xXCIsXG4gICAgXCJvbGRlciBjb3JlIHZlcnNpb25zIG11c3Qgc3RpbGwgYmUgYmxvY2tlZCBldmVuIHdoZW4gdGhleSBjYXJyeSBhIGRldiBzdWZmaXhcIixcbiAgKTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIDMuIHJlc291cmNlLWxvYWRlciBzeW5jcyBidW5kbGVkIHJlc291cmNlc1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoXCJpbml0UmVzb3VyY2VzIHN5bmNzIGV4dGVuc2lvbnMsIGFnZW50cywgYW5kIHNraWxscyB0byB0YXJnZXQgZGlyXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IHsgaW5pdFJlc291cmNlcywgcmVhZE1hbmFnZWRSZXNvdXJjZVZlcnNpb24gfSA9IGF3YWl0IGltcG9ydChcIi4uL3Jlc291cmNlLWxvYWRlci50c1wiKTtcbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcmVzb3VyY2VzLXRlc3QtXCIpKTtcbiAgY29uc3QgZmFrZUFnZW50RGlyID0gam9pbih0bXAsIFwiYWdlbnRcIik7XG5cbiAgaW5pdFJlc291cmNlcyhmYWtlQWdlbnREaXIpO1xuXG4gIC8vIEV4dGVuc2lvbnMgc3luY2VkXG4gIGFzc2VydEV4dGVuc2lvbkluZGV4RXhpc3RzKGZha2VBZ2VudERpciwgXCJnc2RcIik7XG4gIGFzc2VydEV4dGVuc2lvbkluZGV4RXhpc3RzKGZha2VBZ2VudERpciwgXCJicm93c2VyLXRvb2xzXCIpO1xuICBhc3NlcnRFeHRlbnNpb25JbmRleEV4aXN0cyhmYWtlQWdlbnREaXIsIFwic2VhcmNoLXRoZS13ZWJcIik7XG4gIGFzc2VydEV4dGVuc2lvbkluZGV4RXhpc3RzKGZha2VBZ2VudERpciwgXCJjb250ZXh0N1wiKTtcbiAgYXNzZXJ0RXh0ZW5zaW9uSW5kZXhFeGlzdHMoZmFrZUFnZW50RGlyLCBcInN1YmFnZW50XCIpO1xuXG4gIC8vIEFnZW50cyBzeW5jZWRcbiAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoam9pbihmYWtlQWdlbnREaXIsIFwiYWdlbnRzXCIsIFwic2NvdXQubWRcIikpLCBcInNjb3V0IGFnZW50IHN5bmNlZFwiKTtcblxuICAvLyBTa2lsbHMgYXJlIE5PVCBzeW5jZWQgaGVyZSBcdTIwMTQgdGhleSB1c2Ugfi8uYWdlbnRzL3NraWxscy8gdmlhIHNraWxscy5zaFxuXG4gIC8vIFZlcnNpb24gbWFuaWZlc3Qgc3luY2VkXG4gIGNvbnN0IG1hbmFnZWRWZXJzaW9uID0gcmVhZE1hbmFnZWRSZXNvdXJjZVZlcnNpb24oZmFrZUFnZW50RGlyKTtcbiAgYXNzZXJ0Lm9rKG1hbmFnZWRWZXJzaW9uLCBcIm1hbmFnZWQgcmVzb3VyY2UgdmVyc2lvbiB3cml0dGVuXCIpO1xuXG4gIC8vIElkZW1wb3RlbnQ6IHJ1biBhZ2Fpbiwgbm8gY3Jhc2hcbiAgaW5pdFJlc291cmNlcyhmYWtlQWdlbnREaXIpO1xuICBhc3NlcnRFeHRlbnNpb25JbmRleEV4aXN0cyhmYWtlQWdlbnREaXIsIFwiZ3NkXCIpO1xufSk7XG5cbnRlc3QoXCJpbml0UmVzb3VyY2VzIHNraXBzIGNvcHkgd2hlbiBtYW5hZ2VkIHZlcnNpb24gbWF0Y2hlcyBjdXJyZW50IHZlcnNpb25cIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgeyBpbml0UmVzb3VyY2VzLCByZWFkTWFuYWdlZFJlc291cmNlVmVyc2lvbiB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vcmVzb3VyY2UtbG9hZGVyLnRzXCIpO1xuICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1yZXNvdXJjZXMtc2tpcC1cIikpO1xuICBjb25zdCBmYWtlQWdlbnREaXIgPSBqb2luKHRtcCwgXCJhZ2VudFwiKTtcblxuICB0LmFmdGVyKCgpID0+IHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG4gIC8vIEZpcnN0IHJ1bjogZnVsbCBzeW5jIChubyBtYW5pZmVzdCB5ZXQpXG4gIGluaXRSZXNvdXJjZXMoZmFrZUFnZW50RGlyKTtcbiAgY29uc3QgdmVyc2lvbiA9IHJlYWRNYW5hZ2VkUmVzb3VyY2VWZXJzaW9uKGZha2VBZ2VudERpcik7XG4gIGFzc2VydC5vayh2ZXJzaW9uLCBcIm1hbmlmZXN0IHdyaXR0ZW4gYWZ0ZXIgZmlyc3Qgc3luY1wiKTtcblxuICAvLyBBZGQgYSBtYXJrZXIgZmlsZSB0byBkZXRlY3Qgd2hldGhlciBzeW5jIHJ1bnMgYWdhaW5cbiAgY29uc3QgbWFya2VyUGF0aCA9IGpvaW4oZmFrZUFnZW50RGlyLCBcImV4dGVuc2lvbnNcIiwgXCJnc2RcIiwgXCJfbWFya2VyLnR4dFwiKTtcbiAgd3JpdGVGaWxlU3luYyhtYXJrZXJQYXRoLCBcInRlc3QtbWFya2VyXCIpO1xuXG4gIC8vIFNlY29uZCBydW46IHZlcnNpb24gbWF0Y2hlcyBcdTIwMTQgc2hvdWxkIHNraXAsIG1hcmtlciBzdXJ2aXZlc1xuICBpbml0UmVzb3VyY2VzKGZha2VBZ2VudERpcik7XG4gIGFzc2VydC5vayhleGlzdHNTeW5jKG1hcmtlclBhdGgpLCBcIm1hcmtlciBmaWxlIHN1cnZpdmVzIHdoZW4gdmVyc2lvbiBtYXRjaGVzIChzeW5jIHNraXBwZWQpXCIpO1xuXG4gIC8vIFNpbXVsYXRlIHZlcnNpb24gbWlzbWF0Y2ggYnkgd3JpdGluZyBvbGRlciB2ZXJzaW9uIHRvIG1hbmlmZXN0XG4gIGNvbnN0IG1hbmlmZXN0UGF0aCA9IGpvaW4oZmFrZUFnZW50RGlyLCBcIm1hbmFnZWQtcmVzb3VyY2VzLmpzb25cIik7XG4gIHdyaXRlRmlsZVN5bmMobWFuaWZlc3RQYXRoLCBKU09OLnN0cmluZ2lmeSh7IGdzZFZlcnNpb246IFwiMC4wLjFcIiwgc3luY2VkQXQ6IERhdGUubm93KCkgfSkpO1xuXG4gIC8vIFRoaXJkIHJ1bjogdmVyc2lvbiBtaXNtYXRjaCBcdTIwMTQgZnVsbCBzeW5jLCBtYXJrZXIgcmVtb3ZlZFxuICBpbml0UmVzb3VyY2VzKGZha2VBZ2VudERpcik7XG4gIGFzc2VydC5vayghZXhpc3RzU3luYyhtYXJrZXJQYXRoKSwgXCJtYXJrZXIgZmlsZSByZW1vdmVkIGFmdGVyIHZlcnNpb24tbWlzbWF0Y2ggc3luY1wiKTtcblxuICAvLyBNYW5pZmVzdCB1cGRhdGVkIHRvIGN1cnJlbnQgdmVyc2lvblxuICBjb25zdCB1cGRhdGVkVmVyc2lvbiA9IHJlYWRNYW5hZ2VkUmVzb3VyY2VWZXJzaW9uKGZha2VBZ2VudERpcik7XG4gIGFzc2VydC5zdHJpY3RFcXVhbCh1cGRhdGVkVmVyc2lvbiwgdmVyc2lvbiwgXCJtYW5pZmVzdCB1cGRhdGVkIHRvIGN1cnJlbnQgdmVyc2lvbiBhZnRlciBzeW5jXCIpO1xufSk7XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gNC4gd2l6YXJkIGxvYWRTdG9yZWRFbnZLZXlzIGh5ZHJhdGlvblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoXCJsb2FkU3RvcmVkRW52S2V5cyBoeWRyYXRlcyBwcm9jZXNzLmVudiBmcm9tIGF1dGguanNvblwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCB7IGxvYWRTdG9yZWRFbnZLZXlzIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi93aXphcmQudHNcIik7XG4gIGNvbnN0IHsgQXV0aFN0b3JhZ2UgfSA9IGF3YWl0IGltcG9ydChcIkBnc2QvcGktY29kaW5nLWFnZW50XCIpO1xuXG4gIGNvbnN0IHRtcCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXdpemFyZC10ZXN0LVwiKSk7XG4gIGNvbnN0IGF1dGhQYXRoID0gam9pbih0bXAsIFwiYXV0aC5qc29uXCIpO1xuICB3cml0ZUZpbGVTeW5jKGF1dGhQYXRoLCBKU09OLnN0cmluZ2lmeSh7XG4gICAgYnJhdmU6IHsgdHlwZTogXCJhcGlfa2V5XCIsIGtleTogXCJ0ZXN0LWJyYXZlLWtleVwiIH0sXG4gICAgYnJhdmVfYW5zd2VyczogeyB0eXBlOiBcImFwaV9rZXlcIiwga2V5OiBcInRlc3QtYW5zd2Vycy1rZXlcIiB9LFxuICAgIGNvbnRleHQ3OiB7IHR5cGU6IFwiYXBpX2tleVwiLCBrZXk6IFwidGVzdC1jdHg3LWtleVwiIH0sXG4gICAgdGF2aWx5OiB7IHR5cGU6IFwiYXBpX2tleVwiLCBrZXk6IFwidGVzdC10YXZpbHkta2V5XCIgfSxcbiAgICB0ZWxlZ3JhbV9ib3Q6IHsgdHlwZTogXCJhcGlfa2V5XCIsIGtleTogXCJ0ZXN0LXRlbGVncmFtLWtleVwiIH0sXG4gICAgXCJjdXN0b20tb3BlbmFpXCI6IHsgdHlwZTogXCJhcGlfa2V5XCIsIGtleTogXCJ0ZXN0LWN1c3RvbS1vcGVuYWkta2V5XCIgfSxcbiAgfSkpO1xuXG4gIC8vIENsZWFyIGFueSBleGlzdGluZyBlbnYgdmFyc1xuICBjb25zdCBlbnZWYXJzVG9SZXN0b3JlID0gW1xuICAgIFwiQlJBVkVfQVBJX0tFWVwiLCBcIkJSQVZFX0FOU1dFUlNfS0VZXCIsIFwiQ09OVEVYVDdfQVBJX0tFWVwiLFxuICAgIFwiSklOQV9BUElfS0VZXCIsIFwiVEFWSUxZX0FQSV9LRVlcIiwgXCJURUxFR1JBTV9CT1RfVE9LRU5cIixcbiAgICBcIkNVU1RPTV9PUEVOQUlfQVBJX0tFWVwiLFxuICBdO1xuICBjb25zdCBvcmlnVmFsdWVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWQ+ID0ge307XG4gIGZvciAoY29uc3QgdiBvZiBlbnZWYXJzVG9SZXN0b3JlKSB7XG4gICAgb3JpZ1ZhbHVlc1t2XSA9IHByb2Nlc3MuZW52W3ZdO1xuICAgIGRlbGV0ZSBwcm9jZXNzLmVudlt2XTtcbiAgfVxuXG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIGZvciAoY29uc3QgdiBvZiBlbnZWYXJzVG9SZXN0b3JlKSB7XG4gICAgaWYgKG9yaWdWYWx1ZXNbdl0pIHByb2Nlc3MuZW52W3ZdID0gb3JpZ1ZhbHVlc1t2XTsgZWxzZSBkZWxldGUgcHJvY2Vzcy5lbnZbdl07XG4gICAgfVxuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG4gIGNvbnN0IGF1dGggPSBBdXRoU3RvcmFnZS5jcmVhdGUoYXV0aFBhdGgpO1xuICBsb2FkU3RvcmVkRW52S2V5cyhhdXRoKTtcblxuICBhc3NlcnQuZXF1YWwocHJvY2Vzcy5lbnYuQlJBVkVfQVBJX0tFWSwgXCJ0ZXN0LWJyYXZlLWtleVwiLCBcIkJSQVZFX0FQSV9LRVkgaHlkcmF0ZWRcIik7XG4gIGFzc2VydC5lcXVhbChwcm9jZXNzLmVudi5CUkFWRV9BTlNXRVJTX0tFWSwgXCJ0ZXN0LWFuc3dlcnMta2V5XCIsIFwiQlJBVkVfQU5TV0VSU19LRVkgaHlkcmF0ZWRcIik7XG4gIGFzc2VydC5lcXVhbChwcm9jZXNzLmVudi5DT05URVhUN19BUElfS0VZLCBcInRlc3QtY3R4Ny1rZXlcIiwgXCJDT05URVhUN19BUElfS0VZIGh5ZHJhdGVkXCIpO1xuICBhc3NlcnQuZXF1YWwocHJvY2Vzcy5lbnYuSklOQV9BUElfS0VZLCB1bmRlZmluZWQsIFwiSklOQV9BUElfS0VZIG5vdCBzZXQgKG5vdCBpbiBhdXRoKVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHByb2Nlc3MuZW52LlRBVklMWV9BUElfS0VZLCBcInRlc3QtdGF2aWx5LWtleVwiLCBcIlRBVklMWV9BUElfS0VZIGh5ZHJhdGVkXCIpO1xuICBhc3NlcnQuZXF1YWwocHJvY2Vzcy5lbnYuVEVMRUdSQU1fQk9UX1RPS0VOLCBcInRlc3QtdGVsZWdyYW0ta2V5XCIsIFwiVEVMRUdSQU1fQk9UX1RPS0VOIGh5ZHJhdGVkXCIpO1xuICBhc3NlcnQuZXF1YWwocHJvY2Vzcy5lbnYuQ1VTVE9NX09QRU5BSV9BUElfS0VZLCBcInRlc3QtY3VzdG9tLW9wZW5haS1rZXlcIiwgXCJDVVNUT01fT1BFTkFJX0FQSV9LRVkgaHlkcmF0ZWRcIik7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyA1LiBsb2FkU3RvcmVkRW52S2V5cyBkb2VzIE5PVCBvdmVyd3JpdGUgZXhpc3RpbmcgZW52IHZhcnNcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG50ZXN0KFwibG9hZFN0b3JlZEVudktleXMgZG9lcyBub3Qgb3ZlcndyaXRlIGV4aXN0aW5nIGVudiB2YXJzXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IHsgbG9hZFN0b3JlZEVudktleXMgfSA9IGF3YWl0IGltcG9ydChcIi4uL3dpemFyZC50c1wiKTtcbiAgY29uc3QgeyBBdXRoU3RvcmFnZSB9ID0gYXdhaXQgaW1wb3J0KFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIik7XG5cbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtd2l6YXJkLW5vb3ZlcndyaXRlLVwiKSk7XG4gIGNvbnN0IGF1dGhQYXRoID0gam9pbih0bXAsIFwiYXV0aC5qc29uXCIpO1xuICB3cml0ZUZpbGVTeW5jKGF1dGhQYXRoLCBKU09OLnN0cmluZ2lmeSh7XG4gICAgYnJhdmU6IHsgdHlwZTogXCJhcGlfa2V5XCIsIGtleTogXCJzdG9yZWQta2V5XCIgfSxcbiAgfSkpO1xuXG4gIGNvbnN0IG9yaWdCcmF2ZSA9IHByb2Nlc3MuZW52LkJSQVZFX0FQSV9LRVk7XG4gIHByb2Nlc3MuZW52LkJSQVZFX0FQSV9LRVkgPSBcImV4aXN0aW5nLWVudi1rZXlcIjtcblxuICB0LmFmdGVyKCgpID0+IHtcbiAgICBpZiAob3JpZ0JyYXZlKSBwcm9jZXNzLmVudi5CUkFWRV9BUElfS0VZID0gb3JpZ0JyYXZlOyBlbHNlIGRlbGV0ZSBwcm9jZXNzLmVudi5CUkFWRV9BUElfS0VZO1xuICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG4gIGNvbnN0IGF1dGggPSBBdXRoU3RvcmFnZS5jcmVhdGUoYXV0aFBhdGgpO1xuICBsb2FkU3RvcmVkRW52S2V5cyhhdXRoKTtcblxuICBhc3NlcnQuZXF1YWwocHJvY2Vzcy5lbnYuQlJBVkVfQVBJX0tFWSwgXCJleGlzdGluZy1lbnYta2V5XCIsIFwiZXhpc3RpbmcgZW52IHZhciBub3Qgb3ZlcndyaXR0ZW5cIik7XG59KTtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyA2LiBTdGF0ZSBkZXJpdmF0aW9uIFx1MjAxNCBHYXAgMlxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoXCJkZXJpdmVTdGF0ZSByZXR1cm5zIHByZS1wbGFubmluZyBwaGFzZSBmb3IgZW1wdHkgLmdzZC8gZGlyZWN0b3J5XCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IHsgZGVyaXZlU3RhdGUgfSA9IGF3YWl0IGltcG9ydChcIi4uL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9zdGF0ZS50c1wiKTtcbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtc3RhdGUtc21va2UtXCIpKTtcblxuICAvLyBDcmVhdGUgbWluaW1hbCAuZ3NkLyBzdHJ1Y3R1cmUgd2l0aCBubyBtaWxlc3RvbmVzXG4gIG1rZGlyU3luYyhqb2luKHRtcCwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICB0LmFmdGVyKCgpID0+IHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG4gIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUodG1wKTtcblxuICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwicHJlLXBsYW5uaW5nXCIsXG4gICAgYGV4cGVjdGVkIHByZS1wbGFubmluZyBwaGFzZSBmb3IgZW1wdHkgLmdzZC8sIGdvdDogJHtzdGF0ZS5waGFzZX1gKTtcbiAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZSwgbnVsbCwgXCJubyBhY3RpdmUgbWlsZXN0b25lXCIpO1xuICBhc3NlcnQuZXF1YWwoc3RhdGUuYWN0aXZlU2xpY2UsIG51bGwsIFwibm8gYWN0aXZlIHNsaWNlXCIpO1xuICBhc3NlcnQuZXF1YWwoc3RhdGUuYWN0aXZlVGFzaywgbnVsbCwgXCJubyBhY3RpdmUgdGFza1wiKTtcbiAgYXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkoc3RhdGUuYmxvY2tlcnMpLCBcImJsb2NrZXJzIGlzIGFuIGFycmF5XCIpO1xuICBhc3NlcnQub2soQXJyYXkuaXNBcnJheShzdGF0ZS5yZWdpc3RyeSksIFwicmVnaXN0cnkgaXMgYW4gYXJyYXlcIik7XG4gIGFzc2VydC5lcXVhbChzdGF0ZS5yZWdpc3RyeS5sZW5ndGgsIDAsIFwiZW1wdHkgcmVnaXN0cnlcIik7XG4gIGFzc2VydC5vayh0eXBlb2Ygc3RhdGUubmV4dEFjdGlvbiA9PT0gXCJzdHJpbmdcIiwgXCJuZXh0QWN0aW9uIGlzIGEgc3RyaW5nXCIpO1xuICBhc3NlcnQub2soc3RhdGUubmV4dEFjdGlvbi5sZW5ndGggPiAwLCBcIm5leHRBY3Rpb24gaXMgbm9uLWVtcHR5XCIpO1xufSk7XG5cbnRlc3QoXCJkZXJpdmVTdGF0ZSByZXR1cm5zIHByZS1wbGFubmluZyBwaGFzZSB3aGVuIG5vIC5nc2QvIGRpcmVjdG9yeSBleGlzdHNcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgeyBkZXJpdmVTdGF0ZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3N0YXRlLnRzXCIpO1xuICAvLyBVc2UgYSB0ZW1wIGRpciB3aXRoIG5vIC5nc2QvIHN1YmRpcmVjdG9yeSBhdCBhbGxcbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtc3RhdGUtbm9nc2QtXCIpKTtcblxuICB0LmFmdGVyKCgpID0+IHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG4gIC8vIFNob3VsZCBub3QgdGhyb3cgXHUyMDE0IG1pc3NpbmcgLmdzZC8gaXMgYSB2YWxpZCBcIm5vIHByb2plY3RcIiBzdGF0ZVxuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKHRtcCk7XG5cbiAgYXNzZXJ0LmVxdWFsKHN0YXRlLnBoYXNlLCBcInByZS1wbGFubmluZ1wiLFxuICAgIGBleHBlY3RlZCBwcmUtcGxhbm5pbmcgcGhhc2Ugd2hlbiAuZ3NkLyBhYnNlbnQsIGdvdDogJHtzdGF0ZS5waGFzZX1gKTtcbiAgYXNzZXJ0LmVxdWFsKHN0YXRlLmFjdGl2ZU1pbGVzdG9uZSwgbnVsbCwgXCJubyBhY3RpdmUgbWlsZXN0b25lXCIpO1xufSk7XG5cbnRlc3QoXCJkZXJpdmVTdGF0ZSBzaGFwZSBpcyBzdHJ1Y3R1cmFsbHkgY29tcGxldGVcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgeyBkZXJpdmVTdGF0ZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3N0YXRlLnRzXCIpO1xuICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1zdGF0ZS1zaGFwZS1cIikpO1xuICBta2RpclN5bmMoam9pbih0bXAsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgdC5hZnRlcigoKSA9PiBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKHRtcCk7XG5cbiAgLy8gQWxsIHJlcXVpcmVkIGZpZWxkcyBwcmVzZW50XG4gIGNvbnN0IHJlcXVpcmVkRmllbGRzID0gW1xuICAgIFwicGhhc2VcIiwgXCJhY3RpdmVNaWxlc3RvbmVcIiwgXCJhY3RpdmVTbGljZVwiLCBcImFjdGl2ZVRhc2tcIixcbiAgICBcInJlY2VudERlY2lzaW9uc1wiLCBcImJsb2NrZXJzXCIsIFwibmV4dEFjdGlvblwiLCBcInJlZ2lzdHJ5XCIsXG4gIF0gYXMgY29uc3Q7XG4gIGZvciAoY29uc3QgZmllbGQgb2YgcmVxdWlyZWRGaWVsZHMpIHtcbiAgICBhc3NlcnQub2soZmllbGQgaW4gc3RhdGUsIGBzdGF0ZS4ke2ZpZWxkfSBzaG91bGQgYmUgcHJlc2VudGApO1xuICB9XG5cbiAgLy8gcGhhc2UgaXMgYSBrbm93biBzdHJpbmcgdmFsdWVcbiAgY29uc3QgdmFsaWRQaGFzZXMgPSBbXG4gICAgXCJwcmUtcGxhbm5pbmdcIiwgXCJuZWVkcy1kaXNjdXNzaW9uXCIsIFwicmVzZWFyY2hpbmdcIiwgXCJwbGFubmluZ1wiLFxuICAgIFwiZXhlY3V0aW5nXCIsIFwic3VtbWFyaXppbmdcIiwgXCJyZXBsYW5uaW5nLXNsaWNlXCIsIFwidmFsaWRhdGluZy1taWxlc3RvbmVcIixcbiAgICBcImNvbXBsZXRpbmctbWlsZXN0b25lXCIsIFwiY29tcGxldGVcIiwgXCJibG9ja2VkXCIsXG4gIF07XG4gIGFzc2VydC5vayh2YWxpZFBoYXNlcy5pbmNsdWRlcyhzdGF0ZS5waGFzZSksXG4gICAgYHN0YXRlLnBoYXNlICcke3N0YXRlLnBoYXNlfScgc2hvdWxkIGJlIGEga25vd24gcGhhc2VgKTtcbn0pO1xuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIDcuIERvY3RvciBoZWFsdGggY2hlY2tzIFx1MjAxNCBHYXAgM1xuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG5cbnRlc3QoXCJydW5HU0REb2N0b3IgY29tcGxldGVzIHdpdGhvdXQgdGhyb3dpbmcgb24gZW1wdHkgLmdzZC8gZGlyZWN0b3J5XCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IHsgcnVuR1NERG9jdG9yIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvZG9jdG9yLnRzXCIpO1xuICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1kb2N0b3Itc21va2UtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4odG1wLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcbiAgLy8gYXVkaXQtb25seSBtb2RlIChmaXg6IGZhbHNlKSBcdTIwMTQgc2hvdWxkIG5ldmVyIHRocm93XG4gIGNvbnN0IHJlcG9ydCA9IGF3YWl0IHJ1bkdTRERvY3Rvcih0bXAsIHsgZml4OiBmYWxzZSB9KTtcblxuICAvLyBTdHJ1Y3R1cmFsIGFzc2VydGlvbnMgb24gdGhlIERvY3RvclJlcG9ydFxuICBhc3NlcnQub2sodHlwZW9mIHJlcG9ydCA9PT0gXCJvYmplY3RcIiAmJiByZXBvcnQgIT09IG51bGwsIFwicmVwb3J0IGlzIGFuIG9iamVjdFwiKTtcbiAgYXNzZXJ0Lm9rKFwib2tcIiBpbiByZXBvcnQsIFwicmVwb3J0IGhhcyBvayBmaWVsZFwiKTtcbiAgYXNzZXJ0Lm9rKFwiaXNzdWVzXCIgaW4gcmVwb3J0LCBcInJlcG9ydCBoYXMgaXNzdWVzIGZpZWxkXCIpO1xuICBhc3NlcnQub2soXCJmaXhlc0FwcGxpZWRcIiBpbiByZXBvcnQsIFwicmVwb3J0IGhhcyBmaXhlc0FwcGxpZWQgZmllbGRcIik7XG4gIGFzc2VydC5vayhcImJhc2VQYXRoXCIgaW4gcmVwb3J0LCBcInJlcG9ydCBoYXMgYmFzZVBhdGggZmllbGRcIik7XG4gIGFzc2VydC5vayhBcnJheS5pc0FycmF5KHJlcG9ydC5pc3N1ZXMpLCBcInJlcG9ydC5pc3N1ZXMgaXMgYW4gYXJyYXlcIik7XG4gIGFzc2VydC5vayhBcnJheS5pc0FycmF5KHJlcG9ydC5maXhlc0FwcGxpZWQpLCBcInJlcG9ydC5maXhlc0FwcGxpZWQgaXMgYW4gYXJyYXlcIik7XG4gIGFzc2VydC5lcXVhbCh0eXBlb2YgcmVwb3J0Lm9rLCBcImJvb2xlYW5cIiwgXCJyZXBvcnQub2sgaXMgYSBib29sZWFuXCIpO1xuICBhc3NlcnQuZXF1YWwocmVwb3J0LmZpeGVzQXBwbGllZC5sZW5ndGgsIDAsIFwibm8gZml4ZXMgYXBwbGllZCBpbiBhdWRpdCBtb2RlXCIpO1xufSk7XG5cbnRlc3QoXCJydW5HU0REb2N0b3IgaXNzdWUgb2JqZWN0cyBoYXZlIHJlcXVpcmVkIGZpZWxkc1wiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCB7IHJ1bkdTRERvY3RvciB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2RvY3Rvci50c1wiKTtcbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZG9jdG9yLWZpZWxkcy1cIikpO1xuICBta2RpclN5bmMoam9pbih0bXAsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgLy8gQ3JlYXRlIGEgbWlsZXN0b25lIGRpciB3aXRoIG5vIFJPQURNQVAubWQgdG8gZm9yY2UgYSBtaXNzaW5nX3JvYWRtYXAgaXNzdWVcbiAgY29uc3QgbURpciA9IGpvaW4odG1wLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKTtcbiAgbWtkaXJTeW5jKG1EaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4obURpciwgXCJNMDAxLUNPTlRFWFQubWRcIiksIFwiIyBDb250ZXh0XFxuXCIpO1xuXG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcbiAgY29uc3QgcmVwb3J0ID0gYXdhaXQgcnVuR1NERG9jdG9yKHRtcCwgeyBmaXg6IGZhbHNlIH0pO1xuXG4gIC8vIFNob3VsZCBmaW5kIGF0IGxlYXN0IG9uZSBpc3N1ZSAobWlzc2luZyByb2FkbWFwIGZvciBNMDAxKVxuICBhc3NlcnQub2socmVwb3J0Lmlzc3Vlcy5sZW5ndGggPiAwLCBcImV4cGVjdGVkIGF0IGxlYXN0IG9uZSBpc3N1ZSBmb3IgbWlsZXN0b25lIG1pc3NpbmcgUk9BRE1BUC5tZFwiKTtcblxuICAvLyBWZXJpZnkgc3RydWN0dXJlIG9mIGVhY2ggaXNzdWVcbiAgZm9yIChjb25zdCBpc3N1ZSBvZiByZXBvcnQuaXNzdWVzKSB7XG4gICAgYXNzZXJ0Lm9rKHR5cGVvZiBpc3N1ZS5zZXZlcml0eSA9PT0gXCJzdHJpbmdcIiwgXCJpc3N1ZS5zZXZlcml0eSBpcyBhIHN0cmluZ1wiKTtcbiAgICBhc3NlcnQub2soW1wiaW5mb1wiLCBcIndhcm5pbmdcIiwgXCJlcnJvclwiXS5pbmNsdWRlcyhpc3N1ZS5zZXZlcml0eSksXG4gICAgICBgaXNzdWUuc2V2ZXJpdHkgJyR7aXNzdWUuc2V2ZXJpdHl9JyBzaG91bGQgYmUgaW5mb3x3YXJuaW5nfGVycm9yYCk7XG4gICAgYXNzZXJ0Lm9rKHR5cGVvZiBpc3N1ZS5jb2RlID09PSBcInN0cmluZ1wiLCBcImlzc3VlLmNvZGUgaXMgYSBzdHJpbmdcIik7XG4gICAgYXNzZXJ0Lm9rKHR5cGVvZiBpc3N1ZS5tZXNzYWdlID09PSBcInN0cmluZ1wiLCBcImlzc3VlLm1lc3NhZ2UgaXMgYSBzdHJpbmdcIik7XG4gICAgYXNzZXJ0Lm9rKGlzc3VlLm1lc3NhZ2UubGVuZ3RoID4gMCwgXCJpc3N1ZS5tZXNzYWdlIGlzIG5vbi1lbXB0eVwiKTtcbiAgICBhc3NlcnQub2sodHlwZW9mIGlzc3VlLmZpeGFibGUgPT09IFwiYm9vbGVhblwiLCBcImlzc3VlLmZpeGFibGUgaXMgYSBib29sZWFuXCIpO1xuICB9XG59KTtcblxudGVzdChcInJ1bkdTRERvY3RvciB3aXRoIGZpeDpmYWxzZSBuZXZlciBtb2RpZmllcyB0aGUgZmlsZXN5c3RlbVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCB7IHJ1bkdTRERvY3RvciB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2RvY3Rvci50c1wiKTtcbiAgY29uc3QgdG1wID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZG9jdG9yLXJlYWRvbmx5LVwiKSk7XG4gIGNvbnN0IGdzZERpciA9IGpvaW4odG1wLCBcIi5nc2RcIik7XG4gIG1rZGlyU3luYyhnc2REaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIC8vIFdyaXRlIGEgc2VudGluZWwgZmlsZSBcdTIwMTQgZG9jdG9yIG11c3Qgbm90IGRlbGV0ZSBvciBtb2RpZnkgaXRcbiAgY29uc3Qgc2VudGluZWxQYXRoID0gam9pbihnc2REaXIsIFwiU0VOVElORUwubWRcIik7XG4gIHdyaXRlRmlsZVN5bmMoc2VudGluZWxQYXRoLCBcIiMgc2VudGluZWxcXG5cIik7XG5cbiAgdC5hZnRlcigoKSA9PiBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuICBhd2FpdCBydW5HU0REb2N0b3IodG1wLCB7IGZpeDogZmFsc2UgfSk7XG5cbiAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoc2VudGluZWxQYXRoKSwgXCJzZW50aW5lbCBmaWxlIHN0aWxsIGV4aXN0cyBhZnRlciBhdWRpdC1vbmx5IHJ1blwiKTtcbiAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhzZW50aW5lbFBhdGgsIFwidXRmLThcIik7XG4gIGFzc2VydC5lcXVhbChjb250ZW50LCBcIiMgc2VudGluZWxcXG5cIiwgXCJzZW50aW5lbCBmaWxlIGNvbnRlbnQgdW5jaGFuZ2VkXCIpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFZQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsZ0JBQWdCO0FBQ3pCLFNBQVMsWUFBWSxXQUFXLGFBQWEsY0FBYyxRQUFRLHFCQUFxQjtBQUN4RixTQUFvQixZQUFZO0FBQ2hDLFNBQVMsY0FBYztBQUN2QixTQUFTLHFCQUFxQjtBQUU5QixNQUFNLGNBQWMsS0FBSyxjQUFjLFlBQVksR0FBRyxHQUFHLE1BQU0sTUFBTSxJQUFJO0FBRXpFLFNBQVMsMkJBQTJCLFVBQWtCLGVBQTZCO0FBQ2pGLFNBQU87QUFB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
