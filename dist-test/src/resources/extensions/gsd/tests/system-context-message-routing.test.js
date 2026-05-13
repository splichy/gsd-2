import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildContextMessage } from "../bootstrap/system-context.js";
describe("buildContextMessage (#5019 \u2014 memory routing)", () => {
  const markedMemory = "[GSD Context Metadata]\n- Memory supplied: yes\n\n[MEMORY]\nrule one";
  test("returns null when nothing to inject", () => {
    const result = buildContextMessage({
      memoryBlock: "",
      injection: null,
      forensicsInjection: null
    });
    assert.equal(result, null);
  });
  test("whitespace-only memoryBlock counts as empty", () => {
    const result = buildContextMessage({
      memoryBlock: "   \n\n   ",
      injection: null,
      forensicsInjection: null
    });
    assert.equal(result, null);
  });
  test("memory-only path emits gsd-memory message with trimmed content", () => {
    const result = buildContextMessage({
      memoryBlock: "\n\n[MEMORY]\nrule one\nrule two\n\n",
      injection: null,
      forensicsInjection: null
    });
    assert.ok(result, "expected a context message");
    assert.equal(result.customType, "gsd-memory");
    assert.equal(result.content, "[GSD Context Metadata]\n- Memory supplied: yes\n\n[MEMORY]\nrule one\nrule two");
    assert.equal(result.display, false);
  });
  test("guided-execute injection alone emits gsd-guided-context", () => {
    const result = buildContextMessage({
      memoryBlock: "",
      injection: "[GUIDED]\nexecute T01",
      forensicsInjection: null
    });
    assert.ok(result);
    assert.equal(result.customType, "gsd-guided-context");
    assert.equal(result.content, "[GUIDED]\nexecute T01");
  });
  test("forensics injection alone emits gsd-forensics", () => {
    const result = buildContextMessage({
      memoryBlock: "",
      injection: null,
      forensicsInjection: "[FORENSICS]\ninvestigation context"
    });
    assert.ok(result);
    assert.equal(result.customType, "gsd-forensics");
    assert.equal(result.content, "[FORENSICS]\ninvestigation context");
  });
  test("memory + guided injection: memory prepended, customType is gsd-guided-context", () => {
    const result = buildContextMessage({
      memoryBlock: "[MEMORY]\nrule one",
      injection: "[GUIDED]\nexecute T01",
      forensicsInjection: null
    });
    assert.ok(result);
    assert.equal(result.customType, "gsd-guided-context");
    assert.equal(result.content, `${markedMemory}

[GUIDED]
execute T01`);
  });
  test("memory + forensics: memory prepended, customType is gsd-forensics", () => {
    const result = buildContextMessage({
      memoryBlock: "[MEMORY]\nrule one",
      injection: null,
      forensicsInjection: "[FORENSICS]\ninvestigation context"
    });
    assert.ok(result);
    assert.equal(result.customType, "gsd-forensics");
    assert.equal(result.content, `${markedMemory}

[FORENSICS]
investigation context`);
  });
  test("guided takes precedence over forensics when both are somehow present", () => {
    const result = buildContextMessage({
      memoryBlock: "",
      injection: "[GUIDED]",
      forensicsInjection: "[FORENSICS]"
    });
    assert.ok(result);
    assert.equal(result.customType, "gsd-guided-context");
    assert.equal(result.content, "[GUIDED]");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zeXN0ZW0tY29udGV4dC1tZXNzYWdlLXJvdXRpbmcudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFJlZ3Jlc3Npb24gY292ZXJhZ2UgZm9yIHZvbGF0aWxlIHN5c3RlbS1jb250ZXh0IG1lc3NhZ2Ugcm91dGluZy5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcblxuaW1wb3J0IHsgYnVpbGRDb250ZXh0TWVzc2FnZSB9IGZyb20gXCIuLi9ib290c3RyYXAvc3lzdGVtLWNvbnRleHQudHNcIjtcblxuZGVzY3JpYmUoXCJidWlsZENvbnRleHRNZXNzYWdlICgjNTAxOSBcdTIwMTQgbWVtb3J5IHJvdXRpbmcpXCIsICgpID0+IHtcbiAgY29uc3QgbWFya2VkTWVtb3J5ID0gXCJbR1NEIENvbnRleHQgTWV0YWRhdGFdXFxuLSBNZW1vcnkgc3VwcGxpZWQ6IHllc1xcblxcbltNRU1PUlldXFxucnVsZSBvbmVcIjtcblxuICB0ZXN0KFwicmV0dXJucyBudWxsIHdoZW4gbm90aGluZyB0byBpbmplY3RcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGJ1aWxkQ29udGV4dE1lc3NhZ2Uoe1xuICAgICAgbWVtb3J5QmxvY2s6IFwiXCIsXG4gICAgICBpbmplY3Rpb246IG51bGwsXG4gICAgICBmb3JlbnNpY3NJbmplY3Rpb246IG51bGwsXG4gICAgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdCwgbnVsbCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJ3aGl0ZXNwYWNlLW9ubHkgbWVtb3J5QmxvY2sgY291bnRzIGFzIGVtcHR5XCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBidWlsZENvbnRleHRNZXNzYWdlKHtcbiAgICAgIG1lbW9yeUJsb2NrOiBcIiAgIFxcblxcbiAgIFwiLFxuICAgICAgaW5qZWN0aW9uOiBudWxsLFxuICAgICAgZm9yZW5zaWNzSW5qZWN0aW9uOiBudWxsLFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIG51bGwpO1xuICB9KTtcblxuICB0ZXN0KFwibWVtb3J5LW9ubHkgcGF0aCBlbWl0cyBnc2QtbWVtb3J5IG1lc3NhZ2Ugd2l0aCB0cmltbWVkIGNvbnRlbnRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGJ1aWxkQ29udGV4dE1lc3NhZ2Uoe1xuICAgICAgbWVtb3J5QmxvY2s6IFwiXFxuXFxuW01FTU9SWV1cXG5ydWxlIG9uZVxcbnJ1bGUgdHdvXFxuXFxuXCIsXG4gICAgICBpbmplY3Rpb246IG51bGwsXG4gICAgICBmb3JlbnNpY3NJbmplY3Rpb246IG51bGwsXG4gICAgfSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdCwgXCJleHBlY3RlZCBhIGNvbnRleHQgbWVzc2FnZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmN1c3RvbVR5cGUsIFwiZ3NkLW1lbW9yeVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmNvbnRlbnQsIFwiW0dTRCBDb250ZXh0IE1ldGFkYXRhXVxcbi0gTWVtb3J5IHN1cHBsaWVkOiB5ZXNcXG5cXG5bTUVNT1JZXVxcbnJ1bGUgb25lXFxucnVsZSB0d29cIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kaXNwbGF5LCBmYWxzZSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJndWlkZWQtZXhlY3V0ZSBpbmplY3Rpb24gYWxvbmUgZW1pdHMgZ3NkLWd1aWRlZC1jb250ZXh0XCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBidWlsZENvbnRleHRNZXNzYWdlKHtcbiAgICAgIG1lbW9yeUJsb2NrOiBcIlwiLFxuICAgICAgaW5qZWN0aW9uOiBcIltHVUlERURdXFxuZXhlY3V0ZSBUMDFcIixcbiAgICAgIGZvcmVuc2ljc0luamVjdGlvbjogbnVsbCxcbiAgICB9KTtcbiAgICBhc3NlcnQub2socmVzdWx0KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmN1c3RvbVR5cGUsIFwiZ3NkLWd1aWRlZC1jb250ZXh0XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY29udGVudCwgXCJbR1VJREVEXVxcbmV4ZWN1dGUgVDAxXCIpO1xuICB9KTtcblxuICB0ZXN0KFwiZm9yZW5zaWNzIGluamVjdGlvbiBhbG9uZSBlbWl0cyBnc2QtZm9yZW5zaWNzXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBidWlsZENvbnRleHRNZXNzYWdlKHtcbiAgICAgIG1lbW9yeUJsb2NrOiBcIlwiLFxuICAgICAgaW5qZWN0aW9uOiBudWxsLFxuICAgICAgZm9yZW5zaWNzSW5qZWN0aW9uOiBcIltGT1JFTlNJQ1NdXFxuaW52ZXN0aWdhdGlvbiBjb250ZXh0XCIsXG4gICAgfSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jdXN0b21UeXBlLCBcImdzZC1mb3JlbnNpY3NcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5jb250ZW50LCBcIltGT1JFTlNJQ1NdXFxuaW52ZXN0aWdhdGlvbiBjb250ZXh0XCIpO1xuICB9KTtcblxuICB0ZXN0KFwibWVtb3J5ICsgZ3VpZGVkIGluamVjdGlvbjogbWVtb3J5IHByZXBlbmRlZCwgY3VzdG9tVHlwZSBpcyBnc2QtZ3VpZGVkLWNvbnRleHRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGJ1aWxkQ29udGV4dE1lc3NhZ2Uoe1xuICAgICAgbWVtb3J5QmxvY2s6IFwiW01FTU9SWV1cXG5ydWxlIG9uZVwiLFxuICAgICAgaW5qZWN0aW9uOiBcIltHVUlERURdXFxuZXhlY3V0ZSBUMDFcIixcbiAgICAgIGZvcmVuc2ljc0luamVjdGlvbjogbnVsbCxcbiAgICB9KTtcbiAgICBhc3NlcnQub2socmVzdWx0KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmN1c3RvbVR5cGUsIFwiZ3NkLWd1aWRlZC1jb250ZXh0XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY29udGVudCwgYCR7bWFya2VkTWVtb3J5fVxcblxcbltHVUlERURdXFxuZXhlY3V0ZSBUMDFgKTtcbiAgfSk7XG5cbiAgdGVzdChcIm1lbW9yeSArIGZvcmVuc2ljczogbWVtb3J5IHByZXBlbmRlZCwgY3VzdG9tVHlwZSBpcyBnc2QtZm9yZW5zaWNzXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBidWlsZENvbnRleHRNZXNzYWdlKHtcbiAgICAgIG1lbW9yeUJsb2NrOiBcIltNRU1PUlldXFxucnVsZSBvbmVcIixcbiAgICAgIGluamVjdGlvbjogbnVsbCxcbiAgICAgIGZvcmVuc2ljc0luamVjdGlvbjogXCJbRk9SRU5TSUNTXVxcbmludmVzdGlnYXRpb24gY29udGV4dFwiLFxuICAgIH0pO1xuICAgIGFzc2VydC5vayhyZXN1bHQpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY3VzdG9tVHlwZSwgXCJnc2QtZm9yZW5zaWNzXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY29udGVudCwgYCR7bWFya2VkTWVtb3J5fVxcblxcbltGT1JFTlNJQ1NdXFxuaW52ZXN0aWdhdGlvbiBjb250ZXh0YCk7XG4gIH0pO1xuXG4gIHRlc3QoXCJndWlkZWQgdGFrZXMgcHJlY2VkZW5jZSBvdmVyIGZvcmVuc2ljcyB3aGVuIGJvdGggYXJlIHNvbWVob3cgcHJlc2VudFwiLCAoKSA9PiB7XG4gICAgLy8gVGhlIGNhbGxlciBpbiBidWlsZEJlZm9yZUFnZW50U3RhcnRSZXN1bHQgYWxyZWFkeSBnYXRlcyBmb3JlbnNpY3Mgb25cbiAgICAvLyBgIWluamVjdGlvbmAsIGJ1dCB0aGUgaGVscGVyJ3MgZG9jdW1lbnRlZCBwcmlvcml0eSBpcyBndWlkZWQgPiBmb3JlbnNpY3MuXG4gICAgLy8gVGVzdCB0aGUgY29udHJhY3QgZGlyZWN0bHkgc28gYSBmdXR1cmUgcmVmYWN0b3IgY2FuJ3Qgc2lsZW50bHkgZmxpcCBpdC5cbiAgICBjb25zdCByZXN1bHQgPSBidWlsZENvbnRleHRNZXNzYWdlKHtcbiAgICAgIG1lbW9yeUJsb2NrOiBcIlwiLFxuICAgICAgaW5qZWN0aW9uOiBcIltHVUlERURdXCIsXG4gICAgICBmb3JlbnNpY3NJbmplY3Rpb246IFwiW0ZPUkVOU0lDU11cIixcbiAgICB9KTtcbiAgICBhc3NlcnQub2socmVzdWx0KTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmN1c3RvbVR5cGUsIFwiZ3NkLWd1aWRlZC1jb250ZXh0XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuY29udGVudCwgXCJbR1VJREVEXVwiKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUVuQixTQUFTLDJCQUEyQjtBQUVwQyxTQUFTLHFEQUFnRCxNQUFNO0FBQzdELFFBQU0sZUFBZTtBQUVyQixPQUFLLHVDQUF1QyxNQUFNO0FBQ2hELFVBQU0sU0FBUyxvQkFBb0I7QUFBQSxNQUNqQyxhQUFhO0FBQUEsTUFDYixXQUFXO0FBQUEsTUFDWCxvQkFBb0I7QUFBQSxJQUN0QixDQUFDO0FBQ0QsV0FBTyxNQUFNLFFBQVEsSUFBSTtBQUFBLEVBQzNCLENBQUM7QUFFRCxPQUFLLCtDQUErQyxNQUFNO0FBQ3hELFVBQU0sU0FBUyxvQkFBb0I7QUFBQSxNQUNqQyxhQUFhO0FBQUEsTUFDYixXQUFXO0FBQUEsTUFDWCxvQkFBb0I7QUFBQSxJQUN0QixDQUFDO0FBQ0QsV0FBTyxNQUFNLFFBQVEsSUFBSTtBQUFBLEVBQzNCLENBQUM7QUFFRCxPQUFLLGtFQUFrRSxNQUFNO0FBQzNFLFVBQU0sU0FBUyxvQkFBb0I7QUFBQSxNQUNqQyxhQUFhO0FBQUEsTUFDYixXQUFXO0FBQUEsTUFDWCxvQkFBb0I7QUFBQSxJQUN0QixDQUFDO0FBQ0QsV0FBTyxHQUFHLFFBQVEsNEJBQTRCO0FBQzlDLFdBQU8sTUFBTSxPQUFPLFlBQVksWUFBWTtBQUM1QyxXQUFPLE1BQU0sT0FBTyxTQUFTLGdGQUFnRjtBQUM3RyxXQUFPLE1BQU0sT0FBTyxTQUFTLEtBQUs7QUFBQSxFQUNwQyxDQUFDO0FBRUQsT0FBSywyREFBMkQsTUFBTTtBQUNwRSxVQUFNLFNBQVMsb0JBQW9CO0FBQUEsTUFDakMsYUFBYTtBQUFBLE1BQ2IsV0FBVztBQUFBLE1BQ1gsb0JBQW9CO0FBQUEsSUFDdEIsQ0FBQztBQUNELFdBQU8sR0FBRyxNQUFNO0FBQ2hCLFdBQU8sTUFBTSxPQUFPLFlBQVksb0JBQW9CO0FBQ3BELFdBQU8sTUFBTSxPQUFPLFNBQVMsdUJBQXVCO0FBQUEsRUFDdEQsQ0FBQztBQUVELE9BQUssaURBQWlELE1BQU07QUFDMUQsVUFBTSxTQUFTLG9CQUFvQjtBQUFBLE1BQ2pDLGFBQWE7QUFBQSxNQUNiLFdBQVc7QUFBQSxNQUNYLG9CQUFvQjtBQUFBLElBQ3RCLENBQUM7QUFDRCxXQUFPLEdBQUcsTUFBTTtBQUNoQixXQUFPLE1BQU0sT0FBTyxZQUFZLGVBQWU7QUFDL0MsV0FBTyxNQUFNLE9BQU8sU0FBUyxvQ0FBb0M7QUFBQSxFQUNuRSxDQUFDO0FBRUQsT0FBSyxpRkFBaUYsTUFBTTtBQUMxRixVQUFNLFNBQVMsb0JBQW9CO0FBQUEsTUFDakMsYUFBYTtBQUFBLE1BQ2IsV0FBVztBQUFBLE1BQ1gsb0JBQW9CO0FBQUEsSUFDdEIsQ0FBQztBQUNELFdBQU8sR0FBRyxNQUFNO0FBQ2hCLFdBQU8sTUFBTSxPQUFPLFlBQVksb0JBQW9CO0FBQ3BELFdBQU8sTUFBTSxPQUFPLFNBQVMsR0FBRyxZQUFZO0FBQUE7QUFBQTtBQUFBLFlBQTJCO0FBQUEsRUFDekUsQ0FBQztBQUVELE9BQUsscUVBQXFFLE1BQU07QUFDOUUsVUFBTSxTQUFTLG9CQUFvQjtBQUFBLE1BQ2pDLGFBQWE7QUFBQSxNQUNiLFdBQVc7QUFBQSxNQUNYLG9CQUFvQjtBQUFBLElBQ3RCLENBQUM7QUFDRCxXQUFPLEdBQUcsTUFBTTtBQUNoQixXQUFPLE1BQU0sT0FBTyxZQUFZLGVBQWU7QUFDL0MsV0FBTyxNQUFNLE9BQU8sU0FBUyxHQUFHLFlBQVk7QUFBQTtBQUFBO0FBQUEsc0JBQXdDO0FBQUEsRUFDdEYsQ0FBQztBQUVELE9BQUssd0VBQXdFLE1BQU07QUFJakYsVUFBTSxTQUFTLG9CQUFvQjtBQUFBLE1BQ2pDLGFBQWE7QUFBQSxNQUNiLFdBQVc7QUFBQSxNQUNYLG9CQUFvQjtBQUFBLElBQ3RCLENBQUM7QUFDRCxXQUFPLEdBQUcsTUFBTTtBQUNoQixXQUFPLE1BQU0sT0FBTyxZQUFZLG9CQUFvQjtBQUNwRCxXQUFPLE1BQU0sT0FBTyxTQUFTLFVBQVU7QUFBQSxFQUN6QyxDQUFDO0FBQ0gsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
