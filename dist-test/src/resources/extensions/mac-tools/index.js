import { StringEnum } from "@gsd/pi-ai";
import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";
import { statSync, readdirSync } from "node:fs";
import path from "node:path";
const EXTENSION_DIR = path.dirname(new URL(import.meta.url).pathname);
const SWIFT_CLI_DIR = path.join(EXTENSION_DIR, "swift-cli");
const SOURCES_DIR = path.join(SWIFT_CLI_DIR, "Sources");
const BINARY_PATH = path.join(SWIFT_CLI_DIR, ".build", "release", "mac-agent");
const PACKAGE_SWIFT = path.join(SWIFT_CLI_DIR, "Package.swift");
function getSourceMtime() {
  let latest = 0;
  try {
    latest = Math.max(latest, statSync(PACKAGE_SWIFT).mtimeMs);
  } catch {
  }
  try {
    const files = readdirSync(SOURCES_DIR);
    for (const f of files) {
      try {
        const mt = statSync(path.join(SOURCES_DIR, f)).mtimeMs;
        if (mt > latest) latest = mt;
      } catch {
      }
    }
  } catch {
  }
  return latest;
}
function getBinaryMtime() {
  try {
    return statSync(BINARY_PATH).mtimeMs;
  } catch {
    return 0;
  }
}
function ensureCompiled() {
  const srcMtime = getSourceMtime();
  const binMtime = getBinaryMtime();
  if (binMtime > 0 && binMtime >= srcMtime) {
    return;
  }
  const action = binMtime === 0 ? "Compiling" : "Recompiling";
  try {
    execFileSync("swift", ["build", "-c", "release"], {
      cwd: SWIFT_CLI_DIR,
      timeout: 3e4,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (err) {
    const stderr = err.stderr?.toString() || "";
    const stdout = err.stdout?.toString() || "";
    throw new Error(
      `Swift compilation failed (${action.toLowerCase()}):
${stderr || stdout || err.message}`
    );
  }
}
function execMacAgent(command, params) {
  ensureCompiled();
  const input = JSON.stringify({ command, params: params ?? {} });
  let stdout;
  let stderr = "";
  const slowCommands = /* @__PURE__ */ new Set(["clickElement", "typeText", "screenshotWindow"]);
  const timeout = slowCommands.has(command) ? 3e4 : 1e4;
  try {
    const result = execFileSync(BINARY_PATH, [], {
      input,
      timeout,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 5 * 1024 * 1024
      // 5MB — needed for retina screenshot base64 payloads
    });
    stdout = typeof result === "string" ? result : String(result);
  } catch (err) {
    stderr = err.stderr?.toString() || "";
    const isTimeout = err.killed || err.signal === "SIGTERM";
    if (err.stdout) {
      stdout = err.stdout.toString();
    } else if (isTimeout) {
      throw new Error(
        `mac-agent timed out after ${timeout / 1e3}s (command: ${command}). The target app may be slow to respond \u2014 AXPress can block while the app processes the action.`
      );
    } else {
      throw new Error(
        `mac-agent CLI failed (command: ${command}):
${stderr || err.message}`
      );
    }
  }
  try {
    return JSON.parse(stdout.trim());
  } catch {
    throw new Error(
      `mac-agent returned invalid JSON (command: ${command}):
stdout: ${stdout}
stderr: ${stderr}`
    );
  }
}
function mac_tools_default(pi) {
  pi.registerTool({
    name: "mac_check_permissions",
    label: "Mac Permissions",
    description: "Check whether macOS Accessibility and Screen Recording permissions are enabled for the current terminal. Returns { accessibilityEnabled, screenRecordingEnabled }. Accessibility is required for UI automation; Screen Recording is required for mac_screenshot. Both are granted in System Settings > Privacy & Security.",
    promptGuidelines: [
      "Run this first if any mac tool returns a permission error."
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId) {
      const result = execMacAgent("checkPermissions");
      if (!result.success) {
        throw new Error("mac_check_permissions: " + result.error);
      }
      const accessibility = result.data?.accessibilityEnabled ?? false;
      const screenRecording = result.data?.screenRecordingEnabled ?? false;
      const lines = [];
      lines.push(accessibility ? "\u2705 Accessibility: enabled" : "\u274C Accessibility: NOT enabled \u2014 grant in System Settings > Privacy & Security > Accessibility");
      lines.push(screenRecording ? "\u2705 Screen Recording: enabled" : "\u274C Screen Recording: NOT enabled \u2014 grant in System Settings > Privacy & Security > Screen Recording");
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: result.data
      };
    }
  });
  pi.registerTool({
    name: "mac_list_apps",
    label: "List Apps",
    description: "List all running macOS applications. Returns an array of { name, bundleId, pid, isActive } for user-facing apps (regular activation policy). Set includeBackground to true to also include accessory/background apps.",
    promptGuidelines: [
      "Use to discover what apps are running before interacting with them."
    ],
    parameters: Type.Object({
      includeBackground: Type.Optional(Type.Boolean({ description: "Include background/accessory apps (default: false)" }))
    }),
    async execute(_toolCallId, { includeBackground }) {
      const result = execMacAgent("listApps", includeBackground ? { includeBackground: true } : void 0);
      if (!result.success) {
        throw new Error("mac_list_apps: " + result.error);
      }
      const apps = result.data;
      const summary = apps.map((a) => `${a.name} (${a.bundleId}) pid:${a.pid}${a.isActive ? " [active]" : ""}`).join("\n");
      return {
        content: [{ type: "text", text: `${apps.length} running apps:
${summary}` }],
        details: { apps }
      };
    }
  });
  pi.registerTool({
    name: "mac_launch_app",
    label: "Launch App",
    description: "Launch a macOS application by name or bundle ID. Returns { launched, name, bundleId, pid } on success. Provide either 'name' (e.g. 'TextEdit') or 'bundleId' (e.g. 'com.apple.TextEdit').",
    promptGuidelines: [
      "Use app name for well-known apps; use bundleId when the name is ambiguous."
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Application name (e.g. 'TextEdit', 'Safari')" })),
      bundleId: Type.Optional(Type.String({ description: "Bundle identifier (e.g. 'com.apple.TextEdit')" }))
    }),
    async execute(_toolCallId, { name, bundleId }) {
      if (!name && !bundleId) {
        throw new Error("mac_launch_app: provide either 'name' or 'bundleId' parameter");
      }
      const params = {};
      if (name) params.name = name;
      if (bundleId) params.bundleId = bundleId;
      const result = execMacAgent("launchApp", params);
      if (!result.success) {
        throw new Error("mac_launch_app: " + result.error);
      }
      const d = result.data;
      return {
        content: [{ type: "text", text: `Launched ${d.name} (${d.bundleId}) pid:${d.pid}` }],
        details: result.data
      };
    }
  });
  pi.registerTool({
    name: "mac_activate_app",
    label: "Activate App",
    description: "Bring a running macOS application to the front. Returns { activated, name } on success. Errors if the app is not running. Provide either 'name' or 'bundleId'.",
    promptGuidelines: [
      "Activate an app before interacting with its UI to ensure it is frontmost."
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Application name" })),
      bundleId: Type.Optional(Type.String({ description: "Bundle identifier" }))
    }),
    async execute(_toolCallId, { name, bundleId }) {
      if (!name && !bundleId) {
        throw new Error("mac_activate_app: provide either 'name' or 'bundleId' parameter");
      }
      const params = {};
      if (name) params.name = name;
      if (bundleId) params.bundleId = bundleId;
      const result = execMacAgent("activateApp", params);
      if (!result.success) {
        throw new Error("mac_activate_app: " + result.error);
      }
      return {
        content: [{ type: "text", text: `Activated ${result.data?.name}` }],
        details: result.data
      };
    }
  });
  pi.registerTool({
    name: "mac_quit_app",
    label: "Quit App",
    description: "Quit a running macOS application. Returns { quit, name } on success. Errors if the app is not running. Provide either 'name' or 'bundleId'.",
    promptGuidelines: [
      "Use to clean up apps launched during automation \u2014 don't leave apps running unnecessarily."
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Application name" })),
      bundleId: Type.Optional(Type.String({ description: "Bundle identifier" }))
    }),
    async execute(_toolCallId, { name, bundleId }) {
      if (!name && !bundleId) {
        throw new Error("mac_quit_app: provide either 'name' or 'bundleId' parameter");
      }
      const params = {};
      if (name) params.name = name;
      if (bundleId) params.bundleId = bundleId;
      const result = execMacAgent("quitApp", params);
      if (!result.success) {
        throw new Error("mac_quit_app: " + result.error);
      }
      return {
        content: [{ type: "text", text: `Quit ${result.data?.name}` }],
        details: result.data
      };
    }
  });
  pi.registerTool({
    name: "mac_list_windows",
    label: "List Windows",
    description: "List all on-screen windows for a macOS application. Returns an array of { windowId, title, bounds: {x,y,width,height}, isOnScreen, layer }. The windowId can be used with getWindowInfo for detailed inspection or with screenshotWindow for capture. Returns an empty array (not error) if the app is running but has no visible windows. Errors if the app is not running.",
    promptGuidelines: [
      "Use to get windowId values needed by mac_screenshot."
    ],
    parameters: Type.Object({
      app: Type.String({ description: "Application name (e.g. 'TextEdit') or bundle identifier (e.g. 'com.apple.TextEdit')" })
    }),
    async execute(_toolCallId, { app }) {
      const result = execMacAgent("listWindows", { app });
      if (!result.success) {
        throw new Error("mac_list_windows: " + result.error);
      }
      const data = result.data;
      const windows = data.windows ?? [];
      if (windows.length === 0) {
        return {
          content: [{ type: "text", text: `${data.app} (pid:${data.pid}) has no visible windows.` }],
          details: data
        };
      }
      const summary = windows.map(
        (w) => `  windowId:${w.windowId} "${w.title}" ${w.bounds.width}x${w.bounds.height} at (${w.bounds.x},${w.bounds.y}) layer:${w.layer}`
      ).join("\n");
      return {
        content: [{ type: "text", text: `${data.app} (pid:${data.pid}) \u2014 ${windows.length} window(s):
${summary}` }],
        details: data
      };
    }
  });
  pi.registerTool({
    name: "mac_find",
    label: "Find Elements",
    description: "Find UI elements in a macOS application's accessibility tree. Three modes:\n- 'search' (default): Find elements matching role/title/value/identifier criteria. Returns a numbered list of matches.\n- 'tree': Dump the full accessibility subtree as an indented tree. Use maxDepth/maxCount to bound output.\n- 'focused': Get the currently focused element in the app. No criteria needed.\nThe 'app' param accepts an app name (e.g. 'Finder') or bundle ID (e.g. 'com.apple.Finder').",
    promptGuidelines: [
      "Prefer for targeted element search \u2014 use role/title/value criteria to narrow results.",
      "Use mode:focused to check the current focus target without search criteria.",
      "Use mac_get_tree instead of mode:tree when you just need to understand app structure."
    ],
    parameters: Type.Object({
      app: Type.String({ description: "Application name or bundle identifier" }),
      mode: Type.Optional(StringEnum(["search", "tree", "focused"], { description: "'search' (default), 'tree', or 'focused'" })),
      role: Type.Optional(Type.String({ description: "AX role to match (e.g. 'AXButton', 'AXTextArea')" })),
      title: Type.Optional(Type.String({ description: "AX title to match" })),
      value: Type.Optional(Type.String({ description: "AX value to match" })),
      identifier: Type.Optional(Type.String({ description: "AX identifier to match" })),
      matchType: Type.Optional(Type.String({ description: "'exact' (default) or 'contains'" })),
      maxDepth: Type.Optional(Type.Number({ description: "Maximum tree depth to traverse (default: 10)" })),
      maxCount: Type.Optional(Type.Number({ description: "Maximum elements to return/visit (default: 100)" }))
    }),
    async execute(_toolCallId, args) {
      const mode = args.mode ?? "search";
      if (mode === "focused") {
        const result2 = execMacAgent("getFocusedElement", { app: args.app });
        if (!result2.success) {
          throw new Error("mac_find (focused): " + result2.error);
        }
        const el = result2.data;
        const parts = [el.role ?? "unknown"];
        if (el.title) parts.push(`"${el.title}"`);
        if (el.value !== void 0) parts.push(`[${el.value}]`);
        return {
          content: [{ type: "text", text: `Focused element: ${parts.join(" ")}` }],
          details: result2.data
        };
      }
      if (mode === "tree") {
        let renderTree2 = function(nodes, indent) {
          for (const node of nodes) {
            const parts = [node.role ?? "?"];
            if (node.title) parts.push(`"${node.title}"`);
            if (node.value !== void 0 && node.value !== "") parts.push(`[${node.value}]`);
            lines2.push("  ".repeat(indent) + parts.join(" "));
            if (node.children?.length) {
              renderTree2(node.children, indent + 1);
            }
          }
        };
        var renderTree = renderTree2;
        const params2 = { app: args.app };
        if (args.maxDepth !== void 0) params2.maxDepth = args.maxDepth;
        if (args.maxCount !== void 0) params2.maxCount = args.maxCount;
        const result2 = execMacAgent("getTree", params2);
        if (!result2.success) {
          throw new Error("mac_find (tree): " + result2.error);
        }
        const data2 = result2.data;
        const lines2 = [];
        renderTree2(data2.tree ?? [], 0);
        const truncNote2 = data2.truncated ? `
(truncated \u2014 ${data2.totalElements} elements visited)` : "";
        return {
          content: [{ type: "text", text: `${lines2.join("\n")}${truncNote2}` }],
          details: result2.data
        };
      }
      const params = { app: args.app };
      if (args.role) params.role = args.role;
      if (args.title) params.title = args.title;
      if (args.value) params.value = args.value;
      if (args.identifier) params.identifier = args.identifier;
      if (args.matchType) params.matchType = args.matchType;
      if (args.maxDepth !== void 0) params.maxDepth = args.maxDepth;
      if (args.maxCount !== void 0) params.maxCount = args.maxCount;
      const result = execMacAgent("findElements", params);
      if (!result.success) {
        throw new Error("mac_find (search): " + result.error);
      }
      const data = result.data;
      const elements = data.elements ?? [];
      if (elements.length === 0) {
        const criteria = [args.role, args.title, args.value, args.identifier].filter(Boolean).join(", ");
        return {
          content: [{ type: "text", text: `No elements found matching: ${criteria || "(no criteria)"}` }],
          details: result.data
        };
      }
      const lines = elements.map((el, i) => {
        const parts = [`${i + 1}. ${el.role ?? "?"}`];
        if (el.title) parts.push(`"${el.title}"`);
        if (el.value !== void 0 && el.value !== "") parts.push(`[${el.value}]`);
        return parts.join(" ");
      });
      const truncNote = data.truncated ? `
(truncated \u2014 search stopped at limit)` : "";
      return {
        content: [{ type: "text", text: `${elements.length} element(s) found:
${lines.join("\n")}${truncNote}` }],
        details: result.data
      };
    }
  });
  pi.registerTool({
    name: "mac_get_tree",
    label: "Get UI Tree",
    description: "Get a compact accessibility tree of a macOS application's UI structure. Returns an indented tree showing role, title, and value of each element. Tighter defaults than mac_find's tree mode \u2014 designed for quick structure inspection. Each line: `role \"title\" [value]` with 2-space indent per depth level. Omits title/value when nil or empty.",
    promptGuidelines: [
      "Use for understanding app UI structure \u2014 start with low limits and increase if needed.",
      "Prefer mac_find search mode when you know what you're looking for.",
      "Check the truncation note to know if the tree was cut short."
    ],
    parameters: Type.Object({
      app: Type.String({ description: "Application name or bundle identifier" }),
      maxDepth: Type.Optional(Type.Number({ description: "Maximum tree depth to traverse (default: 3)" })),
      maxCount: Type.Optional(Type.Number({ description: "Maximum elements to include (default: 50)" }))
    }),
    async execute(_toolCallId, args) {
      const params = { app: args.app };
      params.maxDepth = args.maxDepth ?? 3;
      params.maxCount = args.maxCount ?? 50;
      const result = execMacAgent("getTree", params);
      if (!result.success) {
        throw new Error("mac_get_tree: " + result.error);
      }
      const data = result.data;
      const lines = [];
      function renderNode(nodes, indent) {
        for (const node of nodes) {
          const parts = [node.role ?? "?"];
          if (node.title) parts.push(`"${node.title}"`);
          if (node.value !== void 0 && node.value !== null && node.value !== "") parts.push(`[${node.value}]`);
          lines.push("  ".repeat(indent) + parts.join(" "));
          if (node.children?.length) {
            renderNode(node.children, indent + 1);
          }
        }
      }
      renderNode(data.tree ?? [], 0);
      if (data.truncated) {
        lines.push(`
(truncated \u2014 ${data.totalElements} elements visited, increase maxDepth or maxCount for more)`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { totalElements: data.totalElements, truncated: data.truncated }
      };
    }
  });
  pi.registerTool({
    name: "mac_click",
    label: "Click Element",
    description: "Click a UI element in a macOS application by performing AXPress. Finds the first element matching the given criteria (role, title, value, identifier) and clicks it. At least one criterion is required. Returns the clicked element's attributes.",
    promptGuidelines: [
      "Verify the click worked by reading the resulting state with mac_find or mac_read.",
      "Use mac_find first to discover the right role/title/value criteria before clicking."
    ],
    parameters: Type.Object({
      app: Type.String({ description: "Application name or bundle identifier" }),
      role: Type.Optional(Type.String({ description: "AX role (e.g. 'AXButton', 'AXMenuItem')" })),
      title: Type.Optional(Type.String({ description: "AX title to match" })),
      value: Type.Optional(Type.String({ description: "AX value to match" })),
      identifier: Type.Optional(Type.String({ description: "AX identifier to match" })),
      matchType: Type.Optional(Type.String({ description: "'exact' (default) or 'contains'" }))
    }),
    async execute(_toolCallId, args) {
      if (!args.role && !args.title && !args.value && !args.identifier) {
        throw new Error("mac_click: provide at least one search criterion (role, title, value, or identifier)");
      }
      const params = { app: args.app };
      if (args.role) params.role = args.role;
      if (args.title) params.title = args.title;
      if (args.value) params.value = args.value;
      if (args.identifier) params.identifier = args.identifier;
      if (args.matchType) params.matchType = args.matchType;
      const result = execMacAgent("clickElement", params);
      if (!result.success) {
        throw new Error("mac_click: " + result.error);
      }
      const el = result.data?.element;
      const parts = [el?.role ?? "element"];
      if (el?.title) parts.push(`'${el.title}'`);
      return {
        content: [{ type: "text", text: `Clicked ${parts.join(" ")}` }],
        details: result.data
      };
    }
  });
  pi.registerTool({
    name: "mac_type",
    label: "Type Text",
    description: "Type text into a UI element in a macOS application by setting its AXValue attribute. Finds the first element matching the given criteria and sets its value. Returns the actual value after setting (read-back verification). At least one criterion is required.",
    promptGuidelines: [
      "Read back the value after typing to verify \u2014 the return value includes actual content.",
      "Target text fields/areas by role (AXTextArea, AXTextField) for reliability."
    ],
    parameters: Type.Object({
      app: Type.String({ description: "Application name or bundle identifier" }),
      text: Type.String({ description: "Text to type into the element" }),
      role: Type.Optional(Type.String({ description: "AX role (e.g. 'AXTextArea', 'AXTextField')" })),
      title: Type.Optional(Type.String({ description: "AX title to match" })),
      value: Type.Optional(Type.String({ description: "AX value to match" })),
      identifier: Type.Optional(Type.String({ description: "AX identifier to match" })),
      matchType: Type.Optional(Type.String({ description: "'exact' (default) or 'contains'" }))
    }),
    async execute(_toolCallId, args) {
      if (!args.role && !args.title && !args.value && !args.identifier) {
        throw new Error("mac_type: provide at least one search criterion (role, title, value, or identifier)");
      }
      const params = { app: args.app, text: args.text };
      if (args.role) params.role = args.role;
      if (args.title) params.title = args.title;
      if (args.value) params.value = args.value;
      if (args.identifier) params.identifier = args.identifier;
      if (args.matchType) params.matchType = args.matchType;
      const result = execMacAgent("typeText", params);
      if (!result.success) {
        throw new Error("mac_type: " + result.error);
      }
      const el = result.data?.element;
      const actualValue = result.data?.value;
      const parts = [el?.role ?? "element"];
      if (el?.title) parts.push(`'${el.title}'`);
      return {
        content: [{ type: "text", text: `Typed into ${parts.join(" ")} \u2014 value is now: ${actualValue}` }],
        details: result.data
      };
    }
  });
  pi.registerTool({
    name: "mac_screenshot",
    label: "Screenshot Window",
    description: "Take a screenshot of a macOS application window by its window ID (from mac_list_windows). Returns the screenshot as an image content block for visual analysis, alongside text metadata (dimensions and format). Requires Screen Recording permission \u2014 use mac_check_permissions to verify.",
    promptGuidelines: [
      "Use for visual verification when accessibility attributes aren't sufficient.",
      "Prefer nominal resolution unless retina detail is needed \u2014 retina doubles payload size.",
      "Requires Screen Recording permission \u2014 run mac_check_permissions first if screenshot fails."
    ],
    parameters: Type.Object({
      windowId: Type.Number({ description: "Window ID from mac_list_windows output" }),
      format: Type.Optional(StringEnum(["jpeg", "png"], { description: "'jpeg' (default) or 'png'" })),
      quality: Type.Optional(Type.Number({ description: "JPEG compression quality 0-1 (default: 0.8)" })),
      retina: Type.Optional(Type.Boolean({ description: "Capture at full pixel resolution (default: false)" }))
    }),
    async execute(_toolCallId, args) {
      const params = { windowId: args.windowId };
      if (args.format) params.format = args.format;
      if (args.quality !== void 0) params.quality = args.quality;
      if (args.retina !== void 0) params.retina = args.retina;
      const result = execMacAgent("screenshotWindow", params);
      if (!result.success) {
        throw new Error("mac_screenshot: " + result.error);
      }
      const data = result.data;
      const imageData = data.imageData;
      const format = data.format;
      const width = data.width;
      const height = data.height;
      const mimeType = format === "png" ? "image/png" : "image/jpeg";
      return {
        content: [
          { type: "text", text: `Screenshot: ${width}x${height} ${format}` },
          { type: "image", data: imageData, mimeType }
        ],
        details: { width, height, format, mimeType }
      };
    }
  });
  pi.registerTool({
    name: "mac_read",
    label: "Read Attribute",
    description: "Read one or more accessibility attributes from a UI element in a macOS application. Finds the first element matching the given criteria and reads the named attribute(s). AXValue subtypes (CGPoint, CGSize, CGRect, CFRange) are automatically unpacked to structured dicts. Use 'attribute' for a single attribute or 'attributes' for multiple. At least one search criterion is required.",
    promptGuidelines: [
      "Use to verify state after actions \u2014 read AXValue to confirm text was typed, AXEnabled to check if a button is active."
    ],
    parameters: Type.Object({
      app: Type.String({ description: "Application name or bundle identifier" }),
      attribute: Type.Optional(Type.String({ description: "Single attribute name to read (e.g. 'AXValue', 'AXPosition', 'AXRole')" })),
      attributes: Type.Optional(Type.Array(Type.String(), { description: "Multiple attribute names to read" })),
      role: Type.Optional(Type.String({ description: "AX role (e.g. 'AXButton', 'AXTextArea')" })),
      title: Type.Optional(Type.String({ description: "AX title to match" })),
      value: Type.Optional(Type.String({ description: "AX value to match" })),
      identifier: Type.Optional(Type.String({ description: "AX identifier to match" })),
      matchType: Type.Optional(Type.String({ description: "'exact' (default) or 'contains'" }))
    }),
    async execute(_toolCallId, args) {
      if (!args.attribute && (!args.attributes || args.attributes.length === 0)) {
        throw new Error("mac_read: provide 'attribute' (single) or 'attributes' (array) parameter");
      }
      if (!args.role && !args.title && !args.value && !args.identifier) {
        throw new Error("mac_read: provide at least one search criterion (role, title, value, or identifier)");
      }
      const params = { app: args.app };
      if (args.attribute) params.attribute = args.attribute;
      if (args.attributes) params.attributes = args.attributes;
      if (args.role) params.role = args.role;
      if (args.title) params.title = args.title;
      if (args.value) params.value = args.value;
      if (args.identifier) params.identifier = args.identifier;
      if (args.matchType) params.matchType = args.matchType;
      const result = execMacAgent("readAttribute", params);
      if (!result.success) {
        throw new Error("mac_read: " + result.error);
      }
      if (args.attribute && !args.attributes) {
        const val = result.data?.value;
        const formatted = typeof val === "object" ? JSON.stringify(val) : String(val);
        return {
          content: [{ type: "text", text: `${args.attribute}: ${formatted}` }],
          details: result.data
        };
      }
      const values = result.data?.values;
      if (values) {
        const lines = Object.entries(values).map(([k, v]) => {
          const formatted = typeof v === "object" ? JSON.stringify(v) : String(v);
          return `${k}: ${formatted}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: result.data
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result.data) }],
        details: result.data
      };
    }
  });
  pi.on("before_agent_start", async (event) => {
    const guidelines = `

[SYSTEM CONTEXT \u2014 Mac Tools]

## Native macOS App Interaction

You have mac-tools for controlling native macOS applications (Finder, TextEdit, Safari, Xcode, etc.) via Accessibility APIs.

**Mac-tools vs browser-tools:** Use mac-tools for native macOS apps. Use browser-tools for web pages inside a browser. If you need to interact with a website in Safari or Chrome, use browser-tools \u2014 mac-tools controls the browser's native UI chrome (menus, tabs, address bar), not web page content.

**Permissions:** If any mac tool returns a permission error, run \`mac_check_permissions\` to diagnose. Accessibility and Screen Recording permissions are granted in System Settings > Privacy & Security.

**Interaction pattern \u2014 discover \u2192 act \u2192 verify:**
1. **Discover** the UI structure with \`mac_find\` (search for specific elements) or \`mac_get_tree\` (see overall layout)
2. **Act** with \`mac_click\` (press buttons/menus) or \`mac_type\` (enter text into fields)
3. **Verify** the result with \`mac_read\` (check attribute values) or \`mac_screenshot\` (visual confirmation)

**Tree queries:** Start with default limits (mac_get_tree: maxDepth:3, maxCount:50). Increase only if the element you need isn't visible in the output. Large trees waste context.

**Screenshots:** Use \`mac_screenshot\` only when visual verification is genuinely needed \u2014 the image payload is large. Prefer \`mac_read\` or \`mac_find\` for checking text values and element state.`;
    return { systemPrompt: event.systemPrompt + guidelines };
  });
}
export {
  mac_tools_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL21hYy10b29scy9pbmRleC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBtYWMtdG9vbHMgXHUyMDE0IHBpIGV4dGVuc2lvblxuICpcbiAqIEdpdmVzIHRoZSBhZ2VudCBtYWNPUyBhdXRvbWF0aW9uIGNhcGFiaWxpdGllcyB2aWEgYSBTd2lmdCBDTEkgdGhhdCBpbnRlcmZhY2VzXG4gKiB3aXRoIEFjY2Vzc2liaWxpdHkgQVBJcywgTlNXb3Jrc3BhY2UsIGFuZCBDR1dpbmRvd0xpc3QuXG4gKlxuICogQXJjaGl0ZWN0dXJlOlxuICogIC0gU3dpZnQgQ0xJIChgc3dpZnQtY2xpL2ApIGhhbmRsZXMgYWxsIG1hY09TIEFQSSBjYWxsc1xuICogIC0gSlNPTiBwcm90b2NvbDogc3RkaW4gYHsgY29tbWFuZCwgcGFyYW1zIH1gIFx1MjE5MiBzdGRvdXQgYHsgc3VjY2VzcywgZGF0YT8sIGVycm9yPyB9YFxuICogIC0gVFMgZXh0ZW5zaW9uIGludm9rZXMgQ0xJIHBlci1jb21tYW5kIHZpYSBleGVjRmlsZVN5bmNcbiAqICAtIE10aW1lLWJhc2VkIGNvbXBpbGF0aW9uIGNhY2hpbmc6IHJlY29tcGlsZXMgb25seSB3aGVuIHNvdXJjZSBmaWxlcyBjaGFuZ2VcbiAqICAtIEFsbCBTd2lmdCBkZWJ1ZyBvdXRwdXQgZ29lcyB0byBzdGRlcnI7IG9ubHkgSlNPTiBvbiBzdGRvdXRcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgU3RyaW5nRW51bSB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgeyBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBzdGF0U3luYywgcmVhZGRpclN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFBhdGhzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuY29uc3QgRVhURU5TSU9OX0RJUiA9IHBhdGguZGlybmFtZShuZXcgVVJMKGltcG9ydC5tZXRhLnVybCkucGF0aG5hbWUpO1xuY29uc3QgU1dJRlRfQ0xJX0RJUiA9IHBhdGguam9pbihFWFRFTlNJT05fRElSLCBcInN3aWZ0LWNsaVwiKTtcbmNvbnN0IFNPVVJDRVNfRElSID0gcGF0aC5qb2luKFNXSUZUX0NMSV9ESVIsIFwiU291cmNlc1wiKTtcbmNvbnN0IEJJTkFSWV9QQVRIID0gcGF0aC5qb2luKFNXSUZUX0NMSV9ESVIsIFwiLmJ1aWxkXCIsIFwicmVsZWFzZVwiLCBcIm1hYy1hZ2VudFwiKTtcbmNvbnN0IFBBQ0tBR0VfU1dJRlQgPSBwYXRoLmpvaW4oU1dJRlRfQ0xJX0RJUiwgXCJQYWNrYWdlLnN3aWZ0XCIpO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIENvbXBpbGF0aW9uIGNhY2hpbmdcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogR2V0IHRoZSBsYXRlc3QgbXRpbWUgKG1zKSBhY3Jvc3MgYWxsIFN3aWZ0IHNvdXJjZSBmaWxlcyBhbmQgUGFja2FnZS5zd2lmdC4gKi9cbmZ1bmN0aW9uIGdldFNvdXJjZU10aW1lKCk6IG51bWJlciB7XG5cdGxldCBsYXRlc3QgPSAwO1xuXHQvLyBDaGVjayBQYWNrYWdlLnN3aWZ0XG5cdHRyeSB7XG5cdFx0bGF0ZXN0ID0gTWF0aC5tYXgobGF0ZXN0LCBzdGF0U3luYyhQQUNLQUdFX1NXSUZUKS5tdGltZU1zKTtcblx0fSBjYXRjaCB7fVxuXHQvLyBDaGVjayBhbGwgZmlsZXMgaW4gU291cmNlcy9cblx0dHJ5IHtcblx0XHRjb25zdCBmaWxlcyA9IHJlYWRkaXJTeW5jKFNPVVJDRVNfRElSKTtcblx0XHRmb3IgKGNvbnN0IGYgb2YgZmlsZXMpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IG10ID0gc3RhdFN5bmMocGF0aC5qb2luKFNPVVJDRVNfRElSLCBmKSkubXRpbWVNcztcblx0XHRcdFx0aWYgKG10ID4gbGF0ZXN0KSBsYXRlc3QgPSBtdDtcblx0XHRcdH0gY2F0Y2gge31cblx0XHR9XG5cdH0gY2F0Y2gge31cblx0cmV0dXJuIGxhdGVzdDtcbn1cblxuLyoqIEdldCB0aGUgYmluYXJ5IG10aW1lIChtcyksIG9yIDAgaWYgaXQgZG9lc24ndCBleGlzdC4gKi9cbmZ1bmN0aW9uIGdldEJpbmFyeU10aW1lKCk6IG51bWJlciB7XG5cdHRyeSB7XG5cdFx0cmV0dXJuIHN0YXRTeW5jKEJJTkFSWV9QQVRIKS5tdGltZU1zO1xuXHR9IGNhdGNoIHtcblx0XHRyZXR1cm4gMDtcblx0fVxufVxuXG4vKiogQ29tcGlsZSB0aGUgU3dpZnQgQ0xJIGlmIHNvdXJjZSBmaWxlcyBhcmUgbmV3ZXIgdGhhbiB0aGUgYmluYXJ5LiAqL1xuZnVuY3Rpb24gZW5zdXJlQ29tcGlsZWQoKTogdm9pZCB7XG5cdGNvbnN0IHNyY010aW1lID0gZ2V0U291cmNlTXRpbWUoKTtcblx0Y29uc3QgYmluTXRpbWUgPSBnZXRCaW5hcnlNdGltZSgpO1xuXG5cdGlmIChiaW5NdGltZSA+IDAgJiYgYmluTXRpbWUgPj0gc3JjTXRpbWUpIHtcblx0XHRyZXR1cm47IC8vIEJpbmFyeSBpcyB1cC10by1kYXRlXG5cdH1cblxuXHRjb25zdCBhY3Rpb24gPSBiaW5NdGltZSA9PT0gMCA/IFwiQ29tcGlsaW5nXCIgOiBcIlJlY29tcGlsaW5nXCI7XG5cdHRyeSB7XG5cdFx0ZXhlY0ZpbGVTeW5jKFwic3dpZnRcIiwgW1wiYnVpbGRcIiwgXCItY1wiLCBcInJlbGVhc2VcIl0sIHtcblx0XHRcdGN3ZDogU1dJRlRfQ0xJX0RJUixcblx0XHRcdHRpbWVvdXQ6IDMwXzAwMCxcblx0XHRcdHN0ZGlvOiBbXCJwaXBlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG5cdFx0fSk7XG5cdH0gY2F0Y2ggKGVycjogYW55KSB7XG5cdFx0Y29uc3Qgc3RkZXJyID0gZXJyLnN0ZGVycj8udG9TdHJpbmcoKSB8fCBcIlwiO1xuXHRcdGNvbnN0IHN0ZG91dCA9IGVyci5zdGRvdXQ/LnRvU3RyaW5nKCkgfHwgXCJcIjtcblx0XHR0aHJvdyBuZXcgRXJyb3IoXG5cdFx0XHRgU3dpZnQgY29tcGlsYXRpb24gZmFpbGVkICgke2FjdGlvbi50b0xvd2VyQ2FzZSgpfSk6XFxuJHtzdGRlcnIgfHwgc3Rkb3V0IHx8IGVyci5tZXNzYWdlfWBcblx0XHQpO1xuXHR9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQ0xJIGludm9jYXRpb25cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5pbnRlcmZhY2UgTWFjQWdlbnRSZXNwb25zZSB7XG5cdHN1Y2Nlc3M6IGJvb2xlYW47XG5cdGRhdGE/OiBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuXHRlcnJvcj86IHN0cmluZztcbn1cblxuLyoqXG4gKiBJbnZva2UgdGhlIG1hYy1hZ2VudCBDTEkgd2l0aCBhIGNvbW1hbmQgYW5kIG9wdGlvbmFsIHBhcmFtcy5cbiAqIEhhbmRsZXMgY29tcGlsYXRpb24gY2FjaGluZywgc3RkaW4vc3Rkb3V0IEpTT04gcHJvdG9jb2wsIGFuZCBlcnJvciBzdXJmYWNpbmcuXG4gKi9cbmZ1bmN0aW9uIGV4ZWNNYWNBZ2VudChjb21tYW5kOiBzdHJpbmcsIHBhcmFtcz86IFJlY29yZDxzdHJpbmcsIGFueT4pOiBNYWNBZ2VudFJlc3BvbnNlIHtcblx0ZW5zdXJlQ29tcGlsZWQoKTtcblxuXHRjb25zdCBpbnB1dCA9IEpTT04uc3RyaW5naWZ5KHsgY29tbWFuZCwgcGFyYW1zOiBwYXJhbXMgPz8ge30gfSk7XG5cdGxldCBzdGRvdXQ6IHN0cmluZztcblx0bGV0IHN0ZGVycjogc3RyaW5nID0gXCJcIjtcblxuXHQvLyBJbnRlcmFjdGlvbiBjb21tYW5kcyAoY2xpY2ssIHR5cGUpIGNhbiBibG9jayB3aGlsZSB0aGUgdGFyZ2V0IGFwcFxuXHQvLyBwcm9jZXNzZXMgdGhlIGFjdGlvbiBcdTIwMTQgZS5nLiBUZXh0RWRpdCdzIEFYUHJlc3Mgb24gXCJOZXcgRG9jdW1lbnRcIlxuXHQvLyB0YWtlcyB+MTJzIHdoaWxlIGl0IGRpc21pc3NlcyB0aGUgT3BlbiBkaWFsb2cgYW5kIGNyZWF0ZXMgYSB3aW5kb3cuXG5cdC8vIFNjcmVlbnNob3RzIGNhbiBhbHNvIGJlIHNsb3cgZm9yIGxhcmdlIHJldGluYSB3aW5kb3dzLlxuXHRjb25zdCBzbG93Q29tbWFuZHMgPSBuZXcgU2V0KFtcImNsaWNrRWxlbWVudFwiLCBcInR5cGVUZXh0XCIsIFwic2NyZWVuc2hvdFdpbmRvd1wiXSk7XG5cdGNvbnN0IHRpbWVvdXQgPSBzbG93Q29tbWFuZHMuaGFzKGNvbW1hbmQpID8gMzBfMDAwIDogMTBfMDAwO1xuXG5cdHRyeSB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gZXhlY0ZpbGVTeW5jKEJJTkFSWV9QQVRILCBbXSwge1xuXHRcdFx0aW5wdXQsXG5cdFx0XHR0aW1lb3V0LFxuXHRcdFx0ZW5jb2Rpbmc6IFwidXRmLThcIixcblx0XHRcdHN0ZGlvOiBbXCJwaXBlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG5cdFx0XHRtYXhCdWZmZXI6IDUgKiAxMDI0ICogMTAyNCwgLy8gNU1CIFx1MjAxNCBuZWVkZWQgZm9yIHJldGluYSBzY3JlZW5zaG90IGJhc2U2NCBwYXlsb2Fkc1xuXHRcdH0pO1xuXHRcdHN0ZG91dCA9IHR5cGVvZiByZXN1bHQgPT09IFwic3RyaW5nXCIgPyByZXN1bHQgOiBTdHJpbmcocmVzdWx0KTtcblx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRzdGRlcnIgPSBlcnIuc3RkZXJyPy50b1N0cmluZygpIHx8IFwiXCI7XG5cdFx0Y29uc3QgaXNUaW1lb3V0ID0gZXJyLmtpbGxlZCB8fCBlcnIuc2lnbmFsID09PSBcIlNJR1RFUk1cIjtcblx0XHQvLyBJZiB0aGUgcHJvY2VzcyBleGl0ZWQgbm9uLXplcm8gYnV0IHByb2R1Y2VkIHN0ZG91dCwgdHJ5IHRvIHBhcnNlIGl0XG5cdFx0aWYgKGVyci5zdGRvdXQpIHtcblx0XHRcdHN0ZG91dCA9IGVyci5zdGRvdXQudG9TdHJpbmcoKTtcblx0XHR9IGVsc2UgaWYgKGlzVGltZW91dCkge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKFxuXHRcdFx0XHRgbWFjLWFnZW50IHRpbWVkIG91dCBhZnRlciAke3RpbWVvdXQgLyAxMDAwfXMgKGNvbW1hbmQ6ICR7Y29tbWFuZH0pLiBgICtcblx0XHRcdFx0YFRoZSB0YXJnZXQgYXBwIG1heSBiZSBzbG93IHRvIHJlc3BvbmQgXHUyMDE0IEFYUHJlc3MgY2FuIGJsb2NrIHdoaWxlIHRoZSBhcHAgcHJvY2Vzc2VzIHRoZSBhY3Rpb24uYFxuXHRcdFx0KTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKFxuXHRcdFx0XHRgbWFjLWFnZW50IENMSSBmYWlsZWQgKGNvbW1hbmQ6ICR7Y29tbWFuZH0pOlxcbiR7c3RkZXJyIHx8IGVyci5tZXNzYWdlfWBcblx0XHRcdCk7XG5cdFx0fVxuXHR9XG5cblx0dHJ5IHtcblx0XHRyZXR1cm4gSlNPTi5wYXJzZShzdGRvdXQudHJpbSgpKSBhcyBNYWNBZ2VudFJlc3BvbnNlO1xuXHR9IGNhdGNoIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoXG5cdFx0XHRgbWFjLWFnZW50IHJldHVybmVkIGludmFsaWQgSlNPTiAoY29tbWFuZDogJHtjb21tYW5kfSk6XFxuc3Rkb3V0OiAke3N0ZG91dH1cXG5zdGRlcnI6ICR7c3RkZXJyfWBcblx0XHQpO1xuXHR9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRXh0ZW5zaW9uIGVudHJ5IHBvaW50XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gKHBpOiBFeHRlbnNpb25BUEkpIHtcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gbWFjX2NoZWNrX3Blcm1pc3Npb25zXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJtYWNfY2hlY2tfcGVybWlzc2lvbnNcIixcblx0XHRsYWJlbDogXCJNYWMgUGVybWlzc2lvbnNcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiQ2hlY2sgd2hldGhlciBtYWNPUyBBY2Nlc3NpYmlsaXR5IGFuZCBTY3JlZW4gUmVjb3JkaW5nIHBlcm1pc3Npb25zIGFyZSBlbmFibGVkIGZvciB0aGUgY3VycmVudCB0ZXJtaW5hbC4gXCIgK1xuXHRcdFx0XCJSZXR1cm5zIHsgYWNjZXNzaWJpbGl0eUVuYWJsZWQsIHNjcmVlblJlY29yZGluZ0VuYWJsZWQgfS4gQWNjZXNzaWJpbGl0eSBpcyByZXF1aXJlZCBmb3IgVUkgYXV0b21hdGlvbjsgXCIgK1xuXHRcdFx0XCJTY3JlZW4gUmVjb3JkaW5nIGlzIHJlcXVpcmVkIGZvciBtYWNfc2NyZWVuc2hvdC4gQm90aCBhcmUgZ3JhbnRlZCBpbiBTeXN0ZW0gU2V0dGluZ3MgPiBQcml2YWN5ICYgU2VjdXJpdHkuXCIsXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJSdW4gdGhpcyBmaXJzdCBpZiBhbnkgbWFjIHRvb2wgcmV0dXJucyBhIHBlcm1pc3Npb24gZXJyb3IuXCIsXG5cdFx0XSxcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkOiBhbnkpIHtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGV4ZWNNYWNBZ2VudChcImNoZWNrUGVybWlzc2lvbnNcIik7XG5cdFx0XHRpZiAoIXJlc3VsdC5zdWNjZXNzKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIm1hY19jaGVja19wZXJtaXNzaW9uczogXCIgKyByZXN1bHQuZXJyb3IpO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgYWNjZXNzaWJpbGl0eSA9IHJlc3VsdC5kYXRhPy5hY2Nlc3NpYmlsaXR5RW5hYmxlZCA/PyBmYWxzZTtcblx0XHRcdGNvbnN0IHNjcmVlblJlY29yZGluZyA9IHJlc3VsdC5kYXRhPy5zY3JlZW5SZWNvcmRpbmdFbmFibGVkID8/IGZhbHNlO1xuXG5cdFx0XHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblx0XHRcdGxpbmVzLnB1c2goYWNjZXNzaWJpbGl0eVxuXHRcdFx0XHQ/IFwiXHUyNzA1IEFjY2Vzc2liaWxpdHk6IGVuYWJsZWRcIlxuXHRcdFx0XHQ6IFwiXHUyNzRDIEFjY2Vzc2liaWxpdHk6IE5PVCBlbmFibGVkIFx1MjAxNCBncmFudCBpbiBTeXN0ZW0gU2V0dGluZ3MgPiBQcml2YWN5ICYgU2VjdXJpdHkgPiBBY2Nlc3NpYmlsaXR5XCIpO1xuXHRcdFx0bGluZXMucHVzaChzY3JlZW5SZWNvcmRpbmdcblx0XHRcdFx0PyBcIlx1MjcwNSBTY3JlZW4gUmVjb3JkaW5nOiBlbmFibGVkXCJcblx0XHRcdFx0OiBcIlx1Mjc0QyBTY3JlZW4gUmVjb3JkaW5nOiBOT1QgZW5hYmxlZCBcdTIwMTQgZ3JhbnQgaW4gU3lzdGVtIFNldHRpbmdzID4gUHJpdmFjeSAmIFNlY3VyaXR5ID4gU2NyZWVuIFJlY29yZGluZ1wiKTtcblxuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGxpbmVzLmpvaW4oXCJcXG5cIikgfV0sXG5cdFx0XHRcdGRldGFpbHM6IHJlc3VsdC5kYXRhLFxuXHRcdFx0fTtcblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBtYWNfbGlzdF9hcHBzXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJtYWNfbGlzdF9hcHBzXCIsXG5cdFx0bGFiZWw6IFwiTGlzdCBBcHBzXCIsXG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcIkxpc3QgYWxsIHJ1bm5pbmcgbWFjT1MgYXBwbGljYXRpb25zLiBSZXR1cm5zIGFuIGFycmF5IG9mIHsgbmFtZSwgYnVuZGxlSWQsIHBpZCwgaXNBY3RpdmUgfSBcIiArXG5cdFx0XHRcImZvciB1c2VyLWZhY2luZyBhcHBzIChyZWd1bGFyIGFjdGl2YXRpb24gcG9saWN5KS4gU2V0IGluY2x1ZGVCYWNrZ3JvdW5kIHRvIHRydWUgdG8gYWxzbyBcIiArXG5cdFx0XHRcImluY2x1ZGUgYWNjZXNzb3J5L2JhY2tncm91bmQgYXBwcy5cIixcblx0XHRwcm9tcHRHdWlkZWxpbmVzOiBbXG5cdFx0XHRcIlVzZSB0byBkaXNjb3ZlciB3aGF0IGFwcHMgYXJlIHJ1bm5pbmcgYmVmb3JlIGludGVyYWN0aW5nIHdpdGggdGhlbS5cIixcblx0XHRdLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdGluY2x1ZGVCYWNrZ3JvdW5kOiBUeXBlLk9wdGlvbmFsKFR5cGUuQm9vbGVhbih7IGRlc2NyaXB0aW9uOiBcIkluY2x1ZGUgYmFja2dyb3VuZC9hY2Nlc3NvcnkgYXBwcyAoZGVmYXVsdDogZmFsc2UpXCIgfSkpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZDogYW55LCB7IGluY2x1ZGVCYWNrZ3JvdW5kIH06IHsgaW5jbHVkZUJhY2tncm91bmQ/OiBib29sZWFuIH0pIHtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGV4ZWNNYWNBZ2VudChcImxpc3RBcHBzXCIsIGluY2x1ZGVCYWNrZ3JvdW5kID8geyBpbmNsdWRlQmFja2dyb3VuZDogdHJ1ZSB9IDogdW5kZWZpbmVkKTtcblx0XHRcdGlmICghcmVzdWx0LnN1Y2Nlc3MpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwibWFjX2xpc3RfYXBwczogXCIgKyByZXN1bHQuZXJyb3IpO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgYXBwcyA9IHJlc3VsdC5kYXRhIGFzIHVua25vd24gYXMgQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGJ1bmRsZUlkOiBzdHJpbmc7IHBpZDogbnVtYmVyOyBpc0FjdGl2ZTogYm9vbGVhbiB9Pjtcblx0XHRcdGNvbnN0IHN1bW1hcnkgPSBhcHBzLm1hcChhID0+IGAke2EubmFtZX0gKCR7YS5idW5kbGVJZH0pIHBpZDoke2EucGlkfSR7YS5pc0FjdGl2ZSA/IFwiIFthY3RpdmVdXCIgOiBcIlwifWApLmpvaW4oXCJcXG5cIik7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYCR7YXBwcy5sZW5ndGh9IHJ1bm5pbmcgYXBwczpcXG4ke3N1bW1hcnl9YCB9XSxcblx0XHRcdFx0ZGV0YWlsczogeyBhcHBzIH0sXG5cdFx0XHR9O1xuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIG1hY19sYXVuY2hfYXBwXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJtYWNfbGF1bmNoX2FwcFwiLFxuXHRcdGxhYmVsOiBcIkxhdW5jaCBBcHBcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiTGF1bmNoIGEgbWFjT1MgYXBwbGljYXRpb24gYnkgbmFtZSBvciBidW5kbGUgSUQuIFwiICtcblx0XHRcdFwiUmV0dXJucyB7IGxhdW5jaGVkLCBuYW1lLCBidW5kbGVJZCwgcGlkIH0gb24gc3VjY2Vzcy4gXCIgK1xuXHRcdFx0XCJQcm92aWRlIGVpdGhlciAnbmFtZScgKGUuZy4gJ1RleHRFZGl0Jykgb3IgJ2J1bmRsZUlkJyAoZS5nLiAnY29tLmFwcGxlLlRleHRFZGl0JykuXCIsXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJVc2UgYXBwIG5hbWUgZm9yIHdlbGwta25vd24gYXBwczsgdXNlIGJ1bmRsZUlkIHdoZW4gdGhlIG5hbWUgaXMgYW1iaWd1b3VzLlwiLFxuXHRcdF0sXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0bmFtZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkFwcGxpY2F0aW9uIG5hbWUgKGUuZy4gJ1RleHRFZGl0JywgJ1NhZmFyaScpXCIgfSkpLFxuXHRcdFx0YnVuZGxlSWQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJCdW5kbGUgaWRlbnRpZmllciAoZS5nLiAnY29tLmFwcGxlLlRleHRFZGl0JylcIiB9KSksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkOiBhbnksIHsgbmFtZSwgYnVuZGxlSWQgfTogeyBuYW1lPzogc3RyaW5nOyBidW5kbGVJZD86IHN0cmluZyB9KSB7XG5cdFx0XHRpZiAoIW5hbWUgJiYgIWJ1bmRsZUlkKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIm1hY19sYXVuY2hfYXBwOiBwcm92aWRlIGVpdGhlciAnbmFtZScgb3IgJ2J1bmRsZUlkJyBwYXJhbWV0ZXJcIik7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcblx0XHRcdGlmIChuYW1lKSBwYXJhbXMubmFtZSA9IG5hbWU7XG5cdFx0XHRpZiAoYnVuZGxlSWQpIHBhcmFtcy5idW5kbGVJZCA9IGJ1bmRsZUlkO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBleGVjTWFjQWdlbnQoXCJsYXVuY2hBcHBcIiwgcGFyYW1zKTtcblx0XHRcdGlmICghcmVzdWx0LnN1Y2Nlc3MpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwibWFjX2xhdW5jaF9hcHA6IFwiICsgcmVzdWx0LmVycm9yKTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGQgPSByZXN1bHQuZGF0YSE7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYExhdW5jaGVkICR7ZC5uYW1lfSAoJHtkLmJ1bmRsZUlkfSkgcGlkOiR7ZC5waWR9YCB9XSxcblx0XHRcdFx0ZGV0YWlsczogcmVzdWx0LmRhdGEsXG5cdFx0XHR9O1xuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIG1hY19hY3RpdmF0ZV9hcHBcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcIm1hY19hY3RpdmF0ZV9hcHBcIixcblx0XHRsYWJlbDogXCJBY3RpdmF0ZSBBcHBcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiQnJpbmcgYSBydW5uaW5nIG1hY09TIGFwcGxpY2F0aW9uIHRvIHRoZSBmcm9udC4gXCIgK1xuXHRcdFx0XCJSZXR1cm5zIHsgYWN0aXZhdGVkLCBuYW1lIH0gb24gc3VjY2Vzcy4gRXJyb3JzIGlmIHRoZSBhcHAgaXMgbm90IHJ1bm5pbmcuIFwiICtcblx0XHRcdFwiUHJvdmlkZSBlaXRoZXIgJ25hbWUnIG9yICdidW5kbGVJZCcuXCIsXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJBY3RpdmF0ZSBhbiBhcHAgYmVmb3JlIGludGVyYWN0aW5nIHdpdGggaXRzIFVJIHRvIGVuc3VyZSBpdCBpcyBmcm9udG1vc3QuXCIsXG5cdFx0XSxcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRuYW1lOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQXBwbGljYXRpb24gbmFtZVwiIH0pKSxcblx0XHRcdGJ1bmRsZUlkOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQnVuZGxlIGlkZW50aWZpZXJcIiB9KSksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkOiBhbnksIHsgbmFtZSwgYnVuZGxlSWQgfTogeyBuYW1lPzogc3RyaW5nOyBidW5kbGVJZD86IHN0cmluZyB9KSB7XG5cdFx0XHRpZiAoIW5hbWUgJiYgIWJ1bmRsZUlkKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIm1hY19hY3RpdmF0ZV9hcHA6IHByb3ZpZGUgZWl0aGVyICduYW1lJyBvciAnYnVuZGxlSWQnIHBhcmFtZXRlclwiKTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IHBhcmFtczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuXHRcdFx0aWYgKG5hbWUpIHBhcmFtcy5uYW1lID0gbmFtZTtcblx0XHRcdGlmIChidW5kbGVJZCkgcGFyYW1zLmJ1bmRsZUlkID0gYnVuZGxlSWQ7XG5cblx0XHRcdGNvbnN0IHJlc3VsdCA9IGV4ZWNNYWNBZ2VudChcImFjdGl2YXRlQXBwXCIsIHBhcmFtcyk7XG5cdFx0XHRpZiAoIXJlc3VsdC5zdWNjZXNzKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIm1hY19hY3RpdmF0ZV9hcHA6IFwiICsgcmVzdWx0LmVycm9yKTtcblx0XHRcdH1cblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgQWN0aXZhdGVkICR7cmVzdWx0LmRhdGE/Lm5hbWV9YCB9XSxcblx0XHRcdFx0ZGV0YWlsczogcmVzdWx0LmRhdGEsXG5cdFx0XHR9O1xuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIG1hY19xdWl0X2FwcFxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwibWFjX3F1aXRfYXBwXCIsXG5cdFx0bGFiZWw6IFwiUXVpdCBBcHBcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiUXVpdCBhIHJ1bm5pbmcgbWFjT1MgYXBwbGljYXRpb24uIFwiICtcblx0XHRcdFwiUmV0dXJucyB7IHF1aXQsIG5hbWUgfSBvbiBzdWNjZXNzLiBFcnJvcnMgaWYgdGhlIGFwcCBpcyBub3QgcnVubmluZy4gXCIgK1xuXHRcdFx0XCJQcm92aWRlIGVpdGhlciAnbmFtZScgb3IgJ2J1bmRsZUlkJy5cIixcblx0XHRwcm9tcHRHdWlkZWxpbmVzOiBbXG5cdFx0XHRcIlVzZSB0byBjbGVhbiB1cCBhcHBzIGxhdW5jaGVkIGR1cmluZyBhdXRvbWF0aW9uIFx1MjAxNCBkb24ndCBsZWF2ZSBhcHBzIHJ1bm5pbmcgdW5uZWNlc3NhcmlseS5cIixcblx0XHRdLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdG5hbWU6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJBcHBsaWNhdGlvbiBuYW1lXCIgfSkpLFxuXHRcdFx0YnVuZGxlSWQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJCdW5kbGUgaWRlbnRpZmllclwiIH0pKSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQ6IGFueSwgeyBuYW1lLCBidW5kbGVJZCB9OiB7IG5hbWU/OiBzdHJpbmc7IGJ1bmRsZUlkPzogc3RyaW5nIH0pIHtcblx0XHRcdGlmICghbmFtZSAmJiAhYnVuZGxlSWQpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwibWFjX3F1aXRfYXBwOiBwcm92aWRlIGVpdGhlciAnbmFtZScgb3IgJ2J1bmRsZUlkJyBwYXJhbWV0ZXJcIik7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcblx0XHRcdGlmIChuYW1lKSBwYXJhbXMubmFtZSA9IG5hbWU7XG5cdFx0XHRpZiAoYnVuZGxlSWQpIHBhcmFtcy5idW5kbGVJZCA9IGJ1bmRsZUlkO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBleGVjTWFjQWdlbnQoXCJxdWl0QXBwXCIsIHBhcmFtcyk7XG5cdFx0XHRpZiAoIXJlc3VsdC5zdWNjZXNzKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIm1hY19xdWl0X2FwcDogXCIgKyByZXN1bHQuZXJyb3IpO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBRdWl0ICR7cmVzdWx0LmRhdGE/Lm5hbWV9YCB9XSxcblx0XHRcdFx0ZGV0YWlsczogcmVzdWx0LmRhdGEsXG5cdFx0XHR9O1xuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIG1hY19saXN0X3dpbmRvd3Ncblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcIm1hY19saXN0X3dpbmRvd3NcIixcblx0XHRsYWJlbDogXCJMaXN0IFdpbmRvd3NcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiTGlzdCBhbGwgb24tc2NyZWVuIHdpbmRvd3MgZm9yIGEgbWFjT1MgYXBwbGljYXRpb24uIFwiICtcblx0XHRcdFwiUmV0dXJucyBhbiBhcnJheSBvZiB7IHdpbmRvd0lkLCB0aXRsZSwgYm91bmRzOiB7eCx5LHdpZHRoLGhlaWdodH0sIGlzT25TY3JlZW4sIGxheWVyIH0uIFwiICtcblx0XHRcdFwiVGhlIHdpbmRvd0lkIGNhbiBiZSB1c2VkIHdpdGggZ2V0V2luZG93SW5mbyBmb3IgZGV0YWlsZWQgaW5zcGVjdGlvbiBvciB3aXRoIHNjcmVlbnNob3RXaW5kb3cgZm9yIGNhcHR1cmUuIFwiICtcblx0XHRcdFwiUmV0dXJucyBhbiBlbXB0eSBhcnJheSAobm90IGVycm9yKSBpZiB0aGUgYXBwIGlzIHJ1bm5pbmcgYnV0IGhhcyBubyB2aXNpYmxlIHdpbmRvd3MuIFwiICtcblx0XHRcdFwiRXJyb3JzIGlmIHRoZSBhcHAgaXMgbm90IHJ1bm5pbmcuXCIsXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJVc2UgdG8gZ2V0IHdpbmRvd0lkIHZhbHVlcyBuZWVkZWQgYnkgbWFjX3NjcmVlbnNob3QuXCIsXG5cdFx0XSxcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRhcHA6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQXBwbGljYXRpb24gbmFtZSAoZS5nLiAnVGV4dEVkaXQnKSBvciBidW5kbGUgaWRlbnRpZmllciAoZS5nLiAnY29tLmFwcGxlLlRleHRFZGl0JylcIiB9KSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQ6IGFueSwgeyBhcHAgfTogeyBhcHA6IHN0cmluZyB9KSB7XG5cdFx0XHRjb25zdCByZXN1bHQgPSBleGVjTWFjQWdlbnQoXCJsaXN0V2luZG93c1wiLCB7IGFwcCB9KTtcblx0XHRcdGlmICghcmVzdWx0LnN1Y2Nlc3MpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwibWFjX2xpc3Rfd2luZG93czogXCIgKyByZXN1bHQuZXJyb3IpO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgZGF0YSA9IHJlc3VsdC5kYXRhIGFzIHsgd2luZG93czogQXJyYXk8eyB3aW5kb3dJZDogbnVtYmVyOyB0aXRsZTogc3RyaW5nOyBib3VuZHM6IFJlY29yZDxzdHJpbmcsIG51bWJlcj47IGlzT25TY3JlZW46IGJvb2xlYW47IGxheWVyOiBudW1iZXIgfT47IGFwcDogc3RyaW5nOyBwaWQ6IG51bWJlciB9O1xuXHRcdFx0Y29uc3Qgd2luZG93cyA9IGRhdGEud2luZG93cyA/PyBbXTtcblx0XHRcdGlmICh3aW5kb3dzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgJHtkYXRhLmFwcH0gKHBpZDoke2RhdGEucGlkfSkgaGFzIG5vIHZpc2libGUgd2luZG93cy5gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IGRhdGEsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBzdW1tYXJ5ID0gd2luZG93cy5tYXAodyA9PlxuXHRcdFx0XHRgICB3aW5kb3dJZDoke3cud2luZG93SWR9IFwiJHt3LnRpdGxlfVwiICR7dy5ib3VuZHMud2lkdGh9eCR7dy5ib3VuZHMuaGVpZ2h0fSBhdCAoJHt3LmJvdW5kcy54fSwke3cuYm91bmRzLnl9KSBsYXllcjoke3cubGF5ZXJ9YFxuXHRcdFx0KS5qb2luKFwiXFxuXCIpO1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGAke2RhdGEuYXBwfSAocGlkOiR7ZGF0YS5waWR9KSBcdTIwMTQgJHt3aW5kb3dzLmxlbmd0aH0gd2luZG93KHMpOlxcbiR7c3VtbWFyeX1gIH1dLFxuXHRcdFx0XHRkZXRhaWxzOiBkYXRhLFxuXHRcdFx0fTtcblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBtYWNfZmluZFxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwibWFjX2ZpbmRcIixcblx0XHRsYWJlbDogXCJGaW5kIEVsZW1lbnRzXCIsXG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcIkZpbmQgVUkgZWxlbWVudHMgaW4gYSBtYWNPUyBhcHBsaWNhdGlvbidzIGFjY2Vzc2liaWxpdHkgdHJlZS4gVGhyZWUgbW9kZXM6XFxuXCIgK1xuXHRcdFx0XCItICdzZWFyY2gnIChkZWZhdWx0KTogRmluZCBlbGVtZW50cyBtYXRjaGluZyByb2xlL3RpdGxlL3ZhbHVlL2lkZW50aWZpZXIgY3JpdGVyaWEuIFJldHVybnMgYSBudW1iZXJlZCBsaXN0IG9mIG1hdGNoZXMuXFxuXCIgK1xuXHRcdFx0XCItICd0cmVlJzogRHVtcCB0aGUgZnVsbCBhY2Nlc3NpYmlsaXR5IHN1YnRyZWUgYXMgYW4gaW5kZW50ZWQgdHJlZS4gVXNlIG1heERlcHRoL21heENvdW50IHRvIGJvdW5kIG91dHB1dC5cXG5cIiArXG5cdFx0XHRcIi0gJ2ZvY3VzZWQnOiBHZXQgdGhlIGN1cnJlbnRseSBmb2N1c2VkIGVsZW1lbnQgaW4gdGhlIGFwcC4gTm8gY3JpdGVyaWEgbmVlZGVkLlxcblwiICtcblx0XHRcdFwiVGhlICdhcHAnIHBhcmFtIGFjY2VwdHMgYW4gYXBwIG5hbWUgKGUuZy4gJ0ZpbmRlcicpIG9yIGJ1bmRsZSBJRCAoZS5nLiAnY29tLmFwcGxlLkZpbmRlcicpLlwiLFxuXHRcdHByb21wdEd1aWRlbGluZXM6IFtcblx0XHRcdFwiUHJlZmVyIGZvciB0YXJnZXRlZCBlbGVtZW50IHNlYXJjaCBcdTIwMTQgdXNlIHJvbGUvdGl0bGUvdmFsdWUgY3JpdGVyaWEgdG8gbmFycm93IHJlc3VsdHMuXCIsXG5cdFx0XHRcIlVzZSBtb2RlOmZvY3VzZWQgdG8gY2hlY2sgdGhlIGN1cnJlbnQgZm9jdXMgdGFyZ2V0IHdpdGhvdXQgc2VhcmNoIGNyaXRlcmlhLlwiLFxuXHRcdFx0XCJVc2UgbWFjX2dldF90cmVlIGluc3RlYWQgb2YgbW9kZTp0cmVlIHdoZW4geW91IGp1c3QgbmVlZCB0byB1bmRlcnN0YW5kIGFwcCBzdHJ1Y3R1cmUuXCIsXG5cdFx0XSxcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRhcHA6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQXBwbGljYXRpb24gbmFtZSBvciBidW5kbGUgaWRlbnRpZmllclwiIH0pLFxuXHRcdFx0bW9kZTogVHlwZS5PcHRpb25hbChTdHJpbmdFbnVtKFtcInNlYXJjaFwiLCBcInRyZWVcIiwgXCJmb2N1c2VkXCJdIGFzIGNvbnN0LCB7IGRlc2NyaXB0aW9uOiBcIidzZWFyY2gnIChkZWZhdWx0KSwgJ3RyZWUnLCBvciAnZm9jdXNlZCdcIiB9KSksXG5cdFx0XHRyb2xlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQVggcm9sZSB0byBtYXRjaCAoZS5nLiAnQVhCdXR0b24nLCAnQVhUZXh0QXJlYScpXCIgfSkpLFxuXHRcdFx0dGl0bGU6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJBWCB0aXRsZSB0byBtYXRjaFwiIH0pKSxcblx0XHRcdHZhbHVlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQVggdmFsdWUgdG8gbWF0Y2hcIiB9KSksXG5cdFx0XHRpZGVudGlmaWVyOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQVggaWRlbnRpZmllciB0byBtYXRjaFwiIH0pKSxcblx0XHRcdG1hdGNoVHlwZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIidleGFjdCcgKGRlZmF1bHQpIG9yICdjb250YWlucydcIiB9KSksXG5cdFx0XHRtYXhEZXB0aDogVHlwZS5PcHRpb25hbChUeXBlLk51bWJlcih7IGRlc2NyaXB0aW9uOiBcIk1heGltdW0gdHJlZSBkZXB0aCB0byB0cmF2ZXJzZSAoZGVmYXVsdDogMTApXCIgfSkpLFxuXHRcdFx0bWF4Q291bnQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoeyBkZXNjcmlwdGlvbjogXCJNYXhpbXVtIGVsZW1lbnRzIHRvIHJldHVybi92aXNpdCAoZGVmYXVsdDogMTAwKVwiIH0pKSxcblx0XHR9KSxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQ6IGFueSwgYXJnczoge1xuXHRcdFx0YXBwOiBzdHJpbmc7XG5cdFx0XHRtb2RlPzogc3RyaW5nO1xuXHRcdFx0cm9sZT86IHN0cmluZztcblx0XHRcdHRpdGxlPzogc3RyaW5nO1xuXHRcdFx0dmFsdWU/OiBzdHJpbmc7XG5cdFx0XHRpZGVudGlmaWVyPzogc3RyaW5nO1xuXHRcdFx0bWF0Y2hUeXBlPzogc3RyaW5nO1xuXHRcdFx0bWF4RGVwdGg/OiBudW1iZXI7XG5cdFx0XHRtYXhDb3VudD86IG51bWJlcjtcblx0XHR9KSB7XG5cdFx0XHRjb25zdCBtb2RlID0gYXJncy5tb2RlID8/IFwic2VhcmNoXCI7XG5cblx0XHRcdC8vIC0tLSBGb2N1c2VkIG1vZGUgLS0tXG5cdFx0XHRpZiAobW9kZSA9PT0gXCJmb2N1c2VkXCIpIHtcblx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gZXhlY01hY0FnZW50KFwiZ2V0Rm9jdXNlZEVsZW1lbnRcIiwgeyBhcHA6IGFyZ3MuYXBwIH0pO1xuXHRcdFx0XHRpZiAoIXJlc3VsdC5zdWNjZXNzKSB7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwibWFjX2ZpbmQgKGZvY3VzZWQpOiBcIiArIHJlc3VsdC5lcnJvcik7XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgZWwgPSByZXN1bHQuZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuXHRcdFx0XHRjb25zdCBwYXJ0cyA9IFtlbC5yb2xlID8/IFwidW5rbm93blwiXTtcblx0XHRcdFx0aWYgKGVsLnRpdGxlKSBwYXJ0cy5wdXNoKGBcIiR7ZWwudGl0bGV9XCJgKTtcblx0XHRcdFx0aWYgKGVsLnZhbHVlICE9PSB1bmRlZmluZWQpIHBhcnRzLnB1c2goYFske2VsLnZhbHVlfV1gKTtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYEZvY3VzZWQgZWxlbWVudDogJHtwYXJ0cy5qb2luKFwiIFwiKX1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHJlc3VsdC5kYXRhLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyAtLS0gVHJlZSBtb2RlIC0tLVxuXHRcdFx0aWYgKG1vZGUgPT09IFwidHJlZVwiKSB7XG5cdFx0XHRcdGNvbnN0IHBhcmFtczogUmVjb3JkPHN0cmluZywgYW55PiA9IHsgYXBwOiBhcmdzLmFwcCB9O1xuXHRcdFx0XHRpZiAoYXJncy5tYXhEZXB0aCAhPT0gdW5kZWZpbmVkKSBwYXJhbXMubWF4RGVwdGggPSBhcmdzLm1heERlcHRoO1xuXHRcdFx0XHRpZiAoYXJncy5tYXhDb3VudCAhPT0gdW5kZWZpbmVkKSBwYXJhbXMubWF4Q291bnQgPSBhcmdzLm1heENvdW50O1xuXG5cdFx0XHRcdGNvbnN0IHJlc3VsdCA9IGV4ZWNNYWNBZ2VudChcImdldFRyZWVcIiwgcGFyYW1zKTtcblx0XHRcdFx0aWYgKCFyZXN1bHQuc3VjY2Vzcykge1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIm1hY19maW5kICh0cmVlKTogXCIgKyByZXN1bHQuZXJyb3IpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgZGF0YSA9IHJlc3VsdC5kYXRhIGFzIHsgdHJlZTogYW55W107IHRvdGFsRWxlbWVudHM6IG51bWJlcjsgdHJ1bmNhdGVkOiBib29sZWFuIH07XG5cdFx0XHRcdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdFx0XHRcdGZ1bmN0aW9uIHJlbmRlclRyZWUobm9kZXM6IGFueVtdLCBpbmRlbnQ6IG51bWJlcikge1xuXHRcdFx0XHRcdGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xuXHRcdFx0XHRcdFx0Y29uc3QgcGFydHMgPSBbbm9kZS5yb2xlID8/IFwiP1wiXTtcblx0XHRcdFx0XHRcdGlmIChub2RlLnRpdGxlKSBwYXJ0cy5wdXNoKGBcIiR7bm9kZS50aXRsZX1cImApO1xuXHRcdFx0XHRcdFx0aWYgKG5vZGUudmFsdWUgIT09IHVuZGVmaW5lZCAmJiBub2RlLnZhbHVlICE9PSBcIlwiKSBwYXJ0cy5wdXNoKGBbJHtub2RlLnZhbHVlfV1gKTtcblx0XHRcdFx0XHRcdGxpbmVzLnB1c2goXCIgIFwiLnJlcGVhdChpbmRlbnQpICsgcGFydHMuam9pbihcIiBcIikpO1xuXHRcdFx0XHRcdFx0aWYgKG5vZGUuY2hpbGRyZW4/Lmxlbmd0aCkge1xuXHRcdFx0XHRcdFx0XHRyZW5kZXJUcmVlKG5vZGUuY2hpbGRyZW4sIGluZGVudCArIDEpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdHJlbmRlclRyZWUoZGF0YS50cmVlID8/IFtdLCAwKTtcblx0XHRcdFx0Y29uc3QgdHJ1bmNOb3RlID0gZGF0YS50cnVuY2F0ZWQgPyBgXFxuKHRydW5jYXRlZCBcdTIwMTQgJHtkYXRhLnRvdGFsRWxlbWVudHN9IGVsZW1lbnRzIHZpc2l0ZWQpYCA6IFwiXCI7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGAke2xpbmVzLmpvaW4oXCJcXG5cIil9JHt0cnVuY05vdGV9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiByZXN1bHQuZGF0YSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gLS0tIFNlYXJjaCBtb2RlIChkZWZhdWx0KSAtLS1cblx0XHRcdGNvbnN0IHBhcmFtczogUmVjb3JkPHN0cmluZywgYW55PiA9IHsgYXBwOiBhcmdzLmFwcCB9O1xuXHRcdFx0aWYgKGFyZ3Mucm9sZSkgcGFyYW1zLnJvbGUgPSBhcmdzLnJvbGU7XG5cdFx0XHRpZiAoYXJncy50aXRsZSkgcGFyYW1zLnRpdGxlID0gYXJncy50aXRsZTtcblx0XHRcdGlmIChhcmdzLnZhbHVlKSBwYXJhbXMudmFsdWUgPSBhcmdzLnZhbHVlO1xuXHRcdFx0aWYgKGFyZ3MuaWRlbnRpZmllcikgcGFyYW1zLmlkZW50aWZpZXIgPSBhcmdzLmlkZW50aWZpZXI7XG5cdFx0XHRpZiAoYXJncy5tYXRjaFR5cGUpIHBhcmFtcy5tYXRjaFR5cGUgPSBhcmdzLm1hdGNoVHlwZTtcblx0XHRcdGlmIChhcmdzLm1heERlcHRoICE9PSB1bmRlZmluZWQpIHBhcmFtcy5tYXhEZXB0aCA9IGFyZ3MubWF4RGVwdGg7XG5cdFx0XHRpZiAoYXJncy5tYXhDb3VudCAhPT0gdW5kZWZpbmVkKSBwYXJhbXMubWF4Q291bnQgPSBhcmdzLm1heENvdW50O1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBleGVjTWFjQWdlbnQoXCJmaW5kRWxlbWVudHNcIiwgcGFyYW1zKTtcblx0XHRcdGlmICghcmVzdWx0LnN1Y2Nlc3MpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwibWFjX2ZpbmQgKHNlYXJjaCk6IFwiICsgcmVzdWx0LmVycm9yKTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgZGF0YSA9IHJlc3VsdC5kYXRhIGFzIHsgZWxlbWVudHM6IGFueVtdOyB0b3RhbFZpc2l0ZWQ6IG51bWJlcjsgdHJ1bmNhdGVkOiBib29sZWFuIH07XG5cdFx0XHRjb25zdCBlbGVtZW50cyA9IGRhdGEuZWxlbWVudHMgPz8gW107XG5cblx0XHRcdGlmIChlbGVtZW50cy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0Y29uc3QgY3JpdGVyaWEgPSBbYXJncy5yb2xlLCBhcmdzLnRpdGxlLCBhcmdzLnZhbHVlLCBhcmdzLmlkZW50aWZpZXJdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiLCBcIik7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBObyBlbGVtZW50cyBmb3VuZCBtYXRjaGluZzogJHtjcml0ZXJpYSB8fCBcIihubyBjcml0ZXJpYSlcIn1gIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHJlc3VsdC5kYXRhLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBsaW5lcyA9IGVsZW1lbnRzLm1hcCgoZWw6IGFueSwgaTogbnVtYmVyKSA9PiB7XG5cdFx0XHRcdGNvbnN0IHBhcnRzID0gW2Ake2kgKyAxfS4gJHtlbC5yb2xlID8/IFwiP1wifWBdO1xuXHRcdFx0XHRpZiAoZWwudGl0bGUpIHBhcnRzLnB1c2goYFwiJHtlbC50aXRsZX1cImApO1xuXHRcdFx0XHRpZiAoZWwudmFsdWUgIT09IHVuZGVmaW5lZCAmJiBlbC52YWx1ZSAhPT0gXCJcIikgcGFydHMucHVzaChgWyR7ZWwudmFsdWV9XWApO1xuXHRcdFx0XHRyZXR1cm4gcGFydHMuam9pbihcIiBcIik7XG5cdFx0XHR9KTtcblx0XHRcdGNvbnN0IHRydW5jTm90ZSA9IGRhdGEudHJ1bmNhdGVkID8gYFxcbih0cnVuY2F0ZWQgXHUyMDE0IHNlYXJjaCBzdG9wcGVkIGF0IGxpbWl0KWAgOiBcIlwiO1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGAke2VsZW1lbnRzLmxlbmd0aH0gZWxlbWVudChzKSBmb3VuZDpcXG4ke2xpbmVzLmpvaW4oXCJcXG5cIil9JHt0cnVuY05vdGV9YCB9XSxcblx0XHRcdFx0ZGV0YWlsczogcmVzdWx0LmRhdGEsXG5cdFx0XHR9O1xuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIG1hY19nZXRfdHJlZVxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwibWFjX2dldF90cmVlXCIsXG5cdFx0bGFiZWw6IFwiR2V0IFVJIFRyZWVcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiR2V0IGEgY29tcGFjdCBhY2Nlc3NpYmlsaXR5IHRyZWUgb2YgYSBtYWNPUyBhcHBsaWNhdGlvbidzIFVJIHN0cnVjdHVyZS4gXCIgK1xuXHRcdFx0XCJSZXR1cm5zIGFuIGluZGVudGVkIHRyZWUgc2hvd2luZyByb2xlLCB0aXRsZSwgYW5kIHZhbHVlIG9mIGVhY2ggZWxlbWVudC4gXCIgK1xuXHRcdFx0XCJUaWdodGVyIGRlZmF1bHRzIHRoYW4gbWFjX2ZpbmQncyB0cmVlIG1vZGUgXHUyMDE0IGRlc2lnbmVkIGZvciBxdWljayBzdHJ1Y3R1cmUgaW5zcGVjdGlvbi4gXCIgK1xuXHRcdFx0XCJFYWNoIGxpbmU6IGByb2xlIFxcXCJ0aXRsZVxcXCIgW3ZhbHVlXWAgd2l0aCAyLXNwYWNlIGluZGVudCBwZXIgZGVwdGggbGV2ZWwuIFwiICtcblx0XHRcdFwiT21pdHMgdGl0bGUvdmFsdWUgd2hlbiBuaWwgb3IgZW1wdHkuXCIsXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJVc2UgZm9yIHVuZGVyc3RhbmRpbmcgYXBwIFVJIHN0cnVjdHVyZSBcdTIwMTQgc3RhcnQgd2l0aCBsb3cgbGltaXRzIGFuZCBpbmNyZWFzZSBpZiBuZWVkZWQuXCIsXG5cdFx0XHRcIlByZWZlciBtYWNfZmluZCBzZWFyY2ggbW9kZSB3aGVuIHlvdSBrbm93IHdoYXQgeW91J3JlIGxvb2tpbmcgZm9yLlwiLFxuXHRcdFx0XCJDaGVjayB0aGUgdHJ1bmNhdGlvbiBub3RlIHRvIGtub3cgaWYgdGhlIHRyZWUgd2FzIGN1dCBzaG9ydC5cIixcblx0XHRdLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdGFwcDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJBcHBsaWNhdGlvbiBuYW1lIG9yIGJ1bmRsZSBpZGVudGlmaWVyXCIgfSksXG5cdFx0XHRtYXhEZXB0aDogVHlwZS5PcHRpb25hbChUeXBlLk51bWJlcih7IGRlc2NyaXB0aW9uOiBcIk1heGltdW0gdHJlZSBkZXB0aCB0byB0cmF2ZXJzZSAoZGVmYXVsdDogMylcIiB9KSksXG5cdFx0XHRtYXhDb3VudDogVHlwZS5PcHRpb25hbChUeXBlLk51bWJlcih7IGRlc2NyaXB0aW9uOiBcIk1heGltdW0gZWxlbWVudHMgdG8gaW5jbHVkZSAoZGVmYXVsdDogNTApXCIgfSkpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZDogYW55LCBhcmdzOiB7IGFwcDogc3RyaW5nOyBtYXhEZXB0aD86IG51bWJlcjsgbWF4Q291bnQ/OiBudW1iZXIgfSkge1xuXHRcdFx0Y29uc3QgcGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0geyBhcHA6IGFyZ3MuYXBwIH07XG5cdFx0XHRwYXJhbXMubWF4RGVwdGggPSBhcmdzLm1heERlcHRoID8/IDM7XG5cdFx0XHRwYXJhbXMubWF4Q291bnQgPSBhcmdzLm1heENvdW50ID8/IDUwO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBleGVjTWFjQWdlbnQoXCJnZXRUcmVlXCIsIHBhcmFtcyk7XG5cdFx0XHRpZiAoIXJlc3VsdC5zdWNjZXNzKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIm1hY19nZXRfdHJlZTogXCIgKyByZXN1bHQuZXJyb3IpO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBkYXRhID0gcmVzdWx0LmRhdGEgYXMgeyB0cmVlOiBhbnlbXTsgdG90YWxFbGVtZW50czogbnVtYmVyOyB0cnVuY2F0ZWQ6IGJvb2xlYW4gfTtcblx0XHRcdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdFx0XHRmdW5jdGlvbiByZW5kZXJOb2RlKG5vZGVzOiBhbnlbXSwgaW5kZW50OiBudW1iZXIpIHtcblx0XHRcdFx0Zm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XG5cdFx0XHRcdFx0Y29uc3QgcGFydHMgPSBbbm9kZS5yb2xlID8/IFwiP1wiXTtcblx0XHRcdFx0XHRpZiAobm9kZS50aXRsZSkgcGFydHMucHVzaChgXCIke25vZGUudGl0bGV9XCJgKTtcblx0XHRcdFx0XHRpZiAobm9kZS52YWx1ZSAhPT0gdW5kZWZpbmVkICYmIG5vZGUudmFsdWUgIT09IG51bGwgJiYgbm9kZS52YWx1ZSAhPT0gXCJcIikgcGFydHMucHVzaChgWyR7bm9kZS52YWx1ZX1dYCk7XG5cdFx0XHRcdFx0bGluZXMucHVzaChcIiAgXCIucmVwZWF0KGluZGVudCkgKyBwYXJ0cy5qb2luKFwiIFwiKSk7XG5cdFx0XHRcdFx0aWYgKG5vZGUuY2hpbGRyZW4/Lmxlbmd0aCkge1xuXHRcdFx0XHRcdFx0cmVuZGVyTm9kZShub2RlLmNoaWxkcmVuLCBpbmRlbnQgKyAxKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0cmVuZGVyTm9kZShkYXRhLnRyZWUgPz8gW10sIDApO1xuXHRcdFx0aWYgKGRhdGEudHJ1bmNhdGVkKSB7XG5cdFx0XHRcdGxpbmVzLnB1c2goYFxcbih0cnVuY2F0ZWQgXHUyMDE0ICR7ZGF0YS50b3RhbEVsZW1lbnRzfSBlbGVtZW50cyB2aXNpdGVkLCBpbmNyZWFzZSBtYXhEZXB0aCBvciBtYXhDb3VudCBmb3IgbW9yZSlgKTtcblx0XHRcdH1cblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBsaW5lcy5qb2luKFwiXFxuXCIpIH1dLFxuXHRcdFx0XHRkZXRhaWxzOiB7IHRvdGFsRWxlbWVudHM6IGRhdGEudG90YWxFbGVtZW50cywgdHJ1bmNhdGVkOiBkYXRhLnRydW5jYXRlZCB9LFxuXHRcdFx0fTtcblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBtYWNfY2xpY2tcblx0Ly8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcIm1hY19jbGlja1wiLFxuXHRcdGxhYmVsOiBcIkNsaWNrIEVsZW1lbnRcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiQ2xpY2sgYSBVSSBlbGVtZW50IGluIGEgbWFjT1MgYXBwbGljYXRpb24gYnkgcGVyZm9ybWluZyBBWFByZXNzLiBcIiArXG5cdFx0XHRcIkZpbmRzIHRoZSBmaXJzdCBlbGVtZW50IG1hdGNoaW5nIHRoZSBnaXZlbiBjcml0ZXJpYSAocm9sZSwgdGl0bGUsIHZhbHVlLCBpZGVudGlmaWVyKSBhbmQgY2xpY2tzIGl0LiBcIiArXG5cdFx0XHRcIkF0IGxlYXN0IG9uZSBjcml0ZXJpb24gaXMgcmVxdWlyZWQuIFJldHVybnMgdGhlIGNsaWNrZWQgZWxlbWVudCdzIGF0dHJpYnV0ZXMuXCIsXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJWZXJpZnkgdGhlIGNsaWNrIHdvcmtlZCBieSByZWFkaW5nIHRoZSByZXN1bHRpbmcgc3RhdGUgd2l0aCBtYWNfZmluZCBvciBtYWNfcmVhZC5cIixcblx0XHRcdFwiVXNlIG1hY19maW5kIGZpcnN0IHRvIGRpc2NvdmVyIHRoZSByaWdodCByb2xlL3RpdGxlL3ZhbHVlIGNyaXRlcmlhIGJlZm9yZSBjbGlja2luZy5cIixcblx0XHRdLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdGFwcDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJBcHBsaWNhdGlvbiBuYW1lIG9yIGJ1bmRsZSBpZGVudGlmaWVyXCIgfSksXG5cdFx0XHRyb2xlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQVggcm9sZSAoZS5nLiAnQVhCdXR0b24nLCAnQVhNZW51SXRlbScpXCIgfSkpLFxuXHRcdFx0dGl0bGU6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJBWCB0aXRsZSB0byBtYXRjaFwiIH0pKSxcblx0XHRcdHZhbHVlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQVggdmFsdWUgdG8gbWF0Y2hcIiB9KSksXG5cdFx0XHRpZGVudGlmaWVyOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQVggaWRlbnRpZmllciB0byBtYXRjaFwiIH0pKSxcblx0XHRcdG1hdGNoVHlwZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIidleGFjdCcgKGRlZmF1bHQpIG9yICdjb250YWlucydcIiB9KSksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkOiBhbnksIGFyZ3M6IHtcblx0XHRcdGFwcDogc3RyaW5nO1xuXHRcdFx0cm9sZT86IHN0cmluZztcblx0XHRcdHRpdGxlPzogc3RyaW5nO1xuXHRcdFx0dmFsdWU/OiBzdHJpbmc7XG5cdFx0XHRpZGVudGlmaWVyPzogc3RyaW5nO1xuXHRcdFx0bWF0Y2hUeXBlPzogc3RyaW5nO1xuXHRcdH0pIHtcblx0XHRcdGlmICghYXJncy5yb2xlICYmICFhcmdzLnRpdGxlICYmICFhcmdzLnZhbHVlICYmICFhcmdzLmlkZW50aWZpZXIpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwibWFjX2NsaWNrOiBwcm92aWRlIGF0IGxlYXN0IG9uZSBzZWFyY2ggY3JpdGVyaW9uIChyb2xlLCB0aXRsZSwgdmFsdWUsIG9yIGlkZW50aWZpZXIpXCIpO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgcGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0geyBhcHA6IGFyZ3MuYXBwIH07XG5cdFx0XHRpZiAoYXJncy5yb2xlKSBwYXJhbXMucm9sZSA9IGFyZ3Mucm9sZTtcblx0XHRcdGlmIChhcmdzLnRpdGxlKSBwYXJhbXMudGl0bGUgPSBhcmdzLnRpdGxlO1xuXHRcdFx0aWYgKGFyZ3MudmFsdWUpIHBhcmFtcy52YWx1ZSA9IGFyZ3MudmFsdWU7XG5cdFx0XHRpZiAoYXJncy5pZGVudGlmaWVyKSBwYXJhbXMuaWRlbnRpZmllciA9IGFyZ3MuaWRlbnRpZmllcjtcblx0XHRcdGlmIChhcmdzLm1hdGNoVHlwZSkgcGFyYW1zLm1hdGNoVHlwZSA9IGFyZ3MubWF0Y2hUeXBlO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBleGVjTWFjQWdlbnQoXCJjbGlja0VsZW1lbnRcIiwgcGFyYW1zKTtcblx0XHRcdGlmICghcmVzdWx0LnN1Y2Nlc3MpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwibWFjX2NsaWNrOiBcIiArIHJlc3VsdC5lcnJvcik7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGVsID0gcmVzdWx0LmRhdGE/LmVsZW1lbnQgYXMgUmVjb3JkPHN0cmluZywgYW55PiB8IHVuZGVmaW5lZDtcblx0XHRcdGNvbnN0IHBhcnRzID0gW2VsPy5yb2xlID8/IFwiZWxlbWVudFwiXTtcblx0XHRcdGlmIChlbD8udGl0bGUpIHBhcnRzLnB1c2goYCcke2VsLnRpdGxlfSdgKTtcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgQ2xpY2tlZCAke3BhcnRzLmpvaW4oXCIgXCIpfWAgfV0sXG5cdFx0XHRcdGRldGFpbHM6IHJlc3VsdC5kYXRhLFxuXHRcdFx0fTtcblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBtYWNfdHlwZVxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwibWFjX3R5cGVcIixcblx0XHRsYWJlbDogXCJUeXBlIFRleHRcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiVHlwZSB0ZXh0IGludG8gYSBVSSBlbGVtZW50IGluIGEgbWFjT1MgYXBwbGljYXRpb24gYnkgc2V0dGluZyBpdHMgQVhWYWx1ZSBhdHRyaWJ1dGUuIFwiICtcblx0XHRcdFwiRmluZHMgdGhlIGZpcnN0IGVsZW1lbnQgbWF0Y2hpbmcgdGhlIGdpdmVuIGNyaXRlcmlhIGFuZCBzZXRzIGl0cyB2YWx1ZS4gXCIgK1xuXHRcdFx0XCJSZXR1cm5zIHRoZSBhY3R1YWwgdmFsdWUgYWZ0ZXIgc2V0dGluZyAocmVhZC1iYWNrIHZlcmlmaWNhdGlvbikuIFwiICtcblx0XHRcdFwiQXQgbGVhc3Qgb25lIGNyaXRlcmlvbiBpcyByZXF1aXJlZC5cIixcblx0XHRwcm9tcHRHdWlkZWxpbmVzOiBbXG5cdFx0XHRcIlJlYWQgYmFjayB0aGUgdmFsdWUgYWZ0ZXIgdHlwaW5nIHRvIHZlcmlmeSBcdTIwMTQgdGhlIHJldHVybiB2YWx1ZSBpbmNsdWRlcyBhY3R1YWwgY29udGVudC5cIixcblx0XHRcdFwiVGFyZ2V0IHRleHQgZmllbGRzL2FyZWFzIGJ5IHJvbGUgKEFYVGV4dEFyZWEsIEFYVGV4dEZpZWxkKSBmb3IgcmVsaWFiaWxpdHkuXCIsXG5cdFx0XSxcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRhcHA6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQXBwbGljYXRpb24gbmFtZSBvciBidW5kbGUgaWRlbnRpZmllclwiIH0pLFxuXHRcdFx0dGV4dDogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJUZXh0IHRvIHR5cGUgaW50byB0aGUgZWxlbWVudFwiIH0pLFxuXHRcdFx0cm9sZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkFYIHJvbGUgKGUuZy4gJ0FYVGV4dEFyZWEnLCAnQVhUZXh0RmllbGQnKVwiIH0pKSxcblx0XHRcdHRpdGxlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQVggdGl0bGUgdG8gbWF0Y2hcIiB9KSksXG5cdFx0XHR2YWx1ZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkFYIHZhbHVlIHRvIG1hdGNoXCIgfSkpLFxuXHRcdFx0aWRlbnRpZmllcjogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkFYIGlkZW50aWZpZXIgdG8gbWF0Y2hcIiB9KSksXG5cdFx0XHRtYXRjaFR5cGU6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCInZXhhY3QnIChkZWZhdWx0KSBvciAnY29udGFpbnMnXCIgfSkpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZDogYW55LCBhcmdzOiB7XG5cdFx0XHRhcHA6IHN0cmluZztcblx0XHRcdHRleHQ6IHN0cmluZztcblx0XHRcdHJvbGU/OiBzdHJpbmc7XG5cdFx0XHR0aXRsZT86IHN0cmluZztcblx0XHRcdHZhbHVlPzogc3RyaW5nO1xuXHRcdFx0aWRlbnRpZmllcj86IHN0cmluZztcblx0XHRcdG1hdGNoVHlwZT86IHN0cmluZztcblx0XHR9KSB7XG5cdFx0XHRpZiAoIWFyZ3Mucm9sZSAmJiAhYXJncy50aXRsZSAmJiAhYXJncy52YWx1ZSAmJiAhYXJncy5pZGVudGlmaWVyKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIm1hY190eXBlOiBwcm92aWRlIGF0IGxlYXN0IG9uZSBzZWFyY2ggY3JpdGVyaW9uIChyb2xlLCB0aXRsZSwgdmFsdWUsIG9yIGlkZW50aWZpZXIpXCIpO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgcGFyYW1zOiBSZWNvcmQ8c3RyaW5nLCBhbnk+ID0geyBhcHA6IGFyZ3MuYXBwLCB0ZXh0OiBhcmdzLnRleHQgfTtcblx0XHRcdGlmIChhcmdzLnJvbGUpIHBhcmFtcy5yb2xlID0gYXJncy5yb2xlO1xuXHRcdFx0aWYgKGFyZ3MudGl0bGUpIHBhcmFtcy50aXRsZSA9IGFyZ3MudGl0bGU7XG5cdFx0XHRpZiAoYXJncy52YWx1ZSkgcGFyYW1zLnZhbHVlID0gYXJncy52YWx1ZTtcblx0XHRcdGlmIChhcmdzLmlkZW50aWZpZXIpIHBhcmFtcy5pZGVudGlmaWVyID0gYXJncy5pZGVudGlmaWVyO1xuXHRcdFx0aWYgKGFyZ3MubWF0Y2hUeXBlKSBwYXJhbXMubWF0Y2hUeXBlID0gYXJncy5tYXRjaFR5cGU7XG5cblx0XHRcdGNvbnN0IHJlc3VsdCA9IGV4ZWNNYWNBZ2VudChcInR5cGVUZXh0XCIsIHBhcmFtcyk7XG5cdFx0XHRpZiAoIXJlc3VsdC5zdWNjZXNzKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIm1hY190eXBlOiBcIiArIHJlc3VsdC5lcnJvcik7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGVsID0gcmVzdWx0LmRhdGE/LmVsZW1lbnQgYXMgUmVjb3JkPHN0cmluZywgYW55PiB8IHVuZGVmaW5lZDtcblx0XHRcdGNvbnN0IGFjdHVhbFZhbHVlID0gcmVzdWx0LmRhdGE/LnZhbHVlO1xuXHRcdFx0Y29uc3QgcGFydHMgPSBbZWw/LnJvbGUgPz8gXCJlbGVtZW50XCJdO1xuXHRcdFx0aWYgKGVsPy50aXRsZSkgcGFydHMucHVzaChgJyR7ZWwudGl0bGV9J2ApO1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBUeXBlZCBpbnRvICR7cGFydHMuam9pbihcIiBcIil9IFx1MjAxNCB2YWx1ZSBpcyBub3c6ICR7YWN0dWFsVmFsdWV9YCB9XSxcblx0XHRcdFx0ZGV0YWlsczogcmVzdWx0LmRhdGEsXG5cdFx0XHR9O1xuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIG1hY19zY3JlZW5zaG90XG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJtYWNfc2NyZWVuc2hvdFwiLFxuXHRcdGxhYmVsOiBcIlNjcmVlbnNob3QgV2luZG93XCIsXG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcIlRha2UgYSBzY3JlZW5zaG90IG9mIGEgbWFjT1MgYXBwbGljYXRpb24gd2luZG93IGJ5IGl0cyB3aW5kb3cgSUQgKGZyb20gbWFjX2xpc3Rfd2luZG93cykuIFwiICtcblx0XHRcdFwiUmV0dXJucyB0aGUgc2NyZWVuc2hvdCBhcyBhbiBpbWFnZSBjb250ZW50IGJsb2NrIGZvciB2aXN1YWwgYW5hbHlzaXMsIGFsb25nc2lkZSB0ZXh0IG1ldGFkYXRhIFwiICtcblx0XHRcdFwiKGRpbWVuc2lvbnMgYW5kIGZvcm1hdCkuIFJlcXVpcmVzIFNjcmVlbiBSZWNvcmRpbmcgcGVybWlzc2lvbiBcdTIwMTQgdXNlIG1hY19jaGVja19wZXJtaXNzaW9ucyB0byB2ZXJpZnkuXCIsXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJVc2UgZm9yIHZpc3VhbCB2ZXJpZmljYXRpb24gd2hlbiBhY2Nlc3NpYmlsaXR5IGF0dHJpYnV0ZXMgYXJlbid0IHN1ZmZpY2llbnQuXCIsXG5cdFx0XHRcIlByZWZlciBub21pbmFsIHJlc29sdXRpb24gdW5sZXNzIHJldGluYSBkZXRhaWwgaXMgbmVlZGVkIFx1MjAxNCByZXRpbmEgZG91YmxlcyBwYXlsb2FkIHNpemUuXCIsXG5cdFx0XHRcIlJlcXVpcmVzIFNjcmVlbiBSZWNvcmRpbmcgcGVybWlzc2lvbiBcdTIwMTQgcnVuIG1hY19jaGVja19wZXJtaXNzaW9ucyBmaXJzdCBpZiBzY3JlZW5zaG90IGZhaWxzLlwiLFxuXHRcdF0sXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0d2luZG93SWQ6IFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiV2luZG93IElEIGZyb20gbWFjX2xpc3Rfd2luZG93cyBvdXRwdXRcIiB9KSxcblx0XHRcdGZvcm1hdDogVHlwZS5PcHRpb25hbChTdHJpbmdFbnVtKFtcImpwZWdcIiwgXCJwbmdcIl0gYXMgY29uc3QsIHsgZGVzY3JpcHRpb246IFwiJ2pwZWcnIChkZWZhdWx0KSBvciAncG5nJ1wiIH0pKSxcblx0XHRcdHF1YWxpdHk6IFR5cGUuT3B0aW9uYWwoVHlwZS5OdW1iZXIoeyBkZXNjcmlwdGlvbjogXCJKUEVHIGNvbXByZXNzaW9uIHF1YWxpdHkgMC0xIChkZWZhdWx0OiAwLjgpXCIgfSkpLFxuXHRcdFx0cmV0aW5hOiBUeXBlLk9wdGlvbmFsKFR5cGUuQm9vbGVhbih7IGRlc2NyaXB0aW9uOiBcIkNhcHR1cmUgYXQgZnVsbCBwaXhlbCByZXNvbHV0aW9uIChkZWZhdWx0OiBmYWxzZSlcIiB9KSksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkOiBhbnksIGFyZ3M6IHsgd2luZG93SWQ6IG51bWJlcjsgZm9ybWF0Pzogc3RyaW5nOyBxdWFsaXR5PzogbnVtYmVyOyByZXRpbmE/OiBib29sZWFuIH0pIHtcblx0XHRcdGNvbnN0IHBhcmFtczogUmVjb3JkPHN0cmluZywgYW55PiA9IHsgd2luZG93SWQ6IGFyZ3Mud2luZG93SWQgfTtcblx0XHRcdGlmIChhcmdzLmZvcm1hdCkgcGFyYW1zLmZvcm1hdCA9IGFyZ3MuZm9ybWF0O1xuXHRcdFx0aWYgKGFyZ3MucXVhbGl0eSAhPT0gdW5kZWZpbmVkKSBwYXJhbXMucXVhbGl0eSA9IGFyZ3MucXVhbGl0eTtcblx0XHRcdGlmIChhcmdzLnJldGluYSAhPT0gdW5kZWZpbmVkKSBwYXJhbXMucmV0aW5hID0gYXJncy5yZXRpbmE7XG5cblx0XHRcdGNvbnN0IHJlc3VsdCA9IGV4ZWNNYWNBZ2VudChcInNjcmVlbnNob3RXaW5kb3dcIiwgcGFyYW1zKTtcblx0XHRcdGlmICghcmVzdWx0LnN1Y2Nlc3MpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwibWFjX3NjcmVlbnNob3Q6IFwiICsgcmVzdWx0LmVycm9yKTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgZGF0YSA9IHJlc3VsdC5kYXRhITtcblx0XHRcdGNvbnN0IGltYWdlRGF0YSA9IGRhdGEuaW1hZ2VEYXRhIGFzIHN0cmluZztcblx0XHRcdGNvbnN0IGZvcm1hdCA9IGRhdGEuZm9ybWF0IGFzIHN0cmluZztcblx0XHRcdGNvbnN0IHdpZHRoID0gZGF0YS53aWR0aCBhcyBudW1iZXI7XG5cdFx0XHRjb25zdCBoZWlnaHQgPSBkYXRhLmhlaWdodCBhcyBudW1iZXI7XG5cdFx0XHRjb25zdCBtaW1lVHlwZSA9IGZvcm1hdCA9PT0gXCJwbmdcIiA/IFwiaW1hZ2UvcG5nXCIgOiBcImltYWdlL2pwZWdcIjtcblxuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBTY3JlZW5zaG90OiAke3dpZHRofXgke2hlaWdodH0gJHtmb3JtYXR9YCB9LFxuXHRcdFx0XHRcdHsgdHlwZTogXCJpbWFnZVwiIGFzIGNvbnN0LCBkYXRhOiBpbWFnZURhdGEsIG1pbWVUeXBlIH0sXG5cdFx0XHRcdF0sXG5cdFx0XHRcdGRldGFpbHM6IHsgd2lkdGgsIGhlaWdodCwgZm9ybWF0LCBtaW1lVHlwZSB9LFxuXHRcdFx0fTtcblx0XHR9LFxuXHR9KTtcblxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHQvLyBtYWNfcmVhZFxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwibWFjX3JlYWRcIixcblx0XHRsYWJlbDogXCJSZWFkIEF0dHJpYnV0ZVwiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJSZWFkIG9uZSBvciBtb3JlIGFjY2Vzc2liaWxpdHkgYXR0cmlidXRlcyBmcm9tIGEgVUkgZWxlbWVudCBpbiBhIG1hY09TIGFwcGxpY2F0aW9uLiBcIiArXG5cdFx0XHRcIkZpbmRzIHRoZSBmaXJzdCBlbGVtZW50IG1hdGNoaW5nIHRoZSBnaXZlbiBjcml0ZXJpYSBhbmQgcmVhZHMgdGhlIG5hbWVkIGF0dHJpYnV0ZShzKS4gXCIgK1xuXHRcdFx0XCJBWFZhbHVlIHN1YnR5cGVzIChDR1BvaW50LCBDR1NpemUsIENHUmVjdCwgQ0ZSYW5nZSkgYXJlIGF1dG9tYXRpY2FsbHkgdW5wYWNrZWQgdG8gc3RydWN0dXJlZCBkaWN0cy4gXCIgK1xuXHRcdFx0XCJVc2UgJ2F0dHJpYnV0ZScgZm9yIGEgc2luZ2xlIGF0dHJpYnV0ZSBvciAnYXR0cmlidXRlcycgZm9yIG11bHRpcGxlLiBBdCBsZWFzdCBvbmUgc2VhcmNoIGNyaXRlcmlvbiBpcyByZXF1aXJlZC5cIixcblx0XHRwcm9tcHRHdWlkZWxpbmVzOiBbXG5cdFx0XHRcIlVzZSB0byB2ZXJpZnkgc3RhdGUgYWZ0ZXIgYWN0aW9ucyBcdTIwMTQgcmVhZCBBWFZhbHVlIHRvIGNvbmZpcm0gdGV4dCB3YXMgdHlwZWQsIEFYRW5hYmxlZCB0byBjaGVjayBpZiBhIGJ1dHRvbiBpcyBhY3RpdmUuXCIsXG5cdFx0XSxcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRhcHA6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQXBwbGljYXRpb24gbmFtZSBvciBidW5kbGUgaWRlbnRpZmllclwiIH0pLFxuXHRcdFx0YXR0cmlidXRlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiU2luZ2xlIGF0dHJpYnV0ZSBuYW1lIHRvIHJlYWQgKGUuZy4gJ0FYVmFsdWUnLCAnQVhQb3NpdGlvbicsICdBWFJvbGUnKVwiIH0pKSxcblx0XHRcdGF0dHJpYnV0ZXM6IFR5cGUuT3B0aW9uYWwoVHlwZS5BcnJheShUeXBlLlN0cmluZygpLCB7IGRlc2NyaXB0aW9uOiBcIk11bHRpcGxlIGF0dHJpYnV0ZSBuYW1lcyB0byByZWFkXCIgfSkpLFxuXHRcdFx0cm9sZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkFYIHJvbGUgKGUuZy4gJ0FYQnV0dG9uJywgJ0FYVGV4dEFyZWEnKVwiIH0pKSxcblx0XHRcdHRpdGxlOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiQVggdGl0bGUgdG8gbWF0Y2hcIiB9KSksXG5cdFx0XHR2YWx1ZTogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkFYIHZhbHVlIHRvIG1hdGNoXCIgfSkpLFxuXHRcdFx0aWRlbnRpZmllcjogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkFYIGlkZW50aWZpZXIgdG8gbWF0Y2hcIiB9KSksXG5cdFx0XHRtYXRjaFR5cGU6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCInZXhhY3QnIChkZWZhdWx0KSBvciAnY29udGFpbnMnXCIgfSkpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZDogYW55LCBhcmdzOiB7XG5cdFx0XHRhcHA6IHN0cmluZztcblx0XHRcdGF0dHJpYnV0ZT86IHN0cmluZztcblx0XHRcdGF0dHJpYnV0ZXM/OiBzdHJpbmdbXTtcblx0XHRcdHJvbGU/OiBzdHJpbmc7XG5cdFx0XHR0aXRsZT86IHN0cmluZztcblx0XHRcdHZhbHVlPzogc3RyaW5nO1xuXHRcdFx0aWRlbnRpZmllcj86IHN0cmluZztcblx0XHRcdG1hdGNoVHlwZT86IHN0cmluZztcblx0XHR9KSB7XG5cdFx0XHRpZiAoIWFyZ3MuYXR0cmlidXRlICYmICghYXJncy5hdHRyaWJ1dGVzIHx8IGFyZ3MuYXR0cmlidXRlcy5sZW5ndGggPT09IDApKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIm1hY19yZWFkOiBwcm92aWRlICdhdHRyaWJ1dGUnIChzaW5nbGUpIG9yICdhdHRyaWJ1dGVzJyAoYXJyYXkpIHBhcmFtZXRlclwiKTtcblx0XHRcdH1cblx0XHRcdGlmICghYXJncy5yb2xlICYmICFhcmdzLnRpdGxlICYmICFhcmdzLnZhbHVlICYmICFhcmdzLmlkZW50aWZpZXIpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwibWFjX3JlYWQ6IHByb3ZpZGUgYXQgbGVhc3Qgb25lIHNlYXJjaCBjcml0ZXJpb24gKHJvbGUsIHRpdGxlLCB2YWx1ZSwgb3IgaWRlbnRpZmllcilcIik7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBwYXJhbXM6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7IGFwcDogYXJncy5hcHAgfTtcblx0XHRcdGlmIChhcmdzLmF0dHJpYnV0ZSkgcGFyYW1zLmF0dHJpYnV0ZSA9IGFyZ3MuYXR0cmlidXRlO1xuXHRcdFx0aWYgKGFyZ3MuYXR0cmlidXRlcykgcGFyYW1zLmF0dHJpYnV0ZXMgPSBhcmdzLmF0dHJpYnV0ZXM7XG5cdFx0XHRpZiAoYXJncy5yb2xlKSBwYXJhbXMucm9sZSA9IGFyZ3Mucm9sZTtcblx0XHRcdGlmIChhcmdzLnRpdGxlKSBwYXJhbXMudGl0bGUgPSBhcmdzLnRpdGxlO1xuXHRcdFx0aWYgKGFyZ3MudmFsdWUpIHBhcmFtcy52YWx1ZSA9IGFyZ3MudmFsdWU7XG5cdFx0XHRpZiAoYXJncy5pZGVudGlmaWVyKSBwYXJhbXMuaWRlbnRpZmllciA9IGFyZ3MuaWRlbnRpZmllcjtcblx0XHRcdGlmIChhcmdzLm1hdGNoVHlwZSkgcGFyYW1zLm1hdGNoVHlwZSA9IGFyZ3MubWF0Y2hUeXBlO1xuXG5cdFx0XHRjb25zdCByZXN1bHQgPSBleGVjTWFjQWdlbnQoXCJyZWFkQXR0cmlidXRlXCIsIHBhcmFtcyk7XG5cdFx0XHRpZiAoIXJlc3VsdC5zdWNjZXNzKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIm1hY19yZWFkOiBcIiArIHJlc3VsdC5lcnJvcik7XG5cdFx0XHR9XG5cblx0XHRcdC8vIEZvcm1hdCBvdXRwdXQgYmFzZWQgb24gc2luZ2xlIHZzIG11bHRpIGF0dHJpYnV0ZVxuXHRcdFx0aWYgKGFyZ3MuYXR0cmlidXRlICYmICFhcmdzLmF0dHJpYnV0ZXMpIHtcblx0XHRcdFx0Y29uc3QgdmFsID0gcmVzdWx0LmRhdGE/LnZhbHVlO1xuXHRcdFx0XHRjb25zdCBmb3JtYXR0ZWQgPSB0eXBlb2YgdmFsID09PSBcIm9iamVjdFwiID8gSlNPTi5zdHJpbmdpZnkodmFsKSA6IFN0cmluZyh2YWwpO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgJHthcmdzLmF0dHJpYnV0ZX06ICR7Zm9ybWF0dGVkfWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogcmVzdWx0LmRhdGEsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cblx0XHRcdC8vIE11bHRpLWF0dHJpYnV0ZTogZm9ybWF0IGFzIGtleTogdmFsdWUgbGluZXNcblx0XHRcdGNvbnN0IHZhbHVlcyA9IHJlc3VsdC5kYXRhPy52YWx1ZXMgYXMgUmVjb3JkPHN0cmluZywgYW55PiB8IHVuZGVmaW5lZDtcblx0XHRcdGlmICh2YWx1ZXMpIHtcblx0XHRcdFx0Y29uc3QgbGluZXMgPSBPYmplY3QuZW50cmllcyh2YWx1ZXMpLm1hcCgoW2ssIHZdKSA9PiB7XG5cdFx0XHRcdFx0Y29uc3QgZm9ybWF0dGVkID0gdHlwZW9mIHYgPT09IFwib2JqZWN0XCIgPyBKU09OLnN0cmluZ2lmeSh2KSA6IFN0cmluZyh2KTtcblx0XHRcdFx0XHRyZXR1cm4gYCR7a306ICR7Zm9ybWF0dGVkfWA7XG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBsaW5lcy5qb2luKFwiXFxuXCIpIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHJlc3VsdC5kYXRhLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBGYWxsYmFja1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IEpTT04uc3RyaW5naWZ5KHJlc3VsdC5kYXRhKSB9XSxcblx0XHRcdFx0ZGV0YWlsczogcmVzdWx0LmRhdGEsXG5cdFx0XHR9O1xuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIFN5c3RlbSBwcm9tcHQgaW5qZWN0aW9uIFx1MjAxNCBtYWMtdG9vbHMgdXNhZ2UgZ3VpZGVsaW5lc1xuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXHRwaS5vbihcImJlZm9yZV9hZ2VudF9zdGFydFwiLCBhc3luYyAoZXZlbnQpID0+IHtcblx0XHRjb25zdCBndWlkZWxpbmVzID0gYFxuXG5bU1lTVEVNIENPTlRFWFQgXHUyMDE0IE1hYyBUb29sc11cblxuIyMgTmF0aXZlIG1hY09TIEFwcCBJbnRlcmFjdGlvblxuXG5Zb3UgaGF2ZSBtYWMtdG9vbHMgZm9yIGNvbnRyb2xsaW5nIG5hdGl2ZSBtYWNPUyBhcHBsaWNhdGlvbnMgKEZpbmRlciwgVGV4dEVkaXQsIFNhZmFyaSwgWGNvZGUsIGV0Yy4pIHZpYSBBY2Nlc3NpYmlsaXR5IEFQSXMuXG5cbioqTWFjLXRvb2xzIHZzIGJyb3dzZXItdG9vbHM6KiogVXNlIG1hYy10b29scyBmb3IgbmF0aXZlIG1hY09TIGFwcHMuIFVzZSBicm93c2VyLXRvb2xzIGZvciB3ZWIgcGFnZXMgaW5zaWRlIGEgYnJvd3Nlci4gSWYgeW91IG5lZWQgdG8gaW50ZXJhY3Qgd2l0aCBhIHdlYnNpdGUgaW4gU2FmYXJpIG9yIENocm9tZSwgdXNlIGJyb3dzZXItdG9vbHMgXHUyMDE0IG1hYy10b29scyBjb250cm9scyB0aGUgYnJvd3NlcidzIG5hdGl2ZSBVSSBjaHJvbWUgKG1lbnVzLCB0YWJzLCBhZGRyZXNzIGJhciksIG5vdCB3ZWIgcGFnZSBjb250ZW50LlxuXG4qKlBlcm1pc3Npb25zOioqIElmIGFueSBtYWMgdG9vbCByZXR1cm5zIGEgcGVybWlzc2lvbiBlcnJvciwgcnVuIFxcYG1hY19jaGVja19wZXJtaXNzaW9uc1xcYCB0byBkaWFnbm9zZS4gQWNjZXNzaWJpbGl0eSBhbmQgU2NyZWVuIFJlY29yZGluZyBwZXJtaXNzaW9ucyBhcmUgZ3JhbnRlZCBpbiBTeXN0ZW0gU2V0dGluZ3MgPiBQcml2YWN5ICYgU2VjdXJpdHkuXG5cbioqSW50ZXJhY3Rpb24gcGF0dGVybiBcdTIwMTQgZGlzY292ZXIgXHUyMTkyIGFjdCBcdTIxOTIgdmVyaWZ5OioqXG4xLiAqKkRpc2NvdmVyKiogdGhlIFVJIHN0cnVjdHVyZSB3aXRoIFxcYG1hY19maW5kXFxgIChzZWFyY2ggZm9yIHNwZWNpZmljIGVsZW1lbnRzKSBvciBcXGBtYWNfZ2V0X3RyZWVcXGAgKHNlZSBvdmVyYWxsIGxheW91dClcbjIuICoqQWN0Kiogd2l0aCBcXGBtYWNfY2xpY2tcXGAgKHByZXNzIGJ1dHRvbnMvbWVudXMpIG9yIFxcYG1hY190eXBlXFxgIChlbnRlciB0ZXh0IGludG8gZmllbGRzKVxuMy4gKipWZXJpZnkqKiB0aGUgcmVzdWx0IHdpdGggXFxgbWFjX3JlYWRcXGAgKGNoZWNrIGF0dHJpYnV0ZSB2YWx1ZXMpIG9yIFxcYG1hY19zY3JlZW5zaG90XFxgICh2aXN1YWwgY29uZmlybWF0aW9uKVxuXG4qKlRyZWUgcXVlcmllczoqKiBTdGFydCB3aXRoIGRlZmF1bHQgbGltaXRzIChtYWNfZ2V0X3RyZWU6IG1heERlcHRoOjMsIG1heENvdW50OjUwKS4gSW5jcmVhc2Ugb25seSBpZiB0aGUgZWxlbWVudCB5b3UgbmVlZCBpc24ndCB2aXNpYmxlIGluIHRoZSBvdXRwdXQuIExhcmdlIHRyZWVzIHdhc3RlIGNvbnRleHQuXG5cbioqU2NyZWVuc2hvdHM6KiogVXNlIFxcYG1hY19zY3JlZW5zaG90XFxgIG9ubHkgd2hlbiB2aXN1YWwgdmVyaWZpY2F0aW9uIGlzIGdlbnVpbmVseSBuZWVkZWQgXHUyMDE0IHRoZSBpbWFnZSBwYXlsb2FkIGlzIGxhcmdlLiBQcmVmZXIgXFxgbWFjX3JlYWRcXGAgb3IgXFxgbWFjX2ZpbmRcXGAgZm9yIGNoZWNraW5nIHRleHQgdmFsdWVzIGFuZCBlbGVtZW50IHN0YXRlLmA7XG5cblx0XHRyZXR1cm4geyBzeXN0ZW1Qcm9tcHQ6IGV2ZW50LnN5c3RlbVByb21wdCArIGd1aWRlbGluZXMgfTtcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFlQSxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLFlBQVk7QUFDckIsU0FB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QUFFLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxNQUFNO0FBQ3BELGdCQUFNLFlBQVksT0FBTyxNQUFNLFdBQVcsS0FBSyxVQUFVLENBQUMsSUFBSSxPQUFPLENBQUM7QUFDdEUsaUJBQU8sR0FBRyxDQUFDLEtBQUssU0FBUztBQUFBLFFBQzFCLENBQUM7QUFDRCxlQUFPO0FBQUEsVUFDTixTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0sTUFBTSxLQUFLLElBQUksRUFBRSxDQUFDO0FBQUEsVUFDM0QsU0FBUyxPQUFPO0FBQUEsUUFDakI7QUFBQSxNQUNEO0FBR0EsYUFBTztBQUFBLFFBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLEtBQUssVUFBVSxPQUFPLElBQUksRUFBRSxDQUFDO0FBQUEsUUFDdEUsU0FBUyxPQUFPO0FBQUEsTUFDakI7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBS0QsS0FBRyxHQUFHLHNCQUFzQixPQUFPLFVBQVU7QUFDNUMsVUFBTSxhQUFhO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFxQm5CLFdBQU8sRUFBRSxjQUFjLE1BQU0sZUFBZSxXQUFXO0FBQUEsRUFDeEQsQ0FBQztBQUNGOyIsCiAgIm5hbWVzIjogWyJyZXN1bHQiLCAicmVuZGVyVHJlZSIsICJsaW5lcyIsICJwYXJhbXMiLCAiZGF0YSIsICJ0cnVuY05vdGUiXQp9Cg==
