import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCompleteSlicePrompt,
  buildPlanSlicePrompt,
  buildReassessRoadmapPrompt,
  buildReplanSlicePrompt,
  buildResearchSlicePrompt
} from "../auto-prompts.js";
function makeSliceContextFixture() {
  const base = mkdtempSync(join(tmpdir(), "gsd-slice-context-"));
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  mkdirSync(join(sliceDir, "tasks"), { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Context Injection",
      "",
      "## Slices",
      "- [ ] **S01: Context-heavy slice** `risk:low`",
      "  Demo: context appears in prompts."
    ].join("\n"),
    "utf-8"
  );
  writeFileSync(join(milestoneDir, "M001-CONTEXT.md"), "# M001 Context\n", "utf-8");
  writeFileSync(
    join(sliceDir, "S01-CONTEXT.md"),
    "# Slice Context\n\nUnique slice context marker: SLICE-CONTEXT-3452\n",
    "utf-8"
  );
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    [
      "# S01: Context-heavy slice",
      "",
      "**Goal:** Test context injection.",
      "**Demo:** Prompt contains the marker.",
      "",
      "## Tasks",
      "- [ ] **T01: Task** `est:10m`"
    ].join("\n"),
    "utf-8"
  );
  return base;
}
describe("slice CONTEXT.md injection into prompt builders (#3452)", () => {
  const builders = [
    ["buildResearchSlicePrompt", (base) => buildResearchSlicePrompt("M001", "Context Injection", "S01", "Context-heavy slice", base)],
    ["buildPlanSlicePrompt", (base) => buildPlanSlicePrompt("M001", "Context Injection", "S01", "Context-heavy slice", base)],
    ["buildCompleteSlicePrompt", (base) => buildCompleteSlicePrompt("M001", "Context Injection", "S01", "Context-heavy slice", base)],
    ["buildReplanSlicePrompt", (base) => buildReplanSlicePrompt("M001", "Context Injection", "S01", "Context-heavy slice", base)],
    ["buildReassessRoadmapPrompt", (base) => buildReassessRoadmapPrompt("M001", "Context Injection", "S01", base)]
  ];
  for (const [name, build] of builders) {
    test(`${name} includes slice discussion context`, async () => {
      const base = makeSliceContextFixture();
      try {
        const prompt = await build(base);
        assert.match(prompt, /Slice Context/);
        assert.match(prompt, /SLICE-CONTEXT-3452/);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zbGljZS1jb250ZXh0LWluamVjdGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdDogUyMjLUNPTlRFWFQubWQgZnJvbSBzbGljZSBkaXNjdXNzaW9uIGlzIGluamVjdGVkIGludG9cbiAqIGRvd25zdHJlYW0gcHJvbXB0IGJ1aWxkZXJzICgjMzQ1MikuXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHtcbiAgYnVpbGRDb21wbGV0ZVNsaWNlUHJvbXB0LFxuICBidWlsZFBsYW5TbGljZVByb21wdCxcbiAgYnVpbGRSZWFzc2Vzc1JvYWRtYXBQcm9tcHQsXG4gIGJ1aWxkUmVwbGFuU2xpY2VQcm9tcHQsXG4gIGJ1aWxkUmVzZWFyY2hTbGljZVByb21wdCxcbn0gZnJvbSBcIi4uL2F1dG8tcHJvbXB0cy50c1wiO1xuXG5mdW5jdGlvbiBtYWtlU2xpY2VDb250ZXh0Rml4dHVyZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtc2xpY2UtY29udGV4dC1cIikpO1xuICBjb25zdCBtaWxlc3RvbmVEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIpO1xuICBjb25zdCBzbGljZURpciA9IGpvaW4obWlsZXN0b25lRGlyLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgbWtkaXJTeW5jKGpvaW4oc2xpY2VEaXIsIFwidGFza3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4obWlsZXN0b25lRGlyLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSxcbiAgICBbXG4gICAgICBcIiMgTTAwMTogQ29udGV4dCBJbmplY3Rpb25cIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgXCItIFsgXSAqKlMwMTogQ29udGV4dC1oZWF2eSBzbGljZSoqIGByaXNrOmxvd2BcIixcbiAgICAgIFwiICBEZW1vOiBjb250ZXh0IGFwcGVhcnMgaW4gcHJvbXB0cy5cIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4obWlsZXN0b25lRGlyLCBcIk0wMDEtQ09OVEVYVC5tZFwiKSwgXCIjIE0wMDEgQ29udGV4dFxcblwiLCBcInV0Zi04XCIpO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oc2xpY2VEaXIsIFwiUzAxLUNPTlRFWFQubWRcIiksXG4gICAgXCIjIFNsaWNlIENvbnRleHRcXG5cXG5VbmlxdWUgc2xpY2UgY29udGV4dCBtYXJrZXI6IFNMSUNFLUNPTlRFWFQtMzQ1MlxcblwiLFxuICAgIFwidXRmLThcIixcbiAgKTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKHNsaWNlRGlyLCBcIlMwMS1QTEFOLm1kXCIpLFxuICAgIFtcbiAgICAgIFwiIyBTMDE6IENvbnRleHQtaGVhdnkgc2xpY2VcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIioqR29hbDoqKiBUZXN0IGNvbnRleHQgaW5qZWN0aW9uLlwiLFxuICAgICAgXCIqKkRlbW86KiogUHJvbXB0IGNvbnRhaW5zIHRoZSBtYXJrZXIuXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCIjIyBUYXNrc1wiLFxuICAgICAgXCItIFsgXSAqKlQwMTogVGFzayoqIGBlc3Q6MTBtYFwiLFxuICAgIF0uam9pbihcIlxcblwiKSxcbiAgICBcInV0Zi04XCIsXG4gICk7XG4gIHJldHVybiBiYXNlO1xufVxuXG5kZXNjcmliZShcInNsaWNlIENPTlRFWFQubWQgaW5qZWN0aW9uIGludG8gcHJvbXB0IGJ1aWxkZXJzICgjMzQ1MilcIiwgKCkgPT4ge1xuICBjb25zdCBidWlsZGVyczogQXJyYXk8W3N0cmluZywgKGJhc2U6IHN0cmluZykgPT4gUHJvbWlzZTxzdHJpbmc+XT4gPSBbXG4gICAgW1wiYnVpbGRSZXNlYXJjaFNsaWNlUHJvbXB0XCIsIChiYXNlKSA9PiBidWlsZFJlc2VhcmNoU2xpY2VQcm9tcHQoXCJNMDAxXCIsIFwiQ29udGV4dCBJbmplY3Rpb25cIiwgXCJTMDFcIiwgXCJDb250ZXh0LWhlYXZ5IHNsaWNlXCIsIGJhc2UpXSxcbiAgICBbXCJidWlsZFBsYW5TbGljZVByb21wdFwiLCAoYmFzZSkgPT4gYnVpbGRQbGFuU2xpY2VQcm9tcHQoXCJNMDAxXCIsIFwiQ29udGV4dCBJbmplY3Rpb25cIiwgXCJTMDFcIiwgXCJDb250ZXh0LWhlYXZ5IHNsaWNlXCIsIGJhc2UpXSxcbiAgICBbXCJidWlsZENvbXBsZXRlU2xpY2VQcm9tcHRcIiwgKGJhc2UpID0+IGJ1aWxkQ29tcGxldGVTbGljZVByb21wdChcIk0wMDFcIiwgXCJDb250ZXh0IEluamVjdGlvblwiLCBcIlMwMVwiLCBcIkNvbnRleHQtaGVhdnkgc2xpY2VcIiwgYmFzZSldLFxuICAgIFtcImJ1aWxkUmVwbGFuU2xpY2VQcm9tcHRcIiwgKGJhc2UpID0+IGJ1aWxkUmVwbGFuU2xpY2VQcm9tcHQoXCJNMDAxXCIsIFwiQ29udGV4dCBJbmplY3Rpb25cIiwgXCJTMDFcIiwgXCJDb250ZXh0LWhlYXZ5IHNsaWNlXCIsIGJhc2UpXSxcbiAgICBbXCJidWlsZFJlYXNzZXNzUm9hZG1hcFByb21wdFwiLCAoYmFzZSkgPT4gYnVpbGRSZWFzc2Vzc1JvYWRtYXBQcm9tcHQoXCJNMDAxXCIsIFwiQ29udGV4dCBJbmplY3Rpb25cIiwgXCJTMDFcIiwgYmFzZSldLFxuICBdO1xuXG4gIGZvciAoY29uc3QgW25hbWUsIGJ1aWxkXSBvZiBidWlsZGVycykge1xuICAgIHRlc3QoYCR7bmFtZX0gaW5jbHVkZXMgc2xpY2UgZGlzY3Vzc2lvbiBjb250ZXh0YCwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmFzZSA9IG1ha2VTbGljZUNvbnRleHRGaXh0dXJlKCk7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBwcm9tcHQgPSBhd2FpdCBidWlsZChiYXNlKTtcbiAgICAgICAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1NsaWNlIENvbnRleHQvKTtcbiAgICAgICAgYXNzZXJ0Lm1hdGNoKHByb21wdCwgL1NMSUNFLUNPTlRFWFQtMzQ1Mi8pO1xuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFLQSxTQUFTLFVBQVUsWUFBWTtBQUMvQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLFdBQVcsUUFBUSxxQkFBcUI7QUFDOUQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQLFNBQVMsMEJBQWtDO0FBQ3pDLFFBQU0sT0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLG9CQUFvQixDQUFDO0FBQzdELFFBQU0sZUFBZSxLQUFLLE1BQU0sUUFBUSxjQUFjLE1BQU07QUFDNUQsUUFBTSxXQUFXLEtBQUssY0FBYyxVQUFVLEtBQUs7QUFDbkQsWUFBVSxLQUFLLFVBQVUsT0FBTyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdEQ7QUFBQSxJQUNFLEtBQUssY0FBYyxpQkFBaUI7QUFBQSxJQUNwQztBQUFBLE1BQ0U7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRixFQUFFLEtBQUssSUFBSTtBQUFBLElBQ1g7QUFBQSxFQUNGO0FBQ0EsZ0JBQWMsS0FBSyxjQUFjLGlCQUFpQixHQUFHLG9CQUFvQixPQUFPO0FBQ2hGO0FBQUEsSUFDRSxLQUFLLFVBQVUsZ0JBQWdCO0FBQUEsSUFDL0I7QUFBQSxJQUNBO0FBQUEsRUFDRjtBQUNBO0FBQUEsSUFDRSxLQUFLLFVBQVUsYUFBYTtBQUFBLElBQzVCO0FBQUEsTUFDRTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0YsRUFBRSxLQUFLLElBQUk7QUFBQSxJQUNYO0FBQUEsRUFDRjtBQUNBLFNBQU87QUFDVDtBQUVBLFNBQVMsMkRBQTJELE1BQU07QUFDeEUsUUFBTSxXQUErRDtBQUFBLElBQ25FLENBQUMsNEJBQTRCLENBQUMsU0FBUyx5QkFBeUIsUUFBUSxxQkFBcUIsT0FBTyx1QkFBdUIsSUFBSSxDQUFDO0FBQUEsSUFDaEksQ0FBQyx3QkFBd0IsQ0FBQyxTQUFTLHFCQUFxQixRQUFRLHFCQUFxQixPQUFPLHVCQUF1QixJQUFJLENBQUM7QUFBQSxJQUN4SCxDQUFDLDRCQUE0QixDQUFDLFNBQVMseUJBQXlCLFFBQVEscUJBQXFCLE9BQU8sdUJBQXVCLElBQUksQ0FBQztBQUFBLElBQ2hJLENBQUMsMEJBQTBCLENBQUMsU0FBUyx1QkFBdUIsUUFBUSxxQkFBcUIsT0FBTyx1QkFBdUIsSUFBSSxDQUFDO0FBQUEsSUFDNUgsQ0FBQyw4QkFBOEIsQ0FBQyxTQUFTLDJCQUEyQixRQUFRLHFCQUFxQixPQUFPLElBQUksQ0FBQztBQUFBLEVBQy9HO0FBRUEsYUFBVyxDQUFDLE1BQU0sS0FBSyxLQUFLLFVBQVU7QUFDcEMsU0FBSyxHQUFHLElBQUksc0NBQXNDLFlBQVk7QUFDNUQsWUFBTSxPQUFPLHdCQUF3QjtBQUNyQyxVQUFJO0FBQ0YsY0FBTSxTQUFTLE1BQU0sTUFBTSxJQUFJO0FBQy9CLGVBQU8sTUFBTSxRQUFRLGVBQWU7QUFDcEMsZUFBTyxNQUFNLFFBQVEsb0JBQW9CO0FBQUEsTUFDM0MsVUFBRTtBQUNBLGVBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLE1BQy9DO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSDtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
