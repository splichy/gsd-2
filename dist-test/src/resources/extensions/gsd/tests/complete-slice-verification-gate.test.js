import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask
} from "../gsd-db.js";
import { handleCompleteSlice } from "../tools/complete-slice.js";
function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-blocked-gate-"));
  return path.join(dir, "test.db");
}
function cleanupDb(dbPath) {
  closeDatabase();
  try {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  } catch {
  }
}
function makeProject() {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "gsd-gate-proj-"));
  fs.mkdirSync(path.join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(basePath, ".gsd", "milestones", "M001", "M001-ROADMAP.md"),
    `# M001

## Slices
- [ ] **S01: Test** \`risk:low\` \`depends:[]\`
  - After this: works
`
  );
  return basePath;
}
function makeParams(overrides) {
  return {
    sliceId: "S01",
    milestoneId: "M001",
    sliceTitle: "Test Slice",
    oneLiner: "one liner",
    narrative: "narrative",
    verification: "all green",
    deviations: "None.",
    knownLimitations: "None.",
    followUps: "None.",
    keyFiles: [],
    keyDecisions: [],
    patternsEstablished: [],
    observabilitySurfaces: [],
    provides: [],
    requirementsSurfaced: [],
    drillDownPaths: [],
    affects: [],
    requirementsAdvanced: [],
    requirementsValidated: [],
    requirementsInvalidated: [],
    filesModified: [],
    requires: [],
    uatContent: "UAT body.",
    ...overrides
  };
}
describe("complete-slice verification gate (#3580)", () => {
  let dbPath;
  let basePath;
  beforeEach(() => {
    dbPath = tempDbPath();
    openDatabase(dbPath);
    basePath = makeProject();
    insertMilestone({ id: "M001" });
    insertSlice({ id: "S01", milestoneId: "M001" });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete", title: "T1" });
  });
  afterEach(() => {
    cleanupDb(dbPath);
    try {
      fs.rmSync(basePath, { recursive: true, force: true });
    } catch {
    }
  });
  test('rejects when verification text contains "verification failed"', async () => {
    const result = await handleCompleteSlice(
      makeParams({ verification: "verification failed: the regression came back" }),
      basePath
    );
    assert.ok("error" in result, "expected handler to return an error");
    assert.match(result.error, /blocked|failed|do not complete/i);
  });
  test('rejects when uatContent contains "verification_result: failed"', async () => {
    const result = await handleCompleteSlice(
      makeParams({ uatContent: "## Result\nverification_result: failed\n" }),
      basePath
    );
    assert.ok("error" in result, "expected handler to return an error");
    assert.match(result.error, /blocked|failed|do not complete/i);
  });
  test('rejects when verification declares "status: blocked"', async () => {
    const result = await handleCompleteSlice(
      makeParams({ verification: "status: blocked \u2014 db unavailable" }),
      basePath
    );
    assert.ok("error" in result, "expected handler to return an error");
    assert.match(result.error, /blocked|failed|do not complete/i);
  });
  test('rejects when uatContent says "slice is blocked"', async () => {
    const result = await handleCompleteSlice(
      makeParams({ uatContent: "slice is blocked on upstream" }),
      basePath
    );
    assert.ok("error" in result, "expected handler to return an error");
    assert.match(result.error, /blocked|failed|do not complete/i);
  });
  test('rejects when verification says "cannot complete"', async () => {
    const result = await handleCompleteSlice(
      makeParams({ verification: "cannot complete: requirements unmet" }),
      basePath
    );
    assert.ok("error" in result, "expected handler to return an error");
    assert.match(result.error, /blocked|failed|do not complete/i);
  });
  test("passes the gate when verification + uatContent are clean", async () => {
    const result = await handleCompleteSlice(
      makeParams({ verification: "all 8 sections pass", uatContent: "green across the board" }),
      basePath
    );
    if ("error" in result) {
      assert.doesNotMatch(
        result.error,
        /blocked\/failed state — do not complete/,
        `clean inputs should not be rejected by the BLOCKED_SIGNALS gate, got: ${result.error}`
      );
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21wbGV0ZS1zbGljZS12ZXJpZmljYXRpb24tZ2F0ZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEJlaGF2aW91cmFsIHJlZ3Jlc3Npb24gdGVzdCBmb3IgIzM1ODAgXHUyMDE0IGNvbXBsZXRlLXNsaWNlIHZlcmlmaWNhdGlvbiBnYXRlLlxuICpcbiAqIFRoZSBnYXRlIG11c3QgcmVqZWN0IGNvbXBsZXRpb24gd2hlbiB0aGUgdmVyaWZpY2F0aW9uIG9yIFVBVCBjb250ZW50XG4gKiBpbmRpY2F0ZXMgYSBibG9ja2VkIG9yIGZhaWxlZCBzbGljZS4gRHJpdmVzIHRoZSByZWFsIGhhbmRsZXIgd2l0aFxuICogYmxvY2tlZC1zaWduYWwgZml4dHVyZXMgYW5kIGFzc2VydHMgb24gdGhlIHJldHVybmVkIGVycm9yLiBSZXBsYWNlcyBhblxuICogZWFybGllciB0ZXN0IGZpbGUgdGhhdCBvbmx5IHN0cmluZy1tYXRjaGVkIHRoZSBCTE9DS0VEX1NJR05BTFMgcmVnZXhcbiAqIGxpdGVyYWwgaW4gdGhlIHNvdXJjZSAoUmVmcyAjNDgyNi8jNDgzMSkuXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQgKiBhcyBmcyBmcm9tICdub2RlOmZzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCAqIGFzIG9zIGZyb20gJ25vZGU6b3MnO1xuXG5pbXBvcnQge1xuICBvcGVuRGF0YWJhc2UsXG4gIGNsb3NlRGF0YWJhc2UsXG4gIGluc2VydE1pbGVzdG9uZSxcbiAgaW5zZXJ0U2xpY2UsXG4gIGluc2VydFRhc2ssXG59IGZyb20gJy4uL2dzZC1kYi50cyc7XG5pbXBvcnQgeyBoYW5kbGVDb21wbGV0ZVNsaWNlIH0gZnJvbSAnLi4vdG9vbHMvY29tcGxldGUtc2xpY2UudHMnO1xuaW1wb3J0IHR5cGUgeyBDb21wbGV0ZVNsaWNlUGFyYW1zIH0gZnJvbSAnLi4vdHlwZXMudHMnO1xuXG5mdW5jdGlvbiB0ZW1wRGJQYXRoKCk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IGZzLm1rZHRlbXBTeW5jKHBhdGguam9pbihvcy50bXBkaXIoKSwgJ2dzZC1ibG9ja2VkLWdhdGUtJykpO1xuICByZXR1cm4gcGF0aC5qb2luKGRpciwgJ3Rlc3QuZGInKTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cERiKGRiUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGNsb3NlRGF0YWJhc2UoKTtcbiAgdHJ5IHsgZnMucm1TeW5jKHBhdGguZGlybmFtZShkYlBhdGgpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7IH0gY2F0Y2ggeyAvKiAqLyB9XG59XG5cbmZ1bmN0aW9uIG1ha2VQcm9qZWN0KCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2VQYXRoID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCAnZ3NkLWdhdGUtcHJvai0nKSk7XG4gIGZzLm1rZGlyU3luYyhwYXRoLmpvaW4oYmFzZVBhdGgsICcuZ3NkJywgJ21pbGVzdG9uZXMnLCAnTTAwMScsICdzbGljZXMnLCAnUzAxJywgJ3Rhc2tzJyksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBmcy53cml0ZUZpbGVTeW5jKFxuICAgIHBhdGguam9pbihiYXNlUGF0aCwgJy5nc2QnLCAnbWlsZXN0b25lcycsICdNMDAxJywgJ00wMDEtUk9BRE1BUC5tZCcpLFxuICAgIGAjIE0wMDFcXG5cXG4jIyBTbGljZXNcXG4tIFsgXSAqKlMwMTogVGVzdCoqIFxcYHJpc2s6bG93XFxgIFxcYGRlcGVuZHM6W11cXGBcXG4gIC0gQWZ0ZXIgdGhpczogd29ya3NcXG5gLFxuICApO1xuICByZXR1cm4gYmFzZVBhdGg7XG59XG5cbmZ1bmN0aW9uIG1ha2VQYXJhbXMob3ZlcnJpZGVzOiBQYXJ0aWFsPENvbXBsZXRlU2xpY2VQYXJhbXM+KTogQ29tcGxldGVTbGljZVBhcmFtcyB7XG4gIHJldHVybiB7XG4gICAgc2xpY2VJZDogJ1MwMScsXG4gICAgbWlsZXN0b25lSWQ6ICdNMDAxJyxcbiAgICBzbGljZVRpdGxlOiAnVGVzdCBTbGljZScsXG4gICAgb25lTGluZXI6ICdvbmUgbGluZXInLFxuICAgIG5hcnJhdGl2ZTogJ25hcnJhdGl2ZScsXG4gICAgdmVyaWZpY2F0aW9uOiAnYWxsIGdyZWVuJyxcbiAgICBkZXZpYXRpb25zOiAnTm9uZS4nLFxuICAgIGtub3duTGltaXRhdGlvbnM6ICdOb25lLicsXG4gICAgZm9sbG93VXBzOiAnTm9uZS4nLFxuICAgIGtleUZpbGVzOiBbXSxcbiAgICBrZXlEZWNpc2lvbnM6IFtdLFxuICAgIHBhdHRlcm5zRXN0YWJsaXNoZWQ6IFtdLFxuICAgIG9ic2VydmFiaWxpdHlTdXJmYWNlczogW10sXG4gICAgcHJvdmlkZXM6IFtdLFxuICAgIHJlcXVpcmVtZW50c1N1cmZhY2VkOiBbXSxcbiAgICBkcmlsbERvd25QYXRoczogW10sXG4gICAgYWZmZWN0czogW10sXG4gICAgcmVxdWlyZW1lbnRzQWR2YW5jZWQ6IFtdLFxuICAgIHJlcXVpcmVtZW50c1ZhbGlkYXRlZDogW10sXG4gICAgcmVxdWlyZW1lbnRzSW52YWxpZGF0ZWQ6IFtdLFxuICAgIGZpbGVzTW9kaWZpZWQ6IFtdLFxuICAgIHJlcXVpcmVzOiBbXSxcbiAgICB1YXRDb250ZW50OiAnVUFUIGJvZHkuJyxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG5cbmRlc2NyaWJlKCdjb21wbGV0ZS1zbGljZSB2ZXJpZmljYXRpb24gZ2F0ZSAoIzM1ODApJywgKCkgPT4ge1xuICBsZXQgZGJQYXRoOiBzdHJpbmc7XG4gIGxldCBiYXNlUGF0aDogc3RyaW5nO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIGRiUGF0aCA9IHRlbXBEYlBhdGgoKTtcbiAgICBvcGVuRGF0YWJhc2UoZGJQYXRoKTtcbiAgICBiYXNlUGF0aCA9IG1ha2VQcm9qZWN0KCk7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6ICdNMDAxJyB9KTtcbiAgICBpbnNlcnRTbGljZSh7IGlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJyB9KTtcbiAgICBpbnNlcnRUYXNrKHsgaWQ6ICdUMDEnLCBzbGljZUlkOiAnUzAxJywgbWlsZXN0b25lSWQ6ICdNMDAxJywgc3RhdHVzOiAnY29tcGxldGUnLCB0aXRsZTogJ1QxJyB9KTtcbiAgfSk7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICBjbGVhbnVwRGIoZGJQYXRoKTtcbiAgICB0cnkgeyBmcy5ybVN5bmMoYmFzZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7IC8qICovIH1cbiAgfSk7XG5cbiAgdGVzdCgncmVqZWN0cyB3aGVuIHZlcmlmaWNhdGlvbiB0ZXh0IGNvbnRhaW5zIFwidmVyaWZpY2F0aW9uIGZhaWxlZFwiJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZUNvbXBsZXRlU2xpY2UoXG4gICAgICBtYWtlUGFyYW1zKHsgdmVyaWZpY2F0aW9uOiAndmVyaWZpY2F0aW9uIGZhaWxlZDogdGhlIHJlZ3Jlc3Npb24gY2FtZSBiYWNrJyB9KSxcbiAgICAgIGJhc2VQYXRoLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0LCAnZXhwZWN0ZWQgaGFuZGxlciB0byByZXR1cm4gYW4gZXJyb3InKTtcbiAgICBhc3NlcnQubWF0Y2goKHJlc3VsdCBhcyB7IGVycm9yOiBzdHJpbmcgfSkuZXJyb3IsIC9ibG9ja2VkfGZhaWxlZHxkbyBub3QgY29tcGxldGUvaSk7XG4gIH0pO1xuXG4gIHRlc3QoJ3JlamVjdHMgd2hlbiB1YXRDb250ZW50IGNvbnRhaW5zIFwidmVyaWZpY2F0aW9uX3Jlc3VsdDogZmFpbGVkXCInLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlQ29tcGxldGVTbGljZShcbiAgICAgIG1ha2VQYXJhbXMoeyB1YXRDb250ZW50OiAnIyMgUmVzdWx0XFxudmVyaWZpY2F0aW9uX3Jlc3VsdDogZmFpbGVkXFxuJyB9KSxcbiAgICAgIGJhc2VQYXRoLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0LCAnZXhwZWN0ZWQgaGFuZGxlciB0byByZXR1cm4gYW4gZXJyb3InKTtcbiAgICBhc3NlcnQubWF0Y2goKHJlc3VsdCBhcyB7IGVycm9yOiBzdHJpbmcgfSkuZXJyb3IsIC9ibG9ja2VkfGZhaWxlZHxkbyBub3QgY29tcGxldGUvaSk7XG4gIH0pO1xuXG4gIHRlc3QoJ3JlamVjdHMgd2hlbiB2ZXJpZmljYXRpb24gZGVjbGFyZXMgXCJzdGF0dXM6IGJsb2NrZWRcIicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVDb21wbGV0ZVNsaWNlKFxuICAgICAgbWFrZVBhcmFtcyh7IHZlcmlmaWNhdGlvbjogJ3N0YXR1czogYmxvY2tlZCBcdTIwMTQgZGIgdW5hdmFpbGFibGUnIH0pLFxuICAgICAgYmFzZVBhdGgsXG4gICAgKTtcbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiByZXN1bHQsICdleHBlY3RlZCBoYW5kbGVyIHRvIHJldHVybiBhbiBlcnJvcicpO1xuICAgIGFzc2VydC5tYXRjaCgocmVzdWx0IGFzIHsgZXJyb3I6IHN0cmluZyB9KS5lcnJvciwgL2Jsb2NrZWR8ZmFpbGVkfGRvIG5vdCBjb21wbGV0ZS9pKTtcbiAgfSk7XG5cbiAgdGVzdCgncmVqZWN0cyB3aGVuIHVhdENvbnRlbnQgc2F5cyBcInNsaWNlIGlzIGJsb2NrZWRcIicsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVDb21wbGV0ZVNsaWNlKFxuICAgICAgbWFrZVBhcmFtcyh7IHVhdENvbnRlbnQ6ICdzbGljZSBpcyBibG9ja2VkIG9uIHVwc3RyZWFtJyB9KSxcbiAgICAgIGJhc2VQYXRoLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKCdlcnJvcicgaW4gcmVzdWx0LCAnZXhwZWN0ZWQgaGFuZGxlciB0byByZXR1cm4gYW4gZXJyb3InKTtcbiAgICBhc3NlcnQubWF0Y2goKHJlc3VsdCBhcyB7IGVycm9yOiBzdHJpbmcgfSkuZXJyb3IsIC9ibG9ja2VkfGZhaWxlZHxkbyBub3QgY29tcGxldGUvaSk7XG4gIH0pO1xuXG4gIHRlc3QoJ3JlamVjdHMgd2hlbiB2ZXJpZmljYXRpb24gc2F5cyBcImNhbm5vdCBjb21wbGV0ZVwiJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZUNvbXBsZXRlU2xpY2UoXG4gICAgICBtYWtlUGFyYW1zKHsgdmVyaWZpY2F0aW9uOiAnY2Fubm90IGNvbXBsZXRlOiByZXF1aXJlbWVudHMgdW5tZXQnIH0pLFxuICAgICAgYmFzZVBhdGgsXG4gICAgKTtcbiAgICBhc3NlcnQub2soJ2Vycm9yJyBpbiByZXN1bHQsICdleHBlY3RlZCBoYW5kbGVyIHRvIHJldHVybiBhbiBlcnJvcicpO1xuICAgIGFzc2VydC5tYXRjaCgocmVzdWx0IGFzIHsgZXJyb3I6IHN0cmluZyB9KS5lcnJvciwgL2Jsb2NrZWR8ZmFpbGVkfGRvIG5vdCBjb21wbGV0ZS9pKTtcbiAgfSk7XG5cbiAgdGVzdCgncGFzc2VzIHRoZSBnYXRlIHdoZW4gdmVyaWZpY2F0aW9uICsgdWF0Q29udGVudCBhcmUgY2xlYW4nLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gU2FuaXR5OiB0aGUgZ2F0ZSBpcyBub3Qgb3Zlci1lYWdlci4gQ2xlYW4gaW5wdXRzIHJlYWNoIHRoZSByZXN0IG9mXG4gICAgLy8gdGhlIGhhbmRsZXIuIChUaGlzIGNhbGwgbWF5IHN0aWxsIGZhaWwgZG93bnN0cmVhbSBiZWNhdXNlIHdlIHByb3ZpZGVcbiAgICAvLyBhIHRoaW4gZml4dHVyZTsgdGhlIG9ubHkgZ3VhcmFudGVlIGhlcmUgaXMgdGhhdCB0aGUgZXJyb3IgXHUyMDE0IGlmIGFueSBcdTIwMTRcbiAgICAvLyBpcyBOT1QgdGhlIGJsb2NrZWQtc2lnbmFscyBlcnJvci4pXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlQ29tcGxldGVTbGljZShcbiAgICAgIG1ha2VQYXJhbXMoeyB2ZXJpZmljYXRpb246ICdhbGwgOCBzZWN0aW9ucyBwYXNzJywgdWF0Q29udGVudDogJ2dyZWVuIGFjcm9zcyB0aGUgYm9hcmQnIH0pLFxuICAgICAgYmFzZVBhdGgsXG4gICAgKTtcbiAgICBpZiAoJ2Vycm9yJyBpbiByZXN1bHQpIHtcbiAgICAgIGFzc2VydC5kb2VzTm90TWF0Y2goXG4gICAgICAgIHJlc3VsdC5lcnJvcixcbiAgICAgICAgL2Jsb2NrZWRcXC9mYWlsZWQgc3RhdGUgXHUyMDE0IGRvIG5vdCBjb21wbGV0ZS8sXG4gICAgICAgIGBjbGVhbiBpbnB1dHMgc2hvdWxkIG5vdCBiZSByZWplY3RlZCBieSB0aGUgQkxPQ0tFRF9TSUdOQUxTIGdhdGUsIGdvdDogJHtyZXN1bHQuZXJyb3J9YCxcbiAgICAgICk7XG4gICAgfVxuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBVUEsU0FBUyxVQUFVLE1BQU0sWUFBWSxpQkFBaUI7QUFDdEQsT0FBTyxZQUFZO0FBQ25CLFlBQVksUUFBUTtBQUNwQixZQUFZLFVBQVU7QUFDdEIsWUFBWSxRQUFRO0FBRXBCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUywyQkFBMkI7QUFHcEMsU0FBUyxhQUFxQjtBQUM1QixRQUFNLE1BQU0sR0FBRyxZQUFZLEtBQUssS0FBSyxHQUFHLE9BQU8sR0FBRyxtQkFBbUIsQ0FBQztBQUN0RSxTQUFPLEtBQUssS0FBSyxLQUFLLFNBQVM7QUFDakM7QUFFQSxTQUFTLFVBQVUsUUFBc0I7QUFDdkMs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
