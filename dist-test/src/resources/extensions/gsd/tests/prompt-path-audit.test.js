import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const promptsDir = join(__dirname, "..", "prompts");
test("prompt templates do not reference legacy milestone-root .gsd paths", () => {
  const offenders = [];
  for (const file of readdirSync(promptsDir)) {
    if (!file.endsWith(".md")) continue;
    const content = readFileSync(join(promptsDir, file), "utf-8");
    const legacyPatterns = [
      /\.gsd\/\{\{(?:milestoneId|mid)\}\}\//g,
      /\.gsd\/<milestone-id>\//g,
      /\.gsd\/<ID>\//g
    ];
    for (const pattern of legacyPatterns) {
      if (pattern.test(content)) {
        offenders.push(`${file}: ${pattern.source}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Milestone artifacts must use .gsd/milestones/<MID>/..., not legacy .gsd/<MID>/..."
  );
});
test("quick task prompt delegates commit policy to quick.ts", () => {
  const content = readFileSync(join(promptsDir, "quick-task.md"), "utf-8");
  assert.match(content, /\{\{commitInstruction\}\}/);
  assert.doesNotMatch(content, /Stage only relevant files/);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcm9tcHQtcGF0aC1hdWRpdC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IHJlYWRGaWxlU3luYywgcmVhZGRpclN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IGRpcm5hbWUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmNvbnN0IF9fZmlsZW5hbWUgPSBmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCk7XG5jb25zdCBfX2Rpcm5hbWUgPSBkaXJuYW1lKF9fZmlsZW5hbWUpO1xuY29uc3QgcHJvbXB0c0RpciA9IGpvaW4oX19kaXJuYW1lLCBcIi4uXCIsIFwicHJvbXB0c1wiKTtcblxudGVzdChcInByb21wdCB0ZW1wbGF0ZXMgZG8gbm90IHJlZmVyZW5jZSBsZWdhY3kgbWlsZXN0b25lLXJvb3QgLmdzZCBwYXRoc1wiLCAoKSA9PiB7XG4gIGNvbnN0IG9mZmVuZGVyczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBmaWxlIG9mIHJlYWRkaXJTeW5jKHByb21wdHNEaXIpKSB7XG4gICAgaWYgKCFmaWxlLmVuZHNXaXRoKFwiLm1kXCIpKSBjb250aW51ZTtcbiAgICBjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKGpvaW4ocHJvbXB0c0RpciwgZmlsZSksIFwidXRmLThcIik7XG4gICAgY29uc3QgbGVnYWN5UGF0dGVybnMgPSBbXG4gICAgICAvXFwuZ3NkXFwvXFx7XFx7KD86bWlsZXN0b25lSWR8bWlkKVxcfVxcfVxcLy9nLFxuICAgICAgL1xcLmdzZFxcLzxtaWxlc3RvbmUtaWQ+XFwvL2csXG4gICAgICAvXFwuZ3NkXFwvPElEPlxcLy9nLFxuICAgIF07XG4gICAgZm9yIChjb25zdCBwYXR0ZXJuIG9mIGxlZ2FjeVBhdHRlcm5zKSB7XG4gICAgICBpZiAocGF0dGVybi50ZXN0KGNvbnRlbnQpKSB7XG4gICAgICAgIG9mZmVuZGVycy5wdXNoKGAke2ZpbGV9OiAke3BhdHRlcm4uc291cmNlfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgb2ZmZW5kZXJzLFxuICAgIFtdLFxuICAgIFwiTWlsZXN0b25lIGFydGlmYWN0cyBtdXN0IHVzZSAuZ3NkL21pbGVzdG9uZXMvPE1JRD4vLi4uLCBub3QgbGVnYWN5IC5nc2QvPE1JRD4vLi4uXCIsXG4gICk7XG59KTtcblxudGVzdChcInF1aWNrIHRhc2sgcHJvbXB0IGRlbGVnYXRlcyBjb21taXQgcG9saWN5IHRvIHF1aWNrLnRzXCIsICgpID0+IHtcbiAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhqb2luKHByb21wdHNEaXIsIFwicXVpY2stdGFzay5tZFwiKSwgXCJ1dGYtOFwiKTtcbiAgYXNzZXJ0Lm1hdGNoKGNvbnRlbnQsIC9cXHtcXHtjb21taXRJbnN0cnVjdGlvblxcfVxcfS8pO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKGNvbnRlbnQsIC9TdGFnZSBvbmx5IHJlbGV2YW50IGZpbGVzLyk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxjQUFjLG1CQUFtQjtBQUMxQyxTQUFTLFlBQVk7QUFDckIsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxlQUFlO0FBRXhCLE1BQU0sYUFBYSxjQUFjLFlBQVksR0FBRztBQUNoRCxNQUFNLFlBQVksUUFBUSxVQUFVO0FBQ3BDLE1BQU0sYUFBYSxLQUFLLFdBQVcsTUFBTSxTQUFTO0FBRWxELEtBQUssc0VBQXNFLE1BQU07QUFDL0UsUUFBTSxZQUFzQixDQUFDO0FBQzdCLGFBQVcsUUFBUSxZQUFZLFVBQVUsR0FBRztBQUMxQyxRQUFJLENBQUMsS0FBSyxTQUFTLEtBQUssRUFBRztBQUMzQixVQUFNLFVBQVUsYUFBYSxLQUFLLFlBQVksSUFBSSxHQUFHLE9BQU87QUFDNUQsVUFBTSxpQkFBaUI7QUFBQSxNQUNyQjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUNBLGVBQVcsV0FBVyxnQkFBZ0I7QUFDcEMsVUFBSSxRQUFRLEtBQUssT0FBTyxHQUFHO0FBQ3pCLGtCQUFVLEtBQUssR0FBRyxJQUFJLEtBQUssUUFBUSxNQUFNLEVBQUU7QUFBQSxNQUM3QztBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBRUEsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBLENBQUM7QUFBQSxJQUNEO0FBQUEsRUFDRjtBQUNGLENBQUM7QUFFRCxLQUFLLHlEQUF5RCxNQUFNO0FBQ2xFLFFBQU0sVUFBVSxhQUFhLEtBQUssWUFBWSxlQUFlLEdBQUcsT0FBTztBQUN2RSxTQUFPLE1BQU0sU0FBUywyQkFBMkI7QUFDakQsU0FBTyxhQUFhLFNBQVMsMkJBQTJCO0FBQzFELENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
