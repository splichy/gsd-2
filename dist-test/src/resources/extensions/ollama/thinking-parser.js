const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";
const MAX_TAG_LEN = Math.max(OPEN_TAG.length, CLOSE_TAG.length);
class ThinkingTagParser {
  buffer = "";
  inThinking = false;
  /**
   * Feed a chunk of text and get back parsed segments.
   * May return zero or more segments depending on tag boundaries.
   */
  push(chunk) {
    const results = [];
    let input = this.buffer + chunk;
    this.buffer = "";
    while (input.length > 0) {
      if (this.inThinking) {
        const closeIdx = input.indexOf(CLOSE_TAG);
        if (closeIdx !== -1) {
          const thinking = input.slice(0, closeIdx);
          if (thinking) results.push({ type: "thinking", text: thinking });
          this.inThinking = false;
          input = input.slice(closeIdx + CLOSE_TAG.length);
        } else if (this.couldBePartialTag(input, CLOSE_TAG)) {
          const tailLen = this.getPartialTagTailLength(input, CLOSE_TAG);
          const safe = input.slice(0, input.length - tailLen);
          if (safe) results.push({ type: "thinking", text: safe });
          this.buffer = input.slice(-tailLen);
          break;
        } else {
          results.push({ type: "thinking", text: input });
          break;
        }
      } else {
        const openIdx = input.indexOf(OPEN_TAG);
        if (openIdx !== -1) {
          const text = input.slice(0, openIdx);
          if (text) results.push({ type: "text", text });
          this.inThinking = true;
          input = input.slice(openIdx + OPEN_TAG.length);
        } else if (this.couldBePartialTag(input, OPEN_TAG)) {
          const tailLen = this.getPartialTagTailLength(input, OPEN_TAG);
          const safe = input.slice(0, input.length - tailLen);
          if (safe) results.push({ type: "text", text: safe });
          this.buffer = input.slice(-tailLen);
          break;
        } else {
          results.push({ type: "text", text: input });
          break;
        }
      }
    }
    return results;
  }
  /**
   * Flush any remaining buffered content. Call at end of stream.
   */
  flush() {
    if (!this.buffer) return [];
    const result = {
      type: this.inThinking ? "thinking" : "text",
      text: this.buffer
    };
    this.buffer = "";
    return [result];
  }
  /**
   * Check if the end of input could be the start of a partial tag.
   * Only buffers when the tail of input matches a prefix of the tag.
   */
  couldBePartialTag(input, tag) {
    return this.getPartialTagTailLength(input, tag) > 0;
  }
  /**
   * Get the length of the tail of input that matches a prefix of the tag.
   * Returns 0 if no partial match.
   */
  getPartialTagTailLength(input, tag) {
    const maxCheck = Math.min(input.length, tag.length - 1);
    for (let len = maxCheck; len >= 1; len--) {
      const tail = input.slice(-len);
      if (tag.startsWith(tail)) {
        return len;
      }
    }
    return 0;
  }
}
export {
  ThinkingTagParser
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL29sbGFtYS90aGlua2luZy1wYXJzZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRDIgXHUyMDE0IE9sbGFtYSBFeHRlbnNpb246IFN0YXRlZnVsIDx0aGluaz4gdGFnIHN0cmVhbSBwYXJzZXJcblxuLyoqXG4gKiBFeHRyYWN0cyA8dGhpbms+Li4uPC90aGluaz4gdGhpbmtpbmcgYmxvY2tzIGZyb20gYSBzdHJlYW1pbmcgdGV4dCByZXNwb25zZS5cbiAqIEhhbmRsZXMgdGhlIGNhc2Ugd2hlcmUgdGFnIGJvdW5kYXJpZXMgc3BhbiBtdWx0aXBsZSBjaHVua3MgYnkgYnVmZmVyaW5nXG4gKiB1cCB0byA4IGNoYXJhY3RlcnMgKGxlbmd0aCBvZiBcIjwvdGhpbms+XCIpIGF0IGNodW5rIGJvdW5kYXJpZXMuXG4gKlxuICogVXNlZCBmb3IgcmVhc29uaW5nIG1vZGVscyBsaWtlIGRlZXBzZWVrLXIxIGFuZCBxd3EgdGhhdCBlbWJlZCB0aGlua2luZ1xuICogaW5saW5lIGluIHRoZWlyIHRleHQgb3V0cHV0LlxuICovXG5cbmV4cG9ydCB0eXBlIFBhcnNlZENodW5rID1cblx0fCB7IHR5cGU6IFwidGhpbmtpbmdcIjsgdGV4dDogc3RyaW5nIH1cblx0fCB7IHR5cGU6IFwidGV4dFwiOyB0ZXh0OiBzdHJpbmcgfTtcblxuY29uc3QgT1BFTl9UQUcgPSBcIjx0aGluaz5cIjtcbmNvbnN0IENMT1NFX1RBRyA9IFwiPC90aGluaz5cIjtcbmNvbnN0IE1BWF9UQUdfTEVOID0gTWF0aC5tYXgoT1BFTl9UQUcubGVuZ3RoLCBDTE9TRV9UQUcubGVuZ3RoKTtcblxuZXhwb3J0IGNsYXNzIFRoaW5raW5nVGFnUGFyc2VyIHtcblx0cHJpdmF0ZSBidWZmZXIgPSBcIlwiO1xuXHRwcml2YXRlIGluVGhpbmtpbmcgPSBmYWxzZTtcblxuXHQvKipcblx0ICogRmVlZCBhIGNodW5rIG9mIHRleHQgYW5kIGdldCBiYWNrIHBhcnNlZCBzZWdtZW50cy5cblx0ICogTWF5IHJldHVybiB6ZXJvIG9yIG1vcmUgc2VnbWVudHMgZGVwZW5kaW5nIG9uIHRhZyBib3VuZGFyaWVzLlxuXHQgKi9cblx0cHVzaChjaHVuazogc3RyaW5nKTogUGFyc2VkQ2h1bmtbXSB7XG5cdFx0Y29uc3QgcmVzdWx0czogUGFyc2VkQ2h1bmtbXSA9IFtdO1xuXHRcdGxldCBpbnB1dCA9IHRoaXMuYnVmZmVyICsgY2h1bms7XG5cdFx0dGhpcy5idWZmZXIgPSBcIlwiO1xuXG5cdFx0d2hpbGUgKGlucHV0Lmxlbmd0aCA+IDApIHtcblx0XHRcdGlmICh0aGlzLmluVGhpbmtpbmcpIHtcblx0XHRcdFx0Y29uc3QgY2xvc2VJZHggPSBpbnB1dC5pbmRleE9mKENMT1NFX1RBRyk7XG5cdFx0XHRcdGlmIChjbG9zZUlkeCAhPT0gLTEpIHtcblx0XHRcdFx0XHQvLyBGb3VuZCBjbG9zZSB0YWcgXHUyMDE0IGVtaXQgdGhpbmtpbmcgY29udGVudCBiZWZvcmUgaXRcblx0XHRcdFx0XHRjb25zdCB0aGlua2luZyA9IGlucHV0LnNsaWNlKDAsIGNsb3NlSWR4KTtcblx0XHRcdFx0XHRpZiAodGhpbmtpbmcpIHJlc3VsdHMucHVzaCh7IHR5cGU6IFwidGhpbmtpbmdcIiwgdGV4dDogdGhpbmtpbmcgfSk7XG5cdFx0XHRcdFx0dGhpcy5pblRoaW5raW5nID0gZmFsc2U7XG5cdFx0XHRcdFx0aW5wdXQgPSBpbnB1dC5zbGljZShjbG9zZUlkeCArIENMT1NFX1RBRy5sZW5ndGgpO1xuXHRcdFx0XHR9IGVsc2UgaWYgKHRoaXMuY291bGRCZVBhcnRpYWxUYWcoaW5wdXQsIENMT1NFX1RBRykpIHtcblx0XHRcdFx0XHQvLyBQb3NzaWJsZSBwYXJ0aWFsIGNsb3NlIHRhZyBhdCBlbmQgXHUyMDE0IGJ1ZmZlciBvbmx5IHRoZSBtYXRjaGluZyB0YWlsXG5cdFx0XHRcdFx0Y29uc3QgdGFpbExlbiA9IHRoaXMuZ2V0UGFydGlhbFRhZ1RhaWxMZW5ndGgoaW5wdXQsIENMT1NFX1RBRyk7XG5cdFx0XHRcdFx0Y29uc3Qgc2FmZSA9IGlucHV0LnNsaWNlKDAsIGlucHV0Lmxlbmd0aCAtIHRhaWxMZW4pO1xuXHRcdFx0XHRcdGlmIChzYWZlKSByZXN1bHRzLnB1c2goeyB0eXBlOiBcInRoaW5raW5nXCIsIHRleHQ6IHNhZmUgfSk7XG5cdFx0XHRcdFx0dGhpcy5idWZmZXIgPSBpbnB1dC5zbGljZSgtdGFpbExlbik7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0Ly8gTm8gY2xvc2UgdGFnIFx1MjAxNCBlbWl0IGFsbCBhcyB0aGlua2luZ1xuXHRcdFx0XHRcdHJlc3VsdHMucHVzaCh7IHR5cGU6IFwidGhpbmtpbmdcIiwgdGV4dDogaW5wdXQgfSk7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGNvbnN0IG9wZW5JZHggPSBpbnB1dC5pbmRleE9mKE9QRU5fVEFHKTtcblx0XHRcdFx0aWYgKG9wZW5JZHggIT09IC0xKSB7XG5cdFx0XHRcdFx0Ly8gRm91bmQgb3BlbiB0YWcgXHUyMDE0IGVtaXQgdGV4dCBiZWZvcmUgaXRcblx0XHRcdFx0XHRjb25zdCB0ZXh0ID0gaW5wdXQuc2xpY2UoMCwgb3BlbklkeCk7XG5cdFx0XHRcdFx0aWYgKHRleHQpIHJlc3VsdHMucHVzaCh7IHR5cGU6IFwidGV4dFwiLCB0ZXh0IH0pO1xuXHRcdFx0XHRcdHRoaXMuaW5UaGlua2luZyA9IHRydWU7XG5cdFx0XHRcdFx0aW5wdXQgPSBpbnB1dC5zbGljZShvcGVuSWR4ICsgT1BFTl9UQUcubGVuZ3RoKTtcblx0XHRcdFx0fSBlbHNlIGlmICh0aGlzLmNvdWxkQmVQYXJ0aWFsVGFnKGlucHV0LCBPUEVOX1RBRykpIHtcblx0XHRcdFx0XHQvLyBQb3NzaWJsZSBwYXJ0aWFsIG9wZW4gdGFnIGF0IGVuZCBcdTIwMTQgYnVmZmVyIG9ubHkgdGhlIG1hdGNoaW5nIHRhaWxcblx0XHRcdFx0XHRjb25zdCB0YWlsTGVuID0gdGhpcy5nZXRQYXJ0aWFsVGFnVGFpbExlbmd0aChpbnB1dCwgT1BFTl9UQUcpO1xuXHRcdFx0XHRcdGNvbnN0IHNhZmUgPSBpbnB1dC5zbGljZSgwLCBpbnB1dC5sZW5ndGggLSB0YWlsTGVuKTtcblx0XHRcdFx0XHRpZiAoc2FmZSkgcmVzdWx0cy5wdXNoKHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IHNhZmUgfSk7XG5cdFx0XHRcdFx0dGhpcy5idWZmZXIgPSBpbnB1dC5zbGljZSgtdGFpbExlbik7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0Ly8gTm8gb3BlbiB0YWcgXHUyMDE0IGVtaXQgYWxsIGFzIHRleHRcblx0XHRcdFx0XHRyZXN1bHRzLnB1c2goeyB0eXBlOiBcInRleHRcIiwgdGV4dDogaW5wdXQgfSk7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHRyZXR1cm4gcmVzdWx0cztcblx0fVxuXG5cdC8qKlxuXHQgKiBGbHVzaCBhbnkgcmVtYWluaW5nIGJ1ZmZlcmVkIGNvbnRlbnQuIENhbGwgYXQgZW5kIG9mIHN0cmVhbS5cblx0ICovXG5cdGZsdXNoKCk6IFBhcnNlZENodW5rW10ge1xuXHRcdGlmICghdGhpcy5idWZmZXIpIHJldHVybiBbXTtcblxuXHRcdGNvbnN0IHJlc3VsdDogUGFyc2VkQ2h1bmsgPSB7XG5cdFx0XHR0eXBlOiB0aGlzLmluVGhpbmtpbmcgPyBcInRoaW5raW5nXCIgOiBcInRleHRcIixcblx0XHRcdHRleHQ6IHRoaXMuYnVmZmVyLFxuXHRcdH07XG5cdFx0dGhpcy5idWZmZXIgPSBcIlwiO1xuXHRcdHJldHVybiBbcmVzdWx0XTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDaGVjayBpZiB0aGUgZW5kIG9mIGlucHV0IGNvdWxkIGJlIHRoZSBzdGFydCBvZiBhIHBhcnRpYWwgdGFnLlxuXHQgKiBPbmx5IGJ1ZmZlcnMgd2hlbiB0aGUgdGFpbCBvZiBpbnB1dCBtYXRjaGVzIGEgcHJlZml4IG9mIHRoZSB0YWcuXG5cdCAqL1xuXHRwcml2YXRlIGNvdWxkQmVQYXJ0aWFsVGFnKGlucHV0OiBzdHJpbmcsIHRhZzogc3RyaW5nKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuZ2V0UGFydGlhbFRhZ1RhaWxMZW5ndGgoaW5wdXQsIHRhZykgPiAwO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCB0aGUgbGVuZ3RoIG9mIHRoZSB0YWlsIG9mIGlucHV0IHRoYXQgbWF0Y2hlcyBhIHByZWZpeCBvZiB0aGUgdGFnLlxuXHQgKiBSZXR1cm5zIDAgaWYgbm8gcGFydGlhbCBtYXRjaC5cblx0ICovXG5cdHByaXZhdGUgZ2V0UGFydGlhbFRhZ1RhaWxMZW5ndGgoaW5wdXQ6IHN0cmluZywgdGFnOiBzdHJpbmcpOiBudW1iZXIge1xuXHRcdGNvbnN0IG1heENoZWNrID0gTWF0aC5taW4oaW5wdXQubGVuZ3RoLCB0YWcubGVuZ3RoIC0gMSk7XG5cdFx0Zm9yIChsZXQgbGVuID0gbWF4Q2hlY2s7IGxlbiA+PSAxOyBsZW4tLSkge1xuXHRcdFx0Y29uc3QgdGFpbCA9IGlucHV0LnNsaWNlKC1sZW4pO1xuXHRcdFx0aWYgKHRhZy5zdGFydHNXaXRoKHRhaWwpKSB7XG5cdFx0XHRcdHJldHVybiBsZW47XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHJldHVybiAwO1xuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFlQSxNQUFNLFdBQVc7QUFDakIsTUFBTSxZQUFZO0FBQ2xCLE1BQU0sY0FBYyxLQUFLLElBQUksU0FBUyxRQUFRLFVBQVUsTUFBTTtBQUV2RCxNQUFNLGtCQUFrQjtBQUFBLEVBQ3RCLFNBQVM7QUFBQSxFQUNULGFBQWE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBTXJCLEtBQUssT0FBOEI7QUFDbEMsVUFBTSxVQUF5QixDQUFDO0FBQ2hDLFFBQUksUUFBUSxLQUFLLFNBQVM7QUFDMUIsU0FBSyxTQUFTO0FBRWQsV0FBTyxNQUFNLFNBQVMs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
