import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fuzzyMatch, fuzzyFilter } from "../fuzzy.js";
describe("fuzzyMatch", () => {
  it("matches exact string", () => {
    const result = fuzzyMatch("hello", "hello");
    assert.equal(result.matches, true);
  });
  it("matches substring characters in order", () => {
    const result = fuzzyMatch("hlo", "hello");
    assert.equal(result.matches, true);
  });
  it("does not match when characters are out of order", () => {
    const result = fuzzyMatch("olh", "hello");
    assert.equal(result.matches, false);
  });
  it("empty query matches everything", () => {
    const result = fuzzyMatch("", "anything");
    assert.equal(result.matches, true);
    assert.equal(result.score, 0);
  });
  it("does not match when query is longer than text", () => {
    const result = fuzzyMatch("toolong", "short");
    assert.equal(result.matches, false);
  });
  it("is case insensitive", () => {
    const result = fuzzyMatch("ABC", "abcdef");
    assert.equal(result.matches, true);
  });
  it("rewards consecutive matches with lower score", () => {
    const consecutive = fuzzyMatch("hel", "hello");
    const gapped = fuzzyMatch("hlo", "hello");
    assert.ok(consecutive.score < gapped.score, "consecutive matches should score lower (better)");
  });
  it("rewards word boundary matches", () => {
    const boundary = fuzzyMatch("sc", "slash-command");
    const nonBoundary = fuzzyMatch("sc", "describe");
    assert.ok(boundary.score < nonBoundary.score, "word boundary matches should score lower (better)");
  });
  it("handles alphanumeric swap (e.g., opus3 matches opus-3)", () => {
    const result = fuzzyMatch("opus3", "opus-3");
    assert.equal(result.matches, true);
  });
  it("handles numeric-alpha swap", () => {
    const result = fuzzyMatch("3opus", "opus-3");
    assert.equal(result.matches, true);
  });
  it("does not match completely unrelated strings", () => {
    const result = fuzzyMatch("xyz", "hello");
    assert.equal(result.matches, false);
  });
});
describe("fuzzyFilter", () => {
  const items = ["settings", "session", "share", "model", "compact", "export"];
  it("returns all items for empty query", () => {
    const result = fuzzyFilter(items, "", (x) => x);
    assert.equal(result.length, items.length);
  });
  it("filters to matching items only", () => {
    const result = fuzzyFilter(items, "se", (x) => x);
    assert.ok(result.includes("settings"));
    assert.ok(result.includes("session"));
    assert.ok(!result.includes("model"));
  });
  it("sorts by match quality (best first)", () => {
    const result = fuzzyFilter(items, "ex", (x) => x);
    assert.equal(result[0], "export");
  });
  it("supports space-separated tokens (all must match)", () => {
    const data = ["anthropic/opus", "anthropic/sonnet", "openai/gpt4"];
    const result = fuzzyFilter(data, "ant opus", (x) => x);
    assert.equal(result.length, 1);
    assert.equal(result[0], "anthropic/opus");
  });
  it("returns empty array when no items match", () => {
    const result = fuzzyFilter(items, "zzz", (x) => x);
    assert.equal(result.length, 0);
  });
  it("works with custom getText function", () => {
    const objects = [
      { name: "alpha", id: 1 },
      { name: "beta", id: 2 },
      { name: "gamma", id: 3 }
    ];
    const result = fuzzyFilter(objects, "bet", (o) => o.name);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.name, "beta");
  });
  it("handles whitespace-only query as empty", () => {
    const result = fuzzyFilter(items, "   ", (x) => x);
    assert.equal(result.length, items.length);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktdHVpL3NyYy9fX3Rlc3RzX18vZnV6enkudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBmdXp6eU1hdGNoLCBmdXp6eUZpbHRlciB9IGZyb20gXCIuLi9mdXp6eS5qc1wiO1xuXG5kZXNjcmliZShcImZ1enp5TWF0Y2hcIiwgKCkgPT4ge1xuXHRpdChcIm1hdGNoZXMgZXhhY3Qgc3RyaW5nXCIsICgpID0+IHtcblx0XHRjb25zdCByZXN1bHQgPSBmdXp6eU1hdGNoKFwiaGVsbG9cIiwgXCJoZWxsb1wiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0Lm1hdGNoZXMsIHRydWUpO1xuXHR9KTtcblxuXHRpdChcIm1hdGNoZXMgc3Vic3RyaW5nIGNoYXJhY3RlcnMgaW4gb3JkZXJcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IGZ1enp5TWF0Y2goXCJobG9cIiwgXCJoZWxsb1wiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0Lm1hdGNoZXMsIHRydWUpO1xuXHR9KTtcblxuXHRpdChcImRvZXMgbm90IG1hdGNoIHdoZW4gY2hhcmFjdGVycyBhcmUgb3V0IG9mIG9yZGVyXCIsICgpID0+IHtcblx0XHRjb25zdCByZXN1bHQgPSBmdXp6eU1hdGNoKFwib2xoXCIsIFwiaGVsbG9cIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5tYXRjaGVzLCBmYWxzZSk7XG5cdH0pO1xuXG5cdGl0KFwiZW1wdHkgcXVlcnkgbWF0Y2hlcyBldmVyeXRoaW5nXCIsICgpID0+IHtcblx0XHRjb25zdCByZXN1bHQgPSBmdXp6eU1hdGNoKFwiXCIsIFwiYW55dGhpbmdcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5tYXRjaGVzLCB0cnVlKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LnNjb3JlLCAwKTtcblx0fSk7XG5cblx0aXQoXCJkb2VzIG5vdCBtYXRjaCB3aGVuIHF1ZXJ5IGlzIGxvbmdlciB0aGFuIHRleHRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IGZ1enp5TWF0Y2goXCJ0b29sb25nXCIsIFwic2hvcnRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5tYXRjaGVzLCBmYWxzZSk7XG5cdH0pO1xuXG5cdGl0KFwiaXMgY2FzZSBpbnNlbnNpdGl2ZVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gZnV6enlNYXRjaChcIkFCQ1wiLCBcImFiY2RlZlwiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0Lm1hdGNoZXMsIHRydWUpO1xuXHR9KTtcblxuXHRpdChcInJld2FyZHMgY29uc2VjdXRpdmUgbWF0Y2hlcyB3aXRoIGxvd2VyIHNjb3JlXCIsICgpID0+IHtcblx0XHRjb25zdCBjb25zZWN1dGl2ZSA9IGZ1enp5TWF0Y2goXCJoZWxcIiwgXCJoZWxsb1wiKTtcblx0XHRjb25zdCBnYXBwZWQgPSBmdXp6eU1hdGNoKFwiaGxvXCIsIFwiaGVsbG9cIik7XG5cdFx0YXNzZXJ0Lm9rKGNvbnNlY3V0aXZlLnNjb3JlIDwgZ2FwcGVkLnNjb3JlLCBcImNvbnNlY3V0aXZlIG1hdGNoZXMgc2hvdWxkIHNjb3JlIGxvd2VyIChiZXR0ZXIpXCIpO1xuXHR9KTtcblxuXHRpdChcInJld2FyZHMgd29yZCBib3VuZGFyeSBtYXRjaGVzXCIsICgpID0+IHtcblx0XHRjb25zdCBib3VuZGFyeSA9IGZ1enp5TWF0Y2goXCJzY1wiLCBcInNsYXNoLWNvbW1hbmRcIik7XG5cdFx0Y29uc3Qgbm9uQm91bmRhcnkgPSBmdXp6eU1hdGNoKFwic2NcIiwgXCJkZXNjcmliZVwiKTtcblx0XHRhc3NlcnQub2soYm91bmRhcnkuc2NvcmUgPCBub25Cb3VuZGFyeS5zY29yZSwgXCJ3b3JkIGJvdW5kYXJ5IG1hdGNoZXMgc2hvdWxkIHNjb3JlIGxvd2VyIChiZXR0ZXIpXCIpO1xuXHR9KTtcblxuXHRpdChcImhhbmRsZXMgYWxwaGFudW1lcmljIHN3YXAgKGUuZy4sIG9wdXMzIG1hdGNoZXMgb3B1cy0zKVwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gZnV6enlNYXRjaChcIm9wdXMzXCIsIFwib3B1cy0zXCIpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQubWF0Y2hlcywgdHJ1ZSk7XG5cdH0pO1xuXG5cdGl0KFwiaGFuZGxlcyBudW1lcmljLWFscGhhIHN3YXBcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IGZ1enp5TWF0Y2goXCIzb3B1c1wiLCBcIm9wdXMtM1wiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0Lm1hdGNoZXMsIHRydWUpO1xuXHR9KTtcblxuXHRpdChcImRvZXMgbm90IG1hdGNoIGNvbXBsZXRlbHkgdW5yZWxhdGVkIHN0cmluZ3NcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IGZ1enp5TWF0Y2goXCJ4eXpcIiwgXCJoZWxsb1wiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0Lm1hdGNoZXMsIGZhbHNlKTtcblx0fSk7XG59KTtcblxuZGVzY3JpYmUoXCJmdXp6eUZpbHRlclwiLCAoKSA9PiB7XG5cdGNvbnN0IGl0ZW1zID0gW1wic2V0dGluZ3NcIiwgXCJzZXNzaW9uXCIsIFwic2hhcmVcIiwgXCJtb2RlbFwiLCBcImNvbXBhY3RcIiwgXCJleHBvcnRcIl07XG5cblx0aXQoXCJyZXR1cm5zIGFsbCBpdGVtcyBmb3IgZW1wdHkgcXVlcnlcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IGZ1enp5RmlsdGVyKGl0ZW1zLCBcIlwiLCAoeCkgPT4geCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5sZW5ndGgsIGl0ZW1zLmxlbmd0aCk7XG5cdH0pO1xuXG5cdGl0KFwiZmlsdGVycyB0byBtYXRjaGluZyBpdGVtcyBvbmx5XCIsICgpID0+IHtcblx0XHRjb25zdCByZXN1bHQgPSBmdXp6eUZpbHRlcihpdGVtcywgXCJzZVwiLCAoeCkgPT4geCk7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdC5pbmNsdWRlcyhcInNldHRpbmdzXCIpKTtcblx0XHRhc3NlcnQub2socmVzdWx0LmluY2x1ZGVzKFwic2Vzc2lvblwiKSk7XG5cdFx0YXNzZXJ0Lm9rKCFyZXN1bHQuaW5jbHVkZXMoXCJtb2RlbFwiKSk7XG5cdH0pO1xuXG5cdGl0KFwic29ydHMgYnkgbWF0Y2ggcXVhbGl0eSAoYmVzdCBmaXJzdClcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IGZ1enp5RmlsdGVyKGl0ZW1zLCBcImV4XCIsICh4KSA9PiB4KTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0WzBdLCBcImV4cG9ydFwiKTtcblx0fSk7XG5cblx0aXQoXCJzdXBwb3J0cyBzcGFjZS1zZXBhcmF0ZWQgdG9rZW5zIChhbGwgbXVzdCBtYXRjaClcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGRhdGEgPSBbXCJhbnRocm9waWMvb3B1c1wiLCBcImFudGhyb3BpYy9zb25uZXRcIiwgXCJvcGVuYWkvZ3B0NFwiXTtcblx0XHRjb25zdCByZXN1bHQgPSBmdXp6eUZpbHRlcihkYXRhLCBcImFudCBvcHVzXCIsICh4KSA9PiB4KTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0Lmxlbmd0aCwgMSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdFswXSwgXCJhbnRocm9waWMvb3B1c1wiKTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIGVtcHR5IGFycmF5IHdoZW4gbm8gaXRlbXMgbWF0Y2hcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IGZ1enp5RmlsdGVyKGl0ZW1zLCBcInp6elwiLCAoeCkgPT4geCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5sZW5ndGgsIDApO1xuXHR9KTtcblxuXHRpdChcIndvcmtzIHdpdGggY3VzdG9tIGdldFRleHQgZnVuY3Rpb25cIiwgKCkgPT4ge1xuXHRcdGNvbnN0IG9iamVjdHMgPSBbXG5cdFx0XHR7IG5hbWU6IFwiYWxwaGFcIiwgaWQ6IDEgfSxcblx0XHRcdHsgbmFtZTogXCJiZXRhXCIsIGlkOiAyIH0sXG5cdFx0XHR7IG5hbWU6IFwiZ2FtbWFcIiwgaWQ6IDMgfSxcblx0XHRdO1xuXHRcdGNvbnN0IHJlc3VsdCA9IGZ1enp5RmlsdGVyKG9iamVjdHMsIFwiYmV0XCIsIChvKSA9PiBvLm5hbWUpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQubGVuZ3RoLCAxKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0WzBdPy5uYW1lLCBcImJldGFcIik7XG5cdH0pO1xuXG5cdGl0KFwiaGFuZGxlcyB3aGl0ZXNwYWNlLW9ubHkgcXVlcnkgYXMgZW1wdHlcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IGZ1enp5RmlsdGVyKGl0ZW1zLCBcIiAgIFwiLCAoeCkgPT4geCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5sZW5ndGgsIGl0ZW1zLmxlbmd0aCk7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsVUFBVTtBQUM3QixPQUFPLFlBQVk7QUFDbkIsU0FBUyxZQUFZLG1CQUFtQjtBQUV4QyxTQUFTLGNBQWMsTUFBTTtBQUM1QixLQUFHLHdCQUF3QixNQUFNO0FBQ2hDLFVBQU0sU0FBUyxXQUFXLFNBQVMsT0FBTztBQUMxQyxXQUFPLE1BQU0sT0FBTyxTQUFTLElBQUk7QUFBQSxFQUNsQyxDQUFDO0FBRUQsS0FBRyx5Q0FBeUMsTUFBTTtBQUNqRCxVQUFNLFNBQVMsV0FBVyxPQUFPLE9BQU87QUFDeEMsV0FBTyxNQUFNLE9BQU8sU0FBUyxJQUFJO0FBQUEsRUFDbEMsQ0FBQztBQUVELEtBQUcsbURBQW1ELE1BQU07QUFDM0QsVUFBTSxTQUFTLFdBQVcsT0FBTyxPQUFPO0FBQ3hDLFdBQU8sTUFBTSxPQUFPLFNBQVMsS0FBSztBQUFBLEVBQ25DLENBQUM7QUFFRCxLQUFHLGtDQUFrQyxNQUFNO0FBQzFDLFVBQU0sU0FBUyxXQUFXLElB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
