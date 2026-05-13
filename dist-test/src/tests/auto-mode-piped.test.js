import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { shouldRedirectAutoToHeadless } from "../cli-auto-routing.js";
test("routes `gsd auto` with piped stdout to headless mode (#2732)", () => {
  assert.equal(shouldRedirectAutoToHeadless("auto", true, false), true);
});
test("routes `gsd auto` with piped stdin to headless mode", () => {
  assert.equal(shouldRedirectAutoToHeadless("auto", false, true), true);
});
test("src/cli.ts routes `gsd auto` with piped stdout through the headless entrypoint", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "gsd-auto-cli-route-"));
  const loaderPath = join(tempDir, "stub-loader.mjs");
  try {
    writeFileSync(loaderPath, `
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = pathToFileURL(process.cwd() + '/').href
const modules = new Map([
  ['stub:pi-coding-agent', \`
    export class AuthStorage {}
    export const DEFAULT_MAX_BYTES = 0
    export const DEFAULT_MAX_LINES = 0
    export function createBashTool() {}
    export function createEditTool() {}
    export function createReadTool() {}
    export function createWriteTool() {}
    export function formatSize() { return '' }
    export function getAgentDir() { return '' }
    export function getAllToolCompatibility() { return {} }
    export function getLoadedSkills() { return [] }
    export function getToolCompatibility() { return {} }
    export function importExtensionModule() { return {} }
    export function isToolCallEventType() { return false }
    export function parseFrontmatter() { return {} }
    export function setAllowedCommandPrefixes() {}
    export function truncateHead(value) { return value }
  \`],
  ['stub:pi-ai', \`
    export async function completeSimple() { return {} }
    export function getEnvApiKey() { return undefined }
    export function getProviderCapabilities() { return {} }
    export function isAnthropicApi() { return false }
    export function StringEnum() { return {} }
  \`],
  ['stub:pi-tui', \`
    export const Key = {}
    export const Text = {}
    export function matchesKey() { return false }
    export function truncateToWidth(value) { return String(value) }
    export function visibleWidth(value) { return String(value).length }
    export function wrapTextWithAnsi(value) { return [String(value)] }
  \`],
  ['stub:chalk', \`
    const passthrough = (value) => String(value)
    passthrough.bold = passthrough
    passthrough.dim = passthrough
    passthrough.yellow = passthrough
    passthrough.green = passthrough
    passthrough.cyan = passthrough
    passthrough.red = passthrough
    export default passthrough
  \`],
  ['stub:headless', \`
    export function parseHeadlessArgs(argv) {
      process.stderr.write('AUTO_REDIRECT_ARGV ' + JSON.stringify(argv) + '\\\\n')
      return { argv }
    }
    export async function runHeadless(options) {
      process.stderr.write('AUTO_REDIRECT_RUN ' + JSON.stringify(options) + '\\\\n')
    }
  \`],
])

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@gsd/pi-coding-agent') return { url: 'stub:pi-coding-agent', shortCircuit: true }
  if (specifier === '@gsd/pi-ai' || specifier === '@gsd/pi-ai/oauth') return { url: 'stub:pi-ai', shortCircuit: true }
  if (specifier === '@gsd/pi-tui') return { url: 'stub:pi-tui', shortCircuit: true }
  if (specifier === 'chalk') return { url: 'stub:chalk', shortCircuit: true }
  if (specifier === './headless.js' && context.parentURL?.endsWith('/src/cli.ts')) {
    return { url: 'stub:headless', shortCircuit: true }
  }
  if (
    specifier.endsWith('.js') &&
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    context.parentURL?.startsWith(root)
  ) {
    const url = new URL(specifier.replace(/\\.js$/, '.ts'), context.parentURL)
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  const source = modules.get(url)
  if (source !== undefined) return { format: 'module', source, shortCircuit: true }
  return nextLoad(url, context)
}
`);
    const registerLoader = `
      import { register } from 'node:module'
      import { pathToFileURL } from 'node:url'
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
      register(${JSON.stringify(pathToFileURL(loaderPath).href)}, pathToFileURL('./'))
    `;
    const result = spawnSync(process.execPath, [
      "--import",
      `data:text/javascript,${encodeURIComponent(registerLoader)}`,
      "--experimental-strip-types",
      join(process.cwd(), "src", "cli.ts"),
      "auto",
      "--model",
      "test-model"
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GSD_HOME: join(tempDir, "home"),
        GSD_RTK_DISABLED: "1"
      },
      encoding: "utf8",
      input: "",
      stdio: ["pipe", "pipe", "pipe"]
    });
    assert.equal(result.status, 0, result.stderr);
    const markerLine = result.stderr.split(/\r?\n/).find((line) => line.startsWith("AUTO_REDIRECT_ARGV "));
    assert.ok(markerLine, result.stderr);
    const headlessArgv = JSON.parse(markerLine.slice("AUTO_REDIRECT_ARGV ".length));
    assert.deepEqual(headlessArgv.slice(2), ["headless", "--model", "test-model", "auto"]);
    assert.match(result.stderr, /AUTO_REDIRECT_RUN /);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
