import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { showInterviewRound } from "../interview-ui.js";
const ENTER = "\r";
const DOWN = "\x1B[B";
const TAB = "	";
function runWithInputs(questions, inputs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out \u2014 likely stuck in infinite loop")), 3e3);
    const mockCtx = {
      ui: {
        custom: (factory) => {
          const mockTui = {
            requestRender: () => {
            }
          };
          const mockTheme = {
            // Minimal theme stubs — render output is not asserted
            fg: (_c, t) => t,
            bold: (t) => t,
            dim: (t) => t,
            italic: (t) => t,
            strikethrough: (t) => t,
            accent: (t) => t,
            success: (t) => t,
            warning: (t) => t,
            error: (t) => t,
            info: (t) => t,
            muted: (t) => t,
            dimmed: (t) => t
          };
          const mockKb = {};
          const widget = factory(mockTui, mockTheme, mockKb, (result) => {
            clearTimeout(timeout);
            resolve(result);
          });
          for (const input of inputs) {
            widget.handleInput(input);
          }
        }
      }
    };
    showInterviewRound(questions, {}, mockCtx).catch(reject);
  });
}
describe("interview-ui notes loop regression (#3502)", () => {
  const questions = [
    {
      id: "q1",
      header: "Project Type",
      question: "What type of project?",
      options: [
        { label: "Web App", description: "Frontend or full-stack" },
        { label: "CLI Tool", description: "Command-line utility" }
      ]
    }
  ];
  it("does not loop when Enter is pressed after typing a note on 'None of the above'", async () => {
    const result = await runWithInputs(questions, [
      DOWN,
      // cursor → index 1 (CLI Tool)
      DOWN,
      // cursor → index 2 (None of the above)
      ENTER,
      // commit → auto-opens notes field
      "u",
      "n",
      "s",
      "u",
      "r",
      "e",
      // type "unsure"
      ENTER,
      // should advance to review, NOT reopen notes
      ENTER
      // submit from review screen
    ]);
    assert.ok(result, "should return a result");
    assert.equal(result.endInterview, false);
    const answer = result.answers.q1;
    assert.ok(answer, "answer for q1 should exist");
    assert.equal(answer.notes, "unsure", "notes should contain typed text");
    assert.equal(answer.selected, "None of the above");
  });
  it("Enter on empty notes advances instead of re-opening (notesVisible guard)", async () => {
    const result = await runWithInputs(questions, [
      DOWN,
      // cursor → 1
      DOWN,
      // cursor → 2 (None of the above)
      ENTER,
      // commit → auto-opens notes (notesVisible = true)
      ENTER,
      // empty notes → notesVisible prevents re-open → advances to review
      ENTER
      // submit from review screen
    ]);
    assert.ok(result, "should return a result");
    const answer = result.answers.q1;
    assert.ok(answer, "answer for q1 should exist");
    assert.equal(answer.notes, "");
  });
  it("normal option selection is unaffected", async () => {
    const result = await runWithInputs(questions, [
      ENTER,
      // select first option (Web App) and advance to review
      ENTER
      // submit from review screen
    ]);
    assert.ok(result, "should return a result");
    const answer = result.answers.q1;
    assert.ok(answer, "answer for q1 should exist");
    assert.equal(answer.selected, "Web App");
  });
  it("ignores abort signals after a submitted answer", async () => {
    const controller = new AbortController();
    const doneCalls = [];
    let widget;
    const resultPromise = showInterviewRound(questions, { signal: controller.signal }, {
      ui: {
        custom: (factory) => new Promise((resolve) => {
          const mockTui = { requestRender: () => {
          } };
          const mockTheme = {
            fg: (_c, t) => t,
            bold: (t) => t,
            dim: (t) => t,
            italic: (t) => t,
            strikethrough: (t) => t,
            accent: (t) => t,
            success: (t) => t,
            warning: (t) => t,
            error: (t) => t,
            info: (t) => t,
            muted: (t) => t,
            dimmed: (t) => t
          };
          widget = factory(mockTui, mockTheme, {}, (result2) => {
            doneCalls.push(result2);
            resolve(result2);
          });
        })
      }
    });
    assert.ok(widget, "widget should be created synchronously");
    widget.handleInput(ENTER);
    widget.handleInput(ENTER);
    controller.abort();
    const result = await resultPromise;
    assert.equal(doneCalls.length, 1, "abort after submit must not emit a second empty result");
    assert.deepEqual(result.answers.q1, { selected: "Web App", notes: "" });
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3NoYXJlZC90ZXN0cy9pbnRlcnZpZXctbm90ZXMtbG9vcC50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBHU0QyIFx1MjAxNCBSZWdyZXNzaW9uIHRlc3QgZm9yIGludGVydmlldy11aSBcIk5vbmUgb2YgdGhlIGFib3ZlXCIgbm90ZXMgbG9vcFxuLy8gQ29weXJpZ2h0IChjKSAyMDI2IEplcmVteSBNY1NwYWRkZW4gPGplcmVteUBmbHV4bGFicy5uZXQ+XG5cbi8qKlxuICogUmVncmVzc2lvbiB0ZXN0IGZvciBidWcgIzM1MDI6XG4gKlxuICogU2VsZWN0aW5nIFwiTm9uZSBvZiB0aGUgYWJvdmVcIiBvcGVucyB0aGUgbm90ZXMgZmllbGQsIGJ1dCBwcmVzc2luZyBFbnRlclxuICogYWZ0ZXIgdHlwaW5nIGEgbm90ZSBjYWxsZWQgZ29OZXh0T3JTdWJtaXQoKSB3aGljaCBzYXcgdGhlIGN1cnNvciBzdGlsbFxuICogb24gdGhlIFwiTm9uZSBvZiB0aGUgYWJvdmVcIiBzbG90IGFuZCByZS1vcGVuZWQgbm90ZXMgXHUyMDE0IHRyYXBwaW5nIHRoZSB1c2VyXG4gKiBpbiBhbiBpbmZpbml0ZSBsb29wLlxuICpcbiAqIFRoZSBmaXggYWRkcyBhIGAhc3RhdGVzW2N1cnJlbnRJZHhdLm5vdGVzYCBndWFyZCBzbyBhdXRvLW9wZW4gb25seSBmaXJlc1xuICogd2hlbiBub3RlcyBhcmUgc3RpbGwgZW1wdHkuXG4gKi9cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBzaG93SW50ZXJ2aWV3Um91bmQsIHR5cGUgUXVlc3Rpb24sIHR5cGUgUm91bmRSZXN1bHQgfSBmcm9tIFwiLi4vaW50ZXJ2aWV3LXVpLmpzXCI7XG5cbi8vIFJhdyB0ZXJtaW5hbCBzZXF1ZW5jZXMgdGhhdCBtYXRjaGVzS2V5KCkgcmVjb2duaXNlc1xuY29uc3QgRU5URVIgPSBcIlxcclwiO1xuY29uc3QgRE9XTiA9IFwiXFx4MWJbQlwiO1xuY29uc3QgVEFCID0gXCJcXHRcIjtcblxuLyoqXG4gKiBEcml2ZSBzaG93SW50ZXJ2aWV3Um91bmQgd2l0aCBhIHNjcmlwdGVkIHNlcXVlbmNlIG9mIGtleSBpbnB1dHMuXG4gKiBXZSBtb2NrIGN0eC51aS5jdXN0b20oKSB0byBjYXB0dXJlIHRoZSB3aWRnZXQsIGZlZWQgaXQgaW5wdXRzLCBhbmRcbiAqIHJlc29sdmUgd2hlbiBkb25lKCkgaXMgY2FsbGVkLlxuICovXG5mdW5jdGlvbiBydW5XaXRoSW5wdXRzKFxuXHRxdWVzdGlvbnM6IFF1ZXN0aW9uW10sXG5cdGlucHV0czogc3RyaW5nW10sXG4pOiBQcm9taXNlPFJvdW5kUmVzdWx0PiB7XG5cdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0Y29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4gcmVqZWN0KG5ldyBFcnJvcihcIlRpbWVkIG91dCBcdTIwMTQgbGlrZWx5IHN0dWNrIGluIGluZmluaXRlIGxvb3BcIikpLCAzMDAwKTtcblxuXHRcdGNvbnN0IG1vY2tDdHggPSB7XG5cdFx0XHR1aToge1xuXHRcdFx0XHRjdXN0b206IChmYWN0b3J5OiBhbnkpID0+IHtcblx0XHRcdFx0XHRjb25zdCBtb2NrVHVpID0ge1xuXHRcdFx0XHRcdFx0cmVxdWVzdFJlbmRlcjogKCkgPT4ge30sXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRjb25zdCBtb2NrVGhlbWUgPSB7XG5cdFx0XHRcdFx0XHQvLyBNaW5pbWFsIHRoZW1lIHN0dWJzIFx1MjAxNCByZW5kZXIgb3V0cHV0IGlzIG5vdCBhc3NlcnRlZFxuXHRcdFx0XHRcdFx0Zmc6IChfYzogc3RyaW5nLCB0OiBzdHJpbmcpID0+IHQsXG5cdFx0XHRcdFx0XHRib2xkOiAodDogc3RyaW5nKSA9PiB0LFxuXHRcdFx0XHRcdFx0ZGltOiAodDogc3RyaW5nKSA9PiB0LFxuXHRcdFx0XHRcdFx0aXRhbGljOiAodDogc3RyaW5nKSA9PiB0LFxuXHRcdFx0XHRcdFx0c3RyaWtldGhyb3VnaDogKHQ6IHN0cmluZykgPT4gdCxcblx0XHRcdFx0XHRcdGFjY2VudDogKHQ6IHN0cmluZykgPT4gdCxcblx0XHRcdFx0XHRcdHN1Y2Nlc3M6ICh0OiBzdHJpbmcpID0+IHQsXG5cdFx0XHRcdFx0XHR3YXJuaW5nOiAodDogc3RyaW5nKSA9PiB0LFxuXHRcdFx0XHRcdFx0ZXJyb3I6ICh0OiBzdHJpbmcpID0+IHQsXG5cdFx0XHRcdFx0XHRpbmZvOiAodDogc3RyaW5nKSA9PiB0LFxuXHRcdFx0XHRcdFx0bXV0ZWQ6ICh0OiBzdHJpbmcpID0+IHQsXG5cdFx0XHRcdFx0XHRkaW1tZWQ6ICh0OiBzdHJpbmcpID0+IHQsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRjb25zdCBtb2NrS2IgPSB7fTtcblxuXHRcdFx0XHRcdGNvbnN0IHdpZGdldCA9IGZhY3RvcnkobW9ja1R1aSwgbW9ja1RoZW1lLCBtb2NrS2IsIChyZXN1bHQ6IFJvdW5kUmVzdWx0KSA9PiB7XG5cdFx0XHRcdFx0XHRjbGVhclRpbWVvdXQodGltZW91dCk7XG5cdFx0XHRcdFx0XHRyZXNvbHZlKHJlc3VsdCk7XG5cdFx0XHRcdFx0fSk7XG5cblx0XHRcdFx0XHQvLyBGZWVkIGVhY2ggaW5wdXQgc2VxdWVudGlhbGx5XG5cdFx0XHRcdFx0Zm9yIChjb25zdCBpbnB1dCBvZiBpbnB1dHMpIHtcblx0XHRcdFx0XHRcdHdpZGdldC5oYW5kbGVJbnB1dChpbnB1dCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9LFxuXHRcdFx0fSxcblx0XHR9O1xuXG5cdFx0c2hvd0ludGVydmlld1JvdW5kKHF1ZXN0aW9ucywge30sIG1vY2tDdHggYXMgYW55KS5jYXRjaChyZWplY3QpO1xuXHR9KTtcbn1cblxuZGVzY3JpYmUoXCJpbnRlcnZpZXctdWkgbm90ZXMgbG9vcCByZWdyZXNzaW9uICgjMzUwMilcIiwgKCkgPT4ge1xuXHRjb25zdCBxdWVzdGlvbnM6IFF1ZXN0aW9uW10gPSBbXG5cdFx0e1xuXHRcdFx0aWQ6IFwicTFcIixcblx0XHRcdGhlYWRlcjogXCJQcm9qZWN0IFR5cGVcIixcblx0XHRcdHF1ZXN0aW9uOiBcIldoYXQgdHlwZSBvZiBwcm9qZWN0P1wiLFxuXHRcdFx0b3B0aW9uczogW1xuXHRcdFx0XHR7IGxhYmVsOiBcIldlYiBBcHBcIiwgZGVzY3JpcHRpb246IFwiRnJvbnRlbmQgb3IgZnVsbC1zdGFja1wiIH0sXG5cdFx0XHRcdHsgbGFiZWw6IFwiQ0xJIFRvb2xcIiwgZGVzY3JpcHRpb246IFwiQ29tbWFuZC1saW5lIHV0aWxpdHlcIiB9LFxuXHRcdFx0XSxcblx0XHR9LFxuXHRdO1xuXG5cdGl0KFwiZG9lcyBub3QgbG9vcCB3aGVuIEVudGVyIGlzIHByZXNzZWQgYWZ0ZXIgdHlwaW5nIGEgbm90ZSBvbiAnTm9uZSBvZiB0aGUgYWJvdmUnXCIsIGFzeW5jICgpID0+IHtcblx0XHQvLyBXaXRoIDIgb3B0aW9ucywgXCJOb25lIG9mIHRoZSBhYm92ZVwiIGlzIGluZGV4IDIgKDAtYmFzZWQpXG5cdFx0Ly8gQ3Vyc29yIHN0YXJ0cyBhdCAwLCBzbyBwcmVzcyBEb3duIHR3aWNlIHRvIHJlYWNoIGl0XG5cdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuV2l0aElucHV0cyhxdWVzdGlvbnMsIFtcblx0XHRcdERPV04sICAgICAgICAvLyBjdXJzb3IgXHUyMTkyIGluZGV4IDEgKENMSSBUb29sKVxuXHRcdFx0RE9XTiwgICAgICAgIC8vIGN1cnNvciBcdTIxOTIgaW5kZXggMiAoTm9uZSBvZiB0aGUgYWJvdmUpXG5cdFx0XHRFTlRFUiwgICAgICAgLy8gY29tbWl0IFx1MjE5MiBhdXRvLW9wZW5zIG5vdGVzIGZpZWxkXG5cdFx0XHRcInVcIiwgXCJuXCIsIFwic1wiLCBcInVcIiwgXCJyXCIsIFwiZVwiLCAgLy8gdHlwZSBcInVuc3VyZVwiXG5cdFx0XHRFTlRFUiwgICAgICAgLy8gc2hvdWxkIGFkdmFuY2UgdG8gcmV2aWV3LCBOT1QgcmVvcGVuIG5vdGVzXG5cdFx0XHRFTlRFUiwgICAgICAgLy8gc3VibWl0IGZyb20gcmV2aWV3IHNjcmVlblxuXHRcdF0pO1xuXG5cdFx0Ly8gSWYgd2UgZ2V0IGhlcmUsIHRoZSBsb29wIGRpZCBub3Qgb2NjdXIgKHRpbWVvdXQgd291bGQgaGF2ZSBmaXJlZClcblx0XHRhc3NlcnQub2socmVzdWx0LCBcInNob3VsZCByZXR1cm4gYSByZXN1bHRcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHJlc3VsdC5lbmRJbnRlcnZpZXcsIGZhbHNlKTtcblxuXHRcdGNvbnN0IGFuc3dlciA9IHJlc3VsdC5hbnN3ZXJzLnExO1xuXHRcdGFzc2VydC5vayhhbnN3ZXIsIFwiYW5zd2VyIGZvciBxMSBzaG91bGQgZXhpc3RcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGFuc3dlci5ub3RlcywgXCJ1bnN1cmVcIiwgXCJub3RlcyBzaG91bGQgY29udGFpbiB0eXBlZCB0ZXh0XCIpO1xuXHRcdGFzc2VydC5lcXVhbChhbnN3ZXIuc2VsZWN0ZWQsIFwiTm9uZSBvZiB0aGUgYWJvdmVcIik7XG5cdH0pO1xuXG5cdGl0KFwiRW50ZXIgb24gZW1wdHkgbm90ZXMgYWR2YW5jZXMgaW5zdGVhZCBvZiByZS1vcGVuaW5nIChub3Rlc1Zpc2libGUgZ3VhcmQpXCIsIGFzeW5jICgpID0+IHtcblx0XHQvLyBQcmVzcyBEb3duIHR3aWNlIHRvIFwiTm9uZSBvZiB0aGUgYWJvdmVcIiwgRW50ZXIgdG8gc2VsZWN0XG5cdFx0Ly8gVGhlbiBpbW1lZGlhdGVseSBFbnRlciBhZ2FpbiAoZW1wdHkgbm90ZXMpIFx1MjAxNCBub3Rlc1Zpc2libGUgaXMgYWxyZWFkeVxuXHRcdC8vIHRydWUgZnJvbSBhdXRvLW9wZW4sIHNvIHRoZSBndWFyZCBwcmV2ZW50cyByZS1vcGVuaW5nIGFuZCBFbnRlclxuXHRcdC8vIGFkdmFuY2VzIHRvIHJldmlldy4gVGhlIG5vdGVzIHJlbWFpbiBlbXB0eS5cblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBydW5XaXRoSW5wdXRzKHF1ZXN0aW9ucywgW1xuXHRcdFx0RE9XTiwgICAgICAgIC8vIGN1cnNvciBcdTIxOTIgMVxuXHRcdFx0RE9XTiwgICAgICAgIC8vIGN1cnNvciBcdTIxOTIgMiAoTm9uZSBvZiB0aGUgYWJvdmUpXG5cdFx0XHRFTlRFUiwgICAgICAgLy8gY29tbWl0IFx1MjE5MiBhdXRvLW9wZW5zIG5vdGVzIChub3Rlc1Zpc2libGUgPSB0cnVlKVxuXHRcdFx0RU5URVIsICAgICAgIC8vIGVtcHR5IG5vdGVzIFx1MjE5MiBub3Rlc1Zpc2libGUgcHJldmVudHMgcmUtb3BlbiBcdTIxOTIgYWR2YW5jZXMgdG8gcmV2aWV3XG5cdFx0XHRFTlRFUiwgICAgICAgLy8gc3VibWl0IGZyb20gcmV2aWV3IHNjcmVlblxuXHRcdF0pO1xuXG5cdFx0YXNzZXJ0Lm9rKHJlc3VsdCwgXCJzaG91bGQgcmV0dXJuIGEgcmVzdWx0XCIpO1xuXHRcdGNvbnN0IGFuc3dlciA9IHJlc3VsdC5hbnN3ZXJzLnExO1xuXHRcdGFzc2VydC5vayhhbnN3ZXIsIFwiYW5zd2VyIGZvciBxMSBzaG91bGQgZXhpc3RcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKGFuc3dlci5ub3RlcywgXCJcIik7XG5cdH0pO1xuXG5cdGl0KFwibm9ybWFsIG9wdGlvbiBzZWxlY3Rpb24gaXMgdW5hZmZlY3RlZFwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuV2l0aElucHV0cyhxdWVzdGlvbnMsIFtcblx0XHRcdEVOVEVSLCAgICAgICAvLyBzZWxlY3QgZmlyc3Qgb3B0aW9uIChXZWIgQXBwKSBhbmQgYWR2YW5jZSB0byByZXZpZXdcblx0XHRcdEVOVEVSLCAgICAgICAvLyBzdWJtaXQgZnJvbSByZXZpZXcgc2NyZWVuXG5cdFx0XSk7XG5cblx0XHRhc3NlcnQub2socmVzdWx0LCBcInNob3VsZCByZXR1cm4gYSByZXN1bHRcIik7XG5cdFx0Y29uc3QgYW5zd2VyID0gcmVzdWx0LmFuc3dlcnMucTE7XG5cdFx0YXNzZXJ0Lm9rKGFuc3dlciwgXCJhbnN3ZXIgZm9yIHExIHNob3VsZCBleGlzdFwiKTtcblx0XHRhc3NlcnQuZXF1YWwoYW5zd2VyLnNlbGVjdGVkLCBcIldlYiBBcHBcIik7XG5cdH0pO1xuXG5cdGl0KFwiaWdub3JlcyBhYm9ydCBzaWduYWxzIGFmdGVyIGEgc3VibWl0dGVkIGFuc3dlclwiLCBhc3luYyAoKSA9PiB7XG5cdFx0Y29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcblx0XHRjb25zdCBkb25lQ2FsbHM6IFJvdW5kUmVzdWx0W10gPSBbXTtcblx0XHRsZXQgd2lkZ2V0OiB7IGhhbmRsZUlucHV0KGlucHV0OiBzdHJpbmcpOiB2b2lkIH0gfCB1bmRlZmluZWQ7XG5cblx0XHRjb25zdCByZXN1bHRQcm9taXNlID0gc2hvd0ludGVydmlld1JvdW5kKHF1ZXN0aW9ucywgeyBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsIH0sIHtcblx0XHRcdHVpOiB7XG5cdFx0XHRcdGN1c3RvbTogKGZhY3Rvcnk6IGFueSkgPT4gbmV3IFByb21pc2U8Um91bmRSZXN1bHQ+KChyZXNvbHZlKSA9PiB7XG5cdFx0XHRcdFx0Y29uc3QgbW9ja1R1aSA9IHsgcmVxdWVzdFJlbmRlcjogKCkgPT4ge30gfTtcblx0XHRcdFx0XHRjb25zdCBtb2NrVGhlbWUgPSB7XG5cdFx0XHRcdFx0XHRmZzogKF9jOiBzdHJpbmcsIHQ6IHN0cmluZykgPT4gdCxcblx0XHRcdFx0XHRcdGJvbGQ6ICh0OiBzdHJpbmcpID0+IHQsXG5cdFx0XHRcdFx0XHRkaW06ICh0OiBzdHJpbmcpID0+IHQsXG5cdFx0XHRcdFx0XHRpdGFsaWM6ICh0OiBzdHJpbmcpID0+IHQsXG5cdFx0XHRcdFx0XHRzdHJpa2V0aHJvdWdoOiAodDogc3RyaW5nKSA9PiB0LFxuXHRcdFx0XHRcdFx0YWNjZW50OiAodDogc3RyaW5nKSA9PiB0LFxuXHRcdFx0XHRcdFx0c3VjY2VzczogKHQ6IHN0cmluZykgPT4gdCxcblx0XHRcdFx0XHRcdHdhcm5pbmc6ICh0OiBzdHJpbmcpID0+IHQsXG5cdFx0XHRcdFx0XHRlcnJvcjogKHQ6IHN0cmluZykgPT4gdCxcblx0XHRcdFx0XHRcdGluZm86ICh0OiBzdHJpbmcpID0+IHQsXG5cdFx0XHRcdFx0XHRtdXRlZDogKHQ6IHN0cmluZykgPT4gdCxcblx0XHRcdFx0XHRcdGRpbW1lZDogKHQ6IHN0cmluZykgPT4gdCxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdHdpZGdldCA9IGZhY3RvcnkobW9ja1R1aSwgbW9ja1RoZW1lLCB7fSwgKHJlc3VsdDogUm91bmRSZXN1bHQpID0+IHtcblx0XHRcdFx0XHRcdGRvbmVDYWxscy5wdXNoKHJlc3VsdCk7XG5cdFx0XHRcdFx0XHRyZXNvbHZlKHJlc3VsdCk7XG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH0pLFxuXHRcdFx0fSxcblx0XHR9IGFzIGFueSk7XG5cblx0XHRhc3NlcnQub2sod2lkZ2V0LCBcIndpZGdldCBzaG91bGQgYmUgY3JlYXRlZCBzeW5jaHJvbm91c2x5XCIpO1xuXHRcdHdpZGdldC5oYW5kbGVJbnB1dChFTlRFUik7XG5cdFx0d2lkZ2V0LmhhbmRsZUlucHV0KEVOVEVSKTtcblx0XHRjb250cm9sbGVyLmFib3J0KCk7XG5cblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCByZXN1bHRQcm9taXNlO1xuXHRcdGFzc2VydC5lcXVhbChkb25lQ2FsbHMubGVuZ3RoLCAxLCBcImFib3J0IGFmdGVyIHN1Ym1pdCBtdXN0IG5vdCBlbWl0IGEgc2Vjb25kIGVtcHR5IHJlc3VsdFwiKTtcblx0XHRhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdC5hbnN3ZXJzLnExLCB7IHNlbGVjdGVkOiBcIldlYiBBcHBcIiwgbm90ZXM6IFwiXCIgfSk7XG5cdH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFlQSxTQUFTLFVBQVUsVUFBVTtBQUM3QixPQUFPLFlBQVk7QUFD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
