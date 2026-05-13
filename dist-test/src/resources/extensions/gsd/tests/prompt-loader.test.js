import test from "node:test";
import assert from "node:assert/strict";
import { loadPrompt } from "../prompt-loader.js";
test("loadPrompt reports missing template variables with balanced braces", () => {
  assert.throws(
    () => loadPrompt("guided-discuss-milestone", {
      milestoneId: "M001",
      milestoneTitle: "Missing working directory",
      structuredQuestionsAvailable: "false",
      fastPathInstruction: "",
      inlinedTemplates: "context template",
      commitInstruction: "Do not commit during this test."
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /template declares \{\{workingDirectory\}\} but no value was provided/);
      assert.doesNotMatch(error.message, /\{\{workingDirectory\}\}\}/);
      return true;
    }
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wcm9tcHQtbG9hZGVyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQgeyBsb2FkUHJvbXB0IH0gZnJvbSBcIi4uL3Byb21wdC1sb2FkZXIudHNcIjtcblxudGVzdChcImxvYWRQcm9tcHQgcmVwb3J0cyBtaXNzaW5nIHRlbXBsYXRlIHZhcmlhYmxlcyB3aXRoIGJhbGFuY2VkIGJyYWNlc1wiLCAoKSA9PiB7XG4gIGFzc2VydC50aHJvd3MoXG4gICAgKCkgPT4gbG9hZFByb21wdChcImd1aWRlZC1kaXNjdXNzLW1pbGVzdG9uZVwiLCB7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICBtaWxlc3RvbmVUaXRsZTogXCJNaXNzaW5nIHdvcmtpbmcgZGlyZWN0b3J5XCIsXG4gICAgICBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlOiBcImZhbHNlXCIsXG4gICAgICBmYXN0UGF0aEluc3RydWN0aW9uOiBcIlwiLFxuICAgICAgaW5saW5lZFRlbXBsYXRlczogXCJjb250ZXh0IHRlbXBsYXRlXCIsXG4gICAgICBjb21taXRJbnN0cnVjdGlvbjogXCJEbyBub3QgY29tbWl0IGR1cmluZyB0aGlzIHRlc3QuXCIsXG4gICAgfSksXG4gICAgKGVycm9yKSA9PiB7XG4gICAgICBhc3NlcnQub2soZXJyb3IgaW5zdGFuY2VvZiBFcnJvcik7XG4gICAgICBhc3NlcnQubWF0Y2goZXJyb3IubWVzc2FnZSwgL3RlbXBsYXRlIGRlY2xhcmVzIFxce1xce3dvcmtpbmdEaXJlY3RvcnlcXH1cXH0gYnV0IG5vIHZhbHVlIHdhcyBwcm92aWRlZC8pO1xuICAgICAgYXNzZXJ0LmRvZXNOb3RNYXRjaChlcnJvci5tZXNzYWdlLCAvXFx7XFx7d29ya2luZ0RpcmVjdG9yeVxcfVxcfVxcfS8pO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSxcbiAgKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUVuQixTQUFTLGtCQUFrQjtBQUUzQixLQUFLLHNFQUFzRSxNQUFNO0FBQy9FLFNBQU87QUFBQSxJQUNMLE1BQU0sV0FBVyw0QkFBNEI7QUFBQSxNQUMzQyxhQUFhO0FBQUEsTUFDYixnQkFBZ0I7QUFBQSxNQUNoQiw4QkFBOEI7QUFBQSxNQUM5QixxQkFBcUI7QUFBQSxNQUNyQixrQkFBa0I7QUFBQSxNQUNsQixtQkFBbUI7QUFBQSxJQUNyQixDQUFDO0FBQUEsSUFDRCxDQUFDLFVBQVU7QUFDVCxhQUFPLEdBQUcsaUJBQWlCLEtBQUs7QUFDaEMsYUFBTyxNQUFNLE1BQU0sU0FBUyxzRUFBc0U7QUFDbEcsYUFBTyxhQUFhLE1BQU0sU0FBUyw0QkFBNEI7QUFDL0QsYUFBTztBQUFBLElBQ1Q7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
