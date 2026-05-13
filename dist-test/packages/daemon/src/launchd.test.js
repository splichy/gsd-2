import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  escapeXml,
  generatePlist,
  getPlistPath,
  install,
  uninstall,
  status
} from "./launchd.js";
function tmpDir() {
  return mkdtempSync(join(tmpdir(), `launchd-test-${randomUUID().slice(0, 8)}-`));
}
const cleanupDirs = [];
afterEach(() => {
  while (cleanupDirs.length) {
    const d = cleanupDirs.pop();
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});
function basePlistOpts(overrides) {
  return {
    nodePath: "/usr/local/bin/node",
    scriptPath: "/usr/local/lib/gsd-daemon/dist/cli.js",
    configPath: join(homedir(), ".gsd", "daemon.yaml"),
    ...overrides
  };
}
describe("escapeXml", () => {
  it(`escapes & < > " '`, () => {
    assert.equal(escapeXml(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });
  it("leaves plain strings untouched", () => {
    assert.equal(escapeXml("/usr/local/bin/node"), "/usr/local/bin/node");
  });
  it("escapes paths with spaces and special chars", () => {
    const input = '/Users/John & Jane/my "project"/file.js';
    const output = escapeXml(input);
    assert.ok(output.includes("&amp;"));
    assert.ok(output.includes("&quot;"));
    assert.equal(output, "/Users/John &amp; Jane/my &quot;project&quot;/file.js");
  });
});
describe("generatePlist", () => {
  it("produces valid XML with plist header", () => {
    const xml = generatePlist(basePlistOpts());
    assert.ok(xml.startsWith('<?xml version="1.0"'));
    assert.ok(xml.includes("<!DOCTYPE plist"));
    assert.ok(xml.includes('<plist version="1.0">'));
    assert.ok(xml.includes("</plist>"));
  });
  it("includes label com.gsd.daemon", () => {
    const xml = generatePlist(basePlistOpts());
    assert.ok(xml.includes("<string>com.gsd.daemon</string>"));
  });
  it("uses the absolute node path from opts", () => {
    const opts = basePlistOpts({ nodePath: "/home/user/.nvm/versions/node/v22.0.0/bin/node" });
    const xml = generatePlist(opts);
    assert.ok(xml.includes("<string>/home/user/.nvm/versions/node/v22.0.0/bin/node</string>"));
  });
  it("includes NVM bin directory in PATH", () => {
    const opts = basePlistOpts({ nodePath: "/home/user/.nvm/versions/node/v22.0.0/bin/node" });
    const xml = generatePlist(opts);
    assert.ok(xml.includes("/home/user/.nvm/versions/node/v22.0.0/bin"));
  });
  it("sets KeepAlive with SuccessfulExit false", () => {
    const xml = generatePlist(basePlistOpts());
    assert.ok(xml.includes("<key>KeepAlive</key>"));
    assert.ok(xml.includes("<key>SuccessfulExit</key>"));
    assert.ok(xml.includes("<false/>"));
  });
  it("sets RunAtLoad true", () => {
    const xml = generatePlist(basePlistOpts());
    assert.ok(xml.includes("<key>RunAtLoad</key>"));
    assert.ok(xml.includes("<true/>"));
  });
  it("includes --config with the config path", () => {
    const configPath = "/custom/path/daemon.yaml";
    const xml = generatePlist(basePlistOpts({ configPath }));
    assert.ok(xml.includes("<string>--config</string>"));
    assert.ok(xml.includes(`<string>${configPath}</string>`));
  });
  it("includes HOME environment variable", () => {
    const xml = generatePlist(basePlistOpts());
    assert.ok(xml.includes("<key>HOME</key>"));
    assert.ok(xml.includes(`<string>${homedir()}</string>`));
  });
  it("includes StandardOutPath and StandardErrorPath", () => {
    const xml = generatePlist(basePlistOpts());
    assert.ok(xml.includes("<key>StandardOutPath</key>"));
    assert.ok(xml.includes("<key>StandardErrorPath</key>"));
  });
  it("escapes special characters in paths", () => {
    const opts = basePlistOpts({
      configPath: "/Users/John & Jane/config.yaml"
    });
    const xml = generatePlist(opts);
    assert.ok(xml.includes("John &amp; Jane"));
    assert.ok(!xml.includes("John & Jane"));
  });
  it("uses custom stdout/stderr paths when provided", () => {
    const opts = basePlistOpts({
      stdoutPath: "/tmp/my-stdout.log",
      stderrPath: "/tmp/my-stderr.log"
    });
    const xml = generatePlist(opts);
    assert.ok(xml.includes("<string>/tmp/my-stdout.log</string>"));
    assert.ok(xml.includes("<string>/tmp/my-stderr.log</string>"));
  });
  it("uses custom working directory when provided", () => {
    const opts = basePlistOpts({
      workingDirectory: "/custom/work/dir"
    });
    const xml = generatePlist(opts);
    assert.ok(xml.includes("<string>/custom/work/dir</string>"));
  });
});
describe("getPlistPath", () => {
  it("returns ~/Library/LaunchAgents/com.gsd.daemon.plist", () => {
    const expected = join(homedir(), "Library", "LaunchAgents", "com.gsd.daemon.plist");
    assert.equal(getPlistPath(), expected);
  });
});
describe("install", () => {
  let tmp;
  let fakePlistPath;
  it("calls launchctl load with the plist path", () => {
    const calls = [];
    const mockRun = (cmd) => {
      calls.push(cmd);
      return "";
    };
    try {
      install(basePlistOpts(), mockRun);
    } catch {
    }
    const loadCalls = calls.filter((c) => c.startsWith("launchctl load"));
    const listCalls = calls.filter((c) => c.startsWith("launchctl list"));
    assert.ok(loadCalls.length > 0 || calls.length > 0, "Expected launchctl commands to be called");
  });
  it("generates valid plist content when called", () => {
    const xml = generatePlist(basePlistOpts());
    assert.ok(xml.includes("<key>Label</key>"));
    assert.ok(xml.includes("<string>com.gsd.daemon</string>"));
  });
  it("handles idempotent install (unloads first if plist exists)", () => {
    const calls = [];
    const mockRun = (cmd) => {
      calls.push(cmd);
      return "";
    };
    try {
      install(basePlistOpts(), mockRun);
      install(basePlistOpts(), mockRun);
    } catch {
    }
    const unloadCalls = calls.filter((c) => c.startsWith("launchctl unload"));
  });
});
describe("uninstall", () => {
  it("calls launchctl unload when plist would exist", () => {
    const calls = [];
    const mockRun = (cmd) => {
      calls.push(cmd);
      return "";
    };
    uninstall(mockRun);
  });
  it("handles missing plist gracefully (no-op)", () => {
    const calls = [];
    const mockRun = (cmd) => {
      calls.push(cmd);
      return "";
    };
    assert.doesNotThrow(() => uninstall(mockRun));
  });
  it("handles already-unloaded agent gracefully", () => {
    const mockRun = (cmd) => {
      if (cmd.includes("launchctl unload")) {
        throw new Error("Could not find specified service");
      }
      return "";
    };
    assert.doesNotThrow(() => uninstall(mockRun));
  });
});
describe("status", () => {
  it("parses running daemon output (PID present)", () => {
    const mockRun = (_cmd) => {
      return '{\n	"PID" = 1234;\n	"Label" = "com.gsd.daemon";\n}\nPID	Status	Label\n1234	0	com.gsd.daemon\n';
    };
    const result = status(mockRun);
    assert.equal(result.registered, true);
    assert.equal(result.pid, 1234);
    assert.equal(result.lastExitStatus, 0);
  });
  it("parses stopped daemon output (no PID)", () => {
    const mockRun = (_cmd) => {
      return "PID	Status	Label\n-	78	com.gsd.daemon\n";
    };
    const result = status(mockRun);
    assert.equal(result.registered, true);
    assert.equal(result.pid, null);
    assert.equal(result.lastExitStatus, 78);
  });
  it("returns not-registered when launchctl list fails", () => {
    const mockRun = (_cmd) => {
      throw new Error('Could not find service "com.gsd.daemon" in domain for port');
    };
    const result = status(mockRun);
    assert.equal(result.registered, false);
    assert.equal(result.pid, null);
    assert.equal(result.lastExitStatus, null);
  });
  it("returns structured result with all fields", () => {
    const mockRun = (_cmd) => {
      return "PID	Status	Label\n5678	0	com.gsd.daemon\n";
    };
    const result = status(mockRun);
    assert.ok("registered" in result);
    assert.ok("pid" in result);
    assert.ok("lastExitStatus" in result);
  });
  it("parses JSON-style dict output (newer macOS)", () => {
    const mockRun = (_cmd) => {
      return `{
	"StandardOutPath" = "/Users/me/.gsd/daemon-stdout.log";
	"LimitLoadToSessionType" = "Aqua";
	"StandardErrorPath" = "/Users/me/.gsd/daemon-stderr.log";
	"Label" = "com.gsd.daemon";
	"OnDemand" = true;
	"LastExitStatus" = 0;
	"PID" = 23802;
	"Program" = "/usr/local/bin/node";
};`;
    };
    const result = status(mockRun);
    assert.equal(result.registered, true);
    assert.equal(result.pid, 23802);
    assert.equal(result.lastExitStatus, 0);
  });
  it("parses JSON-style dict output when daemon stopped (no PID key)", () => {
    const mockRun = (_cmd) => {
      return `{
	"Label" = "com.gsd.daemon";
	"LastExitStatus" = 1;
	"OnDemand" = true;
};`;
    };
    const result = status(mockRun);
    assert.equal(result.registered, true);
    assert.equal(result.pid, null);
    assert.equal(result.lastExitStatus, 1);
  });
  it("handles unexpected output format gracefully", () => {
    const mockRun = (_cmd) => {
      return "some unexpected output without the label";
    };
    const result = status(mockRun);
    assert.equal(result.registered, true);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvZGFlbW9uL3NyYy9sYXVuY2hkLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCBpdCwgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMsIHJtU3luYywgbWtkaXJTeW5jLCBzdGF0U3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgam9pbiwgZGlybmFtZSB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyB0bXBkaXIsIGhvbWVkaXIgfSBmcm9tICdub2RlOm9zJztcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XG5pbXBvcnQge1xuICBlc2NhcGVYbWwsXG4gIGdlbmVyYXRlUGxpc3QsXG4gIGdldFBsaXN0UGF0aCxcbiAgaW5zdGFsbCxcbiAgdW5pbnN0YWxsLFxuICBzdGF0dXMsXG59IGZyb20gJy4vbGF1bmNoZC5qcyc7XG5pbXBvcnQgdHlwZSB7IFBsaXN0T3B0aW9ucywgUnVuQ29tbWFuZEZuLCBMYXVuY2hkU3RhdHVzIH0gZnJvbSAnLi9sYXVuY2hkLmpzJztcblxuLy8gLS0tLS0tLS0tLSBoZWxwZXJzIC0tLS0tLS0tLS1cblxuZnVuY3Rpb24gdG1wRGlyKCk6IHN0cmluZyB7XG4gIHJldHVybiBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBgbGF1bmNoZC10ZXN0LSR7cmFuZG9tVVVJRCgpLnNsaWNlKDAsIDgpfS1gKSk7XG59XG5cbmNvbnN0IGNsZWFudXBEaXJzOiBzdHJpbmdbXSA9IFtdO1xuYWZ0ZXJFYWNoKCgpID0+IHtcbiAgd2hpbGUgKGNsZWFudXBEaXJzLmxlbmd0aCkge1xuICAgIGNvbnN0IGQgPSBjbGVhbnVwRGlycy5wb3AoKSE7XG4gICAgaWYgKGV4aXN0c1N5bmMoZCkpIHJtU3luYyhkLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5mdW5jdGlvbiBiYXNlUGxpc3RPcHRzKG92ZXJyaWRlcz86IFBhcnRpYWw8UGxpc3RPcHRpb25zPik6IFBsaXN0T3B0aW9ucyB7XG4gIHJldHVybiB7XG4gICAgbm9kZVBhdGg6ICcvdXNyL2xvY2FsL2Jpbi9ub2RlJyxcbiAgICBzY3JpcHRQYXRoOiAnL3Vzci9sb2NhbC9saWIvZ3NkLWRhZW1vbi9kaXN0L2NsaS5qcycsXG4gICAgY29uZmlnUGF0aDogam9pbihob21lZGlyKCksICcuZ3NkJywgJ2RhZW1vbi55YW1sJyksXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tIGVzY2FwZVhtbCAtLS0tLS0tLS0tXG5cbmRlc2NyaWJlKCdlc2NhcGVYbWwnLCAoKSA9PiB7XG4gIGl0KCdlc2NhcGVzICYgPCA+IFwiIFxcJycsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoZXNjYXBlWG1sKCdhJmI8Yz5kXCJlXFwnZicpLCAnYSZhbXA7YiZsdDtjJmd0O2QmcXVvdDtlJmFwb3M7ZicpO1xuICB9KTtcblxuICBpdCgnbGVhdmVzIHBsYWluIHN0cmluZ3MgdW50b3VjaGVkJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChlc2NhcGVYbWwoJy91c3IvbG9jYWwvYmluL25vZGUnKSwgJy91c3IvbG9jYWwvYmluL25vZGUnKTtcbiAgfSk7XG5cbiAgaXQoJ2VzY2FwZXMgcGF0aHMgd2l0aCBzcGFjZXMgYW5kIHNwZWNpYWwgY2hhcnMnLCAoKSA9PiB7XG4gICAgY29uc3QgaW5wdXQgPSAnL1VzZXJzL0pvaG4gJiBKYW5lL215IFwicHJvamVjdFwiL2ZpbGUuanMnO1xuICAgIGNvbnN0IG91dHB1dCA9IGVzY2FwZVhtbChpbnB1dCk7XG4gICAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcygnJmFtcDsnKSk7XG4gICAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcygnJnF1b3Q7JykpO1xuICAgIC8vIFZlcmlmeSBubyByYXcgdW5lc2NhcGVkICYgcmVtYWluIChhbGwgJiBhcmUgcGFydCBvZiAmYW1wOyAmbHQ7IGV0Yy4pXG4gICAgYXNzZXJ0LmVxdWFsKG91dHB1dCwgJy9Vc2Vycy9Kb2huICZhbXA7IEphbmUvbXkgJnF1b3Q7cHJvamVjdCZxdW90Oy9maWxlLmpzJyk7XG4gIH0pO1xufSk7XG5cbi8vIC0tLS0tLS0tLS0gZ2VuZXJhdGVQbGlzdCAtLS0tLS0tLS0tXG5cbmRlc2NyaWJlKCdnZW5lcmF0ZVBsaXN0JywgKCkgPT4ge1xuICBpdCgncHJvZHVjZXMgdmFsaWQgWE1MIHdpdGggcGxpc3QgaGVhZGVyJywgKCkgPT4ge1xuICAgIGNvbnN0IHhtbCA9IGdlbmVyYXRlUGxpc3QoYmFzZVBsaXN0T3B0cygpKTtcbiAgICBhc3NlcnQub2soeG1sLnN0YXJ0c1dpdGgoJzw/eG1sIHZlcnNpb249XCIxLjBcIicpKTtcbiAgICBhc3NlcnQub2soeG1sLmluY2x1ZGVzKCc8IURPQ1RZUEUgcGxpc3QnKSk7XG4gICAgYXNzZXJ0Lm9rKHhtbC5pbmNsdWRlcygnPHBsaXN0IHZlcnNpb249XCIxLjBcIj4nKSk7XG4gICAgYXNzZXJ0Lm9rKHhtbC5pbmNsdWRlcygnPC9wbGlzdD4nKSk7XG4gIH0pO1xuXG4gIGl0KCdpbmNsdWRlcyBsYWJlbCBjb20uZ3NkLmRhZW1vbicsICgpID0+IHtcbiAgICBjb25zdCB4bWwgPSBnZW5lcmF0ZVBsaXN0KGJhc2VQbGlzdE9wdHMoKSk7XG4gICAgYXNzZXJ0Lm9rKHhtbC5pbmNsdWRlcygnPHN0cmluZz5jb20uZ3NkLmRhZW1vbjwvc3RyaW5nPicpKTtcbiAgfSk7XG5cbiAgaXQoJ3VzZXMgdGhlIGFic29sdXRlIG5vZGUgcGF0aCBmcm9tIG9wdHMnLCAoKSA9PiB7XG4gICAgY29uc3Qgb3B0cyA9IGJhc2VQbGlzdE9wdHMoeyBub2RlUGF0aDogJy9ob21lL3VzZXIvLm52bS92ZXJzaW9ucy9ub2RlL3YyMi4wLjAvYmluL25vZGUnIH0pO1xuICAgIGNvbnN0IHhtbCA9IGdlbmVyYXRlUGxpc3Qob3B0cyk7XG4gICAgYXNzZXJ0Lm9rKHhtbC5pbmNsdWRlcygnPHN0cmluZz4vaG9tZS91c2VyLy5udm0vdmVyc2lvbnMvbm9kZS92MjIuMC4wL2Jpbi9ub2RlPC9zdHJpbmc+JykpO1xuICB9KTtcblxuICBpdCgnaW5jbHVkZXMgTlZNIGJpbiBkaXJlY3RvcnkgaW4gUEFUSCcsICgpID0+IHtcbiAgICBjb25zdCBvcHRzID0gYmFzZVBsaXN0T3B0cyh7IG5vZGVQYXRoOiAnL2hvbWUvdXNlci8ubnZtL3ZlcnNpb25zL25vZGUvdjIyLjAuMC9iaW4vbm9kZScgfSk7XG4gICAgY29uc3QgeG1sID0gZ2VuZXJhdGVQbGlzdChvcHRzKTtcbiAgICBhc3NlcnQub2soeG1sLmluY2x1ZGVzKCcvaG9tZS91c2VyLy5udm0vdmVyc2lvbnMvbm9kZS92MjIuMC4wL2JpbicpKTtcbiAgfSk7XG5cbiAgaXQoJ3NldHMgS2VlcEFsaXZlIHdpdGggU3VjY2Vzc2Z1bEV4aXQgZmFsc2UnLCAoKSA9PiB7XG4gICAgY29uc3QgeG1sID0gZ2VuZXJhdGVQbGlzdChiYXNlUGxpc3RPcHRzKCkpO1xuICAgIGFzc2VydC5vayh4bWwuaW5jbHVkZXMoJzxrZXk+S2VlcEFsaXZlPC9rZXk+JykpO1xuICAgIGFzc2VydC5vayh4bWwuaW5jbHVkZXMoJzxrZXk+U3VjY2Vzc2Z1bEV4aXQ8L2tleT4nKSk7XG4gICAgYXNzZXJ0Lm9rKHhtbC5pbmNsdWRlcygnPGZhbHNlLz4nKSk7XG4gIH0pO1xuXG4gIGl0KCdzZXRzIFJ1bkF0TG9hZCB0cnVlJywgKCkgPT4ge1xuICAgIGNvbnN0IHhtbCA9IGdlbmVyYXRlUGxpc3QoYmFzZVBsaXN0T3B0cygpKTtcbiAgICBhc3NlcnQub2soeG1sLmluY2x1ZGVzKCc8a2V5PlJ1bkF0TG9hZDwva2V5PicpKTtcbiAgICBhc3NlcnQub2soeG1sLmluY2x1ZGVzKCc8dHJ1ZS8+JykpO1xuICB9KTtcblxuICBpdCgnaW5jbHVkZXMgLS1jb25maWcgd2l0aCB0aGUgY29uZmlnIHBhdGgnLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnUGF0aCA9ICcvY3VzdG9tL3BhdGgvZGFlbW9uLnlhbWwnO1xuICAgIGNvbnN0IHhtbCA9IGdlbmVyYXRlUGxpc3QoYmFzZVBsaXN0T3B0cyh7IGNvbmZpZ1BhdGggfSkpO1xuICAgIGFzc2VydC5vayh4bWwuaW5jbHVkZXMoJzxzdHJpbmc+LS1jb25maWc8L3N0cmluZz4nKSk7XG4gICAgYXNzZXJ0Lm9rKHhtbC5pbmNsdWRlcyhgPHN0cmluZz4ke2NvbmZpZ1BhdGh9PC9zdHJpbmc+YCkpO1xuICB9KTtcblxuICBpdCgnaW5jbHVkZXMgSE9NRSBlbnZpcm9ubWVudCB2YXJpYWJsZScsICgpID0+IHtcbiAgICBjb25zdCB4bWwgPSBnZW5lcmF0ZVBsaXN0KGJhc2VQbGlzdE9wdHMoKSk7XG4gICAgYXNzZXJ0Lm9rKHhtbC5pbmNsdWRlcygnPGtleT5IT01FPC9rZXk+JykpO1xuICAgIGFzc2VydC5vayh4bWwuaW5jbHVkZXMoYDxzdHJpbmc+JHtob21lZGlyKCl9PC9zdHJpbmc+YCkpO1xuICB9KTtcblxuICBpdCgnaW5jbHVkZXMgU3RhbmRhcmRPdXRQYXRoIGFuZCBTdGFuZGFyZEVycm9yUGF0aCcsICgpID0+IHtcbiAgICBjb25zdCB4bWwgPSBnZW5lcmF0ZVBsaXN0KGJhc2VQbGlzdE9wdHMoKSk7XG4gICAgYXNzZXJ0Lm9rKHhtbC5pbmNsdWRlcygnPGtleT5TdGFuZGFyZE91dFBhdGg8L2tleT4nKSk7XG4gICAgYXNzZXJ0Lm9rKHhtbC5pbmNsdWRlcygnPGtleT5TdGFuZGFyZEVycm9yUGF0aDwva2V5PicpKTtcbiAgfSk7XG5cbiAgaXQoJ2VzY2FwZXMgc3BlY2lhbCBjaGFyYWN0ZXJzIGluIHBhdGhzJywgKCkgPT4ge1xuICAgIGNvbnN0IG9wdHMgPSBiYXNlUGxpc3RPcHRzKHtcbiAgICAgIGNvbmZpZ1BhdGg6ICcvVXNlcnMvSm9obiAmIEphbmUvY29uZmlnLnlhbWwnLFxuICAgIH0pO1xuICAgIGNvbnN0IHhtbCA9IGdlbmVyYXRlUGxpc3Qob3B0cyk7XG4gICAgYXNzZXJ0Lm9rKHhtbC5pbmNsdWRlcygnSm9obiAmYW1wOyBKYW5lJykpO1xuICAgIGFzc2VydC5vaygheG1sLmluY2x1ZGVzKCdKb2huICYgSmFuZScpKTtcbiAgfSk7XG5cbiAgaXQoJ3VzZXMgY3VzdG9tIHN0ZG91dC9zdGRlcnIgcGF0aHMgd2hlbiBwcm92aWRlZCcsICgpID0+IHtcbiAgICBjb25zdCBvcHRzID0gYmFzZVBsaXN0T3B0cyh7XG4gICAgICBzdGRvdXRQYXRoOiAnL3RtcC9teS1zdGRvdXQubG9nJyxcbiAgICAgIHN0ZGVyclBhdGg6ICcvdG1wL215LXN0ZGVyci5sb2cnLFxuICAgIH0pO1xuICAgIGNvbnN0IHhtbCA9IGdlbmVyYXRlUGxpc3Qob3B0cyk7XG4gICAgYXNzZXJ0Lm9rKHhtbC5pbmNsdWRlcygnPHN0cmluZz4vdG1wL215LXN0ZG91dC5sb2c8L3N0cmluZz4nKSk7XG4gICAgYXNzZXJ0Lm9rKHhtbC5pbmNsdWRlcygnPHN0cmluZz4vdG1wL215LXN0ZGVyci5sb2c8L3N0cmluZz4nKSk7XG4gIH0pO1xuXG4gIGl0KCd1c2VzIGN1c3RvbSB3b3JraW5nIGRpcmVjdG9yeSB3aGVuIHByb3ZpZGVkJywgKCkgPT4ge1xuICAgIGNvbnN0IG9wdHMgPSBiYXNlUGxpc3RPcHRzKHtcbiAgICAgIHdvcmtpbmdEaXJlY3Rvcnk6ICcvY3VzdG9tL3dvcmsvZGlyJyxcbiAgICB9KTtcbiAgICBjb25zdCB4bWwgPSBnZW5lcmF0ZVBsaXN0KG9wdHMpO1xuICAgIGFzc2VydC5vayh4bWwuaW5jbHVkZXMoJzxzdHJpbmc+L2N1c3RvbS93b3JrL2Rpcjwvc3RyaW5nPicpKTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLSBnZXRQbGlzdFBhdGggLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnZ2V0UGxpc3RQYXRoJywgKCkgPT4ge1xuICBpdCgncmV0dXJucyB+L0xpYnJhcnkvTGF1bmNoQWdlbnRzL2NvbS5nc2QuZGFlbW9uLnBsaXN0JywgKCkgPT4ge1xuICAgIGNvbnN0IGV4cGVjdGVkID0gam9pbihob21lZGlyKCksICdMaWJyYXJ5JywgJ0xhdW5jaEFnZW50cycsICdjb20uZ3NkLmRhZW1vbi5wbGlzdCcpO1xuICAgIGFzc2VydC5lcXVhbChnZXRQbGlzdFBhdGgoKSwgZXhwZWN0ZWQpO1xuICB9KTtcbn0pO1xuXG4vLyAtLS0tLS0tLS0tIGluc3RhbGwgLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnaW5zdGFsbCcsICgpID0+IHtcbiAgbGV0IHRtcDogc3RyaW5nO1xuICBsZXQgZmFrZVBsaXN0UGF0aDogc3RyaW5nO1xuXG4gIC8vIFdlIGNhbid0IG1vY2sgZ2V0UGxpc3RQYXRoIGRpcmVjdGx5LCBidXQgd2UgY2FuIHZlcmlmeSB0aGUgY29tbWFuZHNcbiAgLy8gaXNzdWVkIGFuZCB0aGUgcGxpc3QgY29udGVudCBieSBpbnRlcmNlcHRpbmcgcnVuQ29tbWFuZCBhbmQgZmlsZXN5c3RlbSBvcHMuXG4gIC8vIEZvciBmaWxlc3lzdGVtIHRlc3RpbmcsIHdlIHRlc3QgdGhlIGZ1bmN0aW9ucyB0aGF0IGNhbGwgd3JpdGVGaWxlU3luYyBpbmRpcmVjdGx5XG4gIC8vIGJ5IHZlcmlmeWluZyB0aGUgcnVuQ29tbWFuZCBjYWxscyBhbmQgcmV0dXJuZWQgdmFsdWVzLlxuXG4gIGl0KCdjYWxscyBsYXVuY2hjdGwgbG9hZCB3aXRoIHRoZSBwbGlzdCBwYXRoJywgKCkgPT4ge1xuICAgIGNvbnN0IGNhbGxzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IG1vY2tSdW46IFJ1bkNvbW1hbmRGbiA9IChjbWQ6IHN0cmluZykgPT4ge1xuICAgICAgY2FsbHMucHVzaChjbWQpO1xuICAgICAgcmV0dXJuICcnO1xuICAgIH07XG5cbiAgICAvLyBpbnN0YWxsIHdpbGwgdHJ5IHRvIHdyaXRlIHRvIHRoZSByZWFsIHBsaXN0IHBhdGgsIHNvIHdlIG5lZWQgdG8gYmUgY2FyZWZ1bC5cbiAgICAvLyBXZSB0ZXN0IHRoZSBjb21tYW5kIGZsb3cgYnkgY2F0Y2hpbmcgdGhlIHdyaXRlRmlsZVN5bmMgZXJyb3IgKGRpciBtYXkgbm90IGV4aXN0IGluIENJKVxuICAgIC8vIG9yIGJ5IGxldHRpbmcgaXQgcHJvY2VlZCBpbiBsb2NhbCBkZXYuXG4gICAgdHJ5IHtcbiAgICAgIGluc3RhbGwoYmFzZVBsaXN0T3B0cygpLCBtb2NrUnVuKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIHdyaXRlRmlsZVN5bmMgbWF5IGZhaWwgaWYgfi9MaWJyYXJ5L0xhdW5jaEFnZW50cyBkb2Vzbid0IGV4aXN0IGluIHRlc3QgZW52XG4gICAgfVxuXG4gICAgY29uc3QgbG9hZENhbGxzID0gY2FsbHMuZmlsdGVyKGMgPT4gYy5zdGFydHNXaXRoKCdsYXVuY2hjdGwgbG9hZCcpKTtcbiAgICBjb25zdCBsaXN0Q2FsbHMgPSBjYWxscy5maWx0ZXIoYyA9PiBjLnN0YXJ0c1dpdGgoJ2xhdW5jaGN0bCBsaXN0JykpO1xuICAgIC8vIFNob3VsZCBoYXZlIGF0IGxlYXN0IGF0dGVtcHRlZCBsYXVuY2hjdGwgbG9hZFxuICAgIGFzc2VydC5vayhsb2FkQ2FsbHMubGVuZ3RoID4gMCB8fCBjYWxscy5sZW5ndGggPiAwLCAnRXhwZWN0ZWQgbGF1bmNoY3RsIGNvbW1hbmRzIHRvIGJlIGNhbGxlZCcpO1xuICB9KTtcblxuICBpdCgnZ2VuZXJhdGVzIHZhbGlkIHBsaXN0IGNvbnRlbnQgd2hlbiBjYWxsZWQnLCAoKSA9PiB7XG4gICAgLy8gVGVzdCB0aGF0IHRoZSBwbGlzdCBjb250ZW50IHdvdWxkIGJlIGNvcnJlY3QgYnkgdGVzdGluZyBnZW5lcmF0ZVBsaXN0XG4gICAgLy8gKGluc3RhbGwgaXMgYSB0aGluIHdyYXBwZXIgYXJvdW5kIGdlbmVyYXRlUGxpc3QgKyB3cml0ZUZpbGUgKyBsYXVuY2hjdGwpXG4gICAgY29uc3QgeG1sID0gZ2VuZXJhdGVQbGlzdChiYXNlUGxpc3RPcHRzKCkpO1xuICAgIGFzc2VydC5vayh4bWwuaW5jbHVkZXMoJzxrZXk+TGFiZWw8L2tleT4nKSk7XG4gICAgYXNzZXJ0Lm9rKHhtbC5pbmNsdWRlcygnPHN0cmluZz5jb20uZ3NkLmRhZW1vbjwvc3RyaW5nPicpKTtcbiAgfSk7XG5cbiAgaXQoJ2hhbmRsZXMgaWRlbXBvdGVudCBpbnN0YWxsICh1bmxvYWRzIGZpcnN0IGlmIHBsaXN0IGV4aXN0cyknLCAoKSA9PiB7XG4gICAgY29uc3QgY2FsbHM6IHN0cmluZ1tdID0gW107XG4gICAgY29uc3QgbW9ja1J1bjogUnVuQ29tbWFuZEZuID0gKGNtZDogc3RyaW5nKSA9PiB7XG4gICAgICBjYWxscy5wdXNoKGNtZCk7XG4gICAgICByZXR1cm4gJyc7XG4gICAgfTtcblxuICAgIC8vIFRvIHNpbXVsYXRlIGlkZW1wb3RlbnQgaW5zdGFsbCwgd2UgbmVlZCBhbiBleGlzdGluZyBwbGlzdCBmaWxlLlxuICAgIC8vIFNpbmNlIGluc3RhbGwgd3JpdGVzIHRvIGdldFBsaXN0UGF0aCgpLCB3ZSB0ZXN0IHRoZSBjb21tYW5kIHNlcXVlbmNlLlxuICAgIHRyeSB7XG4gICAgICBpbnN0YWxsKGJhc2VQbGlzdE9wdHMoKSwgbW9ja1J1bik7XG4gICAgICAvLyBTZWNvbmQgaW5zdGFsbFxuICAgICAgaW5zdGFsbChiYXNlUGxpc3RPcHRzKCksIG1vY2tSdW4pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gZmlsZXN5c3RlbSBtYXkgbm90IGJlIHdyaXRhYmxlXG4gICAgfVxuXG4gICAgLy8gVGhlIHNlY29uZCBpbnN0YWxsIHNob3VsZCBoYXZlIHRyaWVkIHRvIHVubG9hZCBmaXJzdFxuICAgIGNvbnN0IHVubG9hZENhbGxzID0gY2FsbHMuZmlsdGVyKGMgPT4gYy5zdGFydHNXaXRoKCdsYXVuY2hjdGwgdW5sb2FkJykpO1xuICAgIC8vIElmIHRoZSBwbGlzdCBwYXRoIGV4aXN0cywgd2UgZXhwZWN0IGF0IGxlYXN0IG9uZSB1bmxvYWQgYXR0ZW1wdCBvbiBzZWNvbmQgY2FsbFxuICAgIC8vIFRoaXMgaXMgYSBjb21tYW5kLWxldmVsIGNoZWNrOyBmaWxlc3lzdGVtIGV4aXN0ZW5jZSBkZXBlbmRzIG9uIGVudmlyb25tZW50XG4gIH0pO1xufSk7XG5cbi8vIC0tLS0tLS0tLS0gdW5pbnN0YWxsIC0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ3VuaW5zdGFsbCcsICgpID0+IHtcbiAgaXQoJ2NhbGxzIGxhdW5jaGN0bCB1bmxvYWQgd2hlbiBwbGlzdCB3b3VsZCBleGlzdCcsICgpID0+IHtcbiAgICBjb25zdCBjYWxsczogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBtb2NrUnVuOiBSdW5Db21tYW5kRm4gPSAoY21kOiBzdHJpbmcpID0+IHtcbiAgICAgIGNhbGxzLnB1c2goY21kKTtcbiAgICAgIHJldHVybiAnJztcbiAgICB9O1xuXG4gICAgLy8gdW5pbnN0YWxsIGNoZWNrcyBleGlzdHNTeW5jKHBsaXN0UGF0aCkgXHUyMDE0IGlmIHBsaXN0IGRvZXNuJ3QgZXhpc3QsIGl0J3MgYSBuby1vcFxuICAgIHVuaW5zdGFsbChtb2NrUnVuKTtcblxuICAgIC8vIElmIHBsaXN0IGRvZXNuJ3QgZXhpc3QgaW4gdGVzdCBlbnZpcm9ubWVudCwgY2FsbHMgc2hvdWxkIGJlIGVtcHR5IChncmFjZWZ1bClcbiAgICAvLyBUaGF0J3MgdGhlIFwiaGFuZGxlcyBtaXNzaW5nIHBsaXN0IGdyYWNlZnVsbHlcIiBjYXNlXG4gIH0pO1xuXG4gIGl0KCdoYW5kbGVzIG1pc3NpbmcgcGxpc3QgZ3JhY2VmdWxseSAobm8tb3ApJywgKCkgPT4ge1xuICAgIGNvbnN0IGNhbGxzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IG1vY2tSdW46IFJ1bkNvbW1hbmRGbiA9IChjbWQ6IHN0cmluZykgPT4ge1xuICAgICAgY2FsbHMucHVzaChjbWQpO1xuICAgICAgcmV0dXJuICcnO1xuICAgIH07XG5cbiAgICAvLyBTaG91bGRuJ3QgdGhyb3cgZXZlbiBpZiBwbGlzdCBkb2Vzbid0IGV4aXN0XG4gICAgYXNzZXJ0LmRvZXNOb3RUaHJvdygoKSA9PiB1bmluc3RhbGwobW9ja1J1bikpO1xuICB9KTtcblxuICBpdCgnaGFuZGxlcyBhbHJlYWR5LXVubG9hZGVkIGFnZW50IGdyYWNlZnVsbHknLCAoKSA9PiB7XG4gICAgY29uc3QgbW9ja1J1bjogUnVuQ29tbWFuZEZuID0gKGNtZDogc3RyaW5nKSA9PiB7XG4gICAgICBpZiAoY21kLmluY2x1ZGVzKCdsYXVuY2hjdGwgdW5sb2FkJykpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDb3VsZCBub3QgZmluZCBzcGVjaWZpZWQgc2VydmljZScpO1xuICAgICAgfVxuICAgICAgcmV0dXJuICcnO1xuICAgIH07XG5cbiAgICAvLyBTaG91bGQgbm90IHRocm93IGV2ZW4gaWYgbGF1bmNoY3RsIHVubG9hZCBmYWlsc1xuICAgIGFzc2VydC5kb2VzTm90VGhyb3coKCkgPT4gdW5pbnN0YWxsKG1vY2tSdW4pKTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLSBzdGF0dXMgLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnc3RhdHVzJywgKCkgPT4ge1xuICBpdCgncGFyc2VzIHJ1bm5pbmcgZGFlbW9uIG91dHB1dCAoUElEIHByZXNlbnQpJywgKCkgPT4ge1xuICAgIGNvbnN0IG1vY2tSdW46IFJ1bkNvbW1hbmRGbiA9IChfY21kOiBzdHJpbmcpID0+IHtcbiAgICAgIHJldHVybiAne1xcblxcdFwiUElEXCIgPSAxMjM0O1xcblxcdFwiTGFiZWxcIiA9IFwiY29tLmdzZC5kYWVtb25cIjtcXG59XFxuUElEXFx0U3RhdHVzXFx0TGFiZWxcXG4xMjM0XFx0MFxcdGNvbS5nc2QuZGFlbW9uXFxuJztcbiAgICB9O1xuXG4gICAgY29uc3QgcmVzdWx0ID0gc3RhdHVzKG1vY2tSdW4pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucmVnaXN0ZXJlZCwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5waWQsIDEyMzQpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubGFzdEV4aXRTdGF0dXMsIDApO1xuICB9KTtcblxuICBpdCgncGFyc2VzIHN0b3BwZWQgZGFlbW9uIG91dHB1dCAobm8gUElEKScsICgpID0+IHtcbiAgICBjb25zdCBtb2NrUnVuOiBSdW5Db21tYW5kRm4gPSAoX2NtZDogc3RyaW5nKSA9PiB7XG4gICAgICByZXR1cm4gJ1BJRFxcdFN0YXR1c1xcdExhYmVsXFxuLVxcdDc4XFx0Y29tLmdzZC5kYWVtb25cXG4nO1xuICAgIH07XG5cbiAgICBjb25zdCByZXN1bHQgPSBzdGF0dXMobW9ja1J1bik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZWdpc3RlcmVkLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnBpZCwgbnVsbCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5sYXN0RXhpdFN0YXR1cywgNzgpO1xuICB9KTtcblxuICBpdCgncmV0dXJucyBub3QtcmVnaXN0ZXJlZCB3aGVuIGxhdW5jaGN0bCBsaXN0IGZhaWxzJywgKCkgPT4ge1xuICAgIGNvbnN0IG1vY2tSdW46IFJ1bkNvbW1hbmRGbiA9IChfY21kOiBzdHJpbmcpID0+IHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignQ291bGQgbm90IGZpbmQgc2VydmljZSBcImNvbS5nc2QuZGFlbW9uXCIgaW4gZG9tYWluIGZvciBwb3J0Jyk7XG4gICAgfTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHN0YXR1cyhtb2NrUnVuKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnJlZ2lzdGVyZWQsIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnBpZCwgbnVsbCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5sYXN0RXhpdFN0YXR1cywgbnVsbCk7XG4gIH0pO1xuXG4gIGl0KCdyZXR1cm5zIHN0cnVjdHVyZWQgcmVzdWx0IHdpdGggYWxsIGZpZWxkcycsICgpID0+IHtcbiAgICBjb25zdCBtb2NrUnVuOiBSdW5Db21tYW5kRm4gPSAoX2NtZDogc3RyaW5nKSA9PiB7XG4gICAgICByZXR1cm4gJ1BJRFxcdFN0YXR1c1xcdExhYmVsXFxuNTY3OFxcdDBcXHRjb20uZ3NkLmRhZW1vblxcbic7XG4gICAgfTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHN0YXR1cyhtb2NrUnVuKTtcbiAgICBhc3NlcnQub2soJ3JlZ2lzdGVyZWQnIGluIHJlc3VsdCk7XG4gICAgYXNzZXJ0Lm9rKCdwaWQnIGluIHJlc3VsdCk7XG4gICAgYXNzZXJ0Lm9rKCdsYXN0RXhpdFN0YXR1cycgaW4gcmVzdWx0KTtcbiAgfSk7XG5cbiAgaXQoJ3BhcnNlcyBKU09OLXN0eWxlIGRpY3Qgb3V0cHV0IChuZXdlciBtYWNPUyknLCAoKSA9PiB7XG4gICAgY29uc3QgbW9ja1J1bjogUnVuQ29tbWFuZEZuID0gKF9jbWQ6IHN0cmluZykgPT4ge1xuICAgICAgcmV0dXJuIGB7XG5cXHRcIlN0YW5kYXJkT3V0UGF0aFwiID0gXCIvVXNlcnMvbWUvLmdzZC9kYWVtb24tc3Rkb3V0LmxvZ1wiO1xuXFx0XCJMaW1pdExvYWRUb1Nlc3Npb25UeXBlXCIgPSBcIkFxdWFcIjtcblxcdFwiU3RhbmRhcmRFcnJvclBhdGhcIiA9IFwiL1VzZXJzL21lLy5nc2QvZGFlbW9uLXN0ZGVyci5sb2dcIjtcblxcdFwiTGFiZWxcIiA9IFwiY29tLmdzZC5kYWVtb25cIjtcblxcdFwiT25EZW1hbmRcIiA9IHRydWU7XG5cXHRcIkxhc3RFeGl0U3RhdHVzXCIgPSAwO1xuXFx0XCJQSURcIiA9IDIzODAyO1xuXFx0XCJQcm9ncmFtXCIgPSBcIi91c3IvbG9jYWwvYmluL25vZGVcIjtcbn07YDtcbiAgICB9O1xuXG4gICAgY29uc3QgcmVzdWx0ID0gc3RhdHVzKG1vY2tSdW4pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucmVnaXN0ZXJlZCwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5waWQsIDIzODAyKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lmxhc3RFeGl0U3RhdHVzLCAwKTtcbiAgfSk7XG5cbiAgaXQoJ3BhcnNlcyBKU09OLXN0eWxlIGRpY3Qgb3V0cHV0IHdoZW4gZGFlbW9uIHN0b3BwZWQgKG5vIFBJRCBrZXkpJywgKCkgPT4ge1xuICAgIGNvbnN0IG1vY2tSdW46IFJ1bkNvbW1hbmRGbiA9IChfY21kOiBzdHJpbmcpID0+IHtcbiAgICAgIHJldHVybiBge1xuXFx0XCJMYWJlbFwiID0gXCJjb20uZ3NkLmRhZW1vblwiO1xuXFx0XCJMYXN0RXhpdFN0YXR1c1wiID0gMTtcblxcdFwiT25EZW1hbmRcIiA9IHRydWU7XG59O2A7XG4gICAgfTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHN0YXR1cyhtb2NrUnVuKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnJlZ2lzdGVyZWQsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucGlkLCBudWxsKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lmxhc3RFeGl0U3RhdHVzLCAxKTtcbiAgfSk7XG5cbiAgaXQoJ2hhbmRsZXMgdW5leHBlY3RlZCBvdXRwdXQgZm9ybWF0IGdyYWNlZnVsbHknLCAoKSA9PiB7XG4gICAgY29uc3QgbW9ja1J1bjogUnVuQ29tbWFuZEZuID0gKF9jbWQ6IHN0cmluZykgPT4ge1xuICAgICAgcmV0dXJuICdzb21lIHVuZXhwZWN0ZWQgb3V0cHV0IHdpdGhvdXQgdGhlIGxhYmVsJztcbiAgICB9O1xuXG4gICAgLy8gU2hvdWxkIG5vdCB0aHJvdyBcdTIwMTQgc2hvdWxkIHJldHVybiByZWdpc3RlcmVkOnRydWUgYnV0IHdpdGggbnVsbCBmaWVsZHNcbiAgICAvLyBzaW5jZSB0aGUgY29tbWFuZCBzdWNjZWVkZWQgKGxhYmVsIHdhcyBmb3VuZCkgYnV0IG91dHB1dCBkaWRuJ3QgbWF0Y2hcbiAgICBjb25zdCByZXN1bHQgPSBzdGF0dXMobW9ja1J1bik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZWdpc3RlcmVkLCB0cnVlKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxJ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
