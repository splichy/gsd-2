import { style, truncateToWidth } from "@gsd/pi-tui";
import { resolveTuiMode } from "../tui-mode.js";
import { theme } from "../theme/theme.js";
import { alignRight, breakpoint, keyValue, roundedPanel } from "./tui-style-kit.js";
class AdaptiveLayoutComponent {
  constructor(getState) {
    this.getState = getState;
  }
  invalidate() {
  }
  render(width) {
    const state = this.getState();
    const mode = resolveTuiMode({
      terminalWidth: width,
      override: state.override,
      activeToolCount: state.activeToolCount,
      gsdPhase: state.gsdPhase,
      hasBlockingError: !!state.lastError
    });
    if (state.override === "auto" && mode === "chat" && !state.gsdPhase && !state.lastError && state.activeToolCount === 0) {
      return [];
    }
    if (mode === "compact" || width < 72) return this.renderCompact(width, mode, state);
    if (mode === "debug") return this.renderDebug(width, state);
    if (mode === "validation") return this.renderValidation(width, state);
    if (mode === "workflow") return this.renderWorkflow(width, state);
    return this.renderChat(width, state);
  }
  renderWorkflow(width, state) {
    if (width < 72) return this.renderCompact(width, "workflow", state);
    const phase = state.gsdPhase ?? "Ready";
    const tools = state.activeToolCount > 0 ? `${state.activeToolCount} running` : "idle";
    const next = state.activeToolCount > 0 ? "watch tool output" : "continue from prompt";
    const modeLabel = state.override === "auto" ? "workflow" : state.override;
    const bp = breakpoint(width);
    const rows = bp === "regular" ? [
      keyValue("Status", phase, "modeWorkflow"),
      keyValue("Tools", tools, state.activeToolCount > 0 ? "toolRunning" : "toolMuted"),
      keyValue("Session", state.sessionName ?? "current", "text"),
      keyValue("Next", next, "surfaceAccent")
    ] : [
      alignRight(
        keyValue("Status", phase, "modeWorkflow"),
        keyValue("Tools", tools, state.activeToolCount > 0 ? "toolRunning" : "toolMuted"),
        Math.max(1, width - 2)
      ),
      alignRight(
        keyValue("Session", state.sessionName ?? "current", "text"),
        keyValue("Path", this.basename(state.cwd), "text"),
        Math.max(1, width - 2)
      ),
      alignRight(
        keyValue("Next", next, "surfaceAccent"),
        keyValue("Mode", modeLabel, "modeWorkflow"),
        Math.max(1, width - 2)
      )
    ];
    return roundedPanel(rows, width, {
      title: "GSD Command Center",
      rightTitle: `${modeLabel} \xB7 ${state.lastError ? "blocked" : "ready"}`,
      tone: state.lastError ? "error" : "default"
    });
  }
  renderValidation(width, state) {
    const phase = state.gsdPhase ?? "Validation pending";
    return this.frame(
      [
        this.metric("Focus", phase, "modeValidation"),
        this.metric("Checks", state.activeToolCount > 0 ? `${state.activeToolCount} active` : "waiting", "toolRunning"),
        this.metric("Timeline", state.lastError ? "blocked" : "ready for completion evidence", state.lastError ? "toolError" : "toolSuccess")
      ],
      width,
      "validation",
      state.override === "auto" ? "auto" : state.override,
      "modeValidation"
    );
  }
  renderDebug(width, state) {
    const error = state.lastError ?? "Blocking error detected";
    return this.frame(
      [
        this.metric("Failure", truncateToWidth(error, Math.max(20, width - 20), ""), "toolError"),
        this.metric("Tools", state.activeToolCount > 0 ? `${state.activeToolCount} still running` : "none running", "toolRunning"),
        this.metric("Next", "inspect the failed output, then retry the smallest step", "modeDebug")
      ],
      width,
      "blocking failure",
      "debug",
      "modeDebug"
    );
  }
  renderChat(width, state) {
    return this.frame(
      [
        this.metric("Mode", state.override === "auto" ? "auto chat" : state.override, "surfaceAccent"),
        this.metric("Tools", state.activeToolCount > 0 ? `${state.activeToolCount} active` : "compact rows", "toolMuted")
      ],
      width,
      "chat",
      state.sessionName ?? "conversation",
      "surfaceAccent"
    );
  }
  renderCompact(width, mode, state) {
    const phase = state.lastError ?? state.gsdPhase ?? (state.activeToolCount > 0 ? `${state.activeToolCount} tools` : "ready");
    const line = `${theme.fg("modeCompact", "GSD compact")} ${theme.fg("surfaceMuted", `${mode} \xB7 ${phase}`)}`;
    return style().border("minimal").borderColor((text) => theme.fg("surfaceBorder", text)).bodyGutter(" ").render([line], width);
  }
  frame(lines, width, title, rightTitle, accent) {
    return style().border("rule").density("compact").toneColor((text) => theme.fg("surfaceMuted", text)).borderColor((text) => theme.fg("surfaceBorder", text)).title(theme.fg("surfaceTitle", title)).rightTitle(theme.fg(accent, rightTitle)).bodyGutter(theme.fg(accent, "\u2502 ")).render(lines, width);
  }
  metric(label, value, color) {
    return `${theme.fg("surfaceMuted", `${label.padEnd(8)} `)}${theme.fg(color, value)}`;
  }
  basename(cwd) {
    const trimmed = cwd.replace(/[\\/]+$/, "");
    if (!trimmed) return cwd.includes("\\") ? "\\" : "/";
    const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return slash === -1 ? trimmed : trimmed.slice(slash + 1);
  }
}
export {
  AdaptiveLayoutComponent
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL2FkYXB0aXZlLWxheW91dC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IEFkYXB0aXZlIGNvbW1hbmQtY2VudGVyIGRhc2hib2FyZCBmb3IgdGhlIGludGVyYWN0aXZlIFRVSS5cblxuaW1wb3J0IHsgc3R5bGUsIHRydW5jYXRlVG9XaWR0aCwgdHlwZSBDb21wb25lbnQgfSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB0eXBlIHsgVHVpQWRhcHRpdmVNb2RlLCBUdWlNb2RlIH0gZnJvbSBcIi4uL3R1aS1tb2RlLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlVHVpTW9kZSB9IGZyb20gXCIuLi90dWktbW9kZS5qc1wiO1xuaW1wb3J0IHsgdGhlbWUsIHR5cGUgVGhlbWVDb2xvciB9IGZyb20gXCIuLi90aGVtZS90aGVtZS5qc1wiO1xuaW1wb3J0IHsgYWxpZ25SaWdodCwgYnJlYWtwb2ludCwga2V5VmFsdWUsIHJvdW5kZWRQYW5lbCB9IGZyb20gXCIuL3R1aS1zdHlsZS1raXQuanNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBZGFwdGl2ZUxheW91dFN0YXRlIHtcblx0b3ZlcnJpZGU6IFR1aUFkYXB0aXZlTW9kZTtcblx0YWN0aXZlVG9vbENvdW50OiBudW1iZXI7XG5cdGdzZFBoYXNlPzogc3RyaW5nO1xuXHRsYXN0RXJyb3I/OiBzdHJpbmc7XG5cdHNlc3Npb25OYW1lPzogc3RyaW5nO1xuXHRjd2Q6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEFkYXB0aXZlTGF5b3V0Q29tcG9uZW50IGltcGxlbWVudHMgQ29tcG9uZW50IHtcblx0Y29uc3RydWN0b3IocHJpdmF0ZSByZWFkb25seSBnZXRTdGF0ZTogKCkgPT4gQWRhcHRpdmVMYXlvdXRTdGF0ZSkge31cblxuXHRpbnZhbGlkYXRlKCk6IHZvaWQge31cblxuXHRyZW5kZXIod2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcblx0XHRjb25zdCBzdGF0ZSA9IHRoaXMuZ2V0U3RhdGUoKTtcblx0XHRjb25zdCBtb2RlID0gcmVzb2x2ZVR1aU1vZGUoe1xuXHRcdFx0dGVybWluYWxXaWR0aDogd2lkdGgsXG5cdFx0XHRvdmVycmlkZTogc3RhdGUub3ZlcnJpZGUsXG5cdFx0XHRhY3RpdmVUb29sQ291bnQ6IHN0YXRlLmFjdGl2ZVRvb2xDb3VudCxcblx0XHRcdGdzZFBoYXNlOiBzdGF0ZS5nc2RQaGFzZSxcblx0XHRcdGhhc0Jsb2NraW5nRXJyb3I6ICEhc3RhdGUubGFzdEVycm9yLFxuXHRcdH0pO1xuXG5cdFx0aWYgKHN0YXRlLm92ZXJyaWRlID09PSBcImF1dG9cIiAmJiBtb2RlID09PSBcImNoYXRcIiAmJiAhc3RhdGUuZ3NkUGhhc2UgJiYgIXN0YXRlLmxhc3RFcnJvciAmJiBzdGF0ZS5hY3RpdmVUb29sQ291bnQgPT09IDApIHtcblx0XHRcdHJldHVybiBbXTtcblx0XHR9XG5cblx0XHRpZiAobW9kZSA9PT0gXCJjb21wYWN0XCIgfHwgd2lkdGggPCA3MikgcmV0dXJuIHRoaXMucmVuZGVyQ29tcGFjdCh3aWR0aCwgbW9kZSwgc3RhdGUpO1xuXHRcdGlmIChtb2RlID09PSBcImRlYnVnXCIpIHJldHVybiB0aGlzLnJlbmRlckRlYnVnKHdpZHRoLCBzdGF0ZSk7XG5cdFx0aWYgKG1vZGUgPT09IFwidmFsaWRhdGlvblwiKSByZXR1cm4gdGhpcy5yZW5kZXJWYWxpZGF0aW9uKHdpZHRoLCBzdGF0ZSk7XG5cdFx0aWYgKG1vZGUgPT09IFwid29ya2Zsb3dcIikgcmV0dXJuIHRoaXMucmVuZGVyV29ya2Zsb3cod2lkdGgsIHN0YXRlKTtcblx0XHRyZXR1cm4gdGhpcy5yZW5kZXJDaGF0KHdpZHRoLCBzdGF0ZSk7XG5cdH1cblxuXHRwcml2YXRlIHJlbmRlcldvcmtmbG93KHdpZHRoOiBudW1iZXIsIHN0YXRlOiBBZGFwdGl2ZUxheW91dFN0YXRlKTogc3RyaW5nW10ge1xuXHRcdGlmICh3aWR0aCA8IDcyKSByZXR1cm4gdGhpcy5yZW5kZXJDb21wYWN0KHdpZHRoLCBcIndvcmtmbG93XCIsIHN0YXRlKTtcblxuXHRcdGNvbnN0IHBoYXNlID0gc3RhdGUuZ3NkUGhhc2UgPz8gXCJSZWFkeVwiO1xuXHRcdGNvbnN0IHRvb2xzID0gc3RhdGUuYWN0aXZlVG9vbENvdW50ID4gMCA/IGAke3N0YXRlLmFjdGl2ZVRvb2xDb3VudH0gcnVubmluZ2AgOiBcImlkbGVcIjtcblx0XHRjb25zdCBuZXh0ID0gc3RhdGUuYWN0aXZlVG9vbENvdW50ID4gMCA/IFwid2F0Y2ggdG9vbCBvdXRwdXRcIiA6IFwiY29udGludWUgZnJvbSBwcm9tcHRcIjtcblx0XHRjb25zdCBtb2RlTGFiZWwgPSBzdGF0ZS5vdmVycmlkZSA9PT0gXCJhdXRvXCIgPyBcIndvcmtmbG93XCIgOiBzdGF0ZS5vdmVycmlkZTtcblx0XHRjb25zdCBicCA9IGJyZWFrcG9pbnQod2lkdGgpO1xuXG5cdFx0Y29uc3Qgcm93cyA9IGJwID09PSBcInJlZ3VsYXJcIlxuXHRcdFx0PyBbXG5cdFx0XHRcdFx0a2V5VmFsdWUoXCJTdGF0dXNcIiwgcGhhc2UsIFwibW9kZVdvcmtmbG93XCIpLFxuXHRcdFx0XHRcdGtleVZhbHVlKFwiVG9vbHNcIiwgdG9vbHMsIHN0YXRlLmFjdGl2ZVRvb2xDb3VudCA+IDAgPyBcInRvb2xSdW5uaW5nXCIgOiBcInRvb2xNdXRlZFwiKSxcblx0XHRcdFx0XHRrZXlWYWx1ZShcIlNlc3Npb25cIiwgc3RhdGUuc2Vzc2lvbk5hbWUgPz8gXCJjdXJyZW50XCIsIFwidGV4dFwiKSxcblx0XHRcdFx0XHRrZXlWYWx1ZShcIk5leHRcIiwgbmV4dCwgXCJzdXJmYWNlQWNjZW50XCIpLFxuXHRcdFx0XHRdXG5cdFx0XHQ6IFtcblx0XHRcdFx0XHRhbGlnblJpZ2h0KFxuXHRcdFx0XHRcdFx0a2V5VmFsdWUoXCJTdGF0dXNcIiwgcGhhc2UsIFwibW9kZVdvcmtmbG93XCIpLFxuXHRcdFx0XHRcdFx0a2V5VmFsdWUoXCJUb29sc1wiLCB0b29scywgc3RhdGUuYWN0aXZlVG9vbENvdW50ID4gMCA/IFwidG9vbFJ1bm5pbmdcIiA6IFwidG9vbE11dGVkXCIpLFxuXHRcdFx0XHRcdFx0TWF0aC5tYXgoMSwgd2lkdGggLSAyKSxcblx0XHRcdFx0XHQpLFxuXHRcdFx0XHRcdGFsaWduUmlnaHQoXG5cdFx0XHRcdFx0XHRrZXlWYWx1ZShcIlNlc3Npb25cIiwgc3RhdGUuc2Vzc2lvbk5hbWUgPz8gXCJjdXJyZW50XCIsIFwidGV4dFwiKSxcblx0XHRcdFx0XHRcdGtleVZhbHVlKFwiUGF0aFwiLCB0aGlzLmJhc2VuYW1lKHN0YXRlLmN3ZCksIFwidGV4dFwiKSxcblx0XHRcdFx0XHRcdE1hdGgubWF4KDEsIHdpZHRoIC0gMiksXG5cdFx0XHRcdFx0KSxcblx0XHRcdFx0XHRhbGlnblJpZ2h0KFxuXHRcdFx0XHRcdFx0a2V5VmFsdWUoXCJOZXh0XCIsIG5leHQsIFwic3VyZmFjZUFjY2VudFwiKSxcblx0XHRcdFx0XHRcdGtleVZhbHVlKFwiTW9kZVwiLCBtb2RlTGFiZWwsIFwibW9kZVdvcmtmbG93XCIpLFxuXHRcdFx0XHRcdFx0TWF0aC5tYXgoMSwgd2lkdGggLSAyKSxcblx0XHRcdFx0XHQpLFxuXHRcdFx0XHRdO1xuXG5cdFx0cmV0dXJuIHJvdW5kZWRQYW5lbChyb3dzLCB3aWR0aCwge1xuXHRcdFx0dGl0bGU6IFwiR1NEIENvbW1hbmQgQ2VudGVyXCIsXG5cdFx0XHRyaWdodFRpdGxlOiBgJHttb2RlTGFiZWx9IFx1MDBCNyAke3N0YXRlLmxhc3RFcnJvciA/IFwiYmxvY2tlZFwiIDogXCJyZWFkeVwifWAsXG5cdFx0XHR0b25lOiBzdGF0ZS5sYXN0RXJyb3IgPyBcImVycm9yXCIgOiBcImRlZmF1bHRcIixcblx0XHR9KTtcblx0fVxuXG5cdHByaXZhdGUgcmVuZGVyVmFsaWRhdGlvbih3aWR0aDogbnVtYmVyLCBzdGF0ZTogQWRhcHRpdmVMYXlvdXRTdGF0ZSk6IHN0cmluZ1tdIHtcblx0XHRjb25zdCBwaGFzZSA9IHN0YXRlLmdzZFBoYXNlID8/IFwiVmFsaWRhdGlvbiBwZW5kaW5nXCI7XG5cdFx0cmV0dXJuIHRoaXMuZnJhbWUoXG5cdFx0XHRbXG5cdFx0XHRcdHRoaXMubWV0cmljKFwiRm9jdXNcIiwgcGhhc2UsIFwibW9kZVZhbGlkYXRpb25cIiksXG5cdFx0XHRcdHRoaXMubWV0cmljKFwiQ2hlY2tzXCIsIHN0YXRlLmFjdGl2ZVRvb2xDb3VudCA+IDAgPyBgJHtzdGF0ZS5hY3RpdmVUb29sQ291bnR9IGFjdGl2ZWAgOiBcIndhaXRpbmdcIiwgXCJ0b29sUnVubmluZ1wiKSxcblx0XHRcdFx0dGhpcy5tZXRyaWMoXCJUaW1lbGluZVwiLCBzdGF0ZS5sYXN0RXJyb3IgPyBcImJsb2NrZWRcIiA6IFwicmVhZHkgZm9yIGNvbXBsZXRpb24gZXZpZGVuY2VcIiwgc3RhdGUubGFzdEVycm9yID8gXCJ0b29sRXJyb3JcIiA6IFwidG9vbFN1Y2Nlc3NcIiksXG5cdFx0XHRdLFxuXHRcdFx0d2lkdGgsXG5cdFx0XHRcInZhbGlkYXRpb25cIixcblx0XHRcdHN0YXRlLm92ZXJyaWRlID09PSBcImF1dG9cIiA/IFwiYXV0b1wiIDogc3RhdGUub3ZlcnJpZGUsXG5cdFx0XHRcIm1vZGVWYWxpZGF0aW9uXCIsXG5cdFx0KTtcblx0fVxuXG5cdHByaXZhdGUgcmVuZGVyRGVidWcod2lkdGg6IG51bWJlciwgc3RhdGU6IEFkYXB0aXZlTGF5b3V0U3RhdGUpOiBzdHJpbmdbXSB7XG5cdFx0Y29uc3QgZXJyb3IgPSBzdGF0ZS5sYXN0RXJyb3IgPz8gXCJCbG9ja2luZyBlcnJvciBkZXRlY3RlZFwiO1xuXHRcdHJldHVybiB0aGlzLmZyYW1lKFxuXHRcdFx0W1xuXHRcdFx0XHR0aGlzLm1ldHJpYyhcIkZhaWx1cmVcIiwgdHJ1bmNhdGVUb1dpZHRoKGVycm9yLCBNYXRoLm1heCgyMCwgd2lkdGggLSAyMCksIFwiXCIpLCBcInRvb2xFcnJvclwiKSxcblx0XHRcdFx0dGhpcy5tZXRyaWMoXCJUb29sc1wiLCBzdGF0ZS5hY3RpdmVUb29sQ291bnQgPiAwID8gYCR7c3RhdGUuYWN0aXZlVG9vbENvdW50fSBzdGlsbCBydW5uaW5nYCA6IFwibm9uZSBydW5uaW5nXCIsIFwidG9vbFJ1bm5pbmdcIiksXG5cdFx0XHRcdHRoaXMubWV0cmljKFwiTmV4dFwiLCBcImluc3BlY3QgdGhlIGZhaWxlZCBvdXRwdXQsIHRoZW4gcmV0cnkgdGhlIHNtYWxsZXN0IHN0ZXBcIiwgXCJtb2RlRGVidWdcIiksXG5cdFx0XHRdLFxuXHRcdFx0d2lkdGgsXG5cdFx0XHRcImJsb2NraW5nIGZhaWx1cmVcIixcblx0XHRcdFwiZGVidWdcIixcblx0XHRcdFwibW9kZURlYnVnXCIsXG5cdFx0KTtcblx0fVxuXG5cdHByaXZhdGUgcmVuZGVyQ2hhdCh3aWR0aDogbnVtYmVyLCBzdGF0ZTogQWRhcHRpdmVMYXlvdXRTdGF0ZSk6IHN0cmluZ1tdIHtcblx0XHRyZXR1cm4gdGhpcy5mcmFtZShcblx0XHRcdFtcblx0XHRcdFx0dGhpcy5tZXRyaWMoXCJNb2RlXCIsIHN0YXRlLm92ZXJyaWRlID09PSBcImF1dG9cIiA/IFwiYXV0byBjaGF0XCIgOiBzdGF0ZS5vdmVycmlkZSwgXCJzdXJmYWNlQWNjZW50XCIpLFxuXHRcdFx0XHR0aGlzLm1ldHJpYyhcIlRvb2xzXCIsIHN0YXRlLmFjdGl2ZVRvb2xDb3VudCA+IDAgPyBgJHtzdGF0ZS5hY3RpdmVUb29sQ291bnR9IGFjdGl2ZWAgOiBcImNvbXBhY3Qgcm93c1wiLCBcInRvb2xNdXRlZFwiKSxcblx0XHRcdF0sXG5cdFx0XHR3aWR0aCxcblx0XHRcdFwiY2hhdFwiLFxuXHRcdFx0c3RhdGUuc2Vzc2lvbk5hbWUgPz8gXCJjb252ZXJzYXRpb25cIixcblx0XHRcdFwic3VyZmFjZUFjY2VudFwiLFxuXHRcdCk7XG5cdH1cblxuXHRwcml2YXRlIHJlbmRlckNvbXBhY3Qod2lkdGg6IG51bWJlciwgbW9kZTogVHVpTW9kZSwgc3RhdGU6IEFkYXB0aXZlTGF5b3V0U3RhdGUpOiBzdHJpbmdbXSB7XG5cdFx0Y29uc3QgcGhhc2UgPSBzdGF0ZS5sYXN0RXJyb3IgPz8gc3RhdGUuZ3NkUGhhc2UgPz8gKHN0YXRlLmFjdGl2ZVRvb2xDb3VudCA+IDAgPyBgJHtzdGF0ZS5hY3RpdmVUb29sQ291bnR9IHRvb2xzYCA6IFwicmVhZHlcIik7XG5cdFx0Y29uc3QgbGluZSA9IGAke3RoZW1lLmZnKFwibW9kZUNvbXBhY3RcIiwgXCJHU0QgY29tcGFjdFwiKX0gJHt0aGVtZS5mZyhcInN1cmZhY2VNdXRlZFwiLCBgJHttb2RlfSBcdTAwQjcgJHtwaGFzZX1gKX1gO1xuXHRcdHJldHVybiBzdHlsZSgpXG5cdFx0XHQuYm9yZGVyKFwibWluaW1hbFwiKVxuXHRcdFx0LmJvcmRlckNvbG9yKCh0ZXh0KSA9PiB0aGVtZS5mZyhcInN1cmZhY2VCb3JkZXJcIiwgdGV4dCkpXG5cdFx0XHQuYm9keUd1dHRlcihcIiBcIilcblx0XHRcdC5yZW5kZXIoW2xpbmVdLCB3aWR0aCk7XG5cdH1cblxuXHRwcml2YXRlIGZyYW1lKGxpbmVzOiBzdHJpbmdbXSwgd2lkdGg6IG51bWJlciwgdGl0bGU6IHN0cmluZywgcmlnaHRUaXRsZTogc3RyaW5nLCBhY2NlbnQ6IFRoZW1lQ29sb3IpOiBzdHJpbmdbXSB7XG5cdFx0cmV0dXJuIHN0eWxlKClcblx0XHRcdC5ib3JkZXIoXCJydWxlXCIpXG5cdFx0XHQuZGVuc2l0eShcImNvbXBhY3RcIilcblx0XHRcdC50b25lQ29sb3IoKHRleHQpID0+IHRoZW1lLmZnKFwic3VyZmFjZU11dGVkXCIsIHRleHQpKVxuXHRcdFx0LmJvcmRlckNvbG9yKCh0ZXh0KSA9PiB0aGVtZS5mZyhcInN1cmZhY2VCb3JkZXJcIiwgdGV4dCkpXG5cdFx0XHQudGl0bGUodGhlbWUuZmcoXCJzdXJmYWNlVGl0bGVcIiwgdGl0bGUpKVxuXHRcdFx0LnJpZ2h0VGl0bGUodGhlbWUuZmcoYWNjZW50LCByaWdodFRpdGxlKSlcblx0XHRcdC5ib2R5R3V0dGVyKHRoZW1lLmZnKGFjY2VudCwgXCJcdTI1MDIgXCIpKVxuXHRcdFx0LnJlbmRlcihsaW5lcywgd2lkdGgpO1xuXHR9XG5cblx0cHJpdmF0ZSBtZXRyaWMobGFiZWw6IHN0cmluZywgdmFsdWU6IHN0cmluZywgY29sb3I6IFRoZW1lQ29sb3IpOiBzdHJpbmcge1xuXHRcdHJldHVybiBgJHt0aGVtZS5mZyhcInN1cmZhY2VNdXRlZFwiLCBgJHtsYWJlbC5wYWRFbmQoOCl9IGApfSR7dGhlbWUuZmcoY29sb3IsIHZhbHVlKX1gO1xuXHR9XG5cblx0cHJpdmF0ZSBiYXNlbmFtZShjd2Q6IHN0cmluZyk6IHN0cmluZyB7XG5cdFx0Y29uc3QgdHJpbW1lZCA9IGN3ZC5yZXBsYWNlKC9bXFxcXC9dKyQvLCBcIlwiKTtcblx0XHRpZiAoIXRyaW1tZWQpIHJldHVybiBjd2QuaW5jbHVkZXMoXCJcXFxcXCIpID8gXCJcXFxcXCIgOiBcIi9cIjtcblx0XHRjb25zdCBzbGFzaCA9IE1hdGgubWF4KHRyaW1tZWQubGFzdEluZGV4T2YoXCIvXCIpLCB0cmltbWVkLmxhc3RJbmRleE9mKFwiXFxcXFwiKSk7XG5cdFx0cmV0dXJuIHNsYXNoID09PSAtMSA/IHRyaW1tZWQgOiB0cmltbWVkLnNsaWNlKHNsYXNoICsgMSk7XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLFNBQVMsT0FBTyx1QkFBdUM7QUFFdkQsU0FBUyxzQkFBc0I7QUFDL0IsU0FBUyxhQUE4QjtBQUN2QyxTQUFTLFlBQVksWUFBWSxVQUFVLG9CQUFvQjtBQVd4RCxNQUFNLHdCQUE2QztBQUFBLEVBQ3pELFlBQTZCLFVBQXFDO0FBQXJDO0FBQUEsRUFBc0M7QUFBQSxFQUVuRSxhQUFtQjtBQUFBLEVBQUM7QUFBQSxFQUVwQixPQUFPLE9BQXlCO0FBQy9CLFVBQU0sUUFBUSxLQUFLLFNBQVM7QUFDNUIsVUFBTSxPQUFPLGVBQWU7QUFBQSxNQUMzQixlQUFlO0FBQUEsTUFDZixVQUFVLE1BQU07QUFBQSxNQUNoQixpQkFB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
