class EventStream {
  constructor(isComplete, extractResult) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.queue = [];
    this.waiting = [];
    this.done = false;
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }
  push(event) {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }
  end(result) {
    this.done = true;
    if (result !== void 0) {
      this.resolveFinalResult(result);
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter({ value: void 0, done: true });
    }
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift();
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise((resolve) => this.waiting.push(resolve));
        if (result.done) return;
        yield result.value;
      }
    }
  }
  result() {
    return this.finalResultPromise;
  }
}
class AssistantMessageEventStream extends EventStream {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") {
          return event.message;
        } else if (event.type === "error") {
          return event.error;
        }
        throw new Error("Unexpected event type for final result");
      }
    );
  }
}
function createAssistantMessageEventStream() {
  return new AssistantMessageEventStream();
}
export {
  AssistantMessageEventStream,
  EventStream,
  createAssistantMessageEventStream
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3V0aWxzL2V2ZW50LXN0cmVhbS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBBc3Npc3RhbnRNZXNzYWdlLCBBc3Npc3RhbnRNZXNzYWdlRXZlbnQgfSBmcm9tIFwiLi4vdHlwZXMuanNcIjtcblxuLy8gR2VuZXJpYyBldmVudCBzdHJlYW0gY2xhc3MgZm9yIGFzeW5jIGl0ZXJhdGlvblxuZXhwb3J0IGNsYXNzIEV2ZW50U3RyZWFtPFQsIFIgPSBUPiBpbXBsZW1lbnRzIEFzeW5jSXRlcmFibGU8VD4ge1xuXHRwcml2YXRlIHF1ZXVlOiBUW10gPSBbXTtcblx0cHJpdmF0ZSB3YWl0aW5nOiAoKHZhbHVlOiBJdGVyYXRvclJlc3VsdDxUPikgPT4gdm9pZClbXSA9IFtdO1xuXHRwcml2YXRlIGRvbmUgPSBmYWxzZTtcblx0cHJpdmF0ZSBmaW5hbFJlc3VsdFByb21pc2U6IFByb21pc2U8Uj47XG5cdHByaXZhdGUgcmVzb2x2ZUZpbmFsUmVzdWx0ITogKHJlc3VsdDogUikgPT4gdm9pZDtcblxuXHRjb25zdHJ1Y3Rvcihcblx0XHRwcml2YXRlIGlzQ29tcGxldGU6IChldmVudDogVCkgPT4gYm9vbGVhbixcblx0XHRwcml2YXRlIGV4dHJhY3RSZXN1bHQ6IChldmVudDogVCkgPT4gUixcblx0KSB7XG5cdFx0dGhpcy5maW5hbFJlc3VsdFByb21pc2UgPSBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuXHRcdFx0dGhpcy5yZXNvbHZlRmluYWxSZXN1bHQgPSByZXNvbHZlO1xuXHRcdH0pO1xuXHR9XG5cblx0cHVzaChldmVudDogVCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLmRvbmUpIHJldHVybjtcblxuXHRcdGlmICh0aGlzLmlzQ29tcGxldGUoZXZlbnQpKSB7XG5cdFx0XHR0aGlzLmRvbmUgPSB0cnVlO1xuXHRcdFx0dGhpcy5yZXNvbHZlRmluYWxSZXN1bHQodGhpcy5leHRyYWN0UmVzdWx0KGV2ZW50KSk7XG5cdFx0fVxuXG5cdFx0Ly8gRGVsaXZlciB0byB3YWl0aW5nIGNvbnN1bWVyIG9yIHF1ZXVlIGl0XG5cdFx0Y29uc3Qgd2FpdGVyID0gdGhpcy53YWl0aW5nLnNoaWZ0KCk7XG5cdFx0aWYgKHdhaXRlcikge1xuXHRcdFx0d2FpdGVyKHsgdmFsdWU6IGV2ZW50LCBkb25lOiBmYWxzZSB9KTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5xdWV1ZS5wdXNoKGV2ZW50KTtcblx0XHR9XG5cdH1cblxuXHRlbmQocmVzdWx0PzogUik6IHZvaWQge1xuXHRcdHRoaXMuZG9uZSA9IHRydWU7XG5cdFx0aWYgKHJlc3VsdCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHR0aGlzLnJlc29sdmVGaW5hbFJlc3VsdChyZXN1bHQpO1xuXHRcdH1cblx0XHQvLyBOb3RpZnkgYWxsIHdhaXRpbmcgY29uc3VtZXJzIHRoYXQgd2UncmUgZG9uZVxuXHRcdHdoaWxlICh0aGlzLndhaXRpbmcubGVuZ3RoID4gMCkge1xuXHRcdFx0Y29uc3Qgd2FpdGVyID0gdGhpcy53YWl0aW5nLnNoaWZ0KCkhO1xuXHRcdFx0d2FpdGVyKHsgdmFsdWU6IHVuZGVmaW5lZCBhcyBhbnksIGRvbmU6IHRydWUgfSk7XG5cdFx0fVxuXHR9XG5cblx0YXN5bmMgKltTeW1ib2wuYXN5bmNJdGVyYXRvcl0oKTogQXN5bmNJdGVyYXRvcjxUPiB7XG5cdFx0d2hpbGUgKHRydWUpIHtcblx0XHRcdGlmICh0aGlzLnF1ZXVlLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0eWllbGQgdGhpcy5xdWV1ZS5zaGlmdCgpITtcblx0XHRcdH0gZWxzZSBpZiAodGhpcy5kb25lKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IG5ldyBQcm9taXNlPEl0ZXJhdG9yUmVzdWx0PFQ+PigocmVzb2x2ZSkgPT4gdGhpcy53YWl0aW5nLnB1c2gocmVzb2x2ZSkpO1xuXHRcdFx0XHRpZiAocmVzdWx0LmRvbmUpIHJldHVybjtcblx0XHRcdFx0eWllbGQgcmVzdWx0LnZhbHVlO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHJlc3VsdCgpOiBQcm9taXNlPFI+IHtcblx0XHRyZXR1cm4gdGhpcy5maW5hbFJlc3VsdFByb21pc2U7XG5cdH1cbn1cblxuZXhwb3J0IGNsYXNzIEFzc2lzdGFudE1lc3NhZ2VFdmVudFN0cmVhbSBleHRlbmRzIEV2ZW50U3RyZWFtPEFzc2lzdGFudE1lc3NhZ2VFdmVudCwgQXNzaXN0YW50TWVzc2FnZT4ge1xuXHRjb25zdHJ1Y3RvcigpIHtcblx0XHRzdXBlcihcblx0XHRcdChldmVudCkgPT4gZXZlbnQudHlwZSA9PT0gXCJkb25lXCIgfHwgZXZlbnQudHlwZSA9PT0gXCJlcnJvclwiLFxuXHRcdFx0KGV2ZW50KSA9PiB7XG5cdFx0XHRcdGlmIChldmVudC50eXBlID09PSBcImRvbmVcIikge1xuXHRcdFx0XHRcdHJldHVybiBldmVudC5tZXNzYWdlO1xuXHRcdFx0XHR9IGVsc2UgaWYgKGV2ZW50LnR5cGUgPT09IFwiZXJyb3JcIikge1xuXHRcdFx0XHRcdHJldHVybiBldmVudC5lcnJvcjtcblx0XHRcdFx0fVxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJVbmV4cGVjdGVkIGV2ZW50IHR5cGUgZm9yIGZpbmFsIHJlc3VsdFwiKTtcblx0XHRcdH0sXG5cdFx0KTtcblx0fVxufVxuXG4vKiogRmFjdG9yeSBmdW5jdGlvbiBmb3IgQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtIChmb3IgdXNlIGJ5IHBhY2thZ2UgY29uc3VtZXJzKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0oKTogQXNzaXN0YW50TWVzc2FnZUV2ZW50U3RyZWFtIHtcblx0cmV0dXJuIG5ldyBBc3Npc3RhbnRNZXNzYWdlRXZlbnRTdHJlYW0oKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUdPLE1BQU0sWUFBa0Q7QUFBQSxFQU85RCxZQUNTLFlBQ0EsZUFDUDtBQUZPO0FBQ0E7QUFSVCxTQUFRLFFBQWEsQ0FBQztBQUN0QixTQUFRLFVBQWtELENBQUM7QUFDM0QsU0FBUSxPQUFPO0FBUWQsU0FBSyxxQkFBcUIsSUFBSSxRQUFRLENBQUMsWUFBWTtBQUNsRCxXQUFLLHFCQUFxQjtBQUFBLElBQzNCLENBQUM7QUFBQSxFQUNGO0FBQUEsRUFFQSxLQUFLLE9BQWdCO0FBQ3BCLFFBQUksS0FBSyxLQUFNO0FBRWYsUUFBSSxLQUFLLFdBQVcsS0FBSyxHQUFHO0FBQzNCLFdBQUssT0FBTztBQUNaLFdBQUssbUJBQW1CLEtBQUssY0FBYyxLQUFLLENBQUM7QUFBQSxJQUNsRDtBQUdBLFVBQU0sU0FBUyxLQUFLLFFBQVEsTUFBTTtBQUNsQyxRQUFJLFFBQVE7QUFDWCxhQUFPLEVBQUUsT0FBTyxPQUFPLE1BQU0sTUFBTSxDQUFDO0FBQUEsSUFDckMsT0FBTztBQUNOLFdBQUssTUFBTSxLQUFLLEtBQUs7QUFBQSxJQUN0QjtBQUFBLEVBQ0Q7QUFBQSxFQUVBLElBQUksUUFBa0I7QUFDckIsU0FBSyxPQUFPO0FBQ1osUUFBSSxXQUFXLFFBQVc7QUFDekIsV0FBSyxtQkFBbUIsTUFBTTtBQUFBLElBQy9CO0FBRUEsV0FBTyxLQUFLLFFBQVEsU0FBUyxHQUFHO0FBQy9CLFlBQU0sU0FBUyxLQUFLLFFBQVEsTUFBTTtBQUNsQyxhQUFPLEVBQUUsT0FBTyxRQUFrQixNQUFNLEtBQUssQ0FBQztBQUFBLElBQy9DO0FBQUEsRUFDRDtBQUFBLEVBRUEsUUFBUSxPQUFPLGFBQWEsSUFBc0I7QUFDakQsV0FBTyxNQUFNO0FBQ1osVUFBSSxLQUFLLE1BQU0sU0FBUyxHQUFHO0FBQzFCLGNBQU0sS0FBSyxNQUFNLE1BQU07QUFBQSxNQUN4QixXQUFXLEtBQUssTUFBTTtBQUNyQjtBQUFBLE1BQ0QsT0FBTztBQUNOLGNBQU0sU0FBUyxNQUFNLElBQUksUUFBMkIsQ0FBQyxZQUFZLEtBQUssUUFBUSxLQUFLLE9BQU8sQ0FBQztBQUMzRixZQUFJLE9BQU8sS0FBTTtBQUNqQixjQUFNLE9BQU87QUFBQSxNQUNkO0FBQUEsSUFDRDtBQUFBLEVBQ0Q7QUFBQSxFQUVBLFNBQXFCO0FBQ3BCLFdBQU8sS0FBSztBQUFBLEVBQ2I7QUFDRDtBQUVPLE1BQU0sb0NBQW9DLFlBQXFEO0FBQUEsRUFDckcsY0FBYztBQUNiO0FBQUEsTUFDQyxDQUFDLFVBQVUsTUFBTSxTQUFTLFVBQVUsTUFBTSxTQUFTO0FBQUEsTUFDbkQsQ0FBQyxVQUFVO0FBQ1YsWUFBSSxNQUFNLFNBQVMsUUFBUTtBQUMxQixpQkFBTyxNQUFNO0FBQUEsUUFDZCxXQUFXLE1BQU0sU0FBUyxTQUFTO0FBQ2xDLGlCQUFPLE1BQU07QUFBQSxRQUNkO0FBQ0EsY0FBTSxJQUFJLE1BQU0sd0NBQXdDO0FBQUEsTUFDekQ7QUFBQSxJQUNEO0FBQUEsRUFDRDtBQUNEO0FBR08sU0FBUyxvQ0FBaUU7QUFDaEYsU0FBTyxJQUFJLDRCQUE0QjtBQUN4QzsiLAogICJuYW1lcyI6IFtdCn0K
