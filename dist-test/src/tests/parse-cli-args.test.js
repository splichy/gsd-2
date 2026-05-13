import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { buildHeadlessAutoArgs, parseCliArgs } from "../cli-web-branch.js";
function parse(...args) {
  return parseCliArgs(["node", "gsd", ...args]);
}
describe("parseCliArgs \u2014 modes", () => {
  test("accepts mcp mode (added during refactor)", () => {
    assert.equal(parse("--mode", "mcp").mode, "mcp");
  });
  test("still accepts text/json/rpc modes", () => {
    assert.equal(parse("--mode", "text").mode, "text");
    assert.equal(parse("--mode", "json").mode, "json");
    assert.equal(parse("--mode", "rpc").mode, "rpc");
  });
  test("ignores unknown mode values", () => {
    assert.equal(parse("--mode", "bogus").mode, void 0);
  });
});
describe("buildHeadlessAutoArgs", () => {
  test("preserves auto positional args without a model override", () => {
    const args = buildHeadlessAutoArgs({ messages: ["auto", "next"] });
    assert.deepEqual(args, ["auto", "next"]);
  });
  test("forwards --model before auto positional args", () => {
    const args = buildHeadlessAutoArgs({
      model: "claude-code/sonnet",
      messages: ["auto", "next"]
    });
    assert.deepEqual(args, ["--model", "claude-code/sonnet", "auto", "next"]);
  });
});
describe("parseCliArgs \u2014 worktree flag", () => {
  test("-w with no value sets worktree=true", () => {
    assert.equal(parse("-w").worktree, true);
  });
  test("--worktree with no value sets worktree=true", () => {
    assert.equal(parse("--worktree").worktree, true);
  });
  test("-w followed by a name captures the name", () => {
    assert.equal(parse("-w", "feature-x").worktree, "feature-x");
  });
  test("--worktree followed by a name captures the name", () => {
    assert.equal(parse("--worktree", "feature-x").worktree, "feature-x");
  });
  test("-w followed by another flag does not consume the flag", () => {
    const flags = parse("-w", "--print");
    assert.equal(flags.worktree, true);
    assert.equal(flags.print, true);
  });
  test("worktree is undefined when flag not passed", () => {
    assert.equal(parse("hello").worktree, void 0);
  });
});
describe("parseCliArgs \u2014 short flags and basic options", () => {
  test("-p sets print", () => {
    assert.equal(parse("-p").print, true);
  });
  test("--print sets print", () => {
    assert.equal(parse("--print").print, true);
  });
  test("-c sets continue", () => {
    assert.equal(parse("-c").continue, true);
  });
  test("--no-session sets noSession", () => {
    assert.equal(parse("--no-session").noSession, true);
  });
  test("--model captures model id", () => {
    assert.equal(parse("--model", "claude-opus-4-6").model, "claude-opus-4-6");
  });
});
describe("parseCliArgs \u2014 list flags and accumulators", () => {
  test("--extension accumulates multiple values", () => {
    const flags = parse("--extension", "a", "--extension", "b");
    assert.deepEqual(flags.extensions, ["a", "b"]);
  });
  test("--tools splits comma-separated list", () => {
    assert.deepEqual(parse("--tools", "read,write,edit").tools, ["read", "write", "edit"]);
  });
  test("--list-models with no value sets to true", () => {
    assert.equal(parse("--list-models").listModels, true);
  });
  test("--list-models with provider filter captures provider", () => {
    assert.equal(parse("--list-models", "anthropic").listModels, "anthropic");
  });
  test("--list-models followed by another flag does not consume it", () => {
    const flags = parse("--list-models", "--print");
    assert.equal(flags.listModels, true);
    assert.equal(flags.print, true);
  });
});
describe("parseCliArgs \u2014 web mode flags", () => {
  test("--web with no path sets web=true", () => {
    const flags = parse("--web");
    assert.equal(flags.web, true);
    assert.equal(flags.webPath, void 0);
  });
  test("--web with a path captures it", () => {
    const flags = parse("--web", "/tmp/project");
    assert.equal(flags.web, true);
    assert.equal(flags.webPath, "/tmp/project");
  });
  test("--port parses valid integer", () => {
    assert.equal(parse("--port", "8080").webPort, 8080);
  });
  test("--port rejects non-numeric", () => {
    assert.equal(parse("--port", "abc").webPort, void 0);
  });
  test("--port rejects out-of-range values", () => {
    assert.equal(parse("--port", "0").webPort, void 0);
    assert.equal(parse("--port", "70000").webPort, void 0);
  });
  test("--allowed-origins splits and trims comma list", () => {
    assert.deepEqual(
      parse("--allowed-origins", "http://a.com, http://b.com ,http://c.com").webAllowedOrigins,
      ["http://a.com", "http://b.com", "http://c.com"]
    );
  });
});
describe("parseCliArgs \u2014 positional messages", () => {
  test("non-flag positional args become messages", () => {
    const flags = parse("hello", "world");
    assert.deepEqual(flags.messages, ["hello", "world"]);
  });
  test("messages and flags can be interleaved", () => {
    const flags = parse("hello", "--print", "world");
    assert.deepEqual(flags.messages, ["hello", "world"]);
    assert.equal(flags.print, true);
  });
  test("default messages and extensions are empty arrays", () => {
    const flags = parse();
    assert.deepEqual(flags.messages, []);
    assert.deepEqual(flags.extensions, []);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL3BhcnNlLWNsaS1hcmdzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yIFx1MjAxNCBVbml0IHRlc3RzIGZvciBwYXJzZUNsaUFyZ3MgKGNhbm9uaWNhbCBDTEkgZmxhZyBwYXJzZXIpXG4vLyBDb3B5cmlnaHQgKGMpIDIwMjYgSmVyZW15IE1jU3BhZGRlbiA8amVyZW15QGZsdXhsYWJzLm5ldD5cblxuaW1wb3J0IHRlc3QsIHsgZGVzY3JpYmUgfSBmcm9tICdub2RlOnRlc3QnXG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCdcbmltcG9ydCB7IGJ1aWxkSGVhZGxlc3NBdXRvQXJncywgcGFyc2VDbGlBcmdzIH0gZnJvbSAnLi4vY2xpLXdlYi1icmFuY2gudHMnXG5cbmZ1bmN0aW9uIHBhcnNlKC4uLmFyZ3M6IHN0cmluZ1tdKSB7XG4gIHJldHVybiBwYXJzZUNsaUFyZ3MoWydub2RlJywgJ2dzZCcsIC4uLmFyZ3NdKVxufVxuXG5kZXNjcmliZSgncGFyc2VDbGlBcmdzIFx1MjAxNCBtb2RlcycsICgpID0+IHtcbiAgdGVzdCgnYWNjZXB0cyBtY3AgbW9kZSAoYWRkZWQgZHVyaW5nIHJlZmFjdG9yKScsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2UoJy0tbW9kZScsICdtY3AnKS5tb2RlLCAnbWNwJylcbiAgfSlcblxuICB0ZXN0KCdzdGlsbCBhY2NlcHRzIHRleHQvanNvbi9ycGMgbW9kZXMnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHBhcnNlKCctLW1vZGUnLCAndGV4dCcpLm1vZGUsICd0ZXh0JylcbiAgICBhc3NlcnQuZXF1YWwocGFyc2UoJy0tbW9kZScsICdqc29uJykubW9kZSwgJ2pzb24nKVxuICAgIGFzc2VydC5lcXVhbChwYXJzZSgnLS1tb2RlJywgJ3JwYycpLm1vZGUsICdycGMnKVxuICB9KVxuXG4gIHRlc3QoJ2lnbm9yZXMgdW5rbm93biBtb2RlIHZhbHVlcycsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2UoJy0tbW9kZScsICdib2d1cycpLm1vZGUsIHVuZGVmaW5lZClcbiAgfSlcbn0pXG5cbmRlc2NyaWJlKCdidWlsZEhlYWRsZXNzQXV0b0FyZ3MnLCAoKSA9PiB7XG4gIHRlc3QoJ3ByZXNlcnZlcyBhdXRvIHBvc2l0aW9uYWwgYXJncyB3aXRob3V0IGEgbW9kZWwgb3ZlcnJpZGUnLCAoKSA9PiB7XG4gICAgY29uc3QgYXJncyA9IGJ1aWxkSGVhZGxlc3NBdXRvQXJncyh7IG1lc3NhZ2VzOiBbJ2F1dG8nLCAnbmV4dCddIH0pXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChhcmdzLCBbJ2F1dG8nLCAnbmV4dCddKVxuICB9KVxuXG4gIHRlc3QoJ2ZvcndhcmRzIC0tbW9kZWwgYmVmb3JlIGF1dG8gcG9zaXRpb25hbCBhcmdzJywgKCkgPT4ge1xuICAgIGNvbnN0IGFyZ3MgPSBidWlsZEhlYWRsZXNzQXV0b0FyZ3Moe1xuICAgICAgbW9kZWw6ICdjbGF1ZGUtY29kZS9zb25uZXQnLFxuICAgICAgbWVzc2FnZXM6IFsnYXV0bycsICduZXh0J10sXG4gICAgfSlcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGFyZ3MsIFsnLS1tb2RlbCcsICdjbGF1ZGUtY29kZS9zb25uZXQnLCAnYXV0bycsICduZXh0J10pXG4gIH0pXG59KVxuXG5kZXNjcmliZSgncGFyc2VDbGlBcmdzIFx1MjAxNCB3b3JrdHJlZSBmbGFnJywgKCkgPT4ge1xuICB0ZXN0KCctdyB3aXRoIG5vIHZhbHVlIHNldHMgd29ya3RyZWU9dHJ1ZScsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2UoJy13Jykud29ya3RyZWUsIHRydWUpXG4gIH0pXG5cbiAgdGVzdCgnLS13b3JrdHJlZSB3aXRoIG5vIHZhbHVlIHNldHMgd29ya3RyZWU9dHJ1ZScsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2UoJy0td29ya3RyZWUnKS53b3JrdHJlZSwgdHJ1ZSlcbiAgfSlcblxuICB0ZXN0KCctdyBmb2xsb3dlZCBieSBhIG5hbWUgY2FwdHVyZXMgdGhlIG5hbWUnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHBhcnNlKCctdycsICdmZWF0dXJlLXgnKS53b3JrdHJlZSwgJ2ZlYXR1cmUteCcpXG4gIH0pXG5cbiAgdGVzdCgnLS13b3JrdHJlZSBmb2xsb3dlZCBieSBhIG5hbWUgY2FwdHVyZXMgdGhlIG5hbWUnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHBhcnNlKCctLXdvcmt0cmVlJywgJ2ZlYXR1cmUteCcpLndvcmt0cmVlLCAnZmVhdHVyZS14JylcbiAgfSlcblxuICB0ZXN0KCctdyBmb2xsb3dlZCBieSBhbm90aGVyIGZsYWcgZG9lcyBub3QgY29uc3VtZSB0aGUgZmxhZycsICgpID0+IHtcbiAgICBjb25zdCBmbGFncyA9IHBhcnNlKCctdycsICctLXByaW50JylcbiAgICBhc3NlcnQuZXF1YWwoZmxhZ3Mud29ya3RyZWUsIHRydWUpXG4gICAgYXNzZXJ0LmVxdWFsKGZsYWdzLnByaW50LCB0cnVlKVxuICB9KVxuXG4gIHRlc3QoJ3dvcmt0cmVlIGlzIHVuZGVmaW5lZCB3aGVuIGZsYWcgbm90IHBhc3NlZCcsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2UoJ2hlbGxvJykud29ya3RyZWUsIHVuZGVmaW5lZClcbiAgfSlcbn0pXG5cbmRlc2NyaWJlKCdwYXJzZUNsaUFyZ3MgXHUyMDE0IHNob3J0IGZsYWdzIGFuZCBiYXNpYyBvcHRpb25zJywgKCkgPT4ge1xuICB0ZXN0KCctcCBzZXRzIHByaW50JywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChwYXJzZSgnLXAnKS5wcmludCwgdHJ1ZSlcbiAgfSlcblxuICB0ZXN0KCctLXByaW50IHNldHMgcHJpbnQnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHBhcnNlKCctLXByaW50JykucHJpbnQsIHRydWUpXG4gIH0pXG5cbiAgdGVzdCgnLWMgc2V0cyBjb250aW51ZScsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2UoJy1jJykuY29udGludWUsIHRydWUpXG4gIH0pXG5cbiAgdGVzdCgnLS1uby1zZXNzaW9uIHNldHMgbm9TZXNzaW9uJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChwYXJzZSgnLS1uby1zZXNzaW9uJykubm9TZXNzaW9uLCB0cnVlKVxuICB9KVxuXG4gIHRlc3QoJy0tbW9kZWwgY2FwdHVyZXMgbW9kZWwgaWQnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHBhcnNlKCctLW1vZGVsJywgJ2NsYXVkZS1vcHVzLTQtNicpLm1vZGVsLCAnY2xhdWRlLW9wdXMtNC02JylcbiAgfSlcbn0pXG5cbmRlc2NyaWJlKCdwYXJzZUNsaUFyZ3MgXHUyMDE0IGxpc3QgZmxhZ3MgYW5kIGFjY3VtdWxhdG9ycycsICgpID0+IHtcbiAgdGVzdCgnLS1leHRlbnNpb24gYWNjdW11bGF0ZXMgbXVsdGlwbGUgdmFsdWVzJywgKCkgPT4ge1xuICAgIGNvbnN0IGZsYWdzID0gcGFyc2UoJy0tZXh0ZW5zaW9uJywgJ2EnLCAnLS1leHRlbnNpb24nLCAnYicpXG4gICAgYXNzZXJ0LmRlZXBFcXVhbChmbGFncy5leHRlbnNpb25zLCBbJ2EnLCAnYiddKVxuICB9KVxuXG4gIHRlc3QoJy0tdG9vbHMgc3BsaXRzIGNvbW1hLXNlcGFyYXRlZCBsaXN0JywgKCkgPT4ge1xuICAgIGFzc2VydC5kZWVwRXF1YWwocGFyc2UoJy0tdG9vbHMnLCAncmVhZCx3cml0ZSxlZGl0JykudG9vbHMsIFsncmVhZCcsICd3cml0ZScsICdlZGl0J10pXG4gIH0pXG5cbiAgdGVzdCgnLS1saXN0LW1vZGVscyB3aXRoIG5vIHZhbHVlIHNldHMgdG8gdHJ1ZScsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2UoJy0tbGlzdC1tb2RlbHMnKS5saXN0TW9kZWxzLCB0cnVlKVxuICB9KVxuXG4gIHRlc3QoJy0tbGlzdC1tb2RlbHMgd2l0aCBwcm92aWRlciBmaWx0ZXIgY2FwdHVyZXMgcHJvdmlkZXInLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHBhcnNlKCctLWxpc3QtbW9kZWxzJywgJ2FudGhyb3BpYycpLmxpc3RNb2RlbHMsICdhbnRocm9waWMnKVxuICB9KVxuXG4gIHRlc3QoJy0tbGlzdC1tb2RlbHMgZm9sbG93ZWQgYnkgYW5vdGhlciBmbGFnIGRvZXMgbm90IGNvbnN1bWUgaXQnLCAoKSA9PiB7XG4gICAgY29uc3QgZmxhZ3MgPSBwYXJzZSgnLS1saXN0LW1vZGVscycsICctLXByaW50JylcbiAgICBhc3NlcnQuZXF1YWwoZmxhZ3MubGlzdE1vZGVscywgdHJ1ZSlcbiAgICBhc3NlcnQuZXF1YWwoZmxhZ3MucHJpbnQsIHRydWUpXG4gIH0pXG59KVxuXG5kZXNjcmliZSgncGFyc2VDbGlBcmdzIFx1MjAxNCB3ZWIgbW9kZSBmbGFncycsICgpID0+IHtcbiAgdGVzdCgnLS13ZWIgd2l0aCBubyBwYXRoIHNldHMgd2ViPXRydWUnLCAoKSA9PiB7XG4gICAgY29uc3QgZmxhZ3MgPSBwYXJzZSgnLS13ZWInKVxuICAgIGFzc2VydC5lcXVhbChmbGFncy53ZWIsIHRydWUpXG4gICAgYXNzZXJ0LmVxdWFsKGZsYWdzLndlYlBhdGgsIHVuZGVmaW5lZClcbiAgfSlcblxuICB0ZXN0KCctLXdlYiB3aXRoIGEgcGF0aCBjYXB0dXJlcyBpdCcsICgpID0+IHtcbiAgICBjb25zdCBmbGFncyA9IHBhcnNlKCctLXdlYicsICcvdG1wL3Byb2plY3QnKVxuICAgIGFzc2VydC5lcXVhbChmbGFncy53ZWIsIHRydWUpXG4gICAgYXNzZXJ0LmVxdWFsKGZsYWdzLndlYlBhdGgsICcvdG1wL3Byb2plY3QnKVxuICB9KVxuXG4gIHRlc3QoJy0tcG9ydCBwYXJzZXMgdmFsaWQgaW50ZWdlcicsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2UoJy0tcG9ydCcsICc4MDgwJykud2ViUG9ydCwgODA4MClcbiAgfSlcblxuICB0ZXN0KCctLXBvcnQgcmVqZWN0cyBub24tbnVtZXJpYycsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2UoJy0tcG9ydCcsICdhYmMnKS53ZWJQb3J0LCB1bmRlZmluZWQpXG4gIH0pXG5cbiAgdGVzdCgnLS1wb3J0IHJlamVjdHMgb3V0LW9mLXJhbmdlIHZhbHVlcycsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwocGFyc2UoJy0tcG9ydCcsICcwJykud2ViUG9ydCwgdW5kZWZpbmVkKVxuICAgIGFzc2VydC5lcXVhbChwYXJzZSgnLS1wb3J0JywgJzcwMDAwJykud2ViUG9ydCwgdW5kZWZpbmVkKVxuICB9KVxuXG4gIHRlc3QoJy0tYWxsb3dlZC1vcmlnaW5zIHNwbGl0cyBhbmQgdHJpbXMgY29tbWEgbGlzdCcsICgpID0+IHtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgICAgcGFyc2UoJy0tYWxsb3dlZC1vcmlnaW5zJywgJ2h0dHA6Ly9hLmNvbSwgaHR0cDovL2IuY29tICxodHRwOi8vYy5jb20nKS53ZWJBbGxvd2VkT3JpZ2lucyxcbiAgICAgIFsnaHR0cDovL2EuY29tJywgJ2h0dHA6Ly9iLmNvbScsICdodHRwOi8vYy5jb20nXSxcbiAgICApXG4gIH0pXG59KVxuXG5kZXNjcmliZSgncGFyc2VDbGlBcmdzIFx1MjAxNCBwb3NpdGlvbmFsIG1lc3NhZ2VzJywgKCkgPT4ge1xuICB0ZXN0KCdub24tZmxhZyBwb3NpdGlvbmFsIGFyZ3MgYmVjb21lIG1lc3NhZ2VzJywgKCkgPT4ge1xuICAgIGNvbnN0IGZsYWdzID0gcGFyc2UoJ2hlbGxvJywgJ3dvcmxkJylcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGZsYWdzLm1lc3NhZ2VzLCBbJ2hlbGxvJywgJ3dvcmxkJ10pXG4gIH0pXG5cbiAgdGVzdCgnbWVzc2FnZXMgYW5kIGZsYWdzIGNhbiBiZSBpbnRlcmxlYXZlZCcsICgpID0+IHtcbiAgICBjb25zdCBmbGFncyA9IHBhcnNlKCdoZWxsbycsICctLXByaW50JywgJ3dvcmxkJylcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGZsYWdzLm1lc3NhZ2VzLCBbJ2hlbGxvJywgJ3dvcmxkJ10pXG4gICAgYXNzZXJ0LmVxdWFsKGZsYWdzLnByaW50LCB0cnVlKVxuICB9KVxuXG4gIHRlc3QoJ2RlZmF1bHQgbWVzc2FnZXMgYW5kIGV4dGVuc2lvbnMgYXJlIGVtcHR5IGFycmF5cycsICgpID0+IHtcbiAgICBjb25zdCBmbGFncyA9IHBhcnNlKClcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGZsYWdzLm1lc3NhZ2VzLCBbXSlcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGZsYWdzLmV4dGVuc2lvbnMsIFtdKVxuICB9KVxufSlcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLE9BQU8sUUFBUSxnQkFBZ0I7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsdUJBQXVCLG9CQUFvQjtBQUVwRCxTQUFTLFNBQVMsTUFBZ0I7QUFDaEMsU0FBTyxhQUFhLENBQUMsUUFBUSxPQUFPLEdBQUcsSUFBSSxDQUFDO0FBQzlDO0FBRUEsU0FBUyw2QkFBd0IsTUFBTTtBQUNyQyxPQUFLLDRDQUE0QyxNQUFNO0FBQ3JELFdBQU8sTUFBTSxNQUFNLFVBQVUsS0FBSyxFQUFFLE1BQU0sS0FBSztBQUFBLEVBQ2pELENBQUM7QUFFRCxPQUFLLHFDQUFxQyxNQUFNO0FBQzlDLFdBQU8sTUFBTSxNQUFNLFVBQVUsTUFBTSxFQUFFLE1BQU0sTUFBTTtBQUNqRCxXQUFPLE1BQU0sTUFBTSxVQUFVLE1BQU0sRUFBRSxNQUFNLE1BQU07QUFDakQsV0FBTyxNQUFNLE1BQU0sVUFBVSxLQUFLLEVBQUUsTUFBTSxLQUFLO0FBQUEsRUFDakQsQ0FBQztBQUVELE9BQUssK0JBQStCLE1BQU07QUFDeEMsV0FBTyxNQUFNLE1BQU0sVUFBVSxPQUFPLEVBQUUsTUFBTSxNQUFTO0FBQUEsRUFDdkQsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLHlCQUF5QixNQUFNO0FBQ3RDLE9BQUssMkRBQTJELE1BQU07QUFDcEUsVUFBTSxPQUFPLHNCQUFzQixFQUFFLFVBQVUsQ0FBQyxRQUFRLE1BQU0sRUFBRSxDQUFDO0FBQ2pFLFdB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
