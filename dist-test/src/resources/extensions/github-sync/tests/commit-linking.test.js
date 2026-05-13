import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTaskCommitMessage } from "../../gsd/git-service.js";
describe("commit linking", () => {
  it("appends Resolves #N when issueNumber is set", () => {
    const msg = buildTaskCommitMessage({
      taskId: "S01/T02",
      taskTitle: "implement auth",
      issueNumber: 43
    });
    assert.ok(msg.includes("Resolves #43"), "should include Resolves trailer");
    assert.ok(msg.startsWith("feat:"), "subject line has no scope");
    assert.ok(msg.includes("GSD-Task: S01/T02"), "GSD-Task trailer present");
  });
  it("includes both key files and Resolves #N", () => {
    const msg = buildTaskCommitMessage({
      taskId: "S01/T02",
      taskTitle: "implement auth",
      keyFiles: ["src/auth.ts"],
      issueNumber: 43
    });
    assert.ok(msg.includes("- src/auth.ts"), "key files present");
    assert.ok(msg.includes("Resolves #43"), "Resolves trailer present");
    assert.ok(msg.includes("GSD-Task: S01/T02"), "GSD-Task trailer present");
    const keyFilesIdx = msg.indexOf("- src/auth.ts");
    const taskIdx = msg.indexOf("GSD-Task: S01/T02");
    const resolvesIdx = msg.indexOf("Resolves #43");
    assert.ok(taskIdx > keyFilesIdx, "GSD-Task after key files");
    assert.ok(resolvesIdx > taskIdx, "Resolves after GSD-Task");
  });
  it("no Resolves trailer when issueNumber is not set", () => {
    const msg = buildTaskCommitMessage({
      taskId: "S01/T02",
      taskTitle: "implement auth"
    });
    assert.ok(!msg.includes("Resolves"), "no Resolves when no issueNumber");
    assert.ok(msg.includes("GSD-Task: S01/T02"), "GSD-Task trailer still present");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dpdGh1Yi1zeW5jL3Rlc3RzL2NvbW1pdC1saW5raW5nLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGRlc2NyaWJlLCBpdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgYnVpbGRUYXNrQ29tbWl0TWVzc2FnZSB9IGZyb20gXCIuLi8uLi9nc2QvZ2l0LXNlcnZpY2UudHNcIjtcblxuZGVzY3JpYmUoXCJjb21taXQgbGlua2luZ1wiLCAoKSA9PiB7XG4gIGl0KFwiYXBwZW5kcyBSZXNvbHZlcyAjTiB3aGVuIGlzc3VlTnVtYmVyIGlzIHNldFwiLCAoKSA9PiB7XG4gICAgY29uc3QgbXNnID0gYnVpbGRUYXNrQ29tbWl0TWVzc2FnZSh7XG4gICAgICB0YXNrSWQ6IFwiUzAxL1QwMlwiLFxuICAgICAgdGFza1RpdGxlOiBcImltcGxlbWVudCBhdXRoXCIsXG4gICAgICBpc3N1ZU51bWJlcjogNDMsXG4gICAgfSk7XG4gICAgYXNzZXJ0Lm9rKG1zZy5pbmNsdWRlcyhcIlJlc29sdmVzICM0M1wiKSwgXCJzaG91bGQgaW5jbHVkZSBSZXNvbHZlcyB0cmFpbGVyXCIpO1xuICAgIGFzc2VydC5vayhtc2cuc3RhcnRzV2l0aChcImZlYXQ6XCIpLCBcInN1YmplY3QgbGluZSBoYXMgbm8gc2NvcGVcIik7XG4gICAgYXNzZXJ0Lm9rKG1zZy5pbmNsdWRlcyhcIkdTRC1UYXNrOiBTMDEvVDAyXCIpLCBcIkdTRC1UYXNrIHRyYWlsZXIgcHJlc2VudFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJpbmNsdWRlcyBib3RoIGtleSBmaWxlcyBhbmQgUmVzb2x2ZXMgI05cIiwgKCkgPT4ge1xuICAgIGNvbnN0IG1zZyA9IGJ1aWxkVGFza0NvbW1pdE1lc3NhZ2Uoe1xuICAgICAgdGFza0lkOiBcIlMwMS9UMDJcIixcbiAgICAgIHRhc2tUaXRsZTogXCJpbXBsZW1lbnQgYXV0aFwiLFxuICAgICAga2V5RmlsZXM6IFtcInNyYy9hdXRoLnRzXCJdLFxuICAgICAgaXNzdWVOdW1iZXI6IDQzLFxuICAgIH0pO1xuICAgIGFzc2VydC5vayhtc2cuaW5jbHVkZXMoXCItIHNyYy9hdXRoLnRzXCIpLCBcImtleSBmaWxlcyBwcmVzZW50XCIpO1xuICAgIGFzc2VydC5vayhtc2cuaW5jbHVkZXMoXCJSZXNvbHZlcyAjNDNcIiksIFwiUmVzb2x2ZXMgdHJhaWxlciBwcmVzZW50XCIpO1xuICAgIGFzc2VydC5vayhtc2cuaW5jbHVkZXMoXCJHU0QtVGFzazogUzAxL1QwMlwiKSwgXCJHU0QtVGFzayB0cmFpbGVyIHByZXNlbnRcIik7XG4gICAgLy8gR1NELVRhc2sgc2hvdWxkIGNvbWUgYWZ0ZXIga2V5IGZpbGVzIGJ1dCBiZWZvcmUgUmVzb2x2ZXNcbiAgICBjb25zdCBrZXlGaWxlc0lkeCA9IG1zZy5pbmRleE9mKFwiLSBzcmMvYXV0aC50c1wiKTtcbiAgICBjb25zdCB0YXNrSWR4ID0gbXNnLmluZGV4T2YoXCJHU0QtVGFzazogUzAxL1QwMlwiKTtcbiAgICBjb25zdCByZXNvbHZlc0lkeCA9IG1zZy5pbmRleE9mKFwiUmVzb2x2ZXMgIzQzXCIpO1xuICAgIGFzc2VydC5vayh0YXNrSWR4ID4ga2V5RmlsZXNJZHgsIFwiR1NELVRhc2sgYWZ0ZXIga2V5IGZpbGVzXCIpO1xuICAgIGFzc2VydC5vayhyZXNvbHZlc0lkeCA+IHRhc2tJZHgsIFwiUmVzb2x2ZXMgYWZ0ZXIgR1NELVRhc2tcIik7XG4gIH0pO1xuXG4gIGl0KFwibm8gUmVzb2x2ZXMgdHJhaWxlciB3aGVuIGlzc3VlTnVtYmVyIGlzIG5vdCBzZXRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG1zZyA9IGJ1aWxkVGFza0NvbW1pdE1lc3NhZ2Uoe1xuICAgICAgdGFza0lkOiBcIlMwMS9UMDJcIixcbiAgICAgIHRhc2tUaXRsZTogXCJpbXBsZW1lbnQgYXV0aFwiLFxuICAgIH0pO1xuICAgIGFzc2VydC5vayghbXNnLmluY2x1ZGVzKFwiUmVzb2x2ZXNcIiksIFwibm8gUmVzb2x2ZXMgd2hlbiBubyBpc3N1ZU51bWJlclwiKTtcbiAgICBhc3NlcnQub2sobXNnLmluY2x1ZGVzKFwiR1NELVRhc2s6IFMwMS9UMDJcIiksIFwiR1NELVRhc2sgdHJhaWxlciBzdGlsbCBwcmVzZW50XCIpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxVQUFVLFVBQVU7QUFDN0IsT0FBTyxZQUFZO0FBQ25CLFNBQVMsOEJBQThCO0FBRXZDLFNBQVMsa0JBQWtCLE1BQU07QUFDL0IsS0FBRywrQ0FBK0MsTUFBTTtBQUN0RCxVQUFNLE1BQU0sdUJBQXVCO0FBQUEsTUFDakMsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsYUFBYTtBQUFBLElBQ2YsQ0FBQztBQUNELFdBQU8sR0FBRyxJQUFJLFNBQVMsY0FBYyxHQUFHLGlDQUFpQztBQUN6RSxXQUFPLEdBQUcsSUFBSSxXQUFXLE9BQU8sR0FBRywyQkFBMkI7QUFDOUQsV0FBTyxHQUFHLElBQUksU0FBUyxtQkFBbUIsR0FBRywwQkFBMEI7QUFBQSxFQUN6RSxDQUFDO0FBRUQsS0FBRywyQ0FBMkMsTUFBTTtBQUNsRCxVQUFNLE1BQU0sdUJBQXVCO0FBQUEsTUFDakMsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsVUFBVSxDQUFDLGFBQWE7QUFBQSxNQUN4QixhQUFhO0FBQUEsSUFDZixDQUFDO0FBQ0QsV0FBTyxHQUFHLElBQUksU0FBUyxlQUFlLEdBQUcsbUJBQW1CO0FBQzVELFdBQU8sR0FBRyxJQUFJLFNBQVMsY0FBYyxHQUFHLDBCQUEwQjtBQUNsRSxXQUFPLEdBQUcsSUFBSSxTQUFTLG1CQUFtQixHQUFHLDBCQUEwQjtBQUV2RSxVQUFNLGNBQWMsSUFBSSxRQUFRLGVBQWU7QUFDL0MsVUFBTSxVQUFVLElBQUksUUFBUSxtQkFBbUI7QUFDL0MsVUFBTSxjQUFjLElBQUksUUFBUSxjQUFjO0FBQzlDLFdBQU8sR0FBRyxVQUFVLGFBQWEsMEJBQTBCO0FBQzNELFdBQU8sR0FBRyxjQUFjLFNBQVMseUJBQXlCO0FBQUEsRUFDNUQsQ0FBQztBQUVELEtBQUcsbURBQW1ELE1BQU07QUFDMUQsVUFBTSxNQUFNLHVCQUF1QjtBQUFBLE1BQ2pDLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxJQUNiLENBQUM7QUFDRCxXQUFPLEdBQUcsQ0FBQyxJQUFJLFNBQVMsVUFBVSxHQUFHLGlDQUFpQztBQUN0RSxXQUFPLEdBQUcsSUFBSSxTQUFTLG1CQUFtQixHQUFHLGdDQUFnQztBQUFBLEVBQy9FLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
