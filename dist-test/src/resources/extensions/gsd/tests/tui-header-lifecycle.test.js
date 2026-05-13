import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { visibleWidth } from "@gsd/pi-tui";
import { setCompletionProgressWidget, updateProgressWidget } from "../auto-dashboard.js";
function makeTempDir(prefix) {
  return join(
    tmpdir(),
    `gsd-tui-lifecycle-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
  }
}
const baseState = {
  phase: "executing",
  activeMilestone: { id: "M001", title: "Milestone" },
  activeSlice: { id: "S01", title: "Slice" },
  activeTask: { id: "T01", title: "Task" }
};
const baseAccessors = {
  getAutoStartTime: () => 0,
  isStepMode: () => false,
  getCmdCtx: () => null,
  getBasePath: () => "/tmp",
  isVerbose: () => false,
  isSessionSwitching: () => false,
  getCurrentDispatchedModelId: () => null
};
function assertLinesFit(lines, width) {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `line exceeds width ${width}: ${visibleWidth(line)} "${line}"`
    );
  }
}
test("updateProgressWidget installs an EMPTY-rendering header (not undefined) \u2014 addresses codex P1 finding that setHeader(undefined) restores the built-in logo+instructions header", (t) => {
  const dir = makeTempDir("empty-header");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));
  const captured = { factory: void 0 };
  let setHeaderCallCount = 0;
  updateProgressWidget(
    {
      hasUI: true,
      ui: {
        setWidget() {
        },
        setHeader(factory) {
          setHeaderCallCount++;
          captured.factory = factory;
        },
        setStatus() {
        }
      }
    },
    "execute-task",
    "M001/S01/T01",
    baseState,
    { ...baseAccessors, getBasePath: () => dir }
  );
  assert.equal(setHeaderCallCount, 1, "setHeader must be called exactly once when widget installs");
  assert.notEqual(captured.factory, void 0, "factory must NOT be undefined \u2014 undefined restores the built-in logo+instructions header (codex P1)");
  assert.equal(typeof captured.factory, "function", "factory must be a component-creating function");
  const component = captured.factory(null, null);
  const rendered = component.render(80);
  assert.deepEqual(rendered, [], "empty header component must render zero lines so auto-mode actually suppresses the welcome banner");
});
test("updateProgressWidget clears the gsd-step wizard badge when auto-mode activates", (t) => {
  const dir = makeTempDir("step-badge");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));
  const statusCalls = [];
  updateProgressWidget(
    {
      hasUI: true,
      ui: {
        setWidget() {
        },
        setHeader() {
        },
        setStatus(key, value) {
          statusCalls.push([key, value]);
        }
      }
    },
    "execute-task",
    "M001/S01/T01",
    baseState,
    { ...baseAccessors, getBasePath: () => dir }
  );
  assert.ok(
    statusCalls.some(([key, value]) => key === "gsd-step" && value === void 0),
    `expected setStatus("gsd-step", undefined) to be called; got ${JSON.stringify(statusCalls)}`
  );
});
test("updateProgressWidget gracefully no-ops when ctx.ui lacks setHeader/setStatus (RPC mode)", (t) => {
  const dir = makeTempDir("rpc-mode");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));
  assert.doesNotThrow(() => {
    updateProgressWidget(
      {
        hasUI: true,
        ui: { setWidget() {
        } }
      },
      "execute-task",
      "M001/S01/T01",
      baseState,
      { ...baseAccessors, getBasePath: () => dir }
    );
  });
});
test("auto-dashboard widget render output includes Ctrl+N guidance when isStepMode is true", (t) => {
  const dir = makeTempDir("step-hint");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));
  let widgetFactory;
  updateProgressWidget(
    {
      hasUI: true,
      ui: {
        setWidget(_key, factory) {
          widgetFactory = factory;
        },
        setHeader() {
        },
        setStatus() {
        }
      }
    },
    "execute-task",
    "M001/S01/T01",
    baseState,
    { ...baseAccessors, getBasePath: () => dir, isStepMode: () => true }
  );
  assert.ok(widgetFactory, "widget factory must be installed");
  const fakeTui = { requestRender() {
  } };
  const fakeTheme = {
    fg: (_color, text) => text,
    bold: (text) => text
  };
  const component = widgetFactory(fakeTui, fakeTheme);
  const lines = component.render(120);
  const hasStepHint = lines.some((line) => line.includes("Ctrl+N to advance"));
  assert.ok(hasStepHint, `expected step-mode hint in render output; got:
${lines.join("\n")}`);
  if (component.dispose) component.dispose();
});
test("auto-dashboard widget render output omits Ctrl+N guidance when isStepMode is false", (t) => {
  const dir = makeTempDir("no-step-hint");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));
  let widgetFactory;
  updateProgressWidget(
    {
      hasUI: true,
      ui: {
        setWidget(_key, factory) {
          widgetFactory = factory;
        },
        setHeader() {
        },
        setStatus() {
        }
      }
    },
    "execute-task",
    "M001/S01/T01",
    baseState,
    { ...baseAccessors, getBasePath: () => dir, isStepMode: () => false }
  );
  assert.ok(widgetFactory);
  const fakeTui = { requestRender() {
  } };
  const fakeTheme = {
    fg: (_color, text) => text,
    bold: (text) => text
  };
  const component = widgetFactory(fakeTui, fakeTheme);
  const lines = component.render(120);
  const hasStepHint = lines.some((line) => line.includes("Ctrl+N to advance"));
  assert.equal(hasStepHint, false, "step-mode hint must NOT appear when isStepMode is false");
  if (component.dispose) component.dispose();
});
test("auto-dashboard widget render output fits common terminal widths", (t) => {
  const dir = makeTempDir("width-safe");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));
  let widgetFactory;
  updateProgressWidget(
    {
      hasUI: true,
      ui: {
        setWidget(_key, factory) {
          widgetFactory = factory;
        },
        setHeader() {
        },
        setStatus() {
        }
      }
    },
    "execute-task",
    "M001/S01/T01",
    baseState,
    { ...baseAccessors, getBasePath: () => dir }
  );
  assert.ok(widgetFactory);
  const component = widgetFactory(
    { requestRender() {
    } },
    {
      fg: (_color, text) => text,
      bold: (text) => text
    }
  );
  t.after(() => component.dispose?.());
  for (const width of [40, 80, 120]) {
    assertLinesFit(component.render(width), width);
    component.invalidate();
  }
  if (component.dispose) component.dispose();
});
test("completion dashboard keeps final milestone roll-up in the progress widget", (t) => {
  const dir = makeTempDir("completion-widget");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  t.after(() => cleanup(dir));
  let widgetFactory;
  setCompletionProgressWidget(
    {
      hasUI: true,
      ui: {
        setWidget(_key, factory) {
          widgetFactory = factory;
        },
        setHeader() {
        },
        setStatus() {
        }
      }
    },
    {
      milestoneId: "M003",
      milestoneTitle: "Budget tracking",
      oneLiner: "Added milestone budget warning output and provider roll-up details.",
      successCriteriaResults: "Budget warnings appear at the end of milestone completion.",
      requirementOutcomes: "Users can see what shipped without opening a fresh session.",
      keyFiles: ["src/resources/extensions/gsd/auto-dashboard.ts", "src/resources/extensions/gsd/auto.ts"],
      keyDecisions: ["Keep completion closeout in the same TUI surface."],
      followUps: "None.",
      reason: "Milestone M003 complete",
      startedAt: Date.now() - 9e4,
      totalCost: 21.29,
      totalTokens: 1e6,
      unitCount: 8,
      cacheHitRate: 100,
      contextPercent: 0.9,
      contextWindow: 1e6,
      completedSlices: 3,
      totalSlices: 3,
      basePath: dir
    }
  );
  assert.ok(widgetFactory, "completion widget factory must be installed");
  const fakeTui = { requestRender() {
  } };
  const fakeTheme = {
    fg: (_color, text) => text,
    bold: (text) => text
  };
  const component = widgetFactory(fakeTui, fakeTheme);
  const output = component.render(140).join("\n");
  assert.match(output, /Milestone M003 roll-up/);
  assert.match(output, /Budget tracking/);
  assert.match(output, /Outcome/);
  assert.match(output, /Added milestone budget warning output/);
  assert.match(output, /What changed/);
  assert.match(output, /Budget warnings appear/);
  assert.match(output, /Users can see what shipped/);
  assert.match(output, /Keep completion closeout/);
  assert.match(output, /Verification/);
  assert.match(output, /Files: src\/resources\/extensions\/gsd\/auto-dashboard\.ts/);
  assert.match(output, /Run totals 3\/3 slices/);
  assert.match(output, /100% cache hit/);
  assert.match(output, /\$21\.29/);
  assert.match(output, /1\.0M tokens/);
  assert.match(output, /8 units/);
  assert.doesNotMatch(output, /COMPLETE-MILESTONE/);
  if (component.dispose) component.dispose();
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy90dWktaGVhZGVyLWxpZmVjeWNsZS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogUmVncmVzc2lvbiB0ZXN0cyBmb3IgdGhlIFRVSSBoZWFkZXIgbGlmZWN5Y2xlIGZpeGVzIFx1MjAxNFxuLy8gaGVhZGVyIGlzIHN1cHByZXNzZWQgKHplcm8gbGluZXMpIHdoZW4gYXV0by1tb2RlIGFjdGl2YXRlcywgdGhlIHdpemFyZFxuLy8gc3RlcCBzdGF0dXMgYmFkZ2UgaXMgY2xlYXJlZCwgdGhlIE5FWFQtbW9kZSBmb290ZXIgaGludCByZW5kZXJzIHdoZW5cbi8vIHN0ZXAgbW9kZSBpcyBhY3RpdmUsIGFuZCB0aGUgaGVhbHRoIHdpZGdldCBhcHBlbmRzIGd1aWRhbmNlIGZvciBhY3RpdmVcbi8vIHByb2plY3RzLlxuXG5pbXBvcnQgdGVzdCBmcm9tIFwibm9kZTp0ZXN0XCI7XG5pbXBvcnQgYXNzZXJ0IGZyb20gXCJub2RlOmFzc2VydC9zdHJpY3RcIjtcbmltcG9ydCB7IG1rZGlyU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgdmlzaWJsZVdpZHRoIH0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5cbmltcG9ydCB7IHNldENvbXBsZXRpb25Qcm9ncmVzc1dpZGdldCwgdXBkYXRlUHJvZ3Jlc3NXaWRnZXQgfSBmcm9tIFwiLi4vYXV0by1kYXNoYm9hcmQudHNcIjtcbmltcG9ydCB0eXBlIHsgR1NEU3RhdGUgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcblxuaW50ZXJmYWNlIENhcHR1cmVkU2V0SGVhZGVyIHtcbiAgZmFjdG9yeTogKCh0dWk6IHVua25vd24sIHRoZW1lOiB1bmtub3duKSA9PiB7IHJlbmRlcih3aWR0aDogbnVtYmVyKTogc3RyaW5nW107IGludmFsaWRhdGUoKTogdm9pZCB9KSB8IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gbWFrZVRlbXBEaXIocHJlZml4OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihcbiAgICB0bXBkaXIoKSxcbiAgICBgZ3NkLXR1aS1saWZlY3ljbGUtdGVzdC0ke3ByZWZpeH0tJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWAsXG4gICk7XG59XG5cbmZ1bmN0aW9uIGNsZWFudXAoZGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHsgcm1TeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIHsgLyogYmVzdC1lZmZvcnQgKi8gfVxufVxuXG5jb25zdCBiYXNlU3RhdGU6IEdTRFN0YXRlID0ge1xuICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiTWlsZXN0b25lXCIgfSxcbiAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIlNsaWNlXCIgfSxcbiAgYWN0aXZlVGFzazogeyBpZDogXCJUMDFcIiwgdGl0bGU6IFwiVGFza1wiIH0sXG59IGFzIHVua25vd24gYXMgR1NEU3RhdGU7XG5cbmNvbnN0IGJhc2VBY2Nlc3NvcnMgPSB7XG4gIGdldEF1dG9TdGFydFRpbWU6ICgpID0+IDAsXG4gIGlzU3RlcE1vZGU6ICgpID0+IGZhbHNlLFxuICBnZXRDbWRDdHg6ICgpID0+IG51bGwsXG4gIGdldEJhc2VQYXRoOiAoKSA9PiBcIi90bXBcIixcbiAgaXNWZXJib3NlOiAoKSA9PiBmYWxzZSxcbiAgaXNTZXNzaW9uU3dpdGNoaW5nOiAoKSA9PiBmYWxzZSxcbiAgZ2V0Q3VycmVudERpc3BhdGNoZWRNb2RlbElkOiAoKSA9PiBudWxsLFxufTtcblxuZnVuY3Rpb24gYXNzZXJ0TGluZXNGaXQobGluZXM6IHN0cmluZ1tdLCB3aWR0aDogbnVtYmVyKTogdm9pZCB7XG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGFzc2VydC5vayhcbiAgICAgIHZpc2libGVXaWR0aChsaW5lKSA8PSB3aWR0aCxcbiAgICAgIGBsaW5lIGV4Y2VlZHMgd2lkdGggJHt3aWR0aH06ICR7dmlzaWJsZVdpZHRoKGxpbmUpfSBcIiR7bGluZX1cImAsXG4gICAgKTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDAgSGVhZGVyIGxpZmVjeWNsZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInVwZGF0ZVByb2dyZXNzV2lkZ2V0IGluc3RhbGxzIGFuIEVNUFRZLXJlbmRlcmluZyBoZWFkZXIgKG5vdCB1bmRlZmluZWQpIFx1MjAxNCBhZGRyZXNzZXMgY29kZXggUDEgZmluZGluZyB0aGF0IHNldEhlYWRlcih1bmRlZmluZWQpIHJlc3RvcmVzIHRoZSBidWlsdC1pbiBsb2dvK2luc3RydWN0aW9ucyBoZWFkZXJcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJlbXB0eS1oZWFkZXJcIik7XG4gIG1rZGlyU3luYyhqb2luKGRpciwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGRpcikpO1xuXG4gIGNvbnN0IGNhcHR1cmVkOiBDYXB0dXJlZFNldEhlYWRlciA9IHsgZmFjdG9yeTogdW5kZWZpbmVkIH07XG4gIGxldCBzZXRIZWFkZXJDYWxsQ291bnQgPSAwO1xuXG4gIHVwZGF0ZVByb2dyZXNzV2lkZ2V0KFxuICAgIHtcbiAgICAgIGhhc1VJOiB0cnVlLFxuICAgICAgdWk6IHtcbiAgICAgICAgc2V0V2lkZ2V0KCkge30sXG4gICAgICAgIHNldEhlYWRlcihmYWN0b3J5OiBhbnkpIHtcbiAgICAgICAgICBzZXRIZWFkZXJDYWxsQ291bnQrKztcbiAgICAgICAgICBjYXB0dXJlZC5mYWN0b3J5ID0gZmFjdG9yeTtcbiAgICAgICAgfSxcbiAgICAgICAgc2V0U3RhdHVzKCkge30sXG4gICAgICB9LFxuICAgIH0gYXMgYW55LFxuICAgIFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgXCJNMDAxL1MwMS9UMDFcIixcbiAgICBiYXNlU3RhdGUsXG4gICAgeyAuLi5iYXNlQWNjZXNzb3JzLCBnZXRCYXNlUGF0aDogKCkgPT4gZGlyIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKHNldEhlYWRlckNhbGxDb3VudCwgMSwgXCJzZXRIZWFkZXIgbXVzdCBiZSBjYWxsZWQgZXhhY3RseSBvbmNlIHdoZW4gd2lkZ2V0IGluc3RhbGxzXCIpO1xuICBhc3NlcnQubm90RXF1YWwoY2FwdHVyZWQuZmFjdG9yeSwgdW5kZWZpbmVkLCBcImZhY3RvcnkgbXVzdCBOT1QgYmUgdW5kZWZpbmVkIFx1MjAxNCB1bmRlZmluZWQgcmVzdG9yZXMgdGhlIGJ1aWx0LWluIGxvZ28raW5zdHJ1Y3Rpb25zIGhlYWRlciAoY29kZXggUDEpXCIpO1xuICBhc3NlcnQuZXF1YWwodHlwZW9mIGNhcHR1cmVkLmZhY3RvcnksIFwiZnVuY3Rpb25cIiwgXCJmYWN0b3J5IG11c3QgYmUgYSBjb21wb25lbnQtY3JlYXRpbmcgZnVuY3Rpb25cIik7XG5cbiAgY29uc3QgY29tcG9uZW50ID0gY2FwdHVyZWQuZmFjdG9yeSEobnVsbCwgbnVsbCk7XG4gIGNvbnN0IHJlbmRlcmVkID0gY29tcG9uZW50LnJlbmRlcig4MCk7XG4gIGFzc2VydC5kZWVwRXF1YWwocmVuZGVyZWQsIFtdLCBcImVtcHR5IGhlYWRlciBjb21wb25lbnQgbXVzdCByZW5kZXIgemVybyBsaW5lcyBzbyBhdXRvLW1vZGUgYWN0dWFsbHkgc3VwcHJlc3NlcyB0aGUgd2VsY29tZSBiYW5uZXJcIik7XG59KTtcblxudGVzdChcInVwZGF0ZVByb2dyZXNzV2lkZ2V0IGNsZWFycyB0aGUgZ3NkLXN0ZXAgd2l6YXJkIGJhZGdlIHdoZW4gYXV0by1tb2RlIGFjdGl2YXRlc1wiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInN0ZXAtYmFkZ2VcIik7XG4gIG1rZGlyU3luYyhqb2luKGRpciwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGRpcikpO1xuXG4gIGNvbnN0IHN0YXR1c0NhbGxzOiBBcnJheTxbc3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWRdPiA9IFtdO1xuXG4gIHVwZGF0ZVByb2dyZXNzV2lkZ2V0KFxuICAgIHtcbiAgICAgIGhhc1VJOiB0cnVlLFxuICAgICAgdWk6IHtcbiAgICAgICAgc2V0V2lkZ2V0KCkge30sXG4gICAgICAgIHNldEhlYWRlcigpIHt9LFxuICAgICAgICBzZXRTdGF0dXMoa2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQpIHsgc3RhdHVzQ2FsbHMucHVzaChba2V5LCB2YWx1ZV0pOyB9LFxuICAgICAgfSxcbiAgICB9IGFzIGFueSxcbiAgICBcImV4ZWN1dGUtdGFza1wiLFxuICAgIFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgYmFzZVN0YXRlLFxuICAgIHsgLi4uYmFzZUFjY2Vzc29ycywgZ2V0QmFzZVBhdGg6ICgpID0+IGRpciB9LFxuICApO1xuXG4gIGFzc2VydC5vayhcbiAgICBzdGF0dXNDYWxscy5zb21lKChba2V5LCB2YWx1ZV0pID0+IGtleSA9PT0gXCJnc2Qtc3RlcFwiICYmIHZhbHVlID09PSB1bmRlZmluZWQpLFxuICAgIGBleHBlY3RlZCBzZXRTdGF0dXMoXCJnc2Qtc3RlcFwiLCB1bmRlZmluZWQpIHRvIGJlIGNhbGxlZDsgZ290ICR7SlNPTi5zdHJpbmdpZnkoc3RhdHVzQ2FsbHMpfWAsXG4gICk7XG59KTtcblxudGVzdChcInVwZGF0ZVByb2dyZXNzV2lkZ2V0IGdyYWNlZnVsbHkgbm8tb3BzIHdoZW4gY3R4LnVpIGxhY2tzIHNldEhlYWRlci9zZXRTdGF0dXMgKFJQQyBtb2RlKVwiLCAodCkgPT4ge1xuICBjb25zdCBkaXIgPSBtYWtlVGVtcERpcihcInJwYy1tb2RlXCIpO1xuICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICAvLyBjdHgudWkgd2l0aG91dCBzZXRIZWFkZXIgLyBzZXRTdGF0dXMgXHUyMDE0IG11c3Qgbm90IHRocm93LlxuICBhc3NlcnQuZG9lc05vdFRocm93KCgpID0+IHtcbiAgICB1cGRhdGVQcm9ncmVzc1dpZGdldChcbiAgICAgIHtcbiAgICAgICAgaGFzVUk6IHRydWUsXG4gICAgICAgIHVpOiB7IHNldFdpZGdldCgpIHt9IH0sXG4gICAgICB9IGFzIGFueSxcbiAgICAgIFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgICBcIk0wMDEvUzAxL1QwMVwiLFxuICAgICAgYmFzZVN0YXRlLFxuICAgICAgeyAuLi5iYXNlQWNjZXNzb3JzLCBnZXRCYXNlUGF0aDogKCkgPT4gZGlyIH0sXG4gICAgKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIE5FWFQtbW9kZSBmb290ZXIgZ3VpZGFuY2UgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJhdXRvLWRhc2hib2FyZCB3aWRnZXQgcmVuZGVyIG91dHB1dCBpbmNsdWRlcyBDdHJsK04gZ3VpZGFuY2Ugd2hlbiBpc1N0ZXBNb2RlIGlzIHRydWVcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJzdGVwLWhpbnRcIik7XG4gIG1rZGlyU3luYyhqb2luKGRpciwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGRpcikpO1xuXG4gIGxldCB3aWRnZXRGYWN0b3J5OiAoKHR1aTogdW5rbm93biwgdGhlbWU6IHVua25vd24pID0+IGFueSkgfCB1bmRlZmluZWQ7XG5cbiAgdXBkYXRlUHJvZ3Jlc3NXaWRnZXQoXG4gICAge1xuICAgICAgaGFzVUk6IHRydWUsXG4gICAgICB1aToge1xuICAgICAgICBzZXRXaWRnZXQoX2tleTogc3RyaW5nLCBmYWN0b3J5OiBhbnkpIHsgd2lkZ2V0RmFjdG9yeSA9IGZhY3Rvcnk7IH0sXG4gICAgICAgIHNldEhlYWRlcigpIHt9LFxuICAgICAgICBzZXRTdGF0dXMoKSB7fSxcbiAgICAgIH0sXG4gICAgfSBhcyBhbnksXG4gICAgXCJleGVjdXRlLXRhc2tcIixcbiAgICBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIGJhc2VTdGF0ZSxcbiAgICB7IC4uLmJhc2VBY2Nlc3NvcnMsIGdldEJhc2VQYXRoOiAoKSA9PiBkaXIsIGlzU3RlcE1vZGU6ICgpID0+IHRydWUgfSxcbiAgKTtcblxuICBhc3NlcnQub2sod2lkZ2V0RmFjdG9yeSwgXCJ3aWRnZXQgZmFjdG9yeSBtdXN0IGJlIGluc3RhbGxlZFwiKTtcblxuICBjb25zdCBmYWtlVHVpID0geyByZXF1ZXN0UmVuZGVyKCkge30gfTtcbiAgY29uc3QgZmFrZVRoZW1lID0ge1xuICAgIGZnOiAoX2NvbG9yOiBzdHJpbmcsIHRleHQ6IHN0cmluZykgPT4gdGV4dCxcbiAgICBib2xkOiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuICB9O1xuICBjb25zdCBjb21wb25lbnQgPSB3aWRnZXRGYWN0b3J5IShmYWtlVHVpLCBmYWtlVGhlbWUpO1xuICBjb25zdCBsaW5lcyA9IGNvbXBvbmVudC5yZW5kZXIoMTIwKTtcblxuICBjb25zdCBoYXNTdGVwSGludCA9IGxpbmVzLnNvbWUoKGxpbmU6IHN0cmluZykgPT4gbGluZS5pbmNsdWRlcyhcIkN0cmwrTiB0byBhZHZhbmNlXCIpKTtcbiAgYXNzZXJ0Lm9rKGhhc1N0ZXBIaW50LCBgZXhwZWN0ZWQgc3RlcC1tb2RlIGhpbnQgaW4gcmVuZGVyIG91dHB1dDsgZ290OlxcbiR7bGluZXMuam9pbihcIlxcblwiKX1gKTtcblxuICBpZiAoY29tcG9uZW50LmRpc3Bvc2UpIGNvbXBvbmVudC5kaXNwb3NlKCk7XG59KTtcblxudGVzdChcImF1dG8tZGFzaGJvYXJkIHdpZGdldCByZW5kZXIgb3V0cHV0IG9taXRzIEN0cmwrTiBndWlkYW5jZSB3aGVuIGlzU3RlcE1vZGUgaXMgZmFsc2VcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJuby1zdGVwLWhpbnRcIik7XG4gIG1rZGlyU3luYyhqb2luKGRpciwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGRpcikpO1xuXG4gIGxldCB3aWRnZXRGYWN0b3J5OiAoKHR1aTogdW5rbm93biwgdGhlbWU6IHVua25vd24pID0+IGFueSkgfCB1bmRlZmluZWQ7XG5cbiAgdXBkYXRlUHJvZ3Jlc3NXaWRnZXQoXG4gICAge1xuICAgICAgaGFzVUk6IHRydWUsXG4gICAgICB1aToge1xuICAgICAgICBzZXRXaWRnZXQoX2tleTogc3RyaW5nLCBmYWN0b3J5OiBhbnkpIHsgd2lkZ2V0RmFjdG9yeSA9IGZhY3Rvcnk7IH0sXG4gICAgICAgIHNldEhlYWRlcigpIHt9LFxuICAgICAgICBzZXRTdGF0dXMoKSB7fSxcbiAgICAgIH0sXG4gICAgfSBhcyBhbnksXG4gICAgXCJleGVjdXRlLXRhc2tcIixcbiAgICBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIGJhc2VTdGF0ZSxcbiAgICB7IC4uLmJhc2VBY2Nlc3NvcnMsIGdldEJhc2VQYXRoOiAoKSA9PiBkaXIsIGlzU3RlcE1vZGU6ICgpID0+IGZhbHNlIH0sXG4gICk7XG5cbiAgYXNzZXJ0Lm9rKHdpZGdldEZhY3RvcnkpO1xuXG4gIGNvbnN0IGZha2VUdWkgPSB7IHJlcXVlc3RSZW5kZXIoKSB7fSB9O1xuICBjb25zdCBmYWtlVGhlbWUgPSB7XG4gICAgZmc6IChfY29sb3I6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuICAgIGJvbGQ6ICh0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG4gIH07XG4gIGNvbnN0IGNvbXBvbmVudCA9IHdpZGdldEZhY3RvcnkhKGZha2VUdWksIGZha2VUaGVtZSk7XG4gIGNvbnN0IGxpbmVzID0gY29tcG9uZW50LnJlbmRlcigxMjApO1xuXG4gIGNvbnN0IGhhc1N0ZXBIaW50ID0gbGluZXMuc29tZSgobGluZTogc3RyaW5nKSA9PiBsaW5lLmluY2x1ZGVzKFwiQ3RybCtOIHRvIGFkdmFuY2VcIikpO1xuICBhc3NlcnQuZXF1YWwoaGFzU3RlcEhpbnQsIGZhbHNlLCBcInN0ZXAtbW9kZSBoaW50IG11c3QgTk9UIGFwcGVhciB3aGVuIGlzU3RlcE1vZGUgaXMgZmFsc2VcIik7XG5cbiAgaWYgKGNvbXBvbmVudC5kaXNwb3NlKSBjb21wb25lbnQuZGlzcG9zZSgpO1xufSk7XG5cbnRlc3QoXCJhdXRvLWRhc2hib2FyZCB3aWRnZXQgcmVuZGVyIG91dHB1dCBmaXRzIGNvbW1vbiB0ZXJtaW5hbCB3aWR0aHNcIiwgKHQpID0+IHtcbiAgY29uc3QgZGlyID0gbWFrZVRlbXBEaXIoXCJ3aWR0aC1zYWZlXCIpO1xuICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHQuYWZ0ZXIoKCkgPT4gY2xlYW51cChkaXIpKTtcblxuICBsZXQgd2lkZ2V0RmFjdG9yeTogKCh0dWk6IHVua25vd24sIHRoZW1lOiB1bmtub3duKSA9PiBhbnkpIHwgdW5kZWZpbmVkO1xuXG4gIHVwZGF0ZVByb2dyZXNzV2lkZ2V0KFxuICAgIHtcbiAgICAgIGhhc1VJOiB0cnVlLFxuICAgICAgdWk6IHtcbiAgICAgICAgc2V0V2lkZ2V0KF9rZXk6IHN0cmluZywgZmFjdG9yeTogYW55KSB7IHdpZGdldEZhY3RvcnkgPSBmYWN0b3J5OyB9LFxuICAgICAgICBzZXRIZWFkZXIoKSB7fSxcbiAgICAgICAgc2V0U3RhdHVzKCkge30sXG4gICAgICB9LFxuICAgIH0gYXMgYW55LFxuICAgIFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgXCJNMDAxL1MwMS9UMDFcIixcbiAgICBiYXNlU3RhdGUsXG4gICAgeyAuLi5iYXNlQWNjZXNzb3JzLCBnZXRCYXNlUGF0aDogKCkgPT4gZGlyIH0sXG4gICk7XG5cbiAgYXNzZXJ0Lm9rKHdpZGdldEZhY3RvcnkpO1xuXG4gIGNvbnN0IGNvbXBvbmVudCA9IHdpZGdldEZhY3RvcnkhKFxuICAgIHsgcmVxdWVzdFJlbmRlcigpIHt9IH0sXG4gICAge1xuICAgICAgZmc6IChfY29sb3I6IHN0cmluZywgdGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuICAgICAgYm9sZDogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcbiAgICB9LFxuICApO1xuICB0LmFmdGVyKCgpID0+IGNvbXBvbmVudC5kaXNwb3NlPy4oKSk7XG5cbiAgZm9yIChjb25zdCB3aWR0aCBvZiBbNDAsIDgwLCAxMjBdKSB7XG4gICAgYXNzZXJ0TGluZXNGaXQoY29tcG9uZW50LnJlbmRlcih3aWR0aCksIHdpZHRoKTtcbiAgICBjb21wb25lbnQuaW52YWxpZGF0ZSgpO1xuICB9XG5cbiAgaWYgKGNvbXBvbmVudC5kaXNwb3NlKSBjb21wb25lbnQuZGlzcG9zZSgpO1xufSk7XG5cbnRlc3QoXCJjb21wbGV0aW9uIGRhc2hib2FyZCBrZWVwcyBmaW5hbCBtaWxlc3RvbmUgcm9sbC11cCBpbiB0aGUgcHJvZ3Jlc3Mgd2lkZ2V0XCIsICh0KSA9PiB7XG4gIGNvbnN0IGRpciA9IG1ha2VUZW1wRGlyKFwiY29tcGxldGlvbi13aWRnZXRcIik7XG4gIG1rZGlyU3luYyhqb2luKGRpciwgXCIuZ3NkXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgdC5hZnRlcigoKSA9PiBjbGVhbnVwKGRpcikpO1xuXG4gIGxldCB3aWRnZXRGYWN0b3J5OiAoKHR1aTogdW5rbm93biwgdGhlbWU6IHVua25vd24pID0+IGFueSkgfCB1bmRlZmluZWQ7XG5cbiAgc2V0Q29tcGxldGlvblByb2dyZXNzV2lkZ2V0KFxuICAgIHtcbiAgICAgIGhhc1VJOiB0cnVlLFxuICAgICAgdWk6IHtcbiAgICAgICAgc2V0V2lkZ2V0KF9rZXk6IHN0cmluZywgZmFjdG9yeTogYW55KSB7IHdpZGdldEZhY3RvcnkgPSBmYWN0b3J5OyB9LFxuICAgICAgICBzZXRIZWFkZXIoKSB7fSxcbiAgICAgICAgc2V0U3RhdHVzKCkge30sXG4gICAgICB9LFxuICAgIH0gYXMgYW55LFxuICAgIHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDNcIixcbiAgICAgIG1pbGVzdG9uZVRpdGxlOiBcIkJ1ZGdldCB0cmFja2luZ1wiLFxuICAgICAgb25lTGluZXI6IFwiQWRkZWQgbWlsZXN0b25lIGJ1ZGdldCB3YXJuaW5nIG91dHB1dCBhbmQgcHJvdmlkZXIgcm9sbC11cCBkZXRhaWxzLlwiLFxuICAgICAgc3VjY2Vzc0NyaXRlcmlhUmVzdWx0czogXCJCdWRnZXQgd2FybmluZ3MgYXBwZWFyIGF0IHRoZSBlbmQgb2YgbWlsZXN0b25lIGNvbXBsZXRpb24uXCIsXG4gICAgICByZXF1aXJlbWVudE91dGNvbWVzOiBcIlVzZXJzIGNhbiBzZWUgd2hhdCBzaGlwcGVkIHdpdGhvdXQgb3BlbmluZyBhIGZyZXNoIHNlc3Npb24uXCIsXG4gICAgICBrZXlGaWxlczogW1wic3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLWRhc2hib2FyZC50c1wiLCBcInNyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvYXV0by50c1wiXSxcbiAgICAgIGtleURlY2lzaW9uczogW1wiS2VlcCBjb21wbGV0aW9uIGNsb3Nlb3V0IGluIHRoZSBzYW1lIFRVSSBzdXJmYWNlLlwiXSxcbiAgICAgIGZvbGxvd1VwczogXCJOb25lLlwiLFxuICAgICAgcmVhc29uOiBcIk1pbGVzdG9uZSBNMDAzIGNvbXBsZXRlXCIsXG4gICAgICBzdGFydGVkQXQ6IERhdGUubm93KCkgLSA5MF8wMDAsXG4gICAgICB0b3RhbENvc3Q6IDIxLjI5LFxuICAgICAgdG90YWxUb2tlbnM6IDFfMDAwXzAwMCxcbiAgICAgIHVuaXRDb3VudDogOCxcbiAgICAgIGNhY2hlSGl0UmF0ZTogMTAwLFxuICAgICAgY29udGV4dFBlcmNlbnQ6IDAuOSxcbiAgICAgIGNvbnRleHRXaW5kb3c6IDFfMDAwXzAwMCxcbiAgICAgIGNvbXBsZXRlZFNsaWNlczogMyxcbiAgICAgIHRvdGFsU2xpY2VzOiAzLFxuICAgICAgYmFzZVBhdGg6IGRpcixcbiAgICB9LFxuICApO1xuXG4gIGFzc2VydC5vayh3aWRnZXRGYWN0b3J5LCBcImNvbXBsZXRpb24gd2lkZ2V0IGZhY3RvcnkgbXVzdCBiZSBpbnN0YWxsZWRcIik7XG5cbiAgY29uc3QgZmFrZVR1aSA9IHsgcmVxdWVzdFJlbmRlcigpIHt9IH07XG4gIGNvbnN0IGZha2VUaGVtZSA9IHtcbiAgICBmZzogKF9jb2xvcjogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHRleHQsXG4gICAgYm9sZDogKHRleHQ6IHN0cmluZykgPT4gdGV4dCxcbiAgfTtcbiAgY29uc3QgY29tcG9uZW50ID0gd2lkZ2V0RmFjdG9yeSEoZmFrZVR1aSwgZmFrZVRoZW1lKTtcbiAgY29uc3Qgb3V0cHV0ID0gY29tcG9uZW50LnJlbmRlcigxNDApLmpvaW4oXCJcXG5cIik7XG5cbiAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgL01pbGVzdG9uZSBNMDAzIHJvbGwtdXAvKTtcbiAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgL0J1ZGdldCB0cmFja2luZy8pO1xuICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvT3V0Y29tZS8pO1xuICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvQWRkZWQgbWlsZXN0b25lIGJ1ZGdldCB3YXJuaW5nIG91dHB1dC8pO1xuICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvV2hhdCBjaGFuZ2VkLyk7XG4gIGFzc2VydC5tYXRjaChvdXRwdXQsIC9CdWRnZXQgd2FybmluZ3MgYXBwZWFyLyk7XG4gIGFzc2VydC5tYXRjaChvdXRwdXQsIC9Vc2VycyBjYW4gc2VlIHdoYXQgc2hpcHBlZC8pO1xuICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvS2VlcCBjb21wbGV0aW9uIGNsb3Nlb3V0Lyk7XG4gIGFzc2VydC5tYXRjaChvdXRwdXQsIC9WZXJpZmljYXRpb24vKTtcbiAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgL0ZpbGVzOiBzcmNcXC9yZXNvdXJjZXNcXC9leHRlbnNpb25zXFwvZ3NkXFwvYXV0by1kYXNoYm9hcmRcXC50cy8pO1xuICBhc3NlcnQubWF0Y2gob3V0cHV0LCAvUnVuIHRvdGFscyAzXFwvMyBzbGljZXMvKTtcbiAgYXNzZXJ0Lm1hdGNoKG91dHB1dCwgLzEwMCUgY2FjaGUgaGl0Lyk7XG4gIGFzc2VydC5tYXRjaChvdXRwdXQsIC9cXCQyMVxcLjI5Lyk7XG4gIGFzc2VydC5tYXRjaChvdXRwdXQsIC8xXFwuME0gdG9rZW5zLyk7XG4gIGFzc2VydC5tYXRjaChvdXRwdXQsIC84IHVuaXRzLyk7XG4gIGFzc2VydC5kb2VzTm90TWF0Y2gob3V0cHV0LCAvQ09NUExFVEUtTUlMRVNUT05FLyk7XG5cbiAgaWYgKGNvbXBvbmVudC5kaXNwb3NlKSBjb21wb25lbnQuZGlzcG9zZSgpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFPQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsV0FBVyxjQUFjO0FBQ2xDLFNBQVMsWUFBWTtBQUNyQixTQUFTLGNBQWM7QUFDdkIsU0FBUyxvQkFBb0I7QUFFN0IsU0FBUyw2QkFBNkIsNEJBQTRCO0FBT2xFLFNBQVMsWUFBWSxRQUF3QjtBQUMzQyxTQUFPO0FBQUEsSUFDTCxPQUFPO0FBQUEsSUFDUCwwQkFBMEIsTUFBTSxJQUFJLEtBQUssSUFBSSxDQUFDLElBQUksS0FBSyxPQUFPLEVBQUUsU0FBUyxFQUFFLEVBQUUsTUFBTSxHQUFHLENBQUMsQ0FBQztBQUFBLEVBQzFGO0FBQ0Y7QUFFQSxTQUFTLFFBQVEsS0FBbUI7QUFDbEMsTUFBSTtBQUFFLFdBQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQUcsUUFBUTtBQUFBLEVBQW9CO0FBQ25GO0FBRUEsTUFBTSxZQUFzQjtBQUFBLEVBQzFCLE9BQU87QUFBQSxFQUNQLGlCQUFpQixFQUFFLElBQUksUUFBUSxPQUFPLFlBQVk7QUFBQSxFQUNsRCxhQUFhLEVBQUUsSUFBSSxPQUFPLE9BQU8sUUFBUTtBQUFBLEVBQ3pDLFlBQVksRUFBRSxJQUFJLE9BQU8sT0FBTyxPQUFPO0FBQ3pDO0FBRUEsTUFBTSxnQkFBZ0I7QUFBQSxFQUNwQixrQkFBa0IsTUFBTTtBQUFBLEVBQ3hCLFlBQVksTUFBTTtBQUFBLEVBQ2xCLFdBQVcsTUFBTTtBQUFBLEVBQ2pCLGFBQWEsTUFBTTtBQUFBLEVBQ25CLFdBQVcsTUFBTTtBQUFBLEVBQ2pCLG9CQUFvQixNQUFNO0FBQUEsRUFDMUIsNkJBQTZCLE1BQU07QUFDckM7QUFFQSxTQUFTLGVBQWUsT0FBaUIsT0FBcUI7QUFDNUQsYUFBVyxRQUFRLE9BQU87QUFDeEIsV0FBTztB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
