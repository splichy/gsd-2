import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensurePreconditions } from "../auto.js";
import {
  openDatabase,
  closeDatabase,
  insertMilestone
} from "../gsd-db.js";
function makeBase(prefix = "gsd-precond-") {
  const base = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
function makeMinimalState() {
  return {
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: []
  };
}
describe("ensurePreconditions phantom-dir guard (#4996)", () => {
  let base;
  afterEach(() => {
    try {
      closeDatabase();
    } catch {
    }
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  });
  it("(a) slice unit ID for unknown milestone does NOT create dirs when no DB row exists", () => {
    base = makeBase();
    const state = makeMinimalState();
    ensurePreconditions("execute-task", "M003/S01", base, state);
    const milestoneDir = join(base, ".gsd", "milestones", "M003");
    assert.ok(!existsSync(milestoneDir), "M003 dir must not be created for phantom slice dispatch");
  });
  it("(b) slice unit ID for milestone with DB row DOES create dirs", () => {
    base = makeBase();
    const dbPath = join(base, ".gsd", "gsd.db");
    openDatabase(dbPath);
    insertMilestone({ id: "M003", status: "active" });
    const state = makeMinimalState();
    ensurePreconditions("execute-task", "M003/S01", base, state);
    const milestoneDir = join(base, ".gsd", "milestones", "M003");
    assert.ok(existsSync(milestoneDir), "M003 dir must be created when DB row exists");
  });
  it("(c) slice unit ID for existing milestone dir with CONTEXT.md content file uses normal scaffolding", () => {
    base = makeBase();
    const mid = "M003";
    const milestoneDir = join(base, ".gsd", "milestones", mid);
    mkdirSync(milestoneDir, { recursive: true });
    writeFileSync(join(milestoneDir, `${mid}-CONTEXT.md`), "# Context\n");
    const state = makeMinimalState();
    ensurePreconditions("execute-task", "M003/S01", base, state);
    const slicesDir = join(milestoneDir, "slices");
    assert.ok(existsSync(slicesDir), "existing milestone dir should allow slice scaffolding");
  });
  it("(d) milestone-only unit ID (no slice) still creates dir even with no DB row", () => {
    base = makeBase();
    const state = makeMinimalState();
    ensurePreconditions("discuss-milestone", "M003", base, state);
    const milestoneDir = join(base, ".gsd", "milestones", "M003");
    assert.ok(existsSync(milestoneDir), "M003 dir must be created for milestone-only dispatch");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9lbnN1cmUtcHJlY29uZGl0aW9ucy1ndWFyZC00OTk2LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRCBFeHRlbnNpb24gXHUyMDE0IFJlZ3Jlc3Npb24gdGVzdCBmb3IgIzQ5OTY6IGVuc3VyZVByZWNvbmRpdGlvbnMgcGhhbnRvbSBkaXIgZ3VhcmRcbi8vIFZlcmlmaWVzIHRoYXQgZW5zdXJlUHJlY29uZGl0aW9ucyBkb2VzIG5vdCBjcmVhdGUgbWlsZXN0b25lIGRpcmVjdG9yaWVzIGZvclxuLy8gZm9yd2FyZC1yZWZlcmVuY2VkIHNsaWNlIHVuaXQgSURzIHdoZW4gdGhlIG1pbGVzdG9uZSBoYXMgbm8gREIgcm93LlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYywgZXhpc3RzU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBlbnN1cmVQcmVjb25kaXRpb25zIH0gZnJvbSBcIi4uL2F1dG8udHNcIjtcbmltcG9ydCB7XG4gIG9wZW5EYXRhYmFzZSxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxufSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5cbmltcG9ydCB0eXBlIHsgR1NEU3RhdGUgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcblxuZnVuY3Rpb24gbWFrZUJhc2UocHJlZml4ID0gXCJnc2QtcHJlY29uZC1cIik6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBwcmVmaXgpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5mdW5jdGlvbiBtYWtlTWluaW1hbFN0YXRlKCk6IEdTRFN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICBhY3RpdmVNaWxlc3RvbmU6IG51bGwsXG4gICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICBwaGFzZTogXCJwbGFubmluZ1wiLFxuICAgIHJlY2VudERlY2lzaW9uczogW10sXG4gICAgYmxvY2tlcnM6IFtdLFxuICAgIG5leHRBY3Rpb246IFwiXCIsXG4gICAgcmVnaXN0cnk6IFtdLFxuICB9O1xufVxuXG5kZXNjcmliZShcImVuc3VyZVByZWNvbmRpdGlvbnMgcGhhbnRvbS1kaXIgZ3VhcmQgKCM0OTk2KVwiLCAoKSA9PiB7XG4gIGxldCBiYXNlOiBzdHJpbmc7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICB0cnkgeyBjbG9zZURhdGFiYXNlKCk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICAgIHRyeSB7IHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICB9KTtcblxuICBpdChcIihhKSBzbGljZSB1bml0IElEIGZvciB1bmtub3duIG1pbGVzdG9uZSBkb2VzIE5PVCBjcmVhdGUgZGlycyB3aGVuIG5vIERCIHJvdyBleGlzdHNcIiwgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IHN0YXRlID0gbWFrZU1pbmltYWxTdGF0ZSgpO1xuXG4gICAgZW5zdXJlUHJlY29uZGl0aW9ucyhcImV4ZWN1dGUtdGFza1wiLCBcIk0wMDMvUzAxXCIsIGJhc2UsIHN0YXRlKTtcblxuICAgIGNvbnN0IG1pbGVzdG9uZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDNcIik7XG4gICAgYXNzZXJ0Lm9rKCFleGlzdHNTeW5jKG1pbGVzdG9uZURpciksIFwiTTAwMyBkaXIgbXVzdCBub3QgYmUgY3JlYXRlZCBmb3IgcGhhbnRvbSBzbGljZSBkaXNwYXRjaFwiKTtcbiAgfSk7XG5cbiAgaXQoXCIoYikgc2xpY2UgdW5pdCBJRCBmb3IgbWlsZXN0b25lIHdpdGggREIgcm93IERPRVMgY3JlYXRlIGRpcnNcIiwgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IGRiUGF0aCA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpO1xuICAgIG9wZW5EYXRhYmFzZShkYlBhdGgpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDNcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgIGNvbnN0IHN0YXRlID0gbWFrZU1pbmltYWxTdGF0ZSgpO1xuXG4gICAgZW5zdXJlUHJlY29uZGl0aW9ucyhcImV4ZWN1dGUtdGFza1wiLCBcIk0wMDMvUzAxXCIsIGJhc2UsIHN0YXRlKTtcblxuICAgIGNvbnN0IG1pbGVzdG9uZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDNcIik7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMobWlsZXN0b25lRGlyKSwgXCJNMDAzIGRpciBtdXN0IGJlIGNyZWF0ZWQgd2hlbiBEQiByb3cgZXhpc3RzXCIpO1xuICB9KTtcblxuICBpdChcIihjKSBzbGljZSB1bml0IElEIGZvciBleGlzdGluZyBtaWxlc3RvbmUgZGlyIHdpdGggQ09OVEVYVC5tZCBjb250ZW50IGZpbGUgdXNlcyBub3JtYWwgc2NhZmZvbGRpbmdcIiwgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IG1pZCA9IFwiTTAwM1wiO1xuICAgIGNvbnN0IG1pbGVzdG9uZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWQpO1xuICAgIG1rZGlyU3luYyhtaWxlc3RvbmVEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihtaWxlc3RvbmVEaXIsIGAke21pZH0tQ09OVEVYVC5tZGApLCBcIiMgQ29udGV4dFxcblwiKTtcbiAgICBjb25zdCBzdGF0ZSA9IG1ha2VNaW5pbWFsU3RhdGUoKTtcblxuICAgIGVuc3VyZVByZWNvbmRpdGlvbnMoXCJleGVjdXRlLXRhc2tcIiwgXCJNMDAzL1MwMVwiLCBiYXNlLCBzdGF0ZSk7XG5cbiAgICBjb25zdCBzbGljZXNEaXIgPSBqb2luKG1pbGVzdG9uZURpciwgXCJzbGljZXNcIik7XG4gICAgYXNzZXJ0Lm9rKGV4aXN0c1N5bmMoc2xpY2VzRGlyKSwgXCJleGlzdGluZyBtaWxlc3RvbmUgZGlyIHNob3VsZCBhbGxvdyBzbGljZSBzY2FmZm9sZGluZ1wiKTtcbiAgfSk7XG5cbiAgaXQoXCIoZCkgbWlsZXN0b25lLW9ubHkgdW5pdCBJRCAobm8gc2xpY2UpIHN0aWxsIGNyZWF0ZXMgZGlyIGV2ZW4gd2l0aCBubyBEQiByb3dcIiwgKCkgPT4ge1xuICAgIGJhc2UgPSBtYWtlQmFzZSgpO1xuICAgIGNvbnN0IHN0YXRlID0gbWFrZU1pbmltYWxTdGF0ZSgpO1xuXG4gICAgZW5zdXJlUHJlY29uZGl0aW9ucyhcImRpc2N1c3MtbWlsZXN0b25lXCIsIFwiTTAwM1wiLCBiYXNlLCBzdGF0ZSk7XG5cbiAgICBjb25zdCBtaWxlc3RvbmVEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAzXCIpO1xuICAgIGFzc2VydC5vayhleGlzdHNTeW5jKG1pbGVzdG9uZURpciksIFwiTTAwMyBkaXIgbXVzdCBiZSBjcmVhdGVkIGZvciBtaWxlc3RvbmUtb25seSBkaXNwYXRjaFwiKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUlBLFNBQVMsVUFBVSxJQUFJLGlCQUFpQjtBQUN4QyxPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsZUFBZSxZQUFZLGNBQWM7QUFDMUUsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLDJCQUEyQjtBQUNwQztBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFJUCxTQUFTLFNBQVMsU0FBUyxnQkFBd0I7QUFDakQsUUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsTUFBTSxDQUFDO0FBQy9DLFlBQVUsS0FBSyxNQUFNLFFBQVEsWUFBWSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDL0QsU0FBTztBQUNUO0FBRUEsU0FBUyxtQkFBNkI7QUFDcEMsU0FBTztBQUFBLElBQ0wsaUJBQWlCO0FBQUEsSUFDakIsYUFBYTtBQUFBLElBQ2IsWUFBWTtBQUFBLElBQ1osT0FBTztBQUFBLElBQ1AsaUJBQWlCLENBQUM7QUFBQSxJQUNsQixVQUFVLENBQUM7QUFBQSxJQUNYLFlBQVk7QUFBQSxJQUNaLFVBQVUsQ0FBQztBQUFBLEVBQ2I7QUFDRjtBQUVBLFNBQVMsaURBQWlELE1BQU07QUFDOUQsTUFBSTtBQUVKLFlBQVUsTUFBTTtBQUNkLFFBQUk7QUFBRSxvQkFBYztBQUFBLElBQUcsUUFBUTtBQUFBLElBQWU7QUFDOUMsUUFBSTtBQUFFLGFBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQUcsUUFBUTtBQUFBLElBQWU7QUFBQSxFQUMvRSxDQUFDO0FBRUQsS0FBRyxzRkFBc0YsTUFBTTtBQUM3RixXQUFPLFNBQVM7QUFDaEIsVUFBTSxRQUFRLGlCQUFpQjtBQUUvQix3QkFBb0IsZ0JBQWdCLFlBQVksTUFBTSxLQUFLO0FBRTNELFVBQU0sZUFBZSxLQUFLLE1BQU0sUUFBUSxjQUFjLE1BQU07QUFDNUQsV0FBTyxHQUFHLENBQUMsV0FBVyxZQUFZLEdBQUcseURBQXlEO0FBQUEsRUFDaEcsQ0FBQztBQUVELEtBQUcsZ0VBQWdFLE1BQU07QUFDdkUsV0FBTyxTQUFTO0FBQ2hCLFVBQU0sU0FBUyxLQUFLLE1BQU0sUUFBUSxRQUFRO0FBQzFDLGlCQUFhLE1BQU07QUFDbkIsb0JBQWdCLEVBQUUsSUFBSSxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBQ2hELFVBQU0sUUFBUSxpQkFBaUI7QUFFL0Isd0JBQW9CLGdCQUFnQixZQUFZLE1BQU0sS0FBSztBQUUzRCxVQUFNLGVBQWUsS0FBSyxNQUFNLFFBQVEsY0FBYyxNQUFNO0FBQzVELFdBQU8sR0FBRyxXQUFXLFlBQVksR0FBRyw2Q0FBNkM7QUFBQSxFQUNuRixDQUFDO0FBRUQsS0FBRyxxR0FBcUcsTUFBTTtBQUM1RyxXQUFPLFNBQVM7QUFDaEIsVUFBTSxNQUFNO0FBQ1osVUFBTSxlQUFlLEtBQUssTUFBTSxRQUFRLGNBQWMsR0FBRztBQUN6RCxjQUFVLGNBQWMsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUMzQyxrQkFBYyxLQUFLLGNBQWMsR0FBRyxHQUFHLGFBQWEsR0FBRyxhQUFhO0FBQ3BFLFVBQU0sUUFBUSxpQkFBaUI7QUFFL0Isd0JBQW9CLGdCQUFnQixZQUFZLE1BQU0sS0FBSztBQUUzRCxVQUFNLFlBQVksS0FBSyxjQUFjLFFBQVE7QUFDN0MsV0FBTyxHQUFHLFdBQVcsU0FBUyxHQUFHLHVEQUF1RDtBQUFBLEVBQzFGLENBQUM7QUFFRCxLQUFHLCtFQUErRSxNQUFNO0FBQ3RGLFdBQU8sU0FBUztBQUNoQixVQUFNLFFBQVEsaUJBQWlCO0FBRS9CLHdCQUFvQixxQkFBcUIsUUFBUSxNQUFNLEtBQUs7QUFFNUQsVUFBTSxlQUFlLEtBQUssTUFBTSxRQUFRLGNBQWMsTUFBTTtBQUM1RCxXQUFPLEdBQUcsV0FBVyxZQUFZLEdBQUcsc0RBQXNEO0FBQUEsRUFDNUYsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
