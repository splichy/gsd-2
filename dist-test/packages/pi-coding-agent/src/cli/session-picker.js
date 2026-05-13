import { ProcessTerminal, TUI } from "@gsd/pi-tui";
import { KeybindingsManager } from "../core/keybindings.js";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.js";
async function selectSession(currentSessionsLoader, allSessionsLoader) {
  return new Promise((resolve) => {
    const ui = new TUI(new ProcessTerminal());
    const keybindings = KeybindingsManager.create();
    let resolved = false;
    const selector = new SessionSelectorComponent(
      currentSessionsLoader,
      allSessionsLoader,
      (path) => {
        if (!resolved) {
          resolved = true;
          ui.stop();
          resolve(path);
        }
      },
      () => {
        if (!resolved) {
          resolved = true;
          ui.stop();
          resolve(null);
        }
      },
      () => {
        ui.stop();
        process.exit(0);
      },
      () => ui.requestRender(),
      { showRenameHint: false, keybindings }
    );
    ui.addChild(selector);
    ui.setFocus(selector.getSessionList());
    ui.start();
  });
}
export {
  selectSession
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jbGkvc2Vzc2lvbi1waWNrZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVFVJIHNlc3Npb24gc2VsZWN0b3IgZm9yIC0tcmVzdW1lIGZsYWdcbiAqL1xuXG5pbXBvcnQgeyBQcm9jZXNzVGVybWluYWwsIFRVSSB9IGZyb20gXCJAZ3NkL3BpLXR1aVwiO1xuaW1wb3J0IHsgS2V5YmluZGluZ3NNYW5hZ2VyIH0gZnJvbSBcIi4uL2NvcmUva2V5YmluZGluZ3MuanNcIjtcbmltcG9ydCB0eXBlIHsgU2Vzc2lvbkluZm8sIFNlc3Npb25MaXN0UHJvZ3Jlc3MgfSBmcm9tIFwiLi4vY29yZS9zZXNzaW9uLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7IFNlc3Npb25TZWxlY3RvckNvbXBvbmVudCB9IGZyb20gXCIuLi9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL3Nlc3Npb24tc2VsZWN0b3IuanNcIjtcblxudHlwZSBTZXNzaW9uc0xvYWRlciA9IChvblByb2dyZXNzPzogU2Vzc2lvbkxpc3RQcm9ncmVzcykgPT4gUHJvbWlzZTxTZXNzaW9uSW5mb1tdPjtcblxuLyoqIFNob3cgVFVJIHNlc3Npb24gc2VsZWN0b3IgYW5kIHJldHVybiBzZWxlY3RlZCBzZXNzaW9uIHBhdGggb3IgbnVsbCBpZiBjYW5jZWxsZWQgKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZWxlY3RTZXNzaW9uKFxuXHRjdXJyZW50U2Vzc2lvbnNMb2FkZXI6IFNlc3Npb25zTG9hZGVyLFxuXHRhbGxTZXNzaW9uc0xvYWRlcjogU2Vzc2lvbnNMb2FkZXIsXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcblx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG5cdFx0Y29uc3QgdWkgPSBuZXcgVFVJKG5ldyBQcm9jZXNzVGVybWluYWwoKSk7XG5cdFx0Y29uc3Qga2V5YmluZGluZ3MgPSBLZXliaW5kaW5nc01hbmFnZXIuY3JlYXRlKCk7XG5cdFx0bGV0IHJlc29sdmVkID0gZmFsc2U7XG5cblx0XHRjb25zdCBzZWxlY3RvciA9IG5ldyBTZXNzaW9uU2VsZWN0b3JDb21wb25lbnQoXG5cdFx0XHRjdXJyZW50U2Vzc2lvbnNMb2FkZXIsXG5cdFx0XHRhbGxTZXNzaW9uc0xvYWRlcixcblx0XHRcdChwYXRoOiBzdHJpbmcpID0+IHtcblx0XHRcdFx0aWYgKCFyZXNvbHZlZCkge1xuXHRcdFx0XHRcdHJlc29sdmVkID0gdHJ1ZTtcblx0XHRcdFx0XHR1aS5zdG9wKCk7XG5cdFx0XHRcdFx0cmVzb2x2ZShwYXRoKTtcblx0XHRcdFx0fVxuXHRcdFx0fSxcblx0XHRcdCgpID0+IHtcblx0XHRcdFx0aWYgKCFyZXNvbHZlZCkge1xuXHRcdFx0XHRcdHJlc29sdmVkID0gdHJ1ZTtcblx0XHRcdFx0XHR1aS5zdG9wKCk7XG5cdFx0XHRcdFx0cmVzb2x2ZShudWxsKTtcblx0XHRcdFx0fVxuXHRcdFx0fSxcblx0XHRcdCgpID0+IHtcblx0XHRcdFx0dWkuc3RvcCgpO1xuXHRcdFx0XHRwcm9jZXNzLmV4aXQoMCk7XG5cdFx0XHR9LFxuXHRcdFx0KCkgPT4gdWkucmVxdWVzdFJlbmRlcigpLFxuXHRcdFx0eyBzaG93UmVuYW1lSGludDogZmFsc2UsIGtleWJpbmRpbmdzIH0sXG5cdFx0KTtcblxuXHRcdHVpLmFkZENoaWxkKHNlbGVjdG9yKTtcblx0XHR1aS5zZXRGb2N1cyhzZWxlY3Rvci5nZXRTZXNzaW9uTGlzdCgpKTtcblx0XHR1aS5zdGFydCgpO1xuXHR9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUlBLFNBQVMsaUJBQWlCLFdBQVc7QUFDckMsU0FBUywwQkFBMEI7QUFFbkMsU0FBUyxnQ0FBZ0M7QUFLekMsZUFBc0IsY0FDckIsdUJBQ0EsbUJBQ3lCO0FBQ3pCLFNBQU8sSUFBSSxRQUFRLENBQUMsWUFBWTtBQUMvQixVQUFNLEtBQUssSUFBSSxJQUFJLElBQUksZ0JBQWdCLENBQUM7QUFDeEMsVUFBTSxjQUFjLG1CQUFtQixPQUFPO0FBQzlDLFFBQUksV0FBVztBQUVmLFVBQU0sV0FBVyxJQUFJO0FBQUEsTUFDcEI7QUFBQSxNQUNBO0FBQUEsTUFDQSxDQUFDLFNBQWlCO0FBQ2pCLFlBQUksQ0FBQyxVQUFVO0FBQ2QscUJBQVc7QUFDWCxhQUFHLEtBQUs7QUFDUixrQkFBUSxJQUFJO0FBQUEsUUFDYjtBQUFBLE1BQ0Q7QUFBQSxNQUNBLE1BQU07QUFDTCxZQUFJLENBQUMsVUFBVTtBQUNkLHFCQUFXO0FBQ1gsYUFBRyxLQUFLO0FBQ1Isa0JBQVEsSUFBSTtBQUFBLFFBQ2I7QUFBQSxNQUNEO0FBQUEsTUFDQSxNQUFNO0FBQ0wsV0FBRyxLQUFLO0FBQ1IsZ0JBQVEsS0FBSyxDQUFDO0FBQUEsTUFDZjtBQUFBLE1BQ0EsTUFBTSxHQUFHLGNBQWM7QUFBQSxNQUN2QixFQUFFLGdCQUFnQixPQUFPLFlBQVk7QUFBQSxJQUN0QztBQUVBLE9BQUcsU0FBUyxRQUFRO0FBQ3BCLE9BQUcsU0FBUyxTQUFTLGVBQWUsQ0FBQztBQUNyQyxPQUFHLE1BQU07QUFBQSxFQUNWLENBQUM7QUFDRjsiLAogICJuYW1lcyI6IFtdCn0K