test("keeps terminal `gsd auto` on the interactive path", () => {
  assert.equal(shouldRedirectAutoToHeadless("auto", true, true), false);
});
test("does not route non-auto subcommands through auto headless mode", () => {
  assert.equal(shouldRedirectAutoToHeadless("headless", true, false), false);
  assert.equal(shouldRedirectAutoToHeadless("config", true, false), false);
  assert.equal(shouldRedirectAutoToHeadless(void 0, false, false), false);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL2F1dG8tbW9kZS1waXBlZC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFRlc3RzIGZvciBgZ3NkIGF1dG9gIHJvdXRpbmcgXHUyMDE0IHZlcmlmaWVzIHRoYXQgYGF1dG9gIGlzIHJlY29nbml6ZWQgYXMgYVxuICogc3ViY29tbWFuZCBhbGlhcyBmb3IgYGhlYWRsZXNzIGF1dG9gIG9ubHkgd2hlbiBzdGRpbiBvciBzdGRvdXQgYXJlIG5vdCBUVFlzLlxuICpcbiAqIFJlZ3Jlc3Npb24gdGVzdCBmb3IgIzI3MzIuXG4gKi9cblxuaW1wb3J0IHRlc3QgZnJvbSAnbm9kZTp0ZXN0J1xuaW1wb3J0IGFzc2VydCBmcm9tICdub2RlOmFzc2VydC9zdHJpY3QnXG5pbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnXG5pbXBvcnQgeyBta2R0ZW1wU3luYywgcm1TeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcydcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gJ25vZGU6b3MnXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJ1xuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJ1xuXG5pbXBvcnQgeyBzaG91bGRSZWRpcmVjdEF1dG9Ub0hlYWRsZXNzIH0gZnJvbSAnLi4vY2xpLWF1dG8tcm91dGluZy5qcydcblxudGVzdCgncm91dGVzIGBnc2QgYXV0b2Agd2l0aCBwaXBlZCBzdGRvdXQgdG8gaGVhZGxlc3MgbW9kZSAoIzI3MzIpJywgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoc2hvdWxkUmVkaXJlY3RBdXRvVG9IZWFkbGVzcygnYXV0bycsIHRydWUsIGZhbHNlKSwgdHJ1ZSlcbn0pXG5cbnRlc3QoJ3JvdXRlcyBgZ3NkIGF1dG9gIHdpdGggcGlwZWQgc3RkaW4gdG8gaGVhZGxlc3MgbW9kZScsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKHNob3VsZFJlZGlyZWN0QXV0b1RvSGVhZGxlc3MoJ2F1dG8nLCBmYWxzZSwgdHJ1ZSksIHRydWUpXG59KVxuXG50ZXN0KCdzcmMvY2xpLnRzIHJvdXRlcyBgZ3NkIGF1dG9gIHdpdGggcGlwZWQgc3Rkb3V0IHRocm91Z2ggdGhlIGhlYWRsZXNzIGVudHJ5cG9pbnQnLCAoKSA9PiB7XG4gIGNvbnN0IHRlbXBEaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCAnZ3NkLWF1dG8tY2xpLXJvdXRlLScpKVxuICBjb25zdCBsb2FkZXJQYXRoID0gam9pbih0ZW1wRGlyLCAnc3R1Yi1sb2FkZXIubWpzJylcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGxvYWRlclBhdGgsIGBcbmltcG9ydCB7IGV4aXN0c1N5bmMgfSBmcm9tICdub2RlOmZzJ1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCwgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJ1xuXG5jb25zdCByb290ID0gcGF0aFRvRmlsZVVSTChwcm9jZXNzLmN3ZCgpICsgJy8nKS5ocmVmXG5jb25zdCBtb2R1bGVzID0gbmV3IE1hcChbXG4gIFsnc3R1YjpwaS1jb2RpbmctYWdlbnQnLCBcXGBcbiAgICBleHBvcnQgY2xhc3MgQXV0aFN0b3JhZ2Uge31cbiAgICBleHBvcnQgY29uc3QgREVGQVVMVF9NQVhfQllURVMgPSAwXG4gICAgZXhwb3J0IGNvbnN0IERFRkFVTFRfTUFYX0xJTkVTID0gMFxuICAgIGV4cG9ydCBmdW5jdGlvbiBjcmVhdGVCYXNoVG9vbCgpIHt9XG4gICAgZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUVkaXRUb29sKCkge31cbiAgICBleHBvcnQgZnVuY3Rpb24gY3JlYXRlUmVhZFRvb2woKSB7fVxuICAgIGV4cG9ydCBmdW5jdGlvbiBjcmVhdGVXcml0ZVRvb2woKSB7fVxuICAgIGV4cG9ydCBmdW5jdGlvbiBmb3JtYXRTaXplKCkgeyByZXR1cm4gJycgfVxuICAgIGV4cG9ydCBmdW5jdGlvbiBnZXRBZ2VudERpcigpIHsgcmV0dXJuICcnIH1cbiAgICBleHBvcnQgZnVuY3Rpb24gZ2V0QWxsVG9vbENvbXBhdGliaWxpdHkoKSB7IHJldHVybiB7fSB9XG4gICAgZXhwb3J0IGZ1bmN0aW9uIGdldExvYWRlZFNraWxscygpIHsgcmV0dXJuIFtdIH1cbiAgICBleHBvcnQgZnVuY3Rpb24gZ2V0VG9vbENvbXBhdGliaWxpdHkoKSB7IHJldHVybiB7fSB9XG4gICAgZXhwb3J0IGZ1bmN0aW9uIGltcG9ydEV4dGVuc2lvbk1vZHVsZSgpIHsgcmV0dXJuIHt9IH1cbiAgICBleHBvcnQgZnVuY3Rpb24gaXNUb29sQ2FsbEV2ZW50VHlwZSgpIHsgcmV0dXJuIGZhbHNlIH1cbiAgICBleHBvcnQgZnVuY3Rpb24gcGFyc2VGcm9udG1hdHRlcigpIHsgcmV0dXJuIHt9IH1cbiAgICBleHBvcnQgZnVuY3Rpb24gc2V0QWxsb3dlZENvbW1hbmRQcmVmaXhlcygpIHt9XG4gICAgZXhwb3J0IGZ1bmN0aW9uIHRydW5jYXRlSGVhZCh2YWx1ZSkgeyByZXR1cm4gdmFsdWUgfVxuICBcXGBdLFxuICBbJ3N0dWI6cGktYWknLCBcXGBcbiAgICBleHBvcnQgYXN5bmMgZnVuY3Rpb24gY29tcGxldGVTaW1wbGUoKSB7IHJldHVybiB7fSB9XG4gICAgZXhwb3J0IGZ1bmN0aW9uIGdldEVudkFwaUtleSgpIHsgcmV0dXJuIHVuZGVmaW5lZCB9XG4gICAgZXhwb3J0IGZ1bmN0aW9uIGdldFByb3ZpZGVyQ2FwYWJpbGl0aWVzKCkgeyByZXR1cm4ge30gfVxuICAgIGV4cG9ydCBmdW5jdGlvbiBpc0FudGhyb3BpY0FwaSgpIHsgcmV0dXJuIGZhbHNlIH1cbiAgICBleHBvcnQgZnVuY3Rpb24gU3RyaW5nRW51bSgpIHsgcmV0dXJuIHt9IH1cbiAgXFxgXSxcbiAgWydzdHViOnBpLXR1aScsIFxcYFxuICAgIGV4cG9ydCBjb25zdCBLZXkgPSB7fVxuICAgIGV4cG9ydCBjb25zdCBUZXh0ID0ge31cbiAgICBleHBvcnQgZnVuY3Rpb24gbWF0Y2hlc0tleSgpIHsgcmV0dXJuIGZhbHNlIH1cbiAgICBleHBvcnQgZnVuY3Rpb24gdHJ1bmNhdGVUb1dpZHRoKHZhbHVlKSB7IHJldHVybiBTdHJpbmcodmFsdWUpIH1cbiAgICBleHBvcnQgZnVuY3Rpb24gdmlzaWJsZVdpZHRoKHZhbHVlKSB7IHJldHVybiBTdHJpbmcodmFsdWUpLmxlbmd0aCB9XG4gICAgZXhwb3J0IGZ1bmN0aW9uIHdyYXBUZXh0V2l0aEFuc2kodmFsdWUpIHsgcmV0dXJuIFtTdHJpbmcodmFsdWUpXSB9XG4gIFxcYF0sXG4gIFsnc3R1YjpjaGFsaycsIFxcYFxuICAgIGNvbnN0IHBhc3N0aHJvdWdoID0gKHZhbHVlKSA9PiBTdHJpbmcodmFsdWUpXG4gICAgcGFzc3Rocm91Z2guYm9sZCA9IHBhc3N0aHJvdWdoXG4gICAgcGFzc3Rocm91Z2guZGltID0gcGFzc3Rocm91Z2hcbiAgICBwYXNzdGhyb3VnaC55ZWxsb3cgPSBwYXNzdGhyb3VnaFxuICAgIHBhc3N0aHJvdWdoLmdyZWVuID0gcGFzc3Rocm91Z2hcbiAgICBwYXNzdGhyb3VnaC5jeWFuID0gcGFzc3Rocm91Z2hcbiAgICBwYXNzdGhyb3VnaC5yZWQgPSBwYXNzdGhyb3VnaFxuICAgIGV4cG9ydCBkZWZhdWx0IHBhc3N0aHJvdWdoXG4gIFxcYF0sXG4gIFsnc3R1YjpoZWFkbGVzcycsIFxcYFxuICAgIGV4cG9ydCBmdW5jdGlvbiBwYXJzZUhlYWRsZXNzQXJncyhhcmd2KSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZSgnQVVUT19SRURJUkVDVF9BUkdWICcgKyBKU09OLnN0cmluZ2lmeShhcmd2KSArICdcXFxcXFxcXG4nKVxuICAgICAgcmV0dXJuIHsgYXJndiB9XG4gICAgfVxuICAgIGV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5IZWFkbGVzcyhvcHRpb25zKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZSgnQVVUT19SRURJUkVDVF9SVU4gJyArIEpTT04uc3RyaW5naWZ5KG9wdGlvbnMpICsgJ1xcXFxcXFxcbicpXG4gICAgfVxuICBcXGBdLFxuXSlcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc29sdmUoc3BlY2lmaWVyLCBjb250ZXh0LCBuZXh0UmVzb2x2ZSkge1xuICBpZiAoc3BlY2lmaWVyID09PSAnQGdzZC9waS1jb2RpbmctYWdlbnQnKSByZXR1cm4geyB1cmw6ICdzdHViOnBpLWNvZGluZy1hZ2VudCcsIHNob3J0Q2lyY3VpdDogdHJ1ZSB9XG4gIGlmIChzcGVjaWZpZXIgPT09ICdAZ3NkL3BpLWFpJyB8fCBzcGVjaWZpZXIgPT09ICdAZ3NkL3BpLWFpL29hdXRoJykgcmV0dXJuIHsgdXJsOiAnc3R1YjpwaS1haScsIHNob3J0Q2lyY3VpdDogdHJ1ZSB9XG4gIGlmIChzcGVjaWZpZXIgPT09ICdAZ3NkL3BpLXR1aScpIHJldHVybiB7IHVybDogJ3N0dWI6cGktdHVpJywgc2hvcnRDaXJjdWl0OiB0cnVlIH1cbiAgaWYgKHNwZWNpZmllciA9PT0gJ2NoYWxrJykgcmV0dXJuIHsgdXJsOiAnc3R1YjpjaGFsaycsIHNob3J0Q2lyY3VpdDogdHJ1ZSB9XG4gIGlmIChzcGVjaWZpZXIgPT09ICcuL2hlYWRsZXNzLmpzJyAmJiBjb250ZXh0LnBhcmVudFVSTD8uZW5kc1dpdGgoJy9zcmMvY2xpLnRzJykpIHtcbiAgICByZXR1cm4geyB1cmw6ICdzdHViOmhlYWRsZXNzJywgc2hvcnRDaXJjdWl0OiB0cnVlIH1cbiAgfVxuICBpZiAoXG4gICAgc3BlY2lmaWVyLmVuZHNXaXRoKCcuanMnKSAmJlxuICAgIChzcGVjaWZpZXIuc3RhcnRzV2l0aCgnLi8nKSB8fCBzcGVjaWZpZXIuc3RhcnRzV2l0aCgnLi4vJykpICYmXG4gICAgY29udGV4dC5wYXJlbnRVUkw/LnN0YXJ0c1dpdGgocm9vdClcbiAgKSB7XG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChzcGVjaWZpZXIucmVwbGFjZSgvXFxcXC5qcyQvLCAnLnRzJyksIGNvbnRleHQucGFyZW50VVJMKVxuICAgIGlmIChleGlzdHNTeW5jKGZpbGVVUkxUb1BhdGgodXJsKSkpIHJldHVybiB7IHVybDogdXJsLmhyZWYsIHNob3J0Q2lyY3VpdDogdHJ1ZSB9XG4gIH1cbiAgcmV0dXJuIG5leHRSZXNvbHZlKHNwZWNpZmllciwgY29udGV4dClcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWQodXJsLCBjb250ZXh0LCBuZXh0TG9hZCkge1xuICBjb25zdCBzb3VyY2UgPSBtb2R1bGVzLmdldCh1cmwpXG4gIGlmIChzb3VyY2UgIT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZm9ybWF0OiAnbW9kdWxlJywgc291cmNlLCBzaG9ydENpcmN1aXQ6IHRydWUgfVxuICByZXR1cm4gbmV4dExvYWQodXJsLCBjb250ZXh0KVxufVxuYClcblxuICAgIGNvbnN0IHJlZ2lzdGVyTG9hZGVyID0gYFxuICAgICAgaW1wb3J0IHsgcmVnaXN0ZXIgfSBmcm9tICdub2RlOm1vZHVsZSdcbiAgICAgIGltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tICdub2RlOnVybCdcbiAgICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0eShwcm9jZXNzLnN0ZGluLCAnaXNUVFknLCB7IGNvbmZpZ3VyYWJsZTogdHJ1ZSwgdmFsdWU6IHRydWUgfSlcbiAgICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0eShwcm9jZXNzLnN0ZG91dCwgJ2lzVFRZJywgeyBjb25maWd1cmFibGU6IHRydWUsIHZhbHVlOiBmYWxzZSB9KVxuICAgICAgcmVnaXN0ZXIoJHtKU09OLnN0cmluZ2lmeShwYXRoVG9GaWxlVVJMKGxvYWRlclBhdGgpLmhyZWYpfSwgcGF0aFRvRmlsZVVSTCgnLi8nKSlcbiAgICBgXG4gICAgY29uc3QgcmVzdWx0ID0gc3Bhd25TeW5jKHByb2Nlc3MuZXhlY1BhdGgsIFtcbiAgICAgICctLWltcG9ydCcsXG4gICAgICBgZGF0YTp0ZXh0L2phdmFzY3JpcHQsJHtlbmNvZGVVUklDb21wb25lbnQocmVnaXN0ZXJMb2FkZXIpfWAsXG4gICAgICAnLS1leHBlcmltZW50YWwtc3RyaXAtdHlwZXMnLFxuICAgICAgam9pbihwcm9jZXNzLmN3ZCgpLCAnc3JjJywgJ2NsaS50cycpLFxuICAgICAgJ2F1dG8nLFxuICAgICAgJy0tbW9kZWwnLFxuICAgICAgJ3Rlc3QtbW9kZWwnLFxuICAgIF0sIHtcbiAgICAgIGN3ZDogcHJvY2Vzcy5jd2QoKSxcbiAgICAgIGVudjoge1xuICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgR1NEX0hPTUU6IGpvaW4odGVtcERpciwgJ2hvbWUnKSxcbiAgICAgICAgR1NEX1JUS19ESVNBQkxFRDogJzEnLFxuICAgICAgfSxcbiAgICAgIGVuY29kaW5nOiAndXRmOCcsXG4gICAgICBpbnB1dDogJycsXG4gICAgICBzdGRpbzogWydwaXBlJywgJ3BpcGUnLCAncGlwZSddLFxuICAgIH0pXG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgMCwgcmVzdWx0LnN0ZGVycilcbiAgICBjb25zdCBtYXJrZXJMaW5lID0gcmVzdWx0LnN0ZGVyclxuICAgICAgLnNwbGl0KC9cXHI/XFxuLylcbiAgICAgIC5maW5kKChsaW5lKSA9PiBsaW5lLnN0YXJ0c1dpdGgoJ0FVVE9fUkVESVJFQ1RfQVJHViAnKSlcbiAgICBhc3NlcnQub2sobWFya2VyTGluZSwgcmVzdWx0LnN0ZGVycilcblxuICAgIGNvbnN0IGhlYWRsZXNzQXJndiA9IEpTT04ucGFyc2UobWFya2VyTGluZS5zbGljZSgnQVVUT19SRURJUkVDVF9BUkdWICcubGVuZ3RoKSkgYXMgc3RyaW5nW11cbiAgICBhc3NlcnQuZGVlcEVxdWFsKGhlYWRsZXNzQXJndi5zbGljZSgyKSwgWydoZWFkbGVzcycsICctLW1vZGVsJywgJ3Rlc3QtbW9kZWwnLCAnYXV0byddKVxuICAgIGFzc2VydC5tYXRjaChyZXN1bHQuc3RkZXJyLCAvQVVUT19SRURJUkVDVF9SVU4gLylcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModGVtcERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pXG4gIH1cbn0pXG5cbnRlc3QoJ2tlZXBzIHRlcm1pbmFsIGBnc2QgYXV0b2Agb24gdGhlIGludGVyYWN0aXZlIHBhdGgnLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChzaG91bGRSZWRpcmVjdEF1dG9Ub0hlYWRsZXNzKCdhdXRvJywgdHJ1ZSwgdHJ1ZSksIGZhbHNlKVxufSlcblxudGVzdCgnZG9lcyBub3Qgcm91dGUgbm9uLWF1dG8gc3ViY29tbWFuZHMgdGhyb3VnaCBhdXRvIGhlYWRsZXNzIG1vZGUnLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChzaG91bGRSZWRpcmVjdEF1dG9Ub0hlYWRsZXNzKCdoZWFkbGVzcycsIHRydWUsIGZhbHNlKSwgZmFsc2UpXG4gIGFzc2VydC5lcXVhbChzaG91bGRSZWRpcmVjdEF1dG9Ub0hlYWRsZXNzKCdjb25maWcnLCB0cnVlLCBmYWxzZSksIGZhbHNlKVxuICBhc3NlcnQuZXF1YWwoc2hvdWxkUmVkaXJlY3RBdXRvVG9IZWFkbGVzcyh1bmRlZmluZWQsIGZhbHNlLCBmYWxzZSksIGZhbHNlKVxufSlcbiJdLAogICJtYXBwaW5ncyI6ICJBQU9BLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFDbkIsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxhQUFhLFFBQVEscUJBQXFCO0FBQ25ELFNBQVMsY0FBYztBQUN2QixTQUFTLFlBQVk7QUFDckIsU0FBUyxxQkFBcUI7QUFFOUIsU0FBUyxvQ0FBb0M7QUFFN0MsS0FBSyxnRUFBZ0UsTUFBTTtBQUN6RSxTQUFPLE1BQU0sNkJBQTZCLFFBQVEsTUFBTSxLQUFLLEdBQUcsSUFBSTtBQUN0RSxDQUFDO0FBRUQsS0FBSyx1REFBdUQsTUFBTTtBQUNoRSxTQUFPLE1BQU0sNkJBQTZCLFFBQVEsT0FBTyxJQUFJLEdBQUcsSUFBSTtBQUN0RSxDQUFDO0FBRUQsS0FBSyxrRkFBa0YsTUFBTTtBQUMzRixRQUFNLFVBQVUsWUFBWSxLQUFLLE9BQU8sR0FBRyxxQkFBcUIsQ0FBQztBQUNqRSxRQUFNLGFBQWEsS0FBSyxTQUFTLGlCQUFpQjtB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
