import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Container } from "@gsd/pi-tui";
import { SettingsManager } from "../../core/settings-manager.js";
import { dispatchSlashCommand } from "./slash-command-handlers.js";
function makeContext(settingsManager = SettingsManager.inMemory()) {
  const statuses = [];
  const warnings = [];
  const renders = [];
  return {
    session: {},
    ui: {},
    keybindings: {},
    chatContainer: new Container(),
    statusContainer: new Container(),
    editorContainer: new Container(),
    headerContainer: new Container(),
    pendingMessagesContainer: new Container(),
    editor: {},
    defaultEditor: {},
    sessionManager: {},
    settingsManager,
    invalidateFooter() {
    },
    showStatus(message) {
      statuses.push(message);
    },
    showError(message) {
      throw new Error(message);
    },
    showWarning(message) {
      warnings.push(message);
    },
    showSelector() {
    },
    updateEditorBorderColor() {
    },
    getMarkdownThemeWithSettings: () => ({}),
    requestRender() {
      renders.push("render");
    },
    updateTerminalTitle() {
    },
    showSettingsSelector() {
    },
    showModelsSelector: async () => {
    },
    handleModelCommand: async () => {
    },
    showUserMessageSelector() {
    },
    showTreeSelector() {
    },
    showProviderManager() {
    },
    showOAuthSelector: async () => {
    },
    showSessionSelector() {
    },
    handleClearCommand: async () => {
    },
    handleReloadCommand: async () => {
    },
    handleDebugCommand() {
    },
    shutdown: async () => {
    },
    executeCompaction: async () => void 0,
    handleBashCommand: async () => {
    },
    _testStatuses: statuses,
    _testWarnings: warnings,
    _testRenders: renders
  };
}
describe("dispatchSlashCommand /tui", () => {
  it("persists /tui mode validation to terminal adaptive mode", async () => {
    const settingsManager = SettingsManager.inMemory();
    const ctx = makeContext(settingsManager);
    const handled = await dispatchSlashCommand("/tui mode validation", ctx);
    assert.equal(handled, true);
    assert.equal(settingsManager.getAdaptiveMode(), "validation");
    assert.deepEqual(ctx._testStatuses, ["TUI mode: validation"]);
    assert.equal(ctx._testRenders.length, 1);
  });
  it("rejects unknown TUI modes without changing settings", async () => {
    const settingsManager = SettingsManager.inMemory({ terminal: { adaptiveMode: "workflow" } });
    const ctx = makeContext(settingsManager);
    const handled = await dispatchSlashCommand("/tui mode poster", ctx);
    assert.equal(handled, true);
    assert.equal(settingsManager.getAdaptiveMode(), "workflow");
    assert.match(ctx._testWarnings[0], /Usage: \/tui mode/);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9zbGFzaC1jb21tYW5kLWhhbmRsZXJzLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRDIgLSBTbGFzaCBjb21tYW5kIHRlc3RzIGZvciBpbnRlcmFjdGl2ZSBUVUkgc2V0dGluZ3MgY29tbWFuZHNcblxuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgeyBDb250YWluZXIgfSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB7IFNldHRpbmdzTWFuYWdlciB9IGZyb20gXCIuLi8uLi9jb3JlL3NldHRpbmdzLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7IGRpc3BhdGNoU2xhc2hDb21tYW5kLCB0eXBlIFNsYXNoQ29tbWFuZENvbnRleHQgfSBmcm9tIFwiLi9zbGFzaC1jb21tYW5kLWhhbmRsZXJzLmpzXCI7XG5cbmZ1bmN0aW9uIG1ha2VDb250ZXh0KHNldHRpbmdzTWFuYWdlciA9IFNldHRpbmdzTWFuYWdlci5pbk1lbW9yeSgpKTogU2xhc2hDb21tYW5kQ29udGV4dCB7XG5cdGNvbnN0IHN0YXR1c2VzOiBzdHJpbmdbXSA9IFtdO1xuXHRjb25zdCB3YXJuaW5nczogc3RyaW5nW10gPSBbXTtcblx0Y29uc3QgcmVuZGVyczogc3RyaW5nW10gPSBbXTtcblx0cmV0dXJuIHtcblx0XHRzZXNzaW9uOiB7fSBhcyBuZXZlcixcblx0XHR1aToge30gYXMgbmV2ZXIsXG5cdFx0a2V5YmluZGluZ3M6IHt9IGFzIG5ldmVyLFxuXHRcdGNoYXRDb250YWluZXI6IG5ldyBDb250YWluZXIoKSxcblx0XHRzdGF0dXNDb250YWluZXI6IG5ldyBDb250YWluZXIoKSxcblx0XHRlZGl0b3JDb250YWluZXI6IG5ldyBDb250YWluZXIoKSxcblx0XHRoZWFkZXJDb250YWluZXI6IG5ldyBDb250YWluZXIoKSxcblx0XHRwZW5kaW5nTWVzc2FnZXNDb250YWluZXI6IG5ldyBDb250YWluZXIoKSxcblx0XHRlZGl0b3I6IHt9IGFzIG5ldmVyLFxuXHRcdGRlZmF1bHRFZGl0b3I6IHt9IGFzIG5ldmVyLFxuXHRcdHNlc3Npb25NYW5hZ2VyOiB7fSBhcyBuZXZlcixcblx0XHRzZXR0aW5nc01hbmFnZXIsXG5cdFx0aW52YWxpZGF0ZUZvb3RlcigpIHt9LFxuXHRcdHNob3dTdGF0dXMobWVzc2FnZTogc3RyaW5nKSB7XG5cdFx0XHRzdGF0dXNlcy5wdXNoKG1lc3NhZ2UpO1xuXHRcdH0sXG5cdFx0c2hvd0Vycm9yKG1lc3NhZ2U6IHN0cmluZykge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuXHRcdH0sXG5cdFx0c2hvd1dhcm5pbmcobWVzc2FnZTogc3RyaW5nKSB7XG5cdFx0XHR3YXJuaW5ncy5wdXNoKG1lc3NhZ2UpO1xuXHRcdH0sXG5cdFx0c2hvd1NlbGVjdG9yKCkge30sXG5cdFx0dXBkYXRlRWRpdG9yQm9yZGVyQ29sb3IoKSB7fSxcblx0XHRnZXRNYXJrZG93blRoZW1lV2l0aFNldHRpbmdzOiAoKSA9PiAoe30gYXMgbmV2ZXIpLFxuXHRcdHJlcXVlc3RSZW5kZXIoKSB7XG5cdFx0XHRyZW5kZXJzLnB1c2goXCJyZW5kZXJcIik7XG5cdFx0fSxcblx0XHR1cGRhdGVUZXJtaW5hbFRpdGxlKCkge30sXG5cdFx0c2hvd1NldHRpbmdzU2VsZWN0b3IoKSB7fSxcblx0XHRzaG93TW9kZWxzU2VsZWN0b3I6IGFzeW5jICgpID0+IHt9LFxuXHRcdGhhbmRsZU1vZGVsQ29tbWFuZDogYXN5bmMgKCkgPT4ge30sXG5cdFx0c2hvd1VzZXJNZXNzYWdlU2VsZWN0b3IoKSB7fSxcblx0XHRzaG93VHJlZVNlbGVjdG9yKCkge30sXG5cdFx0c2hvd1Byb3ZpZGVyTWFuYWdlcigpIHt9LFxuXHRcdHNob3dPQXV0aFNlbGVjdG9yOiBhc3luYyAoKSA9PiB7fSxcblx0XHRzaG93U2Vzc2lvblNlbGVjdG9yKCkge30sXG5cdFx0aGFuZGxlQ2xlYXJDb21tYW5kOiBhc3luYyAoKSA9PiB7fSxcblx0XHRoYW5kbGVSZWxvYWRDb21tYW5kOiBhc3luYyAoKSA9PiB7fSxcblx0XHRoYW5kbGVEZWJ1Z0NvbW1hbmQoKSB7fSxcblx0XHRzaHV0ZG93bjogYXN5bmMgKCkgPT4ge30sXG5cdFx0ZXhlY3V0ZUNvbXBhY3Rpb246IGFzeW5jICgpID0+IHVuZGVmaW5lZCxcblx0XHRoYW5kbGVCYXNoQ29tbWFuZDogYXN5bmMgKCkgPT4ge30sXG5cdFx0X3Rlc3RTdGF0dXNlczogc3RhdHVzZXMsXG5cdFx0X3Rlc3RXYXJuaW5nczogd2FybmluZ3MsXG5cdFx0X3Rlc3RSZW5kZXJzOiByZW5kZXJzLFxuXHR9IGFzIFNsYXNoQ29tbWFuZENvbnRleHQgJiB7XG5cdFx0X3Rlc3RTdGF0dXNlczogc3RyaW5nW107XG5cdFx0X3Rlc3RXYXJuaW5nczogc3RyaW5nW107XG5cdFx0X3Rlc3RSZW5kZXJzOiBzdHJpbmdbXTtcblx0fTtcbn1cblxuZGVzY3JpYmUoXCJkaXNwYXRjaFNsYXNoQ29tbWFuZCAvdHVpXCIsICgpID0+IHtcblx0aXQoXCJwZXJzaXN0cyAvdHVpIG1vZGUgdmFsaWRhdGlvbiB0byB0ZXJtaW5hbCBhZGFwdGl2ZSBtb2RlXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBzZXR0aW5nc01hbmFnZXIgPSBTZXR0aW5nc01hbmFnZXIuaW5NZW1vcnkoKTtcblx0XHRjb25zdCBjdHggPSBtYWtlQ29udGV4dChzZXR0aW5nc01hbmFnZXIpIGFzIFNsYXNoQ29tbWFuZENvbnRleHQgJiB7XG5cdFx0XHRfdGVzdFN0YXR1c2VzOiBzdHJpbmdbXTtcblx0XHRcdF90ZXN0UmVuZGVyczogc3RyaW5nW107XG5cdFx0fTtcblxuXHRcdGNvbnN0IGhhbmRsZWQgPSBhd2FpdCBkaXNwYXRjaFNsYXNoQ29tbWFuZChcIi90dWkgbW9kZSB2YWxpZGF0aW9uXCIsIGN0eCk7XG5cblx0XHRhc3NlcnQuZXF1YWwoaGFuZGxlZCwgdHJ1ZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHNldHRpbmdzTWFuYWdlci5nZXRBZGFwdGl2ZU1vZGUoKSwgXCJ2YWxpZGF0aW9uXCIpO1xuXHRcdGFzc2VydC5kZWVwRXF1YWwoY3R4Ll90ZXN0U3RhdHVzZXMsIFtcIlRVSSBtb2RlOiB2YWxpZGF0aW9uXCJdKTtcblx0XHRhc3NlcnQuZXF1YWwoY3R4Ll90ZXN0UmVuZGVycy5sZW5ndGgsIDEpO1xuXHR9KTtcblxuXHRpdChcInJlamVjdHMgdW5rbm93biBUVUkgbW9kZXMgd2l0aG91dCBjaGFuZ2luZyBzZXR0aW5nc1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3Qgc2V0dGluZ3NNYW5hZ2VyID0gU2V0dGluZ3NNYW5hZ2VyLmluTWVtb3J5KHsgdGVybWluYWw6IHsgYWRhcHRpdmVNb2RlOiBcIndvcmtmbG93XCIgfSB9KTtcblx0XHRjb25zdCBjdHggPSBtYWtlQ29udGV4dChzZXR0aW5nc01hbmFnZXIpIGFzIFNsYXNoQ29tbWFuZENvbnRleHQgJiB7XG5cdFx0XHRfdGVzdFdhcm5pbmdzOiBzdHJpbmdbXTtcblx0XHR9O1xuXG5cdFx0Y29uc3QgaGFuZGxlZCA9IGF3YWl0IGRpc3BhdGNoU2xhc2hDb21tYW5kKFwiL3R1aSBtb2RlIHBvc3RlclwiLCBjdHgpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKGhhbmRsZWQsIHRydWUpO1xuXHRcdGFzc2VydC5lcXVhbChzZXR0aW5nc01hbmFnZXIuZ2V0QWRhcHRpdmVNb2RlKCksIFwid29ya2Zsb3dcIik7XG5cdFx0YXNzZXJ0Lm1hdGNoKGN0eC5fdGVzdFdhcm5pbmdzWzBdLCAvVXNhZ2U6IFxcL3R1aSBtb2RlLyk7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxPQUFPLFlBQVk7QUFDbkIsU0FBUyxVQUFVLFVBQVU7QUFDN0IsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyx1QkFB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
