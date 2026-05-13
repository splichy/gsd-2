import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Agent } from "@gsd/pi-agent-core";
import { AuthStorage } from "./auth-storage.js";
import { AgentSession } from "./agent-session.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
let testDir;
function writeSkill(cwd, name, description, body = `# ${name}
`) {
  const skillDir = join(cwd, ".agents", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, `---
name: ${name}
description: ${description}
---

${body}`);
  return skillPath;
}
describe("Skill tool", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "skill-tool-test-"));
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });
  async function createSession() {
    const agentDir = join(testDir, "agent-home");
    const authStorage = AuthStorage.inMemory({});
    const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd: testDir,
      agentDir,
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true
    });
    await resourceLoader.reload();
    return new AgentSession({
      agent: new Agent(),
      sessionManager: SessionManager.inMemory(testDir),
      settingsManager,
      cwd: testDir,
      resourceLoader,
      modelRegistry
    });
  }
  it("resolves a project-level skill to the exact skill block format", async () => {
    const skillPath = writeSkill(
      testDir,
      "swift-testing",
      "Use for Swift Testing assertions and verification patterns.",
      "# Swift Testing\nUse this skill.\n"
    );
    const session = await createSession();
    const tool = session.state.tools.find((entry) => entry.name === "Skill");
    assert.ok(tool, "Skill tool should be registered");
    const result = await tool.execute("call-1", { skill: "swift-testing" });
    assert.equal(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      `<skill name="swift-testing" location="${skillPath}">
References are relative to ${join(testDir, ".agents", "skills", "swift-testing")}.

# Swift Testing
Use this skill.
</skill>`
    );
  });
  it("returns a helpful error for unknown skills", async () => {
    writeSkill(testDir, "swift-testing", "Use for Swift Testing assertions and verification patterns.");
    const session = await createSession();
    const tool = session.state.tools.find((entry) => entry.name === "Skill");
    assert.ok(tool, "Skill tool should be registered");
    const result = await tool.execute("call-2", { skill: "nonexistent" });
    const message = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.match(message, /^Skill "nonexistent" not found\. Available skills: /);
    assert.match(message, /swift-testing/);
  });
  it("filters skill catalog without unloading skills or disabling Skill tool", async () => {
    writeSkill(testDir, "alpha", "Use alpha.");
    writeSkill(testDir, "beta", "Use beta.");
    const session = await createSession();
    assert.match(session.systemPrompt, /<name>alpha<\/name>/);
    assert.match(session.systemPrompt, /<name>beta<\/name>/);
    session.setVisibleSkillsByName(["alpha"]);
    assert.deepEqual(session.getVisibleSkillNames(), ["alpha"]);
    assert.match(session.systemPrompt, /<name>alpha<\/name>/);
    assert.doesNotMatch(session.systemPrompt, /<name>beta<\/name>/);
    const tool = session.state.tools.find((entry) => entry.name === "Skill");
    assert.ok(tool, "Skill tool should remain active");
    const result = await tool.execute("call-3", { skill: "beta" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.match(text, /<skill name="beta"/);
    session.setVisibleSkillsByName(void 0);
    assert.equal(session.getVisibleSkillNames(), void 0);
    assert.match(session.systemPrompt, /<name>alpha<\/name>/);
    assert.match(session.systemPrompt, /<name>beta<\/name>/);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3NraWxsLXRvb2wudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFRlc3RzIHNraWxsIGludm9jYXRpb24gYW5kIHByb21wdC1vbmx5IHNraWxsIHZpc2liaWxpdHkgYmVoYXZpb3IuXG5cbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCBta2R0ZW1wU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgYWZ0ZXJFYWNoLCBiZWZvcmVFYWNoLCBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5cbmltcG9ydCB7IEFnZW50IH0gZnJvbSBcIkBnc2QvcGktYWdlbnQtY29yZVwiO1xuaW1wb3J0IHsgQXV0aFN0b3JhZ2UgfSBmcm9tIFwiLi9hdXRoLXN0b3JhZ2UuanNcIjtcbmltcG9ydCB7IEFnZW50U2Vzc2lvbiB9IGZyb20gXCIuL2FnZW50LXNlc3Npb24uanNcIjtcbmltcG9ydCB7IE1vZGVsUmVnaXN0cnkgfSBmcm9tIFwiLi9tb2RlbC1yZWdpc3RyeS5qc1wiO1xuaW1wb3J0IHsgRGVmYXVsdFJlc291cmNlTG9hZGVyIH0gZnJvbSBcIi4vcmVzb3VyY2UtbG9hZGVyLmpzXCI7XG5pbXBvcnQgeyBTZXNzaW9uTWFuYWdlciB9IGZyb20gXCIuL3Nlc3Npb24tbWFuYWdlci5qc1wiO1xuaW1wb3J0IHsgU2V0dGluZ3NNYW5hZ2VyIH0gZnJvbSBcIi4vc2V0dGluZ3MtbWFuYWdlci5qc1wiO1xuXG5sZXQgdGVzdERpcjogc3RyaW5nO1xuXG5mdW5jdGlvbiB3cml0ZVNraWxsKGN3ZDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGRlc2NyaXB0aW9uOiBzdHJpbmcsIGJvZHkgPSBgIyAke25hbWV9XFxuYCk6IHN0cmluZyB7XG5cdGNvbnN0IHNraWxsRGlyID0gam9pbihjd2QsIFwiLmFnZW50c1wiLCBcInNraWxsc1wiLCBuYW1lKTtcblx0bWtkaXJTeW5jKHNraWxsRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0Y29uc3Qgc2tpbGxQYXRoID0gam9pbihza2lsbERpciwgXCJTS0lMTC5tZFwiKTtcblx0d3JpdGVGaWxlU3luYyhza2lsbFBhdGgsIGAtLS1cXG5uYW1lOiAke25hbWV9XFxuZGVzY3JpcHRpb246ICR7ZGVzY3JpcHRpb259XFxuLS0tXFxuXFxuJHtib2R5fWApO1xuXHRyZXR1cm4gc2tpbGxQYXRoO1xufVxuXG5kZXNjcmliZShcIlNraWxsIHRvb2xcIiwgKCkgPT4ge1xuXHRiZWZvcmVFYWNoKCgpID0+IHtcblx0XHR0ZXN0RGlyID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJza2lsbC10b29sLXRlc3QtXCIpKTtcblx0fSk7XG5cblx0YWZ0ZXJFYWNoKCgpID0+IHtcblx0XHRybVN5bmModGVzdERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXHR9KTtcblxuXHRhc3luYyBmdW5jdGlvbiBjcmVhdGVTZXNzaW9uKCkge1xuXHRcdGNvbnN0IGFnZW50RGlyID0gam9pbih0ZXN0RGlyLCBcImFnZW50LWhvbWVcIik7XG5cdFx0Y29uc3QgYXV0aFN0b3JhZ2UgPSBBdXRoU3RvcmFnZS5pbk1lbW9yeSh7fSk7XG5cdFx0Y29uc3QgbW9kZWxSZWdpc3RyeSA9IG5ldyBNb2RlbFJlZ2lzdHJ5KGF1dGhTdG9yYWdlLCBqb2luKGFnZW50RGlyLCBcIm1vZGVscy5qc29uXCIpKTtcblx0XHRjb25zdCBzZXR0aW5nc01hbmFnZXIgPSBTZXR0aW5nc01hbmFnZXIuaW5NZW1vcnkoKTtcblx0XHRjb25zdCByZXNvdXJjZUxvYWRlciA9IG5ldyBEZWZhdWx0UmVzb3VyY2VMb2FkZXIoe1xuXHRcdFx0Y3dkOiB0ZXN0RGlyLFxuXHRcdFx0YWdlbnREaXIsXG5cdFx0XHRzZXR0aW5nc01hbmFnZXIsXG5cdFx0XHRub0V4dGVuc2lvbnM6IHRydWUsXG5cdFx0XHRub1Byb21wdFRlbXBsYXRlczogdHJ1ZSxcblx0XHRcdG5vVGhlbWVzOiB0cnVlLFxuXHRcdH0pO1xuXHRcdGF3YWl0IHJlc291cmNlTG9hZGVyLnJlbG9hZCgpO1xuXG5cdFx0cmV0dXJuIG5ldyBBZ2VudFNlc3Npb24oe1xuXHRcdFx0YWdlbnQ6IG5ldyBBZ2VudCgpLFxuXHRcdFx0c2Vzc2lvbk1hbmFnZXI6IFNlc3Npb25NYW5hZ2VyLmluTWVtb3J5KHRlc3REaXIpLFxuXHRcdFx0c2V0dGluZ3NNYW5hZ2VyLFxuXHRcdFx0Y3dkOiB0ZXN0RGlyLFxuXHRcdFx0cmVzb3VyY2VMb2FkZXIsXG5cdFx0XHRtb2RlbFJlZ2lzdHJ5LFxuXHRcdH0pO1xuXHR9XG5cblx0aXQoXCJyZXNvbHZlcyBhIHByb2plY3QtbGV2ZWwgc2tpbGwgdG8gdGhlIGV4YWN0IHNraWxsIGJsb2NrIGZvcm1hdFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc2tpbGxQYXRoID0gd3JpdGVTa2lsbChcblx0XHRcdHRlc3REaXIsXG5cdFx0XHRcInN3aWZ0LXRlc3RpbmdcIixcblx0XHRcdFwiVXNlIGZvciBTd2lmdCBUZXN0aW5nIGFzc2VydGlvbnMgYW5kIHZlcmlmaWNhdGlvbiBwYXR0ZXJucy5cIixcblx0XHRcdFwiIyBTd2lmdCBUZXN0aW5nXFxuVXNlIHRoaXMgc2tpbGwuXFxuXCIsXG5cdFx0KTtcblx0XHRjb25zdCBzZXNzaW9uID0gYXdhaXQgY3JlYXRlU2Vzc2lvbigpO1xuXG5cdFx0Y29uc3QgdG9vbCA9IHNlc3Npb24uc3RhdGUudG9vbHMuZmluZCgoZW50cnkpID0+IGVudHJ5Lm5hbWUgPT09IFwiU2tpbGxcIik7XG5cdFx0YXNzZXJ0Lm9rKHRvb2wsIFwiU2tpbGwgdG9vbCBzaG91bGQgYmUgcmVnaXN0ZXJlZFwiKTtcblxuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRvb2wuZXhlY3V0ZShcImNhbGwtMVwiLCB7IHNraWxsOiBcInN3aWZ0LXRlc3RpbmdcIiB9KTtcblx0XHRhc3NlcnQuZXF1YWwoXG5cdFx0XHRyZXN1bHQuY29udGVudFswXT8udHlwZSA9PT0gXCJ0ZXh0XCIgPyByZXN1bHQuY29udGVudFswXS50ZXh0IDogXCJcIixcblx0XHRcdGA8c2tpbGwgbmFtZT1cInN3aWZ0LXRlc3RpbmdcIiBsb2NhdGlvbj1cIiR7c2tpbGxQYXRofVwiPlxcblJlZmVyZW5jZXMgYXJlIHJlbGF0aXZlIHRvICR7am9pbih0ZXN0RGlyLCBcIi5hZ2VudHNcIiwgXCJza2lsbHNcIiwgXCJzd2lmdC10ZXN0aW5nXCIpfS5cXG5cXG4jIFN3aWZ0IFRlc3RpbmdcXG5Vc2UgdGhpcyBza2lsbC5cXG48L3NraWxsPmAsXG5cdFx0KTtcblx0fSk7XG5cblx0aXQoXCJyZXR1cm5zIGEgaGVscGZ1bCBlcnJvciBmb3IgdW5rbm93biBza2lsbHNcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdHdyaXRlU2tpbGwodGVzdERpciwgXCJzd2lmdC10ZXN0aW5nXCIsIFwiVXNlIGZvciBTd2lmdCBUZXN0aW5nIGFzc2VydGlvbnMgYW5kIHZlcmlmaWNhdGlvbiBwYXR0ZXJucy5cIik7XG5cdFx0Y29uc3Qgc2Vzc2lvbiA9IGF3YWl0IGNyZWF0ZVNlc3Npb24oKTtcblx0XHRjb25zdCB0b29sID0gc2Vzc2lvbi5zdGF0ZS50b29scy5maW5kKChlbnRyeSkgPT4gZW50cnkubmFtZSA9PT0gXCJTa2lsbFwiKTtcblx0XHRhc3NlcnQub2sodG9vbCwgXCJTa2lsbCB0b29sIHNob3VsZCBiZSByZWdpc3RlcmVkXCIpO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgdG9vbC5leGVjdXRlKFwiY2FsbC0yXCIsIHsgc2tpbGw6IFwibm9uZXhpc3RlbnRcIiB9KTtcblx0XHRjb25zdCBtZXNzYWdlID0gcmVzdWx0LmNvbnRlbnRbMF0/LnR5cGUgPT09IFwidGV4dFwiID8gcmVzdWx0LmNvbnRlbnRbMF0udGV4dCA6IFwiXCI7XG5cdFx0YXNzZXJ0Lm1hdGNoKG1lc3NhZ2UsIC9eU2tpbGwgXCJub25leGlzdGVudFwiIG5vdCBmb3VuZFxcLiBBdmFpbGFibGUgc2tpbGxzOiAvKTtcblx0XHRhc3NlcnQubWF0Y2gobWVzc2FnZSwgL3N3aWZ0LXRlc3RpbmcvKTtcblx0fSk7XG5cblx0aXQoXCJmaWx0ZXJzIHNraWxsIGNhdGFsb2cgd2l0aG91dCB1bmxvYWRpbmcgc2tpbGxzIG9yIGRpc2FibGluZyBTa2lsbCB0b29sXCIsIGFzeW5jICgpID0+IHtcblx0XHR3cml0ZVNraWxsKHRlc3REaXIsIFwiYWxwaGFcIiwgXCJVc2UgYWxwaGEuXCIpO1xuXHRcdHdyaXRlU2tpbGwodGVzdERpciwgXCJiZXRhXCIsIFwiVXNlIGJldGEuXCIpO1xuXHRcdGNvbnN0IHNlc3Npb24gPSBhd2FpdCBjcmVhdGVTZXNzaW9uKCk7XG5cblx0XHRhc3NlcnQubWF0Y2goc2Vzc2lvbi5zeXN0ZW1Qcm9tcHQsIC88bmFtZT5hbHBoYTxcXC9uYW1lPi8pO1xuXHRcdGFzc2VydC5tYXRjaChzZXNzaW9uLnN5c3RlbVByb21wdCwgLzxuYW1lPmJldGE8XFwvbmFtZT4vKTtcblxuXHRcdHNlc3Npb24uc2V0VmlzaWJsZVNraWxsc0J5TmFtZShbXCJhbHBoYVwiXSk7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChzZXNzaW9uLmdldFZpc2libGVTa2lsbE5hbWVzKCksIFtcImFscGhhXCJdKTtcblx0XHRhc3NlcnQubWF0Y2goc2Vzc2lvbi5zeXN0ZW1Qcm9tcHQsIC88bmFtZT5hbHBoYTxcXC9uYW1lPi8pO1xuXHRcdGFzc2VydC5kb2VzTm90TWF0Y2goc2Vzc2lvbi5zeXN0ZW1Qcm9tcHQsIC88bmFtZT5iZXRhPFxcL25hbWU+Lyk7XG5cblx0XHRjb25zdCB0b29sID0gc2Vzc2lvbi5zdGF0ZS50b29scy5maW5kKChlbnRyeSkgPT4gZW50cnkubmFtZSA9PT0gXCJTa2lsbFwiKTtcblx0XHRhc3NlcnQub2sodG9vbCwgXCJTa2lsbCB0b29sIHNob3VsZCByZW1haW4gYWN0aXZlXCIpO1xuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRvb2wuZXhlY3V0ZShcImNhbGwtM1wiLCB7IHNraWxsOiBcImJldGFcIiB9KTtcblx0XHRjb25zdCB0ZXh0ID0gcmVzdWx0LmNvbnRlbnRbMF0/LnR5cGUgPT09IFwidGV4dFwiID8gcmVzdWx0LmNvbnRlbnRbMF0udGV4dCA6IFwiXCI7XG5cdFx0YXNzZXJ0Lm1hdGNoKHRleHQsIC88c2tpbGwgbmFtZT1cImJldGFcIi8pO1xuXG5cdFx0c2Vzc2lvbi5zZXRWaXNpYmxlU2tpbGxzQnlOYW1lKHVuZGVmaW5lZCk7XG5cdFx0YXNzZXJ0LmVxdWFsKHNlc3Npb24uZ2V0VmlzaWJsZVNraWxsTmFtZXMoKSwgdW5kZWZpbmVkKTtcblx0XHRhc3NlcnQubWF0Y2goc2Vzc2lvbi5zeXN0ZW1Qcm9tcHQsIC88bmFtZT5hbHBoYTxcXC9uYW1lPi8pO1xuXHRcdGFzc2VydC5tYXRjaChzZXNzaW9uLnN5c3RlbVByb21wdCwgLzxuYW1lPmJldGE8XFwvbmFtZT4vKTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsYUFBYSxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsV0FBVyxZQUFZLFVBQVUsVUFBVTtBQUVwRCxTQUFTLGFBQWE7QUFDdEIsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyw2QkFBNkI7QUFDdEMsU0FBUyxzQkFBc0I7QUFDL0IsU0FBUyx1QkFBdUI7QUFFaEMsSUFBSTtBQUVKLFNBQVMsV0FBVyxLQUFhLE1BQWMsYUFBcUIsT0FBTyxLQUFLLElBQUk7QUFBQSxHQUFjO0FBQ2pH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
