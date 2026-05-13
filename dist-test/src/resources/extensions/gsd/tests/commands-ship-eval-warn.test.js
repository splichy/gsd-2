import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { checkSliceEvalReview } from "../commands-ship.js";
import { _clearGsdRootCache, resolveSliceFile } from "../paths.js";
describe("checkSliceEvalReview", () => {
  let basePath;
  let sliceDir;
  beforeEach(() => {
    basePath = join(tmpdir(), `gsd-ship-eval-${randomUUID()}`);
    sliceDir = join(basePath, ".gsd", "milestones", "M001", "slices", "S07");
    mkdirSync(sliceDir, { recursive: true });
  });
  afterEach(() => {
    _clearGsdRootCache();
    rmSync(basePath, { recursive: true, force: true });
  });
  function writeEvalReview(filename, content) {
    const path = join(sliceDir, filename);
    writeFileSync(path, content, "utf-8");
    return path;
  }
  function happyFrontmatter(overrides = {}) {
    const fields = {
      schema: "eval-review/v1",
      verdict: "PRODUCTION_READY",
      coverage_score: "85",
      infrastructure_score: "80",
      overall_score: "83",
      generated: "2026-04-28T14:00:00Z",
      slice: "S07",
      milestone: "M001",
      ...overrides
    };
    const lines = ["---"];
    for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
    lines.push("gaps: []");
    lines.push("counts:");
    lines.push("  blocker: 0");
    lines.push("  major: 0");
    lines.push("  minor: 0");
    lines.push("---");
    lines.push("");
    lines.push("# Body \u2014 never parsed");
    return lines.join("\n");
  }
  it("returns absent when EVAL-REVIEW.md is missing", async () => {
    const result = await checkSliceEvalReview(basePath, "M001", "S07");
    assert.equal(result.kind, "absent");
    assert.equal(result.sliceId, "S07");
  });
  it("returns ok with verdict and overall_score when frontmatter is valid (PRODUCTION_READY path)", async () => {
    writeEvalReview("S07-EVAL-REVIEW.md", happyFrontmatter());
    const result = await checkSliceEvalReview(basePath, "M001", "S07");
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.verdict, "PRODUCTION_READY");
      assert.equal(result.overall_score, 83);
    }
  });
  it("returns ok with NOT_IMPLEMENTED verdict (warning path)", async () => {
    writeEvalReview(
      "S07-EVAL-REVIEW.md",
      happyFrontmatter({
        verdict: "NOT_IMPLEMENTED",
        coverage_score: "10",
        infrastructure_score: "20",
        overall_score: "14"
      })
    );
    const result = await checkSliceEvalReview(basePath, "M001", "S07");
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.verdict, "NOT_IMPLEMENTED");
      assert.equal(result.overall_score, 14);
    }
  });
  it("returns malformed with a JSON-Pointer when verdict is invalid (regression: malformed verdicts must not parse silently)", async () => {
    writeEvalReview("S07-EVAL-REVIEW.md", happyFrontmatter({ verdict: "MOSTLY_OK" }));
    const result = await checkSliceEvalReview(basePath, "M001", "S07");
    assert.equal(result.kind, "malformed");
    if (result.kind === "malformed") {
      assert.ok(result.pointer.includes("verdict"), `pointer should reference verdict, got ${result.pointer}`);
    }
  });
  it("returns malformed when the file has no frontmatter delimiters at all", async () => {
    writeEvalReview("S07-EVAL-REVIEW.md", "# Just a body, no frontmatter");
    const result = await checkSliceEvalReview(basePath, "M001", "S07");
    assert.equal(result.kind, "malformed");
  });
  it("returns malformed when the YAML is syntactically broken inside the frontmatter block", async () => {
    writeEvalReview("S07-EVAL-REVIEW.md", "---\nfoo: : bar\n---\n");
    const result = await checkSliceEvalReview(basePath, "M001", "S07");
    assert.equal(result.kind, "malformed");
  });
  it("treats a TOCTOU race (file deleted after resolution but before read) as absent without throwing (regression: TOCTOU race must surface as absent, not throw)", async () => {
    const path = writeEvalReview("S07-EVAL-REVIEW.md", happyFrontmatter());
    const resolved = resolveSliceFile(basePath, "M001", "S07", "EVAL-REVIEW");
    assert.ok(resolved);
    assert.equal(realpathSync(resolved), realpathSync(path));
    unlinkSync(path);
    const result = await checkSliceEvalReview(basePath, "M001", "S07");
    assert.equal(result.kind, "absent");
  });
  it("does NOT trigger a malformed verdict on bodies with prose, tables, or numbered lists (regression: body is never parsed)", async () => {
    const body = [
      "",
      "## Gap Analysis",
      "1. first numbered item that the previous parser would have grabbed",
      "2. second numbered item",
      "",
      "| dim | sev |",
      "|---|---|",
      "| metrics | major |",
      "",
      "Some prose paragraph describing the audit."
    ].join("\n");
    writeEvalReview("S07-EVAL-REVIEW.md", happyFrontmatter() + body);
    const result = await checkSliceEvalReview(basePath, "M001", "S07");
    assert.equal(result.kind, "ok");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21tYW5kcy1zaGlwLWV2YWwtd2Fybi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFVuaXQgdGVzdHMgZm9yIHRoZSBwcmUtc2hpcCBldmFsLXJldmlldyBzb2Z0LXdhcm5pbmcgaGVscGVyLlxuICpcbiAqIFRoZSBoZWxwZXIgYGNoZWNrU2xpY2VFdmFsUmV2aWV3YCBpcyBhIHB1cmUtZGF0YSBjbGFzc2lmaWVyIGNhbGxlZCBieVxuICogYGhhbmRsZVNoaXBgIGZvciBlYWNoIHNsaWNlIGluIHRoZSBhY3RpdmUgbWlsZXN0b25lLiBJdCBtdXN0OlxuICogICAtIHJldHVybiBgYWJzZW50YCBvbiBtaXNzaW5nIGZpbGUgKG5vIGV4Y2VwdGlvbiwgbm8gdGhyb3cpXG4gKiAgIC0gdG9sZXJhdGUgYSBUT0NUT1UgcmFjZSB3aGVyZSB0aGUgZmlsZSBpcyBkZWxldGVkIGJldHdlZW5cbiAqICAgICByZXNvbHV0aW9uIGFuZCByZWFkIChyZWdyZXNzaW9uOiBwcmlvciBwYXJzZXIgd291bGQgaGF2ZSBjcmFzaGVkIG9uIHRoaXMgcmFjZSlcbiAqICAgLSByZXBvcnQgYG1hbGZvcm1lZGAgb24gc2NoZW1hLWludmFsaWQgZnJvbnRtYXR0ZXIgKG5vIGNyYXNoKVxuICogICAtIHJlcG9ydCBgb2tgIHdpdGggdmVyZGljdCArIG92ZXJhbGxfc2NvcmUgb24gYSB2YWxpZCBmcm9udG1hdHRlclxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCBpdCwgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHJlYWxwYXRoU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jLCB1bmxpbmtTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuXG5pbXBvcnQgeyBjaGVja1NsaWNlRXZhbFJldmlldyB9IGZyb20gXCIuLi9jb21tYW5kcy1zaGlwLmpzXCI7XG5pbXBvcnQgeyBfY2xlYXJHc2RSb290Q2FjaGUsIHJlc29sdmVTbGljZUZpbGUgfSBmcm9tIFwiLi4vcGF0aHMuanNcIjtcblxuZGVzY3JpYmUoXCJjaGVja1NsaWNlRXZhbFJldmlld1wiLCAoKSA9PiB7XG4gIGxldCBiYXNlUGF0aDogc3RyaW5nO1xuICBsZXQgc2xpY2VEaXI6IHN0cmluZztcblxuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICBiYXNlUGF0aCA9IGpvaW4odG1wZGlyKCksIGBnc2Qtc2hpcC1ldmFsLSR7cmFuZG9tVVVJRCgpfWApO1xuICAgIHNsaWNlRGlyID0gam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDdcIik7XG4gICAgbWtkaXJTeW5jKHNsaWNlRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICBfY2xlYXJHc2RSb290Q2FjaGUoKTtcbiAgICBybVN5bmMoYmFzZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgZnVuY3Rpb24gd3JpdGVFdmFsUmV2aWV3KGZpbGVuYW1lOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgcGF0aCA9IGpvaW4oc2xpY2VEaXIsIGZpbGVuYW1lKTtcbiAgICB3cml0ZUZpbGVTeW5jKHBhdGgsIGNvbnRlbnQsIFwidXRmLThcIik7XG4gICAgcmV0dXJuIHBhdGg7XG4gIH1cblxuICBmdW5jdGlvbiBoYXBweUZyb250bWF0dGVyKG92ZXJyaWRlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9KTogc3RyaW5nIHtcbiAgICBjb25zdCBmaWVsZHMgPSB7XG4gICAgICBzY2hlbWE6IFwiZXZhbC1yZXZpZXcvdjFcIixcbiAgICAgIHZlcmRpY3Q6IFwiUFJPRFVDVElPTl9SRUFEWVwiLFxuICAgICAgY292ZXJhZ2Vfc2NvcmU6IFwiODVcIixcbiAgICAgIGluZnJhc3RydWN0dXJlX3Njb3JlOiBcIjgwXCIsXG4gICAgICBvdmVyYWxsX3Njb3JlOiBcIjgzXCIsXG4gICAgICBnZW5lcmF0ZWQ6IFwiMjAyNi0wNC0yOFQxNDowMDowMFpcIixcbiAgICAgIHNsaWNlOiBcIlMwN1wiLFxuICAgICAgbWlsZXN0b25lOiBcIk0wMDFcIixcbiAgICAgIC4uLm92ZXJyaWRlcyxcbiAgICB9O1xuICAgIGNvbnN0IGxpbmVzID0gW1wiLS0tXCJdO1xuICAgIGZvciAoY29uc3QgW2ssIHZdIG9mIE9iamVjdC5lbnRyaWVzKGZpZWxkcykpIGxpbmVzLnB1c2goYCR7a306ICR7dn1gKTtcbiAgICBsaW5lcy5wdXNoKFwiZ2FwczogW11cIik7XG4gICAgbGluZXMucHVzaChcImNvdW50czpcIik7XG4gICAgbGluZXMucHVzaChcIiAgYmxvY2tlcjogMFwiKTtcbiAgICBsaW5lcy5wdXNoKFwiICBtYWpvcjogMFwiKTtcbiAgICBsaW5lcy5wdXNoKFwiICBtaW5vcjogMFwiKTtcbiAgICBsaW5lcy5wdXNoKFwiLS0tXCIpO1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaChcIiMgQm9keSBcdTIwMTQgbmV2ZXIgcGFyc2VkXCIpO1xuICAgIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xuICB9XG5cbiAgaXQoXCJyZXR1cm5zIGFic2VudCB3aGVuIEVWQUwtUkVWSUVXLm1kIGlzIG1pc3NpbmdcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNoZWNrU2xpY2VFdmFsUmV2aWV3KGJhc2VQYXRoLCBcIk0wMDFcIiwgXCJTMDdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcImFic2VudFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnNsaWNlSWQsIFwiUzA3XCIpO1xuICB9KTtcblxuICBpdChcInJldHVybnMgb2sgd2l0aCB2ZXJkaWN0IGFuZCBvdmVyYWxsX3Njb3JlIHdoZW4gZnJvbnRtYXR0ZXIgaXMgdmFsaWQgKFBST0RVQ1RJT05fUkVBRFkgcGF0aClcIiwgYXN5bmMgKCkgPT4ge1xuICAgIHdyaXRlRXZhbFJldmlldyhcIlMwNy1FVkFMLVJFVklFVy5tZFwiLCBoYXBweUZyb250bWF0dGVyKCkpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNoZWNrU2xpY2VFdmFsUmV2aWV3KGJhc2VQYXRoLCBcIk0wMDFcIiwgXCJTMDdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcIm9rXCIpO1xuICAgIGlmIChyZXN1bHQua2luZCA9PT0gXCJva1wiKSB7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnZlcmRpY3QsIFwiUFJPRFVDVElPTl9SRUFEWVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQub3ZlcmFsbF9zY29yZSwgODMpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIG9rIHdpdGggTk9UX0lNUExFTUVOVEVEIHZlcmRpY3QgKHdhcm5pbmcgcGF0aClcIiwgYXN5bmMgKCkgPT4ge1xuICAgIHdyaXRlRXZhbFJldmlldyhcbiAgICAgIFwiUzA3LUVWQUwtUkVWSUVXLm1kXCIsXG4gICAgICBoYXBweUZyb250bWF0dGVyKHtcbiAgICAgICAgdmVyZGljdDogXCJOT1RfSU1QTEVNRU5URURcIixcbiAgICAgICAgY292ZXJhZ2Vfc2NvcmU6IFwiMTBcIixcbiAgICAgICAgaW5mcmFzdHJ1Y3R1cmVfc2NvcmU6IFwiMjBcIixcbiAgICAgICAgb3ZlcmFsbF9zY29yZTogXCIxNFwiLFxuICAgICAgfSksXG4gICAgKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjaGVja1NsaWNlRXZhbFJldmlldyhiYXNlUGF0aCwgXCJNMDAxXCIsIFwiUzA3XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJva1wiKTtcbiAgICBpZiAocmVzdWx0LmtpbmQgPT09IFwib2tcIikge1xuICAgICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC52ZXJkaWN0LCBcIk5PVF9JTVBMRU1FTlRFRFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN1bHQub3ZlcmFsbF9zY29yZSwgMTQpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJyZXR1cm5zIG1hbGZvcm1lZCB3aXRoIGEgSlNPTi1Qb2ludGVyIHdoZW4gdmVyZGljdCBpcyBpbnZhbGlkIChyZWdyZXNzaW9uOiBtYWxmb3JtZWQgdmVyZGljdHMgbXVzdCBub3QgcGFyc2Ugc2lsZW50bHkpXCIsIGFzeW5jICgpID0+IHtcbiAgICB3cml0ZUV2YWxSZXZpZXcoXCJTMDctRVZBTC1SRVZJRVcubWRcIiwgaGFwcHlGcm9udG1hdHRlcih7IHZlcmRpY3Q6IFwiTU9TVExZX09LXCIgfSkpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNoZWNrU2xpY2VFdmFsUmV2aWV3KGJhc2VQYXRoLCBcIk0wMDFcIiwgXCJTMDdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcIm1hbGZvcm1lZFwiKTtcbiAgICBpZiAocmVzdWx0LmtpbmQgPT09IFwibWFsZm9ybWVkXCIpIHtcbiAgICAgIGFzc2VydC5vayhyZXN1bHQucG9pbnRlci5pbmNsdWRlcyhcInZlcmRpY3RcIiksIGBwb2ludGVyIHNob3VsZCByZWZlcmVuY2UgdmVyZGljdCwgZ290ICR7cmVzdWx0LnBvaW50ZXJ9YCk7XG4gICAgfVxuICB9KTtcblxuICBpdChcInJldHVybnMgbWFsZm9ybWVkIHdoZW4gdGhlIGZpbGUgaGFzIG5vIGZyb250bWF0dGVyIGRlbGltaXRlcnMgYXQgYWxsXCIsIGFzeW5jICgpID0+IHtcbiAgICB3cml0ZUV2YWxSZXZpZXcoXCJTMDctRVZBTC1SRVZJRVcubWRcIiwgXCIjIEp1c3QgYSBib2R5LCBubyBmcm9udG1hdHRlclwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjaGVja1NsaWNlRXZhbFJldmlldyhiYXNlUGF0aCwgXCJNMDAxXCIsIFwiUzA3XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJtYWxmb3JtZWRcIik7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBtYWxmb3JtZWQgd2hlbiB0aGUgWUFNTCBpcyBzeW50YWN0aWNhbGx5IGJyb2tlbiBpbnNpZGUgdGhlIGZyb250bWF0dGVyIGJsb2NrXCIsIGFzeW5jICgpID0+IHtcbiAgICB3cml0ZUV2YWxSZXZpZXcoXCJTMDctRVZBTC1SRVZJRVcubWRcIiwgXCItLS1cXG5mb286IDogYmFyXFxuLS0tXFxuXCIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNoZWNrU2xpY2VFdmFsUmV2aWV3KGJhc2VQYXRoLCBcIk0wMDFcIiwgXCJTMDdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcIm1hbGZvcm1lZFwiKTtcbiAgfSk7XG5cbiAgaXQoXCJ0cmVhdHMgYSBUT0NUT1UgcmFjZSAoZmlsZSBkZWxldGVkIGFmdGVyIHJlc29sdXRpb24gYnV0IGJlZm9yZSByZWFkKSBhcyBhYnNlbnQgd2l0aG91dCB0aHJvd2luZyAocmVncmVzc2lvbjogVE9DVE9VIHJhY2UgbXVzdCBzdXJmYWNlIGFzIGFic2VudCwgbm90IHRocm93KVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcGF0aCA9IHdyaXRlRXZhbFJldmlldyhcIlMwNy1FVkFMLVJFVklFVy5tZFwiLCBoYXBweUZyb250bWF0dGVyKCkpO1xuICAgIC8vIFdhcm0gdGhlIGRpcmVjdG9yeS1saXN0aW5nIGNhY2hlIHVzZWQgaW5zaWRlIHJlc29sdmVTbGljZUZpbGUgc28gdGhlXG4gICAgLy8gcmVzb2x2ZXIgc3RpbGwgc2VlcyB0aGUgZmlsZSBieSBuYW1lIG9uIHRoZSBuZXh0IGNhbGwuIFRoZW4gZGVsZXRlIHRoZVxuICAgIC8vIGZpbGUuIFRoZSBzdWJzZXF1ZW50IGNoZWNrU2xpY2VFdmFsUmV2aWV3IGNhbGwgcmVzb2x2ZXMgYSBwYXRoIHRoYXRcbiAgICAvLyBwb2ludHMgdG8gYSBtaXNzaW5nIGZpbGUgXHUyMDE0IGV4YWN0bHkgdGhlIHJhY2UgYSBwcmlvciBleGlzdHNTeW5jICtcbiAgICAvLyByZWFkRmlsZVN5bmMgc2VxdWVuY2UgcGFuaWNrZWQgb24uXG4gICAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBcIk0wMDFcIiwgXCJTMDdcIiwgXCJFVkFMLVJFVklFV1wiKTtcbiAgICBhc3NlcnQub2socmVzb2x2ZWQpO1xuICAgIGFzc2VydC5lcXVhbChyZWFscGF0aFN5bmMocmVzb2x2ZWQpLCByZWFscGF0aFN5bmMocGF0aCkpO1xuICAgIHVubGlua1N5bmMocGF0aCk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2hlY2tTbGljZUV2YWxSZXZpZXcoYmFzZVBhdGgsIFwiTTAwMVwiLCBcIlMwN1wiKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwiYWJzZW50XCIpO1xuICB9KTtcblxuICBpdChcImRvZXMgTk9UIHRyaWdnZXIgYSBtYWxmb3JtZWQgdmVyZGljdCBvbiBib2RpZXMgd2l0aCBwcm9zZSwgdGFibGVzLCBvciBudW1iZXJlZCBsaXN0cyAocmVncmVzc2lvbjogYm9keSBpcyBuZXZlciBwYXJzZWQpXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBib2R5ID0gW1xuICAgICAgXCJcIixcbiAgICAgIFwiIyMgR2FwIEFuYWx5c2lzXCIsXG4gICAgICBcIjEuIGZpcnN0IG51bWJlcmVkIGl0ZW0gdGhhdCB0aGUgcHJldmlvdXMgcGFyc2VyIHdvdWxkIGhhdmUgZ3JhYmJlZFwiLFxuICAgICAgXCIyLiBzZWNvbmQgbnVtYmVyZWQgaXRlbVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwifCBkaW0gfCBzZXYgfFwiLFxuICAgICAgXCJ8LS0tfC0tLXxcIixcbiAgICAgIFwifCBtZXRyaWNzIHwgbWFqb3IgfFwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiU29tZSBwcm9zZSBwYXJhZ3JhcGggZGVzY3JpYmluZyB0aGUgYXVkaXQuXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpO1xuICAgIHdyaXRlRXZhbFJldmlldyhcIlMwNy1FVkFMLVJFVklFVy5tZFwiLCBoYXBweUZyb250bWF0dGVyKCkgKyBib2R5KTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjaGVja1NsaWNlRXZhbFJldmlldyhiYXNlUGF0aCwgXCJNMDAxXCIsIFwiUzA3XCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJva1wiKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVlBLFNBQVMsVUFBVSxJQUFJLFlBQVksaUJBQWlCO0FBQ3BELE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsY0FBYyxRQUFRLGVBQWUsa0JBQWtCO0FBQzNFLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxrQkFBa0I7QUFFM0IsU0FBUyw0QkFBNEI7QUFDckMsU0FBUyxvQkFBb0Isd0JBQXdCO0FBRXJELFNBQVMsd0JBQXdCLE1BQU07QUFDckMsTUFBSTtBQUNKLE1BQUk7QUFFSixhQUFXLE1BQU07QUFDZixlQUFXLEtBQUssT0FBTyxHQUFHLGlCQUFpQixXQUFXLENBQUMsRUFBRTtBQUN6RCxlQUFXLEtBQUssVUFBVSxRQUFRLGNBQWMsUUFBUSxVQUFVLEtBQUs7QUFDdkUsY0FBVSxVQUFVLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFBQSxFQUN6QyxDQUFDO0FBRUQsWUFBVSxNQUFNO0FBQ2QsdUJBQW1CO0FBQ25CLFdBQU8sVUFBVSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ25E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
