import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isBlockedUrl, setFetchAllowedUrls, getFetchAllowedUrls } from "../resources/extensions/search-the-web/url-utils.js";
describe("isBlockedUrl \u2014 SSRF protection", () => {
  it("blocks localhost", () => {
    assert.equal(isBlockedUrl("http://localhost/admin"), true);
    assert.equal(isBlockedUrl("http://localhost:8080/"), true);
  });
  it("blocks 127.0.0.0/8", () => {
    assert.equal(isBlockedUrl("http://127.0.0.1/"), true);
    assert.equal(isBlockedUrl("http://127.0.0.2:3000/path"), true);
  });
  it("blocks 10.0.0.0/8 (private)", () => {
    assert.equal(isBlockedUrl("http://10.0.0.1/"), true);
    assert.equal(isBlockedUrl("http://10.255.255.255/"), true);
  });
  it("blocks 172.16-31.x.x (private)", () => {
    assert.equal(isBlockedUrl("http://172.16.0.1/"), true);
    assert.equal(isBlockedUrl("http://172.31.255.255/"), true);
  });
  it("blocks 192.168.x.x (private)", () => {
    assert.equal(isBlockedUrl("http://192.168.1.1/"), true);
    assert.equal(isBlockedUrl("http://192.168.0.100:9200/"), true);
  });
  it("blocks 169.254.x.x (link-local / cloud metadata)", () => {
    assert.equal(isBlockedUrl("http://169.254.169.254/latest/meta-data/"), true);
  });
  it("blocks cloud metadata hostnames", () => {
    assert.equal(isBlockedUrl("http://metadata.google.internal/computeMetadata/"), true);
  });
  it("blocks non-http protocols", () => {
    assert.equal(isBlockedUrl("file:///etc/passwd"), true);
    assert.equal(isBlockedUrl("ftp://internal.server/data"), true);
  });
  it("blocks invalid URLs", () => {
    assert.equal(isBlockedUrl("not-a-url"), true);
    assert.equal(isBlockedUrl(""), true);
  });
  it("allows public URLs", () => {
    assert.equal(isBlockedUrl("https://example.com"), false);
    assert.equal(isBlockedUrl("https://api.github.com/repos"), false);
    assert.equal(isBlockedUrl("http://docs.python.org/3/"), false);
  });
  it("allows public IPs", () => {
    assert.equal(isBlockedUrl("http://8.8.8.8/"), false);
    assert.equal(isBlockedUrl("https://1.1.1.1/"), false);
  });
});
describe("REGRESSION #666: private URL blocked with no override", () => {
  afterEach(() => {
    setFetchAllowedUrls([]);
  });
  it("private IP is blocked by default, then unblocked by setFetchAllowedUrls", () => {
    const internalUrl = "http://192.168.1.100/internal-docs/api-reference";
    assert.equal(isBlockedUrl(internalUrl), true, "private IP is blocked by the hardcoded blocklist");
    setFetchAllowedUrls(["192.168.1.100"]);
    assert.equal(isBlockedUrl(internalUrl), false, "private IP must not be blocked after override");
  });
});
describe("setFetchAllowedUrls \u2014 user override", () => {
  afterEach(() => {
    setFetchAllowedUrls([]);
  });
  it("defaults to empty allowlist", () => {
    assert.deepEqual(getFetchAllowedUrls(), []);
  });
  it("exempts an allowed hostname from blocking", () => {
    assert.equal(isBlockedUrl("http://192.168.1.100/docs"), true, "blocked by default");
    setFetchAllowedUrls(["192.168.1.100"]);
    assert.equal(isBlockedUrl("http://192.168.1.100/docs"), false, "allowed after override");
  });
  it("exempts localhost when explicitly allowed", () => {
    assert.equal(isBlockedUrl("http://localhost:3000/api"), true, "blocked by default");
    setFetchAllowedUrls(["localhost"]);
    assert.equal(isBlockedUrl("http://localhost:3000/api"), false, "allowed after override");
  });
  it("exempts cloud metadata hostname when allowed", () => {
    assert.equal(isBlockedUrl("http://metadata.google.internal/computeMetadata/"), true, "blocked by default");
    setFetchAllowedUrls(["metadata.google.internal"]);
    assert.equal(isBlockedUrl("http://metadata.google.internal/computeMetadata/"), false, "allowed after override");
  });
  it("does not affect URLs not in the allowlist", () => {
    setFetchAllowedUrls(["192.168.1.100"]);
    assert.equal(isBlockedUrl("http://192.168.1.200/secret"), true, "other private IPs still blocked");
    assert.equal(isBlockedUrl("http://localhost/admin"), true, "localhost still blocked");
  });
  it("still allows public URLs without configuration", () => {
    setFetchAllowedUrls(["192.168.1.100"]);
    assert.equal(isBlockedUrl("https://example.com"), false);
  });
  it("still blocks non-HTTP protocols even with allowlist", () => {
    setFetchAllowedUrls(["localhost"]);
    assert.equal(isBlockedUrl("file:///etc/passwd"), true, "file:// still blocked");
    assert.equal(isBlockedUrl("ftp://localhost/data"), true, "ftp:// still blocked");
  });
  it("is case-insensitive for hostnames", () => {
    setFetchAllowedUrls(["MyHost.Internal"]);
    assert.equal(isBlockedUrl("http://myhost.internal/api"), false);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL3VybC11dGlscy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgaXQsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgaXNCbG9ja2VkVXJsLCBzZXRGZXRjaEFsbG93ZWRVcmxzLCBnZXRGZXRjaEFsbG93ZWRVcmxzIH0gZnJvbSBcIi4uL3Jlc291cmNlcy9leHRlbnNpb25zL3NlYXJjaC10aGUtd2ViL3VybC11dGlscy50c1wiO1xuXG5kZXNjcmliZShcImlzQmxvY2tlZFVybCBcdTIwMTQgU1NSRiBwcm90ZWN0aW9uXCIsICgpID0+IHtcbiAgaXQoXCJibG9ja3MgbG9jYWxob3N0XCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoaXNCbG9ja2VkVXJsKFwiaHR0cDovL2xvY2FsaG9zdC9hZG1pblwiKSwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQmxvY2tlZFVybChcImh0dHA6Ly9sb2NhbGhvc3Q6ODA4MC9cIiksIHRydWUpO1xuICB9KTtcblxuICBpdChcImJsb2NrcyAxMjcuMC4wLjAvOFwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQmxvY2tlZFVybChcImh0dHA6Ly8xMjcuMC4wLjEvXCIpLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNCbG9ja2VkVXJsKFwiaHR0cDovLzEyNy4wLjAuMjozMDAwL3BhdGhcIiksIHRydWUpO1xuICB9KTtcblxuICBpdChcImJsb2NrcyAxMC4wLjAuMC84IChwcml2YXRlKVwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQmxvY2tlZFVybChcImh0dHA6Ly8xMC4wLjAuMS9cIiksIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChpc0Jsb2NrZWRVcmwoXCJodHRwOi8vMTAuMjU1LjI1NS4yNTUvXCIpLCB0cnVlKTtcbiAgfSk7XG5cbiAgaXQoXCJibG9ja3MgMTcyLjE2LTMxLngueCAocHJpdmF0ZSlcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChpc0Jsb2NrZWRVcmwoXCJodHRwOi8vMTcyLjE2LjAuMS9cIiksIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChpc0Jsb2NrZWRVcmwoXCJodHRwOi8vMTcyLjMxLjI1NS4yNTUvXCIpLCB0cnVlKTtcbiAgfSk7XG5cbiAgaXQoXCJibG9ja3MgMTkyLjE2OC54LnggKHByaXZhdGUpXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoaXNCbG9ja2VkVXJsKFwiaHR0cDovLzE5Mi4xNjguMS4xL1wiKSwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQmxvY2tlZFVybChcImh0dHA6Ly8xOTIuMTY4LjAuMTAwOjkyMDAvXCIpLCB0cnVlKTtcbiAgfSk7XG5cbiAgaXQoXCJibG9ja3MgMTY5LjI1NC54LnggKGxpbmstbG9jYWwgLyBjbG91ZCBtZXRhZGF0YSlcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChpc0Jsb2NrZWRVcmwoXCJodHRwOi8vMTY5LjI1NC4xNjkuMjU0L2xhdGVzdC9tZXRhLWRhdGEvXCIpLCB0cnVlKTtcbiAgfSk7XG5cbiAgaXQoXCJibG9ja3MgY2xvdWQgbWV0YWRhdGEgaG9zdG5hbWVzXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoaXNCbG9ja2VkVXJsKFwiaHR0cDovL21ldGFkYXRhLmdvb2dsZS5pbnRlcm5hbC9jb21wdXRlTWV0YWRhdGEvXCIpLCB0cnVlKTtcbiAgfSk7XG5cbiAgaXQoXCJibG9ja3Mgbm9uLWh0dHAgcHJvdG9jb2xzXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoaXNCbG9ja2VkVXJsKFwiZmlsZTovLy9ldGMvcGFzc3dkXCIpLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNCbG9ja2VkVXJsKFwiZnRwOi8vaW50ZXJuYWwuc2VydmVyL2RhdGFcIiksIHRydWUpO1xuICB9KTtcblxuICBpdChcImJsb2NrcyBpbnZhbGlkIFVSTHNcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChpc0Jsb2NrZWRVcmwoXCJub3QtYS11cmxcIiksIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChpc0Jsb2NrZWRVcmwoXCJcIiksIHRydWUpO1xuICB9KTtcblxuICBpdChcImFsbG93cyBwdWJsaWMgVVJMc1wiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQmxvY2tlZFVybChcImh0dHBzOi8vZXhhbXBsZS5jb21cIiksIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNCbG9ja2VkVXJsKFwiaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvc1wiKSwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChpc0Jsb2NrZWRVcmwoXCJodHRwOi8vZG9jcy5weXRob24ub3JnLzMvXCIpLCBmYWxzZSk7XG4gIH0pO1xuXG4gIGl0KFwiYWxsb3dzIHB1YmxpYyBJUHNcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChpc0Jsb2NrZWRVcmwoXCJodHRwOi8vOC44LjguOC9cIiksIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNCbG9ja2VkVXJsKFwiaHR0cHM6Ly8xLjEuMS4xL1wiKSwgZmFsc2UpO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcIlJFR1JFU1NJT04gIzY2NjogcHJpdmF0ZSBVUkwgYmxvY2tlZCB3aXRoIG5vIG92ZXJyaWRlXCIsICgpID0+IHtcbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICBzZXRGZXRjaEFsbG93ZWRVcmxzKFtdKTtcbiAgfSk7XG5cbiAgaXQoXCJwcml2YXRlIElQIGlzIGJsb2NrZWQgYnkgZGVmYXVsdCwgdGhlbiB1bmJsb2NrZWQgYnkgc2V0RmV0Y2hBbGxvd2VkVXJsc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgaW50ZXJuYWxVcmwgPSBcImh0dHA6Ly8xOTIuMTY4LjEuMTAwL2ludGVybmFsLWRvY3MvYXBpLXJlZmVyZW5jZVwiO1xuXG4gICAgLy8gQnVnOiBwcml2YXRlIElQIGlzIGJsb2NrZWQgd2l0aCBubyB3YXkgdG8gYWxsb3dsaXN0XG4gICAgYXNzZXJ0LmVxdWFsKGlzQmxvY2tlZFVybChpbnRlcm5hbFVybCksIHRydWUsIFwicHJpdmF0ZSBJUCBpcyBibG9ja2VkIGJ5IHRoZSBoYXJkY29kZWQgYmxvY2tsaXN0XCIpO1xuXG4gICAgLy8gRml4OiBvdmVycmlkZSB0aGUgYWxsb3dsaXN0IHRvIGluY2x1ZGUgdGhpcyBob3N0XG4gICAgc2V0RmV0Y2hBbGxvd2VkVXJscyhbXCIxOTIuMTY4LjEuMTAwXCJdKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNCbG9ja2VkVXJsKGludGVybmFsVXJsKSwgZmFsc2UsIFwicHJpdmF0ZSBJUCBtdXN0IG5vdCBiZSBibG9ja2VkIGFmdGVyIG92ZXJyaWRlXCIpO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcInNldEZldGNoQWxsb3dlZFVybHMgXHUyMDE0IHVzZXIgb3ZlcnJpZGVcIiwgKCkgPT4ge1xuICBhZnRlckVhY2goKCkgPT4ge1xuICAgIHNldEZldGNoQWxsb3dlZFVybHMoW10pO1xuICB9KTtcblxuICBpdChcImRlZmF1bHRzIHRvIGVtcHR5IGFsbG93bGlzdFwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChnZXRGZXRjaEFsbG93ZWRVcmxzKCksIFtdKTtcbiAgfSk7XG5cbiAgaXQoXCJleGVtcHRzIGFuIGFsbG93ZWQgaG9zdG5hbWUgZnJvbSBibG9ja2luZ1wiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQmxvY2tlZFVybChcImh0dHA6Ly8xOTIuMTY4LjEuMTAwL2RvY3NcIiksIHRydWUsIFwiYmxvY2tlZCBieSBkZWZhdWx0XCIpO1xuICAgIHNldEZldGNoQWxsb3dlZFVybHMoW1wiMTkyLjE2OC4xLjEwMFwiXSk7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQmxvY2tlZFVybChcImh0dHA6Ly8xOTIuMTY4LjEuMTAwL2RvY3NcIiksIGZhbHNlLCBcImFsbG93ZWQgYWZ0ZXIgb3ZlcnJpZGVcIik7XG4gIH0pO1xuXG4gIGl0KFwiZXhlbXB0cyBsb2NhbGhvc3Qgd2hlbiBleHBsaWNpdGx5IGFsbG93ZWRcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChpc0Jsb2NrZWRVcmwoXCJodHRwOi8vbG9jYWxob3N0OjMwMDAvYXBpXCIpLCB0cnVlLCBcImJsb2NrZWQgYnkgZGVmYXVsdFwiKTtcbiAgICBzZXRGZXRjaEFsbG93ZWRVcmxzKFtcImxvY2FsaG9zdFwiXSk7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQmxvY2tlZFVybChcImh0dHA6Ly9sb2NhbGhvc3Q6MzAwMC9hcGlcIiksIGZhbHNlLCBcImFsbG93ZWQgYWZ0ZXIgb3ZlcnJpZGVcIik7XG4gIH0pO1xuXG4gIGl0KFwiZXhlbXB0cyBjbG91ZCBtZXRhZGF0YSBob3N0bmFtZSB3aGVuIGFsbG93ZWRcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChpc0Jsb2NrZWRVcmwoXCJodHRwOi8vbWV0YWRhdGEuZ29vZ2xlLmludGVybmFsL2NvbXB1dGVNZXRhZGF0YS9cIiksIHRydWUsIFwiYmxvY2tlZCBieSBkZWZhdWx0XCIpO1xuICAgIHNldEZldGNoQWxsb3dlZFVybHMoW1wibWV0YWRhdGEuZ29vZ2xlLmludGVybmFsXCJdKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNCbG9ja2VkVXJsKFwiaHR0cDovL21ldGFkYXRhLmdvb2dsZS5pbnRlcm5hbC9jb21wdXRlTWV0YWRhdGEvXCIpLCBmYWxzZSwgXCJhbGxvd2VkIGFmdGVyIG92ZXJyaWRlXCIpO1xuICB9KTtcblxuICBpdChcImRvZXMgbm90IGFmZmVjdCBVUkxzIG5vdCBpbiB0aGUgYWxsb3dsaXN0XCIsICgpID0+IHtcbiAgICBzZXRGZXRjaEFsbG93ZWRVcmxzKFtcIjE5Mi4xNjguMS4xMDBcIl0pO1xuICAgIGFzc2VydC5lcXVhbChpc0Jsb2NrZWRVcmwoXCJodHRwOi8vMTkyLjE2OC4xLjIwMC9zZWNyZXRcIiksIHRydWUsIFwib3RoZXIgcHJpdmF0ZSBJUHMgc3RpbGwgYmxvY2tlZFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNCbG9ja2VkVXJsKFwiaHR0cDovL2xvY2FsaG9zdC9hZG1pblwiKSwgdHJ1ZSwgXCJsb2NhbGhvc3Qgc3RpbGwgYmxvY2tlZFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJzdGlsbCBhbGxvd3MgcHVibGljIFVSTHMgd2l0aG91dCBjb25maWd1cmF0aW9uXCIsICgpID0+IHtcbiAgICBzZXRGZXRjaEFsbG93ZWRVcmxzKFtcIjE5Mi4xNjguMS4xMDBcIl0pO1xuICAgIGFzc2VydC5lcXVhbChpc0Jsb2NrZWRVcmwoXCJodHRwczovL2V4YW1wbGUuY29tXCIpLCBmYWxzZSk7XG4gIH0pO1xuXG4gIGl0KFwic3RpbGwgYmxvY2tzIG5vbi1IVFRQIHByb3RvY29scyBldmVuIHdpdGggYWxsb3dsaXN0XCIsICgpID0+IHtcbiAgICBzZXRGZXRjaEFsbG93ZWRVcmxzKFtcImxvY2FsaG9zdFwiXSk7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQmxvY2tlZFVybChcImZpbGU6Ly8vZXRjL3Bhc3N3ZFwiKSwgdHJ1ZSwgXCJmaWxlOi8vIHN0aWxsIGJsb2NrZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGlzQmxvY2tlZFVybChcImZ0cDovL2xvY2FsaG9zdC9kYXRhXCIpLCB0cnVlLCBcImZ0cDovLyBzdGlsbCBibG9ja2VkXCIpO1xuICB9KTtcblxuICBpdChcImlzIGNhc2UtaW5zZW5zaXRpdmUgZm9yIGhvc3RuYW1lc1wiLCAoKSA9PiB7XG4gICAgc2V0RmV0Y2hBbGxvd2VkVXJscyhbXCJNeUhvc3QuSW50ZXJuYWxcIl0pO1xuICAgIGFzc2VydC5lcXVhbChpc0Jsb2NrZWRVcmwoXCJodHRwOi8vbXlob3N0LmludGVybmFsL2FwaVwiKSwgZmFsc2UpO1xuICB9KTtcbn0pOyJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxJQUFJLGlCQUFpQjtBQUN4QyxPQUFPLFlBQVk7QUFDbkIsU0FBUyxjQUFjLHFCQUFxQiwyQkFBMkI7QUFFdkUs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
