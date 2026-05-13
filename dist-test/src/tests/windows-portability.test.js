import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveLocalBinaryPath } from "../../packages/pi-coding-agent/src/core/lsp/config.js";
import { encodeCwd } from "../resources/extensions/subagent/isolation.js";
import { buildGsdClientSpawnPlan } from "../../vscode-extension/src/gsd-client-spawn.js";
function makeTempDir(prefix) {
  const dir = path.join(
    os.tmpdir(),
    `gsd-windows-portability-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}
test("resolveLocalBinaryPath finds Windows npm shims", () => {
  const dir = makeTempDir("lsp-shim");
  try {
    writeFileSync(path.join(dir, "package.json"), "{}");
    mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
    const shimPath = path.join(dir, "node_modules", ".bin", "tsc.cmd");
    writeFileSync(shimPath, "@echo off\r\n");
    const resolved = resolveLocalBinaryPath("tsc", dir, true);
    assert.equal(resolved, shimPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("resolveLocalBinaryPath finds Windows venv Scripts executables", () => {
  const dir = makeTempDir("lsp-scripts");
  try {
    writeFileSync(path.join(dir, "pyproject.toml"), "");
    mkdirSync(path.join(dir, "venv", "Scripts"), { recursive: true });
    const exePath = path.join(dir, "venv", "Scripts", "python.exe");
    writeFileSync(exePath, "");
    const resolved = resolveLocalBinaryPath("python", dir, true);
    assert.equal(resolved, exePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("encodeCwd produces a filesystem-safe token for Windows paths", () => {
  const encoded = encodeCwd("C:\\Users\\Alice\\repo");
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.ok(!encoded.includes(":"));
  assert.ok(!encoded.includes("\\"));
  assert.ok(!encoded.includes("/"));
});
test("VS Code RPC launch plan uses shell mode for Windows command shims", () => {
  const plan = buildGsdClientSpawnPlan("gsd.cmd", "C:\\repo", { PATH: "C:\\Windows\\System32" }, "win32");
  assert.equal(plan.command, "gsd.cmd");
  assert.deepEqual(plan.args, ["--mode", "rpc"]);
  assert.equal(plan.options.cwd, "C:\\repo");
  assert.equal(plan.options.shell, true);
  assert.equal(plan.options.env.PATH, "C:\\Windows\\System32");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL3dpbmRvd3MtcG9ydGFiaWxpdHkudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgKiBhcyBvcyBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyByZXNvbHZlTG9jYWxCaW5hcnlQYXRoIH0gZnJvbSBcIi4uLy4uL3BhY2thZ2VzL3BpLWNvZGluZy1hZ2VudC9zcmMvY29yZS9sc3AvY29uZmlnLnRzXCI7XG5pbXBvcnQgeyBlbmNvZGVDd2QgfSBmcm9tIFwiLi4vcmVzb3VyY2VzL2V4dGVuc2lvbnMvc3ViYWdlbnQvaXNvbGF0aW9uLnRzXCI7XG5pbXBvcnQgeyBidWlsZEdzZENsaWVudFNwYXduUGxhbiB9IGZyb20gXCIuLi8uLi92c2NvZGUtZXh0ZW5zaW9uL3NyYy9nc2QtY2xpZW50LXNwYXduLnRzXCI7XG5cbmZ1bmN0aW9uIG1ha2VUZW1wRGlyKHByZWZpeDogc3RyaW5nKTogc3RyaW5nIHtcblx0Y29uc3QgZGlyID0gcGF0aC5qb2luKFxuXHRcdG9zLnRtcGRpcigpLFxuXHRcdGBnc2Qtd2luZG93cy1wb3J0YWJpbGl0eS0ke3ByZWZpeH0tJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWAsXG5cdCk7XG5cdG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRyZXR1cm4gZGlyO1xufVxuXG50ZXN0KFwicmVzb2x2ZUxvY2FsQmluYXJ5UGF0aCBmaW5kcyBXaW5kb3dzIG5wbSBzaGltc1wiLCAoKSA9PiB7XG5cdGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwibHNwLXNoaW1cIik7XG5cdHRyeSB7XG5cdFx0d3JpdGVGaWxlU3luYyhwYXRoLmpvaW4oZGlyLCBcInBhY2thZ2UuanNvblwiKSwgXCJ7fVwiKTtcblx0XHRta2RpclN5bmMocGF0aC5qb2luKGRpciwgXCJub2RlX21vZHVsZXNcIiwgXCIuYmluXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHRjb25zdCBzaGltUGF0aCA9IHBhdGguam9pbihkaXIsIFwibm9kZV9tb2R1bGVzXCIsIFwiLmJpblwiLCBcInRzYy5jbWRcIik7XG5cdFx0d3JpdGVGaWxlU3luYyhzaGltUGF0aCwgXCJAZWNobyBvZmZcXHJcXG5cIik7XG5cblx0XHRjb25zdCByZXNvbHZlZCA9IHJlc29sdmVMb2NhbEJpbmFyeVBhdGgoXCJ0c2NcIiwgZGlyLCB0cnVlKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzb2x2ZWQsIHNoaW1QYXRoKTtcblx0fSBmaW5hbGx5IHtcblx0XHRybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cdH1cbn0pO1xuXG50ZXN0KFwicmVzb2x2ZUxvY2FsQmluYXJ5UGF0aCBmaW5kcyBXaW5kb3dzIHZlbnYgU2NyaXB0cyBleGVjdXRhYmxlc1wiLCAoKSA9PiB7XG5cdGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwibHNwLXNjcmlwdHNcIik7XG5cdHRyeSB7XG5cdFx0d3JpdGVGaWxlU3luYyhwYXRoLmpvaW4oZGlyLCBcInB5cHJvamVjdC50b21sXCIpLCBcIlwiKTtcblx0XHRta2RpclN5bmMocGF0aC5qb2luKGRpciwgXCJ2ZW52XCIsIFwiU2NyaXB0c1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdFx0Y29uc3QgZXhlUGF0aCA9IHBhdGguam9pbihkaXIsIFwidmVudlwiLCBcIlNjcmlwdHNcIiwgXCJweXRob24uZXhlXCIpO1xuXHRcdHdyaXRlRmlsZVN5bmMoZXhlUGF0aCwgXCJcIik7XG5cblx0XHRjb25zdCByZXNvbHZlZCA9IHJlc29sdmVMb2NhbEJpbmFyeVBhdGgoXCJweXRob25cIiwgZGlyLCB0cnVlKTtcblx0XHRhc3NlcnQuZXF1YWwocmVzb2x2ZWQsIGV4ZVBhdGgpO1xuXHR9IGZpbmFsbHkge1xuXHRcdHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0fVxufSk7XG5cbnRlc3QoXCJlbmNvZGVDd2QgcHJvZHVjZXMgYSBmaWxlc3lzdGVtLXNhZmUgdG9rZW4gZm9yIFdpbmRvd3MgcGF0aHNcIiwgKCkgPT4ge1xuXHRjb25zdCBlbmNvZGVkID0gZW5jb2RlQ3dkKFwiQzpcXFxcVXNlcnNcXFxcQWxpY2VcXFxccmVwb1wiKTtcblx0YXNzZXJ0Lm1hdGNoKGVuY29kZWQsIC9eW0EtWmEtejAtOV8tXSskLyk7XG5cdGFzc2VydC5vayghZW5jb2RlZC5pbmNsdWRlcyhcIjpcIikpO1xuXHRhc3NlcnQub2soIWVuY29kZWQuaW5jbHVkZXMoXCJcXFxcXCIpKTtcblx0YXNzZXJ0Lm9rKCFlbmNvZGVkLmluY2x1ZGVzKFwiL1wiKSk7XG59KTtcblxudGVzdChcIlZTIENvZGUgUlBDIGxhdW5jaCBwbGFuIHVzZXMgc2hlbGwgbW9kZSBmb3IgV2luZG93cyBjb21tYW5kIHNoaW1zXCIsICgpID0+IHtcblx0Y29uc3QgcGxhbiA9IGJ1aWxkR3NkQ2xpZW50U3Bhd25QbGFuKFwiZ3NkLmNtZFwiLCBcIkM6XFxcXHJlcG9cIiwgeyBQQVRIOiBcIkM6XFxcXFdpbmRvd3NcXFxcU3lzdGVtMzJcIiB9LCBcIndpbjMyXCIpO1xuXHRhc3NlcnQuZXF1YWwocGxhbi5jb21tYW5kLCBcImdzZC5jbWRcIik7XG5cdGFzc2VydC5kZWVwRXF1YWwocGxhbi5hcmdzLCBbXCItLW1vZGVcIiwgXCJycGNcIl0pO1xuXHRhc3NlcnQuZXF1YWwocGxhbi5vcHRpb25zLmN3ZCwgXCJDOlxcXFxyZXBvXCIpO1xuXHRhc3NlcnQuZXF1YWwocGxhbi5vcHRpb25zLnNoZWxsLCB0cnVlKTtcblx0YXNzZXJ0LmVxdWFsKHBsYW4ub3B0aW9ucy5lbnYuUEFUSCwgXCJDOlxcXFxXaW5kb3dzXFxcXFN5c3RlbTMyXCIpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxRQUFRLHFCQUFxQjtBQUNqRCxZQUFZLFFBQVE7QUFDcEIsWUFBWSxVQUFVO0FBQ3RCLFNBQVMsOEJBQThCO0FBQ3ZDLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsK0JBQStCO0FBRXhDLFNBQVMsWUFBWSxRQUF3QjtBQUM1QyxRQUFNLE1BQU0sS0FBSztBQUFBLElBQ2hCLEdBQUcsT0FBTztBQUFBLElBQ1YsMkJBQTJCLE1BQU0sSUFBSSxLQUFLLElBQUksQ0FBQyxJQUFJLEtBQUssT0FBTyxFQUFFLFNBQVMsRUFBRSxFQUFFLE1BQU0sR0FBRyxDQUFDLENBQUM7QUFBQSxFQUMxRjtBQUNBLFlBQVUsS0FBSyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2xDLFNBQU87QUFDUjtBQUVBLEtBQUssa0RBQWtELE1BQU07QUFDNUQsUUFBTSxNQUFNLFlBQVksVUFBVTtBQUNsQyxNQUFJO0FBQ0gsa0JBQWMsS0FBSyxLQUFLLEtBQUssY0FBYyxHQUFHLElBQUk7QUFDbEQsY0FBVSxLQUFLLEtBQUssS0FBSyxnQkFBZ0IsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDckUsVUFBTSxXQUFXLEtBQUssS0FBSyxLQUFLLGdCQUFnQixRQUFRLFNBQVM7QUFDakUsa0JBQWMsVUFBVSxlQUFlO0FBRXZDLFVBQU0sV0FBVyx1QkFBdUIsT0FBTyxLQUFLLElBQUk7QUFDeEQsV0FBTyxNQUFNLFVBQVUsUUFBUTtBQUFBLEVBQ2hDLFVBQUU7QUFDRCxXQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUM3QztBQUNELENBQUM7QUFFRCxLQUFLLGlFQUFpRSxNQUFNO0FBQzNFLFFBQU0sTUFBTSxZQUFZLGFBQWE7QUFDckMsTUFBSTtBQUNILGtCQUFjLEtBQUssS0FBSyxLQUFLLGdCQUFnQixHQUFHLEVBQUU7QUFDbEQsY0FBVSxLQUFLLEtBQUssS0FBSyxRQUFRLFNBQVMsR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ2hFLFVBQU0sVUFBVSxLQUFLLEtBQUssS0FBSyxRQUFRLFdBQVcsWUFBWTtBQUM5RCxrQkFBYyxTQUFTLEVBQUU7QUFFekIsVUFBTSxXQUFXLHVCQUF1QixVQUFVLEtBQUssSUFBSTtBQUMzRCxXQUFPLE1BQU0sVUFBVSxPQUFPO0FBQUEsRUFDL0IsVUFBRTtBQUNELFdBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQzdDO0FBQ0QsQ0FBQztBQUVELEtBQUssZ0VBQWdFLE1BQU07QUFDMUUsUUFBTSxVQUFVLFVBQVUsd0JBQXdCO0FBQ2xELFNBQU8sTUFBTSxTQUFTLGtCQUFrQjtBQUN4QyxTQUFPLEdBQUcsQ0FBQyxRQUFRLFNBQVMsR0FBRyxDQUFDO0FBQ2hDLFNBQU8sR0FBRyxDQUFDLFFBQVEsU0FBUyxJQUFJLENBQUM7QUFDakMsU0FBTyxHQUFHLENBQUMsUUFBUSxTQUFTLEdBQUcsQ0FBQztBQUNqQyxDQUFDO0FBRUQsS0FBSyxxRUFBcUUsTUFBTTtBQUMvRSxRQUFNLE9BQU8sd0JBQXdCLFdBQVcsWUFBWSxFQUFFLE1BQU0sd0JBQXdCLEdBQUcsT0FBTztBQUN0RyxTQUFPLE1BQU0sS0FBSyxTQUFTLFNBQVM7QUFDcEMsU0FBTyxVQUFVLEtBQUssTUFBTSxDQUFDLFVBQVUsS0FBSyxDQUFDO0FBQzdDLFNBQU8sTUFBTSxLQUFLLFFBQVEsS0FBSyxVQUFVO0FBQ3pDLFNBQU8sTUFBTSxLQUFLLFFBQVEsT0FBTyxJQUFJO0FBQ3JDLFNBQU8sTUFBTSxLQUFLLFFBQVEsSUFBSSxNQUFNLHVCQUF1QjtBQUM1RCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
