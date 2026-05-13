import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConflictsWith } from "../agents.js";
describe("parseConflictsWith", () => {
  it("parses comma-separated conflict list", () => {
    const result = parseConflictsWith("plan-milestone, plan-slice, research-milestone");
    assert.deepEqual(result, ["plan-milestone", "plan-slice", "research-milestone"]);
  });
  it("returns undefined for undefined input", () => {
    assert.equal(parseConflictsWith(void 0), void 0);
  });
  it("returns undefined for empty string", () => {
    assert.equal(parseConflictsWith(""), void 0);
  });
  it("handles single value without commas", () => {
    const result = parseConflictsWith("plan-milestone");
    assert.deepEqual(result, ["plan-milestone"]);
  });
  it("trims whitespace from values", () => {
    const result = parseConflictsWith("  plan-milestone ,  plan-slice  ");
    assert.deepEqual(result, ["plan-milestone", "plan-slice"]);
  });
  it("filters out empty entries from trailing commas", () => {
    const result = parseConflictsWith("plan-milestone,,plan-slice,");
    assert.deepEqual(result, ["plan-milestone", "plan-slice"]);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3N1YmFnZW50L3Rlc3RzL2FnZW50cy1jb25mbGljdHMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBwYXJzZUNvbmZsaWN0c1dpdGggfSBmcm9tIFwiLi4vYWdlbnRzLmpzXCI7XG5cbmRlc2NyaWJlKFwicGFyc2VDb25mbGljdHNXaXRoXCIsICgpID0+IHtcblx0aXQoXCJwYXJzZXMgY29tbWEtc2VwYXJhdGVkIGNvbmZsaWN0IGxpc3RcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IHBhcnNlQ29uZmxpY3RzV2l0aChcInBsYW4tbWlsZXN0b25lLCBwbGFuLXNsaWNlLCByZXNlYXJjaC1taWxlc3RvbmVcIik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIFtcInBsYW4tbWlsZXN0b25lXCIsIFwicGxhbi1zbGljZVwiLCBcInJlc2VhcmNoLW1pbGVzdG9uZVwiXSk7XG5cdH0pO1xuXG5cdGl0KFwicmV0dXJucyB1bmRlZmluZWQgZm9yIHVuZGVmaW5lZCBpbnB1dFwiLCAoKSA9PiB7XG5cdFx0YXNzZXJ0LmVxdWFsKHBhcnNlQ29uZmxpY3RzV2l0aCh1bmRlZmluZWQpLCB1bmRlZmluZWQpO1xuXHR9KTtcblxuXHRpdChcInJldHVybnMgdW5kZWZpbmVkIGZvciBlbXB0eSBzdHJpbmdcIiwgKCkgPT4ge1xuXHRcdGFzc2VydC5lcXVhbChwYXJzZUNvbmZsaWN0c1dpdGgoXCJcIiksIHVuZGVmaW5lZCk7XG5cdH0pO1xuXG5cdGl0KFwiaGFuZGxlcyBzaW5nbGUgdmFsdWUgd2l0aG91dCBjb21tYXNcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IHBhcnNlQ29uZmxpY3RzV2l0aChcInBsYW4tbWlsZXN0b25lXCIpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LCBbXCJwbGFuLW1pbGVzdG9uZVwiXSk7XG5cdH0pO1xuXG5cdGl0KFwidHJpbXMgd2hpdGVzcGFjZSBmcm9tIHZhbHVlc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcGFyc2VDb25mbGljdHNXaXRoKFwiICBwbGFuLW1pbGVzdG9uZSAsICBwbGFuLXNsaWNlICBcIik7XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChyZXN1bHQsIFtcInBsYW4tbWlsZXN0b25lXCIsIFwicGxhbi1zbGljZVwiXSk7XG5cdH0pO1xuXG5cdGl0KFwiZmlsdGVycyBvdXQgZW1wdHkgZW50cmllcyBmcm9tIHRyYWlsaW5nIGNvbW1hc1wiLCAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gcGFyc2VDb25mbGljdHNXaXRoKFwicGxhbi1taWxlc3RvbmUsLHBsYW4tc2xpY2UsXCIpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LCBbXCJwbGFuLW1pbGVzdG9uZVwiLCBcInBsYW4tc2xpY2VcIl0pO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLFVBQVU7QUFDN0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsMEJBQTBCO0FBRW5DLFNBQVMsc0JBQXNCLE1BQU07QUFDcEMsS0FBRyx3Q0FBd0MsTUFBTTtBQUNoRCxVQUFNLFNBQVMsbUJBQW1CLGdEQUFnRDtBQUNsRixXQUFPLFVBQVUsUUFBUSxDQUFDLGtCQUFrQixjQUFjLG9CQUFvQixDQUFDO0FBQUEsRUFDaEYsQ0FBQztBQUVELEtBQUcseUNBQXlDLE1BQU07QUFDakQsV0FBTyxNQUFNLG1CQUFtQixNQUFTLEdBQUcsTUFBUztBQUFBLEVBQ3RELENBQUM7QUFFRCxLQUFHLHNDQUFzQyxNQUFNO0FBQzlDLFdBQU8sTUFBTSxtQkFBbUIsRUFBRSxHQUFHLE1BQVM7QUFBQSxFQUMvQyxDQUFDO0FBRUQsS0FBRyx1Q0FBdUMsTUFBTTtBQUMvQyxVQUFNLFNBQVMsbUJBQW1CLGdCQUFnQjtBQUNsRCxXQUFPLFVBQVUsUUFBUSxDQUFDLGdCQUFnQixDQUFDO0FBQUEsRUFDNUMsQ0FBQztBQUVELEtBQUcsZ0NBQWdDLE1BQU07QUFDeEMsVUFBTSxTQUFTLG1CQUFtQixrQ0FBa0M7QUFDcEUsV0FBTyxVQUFVLFFBQVEsQ0FBQyxrQkFBa0IsWUFBWSxDQUFDO0FBQUEsRUFDMUQsQ0FBQztBQUVELEtBQUcsa0RBQWtELE1BQU07QUFDMUQsVUFBTSxTQUFTLG1CQUFtQiw2QkFBNkI7QUFDL0QsV0FBTyxVQUFVLFFBQVEsQ0FBQyxrQkFBa0IsWUFBWSxDQUFDO0FBQUEsRUFDMUQsQ0FBQztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
