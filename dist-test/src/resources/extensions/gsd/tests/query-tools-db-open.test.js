import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.js";
import { registerQueryTools } from "../bootstrap/query-tools.js";
describe("query-tools ensureDbOpen usage (#3672)", () => {
  test("gsd_milestone_status opens the workspace DB before querying", async () => {
    const base = mkdtempSync(join(tmpdir(), "gsd-query-tools-"));
    const dbPath = join(base, ".gsd", "gsd.db");
    const tools = {};
    const originalCwd = process.cwd();
    try {
      mkdirSync(join(base, ".gsd"), { recursive: true });
      openDatabase(dbPath);
      insertMilestone({ id: "M001", title: "Query me", status: "active" });
      closeDatabase();
      registerQueryTools({ registerTool(tool) {
        tools[tool.name] = tool;
      } });
      process.chdir(base);
      const result = await tools.gsd_milestone_status.execute(
        "call-1",
        { milestoneId: "M001" },
        void 0,
        void 0,
        void 0
      );
      assert.notEqual(result.details?.error, "db_unavailable");
      assert.equal(result.details?.milestoneId ?? result.details?.milestone?.id, "M001");
    } finally {
      process.chdir(originalCwd);
      closeDatabase();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9xdWVyeS10b29scy1kYi1vcGVuLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUmVncmVzc2lvbiB0ZXN0IGZvciAjMzY3MiBcdTIwMTQgcXVlcnktdG9vbHMgdXNlcyBlbnN1cmVEYk9wZW5cbiAqXG4gKiBnc2RfbWlsZXN0b25lX3N0YXR1cyBwcmV2aW91c2x5IGNhbGxlZCBpc0RiQXZhaWxhYmxlKCkgYnV0IG5ldmVyXG4gKiBlbnN1cmVEYk9wZW4oKSwgbWFraW5nIGl0IGFsd2F5cyBmYWlsIG91dHNpZGUgYXV0by1tb2RlIHNlc3Npb25zLlxuICogVGhlIGZpeCBpbXBvcnRzIGVuc3VyZURiT3BlbiBmcm9tIGR5bmFtaWMtdG9vbHMgYW5kIGNhbGxzIGl0IGJlZm9yZVxuICogcXVlcnlpbmcgdGhlIERCLlxuICpcbiAqIFRoaXMgYmVoYXZpb3IgdGVzdCByZWdpc3RlcnMgdGhlIHF1ZXJ5IHRvb2wgYW5kIGV4ZWN1dGVzIGl0IGFnYWluc3QgYVxuICogdGVtcCB3b3Jrc3BhY2Ugd2hlcmUgdGhlIERCIG11c3QgYmUgb3BlbmVkIG9uIGRlbWFuZC5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgeyBta2RpclN5bmMsIG1rZHRlbXBTeW5jLCBybVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgeyBjbG9zZURhdGFiYXNlLCBpbnNlcnRNaWxlc3RvbmUsIG9wZW5EYXRhYmFzZSB9IGZyb20gJy4uL2dzZC1kYi50cyc7XG5pbXBvcnQgeyByZWdpc3RlclF1ZXJ5VG9vbHMgfSBmcm9tICcuLi9ib290c3RyYXAvcXVlcnktdG9vbHMudHMnO1xuXG5kZXNjcmliZSgncXVlcnktdG9vbHMgZW5zdXJlRGJPcGVuIHVzYWdlICgjMzY3MiknLCAoKSA9PiB7XG4gIHRlc3QoJ2dzZF9taWxlc3RvbmVfc3RhdHVzIG9wZW5zIHRoZSB3b3Jrc3BhY2UgREIgYmVmb3JlIHF1ZXJ5aW5nJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLXF1ZXJ5LXRvb2xzLScpKTtcbiAgICBjb25zdCBkYlBhdGggPSBqb2luKGJhc2UsICcuZ3NkJywgJ2dzZC5kYicpO1xuICAgIGNvbnN0IHRvb2xzOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0ge307XG4gICAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMoam9pbihiYXNlLCAnLmdzZCcpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuICAgICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJywgdGl0bGU6ICdRdWVyeSBtZScsIHN0YXR1czogJ2FjdGl2ZScgfSk7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG5cbiAgICAgIHJlZ2lzdGVyUXVlcnlUb29scyh7IHJlZ2lzdGVyVG9vbCh0b29sOiBhbnkpIHsgdG9vbHNbdG9vbC5uYW1lXSA9IHRvb2w7IH0gfSBhcyBhbnkpO1xuICAgICAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRvb2xzLmdzZF9taWxlc3RvbmVfc3RhdHVzLmV4ZWN1dGUoXG4gICAgICAgICdjYWxsLTEnLFxuICAgICAgICB7IG1pbGVzdG9uZUlkOiAnTTAwMScgfSxcbiAgICAgICAgdW5kZWZpbmVkLFxuICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICk7XG5cbiAgICAgIGFzc2VydC5ub3RFcXVhbChyZXN1bHQuZGV0YWlscz8uZXJyb3IsICdkYl91bmF2YWlsYWJsZScpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzPy5taWxlc3RvbmVJZCA/PyByZXN1bHQuZGV0YWlscz8ubWlsZXN0b25lPy5pZCwgJ00wMDEnKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihvcmlnaW5hbEN3ZCk7XG4gICAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVlBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsYUFBYSxjQUFjO0FBQy9DLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxlQUFlLGlCQUFpQixvQkFBb0I7QUFDN0QsU0FBUywwQkFBMEI7QUFFbkMsU0FBUywwQ0FBMEMsTUFBTTtBQUN2RCxPQUFLLCtEQUErRCxZQUFZO0FBQzlFLFVBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLGtCQUFrQixDQUFDO0FBQzNELFVBQU0sU0FBUyxLQUFLLE1BQU0sUUFBUSxRQUFRO0FBQzFDLFVBQU0sUUFBNkIsQ0FBQztBQUNwQyxVQUFNLGNBQWMsUUFBUSxJQUFJO0FBQ2hDLFFBQUk7QUFDRixnQkFBVSxLQUFLLE1BQU0sTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDakQsbUJBQWEsTUFBTTtBQUNuQixzQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxZQUFZLFFBQVEsU0FBUyxDQUFDO0FBQ25FLG9CQUFjO0FBRWQseUJBQW1CLEVBQUUsYUFBYSxNQUFXO0FBQUUsY0FBTSxLQUFLLElBQUksSUFBSTtBQUFBLE1BQU0sRUFBRSxDQUFRO0FBQ2xGLGNBQVEsTUFBTSxJQUFJO0FBQ2xCLFlBQU0sU0FBUyxNQUFNLE1BQU0scUJBQXFCO0FBQUEsUUFDOUM7QUFBQSxRQUNBLEVBQUUsYUFBYSxPQUFPO0FBQUEsUUFDdEI7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLE1BQ0Y7QUFFQSxhQUFPLFNBQVMsT0FBTyxTQUFTLE9BQU8sZ0JBQWdCO0FBQ3ZELGFBQU8sTUFBTSxPQUFPLFNBQVMsZUFBZSxPQUFPLFNBQVMsV0FBVyxJQUFJLE1BQU07QUFBQSxJQUNuRixVQUFFO0FBQ0EsY0FBUSxNQUFNLFdBQVc7QUFDekIsb0JBQWM7QUFDZCxhQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUMvQztBQUFBLEVBQ0YsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
