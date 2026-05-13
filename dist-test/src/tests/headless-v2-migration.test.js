import test from "node:test";
import assert from "node:assert/strict";
const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_BLOCKED = 10;
function mapStatusToExitCode(status) {
  switch (status) {
    case "success":
    case "complete":
      return EXIT_SUCCESS;
    case "error":
    case "timeout":
      return EXIT_ERROR;
    case "blocked":
      return EXIT_BLOCKED;
    case "cancelled":
      return 11;
    default:
      return EXIT_ERROR;
  }
}
const TERMINAL_PREFIXES = ["auto-mode stopped", "step-mode stopped"];
function isTerminalNotification(event) {
  if (event.type !== "extension_ui_request" || event.method !== "notify") return false;
  const message = String(event.message ?? "").toLowerCase();
  return TERMINAL_PREFIXES.some((prefix) => message.startsWith(prefix));
}
function isBlockedNotification(event) {
  if (event.type !== "extension_ui_request" || event.method !== "notify") return false;
  const message = String(event.message ?? "").toLowerCase();
  return message.includes("blocked:");
}
class MockRpcClient {
  sendUICalls = [];
  initCalled = false;
  initShouldFail = false;
  sendUIResponse(id, response) {
    this.sendUICalls.push({ id, response });
  }
  async init(_options) {
    this.initCalled = true;
    if (this.initShouldFail) {
      throw new Error("v2 init not supported");
    }
    return { protocolVersion: 2 };
  }
}
function handleExtensionUIRequest(event, client) {
  const { id, method } = event;
  switch (method) {
    case "select": {
      const title = String(event.title ?? "");
      let selected = event.options?.[0] ?? "";
      if (title.includes("Auto-mode is running") && event.options) {
        const forceOption = event.options.find((o) => o.toLowerCase().includes("force start"));
        if (forceOption) selected = forceOption;
      }
      client.sendUIResponse(id, { value: selected });
      break;
    }
    case "confirm":
      client.sendUIResponse(id, { confirmed: true });
      break;
    case "input":
      client.sendUIResponse(id, { value: "" });
      break;
    case "editor":
      client.sendUIResponse(id, { value: event.prefill ?? "" });
      break;
    case "notify":
    case "setStatus":
    case "setWidget":
    case "setTitle":
    case "set_editor_text":
      client.sendUIResponse(id, { value: "" });
      break;
    default:
      client.sendUIResponse(id, { cancelled: true });
      break;
  }
}
function handleEvent(eventObj, state, client) {
  if (eventObj.type === "execution_complete" && !state.completed && !state.isMultiTurnCommand) {
    state.completed = true;
    const status = String(eventObj.status ?? "success");
    state.exitCode = mapStatusToExitCode(status);
    if (eventObj.status === "blocked") state.blocked = true;
    return;
  }
  if (eventObj.type === "extension_ui_request") {
    if (isBlockedNotification(eventObj)) {
      state.blocked = true;
    }
    if (isTerminalNotification(eventObj)) {
      state.completed = true;
    }
    handleExtensionUIRequest(eventObj, client);
    if (state.completed) {
      state.exitCode = state.blocked ? EXIT_BLOCKED : EXIT_SUCCESS;
      return;
    }
  }
}
test("execution_complete with status success triggers completion with EXIT_SUCCESS", () => {
  const client = new MockRpcClient();
  const state = { completed: false, blocked: false, exitCode: -1, v2Enabled: true };
  handleEvent({ type: "execution_complete", status: "success" }, state, client);
  assert.equal(state.completed, true);
  assert.equal(state.exitCode, EXIT_SUCCESS);
  assert.equal(state.blocked, false);
});
test("execution_complete with status blocked sets blocked flag and EXIT_BLOCKED", () => {
  const client = new MockRpcClient();
  const state = { completed: false, blocked: false, exitCode: -1, v2Enabled: true };
  handleEvent({ type: "execution_complete", status: "blocked" }, state, client);
  assert.equal(state.completed, true);
  assert.equal(state.blocked, true);
  assert.equal(state.exitCode, EXIT_BLOCKED);
});
test("execution_complete with status error maps to EXIT_ERROR", () => {
  const client = new MockRpcClient();
  const state = { completed: false, blocked: false, exitCode: -1, v2Enabled: true };
  handleEvent({ type: "execution_complete", status: "error" }, state, client);
  assert.equal(state.completed, true);
  assert.equal(state.exitCode, EXIT_ERROR);
});
test("execution_complete with missing status defaults to success", () => {
  const client = new MockRpcClient();
  const state = { completed: false, blocked: false, exitCode: -1, v2Enabled: true };
  handleEvent({ type: "execution_complete" }, state, client);
  assert.equal(state.completed, true);
  assert.equal(state.exitCode, EXIT_SUCCESS);
});
test("execution_complete ignored if already completed", () => {
  const client = new MockRpcClient();
  const state = { completed: true, blocked: false, exitCode: EXIT_SUCCESS, v2Enabled: true };
  handleEvent({ type: "execution_complete", status: "error" }, state, client);
  assert.equal(state.exitCode, EXIT_SUCCESS);
});
test("v1 fallback: terminal notification still triggers completion", () => {
  const client = new MockRpcClient();
  const state = { completed: false, blocked: false, exitCode: -1, v2Enabled: false };
  handleEvent(
    { type: "extension_ui_request", method: "notify", id: "n1", message: "Auto-mode stopped \u2014 all slices complete" },
    state,
    client
  );
  assert.equal(state.completed, true);
  assert.equal(state.exitCode, EXIT_SUCCESS);
});
test("v1 fallback: blocked notification sets blocked flag", () => {
  const client = new MockRpcClient();
  const state = { completed: false, blocked: false, exitCode: -1, v2Enabled: false };
  handleEvent(
    { type: "extension_ui_request", method: "notify", id: "n1", message: "Auto-mode stopped (Blocked: plan invalid)" },
    state,
    client
  );
  assert.equal(state.completed, true);
  assert.equal(state.blocked, true);
  assert.equal(state.exitCode, EXIT_BLOCKED);
});
test("string-matching fallback works when execution_complete never received", () => {
  const client = new MockRpcClient();
  const state = { completed: false, blocked: false, exitCode: -1, v2Enabled: false };
  handleEvent({ type: "extension_ui_request", method: "select", id: "q1", options: ["option1"] }, state, client);
  assert.equal(state.completed, false);
  handleEvent(
    { type: "extension_ui_request", method: "notify", id: "n1", message: "Step-mode stopped \u2014 done" },
    state,
    client
  );
  assert.equal(state.completed, true);
  assert.equal(state.exitCode, EXIT_SUCCESS);
});
test("handleExtensionUIRequest select calls sendUIResponse with value", () => {
  const client = new MockRpcClient();
  handleExtensionUIRequest(
    { type: "extension_ui_request", id: "sel1", method: "select", options: ["option-a", "option-b"] },
    client
  );
  assert.equal(client.sendUICalls.length, 1);
  assert.equal(client.sendUICalls[0].id, "sel1");
  assert.equal(client.sendUICalls[0].response.value, "option-a");
});
test("handleExtensionUIRequest confirm calls sendUIResponse with confirmed", () => {
  const client = new MockRpcClient();
  handleExtensionUIRequest(
    { type: "extension_ui_request", id: "conf1", method: "confirm" },
    client
  );
  assert.equal(client.sendUICalls.length, 1);
  assert.equal(client.sendUICalls[0].id, "conf1");
  assert.equal(client.sendUICalls[0].response.confirmed, true);
});
test("handleExtensionUIRequest input calls sendUIResponse with empty value", () => {
  const client = new MockRpcClient();
  handleExtensionUIRequest(
    { type: "extension_ui_request", id: "inp1", method: "input" },
    client
  );
  assert.equal(client.sendUICalls.length, 1);
  assert.equal(client.sendUICalls[0].id, "inp1");
  assert.equal(client.sendUICalls[0].response.value, "");
});
test("handleExtensionUIRequest notify calls sendUIResponse with empty value", () => {
  const client = new MockRpcClient();
  handleExtensionUIRequest(
    { type: "extension_ui_request", id: "not1", method: "notify", message: "Task complete" },
    client
  );
  assert.equal(client.sendUICalls.length, 1);
  assert.equal(client.sendUICalls[0].id, "not1");
  assert.equal(client.sendUICalls[0].response.value, "");
});
test("handleExtensionUIRequest editor calls sendUIResponse with prefill", () => {
  const client = new MockRpcClient();
  handleExtensionUIRequest(
    { type: "extension_ui_request", id: "ed1", method: "editor", prefill: "initial text" },
    client
  );
  assert.equal(client.sendUICalls.length, 1);
  assert.equal(client.sendUICalls[0].id, "ed1");
  assert.equal(client.sendUICalls[0].response.value, "initial text");
});
test("handleExtensionUIRequest unknown method calls sendUIResponse with cancelled", () => {
  const client = new MockRpcClient();
  handleExtensionUIRequest(
    { type: "extension_ui_request", id: "unk1", method: "unknown_method" },
    client
  );
  assert.equal(client.sendUICalls.length, 1);
  assert.equal(client.sendUICalls[0].id, "unk1");
  assert.equal(client.sendUICalls[0].response.cancelled, true);
});
test("extension_ui_response forwarding extracts fields and calls sendUIResponse", () => {
  const client = new MockRpcClient();
  const msg = { type: "extension_ui_response", id: "resp1", value: "chosen option", confirmed: void 0, cancelled: void 0 };
  const id = String(msg.id ?? "");
  const value = msg.value !== void 0 ? String(msg.value) : void 0;
  const confirmed = typeof msg.confirmed === "boolean" ? msg.confirmed : void 0;
  const cancelled = typeof msg.cancelled === "boolean" ? msg.cancelled : void 0;
  client.sendUIResponse(id, { value, confirmed, cancelled });
  assert.equal(client.sendUICalls.length, 1);
  assert.equal(client.sendUICalls[0].id, "resp1");
  assert.equal(client.sendUICalls[0].response.value, "chosen option");
  assert.equal(client.sendUICalls[0].response.confirmed, void 0);
  assert.equal(client.sendUICalls[0].response.cancelled, void 0);
});
test("extension_ui_response with confirmed=true forwards correctly", () => {
  const client = new MockRpcClient();
  const msg = { type: "extension_ui_response", id: "resp2", confirmed: true };
  const id = String(msg.id ?? "");
  const confirmed = typeof msg.confirmed === "boolean" ? msg.confirmed : void 0;
  client.sendUIResponse(id, { confirmed });
  assert.equal(client.sendUICalls.length, 1);
  assert.equal(client.sendUICalls[0].id, "resp2");
  assert.equal(client.sendUICalls[0].response.confirmed, true);
});
test("v2 init success sets v2Enabled", async () => {
  const client = new MockRpcClient();
  let v2Enabled = false;
  try {
    await client.init({ clientId: "gsd-headless" });
    v2Enabled = true;
  } catch {
  }
  assert.equal(client.initCalled, true);
  assert.equal(v2Enabled, true);
});
test("v2 init failure falls back gracefully (v1 mode)", async () => {
  const client = new MockRpcClient();
  client.initShouldFail = true;
  let v2Enabled = false;
  try {
    await client.init({ clientId: "gsd-headless" });
    v2Enabled = true;
  } catch {
  }
  assert.equal(client.initCalled, true);
  assert.equal(v2Enabled, false);
});
test("injector adapter parses serialized JSONL and calls sendUIResponse", () => {
  const client = new MockRpcClient();
  const data = '{"type":"extension_ui_response","id":"inj1","value":"selected"}\n';
  const parsed = JSON.parse(data.trim());
  if (parsed.type === "extension_ui_response" && parsed.id) {
    const { id, value, values, confirmed, cancelled } = parsed;
    client.sendUIResponse(id, { value, values, confirmed, cancelled });
  }
  assert.equal(client.sendUICalls.length, 1);
  assert.equal(client.sendUICalls[0].id, "inj1");
  assert.equal(client.sendUICalls[0].response.value, "selected");
});
test("injector adapter handles cancelled response", () => {
  const client = new MockRpcClient();
  const data = '{"type":"extension_ui_response","id":"inj2","cancelled":true}\n';
  const parsed = JSON.parse(data.trim());
  if (parsed.type === "extension_ui_response" && parsed.id) {
    const { id, value, values, confirmed, cancelled } = parsed;
    client.sendUIResponse(id, { value, values, confirmed, cancelled });
  }
  assert.equal(client.sendUICalls.length, 1);
  assert.equal(client.sendUICalls[0].id, "inj2");
  assert.equal(client.sendUICalls[0].response.cancelled, true);
});
test("injector adapter handles multi-select values", () => {
  const client = new MockRpcClient();
  const data = '{"type":"extension_ui_response","id":"inj3","values":["a","b"]}\n';
  const parsed = JSON.parse(data.trim());
  if (parsed.type === "extension_ui_response" && parsed.id) {
    const { id, value, values, confirmed, cancelled } = parsed;
    client.sendUIResponse(id, { value, values, confirmed, cancelled });
  }
  assert.equal(client.sendUICalls.length, 1);
  assert.equal(client.sendUICalls[0].id, "inj3");
  assert.deepEqual(client.sendUICalls[0].response.values, ["a", "b"]);
});
test("execution_complete is ignored for multi-turn commands (auto)", () => {
  const client = new MockRpcClient();
  const state = { completed: false, blocked: false, exitCode: -1, v2Enabled: true, isMultiTurnCommand: true };
  handleEvent({ type: "execution_complete", status: "success" }, state, client);
  assert.equal(state.completed, false, "should not mark completed for auto/next commands");
  assert.equal(state.exitCode, -1, "exit code should remain unchanged");
});
test("execution_complete is ignored for multi-turn commands even with error status", () => {
  const client = new MockRpcClient();
  const state = { completed: false, blocked: false, exitCode: -1, v2Enabled: true, isMultiTurnCommand: true };
  handleEvent({ type: "execution_complete", status: "error" }, state, client);
  assert.equal(state.completed, false, "should not mark completed for auto/next commands");
  assert.equal(state.exitCode, -1, "exit code should remain unchanged");
});
test("multi-turn commands still complete via terminal notification", () => {
  const client = new MockRpcClient();
  const state = { completed: false, blocked: false, exitCode: -1, v2Enabled: true, isMultiTurnCommand: true };
  handleEvent({ type: "execution_complete", status: "success" }, state, client);
  assert.equal(state.completed, false, "execution_complete should be skipped");
  handleEvent(
    { type: "extension_ui_request", method: "notify", id: "n1", message: "Auto-mode stopped \u2014 all slices complete" },
    state,
    client
  );
  assert.equal(state.completed, true, "terminal notification should trigger completion");
  assert.equal(state.exitCode, EXIT_SUCCESS);
});
test("multi-turn commands detect blocked via terminal notification", () => {
  const client = new MockRpcClient();
  const state = { completed: false, blocked: false, exitCode: -1, v2Enabled: true, isMultiTurnCommand: true };
  handleEvent({ type: "execution_complete", status: "success" }, state, client);
  assert.equal(state.completed, false);
  handleEvent(
    { type: "extension_ui_request", method: "notify", id: "n2", message: "Auto-mode stopped (Blocked: plan rejected)" },
    state,
    client
  );
  assert.equal(state.completed, true);
  assert.equal(state.blocked, true);
  assert.equal(state.exitCode, EXIT_BLOCKED);
});
test("non-multi-turn commands still complete on execution_complete", () => {
  const client = new MockRpcClient();
  const state = { completed: false, blocked: false, exitCode: -1, v2Enabled: true, isMultiTurnCommand: false };
  handleEvent({ type: "execution_complete", status: "success" }, state, client);
  assert.equal(state.completed, true, "single-turn commands should complete on execution_complete");
  assert.equal(state.exitCode, EXIT_SUCCESS);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL2hlYWRsZXNzLXYyLW1pZ3JhdGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFRlc3RzIGZvciBoZWFkbGVzcyB2MiBtaWdyYXRpb24gXHUyMDE0IGV4ZWN1dGlvbl9jb21wbGV0ZSBoYW5kbGluZyxcbiAqIHNlbmRVSVJlc3BvbnNlLWJhc2VkIGF1dG8tcmVzcG9uc2UsIGFuZCB2MSBmYWxsYmFjayBiZWhhdmlvci5cbiAqXG4gKiBVc2VzIGV4dHJhY3RlZCBsb2dpYyBtaXJyb3JzIHRvIGF2b2lkIGltcG9ydGluZyBtb2R1bGVzIHdpdGggbmF0aXZlXG4gKiBkZXBlbmRlbmNpZXMgKHNhbWUgcGF0dGVybiBhcyBoZWFkbGVzcy1ldmVudHMudGVzdC50cyBhbmQgaGVhZGxlc3MtZGV0ZWN0aW9uLnRlc3QudHMpLlxuICovXG5cbmltcG9ydCB0ZXN0IGZyb20gJ25vZGU6dGVzdCdcbmltcG9ydCBhc3NlcnQgZnJvbSAnbm9kZTphc3NlcnQvc3RyaWN0J1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRXh0cmFjdGVkIGV4aXQgY29kZXMgKG1pcnJvcnMgaGVhZGxlc3MtZXZlbnRzLnRzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgRVhJVF9TVUNDRVNTID0gMFxuY29uc3QgRVhJVF9FUlJPUiA9IDFcbmNvbnN0IEVYSVRfQkxPQ0tFRCA9IDEwXG5cbmZ1bmN0aW9uIG1hcFN0YXR1c1RvRXhpdENvZGUoc3RhdHVzOiBzdHJpbmcpOiBudW1iZXIge1xuICBzd2l0Y2ggKHN0YXR1cykge1xuICAgIGNhc2UgJ3N1Y2Nlc3MnOlxuICAgIGNhc2UgJ2NvbXBsZXRlJzpcbiAgICAgIHJldHVybiBFWElUX1NVQ0NFU1NcbiAgICBjYXNlICdlcnJvcic6XG4gICAgY2FzZSAndGltZW91dCc6XG4gICAgICByZXR1cm4gRVhJVF9FUlJPUlxuICAgIGNhc2UgJ2Jsb2NrZWQnOlxuICAgICAgcmV0dXJuIEVYSVRfQkxPQ0tFRFxuICAgIGNhc2UgJ2NhbmNlbGxlZCc6XG4gICAgICByZXR1cm4gMTFcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIEVYSVRfRVJST1JcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRXh0cmFjdGVkIHRlcm1pbmFsIGRldGVjdGlvbiAobWlycm9ycyBoZWFkbGVzcy1ldmVudHMudHMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBURVJNSU5BTF9QUkVGSVhFUyA9IFsnYXV0by1tb2RlIHN0b3BwZWQnLCAnc3RlcC1tb2RlIHN0b3BwZWQnXVxuXG5mdW5jdGlvbiBpc1Rlcm1pbmFsTm90aWZpY2F0aW9uKGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IGJvb2xlYW4ge1xuICBpZiAoZXZlbnQudHlwZSAhPT0gJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JyB8fCBldmVudC5tZXRob2QgIT09ICdub3RpZnknKSByZXR1cm4gZmFsc2VcbiAgY29uc3QgbWVzc2FnZSA9IFN0cmluZyhldmVudC5tZXNzYWdlID8/ICcnKS50b0xvd2VyQ2FzZSgpXG4gIHJldHVybiBURVJNSU5BTF9QUkVGSVhFUy5zb21lKChwcmVmaXgpID0+IG1lc3NhZ2Uuc3RhcnRzV2l0aChwcmVmaXgpKVxufVxuXG5mdW5jdGlvbiBpc0Jsb2NrZWROb3RpZmljYXRpb24oZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogYm9vbGVhbiB7XG4gIGlmIChldmVudC50eXBlICE9PSAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnIHx8IGV2ZW50Lm1ldGhvZCAhPT0gJ25vdGlmeScpIHJldHVybiBmYWxzZVxuICBjb25zdCBtZXNzYWdlID0gU3RyaW5nKGV2ZW50Lm1lc3NhZ2UgPz8gJycpLnRvTG93ZXJDYXNlKClcbiAgcmV0dXJuIG1lc3NhZ2UuaW5jbHVkZXMoJ2Jsb2NrZWQ6Jylcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE1vY2sgUnBjQ2xpZW50IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5pbnRlcmZhY2UgU2VuZFVJQ2FsbCB7XG4gIGlkOiBzdHJpbmdcbiAgcmVzcG9uc2U6IHsgdmFsdWU/OiBzdHJpbmc7IHZhbHVlcz86IHN0cmluZ1tdOyBjb25maXJtZWQ/OiBib29sZWFuOyBjYW5jZWxsZWQ/OiBib29sZWFuIH1cbn1cblxuY2xhc3MgTW9ja1JwY0NsaWVudCB7XG4gIHNlbmRVSUNhbGxzOiBTZW5kVUlDYWxsW10gPSBbXVxuICBpbml0Q2FsbGVkID0gZmFsc2VcbiAgaW5pdFNob3VsZEZhaWwgPSBmYWxzZVxuXG4gIHNlbmRVSVJlc3BvbnNlKGlkOiBzdHJpbmcsIHJlc3BvbnNlOiB7IHZhbHVlPzogc3RyaW5nOyB2YWx1ZXM/OiBzdHJpbmdbXTsgY29uZmlybWVkPzogYm9vbGVhbjsgY2FuY2VsbGVkPzogYm9vbGVhbiB9KTogdm9pZCB7XG4gICAgdGhpcy5zZW5kVUlDYWxscy5wdXNoKHsgaWQsIHJlc3BvbnNlIH0pXG4gIH1cblxuICBhc3luYyBpbml0KF9vcHRpb25zPzogeyBjbGllbnRJZD86IHN0cmluZyB9KTogUHJvbWlzZTx7IHByb3RvY29sVmVyc2lvbjogbnVtYmVyIH0+IHtcbiAgICB0aGlzLmluaXRDYWxsZWQgPSB0cnVlXG4gICAgaWYgKHRoaXMuaW5pdFNob3VsZEZhaWwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcigndjIgaW5pdCBub3Qgc3VwcG9ydGVkJylcbiAgICB9XG4gICAgcmV0dXJuIHsgcHJvdG9jb2xWZXJzaW9uOiAyIH1cbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRXh0cmFjdGVkIGhhbmRsZUV4dGVuc2lvblVJUmVxdWVzdCAobWlycm9ycyBoZWFkbGVzcy11aS50cykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmludGVyZmFjZSBFeHRlbnNpb25VSVJlcXVlc3Qge1xuICB0eXBlOiAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnXG4gIGlkOiBzdHJpbmdcbiAgbWV0aG9kOiBzdHJpbmdcbiAgdGl0bGU/OiBzdHJpbmdcbiAgb3B0aW9ucz86IHN0cmluZ1tdXG4gIG1lc3NhZ2U/OiBzdHJpbmdcbiAgcHJlZmlsbD86IHN0cmluZ1xuICBba2V5OiBzdHJpbmddOiB1bmtub3duXG59XG5cbmZ1bmN0aW9uIGhhbmRsZUV4dGVuc2lvblVJUmVxdWVzdChcbiAgZXZlbnQ6IEV4dGVuc2lvblVJUmVxdWVzdCxcbiAgY2xpZW50OiBNb2NrUnBjQ2xpZW50LFxuKTogdm9pZCB7XG4gIGNvbnN0IHsgaWQsIG1ldGhvZCB9ID0gZXZlbnRcblxuICBzd2l0Y2ggKG1ldGhvZCkge1xuICAgIGNhc2UgJ3NlbGVjdCc6IHtcbiAgICAgIGNvbnN0IHRpdGxlID0gU3RyaW5nKGV2ZW50LnRpdGxlID8/ICcnKVxuICAgICAgbGV0IHNlbGVjdGVkID0gZXZlbnQub3B0aW9ucz8uWzBdID8/ICcnXG4gICAgICBpZiAodGl0bGUuaW5jbHVkZXMoJ0F1dG8tbW9kZSBpcyBydW5uaW5nJykgJiYgZXZlbnQub3B0aW9ucykge1xuICAgICAgICBjb25zdCBmb3JjZU9wdGlvbiA9IGV2ZW50Lm9wdGlvbnMuZmluZChvID0+IG8udG9Mb3dlckNhc2UoKS5pbmNsdWRlcygnZm9yY2Ugc3RhcnQnKSlcbiAgICAgICAgaWYgKGZvcmNlT3B0aW9uKSBzZWxlY3RlZCA9IGZvcmNlT3B0aW9uXG4gICAgICB9XG4gICAgICBjbGllbnQuc2VuZFVJUmVzcG9uc2UoaWQsIHsgdmFsdWU6IHNlbGVjdGVkIH0pXG4gICAgICBicmVha1xuICAgIH1cbiAgICBjYXNlICdjb25maXJtJzpcbiAgICAgIGNsaWVudC5zZW5kVUlSZXNwb25zZShpZCwgeyBjb25maXJtZWQ6IHRydWUgfSlcbiAgICAgIGJyZWFrXG4gICAgY2FzZSAnaW5wdXQnOlxuICAgICAgY2xpZW50LnNlbmRVSVJlc3BvbnNlKGlkLCB7IHZhbHVlOiAnJyB9KVxuICAgICAgYnJlYWtcbiAgICBjYXNlICdlZGl0b3InOlxuICAgICAgY2xpZW50LnNlbmRVSVJlc3BvbnNlKGlkLCB7IHZhbHVlOiBldmVudC5wcmVmaWxsID8/ICcnIH0pXG4gICAgICBicmVha1xuICAgIGNhc2UgJ25vdGlmeSc6XG4gICAgY2FzZSAnc2V0U3RhdHVzJzpcbiAgICBjYXNlICdzZXRXaWRnZXQnOlxuICAgIGNhc2UgJ3NldFRpdGxlJzpcbiAgICBjYXNlICdzZXRfZWRpdG9yX3RleHQnOlxuICAgICAgY2xpZW50LnNlbmRVSVJlc3BvbnNlKGlkLCB7IHZhbHVlOiAnJyB9KVxuICAgICAgYnJlYWtcbiAgICBkZWZhdWx0OlxuICAgICAgY2xpZW50LnNlbmRVSVJlc3BvbnNlKGlkLCB7IGNhbmNlbGxlZDogdHJ1ZSB9KVxuICAgICAgYnJlYWtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2ltdWxhdGVkIGV2ZW50IGhhbmRsZXIgKG1pcnJvcnMgaGVhZGxlc3MudHMgZXZlbnQgaGFuZGxlciBsb2dpYykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmludGVyZmFjZSBFdmVudEhhbmRsZXJTdGF0ZSB7XG4gIGNvbXBsZXRlZDogYm9vbGVhblxuICBibG9ja2VkOiBib29sZWFuXG4gIGV4aXRDb2RlOiBudW1iZXJcbiAgdjJFbmFibGVkOiBib29sZWFuXG4gIGlzTXVsdGlUdXJuQ29tbWFuZD86IGJvb2xlYW5cbn1cblxuZnVuY3Rpb24gaGFuZGxlRXZlbnQoXG4gIGV2ZW50T2JqOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgc3RhdGU6IEV2ZW50SGFuZGxlclN0YXRlLFxuICBjbGllbnQ6IE1vY2tScGNDbGllbnQsXG4pOiB2b2lkIHtcbiAgLy8gZXhlY3V0aW9uX2NvbXBsZXRlICh2MiBzdHJ1Y3R1cmVkIGNvbXBsZXRpb24pXG4gIC8vIFNraXAgZm9yIG11bHRpLXR1cm4gY29tbWFuZHMgKGF1dG8sIG5leHQpIFx1MjAxNCB0aGVpciBjb21wbGV0aW9uIGlzIGRldGVjdGVkIHZpYVxuICAvLyBpc1Rlcm1pbmFsTm90aWZpY2F0aW9uLCBub3QgcGVyLXR1cm4gZXZlbnRzXG4gIGlmIChldmVudE9iai50eXBlID09PSAnZXhlY3V0aW9uX2NvbXBsZXRlJyAmJiAhc3RhdGUuY29tcGxldGVkICYmICFzdGF0ZS5pc011bHRpVHVybkNvbW1hbmQpIHtcbiAgICBzdGF0ZS5jb21wbGV0ZWQgPSB0cnVlXG4gICAgY29uc3Qgc3RhdHVzID0gU3RyaW5nKGV2ZW50T2JqLnN0YXR1cyA/PyAnc3VjY2VzcycpXG4gICAgc3RhdGUuZXhpdENvZGUgPSBtYXBTdGF0dXNUb0V4aXRDb2RlKHN0YXR1cylcbiAgICBpZiAoZXZlbnRPYmouc3RhdHVzID09PSAnYmxvY2tlZCcpIHN0YXRlLmJsb2NrZWQgPSB0cnVlXG4gICAgcmV0dXJuXG4gIH1cblxuICAvLyBleHRlbnNpb25fdWlfcmVxdWVzdCAodjEgZmFsbGJhY2sgKyBVSSByZXNwb25zZXMpXG4gIGlmIChldmVudE9iai50eXBlID09PSAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnKSB7XG4gICAgaWYgKGlzQmxvY2tlZE5vdGlmaWNhdGlvbihldmVudE9iaikpIHtcbiAgICAgIHN0YXRlLmJsb2NrZWQgPSB0cnVlXG4gICAgfVxuXG4gICAgaWYgKGlzVGVybWluYWxOb3RpZmljYXRpb24oZXZlbnRPYmopKSB7XG4gICAgICBzdGF0ZS5jb21wbGV0ZWQgPSB0cnVlXG4gICAgfVxuXG4gICAgaGFuZGxlRXh0ZW5zaW9uVUlSZXF1ZXN0KGV2ZW50T2JqIGFzIHVua25vd24gYXMgRXh0ZW5zaW9uVUlSZXF1ZXN0LCBjbGllbnQpXG5cbiAgICBpZiAoc3RhdGUuY29tcGxldGVkKSB7XG4gICAgICBzdGF0ZS5leGl0Q29kZSA9IHN0YXRlLmJsb2NrZWQgPyBFWElUX0JMT0NLRUQgOiBFWElUX1NVQ0NFU1NcbiAgICAgIHJldHVyblxuICAgIH1cbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZXhlY3V0aW9uX2NvbXBsZXRlIGV2ZW50IGhhbmRsaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KCdleGVjdXRpb25fY29tcGxldGUgd2l0aCBzdGF0dXMgc3VjY2VzcyB0cmlnZ2VycyBjb21wbGV0aW9uIHdpdGggRVhJVF9TVUNDRVNTJywgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgTW9ja1JwY0NsaWVudCgpXG4gIGNvbnN0IHN0YXRlOiBFdmVudEhhbmRsZXJTdGF0ZSA9IHsgY29tcGxldGVkOiBmYWxzZSwgYmxvY2tlZDogZmFsc2UsIGV4aXRDb2RlOiAtMSwgdjJFbmFibGVkOiB0cnVlIH1cblxuICBoYW5kbGVFdmVudCh7IHR5cGU6ICdleGVjdXRpb25fY29tcGxldGUnLCBzdGF0dXM6ICdzdWNjZXNzJyB9LCBzdGF0ZSwgY2xpZW50KVxuXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5jb21wbGV0ZWQsIHRydWUpXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5leGl0Q29kZSwgRVhJVF9TVUNDRVNTKVxuICBhc3NlcnQuZXF1YWwoc3RhdGUuYmxvY2tlZCwgZmFsc2UpXG59KVxuXG50ZXN0KCdleGVjdXRpb25fY29tcGxldGUgd2l0aCBzdGF0dXMgYmxvY2tlZCBzZXRzIGJsb2NrZWQgZmxhZyBhbmQgRVhJVF9CTE9DS0VEJywgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgTW9ja1JwY0NsaWVudCgpXG4gIGNvbnN0IHN0YXRlOiBFdmVudEhhbmRsZXJTdGF0ZSA9IHsgY29tcGxldGVkOiBmYWxzZSwgYmxvY2tlZDogZmFsc2UsIGV4aXRDb2RlOiAtMSwgdjJFbmFibGVkOiB0cnVlIH1cblxuICBoYW5kbGVFdmVudCh7IHR5cGU6ICdleGVjdXRpb25fY29tcGxldGUnLCBzdGF0dXM6ICdibG9ja2VkJyB9LCBzdGF0ZSwgY2xpZW50KVxuXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5jb21wbGV0ZWQsIHRydWUpXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5ibG9ja2VkLCB0cnVlKVxuICBhc3NlcnQuZXF1YWwoc3RhdGUuZXhpdENvZGUsIEVYSVRfQkxPQ0tFRClcbn0pXG5cbnRlc3QoJ2V4ZWN1dGlvbl9jb21wbGV0ZSB3aXRoIHN0YXR1cyBlcnJvciBtYXBzIHRvIEVYSVRfRVJST1InLCAoKSA9PiB7XG4gIGNvbnN0IGNsaWVudCA9IG5ldyBNb2NrUnBjQ2xpZW50KClcbiAgY29uc3Qgc3RhdGU6IEV2ZW50SGFuZGxlclN0YXRlID0geyBjb21wbGV0ZWQ6IGZhbHNlLCBibG9ja2VkOiBmYWxzZSwgZXhpdENvZGU6IC0xLCB2MkVuYWJsZWQ6IHRydWUgfVxuXG4gIGhhbmRsZUV2ZW50KHsgdHlwZTogJ2V4ZWN1dGlvbl9jb21wbGV0ZScsIHN0YXR1czogJ2Vycm9yJyB9LCBzdGF0ZSwgY2xpZW50KVxuXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5jb21wbGV0ZWQsIHRydWUpXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5leGl0Q29kZSwgRVhJVF9FUlJPUilcbn0pXG5cbnRlc3QoJ2V4ZWN1dGlvbl9jb21wbGV0ZSB3aXRoIG1pc3Npbmcgc3RhdHVzIGRlZmF1bHRzIHRvIHN1Y2Nlc3MnLCAoKSA9PiB7XG4gIGNvbnN0IGNsaWVudCA9IG5ldyBNb2NrUnBjQ2xpZW50KClcbiAgY29uc3Qgc3RhdGU6IEV2ZW50SGFuZGxlclN0YXRlID0geyBjb21wbGV0ZWQ6IGZhbHNlLCBibG9ja2VkOiBmYWxzZSwgZXhpdENvZGU6IC0xLCB2MkVuYWJsZWQ6IHRydWUgfVxuXG4gIGhhbmRsZUV2ZW50KHsgdHlwZTogJ2V4ZWN1dGlvbl9jb21wbGV0ZScgfSwgc3RhdGUsIGNsaWVudClcblxuICBhc3NlcnQuZXF1YWwoc3RhdGUuY29tcGxldGVkLCB0cnVlKVxuICBhc3NlcnQuZXF1YWwoc3RhdGUuZXhpdENvZGUsIEVYSVRfU1VDQ0VTUylcbn0pXG5cbnRlc3QoJ2V4ZWN1dGlvbl9jb21wbGV0ZSBpZ25vcmVkIGlmIGFscmVhZHkgY29tcGxldGVkJywgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgTW9ja1JwY0NsaWVudCgpXG4gIGNvbnN0IHN0YXRlOiBFdmVudEhhbmRsZXJTdGF0ZSA9IHsgY29tcGxldGVkOiB0cnVlLCBibG9ja2VkOiBmYWxzZSwgZXhpdENvZGU6IEVYSVRfU1VDQ0VTUywgdjJFbmFibGVkOiB0cnVlIH1cblxuICBoYW5kbGVFdmVudCh7IHR5cGU6ICdleGVjdXRpb25fY29tcGxldGUnLCBzdGF0dXM6ICdlcnJvcicgfSwgc3RhdGUsIGNsaWVudClcblxuICAvLyBTaG91bGQgbm90IGNoYW5nZSBleGl0Q29kZSBiZWNhdXNlIGFscmVhZHkgY29tcGxldGVkXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5leGl0Q29kZSwgRVhJVF9TVUNDRVNTKVxufSlcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHYxIHN0cmluZy1tYXRjaGluZyBmYWxsYmFjayBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgndjEgZmFsbGJhY2s6IHRlcm1pbmFsIG5vdGlmaWNhdGlvbiBzdGlsbCB0cmlnZ2VycyBjb21wbGV0aW9uJywgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgTW9ja1JwY0NsaWVudCgpXG4gIGNvbnN0IHN0YXRlOiBFdmVudEhhbmRsZXJTdGF0ZSA9IHsgY29tcGxldGVkOiBmYWxzZSwgYmxvY2tlZDogZmFsc2UsIGV4aXRDb2RlOiAtMSwgdjJFbmFibGVkOiBmYWxzZSB9XG5cbiAgaGFuZGxlRXZlbnQoXG4gICAgeyB0eXBlOiAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnLCBtZXRob2Q6ICdub3RpZnknLCBpZDogJ24xJywgbWVzc2FnZTogJ0F1dG8tbW9kZSBzdG9wcGVkIFx1MjAxNCBhbGwgc2xpY2VzIGNvbXBsZXRlJyB9LFxuICAgIHN0YXRlLFxuICAgIGNsaWVudCxcbiAgKVxuXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5jb21wbGV0ZWQsIHRydWUpXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5leGl0Q29kZSwgRVhJVF9TVUNDRVNTKVxufSlcblxudGVzdCgndjEgZmFsbGJhY2s6IGJsb2NrZWQgbm90aWZpY2F0aW9uIHNldHMgYmxvY2tlZCBmbGFnJywgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgTW9ja1JwY0NsaWVudCgpXG4gIGNvbnN0IHN0YXRlOiBFdmVudEhhbmRsZXJTdGF0ZSA9IHsgY29tcGxldGVkOiBmYWxzZSwgYmxvY2tlZDogZmFsc2UsIGV4aXRDb2RlOiAtMSwgdjJFbmFibGVkOiBmYWxzZSB9XG5cbiAgaGFuZGxlRXZlbnQoXG4gICAgeyB0eXBlOiAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnLCBtZXRob2Q6ICdub3RpZnknLCBpZDogJ24xJywgbWVzc2FnZTogJ0F1dG8tbW9kZSBzdG9wcGVkIChCbG9ja2VkOiBwbGFuIGludmFsaWQpJyB9LFxuICAgIHN0YXRlLFxuICAgIGNsaWVudCxcbiAgKVxuXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5jb21wbGV0ZWQsIHRydWUpXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5ibG9ja2VkLCB0cnVlKVxuICBhc3NlcnQuZXF1YWwoc3RhdGUuZXhpdENvZGUsIEVYSVRfQkxPQ0tFRClcbn0pXG5cbnRlc3QoJ3N0cmluZy1tYXRjaGluZyBmYWxsYmFjayB3b3JrcyB3aGVuIGV4ZWN1dGlvbl9jb21wbGV0ZSBuZXZlciByZWNlaXZlZCcsICgpID0+IHtcbiAgY29uc3QgY2xpZW50ID0gbmV3IE1vY2tScGNDbGllbnQoKVxuICBjb25zdCBzdGF0ZTogRXZlbnRIYW5kbGVyU3RhdGUgPSB7IGNvbXBsZXRlZDogZmFsc2UsIGJsb2NrZWQ6IGZhbHNlLCBleGl0Q29kZTogLTEsIHYyRW5hYmxlZDogZmFsc2UgfVxuXG4gIC8vIFNpbXVsYXRlIGEgbm9ybWFsIHNlc3Npb24gd2l0aG91dCBleGVjdXRpb25fY29tcGxldGVcbiAgaGFuZGxlRXZlbnQoeyB0eXBlOiAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnLCBtZXRob2Q6ICdzZWxlY3QnLCBpZDogJ3ExJywgb3B0aW9uczogWydvcHRpb24xJ10gfSwgc3RhdGUsIGNsaWVudClcbiAgYXNzZXJ0LmVxdWFsKHN0YXRlLmNvbXBsZXRlZCwgZmFsc2UpXG5cbiAgaGFuZGxlRXZlbnQoXG4gICAgeyB0eXBlOiAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnLCBtZXRob2Q6ICdub3RpZnknLCBpZDogJ24xJywgbWVzc2FnZTogJ1N0ZXAtbW9kZSBzdG9wcGVkIFx1MjAxNCBkb25lJyB9LFxuICAgIHN0YXRlLFxuICAgIGNsaWVudCxcbiAgKVxuICBhc3NlcnQuZXF1YWwoc3RhdGUuY29tcGxldGVkLCB0cnVlKVxuICBhc3NlcnQuZXF1YWwoc3RhdGUuZXhpdENvZGUsIEVYSVRfU1VDQ0VTUylcbn0pXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBoYW5kbGVFeHRlbnNpb25VSVJlcXVlc3QgdXNlcyBjbGllbnQuc2VuZFVJUmVzcG9uc2UgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ2hhbmRsZUV4dGVuc2lvblVJUmVxdWVzdCBzZWxlY3QgY2FsbHMgc2VuZFVJUmVzcG9uc2Ugd2l0aCB2YWx1ZScsICgpID0+IHtcbiAgY29uc3QgY2xpZW50ID0gbmV3IE1vY2tScGNDbGllbnQoKVxuXG4gIGhhbmRsZUV4dGVuc2lvblVJUmVxdWVzdChcbiAgICB7IHR5cGU6ICdleHRlbnNpb25fdWlfcmVxdWVzdCcsIGlkOiAnc2VsMScsIG1ldGhvZDogJ3NlbGVjdCcsIG9wdGlvbnM6IFsnb3B0aW9uLWEnLCAnb3B0aW9uLWInXSB9LFxuICAgIGNsaWVudCxcbiAgKVxuXG4gIGFzc2VydC5lcXVhbChjbGllbnQuc2VuZFVJQ2FsbHMubGVuZ3RoLCAxKVxuICBhc3NlcnQuZXF1YWwoY2xpZW50LnNlbmRVSUNhbGxzWzBdLmlkLCAnc2VsMScpXG4gIGFzc2VydC5lcXVhbChjbGllbnQuc2VuZFVJQ2FsbHNbMF0ucmVzcG9uc2UudmFsdWUsICdvcHRpb24tYScpXG59KVxuXG50ZXN0KCdoYW5kbGVFeHRlbnNpb25VSVJlcXVlc3QgY29uZmlybSBjYWxscyBzZW5kVUlSZXNwb25zZSB3aXRoIGNvbmZpcm1lZCcsICgpID0+IHtcbiAgY29uc3QgY2xpZW50ID0gbmV3IE1vY2tScGNDbGllbnQoKVxuXG4gIGhhbmRsZUV4dGVuc2lvblVJUmVxdWVzdChcbiAgICB7IHR5cGU6ICdleHRlbnNpb25fdWlfcmVxdWVzdCcsIGlkOiAnY29uZjEnLCBtZXRob2Q6ICdjb25maXJtJyB9LFxuICAgIGNsaWVudCxcbiAgKVxuXG4gIGFzc2VydC5lcXVhbChjbGllbnQuc2VuZFVJQ2FsbHMubGVuZ3RoLCAxKVxuICBhc3NlcnQuZXF1YWwoY2xpZW50LnNlbmRVSUNhbGxzWzBdLmlkLCAnY29uZjEnKVxuICBhc3NlcnQuZXF1YWwoY2xpZW50LnNlbmRVSUNhbGxzWzBdLnJlc3BvbnNlLmNvbmZpcm1lZCwgdHJ1ZSlcbn0pXG5cbnRlc3QoJ2hhbmRsZUV4dGVuc2lvblVJUmVxdWVzdCBpbnB1dCBjYWxscyBzZW5kVUlSZXNwb25zZSB3aXRoIGVtcHR5IHZhbHVlJywgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgTW9ja1JwY0NsaWVudCgpXG5cbiAgaGFuZGxlRXh0ZW5zaW9uVUlSZXF1ZXN0KFxuICAgIHsgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JywgaWQ6ICdpbnAxJywgbWV0aG9kOiAnaW5wdXQnIH0sXG4gICAgY2xpZW50LFxuICApXG5cbiAgYXNzZXJ0LmVxdWFsKGNsaWVudC5zZW5kVUlDYWxscy5sZW5ndGgsIDEpXG4gIGFzc2VydC5lcXVhbChjbGllbnQuc2VuZFVJQ2FsbHNbMF0uaWQsICdpbnAxJylcbiAgYXNzZXJ0LmVxdWFsKGNsaWVudC5zZW5kVUlDYWxsc1swXS5yZXNwb25zZS52YWx1ZSwgJycpXG59KVxuXG50ZXN0KCdoYW5kbGVFeHRlbnNpb25VSVJlcXVlc3Qgbm90aWZ5IGNhbGxzIHNlbmRVSVJlc3BvbnNlIHdpdGggZW1wdHkgdmFsdWUnLCAoKSA9PiB7XG4gIGNvbnN0IGNsaWVudCA9IG5ldyBNb2NrUnBjQ2xpZW50KClcblxuICBoYW5kbGVFeHRlbnNpb25VSVJlcXVlc3QoXG4gICAgeyB0eXBlOiAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnLCBpZDogJ25vdDEnLCBtZXRob2Q6ICdub3RpZnknLCBtZXNzYWdlOiAnVGFzayBjb21wbGV0ZScgfSxcbiAgICBjbGllbnQsXG4gIClcblxuICBhc3NlcnQuZXF1YWwoY2xpZW50LnNlbmRVSUNhbGxzLmxlbmd0aCwgMSlcbiAgYXNzZXJ0LmVxdWFsKGNsaWVudC5zZW5kVUlDYWxsc1swXS5pZCwgJ25vdDEnKVxuICBhc3NlcnQuZXF1YWwoY2xpZW50LnNlbmRVSUNhbGxzWzBdLnJlc3BvbnNlLnZhbHVlLCAnJylcbn0pXG5cbnRlc3QoJ2hhbmRsZUV4dGVuc2lvblVJUmVxdWVzdCBlZGl0b3IgY2FsbHMgc2VuZFVJUmVzcG9uc2Ugd2l0aCBwcmVmaWxsJywgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgTW9ja1JwY0NsaWVudCgpXG5cbiAgaGFuZGxlRXh0ZW5zaW9uVUlSZXF1ZXN0KFxuICAgIHsgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JywgaWQ6ICdlZDEnLCBtZXRob2Q6ICdlZGl0b3InLCBwcmVmaWxsOiAnaW5pdGlhbCB0ZXh0JyB9LFxuICAgIGNsaWVudCxcbiAgKVxuXG4gIGFzc2VydC5lcXVhbChjbGllbnQuc2VuZFVJQ2FsbHMubGVuZ3RoLCAxKVxuICBhc3NlcnQuZXF1YWwoY2xpZW50LnNlbmRVSUNhbGxzWzBdLmlkLCAnZWQxJylcbiAgYXNzZXJ0LmVxdWFsKGNsaWVudC5zZW5kVUlDYWxsc1swXS5yZXNwb25zZS52YWx1ZSwgJ2luaXRpYWwgdGV4dCcpXG59KVxuXG50ZXN0KCdoYW5kbGVFeHRlbnNpb25VSVJlcXVlc3QgdW5rbm93biBtZXRob2QgY2FsbHMgc2VuZFVJUmVzcG9uc2Ugd2l0aCBjYW5jZWxsZWQnLCAoKSA9PiB7XG4gIGNvbnN0IGNsaWVudCA9IG5ldyBNb2NrUnBjQ2xpZW50KClcblxuICBoYW5kbGVFeHRlbnNpb25VSVJlcXVlc3QoXG4gICAgeyB0eXBlOiAnZXh0ZW5zaW9uX3VpX3JlcXVlc3QnLCBpZDogJ3VuazEnLCBtZXRob2Q6ICd1bmtub3duX21ldGhvZCcgfSxcbiAgICBjbGllbnQsXG4gIClcblxuICBhc3NlcnQuZXF1YWwoY2xpZW50LnNlbmRVSUNhbGxzLmxlbmd0aCwgMSlcbiAgYXNzZXJ0LmVxdWFsKGNsaWVudC5zZW5kVUlDYWxsc1swXS5pZCwgJ3VuazEnKVxuICBhc3NlcnQuZXF1YWwoY2xpZW50LnNlbmRVSUNhbGxzWzBdLnJlc3BvbnNlLmNhbmNlbGxlZCwgdHJ1ZSlcbn0pXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBzdXBlcnZpc2VkIHN0ZGluIHJlYWRlciBmb3J3YXJkaW5nIHZpYSBzZW5kVUlSZXNwb25zZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnZXh0ZW5zaW9uX3VpX3Jlc3BvbnNlIGZvcndhcmRpbmcgZXh0cmFjdHMgZmllbGRzIGFuZCBjYWxscyBzZW5kVUlSZXNwb25zZScsICgpID0+IHtcbiAgLy8gU2ltdWxhdGVzIHdoYXQgc3RhcnRTdXBlcnZpc2VkU3RkaW5SZWFkZXIgZG9lcyB3aXRoIGEgcGFyc2VkIG1lc3NhZ2VcbiAgY29uc3QgY2xpZW50ID0gbmV3IE1vY2tScGNDbGllbnQoKVxuXG4gIGNvbnN0IG1zZyA9IHsgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXNwb25zZScsIGlkOiAncmVzcDEnLCB2YWx1ZTogJ2Nob3NlbiBvcHRpb24nLCBjb25maXJtZWQ6IHVuZGVmaW5lZCwgY2FuY2VsbGVkOiB1bmRlZmluZWQgfVxuICBjb25zdCBpZCA9IFN0cmluZyhtc2cuaWQgPz8gJycpXG4gIGNvbnN0IHZhbHVlID0gbXNnLnZhbHVlICE9PSB1bmRlZmluZWQgPyBTdHJpbmcobXNnLnZhbHVlKSA6IHVuZGVmaW5lZFxuICBjb25zdCBjb25maXJtZWQgPSB0eXBlb2YgbXNnLmNvbmZpcm1lZCA9PT0gJ2Jvb2xlYW4nID8gbXNnLmNvbmZpcm1lZCA6IHVuZGVmaW5lZFxuICBjb25zdCBjYW5jZWxsZWQgPSB0eXBlb2YgbXNnLmNhbmNlbGxlZCA9PT0gJ2Jvb2xlYW4nID8gbXNnLmNhbmNlbGxlZCA6IHVuZGVmaW5lZFxuICBjbGllbnQuc2VuZFVJUmVzcG9uc2UoaWQsIHsgdmFsdWUsIGNvbmZpcm1lZCwgY2FuY2VsbGVkIH0pXG5cbiAgYXNzZXJ0LmVxdWFsKGNsaWVudC5zZW5kVUlDYWxscy5sZW5ndGgsIDEpXG4gIGFzc2VydC5lcXVhbChjbGllbnQuc2VuZFVJQ2FsbHNbMF0uaWQsICdyZXNwMScpXG4gIGFzc2VydC5lcXVhbChjbGllbnQuc2VuZFVJQ2FsbHNbMF0ucmVzcG9uc2UudmFsdWUsICdjaG9zZW4gb3B0aW9uJylcbiAgYXNzZXJ0LmVxdWFsKGNsaWVudC5zZW5kVUlDYWxsc1swXS5yZXNwb25zZS5jb25maXJtZWQsIHVuZGVmaW5lZClcbiAgYXNzZXJ0LmVxdWFsKGNsaWVudC5zZW5kVUlDYWxsc1swXS5yZXNwb25zZS5jYW5jZWxsZWQsIHVuZGVmaW5lZClcbn0pXG5cbnRlc3QoJ2V4dGVuc2lvbl91aV9yZXNwb25zZSB3aXRoIGNvbmZpcm1lZD10cnVlIGZvcndhcmRzIGNvcnJlY3RseScsICgpID0+IHtcbiAgY29uc3QgY2xpZW50ID0gbmV3IE1vY2tScGNDbGllbnQoKVxuXG4gIGNvbnN0IG1zZyA9IHsgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXNwb25zZScsIGlkOiAncmVzcDInLCBjb25maXJtZWQ6IHRydWUgfVxuICBjb25zdCBpZCA9IFN0cmluZyhtc2cuaWQgPz8gJycpXG4gIGNvbnN0IGNvbmZpcm1lZCA9IHR5cGVvZiBtc2cuY29uZmlybWVkID09PSAnYm9vbGVhbicgPyBtc2cuY29uZmlybWVkIDogdW5kZWZpbmVkXG4gIGNsaWVudC5zZW5kVUlSZXNwb25zZShpZCwgeyBjb25maXJtZWQgfSlcblxuICBhc3NlcnQuZXF1YWwoY2xpZW50LnNlbmRVSUNhbGxzLmxlbmd0aCwgMSlcbiAgYXNzZXJ0LmVxdWFsKGNsaWVudC5zZW5kVUlDYWxsc1swXS5pZCwgJ3Jlc3AyJylcbiAgYXNzZXJ0LmVxdWFsKGNsaWVudC5zZW5kVUlDYWxsc1swXS5yZXNwb25zZS5jb25maXJtZWQsIHRydWUpXG59KVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgdjIgaW5pdCBuZWdvdGlhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgndjIgaW5pdCBzdWNjZXNzIHNldHMgdjJFbmFibGVkJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgTW9ja1JwY0NsaWVudCgpXG4gIGxldCB2MkVuYWJsZWQgPSBmYWxzZVxuICB0cnkge1xuICAgIGF3YWl0IGNsaWVudC5pbml0KHsgY2xpZW50SWQ6ICdnc2QtaGVhZGxlc3MnIH0pXG4gICAgdjJFbmFibGVkID0gdHJ1ZVxuICB9IGNhdGNoIHtcbiAgICAvLyBmYWxsIGJhY2sgdG8gdjFcbiAgfVxuXG4gIGFzc2VydC5lcXVhbChjbGllbnQuaW5pdENhbGxlZCwgdHJ1ZSlcbiAgYXNzZXJ0LmVxdWFsKHYyRW5hYmxlZCwgdHJ1ZSlcbn0pXG5cbnRlc3QoJ3YyIGluaXQgZmFpbHVyZSBmYWxscyBiYWNrIGdyYWNlZnVsbHkgKHYxIG1vZGUpJywgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgTW9ja1JwY0NsaWVudCgpXG4gIGNsaWVudC5pbml0U2hvdWxkRmFpbCA9IHRydWVcbiAgbGV0IHYyRW5hYmxlZCA9IGZhbHNlXG4gIHRyeSB7XG4gICAgYXdhaXQgY2xpZW50LmluaXQoeyBjbGllbnRJZDogJ2dzZC1oZWFkbGVzcycgfSlcbiAgICB2MkVuYWJsZWQgPSB0cnVlXG4gIH0gY2F0Y2gge1xuICAgIC8vIGZhbGwgYmFjayB0byB2MSBcdTIwMTQgdGhpcyBpcyBleHBlY3RlZFxuICB9XG5cbiAgYXNzZXJ0LmVxdWFsKGNsaWVudC5pbml0Q2FsbGVkLCB0cnVlKVxuICBhc3NlcnQuZXF1YWwodjJFbmFibGVkLCBmYWxzZSlcbn0pXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBpbmplY3RvciBhZGFwdGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KCdpbmplY3RvciBhZGFwdGVyIHBhcnNlcyBzZXJpYWxpemVkIEpTT05MIGFuZCBjYWxscyBzZW5kVUlSZXNwb25zZScsICgpID0+IHtcbiAgY29uc3QgY2xpZW50ID0gbmV3IE1vY2tScGNDbGllbnQoKVxuXG4gIC8vIFNpbXVsYXRlIHdoYXQgdGhlIGFkYXB0ZXIgZG9lc1xuICBjb25zdCBkYXRhID0gJ3tcInR5cGVcIjpcImV4dGVuc2lvbl91aV9yZXNwb25zZVwiLFwiaWRcIjpcImluajFcIixcInZhbHVlXCI6XCJzZWxlY3RlZFwifVxcbidcbiAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShkYXRhLnRyaW0oKSlcbiAgaWYgKHBhcnNlZC50eXBlID09PSAnZXh0ZW5zaW9uX3VpX3Jlc3BvbnNlJyAmJiBwYXJzZWQuaWQpIHtcbiAgICBjb25zdCB7IGlkLCB2YWx1ZSwgdmFsdWVzLCBjb25maXJtZWQsIGNhbmNlbGxlZCB9ID0gcGFyc2VkXG4gICAgY2xpZW50LnNlbmRVSVJlc3BvbnNlKGlkLCB7IHZhbHVlLCB2YWx1ZXMsIGNvbmZpcm1lZCwgY2FuY2VsbGVkIH0pXG4gIH1cblxuICBhc3NlcnQuZXF1YWwoY2xpZW50LnNlbmRVSUNhbGxzLmxlbmd0aCwgMSlcbiAgYXNzZXJ0LmVxdWFsKGNsaWVudC5zZW5kVUlDYWxsc1swXS5pZCwgJ2luajEnKVxuICBhc3NlcnQuZXF1YWwoY2xpZW50LnNlbmRVSUNhbGxzWzBdLnJlc3BvbnNlLnZhbHVlLCAnc2VsZWN0ZWQnKVxufSlcblxudGVzdCgnaW5qZWN0b3IgYWRhcHRlciBoYW5kbGVzIGNhbmNlbGxlZCByZXNwb25zZScsICgpID0+IHtcbiAgY29uc3QgY2xpZW50ID0gbmV3IE1vY2tScGNDbGllbnQoKVxuXG4gIGNvbnN0IGRhdGEgPSAne1widHlwZVwiOlwiZXh0ZW5zaW9uX3VpX3Jlc3BvbnNlXCIsXCJpZFwiOlwiaW5qMlwiLFwiY2FuY2VsbGVkXCI6dHJ1ZX1cXG4nXG4gIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UoZGF0YS50cmltKCkpXG4gIGlmIChwYXJzZWQudHlwZSA9PT0gJ2V4dGVuc2lvbl91aV9yZXNwb25zZScgJiYgcGFyc2VkLmlkKSB7XG4gICAgY29uc3QgeyBpZCwgdmFsdWUsIHZhbHVlcywgY29uZmlybWVkLCBjYW5jZWxsZWQgfSA9IHBhcnNlZFxuICAgIGNsaWVudC5zZW5kVUlSZXNwb25zZShpZCwgeyB2YWx1ZSwgdmFsdWVzLCBjb25maXJtZWQsIGNhbmNlbGxlZCB9KVxuICB9XG5cbiAgYXNzZXJ0LmVxdWFsKGNsaWVudC5zZW5kVUlDYWxscy5sZW5ndGgsIDEpXG4gIGFzc2VydC5lcXVhbChjbGllbnQuc2VuZFVJQ2FsbHNbMF0uaWQsICdpbmoyJylcbiAgYXNzZXJ0LmVxdWFsKGNsaWVudC5zZW5kVUlDYWxsc1swXS5yZXNwb25zZS5jYW5jZWxsZWQsIHRydWUpXG59KVxuXG50ZXN0KCdpbmplY3RvciBhZGFwdGVyIGhhbmRsZXMgbXVsdGktc2VsZWN0IHZhbHVlcycsICgpID0+IHtcbiAgY29uc3QgY2xpZW50ID0gbmV3IE1vY2tScGNDbGllbnQoKVxuXG4gIGNvbnN0IGRhdGEgPSAne1widHlwZVwiOlwiZXh0ZW5zaW9uX3VpX3Jlc3BvbnNlXCIsXCJpZFwiOlwiaW5qM1wiLFwidmFsdWVzXCI6W1wiYVwiLFwiYlwiXX1cXG4nXG4gIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UoZGF0YS50cmltKCkpXG4gIGlmIChwYXJzZWQudHlwZSA9PT0gJ2V4dGVuc2lvbl91aV9yZXNwb25zZScgJiYgcGFyc2VkLmlkKSB7XG4gICAgY29uc3QgeyBpZCwgdmFsdWUsIHZhbHVlcywgY29uZmlybWVkLCBjYW5jZWxsZWQgfSA9IHBhcnNlZFxuICAgIGNsaWVudC5zZW5kVUlSZXNwb25zZShpZCwgeyB2YWx1ZSwgdmFsdWVzLCBjb25maXJtZWQsIGNhbmNlbGxlZCB9KVxuICB9XG5cbiAgYXNzZXJ0LmVxdWFsKGNsaWVudC5zZW5kVUlDYWxscy5sZW5ndGgsIDEpXG4gIGFzc2VydC5lcXVhbChjbGllbnQuc2VuZFVJQ2FsbHNbMF0uaWQsICdpbmozJylcbiAgYXNzZXJ0LmRlZXBFcXVhbChjbGllbnQuc2VuZFVJQ2FsbHNbMF0ucmVzcG9uc2UudmFsdWVzLCBbJ2EnLCAnYiddKVxufSlcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIG11bHRpLXR1cm4gY29tbWFuZCAoYXV0by9uZXh0KSBza2lwcyBleGVjdXRpb25fY29tcGxldGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ2V4ZWN1dGlvbl9jb21wbGV0ZSBpcyBpZ25vcmVkIGZvciBtdWx0aS10dXJuIGNvbW1hbmRzIChhdXRvKScsICgpID0+IHtcbiAgY29uc3QgY2xpZW50ID0gbmV3IE1vY2tScGNDbGllbnQoKVxuICBjb25zdCBzdGF0ZTogRXZlbnRIYW5kbGVyU3RhdGUgPSB7IGNvbXBsZXRlZDogZmFsc2UsIGJsb2NrZWQ6IGZhbHNlLCBleGl0Q29kZTogLTEsIHYyRW5hYmxlZDogdHJ1ZSwgaXNNdWx0aVR1cm5Db21tYW5kOiB0cnVlIH1cblxuICBoYW5kbGVFdmVudCh7IHR5cGU6ICdleGVjdXRpb25fY29tcGxldGUnLCBzdGF0dXM6ICdzdWNjZXNzJyB9LCBzdGF0ZSwgY2xpZW50KVxuXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5jb21wbGV0ZWQsIGZhbHNlLCAnc2hvdWxkIG5vdCBtYXJrIGNvbXBsZXRlZCBmb3IgYXV0by9uZXh0IGNvbW1hbmRzJylcbiAgYXNzZXJ0LmVxdWFsKHN0YXRlLmV4aXRDb2RlLCAtMSwgJ2V4aXQgY29kZSBzaG91bGQgcmVtYWluIHVuY2hhbmdlZCcpXG59KVxuXG50ZXN0KCdleGVjdXRpb25fY29tcGxldGUgaXMgaWdub3JlZCBmb3IgbXVsdGktdHVybiBjb21tYW5kcyBldmVuIHdpdGggZXJyb3Igc3RhdHVzJywgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgTW9ja1JwY0NsaWVudCgpXG4gIGNvbnN0IHN0YXRlOiBFdmVudEhhbmRsZXJTdGF0ZSA9IHsgY29tcGxldGVkOiBmYWxzZSwgYmxvY2tlZDogZmFsc2UsIGV4aXRDb2RlOiAtMSwgdjJFbmFibGVkOiB0cnVlLCBpc011bHRpVHVybkNvbW1hbmQ6IHRydWUgfVxuXG4gIGhhbmRsZUV2ZW50KHsgdHlwZTogJ2V4ZWN1dGlvbl9jb21wbGV0ZScsIHN0YXR1czogJ2Vycm9yJyB9LCBzdGF0ZSwgY2xpZW50KVxuXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5jb21wbGV0ZWQsIGZhbHNlLCAnc2hvdWxkIG5vdCBtYXJrIGNvbXBsZXRlZCBmb3IgYXV0by9uZXh0IGNvbW1hbmRzJylcbiAgYXNzZXJ0LmVxdWFsKHN0YXRlLmV4aXRDb2RlLCAtMSwgJ2V4aXQgY29kZSBzaG91bGQgcmVtYWluIHVuY2hhbmdlZCcpXG59KVxuXG50ZXN0KCdtdWx0aS10dXJuIGNvbW1hbmRzIHN0aWxsIGNvbXBsZXRlIHZpYSB0ZXJtaW5hbCBub3RpZmljYXRpb24nLCAoKSA9PiB7XG4gIGNvbnN0IGNsaWVudCA9IG5ldyBNb2NrUnBjQ2xpZW50KClcbiAgY29uc3Qgc3RhdGU6IEV2ZW50SGFuZGxlclN0YXRlID0geyBjb21wbGV0ZWQ6IGZhbHNlLCBibG9ja2VkOiBmYWxzZSwgZXhpdENvZGU6IC0xLCB2MkVuYWJsZWQ6IHRydWUsIGlzTXVsdGlUdXJuQ29tbWFuZDogdHJ1ZSB9XG5cbiAgLy8gRmlyc3QsIGV4ZWN1dGlvbl9jb21wbGV0ZSBmaXJlcyAoc2hvdWxkIGJlIGlnbm9yZWQpXG4gIGhhbmRsZUV2ZW50KHsgdHlwZTogJ2V4ZWN1dGlvbl9jb21wbGV0ZScsIHN0YXR1czogJ3N1Y2Nlc3MnIH0sIHN0YXRlLCBjbGllbnQpXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5jb21wbGV0ZWQsIGZhbHNlLCAnZXhlY3V0aW9uX2NvbXBsZXRlIHNob3VsZCBiZSBza2lwcGVkJylcblxuICAvLyBUaGVuIHRoZSByZWFsIHRlcm1pbmFsIG5vdGlmaWNhdGlvbiBmaXJlc1xuICBoYW5kbGVFdmVudChcbiAgICB7IHR5cGU6ICdleHRlbnNpb25fdWlfcmVxdWVzdCcsIG1ldGhvZDogJ25vdGlmeScsIGlkOiAnbjEnLCBtZXNzYWdlOiAnQXV0by1tb2RlIHN0b3BwZWQgXHUyMDE0IGFsbCBzbGljZXMgY29tcGxldGUnIH0sXG4gICAgc3RhdGUsXG4gICAgY2xpZW50LFxuICApXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5jb21wbGV0ZWQsIHRydWUsICd0ZXJtaW5hbCBub3RpZmljYXRpb24gc2hvdWxkIHRyaWdnZXIgY29tcGxldGlvbicpXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5leGl0Q29kZSwgRVhJVF9TVUNDRVNTKVxufSlcblxudGVzdCgnbXVsdGktdHVybiBjb21tYW5kcyBkZXRlY3QgYmxvY2tlZCB2aWEgdGVybWluYWwgbm90aWZpY2F0aW9uJywgKCkgPT4ge1xuICBjb25zdCBjbGllbnQgPSBuZXcgTW9ja1JwY0NsaWVudCgpXG4gIGNvbnN0IHN0YXRlOiBFdmVudEhhbmRsZXJTdGF0ZSA9IHsgY29tcGxldGVkOiBmYWxzZSwgYmxvY2tlZDogZmFsc2UsIGV4aXRDb2RlOiAtMSwgdjJFbmFibGVkOiB0cnVlLCBpc011bHRpVHVybkNvbW1hbmQ6IHRydWUgfVxuXG4gIC8vIGV4ZWN1dGlvbl9jb21wbGV0ZSBpcyBpZ25vcmVkXG4gIGhhbmRsZUV2ZW50KHsgdHlwZTogJ2V4ZWN1dGlvbl9jb21wbGV0ZScsIHN0YXR1czogJ3N1Y2Nlc3MnIH0sIHN0YXRlLCBjbGllbnQpXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5jb21wbGV0ZWQsIGZhbHNlKVxuXG4gIC8vIEJsb2NrZWQgdGVybWluYWwgbm90aWZpY2F0aW9uXG4gIGhhbmRsZUV2ZW50KFxuICAgIHsgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXF1ZXN0JywgbWV0aG9kOiAnbm90aWZ5JywgaWQ6ICduMicsIG1lc3NhZ2U6ICdBdXRvLW1vZGUgc3RvcHBlZCAoQmxvY2tlZDogcGxhbiByZWplY3RlZCknIH0sXG4gICAgc3RhdGUsXG4gICAgY2xpZW50LFxuICApXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5jb21wbGV0ZWQsIHRydWUpXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5ibG9ja2VkLCB0cnVlKVxuICBhc3NlcnQuZXF1YWwoc3RhdGUuZXhpdENvZGUsIEVYSVRfQkxPQ0tFRClcbn0pXG5cbnRlc3QoJ25vbi1tdWx0aS10dXJuIGNvbW1hbmRzIHN0aWxsIGNvbXBsZXRlIG9uIGV4ZWN1dGlvbl9jb21wbGV0ZScsICgpID0+IHtcbiAgY29uc3QgY2xpZW50ID0gbmV3IE1vY2tScGNDbGllbnQoKVxuICBjb25zdCBzdGF0ZTogRXZlbnRIYW5kbGVyU3RhdGUgPSB7IGNvbXBsZXRlZDogZmFsc2UsIGJsb2NrZWQ6IGZhbHNlLCBleGl0Q29kZTogLTEsIHYyRW5hYmxlZDogdHJ1ZSwgaXNNdWx0aVR1cm5Db21tYW5kOiBmYWxzZSB9XG5cbiAgaGFuZGxlRXZlbnQoeyB0eXBlOiAnZXhlY3V0aW9uX2NvbXBsZXRlJywgc3RhdHVzOiAnc3VjY2VzcycgfSwgc3RhdGUsIGNsaWVudClcblxuICBhc3NlcnQuZXF1YWwoc3RhdGUuY29tcGxldGVkLCB0cnVlLCAnc2luZ2xlLXR1cm4gY29tbWFuZHMgc2hvdWxkIGNvbXBsZXRlIG9uIGV4ZWN1dGlvbl9jb21wbGV0ZScpXG4gIGFzc2VydC5lcXVhbChzdGF0ZS5leGl0Q29kZSwgRVhJVF9TVUNDRVNTKVxufSlcbiJdLAogICJtYXBwaW5ncyI6ICJBQVFBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFJbkIsTUFBTSxlQUFlO0FBQ3JCLE1BQU0sYUFBYTtBQUNuQixNQUFNLGVBQWU7QUFFckIsU0FBUyxvQkFBb0IsUUFBd0I7QUFDbkQsVUFBUSxRQUFRO0FBQUEsSUFDZCxLQUFLO0FBQUEsSUFDTCxLQUFLO0FBQ0gsYUFBTztBQUFBLElBQ1QsS0FBSztBQUFBLElBQ0wsS0FBSztBQUNILGFBQU87QUFBQSxJQUNULEtBQUs7QUFDSCxhQUFPO0FBQUEsSUFDVCxLQUFLO0FBQ0gsYUFBTztBQUFBLElBQ1Q7QUFDRSxhQUFPO0FBQUEsRUFDWDtBQUNGO0FBSUEsTUFBTSxvQkFBb0IsQ0FBQyxxQkFB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
