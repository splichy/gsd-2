import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveState } from "../state.js";
function writeCompleteMilestone(base) {
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Complete Milestone",
      "",
      "## Slices",
      "- [x] **S01: Done slice** `risk:low` `depends:[]`",
      "  > Done."
    ].join("\n")
  );
  writeFileSync(join(milestoneDir, "M001-SUMMARY.md"), "# M001 Summary\n\nComplete.");
}
test("deriveState reports the last completed milestone when all milestone slices are done", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-smart-entry-complete-"));
  try {
    writeCompleteMilestone(base);
    const state = await deriveState(base);
    assert.equal(state.phase, "complete");
    assert.equal(state.lastCompletedMilestone?.id, "M001");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zbWFydC1lbnRyeS1jb21wbGV0ZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QtMiBcdTIwMTQgR3VpZGVkIHNtYXJ0IGVudHJ5IGNvbXBsZXRlLXN0YXRlIGJlaGF2aW9yIHRlc3RzLlxuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgZGVyaXZlU3RhdGUgfSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcblxuZnVuY3Rpb24gd3JpdGVDb21wbGV0ZU1pbGVzdG9uZShiYXNlOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbWlsZXN0b25lRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKTtcbiAgbWtkaXJTeW5jKG1pbGVzdG9uZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihtaWxlc3RvbmVEaXIsIFwiTTAwMS1ST0FETUFQLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiIyBNMDAxOiBDb21wbGV0ZSBNaWxlc3RvbmVcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgXCItIFt4XSAqKlMwMTogRG9uZSBzbGljZSoqIGByaXNrOmxvd2AgYGRlcGVuZHM6W11gXCIsXG4gICAgICBcIiAgPiBEb25lLlwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKG1pbGVzdG9uZURpciwgXCJNMDAxLVNVTU1BUlkubWRcIiksIFwiIyBNMDAxIFN1bW1hcnlcXG5cXG5Db21wbGV0ZS5cIik7XG59XG5cbnRlc3QoXCJkZXJpdmVTdGF0ZSByZXBvcnRzIHRoZSBsYXN0IGNvbXBsZXRlZCBtaWxlc3RvbmUgd2hlbiBhbGwgbWlsZXN0b25lIHNsaWNlcyBhcmUgZG9uZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1zbWFydC1lbnRyeS1jb21wbGV0ZS1cIikpO1xuICB0cnkge1xuICAgIHdyaXRlQ29tcGxldGVNaWxlc3RvbmUoYmFzZSk7XG4gICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoc3RhdGUucGhhc2UsIFwiY29tcGxldGVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHN0YXRlLmxhc3RDb21wbGV0ZWRNaWxlc3RvbmU/LmlkLCBcIk0wMDFcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyxtQkFBbUI7QUFFNUIsU0FBUyx1QkFBdUIsTUFBb0I7QUFDbEQsUUFBTSxlQUFlLEtBQUssTUFBTSxRQUFRLGNBQWMsTUFBTTtBQUM1RCxZQUFVLGNBQWMsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUMzQztBQUFBLElBQ0UsS0FBSyxjQUFjLGlCQUFpQjtBQUFBLElBQ3BDO0FBQUEsTUFDRTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGLEVBQUUsS0FBSyxJQUFJO0FBQUEsRUFDYjtBQUNBLGdCQUFjLEtBQUssY0FBYyxpQkFBaUIsR0FBRyw2QkFBNkI7QUFDcEY7QUFFQSxLQUFLLHVGQUF1RixZQUFZO0FBQ3RHLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLDJCQUEyQixDQUFDO0FBQ3BFLE1BQUk7QUFDRiwyQkFBdUIsSUFBSTtBQUMzQixVQUFNLFFBQVEsTUFBTSxZQUFZLElBQUk7QUFDcEMsV0FBTyxNQUFNLE1BQU0sT0FBTyxVQUFVO0FBQ3BDLFdBQU8sTUFBTSxNQUFNLHdCQUF3QixJQUFJLE1BQU07QUFBQSxFQUN2RCxVQUFFO0FBQ0EsV0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDL0M7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
