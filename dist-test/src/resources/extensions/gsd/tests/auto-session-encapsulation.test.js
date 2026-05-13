import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AutoSession } from "../auto/session.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTO_TS_PATH = join(__dirname, "..", "auto.ts");
const SESSION_TS_PATH = join(__dirname, "..", "auto", "session.ts");
const RUNTIME_STATE_TS_PATH = join(__dirname, "..", "auto-runtime-state.ts");
function getAutoTsSource() {
  return readFileSync(AUTO_TS_PATH, "utf-8");
}
function getSessionTsSource() {
  return readFileSync(SESSION_TS_PATH, "utf-8");
}
function getRuntimeStateTsSource() {
  return readFileSync(RUNTIME_STATE_TS_PATH, "utf-8");
}
test("AutoSession.lockBasePath uses GSD_PROJECT_ROOT for symlink-resolved worktrees", () => {
  const savedProjectRoot = process.env.GSD_PROJECT_ROOT;
  process.env.GSD_PROJECT_ROOT = "/real/project";
  try {
    const session = new AutoSession();
    session.basePath = "/Users/dev/.gsd/projects/abc123/worktrees/M001/slices/S01";
    assert.equal(session.lockBasePath, "/real/project");
  } finally {
    if (savedProjectRoot === void 0) delete process.env.GSD_PROJECT_ROOT;
    else process.env.GSD_PROJECT_ROOT = savedProjectRoot;
  }
});
test("auto.ts has no module-level let declarations", () => {
  const source = getAutoTsSource();
  const lines = source.split("\n");
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(export\s+)?let\s+/.test(line)) {
      violations.push(`line ${i + 1}: ${line.trim()}`);
    }
  }
  assert.equal(
    violations.length,
    0,
    `auto.ts must not have module-level \`let\` declarations. All mutable state belongs in AutoSession (auto/session.ts).
Violations:
${violations.join("\n")}`
  );
});
test("auto.ts has no module-level var declarations", () => {
  const source = getAutoTsSource();
  const lines = source.split("\n");
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(export\s+)?var\s+/.test(line)) {
      violations.push(`line ${i + 1}: ${line.trim()}`);
    }
  }
  assert.equal(
    violations.length,
    0,
    `auto.ts must not have module-level \`var\` declarations. All mutable state belongs in AutoSession (auto/session.ts).
Violations:
${violations.join("\n")}`
  );
});
test("auto-runtime-state.ts has exactly one module-level const for AutoSession", () => {
  const source = getRuntimeStateTsSource();
  const lines = source.split("\n");
  const sessionConsts = lines.filter(
    (line) => /^(export\s+)?const\s+\w+\s*=\s*new\s+AutoSession/.test(line)
  );
  assert.equal(
    sessionConsts.length,
    1,
    `auto-runtime-state.ts should have exactly one \`const autoSession = new AutoSession()\`. Found ${sessionConsts.length}: ${sessionConsts.join(", ")}`
  );
});
test("AutoSession.reset() references every instance property", () => {
  const source = getSessionTsSource();
  const propertyPattern = /^\s+(readonly\s+)?(\w+)\s*[:=]/;
  const properties = [];
  let inClass = false;
  let inMethod = false;
  let braceDepth = 0;
  for (const line of source.split("\n")) {
    if (/^export class AutoSession/.test(line)) {
      inClass = true;
      braceDepth = 0;
      continue;
    }
    if (!inClass) continue;
    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") braceDepth--;
    }
    if (braceDepth === 1 && !inMethod) {
      const match = line.match(propertyPattern);
      if (match && match[2]) {
        const propName = match[2];
        if (![
          "constructor",
          "clearTimers",
          "resetDispatchCounters",
          "lockBasePath",
          "completeCurrentUnit",
          "reset",
          "toJSON"
        ].includes(propName)) {
          properties.push(propName);
        }
      }
    }
    if (braceDepth === 1 && /^\s+(get |async )?(\w+)\s*\(/.test(line)) {
      inMethod = true;
    }
    if (braceDepth === 1 && inMethod) {
      inMethod = false;
    }
  }
  const resetMatch = source.match(/reset\(\): void \{([\s\S]*?)^\s{2}\}/m);
  assert.ok(resetMatch, "AutoSession.reset() method not found");
  const resetBody = resetMatch[1];
  const intentionallySkipped = /* @__PURE__ */ new Set([]);
  const missingFromReset = [];
  for (const prop of properties) {
    if (intentionallySkipped.has(prop)) continue;
    if (!resetBody.includes(`this.${prop}`)) {
      missingFromReset.push(prop);
    }
  }
  assert.equal(
    missingFromReset.length,
    0,
    `AutoSession.reset() must reference every instance property. Missing: ${missingFromReset.join(", ")}. If a property should persist across resets, add it to the intentionallySkipped set in this test.`
  );
});
test("AutoSession.toJSON() includes key diagnostic properties", () => {
  const source = getSessionTsSource();
  const toJSONMatch = source.match(/toJSON\(\)[\s\S]*?return \{([\s\S]*?)\};/);
  assert.ok(toJSONMatch, "AutoSession.toJSON() method not found");
  const toJSONBody = toJSONMatch[1];
  const requiredDiagnostics = [
    "active",
    "paused",
    "basePath",
    "currentMilestoneId",
    "currentUnit",
    "orchestrationPhase",
    "orchestrationTransitionCount",
    "orchestrationLastTransitionAt"
  ];
  const missing = requiredDiagnostics.filter((prop) => !toJSONBody.includes(prop));
  assert.equal(
    missing.length,
    0,
    `AutoSession.toJSON() must include diagnostic properties: ${missing.join(", ")}`
  );
});
test("auto.ts module-level consts are only AutoSession instance, true constants, or static accessors", () => {
  const source = getAutoTsSource();
  const lines = source.split("\n");
  const violations = [];
  const allowedPatterns = [
    /^const [A-Z_]+\s*=/,
    // UPPER_CASE constants
    /^const \w+StateAccessors/,
    // Static accessor objects
    /^const \w+:\s*\w+\s*=/
    // Typed constants
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^(export\s+)?const\s+/.test(line)) continue;
    const isAllowed = allowedPatterns.some((p) => p.test(line.replace(/^export\s+/, "")));
    if (!isAllowed) {
      if (/= new (Map|Set|Array)\(/.test(line) || /= \[\]/.test(line)) {
        violations.push(`line ${i + 1}: ${line.trim()}`);
      }
    }
  }
  assert.equal(
    violations.length,
    0,
    `auto.ts has module-level const declarations that look like mutable state. Move these into AutoSession:
${violations.join("\n")}`
  );
});
test("auto/session.ts exports AutoSession class", () => {
  const source = getSessionTsSource();
  assert.ok(
    /export class AutoSession/.test(source),
    "auto/session.ts must export the AutoSession class"
  );
});
test("AutoSession has a reset() method", () => {
  const source = getSessionTsSource();
  assert.ok(
    /reset\(\): void/.test(source),
    "AutoSession must have a reset(): void method"
  );
});
test("AutoSession has a toJSON() method", () => {
  const source = getSessionTsSource();
  assert.ok(
    /toJSON\(\)/.test(source),
    "AutoSession must have a toJSON() method for diagnostics"
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLXNlc3Npb24tZW5jYXBzdWxhdGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIGF1dG8tc2Vzc2lvbi1lbmNhcHN1bGF0aW9uLnRlc3QudHMgXHUyMDE0IEd1YXJkcyB0aGUgQXV0b1Nlc3Npb24gZW5jYXBzdWxhdGlvbiBpbnZhcmlhbnQuXG4gKlxuICogQWxsIG11dGFibGUgYXV0by1tb2RlIHN0YXRlIG11c3QgbGl2ZSBpbiBBdXRvU2Vzc2lvbiAoYXV0by9zZXNzaW9uLnRzKS5cbiAqIGF1dG8udHMgbXVzdCBub3QgZGVjbGFyZSBtb2R1bGUtbGV2ZWwgYGxldGAgb3IgYHZhcmAgdmFyaWFibGVzLlxuICpcbiAqIFRoZXNlIHRlc3RzIHBhcnNlIGF1dG8udHMgc291cmNlIHRvIGRldGVjdCB2aW9sYXRpb25zLCBzbyB0aGV5IGZhaWwgYXRcbiAqIHRlc3QgdGltZSBcdTIwMTQgYmVmb3JlIGEgUFIgbWVyZ2VzIFx1MjAxNCB3aGVuIHNvbWVvbmUgYWNjaWRlbnRhbGx5IGFkZHMgbXV0YWJsZVxuICogbW9kdWxlLWxldmVsIHN0YXRlIHRvIGF1dG8udHMgaW5zdGVhZCBvZiBBdXRvU2Vzc2lvbi5cbiAqL1xuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCBkaXJuYW1lIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgQXV0b1Nlc3Npb24gfSBmcm9tIFwiLi4vYXV0by9zZXNzaW9uLnRzXCI7XG5cbmNvbnN0IF9fZGlybmFtZSA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IEFVVE9fVFNfUEFUSCA9IGpvaW4oX19kaXJuYW1lLCBcIi4uXCIsIFwiYXV0by50c1wiKTtcbmNvbnN0IFNFU1NJT05fVFNfUEFUSCA9IGpvaW4oX19kaXJuYW1lLCBcIi4uXCIsIFwiYXV0b1wiLCBcInNlc3Npb24udHNcIik7XG5jb25zdCBSVU5USU1FX1NUQVRFX1RTX1BBVEggPSBqb2luKF9fZGlybmFtZSwgXCIuLlwiLCBcImF1dG8tcnVudGltZS1zdGF0ZS50c1wiKTtcblxuZnVuY3Rpb24gZ2V0QXV0b1RzU291cmNlKCk6IHN0cmluZyB7XG4gIHJldHVybiByZWFkRmlsZVN5bmMoQVVUT19UU19QQVRILCBcInV0Zi04XCIpO1xufVxuXG5mdW5jdGlvbiBnZXRTZXNzaW9uVHNTb3VyY2UoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlYWRGaWxlU3luYyhTRVNTSU9OX1RTX1BBVEgsIFwidXRmLThcIik7XG59XG5cbmZ1bmN0aW9uIGdldFJ1bnRpbWVTdGF0ZVRzU291cmNlKCk6IHN0cmluZyB7XG4gIHJldHVybiByZWFkRmlsZVN5bmMoUlVOVElNRV9TVEFURV9UU19QQVRILCBcInV0Zi04XCIpO1xufVxuXG50ZXN0KFwiQXV0b1Nlc3Npb24ubG9ja0Jhc2VQYXRoIHVzZXMgR1NEX1BST0pFQ1RfUk9PVCBmb3Igc3ltbGluay1yZXNvbHZlZCB3b3JrdHJlZXNcIiwgKCkgPT4ge1xuICBjb25zdCBzYXZlZFByb2plY3RSb290ID0gcHJvY2Vzcy5lbnYuR1NEX1BST0pFQ1RfUk9PVDtcbiAgcHJvY2Vzcy5lbnYuR1NEX1BST0pFQ1RfUk9PVCA9IFwiL3JlYWwvcHJvamVjdFwiO1xuICB0cnkge1xuICAgIGNvbnN0IHNlc3Npb24gPSBuZXcgQXV0b1Nlc3Npb24oKTtcbiAgICBzZXNzaW9uLmJhc2VQYXRoID0gXCIvVXNlcnMvZGV2Ly5nc2QvcHJvamVjdHMvYWJjMTIzL3dvcmt0cmVlcy9NMDAxL3NsaWNlcy9TMDFcIjtcblxuICAgIGFzc2VydC5lcXVhbChzZXNzaW9uLmxvY2tCYXNlUGF0aCwgXCIvcmVhbC9wcm9qZWN0XCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGlmIChzYXZlZFByb2plY3RSb290ID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfUFJPSkVDVF9ST09UO1xuICAgIGVsc2UgcHJvY2Vzcy5lbnYuR1NEX1BST0pFQ1RfUk9PVCA9IHNhdmVkUHJvamVjdFJvb3Q7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgSW52YXJpYW50IDE6IE5vIG1vZHVsZS1sZXZlbCBtdXRhYmxlIHZhcmlhYmxlcyBpbiBhdXRvLnRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiYXV0by50cyBoYXMgbm8gbW9kdWxlLWxldmVsIGxldCBkZWNsYXJhdGlvbnNcIiwgKCkgPT4ge1xuICBjb25zdCBzb3VyY2UgPSBnZXRBdXRvVHNTb3VyY2UoKTtcbiAgY29uc3QgbGluZXMgPSBzb3VyY2Uuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IHZpb2xhdGlvbnM6IHN0cmluZ1tdID0gW107XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGxpbmUgPSBsaW5lc1tpXSE7XG4gICAgLy8gTWF0Y2ggbGluZXMgc3RhcnRpbmcgd2l0aCBgbGV0IGAgb3IgYGV4cG9ydCBsZXQgYCAobW9kdWxlLWxldmVsKVxuICAgIC8vIFNraXAgbGluZXMgaW5zaWRlIGZ1bmN0aW9ucy9ibG9ja3MgKGluZGVudGVkKVxuICAgIGlmICgvXihleHBvcnRcXHMrKT9sZXRcXHMrLy50ZXN0KGxpbmUpKSB7XG4gICAgICB2aW9sYXRpb25zLnB1c2goYGxpbmUgJHtpICsgMX06ICR7bGluZS50cmltKCl9YCk7XG4gICAgfVxuICB9XG5cbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHZpb2xhdGlvbnMubGVuZ3RoLFxuICAgIDAsXG4gICAgYGF1dG8udHMgbXVzdCBub3QgaGF2ZSBtb2R1bGUtbGV2ZWwgXFxgbGV0XFxgIGRlY2xhcmF0aW9ucy4gYCArXG4gICAgYEFsbCBtdXRhYmxlIHN0YXRlIGJlbG9uZ3MgaW4gQXV0b1Nlc3Npb24gKGF1dG8vc2Vzc2lvbi50cykuXFxuYCArXG4gICAgYFZpb2xhdGlvbnM6XFxuJHt2aW9sYXRpb25zLmpvaW4oXCJcXG5cIil9YCxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiYXV0by50cyBoYXMgbm8gbW9kdWxlLWxldmVsIHZhciBkZWNsYXJhdGlvbnNcIiwgKCkgPT4ge1xuICBjb25zdCBzb3VyY2UgPSBnZXRBdXRvVHNTb3VyY2UoKTtcbiAgY29uc3QgbGluZXMgPSBzb3VyY2Uuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IHZpb2xhdGlvbnM6IHN0cmluZ1tdID0gW107XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGxpbmUgPSBsaW5lc1tpXSE7XG4gICAgaWYgKC9eKGV4cG9ydFxccyspP3ZhclxccysvLnRlc3QobGluZSkpIHtcbiAgICAgIHZpb2xhdGlvbnMucHVzaChgbGluZSAke2kgKyAxfTogJHtsaW5lLnRyaW0oKX1gKTtcbiAgICB9XG4gIH1cblxuICBhc3NlcnQuZXF1YWwoXG4gICAgdmlvbGF0aW9ucy5sZW5ndGgsXG4gICAgMCxcbiAgICBgYXV0by50cyBtdXN0IG5vdCBoYXZlIG1vZHVsZS1sZXZlbCBcXGB2YXJcXGAgZGVjbGFyYXRpb25zLiBgICtcbiAgICBgQWxsIG11dGFibGUgc3RhdGUgYmVsb25ncyBpbiBBdXRvU2Vzc2lvbiAoYXV0by9zZXNzaW9uLnRzKS5cXG5gICtcbiAgICBgVmlvbGF0aW9uczpcXG4ke3Zpb2xhdGlvbnMuam9pbihcIlxcblwiKX1gLFxuICApO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBJbnZhcmlhbnQgMjogQXV0b1Nlc3Npb24gc2luZ2xldG9uIGlzIHRoZSBvbmx5IG11dGFibGUgbW9kdWxlLWxldmVsIGJpbmRpbmcgXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJhdXRvLXJ1bnRpbWUtc3RhdGUudHMgaGFzIGV4YWN0bHkgb25lIG1vZHVsZS1sZXZlbCBjb25zdCBmb3IgQXV0b1Nlc3Npb25cIiwgKCkgPT4ge1xuICBjb25zdCBzb3VyY2UgPSBnZXRSdW50aW1lU3RhdGVUc1NvdXJjZSgpO1xuICBjb25zdCBsaW5lcyA9IHNvdXJjZS5zcGxpdChcIlxcblwiKTtcblxuICBjb25zdCBzZXNzaW9uQ29uc3RzID0gbGluZXMuZmlsdGVyKGxpbmUgPT5cbiAgICAvXihleHBvcnRcXHMrKT9jb25zdFxccytcXHcrXFxzKj1cXHMqbmV3XFxzK0F1dG9TZXNzaW9uLy50ZXN0KGxpbmUpLFxuICApO1xuXG4gIGFzc2VydC5lcXVhbChcbiAgICBzZXNzaW9uQ29uc3RzLmxlbmd0aCxcbiAgICAxLFxuICAgIGBhdXRvLXJ1bnRpbWUtc3RhdGUudHMgc2hvdWxkIGhhdmUgZXhhY3RseSBvbmUgXFxgY29uc3QgYXV0b1Nlc3Npb24gPSBuZXcgQXV0b1Nlc3Npb24oKVxcYC4gYCArXG4gICAgYEZvdW5kICR7c2Vzc2lvbkNvbnN0cy5sZW5ndGh9OiAke3Nlc3Npb25Db25zdHMuam9pbihcIiwgXCIpfWAsXG4gICk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIEludmFyaWFudCAzOiBBdXRvU2Vzc2lvbi5yZXNldCgpIGNvdmVycyBhbGwgaW5zdGFuY2UgcHJvcGVydGllcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIkF1dG9TZXNzaW9uLnJlc2V0KCkgcmVmZXJlbmNlcyBldmVyeSBpbnN0YW5jZSBwcm9wZXJ0eVwiLCAoKSA9PiB7XG4gIGNvbnN0IHNvdXJjZSA9IGdldFNlc3Npb25Uc1NvdXJjZSgpO1xuXG4gIC8vIEV4dHJhY3QgcHJvcGVydHkgbmFtZXMgZnJvbSBjbGFzcyBib2R5IChsaW5lcyBsaWtlIGAgIHByb3BOYW1lID0gLi4uYCBvciBgICBwcm9wTmFtZTpgKVxuICAvLyBTa2lwIHJlYWRvbmx5IGNvbGxlY3Rpb25zIChNYXBzL1NldHMpIHRoYXQgdXNlIC5jbGVhcigpIGluc3RlYWQgb2YgcmVhc3NpZ25tZW50XG4gIGNvbnN0IHByb3BlcnR5UGF0dGVybiA9IC9eXFxzKyhyZWFkb25seVxccyspPyhcXHcrKVxccypbOj1dLztcbiAgY29uc3QgcHJvcGVydGllczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGluQ2xhc3MgPSBmYWxzZTtcbiAgbGV0IGluTWV0aG9kID0gZmFsc2U7XG4gIGxldCBicmFjZURlcHRoID0gMDtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2Ygc291cmNlLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKC9eZXhwb3J0IGNsYXNzIEF1dG9TZXNzaW9uLy50ZXN0KGxpbmUpKSB7XG4gICAgICBpbkNsYXNzID0gdHJ1ZTtcbiAgICAgIGJyYWNlRGVwdGggPSAwO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghaW5DbGFzcykgY29udGludWU7XG5cbiAgICAvLyBUcmFjayBicmFjZSBkZXB0aCB0byBkaXN0aW5ndWlzaCBwcm9wZXJ0aWVzIGZyb20gbWV0aG9kIGJvZGllc1xuICAgIGZvciAoY29uc3QgY2ggb2YgbGluZSkge1xuICAgICAgaWYgKGNoID09PSBcIntcIikgYnJhY2VEZXB0aCsrO1xuICAgICAgaWYgKGNoID09PSBcIn1cIikgYnJhY2VEZXB0aC0tO1xuICAgIH1cblxuICAgIC8vIENsYXNzLWxldmVsIHByb3BlcnRpZXMgYXJlIGF0IGJyYWNlIGRlcHRoIDEgKGluc2lkZSB0aGUgY2xhc3MsIG91dHNpZGUgbWV0aG9kcylcbiAgICBpZiAoYnJhY2VEZXB0aCA9PT0gMSAmJiAhaW5NZXRob2QpIHtcbiAgICAgIGNvbnN0IG1hdGNoID0gbGluZS5tYXRjaChwcm9wZXJ0eVBhdHRlcm4pO1xuICAgICAgaWYgKG1hdGNoICYmIG1hdGNoWzJdKSB7XG4gICAgICAgIGNvbnN0IHByb3BOYW1lID0gbWF0Y2hbMl07XG4gICAgICAgIC8vIFNraXAgbWV0aG9kLWxpa2UgbmFtZXMgYW5kIHR5cGUtb25seSBkZWNsYXJhdGlvbnNcbiAgICAgICAgaWYgKCFbXCJjb25zdHJ1Y3RvclwiLCBcImNsZWFyVGltZXJzXCIsIFwicmVzZXREaXNwYXRjaENvdW50ZXJzXCIsIFwibG9ja0Jhc2VQYXRoXCIsXG4gICAgICAgICAgICAgICBcImNvbXBsZXRlQ3VycmVudFVuaXRcIiwgXCJyZXNldFwiLCBcInRvSlNPTlwiXS5pbmNsdWRlcyhwcm9wTmFtZSkpIHtcbiAgICAgICAgICBwcm9wZXJ0aWVzLnB1c2gocHJvcE5hbWUpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gRGV0ZWN0IG1ldGhvZCBzdGFydC9lbmRcbiAgICBpZiAoYnJhY2VEZXB0aCA9PT0gMSAmJiAvXlxccysoZ2V0IHxhc3luYyApPyhcXHcrKVxccypcXCgvLnRlc3QobGluZSkpIHtcbiAgICAgIGluTWV0aG9kID0gdHJ1ZTtcbiAgICB9XG4gICAgaWYgKGJyYWNlRGVwdGggPT09IDEgJiYgaW5NZXRob2QpIHtcbiAgICAgIGluTWV0aG9kID0gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgLy8gRXh0cmFjdCB0aGUgcmVzZXQoKSBtZXRob2QgYm9keVxuICBjb25zdCByZXNldE1hdGNoID0gc291cmNlLm1hdGNoKC9yZXNldFxcKFxcKTogdm9pZCBcXHsoW1xcc1xcU10qPyleXFxzezJ9XFx9L20pO1xuICBhc3NlcnQub2socmVzZXRNYXRjaCwgXCJBdXRvU2Vzc2lvbi5yZXNldCgpIG1ldGhvZCBub3QgZm91bmRcIik7XG4gIGNvbnN0IHJlc2V0Qm9keSA9IHJlc2V0TWF0Y2ghWzFdITtcblxuICBjb25zdCBpbnRlbnRpb25hbGx5U2tpcHBlZCA9IG5ldyBTZXQ8c3RyaW5nPihbXSk7XG5cbiAgY29uc3QgbWlzc2luZ0Zyb21SZXNldDogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBwcm9wIG9mIHByb3BlcnRpZXMpIHtcbiAgICBpZiAoaW50ZW50aW9uYWxseVNraXBwZWQuaGFzKHByb3ApKSBjb250aW51ZTtcbiAgICAvLyBDaGVjayBpZiB0aGUgcHJvcGVydHkgbmFtZSBhcHBlYXJzIGluIHJlc2V0IGJvZHkgKGFzIGB0aGlzLnByb3BgIGFzc2lnbm1lbnQgb3IgYC5jbGVhcigpYClcbiAgICBpZiAoIXJlc2V0Qm9keS5pbmNsdWRlcyhgdGhpcy4ke3Byb3B9YCkpIHtcbiAgICAgIG1pc3NpbmdGcm9tUmVzZXQucHVzaChwcm9wKTtcbiAgICB9XG4gIH1cblxuICBhc3NlcnQuZXF1YWwoXG4gICAgbWlzc2luZ0Zyb21SZXNldC5sZW5ndGgsXG4gICAgMCxcbiAgICBgQXV0b1Nlc3Npb24ucmVzZXQoKSBtdXN0IHJlZmVyZW5jZSBldmVyeSBpbnN0YW5jZSBwcm9wZXJ0eS4gYCArXG4gICAgYE1pc3Npbmc6ICR7bWlzc2luZ0Zyb21SZXNldC5qb2luKFwiLCBcIil9LiBgICtcbiAgICBgSWYgYSBwcm9wZXJ0eSBzaG91bGQgcGVyc2lzdCBhY3Jvc3MgcmVzZXRzLCBhZGQgaXQgdG8gdGhlIGludGVudGlvbmFsbHlTa2lwcGVkIHNldCBpbiB0aGlzIHRlc3QuYCxcbiAgKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgSW52YXJpYW50IDQ6IEF1dG9TZXNzaW9uLnRvSlNPTigpIHByb3ZpZGVzIGRpYWdub3N0aWMgdmlzaWJpbGl0eSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIkF1dG9TZXNzaW9uLnRvSlNPTigpIGluY2x1ZGVzIGtleSBkaWFnbm9zdGljIHByb3BlcnRpZXNcIiwgKCkgPT4ge1xuICBjb25zdCBzb3VyY2UgPSBnZXRTZXNzaW9uVHNTb3VyY2UoKTtcblxuICBjb25zdCB0b0pTT05NYXRjaCA9IHNvdXJjZS5tYXRjaCgvdG9KU09OXFwoXFwpW1xcc1xcU10qP3JldHVybiBcXHsoW1xcc1xcU10qPylcXH07Lyk7XG4gIGFzc2VydC5vayh0b0pTT05NYXRjaCwgXCJBdXRvU2Vzc2lvbi50b0pTT04oKSBtZXRob2Qgbm90IGZvdW5kXCIpO1xuICBjb25zdCB0b0pTT05Cb2R5ID0gdG9KU09OTWF0Y2ghWzFdITtcblxuICAvLyBUaGVzZSBhcmUgdGhlIG1pbmltdW0gcHJvcGVydGllcyBuZWVkZWQgZm9yIGRpYWdub3N0aWMgc25hcHNob3RzXG4gIGNvbnN0IHJlcXVpcmVkRGlhZ25vc3RpY3MgPSBbXG4gICAgXCJhY3RpdmVcIixcbiAgICBcInBhdXNlZFwiLFxuICAgIFwiYmFzZVBhdGhcIixcbiAgICBcImN1cnJlbnRNaWxlc3RvbmVJZFwiLFxuICAgIFwiY3VycmVudFVuaXRcIixcbiAgICBcIm9yY2hlc3RyYXRpb25QaGFzZVwiLFxuICAgIFwib3JjaGVzdHJhdGlvblRyYW5zaXRpb25Db3VudFwiLFxuICAgIFwib3JjaGVzdHJhdGlvbkxhc3RUcmFuc2l0aW9uQXRcIixcbiAgXTtcblxuICBjb25zdCBtaXNzaW5nID0gcmVxdWlyZWREaWFnbm9zdGljcy5maWx0ZXIocHJvcCA9PiAhdG9KU09OQm9keS5pbmNsdWRlcyhwcm9wKSk7XG5cbiAgYXNzZXJ0LmVxdWFsKFxuICAgIG1pc3NpbmcubGVuZ3RoLFxuICAgIDAsXG4gICAgYEF1dG9TZXNzaW9uLnRvSlNPTigpIG11c3QgaW5jbHVkZSBkaWFnbm9zdGljIHByb3BlcnRpZXM6ICR7bWlzc2luZy5qb2luKFwiLCBcIil9YCxcbiAgKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgSW52YXJpYW50IDU6IE5vIHN0YXRlLWJlYXJpbmcgbW9kdWxlLWxldmVsIGNvbnN0cyB0aGF0IHNob3VsZCBiZSBpbiBBdXRvU2Vzc2lvbiBcdTI1MDBcdTI1MDBcblxudGVzdChcImF1dG8udHMgbW9kdWxlLWxldmVsIGNvbnN0cyBhcmUgb25seSBBdXRvU2Vzc2lvbiBpbnN0YW5jZSwgdHJ1ZSBjb25zdGFudHMsIG9yIHN0YXRpYyBhY2Nlc3NvcnNcIiwgKCkgPT4ge1xuICBjb25zdCBzb3VyY2UgPSBnZXRBdXRvVHNTb3VyY2UoKTtcbiAgY29uc3QgbGluZXMgPSBzb3VyY2Uuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IHZpb2xhdGlvbnM6IHN0cmluZ1tdID0gW107XG5cbiAgLy8gUGF0dGVybnMgdGhhdCBhcmUgYWNjZXB0YWJsZSBhdCBtb2R1bGUgbGV2ZWxcbiAgY29uc3QgYWxsb3dlZFBhdHRlcm5zID0gW1xuICAgIC9eY29uc3QgW0EtWl9dK1xccyo9LywgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIFVQUEVSX0NBU0UgY29uc3RhbnRzXG4gICAgL15jb25zdCBcXHcrU3RhdGVBY2Nlc3NvcnMvLCAgICAgICAgICAgICAgICAgICAgLy8gU3RhdGljIGFjY2Vzc29yIG9iamVjdHNcbiAgICAvXmNvbnN0IFxcdys6XFxzKlxcdytcXHMqPS8sICAgICAgICAgICAgICAgICAgICAgICAvLyBUeXBlZCBjb25zdGFudHNcbiAgXTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IGxpbmVzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgbGluZSA9IGxpbmVzW2ldITtcbiAgICBpZiAoIS9eKGV4cG9ydFxccyspP2NvbnN0XFxzKy8udGVzdChsaW5lKSkgY29udGludWU7XG5cbiAgICBjb25zdCBpc0FsbG93ZWQgPSBhbGxvd2VkUGF0dGVybnMuc29tZShwID0+IHAudGVzdChsaW5lLnJlcGxhY2UoL15leHBvcnRcXHMrLywgXCJcIikpKTtcbiAgICBpZiAoIWlzQWxsb3dlZCkge1xuICAgICAgLy8gQ2hlY2sgaWYgaXQgbG9va3MgbGlrZSBtdXRhYmxlIHN0YXRlIChhcnJheXMsIG9iamVjdHMgd2l0aCBtdXRhYmxlIHNlbWFudGljcylcbiAgICAgIGlmICgvPSBuZXcgKE1hcHxTZXR8QXJyYXkpXFwoLy50ZXN0KGxpbmUpIHx8IC89IFxcW1xcXS8udGVzdChsaW5lKSkge1xuICAgICAgICB2aW9sYXRpb25zLnB1c2goYGxpbmUgJHtpICsgMX06ICR7bGluZS50cmltKCl9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHZpb2xhdGlvbnMubGVuZ3RoLFxuICAgIDAsXG4gICAgYGF1dG8udHMgaGFzIG1vZHVsZS1sZXZlbCBjb25zdCBkZWNsYXJhdGlvbnMgdGhhdCBsb29rIGxpa2UgbXV0YWJsZSBzdGF0ZS4gYCArXG4gICAgYE1vdmUgdGhlc2UgaW50byBBdXRvU2Vzc2lvbjpcXG4ke3Zpb2xhdGlvbnMuam9pbihcIlxcblwiKX1gLFxuICApO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBJbnZhcmlhbnQgNjogc2Vzc2lvbi50cyBmaWxlIGV4aXN0cyBhbmQgZXhwb3J0cyBBdXRvU2Vzc2lvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImF1dG8vc2Vzc2lvbi50cyBleHBvcnRzIEF1dG9TZXNzaW9uIGNsYXNzXCIsICgpID0+IHtcbiAgY29uc3Qgc291cmNlID0gZ2V0U2Vzc2lvblRzU291cmNlKCk7XG4gIGFzc2VydC5vayhcbiAgICAvZXhwb3J0IGNsYXNzIEF1dG9TZXNzaW9uLy50ZXN0KHNvdXJjZSksXG4gICAgXCJhdXRvL3Nlc3Npb24udHMgbXVzdCBleHBvcnQgdGhlIEF1dG9TZXNzaW9uIGNsYXNzXCIsXG4gICk7XG59KTtcblxudGVzdChcIkF1dG9TZXNzaW9uIGhhcyBhIHJlc2V0KCkgbWV0aG9kXCIsICgpID0+IHtcbiAgY29uc3Qgc291cmNlID0gZ2V0U2Vzc2lvblRzU291cmNlKCk7XG4gIGFzc2VydC5vayhcbiAgICAvcmVzZXRcXChcXCk6IHZvaWQvLnRlc3Qoc291cmNlKSxcbiAgICBcIkF1dG9TZXNzaW9uIG11c3QgaGF2ZSBhIHJlc2V0KCk6IHZvaWQgbWV0aG9kXCIsXG4gICk7XG59KTtcblxudGVzdChcIkF1dG9TZXNzaW9uIGhhcyBhIHRvSlNPTigpIG1ldGhvZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHNvdXJjZSA9IGdldFNlc3Npb25Uc1NvdXJjZSgpO1xuICBhc3NlcnQub2soXG4gICAgL3RvSlNPTlxcKFxcKS8udGVzdChzb3VyY2UpLFxuICAgIFwiQXV0b1Nlc3Npb24gbXVzdCBoYXZlIGEgdG9KU09OKCkgbWV0aG9kIGZvciBkaWFnbm9zdGljc1wiLFxuICApO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFXQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsTUFBTSxlQUFlO0FBQzlCLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsbUJBQW1CO0FBRTVCLE1BQU0sWUFBWSxRQUFRLGNBQWMsWUFBWSxHQUFHLENBQUM7QUFDeEQsTUFBTSxlQUFlLEtBQUssV0FBVyxNQUFNLFNBQVM7QUFDcEQsTUFBTSxrQkFBa0IsS0FBSyxXQUFXLE1BQU0sUUFBUSxZQUFZO0FBQ2xFLE1BQU0sd0JBQXdCLEtBQUssV0FBVyxNQUFNLHVCQUF1QjtBQUUzRSxTQUFTLGtCQUEwQjtBQUNqQyxTQUFPLGFBQWEsY0FBYyxPQUFPO0FBQzNDO0FBRUEsU0FBUyxxQkFBNkI7QUFDcEMsU0FBTyxhQUFhLGlCQUFpQixPQUFPO0FBQzlDO0FBRUEsU0FBUywwQkFBa0M7QUFDekMsU0FBTyxhQUFhLHVCQUF1QixPQUFPO0FBQ3BEO0FBRUEsS0FBSyxpRkFBaUYsTUFBTTtBQUMxRixRQUFNLG1CQUFtQixRQUFRLElBQUk7QUFDckMsVUFBUSxJQUFJLG1CQUFtQjtBQUMvQixNQUFJO0FBQ0YsVUFBTSxVQUFVLElBQUksWUFBWTtBQUNoQyxZQUFRLFdBQVc7QUFFbkIsV0FBTyxNQUFNLFFBQVEsY0FBYyxlQUFlO0FBQUEsRUFDcEQsVUFBRTtBQUNBLFFBQUkscUJBQXFCLE9BQVcsUUFBTyxRQUFRLElBQUk7QUFBQSxRQUNsRCxTQUFRLElB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
