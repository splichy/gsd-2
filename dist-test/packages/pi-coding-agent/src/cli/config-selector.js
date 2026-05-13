import { ProcessTerminal, TUI } from "@gsd/pi-tui";
import { ConfigSelectorComponent } from "../modes/interactive/components/config-selector.js";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.js";
async function selectConfig(options) {
  initTheme(options.settingsManager.getTheme(), true);
  return new Promise((resolve) => {
    const ui = new TUI(new ProcessTerminal());
    let resolved = false;
    const selector = new ConfigSelectorComponent(
      options.resolvedPaths,
      options.settingsManager,
      options.cwd,
      options.agentDir,
      () => {
        if (!resolved) {
          resolved = true;
          ui.stop();
          stopThemeWatcher();
          resolve();
        }
      },
      () => {
        ui.stop();
        stopThemeWatcher();
        process.exit(0);
      },
      () => ui.requestRender()
    );
    ui.addChild(selector);
    ui.setFocus(selector.getResourceList());
    ui.start();
  });
}
export {
  selectConfig
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jbGkvY29uZmlnLXNlbGVjdG9yLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFRVSSBjb25maWcgc2VsZWN0b3IgZm9yIGBwaSBjb25maWdgIGNvbW1hbmRcbiAqL1xuXG5pbXBvcnQgeyBQcm9jZXNzVGVybWluYWwsIFRVSSB9IGZyb20gXCJAZ3NkL3BpLXR1aVwiO1xuaW1wb3J0IHR5cGUgeyBSZXNvbHZlZFBhdGhzIH0gZnJvbSBcIi4uL2NvcmUvcGFja2FnZS1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFNldHRpbmdzTWFuYWdlciB9IGZyb20gXCIuLi9jb3JlL3NldHRpbmdzLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7IENvbmZpZ1NlbGVjdG9yQ29tcG9uZW50IH0gZnJvbSBcIi4uL21vZGVzL2ludGVyYWN0aXZlL2NvbXBvbmVudHMvY29uZmlnLXNlbGVjdG9yLmpzXCI7XG5pbXBvcnQgeyBpbml0VGhlbWUsIHN0b3BUaGVtZVdhdGNoZXIgfSBmcm9tIFwiLi4vbW9kZXMvaW50ZXJhY3RpdmUvdGhlbWUvdGhlbWUuanNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBDb25maWdTZWxlY3Rvck9wdGlvbnMge1xuXHRyZXNvbHZlZFBhdGhzOiBSZXNvbHZlZFBhdGhzO1xuXHRzZXR0aW5nc01hbmFnZXI6IFNldHRpbmdzTWFuYWdlcjtcblx0Y3dkOiBzdHJpbmc7XG5cdGFnZW50RGlyOiBzdHJpbmc7XG59XG5cbi8qKiBTaG93IFRVSSBjb25maWcgc2VsZWN0b3IgYW5kIHJldHVybiB3aGVuIGNsb3NlZCAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNlbGVjdENvbmZpZyhvcHRpb25zOiBDb25maWdTZWxlY3Rvck9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcblx0Ly8gSW5pdGlhbGl6ZSB0aGVtZSBiZWZvcmUgc2hvd2luZyBUVUlcblx0aW5pdFRoZW1lKG9wdGlvbnMuc2V0dGluZ3NNYW5hZ2VyLmdldFRoZW1lKCksIHRydWUpO1xuXG5cdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuXHRcdGNvbnN0IHVpID0gbmV3IFRVSShuZXcgUHJvY2Vzc1Rlcm1pbmFsKCkpO1xuXHRcdGxldCByZXNvbHZlZCA9IGZhbHNlO1xuXG5cdFx0Y29uc3Qgc2VsZWN0b3IgPSBuZXcgQ29uZmlnU2VsZWN0b3JDb21wb25lbnQoXG5cdFx0XHRvcHRpb25zLnJlc29sdmVkUGF0aHMsXG5cdFx0XHRvcHRpb25zLnNldHRpbmdzTWFuYWdlcixcblx0XHRcdG9wdGlvbnMuY3dkLFxuXHRcdFx0b3B0aW9ucy5hZ2VudERpcixcblx0XHRcdCgpID0+IHtcblx0XHRcdFx0aWYgKCFyZXNvbHZlZCkge1xuXHRcdFx0XHRcdHJlc29sdmVkID0gdHJ1ZTtcblx0XHRcdFx0XHR1aS5zdG9wKCk7XG5cdFx0XHRcdFx0c3RvcFRoZW1lV2F0Y2hlcigpO1xuXHRcdFx0XHRcdHJlc29sdmUoKTtcblx0XHRcdFx0fVxuXHRcdFx0fSxcblx0XHRcdCgpID0+IHtcblx0XHRcdFx0dWkuc3RvcCgpO1xuXHRcdFx0XHRzdG9wVGhlbWVXYXRjaGVyKCk7XG5cdFx0XHRcdHByb2Nlc3MuZXhpdCgwKTtcblx0XHRcdH0sXG5cdFx0XHQoKSA9PiB1aS5yZXF1ZXN0UmVuZGVyKCksXG5cdFx0KTtcblxuXHRcdHVpLmFkZENoaWxkKHNlbGVjdG9yKTtcblx0XHR1aS5zZXRGb2N1cyhzZWxlY3Rvci5nZXRSZXNvdXJjZUxpc3QoKSk7XG5cdFx0dWkuc3RhcnQoKTtcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFJQSxTQUFTLGlCQUFpQixXQUFXO0FBR3JDLFNBQVMsK0JBQStCO0FBQ3hDLFNBQVMsV0FBVyx3QkFBd0I7QUFVNUMsZUFBc0IsYUFBYSxTQUErQztBQUVqRixZQUFVLFFBQVEsZ0JBQWdCLFNBQVMsR0FBRyxJQUFJO0FBRWxELFNBQU8sSUFBSSxRQUFRLENBQUMsWUFBWTtBQUMvQixVQUFNLEtBQUssSUFBSSxJQUFJLElBQUksZ0JBQWdCLENBQUM7QUFDeEMsUUFBSSxXQUFXO0FBRWYsVUFBTSxXQUFXLElBQUk7QUFBQSxNQUNwQixRQUFRO0FBQUEsTUFDUixRQUFRO0FBQUEsTUFDUixRQUFRO0FBQUEsTUFDUixRQUFRO0FBQUEsTUFDUixNQUFNO0FBQ0wsWUFBSSxDQUFDLFVBQVU7QUFDZCxxQkFBVztBQUNYLGFBQUcsS0FBSztBQUNSLDJCQUFpQjtBQUNqQixrQkFBUTtBQUFBLFFBQ1Q7QUFBQSxNQUNEO0FBQUEsTUFDQSxNQUFNO0FBQ0wsV0FBRyxLQUFLO0FBQ1IseUJBQWlCO0FBQ2pCLGdCQUFRLEtBQUssQ0FBQztBQUFBLE1BQ2Y7QUFBQSxNQUNBLE1BQU0sR0FBRyxjQUFjO0FBQUEsSUFDeEI7QUFFQSxPQUFHLFNBQVMsUUFBUTtBQUNwQixPQUFHLFNBQVMsU0FBUyxnQkFBZ0IsQ0FBQztBQUN0QyxPQUFHLE1BQU07QUFBQSxFQUNWLENBQUM7QUFDRjsiLAogICJuYW1lcyI6IFtdCn0K
