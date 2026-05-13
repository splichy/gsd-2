import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAgents } from "../../subagent/agents.js";
function makeProjectRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "gsd-subagent-agents-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function writeAgent(root, configDirName, name = "ping") {
  const agentsDir = join(root, configDirName, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, `${name}.md`),
    `---
name: ${name}
description: ${name} agent
---
Say hello
`
  );
  return agentsDir;
}
test("discoverAgents finds project agents in .gsd/agents", (t) => {
  const root = makeProjectRoot(t);
  const agentsDir = writeAgent(root, ".gsd");
  const discovery = discoverAgents(root, "project");
  assert.equal(discovery.projectAgentsDir, agentsDir);
  assert.deepEqual(discovery.agents.map((agent) => agent.name), ["ping"]);
  assert.equal(discovery.agents[0]?.source, "project");
});
test("discoverAgents falls back to legacy .pi/agents when needed", (t) => {
  const root = makeProjectRoot(t);
  const agentsDir = writeAgent(root, ".pi");
  const discovery = discoverAgents(root, "project");
  assert.equal(discovery.projectAgentsDir, agentsDir);
  assert.deepEqual(discovery.agents.map((agent) => agent.name), ["ping"]);
});
test("discoverAgents accepts tools frontmatter as a YAML list", (t) => {
  const root = makeProjectRoot(t);
  const agentsDir = join(root, ".gsd", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: review agent",
      "tools:",
      "  - bash",
      "  - read",
      "---",
      "Review code",
      ""
    ].join("\n")
  );
  const discovery = discoverAgents(root, "project");
  assert.deepEqual(discovery.agents.map((agent) => agent.name), ["reviewer"]);
  assert.deepEqual(discovery.agents[0]?.tools, ["bash", "read"]);
});
test("discoverAgents still accepts comma-separated tools frontmatter", (t) => {
  const root = makeProjectRoot(t);
  const agentsDir = join(root, ".gsd", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: review agent",
      "tools: bash, read",
      "---",
      "Review code",
      ""
    ].join("\n")
  );
  const discovery = discoverAgents(root, "project");
  assert.deepEqual(discovery.agents[0]?.tools, ["bash", "read"]);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zdWJhZ2VudC1hZ2VudC1kaXNjb3ZlcnkudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIG1rZHRlbXBTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5cbmltcG9ydCB7IGRpc2NvdmVyQWdlbnRzIH0gZnJvbSBcIi4uLy4uL3N1YmFnZW50L2FnZW50cy50c1wiO1xuXG5mdW5jdGlvbiBtYWtlUHJvamVjdFJvb3QodDogdGVzdC5UZXN0Q29udGV4dCk6IHN0cmluZyB7XG5cdGNvbnN0IHJvb3QgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1zdWJhZ2VudC1hZ2VudHMtXCIpKTtcblx0dC5hZnRlcigoKSA9PiBybVN5bmMocm9vdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblx0cmV0dXJuIHJvb3Q7XG59XG5cbmZ1bmN0aW9uIHdyaXRlQWdlbnQocm9vdDogc3RyaW5nLCBjb25maWdEaXJOYW1lOiBcIi5nc2RcIiB8IFwiLnBpXCIsIG5hbWUgPSBcInBpbmdcIik6IHN0cmluZyB7XG5cdGNvbnN0IGFnZW50c0RpciA9IGpvaW4ocm9vdCwgY29uZmlnRGlyTmFtZSwgXCJhZ2VudHNcIik7XG5cdG1rZGlyU3luYyhhZ2VudHNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHR3cml0ZUZpbGVTeW5jKFxuXHRcdGpvaW4oYWdlbnRzRGlyLCBgJHtuYW1lfS5tZGApLFxuXHRcdGAtLS1cXG5uYW1lOiAke25hbWV9XFxuZGVzY3JpcHRpb246ICR7bmFtZX0gYWdlbnRcXG4tLS1cXG5TYXkgaGVsbG9cXG5gLFxuXHQpO1xuXHRyZXR1cm4gYWdlbnRzRGlyO1xufVxuXG50ZXN0KFwiZGlzY292ZXJBZ2VudHMgZmluZHMgcHJvamVjdCBhZ2VudHMgaW4gLmdzZC9hZ2VudHNcIiwgKHQpID0+IHtcblx0Y29uc3Qgcm9vdCA9IG1ha2VQcm9qZWN0Um9vdCh0KTtcblx0Y29uc3QgYWdlbnRzRGlyID0gd3JpdGVBZ2VudChyb290LCBcIi5nc2RcIik7XG5cblx0Y29uc3QgZGlzY292ZXJ5ID0gZGlzY292ZXJBZ2VudHMocm9vdCwgXCJwcm9qZWN0XCIpO1xuXG5cdGFzc2VydC5lcXVhbChkaXNjb3ZlcnkucHJvamVjdEFnZW50c0RpciwgYWdlbnRzRGlyKTtcblx0YXNzZXJ0LmRlZXBFcXVhbChkaXNjb3ZlcnkuYWdlbnRzLm1hcCgoYWdlbnQpID0+IGFnZW50Lm5hbWUpLCBbXCJwaW5nXCJdKTtcblx0YXNzZXJ0LmVxdWFsKGRpc2NvdmVyeS5hZ2VudHNbMF0/LnNvdXJjZSwgXCJwcm9qZWN0XCIpO1xufSk7XG5cbnRlc3QoXCJkaXNjb3ZlckFnZW50cyBmYWxscyBiYWNrIHRvIGxlZ2FjeSAucGkvYWdlbnRzIHdoZW4gbmVlZGVkXCIsICh0KSA9PiB7XG5cdGNvbnN0IHJvb3QgPSBtYWtlUHJvamVjdFJvb3QodCk7XG5cdGNvbnN0IGFnZW50c0RpciA9IHdyaXRlQWdlbnQocm9vdCwgXCIucGlcIik7XG5cblx0Y29uc3QgZGlzY292ZXJ5ID0gZGlzY292ZXJBZ2VudHMocm9vdCwgXCJwcm9qZWN0XCIpO1xuXG5cdGFzc2VydC5lcXVhbChkaXNjb3ZlcnkucHJvamVjdEFnZW50c0RpciwgYWdlbnRzRGlyKTtcblx0YXNzZXJ0LmRlZXBFcXVhbChkaXNjb3ZlcnkuYWdlbnRzLm1hcCgoYWdlbnQpID0+IGFnZW50Lm5hbWUpLCBbXCJwaW5nXCJdKTtcbn0pO1xuXG50ZXN0KFwiZGlzY292ZXJBZ2VudHMgYWNjZXB0cyB0b29scyBmcm9udG1hdHRlciBhcyBhIFlBTUwgbGlzdFwiLCAodCkgPT4ge1xuXHRjb25zdCByb290ID0gbWFrZVByb2plY3RSb290KHQpO1xuXHRjb25zdCBhZ2VudHNEaXIgPSBqb2luKHJvb3QsIFwiLmdzZFwiLCBcImFnZW50c1wiKTtcblx0bWtkaXJTeW5jKGFnZW50c0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdHdyaXRlRmlsZVN5bmMoXG5cdFx0am9pbihhZ2VudHNEaXIsIFwicmV2aWV3ZXIubWRcIiksXG5cdFx0W1xuXHRcdFx0XCItLS1cIixcblx0XHRcdFwibmFtZTogcmV2aWV3ZXJcIixcblx0XHRcdFwiZGVzY3JpcHRpb246IHJldmlldyBhZ2VudFwiLFxuXHRcdFx0XCJ0b29sczpcIixcblx0XHRcdFwiICAtIGJhc2hcIixcblx0XHRcdFwiICAtIHJlYWRcIixcblx0XHRcdFwiLS0tXCIsXG5cdFx0XHRcIlJldmlldyBjb2RlXCIsXG5cdFx0XHRcIlwiLFxuXHRcdF0uam9pbihcIlxcblwiKSxcblx0KTtcblxuXHRjb25zdCBkaXNjb3ZlcnkgPSBkaXNjb3ZlckFnZW50cyhyb290LCBcInByb2plY3RcIik7XG5cblx0YXNzZXJ0LmRlZXBFcXVhbChkaXNjb3ZlcnkuYWdlbnRzLm1hcCgoYWdlbnQpID0+IGFnZW50Lm5hbWUpLCBbXCJyZXZpZXdlclwiXSk7XG5cdGFzc2VydC5kZWVwRXF1YWwoZGlzY292ZXJ5LmFnZW50c1swXT8udG9vbHMsIFtcImJhc2hcIiwgXCJyZWFkXCJdKTtcbn0pO1xuXG50ZXN0KFwiZGlzY292ZXJBZ2VudHMgc3RpbGwgYWNjZXB0cyBjb21tYS1zZXBhcmF0ZWQgdG9vbHMgZnJvbnRtYXR0ZXJcIiwgKHQpID0+IHtcblx0Y29uc3Qgcm9vdCA9IG1ha2VQcm9qZWN0Um9vdCh0KTtcblx0Y29uc3QgYWdlbnRzRGlyID0gam9pbihyb290LCBcIi5nc2RcIiwgXCJhZ2VudHNcIik7XG5cdG1rZGlyU3luYyhhZ2VudHNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHR3cml0ZUZpbGVTeW5jKFxuXHRcdGpvaW4oYWdlbnRzRGlyLCBcInJldmlld2VyLm1kXCIpLFxuXHRcdFtcblx0XHRcdFwiLS0tXCIsXG5cdFx0XHRcIm5hbWU6IHJldmlld2VyXCIsXG5cdFx0XHRcImRlc2NyaXB0aW9uOiByZXZpZXcgYWdlbnRcIixcblx0XHRcdFwidG9vbHM6IGJhc2gsIHJlYWRcIixcblx0XHRcdFwiLS0tXCIsXG5cdFx0XHRcIlJldmlldyBjb2RlXCIsXG5cdFx0XHRcIlwiLFxuXHRcdF0uam9pbihcIlxcblwiKSxcblx0KTtcblxuXHRjb25zdCBkaXNjb3ZlcnkgPSBkaXNjb3ZlckFnZW50cyhyb290LCBcInByb2plY3RcIik7XG5cblx0YXNzZXJ0LmRlZXBFcXVhbChkaXNjb3ZlcnkuYWdlbnRzWzBdPy50b29scywgW1wiYmFzaFwiLCBcInJlYWRcIl0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFlBQVk7QUFDbkIsU0FBUyxXQUFXLGFBQWEsUUFBUSxxQkFBcUI7QUFDOUQsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsWUFBWTtBQUNyQixPQUFPLFVBQVU7QUFFakIsU0FBUyxzQkFBc0I7QUFFL0IsU0FBUyxnQkFBZ0IsR0FBNkI7QUFDckQsUUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsc0JBQXNCLENBQUM7QUFDL0QsSUFBRSxNQUFNLE1BQU0sT0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDLENBQUM7QUFDNUQsU0FBTztBQUNSO0FBRUEsU0FBUyxXQUFXLE1BQWMsZUFBK0IsT0FBTyxRQUFnQjtBQUN2RixRQUFNLFlBQVksS0FBSyxNQUFNLGVBQWUsUUFBUTtBQUNwRCxZQUFVLFdBQVcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN4QztBQUFBLElBQ0MsS0FBSyxXQUFXLEdBQUcsSUFBSSxLQUFLO0FBQUEsSUFDNUI7QUFBQSxRQUFjLElBQUk7QUFBQSxlQUFrQixJQUFJO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFDekM7QUFDQSxTQUFPO0FBQ1I7QUFFQSxLQUFLLHNEQUFzRCxDQUFDLE1BQU07QUFDakUsUUFBTSxPQUFPLGdCQUFnQixDQUFDO0FBQzlCLFFBQU0sWUFBWSxXQUFXLE1BQU0sTUFBTTtBQUV6QyxRQUFNLFlBQVksZUFBZSxNQUFNLFNBQVM7QUFFaEQsU0FBTyxNQUFNLFVBQVUsa0JBQWtCLFNBQVM7QUFDbEQsU0FBTyxVQUFVLFVBQVUsT0FBTyxJQUFJLENBQUMsVUFBVSxNQUFNLElBQUksR0FBRyxDQUFDLE1BQU0sQ0FBQztBQUN0RSxTQUFPLE1BQU0sVUFBVSxPQUFPLENBQUMsR0FBRyxRQUFRLFNBQVM7QUFDcEQsQ0FBQztBQUVELEtBQUssOERBQThELENBQUMsTUFBTTtBQUN6RSxRQUFNLE9BQU8sZ0JBQWdCLENBQUM7QUFDOUIsUUFBTSxZQUFZLFdBQVcsTUFBTSxLQUFLO0FBRXhDLFFBQU0sWUFBWSxlQUFlLE1BQU0sU0FBUztBQUVoRCxTQUFPLE1BQU0sVUFBVSxrQkFBa0IsU0FBUztBQUNsRCxTQUFPLFVBQVUsVUFBVSxPQUFPLElBQUksQ0FBQyxVQUFVLE1BQU0sSUFBSSxHQUFHLENBQUMsTUFBTSxDQUFDO0FBQ3ZFLENBQUM7QUFFRCxLQUFLLDJEQUEyRCxDQUFDLE1BQU07QUFDdEUsUUFBTSxPQUFPLGdCQUFnQixDQUFDO0FBQzlCLFFBQU0sWUFBWSxLQUFLLE1BQU0sUUFBUSxRQUFRO0FBQzdDLFlBQVUsV0FBVyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3hDO0FBQUEsSUFDQyxLQUFLLFdBQVcsYUFBYTtBQUFBLElBQzdCO0FBQUEsTUFDQztBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRCxFQUFFLEtBQUssSUFBSTtBQUFBLEVBQ1o7QUFFQSxRQUFNLFlBQVksZUFBZSxNQUFNLFNBQVM7QUFFaEQsU0FBTyxVQUFVLFVBQVUsT0FBTyxJQUFJLENBQUMsVUFBVSxNQUFNLElBQUksR0FBRyxDQUFDLFVBQVUsQ0FBQztBQUMxRSxTQUFPLFVBQVUsVUFBVSxPQUFPLENBQUMsR0FBRyxPQUFPLENBQUMsUUFBUSxNQUFNLENBQUM7QUFDOUQsQ0FBQztBQUVELEtBQUssa0VBQWtFLENBQUMsTUFBTTtBQUM3RSxRQUFNLE9BQU8sZ0JBQWdCLENBQUM7QUFDOUIsUUFBTSxZQUFZLEtBQUssTUFBTSxRQUFRLFFBQVE7QUFDN0MsWUFBVSxXQUFXLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDeEM7QUFBQSxJQUNDLEtBQUssV0FBVyxhQUFhO0FBQUEsSUFDN0I7QUFBQSxNQUNDO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRCxFQUFFLEtBQUssSUFBSTtBQUFBLEVBQ1o7QUFFQSxRQUFNLFlBQVksZUFBZSxNQUFNLFNBQVM7QUFFaEQsU0FBTyxVQUFVLFVBQVUsT0FBTyxDQUFDLEdBQUcsT0FBTyxDQUFDLFFBQVEsTUFBTSxDQUFDO0FBQzlELENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
