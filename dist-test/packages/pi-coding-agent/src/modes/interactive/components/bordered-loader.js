import { CancellableLoader, Container, Loader, Spacer, Text } from "@gsd/pi-tui";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";
class BorderedLoader extends Container {
  constructor(tui, theme, message, options) {
    super();
    this.cancellable = options?.cancellable ?? true;
    const borderColor = (s) => theme.fg("border", s);
    this.addChild(new DynamicBorder(borderColor));
    if (this.cancellable) {
      this.loader = new CancellableLoader(
        tui,
        (s) => theme.fg("accent", s),
        (s) => theme.fg("muted", s),
        message
      );
    } else {
      this.signalController = new AbortController();
      this.loader = new Loader(
        tui,
        (s) => theme.fg("accent", s),
        (s) => theme.fg("muted", s),
        message
      );
    }
    this.addChild(this.loader);
    if (this.cancellable) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(keyHint("selectCancel", "cancel"), 1, 0));
      this.addChild(new Spacer(1));
    }
    this.addChild(new DynamicBorder(borderColor));
  }
  get signal() {
    if (this.cancellable) {
      return this.loader.signal;
    }
    return this.signalController?.signal ?? new AbortController().signal;
  }
  set onAbort(fn) {
    if (this.cancellable) {
      this.loader.onAbort = fn;
    }
  }
  handleInput(data) {
    if (this.cancellable) {
      this.loader.handleInput(data);
    }
  }
  dispose() {
    if ("dispose" in this.loader && typeof this.loader.dispose === "function") {
      this.loader.dispose();
    }
  }
}
export {
  BorderedLoader
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL2JvcmRlcmVkLWxvYWRlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgQ2FuY2VsbGFibGVMb2FkZXIsIENvbnRhaW5lciwgTG9hZGVyLCBTcGFjZXIsIFRleHQsIHR5cGUgVFVJIH0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5pbXBvcnQgdHlwZSB7IFRoZW1lIH0gZnJvbSBcIi4uL3RoZW1lL3RoZW1lLmpzXCI7XG5pbXBvcnQgeyBEeW5hbWljQm9yZGVyIH0gZnJvbSBcIi4vZHluYW1pYy1ib3JkZXIuanNcIjtcbmltcG9ydCB7IGtleUhpbnQgfSBmcm9tIFwiLi9rZXliaW5kaW5nLWhpbnRzLmpzXCI7XG5cbi8qKiBMb2FkZXIgd3JhcHBlZCB3aXRoIGJvcmRlcnMgZm9yIGV4dGVuc2lvbiBVSSAqL1xuZXhwb3J0IGNsYXNzIEJvcmRlcmVkTG9hZGVyIGV4dGVuZHMgQ29udGFpbmVyIHtcblx0cHJpdmF0ZSBsb2FkZXI6IENhbmNlbGxhYmxlTG9hZGVyIHwgTG9hZGVyO1xuXHRwcml2YXRlIGNhbmNlbGxhYmxlOiBib29sZWFuO1xuXHRwcml2YXRlIHNpZ25hbENvbnRyb2xsZXI/OiBBYm9ydENvbnRyb2xsZXI7XG5cblx0Y29uc3RydWN0b3IodHVpOiBUVUksIHRoZW1lOiBUaGVtZSwgbWVzc2FnZTogc3RyaW5nLCBvcHRpb25zPzogeyBjYW5jZWxsYWJsZT86IGJvb2xlYW4gfSkge1xuXHRcdHN1cGVyKCk7XG5cdFx0dGhpcy5jYW5jZWxsYWJsZSA9IG9wdGlvbnM/LmNhbmNlbGxhYmxlID8/IHRydWU7XG5cdFx0Y29uc3QgYm9yZGVyQ29sb3IgPSAoczogc3RyaW5nKSA9PiB0aGVtZS5mZyhcImJvcmRlclwiLCBzKTtcblx0XHR0aGlzLmFkZENoaWxkKG5ldyBEeW5hbWljQm9yZGVyKGJvcmRlckNvbG9yKSk7XG5cdFx0aWYgKHRoaXMuY2FuY2VsbGFibGUpIHtcblx0XHRcdHRoaXMubG9hZGVyID0gbmV3IENhbmNlbGxhYmxlTG9hZGVyKFxuXHRcdFx0XHR0dWksXG5cdFx0XHRcdChzKSA9PiB0aGVtZS5mZyhcImFjY2VudFwiLCBzKSxcblx0XHRcdFx0KHMpID0+IHRoZW1lLmZnKFwibXV0ZWRcIiwgcyksXG5cdFx0XHRcdG1lc3NhZ2UsXG5cdFx0XHQpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLnNpZ25hbENvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG5cdFx0XHR0aGlzLmxvYWRlciA9IG5ldyBMb2FkZXIoXG5cdFx0XHRcdHR1aSxcblx0XHRcdFx0KHMpID0+IHRoZW1lLmZnKFwiYWNjZW50XCIsIHMpLFxuXHRcdFx0XHQocykgPT4gdGhlbWUuZmcoXCJtdXRlZFwiLCBzKSxcblx0XHRcdFx0bWVzc2FnZSxcblx0XHRcdCk7XG5cdFx0fVxuXHRcdHRoaXMuYWRkQ2hpbGQodGhpcy5sb2FkZXIpO1xuXHRcdGlmICh0aGlzLmNhbmNlbGxhYmxlKSB7XG5cdFx0XHR0aGlzLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdFx0dGhpcy5hZGRDaGlsZChuZXcgVGV4dChrZXlIaW50KFwic2VsZWN0Q2FuY2VsXCIsIFwiY2FuY2VsXCIpLCAxLCAwKSk7XG5cdFx0XHR0aGlzLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdH1cblx0XHR0aGlzLmFkZENoaWxkKG5ldyBEeW5hbWljQm9yZGVyKGJvcmRlckNvbG9yKSk7XG5cdH1cblxuXHRnZXQgc2lnbmFsKCk6IEFib3J0U2lnbmFsIHtcblx0XHRpZiAodGhpcy5jYW5jZWxsYWJsZSkge1xuXHRcdFx0cmV0dXJuICh0aGlzLmxvYWRlciBhcyBDYW5jZWxsYWJsZUxvYWRlcikuc2lnbmFsO1xuXHRcdH1cblx0XHRyZXR1cm4gdGhpcy5zaWduYWxDb250cm9sbGVyPy5zaWduYWwgPz8gbmV3IEFib3J0Q29udHJvbGxlcigpLnNpZ25hbDtcblx0fVxuXG5cdHNldCBvbkFib3J0KGZuOiAoKCkgPT4gdm9pZCkgfCB1bmRlZmluZWQpIHtcblx0XHRpZiAodGhpcy5jYW5jZWxsYWJsZSkge1xuXHRcdFx0KHRoaXMubG9hZGVyIGFzIENhbmNlbGxhYmxlTG9hZGVyKS5vbkFib3J0ID0gZm47XG5cdFx0fVxuXHR9XG5cblx0aGFuZGxlSW5wdXQoZGF0YTogc3RyaW5nKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMuY2FuY2VsbGFibGUpIHtcblx0XHRcdCh0aGlzLmxvYWRlciBhcyBDYW5jZWxsYWJsZUxvYWRlcikuaGFuZGxlSW5wdXQoZGF0YSk7XG5cdFx0fVxuXHR9XG5cblx0ZGlzcG9zZSgpOiB2b2lkIHtcblx0XHRpZiAoXCJkaXNwb3NlXCIgaW4gdGhpcy5sb2FkZXIgJiYgdHlwZW9mIHRoaXMubG9hZGVyLmRpc3Bvc2UgPT09IFwiZnVuY3Rpb25cIikge1xuXHRcdFx0dGhpcy5sb2FkZXIuZGlzcG9zZSgpO1xuXHRcdH1cblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxtQkFBbUIsV0FBVyxRQUFRLFFBQVEsWUFBc0I7QUFFN0UsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxlQUFlO0FBR2pCLE1BQU0sdUJBQXVCLFVBQVU7QUFBQSxFQUs3QyxZQUFZLEtBQVUsT0FBYyxTQUFpQixTQUFxQztBQUN6RixVQUFNO0FBQ04sU0FBSyxjQUFjLFNBQVMsZUFBZTtBQUMzQyxVQUFNLGNBQWMsQ0FBQyxNQUFjLE1BQU0sR0FBRyxVQUFVLENBQUM7QUFDdkQsU0FBSyxTQUFTLElBQUksY0FBYyxXQUFXLENBQUM7QUFDNUMsUUFBSSxLQUFLLGFBQWE7QUFDckIsV0FBSyxTQUFTLElBQUk7QUFBQSxRQUNqQjtBQUFBLFFBQ0EsQ0FBQyxNQUFNLE1BQU0sR0FBRyxVQUFVLENBQUM7QUFBQSxRQUMzQixDQUFDLE1BQU0sTUFBTSxHQUFHLFNBQVMsQ0FBQztBQUFBLFFBQzFCO0FBQUEsTUFDRDtBQUFBLElBQ0QsT0FBTztBQUNOLFdBQUssbUJBQW1CLElBQUksZ0JBQWdCO0FBQzVDLFdBQUssU0FBUyxJQUFJO0FBQUEsUUFDakI7QUFBQSxRQUNBLENBQUMsTUFBTSxNQUFNLEdBQUcsVUFBVSxDQUFDO0FBQUEsUUFDM0IsQ0FBQyxNQUFNLE1BQU0sR0FBRyxTQUFTLENBQUM7QUFBQSxRQUMxQjtBQUFBLE1BQ0Q7QUFBQSxJQUNEO0FBQ0EsU0FBSyxTQUFTLEtBQUssTUFBTTtBQUN6QixRQUFJLEtBQUssYUFBYTtBQUNyQixXQUFLLFNBQVMsSUFBSSxPQUFPLENBQUMsQ0FBQztBQUMzQixXQUFLLFNBQVMsSUFBSSxLQUFLLFFBQVEsZ0JBQWdCLFFBQVEsR0FBRyxHQUFHLENBQUMsQ0FBQztBQUMvRCxXQUFLLFNBQVMsSUFBSSxPQUFPLENBQUMsQ0FBQztBQUFBLElBQzVCO0FBQ0EsU0FBSyxTQUFTLElBQUksY0FBYyxXQUFXLENBQUM7QUFBQSxFQUM3QztBQUFBLEVBRUEsSUFBSSxTQUFzQjtBQUN6QixRQUFJLEtBQUssYUFBYTtBQUNyQixhQUFRLEtBQUssT0FBNkI7QUFBQSxJQUMzQztBQUNBLFdBQU8sS0FBSyxrQkFBa0IsVUFBVSxJQUFJLGdCQUFnQixFQUFFO0FBQUEsRUFDL0Q7QUFBQSxFQUVBLElBQUksUUFBUSxJQUE4QjtBQUN6QyxRQUFJLEtBQUssYUFBYTtBQUNyQixNQUFDLEtBQUssT0FBNkIsVUFBVTtBQUFBLElBQzlDO0FBQUEsRUFDRDtBQUFBLEVBRUEsWUFBWSxNQUFvQjtBQUMvQixRQUFJLEtBQUssYUFBYTtBQUNyQixNQUFDLEtBQUssT0FBNkIsWUFBWSxJQUFJO0FBQUEsSUFDcEQ7QUFBQSxFQUNEO0FBQUEsRUFFQSxVQUFnQjtBQUNmLFFBQUksYUFBYSxLQUFLLFVBQVUsT0FBTyxLQUFLLE9BQU8sWUFBWSxZQUFZO0FBQzFFLFdBQUssT0FBTyxRQUFRO0FBQUEsSUFDckI7QUFBQSxFQUNEO0FBQ0Q7IiwKICAibmFtZXMiOiBbXQp9Cg==
