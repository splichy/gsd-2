import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerHooks } from "../bootstrap/register-hooks.js";
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}
describe("quick task turn_end cleanup (#2668)", () => {
  it("turn_end handler runs cleanupQuickBranch and removes quick-return state", async () => {
    const repo = mkdtempSync(join(tmpdir(), "gsd-quick-cleanup-"));
    const oldCwd = process.cwd();
    try {
      git(repo, ["init", "-b", "main"]);
      git(repo, ["config", "user.email", "test@example.com"]);
      git(repo, ["config", "user.name", "Test User"]);
      writeFileSync(join(repo, "README.md"), "base\n");
      git(repo, ["add", "README.md"]);
      git(repo, ["commit", "-m", "chore: initial"]);
      git(repo, ["checkout", "-b", "quick/Q1-test"]);
      writeFileSync(join(repo, "quick.txt"), "quick work\n");
      git(repo, ["add", "quick.txt"]);
      git(repo, ["commit", "-m", "test: quick work"]);
      mkdirSync(join(repo, ".gsd", "runtime"), { recursive: true });
      writeFileSync(join(repo, ".gsd", "runtime", "quick-return.json"), JSON.stringify({
        basePath: repo,
        originalBranch: "main",
        quickBranch: "quick/Q1-test",
        taskNum: 1,
        slug: "test",
        description: "test"
      }) + "\n");
      const handlers = /* @__PURE__ */ new Map();
      registerHooks({ on(event, handler) {
        handlers.set(event, handler);
      } }, []);
      const turnEnd = handlers.get("turn_end");
      assert.ok(turnEnd, "turn_end hook should be registered");
      process.chdir(repo);
      await turnEnd();
      assert.equal(git(repo, ["branch", "--show-current"]), "main");
      assert.throws(() => git(repo, ["rev-parse", "--verify", "quick/Q1-test"]));
      assert.equal(existsSync(join(repo, ".gsd", "runtime", "quick-return.json")), false);
    } finally {
      process.chdir(oldCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9xdWljay10dXJuLWVuZC1jbGVhbnVwLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVGVzdHMgdGhhdCBjbGVhbnVwUXVpY2tCcmFuY2ggaXMgd2lyZWQgdG8gdHVybl9lbmQgYnkgZXhlcmNpc2luZyB0aGVcbiAqIHJlZ2lzdGVyZWQgaG9vayBhZ2FpbnN0IGEgcmVhbCB0ZW1wb3JhcnkgZ2l0IHJlcG9zaXRvcnkuXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIG1rZHRlbXBTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7IHJlZ2lzdGVySG9va3MgfSBmcm9tIFwiLi4vYm9vdHN0cmFwL3JlZ2lzdGVyLWhvb2tzLnRzXCI7XG5cbmZ1bmN0aW9uIGdpdChjd2Q6IHN0cmluZywgYXJnczogc3RyaW5nW10pOiBzdHJpbmcge1xuICByZXR1cm4gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIGFyZ3MsIHsgY3dkLCBlbmNvZGluZzogXCJ1dGYtOFwiIH0pLnRyaW0oKTtcbn1cblxuZGVzY3JpYmUoXCJxdWljayB0YXNrIHR1cm5fZW5kIGNsZWFudXAgKCMyNjY4KVwiLCAoKSA9PiB7XG4gIGl0KFwidHVybl9lbmQgaGFuZGxlciBydW5zIGNsZWFudXBRdWlja0JyYW5jaCBhbmQgcmVtb3ZlcyBxdWljay1yZXR1cm4gc3RhdGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHJlcG8gPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1xdWljay1jbGVhbnVwLVwiKSk7XG4gICAgY29uc3Qgb2xkQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgICB0cnkge1xuICAgICAgZ2l0KHJlcG8sIFtcImluaXRcIiwgXCItYlwiLCBcIm1haW5cIl0pO1xuICAgICAgZ2l0KHJlcG8sIFtcImNvbmZpZ1wiLCBcInVzZXIuZW1haWxcIiwgXCJ0ZXN0QGV4YW1wbGUuY29tXCJdKTtcbiAgICAgIGdpdChyZXBvLCBbXCJjb25maWdcIiwgXCJ1c2VyLm5hbWVcIiwgXCJUZXN0IFVzZXJcIl0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwiUkVBRE1FLm1kXCIpLCBcImJhc2VcXG5cIik7XG4gICAgICBnaXQocmVwbywgW1wiYWRkXCIsIFwiUkVBRE1FLm1kXCJdKTtcbiAgICAgIGdpdChyZXBvLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImNob3JlOiBpbml0aWFsXCJdKTtcbiAgICAgIGdpdChyZXBvLCBbXCJjaGVja291dFwiLCBcIi1iXCIsIFwicXVpY2svUTEtdGVzdFwiXSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocmVwbywgXCJxdWljay50eHRcIiksIFwicXVpY2sgd29ya1xcblwiKTtcbiAgICAgIGdpdChyZXBvLCBbXCJhZGRcIiwgXCJxdWljay50eHRcIl0pO1xuICAgICAgZ2l0KHJlcG8sIFtcImNvbW1pdFwiLCBcIi1tXCIsIFwidGVzdDogcXVpY2sgd29ya1wiXSk7XG5cbiAgICAgIG1rZGlyU3luYyhqb2luKHJlcG8sIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgd3JpdGVGaWxlU3luYyhqb2luKHJlcG8sIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJxdWljay1yZXR1cm4uanNvblwiKSwgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBiYXNlUGF0aDogcmVwbyxcbiAgICAgICAgb3JpZ2luYWxCcmFuY2g6IFwibWFpblwiLFxuICAgICAgICBxdWlja0JyYW5jaDogXCJxdWljay9RMS10ZXN0XCIsXG4gICAgICAgIHRhc2tOdW06IDEsXG4gICAgICAgIHNsdWc6IFwidGVzdFwiLFxuICAgICAgICBkZXNjcmlwdGlvbjogXCJ0ZXN0XCIsXG4gICAgICB9KSArIFwiXFxuXCIpO1xuXG4gICAgICBjb25zdCBoYW5kbGVycyA9IG5ldyBNYXA8c3RyaW5nLCBGdW5jdGlvbj4oKTtcbiAgICAgIHJlZ2lzdGVySG9va3MoeyBvbihldmVudDogc3RyaW5nLCBoYW5kbGVyOiBGdW5jdGlvbikgeyBoYW5kbGVycy5zZXQoZXZlbnQsIGhhbmRsZXIpOyB9IH0gYXMgYW55LCBbXSk7XG4gICAgICBjb25zdCB0dXJuRW5kID0gaGFuZGxlcnMuZ2V0KFwidHVybl9lbmRcIik7XG4gICAgICBhc3NlcnQub2sodHVybkVuZCwgXCJ0dXJuX2VuZCBob29rIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuXG4gICAgICBwcm9jZXNzLmNoZGlyKHJlcG8pO1xuICAgICAgYXdhaXQgdHVybkVuZCgpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoZ2l0KHJlcG8sIFtcImJyYW5jaFwiLCBcIi0tc2hvdy1jdXJyZW50XCJdKSwgXCJtYWluXCIpO1xuICAgICAgYXNzZXJ0LnRocm93cygoKSA9PiBnaXQocmVwbywgW1wicmV2LXBhcnNlXCIsIFwiLS12ZXJpZnlcIiwgXCJxdWljay9RMS10ZXN0XCJdKSk7XG4gICAgICBhc3NlcnQuZXF1YWwoZXhpc3RzU3luYyhqb2luKHJlcG8sIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJxdWljay1yZXR1cm4uanNvblwiKSksIGZhbHNlKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihvbGRDd2QpO1xuICAgICAgcm1TeW5jKHJlcG8sIHsgcmVjdXJz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
