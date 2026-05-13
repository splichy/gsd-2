import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectAndApplyModel } from "../auto-model-selection.js";
test("selectAndApplyModel restores captured thinking level after model selection", async (t) => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-thinking-restore-"));
  const thinkingLevels = [];
  t.after(() => {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    ["---", "models:", "  planning: anthropic/claude-sonnet-4-6", "---"].join("\n"),
    "utf-8"
  );
  process.chdir(base);
  const result = await selectAndApplyModel(
    {
      modelRegistry: { getAvailable: () => [{ id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" }] },
      sessionManager: { getSessionId: () => "thinking-test" },
      ui: { notify: () => {
      } },
      model: { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" }
    },
    {
      setModel: async () => true,
      setThinkingLevel: (level) => {
        thinkingLevels.push(level);
      },
      emitBeforeModelSelect: async () => void 0,
      getActiveTools: () => [],
      emitAdjustToolSet: async () => void 0,
      setActiveTools: () => {
      }
    },
    "plan-slice",
    "M001/S01",
    base,
    void 0,
    false,
    { provider: "anthropic", id: "claude-sonnet-4-6" },
    void 0,
    true,
    void 0,
    { effort: "medium" }
  );
  assert.equal(result.appliedModel?.provider, "anthropic");
  assert.deepEqual(thinkingLevels, [{ effort: "medium" }]);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLXRoaW5raW5nLXJlc3RvcmUudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7IHNlbGVjdEFuZEFwcGx5TW9kZWwgfSBmcm9tIFwiLi4vYXV0by1tb2RlbC1zZWxlY3Rpb24udHNcIjtcblxudGVzdChcInNlbGVjdEFuZEFwcGx5TW9kZWwgcmVzdG9yZXMgY2FwdHVyZWQgdGhpbmtpbmcgbGV2ZWwgYWZ0ZXIgbW9kZWwgc2VsZWN0aW9uXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IG9yaWdpbmFsQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXRoaW5raW5nLXJlc3RvcmUtXCIpKTtcbiAgY29uc3QgdGhpbmtpbmdMZXZlbHM6IHVua25vd25bXSA9IFtdO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpLFxuICAgIFtcIi0tLVwiLCBcIm1vZGVsczpcIiwgXCIgIHBsYW5uaW5nOiBhbnRocm9waWMvY2xhdWRlLXNvbm5ldC00LTZcIiwgXCItLS1cIl0uam9pbihcIlxcblwiKSxcbiAgICBcInV0Zi04XCIsXG4gICk7XG4gIHByb2Nlc3MuY2hkaXIoYmFzZSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc2VsZWN0QW5kQXBwbHlNb2RlbChcbiAgICB7XG4gICAgICBtb2RlbFJlZ2lzdHJ5OiB7IGdldEF2YWlsYWJsZTogKCkgPT4gW3sgaWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIiwgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9XSB9LFxuICAgICAgc2Vzc2lvbk1hbmFnZXI6IHsgZ2V0U2Vzc2lvbklkOiAoKSA9PiBcInRoaW5raW5nLXRlc3RcIiB9LFxuICAgICAgdWk6IHsgbm90aWZ5OiAoKSA9PiB7fSB9LFxuICAgICAgbW9kZWw6IHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGlkOiBcImNsYXVkZS1zb25uZXQtNC02XCIsIGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIiB9LFxuICAgIH0gYXMgYW55LFxuICAgIHtcbiAgICAgIHNldE1vZGVsOiBhc3luYyAoKSA9PiB0cnVlLFxuICAgICAgc2V0VGhpbmtpbmdMZXZlbDogKGxldmVsOiB1bmtub3duKSA9PiB7IHRoaW5raW5nTGV2ZWxzLnB1c2gobGV2ZWwpOyB9LFxuICAgICAgZW1pdEJlZm9yZU1vZGVsU2VsZWN0OiBhc3luYyAoKSA9PiB1bmRlZmluZWQsXG4gICAgICBnZXRBY3RpdmVUb29sczogKCkgPT4gW10sXG4gICAgICBlbWl0QWRqdXN0VG9vbFNldDogYXN5bmMgKCkgPT4gdW5kZWZpbmVkLFxuICAgICAgc2V0QWN0aXZlVG9vbHM6ICgpID0+IHt9LFxuICAgIH0gYXMgYW55LFxuICAgIFwicGxhbi1zbGljZVwiLFxuICAgIFwiTTAwMS9TMDFcIixcbiAgICBiYXNlLFxuICAgIHVuZGVmaW5lZCxcbiAgICBmYWxzZSxcbiAgICB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiIH0sXG4gICAgdW5kZWZpbmVkLFxuICAgIHRydWUsXG4gICAgdW5kZWZpbmVkLFxuICAgIHsgZWZmb3J0OiBcIm1lZGl1bVwiIH0gYXMgYW55LFxuICApO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYXBwbGllZE1vZGVsPy5wcm92aWRlciwgXCJhbnRocm9waWNcIik7XG4gIGFzc2VydC5kZWVwRXF1YWwodGhpbmtpbmdMZXZlbHMsIFt7IGVmZm9ydDogXCJtZWRpdW1cIiB9XSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxxQkFBcUI7QUFDOUQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLDJCQUEyQjtBQUVwQyxLQUFLLDhFQUE4RSxPQUFPLE1BQU07QUFDOUYsUUFBTSxjQUFjLFFBQVEsSUFBSTtBQUNoQyxRQUFNLE9BQU8sWUFBWSxLQUFLLE9BQU8sR0FBRyx1QkFBdUIsQ0FBQztBQUNoRSxRQUFNLGlCQUE0QixDQUFDO0FBQ25DLElBQUUsTUFBTSxNQUFNO0FBQ1osWUFBUSxNQUFNLFdBQVc7QUFDekIsV0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDL0MsQ0FBQztBQUNELFlBQVUsS0FBSyxNQUFNLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2pEO0FBQUEsSUFDRSxLQUFLLE1BQU0sUUFBUSxnQkFBZ0I7QUFBQSxJQUNuQyxDQUFDLE9BQU8sV0FBVywyQ0FBMkMsS0FBSyxFQUFFLEtBQUssSUFBSTtBQUFBLElBQzlFO0FBQUEsRUFDRjtBQUNBLFVBQVEsTUFBTSxJQUFJO0FBRWxCLFFBQU0sU0FBUyxNQUFNO0FBQUEsSUFDbkI7QUFBQSxNQUNFLGVBQWUsRUFBRSxjQUFjLE1BQU0sQ0FBQyxFQUFFLElBQUkscUJBQXFCLFVBQVUsYUFBYSxLQUFLLHFCQUFxQixDQUFDLEVBQUU7QUFBQSxNQUNySCxnQkFBZ0IsRUFBRSxjQUFjLE1BQU0sZ0JBQWdCO0FBQUEsTUFDdEQsSUFBSSxFQUFFLFFBQVEsTUFBTTtBQUFBLE1BQUMsRUFBRTtBQUFBLE1BQ3ZCLE9BQU8sRUFBRSxVQUFVLGFBQWEsSUFBSSxxQkFBcUIsS0FBSyxxQkFBcUI7QUFBQSxJQUNyRjtBQUFBLElBQ0E7QUFBQSxNQUNFLFVBQVUsWUFBWTtBQUFBLE1BQ3RCLGtCQUFrQixDQUFDLFVBQW1CO0FBQUUsdUJBQWUsS0FBSyxLQUFLO0FBQUEsTUFBRztBQUFBLE1BQ3BFLHVCQUF1QixZQUFZO0FBQUEsTUFDbkMsZ0JBQWdCLE1BQU0sQ0FBQztBQUFBLE1BQ3ZCLG1CQUFtQixZQUFZO0FBQUEsTUFDL0IsZ0JBQWdCLE1BQU07QUFBQSxNQUFDO0FBQUEsSUFDekI7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsRUFBRSxVQUFVLGFBQWEsSUFBSSxvQkFBb0I7QUFBQSxJQUNqRDtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxFQUFFLFFBQVEsU0FBUztBQUFBLEVBQ3JCO0FBRUEsU0FBTyxNQUFNLE9BQU8sY0FBYyxVQUFVLFdBQVc7QUFDdkQsU0FBTyxVQUFVLGdCQUFnQixDQUFDLEVBQUUsUUFBUSxTQUFTLENBQUMsQ0FBQztBQUN6RCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
