import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mcpSdkSpecifier } from "../mcp-server.js";
describe("MCP server SDK subpath imports (#3603 / #3914)", () => {
  test("server/index.js subpath is imported with explicit .js suffix", () => {
    assert.equal(
      mcpSdkSpecifier("server/index"),
      "@modelcontextprotocol/sdk/server/index.js"
    );
  });
  test("server/stdio.js subpath is imported with explicit .js suffix", () => {
    assert.equal(
      mcpSdkSpecifier("server/stdio"),
      "@modelcontextprotocol/sdk/server/stdio.js"
    );
  });
  test("types.js subpath is imported with explicit .js suffix", () => {
    assert.equal(mcpSdkSpecifier("types"), "@modelcontextprotocol/sdk/types.js");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL21jcC1jcmVhdGVSZXF1aXJlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7IG1jcFNka1NwZWNpZmllciB9IGZyb20gJy4uL21jcC1zZXJ2ZXIudHMnO1xuXG5kZXNjcmliZSgnTUNQIHNlcnZlciBTREsgc3VicGF0aCBpbXBvcnRzICgjMzYwMyAvICMzOTE0KScsICgpID0+IHtcbiAgdGVzdCgnc2VydmVyL2luZGV4LmpzIHN1YnBhdGggaXMgaW1wb3J0ZWQgd2l0aCBleHBsaWNpdCAuanMgc3VmZml4JywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIG1jcFNka1NwZWNpZmllcignc2VydmVyL2luZGV4JyksXG4gICAgICAnQG1vZGVsY29udGV4dHByb3RvY29sL3Nkay9zZXJ2ZXIvaW5kZXguanMnLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoJ3NlcnZlci9zdGRpby5qcyBzdWJwYXRoIGlzIGltcG9ydGVkIHdpdGggZXhwbGljaXQgLmpzIHN1ZmZpeCcsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBtY3BTZGtTcGVjaWZpZXIoJ3NlcnZlci9zdGRpbycpLFxuICAgICAgJ0Btb2RlbGNvbnRleHRwcm90b2NvbC9zZGsvc2VydmVyL3N0ZGlvLmpzJyxcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KCd0eXBlcy5qcyBzdWJwYXRoIGlzIGltcG9ydGVkIHdpdGggZXhwbGljaXQgLmpzIHN1ZmZpeCcsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwobWNwU2RrU3BlY2lmaWVyKCd0eXBlcycpLCAnQG1vZGVsY29udGV4dHByb3RvY29sL3Nkay90eXBlcy5qcycpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsdUJBQXVCO0FBRWhDLFNBQVMsa0RBQWtELE1BQU07QUFDL0QsT0FBSyxnRUFBZ0UsTUFBTTtBQUN6RSxXQUFPO0FBQUEsTUFDTCxnQkFBZ0IsY0FBYztBQUFBLE1BQzlCO0FBQUEsSUFDRjtBQUFBLEVBQ0YsQ0FBQztBQUVELE9BQUssZ0VBQWdFLE1BQU07QUFDekUsV0FBTztBQUFBLE1BQ0wsZ0JBQWdCLGNBQWM7QUFBQSxNQUM5QjtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxPQUFLLHlEQUF5RCxNQUFNO0FBQ2xFLFdBQU8sTUFBTSxnQkFBZ0IsT0FBTyxHQUFHLG9DQUFvQztBQUFBLEVBQzdFLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
