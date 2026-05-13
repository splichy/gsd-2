import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inlineCode, formatSwarmLanePRBody } from "../templates.js";
describe("inlineCode", () => {
  it("wraps a plain string in single backticks", () => {
    assert.equal(inlineCode("hello"), "`hello`");
  });
  it("uses a double-backtick fence when the input contains a single backtick", () => {
    const out = inlineCode("a`b");
    assert.equal(out, "``a`b``");
  });
  it("uses a 4-backtick fence when the input contains a run of three backticks", () => {
    const out = inlineCode("x```y");
    assert.equal(out, "````x```y````");
  });
  it("pads with a leading space when the input starts with a backtick", () => {
    const out = inlineCode("`leading");
    assert.equal(out, "`` `leading ``");
  });
  it("pads with a trailing space when the input ends with a backtick", () => {
    const out = inlineCode("trailing`");
    assert.equal(out, "`` trailing` ``");
  });
  it("returns an empty string for empty input", () => {
    assert.equal(inlineCode(""), "");
  });
  it("escapes a branch with embedded backticks inside formatSwarmLanePRBody", () => {
    const malicious = "feature`evil";
    const body = formatSwarmLanePRBody({
      lane: {
        id: "workflow",
        branch: malicious
      },
      impactArea: "test",
      transitionRisks: [],
      rollbackPlan: []
    });
    assert.ok(
      body.includes("``feature`evil``"),
      `expected double-backtick fenced branch, got body:
${body}`
    );
    assert.ok(
      !body.includes("`feature`evil`\n") && !body.includes("`feature`evil` "),
      `expected no inline-code break-out, got body:
${body}`
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dpdGh1Yi1zeW5jL3Rlc3RzL2lubGluZS1jb2RlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBUZXN0cyBmb3IgdGhlIGlubGluZUNvZGUgbWFya2Rvd24gaGVscGVyIGFuZCBpdHMgdXNlIGluIFBSIGJvZHkgdGVtcGxhdGVzLlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IGlubGluZUNvZGUsIGZvcm1hdFN3YXJtTGFuZVBSQm9keSB9IGZyb20gXCIuLi90ZW1wbGF0ZXMudHNcIjtcblxuZGVzY3JpYmUoXCJpbmxpbmVDb2RlXCIsICgpID0+IHtcbiAgaXQoXCJ3cmFwcyBhIHBsYWluIHN0cmluZyBpbiBzaW5nbGUgYmFja3RpY2tzXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoaW5saW5lQ29kZShcImhlbGxvXCIpLCBcImBoZWxsb2BcIik7XG4gIH0pO1xuXG4gIGl0KFwidXNlcyBhIGRvdWJsZS1iYWNrdGljayBmZW5jZSB3aGVuIHRoZSBpbnB1dCBjb250YWlucyBhIHNpbmdsZSBiYWNrdGlja1wiLCAoKSA9PiB7XG4gICAgY29uc3Qgb3V0ID0gaW5saW5lQ29kZShcImFgYlwiKTtcbiAgICBhc3NlcnQuZXF1YWwob3V0LCBcImBgYWBiYGBcIik7XG4gIH0pO1xuXG4gIGl0KFwidXNlcyBhIDQtYmFja3RpY2sgZmVuY2Ugd2hlbiB0aGUgaW5wdXQgY29udGFpbnMgYSBydW4gb2YgdGhyZWUgYmFja3RpY2tzXCIsICgpID0+IHtcbiAgICBjb25zdCBvdXQgPSBpbmxpbmVDb2RlKFwieGBgYHlcIik7XG4gICAgYXNzZXJ0LmVxdWFsKG91dCwgXCJgYGBgeGBgYHlgYGBgXCIpO1xuICB9KTtcblxuICBpdChcInBhZHMgd2l0aCBhIGxlYWRpbmcgc3BhY2Ugd2hlbiB0aGUgaW5wdXQgc3RhcnRzIHdpdGggYSBiYWNrdGlja1wiLCAoKSA9PiB7XG4gICAgY29uc3Qgb3V0ID0gaW5saW5lQ29kZShcImBsZWFkaW5nXCIpO1xuICAgIC8vIGxvbmdlc3QgcnVuID0gMSBcdTIxOTIgZmVuY2UgbGVuZ3RoIDI7IGxlYWRpbmcgYmFja3RpY2sgXHUyMTkyIHBhZCBib3RoIHNpZGVzXG4gICAgYXNzZXJ0LmVxdWFsKG91dCwgXCJgYCBgbGVhZGluZyBgYFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJwYWRzIHdpdGggYSB0cmFpbGluZyBzcGFjZSB3aGVuIHRoZSBpbnB1dCBlbmRzIHdpdGggYSBiYWNrdGlja1wiLCAoKSA9PiB7XG4gICAgY29uc3Qgb3V0ID0gaW5saW5lQ29kZShcInRyYWlsaW5nYFwiKTtcbiAgICBhc3NlcnQuZXF1YWwob3V0LCBcImBgIHRyYWlsaW5nYCBgYFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIGFuIGVtcHR5IHN0cmluZyBmb3IgZW1wdHkgaW5wdXRcIiwgKCkgPT4ge1xuICAgIC8vIERvY3VtZW50ZWQgaW52YXJpYW50OiBlbXB0eSBpbnB1dCByZW5kZXJzIGFzIG5vdGhpbmcgcmF0aGVyIHRoYW4gYXNcbiAgICAvLyBhIGxpdGVyYWwgcGFpciBvZiBiYWNrdGlja3MgKHdoaWNoIEdGTSB3b3VsZCByZW5kZXIgYXMgdGhlIGNoYXJhY3RlcnNcbiAgICAvLyB0aGVtc2VsdmVzLCBub3QgYXMgY29kZSkuXG4gICAgYXNzZXJ0LmVxdWFsKGlubGluZUNvZGUoXCJcIiksIFwiXCIpO1xuICB9KTtcblxuICBpdChcImVzY2FwZXMgYSBicmFuY2ggd2l0aCBlbWJlZGRlZCBiYWNrdGlja3MgaW5zaWRlIGZvcm1hdFN3YXJtTGFuZVBSQm9keVwiLCAoKSA9PiB7XG4gICAgY29uc3QgbWFsaWNpb3VzID0gXCJmZWF0dXJlYGV2aWxcIjtcbiAgICBjb25zdCBib2R5ID0gZm9ybWF0U3dhcm1MYW5lUFJCb2R5KHtcbiAgICAgIGxhbmU6IHtcbiAgICAgICAgaWQ6IFwid29ya2Zsb3dcIixcbiAgICAgICAgYnJhbmNoOiBtYWxpY2lvdXMsXG4gICAgICB9LFxuICAgICAgaW1wYWN0QXJlYTogXCJ0ZXN0XCIsXG4gICAgICB0cmFuc2l0aW9uUmlza3M6IFtdLFxuICAgICAgcm9sbGJhY2tQbGFuOiBbXSxcbiAgICB9KTtcbiAgICAvLyBUaGUgYnJhbmNoIG11c3QgYXBwZWFyIGluc2lkZSBhIHByb3Blcmx5IGZlbmNlZCBpbmxpbmUtY29kZSBzcGFuLFxuICAgIC8vIGkuZS4gd3JhcHBlZCBpbiB0aGUgaGVscGVyJ3MgY2hvc2VuIGZlbmNlIChoZXJlIGEgZG91YmxlIGJhY2t0aWNrKS5cbiAgICBhc3NlcnQub2soXG4gICAgICBib2R5LmluY2x1ZGVzKFwiYGBmZWF0dXJlYGV2aWxgYFwiKSxcbiAgICAgIGBleHBlY3RlZCBkb3VibGUtYmFja3RpY2sgZmVuY2VkIGJyYW5jaCwgZ290IGJvZHk6XFxuJHtib2R5fWAsXG4gICAgKTtcbiAgICAvLyBBbmQgdGhlcmUgbXVzdCBiZSBubyBtYXJrZG93biBicmVhay1vdXQ6IHRoZSBzdWJzdHJpbmcgXCJldmlsXCIgc2hvdWxkXG4gICAgLy8gbmV2ZXIgYXBwZWFyIHVuZmVuY2VkIGFzIGEgYmFyZSB3b3JkIGFkamFjZW50IHRvIGEgY2xvc2luZyBzaW5nbGVcbiAgICAvLyBiYWNrdGljayAodGhlIHVucGF0Y2hlZCB0ZW1wbGF0ZSBwcm9kdWNlZCBcImBmZWF0dXJlYGV2aWxgXCIpLlxuICAgIGFzc2VydC5vayhcbiAgICAgICFib2R5LmluY2x1ZGVzKFwiYGZlYXR1cmVgZXZpbGBcXG5cIikgJiYgIWJvZHkuaW5jbHVkZXMoXCJgZmVhdHVyZWBldmlsYCBcIiksXG4gICAgICBgZXhwZWN0ZWQgbm8gaW5saW5lLWNvZGUgYnJlYWstb3V0LCBnb3QgYm9keTpcXG4ke2JvZHl9YCxcbiAgICApO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsU0FBUyxVQUFVLFVBQVU7QUFDN0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsWUFBWSw2QkFBNkI7QUFFbEQsU0FBUyxjQUFjLE1BQU07QUFDM0IsS0FBRyw0Q0FBNEMsTUFBTTtBQUNuRCxXQUFPLE1BQU0sV0FBVyxPQUFPLEdBQUcsU0FBUztBQUFBLEVBQzdDLENBQUM7QUFFRCxLQUFHLDBFQUEwRSxNQUFNO0FBQ2pGLFVBQU0sTUFBTSxXQUFXLEtBQUs7QUFDNUIsV0FBTyxNQUFNLEtBQUssU0FBUztBQUFBLEVBQzdCLENBQUM7QUFFRCxLQUFHLDRFQUE0RSxNQUFNO0FBQ25GLFVBQU0sTUFBTSxXQUFXLE9BQU87QUFDOUIsV0FBTyxNQUFNLEtBQUssZUFBZTtBQUFBLEVBQ25DLENBQUM7QUFFRCxLQUFHLG1FQUFtRSxNQUFNO0FBQzFFLFVBQU0sTUFBTSxXQUFXLFVBQVU7QUFFakMsV0FBTyxNQUFNLEtBQUssZ0JBQWdCO0FBQUEsRUFDcEMsQ0FBQztBQUVELEtBQUcsa0VBQWtFLE1BQU07QUFDekUsVUFBTSxNQUFNLFdBQVcsV0FBVztBQUNsQyxXQUFPLE1BQU0sS0FBSyxpQkFBaUI7QUFBQSxFQUNyQyxDQUFDO0FBRUQsS0FBRywyQ0FBMkMsTUFBTTtBQUlsRCxXQUFPLE1BQU0sV0FBVyxFQUFFLEdBQUcsRUFBRTtBQUFBLEVBQ2pDLENBQUM7QUFFRCxLQUFHLHlFQUF5RSxNQUFNO0FBQ2hGLFVBQU0sWUFBWTtBQUNsQixVQUFNLE9BQU8sc0JBQXNCO0FBQUEsTUFDakMsTUFBTTtBQUFBLFFBQ0osSUFBSTtBQUFBLFFBQ0osUUFBUTtBQUFBLE1BQ1Y7QUFBQSxNQUNBLFlBQVk7QUFBQSxNQUNaLGlCQUFpQixDQUFDO0FBQUEsTUFDbEIsY0FBYyxDQUFDO0FBQUEsSUFDakIsQ0FBQztBQUdELFdBQU87QUFBQSxNQUNMLEtBQUssU0FBUyxrQkFBa0I7QUFBQSxNQUNoQztBQUFBLEVBQXNELElBQUk7QUFBQSxJQUM1RDtBQUlBLFdBQU87QUFBQSxNQUNMLENBQUMsS0FBSyxTQUFTLGtCQUFrQixLQUFLLENBQUMsS0FBSyxTQUFTLGlCQUFpQjtBQUFBLE1BQ3RFO0FBQUEsRUFBaUQsSUFBSTtBQUFBLElBQ3ZEO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
