import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadComponentFromDir,
  loadComponentFromAgentFile,
  scanComponentDir,
  scanAgentDir
} from "../component-loader.js";
let testDir;
function setupTestDir() {
  const dir = join(tmpdir(), `gsd-component-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanupTestDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}
describe("loadComponentFromDir (component.yaml)", () => {
  beforeEach(() => {
    testDir = setupTestDir();
  });
  afterEach(() => {
    cleanupTestDir(testDir);
  });
  it("loads a valid skill component.yaml", () => {
    const skillDir = join(testDir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "component.yaml"), `
apiVersion: gsd/v1
kind: skill
metadata:
  name: my-skill
  description: "A test skill"
  version: 1.0.0
  tags: [test, demo]
spec:
  prompt: SKILL.md
`, "utf-8");
    writeFileSync(join(skillDir, "SKILL.md"), "You are a test skill.", "utf-8");
    const result = loadComponentFromDir(skillDir, "user");
    assert.ok(result.component, "should load component");
    assert.strictEqual(result.component.kind, "skill");
    assert.strictEqual(result.component.id, "my-skill");
    assert.strictEqual(result.component.metadata.description, "A test skill");
    assert.strictEqual(result.component.metadata.version, "1.0.0");
    assert.deepStrictEqual(result.component.metadata.tags, ["test", "demo"]);
    assert.strictEqual(result.component.format, "component-yaml");
    assert.strictEqual(result.component.source, "user");
    assert.strictEqual(result.component.enabled, true);
  });
  it("loads a valid agent component.yaml", () => {
    const agentDir = join(testDir, "my-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "component.yaml"), `
apiVersion: gsd/v1
kind: agent
metadata:
  name: my-agent
  description: "A test agent"
spec:
  systemPrompt: AGENT.md
  model: claude-sonnet-4-6
  tools:
    allow: [bash, read, grep]
  maxTurns: 20
  timeoutMinutes: 5
`, "utf-8");
    writeFileSync(join(agentDir, "AGENT.md"), "You are a test agent.", "utf-8");
    const result = loadComponentFromDir(agentDir, "project");
    assert.ok(result.component);
    assert.strictEqual(result.component.kind, "agent");
    assert.strictEqual(result.component.id, "my-agent");
    assert.strictEqual(result.component.source, "project");
    assert.strictEqual(result.component.format, "component-yaml");
    const spec = result.component.spec;
    assert.strictEqual(spec.model, "claude-sonnet-4-6");
    assert.deepStrictEqual(spec.tools.allow, ["bash", "read", "grep"]);
    assert.strictEqual(spec.maxTurns, 20);
  });
  it("loads component with namespace", () => {
    const dir = join(testDir, "code-review");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "component.yaml"), `
apiVersion: gsd/v1
kind: skill
metadata:
  name: code-review
  namespace: my-plugin
  description: "Code review skill"
spec:
  prompt: SKILL.md
`, "utf-8");
    writeFileSync(join(dir, "SKILL.md"), "Review code.", "utf-8");
    const result = loadComponentFromDir(dir, "user");
    assert.ok(result.component);
    assert.strictEqual(result.component.id, "my-plugin:code-review");
    assert.strictEqual(result.component.metadata.namespace, "my-plugin");
  });
  it("returns error for missing apiVersion", () => {
    const dir = join(testDir, "bad-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "component.yaml"), `
kind: skill
metadata:
  name: bad-skill
  description: "Missing apiVersion"
spec:
  prompt: SKILL.md
`, "utf-8");
    const result = loadComponentFromDir(dir, "user");
    assert.strictEqual(result.component, null);
    assert.ok(result.diagnostics.some((d) => d.message.includes("apiVersion")));
  });
  it("returns error for unsupported apiVersion", () => {
    const dir = join(testDir, "bad-version");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "component.yaml"), `
apiVersion: gsd/v2
kind: skill
metadata:
  name: bad-version
  description: "Unsupported apiVersion"
spec:
  prompt: SKILL.md
`, "utf-8");
    writeFileSync(join(dir, "SKILL.md"), "Content.", "utf-8");
    const result = loadComponentFromDir(dir, "user");
    assert.strictEqual(result.component, null);
    assert.ok(result.diagnostics.some((d) => d.type === "error" && d.message.includes("unsupported apiVersion")));
  });
  it("returns error for missing metadata.name", () => {
    const dir = join(testDir, "no-name");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "component.yaml"), `
apiVersion: gsd/v1
kind: skill
metadata:
  description: "No name"
spec:
  prompt: SKILL.md
`, "utf-8");
    const result = loadComponentFromDir(dir, "user");
    assert.strictEqual(result.component, null);
  });
  it("returns error for invalid component.yaml metadata", () => {
    const dir = join(testDir, "bad-metadata");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "component.yaml"), `
apiVersion: gsd/v1
kind: skill
metadata:
  name: BadName
  description: "Invalid uppercase name"
spec:
  prompt: SKILL.md
`, "utf-8");
    writeFileSync(join(dir, "SKILL.md"), "Content.", "utf-8");
    const result = loadComponentFromDir(dir, "user");
    assert.strictEqual(result.component, null);
    assert.ok(result.diagnostics.some((d) => d.type === "error" && d.message.includes("lowercase")));
  });
  it("returns error for invalid YAML", () => {
    const dir = join(testDir, "bad-yaml");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "component.yaml"), "{{{{invalid yaml", "utf-8");
    const result = loadComponentFromDir(dir, "user");
    assert.strictEqual(result.component, null);
    assert.ok(result.diagnostics.some((d) => d.type === "error"));
  });
  it("returns error when a component.yaml skill prompt file is missing", () => {
    const dir = join(testDir, "missing-prompt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "component.yaml"), `
apiVersion: gsd/v1
kind: skill
metadata:
  name: missing-prompt
  description: "Missing prompt file"
spec:
  prompt: SKILL.md
`, "utf-8");
    const result = loadComponentFromDir(dir, "user");
    assert.strictEqual(result.component, null);
    assert.ok(result.diagnostics.some((d) => d.type === "error" && d.message.includes("missing referenced file")));
  });
  it("rejects unsupported component kinds in this slice", () => {
    const dir = join(testDir, "workflow");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "component.yaml"), `
apiVersion: gsd/v1
kind: pipeline
metadata:
  name: workflow
  description: "Not supported by this PR"
spec:
  steps: []
`, "utf-8");
    const result = loadComponentFromDir(dir, "user");
    assert.strictEqual(result.component, null);
    assert.ok(result.diagnostics.some((d) => d.message.includes("unsupported kind")));
  });
});
describe("loadComponentFromDir (legacy SKILL.md)", () => {
  beforeEach(() => {
    testDir = setupTestDir();
  });
  afterEach(() => {
    cleanupTestDir(testDir);
  });
  it("loads a legacy skill with frontmatter", () => {
    const skillDir = join(testDir, "review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---
name: review
description: Reviews code for quality
---

You are a code reviewer.
`, "utf-8");
    const result = loadComponentFromDir(skillDir, "user");
    assert.ok(result.component);
    assert.strictEqual(result.component.kind, "skill");
    assert.strictEqual(result.component.id, "review");
    assert.strictEqual(result.component.metadata.description, "Reviews code for quality");
    assert.strictEqual(result.component.format, "skill-md");
  });
  it("uses parent directory name when name missing from frontmatter", () => {
    const skillDir = join(testDir, "my-custom");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---
description: A custom skill
---

Content here.
`, "utf-8");
    const result = loadComponentFromDir(skillDir, "project");
    assert.ok(result.component);
    assert.strictEqual(result.component.id, "my-custom");
  });
  it("returns null when description is missing", () => {
    const skillDir = join(testDir, "no-desc");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---
name: no-desc
---

No description.
`, "utf-8");
    const result = loadComponentFromDir(skillDir, "user");
    assert.strictEqual(result.component, null);
  });
  it("prefers component.yaml over SKILL.md when both exist", () => {
    const dir = join(testDir, "dual-format");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "component.yaml"), `
apiVersion: gsd/v1
kind: skill
metadata:
  name: dual-format
  description: "From component.yaml"
spec:
  prompt: SKILL.md
`, "utf-8");
    writeFileSync(join(dir, "SKILL.md"), `---
name: dual-format
description: From SKILL.md frontmatter
---

Content.
`, "utf-8");
    const result = loadComponentFromDir(dir, "user");
    assert.ok(result.component);
    assert.strictEqual(result.component.metadata.description, "From component.yaml");
    assert.strictEqual(result.component.format, "component-yaml");
  });
});
describe("loadComponentFromAgentFile (legacy agent .md)", () => {
  beforeEach(() => {
    testDir = setupTestDir();
  });
  afterEach(() => {
    cleanupTestDir(testDir);
  });
  it("loads a legacy agent file", () => {
    const agentFile = join(testDir, "scout.md");
    writeFileSync(agentFile, `---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
---

You are a scout.
`, "utf-8");
    const result = loadComponentFromAgentFile(agentFile, "user");
    assert.ok(result.component);
    assert.strictEqual(result.component.kind, "agent");
    assert.strictEqual(result.component.id, "scout");
    assert.strictEqual(result.component.format, "agent-md");
    const spec = result.component.spec;
    assert.deepStrictEqual(spec.tools.allow, ["read", "grep", "find", "ls", "bash"]);
  });
  it("loads agent with model override", () => {
    const agentFile = join(testDir, "smart-agent.md");
    writeFileSync(agentFile, `---
name: smart-agent
description: Uses a specific model
model: claude-opus-4-6
tools: bash, read
---

You are smart.
`, "utf-8");
    const result = loadComponentFromAgentFile(agentFile, "user");
    assert.ok(result.component);
    const spec = result.component.spec;
    assert.strictEqual(spec.model, "claude-opus-4-6");
  });
  it("returns null when name is missing", () => {
    const agentFile = join(testDir, "no-name.md");
    writeFileSync(agentFile, `---
description: Missing name
---

Content.
`, "utf-8");
    const result = loadComponentFromAgentFile(agentFile, "user");
    assert.strictEqual(result.component, null);
  });
});
describe("scanComponentDir", () => {
  beforeEach(() => {
    testDir = setupTestDir();
  });
  afterEach(() => {
    cleanupTestDir(testDir);
  });
  it("scans directory with multiple components", () => {
    const skill1Dir = join(testDir, "skill-a");
    mkdirSync(skill1Dir, { recursive: true });
    writeFileSync(join(skill1Dir, "SKILL.md"), `---
name: skill-a
description: First skill
---
Content.
`, "utf-8");
    const skill2Dir = join(testDir, "skill-b");
    mkdirSync(skill2Dir, { recursive: true });
    writeFileSync(join(skill2Dir, "component.yaml"), `
apiVersion: gsd/v1
kind: skill
metadata:
  name: skill-b
  description: "Second skill"
spec:
  prompt: SKILL.md
`, "utf-8");
    writeFileSync(join(skill2Dir, "SKILL.md"), "Content.", "utf-8");
    const result = scanComponentDir(testDir, "user");
    assert.strictEqual(result.components.length, 2);
    const names = result.components.map((c) => c.id).sort();
    assert.deepStrictEqual(names, ["skill-a", "skill-b"]);
  });
  it("filters by kind when specified", () => {
    const skillDir = join(testDir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "component.yaml"), `
apiVersion: gsd/v1
kind: skill
metadata:
  name: my-skill
  description: "A skill"
spec:
  prompt: SKILL.md
`, "utf-8");
    writeFileSync(join(skillDir, "SKILL.md"), "Skill content.", "utf-8");
    const agentDir = join(testDir, "my-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "component.yaml"), `
apiVersion: gsd/v1
kind: agent
metadata:
  name: my-agent
  description: "An agent"
spec:
  systemPrompt: AGENT.md
`, "utf-8");
    writeFileSync(join(agentDir, "AGENT.md"), "Agent content.", "utf-8");
    const skillsOnly = scanComponentDir(testDir, "user", "skill");
    assert.strictEqual(skillsOnly.components.length, 1);
    assert.strictEqual(skillsOnly.components[0].kind, "skill");
    const agentsOnly = scanComponentDir(testDir, "user", "agent");
    assert.strictEqual(agentsOnly.components.length, 1);
    assert.strictEqual(agentsOnly.components[0].kind, "agent");
  });
  it("skips hidden directories", () => {
    const hiddenDir = join(testDir, ".hidden");
    mkdirSync(hiddenDir, { recursive: true });
    writeFileSync(join(hiddenDir, "SKILL.md"), `---
name: hidden
description: Should be skipped
---
`, "utf-8");
    const result = scanComponentDir(testDir, "user");
    assert.strictEqual(result.components.length, 0);
  });
  it("returns empty for non-existent directory", () => {
    const result = scanComponentDir(join(testDir, "nonexistent-dir-xyz"), "user");
    assert.strictEqual(result.components.length, 0);
    assert.strictEqual(result.diagnostics.length, 0);
  });
});
describe("scanAgentDir", () => {
  beforeEach(() => {
    testDir = setupTestDir();
  });
  afterEach(() => {
    cleanupTestDir(testDir);
  });
  it("discovers agent .md files", () => {
    writeFileSync(join(testDir, "scout.md"), `---
name: scout
description: Fast recon
tools: read, grep
---
You are a scout.
`, "utf-8");
    writeFileSync(join(testDir, "worker.md"), `---
name: worker
description: General worker
---
You are a worker.
`, "utf-8");
    const result = scanAgentDir(testDir, "user");
    assert.strictEqual(result.components.length, 2);
    assert.ok(result.components.every((c) => c.kind === "agent"));
  });
  it("prefers component.yaml directory over same-named .md file", () => {
    writeFileSync(join(testDir, "scout.md"), `---
name: scout
description: From .md file
tools: read
---
Old format.
`, "utf-8");
    const scoutDir = join(testDir, "scout");
    mkdirSync(scoutDir, { recursive: true });
    writeFileSync(join(scoutDir, "component.yaml"), `
apiVersion: gsd/v1
kind: agent
metadata:
  name: scout
  description: "From component.yaml"
spec:
  systemPrompt: AGENT.md
`, "utf-8");
    writeFileSync(join(scoutDir, "AGENT.md"), "New format.", "utf-8");
    const result = scanAgentDir(testDir, "user");
    assert.strictEqual(result.components.length, 1);
    assert.strictEqual(result.components[0].metadata.description, "From component.yaml");
    assert.strictEqual(result.components[0].format, "component-yaml");
  });
  it("discovers standalone component.yaml agent directories", () => {
    const scoutDir = join(testDir, "scout");
    mkdirSync(scoutDir, { recursive: true });
    writeFileSync(join(scoutDir, "component.yaml"), `
apiVersion: gsd/v1
kind: agent
metadata:
  name: scout
  description: "From component.yaml"
spec:
  systemPrompt: AGENT.md
`, "utf-8");
    writeFileSync(join(scoutDir, "AGENT.md"), "New format.", "utf-8");
    const result = scanAgentDir(testDir, "user");
    assert.strictEqual(result.components.length, 1);
    assert.strictEqual(result.components[0].kind, "agent");
    assert.strictEqual(result.components[0].format, "component-yaml");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21wb25lbnQtbG9hZGVyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBWZXJpZmllcyBjb21wb25lbnQgbG9hZGluZyBhY3Jvc3MgbW9kZXJuIGFuZCBsZWdhY3kgZm9ybWF0cy5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBiZWZvcmVFYWNoLCBhZnRlckVhY2ggfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgbWtkaXJTeW5jLCB3cml0ZUZpbGVTeW5jLCBybVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQge1xuXHRsb2FkQ29tcG9uZW50RnJvbURpcixcblx0bG9hZENvbXBvbmVudEZyb21BZ2VudEZpbGUsXG5cdHNjYW5Db21wb25lbnREaXIsXG5cdHNjYW5BZ2VudERpcixcbn0gZnJvbSAnLi4vY29tcG9uZW50LWxvYWRlci5qcyc7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFRlc3QgRml4dHVyZXNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxubGV0IHRlc3REaXI6IHN0cmluZztcblxuZnVuY3Rpb24gc2V0dXBUZXN0RGlyKCk6IHN0cmluZyB7XG5cdGNvbnN0IGRpciA9IGpvaW4odG1wZGlyKCksIGBnc2QtY29tcG9uZW50LXRlc3QtJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIpfWApO1xuXHRta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0cmV0dXJuIGRpcjtcbn1cblxuZnVuY3Rpb24gY2xlYW51cFRlc3REaXIoZGlyOiBzdHJpbmcpOiB2b2lkIHtcblx0cm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBsb2FkQ29tcG9uZW50RnJvbURpciBcdTIwMTQgTmV3IEZvcm1hdFxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5kZXNjcmliZSgnbG9hZENvbXBvbmVudEZyb21EaXIgKGNvbXBvbmVudC55YW1sKScsICgpID0+IHtcblx0YmVmb3JlRWFjaCgoKSA9PiB7XG5cdFx0dGVzdERpciA9IHNldHVwVGVzdERpcigpO1xuXHR9KTtcblxuXHRhZnRlckVhY2goKCkgPT4ge1xuXHRcdGNsZWFudXBUZXN0RGlyKHRlc3REaXIpO1xuXHR9KTtcblxuXHRpdCgnbG9hZHMgYSB2YWxpZCBza2lsbCBjb21wb25lbnQueWFtbCcsICgpID0+IHtcblx0XHRjb25zdCBza2lsbERpciA9IGpvaW4odGVzdERpciwgJ215LXNraWxsJyk7XG5cdFx0bWtkaXJTeW5jKHNraWxsRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oc2tpbGxEaXIsICdjb21wb25lbnQueWFtbCcpLCBgXG5hcGlWZXJzaW9uOiBnc2QvdjFcbmtpbmQ6IHNraWxsXG5tZXRhZGF0YTpcbiAgbmFtZTogbXktc2tpbGxcbiAgZGVzY3JpcHRpb246IFwiQSB0ZXN0IHNraWxsXCJcbiAgdmVyc2lvbjogMS4wLjBcbiAgdGFnczogW3Rlc3QsIGRlbW9dXG5zcGVjOlxuICBwcm9tcHQ6IFNLSUxMLm1kXG5gLCAndXRmLTgnKTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oc2tpbGxEaXIsICdTS0lMTC5tZCcpLCAnWW91IGFyZSBhIHRlc3Qgc2tpbGwuJywgJ3V0Zi04Jyk7XG5cblx0XHRjb25zdCByZXN1bHQgPSBsb2FkQ29tcG9uZW50RnJvbURpcihza2lsbERpciwgJ3VzZXInKTtcblx0XHRhc3NlcnQub2socmVzdWx0LmNvbXBvbmVudCwgJ3Nob3VsZCBsb2FkIGNvbXBvbmVudCcpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50IS5raW5kLCAnc2tpbGwnKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNvbXBvbmVudCEuaWQsICdteS1za2lsbCcpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50IS5tZXRhZGF0YS5kZXNjcmlwdGlvbiwgJ0EgdGVzdCBza2lsbCcpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50IS5tZXRhZGF0YS52ZXJzaW9uLCAnMS4wLjAnKTtcblx0XHRhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQhLm1ldGFkYXRhLnRhZ3MsIFsndGVzdCcsICdkZW1vJ10pO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50IS5mb3JtYXQsICdjb21wb25lbnQteWFtbCcpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50IS5zb3VyY2UsICd1c2VyJyk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQhLmVuYWJsZWQsIHRydWUpO1xuXHR9KTtcblxuXHRpdCgnbG9hZHMgYSB2YWxpZCBhZ2VudCBjb21wb25lbnQueWFtbCcsICgpID0+IHtcblx0XHRjb25zdCBhZ2VudERpciA9IGpvaW4odGVzdERpciwgJ215LWFnZW50Jyk7XG5cdFx0bWtkaXJTeW5jKGFnZW50RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oYWdlbnREaXIsICdjb21wb25lbnQueWFtbCcpLCBgXG5hcGlWZXJzaW9uOiBnc2QvdjFcbmtpbmQ6IGFnZW50XG5tZXRhZGF0YTpcbiAgbmFtZTogbXktYWdlbnRcbiAgZGVzY3JpcHRpb246IFwiQSB0ZXN0IGFnZW50XCJcbnNwZWM6XG4gIHN5c3RlbVByb21wdDogQUdFTlQubWRcbiAgbW9kZWw6IGNsYXVkZS1zb25uZXQtNC02XG4gIHRvb2xzOlxuICAgIGFsbG93OiBbYmFzaCwgcmVhZCwgZ3JlcF1cbiAgbWF4VHVybnM6IDIwXG4gIHRpbWVvdXRNaW51dGVzOiA1XG5gLCAndXRmLTgnKTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oYWdlbnREaXIsICdBR0VOVC5tZCcpLCAnWW91IGFyZSBhIHRlc3QgYWdlbnQuJywgJ3V0Zi04Jyk7XG5cblx0XHRjb25zdCByZXN1bHQgPSBsb2FkQ29tcG9uZW50RnJvbURpcihhZ2VudERpciwgJ3Byb2plY3QnKTtcblx0XHRhc3NlcnQub2socmVzdWx0LmNvbXBvbmVudCk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQhLmtpbmQsICdhZ2VudCcpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50IS5pZCwgJ215LWFnZW50Jyk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQhLnNvdXJjZSwgJ3Byb2plY3QnKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNvbXBvbmVudCEuZm9ybWF0LCAnY29tcG9uZW50LXlhbWwnKTtcblxuXHRcdGNvbnN0IHNwZWMgPSByZXN1bHQuY29tcG9uZW50IS5zcGVjIGFzIGFueTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoc3BlYy5tb2RlbCwgJ2NsYXVkZS1zb25uZXQtNC02Jyk7XG5cdFx0YXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzcGVjLnRvb2xzLmFsbG93LCBbJ2Jhc2gnLCAncmVhZCcsICdncmVwJ10pO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChzcGVjLm1heFR1cm5zLCAyMCk7XG5cdH0pO1xuXG5cdGl0KCdsb2FkcyBjb21wb25lbnQgd2l0aCBuYW1lc3BhY2UnLCAoKSA9PiB7XG5cdFx0Y29uc3QgZGlyID0gam9pbih0ZXN0RGlyLCAnY29kZS1yZXZpZXcnKTtcblx0XHRta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCAnY29tcG9uZW50LnlhbWwnKSwgYFxuYXBpVmVyc2lvbjogZ3NkL3YxXG5raW5kOiBza2lsbFxubWV0YWRhdGE6XG4gIG5hbWU6IGNvZGUtcmV2aWV3XG4gIG5hbWVzcGFjZTogbXktcGx1Z2luXG4gIGRlc2NyaXB0aW9uOiBcIkNvZGUgcmV2aWV3IHNraWxsXCJcbnNwZWM6XG4gIHByb21wdDogU0tJTEwubWRcbmAsICd1dGYtOCcpO1xuXHRcdHdyaXRlRmlsZVN5bmMoam9pbihkaXIsICdTS0lMTC5tZCcpLCAnUmV2aWV3IGNvZGUuJywgJ3V0Zi04Jyk7XG5cblx0XHRjb25zdCByZXN1bHQgPSBsb2FkQ29tcG9uZW50RnJvbURpcihkaXIsICd1c2VyJyk7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdC5jb21wb25lbnQpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50IS5pZCwgJ215LXBsdWdpbjpjb2RlLXJldmlldycpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50IS5tZXRhZGF0YS5uYW1lc3BhY2UsICdteS1wbHVnaW4nKTtcblx0fSk7XG5cblx0aXQoJ3JldHVybnMgZXJyb3IgZm9yIG1pc3NpbmcgYXBpVmVyc2lvbicsICgpID0+IHtcblx0XHRjb25zdCBkaXIgPSBqb2luKHRlc3REaXIsICdiYWQtc2tpbGwnKTtcblx0XHRta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCAnY29tcG9uZW50LnlhbWwnKSwgYFxua2luZDogc2tpbGxcbm1ldGFkYXRhOlxuICBuYW1lOiBiYWQtc2tpbGxcbiAgZGVzY3JpcHRpb246IFwiTWlzc2luZyBhcGlWZXJzaW9uXCJcbnNwZWM6XG4gIHByb21wdDogU0tJTEwubWRcbmAsICd1dGYtOCcpO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gbG9hZENvbXBvbmVudEZyb21EaXIoZGlyLCAndXNlcicpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50LCBudWxsKTtcblx0XHRhc3NlcnQub2socmVzdWx0LmRpYWdub3N0aWNzLnNvbWUoZCA9PiBkLm1lc3NhZ2UuaW5jbHVkZXMoJ2FwaVZlcnNpb24nKSkpO1xuXHR9KTtcblxuXHRpdCgncmV0dXJucyBlcnJvciBmb3IgdW5zdXBwb3J0ZWQgYXBpVmVyc2lvbicsICgpID0+IHtcblx0XHRjb25zdCBkaXIgPSBqb2luKHRlc3REaXIsICdiYWQtdmVyc2lvbicpO1xuXHRcdG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdHdyaXRlRmlsZVN5bmMoam9pbihkaXIsICdjb21wb25lbnQueWFtbCcpLCBgXG5hcGlWZXJzaW9uOiBnc2QvdjJcbmtpbmQ6IHNraWxsXG5tZXRhZGF0YTpcbiAgbmFtZTogYmFkLXZlcnNpb25cbiAgZGVzY3JpcHRpb246IFwiVW5zdXBwb3J0ZWQgYXBpVmVyc2lvblwiXG5zcGVjOlxuICBwcm9tcHQ6IFNLSUxMLm1kXG5gLCAndXRmLTgnKTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCAnU0tJTEwubWQnKSwgJ0NvbnRlbnQuJywgJ3V0Zi04Jyk7XG5cblx0XHRjb25zdCByZXN1bHQgPSBsb2FkQ29tcG9uZW50RnJvbURpcihkaXIsICd1c2VyJyk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQsIG51bGwpO1xuXHRcdGFzc2VydC5vayhyZXN1bHQuZGlhZ25vc3RpY3Muc29tZShkID0+IGQudHlwZSA9PT0gJ2Vycm9yJyAmJiBkLm1lc3NhZ2UuaW5jbHVkZXMoJ3Vuc3VwcG9ydGVkIGFwaVZlcnNpb24nKSkpO1xuXHR9KTtcblxuXHRpdCgncmV0dXJucyBlcnJvciBmb3IgbWlzc2luZyBtZXRhZGF0YS5uYW1lJywgKCkgPT4ge1xuXHRcdGNvbnN0IGRpciA9IGpvaW4odGVzdERpciwgJ25vLW5hbWUnKTtcblx0XHRta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCAnY29tcG9uZW50LnlhbWwnKSwgYFxuYXBpVmVyc2lvbjogZ3NkL3YxXG5raW5kOiBza2lsbFxubWV0YWRhdGE6XG4gIGRlc2NyaXB0aW9uOiBcIk5vIG5hbWVcIlxuc3BlYzpcbiAgcHJvbXB0OiBTS0lMTC5tZFxuYCwgJ3V0Zi04Jyk7XG5cblx0XHRjb25zdCByZXN1bHQgPSBsb2FkQ29tcG9uZW50RnJvbURpcihkaXIsICd1c2VyJyk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQsIG51bGwpO1xuXHR9KTtcblxuXHRpdCgncmV0dXJucyBlcnJvciBmb3IgaW52YWxpZCBjb21wb25lbnQueWFtbCBtZXRhZGF0YScsICgpID0+IHtcblx0XHRjb25zdCBkaXIgPSBqb2luKHRlc3REaXIsICdiYWQtbWV0YWRhdGEnKTtcblx0XHRta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCAnY29tcG9uZW50LnlhbWwnKSwgYFxuYXBpVmVyc2lvbjogZ3NkL3YxXG5raW5kOiBza2lsbFxubWV0YWRhdGE6XG4gIG5hbWU6IEJhZE5hbWVcbiAgZGVzY3JpcHRpb246IFwiSW52YWxpZCB1cHBlcmNhc2UgbmFtZVwiXG5zcGVjOlxuICBwcm9tcHQ6IFNLSUxMLm1kXG5gLCAndXRmLTgnKTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCAnU0tJTEwubWQnKSwgJ0NvbnRlbnQuJywgJ3V0Zi04Jyk7XG5cblx0XHRjb25zdCByZXN1bHQgPSBsb2FkQ29tcG9uZW50RnJvbURpcihkaXIsICd1c2VyJyk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQsIG51bGwpO1xuXHRcdGFzc2VydC5vayhyZXN1bHQuZGlhZ25vc3RpY3Muc29tZShkID0+IGQudHlwZSA9PT0gJ2Vycm9yJyAmJiBkLm1lc3NhZ2UuaW5jbHVkZXMoJ2xvd2VyY2FzZScpKSk7XG5cdH0pO1xuXG5cdGl0KCdyZXR1cm5zIGVycm9yIGZvciBpbnZhbGlkIFlBTUwnLCAoKSA9PiB7XG5cdFx0Y29uc3QgZGlyID0gam9pbih0ZXN0RGlyLCAnYmFkLXlhbWwnKTtcblx0XHRta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCAnY29tcG9uZW50LnlhbWwnKSwgJ3t7e3tpbnZhbGlkIHlhbWwnLCAndXRmLTgnKTtcblxuXHRcdGNvbnN0IHJlc3VsdCA9IGxvYWRDb21wb25lbnRGcm9tRGlyKGRpciwgJ3VzZXInKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNvbXBvbmVudCwgbnVsbCk7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdC5kaWFnbm9zdGljcy5zb21lKGQgPT4gZC50eXBlID09PSAnZXJyb3InKSk7XG5cdH0pO1xuXG5cdGl0KCdyZXR1cm5zIGVycm9yIHdoZW4gYSBjb21wb25lbnQueWFtbCBza2lsbCBwcm9tcHQgZmlsZSBpcyBtaXNzaW5nJywgKCkgPT4ge1xuXHRcdGNvbnN0IGRpciA9IGpvaW4odGVzdERpciwgJ21pc3NpbmctcHJvbXB0Jyk7XG5cdFx0bWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdFx0d3JpdGVGaWxlU3luYyhqb2luKGRpciwgJ2NvbXBvbmVudC55YW1sJyksIGBcbmFwaVZlcnNpb246IGdzZC92MVxua2luZDogc2tpbGxcbm1ldGFkYXRhOlxuICBuYW1lOiBtaXNzaW5nLXByb21wdFxuICBkZXNjcmlwdGlvbjogXCJNaXNzaW5nIHByb21wdCBmaWxlXCJcbnNwZWM6XG4gIHByb21wdDogU0tJTEwubWRcbmAsICd1dGYtOCcpO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gbG9hZENvbXBvbmVudEZyb21EaXIoZGlyLCAndXNlcicpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50LCBudWxsKTtcblx0XHRhc3NlcnQub2socmVzdWx0LmRpYWdub3N0aWNzLnNvbWUoZCA9PiBkLnR5cGUgPT09ICdlcnJvcicgJiYgZC5tZXNzYWdlLmluY2x1ZGVzKCdtaXNzaW5nIHJlZmVyZW5jZWQgZmlsZScpKSk7XG5cdH0pO1xuXG5cdGl0KCdyZWplY3RzIHVuc3VwcG9ydGVkIGNvbXBvbmVudCBraW5kcyBpbiB0aGlzIHNsaWNlJywgKCkgPT4ge1xuXHRcdGNvbnN0IGRpciA9IGpvaW4odGVzdERpciwgJ3dvcmtmbG93Jyk7XG5cdFx0bWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdFx0d3JpdGVGaWxlU3luYyhqb2luKGRpciwgJ2NvbXBvbmVudC55YW1sJyksIGBcbmFwaVZlcnNpb246IGdzZC92MVxua2luZDogcGlwZWxpbmVcbm1ldGFkYXRhOlxuICBuYW1lOiB3b3JrZmxvd1xuICBkZXNjcmlwdGlvbjogXCJOb3Qgc3VwcG9ydGVkIGJ5IHRoaXMgUFJcIlxuc3BlYzpcbiAgc3RlcHM6IFtdXG5gLCAndXRmLTgnKTtcblxuXHRcdGNvbnN0IHJlc3VsdCA9IGxvYWRDb21wb25lbnRGcm9tRGlyKGRpciwgJ3VzZXInKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNvbXBvbmVudCwgbnVsbCk7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdC5kaWFnbm9zdGljcy5zb21lKGQgPT4gZC5tZXNzYWdlLmluY2x1ZGVzKCd1bnN1cHBvcnRlZCBraW5kJykpKTtcblx0fSk7XG59KTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gbG9hZENvbXBvbmVudEZyb21EaXIgXHUyMDE0IExlZ2FjeSBTa2lsbCBGb3JtYXRcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZGVzY3JpYmUoJ2xvYWRDb21wb25lbnRGcm9tRGlyIChsZWdhY3kgU0tJTEwubWQpJywgKCkgPT4ge1xuXHRiZWZvcmVFYWNoKCgpID0+IHtcblx0XHR0ZXN0RGlyID0gc2V0dXBUZXN0RGlyKCk7XG5cdH0pO1xuXG5cdGFmdGVyRWFjaCgoKSA9PiB7XG5cdFx0Y2xlYW51cFRlc3REaXIodGVzdERpcik7XG5cdH0pO1xuXG5cdGl0KCdsb2FkcyBhIGxlZ2FjeSBza2lsbCB3aXRoIGZyb250bWF0dGVyJywgKCkgPT4ge1xuXHRcdGNvbnN0IHNraWxsRGlyID0gam9pbih0ZXN0RGlyLCAncmV2aWV3Jyk7XG5cdFx0bWtkaXJTeW5jKHNraWxsRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oc2tpbGxEaXIsICdTS0lMTC5tZCcpLCBgLS0tXG5uYW1lOiByZXZpZXdcbmRlc2NyaXB0aW9uOiBSZXZpZXdzIGNvZGUgZm9yIHF1YWxpdHlcbi0tLVxuXG5Zb3UgYXJlIGEgY29kZSByZXZpZXdlci5cbmAsICd1dGYtOCcpO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gbG9hZENvbXBvbmVudEZyb21EaXIoc2tpbGxEaXIsICd1c2VyJyk7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdC5jb21wb25lbnQpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50IS5raW5kLCAnc2tpbGwnKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNvbXBvbmVudCEuaWQsICdyZXZpZXcnKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNvbXBvbmVudCEubWV0YWRhdGEuZGVzY3JpcHRpb24sICdSZXZpZXdzIGNvZGUgZm9yIHF1YWxpdHknKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNvbXBvbmVudCEuZm9ybWF0LCAnc2tpbGwtbWQnKTtcblx0fSk7XG5cblx0aXQoJ3VzZXMgcGFyZW50IGRpcmVjdG9yeSBuYW1lIHdoZW4gbmFtZSBtaXNzaW5nIGZyb20gZnJvbnRtYXR0ZXInLCAoKSA9PiB7XG5cdFx0Y29uc3Qgc2tpbGxEaXIgPSBqb2luKHRlc3REaXIsICdteS1jdXN0b20nKTtcblx0XHRta2RpclN5bmMoc2tpbGxEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdHdyaXRlRmlsZVN5bmMoam9pbihza2lsbERpciwgJ1NLSUxMLm1kJyksIGAtLS1cbmRlc2NyaXB0aW9uOiBBIGN1c3RvbSBza2lsbFxuLS0tXG5cbkNvbnRlbnQgaGVyZS5cbmAsICd1dGYtOCcpO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gbG9hZENvbXBvbmVudEZyb21EaXIoc2tpbGxEaXIsICdwcm9qZWN0Jyk7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdC5jb21wb25lbnQpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50IS5pZCwgJ215LWN1c3RvbScpO1xuXHR9KTtcblxuXHRpdCgncmV0dXJucyBudWxsIHdoZW4gZGVzY3JpcHRpb24gaXMgbWlzc2luZycsICgpID0+IHtcblx0XHRjb25zdCBza2lsbERpciA9IGpvaW4odGVzdERpciwgJ25vLWRlc2MnKTtcblx0XHRta2RpclN5bmMoc2tpbGxEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdHdyaXRlRmlsZVN5bmMoam9pbihza2lsbERpciwgJ1NLSUxMLm1kJyksIGAtLS1cbm5hbWU6IG5vLWRlc2Ncbi0tLVxuXG5ObyBkZXNjcmlwdGlvbi5cbmAsICd1dGYtOCcpO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gbG9hZENvbXBvbmVudEZyb21EaXIoc2tpbGxEaXIsICd1c2VyJyk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQsIG51bGwpO1xuXHR9KTtcblxuXHRpdCgncHJlZmVycyBjb21wb25lbnQueWFtbCBvdmVyIFNLSUxMLm1kIHdoZW4gYm90aCBleGlzdCcsICgpID0+IHtcblx0XHRjb25zdCBkaXIgPSBqb2luKHRlc3REaXIsICdkdWFsLWZvcm1hdCcpO1xuXHRcdG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdHdyaXRlRmlsZVN5bmMoam9pbihkaXIsICdjb21wb25lbnQueWFtbCcpLCBgXG5hcGlWZXJzaW9uOiBnc2QvdjFcbmtpbmQ6IHNraWxsXG5tZXRhZGF0YTpcbiAgbmFtZTogZHVhbC1mb3JtYXRcbiAgZGVzY3JpcHRpb246IFwiRnJvbSBjb21wb25lbnQueWFtbFwiXG5zcGVjOlxuICBwcm9tcHQ6IFNLSUxMLm1kXG5gLCAndXRmLTgnKTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oZGlyLCAnU0tJTEwubWQnKSwgYC0tLVxubmFtZTogZHVhbC1mb3JtYXRcbmRlc2NyaXB0aW9uOiBGcm9tIFNLSUxMLm1kIGZyb250bWF0dGVyXG4tLS1cblxuQ29udGVudC5cbmAsICd1dGYtOCcpO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gbG9hZENvbXBvbmVudEZyb21EaXIoZGlyLCAndXNlcicpO1xuXHRcdGFzc2VydC5vayhyZXN1bHQuY29tcG9uZW50KTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNvbXBvbmVudCEubWV0YWRhdGEuZGVzY3JpcHRpb24sICdGcm9tIGNvbXBvbmVudC55YW1sJyk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQhLmZvcm1hdCwgJ2NvbXBvbmVudC15YW1sJyk7XG5cdH0pO1xufSk7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIGxvYWRDb21wb25lbnRGcm9tQWdlbnRGaWxlIFx1MjAxNCBMZWdhY3kgQWdlbnQgRm9ybWF0XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmRlc2NyaWJlKCdsb2FkQ29tcG9uZW50RnJvbUFnZW50RmlsZSAobGVnYWN5IGFnZW50IC5tZCknLCAoKSA9PiB7XG5cdGJlZm9yZUVhY2goKCkgPT4ge1xuXHRcdHRlc3REaXIgPSBzZXR1cFRlc3REaXIoKTtcblx0fSk7XG5cblx0YWZ0ZXJFYWNoKCgpID0+IHtcblx0XHRjbGVhbnVwVGVzdERpcih0ZXN0RGlyKTtcblx0fSk7XG5cblx0aXQoJ2xvYWRzIGEgbGVnYWN5IGFnZW50IGZpbGUnLCAoKSA9PiB7XG5cdFx0Y29uc3QgYWdlbnRGaWxlID0gam9pbih0ZXN0RGlyLCAnc2NvdXQubWQnKTtcblx0XHR3cml0ZUZpbGVTeW5jKGFnZW50RmlsZSwgYC0tLVxubmFtZTogc2NvdXRcbmRlc2NyaXB0aW9uOiBGYXN0IGNvZGViYXNlIHJlY29uXG50b29sczogcmVhZCwgZ3JlcCwgZmluZCwgbHMsIGJhc2hcbi0tLVxuXG5Zb3UgYXJlIGEgc2NvdXQuXG5gLCAndXRmLTgnKTtcblxuXHRcdGNvbnN0IHJlc3VsdCA9IGxvYWRDb21wb25lbnRGcm9tQWdlbnRGaWxlKGFnZW50RmlsZSwgJ3VzZXInKTtcblx0XHRhc3NlcnQub2socmVzdWx0LmNvbXBvbmVudCk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQhLmtpbmQsICdhZ2VudCcpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50IS5pZCwgJ3Njb3V0Jyk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQhLmZvcm1hdCwgJ2FnZW50LW1kJyk7XG5cblx0XHRjb25zdCBzcGVjID0gcmVzdWx0LmNvbXBvbmVudCEuc3BlYyBhcyBhbnk7XG5cdFx0YXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChzcGVjLnRvb2xzLmFsbG93LCBbJ3JlYWQnLCAnZ3JlcCcsICdmaW5kJywgJ2xzJywgJ2Jhc2gnXSk7XG5cdH0pO1xuXG5cdGl0KCdsb2FkcyBhZ2VudCB3aXRoIG1vZGVsIG92ZXJyaWRlJywgKCkgPT4ge1xuXHRcdGNvbnN0IGFnZW50RmlsZSA9IGpvaW4odGVzdERpciwgJ3NtYXJ0LWFnZW50Lm1kJyk7XG5cdFx0d3JpdGVGaWxlU3luYyhhZ2VudEZpbGUsIGAtLS1cbm5hbWU6IHNtYXJ0LWFnZW50XG5kZXNjcmlwdGlvbjogVXNlcyBhIHNwZWNpZmljIG1vZGVsXG5tb2RlbDogY2xhdWRlLW9wdXMtNC02XG50b29sczogYmFzaCwgcmVhZFxuLS0tXG5cbllvdSBhcmUgc21hcnQuXG5gLCAndXRmLTgnKTtcblxuXHRcdGNvbnN0IHJlc3VsdCA9IGxvYWRDb21wb25lbnRGcm9tQWdlbnRGaWxlKGFnZW50RmlsZSwgJ3VzZXInKTtcblx0XHRhc3NlcnQub2socmVzdWx0LmNvbXBvbmVudCk7XG5cblx0XHRjb25zdCBzcGVjID0gcmVzdWx0LmNvbXBvbmVudCEuc3BlYyBhcyBhbnk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNwZWMubW9kZWwsICdjbGF1ZGUtb3B1cy00LTYnKTtcblx0fSk7XG5cblx0aXQoJ3JldHVybnMgbnVsbCB3aGVuIG5hbWUgaXMgbWlzc2luZycsICgpID0+IHtcblx0XHRjb25zdCBhZ2VudEZpbGUgPSBqb2luKHRlc3REaXIsICduby1uYW1lLm1kJyk7XG5cdFx0d3JpdGVGaWxlU3luYyhhZ2VudEZpbGUsIGAtLS1cbmRlc2NyaXB0aW9uOiBNaXNzaW5nIG5hbWVcbi0tLVxuXG5Db250ZW50LlxuYCwgJ3V0Zi04Jyk7XG5cblx0XHRjb25zdCByZXN1bHQgPSBsb2FkQ29tcG9uZW50RnJvbUFnZW50RmlsZShhZ2VudEZpbGUsICd1c2VyJyk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnQsIG51bGwpO1xuXHR9KTtcbn0pO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBzY2FuQ29tcG9uZW50RGlyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmRlc2NyaWJlKCdzY2FuQ29tcG9uZW50RGlyJywgKCkgPT4ge1xuXHRiZWZvcmVFYWNoKCgpID0+IHtcblx0XHR0ZXN0RGlyID0gc2V0dXBUZXN0RGlyKCk7XG5cdH0pO1xuXG5cdGFmdGVyRWFjaCgoKSA9PiB7XG5cdFx0Y2xlYW51cFRlc3REaXIodGVzdERpcik7XG5cdH0pO1xuXG5cdGl0KCdzY2FucyBkaXJlY3Rvcnkgd2l0aCBtdWx0aXBsZSBjb21wb25lbnRzJywgKCkgPT4ge1xuXHRcdC8vIENyZWF0ZSB0d28gc2tpbGwgZGlyZWN0b3JpZXNcblx0XHRjb25zdCBza2lsbDFEaXIgPSBqb2luKHRlc3REaXIsICdza2lsbC1hJyk7XG5cdFx0bWtkaXJTeW5jKHNraWxsMURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdFx0d3JpdGVGaWxlU3luYyhqb2luKHNraWxsMURpciwgJ1NLSUxMLm1kJyksIGAtLS1cbm5hbWU6IHNraWxsLWFcbmRlc2NyaXB0aW9uOiBGaXJzdCBza2lsbFxuLS0tXG5Db250ZW50LlxuYCwgJ3V0Zi04Jyk7XG5cblx0XHRjb25zdCBza2lsbDJEaXIgPSBqb2luKHRlc3REaXIsICdza2lsbC1iJyk7XG5cdFx0bWtkaXJTeW5jKHNraWxsMkRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdFx0d3JpdGVGaWxlU3luYyhqb2luKHNraWxsMkRpciwgJ2NvbXBvbmVudC55YW1sJyksIGBcbmFwaVZlcnNpb246IGdzZC92MVxua2luZDogc2tpbGxcbm1ldGFkYXRhOlxuICBuYW1lOiBza2lsbC1iXG4gIGRlc2NyaXB0aW9uOiBcIlNlY29uZCBza2lsbFwiXG5zcGVjOlxuICBwcm9tcHQ6IFNLSUxMLm1kXG5gLCAndXRmLTgnKTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oc2tpbGwyRGlyLCAnU0tJTEwubWQnKSwgJ0NvbnRlbnQuJywgJ3V0Zi04Jyk7XG5cblx0XHRjb25zdCByZXN1bHQgPSBzY2FuQ29tcG9uZW50RGlyKHRlc3REaXIsICd1c2VyJyk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnRzLmxlbmd0aCwgMik7XG5cblx0XHRjb25zdCBuYW1lcyA9IHJlc3VsdC5jb21wb25lbnRzLm1hcChjID0+IGMuaWQpLnNvcnQoKTtcblx0XHRhc3NlcnQuZGVlcFN0cmljdEVxdWFsKG5hbWVzLCBbJ3NraWxsLWEnLCAnc2tpbGwtYiddKTtcblx0fSk7XG5cblx0aXQoJ2ZpbHRlcnMgYnkga2luZCB3aGVuIHNwZWNpZmllZCcsICgpID0+IHtcblx0XHQvLyBDcmVhdGUgYSBza2lsbCBhbmQgYW4gYWdlbnRcblx0XHRjb25zdCBza2lsbERpciA9IGpvaW4odGVzdERpciwgJ215LXNraWxsJyk7XG5cdFx0bWtkaXJTeW5jKHNraWxsRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oc2tpbGxEaXIsICdjb21wb25lbnQueWFtbCcpLCBgXG5hcGlWZXJzaW9uOiBnc2QvdjFcbmtpbmQ6IHNraWxsXG5tZXRhZGF0YTpcbiAgbmFtZTogbXktc2tpbGxcbiAgZGVzY3JpcHRpb246IFwiQSBza2lsbFwiXG5zcGVjOlxuICBwcm9tcHQ6IFNLSUxMLm1kXG5gLCAndXRmLTgnKTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oc2tpbGxEaXIsICdTS0lMTC5tZCcpLCAnU2tpbGwgY29udGVudC4nLCAndXRmLTgnKTtcblxuXHRcdGNvbnN0IGFnZW50RGlyID0gam9pbih0ZXN0RGlyLCAnbXktYWdlbnQnKTtcblx0XHRta2RpclN5bmMoYWdlbnREaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdHdyaXRlRmlsZVN5bmMoam9pbihhZ2VudERpciwgJ2NvbXBvbmVudC55YW1sJyksIGBcbmFwaVZlcnNpb246IGdzZC92MVxua2luZDogYWdlbnRcbm1ldGFkYXRhOlxuICBuYW1lOiBteS1hZ2VudFxuICBkZXNjcmlwdGlvbjogXCJBbiBhZ2VudFwiXG5zcGVjOlxuICBzeXN0ZW1Qcm9tcHQ6IEFHRU5ULm1kXG5gLCAndXRmLTgnKTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oYWdlbnREaXIsICdBR0VOVC5tZCcpLCAnQWdlbnQgY29udGVudC4nLCAndXRmLTgnKTtcblxuXHRcdGNvbnN0IHNraWxsc09ubHkgPSBzY2FuQ29tcG9uZW50RGlyKHRlc3REaXIsICd1c2VyJywgJ3NraWxsJyk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHNraWxsc09ubHkuY29tcG9uZW50cy5sZW5ndGgsIDEpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChza2lsbHNPbmx5LmNvbXBvbmVudHNbMF0ua2luZCwgJ3NraWxsJyk7XG5cblx0XHRjb25zdCBhZ2VudHNPbmx5ID0gc2NhbkNvbXBvbmVudERpcih0ZXN0RGlyLCAndXNlcicsICdhZ2VudCcpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChhZ2VudHNPbmx5LmNvbXBvbmVudHMubGVuZ3RoLCAxKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwoYWdlbnRzT25seS5jb21wb25lbnRzWzBdLmtpbmQsICdhZ2VudCcpO1xuXHR9KTtcblxuXHRpdCgnc2tpcHMgaGlkZGVuIGRpcmVjdG9yaWVzJywgKCkgPT4ge1xuXHRcdGNvbnN0IGhpZGRlbkRpciA9IGpvaW4odGVzdERpciwgJy5oaWRkZW4nKTtcblx0XHRta2RpclN5bmMoaGlkZGVuRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oaGlkZGVuRGlyLCAnU0tJTEwubWQnKSwgYC0tLVxubmFtZTogaGlkZGVuXG5kZXNjcmlwdGlvbjogU2hvdWxkIGJlIHNraXBwZWRcbi0tLVxuYCwgJ3V0Zi04Jyk7XG5cblx0XHRjb25zdCByZXN1bHQgPSBzY2FuQ29tcG9uZW50RGlyKHRlc3REaXIsICd1c2VyJyk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnRzLmxlbmd0aCwgMCk7XG5cdH0pO1xuXG5cdGl0KCdyZXR1cm5zIGVtcHR5IGZvciBub24tZXhpc3RlbnQgZGlyZWN0b3J5JywgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IHNjYW5Db21wb25lbnREaXIoam9pbih0ZXN0RGlyLCAnbm9uZXhpc3RlbnQtZGlyLXh5eicpLCAndXNlcicpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50cy5sZW5ndGgsIDApO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuZGlhZ25vc3RpY3MubGVuZ3RoLCAwKTtcblx0fSk7XG59KTtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gc2NhbkFnZW50RGlyXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmRlc2NyaWJlKCdzY2FuQWdlbnREaXInLCAoKSA9PiB7XG5cdGJlZm9yZUVhY2goKCkgPT4ge1xuXHRcdHRlc3REaXIgPSBzZXR1cFRlc3REaXIoKTtcblx0fSk7XG5cblx0YWZ0ZXJFYWNoKCgpID0+IHtcblx0XHRjbGVhbnVwVGVzdERpcih0ZXN0RGlyKTtcblx0fSk7XG5cblx0aXQoJ2Rpc2NvdmVycyBhZ2VudCAubWQgZmlsZXMnLCAoKSA9PiB7XG5cdFx0d3JpdGVGaWxlU3luYyhqb2luKHRlc3REaXIsICdzY291dC5tZCcpLCBgLS0tXG5uYW1lOiBzY291dFxuZGVzY3JpcHRpb246IEZhc3QgcmVjb25cbnRvb2xzOiByZWFkLCBncmVwXG4tLS1cbllvdSBhcmUgYSBzY291dC5cbmAsICd1dGYtOCcpO1xuXG5cdFx0d3JpdGVGaWxlU3luYyhqb2luKHRlc3REaXIsICd3b3JrZXIubWQnKSwgYC0tLVxubmFtZTogd29ya2VyXG5kZXNjcmlwdGlvbjogR2VuZXJhbCB3b3JrZXJcbi0tLVxuWW91IGFyZSBhIHdvcmtlci5cbmAsICd1dGYtOCcpO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gc2NhbkFnZW50RGlyKHRlc3REaXIsICd1c2VyJyk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnRzLmxlbmd0aCwgMik7XG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdC5jb21wb25lbnRzLmV2ZXJ5KGMgPT4gYy5raW5kID09PSAnYWdlbnQnKSk7XG5cdH0pO1xuXG5cdGl0KCdwcmVmZXJzIGNvbXBvbmVudC55YW1sIGRpcmVjdG9yeSBvdmVyIHNhbWUtbmFtZWQgLm1kIGZpbGUnLCAoKSA9PiB7XG5cdFx0Ly8gQ3JlYXRlIGJvdGggZm9ybWF0cyBmb3Igc2FtZSBhZ2VudFxuXHRcdHdyaXRlRmlsZVN5bmMoam9pbih0ZXN0RGlyLCAnc2NvdXQubWQnKSwgYC0tLVxubmFtZTogc2NvdXRcbmRlc2NyaXB0aW9uOiBGcm9tIC5tZCBmaWxlXG50b29sczogcmVhZFxuLS0tXG5PbGQgZm9ybWF0LlxuYCwgJ3V0Zi04Jyk7XG5cblx0XHRjb25zdCBzY291dERpciA9IGpvaW4odGVzdERpciwgJ3Njb3V0Jyk7XG5cdFx0bWtkaXJTeW5jKHNjb3V0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oc2NvdXREaXIsICdjb21wb25lbnQueWFtbCcpLCBgXG5hcGlWZXJzaW9uOiBnc2QvdjFcbmtpbmQ6IGFnZW50XG5tZXRhZGF0YTpcbiAgbmFtZTogc2NvdXRcbiAgZGVzY3JpcHRpb246IFwiRnJvbSBjb21wb25lbnQueWFtbFwiXG5zcGVjOlxuICBzeXN0ZW1Qcm9tcHQ6IEFHRU5ULm1kXG5gLCAndXRmLTgnKTtcblx0XHR3cml0ZUZpbGVTeW5jKGpvaW4oc2NvdXREaXIsICdBR0VOVC5tZCcpLCAnTmV3IGZvcm1hdC4nLCAndXRmLTgnKTtcblxuXHRcdGNvbnN0IHJlc3VsdCA9IHNjYW5BZ2VudERpcih0ZXN0RGlyLCAndXNlcicpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50cy5sZW5ndGgsIDEpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50c1swXS5tZXRhZGF0YS5kZXNjcmlwdGlvbiwgJ0Zyb20gY29tcG9uZW50LnlhbWwnKTtcblx0XHRhc3NlcnQuc3RyaWN0RXF1YWwocmVzdWx0LmNvbXBvbmVudHNbMF0uZm9ybWF0LCAnY29tcG9uZW50LXlhbWwnKTtcblx0fSk7XG5cblx0aXQoJ2Rpc2NvdmVycyBzdGFuZGFsb25lIGNvbXBvbmVudC55YW1sIGFnZW50IGRpcmVjdG9yaWVzJywgKCkgPT4ge1xuXHRcdGNvbnN0IHNjb3V0RGlyID0gam9pbih0ZXN0RGlyLCAnc2NvdXQnKTtcblx0XHRta2RpclN5bmMoc2NvdXREaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdHdyaXRlRmlsZVN5bmMoam9pbihzY291dERpciwgJ2NvbXBvbmVudC55YW1sJyksIGBcbmFwaVZlcnNpb246IGdzZC92MVxua2luZDogYWdlbnRcbm1ldGFkYXRhOlxuICBuYW1lOiBzY291dFxuICBkZXNjcmlwdGlvbjogXCJGcm9tIGNvbXBvbmVudC55YW1sXCJcbnNwZWM6XG4gIHN5c3RlbVByb21wdDogQUdFTlQubWRcbmAsICd1dGYtOCcpO1xuXHRcdHdyaXRlRmlsZVN5bmMoam9pbihzY291dERpciwgJ0FHRU5ULm1kJyksICdOZXcgZm9ybWF0LicsICd1dGYtOCcpO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gc2NhbkFnZW50RGlyKHRlc3REaXIsICd1c2VyJyk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnRzLmxlbmd0aCwgMSk7XG5cdFx0YXNzZXJ0LnN0cmljdEVxdWFsKHJlc3VsdC5jb21wb25lbnRzWzBdLmtpbmQsICdhZ2VudCcpO1xuXHRcdGFzc2VydC5zdHJpY3RFcXVhbChyZXN1bHQuY29tcG9uZW50c1swXS5mb3JtYXQsICdjb21wb25lbnQteWFtbCcpO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsU0FBUyxVQUFVLElBQUksWUFBWSxpQkFBaUI7QUFDcEQsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxlQUFlLGNBQWM7QUFDakQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUN2QjtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBTVAsSUFBSTtBQUVKLFNBQVMsZUFBdUI7QUFDL0IsUUFBTSxNQUFNLEtBQUssT0FBTyxHQUFHLHNCQUFzQixLQUFLLElBQUksQ0FBQyxJQUFJLEtBQUssT0FBTyxFQUFFLFNBQVMsRUFBRSxFQUFFLE1BQU0sQ0FBQyxDQUFDLEVBQUU7QUFDcEcsWUFBVSxLQUFLLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbEMsU0FBTztBQUNSO0FBRUEsU0FBUyxlQUFlLEtBQW1CO0FBQzFDLFNBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUM3QztBQU1BLFNBQVMseUNBQXlDLE1BQU07QUFDdkQsYUFBVyxNQUFNO0FBQ2hCLGNBQVUsYUFBYTtBQUFBLEVBQ3hCLENBQUM7QUFFRCxZQUFVLE1BQU07QUFDZixtQkFBZSxPQUFPO0FBQUEsRUFDdkIsQ0FBQztBQUVELEtBQUcsc0NBQXNDLE1BQU07QUFDOUMsVUFBTSxXQUFXLEtBQUssU0FBUyxVQUFV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
