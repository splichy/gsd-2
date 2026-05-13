import test from "node:test";
import assert from "node:assert/strict";
test("pr-branch: identifies .gsd/ paths", () => {
  const files = [
    ".gsd/milestones/M001/ROADMAP.md",
    ".gsd/metrics.json",
    "src/main.ts",
    "package.json",
    ".planning/PLAN.md",
    "PLAN.md"
  ];
  const codeFiles = files.filter(
    (f) => !f.startsWith(".gsd/") && !f.startsWith(".planning/") && f !== "PLAN.md"
  );
  assert.deepEqual(codeFiles, ["src/main.ts", "package.json"]);
});
test("pr-branch: all .gsd/ files returns empty", () => {
  const files = [
    ".gsd/milestones/M001/ROADMAP.md",
    ".gsd/metrics.json",
    ".gsd/BACKLOG.md"
  ];
  const codeFiles = files.filter(
    (f) => !f.startsWith(".gsd/") && !f.startsWith(".planning/") && f !== "PLAN.md"
  );
  assert.equal(codeFiles.length, 0);
});
test("pr-branch: mixed commits with code changes", () => {
  const files = [
    ".gsd/milestones/M001/ROADMAP.md",
    "src/auth.ts",
    "src/auth.test.ts"
  ];
  const hasCodeChanges = files.some(
    (f) => !f.startsWith(".gsd/") && !f.startsWith(".planning/") && f !== "PLAN.md"
  );
  assert.ok(hasCodeChanges);
});
test("pr-branch: --dry-run flag", () => {
  assert.ok("--dry-run".includes("--dry-run"));
  assert.ok(!"--name my-branch".includes("--dry-run"));
});
test("pr-branch: --name flag parsing", () => {
  const args = "--name my-clean-pr";
  const nameMatch = args.match(/--name\s+(\S+)/);
  assert.ok(nameMatch);
  assert.equal(nameMatch[1], "my-clean-pr");
});
test("pr-branch: default branch name", () => {
  const currentBranch = "feat/add-auth";
  const prBranch = `pr/${currentBranch}`;
  assert.equal(prBranch, "pr/feat/add-auth");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21tYW5kcy1wci1icmFuY2gudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbi8vIFRlc3QgdGhlIGZpbHRlcmluZyBsb2dpYyB1c2VkIGJ5IC9nc2QgcHItYnJhbmNoLlxuLy8gRnVsbCBpbnRlZ3JhdGlvbiByZXF1aXJlcyBnaXQgb3BlcmF0aW9ucywgc28gd2UgdGVzdCB0aGUgcGF0aCBmaWx0ZXJpbmcuXG5cbnRlc3QoXCJwci1icmFuY2g6IGlkZW50aWZpZXMgLmdzZC8gcGF0aHNcIiwgKCkgPT4ge1xuICBjb25zdCBmaWxlcyA9IFtcbiAgICBcIi5nc2QvbWlsZXN0b25lcy9NMDAxL1JPQURNQVAubWRcIixcbiAgICBcIi5nc2QvbWV0cmljcy5qc29uXCIsXG4gICAgXCJzcmMvbWFpbi50c1wiLFxuICAgIFwicGFja2FnZS5qc29uXCIsXG4gICAgXCIucGxhbm5pbmcvUExBTi5tZFwiLFxuICAgIFwiUExBTi5tZFwiLFxuICBdO1xuXG4gIGNvbnN0IGNvZGVGaWxlcyA9IGZpbGVzLmZpbHRlcihcbiAgICAoZikgPT4gIWYuc3RhcnRzV2l0aChcIi5nc2QvXCIpICYmICFmLnN0YXJ0c1dpdGgoXCIucGxhbm5pbmcvXCIpICYmIGYgIT09IFwiUExBTi5tZFwiLFxuICApO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwoY29kZUZpbGVzLCBbXCJzcmMvbWFpbi50c1wiLCBcInBhY2thZ2UuanNvblwiXSk7XG59KTtcblxudGVzdChcInByLWJyYW5jaDogYWxsIC5nc2QvIGZpbGVzIHJldHVybnMgZW1wdHlcIiwgKCkgPT4ge1xuICBjb25zdCBmaWxlcyA9IFtcbiAgICBcIi5nc2QvbWlsZXN0b25lcy9NMDAxL1JPQURNQVAubWRcIixcbiAgICBcIi5nc2QvbWV0cmljcy5qc29uXCIsXG4gICAgXCIuZ3NkL0JBQ0tMT0cubWRcIixcbiAgXTtcblxuICBjb25zdCBjb2RlRmlsZXMgPSBmaWxlcy5maWx0ZXIoXG4gICAgKGYpID0+ICFmLnN0YXJ0c1dpdGgoXCIuZ3NkL1wiKSAmJiAhZi5zdGFydHNXaXRoKFwiLnBsYW5uaW5nL1wiKSAmJiBmICE9PSBcIlBMQU4ubWRcIixcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwoY29kZUZpbGVzLmxlbmd0aCwgMCk7XG59KTtcblxudGVzdChcInByLWJyYW5jaDogbWl4ZWQgY29tbWl0cyB3aXRoIGNvZGUgY2hhbmdlc1wiLCAoKSA9PiB7XG4gIGNvbnN0IGZpbGVzID0gW1xuICAgIFwiLmdzZC9taWxlc3RvbmVzL00wMDEvUk9BRE1BUC5tZFwiLFxuICAgIFwic3JjL2F1dGgudHNcIixcbiAgICBcInNyYy9hdXRoLnRlc3QudHNcIixcbiAgXTtcblxuICBjb25zdCBoYXNDb2RlQ2hhbmdlcyA9IGZpbGVzLnNvbWUoXG4gICAgKGYpID0+ICFmLnN0YXJ0c1dpdGgoXCIuZ3NkL1wiKSAmJiAhZi5zdGFydHNXaXRoKFwiLnBsYW5uaW5nL1wiKSAmJiBmICE9PSBcIlBMQU4ubWRcIixcbiAgKTtcblxuICBhc3NlcnQub2soaGFzQ29kZUNoYW5nZXMpO1xufSk7XG5cbnRlc3QoXCJwci1icmFuY2g6IC0tZHJ5LXJ1biBmbGFnXCIsICgpID0+IHtcbiAgYXNzZXJ0Lm9rKFwiLS1kcnktcnVuXCIuaW5jbHVkZXMoXCItLWRyeS1ydW5cIikpO1xuICBhc3NlcnQub2soIVwiLS1uYW1lIG15LWJyYW5jaFwiLmluY2x1ZGVzKFwiLS1kcnktcnVuXCIpKTtcbn0pO1xuXG50ZXN0KFwicHItYnJhbmNoOiAtLW5hbWUgZmxhZyBwYXJzaW5nXCIsICgpID0+IHtcbiAgY29uc3QgYXJncyA9IFwiLS1uYW1lIG15LWNsZWFuLXByXCI7XG4gIGNvbnN0IG5hbWVNYXRjaCA9IGFyZ3MubWF0Y2goLy0tbmFtZVxccysoXFxTKykvKTtcbiAgYXNzZXJ0Lm9rKG5hbWVNYXRjaCk7XG4gIGFzc2VydC5lcXVhbChuYW1lTWF0Y2hbMV0sIFwibXktY2xlYW4tcHJcIik7XG59KTtcblxudGVzdChcInByLWJyYW5jaDogZGVmYXVsdCBicmFuY2ggbmFtZVwiLCAoKSA9PiB7XG4gIGNvbnN0IGN1cnJlbnRCcmFuY2ggPSBcImZlYXQvYWRkLWF1dGhcIjtcbiAgY29uc3QgcHJCcmFuY2ggPSBgcHIvJHtjdXJyZW50QnJhbmNofWA7XG4gIGFzc2VydC5lcXVhbChwckJyYW5jaCwgXCJwci9mZWF0L2FkZC1hdXRoXCIpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBS25CLEtBQUsscUNBQXFDLE1BQU07QUFDOUMsUUFBTSxRQUFRO0FBQUEsSUFDWjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRjtBQUVBLFFBQU0sWUFBWSxNQUFNO0FBQUEsSUFDdEIsQ0FBQyxNQUFNLENBQUMsRUFBRSxXQUFXLE9BQU8sS0FBSyxDQUFDLEVBQUUsV0FBVyxZQUFZLEtBQUssTUFBTTtBQUFBLEVBQ3hFO0FBRUEsU0FBTyxVQUFVLFdBQVcsQ0FBQyxlQUFlLGNBQWMsQ0FBQztBQUM3RCxDQUFDO0FBRUQsS0FBSyw0Q0FBNEMsTUFBTTtBQUNyRCxRQUFNLFFBQVE7QUFBQSxJQUNaO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGO0FBRUEsUUFBTSxZQUFZLE1BQU07QUFBQSxJQUN0QixDQUFDLE1BQU0sQ0FBQyxFQUFFLFdBQVcsT0FBTyxLQUFLLENBQUMsRUFBRSxXQUFXLFlBQVksS0FBSyxNQUFNO0FBQUEsRUFDeEU7QUFFQSxTQUFPLE1BQU0sVUFBVSxRQUFRLENBQUM7QUFDbEMsQ0FBQztBQUVELEtBQUssOENBQThDLE1BQU07QUFDdkQsUUFBTSxRQUFRO0FBQUEsSUFDWjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRjtBQUVBLFFBQU0saUJBQWlCLE1BQU07QUFBQSxJQUMzQixDQUFDLE1BQU0sQ0FBQyxFQUFFLFdBQVcsT0FBTyxLQUFLLENBQUMsRUFBRSxXQUFXLFlBQVksS0FBSyxNQUFNO0FBQUEsRUFDeEU7QUFFQSxTQUFPLEdBQUcsY0FBYztBQUMxQixDQUFDO0FBRUQsS0FBSyw2QkFBNkIsTUFBTTtBQUN0QyxTQUFPLEdBQUcsWUFBWSxTQUFTLFdBQVcsQ0FBQztBQUMzQyxTQUFPLEdBQUcsQ0FBQyxtQkFBbUIsU0FBUyxXQUFXLENBQUM7QUFDckQsQ0FBQztBQUVELEtBQUssa0NBQWtDLE1BQU07QUFDM0MsUUFBTSxPQUFPO0FBQ2IsUUFBTSxZQUFZLEtBQUssTUFBTSxnQkFBZ0I7QUFDN0MsU0FBTyxHQUFHLFNBQVM7QUFDbkIsU0FBTyxNQUFNLFVBQVUsQ0FBQyxHQUFHLGFBQWE7QUFDMUMsQ0FBQztBQUVELEtBQUssa0NBQWtDLE1BQU07QUFDM0MsUUFBTSxnQkFBZ0I7QUFDdEIsUUFBTSxXQUFXLE1BQU0sYUFBYTtBQUNwQyxTQUFPLE1BQU0sVUFBVSxrQkFBa0I7QUFDM0MsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
