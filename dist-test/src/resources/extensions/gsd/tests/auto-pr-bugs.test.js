import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDraftPR } from "../git-service.js";
function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
test("#2302 createDraftPR passes head and base branch parameters to gh", (t) => {
  const dir = makeTempDir("gsd-auto-pr-");
  const bin = join(dir, "bin");
  const logPath = join(dir, "gh-args.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(bin, { recursive: true });
  const ghPath = join(bin, "gh");
  writeFileSync(
    ghPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));`,
      "process.stdout.write('https://example.test/pr/1\\n');"
    ].join("\n"),
    "utf-8"
  );
  chmodSync(ghPath, 493);
  const prUrl = createDraftPR(
    dir,
    "M001",
    "Draft title",
    "Draft body",
    {
      head: "milestone/M001",
      base: "main",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }
    }
  );
  assert.equal(prUrl, "https://example.test/pr/1");
  assert.deepEqual(JSON.parse(readFileSync(logPath, "utf-8")), [
    "pr",
    "create",
    "--draft",
    "--title",
    "Draft title",
    "--body",
    "Draft body",
    "--head",
    "milestone/M001",
    "--base",
    "main"
  ]);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLXByLWJ1Z3MudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBhdXRvLXByLWJ1Z3MudGVzdC50cyBcdTIwMTQgUmVncmVzc2lvbiB0ZXN0cyBmb3IgIzIzMDIuXG4gKlxuICogVmVyaWZpZXMgdGhlIFBSIGNyZWF0aW9uIGNvbW1hbmQgYmVoYXZpb3IgZGlyZWN0bHkgaW5zdGVhZCBvZiBhc3NlcnRpbmcgb25cbiAqIGdpdC1zZXJ2aWNlLnRzIHNvdXJjZSB0ZXh0LlxuICovXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgY2htb2RTeW5jLCBta2RpclN5bmMsIG1rZHRlbXBTeW5jLCByZWFkRmlsZVN5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcblxuaW1wb3J0IHsgY3JlYXRlRHJhZnRQUiB9IGZyb20gXCIuLi9naXQtc2VydmljZS50c1wiO1xuXG5mdW5jdGlvbiBtYWtlVGVtcERpcihwcmVmaXg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBwcmVmaXgpKTtcbn1cblxudGVzdChcIiMyMzAyIGNyZWF0ZURyYWZ0UFIgcGFzc2VzIGhlYWQgYW5kIGJhc2UgYnJhbmNoIHBhcmFtZXRlcnMgdG8gZ2hcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJnc2QtYXV0by1wci1cIik7XG4gIGNvbnN0IGJpbiA9IGpvaW4oZGlyLCBcImJpblwiKTtcbiAgY29uc3QgbG9nUGF0aCA9IGpvaW4oZGlyLCBcImdoLWFyZ3MuanNvblwiKTtcbiAgdC5hZnRlcigoKSA9PiBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gIG1rZGlyU3luYyhiaW4sIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCBnaFBhdGggPSBqb2luKGJpbiwgXCJnaFwiKTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBnaFBhdGgsXG4gICAgW1xuICAgICAgXCIjIS91c3IvYmluL2VudiBub2RlXCIsXG4gICAgICBcImNvbnN0IGZzID0gcmVxdWlyZSgnbm9kZTpmcycpO1wiLFxuICAgICAgYGZzLndyaXRlRmlsZVN5bmMoJHtKU09OLnN0cmluZ2lmeShsb2dQYXRoKX0sIEpTT04uc3RyaW5naWZ5KHByb2Nlc3MuYXJndi5zbGljZSgyKSkpO2AsXG4gICAgICBcInByb2Nlc3Muc3Rkb3V0LndyaXRlKCdodHRwczovL2V4YW1wbGUudGVzdC9wci8xXFxcXG4nKTtcIixcbiAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgXCJ1dGYtOFwiLFxuICApO1xuICBjaG1vZFN5bmMoZ2hQYXRoLCAwbzc1NSk7XG5cbiAgY29uc3QgcHJVcmwgPSBjcmVhdGVEcmFmdFBSKFxuICAgIGRpcixcbiAgICBcIk0wMDFcIixcbiAgICBcIkRyYWZ0IHRpdGxlXCIsXG4gICAgXCJEcmFmdCBib2R5XCIsXG4gICAge1xuICAgICAgaGVhZDogXCJtaWxlc3RvbmUvTTAwMVwiLFxuICAgICAgYmFzZTogXCJtYWluXCIsXG4gICAgICBlbnY6IHsgLi4ucHJvY2Vzcy5lbnYsIFBBVEg6IGAke2Jpbn06JHtwcm9jZXNzLmVudi5QQVRIID8/IFwiXCJ9YCB9LFxuICAgIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKHByVXJsLCBcImh0dHBzOi8vZXhhbXBsZS50ZXN0L3ByLzFcIik7XG4gIGFzc2VydC5kZWVwRXF1YWwoSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMobG9nUGF0aCwgXCJ1dGYtOFwiKSksIFtcbiAgICBcInByXCIsXG4gICAgXCJjcmVhdGVcIixcbiAgICBcIi0tZHJhZnRcIixcbiAgICBcIi0tdGl0bGVcIixcbiAgICBcIkRyYWZ0IHRpdGxlXCIsXG4gICAgXCItLWJvZHlcIixcbiAgICBcIkRyYWZ0IGJvZHlcIixcbiAgICBcIi0taGVhZFwiLFxuICAgIFwibWlsZXN0b25lL00wMDFcIixcbiAgICBcIi0tYmFzZVwiLFxuICAgIFwibWFpblwiLFxuICBdKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBT0EsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLFdBQVcsV0FBVyxhQUFhLGNBQWMsUUFBUSxxQkFBcUI7QUFDdkYsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLHFCQUFxQjtBQUU5QixTQUFTLFlBQVksUUFBd0I7QUFDM0MsU0FBTyxZQUFZLEtBQUssT0FBTyxHQUFHLE1BQU0sQ0FBQztBQUMzQztBQUVBLEtBQUssb0VBQW9FLENBQUMsTUFBTTtBQUM5RSxRQUFNLE1BQU0sWUFBWSxjQUFjO0FBQ3RDLFFBQU0sTUFBTSxLQUFLLEtBQUssS0FBSztBQUMzQixRQUFNLFVBQVUsS0FBSyxLQUFLLGNBQWM7QUFDeEMsSUFBRSxNQUFNLE1BQU0sT0FBTyxLQUFLLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDLENBQUM7QUFFM0QsWUFBVSxLQUFLLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDbEMsUUFBTSxTQUFTLEtBQUssS0FBSyxJQUFJO0FBQzdCO0FBQUEsSUFDRTtBQUFBLElBQ0E7QUFBQSxNQUNFO0FBQUEsTUFDQTtBQUFBLE1BQ0Esb0JBQW9CLEtBQUssVUFBVSxPQUFPLENBQUM7QUFBQSxNQUMzQztBQUFBLElBQ0YsRUFBRSxLQUFLLElBQUk7QUFBQSxJQUNYO0FBQUEsRUFDRjtBQUNBLFlBQVUsUUFBUSxHQUFLO0FBRXZCLFFBQU0sUUFBUTtBQUFBLElBQ1o7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsTUFDRSxNQUFNO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixLQUFLLEVBQUUsR0FBRyxRQUFRLEtBQUssTUFBTSxHQUFHLEdBQUcsSUFBSSxRQUFRLElBQUksUUFBUSxFQUFFLEdBQUc7QUFBQSxJQUNsRTtBQUFBLEVBQ0Y7QUFFQSxTQUFPLE1BQU0sT0FBTywyQkFBMkI7QUFDL0MsU0FBTyxVQUFVLEtBQUssTUFBTSxhQUFhLFNBQVMsT0FBTyxDQUFDLEdBQUc7QUFBQSxJQUMzRDtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGLENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
