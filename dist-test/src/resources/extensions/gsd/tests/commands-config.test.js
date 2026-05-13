import test from "node:test";
import assert from "node:assert/strict";
import { getStoredToolKey } from "../commands-config.js";
test("stored tool key lookup skips empty api_key entries", () => {
  const auth = {
    getCredentialsForProvider(providerId) {
      assert.equal(providerId, "tavily");
      return [
        { type: "api_key", key: "" },
        { type: "oauth", accessToken: "oauth-token" },
        { type: "api_key", key: "tool-key" }
      ];
    }
  };
  assert.equal(getStoredToolKey(auth, "tavily"), "tool-key");
});
test("stored tool key lookup returns undefined when only shadowing credentials exist", () => {
  const auth = {
    getCredentialsForProvider() {
      return [
        { type: "api_key", key: "" },
        { type: "oauth", accessToken: "oauth-token" }
      ];
    }
  };
  assert.equal(getStoredToolKey(auth, "brave"), void 0);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21tYW5kcy1jb25maWcudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBnZXRTdG9yZWRUb29sS2V5IH0gZnJvbSBcIi4uL2NvbW1hbmRzLWNvbmZpZy50c1wiO1xuXG50ZXN0KFwic3RvcmVkIHRvb2wga2V5IGxvb2t1cCBza2lwcyBlbXB0eSBhcGlfa2V5IGVudHJpZXNcIiwgKCkgPT4ge1xuICBjb25zdCBhdXRoID0ge1xuICAgIGdldENyZWRlbnRpYWxzRm9yUHJvdmlkZXIocHJvdmlkZXJJZDogc3RyaW5nKSB7XG4gICAgICBhc3NlcnQuZXF1YWwocHJvdmlkZXJJZCwgXCJ0YXZpbHlcIik7XG4gICAgICByZXR1cm4gW1xuICAgICAgICB7IHR5cGU6IFwiYXBpX2tleVwiLCBrZXk6IFwiXCIgfSxcbiAgICAgICAgeyB0eXBlOiBcIm9hdXRoXCIsIGFjY2Vzc1Rva2VuOiBcIm9hdXRoLXRva2VuXCIgfSxcbiAgICAgICAgeyB0eXBlOiBcImFwaV9rZXlcIiwga2V5OiBcInRvb2wta2V5XCIgfSxcbiAgICAgIF07XG4gICAgfSxcbiAgfTtcblxuICBhc3NlcnQuZXF1YWwoZ2V0U3RvcmVkVG9vbEtleShhdXRoIGFzIGFueSwgXCJ0YXZpbHlcIiksIFwidG9vbC1rZXlcIik7XG59KTtcblxudGVzdChcInN0b3JlZCB0b29sIGtleSBsb29rdXAgcmV0dXJucyB1bmRlZmluZWQgd2hlbiBvbmx5IHNoYWRvd2luZyBjcmVkZW50aWFscyBleGlzdFwiLCAoKSA9PiB7XG4gIGNvbnN0IGF1dGggPSB7XG4gICAgZ2V0Q3JlZGVudGlhbHNGb3JQcm92aWRlcigpIHtcbiAgICAgIHJldHVybiBbXG4gICAgICAgIHsgdHlwZTogXCJhcGlfa2V5XCIsIGtleTogXCJcIiB9LFxuICAgICAgICB7IHR5cGU6IFwib2F1dGhcIiwgYWNjZXNzVG9rZW46IFwib2F1dGgtdG9rZW5cIiB9LFxuICAgICAgXTtcbiAgICB9LFxuICB9O1xuXG4gIGFzc2VydC5lcXVhbChnZXRTdG9yZWRUb29sS2V5KGF1dGggYXMgYW55LCBcImJyYXZlXCIpLCB1bmRlZmluZWQpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsd0JBQXdCO0FBRWpDLEtBQUssc0RBQXNELE1BQU07QUFDL0QsUUFBTSxPQUFPO0FBQUEsSUFDWCwwQkFBMEIsWUFBb0I7QUFDNUMsYUFBTyxNQUFNLFlBQVksUUFBUTtBQUNqQyxhQUFPO0FBQUEsUUFDTCxFQUFFLE1BQU0sV0FBVyxLQUFLLEdBQUc7QUFBQSxRQUMzQixFQUFFLE1BQU0sU0FBUyxhQUFhLGNBQWM7QUFBQSxRQUM1QyxFQUFFLE1BQU0sV0FBVyxLQUFLLFdBQVc7QUFBQSxNQUNyQztBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBRUEsU0FBTyxNQUFNLGlCQUFpQixNQUFhLFFBQVEsR0FBRyxVQUFVO0FBQ2xFLENBQUM7QUFFRCxLQUFLLGtGQUFrRixNQUFNO0FBQzNGLFFBQU0sT0FBTztBQUFBLElBQ1gsNEJBQTRCO0FBQzFCLGFBQU87QUFBQSxRQUNMLEVBQUUsTUFBTSxXQUFXLEtBQUssR0FBRztBQUFBLFFBQzNCLEVBQUUsTUFBTSxTQUFTLGFBQWEsY0FBYztBQUFBLE1BQzlDO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxTQUFPLE1BQU0saUJBQWlCLE1BQWEsT0FBTyxHQUFHLE1BQVM7QUFDaEUsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
