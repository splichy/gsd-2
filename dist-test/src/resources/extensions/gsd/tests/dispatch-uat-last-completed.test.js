import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dispatchDirectPhase } from "../auto-direct-dispatch.js";
import { invalidateStateCache } from "../state.js";
function createFixture() {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatch-uat-"));
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-CONTEXT.md"),
    "# M001: Test Milestone\n\nContext.\n"
  );
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test Milestone",
      "",
      "## Slices",
      "",
      "- [x] **S01: Completed slice** `risk:low` `depends:[]`",
      "- [ ] **S02: Active slice** `risk:low` `depends:[S01]`",
      ""
    ].join("\n")
  );
  const s01Dir = join(milestoneDir, "slices", "S01");
  mkdirSync(s01Dir, { recursive: true });
  writeFileSync(
    join(s01Dir, "S01-UAT.md"),
    "# UAT\n\n## UAT Type\n\n- UAT mode: artifact-driven\n\n## Scenarios\n\n- Check output\n"
  );
  writeFileSync(
    join(s01Dir, "S01-PLAN.md"),
    "# S01 Plan\n\n## Tasks\n\n- [x] **T01: Task one** `effort:low`\n"
  );
  const t01Dir = join(s01Dir, "tasks", "T01");
  mkdirSync(t01Dir, { recursive: true });
  writeFileSync(join(t01Dir, "T01-PLAN.md"), "# T01 Plan\n\nDo the thing.\n");
  const s02Dir = join(milestoneDir, "slices", "S02");
  mkdirSync(s02Dir, { recursive: true });
  writeFileSync(
    join(s02Dir, "S02-PLAN.md"),
    "# S02 Plan\n\n## Tasks\n\n- [ ] **T01: Task one** `effort:low`\n"
  );
  const s02t01Dir = join(s02Dir, "tasks", "T01");
  mkdirSync(s02t01Dir, { recursive: true });
  writeFileSync(join(s02t01Dir, "T01-PLAN.md"), "# T01 Plan\n\nDo the thing.\n");
  return base;
}
test("dispatch uat targets last completed slice, not activeSlice (#1693)", async (t) => {
  const base = createFixture();
  invalidateStateCache();
  const notifications = [];
  let sentPrompt;
  const ctx = {
    ui: {
      notify: (message, level) => {
        notifications.push({ message, level });
      }
    },
    newSession: async () => ({ cancelled: false })
  };
  const pi = {
    sendMessage: (msg, _opts) => {
      sentPrompt = msg.content;
    }
  };
  t.after(() => rmSync(base, { recursive: true, force: true }));
  await dispatchDirectPhase(ctx, pi, "uat", base);
  assert.ok(sentPrompt, "sendMessage should have been called with a prompt");
  const dispatchNotification = notifications.find((n) => n.message.startsWith("Dispatching"));
  assert.ok(dispatchNotification, "dispatch notification should be present");
  assert.match(
    dispatchNotification.message,
    /M001\/S01/,
    "dispatch should target completed slice S01, not active slice S02"
  );
  assert.doesNotMatch(
    dispatchNotification.message,
    /M001\/S02/,
    "dispatch should NOT target active (next incomplete) slice S02"
  );
});
test("dispatch uat warns when no completed slices exist", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatch-uat-none-"));
  invalidateStateCache();
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-CONTEXT.md"),
    "# M001: Test Milestone\n\nContext.\n"
  );
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First** `risk:low` `depends:[]`",
      ""
    ].join("\n")
  );
  const s01Dir = join(milestoneDir, "slices", "S01");
  mkdirSync(s01Dir, { recursive: true });
  writeFileSync(
    join(s01Dir, "S01-PLAN.md"),
    "# S01 Plan\n\n## Tasks\n\n- [ ] **T01: Task** `effort:low`\n"
  );
  const t01Dir = join(s01Dir, "tasks", "T01");
  mkdirSync(t01Dir, { recursive: true });
  writeFileSync(join(t01Dir, "T01-PLAN.md"), "# T01 Plan\n");
  const notifications = [];
  const ctx = {
    ui: {
      notify: (message, level) => {
        notifications.push({ message, level });
      }
    },
    newSession: async () => ({ cancelled: false })
  };
  const pi = {
    sendMessage: () => {
      assert.fail("sendMessage should not be called when no completed slices");
    }
  };
  t.after(() => rmSync(base, { recursive: true, force: true }));
  await dispatchDirectPhase(ctx, pi, "uat", base);
  const warning = notifications.find((n) => n.level === "warning");
  assert.ok(warning, "should show a warning notification");
  assert.match(warning.message, /no completed slices/, "warning should mention no completed slices");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kaXNwYXRjaC11YXQtbGFzdC1jb21wbGV0ZWQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUmVncmVzc2lvbiB0ZXN0IGZvciAjMTY5MyBcdTIwMTQgL2dzZCBkaXNwYXRjaCB1YXQgdGFyZ2V0cyB0aGUgbGFzdCBjb21wbGV0ZWRcbi8vIHNsaWNlIGZyb20gdGhlIHJvYWRtYXAgaW5zdGVhZCBvZiBzdGF0ZS5hY3RpdmVTbGljZSAod2hpY2ggaGFzIGFscmVhZHlcbi8vIGFkdmFuY2VkIHRvIHRoZSBuZXh0IGluY29tcGxldGUgc2xpY2UpLlxuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgZGlzcGF0Y2hEaXJlY3RQaGFzZSB9IGZyb20gXCIuLi9hdXRvLWRpcmVjdC1kaXNwYXRjaC50c1wiO1xuaW1wb3J0IHsgaW52YWxpZGF0ZVN0YXRlQ2FjaGUgfSBmcm9tIFwiLi4vc3RhdGUudHNcIjtcblxuZnVuY3Rpb24gY3JlYXRlRml4dHVyZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZGlzcGF0Y2gtdWF0LVwiKSk7XG5cbiAgLy8gTWlsZXN0b25lIE0wMDEgd2l0aCB0d28gc2xpY2VzOiBTMDEgZG9uZSwgUzAyIGluY29tcGxldGVcbiAgY29uc3QgbWlsZXN0b25lRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKTtcbiAgbWtkaXJTeW5jKG1pbGVzdG9uZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKG1pbGVzdG9uZURpciwgXCJNMDAxLUNPTlRFWFQubWRcIiksXG4gICAgXCIjIE0wMDE6IFRlc3QgTWlsZXN0b25lXFxuXFxuQ29udGV4dC5cXG5cIixcbiAgKTtcblxuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4obWlsZXN0b25lRGlyLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSxcbiAgICBbXG4gICAgICBcIiMgTTAwMTogVGVzdCBNaWxlc3RvbmVcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgXCJcIixcbiAgICAgIFwiLSBbeF0gKipTMDE6IENvbXBsZXRlZCBzbGljZSoqIGByaXNrOmxvd2AgYGRlcGVuZHM6W11gXCIsXG4gICAgICBcIi0gWyBdICoqUzAyOiBBY3RpdmUgc2xpY2UqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltTMDFdYFwiLFxuICAgICAgXCJcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICk7XG5cbiAgLy8gUzAxIGhhcyBhIFVBVCBmaWxlICh0aGlzIGlzIHRoZSBvbmUgZGlzcGF0Y2ggc2hvdWxkIHRhcmdldClcbiAgY29uc3QgczAxRGlyID0gam9pbihtaWxlc3RvbmVEaXIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICBta2RpclN5bmMoczAxRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKHMwMURpciwgXCJTMDEtVUFULm1kXCIpLFxuICAgIFwiIyBVQVRcXG5cXG4jIyBVQVQgVHlwZVxcblxcbi0gVUFUIG1vZGU6IGFydGlmYWN0LWRyaXZlblxcblxcbiMjIFNjZW5hcmlvc1xcblxcbi0gQ2hlY2sgb3V0cHV0XFxuXCIsXG4gICk7XG4gIC8vIFMwMSBuZWVkcyBhIFBMQU4gd2l0aCBjb21wbGV0ZWQgdGFza3Mgc28gZGVyaXZlU3RhdGUgY29uc2lkZXJzIGl0IGRvbmVcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKHMwMURpciwgXCJTMDEtUExBTi5tZFwiKSxcbiAgICBcIiMgUzAxIFBsYW5cXG5cXG4jIyBUYXNrc1xcblxcbi0gW3hdICoqVDAxOiBUYXNrIG9uZSoqIGBlZmZvcnQ6bG93YFxcblwiLFxuICApO1xuICBjb25zdCB0MDFEaXIgPSBqb2luKHMwMURpciwgXCJ0YXNrc1wiLCBcIlQwMVwiKTtcbiAgbWtkaXJTeW5jKHQwMURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbih0MDFEaXIsIFwiVDAxLVBMQU4ubWRcIiksIFwiIyBUMDEgUGxhblxcblxcbkRvIHRoZSB0aGluZy5cXG5cIik7XG5cbiAgLy8gUzAyIGhhcyBhIHBsYW4gYnV0IGluY29tcGxldGUgdGFza3MgXHUyMDE0IHRoaXMgaXMgd2hlcmUgYWN0aXZlU2xpY2UgcG9pbnRzXG4gIGNvbnN0IHMwMkRpciA9IGpvaW4obWlsZXN0b25lRGlyLCBcInNsaWNlc1wiLCBcIlMwMlwiKTtcbiAgbWtkaXJTeW5jKHMwMkRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihzMDJEaXIsIFwiUzAyLVBMQU4ubWRcIiksXG4gICAgXCIjIFMwMiBQbGFuXFxuXFxuIyMgVGFza3NcXG5cXG4tIFsgXSAqKlQwMTogVGFzayBvbmUqKiBgZWZmb3J0Omxvd2BcXG5cIixcbiAgKTtcbiAgY29uc3QgczAydDAxRGlyID0gam9pbihzMDJEaXIsIFwidGFza3NcIiwgXCJUMDFcIik7XG4gIG1rZGlyU3luYyhzMDJ0MDFEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oczAydDAxRGlyLCBcIlQwMS1QTEFOLm1kXCIpLCBcIiMgVDAxIFBsYW5cXG5cXG5EbyB0aGUgdGhpbmcuXFxuXCIpO1xuXG4gIHJldHVybiBiYXNlO1xufVxuXG50ZXN0KFwiZGlzcGF0Y2ggdWF0IHRhcmdldHMgbGFzdCBjb21wbGV0ZWQgc2xpY2UsIG5vdCBhY3RpdmVTbGljZSAoIzE2OTMpXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBjcmVhdGVGaXh0dXJlKCk7XG4gIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG5cbiAgY29uc3Qgbm90aWZpY2F0aW9uczogeyBtZXNzYWdlOiBzdHJpbmc7IGxldmVsOiBzdHJpbmcgfVtdID0gW107XG4gIGxldCBzZW50UHJvbXB0OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cbiAgY29uc3QgY3R4ID0ge1xuICAgIHVpOiB7XG4gICAgICBub3RpZnk6IChtZXNzYWdlOiBzdHJpbmcsIGxldmVsOiBzdHJpbmcpID0+IHtcbiAgICAgICAgbm90aWZpY2F0aW9ucy5wdXNoKHsgbWVzc2FnZSwgbGV2ZWwgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gICAgbmV3U2Vzc2lvbjogYXN5bmMgKCkgPT4gKHsgY2FuY2VsbGVkOiBmYWxzZSB9KSxcbiAgfSBhcyBhbnk7XG5cbiAgY29uc3QgcGkgPSB7XG4gICAgc2VuZE1lc3NhZ2U6IChtc2c6IHsgY29udGVudDogc3RyaW5nIH0sIF9vcHRzOiB1bmtub3duKSA9PiB7XG4gICAgICBzZW50UHJvbXB0ID0gbXNnLmNvbnRlbnQ7XG4gICAgfSxcbiAgfSBhcyBhbnk7XG5cbiAgdC5hZnRlcigoKSA9PiBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBhd2FpdCBkaXNwYXRjaERpcmVjdFBoYXNlKGN0eCwgcGksIFwidWF0XCIsIGJhc2UpO1xuXG4gIC8vIFNob3VsZCBoYXZlIGRpc3BhdGNoZWQgKHNlbmRNZXNzYWdlIGNhbGxlZClcbiAgYXNzZXJ0Lm9rKHNlbnRQcm9tcHQsIFwic2VuZE1lc3NhZ2Ugc2hvdWxkIGhhdmUgYmVlbiBjYWxsZWQgd2l0aCBhIHByb21wdFwiKTtcblxuICAvLyBUaGUgZGlzcGF0Y2ggbm90aWZpY2F0aW9uIHNob3VsZCByZWZlcmVuY2UgTTAwMS9TMDEgKGNvbXBsZXRlZCksIG5vdCBNMDAxL1MwMiAoYWN0aXZlKVxuICBjb25zdCBkaXNwYXRjaE5vdGlmaWNhdGlvbiA9IG5vdGlmaWNhdGlvbnMuZmluZChuID0+IG4ubWVzc2FnZS5zdGFydHNXaXRoKFwiRGlzcGF0Y2hpbmdcIikpO1xuICBhc3NlcnQub2soZGlzcGF0Y2hOb3RpZmljYXRpb24sIFwiZGlzcGF0Y2ggbm90aWZpY2F0aW9uIHNob3VsZCBiZSBwcmVzZW50XCIpO1xuICBhc3NlcnQubWF0Y2goXG4gICAgZGlzcGF0Y2hOb3RpZmljYXRpb24ubWVzc2FnZSxcbiAgICAvTTAwMVxcL1MwMS8sXG4gICAgXCJkaXNwYXRjaCBzaG91bGQgdGFyZ2V0IGNvbXBsZXRlZCBzbGljZSBTMDEsIG5vdCBhY3RpdmUgc2xpY2UgUzAyXCIsXG4gICk7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2goXG4gICAgZGlzcGF0Y2hOb3RpZmljYXRpb24ubWVzc2FnZSxcbiAgICAvTTAwMVxcL1MwMi8sXG4gICAgXCJkaXNwYXRjaCBzaG91bGQgTk9UIHRhcmdldCBhY3RpdmUgKG5leHQgaW5jb21wbGV0ZSkgc2xpY2UgUzAyXCIsXG4gICk7XG59KTtcblxudGVzdChcImRpc3BhdGNoIHVhdCB3YXJucyB3aGVuIG5vIGNvbXBsZXRlZCBzbGljZXMgZXhpc3RcIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgYmFzZSA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWRpc3BhdGNoLXVhdC1ub25lLVwiKSk7XG4gIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG5cbiAgY29uc3QgbWlsZXN0b25lRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKTtcbiAgbWtkaXJTeW5jKG1pbGVzdG9uZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKG1pbGVzdG9uZURpciwgXCJNMDAxLUNPTlRFWFQubWRcIiksXG4gICAgXCIjIE0wMDE6IFRlc3QgTWlsZXN0b25lXFxuXFxuQ29udGV4dC5cXG5cIixcbiAgKTtcblxuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4obWlsZXN0b25lRGlyLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSxcbiAgICBbXG4gICAgICBcIiMgTTAwMTogVGVzdFwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgU2xpY2VzXCIsXG4gICAgICBcIlwiLFxuICAgICAgXCItIFsgXSAqKlMwMTogRmlyc3QqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFwiLFxuICAgICAgXCJcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICk7XG5cbiAgLy8gUzAxIG5lZWRzIGEgcGxhbiBzbyBzdGF0ZSBkZXJpdmF0aW9uIGRvZXNuJ3Qgc3RvcCBhdCBwbGFubmluZyBwaGFzZVxuICBjb25zdCBzMDFEaXIgPSBqb2luKG1pbGVzdG9uZURpciwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gIG1rZGlyU3luYyhzMDFEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oczAxRGlyLCBcIlMwMS1QTEFOLm1kXCIpLFxuICAgIFwiIyBTMDEgUGxhblxcblxcbiMjIFRhc2tzXFxuXFxuLSBbIF0gKipUMDE6IFRhc2sqKiBgZWZmb3J0Omxvd2BcXG5cIixcbiAgKTtcbiAgY29uc3QgdDAxRGlyID0gam9pbihzMDFEaXIsIFwidGFza3NcIiwgXCJUMDFcIik7XG4gIG1rZGlyU3luYyh0MDFEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4odDAxRGlyLCBcIlQwMS1QTEFOLm1kXCIpLCBcIiMgVDAxIFBsYW5cXG5cIik7XG5cbiAgY29uc3Qgbm90aWZpY2F0aW9uczogeyBtZXNzYWdlOiBzdHJpbmc7IGxldmVsOiBzdHJpbmcgfVtdID0gW107XG5cbiAgY29uc3QgY3R4ID0ge1xuICAgIHVpOiB7XG4gICAgICBub3RpZnk6IChtZXNzYWdlOiBzdHJpbmcsIGxldmVsOiBzdHJpbmcpID0+IHtcbiAgICAgICAgbm90aWZpY2F0aW9ucy5wdXNoKHsgbWVzc2FnZSwgbGV2ZWwgfSk7XG4gICAgICB9LFxuICAgIH0sXG4gICAgbmV3U2Vzc2lvbjogYXN5bmMgKCkgPT4gKHsgY2FuY2VsbGVkOiBmYWxzZSB9KSxcbiAgfSBhcyBhbnk7XG5cbiAgY29uc3QgcGkgPSB7XG4gICAgc2VuZE1lc3NhZ2U6ICgpID0+IHtcbiAgICAgIGFzc2VydC5mYWlsKFwic2VuZE1lc3NhZ2Ugc2hvdWxkIG5vdCBiZSBjYWxsZWQgd2hlbiBubyBjb21wbGV0ZWQgc2xpY2VzXCIpO1xuICAgIH0sXG4gIH0gYXMgYW55O1xuXG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgYXdhaXQgZGlzcGF0Y2hEaXJlY3RQaGFzZShjdHgsIHBpLCBcInVhdFwiLCBiYXNlKTtcblxuICBjb25zdCB3YXJuaW5nID0gbm90aWZpY2F0aW9ucy5maW5kKG4gPT4gbi5sZXZlbCA9PT0gXCJ3YXJuaW5nXCIpO1xuICBhc3NlcnQub2sod2FybmluZywgXCJzaG91bGQgc2hvdyBhIHdhcm5pbmcgbm90aWZpY2F0aW9uXCIpO1xuICBhc3NlcnQubWF0Y2god2FybmluZy5tZXNzYWdlLCAvbm8gY29tcGxldGVkIHNsaWNlcy8sIFwid2FybmluZyBzaG91bGQgbWVudGlvbiBubyBjb21wbGV0ZWQgc2xpY2VzXCIpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFJQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYSxXQUFXLFFBQVEscUJBQXFCO0FBQzlELFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUywyQkFBMkI7QUFDcEMsU0FBUyw0QkFBNEI7QUFFckMsU0FBUyxnQkFBd0I7QUFDL0Is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
