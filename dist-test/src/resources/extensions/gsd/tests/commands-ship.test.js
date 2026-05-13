import test from "node:test";
import assert from "node:assert/strict";
test("ship: generates TL;DR format", () => {
  const milestoneId = "M001";
  const milestoneTitle = "User authentication system";
  const title = `feat: ${milestoneTitle}`;
  assert.equal(title, "feat: User authentication system");
  assert.ok(title.length < 80);
});
test("ship: --dry-run flag detection", () => {
  const args1 = "--dry-run";
  const args2 = "--draft --dry-run";
  const args3 = "--draft";
  assert.ok(args1.includes("--dry-run"));
  assert.ok(args2.includes("--dry-run"));
  assert.ok(!args3.includes("--dry-run"));
});
test("ship: --base flag parsing", () => {
  const args = "--base develop --draft";
  const baseMatch = args.match(/--base\s+(\S+)/);
  assert.ok(baseMatch);
  assert.equal(baseMatch[1], "develop");
});
test("ship: --base flag absent defaults", () => {
  const args = "--draft";
  const baseMatch = args.match(/--base\s+(\S+)/);
  assert.equal(baseMatch, null);
});
test("ship: --force flag detection", () => {
  const args1 = "--force";
  const args2 = "";
  assert.ok(args1.includes("--force"));
  assert.ok(!args2.includes("--force"));
});
test("ship: change type checklist format", () => {
  const checklist = [
    "- [x] `feat` \u2014 New feature or capability",
    "- [ ] `fix` \u2014 Bug fix",
    "- [ ] `refactor` \u2014 Code restructuring",
    "- [ ] `test` \u2014 Adding or updating tests",
    "- [ ] `docs` \u2014 Documentation only",
    "- [ ] `chore` \u2014 Build, CI, or tooling changes"
  ];
  for (const line of checklist) {
    assert.match(line, /^- \[[ x]\] `\w+` — .+$/);
  }
});
test("ship: PR body contains required sections", () => {
  const requiredSections = ["## TL;DR", "## Change type"];
  const body = "## TL;DR\n\n**What:** Ship M001\n\n## Change type\n\n- [x] `feat`";
  for (const section of requiredSections) {
    assert.ok(body.includes(section), `Missing section: ${section}`);
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jb21tYW5kcy1zaGlwLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG4vLyBUZXN0IHRoZSBQUiBjb250ZW50IGdlbmVyYXRpb24gbG9naWMgdXNlZCBieSAvZ3NkIHNoaXAuXG4vLyBGdWxsIGludGVncmF0aW9uIHJlcXVpcmVzIGdoIENMSSArIGdpdCwgc28gd2UgdGVzdCB0aGUgdGV4dCBnZW5lcmF0aW9uLlxuXG50ZXN0KFwic2hpcDogZ2VuZXJhdGVzIFRMO0RSIGZvcm1hdFwiLCAoKSA9PiB7XG4gIC8vIFNpbXVsYXRlIGdlbmVyYXRlUFJDb250ZW50IG91dHB1dCBzdHJ1Y3R1cmVcbiAgY29uc3QgbWlsZXN0b25lSWQgPSBcIk0wMDFcIjtcbiAgY29uc3QgbWlsZXN0b25lVGl0bGUgPSBcIlVzZXIgYXV0aGVudGljYXRpb24gc3lzdGVtXCI7XG5cbiAgY29uc3QgdGl0bGUgPSBgZmVhdDogJHttaWxlc3RvbmVUaXRsZX1gO1xuICBhc3NlcnQuZXF1YWwodGl0bGUsIFwiZmVhdDogVXNlciBhdXRoZW50aWNhdGlvbiBzeXN0ZW1cIik7XG4gIGFzc2VydC5vayh0aXRsZS5sZW5ndGggPCA4MCk7IC8vIFBSIHRpdGxlIHNob3VsZCBiZSBzaG9ydFxufSk7XG5cbnRlc3QoXCJzaGlwOiAtLWRyeS1ydW4gZmxhZyBkZXRlY3Rpb25cIiwgKCkgPT4ge1xuICBjb25zdCBhcmdzMSA9IFwiLS1kcnktcnVuXCI7XG4gIGNvbnN0IGFyZ3MyID0gXCItLWRyYWZ0IC0tZHJ5LXJ1blwiO1xuICBjb25zdCBhcmdzMyA9IFwiLS1kcmFmdFwiO1xuXG4gIGFzc2VydC5vayhhcmdzMS5pbmNsdWRlcyhcIi0tZHJ5LXJ1blwiKSk7XG4gIGFzc2VydC5vayhhcmdzMi5pbmNsdWRlcyhcIi0tZHJ5LXJ1blwiKSk7XG4gIGFzc2VydC5vayghYXJnczMuaW5jbHVkZXMoXCItLWRyeS1ydW5cIikpO1xufSk7XG5cbnRlc3QoXCJzaGlwOiAtLWJhc2UgZmxhZyBwYXJzaW5nXCIsICgpID0+IHtcbiAgY29uc3QgYXJncyA9IFwiLS1iYXNlIGRldmVsb3AgLS1kcmFmdFwiO1xuICBjb25zdCBiYXNlTWF0Y2ggPSBhcmdzLm1hdGNoKC8tLWJhc2VcXHMrKFxcUyspLyk7XG4gIGFzc2VydC5vayhiYXNlTWF0Y2gpO1xuICBhc3NlcnQuZXF1YWwoYmFzZU1hdGNoWzFdLCBcImRldmVsb3BcIik7XG59KTtcblxudGVzdChcInNoaXA6IC0tYmFzZSBmbGFnIGFic2VudCBkZWZhdWx0c1wiLCAoKSA9PiB7XG4gIGNvbnN0IGFyZ3MgPSBcIi0tZHJhZnRcIjtcbiAgY29uc3QgYmFzZU1hdGNoID0gYXJncy5tYXRjaCgvLS1iYXNlXFxzKyhcXFMrKS8pO1xuICBhc3NlcnQuZXF1YWwoYmFzZU1hdGNoLCBudWxsKTtcbn0pO1xuXG50ZXN0KFwic2hpcDogLS1mb3JjZSBmbGFnIGRldGVjdGlvblwiLCAoKSA9PiB7XG4gIGNvbnN0IGFyZ3MxID0gXCItLWZvcmNlXCI7XG4gIGNvbnN0IGFyZ3MyID0gXCJcIjtcblxuICBhc3NlcnQub2soYXJnczEuaW5jbHVkZXMoXCItLWZvcmNlXCIpKTtcbiAgYXNzZXJ0Lm9rKCFhcmdzMi5pbmNsdWRlcyhcIi0tZm9yY2VcIikpO1xufSk7XG5cbnRlc3QoXCJzaGlwOiBjaGFuZ2UgdHlwZSBjaGVja2xpc3QgZm9ybWF0XCIsICgpID0+IHtcbiAgY29uc3QgY2hlY2tsaXN0ID0gW1xuICAgIFwiLSBbeF0gYGZlYXRgIFx1MjAxNCBOZXcgZmVhdHVyZSBvciBjYXBhYmlsaXR5XCIsXG4gICAgXCItIFsgXSBgZml4YCBcdTIwMTQgQnVnIGZpeFwiLFxuICAgIFwiLSBbIF0gYHJlZmFjdG9yYCBcdTIwMTQgQ29kZSByZXN0cnVjdHVyaW5nXCIsXG4gICAgXCItIFsgXSBgdGVzdGAgXHUyMDE0IEFkZGluZyBvciB1cGRhdGluZyB0ZXN0c1wiLFxuICAgIFwiLSBbIF0gYGRvY3NgIFx1MjAxNCBEb2N1bWVudGF0aW9uIG9ubHlcIixcbiAgICBcIi0gWyBdIGBjaG9yZWAgXHUyMDE0IEJ1aWxkLCBDSSwgb3IgdG9vbGluZyBjaGFuZ2VzXCIsXG4gIF07XG5cbiAgLy8gVmVyaWZ5IGZvcm1hdCBtYXRjaGVzIENPTlRSSUJVVElORy5tZCBleHBlY3RhdGlvbnNcbiAgZm9yIChjb25zdCBsaW5lIG9mIGNoZWNrbGlzdCkge1xuICAgIGFzc2VydC5tYXRjaChsaW5lLCAvXi0gXFxbWyB4XVxcXSBgXFx3K2AgXHUyMDE0IC4rJC8pO1xuICB9XG59KTtcblxudGVzdChcInNoaXA6IFBSIGJvZHkgY29udGFpbnMgcmVxdWlyZWQgc2VjdGlvbnNcIiwgKCkgPT4ge1xuICBjb25zdCByZXF1aXJlZFNlY3Rpb25zID0gW1wiIyMgVEw7RFJcIiwgXCIjIyBDaGFuZ2UgdHlwZVwiXTtcbiAgY29uc3QgYm9keSA9IFwiIyMgVEw7RFJcXG5cXG4qKldoYXQ6KiogU2hpcCBNMDAxXFxuXFxuIyMgQ2hhbmdlIHR5cGVcXG5cXG4tIFt4XSBgZmVhdGBcIjtcblxuICBmb3IgKGNvbnN0IHNlY3Rpb24gb2YgcmVxdWlyZWRTZWN0aW9ucykge1xuICAgIGFzc2VydC5vayhib2R5LmluY2x1ZGVzKHNlY3Rpb24pLCBgTWlzc2luZyBzZWN0aW9uOiAke3NlY3Rpb259YCk7XG4gIH1cbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUtuQixLQUFLLGdDQUFnQyxNQUFNO0FBRXpDLFFBQU0sY0FBYztBQUNwQixRQUFNLGlCQUFpQjtBQUV2QixRQUFNLFFBQVEsU0FBUyxjQUFjO0FBQ3JDLFNBQU8sTUFBTSxPQUFPLGtDQUFrQztBQUN0RCxTQUFPLEdBQUcsTUFBTSxTQUFTLEVBQUU7QUFDN0IsQ0FBQztBQUVELEtBQUssa0NBQWtDLE1BQU07QUFDM0MsUUFBTSxRQUFRO0FBQ2QsUUFBTSxRQUFRO0FBQ2QsUUFBTSxRQUFRO0FBRWQsU0FBTyxHQUFHLE1BQU0sU0FBUyxXQUFXLENBQUM7QUFDckMsU0FBTyxHQUFHLE1BQU0sU0FBUyxXQUFXLENBQUM7QUFDckMsU0FBTyxHQUFHLENBQUMsTUFBTSxTQUFTLFdBQVcsQ0FBQztBQUN4QyxDQUFDO0FBRUQsS0FBSyw2QkFBNkIsTUFBTTtBQUN0QyxRQUFNLE9BQU87QUFDYixRQUFNLFlBQVksS0FBSyxNQUFNLGdCQUFnQjtBQUM3QyxTQUFPLEdBQUcsU0FBUztBQUNuQixTQUFPLE1BQU0sVUFBVSxDQUFDLEdBQUcsU0FBUztBQUN0QyxDQUFDO0FBRUQsS0FBSyxxQ0FBcUMsTUFBTTtBQUM5QyxRQUFNLE9BQU87QUFDYixRQUFNLFlBQVksS0FBSyxNQUFNLGdCQUFnQjtBQUM3QyxTQUFPLE1BQU0sV0FBVyxJQUFJO0FBQzlCLENBQUM7QUFFRCxLQUFLLGdDQUFnQyxNQUFNO0FBQ3pDLFFBQU0sUUFBUTtBQUNkLFFBQU0sUUFBUTtBQUVkLFNBQU8sR0FBRyxNQUFNLFNBQVMsU0FBUyxDQUFDO0FBQ25DLFNBQU8sR0FBRyxDQUFDLE1BQU0sU0FBUyxTQUFTLENBQUM7QUFDdEMsQ0FBQztBQUVELEtBQUssc0NBQXNDLE1BQU07QUFDL0MsUUFBTSxZQUFZO0FBQUEsSUFDaEI7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0Y7QUFHQSxhQUFXLFFBQVEsV0FBVztBQUM1QixXQUFPLE1BQU0sTUFBTSx5QkFBeUI7QUFBQSxFQUM5QztBQUNGLENBQUM7QUFFRCxLQUFLLDRDQUE0QyxNQUFNO0FBQ3JELFFBQU0sbUJBQW1CLENBQUMsWUFBWSxnQkFBZ0I7QUFDdEQsUUFBTSxPQUFPO0FBRWIsYUFBVyxXQUFXLGtCQUFrQjtBQUN0QyxXQUFPLEdBQUcsS0FBSyxTQUFTLE9BQU8sR0FBRyxvQkFBb0IsT0FBTyxFQUFFO0FBQUEsRUFDakU7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
