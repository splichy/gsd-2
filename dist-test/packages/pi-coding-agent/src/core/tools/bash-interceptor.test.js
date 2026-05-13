import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkBashInterception,
  compileInterceptor,
  DEFAULT_BASH_INTERCEPTOR_RULES
} from "./bash-interceptor.js";
const ALL_TOOLS = ["read", "grep", "find", "edit", "write"];
const NO_TOOLS = [];
describe("checkBashInterception", () => {
  describe("read rule (cat/head/tail/less/more)", () => {
    it("blocks cat with a file argument", () => {
      const r = checkBashInterception("cat README.md", ALL_TOOLS);
      assert.equal(r.block, true);
      assert.equal(r.suggestedTool, "read");
    });
    it("blocks head and tail", () => {
      assert.equal(checkBashInterception("head -n 20 file.ts", ALL_TOOLS).block, true);
      assert.equal(checkBashInterception("tail -f app.log", ALL_TOOLS).block, true);
    });
    it("does NOT block cat used as heredoc (cat <<EOF)", () => {
      const r = checkBashInterception("cat <<EOF > file.txt", ALL_TOOLS);
      assert.notEqual(r.suggestedTool, "read");
    });
    it("does NOT block when read tool is absent", () => {
      assert.equal(checkBashInterception("cat README.md", NO_TOOLS).block, false);
      assert.equal(checkBashInterception("cat README.md", ["grep"]).block, false);
    });
  });
  describe("grep rule", () => {
    it("blocks grep and rg", () => {
      assert.equal(checkBashInterception("grep foo bar.ts", ALL_TOOLS).block, true);
      assert.equal(checkBashInterception("rg -r pattern .", ALL_TOOLS).block, true);
    });
    it("blocks grep with leading whitespace", () => {
      assert.equal(checkBashInterception("  grep -r foo .", ALL_TOOLS).block, true);
    });
    it("does NOT block when grep tool is absent", () => {
      assert.equal(checkBashInterception("grep foo bar", ["read", "edit"]).block, false);
    });
  });
  describe("find rule", () => {
    it("blocks find with -name flag", () => {
      assert.equal(checkBashInterception('find . -name "*.ts"', ALL_TOOLS).block, true);
    });
    it("blocks find with -type flag", () => {
      assert.equal(checkBashInterception("find /tmp -maxdepth 1 -type f", ALL_TOOLS).block, true);
    });
    it("does NOT block find without name/type flags", () => {
      assert.equal(checkBashInterception("find /tmp -maxdepth 1", ALL_TOOLS).block, false);
    });
    it("does NOT block when find tool is absent", () => {
      assert.equal(checkBashInterception('find . -name "*.ts"', ["read", "grep"]).block, false);
    });
  });
  describe("edit rule (sed/perl/awk)", () => {
    it("blocks sed -i", () => {
      assert.equal(checkBashInterception("sed -i 's/foo/bar/' file.ts", ALL_TOOLS).block, true);
      assert.equal(checkBashInterception("sed --in-place 's/x/y/' f", ALL_TOOLS).block, true);
    });
    it("does NOT block sed without -i (read-only)", () => {
      assert.equal(checkBashInterception("sed 's/foo/bar/' file.ts", ALL_TOOLS).block, false);
    });
    it("blocks perl -pi and perl -p -i", () => {
      assert.equal(checkBashInterception("perl -pi -e 's/foo/bar/' file", ALL_TOOLS).block, true);
      assert.equal(checkBashInterception("perl -p -i -e 's/x/y/' f", ALL_TOOLS).block, true);
    });
    it("blocks awk -i inplace", () => {
      assert.equal(checkBashInterception("awk -i inplace '{print}' file", ALL_TOOLS).block, true);
    });
    it("does NOT block when edit tool is absent", () => {
      assert.equal(checkBashInterception("sed -i 's/a/b/' f", ["read", "grep"]).block, false);
    });
  });
  describe("write rule (echo/printf/heredoc redirect)", () => {
    it("blocks echo with > redirect", () => {
      assert.equal(checkBashInterception("echo hello > file.txt", ALL_TOOLS).block, true);
    });
    it("blocks printf with > redirect", () => {
      assert.equal(checkBashInterception('printf "%s" content > out.txt', ALL_TOOLS).block, true);
    });
    it("does NOT block echo without redirect", () => {
      assert.equal(checkBashInterception("echo hello", ALL_TOOLS).block, false);
    });
    it("does NOT block >> append redirect (write tool does not support appending)", () => {
      assert.equal(checkBashInterception("echo hello >> file.txt", ALL_TOOLS).block, false);
    });
    it("does NOT block stderr redirect (2>)", () => {
      assert.equal(checkBashInterception("echo test 2> /dev/null", ALL_TOOLS).block, false);
    });
    it("does NOT block pipe (echo foo | grep bar)", () => {
      assert.equal(checkBashInterception("echo foo | grep bar", ALL_TOOLS).block, false);
    });
    it("does NOT block when write tool is absent", () => {
      assert.equal(checkBashInterception("echo hello > file.txt", ["read", "grep"]).block, false);
    });
  });
  describe("pass-through commands", () => {
    it("passes npm install", () => {
      assert.equal(checkBashInterception("npm install", ALL_TOOLS).block, false);
    });
    it("passes ls > output.txt (not an echo/printf/cat)", () => {
      assert.equal(checkBashInterception("ls > output.txt", ALL_TOOLS).block, false);
    });
    it("passes tee file.txt", () => {
      assert.equal(checkBashInterception("tee file.txt", ALL_TOOLS).block, false);
    });
    it("passes git log", () => {
      assert.equal(checkBashInterception("git log --oneline", ALL_TOOLS).block, false);
    });
  });
  describe("block message content", () => {
    it("includes the original command in the block message", () => {
      const r = checkBashInterception("cat README.md", ALL_TOOLS);
      assert.ok(r.message?.includes("cat README.md"), "message should contain original command");
    });
    it("returns block:false with no message when not blocked", () => {
      const r = checkBashInterception("npm install", ALL_TOOLS);
      assert.equal(r.block, false);
      assert.equal(r.message, void 0);
    });
  });
});
describe("compileInterceptor", () => {
  it("produces same results as checkBashInterception", () => {
    const interceptor = compileInterceptor(DEFAULT_BASH_INTERCEPTOR_RULES);
    const cases = [
      ["cat README.md", ALL_TOOLS, true],
      ["npm install", ALL_TOOLS, false],
      ["grep foo bar", ALL_TOOLS, true],
      ["echo hello >> file", ALL_TOOLS, false],
      ["echo test 2> /dev/null", ALL_TOOLS, false]
    ];
    for (const [cmd, tools, expected] of cases) {
      assert.equal(
        interceptor.check(cmd, tools).block,
        expected,
        `pre-compiled: "${cmd}" expected block=${expected}`
      );
    }
  });
  it("silently skips rules with invalid regex patterns", () => {
    const rules = [
      { pattern: "[invalid(", tool: "read", message: "broken" },
      { pattern: "^\\s*cat\\s+", tool: "read", message: "valid" }
    ];
    const interceptor = compileInterceptor(rules);
    assert.equal(interceptor.check("cat file.txt", ["read"]).block, true);
  });
  it("returns block:false when available tools list is empty", () => {
    const interceptor = compileInterceptor(DEFAULT_BASH_INTERCEPTOR_RULES);
    assert.equal(interceptor.check("cat README.md", []).block, false);
  });
  it("allows custom rule override", () => {
    const customRules = [
      { pattern: "^\\s*curl\\s+", tool: "fetch", message: "Use fetch tool instead." }
    ];
    const interceptor = compileInterceptor(customRules);
    assert.equal(interceptor.check("curl https://example.com", ["fetch"]).block, true);
    assert.equal(interceptor.check("cat file.txt", ["read"]).block, false);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL2Jhc2gtaW50ZXJjZXB0b3IudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQge1xuXHRjaGVja0Jhc2hJbnRlcmNlcHRpb24sXG5cdGNvbXBpbGVJbnRlcmNlcHRvcixcblx0REVGQVVMVF9CQVNIX0lOVEVSQ0VQVE9SX1JVTEVTLFxuXHR0eXBlIEJhc2hJbnRlcmNlcHRvclJ1bGUsXG59IGZyb20gXCIuL2Jhc2gtaW50ZXJjZXB0b3IuanNcIjtcblxuY29uc3QgQUxMX1RPT0xTID0gW1wicmVhZFwiLCBcImdyZXBcIiwgXCJmaW5kXCIsIFwiZWRpdFwiLCBcIndyaXRlXCJdO1xuY29uc3QgTk9fVE9PTFM6IHN0cmluZ1tdID0gW107XG5cbmRlc2NyaWJlKFwiY2hlY2tCYXNoSW50ZXJjZXB0aW9uXCIsICgpID0+IHtcblx0ZGVzY3JpYmUoXCJyZWFkIHJ1bGUgKGNhdC9oZWFkL3RhaWwvbGVzcy9tb3JlKVwiLCAoKSA9PiB7XG5cdFx0aXQoXCJibG9ja3MgY2F0IHdpdGggYSBmaWxlIGFyZ3VtZW50XCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHIgPSBjaGVja0Jhc2hJbnRlcmNlcHRpb24oXCJjYXQgUkVBRE1FLm1kXCIsIEFMTF9UT09MUyk7XG5cdFx0XHRhc3NlcnQuZXF1YWwoci5ibG9jaywgdHJ1ZSk7XG5cdFx0XHRhc3NlcnQuZXF1YWwoci5zdWdnZXN0ZWRUb29sLCBcInJlYWRcIik7XG5cdFx0fSk7XG5cblx0XHRpdChcImJsb2NrcyBoZWFkIGFuZCB0YWlsXCIsICgpID0+IHtcblx0XHRcdGFzc2VydC5lcXVhbChjaGVja0Jhc2hJbnRlcmNlcHRpb24oXCJoZWFkIC1uIDIwIGZpbGUudHNcIiwgQUxMX1RPT0xTKS5ibG9jaywgdHJ1ZSk7XG5cdFx0XHRhc3NlcnQuZXF1YWwoY2hlY2tCYXNoSW50ZXJjZXB0aW9uKFwidGFpbCAtZiBhcHAubG9nXCIsIEFMTF9UT09MUykuYmxvY2ssIHRydWUpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJkb2VzIE5PVCBibG9jayBjYXQgdXNlZCBhcyBoZXJlZG9jIChjYXQgPDxFT0YpXCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHIgPSBjaGVja0Jhc2hJbnRlcmNlcHRpb24oXCJjYXQgPDxFT0YgPiBmaWxlLnR4dFwiLCBBTExfVE9PTFMpO1xuXHRcdFx0YXNzZXJ0Lm5vdEVxdWFsKHIuc3VnZ2VzdGVkVG9vbCwgXCJyZWFkXCIpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJkb2VzIE5PVCBibG9jayB3aGVuIHJlYWQgdG9vbCBpcyBhYnNlbnRcIiwgKCkgPT4ge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGNoZWNrQmFzaEludGVyY2VwdGlvbihcImNhdCBSRUFETUUubWRcIiwgTk9fVE9PTFMpLmJsb2NrLCBmYWxzZSk7XG5cdFx0XHRhc3NlcnQuZXF1YWwoY2hlY2tCYXNoSW50ZXJjZXB0aW9uKFwiY2F0IFJFQURNRS5tZFwiLCBbXCJncmVwXCJdKS5ibG9jaywgZmFsc2UpO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRkZXNjcmliZShcImdyZXAgcnVsZVwiLCAoKSA9PiB7XG5cdFx0aXQoXCJibG9ja3MgZ3JlcCBhbmQgcmdcIiwgKCkgPT4ge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGNoZWNrQmFzaEludGVyY2VwdGlvbihcImdyZXAgZm9vIGJhci50c1wiLCBBTExfVE9PTFMpLmJsb2NrLCB0cnVlKTtcblx0XHRcdGFzc2VydC5lcXVhbChjaGVja0Jhc2hJbnRlcmNlcHRpb24oXCJyZyAtciBwYXR0ZXJuIC5cIiwgQUxMX1RPT0xTKS5ibG9jaywgdHJ1ZSk7XG5cdFx0fSk7XG5cblx0XHRpdChcImJsb2NrcyBncmVwIHdpdGggbGVhZGluZyB3aGl0ZXNwYWNlXCIsICgpID0+IHtcblx0XHRcdGFzc2VydC5lcXVhbChjaGVja0Jhc2hJbnRlcmNlcHRpb24oXCIgIGdyZXAgLXIgZm9vIC5cIiwgQUxMX1RPT0xTKS5ibG9jaywgdHJ1ZSk7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgTk9UIGJsb2NrIHdoZW4gZ3JlcCB0b29sIGlzIGFic2VudFwiLCAoKSA9PiB7XG5cdFx0XHRhc3NlcnQuZXF1YWwoY2hlY2tCYXNoSW50ZXJjZXB0aW9uKFwiZ3JlcCBmb28gYmFyXCIsIFtcInJlYWRcIiwgXCJlZGl0XCJdKS5ibG9jaywgZmFsc2UpO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRkZXNjcmliZShcImZpbmQgcnVsZVwiLCAoKSA9PiB7XG5cdFx0aXQoXCJibG9ja3MgZmluZCB3aXRoIC1uYW1lIGZsYWdcIiwgKCkgPT4ge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGNoZWNrQmFzaEludGVyY2VwdGlvbignZmluZCAuIC1uYW1lIFwiKi50c1wiJywgQUxMX1RPT0xTKS5ibG9jaywgdHJ1ZSk7XG5cdFx0fSk7XG5cblx0XHRpdChcImJsb2NrcyBmaW5kIHdpdGggLXR5cGUgZmxhZ1wiLCAoKSA9PiB7XG5cdFx0XHRhc3NlcnQuZXF1YWwoY2hlY2tCYXNoSW50ZXJjZXB0aW9uKFwiZmluZCAvdG1wIC1tYXhkZXB0aCAxIC10eXBlIGZcIiwgQUxMX1RPT0xTKS5ibG9jaywgdHJ1ZSk7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgTk9UIGJsb2NrIGZpbmQgd2l0aG91dCBuYW1lL3R5cGUgZmxhZ3NcIiwgKCkgPT4ge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGNoZWNrQmFzaEludGVyY2VwdGlvbihcImZpbmQgL3RtcCAtbWF4ZGVwdGggMVwiLCBBTExfVE9PTFMpLmJsb2NrLCBmYWxzZSk7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgTk9UIGJsb2NrIHdoZW4gZmluZCB0b29sIGlzIGFic2VudFwiLCAoKSA9PiB7XG5cdFx0XHRhc3NlcnQuZXF1YWwoY2hlY2tCYXNoSW50ZXJjZXB0aW9uKCdmaW5kIC4gLW5hbWUgXCIqLnRzXCInLCBbXCJyZWFkXCIsIFwiZ3JlcFwiXSkuYmxvY2ssIGZhbHNlKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoXCJlZGl0IHJ1bGUgKHNlZC9wZXJsL2F3aylcIiwgKCkgPT4ge1xuXHRcdGl0KFwiYmxvY2tzIHNlZCAtaVwiLCAoKSA9PiB7XG5cdFx0XHRhc3NlcnQuZXF1YWwoY2hlY2tCYXNoSW50ZXJjZXB0aW9uKFwic2VkIC1pICdzL2Zvby9iYXIvJyBmaWxlLnRzXCIsIEFMTF9UT09MUykuYmxvY2ssIHRydWUpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGNoZWNrQmFzaEludGVyY2VwdGlvbihcInNlZCAtLWluLXBsYWNlICdzL3gveS8nIGZcIiwgQUxMX1RPT0xTKS5ibG9jaywgdHJ1ZSk7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgTk9UIGJsb2NrIHNlZCB3aXRob3V0IC1pIChyZWFkLW9ubHkpXCIsICgpID0+IHtcblx0XHRcdGFzc2VydC5lcXVhbChjaGVja0Jhc2hJbnRlcmNlcHRpb24oXCJzZWQgJ3MvZm9vL2Jhci8nIGZpbGUudHNcIiwgQUxMX1RPT0xTKS5ibG9jaywgZmFsc2UpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJibG9ja3MgcGVybCAtcGkgYW5kIHBlcmwgLXAgLWlcIiwgKCkgPT4ge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGNoZWNrQmFzaEludGVyY2VwdGlvbihcInBlcmwgLXBpIC1lICdzL2Zvby9iYXIvJyBmaWxlXCIsIEFMTF9UT09MUykuYmxvY2ssIHRydWUpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGNoZWNrQmFzaEludGVyY2VwdGlvbihcInBlcmwgLXAgLWkgLWUgJ3MveC95LycgZlwiLCBBTExfVE9PTFMpLmJsb2NrLCB0cnVlKTtcblx0XHR9KTtcblxuXHRcdGl0KFwiYmxvY2tzIGF3ayAtaSBpbnBsYWNlXCIsICgpID0+IHtcblx0XHRcdGFzc2VydC5lcXVhbChjaGVja0Jhc2hJbnRlcmNlcHRpb24oXCJhd2sgLWkgaW5wbGFjZSAne3ByaW50fScgZmlsZVwiLCBBTExfVE9PTFMpLmJsb2NrLCB0cnVlKTtcblx0XHR9KTtcblxuXHRcdGl0KFwiZG9lcyBOT1QgYmxvY2sgd2hlbiBlZGl0IHRvb2wgaXMgYWJzZW50XCIsICgpID0+IHtcblx0XHRcdGFzc2VydC5lcXVhbChjaGVja0Jhc2hJbnRlcmNlcHRpb24oXCJzZWQgLWkgJ3MvYS9iLycgZlwiLCBbXCJyZWFkXCIsIFwiZ3JlcFwiXSkuYmxvY2ssIGZhbHNlKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoXCJ3cml0ZSBydWxlIChlY2hvL3ByaW50Zi9oZXJlZG9jIHJlZGlyZWN0KVwiLCAoKSA9PiB7XG5cdFx0aXQoXCJibG9ja3MgZWNobyB3aXRoID4gcmVkaXJlY3RcIiwgKCkgPT4ge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGNoZWNrQmFzaEludGVyY2VwdGlvbihcImVjaG8gaGVsbG8gPiBmaWxlLnR4dFwiLCBBTExfVE9PTFMpLmJsb2NrLCB0cnVlKTtcblx0XHR9KTtcblxuXHRcdGl0KFwiYmxvY2tzIHByaW50ZiB3aXRoID4gcmVkaXJlY3RcIiwgKCkgPT4ge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGNoZWNrQmFzaEludGVyY2VwdGlvbigncHJpbnRmIFwiJXNcIiBjb250ZW50ID4gb3V0LnR4dCcsIEFMTF9UT09MUykuYmxvY2ssIHRydWUpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJkb2VzIE5PVCBibG9jayBlY2hvIHdpdGhvdXQgcmVkaXJlY3RcIiwgKCkgPT4ge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGNoZWNrQmFzaEludGVyY2VwdGlvbihcImVjaG8gaGVsbG9cIiwgQUxMX1RPT0xTKS5ibG9jaywgZmFsc2UpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJkb2VzIE5PVCBibG9jayA+PiBhcHBlbmQgcmVkaXJlY3QgKHdyaXRlIHRvb2wgZG9lcyBub3Qgc3VwcG9ydCBhcHBlbmRpbmcpXCIsICgpID0+IHtcblx0XHRcdGFzc2VydC5lcXVhbChjaGVja0Jhc2hJbnRlcmNlcHRpb24oXCJlY2hvIGhlbGxvID4+IGZpbGUudHh0XCIsIEFMTF9UT09MUykuYmxvY2ssIGZhbHNlKTtcblx0XHR9KTtcblxuXHRcdGl0KFwiZG9lcyBOT1QgYmxvY2sgc3RkZXJyIHJlZGlyZWN0ICgyPilcIiwgKCkgPT4ge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGNoZWNrQmFzaEludGVyY2VwdGlvbihcImVjaG8gdGVzdCAyPiAvZGV2L251bGxcIiwgQUxMX1RPT0xTKS5ibG9jaywgZmFsc2UpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJkb2VzIE5PVCBibG9jayBwaXBlIChlY2hvIGZvbyB8IGdyZXAgYmFyKVwiLCAoKSA9PiB7XG5cdFx0XHRhc3NlcnQuZXF1YWwoY2hlY2tCYXNoSW50ZXJjZXB0aW9uKFwiZWNobyBmb28gfCBncmVwIGJhclwiLCBBTExfVE9PTFMpLmJsb2NrLCBmYWxzZSk7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgTk9UIGJsb2NrIHdoZW4gd3JpdGUgdG9vbCBpcyBhYnNlbnRcIiwgKCkgPT4ge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKGNoZWNrQmFzaEludGVyY2VwdGlvbihcImVjaG8gaGVsbG8gPiBmaWxlLnR4dFwiLCBbXCJyZWFkXCIsIFwiZ3JlcFwiXSkuYmxvY2ssIGZhbHNlKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoXCJwYXNzLXRocm91Z2ggY29tbWFuZHNcIiwgKCkgPT4ge1xuXHRcdGl0KFwicGFzc2VzIG5wbSBpbnN0YWxsXCIsICgpID0+IHtcblx0XHRcdGFzc2VydC5lcXVhbChjaGVja0Jhc2hJbnRlcmNlcHRpb24oXCJucG0gaW5zdGFsbFwiLCBBTExfVE9PTFMpLmJsb2NrLCBmYWxzZSk7XG5cdFx0fSk7XG5cblx0XHRpdChcInBhc3NlcyBscyA+IG91dHB1dC50eHQgKG5vdCBhbiBlY2hvL3ByaW50Zi9jYXQpXCIsICgpID0+IHtcblx0XHRcdGFzc2VydC5lcXVhbChjaGVja0Jhc2hJbnRlcmNlcHRpb24oXCJscyA+IG91dHB1dC50eHRcIiwgQUxMX1RPT0xTKS5ibG9jaywgZmFsc2UpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJwYXNzZXMgdGVlIGZpbGUudHh0XCIsICgpID0+IHtcblx0XHRcdGFzc2VydC5lcXVhbChjaGVja0Jhc2hJbnRlcmNlcHRpb24oXCJ0ZWUgZmlsZS50eHRcIiwgQUxMX1RPT0xTKS5ibG9jaywgZmFsc2UpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJwYXNzZXMgZ2l0IGxvZ1wiLCAoKSA9PiB7XG5cdFx0XHRhc3NlcnQuZXF1YWwoY2hlY2tCYXNoSW50ZXJjZXB0aW9uKFwiZ2l0IGxvZyAtLW9uZWxpbmVcIiwgQUxMX1RPT0xTKS5ibG9jaywgZmFsc2UpO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRkZXNjcmliZShcImJsb2NrIG1lc3NhZ2UgY29udGVudFwiLCAoKSA9PiB7XG5cdFx0aXQoXCJpbmNsdWRlcyB0aGUgb3JpZ2luYWwgY29tbWFuZCBpbiB0aGUgYmxvY2sgbWVzc2FnZVwiLCAoKSA9PiB7XG5cdFx0XHRjb25zdCByID0gY2hlY2tCYXNoSW50ZXJjZXB0aW9uKFwiY2F0IFJFQURNRS5tZFwiLCBBTExfVE9PTFMpO1xuXHRcdFx0YXNzZXJ0Lm9rKHIubWVzc2FnZT8uaW5jbHVkZXMoXCJjYXQgUkVBRE1FLm1kXCIpLCBcIm1lc3NhZ2Ugc2hvdWxkIGNvbnRhaW4gb3JpZ2luYWwgY29tbWFuZFwiKTtcblx0XHR9KTtcblxuXHRcdGl0KFwicmV0dXJucyBibG9jazpmYWxzZSB3aXRoIG5vIG1lc3NhZ2Ugd2hlbiBub3QgYmxvY2tlZFwiLCAoKSA9PiB7XG5cdFx0XHRjb25zdCByID0gY2hlY2tCYXNoSW50ZXJjZXB0aW9uKFwibnBtIGluc3RhbGxcIiwgQUxMX1RPT0xTKTtcblx0XHRcdGFzc2VydC5lcXVhbChyLmJsb2NrLCBmYWxzZSk7XG5cdFx0XHRhc3NlcnQuZXF1YWwoci5tZXNzYWdlLCB1bmRlZmluZWQpO1xuXHRcdH0pO1xuXHR9KTtcbn0pO1xuXG5kZXNjcmliZShcImNvbXBpbGVJbnRlcmNlcHRvclwiLCAoKSA9PiB7XG5cdGl0KFwicHJvZHVjZXMgc2FtZSByZXN1bHRzIGFzIGNoZWNrQmFzaEludGVyY2VwdGlvblwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgaW50ZXJjZXB0b3IgPSBjb21waWxlSW50ZXJjZXB0b3IoREVGQVVMVF9CQVNIX0lOVEVSQ0VQVE9SX1JVTEVTKTtcblx0XHRjb25zdCBjYXNlczogW3N0cmluZywgc3RyaW5nW10sIGJvb2xlYW5dW10gPSBbXG5cdFx0XHRbXCJjYXQgUkVBRE1FLm1kXCIsIEFMTF9UT09MUywgdHJ1ZV0sXG5cdFx0XHRbXCJucG0gaW5zdGFsbFwiLCBBTExfVE9PTFMsIGZhbHNlXSxcblx0XHRcdFtcImdyZXAgZm9vIGJhclwiLCBBTExfVE9PTFMsIHRydWVdLFxuXHRcdFx0W1wiZWNobyBoZWxsbyA+PiBmaWxlXCIsIEFMTF9UT09MUywgZmFsc2VdLFxuXHRcdFx0W1wiZWNobyB0ZXN0IDI+IC9kZXYvbnVsbFwiLCBBTExfVE9PTFMsIGZhbHNlXSxcblx0XHRdO1xuXHRcdGZvciAoY29uc3QgW2NtZCwgdG9vbHMsIGV4cGVjdGVkXSBvZiBjYXNlcykge1xuXHRcdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0XHRpbnRlcmNlcHRvci5jaGVjayhjbWQsIHRvb2xzKS5ibG9jayxcblx0XHRcdFx0ZXhwZWN0ZWQsXG5cdFx0XHRcdGBwcmUtY29tcGlsZWQ6IFwiJHtjbWR9XCIgZXhwZWN0ZWQgYmxvY2s9JHtleHBlY3RlZH1gLFxuXHRcdFx0KTtcblx0XHR9XG5cdH0pO1xuXG5cdGl0KFwic2lsZW50bHkgc2tpcHMgcnVsZXMgd2l0aCBpbnZhbGlkIHJlZ2V4IHBhdHRlcm5zXCIsICgpID0+IHtcblx0XHRjb25zdCBydWxlczogQmFzaEludGVyY2VwdG9yUnVsZVtdID0gW1xuXHRcdFx0eyBwYXR0ZXJuOiBcIltpbnZhbGlkKFwiLCB0b29sOiBcInJlYWRcIiwgbWVzc2FnZTogXCJicm9rZW5cIiB9LFxuXHRcdFx0eyBwYXR0ZXJuOiBcIl5cXFxccypjYXRcXFxccytcIiwgdG9vbDogXCJyZWFkXCIsIG1lc3NhZ2U6IFwidmFsaWRcIiB9LFxuXHRcdF07XG5cdFx0Y29uc3QgaW50ZXJjZXB0b3IgPSBjb21waWxlSW50ZXJjZXB0b3IocnVsZXMpO1xuXHRcdGFzc2VydC5lcXVhbChpbnRlcmNlcHRvci5jaGVjayhcImNhdCBmaWxlLnR4dFwiLCBbXCJyZWFkXCJdKS5ibG9jaywgdHJ1ZSk7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyBibG9jazpmYWxzZSB3aGVuIGF2YWlsYWJsZSB0b29scyBsaXN0IGlzIGVtcHR5XCIsICgpID0+IHtcblx0XHRjb25zdCBpbnRlcmNlcHRvciA9IGNvbXBpbGVJbnRlcmNlcHRvcihERUZBVUxUX0JBU0hfSU5URVJDRVBUT1JfUlVMRVMpO1xuXHRcdGFzc2VydC5lcXVhbChpbnRlcmNlcHRvci5jaGVjayhcImNhdCBSRUFETUUubWRcIiwgW10pLmJsb2NrLCBmYWxzZSk7XG5cdH0pO1xuXG5cdGl0KFwiYWxsb3dzIGN1c3RvbSBydWxlIG92ZXJyaWRlXCIsICgpID0+IHtcblx0XHRjb25zdCBjdXN0b21SdWxlczogQmFzaEludGVyY2VwdG9yUnVsZVtdID0gW1xuXHRcdFx0eyBwYXR0ZXJuOiBcIl5cXFxccypjdXJsXFxcXHMrXCIsIHRvb2w6IFwiZmV0Y2hcIiwgbWVzc2FnZTogXCJVc2UgZmV0Y2ggdG9vbCBpbnN0ZWFkLlwiIH0sXG5cdFx0XTtcblx0XHRjb25zdCBpbnRlcmNlcHRvciA9IGNvbXBpbGVJbnRlcmNlcHRvcihjdXN0b21SdWxlcyk7XG5cdFx0YXNzZXJ0LmVxdWFsKGludGVyY2VwdG9yLmNoZWNrKFwiY3VybCBodHRwczovL2V4YW1wbGUuY29tXCIsIFtcImZldGNoXCJdKS5ibG9jaywgdHJ1ZSk7XG5cdFx0Ly8gZGVmYXVsdCBydWxlcyBub3QgYWN0aXZlXG5cdFx0YXNzZXJ0LmVxdWFsKGludGVyY2VwdG9yLmNoZWNrKFwiY2F0IGZp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
