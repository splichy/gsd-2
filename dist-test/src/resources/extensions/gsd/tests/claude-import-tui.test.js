import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeImportFlow, getClaudeSearchRoots, discoverClaudeSkills, discoverClaudePlugins } from "../claude-import.js";
import { getMarketplaceFixtures } from "./marketplace-test-fixtures.js";
const fixtureSetup = getMarketplaceFixtures(import.meta.dirname);
const fixtures = fixtureSetup.fixtures;
const CLAUDE_SKILLS_PATH = fixtures?.claudeSkillsPath;
const CLAUDE_PLUGINS_OFFICIAL_PATH = fixtures?.claudePluginsOfficialPath;
function marketplacesAvailable() {
  return Boolean(fixtures);
}
function createMockContext(selections) {
  const selectCalls = [];
  const selectMock = mock.fn(async (prompt, options) => {
    selectCalls.push({ prompt, options });
    const next = selections.shift();
    if (next && options.includes(next)) {
      return next;
    }
    return options.find((o) => o.toLowerCase().includes("cancel")) || options[0];
  });
  const notifyMock = mock.fn();
  const ctx = {
    ui: {
      select: selectMock,
      notify: notifyMock,
      confirm: async () => false,
      input: async () => void 0,
      onTerminalInput: () => () => {
      },
      setStatus: () => {
      },
      setWorkingMessage: () => {
      },
      setWidget: () => {
      },
      setFooter: () => {
      },
      setHeader: () => {
      },
      setTitle: () => {
      },
      custom: async () => {
        throw new Error("Not implemented");
      },
      pasteToEditor: () => {
      },
      setEditorText: () => {
      },
      getEditorText: () => "",
      editor: async () => void 0,
      setEditorComponent: () => {
      },
      theme: {},
      getAllThemes: () => [],
      getTheme: () => void 0,
      setTheme: () => ({ success: false }),
      getToolsExpanded: () => true,
      setToolsExpanded: () => {
      }
    },
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: {},
    modelRegistry: {},
    model: void 0,
    isIdle: () => true,
    abort: () => {
    },
    hasPendingMessages: () => false,
    shutdown: () => {
    },
    getContextUsage: () => void 0,
    compact: () => {
    },
    getSystemPrompt: () => "",
    waitForIdle: mock.fn(async () => {
    }),
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: mock.fn(async () => {
    })
  };
  return { ctx, selectCalls };
}
const skipReason = !marketplacesAvailable() ? fixtureSetup.skipReason ?? "Marketplace repos not found for TUI testing" : void 0;
describe(
  "TUI Command Flow Tests",
  { skip: skipReason },
  () => {
    let tempDir;
    let prefsPath;
    let prefs;
    before(() => {
      tempDir = mkdtempSync(join(tmpdir(), "gsd-tui-test-"));
      prefsPath = join(tempDir, "PREFERENCES.md");
      prefs = { version: 1 };
    });
    after(() => {
      fixtures?.cleanup();
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
    describe("getClaudeSearchRoots()", () => {
      it("should return existing skill and plugin roots", () => {
        const cwd = process.cwd();
        const { skillRoots, pluginRoots } = getClaudeSearchRoots(cwd);
        assert.ok(
          skillRoots.length > 0 || pluginRoots.length > 0,
          "Should find at least one search root"
        );
        for (const root of [...skillRoots, ...pluginRoots]) {
          assert.ok(existsSync(root), `Root should exist: ${root}`);
        }
      });
    });
    describe("discoverClaudeSkills()", () => {
      it("should discover skills without crashing", () => {
        const cwd = process.cwd();
        const skills = discoverClaudeSkills(cwd);
        assert.ok(Array.isArray(skills), "Should return an array");
        console.log(`
Discovered ${skills.length} skills`);
        if (skills.length > 0) {
          console.log("Sample skills:");
          skills.slice(0, 3).forEach((s) => {
            console.log(`  - ${s.name} (${s.sourceLabel})`);
          });
          const sample = skills[0];
          assert.ok(sample.name, "Skill should have name");
          assert.ok(sample.path, "Skill should have path");
          assert.ok(sample.root, "Skill should have root");
          assert.strictEqual(sample.type, "skill");
        }
      });
    });
    describe("discoverClaudePlugins()", () => {
      it("should discover plugins without crashing", () => {
        const cwd = process.cwd();
        const plugins = discoverClaudePlugins(cwd);
        assert.ok(Array.isArray(plugins), "Should return an array");
        console.log(`
Discovered ${plugins.length} plugins`);
        if (plugins.length > 0) {
          console.log("Sample plugins:");
          plugins.slice(0, 3).forEach((p) => {
            console.log(`  - ${p.name} (${p.sourceLabel})`);
          });
          const sample = plugins[0];
          assert.ok(sample.name, "Plugin should have name");
          assert.ok(sample.path, "Plugin should have path");
          assert.strictEqual(sample.type, "plugin");
        }
      });
    });
    describe("runClaudeImportFlow()", () => {
      it("should not crash when user cancels at first prompt", async () => {
        const { ctx, selectCalls } = createMockContext(["Cancel"]);
        const readPrefs = () => ({ ...prefs });
        const writePrefs = async (p) => {
          Object.assign(prefs, p);
        };
        await runClaudeImportFlow(ctx, "global", readPrefs, writePrefs);
        assert.ok(selectCalls.length >= 1, "Should have at least one select call");
        assert.ok(
          selectCalls[0].prompt.includes("Import Claude assets"),
          "First prompt should be about asset selection"
        );
      });
      it("should not crash when selecting skills only with cancel at next step", async () => {
        const { ctx, selectCalls } = createMockContext([
          "Skills only",
          // Select skills only
          "Cancel"
          // Cancel at skill selection
        ]);
        const readPrefs = () => ({ ...prefs });
        const writePrefs = async (p) => {
          Object.assign(prefs, p);
        };
        await runClaudeImportFlow(ctx, "global", readPrefs, writePrefs);
        console.log("\nSelect calls made:");
        selectCalls.forEach((call, i) => {
          console.log(`  ${i + 1}. "${call.prompt}"`);
        });
      });
      it("should handle marketplace flow when user selects plugins", async () => {
        const { ctx, selectCalls } = createMockContext([
          "Plugins only",
          // Select plugins only
          "Yes - discover plugins and select components",
          // Marketplace prompt
          "Cancel"
          // Cancel at component selection
        ]);
        const readPrefs = () => ({ ...prefs });
        const writePrefs = async (p) => {
          Object.assign(prefs, p);
        };
        await runClaudeImportFlow(ctx, "global", readPrefs, writePrefs);
        console.log("\nMarketplace flow select calls:");
        selectCalls.forEach((call, i) => {
          console.log(`  ${i + 1}. "${call.prompt}"`);
        });
      });
      it("should complete import-all flow with mock UI", async () => {
        const { ctx, selectCalls } = createMockContext([
          "Skills + plugins",
          // Select both
          "Cancel",
          // Cancel at skill selection (no skills to import)
          "Yes - discover plugins and select components",
          // Marketplace prompt
          "Import all components",
          // Import all
          "Yes, continue"
          // Continue with warnings (if any)
        ]);
        const readPrefs = () => ({ ...prefs });
        const writePrefs = async (p) => {
          Object.assign(prefs, p);
        };
        await runClaudeImportFlow(ctx, "global", readPrefs, writePrefs);
        console.log("\nImport-all flow select calls:");
        selectCalls.forEach((call, i) => {
          console.log(`  ${i + 1}. "${call.prompt}"`);
        });
        const notifyCalls = ctx.ui.notify.mock.calls;
        assert.ok(notifyCalls.length > 0, "Should have shown notification");
        console.log("\nNotifications shown:");
        notifyCalls.forEach((call, i) => {
          const msg = call.arguments[0];
          const level = call.arguments[1];
          console.log(`  ${i + 1}. [${level}]: ${String(msg).split("\n")[0]}`);
        });
      });
      it("should not persist marketplace agent directories into package sources", async (t) => {
        const isolatedAgentDir = join(tempDir, ".gsd", "agent");
        const settingsPath = join(isolatedAgentDir, "settings.json");
        rmSync(isolatedAgentDir, { recursive: true, force: true });
        process.env.GSD_CODING_AGENT_DIR = isolatedAgentDir;
        t.after(() => {
          delete process.env.GSD_CODING_AGENT_DIR;
          rmSync(isolatedAgentDir, { recursive: true, force: true });
        });
        mkdirSync(isolatedAgentDir, { recursive: true });
        const tempSettings = { packages: [] };
        writeFileSync(settingsPath, JSON.stringify(tempSettings, null, 2));
        const { ctx } = createMockContext([
          "Plugins only",
          "Yes - discover plugins and select components",
          "Import all components",
          "Yes, continue"
        ]);
        const readPrefs = () => ({ ...prefs });
        const writePrefs = async (p) => {
          Object.assign(prefs, p);
        };
        await runClaudeImportFlow(ctx, "global", readPrefs, writePrefs);
        const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
        const packageEntries = Array.isArray(settings.packages) ? settings.packages : [];
        const hasAgentsDirPackage = packageEntries.some((entry) => {
          const source = typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.source : void 0;
          return typeof source === "string" && source.endsWith("/agents");
        });
        assert.strictEqual(hasAgentsDirPackage, false, "Marketplace agent directories should not be persisted as package sources");
      });
    });
  }
);
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jbGF1ZGUtaW1wb3J0LXR1aS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFRVSSBDb21tYW5kIEZsb3cgVGVzdHMgZm9yIGltcG9ydC1jbGF1ZGVcbiAqXG4gKiBUZXN0cyBSMDE1OiB2YWxpZGF0ZXMgdGhlIFRVSSBjb21tYW5kIGZsb3cgZm9yIC9nc2QgcHJlZnMgaW1wb3J0LWNsYXVkZS5cbiAqIFRoZXNlIHRlc3RzIGN1cnJlbnRseSB1c2UgbW9jayBVSSwgYW5kIG1hcmtldHBsYWNlIGF2YWlsYWJpbGl0eSBpcyBzdGlsbFxuICogZGVyaXZlZCBmcm9tIHJlYWwvbG9jYWwgbWFya2V0cGxhY2Ugcm9vdHMuIEZvbGxvdy11cCB3b3JrIHNob3VsZCByb3V0ZSB0aGVzZVxuICogdGhyb3VnaCBwb3J0YWJsZSBtYXJrZXRwbGFjZSBmaXh0dXJlcyB0aGF0IG1pcnJvciBDbGF1ZGUgQ29kZSdzXG4gKiBgL3BsdWdpbiBtYXJrZXRwbGFjZSBhZGQgLi4uYCBzb3VyY2UgbW9kZWwuXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBiZWZvcmUsIGFmdGVyLCBtb2NrIH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQnO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkdGVtcFN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYywgcmVhZEZpbGVTeW5jLCBta2RpclN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IH0gZnJvbSAnQGdzZC9waS1jb2RpbmctYWdlbnQnO1xuaW1wb3J0IHsgcnVuQ2xhdWRlSW1wb3J0RmxvdywgZ2V0Q2xhdWRlU2VhcmNoUm9vdHMsIGRpc2NvdmVyQ2xhdWRlU2tpbGxzLCBkaXNjb3ZlckNsYXVkZVBsdWdpbnMgfSBmcm9tICcuLi9jbGF1ZGUtaW1wb3J0LmpzJztcbmltcG9ydCB7IGdldE1hcmtldHBsYWNlRml4dHVyZXMgfSBmcm9tICcuL21hcmtldHBsYWNlLXRlc3QtZml4dHVyZXMuanMnO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBUZXN0IENvbmZpZ3VyYXRpb25cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuY29uc3QgZml4dHVyZVNldHVwID0gZ2V0TWFya2V0cGxhY2VGaXh0dXJlcyhpbXBvcnQubWV0YS5kaXJuYW1lKTtcbmNvbnN0IGZpeHR1cmVzID0gZml4dHVyZVNldHVwLmZpeHR1cmVzO1xuY29uc3QgQ0xBVURFX1NLSUxMU19QQVRIID0gZml4dHVyZXM/LmNsYXVkZVNraWxsc1BhdGg7XG5jb25zdCBDTEFVREVfUExVR0lOU19PRkZJQ0lBTF9QQVRIID0gZml4dHVyZXM/LmNsYXVkZVBsdWdpbnNPZmZpY2lhbFBhdGg7XG5cbmZ1bmN0aW9uIG1hcmtldHBsYWNlc0F2YWlsYWJsZSgpOiBib29sZWFuIHtcblx0cmV0dXJuIEJvb2xlYW4oZml4dHVyZXMpO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBNb2NrIFVJIENvbnRleHRcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuaW50ZXJmYWNlIE1vY2tVSVNlbGVjdENhbGwge1xuXHRwcm9tcHQ6IHN0cmluZztcblx0b3B0aW9uczogc3RyaW5nW107XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZU1vY2tDb250ZXh0KHNlbGVjdGlvbnM6IHN0cmluZ1tdKToge1xuXHRjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0O1xuXHRzZWxlY3RDYWxsczogTW9ja1VJU2VsZWN0Q2FsbFtdO1xufSB7XG5cdGNvbnN0IHNlbGVjdENhbGxzOiBNb2NrVUlTZWxlY3RDYWxsW10gPSBbXTtcblxuXHRjb25zdCBzZWxlY3RNb2NrID0gbW9jay5mbihhc3luYyAocHJvbXB0OiBzdHJpbmcsIG9wdGlvbnM6IHN0cmluZ1tdKSA9PiB7XG5cdFx0c2VsZWN0Q2FsbHMucHVzaCh7IHByb21wdCwgb3B0aW9ucyB9KTtcblx0XHRjb25zdCBuZXh0ID0gc2VsZWN0aW9ucy5zaGlmdCgpO1xuXHRcdGlmIChuZXh0ICYmIG9wdGlvbnMuaW5jbHVkZXMobmV4dCkpIHtcblx0XHRcdHJldHVybiBuZXh0O1xuXHRcdH1cblx0XHQvLyBEZWZhdWx0OiBjYW5jZWwgb3IgZmlyc3Qgb3B0aW9uXG5cdFx0cmV0dXJuIG9wdGlvbnMuZmluZChvID0+IG8udG9Mb3dlckNhc2UoKS5pbmNsdWRlcygnY2FuY2VsJykpIHx8IG9wdGlvbnNbMF07XG5cdH0pO1xuXG5cdGNvbnN0IG5vdGlmeU1vY2sgPSBtb2NrLmZuKCk7XG5cblx0Ly8gQ3JlYXRlIGEgbW9jayB0aGF0IHNhdGlzZmllcyBFeHRlbnNpb25Db21tYW5kQ29udGV4dFxuXHQvLyBVc2luZyB0eXBlIGFzc2VydGlvbiBzaW5jZSB3ZSBvbmx5IHVzZSBzZWxlY3QsIG5vdGlmeSwgd2FpdEZvcklkbGUsIHJlbG9hZCBpbiB0aGUgdGVzdHNcblx0Y29uc3QgY3R4ID0ge1xuXHRcdHVpOiB7XG5cdFx0XHRzZWxlY3Q6IHNlbGVjdE1vY2ssXG5cdFx0XHRub3RpZnk6IG5vdGlmeU1vY2ssXG5cdFx0XHRjb25maXJtOiBhc3luYyAoKSA9PiBmYWxzZSxcblx0XHRcdGlucHV0OiBhc3luYyAoKSA9PiB1bmRlZmluZWQsXG5cdFx0XHRvblRlcm1pbmFsSW5wdXQ6ICgpID0+ICgpID0+IHt9LFxuXHRcdFx0c2V0U3RhdHVzOiAoKSA9PiB7fSxcblx0XHRcdHNldFdvcmtpbmdNZXNzYWdlOiAoKSA9PiB7fSxcblx0XHRcdHNldFdpZGdldDogKCkgPT4ge30sXG5cdFx0XHRzZXRGb290ZXI6ICgpID0+IHt9LFxuXHRcdFx0c2V0SGVhZGVyOiAoKSA9PiB7fSxcblx0XHRcdHNldFRpdGxlOiAoKSA9PiB7fSxcblx0XHRcdGN1c3RvbTogYXN5bmMgKCkgPT4geyB0aHJvdyBuZXcgRXJyb3IoJ05vdCBpbXBsZW1lbnRlZCcpOyB9LFxuXHRcdFx0cGFzdGVUb0VkaXRvcjogKCkgPT4ge30sXG5cdFx0XHRzZXRFZGl0b3JUZXh0OiAoKSA9PiB7fSxcblx0XHRcdGdldEVkaXRvclRleHQ6ICgpID0+ICcnLFxuXHRcdFx0ZWRpdG9yOiBhc3luYyAoKSA9PiB1bmRlZmluZWQsXG5cdFx0XHRzZXRFZGl0b3JDb21wb25lbnQ6ICgpID0+IHt9LFxuXHRcdFx0dGhlbWU6IHt9LFxuXHRcdFx0Z2V0QWxsVGhlbWVzOiAoKSA9PiBbXSxcblx0XHRcdGdldFRoZW1lOiAoKSA9PiB1bmRlZmluZWQsXG5cdFx0XHRzZXRUaGVtZTogKCkgPT4gKHsgc3VjY2VzczogZmFsc2UgfSksXG5cdFx0XHRnZXRUb29sc0V4cGFuZGVkOiAoKSA9PiB0cnVlLFxuXHRcdFx0c2V0VG9vbHNFeHBhbmRlZDogKCkgPT4ge30sXG5cdFx0fSxcblx0XHRoYXNVSTogdHJ1ZSxcblx0XHRjd2Q6IHByb2Nlc3MuY3dkKCksXG5cdFx0c2Vzc2lvbk1hbmFnZXI6IHt9IGFzIHVua25vd24sXG5cdFx0bW9kZWxSZWdpc3RyeToge30gYXMgdW5rbm93bixcblx0XHRtb2RlbDogdW5kZWZpbmVkLFxuXHRcdGlzSWRsZTogKCkgPT4gdHJ1ZSxcblx0XHRhYm9ydDogKCkgPT4ge30sXG5cdFx0aGFzUGVuZGluZ01lc3NhZ2VzOiAoKSA9PiBmYWxzZSxcblx0XHRzaHV0ZG93bjogKCkgPT4ge30sXG5cdFx0Z2V0Q29udGV4dFVzYWdlOiAoKSA9PiB1bmRlZmluZWQsXG5cdFx0Y29tcGFjdDogKCkgPT4ge30sXG5cdFx0Z2V0U3lzdGVtUHJvbXB0OiAoKSA9PiAnJyxcblx0XHR3YWl0Rm9ySWRsZTogbW9jay5mbihhc3luYyAoKSA9PiB7fSksXG5cdFx0bmV3U2Vzc2lvbjogYXN5bmMgKCkgPT4gKHsgY2FuY2VsbGVkOiBmYWxzZSB9KSxcblx0XHRmb3JrOiBhc3luYyAoKSA9PiAoeyBjYW5jZWxsZWQ6IGZhbHNlIH0pLFxuXHRcdG5hdmlnYXRlVHJlZTogYXN5bmMgKCkgPT4gKHsgY2FuY2VsbGVkOiBmYWxzZSB9KSxcblx0XHRzd2l0Y2hTZXNzaW9uOiBhc3luYyAoKSA9PiAoeyBjYW5jZWxsZWQ6IGZhbHNlIH0pLFxuXHRcdHJlbG9hZDogbW9jay5mbihhc3luYyAoKSA9PiB7fSksXG5cdH0gYXMgdW5rbm93biBhcyBFeHRlbnNpb25Db21tYW5kQ29udGV4dDtcblxuXHRyZXR1cm4geyBjdHgsIHNlbGVjdENhbGxzIH07XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFRlc3RzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmNvbnN0IHNraXBSZWFzb24gPSAhbWFya2V0cGxhY2VzQXZhaWxhYmxlKClcblx0PyBmaXh0dXJlU2V0dXAuc2tpcFJlYXNvbiA/PyAnTWFya2V0cGxhY2UgcmVwb3Mgbm90IGZvdW5kIGZvciBUVUkgdGVzdGluZydcblx0OiB1bmRlZmluZWQ7XG5cbmRlc2NyaWJlKFxuXHQnVFVJIENvbW1hbmQgRmxvdyBUZXN0cycsXG5cdHsgc2tpcDogc2tpcFJlYXNvbiB9LFxuXHQoKSA9PiB7XG5cdFx0bGV0IHRlbXBEaXI6IHN0cmluZztcblx0XHRsZXQgcHJlZnNQYXRoOiBzdHJpbmc7XG5cdFx0bGV0IHByZWZzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcblxuXHRcdGJlZm9yZSgoKSA9PiB7XG5cdFx0XHR0ZW1wRGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC10dWktdGVzdC0nKSk7XG5cdFx0XHRwcmVmc1BhdGggPSBqb2luKHRlbXBEaXIsICdQUkVGRVJFTkNFUy5tZCcpO1xuXHRcdFx0cHJlZnMgPSB7IHZlcnNpb246IDEgfTtcblx0XHR9KTtcblxuXHRcdGFmdGVyKCgpID0+IHtcblx0XHRcdGZpeHR1cmVzPy5jbGVhbnVwKCk7XG5cdFx0XHRpZiAoZXhpc3RzU3luYyh0ZW1wRGlyKSkge1xuXHRcdFx0XHRybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdFx0fVxuXHRcdH0pO1xuXG5cdFx0ZGVzY3JpYmUoJ2dldENsYXVkZVNlYXJjaFJvb3RzKCknLCAoKSA9PiB7XG5cdFx0XHRpdCgnc2hvdWxkIHJldHVybiBleGlzdGluZyBza2lsbCBhbmQgcGx1Z2luIHJvb3RzJywgKCkgPT4ge1xuXHRcdFx0XHRjb25zdCBjd2QgPSBwcm9jZXNzLmN3ZCgpO1xuXHRcdFx0XHRjb25zdCB7IHNraWxsUm9vdHMsIHBsdWdpblJvb3RzIH0gPSBnZXRDbGF1ZGVTZWFyY2hSb290cyhjd2QpO1xuXG5cdFx0XHRcdC8vIEF0IGxlYXN0IG9uZSByb290IHNob3VsZCBleGlzdCBpbiBvdXIgdGVzdCBlbnZpcm9ubWVudFxuXHRcdFx0XHRhc3NlcnQub2soXG5cdFx0XHRcdFx0c2tpbGxSb290cy5sZW5ndGggPiAwIHx8IHBsdWdpblJvb3RzLmxlbmd0aCA+IDAsXG5cdFx0XHRcdFx0J1Nob3VsZCBmaW5kIGF0IGxlYXN0IG9uZSBzZWFyY2ggcm9vdCdcblx0XHRcdFx0KTtcblxuXHRcdFx0XHQvLyBBbGwgcmV0dXJuZWQgcm9vdHMgc2hvdWxkIGV4aXN0XG5cdFx0XHRcdGZvciAoY29uc3Qgcm9vdCBvZiBbLi4uc2tpbGxSb290cywgLi4ucGx1Z2luUm9vdHNdKSB7XG5cdFx0XHRcdFx0YXNzZXJ0Lm9rKGV4aXN0c1N5bmMocm9vdCksIGBSb290IHNob3VsZCBleGlzdDogJHtyb290fWApO1xuXHRcdFx0XHR9XG5cdFx0XHR9KTtcblx0XHR9KTtcblxuXHRcdGRlc2NyaWJlKCdkaXNjb3ZlckNsYXVkZVNraWxscygpJywgKCkgPT4ge1xuXHRcdFx0aXQoJ3Nob3VsZCBkaXNjb3ZlciBza2lsbHMgd2l0aG91dCBjcmFzaGluZycsICgpID0+IHtcblx0XHRcdFx0Y29uc3QgY3dkID0gcHJvY2Vzcy5jd2QoKTtcblx0XHRcdFx0Y29uc3Qgc2tpbGxzID0gZGlzY292ZXJDbGF1ZGVTa2lsbHMoY3dkKTtcblxuXHRcdFx0XHRhc3NlcnQub2soQXJyYXkuaXNBcnJheShza2lsbHMpLCAnU2hvdWxkIHJldHVybiBhbiBhcnJheScpO1xuXG5cdFx0XHRcdC8vIExvZyBmb3Igb2JzZXJ2YWJpbGl0eVxuXHRcdFx0XHRjb25zb2xlLmxvZyhgXFxuRGlzY292ZXJlZCAke3NraWxscy5sZW5ndGh9IHNraWxsc2ApO1xuXG5cdFx0XHRcdGlmIChza2lsbHMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRcdGNvbnNvbGUubG9nKCdTYW1wbGUgc2tpbGxzOicpO1xuXHRcdFx0XHRcdHNraWxscy5zbGljZSgwLCAzKS5mb3JFYWNoKHMgPT4ge1xuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYCAgLSAke3MubmFtZX0gKCR7cy5zb3VyY2VMYWJlbH0pYCk7XG5cdFx0XHRcdFx0fSk7XG5cblx0XHRcdFx0XHQvLyBWZXJpZnkgc3RydWN0dXJlXG5cdFx0XHRcdFx0Y29uc3Qgc2FtcGxlID0gc2tpbGxzWzBdITtcblx0XHRcdFx0XHRhc3NlcnQub2soc2FtcGxlLm5hbWUsICdTa2lsbCBzaG91bGQgaGF2ZSBuYW1lJyk7XG5cdFx0XHRcdFx0YXNzZXJ0Lm9rKHNhbXBsZS5wYXRoLCAnU2tpbGwgc2hvdWxkIGhhdmUgcGF0aCcpO1xuXHRcdFx0XHRcdGFzc2VydC5vayhzYW1wbGUucm9vdCwgJ1NraWxsIHNob3VsZCBoYXZlIHJvb3QnKTtcblx0XHRcdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2FtcGxlLnR5cGUsICdza2lsbCcpO1xuXHRcdFx0XHR9XG5cdFx0XHR9KTtcblx0XHR9KTtcblxuXHRcdGRlc2NyaWJlKCdkaXNjb3ZlckNsYXVkZVBsdWdpbnMoKScsICgpID0+IHtcblx0XHRcdGl0KCdzaG91bGQgZGlzY292ZXIgcGx1Z2lucyB3aXRob3V0IGNyYXNoaW5nJywgKCkgPT4ge1xuXHRcdFx0XHRjb25zdCBjd2QgPSBwcm9jZXNzLmN3ZCgpO1xuXHRcdFx0XHRjb25zdCBwbHVnaW5zID0gZGlzY292ZXJDbGF1ZGVQbHVnaW5zKGN3ZCk7XG5cblx0XHRcdFx0YXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkocGx1Z2lucyksICdTaG91bGQgcmV0dXJuIGFuIGFycmF5Jyk7XG5cblx0XHRcdFx0Ly8gTG9nIGZvciBvYnNlcnZhYmlsaXR5XG5cdFx0XHRcdGNvbnNvbGUubG9nKGBcXG5EaXNjb3ZlcmVkICR7cGx1Z2lucy5sZW5ndGh9IHBsdWdpbnNgKTtcblxuXHRcdFx0XHRpZiAocGx1Z2lucy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0Y29uc29sZS5sb2coJ1NhbXBsZSBwbHVnaW5zOicpO1xuXHRcdFx0XHRcdHBsdWdpbnMuc2xpY2UoMCwgMykuZm9yRWFjaChwID0+IHtcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGAgIC0gJHtwLm5hbWV9ICgke3Auc291cmNlTGFiZWx9KWApO1xuXHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0Ly8gVmVyaWZ5IHN0cnVjdHVyZVxuXHRcdFx0XHRcdGNvbnN0IHNhbXBsZSA9IHBsdWdpbnNbMF0hO1xuXHRcdFx0XHRcdGFzc2VydC5vayhzYW1wbGUubmFtZSwgJ1BsdWdpbiBzaG91bGQgaGF2ZSBuYW1lJyk7XG5cdFx0XHRcdFx0YXNzZXJ0Lm9rKHNhbXBsZS5wYXRoLCAnUGx1Z2luIHNob3VsZCBoYXZlIHBhdGgnKTtcblx0XHRcdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc2FtcGxlLnR5cGUsICdwbHVnaW4nKTtcblx0XHRcdFx0fVxuXHRcdFx0fSk7XG5cdFx0fSk7XG5cblx0XHRkZXNjcmliZSgncnVuQ2xhdWRlSW1wb3J0RmxvdygpJywgKCkgPT4ge1xuXHRcdFx0aXQoJ3Nob3VsZCBub3QgY3Jhc2ggd2hlbiB1c2VyIGNhbmNlbHMgYXQgZmlyc3QgcHJvbXB0JywgYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRjb25zdCB7IGN0eCwgc2VsZWN0Q2FsbHMgfSA9IGNyZWF0ZU1vY2tDb250ZXh0KFsnQ2FuY2VsJ10pO1xuXG5cdFx0XHRcdGNvbnN0IHJlYWRQcmVmcyA9ICgpID0+ICh7IC4uLnByZWZzIH0pO1xuXHRcdFx0XHRjb25zdCB3cml0ZVByZWZzID0gYXN5bmMgKHA6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG5cdFx0XHRcdFx0T2JqZWN0LmFzc2lnbihwcmVmcywgcCk7XG5cdFx0XHRcdH07XG5cblx0XHRcdFx0Ly8gU2hvdWxkIGNvbXBsZXRlIHdpdGhvdXQgdGhyb3dpbmdcblx0XHRcdFx0YXdhaXQgcnVuQ2xhdWRlSW1wb3J0RmxvdyhjdHgsICdnbG9iYWwnLCByZWFkUHJlZnMsIHdyaXRlUHJlZnMpO1xuXG5cdFx0XHRcdC8vIFNob3VsZCBoYXZlIGFza2VkIGFib3V0IGFzc2V0IHR5cGVcblx0XHRcdFx0YXNzZXJ0Lm9rKHNlbGVjdENhbGxzLmxlbmd0aCA+PSAxLCAnU2hvdWxkIGhhdmUgYXQgbGVhc3Qgb25lIHNlbGVjdCBjYWxsJyk7XG5cdFx0XHRcdGFzc2VydC5vayhcblx0XHRcdFx0XHRzZWxlY3RDYWxsc1swXSEucHJvbXB0LmluY2x1ZGVzKCdJbXBvcnQgQ2xhdWRlIGFzc2V0cycpLFxuXHRcdFx0XHRcdCdGaXJzdCBwcm9tcHQgc2hvdWxkIGJlIGFib3V0IGFzc2V0IHNlbGVjdGlvbidcblx0XHRcdFx0KTtcblx0XHRcdH0pO1xuXG5cdFx0XHRpdCgnc2hvdWxkIG5vdCBjcmFzaCB3aGVuIHNlbGVjdGluZyBza2lsbHMgb25seSB3aXRoIGNhbmNlbCBhdCBuZXh0IHN0ZXAnLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRcdGNvbnN0IHsgY3R4LCBzZWxlY3RDYWxscyB9ID0gY3JlYXRlTW9ja0NvbnRleHQoW1xuXHRcdFx0XHRcdCdTa2lsbHMgb25seScsICAgIC8vIFNlbGVjdCBza2lsbHMgb25seVxuXHRcdFx0XHRcdCdDYW5jZWwnLCAgICAgICAgIC8vIENhbmNlbCBhdCBza2lsbCBzZWxlY3Rpb25cblx0XHRcdFx0XSk7XG5cblx0XHRcdFx0Y29uc3QgcmVhZFByZWZzID0gKCkgPT4gKHsgLi4ucHJlZnMgfSk7XG5cdFx0XHRcdGNvbnN0IHdyaXRlUHJlZnMgPSBhc3luYyAocDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcblx0XHRcdFx0XHRPYmplY3QuYXNzaWduKHByZWZzLCBwKTtcblx0XHRcdFx0fTtcblxuXHRcdFx0XHQvLyBTaG91bGQgY29tcGxldGUgd2l0aG91dCB0aHJvd2luZ1xuXHRcdFx0XHRhd2FpdCBydW5DbGF1ZGVJbXBvcnRGbG93KGN0eCwgJ2dsb2JhbCcsIHJlYWRQcmVmcywgd3JpdGVQcmVmcyk7XG5cblx0XHRcdFx0Ly8gTG9nIGludGVyYWN0aW9uIGZsb3dcblx0XHRcdFx0Y29uc29sZS5sb2coJ1xcblNlbGVjdCBjYWxscyBtYWRlOicpO1xuXHRcdFx0XHRzZWxlY3RDYWxscy5mb3JFYWNoKChjYWxsLCBpKSA9PiB7XG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYCAgJHtpICsgMX0uIFwiJHtjYWxsLnByb21wdH1cImApO1xuXHRcdFx0XHR9KTtcblx0XHRcdH0pO1xuXG5cdFx0XHRpdCgnc2hvdWxkIGhhbmRsZSBtYXJrZXRwbGFjZSBmbG93IHdoZW4gdXNlciBzZWxlY3RzIHBsdWdpbnMnLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRcdGNvbnN0IHsgY3R4LCBzZWxlY3RDYWxscyB9ID0gY3JlYXRlTW9ja0NvbnRleHQoW1xuXHRcdFx0XHRcdCdQbHVnaW5zIG9ubHknLCAgICAgICAgICAgICAgICAgICAgIC8vIFNlbGVjdCBwbHVnaW5zIG9ubHlcblx0XHRcdFx0XHQnWWVzIC0gZGlzY292ZXIgcGx1Z2lucyBhbmQgc2VsZWN0IGNvbXBvbmVudHMnLCAgLy8gTWFya2V0cGxhY2UgcHJvbXB0XG5cdFx0XHRcdFx0J0NhbmNlbCcsICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gQ2FuY2VsIGF0IGNvbXBvbmVudCBzZWxlY3Rpb25cblx0XHRcdFx0XSk7XG5cblx0XHRcdFx0Y29uc3QgcmVhZFByZWZzID0gKCkgPT4gKHsgLi4ucHJlZnMgfSk7XG5cdFx0XHRcdGNvbnN0IHdyaXRlUHJlZnMgPSBhc3luYyAocDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcblx0XHRcdFx0XHRPYmplY3QuYXNzaWduKHByZWZzLCBwKTtcblx0XHRcdFx0fTtcblxuXHRcdFx0XHQvLyBTaG91bGQgY29tcGxldGUgd2l0aG91dCB0aHJvd2luZ1xuXHRcdFx0XHRhd2FpdCBydW5DbGF1ZGVJbXBvcnRGbG93KGN0eCwgJ2dsb2JhbCcsIHJlYWRQcmVmcywgd3JpdGVQcmVmcyk7XG5cblx0XHRcdFx0Ly8gTG9nIGludGVyYWN0aW9uIGZsb3dcblx0XHRcdFx0Y29uc29sZS5sb2coJ1xcbk1hcmtldHBsYWNlIGZsb3cgc2VsZWN0IGNhbGxzOicpO1xuXHRcdFx0XHRzZWxlY3RDYWxscy5mb3JFYWNoKChjYWxsLCBpKSA9PiB7XG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYCAgJHtpICsgMX0uIFwiJHtjYWxsLnByb21wdH1cImApO1xuXHRcdFx0XHR9KTtcblx0XHRcdH0pO1xuXG5cdFx0XHRpdCgnc2hvdWxkIGNvbXBsZXRlIGltcG9ydC1hbGwgZmxvdyB3aXRoIG1vY2sgVUknLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRcdC8vIFRoaXMgdGVzdHMgdGhlIGhhcHB5IHBhdGggd2hlcmUgdXNlciBzZWxlY3RzIFwiSW1wb3J0IGFsbFwiXG5cdFx0XHRcdGNvbnN0IHsgY3R4LCBzZWxlY3RDYWxscyB9ID0gY3JlYXRlTW9ja0NvbnRleHQoW1xuXHRcdFx0XHRcdCdTa2lsbHMgKyBwbHVnaW5zJywgICAgICAgICAgICAgICAgIC8vIFNlbGVjdCBib3RoXG5cdFx0XHRcdFx0J0NhbmNlbCcsICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gQ2FuY2VsIGF0IHNraWxsIHNlbGVjdGlvbiAobm8gc2tpbGxzIHRvIGltcG9ydClcblx0XHRcdFx0XHQnWWVzIC0gZGlzY292ZXIgcGx1Z2lucyBhbmQgc2VsZWN0IGNvbXBvbmVudHMnLCAgLy8gTWFya2V0cGxhY2UgcHJvbXB0XG5cdFx0XHRcdFx0J0ltcG9ydCBhbGwgY29tcG9uZW50cycsICAgICAgICAgICAgLy8gSW1wb3J0IGFsbFxuXHRcdFx0XHRcdCdZZXMsIGNvbnRpbnVlJywgICAgICAgICAgICAgICAgICAgIC8vIENvbnRpbnVlIHdpdGggd2FybmluZ3MgKGlmIGFueSlcblx0XHRcdFx0XSk7XG5cblx0XHRcdFx0Y29uc3QgcmVhZFByZWZzID0gKCkgPT4gKHsgLi4ucHJlZnMgfSk7XG5cdFx0XHRcdGNvbnN0IHdyaXRlUHJlZnMgPSBhc3luYyAocDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcblx0XHRcdFx0XHRPYmplY3QuYXNzaWduKHByZWZzLCBwKTtcblx0XHRcdFx0fTtcblxuXHRcdFx0XHQvLyBTaG91bGQgY29tcGxldGUgd2l0aG91dCB0aHJvd2luZ1xuXHRcdFx0XHRhd2FpdCBydW5DbGF1ZGVJbXBvcnRGbG93KGN0eCwgJ2dsb2JhbCcsIHJlYWRQcmVmcywgd3JpdGVQcmVmcyk7XG5cblx0XHRcdFx0Ly8gTG9nIGludGVyYWN0aW9uIGZsb3dcblx0XHRcdFx0Y29uc29sZS5sb2coJ1xcbkltcG9ydC1hbGwgZmxvdyBzZWxlY3QgY2FsbHM6Jyk7XG5cdFx0XHRcdHNlbGVjdENhbGxzLmZvckVhY2goKGNhbGwsIGkpID0+IHtcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgICAke2kgKyAxfS4gXCIke2NhbGwucHJvbXB0fVwiYCk7XG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdC8vIFZlcmlmeSBub3RpZmljYXRpb24gd2FzIGNhbGxlZFxuXHRcdFx0XHRjb25zdCBub3RpZnlDYWxscyA9IChjdHgudWkubm90aWZ5IGFzIHVua25vd24gYXMgUmV0dXJuVHlwZTx0eXBlb2YgbW9jay5mbj4pLm1vY2suY2FsbHM7XG5cdFx0XHRcdGFzc2VydC5vayhub3RpZnlDYWxscy5sZW5ndGggPiAwLCAnU2hvdWxkIGhhdmUgc2hvd24gbm90aWZpY2F0aW9uJyk7XG5cblx0XHRcdFx0Y29uc29sZS5sb2coJ1xcbk5vdGlmaWNhdGlvbnMgc2hvd246Jyk7XG5cdFx0XHRcdG5vdGlmeUNhbGxzLmZvckVhY2goKGNhbGwsIGkpID0+IHtcblx0XHRcdFx0XHRjb25zdCBtc2cgPSBjYWxsLmFyZ3VtZW50c1swXTtcblx0XHRcdFx0XHRjb25zdCBsZXZlbCA9IGNhbGwuYXJndW1lbnRzWzFdO1xuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGAgICR7aSArIDF9LiBbJHtsZXZlbH1dOiAke1N0cmluZyhtc2cpLnNwbGl0KCdcXG4nKVswXX1gKTtcblx0XHRcdFx0fSk7XG5cdFx0XHR9KTtcblxuXHRcdFx0aXQoJ3Nob3VsZCBub3QgcGVyc2lzdCBtYXJrZXRwbGFjZSBhZ2VudCBkaXJlY3RvcmllcyBpbnRvIHBhY2thZ2Ugc291cmNlcycsIGFzeW5jICh0KSA9PiB7XG5cdFx0XHRcdGNvbnN0IGlzb2xhdGVkQWdlbnREaXIgPSBqb2luKHRlbXBEaXIsICcuZ3NkJywgJ2FnZW50Jyk7XG5cdFx0XHRcdGNvbnN0IHNldHRpbmdzUGF0aCA9IGpvaW4oaXNvbGF0ZWRBZ2VudERpciwgJ3NldHRpbmdzLmpzb24nKTtcblx0XHRcdFx0cm1TeW5jKGlzb2xhdGVkQWdlbnREaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0XHRcdFx0cHJvY2Vzcy5lbnYuR1NEX0NPRElOR19BR0VOVF9ESVIgPSBpc29sYXRlZEFnZW50RGlyO1xuXG5cdFx0XHRcdHQuYWZ0ZXIoKCkgPT4ge1xuXHRcdFx0XHRcdGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfQ09ESU5HX0FHRU5UX0RJUjtcblx0XHRcdFx0XHRybVN5bmMoaXNvbGF0ZWRBZ2VudERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHRta2RpclN5bmMoaXNvbGF0ZWRBZ2VudERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdFx0XHRcdGNvbnN0IHRlbXBTZXR0aW5nczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IHBhY2thZ2VzOiBbXSB9O1xuXHRcdFx0XHR3cml0ZUZpbGVTeW5jKHNldHRpbmdzUGF0aCwgSlNPTi5zdHJpbmdpZnkodGVtcFNldHRpbmdzLCBudWxsLCAyKSk7XG5cblx0XHRcdFx0Y29uc3QgeyBjdHggfSA9IGNyZWF0ZU1vY2tDb250ZXh0KFtcblx0XHRcdFx0XHQnUGx1Z2lucyBvbmx5Jyxcblx0XHRcdFx0XHQnWWVzIC0gZGlzY292ZXIgcGx1Z2lucyBhbmQgc2VsZWN0IGNvbXBvbmVudHMnLFxuXHRcdFx0XHRcdCdJbXBvcnQgYWxsIGNvbXBvbmVudHMnLFxuXHRcdFx0XHRcdCdZZXMsIGNvbnRpbnVlJyxcblx0XHRcdFx0XSk7XG5cblx0XHRcdFx0Y29uc3QgcmVhZFByZWZzID0gKCkgPT4gKHsgLi4ucHJlZnMgfSk7XG5cdFx0XHRcdGNvbnN0IHdyaXRlUHJlZnMgPSBhc3luYyAocDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcblx0XHRcdFx0XHRPYmplY3QuYXNzaWduKHByZWZzLCBwKTtcblx0XHRcdFx0fTtcblxuXHRcdFx0XHRhd2FpdCBydW5DbGF1ZGVJbXBvcnRGbG93KGN0eCwgJ2dsb2JhbCcsIHJlYWRQcmVmcywgd3JpdGVQcmVmcyk7XG5cblx0XHRcdFx0Y29uc3Qgc2V0dGluZ3MgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhzZXR0aW5nc1BhdGgsICd1dGY4JykpIGFzIHsgcGFja2FnZXM/OiB1bmtub3duW10gfTtcblx0XHRcdFx0Y29uc3QgcGFja2FnZUVudHJpZXMgPSBBcnJheS5pc0FycmF5KHNldHRpbmdzLnBhY2thZ2VzKSA/IHNldHRpbmdzLnBhY2thZ2VzIDogW107XG5cdFx0XHRcdGNvbnN0IGhhc0FnZW50c0RpclBhY2thZ2UgPSBwYWNrYWdlRW50cmllcy5zb21lKChlbnRyeSkgPT4ge1xuXHRcdFx0XHRcdGNvbnN0IHNvdXJjZSA9IHR5cGVvZiBlbnRyeSA9PT0gJ3N0cmluZydcblx0XHRcdFx0XHRcdD8gZW50cnlcblx0XHRcdFx0XHRcdDogKGVudHJ5ICYmIHR5cGVvZiBlbnRyeSA9PT0gJ29iamVjdCcgPyAoZW50cnkgYXMgeyBzb3VyY2U/OiB1bmtub3duIH0pLnNvdXJjZSA6IHVuZGVmaW5lZCk7XG5cdFx0XHRcdFx0cmV0dXJuIHR5cGVvZiBzb3VyY2UgPT09ICdzdHJpbmcnICYmIHNvdXJjZS5lbmRzV2l0aCgnL2FnZW50cycpO1xuXHRcdFx0XHR9KTtcblxuXHRcdFx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoaGFzQWdlbnRzRGlyUGFja2FnZSwgZmFsc2UsICdNYXJrZXRwbGFjZSBhZ2VudCBkaXJlY3RvcmllcyBzaG91bGQgbm90IGJlIHBlcnNpc3RlZCBhcyBwYWNrYWdlIHNvdXJjZXMnKTtcblx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9XG4pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBVUEsU0FBUyxVQUFVLElBQUksUUFBUSxPQUFPLFlBQVk7QUFDbEQsT0FBTyxZQUFZO0FBQ25CLFNBQVMsWUFBWSxhQUFhLFFBQVEsZUFBZSxjQUFjLGlCQUFpQjtBQUN4RixTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBRXJCLFNBQVMscUJBQXFCLHNCQUFzQixzQkFBc0IsNkJBQTZCO0FBQ3ZHLFNBQVMs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
