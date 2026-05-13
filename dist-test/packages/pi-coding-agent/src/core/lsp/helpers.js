class ToolAbortError extends Error {
  constructor() {
    super("Tool execution aborted");
    this.name = "ToolAbortError";
  }
}
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new ToolAbortError();
  }
}
function isEnoent(err) {
  return err?.code === "ENOENT";
}
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function clampTimeout(timeout) {
  return Math.max(5, Math.min(60, timeout ?? 20));
}
async function untilAborted(signal, fn) {
  if (signal?.aborted) {
    throw new ToolAbortError();
  }
  if (!signal) {
    return fn();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new ToolAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    fn().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}
export {
  ToolAbortError,
  clampTimeout,
  isEnoent,
  isRecord,
  throwIfAborted,
  untilAborted
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2xzcC9oZWxwZXJzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIExvY2FsIGhlbHBlcnMgcmVwbGFjaW5nIEBvaC1teS1waS9waS11dGlscyBhbmQgdG9vbC1lcnJvcnMvdG9vbC10aW1lb3V0cyBpbXBvcnRzLlxuICovXG5cbmV4cG9ydCBjbGFzcyBUb29sQWJvcnRFcnJvciBleHRlbmRzIEVycm9yIHtcblx0Y29uc3RydWN0b3IoKSB7XG5cdFx0c3VwZXIoXCJUb29sIGV4ZWN1dGlvbiBhYm9ydGVkXCIpO1xuXHRcdHRoaXMubmFtZSA9IFwiVG9vbEFib3J0RXJyb3JcIjtcblx0fVxufVxuXG5leHBvcnQgZnVuY3Rpb24gdGhyb3dJZkFib3J0ZWQoc2lnbmFsPzogQWJvcnRTaWduYWwpOiB2b2lkIHtcblx0aWYgKHNpZ25hbD8uYWJvcnRlZCkge1xuXHRcdHRocm93IG5ldyBUb29sQWJvcnRFcnJvcigpO1xuXHR9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0Vub2VudChlcnI6IHVua25vd24pOiBib29sZWFuIHtcblx0cmV0dXJuIChlcnIgYXMgYW55KT8uY29kZSA9PT0gXCJFTk9FTlRcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzUmVjb3JkKHY6IHVua25vd24pOiB2IGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcblx0cmV0dXJuIHR5cGVvZiB2ID09PSBcIm9iamVjdFwiICYmIHYgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbGFtcFRpbWVvdXQodGltZW91dD86IG51bWJlcik6IG51bWJlciB7XG5cdHJldHVybiBNYXRoLm1heCg1LCBNYXRoLm1pbig2MCwgdGltZW91dCA/PyAyMCkpO1xufVxuXG4vKipcbiAqIFJ1biBhIHByb21pc2UsIHJlamVjdGluZyBpZiB0aGUgc2lnbmFsIGFib3J0cy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHVudGlsQWJvcnRlZDxUPihzaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkLCBmbjogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xuXHRpZiAoc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0dGhyb3cgbmV3IFRvb2xBYm9ydEVycm9yKCk7XG5cdH1cblx0aWYgKCFzaWduYWwpIHtcblx0XHRyZXR1cm4gZm4oKTtcblx0fVxuXHRyZXR1cm4gbmV3IFByb21pc2U8VD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdGNvbnN0IG9uQWJvcnQgPSAoKSA9PiByZWplY3QobmV3IFRvb2xBYm9ydEVycm9yKCkpO1xuXHRcdHNpZ25hbC5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCwgeyBvbmNlOiB0cnVlIH0pO1xuXHRcdGZuKCkudGhlbihcblx0XHRcdHJlc3VsdCA9PiB7XG5cdFx0XHRcdHNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCk7XG5cdFx0XHRcdHJlc29sdmUocmVzdWx0KTtcblx0XHRcdH0sXG5cdFx0XHRlcnIgPT4ge1xuXHRcdFx0XHRzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXHRcdFx0XHRyZWplY3QoZXJyKTtcblx0XHRcdH0sXG5cdFx0KTtcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFJTyxNQUFNLHVCQUF1QixNQUFNO0FBQUEsRUFDekMsY0FBYztBQUNiLFVBQU0sd0JBQXdCO0FBQzlCLFNBQUssT0FBTztBQUFBLEVBQ2I7QUFDRDtBQUVPLFNBQVMsZUFBZSxRQUE0QjtBQUMxRCxNQUFJLFFBQVEsU0FBUztBQUNwQixVQUFNLElBQUksZUFBZTtBQUFBLEVBQzFCO0FBQ0Q7QUFFTyxTQUFTLFNBQVMsS0FBdUI7QUFDL0MsU0FBUSxLQUFhLFNBQVM7QUFDL0I7QUFFTyxTQUFTLFNBQVMsR0FBMEM7QUFDbEUsU0FBTyxPQUFPLE1BQU0sWUFBWSxNQUFNLFFBQVEsQ0FBQyxNQUFNLFFBQVEsQ0FBQztBQUMvRDtBQUVPLFNBQVMsYUFBYSxTQUEwQjtBQUN0RCxTQUFPLEtBQUssSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLFdBQVcsRUFBRSxDQUFDO0FBQy9DO0FBS0EsZUFBc0IsYUFBZ0IsUUFBaUMsSUFBa0M7QUFDeEcsTUFBSSxRQUFRLFNBQVM7QUFDcEIsVUFBTSxJQUFJLGVBQWU7QUFBQSxFQUMxQjtBQUNBLE1BQUksQ0FBQyxRQUFRO0FBQ1osV0FBTyxHQUFHO0FBQUEsRUFDWDtBQUNBLFNBQU8sSUFBSSxRQUFXLENBQUMsU0FBUyxXQUFXO0FBQzFDLFVBQU0sVUFBVSxNQUFNLE9BQU8sSUFBSSxlQUFlLENBQUM7QUFDakQsV0FBTyxpQkFBaUIsU0FBUyxTQUFTLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFDeEQsT0FBRyxFQUFFO0FBQUEsTUFDSixZQUFVO0FBQ1QsZUFBTyxvQkFBb0IsU0FBUyxPQUFPO0FBQzNDLGdCQUFRLE1BQU07QUFBQSxNQUNmO0FBQUEsTUFDQSxTQUFPO0FBQ04sZUFBTyxvQkFBb0IsU0FBUyxPQUFPO0FBQzNDLGVBQU8sR0FBRztBQUFBLE1BQ1g7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBQ0Y7IiwKICAibmFtZXMiOiBbXQp9Cg==
