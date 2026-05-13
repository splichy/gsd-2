import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockModel,
  isModelBlocked,
  loadBlockedModels
} from "../blocked-models.js";
function mkBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-blocked-models-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}
test("blocked-models: round-trip write and read", () => {
  const base = mkBase();
  try {
    assert.equal(isModelBlocked(base, "openai-codex", "gpt-5.1-codex-max"), false);
    blockModel(base, "openai-codex", "gpt-5.1-codex-max", "not supported for ChatGPT account");
    assert.equal(isModelBlocked(base, "openai-codex", "gpt-5.1-codex-max"), true);
    const entries = loadBlockedModels(base);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].provider, "openai-codex");
    assert.equal(entries[0].id, "gpt-5.1-codex-max");
    assert.ok(entries[0].blockedAt > 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("blocked-models: case-insensitive lookup", () => {
  const base = mkBase();
  try {
    blockModel(base, "OpenAI-Codex", "GPT-5.1-Codex-Max", "reason");
    assert.equal(isModelBlocked(base, "openai-codex", "gpt-5.1-codex-max"), true);
    assert.equal(isModelBlocked(base, "OPENAI-CODEX", "GPT-5.1-CODEX-MAX"), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("blocked-models: dedupes repeated blocks", () => {
  const base = mkBase();
  try {
    blockModel(base, "openai-codex", "gpt-5", "first");
    blockModel(base, "openai-codex", "gpt-5", "second");
    blockModel(base, "openai-codex", "gpt-5", "third");
    assert.equal(loadBlockedModels(base).length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("blocked-models: corrupted JSON recovers to empty", () => {
  const base = mkBase();
  try {
    const path = join(base, ".gsd", "runtime", "blocked-models.json");
    mkdirSync(join(base, ".gsd", "runtime"), { recursive: true });
    writeFileSync(path, "{not valid json", "utf-8");
    assert.equal(loadBlockedModels(base).length, 0);
    assert.equal(isModelBlocked(base, "any", "model"), false);
    blockModel(base, "openai-codex", "gpt-5", "reason");
    assert.equal(loadBlockedModels(base).length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("blocked-models: returns false for missing provider or id", () => {
  const base = mkBase();
  try {
    blockModel(base, "openai-codex", "gpt-5", "reason");
    assert.equal(isModelBlocked(base, void 0, "gpt-5"), false);
    assert.equal(isModelBlocked(base, "openai-codex", void 0), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("blocked-models: file created under .gsd/runtime/", () => {
  const base = mkBase();
  try {
    blockModel(base, "openai-codex", "gpt-5", "reason");
    assert.ok(existsSync(join(base, ".gsd", "runtime", "blocked-models.json")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9ibG9ja2VkLW1vZGVscy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QgXHUyMDE0IFRlc3RzIGZvciBwZXJzaXN0ZW50IGJsb2NrZWQtbW9kZWxzIHN0b3JlIChpc3N1ZSAjNDUxMylcblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB7XG4gIGJsb2NrTW9kZWwsXG4gIGlzTW9kZWxCbG9ja2VkLFxuICBsb2FkQmxvY2tlZE1vZGVscyxcbn0gZnJvbSBcIi4uL2Jsb2NrZWQtbW9kZWxzLnRzXCI7XG5cbmZ1bmN0aW9uIG1rQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtYmxvY2tlZC1tb2RlbHMtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcmV0dXJuIGJhc2U7XG59XG5cbnRlc3QoXCJibG9ja2VkLW1vZGVsczogcm91bmQtdHJpcCB3cml0ZSBhbmQgcmVhZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta0Jhc2UoKTtcbiAgdHJ5IHtcbiAgICBhc3NlcnQuZXF1YWwoaXNNb2RlbEJsb2NrZWQoYmFzZSwgXCJvcGVuYWktY29kZXhcIiwgXCJncHQtNS4xLWNvZGV4LW1heFwiKSwgZmFsc2UpO1xuICAgIGJsb2NrTW9kZWwoYmFzZSwgXCJvcGVuYWktY29kZXhcIiwgXCJncHQtNS4xLWNvZGV4LW1heFwiLCBcIm5vdCBzdXBwb3J0ZWQgZm9yIENoYXRHUFQgYWNjb3VudFwiKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNNb2RlbEJsb2NrZWQoYmFzZSwgXCJvcGVuYWktY29kZXhcIiwgXCJncHQtNS4xLWNvZGV4LW1heFwiKSwgdHJ1ZSk7XG5cbiAgICBjb25zdCBlbnRyaWVzID0gbG9hZEJsb2NrZWRNb2RlbHMoYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGVudHJpZXMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwoZW50cmllc1swXS5wcm92aWRlciwgXCJvcGVuYWktY29kZXhcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGVudHJpZXNbMF0uaWQsIFwiZ3B0LTUuMS1jb2RleC1tYXhcIik7XG4gICAgYXNzZXJ0Lm9rKGVudHJpZXNbMF0uYmxvY2tlZEF0ID4gMCk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJibG9ja2VkLW1vZGVsczogY2FzZS1pbnNlbnNpdGl2ZSBsb29rdXBcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWtCYXNlKCk7XG4gIHRyeSB7XG4gICAgYmxvY2tNb2RlbChiYXNlLCBcIk9wZW5BSS1Db2RleFwiLCBcIkdQVC01LjEtQ29kZXgtTWF4XCIsIFwicmVhc29uXCIpO1xuICAgIGFzc2VydC5lcXVhbChpc01vZGVsQmxvY2tlZChiYXNlLCBcIm9wZW5haS1jb2RleFwiLCBcImdwdC01LjEtY29kZXgtbWF4XCIpLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNNb2RlbEJsb2NrZWQoYmFzZSwgXCJPUEVOQUktQ09ERVhcIiwgXCJHUFQtNS4xLUNPREVYLU1BWFwiKSwgdHJ1ZSk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJibG9ja2VkLW1vZGVsczogZGVkdXBlcyByZXBlYXRlZCBibG9ja3NcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWtCYXNlKCk7XG4gIHRyeSB7XG4gICAgYmxvY2tNb2RlbChiYXNlLCBcIm9wZW5haS1jb2RleFwiLCBcImdwdC01XCIsIFwiZmlyc3RcIik7XG4gICAgYmxvY2tNb2RlbChiYXNlLCBcIm9wZW5haS1jb2RleFwiLCBcImdwdC01XCIsIFwic2Vjb25kXCIpO1xuICAgIGJsb2NrTW9kZWwoYmFzZSwgXCJvcGVuYWktY29kZXhcIiwgXCJncHQtNVwiLCBcInRoaXJkXCIpO1xuICAgIGFzc2VydC5lcXVhbChsb2FkQmxvY2tlZE1vZGVscyhiYXNlKS5sZW5ndGgsIDEpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiYmxvY2tlZC1tb2RlbHM6IGNvcnJ1cHRlZCBKU09OIHJlY292ZXJzIHRvIGVtcHR5XCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1rQmFzZSgpO1xuICB0cnkge1xuICAgIGNvbnN0IHBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJibG9ja2VkLW1vZGVscy5qc29uXCIpO1xuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMocGF0aCwgXCJ7bm90IHZhbGlkIGpzb25cIiwgXCJ1dGYtOFwiKTtcblxuICAgIGFzc2VydC5lcXVhbChsb2FkQmxvY2tlZE1vZGVscyhiYXNlKS5sZW5ndGgsIDApO1xuICAgIGFzc2VydC5lcXVhbChpc01vZGVsQmxvY2tlZChiYXNlLCBcImFueVwiLCBcIm1vZGVsXCIpLCBmYWxzZSk7XG5cbiAgICAvLyBBIHN1YnNlcXVlbnQgd3JpdGUgc2hvdWxkIHN0aWxsIHN1Y2NlZWQgKG92ZXJ3cml0ZXMgdGhlIGNvcnJ1cHQgZmlsZSkuXG4gICAgYmxvY2tNb2RlbChiYXNlLCBcIm9wZW5haS1jb2RleFwiLCBcImdwdC01XCIsIFwicmVhc29uXCIpO1xuICAgIGFzc2VydC5lcXVhbChsb2FkQmxvY2tlZE1vZGVscyhiYXNlKS5sZW5ndGgsIDEpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiYmxvY2tlZC1tb2RlbHM6IHJldHVybnMgZmFsc2UgZm9yIG1pc3NpbmcgcHJvdmlkZXIgb3IgaWRcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gbWtCYXNlKCk7XG4gIHRyeSB7XG4gICAgYmxvY2tNb2RlbChiYXNlLCBcIm9wZW5haS1jb2RleFwiLCBcImdwdC01XCIsIFwicmVhc29uXCIpO1xuICAgIGFzc2VydC5lcXVhbChpc01vZGVsQmxvY2tlZChiYXNlLCB1bmRlZmluZWQsIFwiZ3B0LTVcIiksIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNNb2RlbEJsb2NrZWQoYmFzZSwgXCJvcGVuYWktY29kZXhcIiwgdW5kZWZpbmVkKSwgZmFsc2UpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiYmxvY2tlZC1tb2RlbHM6IGZpbGUgY3JlYXRlZCB1bmRlciAuZ3NkL3J1bnRpbWUvXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1rQmFzZSgpO1xuICB0cnkge1xuICAgIGJsb2NrTW9kZWwoYmFzZSwgXCJvcGVuYWktY29kZXhcIiwgXCJncHQtNVwiLCBcInJlYXNvblwiKTtcbiAgICBhc3NlcnQub2soZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcInJ1bnRpbWVcIiwgXCJibG9ja2VkLW1vZGVscy5qc29uXCIpKSk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEsZUFBZSxrQkFBa0I7QUFDMUUsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsWUFBWTtBQUVyQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFFUCxTQUFTLFNBQWlCO0FBQ3hCLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLHFCQUFxQixDQUFDO0FBQzlELFlBQVUsS0FBSyxNQUFNLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2pELFNBQU87QUFDVDtBQUVBLEtBQUssNkNBQTZDLE1BQU07QUFDdEQsUUFBTSxPQUFPLE9BQU87QUFDcEIsTUFBSTtBQUNGLFdBQU8sTUFBTSxlQUFlLE1BQU0sZ0JBQWdCLG1CQUFtQixHQUFHLEtBQUs7QUFDN0UsZUFBVyxNQUFNLGdCQUFnQixxQkFBcUIsbUNBQW1DO0FBQ3pGLFdBQU8sTUFBTSxlQUFlLE1BQU0sZ0JBQWdCLG1CQUFtQixHQUFHLElBQUk7QUFFNUUsVUFBTSxVQUFVLGtCQUFrQixJQUFJO0FBQ3RDLFdBQU8sTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUM5QixXQUFPLE1BQU0sUUFBUSxDQUFDLEVBQUUsVUFBVSxjQUFjO0FBQ2hELFdBQU8sTUFBTSxRQUFRLENBQUMsRUFBRSxJQUFJLG1CQUFtQjtBQUMvQyxXQUFPLEdBQUcsUUFBUSxDQUFDLEVBQUUsWUFBWSxDQUFDO0FBQUEsRUFDcEMsVUFBRTtBQUNBLFdBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQy9DO0FBQ0YsQ0FBQztBQUVELEtBQUssMkNBQTJDLE1BQU07QUFDcEQsUUFBTSxPQUFPLE9BQU87QUFDcEIsTUFBSTtBQUNGLGVBQVcsTUFBTSxnQkFBZ0IscUJBQXFCLFFBQVE7QUFDOUQsV0FBTyxNQUFNLGVBQWUsTUFBTSxnQkFBZ0IsbUJBQW1CLEdBQUcsSUFBSTtBQUM1RSxXQUFPLE1BQU0sZUFBZSxNQUFNLGdCQUFnQixtQkFBbUIsR0FBRyxJQUFJO0FBQUEsRUFDOUUsVUFBRTtBQUNBLFdBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQy9DO0FBQ0YsQ0FBQztBQUVELEtBQUssMkNBQTJDLE1BQU07QUFDcEQsUUFBTSxPQUFPLE9BQU87QUFDcEIsTUFBSTtBQUNGLGVBQVcsTUFBTSxnQkFBZ0IsU0FBUyxPQUFPO0FBQ2pELGVBQVcsTUFBTSxnQkFBZ0IsU0FBUyxRQUFRO0FBQ2xELGVBQVcsTUFBTSxnQkFBZ0IsU0FBUyxPQUFPO0FBQ2pELFdBQU8sTUFBTSxrQkFBa0IsSUFBSSxFQUFFLFFBQVEsQ0FBQztBQUFBLEVBQ2hELFVBQUU7QUFDQSxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvQztBQUNGLENBQUM7QUFFRCxLQUFLLG9EQUFvRCxNQUFNO0FBQzdELFFBQU0sT0FBTyxPQUFPO0FBQ3BCLE1BQUk7QUFDRixVQUFNLE9BQU8sS0FBSyxNQUFNLFFBQVEsV0FBVyxxQkFBcUI7QUFDaEUsY0FBVSxLQUFLLE1BQU0sUUFBUSxTQUFTLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUM1RCxrQkFBYyxNQUFNLG1CQUFtQixPQUFPO0FBRTlDLFdBQU8sTUFBTSxrQkFBa0IsSUFBSSxFQUFFLFFBQVEsQ0FBQztBQUM5QyxXQUFPLE1BQU0sZUFBZSxNQUFNLE9BQU8sT0FBTyxHQUFHLEtBQUs7QUFHeEQsZUFBVyxNQUFNLGdCQUFnQixTQUFTLFFBQVE7QUFDbEQsV0FBTyxNQUFNLGtCQUFrQixJQUFJLEVBQUUsUUFBUSxDQUFDO0FBQUEsRUFDaEQsVUFBRTtBQUNBLFdBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQy9DO0FBQ0YsQ0FBQztBQUVELEtBQUssNERBQTRELE1BQU07QUFDckUsUUFBTSxPQUFPLE9BQU87QUFDcEIsTUFBSTtBQUNGLGVBQVcsTUFBTSxnQkFBZ0IsU0FBUyxRQUFRO0FBQ2xELFdBQU8sTUFBTSxlQUFlLE1BQU0sUUFBVyxPQUFPLEdBQUcsS0FBSztBQUM1RCxXQUFPLE1BQU0sZUFBZSxNQUFNLGdCQUFnQixNQUFTLEdBQUcsS0FBSztBQUFBLEVBQ3JFLFVBQUU7QUFDQSxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvQztBQUNGLENBQUM7QUFFRCxLQUFLLG9EQUFvRCxNQUFNO0FBQzdELFFBQU0sT0FBTyxPQUFPO0FBQ3BCLE1BQUk7QUFDRixlQUFXLE1BQU0sZ0JBQWdCLFNBQVMsUUFBUTtBQUNsRCxXQUFPLEdBQUcsV0FBVyxLQUFLLE1BQU0sUUFBUSxXQUFXLHFCQUFxQixDQUFDLENBQUM7QUFBQSxFQUM1RSxVQUFFO0FBQ0EsV0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDL0M7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
