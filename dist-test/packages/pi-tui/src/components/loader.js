import { Text } from "./text.js";
class Loader extends Text {
  constructor(ui, spinnerColorFn, messageColorFn, message = "Loading...") {
    super("", 1, 0);
    this.spinnerColorFn = spinnerColorFn;
    this.messageColorFn = messageColorFn;
    this.message = message;
    this.frames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
    this.currentFrame = 0;
    this.intervalId = null;
    this.ui = null;
    this._lastMessage = "";
    this.ui = ui;
    this.start();
  }
  render(width) {
    if (this.message !== this._lastMessage) {
      this.setText(this.messageColorFn(this.message));
      this._lastMessage = this.message;
    }
    const messageLines = super.render(width);
    const result = ["", ...messageLines];
    if (result.length > 1) {
      const frame = this.frames[this.currentFrame];
      result[1] = this.spinnerColorFn(frame) + " " + result[1];
    }
    return result;
  }
  start() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    this.currentFrame = 0;
    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      if (this.ui) {
        this.ui.requestRender();
      }
    }, 80);
    if (this.ui) {
      this.ui.requestRender();
    }
  }
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
  dispose() {
    this.stop();
    this.ui = null;
  }
  setMessage(message) {
    this.message = message;
    if (this.ui) {
      this.ui.requestRender();
    }
  }
}
export {
  Loader
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktdHVpL3NyYy9jb21wb25lbnRzL2xvYWRlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBUVUkgfSBmcm9tIFwiLi4vdHVpLmpzXCI7XG5pbXBvcnQgeyBUZXh0IH0gZnJvbSBcIi4vdGV4dC5qc1wiO1xuXG4vKipcbiAqIExvYWRlciBjb21wb25lbnQgdGhhdCB1cGRhdGVzIGV2ZXJ5IDgwbXMgd2l0aCBzcGlubmluZyBhbmltYXRpb24uXG4gKiBGcmFtZSByb3RhdGlvbiBpcyBpc29sYXRlZCBmcm9tIG1lc3NhZ2UgdGV4dCB0byBhdm9pZCBpbnZhbGlkYXRpbmdcbiAqIFRleHQncyByZW5kZXIgY2FjaGUgKHdyYXBUZXh0V2l0aEFuc2ksIHZpc2libGVXaWR0aCkgb24gZXZlcnkgdGljay5cbiAqL1xuZXhwb3J0IGNsYXNzIExvYWRlciBleHRlbmRzIFRleHQge1xuXHRwcml2YXRlIGZyYW1lcyA9IFtcIlx1MjgwQlwiLCBcIlx1MjgxOVwiLCBcIlx1MjgzOVwiLCBcIlx1MjgzOFwiLCBcIlx1MjgzQ1wiLCBcIlx1MjgzNFwiLCBcIlx1MjgyNlwiLCBcIlx1MjgyN1wiLCBcIlx1MjgwN1wiLCBcIlx1MjgwRlwiXTtcblx0cHJpdmF0ZSBjdXJyZW50RnJhbWUgPSAwO1xuXHRwcml2YXRlIGludGVydmFsSWQ6IE5vZGVKUy5UaW1lb3V0IHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgdWk6IFRVSSB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIF9sYXN0TWVzc2FnZTogc3RyaW5nID0gXCJcIjtcblxuXHRjb25zdHJ1Y3Rvcihcblx0XHR1aTogVFVJLFxuXHRcdHByaXZhdGUgc3Bpbm5lckNvbG9yRm46IChzdHI6IHN0cmluZykgPT4gc3RyaW5nLFxuXHRcdHByaXZhdGUgbWVzc2FnZUNvbG9yRm46IChzdHI6IHN0cmluZykgPT4gc3RyaW5nLFxuXHRcdHByaXZhdGUgbWVzc2FnZTogc3RyaW5nID0gXCJMb2FkaW5nLi4uXCIsXG5cdCkge1xuXHRcdHN1cGVyKFwiXCIsIDEsIDApO1xuXHRcdHRoaXMudWkgPSB1aTtcblx0XHR0aGlzLnN0YXJ0KCk7XG5cdH1cblxuXHRyZW5kZXIod2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcblx0XHQvLyBPbmx5IHVwZGF0ZSBUZXh0IGNvbnRlbnQgd2hlbiBtZXNzYWdlIGFjdHVhbGx5IGNoYW5nZXMgXHUyMDE0XG5cdFx0Ly8gZnJhbWUgcm90YXRpb24gaXMgcHJlcGVuZGVkIGJlbG93IHdpdGhvdXQgdG91Y2hpbmcgdGhlIGNhY2hlXG5cdFx0aWYgKHRoaXMubWVzc2FnZSAhPT0gdGhpcy5fbGFzdE1lc3NhZ2UpIHtcblx0XHRcdHRoaXMuc2V0VGV4dCh0aGlzLm1lc3NhZ2VDb2xvckZuKHRoaXMubWVzc2FnZSkpO1xuXHRcdFx0dGhpcy5fbGFzdE1lc3NhZ2UgPSB0aGlzLm1lc3NhZ2U7XG5cdFx0fVxuXHRcdGNvbnN0IG1lc3NhZ2VMaW5lcyA9IHN1cGVyLnJlbmRlcih3aWR0aCk7XG5cdFx0Ly8gU2hhbGxvdyBjb3B5IHNvIHdlIGRvbid0IG11dGF0ZSBjYWNoZWRMaW5lcyBmcm9tIFRleHRcblx0XHRjb25zdCByZXN1bHQgPSBbXCJcIiwgLi4ubWVzc2FnZUxpbmVzXTtcblx0XHQvLyBQcmVwZW5kIHNwaW5uZXIgZnJhbWUgdG8gZmlyc3QgY29udGVudCBsaW5lXG5cdFx0aWYgKHJlc3VsdC5sZW5ndGggPiAxKSB7XG5cdFx0XHRjb25zdCBmcmFtZSA9IHRoaXMuZnJhbWVzW3RoaXMuY3VycmVudEZyYW1lXTtcblx0XHRcdHJlc3VsdFsxXSA9IHRoaXMuc3Bpbm5lckNvbG9yRm4oZnJhbWUpICsgXCIgXCIgKyByZXN1bHRbMV07XG5cdFx0fVxuXHRcdHJldHVybiByZXN1bHQ7XG5cdH1cblxuXHRzdGFydCgpIHtcblx0XHRpZiAodGhpcy5pbnRlcnZhbElkKSB7XG5cdFx0XHRjbGVhckludGVydmFsKHRoaXMuaW50ZXJ2YWxJZCk7XG5cdFx0fVxuXHRcdHRoaXMuY3VycmVudEZyYW1lID0gMDtcblx0XHR0aGlzLmludGVydmFsSWQgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG5cdFx0XHR0aGlzLmN1cnJlbnRGcmFtZSA9ICh0aGlzLmN1cnJlbnRGcmFtZSArIDEpICUgdGhpcy5mcmFtZXMubGVuZ3RoO1xuXHRcdFx0aWYgKHRoaXMudWkpIHtcblx0XHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHR9XG5cdFx0fSwgODApO1xuXHRcdC8vIFRyaWdnZXIgaW5pdGlhbCByZW5kZXJcblx0XHRpZiAodGhpcy51aSkge1xuXHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0fVxuXHR9XG5cblx0c3RvcCgpIHtcblx0XHRpZiAodGhpcy5pbnRlcnZhbElkKSB7XG5cdFx0XHRjbGVhckludGVydmFsKHRoaXMuaW50ZXJ2YWxJZCk7XG5cdFx0XHR0aGlzLmludGVydmFsSWQgPSBudWxsO1xuXHRcdH1cblx0fVxuXG5cdGRpc3Bvc2UoKSB7XG5cdFx0dGhpcy5zdG9wKCk7XG5cdFx0dGhpcy51aSA9IG51bGw7XG5cdH1cblxuXHRzZXRNZXNzYWdlKG1lc3NhZ2U6IHN0cmluZykge1xuXHRcdHRoaXMubWVzc2FnZSA9IG1lc3NhZ2U7XG5cdFx0aWYgKHRoaXMudWkpIHtcblx0XHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdH1cblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQ0EsU0FBUyxZQUFZO0FBT2QsTUFBTSxlQUFlLEtBQUs7QUFBQSxFQU9oQyxZQUNDLElBQ1EsZ0JBQ0EsZ0JBQ0EsVUFBa0IsY0FDekI7QUFDRCxVQUFNLElBQUksR0FBRyxDQUFDO0FBSk47QUFDQTtBQUNBO0FBVlQsU0FBUSxTQUFTLENBQUMsVUFBSyxVQUFLLFVBQUssVUFBSyxVQUFLLFVBQUssVUFBSyxVQUFLLFVBQUssUUFBRztBQUNsRSxTQUFRLGVBQWU7QUFDdkIsU0FBUSxhQUFvQztBQUM1QyxTQUFRLEtBQWlCO0FBQ3pCLFNBQVEsZUFBdUI7QUFTOUIsU0FBSyxLQUFLO0FBQ1YsU0FBSyxNQUFNO0FBQUEsRUFDWjtBQUFBLEVBRUEsT0FBTyxPQUF5QjtBQUcvQixRQUFJLEtBQUssWUFBWSxLQUFLLGNBQWM7QUFDdkMsV0FBSyxRQUFRLEtBQUssZUFBZSxLQUFLLE9BQU8sQ0FBQztBQUM5QyxXQUFLLGVBQWUsS0FBSztBQUFBLElBQzFCO0FBQ0EsVUFBTSxlQUFlLE1BQU0sT0FBTyxLQUFLO0FBRXZDLFVBQU0sU0FBUyxDQUFDLElBQUksR0FBRyxZQUFZO0FBRW5DLFFBQUksT0FBTyxTQUFTLEdBQUc7QUFDdEIsWUFBTSxRQUFRLEtBQUssT0FBTyxLQUFLLFlBQVk7QUFDM0MsYUFBTyxDQUFDLElBQUksS0FBSyxlQUFlLEtBQUssSUFBSSxNQUFNLE9BQU8sQ0FBQztBQUFBLElBQ3hEO0FBQ0EsV0FBTztBQUFBLEVBQ1I7QUFBQSxFQUVBLFFBQVE7QUFDUCxRQUFJLEtBQUssWUFBWTtBQUNwQixvQkFBYyxLQUFLLFVBQVU7QUFBQSxJQUM5QjtBQUNBLFNBQUssZUFBZTtBQUNwQixTQUFLLGFBQWEsWUFBWSxNQUFNO0FBQ25DLFdBQUssZ0JBQWdCLEtBQUssZUFBZSxLQUFLLEtBQUssT0FBTztBQUMxRCxVQUFJLEtBQUssSUFBSTtBQUNaLGFBQUssR0FBRyxjQUFjO0FBQUEsTUFDdkI7QUFBQSxJQUNELEdBQUcsRUFBRTtBQUVMLFFBQUksS0FBSyxJQUFJO0FBQ1osV0FBSyxHQUFHLGNBQWM7QUFBQSxJQUN2QjtBQUFBLEVBQ0Q7QUFBQSxFQUVBLE9BQU87QUFDTixRQUFJLEtBQUssWUFBWTtBQUNwQixvQkFBYyxLQUFLLFVBQVU7QUFDN0IsV0FBSyxhQUFhO0FBQUEsSUFDbkI7QUFBQSxFQUNEO0FBQUEsRUFFQSxVQUFVO0FBQ1QsU0FBSyxLQUFLO0FBQ1YsU0FBSyxLQUFLO0FBQUEsRUFDWDtBQUFBLEVBRUEsV0FBVyxTQUFpQjtBQUMzQixTQUFLLFVBQVU7QUFDZixRQUFJLEtBQUssSUFBSTtBQUNaLFdBQUssR0FBRyxjQUFjO0FBQUEsSUFDdkI7QUFBQSxFQUNEO0FBQ0Q7IiwKICAibmFtZXMiOiBbXQp9Cg==
