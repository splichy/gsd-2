import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyExpectedArtifact } from "../auto-recovery.js";
function createFixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-plan-milestone-artifact-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}
function writeRoadmap(base, milestoneId, content) {
  const milestoneDir = join(base, ".gsd", "milestones", milestoneId);
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, `${milestoneId}-ROADMAP.md`), content, "utf-8");
}
function writeLegacyRoadmap(base, milestoneId, content) {
  const milestoneDir = join(base, ".gsd", "milestones", milestoneId);
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "ROADMAP.md"), content, "utf-8");
}
test("#3405: plan-milestone roadmap stub does not count as a verified artifact", () => {
  const base = createFixtureBase();
  try {
    writeRoadmap(base, "M001", [
      "# M001: Placeholder",
      "",
      "**Vision:** Stub only.",
      "",
      "## Slices",
      "",
      "_TBD_",
      ""
    ].join("\n"));
    const result = verifyExpectedArtifact("plan-milestone", "M001", base);
    assert.equal(result, false, "zero-slice roadmap stubs must fail verification");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("#3405: plan-milestone roadmap with real slices still passes artifact verification", () => {
  const base = createFixtureBase();
  try {
    writeRoadmap(base, "M001", [
      "# M001: Real roadmap",
      "",
      "**Vision:** Real work.",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First slice** `risk:low` `depends:[]`",
      "  > After this: a real slice exists.",
      ""
    ].join("\n"));
    const result = verifyExpectedArtifact("plan-milestone", "M001", base);
    assert.equal(result, true, "real roadmap slices should keep passing verification");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("plan-milestone verification accepts legacy ROADMAP.md via shared resolver", () => {
  const base = createFixtureBase();
  try {
    writeLegacyRoadmap(base, "M001", [
      "# M001: Legacy roadmap",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First slice** `risk:low` `depends:[]`",
      "  > After this: a real slice exists.",
      ""
    ].join("\n"));
    const result = verifyExpectedArtifact("plan-milestone", "M001", base);
    assert.equal(result, true, "legacy unprefixed ROADMAP.md should resolve");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test("discuss-milestone verification accepts legacy CONTEXT.md via shared resolver", () => {
  const base = createFixtureBase();
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    writeFileSync(join(milestoneDir, "CONTEXT.md"), "# M001 Context\n", "utf-8");
    const result = verifyExpectedArtifact("discuss-milestone", "M001", base);
    assert.equal(result, true, "legacy unprefixed CONTEXT.md should resolve");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wbGFuLW1pbGVzdG9uZS1hcnRpZmFjdC12ZXJpZmljYXRpb24udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IH0gZnJvbSBcIi4uL2F1dG8tcmVjb3ZlcnkudHNcIjtcblxuZnVuY3Rpb24gY3JlYXRlRml4dHVyZUJhc2UoKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLXBsYW4tbWlsZXN0b25lLWFydGlmYWN0LVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gd3JpdGVSb2FkbWFwKGJhc2U6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IG1pbGVzdG9uZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBtaWxlc3RvbmVJZCk7XG4gIG1rZGlyU3luYyhtaWxlc3RvbmVEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4obWlsZXN0b25lRGlyLCBgJHttaWxlc3RvbmVJZH0tUk9BRE1BUC5tZGApLCBjb250ZW50LCBcInV0Zi04XCIpO1xufVxuXG5mdW5jdGlvbiB3cml0ZUxlZ2FjeVJvYWRtYXAoYmFzZTogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbWlsZXN0b25lRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pbGVzdG9uZUlkKTtcbiAgbWtkaXJTeW5jKG1pbGVzdG9uZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihtaWxlc3RvbmVEaXIsIFwiUk9BRE1BUC5tZFwiKSwgY29udGVudCwgXCJ1dGYtOFwiKTtcbn1cblxudGVzdChcIiMzNDA1OiBwbGFuLW1pbGVzdG9uZSByb2FkbWFwIHN0dWIgZG9lcyBub3QgY291bnQgYXMgYSB2ZXJpZmllZCBhcnRpZmFjdFwiLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlQmFzZSgpO1xuICB0cnkge1xuICAgIHdyaXRlUm9hZG1hcChiYXNlLCBcIk0wMDFcIiwgW1xuICAgICAgXCIjIE0wMDE6IFBsYWNlaG9sZGVyXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIqKlZpc2lvbjoqKiBTdHViIG9ubHkuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBTbGljZXNcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIl9UQkRfXCIsXG4gICAgICBcIlwiLFxuICAgIF0uam9pbihcIlxcblwiKSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwicGxhbi1taWxlc3RvbmVcIiwgXCJNMDAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIGZhbHNlLCBcInplcm8tc2xpY2Ugcm9hZG1hcCBzdHVicyBtdXN0IGZhaWwgdmVyaWZpY2F0aW9uXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiIzM0MDU6IHBsYW4tbWlsZXN0b25lIHJvYWRtYXAgd2l0aCByZWFsIHNsaWNlcyBzdGlsbCBwYXNzZXMgYXJ0aWZhY3QgdmVyaWZpY2F0aW9uXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBbXG4gICAgICBcIiMgTTAwMTogUmVhbCByb2FkbWFwXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIqKlZpc2lvbjoqKiBSZWFsIHdvcmsuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBTbGljZXNcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIi0gWyBdICoqUzAxOiBGaXJzdCBzbGljZSoqIGByaXNrOmxvd2AgYGRlcGVuZHM6W11gXCIsXG4gICAgICBcIiAgPiBBZnRlciB0aGlzOiBhIHJlYWwgc2xpY2UgZXhpc3RzLlwiLFxuICAgICAgXCJcIixcbiAgICBdLmpvaW4oXCJcXG5cIikpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdChcInBsYW4tbWlsZXN0b25lXCIsIFwiTTAwMVwiLCBiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCB0cnVlLCBcInJlYWwgcm9hZG1hcCBzbGljZXMgc2hvdWxkIGtlZXAgcGFzc2luZyB2ZXJpZmljYXRpb25cIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJwbGFuLW1pbGVzdG9uZSB2ZXJpZmljYXRpb24gYWNjZXB0cyBsZWdhY3kgUk9BRE1BUC5tZCB2aWEgc2hhcmVkIHJlc29sdmVyXCIsICgpID0+IHtcbiAgY29uc3QgYmFzZSA9IGNyZWF0ZUZpeHR1cmVCYXNlKCk7XG4gIHRyeSB7XG4gICAgd3JpdGVMZWdhY3lSb2FkbWFwKGJhc2UsIFwiTTAwMVwiLCBbXG4gICAgICBcIiMgTTAwMTogTGVnYWN5IHJvYWRtYXBcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbIF0gKipTMDE6IEZpcnN0IHNsaWNlKiogYHJpc2s6bG93YCBgZGVwZW5kczpbXWBcIixcbiAgICAgIFwiICA+IEFmdGVyIHRoaXM6IGEgcmVhbCBzbGljZSBleGlzdHMuXCIsXG4gICAgICBcIlwiLFxuICAgIF0uam9pbihcIlxcblwiKSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFwicGxhbi1taWxlc3RvbmVcIiwgXCJNMDAxXCIsIGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQsIHRydWUsIFwibGVnYWN5IHVucHJlZml4ZWQgUk9BRE1BUC5tZCBzaG91bGQgcmVzb2x2ZVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcImRpc2N1c3MtbWlsZXN0b25lIHZlcmlmaWNhdGlvbiBhY2NlcHRzIGxlZ2FjeSBDT05URVhULm1kIHZpYSBzaGFyZWQgcmVzb2x2ZXJcIiwgKCkgPT4ge1xuICBjb25zdCBiYXNlID0gY3JlYXRlRml4dHVyZUJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBtaWxlc3RvbmVEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICAgIG1rZGlyU3luYyhtaWxlc3RvbmVEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihtaWxlc3RvbmVEaXIsIFwiQ09OVEVYVC5tZFwiKSwgXCIjIE0wMDEgQ29udGV4dFxcblwiLCBcInV0Zi04XCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdChcImRpc2N1c3MtbWlsZXN0b25lXCIsIFwiTTAwMVwiLCBiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LCB0cnVlLCBcImxlZ2FjeSB1bnByZWZpeGVkIENPTlRFWFQubWQgc2hvdWxkIHJlc29sdmVcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFlBQVk7QUFDckIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyw4QkFBOEI7QUFFdkMsU0FBUyxvQkFBNEI7QUFDbkMsUUFBTSxPQUFPLFlBQVksS0FBSyxPQUFPLEdBQUcsOEJBQThCLENBQUM7QUFDdkUsWUFBVSxLQUFLLE1BQU0sUUFBUSxZQUFZLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUMvRCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGFBQWEsTUFBYyxhQUFxQixTQUF1QjtBQUM5RSxRQUFNLGVBQWUsS0FBSyxNQUFNLFFBQVEsY0FBYyxXQUFXO0FBQ2pFLFlBQVUsY0FBYyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQzNDLGdCQUFjLEtBQUssY0FBYyxHQUFHLFdBQVcsYUFBYSxHQUFHLFNBQVMsT0FBTztBQUNqRjtBQUVBLFNBQVMsbUJBQW1CLE1BQWMsYUFBcUIsU0FBdUI7QUFDcEYsUUFBTSxlQUFlLEtBQUssTUFBTSxRQUFRLGNBQWMsV0FBVztBQUNqRSxZQUFVLGNBQWMsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUMzQyxnQkFBYyxLQUFLLGNBQWMsWUFBWSxHQUFHLFNBQVMsT0FBTztBQUNsRTtBQUVBLEtBQUssNEVBQTRFLE1BQU07QUFDckYsUUFBTSxPQUFPLGtCQUFrQjtBQUMvQixNQUFJO0FBQ0YsaUJBQWEsTUFBTSxRQUFRO0FBQUEsTUFDekI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRixFQUFFLEtBQUssSUFBSSxDQUFDO0FBRVosVUFBTSxTQUFTLHVCQUF1QixrQkFBa0IsUUFBUSxJQUFJO0FBQ3BFLFdBQU8sTUFBTSxRQUFRLE9BQU8saURBQWlEO0FBQUEsRUFDL0UsVUFBRTtBQUNBLFdBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQy9DO0FBQ0YsQ0FBQztBQUVELEtBQUsscUZBQXFGLE1BQU07QUFDOUYsUUFBTSxPQUFPLGtCQUFrQjtBQUMvQixNQUFJO0FBQ0YsaUJBQWEsTUFBTSxRQUFRO0FBQUEsTUFDekI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0YsRUFBRSxLQUFLLElBQUksQ0FBQztBQUVaLFVBQU0sU0FBUyx1QkFBdUIsa0JBQWtCLFFBQVEsSUFBSTtBQUNwRSxXQUFPLE1BQU0sUUFBUSxNQUFNLHNEQUFzRDtBQUFBLEVBQ25GLFVBQUU7QUFDQSxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvQztBQUNGLENBQUM7QUFFRCxLQUFLLDZFQUE2RSxNQUFNO0FBQ3RGLFFBQU0sT0FBTyxrQkFBa0I7QUFDL0IsTUFBSTtBQUNGLHVCQUFtQixNQUFNLFFBQVE7QUFBQSxNQUMvQjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0YsRUFBRSxLQUFLLElBQUksQ0FBQztBQUVaLFVBQU0sU0FBUyx1QkFBdUIsa0JBQWtCLFFBQVEsSUFBSTtBQUNwRSxXQUFPLE1BQU0sUUFBUSxNQUFNLDZDQUE2QztBQUFBLEVBQzFFLFVBQUU7QUFDQSxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvQztBQUNGLENBQUM7QUFFRCxLQUFLLGdGQUFnRixNQUFNO0FBQ3pGLFFBQU0sT0FBTyxrQkFBa0I7QUFDL0IsTUFBSTtBQUNGLFVBQU0sZUFBZSxLQUFLLE1BQU0sUUFBUSxjQUFjLE1BQU07QUFDNUQsY0FBVSxjQUFjLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDM0Msa0JBQWMsS0FBSyxjQUFjLFlBQVksR0FBRyxvQkFBb0IsT0FBTztBQUUzRSxVQUFNLFNBQVMsdUJBQXVCLHFCQUFxQixRQUFRLElBQUk7QUFDdkUsV0FBTyxNQUFNLFFBQVEsTUFBTSw2Q0FBNkM7QUFBQSxFQUMxRSxVQUFFO0FBQ0EsV0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDL0M7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
