import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  fastForwardReusedMilestoneBranchIfSafe,
  _isBranchCheckedOutElsewhere
} from "../auto-worktree.js";
const NO_PROMPT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com"
};
function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: NO_PROMPT_ENV
  });
}
function rev(cwd, ref) {
  return git(cwd, "rev-parse", ref).trim();
}
describe("fastForwardReusedMilestoneBranchIfSafe", () => {
  let repo;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "ff-reused-branch-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "test");
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, "add", "seed.txt");
    git(repo, "commit", "-q", "-m", "initial");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  test("fast-forwards a milestone branch that is strictly behind integration (regression: stale base)", () => {
    git(repo, "branch", "milestone/M001");
    const m001Initial = rev(repo, "milestone/M001");
    writeFileSync(join(repo, "seed.txt"), "advanced\n");
    git(repo, "add", "seed.txt");
    git(repo, "commit", "-q", "-m", "main moved forward");
    const mainTip = rev(repo, "main");
    assert.notEqual(m001Initial, mainTip, "main must be ahead before the test");
    fastForwardReusedMilestoneBranchIfSafe(repo, "M001", "milestone/M001");
    assert.equal(
      rev(repo, "milestone/M001"),
      mainTip,
      "milestone/M001 must be fast-forwarded to main's tip"
    );
  });
  test("does not touch a milestone branch that has its own commits ahead", () => {
    git(repo, "checkout", "-q", "-b", "milestone/M001");
    writeFileSync(join(repo, "milestone-only.txt"), "milestone work\n");
    git(repo, "add", "milestone-only.txt");
    git(repo, "commit", "-q", "-m", "M001 work");
    const milestoneTip = rev(repo, "milestone/M001");
    git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "seed.txt"), "advanced\n");
    git(repo, "add", "seed.txt");
    git(repo, "commit", "-q", "-m", "main moved forward");
    fastForwardReusedMilestoneBranchIfSafe(repo, "M001", "milestone/M001");
    assert.equal(
      rev(repo, "milestone/M001"),
      milestoneTip,
      "diverged milestone branch must NOT be touched (would lose work)"
    );
  });
  test("is a no-op when milestone branch is already up-to-date with main", () => {
    git(repo, "branch", "milestone/M001");
    const before = rev(repo, "milestone/M001");
    fastForwardReusedMilestoneBranchIfSafe(repo, "M001", "milestone/M001");
    assert.equal(rev(repo, "milestone/M001"), before, "ref must not move");
  });
  test("does nothing when the milestone branch does not exist", () => {
    assert.doesNotThrow(
      () => fastForwardReusedMilestoneBranchIfSafe(repo, "M999", "milestone/M999")
    );
  });
  test("does nothing in a non-git directory", () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "ff-not-a-repo-"));
    try {
      assert.doesNotThrow(
        () => fastForwardReusedMilestoneBranchIfSafe(nonRepo, "M001", "milestone/M001")
      );
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
  test("skips fast-forward when branch is checked out in another worktree (peer-review regression)", () => {
    git(repo, "branch", "milestone/M001");
    const m001Initial = rev(repo, "milestone/M001");
    const wtPath = join(repo, "..", `${basename(repo)}-wt`);
    git(repo, "worktree", "add", wtPath, "milestone/M001");
    writeFileSync(join(repo, "seed.txt"), "advanced\n");
    git(repo, "add", "seed.txt");
    git(repo, "commit", "-q", "-m", "main moved forward");
    try {
      fastForwardReusedMilestoneBranchIfSafe(repo, "M001", "milestone/M001");
      assert.equal(
        rev(repo, "milestone/M001"),
        m001Initial,
        "milestone/M001 must NOT move while a linked worktree has it checked out"
      );
    } finally {
      git(repo, "worktree", "remove", "--force", wtPath);
      rmSync(wtPath, { recursive: true, force: true });
    }
  });
});
describe("_isBranchCheckedOutElsewhere", () => {
  let repo;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "is-checked-out-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "test");
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, "add", "seed.txt");
    git(repo, "commit", "-q", "-m", "initial");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });
  test("returns true when branch is checked out in a linked worktree", () => {
    git(repo, "branch", "milestone/M001");
    const wtPath = join(repo, "..", `${basename(repo)}-wt`);
    git(repo, "worktree", "add", wtPath, "milestone/M001");
    try {
      assert.equal(_isBranchCheckedOutElsewhere(repo, "milestone/M001"), true);
    } finally {
      git(repo, "worktree", "remove", "--force", wtPath);
      rmSync(wtPath, { recursive: true, force: true });
    }
  });
  test("returns true when branch is checked out in the main worktree itself", () => {
    git(repo, "checkout", "-q", "-b", "milestone/M002");
    assert.equal(_isBranchCheckedOutElsewhere(repo, "milestone/M002"), true);
  });
  test("returns false when branch exists but is not checked out anywhere", () => {
    git(repo, "branch", "milestone/M003");
    assert.equal(_isBranchCheckedOutElsewhere(repo, "milestone/M003"), false);
  });
  test("returns false for an unknown branch in a clean repo", () => {
    assert.equal(_isBranchCheckedOutElsewhere(repo, "milestone/M999"), false);
  });
  test("returns false on a non-git directory (empty worktree list)", () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "is-checked-out-not-repo-"));
    try {
      assert.equal(_isBranchCheckedOutElsewhere(nonRepo, "milestone/M001"), false);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9mYXN0LWZvcndhcmQtcmV1c2VkLW1pbGVzdG9uZS1icmFuY2gudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgKyBzcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3Rlc3RzL2Zhc3QtZm9yd2FyZC1yZXVzZWQtbWlsZXN0b25lLWJyYW5jaC50ZXN0LnRzXG4vLyBSZWdyZXNzaW9uOiB3aGVuIGNyZWF0ZUF1dG9Xb3JrdHJlZSByZXVzZXMgYW4gZXhpc3RpbmcgbWlsZXN0b25lIGJyYW5jaCxcbi8vIGl0IG11c3QgYmUgZmFzdC1mb3J3YXJkZWQgb250byBpbnRlZ3JhdGlvbiBzbyB0aGUgbmV4dCBtaWxlc3RvbmUgZm9ya3Ncbi8vIGZyb20gdXAtdG8tZGF0ZSBjb2RlICgjNTUzOC1mb2xsb3d1cCkuXG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0LCBiZWZvcmVFYWNoLCBhZnRlckVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGV4ZWNGaWxlU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQge1xuICBmYXN0Rm9yd2FyZFJldXNlZE1pbGVzdG9uZUJyYW5jaElmU2FmZSxcbiAgX2lzQnJhbmNoQ2hlY2tlZE91dEVsc2V3aGVyZSxcbn0gZnJvbSBcIi4uL2F1dG8td29ya3RyZWUuanNcIjtcblxuY29uc3QgTk9fUFJPTVBUX0VOViA9IHtcbiAgLi4ucHJvY2Vzcy5lbnYsXG4gIEdJVF9URVJNSU5BTF9QUk9NUFQ6IFwiMFwiLFxuICBHSVRfQVVUSE9SX05BTUU6IFwidGVzdFwiLFxuICBHSVRfQVVUSE9SX0VNQUlMOiBcInRlc3RAZXhhbXBsZS5jb21cIixcbiAgR0lUX0NPTU1JVFRFUl9OQU1FOiBcInRlc3RcIixcbiAgR0lUX0NPTU1JVFRFUl9FTUFJTDogXCJ0ZXN0QGV4YW1wbGUuY29tXCIsXG59O1xuXG5mdW5jdGlvbiBnaXQoY3dkOiBzdHJpbmcsIC4uLmFyZ3M6IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgcmV0dXJuIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBhcmdzLCB7XG4gICAgY3dkLFxuICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgIGVudjogTk9fUFJPTVBUX0VOVixcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJldihjd2Q6IHN0cmluZywgcmVmOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gZ2l0KGN3ZCwgXCJyZXYtcGFyc2VcIiwgcmVmKS50cmltKCk7XG59XG5cbmRlc2NyaWJlKFwiZmFzdEZvcndhcmRSZXVzZWRNaWxlc3RvbmVCcmFuY2hJZlNhZmVcIiwgKCkgPT4ge1xuICBsZXQgcmVwbzogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIHJlcG8gPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImZmLXJldXNlZC1icmFuY2gtXCIpKTtcbiAgICBnaXQocmVwbywgXCJpbml0XCIsIFwiLXFcIiwgXCItYlwiLCBcIm1haW5cIik7XG4gICAgZ2l0KHJlcG8sIFwiY29uZmlnXCIsIFwidXNlci5lbWFpbFwiLCBcInRlc3RAZXhhbXBsZS5jb21cIik7XG4gICAgZ2l0KHJlcG8sIFwiY29uZmlnXCIsIFwidXNlci5uYW1lXCIsIFwidGVzdFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJzZWVkLnR4dFwiKSwgXCJzZWVkXFxuXCIpO1xuICAgIGdpdChyZXBvLCBcImFkZFwiLCBcInNlZWQudHh0XCIpO1xuICAgIGdpdChyZXBvLCBcImNvbW1pdFwiLCBcIi1xXCIsIFwiLW1cIiwgXCJpbml0aWFsXCIpO1xuICB9KTtcblxuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIHJtU3luYyhyZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJmYXN0LWZvcndhcmRzIGEgbWlsZXN0b25lIGJyYW5jaCB0aGF0IGlzIHN0cmljdGx5IGJlaGluZCBpbnRlZ3JhdGlvbiAocmVncmVzc2lvbjogc3RhbGUgYmFzZSlcIiwgKCkgPT4ge1xuICAgIC8vIENyZWF0ZSBtaWxlc3RvbmUvTTAwMSBmcm9tIG1haW4ncyBpbml0aWFsIGNvbW1pdCwgdGhlbiBhZHZhbmNlIG1haW4uXG4gICAgZ2l0KHJlcG8sIFwiYnJhbmNoXCIsIFwibWlsZXN0b25lL00wMDFcIik7XG4gICAgY29uc3QgbTAwMUluaXRpYWwgPSByZXYocmVwbywgXCJtaWxlc3RvbmUvTTAwMVwiKTtcblxuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcInNlZWQudHh0XCIpLCBcImFkdmFuY2VkXFxuXCIpO1xuICAgIGdpdChyZXBvLCBcImFkZFwiLCBcInNlZWQudHh0XCIpO1xuICAgIGdpdChyZXBvLCBcImNvbW1pdFwiLCBcIi1xXCIsIFwiLW1cIiwgXCJtYWluIG1vdmVkIGZvcndhcmRcIik7XG4gICAgY29uc3QgbWFpblRpcCA9IHJldihyZXBvLCBcIm1haW5cIik7XG5cbiAgICBhc3NlcnQubm90RXF1YWwobTAwMUluaXRpYWwsIG1haW5UaXAsIFwibWFpbiBtdXN0IGJlIGFoZWFkIGJlZm9yZSB0aGUgdGVzdFwiKTtcblxuICAgIGZhc3RGb3J3YXJkUmV1c2VkTWlsZXN0b25lQnJhbmNoSWZTYWZlKHJlcG8sIFwiTTAwMVwiLCBcIm1pbGVzdG9uZS9NMDAxXCIpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgcmV2KHJlcG8sIFwibWlsZXN0b25lL00wMDFcIiksXG4gICAgICBtYWluVGlwLFxuICAgICAgXCJtaWxlc3RvbmUvTTAwMSBtdXN0IGJlIGZhc3QtZm9yd2FyZGVkIHRvIG1haW4ncyB0aXBcIixcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwiZG9lcyBub3QgdG91Y2ggYSBtaWxlc3RvbmUgYnJhbmNoIHRoYXQgaGFzIGl0cyBvd24gY29tbWl0cyBhaGVhZFwiLCAoKSA9PiB7XG4gICAgLy8gQnJhbmNoIGZyb20gbWFpbiwgYWRkIGEgdW5pcXVlIGNvbW1pdCwgdGhlbiBhZHZhbmNlIG1haW4uXG4gICAgZ2l0KHJlcG8sIFwiY2hlY2tvdXRcIiwgXCItcVwiLCBcIi1iXCIsIFwibWlsZXN0b25lL00wMDFcIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwibWlsZXN0b25lLW9ubHkudHh0XCIpLCBcIm1pbGVzdG9uZSB3b3JrXFxuXCIpO1xuICAgIGdpdChyZXBvLCBcImFkZFwiLCBcIm1pbGVzdG9uZS1vbmx5LnR4dFwiKTtcbiAgICBnaXQocmVwbywgXCJjb21taXRcIiwgXCItcVwiLCBcIi1tXCIsIFwiTTAwMSB3b3JrXCIpO1xuICAgIGNvbnN0IG1pbGVzdG9uZVRpcCA9IHJldihyZXBvLCBcIm1pbGVzdG9uZS9NMDAxXCIpO1xuXG4gICAgZ2l0KHJlcG8sIFwiY2hlY2tvdXRcIiwgXCItcVwiLCBcIm1haW5cIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwic2VlZC50eHRcIiksIFwiYWR2YW5jZWRcXG5cIik7XG4gICAgZ2l0KHJlcG8sIFwiYWRkXCIsIFwic2VlZC50eHRcIik7XG4gICAgZ2l0KHJlcG8sIFwiY29tbWl0XCIsIFwiLXFcIiwgXCItbVwiLCBcIm1haW4gbW92ZWQgZm9yd2FyZFwiKTtcblxuICAgIGZhc3RGb3J3YXJkUmV1c2VkTWlsZXN0b25lQnJhbmNoSWZTYWZlKHJlcG8sIFwiTTAwMVwiLCBcIm1pbGVzdG9uZS9NMDAxXCIpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgcmV2KHJlcG8sIFwibWlsZXN0b25lL00wMDFcIiksXG4gICAgICBtaWxlc3RvbmVUaXAsXG4gICAgICBcImRpdmVyZ2VkIG1pbGVzdG9uZSBicmFuY2ggbXVzdCBOT1QgYmUgdG91Y2hlZCAod291bGQgbG9zZSB3b3JrKVwiLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJpcyBhIG5vLW9wIHdoZW4gbWlsZXN0b25lIGJyYW5jaCBpcyBhbHJlYWR5IHVwLXRvLWRhdGUgd2l0aCBtYWluXCIsICgpID0+IHtcbiAgICBnaXQocmVwbywgXCJicmFuY2hcIiwgXCJtaWxlc3RvbmUvTTAwMVwiKTtcbiAgICBjb25zdCBiZWZvcmUgPSByZXYocmVwbywgXCJtaWxlc3RvbmUvTTAwMVwiKTtcblxuICAgIGZhc3RGb3J3YXJkUmV1c2VkTWlsZXN0b25lQnJhbmNoSWZTYWZlKHJlcG8sIFwiTTAwMVwiLCBcIm1pbGVzdG9uZS9NMDAxXCIpO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJldihyZXBvLCBcIm1pbGVzdG9uZS9NMDAxXCIpLCBiZWZvcmUsIFwicmVmIG11c3Qgbm90IG1vdmVcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJkb2VzIG5vdGhpbmcgd2hlbiB0aGUgbWlsZXN0b25lIGJyYW5jaCBkb2VzIG5vdCBleGlzdFwiLCAoKSA9PiB7XG4gICAgLy8gU2hvdWxkIHNpbGVudGx5IHJldHVybiBcdTIwMTQgbm8gZXJyb3IsIG5vIHNpZGUgZWZmZWN0cy5cbiAgICBhc3NlcnQuZG9lc05vdFRocm93KCgpID0+XG4gICAgICBmYXN0Rm9yd2FyZFJldXNlZE1pbGVzdG9uZUJyYW5jaElmU2FmZShyZXBvLCBcIk05OTlcIiwgXCJtaWxlc3RvbmUvTTk5OVwiKSxcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwiZG9lcyBub3RoaW5nIGluIGEgbm9uLWdpdCBkaXJlY3RvcnlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG5vblJlcG8gPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImZmLW5vdC1hLXJlcG8tXCIpKTtcbiAgICB0cnkge1xuICAgICAgYXNzZXJ0LmRvZXNOb3RUaHJvdygoKSA9PlxuICAgICAgICBmYXN0Rm9yd2FyZFJldXNlZE1pbGVzdG9uZUJyYW5jaElmU2FmZShub25SZXBvLCBcIk0wMDFcIiwgXCJtaWxlc3RvbmUvTTAwMVwiKSxcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJtU3luYyhub25SZXBvLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcblxuICB0ZXN0KFwic2tpcHMgZmFzdC1mb3J3YXJkIHdoZW4gYnJhbmNoIGlzIGNoZWNrZWQgb3V0IGluIGFub3RoZXIgd29ya3RyZWUgKHBlZXItcmV2aWV3IHJlZ3Jlc3Npb24pXCIsICgpID0+IHtcbiAgICAvLyBDb2RleCBwZWVyIHJldmlldyBjYXVnaHQ6IGBuYXRpdmVVcGRhdGVSZWZgIHN1Y2NlZWRzIGV2ZW4gd2hlbiB0aGVcbiAgICAvLyBicmFuY2ggaXMgY2hlY2tlZCBvdXQgaW4gYSBsaW5rZWQgd29ya3RyZWUsIGxlYXZpbmcgdGhhdCB3b3JrdHJlZSdzXG4gICAgLy8gSEVBRCBpbmNvbnNpc3RlbnQgd2l0aCBpdHMgaW5kZXgvd29yayB0cmVlLiBUaGUgZml4IGNhbGxzXG4gICAgLy8gYG5hdGl2ZVdvcmt0cmVlTGlzdGAgZmlyc3QgYW5kIHNraXBzIHRoZSBGRiBpZiBhbnkgd29ya3RyZWUgb3ducyB0aGVcbiAgICAvLyB0YXJnZXQgYnJhbmNoLiBUaGlzIHRlc3Qgc2V0cyB1cCB0aGUgZXhhY3Qgc2NlbmFyaW8uXG4gICAgZ2l0KHJlcG8sIFwiYnJhbmNoXCIsIFwibWlsZXN0b25lL00wMDFcIik7XG4gICAgY29uc3QgbTAwMUluaXRpYWwgPSByZXYocmVwbywgXCJtaWxlc3RvbmUvTTAwMVwiKTtcblxuICAgIC8vIEFkZCBhIGxpbmtlZCB3b3JrdHJlZSB0aGF0IGNoZWNrcyBvdXQgbWlsZXN0b25lL00wMDEuXG4gICAgY29uc3Qgd3RQYXRoID0gam9pbihyZXBvLCBcIi4uXCIsIGAke2Jhc2VuYW1lKHJlcG8pfS13dGApO1xuICAgIGdpdChyZXBvLCBcIndvcmt0cmVlXCIsIFwiYWRkXCIsIHd0UGF0aCwgXCJtaWxlc3RvbmUvTTAwMVwiKTtcblxuICAgIC8vIEFkdmFuY2UgbWFpbiBzbyBhIGZhc3QtZm9yd2FyZCB3b3VsZCBvdGhlcndpc2UgYXBwbHkuXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwic2VlZC50eHRcIiksIFwiYWR2YW5jZWRcXG5cIik7XG4gICAgZ2l0KHJlcG8sIFwiYWRkXCIsIFwic2VlZC50eHRcIik7XG4gICAgZ2l0KHJlcG8sIFwiY29tbWl0XCIsIFwiLXFcIiwgXCItbVwiLCBcIm1haW4gbW92ZWQgZm9yd2FyZFwiKTtcblxuICAgIHRyeSB7XG4gICAgICBmYXN0Rm9yd2FyZFJldXNlZE1pbGVzdG9uZUJyYW5jaElmU2FmZShyZXBvLCBcIk0wMDFcIiwgXCJtaWxlc3RvbmUvTTAwMVwiKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgICByZXYocmVwbywgXCJtaWxlc3RvbmUvTTAwMVwiKSxcbiAgICAgICAgbTAwMUluaXRpYWwsXG4gICAgICAgIFwibWlsZXN0b25lL00wMDEgbXVzdCBOT1QgbW92ZSB3aGlsZSBhIGxpbmtlZCB3b3JrdHJlZSBoYXMgaXQgY2hlY2tlZCBvdXRcIixcbiAgICAgICk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGdpdChyZXBvLCBcIndvcmt0cmVlXCIsIFwicmVtb3ZlXCIsIFwiLS1mb3JjZVwiLCB3dFBhdGgpO1xuICAgICAgcm1TeW5jKHd0UGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJfaXNCcmFuY2hDaGVja2VkT3V0RWxzZXdoZXJlXCIsICgpID0+IHtcbiAgbGV0IHJlcG86IHN0cmluZztcblxuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICByZXBvID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJpcy1jaGVja2VkLW91dC1cIikpO1xuICAgIGdpdChyZXBvLCBcImluaXRcIiwgXCItcVwiLCBcIi1iXCIsIFwibWFpblwiKTtcbiAgICBnaXQocmVwbywgXCJjb25maWdcIiwgXCJ1c2VyLmVtYWlsXCIsIFwidGVzdEBleGFtcGxlLmNvbVwiKTtcbiAgICBnaXQocmVwbywgXCJjb25maWdcIiwgXCJ1c2VyLm5hbWVcIiwgXCJ0ZXN0XCIpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihyZXBvLCBcInNlZWQudHh0XCIpLCBcInNlZWRcXG5cIik7XG4gICAgZ2l0KHJlcG8sIFwiYWRkXCIsIFwic2VlZC50eHRcIik7XG4gICAgZ2l0KHJlcG8sIFwiY29tbWl0XCIsIFwiLXFcIiwgXCItbVwiLCBcImluaXRpYWxcIik7XG4gIH0pO1xuXG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgcm1TeW5jKHJlcG8sIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgdHJ1ZSB3aGVuIGJyYW5jaCBpcyBjaGVja2VkIG91dCBpbiBhIGxpbmtlZCB3b3JrdHJlZVwiLCAoKSA9PiB7XG4gICAgZ2l0KHJlcG8sIFwiYnJhbmNoXCIsIFwibWlsZXN0b25lL00wMDFcIik7XG4gICAgY29uc3Qgd3RQYXRoID0gam9pbihyZXBvLCBcIi4uXCIsIGAke2Jhc2VuYW1lKHJlcG8pfS13dGApO1xuICAgIGdpdChyZXBvLCBcIndvcmt0cmVlXCIsIFwiYWRkXCIsIHd0UGF0aCwgXCJtaWxlc3RvbmUvTTAwMVwiKTtcbiAgICB0cnkge1xuICAgICAgYXNzZXJ0LmVxdWFsKF9pc0JyYW5jaENoZWNrZWRPdXRFbHNld2hlcmUocmVwbywgXCJtaWxlc3RvbmUvTTAwMVwiKSwgdHJ1ZSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGdpdChyZXBvLCBcIndvcmt0cmVlXCIsIFwicmVtb3ZlXCIsIFwiLS1mb3JjZVwiLCB3dFBhdGgpO1xuICAgICAgcm1TeW5jKHd0UGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgdHJ1ZSB3aGVuIGJyYW5jaCBpcyBjaGVja2VkIG91dCBpbiB0aGUgbWFpbiB3b3JrdHJlZSBpdHNlbGZcIiwgKCkgPT4ge1xuICAgIC8vIFRoZSBkZWZhdWx0IGNoZWNrb3V0LiBgZ2l0IHdvcmt0cmVlIGxpc3QgLS1wb3JjZWxhaW5gIHJlcG9ydHMgdGhlXG4gICAgLy8gcHJpbWFyeSB3b3JrdHJlZSB0b28sIHNvIGEgYnJhbmNoIGNoZWNrZWQgb3V0IHRoZXJlIGNvdW50cyBhc1xuICAgIC8vIFwiY2hlY2tlZCBvdXQgZWxzZXdoZXJlXCIgcmVsYXRpdmUgdG8gYSBmcmVzaCByZWYgdXBkYXRlIGludGVudC5cbiAgICBnaXQocmVwbywgXCJjaGVja291dFwiLCBcIi1xXCIsIFwiLWJcIiwgXCJtaWxlc3RvbmUvTTAwMlwiKTtcbiAgICBhc3NlcnQuZXF1YWwoX2lzQnJhbmNoQ2hlY2tlZE91dEVsc2V3aGVyZShyZXBvLCBcIm1pbGVzdG9uZS9NMDAyXCIpLCB0cnVlKTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgZmFsc2Ugd2hlbiBicmFuY2ggZXhpc3RzIGJ1dCBpcyBub3QgY2hlY2tlZCBvdXQgYW55d2hlcmVcIiwgKCkgPT4ge1xuICAgIGdpdChyZXBvLCBcImJyYW5jaFwiLCBcIm1pbGVzdG9uZS9NMDAzXCIpO1xuICAgIGFzc2VydC5lcXVhbChfaXNCcmFuY2hDaGVja2VkT3V0RWxzZXdoZXJlKHJlcG8sIFwibWlsZXN0b25lL00wMDNcIiksIGZhbHNlKTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgZmFsc2UgZm9yIGFuIHVua25vd24gYnJhbmNoIGluIGEgY2xlYW4gcmVwb1wiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKF9pc0JyYW5jaENoZWNrZWRPdXRFbHNld2hlcmUocmVwbywgXCJtaWxlc3RvbmUvTTk5OVwiKSwgZmFsc2UpO1xuICB9KTtcblxuICB0ZXN0KFwicmV0dXJucyBmYWxzZSBvbiBhIG5vbi1naXQgZGlyZWN0b3J5IChlbXB0eSB3b3JrdHJlZSBsaXN0KVwiLCAoKSA9PiB7XG4gICAgLy8gbmF0aXZlV29ya3RyZWVMaXN0IGRvZXMgbm90IHRocm93IG9uIGEgbm9uLXJlcG8gXHUyMDE0IGl0IHJldHVybnMgW10uIFRoZVxuICAgIC8vIHBhcmVudCBmdW5jdGlvbiBgZmFzdEZvcndhcmRSZXVzZWRNaWxlc3RvbmVCcmFuY2hJZlNhZmVgIG5ldmVyIHJlYWNoZXNcbiAgICAvLyB0aGlzIGNvZGUgcGF0aCBvbiBhIG5vbi1yZXBvIGJlY2F1c2UgYG5hdGl2ZUJyYW5jaEV4aXN0c2Agc2hvcnQtY2lyY3VpdHNcbiAgICAvLyBlYXJsaWVyLiBEb2N1bWVudGluZyBhY3R1YWwgYmVoYXZpb3Igc28gZnV0dXJlIHJlYWRlcnMgZG9uJ3QgZXhwZWN0IGFcbiAgICAvLyBmYWlsLXNhZmUgYHRydWVgIGhlcmUuXG4gICAgY29uc3Qgbm9uUmVwbyA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiaXMtY2hlY2tlZC1vdXQtbm90LXJlcG8tXCIpKTtcbiAgICB0cnkge1xuICAgICAgYXNzZXJ0LmVxdWFsKF9pc0JyYW5jaENoZWNrZWRPdXRFbHNld2hlcmUobm9uUmVwbywgXCJtaWxlc3RvbmUvTTAwMVwiKSwgZmFsc2UpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMobm9uUmVwbywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUtBLFNBQVMsVUFBVSxNQUFNLFlBQVksaUJBQWlCO0FBQ3RELE9BQU8sWUFBWTtBQUNuQixTQUFTLG9CQUFvQjtBQUM3QixTQUFTLGFBQWEsUUFBUSxxQkFBcUI7QUFDbkQsU0FBUyxjQUFjO0FBQ3ZC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
