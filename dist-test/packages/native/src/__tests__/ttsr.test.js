import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require2 = createRequire(import.meta.url);
const addonDir = path.resolve(__dirname, "..", "..", "..", "..", "native", "addon");
const platformTag = `${process.platform}-${process.arch}`;
const candidates = [
  path.join(addonDir, `gsd_engine.${platformTag}.node`),
  path.join(addonDir, "gsd_engine.dev.node")
];
let native;
for (const candidate of candidates) {
  try {
    native = require2(candidate);
    break;
  } catch {
  }
}
if (!native) {
  console.error("Native addon not found. Run `npm run build:native -w @gsd/native` first.");
  process.exit(1);
}
describe("native ttsr: ttsrCompileRules()", () => {
  test("compiles rules and returns a numeric handle", () => {
    const handle = native.ttsrCompileRules([
      { name: "rule1", conditions: ["foo", "bar"] }
    ]);
    assert.equal(typeof handle, "number");
    assert.ok(handle > 0);
    native.ttsrFreeRules(handle);
  });
  test("rejects empty conditions", () => {
    assert.throws(() => {
      native.ttsrCompileRules([]);
    });
  });
  test("rejects invalid regex patterns", () => {
    assert.throws(() => {
      native.ttsrCompileRules([
        { name: "bad", conditions: ["(unclosed"] }
      ]);
    });
  });
});
describe("native ttsr: ttsrCheckBuffer()", () => {
  test("returns matching rule names", () => {
    const handle = native.ttsrCompileRules([
      { name: "greet", conditions: ["hello\\s+world"] },
      { name: "farewell", conditions: ["goodbye"] }
    ]);
    const matches = native.ttsrCheckBuffer(handle, "say hello world please");
    assert.deepEqual(matches, ["greet"]);
    native.ttsrFreeRules(handle);
  });
  test("returns multiple matching rules", () => {
    const handle = native.ttsrCompileRules([
      { name: "a", conditions: ["alpha"] },
      { name: "b", conditions: ["beta"] },
      { name: "c", conditions: ["gamma"] }
    ]);
    const matches = native.ttsrCheckBuffer(handle, "alpha and beta together");
    assert.ok(matches.includes("a"));
    assert.ok(matches.includes("b"));
    assert.ok(!matches.includes("c"));
    native.ttsrFreeRules(handle);
  });
  test("returns empty array on no match", () => {
    const handle = native.ttsrCompileRules([
      { name: "x", conditions: ["zzz_no_match"] }
    ]);
    const matches = native.ttsrCheckBuffer(handle, "nothing here");
    assert.deepEqual(matches, []);
    native.ttsrFreeRules(handle);
  });
  test("deduplicates when multiple conditions of same rule match", () => {
    const handle = native.ttsrCompileRules([
      { name: "multi", conditions: ["foo", "bar"] }
    ]);
    const matches = native.ttsrCheckBuffer(handle, "foo and bar");
    assert.deepEqual(matches, ["multi"]);
    native.ttsrFreeRules(handle);
  });
  test("handles large buffers efficiently", () => {
    const handle = native.ttsrCompileRules([
      { name: "needle", conditions: ["NEEDLE_PATTERN_XYZ"] }
    ]);
    const bigBuffer = "x".repeat(1024 * 1024) + "NEEDLE_PATTERN_XYZ";
    const matches = native.ttsrCheckBuffer(handle, bigBuffer);
    assert.deepEqual(matches, ["needle"]);
    native.ttsrFreeRules(handle);
  });
});
describe("native ttsr: ttsrFreeRules()", () => {
  test("frees handle without error", () => {
    const handle = native.ttsrCompileRules([
      { name: "temp", conditions: ["tmp"] }
    ]);
    native.ttsrFreeRules(handle);
  });
  test("rejects invalid handle on check", () => {
    assert.throws(() => {
      native.ttsrCheckBuffer(99999, "test");
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvbmF0aXZlL3NyYy9fX3Rlc3RzX18vdHRzci50ZXN0Lm1qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgdGVzdCwgZGVzY3JpYmUgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tIFwibm9kZTptb2R1bGVcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuXG5jb25zdCBfX2Rpcm5hbWUgPSBwYXRoLmRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IHJlcXVpcmUgPSBjcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XG5cbi8vIExvYWQgdGhlIG5hdGl2ZSBhZGRvbiBkaXJlY3RseVxuY29uc3QgYWRkb25EaXIgPSBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwibmF0aXZlXCIsIFwiYWRkb25cIik7XG5jb25zdCBwbGF0Zm9ybVRhZyA9IGAke3Byb2Nlc3MucGxhdGZvcm19LSR7cHJvY2Vzcy5hcmNofWA7XG5jb25zdCBjYW5kaWRhdGVzID0gW1xuICBwYXRoLmpvaW4oYWRkb25EaXIsIGBnc2RfZW5naW5lLiR7cGxhdGZvcm1UYWd9Lm5vZGVgKSxcbiAgcGF0aC5qb2luKGFkZG9uRGlyLCBcImdzZF9lbmdpbmUuZGV2Lm5vZGVcIiksXG5dO1xuXG5sZXQgbmF0aXZlO1xuZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgY2FuZGlkYXRlcykge1xuICB0cnkge1xuICAgIG5hdGl2ZSA9IHJlcXVpcmUoY2FuZGlkYXRlKTtcbiAgICBicmVhaztcbiAgfSBjYXRjaCB7XG4gICAgLy8gdHJ5IG5leHRcbiAgfVxufVxuXG5pZiAoIW5hdGl2ZSkge1xuICBjb25zb2xlLmVycm9yKFwiTmF0aXZlIGFkZG9uIG5vdCBmb3VuZC4gUnVuIGBucG0gcnVuIGJ1aWxkOm5hdGl2ZSAtdyBAZ3NkL25hdGl2ZWAgZmlyc3QuXCIpO1xuICBwcm9jZXNzLmV4aXQoMSk7XG59XG5cbmRlc2NyaWJlKFwibmF0aXZlIHR0c3I6IHR0c3JDb21waWxlUnVsZXMoKVwiLCAoKSA9PiB7XG4gIHRlc3QoXCJjb21waWxlcyBydWxlcyBhbmQgcmV0dXJucyBhIG51bWVyaWMgaGFuZGxlXCIsICgpID0+IHtcbiAgICBjb25zdCBoYW5kbGUgPSBuYXRpdmUudHRzckNvbXBpbGVSdWxlcyhbXG4gICAgICB7IG5hbWU6IFwicnVsZTFcIiwgY29uZGl0aW9uczogW1wiZm9vXCIsIFwiYmFyXCJdIH0sXG4gICAgXSk7XG4gICAgYXNzZXJ0LmVxdWFsKHR5cGVvZiBoYW5kbGUsIFwibnVtYmVyXCIpO1xuICAgIGFzc2VydC5vayhoYW5kbGUgPiAwKTtcbiAgICBuYXRpdmUudHRzckZyZWVSdWxlcyhoYW5kbGUpO1xuICB9KTtcblxuICB0ZXN0KFwicmVqZWN0cyBlbXB0eSBjb25kaXRpb25zXCIsICgpID0+IHtcbiAgICBhc3NlcnQudGhyb3dzKCgpID0+IHtcbiAgICAgIG5hdGl2ZS50dHNyQ29tcGlsZVJ1bGVzKFtdKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdChcInJlamVjdHMgaW52YWxpZCByZWdleCBwYXR0ZXJuc1wiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LnRocm93cygoKSA9PiB7XG4gICAgICBuYXRpdmUudHRzckNvbXBpbGVSdWxlcyhbXG4gICAgICAgIHsgbmFtZTogXCJiYWRcIiwgY29uZGl0aW9uczogW1wiKHVuY2xvc2VkXCJdIH0sXG4gICAgICBdKTtcbiAgICB9KTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJuYXRpdmUgdHRzcjogdHRzckNoZWNrQnVmZmVyKClcIiwgKCkgPT4ge1xuICB0ZXN0KFwicmV0dXJucyBtYXRjaGluZyBydWxlIG5hbWVzXCIsICgpID0+IHtcbiAgICBjb25zdCBoYW5kbGUgPSBuYXRpdmUudHRzckNvbXBpbGVSdWxlcyhbXG4gICAgICB7IG5hbWU6IFwiZ3JlZXRcIiwgY29uZGl0aW9uczogW1wiaGVsbG9cXFxccyt3b3JsZFwiXSB9LFxuICAgICAgeyBuYW1lOiBcImZhcmV3ZWxsXCIsIGNvbmRpdGlvbnM6IFtcImdvb2RieWVcIl0gfSxcbiAgICBdKTtcblxuICAgIGNvbnN0IG1hdGNoZXMgPSBuYXRpdmUudHRzckNoZWNrQnVmZmVyKGhhbmRsZSwgXCJzYXkgaGVsbG8gd29ybGQgcGxlYXNlXCIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwobWF0Y2hlcywgW1wiZ3JlZXRcIl0pO1xuXG4gICAgbmF0aXZlLnR0c3JGcmVlUnVsZXMoaGFuZGxlKTtcbiAgfSk7XG5cbiAgdGVzdChcInJldHVybnMgbXVsdGlwbGUgbWF0Y2hpbmcgcnVsZXNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGhhbmRsZSA9IG5hdGl2ZS50dHNyQ29tcGlsZVJ1bGVzKFtcbiAgICAgIHsgbmFtZTogXCJhXCIsIGNvbmRpdGlvbnM6IFtcImFscGhhXCJdIH0sXG4gICAgICB7IG5hbWU6IFwiYlwiLCBjb25kaXRpb25zOiBbXCJiZXRhXCJdIH0sXG4gICAgICB7IG5hbWU6IFwiY1wiLCBjb25kaXRpb25zOiBbXCJnYW1tYVwiXSB9LFxuICAgIF0pO1xuXG4gICAgY29uc3QgbWF0Y2hlcyA9IG5hdGl2ZS50dHNyQ2hlY2tCdWZmZXIoaGFuZGxlLCBcImFscGhhIGFuZCBiZXRhIHRvZ2V0aGVyXCIpO1xuICAgIGFzc2VydC5vayhtYXRjaGVzLmluY2x1ZGVzKFwiYVwiKSk7XG4gICAgYXNzZXJ0Lm9rKG1hdGNoZXMuaW5jbHVkZXMoXCJiXCIpKTtcbiAgICBhc3NlcnQub2soIW1hdGNoZXMuaW5jbHVkZXMoXCJjXCIpKTtcblxuICAgIG5hdGl2ZS50dHNyRnJlZVJ1bGVzKGhhbmRsZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJyZXR1cm5zIGVtcHR5IGFycmF5IG9uIG5vIG1hdGNoXCIsICgpID0+IHtcbiAgICBjb25zdCBoYW5kbGUgPSBuYXRpdmUudHRzckNvbXBpbGVSdWxlcyhbXG4gICAgICB7IG5hbWU6IFwieFwiLCBjb25kaXRpb25zOiBbXCJ6enpfbm9fbWF0Y2hcIl0gfSxcbiAgICBdKTtcblxuICAgIGNvbnN0IG1hdGNoZXMgPSBuYXRpdmUudHRzckNoZWNrQnVmZmVyKGhhbmRsZSwgXCJub3RoaW5nIGhlcmVcIik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChtYXRjaGVzLCBbXSk7XG5cbiAgICBuYXRpdmUudHRzckZyZWVSdWxlcyhoYW5kbGUpO1xuICB9KTtcblxuICB0ZXN0KFwiZGVkdXBsaWNhdGVzIHdoZW4gbXVsdGlwbGUgY29uZGl0aW9ucyBvZiBzYW1lIHJ1bGUgbWF0Y2hcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGhhbmRsZSA9IG5hdGl2ZS50dHNyQ29tcGlsZVJ1bGVzKFtcbiAgICAgIHsgbmFtZTogXCJtdWx0aVwiLCBjb25kaXRpb25zOiBbXCJmb29cIiwgXCJiYXJcIl0gfSxcbiAgICBdKTtcblxuICAgIGNvbnN0IG1hdGNoZXMgPSBuYXRpdmUudHRzckNoZWNrQnVmZmVyKGhhbmRsZSwgXCJmb28gYW5kIGJhclwiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKG1hdGNoZXMsIFtcIm11bHRpXCJdKTtcblxuICAgIG5hdGl2ZS50dHNyRnJlZVJ1bGVzKGhhbmRsZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJoYW5kbGVzIGxhcmdlIGJ1ZmZlcnMgZWZmaWNpZW50bHlcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGhhbmRsZSA9IG5hdGl2ZS50dHNyQ29tcGlsZVJ1bGVzKFtcbiAgICAgIHsgbmFtZTogXCJuZWVkbGVcIiwgY29uZGl0aW9uczogW1wiTkVFRExFX1BBVFRFUk5fWFlaXCJdIH0sXG4gICAgXSk7XG5cbiAgICAvLyAxTUIgYnVmZmVyIHdpdGggdGhlIG5lZWRsZSBuZWFyIHRoZSBlbmRcbiAgICBjb25zdCBiaWdCdWZmZXIgPSBcInhcIi5yZXBlYXQoMTAyNCAqIDEwMjQpICsgXCJORUVETEVfUEFUVEVSTl9YWVpcIjtcbiAgICBjb25zdCBtYXRjaGVzID0gbmF0aXZlLnR0c3JDaGVja0J1ZmZlcihoYW5kbGUsIGJpZ0J1ZmZlcik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChtYXRjaGVzLCBbXCJuZWVkbGVcIl0pO1xuXG4gICAgbmF0aXZlLnR0c3JGcmVlUnVsZXMoaGFuZGxlKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJuYXRpdmUgdHRzcjogdHRzckZyZWVSdWxlcygpXCIsICgpID0+IHtcbiAgdGVzdChcImZyZWVzIGhhbmRsZSB3aXRob3V0IGVycm9yXCIsICgpID0+IHtcbiAgICBjb25zdCBoYW5kbGUgPSBuYXRpdmUudHRzckNvbXBpbGVSdWxlcyhbXG4gICAgICB7IG5hbWU6IFwidGVtcFwiLCBjb25kaXRpb25zOiBbXCJ0bXBcIl0gfSxcbiAgICBdKTtcbiAgICBuYXRpdmUudHRzckZyZWVSdWxlcyhoYW5kbGUpO1xuICB9KTtcblxuICB0ZXN0KFwicmVqZWN0cyBpbnZhbGlkIGhhbmRsZSBvbiBjaGVja1wiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LnRocm93cygoKSA9PiB7XG4gICAgICBuYXRpdmUudHRzckNoZWNrQnVmZmVyKDk5OTk5LCBcInRlc3RcIik7XG4gICAgfSk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLE1BQU0sZ0JBQWdCO0FBQy9CLE9BQU8sWUFBWTtBQUNuQixTQUFTLHFCQUFxQjtBQUM5QixZQUFZLFVBQVU7QUFDdEIsU0FBUyxxQkFBcUI7QUFFOUIsTUFBTSxZQUFZLEtBQUssUUFBUSxjQUFjLFlBQVksR0FBRyxDQUFDO0FBQzdELE1BQU1BLFdBQVUsY0FBYyxZQUFZLEdBQUc7QUFHN0MsTUFBTSxXQUFXLEtBQUssUUFBUSxXQUFXLE1BQU0sTUFBTSxNQUFNLE1BQU0sVUFBVSxPQUFPO0FB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
