import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { preflightCleanRoot, postflightPopStash } from "../clean-root-preflight.js";
function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}
function createTempRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-preflight-test-")));
  run("git init", dir);
  run("git config user.email test@example.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "# State\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  return dir;
}
test("preflightCleanRoot \u2014 clean tree returns stashPushed=false and emits no notifications", () => {
  const repo = createTempRepo();
  try {
    const notifications = [];
    const result = preflightCleanRoot(repo, "M001", (msg, level) => {
      notifications.push({ msg, level });
    });
    assert.equal(result.stashPushed, false, "stashPushed must be false for clean tree");
    assert.equal(result.summary, "", "summary must be empty for clean tree");
    assert.equal(notifications.length, 0, "no notifications on clean tree");
    const stashList = run("git stash list", repo);
    assert.equal(stashList, "", "no stash entry on clean tree");
  } finally {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
});
test("preflightCleanRoot \u2014 dirty tree warns user and auto-stashes", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo, "README.md"), "# locally modified\n");
    const notifications = [];
    const result = preflightCleanRoot(repo, "M002", (msg, level) => {
      notifications.push({ msg, level });
    });
    assert.equal(result.stashPushed, true, "stashPushed must be true when tree was dirty");
    assert.ok(result.summary.length > 0, "summary must be non-empty when stash was pushed");
    assert.ok(
      notifications.some((n) => n.level === "warning" && n.msg.includes("M002")),
      "warning notification must mention the milestone ID"
    );
    const status = run("git status --porcelain", repo);
    assert.equal(status, "", "working tree must be clean after stash push");
    const stashList = run("git stash list", repo);
    assert.ok(stashList.includes("gsd-preflight-stash"), "stash entry must be named gsd-preflight-stash");
  } finally {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
});
test("preflightCleanRoot \u2014 untracked file triggers stash with --include-untracked", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo, "untracked.ts"), "export const x = 1;\n");
    const notifications = [];
    const result = preflightCleanRoot(repo, "M003", (msg, level) => {
      notifications.push({ msg, level });
    });
    assert.equal(result.stashPushed, true, "stashPushed must be true for untracked file");
    const status = run("git status --porcelain", repo);
    assert.equal(status, "", "working tree must be clean after stash push");
  } finally {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
});
test("postflightPopStash \u2014 restores stashed changes and emits info notification", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo, "README.md"), "# stash me\n");
    const preNotifications = [];
    const preflight = preflightCleanRoot(repo, "M004", (msg, level) => {
      preNotifications.push({ msg, level });
    });
    assert.equal(preflight.stashPushed, true, "preflight must have stashed");
    writeFileSync(join(repo, "merged.ts"), "export const merged = true;\n");
    run("git add .", repo);
    run('git commit -m "simulate merge"', repo);
    const postNotifications = [];
    const postflight = postflightPopStash(repo, "M004", preflight.stashMarker, (msg, level) => {
      postNotifications.push({ msg, level });
    });
    assert.equal(postflight.restored, true, "postflight must report successful restore");
    assert.equal(postflight.needsManualRecovery, false, "successful restore must not need manual recovery");
    const content = readFileSync(join(repo, "README.md"), "utf-8");
    assert.equal(content.replace(/\r\n/g, "\n"), "# stash me\n", "stashed file must be restored");
    assert.ok(
      postNotifications.some((n) => n.level === "info" && n.msg.includes("M004")),
      "info notification must mention milestone ID after pop"
    );
    const stashList = run("git stash list", repo);
    assert.equal(stashList, "", "stash list must be empty after pop");
  } finally {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
});
test("preflight + merge + postflight round-trip preserves uncommitted changes", () => {
  const repo = createTempRepo();
  try {
    const originalContent = "# my local work\n";
    writeFileSync(join(repo, "README.md"), originalContent);
    const preflight = preflightCleanRoot(repo, "M005", () => {
    });
    assert.equal(preflight.stashPushed, true, "must have stashed");
    writeFileSync(join(repo, "feature.ts"), "export const feature = true;\n");
    run("git add feature.ts", repo);
    run('git commit -m "feat: add feature"', repo);
    const postflight = postflightPopStash(repo, "M005", preflight.stashMarker, () => {
    });
    assert.equal(postflight.needsManualRecovery, false, "clean restore must not stop auto-mode");
    const restored = readFileSync(join(repo, "README.md"), "utf-8");
    assert.equal(restored.replace(/\r\n/g, "\n"), originalContent, "local changes must survive merge");
    const featureContent = readFileSync(join(repo, "feature.ts"), "utf-8");
    assert.ok(featureContent.includes("feature"), "merged feature must be present");
  } finally {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
});
test("postflightPopStash conflict warning names the exact stash ref", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo, "README.md"), "# local work\n");
    const preflight = preflightCleanRoot(repo, "M005C", () => {
    });
    assert.equal(preflight.stashPushed, true, "must have stashed");
    writeFileSync(join(repo, "README.md"), "# merged work\n");
    run("git add README.md", repo);
    run('git commit -m "simulate conflicting merge"', repo);
    const notifications = [];
    const postflight = postflightPopStash(repo, "M005C", preflight.stashMarker, (msg, level) => {
      notifications.push({ msg, level });
    });
    assert.equal(postflight.restored, false, "conflicted restore must report restored=false");
    assert.equal(postflight.needsManualRecovery, true, "conflicted restore must require manual recovery");
    assert.match(postflight.message, /failed after merge of milestone M005C/);
    const warning = notifications.find((n) => n.level === "warning")?.msg ?? "";
    assert.match(warning, /git stash apply stash@\{\d+\}/);
    assert.match(warning, /git stash drop stash@\{\d+\}/);
  } finally {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
});
test("postflightPopStash restores the matching GSD stash, not stash@{0}", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo, "README.md"), "# target stash\n");
    const preflight = preflightCleanRoot(repo, "M006", () => {
    });
    assert.equal(preflight.stashPushed, true, "must have stashed target change");
    writeFileSync(join(repo, "other.txt"), "other stash\n");
    run('git stash push --include-untracked -m "unrelated newer stash"', repo);
    const postflight = postflightPopStash(repo, "M006", preflight.stashMarker, () => {
    });
    assert.equal(postflight.needsManualRecovery, false, "targeted restore must not need manual recovery");
    const content = readFileSync(join(repo, "README.md"), "utf-8");
    assert.equal(content.replace(/\r\n/g, "\n"), "# target stash\n");
    const stashList = run("git stash list", repo);
    assert.ok(stashList.includes("unrelated newer stash"), "unrelated newer stash must remain");
    assert.ok(!stashList.includes("gsd-preflight-stash [gsd-preflight-stash:M006"), "target stash should be consumed");
  } finally {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
});
test("postflightPopStash restores the exact preflight marker when another same-milestone stash exists", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo, "README.md"), "# target stash\n");
    const preflight = preflightCleanRoot(repo, "M007", () => {
    });
    assert.equal(preflight.stashPushed, true, "must have stashed target change");
    assert.ok(preflight.stashMarker, "preflight must expose exact stash marker");
    writeFileSync(join(repo, "same-milestone.txt"), "newer same milestone stash\n");
    run('git stash push --include-untracked -m "gsd-preflight-stash [gsd-preflight-stash:M007:other]"', repo);
    const postflight = postflightPopStash(repo, "M007", preflight.stashMarker, () => {
    });
    assert.equal(postflight.needsManualRecovery, false, "exact marker restore must not need manual recovery");
    const content = readFileSync(join(repo, "README.md"), "utf-8");
    assert.equal(content.replace(/\r\n/g, "\n"), "# target stash\n");
    const stashList = run("git stash list", repo);
    assert.ok(stashList.includes("gsd-preflight-stash:M007:other"), "newer same-milestone stash must remain");
    assert.ok(!stashList.includes(preflight.stashMarker), "exact target stash should be consumed");
  } finally {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
});
test("postflightPopStash falls back to milestone marker prefix when exact marker is unavailable", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo, "README.md"), "# fallback stash\n");
    run('git stash push --include-untracked -m "gsd-preflight-stash [gsd-preflight-stash:M008:fallback]"', repo);
    const postflight = postflightPopStash(repo, "M008", void 0, () => {
    });
    assert.equal(postflight.needsManualRecovery, false, "fallback marker restore must not need manual recovery");
    const content = readFileSync(join(repo, "README.md"), "utf-8");
    assert.equal(content.replace(/\r\n/g, "\n"), "# fallback stash\n");
    const stashList = run("git stash list", repo);
    assert.ok(!stashList.includes("gsd-preflight-stash:M008:fallback"), "fallback stash should be consumed");
  } finally {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
});
test("postflightPopStash preserves stash when untracked collision differs from merged file", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo, "tests.txt"), "local preflight test\n");
    const preflight = preflightCleanRoot(repo, "M009", () => {
    });
    assert.equal(preflight.stashPushed, true, "preflight must stash untracked file");
    writeFileSync(join(repo, "tests.txt"), "merged milestone test\n");
    run("git add tests.txt", repo);
    run('git commit -m "feat: add merged test"', repo);
    const notifications = [];
    const postflight = postflightPopStash(repo, "M009", preflight.stashMarker, (msg, level) => {
      notifications.push({ msg, level });
    });
    assert.equal(postflight.needsManualRecovery, false, "different already-present untracked files must not stop auto-mode");
    assert.equal(postflight.resolution, "already-present-preserved");
    assert.deepEqual(postflight.collidedPaths, ["tests.txt"]);
    assert.equal(readFileSync(join(repo, "tests.txt"), "utf-8"), "merged milestone test\n");
    assert.equal(run("git status --porcelain", repo), "", "merged file must stay clean");
    const stashList = run("git stash list", repo);
    assert.ok(preflight.stashMarker && stashList.includes(preflight.stashMarker), "stash backup must be preserved");
    assert.ok(
      notifications.some((n) => n.level === "warning" && n.msg.includes("preserving")),
      "user must be warned that the stash was preserved as backup"
    );
  } finally {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
});
test("postflightPopStash drops stash when untracked collision is identical to merged file", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo, "tests.txt"), "same test content\n");
    const preflight = preflightCleanRoot(repo, "M010", () => {
    });
    assert.equal(preflight.stashPushed, true, "preflight must stash untracked file");
    writeFileSync(join(repo, "tests.txt"), "same test content\n");
    run("git add tests.txt", repo);
    run('git commit -m "feat: add same test"', repo);
    const postflight = postflightPopStash(repo, "M010", preflight.stashMarker, () => {
    });
    assert.equal(postflight.needsManualRecovery, false, "identical already-present files must not stop auto-mode");
    assert.equal(postflight.resolution, "already-present-dropped");
    assert.equal(readFileSync(join(repo, "tests.txt"), "utf-8"), "same test content\n");
    const stashList = run("git stash list", repo);
    assert.ok(!stashList.includes(preflight.stashMarker ?? ""), "identical stash must be dropped");
  } finally {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
});
test("postflightPopStash requires manual recovery for mixed tracked changes and untracked collision", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo, "README.md"), "# local tracked work\n");
    writeFileSync(join(repo, "tests.txt"), "local untracked work\n");
    const preflight = preflightCleanRoot(repo, "M011", () => {
    });
    assert.equal(preflight.stashPushed, true, "preflight must stash mixed changes");
    writeFileSync(join(repo, "tests.txt"), "merged milestone test\n");
    run("git add tests.txt", repo);
    run('git commit -m "feat: add merged test"', repo);
    const postflight = postflightPopStash(repo, "M011", preflight.stashMarker, () => {
    });
    assert.equal(postflight.needsManualRecovery, true, "tracked stash payload must still require manual recovery");
    assert.equal(postflight.resolution, "manual-recovery");
    const stashList = run("git stash list", repo);
    assert.ok(preflight.stashMarker && stashList.includes(preflight.stashMarker), "mixed stash must be preserved");
  } finally {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
});
test("postflightPopStash requires manual recovery when an untracked stash path is missing after collision", () => {
  const repo = createTempRepo();
  try {
    writeFileSync(join(repo, "tests.txt"), "local untracked work\n");
    writeFileSync(join(repo, "other-tests.txt"), "other local untracked work\n");
    const preflight = preflightCleanRoot(repo, "M012", () => {
    });
    assert.equal(preflight.stashPushed, true, "preflight must stash untracked files");
    writeFileSync(join(repo, "tests.txt"), "merged milestone test\n");
    run("git add tests.txt", repo);
    run('git commit -m "feat: add one merged test"', repo);
    const postflight = postflightPopStash(repo, "M012", preflight.stashMarker, () => {
    });
    assert.equal(postflight.needsManualRecovery, true, "partial untracked restores must still require manual recovery");
    assert.equal(postflight.resolution, "manual-recovery");
    assert.equal(existsSync(join(repo, "other-tests.txt")), true, "git may partially restore the non-colliding path");
    assert.match(run("git status --porcelain", repo), /\?\? other-tests\.txt/, "partial restore must leave manual recovery visible");
    const stashList = run("git stash list", repo);
    assert.ok(preflight.stashMarker && stashList.includes(preflight.stashMarker), "stash must remain for manual recovery");
  } finally {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jbGVhbi1yb290LXByZWZsaWdodC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIGNsZWFuLXJvb3QtcHJlZmxpZ2h0LnRlc3QudHMgXHUyMDE0IFJlZ3Jlc3Npb24gdGVzdHMgZm9yICMyOTA5LlxuICpcbiAqIFRlc3RzIHRoYXQgcHJlZmxpZ2h0Q2xlYW5Sb290IHdhcm5zICsgc3Rhc2hlcyBvbiBkaXJ0eSB0cmVlcyxcbiAqIGlzIGEgbm8tb3Agb24gY2xlYW4gdHJlZXMsIGFuZCB0aGF0IHBvc3RmbGlnaHRQb3BTdGFzaCByZXN0b3Jlc1xuICogc3Rhc2hlZCBjaGFuZ2VzIGFmdGVyIGEgbWVyZ2UuXG4gKi9cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMsIHJlYWRGaWxlU3luYywgcmVhbHBhdGhTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgZXhlY1N5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5cbmltcG9ydCB7IHByZWZsaWdodENsZWFuUm9vdCwgcG9zdGZsaWdodFBvcFN0YXNoIH0gZnJvbSBcIi4uL2NsZWFuLXJvb3QtcHJlZmxpZ2h0LnRzXCI7XG5cbmZ1bmN0aW9uIHJ1bihjbWQ6IHN0cmluZywgY3dkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gZXhlY1N5bmMoY21kLCB7IGN3ZCwgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLCBlbmNvZGluZzogXCJ1dGYtOFwiIH0pLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlVGVtcFJlcG8oKTogc3RyaW5nIHtcbiAgY29uc3QgZGlyID0gcmVhbHBhdGhTeW5jKG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXByZWZsaWdodC10ZXN0LVwiKSkpO1xuICBydW4oXCJnaXQgaW5pdFwiLCBkaXIpO1xuICBydW4oXCJnaXQgY29uZmlnIHVzZXIuZW1haWwgdGVzdEBleGFtcGxlLmNvbVwiLCBkaXIpO1xuICBydW4oXCJnaXQgY29uZmlnIHVzZXIubmFtZSBUZXN0XCIsIGRpcik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihkaXIsIFwiUkVBRE1FLm1kXCIpLCBcIiMgdGVzdFxcblwiKTtcbiAgbWtkaXJTeW5jKGpvaW4oZGlyLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCBcIi5nc2RcIiwgXCJTVEFURS5tZFwiKSwgXCIjIFN0YXRlXFxuXCIpO1xuICBydW4oXCJnaXQgYWRkIC5cIiwgZGlyKTtcbiAgcnVuKFwiZ2l0IGNvbW1pdCAtbSBpbml0XCIsIGRpcik7XG4gIHJ1bihcImdpdCBicmFuY2ggLU0gbWFpblwiLCBkaXIpO1xuICByZXR1cm4gZGlyO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgQ2xlYW4gdHJlZTogZmFzdC1wYXRoIHJldHVybnMgaW1tZWRpYXRlbHkgd2l0aG91dCBzdGFzaGluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInByZWZsaWdodENsZWFuUm9vdCBcdTIwMTQgY2xlYW4gdHJlZSByZXR1cm5zIHN0YXNoUHVzaGVkPWZhbHNlIGFuZCBlbWl0cyBubyBub3RpZmljYXRpb25zXCIsICgpID0+IHtcbiAgY29uc3QgcmVwbyA9IGNyZWF0ZVRlbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgY29uc3Qgbm90aWZpY2F0aW9uczogQXJyYXk8eyBtc2c6IHN0cmluZzsgbGV2ZWw6IHN0cmluZyB9PiA9IFtdO1xuICAgIGNvbnN0IHJlc3VsdCA9IHByZWZsaWdodENsZWFuUm9vdChyZXBvLCBcIk0wMDFcIiwgKG1zZywgbGV2ZWwpID0+IHtcbiAgICAgIG5vdGlmaWNhdGlvbnMucHVzaCh7IG1zZywgbGV2ZWwgfSk7XG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXNoUHVzaGVkLCBmYWxzZSwgXCJzdGFzaFB1c2hlZCBtdXN0IGJlIGZhbHNlIGZvciBjbGVhbiB0cmVlXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuc3VtbWFyeSwgXCJcIiwgXCJzdW1tYXJ5IG11c3QgYmUgZW1wdHkgZm9yIGNsZWFuIHRyZWVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKG5vdGlmaWNhdGlvbnMubGVuZ3RoLCAwLCBcIm5vIG5vdGlmaWNhdGlvbnMgb24gY2xlYW4gdHJlZVwiKTtcblxuICAgIC8vIFZlcmlmeSBubyBzdGFzaCB3YXMgY3JlYXRlZFxuICAgIGNvbnN0IHN0YXNoTGlzdCA9IHJ1bihcImdpdCBzdGFzaCBsaXN0XCIsIHJlcG8pO1xuICAgIGFzc2VydC5lcXVhbChzdGFzaExpc3QsIFwiXCIsIFwibm8gc3Rhc2ggZW50cnkgb24gY2xlYW4gdHJlZVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICB0cnkgeyBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlLCBtYXhSZXRyaWVzOiAzLCByZXRyeURlbGF5OiAxMDAgfSk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIERpcnR5IHRyZWU6IHdhcm5zLCBzdGFzaGVzLCByZXR1cm5zIHN0YXNoUHVzaGVkPXRydWUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJwcmVmbGlnaHRDbGVhblJvb3QgXHUyMDE0IGRpcnR5IHRyZWUgd2FybnMgdXNlciBhbmQgYXV0by1zdGFzaGVzXCIsICgpID0+IHtcbiAgY29uc3QgcmVwbyA9IGNyZWF0ZVRlbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgLy8gRGlydHkgYW4gZXhpc3RpbmcgdHJhY2tlZCBmaWxlXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwiUkVBRE1FLm1kXCIpLCBcIiMgbG9jYWxseSBtb2RpZmllZFxcblwiKTtcblxuICAgIGNvbnN0IG5vdGlmaWNhdGlvbnM6IEFycmF5PHsgbXNnOiBzdHJpbmc7IGxldmVsOiBzdHJpbmcgfT4gPSBbXTtcbiAgICBjb25zdCByZXN1bHQgPSBwcmVmbGlnaHRDbGVhblJvb3QocmVwbywgXCJNMDAyXCIsIChtc2csIGxldmVsKSA9PiB7XG4gICAgICBub3RpZmljYXRpb25zLnB1c2goeyBtc2csIGxldmVsIH0pO1xuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGFzaFB1c2hlZCwgdHJ1ZSwgXCJzdGFzaFB1c2hlZCBtdXN0IGJlIHRydWUgd2hlbiB0cmVlIHdhcyBkaXJ0eVwiKTtcbiAgICBhc3NlcnQub2socmVzdWx0LnN1bW1hcnkubGVuZ3RoID4gMCwgXCJzdW1tYXJ5IG11c3QgYmUgbm9uLWVtcHR5IHdoZW4gc3Rhc2ggd2FzIHB1c2hlZFwiKTtcblxuICAgIC8vIEEgd2FybmluZyBub3RpZmljYXRpb24gbXVzdCBoYXZlIGJlZW4gZW1pdHRlZCBiZWZvcmUgc3Rhc2hpbmdcbiAgICBhc3NlcnQub2soXG4gICAgICBub3RpZmljYXRpb25zLnNvbWUobiA9PiBuLmxldmVsID09PSBcIndhcm5pbmdcIiAmJiBuLm1zZy5pbmNsdWRlcyhcIk0wMDJcIikpLFxuICAgICAgXCJ3YXJuaW5nIG5vdGlmaWNhdGlvbiBtdXN0IG1lbnRpb24gdGhlIG1pbGVzdG9uZSBJRFwiLFxuICAgICk7XG5cbiAgICAvLyBXb3JraW5nIHRyZWUgbXVzdCBub3cgYmUgY2xlYW4gKHN0YXNoIHB1c2hlZClcbiAgICBjb25zdCBzdGF0dXMgPSBydW4oXCJnaXQgc3RhdHVzIC0tcG9yY2VsYWluXCIsIHJlcG8pO1xuICAgIGFzc2VydC5lcXVhbChzdGF0dXMsIFwiXCIsIFwid29ya2luZyB0cmVlIG11c3QgYmUgY2xlYW4gYWZ0ZXIgc3Rhc2ggcHVzaFwiKTtcblxuICAgIC8vIFRoZSBzdGFzaCBlbnRyeSBtdXN0IGV4aXN0XG4gICAgY29uc3Qgc3Rhc2hMaXN0ID0gcnVuKFwiZ2l0IHN0YXNoIGxpc3RcIiwgcmVwbyk7XG4gICAgYXNzZXJ0Lm9rKHN0YXNoTGlzdC5pbmNsdWRlcyhcImdzZC1wcmVmbGlnaHQtc3Rhc2hcIiksIFwic3Rhc2ggZW50cnkgbXVzdCBiZSBuYW1lZCBnc2QtcHJlZmxpZ2h0LXN0YXNoXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHRyeSB7IHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUsIG1heFJldHJpZXM6IDMsIHJldHJ5RGVsYXk6IDEwMCB9KTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgVW50cmFja2VkIGZpbGVzIGFyZSBhbHNvIHN0YXNoZWQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJwcmVmbGlnaHRDbGVhblJvb3QgXHUyMDE0IHVudHJhY2tlZCBmaWxlIHRyaWdnZXJzIHN0YXNoIHdpdGggLS1pbmNsdWRlLXVudHJhY2tlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlcG8gPSBjcmVhdGVUZW1wUmVwbygpO1xuICB0cnkge1xuICAgIC8vIEFkZCBhbiB1bnRyYWNrZWQgZmlsZVxuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcInVudHJhY2tlZC50c1wiKSwgXCJleHBvcnQgY29uc3QgeCA9IDE7XFxuXCIpO1xuXG4gICAgY29uc3Qgbm90aWZpY2F0aW9uczogQXJyYXk8eyBtc2c6IHN0cmluZzsgbGV2ZWw6IHN0cmluZyB9PiA9IFtdO1xuICAgIGNvbnN0IHJlc3VsdCA9IHByZWZsaWdodENsZWFuUm9vdChyZXBvLCBcIk0wMDNcIiwgKG1zZywgbGV2ZWwpID0+IHtcbiAgICAgIG5vdGlmaWNhdGlvbnMucHVzaCh7IG1zZywgbGV2ZWwgfSk7XG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXNoUHVzaGVkLCB0cnVlLCBcInN0YXNoUHVzaGVkIG11c3QgYmUgdHJ1ZSBmb3IgdW50cmFja2VkIGZpbGVcIik7XG5cbiAgICBjb25zdCBzdGF0dXMgPSBydW4oXCJnaXQgc3RhdHVzIC0tcG9yY2VsYWluXCIsIHJlcG8pO1xuICAgIGFzc2VydC5lcXVhbChzdGF0dXMsIFwiXCIsIFwid29ya2luZyB0cmVlIG11c3QgYmUgY2xlYW4gYWZ0ZXIgc3Rhc2ggcHVzaFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICB0cnkgeyBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlLCBtYXhSZXRyaWVzOiAzLCByZXRyeURlbGF5OiAxMDAgfSk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICB9XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIHBvc3RmbGlnaHRQb3BTdGFzaDogcmVzdG9yZXMgc3Rhc2hlZCBjaGFuZ2VzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwicG9zdGZsaWdodFBvcFN0YXNoIFx1MjAxNCByZXN0b3JlcyBzdGFzaGVkIGNoYW5nZXMgYW5kIGVtaXRzIGluZm8gbm90aWZpY2F0aW9uXCIsICgpID0+IHtcbiAgY29uc3QgcmVwbyA9IGNyZWF0ZVRlbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgLy8gRGlydHkgdGhlIHdvcmtpbmcgdHJlZVxuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcIlJFQURNRS5tZFwiKSwgXCIjIHN0YXNoIG1lXFxuXCIpO1xuXG4gICAgY29uc3QgcHJlTm90aWZpY2F0aW9uczogQXJyYXk8eyBtc2c6IHN0cmluZzsgbGV2ZWw6IHN0cmluZyB9PiA9IFtdO1xuICAgIGNvbnN0IHByZWZsaWdodCA9IHByZWZsaWdodENsZWFuUm9vdChyZXBvLCBcIk0wMDRcIiwgKG1zZywgbGV2ZWwpID0+IHtcbiAgICAgIHByZU5vdGlmaWNhdGlvbnMucHVzaCh7IG1zZywgbGV2ZWwgfSk7XG4gICAgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHByZWZsaWdodC5zdGFzaFB1c2hlZCwgdHJ1ZSwgXCJwcmVmbGlnaHQgbXVzdCBoYXZlIHN0YXNoZWRcIik7XG5cbiAgICAvLyBTaW11bGF0ZSB0aGUgbWVyZ2UgKGp1c3QgYSBuby1vcCBjb21taXQgaGVyZSlcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJtZXJnZWQudHNcIiksIFwiZXhwb3J0IGNvbnN0IG1lcmdlZCA9IHRydWU7XFxuXCIpO1xuICAgIHJ1bihcImdpdCBhZGQgLlwiLCByZXBvKTtcbiAgICBydW4oJ2dpdCBjb21taXQgLW0gXCJzaW11bGF0ZSBtZXJnZVwiJywgcmVwbyk7XG5cbiAgICBjb25zdCBwb3N0Tm90aWZpY2F0aW9uczogQXJyYXk8eyBtc2c6IHN0cmluZzsgbGV2ZWw6IHN0cmluZyB9PiA9IFtdO1xuICAgIGNvbnN0IHBvc3RmbGlnaHQgPSBwb3N0ZmxpZ2h0UG9wU3Rhc2gocmVwbywgXCJNMDA0XCIsIHByZWZsaWdodC5zdGFzaE1hcmtlciwgKG1zZywgbGV2ZWwpID0+IHtcbiAgICAgIHBvc3ROb3RpZmljYXRpb25zLnB1c2goeyBtc2csIGxldmVsIH0pO1xuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbChwb3N0ZmxpZ2h0LnJlc3RvcmVkLCB0cnVlLCBcInBvc3RmbGlnaHQgbXVzdCByZXBvcnQgc3VjY2Vzc2Z1bCByZXN0b3JlXCIpO1xuICAgIGFzc2VydC5lcXVhbChwb3N0ZmxpZ2h0Lm5lZWRzTWFudWFsUmVjb3ZlcnksIGZhbHNlLCBcInN1Y2Nlc3NmdWwgcmVzdG9yZSBtdXN0IG5vdCBuZWVkIG1hbnVhbCByZWNvdmVyeVwiKTtcblxuICAgIC8vIFRoZSBzdGFzaGVkIFJFQURNRS5tZCBjaGFuZ2UgbXVzdCBiZSByZXN0b3JlZFxuICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoam9pbihyZXBvLCBcIlJFQURNRS5tZFwiKSwgXCJ1dGYtOFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoY29udGVudC5yZXBsYWNlKC9cXHJcXG4vZywgXCJcXG5cIiksIFwiIyBzdGFzaCBtZVxcblwiLCBcInN0YXNoZWQgZmlsZSBtdXN0IGJlIHJlc3RvcmVkXCIpO1xuXG4gICAgLy8gQW4gaW5mbyBub3RpZmljYXRpb24gbXVzdCBoYXZlIGJlZW4gZW1pdHRlZFxuICAgIGFzc2VydC5vayhcbiAgICAgIHBvc3ROb3RpZmljYXRpb25zLnNvbWUobiA9PiBuLmxldmVsID09PSBcImluZm9cIiAmJiBuLm1zZy5pbmNsdWRlcyhcIk0wMDRcIikpLFxuICAgICAgXCJpbmZvIG5vdGlmaWNhdGlvbiBtdXN0IG1lbnRpb24gbWlsZXN0b25lIElEIGFmdGVyIHBvcFwiLFxuICAgICk7XG5cbiAgICAvLyBTdGFzaCBsaXN0IG11c3QgYmUgZW1wdHlcbiAgICBjb25zdCBzdGFzaExpc3QgPSBydW4oXCJnaXQgc3Rhc2ggbGlzdFwiLCByZXBvKTtcbiAgICBhc3NlcnQuZXF1YWwoc3Rhc2hMaXN0LCBcIlwiLCBcInN0YXNoIGxpc3QgbXVzdCBiZSBlbXB0eSBhZnRlciBwb3BcIik7XG4gIH0gZmluYWxseSB7XG4gICAgdHJ5IHsgcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSwgbWF4UmV0cmllczogMywgcmV0cnlEZWxheTogMTAwIH0pOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMCBSb3VuZC10cmlwOiBwcmVmbGlnaHQgKyBtZXJnZSArIHBvc3RmbGlnaHQgcHJlc2VydmVzIGNoYW5nZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJwcmVmbGlnaHQgKyBtZXJnZSArIHBvc3RmbGlnaHQgcm91bmQtdHJpcCBwcmVzZXJ2ZXMgdW5jb21taXR0ZWQgY2hhbmdlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlcG8gPSBjcmVhdGVUZW1wUmVwbygpO1xuICB0cnkge1xuICAgIGNvbnN0IG9yaWdpbmFsQ29udGVudCA9IFwiIyBteSBsb2NhbCB3b3JrXFxuXCI7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwiUkVBRE1FLm1kXCIpLCBvcmlnaW5hbENvbnRlbnQpO1xuXG4gICAgLy8gUHJlZmxpZ2h0OiBzdGFzaFxuICAgIGNvbnN0IHByZWZsaWdodCA9IHByZWZsaWdodENsZWFuUm9vdChyZXBvLCBcIk0wMDVcIiwgKCkgPT4ge30pO1xuICAgIGFzc2VydC5lcXVhbChwcmVmbGlnaHQuc3Rhc2hQdXNoZWQsIHRydWUsIFwibXVzdCBoYXZlIHN0YXNoZWRcIik7XG5cbiAgICAvLyBNZXJnZTogaW50cm9kdWNlIGEgbmV3IGZpbGUgKG5vIG92ZXJsYXAgd2l0aCBSRUFETUUubWQpXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwiZmVhdHVyZS50c1wiKSwgXCJleHBvcnQgY29uc3QgZmVhdHVyZSA9IHRydWU7XFxuXCIpO1xuICAgIHJ1bihcImdpdCBhZGQgZmVhdHVyZS50c1wiLCByZXBvKTtcbiAgICBydW4oJ2dpdCBjb21taXQgLW0gXCJmZWF0OiBhZGQgZmVhdHVyZVwiJywgcmVwbyk7XG5cbiAgICAvLyBQb3N0ZmxpZ2h0OiBwb3Agc3Rhc2hcbiAgICBjb25zdCBwb3N0ZmxpZ2h0ID0gcG9zdGZsaWdodFBvcFN0YXNoKHJlcG8sIFwiTTAwNVwiLCBwcmVmbGlnaHQuc3Rhc2hNYXJrZXIsICgpID0+IHt9KTtcbiAgICBhc3NlcnQuZXF1YWwocG9zdGZsaWdodC5uZWVkc01hbnVhbFJlY292ZXJ5LCBmYWxzZSwgXCJjbGVhbiByZXN0b3JlIG11c3Qgbm90IHN0b3AgYXV0by1tb2RlXCIpO1xuXG4gICAgLy8gUkVBRE1FLm1kIG11c3Qgc3RpbGwgaGF2ZSBvdXIgbG9jYWwgY29udGVudFxuICAgIGNvbnN0IHJlc3RvcmVkID0gcmVhZEZpbGVTeW5jKGpvaW4ocmVwbywgXCJSRUFETUUubWRcIiksIFwidXRmLThcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3RvcmVkLnJlcGxhY2UoL1xcclxcbi9nLCBcIlxcblwiKSwgb3JpZ2luYWxDb250ZW50LCBcImxvY2FsIGNoYW5nZXMgbXVzdCBzdXJ2aXZlIG1lcmdlXCIpO1xuXG4gICAgLy8gZmVhdHVyZS50cyBtdXN0IGFsc28gZXhpc3QgKHRoZSBtZXJnZSBjb21taXQgbGFuZGVkKVxuICAgIGNvbnN0IGZlYXR1cmVDb250ZW50ID0gcmVhZEZpbGVTeW5jKGpvaW4ocmVwbywgXCJmZWF0dXJlLnRzXCIpLCBcInV0Zi04XCIpO1xuICAgIGFzc2VydC5vayhmZWF0dXJlQ29udGVudC5pbmNsdWRlcyhcImZlYXR1cmVcIiksIFwibWVyZ2VkIGZlYXR1cmUgbXVzdCBiZSBwcmVzZW50XCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHRyeSB7IHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUsIG1heFJldHJpZXM6IDMsIHJldHJ5RGVsYXk6IDEwMCB9KTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gIH1cbn0pO1xuXG50ZXN0KFwicG9zdGZsaWdodFBvcFN0YXNoIGNvbmZsaWN0IHdhcm5pbmcgbmFtZXMgdGhlIGV4YWN0IHN0YXNoIHJlZlwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlcG8gPSBjcmVhdGVUZW1wUmVwbygpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcIlJFQURNRS5tZFwiKSwgXCIjIGxvY2FsIHdvcmtcXG5cIik7XG4gICAgY29uc3QgcHJlZmxpZ2h0ID0gcHJlZmxpZ2h0Q2xlYW5Sb290KHJlcG8sIFwiTTAwNUNcIiwgKCkgPT4ge30pO1xuICAgIGFzc2VydC5lcXVhbChwcmVmbGlnaHQuc3Rhc2hQdXNoZWQsIHRydWUsIFwibXVzdCBoYXZlIHN0YXNoZWRcIik7XG5cbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJSRUFETUUubWRcIiksIFwiIyBtZXJnZWQgd29ya1xcblwiKTtcbiAgICBydW4oXCJnaXQgYWRkIFJFQURNRS5tZFwiLCByZXBvKTtcbiAgICBydW4oJ2dpdCBjb21taXQgLW0gXCJzaW11bGF0ZSBjb25mbGljdGluZyBtZXJnZVwiJywgcmVwbyk7XG5cbiAgICBjb25zdCBub3RpZmljYXRpb25zOiBBcnJheTx7IG1zZzogc3RyaW5nOyBsZXZlbDogc3RyaW5nIH0+ID0gW107XG4gICAgY29uc3QgcG9zdGZsaWdodCA9IHBvc3RmbGlnaHRQb3BTdGFzaChyZXBvLCBcIk0wMDVDXCIsIHByZWZsaWdodC5zdGFzaE1hcmtlciwgKG1zZywgbGV2ZWwpID0+IHtcbiAgICAgIG5vdGlmaWNhdGlvbnMucHVzaCh7IG1zZywgbGV2ZWwgfSk7XG4gICAgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHBvc3RmbGlnaHQucmVzdG9yZWQsIGZhbHNlLCBcImNvbmZsaWN0ZWQgcmVzdG9yZSBtdXN0IHJlcG9ydCByZXN0b3JlZD1mYWxzZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocG9zdGZsaWdodC5uZWVkc01hbnVhbFJlY292ZXJ5LCB0cnVlLCBcImNvbmZsaWN0ZWQgcmVzdG9yZSBtdXN0IHJlcXVpcmUgbWFudWFsIHJlY292ZXJ5XCIpO1xuICAgIGFzc2VydC5tYXRjaChwb3N0ZmxpZ2h0Lm1lc3NhZ2UsIC9mYWlsZWQgYWZ0ZXIgbWVyZ2Ugb2YgbWlsZXN0b25lIE0wMDVDLyk7XG5cbiAgICBjb25zdCB3YXJuaW5nID0gbm90aWZpY2F0aW9ucy5maW5kKChuKSA9PiBuLmxldmVsID09PSBcIndhcm5pbmdcIik/Lm1zZyA/PyBcIlwiO1xuICAgIGFzc2VydC5tYXRjaCh3YXJuaW5nLCAvZ2l0IHN0YXNoIGFwcGx5IHN0YXNoQFxce1xcZCtcXH0vKTtcbiAgICBhc3NlcnQubWF0Y2god2FybmluZywgL2dpdCBzdGFzaCBkcm9wIHN0YXNoQFxce1xcZCtcXH0vKTtcbiAgfSBmaW5hbGx5IHtcbiAgICB0cnkgeyBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlLCBtYXhSZXRyaWVzOiAzLCByZXRyeURlbGF5OiAxMDAgfSk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICB9XG59KTtcblxudGVzdChcInBvc3RmbGlnaHRQb3BTdGFzaCByZXN0b3JlcyB0aGUgbWF0Y2hpbmcgR1NEIHN0YXNoLCBub3Qgc3Rhc2hAezB9XCIsICgpID0+IHtcbiAgY29uc3QgcmVwbyA9IGNyZWF0ZVRlbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwiUkVBRE1FLm1kXCIpLCBcIiMgdGFyZ2V0IHN0YXNoXFxuXCIpO1xuICAgIGNvbnN0IHByZWZsaWdodCA9IHByZWZsaWdodENsZWFuUm9vdChyZXBvLCBcIk0wMDZcIiwgKCkgPT4ge30pO1xuICAgIGFzc2VydC5lcXVhbChwcmVmbGlnaHQuc3Rhc2hQdXNoZWQsIHRydWUsIFwibXVzdCBoYXZlIHN0YXNoZWQgdGFyZ2V0IGNoYW5nZVwiKTtcblxuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcIm90aGVyLnR4dFwiKSwgXCJvdGhlciBzdGFzaFxcblwiKTtcbiAgICBydW4oJ2dpdCBzdGFzaCBwdXNoIC0taW5jbHVkZS11bnRyYWNrZWQgLW0gXCJ1bnJlbGF0ZWQgbmV3ZXIgc3Rhc2hcIicsIHJlcG8pO1xuXG4gICAgY29uc3QgcG9zdGZsaWdodCA9IHBvc3RmbGlnaHRQb3BTdGFzaChyZXBvLCBcIk0wMDZcIiwgcHJlZmxpZ2h0LnN0YXNoTWFya2VyLCAoKSA9PiB7fSk7XG4gICAgYXNzZXJ0LmVxdWFsKHBvc3RmbGlnaHQubmVlZHNNYW51YWxSZWNvdmVyeSwgZmFsc2UsIFwidGFyZ2V0ZWQgcmVzdG9yZSBtdXN0IG5vdCBuZWVkIG1hbnVhbCByZWNvdmVyeVwiKTtcblxuICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoam9pbihyZXBvLCBcIlJFQURNRS5tZFwiKSwgXCJ1dGYtOFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoY29udGVudC5yZXBsYWNlKC9cXHJcXG4vZywgXCJcXG5cIiksIFwiIyB0YXJnZXQgc3Rhc2hcXG5cIik7XG4gICAgY29uc3Qgc3Rhc2hMaXN0ID0gcnVuKFwiZ2l0IHN0YXNoIGxpc3RcIiwgcmVwbyk7XG4gICAgYXNzZXJ0Lm9rKHN0YXNoTGlzdC5pbmNsdWRlcyhcInVucmVsYXRlZCBuZXdlciBzdGFzaFwiKSwgXCJ1bnJlbGF0ZWQgbmV3ZXIgc3Rhc2ggbXVzdCByZW1haW5cIik7XG4gICAgYXNzZXJ0Lm9rKCFzdGFzaExpc3QuaW5jbHVkZXMoXCJnc2QtcHJlZmxpZ2h0LXN0YXNoIFtnc2QtcHJlZmxpZ2h0LXN0YXNoOk0wMDZcIiksIFwidGFyZ2V0IHN0YXNoIHNob3VsZCBiZSBjb25zdW1lZFwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICB0cnkgeyBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlLCBtYXhSZXRyaWVzOiAzLCByZXRyeURlbGF5OiAxMDAgfSk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICB9XG59KTtcblxudGVzdChcInBvc3RmbGlnaHRQb3BTdGFzaCByZXN0b3JlcyB0aGUgZXhhY3QgcHJlZmxpZ2h0IG1hcmtlciB3aGVuIGFub3RoZXIgc2FtZS1taWxlc3RvbmUgc3Rhc2ggZXhpc3RzXCIsICgpID0+IHtcbiAgY29uc3QgcmVwbyA9IGNyZWF0ZVRlbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwiUkVBRE1FLm1kXCIpLCBcIiMgdGFyZ2V0IHN0YXNoXFxuXCIpO1xuICAgIGNvbnN0IHByZWZsaWdodCA9IHByZWZsaWdodENsZWFuUm9vdChyZXBvLCBcIk0wMDdcIiwgKCkgPT4ge30pO1xuICAgIGFzc2VydC5lcXVhbChwcmVmbGlnaHQuc3Rhc2hQdXNoZWQsIHRydWUsIFwibXVzdCBoYXZlIHN0YXNoZWQgdGFyZ2V0IGNoYW5nZVwiKTtcbiAgICBhc3NlcnQub2socHJlZmxpZ2h0LnN0YXNoTWFya2VyLCBcInByZWZsaWdodCBtdXN0IGV4cG9zZSBleGFjdCBzdGFzaCBtYXJrZXJcIik7XG5cbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJzYW1lLW1pbGVzdG9uZS50eHRcIiksIFwibmV3ZXIgc2FtZSBtaWxlc3RvbmUgc3Rhc2hcXG5cIik7XG4gICAgcnVuKCdnaXQgc3Rhc2ggcHVzaCAtLWluY2x1ZGUtdW50cmFja2VkIC1tIFwiZ3NkLXByZWZsaWdodC1zdGFzaCBbZ3NkLXByZWZsaWdodC1zdGFzaDpNMDA3Om90aGVyXVwiJywgcmVwbyk7XG5cbiAgICBjb25zdCBwb3N0ZmxpZ2h0ID0gcG9zdGZsaWdodFBvcFN0YXNoKHJlcG8sIFwiTTAwN1wiLCBwcmVmbGlnaHQuc3Rhc2hNYXJrZXIsICgpID0+IHt9KTtcbiAgICBhc3NlcnQuZXF1YWwocG9zdGZsaWdodC5uZWVkc01hbnVhbFJlY292ZXJ5LCBmYWxzZSwgXCJleGFjdCBtYXJrZXIgcmVzdG9yZSBtdXN0IG5vdCBuZWVkIG1hbnVhbCByZWNvdmVyeVwiKTtcblxuICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoam9pbihyZXBvLCBcIlJFQURNRS5tZFwiKSwgXCJ1dGYtOFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoY29udGVudC5yZXBsYWNlKC9cXHJcXG4vZywgXCJcXG5cIiksIFwiIyB0YXJnZXQgc3Rhc2hcXG5cIik7XG4gICAgY29uc3Qgc3Rhc2hMaXN0ID0gcnVuKFwiZ2l0IHN0YXNoIGxpc3RcIiwgcmVwbyk7XG4gICAgYXNzZXJ0Lm9rKHN0YXNoTGlzdC5pbmNsdWRlcyhcImdzZC1wcmVmbGlnaHQtc3Rhc2g6TTAwNzpvdGhlclwiKSwgXCJuZXdlciBzYW1lLW1pbGVzdG9uZSBzdGFzaCBtdXN0IHJlbWFpblwiKTtcbiAgICBhc3NlcnQub2soIXN0YXNoTGlzdC5pbmNsdWRlcyhwcmVmbGlnaHQuc3Rhc2hNYXJrZXIpLCBcImV4YWN0IHRhcmdldCBzdGFzaCBzaG91bGQgYmUgY29uc3VtZWRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgdHJ5IHsgcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSwgbWF4UmV0cmllczogMywgcmV0cnlEZWxheTogMTAwIH0pOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgfVxufSk7XG5cbnRlc3QoXCJwb3N0ZmxpZ2h0UG9wU3Rhc2ggZmFsbHMgYmFjayB0byBtaWxlc3RvbmUgbWFya2VyIHByZWZpeCB3aGVuIGV4YWN0IG1hcmtlciBpcyB1bmF2YWlsYWJsZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlcG8gPSBjcmVhdGVUZW1wUmVwbygpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcIlJFQURNRS5tZFwiKSwgXCIjIGZhbGxiYWNrIHN0YXNoXFxuXCIpO1xuICAgIHJ1bignZ2l0IHN0YXNoIHB1c2ggLS1pbmNsdWRlLXVudHJhY2tlZCAtbSBcImdzZC1wcmVmbGlnaHQtc3Rhc2ggW2dzZC1wcmVmbGlnaHQtc3Rhc2g6TTAwODpmYWxsYmFja11cIicsIHJlcG8pO1xuXG4gICAgY29uc3QgcG9zdGZsaWdodCA9IHBvc3RmbGlnaHRQb3BTdGFzaChyZXBvLCBcIk0wMDhcIiwgdW5kZWZpbmVkLCAoKSA9PiB7fSk7XG4gICAgYXNzZXJ0LmVxdWFsKHBvc3RmbGlnaHQubmVlZHNNYW51YWxSZWNvdmVyeSwgZmFsc2UsIFwiZmFsbGJhY2sgbWFya2VyIHJlc3RvcmUgbXVzdCBub3QgbmVlZCBtYW51YWwgcmVjb3ZlcnlcIik7XG5cbiAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGpvaW4ocmVwbywgXCJSRUFETUUubWRcIiksIFwidXRmLThcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGNvbnRlbnQucmVwbGFjZSgvXFxyXFxuL2csIFwiXFxuXCIpLCBcIiMgZmFsbGJhY2sgc3Rhc2hcXG5cIik7XG4gICAgY29uc3Qgc3Rhc2hMaXN0ID0gcnVuKFwiZ2l0IHN0YXNoIGxpc3RcIiwgcmVwbyk7XG4gICAgYXNzZXJ0Lm9rKCFzdGFzaExpc3QuaW5jbHVkZXMoXCJnc2QtcHJlZmxpZ2h0LXN0YXNoOk0wMDg6ZmFsbGJhY2tcIiksIFwiZmFsbGJhY2sgc3Rhc2ggc2hvdWxkIGJlIGNvbnN1bWVkXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHRyeSB7IHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUsIG1heFJldHJpZXM6IDMsIHJldHJ5RGVsYXk6IDEwMCB9KTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gIH1cbn0pO1xuXG50ZXN0KFwicG9zdGZsaWdodFBvcFN0YXNoIHByZXNlcnZlcyBzdGFzaCB3aGVuIHVudHJhY2tlZCBjb2xsaXNpb24gZGlmZmVycyBmcm9tIG1lcmdlZCBmaWxlXCIsICgpID0+IHtcbiAgY29uc3QgcmVwbyA9IGNyZWF0ZVRlbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwidGVzdHMudHh0XCIpLCBcImxvY2FsIHByZWZsaWdodCB0ZXN0XFxuXCIpO1xuICAgIGNvbnN0IHByZWZsaWdodCA9IHByZWZsaWdodENsZWFuUm9vdChyZXBvLCBcIk0wMDlcIiwgKCkgPT4ge30pO1xuICAgIGFzc2VydC5lcXVhbChwcmVmbGlnaHQuc3Rhc2hQdXNoZWQsIHRydWUsIFwicHJlZmxpZ2h0IG11c3Qgc3Rhc2ggdW50cmFja2VkIGZpbGVcIik7XG5cbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJ0ZXN0cy50eHRcIiksIFwibWVyZ2VkIG1pbGVzdG9uZSB0ZXN0XFxuXCIpO1xuICAgIHJ1bihcImdpdCBhZGQgdGVzdHMudHh0XCIsIHJlcG8pO1xuICAgIHJ1bignZ2l0IGNvbW1pdCAtbSBcImZlYXQ6IGFkZCBtZXJnZWQgdGVzdFwiJywgcmVwbyk7XG5cbiAgICBjb25zdCBub3RpZmljYXRpb25zOiBBcnJheTx7IG1zZzogc3RyaW5nOyBsZXZlbDogc3RyaW5nIH0+ID0gW107XG4gICAgY29uc3QgcG9zdGZsaWdodCA9IHBvc3RmbGlnaHRQb3BTdGFzaChyZXBvLCBcIk0wMDlcIiwgcHJlZmxpZ2h0LnN0YXNoTWFya2VyLCAobXNnLCBsZXZlbCkgPT4ge1xuICAgICAgbm90aWZpY2F0aW9ucy5wdXNoKHsgbXNnLCBsZXZlbCB9KTtcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChwb3N0ZmxpZ2h0Lm5lZWRzTWFudWFsUmVjb3ZlcnksIGZhbHNlLCBcImRpZmZlcmVudCBhbHJlYWR5LXByZXNlbnQgdW50cmFja2VkIGZpbGVzIG11c3Qgbm90IHN0b3AgYXV0by1tb2RlXCIpO1xuICAgIGFzc2VydC5lcXVhbChwb3N0ZmxpZ2h0LnJlc29sdXRpb24sIFwiYWxyZWFkeS1wcmVzZW50LXByZXNlcnZlZFwiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHBvc3RmbGlnaHQuY29sbGlkZWRQYXRocywgW1widGVzdHMudHh0XCJdKTtcbiAgICBhc3NlcnQuZXF1YWwocmVhZEZpbGVTeW5jKGpvaW4ocmVwbywgXCJ0ZXN0cy50eHRcIiksIFwidXRmLThcIiksIFwibWVyZ2VkIG1pbGVzdG9uZSB0ZXN0XFxuXCIpO1xuICAgIGFzc2VydC5lcXVhbChydW4oXCJnaXQgc3RhdHVzIC0tcG9yY2VsYWluXCIsIHJlcG8pLCBcIlwiLCBcIm1lcmdlZCBmaWxlIG11c3Qgc3RheSBjbGVhblwiKTtcblxuICAgIGNvbnN0IHN0YXNoTGlzdCA9IHJ1bihcImdpdCBzdGFzaCBsaXN0XCIsIHJlcG8pO1xuICAgIGFzc2VydC5vayhwcmVmbGlnaHQuc3Rhc2hNYXJrZXIgJiYgc3Rhc2hMaXN0LmluY2x1ZGVzKHByZWZsaWdodC5zdGFzaE1hcmtlciksIFwic3Rhc2ggYmFja3VwIG11c3QgYmUgcHJlc2VydmVkXCIpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIG5vdGlmaWNhdGlvbnMuc29tZSgobikgPT4gbi5sZXZlbCA9PT0gXCJ3YXJuaW5nXCIgJiYgbi5tc2cuaW5jbHVkZXMoXCJwcmVzZXJ2aW5nXCIpKSxcbiAgICAgIFwidXNlciBtdXN0IGJlIHdhcm5lZCB0aGF0IHRoZSBzdGFzaCB3YXMgcHJlc2VydmVkIGFzIGJhY2t1cFwiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgdHJ5IHsgcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSwgbWF4UmV0cmllczogMywgcmV0cnlEZWxheTogMTAwIH0pOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgfVxufSk7XG5cbnRlc3QoXCJwb3N0ZmxpZ2h0UG9wU3Rhc2ggZHJvcHMgc3Rhc2ggd2hlbiB1bnRyYWNrZWQgY29sbGlzaW9uIGlzIGlkZW50aWNhbCB0byBtZXJnZWQgZmlsZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlcG8gPSBjcmVhdGVUZW1wUmVwbygpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcInRlc3RzLnR4dFwiKSwgXCJzYW1lIHRlc3QgY29udGVudFxcblwiKTtcbiAgICBjb25zdCBwcmVmbGlnaHQgPSBwcmVmbGlnaHRDbGVhblJvb3QocmVwbywgXCJNMDEwXCIsICgpID0+IHt9KTtcbiAgICBhc3NlcnQuZXF1YWwocHJlZmxpZ2h0LnN0YXNoUHVzaGVkLCB0cnVlLCBcInByZWZsaWdodCBtdXN0IHN0YXNoIHVudHJhY2tlZCBmaWxlXCIpO1xuXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwidGVzdHMudHh0XCIpLCBcInNhbWUgdGVzdCBjb250ZW50XFxuXCIpO1xuICAgIHJ1bihcImdpdCBhZGQgdGVzdHMudHh0XCIsIHJlcG8pO1xuICAgIHJ1bignZ2l0IGNvbW1pdCAtbSBcImZlYXQ6IGFkZCBzYW1lIHRlc3RcIicsIHJlcG8pO1xuXG4gICAgY29uc3QgcG9zdGZsaWdodCA9IHBvc3RmbGlnaHRQb3BTdGFzaChyZXBvLCBcIk0wMTBcIiwgcHJlZmxpZ2h0LnN0YXNoTWFya2VyLCAoKSA9PiB7fSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocG9zdGZsaWdodC5uZWVkc01hbnVhbFJlY292ZXJ5LCBmYWxzZSwgXCJpZGVudGljYWwgYWxyZWFkeS1wcmVzZW50IGZpbGVzIG11c3Qgbm90IHN0b3AgYXV0by1tb2RlXCIpO1xuICAgIGFzc2VydC5lcXVhbChwb3N0ZmxpZ2h0LnJlc29sdXRpb24sIFwiYWxyZWFkeS1wcmVzZW50LWRyb3BwZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlYWRGaWxlU3luYyhqb2luKHJlcG8sIFwidGVzdHMudHh0XCIpLCBcInV0Zi04XCIpLCBcInNhbWUgdGVzdCBjb250ZW50XFxuXCIpO1xuXG4gICAgY29uc3Qgc3Rhc2hMaXN0ID0gcnVuKFwiZ2l0IHN0YXNoIGxpc3RcIiwgcmVwbyk7XG4gICAgYXNzZXJ0Lm9rKCFzdGFzaExpc3QuaW5jbHVkZXMocHJlZmxpZ2h0LnN0YXNoTWFya2VyID8/IFwiXCIpLCBcImlkZW50aWNhbCBzdGFzaCBtdXN0IGJlIGRyb3BwZWRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgdHJ5IHsgcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSwgbWF4UmV0cmllczogMywgcmV0cnlEZWxheTogMTAwIH0pOyB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgfVxufSk7XG5cbnRlc3QoXCJwb3N0ZmxpZ2h0UG9wU3Rhc2ggcmVxdWlyZXMgbWFudWFsIHJlY292ZXJ5IGZvciBtaXhlZCB0cmFja2VkIGNoYW5nZXMgYW5kIHVudHJhY2tlZCBjb2xsaXNpb25cIiwgKCkgPT4ge1xuICBjb25zdCByZXBvID0gY3JlYXRlVGVtcFJlcG8oKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJSRUFETUUubWRcIiksIFwiIyBsb2NhbCB0cmFja2VkIHdvcmtcXG5cIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwidGVzdHMudHh0XCIpLCBcImxvY2FsIHVudHJhY2tlZCB3b3JrXFxuXCIpO1xuICAgIGNvbnN0IHByZWZsaWdodCA9IHByZWZsaWdodENsZWFuUm9vdChyZXBvLCBcIk0wMTFcIiwgKCkgPT4ge30pO1xuICAgIGFzc2VydC5lcXVhbChwcmVmbGlnaHQuc3Rhc2hQdXNoZWQsIHRydWUsIFwicHJlZmxpZ2h0IG11c3Qgc3Rhc2ggbWl4ZWQgY2hhbmdlc1wiKTtcblxuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcInRlc3RzLnR4dFwiKSwgXCJtZXJnZWQgbWlsZXN0b25lIHRlc3RcXG5cIik7XG4gICAgcnVuKFwiZ2l0IGFkZCB0ZXN0cy50eHRcIiwgcmVwbyk7XG4gICAgcnVuKCdnaXQgY29tbWl0IC1tIFwiZmVhdDogYWRkIG1lcmdlZCB0ZXN0XCInLCByZXBvKTtcblxuICAgIGNvbnN0IHBvc3RmbGlnaHQgPSBwb3N0ZmxpZ2h0UG9wU3Rhc2gocmVwbywgXCJNMDExXCIsIHByZWZsaWdodC5zdGFzaE1hcmtlciwgKCkgPT4ge30pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHBvc3RmbGlnaHQubmVlZHNNYW51YWxSZWNvdmVyeSwgdHJ1ZSwgXCJ0cmFja2VkIHN0YXNoIHBheWxvYWQgbXVzdCBzdGlsbCByZXF1aXJlIG1hbnVhbCByZWNvdmVyeVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocG9zdGZsaWdodC5yZXNvbHV0aW9uLCBcIm1hbnVhbC1yZWNvdmVyeVwiKTtcbiAgICBjb25zdCBzdGFzaExpc3QgPSBydW4oXCJnaXQgc3Rhc2ggbGlzdFwiLCByZXBvKTtcbiAgICBhc3NlcnQub2socHJlZmxpZ2h0LnN0YXNoTWFya2VyICYmIHN0YXNoTGlzdC5pbmNsdWRlcyhwcmVmbGlnaHQuc3Rhc2hNYXJrZXIpLCBcIm1peGVkIHN0YXNoIG11c3QgYmUgcHJlc2VydmVkXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHRyeSB7IHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUsIG1heFJldHJpZXM6IDMsIHJldHJ5RGVsYXk6IDEwMCB9KTsgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gIH1cbn0pO1xuXG50ZXN0KFwicG9zdGZsaWdodFBvcFN0YXNoIHJlcXVpcmVzIG1hbnVhbCByZWNvdmVyeSB3aGVuIGFuIHVudHJhY2tlZCBzdGFzaCBwYXRoIGlzIG1pc3NpbmcgYWZ0ZXIgY29sbGlzaW9uXCIsICgpID0+IHtcbiAgY29uc3QgcmVwbyA9IGNyZWF0ZVRlbXBSZXBvKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwidGVzdHMudHh0XCIpLCBcImxvY2FsIHVudHJhY2tlZCB3b3JrXFxuXCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcIm90aGVyLXRlc3RzLnR4dFwiKSwgXCJvdGhlciBsb2NhbCB1bnRyYWNrZWQgd29ya1xcblwiKTtcbiAgICBjb25zdCBwcmVmbGlnaHQgPSBwcmVmbGlnaHRDbGVhblJvb3QocmVwbywgXCJNMDEyXCIsICgpID0+IHt9KTtcbiAgICBhc3NlcnQuZXF1YWwocHJlZmxpZ2h0LnN0YXNoUHVzaGVkLCB0cnVlLCBcInByZWZsaWdodCBtdXN0IHN0YXNoIHVudHJhY2tlZCBmaWxlc1wiKTtcblxuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcInRlc3RzLnR4dFwiKSwgXCJtZXJnZWQgbWlsZXN0b25lIHRlc3RcXG5cIik7XG4gICAgcnVuKFwiZ2l0IGFkZCB0ZXN0cy50eHRcIiwgcmVwbyk7XG4gICAgcnVuKCdnaXQgY29tbWl0IC1tIFwiZmVhdDogYWRkIG9uZSBtZXJnZWQgdGVzdFwiJywgcmVwbyk7XG5cbiAgICBjb25zdCBwb3N0ZmxpZ2h0ID0gcG9zdGZsaWdodFBvcFN0YXNoKHJlcG8sIFwiTTAxMlwiLCBwcmVmbGlnaHQuc3Rhc2hNYXJrZXIsICgpID0+IHt9KTtcblxuICAgIGFzc2VydC5lcXVhbChwb3N0ZmxpZ2h0Lm5lZWRzTWFudWFsUmVjb3ZlcnksIHRydWUsIFwicGFydGlhbCB1bnRyYWNrZWQgcmVzdG9yZXMgbXVzdCBzdGlsbCByZXF1aXJlIG1hbnVhbCByZWNvdmVyeVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocG9zdGZsaWdodC5yZXNvbHV0aW9uLCBcIm1hbnVhbC1yZWNvdmVyeVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoZXhpc3RzU3luYyhqb2luKHJlcG8sIFwib3RoZXItdGVzdHMudHh0XCIpKSwgdHJ1ZSwgXCJnaXQgbWF5IHBhcnRpYWxseSByZXN0b3JlIHRoZSBub24tY29sbGlkaW5nIHBhdGhcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHJ1bihcImdpdCBzdGF0dXMgLS1wb3JjZWxhaW5cIiwgcmVwbyksIC9cXD9cXD8gb3RoZXItdGVzdHNcXC50eHQvLCBcInBhcnRpYWwgcmVzdG9yZSBtdXN0IGxlYXZlIG1hbnVhbCByZWNvdmVyeSB2aXNpYmxlXCIpO1xuICAgIGNvbnN0IHN0YXNoTGlzdCA9IHJ1bihcImdpdCBzdGFzaCBsaXN0XCIsIHJlcG8pO1xuICAgIGFzc2VydC5vayhwcmVmbGlnaHQuc3Rhc2hNYXJrZXIgJiYgc3Rhc2hMaXN0LmluY2x1ZGVzKHByZWZsaWdodC5zdGFzaE1hcmtlciksIFwic3Rhc2ggbXVzdCByZW1haW4gZm9yIG1hbnVhbCByZWNvdmVyeVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICB0cnkgeyBybVN5bmMocmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlLCBtYXhSZXRyaWVzOiAzLCByZXRyeURlbGF5OiAxMDAgfSk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxZQUFZLGFBQWEsV0FBVyxlQUFlLFFBQVEsY0FBYyxvQkFBb0I7QUFDdEcsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QixTQUFTLGdCQUFnQjtBQUV6QixTQUFTLG9CQUFvQiwwQkFBMEI7QUFFdkQsU0FBUyxJQUFJLEtBQWEsS0FBcUI7QUFDN0MsU0FBTyxTQUFTLEtBQUssRUFBRSxLQUFLLE9BQU8sQ0FBQyxVQUFVLFFBQVEsTUFBTSxHQUFHLFVBQVUsUUFBUSxDQUFDLEVBQUUsS0FBSztBQUMzRjtBQUVBLFNBQVMsaUJBQXlCO0FBQ2hDLFFBQU0sTUFBTSxhQUFhLFlBQVksS0FBSyxPQUFPLEdBQUcscUJBQXFCLENBQUMsQ0FBQztBQUMzRSxNQUFJLFlBQVksR0FBRztBQUNuQixNQUFJLDBDQUEwQyxHQUFHO0FBQ2pELE1BQUksNkJBQTZCLEdBQUc7QUFDcEMsZ0JBQWMsS0FBSyxLQUFLLFdBQVcsR0FBRyxVQUFVO0FBQ2hELFlBQVUsS0FBSyxLQUFLLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2hELGdCQUFjLEtBQUssS0FBSyxRQUFRLFVBQVUsR0FBRyxXQUFXO0FBQ3hELE1BQUksYUFBYSxHQUFHO0FBQ3BCLE1BQUksc0JBQXNCLEdBQUc7QUFDN0IsTUFBSSxzQkFBc0IsR0FBRztBQUM3QixTQUFPO0FBQ1Q7QUFJQSxLQUFLLDZGQUF3RixNQUFNO0FBQ2pHLFFBQU0sT0FBTyxlQUFlO0FB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
