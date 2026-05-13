import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMilestoneTarget } from "../commands/handlers/auto.js";
describe("parseMilestoneTarget", () => {
  it("extracts a simple milestone ID", () => {
    const result = parseMilestoneTarget("auto M016");
    assert.equal(result.milestoneId, "M016");
    assert.equal(result.rest, "auto");
  });
  it("extracts a milestone ID with unique suffix", () => {
    const result = parseMilestoneTarget("auto M001-a3b4c5 --verbose");
    assert.equal(result.milestoneId, "M001-a3b4c5");
    assert.equal(result.rest, "auto --verbose");
  });
  it("returns null when no milestone ID is present", () => {
    const result = parseMilestoneTarget("auto --verbose");
    assert.equal(result.milestoneId, null);
    assert.equal(result.rest, "auto --verbose");
  });
  it("extracts milestone ID with flags in any order", () => {
    const result = parseMilestoneTarget("auto --verbose M003 --debug");
    assert.equal(result.milestoneId, "M003");
    assert.equal(result.rest, "auto --verbose --debug");
  });
  it("returns null for plain 'auto'", () => {
    const result = parseMilestoneTarget("auto");
    assert.equal(result.milestoneId, null);
    assert.equal(result.rest, "auto");
  });
  it("extracts from 'next' command", () => {
    const result = parseMilestoneTarget("next M012");
    assert.equal(result.milestoneId, "M012");
    assert.equal(result.rest, "next");
  });
  it("handles milestone ID at the start of input", () => {
    const result = parseMilestoneTarget("M007");
    assert.equal(result.milestoneId, "M007");
    assert.equal(result.rest, "");
  });
  it("picks the first milestone ID when multiple appear", () => {
    const result = parseMilestoneTarget("auto M001 M002");
    assert.equal(result.milestoneId, "M001");
    assert.ok(result.rest.includes("M002"));
  });
  it("does not match bare numbers without M prefix", () => {
    const result = parseMilestoneTarget("auto 016");
    assert.equal(result.milestoneId, null);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLW1pbGVzdG9uZS10YXJnZXQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbmltcG9ydCB7IHBhcnNlTWlsZXN0b25lVGFyZ2V0IH0gZnJvbSBcIi4uL2NvbW1hbmRzL2hhbmRsZXJzL2F1dG8uanNcIjtcblxuZGVzY3JpYmUoXCJwYXJzZU1pbGVzdG9uZVRhcmdldFwiLCAoKSA9PiB7XG4gIGl0KFwiZXh0cmFjdHMgYSBzaW1wbGUgbWlsZXN0b25lIElEXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBwYXJzZU1pbGVzdG9uZVRhcmdldChcImF1dG8gTTAxNlwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1pbGVzdG9uZUlkLCBcIk0wMTZcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZXN0LCBcImF1dG9cIik7XG4gIH0pO1xuXG4gIGl0KFwiZXh0cmFjdHMgYSBtaWxlc3RvbmUgSUQgd2l0aCB1bmlxdWUgc3VmZml4XCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBwYXJzZU1pbGVzdG9uZVRhcmdldChcImF1dG8gTTAwMS1hM2I0YzUgLS12ZXJib3NlXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWlsZXN0b25lSWQsIFwiTTAwMS1hM2I0YzVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZXN0LCBcImF1dG8gLS12ZXJib3NlXCIpO1xuICB9KTtcblxuICBpdChcInJldHVybnMgbnVsbCB3aGVuIG5vIG1pbGVzdG9uZSBJRCBpcyBwcmVzZW50XCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBwYXJzZU1pbGVzdG9uZVRhcmdldChcImF1dG8gLS12ZXJib3NlXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWlsZXN0b25lSWQsIG51bGwpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucmVzdCwgXCJhdXRvIC0tdmVyYm9zZVwiKTtcbiAgfSk7XG5cbiAgaXQoXCJleHRyYWN0cyBtaWxlc3RvbmUgSUQgd2l0aCBmbGFncyBpbiBhbnkgb3JkZXJcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHBhcnNlTWlsZXN0b25lVGFyZ2V0KFwiYXV0byAtLXZlcmJvc2UgTTAwMyAtLWRlYnVnXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWlsZXN0b25lSWQsIFwiTTAwM1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnJlc3QsIFwiYXV0byAtLXZlcmJvc2UgLS1kZWJ1Z1wiKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIG51bGwgZm9yIHBsYWluICdhdXRvJ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gcGFyc2VNaWxlc3RvbmVUYXJnZXQoXCJhdXRvXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWlsZXN0b25lSWQsIG51bGwpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucmVzdCwgXCJhdXRvXCIpO1xuICB9KTtcblxuICBpdChcImV4dHJhY3RzIGZyb20gJ25leHQnIGNvbW1hbmRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHBhcnNlTWlsZXN0b25lVGFyZ2V0KFwibmV4dCBNMDEyXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWlsZXN0b25lSWQsIFwiTTAxMlwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnJlc3QsIFwibmV4dFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJoYW5kbGVzIG1pbGVzdG9uZSBJRCBhdCB0aGUgc3RhcnQgb2YgaW5wdXRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IHBhcnNlTWlsZXN0b25lVGFyZ2V0KFwiTTAwN1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1pbGVzdG9uZUlkLCBcIk0wMDdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZXN0LCBcIlwiKTtcbiAgfSk7XG5cbiAgaXQoXCJwaWNrcyB0aGUgZmlyc3QgbWlsZXN0b25lIElEIHdoZW4gbXVsdGlwbGUgYXBwZWFyXCIsICgpID0+IHtcbiAgICAvLyBFZGdlIGNhc2U6IHVzZXIgYWNjaWRlbnRhbGx5IHR5cGVzIHR3by4gRmlyc3Qgb25lIHdpbnMuXG4gICAgY29uc3QgcmVzdWx0ID0gcGFyc2VNaWxlc3RvbmVUYXJnZXQoXCJhdXRvIE0wMDEgTTAwMlwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0Lm1pbGVzdG9uZUlkLCBcIk0wMDFcIik7XG4gICAgLy8gTTAwMiByZW1haW5zIGluIHJlc3Qgc2luY2Ugb25seSB0aGUgZmlyc3QgbWF0Y2ggaXMgcmVtb3ZlZFxuICAgIGFzc2VydC5vayhyZXN1bHQucmVzdC5pbmNsdWRlcyhcIk0wMDJcIikpO1xuICB9KTtcblxuICBpdChcImRvZXMgbm90IG1hdGNoIGJhcmUgbnVtYmVycyB3aXRob3V0IE0gcHJlZml4XCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBwYXJzZU1pbGVzdG9uZVRhcmdldChcImF1dG8gMDE2XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQubWlsZXN0b25lSWQsIG51bGwpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLFVBQVU7QUFDN0IsT0FBTyxZQUFZO0FBRW5CLFNBQVMsNEJBQTRCO0FBRXJDLFNBQVMsd0JBQXdCLE1BQU07QUFDckMsS0FBRyxrQ0FBa0MsTUFBTTtBQUN6QyxVQUFNLFNBQVMscUJBQXFCLFdBQVc7QUFDL0MsV0FBTyxNQUFNLE9BQU8sYUFBYSxNQUFNO0FBQ3ZDLFdBQU8sTUFBTSxPQUFPLE1BQU0sTUFBTTtBQUFBLEVBQ2xDLENBQUM7QUFFRCxLQUFHLDhDQUE4QyxNQUFNO0FBQ3JELFVBQU0sU0FBUyxxQkFBcUIsNEJBQTRCO0FBQ2hFLFdBQU8sTUFBTSxPQUFPLGFBQWEsYUFBYTtBQUM5QyxXQUFPLE1BQU0sT0FBTyxNQUFNLGdCQUFnQjtBQUFBLEVBQzVDLENBQUM7QUFFRCxLQUFHLGdEQUFnRCxNQUFNO0FBQ3ZELFVBQU0sU0FBUyxxQkFBcUIsZ0JBQWdCO0FBQ3BELFdBQU8sTUFBTSxPQUFPLGFBQWEsSUFBSTtBQUNyQyxXQUFPLE1BQU0sT0FBTyxNQUFNLGdCQUFnQjtBQUFBLEVBQzVDLENBQUM7QUFFRCxLQUFHLGlEQUFpRCxNQUFNO0FBQ3hELFVBQU0sU0FBUyxxQkFBcUIsNkJBQTZCO0FBQ2pFLFdBQU8sTUFBTSxPQUFPLGFBQWEsTUFBTTtBQUN2QyxXQUFPLE1BQU0sT0FBTyxNQUFNLHdCQUF3QjtBQUFBLEVBQ3BELENBQUM7QUFFRCxLQUFHLGlDQUFpQyxNQUFNO0FBQ3hDLFVBQU0sU0FBUyxxQkFBcUIsTUFBTTtBQUMxQyxXQUFPLE1BQU0sT0FBTyxhQUFhLElBQUk7QUFDckMsV0FBTyxNQUFNLE9BQU8sTUFBTSxNQUFNO0FBQUEsRUFDbEMsQ0FBQztBQUVELEtBQUcsZ0NBQWdDLE1BQU07QUFDdkMsVUFBTSxTQUFTLHFCQUFxQixXQUFXO0FBQy9DLFdBQU8sTUFBTSxPQUFPLGFBQWEsTUFBTTtBQUN2QyxXQUFPLE1BQU0sT0FBTyxNQUFNLE1BQU07QUFBQSxFQUNsQyxDQUFDO0FBRUQsS0FBRyw4Q0FBOEMsTUFBTTtBQUNyRCxVQUFNLFNBQVMscUJBQXFCLE1BQU07QUFDMUMsV0FBTyxNQUFNLE9BQU8sYUFBYSxNQUFNO0FBQ3ZDLFdBQU8sTUFBTSxPQUFPLE1BQU0sRUFBRTtBQUFBLEVBQzlCLENBQUM7QUFFRCxLQUFHLHFEQUFxRCxNQUFNO0FBRTVELFVBQU0sU0FBUyxxQkFBcUIsZ0JBQWdCO0FBQ3BELFdBQU8sTUFBTSxPQUFPLGFBQWEsTUFBTTtBQUV2QyxXQUFPLEdBQUcsT0FBTyxLQUFLLFNBQVMsTUFBTSxDQUFDO0FBQUEsRUFDeEMsQ0FBQztBQUVELEtBQUcsZ0RBQWdELE1BQU07QUFDdkQsVUFBTSxTQUFTLHFCQUFxQixVQUFVO0FBQzlDLFdBQU8sTUFBTSxPQUFPLGFBQWEsSUFBSTtBQUFBLEVBQ3ZDLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
