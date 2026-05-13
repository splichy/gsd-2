import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { getSkillSearchDirs } from "../preferences-skills.js";
describe("getSkillSearchDirs \u2014 Claude Code directory support", () => {
  const cwd = "/tmp/test-project";
  test("includes ~/.agents/skills/ as user-skill", () => {
    const dirs = getSkillSearchDirs(cwd);
    const agents = dirs.find((d) => d.dir === join(homedir(), ".agents", "skills"));
    assert.ok(agents, "should include ~/.agents/skills/");
    assert.equal(agents.method, "user-skill");
  });
  test("includes .agents/skills/ as project-skill", () => {
    const dirs = getSkillSearchDirs(cwd);
    const projectAgents = dirs.find((d) => d.dir === join(cwd, ".agents", "skills"));
    assert.ok(projectAgents, "should include .agents/skills/");
    assert.equal(projectAgents.method, "project-skill");
  });
  test("includes ~/.claude/skills/ as user-skill", () => {
    const dirs = getSkillSearchDirs(cwd);
    const claude = dirs.find((d) => d.dir === join(homedir(), ".claude", "skills"));
    assert.ok(claude, "should include ~/.claude/skills/");
    assert.equal(claude.method, "user-skill");
  });
  test("includes .claude/skills/ as project-skill", () => {
    const dirs = getSkillSearchDirs(cwd);
    const projectClaude = dirs.find((d) => d.dir === join(cwd, ".claude", "skills"));
    assert.ok(projectClaude, "should include .claude/skills/");
    assert.equal(projectClaude.method, "project-skill");
  });
  test("~/.agents/skills/ appears before ~/.claude/skills/ (priority order)", () => {
    const dirs = getSkillSearchDirs(cwd);
    const agentsIdx = dirs.findIndex((d) => d.dir === join(homedir(), ".agents", "skills"));
    const claudeIdx = dirs.findIndex((d) => d.dir === join(homedir(), ".claude", "skills"));
    assert.ok(agentsIdx < claudeIdx, "~/.agents/skills/ should have higher priority than ~/.claude/skills/");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jbGF1ZGUtc2tpbGwtZGlycy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFRlc3RzIGZvciBDbGF1ZGUgQ29kZSBza2lsbCBkaXJlY3Rvcnkgc3VwcG9ydCBpbiBnZXRTa2lsbFNlYXJjaERpcnMoKS5cbiAqXG4gKiBWZXJpZmllcyB0aGF0IH4vLmNsYXVkZS9za2lsbHMvIGFuZCAuY2xhdWRlL3NraWxscy8gYXJlIGluY2x1ZGVkIGluXG4gKiB0aGUgc2tpbGwgc2VhcmNoIHBhdGggYWxvbmdzaWRlIH4vLmFnZW50cy9za2lsbHMvIGFuZCAuYWdlbnRzL3NraWxscy8uXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGdldFNraWxsU2VhcmNoRGlycyB9IGZyb20gXCIuLi9wcmVmZXJlbmNlcy1za2lsbHMudHNcIjtcblxuZGVzY3JpYmUoXCJnZXRTa2lsbFNlYXJjaERpcnMgXHUyMDE0IENsYXVkZSBDb2RlIGRpcmVjdG9yeSBzdXBwb3J0XCIsICgpID0+IHtcbiAgY29uc3QgY3dkID0gXCIvdG1wL3Rlc3QtcHJvamVjdFwiO1xuXG4gIHRlc3QoXCJpbmNsdWRlcyB+Ly5hZ2VudHMvc2tpbGxzLyBhcyB1c2VyLXNraWxsXCIsICgpID0+IHtcbiAgICBjb25zdCBkaXJzID0gZ2V0U2tpbGxTZWFyY2hEaXJzKGN3ZCk7XG4gICAgY29uc3QgYWdlbnRzID0gZGlycy5maW5kKChkKSA9PiBkLmRpciA9PT0gam9pbihob21lZGlyKCksIFwiLmFnZW50c1wiLCBcInNraWxsc1wiKSk7XG4gICAgYXNzZXJ0Lm9rKGFnZW50cywgXCJzaG91bGQgaW5jbHVkZSB+Ly5hZ2VudHMvc2tpbGxzL1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoYWdlbnRzIS5tZXRob2QsIFwidXNlci1za2lsbFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImluY2x1ZGVzIC5hZ2VudHMvc2tpbGxzLyBhcyBwcm9qZWN0LXNraWxsXCIsICgpID0+IHtcbiAgICBjb25zdCBkaXJzID0gZ2V0U2tpbGxTZWFyY2hEaXJzKGN3ZCk7XG4gICAgY29uc3QgcHJvamVjdEFnZW50cyA9IGRpcnMuZmluZCgoZCkgPT4gZC5kaXIgPT09IGpvaW4oY3dkLCBcIi5hZ2VudHNcIiwgXCJza2lsbHNcIikpO1xuICAgIGFzc2VydC5vayhwcm9qZWN0QWdlbnRzLCBcInNob3VsZCBpbmNsdWRlIC5hZ2VudHMvc2tpbGxzL1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocHJvamVjdEFnZW50cyEubWV0aG9kLCBcInByb2plY3Qtc2tpbGxcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJpbmNsdWRlcyB+Ly5jbGF1ZGUvc2tpbGxzLyBhcyB1c2VyLXNraWxsXCIsICgpID0+IHtcbiAgICBjb25zdCBkaXJzID0gZ2V0U2tpbGxTZWFyY2hEaXJzKGN3ZCk7XG4gICAgY29uc3QgY2xhdWRlID0gZGlycy5maW5kKChkKSA9PiBkLmRpciA9PT0gam9pbihob21lZGlyKCksIFwiLmNsYXVkZVwiLCBcInNraWxsc1wiKSk7XG4gICAgYXNzZXJ0Lm9rKGNsYXVkZSwgXCJzaG91bGQgaW5jbHVkZSB+Ly5jbGF1ZGUvc2tpbGxzL1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoY2xhdWRlIS5tZXRob2QsIFwidXNlci1za2lsbFwiKTtcbiAgfSk7XG5cbiAgdGVzdChcImluY2x1ZGVzIC5jbGF1ZGUvc2tpbGxzLyBhcyBwcm9qZWN0LXNraWxsXCIsICgpID0+IHtcbiAgICBjb25zdCBkaXJzID0gZ2V0U2tpbGxTZWFyY2hEaXJzKGN3ZCk7XG4gICAgY29uc3QgcHJvamVjdENsYXVkZSA9IGRpcnMuZmluZCgoZCkgPT4gZC5kaXIgPT09IGpvaW4oY3dkLCBcIi5jbGF1ZGVcIiwgXCJza2lsbHNcIikpO1xuICAgIGFzc2VydC5vayhwcm9qZWN0Q2xhdWRlLCBcInNob3VsZCBpbmNsdWRlIC5jbGF1ZGUvc2tpbGxzL1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocHJvamVjdENsYXVkZSEubWV0aG9kLCBcInByb2plY3Qtc2tpbGxcIik7XG4gIH0pO1xuXG4gIHRlc3QoXCJ+Ly5hZ2VudHMvc2tpbGxzLyBhcHBlYXJzIGJlZm9yZSB+Ly5jbGF1ZGUvc2tpbGxzLyAocHJpb3JpdHkgb3JkZXIpXCIsICgpID0+IHtcbiAgICBjb25zdCBkaXJzID0gZ2V0U2tpbGxTZWFyY2hEaXJzKGN3ZCk7XG4gICAgY29uc3QgYWdlbnRzSWR4ID0gZGlycy5maW5kSW5kZXgoKGQpID0+IGQuZGlyID09PSBqb2luKGhvbWVkaXIoKSwgXCIuYWdlbnRzXCIsIFwic2tpbGxzXCIpKTtcbiAgICBjb25zdCBjbGF1ZGVJZHggPSBkaXJzLmZpbmRJbmRleCgoZCkgPT4gZC5kaXIgPT09IGpvaW4oaG9tZWRpcigpLCBcIi5jbGF1ZGVcIiwgXCJza2lsbHNcIikpO1xuICAgIGFzc2VydC5vayhhZ2VudHNJZHggPCBjbGF1ZGVJZHgsIFwifi8uYWdlbnRzL3NraWxscy8gc2hvdWxkIGhhdmUgaGlnaGVyIHByaW9yaXR5IHRoYW4gfi8uY2xhdWRlL3NraWxscy9cIik7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFPQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsZUFBZTtBQUN4QixTQUFTLDBCQUEwQjtBQUVuQyxTQUFTLDJEQUFzRCxNQUFNO0FBQ25FLFFBQU0sTUFBTTtBQUVaLE9BQUssNENBQTRDLE1BQU07QUFDckQsVUFBTSxPQUFPLG1CQUFtQixHQUFHO0FBQ25DLFVBQU0sU0FBUyxLQUFLLEtBQUssQ0FBQyxNQUFNLEVBQUUsUUFBUSxLQUFLLFFBQVEsR0FBRyxXQUFXLFFBQVEsQ0FBQztBQUM5RSxXQUFPLEdBQUcsUUFBUSxrQ0FBa0M7QUFDcEQsV0FBTyxNQUFNLE9BQVEsUUFBUSxZQUFZO0FBQUEsRUFDM0MsQ0FBQztBQUVELE9BQUssNkNBQTZDLE1BQU07QUFDdEQsVUFBTSxPQUFPLG1CQUFtQixHQUFHO0FBQ25DLFVBQU0sZ0JBQWdCLEtBQUssS0FBSyxDQUFDLE1BQU0sRUFBRSxRQUFRLEtBQUssS0FBSyxXQUFXLFFBQVEsQ0FBQztBQUMvRSxXQUFPLEdBQUcsZUFBZSxnQ0FBZ0M7QUFDekQsV0FBTyxNQUFNLGNBQWUsUUFBUSxlQUFlO0FBQUEsRUFDckQsQ0FBQztBQUVELE9BQUssNENBQTRDLE1BQU07QUFDckQsVUFBTSxPQUFPLG1CQUFtQixHQUFHO0FBQ25DLFVBQU0sU0FBUyxLQUFLLEtBQUssQ0FBQyxNQUFNLEVBQUUsUUFBUSxLQUFLLFFBQVEsR0FBRyxXQUFXLFFBQVEsQ0FBQztBQUM5RSxXQUFPLEdBQUcsUUFBUSxrQ0FBa0M7QUFDcEQsV0FBTyxNQUFNLE9BQVEsUUFBUSxZQUFZO0FBQUEsRUFDM0MsQ0FBQztBQUVELE9BQUssNkNBQTZDLE1BQU07QUFDdEQsVUFBTSxPQUFPLG1CQUFtQixHQUFHO0FBQ25DLFVBQU0sZ0JBQWdCLEtBQUssS0FBSyxDQUFDLE1BQU0sRUFBRSxRQUFRLEtBQUssS0FBSyxXQUFXLFFBQVEsQ0FBQztBQUMvRSxXQUFPLEdBQUcsZUFBZSxnQ0FBZ0M7QUFDekQsV0FBTyxNQUFNLGNBQWUsUUFBUSxlQUFlO0FBQUEsRUFDckQsQ0FBQztBQUVELE9BQUssdUVBQXVFLE1BQU07QUFDaEYsVUFBTSxPQUFPLG1CQUFtQixHQUFHO0FBQ25DLFVBQU0sWUFBWSxLQUFLLFVBQVUsQ0FBQyxNQUFNLEVBQUUsUUFBUSxLQUFLLFFBQVEsR0FBRyxXQUFXLFFBQVEsQ0FBQztBQUN0RixVQUFNLFlBQVksS0FBSyxVQUFVLENBQUMsTUFBTSxFQUFFLFFBQVEsS0FBSyxRQUFRLEdBQUcsV0FBVyxRQUFRLENBQUM7QUFDdEYsV0FBTyxHQUFHLFlBQVksV0FBVyxzRUFBc0U7QUFBQSxFQUN6RyxDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
