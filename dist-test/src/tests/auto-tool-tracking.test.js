import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  markToolStart,
  markToolEnd,
  getOldestInFlightToolAgeMs,
  getInFlightToolCount,
  clearInFlightTools
} from "../resources/extensions/gsd/auto-tool-tracking.js";
describe("auto-tool-tracking", () => {
  beforeEach(() => {
    clearInFlightTools();
  });
  it("tracks tool start and end", () => {
    assert.equal(getInFlightToolCount(), 0);
    markToolStart("tool-1", true);
    assert.equal(getInFlightToolCount(), 1);
    markToolEnd("tool-1");
    assert.equal(getInFlightToolCount(), 0);
  });
  it("skips tracking when not active", () => {
    markToolStart("tool-1", false);
    assert.equal(getInFlightToolCount(), 0);
  });
  it("returns 0 age when no tools in flight", () => {
    assert.equal(getOldestInFlightToolAgeMs(), 0);
  });
  it("returns positive age for in-flight tools", () => {
    markToolStart("tool-1", true);
    assert.ok(getOldestInFlightToolAgeMs() < 100);
  });
  it("clears all in-flight tools", () => {
    markToolStart("tool-1", true);
    markToolStart("tool-2", true);
    assert.equal(getInFlightToolCount(), 2);
    clearInFlightTools();
    assert.equal(getInFlightToolCount(), 0);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL2F1dG8tdG9vbC10cmFja2luZy50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBkZXNjcmliZSwgaXQsIGJlZm9yZUVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7XG4gIG1hcmtUb29sU3RhcnQsXG4gIG1hcmtUb29sRW5kLFxuICBnZXRPbGRlc3RJbkZsaWdodFRvb2xBZ2VNcyxcbiAgZ2V0SW5GbGlnaHRUb29sQ291bnQsXG4gIGNsZWFySW5GbGlnaHRUb29scyxcbn0gZnJvbSBcIi4uL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLXRvb2wtdHJhY2tpbmcuanNcIjtcblxuZGVzY3JpYmUoXCJhdXRvLXRvb2wtdHJhY2tpbmdcIiwgKCkgPT4ge1xuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICBjbGVhckluRmxpZ2h0VG9vbHMoKTtcbiAgfSk7XG5cbiAgaXQoXCJ0cmFja3MgdG9vbCBzdGFydCBhbmQgZW5kXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0SW5GbGlnaHRUb29sQ291bnQoKSwgMCk7XG4gICAgbWFya1Rvb2xTdGFydChcInRvb2wtMVwiLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0SW5GbGlnaHRUb29sQ291bnQoKSwgMSk7XG4gICAgbWFya1Rvb2xFbmQoXCJ0b29sLTFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGdldEluRmxpZ2h0VG9vbENvdW50KCksIDApO1xuICB9KTtcblxuICBpdChcInNraXBzIHRyYWNraW5nIHdoZW4gbm90IGFjdGl2ZVwiLCAoKSA9PiB7XG4gICAgbWFya1Rvb2xTdGFydChcInRvb2wtMVwiLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGdldEluRmxpZ2h0VG9vbENvdW50KCksIDApO1xuICB9KTtcblxuICBpdChcInJldHVybnMgMCBhZ2Ugd2hlbiBubyB0b29scyBpbiBmbGlnaHRcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChnZXRPbGRlc3RJbkZsaWdodFRvb2xBZ2VNcygpLCAwKTtcbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIHBvc2l0aXZlIGFnZSBmb3IgaW4tZmxpZ2h0IHRvb2xzXCIsICgpID0+IHtcbiAgICBtYXJrVG9vbFN0YXJ0KFwidG9vbC0xXCIsIHRydWUpO1xuICAgIC8vIEFnZSBzaG91bGQgYmUgdmVyeSBzbWFsbCAoPCAxMDBtcylcbiAgICBhc3NlcnQub2soZ2V0T2xkZXN0SW5GbGlnaHRUb29sQWdlTXMoKSA8IDEwMCk7XG4gIH0pO1xuXG4gIGl0KFwiY2xlYXJzIGFsbCBpbi1mbGlnaHQgdG9vbHNcIiwgKCkgPT4ge1xuICAgIG1hcmtUb29sU3RhcnQoXCJ0b29sLTFcIiwgdHJ1ZSk7XG4gICAgbWFya1Rvb2xTdGFydChcInRvb2wtMlwiLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0SW5GbGlnaHRUb29sQ291bnQoKSwgMik7XG4gICAgY2xlYXJJbkZsaWdodFRvb2xzKCk7XG4gICAgYXNzZXJ0LmVxdWFsKGdldEluRmxpZ2h0VG9vbENvdW50KCksIDApO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLElBQUksa0JBQWtCO0FBQ3pDLE9BQU8sWUFBWTtBQUNuQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQLFNBQVMsc0JBQXNCLE1BQU07QUFDbkMsYUFBVyxNQUFNO0FBQ2YsdUJBQW1CO0FBQUEsRUFDckIsQ0FBQztBQUVELEtBQUcsNkJBQTZCLE1BQU07QUFDcEMsV0FBTyxNQUFNLHFCQUFxQixHQUFHLENBQUM7QUFDdEMsa0JBQWMsVUFBVSxJQUFJO0FBQzVCLFdBQU8sTUFBTSxxQkFBcUIsR0FBRyxDQUFDO0FBQ3RDLGdCQUFZLFFBQVE7QUFDcEIsV0FBTyxNQUFNLHFCQUFxQixHQUFHLENBQUM7QUFBQSxFQUN4QyxDQUFDO0FBRUQsS0FBRyxrQ0FBa0MsTUFBTTtBQUN6QyxrQkFBYyxVQUFVLEtBQUs7QUFDN0IsV0FBTyxNQUFNLHFCQUFxQixHQUFHLENBQUM7QUFBQSxFQUN4QyxDQUFDO0FBRUQsS0FBRyx5Q0FBeUMsTUFBTTtBQUNoRCxXQUFPLE1BQU0sMkJBQTJCLEdBQUcsQ0FBQztBQUFBLEVBQzlDLENBQUM7QUFFRCxLQUFHLDRDQUE0QyxNQUFNO0FBQ25ELGtCQUFjLFVBQVUsSUFBSTtBQUU1QixXQUFPLEdBQUcsMkJBQTJCLElBQUksR0FBRztBQUFBLEVBQzlDLENBQUM7QUFFRCxLQUFHLDhCQUE4QixNQUFNO0FBQ3JDLGtCQUFjLFVBQVUsSUFBSTtBQUM1QixrQkFBYyxVQUFVLElBQUk7QUFDNUIsV0FBTyxNQUFNLHFCQUFxQixHQUFHLENBQUM7QUFDdEMsdUJBQW1CO0FBQ25CLFdBQU8sTUFBTSxxQkFBcUIsR0FBRyxDQUFDO0FBQUEsRUFDeEMsQ0FBQztBQUNILENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
