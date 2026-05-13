import { readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Editor, Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import { makeUI } from "./shared/tui.js";
import { maskEditorLine } from "./shared/mod.js";
import { parseSecretsManifest, formatSecretsManifest } from "./gsd/files.js";
import { resolveMilestoneFile } from "./gsd/paths.js";
function maskPreview(value) {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}${"*".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}
function shellEscapeSingle(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function isSafeEnvVarKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}
function isSupportedDeploymentEnvironment(env) {
  return env === "development" || env === "preview" || env === "production";
}
function hydrateProcessEnv(key, value) {
  process.env[key] = value;
}
async function writeEnvKey(filePath, key, value) {
  if (typeof value !== "string") {
    throw new TypeError(`writeEnvKey expects a string value for key "${key}", got ${typeof value}`);
  }
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    content = "";
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "");
  const line = `${key}=${escaped}`;
  const regex = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    if (content.length > 0 && !content.endsWith("\n")) content += "\n";
    content += `${line}
`;
  }
  await writeFile(filePath, content, "utf8");
}
import { checkExistingEnvKeys } from "./gsd/env-utils.js";
function detectDestination(basePath) {
  if (existsSync(resolve(basePath, "vercel.json"))) {
    return "vercel";
  }
  const convexPath = resolve(basePath, "convex");
  try {
    if (existsSync(convexPath) && statSync(convexPath).isDirectory()) {
      return "convex";
    }
  } catch {
  }
  return "dotenv";
}
async function collectOneSecret(ctx, pageIndex, totalPages, keyName, hint, guidance) {
  if (!ctx.hasUI) return null;
  const customResult = await ctx.ui.custom((tui, theme, _kb, done) => {
    let value = "";
    let cachedLines;
    const editorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t)
      }
    };
    const editor = new Editor(tui, editorTheme, { paddingX: 1 });
    function refresh() {
      cachedLines = void 0;
      tui.requestRender();
    }
    function handleInput(data) {
      if (matchesKey(data, Key.enter)) {
        value = editor.getText().trim();
        done(value.length > 0 ? value : null);
        return;
      }
      if (matchesKey(data, Key.escape)) {
        done(null);
        return;
      }
      if (data === "") {
        done(null);
        return;
      }
      editor.handleInput(data);
      refresh();
    }
    function render(width) {
      if (cachedLines) return cachedLines;
      const lines = [];
      const add = (s) => lines.push(truncateToWidth(s, width));
      add(theme.fg("accent", "\u2500".repeat(width)));
      add(theme.fg("dim", ` Page ${pageIndex + 1}/${totalPages} \xB7 Secure Env Setup`));
      lines.push("");
      add(theme.fg("accent", theme.bold(` ${keyName}`)));
      if (hint) {
        add(theme.fg("muted", `  ${hint}`));
      }
      if (guidance && guidance.length > 0) {
        lines.push("");
        for (let g = 0; g < guidance.length; g++) {
          const prefix = `  ${g + 1}. `;
          const step = guidance[g];
          const wrappedLines = wrapTextWithAnsi(step, width - 4);
          for (let w = 0; w < wrappedLines.length; w++) {
            const indent = w === 0 ? prefix : " ".repeat(prefix.length);
            lines.push(theme.fg("dim", `${indent}${wrappedLines[w]}`));
          }
        }
      }
      lines.push("");
      const raw = editor.getText();
      const preview = raw.length > 0 ? maskPreview(raw) : theme.fg("dim", "(empty \u2014 press enter to skip)");
      add(theme.fg("text", `  Preview: ${preview}`));
      lines.push("");
      add(theme.fg("muted", " Enter value:"));
      for (const line of editor.render(width - 2)) {
        add(theme.fg("text", maskEditorLine(line)));
      }
      lines.push("");
      add(theme.fg("dim", ` enter to confirm  |  ctrl+s or esc to skip  |  esc cancels`));
      add(theme.fg("accent", "\u2500".repeat(width)));
      cachedLines = lines;
      return lines;
    }
    return {
      render,
      invalidate: () => {
        cachedLines = void 0;
      },
      handleInput
    };
  });
  if (customResult !== void 0) {
    return customResult;
  }
  if (typeof ctx.ui?.input !== "function") {
    return null;
  }
  const inputTitle = `Secure value for ${keyName} (${pageIndex + 1}/${totalPages})`;
  const inputPlaceholder = hint || "Enter secret value";
  const inputResult = await ctx.ui.input(
    inputTitle,
    inputPlaceholder,
    { secure: true }
  );
  if (typeof inputResult !== "string") {
    return null;
  }
  const trimmed = inputResult.trim();
  return trimmed.length > 0 ? trimmed : null;
}
const collectOneSecretWithGuidance = collectOneSecret;
async function showSecretsSummary(ctx, entries, existingKeys) {
  if (!ctx.hasUI) return;
  const existingSet = new Set(existingKeys);
  await ctx.ui.custom((_tui, theme, _kb, done) => {
    let cachedLines;
    function handleInput(_data) {
      done(null);
    }
    function render(width) {
      if (cachedLines) return cachedLines;
      const ui = makeUI(theme, width);
      const lines = [];
      const push = (...rows) => {
        for (const r of rows) lines.push(...r);
      };
      push(ui.bar());
      push(ui.blank());
      push(ui.header("  Secrets Summary"));
      push(ui.blank());
      for (const entry of entries) {
        let status;
        let detail;
        if (existingSet.has(entry.key)) {
          status = "done";
          detail = "already set";
        } else if (entry.status === "collected") {
          status = "done";
        } else if (entry.status === "skipped") {
          status = "skipped";
        } else {
          status = "pending";
        }
        push(ui.progressItem(entry.key, status, { detail }));
      }
      push(ui.blank());
      push(ui.hints(["any key to continue"]));
      push(ui.bar());
      cachedLines = lines;
      return lines;
    }
    return {
      render,
      invalidate: () => {
        cachedLines = void 0;
      },
      handleInput
    };
  });
}
async function applySecrets(provided, destination, opts) {
  const applied = [];
  const errors = [];
  if (destination === "dotenv") {
    for (const { key, value } of provided) {
      try {
        await writeEnvKey(opts.envFilePath, key, value);
        applied.push(key);
        hydrateProcessEnv(key, value);
      } catch (err) {
        errors.push(`${key}: ${err.message}`);
      }
    }
  }
  if ((destination === "vercel" || destination === "convex") && opts.exec) {
    const env = opts.environment ?? "development";
    if (!isSupportedDeploymentEnvironment(env)) {
      errors.push(`environment: unsupported target environment "${env}"`);
      return { applied, errors };
    }
    for (const { key, value } of provided) {
      if (!isSafeEnvVarKey(key)) {
        errors.push(`${key}: invalid environment variable name`);
        continue;
      }
      const cmd = destination === "vercel" ? `printf %s ${shellEscapeSingle(value)} | vercel env add ${key} ${env}` : "";
      try {
        const result = destination === "vercel" ? await opts.exec("sh", ["-c", cmd]) : await opts.exec("npx", ["convex", "env", "set", key, value]);
        if (result.code !== 0) {
          errors.push(`${key}: ${result.stderr.slice(0, 200)}`);
        } else {
          applied.push(key);
          hydrateProcessEnv(key, value);
        }
      } catch (err) {
        errors.push(`${key}: ${err.message}`);
      }
    }
  }
  return { applied, errors };
}
async function collectSecretsFromManifest(base, milestoneId, ctx) {
  const manifestPath = resolveMilestoneFile(base, milestoneId, "SECRETS");
  if (!manifestPath) {
    throw new Error(`Secrets manifest not found for milestone ${milestoneId} in ${base}`);
  }
  const content = await readFile(manifestPath, "utf8");
  const manifest = parseSecretsManifest(content);
  const envPath = resolve(base, ".env");
  const allKeys = manifest.entries.map((e) => e.key);
  const existingKeys = await checkExistingEnvKeys(allKeys, envPath);
  const existingSet = new Set(existingKeys);
  const existingSkipped = [];
  const alreadySkipped = [];
  const pendingEntries = [];
  for (const entry of manifest.entries) {
    if (existingSet.has(entry.key)) {
      existingSkipped.push(entry.key);
    } else if (entry.status === "skipped") {
      alreadySkipped.push(entry.key);
    } else if (entry.status === "pending") {
      pendingEntries.push(entry);
    }
  }
  await showSecretsSummary(ctx, manifest.entries, existingKeys);
  const destination = detectDestination(ctx.cwd);
  const collected = [];
  for (let i = 0; i < pendingEntries.length; i++) {
    const entry = pendingEntries[i];
    const value = await collectOneSecret(
      ctx,
      i,
      pendingEntries.length,
      entry.key,
      entry.formatHint || void 0,
      entry.guidance.length > 0 ? entry.guidance : void 0
    );
    collected.push({ key: entry.key, value });
  }
  for (const { key, value } of collected) {
    const entry = manifest.entries.find((e) => e.key === key);
    if (entry) {
      entry.status = value != null ? "collected" : "skipped";
    }
  }
  await writeFile(manifestPath, formatSecretsManifest(manifest), "utf8");
  const provided = collected.filter((c) => c.value != null);
  const { applied } = await applySecrets(provided, destination, {
    envFilePath: resolve(ctx.cwd, ".env")
  });
  const skipped = [
    ...alreadySkipped,
    ...collected.filter((c) => c.value == null).map((c) => c.key)
  ];
  return { applied, skipped, existingSkipped };
}
function secureEnv(pi) {
  pi.registerTool({
    name: "secure_env_collect",
    label: "Secure Env Collect",
    description: "Collect one or more env vars through a paged masked-input UI, then write them to .env, Vercel, or Convex. Values are shown masked to the user (e.g. sk-ir***dgdh) and never echoed in tool output.",
    promptSnippet: "Collect and apply env vars securely without asking user to edit files manually.",
    promptGuidelines: [
      "NEVER ask the user to manually edit .env files, copy-paste into a terminal, or open a dashboard to set env vars. Always use secure_env_collect instead.",
      "When a command fails due to a missing env var (e.g. 'OPENAI_API_KEY is not set', 'Missing required environment variable', 'Invalid API key', 'authentication required'), immediately call secure_env_collect with the missing keys before retrying.",
      "When starting a new project or running setup steps that require secrets (API keys, tokens, database URLs), proactively call secure_env_collect before the first command that needs them.",
      "Detect the right destination: use 'dotenv' for local dev, 'vercel' when deploying to Vercel, 'convex' when using Convex backend.",
      "After secure_env_collect completes, re-run the originally blocked command to verify the fix worked.",
      "Never echo, log, or repeat secret values in your responses. Only report key names and applied/skipped status."
    ],
    parameters: Type.Object({
      destination: Type.Optional(Type.Union([
        Type.Literal("dotenv"),
        Type.Literal("vercel"),
        Type.Literal("convex")
      ], { description: "Where to write the collected secrets" })),
      keys: Type.Array(
        Type.Object({
          key: Type.String({ description: "Env var name, e.g. OPENAI_API_KEY" }),
          hint: Type.Optional(Type.String({ description: "Format hint shown to user, e.g. 'starts with sk-'" })),
          required: Type.Optional(Type.Boolean()),
          guidance: Type.Optional(Type.Array(Type.String(), { description: "Step-by-step guidance for finding this key" }))
        }),
        { minItems: 1 }
      ),
      envFilePath: Type.Optional(Type.String({ description: "Path to .env file (dotenv only). Defaults to .env in cwd." })),
      environment: Type.Optional(
        Type.Union([
          Type.Literal("development"),
          Type.Literal("preview"),
          Type.Literal("production")
        ], { description: "Target environment (vercel only)" })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Error: UI not available (interactive mode required for secure env collection)." }],
          isError: true,
          details: void 0
        };
      }
      const destinationAutoDetected = params.destination == null;
      const destination = params.destination ?? detectDestination(ctx.cwd);
      const collected = [];
      for (let i = 0; i < params.keys.length; i++) {
        const item = params.keys[i];
        const value = await collectOneSecret(ctx, i, params.keys.length, item.key, item.hint, item.guidance);
        collected.push({ key: item.key, value });
      }
      const provided = collected.filter((c) => c.value != null);
      const skipped = collected.filter((c) => c.value == null).map((c) => c.key);
      const { applied, errors } = await applySecrets(provided, destination, {
        envFilePath: resolve(ctx.cwd, params.envFilePath ?? ".env"),
        environment: params.environment,
        exec: (cmd, args) => pi.exec(cmd, args)
      });
      const details = {
        destination,
        environment: params.environment,
        applied,
        skipped,
        ...destinationAutoDetected ? { detectedDestination: destination } : {}
      };
      const lines = [
        `destination: ${destination}${destinationAutoDetected ? " (auto-detected)" : ""}${params.environment ? ` (${params.environment})` : ""}`,
        ...applied.map((k) => `\u2713 ${k}: applied`),
        ...skipped.map((k) => `\u2022 ${k}: skipped`),
        ...errors.map((e) => `\u2717 ${e}`)
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details,
        isError: errors.length > 0 && applied.length === 0
      };
    },
    renderCall(args, theme) {
      const count = Array.isArray(args.keys) ? args.keys.length : 0;
      return new Text(
        theme.fg("toolTitle", theme.bold("secure_env_collect ")) + theme.fg("muted", `\u2192 ${args.destination ?? "auto"}`) + theme.fg("dim", `  ${count} key${count !== 1 ? "s" : ""}`),
        0,
        0
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details;
      if (!details) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "", 0, 0);
      }
      const lines = [
        `${theme.fg("success", "\u2713")} ${details.destination}${details.environment ? ` (${details.environment})` : ""}`,
        ...details.applied.map((k) => `  ${theme.fg("success", "\u2713")} ${k}: applied`),
        ...details.skipped.map((k) => `  ${theme.fg("warning", "\u2022")} ${k}: skipped`)
      ];
      return new Text(lines.join("\n"), 0, 0);
    }
  });
}
export {
  checkExistingEnvKeys,
  collectOneSecretWithGuidance,
  collectSecretsFromManifest,
  secureEnv as default,
  detectDestination,
  showSecretsSummary
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dldC1zZWNyZXRzLWZyb20tdXNlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBnZXQtc2VjcmV0cy1mcm9tLXVzZXIgXHUyMDE0IHBhZ2VkIHNlY3VyZSBlbnYgdmFyIGNvbGxlY3Rpb24gKyBhcHBseVxuICpcbiAqIENvbGxlY3RzIHNlY3JldHMgb25lLXBlci1wYWdlIHZpYSBtYXNrZWQgVFVJIGlucHV0LCB0aGVuIHdyaXRlcyB0aGVtXG4gKiB0byAuZW52IChsb2NhbCksIFZlcmNlbCwgb3IgQ29udmV4LiBObyBjdHguY2FsbFRvb2wsIG5vIGV4dGVybmFsIGRlcHMuXG4gKiBVc2VzIE5vZGUgZnMvcHJvbWlzZXMgZm9yIGZpbGUgSS9PIGFuZCBwaS5leGVjKCkgZm9yIENMSSBzaW5rcy5cbiAqL1xuXG5pbXBvcnQgeyByZWFkRmlsZSwgd3JpdGVGaWxlIH0gZnJvbSBcIm5vZGU6ZnMvcHJvbWlzZXNcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHN0YXRTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJLCBUaGVtZSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgRWRpdG9yLCB0eXBlIEVkaXRvclRoZW1lLCBLZXksIG1hdGNoZXNLZXksIFRleHQsIHRydW5jYXRlVG9XaWR0aCwgd3JhcFRleHRXaXRoQW5zaSB9IGZyb20gXCJAZ3NkL3BpLXR1aVwiO1xuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHsgbWFrZVVJIH0gZnJvbSBcIi4vc2hhcmVkL3R1aS5qc1wiO1xuaW1wb3J0IHsgbWFza0VkaXRvckxpbmUsIHR5cGUgUHJvZ3Jlc3NTdGF0dXMgfSBmcm9tIFwiLi9zaGFyZWQvbW9kLmpzXCI7XG5pbXBvcnQgeyBwYXJzZVNlY3JldHNNYW5pZmVzdCwgZm9ybWF0U2VjcmV0c01hbmlmZXN0IH0gZnJvbSBcIi4vZ3NkL2ZpbGVzLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlTWlsZXN0b25lRmlsZSB9IGZyb20gXCIuL2dzZC9wYXRocy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBTZWNyZXRzTWFuaWZlc3RFbnRyeSB9IGZyb20gXCIuL2dzZC90eXBlcy5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVHlwZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmludGVyZmFjZSBDb2xsZWN0ZWRTZWNyZXQge1xuXHRrZXk6IHN0cmluZztcblx0dmFsdWU6IHN0cmluZyB8IG51bGw7IC8vIG51bGwgPSBza2lwcGVkXG59XG5cbmludGVyZmFjZSBUb29sUmVzdWx0RGV0YWlscyB7XG5cdGRlc3RpbmF0aW9uOiBzdHJpbmc7XG5cdGVudmlyb25tZW50Pzogc3RyaW5nO1xuXHRhcHBsaWVkOiBzdHJpbmdbXTtcblx0c2tpcHBlZDogc3RyaW5nW107XG5cdGV4aXN0aW5nU2tpcHBlZD86IHN0cmluZ1tdO1xuXHRkZXRlY3RlZERlc3RpbmF0aW9uPzogc3RyaW5nO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gbWFza1ByZXZpZXcodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG5cdGlmICghdmFsdWUpIHJldHVybiBcIlwiO1xuXHRpZiAodmFsdWUubGVuZ3RoIDw9IDgpIHJldHVybiBcIipcIi5yZXBlYXQodmFsdWUubGVuZ3RoKTtcblx0cmV0dXJuIGAke3ZhbHVlLnNsaWNlKDAsIDQpfSR7XCIqXCIucmVwZWF0KE1hdGgubWF4KDQsIHZhbHVlLmxlbmd0aCAtIDgpKX0ke3ZhbHVlLnNsaWNlKC00KX1gO1xufVxuXG5mdW5jdGlvbiBzaGVsbEVzY2FwZVNpbmdsZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIGAnJHt2YWx1ZS5yZXBsYWNlKC8nL2csIGAnXFxcXCcnYCl9J2A7XG59XG5cbmZ1bmN0aW9uIGlzU2FmZUVudlZhcktleShrZXk6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRyZXR1cm4gL15bQS1aYS16X11bQS1aYS16MC05X10qJC8udGVzdChrZXkpO1xufVxuXG5mdW5jdGlvbiBpc1N1cHBvcnRlZERlcGxveW1lbnRFbnZpcm9ubWVudChlbnY6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRyZXR1cm4gZW52ID09PSBcImRldmVsb3BtZW50XCIgfHwgZW52ID09PSBcInByZXZpZXdcIiB8fCBlbnYgPT09IFwicHJvZHVjdGlvblwiO1xufVxuXG5mdW5jdGlvbiBoeWRyYXRlUHJvY2Vzc0VudihrZXk6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IHZvaWQge1xuXHQvLyBNYWtlIG5ld2x5IGNvbGxlY3RlZCBzZWNyZXRzIGltbWVkaWF0ZWx5IHZpc2libGUgdG8gdGhlIGN1cnJlbnQgc2Vzc2lvbi5cblx0Ly8gU29tZSBleHRlbnNpb25zIHJlYWQgcHJvY2Vzcy5lbnYgZGlyZWN0bHkgYW5kIGRvIG5vdCByZWxvYWQgLmVudiBvbiBldmVyeSBjYWxsLlxuXHRwcm9jZXNzLmVudltrZXldID0gdmFsdWU7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlRW52S2V5KGZpbGVQYXRoOiBzdHJpbmcsIGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG5cdGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIpIHtcblx0XHR0aHJvdyBuZXcgVHlwZUVycm9yKGB3cml0ZUVudktleSBleHBlY3RzIGEgc3RyaW5nIHZhbHVlIGZvciBrZXkgXCIke2tleX1cIiwgZ290ICR7dHlwZW9mIHZhbHVlfWApO1xuXHR9XG5cdGxldCBjb250ZW50ID0gXCJcIjtcblx0dHJ5IHtcblx0XHRjb250ZW50ID0gYXdhaXQgcmVhZEZpbGUoZmlsZVBhdGgsIFwidXRmOFwiKTtcblx0fSBjYXRjaCB7XG5cdFx0Y29udGVudCA9IFwiXCI7XG5cdH1cblx0Y29uc3QgZXNjYXBlZCA9IHZhbHVlLnJlcGxhY2UoL1xcXFwvZywgXCJcXFxcXFxcXFwiKS5yZXBsYWNlKC9cXG4vZywgXCJcXFxcblwiKS5yZXBsYWNlKC9cXHIvZywgXCJcIik7XG5cdGNvbnN0IGxpbmUgPSBgJHtrZXl9PSR7ZXNjYXBlZH1gO1xuXHRjb25zdCByZWdleCA9IG5ldyBSZWdFeHAoYF4ke2tleS5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgXCJcXFxcJCZcIil9XFxcXHMqPS4qJGAsIFwibVwiKTtcblx0aWYgKHJlZ2V4LnRlc3QoY29udGVudCkpIHtcblx0XHRjb250ZW50ID0gY29udGVudC5yZXBsYWNlKHJlZ2V4LCBsaW5lKTtcblx0fSBlbHNlIHtcblx0XHRpZiAoY29udGVudC5sZW5ndGggPiAwICYmICFjb250ZW50LmVuZHNXaXRoKFwiXFxuXCIpKSBjb250ZW50ICs9IFwiXFxuXCI7XG5cdFx0Y29udGVudCArPSBgJHtsaW5lfVxcbmA7XG5cdH1cblx0YXdhaXQgd3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50LCBcInV0ZjhcIik7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBFeHBvcnRlZCB1dGlsaXRpZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8vIFJlLWV4cG9ydCBmcm9tIGVudi11dGlscy50cyBzbyBleGlzdGluZyBjb25zdW1lcnMgc3RpbGwgd29yay5cbi8vIFRoZSBpbXBsZW1lbnRhdGlvbiBsaXZlcyBpbiBlbnYtdXRpbHMudHMgdG8gYXZvaWQgcHVsbGluZyBAZ3NkL3BpLXR1aVxuLy8gaW50byBtb2R1bGVzIHRoYXQgb25seSBuZWVkIGVudi1jaGVja2luZyAoZS5nLiBmaWxlcy50cyBkdXJpbmcgcmVwb3J0cykuXG5pbXBvcnQgeyBjaGVja0V4aXN0aW5nRW52S2V5cyB9IGZyb20gXCIuL2dzZC9lbnYtdXRpbHMuanNcIjtcbmV4cG9ydCB7IGNoZWNrRXhpc3RpbmdFbnZLZXlzIH07XG5cbi8qKlxuICogRGV0ZWN0IHRoZSB3cml0ZSBkZXN0aW5hdGlvbiBiYXNlZCBvbiBwcm9qZWN0IGZpbGVzIGluIGJhc2VQYXRoLlxuICogUHJpb3JpdHk6IHZlcmNlbC5qc29uIFx1MjE5MiBjb252ZXgvIGRpciBcdTIxOTIgZmFsbGJhY2sgXCJkb3RlbnZcIi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdERlc3RpbmF0aW9uKGJhc2VQYXRoOiBzdHJpbmcpOiBcImRvdGVudlwiIHwgXCJ2ZXJjZWxcIiB8IFwiY29udmV4XCIge1xuXHRpZiAoZXhpc3RzU3luYyhyZXNvbHZlKGJhc2VQYXRoLCBcInZlcmNlbC5qc29uXCIpKSkge1xuXHRcdHJldHVybiBcInZlcmNlbFwiO1xuXHR9XG5cdGNvbnN0IGNvbnZleFBhdGggPSByZXNvbHZlKGJhc2VQYXRoLCBcImNvbnZleFwiKTtcblx0dHJ5IHtcblx0XHRpZiAoZXhpc3RzU3luYyhjb252ZXhQYXRoKSAmJiBzdGF0U3luYyhjb252ZXhQYXRoKS5pc0RpcmVjdG9yeSgpKSB7XG5cdFx0XHRyZXR1cm4gXCJjb252ZXhcIjtcblx0XHR9XG5cdH0gY2F0Y2gge1xuXHRcdC8vIHN0YXQgZXJyb3IgXHUyMDE0IHRyZWF0IGFzIG5vdCBmb3VuZFxuXHR9XG5cdHJldHVybiBcImRvdGVudlwiO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUGFnZWQgc2VjdXJlIGlucHV0IFVJIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFNob3cgYSBzaW5nbGUta2V5IG1hc2tlZCBpbnB1dCBwYWdlIHZpYSBjdHgudWkuY3VzdG9tKCkuXG4gKiBSZXR1cm5zIHRoZSBlbnRlcmVkIHZhbHVlLCBvciBudWxsIGlmIHNraXBwZWQvY2FuY2VsbGVkLlxuICovXG5hc3luYyBmdW5jdGlvbiBjb2xsZWN0T25lU2VjcmV0KFxuXHRjdHg6IHsgdWk6IGFueTsgaGFzVUk6IGJvb2xlYW4gfSxcblx0cGFnZUluZGV4OiBudW1iZXIsXG5cdHRvdGFsUGFnZXM6IG51bWJlcixcblx0a2V5TmFtZTogc3RyaW5nLFxuXHRoaW50OiBzdHJpbmcgfCB1bmRlZmluZWQsXG5cdGd1aWRhbmNlPzogc3RyaW5nW10sXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcblx0aWYgKCFjdHguaGFzVUkpIHJldHVybiBudWxsO1xuXG5cdGNvbnN0IGN1c3RvbVJlc3VsdCA9IGF3YWl0IGN0eC51aS5jdXN0b20oKHR1aTogYW55LCB0aGVtZTogYW55LCBfa2I6IGFueSwgZG9uZTogKHI6IHN0cmluZyB8IG51bGwpID0+IHZvaWQpID0+IHtcblx0XHRsZXQgdmFsdWUgPSBcIlwiO1xuXHRcdGxldCBjYWNoZWRMaW5lczogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG5cblx0XHRjb25zdCBlZGl0b3JUaGVtZTogRWRpdG9yVGhlbWUgPSB7XG5cdFx0XHRib3JkZXJDb2xvcjogKHM6IHN0cmluZykgPT4gdGhlbWUuZmcoXCJhY2NlbnRcIiwgcyksXG5cdFx0XHRzZWxlY3RMaXN0OiB7XG5cdFx0XHRcdHNlbGVjdGVkUHJlZml4OiAodDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcImFjY2VudFwiLCB0KSxcblx0XHRcdFx0c2VsZWN0ZWRUZXh0OiAodDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcImFjY2VudFwiLCB0KSxcblx0XHRcdFx0ZGVzY3JpcHRpb246ICh0OiBzdHJpbmcpID0+IHRoZW1lLmZnKFwibXV0ZWRcIiwgdCksXG5cdFx0XHRcdHNjcm9sbEluZm86ICh0OiBzdHJpbmcpID0+IHRoZW1lLmZnKFwiZGltXCIsIHQpLFxuXHRcdFx0XHRub01hdGNoOiAodDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcIndhcm5pbmdcIiwgdCksXG5cdFx0XHR9LFxuXHRcdH07XG5cdFx0Y29uc3QgZWRpdG9yID0gbmV3IEVkaXRvcih0dWksIGVkaXRvclRoZW1lLCB7IHBhZGRpbmdYOiAxIH0pO1xuXG5cdFx0ZnVuY3Rpb24gcmVmcmVzaCgpIHtcblx0XHRcdGNhY2hlZExpbmVzID0gdW5kZWZpbmVkO1xuXHRcdFx0dHVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHR9XG5cblx0XHRmdW5jdGlvbiBoYW5kbGVJbnB1dChkYXRhOiBzdHJpbmcpIHtcblx0XHRcdGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS5lbnRlcikpIHtcblx0XHRcdFx0dmFsdWUgPSBlZGl0b3IuZ2V0VGV4dCgpLnRyaW0oKTtcblx0XHRcdFx0ZG9uZSh2YWx1ZS5sZW5ndGggPiAwID8gdmFsdWUgOiBudWxsKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0aWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LmVzY2FwZSkpIHtcblx0XHRcdFx0ZG9uZShudWxsKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0Ly8gY3RybCtzID0gc2tpcCB0aGlzIGtleVxuXHRcdFx0aWYgKGRhdGEgPT09IFwiXFx4MTNcIikge1xuXHRcdFx0XHRkb25lKG51bGwpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHRlZGl0b3IuaGFuZGxlSW5wdXQoZGF0YSk7XG5cdFx0XHRyZWZyZXNoKCk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gcmVuZGVyKHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG5cdFx0XHRpZiAoY2FjaGVkTGluZXMpIHJldHVybiBjYWNoZWRMaW5lcztcblx0XHRcdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdFx0Y29uc3QgYWRkID0gKHM6IHN0cmluZykgPT4gbGluZXMucHVzaCh0cnVuY2F0ZVRvV2lkdGgocywgd2lkdGgpKTtcblxuXHRcdFx0YWRkKHRoZW1lLmZnKFwiYWNjZW50XCIsIFwiXHUyNTAwXCIucmVwZWF0KHdpZHRoKSkpO1xuXHRcdFx0YWRkKHRoZW1lLmZnKFwiZGltXCIsIGAgUGFnZSAke3BhZ2VJbmRleCArIDF9LyR7dG90YWxQYWdlc30gXHUwMEI3IFNlY3VyZSBFbnYgU2V0dXBgKSk7XG5cdFx0XHRsaW5lcy5wdXNoKFwiXCIpO1xuXG5cdFx0XHQvLyBLZXkgbmFtZSBhcyBiaWcgaGVhZGVyXG5cdFx0XHRhZGQodGhlbWUuZmcoXCJhY2NlbnRcIiwgdGhlbWUuYm9sZChgICR7a2V5TmFtZX1gKSkpO1xuXHRcdFx0aWYgKGhpbnQpIHtcblx0XHRcdFx0YWRkKHRoZW1lLmZnKFwibXV0ZWRcIiwgYCAgJHtoaW50fWApKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gR3VpZGFuY2Ugc3RlcHMgKG51bWJlcmVkLCBkaW0sIHdyYXBwZWQgZm9yIGxvbmcgVVJMcylcblx0XHRcdGlmIChndWlkYW5jZSAmJiBndWlkYW5jZS5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdGxpbmVzLnB1c2goXCJcIik7XG5cdFx0XHRcdGZvciAobGV0IGcgPSAwOyBnIDwgZ3VpZGFuY2UubGVuZ3RoOyBnKyspIHtcblx0XHRcdFx0XHRjb25zdCBwcmVmaXggPSBgICAke2cgKyAxfS4gYDtcblx0XHRcdFx0XHRjb25zdCBzdGVwID0gZ3VpZGFuY2VbZ10gYXMgc3RyaW5nO1xuXHRcdFx0XHRcdGNvbnN0IHdyYXBwZWRMaW5lcyA9IHdyYXBUZXh0V2l0aEFuc2koc3RlcCwgd2lkdGggLSA0KTtcblx0XHRcdFx0XHRmb3IgKGxldCB3ID0gMDsgdyA8IHdyYXBwZWRMaW5lcy5sZW5ndGg7IHcrKykge1xuXHRcdFx0XHRcdFx0Y29uc3QgaW5kZW50ID0gdyA9PT0gMCA/IHByZWZpeCA6IFwiIFwiLnJlcGVhdChwcmVmaXgubGVuZ3RoKTtcblx0XHRcdFx0XHRcdGxpbmVzLnB1c2godGhlbWUuZmcoXCJkaW1cIiwgYCR7aW5kZW50fSR7d3JhcHBlZExpbmVzW3ddfWApKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0bGluZXMucHVzaChcIlwiKTtcblxuXHRcdFx0Ly8gTWFza2VkIHByZXZpZXdcblx0XHRcdGNvbnN0IHJhdyA9IGVkaXRvci5nZXRUZXh0KCk7XG5cdFx0XHRjb25zdCBwcmV2aWV3ID0gcmF3Lmxlbmd0aCA+IDAgPyBtYXNrUHJldmlldyhyYXcpIDogdGhlbWUuZmcoXCJkaW1cIiwgXCIoZW1wdHkgXHUyMDE0IHByZXNzIGVudGVyIHRvIHNraXApXCIpO1xuXHRcdFx0YWRkKHRoZW1lLmZnKFwidGV4dFwiLCBgICBQcmV2aWV3OiAke3ByZXZpZXd9YCkpO1xuXHRcdFx0bGluZXMucHVzaChcIlwiKTtcblxuXHRcdFx0Ly8gRWRpdG9yXG5cdFx0XHRhZGQodGhlbWUuZmcoXCJtdXRlZFwiLCBcIiBFbnRlciB2YWx1ZTpcIikpO1xuXHRcdFx0Zm9yIChjb25zdCBsaW5lIG9mIGVkaXRvci5yZW5kZXIod2lkdGggLSAyKSkge1xuXHRcdFx0XHRhZGQodGhlbWUuZmcoXCJ0ZXh0XCIsIG1hc2tFZGl0b3JMaW5lKGxpbmUpKSk7XG5cdFx0XHR9XG5cblx0XHRcdGxpbmVzLnB1c2goXCJcIik7XG5cdFx0XHRhZGQodGhlbWUuZmcoXCJkaW1cIiwgYCBlbnRlciB0byBjb25maXJtICB8ICBjdHJsK3Mgb3IgZXNjIHRvIHNraXAgIHwgIGVzYyBjYW5jZWxzYCkpO1xuXHRcdFx0YWRkKHRoZW1lLmZnKFwiYWNjZW50XCIsIFwiXHUyNTAwXCIucmVwZWF0KHdpZHRoKSkpO1xuXG5cdFx0XHRjYWNoZWRMaW5lcyA9IGxpbmVzO1xuXHRcdFx0cmV0dXJuIGxpbmVzO1xuXHRcdH1cblxuXHRcdHJldHVybiB7XG5cdFx0XHRyZW5kZXIsXG5cdFx0XHRpbnZhbGlkYXRlOiAoKSA9PiB7IGNhY2hlZExpbmVzID0gdW5kZWZpbmVkOyB9LFxuXHRcdFx0aGFuZGxlSW5wdXQsXG5cdFx0fTtcblx0fSk7XG5cblx0Ly8gUlBDL3dlYiBzdXJmYWNlcyBtYXkgbm90IGltcGxlbWVudCBjdHgudWkuY3VzdG9tKCkuIEZhbGwgYmFjayB0byBhXG5cdC8vIHN0YW5kYXJkIGlucHV0IHByb21wdCBzbyB1c2VycyBjYW4gc3RpbGwgcHJvdmlkZSB0aGUgc2VjcmV0LlxuXHRpZiAoY3VzdG9tUmVzdWx0ICE9PSB1bmRlZmluZWQpIHtcblx0XHRyZXR1cm4gY3VzdG9tUmVzdWx0O1xuXHR9XG5cblx0aWYgKHR5cGVvZiBjdHgudWk/LmlucHV0ICE9PSBcImZ1bmN0aW9uXCIpIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxuXG5cdGNvbnN0IGlucHV0VGl0bGUgPSBgU2VjdXJlIHZhbHVlIGZvciAke2tleU5hbWV9ICgke3BhZ2VJbmRleCArIDF9LyR7dG90YWxQYWdlc30pYDtcblx0Y29uc3QgaW5wdXRQbGFjZWhvbGRlciA9IGhpbnQgfHwgXCJFbnRlciBzZWNyZXQgdmFsdWVcIjtcblx0Y29uc3QgaW5wdXRSZXN1bHQgPSBhd2FpdCBjdHgudWkuaW5wdXQoXG5cdFx0aW5wdXRUaXRsZSxcblx0XHRpbnB1dFBsYWNlaG9sZGVyLFxuXHRcdHsgc2VjdXJlOiB0cnVlIH0sXG5cdCk7XG5cdGlmICh0eXBlb2YgaW5wdXRSZXN1bHQgIT09IFwic3RyaW5nXCIpIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxuXHRjb25zdCB0cmltbWVkID0gaW5wdXRSZXN1bHQudHJpbSgpO1xuXHRyZXR1cm4gdHJpbW1lZC5sZW5ndGggPiAwID8gdHJpbW1lZCA6IG51bGw7XG59XG5cbi8qKlxuICogRXhwb3J0ZWQgd3JhcHBlciBhcm91bmQgY29sbGVjdE9uZVNlY3JldCBmb3IgdGVzdGluZy5cbiAqIEV4cG9zZXMgdGhlIHNhbWUgaW50ZXJmYWNlIHdpdGggZ3VpZGFuY2UgcGFyYW1ldGVyIGZvciB0ZXN0IHZlcmlmaWNhdGlvbi5cbiAqL1xuZXhwb3J0IGNvbnN0IGNvbGxlY3RPbmVTZWNyZXRXaXRoR3VpZGFuY2UgPSBjb2xsZWN0T25lU2VjcmV0O1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU3VtbWFyeSBTY3JlZW4gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogUmVhZC1vbmx5IHN1bW1hcnkgc2NyZWVuIHNob3dpbmcgYWxsIG1hbmlmZXN0IGVudHJpZXMgd2l0aCBzdGF0dXMgaW5kaWNhdG9ycy5cbiAqIEZvbGxvd3MgdGhlIGNvbmZpcm0tdWkudHMgcGF0dGVybjogcmVuZGVyIFx1MjE5MiBhbnkga2V5IFx1MjE5MiBkb25lLlxuICpcbiAqIFN0YXR1cyBtYXBwaW5nOlxuICogLSBjb2xsZWN0ZWQgXHUyMTkyIGRvbmVcbiAqIC0gcGVuZGluZyAgIFx1MjE5MiBwZW5kaW5nXG4gKiAtIHNraXBwZWQgICBcdTIxOTIgc2tpcHBlZFxuICogLSBleGlzdGluZyBrZXlzIChpbiBleGlzdGluZ0tleXMpIFx1MjE5MiBkb25lIHdpdGggXCJhbHJlYWR5IHNldFwiIGFubm90YXRpb25cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNob3dTZWNyZXRzU3VtbWFyeShcblx0Y3R4OiB7IHVpOiBhbnk7IGhhc1VJOiBib29sZWFuIH0sXG5cdGVudHJpZXM6IFNlY3JldHNNYW5pZmVzdEVudHJ5W10sXG5cdGV4aXN0aW5nS2V5czogc3RyaW5nW10sXG4pOiBQcm9taXNlPHZvaWQ+IHtcblx0aWYgKCFjdHguaGFzVUkpIHJldHVybjtcblxuXHRjb25zdCBleGlzdGluZ1NldCA9IG5ldyBTZXQoZXhpc3RpbmdLZXlzKTtcblxuXHRhd2FpdCBjdHgudWkuY3VzdG9tKChfdHVpOiBhbnksIHRoZW1lOiBUaGVtZSwgX2tiOiBhbnksIGRvbmU6IChyOiBudWxsKSA9PiB2b2lkKSA9PiB7XG5cdFx0bGV0IGNhY2hlZExpbmVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcblxuXHRcdGZ1bmN0aW9uIGhhbmRsZUlucHV0KF9kYXRhOiBzdHJpbmcpIHtcblx0XHRcdC8vIEFueSBrZXkgZGlzbWlzc2VzIFx1MjAxNCBwYXNzIG51bGwgdG8gc2F0aXNmeSB0aGUgdHlwZWQgZG9uZSgpIGNhbGxiYWNrXG5cdFx0XHRkb25lKG51bGwpO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIHJlbmRlcih3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuXHRcdFx0aWYgKGNhY2hlZExpbmVzKSByZXR1cm4gY2FjaGVkTGluZXM7XG5cblx0XHRcdGNvbnN0IHVpID0gbWFrZVVJKHRoZW1lLCB3aWR0aCk7XG5cdFx0XHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblx0XHRcdGNvbnN0IHB1c2ggPSAoLi4ucm93czogc3RyaW5nW11bXSkgPT4geyBmb3IgKGNvbnN0IHIgb2Ygcm93cykgbGluZXMucHVzaCguLi5yKTsgfTtcblxuXHRcdFx0cHVzaCh1aS5iYXIoKSk7XG5cdFx0XHRwdXNoKHVpLmJsYW5rKCkpO1xuXHRcdFx0cHVzaCh1aS5oZWFkZXIoXCIgIFNlY3JldHMgU3VtbWFyeVwiKSk7XG5cdFx0XHRwdXNoKHVpLmJsYW5rKCkpO1xuXG5cdFx0XHRmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcblx0XHRcdFx0bGV0IHN0YXR1czogUHJvZ3Jlc3NTdGF0dXM7XG5cdFx0XHRcdGxldCBkZXRhaWw6IHN0cmluZyB8IHVuZGVmaW5lZDtcblxuXHRcdFx0XHRpZiAoZXhpc3RpbmdTZXQuaGFzKGVudHJ5LmtleSkpIHtcblx0XHRcdFx0XHRzdGF0dXMgPSBcImRvbmVcIjtcblx0XHRcdFx0XHRkZXRhaWwgPSBcImFscmVhZHkgc2V0XCI7XG5cdFx0XHRcdH0gZWxzZSBpZiAoZW50cnkuc3RhdHVzID09PSBcImNvbGxlY3RlZFwiKSB7XG5cdFx0XHRcdFx0c3RhdHVzID0gXCJkb25lXCI7XG5cdFx0XHRcdH0gZWxzZSBpZiAoZW50cnkuc3RhdHVzID09PSBcInNraXBwZWRcIikge1xuXHRcdFx0XHRcdHN0YXR1cyA9IFwic2tpcHBlZFwiO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdHN0YXR1cyA9IFwicGVuZGluZ1wiO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0cHVzaCh1aS5wcm9ncmVzc0l0ZW0oZW50cnkua2V5LCBzdGF0dXMsIHsgZGV0YWlsIH0pKTtcblx0XHRcdH1cblxuXHRcdFx0cHVzaCh1aS5ibGFuaygpKTtcblx0XHRcdHB1c2godWkuaGludHMoW1wiYW55IGtleSB0byBjb250aW51ZVwiXSkpO1xuXHRcdFx0cHVzaCh1aS5iYXIoKSk7XG5cblx0XHRcdGNhY2hlZExpbmVzID0gbGluZXM7XG5cdFx0XHRyZXR1cm4gbGluZXM7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHtcblx0XHRcdHJlbmRlcixcblx0XHRcdGludmFsaWRhdGU6ICgpID0+IHsgY2FjaGVkTGluZXMgPSB1bmRlZmluZWQ7IH0sXG5cdFx0XHRoYW5kbGVJbnB1dCxcblx0XHR9O1xuXHR9KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIERlc3RpbmF0aW9uIFdyaXRlIEhlbHBlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBBcHBseSBjb2xsZWN0ZWQgc2VjcmV0cyB0byB0aGUgdGFyZ2V0IGRlc3RpbmF0aW9uLlxuICogRG90ZW52IHdyaXRlcyBhcmUgaGFuZGxlZCBkaXJlY3RseTsgdmVyY2VsL2NvbnZleCByZXF1aXJlIHBpLmV4ZWMuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGFwcGx5U2VjcmV0cyhcblx0cHJvdmlkZWQ6IEFycmF5PHsga2V5OiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfT4sXG5cdGRlc3RpbmF0aW9uOiBcImRvdGVudlwiIHwgXCJ2ZXJjZWxcIiB8IFwiY29udmV4XCIsXG5cdG9wdHM6IHtcblx0XHRlbnZGaWxlUGF0aDogc3RyaW5nO1xuXHRcdGVudmlyb25tZW50Pzogc3RyaW5nO1xuXHRcdGV4ZWM/OiAoY21kOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdKSA9PiBQcm9taXNlPHsgY29kZTogbnVtYmVyOyBzdGRlcnI6IHN0cmluZyB9Pjtcblx0fSxcbik6IFByb21pc2U8eyBhcHBsaWVkOiBzdHJpbmdbXTsgZXJyb3JzOiBzdHJpbmdbXSB9PiB7XG5cdGNvbnN0IGFwcGxpZWQ6IHN0cmluZ1tdID0gW107XG5cdGNvbnN0IGVycm9yczogc3RyaW5nW10gPSBbXTtcblxuXHRpZiAoZGVzdGluYXRpb24gPT09IFwiZG90ZW52XCIpIHtcblx0XHRmb3IgKGNvbnN0IHsga2V5LCB2YWx1ZSB9IG9mIHByb3ZpZGVkKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRhd2FpdCB3cml0ZUVudktleShvcHRzLmVudkZpbGVQYXRoLCBrZXksIHZhbHVlKTtcblx0XHRcdFx0YXBwbGllZC5wdXNoKGtleSk7XG5cdFx0XHRcdGh5ZHJhdGVQcm9jZXNzRW52KGtleSwgdmFsdWUpO1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0ZXJyb3JzLnB1c2goYCR7a2V5fTogJHtlcnIubWVzc2FnZX1gKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRpZiAoKGRlc3RpbmF0aW9uID09PSBcInZlcmNlbFwiIHx8IGRlc3RpbmF0aW9uID09PSBcImNvbnZleFwiKSAmJiBvcHRzLmV4ZWMpIHtcblx0XHRjb25zdCBlbnYgPSBvcHRzLmVudmlyb25tZW50ID8/IFwiZGV2ZWxvcG1lbnRcIjtcblx0XHRpZiAoIWlzU3VwcG9ydGVkRGVwbG95bWVudEVudmlyb25tZW50KGVudikpIHtcblx0XHRcdGVycm9ycy5wdXNoKGBlbnZpcm9ubWVudDogdW5zdXBwb3J0ZWQgdGFyZ2V0IGVudmlyb25tZW50IFwiJHtlbnZ9XCJgKTtcblx0XHRcdHJldHVybiB7IGFwcGxpZWQsIGVycm9ycyB9O1xuXHRcdH1cblx0XHRmb3IgKGNvbnN0IHsga2V5LCB2YWx1ZSB9IG9mIHByb3ZpZGVkKSB7XG5cdFx0XHRpZiAoIWlzU2FmZUVudlZhcktleShrZXkpKSB7XG5cdFx0XHRcdGVycm9ycy5wdXNoKGAke2tleX06IGludmFsaWQgZW52aXJvbm1lbnQgdmFyaWFibGUgbmFtZWApO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGNtZCA9IGRlc3RpbmF0aW9uID09PSBcInZlcmNlbFwiXG5cdFx0XHRcdD8gYHByaW50ZiAlcyAke3NoZWxsRXNjYXBlU2luZ2xlKHZhbHVlKX0gfCB2ZXJjZWwgZW52IGFkZCAke2tleX0gJHtlbnZ9YFxuXHRcdFx0XHQ6IFwiXCI7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCByZXN1bHQgPSBkZXN0aW5hdGlvbiA9PT0gXCJ2ZXJjZWxcIlxuXHRcdFx0XHRcdD8gYXdhaXQgb3B0cy5leGVjKFwic2hcIiwgW1wiLWNcIiwgY21kXSlcblx0XHRcdFx0XHQ6IGF3YWl0IG9wdHMuZXhlYyhcIm5weFwiLCBbXCJjb252ZXhcIiwgXCJlbnZcIiwgXCJzZXRcIiwga2V5LCB2YWx1ZV0pO1xuXHRcdFx0XHRpZiAocmVzdWx0LmNvZGUgIT09IDApIHtcblx0XHRcdFx0XHRlcnJvcnMucHVzaChgJHtrZXl9OiAke3Jlc3VsdC5zdGRlcnIuc2xpY2UoMCwgMjAwKX1gKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRhcHBsaWVkLnB1c2goa2V5KTtcblx0XHRcdFx0XHRoeWRyYXRlUHJvY2Vzc0VudihrZXksIHZhbHVlKTtcblx0XHRcdFx0fVxuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0ZXJyb3JzLnB1c2goYCR7a2V5fTogJHtlcnIubWVzc2FnZX1gKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRyZXR1cm4geyBhcHBsaWVkLCBlcnJvcnMgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE1hbmlmZXN0IE9yY2hlc3RyYXRvciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBGdWxsIG9yY2hlc3RyYXRvcjogcmVhZHMgbWFuaWZlc3QsIGNoZWNrcyBlbnYsIHNob3dzIHN1bW1hcnksIGNvbGxlY3RzXG4gKiBvbmx5IHBlbmRpbmcga2V5cyAod2l0aCBndWlkYW5jZSArIGhpbnQpLCB1cGRhdGVzIG1hbmlmZXN0IHN0YXR1c2VzLFxuICogd3JpdGVzIGJhY2ssIGFuZCBhcHBsaWVzIGNvbGxlY3RlZCB2YWx1ZXMgdG8gdGhlIGRlc3RpbmF0aW9uLlxuICpcbiAqIFJldHVybnMgYSBzdHJ1Y3R1cmVkIHJlc3VsdCBtYXRjaGluZyB0aGUgdG9vbCByZXN1bHQgc2hhcGUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb2xsZWN0U2VjcmV0c0Zyb21NYW5pZmVzdChcblx0YmFzZTogc3RyaW5nLFxuXHRtaWxlc3RvbmVJZDogc3RyaW5nLFxuXHRjdHg6IHsgdWk6IGFueTsgaGFzVUk6IGJvb2xlYW47IGN3ZDogc3RyaW5nIH0sXG4pOiBQcm9taXNlPHsgYXBwbGllZDogc3RyaW5nW107IHNraXBwZWQ6IHN0cmluZ1tdOyBleGlzdGluZ1NraXBwZWQ6IHN0cmluZ1tdIH0+IHtcblx0Ly8gKGEpIFJlc29sdmUgbWFuaWZlc3QgcGF0aFxuXHRjb25zdCBtYW5pZmVzdFBhdGggPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlLCBtaWxlc3RvbmVJZCwgXCJTRUNSRVRTXCIpO1xuXHRpZiAoIW1hbmlmZXN0UGF0aCkge1xuXHRcdHRocm93IG5ldyBFcnJvcihgU2VjcmV0cyBtYW5pZmVzdCBub3QgZm91bmQgZm9yIG1pbGVzdG9uZSAke21pbGVzdG9uZUlkfSBpbiAke2Jhc2V9YCk7XG5cdH1cblxuXHQvLyAoYikgUmVhZCBhbmQgcGFyc2UgbWFuaWZlc3Rcblx0Y29uc3QgY29udGVudCA9IGF3YWl0IHJlYWRGaWxlKG1hbmlmZXN0UGF0aCwgXCJ1dGY4XCIpO1xuXHRjb25zdCBtYW5pZmVzdCA9IHBhcnNlU2VjcmV0c01hbmlmZXN0KGNvbnRlbnQpO1xuXG5cdC8vIChjKSBDaGVjayBleGlzdGluZyBrZXlzXG5cdGNvbnN0IGVudlBhdGggPSByZXNvbHZlKGJhc2UsIFwiLmVudlwiKTtcblx0Y29uc3QgYWxsS2V5cyA9IG1hbmlmZXN0LmVudHJpZXMubWFwKChlKSA9PiBlLmtleSk7XG5cdGNvbnN0IGV4aXN0aW5nS2V5cyA9IGF3YWl0IGNoZWNrRXhpc3RpbmdFbnZLZXlzKGFsbEtleXMsIGVudlBhdGgpO1xuXHRjb25zdCBleGlzdGluZ1NldCA9IG5ldyBTZXQoZXhpc3RpbmdLZXlzKTtcblxuXHQvLyAoZCkgQnVpbGQgY2F0ZWdvcml6YXRpb25cblx0Y29uc3QgZXhpc3RpbmdTa2lwcGVkOiBzdHJpbmdbXSA9IFtdO1xuXHRjb25zdCBhbHJlYWR5U2tpcHBlZDogc3RyaW5nW10gPSBbXTtcblx0Y29uc3QgcGVuZGluZ0VudHJpZXM6IFNlY3JldHNNYW5pZmVzdEVudHJ5W10gPSBbXTtcblxuXHRmb3IgKGNvbnN0IGVudHJ5IG9mIG1hbmlmZXN0LmVudHJpZXMpIHtcblx0XHRpZiAoZXhpc3RpbmdTZXQuaGFzKGVudHJ5LmtleSkpIHtcblx0XHRcdGV4aXN0aW5nU2tpcHBlZC5wdXNoKGVudHJ5LmtleSk7XG5cdFx0fSBlbHNlIGlmIChlbnRyeS5zdGF0dXMgPT09IFwic2tpcHBlZFwiKSB7XG5cdFx0XHRhbHJlYWR5U2tpcHBlZC5wdXNoKGVudHJ5LmtleSk7XG5cdFx0fSBlbHNlIGlmIChlbnRyeS5zdGF0dXMgPT09IFwicGVuZGluZ1wiKSB7XG5cdFx0XHRwZW5kaW5nRW50cmllcy5wdXNoKGVudHJ5KTtcblx0XHR9XG5cdFx0Ly8gY29sbGVjdGVkIGVudHJpZXMgdGhhdCBhcmUgbm90IGluIGVudiBhcmUgbGVmdCBhcy1pc1xuXHR9XG5cblx0Ly8gKGUpIFNob3cgc3VtbWFyeSBzY3JlZW5cblx0YXdhaXQgc2hvd1NlY3JldHNTdW1tYXJ5KGN0eCwgbWFuaWZlc3QuZW50cmllcywgZXhpc3RpbmdLZXlzKTtcblxuXHQvLyAoZikgRGV0ZWN0IGRlc3RpbmF0aW9uXG5cdGNvbnN0IGRlc3RpbmF0aW9uID0gZGV0ZWN0RGVzdGluYXRpb24oY3R4LmN3ZCk7XG5cblx0Ly8gKGcpIENvbGxlY3Qgb25seSBwZW5kaW5nIGtleXMgdGhhdCBhcmUgbm90IGFscmVhZHkgZXhpc3Rpbmdcblx0Y29uc3QgY29sbGVjdGVkOiBDb2xsZWN0ZWRTZWNyZXRbXSA9IFtdO1xuXHRmb3IgKGxldCBpID0gMDsgaSA8IHBlbmRpbmdFbnRyaWVzLmxlbmd0aDsgaSsrKSB7XG5cdFx0Y29uc3QgZW50cnkgPSBwZW5kaW5nRW50cmllc1tpXSBhcyBTZWNyZXRzTWFuaWZlc3RFbnRyeTtcblx0XHRjb25zdCB2YWx1ZSA9IGF3YWl0IGNvbGxlY3RPbmVTZWNyZXQoXG5cdFx0XHRjdHgsXG5cdFx0XHRpLFxuXHRcdFx0cGVuZGluZ0VudHJpZXMubGVuZ3RoLFxuXHRcdFx0ZW50cnkua2V5LFxuXHRcdFx0ZW50cnkuZm9ybWF0SGludCB8fCB1bmRlZmluZWQsXG5cdFx0XHRlbnRyeS5ndWlkYW5jZS5sZW5ndGggPiAwID8gZW50cnkuZ3VpZGFuY2UgOiB1bmRlZmluZWQsXG5cdFx0KTtcblx0XHRjb2xsZWN0ZWQucHVzaCh7IGtleTogZW50cnkua2V5LCB2YWx1ZSB9KTtcblx0fVxuXG5cdC8vIChoKSBVcGRhdGUgbWFuaWZlc3QgZW50cnkgc3RhdHVzZXNcblx0Zm9yIChjb25zdCB7IGtleSwgdmFsdWUgfSBvZiBjb2xsZWN0ZWQpIHtcblx0XHRjb25zdCBlbnRyeSA9IG1hbmlmZXN0LmVudHJpZXMuZmluZCgoZSkgPT4gZS5rZXkgPT09IGtleSk7XG5cdFx0aWYgKGVudHJ5KSB7XG5cdFx0XHRlbnRyeS5zdGF0dXMgPSB2YWx1ZSAhPSBudWxsID8gXCJjb2xsZWN0ZWRcIiA6IFwic2tpcHBlZFwiO1xuXHRcdH1cblx0fVxuXG5cdC8vIChpKSBXcml0ZSBtYW5pZmVzdCBiYWNrIHRvIGRpc2tcblx0YXdhaXQgd3JpdGVGaWxlKG1hbmlmZXN0UGF0aCwgZm9ybWF0U2VjcmV0c01hbmlmZXN0KG1hbmlmZXN0KSwgXCJ1dGY4XCIpO1xuXG5cdC8vIChqKSBBcHBseSBjb2xsZWN0ZWQgdmFsdWVzIHRvIGRlc3RpbmF0aW9uXG5cdGNvbnN0IHByb3ZpZGVkID0gY29sbGVjdGVkLmZpbHRlcigoYykgPT4gYy52YWx1ZSAhPSBudWxsKSBhcyBBcnJheTx7IGtleTogc3RyaW5nOyB2YWx1ZTogc3RyaW5nIH0+O1xuXHRjb25zdCB7IGFwcGxpZWQgfSA9IGF3YWl0IGFwcGx5U2VjcmV0cyhwcm92aWRlZCwgZGVzdGluYXRpb24sIHtcblx0XHRlbnZGaWxlUGF0aDogcmVzb2x2ZShjdHguY3dkLCBcIi5lbnZcIiksXG5cdH0pO1xuXG5cdGNvbnN0IHNraXBwZWQgPSBbXG5cdFx0Li4uYWxyZWFkeVNraXBwZWQsXG5cdFx0Li4uY29sbGVjdGVkLmZpbHRlcigoYykgPT4gYy52YWx1ZSA9PSBudWxsKS5tYXAoKGMpID0+IGMua2V5KSxcblx0XTtcblxuXHRyZXR1cm4geyBhcHBsaWVkLCBza2lwcGVkLCBleGlzdGluZ1NraXBwZWQgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEV4dGVuc2lvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gc2VjdXJlRW52KHBpOiBFeHRlbnNpb25BUEkpIHtcblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcInNlY3VyZV9lbnZfY29sbGVjdFwiLFxuXHRcdGxhYmVsOiBcIlNlY3VyZSBFbnYgQ29sbGVjdFwiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJDb2xsZWN0IG9uZSBvciBtb3JlIGVudiB2YXJzIHRocm91Z2ggYSBwYWdlZCBtYXNrZWQtaW5wdXQgVUksIHRoZW4gd3JpdGUgdGhlbSB0byAuZW52LCBWZXJjZWwsIG9yIENvbnZleC4gXCIgK1xuXHRcdFx0XCJWYWx1ZXMgYXJlIHNob3duIG1hc2tlZCB0byB0aGUgdXNlciAoZS5nLiBzay1pcioqKmRnZGgpIGFuZCBuZXZlciBlY2hvZWQgaW4gdG9vbCBvdXRwdXQuXCIsXG5cdFx0cHJvbXB0U25pcHBldDogXCJDb2xsZWN0IGFuZCBhcHBseSBlbnYgdmFycyBzZWN1cmVseSB3aXRob3V0IGFza2luZyB1c2VyIHRvIGVkaXQgZmlsZXMgbWFudWFsbHkuXCIsXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJORVZFUiBhc2sgdGhlIHVzZXIgdG8gbWFudWFsbHkgZWRpdCAuZW52IGZpbGVzLCBjb3B5LXBhc3RlIGludG8gYSB0ZXJtaW5hbCwgb3Igb3BlbiBhIGRhc2hib2FyZCB0byBzZXQgZW52IHZhcnMuIEFsd2F5cyB1c2Ugc2VjdXJlX2Vudl9jb2xsZWN0IGluc3RlYWQuXCIsXG5cdFx0XHRcIldoZW4gYSBjb21tYW5kIGZhaWxzIGR1ZSB0byBhIG1pc3NpbmcgZW52IHZhciAoZS5nLiAnT1BFTkFJX0FQSV9LRVkgaXMgbm90IHNldCcsICdNaXNzaW5nIHJlcXVpcmVkIGVudmlyb25tZW50IHZhcmlhYmxlJywgJ0ludmFsaWQgQVBJIGtleScsICdhdXRoZW50aWNhdGlvbiByZXF1aXJlZCcpLCBpbW1lZGlhdGVseSBjYWxsIHNlY3VyZV9lbnZfY29sbGVjdCB3aXRoIHRoZSBtaXNzaW5nIGtleXMgYmVmb3JlIHJldHJ5aW5nLlwiLFxuXHRcdFx0XCJXaGVuIHN0YXJ0aW5nIGEgbmV3IHByb2plY3Qgb3IgcnVubmluZyBzZXR1cCBzdGVwcyB0aGF0IHJlcXVpcmUgc2VjcmV0cyAoQVBJIGtleXMsIHRva2VucywgZGF0YWJhc2UgVVJMcyksIHByb2FjdGl2ZWx5IGNhbGwgc2VjdXJlX2Vudl9jb2xsZWN0IGJlZm9yZSB0aGUgZmlyc3QgY29tbWFuZCB0aGF0IG5lZWRzIHRoZW0uXCIsXG5cdFx0XHRcIkRldGVjdCB0aGUgcmlnaHQgZGVzdGluYXRpb246IHVzZSAnZG90ZW52JyBmb3IgbG9jYWwgZGV2LCAndmVyY2VsJyB3aGVuIGRlcGxveWluZyB0byBWZXJjZWwsICdjb252ZXgnIHdoZW4gdXNpbmcgQ29udmV4IGJhY2tlbmQuXCIsXG5cdFx0XHRcIkFmdGVyIHNlY3VyZV9lbnZfY29sbGVjdCBjb21wbGV0ZXMsIHJlLXJ1biB0aGUgb3JpZ2luYWxseSBibG9ja2VkIGNvbW1hbmQgdG8gdmVyaWZ5IHRoZSBmaXggd29ya2VkLlwiLFxuXHRcdFx0XCJOZXZlciBlY2hvLCBsb2csIG9yIHJlcGVhdCBzZWNyZXQgdmFsdWVzIGluIHlvdXIgcmVzcG9uc2VzLiBPbmx5IHJlcG9ydCBrZXkgbmFtZXMgYW5kIGFwcGxpZWQvc2tpcHBlZCBzdGF0dXMuXCIsXG5cdFx0XSxcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRkZXN0aW5hdGlvbjogVHlwZS5PcHRpb25hbChUeXBlLlVuaW9uKFtcblx0XHRcdFx0VHlwZS5MaXRlcmFsKFwiZG90ZW52XCIpLFxuXHRcdFx0XHRUeXBlLkxpdGVyYWwoXCJ2ZXJjZWxcIiksXG5cdFx0XHRcdFR5cGUuTGl0ZXJhbChcImNvbnZleFwiKSxcblx0XHRcdF0sIHsgZGVzY3JpcHRpb246IFwiV2hlcmUgdG8gd3JpdGUgdGhlIGNvbGxlY3RlZCBzZWNyZXRzXCIgfSkpLFxuXHRcdFx0a2V5czogVHlwZS5BcnJheShcblx0XHRcdFx0VHlwZS5PYmplY3Qoe1xuXHRcdFx0XHRcdGtleTogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJFbnYgdmFyIG5hbWUsIGUuZy4gT1BFTkFJX0FQSV9LRVlcIiB9KSxcblx0XHRcdFx0XHRoaW50OiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiRm9ybWF0IGhpbnQgc2hvd24gdG8gdXNlciwgZS5nLiAnc3RhcnRzIHdpdGggc2stJ1wiIH0pKSxcblx0XHRcdFx0XHRyZXF1aXJlZDogVHlwZS5PcHRpb25hbChUeXBlLkJvb2xlYW4oKSksXG5cdFx0XHRcdFx0Z3VpZGFuY2U6IFR5cGUuT3B0aW9uYWwoVHlwZS5BcnJheShUeXBlLlN0cmluZygpLCB7IGRlc2NyaXB0aW9uOiBcIlN0ZXAtYnktc3RlcCBndWlkYW5jZSBmb3IgZmluZGluZyB0aGlzIGtleVwiIH0pKSxcblx0XHRcdFx0fSksXG5cdFx0XHRcdHsgbWluSXRlbXM6IDEgfSxcblx0XHRcdCksXG5cdFx0XHRlbnZGaWxlUGF0aDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlBhdGggdG8gLmVudiBmaWxlIChkb3RlbnYgb25seSkuIERlZmF1bHRzIHRvIC5lbnYgaW4gY3dkLlwiIH0pKSxcblx0XHRcdGVudmlyb25tZW50OiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlVuaW9uKFtcblx0XHRcdFx0XHRUeXBlLkxpdGVyYWwoXCJkZXZlbG9wbWVudFwiKSxcblx0XHRcdFx0XHRUeXBlLkxpdGVyYWwoXCJwcmV2aWV3XCIpLFxuXHRcdFx0XHRcdFR5cGUuTGl0ZXJhbChcInByb2R1Y3Rpb25cIiksXG5cdFx0XHRcdF0sIHsgZGVzY3JpcHRpb246IFwiVGFyZ2V0IGVudmlyb25tZW50ICh2ZXJjZWwgb25seSlcIiB9KSxcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgY3R4KSB7XG5cdFx0XHRpZiAoIWN0eC5oYXNVSSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkVycm9yOiBVSSBub3QgYXZhaWxhYmxlIChpbnRlcmFjdGl2ZSBtb2RlIHJlcXVpcmVkIGZvciBzZWN1cmUgZW52IGNvbGxlY3Rpb24pLlwiIH1dLFxuXHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0ZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24sXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cblx0XHRcdC8vIEF1dG8tZGV0ZWN0IGRlc3RpbmF0aW9uIHdoZW4gbm90IHByb3ZpZGVkXG5cdFx0XHRjb25zdCBkZXN0aW5hdGlvbkF1dG9EZXRlY3RlZCA9IHBhcmFtcy5kZXN0aW5hdGlvbiA9PSBudWxsO1xuXHRcdFx0Y29uc3QgZGVzdGluYXRpb24gPSBwYXJhbXMuZGVzdGluYXRpb24gPz8gZGV0ZWN0RGVzdGluYXRpb24oY3R4LmN3ZCk7XG5cblx0XHRcdGNvbnN0IGNvbGxlY3RlZDogQ29sbGVjdGVkU2VjcmV0W10gPSBbXTtcblxuXHRcdFx0Ly8gQ29sbGVjdCBvbmUga2V5IHBlciBwYWdlXG5cdFx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHBhcmFtcy5rZXlzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRcdGNvbnN0IGl0ZW0gPSBwYXJhbXMua2V5c1tpXTtcblx0XHRcdFx0Y29uc3QgdmFsdWUgPSBhd2FpdCBjb2xsZWN0T25lU2VjcmV0KGN0eCwgaSwgcGFyYW1zLmtleXMubGVuZ3RoLCBpdGVtLmtleSwgaXRlbS5oaW50LCBpdGVtLmd1aWRhbmNlKTtcblx0XHRcdFx0Y29sbGVjdGVkLnB1c2goeyBrZXk6IGl0ZW0ua2V5LCB2YWx1ZSB9KTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgcHJvdmlkZWQgPSBjb2xsZWN0ZWQuZmlsdGVyKChjKSA9PiBjLnZhbHVlICE9IG51bGwpIGFzIEFycmF5PHsga2V5OiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfT47XG5cdFx0XHRjb25zdCBza2lwcGVkID0gY29sbGVjdGVkLmZpbHRlcigoYykgPT4gYy52YWx1ZSA9PSBudWxsKS5tYXAoKGMpID0+IGMua2V5KTtcblxuXHRcdFx0Ly8gQXBwbHkgdG8gZGVzdGluYXRpb24gdmlhIHNoYXJlZCBoZWxwZXJcblx0XHRcdGNvbnN0IHsgYXBwbGllZCwgZXJyb3JzIH0gPSBhd2FpdCBhcHBseVNlY3JldHMocHJvdmlkZWQsIGRlc3RpbmF0aW9uLCB7XG5cdFx0XHRcdGVudkZpbGVQYXRoOiByZXNvbHZlKGN0eC5jd2QsIHBhcmFtcy5lbnZGaWxlUGF0aCA/PyBcIi5lbnZcIiksXG5cdFx0XHRcdGVudmlyb25tZW50OiBwYXJhbXMuZW52aXJvbm1lbnQsXG5cdFx0XHRcdGV4ZWM6IChjbWQsIGFyZ3MpID0+IHBpLmV4ZWMoY21kLCBhcmdzKSxcblx0XHRcdH0pO1xuXG5cdFx0XHRjb25zdCBkZXRhaWxzOiBUb29sUmVzdWx0RGV0YWlscyA9IHtcblx0XHRcdFx0ZGVzdGluYXRpb24sXG5cdFx0XHRcdGVudmlyb25tZW50OiBwYXJhbXMuZW52aXJvbm1lbnQsXG5cdFx0XHRcdGFwcGxpZWQsXG5cdFx0XHRcdHNraXBwZWQsXG5cdFx0XHRcdC4uLihkZXN0aW5hdGlvbkF1dG9EZXRlY3RlZCA/IHsgZGV0ZWN0ZWREZXN0aW5hdGlvbjogZGVzdGluYXRpb24gfSA6IHt9KSxcblx0XHRcdH07XG5cblx0XHRcdGNvbnN0IGxpbmVzID0gW1xuXHRcdFx0XHRgZGVzdGluYXRpb246ICR7ZGVzdGluYXRpb259JHtkZXN0aW5hdGlvbkF1dG9EZXRlY3RlZCA/IFwiIChhdXRvLWRldGVjdGVkKVwiIDogXCJcIn0ke3BhcmFtcy5lbnZpcm9ubWVudCA/IGAgKCR7cGFyYW1zLmVudmlyb25tZW50fSlgIDogXCJcIn1gLFxuXHRcdFx0XHQuLi5hcHBsaWVkLm1hcCgoaykgPT4gYFx1MjcxMyAke2t9OiBhcHBsaWVkYCksXG5cdFx0XHRcdC4uLnNraXBwZWQubWFwKChrKSA9PiBgXHUyMDIyICR7a306IHNraXBwZWRgKSxcblx0XHRcdFx0Li4uZXJyb3JzLm1hcCgoZSkgPT4gYFx1MjcxNyAke2V9YCksXG5cdFx0XHRdO1xuXG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogbGluZXMuam9pbihcIlxcblwiKSB9XSxcblx0XHRcdFx0ZGV0YWlscyxcblx0XHRcdFx0aXNFcnJvcjogZXJyb3JzLmxlbmd0aCA+IDAgJiYgYXBwbGllZC5sZW5ndGggPT09IDAsXG5cdFx0XHR9O1xuXHRcdH0sXG5cblx0XHRyZW5kZXJDYWxsKGFyZ3MsIHRoZW1lKSB7XG5cdFx0XHRjb25zdCBjb3VudCA9IEFycmF5LmlzQXJyYXkoYXJncy5rZXlzKSA/IGFyZ3Mua2V5cy5sZW5ndGggOiAwO1xuXHRcdFx0cmV0dXJuIG5ldyBUZXh0KFxuXHRcdFx0XHR0aGVtZS5mZyhcInRvb2xUaXRsZVwiLCB0aGVtZS5ib2xkKFwic2VjdXJlX2Vudl9jb2xsZWN0IFwiKSkgK1xuXHRcdFx0XHR0aGVtZS5mZyhcIm11dGVkXCIsIGBcdTIxOTIgJHthcmdzLmRlc3RpbmF0aW9uID8/IFwiYXV0b1wifWApICtcblx0XHRcdFx0dGhlbWUuZmcoXCJkaW1cIiwgYCAgJHtjb3VudH0ga2V5JHtjb3VudCAhPT0gMSA/IFwic1wiIDogXCJcIn1gKSxcblx0XHRcdFx0MCwgMCxcblx0XHRcdCk7XG5cdFx0fSxcblxuXHRcdHJlbmRlclJlc3VsdChyZXN1bHQsIF9vcHRpb25zLCB0aGVtZSkge1xuXHRcdFx0Y29uc3QgZGV0YWlscyA9IHJlc3VsdC5kZXRhaWxzIGFzIFRvb2xSZXN1bHREZXRhaWxzIHwgdW5kZWZpbmVkO1xuXHRcdFx0aWYgKCFkZXRhaWxzKSB7XG5cdFx0XHRcdGNvbnN0IHQgPSByZXN1bHQuY29udGVudFswXTtcblx0XHRcdFx0cmV0dXJuIG5ldyBUZXh0KHQ/LnR5cGUgPT09IFwidGV4dFwiID8gdC50ZXh0IDogXCJcIiwgMCwgMCk7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBsaW5lcyA9IFtcblx0XHRcdFx0YCR7dGhlbWUuZmcoXCJzdWNjZXNzXCIsIFwiXHUyNzEzXCIpfSAke2RldGFpbHMuZGVzdGluYXRpb259JHtkZXRhaWxzLmVudmlyb25tZW50ID8gYCAoJHtkZXRhaWxzLmVudmlyb25tZW50fSlgIDogXCJcIn1gLFxuXHRcdFx0XHQuLi5kZXRhaWxzLmFwcGxpZWQubWFwKChrKSA9PiBgICAke3RoZW1lLmZnKFwic3VjY2Vzc1wiLCBcIlx1MjcxM1wiKX0gJHtrfTogYXBwbGllZGApLFxuXHRcdFx0XHQuLi5kZXRhaWxzLnNraXBwZWQubWFwKChrKSA9PiBgICAke3RoZW1lLmZnKFwid2FybmluZ1wiLCBcIlx1MjAyMlwiKX0gJHtrfTogc2tpcHBlZGApLFxuXHRcdFx0XTtcblx0XHRcdHJldHVybiBuZXcgVGV4dChsaW5lcy5qb2luKFwiXFxuXCIpLCAwLCAwKTtcblx0XHR9LFxuXHR9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVFBLFNBQVMsVUFBVSxpQkFBaUI7QUFDcEMsU0FBUyxZQUFZLGdCQUFnQjtBQUNyQyxTQUFTLGVBQWU7QUFHeEIsU0FBUyxRQUEwQixLQUFLLFlBQVksTUFBTSxpQkFBaUIsd0JBQXdCO0FBQ25HLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxzQkFBMkM7QUFDcEQsU0FBUyxzQkFBc0IsNkJBQTZCO0FBQzVELFNBQVMsNEJBQTRCO0FBcUJyQyxTQUFTLFlBQVksT0FBdUI7QUFDM0MsTUFBSSxDQUFDLE1BQU8sUUFBTztBQUNuQixNQUFJLE1BQU0sVUFBVSxFQUFHLFFBQU8sSUFBSSxPQUFPLE1BQU0sTUFBTTtBQUNyRCxTQUFPLEdBQUcs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
