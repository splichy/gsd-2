import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
test("shared/mod.ts imports without resolving @gsd/pi-tui", () => {
  const tmp = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "gsd-shared-mod-"));
  const loaderPath = join(tmp, "block-pi-tui-loader.mjs");
  writeFileSync(
    loaderPath,
    [
      "export async function resolve(specifier, context, nextResolve) {",
      "  if (specifier === '@gsd/pi-tui') throw new Error('unexpected @gsd/pi-tui import');",
      "  return nextResolve(specifier, context);",
      "}",
      ""
    ].join("\n"),
    "utf-8"
  );
  try {
    const sharedModPath = join(__dirname, "../../shared/mod.ts");
    const resolveTsPath = join(__dirname, "resolve-ts.mjs");
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        resolveTsPath,
        "--experimental-loader",
        loaderPath,
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(sharedModPath)});`
      ],
      { encoding: "utf-8" }
    );
    assert.equal(
      result.status,
      0,
      `shared/mod.ts should import without @gsd/pi-tui; stderr:
${result.stderr}`
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9sYXp5LXBpLXR1aS1pbXBvcnQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEMiBcdTIwMTQgU2hhcmVkIGJhcnJlbCBpbXBvcnQgYmVoYXZpb3Igd2l0aG91dCBUVUkgZGVwZW5kZW5jeSBsb2FkaW5nXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCBkaXJuYW1lIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgc3Bhd25TeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuXG5jb25zdCBfX2Rpcm5hbWUgPSBkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG5cbnRlc3QoXCJzaGFyZWQvbW9kLnRzIGltcG9ydHMgd2l0aG91dCByZXNvbHZpbmcgQGdzZC9waS10dWlcIiwgKCkgPT4ge1xuICBjb25zdCB0bXAgPSBta2R0ZW1wU3luYyhqb2luKHByb2Nlc3MuZW52LlRNUERJUiA/PyBcIi90bXBcIiwgXCJnc2Qtc2hhcmVkLW1vZC1cIikpO1xuICBjb25zdCBsb2FkZXJQYXRoID0gam9pbih0bXAsIFwiYmxvY2stcGktdHVpLWxvYWRlci5tanNcIik7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgbG9hZGVyUGF0aCxcbiAgICBbXG4gICAgICBcImV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXNvbHZlKHNwZWNpZmllciwgY29udGV4dCwgbmV4dFJlc29sdmUpIHtcIixcbiAgICAgIFwiICBpZiAoc3BlY2lmaWVyID09PSAnQGdzZC9waS10dWknKSB0aHJvdyBuZXcgRXJyb3IoJ3VuZXhwZWN0ZWQgQGdzZC9waS10dWkgaW1wb3J0Jyk7XCIsXG4gICAgICBcIiAgcmV0dXJuIG5leHRSZXNvbHZlKHNwZWNpZmllciwgY29udGV4dCk7XCIsXG4gICAgICBcIn1cIixcbiAgICAgIFwiXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICAgIFwidXRmLThcIixcbiAgKTtcblxuICB0cnkge1xuICAgIGNvbnN0IHNoYXJlZE1vZFBhdGggPSBqb2luKF9fZGlybmFtZSwgXCIuLi8uLi9zaGFyZWQvbW9kLnRzXCIpO1xuICAgIGNvbnN0IHJlc29sdmVUc1BhdGggPSBqb2luKF9fZGlybmFtZSwgXCJyZXNvbHZlLXRzLm1qc1wiKTtcbiAgICBjb25zdCByZXN1bHQgPSBzcGF3blN5bmMoXG4gICAgICBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgW1xuICAgICAgICBcIi0tZXhwZXJpbWVudGFsLXN0cmlwLXR5cGVzXCIsXG4gICAgICAgIFwiLS1pbXBvcnRcIixcbiAgICAgICAgcmVzb2x2ZVRzUGF0aCxcbiAgICAgICAgXCItLWV4cGVyaW1lbnRhbC1sb2FkZXJcIixcbiAgICAgICAgbG9hZGVyUGF0aCxcbiAgICAgICAgXCItLWlucHV0LXR5cGU9bW9kdWxlXCIsXG4gICAgICAgIFwiLS1ldmFsXCIsXG4gICAgICAgIGBhd2FpdCBpbXBvcnQoJHtKU09OLnN0cmluZ2lmeShzaGFyZWRNb2RQYXRoKX0pO2AsXG4gICAgICBdLFxuICAgICAgeyBlbmNvZGluZzogXCJ1dGYtOFwiIH0sXG4gICAgKTtcblxuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHJlc3VsdC5zdGF0dXMsXG4gICAgICAwLFxuICAgICAgYHNoYXJlZC9tb2QudHMgc2hvdWxkIGltcG9ydCB3aXRob3V0IEBnc2QvcGktdHVpOyBzdGRlcnI6XFxuJHtyZXN1bHQuc3RkZXJyfWAsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmModG1wLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsUUFBUSxxQkFBcUI7QUFDbkQsU0FBUyxNQUFNLGVBQWU7QUFDOUIsU0FBUyxpQkFBaUI7QUFDMUIsU0FBUyxxQkFBcUI7QUFFOUIsTUFBTSxZQUFZLFFBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQztBQUV4RCxLQUFLLHVEQUF1RCxNQUFNO0FBQ2hFLFFBQU0sTUFBTSxZQUFZLEtBQUssUUFBUSxJQUFJLFVBQVUsUUFBUSxpQkFBaUIsQ0FBQztBQUM3RSxRQUFNLGFBQWEsS0FBSyxLQUFLLHlCQUF5QjtBQUN0RDtBQUFBLElBQ0U7QUFBQSxJQUNBO0FBQUEsTUFDRTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGLEVBQUUsS0FBSyxJQUFJO0FBQUEsSUFDWDtBQUFBLEVBQ0Y7QUFFQSxNQUFJO0FBQ0YsVUFBTSxnQkFBZ0IsS0FBSyxXQUFXLHFCQUFxQjtBQUMzRCxVQUFNLGdCQUFnQixLQUFLLFdBQVcsZ0JBQWdCO0FBQ3RELFVBQU0sU0FBUztBQUFBLE1BQ2IsUUFBUTtBQUFBLE1BQ1I7QUFBQSxRQUNFO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQSxnQkFBZ0IsS0FBSyxVQUFVLGFBQWEsQ0FBQztBQUFBLE1BQy9DO0FBQUEsTUFDQSxFQUFFLFVBQVUsUUFBUTtBQUFBLElBQ3RCO0FBRUEsV0FBTztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1A7QUFBQSxNQUNBO0FBQUEsRUFBNkQsT0FBTyxNQUFNO0FBQUEsSUFDNUU7QUFBQSxFQUNGLFVBQUU7QUFDQSxXQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUM5QztBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
