import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFrozenDefinition } from "../definition-io.js";
function createTmpDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), "gsd-defio-test-")));
}
describe("readFrozenDefinition", () => {
  let runDir;
  beforeEach(() => {
    runDir = createTmpDir();
  });
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });
  test("parses a valid DEFINITION.yaml", () => {
    const yaml = [
      "version: 1",
      "name: test-workflow",
      "description: A test workflow",
      "steps:",
      "  - id: step-1",
      "    prompt: do the thing"
    ].join("\n");
    writeFileSync(join(runDir, "DEFINITION.yaml"), yaml, "utf-8");
    const def = readFrozenDefinition(runDir);
    assert.equal(def.version, 1);
    assert.equal(def.name, "test-workflow");
    assert.equal(def.description, "A test workflow");
    assert.equal(def.steps.length, 1);
    assert.equal(def.steps[0].id, "step-1");
  });
  test("throws when DEFINITION.yaml is missing", () => {
    assert.throws(() => readFrozenDefinition(runDir), {
      code: "ENOENT"
    });
  });
  test("throws on malformed YAML", () => {
    writeFileSync(join(runDir, "DEFINITION.yaml"), ": : : not valid yaml [", "utf-8");
    assert.throws(() => readFrozenDefinition(runDir));
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9kZWZpbml0aW9uLWlvLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogZGVmaW5pdGlvbi1pby50cyBcdTIwMTQgdW5pdCB0ZXN0cyBmb3IgcmVhZEZyb3plbkRlZmluaXRpb24uXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIHRlc3QsIGJlZm9yZUVhY2gsIGFmdGVyRWFjaCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgbWtkdGVtcFN5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYywgcm1TeW5jLCByZWFscGF0aFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7IHJlYWRGcm96ZW5EZWZpbml0aW9uIH0gZnJvbSBcIi4uL2RlZmluaXRpb24taW8udHNcIjtcblxuZnVuY3Rpb24gY3JlYXRlVG1wRGlyKCk6IHN0cmluZyB7XG4gIHJldHVybiByZWFscGF0aFN5bmMobWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtZGVmaW8tdGVzdC1cIikpKTtcbn1cblxuZGVzY3JpYmUoXCJyZWFkRnJvemVuRGVmaW5pdGlvblwiLCAoKSA9PiB7XG4gIGxldCBydW5EaXI6IHN0cmluZztcblxuICBiZWZvcmVFYWNoKCgpID0+IHtcbiAgICBydW5EaXIgPSBjcmVhdGVUbXBEaXIoKTtcbiAgfSk7XG5cbiAgYWZ0ZXJFYWNoKCgpID0+IHtcbiAgICBybVN5bmMocnVuRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIHRlc3QoXCJwYXJzZXMgYSB2YWxpZCBERUZJTklUSU9OLnlhbWxcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHlhbWwgPSBbXG4gICAgICBcInZlcnNpb246IDFcIixcbiAgICAgIFwibmFtZTogdGVzdC13b3JrZmxvd1wiLFxuICAgICAgXCJkZXNjcmlwdGlvbjogQSB0ZXN0IHdvcmtmbG93XCIsXG4gICAgICBcInN0ZXBzOlwiLFxuICAgICAgXCIgIC0gaWQ6IHN0ZXAtMVwiLFxuICAgICAgXCIgICAgcHJvbXB0OiBkbyB0aGUgdGhpbmdcIixcbiAgICBdLmpvaW4oXCJcXG5cIik7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJ1bkRpciwgXCJERUZJTklUSU9OLnlhbWxcIiksIHlhbWwsIFwidXRmLThcIik7XG5cbiAgICBjb25zdCBkZWYgPSByZWFkRnJvemVuRGVmaW5pdGlvbihydW5EaXIpO1xuICAgIGFzc2VydC5lcXVhbChkZWYudmVyc2lvbiwgMSk7XG4gICAgYXNzZXJ0LmVxdWFsKGRlZi5uYW1lLCBcInRlc3Qtd29ya2Zsb3dcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGRlZi5kZXNjcmlwdGlvbiwgXCJBIHRlc3Qgd29ya2Zsb3dcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGRlZi5zdGVwcy5sZW5ndGgsIDEpO1xuICAgIGFzc2VydC5lcXVhbChkZWYuc3RlcHNbMF0uaWQsIFwic3RlcC0xXCIpO1xuICB9KTtcblxuICB0ZXN0KFwidGhyb3dzIHdoZW4gREVGSU5JVElPTi55YW1sIGlzIG1pc3NpbmdcIiwgKCkgPT4ge1xuICAgIGFzc2VydC50aHJvd3MoKCkgPT4gcmVhZEZyb3plbkRlZmluaXRpb24ocnVuRGlyKSwge1xuICAgICAgY29kZTogXCJFTk9FTlRcIixcbiAgICB9KTtcbiAgfSk7XG5cbiAgdGVzdChcInRocm93cyBvbiBtYWxmb3JtZWQgWUFNTFwiLCAoKSA9PiB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHJ1bkRpciwgXCJERUZJTklUSU9OLnlhbWxcIiksIFwiOiA6IDogbm90IHZhbGlkIHlhbWwgW1wiLCBcInV0Zi04XCIpO1xuICAgIGFzc2VydC50aHJvd3MoKCkgPT4gcmVhZEZyb3plbkRlZmluaXRpb24ocnVuRGlyKSk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFJQSxTQUFTLFVBQVUsTUFBTSxZQUFZLGlCQUFpQjtBQUN0RCxPQUFPLFlBQVk7QUFDbkIsU0FBUyxhQUF3QixlQUFlLFFBQVEsb0JBQW9CO0FBQzVFLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFFdkIsU0FBUyw0QkFBNEI7QUFFckMsU0FBUyxlQUF1QjtBQUM5QixTQUFPLGFBQWEsWUFBWSxLQUFLLE9BQU8sR0FBRyxpQkFBaUIsQ0FBQyxDQUFDO0FBQ3BFO0FBRUEsU0FBUyx3QkFBd0IsTUFBTTtBQUNyQyxNQUFJO0FBRUosYUFBVyxNQUFNO0FBQ2YsYUFBUyxhQUFhO0FBQUEsRUFDeEIsQ0FBQztBQUVELFlBQVUsTUFBTTtBQUNkLFdBQU8sUUFBUSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ2pELENBQUM7QUFFRCxPQUFLLGtDQUFrQyxNQUFNO0FBQzNDLFVBQU0sT0FBTztBQUFBLE1BQ1g7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0YsRUFBRSxLQUFLLElBQUk7QUFDWCxrQkFBYyxLQUFLLFFBQVEsaUJBQWlCLEdBQUcsTUFBTSxPQUFPO0FBRTVELFVBQU0sTUFBTSxxQkFBcUIsTUFBTTtBQUN2QyxXQUFPLE1BQU0sSUFBSSxTQUFTLENBQUM7QUFDM0IsV0FBTyxNQUFNLElBQUksTUFBTSxlQUFlO0FBQ3RDLFdBQU8sTUFBTSxJQUFJLGFBQWEsaUJBQWlCO0FBQy9DLFdBQU8sTUFBTSxJQUFJLE1BQU0sUUFBUSxDQUFDO0FBQ2hDLFdBQU8sTUFBTSxJQUFJLE1BQU0sQ0FBQyxFQUFFLElBQUksUUFBUTtBQUFBLEVBQ3hDLENBQUM7QUFFRCxPQUFLLDBDQUEwQyxNQUFNO0FBQ25ELFdBQU8sT0FBTyxNQUFNLHFCQUFxQixNQUFNLEdBQUc7QUFBQSxNQUNoRCxNQUFNO0FBQUEsSUFDUixDQUFDO0FBQUEsRUFDSCxDQUFDO0FBRUQsT0FBSyw0QkFBNEIsTUFBTTtBQUNyQyxrQkFBYyxLQUFLLFFBQVEsaUJBQWlCLEdBQUcsMEJBQTBCLE9BQU87QUFDaEYsV0FBTyxPQUFPLE1BQU0scUJBQXFCLE1BQU0sQ0FBQztBQUFBLEVBQ2xELENBQUM7QUFDSCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
