import { Container, getEditorKeybindings, Spacer, Text } from "@gsd/pi-tui";
import { theme } from "../theme/theme.js";
import { CountdownTimer } from "./countdown-timer.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";
const SEPARATOR_PREFIX = "\u2500\u2500\u2500";
class ExtensionSelectorComponent extends Container {
  constructor(title, options, onSelect, onCancel, opts) {
    super();
    this.selectedIndex = 0;
    this.options = options;
    this.onSelectCallback = onSelect;
    this.onCancelCallback = onCancel;
    this.baseTitle = title;
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.titleText = new Text(theme.fg("accent", title), 1, 0);
    this.addChild(this.titleText);
    this.addChild(new Spacer(1));
    if (opts?.timeout && opts.timeout > 0 && opts.tui) {
      this.countdown = new CountdownTimer(
        opts.timeout,
        opts.tui,
        (s) => this.titleText.setText(theme.fg("accent", `${this.baseTitle} (${s}s)`)),
        () => this.onCancelCallback()
      );
    }
    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        rawKeyHint("\u2191\u2193", "navigate") + "  " + keyHint("selectConfirm", "select") + "  " + keyHint("selectCancel", "cancel"),
        1,
        0
      )
    );
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    this.selectedIndex = this.nextSelectable(0, 1);
    this.updateList();
  }
  isSeparator(index) {
    return this.options[index]?.startsWith(SEPARATOR_PREFIX) ?? false;
  }
  /**
   * Find the next selectable index starting from `from` in the given direction.
   * Returns `from` clamped to bounds if nothing selectable is found.
   */
  nextSelectable(from, direction) {
    let idx = from;
    while (idx >= 0 && idx < this.options.length && this.isSeparator(idx)) {
      idx += direction;
    }
    if (idx < 0 || idx >= this.options.length) {
      return Math.max(0, Math.min(from, this.options.length - 1));
    }
    if (this.isSeparator(idx)) {
      return Math.max(0, Math.min(from, this.options.length - 1));
    }
    return idx;
  }
  updateList() {
    this.listContainer.clear();
    for (let i = 0; i < this.options.length; i++) {
      const option = this.options[i];
      if (this.isSeparator(i)) {
        this.listContainer.addChild(new Text(theme.fg("borderAccent", `  ${option}`), 1, 0));
        continue;
      }
      const isSelected = i === this.selectedIndex;
      const text = isSelected ? theme.fg("accent", "\u2192 ") + theme.fg("accent", option) : `  ${theme.fg("text", option)}`;
      this.listContainer.addChild(new Text(text, 1, 0));
    }
  }
  handleInput(keyData) {
    const kb = getEditorKeybindings();
    if (kb.matches(keyData, "selectUp") || keyData === "k") {
      let next = this.selectedIndex - 1;
      if (next < 0) next = this.options.length - 1;
      next = this.nextSelectable(next, -1);
      if (this.isSeparator(next)) {
        next = this.nextSelectable(this.options.length - 1, -1);
      }
      this.selectedIndex = next;
      this.updateList();
    } else if (kb.matches(keyData, "selectDown") || keyData === "j") {
      let next = this.selectedIndex + 1;
      if (next >= this.options.length) next = 0;
      next = this.nextSelectable(next, 1);
      if (this.isSeparator(next)) {
        next = this.nextSelectable(0, 1);
      }
      this.selectedIndex = next;
      this.updateList();
    } else if (kb.matches(keyData, "selectConfirm") || keyData === "\n") {
      const selected = this.options[this.selectedIndex];
      if (selected && !this.isSeparator(this.selectedIndex)) {
        this.onSelectCallback(selected);
      }
    } else if (kb.matches(keyData, "selectCancel")) {
      this.onCancelCallback();
    }
  }
  dispose() {
    this.countdown?.dispose();
  }
}
export {
  ExtensionSelectorComponent,
  SEPARATOR_PREFIX
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL2V4dGVuc2lvbi1zZWxlY3Rvci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHZW5lcmljIHNlbGVjdG9yIGNvbXBvbmVudCBmb3IgZXh0ZW5zaW9ucy5cbiAqIERpc3BsYXlzIGEgbGlzdCBvZiBzdHJpbmcgb3B0aW9ucyB3aXRoIGtleWJvYXJkIG5hdmlnYXRpb24uXG4gKiBPcHRpb25zIHN0YXJ0aW5nIHdpdGggU0VQQVJBVE9SX1BSRUZJWCBhcmUgcmVuZGVyZWQgYXMgbm9uLXNlbGVjdGFibGUgZ3JvdXAgaGVhZGVycy5cbiAqL1xuXG5pbXBvcnQgeyBDb250YWluZXIsIGdldEVkaXRvcktleWJpbmRpbmdzLCBTcGFjZXIsIFRleHQsIHR5cGUgVFVJIH0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5pbXBvcnQgeyB0aGVtZSB9IGZyb20gXCIuLi90aGVtZS90aGVtZS5qc1wiO1xuaW1wb3J0IHsgQ291bnRkb3duVGltZXIgfSBmcm9tIFwiLi9jb3VudGRvd24tdGltZXIuanNcIjtcbmltcG9ydCB7IER5bmFtaWNCb3JkZXIgfSBmcm9tIFwiLi9keW5hbWljLWJvcmRlci5qc1wiO1xuaW1wb3J0IHsga2V5SGludCwgcmF3S2V5SGludCB9IGZyb20gXCIuL2tleWJpbmRpbmctaGludHMuanNcIjtcblxuLyoqIFByZWZpeCB0aGF0IG1hcmtzIGFuIG9wdGlvbiBhcyBhIG5vbi1zZWxlY3RhYmxlIGdyb3VwIGhlYWRlci4gKi9cbmV4cG9ydCBjb25zdCBTRVBBUkFUT1JfUFJFRklYID0gXCJcdTI1MDBcdTI1MDBcdTI1MDBcIjtcblxuZXhwb3J0IGludGVyZmFjZSBFeHRlbnNpb25TZWxlY3Rvck9wdGlvbnMge1xuXHR0dWk/OiBUVUk7XG5cdHRpbWVvdXQ/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBjbGFzcyBFeHRlbnNpb25TZWxlY3RvckNvbXBvbmVudCBleHRlbmRzIENvbnRhaW5lciB7XG5cdHByaXZhdGUgb3B0aW9uczogc3RyaW5nW107XG5cdHByaXZhdGUgc2VsZWN0ZWRJbmRleCA9IDA7XG5cdHByaXZhdGUgbGlzdENvbnRhaW5lcjogQ29udGFpbmVyO1xuXHRwcml2YXRlIG9uU2VsZWN0Q2FsbGJhY2s6IChvcHRpb246IHN0cmluZykgPT4gdm9pZDtcblx0cHJpdmF0ZSBvbkNhbmNlbENhbGxiYWNrOiAoKSA9PiB2b2lkO1xuXHRwcml2YXRlIHRpdGxlVGV4dDogVGV4dDtcblx0cHJpdmF0ZSBiYXNlVGl0bGU6IHN0cmluZztcblx0cHJpdmF0ZSBjb3VudGRvd246IENvdW50ZG93blRpbWVyIHwgdW5kZWZpbmVkO1xuXG5cdGNvbnN0cnVjdG9yKFxuXHRcdHRpdGxlOiBzdHJpbmcsXG5cdFx0b3B0aW9uczogc3RyaW5nW10sXG5cdFx0b25TZWxlY3Q6IChvcHRpb246IHN0cmluZykgPT4gdm9pZCxcblx0XHRvbkNhbmNlbDogKCkgPT4gdm9pZCxcblx0XHRvcHRzPzogRXh0ZW5zaW9uU2VsZWN0b3JPcHRpb25zLFxuXHQpIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0dGhpcy5vcHRpb25zID0gb3B0aW9ucztcblx0XHR0aGlzLm9uU2VsZWN0Q2FsbGJhY2sgPSBvblNlbGVjdDtcblx0XHR0aGlzLm9uQ2FuY2VsQ2FsbGJhY2sgPSBvbkNhbmNlbDtcblx0XHR0aGlzLmJhc2VUaXRsZSA9IHRpdGxlO1xuXG5cdFx0dGhpcy5hZGRDaGlsZChuZXcgRHluYW1pY0JvcmRlcigpKTtcblx0XHR0aGlzLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXG5cdFx0dGhpcy50aXRsZVRleHQgPSBuZXcgVGV4dCh0aGVtZS5mZyhcImFjY2VudFwiLCB0aXRsZSksIDEsIDApO1xuXHRcdHRoaXMuYWRkQ2hpbGQodGhpcy50aXRsZVRleHQpO1xuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cblx0XHRpZiAob3B0cz8udGltZW91dCAmJiBvcHRzLnRpbWVvdXQgPiAwICYmIG9wdHMudHVpKSB7XG5cdFx0XHR0aGlzLmNvdW50ZG93biA9IG5ldyBDb3VudGRvd25UaW1lcihcblx0XHRcdFx0b3B0cy50aW1lb3V0LFxuXHRcdFx0XHRvcHRzLnR1aSxcblx0XHRcdFx0KHMpID0+IHRoaXMudGl0bGVUZXh0LnNldFRleHQodGhlbWUuZmcoXCJhY2NlbnRcIiwgYCR7dGhpcy5iYXNlVGl0bGV9ICgke3N9cylgKSksXG5cdFx0XHRcdCgpID0+IHRoaXMub25DYW5jZWxDYWxsYmFjaygpLFxuXHRcdFx0KTtcblx0XHR9XG5cblx0XHR0aGlzLmxpc3RDb250YWluZXIgPSBuZXcgQ29udGFpbmVyKCk7XG5cdFx0dGhpcy5hZGRDaGlsZCh0aGlzLmxpc3RDb250YWluZXIpO1xuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0dGhpcy5hZGRDaGlsZChcblx0XHRcdG5ldyBUZXh0KFxuXHRcdFx0XHRyYXdLZXlIaW50KFwiXHUyMTkxXHUyMTkzXCIsIFwibmF2aWdhdGVcIikgK1xuXHRcdFx0XHRcdFwiICBcIiArXG5cdFx0XHRcdFx0a2V5SGludChcInNlbGVjdENvbmZpcm1cIiwgXCJzZWxlY3RcIikgK1xuXHRcdFx0XHRcdFwiICBcIiArXG5cdFx0XHRcdFx0a2V5SGludChcInNlbGVjdENhbmNlbFwiLCBcImNhbmNlbFwiKSxcblx0XHRcdFx0MSxcblx0XHRcdFx0MCxcblx0XHRcdCksXG5cdFx0KTtcblx0XHR0aGlzLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IER5bmFtaWNCb3JkZXIoKSk7XG5cblx0XHQvLyBTdGFydCBvbiB0aGUgZmlyc3Qgc2VsZWN0YWJsZSAobm9uLXNlcGFyYXRvcikgaXRlbVxuXHRcdHRoaXMuc2VsZWN0ZWRJbmRleCA9IHRoaXMubmV4dFNlbGVjdGFibGUoMCwgMSk7XG5cdFx0dGhpcy51cGRhdGVMaXN0KCk7XG5cdH1cblxuXHRwcml2YXRlIGlzU2VwYXJhdG9yKGluZGV4OiBudW1iZXIpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5vcHRpb25zW2luZGV4XT8uc3RhcnRzV2l0aChTRVBBUkFUT1JfUFJFRklYKSA/PyBmYWxzZTtcblx0fVxuXG5cdC8qKlxuXHQgKiBGaW5kIHRoZSBuZXh0IHNlbGVjdGFibGUgaW5kZXggc3RhcnRpbmcgZnJvbSBgZnJvbWAgaW4gdGhlIGdpdmVuIGRpcmVjdGlvbi5cblx0ICogUmV0dXJucyBgZnJvbWAgY2xhbXBlZCB0byBib3VuZHMgaWYgbm90aGluZyBzZWxlY3RhYmxlIGlzIGZvdW5kLlxuXHQgKi9cblx0cHJpdmF0ZSBuZXh0U2VsZWN0YWJsZShmcm9tOiBudW1iZXIsIGRpcmVjdGlvbjogMSB8IC0xKTogbnVtYmVyIHtcblx0XHRsZXQgaWR4ID0gZnJvbTtcblx0XHR3aGlsZSAoaWR4ID49IDAgJiYgaWR4IDwgdGhpcy5vcHRpb25zLmxlbmd0aCAmJiB0aGlzLmlzU2VwYXJhdG9yKGlkeCkpIHtcblx0XHRcdGlkeCArPSBkaXJlY3Rpb247XG5cdFx0fVxuXHRcdGlmIChpZHggPCAwIHx8IGlkeCA+PSB0aGlzLm9wdGlvbnMubGVuZ3RoKSB7XG5cdFx0XHRyZXR1cm4gTWF0aC5tYXgoMCwgTWF0aC5taW4oZnJvbSwgdGhpcy5vcHRpb25zLmxlbmd0aCAtIDEpKTtcblx0XHR9XG5cdFx0Ly8gSWYgYWxsIGl0ZW1zIGFyZSBzZXBhcmF0b3JzLCBpZHggbWF5IHN0aWxsIHBvaW50IHRvIG9uZSBcdTIwMTQgZmFsbCBiYWNrIHRvIG9yaWdpbmFsIGluZGV4XG5cdFx0aWYgKHRoaXMuaXNTZXBhcmF0b3IoaWR4KSkge1xuXHRcdFx0cmV0dXJuIE1hdGgubWF4KDAsIE1hdGgubWluKGZyb20sIHRoaXMub3B0aW9ucy5sZW5ndGggLSAxKSk7XG5cdFx0fVxuXHRcdHJldHVybiBpZHg7XG5cdH1cblxuXHRwcml2YXRlIHVwZGF0ZUxpc3QoKTogdm9pZCB7XG5cdFx0dGhpcy5saXN0Q29udGFpbmVyLmNsZWFyKCk7XG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCB0aGlzLm9wdGlvbnMubGVuZ3RoOyBpKyspIHtcblx0XHRcdGNvbnN0IG9wdGlvbiA9IHRoaXMub3B0aW9uc1tpXTtcblx0XHRcdGlmICh0aGlzLmlzU2VwYXJhdG9yKGkpKSB7XG5cdFx0XHRcdHRoaXMubGlzdENvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5mZyhcImJvcmRlckFjY2VudFwiLCBgICAke29wdGlvbn1gKSwgMSwgMCkpO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGlzU2VsZWN0ZWQgPSBpID09PSB0aGlzLnNlbGVjdGVkSW5kZXg7XG5cdFx0XHRjb25zdCB0ZXh0ID0gaXNTZWxlY3RlZFxuXHRcdFx0XHQ/IHRoZW1lLmZnKFwiYWNjZW50XCIsIFwiXHUyMTkyIFwiKSArIHRoZW1lLmZnKFwiYWNjZW50XCIsIG9wdGlvbilcblx0XHRcdFx0OiBgICAke3RoZW1lLmZnKFwidGV4dFwiLCBvcHRpb24pfWA7XG5cdFx0XHR0aGlzLmxpc3RDb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQodGV4dCwgMSwgMCkpO1xuXHRcdH1cblx0fVxuXG5cdGhhbmRsZUlucHV0KGtleURhdGE6IHN0cmluZyk6IHZvaWQge1xuXHRcdGNvbnN0IGtiID0gZ2V0RWRpdG9yS2V5YmluZGluZ3MoKTtcblx0XHRpZiAoa2IubWF0Y2hlcyhrZXlEYXRhLCBcInNlbGVjdFVwXCIpIHx8IGtleURhdGEgPT09IFwia1wiKSB7XG5cdFx0XHRsZXQgbmV4dCA9IHRoaXMuc2VsZWN0ZWRJbmRleCAtIDE7XG5cdFx0XHRpZiAobmV4dCA8IDApIG5leHQgPSB0aGlzLm9wdGlvbnMubGVuZ3RoIC0gMTtcblx0XHRcdG5leHQgPSB0aGlzLm5leHRTZWxlY3RhYmxlKG5leHQsIC0xKTtcblx0XHRcdGlmICh0aGlzLmlzU2VwYXJhdG9yKG5leHQpKSB7XG5cdFx0XHRcdG5leHQgPSB0aGlzLm5leHRTZWxlY3RhYmxlKHRoaXMub3B0aW9ucy5sZW5ndGggLSAxLCAtMSk7XG5cdFx0XHR9XG5cdFx0XHR0aGlzLnNlbGVjdGVkSW5kZXggPSBuZXh0O1xuXHRcdFx0dGhpcy51cGRhdGVMaXN0KCk7XG5cdFx0fSBlbHNlIGlmIChrYi5tYXRjaGVzKGtleURhdGEsIFwic2VsZWN0RG93blwiKSB8fCBrZXlEYXRhID09PSBcImpcIikge1xuXHRcdFx0bGV0IG5leHQgPSB0aGlzLnNlbGVjdGVkSW5kZXggKyAxO1xuXHRcdFx0aWYgKG5leHQgPj0gdGhpcy5vcHRpb25zLmxlbmd0aCkgbmV4dCA9IDA7XG5cdFx0XHRuZXh0ID0gdGhpcy5uZXh0U2VsZWN0YWJsZShuZXh0LCAxKTtcblx0XHRcdGlmICh0aGlzLmlzU2VwYXJhdG9yKG5leHQpKSB7XG5cdFx0XHRcdG5leHQgPSB0aGlzLm5leHRTZWxlY3RhYmxlKDAsIDEpO1xuXHRcdFx0fVxuXHRcdFx0dGhpcy5zZWxlY3RlZEluZGV4ID0gbmV4dDtcblx0XHRcdHRoaXMudXBkYXRlTGlzdCgpO1xuXHRcdH0gZWxzZSBpZiAoa2IubWF0Y2hlcyhrZXlEYXRhLCBcInNlbGVjdENvbmZpcm1cIikgfHwga2V5RGF0YSA9PT0gXCJcXG5cIikge1xuXHRcdFx0Y29uc3Qgc2VsZWN0ZWQgPSB0aGlzLm9wdGlvbnNbdGhpcy5zZWxlY3RlZEluZGV4XTtcblx0XHRcdGlmIChzZWxlY3RlZCAmJiAhdGhpcy5pc1NlcGFyYXRvcih0aGlzLnNlbGVjdGVkSW5kZXgpKSB7XG5cdFx0XHRcdHRoaXMub25TZWxlY3RDYWxsYmFjayhzZWxlY3RlZCk7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIGlmIChrYi5tYXRjaGVzKGtleURhdGEsIFwic2VsZWN0Q2FuY2VsXCIpKSB7XG5cdFx0XHR0aGlzLm9uQ2FuY2VsQ2FsbGJhY2soKTtcblx0XHR9XG5cdH1cblxuXHRkaXNwb3NlKCk6IHZvaWQge1xuXHRcdHRoaXMuY291bnRkb3duPy5kaXNwb3NlKCk7XG5cdH1cbn1c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QSxNQUNEO0FBQ0EsWUFBTSxhQUFhLE1BQU0sS0FBSztBQUM5QixZQUFNLE9BQU8sYUFDVixNQUFNLEdBQUcsVUFBVSxTQUFJLElBQUksTUFBTSxHQUFHLFVBQVUsTUFBTSxJQUNwRCxLQUFLLE1BQU0sR0FBRyxRQUFRLE1BQU0sQ0FBQztBQUNoQyxXQUFLLGNBQWMsU0FBUyxJQUFJLEtBQUssTUFBTSxHQUFHLENBQUMsQ0FBQztBQUFBLElBQ2pEO0FBQUEsRUFDRDtBQUFBLEVBRUEsWUFBWSxTQUF1QjtBQUNsQyxVQUFNLEtBQUsscUJBQXFCO0FBQ2hDLFFBQUksR0FBRyxRQUFRLFNBQVMsVUFBVSxLQUFLLFlBQVksS0FBSztBQUN2RCxVQUFJLE9BQU8sS0FBSyxnQkFBZ0I7QUFDaEMsVUFBSSxPQUFPLEVBQUcsUUFBTyxLQUFLLFFBQVEsU0FBUztBQUMzQyxhQUFPLEtBQUssZUFBZSxNQUFNLEVBQUU7QUFDbkMsVUFBSSxLQUFLLFlBQVksSUFBSSxHQUFHO0FBQzNCLGVBQU8sS0FBSyxlQUFlLEtBQUssUUFBUSxTQUFTLEdBQUcsRUFBRTtBQUFBLE1BQ3ZEO0FBQ0EsV0FBSyxnQkFBZ0I7QUFDckIsV0FBSyxXQUFXO0FBQUEsSUFDakIsV0FBVyxHQUFHLFFBQVEsU0FBUyxZQUFZLEtBQUssWUFBWSxLQUFLO0FBQ2hFLFVBQUksT0FBTyxLQUFLLGdCQUFnQjtBQUNoQyxVQUFJLFFBQVEsS0FBSyxRQUFRLE9BQVEsUUFBTztBQUN4QyxhQUFPLEtBQUssZUFBZSxNQUFNLENBQUM7QUFDbEMsVUFBSSxLQUFLLFlBQVksSUFBSSxHQUFHO0FBQzNCLGVBQU8sS0FBSyxlQUFlLEdBQUcsQ0FBQztBQUFBLE1BQ2hDO0FBQ0EsV0FBSyxnQkFBZ0I7QUFDckIsV0FBSyxXQUFXO0FBQUEsSUFDakIsV0FBVyxHQUFHLFFBQVEsU0FBUyxlQUFlLEtBQUssWUFBWSxNQUFNO0FBQ3BFLFlBQU0sV0FBVyxLQUFLLFFBQVEsS0FBSyxhQUFhO0FBQ2hELFVBQUksWUFBWSxDQUFDLEtBQUssWUFBWSxLQUFLLGFBQWEsR0FBRztBQUN0RCxhQUFLLGlCQUFpQixRQUFRO0FBQUEsTUFDL0I7QUFBQSxJQUNELFdBQVcsR0FBRyxRQUFRLFNBQVMsY0FBYyxHQUFHO0FBQy9DLFdBQUssaUJBQWlCO0FBQUEsSUFDdkI7QUFBQSxFQUNEO0FBQUEsRUFFQSxVQUFnQjtBQUNmLFNBQUssV0FBVyxRQUFRO0FBQUEsRUFDekI7QUFDRDsiLAogICJuYW1lcyI6IFtdCn0K
