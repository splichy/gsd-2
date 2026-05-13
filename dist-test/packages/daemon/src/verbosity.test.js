import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VerbosityManager, shouldShowAtLevel } from "./verbosity.js";
describe("VerbosityManager", () => {
  let vm;
  beforeEach(() => {
    vm = new VerbosityManager();
  });
  it("returns default level for unknown channel", () => {
    assert.equal(vm.getLevel("chan-1"), "default");
  });
  it("set/get round-trips", () => {
    vm.setLevel("chan-1", "quiet");
    assert.equal(vm.getLevel("chan-1"), "quiet");
    vm.setLevel("chan-1", "verbose");
    assert.equal(vm.getLevel("chan-1"), "verbose");
  });
  it("different channels are independent", () => {
    vm.setLevel("chan-a", "quiet");
    vm.setLevel("chan-b", "verbose");
    assert.equal(vm.getLevel("chan-a"), "quiet");
    assert.equal(vm.getLevel("chan-b"), "verbose");
    assert.equal(vm.getLevel("chan-c"), "default");
  });
  it("shouldShow delegates to the level-based filter", () => {
    vm.setLevel("chan-q", "quiet");
    assert.equal(vm.shouldShow("chan-q", "tool_execution_start"), false);
    assert.equal(vm.shouldShow("chan-q", "extension_ui_request"), true);
  });
});
describe("shouldShowAtLevel \u2014 quiet", () => {
  const level = "quiet";
  it("shows blockers", () => {
    assert.equal(shouldShowAtLevel(level, "extension_ui_request"), true);
  });
  it("shows execution_complete", () => {
    assert.equal(shouldShowAtLevel(level, "execution_complete"), true);
  });
  it("shows error", () => {
    assert.equal(shouldShowAtLevel(level, "error"), true);
  });
  it("shows session_error", () => {
    assert.equal(shouldShowAtLevel(level, "session_error"), true);
  });
  it("hides tool calls", () => {
    assert.equal(shouldShowAtLevel(level, "tool_execution_start"), false);
    assert.equal(shouldShowAtLevel(level, "tool_execution_end"), false);
  });
  it("hides messages", () => {
    assert.equal(shouldShowAtLevel(level, "message_start"), false);
    assert.equal(shouldShowAtLevel(level, "message"), false);
  });
  it("hides cost_update", () => {
    assert.equal(shouldShowAtLevel(level, "cost_update"), false);
  });
  it("hides task_transition", () => {
    assert.equal(shouldShowAtLevel(level, "task_transition"), false);
  });
  it("hides unknown events", () => {
    assert.equal(shouldShowAtLevel(level, "totally_random"), false);
  });
});
describe("shouldShowAtLevel \u2014 default", () => {
  const level = "default";
  it("shows blockers", () => {
    assert.equal(shouldShowAtLevel(level, "extension_ui_request"), true);
  });
  it("shows execution_complete", () => {
    assert.equal(shouldShowAtLevel(level, "execution_complete"), true);
  });
  it("shows error", () => {
    assert.equal(shouldShowAtLevel(level, "error"), true);
  });
  it("shows tool calls", () => {
    assert.equal(shouldShowAtLevel(level, "tool_execution_start"), true);
    assert.equal(shouldShowAtLevel(level, "tool_execution_end"), true);
  });
  it("shows messages", () => {
    assert.equal(shouldShowAtLevel(level, "message_start"), true);
    assert.equal(shouldShowAtLevel(level, "message_end"), true);
    assert.equal(shouldShowAtLevel(level, "message"), true);
  });
  it("shows task_transition", () => {
    assert.equal(shouldShowAtLevel(level, "task_transition"), true);
  });
  it("shows session_started", () => {
    assert.equal(shouldShowAtLevel(level, "session_started"), true);
  });
  it("hides cost_update", () => {
    assert.equal(shouldShowAtLevel(level, "cost_update"), false);
  });
  it("hides status events", () => {
    assert.equal(shouldShowAtLevel(level, "state_update"), false);
    assert.equal(shouldShowAtLevel(level, "status"), false);
  });
  it("hides unknown events", () => {
    assert.equal(shouldShowAtLevel(level, "something_weird"), false);
  });
});
describe("shouldShowAtLevel \u2014 verbose", () => {
  const level = "verbose";
  it("shows everything that quiet/default show", () => {
    const events = [
      "extension_ui_request",
      "execution_complete",
      "error",
      "session_error",
      "tool_execution_start",
      "tool_execution_end",
      "message_start",
      "message_end",
      "message",
      "task_transition",
      "session_started"
    ];
    for (const e of events) {
      assert.equal(shouldShowAtLevel(level, e), true, `Expected verbose to show ${e}`);
    }
  });
  it("shows cost_update", () => {
    assert.equal(shouldShowAtLevel(level, "cost_update"), true);
  });
  it("shows status events", () => {
    assert.equal(shouldShowAtLevel(level, "state_update"), true);
    assert.equal(shouldShowAtLevel(level, "status"), true);
    assert.equal(shouldShowAtLevel(level, "set_status"), true);
  });
  it("shows unknown/arbitrary events", () => {
    assert.equal(shouldShowAtLevel(level, "something_arbitrary"), true);
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvZGFlbW9uL3NyYy92ZXJib3NpdHkudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZGVzY3JpYmUsIGl0LCBiZWZvcmVFYWNoIH0gZnJvbSAnbm9kZTp0ZXN0JztcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0JztcbmltcG9ydCB7IFZlcmJvc2l0eU1hbmFnZXIsIHNob3VsZFNob3dBdExldmVsIH0gZnJvbSAnLi92ZXJib3NpdHkuanMnO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFZlcmJvc2l0eU1hbmFnZXJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnVmVyYm9zaXR5TWFuYWdlcicsICgpID0+IHtcbiAgbGV0IHZtOiBWZXJib3NpdHlNYW5hZ2VyO1xuXG4gIGJlZm9yZUVhY2goKCkgPT4ge1xuICAgIHZtID0gbmV3IFZlcmJvc2l0eU1hbmFnZXIoKTtcbiAgfSk7XG5cbiAgaXQoJ3JldHVybnMgZGVmYXVsdCBsZXZlbCBmb3IgdW5rbm93biBjaGFubmVsJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbCh2bS5nZXRMZXZlbCgnY2hhbi0xJyksICdkZWZhdWx0Jyk7XG4gIH0pO1xuXG4gIGl0KCdzZXQvZ2V0IHJvdW5kLXRyaXBzJywgKCkgPT4ge1xuICAgIHZtLnNldExldmVsKCdjaGFuLTEnLCAncXVpZXQnKTtcbiAgICBhc3NlcnQuZXF1YWwodm0uZ2V0TGV2ZWwoJ2NoYW4tMScpLCAncXVpZXQnKTtcbiAgICB2bS5zZXRMZXZlbCgnY2hhbi0xJywgJ3ZlcmJvc2UnKTtcbiAgICBhc3NlcnQuZXF1YWwodm0uZ2V0TGV2ZWwoJ2NoYW4tMScpLCAndmVyYm9zZScpO1xuICB9KTtcblxuICBpdCgnZGlmZmVyZW50IGNoYW5uZWxzIGFyZSBpbmRlcGVuZGVudCcsICgpID0+IHtcbiAgICB2bS5zZXRMZXZlbCgnY2hhbi1hJywgJ3F1aWV0Jyk7XG4gICAgdm0uc2V0TGV2ZWwoJ2NoYW4tYicsICd2ZXJib3NlJyk7XG4gICAgYXNzZXJ0LmVxdWFsKHZtLmdldExldmVsKCdjaGFuLWEnKSwgJ3F1aWV0Jyk7XG4gICAgYXNzZXJ0LmVxdWFsKHZtLmdldExldmVsKCdjaGFuLWInKSwgJ3ZlcmJvc2UnKTtcbiAgICBhc3NlcnQuZXF1YWwodm0uZ2V0TGV2ZWwoJ2NoYW4tYycpLCAnZGVmYXVsdCcpO1xuICB9KTtcblxuICBpdCgnc2hvdWxkU2hvdyBkZWxlZ2F0ZXMgdG8gdGhlIGxldmVsLWJhc2VkIGZpbHRlcicsICgpID0+IHtcbiAgICB2bS5zZXRMZXZlbCgnY2hhbi1xJywgJ3F1aWV0Jyk7XG4gICAgYXNzZXJ0LmVxdWFsKHZtLnNob3VsZFNob3coJ2NoYW4tcScsICd0b29sX2V4ZWN1dGlvbl9zdGFydCcpLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHZtLnNob3VsZFNob3coJ2NoYW4tcScsICdleHRlbnNpb25fdWlfcmVxdWVzdCcpLCB0cnVlKTtcbiAgfSk7XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBzaG91bGRTaG93QXRMZXZlbCBcdTIwMTQgcXVpZXRcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnc2hvdWxkU2hvd0F0TGV2ZWwgXHUyMDE0IHF1aWV0JywgKCkgPT4ge1xuICBjb25zdCBsZXZlbCA9ICdxdWlldCcgYXMgY29uc3Q7XG5cbiAgaXQoJ3Nob3dzIGJsb2NrZXJzJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzaG91bGRTaG93QXRMZXZlbChsZXZlbCwgJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JyksIHRydWUpO1xuICB9KTtcblxuICBpdCgnc2hvd3MgZXhlY3V0aW9uX2NvbXBsZXRlJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzaG91bGRTaG93QXRMZXZlbChsZXZlbCwgJ2V4ZWN1dGlvbl9jb21wbGV0ZScpLCB0cnVlKTtcbiAgfSk7XG5cbiAgaXQoJ3Nob3dzIGVycm9yJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzaG91bGRTaG93QXRMZXZlbChsZXZlbCwgJ2Vycm9yJyksIHRydWUpO1xuICB9KTtcblxuICBpdCgnc2hvd3Mgc2Vzc2lvbl9lcnJvcicsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc2hvdWxkU2hvd0F0TGV2ZWwobGV2ZWwsICdzZXNzaW9uX2Vycm9yJyksIHRydWUpO1xuICB9KTtcblxuICBpdCgnaGlkZXMgdG9vbCBjYWxscycsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc2hvdWxkU2hvd0F0TGV2ZWwobGV2ZWwsICd0b29sX2V4ZWN1dGlvbl9zdGFydCcpLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHNob3VsZFNob3dBdExldmVsKGxldmVsLCAndG9vbF9leGVjdXRpb25fZW5kJyksIGZhbHNlKTtcbiAgfSk7XG5cbiAgaXQoJ2hpZGVzIG1lc3NhZ2VzJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzaG91bGRTaG93QXRMZXZlbChsZXZlbCwgJ21lc3NhZ2Vfc3RhcnQnKSwgZmFsc2UpO1xuICAgIGFzc2VydC5lcXVhbChzaG91bGRTaG93QXRMZXZlbChsZXZlbCwgJ21lc3NhZ2UnKSwgZmFsc2UpO1xuICB9KTtcblxuICBpdCgnaGlkZXMgY29zdF91cGRhdGUnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHNob3VsZFNob3dBdExldmVsKGxldmVsLCAnY29zdF91cGRhdGUnKSwgZmFsc2UpO1xuICB9KTtcblxuICBpdCgnaGlkZXMgdGFza190cmFuc2l0aW9uJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzaG91bGRTaG93QXRMZXZlbChsZXZlbCwgJ3Rhc2tfdHJhbnNpdGlvbicpLCBmYWxzZSk7XG4gIH0pO1xuXG4gIGl0KCdoaWRlcyB1bmtub3duIGV2ZW50cycsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc2hvdWxkU2hvd0F0TGV2ZWwobGV2ZWwsICd0b3RhbGx5X3JhbmRvbScpLCBmYWxzZSk7XG4gIH0pO1xufSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gc2hvdWxkU2hvd0F0TGV2ZWwgXHUyMDE0IGRlZmF1bHRcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnc2hvdWxkU2hvd0F0TGV2ZWwgXHUyMDE0IGRlZmF1bHQnLCAoKSA9PiB7XG4gIGNvbnN0IGxldmVsID0gJ2RlZmF1bHQnIGFzIGNvbnN0O1xuXG4gIGl0KCdzaG93cyBibG9ja2VycycsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc2hvdWxkU2hvd0F0TGV2ZWwobGV2ZWwsICdleHRlbnNpb25fdWlfcmVxdWVzdCcpLCB0cnVlKTtcbiAgfSk7XG5cbiAgaXQoJ3Nob3dzIGV4ZWN1dGlvbl9jb21wbGV0ZScsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc2hvdWxkU2hvd0F0TGV2ZWwobGV2ZWwsICdleGVjdXRpb25fY29tcGxldGUnKSwgdHJ1ZSk7XG4gIH0pO1xuXG4gIGl0KCdzaG93cyBlcnJvcicsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc2hvdWxkU2hvd0F0TGV2ZWwobGV2ZWwsICdlcnJvcicpLCB0cnVlKTtcbiAgfSk7XG5cbiAgaXQoJ3Nob3dzIHRvb2wgY2FsbHMnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHNob3VsZFNob3dBdExldmVsKGxldmVsLCAndG9vbF9leGVjdXRpb25fc3RhcnQnKSwgdHJ1ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHNob3VsZFNob3dBdExldmVsKGxldmVsLCAndG9vbF9leGVjdXRpb25fZW5kJyksIHRydWUpO1xuICB9KTtcblxuICBpdCgnc2hvd3MgbWVzc2FnZXMnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHNob3VsZFNob3dBdExldmVsKGxldmVsLCAnbWVzc2FnZV9zdGFydCcpLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoc2hvdWxkU2hvd0F0TGV2ZWwobGV2ZWwsICdtZXNzYWdlX2VuZCcpLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoc2hvdWxkU2hvd0F0TGV2ZWwobGV2ZWwsICdtZXNzYWdlJyksIHRydWUpO1xuICB9KTtcblxuICBpdCgnc2hvd3MgdGFza190cmFuc2l0aW9uJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzaG91bGRTaG93QXRMZXZlbChsZXZlbCwgJ3Rhc2tfdHJhbnNpdGlvbicpLCB0cnVlKTtcbiAgfSk7XG5cbiAgaXQoJ3Nob3dzIHNlc3Npb25fc3RhcnRlZCcsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc2hvdWxkU2hvd0F0TGV2ZWwobGV2ZWwsICdzZXNzaW9uX3N0YXJ0ZWQnKSwgdHJ1ZSk7XG4gIH0pO1xuXG4gIGl0KCdoaWRlcyBjb3N0X3VwZGF0ZScsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc2hvdWxkU2hvd0F0TGV2ZWwobGV2ZWwsICdjb3N0X3VwZGF0ZScpLCBmYWxzZSk7XG4gIH0pO1xuXG4gIGl0KCdoaWRlcyBzdGF0dXMgZXZlbnRzJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzaG91bGRTaG93QXRMZXZlbChsZXZlbCwgJ3N0YXRlX3VwZGF0ZScpLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHNob3VsZFNob3dBdExldmVsKGxldmVsLCAnc3RhdHVzJyksIGZhbHNlKTtcbiAgfSk7XG5cbiAgaXQoJ2hpZGVzIHVua25vd24gZXZlbnRzJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzaG91bGRTaG93QXRMZXZlbChsZXZlbCwgJ3NvbWV0aGluZ193ZWlyZCcpLCBmYWxzZSk7XG4gIH0pO1xufSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gc2hvdWxkU2hvd0F0TGV2ZWwgXHUyMDE0IHZlcmJvc2Vcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5kZXNjcmliZSgnc2hvdWxkU2hvd0F0TGV2ZWwgXHUyMDE0IHZlcmJvc2UnLCAoKSA9PiB7XG4gIGNvbnN0IGxldmVsID0gJ3ZlcmJvc2UnIGFzIGNvbnN0O1xuXG4gIGl0KCdzaG93cyBldmVyeXRoaW5nIHRoYXQgcXVpZXQvZGVmYXVsdCBzaG93JywgKCkgPT4ge1xuICAgIGNvbnN0IGV2ZW50cyA9IFtcbiAgICAgICdleHRlbnNpb25fdWlfcmVxdWVzdCcsICdleGVjdXRpb25fY29tcGxldGUnLCAnZXJyb3InLCAnc2Vzc2lvbl9lcnJvcicsXG4gICAgICAndG9vbF9leGVjdXRpb25fc3RhcnQnLCAndG9vbF9leGVjdXRpb25fZW5kJywgJ21lc3NhZ2Vfc3RhcnQnLCAnbWVzc2FnZV9lbmQnLFxuICAgICAgJ21lc3NhZ2UnLCAndGFza190cmFuc2l0aW9uJywgJ3Nlc3Npb25fc3RhcnRlZCcsXG4gICAgXTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgZXZlbnRzKSB7XG4gICAgICBhc3NlcnQuZXF1YWwoc2hvdWxkU2hvd0F0TGV2ZWwobGV2ZWwsIGUpLCB0cnVlLCBgRXhwZWN0ZWQgdmVyYm9zZSB0byBzaG93ICR7ZX1gKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KCdzaG93cyBjb3N0X3VwZGF0ZScsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoc2hvdWxkU2hvd0F0TGV2ZWwobGV2ZWwsICdjb3N0X3VwZGF0ZScpLCB0cnVlKTtcbiAgfSk7XG5cbiAgaXQoJ3Nob3dzIHN0YXR1cyBldmVudHMnLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKHNob3VsZFNob3dBdExldmVsKGxldmVsLCAnc3RhdGVfdXBkYXRlJyksIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChzaG91bGRTaG93QXRMZXZlbChsZXZlbCwgJ3N0YXR1cycpLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoc2hvdWxkU2hvd0F0TGV2ZWwobGV2ZWwsICdzZXRfc3RhdHVzJyksIHRydWUpO1xuICB9KTtcblxuICBpdCgnc2hvd3MgdW5rbm93bi9hcmJpdHJhcnkgZXZlbnRzJywgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChzaG91bGRTaG93QXRMZXZlbChsZXZlbCwgJ3NvbWV0aGluZ19hcmJpdHJhcnknKSwgdHJ1ZSk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFVBQVUsSUFBSSxrQkFBa0I7QUFDekMsT0FBTyxZQUFZO0FBQ25CLFNBQVMsa0JBQWtCLHlCQUF5QjtBQU1wRCxTQUFTLG9CQUFvQixNQUFNO0FBQ2pDLE1BQUk7QUFFSixhQUFXLE1BQU07QUFDZixTQUFLLElBQUksaUJBQWlCO0FBQUEsRUFDNUIsQ0FBQztBQUVELEtBQUcsNkNBQTZDLE1BQU07QUFDcEQsV0FBTyxNQUFNLEdBQUcsU0FBUyxRQUFRLEdBQUcsU0FBUztBQUFBLEVBQy9DLENBQUM7QUFFRCxLQUFHLHVCQUF1QixNQUFNO0FBQzlCLE9BQUcsU0FBUyxVQUFVLE9BQU87QUFDN0IsV0FBTyxNQUFNLEdBQUcsU0FBUyxRQUFRLEdBQUcsT0FBTztBQUMzQyxPQUFHLFNBQVMsVUFBVSxTQUFTO0FBQy9CLFdBQU8sTUFBTSxHQUFHLFNBQVMsUUFBUSxHQUFHLFNBQVM7QUFBQSxFQUMvQyxD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
