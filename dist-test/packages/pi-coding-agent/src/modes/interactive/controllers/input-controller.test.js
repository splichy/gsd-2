import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import test from "node:test";
import { setupEditorSubmitHandler } from "./input-controller.js";
import { ContextualTips } from "../../../core/contextual-tips.js";
function createMockHost() {
  const promptCalls = [];
  const historyCalls = [];
  let editorText = "";
  const host = {
    defaultEditor: {
      onSubmit: void 0,
      addToHistory: (text) => {
        historyCalls.push(text);
      },
      setText: (text) => {
        editorText = text;
      },
      getText: () => editorText
    },
    editor: {
      setText: (text) => {
        editorText = text;
      },
      getText: () => editorText,
      addToHistory: (text) => {
        historyCalls.push(text);
      }
    },
    session: {
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      thinkingLevel: void 0,
      prompt: async (text, options) => {
        promptCalls.push({ text, options });
      }
    },
    ui: { requestRender: () => {
    } },
    footer: {},
    keybindings: {},
    statusContainer: {},
    chatContainer: {},
    pinnedMessageContainer: {},
    settingsManager: {},
    pendingTools: /* @__PURE__ */ new Map(),
    toolOutputExpanded: false,
    hideThinkingBlock: false,
    isBashMode: false,
    onInputCallback: void 0,
    isInitialized: true,
    loadingAnimation: void 0,
    pendingWorkingMessage: void 0,
    clearBlockingError: () => {
    },
    defaultWorkingMessage: "Working...",
    streamingComponent: void 0,
    streamingMessage: void 0,
    retryEscapeHandler: void 0,
    retryLoader: void 0,
    autoCompactionLoader: void 0,
    autoCompactionEscapeHandler: void 0,
    compactionQueuedMessages: [],
    extensionSelector: void 0,
    extensionInput: void 0,
    extensionEditor: void 0,
    editorContainer: {},
    keybindingsManager: void 0,
    pendingImages: [],
    // Extra methods required by setupEditorSubmitHandler
    getSlashCommandContext: () => ({}),
    handleBashCommand: async (_command, _excludeFromContext) => {
    },
    showWarning: (_message) => {
    },
    showError: (_message) => {
    },
    showTip: (_message) => {
    },
    updateEditorBorderColor: () => {
    },
    isExtensionCommand: (_text) => false,
    isKnownSlashCommand: (_text) => false,
    queueCompactionMessage: (_text, _mode) => {
    },
    updatePendingMessagesDisplay: () => {
    },
    flushPendingBashComponents: () => {
    },
    contextualTips: new ContextualTips(),
    getContextPercent: () => void 0,
    options: { submitPromptsDirectly: true }
  };
  return { host, promptCalls, historyCalls };
}
const TEST_IMAGE = {
  type: "image",
  data: "iVBORw0KGgo=",
  mimeType: "image/png"
};
describe("input-controller pending images", () => {
  let host;
  let promptCalls;
  beforeEach(() => {
    const mock = createMockHost();
    host = mock.host;
    promptCalls = mock.promptCalls;
    setupEditorSubmitHandler(host);
  });
  it("passes pending images to session.prompt on submit", async () => {
    host.pendingImages.push({ ...TEST_IMAGE });
    await host.defaultEditor.onSubmit("describe this image");
    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0].text, "describe this image");
    assert.ok(promptCalls[0].options?.images);
    assert.equal(promptCalls[0].options.images.length, 1);
    assert.equal(promptCalls[0].options.images[0].mimeType, "image/png");
  });
  it("clears pending images after submit", async () => {
    host.pendingImages.push({ ...TEST_IMAGE });
    await host.defaultEditor.onSubmit("describe this image");
    assert.equal(host.pendingImages.length, 0);
  });
  it("passes undefined images when no images are pending", async () => {
    await host.defaultEditor.onSubmit("hello");
    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0].options?.images, void 0);
  });
  it("passes multiple images in order", async () => {
    const img1 = { type: "image", data: "aaa=", mimeType: "image/png" };
    const img2 = { type: "image", data: "bbb=", mimeType: "image/jpeg" };
    host.pendingImages.push(img1, img2);
    await host.defaultEditor.onSubmit("describe these images");
    assert.equal(promptCalls[0].options.images.length, 2);
    assert.equal(promptCalls[0].options.images[0].data, "aaa=");
    assert.equal(promptCalls[0].options.images[1].data, "bbb=");
  });
  it("discards pending images on bash command", async () => {
    host.pendingImages.push({ ...TEST_IMAGE });
    await host.defaultEditor.onSubmit("! ls -la");
    assert.equal(host.pendingImages.length, 0);
    assert.equal(promptCalls.length, 0);
  });
});
function getSlashCommandName(text) {
  const trimmed = text.trim();
  const spaceIndex = trimmed.indexOf(" ");
  return spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
}
function createHost(options = {}) {
  const prompted = [];
  const promptOptions = [];
  const errors = [];
  const warnings = [];
  const tips = [];
  const history = [];
  const knownSlashCommands = new Set(options.knownSlashCommands ?? []);
  let editorText = "";
  let settingsOpened = 0;
  const editor = {
    setText(text) {
      editorText = text;
    },
    getText() {
      return editorText;
    },
    addToHistory(text) {
      history.push(text);
    }
  };
  const host = {
    defaultEditor: editor,
    editor,
    session: {
      isBashRunning: false,
      isCompacting: false,
      isStreaming: false,
      prompt: async (text, options2) => {
        prompted.push(text);
        promptOptions.push(options2);
      }
    },
    ui: {
      requestRender() {
      }
    },
    pendingImages: [],
    getSlashCommandContext: () => ({
      showSettingsSelector: () => {
        settingsOpened += 1;
      }
    }),
    handleBashCommand: async () => {
    },
    showWarning(message) {
      warnings.push(message);
    },
    showError(message) {
      errors.push(message);
    },
    showTip(message) {
      tips.push(message);
    },
    updateEditorBorderColor() {
    },
    isExtensionCommand() {
      return false;
    },
    isKnownSlashCommand(text) {
      return knownSlashCommands.has(getSlashCommandName(text));
    },
    queueCompactionMessage() {
    },
    updatePendingMessagesDisplay() {
    },
    flushPendingBashComponents() {
    },
    contextualTips: {
      recordBashIncluded() {
      },
      evaluate() {
        return void 0;
      }
    },
    getContextPercent() {
      return void 0;
    }
  };
  setupEditorSubmitHandler(host);
  return {
    host,
    prompted,
    promptOptions,
    errors,
    warnings,
    tips,
    history,
    getEditorText: () => editorText,
    getSettingsOpened: () => settingsOpened
  };
}
test("input-controller: regular prompt submit preserves pending images", async () => {
  const { host, prompted, promptOptions } = createHost();
  host.pendingImages.push({ ...TEST_IMAGE });
  await host.defaultEditor.onSubmit("describe this image [Image #1]");
  assert.deepEqual(prompted, ["describe this image [Image #1]"]);
  assert.equal(promptOptions[0]?.images?.length, 1);
  assert.equal(promptOptions[0].images[0].mimeType, "image/png");
  assert.equal(promptOptions[0].images[0].data, TEST_IMAGE.data);
  assert.equal(host.pendingImages.length, 0);
});
test("input-controller: built-in slash commands stay in TUI dispatch", async () => {
  const { host, prompted, errors, getSettingsOpened, getEditorText } = createHost();
  await host.defaultEditor.onSubmit("/settings");
  assert.equal(getSettingsOpened(), 1, "built-in /settings should open the settings selector");
  assert.deepEqual(prompted, [], "built-in slash commands should not reach session.prompt");
  assert.deepEqual(errors, [], "built-in slash commands should not show errors");
  assert.equal(getEditorText(), "", "built-in slash commands should clear the editor after handling");
});
test("input-controller: extension slash commands fall through to session.prompt", async () => {
  const { host, prompted, errors, history } = createHost({ knownSlashCommands: ["gsd"] });
  await host.defaultEditor.onSubmit("/gsd help");
  assert.deepEqual(prompted, ["/gsd help"], "known extension slash commands should reach session.prompt");
  assert.deepEqual(errors, [], "known extension slash commands should not show unknown-command errors");
  assert.deepEqual(history, ["/gsd help"], "known extension slash commands should still be added to history");
});
test("input-controller: prompt template slash commands fall through to session.prompt", async () => {
  const { host, prompted, errors } = createHost({ knownSlashCommands: ["daily"] });
  await host.defaultEditor.onSubmit("/daily focus area");
  assert.deepEqual(prompted, ["/daily focus area"]);
  assert.deepEqual(errors, []);
});
test("input-controller: skill slash commands fall through to session.prompt", async () => {
  const { host, prompted, errors } = createHost({ knownSlashCommands: ["skill:create-skill"] });
  await host.defaultEditor.onSubmit("/skill:create-skill routing bug");
  assert.deepEqual(prompted, ["/skill:create-skill routing bug"]);
  assert.deepEqual(errors, []);
});
test("input-controller: disabled skill slash commands stay unknown", async () => {
  const { host, prompted, errors } = createHost();
  await host.defaultEditor.onSubmit("/skill:create-skill routing bug");
  assert.deepEqual(prompted, []);
  assert.deepEqual(errors, ["Unknown command: /skill:create-skill. Use slash autocomplete to see available commands."]);
});
test("input-controller: /export prefix does not swallow unrelated slash commands", async () => {
  const { host, prompted, errors } = createHost();
  await host.defaultEditor.onSubmit("/exportfoo");
  assert.deepEqual(prompted, []);
  assert.deepEqual(errors, ["Unknown command: /exportfoo. Use slash autocomplete to see available commands."]);
});
test("input-controller: truly unknown slash commands stop before session.prompt", async () => {
  const { host, prompted, errors, getEditorText } = createHost();
  await host.defaultEditor.onSubmit("/definitely-not-a-command");
  assert.deepEqual(prompted, [], "unknown slash commands should not reach session.prompt");
  assert.deepEqual(
    errors,
    ["Unknown command: /definitely-not-a-command. Use slash autocomplete to see available commands."]
  );
  assert.equal(getEditorText(), "", "unknown slash commands should clear the editor after showing the error");
});
test("input-controller: absolute file paths are not treated as slash commands (#3478)", async () => {
  const { host, prompted, errors } = createHost();
  await host.defaultEditor.onSubmit("/Users/name/Desktop/screenshot.png");
  assert.deepEqual(errors, [], "file paths should not trigger unknown command error");
  assert.deepEqual(prompted, ["/Users/name/Desktop/screenshot.png"], "file paths should be sent as plain input");
});
test("input-controller: Linux absolute paths are not treated as slash commands (#3478)", async () => {
  const { host, prompted, errors } = createHost();
  await host.defaultEditor.onSubmit("/home/user/documents/file.txt");
  assert.deepEqual(errors, [], "Linux paths should not trigger unknown command error");
  assert.deepEqual(prompted, ["/home/user/documents/file.txt"], "Linux paths should be sent as plain input");
});
test("input-controller: /tmp paths are not treated as slash commands (#3478)", async () => {
  const { host, prompted, errors } = createHost();
  await host.defaultEditor.onSubmit("/tmp/some-file.log");
  assert.deepEqual(errors, []);
  assert.deepEqual(prompted, ["/tmp/some-file.log"]);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb250cm9sbGVycy9pbnB1dC1jb250cm9sbGVyLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRDIgXHUyMDE0IFRlc3RzIGZvciBpbnB1dC1jb250cm9sbGVyIGltYWdlIHBhc3RpbmcgYmVoYXZpb3Jcbi8vIENvcHlyaWdodCAoYykgMjAyNiBKZXJlbXkgTWNTcGFkZGVuIDxqZXJlbXlAZmx1eGxhYnMubmV0PlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgaXQsIGJlZm9yZUVhY2ggfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCB7IHNldHVwRWRpdG9yU3VibWl0SGFuZGxlciB9IGZyb20gXCIuL2lucHV0LWNvbnRyb2xsZXIuanNcIjtcbmltcG9ydCB7IENvbnRleHR1YWxUaXBzIH0gZnJvbSBcIi4uLy4uLy4uL2NvcmUvY29udGV4dHVhbC10aXBzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEludGVyYWN0aXZlTW9kZVN0YXRlSG9zdCB9IGZyb20gXCIuLi9pbnRlcmFjdGl2ZS1tb2RlLXN0YXRlLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEltYWdlQ29udGVudCB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5cbi8qKiBNaW5pbWFsIG1vY2sgaG9zdCBzYXRpc2Z5aW5nIEludGVyYWN0aXZlTW9kZVN0YXRlSG9zdCArIHNldHVwRWRpdG9yU3VibWl0SGFuZGxlciBleHRyYXMuICovXG5mdW5jdGlvbiBjcmVhdGVNb2NrSG9zdCgpIHtcblx0Y29uc3QgcHJvbXB0Q2FsbHM6IEFycmF5PHsgdGV4dDogc3RyaW5nOyBvcHRpb25zPzogYW55IH0+ID0gW107XG5cdGNvbnN0IGhpc3RvcnlDYWxsczogc3RyaW5nW10gPSBbXTtcblx0bGV0IGVkaXRvclRleHQgPSBcIlwiO1xuXG5cdGNvbnN0IGhvc3QgPSB7XG5cdFx0ZGVmYXVsdEVkaXRvcjoge1xuXHRcdFx0b25TdWJtaXQ6IHVuZGVmaW5lZCBhcyAoKHRleHQ6IHN0cmluZykgPT4gUHJvbWlzZTx2b2lkPikgfCB1bmRlZmluZWQsXG5cdFx0XHRhZGRUb0hpc3Rvcnk6ICh0ZXh0OiBzdHJpbmcpID0+IHsgaGlzdG9yeUNhbGxzLnB1c2godGV4dCk7IH0sXG5cdFx0XHRzZXRUZXh0OiAodGV4dDogc3RyaW5nKSA9PiB7IGVkaXRvclRleHQgPSB0ZXh0OyB9LFxuXHRcdFx0Z2V0VGV4dDogKCkgPT4gZWRpdG9yVGV4dCxcblx0XHR9LFxuXHRcdGVkaXRvcjoge1xuXHRcdFx0c2V0VGV4dDogKHRleHQ6IHN0cmluZykgPT4geyBlZGl0b3JUZXh0ID0gdGV4dDsgfSxcblx0XHRcdGdldFRleHQ6ICgpID0+IGVkaXRvclRleHQsXG5cdFx0XHRhZGRUb0hpc3Rvcnk6ICh0ZXh0OiBzdHJpbmcpID0+IHsgaGlzdG9yeUNhbGxzLnB1c2godGV4dCk7IH0sXG5cdFx0fSxcblx0XHRzZXNzaW9uOiB7XG5cdFx0XHRpc1N0cmVhbWluZzogZmFsc2UsXG5cdFx0XHRpc0NvbXBhY3Rpbmc6IGZhbHNlLFxuXHRcdFx0aXNCYXNoUnVubmluZzogZmFsc2UsXG5cdFx0XHR0aGlua2luZ0xldmVsOiB1bmRlZmluZWQsXG5cdFx0XHRwcm9tcHQ6IGFzeW5jICh0ZXh0OiBzdHJpbmcsIG9wdGlvbnM/OiBhbnkpID0+IHsgcHJvbXB0Q2FsbHMucHVzaCh7IHRleHQsIG9wdGlvbnMgfSk7IH0sXG5cdFx0fSxcblx0XHR1aTogeyByZXF1ZXN0UmVuZGVyOiAoKSA9PiB7fSB9LFxuXHRcdGZvb3Rlcjoge30sXG5cdFx0a2V5YmluZGluZ3M6IHt9LFxuXHRcdHN0YXR1c0NvbnRhaW5lcjoge30sXG5cdFx0Y2hhdENvbnRhaW5lcjoge30sXG5cdFx0cGlubmVkTWVzc2FnZUNvbnRhaW5lcjoge30sXG5cdFx0c2V0dGluZ3NNYW5hZ2VyOiB7fSxcblx0XHRwZW5kaW5nVG9vbHM6IG5ldyBNYXAoKSxcblx0XHR0b29sT3V0cHV0RXhwYW5kZWQ6IGZhbHNlLFxuXHRcdGhpZGVUaGlua2luZ0Jsb2NrOiBmYWxzZSxcblx0XHRpc0Jhc2hNb2RlOiBmYWxzZSxcblx0XHRvbklucHV0Q2FsbGJhY2s6IHVuZGVmaW5lZCxcblx0XHRpc0luaXRpYWxpemVkOiB0cnVlLFxuXHRcdGxvYWRpbmdBbmltYXRpb246IHVuZGVmaW5lZCxcblx0XHRwZW5kaW5nV29ya2luZ01lc3NhZ2U6IHVuZGVmaW5lZCxcblx0XHRjbGVhckJsb2NraW5nRXJyb3I6ICgpID0+IHt9LFxuXHRcdGRlZmF1bHRXb3JraW5nTWVzc2FnZTogXCJXb3JraW5nLi4uXCIsXG5cdFx0c3RyZWFtaW5nQ29tcG9uZW50OiB1bmRlZmluZWQsXG5cdFx0c3RyZWFtaW5nTWVzc2FnZTogdW5kZWZpbmVkLFxuXHRcdHJldHJ5RXNjYXBlSGFuZGxlcjogdW5kZWZpbmVkLFxuXHRcdHJldHJ5TG9hZGVyOiB1bmRlZmluZWQsXG5cdFx0YXV0b0NvbXBhY3Rpb25Mb2FkZXI6IHVuZGVmaW5lZCxcblx0XHRhdXRvQ29tcGFjdGlvbkVzY2FwZUhhbmRsZXI6IHVuZGVmaW5lZCxcblx0XHRjb21wYWN0aW9uUXVldWVkTWVzc2FnZXM6IFtdIGFzIEFycmF5PHsgdGV4dDogc3RyaW5nOyBtb2RlOiBcInN0ZWVyXCIgfCBcImZvbGxvd1VwXCIgfT4sXG5cdFx0ZXh0ZW5zaW9uU2VsZWN0b3I6IHVuZGVmaW5lZCxcblx0XHRleHRlbnNpb25JbnB1dDogdW5kZWZpbmVkLFxuXHRcdGV4dGVuc2lvbkVkaXRvcjogdW5kZWZpbmVkLFxuXHRcdGVkaXRvckNvbnRhaW5lcjoge30sXG5cdFx0a2V5YmluZGluZ3NNYW5hZ2VyOiB1bmRlZmluZWQsXG5cdFx0cGVuZGluZ0ltYWdlczogW10gYXMgSW1hZ2VDb250ZW50W10sXG5cblx0XHQvLyBFeHRyYSBtZXRob2RzIHJlcXVpcmVkIGJ5IHNldHVwRWRpdG9yU3VibWl0SGFuZGxlclxuXHRcdGdldFNsYXNoQ29tbWFuZENvbnRleHQ6ICgpID0+ICh7fSksXG5cdFx0aGFuZGxlQmFzaENvbW1hbmQ6IGFzeW5jIChfY29tbWFuZDogc3RyaW5nLCBfZXhjbHVkZUZyb21Db250ZXh0PzogYm9vbGVhbikgPT4ge30sXG5cdFx0c2hvd1dhcm5pbmc6IChfbWVzc2FnZTogc3RyaW5nKSA9PiB7fSxcblx0XHRzaG93RXJyb3I6IChfbWVzc2FnZTogc3RyaW5nKSA9PiB7fSxcblx0XHRzaG93VGlwOiAoX21lc3NhZ2U6IHN0cmluZykgPT4ge30sXG5cdFx0dXBkYXRlRWRpdG9yQm9yZGVyQ29sb3I6ICgpID0+IHt9LFxuXHRcdGlzRXh0ZW5zaW9uQ29tbWFuZDogKF90ZXh0OiBzdHJpbmcpID0+IGZhbHNlLFxuXHRcdGlzS25vd25TbGFzaENvbW1hbmQ6IChfdGV4dDogc3RyaW5nKSA9PiBmYWxzZSxcblx0XHRxdWV1ZUNvbXBhY3Rpb25NZXNzYWdlOiAoX3RleHQ6IHN0cmluZywgX21vZGU6IFwic3RlZXJcIiB8IFwiZm9sbG93VXBcIikgPT4ge30sXG5cdFx0dXBkYXRlUGVuZGluZ01lc3NhZ2VzRGlzcGxheTogKCkgPT4ge30sXG5cdFx0Zmx1c2hQZW5kaW5nQmFzaENvbXBvbmVudHM6ICgpID0+IHt9LFxuXHRcdGNvbnRleHR1YWxUaXBzOiBuZXcgQ29udGV4dHVhbFRpcHMoKSxcblx0XHRnZXRDb250ZXh0UGVyY2VudDogKCkgPT4gdW5kZWZpbmVkLFxuXHRcdG9wdGlvbnM6IHsgc3VibWl0UHJvbXB0c0RpcmVjdGx5OiB0cnVlIH0sXG5cdH0gc2F0aXNmaWVzIEludGVyYWN0aXZlTW9kZVN0YXRlSG9zdCAmIFBhcmFtZXRlcnM8dHlwZW9mIHNldHVwRWRpdG9yU3VibWl0SGFuZGxlcj5bMF07XG5cblx0cmV0dXJuIHsgaG9zdCwgcHJvbXB0Q2FsbHMsIGhpc3RvcnlDYWxscyB9O1xufVxuXG5jb25zdCBURVNUX0lNQUdFOiBJbWFnZUNvbnRlbnQgPSB7XG5cdHR5cGU6IFwiaW1hZ2VcIixcblx0ZGF0YTogXCJpVkJPUncwS0dnbz1cIixcblx0bWltZVR5cGU6IFwiaW1hZ2UvcG5nXCIsXG59O1xuXG5kZXNjcmliZShcImlucHV0LWNvbnRyb2xsZXIgcGVuZGluZyBpbWFnZXNcIiwgKCkgPT4ge1xuXHRsZXQgaG9zdDogUmV0dXJuVHlwZTx0eXBlb2YgY3JlYXRlTW9ja0hvc3Q+W1wiaG9zdFwiXTtcblx0bGV0IHByb21wdENhbGxzOiBSZXR1cm5UeXBlPHR5cGVvZiBjcmVhdGVNb2NrSG9zdD5bXCJwcm9tcHRDYWxsc1wiXTtcblxuXHRiZWZvcmVFYWNoKCgpID0+IHtcblx0XHRjb25zdCBtb2NrID0gY3JlYXRlTW9ja0hvc3QoKTtcblx0XHRob3N0ID0gbW9jay5ob3N0O1xuXHRcdHByb21wdENhbGxzID0gbW9jay5wcm9tcHRDYWxscztcblx0XHRzZXR1cEVkaXRvclN1Ym1pdEhhbmRsZXIoaG9zdCk7XG5cdH0pO1xuXG5cdGl0KFwicGFzc2VzIHBlbmRpbmcgaW1hZ2VzIHRvIHNlc3Npb24ucHJvbXB0IG9uIHN1Ym1pdFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0aG9zdC5wZW5kaW5nSW1hZ2VzLnB1c2goeyAuLi5URVNUX0lNQUdFIH0pO1xuXHRcdGF3YWl0IGhvc3QuZGVmYXVsdEVkaXRvci5vblN1Ym1pdCEoXCJkZXNjcmliZSB0aGlzIGltYWdlXCIpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKHByb21wdENhbGxzLmxlbmd0aCwgMSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHByb21wdENhbGxzWzBdLnRleHQsIFwiZGVzY3JpYmUgdGhpcyBpbWFnZVwiKTtcblx0XHRhc3NlcnQub2socHJvbXB0Q2FsbHNbMF0ub3B0aW9ucz8uaW1hZ2VzKTtcblx0XHRhc3NlcnQuZXF1YWwocHJvbXB0Q2FsbHNbMF0ub3B0aW9ucy5pbWFnZXMubGVuZ3RoLCAxKTtcblx0XHRhc3NlcnQuZXF1YWwocHJvbXB0Q2FsbHNbMF0ub3B0aW9ucy5pbWFnZXNbMF0ubWltZVR5cGUsIFwiaW1hZ2UvcG5nXCIpO1xuXHR9KTtcblxuXHRpdChcImNsZWFycyBwZW5kaW5nIGltYWdlcyBhZnRlciBzdWJtaXRcIiwgYXN5bmMgKCkgPT4ge1xuXHRcdGhvc3QucGVuZGluZ0ltYWdlcy5wdXNoKHsgLi4uVEVTVF9JTUFHRSB9KTtcblx0XHRhd2FpdCBob3N0LmRlZmF1bHRFZGl0b3Iub25TdWJtaXQhKFwiZGVzY3JpYmUgdGhpcyBpbWFnZVwiKTtcblxuXHRcdGFzc2VydC5lcXVhbChob3N0LnBlbmRpbmdJbWFnZXMubGVuZ3RoLCAwKTtcblx0fSk7XG5cblx0aXQoXCJwYXNzZXMgdW5kZWZpbmVkIGltYWdlcyB3aGVuIG5vIGltYWdlcyBhcmUgcGVuZGluZ1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0YXdhaXQgaG9zdC5kZWZhdWx0RWRpdG9yLm9uU3VibWl0IShcImhlbGxvXCIpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKHByb21wdENhbGxzLmxlbmd0aCwgMSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHByb21wdENhbGxzWzBdLm9wdGlvbnM/LmltYWdlcywgdW5kZWZpbmVkKTtcblx0fSk7XG5cblx0aXQoXCJwYXNzZXMgbXVsdGlwbGUgaW1hZ2VzIGluIG9yZGVyXCIsIGFzeW5jICgpID0+IHtcblx0XHRjb25zdCBpbWcxOiBJbWFnZUNvbnRlbnQgPSB7IHR5cGU6IFwiaW1hZ2VcIiwgZGF0YTogXCJhYWE9XCIsIG1pbWVUeXBlOiBcImltYWdlL3BuZ1wiIH07XG5cdFx0Y29uc3QgaW1nMjogSW1hZ2VDb250ZW50ID0geyB0eXBlOiBcImltYWdlXCIsIGRhdGE6IFwiYmJiPVwiLCBtaW1lVHlwZTogXCJpbWFnZS9qcGVnXCIgfTtcblx0XHRob3N0LnBlbmRpbmdJbWFnZXMucHVzaChpbWcxLCBpbWcyKTtcblxuXHRcdGF3YWl0IGhvc3QuZGVmYXVsdEVkaXRvci5vblN1Ym1pdCEoXCJkZXNjcmliZSB0aGVzZSBpbWFnZXNcIik7XG5cblx0XHRhc3NlcnQuZXF1YWwocHJvbXB0Q2FsbHNbMF0ub3B0aW9ucy5pbWFnZXMubGVuZ3RoLCAyKTtcblx0XHRhc3NlcnQuZXF1YWwocHJvbXB0Q2FsbHNbMF0ub3B0aW9ucy5pbWFnZXNbMF0uZGF0YSwgXCJhYWE9XCIpO1xuXHRcdGFzc2VydC5lcXVhbChwcm9tcHRDYWxsc1swXS5vcHRpb25zLmltYWdlc1sxXS5kYXRhLCBcImJiYj1cIik7XG5cdH0pO1xuXG5cdGl0KFwiZGlzY2FyZHMgcGVuZGluZyBpbWFnZXMgb24gYmFzaCBjb21tYW5kXCIsIGFzeW5jICgpID0+IHtcblx0XHRob3N0LnBlbmRpbmdJbWFnZXMucHVzaCh7IC4uLlRFU1RfSU1BR0UgfSk7XG5cdFx0YXdhaXQgaG9zdC5kZWZhdWx0RWRpdG9yLm9uU3VibWl0IShcIiEgbHMgLWxhXCIpO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKGhvc3QucGVuZGluZ0ltYWdlcy5sZW5ndGgsIDApO1xuXHRcdGFzc2VydC5lcXVhbChwcm9tcHRDYWxscy5sZW5ndGgsIDApOyAvLyBiYXNoIGNvbW1hbmRzIGRvbid0IGdvIHRocm91Z2ggcHJvbXB0XG5cdH0pO1xufSk7XG5cbnR5cGUgSG9zdE9wdGlvbnMgPSB7XG5cdGtub3duU2xhc2hDb21tYW5kcz86IHN0cmluZ1tdO1xufTtcblxuZnVuY3Rpb24gZ2V0U2xhc2hDb21tYW5kTmFtZSh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCB0cmltbWVkID0gdGV4dC50cmltKCk7XG5cdGNvbnN0IHNwYWNlSW5kZXggPSB0cmltbWVkLmluZGV4T2YoXCIgXCIpO1xuXHRyZXR1cm4gc3BhY2VJbmRleCA9PT0gLTEgPyB0cmltbWVkLnNsaWNlKDEpIDogdHJpbW1lZC5zbGljZSgxLCBzcGFjZUluZGV4KTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlSG9zdChvcHRpb25zOiBIb3N0T3B0aW9ucyA9IHt9KSB7XG5cdGNvbnN0IHByb21wdGVkOiBzdHJpbmdbXSA9IFtdO1xuXHRjb25zdCBwcm9tcHRPcHRpb25zOiBhbnlbXSA9IFtdO1xuXHRjb25zdCBlcnJvcnM6IHN0cmluZ1tdID0gW107XG5cdGNvbnN0IHdhcm5pbmdzOiBzdHJpbmdbXSA9IFtdO1xuXHRjb25zdCB0aXBzOiBzdHJpbmdbXSA9IFtdO1xuXHRjb25zdCBoaXN0b3J5OiBzdHJpbmdbXSA9IFtdO1xuXHRjb25zdCBrbm93blNsYXNoQ29tbWFuZHMgPSBuZXcgU2V0KG9wdGlvbnMua25vd25TbGFzaENvbW1hbmRzID8/IFtdKTtcblx0bGV0IGVkaXRvclRleHQgPSBcIlwiO1xuXHRsZXQgc2V0dGluZ3NPcGVuZWQgPSAwO1xuXG5cdGNvbnN0IGVkaXRvciA9IHtcblx0XHRzZXRUZXh0KHRleHQ6IHN0cmluZykge1xuXHRcdFx0ZWRpdG9yVGV4dCA9IHRleHQ7XG5cdFx0fSxcblx0XHRnZXRUZXh0KCkge1xuXHRcdFx0cmV0dXJuIGVkaXRvclRleHQ7XG5cdFx0fSxcblx0XHRhZGRUb0hpc3RvcnkodGV4dDogc3RyaW5nKSB7XG5cdFx0XHRoaXN0b3J5LnB1c2godGV4dCk7XG5cdFx0fSxcblx0fTtcblxuXHRjb25zdCBob3N0ID0ge1xuXHRcdGRlZmF1bHRFZGl0b3I6IGVkaXRvciBhcyB0eXBlb2YgZWRpdG9yICYgeyBvblN1Ym1pdD86ICh0ZXh0OiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD4gfSxcblx0XHRlZGl0b3IsXG5cdFx0c2Vzc2lvbjoge1xuXHRcdFx0aXNCYXNoUnVubmluZzogZmFsc2UsXG5cdFx0XHRpc0NvbXBhY3Rpbmc6IGZhbHNlLFxuXHRcdFx0aXNTdHJlYW1pbmc6IGZhbHNlLFxuXHRcdFx0cHJvbXB0OiBhc3luYyAodGV4dDogc3RyaW5nLCBvcHRpb25zPzogYW55KSA9PiB7XG5cdFx0XHRcdHByb21wdGVkLnB1c2godGV4dCk7XG5cdFx0XHRcdHByb21wdE9wdGlvbnMucHVzaChvcHRpb25zKTtcblx0XHRcdH0sXG5cdFx0fSxcblx0XHR1aToge1xuXHRcdFx0cmVxdWVzdFJlbmRlcigpIHt9LFxuXHRcdH0sXG5cdFx0cGVuZGluZ0ltYWdlczogW10gYXMgSW1hZ2VDb250ZW50W10sXG5cdFx0Z2V0U2xhc2hDb21tYW5kQ29udGV4dDogKCkgPT4gKHtcblx0XHRcdHNob3dTZXR0aW5nc1NlbGVjdG9yOiAoKSA9PiB7XG5cdFx0XHRcdHNldHRpbmdzT3BlbmVkICs9IDE7XG5cdFx0XHR9LFxuXHRcdH0pLFxuXHRcdGhhbmRsZUJhc2hDb21tYW5kOiBhc3luYyAoKSA9PiB7fSxcblx0XHRzaG93V2FybmluZyhtZXNzYWdlOiBzdHJpbmcpIHtcblx0XHRcdHdhcm5pbmdzLnB1c2gobWVzc2FnZSk7XG5cdFx0fSxcblx0XHRzaG93RXJyb3IobWVzc2FnZTogc3RyaW5nKSB7XG5cdFx0XHRlcnJvcnMucHVzaChtZXNzYWdlKTtcblx0XHR9LFxuXHRcdHNob3dUaXAobWVzc2FnZTogc3RyaW5nKSB7XG5cdFx0XHR0aXBzLnB1c2gobWVzc2FnZSk7XG5cdFx0fSxcblx0XHR1cGRhdGVFZGl0b3JCb3JkZXJDb2xvcigpIHt9LFxuXHRcdGlzRXh0ZW5zaW9uQ29tbWFuZCgpIHtcblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9LFxuXHRcdGlzS25vd25TbGFzaENvbW1hbmQodGV4dDogc3RyaW5nKSB7XG5cdFx0XHRyZXR1cm4ga25vd25TbGFzaENvbW1hbmRzLmhhcyhnZXRTbGFzaENvbW1hbmROYW1lKHRleHQpKTtcblx0XHR9LFxuXHRcdHF1ZXVlQ29tcGFjdGlvbk1lc3NhZ2UoKSB7fSxcblx0XHR1cGRhdGVQZW5kaW5nTWVzc2FnZXNEaXNwbGF5KCkge30sXG5cdFx0Zmx1c2hQZW5kaW5nQmFzaENvbXBvbmVudHMoKSB7fSxcblx0XHRjb250ZXh0dWFsVGlwczoge1xuXHRcdFx0cmVjb3JkQmFzaEluY2x1ZGVkKCkge30sXG5cdFx0XHRldmFsdWF0ZSgpIHtcblx0XHRcdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0XHRcdH0sXG5cdFx0fSxcblx0XHRnZXRDb250ZXh0UGVyY2VudCgpIHtcblx0XHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdFx0fSxcblx0fTtcblxuXHRzZXR1cEVkaXRvclN1Ym1pdEhhbmRsZXIoaG9zdCBhcyBhbnkpO1xuXG5cdHJldHVybiB7XG5cdFx0aG9zdDogaG9zdCBhcyB0eXBlb2YgaG9zdCAmIHsgZGVmYXVsdEVkaXRvcjogdHlwZW9mIGVkaXRvciAmIHsgb25TdWJtaXQ6ICh0ZXh0OiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD4gfSB9LFxuXHRcdHByb21wdGVkLFxuXHRcdHByb21wdE9wdGlvbnMsXG5cdFx0ZXJyb3JzLFxuXHRcdHdhcm5pbmdzLFxuXHRcdHRpcHMsXG5cdFx0aGlzdG9yeSxcblx0XHRnZXRFZGl0b3JUZXh0OiAoKSA9PiBlZGl0b3JUZXh0LFxuXHRcdGdldFNldHRpbmdzT3BlbmVkOiAoKSA9PiBzZXR0aW5nc09wZW5lZCxcblx0fTtcbn1cblxudGVzdChcImlucHV0LWNvbnRyb2xsZXI6IHJlZ3VsYXIgcHJvbXB0IHN1Ym1pdCBwcmVzZXJ2ZXMgcGVuZGluZyBpbWFnZXNcIiwgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCB7IGhvc3QsIHByb21wdGVkLCBwcm9tcHRPcHRpb25zIH0gPSBjcmVhdGVIb3N0KCk7XG5cdGhvc3QucGVuZGluZ0ltYWdlcy5wdXNoKHsgLi4uVEVTVF9JTUFHRSB9KTtcblxuXHRhd2FpdCBob3N0LmRlZmF1bHRFZGl0b3Iub25TdWJtaXQoXCJkZXNjcmliZSB0aGlzIGltYWdlIFtJbWFnZSAjMV1cIik7XG5cblx0YXNzZXJ0LmRlZXBFcXVhbChwcm9tcHRlZCwgW1wiZGVzY3JpYmUgdGhpcyBpbWFnZSBbSW1hZ2UgIzFdXCJdKTtcblx0YXNzZXJ0LmVxdWFsKHByb21wdE9wdGlvbnNbMF0/LmltYWdlcz8ubGVuZ3RoLCAxKTtcblx0YXNzZXJ0LmVxdWFsKHByb21wdE9wdGlvbnNbMF0uaW1hZ2VzWzBdLm1pbWVUeXBlLCBcImltYWdlL3BuZ1wiKTtcblx0YXNzZXJ0LmVxdWFsKHByb21wdE9wdGlvbnNbMF0uaW1hZ2VzWzBdLmRhdGEsIFRFU1RfSU1BR0UuZGF0YSk7XG5cdGFzc2VydC5lcXVhbChob3N0LnBlbmRpbmdJbWFnZXMubGVuZ3RoLCAwKTtcbn0pO1xuXG50ZXN0KFwiaW5wdXQtY29udHJvbGxlcjogYnVpbHQtaW4gc2xhc2ggY29tbWFuZHMgc3RheSBpbiBUVUkgZGlzcGF0Y2hcIiwgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCB7IGhvc3QsIHByb21wdGVkLCBlcnJvcnMsIGdldFNldHRpbmdzT3BlbmVkLCBnZXRFZGl0b3JUZXh0IH0gPSBjcmVhdGVIb3N0KCk7XG5cblx0YXdhaXQgaG9zdC5kZWZhdWx0RWRpdG9yLm9uU3VibWl0KFwiL3NldHRpbmdzXCIpO1xuXG5cdGFzc2VydC5lcXVhbChnZXRTZXR0aW5nc09wZW5lZCgpLCAxLCBcImJ1aWx0LWluIC9zZXR0aW5ncyBzaG91bGQgb3BlbiB0aGUgc2V0dGluZ3Mgc2VsZWN0b3JcIik7XG5cdGFzc2VydC5kZWVwRXF1YWwocHJvbXB0ZWQsIFtdLCBcImJ1aWx0LWluIHNsYXNoIGNvbW1hbmRzIHNob3VsZCBub3QgcmVhY2ggc2Vzc2lvbi5wcm9tcHRcIik7XG5cdGFzc2VydC5kZWVwRXF1YWwoZXJyb3JzLCBbXSwgXCJidWlsdC1pbiBzbGFzaCBjb21tYW5kcyBzaG91bGQgbm90IHNob3cgZXJyb3JzXCIpO1xuXHRhc3NlcnQuZXF1YWwoZ2V0RWRpdG9yVGV4dCgpLCBcIlwiLCBcImJ1aWx0LWluIHNsYXNoIGNvbW1hbmRzIHNob3VsZCBjbGVhciB0aGUgZWRpdG9yIGFmdGVyIGhhbmRsaW5nXCIpO1xufSk7XG5cbnRlc3QoXCJpbnB1dC1jb250cm9sbGVyOiBleHRlbnNpb24gc2xhc2ggY29tbWFuZHMgZmFsbCB0aHJvdWdoIHRvIHNlc3Npb24ucHJvbXB0XCIsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgeyBob3N0LCBwcm9tcHRlZCwgZXJyb3JzLCBoaXN0b3J5IH0gPSBjcmVhdGVIb3N0KHsga25vd25TbGFzaENvbW1hbmRzOiBbXCJnc2RcIl0gfSk7XG5cblx0YXdhaXQgaG9zdC5kZWZhdWx0RWRpdG9yLm9uU3VibWl0KFwiL2dzZCBoZWxwXCIpO1xuXG5cdGFzc2VydC5kZWVwRXF1YWwocHJvbXB0ZWQsIFtcIi9nc2QgaGVscFwiXSwgXCJrbm93biBleHRlbnNpb24gc2xhc2ggY29tbWFuZHMgc2hvdWxkIHJlYWNoIHNlc3Npb24ucHJvbXB0XCIpO1xuXHRhc3NlcnQuZGVlcEVxdWFsKGVycm9ycywgW10sIFwia25vd24gZXh0ZW5zaW9uIHNsYXNoIGNvbW1hbmRzIHNob3VsZCBub3Qgc2hvdyB1bmtub3duLWNvbW1hbmQgZXJyb3JzXCIpO1xuXHRhc3NlcnQuZGVlcEVxdWFsKGhpc3RvcnksIFtcIi9nc2QgaGVscFwiXSwgXCJrbm93biBleHRlbnNpb24gc2xhc2ggY29tbWFuZHMgc2hvdWxkIHN0aWxsIGJlIGFkZGVkIHRvIGhpc3RvcnlcIik7XG59KTtcblxudGVzdChcImlucHV0LWNvbnRyb2xsZXI6IHByb21wdCB0ZW1wbGF0ZSBzbGFzaCBjb21tYW5kcyBmYWxsIHRocm91Z2ggdG8gc2Vzc2lvbi5wcm9tcHRcIiwgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCB7IGhvc3QsIHByb21wdGVkLCBlcnJvcnMgfSA9IGNyZWF0ZUhvc3QoeyBrbm93blNsYXNoQ29tbWFuZHM6IFtcImRhaWx5XCJdIH0pO1xuXG5cdGF3YWl0IGhvc3QuZGVmYXVsdEVkaXRvci5vblN1Ym1pdChcIi9kYWlseSBmb2N1cyBhcmVhXCIpO1xuXG5cdGFzc2VydC5kZWVwRXF1YWwocHJvbXB0ZWQsIFtcIi9kYWlseSBmb2N1cyBhcmVhXCJdKTtcblx0YXNzZXJ0LmRlZXBFcXVhbChlcnJvcnMsIFtdKTtcbn0pO1xuXG50ZXN0KFwiaW5wdXQtY29udHJvbGxlcjogc2tpbGwgc2xhc2ggY29tbWFuZHMgZmFsbCB0aHJvdWdoIHRvIHNlc3Npb24ucHJvbXB0XCIsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgeyBob3N0LCBwcm9tcHRlZCwgZXJyb3JzIH0gPSBjcmVhdGVIb3N0KHsga25vd25TbGFzaENvbW1hbmRzOiBbXCJza2lsbDpjcmVhdGUtc2tpbGxcIl0gfSk7XG5cblx0YXdhaXQgaG9zdC5kZWZhdWx0RWRpdG9yLm9uU3VibWl0KFwiL3NraWxsOmNyZWF0ZS1za2lsbCByb3V0aW5nIGJ1Z1wiKTtcblxuXHRhc3NlcnQuZGVlcEVxdWFsKHByb21wdGVkLCBbXCIvc2tpbGw6Y3JlYXRlLXNraWxsIHJvdXRpbmcgYnVnXCJdKTtcblx0YXNzZXJ0LmRlZXBFcXVhbChlcnJvcnMsIFtdKTtcbn0pO1xuXG50ZXN0KFwiaW5wdXQtY29udHJvbGxlcjogZGlzYWJsZWQgc2tpbGwgc2xhc2ggY29tbWFuZHMgc3RheSB1bmtub3duXCIsIGFzeW5jICgpID0+IHtcblx0Y29uc3QgeyBob3N0LCBwcm9tcHRlZCwgZXJyb3JzIH0gPSBjcmVhdGVIb3N0KCk7XG5cblx0YXdhaXQgaG9zdC5kZWZhdWx0RWRpdG9yLm9uU3VibWl0KFwiL3NraWxsOmNyZWF0ZS1za2lsbCByb3V0aW5nIGJ1Z1wiKTtcblxuXHRhc3NlcnQuZGVlcEVxdWFsKHByb21wdGVkLCBbXSk7XG5cdGFzc2VydC5kZWVwRXF1YWwoZXJyb3JzLCBbXCJVbmtub3duIGNvbW1hbmQ6IC9za2lsbDpjcmVhdGUtc2tpbGwuIFVzZSBzbGFzaCBhdXRvY29tcGxldGUgdG8gc2VlIGF2YWlsYWJsZSBjb21tYW5kcy5cIl0pO1xufSk7XG5cbnRlc3QoXCJpbnB1dC1jb250cm9sbGVyOiAvZXhwb3J0IHByZWZpeCBkb2VzIG5vdCBzd2FsbG93IHVucmVsYXRlZCBzbGFzaCBjb21tYW5kc1wiLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHsgaG9zdCwgcHJvbXB0ZWQsIGVycm9ycyB9ID0gY3JlYXRlSG9zdCgpO1xuXG5cdGF3YWl0IGhvc3QuZGVmYXVsdEVkaXRvci5vblN1Ym1pdChcIi9leHBvcnRmb29cIik7XG5cblx0YXNzZXJ0LmRlZXBFcXVhbChwcm9tcHRlZCwgW10pO1xuXHRhc3NlcnQuZGVlcEVxdWFsKGVycm9ycywgW1wiVW5rbm93biBjb21tYW5kOiAvZXhwb3J0Zm9vLiBVc2Ugc2xhc2ggYXV0b2NvbXBsZXRlIHRvIHNlZSBhdmFpbGFibGUgY29tbWFuZHMuXCJdKTtcbn0pO1xuXG50ZXN0KFwiaW5wdXQtY29udHJvbGxlcjogdHJ1bHkgdW5rbm93biBzbGFzaCBjb21tYW5kcyBzdG9wIGJlZm9yZSBzZXNzaW9uLnByb21wdFwiLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHsgaG9zdCwgcHJvbXB0ZWQsIGVycm9ycywgZ2V0RWRpdG9yVGV4dCB9ID0gY3JlYXRlSG9zdCgpO1xuXG5cdGF3YWl0IGhvc3QuZGVmYXVsdEVkaXRvci5vblN1Ym1pdChcIi9kZWZpbml0ZWx5LW5vdC1hLWNvbW1hbmRcIik7XG5cblx0YXNzZXJ0LmRlZXBFcXVhbChwcm9tcHRlZCwgW10sIFwidW5rbm93biBzbGFzaCBjb21tYW5kcyBzaG91bGQgbm90IHJlYWNoIHNlc3Npb24ucHJvbXB0XCIpO1xuXHRhc3NlcnQuZGVlcEVxdWFsKFxuXHRcdGVycm9ycyxcblx0XHRbXCJVbmtub3duIGNvbW1hbmQ6IC9kZWZpbml0ZWx5LW5vdC1hLWNvbW1hbmQuIFVzZSBzbGFzaCBhdXRvY29tcGxldGUgdG8gc2VlIGF2YWlsYWJsZSBjb21tYW5kcy5cIl0sXG5cdCk7XG5cdGFzc2VydC5lcXVhbChnZXRFZGl0b3JUZXh0KCksIFwiXCIsIFwidW5rbm93biBzbGFzaCBjb21tYW5kcyBzaG91bGQgY2xlYXIgdGhlIGVkaXRvciBhZnRlciBzaG93aW5nIHRoZSBlcnJvclwiKTtcbn0pO1xuXG50ZXN0KFwiaW5wdXQtY29udHJvbGxlcjogYWJzb2x1dGUgZmlsZSBwYXRocyBhcmUgbm90IHRyZWF0ZWQgYXMgc2xhc2ggY29tbWFuZHMgKCMzNDc4KVwiLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHsgaG9zdCwgcHJvbXB0ZWQsIGVycm9ycyB9ID0gY3JlYXRlSG9zdCgpO1xuXG5cdGF3YWl0IGhvc3QuZGVmYXVsdEVkaXRvci5vblN1Ym1pdChcIi9Vc2Vycy9uYW1lL0Rlc2t0b3Avc2NyZWVuc2hvdC5wbmdcIik7XG5cblx0YXNzZXJ0LmRlZXBFcXVhbChlcnJvcnMsIFtdLCBcImZpbGUgcGF0aHMgc2hvdWxkIG5vdCB0cmlnZ2VyIHVua25vd24gY29tbWFuZCBlcnJvclwiKTtcblx0YXNzZXJ0LmRlZXBFcXVhbChwcm9tcHRlZCwgW1wiL1VzZXJzL25hbWUvRGVza3RvcC9zY3JlZW5zaG90LnBuZ1wiXSwgXCJmaWxlIHBhdGhzIHNob3VsZCBiZSBzZW50IGFzIHBsYWluIGlucHV0XCIpO1xufSk7XG5cbnRlc3QoXCJpbnB1dC1jb250cm9sbGVyOiBMaW51eCBhYnNvbHV0ZSBwYXRocyBhcmUgbm90IHRyZWF0ZWQgYXMgc2xhc2ggY29tbWFuZHMgKCMzNDc4KVwiLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHsgaG9zdCwgcHJvbXB0ZWQsIGVycm9ycyB9ID0gY3JlYXRlSG9zdCgpO1xuXG5cdGF3YWl0IGhvc3QuZGVmYXVsdEVkaXRvci5vblN1Ym1pdChcIi9ob21lL3VzZXIvZG9jdW1lbnRzL2ZpbGUudHh0XCIpO1xuXG5cdGFzc2VydC5kZWVwRXF1YWwoZXJyb3JzLCBbXSwgXCJMaW51eCBwYXRocyBzaG91bGQgbm90IHRyaWdnZXIgdW5rbm93biBjb21tYW5kIGVycm9yXCIpO1xuXHRhc3NlcnQuZGVlcEVxdWFsKHByb21wdGVkLCBbXCIvaG9tZS91c2VyL2RvY3VtZW50cy9maWxlLnR4dFwiXSwgXCJMaW51eCBwYXRocyBzaG91bGQgYmUgc2VudCBhcyBwbGFpbiBpbnB1dFwiKTtcbn0pO1xuXG50ZXN0KFwiaW5wdXQtY29udHJvbGxlcjogL3RtcCBwYXRocyBhcmUgbm90IHRyZWF0ZWQgYXMgc2xhc2ggY29tbWFuZHMgKCMzNDc4KVwiLCBhc3luYyAoKSA9PiB7XG5cdGNvbnN0IHsgaG9zdCwgcHJvbXB0ZWQsIGVycm9ycyB9ID0gY3JlYXRlSG9zdCgpO1xuXG5cdGF3YWl0IGhvc3QuZGVmYXVsdEVkaXRvci5vblN1Ym1pdChcIi90bXAvc29tZS1maWxlLmxvZ1wiKTtcblxuXHRhc3NlcnQuZGVlcEVxdWFsKGVycm9ycywgW10pO1xuXHRhc3NlcnQuZGVlcEVxdWFsKHByb21wdGVkLCBbXCIvdG1wL3NvbWUtZmlsZS5sb2dcIl0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFHQSxTQUFTLFVBQVUsSUFBSSxrQkFBa0I7QUFDekMsT0FBTyxZQUFZO0FBQ25CLE9BQU8sVUFBVTtBQUNqQixTQUFTLGdDQUFnQztBQUN6QyxTQUFTLHNCQUFzQjtBQUsvQixTQUFTLGlCQUFpQjtBQUN6QixRQUFNLGNBQXNELENBQUM7QUFDN0QsUUFBTSxlQUF5QixDQUFDO0FBQ2hDLE1BQUksYUFBYTtBQUVqQixRQUFNLE9BQU87QUFBQSxJQUNaLGVBQWU7QUFBQSxNQUNkLFVBQVU7QUFBQSxNQUNWLGNBQWMsQ0FBQyxTQUFpQjtBQUFFLHFCQUFhLEtBQUssSUFBSTtBQUFBLE1BQUc7QUFBQSxNQUMzRCxTQUFTLENBQUMsU0FBaUI7QUFBRSxxQkFBYTtBQUFBLE1BQU07QUFBQSxNQUNoRCxTQUFTLE1BQU07QUFBQSxJQUNoQjtBQUFBLElBQ0EsUUFBUTtBQUFBLE1BQ1AsU0FBUyxDQUFDLFNBQWlCO0FBQUUscUJBQWE7QUFBQSxNQUFNO0FBQUEsTUFDaEQsU0FBUyxNQUFNO0FBQUEsTUFDZixjQUFjLENBQUMsU0FBaUI7QUFBRSxxQkFBYSxLQUFLLElBQUk7QUFBQSxNQUFHO0FBQUEsSUFDNUQ7QUFBQSxJQUNBLFNBQVM7QUFBQSxNQUNSLGFBQWE7QUFBQSxNQUNiLGNBQWM7QUFBQSxNQUNkLGVBQWU7QUFBQSxNQUNmLGVBQWU7QUFBQSxNQUNmLFFBQVEsT0FBTyxNQUFjLFlBQWtCO0FBQUUsb0JBQVksS0FBSyxFQUFFLE1BQU0sUUFBUSxDQUFDO0FBQUEsTUFBRztBQUFBLElBQ3ZGO0FBQUEsSUFDQSxJQUFJLEVBQUUsZUFBZSxNQUFNO0FBQUEsSUFBQyxFQUFFO0FBQUEsSUFDOUIsUUFBUSxDQUFDO0FBQUEsSUFDVCxhQUFhLENBQUM7QUFBQSxJQUNkLGlCQUFpQixDQUFDO0FBQUEsSUFDbEIsZUFB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O0FBQ2hGLFFBQU0sRUFBRSxNQUFNLFVBQVUsT0FBTyxJQUFJLFdBQVc7QUFFOUMsUUFBTSxLQUFLLGNBQWMsU0FBUyxpQ0FBaUM7QUFFbkUsU0FBTyxVQUFVLFVBQVUsQ0FBQyxDQUFDO0FBQzdCLFNBQU8sVUFBVSxRQUFRLENBQUMseUZBQXlGLENBQUM7QUFDckgsQ0FBQztBQUVELEtBQUssOEVBQThFLFlBQVk7QUFDOUYsUUFBTSxFQUFFLE1BQU0sVUFBVSxPQUFPLElBQUksV0FBVztBQUU5QyxRQUFNLEtBQUssY0FBYyxTQUFTLFlBQVk7QUFFOUMsU0FBTyxVQUFVLFVBQVUsQ0FBQyxDQUFDO0FBQzdCLFNBQU8sVUFBVSxRQUFRLENBQUMsZ0ZBQWdGLENBQUM7QUFDNUcsQ0FBQztBQUVELEtBQUssNkVBQTZFLFlBQVk7QUFDN0YsUUFBTSxFQUFFLE1BQU0sVUFBVSxRQUFRLGNBQWMsSUFBSSxXQUFXO0FBRTdELFFBQU0sS0FBSyxjQUFjLFNBQVMsMkJBQTJCO0FBRTdELFNBQU8sVUFBVSxVQUFVLENBQUMsR0FBRyx3REFBd0Q7QUFDdkYsU0FBTztBQUFBLElBQ047QUFBQSxJQUNBLENBQUMsK0ZBQStGO0FBQUEsRUFDakc7QUFDQSxTQUFPLE1BQU0sY0FBYyxHQUFHLElBQUksd0VBQXdFO0FBQzNHLENBQUM7QUFFRCxLQUFLLG1GQUFtRixZQUFZO0FBQ25HLFFBQU0sRUFBRSxNQUFNLFVBQVUsT0FBTyxJQUFJLFdBQVc7QUFFOUMsUUFBTSxLQUFLLGNBQWMsU0FBUyxvQ0FBb0M7QUFFdEUsU0FBTyxVQUFVLFFBQVEsQ0FBQyxHQUFHLHFEQUFxRDtBQUNsRixTQUFPLFVBQVUsVUFBVSxDQUFDLG9DQUFvQyxHQUFHLDBDQUEwQztBQUM5RyxDQUFDO0FBRUQsS0FBSyxvRkFBb0YsWUFBWTtBQUNwRyxRQUFNLEVBQUUsTUFBTSxVQUFVLE9BQU8sSUFBSSxXQUFXO0FBRTlDLFFBQU0sS0FBSyxjQUFjLFNBQVMsK0JBQStCO0FBRWpFLFNBQU8sVUFBVSxRQUFRLENBQUMsR0FBRyxzREFBc0Q7QUFDbkYsU0FBTyxVQUFVLFVBQVUsQ0FBQywrQkFBK0IsR0FBRywyQ0FBMkM7QUFDMUcsQ0FBQztBQUVELEtBQUssMEVBQTBFLFlBQVk7QUFDMUYsUUFBTSxFQUFFLE1BQU0sVUFBVSxPQUFPLElBQUksV0FBVztBQUU5QyxRQUFNLEtBQUssY0FBYyxTQUFTLG9CQUFvQjtBQUV0RCxTQUFPLFVBQVUsUUFBUSxDQUFDLENBQUM7QUFDM0IsU0FBTyxVQUFVLFVBQVUsQ0FBQyxvQkFBb0IsQ0FBQztBQUNsRCxDQUFDOyIsCiAgIm5hbWVzIjogWyJvcHRpb25zIl0KfQo=
