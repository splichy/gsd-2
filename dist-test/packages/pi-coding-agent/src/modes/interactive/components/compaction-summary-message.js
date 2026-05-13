import { Container, Markdown, Text } from "@gsd/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { renderChatFrame } from "./chat-frame.js";
import { editorKey } from "./keybinding-hints.js";
class CompactionSummaryMessageComponent extends Container {
  constructor(message, markdownTheme = getMarkdownTheme()) {
    super();
    this.expanded = false;
    this.message = message;
    this.markdownTheme = markdownTheme;
    this.rebuild();
  }
  setExpanded(expanded) {
    if (this.expanded !== expanded) {
      this.expanded = expanded;
      this.rebuild();
    }
  }
  invalidate() {
    super.invalidate();
    this.rebuild();
  }
  rebuild() {
    this.clear();
    const tokenStr = this.message.tokensBefore.toLocaleString();
    if (this.expanded) {
      const header = `**Compacted from ${tokenStr} tokens**

`;
      this.addChild(
        new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
          color: (text) => theme.fg("customMessageText", text)
        })
      );
    } else {
      this.addChild(
        new Text(
          theme.fg(
            "customMessageText",
            `Compacted from ${tokenStr} tokens (`
          ) + theme.fg("dim", editorKey("expandTools")) + theme.fg("customMessageText", " to expand)"),
          0,
          0
        )
      );
    }
  }
  render(width) {
    const frameWidth = Math.max(20, width);
    const contentWidth = Math.max(1, frameWidth - 4);
    const lines = super.render(contentWidth);
    const framed = renderChatFrame(lines, frameWidth, {
      label: "compaction",
      tone: "compaction",
      timestampFormat: "date-time-iso",
      showTimestamp: false
    });
    return framed.length > 0 ? ["", ...framed] : framed;
  }
}
export {
  CompactionSummaryMessageComponent
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL2NvbXBhY3Rpb24tc3VtbWFyeS1tZXNzYWdlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBDb250YWluZXIsIE1hcmtkb3duLCB0eXBlIE1hcmtkb3duVGhlbWUsIFRleHQgfSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB0eXBlIHsgQ29tcGFjdGlvblN1bW1hcnlNZXNzYWdlIH0gZnJvbSBcIi4uLy4uLy4uL2NvcmUvbWVzc2FnZXMuanNcIjtcbmltcG9ydCB7IGdldE1hcmtkb3duVGhlbWUsIHRoZW1lIH0gZnJvbSBcIi4uL3RoZW1lL3RoZW1lLmpzXCI7XG5pbXBvcnQgeyByZW5kZXJDaGF0RnJhbWUgfSBmcm9tIFwiLi9jaGF0LWZyYW1lLmpzXCI7XG5pbXBvcnQgeyBlZGl0b3JLZXkgfSBmcm9tIFwiLi9rZXliaW5kaW5nLWhpbnRzLmpzXCI7XG5cbi8qKlxuICogUmVuZGVycyBhIGNvbXBhY3Rpb24gbm90aWNlIGluIHRoZSBzaGFyZWQgY2hhdC1mcmFtZSBzdHlsZSAodG9wIHJ1bGUsXG4gKiBgXHUyMDIyIGNvbXBhY3Rpb25gIGhlYWRlciwgYFx1MjUwMiBgIGJvZHkgbWFyZ2luKSB3aXRoIHB1cnBsZSBib3JkZXIvbGFiZWwgc28gaXRcbiAqIHZpc3VhbGx5IG1hdGNoZXMgdGhlIG90aGVyIGZyYW1lZCBtZXNzYWdlcyAodXNlciAvIGFzc2lzdGFudCAvIHRvb2xcbiAqIGV4ZWN1dGlvbikgd2hpbGUgc3RhbmRpbmcgYXBhcnQgZnJvbSB0aGUgY29udmVyc2F0aW9uIGZsb3cuXG4gKi9cbmV4cG9ydCBjbGFzcyBDb21wYWN0aW9uU3VtbWFyeU1lc3NhZ2VDb21wb25lbnQgZXh0ZW5kcyBDb250YWluZXIge1xuXHRwcml2YXRlIGV4cGFuZGVkID0gZmFsc2U7XG5cdHByaXZhdGUgbWVzc2FnZTogQ29tcGFjdGlvblN1bW1hcnlNZXNzYWdlO1xuXHRwcml2YXRlIG1hcmtkb3duVGhlbWU6IE1hcmtkb3duVGhlbWU7XG5cblx0Y29uc3RydWN0b3IoXG5cdFx0bWVzc2FnZTogQ29tcGFjdGlvblN1bW1hcnlNZXNzYWdlLFxuXHRcdG1hcmtkb3duVGhlbWU6IE1hcmtkb3duVGhlbWUgPSBnZXRNYXJrZG93blRoZW1lKCksXG5cdCkge1xuXHRcdHN1cGVyKCk7XG5cdFx0dGhpcy5tZXNzYWdlID0gbWVzc2FnZTtcblx0XHR0aGlzLm1hcmtkb3duVGhlbWUgPSBtYXJrZG93blRoZW1lO1xuXHRcdHRoaXMucmVidWlsZCgpO1xuXHR9XG5cblx0c2V0RXhwYW5kZWQoZXhwYW5kZWQ6IGJvb2xlYW4pOiB2b2lkIHtcblx0XHRpZiAodGhpcy5leHBhbmRlZCAhPT0gZXhwYW5kZWQpIHtcblx0XHRcdHRoaXMuZXhwYW5kZWQgPSBleHBhbmRlZDtcblx0XHRcdHRoaXMucmVidWlsZCgpO1xuXHRcdH1cblx0fVxuXG5cdG92ZXJyaWRlIGludmFsaWRhdGUoKTogdm9pZCB7XG5cdFx0c3VwZXIuaW52YWxpZGF0ZSgpO1xuXHRcdHRoaXMucmVidWlsZCgpO1xuXHR9XG5cblx0cHJpdmF0ZSByZWJ1aWxkKCk6IHZvaWQge1xuXHRcdHRoaXMuY2xlYXIoKTtcblxuXHRcdGNvbnN0IHRva2VuU3RyID0gdGhpcy5tZXNzYWdlLnRva2Vuc0JlZm9yZS50b0xvY2FsZVN0cmluZygpO1xuXG5cdFx0aWYgKHRoaXMuZXhwYW5kZWQpIHtcblx0XHRcdGNvbnN0IGhlYWRlciA9IGAqKkNvbXBhY3RlZCBmcm9tICR7dG9rZW5TdHJ9IHRva2VucyoqXFxuXFxuYDtcblx0XHRcdHRoaXMuYWRkQ2hpbGQoXG5cdFx0XHRcdG5ldyBNYXJrZG93bihoZWFkZXIgKyB0aGlzLm1lc3NhZ2Uuc3VtbWFyeSwgMCwgMCwgdGhpcy5tYXJrZG93blRoZW1lLCB7XG5cdFx0XHRcdFx0Y29sb3I6ICh0ZXh0OiBzdHJpbmcpID0+IHRoZW1lLmZnKFwiY3VzdG9tTWVzc2FnZVRleHRcIiwgdGV4dCksXG5cdFx0XHRcdH0pLFxuXHRcdFx0KTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5hZGRDaGlsZChcblx0XHRcdFx0bmV3IFRleHQoXG5cdFx0XHRcdFx0dGhlbWUuZmcoXG5cdFx0XHRcdFx0XHRcImN1c3RvbU1lc3NhZ2VUZXh0XCIsXG5cdFx0XHRcdFx0XHRgQ29tcGFjdGVkIGZyb20gJHt0b2tlblN0cn0gdG9rZW5zIChgLFxuXHRcdFx0XHRcdCkgK1xuXHRcdFx0XHRcdFx0dGhlbWUuZmcoXCJkaW1cIiwgZWRpdG9yS2V5KFwiZXhwYW5kVG9vbHNcIikpICtcblx0XHRcdFx0XHRcdHRoZW1lLmZnKFwiY3VzdG9tTWVzc2FnZVRleHRcIiwgXCIgdG8gZXhwYW5kKVwiKSxcblx0XHRcdFx0XHQwLFxuXHRcdFx0XHRcdDAsXG5cdFx0XHRcdCksXG5cdFx0XHQpO1xuXHRcdH1cblx0fVxuXG5cdG92ZXJyaWRlIHJlbmRlcih3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuXHRcdGNvbnN0IGZyYW1lV2lkdGggPSBNYXRoLm1heCgyMCwgd2lkdGgpO1xuXHRcdGNvbnN0IGNvbnRlbnRXaWR0aCA9IE1hdGgubWF4KDEsIGZyYW1lV2lkdGggLSA0KTtcblx0XHRjb25zdCBsaW5lcyA9IHN1cGVyLnJlbmRlcihjb250ZW50V2lkdGgpO1xuXHRcdGNvbnN0IGZyYW1lZCA9IHJlbmRlckNoYXRGcmFtZShsaW5lcywgZnJhbWVXaWR0aCwge1xuXHRcdFx0bGFiZWw6IFwiY29tcGFjdGlvblwiLFxuXHRcdFx0dG9uZTogXCJjb21wYWN0aW9uXCIsXG5cdFx0XHR0aW1lc3RhbXBGb3JtYXQ6IFwiZGF0ZS10aW1lLWlzb1wiLFxuXHRcdFx0c2hvd1RpbWVzdGFtcDogZmFsc2UsXG5cdFx0fSk7XG5cdFx0cmV0dXJuIGZyYW1lZC5sZW5ndGggPiAwID8gW1wiXCIsIC4uLmZyYW1lZF0gOiBmcmFtZWQ7XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsV0FBVyxVQUE4QixZQUFZO0FBRTlELFNBQVMsa0JBQWtCLGFBQWE7QUFDeEMsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyxpQkFBaUI7QUFRbkIsTUFBTSwwQ0FBMEMsVUFBVTtBQUFBLEVBS2hFLFlBQ0MsU0FDQSxnQkFBK0IsaUJBQWlCLEdBQy9DO0FBQ0QsVUFBTTtBQVJQLFNBQVEsV0FBVztBQVNsQixTQUFLLFVBQVU7QUFDZixTQUFLLGdCQUFnQjtBQUNyQixTQUFLLFFBQVE7QUFBQSxFQUNkO0FBQUEsRUFFQSxZQUFZLFVBQXlCO0FBQ3BDLFFBQUksS0FBSyxhQUFhLFVBQVU7QUFDL0IsV0FBSyxXQUFXO0FBQ2hCLFdBQUssUUFBUTtBQUFBLElBQ2Q7QUFBQSxFQUNEO0FBQUEsRUFFUyxhQUFtQjtBQUMzQixVQUFNLFdBQVc7QUFDakIsU0FBSyxRQUFRO0FBQUEsRUFDZDtBQUFBLEVBRVEsVUFBZ0I7QUFDdkIsU0FBSyxNQUFNO0FBRVgsVUFBTSxXQUFXLEtBQUssUUFBUSxhQUFhLGVBQWU7QUFFMUQsUUFBSSxLQUFLLFVBQVU7QUFDbEIsWUFBTSxTQUFTLG9CQUFvQixRQUFRO0FBQUE7QUFBQTtBQUMzQyxXQUFLO0FBQUEsUUFDSixJQUFJLFNBQVMsU0FBUyxLQUFLLFFBQVEsU0FBUyxHQUFHLEdBQUcsS0FBSyxlQUFlO0FBQUEsVUFDckUsT0FBTyxDQUFDLFNBQWlCLE1BQU0sR0FBRyxxQkFBcUIsSUFBSTtBQUFBLFFBQzVELENBQUM7QUFBQSxNQUNGO0FBQUEsSUFDRCxPQUFPO0FBQ04sV0FBSztBQUFBLFFBQ0osSUFBSTtBQUFBLFVBQ0gsTUFBTTtBQUFBLFlBQ0w7QUFBQSxZQUNBLGtCQUFrQixRQUFRO0FBQUEsVUFDM0IsSUFDQyxNQUFNLEdBQUcsT0FBTyxVQUFVLGFBQWEsQ0FBQyxJQUN4QyxNQUFNLEdBQUcscUJBQXFCLGFBQWE7QUFBQSxVQUM1QztBQUFBLFVBQ0E7QUFBQSxRQUNEO0FBQUEsTUFDRDtBQUFBLElBQ0Q7QUFBQSxFQUNEO0FBQUEsRUFFUyxPQUFPLE9BQXlCO0FBQ3hDLFVBQU0sYUFBYSxLQUFLLElBQUksSUFBSSxLQUFLO0FBQ3JDLFVBQU0sZUFBZSxLQUFLLElBQUksR0FBRyxhQUFhLENBQUM7QUFDL0MsVUFBTSxRQUFRLE1BQU0sT0FBTyxZQUFZO0FBQ3ZDLFVBQU0sU0FBUyxnQkFBZ0IsT0FBTyxZQUFZO0FBQUEsTUFDakQsT0FBTztBQUFBLE1BQ1AsTUFBTTtBQUFBLE1BQ04saUJBQWlCO0FBQUEsTUFDakIsZUFBZTtBQUFBLElBQ2hCLENBQUM7QUFDRCxXQUFPLE9BQU8sU0FBUyxJQUFJLENBQUMsSUFBSSxHQUFHLE1BQU0sSUFBSTtBQUFBLEVBQzlDO0FBQ0Q7IiwKICAibmFtZXMiOiBbXQp9Cg==
