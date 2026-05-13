import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { MessageBatcher } from "./message-batcher.js";
function fakeEvent(content, hasEmbed = false) {
  const fe = { content };
  if (hasEmbed) {
    fe.embed = { data: { title: content } };
  }
  return fe;
}
function createSend() {
  const calls = [];
  const fn = mock.fn(async (payload) => {
    calls.push(payload);
  });
  return { fn, calls };
}
function createLogger() {
  const errors = [];
  const warns = [];
  const debugs = [];
  const logger = {
    error(msg) {
      errors.push(msg);
    },
    warn(msg) {
      warns.push(msg);
    },
    debug(msg) {
      debugs.push(msg);
    }
  };
  return { logger, errors, warns, debugs };
}
describe("MessageBatcher", () => {
  describe("enqueue + capacity flush", () => {
    it("flushes when buffer reaches maxBatchSize", async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, void 0, { maxBatchSize: 3, flushIntervalMs: 6e4 });
      batcher.enqueue(fakeEvent("a"));
      batcher.enqueue(fakeEvent("b"));
      assert.equal(calls.length, 0, "should not flush yet");
      batcher.enqueue(fakeEvent("c"));
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(calls.length, 1, "should have flushed once");
      assert.equal(calls[0].content, "a\nb\nc");
      assert.equal(batcher.pending, 0);
      await batcher.destroy();
    });
    it("skips embeds for batched messages (only content)", async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, void 0, { maxBatchSize: 2, flushIntervalMs: 6e4 });
      batcher.enqueue(fakeEvent("a", true));
      batcher.enqueue(fakeEvent("b", true));
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].embeds.length, 0, "batched sends skip embeds to avoid duplication");
      assert.equal(calls[0].content, "a\nb");
      await batcher.destroy();
    });
  });
  describe("enqueueImmediate", () => {
    it("flushes pending buffer then sends immediately", async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, void 0, { maxBatchSize: 10, flushIntervalMs: 6e4 });
      batcher.enqueue(fakeEvent("buffered-1"));
      batcher.enqueue(fakeEvent("buffered-2"));
      await batcher.enqueueImmediate(fakeEvent("blocker!"));
      assert.equal(calls.length, 2, "should have two send calls");
      assert.equal(calls[0].content, "buffered-1\nbuffered-2");
      assert.equal(calls[1].content, "blocker!");
      assert.equal(batcher.pending, 0);
      await batcher.destroy();
    });
    it("sends immediately when buffer is empty", async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, void 0, { maxBatchSize: 10, flushIntervalMs: 6e4 });
      await batcher.enqueueImmediate(fakeEvent("urgent"));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].content, "urgent");
      await batcher.destroy();
    });
  });
  describe("timer-based flush", () => {
    it("flushes on interval", async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, void 0, { maxBatchSize: 100, flushIntervalMs: 50 });
      batcher.start();
      batcher.enqueue(fakeEvent("timed-1"));
      batcher.enqueue(fakeEvent("timed-2"));
      await new Promise((r) => setTimeout(r, 120));
      assert.ok(calls.length >= 1, "timer should have triggered at least one flush");
      assert.equal(calls[0].content, "timed-1\ntimed-2");
      assert.equal(batcher.pending, 0);
      await batcher.destroy();
    });
    it("stop prevents further timer flushes", async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, void 0, { maxBatchSize: 100, flushIntervalMs: 30 });
      batcher.start();
      batcher.stop();
      batcher.enqueue(fakeEvent("orphan"));
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(calls.length, 0, "no flush after stop");
      batcher.stop();
      await batcher.destroy();
    });
  });
  describe("destroy", () => {
    it("flushes remaining buffer on destroy", async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, void 0, { maxBatchSize: 100, flushIntervalMs: 6e4 });
      batcher.enqueue(fakeEvent("leftover-1"));
      batcher.enqueue(fakeEvent("leftover-2"));
      await batcher.destroy();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].content, "leftover-1\nleftover-2");
    });
    it("is idempotent \u2014 second destroy is no-op", async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, void 0, { maxBatchSize: 100, flushIntervalMs: 6e4 });
      batcher.enqueue(fakeEvent("once"));
      await batcher.destroy();
      await batcher.destroy();
      assert.equal(calls.length, 1, "only flushed once");
    });
    it("enqueue after destroy is silently ignored", async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, void 0, { maxBatchSize: 2, flushIntervalMs: 6e4 });
      await batcher.destroy();
      batcher.enqueue(fakeEvent("post-destroy"));
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(calls.length, 0, "no sends after destroy");
    });
  });
  describe("empty buffer", () => {
    it("flush of empty buffer is no-op", async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, void 0, { maxBatchSize: 100, flushIntervalMs: 6e4 });
      batcher.start();
      await new Promise((r) => setTimeout(r, 10));
      await batcher.destroy();
      assert.equal(calls.length, 0, "no sends for empty buffer");
    });
  });
  describe("single-item flush", () => {
    it("handles a single item in buffer at destroy", async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, void 0, { maxBatchSize: 100, flushIntervalMs: 6e4 });
      batcher.enqueue(fakeEvent("solo"));
      await batcher.destroy();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].content, "solo");
      assert.equal(calls[0].embeds.length, 0);
      assert.equal(calls[0].components.length, 0);
    });
  });
  describe("error handling", () => {
    it("logs error and continues when send throws", async () => {
      let attempt = 0;
      const sendFn = async () => {
        attempt++;
        throw new Error("Discord rate limit");
      };
      const { logger, errors, warns } = createLogger();
      const batcher = new MessageBatcher(sendFn, logger, { maxBatchSize: 2, flushIntervalMs: 6e4 });
      batcher.enqueue(fakeEvent("x"));
      batcher.enqueue(fakeEvent("y"));
      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(errors.length >= 1, "should have logged an error");
      assert.ok(warns.length >= 1, "should have logged a warning on retry failure");
      assert.equal(batcher.pending, 0, "buffer cleared even on error");
      batcher.enqueue(fakeEvent("after-error"));
      assert.equal(batcher.pending, 1, "can still enqueue after error");
      await batcher.destroy();
    });
    it("succeeds on retry if first attempt fails", async () => {
      let attempt = 0;
      const calls = [];
      const sendFn = async (payload) => {
        attempt++;
        if (attempt === 1) throw new Error("transient");
        calls.push(payload);
      };
      const { logger, errors } = createLogger();
      const batcher = new MessageBatcher(sendFn, logger, { maxBatchSize: 2, flushIntervalMs: 6e4 });
      batcher.enqueue(fakeEvent("retry-me"));
      batcher.enqueue(fakeEvent("retry-too"));
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(errors.length, 1, "logged one error on first attempt");
      assert.equal(calls.length, 1, "retry succeeded");
      assert.equal(calls[0].content, "retry-me\nretry-too");
      await batcher.destroy();
    });
  });
  describe("buffer at exactly capacity", () => {
    it("flushes at exactly maxBatchSize", async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, void 0, { maxBatchSize: 4, flushIntervalMs: 6e4 });
      batcher.enqueue(fakeEvent("1"));
      batcher.enqueue(fakeEvent("2"));
      batcher.enqueue(fakeEvent("3"));
      assert.equal(calls.length, 0, "not flushed at 3/4");
      batcher.enqueue(fakeEvent("4"));
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].content, "1\n2\n3\n4");
      await batcher.destroy();
    });
  });
  describe("components handling", () => {
    it("uses components from the last event that has them", async () => {
      const { fn, calls } = createSend();
      const batcher = new MessageBatcher(fn, void 0, { maxBatchSize: 3, flushIntervalMs: 6e4 });
      const fakeRow = { type: "ActionRow", components: [] };
      batcher.enqueue(fakeEvent("no-components"));
      batcher.enqueue({ content: "with-components", components: [fakeRow] });
      batcher.enqueue(fakeEvent("also-no-components"));
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].components, [fakeRow]);
      await batcher.destroy();
    });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvZGFlbW9uL3NyYy9tZXNzYWdlLWJhdGNoZXIudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBiZWZvcmVFYWNoLCBhZnRlckVhY2gsIG1vY2sgfSBmcm9tICdub2RlOnRlc3QnO1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnO1xuaW1wb3J0IHsgTWVzc2FnZUJhdGNoZXIgfSBmcm9tICcuL21lc3NhZ2UtYmF0Y2hlci5qcyc7XG5pbXBvcnQgdHlwZSB7IFNlbmRQYXlsb2FkLCBCYXRjaGVyTG9nZ2VyIH0gZnJvbSAnLi9tZXNzYWdlLWJhdGNoZXIuanMnO1xuaW1wb3J0IHR5cGUgeyBGb3JtYXR0ZWRFdmVudCB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEhlbHBlcnNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogQ3JlYXRlIGEgbWluaW1hbCBGb3JtYXR0ZWRFdmVudCBmb3IgdGVzdGluZy4gKi9cbmZ1bmN0aW9uIGZha2VFdmVudChjb250ZW50OiBzdHJpbmcsIGhhc0VtYmVkID0gZmFsc2UpOiBGb3JtYXR0ZWRFdmVudCB7XG4gIGNvbnN0IGZlOiBGb3JtYXR0ZWRFdmVudCA9IHsgY29udGVudCB9O1xuICBpZiAoaGFzRW1iZWQpIHtcbiAgICAvLyBNaW5pbWFsIG1vY2sgZW1iZWQgXHUyMDE0IGp1c3QgbmVlZHMgdG8gYmUgdHJ1dGh5IGFuZCBwYXNzIHRocm91Z2hcbiAgICBmZS5lbWJlZCA9IHsgZGF0YTogeyB0aXRsZTogY29udGVudCB9IH0gYXMgYW55O1xuICB9XG4gIHJldHVybiBmZTtcbn1cblxuLyoqIENyZWF0ZSBhIHRyYWNraW5nIHNlbmQgZnVuY3Rpb24uICovXG5mdW5jdGlvbiBjcmVhdGVTZW5kKCkge1xuICBjb25zdCBjYWxsczogU2VuZFBheWxvYWRbXSA9IFtdO1xuICBjb25zdCBmbiA9IG1vY2suZm4oYXN5bmMgKHBheWxvYWQ6IFNlbmRQYXlsb2FkKSA9PiB7XG4gICAgY2FsbHMucHVzaChwYXlsb2FkKTtcbiAgfSk7XG4gIHJldHVybiB7IGZuLCBjYWxscyB9O1xufVxuXG4vKiogQ3JlYXRlIGEgbG9nZ2VyIHRoYXQgY2FwdHVyZXMgZXJyb3Ivd2FybiBjYWxscy4gKi9cbmZ1bmN0aW9uIGNyZWF0ZUxvZ2dlcigpIHtcbiAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB3YXJuczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGVidWdzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBsb2dnZXI6IEJhdGNoZXJMb2dnZXIgPSB7XG4gICAgZXJyb3IobXNnOiBzdHJpbmcpIHsgZXJyb3JzLnB1c2gobXNnKTsgfSxcbiAgICB3YXJuKG1zZzogc3RyaW5nKSB7IHdhcm5zLnB1c2gobXNnKTsgfSxcbiAgICBkZWJ1Zyhtc2c6IHN0cmluZykgeyBkZWJ1Z3MucHVzaChtc2cpOyB9LFxuICB9O1xuICByZXR1cm4geyBsb2dnZXIsIGVycm9ycywgd2FybnMsIGRlYnVncyB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRlc3RzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZGVzY3JpYmUoJ01lc3NhZ2VCYXRjaGVyJywgKCkgPT4ge1xuICBkZXNjcmliZSgnZW5xdWV1ZSArIGNhcGFjaXR5IGZsdXNoJywgKCkgPT4ge1xuICAgIGl0KCdmbHVzaGVzIHdoZW4gYnVmZmVyIHJlYWNoZXMgbWF4QmF0Y2hTaXplJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgeyBmbiwgY2FsbHMgfSA9IGNyZWF0ZVNlbmQoKTtcbiAgICAgIGNvbnN0IGJhdGNoZXIgPSBuZXcgTWVzc2FnZUJhdGNoZXIoZm4sIHVuZGVmaW5lZCwgeyBtYXhCYXRjaFNpemU6IDMsIGZsdXNoSW50ZXJ2YWxNczogNjBfMDAwIH0pO1xuXG4gICAgICBiYXRjaGVyLmVucXVldWUoZmFrZUV2ZW50KCdhJykpO1xuICAgICAgYmF0Y2hlci5lbnF1ZXVlKGZha2VFdmVudCgnYicpKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYWxscy5sZW5ndGgsIDAsICdzaG91bGQgbm90IGZsdXNoIHlldCcpO1xuXG4gICAgICBiYXRjaGVyLmVucXVldWUoZmFrZUV2ZW50KCdjJykpOyAvLyBoaXRzIGNhcGFjaXR5XG4gICAgICAvLyBmbHVzaCBpcyBhc3luYyBcdTIwMTQgZ2l2ZSBpdCBhIHRpY2tcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwKSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChjYWxscy5sZW5ndGgsIDEsICdzaG91bGQgaGF2ZSBmbHVzaGVkIG9uY2UnKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYWxsc1swXS5jb250ZW50LCAnYVxcbmJcXG5jJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoYmF0Y2hlci5wZW5kaW5nLCAwKTtcblxuICAgICAgYXdhaXQgYmF0Y2hlci5kZXN0cm95KCk7XG4gICAgfSk7XG5cbiAgICBpdCgnc2tpcHMgZW1iZWRzIGZvciBiYXRjaGVkIG1lc3NhZ2VzIChvbmx5IGNvbnRlbnQpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgeyBmbiwgY2FsbHMgfSA9IGNyZWF0ZVNlbmQoKTtcbiAgICAgIGNvbnN0IGJhdGNoZXIgPSBuZXcgTWVzc2FnZUJhdGNoZXIoZm4sIHVuZGVmaW5lZCwgeyBtYXhCYXRjaFNpemU6IDIsIGZsdXNoSW50ZXJ2YWxNczogNjBfMDAwIH0pO1xuXG4gICAgICBiYXRjaGVyLmVucXVldWUoZmFrZUV2ZW50KCdhJywgdHJ1ZSkpO1xuICAgICAgYmF0Y2hlci5lbnF1ZXVlKGZha2VFdmVudCgnYicsIHRydWUpKTsgLy8gdHJpZ2dlcnMgZmx1c2hcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwKSk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChjYWxscy5sZW5ndGgsIDEpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNhbGxzWzBdLmVtYmVkcy5sZW5ndGgsIDAsICdiYXRjaGVkIHNlbmRzIHNraXAgZW1iZWRzIHRvIGF2b2lkIGR1cGxpY2F0aW9uJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoY2FsbHNbMF0uY29udGVudCwgJ2FcXG5iJyk7XG5cbiAgICAgIGF3YWl0IGJhdGNoZXIuZGVzdHJveSgpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnZW5xdWV1ZUltbWVkaWF0ZScsICgpID0+IHtcbiAgICBpdCgnZmx1c2hlcyBwZW5kaW5nIGJ1ZmZlciB0aGVuIHNlbmRzIGltbWVkaWF0ZWx5JywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgeyBmbiwgY2FsbHMgfSA9IGNyZWF0ZVNlbmQoKTtcbiAgICAgIGNvbnN0IGJhdGNoZXIgPSBuZXcgTWVzc2FnZUJhdGNoZXIoZm4sIHVuZGVmaW5lZCwgeyBtYXhCYXRjaFNpemU6IDEwLCBmbHVzaEludGVydmFsTXM6IDYwXzAwMCB9KTtcblxuICAgICAgYmF0Y2hlci5lbnF1ZXVlKGZha2VFdmVudCgnYnVmZmVyZWQtMScpKTtcbiAgICAgIGJhdGNoZXIuZW5xdWV1ZShmYWtlRXZlbnQoJ2J1ZmZlcmVkLTInKSk7XG5cbiAgICAgIGF3YWl0IGJhdGNoZXIuZW5xdWV1ZUltbWVkaWF0ZShmYWtlRXZlbnQoJ2Jsb2NrZXIhJykpO1xuXG4gICAgICAvLyBGaXJzdCBjYWxsOiB0aGUgcGVuZGluZyBidWZmZXIgZmx1c2hcbiAgICAgIC8vIFNlY29uZCBjYWxsOiB0aGUgaW1tZWRpYXRlIGV2ZW50XG4gICAgICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAyLCAnc2hvdWxkIGhhdmUgdHdvIHNlbmQgY2FsbHMnKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYWxsc1swXS5jb250ZW50LCAnYnVmZmVyZWQtMVxcbmJ1ZmZlcmVkLTInKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYWxsc1sxXS5jb250ZW50LCAnYmxvY2tlciEnKTtcbiAgICAgIGFzc2VydC5lcXVhbChiYXRjaGVyLnBlbmRpbmcsIDApO1xuXG4gICAgICBhd2FpdCBiYXRjaGVyLmRlc3Ryb3koKTtcbiAgICB9KTtcblxuICAgIGl0KCdzZW5kcyBpbW1lZGlhdGVseSB3aGVuIGJ1ZmZlciBpcyBlbXB0eScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHsgZm4sIGNhbGxzIH0gPSBjcmVhdGVTZW5kKCk7XG4gICAgICBjb25zdCBiYXRjaGVyID0gbmV3IE1lc3NhZ2VCYXRjaGVyKGZuLCB1bmRlZmluZWQsIHsgbWF4QmF0Y2hTaXplOiAxMCwgZmx1c2hJbnRlcnZhbE1zOiA2MF8wMDAgfSk7XG5cbiAgICAgIGF3YWl0IGJhdGNoZXIuZW5xdWV1ZUltbWVkaWF0ZShmYWtlRXZlbnQoJ3VyZ2VudCcpKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKGNhbGxzLmxlbmd0aCwgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwoY2FsbHNbMF0uY29udGVudCwgJ3VyZ2VudCcpO1xuXG4gICAgICBhd2FpdCBiYXRjaGVyLmRlc3Ryb3koKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ3RpbWVyLWJhc2VkIGZsdXNoJywgKCkgPT4ge1xuICAgIGl0KCdmbHVzaGVzIG9uIGludGVydmFsJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgeyBmbiwgY2FsbHMgfSA9IGNyZWF0ZVNlbmQoKTtcbiAgICAgIGNvbnN0IGJhdGNoZXIgPSBuZXcgTWVzc2FnZUJhdGNoZXIoZm4sIHVuZGVmaW5lZCwgeyBtYXhCYXRjaFNpemU6IDEwMCwgZmx1c2hJbnRlcnZhbE1zOiA1MCB9KTtcbiAgICAgIGJhdGNoZXIuc3RhcnQoKTtcblxuICAgICAgYmF0Y2hlci5lbnF1ZXVlKGZha2VFdmVudCgndGltZWQtMScpKTtcbiAgICAgIGJhdGNoZXIuZW5xdWV1ZShmYWtlRXZlbnQoJ3RpbWVkLTInKSk7XG5cbiAgICAgIC8vIFdhaXQgbG9uZ2VyIHRoYW4gZmx1c2hJbnRlcnZhbE1zXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMjApKTtcblxuICAgICAgYXNzZXJ0Lm9rKGNhbGxzLmxlbmd0aCA+PSAxLCAndGltZXIgc2hvdWxkIGhhdmUgdHJpZ2dlcmVkIGF0IGxlYXN0IG9uZSBmbHVzaCcpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNhbGxzWzBdLmNvbnRlbnQsICd0aW1lZC0xXFxudGltZWQtMicpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGJhdGNoZXIucGVuZGluZywgMCk7XG5cbiAgICAgIGF3YWl0IGJhdGNoZXIuZGVzdHJveSgpO1xuICAgIH0pO1xuXG4gICAgaXQoJ3N0b3AgcHJldmVudHMgZnVydGhlciB0aW1lciBmbHVzaGVzJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgeyBmbiwgY2FsbHMgfSA9IGNyZWF0ZVNlbmQoKTtcbiAgICAgIGNvbnN0IGJhdGNoZXIgPSBuZXcgTWVzc2FnZUJhdGNoZXIoZm4sIHVuZGVmaW5lZCwgeyBtYXhCYXRjaFNpemU6IDEwMCwgZmx1c2hJbnRlcnZhbE1zOiAzMCB9KTtcbiAgICAgIGJhdGNoZXIuc3RhcnQoKTtcbiAgICAgIGJhdGNoZXIuc3RvcCgpO1xuXG4gICAgICBiYXRjaGVyLmVucXVldWUoZmFrZUV2ZW50KCdvcnBoYW4nKSk7XG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA4MCkpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAwLCAnbm8gZmx1c2ggYWZ0ZXIgc3RvcCcpO1xuICAgICAgLy8gQ2xlYW51cCB3aXRob3V0IHRyaWdnZXJpbmcgZmx1c2ggdGltZXJcbiAgICAgIGJhdGNoZXIuc3RvcCgpOyAvLyBpZGVtcG90ZW50XG4gICAgICAvLyBNYW51YWxseSBkcmFpbiBmb3IgY2xlYW51cFxuICAgICAgYXdhaXQgYmF0Y2hlci5kZXN0cm95KCk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdkZXN0cm95JywgKCkgPT4ge1xuICAgIGl0KCdmbHVzaGVzIHJlbWFpbmluZyBidWZmZXIgb24gZGVzdHJveScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHsgZm4sIGNhbGxzIH0gPSBjcmVhdGVTZW5kKCk7XG4gICAgICBjb25zdCBiYXRjaGVyID0gbmV3IE1lc3NhZ2VCYXRjaGVyKGZuLCB1bmRlZmluZWQsIHsgbWF4QmF0Y2hTaXplOiAxMDAsIGZsdXNoSW50ZXJ2YWxNczogNjBfMDAwIH0pO1xuXG4gICAgICBiYXRjaGVyLmVucXVldWUoZmFrZUV2ZW50KCdsZWZ0b3Zlci0xJykpO1xuICAgICAgYmF0Y2hlci5lbnF1ZXVlKGZha2VFdmVudCgnbGVmdG92ZXItMicpKTtcblxuICAgICAgYXdhaXQgYmF0Y2hlci5kZXN0cm95KCk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChjYWxscy5sZW5ndGgsIDEpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNhbGxzWzBdLmNvbnRlbnQsICdsZWZ0b3Zlci0xXFxubGVmdG92ZXItMicpO1xuICAgIH0pO1xuXG4gICAgaXQoJ2lzIGlkZW1wb3RlbnQgXHUyMDE0IHNlY29uZCBkZXN0cm95IGlzIG5vLW9wJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgeyBmbiwgY2FsbHMgfSA9IGNyZWF0ZVNlbmQoKTtcbiAgICAgIGNvbnN0IGJhdGNoZXIgPSBuZXcgTWVzc2FnZUJhdGNoZXIoZm4sIHVuZGVmaW5lZCwgeyBtYXhCYXRjaFNpemU6IDEwMCwgZmx1c2hJbnRlcnZhbE1zOiA2MF8wMDAgfSk7XG5cbiAgICAgIGJhdGNoZXIuZW5xdWV1ZShmYWtlRXZlbnQoJ29uY2UnKSk7XG4gICAgICBhd2FpdCBiYXRjaGVyLmRlc3Ryb3koKTtcbiAgICAgIGF3YWl0IGJhdGNoZXIuZGVzdHJveSgpOyAvLyBzZWNvbmQgY2FsbFxuXG4gICAgICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAxLCAnb25seSBmbHVzaGVkIG9uY2UnKTtcbiAgICB9KTtcblxuICAgIGl0KCdlbnF1ZXVlIGFmdGVyIGRlc3Ryb3kgaXMgc2lsZW50bHkgaWdub3JlZCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHsgZm4sIGNhbGxzIH0gPSBjcmVhdGVTZW5kKCk7XG4gICAgICBjb25zdCBiYXRjaGVyID0gbmV3IE1lc3NhZ2VCYXRjaGVyKGZuLCB1bmRlZmluZWQsIHsgbWF4QmF0Y2hTaXplOiAyLCBmbHVzaEludGVydmFsTXM6IDYwXzAwMCB9KTtcbiAgICAgIGF3YWl0IGJhdGNoZXIuZGVzdHJveSgpO1xuXG4gICAgICBiYXRjaGVyLmVucXVldWUoZmFrZUV2ZW50KCdwb3N0LWRlc3Ryb3knKSk7XG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMCkpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAwLCAnbm8gc2VuZHMgYWZ0ZXIgZGVzdHJveScpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnZW1wdHkgYnVmZmVyJywgKCkgPT4ge1xuICAgIGl0KCdmbHVzaCBvZiBlbXB0eSBidWZmZXIgaXMgbm8tb3AnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IGZuLCBjYWxscyB9ID0gY3JlYXRlU2VuZCgpO1xuICAgICAgY29uc3QgYmF0Y2hlciA9IG5ldyBNZXNzYWdlQmF0Y2hlcihmbiwgdW5kZWZpbmVkLCB7IG1heEJhdGNoU2l6ZTogMTAwLCBmbHVzaEludGVydmFsTXM6IDYwXzAwMCB9KTtcbiAgICAgIGJhdGNoZXIuc3RhcnQoKTtcblxuICAgICAgLy8gRm9yY2UgYSB0aW1lciB0aWNrIHdpdGggYW4gZW1wdHkgYnVmZmVyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMCkpO1xuICAgICAgYXdhaXQgYmF0Y2hlci5kZXN0cm95KCk7XG5cbiAgICAgIC8vIE9ubHkgdGhlIGRlc3Ryb3ktdHJpZ2dlcmVkIGZsdXNoLCB3aGljaCBzaG91bGQgYWxzbyBiZSBhIG5vLW9wXG4gICAgICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAwLCAnbm8gc2VuZHMgZm9yIGVtcHR5IGJ1ZmZlcicpO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnc2luZ2xlLWl0ZW0gZmx1c2gnLCAoKSA9PiB7XG4gICAgaXQoJ2hhbmRsZXMgYSBzaW5nbGUgaXRlbSBpbiBidWZmZXIgYXQgZGVzdHJveScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHsgZm4sIGNhbGxzIH0gPSBjcmVhdGVTZW5kKCk7XG4gICAgICBjb25zdCBiYXRjaGVyID0gbmV3IE1lc3NhZ2VCYXRjaGVyKGZuLCB1bmRlZmluZWQsIHsgbWF4QmF0Y2hTaXplOiAxMDAsIGZsdXNoSW50ZXJ2YWxNczogNjBfMDAwIH0pO1xuXG4gICAgICBiYXRjaGVyLmVucXVldWUoZmFrZUV2ZW50KCdzb2xvJykpO1xuICAgICAgYXdhaXQgYmF0Y2hlci5kZXN0cm95KCk7XG5cbiAgICAgIGFzc2VydC5lcXVhbChjYWxscy5sZW5ndGgsIDEpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNhbGxzWzBdLmNvbnRlbnQsICdzb2xvJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoY2FsbHNbMF0uZW1iZWRzLmxlbmd0aCwgMCk7XG4gICAgICBhc3NlcnQuZXF1YWwoY2FsbHNbMF0uY29tcG9uZW50cy5sZW5ndGgsIDApO1xuICAgIH0pO1xuICB9KTtcblxuICBkZXNjcmliZSgnZXJyb3IgaGFuZGxpbmcnLCAoKSA9PiB7XG4gICAgaXQoJ2xvZ3MgZXJyb3IgYW5kIGNvbnRpbnVlcyB3aGVuIHNlbmQgdGhyb3dzJywgYXN5bmMgKCkgPT4ge1xuICAgICAgbGV0IGF0dGVtcHQgPSAwO1xuICAgICAgY29uc3Qgc2VuZEZuID0gYXN5bmMgKCkgPT4ge1xuICAgICAgICBhdHRlbXB0Kys7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignRGlzY29yZCByYXRlIGxpbWl0Jyk7XG4gICAgICB9O1xuICAgICAgY29uc3QgeyBsb2dnZXIsIGVycm9ycywgd2FybnMgfSA9IGNyZWF0ZUxvZ2dlcigpO1xuICAgICAgY29uc3QgYmF0Y2hlciA9IG5ldyBNZXNzYWdlQmF0Y2hlcihzZW5kRm4sIGxvZ2dlciwgeyBtYXhCYXRjaFNpemU6IDIsIGZsdXNoSW50ZXJ2YWxNczogNjBfMDAwIH0pO1xuXG4gICAgICBiYXRjaGVyLmVucXVldWUoZmFrZUV2ZW50KCd4JykpO1xuICAgICAgYmF0Y2hlci5lbnF1ZXVlKGZha2VFdmVudCgneScpKTsgLy8gdHJpZ2dlcnMgZmx1c2hcbiAgICAgIC8vIFdhaXQgZm9yIGZsdXNoICsgcmV0cnlcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDE1MDApKTtcblxuICAgICAgYXNzZXJ0Lm9rKGVycm9ycy5sZW5ndGggPj0gMSwgJ3Nob3VsZCBoYXZlIGxvZ2dlZCBhbiBlcnJvcicpO1xuICAgICAgYXNzZXJ0Lm9rKHdhcm5zLmxlbmd0aCA+PSAxLCAnc2hvdWxkIGhhdmUgbG9nZ2VkIGEgd2FybmluZyBvbiByZXRyeSBmYWlsdXJlJyk7XG4gICAgICBhc3NlcnQuZXF1YWwoYmF0Y2hlci5wZW5kaW5nLCAwLCAnYnVmZmVyIGNsZWFyZWQgZXZlbiBvbiBlcnJvcicpO1xuXG4gICAgICAvLyBCYXRjaGVyIHNob3VsZCBzdGlsbCBiZSBhbGl2ZSBcdTIwMTQgZW5xdWV1ZSBtb3JlXG4gICAgICBiYXRjaGVyLmVucXVldWUoZmFrZUV2ZW50KCdhZnRlci1lcnJvcicpKTtcbiAgICAgIGFzc2VydC5lcXVhbChiYXRjaGVyLnBlbmRpbmcsIDEsICdjYW4gc3RpbGwgZW5xdWV1ZSBhZnRlciBlcnJvcicpO1xuXG4gICAgICBhd2FpdCBiYXRjaGVyLmRlc3Ryb3koKTtcbiAgICB9KTtcblxuICAgIGl0KCdzdWNjZWVkcyBvbiByZXRyeSBpZiBmaXJzdCBhdHRlbXB0IGZhaWxzJywgYXN5bmMgKCkgPT4ge1xuICAgICAgbGV0IGF0dGVtcHQgPSAwO1xuICAgICAgY29uc3QgY2FsbHM6IFNlbmRQYXlsb2FkW10gPSBbXTtcbiAgICAgIGNvbnN0IHNlbmRGbiA9IGFzeW5jIChwYXlsb2FkOiBTZW5kUGF5bG9hZCkgPT4ge1xuICAgICAgICBhdHRlbXB0Kys7XG4gICAgICAgIGlmIChhdHRlbXB0ID09PSAxKSB0aHJvdyBuZXcgRXJyb3IoJ3RyYW5zaWVudCcpO1xuICAgICAgICBjYWxscy5wdXNoKHBheWxvYWQpO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IHsgbG9nZ2VyLCBlcnJvcnMgfSA9IGNyZWF0ZUxvZ2dlcigpO1xuICAgICAgY29uc3QgYmF0Y2hlciA9IG5ldyBNZXNzYWdlQmF0Y2hlcihzZW5kRm4sIGxvZ2dlciwgeyBtYXhCYXRjaFNpemU6IDIsIGZsdXNoSW50ZXJ2YWxNczogNjBfMDAwIH0pO1xuXG4gICAgICBiYXRjaGVyLmVucXVldWUoZmFrZUV2ZW50KCdyZXRyeS1tZScpKTtcbiAgICAgIGJhdGNoZXIuZW5xdWV1ZShmYWtlRXZlbnQoJ3JldHJ5LXRvbycpKTtcbiAgICAgIC8vIFdhaXQgZm9yIGZsdXNoICsgcmV0cnkgZGVsYXlcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDE1MDApKTtcblxuICAgICAgYXNzZXJ0LmVxdWFsKGVycm9ycy5sZW5ndGgsIDEsICdsb2dnZWQgb25lIGVycm9yIG9uIGZpcnN0IGF0dGVtcHQnKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYWxscy5sZW5ndGgsIDEsICdyZXRyeSBzdWNjZWVkZWQnKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYWxsc1swXS5jb250ZW50LCAncmV0cnktbWVcXG5yZXRyeS10b28nKTtcblxuICAgICAgYXdhaXQgYmF0Y2hlci5kZXN0cm95KCk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGRlc2NyaWJlKCdidWZmZXIgYXQgZXhhY3RseSBjYXBhY2l0eScsICgpID0+IHtcbiAgICBpdCgnZmx1c2hlcyBhdCBleGFjdGx5IG1heEJhdGNoU2l6ZScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHsgZm4sIGNhbGxzIH0gPSBjcmVhdGVTZW5kKCk7XG4gICAgICBjb25zdCBiYXRjaGVyID0gbmV3IE1lc3NhZ2VCYXRjaGVyKGZuLCB1bmRlZmluZWQsIHsgbWF4QmF0Y2hTaXplOiA0LCBmbHVzaEludGVydmFsTXM6IDYwXzAwMCB9KTtcblxuICAgICAgYmF0Y2hlci5lbnF1ZXVlKGZha2VFdmVudCgnMScpKTtcbiAgICAgIGJhdGNoZXIuZW5xdWV1ZShmYWtlRXZlbnQoJzInKSk7XG4gICAgICBiYXRjaGVyLmVucXVldWUoZmFrZUV2ZW50KCczJykpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGNhbGxzLmxlbmd0aCwgMCwgJ25vdCBmbHVzaGVkIGF0IDMvNCcpO1xuXG4gICAgICBiYXRjaGVyLmVucXVldWUoZmFrZUV2ZW50KCc0JykpOyAvLyBleGFjdGx5IGF0IGNhcGFjaXR5XG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMCkpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5lcXVhbChjYWxsc1swXS5jb250ZW50LCAnMVxcbjJcXG4zXFxuNCcpO1xuXG4gICAgICBhd2FpdCBiYXRjaGVyLmRlc3Ryb3koKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgZGVzY3JpYmUoJ2NvbXBvbmVudHMgaGFuZGxpbmcnLCAoKSA9PiB7XG4gICAgaXQoJ3VzZXMgY29tcG9uZW50cyBmcm9tIHRoZSBsYXN0IGV2ZW50IHRoYXQgaGFzIHRoZW0nLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IGZuLCBjYWxscyB9ID0gY3JlYXRlU2VuZCgpO1xuICAgICAgY29uc3QgYmF0Y2hlciA9IG5ldyBNZXNzYWdlQmF0Y2hlcihmbiwgdW5kZWZpbmVkLCB7IG1heEJhdGNoU2l6ZTogMywgZmx1c2hJbnRlcnZhbE1zOiA2MF8wMDAgfSk7XG5cbiAgICAgIGNvbnN0IGZha2VSb3cgPSB7IHR5cGU6ICdBY3Rpb25Sb3cnLCBjb21wb25lbnRzOiBbXSB9O1xuICAgICAgYmF0Y2hlci5lbnF1ZXVlKGZha2VFdmVudCgnbm8tY29tcG9uZW50cycpKTtcbiAgICAgIGJhdGNoZXIuZW5xdWV1ZSh7IGNvbnRlbnQ6ICd3aXRoLWNvbXBvbmVudHMnLCBjb21wb25lbnRzOiBbZmFrZVJvd10gfSBhcyBhbnkpO1xuICAgICAgYmF0Y2hlci5lbnF1ZXVlKGZha2VFdmVudCgnYWxzby1uby1jb21wb25lbnRzJykpOyAvLyB0cmlnZ2VycyBmbHVzaFxuXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMCkpO1xuXG4gICAgICBhc3NlcnQuZXF1YWwoY2FsbHMubGVuZ3RoLCAxKTtcbiAgICAgIGFzc2VydC5kZWVwRXF1YWwoY2FsbHNbMF0uY29tcG9uZW50cywgW2Zha2VSb3ddKTtcblxuICAgICAgYXdhaXQgYmF0Y2hlci5kZXN0cm95KCk7XG4gICAgfSk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsSUFBMkIsWUFBWTtBQUMxRCxPQUFPLFlBQVk7QUFDbkIsU0FBUyxzQkFBc0I7QUFTL0IsU0FBUyxVQUFVLFNBQWlCLFdBQVcsT0FBdUI7QUFDcEUsUUFBTSxLQUFxQixFQUFFLFFBQVE7QUFDckMsTUFBSSxVQUFVO0FBRVosT0FBRyxRQUFRLEVBQUUsTUFBTSxFQUFFLE9BQU8sUUFBUSxFQUFFO0FBQUEsRUFDeEM7QUFDQSxTQUFPO0FBQ1Q7QUFHQSxT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
