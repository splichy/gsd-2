import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@gsd/pi-tui";
function assertLinesFit(lines, width) {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `line exceeds width ${width}: ${visibleWidth(line)} "${line}"`
    );
  }
}
describe("parallel-monitor-overlay", () => {
  it("progressBar generates correct width", async () => {
    const mod = await import("../parallel-monitor-overlay.js");
    assert.ok(mod.ParallelMonitorOverlay, "ParallelMonitorOverlay class should be exported");
  });
  it("ParallelMonitorOverlay can be instantiated with mock tui", async () => {
    const mod = await import("../parallel-monitor-overlay.js");
    let renderRequested = false;
    const mockTui = { requestRender: () => {
      renderRequested = true;
    } };
    const mockTheme = {
      fg: (_color, text) => text,
      bold: (text) => text
    };
    let closed = false;
    const overlay = new mod.ParallelMonitorOverlay(
      mockTui,
      mockTheme,
      () => {
        closed = true;
      },
      "/nonexistent/path"
      // basePath — no real data, tests empty state
    );
    const lines = overlay.render(80);
    assert.ok(Array.isArray(lines), "render should return an array");
    assert.ok(lines.length > 0, "render should return at least one line");
    assertLinesFit(lines, 80);
    const joined = lines.join("\n");
    assert.ok(joined.includes("Parallel Monitor"), "should include title");
    assert.ok(joined.includes("No parallel workers found"), "should show empty state");
    overlay.dispose();
    const overlay2 = new mod.ParallelMonitorOverlay(
      mockTui,
      mockTheme,
      () => {
        closed = true;
      },
      "/nonexistent/path"
    );
    overlay2.handleInput("q");
    assert.ok(closed, "pressing q should trigger onClose");
    overlay2.dispose();
  });
  it("ParallelMonitorOverlay clamps scrollOffset during render", async () => {
    const mod = await import("../parallel-monitor-overlay.js");
    const mockTui = { requestRender: () => {
    } };
    const mockTheme = {
      fg: (_color, text) => text,
      bold: (text) => text
    };
    const overlay = new mod.ParallelMonitorOverlay(
      mockTui,
      mockTheme,
      () => {
      },
      "/nonexistent/path"
    );
    overlay.scrollOffset = 999;
    overlay.render(80);
    assert.equal(overlay.scrollOffset, 0, "empty overlays clamp scroll to zero");
    overlay.dispose();
  });
  it("ParallelMonitorOverlay empty state fits narrow and wide widths", async () => {
    const mod = await import("../parallel-monitor-overlay.js");
    const mockTui = { requestRender: () => {
    } };
    const mockTheme = {
      fg: (_color, text) => text,
      bold: (text) => text
    };
    const overlay = new mod.ParallelMonitorOverlay(
      mockTui,
      mockTheme,
      () => {
      },
      "/nonexistent/path"
    );
    for (const width of [40, 80, 120]) {
      assertLinesFit(overlay.render(width), width);
      overlay.invalidate();
    }
    overlay.dispose();
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wYXJhbGxlbC1tb25pdG9yLW92ZXJsYXkudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFJlZ3Jlc3Npb24gdGVzdHMgZm9yIHBhcmFsbGVsIG1vbml0b3Igb3ZlcmxheSByZW5kZXJpbmcgYW5kIGlucHV0IGhhbmRsaW5nLlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcblxuaW1wb3J0IHsgdmlzaWJsZVdpZHRoIH0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5cbmZ1bmN0aW9uIGFzc2VydExpbmVzRml0KGxpbmVzOiBzdHJpbmdbXSwgd2lkdGg6IG51bWJlcik6IHZvaWQge1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICBhc3NlcnQub2soXG4gICAgICB2aXNpYmxlV2lkdGgobGluZSkgPD0gd2lkdGgsXG4gICAgICBgbGluZSBleGNlZWRzIHdpZHRoICR7d2lkdGh9OiAke3Zpc2libGVXaWR0aChsaW5lKX0gXCIke2xpbmV9XCJgLFxuICAgICk7XG4gIH1cbn1cblxuZGVzY3JpYmUoXCJwYXJhbGxlbC1tb25pdG9yLW92ZXJsYXlcIiwgKCkgPT4ge1xuICBpdChcInByb2dyZXNzQmFyIGdlbmVyYXRlcyBjb3JyZWN0IHdpZHRoXCIsIGFzeW5jICgpID0+IHtcbiAgICAvLyBEeW5hbWljIGltcG9ydCB0byB0ZXN0IHRoZSBtb2R1bGUgbG9hZHMgY2xlYW5seVxuICAgIGNvbnN0IG1vZCA9IGF3YWl0IGltcG9ydChcIi4uL3BhcmFsbGVsLW1vbml0b3Itb3ZlcmxheS5qc1wiKTtcbiAgICAvLyBNb2R1bGUgc2hvdWxkIGV4cG9ydCB0aGUgY2xhc3NcbiAgICBhc3NlcnQub2sobW9kLlBhcmFsbGVsTW9uaXRvck92ZXJsYXksIFwiUGFyYWxsZWxNb25pdG9yT3ZlcmxheSBjbGFzcyBzaG91bGQgYmUgZXhwb3J0ZWRcIik7XG4gIH0pO1xuXG4gIGl0KFwiUGFyYWxsZWxNb25pdG9yT3ZlcmxheSBjYW4gYmUgaW5zdGFudGlhdGVkIHdpdGggbW9jayB0dWlcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IG1vZCA9IGF3YWl0IGltcG9ydChcIi4uL3BhcmFsbGVsLW1vbml0b3Itb3ZlcmxheS5qc1wiKTtcblxuICAgIGxldCByZW5kZXJSZXF1ZXN0ZWQgPSBmYWxzZTtcbiAgICBjb25zdCBtb2NrVHVpID0geyByZXF1ZXN0UmVuZGVyOiAoKSA9PiB7IHJlbmRlclJlcXVlc3RlZCA9IHRydWU7IH0gfTtcbiAgICBjb25zdCBtb2NrVGhlbWUgPSB7XG4gICAgICBmZzogKF9jb2xvcjogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG4gICAgICBib2xkOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuICAgIH07XG4gICAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuXG4gICAgY29uc3Qgb3ZlcmxheSA9IG5ldyBtb2QuUGFyYWxsZWxNb25pdG9yT3ZlcmxheShcbiAgICAgIG1vY2tUdWksXG4gICAgICBtb2NrVGhlbWUgYXMgYW55LFxuICAgICAgKCkgPT4geyBjbG9zZWQgPSB0cnVlOyB9LFxuICAgICAgXCIvbm9uZXhpc3RlbnQvcGF0aFwiLCAgLy8gYmFzZVBhdGggXHUyMDE0IG5vIHJlYWwgZGF0YSwgdGVzdHMgZW1wdHkgc3RhdGVcbiAgICApO1xuXG4gICAgLy8gU2hvdWxkIHJlbmRlciB3aXRob3V0IHRocm93aW5nXG4gICAgY29uc3QgbGluZXMgPSBvdmVybGF5LnJlbmRlcig4MCk7XG4gICAgYXNzZXJ0Lm9rKEFycmF5LmlzQXJyYXkobGluZXMpLCBcInJlbmRlciBzaG91bGQgcmV0dXJuIGFuIGFycmF5XCIpO1xuICAgIGFzc2VydC5vayhsaW5lcy5sZW5ndGggPiAwLCBcInJlbmRlciBzaG91bGQgcmV0dXJuIGF0IGxlYXN0IG9uZSBsaW5lXCIpO1xuICAgIGFzc2VydExpbmVzRml0KGxpbmVzLCA4MCk7XG5cbiAgICAvLyBTaG91bGQgY29udGFpbiBoZWFkZXIgdGV4dFxuICAgIGNvbnN0IGpvaW5lZCA9IGxpbmVzLmpvaW4oXCJcXG5cIik7XG4gICAgYXNzZXJ0Lm9rKGpvaW5lZC5pbmNsdWRlcyhcIlBhcmFsbGVsIE1vbml0b3JcIiksIFwic2hvdWxkIGluY2x1ZGUgdGl0bGVcIik7XG4gICAgYXNzZXJ0Lm9rKGpvaW5lZC5pbmNsdWRlcyhcIk5vIHBhcmFsbGVsIHdvcmtlcnMgZm91bmRcIiksIFwic2hvdWxkIHNob3cgZW1wdHkgc3RhdGVcIik7XG5cbiAgICAvLyBEaXNwb3NlIHNob3VsZCBub3QgdGhyb3dcbiAgICBvdmVybGF5LmRpc3Bvc2UoKTtcblxuICAgIC8vIGhhbmRsZUlucHV0IHdpdGggRVNDIHNob3VsZCBjYWxsIG9uQ2xvc2VcbiAgICBjb25zdCBvdmVybGF5MiA9IG5ldyBtb2QuUGFyYWxsZWxNb25pdG9yT3ZlcmxheShcbiAgICAgIG1vY2tUdWksXG4gICAgICBtb2NrVGhlbWUgYXMgYW55LFxuICAgICAgKCkgPT4geyBjbG9zZWQgPSB0cnVlOyB9LFxuICAgICAgXCIvbm9uZXhpc3RlbnQvcGF0aFwiLFxuICAgICk7XG4gICAgb3ZlcmxheTIuaGFuZGxlSW5wdXQoXCJxXCIpO1xuICAgIGFzc2VydC5vayhjbG9zZWQsIFwicHJlc3NpbmcgcSBzaG91bGQgdHJpZ2dlciBvbkNsb3NlXCIpO1xuICAgIG92ZXJsYXkyLmRpc3Bvc2UoKTtcblxuICB9KTtcblxuICBpdChcIlBhcmFsbGVsTW9uaXRvck92ZXJsYXkgY2xhbXBzIHNjcm9sbE9mZnNldCBkdXJpbmcgcmVuZGVyXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBtb2QgPSBhd2FpdCBpbXBvcnQoXCIuLi9wYXJhbGxlbC1tb25pdG9yLW92ZXJsYXkuanNcIik7XG5cbiAgICBjb25zdCBtb2NrVHVpID0geyByZXF1ZXN0UmVuZGVyOiAoKSA9PiB7fSB9O1xuICAgIGNvbnN0IG1vY2tUaGVtZSA9IHtcbiAgICAgIGZnOiAoX2NvbG9yOiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcbiAgICAgIGJvbGQ6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG4gICAgfTtcbiAgICBjb25zdCBvdmVybGF5ID0gbmV3IG1vZC5QYXJhbGxlbE1vbml0b3JPdmVybGF5KFxuICAgICAgbW9ja1R1aSxcbiAgICAgIG1vY2tUaGVtZSBhcyBhbnksXG4gICAgICAoKSA9PiB7fSxcbiAgICAgIFwiL25vbmV4aXN0ZW50L3BhdGhcIixcbiAgICApO1xuXG4gICAgKG92ZXJsYXkgYXMgYW55KS5zY3JvbGxPZmZzZXQgPSA5OTk7XG4gICAgb3ZlcmxheS5yZW5kZXIoODApO1xuICAgIGFzc2VydC5lcXVhbCgob3ZlcmxheSBhcyBhbnkpLnNjcm9sbE9mZnNldCwgMCwgXCJlbXB0eSBvdmVybGF5cyBjbGFtcCBzY3JvbGwgdG8gemVyb1wiKTtcbiAgICBvdmVybGF5LmRpc3Bvc2UoKTtcbiAgfSk7XG5cbiAgaXQoXCJQYXJhbGxlbE1vbml0b3JPdmVybGF5IGVtcHR5IHN0YXRlIGZpdHMgbmFycm93IGFuZCB3aWRlIHdpZHRoc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgbW9kID0gYXdhaXQgaW1wb3J0KFwiLi4vcGFyYWxsZWwtbW9uaXRvci1vdmVybGF5LmpzXCIpO1xuXG4gICAgY29uc3QgbW9ja1R1aSA9IHsgcmVxdWVzdFJlbmRlcjogKCkgPT4ge30gfTtcbiAgICBjb25zdCBtb2NrVGhlbWUgPSB7XG4gICAgICBmZzogKF9jb2xvcjogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG4gICAgICBib2xkOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuICAgIH07XG4gICAgY29uc3Qgb3ZlcmxheSA9IG5ldyBtb2QuUGFyYWxsZWxNb25pdG9yT3ZlcmxheShcbiAgICAgIG1vY2tUdWksXG4gICAgICBtb2NrVGhlbWUgYXMgYW55LFxuICAgICAgKCkgPT4ge30sXG4gICAgICBcIi9ub25leGlzdGVudC9wYXRoXCIsXG4gICAgKTtcblxuICAgIGZvciAoY29uc3Qgd2lkdGggb2YgWzQwLCA4MCwgMTIwXSkge1xuICAgICAgYXNzZXJ0TGluZXNGaXQob3ZlcmxheS5yZW5kZXIod2lkdGgpLCB3aWR0aCk7XG4gICAgICBvdmVybGF5LmludmFsaWRhdGUoKTtcbiAgICB9XG5cbiAgICBvdmVybGF5LmRpc3Bvc2UoKTtcbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLFNBQVMsVUFBVSxVQUFVO0FBQzdCLE9BQU8sWUFBWTtBQUVuQixTQUFTLG9CQUFvQjtBQUU3QixTQUFTLGVBQWUsT0FBaUIsT0FBcUI7QUFDNUQsYUFBVyxRQUFRLE9BQU87QUFDeEIsV0FBTztBQUFBLE1BQ0wsYUFBYSxJQUFJLEtBQUs7QUFBQSxNQUN0QixzQkFBc0IsS0FBSyxLQUFLLGFBQWEsSUFBSSxDQUFDLEtBQUssSUFBSTtBQUFBLElBQzdEO0FBQUEsRUFDRjtBQUNGO0FBRUEsU0FBUyw0QkFBNEIsTUFBTTtBQUN6QyxLQUFHLHVDQUF1QyxZQUFZO0FBRXBELFVBQU0sTUFBTSxNQUFNLE9BQU8sZ0NBQWdDO0FBRXpELFdBQU8sR0FBRyxJQUFJLHdCQUF3QixpREFBaUQ7QUFBQSxFQUN6RixDQUFDO0FBRUQsS0FBRyw0REFBNEQsWUFBWTtBQUN6RSxVQUFNLE1BQU0sTUFBTSxPQUFPLGdDQUFnQztBQUV6RCxRQUFJLGtCQUFrQjtBQUN0QixVQUFNLFVBQVUsRUFBRSxlQUFlLE1BQU07QUFBRSx3QkFBa0I7QUFBQSxJQUFNLEVBQUU7QUFDbkUsVUFBTSxZQUFZO0FBQUEsTUFDaEIsSUFBSSxDQUFDLFFBQWdCLFNBQWlCO0FBQUEsTUFDdEMsTUFBTSxDQUFDLFNBQWlCO0FBQUEsSUFDMUI7QUFDQSxRQUFJLFNBQVM7QUFFYixVQUFNLFVBQVUsSUFBSSxJQUFJO0FBQUEsTUFDdEI7QUFBQSxNQUNBO0FBQUEsTUFDQSxNQUFNO0FBQUUsaUJBQVM7QUFBQSxNQUFNO0FBQUEsTUFDdkI7QUFBQTtBQUFBLElBQ0Y7QUFHQSxVQUFNLFFBQVEsUUFBUSxPQUFPLEVBQUU7QUFDL0IsV0FBTyxHQUFHLE1BQU0sUUFBUSxLQUFLLEdBQUcsK0JBQStCO0FBQy9ELFdBQU8sR0FBRyxNQUFNLFNBQVMsR0FBRyx3Q0FBd0M7QUFDcEUsbUJBQWUsT0FBTyxFQUFFO0FBR3hCLFVBQU0sU0FBUyxNQUFNLEtBQUssSUFBSTtBQUM5QixXQUFPLEdBQUcsT0FBTyxTQUFTLGtCQUFrQixHQUFHLHNCQUFzQjtBQUNyRSxXQUFPLEdBQUcsT0FBTyxTQUFTLDJCQUEyQixHQUFHLHlCQUF5QjtBQUdqRixZQUFRLFFBQVE7QUFHaEIsVUFBTSxXQUFXLElBQUksSUFBSTtBQUFBLE1BQ3ZCO0FBQUEsTUFDQTtBQUFBLE1BQ0EsTUFBTTtBQUFFLGlCQUFTO0FBQUEsTUFBTTtBQUFBLE1BQ3ZCO0FBQUEsSUFDRjtBQUNBLGFBQVMsWUFBWSxHQUFHO0FBQ3hCLFdBQU8sR0FBRyxRQUFRLG1DQUFtQztBQUNyRCxhQUFTLFFBQVE7QUFBQSxFQUVuQixDQUFDO0FBRUQsS0FBRyw0REFBNEQsWUFBWTtBQUN6RSxVQUFNLE1BQU0sTUFBTSxPQUFPLGdDQUFnQztBQUV6RCxVQUFNLFVBQVUsRUFBRSxlQUFlLE1BQU07QUFBQSxJQUFDLEVBQUU7QUFDMUMsVUFBTSxZQUFZO0FBQUEsTUFDaEIsSUFBSSxDQUFDLFFBQWdCLFNBQWlCO0FBQUEsTUFDdEMsTUFBTSxDQUFDLFNBQWlCO0FBQUEsSUFDMUI7QUFDQSxVQUFNLFVBQVUsSUFBSSxJQUFJO0FBQUEsTUFDdEI7QUFBQSxNQUNBO0FBQUEsTUFDQSxNQUFNO0FBQUEsTUFBQztBQUFBLE1BQ1A7QUFBQSxJQUNGO0FBRUEsSUFBQyxRQUFnQixlQUFlO0FBQ2hDLFlBQVEsT0FBTyxFQUFFO0FBQ2pCLFdBQU8sTUFBTyxRQUFnQixjQUFjLEdBQUcscUNBQXFDO0FBQ3BGLFlBQVEsUUFBUTtBQUFBLEVBQ2xCLENBQUM7QUFFRCxLQUFHLGtFQUFrRSxZQUFZO0FBQy9FLFVBQU0sTUFBTSxNQUFNLE9BQU8sZ0NBQWdDO0FBRXpELFVBQU0sVUFBVSxFQUFFLGVBQWUsTUFBTTtBQUFBLElBQUMsRUFBRTtBQUMxQyxVQUFNLFlBQVk7QUFBQSxNQUNoQixJQUFJLENBQUMsUUFBZ0IsU0FBaUI7QUFBQSxNQUN0QyxNQUFNLENBQUMsU0FBaUI7QUFBQSxJQUMxQjtBQUNBLFVBQU0sVUFBVSxJQUFJLElBQUk7QUFBQSxNQUN0QjtBQUFBLE1BQ0E7QUFBQSxNQUNBLE1BQU07QUFBQSxNQUFDO0FBQUEsTUFDUDtBQUFBLElBQ0Y7QUFFQSxlQUFXLFNBQVMsQ0FBQyxJQUFJLElBQUksR0FBRyxHQUFHO0FBQ2pDLHFCQUFlLFFBQVEsT0FBTyxLQUFLLEdBQUcsS0FBSztBQUMzQyxjQUFRLFdBQVc7QUFBQSxJQUNyQjtBQUVBLFlBQVEsUUFBUTtBQUFBLEVBQ2xCLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
