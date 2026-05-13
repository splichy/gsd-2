import * as fs from "node:fs";
import * as path from "node:path";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import chalk from "chalk";
import {
  highlightCode as nativeHighlightCode,
  supportsLanguage
} from "@gsd/native";
import { getCustomThemesDir } from "../../../config.js";
import { ThemeJsonSchema } from "./theme-schema.js";
import { builtinThemes } from "./themes.js";
const NATIVE_TUI_HIGHLIGHT_ENABLED = process.env.GSD_ENABLE_NATIVE_TUI_HIGHLIGHT === "1";
const validateThemeJson = TypeCompiler.Compile(ThemeJsonSchema);
function detectColorMode() {
  const colorterm = process.env.COLORTERM;
  if (colorterm === "truecolor" || colorterm === "24bit") {
    return "truecolor";
  }
  if (process.env.WT_SESSION) {
    return "truecolor";
  }
  const term = process.env.TERM || "";
  if (term === "dumb" || term === "" || term === "linux") {
    return "256color";
  }
  if (process.env.TERM_PROGRAM === "Apple_Terminal") {
    return "256color";
  }
  if (term === "screen" || term.startsWith("screen-") || term.startsWith("screen.")) {
    return "256color";
  }
  return "truecolor";
}
function hexToRgb(hex) {
  const cleaned = hex.replace("#", "");
  if (cleaned.length !== 6) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const r = parseInt(cleaned.substring(0, 2), 16);
  const g = parseInt(cleaned.substring(2, 4), 16);
  const b = parseInt(cleaned.substring(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return { r, g, b };
}
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);
function findClosestCubeIndex(value) {
  let minDist = Infinity;
  let minIdx = 0;
  for (let i = 0; i < CUBE_VALUES.length; i++) {
    const dist = Math.abs(value - CUBE_VALUES[i]);
    if (dist < minDist) {
      minDist = dist;
      minIdx = i;
    }
  }
  return minIdx;
}
function findClosestGrayIndex(gray) {
  let minDist = Infinity;
  let minIdx = 0;
  for (let i = 0; i < GRAY_VALUES.length; i++) {
    const dist = Math.abs(gray - GRAY_VALUES[i]);
    if (dist < minDist) {
      minDist = dist;
      minIdx = i;
    }
  }
  return minIdx;
}
function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}
function rgbTo256(r, g, b) {
  const rIdx = findClosestCubeIndex(r);
  const gIdx = findClosestCubeIndex(g);
  const bIdx = findClosestCubeIndex(b);
  const cubeR = CUBE_VALUES[rIdx];
  const cubeG = CUBE_VALUES[gIdx];
  const cubeB = CUBE_VALUES[bIdx];
  const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
  const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  const grayIdx = findClosestGrayIndex(gray);
  const grayValue = GRAY_VALUES[grayIdx];
  const grayIndex = 232 + grayIdx;
  const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const spread = maxC - minC;
  if (spread < 10 && grayDist < cubeDist) {
    return grayIndex;
  }
  return cubeIndex;
}
function hexTo256(hex) {
  const { r, g, b } = hexToRgb(hex);
  return rgbTo256(r, g, b);
}
function fgAnsi(color, mode) {
  if (color === "") return "\x1B[39m";
  if (typeof color === "number") return `\x1B[38;5;${color}m`;
  if (color.startsWith("#")) {
    if (mode === "truecolor") {
      const { r, g, b } = hexToRgb(color);
      return `\x1B[38;2;${r};${g};${b}m`;
    } else {
      const index = hexTo256(color);
      return `\x1B[38;5;${index}m`;
    }
  }
  throw new Error(`Invalid color value: ${color}`);
}
function bgAnsi(color, mode) {
  if (color === "") return "\x1B[49m";
  if (typeof color === "number") return `\x1B[48;5;${color}m`;
  if (color.startsWith("#")) {
    if (mode === "truecolor") {
      const { r, g, b } = hexToRgb(color);
      return `\x1B[48;2;${r};${g};${b}m`;
    } else {
      const index = hexTo256(color);
      return `\x1B[48;5;${index}m`;
    }
  }
  throw new Error(`Invalid color value: ${color}`);
}
function resolveVarRefs(value, vars, visited = /* @__PURE__ */ new Set()) {
  if (typeof value === "number" || value === "" || value.startsWith("#")) {
    return value;
  }
  if (visited.has(value)) {
    throw new Error(`Circular variable reference detected: ${value}`);
  }
  if (!(value in vars)) {
    throw new Error(`Variable reference not found: ${value}`);
  }
  visited.add(value);
  return resolveVarRefs(vars[value], vars, visited);
}
function resolveThemeColors(colors, vars = {}) {
  const resolved = {};
  for (const [key, value] of Object.entries(colors)) {
    resolved[key] = resolveVarRefs(value, vars);
  }
  return resolved;
}
class Theme {
  constructor(fgColors, bgColors, mode, options = {}) {
    this.name = options.name;
    this.sourcePath = options.sourcePath;
    this.mode = mode;
    this.fgColors = /* @__PURE__ */ new Map();
    for (const [key, value] of Object.entries(fgColors)) {
      this.fgColors.set(key, fgAnsi(value, mode));
    }
    this.bgColors = /* @__PURE__ */ new Map();
    for (const [key, value] of Object.entries(bgColors)) {
      this.bgColors.set(key, bgAnsi(value, mode));
    }
  }
  fg(color, text) {
    const ansi = this.fgColors.get(color);
    if (!ansi) throw new Error(`Unknown theme color: ${color}`);
    return `${ansi}${text}\x1B[39m`;
  }
  bg(color, text) {
    const ansi = this.bgColors.get(color);
    if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
    return `${ansi}${text}\x1B[49m`;
  }
  bold(text) {
    return chalk.bold(text);
  }
  italic(text) {
    return chalk.italic(text);
  }
  underline(text) {
    return chalk.underline(text);
  }
  inverse(text) {
    return chalk.inverse(text);
  }
  strikethrough(text) {
    return chalk.strikethrough(text);
  }
  getFgAnsi(color) {
    const ansi = this.fgColors.get(color);
    if (!ansi) throw new Error(`Unknown theme color: ${color}`);
    return ansi;
  }
  getBgAnsi(color) {
    const ansi = this.bgColors.get(color);
    if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
    return ansi;
  }
  getColorMode() {
    return this.mode;
  }
  getThinkingBorderColor(level) {
    switch (level) {
      case "off":
        return (str) => this.fg("thinkingOff", str);
      case "minimal":
        return (str) => this.fg("thinkingMinimal", str);
      case "low":
        return (str) => this.fg("thinkingLow", str);
      case "medium":
        return (str) => this.fg("thinkingMedium", str);
      case "high":
        return (str) => this.fg("thinkingHigh", str);
      case "xhigh":
        return (str) => this.fg("thinkingXhigh", str);
      default:
        return (str) => this.fg("thinkingOff", str);
    }
  }
  getBashModeBorderColor() {
    return (str) => this.fg("bashMode", str);
  }
}
function getBuiltinThemes() {
  return builtinThemes;
}
function withSemanticColorDefaults(colors) {
  return {
    ...colors,
    surfaceBorder: colors.surfaceBorder ?? colors.border,
    surfaceMuted: colors.surfaceMuted ?? colors.borderMuted,
    surfaceTitle: colors.surfaceTitle ?? colors.toolTitle,
    surfaceAccent: colors.surfaceAccent ?? colors.borderAccent,
    toolRunning: colors.toolRunning ?? colors.warning,
    toolSuccess: colors.toolSuccess ?? colors.success,
    toolError: colors.toolError ?? colors.error,
    toolMuted: colors.toolMuted ?? colors.muted,
    modeWorkflow: colors.modeWorkflow ?? colors.accent,
    modeValidation: colors.modeValidation ?? colors.warning,
    modeDebug: colors.modeDebug ?? colors.error,
    modeCompact: colors.modeCompact ?? colors.muted
  };
}
function getAvailableThemes() {
  const themes = new Set(Object.keys(getBuiltinThemes()));
  const customThemesDir = getCustomThemesDir();
  if (fs.existsSync(customThemesDir)) {
    const files = fs.readdirSync(customThemesDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        themes.add(file.slice(0, -5));
      }
    }
  }
  for (const name of registeredThemes.keys()) {
    themes.add(name);
  }
  return Array.from(themes).sort();
}
function getAvailableThemesWithPaths() {
  const customThemesDir = getCustomThemesDir();
  const result = [];
  for (const name of Object.keys(getBuiltinThemes())) {
    result.push({ name, path: void 0 });
  }
  if (fs.existsSync(customThemesDir)) {
    for (const file of fs.readdirSync(customThemesDir)) {
      if (file.endsWith(".json")) {
        const name = file.slice(0, -5);
        if (!result.some((t) => t.name === name)) {
          result.push({ name, path: path.join(customThemesDir, file) });
        }
      }
    }
  }
  for (const [name, theme2] of registeredThemes.entries()) {
    if (!result.some((t) => t.name === name)) {
      result.push({ name, path: theme2.sourcePath });
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
function parseThemeJson(label, json) {
  if (!validateThemeJson.Check(json)) {
    const errors = Array.from(validateThemeJson.Errors(json));
    const missingColors = [];
    const otherErrors = [];
    for (const e of errors) {
      const match = e.path.match(/^\/colors\/(\w+)$/);
      if (match && e.message.includes("Required")) {
        missingColors.push(match[1]);
      } else {
        otherErrors.push(`  - ${e.path}: ${e.message}`);
      }
    }
    let errorMessage = `Invalid theme "${label}":
`;
    if (missingColors.length > 0) {
      errorMessage += "\nMissing required color tokens:\n";
      errorMessage += missingColors.map((c) => `  - ${c}`).join("\n");
      errorMessage += `

Please add these colors to your theme's "colors" object.`;
      errorMessage += "\nSee the built-in dark/light themes for reference values.";
    }
    if (otherErrors.length > 0) {
      errorMessage += `

Other errors:
${otherErrors.join("\n")}`;
    }
    throw new Error(errorMessage);
  }
  return json;
}
function parseThemeJsonContent(label, content) {
  let json;
  try {
    json = JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse theme ${label}: ${error}`);
  }
  return parseThemeJson(label, json);
}
function loadThemeJson(name) {
  const builtinThemes2 = getBuiltinThemes();
  if (name in builtinThemes2) {
    return builtinThemes2[name];
  }
  const registeredTheme = registeredThemes.get(name);
  if (registeredTheme?.sourcePath) {
    const content2 = fs.readFileSync(registeredTheme.sourcePath, "utf-8");
    return parseThemeJsonContent(registeredTheme.sourcePath, content2);
  }
  if (registeredTheme) {
    throw new Error(`Theme "${name}" does not have a source path for export`);
  }
  const customThemesDir = getCustomThemesDir();
  const themePath = path.join(customThemesDir, `${name}.json`);
  if (!fs.existsSync(themePath)) {
    throw new Error(`Theme not found: ${name}`);
  }
  const content = fs.readFileSync(themePath, "utf-8");
  return parseThemeJsonContent(name, content);
}
function createTheme(themeJson, mode, sourcePath) {
  const colorMode = mode ?? detectColorMode();
  const resolvedColors = resolveThemeColors(withSemanticColorDefaults(themeJson.colors), themeJson.vars);
  const fgColors = {};
  const bgColors = {};
  const bgColorKeys = /* @__PURE__ */ new Set([
    "selectedBg",
    "userMessageBg",
    "customMessageBg",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg"
  ]);
  for (const [key, value] of Object.entries(resolvedColors)) {
    if (bgColorKeys.has(key)) {
      bgColors[key] = value;
    } else {
      fgColors[key] = value;
    }
  }
  return new Theme(fgColors, bgColors, colorMode, {
    name: themeJson.name,
    sourcePath
  });
}
function loadThemeFromPath(themePath, mode) {
  const content = fs.readFileSync(themePath, "utf-8");
  const themeJson = parseThemeJsonContent(themePath, content);
  return createTheme(themeJson, mode, themePath);
}
function loadTheme(name, mode) {
  const registeredTheme = registeredThemes.get(name);
  if (registeredTheme) {
    return registeredTheme;
  }
  const themeJson = loadThemeJson(name);
  return createTheme(themeJson, mode);
}
function getThemeByName(name) {
  try {
    return loadTheme(name);
  } catch {
    return void 0;
  }
}
function detectTerminalBackground() {
  const colorfgbg = process.env.COLORFGBG || "";
  if (colorfgbg) {
    const parts = colorfgbg.split(";");
    if (parts.length >= 2) {
      const bg = parseInt(parts[1], 10);
      if (!Number.isNaN(bg)) {
        const result = bg < 8 ? "dark" : "light";
        return result;
      }
    }
  }
  return "dark";
}
function getDefaultTheme() {
  return detectTerminalBackground();
}
const THEME_KEY = Symbol.for("@gsd/pi-coding-agent:theme");
const theme = new Proxy({}, {
  get(_target, prop) {
    const t = globalThis[THEME_KEY];
    if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
    return t[prop];
  }
});
function setGlobalTheme(t) {
  globalThis[THEME_KEY] = t;
}
let currentThemeName;
let themeWatcher;
const onThemeChangeCallbacks = /* @__PURE__ */ new Set();
const registeredThemes = /* @__PURE__ */ new Map();
function setRegisteredThemes(themes) {
  registeredThemes.clear();
  for (const theme2 of themes) {
    if (theme2.name) {
      registeredThemes.set(theme2.name, theme2);
    }
  }
}
function initTheme(themeName, enableWatcher = false) {
  const name = themeName ?? getDefaultTheme();
  currentThemeName = name;
  try {
    setGlobalTheme(loadTheme(name));
    if (enableWatcher) {
      startThemeWatcher();
    }
  } catch (_error) {
    currentThemeName = "dark";
    setGlobalTheme(loadTheme("dark"));
  }
}
function setTheme(name, enableWatcher = false) {
  currentThemeName = name;
  try {
    setGlobalTheme(loadTheme(name));
    if (enableWatcher) {
      startThemeWatcher();
    }
    onThemeChangeCallbacks.forEach((cb) => cb());
    return { success: true };
  } catch (error) {
    currentThemeName = "dark";
    setGlobalTheme(loadTheme("dark"));
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
function setThemeInstance(themeInstance) {
  setGlobalTheme(themeInstance);
  currentThemeName = "<in-memory>";
  stopThemeWatcher();
  onThemeChangeCallbacks.forEach((cb) => cb());
}
function onThemeChange(callback) {
  onThemeChangeCallbacks.add(callback);
  return () => {
    onThemeChangeCallbacks.delete(callback);
  };
}
function startThemeWatcher() {
  if (themeWatcher) {
    themeWatcher.close();
    themeWatcher = void 0;
  }
  if (!currentThemeName || currentThemeName === "dark" || currentThemeName === "light") {
    return;
  }
  const customThemesDir = getCustomThemesDir();
  const themeFile = path.join(customThemesDir, `${currentThemeName}.json`);
  if (!fs.existsSync(themeFile)) {
    return;
  }
  try {
    themeWatcher = fs.watch(themeFile, (eventType) => {
      if (eventType === "change") {
        setTimeout(() => {
          try {
            setGlobalTheme(loadTheme(currentThemeName));
            onThemeChangeCallbacks.forEach((cb) => cb());
          } catch (_error) {
          }
        }, 100);
      } else if (eventType === "rename") {
        setTimeout(() => {
          if (!fs.existsSync(themeFile)) {
            currentThemeName = "dark";
            setGlobalTheme(loadTheme("dark"));
            if (themeWatcher) {
              themeWatcher.close();
              themeWatcher = void 0;
            }
            onThemeChangeCallbacks.forEach((cb) => cb());
          }
        }, 100);
      }
    });
  } catch (_error) {
  }
}
function stopThemeWatcher() {
  if (themeWatcher) {
    themeWatcher.close();
    themeWatcher = void 0;
  }
}
function ansi256ToHex(index) {
  const basicColors = [
    "#000000",
    "#800000",
    "#008000",
    "#808000",
    "#000080",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#0000ff",
    "#ff00ff",
    "#00ffff",
    "#ffffff"
  ];
  if (index < 16) {
    return basicColors[index];
  }
  if (index < 232) {
    const cubeIndex = index - 16;
    const r = Math.floor(cubeIndex / 36);
    const g = Math.floor(cubeIndex % 36 / 6);
    const b = cubeIndex % 6;
    const toHex = (n) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  const gray = 8 + (index - 232) * 10;
  const grayHex = gray.toString(16).padStart(2, "0");
  return `#${grayHex}${grayHex}${grayHex}`;
}
function getResolvedThemeColors(themeName) {
  const name = themeName ?? currentThemeName ?? getDefaultTheme();
  const isLight = name === "light";
  const themeJson = loadThemeJson(name);
  const resolved = resolveThemeColors(themeJson.colors, themeJson.vars);
  const defaultText = isLight ? "#000000" : "#e5e5e7";
  const cssColors = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === "number") {
      cssColors[key] = ansi256ToHex(value);
    } else if (value === "") {
      cssColors[key] = defaultText;
    } else {
      cssColors[key] = value;
    }
  }
  return cssColors;
}
function getThemeExportColors(themeName) {
  const name = themeName ?? currentThemeName ?? getDefaultTheme();
  try {
    const themeJson = loadThemeJson(name);
    const exportSection = themeJson.export;
    if (!exportSection) return {};
    const vars = themeJson.vars ?? {};
    const resolve = (value) => {
      if (value === void 0) return void 0;
      if (typeof value === "number") return ansi256ToHex(value);
      if (value.startsWith("$")) {
        const resolved = vars[value];
        if (resolved === void 0) return void 0;
        if (typeof resolved === "number") return ansi256ToHex(resolved);
        return resolved;
      }
      return value;
    };
    return {
      pageBg: resolve(exportSection.pageBg),
      cardBg: resolve(exportSection.cardBg),
      infoBg: resolve(exportSection.infoBg)
    };
  } catch {
    return {};
  }
}
let cachedHighlightColorsFor;
let cachedHighlightColors;
function buildHighlightColors(t) {
  return {
    comment: t.getFgAnsi("syntaxComment"),
    keyword: t.getFgAnsi("syntaxKeyword"),
    function: t.getFgAnsi("syntaxFunction"),
    variable: t.getFgAnsi("syntaxVariable"),
    string: t.getFgAnsi("syntaxString"),
    number: t.getFgAnsi("syntaxNumber"),
    type: t.getFgAnsi("syntaxType"),
    operator: t.getFgAnsi("syntaxOperator"),
    punctuation: t.getFgAnsi("syntaxPunctuation")
  };
}
function getHighlightColors(t) {
  if (cachedHighlightColorsFor !== t || !cachedHighlightColors) {
    cachedHighlightColorsFor = t;
    cachedHighlightColors = buildHighlightColors(t);
  }
  return cachedHighlightColors;
}
const LIGHTWEIGHT_KEYWORDS = /* @__PURE__ */ new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "def",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "fn",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "interface",
  "let",
  "match",
  "new",
  "null",
  "return",
  "struct",
  "switch",
  "throw",
  "true",
  "try",
  "type",
  "undefined",
  "use",
  "var",
  "while"
]);
function lightweightHighlightLine(line) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === "/" && next === "/") {
      out += theme.fg("syntaxComment", line.slice(i));
      break;
    }
    if (ch === "#") {
      out += theme.fg("syntaxComment", line.slice(i));
      break;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") {
          if (j + 1 >= line.length) {
            j = line.length;
            break;
          }
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      out += theme.fg("syntaxString", line.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch ?? "")) {
      let j = i + 1;
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j] ?? "")) j++;
      const word = line.slice(i, j);
      out += LIGHTWEIGHT_KEYWORDS.has(word) ? theme.fg("syntaxKeyword", word) : word;
      i = j;
      continue;
    }
    if (/\d/.test(ch ?? "")) {
      let j = i + 1;
      while (j < line.length && /[\d._]/.test(line[j] ?? "")) j++;
      out += theme.fg("syntaxNumber", line.slice(i, j));
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
function lightweightHighlightCode(code) {
  return code.split("\n").map(lightweightHighlightLine);
}
function highlightCode(code, lang) {
  if (!NATIVE_TUI_HIGHLIGHT_ENABLED) {
    return lang ? lightweightHighlightCode(code) : code.split("\n");
  }
  const validLang = lang && supportsLanguage(lang) ? lang : null;
  try {
    return nativeHighlightCode(code, validLang, getHighlightColors(theme)).split("\n");
  } catch {
    return code.split("\n");
  }
}
function getLanguageFromPath(filePath) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return void 0;
  const extToLang = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    fish: "fish",
    ps1: "powershell",
    sql: "sql",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    less: "less",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    md: "markdown",
    markdown: "markdown",
    dockerfile: "dockerfile",
    makefile: "makefile",
    cmake: "cmake",
    lua: "lua",
    perl: "perl",
    r: "r",
    scala: "scala",
    clj: "clojure",
    ex: "elixir",
    exs: "elixir",
    erl: "erlang",
    hs: "haskell",
    ml: "ocaml",
    vim: "vim",
    graphql: "graphql",
    proto: "protobuf",
    tf: "hcl",
    hcl: "hcl"
  };
  return extToLang[ext];
}
function getMarkdownTheme() {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    underline: (text) => theme.underline(text),
    strikethrough: (text) => chalk.strikethrough(text),
    highlightCode: (code, lang) => {
      if (!NATIVE_TUI_HIGHLIGHT_ENABLED) {
        return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
      }
      const validLang = lang && supportsLanguage(lang) ? lang : null;
      try {
        return nativeHighlightCode(code, validLang, getHighlightColors(theme)).split("\n");
      } catch {
        return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
      }
    }
  };
}
function getSelectListTheme() {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("muted", text),
    noMatch: (text) => theme.fg("muted", text)
  };
}
function getEditorTheme() {
  return {
    borderColor: (text) => theme.fg("borderMuted", text),
    selectList: getSelectListTheme()
  };
}
function getSettingsListTheme() {
  return {
    label: (text, selected) => selected ? theme.fg("accent", text) : text,
    value: (text, selected) => selected ? theme.fg("accent", text) : theme.fg("muted", text),
    description: (text) => theme.fg("dim", text),
    cursor: theme.fg("accent", "\u2192 "),
    hint: (text) => theme.fg("dim", text)
  };
}
export {
  Theme,
  getAvailableThemes,
  getAvailableThemesWithPaths,
  getEditorTheme,
  getLanguageFromPath,
  getMarkdownTheme,
  getResolvedThemeColors,
  getSelectListTheme,
  getSettingsListTheme,
  getThemeByName,
  getThemeExportColors,
  highlightCode,
  initTheme,
  loadThemeFromPath,
  onThemeChange,
  setRegisteredThemes,
  setTheme,
  setThemeInstance,
  stopThemeWatcher,
  theme
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS90aGVtZS90aGVtZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0ICogYXMgZnMgZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBFZGl0b3JUaGVtZSwgTWFya2Rvd25UaGVtZSwgU2VsZWN0TGlzdFRoZW1lIH0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5pbXBvcnQgeyBUeXBlQ29tcGlsZXIgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3gvY29tcGlsZXJcIjtcbmltcG9ydCBjaGFsayBmcm9tIFwiY2hhbGtcIjtcbmltcG9ydCB7XG5cdGhpZ2hsaWdodENvZGUgYXMgbmF0aXZlSGlnaGxpZ2h0Q29kZSxcblx0c3VwcG9ydHNMYW5ndWFnZSxcblx0dHlwZSBIaWdobGlnaHRDb2xvcnMsXG59IGZyb20gXCJAZ3NkL25hdGl2ZVwiO1xuaW1wb3J0IHsgZ2V0Q3VzdG9tVGhlbWVzRGlyIH0gZnJvbSBcIi4uLy4uLy4uL2NvbmZpZy5qc1wiO1xuaW1wb3J0IHsgVGhlbWVKc29uU2NoZW1hLCB0eXBlIENvbG9yVmFsdWUsIHR5cGUgVGhlbWVKc29uIH0gZnJvbSBcIi4vdGhlbWUtc2NoZW1hLmpzXCI7XG5pbXBvcnQgeyBidWlsdGluVGhlbWVzIH0gZnJvbSBcIi4vdGhlbWVzLmpzXCI7XG5cbi8vIElzc3VlICM0NTM6IG5hdGl2ZSBwcmV2aWV3IGhpZ2hsaWdodGluZyBjYW4gd2VkZ2UgdGhlIGVudGlyZSBpbnRlcmFjdGl2ZVxuLy8gc2Vzc2lvbiBhZnRlciBhIHN1Y2Nlc3NmdWwgZmlsZSB0b29sLiBLZWVwIHRoZSBzYWZlciBwbGFpbi10ZXh0IHBhdGggYXMgdGhlXG4vLyBkZWZhdWx0IGFuZCBhbGxvdyBuYXRpdmUgaGlnaGxpZ2h0aW5nIG9ubHkgYXMgYW4gZXhwbGljaXQgb3B0LWluLlxuY29uc3QgTkFUSVZFX1RVSV9ISUdITElHSFRfRU5BQkxFRCA9IHByb2Nlc3MuZW52LkdTRF9FTkFCTEVfTkFUSVZFX1RVSV9ISUdITElHSFQgPT09IFwiMVwiO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBUeXBlcyAmIFNjaGVtYVxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5jb25zdCB2YWxpZGF0ZVRoZW1lSnNvbiA9IFR5cGVDb21waWxlci5Db21waWxlKFRoZW1lSnNvblNjaGVtYSk7XG5cbmV4cG9ydCB0eXBlIFRoZW1lQ29sb3IgPVxuXHR8IFwiYWNjZW50XCJcblx0fCBcImJvcmRlclwiXG5cdHwgXCJib3JkZXJBY2NlbnRcIlxuXHR8IFwiYm9yZGVyTXV0ZWRcIlxuXHR8IFwic3VjY2Vzc1wiXG5cdHwgXCJlcnJvclwiXG5cdHwgXCJ3YXJuaW5nXCJcblx0fCBcIm11dGVkXCJcblx0fCBcImRpbVwiXG5cdHwgXCJ0ZXh0XCJcblx0fCBcInRoaW5raW5nVGV4dFwiXG5cdHwgXCJ1c2VyTWVzc2FnZVRleHRcIlxuXHR8IFwiYXNzaXN0YW50TWVzc2FnZVRleHRcIlxuXHR8IFwiY3VzdG9tTWVzc2FnZVRleHRcIlxuXHR8IFwiY3VzdG9tTWVzc2FnZUxhYmVsXCJcblx0fCBcInRvb2xUaXRsZVwiXG5cdHwgXCJ0b29sT3V0cHV0XCJcblx0fCBcIm1kSGVhZGluZ1wiXG5cdHwgXCJtZExpbmtcIlxuXHR8IFwibWRMaW5rVXJsXCJcblx0fCBcIm1kQ29kZVwiXG5cdHwgXCJtZENvZGVCbG9ja1wiXG5cdHwgXCJtZENvZGVCbG9ja0JvcmRlclwiXG5cdHwgXCJtZFF1b3RlXCJcblx0fCBcIm1kUXVvdGVCb3JkZXJcIlxuXHR8IFwibWRIclwiXG5cdHwgXCJtZExpc3RCdWxsZXRcIlxuXHR8IFwidG9vbERpZmZBZGRlZFwiXG5cdHwgXCJ0b29sRGlmZlJlbW92ZWRcIlxuXHR8IFwidG9vbERpZmZDb250ZXh0XCJcblx0fCBcInN5bnRheENvbW1lbnRcIlxuXHR8IFwic3ludGF4S2V5d29yZFwiXG5cdHwgXCJzeW50YXhGdW5jdGlvblwiXG5cdHwgXCJzeW50YXhWYXJpYWJsZVwiXG5cdHwgXCJzeW50YXhTdHJpbmdcIlxuXHR8IFwic3ludGF4TnVtYmVyXCJcblx0fCBcInN5bnRheFR5cGVcIlxuXHR8IFwic3ludGF4T3BlcmF0b3JcIlxuXHR8IFwic3ludGF4UHVuY3R1YXRpb25cIlxuXHR8IFwidGhpbmtpbmdPZmZcIlxuXHR8IFwidGhpbmtpbmdNaW5pbWFsXCJcblx0fCBcInRoaW5raW5nTG93XCJcblx0fCBcInRoaW5raW5nTWVkaXVtXCJcblx0fCBcInRoaW5raW5nSGlnaFwiXG5cdHwgXCJ0aGlua2luZ1hoaWdoXCJcblx0fCBcImJhc2hNb2RlXCJcblx0fCBcInN1cmZhY2VCb3JkZXJcIlxuXHR8IFwic3VyZmFjZU11dGVkXCJcblx0fCBcInN1cmZhY2VUaXRsZVwiXG5cdHwgXCJzdXJmYWNlQWNjZW50XCJcblx0fCBcInRvb2xSdW5uaW5nXCJcblx0fCBcInRvb2xTdWNjZXNzXCJcblx0fCBcInRvb2xFcnJvclwiXG5cdHwgXCJ0b29sTXV0ZWRcIlxuXHR8IFwibW9kZVdvcmtmbG93XCJcblx0fCBcIm1vZGVWYWxpZGF0aW9uXCJcblx0fCBcIm1vZGVEZWJ1Z1wiXG5cdHwgXCJtb2RlQ29tcGFjdFwiO1xuXG5leHBvcnQgdHlwZSBUaGVtZUJnID1cblx0fCBcInNlbGVjdGVkQmdcIlxuXHR8IFwidXNlck1lc3NhZ2VCZ1wiXG5cdHwgXCJjdXN0b21NZXNzYWdlQmdcIlxuXHR8IFwidG9vbFBlbmRpbmdCZ1wiXG5cdHwgXCJ0b29sU3VjY2Vzc0JnXCJcblx0fCBcInRvb2xFcnJvckJnXCI7XG5cbnR5cGUgQ29sb3JNb2RlID0gXCJ0cnVlY29sb3JcIiB8IFwiMjU2Y29sb3JcIjtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gQ29sb3IgVXRpbGl0aWVzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmZ1bmN0aW9uIGRldGVjdENvbG9yTW9kZSgpOiBDb2xvck1vZGUge1xuXHRjb25zdCBjb2xvcnRlcm0gPSBwcm9jZXNzLmVudi5DT0xPUlRFUk07XG5cdGlmIChjb2xvcnRlcm0gPT09IFwidHJ1ZWNvbG9yXCIgfHwgY29sb3J0ZXJtID09PSBcIjI0Yml0XCIpIHtcblx0XHRyZXR1cm4gXCJ0cnVlY29sb3JcIjtcblx0fVxuXHQvLyBXaW5kb3dzIFRlcm1pbmFsIHN1cHBvcnRzIHRydWVjb2xvclxuXHRpZiAocHJvY2Vzcy5lbnYuV1RfU0VTU0lPTikge1xuXHRcdHJldHVybiBcInRydWVjb2xvclwiO1xuXHR9XG5cdGNvbnN0IHRlcm0gPSBwcm9jZXNzLmVudi5URVJNIHx8IFwiXCI7XG5cdC8vIEZhbGwgYmFjayB0byAyNTZjb2xvciBmb3IgdHJ1bHkgbGltaXRlZCB0ZXJtaW5hbHNcblx0aWYgKHRlcm0gPT09IFwiZHVtYlwiIHx8IHRlcm0gPT09IFwiXCIgfHwgdGVybSA9PT0gXCJsaW51eFwiKSB7XG5cdFx0cmV0dXJuIFwiMjU2Y29sb3JcIjtcblx0fVxuXHQvLyBUZXJtaW5hbC5hcHAgYWxzbyBkb2Vzbid0IHN1cHBvcnQgdHJ1ZWNvbG9yXG5cdGlmIChwcm9jZXNzLmVudi5URVJNX1BST0dSQU0gPT09IFwiQXBwbGVfVGVybWluYWxcIikge1xuXHRcdHJldHVybiBcIjI1NmNvbG9yXCI7XG5cdH1cblx0Ly8gR05VIHNjcmVlbiBkb2Vzbid0IHN1cHBvcnQgdHJ1ZWNvbG9yIHVubGVzcyBleHBsaWNpdGx5IG9wdGVkIGluIHZpYSBDT0xPUlRFUk09dHJ1ZWNvbG9yLlxuXHQvLyBURVJNIHVuZGVyIHNjcmVlbiBpcyB0eXBpY2FsbHkgXCJzY3JlZW5cIiwgXCJzY3JlZW4tMjU2Y29sb3JcIiwgb3IgXCJzY3JlZW4ueHRlcm0tMjU2Y29sb3JcIi5cblx0aWYgKHRlcm0gPT09IFwic2NyZWVuXCIgfHwgdGVybS5zdGFydHNXaXRoKFwic2NyZWVuLVwiKSB8fCB0ZXJtLnN0YXJ0c1dpdGgoXCJzY3JlZW4uXCIpKSB7XG5cdFx0cmV0dXJuIFwiMjU2Y29sb3JcIjtcblx0fVxuXHQvLyBBc3N1bWUgdHJ1ZWNvbG9yIGZvciBldmVyeXRoaW5nIGVsc2UgLSB2aXJ0dWFsbHkgYWxsIG1vZGVybiB0ZXJtaW5hbHMgc3VwcG9ydCBpdFxuXHRyZXR1cm4gXCJ0cnVlY29sb3JcIjtcbn1cblxuZnVuY3Rpb24gaGV4VG9SZ2IoaGV4OiBzdHJpbmcpOiB7IHI6IG51bWJlcjsgZzogbnVtYmVyOyBiOiBudW1iZXIgfSB7XG5cdGNvbnN0IGNsZWFuZWQgPSBoZXgucmVwbGFjZShcIiNcIiwgXCJcIik7XG5cdGlmIChjbGVhbmVkLmxlbmd0aCAhPT0gNikge1xuXHRcdHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBoZXggY29sb3I6ICR7aGV4fWApO1xuXHR9XG5cdGNvbnN0IHIgPSBwYXJzZUludChjbGVhbmVkLnN1YnN0cmluZygwLCAyKSwgMTYpO1xuXHRjb25zdCBnID0gcGFyc2VJbnQoY2xlYW5lZC5zdWJzdHJpbmcoMiwgNCksIDE2KTtcblx0Y29uc3QgYiA9IHBhcnNlSW50KGNsZWFuZWQuc3Vic3RyaW5nKDQsIDYpLCAxNik7XG5cdGlmIChOdW1iZXIuaXNOYU4ocikgfHwgTnVtYmVyLmlzTmFOKGcpIHx8IE51bWJlci5pc05hTihiKSkge1xuXHRcdHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBoZXggY29sb3I6ICR7aGV4fWApO1xuXHR9XG5cdHJldHVybiB7IHIsIGcsIGIgfTtcbn1cblxuLy8gVGhlIDZ4Nng2IGNvbG9yIGN1YmUgY2hhbm5lbCB2YWx1ZXMgKGluZGljZXMgMC01KVxuY29uc3QgQ1VCRV9WQUxVRVMgPSBbMCwgOTUsIDEzNSwgMTc1LCAyMTUsIDI1NV07XG5cbi8vIEdyYXlzY2FsZSByYW1wIHZhbHVlcyAoaW5kaWNlcyAyMzItMjU1LCAyNCBncmF5cyBmcm9tIDggdG8gMjM4KVxuY29uc3QgR1JBWV9WQUxVRVMgPSBBcnJheS5mcm9tKHsgbGVuZ3RoOiAyNCB9LCAoXywgaSkgPT4gOCArIGkgKiAxMCk7XG5cbmZ1bmN0aW9uIGZpbmRDbG9zZXN0Q3ViZUluZGV4KHZhbHVlOiBudW1iZXIpOiBudW1iZXIge1xuXHRsZXQgbWluRGlzdCA9IEluZmluaXR5O1xuXHRsZXQgbWluSWR4ID0gMDtcblx0Zm9yIChsZXQgaSA9IDA7IGkgPCBDVUJFX1ZBTFVFUy5sZW5ndGg7IGkrKykge1xuXHRcdGNvbnN0IGRpc3QgPSBNYXRoLmFicyh2YWx1ZSAtIENVQkVfVkFMVUVTW2ldKTtcblx0XHRpZiAoZGlzdCA8IG1pbkRpc3QpIHtcblx0XHRcdG1pbkRpc3QgPSBkaXN0O1xuXHRcdFx0bWluSWR4ID0gaTtcblx0XHR9XG5cdH1cblx0cmV0dXJuIG1pbklkeDtcbn1cblxuZnVuY3Rpb24gZmluZENsb3Nlc3RHcmF5SW5kZXgoZ3JheTogbnVtYmVyKTogbnVtYmVyIHtcblx0bGV0IG1pbkRpc3QgPSBJbmZpbml0eTtcblx0bGV0IG1pbklkeCA9IDA7XG5cdGZvciAobGV0IGkgPSAwOyBpIDwgR1JBWV9WQUxVRVMubGVuZ3RoOyBpKyspIHtcblx0XHRjb25zdCBkaXN0ID0gTWF0aC5hYnMoZ3JheSAtIEdSQVlfVkFMVUVTW2ldKTtcblx0XHRpZiAoZGlzdCA8IG1pbkRpc3QpIHtcblx0XHRcdG1pbkRpc3QgPSBkaXN0O1xuXHRcdFx0bWluSWR4ID0gaTtcblx0XHR9XG5cdH1cblx0cmV0dXJuIG1pbklkeDtcbn1cblxuZnVuY3Rpb24gY29sb3JEaXN0YW5jZShyMTogbnVtYmVyLCBnMTogbnVtYmVyLCBiMTogbnVtYmVyLCByMjogbnVtYmVyLCBnMjogbnVtYmVyLCBiMjogbnVtYmVyKTogbnVtYmVyIHtcblx0Ly8gV2VpZ2h0ZWQgRXVjbGlkZWFuIGRpc3RhbmNlIChodW1hbiBleWUgaXMgbW9yZSBzZW5zaXRpdmUgdG8gZ3JlZW4pXG5cdGNvbnN0IGRyID0gcjEgLSByMjtcblx0Y29uc3QgZGcgPSBnMSAtIGcyO1xuXHRjb25zdCBkYiA9IGIxIC0gYjI7XG5cdHJldHVybiBkciAqIGRyICogMC4yOTkgKyBkZyAqIGRnICogMC41ODcgKyBkYiAqIGRiICogMC4xMTQ7XG59XG5cbmZ1bmN0aW9uIHJnYlRvMjU2KHI6IG51bWJlciwgZzogbnVtYmVyLCBiOiBudW1iZXIpOiBudW1iZXIge1xuXHQvLyBGaW5kIGNsb3Nlc3QgY29sb3IgaW4gdGhlIDZ4Nng2IGN1YmVcblx0Y29uc3QgcklkeCA9IGZpbmRDbG9zZXN0Q3ViZUluZGV4KHIpO1xuXHRjb25zdCBnSWR4ID0gZmluZENsb3Nlc3RDdWJlSW5kZXgoZyk7XG5cdGNvbnN0IGJJZHggPSBmaW5kQ2xvc2VzdEN1YmVJbmRleChiKTtcblx0Y29uc3QgY3ViZVIgPSBDVUJFX1ZBTFVFU1tySWR4XTtcblx0Y29uc3QgY3ViZUcgPSBDVUJFX1ZBTFVFU1tnSWR4XTtcblx0Y29uc3QgY3ViZUIgPSBDVUJFX1ZBTFVFU1tiSWR4XTtcblx0Y29uc3QgY3ViZUluZGV4ID0gMTYgKyAzNiAqIHJJZHggKyA2ICogZ0lkeCArIGJJZHg7XG5cdGNvbnN0IGN1YmVEaXN0ID0gY29sb3JEaXN0YW5jZShyLCBnLCBiLCBjdWJlUiwgY3ViZUcsIGN1YmVCKTtcblxuXHQvLyBGaW5kIGNsb3Nlc3QgZ3JheXNjYWxlXG5cdGNvbnN0IGdyYXkgPSBNYXRoLnJvdW5kKDAuMjk5ICogciArIDAuNTg3ICogZyArIDAuMTE0ICogYik7XG5cdGNvbnN0IGdyYXlJZHggPSBmaW5kQ2xvc2VzdEdyYXlJbmRleChncmF5KTtcblx0Y29uc3QgZ3JheVZhbHVlID0gR1JBWV9WQUxVRVNbZ3JheUlkeF07XG5cdGNvbnN0IGdyYXlJbmRleCA9IDIzMiArIGdyYXlJZHg7XG5cdGNvbnN0IGdyYXlEaXN0ID0gY29sb3JEaXN0YW5jZShyLCBnLCBiLCBncmF5VmFsdWUsIGdyYXlWYWx1ZSwgZ3JheVZhbHVlKTtcblxuXHQvLyBDaGVjayBpZiBjb2xvciBoYXMgbm90aWNlYWJsZSBzYXR1cmF0aW9uIChodWUgbWF0dGVycylcblx0Ly8gSWYgbWF4LW1pbiBzcHJlYWQgaXMgc2lnbmlmaWNhbnQsIHByZWZlciBjdWJlIHRvIHByZXNlcnZlIHRpbnRcblx0Y29uc3QgbWF4QyA9IE1hdGgubWF4KHIsIGcsIGIpO1xuXHRjb25zdCBtaW5DID0gTWF0aC5taW4ociwgZywgYik7XG5cdGNvbnN0IHNwcmVhZCA9IG1heEMgLSBtaW5DO1xuXG5cdC8vIE9ubHkgY29uc2lkZXIgZ3JheXNjYWxlIGlmIGNvbG9yIGlzIG5lYXJseSBuZXV0cmFsIChzcHJlYWQgPCAxMClcblx0Ly8gQU5EIGdyYXlzY2FsZSBpcyBhY3R1YWxseSBjbG9zZXJcblx0aWYgKHNwcmVhZCA8IDEwICYmIGdyYXlEaXN0IDwgY3ViZURpc3QpIHtcblx0XHRyZXR1cm4gZ3JheUluZGV4O1xuXHR9XG5cblx0cmV0dXJuIGN1YmVJbmRleDtcbn1cblxuZnVuY3Rpb24gaGV4VG8yNTYoaGV4OiBzdHJpbmcpOiBudW1iZXIge1xuXHRjb25zdCB7IHIsIGcsIGIgfSA9IGhleFRvUmdiKGhleCk7XG5cdHJldHVybiByZ2JUbzI1NihyLCBnLCBiKTtcbn1cblxuZnVuY3Rpb24gZmdBbnNpKGNvbG9yOiBzdHJpbmcgfCBudW1iZXIsIG1vZGU6IENvbG9yTW9kZSk6IHN0cmluZyB7XG5cdGlmIChjb2xvciA9PT0gXCJcIikgcmV0dXJuIFwiXFx4MWJbMzltXCI7XG5cdGlmICh0eXBlb2YgY29sb3IgPT09IFwibnVtYmVyXCIpIHJldHVybiBgXFx4MWJbMzg7NTske2NvbG9yfW1gO1xuXHRpZiAoY29sb3Iuc3RhcnRzV2l0aChcIiNcIikpIHtcblx0XHRpZiAobW9kZSA9PT0gXCJ0cnVlY29sb3JcIikge1xuXHRcdFx0Y29uc3QgeyByLCBnLCBiIH0gPSBoZXhUb1JnYihjb2xvcik7XG5cdFx0XHRyZXR1cm4gYFxceDFiWzM4OzI7JHtyfTske2d9OyR7Yn1tYDtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc3QgaW5kZXggPSBoZXhUbzI1Nihjb2xvcik7XG5cdFx0XHRyZXR1cm4gYFxceDFiWzM4OzU7JHtpbmRleH1tYDtcblx0XHR9XG5cdH1cblx0dGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGNvbG9yIHZhbHVlOiAke2NvbG9yfWApO1xufVxuXG5mdW5jdGlvbiBiZ0Fuc2koY29sb3I6IHN0cmluZyB8IG51bWJlciwgbW9kZTogQ29sb3JNb2RlKTogc3RyaW5nIHtcblx0aWYgKGNvbG9yID09PSBcIlwiKSByZXR1cm4gXCJcXHgxYls0OW1cIjtcblx0aWYgKHR5cGVvZiBjb2xvciA9PT0gXCJudW1iZXJcIikgcmV0dXJuIGBcXHgxYls0ODs1OyR7Y29sb3J9bWA7XG5cdGlmIChjb2xvci5zdGFydHNXaXRoKFwiI1wiKSkge1xuXHRcdGlmIChtb2RlID09PSBcInRydWVjb2xvclwiKSB7XG5cdFx0XHRjb25zdCB7IHIsIGcsIGIgfSA9IGhleFRvUmdiKGNvbG9yKTtcblx0XHRcdHJldHVybiBgXFx4MWJbNDg7Mjske3J9OyR7Z307JHtifW1gO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRjb25zdCBpbmRleCA9IGhleFRvMjU2KGNvbG9yKTtcblx0XHRcdHJldHVybiBgXFx4MWJbNDg7NTske2luZGV4fW1gO1xuXHRcdH1cblx0fVxuXHR0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgY29sb3IgdmFsdWU6ICR7Y29sb3J9YCk7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVWYXJSZWZzKFxuXHR2YWx1ZTogQ29sb3JWYWx1ZSxcblx0dmFyczogUmVjb3JkPHN0cmluZywgQ29sb3JWYWx1ZT4sXG5cdHZpc2l0ZWQgPSBuZXcgU2V0PHN0cmluZz4oKSxcbik6IHN0cmluZyB8IG51bWJlciB7XG5cdGlmICh0eXBlb2YgdmFsdWUgPT09IFwibnVtYmVyXCIgfHwgdmFsdWUgPT09IFwiXCIgfHwgdmFsdWUuc3RhcnRzV2l0aChcIiNcIikpIHtcblx0XHRyZXR1cm4gdmFsdWU7XG5cdH1cblx0aWYgKHZpc2l0ZWQuaGFzKHZhbHVlKSkge1xuXHRcdHRocm93IG5ldyBFcnJvcihgQ2lyY3VsYXIgdmFyaWFibGUgcmVmZXJlbmNlIGRldGVjdGVkOiAke3ZhbHVlfWApO1xuXHR9XG5cdGlmICghKHZhbHVlIGluIHZhcnMpKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKGBWYXJpYWJsZSByZWZlcmVuY2Ugbm90IGZvdW5kOiAke3ZhbHVlfWApO1xuXHR9XG5cdHZpc2l0ZWQuYWRkKHZhbHVlKTtcblx0cmV0dXJuIHJlc29sdmVWYXJSZWZzKHZhcnNbdmFsdWVdLCB2YXJzLCB2aXNpdGVkKTtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVRoZW1lQ29sb3JzPFQgZXh0ZW5kcyBSZWNvcmQ8c3RyaW5nLCBDb2xvclZhbHVlPj4oXG5cdGNvbG9yczogVCxcblx0dmFyczogUmVjb3JkPHN0cmluZywgQ29sb3JWYWx1ZT4gPSB7fSxcbik6IFJlY29yZDxrZXlvZiBULCBzdHJpbmcgfCBudW1iZXI+IHtcblx0Y29uc3QgcmVzb2x2ZWQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IG51bWJlcj4gPSB7fTtcblx0Zm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoY29sb3JzKSkge1xuXHRcdHJlc29sdmVkW2tleV0gPSByZXNvbHZlVmFyUmVmcyh2YWx1ZSwgdmFycyk7XG5cdH1cblx0cmV0dXJuIHJlc29sdmVkIGFzIFJlY29yZDxrZXlvZiBULCBzdHJpbmcgfCBudW1iZXI+O1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBUaGVtZSBDbGFzc1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5leHBvcnQgY2xhc3MgVGhlbWUge1xuXHRyZWFkb25seSBuYW1lPzogc3RyaW5nO1xuXHRyZWFkb25seSBzb3VyY2VQYXRoPzogc3RyaW5nO1xuXHRwcml2YXRlIGZnQ29sb3JzOiBNYXA8VGhlbWVDb2xvciwgc3RyaW5nPjtcblx0cHJpdmF0ZSBiZ0NvbG9yczogTWFwPFRoZW1lQmcsIHN0cmluZz47XG5cdHByaXZhdGUgbW9kZTogQ29sb3JNb2RlO1xuXG5cdGNvbnN0cnVjdG9yKFxuXHRcdGZnQ29sb3JzOiBSZWNvcmQ8VGhlbWVDb2xvciwgc3RyaW5nIHwgbnVtYmVyPixcblx0XHRiZ0NvbG9yczogUmVjb3JkPFRoZW1lQmcsIHN0cmluZyB8IG51bWJlcj4sXG5cdFx0bW9kZTogQ29sb3JNb2RlLFxuXHRcdG9wdGlvbnM6IHsgbmFtZT86IHN0cmluZzsgc291cmNlUGF0aD86IHN0cmluZyB9ID0ge30sXG5cdCkge1xuXHRcdHRoaXMubmFtZSA9IG9wdGlvbnMubmFtZTtcblx0XHR0aGlzLnNvdXJjZVBhdGggPSBvcHRpb25zLnNvdXJjZVBhdGg7XG5cdFx0dGhpcy5tb2RlID0gbW9kZTtcblx0XHR0aGlzLmZnQ29sb3JzID0gbmV3IE1hcCgpO1xuXHRcdGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGZnQ29sb3JzKSBhcyBbVGhlbWVDb2xvciwgc3RyaW5nIHwgbnVtYmVyXVtdKSB7XG5cdFx0XHR0aGlzLmZnQ29sb3JzLnNldChrZXksIGZnQW5zaSh2YWx1ZSwgbW9kZSkpO1xuXHRcdH1cblx0XHR0aGlzLmJnQ29sb3JzID0gbmV3IE1hcCgpO1xuXHRcdGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGJnQ29sb3JzKSBhcyBbVGhlbWVCZywgc3RyaW5nIHwgbnVtYmVyXVtdKSB7XG5cdFx0XHR0aGlzLmJnQ29sb3JzLnNldChrZXksIGJnQW5zaSh2YWx1ZSwgbW9kZSkpO1xuXHRcdH1cblx0fVxuXG5cdGZnKGNvbG9yOiBUaGVtZUNvbG9yLCB0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdGNvbnN0IGFuc2kgPSB0aGlzLmZnQ29sb3JzLmdldChjb2xvcik7XG5cdFx0aWYgKCFhbnNpKSB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gdGhlbWUgY29sb3I6ICR7Y29sb3J9YCk7XG5cdFx0cmV0dXJuIGAke2Fuc2l9JHt0ZXh0fVxceDFiWzM5bWA7IC8vIFJlc2V0IG9ubHkgZm9yZWdyb3VuZCBjb2xvclxuXHR9XG5cblx0YmcoY29sb3I6IFRoZW1lQmcsIHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdFx0Y29uc3QgYW5zaSA9IHRoaXMuYmdDb2xvcnMuZ2V0KGNvbG9yKTtcblx0XHRpZiAoIWFuc2kpIHRocm93IG5ldyBFcnJvcihgVW5rbm93biB0aGVtZSBiYWNrZ3JvdW5kIGNvbG9yOiAke2NvbG9yfWApO1xuXHRcdHJldHVybiBgJHthbnNpfSR7dGV4dH1cXHgxYls0OW1gOyAvLyBSZXNldCBvbmx5IGJhY2tncm91bmQgY29sb3Jcblx0fVxuXG5cdGJvbGQodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0XHRyZXR1cm4gY2hhbGsuYm9sZCh0ZXh0KTtcblx0fVxuXG5cdGl0YWxpYyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdHJldHVybiBjaGFsay5pdGFsaWModGV4dCk7XG5cdH1cblxuXHR1bmRlcmxpbmUodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0XHRyZXR1cm4gY2hhbGsudW5kZXJsaW5lKHRleHQpO1xuXHR9XG5cblx0aW52ZXJzZSh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdHJldHVybiBjaGFsay5pbnZlcnNlKHRleHQpO1xuXHR9XG5cblx0c3RyaWtldGhyb3VnaCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdHJldHVybiBjaGFsay5zdHJpa2V0aHJvdWdoKHRleHQpO1xuXHR9XG5cblx0Z2V0RmdBbnNpKGNvbG9yOiBUaGVtZUNvbG9yKTogc3RyaW5nIHtcblx0XHRjb25zdCBhbnNpID0gdGhpcy5mZ0NvbG9ycy5nZXQoY29sb3IpO1xuXHRcdGlmICghYW5zaSkgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIHRoZW1lIGNvbG9yOiAke2NvbG9yfWApO1xuXHRcdHJldHVybiBhbnNpO1xuXHR9XG5cblx0Z2V0QmdBbnNpKGNvbG9yOiBUaGVtZUJnKTogc3RyaW5nIHtcblx0XHRjb25zdCBhbnNpID0gdGhpcy5iZ0NvbG9ycy5nZXQoY29sb3IpO1xuXHRcdGlmICghYW5zaSkgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIHRoZW1lIGJhY2tncm91bmQgY29sb3I6ICR7Y29sb3J9YCk7XG5cdFx0cmV0dXJuIGFuc2k7XG5cdH1cblxuXHRnZXRDb2xvck1vZGUoKTogQ29sb3JNb2RlIHtcblx0XHRyZXR1cm4gdGhpcy5tb2RlO1xuXHR9XG5cblx0Z2V0VGhpbmtpbmdCb3JkZXJDb2xvcihsZXZlbDogXCJvZmZcIiB8IFwibWluaW1hbFwiIHwgXCJsb3dcIiB8IFwibWVkaXVtXCIgfCBcImhpZ2hcIiB8IFwieGhpZ2hcIik6IChzdHI6IHN0cmluZykgPT4gc3RyaW5nIHtcblx0XHQvLyBNYXAgdGhpbmtpbmcgbGV2ZWxzIHRvIGRlZGljYXRlZCB0aGVtZSBjb2xvcnNcblx0XHRzd2l0Y2ggKGxldmVsKSB7XG5cdFx0XHRjYXNlIFwib2ZmXCI6XG5cdFx0XHRcdHJldHVybiAoc3RyOiBzdHJpbmcpID0+IHRoaXMuZmcoXCJ0aGlua2luZ09mZlwiLCBzdHIpO1xuXHRcdFx0Y2FzZSBcIm1pbmltYWxcIjpcblx0XHRcdFx0cmV0dXJuIChzdHI6IHN0cmluZykgPT4gdGhpcy5mZyhcInRoaW5raW5nTWluaW1hbFwiLCBzdHIpO1xuXHRcdFx0Y2FzZSBcImxvd1wiOlxuXHRcdFx0XHRyZXR1cm4gKHN0cjogc3RyaW5nKSA9PiB0aGlzLmZnKFwidGhpbmtpbmdMb3dcIiwgc3RyKTtcblx0XHRcdGNhc2UgXCJtZWRpdW1cIjpcblx0XHRcdFx0cmV0dXJuIChzdHI6IHN0cmluZykgPT4gdGhpcy5mZyhcInRoaW5raW5nTWVkaXVtXCIsIHN0cik7XG5cdFx0XHRjYXNlIFwiaGlnaFwiOlxuXHRcdFx0XHRyZXR1cm4gKHN0cjogc3RyaW5nKSA9PiB0aGlzLmZnKFwidGhpbmtpbmdIaWdoXCIsIHN0cik7XG5cdFx0XHRjYXNlIFwieGhpZ2hcIjpcblx0XHRcdFx0cmV0dXJuIChzdHI6IHN0cmluZykgPT4gdGhpcy5mZyhcInRoaW5raW5nWGhpZ2hcIiwgc3RyKTtcblx0XHRcdGRlZmF1bHQ6XG5cdFx0XHRcdHJldHVybiAoc3RyOiBzdHJpbmcpID0+IHRoaXMuZmcoXCJ0aGlua2luZ09mZlwiLCBzdHIpO1xuXHRcdH1cblx0fVxuXG5cdGdldEJhc2hNb2RlQm9yZGVyQ29sb3IoKTogKHN0cjogc3RyaW5nKSA9PiBzdHJpbmcge1xuXHRcdHJldHVybiAoc3RyOiBzdHJpbmcpID0+IHRoaXMuZmcoXCJiYXNoTW9kZVwiLCBzdHIpO1xuXHR9XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFRoZW1lIExvYWRpbmdcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZnVuY3Rpb24gZ2V0QnVpbHRpblRoZW1lcygpOiBSZWNvcmQ8c3RyaW5nLCBUaGVtZUpzb24+IHtcblx0cmV0dXJuIGJ1aWx0aW5UaGVtZXM7XG59XG5cbmZ1bmN0aW9uIHdpdGhTZW1hbnRpY0NvbG9yRGVmYXVsdHMoY29sb3JzOiBUaGVtZUpzb25bXCJjb2xvcnNcIl0pOiBUaGVtZUpzb25bXCJjb2xvcnNcIl0ge1xuXHRyZXR1cm4ge1xuXHRcdC4uLmNvbG9ycyxcblx0XHRzdXJmYWNlQm9yZGVyOiBjb2xvcnMuc3VyZmFjZUJvcmRlciA/PyBjb2xvcnMuYm9yZGVyLFxuXHRcdHN1cmZhY2VNdXRlZDogY29sb3JzLnN1cmZhY2VNdXRlZCA/PyBjb2xvcnMuYm9yZGVyTXV0ZWQsXG5cdFx0c3VyZmFjZVRpdGxlOiBjb2xvcnMuc3VyZmFjZVRpdGxlID8/IGNvbG9ycy50b29sVGl0bGUsXG5cdFx0c3VyZmFjZUFjY2VudDogY29sb3JzLnN1cmZhY2VBY2NlbnQgPz8gY29sb3JzLmJvcmRlckFjY2VudCxcblx0XHR0b29sUnVubmluZzogY29sb3JzLnRvb2xSdW5uaW5nID8/IGNvbG9ycy53YXJuaW5nLFxuXHRcdHRvb2xTdWNjZXNzOiBjb2xvcnMudG9vbFN1Y2Nlc3MgPz8gY29sb3JzLnN1Y2Nlc3MsXG5cdFx0dG9vbEVycm9yOiBjb2xvcnMudG9vbEVycm9yID8/IGNvbG9ycy5lcnJvcixcblx0XHR0b29sTXV0ZWQ6IGNvbG9ycy50b29sTXV0ZWQgPz8gY29sb3JzLm11dGVkLFxuXHRcdG1vZGVXb3JrZmxvdzogY29sb3JzLm1vZGVXb3JrZmxvdyA/PyBjb2xvcnMuYWNjZW50LFxuXHRcdG1vZGVWYWxpZGF0aW9uOiBjb2xvcnMubW9kZVZhbGlkYXRpb24gPz8gY29sb3JzLndhcm5pbmcsXG5cdFx0bW9kZURlYnVnOiBjb2xvcnMubW9kZURlYnVnID8/IGNvbG9ycy5lcnJvcixcblx0XHRtb2RlQ29tcGFjdDogY29sb3JzLm1vZGVDb21wYWN0ID8/IGNvbG9ycy5tdXRlZCxcblx0fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEF2YWlsYWJsZVRoZW1lcygpOiBzdHJpbmdbXSB7XG5cdGNvbnN0IHRoZW1lcyA9IG5ldyBTZXQ8c3RyaW5nPihPYmplY3Qua2V5cyhnZXRCdWlsdGluVGhlbWVzKCkpKTtcblx0Y29uc3QgY3VzdG9tVGhlbWVzRGlyID0gZ2V0Q3VzdG9tVGhlbWVzRGlyKCk7XG5cdGlmIChmcy5leGlzdHNTeW5jKGN1c3RvbVRoZW1lc0RpcikpIHtcblx0XHRjb25zdCBmaWxlcyA9IGZzLnJlYWRkaXJTeW5jKGN1c3RvbVRoZW1lc0Rpcik7XG5cdFx0Zm9yIChjb25zdCBmaWxlIG9mIGZpbGVzKSB7XG5cdFx0XHRpZiAoZmlsZS5lbmRzV2l0aChcIi5qc29uXCIpKSB7XG5cdFx0XHRcdHRoZW1lcy5hZGQoZmlsZS5zbGljZSgwLCAtNSkpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXHRmb3IgKGNvbnN0IG5hbWUgb2YgcmVnaXN0ZXJlZFRoZW1lcy5rZXlzKCkpIHtcblx0XHR0aGVtZXMuYWRkKG5hbWUpO1xuXHR9XG5cdHJldHVybiBBcnJheS5mcm9tKHRoZW1lcykuc29ydCgpO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRoZW1lSW5mbyB7XG5cdG5hbWU6IHN0cmluZztcblx0cGF0aDogc3RyaW5nIHwgdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QXZhaWxhYmxlVGhlbWVzV2l0aFBhdGhzKCk6IFRoZW1lSW5mb1tdIHtcblx0Y29uc3QgY3VzdG9tVGhlbWVzRGlyID0gZ2V0Q3VzdG9tVGhlbWVzRGlyKCk7XG5cdGNvbnN0IHJlc3VsdDogVGhlbWVJbmZvW10gPSBbXTtcblxuXHQvLyBCdWlsdC1pbiB0aGVtZXMgKGVtYmVkZGVkIGluIGNvZGUsIG5vIGZpbGUgcGF0aClcblx0Zm9yIChjb25zdCBuYW1lIG9mIE9iamVjdC5rZXlzKGdldEJ1aWx0aW5UaGVtZXMoKSkpIHtcblx0XHRyZXN1bHQucHVzaCh7IG5hbWUsIHBhdGg6IHVuZGVmaW5lZCB9KTtcblx0fVxuXG5cdC8vIEN1c3RvbSB0aGVtZXNcblx0aWYgKGZzLmV4aXN0c1N5bmMoY3VzdG9tVGhlbWVzRGlyKSkge1xuXHRcdGZvciAoY29uc3QgZmlsZSBvZiBmcy5yZWFkZGlyU3luYyhjdXN0b21UaGVtZXNEaXIpKSB7XG5cdFx0XHRpZiAoZmlsZS5lbmRzV2l0aChcIi5qc29uXCIpKSB7XG5cdFx0XHRcdGNvbnN0IG5hbWUgPSBmaWxlLnNsaWNlKDAsIC01KTtcblx0XHRcdFx0aWYgKCFyZXN1bHQuc29tZSgodCkgPT4gdC5uYW1lID09PSBuYW1lKSkge1xuXHRcdFx0XHRcdHJlc3VsdC5wdXNoKHsgbmFtZSwgcGF0aDogcGF0aC5qb2luKGN1c3RvbVRoZW1lc0RpciwgZmlsZSkgfSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRmb3IgKGNvbnN0IFtuYW1lLCB0aGVtZV0gb2YgcmVnaXN0ZXJlZFRoZW1lcy5lbnRyaWVzKCkpIHtcblx0XHRpZiAoIXJlc3VsdC5zb21lKCh0KSA9PiB0Lm5hbWUgPT09IG5hbWUpKSB7XG5cdFx0XHRyZXN1bHQucHVzaCh7IG5hbWUsIHBhdGg6IHRoZW1lLnNvdXJjZVBhdGggfSk7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIHJlc3VsdC5zb3J0KChhLCBiKSA9PiBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpKTtcbn1cblxuZnVuY3Rpb24gcGFyc2VUaGVtZUpzb24obGFiZWw6IHN0cmluZywganNvbjogdW5rbm93bik6IFRoZW1lSnNvbiB7XG5cdGlmICghdmFsaWRhdGVUaGVtZUpzb24uQ2hlY2soanNvbikpIHtcblx0XHRjb25zdCBlcnJvcnMgPSBBcnJheS5mcm9tKHZhbGlkYXRlVGhlbWVKc29uLkVycm9ycyhqc29uKSk7XG5cdFx0Y29uc3QgbWlzc2luZ0NvbG9yczogc3RyaW5nW10gPSBbXTtcblx0XHRjb25zdCBvdGhlckVycm9yczogc3RyaW5nW10gPSBbXTtcblxuXHRcdGZvciAoY29uc3QgZSBvZiBlcnJvcnMpIHtcblx0XHRcdC8vIENoZWNrIGZvciBtaXNzaW5nIHJlcXVpcmVkIGNvbG9yIHByb3BlcnRpZXNcblx0XHRcdGNvbnN0IG1hdGNoID0gZS5wYXRoLm1hdGNoKC9eXFwvY29sb3JzXFwvKFxcdyspJC8pO1xuXHRcdFx0aWYgKG1hdGNoICYmIGUubWVzc2FnZS5pbmNsdWRlcyhcIlJlcXVpcmVkXCIpKSB7XG5cdFx0XHRcdG1pc3NpbmdDb2xvcnMucHVzaChtYXRjaFsxXSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRvdGhlckVycm9ycy5wdXNoKGAgIC0gJHtlLnBhdGh9OiAke2UubWVzc2FnZX1gKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRsZXQgZXJyb3JNZXNzYWdlID0gYEludmFsaWQgdGhlbWUgXCIke2xhYmVsfVwiOlxcbmA7XG5cdFx0aWYgKG1pc3NpbmdDb2xvcnMubGVuZ3RoID4gMCkge1xuXHRcdFx0ZXJyb3JNZXNzYWdlICs9IFwiXFxuTWlzc2luZyByZXF1aXJlZCBjb2xvciB0b2tlbnM6XFxuXCI7XG5cdFx0XHRlcnJvck1lc3NhZ2UgKz0gbWlzc2luZ0NvbG9ycy5tYXAoKGMpID0+IGAgIC0gJHtjfWApLmpvaW4oXCJcXG5cIik7XG5cdFx0XHRlcnJvck1lc3NhZ2UgKz0gJ1xcblxcblBsZWFzZSBhZGQgdGhlc2UgY29sb3JzIHRvIHlvdXIgdGhlbWVcXCdzIFwiY29sb3JzXCIgb2JqZWN0Lic7XG5cdFx0XHRlcnJvck1lc3NhZ2UgKz0gXCJcXG5TZWUgdGhlIGJ1aWx0LWluIGRhcmsvbGlnaHQgdGhlbWVzIGZvciByZWZlcmVuY2UgdmFsdWVzLlwiO1xuXHRcdH1cblx0XHRpZiAob3RoZXJFcnJvcnMubGVuZ3RoID4gMCkge1xuXHRcdFx0ZXJyb3JNZXNzYWdlICs9IGBcXG5cXG5PdGhlciBlcnJvcnM6XFxuJHtvdGhlckVycm9ycy5qb2luKFwiXFxuXCIpfWA7XG5cdFx0fVxuXG5cdFx0dGhyb3cgbmV3IEVycm9yKGVycm9yTWVzc2FnZSk7XG5cdH1cblxuXHRyZXR1cm4ganNvbiBhcyBUaGVtZUpzb247XG59XG5cbmZ1bmN0aW9uIHBhcnNlVGhlbWVKc29uQ29udGVudChsYWJlbDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiBUaGVtZUpzb24ge1xuXHRsZXQganNvbjogdW5rbm93bjtcblx0dHJ5IHtcblx0XHRqc29uID0gSlNPTi5wYXJzZShjb250ZW50KTtcblx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBwYXJzZSB0aGVtZSAke2xhYmVsfTogJHtlcnJvcn1gKTtcblx0fVxuXHRyZXR1cm4gcGFyc2VUaGVtZUpzb24obGFiZWwsIGpzb24pO1xufVxuXG5mdW5jdGlvbiBsb2FkVGhlbWVKc29uKG5hbWU6IHN0cmluZyk6IFRoZW1lSnNvbiB7XG5cdGNvbnN0IGJ1aWx0aW5UaGVtZXMgPSBnZXRCdWlsdGluVGhlbWVzKCk7XG5cdGlmIChuYW1lIGluIGJ1aWx0aW5UaGVtZXMpIHtcblx0XHRyZXR1cm4gYnVpbHRpblRoZW1lc1tuYW1lXTtcblx0fVxuXHRjb25zdCByZWdpc3RlcmVkVGhlbWUgPSByZWdpc3RlcmVkVGhlbWVzLmdldChuYW1lKTtcblx0aWYgKHJlZ2lzdGVyZWRUaGVtZT8uc291cmNlUGF0aCkge1xuXHRcdGNvbnN0IGNvbnRlbnQgPSBmcy5yZWFkRmlsZVN5bmMocmVnaXN0ZXJlZFRoZW1lLnNvdXJjZVBhdGgsIFwidXRmLThcIik7XG5cdFx0cmV0dXJuIHBhcnNlVGhlbWVKc29uQ29udGVudChyZWdpc3RlcmVkVGhlbWUuc291cmNlUGF0aCwgY29udGVudCk7XG5cdH1cblx0aWYgKHJlZ2lzdGVyZWRUaGVtZSkge1xuXHRcdHRocm93IG5ldyBFcnJvcihgVGhlbWUgXCIke25hbWV9XCIgZG9lcyBub3QgaGF2ZSBhIHNvdXJjZSBwYXRoIGZvciBleHBvcnRgKTtcblx0fVxuXHRjb25zdCBjdXN0b21UaGVtZXNEaXIgPSBnZXRDdXN0b21UaGVtZXNEaXIoKTtcblx0Y29uc3QgdGhlbWVQYXRoID0gcGF0aC5qb2luKGN1c3RvbVRoZW1lc0RpciwgYCR7bmFtZX0uanNvbmApO1xuXHRpZiAoIWZzLmV4aXN0c1N5bmModGhlbWVQYXRoKSkge1xuXHRcdHRocm93IG5ldyBFcnJvcihgVGhlbWUgbm90IGZvdW5kOiAke25hbWV9YCk7XG5cdH1cblx0Y29uc3QgY29udGVudCA9IGZzLnJlYWRGaWxlU3luYyh0aGVtZVBhdGgsIFwidXRmLThcIik7XG5cdHJldHVybiBwYXJzZVRoZW1lSnNvbkNvbnRlbnQobmFtZSwgY29udGVudCk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVRoZW1lKHRoZW1lSnNvbjogVGhlbWVKc29uLCBtb2RlPzogQ29sb3JNb2RlLCBzb3VyY2VQYXRoPzogc3RyaW5nKTogVGhlbWUge1xuXHRjb25zdCBjb2xvck1vZGUgPSBtb2RlID8/IGRldGVjdENvbG9yTW9kZSgpO1xuXHRjb25zdCByZXNvbHZlZENvbG9ycyA9IHJlc29sdmVUaGVtZUNvbG9ycyh3aXRoU2VtYW50aWNDb2xvckRlZmF1bHRzKHRoZW1lSnNvbi5jb2xvcnMpLCB0aGVtZUpzb24udmFycyk7XG5cdGNvbnN0IGZnQ29sb3JzOiBSZWNvcmQ8VGhlbWVDb2xvciwgc3RyaW5nIHwgbnVtYmVyPiA9IHt9IGFzIFJlY29yZDxUaGVtZUNvbG9yLCBzdHJpbmcgfCBudW1iZXI+O1xuXHRjb25zdCBiZ0NvbG9yczogUmVjb3JkPFRoZW1lQmcsIHN0cmluZyB8IG51bWJlcj4gPSB7fSBhcyBSZWNvcmQ8VGhlbWVCZywgc3RyaW5nIHwgbnVtYmVyPjtcblx0Y29uc3QgYmdDb2xvcktleXM6IFNldDxzdHJpbmc+ID0gbmV3IFNldChbXG5cdFx0XCJzZWxlY3RlZEJnXCIsXG5cdFx0XCJ1c2VyTWVzc2FnZUJnXCIsXG5cdFx0XCJjdXN0b21NZXNzYWdlQmdcIixcblx0XHRcInRvb2xQZW5kaW5nQmdcIixcblx0XHRcInRvb2xTdWNjZXNzQmdcIixcblx0XHRcInRvb2xFcnJvckJnXCIsXG5cdF0pO1xuXHRmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhyZXNvbHZlZENvbG9ycykpIHtcblx0XHRpZiAoYmdDb2xvcktleXMuaGFzKGtleSkpIHtcblx0XHRcdGJnQ29sb3JzW2tleSBhcyBUaGVtZUJnXSA9IHZhbHVlO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRmZ0NvbG9yc1trZXkgYXMgVGhlbWVDb2xvcl0gPSB2YWx1ZTtcblx0XHR9XG5cdH1cblx0cmV0dXJuIG5ldyBUaGVtZShmZ0NvbG9ycywgYmdDb2xvcnMsIGNvbG9yTW9kZSwge1xuXHRcdG5hbWU6IHRoZW1lSnNvbi5uYW1lLFxuXHRcdHNvdXJjZVBhdGgsXG5cdH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbG9hZFRoZW1lRnJvbVBhdGgodGhlbWVQYXRoOiBzdHJpbmcsIG1vZGU/OiBDb2xvck1vZGUpOiBUaGVtZSB7XG5cdGNvbnN0IGNvbnRlbnQgPSBmcy5yZWFkRmlsZVN5bmModGhlbWVQYXRoLCBcInV0Zi04XCIpO1xuXHRjb25zdCB0aGVtZUpzb24gPSBwYXJzZVRoZW1lSnNvbkNvbnRlbnQodGhlbWVQYXRoLCBjb250ZW50KTtcblx0cmV0dXJuIGNyZWF0ZVRoZW1lKHRoZW1lSnNvbiwgbW9kZSwgdGhlbWVQYXRoKTtcbn1cblxuZnVuY3Rpb24gbG9hZFRoZW1lKG5hbWU6IHN0cmluZywgbW9kZT86IENvbG9yTW9kZSk6IFRoZW1lIHtcblx0Y29uc3QgcmVnaXN0ZXJlZFRoZW1lID0gcmVnaXN0ZXJlZFRoZW1lcy5nZXQobmFtZSk7XG5cdGlmIChyZWdpc3RlcmVkVGhlbWUpIHtcblx0XHRyZXR1cm4gcmVnaXN0ZXJlZFRoZW1lO1xuXHR9XG5cdGNvbnN0IHRoZW1lSnNvbiA9IGxvYWRUaGVtZUpzb24obmFtZSk7XG5cdHJldHVybiBjcmVhdGVUaGVtZSh0aGVtZUpzb24sIG1vZGUpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0VGhlbWVCeU5hbWUobmFtZTogc3RyaW5nKTogVGhlbWUgfCB1bmRlZmluZWQge1xuXHR0cnkge1xuXHRcdHJldHVybiBsb2FkVGhlbWUobmFtZSk7XG5cdH0gY2F0Y2gge1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1cbn1cblxuZnVuY3Rpb24gZGV0ZWN0VGVybWluYWxCYWNrZ3JvdW5kKCk6IFwiZGFya1wiIHwgXCJsaWdodFwiIHtcblx0Y29uc3QgY29sb3JmZ2JnID0gcHJvY2Vzcy5lbnYuQ09MT1JGR0JHIHx8IFwiXCI7XG5cdGlmIChjb2xvcmZnYmcpIHtcblx0XHRjb25zdCBwYXJ0cyA9IGNvbG9yZmdiZy5zcGxpdChcIjtcIik7XG5cdFx0aWYgKHBhcnRzLmxlbmd0aCA+PSAyKSB7XG5cdFx0XHRjb25zdCBiZyA9IHBhcnNlSW50KHBhcnRzWzFdLCAxMCk7XG5cdFx0XHRpZiAoIU51bWJlci5pc05hTihiZykpIHtcblx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gYmcgPCA4ID8gXCJkYXJrXCIgOiBcImxpZ2h0XCI7XG5cdFx0XHRcdHJldHVybiByZXN1bHQ7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cdHJldHVybiBcImRhcmtcIjtcbn1cblxuZnVuY3Rpb24gZ2V0RGVmYXVsdFRoZW1lKCk6IHN0cmluZyB7XG5cdHJldHVybiBkZXRlY3RUZXJtaW5hbEJhY2tncm91bmQoKTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gR2xvYmFsIFRoZW1lIEluc3RhbmNlXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8vIFVzZSBnbG9iYWxUaGlzIHRvIHNoYXJlIHRoZW1lIGFjcm9zcyBtb2R1bGUgbG9hZGVycyAodHN4ICsgaml0aSBpbiBkZXYgbW9kZSlcbmNvbnN0IFRIRU1FX0tFWSA9IFN5bWJvbC5mb3IoXCJAZ3NkL3BpLWNvZGluZy1hZ2VudDp0aGVtZVwiKTtcblxuLy8gRXhwb3J0IHRoZW1lIGFzIGEgZ2V0dGVyIHRoYXQgcmVhZHMgZnJvbSBnbG9iYWxUaGlzXG4vLyBUaGlzIGVuc3VyZXMgYWxsIG1vZHVsZSBpbnN0YW5jZXMgKHRzeCwgaml0aSkgc2VlIHRoZSBzYW1lIHRoZW1lXG5leHBvcnQgY29uc3QgdGhlbWU6IFRoZW1lID0gbmV3IFByb3h5KHt9IGFzIFRoZW1lLCB7XG5cdGdldChfdGFyZ2V0LCBwcm9wKSB7XG5cdFx0Y29uc3QgdCA9IChnbG9iYWxUaGlzIGFzIFJlY29yZDxzeW1ib2wsIFRoZW1lPilbVEhFTUVfS0VZXTtcblx0XHRpZiAoIXQpIHRocm93IG5ldyBFcnJvcihcIlRoZW1lIG5vdCBpbml0aWFsaXplZC4gQ2FsbCBpbml0VGhlbWUoKSBmaXJzdC5cIik7XG5cdFx0cmV0dXJuICh0IGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZyB8IHN5bWJvbCwgdW5rbm93bj4pW3Byb3BdO1xuXHR9LFxufSk7XG5cbmZ1bmN0aW9uIHNldEdsb2JhbFRoZW1lKHQ6IFRoZW1lKTogdm9pZCB7XG5cdChnbG9iYWxUaGlzIGFzIFJlY29yZDxzeW1ib2wsIFRoZW1lPilbVEhFTUVfS0VZXSA9IHQ7XG59XG5cbmxldCBjdXJyZW50VGhlbWVOYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5sZXQgdGhlbWVXYXRjaGVyOiBmcy5GU1dhdGNoZXIgfCB1bmRlZmluZWQ7XG5jb25zdCBvblRoZW1lQ2hhbmdlQ2FsbGJhY2tzID0gbmV3IFNldDwoKSA9PiB2b2lkPigpO1xuY29uc3QgcmVnaXN0ZXJlZFRoZW1lcyA9IG5ldyBNYXA8c3RyaW5nLCBUaGVtZT4oKTtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldFJlZ2lzdGVyZWRUaGVtZXModGhlbWVzOiBUaGVtZVtdKTogdm9pZCB7XG5cdHJlZ2lzdGVyZWRUaGVtZXMuY2xlYXIoKTtcblx0Zm9yIChjb25zdCB0aGVtZSBvZiB0aGVtZXMpIHtcblx0XHRpZiAodGhlbWUubmFtZSkge1xuXHRcdFx0cmVnaXN0ZXJlZFRoZW1lcy5zZXQodGhlbWUubmFtZSwgdGhlbWUpO1xuXHRcdH1cblx0fVxufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5pdFRoZW1lKHRoZW1lTmFtZT86IHN0cmluZywgZW5hYmxlV2F0Y2hlcjogYm9vbGVhbiA9IGZhbHNlKTogdm9pZCB7XG5cdGNvbnN0IG5hbWUgPSB0aGVtZU5hbWUgPz8gZ2V0RGVmYXVsdFRoZW1lKCk7XG5cdGN1cnJlbnRUaGVtZU5hbWUgPSBuYW1lO1xuXHR0cnkge1xuXHRcdHNldEdsb2JhbFRoZW1lKGxvYWRUaGVtZShuYW1lKSk7XG5cdFx0aWYgKGVuYWJsZVdhdGNoZXIpIHtcblx0XHRcdHN0YXJ0VGhlbWVXYXRjaGVyKCk7XG5cdFx0fVxuXHR9IGNhdGNoIChfZXJyb3IpIHtcblx0XHQvLyBUaGVtZSBpcyBpbnZhbGlkIC0gZmFsbCBiYWNrIHRvIGRhcmsgdGhlbWUgc2lsZW50bHlcblx0XHRjdXJyZW50VGhlbWVOYW1lID0gXCJkYXJrXCI7XG5cdFx0c2V0R2xvYmFsVGhlbWUobG9hZFRoZW1lKFwiZGFya1wiKSk7XG5cdFx0Ly8gRG9uJ3Qgc3RhcnQgd2F0Y2hlciBmb3IgZmFsbGJhY2sgdGhlbWVcblx0fVxufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0VGhlbWUobmFtZTogc3RyaW5nLCBlbmFibGVXYXRjaGVyOiBib29sZWFuID0gZmFsc2UpOiB7IHN1Y2Nlc3M6IGJvb2xlYW47IGVycm9yPzogc3RyaW5nIH0ge1xuXHRjdXJyZW50VGhlbWVOYW1lID0gbmFtZTtcblx0dHJ5IHtcblx0XHRzZXRHbG9iYWxUaGVtZShsb2FkVGhlbWUobmFtZSkpO1xuXHRcdGlmIChlbmFibGVXYXRjaGVyKSB7XG5cdFx0XHRzdGFydFRoZW1lV2F0Y2hlcigpO1xuXHRcdH1cblx0XHRvblRoZW1lQ2hhbmdlQ2FsbGJhY2tzLmZvckVhY2goY2IgPT4gY2IoKSk7XG5cdFx0cmV0dXJuIHsgc3VjY2VzczogdHJ1ZSB9O1xuXHR9IGNhdGNoIChlcnJvcikge1xuXHRcdC8vIFRoZW1lIGlzIGludmFsaWQgLSBmYWxsIGJhY2sgdG8gZGFyayB0aGVtZVxuXHRcdGN1cnJlbnRUaGVtZU5hbWUgPSBcImRhcmtcIjtcblx0XHRzZXRHbG9iYWxUaGVtZShsb2FkVGhlbWUoXCJkYXJrXCIpKTtcblx0XHQvLyBEb24ndCBzdGFydCB3YXRjaGVyIGZvciBmYWxsYmFjayB0aGVtZVxuXHRcdHJldHVybiB7XG5cdFx0XHRzdWNjZXNzOiBmYWxzZSxcblx0XHRcdGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXG5cdFx0fTtcblx0fVxufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0VGhlbWVJbnN0YW5jZSh0aGVtZUluc3RhbmNlOiBUaGVtZSk6IHZvaWQge1xuXHRzZXRHbG9iYWxUaGVtZSh0aGVtZUluc3RhbmNlKTtcblx0Y3VycmVudFRoZW1lTmFtZSA9IFwiPGluLW1lbW9yeT5cIjtcblx0c3RvcFRoZW1lV2F0Y2hlcigpOyAvLyBDYW4ndCB3YXRjaCBhIGRpcmVjdCBpbnN0YW5jZVxuXHRvblRoZW1lQ2hhbmdlQ2FsbGJhY2tzLmZvckVhY2goY2IgPT4gY2IoKSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBvblRoZW1lQ2hhbmdlKGNhbGxiYWNrOiAoKSA9PiB2b2lkKTogKCkgPT4gdm9pZCB7XG5cdG9uVGhlbWVDaGFuZ2VDYWxsYmFja3MuYWRkKGNhbGxiYWNrKTtcblx0cmV0dXJuICgpID0+IHsgb25UaGVtZUNoYW5nZUNhbGxiYWNrcy5kZWxldGUoY2FsbGJhY2spOyB9O1xufVxuXG5mdW5jdGlvbiBzdGFydFRoZW1lV2F0Y2hlcigpOiB2b2lkIHtcblx0Ly8gU3RvcCBleGlzdGluZyB3YXRjaGVyIGlmIGFueVxuXHRpZiAodGhlbWVXYXRjaGVyKSB7XG5cdFx0dGhlbWVXYXRjaGVyLmNsb3NlKCk7XG5cdFx0dGhlbWVXYXRjaGVyID0gdW5kZWZpbmVkO1xuXHR9XG5cblx0Ly8gT25seSB3YXRjaCBpZiBpdCdzIGEgY3VzdG9tIHRoZW1lIChub3QgYnVpbHQtaW4pXG5cdGlmICghY3VycmVudFRoZW1lTmFtZSB8fCBjdXJyZW50VGhlbWVOYW1lID09PSBcImRhcmtcIiB8fCBjdXJyZW50VGhlbWVOYW1lID09PSBcImxpZ2h0XCIpIHtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRjb25zdCBjdXN0b21UaGVtZXNEaXIgPSBnZXRDdXN0b21UaGVtZXNEaXIoKTtcblx0Y29uc3QgdGhlbWVGaWxlID0gcGF0aC5qb2luKGN1c3RvbVRoZW1lc0RpciwgYCR7Y3VycmVudFRoZW1lTmFtZX0uanNvbmApO1xuXG5cdC8vIE9ubHkgd2F0Y2ggaWYgdGhlIGZpbGUgZXhpc3RzXG5cdGlmICghZnMuZXhpc3RzU3luYyh0aGVtZUZpbGUpKSB7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0dHJ5IHtcblx0XHR0aGVtZVdhdGNoZXIgPSBmcy53YXRjaCh0aGVtZUZpbGUsIChldmVudFR5cGUpID0+IHtcblx0XHRcdGlmIChldmVudFR5cGUgPT09IFwiY2hhbmdlXCIpIHtcblx0XHRcdFx0Ly8gRGVib3VuY2UgcmFwaWQgY2hhbmdlc1xuXHRcdFx0XHRzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0Ly8gUmVsb2FkIHRoZSB0aGVtZVxuXHRcdFx0XHRcdFx0c2V0R2xvYmFsVGhlbWUobG9hZFRoZW1lKGN1cnJlbnRUaGVtZU5hbWUhKSk7XG5cdFx0XHRcdFx0XHQvLyBOb3RpZnkgY2FsbGJhY2tzICh0byBpbnZhbGlkYXRlIFVJKVxuXHRcdFx0XHRcdFx0b25UaGVtZUNoYW5nZUNhbGxiYWNrcy5mb3JFYWNoKGNiID0+IGNiKCkpO1xuXHRcdFx0XHRcdH0gY2F0Y2ggKF9lcnJvcikge1xuXHRcdFx0XHRcdFx0Ly8gSWdub3JlIGVycm9ycyAoZmlsZSBtaWdodCBiZSBpbiBpbnZhbGlkIHN0YXRlIHdoaWxlIGJlaW5nIGVkaXRlZClcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0sIDEwMCk7XG5cdFx0XHR9IGVsc2UgaWYgKGV2ZW50VHlwZSA9PT0gXCJyZW5hbWVcIikge1xuXHRcdFx0XHQvLyBGaWxlIHdhcyBkZWxldGVkIG9yIHJlbmFtZWQgLSBmYWxsIGJhY2sgdG8gZGVmYXVsdCB0aGVtZVxuXHRcdFx0XHRzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0XHRpZiAoIWZzLmV4aXN0c1N5bmModGhlbWVGaWxlKSkge1xuXHRcdFx0XHRcdFx0Y3VycmVudFRoZW1lTmFtZSA9IFwiZGFya1wiO1xuXHRcdFx0XHRcdFx0c2V0R2xvYmFsVGhlbWUobG9hZFRoZW1lKFwiZGFya1wiKSk7XG5cdFx0XHRcdFx0XHRpZiAodGhlbWVXYXRjaGVyKSB7XG5cdFx0XHRcdFx0XHRcdHRoZW1lV2F0Y2hlci5jbG9zZSgpO1xuXHRcdFx0XHRcdFx0XHR0aGVtZVdhdGNoZXIgPSB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRvblRoZW1lQ2hhbmdlQ2FsbGJhY2tzLmZvckVhY2goY2IgPT4gY2IoKSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9LCAxMDApO1xuXHRcdFx0fVxuXHRcdH0pO1xuXHR9IGNhdGNoIChfZXJyb3IpIHtcblx0XHQvLyBJZ25vcmUgZXJyb3JzIHN0YXJ0aW5nIHdhdGNoZXJcblx0fVxufVxuXG5leHBvcnQgZnVuY3Rpb24gc3RvcFRoZW1lV2F0Y2hlcigpOiB2b2lkIHtcblx0aWYgKHRoZW1lV2F0Y2hlcikge1xuXHRcdHRoZW1lV2F0Y2hlci5jbG9zZSgpO1xuXHRcdHRoZW1lV2F0Y2hlciA9IHVuZGVmaW5lZDtcblx0fVxufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBIVE1MIEV4cG9ydCBIZWxwZXJzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogQ29udmVydCBhIDI1Ni1jb2xvciBpbmRleCB0byBoZXggc3RyaW5nLlxuICogSW5kaWNlcyAwLTE1OiBiYXNpYyBjb2xvcnMgKGFwcHJveGltYXRlKVxuICogSW5kaWNlcyAxNi0yMzE6IDZ4Nng2IGNvbG9yIGN1YmVcbiAqIEluZGljZXMgMjMyLTI1NTogZ3JheXNjYWxlIHJhbXBcbiAqL1xuZnVuY3Rpb24gYW5zaTI1NlRvSGV4KGluZGV4OiBudW1iZXIpOiBzdHJpbmcge1xuXHQvLyBCYXNpYyBjb2xvcnMgKDAtMTUpIC0gYXBwcm94aW1hdGUgY29tbW9uIHRlcm1pbmFsIHZhbHVlc1xuXHRjb25zdCBiYXNpY0NvbG9ycyA9IFtcblx0XHRcIiMwMDAwMDBcIixcblx0XHRcIiM4MDAwMDBcIixcblx0XHRcIiMwMDgwMDBcIixcblx0XHRcIiM4MDgwMDBcIixcblx0XHRcIiMwMDAwODBcIixcblx0XHRcIiM4MDAwODBcIixcblx0XHRcIiMwMDgwODBcIixcblx0XHRcIiNjMGMwYzBcIixcblx0XHRcIiM4MDgwODBcIixcblx0XHRcIiNmZjAwMDBcIixcblx0XHRcIiMwMGZmMDBcIixcblx0XHRcIiNmZmZmMDBcIixcblx0XHRcIiMwMDAwZmZcIixcblx0XHRcIiNmZjAwZmZcIixcblx0XHRcIiMwMGZmZmZcIixcblx0XHRcIiNmZmZmZmZcIixcblx0XTtcblx0aWYgKGluZGV4IDwgMTYpIHtcblx0XHRyZXR1cm4gYmFzaWNDb2xvcnNbaW5kZXhdO1xuXHR9XG5cblx0Ly8gQ29sb3IgY3ViZSAoMTYtMjMxKTogNng2eDYgPSAyMTYgY29sb3JzXG5cdGlmIChpbmRleCA8IDIzMikge1xuXHRcdGNvbnN0IGN1YmVJbmRleCA9IGluZGV4IC0gMTY7XG5cdFx0Y29uc3QgciA9IE1hdGguZmxvb3IoY3ViZUluZGV4IC8gMzYpO1xuXHRcdGNvbnN0IGcgPSBNYXRoLmZsb29yKChjdWJlSW5kZXggJSAzNikgLyA2KTtcblx0XHRjb25zdCBiID0gY3ViZUluZGV4ICUgNjtcblx0XHRjb25zdCB0b0hleCA9IChuOiBudW1iZXIpID0+IChuID09PSAwID8gMCA6IDU1ICsgbiAqIDQwKS50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpO1xuXHRcdHJldHVybiBgIyR7dG9IZXgocil9JHt0b0hleChnKX0ke3RvSGV4KGIpfWA7XG5cdH1cblxuXHQvLyBHcmF5c2NhbGUgKDIzMi0yNTUpOiAyNCBzaGFkZXNcblx0Y29uc3QgZ3JheSA9IDggKyAoaW5kZXggLSAyMzIpICogMTA7XG5cdGNvbnN0IGdyYXlIZXggPSBncmF5LnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIik7XG5cdHJldHVybiBgIyR7Z3JheUhleH0ke2dyYXlIZXh9JHtncmF5SGV4fWA7XG59XG5cbi8qKlxuICogR2V0IHJlc29sdmVkIHRoZW1lIGNvbG9ycyBhcyBDU1MtY29tcGF0aWJsZSBoZXggc3RyaW5ncy5cbiAqIFVzZWQgYnkgSFRNTCBleHBvcnQgdG8gZ2VuZXJhdGUgQ1NTIGN1c3RvbSBwcm9wZXJ0aWVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmVzb2x2ZWRUaGVtZUNvbG9ycyh0aGVtZU5hbWU/OiBzdHJpbmcpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcblx0Y29uc3QgbmFtZSA9IHRoZW1lTmFtZSA/PyBjdXJyZW50VGhlbWVOYW1lID8/IGdldERlZmF1bHRUaGVtZSgpO1xuXHRjb25zdCBpc0xpZ2h0ID0gbmFtZSA9PT0gXCJsaWdodFwiO1xuXHRjb25zdCB0aGVtZUpzb24gPSBsb2FkVGhlbWVKc29uKG5hbWUpO1xuXHRjb25zdCByZXNvbHZlZCA9IHJlc29sdmVUaGVtZUNvbG9ycyh0aGVtZUpzb24uY29sb3JzLCB0aGVtZUpzb24udmFycyk7XG5cblx0Ly8gRGVmYXVsdCB0ZXh0IGNvbG9yIGZvciBlbXB0eSB2YWx1ZXMgKHRlcm1pbmFsIHVzZXMgZGVmYXVsdCBmZyBjb2xvcilcblx0Y29uc3QgZGVmYXVsdFRleHQgPSBpc0xpZ2h0ID8gXCIjMDAwMDAwXCIgOiBcIiNlNWU1ZTdcIjtcblxuXHRjb25zdCBjc3NDb2xvcnM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcblx0Zm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocmVzb2x2ZWQpKSB7XG5cdFx0aWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJudW1iZXJcIikge1xuXHRcdFx0Y3NzQ29sb3JzW2tleV0gPSBhbnNpMjU2VG9IZXgodmFsdWUpO1xuXHRcdH0gZWxzZSBpZiAodmFsdWUgPT09IFwiXCIpIHtcblx0XHRcdC8vIEVtcHR5IG1lYW5zIGRlZmF1bHQgdGVybWluYWwgY29sb3IgLSB1c2Ugc2Vuc2libGUgZmFsbGJhY2sgZm9yIEhUTUxcblx0XHRcdGNzc0NvbG9yc1trZXldID0gZGVmYXVsdFRleHQ7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGNzc0NvbG9yc1trZXldID0gdmFsdWU7XG5cdFx0fVxuXHR9XG5cdHJldHVybiBjc3NDb2xvcnM7XG59XG5cbi8qKlxuICogR2V0IGV4cGxpY2l0IGV4cG9ydCBjb2xvcnMgZnJvbSB0aGVtZSBKU09OLCBpZiBzcGVjaWZpZWQuXG4gKiBSZXR1cm5zIHVuZGVmaW5lZCBmb3IgZWFjaCBjb2xvciB0aGF0IGlzbid0IGV4cGxpY2l0bHkgc2V0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0VGhlbWVFeHBvcnRDb2xvcnModGhlbWVOYW1lPzogc3RyaW5nKToge1xuXHRwYWdlQmc/OiBzdHJpbmc7XG5cdGNhcmRCZz86IHN0cmluZztcblx0aW5mb0JnPzogc3RyaW5nO1xufSB7XG5cdGNvbnN0IG5hbWUgPSB0aGVtZU5hbWUgPz8gY3VycmVudFRoZW1lTmFtZSA/PyBnZXREZWZhdWx0VGhlbWUoKTtcblx0dHJ5IHtcblx0XHRjb25zdCB0aGVtZUpzb24gPSBsb2FkVGhlbWVKc29uKG5hbWUpO1xuXHRcdGNvbnN0IGV4cG9ydFNlY3Rpb24gPSB0aGVtZUpzb24uZXhwb3J0O1xuXHRcdGlmICghZXhwb3J0U2VjdGlvbikgcmV0dXJuIHt9O1xuXG5cdFx0Y29uc3QgdmFycyA9IHRoZW1lSnNvbi52YXJzID8/IHt9O1xuXHRcdGNvbnN0IHJlc29sdmUgPSAodmFsdWU6IHN0cmluZyB8IG51bWJlciB8IHVuZGVmaW5lZCk6IHN0cmluZyB8IHVuZGVmaW5lZCA9PiB7XG5cdFx0XHRpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcblx0XHRcdGlmICh0eXBlb2YgdmFsdWUgPT09IFwibnVtYmVyXCIpIHJldHVybiBhbnNpMjU2VG9IZXgodmFsdWUpO1xuXHRcdFx0aWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIkXCIpKSB7XG5cdFx0XHRcdGNvbnN0IHJlc29sdmVkID0gdmFyc1t2YWx1ZV07XG5cdFx0XHRcdGlmIChyZXNvbHZlZCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkO1xuXHRcdFx0XHRpZiAodHlwZW9mIHJlc29sdmVkID09PSBcIm51bWJlclwiKSByZXR1cm4gYW5zaTI1NlRvSGV4KHJlc29sdmVkKTtcblx0XHRcdFx0cmV0dXJuIHJlc29sdmVkO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIHZhbHVlO1xuXHRcdH07XG5cblx0XHRyZXR1cm4ge1xuXHRcdFx0cGFnZUJnOiByZXNvbHZlKGV4cG9ydFNlY3Rpb24ucGFnZUJnKSxcblx0XHRcdGNhcmRCZzogcmVzb2x2ZShleHBvcnRTZWN0aW9uLmNhcmRCZyksXG5cdFx0XHRpbmZvQmc6IHJlc29sdmUoZXhwb3J0U2VjdGlvbi5pbmZvQmcpLFxuXHRcdH07XG5cdH0gY2F0Y2gge1xuXHRcdHJldHVybiB7fTtcblx0fVxufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBUVUkgSGVscGVyc1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5sZXQgY2FjaGVkSGlnaGxpZ2h0Q29sb3JzRm9yOiBUaGVtZSB8IHVuZGVmaW5lZDtcbmxldCBjYWNoZWRIaWdobGlnaHRDb2xvcnM6IEhpZ2hsaWdodENvbG9ycyB8IHVuZGVmaW5lZDtcblxuZnVuY3Rpb24gYnVpbGRIaWdobGlnaHRDb2xvcnModDogVGhlbWUpOiBIaWdobGlnaHRDb2xvcnMge1xuXHRyZXR1cm4ge1xuXHRcdGNvbW1lbnQ6IHQuZ2V0RmdBbnNpKFwic3ludGF4Q29tbWVudFwiKSxcblx0XHRrZXl3b3JkOiB0LmdldEZnQW5zaShcInN5bnRheEtleXdvcmRcIiksXG5cdFx0ZnVuY3Rpb246IHQuZ2V0RmdBbnNpKFwic3ludGF4RnVuY3Rpb25cIiksXG5cdFx0dmFyaWFibGU6IHQuZ2V0RmdBbnNpKFwic3ludGF4VmFyaWFibGVcIiksXG5cdFx0c3RyaW5nOiB0LmdldEZnQW5zaShcInN5bnRheFN0cmluZ1wiKSxcblx0XHRudW1iZXI6IHQuZ2V0RmdBbnNpKFwic3ludGF4TnVtYmVyXCIpLFxuXHRcdHR5cGU6IHQuZ2V0RmdBbnNpKFwic3ludGF4VHlwZVwiKSxcblx0XHRvcGVyYXRvcjogdC5nZXRGZ0Fuc2koXCJzeW50YXhPcGVyYXRvclwiKSxcblx0XHRwdW5jdHVhdGlvbjogdC5nZXRGZ0Fuc2koXCJzeW50YXhQdW5jdHVhdGlvblwiKSxcblx0fTtcbn1cblxuZnVuY3Rpb24gZ2V0SGlnaGxpZ2h0Q29sb3JzKHQ6IFRoZW1lKTogSGlnaGxpZ2h0Q29sb3JzIHtcblx0aWYgKGNhY2hlZEhpZ2hsaWdodENvbG9yc0ZvciAhPT0gdCB8fCAhY2FjaGVkSGlnaGxpZ2h0Q29sb3JzKSB7XG5cdFx0Y2FjaGVkSGlnaGxpZ2h0Q29sb3JzRm9yID0gdDtcblx0XHRjYWNoZWRIaWdobGlnaHRDb2xvcnMgPSBidWlsZEhpZ2hsaWdodENvbG9ycyh0KTtcblx0fVxuXHRyZXR1cm4gY2FjaGVkSGlnaGxpZ2h0Q29sb3JzO1xufVxuXG5jb25zdCBMSUdIVFdFSUdIVF9LRVlXT1JEUyA9IG5ldyBTZXQoW1xuXHRcImFzXCIsXG5cdFwiYXN5bmNcIixcblx0XCJhd2FpdFwiLFxuXHRcImJyZWFrXCIsXG5cdFwiY2FzZVwiLFxuXHRcImNhdGNoXCIsXG5cdFwiY2xhc3NcIixcblx0XCJjb25zdFwiLFxuXHRcImNvbnRpbnVlXCIsXG5cdFwiZGVmYXVsdFwiLFxuXHRcImRlZlwiLFxuXHRcImVsc2VcIixcblx0XCJlbnVtXCIsXG5cdFwiZXhwb3J0XCIsXG5cdFwiZXh0ZW5kc1wiLFxuXHRcImZhbHNlXCIsXG5cdFwiZm5cIixcblx0XCJmb3JcIixcblx0XCJmcm9tXCIsXG5cdFwiZnVuY3Rpb25cIixcblx0XCJpZlwiLFxuXHRcImltcG9ydFwiLFxuXHRcImluXCIsXG5cdFwiaW50ZXJmYWNlXCIsXG5cdFwibGV0XCIsXG5cdFwibWF0Y2hcIixcblx0XCJuZXdcIixcblx0XCJudWxsXCIsXG5cdFwicmV0dXJuXCIsXG5cdFwic3RydWN0XCIsXG5cdFwic3dpdGNoXCIsXG5cdFwidGhyb3dcIixcblx0XCJ0cnVlXCIsXG5cdFwidHJ5XCIsXG5cdFwidHlwZVwiLFxuXHRcInVuZGVmaW5lZFwiLFxuXHRcInVzZVwiLFxuXHRcInZhclwiLFxuXHRcIndoaWxlXCIsXG5dKTtcblxuZnVuY3Rpb24gbGlnaHR3ZWlnaHRIaWdobGlnaHRMaW5lKGxpbmU6IHN0cmluZyk6IHN0cmluZyB7XG5cdGxldCBvdXQgPSBcIlwiO1xuXHRsZXQgaSA9IDA7XG5cdHdoaWxlIChpIDwgbGluZS5sZW5ndGgpIHtcblx0XHRjb25zdCBjaCA9IGxpbmVbaV07XG5cdFx0Y29uc3QgbmV4dCA9IGxpbmVbaSArIDFdO1xuXHRcdGlmIChjaCA9PT0gXCIvXCIgJiYgbmV4dCA9PT0gXCIvXCIpIHtcblx0XHRcdG91dCArPSB0aGVtZS5mZyhcInN5bnRheENvbW1lbnRcIiwgbGluZS5zbGljZShpKSk7XG5cdFx0XHRicmVhaztcblx0XHR9XG5cdFx0aWYgKGNoID09PSBcIiNcIikge1xuXHRcdFx0b3V0ICs9IHRoZW1lLmZnKFwic3ludGF4Q29tbWVudFwiLCBsaW5lLnNsaWNlKGkpKTtcblx0XHRcdGJyZWFrO1xuXHRcdH1cblx0XHRpZiAoY2ggPT09ICdcIicgfHwgY2ggPT09IFwiJ1wiIHx8IGNoID09PSBcImBcIikge1xuXHRcdFx0Y29uc3QgcXVvdGUgPSBjaDtcblx0XHRcdGxldCBqID0gaSArIDE7XG5cdFx0XHR3aGlsZSAoaiA8IGxpbmUubGVuZ3RoKSB7XG5cdFx0XHRcdGlmIChsaW5lW2pdID09PSBcIlxcXFxcIikge1xuXHRcdFx0XHRcdGlmIChqICsgMSA+PSBsaW5lLmxlbmd0aCkge1xuXHRcdFx0XHRcdFx0aiA9IGxpbmUubGVuZ3RoO1xuXHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGogKz0gMjtcblx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAobGluZVtqXSA9PT0gcXVvdGUpIHtcblx0XHRcdFx0XHRqKys7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblx0XHRcdFx0aisrO1xuXHRcdFx0fVxuXHRcdFx0b3V0ICs9IHRoZW1lLmZnKFwic3ludGF4U3RyaW5nXCIsIGxpbmUuc2xpY2UoaSwgaikpO1xuXHRcdFx0aSA9IGo7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cdFx0aWYgKC9bQS1aYS16XyRdLy50ZXN0KGNoID8/IFwiXCIpKSB7XG5cdFx0XHRsZXQgaiA9IGkgKyAxO1xuXHRcdFx0d2hpbGUgKGogPCBsaW5lLmxlbmd0aCAmJiAvW0EtWmEtejAtOV8kXS8udGVzdChsaW5lW2pdID8/IFwiXCIpKSBqKys7XG5cdFx0XHRjb25zdCB3b3JkID0gbGluZS5zbGljZShpLCBqKTtcblx0XHRcdG91dCArPSBMSUdIVFdFSUdIVF9LRVlXT1JEUy5oYXMod29yZClcblx0XHRcdFx0PyB0aGVtZS5mZyhcInN5bnRheEtleXdvcmRcIiwgd29yZClcblx0XHRcdFx0OiB3b3JkO1xuXHRcdFx0aSA9IGo7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cdFx0aWYgKC9cXGQvLnRlc3QoY2ggPz8gXCJcIikpIHtcblx0XHRcdGxldCBqID0gaSArIDE7XG5cdFx0XHR3aGlsZSAoaiA8IGxpbmUubGVuZ3RoICYmIC9bXFxkLl9dLy50ZXN0KGxpbmVbal0gPz8gXCJcIikpIGorKztcblx0XHRcdG91dCArPSB0aGVtZS5mZyhcInN5bnRheE51bWJlclwiLCBsaW5lLnNsaWNlKGksIGopKTtcblx0XHRcdGkgPSBqO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXHRcdG91dCArPSBjaDtcblx0XHRpKys7XG5cdH1cblx0cmV0dXJuIG91dDtcbn1cblxuZnVuY3Rpb24gbGlnaHR3ZWlnaHRIaWdobGlnaHRDb2RlKGNvZGU6IHN0cmluZyk6IHN0cmluZ1tdIHtcblx0cmV0dXJuIGNvZGUuc3BsaXQoXCJcXG5cIikubWFwKGxpZ2h0d2VpZ2h0SGlnaGxpZ2h0TGluZSk7XG59XG5cbi8qKlxuICogSGlnaGxpZ2h0IGNvZGUgd2l0aCBzeW50YXggY29sb3JpbmcgYmFzZWQgb24gZmlsZSBleHRlbnNpb24gb3IgbGFuZ3VhZ2UuXG4gKiBSZXR1cm5zIGFycmF5IG9mIGhpZ2hsaWdodGVkIGxpbmVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGlnaGxpZ2h0Q29kZShjb2RlOiBzdHJpbmcsIGxhbmc/OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG5cdGlmICghTkFUSVZFX1RVSV9ISUdITElHSFRfRU5BQkxFRCkge1xuXHRcdHJldHVybiBsYW5nID8gbGlnaHR3ZWlnaHRIaWdobGlnaHRDb2RlKGNvZGUpIDogY29kZS5zcGxpdChcIlxcblwiKTtcblx0fVxuXG5cdGNvbnN0IHZhbGlkTGFuZyA9IGxhbmcgJiYgc3VwcG9ydHNMYW5ndWFnZShsYW5nKSA/IGxhbmcgOiBudWxsO1xuXHR0cnkge1xuXHRcdHJldHVybiBuYXRpdmVIaWdobGlnaHRDb2RlKGNvZGUsIHZhbGlkTGFuZywgZ2V0SGlnaGxpZ2h0Q29sb3JzKHRoZW1lKSkuc3BsaXQoXCJcXG5cIik7XG5cdH0gY2F0Y2gge1xuXHRcdHJldHVybiBjb2RlLnNwbGl0KFwiXFxuXCIpO1xuXHR9XG59XG5cbi8qKlxuICogR2V0IGxhbmd1YWdlIGlkZW50aWZpZXIgZnJvbSBmaWxlIHBhdGggZXh0ZW5zaW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0TGFuZ3VhZ2VGcm9tUGF0aChmaWxlUGF0aDogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0Y29uc3QgZXh0ID0gZmlsZVBhdGguc3BsaXQoXCIuXCIpLnBvcCgpPy50b0xvd2VyQ2FzZSgpO1xuXHRpZiAoIWV4dCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuXHRjb25zdCBleHRUb0xhbmc6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG5cdFx0dHM6IFwidHlwZXNjcmlwdFwiLFxuXHRcdHRzeDogXCJ0eXBlc2NyaXB0XCIsXG5cdFx0anM6IFwiamF2YXNjcmlwdFwiLFxuXHRcdGpzeDogXCJqYXZhc2NyaXB0XCIsXG5cdFx0bWpzOiBcImphdmFzY3JpcHRcIixcblx0XHRjanM6IFwiamF2YXNjcmlwdFwiLFxuXHRcdHB5OiBcInB5dGhvblwiLFxuXHRcdHJiOiBcInJ1YnlcIixcblx0XHRyczogXCJydXN0XCIsXG5cdFx0Z286IFwiZ29cIixcblx0XHRqYXZhOiBcImphdmFcIixcblx0XHRrdDogXCJrb3RsaW5cIixcblx0XHRzd2lmdDogXCJzd2lmdFwiLFxuXHRcdGM6IFwiY1wiLFxuXHRcdGg6IFwiY1wiLFxuXHRcdGNwcDogXCJjcHBcIixcblx0XHRjYzogXCJjcHBcIixcblx0XHRjeHg6IFwiY3BwXCIsXG5cdFx0aHBwOiBcImNwcFwiLFxuXHRcdGNzOiBcImNzaGFycFwiLFxuXHRcdHBocDogXCJwaHBcIixcblx0XHRzaDogXCJiYXNoXCIsXG5cdFx0YmFzaDogXCJiYXNoXCIsXG5cdFx0enNoOiBcImJhc2hcIixcblx0XHRmaXNoOiBcImZpc2hcIixcblx0XHRwczE6IFwicG93ZXJzaGVsbFwiLFxuXHRcdHNxbDogXCJzcWxcIixcblx0XHRodG1sOiBcImh0bWxcIixcblx0XHRodG06IFwiaHRtbFwiLFxuXHRcdGNzczogXCJjc3NcIixcblx0XHRzY3NzOiBcInNjc3NcIixcblx0XHRzYXNzOiBcInNhc3NcIixcblx0XHRsZXNzOiBcImxlc3NcIixcblx0XHRqc29uOiBcImpzb25cIixcblx0XHR5YW1sOiBcInlhbWxcIixcblx0XHR5bWw6IFwieWFtbFwiLFxuXHRcdHRvbWw6IFwidG9tbFwiLFxuXHRcdHhtbDogXCJ4bWxcIixcblx0XHRtZDogXCJtYXJrZG93blwiLFxuXHRcdG1hcmtkb3duOiBcIm1hcmtkb3duXCIsXG5cdFx0ZG9ja2VyZmlsZTogXCJkb2NrZXJmaWxlXCIsXG5cdFx0bWFrZWZpbGU6IFwibWFrZWZpbGVcIixcblx0XHRjbWFrZTogXCJjbWFrZVwiLFxuXHRcdGx1YTogXCJsdWFcIixcblx0XHRwZXJsOiBcInBlcmxcIixcblx0XHRyOiBcInJcIixcblx0XHRzY2FsYTogXCJzY2FsYVwiLFxuXHRcdGNsajogXCJjbG9qdXJlXCIsXG5cdFx0ZXg6IFwiZWxpeGlyXCIsXG5cdFx0ZXhzOiBcImVsaXhpclwiLFxuXHRcdGVybDogXCJlcmxhbmdcIixcblx0XHRoczogXCJoYXNrZWxsXCIsXG5cdFx0bWw6IFwib2NhbWxcIixcblx0XHR2aW06IFwidmltXCIsXG5cdFx0Z3JhcGhxbDogXCJncmFwaHFsXCIsXG5cdFx0cHJvdG86IFwicHJvdG9idWZcIixcblx0XHR0ZjogXCJoY2xcIixcblx0XHRoY2w6IFwiaGNsXCIsXG5cdH07XG5cblx0cmV0dXJuIGV4dFRvTGFuZ1tleHRdO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0TWFya2Rvd25UaGVtZSgpOiBNYXJrZG93blRoZW1lIHtcblx0cmV0dXJuIHtcblx0XHRoZWFkaW5nOiAodGV4dDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcIm1kSGVhZGluZ1wiLCB0ZXh0KSxcblx0XHRsaW5rOiAodGV4dDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcIm1kTGlua1wiLCB0ZXh0KSxcblx0XHRsaW5rVXJsOiAodGV4dDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcIm1kTGlua1VybFwiLCB0ZXh0KSxcblx0XHRjb2RlOiAodGV4dDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcIm1kQ29kZVwiLCB0ZXh0KSxcblx0XHRjb2RlQmxvY2s6ICh0ZXh0OiBzdHJpbmcpID0+IHRoZW1lLmZnKFwibWRDb2RlQmxvY2tcIiwgdGV4dCksXG5cdFx0Y29kZUJsb2NrQm9yZGVyOiAodGV4dDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcIm1kQ29kZUJsb2NrQm9yZGVyXCIsIHRleHQpLFxuXHRcdHF1b3RlOiAodGV4dDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcIm1kUXVvdGVcIiwgdGV4dCksXG5cdFx0cXVvdGVCb3JkZXI6ICh0ZXh0OiBzdHJpbmcpID0+IHRoZW1lLmZnKFwibWRRdW90ZUJvcmRlclwiLCB0ZXh0KSxcblx0XHRocjogKHRleHQ6IHN0cmluZykgPT4gdGhlbWUuZmcoXCJtZEhyXCIsIHRleHQpLFxuXHRcdGxpc3RCdWxsZXQ6ICh0ZXh0OiBzdHJpbmcpID0+IHRoZW1lLmZnKFwibWRMaXN0QnVsbGV0XCIsIHRleHQpLFxuXHRcdGJvbGQ6ICh0ZXh0OiBzdHJpbmcpID0+IHRoZW1lLmJvbGQodGV4dCksXG5cdFx0aXRhbGljOiAodGV4dDogc3RyaW5nKSA9PiB0aGVtZS5pdGFsaWModGV4dCksXG5cdFx0dW5kZXJsaW5lOiAodGV4dDogc3RyaW5nKSA9PiB0aGVtZS51bmRlcmxpbmUodGV4dCksXG5cdFx0c3RyaWtldGhyb3VnaDogKHRleHQ6IHN0cmluZykgPT4gY2hhbGsuc3RyaWtldGhyb3VnaCh0ZXh0KSxcblx0XHRoaWdobGlnaHRDb2RlOiAoY29kZTogc3RyaW5nLCBsYW5nPzogc3RyaW5nKTogc3RyaW5nW10gPT4ge1xuXHRcdFx0aWYgKCFOQVRJVkVfVFVJX0hJR0hMSUdIVF9FTkFCTEVEKSB7XG5cdFx0XHRcdHJldHVybiBjb2RlLnNwbGl0KFwiXFxuXCIpLm1hcCgobGluZSkgPT4gdGhlbWUuZmcoXCJtZENvZGVCbG9ja1wiLCBsaW5lKSk7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHZhbGlkTGFuZyA9IGxhbmcgJiYgc3VwcG9ydHNMYW5ndWFnZShsYW5nKSA/IGxhbmcgOiBudWxsO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0cmV0dXJuIG5hdGl2ZUhpZ2hsaWdodENvZGUoY29kZSwgdmFsaWRMYW5nLCBnZXRIaWdobGlnaHRDb2xvcnModGhlbWUpKS5zcGxpdChcIlxcblwiKTtcblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRyZXR1cm4gY29kZS5zcGxpdChcIlxcblwiKS5tYXAoKGxpbmUpID0+IHRoZW1lLmZnKFwibWRDb2RlQmxvY2tcIiwgbGluZSkpO1xuXHRcdFx0fVxuXHRcdH0sXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRTZWxlY3RMaXN0VGhlbWUoKTogU2VsZWN0TGlzdFRoZW1lIHtcblx0cmV0dXJuIHtcblx0XHRzZWxlY3RlZFByZWZpeDogKHRleHQ6IHN0cmluZykgPT4gdGhlbWUuZmcoXCJhY2NlbnRcIiwgdGV4dCksXG5cdFx0c2VsZWN0ZWRUZXh0OiAodGV4dDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcImFjY2VudFwiLCB0ZXh0KSxcblx0XHRkZXNjcmlwdGlvbjogKHRleHQ6IHN0cmluZykgPT4gdGhlbWUuZmcoXCJtdXRlZFwiLCB0ZXh0KSxcblx0XHRzY3JvbGxJbmZvOiAodGV4dDogc3RyaW5nKSA9PiB0aGVtZS5mZyhcIm11dGVkXCIsIHRleHQpLFxuXHRcdG5vTWF0Y2g6ICh0ZXh0OiBzdHJpbmcpID0+IHRoZW1lLmZnKFwibXV0ZWRcIiwgdGV4dCksXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRFZGl0b3JUaGVtZSgpOiBFZGl0b3JUaGVtZSB7XG5cdHJldHVybiB7XG5cdFx0Ym9yZGVyQ29sb3I6ICh0ZXh0OiBzdHJpbmcpID0+IHRoZW1lLmZnKFwiYm9yZGVyTXV0ZWRcIiwgdGV4dCksXG5cdFx0c2VsZWN0TGlzdDogZ2V0U2VsZWN0TGlzdFRoZW1lKCksXG5cdH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRTZXR0aW5nc0xpc3RUaGVtZSgpOiBpbXBvcnQoXCJAZ3NkL3BpLXR1aVwiKS5TZXR0aW5nc0xpc3RUaGVtZSB7XG5cdHJldHVybiB7XG5cdFx0bGFiZWw6ICh0ZXh0OiBzdHJpbmcsIHNlbGVjdGVkOiBib29sZWFuKSA9PiAoc2VsZWN0ZWQgPyB0aGVtZS5mZyhcImFjY2VudFwiLCB0ZXh0KSA6IHRleHQpLFxuXHRcdHZhbHVlOiAodGV4dDogc3RyaW5nLCBzZWxlY3RlZDogYm9vbGVhbikgPT4gKHNlbGVjdGVkID8gdGhlbWUuZmcoXCJhY2NlbnRcIiwgdGV4dCkgOiB0aGVtZS5mZyhcIm11dGVkXCIsIHRleHQpKSxcblx0XHRkZXNjcmlwdGlvbjogKHRleHQ6IHN0cmluZykgPT4gdGhlbWUuZmcoXCJkaW1cIiwgdGV4dCksXG5cdFx0Y3Vyc29yOiB0aGVtZS5mZyhcImFjY2VudFwiLCBcIlx1MjE5MiBcIiksXG5cdFx0aGludDogKHRleHQ6IHN0cmluZykgPT4gdGhlbWUuZmcoXCJkaW1cIiwgdGV4dCksXG5cdH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxZQUFZLFFBQVE7QUFDcEIsWUFBWSxVQUFVO0FBRXRCLFNBQVMsb0JBQW9CO0FBQzdCLE9BQU8sV0FBVztBQUNsQjtBQUFBLEVBQ0MsaUJBQWlCO0FBQUEsRUFDakI7QUFBQSxPQUVNO0FBQ1AsU0FBUywwQkFBMEI7QUFDbkMsU0FBUyx1QkFBd0Q7QUFDakUsU0FBUyxxQkFBcUI7QUFLOUIsTUFBTSwrQkFBK0IsUUFBUSxJQUFJLG9DQUFvQztBQU1yRixNQUFNLG9CQUFvQixhQUFhLFFBQVEsZUFBZTtBQTRFOUQsU0FBUyxrQkFBNkI7QUFDckMsUUFBTSxZQUFZLFFBQVEsSUFBSTtBQUM5QixNQUFJLGNBQWMsZUFBZSxjQUFjLFNBQVM7QUFDdkQsV0FBTztBQUFBLEVBQ1I7QUFFQSxNQUFJLFFBQVEsSUFBSSxZQUFZO0FBQzNCLFdBQU87QUFBQSxFQUNSO0FBQ0EsUUFBTSxPQUFPLFFBQVEsSUFBSSxRQUFRO0FBRWpDLE1BQUksU0FBUyxVQUFVLFNBQVMsTUFBTSxTQUFTLFNBQVM7QUFDdkQsV0FBTztBQUFBLEVBQ1I7QUFFQSxNQUFJLFFBQVEsSUFBSSxpQkFBaUIsa0JBQWtCO0FBQ2xELFdBQU87QUFBQSxFQUNSO0FBR0EsTUFBSSxTQUFTLFlBQVksS0FBSyxXQUFXLFNBQVMsS0FBSyxLQUFLLFdBQVcsU0FBUyxHQUFHO0FBQ2xGLFdBQU87QUFBQSxFQUNSO0FBRUEsU0FBTztBQUNSO0FBRUEsU0FBUyxTQUFTLEtB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Y0FBYyxJQUFJO0FBQUEsSUFDekQsZUFBZSxDQUFDLE1BQWMsU0FBNEI7QUFDekQsVUFBSSxDQUFDLDhCQUE4QjtBQUNsQyxlQUFPLEtBQUssTUFBTSxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsTUFBTSxHQUFHLGVBQWUsSUFBSSxDQUFDO0FBQUEsTUFDcEU7QUFFQSxZQUFNLFlBQVksUUFBUSxpQkFBaUIsSUFBSSxJQUFJLE9BQU87QUFDMUQsVUFBSTtBQUNILGVBQU8sb0JBQW9CLE1BQU0sV0FBVyxtQkFBbUIsS0FBSyxDQUFDLEVBQUUsTUFBTSxJQUFJO0FBQUEsTUFDbEYsUUFBUTtBQUNQLGVBQU8sS0FBSyxNQUFNLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxNQUFNLEdBQUcsZUFBZSxJQUFJLENBQUM7QUFBQSxNQUNwRTtBQUFBLElBQ0Q7QUFBQSxFQUNEO0FBQ0Q7QUFFTyxTQUFTLHFCQUFzQztBQUNyRCxTQUFPO0FBQUEsSUFDTixnQkFBZ0IsQ0FBQyxTQUFpQixNQUFNLEdBQUcsVUFBVSxJQUFJO0FBQUEsSUFDekQsY0FBYyxDQUFDLFNBQWlCLE1BQU0sR0FBRyxVQUFVLElBQUk7QUFBQSxJQUN2RCxhQUFhLENBQUMsU0FBaUIsTUFBTSxHQUFHLFNBQVMsSUFBSTtBQUFBLElBQ3JELFlBQVksQ0FBQyxTQUFpQixNQUFNLEdBQUcsU0FBUyxJQUFJO0FBQUEsSUFDcEQsU0FBUyxDQUFDLFNBQWlCLE1BQU0sR0FBRyxTQUFTLElBQUk7QUFBQSxFQUNsRDtBQUNEO0FBRU8sU0FBUyxpQkFBOEI7QUFDN0MsU0FBTztBQUFBLElBQ04sYUFBYSxDQUFDLFNBQWlCLE1BQU0sR0FBRyxlQUFlLElBQUk7QUFBQSxJQUMzRCxZQUFZLG1CQUFtQjtBQUFBLEVBQ2hDO0FBQ0Q7QUFFTyxTQUFTLHVCQUFnRTtBQUMvRSxTQUFPO0FBQUEsSUFDTixPQUFPLENBQUMsTUFBYyxhQUF1QixXQUFXLE1BQU0sR0FBRyxVQUFVLElBQUksSUFBSTtBQUFBLElBQ25GLE9BQU8sQ0FBQyxNQUFjLGFBQXVCLFdBQVcsTUFBTSxHQUFHLFVBQVUsSUFBSSxJQUFJLE1BQU0sR0FBRyxTQUFTLElBQUk7QUFBQSxJQUN6RyxhQUFhLENBQUMsU0FBaUIsTUFBTSxHQUFHLE9BQU8sSUFBSTtBQUFBLElBQ25ELFFBQVEsTUFBTSxHQUFHLFVBQVUsU0FBSTtBQUFBLElBQy9CLE1BQU0sQ0FBQyxTQUFpQixNQUFNLEdBQUcsT0FBTyxJQUFJO0FBQUEsRUFDN0M7QUFDRDsiLAogICJuYW1lcyI6IFsidGhlbWUiLCAiYnVpbHRpblRoZW1lcyIsICJjb250ZW50Il0KfQo=
