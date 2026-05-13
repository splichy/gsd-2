import { describe, test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runPostUnitVerification } from "../auto-verification.js";
import { AutoSession } from "../auto/session.js";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice
} from "../gsd-db.js";
import { invalidateAllCaches } from "../cache.js";
import { _clearGsdRootCache } from "../paths.js";
let tempDir;
let dbPath;
let originalCwd;
function makeMockCtx() {
  return {
    ui: {
      notify: mock.fn(),
      setStatus: () => {
      },
      setWidget: () => {
      },
      setFooter: () => {
      }
    },
    model: { id: "test-model" }
  };
}
function makeMockPi() {
  return {
    sendMessage: mock.fn(),
    setModel: mock.fn(async () => true)
  };
}
function makeMockSession(basePath, unitType, unitId) {
  const s = new AutoSession();
  s.basePath = basePath;
  s.active = true;
  s.pendingVerificationRetry = null;
  s.currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
  return s;
}
function setupTestEnvironment() {
  originalCwd = process.cwd();
  tempDir = join(tmpdir(), `validate-milestone-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  const milestoneDir = join(tempDir, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  process.chdir(tempDir);
  _clearGsdRootCache();
  dbPath = join(tempDir, ".gsd", "gsd.db");
  openDatabase(dbPath);
  invalidateAllCaches();
}
function cleanupTestEnvironment() {
  try {
    process.chdir(originalCwd);
  } catch {
  }
  try {
    closeDatabase();
  } catch {
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
  }
}
function writeValidationFile(verdict) {
  const path = join(tempDir, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
  const content = `---
verdict: ${verdict}
remediation_round: 1
---

# Milestone Validation: M001

## Verdict Rationale
Test fixture
`;
  writeFileSync(path, content, "utf-8");
  invalidateAllCaches();
}
describe("validate-milestone stuck-loop guard (#4094)", () => {
  beforeEach(() => setupTestEnvironment());
  afterEach(() => cleanupTestEnvironment());
  test("pauses when verdict=needs-remediation and all slices are closed", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Slice 2", status: "done" });
    writeValidationFile("needs-remediation");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, "validate-milestone", "M001");
    const result = await runPostUnitVerification({ s, ctx, pi }, pauseAutoMock);
    assert.equal(result, "pause");
    assert.equal(pauseAutoMock.mock.callCount(), 1);
    assert.equal(ctx.ui.notify.mock.callCount(), 1);
    const notifyArgs = ctx.ui.notify.mock.calls[0].arguments;
    assert.match(notifyArgs[0], /needs-remediation/);
    assert.equal(notifyArgs[1], "error");
  });
  test("treats skipped slices as closed", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Slice 2", status: "skipped" });
    writeValidationFile("needs-remediation");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, "validate-milestone", "M001");
    const result = await runPostUnitVerification({ s, ctx, pi }, pauseAutoMock);
    assert.equal(result, "pause");
    assert.equal(pauseAutoMock.mock.callCount(), 1);
  });
  test("continues when verdict=needs-remediation but a queued remediation slice exists", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Remediation", status: "queued" });
    writeValidationFile("needs-remediation");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, "validate-milestone", "M001");
    const result = await runPostUnitVerification({ s, ctx, pi }, pauseAutoMock);
    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });
  test("continues when verdict is pass", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    writeValidationFile("pass");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, "validate-milestone", "M001");
    const result = await runPostUnitVerification({ s, ctx, pi }, pauseAutoMock);
    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });
  test("continues when no VALIDATION file exists yet", async () => {
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice 1", status: "complete" });
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const pauseAutoMock = mock.fn(async () => {
    });
    const s = makeMockSession(tempDir, "validate-milestone", "M001");
    const result = await runPostUnitVerification({ s, ctx, pi }, pauseAutoMock);
    assert.equal(result, "continue");
    assert.equal(pauseAutoMock.mock.callCount(), 0);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy92YWxpZGF0ZS1taWxlc3RvbmUtc3R1Y2stZ3VhcmQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gZ3NkLXBpIFx1MjAxNCBSZWdyZXNzaW9uIHRlc3RzIGZvciB0aGUgdmFsaWRhdGUtbWlsZXN0b25lIHN0dWNrLWxvb3AgZ3VhcmQgKCM0MDk0KVxuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCwgbW9jaywgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuaW1wb3J0IHsgcnVuUG9zdFVuaXRWZXJpZmljYXRpb24sIHR5cGUgVmVyaWZpY2F0aW9uQ29udGV4dCB9IGZyb20gXCIuLi9hdXRvLXZlcmlmaWNhdGlvbi50c1wiO1xuaW1wb3J0IHsgQXV0b1Nlc3Npb24gfSBmcm9tIFwiLi4vYXV0by9zZXNzaW9uLnRzXCI7XG5pbXBvcnQge1xuICBvcGVuRGF0YWJhc2UsXG4gIGNsb3NlRGF0YWJhc2UsXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgaW5zZXJ0U2xpY2UsXG59IGZyb20gXCIuLi9nc2QtZGIudHNcIjtcbmltcG9ydCB7IGludmFsaWRhdGVBbGxDYWNoZXMgfSBmcm9tIFwiLi4vY2FjaGUudHNcIjtcbmltcG9ydCB7IF9jbGVhckdzZFJvb3RDYWNoZSB9IGZyb20gXCIuLi9wYXRocy50c1wiO1xuXG5sZXQgdGVtcERpcjogc3RyaW5nO1xubGV0IGRiUGF0aDogc3RyaW5nO1xubGV0IG9yaWdpbmFsQ3dkOiBzdHJpbmc7XG5cbmZ1bmN0aW9uIG1ha2VNb2NrQ3R4KCkge1xuICByZXR1cm4ge1xuICAgIHVpOiB7XG4gICAgICBub3RpZnk6IG1vY2suZm4oKSxcbiAgICAgIHNldFN0YXR1czogKCkgPT4ge30sXG4gICAgICBzZXRXaWRnZXQ6ICgpID0+IHt9LFxuICAgICAgc2V0Rm9vdGVyOiAoKSA9PiB7fSxcbiAgICB9LFxuICAgIG1vZGVsOiB7IGlkOiBcInRlc3QtbW9kZWxcIiB9LFxuICB9IGFzIGFueTtcbn1cblxuZnVuY3Rpb24gbWFrZU1vY2tQaSgpIHtcbiAgcmV0dXJuIHtcbiAgICBzZW5kTWVzc2FnZTogbW9jay5mbigpLFxuICAgIHNldE1vZGVsOiBtb2NrLmZuKGFzeW5jICgpID0+IHRydWUpLFxuICB9IGFzIGFueTtcbn1cblxuZnVuY3Rpb24gbWFrZU1vY2tTZXNzaW9uKGJhc2VQYXRoOiBzdHJpbmcsIHVuaXRUeXBlOiBzdHJpbmcsIHVuaXRJZDogc3RyaW5nKTogQXV0b1Nlc3Npb24ge1xuICBjb25zdCBzID0gbmV3IEF1dG9TZXNzaW9uKCk7XG4gIHMuYmFzZVBhdGggPSBiYXNlUGF0aDtcbiAgcy5hY3RpdmUgPSB0cnVlO1xuICBzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSA9IG51bGw7XG4gIHMuY3VycmVudFVuaXQgPSB7IHR5cGU6IHVuaXRUeXBlLCBpZDogdW5pdElkLCBzdGFydGVkQXQ6IERhdGUubm93KCkgfTtcbiAgcmV0dXJuIHM7XG59XG5cbmZ1bmN0aW9uIHNldHVwVGVzdEVudmlyb25tZW50KCk6IHZvaWQge1xuICBvcmlnaW5hbEN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIHRlbXBEaXIgPSBqb2luKHRtcGRpcigpLCBgdmFsaWRhdGUtbWlsZXN0b25lLWd1YXJkLSR7RGF0ZS5ub3coKX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyKX1gKTtcbiAgbWtkaXJTeW5jKHRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIGNvbnN0IG1pbGVzdG9uZURpciA9IGpvaW4odGVtcERpciwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIik7XG4gIG1rZGlyU3luYyhtaWxlc3RvbmVEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIHByb2Nlc3MuY2hkaXIodGVtcERpcik7XG4gIF9jbGVhckdzZFJvb3RDYWNoZSgpO1xuXG4gIGRiUGF0aCA9IGpvaW4odGVtcERpciwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpO1xuICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xufVxuXG5mdW5jdGlvbiBjbGVhbnVwVGVzdEVudmlyb25tZW50KCk6IHZvaWQge1xuICB0cnkgeyBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gIHRyeSB7IGNsb3NlRGF0YWJhc2UoKTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gIHRyeSB7IHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxufVxuXG5mdW5jdGlvbiB3cml0ZVZhbGlkYXRpb25GaWxlKHZlcmRpY3Q6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBwYXRoID0gam9pbih0ZW1wRGlyLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcIk0wMDEtVkFMSURBVElPTi5tZFwiKTtcbiAgY29uc3QgY29udGVudCA9IGAtLS1cbnZlcmRpY3Q6ICR7dmVyZGljdH1cbnJlbWVkaWF0aW9uX3JvdW5kOiAxXG4tLS1cblxuIyBNaWxlc3RvbmUgVmFsaWRhdGlvbjogTTAwMVxuXG4jIyBWZXJkaWN0IFJhdGlvbmFsZVxuVGVzdCBmaXh0dXJlXG5gO1xuICB3cml0ZUZpbGVTeW5jKHBhdGgsIGNvbnRlbnQsIFwidXRmLThcIik7XG4gIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcbn1cblxuZGVzY3JpYmUoXCJ2YWxpZGF0ZS1taWxlc3RvbmUgc3R1Y2stbG9vcCBndWFyZCAoIzQwOTQpXCIsICgpID0+IHtcbiAgYmVmb3JlRWFjaCgoKSA9PiBzZXR1cFRlc3RFbnZpcm9ubWVudCgpKTtcbiAgYWZ0ZXJFYWNoKCgpID0+IGNsZWFudXBUZXN0RW52aXJvbm1lbnQoKSk7XG5cbiAgdGVzdChcInBhdXNlcyB3aGVuIHZlcmRpY3Q9bmVlZHMtcmVtZWRpYXRpb24gYW5kIGFsbCBzbGljZXMgYXJlIGNsb3NlZFwiLCBhc3luYyAoKSA9PiB7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiU2xpY2UgMVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMlwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlNsaWNlIDJcIiwgc3RhdHVzOiBcImRvbmVcIiB9KTtcbiAgICB3cml0ZVZhbGlkYXRpb25GaWxlKFwibmVlZHMtcmVtZWRpYXRpb25cIik7XG5cbiAgICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICAgIGNvbnN0IHBhdXNlQXV0b01vY2sgPSBtb2NrLmZuKGFzeW5jICgpID0+IHt9KTtcbiAgICBjb25zdCBzID0gbWFrZU1vY2tTZXNzaW9uKHRlbXBEaXIsIFwidmFsaWRhdGUtbWlsZXN0b25lXCIsIFwiTTAwMVwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blBvc3RVbml0VmVyaWZpY2F0aW9uKHsgcywgY3R4LCBwaSB9IGFzIFZlcmlmaWNhdGlvbkNvbnRleHQsIHBhdXNlQXV0b01vY2spO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgXCJwYXVzZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocGF1c2VBdXRvTW9jay5tb2NrLmNhbGxDb3VudCgpLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwoY3R4LnVpLm5vdGlmeS5tb2NrLmNhbGxDb3VudCgpLCAxKTtcbiAgICBjb25zdCBub3RpZnlBcmdzID0gY3R4LnVpLm5vdGlmeS5tb2NrLmNhbGxzWzBdLmFyZ3VtZW50cztcbiAgICBhc3NlcnQubWF0Y2gobm90aWZ5QXJnc1swXSwgL25lZWRzLXJlbWVkaWF0aW9uLyk7XG4gICAgYXNzZXJ0LmVxdWFsKG5vdGlmeUFyZ3NbMV0sIFwiZXJyb3JcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJ0cmVhdHMgc2tpcHBlZCBzbGljZXMgYXMgY2xvc2VkXCIsIGFzeW5jICgpID0+IHtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIgfSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTbGljZSAxXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAyXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiU2xpY2UgMlwiLCBzdGF0dXM6IFwic2tpcHBlZFwiIH0pO1xuICAgIHdyaXRlVmFsaWRhdGlvbkZpbGUoXCJuZWVkcy1yZW1lZGlhdGlvblwiKTtcblxuICAgIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gICAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gICAgY29uc3QgcGF1c2VBdXRvTW9jayA9IG1vY2suZm4oYXN5bmMgKCkgPT4ge30pO1xuICAgIGNvbnN0IHMgPSBtYWtlTW9ja1Nlc3Npb24odGVtcERpciwgXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIiwgXCJNMDAxXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUG9zdFVuaXRWZXJpZmljYXRpb24oeyBzLCBjdHgsIHBpIH0gYXMgVmVyaWZpY2F0aW9uQ29udGV4dCwgcGF1c2VBdXRvTW9jayk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcInBhdXNlXCIpO1xuICAgIGFzc2VydC5lcXVhbChwYXVzZUF1dG9Nb2NrLm1vY2suY2FsbENvdW50KCksIDEpO1xuICB9KTtcblxuICB0ZXN0KFwiY29udGludWVzIHdoZW4gdmVyZGljdD1uZWVkcy1yZW1lZGlhdGlvbiBidXQgYSBxdWV1ZWQgcmVtZWRpYXRpb24gc2xpY2UgZXhpc3RzXCIsIGFzeW5jICgpID0+IHtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIgfSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTbGljZSAxXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAyXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiUmVtZWRpYXRpb25cIiwgc3RhdHVzOiBcInF1ZXVlZFwiIH0pO1xuICAgIHdyaXRlVmFsaWRhdGlvbkZpbGUoXCJuZWVkcy1yZW1lZGlhdGlvblwiKTtcblxuICAgIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gICAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gICAgY29uc3QgcGF1c2VBdXRvTW9jayA9IG1vY2suZm4oYXN5bmMgKCkgPT4ge30pO1xuICAgIGNvbnN0IHMgPSBtYWtlTW9ja1Nlc3Npb24odGVtcERpciwgXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIiwgXCJNMDAxXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUG9zdFVuaXRWZXJpZmljYXRpb24oeyBzLCBjdHgsIHBpIH0gYXMgVmVyaWZpY2F0aW9uQ29udGV4dCwgcGF1c2VBdXRvTW9jayk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcImNvbnRpbnVlXCIpO1xuICAgIGFzc2VydC5lcXVhbChwYXVzZUF1dG9Nb2NrLm1vY2suY2FsbENvdW50KCksIDApO1xuICB9KTtcblxuICB0ZXN0KFwiY29udGludWVzIHdoZW4gdmVyZGljdCBpcyBwYXNzXCIsIGFzeW5jICgpID0+IHtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIgfSk7XG4gICAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTbGljZSAxXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0pO1xuICAgIHdyaXRlVmFsaWRhdGlvbkZpbGUoXCJwYXNzXCIpO1xuXG4gICAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgICBjb25zdCBwYXVzZUF1dG9Nb2NrID0gbW9jay5mbihhc3luYyAoKSA9PiB7fSk7XG4gICAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbih0ZW1wRGlyLCBcInZhbGlkYXRlLW1pbGVzdG9uZVwiLCBcIk0wMDFcIik7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5Qb3N0VW5pdFZlcmlmaWNhdGlvbih7IHMsIGN0eCwgcGkgfSBhcyBWZXJpZmljYXRpb25Db250ZXh0LCBwYXVzZUF1dG9Nb2NrKTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIFwiY29udGludWVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHBhdXNlQXV0b01vY2subW9jay5jYWxsQ291bnQoKSwgMCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJjb250aW51ZXMgd2hlbiBubyBWQUxJREFUSU9OIGZpbGUgZXhpc3RzIHlldFwiLCBhc3luYyAoKSA9PiB7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiIH0pO1xuICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiU2xpY2UgMVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcblxuICAgIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gICAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gICAgY29uc3QgcGF1c2VBdXRvTW9jayA9IG1vY2suZm4oYXN5bmMgKCkgPT4ge30pO1xuICAgIGNvbnN0IHMgPSBtYWtlTW9ja1Nlc3Npb24odGVtcERpciwgXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIiwgXCJNMDAxXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUG9zdFVuaXRWZXJpZmljYXRpb24oeyBzLCBjdHgsIHBpIH0gYXMgVmVyaWZpY2F0aW9uQ29udGV4dCwgcGF1c2VBdXRvTW9jayk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCBcImNvbnRpbnVlXCIpO1xuICAgIGFzc2VydC5lcXVhbChwYXVzZUF1dG9Nb2NrLm1vY2suY2FsbENvdW50KCksIDApO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsU0FBUyxVQUFVLE1BQU0sTUFBTSxZQUFZLGlCQUFpQjtBQUM1RCxPQUFPLFlBQVk7QUFDbkIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsV0FBVyxlQUFlLGNBQWM7QUFDakQsU0FBUyxZQUFZO0FBRXJCLFNBQVMsK0JBQXlEO0FBQ2xFLFNBQVMsbUJBQW1CO0FBQzVCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLDJCQUEyQjtBQUNwQyxTQUFTLDBCQUEwQjtBQUVuQyxJQUFJO0FBQ0osSUFBSTtBQUNKLElBQUk7QUFFSixTQUFTLGNBQWM7QUFDckIsU0FBTztBQUFBLElBQ0wsSUFBSTtBQUFBLE1BQ0YsUUFBUSxLQUFLLEdBQUc7QUFBQSxNQUNoQixXQUFXLE1BQU07QUFBQSxNQUFDO0FBQUEsTUFDbEIsV0FBVyxNQUFNO0FBQUEsTUFBQztBQUFBLE1BQ2xCLFdBQVcsTUFBTTtBQUFBLE1BQUM7QUFBQSxJQUNwQjtBQUFBLElBQ0EsT0FBTyxFQUFFLElBQUksYUFBYTtBQUFBLEVBQzVCO0FBQ0Y7QUFFQSxTQUFTLGFBQWE7QUFDcEIsU0FBTztB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
