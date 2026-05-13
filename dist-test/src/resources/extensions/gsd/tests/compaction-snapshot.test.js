import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSnapshot,
  readCompactionSnapshot,
  writeCompactionSnapshot,
  DEFAULT_SNAPSHOT_BYTES
} from "../compaction-snapshot.js";
import { closeDatabase, openDatabase } from "../gsd-db.js";
import { createMemory } from "../memory-store.js";
import { executeResume } from "../tools/resume-tool.js";
function freshBase() {
  return mkdtempSync(join(tmpdir(), "gsd-snap-"));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
test("buildSnapshot: renders memories, exec history, and active context", () => {
  const snap = buildSnapshot({
    generatedAt: /* @__PURE__ */ new Date("2026-04-20T12:00:00.000Z"),
    activeContext: "M001 / S01 / T01 \u2014 wire gsd_exec",
    memories: [
      {
        id: "MEM001",
        category: "gotcha",
        content: "FTS5 needs Porter tokenizer",
        confidence: 0.9,
        source_unit_type: null,
        source_unit_id: null,
        created_at: "",
        updated_at: "",
        superseded_by: null,
        hit_count: 0,
        scope: "project",
        seq: 1,
        tags: [],
        structured_fields: null,
        last_hit_at: null
      }
    ],
    execHistory: [
      {
        id: "abc",
        runtime: "bash",
        purpose: "count TODOs",
        started_at: "",
        finished_at: "",
        duration_ms: 10,
        exit_code: 0,
        signal: null,
        timed_out: false,
        stdout_bytes: 1,
        stderr_bytes: 0,
        stdout_truncated: false,
        stderr_truncated: false,
        stdout_path: "/tmp/abc.stdout",
        stderr_path: "/tmp/abc.stderr",
        meta_path: "/tmp/abc.meta.json"
      }
    ]
  });
  assert.match(snap, /Active context/);
  assert.match(snap, /M001 \/ S01 \/ T01/);
  assert.match(snap, /FTS5 needs Porter tokenizer/);
  assert.match(snap, /\[abc\] bash exit:0 — count TODOs/);
});
test("buildSnapshot: enforces the byte cap with a truncation marker", () => {
  const longMemories = Array.from({ length: 50 }, (_v, i) => ({
    id: `MEM${String(i).padStart(3, "0")}`,
    category: "gotcha",
    content: "x".repeat(200),
    confidence: 0.8,
    source_unit_type: null,
    source_unit_id: null,
    created_at: "",
    updated_at: "",
    superseded_by: null,
    hit_count: 0,
    scope: "project",
    seq: i,
    tags: [],
    structured_fields: null,
    last_hit_at: null
  }));
  const snap = buildSnapshot(
    { generatedAt: /* @__PURE__ */ new Date(), memories: longMemories, execHistory: [] },
    { maxBytes: 512, maxMemories: 50 }
  );
  assert.ok(Buffer.byteLength(snap, "utf-8") <= 512, "should respect cap");
  assert.match(snap, /\[truncated\]/, "should include truncation marker");
});
test("buildSnapshot: handles empty state with an explanatory placeholder", () => {
  const snap = buildSnapshot({ generatedAt: /* @__PURE__ */ new Date(), memories: [], execHistory: [] });
  assert.match(snap, /_No durable memories/);
  assert.ok(Buffer.byteLength(snap, "utf-8") <= DEFAULT_SNAPSHOT_BYTES);
});
test("writeCompactionSnapshot + readCompactionSnapshot + executeResume: end-to-end", () => {
  const base = freshBase();
  try {
    openDatabase(":memory:");
    createMemory({ category: "architecture", content: "Single-writer DB through gsd-db.ts", confidence: 0.95 });
    createMemory({ category: "convention", content: "Prefer typed helpers over raw SQL", confidence: 0.9 });
    const out = writeCompactionSnapshot(base, { activeContext: "M099 resume check" });
    assert.ok(out.path.endsWith("last-snapshot.md"));
    assert.ok(out.bytes > 0);
    assert.equal(out.memories, 2);
    const contents = readCompactionSnapshot(base);
    assert.ok(contents);
    assert.match(contents, /Single-writer DB through gsd-db\.ts/);
    assert.match(contents, /M099 resume check/);
    const tool = executeResume({}, { baseDir: base });
    assert.ok(!tool.isError);
    assert.equal(tool.details.found, true);
    assert.match(tool.content[0].text, /Single-writer DB through gsd-db\.ts/);
    const raw = readFileSync(out.path, "utf-8");
    assert.ok(raw.endsWith("\n"));
  } finally {
    closeDatabase();
    cleanup(base);
  }
});
test("executeResume: reports friendly empty state when no snapshot exists", () => {
  const base = freshBase();
  try {
    const result = executeResume({}, { baseDir: base });
    assert.equal(result.details.found, false);
    assert.match(result.content[0].text, /No snapshot found/);
  } finally {
    cleanup(base);
  }
});
test("executeResume: returns disabled error when context_mode.enabled=false", () => {
  const base = freshBase();
  try {
    const result = executeResume({}, { baseDir: base, preferences: { context_mode: { enabled: false } } });
    assert.equal(result.isError, true);
    assert.equal(result.details.error, "context_mode_disabled");
  } finally {
    cleanup(base);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21wYWN0aW9uLXNuYXBzaG90LnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IHRlc3QgfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIHJlYWRGaWxlU3luYywgcm1TeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tICdub2RlOm9zJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuXG5pbXBvcnQge1xuICBidWlsZFNuYXBzaG90LFxuICByZWFkQ29tcGFjdGlvblNuYXBzaG90LFxuICB3cml0ZUNvbXBhY3Rpb25TbmFwc2hvdCxcbiAgREVGQVVMVF9TTkFQU0hPVF9CWVRFUyxcbn0gZnJvbSAnLi4vY29tcGFjdGlvbi1zbmFwc2hvdC50cyc7XG5pbXBvcnQgeyBjbG9zZURhdGFiYXNlLCBvcGVuRGF0YWJhc2UgfSBmcm9tICcuLi9nc2QtZGIudHMnO1xuaW1wb3J0IHsgY3JlYXRlTWVtb3J5IH0gZnJvbSAnLi4vbWVtb3J5LXN0b3JlLnRzJztcbmltcG9ydCB7IGV4ZWN1dGVSZXN1bWUgfSBmcm9tICcuLi90b29scy9yZXN1bWUtdG9vbC50cyc7XG5cbmZ1bmN0aW9uIGZyZXNoQmFzZSgpOiBzdHJpbmcge1xuICByZXR1cm4gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgJ2dzZC1zbmFwLScpKTtcbn1cblxuZnVuY3Rpb24gY2xlYW51cChkaXI6IHN0cmluZyk6IHZvaWQge1xuICBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59XG5cbnRlc3QoJ2J1aWxkU25hcHNob3Q6IHJlbmRlcnMgbWVtb3JpZXMsIGV4ZWMgaGlzdG9yeSwgYW5kIGFjdGl2ZSBjb250ZXh0JywgKCkgPT4ge1xuICBjb25zdCBzbmFwID0gYnVpbGRTbmFwc2hvdCh7XG4gICAgZ2VuZXJhdGVkQXQ6IG5ldyBEYXRlKCcyMDI2LTA0LTIwVDEyOjAwOjAwLjAwMFonKSxcbiAgICBhY3RpdmVDb250ZXh0OiAnTTAwMSAvIFMwMSAvIFQwMSBcdTIwMTQgd2lyZSBnc2RfZXhlYycsXG4gICAgbWVtb3JpZXM6IFtcbiAgICAgIHsgaWQ6ICdNRU0wMDEnLCBjYXRlZ29yeTogJ2dvdGNoYScsIGNvbnRlbnQ6ICdGVFM1IG5lZWRzIFBvcnRlciB0b2tlbml6ZXInLCBjb25maWRlbmNlOiAwLjksXG4gICAgICAgIHNvdXJjZV91bml0X3R5cGU6IG51bGwsIHNvdXJjZV91bml0X2lkOiBudWxsLCBjcmVhdGVkX2F0OiAnJywgdXBkYXRlZF9hdDogJycsXG4gICAgICAgIHN1cGVyc2VkZWRfYnk6IG51bGwsIGhpdF9jb3VudDogMCwgc2NvcGU6ICdwcm9qZWN0Jywgc2VxOiAxLCB0YWdzOiBbXSwgc3RydWN0dXJlZF9maWVsZHM6IG51bGwsXG4gICAgICAgIGxhc3RfaGl0X2F0OiBudWxsIH0sXG4gICAgXSxcbiAgICBleGVjSGlzdG9yeTogW1xuICAgICAge1xuICAgICAgICBpZDogJ2FiYycsXG4gICAgICAgIHJ1bnRpbWU6ICdiYXNoJyxcbiAgICAgICAgcHVycG9zZTogJ2NvdW50IFRPRE9zJyxcbiAgICAgICAgc3RhcnRlZF9hdDogJycsIGZpbmlzaGVkX2F0OiAnJywgZHVyYXRpb25fbXM6IDEwLFxuICAgICAgICBleGl0X2NvZGU6IDAsIHNpZ25hbDogbnVsbCwgdGltZWRfb3V0OiBmYWxzZSxcbiAgICAgICAgc3Rkb3V0X2J5dGVzOiAxLCBzdGRlcnJfYnl0ZXM6IDAsIHN0ZG91dF90cnVuY2F0ZWQ6IGZhbHNlLCBzdGRlcnJfdHJ1bmNhdGVkOiBmYWxzZSxcbiAgICAgICAgc3Rkb3V0X3BhdGg6ICcvdG1wL2FiYy5zdGRvdXQnLCBzdGRlcnJfcGF0aDogJy90bXAvYWJjLnN0ZGVycicsIG1ldGFfcGF0aDogJy90bXAvYWJjLm1ldGEuanNvbicsXG4gICAgICB9LFxuICAgIF0sXG4gIH0pO1xuICBhc3NlcnQubWF0Y2goc25hcCwgL0FjdGl2ZSBjb250ZXh0Lyk7XG4gIGFzc2VydC5tYXRjaChzbmFwLCAvTTAwMSBcXC8gUzAxIFxcLyBUMDEvKTtcbiAgYXNzZXJ0Lm1hdGNoKHNuYXAsIC9GVFM1IG5lZWRzIFBvcnRlciB0b2tlbml6ZXIvKTtcbiAgYXNzZXJ0Lm1hdGNoKHNuYXAsIC9cXFthYmNcXF0gYmFzaCBleGl0OjAgXHUyMDE0IGNvdW50IFRPRE9zLyk7XG59KTtcblxudGVzdCgnYnVpbGRTbmFwc2hvdDogZW5mb3JjZXMgdGhlIGJ5dGUgY2FwIHdpdGggYSB0cnVuY2F0aW9uIG1hcmtlcicsICgpID0+IHtcbiAgY29uc3QgbG9uZ01lbW9yaWVzID0gQXJyYXkuZnJvbSh7IGxlbmd0aDogNTAgfSwgKF92LCBpKSA9PiAoe1xuICAgIGlkOiBgTUVNJHtTdHJpbmcoaSkucGFkU3RhcnQoMywgJzAnKX1gLFxuICAgIGNhdGVnb3J5OiAnZ290Y2hhJyxcbiAgICBjb250ZW50OiAneCcucmVwZWF0KDIwMCksXG4gICAgY29uZmlkZW5jZTogMC44LFxuICAgIHNvdXJjZV91bml0X3R5cGU6IG51bGwsXG4gICAgc291cmNlX3VuaXRfaWQ6IG51bGwsXG4gICAgY3JlYXRlZF9hdDogJycsXG4gICAgdXBkYXRlZF9hdDogJycsXG4gICAgc3VwZXJzZWRlZF9ieTogbnVsbCxcbiAgICBoaXRfY291bnQ6IDAsXG4gICAgc2NvcGU6ICdwcm9qZWN0JyxcbiAgICBzZXE6IGksXG4gICAgdGFnczogW10gYXMgc3RyaW5nW10sXG4gICAgc3RydWN0dXJlZF9maWVsZHM6IG51bGwsXG4gICAgbGFzdF9oaXRfYXQ6IG51bGwsXG4gIH0pKTtcbiAgY29uc3Qgc25hcCA9IGJ1aWxkU25hcHNob3QoXG4gICAgeyBnZW5lcmF0ZWRBdDogbmV3IERhdGUoKSwgbWVtb3JpZXM6IGxvbmdNZW1vcmllcywgZXhlY0hpc3Rvcnk6IFtdIH0sXG4gICAgeyBtYXhCeXRlczogNTEyLCBtYXhNZW1vcmllczogNTAgfSxcbiAgKTtcbiAgYXNzZXJ0Lm9rKEJ1ZmZlci5ieXRlTGVuZ3RoKHNuYXAsICd1dGYtOCcpIDw9IDUxMiwgJ3Nob3VsZCByZXNwZWN0IGNhcCcpO1xuICBhc3NlcnQubWF0Y2goc25hcCwgL1xcW3RydW5jYXRlZFxcXS8sICdzaG91bGQgaW5jbHVkZSB0cnVuY2F0aW9uIG1hcmtlcicpO1xufSk7XG5cbnRlc3QoJ2J1aWxkU25hcHNob3Q6IGhhbmRsZXMgZW1wdHkgc3RhdGUgd2l0aCBhbiBleHBsYW5hdG9yeSBwbGFjZWhvbGRlcicsICgpID0+IHtcbiAgY29uc3Qgc25hcCA9IGJ1aWxkU25hcHNob3QoeyBnZW5lcmF0ZWRBdDogbmV3IERhdGUoKSwgbWVtb3JpZXM6IFtdLCBleGVjSGlzdG9yeTogW10gfSk7XG4gIGFzc2VydC5tYXRjaChzbmFwLCAvX05vIGR1cmFibGUgbWVtb3JpZXMvKTtcbiAgYXNzZXJ0Lm9rKEJ1ZmZlci5ieXRlTGVuZ3RoKHNuYXAsICd1dGYtOCcpIDw9IERFRkFVTFRfU05BUFNIT1RfQllURVMpO1xufSk7XG5cbnRlc3QoJ3dyaXRlQ29tcGFjdGlvblNuYXBzaG90ICsgcmVhZENvbXBhY3Rpb25TbmFwc2hvdCArIGV4ZWN1dGVSZXN1bWU6IGVuZC10by1lbmQnLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBmcmVzaEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBvcGVuRGF0YWJhc2UoJzptZW1vcnk6Jyk7XG4gICAgY3JlYXRlTWVtb3J5KHsgY2F0ZWdvcnk6ICdhcmNoaXRlY3R1cmUnLCBjb250ZW50OiAnU2luZ2xlLXdyaXRlciBEQiB0aHJvdWdoIGdzZC1kYi50cycsIGNvbmZpZGVuY2U6IDAuOTUgfSk7XG4gICAgY3JlYXRlTWVtb3J5KHsgY2F0ZWdvcnk6ICdjb252ZW50aW9uJywgY29udGVudDogJ1ByZWZlciB0eXBlZCBoZWxwZXJzIG92ZXIgcmF3IFNRTCcsIGNvbmZpZGVuY2U6IDAuOSB9KTtcblxuICAgIGNvbnN0IG91dCA9IHdyaXRlQ29tcGFjdGlvblNuYXBzaG90KGJhc2UsIHsgYWN0aXZlQ29udGV4dDogJ00wOTkgcmVzdW1lIGNoZWNrJyB9KTtcbiAgICBhc3NlcnQub2sob3V0LnBhdGguZW5kc1dpdGgoJ2xhc3Qtc25hcHNob3QubWQnKSk7XG4gICAgYXNzZXJ0Lm9rKG91dC5ieXRlcyA+IDApO1xuICAgIGFzc2VydC5lcXVhbChvdXQubWVtb3JpZXMsIDIpO1xuXG4gICAgY29uc3QgY29udGVudHMgPSByZWFkQ29tcGFjdGlvblNuYXBzaG90KGJhc2UpO1xuICAgIGFzc2VydC5vayhjb250ZW50cyk7XG4gICAgYXNzZXJ0Lm1hdGNoKGNvbnRlbnRzISwgL1NpbmdsZS13cml0ZXIgREIgdGhyb3VnaCBnc2QtZGJcXC50cy8pO1xuICAgIGFzc2VydC5tYXRjaChjb250ZW50cyEsIC9NMDk5IHJlc3VtZSBjaGVjay8pO1xuXG4gICAgY29uc3QgdG9vbCA9IGV4ZWN1dGVSZXN1bWUoe30sIHsgYmFzZURpcjogYmFzZSB9KTtcbiAgICBhc3NlcnQub2soIXRvb2wuaXNFcnJvcik7XG4gICAgYXNzZXJ0LmVxdWFsKHRvb2wuZGV0YWlscy5mb3VuZCwgdHJ1ZSk7XG4gICAgYXNzZXJ0Lm1hdGNoKHRvb2wuY29udGVudFswXS50ZXh0LCAvU2luZ2xlLXdyaXRlciBEQiB0aHJvdWdoIGdzZC1kYlxcLnRzLyk7XG5cbiAgICAvLyBhbHNvIHZlcmlmeSB0aGUgZmlsZSBjb250ZW50IG1hdGNoZXMgKHdpdGhvdXQgdHJhaWxpbmcgbmV3bGluZSlcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMob3V0LnBhdGgsICd1dGYtOCcpO1xuICAgIGFzc2VydC5vayhyYXcuZW5kc1dpdGgoJ1xcbicpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgY2xlYW51cChiYXNlKTtcbiAgfVxufSk7XG5cbnRlc3QoJ2V4ZWN1dGVSZXN1bWU6IHJlcG9ydHMgZnJpZW5kbHkgZW1wdHkgc3RhdGUgd2hlbiBubyBzbmFwc2hvdCBleGlzdHMnLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBmcmVzaEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBleGVjdXRlUmVzdW1lKHt9LCB7IGJhc2VEaXI6IGJhc2UgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kZXRhaWxzLmZvdW5kLCBmYWxzZSk7XG4gICAgYXNzZXJ0Lm1hdGNoKHJlc3VsdC5jb250ZW50WzBdLnRleHQsIC9ObyBzbmFwc2hvdCBmb3VuZC8pO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFudXAoYmFzZSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdleGVjdXRlUmVzdW1lOiByZXR1cm5zIGRpc2FibGVkIGVycm9yIHdoZW4gY29udGV4dF9tb2RlLmVuYWJsZWQ9ZmFsc2UnLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2UgPSBmcmVzaEJhc2UoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBleGVjdXRlUmVzdW1lKHt9LCB7IGJhc2VEaXI6IGJhc2UsIHByZWZlcmVuY2VzOiB7IGNvbnRleHRfbW9kZTogeyBlbmFibGVkOiBmYWxzZSB9IH0gfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5pc0Vycm9yLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoKHJlc3VsdC5kZXRhaWxzIGFzIHsgZXJyb3I/OiBzdHJpbmcgfSkuZXJyb3IsICdjb250ZXh0X21vZGVfZGlzYWJsZWQnKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhbnVwKGJhc2UpO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsWUFBWTtBQUNyQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUFhLGNBQWMsY0FBYztBQUNsRCxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBRXJCO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFB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
