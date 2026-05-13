import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSuggestedNextCommands, indexWorkspace, listDoctorScopeSuggestions } from "../workspace-index.js";
test("workspace index: indexes active milestone/slice/task and suggests commands", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-workspace-index-test-"));
  const gsd = join(base, ".gsd");
  const mDir = join(gsd, "milestones", "M001");
  const sDir = join(mDir, "slices", "S01");
  mkdirSync(join(sDir, "tasks"), { recursive: true });
  writeFileSync(join(mDir, "M001-ROADMAP.md"), `# M001: Demo Milestone

## Slices
- [ ] **S01: Demo Slice** \`risk:low\` \`depends:[]\`
  > After this: demo works
`);
  writeFileSync(join(sDir, "S01-PLAN.md"), `# S01: Demo Slice

**Goal:** Demo
**Demo:** Demo

## Must-Haves
- done

## Tasks
- [ ] **T01: Implement thing** \`est:10m\`
  Task is in progress.
`);
  writeFileSync(join(sDir, "tasks", "T01-PLAN.md"), `# T01: Implement thing

## Steps
- do it
`);
  try {
    const index = await indexWorkspace(base);
    assert.equal(index.active.milestoneId, "M001");
    assert.equal(index.active.sliceId, "S01");
    assert.equal(index.active.taskId, "T01");
    assert.ok(index.scopes.some((s) => s.scope === "M001/S01"));
    assert.ok(index.scopes.some((s) => s.scope === "M001/S01/T01"));
    const suggestions = await listDoctorScopeSuggestions(base);
    assert.equal(suggestions[0].value, "M001/S01");
    assert.ok(suggestions.some((item) => item.value === "M001/S01/T01"));
    const commands = await getSuggestedNextCommands(base);
    assert.ok(commands.includes("/gsd auto"));
    assert.ok(commands.includes("/gsd doctor M001/S01"));
    assert.ok(commands.includes("/gsd status"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3Jrc3BhY2UtaW5kZXgudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBnZXRTdWdnZXN0ZWROZXh0Q29tbWFuZHMsIGluZGV4V29ya3NwYWNlLCBsaXN0RG9jdG9yU2NvcGVTdWdnZXN0aW9ucyB9IGZyb20gXCIuLi93b3Jrc3BhY2UtaW5kZXgudHNcIjtcblxudGVzdChcIndvcmtzcGFjZSBpbmRleDogaW5kZXhlcyBhY3RpdmUgbWlsZXN0b25lL3NsaWNlL3Rhc2sgYW5kIHN1Z2dlc3RzIGNvbW1hbmRzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXdvcmtzcGFjZS1pbmRleC10ZXN0LVwiKSk7XG4gIGNvbnN0IGdzZCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIpO1xuICBjb25zdCBtRGlyID0gam9pbihnc2QsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIik7XG4gIGNvbnN0IHNEaXIgPSBqb2luKG1EaXIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICBta2RpclN5bmMoam9pbihzRGlyLCBcInRhc2tzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICB3cml0ZUZpbGVTeW5jKGpvaW4obURpciwgXCJNMDAxLVJPQURNQVAubWRcIiksIGAjIE0wMDE6IERlbW8gTWlsZXN0b25lXFxuXFxuIyMgU2xpY2VzXFxuLSBbIF0gKipTMDE6IERlbW8gU2xpY2UqKiBcXGByaXNrOmxvd1xcYCBcXGBkZXBlbmRzOltdXFxgXFxuICA+IEFmdGVyIHRoaXM6IGRlbW8gd29ya3NcXG5gKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHNEaXIsIFwiUzAxLVBMQU4ubWRcIiksIGAjIFMwMTogRGVtbyBTbGljZVxcblxcbioqR29hbDoqKiBEZW1vXFxuKipEZW1vOioqIERlbW9cXG5cXG4jIyBNdXN0LUhhdmVzXFxuLSBkb25lXFxuXFxuIyMgVGFza3NcXG4tIFsgXSAqKlQwMTogSW1wbGVtZW50IHRoaW5nKiogXFxgZXN0OjEwbVxcYFxcbiAgVGFzayBpcyBpbiBwcm9ncmVzcy5cXG5gKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHNEaXIsIFwidGFza3NcIiwgXCJUMDEtUExBTi5tZFwiKSwgYCMgVDAxOiBJbXBsZW1lbnQgdGhpbmdcXG5cXG4jIyBTdGVwc1xcbi0gZG8gaXRcXG5gKTtcblxuICB0cnkge1xuICAgIGNvbnN0IGluZGV4ID0gYXdhaXQgaW5kZXhXb3Jrc3BhY2UoYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGluZGV4LmFjdGl2ZS5taWxlc3RvbmVJZCwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChpbmRleC5hY3RpdmUuc2xpY2VJZCwgXCJTMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGluZGV4LmFjdGl2ZS50YXNrSWQsIFwiVDAxXCIpO1xuICAgIGFzc2VydC5vayhpbmRleC5zY29wZXMuc29tZShzID0+IHMuc2NvcGUgPT09IFwiTTAwMS9TMDFcIikpO1xuICAgIGFzc2VydC5vayhpbmRleC5zY29wZXMuc29tZShzID0+IHMuc2NvcGUgPT09IFwiTTAwMS9TMDEvVDAxXCIpKTtcblxuICAgIGNvbnN0IHN1Z2dlc3Rpb25zID0gYXdhaXQgbGlzdERvY3RvclNjb3BlU3VnZ2VzdGlvbnMoYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHN1Z2dlc3Rpb25zWzBdLnZhbHVlLCBcIk0wMDEvUzAxXCIpO1xuICAgIGFzc2VydC5vayhzdWdnZXN0aW9ucy5zb21lKGl0ZW0gPT4gaXRlbS52YWx1ZSA9PT0gXCJNMDAxL1MwMS9UMDFcIikpO1xuXG4gICAgY29uc3QgY29tbWFuZHMgPSBhd2FpdCBnZXRTdWdnZXN0ZWROZXh0Q29tbWFuZHMoYmFzZSk7XG4gICAgYXNzZXJ0Lm9rKGNvbW1hbmRzLmluY2x1ZGVzKFwiL2dzZCBhdXRvXCIpKTtcbiAgICBhc3NlcnQub2soY29tbWFuZHMuaW5jbHVkZXMoXCIvZ3NkIGRvY3RvciBNMDAxL1MwMVwiKSk7XG4gICAgYXNzZXJ0Lm9rKGNvbW1hbmRzLmluY2x1ZGVzKFwiL2dzZCBzdGF0dXNcIikpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsV0FBVyxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLFlBQVk7QUFDckIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsMEJBQTBCLGdCQUFnQixrQ0FBa0M7QUFFckYsS0FBSyw4RUFBOEUsWUFBWTtBQUM3RixRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRywyQkFBMkIsQ0FBQztBQUNwRSxRQUFNLE1BQU0sS0FBSyxNQUFNLE1BQU07QUFDN0IsUUFBTSxPQUFPLEtBQUssS0FBSyxjQUFjLE1BQU07QUFDM0MsUUFBTSxPQUFPLEtBQUssTUFBTSxVQUFVLEtBQUs7QUFDdkMsWUFBVSxLQUFLLE1BQU0sT0FBTyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFFbEQsZ0JBQWMsS0FBSyxNQUFNLGlCQUFpQixHQUFHO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxDQUEwSDtBQUN2SyxnQkFBYyxLQUFLLE1BQU0sYUFBYSxHQUFHO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxDQUFnSztBQUN6TSxnQkFBYyxLQUFLLE1BQU0sU0FBUyxhQUFhLEdBQUc7QUFBQTtBQUFBO0FBQUE7QUFBQSxDQUErQztBQUVqRyxNQUFJO0FBQ0YsVUFBTSxRQUFRLE1BQU0sZUFBZSxJQUFJO0FBQ3ZDLFdBQU8sTUFBTSxNQUFNLE9BQU8sYUFBYSxNQUFNO0FBQzdDLFdBQU8sTUFBTSxNQUFNLE9BQU8sU0FBUyxLQUFLO0FBQ3hDLFdBQU8sTUFBTSxNQUFNLE9BQU8sUUFBUSxLQUFLO0FBQ3ZDLFdBQU8sR0FBRyxNQUFNLE9BQU8sS0FBSyxPQUFLLEVBQUUsVUFBVSxVQUFVLENBQUM7QUFDeEQsV0FBTyxHQUFHLE1BQU0sT0FBTyxLQUFLLE9BQUssRUFBRSxVQUFVLGNBQWMsQ0FBQztBQUU1RCxVQUFNLGNBQWMsTUFBTSwyQkFBMkIsSUFBSTtBQUN6RCxXQUFPLE1BQU0sWUFBWSxDQUFDLEVBQUUsT0FBTyxVQUFVO0FBQzdDLFdBQU8sR0FBRyxZQUFZLEtBQUssVUFBUSxLQUFLLFVBQVUsY0FBYyxDQUFDO0FBRWpFLFVBQU0sV0FBVyxNQUFNLHlCQUF5QixJQUFJO0FBQ3BELFdBQU8sR0FBRyxTQUFTLFNBQVMsV0FBVyxDQUFDO0FBQ3hDLFdBQU8sR0FBRyxTQUFTLFNBQVMsc0JBQXNCLENBQUM7QUFDbkQsV0FBTyxHQUFHLFNBQVMsU0FBUyxhQUFhLENBQUM7QUFBQSxFQUM1QyxVQUFFO0FBQ0EsV0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDL0M7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
