import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkExistingEnvKeys,
  detectDestination,
  writeEnvKey,
  applySecrets,
  isSecuritySensitiveEnvKey,
  isSafeEnvVarKey,
  isSupportedDeploymentEnvironment,
  resolveProjectEnvFilePath,
  shellEscapeSingle
} from "./env-writer.js";
function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}
describe("checkExistingEnvKeys", () => {
  it("finds key in .env file", async () => {
    const tmp = makeTempDir("env-check");
    try {
      const envPath = join(tmp, ".env");
      writeFileSync(envPath, "API_KEY=secret123\nOTHER=val\n");
      const result = await checkExistingEnvKeys(["API_KEY"], envPath);
      assert.deepStrictEqual(result, ["API_KEY"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("finds key in process.env", async () => {
    const tmp = makeTempDir("env-check");
    const saved = process.env.GSD_MCP_TEST_KEY_1;
    try {
      process.env.GSD_MCP_TEST_KEY_1 = "some-value";
      const envPath = join(tmp, ".env");
      const result = await checkExistingEnvKeys(["GSD_MCP_TEST_KEY_1"], envPath);
      assert.deepStrictEqual(result, ["GSD_MCP_TEST_KEY_1"]);
    } finally {
      delete process.env.GSD_MCP_TEST_KEY_1;
      if (saved !== void 0) process.env.GSD_MCP_TEST_KEY_1 = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("returns empty for missing keys", async () => {
    const tmp = makeTempDir("env-check");
    try {
      const envPath = join(tmp, ".env");
      writeFileSync(envPath, "OTHER=val\n");
      delete process.env.DEFINITELY_NOT_SET_MCP_XYZ;
      const result = await checkExistingEnvKeys(["DEFINITELY_NOT_SET_MCP_XYZ"], envPath);
      assert.deepStrictEqual(result, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("handles missing .env file gracefully", async () => {
    const tmp = makeTempDir("env-check");
    try {
      const envPath = join(tmp, "nonexistent.env");
      delete process.env.DEFINITELY_NOT_SET_MCP_XYZ;
      const result = await checkExistingEnvKeys(["DEFINITELY_NOT_SET_MCP_XYZ"], envPath);
      assert.deepStrictEqual(result, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
describe("detectDestination", () => {
  it("returns vercel when vercel.json exists", () => {
    const tmp = makeTempDir("dest");
    try {
      writeFileSync(join(tmp, "vercel.json"), "{}");
      assert.equal(detectDestination(tmp), "vercel");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("returns convex when convex/ dir exists", () => {
    const tmp = makeTempDir("dest");
    try {
      mkdirSync(join(tmp, "convex"));
      assert.equal(detectDestination(tmp), "convex");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("returns dotenv when neither exists", () => {
    const tmp = makeTempDir("dest");
    try {
      assert.equal(detectDestination(tmp), "dotenv");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("vercel takes priority over convex", () => {
    const tmp = makeTempDir("dest");
    try {
      writeFileSync(join(tmp, "vercel.json"), "{}");
      mkdirSync(join(tmp, "convex"));
      assert.equal(detectDestination(tmp), "vercel");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
describe("writeEnvKey", () => {
  it("creates .env file with new key", async () => {
    const tmp = makeTempDir("write");
    try {
      const envPath = join(tmp, ".env");
      await writeEnvKey(envPath, "NEW_KEY", "new-value");
      const content = readFileSync(envPath, "utf8");
      assert.ok(content.includes("NEW_KEY=new-value"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("updates existing key in-place", async () => {
    const tmp = makeTempDir("write");
    try {
      const envPath = join(tmp, ".env");
      writeFileSync(envPath, "EXISTING=old\nOTHER=keep\n");
      await writeEnvKey(envPath, "EXISTING", "new");
      const content = readFileSync(envPath, "utf8");
      assert.ok(content.includes("EXISTING=new"));
      assert.ok(content.includes("OTHER=keep"));
      assert.ok(!content.includes("old"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("escapes newlines in values", async () => {
    const tmp = makeTempDir("write");
    try {
      const envPath = join(tmp, ".env");
      await writeEnvKey(envPath, "MULTI", "line1\nline2");
      const content = readFileSync(envPath, "utf8");
      assert.ok(content.includes("MULTI=line1\\nline2"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("rejects non-string values", async () => {
    const tmp = makeTempDir("write");
    try {
      const envPath = join(tmp, ".env");
      await assert.rejects(
        () => writeEnvKey(envPath, "KEY", void 0),
        /expects a string value/
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("does not follow symlinked env files when writing", async () => {
    const tmp = makeTempDir("write");
    const outside = makeTempDir("write-outside");
    try {
      const outsideEnv = join(outside, ".env");
      writeFileSync(outsideEnv, "SECRET=outside\n");
      symlinkSync(outsideEnv, join(tmp, ".env"));
      await assert.rejects(
        () => writeEnvKey(join(tmp, ".env"), "SECRET", "inside"),
        /ELOOP|symbolic link|symlink/i
      );
      assert.equal(readFileSync(outsideEnv, "utf8"), "SECRET=outside\n");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
describe("resolveProjectEnvFilePath", () => {
  it("allows .env under the project root", () => {
    const tmp = makeTempDir("env-path");
    try {
      assert.equal(resolveProjectEnvFilePath(tmp, ".env"), join(realpathSync.native(tmp), ".env"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("rejects envFilePath outside the project root", () => {
    const tmp = makeTempDir("env-path");
    try {
      assert.throws(
        () => resolveProjectEnvFilePath(tmp, "../outside.env"),
        /inside the project directory/
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("rejects symlinked parent directories that escape the project root", () => {
    const tmp = makeTempDir("env-path");
    const outside = makeTempDir("env-path-outside");
    try {
      symlinkSync(outside, join(tmp, "linked-outside"), "dir");
      assert.throws(
        () => resolveProjectEnvFilePath(tmp, "linked-outside/.env"),
        /inside the project directory/
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it("rejects existing env files that are symlinks outside the project root", () => {
    const tmp = makeTempDir("env-path");
    const outside = makeTempDir("env-path-outside");
    try {
      writeFileSync(join(outside, ".env"), "SECRET=outside\n");
      symlinkSync(join(outside, ".env"), join(tmp, ".env"));
      assert.throws(
        () => resolveProjectEnvFilePath(tmp, ".env"),
        /inside the project directory/
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
describe("applySecrets", () => {
  const savedKeys = {};
  afterEach(() => {
    for (const [k, v] of Object.entries(savedKeys)) {
      if (v === void 0) delete process.env[k];
      else process.env[k] = v;
    }
  });
  it("writes keys to .env and hydrates process.env", async () => {
    const tmp = makeTempDir("apply");
    const envPath = join(tmp, ".env");
    savedKeys.GSD_APPLY_TEST_A = process.env.GSD_APPLY_TEST_A;
    try {
      const { applied, errors } = await applySecrets(
        [{ key: "GSD_APPLY_TEST_A", value: "val-a" }],
        "dotenv",
        { envFilePath: envPath }
      );
      assert.deepStrictEqual(applied, ["GSD_APPLY_TEST_A"]);
      assert.deepStrictEqual(errors, []);
      assert.equal(process.env.GSD_APPLY_TEST_A, "val-a");
      const content = readFileSync(envPath, "utf8");
      assert.ok(content.includes("GSD_APPLY_TEST_A=val-a"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("rejects invalid dotenv keys before writing or hydrating", async () => {
    const tmp = makeTempDir("apply-invalid");
    const envPath = join(tmp, ".env");
    try {
      const { applied, errors } = await applySecrets(
        [{ key: "BAD-KEY", value: "val-a" }],
        "dotenv",
        { envFilePath: envPath }
      );
      assert.deepStrictEqual(applied, []);
      assert.deepStrictEqual(errors, ["BAD-KEY: invalid environment variable name"]);
      assert.throws(() => readFileSync(envPath, "utf8"), /ENOENT/);
      assert.equal(process.env["BAD-KEY"], void 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("rejects security-sensitive dotenv keys case-insensitively", async () => {
    const tmp = makeTempDir("apply-sensitive");
    const envPath = join(tmp, ".env");
    try {
      const { applied, errors } = await applySecrets(
        [{ key: "path", value: "malicious-bin" }],
        "dotenv",
        { envFilePath: envPath }
      );
      assert.deepStrictEqual(applied, []);
      assert.deepStrictEqual(errors, ["path: refusing to set MCP server runtime variable via secure_env_collect"]);
      assert.throws(() => readFileSync(envPath, "utf8"), /ENOENT/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("returns errors for invalid vercel environment", async () => {
    const tmp = makeTempDir("apply");
    try {
      const { applied, errors } = await applySecrets(
        [{ key: "KEY", value: "val" }],
        "vercel",
        {
          envFilePath: join(tmp, ".env"),
          environment: "staging",
          execFn: async () => ({ code: 0, stderr: "" })
        }
      );
      assert.deepStrictEqual(applied, []);
      assert.ok(errors[0]?.includes("unsupported"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("passes remote destination secrets on stdin instead of process arguments", async () => {
    const tmp = makeTempDir("apply-remote-stdin");
    const calls = [];
    try {
      const { applied, errors } = await applySecrets(
        [{ key: "REMOTE_SECRET", value: "super-secret-value" }],
        "vercel",
        {
          envFilePath: join(tmp, ".env"),
          environment: "preview",
          execFn: async (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return { code: 0, stderr: "" };
          }
        }
      );
      assert.deepStrictEqual(applied, ["REMOTE_SECRET"]);
      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual(calls, [
        {
          cmd: "vercel",
          args: ["env", "add", "REMOTE_SECRET", "preview"],
          opts: { stdin: "super-secret-value" }
        }
      ]);
      assert.ok(!calls[0].args.some((arg) => arg.includes("super-secret-value")));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
describe("isSafeEnvVarKey", () => {
  it("accepts valid keys", () => {
    assert.ok(isSafeEnvVarKey("API_KEY"));
    assert.ok(isSafeEnvVarKey("_PRIVATE"));
    assert.ok(isSafeEnvVarKey("key123"));
  });
  it("rejects invalid keys", () => {
    assert.ok(!isSafeEnvVarKey("123BAD"));
    assert.ok(!isSafeEnvVarKey("has-dash"));
    assert.ok(!isSafeEnvVarKey("has space"));
    assert.ok(!isSafeEnvVarKey(""));
  });
});
describe("isSecuritySensitiveEnvKey", () => {
  it("matches sensitive keys case-insensitively", () => {
    assert.ok(isSecuritySensitiveEnvKey("PATH"));
    assert.ok(isSecuritySensitiveEnvKey("path"));
    assert.ok(isSecuritySensitiveEnvKey("Node_Options"));
  });
});
describe("isSupportedDeploymentEnvironment", () => {
  it("accepts valid environments", () => {
    assert.ok(isSupportedDeploymentEnvironment("development"));
    assert.ok(isSupportedDeploymentEnvironment("preview"));
    assert.ok(isSupportedDeploymentEnvironment("production"));
  });
  it("rejects invalid environments", () => {
    assert.ok(!isSupportedDeploymentEnvironment("staging"));
    assert.ok(!isSupportedDeploymentEnvironment("test"));
  });
});
describe("shellEscapeSingle", () => {
  it("wraps in single quotes", () => {
    assert.equal(shellEscapeSingle("hello"), "'hello'");
  });
  it("escapes embedded single quotes", () => {
    assert.equal(shellEscapeSingle("it's"), "'it'\\''s'");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvbWNwLXNlcnZlci9zcmMvZW52LXdyaXRlci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBAZ3NkLWJ1aWxkL21jcC1zZXJ2ZXIgXHUyMDE0IFRlc3RzIGZvciBlbnYtd3JpdGVyIHV0aWxpdGllc1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGFmdGVyRWFjaCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMsIHJlYWRGaWxlU3luYywgcmVhbHBhdGhTeW5jLCBzeW1saW5rU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcblxuaW1wb3J0IHtcbiAgY2hlY2tFeGlzdGluZ0VudktleXMsXG4gIGRldGVjdERlc3RpbmF0aW9uLFxuICB3cml0ZUVudktleSxcbiAgYXBwbHlTZWNyZXRzLFxuICBpc1NlY3VyaXR5U2Vuc2l0aXZlRW52S2V5LFxuICBpc1NhZmVFbnZWYXJLZXksXG4gIGlzU3VwcG9ydGVkRGVwbG95bWVudEVudmlyb25tZW50LFxuICByZXNvbHZlUHJvamVjdEVudkZpbGVQYXRoLFxuICBzaGVsbEVzY2FwZVNpbmdsZSxcbn0gZnJvbSAnLi9lbnYtd3JpdGVyLmpzJztcblxuZnVuY3Rpb24gbWFrZVRlbXBEaXIocHJlZml4OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgYCR7cHJlZml4fS1gKSk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gY2hlY2tFeGlzdGluZ0VudktleXNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnY2hlY2tFeGlzdGluZ0VudktleXMnLCAoKSA9PiB7XG4gIGl0KCdmaW5kcyBrZXkgaW4gLmVudiBmaWxlJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKCdlbnYtY2hlY2snKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZW52UGF0aCA9IGpvaW4odG1wLCAnLmVudicpO1xuICAgICAgd3JpdGVGaWxlU3luYyhlbnZQYXRoLCAnQVBJX0tFWT1zZWNyZXQxMjNcXG5PVEhFUj12YWxcXG4nKTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNoZWNrRXhpc3RpbmdFbnZLZXlzKFsnQVBJX0tFWSddLCBlbnZQYXRoKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LCBbJ0FQSV9LRVknXSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KCdmaW5kcyBrZXkgaW4gcHJvY2Vzcy5lbnYnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoJ2Vudi1jaGVjaycpO1xuICAgIGNvbnN0IHNhdmVkID0gcHJvY2Vzcy5lbnYuR1NEX01DUF9URVNUX0tFWV8xO1xuICAgIHRyeSB7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfTUNQX1RFU1RfS0VZXzEgPSAnc29tZS12YWx1ZSc7XG4gICAgICBjb25zdCBlbnZQYXRoID0gam9pbih0bXAsICcuZW52Jyk7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjaGVja0V4aXN0aW5nRW52S2V5cyhbJ0dTRF9NQ1BfVEVTVF9LRVlfMSddLCBlbnZQYXRoKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LCBbJ0dTRF9NQ1BfVEVTVF9LRVlfMSddKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgZGVsZXRlIHByb2Nlc3MuZW52LkdTRF9NQ1BfVEVTVF9LRVlfMTtcbiAgICAgIGlmIChzYXZlZCAhPT0gdW5kZWZpbmVkKSBwcm9jZXNzLmVudi5HU0RfTUNQX1RFU1RfS0VZXzEgPSBzYXZlZDtcbiAgICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KCdyZXR1cm5zIGVtcHR5IGZvciBtaXNzaW5nIGtleXMnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoJ2Vudi1jaGVjaycpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBlbnZQYXRoID0gam9pbih0bXAsICcuZW52Jyk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGVudlBhdGgsICdPVEhFUj12YWxcXG4nKTtcbiAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5ERUZJTklURUxZX05PVF9TRVRfTUNQX1hZWjtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNoZWNrRXhpc3RpbmdFbnZLZXlzKFsnREVGSU5JVEVMWV9OT1RfU0VUX01DUF9YWVonXSwgZW52UGF0aCk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdCwgW10pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICBpdCgnaGFuZGxlcyBtaXNzaW5nIC5lbnYgZmlsZSBncmFjZWZ1bGx5JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKCdlbnYtY2hlY2snKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZW52UGF0aCA9IGpvaW4odG1wLCAnbm9uZXhpc3RlbnQuZW52Jyk7XG4gICAgICBkZWxldGUgcHJvY2Vzcy5lbnYuREVGSU5JVEVMWV9OT1RfU0VUX01DUF9YWVo7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjaGVja0V4aXN0aW5nRW52S2V5cyhbJ0RFRklOSVRFTFlfTk9UX1NFVF9NQ1BfWFlaJ10sIGVudlBhdGgpO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQsIFtdKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBkZXRlY3REZXN0aW5hdGlvblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmRlc2NyaWJlKCdkZXRlY3REZXN0aW5hdGlvbicsICgpID0+IHtcbiAgaXQoJ3JldHVybnMgdmVyY2VsIHdoZW4gdmVyY2VsLmpzb24gZXhpc3RzJywgKCkgPT4ge1xuICAgIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKCdkZXN0Jyk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbih0bXAsICd2ZXJjZWwuanNvbicpLCAne30nKTtcbiAgICAgIGFzc2VydC5lcXVhbChkZXRlY3REZXN0aW5hdGlvbih0bXApLCAndmVyY2VsJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KCdyZXR1cm5zIGNvbnZleCB3aGVuIGNvbnZleC8gZGlyIGV4aXN0cycsICgpID0+IHtcbiAgICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcignZGVzdCcpO1xuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMoam9pbih0bXAsICdjb252ZXgnKSk7XG4gICAgICBhc3NlcnQuZXF1YWwoZGV0ZWN0RGVzdGluYXRpb24odG1wKSwgJ2NvbnZleCcpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICBpdCgncmV0dXJucyBkb3RlbnYgd2hlbiBuZWl0aGVyIGV4aXN0cycsICgpID0+IHtcbiAgICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcignZGVzdCcpO1xuICAgIHRyeSB7XG4gICAgICBhc3NlcnQuZXF1YWwoZGV0ZWN0RGVzdGluYXRpb24odG1wKSwgJ2RvdGVudicpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICBpdCgndmVyY2VsIHRha2VzIHByaW9yaXR5IG92ZXIgY29udmV4JywgKCkgPT4ge1xuICAgIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKCdkZXN0Jyk7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbih0bXAsICd2ZXJjZWwuanNvbicpLCAne30nKTtcbiAgICAgIG1rZGlyU3luYyhqb2luKHRtcCwgJ2NvbnZleCcpKTtcbiAgICAgIGFzc2VydC5lcXVhbChkZXRlY3REZXN0aW5hdGlvbih0bXApLCAndmVyY2VsJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gd3JpdGVFbnZLZXlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnd3JpdGVFbnZLZXknLCAoKSA9PiB7XG4gIGl0KCdjcmVhdGVzIC5lbnYgZmlsZSB3aXRoIG5ldyBrZXknLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoJ3dyaXRlJyk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVudlBhdGggPSBqb2luKHRtcCwgJy5lbnYnKTtcbiAgICAgIGF3YWl0IHdyaXRlRW52S2V5KGVudlBhdGgsICdORVdfS0VZJywgJ25ldy12YWx1ZScpO1xuICAgICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhlbnZQYXRoLCAndXRmOCcpO1xuICAgICAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoJ05FV19LRVk9bmV3LXZhbHVlJykpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICBpdCgndXBkYXRlcyBleGlzdGluZyBrZXkgaW4tcGxhY2UnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoJ3dyaXRlJyk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVudlBhdGggPSBqb2luKHRtcCwgJy5lbnYnKTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoZW52UGF0aCwgJ0VYSVNUSU5HPW9sZFxcbk9USEVSPWtlZXBcXG4nKTtcbiAgICAgIGF3YWl0IHdyaXRlRW52S2V5KGVudlBhdGgsICdFWElTVElORycsICduZXcnKTtcbiAgICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoZW52UGF0aCwgJ3V0ZjgnKTtcbiAgICAgIGFzc2VydC5vayhjb250ZW50LmluY2x1ZGVzKCdFWElTVElORz1uZXcnKSk7XG4gICAgICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcygnT1RIRVI9a2VlcCcpKTtcbiAgICAgIGFzc2VydC5vayghY29udGVudC5pbmNsdWRlcygnb2xkJykpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICBpdCgnZXNjYXBlcyBuZXdsaW5lcyBpbiB2YWx1ZXMnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoJ3dyaXRlJyk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVudlBhdGggPSBqb2luKHRtcCwgJy5lbnYnKTtcbiAgICAgIGF3YWl0IHdyaXRlRW52S2V5KGVudlBhdGgsICdNVUxUSScsICdsaW5lMVxcbmxpbmUyJyk7XG4gICAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGVudlBhdGgsICd1dGY4Jyk7XG4gICAgICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcygnTVVMVEk9bGluZTFcXFxcbmxpbmUyJykpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICBpdCgncmVqZWN0cyBub24tc3RyaW5nIHZhbHVlcycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcignd3JpdGUnKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZW52UGF0aCA9IGpvaW4odG1wLCAnLmVudicpO1xuICAgICAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgICAgICgpID0+IHdyaXRlRW52S2V5KGVudlBhdGgsICdLRVknLCB1bmRlZmluZWQgYXMgdW5rbm93biBhcyBzdHJpbmcpLFxuICAgICAgICAvZXhwZWN0cyBhIHN0cmluZyB2YWx1ZS8sXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICBpdCgnZG9lcyBub3QgZm9sbG93IHN5bWxpbmtlZCBlbnYgZmlsZXMgd2hlbiB3cml0aW5nJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKCd3cml0ZScpO1xuICAgIGNvbnN0IG91dHNpZGUgPSBtYWtlVGVtcERpcignd3JpdGUtb3V0c2lkZScpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBvdXRzaWRlRW52ID0gam9pbihvdXRzaWRlLCAnLmVudicpO1xuICAgICAgd3JpdGVGaWxlU3luYyhvdXRzaWRlRW52LCAnU0VDUkVUPW91dHNpZGVcXG4nKTtcbiAgICAgIHN5bWxpbmtTeW5jKG91dHNpZGVFbnYsIGpvaW4odG1wLCAnLmVudicpKTtcblxuICAgICAgYXdhaXQgYXNzZXJ0LnJlamVjdHMoXG4gICAgICAgICgpID0+IHdyaXRlRW52S2V5KGpvaW4odG1wLCAnLmVudicpLCAnU0VDUkVUJywgJ2luc2lkZScpLFxuICAgICAgICAvRUxPT1B8c3ltYm9saWMgbGlua3xzeW1saW5rL2ksXG4gICAgICApO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlYWRGaWxlU3luYyhvdXRzaWRlRW52LCAndXRmOCcpLCAnU0VDUkVUPW91dHNpZGVcXG4nKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgcm1TeW5jKG91dHNpZGUsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gcmVzb2x2ZVByb2plY3RFbnZGaWxlUGF0aFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmRlc2NyaWJlKCdyZXNvbHZlUHJvamVjdEVudkZpbGVQYXRoJywgKCkgPT4ge1xuICBpdCgnYWxsb3dzIC5lbnYgdW5kZXIgdGhlIHByb2plY3Qgcm9vdCcsICgpID0+IHtcbiAgICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcignZW52LXBhdGgnKTtcbiAgICB0cnkge1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc29sdmVQcm9qZWN0RW52RmlsZVBhdGgodG1wLCAnLmVudicpLCBqb2luKHJlYWxwYXRoU3luYy5uYXRpdmUodG1wKSwgJy5lbnYnKSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KCdyZWplY3RzIGVudkZpbGVQYXRoIG91dHNpZGUgdGhlIHByb2plY3Qgcm9vdCcsICgpID0+IHtcbiAgICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcignZW52LXBhdGgnKTtcbiAgICB0cnkge1xuICAgICAgYXNzZXJ0LnRocm93cyhcbiAgICAgICAgKCkgPT4gcmVzb2x2ZVByb2plY3RFbnZGaWxlUGF0aCh0bXAsICcuLi9vdXRzaWRlLmVudicpLFxuICAgICAgICAvaW5zaWRlIHRoZSBwcm9qZWN0IGRpcmVjdG9yeS8sXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICBpdCgncmVqZWN0cyBzeW1saW5rZWQgcGFyZW50IGRpcmVjdG9yaWVzIHRoYXQgZXNjYXBlIHRoZSBwcm9qZWN0IHJvb3QnLCAoKSA9PiB7XG4gICAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoJ2Vudi1wYXRoJyk7XG4gICAgY29uc3Qgb3V0c2lkZSA9IG1ha2VUZW1wRGlyKCdlbnYtcGF0aC1vdXRzaWRlJyk7XG4gICAgdHJ5IHtcbiAgICAgIHN5bWxpbmtTeW5jKG91dHNpZGUsIGpvaW4odG1wLCAnbGlua2VkLW91dHNpZGUnKSwgJ2RpcicpO1xuICAgICAgYXNzZXJ0LnRocm93cyhcbiAgICAgICAgKCkgPT4gcmVzb2x2ZVByb2plY3RFbnZGaWxlUGF0aCh0bXAsICdsaW5rZWQtb3V0c2lkZS8uZW52JyksXG4gICAgICAgIC9pbnNpZGUgdGhlIHByb2plY3QgZGlyZWN0b3J5LyxcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgIHJtU3luYyhvdXRzaWRlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICBpdCgncmVqZWN0cyBleGlzdGluZyBlbnYgZmlsZXMgdGhhdCBhcmUgc3ltbGlua3Mgb3V0c2lkZSB0aGUgcHJvamVjdCByb290JywgKCkgPT4ge1xuICAgIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKCdlbnYtcGF0aCcpO1xuICAgIGNvbnN0IG91dHNpZGUgPSBtYWtlVGVtcERpcignZW52LXBhdGgtb3V0c2lkZScpO1xuICAgIHRyeSB7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ob3V0c2lkZSwgJy5lbnYnKSwgJ1NFQ1JFVD1vdXRzaWRlXFxuJyk7XG4gICAgICBzeW1saW5rU3luYyhqb2luKG91dHNpZGUsICcuZW52JyksIGpvaW4odG1wLCAnLmVudicpKTtcbiAgICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAgICgpID0+IHJlc29sdmVQcm9qZWN0RW52RmlsZVBhdGgodG1wLCAnLmVudicpLFxuICAgICAgICAvaW5zaWRlIHRoZSBwcm9qZWN0IGRpcmVjdG9yeS8sXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICBybVN5bmMob3V0c2lkZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBhcHBseVNlY3JldHMgKGRvdGVudilcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnYXBwbHlTZWNyZXRzJywgKCkgPT4ge1xuICBjb25zdCBzYXZlZEtleXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4gPSB7fTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKHNhdmVkS2V5cykpIHtcbiAgICAgIGlmICh2ID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudltrXTtcbiAgICAgIGVsc2UgcHJvY2Vzcy5lbnZba10gPSB2O1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoJ3dyaXRlcyBrZXlzIHRvIC5lbnYgYW5kIGh5ZHJhdGVzIHByb2Nlc3MuZW52JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKCdhcHBseScpO1xuICAgIGNvbnN0IGVudlBhdGggPSBqb2luKHRtcCwgJy5lbnYnKTtcbiAgICBzYXZlZEtleXMuR1NEX0FQUExZX1RFU1RfQSA9IHByb2Nlc3MuZW52LkdTRF9BUFBMWV9URVNUX0E7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgYXBwbGllZCwgZXJyb3JzIH0gPSBhd2FpdCBhcHBseVNlY3JldHMoXG4gICAgICAgIFt7IGtleTogJ0dTRF9BUFBMWV9URVNUX0EnLCB2YWx1ZTogJ3ZhbC1hJyB9XSxcbiAgICAgICAgJ2RvdGVudicsXG4gICAgICAgIHsgZW52RmlsZVBhdGg6IGVudlBhdGggfSxcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGFwcGxpZWQsIFsnR1NEX0FQUExZX1RFU1RfQSddKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZXJyb3JzLCBbXSk7XG4gICAgICBhc3NlcnQuZXF1YWwocHJvY2Vzcy5lbnYuR1NEX0FQUExZX1RFU1RfQSwgJ3ZhbC1hJyk7XG4gICAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGVudlBhdGgsICd1dGY4Jyk7XG4gICAgICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcygnR1NEX0FQUExZX1RFU1RfQT12YWwtYScpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoJ3JlamVjdHMgaW52YWxpZCBkb3RlbnYga2V5cyBiZWZvcmUgd3JpdGluZyBvciBoeWRyYXRpbmcnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdG1wID0gbWFrZVRlbXBEaXIoJ2FwcGx5LWludmFsaWQnKTtcbiAgICBjb25zdCBlbnZQYXRoID0gam9pbih0bXAsICcuZW52Jyk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgYXBwbGllZCwgZXJyb3JzIH0gPSBhd2FpdCBhcHBseVNlY3JldHMoXG4gICAgICAgIFt7IGtleTogJ0JBRC1LRVknLCB2YWx1ZTogJ3ZhbC1hJyB9XSxcbiAgICAgICAgJ2RvdGVudicsXG4gICAgICAgIHsgZW52RmlsZVBhdGg6IGVudlBhdGggfSxcbiAgICAgICk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGFwcGxpZWQsIFtdKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZXJyb3JzLCBbJ0JBRC1LRVk6IGludmFsaWQgZW52aXJvbm1lbnQgdmFyaWFibGUgbmFtZSddKTtcbiAgICAgIGFzc2VydC50aHJvd3MoKCkgPT4gcmVhZEZpbGVTeW5jKGVudlBhdGgsICd1dGY4JyksIC9FTk9FTlQvKTtcbiAgICAgIGFzc2VydC5lcXVhbChwcm9jZXNzLmVudlsnQkFELUtFWSddLCB1bmRlZmluZWQpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICBpdCgncmVqZWN0cyBzZWN1cml0eS1zZW5zaXRpdmUgZG90ZW52IGtleXMgY2FzZS1pbnNlbnNpdGl2ZWx5JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKCdhcHBseS1zZW5zaXRpdmUnKTtcbiAgICBjb25zdCBlbnZQYXRoID0gam9pbih0bXAsICcuZW52Jyk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgYXBwbGllZCwgZXJyb3JzIH0gPSBhd2FpdCBhcHBseVNlY3JldHMoXG4gICAgICAgIFt7IGtleTogJ3BhdGgnLCB2YWx1ZTogJ21hbGljaW91cy1iaW4nIH1dLFxuICAgICAgICAnZG90ZW52JyxcbiAgICAgICAgeyBlbnZGaWxlUGF0aDogZW52UGF0aCB9LFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYXBwbGllZCwgW10pO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChlcnJvcnMsIFsncGF0aDogcmVmdXNpbmcgdG8gc2V0IE1DUCBzZXJ2ZXIgcnVudGltZSB2YXJpYWJsZSB2aWEgc2VjdXJlX2Vudl9jb2xsZWN0J10pO1xuICAgICAgYXNzZXJ0LnRocm93cygoKSA9PiByZWFkRmlsZVN5bmMoZW52UGF0aCwgJ3V0ZjgnKSwgL0VOT0VOVC8pO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICBpdCgncmV0dXJucyBlcnJvcnMgZm9yIGludmFsaWQgdmVyY2VsIGVudmlyb25tZW50JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKCdhcHBseScpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGFwcGxpZWQsIGVycm9ycyB9ID0gYXdhaXQgYXBwbHlTZWNyZXRzKFxuICAgICAgICBbeyBrZXk6ICdLRVknLCB2YWx1ZTogJ3ZhbCcgfV0sXG4gICAgICAgICd2ZXJjZWwnLFxuICAgICAgICB7XG4gICAgICAgICAgZW52RmlsZVBhdGg6IGpvaW4odG1wLCAnLmVudicpLFxuICAgICAgICAgIGVudmlyb25tZW50OiAnc3RhZ2luZycgYXMgJ2RldmVsb3BtZW50JyxcbiAgICAgICAgICBleGVjRm46IGFzeW5jICgpID0+ICh7IGNvZGU6IDAsIHN0ZGVycjogJycgfSksXG4gICAgICAgIH0sXG4gICAgICApO1xuICAgICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChhcHBsaWVkLCBbXSk7XG4gICAgICBhc3NlcnQub2soZXJyb3JzWzBdPy5pbmNsdWRlcygndW5zdXBwb3J0ZWQnKSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KCdwYXNzZXMgcmVtb3RlIGRlc3RpbmF0aW9uIHNlY3JldHMgb24gc3RkaW4gaW5zdGVhZCBvZiBwcm9jZXNzIGFyZ3VtZW50cycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB0bXAgPSBtYWtlVGVtcERpcignYXBwbHktcmVtb3RlLXN0ZGluJyk7XG4gICAgY29uc3QgY2FsbHM6IEFycmF5PHsgY21kOiBzdHJpbmc7IGFyZ3M6IHN0cmluZ1tdOyBvcHRzPzogeyBzdGRpbj86IHN0cmluZyB9IH0+ID0gW107XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgYXBwbGllZCwgZXJyb3JzIH0gPSBhd2FpdCBhcHBseVNlY3JldHMoXG4gICAgICAgIFt7IGtleTogJ1JFTU9URV9TRUNSRVQnLCB2YWx1ZTogJ3N1cGVyLXNlY3JldC12YWx1ZScgfV0sXG4gICAgICAgICd2ZXJjZWwnLFxuICAgICAgICB7XG4gICAgICAgICAgZW52RmlsZVBhdGg6IGpvaW4odG1wLCAnLmVudicpLFxuICAgICAgICAgIGVudmlyb25tZW50OiAncHJldmlldycsXG4gICAgICAgICAgZXhlY0ZuOiBhc3luYyAoY21kLCBhcmdzLCBvcHRzKSA9PiB7XG4gICAgICAgICAgICBjYWxscy5wdXNoKHsgY21kLCBhcmdzLCBvcHRzIH0pO1xuICAgICAgICAgICAgcmV0dXJuIHsgY29kZTogMCwgc3RkZXJyOiAnJyB9O1xuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICApO1xuXG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGFwcGxpZWQsIFsnUkVNT1RFX1NFQ1JFVCddKTtcbiAgICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoZXJyb3JzLCBbXSk7XG4gICAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKGNhbGxzLCBbXG4gICAgICAgIHtcbiAgICAgICAgICBjbWQ6ICd2ZXJjZWwnLFxuICAgICAgICAgIGFyZ3M6IFsnZW52JywgJ2FkZCcsICdSRU1PVEVfU0VDUkVUJywgJ3ByZXZpZXcnXSxcbiAgICAgICAgICBvcHRzOiB7IHN0ZGluOiAnc3VwZXItc2VjcmV0LXZhbHVlJyB9LFxuICAgICAgICB9LFxuICAgICAgXSk7XG4gICAgICBhc3NlcnQub2soIWNhbGxzWzBdLmFyZ3Muc29tZSgoYXJnKSA9PiBhcmcuaW5jbHVkZXMoJ3N1cGVyLXNlY3JldC12YWx1ZScpKSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVmFsaWRhdGlvbiBoZWxwZXJzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ2lzU2FmZUVudlZhcktleScsICgpID0+IHtcbiAgaXQoJ2FjY2VwdHMgdmFsaWQga2V5cycsICgpID0+IHtcbiAgICBhc3NlcnQub2soaXNTYWZlRW52VmFyS2V5KCdBUElfS0VZJykpO1xuICAgIGFzc2VydC5vayhpc1NhZmVFbnZWYXJLZXkoJ19QUklWQVRFJykpO1xuICAgIGFzc2VydC5vayhpc1NhZmVFbnZWYXJLZXkoJ2tleTEyMycpKTtcbiAgfSk7XG5cbiAgaXQoJ3JlamVjdHMgaW52YWxpZCBrZXlzJywgKCkgPT4ge1xuICAgIGFzc2VydC5vayghaXNTYWZlRW52VmFyS2V5KCcxMjNCQUQnKSk7XG4gICAgYXNzZXJ0Lm9rKCFpc1NhZmVFbnZWYXJLZXkoJ2hhcy1kYXNoJykpO1xuICAgIGFzc2VydC5vayghaXNTYWZlRW52VmFyS2V5KCdoYXMgc3BhY2UnKSk7XG4gICAgYXNzZXJ0Lm9rKCFpc1NhZmVFbnZWYXJLZXkoJycpKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ2lzU2VjdXJpdHlTZW5zaXRpdmVFbnZLZXknLCAoKSA9PiB7XG4gIGl0KCdtYXRjaGVzIHNlbnNpdGl2ZSBrZXlzIGNhc2UtaW5zZW5zaXRpdmVseScsICgpID0+IHtcbiAgICBhc3NlcnQub2soaXNTZWN1cml0eVNlbnNpdGl2ZUVudktleSgnUEFUSCcpKTtcbiAgICBhc3NlcnQub2soaXNTZWN1cml0eVNlbnNpdGl2ZUVudktleSgncGF0aCcpKTtcbiAgICBhc3NlcnQub2soaXNTZWN1cml0eVNlbnNpdGl2ZUVudktleSgnTm9kZV9PcHRpb25zJykpO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZSgnaXNTdXBwb3J0ZWREZXBsb3ltZW50RW52aXJvbm1lbnQnLCAoKSA9PiB7XG4gIGl0KCdhY2NlcHRzIHZhbGlkIGVudmlyb25tZW50cycsICgpID0+IHtcbiAgICBhc3NlcnQub2soaXNTdXBwb3J0ZWREZXBsb3ltZW50RW52aXJvbm1lbnQoJ2RldmVsb3BtZW50JykpO1xuICAgIGFzc2VydC5vayhpc1N1cHBvcnRlZERlcGxveW1lbnRFbnZpcm9ubWVudCgncHJldmlldycpKTtcbiAgICBhc3NlcnQub2soaXNTdXBwb3J0ZWREZXBsb3ltZW50RW52aXJvbm1lbnQoJ3Byb2R1Y3Rpb24nKSk7XG4gIH0pO1xuXG4gIGl0KCdyZWplY3RzIGludmFsaWQgZW52aXJvbm1lbnRzJywgKCkgPT4ge1xuICAgIGFzc2VydC5vayghaXNTdXBwb3J0ZWREZXBsb3ltZW50RW52aXJvbm1lbnQoJ3N0YWdpbmcnKSk7XG4gICAgYXNzZXJ0Lm9rKCFpc1N1cHBvcnRlZERlcGxveW1lbnRFbnZpcm9ubWVudCgndGVzdCcpKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ3NoZWxsRXNjYXBlU2luZ2xlJywgKCkgPT4ge1xuICBpdCgnd3JhcHMgaW4gc2luZ2xlIHF1b3RlcycsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc2hlbGxFc2NhcGVTaW5nbGUoJ2hlbGxvJyksIFwiJ2hlbGxvJ1wiKTtcbiAgfSk7XG5cbiAgaXQoJ2VzY2FwZXMgZW1iZWRkZWQgc2luZ2xlIHF1b3RlcycsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc2hlbGxFc2NhcGVTaW5nbGUoXCJpdCdzXCIpLCBcIidpdCdcXFxcJydzJ1wiKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLFNBQVMsVUFBVSxJQUFJLGlCQUFpQjtBQUN4QyxPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxlQUFlLGNBQWMsY0FBYyxtQkFBbUI7QUFDdkcsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsWUFBWTtBQUVyQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFFUCxTQUFTLFlBQVksUUFBd0I7QUFDM0MsU0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLEdBQUcsTUFBTSxHQUFHLENBQUM7QUFDakQ7QUFNQSxTQUFTLHdCQUF3QixNQUFNO0FBQ3JDLEtBQUcsMEJBQTBCLFlBQVk7QUFDdkMsVUFBTSxNQUFNLFlBQVksV0FBVztBQUNuQyxRQUFJO0FBQ0YsWUFBTSxVQUFVLEtBQUssS0FBSyxNQUFNO0FBQ2hDLG9CQUFjLFNBQVMsZ0NBQWdDO0FBQ3ZELFlBQU0sU0FBUyxNQUFNLHFCQUFxQixDQUFDLFNBQVMsR0FBRyxPQUFPO0FBQzlELGFBQU8sZ0JBQWdCLFFBQVEsQ0FBQyxTQUFTLENBQUM7QUFBQSxJQUM1QyxVQUFFO0FBQ0EsYUFBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDOUM7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLDRCQUE0QixZQUFZO0FBQ3pDLFVBQU0sTUFBTSxZQUFZLFdBQVc7QUFDbkMsVUFBTSxRQUFRLFFBQVEsSUFBSTtBQUMxQixRQUFJO0FBQ0YsY0FBUSxJQUFJLHFCQUFxQjtBQUNqQyxZQUFNLFVBQVUsS0FBSyxLQUFLLE1BQU07QUFDaEMsWUFBTSxTQUFTLE1BQU0scUJBQXFCLENBQUMsb0JBQW9CLEdBQUcsT0FBTztBQUN6RSxhQUFPLGdCQUFnQixRQUFRLENBQUMsb0JBQW9CLENBQUM7QUFBQSxJQUN2RCxVQUFFO0FBQ0EsYUFBTyxRQUFRLElBQUk7QUFDbkIsVUFBSSxVQUFVLE9BQVcsU0FBUSxJQUFJLHFCQUFxQjtBQUMxRCxhQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUM5QztBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsa0NBQWtDLFlBQVk7QUFDL0MsVUFBTSxNQUFNLFlBQVksV0FBVztBQUNuQyxRQUFJO0FBQ0YsWUFBTSxVQUFVLEtBQUssS0FBSyxNQUFNO0FBQ2hDLG9CQUFjLFNBQVMsYUFBYTtBQUNwQyxhQUFPLFFBQVEsSUFBSTtBQUNuQixZQUFNLFNBQVMsTUFBTSxxQkFBcUIsQ0FBQyw0QkFBNEIsR0FBRyxPQUFPO0FBQ2pGLGFBQU8sZ0JBQWdCLFFBQVEsQ0FBQyxDQUFDO0FBQUEsSUFDbkMsVUFBRTtBQUNBLGFBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzlDO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyx3Q0FBd0MsWUFBWTtBQUNyRCxVQUFNLE1BQU0sWUFBWSxXQUFXO0FBQ25DLFFBQUk7QUFDRixZQUFNLFVBQVUsS0FBSyxLQUFLLGlCQUFpQjtBQUMzQyxhQUFPLFFBQVEsSUFBSTtBQUNuQixZQUFNLFNBQVMsTUFBTSxxQkFBcUIsQ0FBQyw0QkFBNEIsR0FBRyxPQUFPO0FBQ2pGLGFBQU8sZ0JBQWdCLFFBQVEsQ0FBQyxDQUFDO0FBQUEsSUFDbkMsVUFBRTtBQUNBLGFBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzlDO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQztBQU1ELFNBQVMscUJBQXFCLE1BQU07QUFDbEMsS0FBRywwQ0FBMEMsTUFBTTtBQUNqRCxVQUFNLE1BQU0sWUFBWSxNQUFNO0FBQzlCLFFBQUk7QUFDRixvQkFBYyxLQUFLLEtBQUssYUFBYSxHQUFHLElBQUk7QUFDNUMsYUFBTyxNQUFNLGtCQUFrQixHQUFHLEdBQUcsUUFBUTtBQUFBLElBQy9DLFVBQUU7QUFDQSxhQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUM5QztBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsMENBQTBDLE1BQU07QUFDakQsVUFBTSxNQUFNLFlBQVksTUFBTTtBQUM5QixRQUFJO0FBQ0YsZ0JBQVUsS0FBSyxLQUFLLFFBQVEsQ0FBQztBQUM3QixhQUFPLE1BQU0sa0JBQWtCLEdBQUcsR0FBRyxRQUFRO0FBQUEsSUFDL0MsVUFBRTtBQUNBLGFBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzlDO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyxzQ0FBc0MsTUFBTTtBQUM3QyxVQUFNLE1BQU0sWUFBWSxNQUFNO0FBQzlCLFFBQUk7QUFDRixhQUFPLE1BQU0sa0JBQWtCLEdBQUcsR0FBRyxRQUFRO0FBQUEsSUFDL0MsVUFBRTtBQUNBLGFBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzlDO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyxxQ0FBcUMsTUFBTTtBQUM1QyxVQUFNLE1BQU0sWUFBWSxNQUFNO0FBQzlCLFFBQUk7QUFDRixvQkFBYyxLQUFLLEtBQUssYUFBYSxHQUFHLElBQUk7QUFDNUMsZ0JBQVUsS0FBSyxLQUFLLFFBQVEsQ0FBQztBQUM3QixhQUFPLE1BQU0sa0JBQWtCLEdBQUcsR0FBRyxRQUFRO0FBQUEsSUFDL0MsVUFBRTtBQUNBLGFBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzlDO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQztBQU1ELFNBQVMsZUFBZSxNQUFNO0FBQzVCLEtBQUcsa0NBQWtDLFlBQVk7QUFDL0MsVUFBTSxNQUFNLFlBQVksT0FBTztBQUMvQixRQUFJO0FBQ0YsWUFBTSxVQUFVLEtBQUssS0FBSyxNQUFNO0FBQ2hDLFlBQU0sWUFBWSxTQUFTLFdBQVcsV0FBVztBQUNqRCxZQUFNLFVBQVUsYUFBYSxTQUFTLE1BQU07QUFDNUMsYUFBTyxHQUFHLFFBQVEsU0FBUyxtQkFBbUIsQ0FBQztBQUFBLElBQ2pELFVBQUU7QUFDQSxhQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUM5QztBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsaUNBQWlDLFlBQVk7QUFDOUMsVUFBTSxNQUFNLFlBQVksT0FBTztBQUMvQixRQUFJO0FBQ0YsWUFBTSxVQUFVLEtBQUssS0FBSyxNQUFNO0FBQ2hDLG9CQUFjLFNBQVMsNEJBQTRCO0FBQ25ELFlBQU0sWUFBWSxTQUFTLFlBQVksS0FBSztBQUM1QyxZQUFNLFVBQVUsYUFBYSxTQUFTLE1BQU07QUFDNUMsYUFBTyxHQUFHLFFBQVEsU0FBUyxjQUFjLENBQUM7QUFDMUMsYUFBTyxHQUFHLFFBQVEsU0FBUyxZQUFZLENBQUM7QUFDeEMsYUFBTyxHQUFHLENBQUMsUUFBUSxTQUFTLEtBQUssQ0FBQztBQUFBLElBQ3BDLFVBQUU7QUFDQSxhQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUM5QztBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsOEJBQThCLFlBQVk7QUFDM0MsVUFBTSxNQUFNLFlBQVksT0FBTztBQUMvQixRQUFJO0FBQ0YsWUFBTSxVQUFVLEtBQUssS0FBSyxNQUFNO0FBQ2hDLFlBQU0sWUFBWSxTQUFTLFNBQVMsY0FBYztBQUNsRCxZQUFNLFVBQVUsYUFBYSxTQUFTLE1BQU07QUFDNUMsYUFBTyxHQUFHLFFBQVEsU0FBUyxxQkFBcUIsQ0FBQztBQUFBLElBQ25ELFVBQUU7QUFDQSxhQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUM5QztBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsNkJBQTZCLFlBQVk7QUFDMUMsVUFBTSxNQUFNLFlBQVksT0FBTztBQUMvQixRQUFJO0FBQ0YsWUFBTSxVQUFVLEtBQUssS0FBSyxNQUFNO0FBQ2hDLFlBQU0sT0FBTztBQUFBLFFBQ1gsTUFBTSxZQUFZLFNBQVMsT0FBTyxNQUE4QjtBQUFBLFFBQ2hFO0FBQUEsTUFDRjtBQUFBLElBQ0YsVUFBRTtBQUNBLGFBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzlDO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyxvREFBb0QsWUFBWTtBQUNqRSxVQUFNLE1BQU0sWUFBWSxPQUFPO0FBQy9CLFVBQU0sVUFBVSxZQUFZLGVBQWU7QUFDM0MsUUFBSTtBQUNGLFlBQU0sYUFBYSxLQUFLLFNBQVMsTUFBTTtBQUN2QyxvQkFBYyxZQUFZLGtCQUFrQjtBQUM1QyxrQkFBWSxZQUFZLEtBQUssS0FBSyxNQUFNLENBQUM7QUFFekMsWUFBTSxPQUFPO0FBQUEsUUFDWCxNQUFNLFlBQVksS0FBSyxLQUFLLE1BQU0sR0FBRyxVQUFVLFFBQVE7QUFBQSxRQUN2RDtBQUFBLE1BQ0Y7QUFDQSxhQUFPLE1BQU0sYUFBYSxZQUFZLE1BQU0sR0FBRyxrQkFBa0I7QUFBQSxJQUNuRSxVQUFFO0FBQ0EsYUFBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQzVDLGFBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2xEO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQztBQU1ELFNBQVMsNkJBQTZCLE1BQU07QUFDMUMsS0FBRyxzQ0FBc0MsTUFBTTtBQUM3QyxVQUFNLE1BQU0sWUFBWSxVQUFVO0FBQ2xDLFFBQUk7QUFDRixhQUFPLE1BQU0sMEJBQTBCLEtBQUssTUFBTSxHQUFHLEtBQUssYUFBYSxPQUFPLEdBQUcsR0FBRyxNQUFNLENBQUM7QUFBQSxJQUM3RixVQUFFO0FBQ0EsYUFBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDOUM7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLGdEQUFnRCxNQUFNO0FBQ3ZELFVBQU0sTUFBTSxZQUFZLFVBQVU7QUFDbEMsUUFBSTtBQUNGLGFBQU87QUFBQSxRQUNMLE1BQU0sMEJBQTBCLEtBQUssZ0JBQWdCO0FBQUEsUUFDckQ7QUFBQSxNQUNGO0FBQUEsSUFDRixVQUFFO0FBQ0EsYUFBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDOUM7QUFBQSxFQUNGLENBQUM7QUFFRCxLQUFHLHFFQUFxRSxNQUFNO0FBQzVFLFVBQU0sTUFBTSxZQUFZLFVBQVU7QUFDbEMsVUFBTSxVQUFVLFlBQVksa0JBQWtCO0FBQzlDLFFBQUk7QUFDRixrQkFBWSxTQUFTLEtBQUssS0FBSyxnQkFBZ0IsR0FBRyxLQUFLO0FBQ3ZELGFBQU87QUFBQSxRQUNMLE1BQU0sMEJBQTBCLEtBQUsscUJBQXFCO0FBQUEsUUFDMUQ7QUFBQSxNQUNGO0FBQUEsSUFDRixVQUFFO0FBQ0EsYUFBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQzVDLGFBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2xEO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyx5RUFBeUUsTUFBTTtBQUNoRixVQUFNLE1BQU0sWUFBWSxVQUFVO0FBQ2xDLFVBQU0sVUFBVSxZQUFZLGtCQUFrQjtBQUM5QyxRQUFJO0FBQ0Ysb0JBQWMsS0FBSyxTQUFTLE1BQU0sR0FBRyxrQkFBa0I7QUFDdkQsa0JBQVksS0FBSyxTQUFTLE1BQU0sR0FBRyxLQUFLLEtBQUssTUFBTSxDQUFDO0FBQ3BELGFBQU87QUFBQSxRQUNMLE1BQU0sMEJBQTBCLEtBQUssTUFBTTtBQUFBLFFBQzNDO0FBQUEsTUFDRjtBQUFBLElBQ0YsVUFBRTtBQUNBLGFBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUM1QyxhQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNsRDtBQUFBLEVBQ0YsQ0FBQztBQUNILENBQUM7QUFNRCxTQUFTLGdCQUFnQixNQUFNO0FBQzdCLFFBQU0sWUFBZ0QsQ0FBQztBQUV2RCxZQUFVLE1BQU07QUFDZCxlQUFXLENBQUMsR0FBRyxDQUFDLEtBQUssT0FBTyxRQUFRLFNBQVMsR0FBRztBQUM5QyxVQUFJLE1BQU0sT0FBVyxRQUFPLFFBQVEsSUFBSSxDQUFDO0FBQUEsVUFDcEMsU0FBUSxJQUFJLENBQUMsSUFBSTtBQUFBLElBQ3hCO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyxnREFBZ0QsWUFBWTtBQUM3RCxVQUFNLE1BQU0sWUFBWSxPQUFPO0FBQy9CLFVBQU0sVUFBVSxLQUFLLEtBQUssTUFBTTtBQUNoQyxjQUFVLG1CQUFtQixRQUFRLElBQUk7QUFDekMsUUFBSTtBQUNGLFlBQU0sRUFBRSxTQUFTLE9BQU8sSUFBSSxNQUFNO0FBQUEsUUFDaEMsQ0FBQyxFQUFFLEtBQUssb0JBQW9CLE9BQU8sUUFBUSxDQUFDO0FBQUEsUUFDNUM7QUFBQSxRQUNBLEVBQUUsYUFBYSxRQUFRO0FBQUEsTUFDekI7QUFDQSxhQUFPLGdCQUFnQixTQUFTLENBQUMsa0JBQWtCLENBQUM7QUFDcEQsYUFBTyxnQkFBZ0IsUUFBUSxDQUFDLENBQUM7QUFDakMsYUFBTyxNQUFNLFFBQVEsSUFBSSxrQkFBa0IsT0FBTztBQUNsRCxZQUFNLFVBQVUsYUFBYSxTQUFTLE1BQU07QUFDNUMsYUFBTyxHQUFHLFFBQVEsU0FBUyx3QkFBd0IsQ0FBQztBQUFBLElBQ3RELFVBQUU7QUFDQSxhQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUM5QztBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsMkRBQTJELFlBQVk7QUFDeEUsVUFBTSxNQUFNLFlBQVksZUFBZTtBQUN2QyxVQUFNLFVBQVUsS0FBSyxLQUFLLE1BQU07QUFDaEMsUUFBSTtBQUNGLFlBQU0sRUFBRSxTQUFTLE9BQU8sSUFBSSxNQUFNO0FBQUEsUUFDaEMsQ0FBQyxFQUFFLEtBQUssV0FBVyxPQUFPLFFBQVEsQ0FBQztBQUFBLFFBQ25DO0FBQUEsUUFDQSxFQUFFLGFBQWEsUUFBUTtBQUFBLE1BQ3pCO0FBQ0EsYUFBTyxnQkFBZ0IsU0FBUyxDQUFDLENBQUM7QUFDbEMsYUFBTyxnQkFBZ0IsUUFBUSxDQUFDLDRDQUE0QyxDQUFDO0FBQzdFLGFBQU8sT0FBTyxNQUFNLGFBQWEsU0FBUyxNQUFNLEdBQUcsUUFBUTtBQUMzRCxhQUFPLE1BQU0sUUFBUSxJQUFJLFNBQVMsR0FBRyxNQUFTO0FBQUEsSUFDaEQsVUFBRTtBQUNBLGFBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzlDO0FBQUEsRUFDRixDQUFDO0FBRUQsS0FBRyw2REFBNkQsWUFBWTtBQUMxRSxVQUFNLE1BQU0sWUFBWSxpQkFBaUI7QUFDekMsVUFBTSxVQUFVLEtBQUssS0FBSyxNQUFNO0FBQ2hDLFFBQUk7QUFDRixZQUFNLEVBQUUsU0FBUyxPQUFPLElBQUksTUFBTTtBQUFBLFFBQ2hDLENBQUMsRUFBRSxLQUFLLFFBQVEsT0FBTyxnQkFBZ0IsQ0FBQztBQUFBLFFBQ3hDO0FBQUEsUUFDQSxFQUFFLGFBQWEsUUFBUTtBQUFBLE1BQ3pCO0FBQ0EsYUFBTyxnQkFBZ0IsU0FBUyxDQUFDLENBQUM7QUFDbEMsYUFBTyxnQkFBZ0IsUUFBUSxDQUFDLDBFQUEwRSxDQUFDO0FBQzNHLGFBQU8sT0FBTyxNQUFNLGFBQWEsU0FBUyxNQUFNLEdBQUcsUUFBUTtBQUFBLElBQzdELFVBQUU7QUFDQSxhQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUM5QztBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsaURBQWlELFlBQVk7QUFDOUQsVUFBTSxNQUFNLFlBQVksT0FBTztBQUMvQixRQUFJO0FBQ0YsWUFBTSxFQUFFLFNBQVMsT0FBTyxJQUFJLE1BQU07QUFBQSxRQUNoQyxDQUFDLEVBQUUsS0FBSyxPQUFPLE9BQU8sTUFBTSxDQUFDO0FBQUEsUUFDN0I7QUFBQSxRQUNBO0FBQUEsVUFDRSxhQUFhLEtBQUssS0FBSyxNQUFNO0FBQUEsVUFDN0IsYUFBYTtBQUFBLFVBQ2IsUUFBUSxhQUFhLEVBQUUsTUFBTSxHQUFHLFFBQVEsR0FBRztBQUFBLFFBQzdDO0FBQUEsTUFDRjtBQUNBLGFBQU8sZ0JBQWdCLFNBQVMsQ0FBQyxDQUFDO0FBQ2xDLGFBQU8sR0FBRyxPQUFPLENBQUMsR0FBRyxTQUFTLGFBQWEsQ0FBQztBQUFBLElBQzlDLFVBQUU7QUFDQSxhQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUM5QztBQUFBLEVBQ0YsQ0FBQztBQUVELEtBQUcsMkVBQTJFLFlBQVk7QUFDeEYsVUFBTSxNQUFNLFlBQVksb0JBQW9CO0FBQzVDLFVBQU0sUUFBMkUsQ0FBQztBQUNsRixRQUFJO0FBQ0YsWUFBTSxFQUFFLFNBQVMsT0FBTyxJQUFJLE1BQU07QUFBQSxRQUNoQyxDQUFDLEVBQUUsS0FBSyxpQkFBaUIsT0FBTyxxQkFBcUIsQ0FBQztBQUFBLFFBQ3REO0FBQUEsUUFDQTtBQUFBLFVBQ0UsYUFBYSxLQUFLLEtBQUssTUFBTTtBQUFBLFVBQzdCLGFBQWE7QUFBQSxVQUNiLFFBQVEsT0FBTyxLQUFLLE1BQU0sU0FBUztBQUNqQyxrQkFBTSxLQUFLLEVBQUUsS0FBSyxNQUFNLEtBQUssQ0FBQztBQUM5QixtQkFBTyxFQUFFLE1BQU0sR0FBRyxRQUFRLEdBQUc7QUFBQSxVQUMvQjtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBRUEsYUFBTyxnQkFBZ0IsU0FBUyxDQUFDLGVBQWUsQ0FBQztBQUNqRCxhQUFPLGdCQUFnQixRQUFRLENBQUMsQ0FBQztBQUNqQyxhQUFPLGdCQUFnQixPQUFPO0FBQUEsUUFDNUI7QUFBQSxVQUNFLEtBQUs7QUFBQSxVQUNMLE1BQU0sQ0FBQyxPQUFPLE9BQU8saUJBQWlCLFNBQVM7QUFBQSxVQUMvQyxNQUFNLEVBQUUsT0FBTyxxQkFBcUI7QUFBQSxRQUN0QztBQUFBLE1BQ0YsQ0FBQztBQUNELGFBQU8sR0FBRyxDQUFDLE1BQU0sQ0FBQyxFQUFFLEtBQUssS0FBSyxDQUFDLFFBQVEsSUFBSSxTQUFTLG9CQUFvQixDQUFDLENBQUM7QUFBQSxJQUM1RSxVQUFFO0FBQ0EsYUFBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDOUM7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDO0FBTUQsU0FBUyxtQkFBbUIsTUFBTTtBQUNoQyxLQUFHLHNCQUFzQixNQUFNO0FBQzdCLFdBQU8sR0FBRyxnQkFBZ0IsU0FBUyxDQUFDO0FBQ3BDLFdBQU8sR0FBRyxnQkFBZ0IsVUFBVSxDQUFDO0FBQ3JDLFdBQU8sR0FBRyxnQkFBZ0IsUUFBUSxDQUFDO0FBQUEsRUFDckMsQ0FBQztBQUVELEtBQUcsd0JBQXdCLE1BQU07QUFDL0IsV0FBTyxHQUFHLENBQUMsZ0JBQWdCLFFBQVEsQ0FBQztBQUNwQyxXQUFPLEdBQUcsQ0FBQyxnQkFBZ0IsVUFBVSxDQUFDO0FBQ3RDLFdBQU8sR0FBRyxDQUFDLGdCQUFnQixXQUFXLENBQUM7QUFDdkMsV0FBTyxHQUFHLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztBQUFBLEVBQ2hDLENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyw2QkFBNkIsTUFBTTtBQUMxQyxLQUFHLDZDQUE2QyxNQUFNO0FBQ3BELFdBQU8sR0FBRywwQkFBMEIsTUFBTSxDQUFDO0FBQzNDLFdBQU8sR0FBRywwQkFBMEIsTUFBTSxDQUFDO0FBQzNDLFdBQU8sR0FBRywwQkFBMEIsY0FBYyxDQUFDO0FBQUEsRUFDckQsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLG9DQUFvQyxNQUFNO0FBQ2pELEtBQUcsOEJBQThCLE1BQU07QUFDckMsV0FBTyxHQUFHLGlDQUFpQyxhQUFhLENBQUM7QUFDekQsV0FBTyxHQUFHLGlDQUFpQyxTQUFTLENBQUM7QUFDckQsV0FBTyxHQUFHLGlDQUFpQyxZQUFZLENBQUM7QUFBQSxFQUMxRCxDQUFDO0FBRUQsS0FBRyxnQ0FBZ0MsTUFBTTtBQUN2QyxXQUFPLEdBQUcsQ0FBQyxpQ0FBaUMsU0FBUyxDQUFDO0FBQ3RELFdBQU8sR0FBRyxDQUFDLGlDQUFpQyxNQUFNLENBQUM7QUFBQSxFQUNyRCxDQUFDO0FBQ0gsQ0FBQztBQUVELFNBQVMscUJBQXFCLE1BQU07QUFDbEMsS0FBRywwQkFBMEIsTUFBTTtBQUNqQyxXQUFPLE1BQU0sa0JBQWtCLE9BQU8sR0FBRyxTQUFTO0FBQUEsRUFDcEQsQ0FBQztBQUVELEtBQUcsa0NBQWtDLE1BQU07QUFDekMsV0FBTyxNQUFNLGtCQUFrQixNQUFNLEdBQUcsWUFBWTtBQUFBLEVBQ3RELENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
