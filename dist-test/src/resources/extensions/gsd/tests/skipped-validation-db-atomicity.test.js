import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DISPATCH_RULES } from "../auto-dispatch.js";
import {
  closeDatabase,
  getLatestAssessmentByScope,
  insertMilestone,
  insertSlice,
  openDatabase
} from "../gsd-db.js";
test("skipped validation dispatch persists the validation file and DB assessment together", async () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-skip-validation-"));
  const milestoneDir = join(basePath, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  const rule = DISPATCH_RULES.find((r) => r.name === "validating-milestone \u2192 validate-milestone");
  assert.ok(rule, "validate-milestone rule is registered");
  try {
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "S01-SUMMARY.md"), "# S01 Summary\n", "utf-8");
    openDatabase(join(basePath, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Validation", status: "active", depends_on: [] });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Done slice",
      status: "complete",
      risk: "low",
      depends: [],
      demo: "",
      sequence: 1
    });
    const action = await rule.match({
      state: { phase: "validating-milestone" },
      mid: "M001",
      midTitle: "Validation",
      basePath,
      prefs: { phases: { skip_milestone_validation: true } }
    });
    assert.deepEqual(action, { action: "skip" });
    assert.equal(existsSync(join(milestoneDir, "M001-VALIDATION.md")), true);
    assert.equal(
      getLatestAssessmentByScope("M001", "milestone-validation")?.status,
      "pass"
    );
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9za2lwcGVkLXZhbGlkYXRpb24tZGItYXRvbWljaXR5LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCBta2R0ZW1wU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBESVNQQVRDSF9SVUxFUyB9IGZyb20gXCIuLi9hdXRvLWRpc3BhdGNoLnRzXCI7XG5pbXBvcnQge1xuICBjbG9zZURhdGFiYXNlLFxuICBnZXRMYXRlc3RBc3Nlc3NtZW50QnlTY29wZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBpbnNlcnRTbGljZSxcbiAgb3BlbkRhdGFiYXNlLFxufSBmcm9tIFwiLi4vZ3NkLWRiLnRzXCI7XG5cbnRlc3QoXCJza2lwcGVkIHZhbGlkYXRpb24gZGlzcGF0Y2ggcGVyc2lzdHMgdGhlIHZhbGlkYXRpb24gZmlsZSBhbmQgREIgYXNzZXNzbWVudCB0b2dldGhlclwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2VQYXRoID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtc2tpcC12YWxpZGF0aW9uLVwiKSk7XG4gIGNvbnN0IG1pbGVzdG9uZURpciA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICBjb25zdCBzbGljZURpciA9IGpvaW4obWlsZXN0b25lRGlyLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgY29uc3QgcnVsZSA9IERJU1BBVENIX1JVTEVTLmZpbmQoKHIpID0+IHIubmFtZSA9PT0gXCJ2YWxpZGF0aW5nLW1pbGVzdG9uZSBcdTIxOTIgdmFsaWRhdGUtbWlsZXN0b25lXCIpO1xuICBhc3NlcnQub2socnVsZSwgXCJ2YWxpZGF0ZS1taWxlc3RvbmUgcnVsZSBpcyByZWdpc3RlcmVkXCIpO1xuXG4gIHRyeSB7XG4gICAgbWtkaXJTeW5jKHNsaWNlRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oc2xpY2VEaXIsIFwiUzAxLVNVTU1BUlkubWRcIiksIFwiIyBTMDEgU3VtbWFyeVxcblwiLCBcInV0Zi04XCIpO1xuICAgIG9wZW5EYXRhYmFzZShqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVmFsaWRhdGlvblwiLCBzdGF0dXM6IFwiYWN0aXZlXCIsIGRlcGVuZHNfb246IFtdIH0pO1xuICAgIGluc2VydFNsaWNlKHtcbiAgICAgIGlkOiBcIlMwMVwiLFxuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgdGl0bGU6IFwiRG9uZSBzbGljZVwiLFxuICAgICAgc3RhdHVzOiBcImNvbXBsZXRlXCIsXG4gICAgICByaXNrOiBcImxvd1wiLFxuICAgICAgZGVwZW5kczogW10sXG4gICAgICBkZW1vOiBcIlwiLFxuICAgICAgc2VxdWVuY2U6IDEsXG4gICAgfSk7XG5cbiAgICBjb25zdCBhY3Rpb24gPSBhd2FpdCBydWxlLm1hdGNoKHtcbiAgICAgIHN0YXRlOiB7IHBoYXNlOiBcInZhbGlkYXRpbmctbWlsZXN0b25lXCIgfSxcbiAgICAgIG1pZDogXCJNMDAxXCIsXG4gICAgICBtaWRUaXRsZTogXCJWYWxpZGF0aW9uXCIsXG4gICAgICBiYXNlUGF0aCxcbiAgICAgIHByZWZzOiB7IHBoYXNlczogeyBza2lwX21pbGVzdG9uZV92YWxpZGF0aW9uOiB0cnVlIH0gfSxcbiAgICB9IGFzIGFueSk7XG5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKGFjdGlvbiwgeyBhY3Rpb246IFwic2tpcFwiIH0pO1xuICAgIGFzc2VydC5lcXVhbChleGlzdHNTeW5jKGpvaW4obWlsZXN0b25lRGlyLCBcIk0wMDEtVkFMSURBVElPTi5tZFwiKSksIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIGdldExhdGVzdEFzc2Vzc21lbnRCeVNjb3BlKFwiTTAwMVwiLCBcIm1pbGVzdG9uZS12YWxpZGF0aW9uXCIpPy5zdGF0dXMsXG4gICAgICBcInBhc3NcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBybVN5bmMoYmFzZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsWUFBWSxXQUFXLGFBQWEsUUFBUSxxQkFBcUI7QUFDMUUsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLHNCQUFzQjtBQUMvQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQLEtBQUssdUZBQXVGLFlBQVk7QUFDdEcsUUFBTSxXQUFXLFlBQVksS0FBSyxPQUFPLEdBQUcsc0JBQXNCLENBQUM7QUFDbkUsUUFBTSxlQUFlLEtBQUssVUFBVSxRQUFRLGNBQWMsTUFBTTtBQUNoRSxRQUFNLFdBQVcsS0FBSyxjQUFjLFVBQVUsS0FBSztBQUNuRCxRQUFNLE9BQU8sZUFBZSxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsZ0RBQTJDO0FBQzlGLFNBQU8sR0FBRyxNQUFNLHVDQUF1QztBQUV2RCxNQUFJO0FBQ0YsY0FBVSxVQUFVLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkMsa0JBQWMsS0FBSyxVQUFVLGdCQUFnQixHQUFHLG1CQUFtQixPQUFPO0FBQzFFLGlCQUFhLEtBQUssVUFBVSxRQUFRLFFBQVEsQ0FBQztBQUM3QyxvQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxjQUFjLFFBQVEsVUFBVSxZQUFZLENBQUMsRUFBRSxDQUFDO0FBQ3JGLGdCQUFZO0FBQUEsTUFDVixJQUFJO0FBQUEsTUFDSixhQUFhO0FBQUEsTUFDYixPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixNQUFNO0FBQUEsTUFDTixTQUFTLENBQUM7QUFBQSxNQUNWLE1BQU07QUFBQSxNQUNOLFVBQVU7QUFBQSxJQUNaLENBQUM7QUFFRCxVQUFNLFNBQVMsTUFBTSxLQUFLLE1BQU07QUFBQSxNQUM5QixPQUFPLEVBQUUsT0FBTyx1QkFBdUI7QUFBQSxNQUN2QyxLQUFLO0FBQUEsTUFDTCxVQUFVO0FBQUEsTUFDVjtBQUFBLE1BQ0EsT0FBTyxFQUFFLFFBQVEsRUFBRSwyQkFBMkIsS0FBSyxFQUFFO0FBQUEsSUFDdkQsQ0FBUTtBQUVSLFdBQU8sVUFBVSxRQUFRLEVBQUUsUUFBUSxPQUFPLENBQUM7QUFDM0MsV0FBTyxNQUFNLFdBQVcsS0FBSyxjQUFjLG9CQUFvQixDQUFDLEdBQUcsSUFBSTtBQUN2RSxXQUFPO0FBQUEsTUFDTCwyQkFBMkIsUUFBUSxzQkFBc0IsR0FBRztBQUFBLE1BQzVEO0FBQUEsSUFDRjtBQUFBLEVBQ0YsVUFBRTtBQUNBLGtCQUFjO0FBQ2QsV0FBTyxVQUFVLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDbkQ7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
