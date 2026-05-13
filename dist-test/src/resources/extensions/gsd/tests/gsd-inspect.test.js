import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatInspectOutput } from "../commands-inspect.js";
describe("gsd-inspect", () => {
  test("full output formatting", () => {
    const data = {
      schemaVersion: 2,
      counts: { decisions: 12, requirements: 8, artifacts: 3 },
      recentDecisions: [
        { id: "D012", decision: "Use SQLite for persistence", choice: "node:sqlite with fallback" },
        { id: "D011", decision: "Markdown dual-write", choice: "DB-first then regenerate" }
      ],
      recentRequirements: [
        { id: "R015", status: "active", description: "Commands register via pi.registerCommand" },
        { id: "R014", status: "active", description: "DB writes use upsert pattern" }
      ]
    };
    const output = formatInspectOutput(data);
    assert.match(output, /=== GSD Database Inspect ===/, "contains header");
    assert.match(output, /Schema version: 2/, "contains schema version");
    assert.match(output, /Decisions:\s+12/, "contains decisions count");
    assert.match(output, /Requirements:\s+8/, "contains requirements count");
    assert.match(output, /Artifacts:\s+3/, "contains artifacts count");
    assert.match(output, /Recent decisions:/, "contains recent decisions header");
    assert.match(output, /D012: Use SQLite for persistence → node:sqlite with fallback/, "contains D012 entry");
    assert.match(output, /D011: Markdown dual-write → DB-first then regenerate/, "contains D011 entry");
    assert.match(output, /Recent requirements:/, "contains recent requirements header");
    assert.match(output, /R015 \[active\]: Commands register via pi\.registerCommand/, "contains R015 entry");
    assert.match(output, /R014 \[active\]: DB writes use upsert pattern/, "contains R014 entry");
  });
  test("empty data", () => {
    const data = {
      schemaVersion: 1,
      counts: { decisions: 0, requirements: 0, artifacts: 0 },
      recentDecisions: [],
      recentRequirements: []
    };
    const output = formatInspectOutput(data);
    assert.match(output, /Schema version: 1/, "contains schema version 1");
    assert.match(output, /Decisions:\s+0/, "zero decisions");
    assert.match(output, /Requirements:\s+0/, "zero requirements");
    assert.match(output, /Artifacts:\s+0/, "zero artifacts");
    assert.ok(!output.includes("Recent decisions:"), "no recent decisions section when empty");
    assert.ok(!output.includes("Recent requirements:"), "no recent requirements section when empty");
  });
  test("null schema version", () => {
    const data = {
      schemaVersion: null,
      counts: { decisions: 0, requirements: 0, artifacts: 0 },
      recentDecisions: [],
      recentRequirements: []
    };
    const output = formatInspectOutput(data);
    assert.match(output, /Schema version: unknown/, "null version shows as unknown");
  });
  test("five recent entries", () => {
    const data = {
      schemaVersion: 2,
      counts: { decisions: 5, requirements: 5, artifacts: 0 },
      recentDecisions: [
        { id: "D005", decision: "Dec 5", choice: "C5" },
        { id: "D004", decision: "Dec 4", choice: "C4" },
        { id: "D003", decision: "Dec 3", choice: "C3" },
        { id: "D002", decision: "Dec 2", choice: "C2" },
        { id: "D001", decision: "Dec 1", choice: "C1" }
      ],
      recentRequirements: [
        { id: "R005", status: "active", description: "Req 5" },
        { id: "R004", status: "done", description: "Req 4" },
        { id: "R003", status: "active", description: "Req 3" },
        { id: "R002", status: "active", description: "Req 2" },
        { id: "R001", status: "done", description: "Req 1" }
      ]
    };
    const output = formatInspectOutput(data);
    for (let i = 1; i <= 5; i++) {
      assert.match(output, new RegExp(`D00${i}: Dec ${i} \u2192 C${i}`), `contains D00${i}`);
    }
    for (let i = 1; i <= 5; i++) {
      assert.match(output, new RegExp(`R00${i}`), `contains R00${i}`);
    }
    assert.match(output, /\[active\]/, "contains active status");
    assert.match(output, /\[done\]/, "contains done status");
  });
  test("output format", () => {
    const data = {
      schemaVersion: 2,
      counts: { decisions: 1, requirements: 1, artifacts: 0 },
      recentDecisions: [{ id: "D001", decision: "Test", choice: "Yes" }],
      recentRequirements: [{ id: "R001", status: "active", description: "Test req" }]
    };
    const output = formatInspectOutput(data);
    const lines = output.split("\n");
    assert.ok(lines.length > 5, "output has multiple lines");
    assert.ok(!output.startsWith("{"), "output is not JSON");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9nc2QtaW5zcGVjdC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG4vLyBnc2QtaW5zcGVjdCBcdTIwMTQgVGVzdHMgZm9yIC9nc2QgaW5zcGVjdCBvdXRwdXQgZm9ybWF0dGluZ1xuLy9cbi8vIFRlc3RzIHRoZSBwdXJlIGZvcm1hdEluc3BlY3RPdXRwdXQgZnVuY3Rpb24gd2l0aCBrbm93biBkYXRhLlxuXG5pbXBvcnQgeyBmb3JtYXRJbnNwZWN0T3V0cHV0LCB0eXBlIEluc3BlY3REYXRhIH0gZnJvbSAnLi4vY29tbWFuZHMtaW5zcGVjdC50cyc7XG5cbmRlc2NyaWJlKCdnc2QtaW5zcGVjdCcsICgpID0+IHtcbiAgdGVzdCgnZnVsbCBvdXRwdXQgZm9ybWF0dGluZycsICgpID0+IHtcbiAgICBjb25zdCBkYXRhOiBJbnNwZWN0RGF0YSA9IHtcbiAgICAgIHNjaGVtYVZlcnNpb246IDIsXG4gICAgICBjb3VudHM6IHsgZGVjaXNpb25zOiAxMiwgcmVxdWlyZW1lbnRzOiA4LCBhcnRpZmFjdHM6IDMgfSxcbiAgICAgIHJlY2VudERlY2lzaW9uczogW1xuICAgICAgICB7IGlkOiBcIkQwMTJcIiwgZGVjaXNpb246IFwiVXNlIFNRTGl0ZSBmb3IgcGVyc2lzdGVuY2VcIiwgY2hvaWNlOiBcIm5vZGU6c3FsaXRlIHdpdGggZmFsbGJhY2tcIiB9LFxuICAgICAgICB7IGlkOiBcIkQwMTFcIiwgZGVjaXNpb246IFwiTWFya2Rvd24gZHVhbC13cml0ZVwiLCBjaG9pY2U6IFwiREItZmlyc3QgdGhlbiByZWdlbmVyYXRlXCIgfSxcbiAgICAgIF0sXG4gICAgICByZWNlbnRSZXF1aXJlbWVudHM6IFtcbiAgICAgICAgeyBpZDogXCJSMDE1XCIsIHN0YXR1czogXCJhY3RpdmVcIiwgZGVzY3JpcHRpb246IFwiQ29tbWFuZHMgcmVnaXN0ZXIgdmlhIHBpLnJlZ2lzdGVyQ29tbWFuZFwiIH0sXG4gICAgICAgIHsgaWQ6IFwiUjAxNFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIsIGRlc2NyaXB0aW9uOiBcIkRCIHdyaXRlcyB1c2UgdXBzZXJ0IHBhdHRlcm5cIiB9LFxuICAgICAgXSxcbiAgICB9O1xuXG4gICAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0SW5zcGVjdE91dHB1dChkYXRhKTtcblxuICAgIGFzc2VydC5tYXRjaChvdXRwdXQsIC89PT0gR1NEIERhdGFiYXNlIEluc3BlY3QgPT09LywgXCJjb250YWlucyBoZWFkZXJcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgL1NjaGVtYSB2ZXJzaW9uOiAyLywgXCJjb250YWlucyBzY2hlbWEgdmVyc2lvblwiKTtcbiAgICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvRGVjaXNpb25zOlxccysxMi8sIFwiY29udGFpbnMgZGVjaXNpb25zIGNvdW50XCIpO1xuICAgIGFzc2VydC5tYXRjaChvdXRwdXQsIC9SZXF1aXJlbWVudHM6XFxzKzgvLCBcImNvbnRhaW5zIHJlcXVpcmVtZW50cyBjb3VudFwiKTtcbiAgICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvQXJ0aWZhY3RzOlxccyszLywgXCJjb250YWlucyBhcnRpZmFjdHMgY291bnRcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgL1JlY2VudCBkZWNpc2lvbnM6LywgXCJjb250YWlucyByZWNlbnQgZGVjaXNpb25zIGhlYWRlclwiKTtcbiAgICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvRDAxMjogVXNlIFNRTGl0ZSBmb3IgcGVyc2lzdGVuY2UgXHUyMTkyIG5vZGU6c3FsaXRlIHdpdGggZmFsbGJhY2svLCBcImNvbnRhaW5zIEQwMTIgZW50cnlcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgL0QwMTE6IE1hcmtkb3duIGR1YWwtd3JpdGUgXHUyMTkyIERCLWZpcnN0IHRoZW4gcmVnZW5lcmF0ZS8sIFwiY29udGFpbnMgRDAxMSBlbnRyeVwiKTtcbiAgICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvUmVjZW50IHJlcXVpcmVtZW50czovLCBcImNvbnRhaW5zIHJlY2VudCByZXF1aXJlbWVudHMgaGVhZGVyXCIpO1xuICAgIGFzc2VydC5tYXRjaChvdXRwdXQsIC9SMDE1IFxcW2FjdGl2ZVxcXTogQ29tbWFuZHMgcmVnaXN0ZXIgdmlhIHBpXFwucmVnaXN0ZXJDb21tYW5kLywgXCJjb250YWlucyBSMDE1IGVudHJ5XCIpO1xuICAgIGFzc2VydC5tYXRjaChvdXRwdXQsIC9SMDE0IFxcW2FjdGl2ZVxcXTogREIgd3JpdGVzIHVzZSB1cHNlcnQgcGF0dGVybi8sIFwiY29udGFpbnMgUjAxNCBlbnRyeVwiKTtcbiAgfSk7XG5cbiAgdGVzdCgnZW1wdHkgZGF0YScsICgpID0+IHtcbiAgICBjb25zdCBkYXRhOiBJbnNwZWN0RGF0YSA9IHtcbiAgICAgIHNjaGVtYVZlcnNpb246IDEsXG4gICAgICBjb3VudHM6IHsgZGVjaXNpb25zOiAwLCByZXF1aXJlbWVudHM6IDAsIGFydGlmYWN0czogMCB9LFxuICAgICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICAgIHJlY2VudFJlcXVpcmVtZW50czogW10sXG4gICAgfTtcblxuICAgIGNvbnN0IG91dHB1dCA9IGZvcm1hdEluc3BlY3RPdXRwdXQoZGF0YSk7XG5cbiAgICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvU2NoZW1hIHZlcnNpb246IDEvLCBcImNvbnRhaW5zIHNjaGVtYSB2ZXJzaW9uIDFcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgL0RlY2lzaW9uczpcXHMrMC8sIFwiemVybyBkZWNpc2lvbnNcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgL1JlcXVpcmVtZW50czpcXHMrMC8sIFwiemVybyByZXF1aXJlbWVudHNcIik7XG4gICAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgL0FydGlmYWN0czpcXHMrMC8sIFwiemVybyBhcnRpZmFjdHNcIik7XG4gICAgYXNzZXJ0Lm9rKCFvdXRwdXQuaW5jbHVkZXMoXCJSZWNlbnQgZGVjaXNpb25zOlwiKSwgXCJubyByZWNlbnQgZGVjaXNpb25zIHNlY3Rpb24gd2hlbiBlbXB0eVwiKTtcbiAgICBhc3NlcnQub2soIW91dHB1dC5pbmNsdWRlcyhcIlJlY2VudCByZXF1aXJlbWVudHM6XCIpLCBcIm5vIHJlY2VudCByZXF1aXJlbWVudHMgc2VjdGlvbiB3aGVuIGVtcHR5XCIpO1xuICB9KTtcblxuICB0ZXN0KCdudWxsIHNjaGVtYSB2ZXJzaW9uJywgKCkgPT4ge1xuICAgIGNvbnN0IGRhdGE6IEluc3BlY3REYXRhID0ge1xuICAgICAgc2NoZW1hVmVyc2lvbjogbnVsbCxcbiAgICAgIGNvdW50czogeyBkZWNpc2lvbnM6IDAsIHJlcXVpcmVtZW50czogMCwgYXJ0aWZhY3RzOiAwIH0sXG4gICAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgICAgcmVjZW50UmVxdWlyZW1lbnRzOiBbXSxcbiAgICB9O1xuXG4gICAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0SW5zcGVjdE91dHB1dChkYXRhKTtcbiAgICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvU2NoZW1hIHZlcnNpb246IHVua25vd24vLCBcIm51bGwgdmVyc2lvbiBzaG93cyBhcyB1bmtub3duXCIpO1xuICB9KTtcblxuICB0ZXN0KCdmaXZlIHJlY2VudCBlbnRyaWVzJywgKCkgPT4ge1xuICAgIGNvbnN0IGRhdGE6IEluc3BlY3REYXRhID0ge1xuICAgICAgc2NoZW1hVmVyc2lvbjogMixcbiAgICAgIGNvdW50czogeyBkZWNpc2lvbnM6IDUsIHJlcXVpcmVtZW50czogNSwgYXJ0aWZhY3RzOiAwIH0sXG4gICAgICByZWNlbnREZWNpc2lvbnM6IFtcbiAgICAgICAgeyBpZDogXCJEMDA1XCIsIGRlY2lzaW9uOiBcIkRlYyA1XCIsIGNob2ljZTogXCJDNVwiIH0sXG4gICAgICAgIHsgaWQ6IFwiRDAwNFwiLCBkZWNpc2lvbjogXCJEZWMgNFwiLCBjaG9pY2U6IFwiQzRcIiB9LFxuICAgICAgICB7IGlkOiBcIkQwMDNcIiwgZGVjaXNpb246IFwiRGVjIDNcIiwgY2hvaWNlOiBcIkMzXCIgfSxcbiAgICAgICAgeyBpZDogXCJEMDAyXCIsIGRlY2lzaW9uOiBcIkRlYyAyXCIsIGNob2ljZTogXCJDMlwiIH0sXG4gICAgICAgIHsgaWQ6IFwiRDAwMVwiLCBkZWNpc2lvbjogXCJEZWMgMVwiLCBjaG9pY2U6IFwiQzFcIiB9LFxuICAgICAgXSxcbiAgICAgIHJlY2VudFJlcXVpcmVtZW50czogW1xuICAgICAgICB7IGlkOiBcIlIwMDVcIiwgc3RhdHVzOiBcImFjdGl2ZVwiLCBkZXNjcmlwdGlvbjogXCJSZXEgNVwiIH0sXG4gICAgICAgIHsgaWQ6IFwiUjAwNFwiLCBzdGF0dXM6IFwiZG9uZVwiLCBkZXNjcmlwdGlvbjogXCJSZXEgNFwiIH0sXG4gICAgICAgIHsgaWQ6IFwiUjAwM1wiLCBzdGF0dXM6IFwiYWN0aXZlXCIsIGRlc2NyaXB0aW9uOiBcIlJlcSAzXCIgfSxcbiAgICAgICAgeyBpZDogXCJSMDAyXCIsIHN0YXR1czogXCJhY3RpdmVcIiwgZGVzY3JpcHRpb246IFwiUmVxIDJcIiB9LFxuICAgICAgICB7IGlkOiBcIlIwMDFcIiwgc3RhdHVzOiBcImRvbmVcIiwgZGVzY3JpcHRpb246IFwiUmVxIDFcIiB9LFxuICAgICAgXSxcbiAgICB9O1xuXG4gICAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0SW5zcGVjdE91dHB1dChkYXRhKTtcblxuICAgIGZvciAobGV0IGkgPSAxOyBpIDw9IDU7IGkrKykge1xuICAgICAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgbmV3IFJlZ0V4cChgRDAwJHtpfTogRGVjICR7aX0gXHUyMTkyIEMke2l9YCksIGBjb250YWlucyBEMDAke2l9YCk7XG4gICAgfVxuICAgIGZvciAobGV0IGkgPSAxOyBpIDw9IDU7IGkrKykge1xuICAgICAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgbmV3IFJlZ0V4cChgUjAwJHtpfWApLCBgY29udGFpbnMgUjAwJHtpfWApO1xuICAgIH1cbiAgICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvXFxbYWN0aXZlXFxdLywgXCJjb250YWlucyBhY3RpdmUgc3RhdHVzXCIpO1xuICAgIGFzc2VydC5tYXRjaChvdXRwdXQsIC9cXFtkb25lXFxdLywgXCJjb250YWlucyBkb25lIHN0YXR1c1wiKTtcbiAgfSk7XG5cbiAgdGVzdCgnb3V0cHV0IGZvcm1hdCcsICgpID0+IHtcbiAgICBjb25zdCBkYXRhOiBJbnNwZWN0RGF0YSA9IHtcbiAgICAgIHNjaGVtYVZlcnNpb246IDIsXG4gICAgICBjb3VudHM6IHsgZGVjaXNpb25zOiAxLCByZXF1aXJlbWVudHM6IDEsIGFydGlmYWN0czogMCB9LFxuICAgICAgcmVjZW50RGVjaXNpb25zOiBbeyBpZDogXCJEMDAxXCIsIGRlY2lzaW9uOiBcIlRlc3RcIiwgY2hvaWNlOiBcIlllc1wiIH1dLFxuICAgICAgcmVjZW50UmVxdWlyZW1lbnRzOiBbeyBpZDogXCJSMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiwgZGVzY3JpcHRpb246IFwiVGVzdCByZXFcIiB9XSxcbiAgICB9O1xuXG4gICAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0SW5zcGVjdE91dHB1dChkYXRhKTtcbiAgICBjb25zdCBsaW5lcyA9IG91dHB1dC5zcGxpdChcIlxcblwiKTtcbiAgICBhc3NlcnQub2sobGluZXMubGVuZ3RoID4gNSwgXCJvdXRwdXQgaGFzIG11bHRpcGxlIGxpbmVzXCIpO1xuICAgIGFzc2VydC5vayghb3V0cHV0LnN0YXJ0c1dpdGgoXCJ7XCIpLCBcIm91dHB1dCBpcyBub3QgSlNPTlwiKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUtuQixTQUFTLDJCQUE2QztBQUV0RCxTQUFTLGVBQWUsTUFBTTtBQUM1QixPQUFL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LFVBQVUsU0FBUyxRQUFRLEtBQUs7QUFBQSxNQUNoRDtBQUFBLE1BQ0Esb0JBQW9CO0FBQUEsUUFDbEIsRUFBRSxJQUFJLFFBQVEsUUFBUSxVQUFVLGFBQWEsUUFBUTtBQUFBLFFBQ3JELEVBQUUsSUFBSSxRQUFRLFFBQVEsUUFBUSxhQUFhLFFBQVE7QUFBQSxRQUNuRCxFQUFFLElBQUksUUFBUSxRQUFRLFVBQVUsYUFBYSxRQUFRO0FBQUEsUUFDckQsRUFBRSxJQUFJLFFBQVEsUUFBUSxVQUFVLGFBQWEsUUFBUTtBQUFBLFFBQ3JELEVBQUUsSUFBSSxRQUFRLFFBQVEsUUFBUSxhQUFhLFFBQVE7QUFBQSxNQUNyRDtBQUFBLElBQ0Y7QUFFQSxVQUFNLFNBQVMsb0JBQW9CLElBQUk7QUFFdkMsYUFBUyxJQUFJLEdBQUcsS0FBSyxHQUFHLEtBQUs7QUFDM0IsYUFBTyxNQUFNLFFBQVEsSUFBSSxPQUFPLE1BQU0sQ0FBQyxTQUFTLENBQUMsWUFBTyxDQUFDLEVBQUUsR0FBRyxlQUFlLENBQUMsRUFBRTtBQUFBLElBQ2xGO0FBQ0EsYUFBUyxJQUFJLEdBQUcsS0FBSyxHQUFHLEtBQUs7QUFDM0IsYUFBTyxNQUFNLFFBQVEsSUFBSSxPQUFPLE1BQU0sQ0FBQyxFQUFFLEdBQUcsZUFBZSxDQUFDLEVBQUU7QUFBQSxJQUNoRTtBQUNBLFdBQU8sTUFBTSxRQUFRLGNBQWMsd0JBQXdCO0FBQzNELFdBQU8sTUFBTSxRQUFRLFlBQVksc0JBQXNCO0FBQUEsRUFDekQsQ0FBQztBQUVELE9BQUssaUJBQWlCLE1BQU07QUFDMUIsVUFBTSxPQUFvQjtBQUFBLE1BQ3hCLGVBQWU7QUFBQSxNQUNmLFFBQVEsRUFBRSxXQUFXLEdBQUcsY0FBYyxHQUFHLFdBQVcsRUFBRTtBQUFBLE1BQ3RELGlCQUFpQixDQUFDLEVBQUUsSUFBSSxRQUFRLFVBQVUsUUFBUSxRQUFRLE1BQU0sQ0FBQztBQUFBLE1BQ2pFLG9CQUFvQixDQUFDLEVBQUUsSUFBSSxRQUFRLFFBQVEsVUFBVSxhQUFhLFdBQVcsQ0FBQztBQUFBLElBQ2hGO0FBRUEsVUFBTSxTQUFTLG9CQUFvQixJQUFJO0FBQ3ZDLFVBQU0sUUFBUSxPQUFPLE1BQU0sSUFBSTtBQUMvQixXQUFPLEdBQUcsTUFBTSxTQUFTLEdBQUcsMkJBQTJCO0FBQ3ZELFdBQU8sR0FBRyxDQUFDLE9BQU8sV0FBVyxHQUFHLEdBQUcsb0JBQW9CO0FBQUEsRUFDekQsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
