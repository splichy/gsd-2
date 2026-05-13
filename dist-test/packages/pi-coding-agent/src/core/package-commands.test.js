import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import { runPackageCommand } from "./package-commands.js";
function createCaptureStream() {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  return { stream, getOutput: () => output };
}
function writePackage(root, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
}
function createTestDirs(prefix, t) {
  const root = mkdtempSync(join(tmpdir(), `pi-lifecycle-${prefix}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const extensionDir = join(root, `ext-${prefix}`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(extensionDir, { recursive: true });
  return { root, cwd, agentDir, extensionDir };
}
describe("runPackageCommand lifecycle hooks", () => {
  it("executes registered beforeInstall and afterInstall handlers for local packages", async (t) => {
    const { cwd, agentDir, extensionDir } = createTestDirs("install", t);
    writePackage(extensionDir, {
      "package.json": JSON.stringify({
        name: "ext-registered",
        type: "module",
        pi: { extensions: ["./index.js"] }
      }),
      "index.js": [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "export default function (pi) {",
        "  pi.registerBeforeInstall((ctx) => {",
        '    writeFileSync(join(ctx.installedPath, "before-install-ran.txt"), "ok", "utf-8");',
        "  });",
        "  pi.registerAfterInstall((ctx) => {",
        '    writeFileSync(join(ctx.installedPath, "after-install-ran.txt"), "ok", "utf-8");',
        "  });",
        "}"
      ].join("\n")
    });
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const result = await runPackageCommand({
      appName: "pi",
      args: ["install", extensionDir],
      cwd,
      agentDir,
      stdout: stdout.stream,
      stderr: stderr.stream
    });
    assert.equal(result.handled, true);
    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(join(extensionDir, "before-install-ran.txt"), "utf-8"), "ok");
    assert.equal(readFileSync(join(extensionDir, "after-install-ran.txt"), "utf-8"), "ok");
    assert.ok(stdout.getOutput().includes(`Installed ${extensionDir}`));
  });
  it("runs legacy named lifecycle hooks when no registered hooks exist", async (t) => {
    const { cwd, agentDir, extensionDir } = createTestDirs("legacy", t);
    writePackage(extensionDir, {
      "package.json": JSON.stringify({
        name: "ext-legacy",
        type: "module",
        pi: { extensions: ["./index.js"] }
      }),
      "index.js": [
        'import { writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "export default function () {}",
        "export async function beforeInstall(ctx) {",
        '  writeFileSync(join(ctx.installedPath, "legacy-before-install.txt"), "ok", "utf-8");',
        "}",
        "export async function afterInstall(ctx) {",
        '  writeFileSync(join(ctx.installedPath, "legacy-after-install.txt"), "ok", "utf-8");',
        "}",
        "export async function beforeRemove(ctx) {",
        '  writeFileSync(join(ctx.installedPath, "legacy-before-remove.txt"), "ok", "utf-8");',
        "}",
        "export async function afterRemove(ctx) {",
        '  writeFileSync(join(ctx.installedPath, "legacy-after-remove.txt"), "ok", "utf-8");',
        "}"
      ].join("\n")
    });
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const installResult = await runPackageCommand({
      appName: "pi",
      args: ["install", extensionDir],
      cwd,
      agentDir,
      stdout: stdout.stream,
      stderr: stderr.stream
    });
    assert.equal(installResult.handled, true);
    assert.equal(installResult.exitCode, 0);
    assert.equal(readFileSync(join(extensionDir, "legacy-before-install.txt"), "utf-8"), "ok");
    assert.equal(readFileSync(join(extensionDir, "legacy-after-install.txt"), "utf-8"), "ok");
    const removeResult = await runPackageCommand({
      appName: "pi",
      args: ["remove", extensionDir],
      cwd,
      agentDir,
      stdout: stdout.stream,
      stderr: stderr.stream
    });
    assert.equal(removeResult.handled, true);
    assert.equal(removeResult.exitCode, 0);
    assert.equal(readFileSync(join(extensionDir, "legacy-before-remove.txt"), "utf-8"), "ok");
    assert.equal(readFileSync(join(extensionDir, "legacy-after-remove.txt"), "utf-8"), "ok");
  });
  it("skips lifecycle phases with no hooks declared", async (t) => {
    const { cwd, agentDir, extensionDir } = createTestDirs("skip", t);
    writePackage(extensionDir, {
      "package.json": JSON.stringify({
        name: "ext-empty",
        type: "module",
        pi: { extensions: ["./index.js"] }
      }),
      "index.js": "export default function () {}"
    });
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const installResult = await runPackageCommand({
      appName: "pi",
      args: ["install", extensionDir],
      cwd,
      agentDir,
      stdout: stdout.stream,
      stderr: stderr.stream
    });
    assert.equal(installResult.handled, true);
    assert.equal(installResult.exitCode, 0);
    const removeResult = await runPackageCommand({
      appName: "pi",
      args: ["remove", extensionDir],
      cwd,
      agentDir,
      stdout: stdout.stream,
      stderr: stderr.stream
    });
    assert.equal(removeResult.handled, true);
    assert.equal(removeResult.exitCode, 0);
    assert.equal(stderr.getOutput().includes("Hook failed"), false);
  });
  it("fails install when manifest runtime dependency is missing", async (t) => {
    const { cwd, agentDir, extensionDir } = createTestDirs("deps", t);
    writePackage(extensionDir, {
      "package.json": JSON.stringify({
        name: "ext-runtime-deps",
        type: "module",
        pi: { extensions: ["./index.js"] }
      }),
      "index.js": "export default function () {}",
      "extension-manifest.json": JSON.stringify({
        id: "ext-runtime-deps",
        name: "Runtime Dep Test",
        version: "1.0.0",
        dependencies: { runtime: ["__definitely_missing_command_for_test__"] }
      })
    });
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    const result = await runPackageCommand({
      appName: "pi",
      args: ["install", extensionDir],
      cwd,
      agentDir,
      stdout: stdout.stream,
      stderr: stderr.stream
    });
    assert.equal(result.handled, true);
    assert.equal(result.exitCode, 1);
    assert.ok(stderr.getOutput().includes("Missing runtime dependencies"));
  });
  it("afterRemove hook receives installedPath even when directory is deleted", async (t) => {
    const { cwd, agentDir, extensionDir } = createTestDirs("after-remove", t);
    writePackage(extensionDir, {
      "package.json": JSON.stringify({
        name: "ext-after-remove",
        type: "module",
        pi: { extensions: ["./index.js"] }
      }),
      "index.js": [
        'import { writeFileSync, existsSync } from "node:fs";',
        'import { join } from "node:path";',
        "export default function () {}",
        "export async function afterRemove(ctx) {",
        '  const marker = join(ctx.cwd, "after-remove-marker.json");',
        "  writeFileSync(marker, JSON.stringify({",
        "    receivedPath: ctx.installedPath,",
        "    pathExisted: existsSync(ctx.installedPath),",
        '  }), "utf-8");',
        "}"
      ].join("\n")
    });
    const stdout = createCaptureStream();
    const stderr = createCaptureStream();
    await runPackageCommand({
      appName: "pi",
      args: ["install", extensionDir],
      cwd,
      agentDir,
      stdout: stdout.stream,
      stderr: stderr.stream
    });
    await runPackageCommand({
      appName: "pi",
      args: ["remove", extensionDir],
      cwd,
      agentDir,
      stdout: stdout.stream,
      stderr: stderr.stream
    });
    const markerPath = join(cwd, "after-remove-marker.json");
    assert.ok(existsSync(markerPath), "afterRemove hook must have executed and written marker");
    const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
    assert.equal(typeof marker.receivedPath, "string", "hook must receive installedPath as string");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3BhY2thZ2UtY29tbWFuZHMudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2R0ZW1wU3luYywgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IFdyaXRhYmxlIH0gZnJvbSBcIm5vZGU6c3RyZWFtXCI7XG5pbXBvcnQgeyBkZXNjcmliZSwgaXQgfSBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgeyBydW5QYWNrYWdlQ29tbWFuZCB9IGZyb20gXCIuL3BhY2thZ2UtY29tbWFuZHMuanNcIjtcblxuZnVuY3Rpb24gY3JlYXRlQ2FwdHVyZVN0cmVhbSgpIHtcblx0bGV0IG91dHB1dCA9IFwiXCI7XG5cdGNvbnN0IHN0cmVhbSA9IG5ldyBXcml0YWJsZSh7XG5cdFx0d3JpdGUoY2h1bmssIF9lbmNvZGluZywgY2FsbGJhY2spIHtcblx0XHRcdG91dHB1dCArPSBjaHVuay50b1N0cmluZygpO1xuXHRcdFx0Y2FsbGJhY2soKTtcblx0XHR9LFxuXHR9KSBhcyB1bmtub3duIGFzIE5vZGVKUy5Xcml0ZVN0cmVhbTtcblx0cmV0dXJuIHsgc3RyZWFtLCBnZXRPdXRwdXQ6ICgpID0+IG91dHB1dCB9O1xufVxuXG5mdW5jdGlvbiB3cml0ZVBhY2thZ2Uocm9vdDogc3RyaW5nLCBmaWxlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPik6IHZvaWQge1xuXHRmb3IgKGNvbnN0IFtyZWxQYXRoLCBjb250ZW50XSBvZiBPYmplY3QuZW50cmllcyhmaWxlcykpIHtcblx0XHRjb25zdCBhYnMgPSBqb2luKHJvb3QsIHJlbFBhdGgpO1xuXHRcdG1rZGlyU3luYyhqb2luKGFicywgXCIuLlwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdFx0d3JpdGVGaWxlU3luYyhhYnMsIGNvbnRlbnQsIFwidXRmLThcIik7XG5cdH1cbn1cblxuZnVuY3Rpb24gY3JlYXRlVGVzdERpcnMocHJlZml4OiBzdHJpbmcsIHQ6IHsgYWZ0ZXI6IChmbjogKCkgPT4gdm9pZCkgPT4gdm9pZCB9KSB7XG5cdGNvbnN0IHJvb3QgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBgcGktbGlmZWN5Y2xlLSR7cHJlZml4fS1gKSk7XG5cdHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cdGNvbnN0IGN3ZCA9IGpvaW4ocm9vdCwgXCJjd2RcIik7XG5cdGNvbnN0IGFnZW50RGlyID0gam9pbihyb290LCBcImFnZW50XCIpO1xuXHRjb25zdCBleHRlbnNpb25EaXIgPSBqb2luKHJvb3QsIGBleHQtJHtwcmVmaXh9YCk7XG5cdG1rZGlyU3luYyhjd2QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRta2RpclN5bmMoYWdlbnREaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRta2RpclN5bmMoZXh0ZW5zaW9uRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0cmV0dXJuIHsgcm9vdCwgY3dkLCBhZ2VudERpciwgZXh0ZW5zaW9uRGlyIH07XG59XG5cbmRlc2NyaWJlKFwicnVuUGFja2FnZUNvbW1hbmQgbGlmZWN5Y2xlIGhvb2tzXCIsICgpID0+IHtcblx0aXQoXCJleGVjdXRlcyByZWdpc3RlcmVkIGJlZm9yZUluc3RhbGwgYW5kIGFmdGVySW5zdGFsbCBoYW5kbGVycyBmb3IgbG9jYWwgcGFja2FnZXNcIiwgYXN5bmMgKHQpID0+IHtcblx0XHRjb25zdCB7IGN3ZCwgYWdlbnREaXIsIGV4dGVuc2lvbkRpciB9ID0gY3JlYXRlVGVzdERpcnMoXCJpbnN0YWxsXCIsIHQpO1xuXG5cdFx0d3JpdGVQYWNrYWdlKGV4dGVuc2lvbkRpciwge1xuXHRcdFx0XCJwYWNrYWdlLmpzb25cIjogSlNPTi5zdHJpbmdpZnkoe1xuXHRcdFx0XHRuYW1lOiBcImV4dC1yZWdpc3RlcmVkXCIsXG5cdFx0XHRcdHR5cGU6IFwibW9kdWxlXCIsXG5cdFx0XHRcdHBpOiB7IGV4dGVuc2lvbnM6IFtcIi4vaW5kZXguanNcIl0gfSxcblx0XHRcdH0pLFxuXHRcdFx0XCJpbmRleC5qc1wiOiBbXG5cdFx0XHRcdCdpbXBvcnQgeyB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjsnLFxuXHRcdFx0XHQnaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjsnLFxuXHRcdFx0XHRcImV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIChwaSkge1wiLFxuXHRcdFx0XHRcIiAgcGkucmVnaXN0ZXJCZWZvcmVJbnN0YWxsKChjdHgpID0+IHtcIixcblx0XHRcdFx0JyAgICB3cml0ZUZpbGVTeW5jKGpvaW4oY3R4Lmluc3RhbGxlZFBhdGgsIFwiYmVmb3JlLWluc3RhbGwtcmFuLnR4dFwiKSwgXCJva1wiLCBcInV0Zi04XCIpOycsXG5cdFx0XHRcdFwiICB9KTtcIixcblx0XHRcdFx0XCIgIHBpLnJlZ2lzdGVyQWZ0ZXJJbnN0YWxsKChjdHgpID0+IHtcIixcblx0XHRcdFx0JyAgICB3cml0ZUZpbGVTeW5jKGpvaW4oY3R4Lmluc3RhbGxlZFBhdGgsIFwiYWZ0ZXItaW5zdGFsbC1yYW4udHh0XCIpLCBcIm9rXCIsIFwidXRmLThcIik7Jyxcblx0XHRcdFx0XCIgIH0pO1wiLFxuXHRcdFx0XHRcIn1cIixcblx0XHRcdF0uam9pbihcIlxcblwiKSxcblx0XHR9KTtcblxuXHRcdGNvbnN0IHN0ZG91dCA9IGNyZWF0ZUNhcHR1cmVTdHJlYW0oKTtcblx0XHRjb25zdCBzdGRlcnIgPSBjcmVhdGVDYXB0dXJlU3RyZWFtKCk7XG5cdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUGFja2FnZUNvbW1hbmQoe1xuXHRcdFx0YXBwTmFtZTogXCJwaVwiLFxuXHRcdFx0YXJnczogW1wiaW5zdGFsbFwiLCBleHRlbnNpb25EaXJdLFxuXHRcdFx0Y3dkLFxuXHRcdFx0YWdlbnREaXIsXG5cdFx0XHRzdGRvdXQ6IHN0ZG91dC5zdHJlYW0sXG5cdFx0XHRzdGRlcnI6IHN0ZGVyci5zdHJlYW0sXG5cdFx0fSk7XG5cblx0XHRhc3NlcnQuZXF1YWwocmVzdWx0LmhhbmRsZWQsIHRydWUpO1xuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuZXhpdENvZGUsIDApO1xuXHRcdGFzc2VydC5lcXVhbChyZWFkRmlsZVN5bmMoam9pbihleHRlbnNpb25EaXIsIFwiYmVmb3JlLWluc3RhbGwtcmFuLnR4dFwiKSwgXCJ1dGYtOFwiKSwgXCJva1wiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVhZEZpbGVTeW5jKGpvaW4oZXh0ZW5zaW9uRGlyLCBcImFmdGVyLWluc3RhbGwtcmFuLnR4dFwiKSwgXCJ1dGYtOFwiKSwgXCJva1wiKTtcblx0XHRhc3NlcnQub2soc3Rkb3V0LmdldE91dHB1dCgpLmluY2x1ZGVzKGBJbnN0YWxsZWQgJHtleHRlbnNpb25EaXJ9YCkpO1xuXHR9KTtcblxuXHRpdChcInJ1bnMgbGVnYWN5IG5hbWVkIGxpZmVjeWNsZSBob29rcyB3aGVuIG5vIHJlZ2lzdGVyZWQgaG9va3MgZXhpc3RcIiwgYXN5bmMgKHQpID0+IHtcblx0XHRjb25zdCB7IGN3ZCwgYWdlbnREaXIsIGV4dGVuc2lvbkRpciB9ID0gY3JlYXRlVGVzdERpcnMoXCJsZWdhY3lcIiwgdCk7XG5cblx0XHR3cml0ZVBhY2thZ2UoZXh0ZW5zaW9uRGlyLCB7XG5cdFx0XHRcInBhY2thZ2UuanNvblwiOiBKU09OLnN0cmluZ2lmeSh7XG5cdFx0XHRcdG5hbWU6IFwiZXh0LWxlZ2FjeVwiLFxuXHRcdFx0XHR0eXBlOiBcIm1vZHVsZVwiLFxuXHRcdFx0XHRwaTogeyBleHRlbnNpb25zOiBbXCIuL2luZGV4LmpzXCJdIH0sXG5cdFx0XHR9KSxcblx0XHRcdFwiaW5kZXguanNcIjogW1xuXHRcdFx0XHQnaW1wb3J0IHsgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7Jyxcblx0XHRcdFx0J2ltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7Jyxcblx0XHRcdFx0XCJleHBvcnQgZGVmYXVsdCBmdW5jdGlvbiAoKSB7fVwiLFxuXHRcdFx0XHRcImV4cG9ydCBhc3luYyBmdW5jdGlvbiBiZWZvcmVJbnN0YWxsKGN0eCkge1wiLFxuXHRcdFx0XHQnICB3cml0ZUZpbGVTeW5jKGpvaW4oY3R4Lmluc3RhbGxlZFBhdGgsIFwibGVnYWN5LWJlZm9yZS1pbnN0YWxsLnR4dFwiKSwgXCJva1wiLCBcInV0Zi04XCIpOycsXG5cdFx0XHRcdFwifVwiLFxuXHRcdFx0XHRcImV4cG9ydCBhc3luYyBmdW5jdGlvbiBhZnRlckluc3RhbGwoY3R4KSB7XCIsXG5cdFx0XHRcdCcgIHdyaXRlRmlsZVN5bmMoam9pbihjdHguaW5zdGFsbGVkUGF0aCwgXCJsZWdhY3ktYWZ0ZXItaW5zdGFsbC50eHRcIiksIFwib2tcIiwgXCJ1dGYtOFwiKTsnLFxuXHRcdFx0XHRcIn1cIixcblx0XHRcdFx0XCJleHBvcnQgYXN5bmMgZnVuY3Rpb24gYmVmb3JlUmVtb3ZlKGN0eCkge1wiLFxuXHRcdFx0XHQnICB3cml0ZUZpbGVTeW5jKGpvaW4oY3R4Lmluc3RhbGxlZFBhdGgsIFwibGVnYWN5LWJlZm9yZS1yZW1vdmUudHh0XCIpLCBcIm9rXCIsIFwidXRmLThcIik7Jyxcblx0XHRcdFx0XCJ9XCIsXG5cdFx0XHRcdFwiZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFmdGVyUmVtb3ZlKGN0eCkge1wiLFxuXHRcdFx0XHQnICB3cml0ZUZpbGVTeW5jKGpvaW4oY3R4Lmluc3RhbGxlZFBhdGgsIFwibGVnYWN5LWFmdGVyLXJlbW92ZS50eHRcIiksIFwib2tcIiwgXCJ1dGYtOFwiKTsnLFxuXHRcdFx0XHRcIn1cIixcblx0XHRcdF0uam9pbihcIlxcblwiKSxcblx0XHR9KTtcblxuXHRcdGNvbnN0IHN0ZG91dCA9IGNyZWF0ZUNhcHR1cmVTdHJlYW0oKTtcblx0XHRjb25zdCBzdGRlcnIgPSBjcmVhdGVDYXB0dXJlU3RyZWFtKCk7XG5cdFx0Y29uc3QgaW5zdGFsbFJlc3VsdCA9IGF3YWl0IHJ1blBhY2thZ2VDb21tYW5kKHtcblx0XHRcdGFwcE5hbWU6IFwicGlcIixcblx0XHRcdGFyZ3M6IFtcImluc3RhbGxcIiwgZXh0ZW5zaW9uRGlyXSxcblx0XHRcdGN3ZCxcblx0XHRcdGFnZW50RGlyLFxuXHRcdFx0c3Rkb3V0OiBzdGRvdXQuc3RyZWFtLFxuXHRcdFx0c3RkZXJyOiBzdGRlcnIuc3RyZWFtLFxuXHRcdH0pO1xuXG5cdFx0YXNzZXJ0LmVxdWFsKGluc3RhbGxSZXN1bHQuaGFuZGxlZCwgdHJ1ZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKGluc3RhbGxSZXN1bHQuZXhpdENvZGUsIDApO1xuXHRcdGFzc2VydC5lcXVhbChyZWFkRmlsZVN5bmMoam9pbihleHRlbnNpb25EaXIsIFwibGVnYWN5LWJlZm9yZS1pbnN0YWxsLnR4dFwiKSwgXCJ1dGYtOFwiKSwgXCJva1wiKTtcblx0XHRhc3NlcnQuZXF1YWwocmVhZEZpbGVTeW5jKGpvaW4oZXh0ZW5zaW9uRGlyLCBcImxlZ2FjeS1hZnRlci1pbnN0YWxsLnR4dFwiKSwgXCJ1dGYtOFwiKSwgXCJva1wiKTtcblxuXHRcdGNvbnN0IHJlbW92ZVJlc3VsdCA9IGF3YWl0IHJ1blBhY2thZ2VDb21tYW5kKHtcblx0XHRcdGFwcE5hbWU6IFwicGlcIixcblx0XHRcdGFyZ3M6IFtcInJlbW92ZVwiLCBleHRlbnNpb25EaXJdLFxuXHRcdFx0Y3dkLFxuXHRcdFx0YWdlbnREaXIsXG5cdFx0XHRzdGRvdXQ6IHN0ZG91dC5zdHJlYW0sXG5cdFx0XHRzdGRlcnI6IHN0ZGVyci5zdHJlYW0sXG5cdFx0fSk7XG5cblx0XHRhc3NlcnQuZXF1YWwocmVtb3ZlUmVzdWx0LmhhbmRsZWQsIHRydWUpO1xuXHRcdGFzc2VydC5lcXVhbChyZW1vdmVSZXN1bHQuZXhpdENvZGUsIDApO1xuXHRcdGFzc2VydC5lcXVhbChyZWFkRmlsZVN5bmMoam9pbihleHRlbnNpb25EaXIsIFwibGVnYWN5LWJlZm9yZS1yZW1vdmUudHh0XCIpLCBcInV0Zi04XCIpLCBcIm9rXCIpO1xuXHRcdGFzc2VydC5lcXVhbChyZWFkRmlsZVN5bmMoam9pbihleHRlbnNpb25EaXIsIFwibGVnYWN5LWFmdGVyLXJlbW92ZS50eHRcIiksIFwidXRmLThcIiksIFwib2tcIik7XG5cdH0pO1xuXG5cdGl0KFwic2tpcHMgbGlmZWN5Y2xlIHBoYXNlcyB3aXRoIG5vIGhvb2tzIGRlY2xhcmVkXCIsIGFzeW5jICh0KSA9PiB7XG5cdFx0Y29uc3QgeyBjd2QsIGFnZW50RGlyLCBleHRlbnNpb25EaXIgfSA9IGNyZWF0ZVRlc3REaXJzKFwic2tpcFwiLCB0KTtcblxuXHRcdHdyaXRlUGFja2FnZShleHRlbnNpb25EaXIsIHtcblx0XHRcdFwicGFja2FnZS5qc29uXCI6IEpTT04uc3RyaW5naWZ5KHtcblx0XHRcdFx0bmFtZTogXCJleHQtZW1wdHlcIixcblx0XHRcdFx0dHlwZTogXCJtb2R1bGVcIixcblx0XHRcdFx0cGk6IHsgZXh0ZW5zaW9uczogW1wiLi9pbmRleC5qc1wiXSB9LFxuXHRcdFx0fSksXG5cdFx0XHRcImluZGV4LmpzXCI6IFwiZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gKCkge31cIixcblx0XHR9KTtcblxuXHRcdGNvbnN0IHN0ZG91dCA9IGNyZWF0ZUNhcHR1cmVTdHJlYW0oKTtcblx0XHRjb25zdCBzdGRlcnIgPSBjcmVhdGVDYXB0dXJlU3RyZWFtKCk7XG5cdFx0Y29uc3QgaW5zdGFsbFJlc3VsdCA9IGF3YWl0IHJ1blBhY2thZ2VDb21tYW5kKHtcblx0XHRcdGFwcE5hbWU6IFwicGlcIixcblx0XHRcdGFyZ3M6IFtcImluc3RhbGxcIiwgZXh0ZW5zaW9uRGlyXSxcblx0XHRcdGN3ZCxcblx0XHRcdGFnZW50RGlyLFxuXHRcdFx0c3Rkb3V0OiBzdGRvdXQuc3RyZWFtLFxuXHRcdFx0c3RkZXJyOiBzdGRlcnIuc3RyZWFtLFxuXHRcdH0pO1xuXHRcdGFzc2VydC5lcXVhbChpbnN0YWxsUmVzdWx0LmhhbmRsZWQsIHRydWUpO1xuXHRcdGFzc2VydC5lcXVhbChpbnN0YWxsUmVzdWx0LmV4aXRDb2RlLCAwKTtcblxuXHRcdGNvbnN0IHJlbW92ZVJlc3VsdCA9IGF3YWl0IHJ1blBhY2thZ2VDb21tYW5kKHtcblx0XHRcdGFwcE5hbWU6IFwicGlcIixcblx0XHRcdGFyZ3M6IFtcInJlbW92ZVwiLCBleHRlbnNpb25EaXJdLFxuXHRcdFx0Y3dkLFxuXHRcdFx0YWdlbnREaXIsXG5cdFx0XHRzdGRvdXQ6IHN0ZG91dC5zdHJlYW0sXG5cdFx0XHRzdGRlcnI6IHN0ZGVyci5zdHJlYW0sXG5cdFx0fSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlbW92ZVJlc3VsdC5oYW5kbGVkLCB0cnVlKTtcblx0XHRhc3NlcnQuZXF1YWwocmVtb3ZlUmVzdWx0LmV4aXRDb2RlLCAwKTtcblx0XHRhc3NlcnQuZXF1YWwoc3RkZXJyLmdldE91dHB1dCgpLmluY2x1ZGVzKFwiSG9vayBmYWlsZWRcIiksIGZhbHNlKTtcblx0fSk7XG5cblx0aXQoXCJmYWlscyBpbnN0YWxsIHdoZW4gbWFuaWZlc3QgcnVudGltZSBkZXBlbmRlbmN5IGlzIG1pc3NpbmdcIiwgYXN5bmMgKHQpID0+IHtcblx0XHRjb25zdCB7IGN3ZCwgYWdlbnREaXIsIGV4dGVuc2lvbkRpciB9ID0gY3JlYXRlVGVzdERpcnMoXCJkZXBzXCIsIHQpO1xuXG5cdFx0d3JpdGVQYWNrYWdlKGV4dGVuc2lvbkRpciwge1xuXHRcdFx0XCJwYWNrYWdlLmpzb25cIjogSlNPTi5zdHJpbmdpZnkoe1xuXHRcdFx0XHRuYW1lOiBcImV4dC1ydW50aW1lLWRlcHNcIixcblx0XHRcdFx0dHlwZTogXCJtb2R1bGVcIixcblx0XHRcdFx0cGk6IHsgZXh0ZW5zaW9uczogW1wiLi9pbmRleC5qc1wiXSB9LFxuXHRcdFx0fSksXG5cdFx0XHRcImluZGV4LmpzXCI6IFwiZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gKCkge31cIixcblx0XHRcdFwiZXh0ZW5zaW9uLW1hbmlmZXN0Lmpzb25cIjogSlNPTi5zdHJpbmdpZnkoe1xuXHRcdFx0XHRpZDogXCJleHQtcnVudGltZS1kZXBzXCIsXG5cdFx0XHRcdG5hbWU6IFwiUnVudGltZSBEZXAgVGVzdFwiLFxuXHRcdFx0XHR2ZXJzaW9uOiBcIjEuMC4wXCIsXG5cdFx0XHRcdGRlcGVuZGVuY2llczogeyBydW50aW1lOiBbXCJfX2RlZmluaXRlbHlfbWlzc2luZ19jb21tYW5kX2Zvcl90ZXN0X19cIl0gfSxcblx0XHRcdH0pLFxuXHRcdH0pO1xuXG5cdFx0Y29uc3Qgc3Rkb3V0ID0gY3JlYXRlQ2FwdHVyZVN0cmVhbSgpO1xuXHRcdGNvbnN0IHN0ZGVyciA9IGNyZWF0ZUNhcHR1cmVTdHJlYW0oKTtcblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QYWNrYWdlQ29tbWFuZCh7XG5cdFx0XHRhcHBOYW1lOiBcInBpXCIsXG5cdFx0XHRhcmdzOiBbXCJpbnN0YWxsXCIsIGV4dGVuc2lvbkRpcl0sXG5cdFx0XHRjd2QsXG5cdFx0XHRhZ2VudERpcixcblx0XHRcdHN0ZG91dDogc3Rkb3V0LnN0cmVhbSxcblx0XHRcdHN0ZGVycjogc3RkZXJyLnN0cmVhbSxcblx0XHR9KTtcblxuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQuaGFuZGxlZCwgdHJ1ZSk7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5leGl0Q29kZSwgMSk7XG5cdFx0YXNzZXJ0Lm9rKHN0ZGVyci5nZXRPdXRwdXQoKS5pbmNsdWRlcyhcIk1pc3NpbmcgcnVudGltZSBkZXBlbmRlbmNpZXNcIikpO1xuXHR9KTtcblxuXHRpdChcImFmdGVyUmVtb3ZlIGhvb2sgcmVjZWl2ZXMgaW5zdGFsbGVkUGF0aCBldmVuIHdoZW4gZGlyZWN0b3J5IGlzIGRlbGV0ZWRcIiwgYXN5bmMgKHQpID0+IHtcblx0XHRjb25zdCB7IGN3ZCwgYWdlbnREaXIsIGV4dGVuc2lvbkRpciB9ID0gY3JlYXRlVGVzdERpcnMoXCJhZnRlci1yZW1vdmVcIiwgdCk7XG5cblx0XHR3cml0ZVBhY2thZ2UoZXh0ZW5zaW9uRGlyLCB7XG5cdFx0XHRcInBhY2thZ2UuanNvblwiOiBKU09OLnN0cmluZ2lmeSh7XG5cdFx0XHRcdG5hbWU6IFwiZXh0LWFmdGVyLXJlbW92ZVwiLFxuXHRcdFx0XHR0eXBlOiBcIm1vZHVsZVwiLFxuXHRcdFx0XHRwaTogeyBleHRlbnNpb25zOiBbXCIuL2luZGV4LmpzXCJdIH0sXG5cdFx0XHR9KSxcblx0XHRcdFwiaW5kZXguanNcIjogW1xuXHRcdFx0XHQnaW1wb3J0IHsgd3JpdGVGaWxlU3luYywgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7Jyxcblx0XHRcdFx0J2ltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7Jyxcblx0XHRcdFx0XCJleHBvcnQgZGVmYXVsdCBmdW5jdGlvbiAoKSB7fVwiLFxuXHRcdFx0XHRcImV4cG9ydCBhc3luYyBmdW5jdGlvbiBhZnRlclJlbW92ZShjdHgpIHtcIixcblx0XHRcdFx0JyAgY29uc3QgbWFya2VyID0gam9pbihjdHguY3dkLCBcImFmdGVyLXJlbW92ZS1tYXJrZXIuanNvblwiKTsnLFxuXHRcdFx0XHRcIiAgd3JpdGVGaWxlU3luYyhtYXJrZXIsIEpTT04uc3RyaW5naWZ5KHtcIixcblx0XHRcdFx0XCIgICAgcmVjZWl2ZWRQYXRoOiBjdHguaW5zdGFsbGVkUGF0aCxcIixcblx0XHRcdFx0XCIgICAgcGF0aEV4aXN0ZWQ6IGV4aXN0c1N5bmMoY3R4Lmluc3RhbGxlZFBhdGgpLFwiLFxuXHRcdFx0XHQnICB9KSwgXCJ1dGYtOFwiKTsnLFxuXHRcdFx0XHRcIn1cIixcblx0XHRcdF0uam9pbihcIlxcblwiKSxcblx0XHR9KTtcblxuXHRcdGNvbnN0IHN0ZG91dCA9IGNyZWF0ZUNhcHR1cmVTdHJlYW0oKTtcblx0XHRjb25zdCBzdGRlcnIgPSBjcmVhdGVDYXB0dXJlU3RyZWFtKCk7XG5cblx0XHRhd2FpdCBydW5QYWNrYWdlQ29tbWFuZCh7XG5cdFx0XHRhcHBOYW1lOiBcInBpXCIsXG5cdFx0XHRhcmdzOiBbXCJpbnN0YWxsXCIsIGV4dGVuc2lvbkRpcl0sXG5cdFx0XHRjd2QsXG5cdFx0XHRhZ2VudERpcixcblx0XHRcdHN0ZG91dDogc3Rkb3V0LnN0cmVhbSxcblx0XHRcdHN0ZGVycjogc3RkZXJyLnN0cmVhbSxcblx0XHR9KTtcblxuXHRcdGF3YWl0IHJ1blBhY2thZ2VDb21tYW5kKHtcblx0XHRcdGFwcE5hbWU6IFwicGlcIixcblx0XHRcdGFyZ3M6IFtcInJlbW92ZVwiLCBleHRlbnNpb25EaXJdLFxuXHRcdFx0Y3dkLFxuXHRcdFx0YWdlbnREaXIsXG5cdFx0XHRzdGRvdXQ6IHN0ZG91dC5zdHJlYW0sXG5cdFx0XHRzdGRlcnI6IHN0ZGVyci5zdHJlYW0sXG5cdFx0fSk7XG5cblx0XHRjb25zdCBtYXJrZXJQYXRoID0gam9pbihjd2QsIFwiYWZ0ZXItcmVtb3ZlLW1hcmtlci5qc29uXCIpO1xuXHRcdGFzc2VydC5vayhleGlzdHNTeW5jKG1hcmtlclBhdGgpLCBcImFmdGVyUmVtb3ZlIGhvb2sgbXVzdCBoYXZlIGV4ZWN1dGVkIGFuZCB3cml0dGVuIG1hcmtlclwiKTtcblx0XHRjb25zdCBtYXJrZXIgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhtYXJrZXJQYXRoLCBcInV0Zi04XCIpKTtcblx0XHRhc3NlcnQuZXF1YWwodHlwZW9mIG1hcmtlci5yZWNlaXZlZFBhdGgsIFwic3RyaW5nXCIsIFwiaG9vayBtdXN0IHJlY2VpdmUgaW5zdGFsbGVkUGF0aCBhcyBzdHJpbmdcIik7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFlBQVk7QUFDbkIsU0FBUyxZQUFZLGFBQWEsV0FBVyxjQUFjLFFBQVEscUJBQXFCO0FBQ3hGLFNBQVMsY0FBYztBQUN2QixTQUFTLFlBQVk7QUFDckIsU0FBUyxn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
