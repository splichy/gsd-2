import test from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_SUCCESS,
  EXIT_ERROR,
  EXIT_BLOCKED,
  EXIT_CANCELLED,
  mapStatusToExitCode
} from "../headless-events.js";
import { VALID_OUTPUT_FORMATS } from "../headless-types.js";
function parseHeadlessArgs(argv) {
  const options = {
    timeout: 3e5,
    json: false,
    outputFormat: "text",
    command: "auto",
    commandArgs: []
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "headless") continue;
    if (arg.startsWith("--")) {
      if (arg === "--timeout" && i + 1 < args.length) {
        options.timeout = parseInt(args[++i], 10);
      } else if (arg === "--json") {
        options.json = true;
        options.outputFormat = "stream-json";
      } else if (arg === "--output-format" && i + 1 < args.length) {
        const fmt = args[++i];
        if (!VALID_OUTPUT_FORMATS.has(fmt)) {
          throw new Error(`Invalid output format: ${fmt}`);
        }
        options.outputFormat = fmt;
        if (fmt === "stream-json" || fmt === "json") {
          options.json = true;
        }
      } else if (arg === "--model" && i + 1 < args.length) {
        options.model = args[++i];
      } else if (arg === "--context" && i + 1 < args.length) {
        options.context = args[++i];
      } else if (arg === "--context-text" && i + 1 < args.length) {
        options.contextText = args[++i];
      } else if (arg === "--auto") {
        options.auto = true;
      } else if (arg === "--verbose") {
        options.verbose = true;
      } else if (arg === "--max-restarts" && i + 1 < args.length) {
        options.maxRestarts = parseInt(args[++i], 10);
      } else if (arg === "--answers" && i + 1 < args.length) {
        options.answers = args[++i];
      } else if (arg === "--events" && i + 1 < args.length) {
        options.eventFilter = new Set(args[++i].split(","));
        options.json = true;
        if (options.outputFormat === "text") {
          options.outputFormat = "stream-json";
        }
      } else if (arg === "--supervised") {
        options.supervised = true;
        options.json = true;
        if (options.outputFormat === "text") {
          options.outputFormat = "stream-json";
        }
      } else if (arg === "--response-timeout" && i + 1 < args.length) {
        options.responseTimeout = parseInt(args[++i], 10);
      } else if (arg === "--resume" && i + 1 < args.length) {
        options.resumeSession = args[++i];
      } else if (arg === "--bare") {
        options.bare = true;
      }
    } else if (options.command === "auto") {
      options.command = arg;
    } else {
      options.commandArgs.push(arg);
    }
  }
  return options;
}
test("--output-format text sets outputFormat to text", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "--output-format", "text", "auto"]);
  assert.equal(opts.outputFormat, "text");
  assert.equal(opts.json, false);
});
test("--output-format json sets outputFormat to json and json=true", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "--output-format", "json", "auto"]);
  assert.equal(opts.outputFormat, "json");
  assert.equal(opts.json, true);
});
test("--output-format stream-json sets outputFormat to stream-json and json=true", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "--output-format", "stream-json", "auto"]);
  assert.equal(opts.outputFormat, "stream-json");
  assert.equal(opts.json, true);
});
test("default output format is text", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "auto"]);
  assert.equal(opts.outputFormat, "text");
  assert.equal(opts.json, false);
});
test("invalid --output-format value throws", () => {
  assert.throws(
    () => parseHeadlessArgs(["node", "gsd", "headless", "--output-format", "yaml", "auto"]),
    /Invalid output format: yaml/
  );
});
test("invalid --output-format value (empty) throws", () => {
  assert.throws(
    () => parseHeadlessArgs(["node", "gsd", "headless", "--output-format", "xml", "auto"]),
    /Invalid output format/
  );
});
test("--json is alias for --output-format stream-json", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "--json", "auto"]);
  assert.equal(opts.outputFormat, "stream-json");
  assert.equal(opts.json, true);
});
test("--json before --output-format json: last writer wins", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "--json", "--output-format", "json", "auto"]);
  assert.equal(opts.outputFormat, "json");
  assert.equal(opts.json, true);
});
test("--resume parses session ID", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "--resume", "abc-123", "auto"]);
  assert.equal(opts.resumeSession, "abc-123");
  assert.equal(opts.command, "auto");
});
test("no --resume means undefined", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "auto"]);
  assert.equal(opts.resumeSession, void 0);
});
test("EXIT_SUCCESS is 0", () => {
  assert.equal(EXIT_SUCCESS, 0);
});
test("EXIT_ERROR is 1", () => {
  assert.equal(EXIT_ERROR, 1);
});
test("EXIT_BLOCKED is 10", () => {
  assert.equal(EXIT_BLOCKED, 10);
});
test("EXIT_CANCELLED is 11", () => {
  assert.equal(EXIT_CANCELLED, 11);
});
test("mapStatusToExitCode: success \u2192 0", () => {
  assert.equal(mapStatusToExitCode("success"), EXIT_SUCCESS);
});
test("mapStatusToExitCode: complete \u2192 0", () => {
  assert.equal(mapStatusToExitCode("complete"), EXIT_SUCCESS);
});
test("mapStatusToExitCode: error \u2192 1", () => {
  assert.equal(mapStatusToExitCode("error"), EXIT_ERROR);
});
test("mapStatusToExitCode: timeout \u2192 1", () => {
  assert.equal(mapStatusToExitCode("timeout"), EXIT_ERROR);
});
test("mapStatusToExitCode: blocked \u2192 10", () => {
  assert.equal(mapStatusToExitCode("blocked"), EXIT_BLOCKED);
});
test("mapStatusToExitCode: cancelled \u2192 11", () => {
  assert.equal(mapStatusToExitCode("cancelled"), EXIT_CANCELLED);
});
test("mapStatusToExitCode: unknown status defaults to EXIT_ERROR", () => {
  assert.equal(mapStatusToExitCode("unknown"), EXIT_ERROR);
  assert.equal(mapStatusToExitCode(""), EXIT_ERROR);
});
test("HeadlessJsonResult satisfies expected shape", () => {
  const result = {
    status: "success",
    exitCode: 0,
    duration: 12345,
    cost: { total: 0.05, input_tokens: 1e3, output_tokens: 500, cache_read_tokens: 200, cache_write_tokens: 100 },
    toolCalls: 15,
    events: 42
  };
  assert.equal(result.status, "success");
  assert.equal(result.exitCode, 0);
  assert.equal(typeof result.duration, "number");
  assert.ok(result.cost);
  assert.equal(typeof result.cost.total, "number");
  assert.equal(typeof result.cost.input_tokens, "number");
  assert.equal(typeof result.cost.output_tokens, "number");
  assert.equal(typeof result.cost.cache_read_tokens, "number");
  assert.equal(typeof result.cost.cache_write_tokens, "number");
  assert.equal(typeof result.toolCalls, "number");
  assert.equal(typeof result.events, "number");
});
test("HeadlessJsonResult accepts optional fields", () => {
  const result = {
    status: "blocked",
    exitCode: 10,
    sessionId: "sess-abc",
    duration: 5e3,
    cost: { total: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    toolCalls: 0,
    events: 1,
    milestone: "M001",
    phase: "planning",
    nextAction: "fix blocker",
    artifacts: ["ROADMAP.md"],
    commits: ["abc1234"]
  };
  assert.equal(result.sessionId, "sess-abc");
  assert.equal(result.milestone, "M001");
  assert.deepEqual(result.artifacts, ["ROADMAP.md"]);
  assert.deepEqual(result.commits, ["abc1234"]);
});
test("VALID_OUTPUT_FORMATS contains exactly text, json, stream-json", () => {
  assert.equal(VALID_OUTPUT_FORMATS.size, 3);
  assert.ok(VALID_OUTPUT_FORMATS.has("text"));
  assert.ok(VALID_OUTPUT_FORMATS.has("json"));
  assert.ok(VALID_OUTPUT_FORMATS.has("stream-json"));
});
test("--events still works with new outputFormat default", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "--events", "agent_end,tool_execution_start", "auto"]);
  assert.ok(opts.eventFilter instanceof Set);
  assert.equal(opts.eventFilter.size, 2);
  assert.equal(opts.json, true);
  assert.equal(opts.outputFormat, "stream-json");
});
test("--timeout still works", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "--timeout", "60000", "auto"]);
  assert.equal(opts.timeout, 6e4);
});
test("--supervised still works and implies stream-json", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "--supervised", "auto"]);
  assert.equal(opts.supervised, true);
  assert.equal(opts.json, true);
  assert.equal(opts.outputFormat, "stream-json");
});
test("--answers still works", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "--answers", "answers.json", "auto"]);
  assert.equal(opts.answers, "answers.json");
});
test("positional command parsing still works", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "next"]);
  assert.equal(opts.command, "next");
});
test("combined flags parse correctly", () => {
  const opts = parseHeadlessArgs([
    "node",
    "gsd",
    "headless",
    "--output-format",
    "json",
    "--timeout",
    "120000",
    "--resume",
    "sess-xyz",
    "--verbose",
    "auto"
  ]);
  assert.equal(opts.outputFormat, "json");
  assert.equal(opts.json, true);
  assert.equal(opts.timeout, 12e4);
  assert.equal(opts.resumeSession, "sess-xyz");
  assert.equal(opts.verbose, true);
  assert.equal(opts.command, "auto");
});
test("--bare sets bare to true", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "--bare", "auto"]);
  assert.equal(opts.bare, true);
  assert.equal(opts.command, "auto");
});
test("no --bare means bare is undefined", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "auto"]);
  assert.equal(opts.bare, void 0);
});
test("--bare is a boolean flag (no value needed)", () => {
  const opts = parseHeadlessArgs(["node", "gsd", "headless", "--bare", "--json", "auto"]);
  assert.equal(opts.bare, true);
  assert.equal(opts.json, true);
});
test("--bare combined with --output-format json", () => {
  const opts = parseHeadlessArgs([
    "node",
    "gsd",
    "headless",
    "--bare",
    "--output-format",
    "json",
    "auto"
  ]);
  assert.equal(opts.bare, true);
  assert.equal(opts.outputFormat, "json");
  assert.equal(opts.json, true);
  assert.equal(opts.command, "auto");
});
test("command before flags: new-milestone --context-text --auto --verbose", () => {
  const opts = parseHeadlessArgs([
    "node",
    "gsd",
    "headless",
    "new-milestone",
    "--context-text",
    "build something cool",
    "--auto",
    "--verbose"
  ]);
  assert.equal(opts.command, "new-milestone");
  assert.equal(opts.contextText, "build something cool");
  assert.equal(opts.auto, true);
  assert.equal(opts.verbose, true);
});
test("command before flags: next --json --timeout", () => {
  const opts = parseHeadlessArgs([
    "node",
    "gsd",
    "headless",
    "next",
    "--json",
    "--timeout",
    "60000"
  ]);
  assert.equal(opts.command, "next");
  assert.equal(opts.json, true);
  assert.equal(opts.timeout, 6e4);
});
test("command between flags: --auto new-milestone --verbose", () => {
  const opts = parseHeadlessArgs([
    "node",
    "gsd",
    "headless",
    "--auto",
    "new-milestone",
    "--verbose"
  ]);
  assert.equal(opts.command, "new-milestone");
  assert.equal(opts.auto, true);
  assert.equal(opts.verbose, true);
});
test("--bare does not affect other flags", () => {
  const opts = parseHeadlessArgs([
    "node",
    "gsd",
    "headless",
    "--bare",
    "--timeout",
    "60000",
    "--resume",
    "sess-abc",
    "auto"
  ]);
  assert.equal(opts.bare, true);
  assert.equal(opts.timeout, 6e4);
  assert.equal(opts.resumeSession, "sess-abc");
  assert.equal(opts.command, "auto");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL2hlYWRsZXNzLWNsaS1zdXJmYWNlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVGVzdHMgZm9yIFMwMiBDTEkgc3VyZmFjZSBcdTIwMTQgLS1vdXRwdXQtZm9ybWF0LCBleGl0IGNvZGVzLCBIZWFkbGVzc0pzb25SZXN1bHQsIC0tcmVzdW1lLlxuICpcbiAqIFVzZXMgZXh0cmFjdGVkIHBhcnNpbmcgbG9naWMgKG1pcnJvcnMgaGVhZGxlc3MudHMpIGFuZCBkaXJlY3QgaW1wb3J0cyBmcm9tXG4gKiBoZWFkbGVzcy10eXBlcy50cyAvIGhlYWRsZXNzLWV2ZW50cy50cyB0byBhdm9pZCB0cmFuc2l0aXZlIEBnc2QvbmF0aXZlXG4gKiBpbXBvcnQgdGhhdCBicmVha3MgaW4gdGVzdCBlbnZpcm9ubWVudC5cbiAqL1xuXG5pbXBvcnQgdGVzdCBmcm9tICdub2RlOnRlc3QnXG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCdcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEltcG9ydCBleGl0IGNvZGUgY29uc3RhbnRzICYgbWFwU3RhdHVzVG9FeGl0Q29kZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuaW1wb3J0IHtcbiAgRVhJVF9TVUNDRVNTLFxuICBFWElUX0VSUk9SLFxuICBFWElUX0JMT0NLRUQsXG4gIEVYSVRfQ0FOQ0VMTEVELFxuICBtYXBTdGF0dXNUb0V4aXRDb2RlLFxufSBmcm9tICcuLi9oZWFkbGVzcy1ldmVudHMuanMnXG5cbmltcG9ydCB0eXBlIHsgT3V0cHV0Rm9ybWF0LCBIZWFkbGVzc0pzb25SZXN1bHQgfSBmcm9tICcuLi9oZWFkbGVzcy10eXBlcy5qcydcbmltcG9ydCB7IFZBTElEX09VVFBVVF9GT1JNQVRTIH0gZnJvbSAnLi4vaGVhZGxlc3MtdHlwZXMuanMnXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBFeHRyYWN0ZWQgcGFyc2luZyBsb2dpYyAobWlycm9ycyBoZWFkbGVzcy50cykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmludGVyZmFjZSBIZWFkbGVzc09wdGlvbnMge1xuICB0aW1lb3V0OiBudW1iZXJcbiAganNvbjogYm9vbGVhblxuICBvdXRwdXRGb3JtYXQ6IE91dHB1dEZvcm1hdFxuICBtb2RlbD86IHN0cmluZ1xuICBjb21tYW5kOiBzdHJpbmdcbiAgY29tbWFuZEFyZ3M6IHN0cmluZ1tdXG4gIGNvbnRleHQ/OiBzdHJpbmdcbiAgY29udGV4dFRleHQ/OiBzdHJpbmdcbiAgYXV0bz86IGJvb2xlYW5cbiAgdmVyYm9zZT86IGJvb2xlYW5cbiAgbWF4UmVzdGFydHM/OiBudW1iZXJcbiAgc3VwZXJ2aXNlZD86IGJvb2xlYW5cbiAgcmVzcG9uc2VUaW1lb3V0PzogbnVtYmVyXG4gIGFuc3dlcnM/OiBzdHJpbmdcbiAgZXZlbnRGaWx0ZXI/OiBTZXQ8c3RyaW5nPlxuICByZXN1bWVTZXNzaW9uPzogc3RyaW5nXG4gIGJhcmU/OiBib29sZWFuXG59XG5cbmZ1bmN0aW9uIHBhcnNlSGVhZGxlc3NBcmdzKGFyZ3Y6IHN0cmluZ1tdKTogSGVhZGxlc3NPcHRpb25zIHtcbiAgY29uc3Qgb3B0aW9uczogSGVhZGxlc3NPcHRpb25zID0ge1xuICAgIHRpbWVvdXQ6IDMwMF8wMDAsXG4gICAganNvbjogZmFsc2UsXG4gICAgb3V0cHV0Rm9ybWF0OiAndGV4dCcsXG4gICAgY29tbWFuZDogJ2F1dG8nLFxuICAgIGNvbW1hbmRBcmdzOiBbXSxcbiAgfVxuXG4gIGNvbnN0IGFyZ3MgPSBhcmd2LnNsaWNlKDIpXG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgYXJnID0gYXJnc1tpXVxuICAgIGlmIChhcmcgPT09ICdoZWFkbGVzcycpIGNvbnRpbnVlXG5cbiAgICBpZiAoYXJnLnN0YXJ0c1dpdGgoJy0tJykpIHtcbiAgICAgIGlmIChhcmcgPT09ICctLXRpbWVvdXQnICYmIGkgKyAxIDwgYXJncy5sZW5ndGgpIHtcbiAgICAgICAgb3B0aW9ucy50aW1lb3V0ID0gcGFyc2VJbnQoYXJnc1srK2ldLCAxMClcbiAgICAgIH0gZWxzZSBpZiAoYXJnID09PSAnLS1qc29uJykge1xuICAgICAgICBvcHRpb25zLmpzb24gPSB0cnVlXG4gICAgICAgIG9wdGlvbnMub3V0cHV0Rm9ybWF0ID0gJ3N0cmVhbS1qc29uJ1xuICAgICAgfSBlbHNlIGlmIChhcmcgPT09ICctLW91dHB1dC1mb3JtYXQnICYmIGkgKyAxIDwgYXJncy5sZW5ndGgpIHtcbiAgICAgICAgY29uc3QgZm10ID0gYXJnc1srK2ldXG4gICAgICAgIGlmICghVkFMSURfT1VUUFVUX0ZPUk1BVFMuaGFzKGZtdCkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgb3V0cHV0IGZvcm1hdDogJHtmbXR9YClcbiAgICAgICAgfVxuICAgICAgICBvcHRpb25zLm91dHB1dEZvcm1hdCA9IGZtdCBhcyBPdXRwdXRGb3JtYXRcbiAgICAgICAgaWYgKGZtdCA9PT0gJ3N0cmVhbS1qc29uJyB8fCBmbXQgPT09ICdqc29uJykge1xuICAgICAgICAgIG9wdGlvbnMuanNvbiA9IHRydWVcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChhcmcgPT09ICctLW1vZGVsJyAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG4gICAgICAgIG9wdGlvbnMubW9kZWwgPSBhcmdzWysraV1cbiAgICAgIH0gZWxzZSBpZiAoYXJnID09PSAnLS1jb250ZXh0JyAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG4gICAgICAgIG9wdGlvbnMuY29udGV4dCA9IGFyZ3NbKytpXVxuICAgICAgfSBlbHNlIGlmIChhcmcgPT09ICctLWNvbnRleHQtdGV4dCcgJiYgaSArIDEgPCBhcmdzLmxlbmd0aCkge1xuICAgICAgICBvcHRpb25zLmNvbnRleHRUZXh0ID0gYXJnc1srK2ldXG4gICAgICB9IGVsc2UgaWYgKGFyZyA9PT0gJy0tYXV0bycpIHtcbiAgICAgICAgb3B0aW9ucy5hdXRvID0gdHJ1ZVxuICAgICAgfSBlbHNlIGlmIChhcmcgPT09ICctLXZlcmJvc2UnKSB7XG4gICAgICAgIG9wdGlvbnMudmVyYm9zZSA9IHRydWVcbiAgICAgIH0gZWxzZSBpZiAoYXJnID09PSAnLS1tYXgtcmVzdGFydHMnICYmIGkgKyAxIDwgYXJncy5sZW5ndGgpIHtcbiAgICAgICAgb3B0aW9ucy5tYXhSZXN0YXJ0cyA9IHBhcnNlSW50KGFyZ3NbKytpXSwgMTApXG4gICAgICB9IGVsc2UgaWYgKGFyZyA9PT0gJy0tYW5zd2VycycgJiYgaSArIDEgPCBhcmdzLmxlbmd0aCkge1xuICAgICAgICBvcHRpb25zLmFuc3dlcnMgPSBhcmdzWysraV1cbiAgICAgIH0gZWxzZSBpZiAoYXJnID09PSAnLS1ldmVudHMnICYmIGkgKyAxIDwgYXJncy5sZW5ndGgpIHtcbiAgICAgICAgb3B0aW9ucy5ldmVudEZpbHRlciA9IG5ldyBTZXQoYXJnc1srK2ldLnNwbGl0KCcsJykpXG4gICAgICAgIG9wdGlvbnMuanNvbiA9IHRydWVcbiAgICAgICAgaWYgKG9wdGlvbnMub3V0cHV0Rm9ybWF0ID09PSAndGV4dCcpIHtcbiAgICAgICAgICBvcHRpb25zLm91dHB1dEZvcm1hdCA9ICdzdHJlYW0tanNvbidcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChhcmcgPT09ICctLXN1cGVydmlzZWQnKSB7XG4gICAgICAgIG9wdGlvbnMuc3VwZXJ2aXNlZCA9IHRydWVcbiAgICAgICAgb3B0aW9ucy5qc29uID0gdHJ1ZVxuICAgICAgICBpZiAob3B0aW9ucy5vdXRwdXRGb3JtYXQgPT09ICd0ZXh0Jykge1xuICAgICAgICAgIG9wdGlvbnMub3V0cHV0Rm9ybWF0ID0gJ3N0cmVhbS1qc29uJ1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGFyZyA9PT0gJy0tcmVzcG9uc2UtdGltZW91dCcgJiYgaSArIDEgPCBhcmdzLmxlbmd0aCkge1xuICAgICAgICBvcHRpb25zLnJlc3BvbnNlVGltZW91dCA9IHBhcnNlSW50KGFyZ3NbKytpXSwgMTApXG4gICAgICB9IGVsc2UgaWYgKGFyZyA9PT0gJy0tcmVzdW1lJyAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG4gICAgICAgIG9wdGlvbnMucmVzdW1lU2Vzc2lvbiA9IGFyZ3NbKytpXVxuICAgICAgfSBlbHNlIGlmIChhcmcgPT09ICctLWJhcmUnKSB7XG4gICAgICAgIG9wdGlvbnMuYmFyZSA9IHRydWVcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKG9wdGlvbnMuY29tbWFuZCA9PT0gJ2F1dG8nKSB7XG4gICAgICBvcHRpb25zLmNvbW1hbmQgPSBhcmdcbiAgICB9IGVsc2Uge1xuICAgICAgb3B0aW9ucy5jb21tYW5kQXJncy5wdXNoKGFyZylcbiAgICB9XG4gIH1cblxuICByZXR1cm4gb3B0aW9uc1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgLS1vdXRwdXQtZm9ybWF0IGZsYWcgcGFyc2luZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnLS1vdXRwdXQtZm9ybWF0IHRleHQgc2V0cyBvdXRwdXRGb3JtYXQgdG8gdGV4dCcsICgpID0+IHtcbiAgY29uc3Qgb3B0cyA9IHBhcnNlSGVhZGxlc3NBcmdzKFsnbm9kZScsICdnc2QnLCAnaGVhZGxlc3MnLCAnLS1vdXRwdXQtZm9ybWF0JywgJ3RleHQnLCAnYXV0byddKVxuICBhc3NlcnQuZXF1YWwob3B0cy5vdXRwdXRGb3JtYXQsICd0ZXh0JylcbiAgYXNzZXJ0LmVxdWFsKG9wdHMuanNvbiwgZmFsc2UpXG59KVxuXG50ZXN0KCctLW91dHB1dC1mb3JtYXQganNvbiBzZXRzIG91dHB1dEZvcm1hdCB0byBqc29uIGFuZCBqc29uPXRydWUnLCAoKSA9PiB7XG4gIGNvbnN0IG9wdHMgPSBwYXJzZUhlYWRsZXNzQXJncyhbJ25vZGUnLCAnZ3NkJywgJ2hlYWRsZXNzJywgJy0tb3V0cHV0LWZvcm1hdCcsICdqc29uJywgJ2F1dG8nXSlcbiAgYXNzZXJ0LmVxdWFsKG9wdHMub3V0cHV0Rm9ybWF0LCAnanNvbicpXG4gIGFzc2VydC5lcXVhbChvcHRzLmpzb24sIHRydWUpXG59KVxuXG50ZXN0KCctLW91dHB1dC1mb3JtYXQgc3RyZWFtLWpzb24gc2V0cyBvdXRwdXRGb3JtYXQgdG8gc3RyZWFtLWpzb24gYW5kIGpzb249dHJ1ZScsICgpID0+IHtcbiAgY29uc3Qgb3B0cyA9IHBhcnNlSGVhZGxlc3NBcmdzKFsnbm9kZScsICdnc2QnLCAnaGVhZGxlc3MnLCAnLS1vdXRwdXQtZm9ybWF0JywgJ3N0cmVhbS1qc29uJywgJ2F1dG8nXSlcbiAgYXNzZXJ0LmVxdWFsKG9wdHMub3V0cHV0Rm9ybWF0LCAnc3RyZWFtLWpzb24nKVxuICBhc3NlcnQuZXF1YWwob3B0cy5qc29uLCB0cnVlKVxufSlcblxudGVzdCgnZGVmYXVsdCBvdXRwdXQgZm9ybWF0IGlzIHRleHQnLCAoKSA9PiB7XG4gIGNvbnN0IG9wdHMgPSBwYXJzZUhlYWRsZXNzQXJncyhbJ25vZGUnLCAnZ3NkJywgJ2hlYWRsZXNzJywgJ2F1dG8nXSlcbiAgYXNzZXJ0LmVxdWFsKG9wdHMub3V0cHV0Rm9ybWF0LCAndGV4dCcpXG4gIGFzc2VydC5lcXVhbChvcHRzLmpzb24sIGZhbHNlKVxufSlcblxudGVzdCgnaW52YWxpZCAtLW91dHB1dC1mb3JtYXQgdmFsdWUgdGhyb3dzJywgKCkgPT4ge1xuICBhc3NlcnQudGhyb3dzKFxuICAgICgpID0+IHBhcnNlSGVhZGxlc3NBcmdzKFsnbm9kZScsICdnc2QnLCAnaGVhZGxlc3MnLCAnLS1vdXRwdXQtZm9ybWF0JywgJ3lhbWwnLCAnYXV0byddKSxcbiAgICAvSW52YWxpZCBvdXRwdXQgZm9ybWF0OiB5YW1sLyxcbiAgKVxufSlcblxudGVzdCgnaW52YWxpZCAtLW91dHB1dC1mb3JtYXQgdmFsdWUgKGVtcHR5KSB0aHJvd3MnLCAoKSA9PiB7XG4gIGFzc2VydC50aHJvd3MoXG4gICAgKCkgPT4gcGFyc2VIZWFkbGVzc0FyZ3MoWydub2RlJywgJ2dzZCcsICdoZWFkbGVzcycsICctLW91dHB1dC1mb3JtYXQnLCAneG1sJywgJ2F1dG8nXSksXG4gICAgL0ludmFsaWQgb3V0cHV0IGZvcm1hdC8sXG4gIClcbn0pXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCAtLWpzb24gYmFja3dhcmQgY29tcGF0aWJpbGl0eSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnLS1qc29uIGlzIGFsaWFzIGZvciAtLW91dHB1dC1mb3JtYXQgc3RyZWFtLWpzb24nLCAoKSA9PiB7XG4gIGNvbnN0IG9wdHMgPSBwYXJzZUhlYWRsZXNzQXJncyhbJ25vZGUnLCAnZ3NkJywgJ2hlYWRsZXNzJywgJy0tanNvbicsICdhdXRvJ10pXG4gIGFzc2VydC5lcXVhbChvcHRzLm91dHB1dEZvcm1hdCwgJ3N0cmVhbS1qc29uJylcbiAgYXNzZXJ0LmVxdWFsKG9wdHMuanNvbiwgdHJ1ZSlcbn0pXG5cbnRlc3QoJy0tanNvbiBiZWZvcmUgLS1vdXRwdXQtZm9ybWF0IGpzb246IGxhc3Qgd3JpdGVyIHdpbnMnLCAoKSA9PiB7XG4gIGNvbnN0IG9wdHMgPSBwYXJzZUhlYWRsZXNzQXJncyhbJ25vZGUnLCAnZ3NkJywgJ2hlYWRsZXNzJywgJy0tanNvbicsICctLW91dHB1dC1mb3JtYXQnLCAnanNvbicsICdhdXRvJ10pXG4gIGFzc2VydC5lcXVhbChvcHRzLm91dHB1dEZvcm1hdCwgJ2pzb24nKVxuICBhc3NlcnQuZXF1YWwob3B0cy5qc29uLCB0cnVlKVxufSlcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIC0tcmVzdW1lIGZsYWcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJy0tcmVzdW1lIHBhcnNlcyBzZXNzaW9uIElEJywgKCkgPT4ge1xuICBjb25zdCBvcHRzID0gcGFyc2VIZWFkbGVzc0FyZ3MoWydub2RlJywgJ2dzZCcsICdoZWFkbGVzcycsICctLXJlc3VtZScsICdhYmMtMTIzJywgJ2F1dG8nXSlcbiAgYXNzZXJ0LmVxdWFsKG9wdHMucmVzdW1lU2Vzc2lvbiwgJ2FiYy0xMjMnKVxuICBhc3NlcnQuZXF1YWwob3B0cy5jb21tYW5kLCAnYXV0bycpXG59KVxuXG50ZXN0KCdubyAtLXJlc3VtZSBtZWFucyB1bmRlZmluZWQnLCAoKSA9PiB7XG4gIGNvbnN0IG9wdHMgPSBwYXJzZUhlYWRsZXNzQXJncyhbJ25vZGUnLCAnZ3NkJywgJ2hlYWRsZXNzJywgJ2F1dG8nXSlcbiAgYXNzZXJ0LmVxdWFsKG9wdHMucmVzdW1lU2Vzc2lvbiwgdW5kZWZpbmVkKVxufSlcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEV4aXQgY29kZSBjb25zdGFudHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoJ0VYSVRfU1VDQ0VTUyBpcyAwJywgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoRVhJVF9TVUNDRVNTLCAwKVxufSlcblxudGVzdCgnRVhJVF9FUlJPUiBpcyAxJywgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoRVhJVF9FUlJPUiwgMSlcbn0pXG5cbnRlc3QoJ0VYSVRfQkxPQ0tFRCBpcyAxMCcsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKEVYSVRfQkxPQ0tFRCwgMTApXG59KVxuXG50ZXN0KCdFWElUX0NBTkNFTExFRCBpcyAxMScsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKEVYSVRfQ0FOQ0VMTEVELCAxMSlcbn0pXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBtYXBTdGF0dXNUb0V4aXRDb2RlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KCdtYXBTdGF0dXNUb0V4aXRDb2RlOiBzdWNjZXNzIFx1MjE5MiAwJywgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwobWFwU3RhdHVzVG9FeGl0Q29kZSgnc3VjY2VzcycpLCBFWElUX1NVQ0NFU1MpXG59KVxuXG50ZXN0KCdtYXBTdGF0dXNUb0V4aXRDb2RlOiBjb21wbGV0ZSBcdTIxOTIgMCcsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKG1hcFN0YXR1c1RvRXhpdENvZGUoJ2NvbXBsZXRlJyksIEVYSVRfU1VDQ0VTUylcbn0pXG5cbnRlc3QoJ21hcFN0YXR1c1RvRXhpdENvZGU6IGVycm9yIFx1MjE5MiAxJywgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwobWFwU3RhdHVzVG9FeGl0Q29kZSgnZXJyb3InKSwgRVhJVF9FUlJPUilcbn0pXG5cbnRlc3QoJ21hcFN0YXR1c1RvRXhpdENvZGU6IHRpbWVvdXQgXHUyMTkyIDEnLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChtYXBTdGF0dXNUb0V4aXRDb2RlKCd0aW1lb3V0JyksIEVYSVRfRVJST1IpXG59KVxuXG50ZXN0KCdtYXBTdGF0dXNUb0V4aXRDb2RlOiBibG9ja2VkIFx1MjE5MiAxMCcsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKG1hcFN0YXR1c1RvRXhpdENvZGUoJ2Jsb2NrZWQnKSwgRVhJVF9CTE9DS0VEKVxufSlcblxudGVzdCgnbWFwU3RhdHVzVG9FeGl0Q29kZTogY2FuY2VsbGVkIFx1MjE5MiAxMScsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKG1hcFN0YXR1c1RvRXhpdENvZGUoJ2NhbmNlbGxlZCcpLCBFWElUX0NBTkNFTExFRClcbn0pXG5cbnRlc3QoJ21hcFN0YXR1c1RvRXhpdENvZGU6IHVua25vd24gc3RhdHVzIGRlZmF1bHRzIHRvIEVYSVRfRVJST1InLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChtYXBTdGF0dXNUb0V4aXRDb2RlKCd1bmtub3duJyksIEVYSVRfRVJST1IpXG4gIGFzc2VydC5lcXVhbChtYXBTdGF0dXNUb0V4aXRDb2RlKCcnKSwgRVhJVF9FUlJPUilcbn0pXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWFkbGVzc0pzb25SZXN1bHQgdHlwZSBzaGFwZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnSGVhZGxlc3NKc29uUmVzdWx0IHNhdGlzZmllcyBleHBlY3RlZCBzaGFwZScsICgpID0+IHtcbiAgLy8gVHlwZS1sZXZlbCBhc3NlcnRpb246IGNvbnN0cnVjdCBhIHZhbGlkIG9iamVjdCBhbmQgdmVyaWZ5IGl0IGNvbXBpbGVzLlxuICAvLyBBdCBydW50aW1lLCB2ZXJpZnkgYWxsIHJlcXVpcmVkIGtleXMgZXhpc3QuXG4gIGNvbnN0IHJlc3VsdDogSGVhZGxlc3NKc29uUmVzdWx0ID0ge1xuICAgIHN0YXR1czogJ3N1Y2Nlc3MnLFxuICAgIGV4aXRDb2RlOiAwLFxuICAgIGR1cmF0aW9uOiAxMjM0NSxcbiAgICBjb3N0OiB7IHRvdGFsOiAwLjA1LCBpbnB1dF90b2tlbnM6IDEwMDAsIG91dHB1dF90b2tlbnM6IDUwMCwgY2FjaGVfcmVhZF90b2tlbnM6IDIwMCwgY2FjaGVfd3JpdGVfdG9rZW5zOiAxMDAgfSxcbiAgICB0b29sQ2FsbHM6IDE1LFxuICAgIGV2ZW50czogNDIsXG4gIH1cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGF0dXMsICdzdWNjZXNzJylcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5leGl0Q29kZSwgMClcbiAgYXNzZXJ0LmVxdWFsKHR5cGVvZiByZXN1bHQuZHVyYXRpb24sICdudW1iZXInKVxuICBhc3NlcnQub2socmVzdWx0LmNvc3QpXG4gIGFzc2VydC5lcXVhbCh0eXBlb2YgcmVzdWx0LmNvc3QudG90YWwsICdudW1iZXInKVxuICBhc3NlcnQuZXF1YWwodHlwZW9mIHJlc3VsdC5jb3N0LmlucHV0X3Rva2VucywgJ251bWJlcicpXG4gIGFzc2VydC5lcXVhbCh0eXBlb2YgcmVzdWx0LmNvc3Qub3V0cHV0X3Rva2VucywgJ251bWJlcicpXG4gIGFzc2VydC5lcXVhbCh0eXBlb2YgcmVzdWx0LmNvc3QuY2FjaGVfcmVhZF90b2tlbnMsICdudW1iZXInKVxuICBhc3NlcnQuZXF1YWwodHlwZW9mIHJlc3VsdC5jb3N0LmNhY2hlX3dyaXRlX3Rva2VucywgJ251bWJlcicpXG4gIGFzc2VydC5lcXVhbCh0eXBlb2YgcmVzdWx0LnRvb2xDYWxscywgJ251bWJlcicpXG4gIGFzc2VydC5lcXVhbCh0eXBlb2YgcmVzdWx0LmV2ZW50cywgJ251bWJlcicpXG59KVxuXG50ZXN0KCdIZWFkbGVzc0pzb25SZXN1bHQgYWNjZXB0cyBvcHRpb25hbCBmaWVsZHMnLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdDogSGVhZGxlc3NKc29uUmVzdWx0ID0ge1xuICAgIHN0YXR1czogJ2Jsb2NrZWQnLFxuICAgIGV4aXRDb2RlOiAxMCxcbiAgICBzZXNzaW9uSWQ6ICdzZXNzLWFiYycsXG4gICAgZHVyYXRpb246IDUwMDAsXG4gICAgY29zdDogeyB0b3RhbDogMCwgaW5wdXRfdG9rZW5zOiAwLCBvdXRwdXRfdG9rZW5zOiAwLCBjYWNoZV9yZWFkX3Rva2VuczogMCwgY2FjaGVfd3JpdGVfdG9rZW5zOiAwIH0sXG4gICAgdG9vbENhbGxzOiAwLFxuICAgIGV2ZW50czogMSxcbiAgICBtaWxlc3RvbmU6ICdNMDAxJyxcbiAgICBwaGFzZTogJ3BsYW5uaW5nJyxcbiAgICBuZXh0QWN0aW9uOiAnZml4IGJsb2NrZXInLFxuICAgIGFydGlmYWN0czogWydST0FETUFQLm1kJ10sXG4gICAgY29tbWl0czogWydhYmMxMjM0J10sXG4gIH1cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zZXNzaW9uSWQsICdzZXNzLWFiYycpXG4gIGFzc2VydC5lcXVhbChyZXN1bHQubWlsZXN0b25lLCAnTTAwMScpXG4gIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LmFydGlmYWN0cywgWydST0FETUFQLm1kJ10pXG4gIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LmNvbW1pdHMsIFsnYWJjMTIzNCddKVxufSlcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFZBTElEX09VVFBVVF9GT1JNQVRTIHNldCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnVkFMSURfT1VUUFVUX0ZPUk1BVFMgY29udGFpbnMgZXhhY3RseSB0ZXh0LCBqc29uLCBzdHJlYW0tanNvbicsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKFZBTElEX09VVFBVVF9GT1JNQVRTLnNpemUsIDMpXG4gIGFzc2VydC5vayhWQUxJRF9PVVRQVVRfRk9STUFUUy5oYXMoJ3RleHQnKSlcbiAgYXNzZXJ0Lm9rKFZBTElEX09VVFBVVF9GT1JNQVRTLmhhcygnanNvbicpKVxuICBhc3NlcnQub2soVkFMSURfT1VUUFVUX0ZPUk1BVFMuaGFzKCdzdHJlYW0tanNvbicpKVxufSlcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJlZ3Jlc3Npb246IGV4aXN0aW5nIGZsYWdzIHN0aWxsIHBhcnNlIGNvcnJlY3RseSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnLS1ldmVudHMgc3RpbGwgd29ya3Mgd2l0aCBuZXcgb3V0cHV0Rm9ybWF0IGRlZmF1bHQnLCAoKSA9PiB7XG4gIGNvbnN0IG9wdHMgPSBwYXJzZUhlYWRsZXNzQXJncyhbJ25vZGUnLCAnZ3NkJywgJ2hlYWRsZXNzJywgJy0tZXZlbnRzJywgJ2FnZW50X2VuZCx0b29sX2V4ZWN1dGlvbl9zdGFydCcsICdhdXRvJ10pXG4gIGFzc2VydC5vayhvcHRzLmV2ZW50RmlsdGVyIGluc3RhbmNlb2YgU2V0KVxuICBhc3NlcnQuZXF1YWwob3B0cy5ldmVudEZpbHRlciEuc2l6ZSwgMilcbiAgYXNzZXJ0LmVxdWFsKG9wdHMuanNvbiwgdHJ1ZSlcbiAgYXNzZXJ0LmVxdWFsKG9wdHMub3V0cHV0Rm9ybWF0LCAnc3RyZWFtLWpzb24nKVxufSlcblxudGVzdCgnLS10aW1lb3V0IHN0aWxsIHdvcmtzJywgKCkgPT4ge1xuICBjb25zdCBvcHRzID0gcGFyc2VIZWFkbGVzc0FyZ3MoWydub2RlJywgJ2dzZCcsICdoZWFkbGVzcycsICctLXRpbWVvdXQnLCAnNjAwMDAnLCAnYXV0byddKVxuICBhc3NlcnQuZXF1YWwob3B0cy50aW1lb3V0LCA2MDAwMClcbn0pXG5cbnRlc3QoJy0tc3VwZXJ2aXNlZCBzdGlsbCB3b3JrcyBhbmQgaW1wbGllcyBzdHJlYW0tanNvbicsICgpID0+IHtcbiAgY29uc3Qgb3B0cyA9IHBhcnNlSGVhZGxlc3NBcmdzKFsnbm9kZScsICdnc2QnLCAnaGVhZGxlc3MnLCAnLS1zdXBlcnZpc2VkJywgJ2F1dG8nXSlcbiAgYXNzZXJ0LmVxdWFsKG9wdHMuc3VwZXJ2aXNlZCwgdHJ1ZSlcbiAgYXNzZXJ0LmVxdWFsKG9wdHMuanNvbiwgdHJ1ZSlcbiAgYXNzZXJ0LmVxdWFsKG9wdHMub3V0cHV0Rm9ybWF0LCAnc3RyZWFtLWpzb24nKVxufSlcblxudGVzdCgnLS1hbnN3ZXJzIHN0aWxsIHdvcmtzJywgKCkgPT4ge1xuICBjb25zdCBvcHRzID0gcGFyc2VIZWFkbGVzc0FyZ3MoWydub2RlJywgJ2dzZCcsICdoZWFkbGVzcycsICctLWFuc3dlcnMnLCAnYW5zd2Vycy5qc29uJywgJ2F1dG8nXSlcbiAgYXNzZXJ0LmVxdWFsKG9wdHMuYW5zd2VycywgJ2Fuc3dlcnMuanNvbicpXG59KVxuXG50ZXN0KCdwb3NpdGlvbmFsIGNvbW1hbmQgcGFyc2luZyBzdGlsbCB3b3JrcycsICgpID0+IHtcbiAgY29uc3Qgb3B0cyA9IHBhcnNlSGVhZGxlc3NBcmdzKFsnbm9kZScsICdnc2QnLCAnaGVhZGxlc3MnLCAnbmV4dCddKVxuICBhc3NlcnQuZXF1YWwob3B0cy5jb21tYW5kLCAnbmV4dCcpXG59KVxuXG50ZXN0KCdjb21iaW5lZCBmbGFncyBwYXJzZSBjb3JyZWN0bHknLCAoKSA9PiB7XG4gIGNvbnN0IG9wdHMgPSBwYXJzZUhlYWRsZXNzQXJncyhbXG4gICAgJ25vZGUnLCAnZ3NkJywgJ2hlYWRsZXNzJyxcbiAgICAnLS1vdXRwdXQtZm9ybWF0JywgJ2pzb24nLFxuICAgICctLXRpbWVvdXQnLCAnMTIwMDAwJyxcbiAgICAnLS1yZXN1bWUnLCAnc2Vzcy14eXonLFxuICAgICctLXZlcmJvc2UnLFxuICAgICdhdXRvJyxcbiAgXSlcbiAgYXNzZXJ0LmVxdWFsKG9wdHMub3V0cHV0Rm9ybWF0LCAnanNvbicpXG4gIGFzc2VydC5lcXVhbChvcHRzLmpzb24sIHRydWUpXG4gIGFzc2VydC5lcXVhbChvcHRzLnRpbWVvdXQsIDEyMDAwMClcbiAgYXNzZXJ0LmVxdWFsKG9wdHMucmVzdW1lU2Vzc2lvbiwgJ3Nlc3MteHl6JylcbiAgYXNzZXJ0LmVxdWFsKG9wdHMudmVyYm9zZSwgdHJ1ZSlcbiAgYXNzZXJ0LmVxdWFsKG9wdHMuY29tbWFuZCwgJ2F1dG8nKVxufSlcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIC0tYmFyZSBmbGFnIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KCctLWJhcmUgc2V0cyBiYXJlIHRvIHRydWUnLCAoKSA9PiB7XG4gIGNvbnN0IG9wdHMgPSBwYXJzZUhlYWRsZXNzQXJncyhbJ25vZGUnLCAnZ3NkJywgJ2hlYWRsZXNzJywgJy0tYmFyZScsICdhdXRvJ10pXG4gIGFzc2VydC5lcXVhbChvcHRzLmJhcmUsIHRydWUpXG4gIGFzc2VydC5lcXVhbChvcHRzLmNvbW1hbmQsICdhdXRvJylcbn0pXG5cbnRlc3QoJ25vIC0tYmFyZSBtZWFucyBiYXJlIGlzIHVuZGVmaW5lZCcsICgpID0+IHtcbiAgY29uc3Qgb3B0cyA9IHBhcnNlSGVhZGxlc3NBcmdzKFsnbm9kZScsICdnc2QnLCAnaGVhZGxlc3MnLCAnYXV0byddKVxuICBhc3NlcnQuZXF1YWwob3B0cy5iYXJlLCB1bmRlZmluZWQpXG59KVxuXG50ZXN0KCctLWJhcmUgaXMgYSBib29sZWFuIGZsYWcgKG5vIHZhbHVlIG5lZWRlZCknLCAoKSA9PiB7XG4gIGNvbnN0IG9wdHMgPSBwYXJzZUhlYWRsZXNzQXJncyhbJ25vZGUnLCAnZ3NkJywgJ2hlYWRsZXNzJywgJy0tYmFyZScsICctLWpzb24nLCAnYXV0byddKVxuICBhc3NlcnQuZXF1YWwob3B0cy5iYXJlLCB0cnVlKVxuICBhc3NlcnQuZXF1YWwob3B0cy5qc29uLCB0cnVlKVxufSlcblxudGVzdCgnLS1iYXJlIGNvbWJpbmVkIHdpdGggLS1vdXRwdXQtZm9ybWF0IGpzb24nLCAoKSA9PiB7XG4gIGNvbnN0IG9wdHMgPSBwYXJzZUhlYWRsZXNzQXJncyhbXG4gICAgJ25vZGUnLCAnZ3NkJywgJ2hlYWRsZXNzJyxcbiAgICAnLS1iYXJlJyxcbiAgICAnLS1vdXRwdXQtZm9ybWF0JywgJ2pzb24nLFxuICAgICdhdXRvJyxcbiAgXSlcbiAgYXNzZXJ0LmVxdWFsKG9wdHMuYmFyZSwgdHJ1ZSlcbiAgYXNzZXJ0LmVxdWFsKG9wdHMub3V0cHV0Rm9ybWF0LCAnanNvbicpXG4gIGFzc2VydC5lcXVhbChvcHRzLmpzb24sIHRydWUpXG4gIGFzc2VydC5lcXVhbChvcHRzLmNvbW1hbmQsICdhdXRvJylcbn0pXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDb21tYW5kLWZpcnN0IG9yZGVyaW5nIChmbGFncyBhZnRlciBjb21tYW5kKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdCgnY29tbWFuZCBiZWZvcmUgZmxhZ3M6IG5ldy1taWxlc3RvbmUgLS1jb250ZXh0LXRleHQgLS1hdXRvIC0tdmVyYm9zZScsICgpID0+IHtcbiAgY29uc3Qgb3B0cyA9IHBhcnNlSGVhZGxlc3NBcmdzKFtcbiAgICAnbm9kZScsICdnc2QnLCAnaGVhZGxlc3MnLFxuICAgICduZXctbWlsZXN0b25lJyxcbiAgICAnLS1jb250ZXh0LXRleHQnLCAnYnVpbGQgc29tZXRoaW5nIGNvb2wnLFxuICAgICctLWF1dG8nLFxuICAgICctLXZlcmJvc2UnLFxuICBdKVxuICBhc3NlcnQuZXF1YWwob3B0cy5jb21tYW5kLCAnbmV3LW1pbGVzdG9uZScpXG4gIGFzc2VydC5lcXVhbChvcHRzLmNvbnRleHRUZXh0LCAnYnVpbGQgc29tZXRoaW5nIGNvb2wnKVxuICBhc3NlcnQuZXF1YWwob3B0cy5hdXRvLCB0cnVlKVxuICBhc3NlcnQuZXF1YWwob3B0cy52ZXJib3NlLCB0cnVlKVxufSlcblxudGVzdCgnY29tbWFuZCBiZWZvcmUgZmxhZ3M6IG5leHQgLS1qc29uIC0tdGltZW91dCcsICgpID0+IHtcbiAgY29uc3Qgb3B0cyA9IHBhcnNlSGVhZGxlc3NBcmdzKFtcbiAgICAnbm9kZScsICdnc2QnLCAnaGVhZGxlc3MnLFxuICAgICduZXh0JyxcbiAgICAnLS1qc29uJyxcbiAgICAnLS10aW1lb3V0JywgJzYwMDAwJyxcbiAgXSlcbiAgYXNzZXJ0LmVxdWFsKG9wdHMuY29tbWFuZCwgJ25leHQnKVxuICBhc3NlcnQuZXF1YWwob3B0cy5qc29uLCB0cnVlKVxuICBhc3NlcnQuZXF1YWwob3B0cy50aW1lb3V0LCA2MDAwMClcbn0pXG5cbnRlc3QoJ2NvbW1hbmQgYmV0d2VlbiBmbGFnczogLS1hdXRvIG5ldy1taWxlc3RvbmUgLS12ZXJib3NlJywgKCkgPT4ge1xuICBjb25zdCBvcHRzID0gcGFyc2VIZWFkbGVzc0FyZ3MoW1xuICAgICdub2RlJywgJ2dzZCcsICdoZWFkbGVzcycsXG4gICAgJy0tYXV0bycsXG4gICAgJ25ldy1taWxlc3RvbmUnLFxuICAgICctLXZlcmJvc2UnLFxuICBdKVxuICBhc3NlcnQuZXF1YWwob3B0cy5jb21tYW5kLCAnbmV3LW1pbGVzdG9uZScpXG4gIGFzc2VydC5lcXVhbChvcHRzLmF1dG8sIHRydWUpXG4gIGFzc2VydC5lcXVhbChvcHRzLnZlcmJvc2UsIHRydWUpXG59KVxuXG50ZXN0KCctLWJhcmUgZG9lcyBub3QgYWZmZWN0IG90aGVyIGZsYWdzJywgKCkgPT4ge1xuICBjb25zdCBvcHRzID0gcGFyc2VIZWFkbGVzc0FyZ3MoW1xuICAgICdub2RlJywgJ2dzZCcsICdoZWFkbGVzcycsXG4gICAgJy0tYmFyZScsXG4gICAgJy0tdGltZW91dCcsICc2MDAwMCcsXG4gICAgJy0tcmVzdW1lJywgJ3Nlc3MtYWJjJyxcbiAgICAnYXV0bycsXG4gIF0pXG4gIGFzc2VydC5lcXVhbChvcHRzLmJhcmUsIHRydWUpXG4gIGFzc2VydC5lcXVhbChvcHRzLnRpbWVvdXQsIDYwMDAwKVxuICBhc3NlcnQuZXF1YWwob3B0cy5yZXN1bWVTZXNzaW9uLCAnc2Vzcy1hYmMnKVxuICBhc3NlcnQuZXF1YWwob3B0cy5jb21tYW5kLCAnYXV0bycpXG59KVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBUUEsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUluQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUdQLFNBQVMsNEJBQTRCO0FBd0JyQyxTQUFTLGtCQUFrQixNQUFpQztBQUMxRCxRQUFNLFVBQTJCO0FBQUEsSUFDL0IsU0FBUztBQUFB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
