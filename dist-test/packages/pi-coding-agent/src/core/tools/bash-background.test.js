import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rewriteBackgroundCommand } from "./bash.js";
describe("rewriteBackgroundCommand", () => {
  describe("no-op cases (no & operator)", () => {
    it("passes through a plain command unchanged", () => {
      const r = rewriteBackgroundCommand("python -m http.server 8080");
      assert.equal(r.rewritten, false);
      assert.equal(r.command, "python -m http.server 8080");
    });
    it("passes through a command with && (logical AND)", () => {
      const r = rewriteBackgroundCommand("npm install && npm start");
      assert.equal(r.rewritten, false);
    });
    it("passes through a command with & inside a string", () => {
      const r = rewriteBackgroundCommand("echo 'foo & bar'");
      assert.equal(r.rewritten, false);
    });
  });
  describe("rewrite cases (& backgrounding)", () => {
    it("rewrites bare background command", () => {
      const r = rewriteBackgroundCommand("python -m http.server 8080 &");
      assert.equal(r.rewritten, true);
      assert.ok(r.command.includes(">/dev/null 2>&1"), "injects stdout redirect");
      assert.ok(r.command.includes("&"), "preserves background operator");
    });
    it("rewrites background command with trailing whitespace", () => {
      const r = rewriteBackgroundCommand("python -m http.server 8080 &   ");
      assert.equal(r.rewritten, true);
      assert.ok(r.command.includes(">/dev/null 2>&1"));
    });
    it("rewrites background command with & disown", () => {
      const r = rewriteBackgroundCommand("node server.js & disown");
      assert.equal(r.rewritten, true);
      assert.ok(r.command.includes(">/dev/null 2>&1"));
    });
    it("does NOT double-inject when stdout already redirected (>)", () => {
      const r = rewriteBackgroundCommand("python -m http.server 8080 > server.log &");
      assert.equal(r.rewritten, false, "already has > redirect");
    });
    it("does NOT inject when already redirected to /dev/null", () => {
      const r = rewriteBackgroundCommand("python -m http.server 8080 >/dev/null 2>&1 &");
      assert.equal(r.rewritten, false, "already fully redirected");
    });
    it("does NOT inject when command uses a pipe", () => {
      const r = rewriteBackgroundCommand("python -m http.server 8080 | tee server.log &");
      assert.equal(r.rewritten, false, "stdout piped elsewhere");
    });
  });
  describe("compound commands", () => {
    it("rewrites only the backgrounded segment in a compound command", () => {
      const r = rewriteBackgroundCommand("echo starting; python -m http.server 8080 &");
      assert.equal(r.rewritten, true);
      assert.ok(r.command.includes(">/dev/null 2>&1 &"));
      assert.ok(r.command.includes("echo starting"), "non-background part preserved");
    });
    it("handles multiple backgrounded commands", () => {
      const r = rewriteBackgroundCommand("node server.js &\npython worker.py &");
      assert.equal(r.rewritten, true);
      const occurrences = (r.command.match(/\/dev\/null/g) ?? []).length;
      assert.ok(occurrences >= 2, "both background commands rewritten");
    });
  });
  describe("nohup / already-safe patterns pass through", () => {
    it("nohup ... & passes through unchanged (already redirects)", () => {
      const r = rewriteBackgroundCommand("nohup python -m http.server 8080 > /dev/null 2>&1 &");
      assert.equal(r.rewritten, false);
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL2Jhc2gtYmFja2dyb3VuZC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIGJhc2gtYmFja2dyb3VuZC50ZXN0LnRzIFx1MjAxNCBUZXN0cyBmb3IgcmV3cml0ZUJhY2tncm91bmRDb21tYW5kXG4gKlxuICogUmVncmVzc2lvbiBmb3IgIzczMzogYGNtZCAmYCBjYXVzZXMgdGhlIGJhc2ggdG9vbCB0byBoYW5nIGluZGVmaW5pdGVseVxuICogYmVjYXVzZSB0aGUgYmFja2dyb3VuZCBwcm9jZXNzIGluaGVyaXRzIHRoZSBwaXBlZCBzdGRvdXQvc3RkZXJyIGFuZCBrZWVwc1xuICogdGhlbSBvcGVuLiByZXdyaXRlQmFja2dyb3VuZENvbW1hbmQgaW5qZWN0cyA+L2Rldi9udWxsIDI+JjEgYmVmb3JlICYgd2hlblxuICogdGhlIGNvbW1hbmQgZG9lcyBub3QgYWxyZWFkeSByZWRpcmVjdCBzdGRvdXQuXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyByZXdyaXRlQmFja2dyb3VuZENvbW1hbmQgfSBmcm9tIFwiLi9iYXNoLmpzXCI7XG5cbmRlc2NyaWJlKFwicmV3cml0ZUJhY2tncm91bmRDb21tYW5kXCIsICgpID0+IHtcblx0ZGVzY3JpYmUoXCJuby1vcCBjYXNlcyAobm8gJiBvcGVyYXRvcilcIiwgKCkgPT4ge1xuXHRcdGl0KFwicGFzc2VzIHRocm91Z2ggYSBwbGFpbiBjb21tYW5kIHVuY2hhbmdlZFwiLCAoKSA9PiB7XG5cdFx0XHRjb25zdCByID0gcmV3cml0ZUJhY2tncm91bmRDb21tYW5kKFwicHl0aG9uIC1tIGh0dHAuc2VydmVyIDgwODBcIik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoci5yZXdyaXR0ZW4sIGZhbHNlKTtcblx0XHRcdGFzc2VydC5lcXVhbChyLmNvbW1hbmQsIFwicHl0aG9uIC1tIGh0dHAuc2VydmVyIDgwODBcIik7XG5cdFx0fSk7XG5cblx0XHRpdChcInBhc3NlcyB0aHJvdWdoIGEgY29tbWFuZCB3aXRoICYmIChsb2dpY2FsIEFORClcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgciA9IHJld3JpdGVCYWNrZ3JvdW5kQ29tbWFuZChcIm5wbSBpbnN0YWxsICYmIG5wbSBzdGFydFwiKTtcblx0XHRcdGFzc2VydC5lcXVhbChyLnJld3JpdHRlbiwgZmFsc2UpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJwYXNzZXMgdGhyb3VnaCBhIGNvbW1hbmQgd2l0aCAmIGluc2lkZSBhIHN0cmluZ1wiLCAoKSA9PiB7XG5cdFx0XHRjb25zdCByID0gcmV3cml0ZUJhY2tncm91bmRDb21tYW5kKFwiZWNobyAnZm9vICYgYmFyJ1wiKTtcblx0XHRcdGFzc2VydC5lcXVhbChyLnJld3JpdHRlbiwgZmFsc2UpO1xuXHRcdH0pO1xuXHR9KTtcblxuXHRkZXNjcmliZShcInJld3JpdGUgY2FzZXMgKCYgYmFja2dyb3VuZGluZylcIiwgKCkgPT4ge1xuXHRcdGl0KFwicmV3cml0ZXMgYmFyZSBiYWNrZ3JvdW5kIGNvbW1hbmRcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgciA9IHJld3JpdGVCYWNrZ3JvdW5kQ29tbWFuZChcInB5dGhvbiAtbSBodHRwLnNlcnZlciA4MDgwICZcIik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoci5yZXdyaXR0ZW4sIHRydWUpO1xuXHRcdFx0YXNzZXJ0Lm9rKHIuY29tbWFuZC5pbmNsdWRlcyhcIj4vZGV2L251bGwgMj4mMVwiKSwgXCJpbmplY3RzIHN0ZG91dCByZWRpcmVjdFwiKTtcblx0XHRcdGFzc2VydC5vayhyLmNvbW1hbmQuaW5jbHVkZXMoXCImXCIpLCBcInByZXNlcnZlcyBiYWNrZ3JvdW5kIG9wZXJhdG9yXCIpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJyZXdyaXRlcyBiYWNrZ3JvdW5kIGNvbW1hbmQgd2l0aCB0cmFpbGluZyB3aGl0ZXNwYWNlXCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHIgPSByZXdyaXRlQmFja2dyb3VuZENvbW1hbmQoXCJweXRob24gLW0gaHR0cC5zZXJ2ZXIgODA4MCAmICAgXCIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHIucmV3cml0dGVuLCB0cnVlKTtcblx0XHRcdGFzc2VydC5vayhyLmNvbW1hbmQuaW5jbHVkZXMoXCI+L2Rldi9udWxsIDI+JjFcIikpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJyZXdyaXRlcyBiYWNrZ3JvdW5kIGNvbW1hbmQgd2l0aCAmIGRpc293blwiLCAoKSA9PiB7XG5cdFx0XHRjb25zdCByID0gcmV3cml0ZUJhY2tncm91bmRDb21tYW5kKFwibm9kZSBzZXJ2ZXIuanMgJiBkaXNvd25cIik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoci5yZXdyaXR0ZW4sIHRydWUpO1xuXHRcdFx0YXNzZXJ0Lm9rKHIuY29tbWFuZC5pbmNsdWRlcyhcIj4vZGV2L251bGwgMj4mMVwiKSk7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgTk9UIGRvdWJsZS1pbmplY3Qgd2hlbiBzdGRvdXQgYWxyZWFkeSByZWRpcmVjdGVkICg+KVwiLCAoKSA9PiB7XG5cdFx0XHRjb25zdCByID0gcmV3cml0ZUJhY2tncm91bmRDb21tYW5kKFwicHl0aG9uIC1tIGh0dHAuc2VydmVyIDgwODAgPiBzZXJ2ZXIubG9nICZcIik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoci5yZXdyaXR0ZW4sIGZhbHNlLCBcImFscmVhZHkgaGFzID4gcmVkaXJlY3RcIik7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgTk9UIGluamVjdCB3aGVuIGFscmVhZHkgcmVkaXJlY3RlZCB0byAvZGV2L251bGxcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgciA9IHJld3JpdGVCYWNrZ3JvdW5kQ29tbWFuZChcInB5dGhvbiAtbSBodHRwLnNlcnZlciA4MDgwID4vZGV2L251bGwgMj4mMSAmXCIpO1xuXHRcdFx0YXNzZXJ0LmVxdWFsKHIucmV3cml0dGVuLCBmYWxzZSwgXCJhbHJlYWR5IGZ1bGx5IHJlZGlyZWN0ZWRcIik7XG5cdFx0fSk7XG5cblx0XHRpdChcImRvZXMgTk9UIGluamVjdCB3aGVuIGNvbW1hbmQgdXNlcyBhIHBpcGVcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgciA9IHJld3JpdGVCYWNrZ3JvdW5kQ29tbWFuZChcInB5dGhvbiAtbSBodHRwLnNlcnZlciA4MDgwIHwgdGVlIHNlcnZlci5sb2cgJlwiKTtcblx0XHRcdGFzc2VydC5lcXVhbChyLnJld3JpdHRlbiwgZmFsc2UsIFwic3Rkb3V0IHBpcGVkIGVsc2V3aGVyZVwiKTtcblx0XHR9KTtcblx0fSk7XG5cblx0ZGVzY3JpYmUoXCJjb21wb3VuZCBjb21tYW5kc1wiLCAoKSA9PiB7XG5cdFx0aXQoXCJyZXdyaXRlcyBvbmx5IHRoZSBiYWNrZ3JvdW5kZWQgc2VnbWVudCBpbiBhIGNvbXBvdW5kIGNvbW1hbmRcIiwgKCkgPT4ge1xuXHRcdFx0Y29uc3QgciA9IHJld3JpdGVCYWNrZ3JvdW5kQ29tbWFuZChcImVjaG8gc3RhcnRpbmc7IHB5dGhvbiAtbSBodHRwLnNlcnZlciA4MDgwICZcIik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoci5yZXdyaXR0ZW4sIHRydWUpO1xuXHRcdFx0YXNzZXJ0Lm9rKHIuY29tbWFuZC5pbmNsdWRlcyhcIj4vZGV2L251bGwgMj4mMSAmXCIpKTtcblx0XHRcdGFzc2VydC5vayhyLmNvbW1hbmQuaW5jbHVkZXMoXCJlY2hvIHN0YXJ0aW5nXCIpLCBcIm5vbi1iYWNrZ3JvdW5kIHBhcnQgcHJlc2VydmVkXCIpO1xuXHRcdH0pO1xuXG5cdFx0aXQoXCJoYW5kbGVzIG11bHRpcGxlIGJhY2tncm91bmRlZCBjb21tYW5kc1wiLCAoKSA9PiB7XG5cdFx0XHRjb25zdCByID0gcmV3cml0ZUJhY2tncm91bmRDb21tYW5kKFwibm9kZSBzZXJ2ZXIuanMgJlxcbnB5dGhvbiB3b3JrZXIucHkgJlwiKTtcblx0XHRcdGFzc2VydC5lcXVhbChyLnJld3JpdHRlbiwgdHJ1ZSk7XG5cdFx0XHRjb25zdCBvY2N1cnJlbmNlcyA9IChyLmNvbW1hbmQubWF0Y2goL1xcL2RldlxcL251bGwvZykgPz8gW10pLmxlbmd0aDtcblx0XHRcdGFzc2VydC5vayhvY2N1cnJlbmNlcyA+PSAyLCBcImJvdGggYmFja2dyb3VuZCBjb21tYW5kcyByZXdyaXR0ZW5cIik7XG5cdFx0fSk7XG5cdH0pO1xuXG5cdGRlc2NyaWJlKFwibm9odXAgLyBhbHJlYWR5LXNhZmUgcGF0dGVybnMgcGFzcyB0aHJvdWdoXCIsICgpID0+IHtcblx0XHRpdChcIm5vaHVwIC4uLiAmIHBhc3NlcyB0aHJvdWdoIHVuY2hhbmdlZCAoYWxyZWFkeSByZWRpcmVjdHMpXCIsICgpID0+IHtcblx0XHRcdGNvbnN0IHIgPSByZXdyaXRlQmFja2dyb3VuZENvbW1hbmQoXCJub2h1cCBweXRob24gLW0gaHR0cC5zZXJ2ZXIgODA4MCA+IC9kZXYvbnVsbCAyPiYxICZcIik7XG5cdFx0XHRhc3NlcnQuZXF1YWwoci5yZXdyaXR0ZW4sIGZhbHNlKTtcblx0XHR9KTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVNBLFNBQVMsVUFBVSxVQUFVO0FBQzdCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGdDQUFnQztBQUV6QyxTQUFTLDRCQUE0QixNQUFNO0FBQzFDLFdBQVMsK0JBQStCLE1BQU07QUFDN0MsT0FBRyw0Q0FBNEMsTUFBTTtBQUNwRCxZQUFNLElBQUkseUJBQXlCLDRCQUE0QjtBQUMvRCxhQUFPLE1BQU0sRUFBRSxXQUFXLEtBQUs7QUFDL0IsYUFBTyxNQUFNLEVBQUUsU0FBUyw0QkFBNEI7QUFBQSxJQUNyRCxDQUFDO0FBRUQsT0FBRyxrREFBa0QsTUFBTTtBQUMxRCxZQUFNLElBQUkseUJBQXlCLDBCQUEwQjtBQUM3RCxhQUFPLE1BQU0sRUFBRSxXQUFXLEtBQUs7QUFBQSxJQUNoQyxDQUFDO0FBRUQsT0FBRyxtREFBbUQsTUFBTTtBQUMzRCxZQUFNLElBQUkseUJBQXlCLGtCQUFrQjtBQUNyRCxhQUFPLE1BQU0sRUFBRSxXQUFXLEtBQUs7QUFBQSxJQUNoQyxDQUFDO0FBQUEsRUFDRixDQUFDO0FBRUQsV0FBUyxtQ0FBbUMsTUFBTTtBQUNqRCxPQUFHLG9DQUFvQyxNQUFNO0FBQzVDLFlBQU0sSUFBSSx5QkFBeUIsOEJBQThCO0FBQ2pFLGFBQU8sTUFBTSxFQUFFLFdBQVcsSUFBSTtBQUM5QixhQUFPLEdBQUcsRUFBRSxRQUFRLFNBQVMsaUJBQWlCLEdBQUcseUJBQXlCO0FBQzFFLGFBQU8sR0FBRyxFQUFFLFFBQVEsU0FBUyxHQUFHLEdBQUcsK0JBQStCO0FBQUEsSUFDbkUsQ0FBQztBQUVELE9BQUcsd0RBQXdELE1BQU07QUFDaEUsWUFBTSxJQUFJLHlCQUF5QixpQ0FBaUM7QUFDcEUsYUFBTyxNQUFNLEVBQUUsV0FBVyxJQUFJO0FBQzlCLGFBQU8sR0FBRyxFQUFFLFFBQVEsU0FBUyxpQkFBaUIsQ0FBQztBQUFBLElBQ2hELENBQUM7QUFFRCxPQUFHLDZDQUE2QyxNQUFNO0FBQ3JELFlBQU0sSUFBSSx5QkFBeUIseUJBQXlCO0FBQzVELGFBQU8sTUFBTSxFQUFFLFdBQVcsSUFBSTtBQUM5QixhQUFPLEdBQUcsRUFBRSxRQUFRLFNBQVMsaUJBQWlCLENBQUM7QUFBQSxJQUNoRCxDQUFDO0FBRUQsT0FBRyw2REFBNkQsTUFBTTtBQUNyRSxZQUFNLElBQUkseUJBQXlCLDJDQUEyQztBQUM5RSxhQUFPLE1BQU0sRUFBRSxXQUFXLE9BQU8sd0JBQXdCO0FBQUEsSUFDMUQsQ0FBQztBQUVELE9BQUcsd0RBQXdELE1BQU07QUFDaEUsWUFBTSxJQUFJLHlCQUF5Qiw4Q0FBOEM7QUFDakYsYUFBTyxNQUFNLEVBQUUsV0FBVyxPQUFPLDBCQUEwQjtBQUFBLElBQzVELENBQUM7QUFFRCxPQUFHLDRDQUE0QyxNQUFNO0FBQ3BELFlBQU0sSUFBSSx5QkFBeUIsK0NBQStDO0FBQ2xGLGFBQU8sTUFBTSxFQUFFLFdBQVcsT0FBTyx3QkFBd0I7QUFBQSxJQUMxRCxDQUFDO0FBQUEsRUFDRixDQUFDO0FBRUQsV0FBUyxxQkFBcUIsTUFBTTtBQUNuQyxPQUFHLGdFQUFnRSxNQUFNO0FBQ3hFLFlBQU0sSUFBSSx5QkFBeUIsNkNBQTZDO0FBQ2hGLGFBQU8sTUFBTSxFQUFFLFdBQVcsSUFBSTtBQUM5QixhQUFPLEdBQUcsRUFBRSxRQUFRLFNBQVMsbUJBQW1CLENBQUM7QUFDakQsYUFBTyxHQUFHLEVBQUUsUUFBUSxTQUFTLGVBQWUsR0FBRywrQkFBK0I7QUFBQSxJQUMvRSxDQUFDO0FBRUQsT0FBRywwQ0FBMEMsTUFBTTtBQUNsRCxZQUFNLElBQUkseUJBQXlCLHNDQUFzQztBQUN6RSxhQUFPLE1BQU0sRUFBRSxXQUFXLElBQUk7QUFDOUIsWUFBTSxlQUFlLEVBQUUsUUFBUSxNQUFNLGNBQWMsS0FBSyxDQUFDLEdBQUc7QUFDNUQsYUFBTyxHQUFHLGVBQWUsR0FBRyxvQ0FBb0M7QUFBQSxJQUNqRSxDQUFDO0FBQUEsRUFDRixDQUFDO0FBRUQsV0FBUyw4Q0FBOEMsTUFBTTtBQUM1RCxPQUFHLDREQUE0RCxNQUFNO0FBQ3BFLFlBQU0sSUFBSSx5QkFBeUIscURBQXFEO0FBQ3hGLGFBQU8sTUFBTSxFQUFFLFdBQVcsS0FBSztBQUFBLElBQ2hDLENBQUM7QUFBQSxFQUNGLENBQUM7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
