import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isLowEntropyResumePrompt } from "../bootstrap/system-context.js";
describe("#3615 \u2014 RESUME_INTENT_PATTERNS behavior", () => {
  const shouldMatch = [
    "continue",
    "Continue",
    "CONTINUE",
    "continue.",
    "continue!",
    "resume",
    "ok",
    "OK",
    "Ok!",
    "go",
    "go ahead",
    "Go ahead.",
    "proceed",
    "keep going",
    "carry on",
    "next",
    "yes",
    "yeah",
    "yep",
    "sure",
    "do it",
    "let's go",
    "pick up where you left off",
    "  continue  "
  ];
  const shouldNotMatch = [
    "help",
    "status",
    "/gsd auto",
    "/gsd stats",
    "what's the plan?",
    "show me the logs",
    "abort",
    "stop",
    "cancel",
    "replan this slice",
    "I think we should change the approach",
    "can you explain what you just did?",
    "run the tests",
    "check the build",
    "Execute the next task: T01",
    "what files were changed",
    ""
  ];
  for (const prompt of shouldMatch) {
    test(`matches resume prompt: "${prompt}"`, () => {
      assert.equal(isLowEntropyResumePrompt(prompt), true);
    });
  }
  for (const prompt of shouldNotMatch) {
    test(`rejects non-resume prompt: "${prompt}"`, () => {
      assert.equal(isLowEntropyResumePrompt(prompt), false);
    });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy91bnN0cnVjdHVyZWQtY29udGludWUtY29udGV4dC1pbmplY3Rpb24udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgXHUyMDE0IFJlZ3Jlc3Npb24gdGVzdCBmb3IgIzM2MTU6IHVuc3RydWN0dXJlZCBcImNvbnRpbnVlXCIgbXVzdCBpbmplY3QgdGFzayBjb250ZXh0XG5cbmltcG9ydCB7IGRlc2NyaWJlLCB0ZXN0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5cbmltcG9ydCB7IGlzTG93RW50cm9weVJlc3VtZVByb21wdCB9IGZyb20gXCIuLi9ib290c3RyYXAvc3lzdGVtLWNvbnRleHQudHNcIjtcblxuZGVzY3JpYmUoXCIjMzYxNSBcdTIwMTQgUkVTVU1FX0lOVEVOVF9QQVRURVJOUyBiZWhhdmlvclwiLCAoKSA9PiB7XG4gIGNvbnN0IHNob3VsZE1hdGNoID0gW1xuICAgIFwiY29udGludWVcIixcbiAgICBcIkNvbnRpbnVlXCIsXG4gICAgXCJDT05USU5VRVwiLFxuICAgIFwiY29udGludWUuXCIsXG4gICAgXCJjb250aW51ZSFcIixcbiAgICBcInJlc3VtZVwiLFxuICAgIFwib2tcIixcbiAgICBcIk9LXCIsXG4gICAgXCJPayFcIixcbiAgICBcImdvXCIsXG4gICAgXCJnbyBhaGVhZFwiLFxuICAgIFwiR28gYWhlYWQuXCIsXG4gICAgXCJwcm9jZWVkXCIsXG4gICAgXCJrZWVwIGdvaW5nXCIsXG4gICAgXCJjYXJyeSBvblwiLFxuICAgIFwibmV4dFwiLFxuICAgIFwieWVzXCIsXG4gICAgXCJ5ZWFoXCIsXG4gICAgXCJ5ZXBcIixcbiAgICBcInN1cmVcIixcbiAgICBcImRvIGl0XCIsXG4gICAgXCJsZXQncyBnb1wiLFxuICAgIFwicGljayB1cCB3aGVyZSB5b3UgbGVmdCBvZmZcIixcbiAgICBcIiAgY29udGludWUgIFwiLFxuICBdO1xuXG4gIGNvbnN0IHNob3VsZE5vdE1hdGNoID0gW1xuICAgIFwiaGVscFwiLFxuICAgIFwic3RhdHVzXCIsXG4gICAgXCIvZ3NkIGF1dG9cIixcbiAgICBcIi9nc2Qgc3RhdHNcIixcbiAgICBcIndoYXQncyB0aGUgcGxhbj9cIixcbiAgICBcInNob3cgbWUgdGhlIGxvZ3NcIixcbiAgICBcImFib3J0XCIsXG4gICAgXCJzdG9wXCIsXG4gICAgXCJjYW5jZWxcIixcbiAgICBcInJlcGxhbiB0aGlzIHNsaWNlXCIsXG4gICAgXCJJIHRoaW5rIHdlIHNob3VsZCBjaGFuZ2UgdGhlIGFwcHJvYWNoXCIsXG4gICAgXCJjYW4geW91IGV4cGxhaW4gd2hhdCB5b3UganVzdCBkaWQ/XCIsXG4gICAgXCJydW4gdGhlIHRlc3RzXCIsXG4gICAgXCJjaGVjayB0aGUgYnVpbGRcIixcbiAgICBcIkV4ZWN1dGUgdGhlIG5leHQgdGFzazogVDAxXCIsXG4gICAgXCJ3aGF0IGZpbGVzIHdlcmUgY2hhbmdlZFwiLFxuICAgIFwiXCIsXG4gIF07XG5cbiAgZm9yIChjb25zdCBwcm9tcHQgb2Ygc2hvdWxkTWF0Y2gpIHtcbiAgICB0ZXN0KGBtYXRjaGVzIHJlc3VtZSBwcm9tcHQ6IFwiJHtwcm9tcHR9XCJgLCAoKSA9PiB7XG4gICAgICBhc3NlcnQuZXF1YWwoaXNMb3dFbnRyb3B5UmVzdW1lUHJvbXB0KHByb21wdCksIHRydWUpO1xuICAgIH0pO1xuICB9XG5cbiAgZm9yIChjb25zdCBwcm9tcHQgb2Ygc2hvdWxkTm90TWF0Y2gpIHtcbiAgICB0ZXN0KGByZWplY3RzIG5vbi1yZXN1bWUgcHJvbXB0OiBcIiR7cHJvbXB0fVwiYCwgKCkgPT4ge1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzTG93RW50cm9weVJlc3VtZVByb21wdChwcm9tcHQpLCBmYWxzZSk7XG4gICAgfSk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBRW5CLFNBQVMsZ0NBQWdDO0FBRXpDLFNBQVMsZ0RBQTJDLE1BQU07QUFDeEQsUUFBTSxjQUFjO0FBQUEsSUFDbEI7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0Y7QUFFQSxRQUFNLGlCQUFpQjtBQUFBLElBQ3JCO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0Y7QUFFQSxhQUFXLFVBQVUsYUFBYTtBQUNoQyxTQUFLLDJCQUEyQixNQUFNLEtBQUssTUFBTTtBQUMvQyxhQUFPLE1BQU0seUJBQXlCLE1BQU0sR0FBRyxJQUFJO0FBQUEsSUFDckQsQ0FBQztBQUFBLEVBQ0g7QUFFQSxhQUFXLFVBQVUsZ0JBQWdCO0FBQ25DLFNBQUssK0JBQStCLE1BQU0sS0FBSyxNQUFNO0FBQ25ELGFBQU8sTUFBTSx5QkFBeUIsTUFBTSxHQUFHLEtBQUs7QUFBQSxJQUN0RCxDQUFDO0FBQUEsRUFDSDtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
