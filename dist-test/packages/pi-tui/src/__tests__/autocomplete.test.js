import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CombinedAutocompleteProvider } from "../autocomplete.js";
function makeProvider(commands = [], basePath = "/tmp") {
  return new CombinedAutocompleteProvider(commands, basePath);
}
const sampleCommands = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model" },
  { name: "session", description: "Show session info" },
  { name: "export", description: "Export session" },
  { name: "thinking", description: "Set thinking level" }
];
describe("CombinedAutocompleteProvider \u2014 slash commands", () => {
  it("returns all commands for bare /", () => {
    const provider = makeProvider(sampleCommands);
    const result = provider.getSuggestions(["/"], 0, 1);
    assert.ok(result, "should return suggestions");
    assert.equal(result.items.length, sampleCommands.length);
    assert.equal(result.prefix, "/");
  });
  it("filters commands by typed prefix", () => {
    const provider = makeProvider(sampleCommands);
    const result = provider.getSuggestions(["/se"], 0, 3);
    assert.ok(result);
    assert.ok(result.items.some((i) => i.value === "settings"));
    assert.ok(result.items.some((i) => i.value === "session"));
    assert.equal(result.items.length, 2);
  });
  it("returns null when no commands match", () => {
    const provider = makeProvider(sampleCommands);
    const result = provider.getSuggestions(["/zzz"], 0, 4);
    assert.equal(result, null);
  });
  it("includes description in suggestions", () => {
    const provider = makeProvider(sampleCommands);
    const result = provider.getSuggestions(["/mod"], 0, 4);
    assert.ok(result);
    assert.ok(result.items.some((i) => i.value === "model"));
    assert.ok(
      result.items.every((i) => typeof i.description === "string" && i.description.length > 0),
      "every suggestion must have a non-empty description"
    );
  });
  it("does not offer slash command suggestions mid-line", () => {
    const sentinelCommands = [
      { name: "codexmidlinecommand", description: "Sentinel slash command" }
    ];
    const provider = makeProvider(sentinelCommands);
    const line = "hello /codexmid";
    const result = provider.getSuggestions([line], 0, line.length);
    if (result === null) {
      return;
    }
    assert.ok(
      result.items.every((item) => item.value !== "codexmidlinecommand"),
      "mid-line slash-like text should not return slash command completions"
    );
    assert.ok(
      result.items.every((item) => item.description !== "Sentinel slash command"),
      "mid-line slash-like text should not return slash command metadata"
    );
  });
  it("triggers slash commands after leading whitespace", () => {
    const provider = makeProvider(sampleCommands);
    const result = provider.getSuggestions(["  /se"], 0, 5);
    assert.ok(result);
    assert.equal(result.prefix, "/se");
    assert.ok(result.items.some((item) => item.value === "settings"));
  });
});
describe("CombinedAutocompleteProvider \u2014 argument completions", () => {
  it("returns argument completions for commands that support them", () => {
    const commands = [
      {
        name: "thinking",
        description: "Set thinking level",
        getArgumentCompletions: (prefix) => {
          const levels = ["off", "low", "medium", "high"];
          const filtered = levels.filter((l) => l.startsWith(prefix.trim())).map((l) => ({ value: l, label: l }));
          return filtered.length > 0 ? filtered : null;
        }
      }
    ];
    const provider = makeProvider(commands);
    const result = provider.getSuggestions(["/thinking m"], 0, 11);
    assert.ok(result);
    assert.ok(result.items.some((i) => i.value === "medium"));
    assert.equal(result.items.length, 1);
  });
  it("returns null for commands without argument completions", () => {
    const provider = makeProvider(sampleCommands);
    const result = provider.getSuggestions(["/settings foo"], 0, 13);
    assert.equal(result, null);
  });
  it("returns all arg completions for empty prefix after space", () => {
    const commands = [
      {
        name: "test",
        description: "Test command",
        getArgumentCompletions: (prefix) => {
          const subs = ["start", "stop", "status"];
          const filtered = subs.filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s }));
          return filtered.length > 0 ? filtered : null;
        }
      }
    ];
    const provider = makeProvider(commands);
    const result = provider.getSuggestions(["/test "], 0, 6);
    assert.ok(result);
    assert.ok(result.items.some((i) => i.value === "start"));
    assert.ok(result.items.some((i) => i.value === "stop"));
    assert.ok(result.items.some((i) => i.value === "status"));
    assert.equal(result.items.length, 3);
  });
});
describe("CombinedAutocompleteProvider \u2014 @ file prefix extraction", () => {
  it("detects @ at start of line and returns a valid suggestion shape", () => {
    const provider = makeProvider();
    const result = provider.getSuggestions(["@nonexistent_xyz"], 0, 16);
    if (result !== null) {
      assert.ok(Array.isArray(result.items), "result.items must be an array");
      assert.equal(typeof result.prefix, "string", "prefix must be a string");
      assert.ok(
        !result.prefix.startsWith("@"),
        `prefix must have the @ trigger stripped, got: ${JSON.stringify(result.prefix)}`
      );
    }
  });
  it("detects @ after space and returns a valid suggestion shape", () => {
    const provider = makeProvider();
    const result = provider.getSuggestions(["check @nonexistent_xyz"], 0, 22);
    if (result !== null) {
      assert.ok(Array.isArray(result.items), "result.items must be an array");
      assert.equal(typeof result.prefix, "string", "prefix must be a string");
      assert.ok(
        !result.prefix.includes("check"),
        `prefix must not include text before the @, got: ${JSON.stringify(result.prefix)}`
      );
    }
  });
  it("returns null for bare @ with no query to avoid full tree walk (#1824)", () => {
    const provider = makeProvider([], process.cwd());
    const result = provider.getSuggestions(["@"], 0, 1);
    assert.equal(result, null, "bare @ should not trigger fuzzy file search");
  });
  it("returns null for @ after space with no query (#1824)", () => {
    const provider = makeProvider([], process.cwd());
    const result = provider.getSuggestions(["look at @"], 0, 9);
    assert.equal(result, null, "@ after space with no query should not trigger fuzzy file search");
  });
});
describe("CombinedAutocompleteProvider \u2014 applyCompletion", () => {
  it("applies slash command completion with trailing space", () => {
    const provider = makeProvider(sampleCommands);
    const result = provider.applyCompletion(["/se"], 0, 3, { value: "settings", label: "settings" }, "/se");
    assert.equal(result.lines[0], "/settings ");
    assert.equal(result.cursorCol, 10);
  });
  it("preserves leading whitespace when applying slash command completion", () => {
    const provider = makeProvider(sampleCommands);
    const result = provider.applyCompletion(["  /se"], 0, 5, { value: "settings", label: "settings" }, "/se");
    assert.equal(result.lines[0], "  /settings ");
    assert.equal(result.cursorCol, 12);
  });
  it("applies file path completion for @ prefix", () => {
    const provider = makeProvider();
    const result = provider.applyCompletion(
      ["@src/"],
      0,
      5,
      { value: "@src/index.ts", label: "index.ts" },
      "@src/"
    );
    assert.equal(result.lines[0], "@src/index.ts ");
  });
  it("applies directory completion without trailing space", () => {
    const provider = makeProvider();
    const result = provider.applyCompletion(
      ["@sr"],
      0,
      3,
      { value: "@src/", label: "src/" },
      "@sr"
    );
    assert.ok(!result.lines[0].endsWith(" "));
  });
  it("preserves text after cursor", () => {
    const provider = makeProvider(sampleCommands);
    const result = provider.applyCompletion(
      ["/se and more text"],
      0,
      3,
      { value: "settings", label: "settings" },
      "/se"
    );
    assert.ok(result.lines[0].includes("and more text"));
  });
});
describe("CombinedAutocompleteProvider \u2014 force file suggestions", () => {
  it("does not trigger for slash commands", () => {
    const provider = makeProvider(sampleCommands);
    const result = provider.getForceFileSuggestions(["/set"], 0, 4);
    assert.equal(result, null);
  });
  it("shouldTriggerFileCompletion returns false for slash commands", () => {
    const provider = makeProvider(sampleCommands);
    assert.equal(provider.shouldTriggerFileCompletion(["/set"], 0, 4), false);
  });
  it("shouldTriggerFileCompletion returns true for regular text", () => {
    const provider = makeProvider();
    assert.equal(provider.shouldTriggerFileCompletion(["some text"], 0, 9), true);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktdHVpL3NyYy9fX3Rlc3RzX18vYXV0b2NvbXBsZXRlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgQ29tYmluZWRBdXRvY29tcGxldGVQcm92aWRlciB9IGZyb20gXCIuLi9hdXRvY29tcGxldGUuanNcIjtcbmltcG9ydCB0eXBlIHsgU2xhc2hDb21tYW5kIH0gZnJvbSBcIi4uL2F1dG9jb21wbGV0ZS5qc1wiO1xuXG5mdW5jdGlvbiBtYWtlUHJvdmlkZXIoY29tbWFuZHM6IFNsYXNoQ29tbWFuZFtdID0gW10sIGJhc2VQYXRoOiBzdHJpbmcgPSBcIi90bXBcIikge1xuXHRyZXR1cm4gbmV3IENvbWJpbmVkQXV0b2NvbXBsZXRlUHJvdmlkZXIoY29tbWFuZHMsIGJhc2VQYXRoKTtcbn1cblxuY29uc3Qgc2FtcGxlQ29tbWFuZHM6IFNsYXNoQ29tbWFuZFtdID0gW1xuXHR7IG5hbWU6IFwic2V0dGluZ3NcIiwgZGVzY3JpcHRpb246IFwiT3BlbiBzZXR0aW5ncyBtZW51XCIgfSxcblx0eyBuYW1lOiBcIm1vZGVsXCIsIGRlc2NyaXB0aW9uOiBcIlNlbGVjdCBtb2RlbFwiIH0sXG5cdHsgbmFtZTogXCJzZXNzaW9uXCIsIGRlc2NyaXB0aW9uOiBcIlNob3cgc2Vzc2lvbiBpbmZvXCIgfSxcblx0eyBuYW1lOiBcImV4cG9ydFwiLCBkZXNjcmlwdGlvbjogXCJFeHBvcnQgc2Vzc2lvblwiIH0sXG5cdHsgbmFtZTogXCJ0aGlua2luZ1wiLCBkZXNjcmlwdGlvbjogXCJTZXQgdGhpbmtpbmcgbGV2ZWxcIiB9LFxuXTtcblxuZGVzY3JpYmUoXCJDb21iaW5lZEF1dG9jb21wbGV0ZVByb3ZpZGVyIFx1MjAxNCBzbGFzaCBjb21tYW5kc1wiLCAoKSA9PiB7XG5cdGl0KFwicmV0dXJucyBhbGwgY29tbWFuZHMgZm9yIGJhcmUgL1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcHJvdmlkZXIgPSBtYWtlUHJvdmlkZXIoc2FtcGxlQ29tbWFuZHMpO1xuXHRcdGNvbnN0IHJlc3VsdCA9IHByb3ZpZGVyLmdldFN1Z2dlc3Rpb25zKFtcIi9cIl0sIDAsIDEpO1xuXHRcdGFzc2VydC5vayhyZXN1bHQsIFwic2hvdWxkIHJldHVybiBzdWdnZXN0aW9uc1wiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0IS5pdGVtcy5sZW5ndGgsIHNhbXBsZUNvbW1hbmRzLmxlbmd0aCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCEucHJlZml4LCBcIi9cIik7XG5cdH0pO1xuXG5cdGl0KFwiZmlsdGVycyBjb21tYW5kcyBieSB0eXBlZCBwcmVmaXhcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHByb3ZpZGVyID0gbWFrZVByb3ZpZGVyKHNhbXBsZUNvbW1hbmRzKTtcblx0XHRjb25zdCByZXN1bHQgPSBwcm92aWRlci5nZXRTdWdnZXN0aW9ucyhbXCIvc2VcIl0sIDAsIDMpO1xuXHRcdGFzc2VydC5vayhyZXN1bHQpO1xuXHRcdC8vIC9zZSBtYXRjaGVzIHNldHRpbmdzIGFuZCBzZXNzaW9uIFx1MjAxNCBuYW1lIHRoZSB2YWx1ZXMsIHRoZW4gYXNzZXJ0IGV4YWN0XG5cdFx0Ly8gY291bnQgYXMgdGhlIGNvbnRyYWN0IGZvciB0aGlzIHByZWZpeC4gQXNzZXJ0aW5nIGNvdW50IGFsb25lIHdvdWxkXG5cdFx0Ly8gcGFzcyBldmVuIGlmIHRoZSBtYXRjaGVzIHdlcmUgdGhlIHdyb25nIGNvbW1hbmRzLlxuXHRcdGFzc2VydC5vayhyZXN1bHQhLml0ZW1zLnNvbWUoKGkpID0+IGkudmFsdWUgPT09IFwic2V0dGluZ3NcIikpO1xuXHRcdGFzc2VydC5vayhyZXN1bHQhLml0ZW1zLnNvbWUoKGkpID0+IGkudmFsdWUgPT09IFwic2Vzc2lvblwiKSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCEuaXRlbXMubGVuZ3RoLCAyKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIG51bGwgd2hlbiBubyBjb21tYW5kcyBtYXRjaFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcHJvdmlkZXIgPSBtYWtlUHJvdmlkZXIoc2FtcGxlQ29tbWFuZHMpO1xuXHRcdGNvbnN0IHJlc3VsdCA9IHByb3ZpZGVyLmdldFN1Z2dlc3Rpb25zKFtcIi96enpcIl0sIDAsIDQpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuXHR9KTtcblxuXHRpdChcImluY2x1ZGVzIGRlc2NyaXB0aW9uIGluIHN1Z2dlc3Rpb25zXCIsICgpID0+IHtcblx0XHRjb25zdCBwcm92aWRlciA9IG1ha2VQcm92aWRlcihzYW1wbGVDb21tYW5kcyk7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcHJvdmlkZXIuZ2V0U3VnZ2VzdGlvbnMoW1wiL21vZFwiXSwgMCwgNCk7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdCk7XG5cdFx0Ly8gVmVyaWZ5IHRoZSBtYXRjaGVkIGNvbW1hbmQgaXMgcHJlc2VudCBhbmQgZXZlcnkgaXRlbSBjYXJyaWVzIGFcblx0XHQvLyBkZXNjcmlwdGlvbiBcdTIwMTQgYXZvaWRzIGBbMF1gIHBvc2l0aW9uYWwgY291cGxpbmcgdGhhdCB3b3VsZCBzaWxlbnRseVxuXHRcdC8vIHBhc3MgaWYgbGlzdCBvcmRlcmluZyBjaGFuZ2VkLlxuXHRcdGFzc2VydC5vayhyZXN1bHQhLml0ZW1zLnNvbWUoKGkpID0+IGkudmFsdWUgPT09IFwibW9kZWxcIikpO1xuXHRcdGFzc2VydC5vayhcblx0XHRcdHJlc3VsdCEuaXRlbXMuZXZlcnkoKGkpID0+IHR5cGVvZiBpLmRlc2NyaXB0aW9uID09PSBcInN0cmluZ1wiICYmIGkuZGVzY3JpcHRpb24ubGVuZ3RoID4gMCksXG5cdFx0XHRcImV2ZXJ5IHN1Z2dlc3Rpb24gbXVzdCBoYXZlIGEgbm9uLWVtcHR5IGRlc2NyaXB0aW9uXCIsXG5cdFx0KTtcblx0fSk7XG5cblx0aXQoXCJkb2VzIG5vdCBvZmZlciBzbGFzaCBjb21tYW5kIHN1Z2dlc3Rpb25zIG1pZC1saW5lXCIsICgpID0+IHtcblx0XHRjb25zdCBzZW50aW5lbENvbW1hbmRzOiBTbGFzaENvbW1hbmRbXSA9IFtcblx0XHRcdHsgbmFtZTogXCJjb2RleG1pZGxpbmVjb21tYW5kXCIsIGRlc2NyaXB0aW9uOiBcIlNlbnRpbmVsIHNsYXNoIGNvbW1hbmRcIiB9LFxuXHRcdF07XG5cdFx0Y29uc3QgcHJvdmlkZXIgPSBtYWtlUHJvdmlkZXIoc2VudGluZWxDb21tYW5kcyk7XG5cdFx0Y29uc3QgbGluZSA9IFwiaGVsbG8gL2NvZGV4bWlkXCI7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcHJvdmlkZXIuZ2V0U3VnZ2VzdGlvbnMoW2xpbmVdLCAwLCBsaW5lLmxlbmd0aCk7XG5cblx0XHRpZiAocmVzdWx0ID09PSBudWxsKSB7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0cmVzdWx0Lml0ZW1zLmV2ZXJ5KChpdGVtKSA9PiBpdGVtLnZhbHVlICE9PSBcImNvZGV4bWlkbGluZWNvbW1hbmRcIiksXG5cdFx0XHRcIm1pZC1saW5lIHNsYXNoLWxpa2UgdGV4dCBzaG91bGQgbm90IHJldHVybiBzbGFzaCBjb21tYW5kIGNvbXBsZXRpb25zXCIsXG5cdFx0KTtcblx0XHRhc3NlcnQub2soXG5cdFx0XHRyZXN1bHQuaXRlbXMuZXZlcnkoKGl0ZW0pID0+IGl0ZW0uZGVzY3JpcHRpb24gIT09IFwiU2VudGluZWwgc2xhc2ggY29tbWFuZFwiKSxcblx0XHRcdFwibWlkLWxpbmUgc2xhc2gtbGlrZSB0ZXh0IHNob3VsZCBub3QgcmV0dXJuIHNsYXNoIGNvbW1hbmQgbWV0YWRhdGFcIixcblx0XHQpO1xuXHR9KTtcblxuXHRpdChcInRyaWdnZXJzIHNsYXNoIGNvbW1hbmRzIGFmdGVyIGxlYWRpbmcgd2hpdGVzcGFjZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcHJvdmlkZXIgPSBtYWtlUHJvdmlkZXIoc2FtcGxlQ29tbWFuZHMpO1xuXHRcdGNvbnN0IHJlc3VsdCA9IHByb3ZpZGVyLmdldFN1Z2dlc3Rpb25zKFtcIiAgL3NlXCJdLCAwLCA1KTtcblx0XHRhc3NlcnQub2socmVzdWx0KTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0IS5wcmVmaXgsIFwiL3NlXCIpO1xuXHRcdGFzc2VydC5vayhyZXN1bHQhLml0ZW1zLnNvbWUoKGl0ZW0pID0+IGl0ZW0udmFsdWUgPT09IFwic2V0dGluZ3NcIikpO1xuXHR9KTtcbn0pO1xuXG5kZXNjcmliZShcIkNvbWJpbmVkQXV0b2NvbXBsZXRlUHJvdmlkZXIgXHUyMDE0IGFyZ3VtZW50IGNvbXBsZXRpb25zXCIsICgpID0+IHtcblx0aXQoXCJyZXR1cm5zIGFyZ3VtZW50IGNvbXBsZXRpb25zIGZvciBjb21tYW5kcyB0aGF0IHN1cHBvcnQgdGhlbVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29tbWFuZHM6IFNsYXNoQ29tbWFuZFtdID0gW1xuXHRcdFx0e1xuXHRcdFx0XHRuYW1lOiBcInRoaW5raW5nXCIsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBcIlNldCB0aGlua2luZyBsZXZlbFwiLFxuXHRcdFx0XHRnZXRBcmd1bWVudENvbXBsZXRpb25zOiAocHJlZml4KSA9PiB7XG5cdFx0XHRcdFx0Y29uc3QgbGV2ZWxzID0gW1wib2ZmXCIsIFwibG93XCIsIFwibWVkaXVtXCIsIFwiaGlnaFwiXTtcblx0XHRcdFx0XHRjb25zdCBmaWx0ZXJlZCA9IGxldmVsc1xuXHRcdFx0XHRcdFx0LmZpbHRlcigobCkgPT4gbC5zdGFydHNXaXRoKHByZWZpeC50cmltKCkpKVxuXHRcdFx0XHRcdFx0Lm1hcCgobCkgPT4gKHsgdmFsdWU6IGwsIGxhYmVsOiBsIH0pKTtcblx0XHRcdFx0XHRyZXR1cm4gZmlsdGVyZWQubGVuZ3RoID4gMCA/IGZpbHRlcmVkIDogbnVsbDtcblx0XHRcdFx0fSxcblx0XHRcdH0sXG5cdFx0XTtcblx0XHRjb25zdCBwcm92aWRlciA9IG1ha2VQcm92aWRlcihjb21tYW5kcyk7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcHJvdmlkZXIuZ2V0U3VnZ2VzdGlvbnMoW1wiL3RoaW5raW5nIG1cIl0sIDAsIDExKTtcblx0XHRhc3NlcnQub2socmVzdWx0KTtcblx0XHQvLyAvdGhpbmtpbmcgbSBtYXRjaGVzIG9ubHkgXCJtZWRpdW1cIiBcdTIwMTQgdmVyaWZ5IHRoZSBleHBlY3RlZCB2YWx1ZSBpc1xuXHRcdC8vIHByZXNlbnQgKGJ5IG5hbWUsIG5vdCBpbmRleCkgYW5kIHRoZW4gYXNzZXJ0IGV4YWN0IGNvdW50LlxuXHRcdGFzc2VydC5vayhyZXN1bHQhLml0ZW1zLnNvbWUoKGkpID0+IGkudmFsdWUgPT09IFwibWVkaXVtXCIpKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0IS5pdGVtcy5sZW5ndGgsIDEpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgbnVsbCBmb3IgY29tbWFuZHMgd2l0aG91dCBhcmd1bWVudCBjb21wbGV0aW9uc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcHJvdmlkZXIgPSBtYWtlUHJvdmlkZXIoc2FtcGxlQ29tbWFuZHMpO1xuXHRcdGNvbnN0IHJlc3VsdCA9IHByb3ZpZGVyLmdldFN1Z2dlc3Rpb25zKFtcIi9zZXR0aW5ncyBmb29cIl0sIDAsIDEzKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LCBudWxsKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIGFsbCBhcmcgY29tcGxldGlvbnMgZm9yIGVtcHR5IHByZWZpeCBhZnRlciBzcGFjZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgY29tbWFuZHM6IFNsYXNoQ29tbWFuZFtdID0gW1xuXHRcdFx0e1xuXHRcdFx0XHRuYW1lOiBcInRlc3RcIixcblx0XHRcdFx0ZGVzY3JpcHRpb246IFwiVGVzdCBjb21tYW5kXCIsXG5cdFx0XHRcdGdldEFyZ3VtZW50Q29tcGxldGlvbnM6IChwcmVmaXgpID0+IHtcblx0XHRcdFx0XHRjb25zdCBzdWJzID0gW1wic3RhcnRcIiwgXCJzdG9wXCIsIFwic3RhdHVzXCJdO1xuXHRcdFx0XHRcdGNvbnN0IGZpbHRlcmVkID0gc3Vic1xuXHRcdFx0XHRcdFx0LmZpbHRlcigocykgPT4gcy5zdGFydHNXaXRoKHByZWZpeC50cmltKCkpKVxuXHRcdFx0XHRcdFx0Lm1hcCgocykgPT4gKHsgdmFsdWU6IHMsIGxhYmVsOiBzIH0pKTtcblx0XHRcdFx0XHRyZXR1cm4gZmlsdGVyZWQubGVuZ3RoID4gMCA/IGZpbHRlcmVkIDogbnVsbDtcblx0XHRcdFx0fSxcblx0XHRcdH0sXG5cdFx0XTtcblx0XHRjb25zdCBwcm92aWRlciA9IG1ha2VQcm92aWRlcihjb21tYW5kcyk7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcHJvdmlkZXIuZ2V0U3VnZ2VzdGlvbnMoW1wiL3Rlc3QgXCJdLCAwLCA2KTtcblx0XHRhc3NlcnQub2socmVzdWx0KTtcblx0XHQvLyBFbXB0eSBwcmVmaXggcmV0dXJucyBhbGwgMyBzdWJjb21tYW5kcyBcdTIwMTQgdmVyaWZ5IGVhY2ggaXMgcHJlc2VudFxuXHRcdC8vIGJ5IG5hbWUuIEJhcmUgY291bnQgd291bGQgcGFzcyBmb3IgYW55IDMtZWxlbWVudCBsaXN0LlxuXHRcdGFzc2VydC5vayhyZXN1bHQhLml0ZW1zLnNvbWUoKGkpID0+IGkudmFsdWUgPT09IFwic3RhcnRcIikpO1xuXHRcdGFzc2VydC5vayhyZXN1bHQhLml0ZW1zLnNvbWUoKGkpID0+IGkudmFsdWUgPT09IFwic3RvcFwiKSk7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdCEuaXRlbXMuc29tZSgoaSkgPT4gaS52YWx1ZSA9PT0gXCJzdGF0dXNcIikpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQhLml0ZW1zLmxlbmd0aCwgMyk7XG5cdH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiQ29tYmluZWRBdXRvY29tcGxldGVQcm92aWRlciBcdTIwMTQgQCBmaWxlIHByZWZpeCBleHRyYWN0aW9uXCIsICgpID0+IHtcblx0aXQoXCJkZXRlY3RzIEAgYXQgc3RhcnQgb2YgbGluZSBhbmQgcmV0dXJucyBhIHZhbGlkIHN1Z2dlc3Rpb24gc2hhcGVcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHByb3ZpZGVyID0gbWFrZVByb3ZpZGVyKCk7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcHJvdmlkZXIuZ2V0U3VnZ2VzdGlvbnMoW1wiQG5vbmV4aXN0ZW50X3h5elwiXSwgMCwgMTYpO1xuXHRcdC8vIEVpdGhlciBudWxsIChub3RoaW5nIG1hdGNoZWQpIG9yIGEgd2VsbC1mb3JtZWQge2l0ZW1zOiBBcnJheSwgcHJlZml4OiBzdHJpbmd9XG5cdFx0Ly8gc2hhcGUuIFByZXZpb3VzIHZlcnNpb24ncyBgcmVzdWx0Lml0ZW1zLmxlbmd0aCA+PSAwYCB3YXMgYSB0YXV0b2xvZ3kgXHUyMDE0XG5cdFx0Ly8gYXJyYXkgbGVuZ3RoIGlzIGFsd2F5cyBcdTIyNjUgMDsgdGhlIHdob2xlIGV4cHJlc3Npb24gY291bGQgbmV2ZXIgZmFpbC5cblx0XHRpZiAocmVzdWx0ICE9PSBudWxsKSB7XG5cdFx0XHRhc3NlcnQub2soQXJyYXkuaXNBcnJheShyZXN1bHQuaXRlbXMpLCBcInJlc3VsdC5pdGVtcyBtdXN0IGJlIGFuIGFycmF5XCIpO1xuXHRcdFx0Ly8gVGhlIEAtcHJlZml4IGV4dHJhY3Rpb24gc3RyaXBzIHRoZSBsZWFkaW5nIEAgXHUyMDE0IHByZWZpeCBzaG91bGQgYmVcblx0XHRcdC8vIHRoZSByYXcgdGV4dCB3aXRob3V0IHRoZSB0cmlnZ2VyIGNoYXJhY3Rlci5cblx0XHRcdGFzc2VydC5lcXVhbCh0eXBlb2YgcmVzdWx0LnByZWZpeCwgXCJzdHJpbmdcIiwgXCJwcmVmaXggbXVzdCBiZSBhIHN0cmluZ1wiKTtcblx0XHRcdGFzc2VydC5vayhcblx0XHRcdFx0IXJlc3VsdC5wcmVmaXguc3RhcnRzV2l0aChcIkBcIiksXG5cdFx0XHRcdGBwcmVmaXggbXVzdCBoYXZlIHRoZSBAIHRyaWdnZXIgc3RyaXBwZWQsIGdvdDogJHtKU09OLnN0cmluZ2lmeShyZXN1bHQucHJlZml4KX1gLFxuXHRcdFx0KTtcblx0XHR9XG5cdH0pO1xuXG5cdGl0KFwiZGV0ZWN0cyBAIGFmdGVyIHNwYWNlIGFuZCByZXR1cm5zIGEgdmFsaWQgc3VnZ2VzdGlvbiBzaGFwZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcHJvdmlkZXIgPSBtYWtlUHJvdmlkZXIoKTtcblx0XHRjb25zdCByZXN1bHQgPSBwcm92aWRlci5nZXRTdWdnZXN0aW9ucyhbXCJjaGVjayBAbm9uZXhpc3RlbnRfeHl6XCJdLCAwLCAyMik7XG5cdFx0aWYgKHJlc3VsdCAhPT0gbnVsbCkge1xuXHRcdFx0YXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkocmVzdWx0Lml0ZW1zKSwgXCJyZXN1bHQuaXRlbXMgbXVzdCBiZSBhbiBhcnJheVwiKTtcblx0XHRcdGFzc2VydC5lcXVhbCh0eXBlb2YgcmVzdWx0LnByZWZpeCwgXCJzdHJpbmdcIiwgXCJwcmVmaXggbXVzdCBiZSBhIHN0cmluZ1wiKTtcblx0XHRcdC8vIFRoZSBwcmVmaXggbXVzdCBOT1QgaW5jbHVkZSB0aGUgd29yZCBcImNoZWNrXCIgdGhhdCBjYW1lIGJlZm9yZSB0aGUgQC5cblx0XHRcdGFzc2VydC5vayhcblx0XHRcdFx0IXJlc3VsdC5wcmVmaXguaW5jbHVkZXMoXCJjaGVja1wiKSxcblx0XHRcdFx0YHByZWZpeCBtdXN0IG5vdCBpbmNsdWRlIHRleHQgYmVmb3JlIHRoZSBALCBnb3Q6ICR7SlNPTi5zdHJpbmdpZnkocmVzdWx0LnByZWZpeCl9YCxcblx0XHRcdCk7XG5cdFx0fVxuXHR9KTtcblxuXHRpdChcInJldHVybnMgbnVsbCBmb3IgYmFyZSBAIHdpdGggbm8gcXVlcnkgdG8gYXZvaWQgZnVsbCB0cmVlIHdhbGsgKCMxODI0KVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcHJvdmlkZXIgPSBtYWtlUHJvdmlkZXIoW10sIHByb2Nlc3MuY3dkKCkpO1xuXHRcdC8vIEEgYmFyZSBcIkBcIiBwcm9kdWNlcyBhbiBlbXB0eSByYXdQcmVmaXggYWZ0ZXIgc3RyaXBwaW5nIHRoZSBcIkBcIi5cblx0XHQvLyBUaGlzIG11c3QgcmV0dXJuIG51bGwgdG8gYXZvaWQgYSBzeW5jaHJvbm91cyBmdWxsIGZpbGVzeXN0ZW0gd2Fsa1xuXHRcdC8vIHZpYSB0aGUgbmF0aXZlIGZ1enp5RmluZCBhZGRvbiwgd2hpY2ggZnJlZXplcyB0aGUgVFVJIG9uIGxhcmdlIHJlcG9zLlxuXHRcdGNvbnN0IHJlc3VsdCA9IHByb3ZpZGVyLmdldFN1Z2dlc3Rpb25zKFtcIkBcIl0sIDAsIDEpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwsIFwiYmFyZSBAIHNob3VsZCBub3QgdHJpZ2dlciBmdXp6eSBmaWxlIHNlYXJjaFwiKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIG51bGwgZm9yIEAgYWZ0ZXIgc3BhY2Ugd2l0aCBubyBxdWVyeSAoIzE4MjQpXCIsICgpID0+IHtcblx0XHRjb25zdCBwcm92aWRlciA9IG1ha2VQcm92aWRlcihbXSwgcHJvY2Vzcy5jd2QoKSk7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcHJvdmlkZXIuZ2V0U3VnZ2VzdGlvbnMoW1wibG9vayBhdCBAXCJdLCAwLCA5KTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LCBudWxsLCBcIkAgYWZ0ZXIgc3BhY2Ugd2l0aCBubyBxdWVyeSBzaG91bGQgbm90IHRyaWdnZXIgZnV6enkgZmlsZSBzZWFyY2hcIik7XG5cdH0pO1xufSk7XG5cbmRlc2NyaWJlKFwiQ29tYmluZWRBdXRvY29tcGxldGVQcm92aWRlciBcdTIwMTQgYXBwbHlDb21wbGV0aW9uXCIsICgpID0+IHtcblx0aXQoXCJhcHBsaWVzIHNsYXNoIGNvbW1hbmQgY29tcGxldGlvbiB3aXRoIHRyYWlsaW5nIHNwYWNlXCIsICgpID0+IHtcblx0XHRjb25zdCBwcm92aWRlciA9IG1ha2VQcm92aWRlcihzYW1wbGVDb21tYW5kcyk7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcHJvdmlkZXIuYXBwbHlDb21wbGV0aW9uKFtcIi9zZVwiXSwgMCwgMywgeyB2YWx1ZTogXCJzZXR0aW5nc1wiLCBsYWJlbDogXCJzZXR0aW5nc1wiIH0sIFwiL3NlXCIpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQubGluZXNbMF0sIFwiL3NldHRpbmdzIFwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmN1cnNvckNvbCwgMTApOyAvLyBhZnRlciBcIi9zZXR0aW5ncyBcIlxuXHR9KTtcblxuXHRpdChcInByZXNlcnZlcyBsZWFkaW5nIHdoaXRlc3BhY2Ugd2hlbiBhcHBseWluZyBzbGFzaCBjb21tYW5kIGNvbXBsZXRpb25cIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHByb3ZpZGVyID0gbWFrZVByb3ZpZGVyKHNhbXBsZUNvbW1hbmRzKTtcblx0XHRjb25zdCByZXN1bHQgPSBwcm92aWRlci5hcHBseUNvbXBsZXRpb24oW1wiICAvc2VcIl0sIDAsIDUsIHsgdmFsdWU6IFwic2V0dGluZ3NcIiwgbGFiZWw6IFwic2V0dGluZ3NcIiB9LCBcIi9zZVwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmxpbmVzWzBdLCBcIiAgL3NldHRpbmdzIFwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmN1cnNvckNvbCwgMTIpO1xuXHR9KTtcblxuXHRpdChcImFwcGxpZXMgZmlsZSBwYXRoIGNvbXBsZXRpb24gZm9yIEAgcHJlZml4XCIsICgpID0+IHtcblx0XHRjb25zdCBwcm92aWRlciA9IG1ha2VQcm92aWRlcigpO1xuXHRcdGNvbnN0IHJlc3VsdCA9IHByb3ZpZGVyLmFwcGx5Q29tcGxldGlvbihcblx0XHRcdFtcIkBzcmMvXCJdLFxuXHRcdFx0MCxcblx0XHRcdDUsXG5cdFx0XHR7IHZhbHVlOiBcIkBzcmMvaW5kZXgudHNcIiwgbGFiZWw6IFwiaW5kZXgudHNcIiB9LFxuXHRcdFx0XCJAc3JjL1wiLFxuXHRcdCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5saW5lc1swXSwgXCJAc3JjL2luZGV4LnRzIFwiKTtcblx0fSk7XG5cblx0aXQoXCJhcHBsaWVzIGRpcmVjdG9yeSBjb21wbGV0aW9uIHdpdGhvdXQgdHJhaWxpbmcgc3BhY2VcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHByb3ZpZGVyID0gbWFrZVByb3ZpZGVyKCk7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcHJvdmlkZXIuYXBwbHlDb21wbGV0aW9uKFxuXHRcdFx0W1wiQHNyXCJdLFxuXHRcdFx0MCxcblx0XHRcdDMsXG5cdFx0XHR7IHZhbHVlOiBcIkBzcmMvXCIsIGxhYmVsOiBcInNyYy9cIiB9LFxuXHRcdFx0XCJAc3JcIixcblx0XHQpO1xuXHRcdC8vIERpcmVjdG9yaWVzIHNob3VsZCBub3QgZ2V0IHRyYWlsaW5nIHNwYWNlIHNvIHVzZXIgY2FuIGNvbnRpbnVlIHR5cGluZ1xuXHRcdGFzc2VydC5vayghcmVzdWx0LmxpbmVzWzBdIS5lbmRzV2l0aChcIiBcIikpO1xuXHR9KTtcblxuXHRpdChcInByZXNlcnZlcyB0ZXh0IGFmdGVyIGN1cnNvclwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcHJvdmlkZXIgPSBtYWtlUHJvdmlkZXIoc2FtcGxlQ29tbWFuZHMpO1xuXHRcdGNvbnN0IHJlc3VsdCA9IHByb3ZpZGVyLmFwcGx5Q29tcGxldGlvbihcblx0XHRcdFtcIi9zZSBhbmQgbW9yZSB0ZXh0XCJdLFxuXHRcdFx0MCxcblx0XHRcdDMsXG5cdFx0XHR7IHZhbHVlOiBcInNldHRpbmdzXCIsIGxhYmVsOiBcInNldHRpbmdzXCIgfSxcblx0XHRcdFwiL3NlXCIsXG5cdFx0KTtcblx0XHRhc3NlcnQub2socmVzdWx0LmxpbmVzWzBdIS5pbmNsdWRlcyhcImFuZCBtb3JlIHRleHRcIikpO1xuXHR9KTtcbn0pO1xuXG5kZXNjcmliZShcIkNvbWJpbmVkQXV0b2NvbXBsZXRlUHJvdmlkZXIgXHUyMDE0IGZvcmNlIGZpbGUgc3VnZ2VzdGlvbnNcIiwgKCkgPT4ge1xuXHRpdChcImRvZXMgbm90IHRyaWdnZXIgZm9yIHNsYXNoIGNvbW1hbmRzXCIsICgpID0+IHtcblx0XHRjb25zdCBwcm92aWRlciA9IG1ha2VQcm92aWRlcihzYW1wbGVDb21tYW5kcyk7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcHJvdmlkZXIuZ2V0Rm9yY2VGaWxlU3VnZ2VzdGlvbnMoW1wiL3NldFwiXSwgMCwgNCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbCk7XG5cdH0pO1xuXG5cdGl0KFwic2hvdWxkVHJpZ2dlckZpbGVDb21wbGV0aW9uIHJldHVybnMgZmFsc2UgZm9yIHNsYXNoIGNvbW1hbmRzXCIsICgpID0+IHtcblx0XHRjb25zdCBwcm92aWRlciA9IG1ha2VQcm92aWRlcihzYW1wbGVDb21tYW5kcyk7XG5cdFx0YXNzZXJ0LmVxdWFsKHByb3ZpZGVyLnNob3VsZFRyaWdnZXJGaWxlQ29tcGxldGlvbihbXCIvc2V0XCJdLCAwLCA0KSwgZmFsc2UpO1xuXHR9KTtcblxuXHRpdChcInNob3VsZFRyaWdnZXJGaWxlQ29tcGxldGlvbiByZXR1cm5zIHRydWUgZm9yIHJlZ3VsYXIgdGV4dFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcHJvdmlkZXIgPSBtYWtlUHJvdmlkZXIoKTtcblx0XHRhc3NlcnQuZXF1YWwocHJvdmlkZXIuc2hvdWxkVHJpZ2dlckZpbGVDb21wbGV0aW9uKFtcInNvbWUgdGV4dFwiXSwgMCwgOSksIHRydWUpO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLFVBQVU7QUFDN0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsb0NBQW9DO0FBRzdDLFNBQVMsYUFBYSxXQUEyQixDQUFDLEdBQUcsV0FBbUIsUUFBUTtBQUMvRSxTQUFPLElBQUksNkJBQTZCLFVBQVUsUUFBUTtBQUMzRDtBQUVBLE1BQU0saUJBQWlDO0FBQUEsRUFDdEMsRUFBRSxNQUFNLFlBQVksYUFBYSxxQkFBcUI7QUFBQSxFQUN0RCxFQUFFLE1BQU0sU0FBUyxhQUFhLGVBQWU7QUFBQSxFQUM3QyxFQUFFLE1BQU0sV0FBVyxhQUFhLG9CQUFvQjtBQUFBLEVBQ3BELEVBQUUsTUFBTSxVQUFVLGFBQWEsaUJBQWlCO0FBQUEsRUFDaEQsRUFBRSxNQUFNLFlBQVksYUFBYSxxQkFB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
