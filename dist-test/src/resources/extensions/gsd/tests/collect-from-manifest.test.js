import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
async function loadFilesExports() {
  const mod = await import("../files.js");
  return {
    formatSecretsManifest: mod.formatSecretsManifest,
    parseSecretsManifest: mod.parseSecretsManifest
  };
}
function makeTempDir(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function makeManifest(entries) {
  return {
    milestone: "M001",
    generatedAt: "2026-03-12T00:00:00Z",
    entries: entries.map((e) => ({
      key: e.key ?? "TEST_KEY",
      service: e.service ?? "TestService",
      dashboardUrl: e.dashboardUrl ?? "",
      guidance: e.guidance ?? [],
      formatHint: e.formatHint ?? "",
      status: e.status ?? "pending",
      destination: e.destination ?? "dotenv"
    }))
  };
}
async function writeManifestFile(dir, manifest) {
  const { formatSecretsManifest } = await loadFilesExports();
  const milestoneDir = join(dir, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  const filePath = join(milestoneDir, "M001-SECRETS.md");
  writeFileSync(filePath, formatSecretsManifest(manifest));
  return filePath;
}
async function loadOrchestrator() {
  const mod = await import("../../get-secrets-from-user.js");
  if (typeof mod.collectSecretsFromManifest !== "function") {
    throw new Error("collectSecretsFromManifest is not exported from get-secrets-from-user.ts \u2014 T03 will implement this");
  }
  if (typeof mod.showSecretsSummary !== "function") {
    throw new Error("showSecretsSummary is not exported from get-secrets-from-user.ts \u2014 T03 will implement this");
  }
  return {
    collectSecretsFromManifest: mod.collectSecretsFromManifest,
    showSecretsSummary: mod.showSecretsSummary
  };
}
async function loadGuidanceExport() {
  const mod = await import("../../get-secrets-from-user.js");
  if (typeof mod.collectOneSecretWithGuidance !== "function") {
    throw new Error("collectOneSecretWithGuidance is not exported from get-secrets-from-user.ts \u2014 T02 will implement this");
  }
  return { collectOneSecretWithGuidance: mod.collectOneSecretWithGuidance };
}
test("collectSecretsFromManifest: categorizes entries \u2014 pending keys need collection, existing keys are skipped", async (t) => {
  const { collectSecretsFromManifest } = await loadOrchestrator();
  const tmp = makeTempDir("manifest-collect");
  const savedA = process.env.EXISTING_KEY_A;
  t.after(() => {
    delete process.env.EXISTING_KEY_A;
    if (savedA !== void 0) process.env.EXISTING_KEY_A = savedA;
    rmSync(tmp, { recursive: true, force: true });
  });
  process.env.EXISTING_KEY_A = "already-set";
  const manifest = makeManifest([
    { key: "EXISTING_KEY_A", status: "pending" },
    { key: "PENDING_KEY_B", status: "pending", guidance: ["Step 1: Go to dashboard", "Step 2: Click create key"] },
    { key: "SKIPPED_KEY_C", status: "skipped" }
  ]);
  await writeManifestFile(tmp, manifest);
  let callIndex = 0;
  const mockCtx = {
    cwd: tmp,
    hasUI: true,
    ui: {
      custom: async (_factory) => {
        callIndex++;
        if (callIndex <= 1) return null;
        return "mock-secret-value";
      }
    }
  };
  const result = await collectSecretsFromManifest(tmp, "M001", mockCtx);
  assert.ok(
    result.existingSkipped?.includes("EXISTING_KEY_A"),
    "EXISTING_KEY_A should be in existingSkipped"
  );
  assert.ok(
    result.applied.includes("PENDING_KEY_B"),
    "PENDING_KEY_B should be in applied"
  );
  assert.ok(
    result.skipped.includes("SKIPPED_KEY_C"),
    "SKIPPED_KEY_C should be in skipped"
  );
});
test("collectSecretsFromManifest: existing keys are excluded from the collection list \u2014 not prompted", async (t) => {
  const { collectSecretsFromManifest } = await loadOrchestrator();
  const tmp = makeTempDir("manifest-collect-skip");
  const savedA = process.env.ALREADY_SET_KEY;
  t.after(() => {
    delete process.env.ALREADY_SET_KEY;
    if (savedA !== void 0) process.env.ALREADY_SET_KEY = savedA;
    rmSync(tmp, { recursive: true, force: true });
  });
  process.env.ALREADY_SET_KEY = "present";
  const manifest = makeManifest([
    { key: "ALREADY_SET_KEY", status: "pending" },
    { key: "NEEDS_COLLECTION", status: "pending" }
  ]);
  await writeManifestFile(tmp, manifest);
  const collectedKeyNames = [];
  let summaryShown = false;
  const mockCtx = {
    cwd: tmp,
    hasUI: true,
    ui: {
      custom: async (factory) => {
        if (!summaryShown) {
          summaryShown = true;
          return null;
        }
        collectedKeyNames.push("prompted");
        return "mock-value";
      }
    }
  };
  const result = await collectSecretsFromManifest(tmp, "M001", mockCtx);
  assert.ok(
    !result.applied.includes("ALREADY_SET_KEY"),
    "ALREADY_SET_KEY should not be in applied (it was auto-skipped)"
  );
  assert.ok(
    result.existingSkipped?.includes("ALREADY_SET_KEY"),
    "ALREADY_SET_KEY should be in existingSkipped"
  );
});
test("collectSecretsFromManifest: manifest statuses are updated after collection", async (t) => {
  const { collectSecretsFromManifest } = await loadOrchestrator();
  const tmp = makeTempDir("manifest-update");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const manifest = makeManifest([
    { key: "KEY_TO_COLLECT", status: "pending" },
    { key: "KEY_TO_SKIP", status: "pending" }
  ]);
  const manifestPath = await writeManifestFile(tmp, manifest);
  let callIndex = 0;
  const mockCtx = {
    cwd: tmp,
    hasUI: true,
    ui: {
      custom: async (_factory) => {
        callIndex++;
        if (callIndex <= 1) return null;
        if (callIndex === 2) return "secret-value";
        return null;
      }
    }
  };
  await collectSecretsFromManifest(tmp, "M001", mockCtx);
  const { parseSecretsManifest } = await loadFilesExports();
  const updatedContent = readFileSync(manifestPath, "utf8");
  const updatedManifest = parseSecretsManifest(updatedContent);
  const keyToCollect = updatedManifest.entries.find((e) => e.key === "KEY_TO_COLLECT");
  const keyToSkip = updatedManifest.entries.find((e) => e.key === "KEY_TO_SKIP");
  assert.equal(
    keyToCollect?.status,
    "collected",
    "KEY_TO_COLLECT should have status 'collected' after providing a value"
  );
  assert.equal(
    keyToSkip?.status,
    "skipped",
    "KEY_TO_SKIP should have status 'skipped' after user skipped it"
  );
});
test("collectSecretsFromManifest: applied keys hydrate process.env for the running session", async (t) => {
  const { collectSecretsFromManifest } = await loadOrchestrator();
  const tmp = makeTempDir("manifest-live-env");
  const envKey = "CONTEXT7_API_KEY";
  const saved = process.env[envKey];
  t.after(() => {
    if (saved === void 0) delete process.env[envKey];
    else process.env[envKey] = saved;
    rmSync(tmp, { recursive: true, force: true });
  });
  delete process.env[envKey];
  const manifest = makeManifest([
    { key: envKey, status: "pending" }
  ]);
  await writeManifestFile(tmp, manifest);
  let callIndex = 0;
  const mockCtx = {
    cwd: tmp,
    hasUI: true,
    ui: {
      custom: async (_factory) => {
        callIndex++;
        if (callIndex <= 1) return null;
        return "c7_live_test_key";
      }
    }
  };
  const result = await collectSecretsFromManifest(tmp, "M001", mockCtx);
  assert.ok(result.applied.includes(envKey), "CONTEXT7_API_KEY should be applied");
  assert.equal(
    process.env[envKey],
    "c7_live_test_key",
    "applied keys should be available through process.env without restarting"
  );
});
test("showSecretsSummary: produces lines with correct status glyphs for each entry status", async () => {
  const { showSecretsSummary } = await loadOrchestrator();
  const entries = [
    { key: "PENDING_KEY", service: "Svc", dashboardUrl: "", guidance: [], formatHint: "", status: "pending", destination: "dotenv" },
    { key: "COLLECTED_KEY", service: "Svc", dashboardUrl: "", guidance: [], formatHint: "", status: "collected", destination: "dotenv" },
    { key: "SKIPPED_KEY", service: "Svc", dashboardUrl: "", guidance: [], formatHint: "", status: "skipped", destination: "dotenv" }
  ];
  let renderFn;
  const mockCtx = {
    hasUI: true,
    ui: {
      custom: async (factory) => {
        const mockTheme = {
          fg: (_color, text) => text,
          bold: (text) => text
        };
        const mockTui = { requestRender: () => {
        }, terminal: { rows: 24, columns: 80 } };
        const component = factory(mockTui, mockTheme, {}, () => {
        });
        renderFn = component.render;
        component.handleInput("\x1B");
      }
    }
  };
  await showSecretsSummary(mockCtx, entries, []);
  assert.ok(renderFn, "render function should have been captured from factory");
  const lines = renderFn(80);
  const output = lines.join("\n");
  assert.ok(output.includes("PENDING_KEY"), "should include PENDING_KEY");
  assert.ok(output.includes("COLLECTED_KEY"), "should include COLLECTED_KEY");
  assert.ok(output.includes("SKIPPED_KEY"), "should include SKIPPED_KEY");
  assert.ok(lines.length >= 5, `should have at least 5 lines (got ${lines.length})`);
});
test("showSecretsSummary: existing keys shown with distinct status indicator", async () => {
  const { showSecretsSummary } = await loadOrchestrator();
  const entries = [
    { key: "NEW_KEY", service: "Svc", dashboardUrl: "", guidance: [], formatHint: "", status: "pending", destination: "dotenv" },
    { key: "OLD_KEY", service: "Svc", dashboardUrl: "", guidance: [], formatHint: "", status: "collected", destination: "dotenv" }
  ];
  const existingKeys = ["OLD_KEY"];
  let renderFn;
  const mockCtx = {
    hasUI: true,
    ui: {
      custom: async (factory) => {
        const mockTheme = {
          fg: (_color, text) => text,
          bold: (text) => text
        };
        const mockTui = { requestRender: () => {
        }, terminal: { rows: 24, columns: 80 } };
        const component = factory(mockTui, mockTheme, {}, () => {
        });
        renderFn = component.render;
        component.handleInput("\x1B");
      }
    }
  };
  await showSecretsSummary(mockCtx, entries, existingKeys);
  assert.ok(renderFn, "render function should have been captured");
  const lines = renderFn(80);
  const output = lines.join("\n");
  assert.ok(output.includes("NEW_KEY"), "should include NEW_KEY");
  assert.ok(output.includes("OLD_KEY"), "should include OLD_KEY");
});
test("collectOneSecret: guidance lines appear in render output when guidance is provided", async () => {
  const { collectOneSecretWithGuidance } = await loadGuidanceExport();
  const guidanceSteps = [
    "Navigate to https://platform.openai.com/api-keys",
    "Click 'Create new secret key'",
    "Copy the key value"
  ];
  let renderFn;
  const mockCtx = {
    hasUI: true,
    ui: {
      custom: async (factory) => {
        const mockTheme = {
          fg: (_color, text) => text,
          bold: (text) => text
        };
        const mockTui = { requestRender: () => {
        }, terminal: { rows: 24, columns: 80 } };
        const component = factory(mockTui, mockTheme, {}, () => {
        });
        renderFn = component.render;
        component.handleInput("\x1B");
      }
    }
  };
  await collectOneSecretWithGuidance(mockCtx, 0, 1, "OPENAI_API_KEY", "starts with sk-", guidanceSteps);
  assert.ok(renderFn, "render function should have been captured");
  const lines = renderFn(80);
  const output = lines.join("\n");
  assert.ok(output.includes("Navigate to"), "should include first guidance step");
  assert.ok(output.includes("Create new secret key"), "should include second guidance step");
  assert.ok(output.includes("Copy the key value"), "should include third guidance step");
});
test("collectOneSecret: guidance lines wrap long URLs instead of truncating", async () => {
  const { collectOneSecretWithGuidance } = await loadGuidanceExport();
  const longGuidance = [
    "Navigate to https://platform.openai.com/account/api-keys and click 'Create new secret key'"
  ];
  let renderFn;
  const mockCtx = {
    hasUI: true,
    ui: {
      custom: async (factory) => {
        const mockTheme = {
          fg: (_color, text) => text,
          bold: (text) => text
        };
        const mockTui = { requestRender: () => {
        }, terminal: { rows: 24, columns: 80 } };
        const component = factory(mockTui, mockTheme, {}, () => {
        });
        renderFn = component.render;
        component.handleInput("\x1B");
      }
    }
  };
  await collectOneSecretWithGuidance(mockCtx, 0, 1, "TEST_KEY", void 0, longGuidance);
  assert.ok(renderFn, "render function should have been captured");
  const lines = renderFn(50);
  const output = lines.join("\n");
  assert.ok(output.includes("platform.openai.com"), "URL should not be truncated");
  assert.ok(output.includes("Create new secret key"), "text after URL should not be truncated");
});
test("collectOneSecret: no guidance provided \u2014 render output has no guidance section", async () => {
  const { collectOneSecretWithGuidance } = await loadGuidanceExport();
  let renderFn;
  const mockCtx = {
    hasUI: true,
    ui: {
      custom: async (factory) => {
        const mockTheme = {
          fg: (_color, text) => text,
          bold: (text) => text
        };
        const mockTui = { requestRender: () => {
        }, terminal: { rows: 24, columns: 80 } };
        const component = factory(mockTui, mockTheme, {}, () => {
        });
        renderFn = component.render;
        component.handleInput("\x1B");
      }
    }
  };
  await collectOneSecretWithGuidance(mockCtx, 0, 1, "SOME_KEY", "hint text", void 0);
  assert.ok(renderFn, "render function should have been captured");
  const lines = renderFn(80);
  const output = lines.join("\n");
  assert.ok(output.includes("SOME_KEY"), "should include key name");
  assert.ok(output.includes("hint text"), "should include hint");
  assert.ok(!output.match(/^\s*1\.\s/m), "should not have numbered guidance steps when no guidance provided");
});
test("collectSecretsFromManifest: returns result with applied, skipped, and existingSkipped arrays", async (t) => {
  const { collectSecretsFromManifest } = await loadOrchestrator();
  const tmp = makeTempDir("manifest-result");
  const savedKey = process.env.RESULT_TEST_EXISTING;
  t.after(() => {
    delete process.env.RESULT_TEST_EXISTING;
    if (savedKey !== void 0) process.env.RESULT_TEST_EXISTING = savedKey;
    rmSync(tmp, { recursive: true, force: true });
  });
  process.env.RESULT_TEST_EXISTING = "already-here";
  const manifest = makeManifest([
    { key: "RESULT_TEST_EXISTING", status: "pending" },
    { key: "RESULT_TEST_NEW", status: "pending" }
  ]);
  await writeManifestFile(tmp, manifest);
  let callIndex = 0;
  const mockCtx = {
    cwd: tmp,
    hasUI: true,
    ui: {
      custom: async (_factory) => {
        callIndex++;
        if (callIndex <= 1) return null;
        return "secret-value";
      }
    }
  };
  const result = await collectSecretsFromManifest(tmp, "M001", mockCtx);
  assert.ok(Array.isArray(result.applied), "result should have applied array");
  assert.ok(Array.isArray(result.skipped), "result should have skipped array");
  assert.ok(Array.isArray(result.existingSkipped), "result should have existingSkipped array");
  assert.ok(
    result.existingSkipped.includes("RESULT_TEST_EXISTING"),
    "existing key should be in existingSkipped"
  );
  assert.ok(
    result.applied.includes("RESULT_TEST_NEW"),
    "collected key should be in applied"
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb2xsZWN0LWZyb20tbWFuaWZlc3QudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBUZXN0cyBmb3IgUzAyIEVuaGFuY2VkIENvbGxlY3Rpb24gVFVJIGZ1bmN0aW9uczpcbiAqIC0gY29sbGVjdFNlY3JldHNGcm9tTWFuaWZlc3QoKSBvcmNoZXN0cmF0b3IgY2F0ZWdvcml6YXRpb24gYW5kIGZsb3dcbiAqIC0gc2hvd1NlY3JldHNTdW1tYXJ5KCkgcmVuZGVyIG91dHB1dFxuICogLSBjb2xsZWN0T25lU2VjcmV0KCkgZ3VpZGFuY2UgcmVuZGVyaW5nXG4gKlxuICogVGhlc2UgdGVzdHMgaW1wb3J0IGZ1bmN0aW9ucyB0aGF0IGRvbid0IGV4aXN0IHlldCAoVDAyL1QwMyB3aWxsIGJ1aWxkIHRoZW0pLlxuICogVGhleSBhcmUgZXhwZWN0ZWQgdG8gZmFpbCB1bnRpbCBpbXBsZW1lbnRhdGlvbiBpcyBjb21wbGV0ZS5cbiAqXG4gKiBVc2VzIGR5bmFtaWMgaW1wb3J0cyBzbyBpbmRpdmlkdWFsIHRlc3RzIGZhaWwgd2l0aCBjbGVhciBtZXNzYWdlc1xuICogaW5zdGVhZCBvZiB0aGUgZW50aXJlIGZpbGUgY3Jhc2hpbmcgYXQgaW1wb3J0IHRpbWUuXG4gKi9cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHR5cGUgeyBTZWNyZXRzTWFuaWZlc3QsIFNlY3JldHNNYW5pZmVzdEVudHJ5IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbi8vIER5bmFtaWMgaW1wb3J0cyBmb3IgZmlsZXMudHMgZnVuY3Rpb25zIHRvIGF2b2lkIGNhc2NhZGluZyBmYWlsdXJlXG4vLyB3aGVuIHBhdGhzLmpzIGlzbid0IGF2YWlsYWJsZSAoZmlsZXMudHMgc3RhdGljYWxseSBpbXBvcnRzIHBhdGhzLmpzKVxuYXN5bmMgZnVuY3Rpb24gbG9hZEZpbGVzRXhwb3J0cygpOiBQcm9taXNlPHtcblx0Zm9ybWF0U2VjcmV0c01hbmlmZXN0OiAobTogU2VjcmV0c01hbmlmZXN0KSA9PiBzdHJpbmc7XG5cdHBhcnNlU2VjcmV0c01hbmlmZXN0OiAoY29udGVudDogc3RyaW5nKSA9PiBTZWNyZXRzTWFuaWZlc3Q7XG59PiB7XG5cdGNvbnN0IG1vZCA9IGF3YWl0IGltcG9ydChcIi4uL2ZpbGVzLnRzXCIpO1xuXHRyZXR1cm4ge1xuXHRcdGZvcm1hdFNlY3JldHNNYW5pZmVzdDogbW9kLmZvcm1hdFNlY3JldHNNYW5pZmVzdCxcblx0XHRwYXJzZVNlY3JldHNNYW5pZmVzdDogbW9kLnBhcnNlU2VjcmV0c01hbmlmZXN0LFxuXHR9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gbWFrZVRlbXBEaXIocHJlZml4OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBkaXIgPSBqb2luKHRtcGRpcigpLCBgJHtwcmVmaXh9LSR7RGF0ZS5ub3coKX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyKX1gKTtcblx0bWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdHJldHVybiBkaXI7XG59XG5cbmZ1bmN0aW9uIG1ha2VNYW5pZmVzdChlbnRyaWVzOiBQYXJ0aWFsPFNlY3JldHNNYW5pZmVzdEVudHJ5PltdKTogU2VjcmV0c01hbmlmZXN0IHtcblx0cmV0dXJuIHtcblx0XHRtaWxlc3RvbmU6IFwiTTAwMVwiLFxuXHRcdGdlbmVyYXRlZEF0OiBcIjIwMjYtMDMtMTJUMDA6MDA6MDBaXCIsXG5cdFx0ZW50cmllczogZW50cmllcy5tYXAoKGUpID0+ICh7XG5cdFx0XHRrZXk6IGUua2V5ID8/IFwiVEVTVF9LRVlcIixcblx0XHRcdHNlcnZpY2U6IGUuc2VydmljZSA/PyBcIlRlc3RTZXJ2aWNlXCIsXG5cdFx0XHRkYXNoYm9hcmRVcmw6IGUuZGFzaGJvYXJkVXJsID8/IFwiXCIsXG5cdFx0XHRndWlkYW5jZTogZS5ndWlkYW5jZSA/PyBbXSxcblx0XHRcdGZvcm1hdEhpbnQ6IGUuZm9ybWF0SGludCA/PyBcIlwiLFxuXHRcdFx0c3RhdHVzOiBlLnN0YXR1cyA/PyBcInBlbmRpbmdcIixcblx0XHRcdGRlc3RpbmF0aW9uOiBlLmRlc3RpbmF0aW9uID8/IFwiZG90ZW52XCIsXG5cdFx0fSkpLFxuXHR9O1xufVxuXG5hc3luYyBmdW5jdGlvbiB3cml0ZU1hbmlmZXN0RmlsZShkaXI6IHN0cmluZywgbWFuaWZlc3Q6IFNlY3JldHNNYW5pZmVzdCk6IFByb21pc2U8c3RyaW5nPiB7XG5cdGNvbnN0IHsgZm9ybWF0U2VjcmV0c01hbmlmZXN0IH0gPSBhd2FpdCBsb2FkRmlsZXNFeHBvcnRzKCk7XG5cdGNvbnN0IG1pbGVzdG9uZURpciA9IGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKTtcblx0bWtkaXJTeW5jKG1pbGVzdG9uZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdGNvbnN0IGZpbGVQYXRoID0gam9pbihtaWxlc3RvbmVEaXIsIFwiTTAwMS1TRUNSRVRTLm1kXCIpO1xuXHR3cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBmb3JtYXRTZWNyZXRzTWFuaWZlc3QobWFuaWZlc3QpKTtcblx0cmV0dXJuIGZpbGVQYXRoO1xufVxuXG5hc3luYyBmdW5jdGlvbiBsb2FkT3JjaGVzdHJhdG9yKCk6IFByb21pc2U8e1xuXHRjb2xsZWN0U2VjcmV0c0Zyb21NYW5pZmVzdDogRnVuY3Rpb247XG5cdHNob3dTZWNyZXRzU3VtbWFyeTogRnVuY3Rpb247XG59PiB7XG5cdGNvbnN0IG1vZCA9IGF3YWl0IGltcG9ydChcIi4uLy4uL2dldC1zZWNyZXRzLWZyb20tdXNlci50c1wiKTtcblx0aWYgKHR5cGVvZiBtb2QuY29sbGVjdFNlY3JldHNGcm9tTWFuaWZlc3QgIT09IFwiZnVuY3Rpb25cIikge1xuXHRcdHRocm93IG5ldyBFcnJvcihcImNvbGxlY3RTZWNyZXRzRnJvbU1hbmlmZXN0IGlzIG5vdCBleHBvcnRlZCBmcm9tIGdldC1zZWNyZXRzLWZyb20tdXNlci50cyBcdTIwMTQgVDAzIHdpbGwgaW1wbGVtZW50IHRoaXNcIik7XG5cdH1cblx0aWYgKHR5cGVvZiBtb2Quc2hvd1NlY3JldHNTdW1tYXJ5ICE9PSBcImZ1bmN0aW9uXCIpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoXCJzaG93U2VjcmV0c1N1bW1hcnkgaXMgbm90IGV4cG9ydGVkIGZyb20gZ2V0LXNlY3JldHMtZnJvbS11c2VyLnRzIFx1MjAxNCBUMDMgd2lsbCBpbXBsZW1lbnQgdGhpc1wiKTtcblx0fVxuXHRyZXR1cm4ge1xuXHRcdGNvbGxlY3RTZWNyZXRzRnJvbU1hbmlmZXN0OiBtb2QuY29sbGVjdFNlY3JldHNGcm9tTWFuaWZlc3QsXG5cdFx0c2hvd1NlY3JldHNTdW1tYXJ5OiBtb2Quc2hvd1NlY3JldHNTdW1tYXJ5LFxuXHR9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBsb2FkR3VpZGFuY2VFeHBvcnQoKTogUHJvbWlzZTx7IGNvbGxlY3RPbmVTZWNyZXRXaXRoR3VpZGFuY2U6IEZ1bmN0aW9uIH0+IHtcblx0Y29uc3QgbW9kID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vZ2V0LXNlY3JldHMtZnJvbS11c2VyLnRzXCIpO1xuXHRpZiAodHlwZW9mIG1vZC5jb2xsZWN0T25lU2VjcmV0V2l0aEd1aWRhbmNlICE9PSBcImZ1bmN0aW9uXCIpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoXCJjb2xsZWN0T25lU2VjcmV0V2l0aEd1aWRhbmNlIGlzIG5vdCBleHBvcnRlZCBmcm9tIGdldC1zZWNyZXRzLWZyb20tdXNlci50cyBcdTIwMTQgVDAyIHdpbGwgaW1wbGVtZW50IHRoaXNcIik7XG5cdH1cblx0cmV0dXJuIHsgY29sbGVjdE9uZVNlY3JldFdpdGhHdWlkYW5jZTogbW9kLmNvbGxlY3RPbmVTZWNyZXRXaXRoR3VpZGFuY2UgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIGNvbGxlY3RTZWNyZXRzRnJvbU1hbmlmZXN0OiBjYXRlZ29yaXphdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImNvbGxlY3RTZWNyZXRzRnJvbU1hbmlmZXN0OiBjYXRlZ29yaXplcyBlbnRyaWVzIFx1MjAxNCBwZW5kaW5nIGtleXMgbmVlZCBjb2xsZWN0aW9uLCBleGlzdGluZyBrZXlzIGFyZSBza2lwcGVkXCIsIGFzeW5jICh0KSA9PiB7XG5cdGNvbnN0IHsgY29sbGVjdFNlY3JldHNGcm9tTWFuaWZlc3QgfSA9IGF3YWl0IGxvYWRPcmNoZXN0cmF0b3IoKTtcblxuXHRjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcIm1hbmlmZXN0LWNvbGxlY3RcIik7XG5cdGNvbnN0IHNhdmVkQSA9IHByb2Nlc3MuZW52LkVYSVNUSU5HX0tFWV9BO1xuXHR0LmFmdGVyKCgpID0+IHtcblx0XHRkZWxldGUgcHJvY2Vzcy5lbnYuRVhJU1RJTkdfS0VZX0E7XG5cdFx0aWYgKHNhdmVkQSAhPT0gdW5kZWZpbmVkKSBwcm9jZXNzLmVudi5FWElTVElOR19LRVlfQSA9IHNhdmVkQTtcblx0XHRybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cdH0pO1xuXG5cdHByb2Nlc3MuZW52LkVYSVNUSU5HX0tFWV9BID0gXCJhbHJlYWR5LXNldFwiO1xuXG5cdGNvbnN0IG1hbmlmZXN0ID0gbWFrZU1hbmlmZXN0KFtcblx0XHR7IGtleTogXCJFWElTVElOR19LRVlfQVwiLCBzdGF0dXM6IFwicGVuZGluZ1wiIH0sXG5cdFx0eyBrZXk6IFwiUEVORElOR19LRVlfQlwiLCBzdGF0dXM6IFwicGVuZGluZ1wiLCBndWlkYW5jZTogW1wiU3RlcCAxOiBHbyB0byBkYXNoYm9hcmRcIiwgXCJTdGVwIDI6IENsaWNrIGNyZWF0ZSBrZXlcIl0gfSxcblx0XHR7IGtleTogXCJTS0lQUEVEX0tFWV9DXCIsIHN0YXR1czogXCJza2lwcGVkXCIgfSxcblx0XSk7XG5cdGF3YWl0IHdyaXRlTWFuaWZlc3RGaWxlKHRtcCwgbWFuaWZlc3QpO1xuXG5cdGxldCBjYWxsSW5kZXggPSAwO1xuXHRjb25zdCBtb2NrQ3R4ID0ge1xuXHRcdGN3ZDogdG1wLFxuXHRcdGhhc1VJOiB0cnVlLFxuXHRcdHVpOiB7XG5cdFx0XHRjdXN0b206IGFzeW5jIChfZmFjdG9yeTogYW55KSA9PiB7XG5cdFx0XHRcdGNhbGxJbmRleCsrO1xuXHRcdFx0XHRpZiAoY2FsbEluZGV4IDw9IDEpIHJldHVybiBudWxsOyAvLyBzdW1tYXJ5IHNjcmVlbiBkaXNtaXNzXG5cdFx0XHRcdHJldHVybiBcIm1vY2stc2VjcmV0LXZhbHVlXCI7IC8vIGNvbGxlY3QgcGVuZGluZyBrZXlcblx0XHRcdH0sXG5cdFx0fSxcblx0fTtcblxuXHRjb25zdCByZXN1bHQgPSBhd2FpdCBjb2xsZWN0U2VjcmV0c0Zyb21NYW5pZmVzdCh0bXAsIFwiTTAwMVwiLCBtb2NrQ3R4IGFzIGFueSk7XG5cblx0Ly8gRVhJU1RJTkdfS0VZX0Egc2hvdWxkIGJlIGluIGV4aXN0aW5nU2tpcHBlZCAoaXQncyBpbiBwcm9jZXNzLmVudilcblx0YXNzZXJ0Lm9rKHJlc3VsdC5leGlzdGluZ1NraXBwZWQ/LmluY2x1ZGVzKFwiRVhJU1RJTkdfS0VZX0FcIiksXG5cdFx0XCJFWElTVElOR19LRVlfQSBzaG91bGQgYmUgaW4gZXhpc3RpbmdTa2lwcGVkXCIpO1xuXG5cdC8vIFBFTkRJTkdfS0VZX0Igc2hvdWxkIGhhdmUgYmVlbiBjb2xsZWN0ZWQgKGFwcGxpZWQpXG5cdGFzc2VydC5vayhyZXN1bHQuYXBwbGllZC5pbmNsdWRlcyhcIlBFTkRJTkdfS0VZX0JcIiksXG5cdFx0XCJQRU5ESU5HX0tFWV9CIHNob3VsZCBiZSBpbiBhcHBsaWVkXCIpO1xuXG5cdC8vIFNLSVBQRURfS0VZX0Mgc2hvdWxkIHJlbWFpbiBza2lwcGVkXG5cdGFzc2VydC5vayhyZXN1bHQuc2tpcHBlZC5pbmNsdWRlcyhcIlNLSVBQRURfS0VZX0NcIiksXG5cdFx0XCJTS0lQUEVEX0tFWV9DIHNob3VsZCBiZSBpbiBza2lwcGVkXCIpO1xufSk7XG5cbnRlc3QoXCJjb2xsZWN0U2VjcmV0c0Zyb21NYW5pZmVzdDogZXhpc3Rpbmcga2V5cyBhcmUgZXhjbHVkZWQgZnJvbSB0aGUgY29sbGVjdGlvbiBsaXN0IFx1MjAxNCBub3QgcHJvbXB0ZWRcIiwgYXN5bmMgKHQpID0+IHtcblx0Y29uc3QgeyBjb2xsZWN0U2VjcmV0c0Zyb21NYW5pZmVzdCB9ID0gYXdhaXQgbG9hZE9yY2hlc3RyYXRvcigpO1xuXG5cdGNvbnN0IHRtcCA9IG1ha2VUZW1wRGlyKFwibWFuaWZlc3QtY29sbGVjdC1za2lwXCIpO1xuXHRjb25zdCBzYXZlZEEgPSBwcm9jZXNzLmVudi5BTFJFQURZX1NFVF9LRVk7XG5cdHQuYWZ0ZXIoKCkgPT4ge1xuXHRcdGRlbGV0ZSBwcm9jZXNzLmVudi5BTFJFQURZX1NFVF9LRVk7XG5cdFx0aWYgKHNhdmVkQSAhPT0gdW5kZWZpbmVkKSBwcm9jZXNzLmVudi5BTFJFQURZX1NFVF9LRVkgPSBzYXZlZEE7XG5cdFx0cm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHR9KTtcblxuXHRwcm9jZXNzLmVudi5BTFJFQURZX1NFVF9LRVkgPSBcInByZXNlbnRcIjtcblxuXHRjb25zdCBtYW5pZmVzdCA9IG1ha2VNYW5pZmVzdChbXG5cdFx0eyBrZXk6IFwiQUxSRUFEWV9TRVRfS0VZXCIsIHN0YXR1czogXCJwZW5kaW5nXCIgfSxcblx0XHR7IGtleTogXCJORUVEU19DT0xMRUNUSU9OXCIsIHN0YXR1czogXCJwZW5kaW5nXCIgfSxcblx0XSk7XG5cdGF3YWl0IHdyaXRlTWFuaWZlc3RGaWxlKHRtcCwgbWFuaWZlc3QpO1xuXG5cdGNvbnN0IGNvbGxlY3RlZEtleU5hbWVzOiBzdHJpbmdbXSA9IFtdO1xuXHRsZXQgc3VtbWFyeVNob3duID0gZmFsc2U7XG5cdGNvbnN0IG1vY2tDdHggPSB7XG5cdFx0Y3dkOiB0bXAsXG5cdFx0aGFzVUk6IHRydWUsXG5cdFx0dWk6IHtcblx0XHRcdGN1c3RvbTogYXN5bmMgKGZhY3Rvcnk6IGFueSkgPT4ge1xuXHRcdFx0XHQvLyBJbnRlcmNlcHQgdGhlIGZhY3RvcnkgdG8gY2hlY2sgd2hhdCBrZXkgaXMgYmVpbmcgY29sbGVjdGVkXG5cdFx0XHRcdGlmICghc3VtbWFyeVNob3duKSB7XG5cdFx0XHRcdFx0c3VtbWFyeVNob3duID0gdHJ1ZTtcblx0XHRcdFx0XHRyZXR1cm4gbnVsbDsgLy8gZGlzbWlzcyBzdW1tYXJ5XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29sbGVjdGVkS2V5TmFtZXMucHVzaChcInByb21wdGVkXCIpO1xuXHRcdFx0XHRyZXR1cm4gXCJtb2NrLXZhbHVlXCI7XG5cdFx0XHR9LFxuXHRcdH0sXG5cdH07XG5cblx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgY29sbGVjdFNlY3JldHNGcm9tTWFuaWZlc3QodG1wLCBcIk0wMDFcIiwgbW9ja0N0eCBhcyBhbnkpO1xuXG5cdC8vIEFMUkVBRFlfU0VUX0tFWSBzaG91bGQgbm90IGhhdmUgYmVlbiBwcm9tcHRlZCBcdTIwMTQgb25seSBORUVEU19DT0xMRUNUSU9OIHNob3VsZFxuXHRhc3NlcnQub2soIXJlc3VsdC5hcHBsaWVkLmluY2x1ZGVzKFwiQUxSRUFEWV9TRVRfS0VZXCIpLFxuXHRcdFwiQUxSRUFEWV9TRVRfS0VZIHNob3VsZCBub3QgYmUgaW4gYXBwbGllZCAoaXQgd2FzIGF1dG8tc2tpcHBlZClcIik7XG5cdGFzc2VydC5vayhyZXN1bHQuZXhpc3RpbmdTa2lwcGVkPy5pbmNsdWRlcyhcIkFMUkVBRFlfU0VUX0tFWVwiKSxcblx0XHRcIkFMUkVBRFlfU0VUX0tFWSBzaG91bGQgYmUgaW4gZXhpc3RpbmdTa2lwcGVkXCIpO1xufSk7XG5cbnRlc3QoXCJjb2xsZWN0U2VjcmV0c0Zyb21NYW5pZmVzdDogbWFuaWZlc3Qgc3RhdHVzZXMgYXJlIHVwZGF0ZWQgYWZ0ZXIgY29sbGVjdGlvblwiLCBhc3luYyAodCkgPT4ge1xuXHRjb25zdCB7IGNvbGxlY3RTZWNyZXRzRnJvbU1hbmlmZXN0IH0gPSBhd2FpdCBsb2FkT3JjaGVzdHJhdG9yKCk7XG5cblx0Y29uc3QgdG1wID0gbWFrZVRlbXBEaXIoXCJtYW5pZmVzdC11cGRhdGVcIik7XG5cdHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuXHRjb25zdCBtYW5pZmVzdCA9IG1ha2VNYW5pZmVzdChbXG5cdFx0eyBrZXk6IFwiS0VZX1RPX0NPTExFQ1RcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiB9LFxuXHRcdHsga2V5OiBcIktFWV9UT19TS0lQXCIsIHN0YXR1czogXCJwZW5kaW5nXCIgfSxcblx0XSk7XG5cdGNvbnN0IG1hbmlmZXN0UGF0aCA9IGF3YWl0IHdyaXRlTWFuaWZlc3RGaWxlKHRtcCwgbWFuaWZlc3QpO1xuXG5cdGxldCBjYWxsSW5kZXggPSAwO1xuXHRjb25zdCBtb2NrQ3R4ID0ge1xuXHRcdGN3ZDogdG1wLFxuXHRcdGhhc1VJOiB0cnVlLFxuXHRcdHVpOiB7XG5cdFx0XHRjdXN0b206IGFzeW5jIChfZmFjdG9yeTogYW55KSA9PiB7XG5cdFx0XHRcdGNhbGxJbmRleCsrO1xuXHRcdFx0XHRpZiAoY2FsbEluZGV4IDw9IDEpIHJldHVybiBudWxsOyAvLyBzdW1tYXJ5IHNjcmVlbiBkaXNtaXNzXG5cdFx0XHRcdGlmIChjYWxsSW5kZXggPT09IDIpIHJldHVybiBcInNlY3JldC12YWx1ZVwiOyAvLyBLRVlfVE9fQ09MTEVDVFxuXHRcdFx0XHRyZXR1cm4gbnVsbDsgLy8gS0VZX1RPX1NLSVAgXHUyMDE0IHVzZXIgc2tpcHNcblx0XHRcdH0sXG5cdFx0fSxcblx0fTtcblxuXHRhd2FpdCBjb2xsZWN0U2VjcmV0c0Zyb21NYW5pZmVzdCh0bXAsIFwiTTAwMVwiLCBtb2NrQ3R4IGFzIGFueSk7XG5cblx0Ly8gUmVhZCBiYWNrIHRoZSBtYW5pZmVzdCBmaWxlIGFuZCB2ZXJpZnkgc3RhdHVzZXMgd2VyZSB1cGRhdGVkXG5cdGNvbnN0IHsgcGFyc2VTZWNyZXRzTWFuaWZlc3QgfSA9IGF3YWl0IGxvYWRGaWxlc0V4cG9ydHMoKTtcblx0Y29uc3QgdXBkYXRlZENvbnRlbnQgPSByZWFkRmlsZVN5bmMobWFuaWZlc3RQYXRoLCBcInV0ZjhcIik7XG5cdGNvbnN0IHVwZGF0ZWRNYW5pZmVzdCA9IHBhcnNlU2VjcmV0c01hbmlmZXN0KHVwZGF0ZWRDb250ZW50KTtcblxuXHRjb25zdCBrZXlUb0NvbGxlY3QgPSB1cGRhdGVkTWFuaWZlc3QuZW50cmllcy5maW5kKGUgPT4gZS5rZXkgPT09IFwiS0VZX1RPX0NPTExFQ1RcIik7XG5cdGNvbnN0IGtleVRvU2tpcCA9IHVwZGF0ZWRNYW5pZmVzdC5lbnRyaWVzLmZpbmQoZSA9PiBlLmtleSA9PT0gXCJLRVlfVE9fU0tJUFwiKTtcblxuXHRhc3NlcnQuZXF1YWwoa2V5VG9Db2xsZWN0Py5zdGF0dXMsIFwiY29sbGVjdGVkXCIsXG5cdFx0XCJLRVlfVE9fQ09MTEVDVCBzaG91bGQgaGF2ZSBzdGF0dXMgJ2NvbGxlY3RlZCcgYWZ0ZXIgcHJvdmlkaW5nIGEgdmFsdWVcIik7XG5cdGFzc2VydC5lcXVhbChrZXlUb1NraXA/LnN0YXR1cywgXCJza2lwcGVkXCIsXG5cdFx0XCJLRVlfVE9fU0tJUCBzaG91bGQgaGF2ZSBzdGF0dXMgJ3NraXBwZWQnIGFmdGVyIHVzZXIgc2tpcHBlZCBpdFwiKTtcbn0pO1xuXG50ZXN0KFwiY29sbGVjdFNlY3JldHNGcm9tTWFuaWZlc3Q6IGFwcGxpZWQga2V5cyBoeWRyYXRlIHByb2Nlc3MuZW52IGZvciB0aGUgcnVubmluZyBzZXNzaW9uXCIsIGFzeW5jICh0KSA9PiB7XG5cdGNvbnN0IHsgY29sbGVjdFNlY3JldHNGcm9tTWFuaWZlc3QgfSA9IGF3YWl0IGxvYWRPcmNoZXN0cmF0b3IoKTtcblxuXHRjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcIm1hbmlmZXN0LWxpdmUtZW52XCIpO1xuXHRjb25zdCBlbnZLZXkgPSBcIkNPTlRFWFQ3X0FQSV9LRVlcIjtcblx0Y29uc3Qgc2F2ZWQgPSBwcm9jZXNzLmVudltlbnZLZXldO1xuXHR0LmFmdGVyKCgpID0+IHtcblx0XHRpZiAoc2F2ZWQgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52W2VudktleV07XG5cdFx0ZWxzZSBwcm9jZXNzLmVudltlbnZLZXldID0gc2F2ZWQ7XG5cdFx0cm1TeW5jKHRtcCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHR9KTtcblxuXHRkZWxldGUgcHJvY2Vzcy5lbnZbZW52S2V5XTtcblxuXHRjb25zdCBtYW5pZmVzdCA9IG1ha2VNYW5pZmVzdChbXG5cdFx0eyBrZXk6IGVudktleSwgc3RhdHVzOiBcInBlbmRpbmdcIiB9LFxuXHRdKTtcblx0YXdhaXQgd3JpdGVNYW5pZmVzdEZpbGUodG1wLCBtYW5pZmVzdCk7XG5cblx0bGV0IGNhbGxJbmRleCA9IDA7XG5cdGNvbnN0IG1vY2tDdHggPSB7XG5cdFx0Y3dkOiB0bXAsXG5cdFx0aGFzVUk6IHRydWUsXG5cdFx0dWk6IHtcblx0XHRcdGN1c3RvbTogYXN5bmMgKF9mYWN0b3J5OiBhbnkpID0+IHtcblx0XHRcdFx0Y2FsbEluZGV4Kys7XG5cdFx0XHRcdGlmIChjYWxsSW5kZXggPD0gMSkgcmV0dXJuIG51bGw7IC8vIHN1bW1hcnkgc2NyZWVuIGRpc21pc3Ncblx0XHRcdFx0cmV0dXJuIFwiYzdfbGl2ZV90ZXN0X2tleVwiO1xuXHRcdFx0fSxcblx0XHR9LFxuXHR9O1xuXG5cdGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNvbGxlY3RTZWNyZXRzRnJvbU1hbmlmZXN0KHRtcCwgXCJNMDAxXCIsIG1vY2tDdHggYXMgYW55KTtcblxuXHRhc3NlcnQub2socmVzdWx0LmFwcGxpZWQuaW5jbHVkZXMoZW52S2V5KSwgXCJDT05URVhUN19BUElfS0VZIHNob3VsZCBiZSBhcHBsaWVkXCIpO1xuXHRhc3NlcnQuZXF1YWwocHJvY2Vzcy5lbnZbZW52S2V5XSwgXCJjN19saXZlX3Rlc3Rfa2V5XCIsXG5cdFx0XCJhcHBsaWVkIGtleXMgc2hvdWxkIGJlIGF2YWlsYWJsZSB0aHJvdWdoIHByb2Nlc3MuZW52IHdpdGhvdXQgcmVzdGFydGluZ1wiKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgc2hvd1NlY3JldHNTdW1tYXJ5OiByZW5kZXIgb3V0cHV0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwic2hvd1NlY3JldHNTdW1tYXJ5OiBwcm9kdWNlcyBsaW5lcyB3aXRoIGNvcnJlY3Qgc3RhdHVzIGdseXBocyBmb3IgZWFjaCBlbnRyeSBzdGF0dXNcIiwgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCB7IHNob3dTZWNyZXRzU3VtbWFyeSB9ID0gYXdhaXQgbG9hZE9yY2hlc3RyYXRvcigpO1xuXG5cdGNvbnN0IGVudHJpZXM6IFNlY3JldHNNYW5pZmVzdEVudHJ5W10gPSBbXG5cdFx0eyBrZXk6IFwiUEVORElOR19LRVlcIiwgc2VydmljZTogXCJTdmNcIiwgZGFzaGJvYXJkVXJsOiBcIlwiLCBndWlkYW5jZTogW10sIGZvcm1hdEhpbnQ6IFwiXCIsIHN0YXR1czogXCJwZW5kaW5nXCIsIGRlc3RpbmF0aW9uOiBcImRvdGVudlwiIH0sXG5cdFx0eyBrZXk6IFwiQ09MTEVDVEVEX0tFWVwiLCBzZXJ2aWNlOiBcIlN2Y1wiLCBkYXNoYm9hcmRVcmw6IFwiXCIsIGd1aWRhbmNlOiBbXSwgZm9ybWF0SGludDogXCJcIiwgc3RhdHVzOiBcImNvbGxlY3RlZFwiLCBkZXN0aW5hdGlvbjogXCJkb3RlbnZcIiB9LFxuXHRcdHsga2V5OiBcIlNLSVBQRURfS0VZXCIsIHNlcnZpY2U6IFwiU3ZjXCIsIGRhc2hib2FyZFVybDogXCJcIiwgZ3VpZGFuY2U6IFtdLCBmb3JtYXRIaW50OiBcIlwiLCBzdGF0dXM6IFwic2tpcHBlZFwiLCBkZXN0aW5hdGlvbjogXCJkb3RlbnZcIiB9LFxuXHRdO1xuXG5cdC8vIHNob3dTZWNyZXRzU3VtbWFyeSByZW5kZXJzIGEgY3R4LnVpLmN1c3RvbSBzY3JlZW4uIFdlIGNhcHR1cmUgdGhlIHJlbmRlciBvdXRwdXQuXG5cdGxldCByZW5kZXJGbjogKCh3aWR0aDogbnVtYmVyKSA9PiBzdHJpbmdbXSkgfCB1bmRlZmluZWQ7XG5cdGNvbnN0IG1vY2tDdHggPSB7XG5cdFx0aGFzVUk6IHRydWUsXG5cdFx0dWk6IHtcblx0XHRcdGN1c3RvbTogYXN5bmMgKGZhY3Rvcnk6IGFueSkgPT4ge1xuXHRcdFx0XHRjb25zdCBtb2NrVGhlbWUgPSB7XG5cdFx0XHRcdFx0Zmc6IChfY29sb3I6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdFx0XHRcdGJvbGQ6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0XHRcdH07XG5cdFx0XHRcdGNvbnN0IG1vY2tUdWkgPSB7IHJlcXVlc3RSZW5kZXI6ICgpID0+IHt9LCB0ZXJtaW5hbDogeyByb3dzOiAyNCwgY29sdW1uczogODAgfSB9O1xuXHRcdFx0XHRjb25zdCBjb21wb25lbnQgPSBmYWN0b3J5KG1vY2tUdWksIG1vY2tUaGVtZSwge30sICgpID0+IHt9KTtcblx0XHRcdFx0cmVuZGVyRm4gPSBjb21wb25lbnQucmVuZGVyO1xuXHRcdFx0XHQvLyBTaW11bGF0ZSBpbW1lZGlhdGUgZGlzbWlzc1xuXHRcdFx0XHRjb21wb25lbnQuaGFuZGxlSW5wdXQoXCJcXHgxYlwiKTsgLy8gZXNjYXBlXG5cdFx0XHR9LFxuXHRcdH0sXG5cdH07XG5cblx0YXdhaXQgc2hvd1NlY3JldHNTdW1tYXJ5KG1vY2tDdHggYXMgYW55LCBlbnRyaWVzLCBbXSk7XG5cblx0YXNzZXJ0Lm9rKHJlbmRlckZuLCBcInJlbmRlciBmdW5jdGlvbiBzaG91bGQgaGF2ZSBiZWVuIGNhcHR1cmVkIGZyb20gZmFjdG9yeVwiKTtcblx0Y29uc3QgbGluZXMgPSByZW5kZXJGbiEoODApO1xuXG5cdC8vIFZlcmlmeSBlYWNoIGtleSBhcHBlYXJzIGluIHRoZSBvdXRwdXRcblx0Y29uc3Qgb3V0cHV0ID0gbGluZXMuam9pbihcIlxcblwiKTtcblx0YXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIlBFTkRJTkdfS0VZXCIpLCBcInNob3VsZCBpbmNsdWRlIFBFTkRJTkdfS0VZXCIpO1xuXHRhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiQ09MTEVDVEVEX0tFWVwiKSwgXCJzaG91bGQgaW5jbHVkZSBDT0xMRUNURURfS0VZXCIpO1xuXHRhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiU0tJUFBFRF9LRVlcIiksIFwic2hvdWxkIGluY2x1ZGUgU0tJUFBFRF9LRVlcIik7XG5cblx0Ly8gVmVyaWZ5IHdlIGhhdmUgYXQgbGVhc3Qgb25lIGxpbmUgcGVyIGVudHJ5IHBsdXMgaGVhZGVyL2Zvb3RlclxuXHRhc3NlcnQub2sobGluZXMubGVuZ3RoID49IDUsIGBzaG91bGQgaGF2ZSBhdCBsZWFzdCA1IGxpbmVzIChnb3QgJHtsaW5lcy5sZW5ndGh9KWApO1xufSk7XG5cbnRlc3QoXCJzaG93U2VjcmV0c1N1bW1hcnk6IGV4aXN0aW5nIGtleXMgc2hvd24gd2l0aCBkaXN0aW5jdCBzdGF0dXMgaW5kaWNhdG9yXCIsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgeyBzaG93U2VjcmV0c1N1bW1hcnkgfSA9IGF3YWl0IGxvYWRPcmNoZXN0cmF0b3IoKTtcblxuXHRjb25zdCBlbnRyaWVzOiBTZWNyZXRzTWFuaWZlc3RFbnRyeVtdID0gW1xuXHRcdHsga2V5OiBcIk5FV19LRVlcIiwgc2VydmljZTogXCJTdmNcIiwgZGFzaGJvYXJkVXJsOiBcIlwiLCBndWlkYW5jZTogW10sIGZvcm1hdEhpbnQ6IFwiXCIsIHN0YXR1czogXCJwZW5kaW5nXCIsIGRlc3RpbmF0aW9uOiBcImRvdGVudlwiIH0sXG5cdFx0eyBrZXk6IFwiT0xEX0tFWVwiLCBzZXJ2aWNlOiBcIlN2Y1wiLCBkYXNoYm9hcmRVcmw6IFwiXCIsIGd1aWRhbmNlOiBbXSwgZm9ybWF0SGludDogXCJcIiwgc3RhdHVzOiBcImNvbGxlY3RlZFwiLCBkZXN0aW5hdGlvbjogXCJkb3RlbnZcIiB9LFxuXHRdO1xuXHRjb25zdCBleGlzdGluZ0tleXMgPSBbXCJPTERfS0VZXCJdO1xuXG5cdGxldCByZW5kZXJGbjogKCh3aWR0aDogbnVtYmVyKSA9PiBzdHJpbmdbXSkgfCB1bmRlZmluZWQ7XG5cdGNvbnN0IG1vY2tDdHggPSB7XG5cdFx0aGFzVUk6IHRydWUsXG5cdFx0dWk6IHtcblx0XHRcdGN1c3RvbTogYXN5bmMgKGZhY3Rvcnk6IGFueSkgPT4ge1xuXHRcdFx0XHRjb25zdCBtb2NrVGhlbWUgPSB7XG5cdFx0XHRcdFx0Zmc6IChfY29sb3I6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdFx0XHRcdGJvbGQ6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0XHRcdH07XG5cdFx0XHRcdGNvbnN0IG1vY2tUdWkgPSB7IHJlcXVlc3RSZW5kZXI6ICgpID0+IHt9LCB0ZXJtaW5hbDogeyByb3dzOiAyNCwgY29sdW1uczogODAgfSB9O1xuXHRcdFx0XHRjb25zdCBjb21wb25lbnQgPSBmYWN0b3J5KG1vY2tUdWksIG1vY2tUaGVtZSwge30sICgpID0+IHt9KTtcblx0XHRcdFx0cmVuZGVyRm4gPSBjb21wb25lbnQucmVuZGVyO1xuXHRcdFx0XHRjb21wb25lbnQuaGFuZGxlSW5wdXQoXCJcXHgxYlwiKTtcblx0XHRcdH0sXG5cdFx0fSxcblx0fTtcblxuXHRhd2FpdCBzaG93U2VjcmV0c1N1bW1hcnkobW9ja0N0eCBhcyBhbnksIGVudHJpZXMsIGV4aXN0aW5nS2V5cyk7XG5cblx0YXNzZXJ0Lm9rKHJlbmRlckZuLCBcInJlbmRlciBmdW5jdGlvbiBzaG91bGQgaGF2ZSBiZWVuIGNhcHR1cmVkXCIpO1xuXHRjb25zdCBsaW5lcyA9IHJlbmRlckZuISg4MCk7XG5cdGNvbnN0IG91dHB1dCA9IGxpbmVzLmpvaW4oXCJcXG5cIik7XG5cblx0YXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIk5FV19LRVlcIiksIFwic2hvdWxkIGluY2x1ZGUgTkVXX0tFWVwiKTtcblx0YXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIk9MRF9LRVlcIiksIFwic2hvdWxkIGluY2x1ZGUgT0xEX0tFWVwiKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgY29sbGVjdE9uZVNlY3JldDogZ3VpZGFuY2UgcmVuZGVyaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiY29sbGVjdE9uZVNlY3JldDogZ3VpZGFuY2UgbGluZXMgYXBwZWFyIGluIHJlbmRlciBvdXRwdXQgd2hlbiBndWlkYW5jZSBpcyBwcm92aWRlZFwiLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHsgY29sbGVjdE9uZVNlY3JldFdpdGhHdWlkYW5jZSB9ID0gYXdhaXQgbG9hZEd1aWRhbmNlRXhwb3J0KCk7XG5cblx0Y29uc3QgZ3VpZGFuY2VTdGVwcyA9IFtcblx0XHRcIk5hdmlnYXRlIHRvIGh0dHBzOi8vcGxhdGZvcm0ub3BlbmFpLmNvbS9hcGkta2V5c1wiLFxuXHRcdFwiQ2xpY2sgJ0NyZWF0ZSBuZXcgc2VjcmV0IGtleSdcIixcblx0XHRcIkNvcHkgdGhlIGtleSB2YWx1ZVwiLFxuXHRdO1xuXG5cdC8vIFVzZSB0aGUgZXhwb3J0ZWQgdGVzdCBoZWxwZXIgdG8gY2FwdHVyZSByZW5kZXIgb3V0cHV0IHdpdGggZ3VpZGFuY2Vcblx0bGV0IHJlbmRlckZuOiAoKHdpZHRoOiBudW1iZXIpID0+IHN0cmluZ1tdKSB8IHVuZGVmaW5lZDtcblx0Y29uc3QgbW9ja0N0eCA9IHtcblx0XHRoYXNVSTogdHJ1ZSxcblx0XHR1aToge1xuXHRcdFx0Y3VzdG9tOiBhc3luYyAoZmFjdG9yeTogYW55KSA9PiB7XG5cdFx0XHRcdGNvbnN0IG1vY2tUaGVtZSA9IHtcblx0XHRcdFx0XHRmZzogKF9jb2xvcjogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0XHRcdFx0Ym9sZDogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRcdFx0fTtcblx0XHRcdFx0Y29uc3QgbW9ja1R1aSA9IHsgcmVxdWVzdFJlbmRlcjogKCkgPT4ge30sIHRlcm1pbmFsOiB7IHJvd3M6IDI0LCBjb2x1bW5zOiA4MCB9IH07XG5cdFx0XHRcdGNvbnN0IGNvbXBvbmVudCA9IGZhY3RvcnkobW9ja1R1aSwgbW9ja1RoZW1lLCB7fSwgKCkgPT4ge30pO1xuXHRcdFx0XHRyZW5kZXJGbiA9IGNvbXBvbmVudC5yZW5kZXI7XG5cdFx0XHRcdGNvbXBvbmVudC5oYW5kbGVJbnB1dChcIlxceDFiXCIpOyAvLyBlc2NhcGUgdG8gZGlzbWlzc1xuXHRcdFx0fSxcblx0XHR9LFxuXHR9O1xuXG5cdGF3YWl0IGNvbGxlY3RPbmVTZWNyZXRXaXRoR3VpZGFuY2UobW9ja0N0eCwgMCwgMSwgXCJPUEVOQUlfQVBJX0tFWVwiLCBcInN0YXJ0cyB3aXRoIHNrLVwiLCBndWlkYW5jZVN0ZXBzKTtcblxuXHRhc3NlcnQub2socmVuZGVyRm4sIFwicmVuZGVyIGZ1bmN0aW9uIHNob3VsZCBoYXZlIGJlZW4gY2FwdHVyZWRcIik7XG5cdGNvbnN0IGxpbmVzID0gcmVuZGVyRm4hKDgwKTtcblx0Y29uc3Qgb3V0cHV0ID0gbGluZXMuam9pbihcIlxcblwiKTtcblxuXHQvLyBWZXJpZnkgZ3VpZGFuY2Ugc3RlcHMgYXBwZWFyIGluIHRoZSBvdXRwdXRcblx0YXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIk5hdmlnYXRlIHRvXCIpLCBcInNob3VsZCBpbmNsdWRlIGZpcnN0IGd1aWRhbmNlIHN0ZXBcIik7XG5cdGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCJDcmVhdGUgbmV3IHNlY3JldCBrZXlcIiksIFwic2hvdWxkIGluY2x1ZGUgc2Vjb25kIGd1aWRhbmNlIHN0ZXBcIik7XG5cdGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCJDb3B5IHRoZSBrZXkgdmFsdWVcIiksIFwic2hvdWxkIGluY2x1ZGUgdGhpcmQgZ3VpZGFuY2Ugc3RlcFwiKTtcbn0pO1xuXG50ZXN0KFwiY29sbGVjdE9uZVNlY3JldDogZ3VpZGFuY2UgbGluZXMgd3JhcCBsb25nIFVSTHMgaW5zdGVhZCBvZiB0cnVuY2F0aW5nXCIsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgeyBjb2xsZWN0T25lU2VjcmV0V2l0aEd1aWRhbmNlIH0gPSBhd2FpdCBsb2FkR3VpZGFuY2VFeHBvcnQoKTtcblxuXHRjb25zdCBsb25nR3VpZGFuY2UgPSBbXG5cdFx0XCJOYXZpZ2F0ZSB0byBodHRwczovL3BsYXRmb3JtLm9wZW5haS5jb20vYWNjb3VudC9hcGkta2V5cyBhbmQgY2xpY2sgJ0NyZWF0ZSBuZXcgc2VjcmV0IGtleSdcIixcblx0XTtcblxuXHRsZXQgcmVuZGVyRm46ICgod2lkdGg6IG51bWJlcikgPT4gc3RyaW5nW10pIHwgdW5kZWZpbmVkO1xuXHRjb25zdCBtb2NrQ3R4ID0ge1xuXHRcdGhhc1VJOiB0cnVlLFxuXHRcdHVpOiB7XG5cdFx0XHRjdXN0b206IGFzeW5jIChmYWN0b3J5OiBhbnkpID0+IHtcblx0XHRcdFx0Y29uc3QgbW9ja1RoZW1lID0ge1xuXHRcdFx0XHRcdGZnOiAoX2NvbG9yOiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRcdFx0XHRib2xkOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdFx0XHR9O1xuXHRcdFx0XHRjb25zdCBtb2NrVHVpID0geyByZXF1ZXN0UmVuZGVyOiAoKSA9PiB7fSwgdGVybWluYWw6IHsgcm93czogMjQsIGNvbHVtbnM6IDgwIH0gfTtcblx0XHRcdFx0Y29uc3QgY29tcG9uZW50ID0gZmFjdG9yeShtb2NrVHVpLCBtb2NrVGhlbWUsIHt9LCAoKSA9PiB7fSk7XG5cdFx0XHRcdHJlbmRlckZuID0gY29tcG9uZW50LnJlbmRlcjtcblx0XHRcdFx0Y29tcG9uZW50LmhhbmRsZUlucHV0KFwiXFx4MWJcIik7XG5cdFx0XHR9LFxuXHRcdH0sXG5cdH07XG5cblx0YXdhaXQgY29sbGVjdE9uZVNlY3JldFdpdGhHdWlkYW5jZShtb2NrQ3R4LCAwLCAxLCBcIlRFU1RfS0VZXCIsIHVuZGVmaW5lZCwgbG9uZ0d1aWRhbmNlKTtcblxuXHRhc3NlcnQub2socmVuZGVyRm4sIFwicmVuZGVyIGZ1bmN0aW9uIHNob3VsZCBoYXZlIGJlZW4gY2FwdHVyZWRcIik7XG5cdC8vIFJlbmRlciBhdCBuYXJyb3cgd2lkdGggdG8gZm9yY2Ugd3JhcHBpbmdcblx0Y29uc3QgbGluZXMgPSByZW5kZXJGbiEoNTApO1xuXHRjb25zdCBvdXRwdXQgPSBsaW5lcy5qb2luKFwiXFxuXCIpO1xuXG5cdC8vIFRoZSBmdWxsIFVSTCBzaG91bGQgYmUgcHJlc2VudCAod3JhcHBlZCwgbm90IHRydW5jYXRlZClcblx0YXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcInBsYXRmb3JtLm9wZW5haS5jb21cIiksIFwiVVJMIHNob3VsZCBub3QgYmUgdHJ1bmNhdGVkXCIpO1xuXHRhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiQ3JlYXRlIG5ldyBzZWNyZXQga2V5XCIpLCBcInRleHQgYWZ0ZXIgVVJMIHNob3VsZCBub3QgYmUgdHJ1bmNhdGVkXCIpO1xufSk7XG5cbnRlc3QoXCJjb2xsZWN0T25lU2VjcmV0OiBubyBndWlkYW5jZSBwcm92aWRlZCBcdTIwMTQgcmVuZGVyIG91dHB1dCBoYXMgbm8gZ3VpZGFuY2Ugc2VjdGlvblwiLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHsgY29sbGVjdE9uZVNlY3JldFdpdGhHdWlkYW5jZSB9ID0gYXdhaXQgbG9hZEd1aWRhbmNlRXhwb3J0KCk7XG5cblx0bGV0IHJlbmRlckZuOiAoKHdpZHRoOiBudW1iZXIpID0+IHN0cmluZ1tdKSB8IHVuZGVmaW5lZDtcblx0Y29uc3QgbW9ja0N0eCA9IHtcblx0XHRoYXNVSTogdHJ1ZSxcblx0XHR1aToge1xuXHRcdFx0Y3VzdG9tOiBhc3luYyAoZmFjdG9yeTogYW55KSA9PiB7XG5cdFx0XHRcdGNvbnN0IG1vY2tUaGVtZSA9IHtcblx0XHRcdFx0XHRmZzogKF9jb2xvcjogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG5cdFx0XHRcdFx0Ym9sZDogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcblx0XHRcdFx0fTtcblx0XHRcdFx0Y29uc3QgbW9ja1R1aSA9IHsgcmVxdWVzdFJlbmRlcjogKCkgPT4ge30sIHRlcm1pbmFsOiB7IHJvd3M6IDI0LCBjb2x1bW5zOiA4MCB9IH07XG5cdFx0XHRcdGNvbnN0IGNvbXBvbmVudCA9IGZhY3RvcnkobW9ja1R1aSwgbW9ja1RoZW1lLCB7fSwgKCkgPT4ge30pO1xuXHRcdFx0XHRyZW5kZXJGbiA9IGNvbXBvbmVudC5yZW5kZXI7XG5cdFx0XHRcdGNvbXBvbmVudC5oYW5kbGVJbnB1dChcIlxceDFiXCIpO1xuXHRcdFx0fSxcblx0XHR9LFxuXHR9O1xuXG5cdC8vIENhbGwgd2l0aG91dCBndWlkYW5jZSAodW5kZWZpbmVkKVxuXHRhd2FpdCBjb2xsZWN0T25lU2VjcmV0V2l0aEd1aWRhbmNlKG1vY2tDdHgsIDAsIDEsIFwiU09NRV9LRVlcIiwgXCJoaW50IHRleHRcIiwgdW5kZWZpbmVkKTtcblxuXHRhc3NlcnQub2socmVuZGVyRm4sIFwicmVuZGVyIGZ1bmN0aW9uIHNob3VsZCBoYXZlIGJlZW4gY2FwdHVyZWRcIik7XG5cdGNvbnN0IGxpbmVzID0gcmVuZGVyRm4hKDgwKTtcblx0Y29uc3Qgb3V0cHV0ID0gbGluZXMuam9pbihcIlxcblwiKTtcblxuXHQvLyBTaG91bGQgaW5jbHVkZSB0aGUga2V5IG5hbWUgYW5kIGhpbnQgYnV0IG5vIG51bWJlcmVkIGd1aWRhbmNlIHN0ZXBzXG5cdGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCJTT01FX0tFWVwiKSwgXCJzaG91bGQgaW5jbHVkZSBrZXkgbmFtZVwiKTtcblx0YXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcImhpbnQgdGV4dFwiKSwgXCJzaG91bGQgaW5jbHVkZSBoaW50XCIpO1xuXHQvLyBTaG91bGQgTk9UIGhhdmUgbnVtYmVyZWQgc3RlcCBpbmRpY2F0b3JzICgxLiwgMi4sIGV0Yy4pIGZvciBndWlkYW5jZVxuXHRhc3NlcnQub2soIW91dHB1dC5tYXRjaCgvXlxccyoxXFwuXFxzL20pLCBcInNob3VsZCBub3QgaGF2ZSBudW1iZXJlZCBndWlkYW5jZSBzdGVwcyB3aGVuIG5vIGd1aWRhbmNlIHByb3ZpZGVkXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBjb2xsZWN0U2VjcmV0c0Zyb21NYW5pZmVzdDogcmV0dXJucyBzdHJ1Y3R1cmVkIHJlc3VsdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImNvbGxlY3RTZWNyZXRzRnJvbU1hbmlmZXN0OiByZXR1cm5zIHJlc3VsdCB3aXRoIGFwcGxpZWQsIHNraXBwZWQsIGFuZCBleGlzdGluZ1NraXBwZWQgYXJyYXlzXCIsIGFzeW5jICh0KSA9PiB7XG5cdGNvbnN0IHsgY29sbGVjdFNlY3JldHNGcm9tTWFuaWZlc3QgfSA9IGF3YWl0IGxvYWRPcmNoZXN0cmF0b3IoKTtcblxuXHRjb25zdCB0bXAgPSBtYWtlVGVtcERpcihcIm1hbmlmZXN0LXJlc3VsdFwiKTtcblx0Y29uc3Qgc2F2ZWRLZXkgPSBwcm9jZXNzLmVudi5SRVNVTFRfVEVTVF9FWElTVElORztcblx0dC5hZnRlcigoKSA9PiB7XG5cdFx0ZGVsZXRlIHByb2Nlc3MuZW52LlJFU1VMVF9URVNUX0VYSVNUSU5HO1xuXHRcdGlmIChzYXZlZEtleSAhPT0gdW5kZWZpbmVkKSBwcm9jZXNzLmVudi5SRVNVTFRfVEVTVF9FWElTVElORyA9IHNhdmVkS2V5O1xuXHRcdHJtU3luYyh0bXAsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0fSk7XG5cblx0cHJvY2Vzcy5lbnYuUkVTVUxUX1RFU1RfRVhJU1RJTkcgPSBcImFscmVhZHktaGVyZVwiO1xuXG5cdGNvbnN0IG1hbmlmZXN0ID0gbWFrZU1hbmlmZXN0KFtcblx0XHR7IGtleTogXCJSRVNVTFRfVEVTVF9FWElTVElOR1wiLCBzdGF0dXM6IFwicGVuZGluZ1wiIH0sXG5cdFx0eyBrZXk6IFwiUkVTVUxUX1RFU1RfTkVXXCIsIHN0YXR1czogXCJwZW5kaW5nXCIgfSxcblx0XSk7XG5cdGF3YWl0IHdyaXRlTWFuaWZlc3RGaWxlKHRtcCwgbWFuaWZlc3QpO1xuXG5cdGxldCBjYWxsSW5kZXggPSAwO1xuXHRjb25zdCBtb2NrQ3R4ID0ge1xuXHRcdGN3ZDogdG1wLFxuXHRcdGhhc1VJOiB0cnVlLFxuXHRcdHVpOiB7XG5cdFx0XHRjdXN0b206IGFzeW5jIChfZmFjdG9yeTogYW55KSA9PiB7XG5cdFx0XHRcdGNhbGxJbmRleCsrO1xuXHRcdFx0XHRpZiAoY2FsbEluZGV4IDw9IDEpIHJldHVybiBudWxsOyAvLyBzdW1tYXJ5IGRpc21pc3Ncblx0XHRcdFx0cmV0dXJuIFwic2VjcmV0LXZhbHVlXCI7IC8vIGNvbGxlY3QgdGhlIHBlbmRpbmcga2V5XG5cdFx0XHR9LFxuXHRcdH0sXG5cdH07XG5cblx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgY29sbGVjdFNlY3JldHNGcm9tTWFuaWZlc3QodG1wLCBcIk0wMDFcIiwgbW9ja0N0eCBhcyBhbnkpO1xuXG5cdC8vIFZlcmlmeSByZXN1bHQgc2hhcGVcblx0YXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkocmVzdWx0LmFwcGxpZWQpLCBcInJlc3VsdCBzaG91bGQgaGF2ZSBhcHBsaWVkIGFycmF5XCIpO1xuXHRhc3NlcnQub2soQXJyYXkuaXNBcnJheShyZXN1bHQuc2tpcHBlZCksIFwicmVzdWx0IHNob3VsZCBoYXZlIHNraXBwZWQgYXJyYXlcIik7XG5cdGFzc2VydC5vayhBcnJheS5pc0FycmF5KHJlc3VsdC5leGlzdGluZ1NraXBwZWQpLCBcInJlc3VsdCBzaG91bGQgaGF2ZSBleGlzdGluZ1NraXBwZWQgYXJyYXlcIik7XG5cblx0YXNzZXJ0Lm9rKHJlc3VsdC5leGlzdGluZ1NraXBwZWQuaW5jbHVkZXMoXCJSRVNVTFRfVEVTVF9FWElTVElOR1wiKSxcblx0XHRcImV4aXN0aW5nIGtleSBzaG91bGQgYmUgaW4gZXhpc3RpbmdTa2lwcGVkXCIpO1xuXHRhc3NlcnQub2socmVzdWx0LmFwcGxpZWQuaW5jbHVkZXMoXCJSRVNVTFRfVEVTVF9ORVdcIiksXG5cdFx0XCJjb2xsZWN0ZWQga2V5IHNob3VsZCBiZSBpbiBhcHBsaWVkXCIpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFhQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxlQUFlLGNBQWMsY0FBYztBQUMvRCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBS3ZCLGVBQWUsbUJBR1o7QUFDRixRQUFNLE1BQU0sTUFBTSxPQUFPLGFBQWE7QUFDdEMsU0FBTztBQUFBLElBQ04sdUJBQXVCLElBQUk7QUFBQSxJQUMzQixzQkFBc0IsSUFBSTtBQUFBLEVBQzNCO0FBQ0Q7QUFJQSxTQUFTLFlBQVksUUFBd0I7QUFDNUMsUUFBTSxNQUFNLEtBQUssT0FBTyxHQUFHLEdBQUcsTUFBTSxJQUFJLEtBQUssSUFBSSxDQUFDLElBQUksS0FBSyxPQUFPLEVBQUUsU0FBUyxFQUFFLEVBQUUsTUFBTSxDQUFDLENBQUMsRUFBRTtBQUMzRixZQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNsQyxTQUFPO0FBQ1I7QUFFQSxTQUFTLGFBQWEsU0FBMkQ7QUFDaEYsU0FBTztBQUFBLElBQ04sV0FBVztBQUFBLElBQ1gsYUFBYTtBQUFBLElB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
