import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerDbTools } from "../bootstrap/db-tools.js";
import {
  closeDatabase,
  getSlice,
  insertMilestone,
  insertSlice,
  openDatabase
} from "../gsd-db.js";
test("gsd_skip_slice marks a slice skipped and refreshes STATE.md", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-skip-slice-"));
  const tools = /* @__PURE__ */ new Map();
  const pi = { registerTool: (tool) => tools.set(tool.name, tool) };
  try {
    mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Skip Test", status: "active", depends_on: [] });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Skipped slice",
      status: "pending",
      risk: "low",
      depends: [],
      demo: "",
      sequence: 1
    });
    registerDbTools(pi);
    const skipSlice = tools.get("gsd_skip_slice");
    assert.ok(skipSlice, "gsd_skip_slice is registered");
    const result = await skipSlice.execute(
      "tool-call",
      { milestoneId: "M001", sliceId: "S01", reason: "descoped" },
      void 0,
      void 0,
      { cwd: base }
    );
    assert.equal(result.details.operation, "skip_slice");
    assert.equal(getSlice("M001", "S01")?.status, "skipped");
    const statePath = join(base, ".gsd", "STATE.md");
    assert.equal(existsSync(statePath), true, "STATE.md should be rebuilt");
    assert.match(readFileSync(statePath, "utf-8"), /Active Slice:\*\* None/);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9za2lwLXNsaWNlLXN0YXRlLXJlYnVpbGQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSZWdyZXNzaW9uIHRlc3QgZm9yICMzNDc3OiBnc2Rfc2tpcF9zbGljZSB1cGRhdGVzIERCIHN0YXRlIGFuZCByZWJ1aWxkc1xuICogdGhlIHByb2plY3RlZCBTVEFURS5tZCBhcnRpZmFjdC5cbiAqL1xuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyByZWdpc3RlckRiVG9vbHMgfSBmcm9tIFwiLi4vYm9vdHN0cmFwL2RiLXRvb2xzLnRzXCI7XG5pbXBvcnQge1xuICBjbG9zZURhdGFiYXNlLFxuICBnZXRTbGljZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBpbnNlcnRTbGljZSxcbiAgb3BlbkRhdGFiYXNlLFxufSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5cbnRlc3QoXCJnc2Rfc2tpcF9zbGljZSBtYXJrcyBhIHNsaWNlIHNraXBwZWQgYW5kIHJlZnJlc2hlcyBTVEFURS5tZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1za2lwLXNsaWNlLVwiKSk7XG4gIGNvbnN0IHRvb2xzID0gbmV3IE1hcDxzdHJpbmcsIGFueT4oKTtcbiAgY29uc3QgcGkgPSB7IHJlZ2lzdGVyVG9vbDogKHRvb2w6IGFueSkgPT4gdG9vbHMuc2V0KHRvb2wubmFtZSwgdG9vbCkgfTtcblxuICB0cnkge1xuICAgIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiU2tpcCBUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiwgZGVwZW5kc19vbjogW10gfSk7XG4gICAgaW5zZXJ0U2xpY2Uoe1xuICAgICAgaWQ6IFwiUzAxXCIsXG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICB0aXRsZTogXCJTa2lwcGVkIHNsaWNlXCIsXG4gICAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgICAgcmlzazogXCJsb3dcIixcbiAgICAgIGRlcGVuZHM6IFtdLFxuICAgICAgZGVtbzogXCJcIixcbiAgICAgIHNlcXVlbmNlOiAxLFxuICAgIH0pO1xuXG4gICAgcmVnaXN0ZXJEYlRvb2xzKHBpIGFzIGFueSk7XG4gICAgY29uc3Qgc2tpcFNsaWNlID0gdG9vbHMuZ2V0KFwiZ3NkX3NraXBfc2xpY2VcIik7XG4gICAgYXNzZXJ0Lm9rKHNraXBTbGljZSwgXCJnc2Rfc2tpcF9zbGljZSBpcyByZWdpc3RlcmVkXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc2tpcFNsaWNlLmV4ZWN1dGUoXG4gICAgICBcInRvb2wtY2FsbFwiLFxuICAgICAgeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIHJlYXNvbjogXCJkZXNjb3BlZFwiIH0sXG4gICAgICB1bmRlZmluZWQsXG4gICAgICB1bmRlZmluZWQsXG4gICAgICB7IGN3ZDogYmFzZSB9LFxuICAgICk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmRldGFpbHMub3BlcmF0aW9uLCBcInNraXBfc2xpY2VcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGdldFNsaWNlKFwiTTAwMVwiLCBcIlMwMVwiKT8uc3RhdHVzLCBcInNraXBwZWRcIik7XG5cbiAgICBjb25zdCBzdGF0ZVBhdGggPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIlNUQVRFLm1kXCIpO1xuICAgIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKHN0YXRlUGF0aCksIHRydWUsIFwiU1RBVEUubWQgc2hvdWxkIGJlIHJlYnVpbHRcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlYWRGaWxlU3luYyhzdGF0ZVBhdGgsIFwidXRmLThcIiksIC9BY3RpdmUgU2xpY2U6XFwqXFwqIE5vbmUvKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFLQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsWUFBWSxhQUFhLFdBQVcsY0FBYyxjQUFjO0FBQ3pFLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyx1QkFBdUI7QUFDaEM7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFFUCxLQUFLLCtEQUErRCxZQUFZO0FBQzlFLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLGlCQUFpQixDQUFDO0FBQzFELFFBQU0sUUFBUSxvQkFBSSxJQUFpQjtBQUNuQyxRQUFNLEtBQUssRUFBRSxjQUFjLENBQUMsU0FBYyxNQUFNLElBQUksS0FBSyxNQUFNLElBQUksRUFBRTtBQUVyRSxNQUFJO0FBQ0YsY0FBVSxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsVUFBVSxLQUFLLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN4RixpQkFBYSxLQUFLLE1BQU0sUUFBUSxRQUFRLENBQUM7QUFDekMsb0JBQWdCLEVBQUUsSUFBSSxRQUFRLE9BQU8sYUFBYSxRQUFRLFVBQVUsWUFBWSxDQUFDLEVBQUUsQ0FBQztBQUNwRixnQkFBWTtBQUFBLE1BQ1YsSUFBSTtBQUFBLE1BQ0osYUFBYTtBQUFBLE1BQ2IsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsTUFBTTtBQUFBLE1BQ04sU0FBUyxDQUFDO0FBQUEsTUFDVixNQUFNO0FBQUEsTUFDTixVQUFVO0FBQUEsSUFDWixDQUFDO0FBRUQsb0JBQWdCLEVBQVM7QUFDekIsVUFBTSxZQUFZLE1BQU0sSUFBSSxnQkFBZ0I7QUFDNUMsV0FBTyxHQUFHLFdBQVcsOEJBQThCO0FBRW5ELFVBQU0sU0FBUyxNQUFNLFVBQVU7QUFBQSxNQUM3QjtBQUFBLE1BQ0EsRUFBRSxhQUFhLFFBQVEsU0FBUyxPQUFPLFFBQVEsV0FBVztBQUFBLE1BQzFEO0FBQUEsTUFDQTtBQUFBLE1BQ0EsRUFBRSxLQUFLLEtBQUs7QUFBQSxJQUNkO0FBRUEsV0FBTyxNQUFNLE9BQU8sUUFBUSxXQUFXLFlBQVk7QUFDbkQsV0FBTyxNQUFNLFNBQVMsUUFBUSxLQUFLLEdBQUcsUUFBUSxTQUFTO0FBRXZELFVBQU0sWUFBWSxLQUFLLE1BQU0sUUFBUSxVQUFVO0FBQy9DLFdBQU8sTUFBTSxXQUFXLFNBQVMsR0FBRyxNQUFNLDRCQUE0QjtBQUN0RSxXQUFPLE1BQU0sYUFBYSxXQUFXLE9BQU8sR0FBRyx3QkFBd0I7QUFBQSxFQUN6RSxVQUFFO0FBQ0Esa0JBQWM7QUFDZCxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvQztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
