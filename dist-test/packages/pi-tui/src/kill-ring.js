class KillRing {
  constructor() {
    this.ring = [];
  }
  /**
   * Add text to the kill ring.
   *
   * @param text - The killed text to add
   * @param opts - Push options
   * @param opts.prepend - If accumulating, prepend (backward deletion) or append (forward deletion)
   * @param opts.accumulate - Merge with the most recent entry instead of creating a new one
   */
  push(text, opts) {
    if (!text) return;
    if (opts.accumulate && this.ring.length > 0) {
      const last = this.ring.pop();
      this.ring.push(opts.prepend ? text + last : last + text);
    } else {
      this.ring.push(text);
    }
  }
  /** Get most recent entry without modifying the ring. */
  peek() {
    return this.ring.length > 0 ? this.ring[this.ring.length - 1] : void 0;
  }
  /** Move last entry to front (for yank-pop cycling). */
  rotate() {
    if (this.ring.length > 1) {
      const last = this.ring.pop();
      this.ring.unshift(last);
    }
  }
  get length() {
    return this.ring.length;
  }
}
export {
  KillRing
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktdHVpL3NyYy9raWxsLXJpbmcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUmluZyBidWZmZXIgZm9yIEVtYWNzLXN0eWxlIGtpbGwveWFuayBvcGVyYXRpb25zLlxuICpcbiAqIFRyYWNrcyBraWxsZWQgKGRlbGV0ZWQpIHRleHQgZW50cmllcy4gQ29uc2VjdXRpdmUga2lsbHMgY2FuIGFjY3VtdWxhdGVcbiAqIGludG8gYSBzaW5nbGUgZW50cnkuIFN1cHBvcnRzIHlhbmsgKHBhc3RlIG1vc3QgcmVjZW50KSBhbmQgeWFuay1wb3BcbiAqIChjeWNsZSB0aHJvdWdoIG9sZGVyIGVudHJpZXMpLlxuICovXG5leHBvcnQgY2xhc3MgS2lsbFJpbmcge1xuXHRwcml2YXRlIHJpbmc6IHN0cmluZ1tdID0gW107XG5cblx0LyoqXG5cdCAqIEFkZCB0ZXh0IHRvIHRoZSBraWxsIHJpbmcuXG5cdCAqXG5cdCAqIEBwYXJhbSB0ZXh0IC0gVGhlIGtpbGxlZCB0ZXh0IHRvIGFkZFxuXHQgKiBAcGFyYW0gb3B0cyAtIFB1c2ggb3B0aW9uc1xuXHQgKiBAcGFyYW0gb3B0cy5wcmVwZW5kIC0gSWYgYWNjdW11bGF0aW5nLCBwcmVwZW5kIChiYWNrd2FyZCBkZWxldGlvbikgb3IgYXBwZW5kIChmb3J3YXJkIGRlbGV0aW9uKVxuXHQgKiBAcGFyYW0gb3B0cy5hY2N1bXVsYXRlIC0gTWVyZ2Ugd2l0aCB0aGUgbW9zdCByZWNlbnQgZW50cnkgaW5zdGVhZCBvZiBjcmVhdGluZyBhIG5ldyBvbmVcblx0ICovXG5cdHB1c2godGV4dDogc3RyaW5nLCBvcHRzOiB7IHByZXBlbmQ6IGJvb2xlYW47IGFjY3VtdWxhdGU/OiBib29sZWFuIH0pOiB2b2lkIHtcblx0XHRpZiAoIXRleHQpIHJldHVybjtcblxuXHRcdGlmIChvcHRzLmFjY3VtdWxhdGUgJiYgdGhpcy5yaW5nLmxlbmd0aCA+IDApIHtcblx0XHRcdGNvbnN0IGxhc3QgPSB0aGlzLnJpbmcucG9wKCkhO1xuXHRcdFx0dGhpcy5yaW5nLnB1c2gob3B0cy5wcmVwZW5kID8gdGV4dCArIGxhc3QgOiBsYXN0ICsgdGV4dCk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHRoaXMucmluZy5wdXNoKHRleHQpO1xuXHRcdH1cblx0fVxuXG5cdC8qKiBHZXQgbW9zdCByZWNlbnQgZW50cnkgd2l0aG91dCBtb2RpZnlpbmcgdGhlIHJpbmcuICovXG5cdHBlZWsoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0XHRyZXR1cm4gdGhpcy5yaW5nLmxlbmd0aCA+IDAgPyB0aGlzLnJpbmdbdGhpcy5yaW5nLmxlbmd0aCAtIDFdIDogdW5kZWZpbmVkO1xuXHR9XG5cblx0LyoqIE1vdmUgbGFzdCBlbnRyeSB0byBmcm9udCAoZm9yIHlhbmstcG9wIGN5Y2xpbmcpLiAqL1xuXHRyb3RhdGUoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMucmluZy5sZW5ndGggPiAxKSB7XG5cdFx0XHRjb25zdCBsYXN0ID0gdGhpcy5yaW5nLnBvcCgpITtcblx0XHRcdHRoaXMucmluZy51bnNoaWZ0KGxhc3QpO1xuXHRcdH1cblx0fVxuXG5cdGdldCBsZW5ndGgoKTogbnVtYmVyIHtcblx0XHRyZXR1cm4gdGhpcy5yaW5nLmxlbmd0aDtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBT08sTUFBTSxTQUFTO0FBQUEsRUFBZjtBQUNOLFNBQVEsT0FBaUIsQ0FBQztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBVTFCLEtBQUssTUFBYyxNQUF3RDtBQUMxRSxRQUFJLENBQUMsS0FBTTtBQUVYLFFBQUksS0FBSyxjQUFjLEtBQUssS0FBSyxTQUFTLEdBQUc7QUFDNUMsWUFBTSxPQUFPLEtBQUssS0FBSyxJQUFJO0FBQzNCLFdBQUssS0FBSyxLQUFLLEtBQUssVUFBVSxPQUFPLE9BQU8sT0FBTyxJQUFJO0FBQUEsSUFDeEQsT0FBTztBQUNOLFdBQUssS0FBSyxLQUFLLElBQUk7QUFBQSxJQUNwQjtBQUFBLEVBQ0Q7QUFBQTtBQUFBLEVBR0EsT0FBMkI7QUFDMUIsV0FBTyxLQUFLLEtBQUssU0FBUyxJQUFJLEtBQUssS0FBSyxLQUFLLEtBQUssU0FBUyxDQUFDLElBQUk7QUFBQSxFQUNqRTtBQUFBO0FBQUEsRUFHQSxTQUFlO0FBQ2QsUUFBSSxLQUFLLEtBQUssU0FBUyxHQUFHO0FBQ3pCLFlBQU0sT0FBTyxLQUFLLEtBQUssSUFBSTtBQUMzQixXQUFLLEtBQUssUUFBUSxJQUFJO0FBQUEsSUFDdkI7QUFBQSxFQUNEO0FBQUEsRUFFQSxJQUFJLFNBQWlCO0FBQ3BCLFdBQU8sS0FBSyxLQUFLO0FBQUEsRUFDbEI7QUFDRDsiLAogICJuYW1lcyI6IFtdCn0K
