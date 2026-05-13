import { describe, it, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { resolveConfigPath, loadConfig, validateConfig } from "./config.js";
import { Logger } from "./logger.js";
import { Daemon } from "./daemon.js";
import { SessionManager } from "./session-manager.js";
function tmpDir() {
  return mkdtempSync(join(tmpdir(), `daemon-test-${randomUUID().slice(0, 8)}-`));
}
const cleanupDirs = [];
afterEach(() => {
  while (cleanupDirs.length) {
    const d = cleanupDirs.pop();
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});
describe("resolveConfigPath", () => {
  it("prefers explicit CLI path", () => {
    const p = resolveConfigPath("/custom/config.yaml");
    assert.equal(p, "/custom/config.yaml");
  });
  it("expands ~ in CLI path", () => {
    const p = resolveConfigPath("~/my-daemon.yaml");
    assert.ok(p.startsWith(homedir()));
    assert.ok(p.endsWith("my-daemon.yaml"));
  });
  it("falls back to GSD_DAEMON_CONFIG env var", () => {
    const prev = process.env["GSD_DAEMON_CONFIG"];
    try {
      process.env["GSD_DAEMON_CONFIG"] = "/env/path.yaml";
      const p = resolveConfigPath();
      assert.equal(p, "/env/path.yaml");
    } finally {
      if (prev === void 0) delete process.env["GSD_DAEMON_CONFIG"];
      else process.env["GSD_DAEMON_CONFIG"] = prev;
    }
  });
  it("defaults to ~/.gsd/daemon.yaml", () => {
    const prev = process.env["GSD_DAEMON_CONFIG"];
    try {
      delete process.env["GSD_DAEMON_CONFIG"];
      const p = resolveConfigPath();
      assert.equal(p, join(homedir(), ".gsd", "daemon.yaml"));
    } finally {
      if (prev !== void 0) process.env["GSD_DAEMON_CONFIG"] = prev;
    }
  });
});
describe("loadConfig", () => {
  let savedToken;
  before(() => {
    savedToken = process.env["DISCORD_BOT_TOKEN"];
    delete process.env["DISCORD_BOT_TOKEN"];
  });
  afterEach(() => {
  });
  after(() => {
    if (savedToken !== void 0) process.env["DISCORD_BOT_TOKEN"] = savedToken;
  });
  it("parses valid YAML config", () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const configPath = join(dir, "daemon.yaml");
    writeFileSync(configPath, `
discord:
  token: "test-token-123"
  guild_id: "g1"
  owner_id: "o1"
projects:
  scan_roots:
    - ~/projects
    - /absolute/path
log:
  file: ~/logs/daemon.log
  level: debug
  max_size_mb: 100
`);
    const cfg = loadConfig(configPath);
    assert.equal(cfg.discord?.token, "test-token-123");
    assert.equal(cfg.discord?.guild_id, "g1");
    assert.equal(cfg.log.level, "debug");
    assert.equal(cfg.log.max_size_mb, 100);
    assert.ok(cfg.log.file.startsWith(homedir()));
    assert.ok(cfg.projects.scan_roots[0].startsWith(homedir()));
    assert.equal(cfg.projects.scan_roots[1], "/absolute/path");
  });
  it("returns defaults when config file is missing", () => {
    const cfg = loadConfig("/nonexistent/path/daemon.yaml");
    assert.equal(cfg.log.level, "info");
    assert.equal(cfg.log.max_size_mb, 50);
    assert.ok(cfg.log.file.endsWith("daemon.log"));
    assert.deepEqual(cfg.projects.scan_roots, []);
    assert.equal(cfg.discord, void 0);
  });
  it("throws on malformed YAML", () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const configPath = join(dir, "bad.yaml");
    writeFileSync(configPath, ":\n  :\n    bad: [unclosed");
    assert.throws(() => loadConfig(configPath), (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("Failed to parse YAML"));
      assert.ok(err.message.includes(configPath));
      return true;
    });
  });
  it("returns defaults for empty YAML file", () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const configPath = join(dir, "empty.yaml");
    writeFileSync(configPath, "");
    const cfg = loadConfig(configPath);
    assert.equal(cfg.log.level, "info");
    assert.equal(cfg.log.max_size_mb, 50);
    assert.deepEqual(cfg.projects.scan_roots, []);
  });
});
describe("validateConfig", () => {
  let savedToken;
  before(() => {
    savedToken = process.env["DISCORD_BOT_TOKEN"];
    delete process.env["DISCORD_BOT_TOKEN"];
  });
  after(() => {
    if (savedToken !== void 0) process.env["DISCORD_BOT_TOKEN"] = savedToken;
  });
  it("fills remaining defaults for partial config", () => {
    const cfg = validateConfig({ projects: { scan_roots: ["/a"] } });
    assert.equal(cfg.log.level, "info");
    assert.equal(cfg.log.max_size_mb, 50);
    assert.ok(cfg.log.file.endsWith("daemon.log"));
    assert.deepEqual(cfg.projects.scan_roots, ["/a"]);
    assert.equal(cfg.discord, void 0);
  });
  it("falls back to info for invalid log level", () => {
    const cfg = validateConfig({ log: { level: "trace" } });
    assert.equal(cfg.log.level, "info");
  });
  it("returns full defaults for null input", () => {
    const cfg = validateConfig(null);
    assert.equal(cfg.log.level, "info");
    assert.equal(cfg.log.max_size_mb, 50);
  });
  it("returns full defaults for non-object input", () => {
    const cfg = validateConfig("not-an-object");
    assert.equal(cfg.log.level, "info");
  });
  it("expands ~ in log file path", () => {
    const cfg = validateConfig({ log: { file: "~/my.log" } });
    assert.ok(cfg.log.file.startsWith(homedir()));
    assert.ok(cfg.log.file.endsWith("my.log"));
  });
  it("overrides discord token from DISCORD_BOT_TOKEN env var", () => {
    const prev = process.env["DISCORD_BOT_TOKEN"];
    try {
      process.env["DISCORD_BOT_TOKEN"] = "env-override-token";
      const cfg = validateConfig({
        discord: { token: "file-token", guild_id: "g1", owner_id: "o1" }
      });
      assert.equal(cfg.discord?.token, "env-override-token");
      assert.equal(cfg.discord?.guild_id, "g1");
    } finally {
      if (prev === void 0) delete process.env["DISCORD_BOT_TOKEN"];
      else process.env["DISCORD_BOT_TOKEN"] = prev;
    }
  });
  it("creates discord block from env var even when absent in config", () => {
    const prev = process.env["DISCORD_BOT_TOKEN"];
    try {
      process.env["DISCORD_BOT_TOKEN"] = "env-only-token";
      const cfg = validateConfig({});
      assert.equal(cfg.discord?.token, "env-only-token");
    } finally {
      if (prev === void 0) delete process.env["DISCORD_BOT_TOKEN"];
      else process.env["DISCORD_BOT_TOKEN"] = prev;
    }
  });
});
describe("Logger", () => {
  it("writes JSON-lines entries to file", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "test.log");
    const logger = new Logger({ filePath: logPath, level: "debug" });
    logger.info("hello world");
    logger.debug("detail", { key: "val" });
    await logger.close();
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    const entry0 = JSON.parse(lines[0]);
    assert.equal(entry0.level, "info");
    assert.equal(entry0.msg, "hello world");
    assert.ok(entry0.ts);
    const entry1 = JSON.parse(lines[1]);
    assert.equal(entry1.level, "debug");
    assert.equal(entry1.msg, "detail");
    assert.deepEqual(entry1.data, { key: "val" });
  });
  it("filters entries below configured level", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "filter.log");
    const logger = new Logger({ filePath: logPath, level: "warn" });
    logger.debug("should not appear");
    logger.info("should not appear either");
    logger.warn("visible warning");
    logger.error("visible error");
    await logger.close();
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).level, "warn");
    assert.equal(JSON.parse(lines[1]).level, "error");
  });
  it("close() resolves after stream ends", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "close.log");
    const logger = new Logger({ filePath: logPath, level: "info" });
    logger.info("before close");
    await logger.close();
    const content = readFileSync(logPath, "utf-8");
    assert.ok(content.includes("before close"));
  });
  it("creates parent directories if they do not exist", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "nested", "deep", "test.log");
    const logger = new Logger({ filePath: logPath, level: "info" });
    logger.info("nested dir test");
    await logger.close();
    assert.ok(existsSync(logPath));
    const content = readFileSync(logPath, "utf-8");
    assert.ok(content.includes("nested dir test"));
  });
  it("does not include data field when not provided", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "nodata.log");
    const logger = new Logger({ filePath: logPath, level: "info" });
    logger.info("no extra data");
    await logger.close();
    const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
    assert.equal(entry.data, void 0);
    assert.ok(!readFileSync(logPath, "utf-8").includes('"data"'));
  });
});
describe("token safety", () => {
  it("discord token never appears in log output", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "token-safety.log");
    const prev = process.env["DISCORD_BOT_TOKEN"];
    try {
      process.env["DISCORD_BOT_TOKEN"] = "super-secret-token-value";
      const cfg = validateConfig({});
      const logger = new Logger({ filePath: logPath, level: "debug" });
      logger.info("config loaded", { discord_configured: !!cfg.discord });
      logger.debug("startup complete");
      await logger.close();
      const content = readFileSync(logPath, "utf-8");
      assert.ok(!content.includes("super-secret-token-value"));
    } finally {
      if (prev === void 0) delete process.env["DISCORD_BOT_TOKEN"];
      else process.env["DISCORD_BOT_TOKEN"] = prev;
    }
  });
});
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
describe("Daemon", () => {
  it("logs lifecycle events on start and shutdown", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "daemon-lifecycle.log");
    const config = {
      discord: void 0,
      projects: { scan_roots: ["/a", "/b"] },
      log: { file: logPath, level: "info", max_size_mb: 50 }
    };
    const logger = new Logger({ filePath: logPath, level: "info" });
    const daemon = new Daemon(config, logger);
    await daemon.start();
    const origExit = process.exit;
    let exitCode;
    process.exit = (code) => {
      exitCode = code ?? 0;
    };
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
    assert.equal(exitCode, 0);
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    const startEntry = JSON.parse(lines[0]);
    assert.equal(startEntry.msg, "daemon started");
    assert.equal(startEntry.data?.scan_roots, 2);
    assert.equal(startEntry.data?.discord_configured, false);
    const stopEntry = JSON.parse(lines[1]);
    assert.equal(stopEntry.msg, "daemon shutting down");
  });
  it("shutdown is idempotent \u2014 second call is a no-op", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "idempotent.log");
    const config = {
      discord: void 0,
      projects: { scan_roots: [] },
      log: { file: logPath, level: "info", max_size_mb: 50 }
    };
    const logger = new Logger({ filePath: logPath, level: "info" });
    const daemon = new Daemon(config, logger);
    await daemon.start();
    const origExit = process.exit;
    let exitCount = 0;
    process.exit = () => {
      exitCount++;
    };
    try {
      await daemon.shutdown();
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
    assert.equal(exitCount, 1, "process.exit should be called exactly once");
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    const shutdownLines = lines.filter((l) => {
      const e = JSON.parse(l);
      return e.msg === "daemon shutting down";
    });
    assert.equal(shutdownLines.length, 1, "shutdown log should appear exactly once");
  });
});
describe("Health heartbeat", () => {
  it("logs health entry with expected fields after interval tick", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "health.log");
    const config = {
      discord: void 0,
      projects: { scan_roots: [] },
      log: { file: logPath, level: "info", max_size_mb: 50 }
    };
    const logger = new Logger({ filePath: logPath, level: "info" });
    const daemon = new Daemon(config, logger, 50);
    await daemon.start();
    await new Promise((r) => setTimeout(r, 120));
    const origExit = process.exit;
    process.exit = () => {
    };
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    const healthLines = lines.filter((l) => {
      const e = JSON.parse(l);
      return e.msg === "health";
    });
    assert.ok(healthLines.length >= 1, "should have at least one health log entry");
    const entry = JSON.parse(healthLines[0]);
    assert.equal(entry.msg, "health");
    assert.equal(typeof entry.data?.uptime_s, "number");
    assert.equal(typeof entry.data?.active_sessions, "number");
    assert.equal(typeof entry.data?.discord_connected, "boolean");
    assert.equal(typeof entry.data?.memory_rss_mb, "number");
    assert.equal(entry.data?.discord_connected, false);
    assert.equal(entry.data?.active_sessions, 0);
  });
  it("health timer is cleared on shutdown \u2014 no lingering intervals", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "health-cleanup.log");
    const config = {
      discord: void 0,
      projects: { scan_roots: [] },
      log: { file: logPath, level: "info", max_size_mb: 50 }
    };
    const logger = new Logger({ filePath: logPath, level: "info" });
    const daemon = new Daemon(config, logger, 50);
    await daemon.start();
    await new Promise((r) => setTimeout(r, 80));
    const origExit = process.exit;
    process.exit = () => {
    };
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
    const contentAtShutdown = readFileSync(logPath, "utf-8");
    const healthCountAtShutdown = contentAtShutdown.trim().split("\n").filter((l) => JSON.parse(l).msg === "health").length;
    await new Promise((r) => setTimeout(r, 120));
    const contentAfterWait = readFileSync(logPath, "utf-8");
    const healthCountAfterWait = contentAfterWait.trim().split("\n").filter((l) => JSON.parse(l).msg === "health").length;
    assert.equal(
      healthCountAfterWait,
      healthCountAtShutdown,
      "no new health entries should appear after shutdown"
    );
  });
});
describe("CLI integration", () => {
  it("--help prints usage and exits 0", () => {
    const result = execFileSync(
      process.execPath,
      [join(__dirname, "cli.js"), "--help"],
      { encoding: "utf-8", timeout: 5e3 }
    );
    assert.ok(result.includes("Usage: gsd-daemon"));
    assert.ok(result.includes("--config"));
    assert.ok(result.includes("--verbose"));
  });
  it("starts, logs to file, and exits cleanly on SIGTERM", { timeout: 15e3 }, async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "integration.log");
    const configPath = join(dir, "daemon.yaml");
    writeFileSync(configPath, `
projects:
  scan_roots:
    - /tmp/test-project
log:
  file: "${logPath}"
  level: info
  max_size_mb: 10
`);
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [join(__dirname, "cli.js"), "--config", configPath],
        { stdio: "ignore" }
      );
      let resolved = false;
      child.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
      child.on("exit", (code) => {
        if (!resolved) {
          resolved = true;
          resolve(code ?? 1);
        }
      });
      const poll = setInterval(() => {
        if (existsSync(logPath)) {
          const content = readFileSync(logPath, "utf-8");
          if (content.includes("daemon started")) {
            clearInterval(poll);
            child.kill("SIGTERM");
          }
        }
      }, 100);
      setTimeout(() => {
        clearInterval(poll);
        if (!resolved) {
          child.kill("SIGKILL");
          resolved = true;
          reject(new Error("timed out waiting for daemon"));
        }
      }, 1e4);
    });
    assert.equal(exitCode, 0, "daemon should exit with code 0 on SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    const finalContent = readFileSync(logPath, "utf-8");
    assert.ok(finalContent.includes("daemon started"), "log should contain startup entry");
    assert.ok(finalContent.includes("daemon shutting down"), "log should contain shutdown entry");
    const lines = finalContent.trim().split("\n");
    for (const line of lines) {
      const entry = JSON.parse(line);
      assert.ok(entry.ts, "each entry should have a timestamp");
      assert.ok(entry.level, "each entry should have a level");
      assert.ok(entry.msg, "each entry should have a message");
    }
  });
  it("exits with code 1 on invalid config", () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const configPath = join(dir, "bad.yaml");
    writeFileSync(configPath, ":\n  :\n    bad: [unclosed");
    try {
      execFileSync(
        process.execPath,
        [join(__dirname, "cli.js"), "--config", configPath],
        { encoding: "utf-8", timeout: 5e3 }
      );
      assert.fail("should have thrown");
    } catch (err) {
      const execErr = err;
      assert.equal(execErr.status, 1);
      assert.ok(execErr.stderr.includes("fatal"));
    }
  });
});
describe("Daemon integration", () => {
  it("getSessionManager() returns SessionManager after start()", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "daemon-sm.log");
    const config = {
      discord: void 0,
      projects: { scan_roots: [] },
      log: { file: logPath, level: "info", max_size_mb: 50 }
    };
    const logger = new Logger({ filePath: logPath, level: "info" });
    const daemon = new Daemon(config, logger);
    await daemon.start();
    const sm = daemon.getSessionManager();
    assert.ok(sm instanceof SessionManager);
    const origExit = process.exit;
    process.exit = () => {
    };
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
  });
  it("getSessionManager() throws before start()", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "daemon-nostart.log");
    const config = {
      discord: void 0,
      projects: { scan_roots: [] },
      log: { file: logPath, level: "info", max_size_mb: 50 }
    };
    const logger = new Logger({ filePath: logPath, level: "info" });
    const daemon = new Daemon(config, logger);
    assert.throws(
      () => daemon.getSessionManager(),
      (err) => {
        assert.ok(err.message.includes("Daemon not started"));
        return true;
      }
    );
    await logger.close();
  });
  it("scanProjects() delegates to scanForProjects with configured roots", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "daemon-scan.log");
    const scanRoot = join(dir, "projects");
    mkdirSync(scanRoot);
    const projectDir = join(scanRoot, "my-project");
    mkdirSync(projectDir);
    mkdirSync(join(projectDir, ".git"));
    const config = {
      discord: void 0,
      projects: { scan_roots: [scanRoot] },
      log: { file: logPath, level: "info", max_size_mb: 50 }
    };
    const logger = new Logger({ filePath: logPath, level: "info" });
    const daemon = new Daemon(config, logger);
    await daemon.start();
    const projects = await daemon.scanProjects();
    assert.ok(projects.length >= 1);
    const found = projects.find((p) => p.name === "my-project");
    assert.ok(found);
    assert.ok(found.markers.includes("git"));
    const origExit = process.exit;
    process.exit = () => {
    };
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
  });
  it("shutdown cleans up sessionManager before closing logger", async () => {
    const dir = tmpDir();
    cleanupDirs.push(dir);
    const logPath = join(dir, "daemon-cleanup.log");
    const config = {
      discord: void 0,
      projects: { scan_roots: [] },
      log: { file: logPath, level: "info", max_size_mb: 50 }
    };
    const logger = new Logger({ filePath: logPath, level: "info" });
    const daemon = new Daemon(config, logger);
    await daemon.start();
    const sm = daemon.getSessionManager();
    assert.ok(sm);
    const origExit = process.exit;
    process.exit = () => {
    };
    try {
      await daemon.shutdown();
    } finally {
      process.exit = origExit;
    }
    const content = readFileSync(logPath, "utf-8");
    assert.ok(content.includes("daemon started"));
    assert.ok(content.includes("daemon shutting down"));
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvZGFlbW9uL3NyYy9kYWVtb24udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBhZnRlckVhY2gsIGJlZm9yZSwgYWZ0ZXIgfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIHdyaXRlRmlsZVN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jLCBleGlzdHNTeW5jLCBta2RpclN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyLCBob21lZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jLCBzcGF3biB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSAnbm9kZTp1cmwnO1xuaW1wb3J0IHsgZGlybmFtZSB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyByZXNvbHZlQ29uZmlnUGF0aCwgbG9hZENvbmZpZywgdmFsaWRhdGVDb25maWcgfSBmcm9tICcuL2NvbmZpZy5qcyc7XG5pbXBvcnQgeyBMb2dnZXIgfSBmcm9tICcuL2xvZ2dlci5qcyc7XG5pbXBvcnQgeyBEYWVtb24gfSBmcm9tICcuL2RhZW1vbi5qcyc7XG5pbXBvcnQgeyBTZXNzaW9uTWFuYWdlciB9IGZyb20gJy4vc2Vzc2lvbi1tYW5hZ2VyLmpzJztcbmltcG9ydCB0eXBlIHsgRGFlbW9uQ29uZmlnLCBMb2dFbnRyeSB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyAtLS0tLS0tLS0tIGhlbHBlcnMgLS0tLS0tLS0tLVxuXG5mdW5jdGlvbiB0bXBEaXIoKTogc3RyaW5nIHtcbiAgcmV0dXJuIG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIGBkYWVtb24tdGVzdC0ke3JhbmRvbVVVSUQoKS5zbGljZSgwLCA4KX0tYCkpO1xufVxuXG5jb25zdCBjbGVhbnVwRGlyczogc3RyaW5nW10gPSBbXTtcbmFmdGVyRWFjaCgoKSA9PiB7XG4gIHdoaWxlIChjbGVhbnVwRGlycy5sZW5ndGgpIHtcbiAgICBjb25zdCBkID0gY2xlYW51cERpcnMucG9wKCkhO1xuICAgIGlmIChleGlzdHNTeW5jKGQpKSBybVN5bmMoZCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuLy8gLS0tLS0tLS0tLSBjb25maWcgLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgncmVzb2x2ZUNvbmZpZ1BhdGgnLCAoKSA9PiB7XG4gIGl0KCdwcmVmZXJzIGV4cGxpY2l0IENMSSBwYXRoJywgKCkgPT4ge1xuICAgIGNvbnN0IHAgPSByZXNvbHZlQ29uZmlnUGF0aCgnL2N1c3RvbS9jb25maWcueWFtbCcpO1xuICAgIGFzc2VydC5lcXVhbChwLCAnL2N1c3RvbS9jb25maWcueWFtbCcpO1xuICB9KTtcblxuICBpdCgnZXhwYW5kcyB+IGluIENMSSBwYXRoJywgKCkgPT4ge1xuICAgIGNvbnN0IHAgPSByZXNvbHZlQ29uZmlnUGF0aCgnfi9teS1kYWVtb24ueWFtbCcpO1xuICAgIGFzc2VydC5vayhwLnN0YXJ0c1dpdGgoaG9tZWRpcigpKSk7XG4gICAgYXNzZXJ0Lm9rKHAuZW5kc1dpdGgoJ215LWRhZW1vbi55YW1sJykpO1xuICB9KTtcblxuICBpdCgnZmFsbHMgYmFjayB0byBHU0RfREFFTU9OX0NPTkZJRyBlbnYgdmFyJywgKCkgPT4ge1xuICAgIGNvbnN0IHByZXYgPSBwcm9jZXNzLmVudlsnR1NEX0RBRU1PTl9DT05GSUcnXTtcbiAgICB0cnkge1xuICAgICAgcHJvY2Vzcy5lbnZbJ0dTRF9EQUVNT05fQ09ORklHJ10gPSAnL2Vudi9wYXRoLnlhbWwnO1xuICAgICAgY29uc3QgcCA9IHJlc29sdmVDb25maWdQYXRoKCk7XG4gICAgICBhc3NlcnQuZXF1YWwocCwgJy9lbnYvcGF0aC55YW1sJyk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGlmIChwcmV2ID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudlsnR1NEX0RBRU1PTl9DT05GSUcnXTtcbiAgICAgIGVsc2UgcHJvY2Vzcy5lbnZbJ0dTRF9EQUVNT05fQ09ORklHJ10gPSBwcmV2O1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoJ2RlZmF1bHRzIHRvIH4vLmdzZC9kYWVtb24ueWFtbCcsICgpID0+IHtcbiAgICBjb25zdCBwcmV2ID0gcHJvY2Vzcy5lbnZbJ0dTRF9EQUVNT05fQ09ORklHJ107XG4gICAgdHJ5IHtcbiAgICAgIGRlbGV0ZSBwcm9jZXNzLmVudlsnR1NEX0RBRU1PTl9DT05GSUcnXTtcbiAgICAgIGNvbnN0IHAgPSByZXNvbHZlQ29uZmlnUGF0aCgpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHAsIGpvaW4oaG9tZWRpcigpLCAnLmdzZCcsICdkYWVtb24ueWFtbCcpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKHByZXYgIT09IHVuZGVmaW5lZCkgcHJvY2Vzcy5lbnZbJ0dTRF9EQUVNT05fQ09ORklHJ10gPSBwcmV2O1xuICAgIH1cbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ2xvYWRDb25maWcnLCAoKSA9PiB7XG4gIC8vIFNhdmUgYW5kIGNsZWFyIERJU0NPUkRfQk9UX1RPS0VOIGZvciB0aGlzIHN1aXRlIFx1MjAxNCBlbnYgb3ZlcnJpZGUgaW50ZXJmZXJlcyB3aXRoIGZpbGUtdG9rZW4gYXNzZXJ0aW9uc1xuICBsZXQgc2F2ZWRUb2tlbjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBiZWZvcmUoKCkgPT4ge1xuICAgIHNhdmVkVG9rZW4gPSBwcm9jZXNzLmVudlsnRElTQ09SRF9CT1RfVE9LRU4nXTtcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnZbJ0RJU0NPUkRfQk9UX1RPS0VOJ107XG4gIH0pO1xuICBhZnRlckVhY2goKCkgPT4ge30pOyAvLyBjbGVhbnVwIGRpcnMgaGFuZGxlZCBieSB0b3AtbGV2ZWwgYWZ0ZXJFYWNoXG4gIC8vIFJlc3RvcmUgYWZ0ZXIgYWxsIHRlc3RzIGluIHRoaXMgc3VpdGVcbiAgYWZ0ZXIoKCkgPT4ge1xuICAgIGlmIChzYXZlZFRva2VuICE9PSB1bmRlZmluZWQpIHByb2Nlc3MuZW52WydESVNDT1JEX0JPVF9UT0tFTiddID0gc2F2ZWRUb2tlbjtcbiAgfSk7XG5cbiAgaXQoJ3BhcnNlcyB2YWxpZCBZQU1MIGNvbmZpZycsICgpID0+IHtcbiAgICBjb25zdCBkaXIgPSB0bXBEaXIoKTtcbiAgICBjbGVhbnVwRGlycy5wdXNoKGRpcik7XG4gICAgY29uc3QgY29uZmlnUGF0aCA9IGpvaW4oZGlyLCAnZGFlbW9uLnlhbWwnKTtcbiAgICB3cml0ZUZpbGVTeW5jKGNvbmZpZ1BhdGgsIGBcbmRpc2NvcmQ6XG4gIHRva2VuOiBcInRlc3QtdG9rZW4tMTIzXCJcbiAgZ3VpbGRfaWQ6IFwiZzFcIlxuICBvd25lcl9pZDogXCJvMVwiXG5wcm9qZWN0czpcbiAgc2Nhbl9yb290czpcbiAgICAtIH4vcHJvamVjdHNcbiAgICAtIC9hYnNvbHV0ZS9wYXRoXG5sb2c6XG4gIGZpbGU6IH4vbG9ncy9kYWVtb24ubG9nXG4gIGxldmVsOiBkZWJ1Z1xuICBtYXhfc2l6ZV9tYjogMTAwXG5gKTtcbiAgICBjb25zdCBjZmcgPSBsb2FkQ29uZmlnKGNvbmZpZ1BhdGgpO1xuICAgIGFzc2VydC5lcXVhbChjZmcuZGlzY29yZD8udG9rZW4sICd0ZXN0LXRva2VuLTEyMycpO1xuICAgIGFzc2VydC5lcXVhbChjZmcuZGlzY29yZD8uZ3VpbGRfaWQsICdnMScpO1xuICAgIGFzc2VydC5lcXVhbChjZmcubG9nLmxldmVsLCAnZGVidWcnKTtcbiAgICBhc3NlcnQuZXF1YWwoY2ZnLmxvZy5tYXhfc2l6ZV9tYiwgMTAwKTtcbiAgICBhc3NlcnQub2soY2ZnLmxvZy5maWxlLnN0YXJ0c1dpdGgoaG9tZWRpcigpKSk7XG4gICAgYXNzZXJ0Lm9rKGNmZy5wcm9qZWN0cy5zY2FuX3Jvb3RzWzBdIS5zdGFydHNXaXRoKGhvbWVkaXIoKSkpO1xuICAgIGFzc2VydC5lcXVhbChjZmcucHJvamVjdHMuc2Nhbl9yb290c1sxXSwgJy9hYnNvbHV0ZS9wYXRoJyk7XG4gIH0pO1xuXG4gIGl0KCdyZXR1cm5zIGRlZmF1bHRzIHdoZW4gY29uZmlnIGZpbGUgaXMgbWlzc2luZycsICgpID0+IHtcbiAgICBjb25zdCBjZmcgPSBsb2FkQ29uZmlnKCcvbm9uZXhpc3RlbnQvcGF0aC9kYWVtb24ueWFtbCcpO1xuICAgIGFzc2VydC5lcXVhbChjZmcubG9nLmxldmVsLCAnaW5mbycpO1xuICAgIGFzc2VydC5lcXVhbChjZmcubG9nLm1heF9zaXplX21iLCA1MCk7XG4gICAgYXNzZXJ0Lm9rKGNmZy5sb2cuZmlsZS5lbmRzV2l0aCgnZGFlbW9uLmxvZycpKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGNmZy5wcm9qZWN0cy5zY2FuX3Jvb3RzLCBbXSk7XG4gICAgYXNzZXJ0LmVxdWFsKGNmZy5kaXNjb3JkLCB1bmRlZmluZWQpO1xuICB9KTtcblxuICBpdCgndGhyb3dzIG9uIG1hbGZvcm1lZCBZQU1MJywgKCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IHRtcERpcigpO1xuICAgIGNsZWFudXBEaXJzLnB1c2goZGlyKTtcbiAgICBjb25zdCBjb25maWdQYXRoID0gam9pbihkaXIsICdiYWQueWFtbCcpO1xuICAgIHdyaXRlRmlsZVN5bmMoY29uZmlnUGF0aCwgJzpcXG4gIDpcXG4gICAgYmFkOiBbdW5jbG9zZWQnKTtcbiAgICBhc3NlcnQudGhyb3dzKCgpID0+IGxvYWRDb25maWcoY29uZmlnUGF0aCksIChlcnI6IHVua25vd24pID0+IHtcbiAgICAgIGFzc2VydC5vayhlcnIgaW5zdGFuY2VvZiBFcnJvcik7XG4gICAgICBhc3NlcnQub2soZXJyLm1lc3NhZ2UuaW5jbHVkZXMoJ0ZhaWxlZCB0byBwYXJzZSBZQU1MJykpO1xuICAgICAgYXNzZXJ0Lm9rKGVyci5tZXNzYWdlLmluY2x1ZGVzKGNvbmZpZ1BhdGgpKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0pO1xuICB9KTtcblxuICBpdCgncmV0dXJucyBkZWZhdWx0cyBmb3IgZW1wdHkgWUFNTCBmaWxlJywgKCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IHRtcERpcigpO1xuICAgIGNsZWFudXBEaXJzLnB1c2goZGlyKTtcbiAgICBjb25zdCBjb25maWdQYXRoID0gam9pbihkaXIsICdlbXB0eS55YW1sJyk7XG4gICAgd3JpdGVGaWxlU3luYyhjb25maWdQYXRoLCAnJyk7XG4gICAgY29uc3QgY2ZnID0gbG9hZENvbmZpZyhjb25maWdQYXRoKTtcbiAgICBhc3NlcnQuZXF1YWwoY2ZnLmxvZy5sZXZlbCwgJ2luZm8nKTtcbiAgICBhc3NlcnQuZXF1YWwoY2ZnLmxvZy5tYXhfc2l6ZV9tYiwgNTApO1xuICAgIGFzc2VydC5kZWVwRXF1YWwoY2ZnLnByb2plY3RzLnNjYW5fcm9vdHMsIFtdKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoJ3ZhbGlkYXRlQ29uZmlnJywgKCkgPT4ge1xuICAvLyBTYXZlIGFuZCBjbGVhciBESVNDT1JEX0JPVF9UT0tFTiBmb3IgdGVzdHMgdGhhdCBkb24ndCBleHBlY3QgaXRcbiAgbGV0IHNhdmVkVG9rZW46IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgYmVmb3JlKCgpID0+IHtcbiAgICBzYXZlZFRva2VuID0gcHJvY2Vzcy5lbnZbJ0RJU0NPUkRfQk9UX1RPS0VOJ107XG4gICAgZGVsZXRlIHByb2Nlc3MuZW52WydESVNDT1JEX0JPVF9UT0tFTiddO1xuICB9KTtcbiAgYWZ0ZXIoKCkgPT4ge1xuICAgIGlmIChzYXZlZFRva2VuICE9PSB1bmRlZmluZWQpIHByb2Nlc3MuZW52WydESVNDT1JEX0JPVF9UT0tFTiddID0gc2F2ZWRUb2tlbjtcbiAgfSk7XG5cbiAgaXQoJ2ZpbGxzIHJlbWFpbmluZyBkZWZhdWx0cyBmb3IgcGFydGlhbCBjb25maWcnLCAoKSA9PiB7XG4gICAgY29uc3QgY2ZnID0gdmFsaWRhdGVDb25maWcoeyBwcm9qZWN0czogeyBzY2FuX3Jvb3RzOiBbJy9hJ10gfSB9KTtcbiAgICBhc3NlcnQuZXF1YWwoY2ZnLmxvZy5sZXZlbCwgJ2luZm8nKTtcbiAgICBhc3NlcnQuZXF1YWwoY2ZnLmxvZy5tYXhfc2l6ZV9tYiwgNTApO1xuICAgIGFzc2VydC5vayhjZmcubG9nLmZpbGUuZW5kc1dpdGgoJ2RhZW1vbi5sb2cnKSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChjZmcucHJvamVjdHMuc2Nhbl9yb290cywgWycvYSddKTtcbiAgICBhc3NlcnQuZXF1YWwoY2ZnLmRpc2NvcmQsIHVuZGVmaW5lZCk7XG4gIH0pO1xuXG4gIGl0KCdmYWxscyBiYWNrIHRvIGluZm8gZm9yIGludmFsaWQgbG9nIGxldmVsJywgKCkgPT4ge1xuICAgIGNvbnN0IGNmZyA9IHZhbGlkYXRlQ29uZmlnKHsgbG9nOiB7IGxldmVsOiAndHJhY2UnIH0gfSk7XG4gICAgYXNzZXJ0LmVxdWFsKGNmZy5sb2cubGV2ZWwsICdpbmZvJyk7XG4gIH0pO1xuXG4gIGl0KCdyZXR1cm5zIGZ1bGwgZGVmYXVsdHMgZm9yIG51bGwgaW5wdXQnLCAoKSA9PiB7XG4gICAgY29uc3QgY2ZnID0gdmFsaWRhdGVDb25maWcobnVsbCk7XG4gICAgYXNzZXJ0LmVxdWFsKGNmZy5sb2cubGV2ZWwsICdpbmZvJyk7XG4gICAgYXNzZXJ0LmVxdWFsKGNmZy5sb2cubWF4X3NpemVfbWIsIDUwKTtcbiAgfSk7XG5cbiAgaXQoJ3JldHVybnMgZnVsbCBkZWZhdWx0cyBmb3Igbm9uLW9iamVjdCBpbnB1dCcsICgpID0+IHtcbiAgICBjb25zdCBjZmcgPSB2YWxpZGF0ZUNvbmZpZygnbm90LWFuLW9iamVjdCcpO1xuICAgIGFzc2VydC5lcXVhbChjZmcubG9nLmxldmVsLCAnaW5mbycpO1xuICB9KTtcblxuICBpdCgnZXhwYW5kcyB+IGluIGxvZyBmaWxlIHBhdGgnLCAoKSA9PiB7XG4gICAgY29uc3QgY2ZnID0gdmFsaWRhdGVDb25maWcoeyBsb2c6IHsgZmlsZTogJ34vbXkubG9nJyB9IH0pO1xuICAgIGFzc2VydC5vayhjZmcubG9nLmZpbGUuc3RhcnRzV2l0aChob21lZGlyKCkpKTtcbiAgICBhc3NlcnQub2soY2ZnLmxvZy5maWxlLmVuZHNXaXRoKCdteS5sb2cnKSk7XG4gIH0pO1xuXG4gIGl0KCdvdmVycmlkZXMgZGlzY29yZCB0b2tlbiBmcm9tIERJU0NPUkRfQk9UX1RPS0VOIGVudiB2YXInLCAoKSA9PiB7XG4gICAgY29uc3QgcHJldiA9IHByb2Nlc3MuZW52WydESVNDT1JEX0JPVF9UT0tFTiddO1xuICAgIHRyeSB7XG4gICAgICBwcm9jZXNzLmVudlsnRElTQ09SRF9CT1RfVE9LRU4nXSA9ICdlbnYtb3ZlcnJpZGUtdG9rZW4nO1xuICAgICAgY29uc3QgY2ZnID0gdmFsaWRhdGVDb25maWcoe1xuICAgICAgICBkaXNjb3JkOiB7IHRva2VuOiAnZmlsZS10b2tlbicsIGd1aWxkX2lkOiAnZzEnLCBvd25lcl9pZDogJ28xJyB9LFxuICAgICAgfSk7XG4gICAgICBhc3NlcnQuZXF1YWwoY2ZnLmRpc2NvcmQ/LnRva2VuLCAnZW52LW92ZXJyaWRlLXRva2VuJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoY2ZnLmRpc2NvcmQ/Lmd1aWxkX2lkLCAnZzEnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKHByZXYgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52WydESVNDT1JEX0JPVF9UT0tFTiddO1xuICAgICAgZWxzZSBwcm9jZXNzLmVudlsnRElTQ09SRF9CT1RfVE9LRU4nXSA9IHByZXY7XG4gICAgfVxuICB9KTtcblxuICBpdCgnY3JlYXRlcyBkaXNjb3JkIGJsb2NrIGZyb20gZW52IHZhciBldmVuIHdoZW4gYWJzZW50IGluIGNvbmZpZycsICgpID0+IHtcbiAgICBjb25zdCBwcmV2ID0gcHJvY2Vzcy5lbnZbJ0RJU0NPUkRfQk9UX1RPS0VOJ107XG4gICAgdHJ5IHtcbiAgICAgIHByb2Nlc3MuZW52WydESVNDT1JEX0JPVF9UT0tFTiddID0gJ2Vudi1vbmx5LXRva2VuJztcbiAgICAgIGNvbnN0IGNmZyA9IHZhbGlkYXRlQ29uZmlnKHt9KTtcbiAgICAgIGFzc2VydC5lcXVhbChjZmcuZGlzY29yZD8udG9rZW4sICdlbnYtb25seS10b2tlbicpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBpZiAocHJldiA9PT0gdW5kZWZpbmVkKSBkZWxldGUgcHJvY2Vzcy5lbnZbJ0RJU0NPUkRfQk9UX1RPS0VOJ107XG4gICAgICBlbHNlIHByb2Nlc3MuZW52WydESVNDT1JEX0JPVF9UT0tFTiddID0gcHJldjtcbiAgICB9XG4gIH0pO1xufSk7XG5cbi8vIC0tLS0tLS0tLS0gbG9nZ2VyIC0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ0xvZ2dlcicsICgpID0+IHtcbiAgaXQoJ3dyaXRlcyBKU09OLWxpbmVzIGVudHJpZXMgdG8gZmlsZScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBkaXIgPSB0bXBEaXIoKTtcbiAgICBjbGVhbnVwRGlycy5wdXNoKGRpcik7XG4gICAgY29uc3QgbG9nUGF0aCA9IGpvaW4oZGlyLCAndGVzdC5sb2cnKTtcblxuICAgIGNvbnN0IGxvZ2dlciA9IG5ldyBMb2dnZXIoeyBmaWxlUGF0aDogbG9nUGF0aCwgbGV2ZWw6ICdkZWJ1ZycgfSk7XG4gICAgbG9nZ2VyLmluZm8oJ2hlbGxvIHdvcmxkJyk7XG4gICAgbG9nZ2VyLmRlYnVnKCdkZXRhaWwnLCB7IGtleTogJ3ZhbCcgfSk7XG4gICAgYXdhaXQgbG9nZ2VyLmNsb3NlKCk7XG5cbiAgICBjb25zdCBsaW5lcyA9IHJlYWRGaWxlU3luYyhsb2dQYXRoLCAndXRmLTgnKS50cmltKCkuc3BsaXQoJ1xcbicpO1xuICAgIGFzc2VydC5lcXVhbChsaW5lcy5sZW5ndGgsIDIpO1xuXG4gICAgY29uc3QgZW50cnkwOiBMb2dFbnRyeSA9IEpTT04ucGFyc2UobGluZXNbMF0hKTtcbiAgICBhc3NlcnQuZXF1YWwoZW50cnkwLmxldmVsLCAnaW5mbycpO1xuICAgIGFzc2VydC5lcXVhbChlbnRyeTAubXNnLCAnaGVsbG8gd29ybGQnKTtcbiAgICBhc3NlcnQub2soZW50cnkwLnRzKTsgLy8gSVNPLTg2MDFcblxuICAgIGNvbnN0IGVudHJ5MTogTG9nRW50cnkgPSBKU09OLnBhcnNlKGxpbmVzWzFdISk7XG4gICAgYXNzZXJ0LmVxdWFsKGVudHJ5MS5sZXZlbCwgJ2RlYnVnJyk7XG4gICAgYXNzZXJ0LmVxdWFsKGVudHJ5MS5tc2csICdkZXRhaWwnKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGVudHJ5MS5kYXRhLCB7IGtleTogJ3ZhbCcgfSk7XG4gIH0pO1xuXG4gIGl0KCdmaWx0ZXJzIGVudHJpZXMgYmVsb3cgY29uZmlndXJlZCBsZXZlbCcsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBkaXIgPSB0bXBEaXIoKTtcbiAgICBjbGVhbnVwRGlycy5wdXNoKGRpcik7XG4gICAgY29uc3QgbG9nUGF0aCA9IGpvaW4oZGlyLCAnZmlsdGVyLmxvZycpO1xuXG4gICAgY29uc3QgbG9nZ2VyID0gbmV3IExvZ2dlcih7IGZpbGVQYXRoOiBsb2dQYXRoLCBsZXZlbDogJ3dhcm4nIH0pO1xuICAgIGxvZ2dlci5kZWJ1Zygnc2hvdWxkIG5vdCBhcHBlYXInKTtcbiAgICBsb2dnZXIuaW5mbygnc2hvdWxkIG5vdCBhcHBlYXIgZWl0aGVyJyk7XG4gICAgbG9nZ2VyLndhcm4oJ3Zpc2libGUgd2FybmluZycpO1xuICAgIGxvZ2dlci5lcnJvcigndmlzaWJsZSBlcnJvcicpO1xuICAgIGF3YWl0IGxvZ2dlci5jbG9zZSgpO1xuXG4gICAgY29uc3QgbGluZXMgPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgJ3V0Zi04JykudHJpbSgpLnNwbGl0KCdcXG4nKTtcbiAgICBhc3NlcnQuZXF1YWwobGluZXMubGVuZ3RoLCAyKTtcbiAgICBhc3NlcnQuZXF1YWwoKEpTT04ucGFyc2UobGluZXNbMF0hKSBhcyBMb2dFbnRyeSkubGV2ZWwsICd3YXJuJyk7XG4gICAgYXNzZXJ0LmVxdWFsKChKU09OLnBhcnNlKGxpbmVzWzFdISkgYXMgTG9nRW50cnkpLmxldmVsLCAnZXJyb3InKTtcbiAgfSk7XG5cbiAgaXQoJ2Nsb3NlKCkgcmVzb2x2ZXMgYWZ0ZXIgc3RyZWFtIGVuZHMnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZGlyID0gdG1wRGlyKCk7XG4gICAgY2xlYW51cERpcnMucHVzaChkaXIpO1xuICAgIGNvbnN0IGxvZ1BhdGggPSBqb2luKGRpciwgJ2Nsb3NlLmxvZycpO1xuXG4gICAgY29uc3QgbG9nZ2VyID0gbmV3IExvZ2dlcih7IGZpbGVQYXRoOiBsb2dQYXRoLCBsZXZlbDogJ2luZm8nIH0pO1xuICAgIGxvZ2dlci5pbmZvKCdiZWZvcmUgY2xvc2UnKTtcbiAgICBhd2FpdCBsb2dnZXIuY2xvc2UoKTtcblxuICAgIC8vIEZpbGUgc2hvdWxkIGJlIHJlYWRhYmxlIGFuZCBjb250YWluIHRoZSBlbnRyeVxuICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgJ3V0Zi04Jyk7XG4gICAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoJ2JlZm9yZSBjbG9zZScpKTtcbiAgfSk7XG5cbiAgaXQoJ2NyZWF0ZXMgcGFyZW50IGRpcmVjdG9yaWVzIGlmIHRoZXkgZG8gbm90IGV4aXN0JywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IHRtcERpcigpO1xuICAgIGNsZWFudXBEaXJzLnB1c2goZGlyKTtcbiAgICBjb25zdCBsb2dQYXRoID0gam9pbihkaXIsICduZXN0ZWQnLCAnZGVlcCcsICd0ZXN0LmxvZycpO1xuXG4gICAgY29uc3QgbG9nZ2VyID0gbmV3IExvZ2dlcih7IGZpbGVQYXRoOiBsb2dQYXRoLCBsZXZlbDogJ2luZm8nIH0pO1xuICAgIGxvZ2dlci5pbmZvKCduZXN0ZWQgZGlyIHRlc3QnKTtcbiAgICBhd2FpdCBsb2dnZXIuY2xvc2UoKTtcblxuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKGxvZ1BhdGgpKTtcbiAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGxvZ1BhdGgsICd1dGYtOCcpO1xuICAgIGFzc2VydC5vayhjb250ZW50LmluY2x1ZGVzKCduZXN0ZWQgZGlyIHRlc3QnKSk7XG4gIH0pO1xuXG4gIGl0KCdkb2VzIG5vdCBpbmNsdWRlIGRhdGEgZmllbGQgd2hlbiBub3QgcHJvdmlkZWQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZGlyID0gdG1wRGlyKCk7XG4gICAgY2xlYW51cERpcnMucHVzaChkaXIpO1xuICAgIGNvbnN0IGxvZ1BhdGggPSBqb2luKGRpciwgJ25vZGF0YS5sb2cnKTtcblxuICAgIGNvbnN0IGxvZ2dlciA9IG5ldyBMb2dnZXIoeyBmaWxlUGF0aDogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJyB9KTtcbiAgICBsb2dnZXIuaW5mbygnbm8gZXh0cmEgZGF0YScpO1xuICAgIGF3YWl0IGxvZ2dlci5jbG9zZSgpO1xuXG4gICAgY29uc3QgZW50cnk6IExvZ0VudHJ5ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMobG9nUGF0aCwgJ3V0Zi04JykudHJpbSgpKTtcbiAgICBhc3NlcnQuZXF1YWwoZW50cnkuZGF0YSwgdW5kZWZpbmVkKTtcbiAgICAvLyBBbHNvIHZlcmlmeSB0aGUgcmF3IEpTT04gZG9lc24ndCBjb250YWluIFwiZGF0YVwiIGtleVxuICAgIGFzc2VydC5vayghcmVhZEZpbGVTeW5jKGxvZ1BhdGgsICd1dGYtOCcpLmluY2x1ZGVzKCdcImRhdGFcIicpKTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLSB0b2tlbiBzYWZldHkgLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgndG9rZW4gc2FmZXR5JywgKCkgPT4ge1xuICBpdCgnZGlzY29yZCB0b2tlbiBuZXZlciBhcHBlYXJzIGluIGxvZyBvdXRwdXQnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZGlyID0gdG1wRGlyKCk7XG4gICAgY2xlYW51cERpcnMucHVzaChkaXIpO1xuICAgIGNvbnN0IGxvZ1BhdGggPSBqb2luKGRpciwgJ3Rva2VuLXNhZmV0eS5sb2cnKTtcblxuICAgIC8vIENvbmZpZyB3aXRoIGEgdG9rZW5cbiAgICBjb25zdCBwcmV2ID0gcHJvY2Vzcy5lbnZbJ0RJU0NPUkRfQk9UX1RPS0VOJ107XG4gICAgdHJ5IHtcbiAgICAgIHByb2Nlc3MuZW52WydESVNDT1JEX0JPVF9UT0tFTiddID0gJ3N1cGVyLXNlY3JldC10b2tlbi12YWx1ZSc7XG4gICAgICBjb25zdCBjZmcgPSB2YWxpZGF0ZUNvbmZpZyh7fSk7XG5cbiAgICAgIGNvbnN0IGxvZ2dlciA9IG5ldyBMb2dnZXIoeyBmaWxlUGF0aDogbG9nUGF0aCwgbGV2ZWw6ICdkZWJ1ZycgfSk7XG4gICAgICAvLyBMb2cgdGhlIGNvbmZpZyBvYmplY3QgXHUyMDE0IHRva2VuIG11c3Qgbm90IGxlYWtcbiAgICAgIGxvZ2dlci5pbmZvKCdjb25maWcgbG9hZGVkJywgeyBkaXNjb3JkX2NvbmZpZ3VyZWQ6ICEhY2ZnLmRpc2NvcmQgfSk7XG4gICAgICBsb2dnZXIuZGVidWcoJ3N0YXJ0dXAgY29tcGxldGUnKTtcbiAgICAgIGF3YWl0IGxvZ2dlci5jbG9zZSgpO1xuXG4gICAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGxvZ1BhdGgsICd1dGYtOCcpO1xuICAgICAgYXNzZXJ0Lm9rKCFjb250ZW50LmluY2x1ZGVzKCdzdXBlci1zZWNyZXQtdG9rZW4tdmFsdWUnKSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGlmIChwcmV2ID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudlsnRElTQ09SRF9CT1RfVE9LRU4nXTtcbiAgICAgIGVsc2UgcHJvY2Vzcy5lbnZbJ0RJU0NPUkRfQk9UX1RPS0VOJ10gPSBwcmV2O1xuICAgIH1cbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLSBkYWVtb24gbGlmZWN5Y2xlIC0tLS0tLS0tLS1cblxuLy8gUmVzb2x2ZSB0aGUgZGlzdC8gZGlyZWN0b3J5IGZvciBzcGF3bmluZyBDTElcbmNvbnN0IF9fZmlsZW5hbWUgPSBmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCk7XG5jb25zdCBfX2Rpcm5hbWUgPSBkaXJuYW1lKF9fZmlsZW5hbWUpO1xuXG5kZXNjcmliZSgnRGFlbW9uJywgKCkgPT4ge1xuICBpdCgnbG9ncyBsaWZlY3ljbGUgZXZlbnRzIG9uIHN0YXJ0IGFuZCBzaHV0ZG93bicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBkaXIgPSB0bXBEaXIoKTtcbiAgICBjbGVhbnVwRGlycy5wdXNoKGRpcik7XG4gICAgY29uc3QgbG9nUGF0aCA9IGpvaW4oZGlyLCAnZGFlbW9uLWxpZmVjeWNsZS5sb2cnKTtcblxuICAgIGNvbnN0IGNvbmZpZzogRGFlbW9uQ29uZmlnID0ge1xuICAgICAgZGlzY29yZDogdW5kZWZpbmVkLFxuICAgICAgcHJvamVjdHM6IHsgc2Nhbl9yb290czogWycvYScsICcvYiddIH0sXG4gICAgICBsb2c6IHsgZmlsZTogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJywgbWF4X3NpemVfbWI6IDUwIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IGxvZ2dlciA9IG5ldyBMb2dnZXIoeyBmaWxlUGF0aDogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJyB9KTtcbiAgICBjb25zdCBkYWVtb24gPSBuZXcgRGFlbW9uKGNvbmZpZywgbG9nZ2VyKTtcblxuICAgIGF3YWl0IGRhZW1vbi5zdGFydCgpO1xuXG4gICAgLy8gc3RhcnQoKSBzaG91bGQgaGF2ZSBsb2dnZWQgJ2RhZW1vbiBzdGFydGVkJ1xuICAgIC8vIHNodXRkb3duKCkgZGlyZWN0bHkgXHUyMDE0IHdlIG92ZXJyaWRlIHByb2Nlc3MuZXhpdCB0byBwcmV2ZW50IHRlc3QgcnVubmVyIGZyb20gZHlpbmdcbiAgICBjb25zdCBvcmlnRXhpdCA9IHByb2Nlc3MuZXhpdDtcbiAgICBsZXQgZXhpdENvZGU6IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgICAvLyBAdHMtZXhwZWN0LWVycm9yIFx1MjAxNCBvdmVycmlkaW5nIHByb2Nlc3MuZXhpdCBmb3IgdGVzdFxuICAgIHByb2Nlc3MuZXhpdCA9IChjb2RlPzogbnVtYmVyKSA9PiB7IGV4aXRDb2RlID0gY29kZSA/PyAwOyB9O1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBkYWVtb24uc2h1dGRvd24oKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5leGl0ID0gb3JpZ0V4aXQ7XG4gICAgfVxuXG4gICAgYXNzZXJ0LmVxdWFsKGV4aXRDb2RlLCAwKTtcblxuICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgJ3V0Zi04Jyk7XG4gICAgY29uc3QgbGluZXMgPSBjb250ZW50LnRyaW0oKS5zcGxpdCgnXFxuJyk7XG5cbiAgICAvLyBGaXJzdCBsaW5lOiBkYWVtb24gc3RhcnRlZFxuICAgIGNvbnN0IHN0YXJ0RW50cnk6IExvZ0VudHJ5ID0gSlNPTi5wYXJzZShsaW5lc1swXSEpO1xuICAgIGFzc2VydC5lcXVhbChzdGFydEVudHJ5Lm1zZywgJ2RhZW1vbiBzdGFydGVkJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHN0YXJ0RW50cnkuZGF0YT8uc2Nhbl9yb290cywgMik7XG4gICAgYXNzZXJ0LmVxdWFsKHN0YXJ0RW50cnkuZGF0YT8uZGlzY29yZF9jb25maWd1cmVkLCBmYWxzZSk7XG5cbiAgICAvLyBTZWNvbmQgbGluZTogZGFlbW9uIHNodXR0aW5nIGRvd25cbiAgICBjb25zdCBzdG9wRW50cnk6IExvZ0VudHJ5ID0gSlNPTi5wYXJzZShsaW5lc1sxXSEpO1xuICAgIGFzc2VydC5lcXVhbChzdG9wRW50cnkubXNnLCAnZGFlbW9uIHNodXR0aW5nIGRvd24nKTtcbiAgfSk7XG5cbiAgaXQoJ3NodXRkb3duIGlzIGlkZW1wb3RlbnQgXHUyMDE0IHNlY29uZCBjYWxsIGlzIGEgbm8tb3AnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZGlyID0gdG1wRGlyKCk7XG4gICAgY2xlYW51cERpcnMucHVzaChkaXIpO1xuICAgIGNvbnN0IGxvZ1BhdGggPSBqb2luKGRpciwgJ2lkZW1wb3RlbnQubG9nJyk7XG5cbiAgICBjb25zdCBjb25maWc6IERhZW1vbkNvbmZpZyA9IHtcbiAgICAgIGRpc2NvcmQ6IHVuZGVmaW5lZCxcbiAgICAgIHByb2plY3RzOiB7IHNjYW5fcm9vdHM6IFtdIH0sXG4gICAgICBsb2c6IHsgZmlsZTogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJywgbWF4X3NpemVfbWI6IDUwIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IGxvZ2dlciA9IG5ldyBMb2dnZXIoeyBmaWxlUGF0aDogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJyB9KTtcbiAgICBjb25zdCBkYWVtb24gPSBuZXcgRGFlbW9uKGNvbmZpZywgbG9nZ2VyKTtcblxuICAgIGF3YWl0IGRhZW1vbi5zdGFydCgpO1xuXG4gICAgY29uc3Qgb3JpZ0V4aXQgPSBwcm9jZXNzLmV4aXQ7XG4gICAgbGV0IGV4aXRDb3VudCA9IDA7XG4gICAgLy8gQHRzLWV4cGVjdC1lcnJvciBcdTIwMTQgb3ZlcnJpZGluZyBwcm9jZXNzLmV4aXQgZm9yIHRlc3RcbiAgICBwcm9jZXNzLmV4aXQgPSAoKSA9PiB7IGV4aXRDb3VudCsrOyB9O1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBkYWVtb24uc2h1dGRvd24oKTtcbiAgICAgIGF3YWl0IGRhZW1vbi5zaHV0ZG93bigpOyAvLyBzZWNvbmQgY2FsbCBcdTIwMTQgc2hvdWxkIGJlIG5vLW9wXG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuZXhpdCA9IG9yaWdFeGl0O1xuICAgIH1cblxuICAgIGFzc2VydC5lcXVhbChleGl0Q291bnQsIDEsICdwcm9jZXNzLmV4aXQgc2hvdWxkIGJlIGNhbGxlZCBleGFjdGx5IG9uY2UnKTtcblxuICAgIGNvbnN0IGxpbmVzID0gcmVhZEZpbGVTeW5jKGxvZ1BhdGgsICd1dGYtOCcpLnRyaW0oKS5zcGxpdCgnXFxuJyk7XG4gICAgY29uc3Qgc2h1dGRvd25MaW5lcyA9IGxpbmVzLmZpbHRlcihsID0+IHtcbiAgICAgIGNvbnN0IGU6IExvZ0VudHJ5ID0gSlNPTi5wYXJzZShsKTtcbiAgICAgIHJldHVybiBlLm1zZyA9PT0gJ2RhZW1vbiBzaHV0dGluZyBkb3duJztcbiAgICB9KTtcbiAgICBhc3NlcnQuZXF1YWwoc2h1dGRvd25MaW5lcy5sZW5ndGgsIDEsICdzaHV0ZG93biBsb2cgc2hvdWxkIGFwcGVhciBleGFjdGx5IG9uY2UnKTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLSBIZWFsdGggaGVhcnRiZWF0IC0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ0hlYWx0aCBoZWFydGJlYXQnLCAoKSA9PiB7XG4gIGl0KCdsb2dzIGhlYWx0aCBlbnRyeSB3aXRoIGV4cGVjdGVkIGZpZWxkcyBhZnRlciBpbnRlcnZhbCB0aWNrJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IHRtcERpcigpO1xuICAgIGNsZWFudXBEaXJzLnB1c2goZGlyKTtcbiAgICBjb25zdCBsb2dQYXRoID0gam9pbihkaXIsICdoZWFsdGgubG9nJyk7XG5cbiAgICBjb25zdCBjb25maWc6IERhZW1vbkNvbmZpZyA9IHtcbiAgICAgIGRpc2NvcmQ6IHVuZGVmaW5lZCxcbiAgICAgIHByb2plY3RzOiB7IHNjYW5fcm9vdHM6IFtdIH0sXG4gICAgICBsb2c6IHsgZmlsZTogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJywgbWF4X3NpemVfbWI6IDUwIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IGxvZ2dlciA9IG5ldyBMb2dnZXIoeyBmaWxlUGF0aDogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJyB9KTtcbiAgICAvLyBVc2UgNTBtcyBpbnRlcnZhbCBmb3IgZmFzdCB0ZXN0XG4gICAgY29uc3QgZGFlbW9uID0gbmV3IERhZW1vbihjb25maWcsIGxvZ2dlciwgNTApO1xuXG4gICAgYXdhaXQgZGFlbW9uLnN0YXJ0KCk7XG5cbiAgICAvLyBXYWl0IGZvciBhdCBsZWFzdCBvbmUgaGVhbHRoIHRpY2tcbiAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMjApKTtcblxuICAgIGNvbnN0IG9yaWdFeGl0ID0gcHJvY2Vzcy5leGl0O1xuICAgIC8vIEB0cy1leHBlY3QtZXJyb3IgXHUyMDE0IG92ZXJyaWRpbmcgcHJvY2Vzcy5leGl0IGZvciB0ZXN0XG4gICAgcHJvY2Vzcy5leGl0ID0gKCkgPT4ge307XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGRhZW1vbi5zaHV0ZG93bigpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmV4aXQgPSBvcmlnRXhpdDtcbiAgICB9XG5cbiAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGxvZ1BhdGgsICd1dGYtOCcpO1xuICAgIGNvbnN0IGxpbmVzID0gY29udGVudC50cmltKCkuc3BsaXQoJ1xcbicpO1xuICAgIGNvbnN0IGhlYWx0aExpbmVzID0gbGluZXMuZmlsdGVyKChsKSA9PiB7XG4gICAgICBjb25zdCBlOiBMb2dFbnRyeSA9IEpTT04ucGFyc2UobCk7XG4gICAgICByZXR1cm4gZS5tc2cgPT09ICdoZWFsdGgnO1xuICAgIH0pO1xuXG4gICAgYXNzZXJ0Lm9rKGhlYWx0aExpbmVzLmxlbmd0aCA+PSAxLCAnc2hvdWxkIGhhdmUgYXQgbGVhc3Qgb25lIGhlYWx0aCBsb2cgZW50cnknKTtcblxuICAgIGNvbnN0IGVudHJ5OiBMb2dFbnRyeSA9IEpTT04ucGFyc2UoaGVhbHRoTGluZXNbMF0hKTtcbiAgICBhc3NlcnQuZXF1YWwoZW50cnkubXNnLCAnaGVhbHRoJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBlbnRyeS5kYXRhPy51cHRpbWVfcywgJ251bWJlcicpO1xuICAgIGFzc2VydC5lcXVhbCh0eXBlb2YgZW50cnkuZGF0YT8uYWN0aXZlX3Nlc3Npb25zLCAnbnVtYmVyJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBlbnRyeS5kYXRhPy5kaXNjb3JkX2Nvbm5lY3RlZCwgJ2Jvb2xlYW4nKTtcbiAgICBhc3NlcnQuZXF1YWwodHlwZW9mIGVudHJ5LmRhdGE/Lm1lbW9yeV9yc3NfbWIsICdudW1iZXInKTtcbiAgICBhc3NlcnQuZXF1YWwoZW50cnkuZGF0YT8uZGlzY29yZF9jb25uZWN0ZWQsIGZhbHNlKTsgLy8gbm8gZGlzY29yZCBjb25maWd1cmVkXG4gICAgYXNzZXJ0LmVxdWFsKGVudHJ5LmRhdGE/LmFjdGl2ZV9zZXNzaW9ucywgMCk7IC8vIG5vIHNlc3Npb25zXG4gIH0pO1xuXG4gIGl0KCdoZWFsdGggdGltZXIgaXMgY2xlYXJlZCBvbiBzaHV0ZG93biBcdTIwMTQgbm8gbGluZ2VyaW5nIGludGVydmFscycsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBkaXIgPSB0bXBEaXIoKTtcbiAgICBjbGVhbnVwRGlycy5wdXNoKGRpcik7XG4gICAgY29uc3QgbG9nUGF0aCA9IGpvaW4oZGlyLCAnaGVhbHRoLWNsZWFudXAubG9nJyk7XG5cbiAgICBjb25zdCBjb25maWc6IERhZW1vbkNvbmZpZyA9IHtcbiAgICAgIGRpc2NvcmQ6IHVuZGVmaW5lZCxcbiAgICAgIHByb2plY3RzOiB7IHNjYW5fcm9vdHM6IFtdIH0sXG4gICAgICBsb2c6IHsgZmlsZTogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJywgbWF4X3NpemVfbWI6IDUwIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IGxvZ2dlciA9IG5ldyBMb2dnZXIoeyBmaWxlUGF0aDogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJyB9KTtcbiAgICAvLyBVc2UgNTBtcyBpbnRlcnZhbFxuICAgIGNvbnN0IGRhZW1vbiA9IG5ldyBEYWVtb24oY29uZmlnLCBsb2dnZXIsIDUwKTtcblxuICAgIGF3YWl0IGRhZW1vbi5zdGFydCgpO1xuXG4gICAgLy8gV2FpdCBmb3Igb25lIHRpY2tcbiAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA4MCkpO1xuXG4gICAgY29uc3Qgb3JpZ0V4aXQgPSBwcm9jZXNzLmV4aXQ7XG4gICAgLy8gQHRzLWV4cGVjdC1lcnJvciBcdTIwMTQgb3ZlcnJpZGluZyBwcm9jZXNzLmV4aXQgZm9yIHRlc3RcbiAgICBwcm9jZXNzLmV4aXQgPSAoKSA9PiB7fTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgZGFlbW9uLnNodXRkb3duKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuZXhpdCA9IG9yaWdFeGl0O1xuICAgIH1cblxuICAgIC8vIENvdW50IGhlYWx0aCBlbnRyaWVzIGF0IHNodXRkb3duXG4gICAgY29uc3QgY29udGVudEF0U2h1dGRvd24gPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgJ3V0Zi04Jyk7XG4gICAgY29uc3QgaGVhbHRoQ291bnRBdFNodXRkb3duID0gY29udGVudEF0U2h1dGRvd25cbiAgICAgIC50cmltKClcbiAgICAgIC5zcGxpdCgnXFxuJylcbiAgICAgIC5maWx0ZXIoKGwpID0+IEpTT04ucGFyc2UobCkubXNnID09PSAnaGVhbHRoJykubGVuZ3RoO1xuXG4gICAgLy8gV2FpdCBhbm90aGVyIGludGVydmFsIFx1MjAxNCBubyBuZXcgaGVhbHRoIGVudHJpZXMgc2hvdWxkIGFwcGVhclxuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEyMCkpO1xuXG4gICAgLy8gUmUtcmVhZCAobG9nZ2VyIGlzIGNsb3NlZCwgc28gZmlsZSBzaG91bGRuJ3QgY2hhbmdlKVxuICAgIGNvbnN0IGNvbnRlbnRBZnRlcldhaXQgPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgJ3V0Zi04Jyk7XG4gICAgY29uc3QgaGVhbHRoQ291bnRBZnRlcldhaXQgPSBjb250ZW50QWZ0ZXJXYWl0XG4gICAgICAudHJpbSgpXG4gICAgICAuc3BsaXQoJ1xcbicpXG4gICAgICAuZmlsdGVyKChsKSA9PiBKU09OLnBhcnNlKGwpLm1zZyA9PT0gJ2hlYWx0aCcpLmxlbmd0aDtcblxuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIGhlYWx0aENvdW50QWZ0ZXJXYWl0LFxuICAgICAgaGVhbHRoQ291bnRBdFNodXRkb3duLFxuICAgICAgJ25vIG5ldyBoZWFsdGggZW50cmllcyBzaG91bGQgYXBwZWFyIGFmdGVyIHNodXRkb3duJyxcbiAgICApO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZSgnQ0xJIGludGVncmF0aW9uJywgKCkgPT4ge1xuICBpdCgnLS1oZWxwIHByaW50cyB1c2FnZSBhbmQgZXhpdHMgMCcsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBleGVjRmlsZVN5bmMoXG4gICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgW2pvaW4oX19kaXJuYW1lLCAnY2xpLmpzJyksICctLWhlbHAnXSxcbiAgICAgIHsgZW5jb2Rpbmc6ICd1dGYtOCcsIHRpbWVvdXQ6IDUwMDAgfSxcbiAgICApO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoJ1VzYWdlOiBnc2QtZGFlbW9uJykpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoJy0tY29uZmlnJykpO1xuICAgIGFzc2VydC5vayhyZXN1bHQuaW5jbHVkZXMoJy0tdmVyYm9zZScpKTtcbiAgfSk7XG5cbiAgaXQoJ3N0YXJ0cywgbG9ncyB0byBmaWxlLCBhbmQgZXhpdHMgY2xlYW5seSBvbiBTSUdURVJNJywgeyB0aW1lb3V0OiAxNTAwMCB9LCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZGlyID0gdG1wRGlyKCk7XG4gICAgY2xlYW51cERpcnMucHVzaChkaXIpO1xuICAgIGNvbnN0IGxvZ1BhdGggPSBqb2luKGRpciwgJ2ludGVncmF0aW9uLmxvZycpO1xuICAgIGNvbnN0IGNvbmZpZ1BhdGggPSBqb2luKGRpciwgJ2RhZW1vbi55YW1sJyk7XG5cbiAgICB3cml0ZUZpbGVTeW5jKGNvbmZpZ1BhdGgsIGBcbnByb2plY3RzOlxuICBzY2FuX3Jvb3RzOlxuICAgIC0gL3RtcC90ZXN0LXByb2plY3RcbmxvZzpcbiAgZmlsZTogXCIke2xvZ1BhdGh9XCJcbiAgbGV2ZWw6IGluZm9cbiAgbWF4X3NpemVfbWI6IDEwXG5gKTtcblxuICAgIC8vIFVzZSBleGVjRmlsZSB3aXRoIGEgd3JhcHBlciBzY3JpcHQgYXBwcm9hY2g6IHNwYXduLCB3YWl0IGZvciBzdGFydCwgU0lHVEVSTSwgdmVyaWZ5XG4gICAgY29uc3QgZXhpdENvZGUgPSBhd2FpdCBuZXcgUHJvbWlzZTxudW1iZXI+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IGNoaWxkID0gc3Bhd24oXG4gICAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIFtqb2luKF9fZGlybmFtZSwgJ2NsaS5qcycpLCAnLS1jb25maWcnLCBjb25maWdQYXRoXSxcbiAgICAgICAgeyBzdGRpbzogJ2lnbm9yZScgfSxcbiAgICAgICk7XG5cbiAgICAgIGxldCByZXNvbHZlZCA9IGZhbHNlO1xuICAgICAgY2hpbGQub24oJ2Vycm9yJywgKGVycikgPT4geyBpZiAoIXJlc29sdmVkKSB7IHJlc29sdmVkID0gdHJ1ZTsgcmVqZWN0KGVycik7IH0gfSk7XG4gICAgICBjaGlsZC5vbignZXhpdCcsIChjb2RlKSA9PiB7IGlmICghcmVzb2x2ZWQpIHsgcmVzb2x2ZWQgPSB0cnVlOyByZXNvbHZlKGNvZGUgPz8gMSk7IH0gfSk7XG5cbiAgICAgIC8vIFBvbGwgZm9yIHN0YXJ0dXAsIHRoZW4gc2VuZCBTSUdURVJNXG4gICAgICBjb25zdCBwb2xsID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgICBpZiAoZXhpc3RzU3luYyhsb2dQYXRoKSkge1xuICAgICAgICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgJ3V0Zi04Jyk7XG4gICAgICAgICAgaWYgKGNvbnRlbnQuaW5jbHVkZXMoJ2RhZW1vbiBzdGFydGVkJykpIHtcbiAgICAgICAgICAgIGNsZWFySW50ZXJ2YWwocG9sbCk7XG4gICAgICAgICAgICBjaGlsZC5raWxsKCdTSUdURVJNJyk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9LCAxMDApO1xuXG4gICAgICAvLyBTYWZldHk6IGtpbGwgY2hpbGQgaWYgaXQgdGFrZXMgdG9vIGxvbmdcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBjbGVhckludGVydmFsKHBvbGwpO1xuICAgICAgICBpZiAoIXJlc29sdmVkKSB7XG4gICAgICAgICAgY2hpbGQua2lsbCgnU0lHS0lMTCcpO1xuICAgICAgICAgIHJlc29sdmVkID0gdHJ1ZTtcbiAgICAgICAgICByZWplY3QobmV3IEVycm9yKCd0aW1lZCBvdXQgd2FpdGluZyBmb3IgZGFlbW9uJykpO1xuICAgICAgICB9XG4gICAgICB9LCAxMDAwMCk7XG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwoZXhpdENvZGUsIDAsICdkYWVtb24gc2hvdWxkIGV4aXQgd2l0aCBjb2RlIDAgb24gU0lHVEVSTScpO1xuXG4gICAgLy8gU21hbGwgZGVsYXkgZm9yIGZpbGVzeXN0ZW0gZmx1c2hcbiAgICBhd2FpdCBuZXcgUHJvbWlzZShyID0+IHNldFRpbWVvdXQociwgMTAwKSk7XG5cbiAgICAvLyBWZXJpZnkgbG9nIGZpbGUgY29udGVudHNcbiAgICBjb25zdCBmaW5hbENvbnRlbnQgPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgJ3V0Zi04Jyk7XG4gICAgYXNzZXJ0Lm9rKGZpbmFsQ29udGVudC5pbmNsdWRlcygnZGFlbW9uIHN0YXJ0ZWQnKSwgJ2xvZyBzaG91bGQgY29udGFpbiBzdGFydHVwIGVudHJ5Jyk7XG4gICAgYXNzZXJ0Lm9rKGZpbmFsQ29udGVudC5pbmNsdWRlcygnZGFlbW9uIHNodXR0aW5nIGRvd24nKSwgJ2xvZyBzaG91bGQgY29udGFpbiBzaHV0ZG93biBlbnRyeScpO1xuXG4gICAgLy8gVmVyaWZ5IGxvZyBlbnRyaWVzIGFyZSB2YWxpZCBKU09OLWxpbmVzXG4gICAgY29uc3QgbGluZXMgPSBmaW5hbENvbnRlbnQudHJpbSgpLnNwbGl0KCdcXG4nKTtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICAgIGNvbnN0IGVudHJ5OiBMb2dFbnRyeSA9IEpTT04ucGFyc2UobGluZSk7XG4gICAgICBhc3NlcnQub2soZW50cnkudHMsICdlYWNoIGVudHJ5IHNob3VsZCBoYXZlIGEgdGltZXN0YW1wJyk7XG4gICAgICBhc3NlcnQub2soZW50cnkubGV2ZWwsICdlYWNoIGVudHJ5IHNob3VsZCBoYXZlIGEgbGV2ZWwnKTtcbiAgICAgIGFzc2VydC5vayhlbnRyeS5tc2csICdlYWNoIGVudHJ5IHNob3VsZCBoYXZlIGEgbWVzc2FnZScpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoJ2V4aXRzIHdpdGggY29kZSAxIG9uIGludmFsaWQgY29uZmlnJywgKCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IHRtcERpcigpO1xuICAgIGNsZWFudXBEaXJzLnB1c2goZGlyKTtcbiAgICBjb25zdCBjb25maWdQYXRoID0gam9pbihkaXIsICdiYWQueWFtbCcpO1xuICAgIHdyaXRlRmlsZVN5bmMoY29uZmlnUGF0aCwgJzpcXG4gIDpcXG4gICAgYmFkOiBbdW5jbG9zZWQnKTtcblxuICAgIHRyeSB7XG4gICAgICBleGVjRmlsZVN5bmMoXG4gICAgICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIFtqb2luKF9fZGlybmFtZSwgJ2NsaS5qcycpLCAnLS1jb25maWcnLCBjb25maWdQYXRoXSxcbiAgICAgICAgeyBlbmNvZGluZzogJ3V0Zi04JywgdGltZW91dDogNTAwMCB9LFxuICAgICAgKTtcbiAgICAgIGFzc2VydC5mYWlsKCdzaG91bGQgaGF2ZSB0aHJvd24nKTtcbiAgICB9IGNhdGNoIChlcnI6IHVua25vd24pIHtcbiAgICAgIC8vIGV4ZWNGaWxlU3luYyB0aHJvd3Mgb24gbm9uLXplcm8gZXhpdFxuICAgICAgY29uc3QgZXhlY0VyciA9IGVyciBhcyB7IHN0YXR1czogbnVtYmVyOyBzdGRlcnI6IHN0cmluZyB9O1xuICAgICAgYXNzZXJ0LmVxdWFsKGV4ZWNFcnIuc3RhdHVzLCAxKTtcbiAgICAgIGFzc2VydC5vayhleGVjRXJyLnN0ZGVyci5pbmNsdWRlcygnZmF0YWwnKSk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG4vLyAtLS0tLS0tLS0tIERhZW1vbiArIFNlc3Npb25NYW5hZ2VyIGludGVncmF0aW9uIC0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ0RhZW1vbiBpbnRlZ3JhdGlvbicsICgpID0+IHtcbiAgaXQoJ2dldFNlc3Npb25NYW5hZ2VyKCkgcmV0dXJucyBTZXNzaW9uTWFuYWdlciBhZnRlciBzdGFydCgpJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGRpciA9IHRtcERpcigpO1xuICAgIGNsZWFudXBEaXJzLnB1c2goZGlyKTtcbiAgICBjb25zdCBsb2dQYXRoID0gam9pbihkaXIsICdkYWVtb24tc20ubG9nJyk7XG5cbiAgICBjb25zdCBjb25maWc6IERhZW1vbkNvbmZpZyA9IHtcbiAgICAgIGRpc2NvcmQ6IHVuZGVmaW5lZCxcbiAgICAgIHByb2plY3RzOiB7IHNjYW5fcm9vdHM6IFtdIH0sXG4gICAgICBsb2c6IHsgZmlsZTogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJywgbWF4X3NpemVfbWI6IDUwIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IGxvZ2dlciA9IG5ldyBMb2dnZXIoeyBmaWxlUGF0aDogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJyB9KTtcbiAgICBjb25zdCBkYWVtb24gPSBuZXcgRGFlbW9uKGNvbmZpZywgbG9nZ2VyKTtcblxuICAgIGF3YWl0IGRhZW1vbi5zdGFydCgpO1xuXG4gICAgY29uc3Qgc20gPSBkYWVtb24uZ2V0U2Vzc2lvbk1hbmFnZXIoKTtcbiAgICBhc3NlcnQub2soc20gaW5zdGFuY2VvZiBTZXNzaW9uTWFuYWdlcik7XG5cbiAgICAvLyBDbGVhbiBzaHV0ZG93blxuICAgIGNvbnN0IG9yaWdFeGl0ID0gcHJvY2Vzcy5leGl0O1xuICAgIC8vIEB0cy1leHBlY3QtZXJyb3IgXHUyMDE0IG92ZXJyaWRpbmcgcHJvY2Vzcy5leGl0IGZvciB0ZXN0XG4gICAgcHJvY2Vzcy5leGl0ID0gKCkgPT4ge307XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGRhZW1vbi5zaHV0ZG93bigpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBwcm9jZXNzLmV4aXQgPSBvcmlnRXhpdDtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KCdnZXRTZXNzaW9uTWFuYWdlcigpIHRocm93cyBiZWZvcmUgc3RhcnQoKScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBkaXIgPSB0bXBEaXIoKTtcbiAgICBjbGVhbnVwRGlycy5wdXNoKGRpcik7XG4gICAgY29uc3QgbG9nUGF0aCA9IGpvaW4oZGlyLCAnZGFlbW9uLW5vc3RhcnQubG9nJyk7XG5cbiAgICBjb25zdCBjb25maWc6IERhZW1vbkNvbmZpZyA9IHtcbiAgICAgIGRpc2NvcmQ6IHVuZGVmaW5lZCxcbiAgICAgIHByb2plY3RzOiB7IHNjYW5fcm9vdHM6IFtdIH0sXG4gICAgICBsb2c6IHsgZmlsZTogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJywgbWF4X3NpemVfbWI6IDUwIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IGxvZ2dlciA9IG5ldyBMb2dnZXIoeyBmaWxlUGF0aDogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJyB9KTtcbiAgICBjb25zdCBkYWVtb24gPSBuZXcgRGFlbW9uKGNvbmZpZywgbG9nZ2VyKTtcblxuICAgIGFzc2VydC50aHJvd3MoXG4gICAgICAoKSA9PiBkYWVtb24uZ2V0U2Vzc2lvbk1hbmFnZXIoKSxcbiAgICAgIChlcnI6IEVycm9yKSA9PiB7XG4gICAgICAgIGFzc2VydC5vayhlcnIubWVzc2FnZS5pbmNsdWRlcygnRGFlbW9uIG5vdCBzdGFydGVkJykpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICApO1xuXG4gICAgLy8gQ2xvc2UgbG9nZ2VyIHRvIHByZXZlbnQgYXN5bmMgd3JpdGUgc3RyZWFtIGZyb20gaGl0dGluZyBjbGVhbmVkLXVwIHRtcGRpclxuICAgIGF3YWl0IGxvZ2dlci5jbG9zZSgpO1xuICB9KTtcblxuICBpdCgnc2NhblByb2plY3RzKCkgZGVsZWdhdGVzIHRvIHNjYW5Gb3JQcm9qZWN0cyB3aXRoIGNvbmZpZ3VyZWQgcm9vdHMnLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgZGlyID0gdG1wRGlyKCk7XG4gICAgY2xlYW51cERpcnMucHVzaChkaXIpO1xuICAgIGNvbnN0IGxvZ1BhdGggPSBqb2luKGRpciwgJ2RhZW1vbi1zY2FuLmxvZycpO1xuXG4gICAgLy8gQ3JlYXRlIGEgZmFrZSBwcm9qZWN0IHJvb3Qgd2l0aCBhIHByb2plY3QgdGhhdCBoYXMgYSAuZ2l0IG1hcmtlclxuICAgIGNvbnN0IHNjYW5Sb290ID0gam9pbihkaXIsICdwcm9qZWN0cycpO1xuICAgIG1rZGlyU3luYyhzY2FuUm9vdCk7XG4gICAgY29uc3QgcHJvamVjdERpciA9IGpvaW4oc2NhblJvb3QsICdteS1wcm9qZWN0Jyk7XG4gICAgbWtkaXJTeW5jKHByb2plY3REaXIpO1xuICAgIG1rZGlyU3luYyhqb2luKHByb2plY3REaXIsICcuZ2l0JykpO1xuXG4gICAgY29uc3QgY29uZmlnOiBEYWVtb25Db25maWcgPSB7XG4gICAgICBkaXNjb3JkOiB1bmRlZmluZWQsXG4gICAgICBwcm9qZWN0czogeyBzY2FuX3Jvb3RzOiBbc2NhblJvb3RdIH0sXG4gICAgICBsb2c6IHsgZmlsZTogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJywgbWF4X3NpemVfbWI6IDUwIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IGxvZ2dlciA9IG5ldyBMb2dnZXIoeyBmaWxlUGF0aDogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJyB9KTtcbiAgICBjb25zdCBkYWVtb24gPSBuZXcgRGFlbW9uKGNvbmZpZywgbG9nZ2VyKTtcblxuICAgIGF3YWl0IGRhZW1vbi5zdGFydCgpO1xuXG4gICAgY29uc3QgcHJvamVjdHMgPSBhd2FpdCBkYWVtb24uc2NhblByb2plY3RzKCk7XG4gICAgYXNzZXJ0Lm9rKHByb2plY3RzLmxlbmd0aCA+PSAxKTtcbiAgICBjb25zdCBmb3VuZCA9IHByb2plY3RzLmZpbmQocCA9PiBwLm5hbWUgPT09ICdteS1wcm9qZWN0Jyk7XG4gICAgYXNzZXJ0Lm9rKGZvdW5kKTtcbiAgICBhc3NlcnQub2soZm91bmQubWFya2Vycy5pbmNsdWRlcygnZ2l0JykpO1xuXG4gICAgLy8gQ2xlYW4gc2h1dGRvd25cbiAgICBjb25zdCBvcmlnRXhpdCA9IHByb2Nlc3MuZXhpdDtcbiAgICAvLyBAdHMtZXhwZWN0LWVycm9yIFx1MjAxNCBvdmVycmlkaW5nIHByb2Nlc3MuZXhpdCBmb3IgdGVzdFxuICAgIHByb2Nlc3MuZXhpdCA9ICgpID0+IHt9O1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBkYWVtb24uc2h1dGRvd24oKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5leGl0ID0gb3JpZ0V4aXQ7XG4gICAgfVxuICB9KTtcblxuICBpdCgnc2h1dGRvd24gY2xlYW5zIHVwIHNlc3Npb25NYW5hZ2VyIGJlZm9yZSBjbG9zaW5nIGxvZ2dlcicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBkaXIgPSB0bXBEaXIoKTtcbiAgICBjbGVhbnVwRGlycy5wdXNoKGRpcik7XG4gICAgY29uc3QgbG9nUGF0aCA9IGpvaW4oZGlyLCAnZGFlbW9uLWNsZWFudXAubG9nJyk7XG5cbiAgICBjb25zdCBjb25maWc6IERhZW1vbkNvbmZpZyA9IHtcbiAgICAgIGRpc2NvcmQ6IHVuZGVmaW5lZCxcbiAgICAgIHByb2plY3RzOiB7IHNjYW5fcm9vdHM6IFtdIH0sXG4gICAgICBsb2c6IHsgZmlsZTogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJywgbWF4X3NpemVfbWI6IDUwIH0sXG4gICAgfTtcblxuICAgIGNvbnN0IGxvZ2dlciA9IG5ldyBMb2dnZXIoeyBmaWxlUGF0aDogbG9nUGF0aCwgbGV2ZWw6ICdpbmZvJyB9KTtcbiAgICBjb25zdCBkYWVtb24gPSBuZXcgRGFlbW9uKGNvbmZpZywgbG9nZ2VyKTtcblxuICAgIGF3YWl0IGRhZW1vbi5zdGFydCgpO1xuXG4gICAgLy8gQWNjZXNzIHNlc3Npb25NYW5hZ2VyIHRvIHZlcmlmeSBpdCBleGlzdHNcbiAgICBjb25zdCBzbSA9IGRhZW1vbi5nZXRTZXNzaW9uTWFuYWdlcigpO1xuICAgIGFzc2VydC5vayhzbSk7XG5cbiAgICAvLyBTaHV0ZG93biBcdTIwMTQgc2hvdWxkIG5vdCB0aHJvdyBldmVuIHRob3VnaCBzZXNzaW9uTWFuYWdlciBoYXMgbm8gYWN0aXZlIHNlc3Npb25zXG4gICAgY29uc3Qgb3JpZ0V4aXQgPSBwcm9jZXNzLmV4aXQ7XG4gICAgLy8gQHRzLWV4cGVjdC1lcnJvciBcdTIwMTQgb3ZlcnJpZGluZyBwcm9jZXNzLmV4aXQgZm9yIHRlc3RcbiAgICBwcm9jZXNzLmV4aXQgPSAoKSA9PiB7fTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgZGFlbW9uLnNodXRkb3duKCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHByb2Nlc3MuZXhpdCA9IG9yaWdFeGl0O1xuICAgIH1cblxuICAgIC8vIFZlcmlmeSBsb2cgY29udGFpbnMgYm90aCBzdGFydGVkIGFuZCBzaHV0dGluZyBkb3duXG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhsb2dQYXRoLCAndXRmLTgnKTtcbiAgICBhc3NlcnQub2soY29udGVudC5pbmNsdWRlcygnZGFlbW9uIHN0YXJ0ZWQnKSk7XG4gICAgYXNzZXJ0Lm9rKGNvbnRlbnQuaW5jbHVkZXMoJ2RhZW1vbiBzaHV0dGluZyBkb3duJykpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLElBQUksV0FBVyxRQUFRLGFBQWE7QUFDdkQsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxlQUFlLGNBQWMsUUFBUSxZQUFZLGlCQUFpQjtBQUN4RixTQUFTLFlBQVk7QUFDckIsU0FBUyxRQUFRLGVBQWU7QUFDaEMsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxjQUFjLGFBQWE7QUFDcEMsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsbUJBQW1CLFlBQVksc0JBQXNCO0FBQzlELFNB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
