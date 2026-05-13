import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../editor.js";
import { CURSOR_MARKER, TUI } from "../../tui.js";
function makeTerminal() {
  return {
    isTTY: true,
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    start() {
    },
    stop() {
    },
    drainInput: async () => {
    },
    write() {
    },
    moveBy() {
    },
    hideCursor() {
    },
    showCursor() {
    },
    clearLine() {
    },
    clearFromCursor() {
    },
    clearScreen() {
    },
    setTitle() {
    }
  };
}
const theme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text
  }
};
describe("Editor", () => {
  it("clears bracketed paste state when focus is lost", () => {
    const editor = new Editor(new TUI(makeTerminal()), theme);
    editor.focused = true;
    editor.handleInput("\x1B[200~partial");
    editor.focused = false;
    editor.focused = true;
    editor.handleInput("hello");
    assert.equal(editor.getText(), "hello");
  });
  it("keeps the hardware cursor marker visible while autocomplete is open", () => {
    const editor = new Editor(new TUI(makeTerminal()), theme);
    editor.focused = true;
    editor.setText("/se");
    editor.autocompleteState = "regular";
    editor.autocompleteList = { render: () => [] };
    const rendered = editor.render(40).join("\n");
    assert.ok(rendered.includes(CURSOR_MARKER));
  });
  it("maps kitty keypad digits to plain editor text", () => {
    const editor = new Editor(new TUI(makeTerminal()), theme);
    editor.focused = true;
    editor.handleInput("\x1B[57404;129u");
    assert.equal(editor.getText(), "5");
  });
  it("does not insert kitty keypad navigation private-use glyphs into the editor", () => {
    const editor = new Editor(new TUI(makeTerminal()), theme);
    editor.focused = true;
    editor.handleInput("\x1B[57419u");
    assert.equal(editor.getText(), "");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktdHVpL3NyYy9jb21wb25lbnRzL19fdGVzdHNfXy9lZGl0b3IudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5cbmltcG9ydCB7IEVkaXRvciwgdHlwZSBFZGl0b3JUaGVtZSB9IGZyb20gXCIuLi9lZGl0b3IuanNcIjtcbmltcG9ydCB7IENVUlNPUl9NQVJLRVIsIFRVSSB9IGZyb20gXCIuLi8uLi90dWkuanNcIjtcbmltcG9ydCB0eXBlIHsgVGVybWluYWwgfSBmcm9tIFwiLi4vLi4vdGVybWluYWwuanNcIjtcblxuZnVuY3Rpb24gbWFrZVRlcm1pbmFsKCk6IFRlcm1pbmFsIHtcblx0cmV0dXJuIHtcblx0XHRpc1RUWTogdHJ1ZSxcblx0XHRjb2x1bW5zOiA4MCxcblx0XHRyb3dzOiAyNCxcblx0XHRraXR0eVByb3RvY29sQWN0aXZlOiBmYWxzZSxcblx0XHRzdGFydCgpIHt9LFxuXHRcdHN0b3AoKSB7fSxcblx0XHRkcmFpbklucHV0OiBhc3luYyAoKSA9PiB7fSxcblx0XHR3cml0ZSgpIHt9LFxuXHRcdG1vdmVCeSgpIHt9LFxuXHRcdGhpZGVDdXJzb3IoKSB7fSxcblx0XHRzaG93Q3Vyc29yKCkge30sXG5cdFx0Y2xlYXJMaW5lKCkge30sXG5cdFx0Y2xlYXJGcm9tQ3Vyc29yKCkge30sXG5cdFx0Y2xlYXJTY3JlZW4oKSB7fSxcblx0XHRzZXRUaXRsZSgpIHt9LFxuXHR9O1xufVxuXG5jb25zdCB0aGVtZTogRWRpdG9yVGhlbWUgPSB7XG5cdGJvcmRlckNvbG9yOiAodGV4dCkgPT4gdGV4dCxcblx0c2VsZWN0TGlzdDoge1xuXHRcdHNlbGVjdGVkUHJlZml4OiAodGV4dCkgPT4gdGV4dCxcblx0XHRzZWxlY3RlZFRleHQ6ICh0ZXh0KSA9PiB0ZXh0LFxuXHRcdGRlc2NyaXB0aW9uOiAodGV4dCkgPT4gdGV4dCxcblx0XHRzY3JvbGxJbmZvOiAodGV4dCkgPT4gdGV4dCxcblx0XHRub01hdGNoOiAodGV4dCkgPT4gdGV4dCxcblx0fSxcbn07XG5cbmRlc2NyaWJlKFwiRWRpdG9yXCIsICgpID0+IHtcblx0aXQoXCJjbGVhcnMgYnJhY2tldGVkIHBhc3RlIHN0YXRlIHdoZW4gZm9jdXMgaXMgbG9zdFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgZWRpdG9yID0gbmV3IEVkaXRvcihuZXcgVFVJKG1ha2VUZXJtaW5hbCgpKSwgdGhlbWUpO1xuXHRcdGVkaXRvci5mb2N1c2VkID0gdHJ1ZTtcblxuXHRcdGVkaXRvci5oYW5kbGVJbnB1dChcIlxceDFiWzIwMH5wYXJ0aWFsXCIpO1xuXHRcdGVkaXRvci5mb2N1c2VkID0gZmFsc2U7XG5cdFx0ZWRpdG9yLmZvY3VzZWQgPSB0cnVlO1xuXHRcdGVkaXRvci5oYW5kbGVJbnB1dChcImhlbGxvXCIpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKGVkaXRvci5nZXRUZXh0KCksIFwiaGVsbG9cIik7XG5cdH0pO1xuXG5cdGl0KFwia2VlcHMgdGhlIGhhcmR3YXJlIGN1cnNvciBtYXJrZXIgdmlzaWJsZSB3aGlsZSBhdXRvY29tcGxldGUgaXMgb3BlblwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgZWRpdG9yID0gbmV3IEVkaXRvcihuZXcgVFVJKG1ha2VUZXJtaW5hbCgpKSwgdGhlbWUpO1xuXHRcdGVkaXRvci5mb2N1c2VkID0gdHJ1ZTtcblx0XHRlZGl0b3Iuc2V0VGV4dChcIi9zZVwiKTtcblxuXHRcdChlZGl0b3IgYXMgYW55KS5hdXRvY29tcGxldGVTdGF0ZSA9IFwicmVndWxhclwiO1xuXHRcdChlZGl0b3IgYXMgYW55KS5hdXRvY29tcGxldGVMaXN0ID0geyByZW5kZXI6ICgpID0+IFtdIH07XG5cblx0XHRjb25zdCByZW5kZXJlZCA9IGVkaXRvci5yZW5kZXIoNDApLmpvaW4oXCJcXG5cIik7XG5cblx0XHRhc3NlcnQub2socmVuZGVyZWQuaW5jbHVkZXMoQ1VSU09SX01BUktFUikpO1xuXHR9KTtcblxuXHRpdChcIm1hcHMga2l0dHkga2V5cGFkIGRpZ2l0cyB0byBwbGFpbiBlZGl0b3IgdGV4dFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgZWRpdG9yID0gbmV3IEVkaXRvcihuZXcgVFVJKG1ha2VUZXJtaW5hbCgpKSwgdGhlbWUpO1xuXHRcdGVkaXRvci5mb2N1c2VkID0gdHJ1ZTtcblxuXHRcdGVkaXRvci5oYW5kbGVJbnB1dChcIlxceDFiWzU3NDA0OzEyOXVcIik7XG5cblx0XHRhc3NlcnQuZXF1YWwoZWRpdG9yLmdldFRleHQoKSwgXCI1XCIpO1xuXHR9KTtcblxuXHRpdChcImRvZXMgbm90IGluc2VydCBraXR0eSBrZXlwYWQgbmF2aWdhdGlvbiBwcml2YXRlLXVzZSBnbHlwaHMgaW50byB0aGUgZWRpdG9yXCIsICgpID0+IHtcblx0XHRjb25zdCBlZGl0b3IgPSBuZXcgRWRpdG9yKG5ldyBUVUkobWFrZVRlcm1pbmFsKCkpLCB0aGVtZSk7XG5cdFx0ZWRpdG9yLmZvY3VzZWQgPSB0cnVlO1xuXG5cdFx0ZWRpdG9yLmhhbmRsZUlucHV0KFwiXFx4MWJbNTc0MTl1XCIpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKGVkaXRvci5nZXRUZXh0KCksIFwiXCIpO1xuXHR9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxZQUFZO0FBQ25CLFNBQVMsVUFBVSxVQUFVO0FBRTdCLFNBQVMsY0FBZ0M7QUFDekMsU0FBUyxlQUFlLFdBQVc7QUFHbkMsU0FBUyxlQUF5QjtBQUNqQyxTQUFPO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxTQUFTO0FBQUEsSUFDVCxNQUFNO0FBQUEsSUFDTixxQkFBcUI7QUFBQSxJQUNyQixRQUFRO0FBQUEsSUFBQztBQUFBLElBQ1QsT0FBTztBQUFBLElBQUM7QUFBQSxJQUNSLFlBQVksWUFBWTtBQUFBLElBQUM7QUFBQSxJQUN6QixRQUFRO0FBQUEsSUFBQztBQUFBLElBQ1QsU0FBUztBQUFBLElBQUM7QUFBQSxJQUNWLGFBQWE7QUFBQSxJQUFDO0FBQUEsSUFDZCxhQUFhO0FBQUEsSUFBQztBQUFBLElBQ2QsWUFBWTtBQUFBLElBQUM7QUFBQSxJQUNiLGtCQUFrQjtBQUFBLElBQUM7QUFBQSxJQUNuQixjQUFjO0FBQUEsSUFBQztBQUFBLElBQ2YsV0FBVztBQUFBLElBQUM7QUFBQSxFQUNiO0FBQ0Q7QUFFQSxNQUFNLFFBQXFCO0FBQUEsRUFDMUIsYUFBYSxDQUFDLFNBQVM7QUFBQSxFQUN2QixZQUFZO0FBQUEsSUFDWCxnQkFBZ0IsQ0FBQyxTQUFTO0FBQUEsSUFDMUIsY0FBYyxDQUFDLFNBQVM7QUFBQSxJQUN4QixhQUFhLENBQUMsU0FBUztBQUFBLElBQ3ZCLFlBQVksQ0FBQyxTQUFTO0FBQUEsSUFDdEIsU0FBUyxDQUFDLFNBQVM7QUFBQSxFQUNwQjtBQUNEO0FBRUEsU0FBUyxVQUFVLE1BQU07QUFDeEIsS0FBRyxtREFBbUQsTUFBTTtBQUMzRCxVQUFNLFNBQVMsSUFBSSxPQUFPLElBQUksSUFBSSxhQUFhLENBQUMsR0FBRyxLQUFLO0FBQ3hELFdBQU8sVUFBVTtBQUVqQixXQUFPLFlBQVksa0JBQWtCO0FBQ3JDLFdBQU8sVUFBVTtBQUNqQixXQUFPLFVBQVU7QUFDakIsV0FBTyxZQUFZLE9BQU87QUFFMUIsV0FBTyxNQUFNLE9BQU8sUUFBUSxHQUFHLE9BQU87QUFBQSxFQUN2QyxDQUFDO0FBRUQsS0FBRyx1RUFBdUUsTUFBTTtBQUMvRSxVQUFNLFNBQVMsSUFBSSxPQUFPLElBQUksSUFBSSxhQUFhLENBQUMsR0FBRyxLQUFLO0FBQ3hELFdBQU8sVUFBVTtBQUNqQixXQUFPLFFBQVEsS0FBSztBQUVwQixJQUFDLE9BQWUsb0JBQW9CO0FBQ3BDLElBQUMsT0FBZSxtQkFBbUIsRUFBRSxRQUFRLE1BQU0sQ0FBQyxFQUFFO0FBRXRELFVBQU0sV0FBVyxPQUFPLE9BQU8sRUFBRSxFQUFFLEtBQUssSUFBSTtBQUU1QyxXQUFPLEdBQUcsU0FBUyxTQUFTLGFBQWEsQ0FBQztBQUFBLEVBQzNDLENBQUM7QUFFRCxLQUFHLGlEQUFpRCxNQUFNO0FBQ3pELFVBQU0sU0FBUyxJQUFJLE9BQU8sSUFBSSxJQUFJLGFBQWEsQ0FBQyxHQUFHLEtBQUs7QUFDeEQsV0FBTyxVQUFVO0FBRWpCLFdBQU8sWUFBWSxpQkFBaUI7QUFFcEMsV0FBTyxNQUFNLE9BQU8sUUFBUSxHQUFHLEdBQUc7QUFBQSxFQUNuQyxDQUFDO0FBRUQsS0FBRyw4RUFBOEUsTUFBTTtBQUN0RixVQUFNLFNBQVMsSUFBSSxPQUFPLElBQUksSUFBSSxhQUFhLENBQUMsR0FBRyxLQUFLO0FBQ3hELFdBQU8sVUFBVTtBQUVqQixXQUFPLFlBQVksYUFBYTtBQUVoQyxXQUFPLE1BQU0sT0FBTyxRQUFRLEdBQUcsRUFBRTtBQUFBLEVBQ2xDLENBQUM7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
