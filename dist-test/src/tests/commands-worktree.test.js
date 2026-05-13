import test from "node:test";
import assert from "node:assert/strict";
import {
  formatWorktreeList
} from "../../dist/resources/extensions/gsd/commands-worktree.js";
function mkStatus(over) {
  const name = over.name ?? "feat-x";
  return {
    name,
    path: `/repo/.gsd/worktrees/${name}`,
    branch: `gsd/${name}`,
    exists: true,
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    uncommitted: false,
    commits: 0,
    ...over
  };
}
test("empty list shows hint to create one", () => {
  const out = formatWorktreeList([]);
  assert.match(out, /No worktrees\./);
  assert.match(out, /gsd -w/);
});
test("clean worktree shows (clean) badge and no diff line", () => {
  const out = formatWorktreeList([mkStatus({ name: "alpha" })]);
  assert.match(out, /alpha \(clean\)/);
  assert.match(out, /branch\s+gsd\/alpha/);
  assert.match(out, /path\s+\/repo\/\.gsd/);
  assert.doesNotMatch(out, /diff\s+/);
});
test("uncommitted worktree shows (uncommitted) badge", () => {
  const out = formatWorktreeList([mkStatus({ name: "wip", uncommitted: true })]);
  assert.match(out, /wip \(uncommitted\)/);
});
test("unmerged worktree shows (unmerged) badge with diff stats", () => {
  const out = formatWorktreeList([
    mkStatus({
      name: "feature-y",
      filesChanged: 3,
      linesAdded: 42,
      linesRemoved: 7,
      commits: 2
    })
  ]);
  assert.match(out, /feature-y \(unmerged\)/);
  assert.match(out, /\bdiff\s+3 files, \+42 -7, 2 commits\b/);
});
test("singular file/commit pluralization", () => {
  const out = formatWorktreeList([
    mkStatus({
      name: "single",
      filesChanged: 1,
      linesAdded: 1,
      linesRemoved: 0,
      commits: 1
    })
  ]);
  assert.match(out, /\bdiff\s+1 file, \+1 -0, 1 commit\b/);
});
test("count header matches number of worktrees", () => {
  const out = formatWorktreeList([
    mkStatus({ name: "a" }),
    mkStatus({ name: "b" }),
    mkStatus({ name: "c" })
  ]);
  assert.match(out, /Worktrees — 3/);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL2NvbW1hbmRzLXdvcmt0cmVlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yIFx1MjAxNCBVbml0IHRlc3RzIGZvciAvZ3NkIHdvcmt0cmVlIGZvcm1hdHRlciBhbmQgZGlzcGF0Y2hlclxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbmltcG9ydCB7XG4gIGZvcm1hdFdvcmt0cmVlTGlzdCxcbiAgdHlwZSBXb3JrdHJlZVN0YXR1cyxcbn0gZnJvbSBcIi4uLy4uL2Rpc3QvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2NvbW1hbmRzLXdvcmt0cmVlLmpzXCI7XG5cbmZ1bmN0aW9uIG1rU3RhdHVzKG92ZXI6IFBhcnRpYWw8V29ya3RyZWVTdGF0dXM+KTogV29ya3RyZWVTdGF0dXMge1xuICBjb25zdCBuYW1lID0gb3Zlci5uYW1lID8/IFwiZmVhdC14XCI7XG4gIHJldHVybiB7XG4gICAgbmFtZSxcbiAgICBwYXRoOiBgL3JlcG8vLmdzZC93b3JrdHJlZXMvJHtuYW1lfWAsXG4gICAgYnJhbmNoOiBgZ3NkLyR7bmFtZX1gLFxuICAgIGV4aXN0czogdHJ1ZSxcbiAgICBmaWxlc0NoYW5nZWQ6IDAsXG4gICAgbGluZXNBZGRlZDogMCxcbiAgICBsaW5lc1JlbW92ZWQ6IDAsXG4gICAgdW5jb21taXR0ZWQ6IGZhbHNlLFxuICAgIGNvbW1pdHM6IDAsXG4gICAgLi4ub3ZlcixcbiAgfTtcbn1cblxudGVzdChcImVtcHR5IGxpc3Qgc2hvd3MgaGludCB0byBjcmVhdGUgb25lXCIsICgpID0+IHtcbiAgY29uc3Qgb3V0ID0gZm9ybWF0V29ya3RyZWVMaXN0KFtdKTtcbiAgYXNzZXJ0Lm1hdGNoKG91dCwgL05vIHdvcmt0cmVlc1xcLi8pO1xuICBhc3NlcnQubWF0Y2gob3V0LCAvZ3NkIC13Lyk7XG59KTtcblxudGVzdChcImNsZWFuIHdvcmt0cmVlIHNob3dzIChjbGVhbikgYmFkZ2UgYW5kIG5vIGRpZmYgbGluZVwiLCAoKSA9PiB7XG4gIGNvbnN0IG91dCA9IGZvcm1hdFdvcmt0cmVlTGlzdChbbWtTdGF0dXMoeyBuYW1lOiBcImFscGhhXCIgfSldKTtcbiAgYXNzZXJ0Lm1hdGNoKG91dCwgL2FscGhhIFxcKGNsZWFuXFwpLyk7XG4gIGFzc2VydC5tYXRjaChvdXQsIC9icmFuY2hcXHMrZ3NkXFwvYWxwaGEvKTtcbiAgYXNzZXJ0Lm1hdGNoKG91dCwgL3BhdGhcXHMrXFwvcmVwb1xcL1xcLmdzZC8pO1xuICBhc3NlcnQuZG9lc05vdE1hdGNoKG91dCwgL2RpZmZcXHMrLyk7XG59KTtcblxudGVzdChcInVuY29tbWl0dGVkIHdvcmt0cmVlIHNob3dzICh1bmNvbW1pdHRlZCkgYmFkZ2VcIiwgKCkgPT4ge1xuICBjb25zdCBvdXQgPSBmb3JtYXRXb3JrdHJlZUxpc3QoW21rU3RhdHVzKHsgbmFtZTogXCJ3aXBcIiwgdW5jb21taXR0ZWQ6IHRydWUgfSldKTtcbiAgYXNzZXJ0Lm1hdGNoKG91dCwgL3dpcCBcXCh1bmNvbW1pdHRlZFxcKS8pO1xufSk7XG5cbnRlc3QoXCJ1bm1lcmdlZCB3b3JrdHJlZSBzaG93cyAodW5tZXJnZWQpIGJhZGdlIHdpdGggZGlmZiBzdGF0c1wiLCAoKSA9PiB7XG4gIGNvbnN0IG91dCA9IGZvcm1hdFdvcmt0cmVlTGlzdChbXG4gICAgbWtTdGF0dXMoe1xuICAgICAgbmFtZTogXCJmZWF0dXJlLXlcIixcbiAgICAgIGZpbGVzQ2hhbmdlZDogMyxcbiAgICAgIGxpbmVzQWRkZWQ6IDQyLFxuICAgICAgbGluZXNSZW1vdmVkOiA3LFxuICAgICAgY29tbWl0czogMixcbiAgICB9KSxcbiAgXSk7XG4gIGFzc2VydC5tYXRjaChvdXQsIC9mZWF0dXJlLXkgXFwodW5tZXJnZWRcXCkvKTtcbiAgYXNzZXJ0Lm1hdGNoKG91dCwgL1xcYmRpZmZcXHMrMyBmaWxlcywgXFwrNDIgLTcsIDIgY29tbWl0c1xcYi8pO1xufSk7XG5cbnRlc3QoXCJzaW5ndWxhciBmaWxlL2NvbW1pdCBwbHVyYWxpemF0aW9uXCIsICgpID0+IHtcbiAgY29uc3Qgb3V0ID0gZm9ybWF0V29ya3RyZWVMaXN0KFtcbiAgICBta1N0YXR1cyh7XG4gICAgICBuYW1lOiBcInNpbmdsZVwiLFxuICAgICAgZmlsZXNDaGFuZ2VkOiAxLFxuICAgICAgbGluZXNBZGRlZDogMSxcbiAgICAgIGxpbmVzUmVtb3ZlZDogMCxcbiAgICAgIGNvbW1pdHM6IDEsXG4gICAgfSksXG4gIF0pO1xuICBhc3NlcnQubWF0Y2gob3V0LCAvXFxiZGlmZlxccysxIGZpbGUsIFxcKzEgLTAsIDEgY29tbWl0XFxiLyk7XG59KTtcblxudGVzdChcImNvdW50IGhlYWRlciBtYXRjaGVzIG51bWJlciBvZiB3b3JrdHJlZXNcIiwgKCkgPT4ge1xuICBjb25zdCBvdXQgPSBmb3JtYXRXb3JrdHJlZUxpc3QoW1xuICAgIG1rU3RhdHVzKHsgbmFtZTogXCJhXCIgfSksXG4gICAgbWtTdGF0dXMoeyBuYW1lOiBcImJcIiB9KSxcbiAgICBta1N0YXR1cyh7IG5hbWU6IFwiY1wiIH0pLFxuICBdKTtcbiAgYXNzZXJ0Lm1hdGNoKG91dCwgL1dvcmt0cmVlcyBcdTIwMTQgMy8pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBRW5CO0FBQUEsRUFDRTtBQUFBLE9BRUs7QUFFUCxTQUFTLFNBQVMsTUFBK0M7QUFDL0QsUUFBTSxPQUFPLEtBQUssUUFBUTtBQUMxQixTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0EsTUFBTSx3QkFBd0IsSUFBSTtBQUFBLElBQ2xDLFFBQVEsT0FBTyxJQUFJO0FBQUEsSUFDbkIsUUFBUTtBQUFBLElBQ1IsY0FBYztBQUFBLElBQ2QsWUFBWTtBQUFBLElBQ1osY0FBYztBQUFBLElBQ2QsYUFBYTtBQUFBLElBQ2IsU0FBUztBQUFBLElBQ1QsR0FBRztBQUFBLEVBQ0w7QUFDRjtBQUVBLEtBQUssdUNBQXVDLE1BQU07QUFDaEQsUUFBTSxNQUFNLG1CQUFtQixDQUFDLENBQUM7QUFDakMsU0FBTyxNQUFNLEtBQUssZ0JBQWdCO0FBQ2xDLFNBQU8sTUFBTSxLQUFLLFFBQVE7QUFDNUIsQ0FBQztBQUVELEtBQUssdURBQXVELE1BQU07QUFDaEUsUUFBTSxNQUFNLG1CQUFtQixDQUFDLFNBQVMsRUFBRSxNQUFNLFFBQVEsQ0FBQyxDQUFDLENBQUM7QUFDNUQsU0FBTyxNQUFNLEtBQUssaUJBQWlCO0FBQ25DLFNBQU8sTUFBTSxLQUFLLHFCQUFxQjtBQUN2QyxTQUFPLE1BQU0sS0FBSyxzQkFBc0I7QUFDeEMsU0FBTyxhQUFhLEtBQUssU0FBUztBQUNwQyxDQUFDO0FBRUQsS0FBSyxrREFBa0QsTUFBTTtBQUMzRCxRQUFNLE1BQU0sbUJBQW1CLENBQUMsU0FBUyxFQUFFLE1BQU0sT0FBTyxhQUFhLEtBQUssQ0FBQyxDQUFDLENBQUM7QUFDN0UsU0FBTyxNQUFNLEtBQUsscUJBQXFCO0FBQ3pDLENBQUM7QUFFRCxLQUFLLDREQUE0RCxNQUFNO0FBQ3JFLFFBQU0sTUFBTSxtQkFBbUI7QUFBQSxJQUM3QixTQUFTO0FBQUEsTUFDUCxNQUFNO0FBQUEsTUFDTixjQUFjO0FBQUEsTUFDZCxZQUFZO0FBQUEsTUFDWixjQUFjO0FBQUEsTUFDZCxTQUFTO0FBQUEsSUFDWCxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBQ0QsU0FBTyxNQUFNLEtBQUssd0JBQXdCO0FBQzFDLFNBQU8sTUFBTSxLQUFLLHdDQUF3QztBQUM1RCxDQUFDO0FBRUQsS0FBSyxzQ0FBc0MsTUFBTTtBQUMvQyxRQUFNLE1BQU0sbUJBQW1CO0FBQUEsSUFDN0IsU0FBUztBQUFBLE1BQ1AsTUFBTTtBQUFBLE1BQ04sY0FBYztBQUFBLE1BQ2QsWUFBWTtBQUFBLE1BQ1osY0FBYztBQUFBLE1BQ2QsU0FBUztBQUFBLElBQ1gsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUNELFNBQU8sTUFBTSxLQUFLLHFDQUFxQztBQUN6RCxDQUFDO0FBRUQsS0FBSyw0Q0FBNEMsTUFBTTtBQUNyRCxRQUFNLE1BQU0sbUJBQW1CO0FBQUEsSUFDN0IsU0FBUyxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBQUEsSUFDdEIsU0FBUyxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBQUEsSUFDdEIsU0FBUyxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBQUEsRUFDeEIsQ0FBQztBQUNELFNBQU8sTUFBTSxLQUFLLGVBQWU7QUFDbkMsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
