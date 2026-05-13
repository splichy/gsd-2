const noopLogger = {
  error() {
  },
  warn() {
  },
  debug() {
  }
};
class MessageBatcher {
  send;
  logger;
  flushIntervalMs;
  maxBatchSize;
  buffer = [];
  timer = null;
  flushing = false;
  destroyed = false;
  constructor(send, logger, options) {
    this.send = send;
    this.logger = logger ?? noopLogger;
    this.flushIntervalMs = options?.flushIntervalMs ?? 1500;
    this.maxBatchSize = options?.maxBatchSize ?? 4;
  }
  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------
  /** Start the periodic flush timer. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
    this.logger.debug("Batcher started", { flushIntervalMs: this.flushIntervalMs });
  }
  /** Stop the periodic flush timer without flushing. */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.debug("Batcher stopped");
  }
  /** Flush remaining buffer and stop. Safe to call multiple times. */
  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    await this.flush();
    this.logger.debug("Batcher destroyed");
  }
  /**
   * Enqueue a formatted event for batched sending.
   * Triggers an immediate capacity flush if buffer reaches maxBatchSize.
   */
  enqueue(formatted) {
    if (this.destroyed) return;
    this.buffer.push(formatted);
    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush();
    }
  }
  /**
   * Immediately send a high-priority event (e.g. blocker).
   * Flushes any pending buffer first, then sends the priority event alone.
   */
  async enqueueImmediate(formatted) {
    if (this.destroyed) return;
    await this.flush();
    await this.doSend([formatted]);
  }
  /** Current number of events in the buffer (for testing/diagnostics). */
  get pending() {
    return this.buffer.length;
  }
  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------
  /**
   * Flush the current buffer as a single Discord message.
   * Multiple embeds are combined into one send() call (Discord supports up to 10).
   * No-op if buffer is empty.
   */
  async flush() {
    if (this.buffer.length === 0) return;
    if (this.flushing) return;
    this.flushing = true;
    const batch = this.buffer.splice(0);
    try {
      await this.doSend(batch);
    } finally {
      this.flushing = false;
    }
  }
  /**
   * Build a SendPayload from a batch of FormattedEvents and invoke the send callback.
   * Catches and logs errors — never throws.
   *
   * For batched messages (2+ events), we send content-only to avoid duplication
   * between content text and embed descriptions, and to stay under Discord's
   * 10-embed limit. Single-event sends include the embed for rich formatting.
   */
  async doSend(batch) {
    if (batch.length === 0) return;
    const content = batch.map((e) => e.content).join("\n");
    const embeds = [];
    if (batch.length === 1 && batch[0].embed) {
      embeds.push(batch[0].embed);
    }
    let components = [];
    for (const e of batch) {
      if (e.components && e.components.length > 0) {
        components = e.components;
      }
    }
    const payload = { content, embeds, components };
    try {
      await this.send(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("Batcher send failed", { error: message, batchSize: batch.length });
      try {
        await new Promise((r) => setTimeout(r, 1e3));
        await this.send(payload);
        this.logger.debug("Batcher retry succeeded");
      } catch (retryErr) {
        const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
        this.logger.warn("Batcher retry also failed, dropping batch", {
          error: retryMessage,
          batchSize: batch.length
        });
      }
    }
  }
}
export {
  MessageBatcher
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvZGFlbW9uL3NyYy9tZXNzYWdlLWJhdGNoZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogbWVzc2FnZS1iYXRjaGVyLnRzIFx1MjAxNCBSYXRlLWxpbWl0LWF3YXJlIG1lc3NhZ2UgYmF0Y2hlciBmb3IgRGlzY29yZC5cbiAqXG4gKiBBY2N1bXVsYXRlcyBGb3JtYXR0ZWRFdmVudCBwYXlsb2FkcyBhbmQgZmx1c2hlcyB0aGVtIHRvIGEgRGlzY29yZCBjaGFubmVsXG4gKiByZXNwZWN0aW5nIHRoZSA1IG1zZy81cyByYXRlIGxpbWl0LiBTdXBwb3J0czpcbiAqICAgLSBUaW1lci1iYXNlZCBwZXJpb2RpYyBmbHVzaCAoZGVmYXVsdCAxLjVzKVxuICogICAtIENhcGFjaXR5LWJhc2VkIGZsdXNoIHdoZW4gYnVmZmVyIGhpdHMgbWF4QmF0Y2hTaXplXG4gKiAgIC0gSW1tZWRpYXRlIHByaW9yaXR5IGZsdXNoIGZvciBibG9ja2VycyAoYnlwYXNzZXMgYmF0Y2hpbmcpXG4gKiAgIC0gQ29tYmluaW5nIG11bHRpcGxlIGVtYmVkcyBpbnRvIGEgc2luZ2xlIHNlbmQoKSBjYWxsXG4gKiAgIC0gRXJyb3IgaXNvbGF0aW9uOiBzZW5kKCkgZmFpbHVyZXMgYXJlIGxvZ2dlZCwgbmV2ZXIgY3Jhc2ggdGhlIGJhdGNoZXJcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEZvcm1hdHRlZEV2ZW50IH0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVHlwZXNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogUGF5bG9hZCBwYXNzZWQgdG8gdGhlIHNlbmQgY2FsbGJhY2sgXHUyMDE0IG1hdGNoZXMgRGlzY29yZCBUZXh0Q2hhbm5lbC5zZW5kKCkgc2hhcGUuICovXG5leHBvcnQgaW50ZXJmYWNlIFNlbmRQYXlsb2FkIHtcbiAgY29udGVudDogc3RyaW5nO1xuICBlbWJlZHM6IHVua25vd25bXTtcbiAgY29tcG9uZW50czogdW5rbm93bltdO1xufVxuXG4vKiogU2VuZCBjYWxsYmFjayBhYnN0cmFjdGlvbi4gUmV0dXJucyB2b2lkIG9yIGEgcHJvbWlzZS4gKi9cbmV4cG9ydCB0eXBlIFNlbmRGbiA9IChwYXlsb2FkOiBTZW5kUGF5bG9hZCkgPT4gUHJvbWlzZTx2b2lkPiB8IHZvaWQ7XG5cbi8qKiBMb2dnZXIgaW50ZXJmYWNlIFx1MjAxNCBqdXN0IG5lZWRzIGVycm9yL3dhcm4vZGVidWcuICovXG5leHBvcnQgaW50ZXJmYWNlIEJhdGNoZXJMb2dnZXIge1xuICBlcnJvcihtc2c6IHN0cmluZywgZGF0YT86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogdm9pZDtcbiAgd2Fybihtc2c6IHN0cmluZywgZGF0YT86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogdm9pZDtcbiAgZGVidWcobXNnOiBzdHJpbmcsIGRhdGE/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHZvaWQ7XG59XG5cbi8qKiBNZXNzYWdlQmF0Y2hlciBjb25maWd1cmF0aW9uIG9wdGlvbnMuICovXG5leHBvcnQgaW50ZXJmYWNlIEJhdGNoZXJPcHRpb25zIHtcbiAgLyoqIEludGVydmFsIGJldHdlZW4gdGltZWQgZmx1c2hlcyBpbiBtcy4gRGVmYXVsdDogMTUwMCAqL1xuICBmbHVzaEludGVydmFsTXM/OiBudW1iZXI7XG4gIC8qKiBNYXggZXZlbnRzIGJlZm9yZSB0cmlnZ2VyaW5nIGFuIGltbWVkaWF0ZSBjYXBhY2l0eSBmbHVzaC4gRGVmYXVsdDogNCAqL1xuICBtYXhCYXRjaFNpemU/OiBudW1iZXI7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRGVmYXVsdCBuby1vcCBsb2dnZXJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5jb25zdCBub29wTG9nZ2VyOiBCYXRjaGVyTG9nZ2VyID0ge1xuICBlcnJvcigpIHt9LFxuICB3YXJuKCkge30sXG4gIGRlYnVnKCkge30sXG59O1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIE1lc3NhZ2VCYXRjaGVyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGNsYXNzIE1lc3NhZ2VCYXRjaGVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBzZW5kOiBTZW5kRm47XG4gIHByaXZhdGUgcmVhZG9ubHkgbG9nZ2VyOiBCYXRjaGVyTG9nZ2VyO1xuICBwcml2YXRlIHJlYWRvbmx5IGZsdXNoSW50ZXJ2YWxNczogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IG1heEJhdGNoU2l6ZTogbnVtYmVyO1xuXG4gIHByaXZhdGUgYnVmZmVyOiBGb3JtYXR0ZWRFdmVudFtdID0gW107XG4gIHByaXZhdGUgdGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGZsdXNoaW5nID0gZmFsc2U7XG4gIHByaXZhdGUgZGVzdHJveWVkID0gZmFsc2U7XG5cbiAgY29uc3RydWN0b3Ioc2VuZDogU2VuZEZuLCBsb2dnZXI/OiBCYXRjaGVyTG9nZ2VyLCBvcHRpb25zPzogQmF0Y2hlck9wdGlvbnMpIHtcbiAgICB0aGlzLnNlbmQgPSBzZW5kO1xuICAgIHRoaXMubG9nZ2VyID0gbG9nZ2VyID8/IG5vb3BMb2dnZXI7XG4gICAgdGhpcy5mbHVzaEludGVydmFsTXMgPSBvcHRpb25zPy5mbHVzaEludGVydmFsTXMgPz8gMTUwMDtcbiAgICB0aGlzLm1heEJhdGNoU2l6ZSA9IG9wdGlvbnM/Lm1heEJhdGNoU2l6ZSA/PyA0O1xuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gUHVibGljIEFQSVxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gIC8qKiBTdGFydCB0aGUgcGVyaW9kaWMgZmx1c2ggdGltZXIuICovXG4gIHN0YXJ0KCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnRpbWVyKSByZXR1cm47IC8vIGFscmVhZHkgcnVubmluZ1xuICAgIHRoaXMudGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICB2b2lkIHRoaXMuZmx1c2goKTtcbiAgICB9LCB0aGlzLmZsdXNoSW50ZXJ2YWxNcyk7XG4gICAgLy8gRG9uJ3QgaG9sZCB0aGUgcHJvY2VzcyBvcGVuIGZvciB0aGUgdGltZXJcbiAgICBpZiAodGhpcy50aW1lciAmJiB0eXBlb2YgdGhpcy50aW1lciA9PT0gJ29iamVjdCcgJiYgJ3VucmVmJyBpbiB0aGlzLnRpbWVyKSB7XG4gICAgICB0aGlzLnRpbWVyLnVucmVmKCk7XG4gICAgfVxuICAgIHRoaXMubG9nZ2VyLmRlYnVnKCdCYXRjaGVyIHN0YXJ0ZWQnLCB7IGZsdXNoSW50ZXJ2YWxNczogdGhpcy5mbHVzaEludGVydmFsTXMgfSk7XG4gIH1cblxuICAvKiogU3RvcCB0aGUgcGVyaW9kaWMgZmx1c2ggdGltZXIgd2l0aG91dCBmbHVzaGluZy4gKi9cbiAgc3RvcCgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy50aW1lcikge1xuICAgICAgY2xlYXJJbnRlcnZhbCh0aGlzLnRpbWVyKTtcbiAgICAgIHRoaXMudGltZXIgPSBudWxsO1xuICAgIH1cbiAgICB0aGlzLmxvZ2dlci5kZWJ1ZygnQmF0Y2hlciBzdG9wcGVkJyk7XG4gIH1cblxuICAvKiogRmx1c2ggcmVtYWluaW5nIGJ1ZmZlciBhbmQgc3RvcC4gU2FmZSB0byBjYWxsIG11bHRpcGxlIHRpbWVzLiAqL1xuICBhc3luYyBkZXN0cm95KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLmRlc3Ryb3llZCkgcmV0dXJuO1xuICAgIHRoaXMuZGVzdHJveWVkID0gdHJ1ZTtcbiAgICB0aGlzLnN0b3AoKTtcbiAgICBhd2FpdCB0aGlzLmZsdXNoKCk7XG4gICAgdGhpcy5sb2dnZXIuZGVidWcoJ0JhdGNoZXIgZGVzdHJveWVkJyk7XG4gIH1cblxuICAvKipcbiAgICogRW5xdWV1ZSBhIGZvcm1hdHRlZCBldmVudCBmb3IgYmF0Y2hlZCBzZW5kaW5nLlxuICAgKiBUcmlnZ2VycyBhbiBpbW1lZGlhdGUgY2FwYWNpdHkgZmx1c2ggaWYgYnVmZmVyIHJlYWNoZXMgbWF4QmF0Y2hTaXplLlxuICAgKi9cbiAgZW5xdWV1ZShmb3JtYXR0ZWQ6IEZvcm1hdHRlZEV2ZW50KTogdm9pZCB7XG4gICAgaWYgKHRoaXMuZGVzdHJveWVkKSByZXR1cm47XG4gICAgdGhpcy5idWZmZXIucHVzaChmb3JtYXR0ZWQpO1xuICAgIGlmICh0aGlzLmJ1ZmZlci5sZW5ndGggPj0gdGhpcy5tYXhCYXRjaFNpemUpIHtcbiAgICAgIHZvaWQgdGhpcy5mbHVzaCgpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBJbW1lZGlhdGVseSBzZW5kIGEgaGlnaC1wcmlvcml0eSBldmVudCAoZS5nLiBibG9ja2VyKS5cbiAgICogRmx1c2hlcyBhbnkgcGVuZGluZyBidWZmZXIgZmlyc3QsIHRoZW4gc2VuZHMgdGhlIHByaW9yaXR5IGV2ZW50IGFsb25lLlxuICAgKi9cbiAgYXN5bmMgZW5xdWV1ZUltbWVkaWF0ZShmb3JtYXR0ZWQ6IEZvcm1hdHRlZEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMuZGVzdHJveWVkKSByZXR1cm47XG4gICAgLy8gRmx1c2ggcGVuZGluZyBidWZmZXIgZmlyc3Qgc28gb3JkZXJpbmcgaXMgcHJlc2VydmVkXG4gICAgYXdhaXQgdGhpcy5mbHVzaCgpO1xuICAgIC8vIFNlbmQgdGhlIHByaW9yaXR5IGV2ZW50IGltbWVkaWF0ZWx5LCBhbG9uZVxuICAgIGF3YWl0IHRoaXMuZG9TZW5kKFtmb3JtYXR0ZWRdKTtcbiAgfVxuXG4gIC8qKiBDdXJyZW50IG51bWJlciBvZiBldmVudHMgaW4gdGhlIGJ1ZmZlciAoZm9yIHRlc3RpbmcvZGlhZ25vc3RpY3MpLiAqL1xuICBnZXQgcGVuZGluZygpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLmJ1ZmZlci5sZW5ndGg7XG4gIH1cblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBJbnRlcm5hbFxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gIC8qKlxuICAgKiBGbHVzaCB0aGUgY3VycmVudCBidWZmZXIgYXMgYSBzaW5nbGUgRGlzY29yZCBtZXNzYWdlLlxuICAgKiBNdWx0aXBsZSBlbWJlZHMgYXJlIGNvbWJpbmVkIGludG8gb25lIHNlbmQoKSBjYWxsIChEaXNjb3JkIHN1cHBvcnRzIHVwIHRvIDEwKS5cbiAgICogTm8tb3AgaWYgYnVmZmVyIGlzIGVtcHR5LlxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyBmbHVzaCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5idWZmZXIubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgaWYgKHRoaXMuZmx1c2hpbmcpIHJldHVybjsgLy8gcHJldmVudCByZS1lbnRyYW50IGZsdXNoXG5cbiAgICB0aGlzLmZsdXNoaW5nID0gdHJ1ZTtcbiAgICBjb25zdCBiYXRjaCA9IHRoaXMuYnVmZmVyLnNwbGljZSgwKTsgLy8gdGFrZSBhbGxcbiAgICB0cnkge1xuICAgICAgYXdhaXQgdGhpcy5kb1NlbmQoYmF0Y2gpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICB0aGlzLmZsdXNoaW5nID0gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEJ1aWxkIGEgU2VuZFBheWxvYWQgZnJvbSBhIGJhdGNoIG9mIEZvcm1hdHRlZEV2ZW50cyBhbmQgaW52b2tlIHRoZSBzZW5kIGNhbGxiYWNrLlxuICAgKiBDYXRjaGVzIGFuZCBsb2dzIGVycm9ycyBcdTIwMTQgbmV2ZXIgdGhyb3dzLlxuICAgKlxuICAgKiBGb3IgYmF0Y2hlZCBtZXNzYWdlcyAoMisgZXZlbnRzKSwgd2Ugc2VuZCBjb250ZW50LW9ubHkgdG8gYXZvaWQgZHVwbGljYXRpb25cbiAgICogYmV0d2VlbiBjb250ZW50IHRleHQgYW5kIGVtYmVkIGRlc2NyaXB0aW9ucywgYW5kIHRvIHN0YXkgdW5kZXIgRGlzY29yZCdzXG4gICAqIDEwLWVtYmVkIGxpbWl0LiBTaW5nbGUtZXZlbnQgc2VuZHMgaW5jbHVkZSB0aGUgZW1iZWQgZm9yIHJpY2ggZm9ybWF0dGluZy5cbiAgICovXG4gIHByaXZhdGUgYXN5bmMgZG9TZW5kKGJhdGNoOiBGb3JtYXR0ZWRFdmVudFtdKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKGJhdGNoLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuXG4gICAgLy8gQ29tYmluZSBjb250ZW50IGxpbmVzXG4gICAgY29uc3QgY29udGVudCA9IGJhdGNoLm1hcCgoZSkgPT4gZS5jb250ZW50KS5qb2luKCdcXG4nKTtcblxuICAgIC8vIEZvciBzaW5nbGUgZXZlbnRzLCBpbmNsdWRlIHRoZSBlbWJlZCBmb3IgcmljaCBmb3JtYXR0aW5nLlxuICAgIC8vIEZvciBiYXRjaGVzLCBza2lwIGVtYmVkcyBcdTIwMTQgdGhlIGNvbnRlbnQgbGluZXMgYXJlIHNlbGYtZGVzY3JpcHRpdmUgYW5kXG4gICAgLy8gZW1iZWRzIHdvdWxkIGR1cGxpY2F0ZSB0aGUgaW5mb3JtYXRpb24gKyByaXNrIGhpdHRpbmcgRGlzY29yZCdzIDEwLWVtYmVkIGNhcC5cbiAgICBjb25zdCBlbWJlZHM6IHVua25vd25bXSA9IFtdO1xuICAgIGlmIChiYXRjaC5sZW5ndGggPT09IDEgJiYgYmF0Y2hbMF0uZW1iZWQpIHtcbiAgICAgIGVtYmVkcy5wdXNoKGJhdGNoWzBdLmVtYmVkKTtcbiAgICB9XG5cbiAgICAvLyBDb2xsZWN0IGFsbCBjb21wb25lbnQgcm93cyAob25seSBmcm9tIHRoZSBsYXN0IGV2ZW50IHdpdGggY29tcG9uZW50cyBcdTIwMTRcbiAgICAvLyBEaXNjb3JkIG9ubHkgc3VwcG9ydHMgb25lIHNldCBvZiBjb21wb25lbnRzIHBlciBtZXNzYWdlKVxuICAgIGxldCBjb21wb25lbnRzOiB1bmtub3duW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgYmF0Y2gpIHtcbiAgICAgIGlmIChlLmNvbXBvbmVudHMgJiYgZS5jb21wb25lbnRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgY29tcG9uZW50cyA9IGUuY29tcG9uZW50cztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBwYXlsb2FkOiBTZW5kUGF5bG9hZCA9IHsgY29udGVudCwgZW1iZWRzLCBjb21wb25lbnRzIH07XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgdGhpcy5zZW5kKHBheWxvYWQpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKCdCYXRjaGVyIHNlbmQgZmFpbGVkJywgeyBlcnJvcjogbWVzc2FnZSwgYmF0Y2hTaXplOiBiYXRjaC5sZW5ndGggfSk7XG5cbiAgICAgIC8vIFJldHJ5IG9uY2UgYWZ0ZXIgYSBzaG9ydCBkZWxheVxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMTAwMCkpO1xuICAgICAgICBhd2FpdCB0aGlzLnNlbmQocGF5bG9hZCk7XG4gICAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKCdCYXRjaGVyIHJldHJ5IHN1Y2NlZWRlZCcpO1xuICAgICAgfSBjYXRjaCAocmV0cnlFcnIpIHtcbiAgICAgICAgY29uc3QgcmV0cnlNZXNzYWdlID0gcmV0cnlFcnIgaW5zdGFuY2VvZiBFcnJvciA/IHJldHJ5RXJyLm1lc3NhZ2UgOiBTdHJpbmcocmV0cnlFcnIpO1xuICAgICAgICB0aGlzLmxvZ2dlci53YXJuKCdCYXRjaGVyIHJldHJ5IGFsc28gZmFpbGVkLCBkcm9wcGluZyBiYXRjaCcsIHtcbiAgICAgICAgICBlcnJvcjogcmV0cnlNZXNzYWdlLFxuICAgICAgICAgIGJhdGNoU2l6ZTogYmF0Y2gubGVuZ3RoLFxuICAgICAgICB9KTtcbiAgICAgICAgLy8gRHJvcCB0aGUgYmF0Y2ggXHUyMDE0IGRvbid0IHJlLWVucXVldWUgdG8gcHJldmVudCBpbmZpbml0ZSBsb29wc1xuICAgICAgfVxuICAgIH1cbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBK0NBLE1BQU0sYUFBNEI7QUFBQSxFQUNoQyxRQUFRO0FBQUEsRUFBQztBQUFBLEVBQ1QsT0FBTztBQUFBLEVBQUM7QUFBQSxFQUNSLFFBQVE7QUFBQSxFQUFDO0FBQ1g7QUFNTyxNQUFNLGVBQWU7QUFBQSxFQUNUO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFFVCxTQUEyQixDQUFDO0FBQUEsRUFDNUIsUUFBK0M7QUFBQSxFQUMvQyxXQUFXO0FBQUEsRUFDWCxZQUFZO0FBQUEsRUFFcEIsWUFBWSxNQUFjLFFBQXdCLFNBQTBCO0FBQzFFLFNBQUssT0FBTztBQUNaLFNBQUssU0FBUyxVQUFVO0FBQ3hCLFNBQUssa0JBQWtCLFNBQVMsbUJBQW1CO0FBQ25E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
