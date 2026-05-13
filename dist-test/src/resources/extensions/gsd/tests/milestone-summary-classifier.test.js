import test from "node:test";
import assert from "node:assert/strict";
import { classifyMilestoneSummaryContent } from "../milestone-summary-classifier.js";
test("milestone SUMMARY classifier treats explicit failed status as failure", () => {
  assert.equal(
    classifyMilestoneSummaryContent([
      "---",
      "status: failed",
      "---",
      "",
      "# M001 Summary",
      "Recovery stopped."
    ].join("\n")),
    "failure"
  );
});
test("milestone SUMMARY classifier does not treat historical not-complete prose as failure", () => {
  assert.equal(
    classifyMilestoneSummaryContent([
      "# M001 Summary",
      "",
      "This milestone was previously not complete, now resolved."
    ].join("\n")),
    "unknown"
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9taWxlc3RvbmUtc3VtbWFyeS1jbGFzc2lmaWVyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQgeyBjbGFzc2lmeU1pbGVzdG9uZVN1bW1hcnlDb250ZW50IH0gZnJvbSBcIi4uL21pbGVzdG9uZS1zdW1tYXJ5LWNsYXNzaWZpZXIudHNcIjtcblxudGVzdChcIm1pbGVzdG9uZSBTVU1NQVJZIGNsYXNzaWZpZXIgdHJlYXRzIGV4cGxpY2l0IGZhaWxlZCBzdGF0dXMgYXMgZmFpbHVyZVwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChcbiAgICBjbGFzc2lmeU1pbGVzdG9uZVN1bW1hcnlDb250ZW50KFtcbiAgICAgIFwiLS0tXCIsXG4gICAgICBcInN0YXR1czogZmFpbGVkXCIsXG4gICAgICBcIi0tLVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyBNMDAxIFN1bW1hcnlcIixcbiAgICAgIFwiUmVjb3Zlcnkgc3RvcHBlZC5cIixcbiAgICBdLmpvaW4oXCJcXG5cIikpLFxuICAgIFwiZmFpbHVyZVwiLFxuICApO1xufSk7XG5cbnRlc3QoXCJtaWxlc3RvbmUgU1VNTUFSWSBjbGFzc2lmaWVyIGRvZXMgbm90IHRyZWF0IGhpc3RvcmljYWwgbm90LWNvbXBsZXRlIHByb3NlIGFzIGZhaWx1cmVcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoXG4gICAgY2xhc3NpZnlNaWxlc3RvbmVTdW1tYXJ5Q29udGVudChbXG4gICAgICBcIiMgTTAwMSBTdW1tYXJ5XCIsXG4gICAgICBcIlwiLFxuICAgICAgXCJUaGlzIG1pbGVzdG9uZSB3YXMgcHJldmlvdXNseSBub3QgY29tcGxldGUsIG5vdyByZXNvbHZlZC5cIixcbiAgICBdLmpvaW4oXCJcXG5cIikpLFxuICAgIFwidW5rbm93blwiLFxuICApO1xufSk7XG5cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFFbkIsU0FBUyx1Q0FBdUM7QUFFaEQsS0FBSyx5RUFBeUUsTUFBTTtBQUNsRixTQUFPO0FBQUEsSUFDTCxnQ0FBZ0M7QUFBQSxNQUM5QjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRixFQUFFLEtBQUssSUFBSSxDQUFDO0FBQUEsSUFDWjtBQUFBLEVBQ0Y7QUFDRixDQUFDO0FBRUQsS0FBSyx3RkFBd0YsTUFBTTtBQUNqRyxTQUFPO0FBQUEsSUFDTCxnQ0FBZ0M7QUFBQSxNQUM5QjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRixFQUFFLEtBQUssSUFBSSxDQUFDO0FBQUEsSUFDWjtBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
