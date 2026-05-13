import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compositeOverlays } from "../overlay-layout.js";
function makeEntry(lines, options) {
  return {
    component: { render: () => lines },
    options,
    hidden: false,
    focusOrder: 1
  };
}
function sgrStateAtGlyph(line, targetGlyph) {
  const state = { dim: false, fg: "default", bg: "default" };
  let visibleSeen = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1B" && line[i + 1] === "[") {
      let j = i + 2;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if (c >= 64 && c <= 126) break;
        j++;
      }
      const final = line[j];
      if (final === "m") {
        const paramString = line.slice(i + 2, j);
        applySgr(state, paramString);
      }
      i = j + 1;
      continue;
    }
    if (line[i] === "\x1B") {
      i++;
      continue;
    }
    visibleSeen += line[i];
    if (visibleSeen.endsWith(targetGlyph)) {
      return state;
    }
    i++;
  }
  throw new Error(`Target glyph ${JSON.stringify(targetGlyph)} not found in line`);
}
function applySgr(state, paramString) {
  const parts = paramString === "" ? ["0"] : paramString.split(";");
  let k = 0;
  while (k < parts.length) {
    const n = parts[k] === "" ? 0 : Number(parts[k]);
    if (n === 0) {
      state.dim = false;
      state.fg = "default";
      state.bg = "default";
    } else if (n === 2) {
      state.dim = true;
    } else if (n === 22) {
      state.dim = false;
    } else if (n === 39) {
      state.fg = "default";
    } else if (n === 49) {
      state.bg = "default";
    } else if (n >= 30 && n <= 37 || n >= 90 && n <= 97) {
      state.fg = "set";
    } else if (n >= 40 && n <= 47 || n >= 100 && n <= 107) {
      state.bg = "set";
    } else if (n === 38) {
      state.fg = "set";
      if (parts[k + 1] === "5") {
        k += 2;
      } else if (parts[k + 1] === "2") {
        k += 4;
      }
    } else if (n === 48) {
      state.bg = "set";
      if (parts[k + 1] === "5") {
        k += 2;
      } else if (parts[k + 1] === "2") {
        k += 4;
      }
    }
    k++;
  }
}
function stripAnsi(line) {
  return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
}
describe("compositeOverlays \u2014 backdrop", () => {
  it("positions overlays against the visible terminal when base content is short", () => {
    const base = ["footer-like content"];
    const overlay = makeEntry(["TOP"], {
      width: 3,
      anchor: "top-left"
    });
    const result = compositeOverlays(base, [overlay], 20, 10, 1);
    assert.equal(result.length, 10);
    assert.ok(stripAnsi(result[0]).startsWith("TOP"), "top overlay should render on terminal row 0");
    assert.ok(
      stripAnsi(result.at(-1) ?? "").includes("footer-like content"),
      "short base content remains bottom-anchored"
    );
  });
  it("dims base lines outside the overlay when backdrop is true", () => {
    const base = ["hello world", "second line"];
    const overlay = makeEntry(["OVERLAY"], {
      width: 7,
      anchor: "top-left",
      backdrop: true
    });
    const result = compositeOverlays(base, [overlay], 20, 20, 2);
    const line = result.find((l) => stripAnsi(l).includes("second line"));
    assert.ok(line, "should have a line containing 'second line'");
    const state = sgrStateAtGlyph(line, "second line");
    assert.equal(state.dim, true, "base line should be dimmed (SGR 2)");
  });
  it("backdrop applies a non-default foreground colour and leaves background untouched", () => {
    const base = ["hello world", "second line"];
    const overlay = makeEntry(["OV"], {
      width: 2,
      anchor: "top-left",
      backdrop: true
    });
    const result = compositeOverlays(base, [overlay], 20, 20, 2);
    const line = result.find((l) => stripAnsi(l).includes("second line"));
    assert.ok(line, "should have a line containing 'second line'");
    const state = sgrStateAtGlyph(line, "second line");
    assert.equal(state.fg, "set", "backdrop must set a foreground colour");
    assert.equal(
      state.bg,
      "default",
      "backdrop must not paint a background (preserves user's terminal theme)"
    );
  });
  it("does not dim when backdrop is false/absent", () => {
    const base = ["hello world", "second line"];
    const overlay = makeEntry(["OVERLAY"], {
      width: 7,
      anchor: "top-left"
    });
    const result = compositeOverlays(base, [overlay], 20, 20, 2);
    const line = result.find((l) => stripAnsi(l).includes("second line"));
    assert.ok(line, "should have a line containing 'second line'");
    const state = sgrStateAtGlyph(line, "second line");
    assert.equal(state.dim, false, "base line should not be dimmed when no backdrop");
  });
  it("overlay content renders on top of dimmed background", () => {
    const base = ["aaaaaaaaaa"];
    const overlay = makeEntry(["XX"], {
      width: 2,
      anchor: "top-left",
      backdrop: true
    });
    const result = compositeOverlays(base, [overlay], 10, 10, 1);
    const overlayRow = result.find((l) => stripAnsi(l).includes("XX"));
    assert.ok(overlayRow, "overlay text should be composited into some rendered row");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktdHVpL3NyYy9fX3Rlc3RzX18vb3ZlcmxheS1sYXlvdXQudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gcGktdHVpIFx1MjAxNCBPdmVybGF5IExheW91dCBUZXN0cyAoYmFja2Ryb3AgZGltbWluZylcbi8vXG4vLyBUaGVzZSB0ZXN0cyBwcmV2aW91c2x5IGNvdXBsZWQgdG8gbGl0ZXJhbCBBTlNJIGVzY2FwZSBieXRlc1xuLy8gKGBcXHgxYlsybWAsIGBcXHgxYlszODs1OzI0MG1gKSBhbmQgd291bGQgYnJlYWsgaWYgdGhlIHBhbGV0dGUgaW5kZXggb3Jcbi8vIFNHUiBzcGVsbGluZyBjaGFuZ2VkIGRlc3BpdGUgaWRlbnRpY2FsIHJlbmRlcmVkIG91dHB1dCBcdTIwMTQgR29vZGhhcnQncyBsYXc6XG4vLyB0aGUgdGVzdCBtZWFzdXJlcyBlc2NhcGUgY29kZXMsIG5vdCBkaW1taW5nLlxuLy9cbi8vIFdlIG5vdyBwYXJzZSB0aGUgU0dSIGVzY2FwZSBjb2RlcyBpbnRvIGEgc2VtYW50aWMgc3R5bGUgc3RhdGUgYW5kIGFzc2VydFxuLy8gb24gdGhlIHZpc2libGUgY29udHJhY3Q6IHRoZSBjb3ZlcmVkLWJ1dC1vdXRzaWRlLW92ZXJsYXkgcmVnaW9uIGlzIGRpbSxcbi8vIGhhcyBhIG5vbi1kZWZhdWx0IGZvcmVncm91bmQgKHNvIHRoZSBleWUgY2FuIGRpc3Rpbmd1aXNoIGZvcmVncm91bmQgZnJvbVxuLy8gYmFja2dyb3VuZCksIGFuZCBkb2VzIG5vdCBwYWludCB0aGUgdGVybWluYWwgYmFja2dyb3VuZCAoc28gdXNlciB0aGVtZXNcbi8vIGFyZSBwcmVzZXJ2ZWQpLiBUaGUgb3ZlcmxheSBjb250ZW50IGl0c2VsZiBpcyByZWFjaGFibGUgdmlhIHBsYWluLXRleHRcbi8vIGxvb2t1cCBhZnRlciBzdHJpcHBpbmcgQU5TSS5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBjb21wb3NpdGVPdmVybGF5cywgdHlwZSBPdmVybGF5RW50cnkgfSBmcm9tIFwiLi4vb3ZlcmxheS1sYXlvdXQuanNcIjtcblxuZnVuY3Rpb24gbWFrZUVudHJ5KFxuXHRsaW5lczogc3RyaW5nW10sXG5cdG9wdGlvbnM/OiBPdmVybGF5RW50cnlbXCJvcHRpb25zXCJdLFxuKTogT3ZlcmxheUVudHJ5IHtcblx0cmV0dXJuIHtcblx0XHRjb21wb25lbnQ6IHsgcmVuZGVyOiAoKSA9PiBsaW5lcyB9LFxuXHRcdG9wdGlvbnMsXG5cdFx0aGlkZGVuOiBmYWxzZSxcblx0XHRmb2N1c09yZGVyOiAxLFxuXHR9O1xufVxuXG4vKipcbiAqIFBhcnNlIGEgbGluZSdzIEFOU0kgU0dSIHN0YXRlIGltbWVkaWF0ZWx5IGJlZm9yZSB0aGUgZmlyc3Qgb2NjdXJyZW5jZSBvZiBhXG4gKiB0YXJnZXQgc3Vic3RyaW5nIGluIHRoZSByZW5kZXJlZCAoQU5TSS1zdHJpcHBlZCkgdGV4dC4gV2Fsa3MgYFxceDFiWy4uLm1gXG4gKiBzZXF1ZW5jZXMgbGVmdC10by1yaWdodCwgbWFpbnRhaW5pbmcgYSBydW5uaW5nIHN0YXRlIHNvIHdlIGNhbiBhc2sgd2hhdFxuICogdGhlIHRlcm1pbmFsIGlzIGRvaW5nIHdoZW4gaXQgcmVhY2hlcyB0aGUgdGFyZ2V0IGdseXBocy5cbiAqXG4gKiBTZW1hbnRpYyBmaWVsZHM6XG4gKiAgIC0gZGltOiAgICBTR1IgMiBhY3RpdmUgYW5kIG5vdCByZXNldCBieSBTR1IgMjIgLyAwXG4gKiAgIC0gZmc6ICAgICBmb3JlZ3JvdW5kOiBcImRlZmF1bHRcIiB8IFwic2V0XCIgfCB0aGUgcmF3IG51bWVyaWMgcGFyYW1ldGVyc1xuICogICAtIGJnOiAgICAgYmFja2dyb3VuZDogXCJkZWZhdWx0XCIgfCBcInNldFwiXG4gKi9cbnR5cGUgU2dyU3RhdGUgPSB7IGRpbTogYm9vbGVhbjsgZmc6IFwiZGVmYXVsdFwiIHwgXCJzZXRcIjsgYmc6IFwiZGVmYXVsdFwiIHwgXCJzZXRcIiB9O1xuXG5mdW5jdGlvbiBzZ3JTdGF0ZUF0R2x5cGgobGluZTogc3RyaW5nLCB0YXJnZXRHbHlwaDogc3RyaW5nKTogU2dyU3RhdGUge1xuXHRjb25zdCBzdGF0ZTogU2dyU3RhdGUgPSB7IGRpbTogZmFsc2UsIGZnOiBcImRlZmF1bHRcIiwgYmc6IFwiZGVmYXVsdFwiIH07XG5cdC8vIFdhbGsgY29kZXMgYW5kIHZpc2libGUgY2hhcnMsIHRyYWNraW5nIHZpc2libGUtZ2x5cGggcG9zaXRpb24uXG5cdGxldCB2aXNpYmxlU2VlbiA9IFwiXCI7XG5cdGxldCBpID0gMDtcblx0d2hpbGUgKGkgPCBsaW5lLmxlbmd0aCkge1xuXHRcdGlmIChsaW5lW2ldID09PSBcIlxceDFiXCIgJiYgbGluZVtpICsgMV0gPT09IFwiW1wiKSB7XG5cdFx0XHQvLyBSZWFkIHVudGlsIGZpbmFsIGJ5dGUgaW4gMHg0MC0weDdFXG5cdFx0XHRsZXQgaiA9IGkgKyAyO1xuXHRcdFx0d2hpbGUgKGogPCBsaW5lLmxlbmd0aCkge1xuXHRcdFx0XHRjb25zdCBjID0gbGluZS5jaGFyQ29kZUF0KGopO1xuXHRcdFx0XHRpZiAoYyA+PSAweDQwICYmIGMgPD0gMHg3ZSkgYnJlYWs7XG5cdFx0XHRcdGorKztcblx0XHRcdH1cblx0XHRcdGNvbnN0IGZpbmFsID0gbGluZVtqXTtcblx0XHRcdGlmIChmaW5hbCA9PT0gXCJtXCIpIHtcblx0XHRcdFx0Y29uc3QgcGFyYW1TdHJpbmcgPSBsaW5lLnNsaWNlKGkgKyAyLCBqKTtcblx0XHRcdFx0YXBwbHlTZ3Ioc3RhdGUsIHBhcmFtU3RyaW5nKTtcblx0XHRcdH1cblx0XHRcdGkgPSBqICsgMTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblx0XHQvLyBTa2lwIG90aGVyIGVzY2FwZSBzZXF1ZW5jZXMgKE9TQyBoeXBlcmxpbmtzIGV0YykgY29uc2VydmF0aXZlbHk6XG5cdFx0Ly8gaWYgd2UgZXZlciBoaXQgYSBub24tU0dSIGVzY2FwZSwganVzdCBzdGVwIHBhc3QgdGhlIEVTQy5cblx0XHRpZiAobGluZVtpXSA9PT0gXCJcXHgxYlwiKSB7XG5cdFx0XHRpKys7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cdFx0dmlzaWJsZVNlZW4gKz0gbGluZVtpXTtcblx0XHRpZiAodmlzaWJsZVNlZW4uZW5kc1dpdGgodGFyZ2V0R2x5cGgpKSB7XG5cdFx0XHQvLyBXZSd2ZSBqdXN0IGNvbnN1bWVkIHRoZSBsYXN0IGNoYXIgb2YgdGFyZ2V0R2x5cGggXHUyMDE0IHJldHVybiB0aGVcblx0XHRcdC8vIHN0YXRlIHRoYXQgd2FzIGluIGVmZmVjdCBmb3IgdGhlIHdob2xlIG1hdGNoLlxuXHRcdFx0cmV0dXJuIHN0YXRlO1xuXHRcdH1cblx0XHRpKys7XG5cdH1cblx0dGhyb3cgbmV3IEVycm9yKGBUYXJnZXQgZ2x5cGggJHtKU09OLnN0cmluZ2lmeSh0YXJnZXRHbHlwaCl9IG5vdCBmb3VuZCBpbiBsaW5lYCk7XG59XG5cbmZ1bmN0aW9uIGFwcGx5U2dyKHN0YXRlOiBTZ3JTdGF0ZSwgcGFyYW1TdHJpbmc6IHN0cmluZyk6IHZvaWQge1xuXHQvLyBFbXB0eSBwYXJhbXMgPT0gcmVzZXRcblx0Y29uc3QgcGFydHMgPSBwYXJhbVN0cmluZyA9PT0gXCJcIiA/IFtcIjBcIl0gOiBwYXJhbVN0cmluZy5zcGxpdChcIjtcIik7XG5cdGxldCBrID0gMDtcblx0d2hpbGUgKGsgPCBwYXJ0cy5sZW5ndGgpIHtcblx0XHRjb25zdCBuID0gcGFydHNba10gPT09IFwiXCIgPyAwIDogTnVtYmVyKHBhcnRzW2tdKTtcblx0XHRpZiAobiA9PT0gMCkge1xuXHRcdFx0c3RhdGUuZGltID0gZmFsc2U7XG5cdFx0XHRzdGF0ZS5mZyA9IFwiZGVmYXVsdFwiO1xuXHRcdFx0c3RhdGUuYmcgPSBcImRlZmF1bHRcIjtcblx0XHR9IGVsc2UgaWYgKG4gPT09IDIpIHtcblx0XHRcdHN0YXRlLmRpbSA9IHRydWU7XG5cdFx0fSBlbHNlIGlmIChuID09PSAyMikge1xuXHRcdFx0c3RhdGUuZGltID0gZmFsc2U7XG5cdFx0fSBlbHNlIGlmIChuID09PSAzOSkge1xuXHRcdFx0c3RhdGUuZmcgPSBcImRlZmF1bHRcIjtcblx0XHR9IGVsc2UgaWYgKG4gPT09IDQ5KSB7XG5cdFx0XHRzdGF0ZS5iZyA9IFwiZGVmYXVsdFwiO1xuXHRcdH0gZWxzZSBpZiAoKG4gPj0gMzAgJiYgbiA8PSAzNykgfHwgKG4gPj0gOTAgJiYgbiA8PSA5NykpIHtcblx0XHRcdHN0YXRlLmZnID0gXCJzZXRcIjtcblx0XHR9IGVsc2UgaWYgKChuID49IDQwICYmIG4gPD0gNDcpIHx8IChuID49IDEwMCAmJiBuIDw9IDEwNykpIHtcblx0XHRcdHN0YXRlLmJnID0gXCJzZXRcIjtcblx0XHR9IGVsc2UgaWYgKG4gPT09IDM4KSB7XG5cdFx0XHRzdGF0ZS5mZyA9IFwic2V0XCI7XG5cdFx0XHQvLyBTa2lwIGNvbG91ci1tb2RlbCBwYXJhbWV0ZXJzOiAzODs1O04gb3IgMzg7MjtSO0c7QlxuXHRcdFx0aWYgKHBhcnRzW2sgKyAxXSA9PT0gXCI1XCIpIHtcblx0XHRcdFx0ayArPSAyO1xuXHRcdFx0fSBlbHNlIGlmIChwYXJ0c1trICsgMV0gPT09IFwiMlwiKSB7XG5cdFx0XHRcdGsgKz0gNDtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKG4gPT09IDQ4KSB7XG5cdFx0XHRzdGF0ZS5iZyA9IFwic2V0XCI7XG5cdFx0XHRpZiAocGFydHNbayArIDFdID09PSBcIjVcIikge1xuXHRcdFx0XHRrICs9IDI7XG5cdFx0XHR9IGVsc2UgaWYgKHBhcnRzW2sgKyAxXSA9PT0gXCIyXCIpIHtcblx0XHRcdFx0ayArPSA0O1xuXHRcdFx0fVxuXHRcdH1cblx0XHRrKys7XG5cdH1cbn1cblxuZnVuY3Rpb24gc3RyaXBBbnNpKGxpbmU6IHN0cmluZyk6IHN0cmluZyB7XG5cdC8vIFJlbW92ZSBDU0kgc2VxdWVuY2VzLiBHb29kIGVub3VnaCBmb3IgdGhlc2UgdGVzdHMuXG5cdHJldHVybiBsaW5lXG5cdFx0LnJlcGxhY2UoL1xceDFiXFxbWzAtP10qWyAtL10qW0Atfl0vZywgXCJcIilcblx0XHQucmVwbGFjZSgvXFx4MWJcXF1bXFxzXFxTXSo/KD86XFx4MDd8XFx4MWJcXFxcKS9nLCBcIlwiKTtcbn1cblxuZGVzY3JpYmUoXCJjb21wb3NpdGVPdmVybGF5cyBcdTIwMTQgYmFja2Ryb3BcIiwgKCkgPT4ge1xuXHRpdChcInBvc2l0aW9ucyBvdmVybGF5cyBhZ2FpbnN0IHRoZSB2aXNpYmxlIHRlcm1pbmFsIHdoZW4gYmFzZSBjb250ZW50IGlzIHNob3J0XCIsICgpID0+IHtcblx0XHRjb25zdCBiYXNlID0gW1wiZm9vdGVyLWxpa2UgY29udGVudFwiXTtcblx0XHRjb25zdCBvdmVybGF5ID0gbWFrZUVudHJ5KFtcIlRPUFwiXSwge1xuXHRcdFx0d2lkdGg6IDMsXG5cdFx0XHRhbmNob3I6IFwidG9wLWxlZnRcIixcblx0XHR9KTtcblxuXHRcdGNvbnN0IHJlc3VsdCA9IGNvbXBvc2l0ZU92ZXJsYXlzKGJhc2UsIFtvdmVybGF5XSwgMjAsIDEwLCAxKTtcblxuXHRcdGFzc2VydC5lcXVhbChyZXN1bHQubGVuZ3RoLCAxMCk7XG5cdFx0YXNzZXJ0Lm9rKHN0cmlwQW5zaShyZXN1bHRbMF0pLnN0YXJ0c1dpdGgoXCJUT1BcIiksIFwidG9wIG92ZXJsYXkgc2hvdWxkIHJlbmRlciBvbiB0ZXJtaW5hbCByb3cgMFwiKTtcblx0XHRhc3NlcnQub2soXG5cdFx0XHRzdHJpcEFuc2kocmVzdWx0LmF0KC0xKSA/PyBcIlwiKS5pbmNsdWRlcyhcImZvb3Rlci1saWtlIGNvbnRlbnRcIiksXG5cdFx0XHRcInNob3J0IGJhc2UgY29udGVudCByZW1haW5zIGJvdHRvbS1hbmNob3JlZFwiLFxuXHRcdCk7XG5cdH0pO1xuXG5cdGl0KFwiZGltcyBiYXNlIGxpbmVzIG91dHNpZGUgdGhlIG92ZXJsYXkgd2hlbiBiYWNrZHJvcCBpcyB0cnVlXCIsICgpID0+IHtcblx0XHRjb25zdCBiYXNlID0gW1wiaGVsbG8gd29ybGRcIiwgXCJzZWNvbmQgbGluZVwiXTtcblx0XHRjb25zdCBvdmVybGF5ID0gbWFrZUVudHJ5KFtcIk9WRVJMQVlcIl0sIHtcblx0XHRcdHdpZHRoOiA3LFxuXHRcdFx0YW5jaG9yOiBcInRvcC1sZWZ0XCIsXG5cdFx0XHRiYWNrZHJvcDogdHJ1ZSxcblx0XHR9KTtcblxuXHRcdGNvbnN0IHJlc3VsdCA9IGNvbXBvc2l0ZU92ZXJsYXlzKGJhc2UsIFtvdmVybGF5XSwgMjAsIDIwLCAyKTtcblxuXHRcdC8vIFwic2Vjb25kIGxpbmVcIiBpcyBiZWxvdyB0aGUgb3ZlcmxheSAod2hpY2ggaXMgYW5jaG9yZWQgdG9wLWxlZnQgd2l0aFxuXHRcdC8vIGEgc2luZ2xlIHZpc2libGUgcm93KSwgc28gZXZlcnkgZ2x5cGggb2YgdGhhdCB0ZXh0IHNob3VsZCBiZVxuXHRcdC8vIHJlbmRlcmVkIHdpdGggdGhlIGRpbSBhdHRyaWJ1dGUgYWN0aXZlLlxuXHRcdGNvbnN0IGxpbmUgPSByZXN1bHQuZmluZCgobCkgPT4gc3RyaXBBbnNpKGwpLmluY2x1ZGVzKFwic2Vjb25kIGxpbmVcIikpO1xuXHRcdGFzc2VydC5vayhsaW5lLCBcInNob3VsZCBoYXZlIGEgbGluZSBjb250YWluaW5nICdzZWNvbmQgbGluZSdcIik7XG5cblx0XHRjb25zdCBzdGF0ZSA9IHNnclN0YXRlQXRHbHlwaChsaW5lLCBcInNlY29uZCBsaW5lXCIpO1xuXHRcdGFzc2VydC5lcXVhbChzdGF0ZS5kaW0sIHRydWUsIFwiYmFzZSBsaW5lIHNob3VsZCBiZSBkaW1tZWQgKFNHUiAyKVwiKTtcblx0fSk7XG5cblx0aXQoXCJiYWNrZHJvcCBhcHBsaWVzIGEgbm9uLWRlZmF1bHQgZm9yZWdyb3VuZCBjb2xvdXIgYW5kIGxlYXZlcyBiYWNrZ3JvdW5kIHVudG91Y2hlZFwiLCAoKSA9PiB7XG5cdFx0Y29uc3QgYmFzZSA9IFtcImhlbGxvIHdvcmxkXCIsIFwic2Vjb25kIGxpbmVcIl07XG5cdFx0Y29uc3Qgb3ZlcmxheSA9IG1ha2VFbnRyeShbXCJPVlwiXSwge1xuXHRcdFx0d2lkdGg6IDIsXG5cdFx0XHRhbmNob3I6IFwidG9wLWxlZnRcIixcblx0XHRcdGJhY2tkcm9wOiB0cnVlLFxuXHRcdH0pO1xuXG5cdFx0Y29uc3QgcmVzdWx0ID0gY29tcG9zaXRlT3ZlcmxheXMoYmFzZSwgW292ZXJsYXldLCAyMCwgMjAsIDIpO1xuXG5cdFx0Y29uc3QgbGluZSA9IHJlc3VsdC5maW5kKChsKSA9PiBzdHJpcEFuc2kobCkuaW5jbHVkZXMoXCJzZWNvbmQgbGluZVwiKSk7XG5cdFx0YXNzZXJ0Lm9rKGxpbmUsIFwic2hvdWxkIGhhdmUgYSBsaW5lIGNvbnRhaW5pbmcgJ3NlY29uZCBsaW5lJ1wiKTtcblxuXHRcdGNvbnN0IHN0YXRlID0gc2dyU3RhdGVBdEdseXBoKGxpbmUsIFwic2Vjb25kIGxpbmVcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKHN0YXRlLmZnLCBcInNldFwiLCBcImJhY2tkcm9wIG11c3Qgc2V0IGEgZm9yZWdyb3VuZCBjb2xvdXJcIik7XG5cdFx0YXNzZXJ0LmVxdWFsKFxuXHRcdFx0c3RhdGUuYmcsXG5cdFx0XHRcImRlZmF1bHRcIixcblx0XHRcdFwiYmFja2Ryb3AgbXVzdCBub3QgcGFpbnQgYSBiYWNrZ3JvdW5kIChwcmVzZXJ2ZXMgdXNlcidzIHRlcm1pbmFsIHRoZW1lKVwiLFxuXHRcdCk7XG5cdH0pO1xuXG5cdGl0KFwiZG9lcyBub3QgZGltIHdoZW4gYmFja2Ryb3AgaXMgZmFsc2UvYWJzZW50XCIsICgpID0+IHtcblx0XHRjb25zdCBiYXNlID0gW1wiaGVsbG8gd29ybGRcIiwgXCJzZWNvbmQgbGluZVwiXTtcblx0XHRjb25zdCBvdmVybGF5ID0gbWFrZUVudHJ5KFtcIk9WRVJMQVlcIl0sIHtcblx0XHRcdHdpZHRoOiA3LFxuXHRcdFx0YW5jaG9yOiBcInRvcC1sZWZ0XCIsXG5cdFx0fSk7XG5cblx0XHRjb25zdCByZXN1bHQgPSBjb21wb3NpdGVPdmVybGF5cyhiYXNlLCBbb3ZlcmxheV0sIDIwLCAyMCwgMik7XG5cblx0XHRjb25zdCBsaW5lID0gcmVzdWx0LmZpbmQoKGwpID0+IHN0cmlwQW5zaShsKS5pbmNsdWRlcyhcInNlY29uZCBsaW5lXCIpKTtcblx0XHRhc3NlcnQub2sobGluZSwgXCJzaG91bGQgaGF2ZSBhIGxpbmUgY29udGFpbmluZyAnc2Vjb25kIGxpbmUnXCIpO1xuXG5cdFx0Y29uc3Qgc3RhdGUgPSBzZ3JTdGF0ZUF0R2x5cGgobGluZSwgXCJzZWNvbmQgbGluZVwiKTtcblx0XHRhc3NlcnQuZXF1YWwoc3RhdGUuZGltLCBmYWxzZSwgXCJiYXNlIGxpbmUgc2hvdWxkIG5vdCBiZSBkaW1tZWQgd2hlbiBubyBiYWNrZHJvcFwiKTtcblx0fSk7XG5cblx0aXQoXCJvdmVybGF5IGNvbnRlbnQgcmVuZGVycyBvbiB0b3Agb2YgZGltbWVkIGJhY2tncm91bmRcIiwgKCkgPT4ge1xuXHRcdGNvbnN0IGJhc2UgPSBbXCJhYWFhYWFhYWFhXCJdO1xuXHRcdGNvbnN0IG92ZXJsYXkgPSBtYWtlRW50cnkoW1wiWFhcIl0sIHtcblx0XHRcdHdpZHRoOiAyLFxuXHRcdFx0YW5jaG9yOiBcInRvcC1sZWZ0XCIsXG5cdFx0XHRiYWNrZHJvcDogdHJ1ZSxcblx0XHR9KTtcblxuXHRcdGNvbnN0IHJlc3VsdCA9IGNvbXBvc2l0ZU92ZXJsYXlzKGJhc2UsIFtvdmVybGF5XSwgMTAsIDEwLCAxKTtcblxuXHRcdC8vIEZpbmQgdGhlIHJvdyB0aGF0IChhZnRlciBzdHJpcHBpbmcgc3R5bGluZykgY29udGFpbnMgdGhlIG92ZXJsYXlcblx0XHQvLyB0ZXh0LiBXZSBkb24ndCB1c2UgcG9zaXRpb25hbCBgcmVzdWx0WzBdYCBzbyB0aGUgdGVzdCBzdXJ2aXZlcyBpZlxuXHRcdC8vIHRoZSByb3cgb3JkZXJpbmcgY2hhbmdlcy5cblx0XHRjb25zdCBvdmVybGF5Um93ID0gcmVzdWx0LmZpbmQoKGwpID0+IHN0cmlwQW5zaShsKS5pbmNsdWRlcyhcIlhYXCIpKTtcblx0XHRhc3NlcnQub2sob3ZlcmxheVJvdywgXCJvdmVybGF5IHRleHQgc2hvdWxkIGJlIGNvbXBvc2l0ZWQgaW50byBzb21lIHJlbmRlcmVkIHJvd1wiKTtcblx0fSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQWNBLFNBQVMsVUFBVSxVQUFVO0FBQzdCLE9BQU8sWUFBWTtBQUNuQixTQUFTLHlCQUE0QztBQUVyRCxTQUFTLFVBQ1IsT0FDQSxTQUNlO0FBQ2YsU0FBTztBQUFBLElBQ04sV0FBVyxFQUFFLFFBQVEsTUFBTSxNQUFNO0FBQUEsSUFDakM7QUFBQSxJQUNBLFFBQVE7QUFBQSxJQUNSLFlBQVk7QUFBQSxFQUNiO0FBQ0Q7QUFlQSxTQUFTLGdCQUFnQixNQUFjLGFBQStCO0FBQ3JFLFFBQU0sUUFBa0IsRUFBRSxLQUFLLE9BQU8sSUFBSSxXQUFXLElBQUksVUFBVTtBQUVuRSxNQUFJLGNBQWM7QUFDbEIsTUFBSSxJQUFJO0FBQ1IsU0FBTyxJQUFJLEtBQUssUUFBUTtBQUN2QixRQUFJLEtBQUssQ0FBQyxNQUFNLFVBQVUsS0FBSyxJQUFJLENBQUMsTUFBTSxLQUFLO0FBRTlDLFVBQUksSUFBSSxJQUFJO0FBQ1osYUFBTyxJQUFJLEtBQUssUUFBUTtBQUN2QixjQUFNLElBQUksS0FBSyxXQUFXLENBQUM7QUFDM0IsWUFBSSxLQUFLLE1BQVEsS0FBSyxJQUFNO0FBQzVCO0FBQUEsTUFDRDtBQUNBLFlBQU0sUUFBUSxLQUFLLENBQUM7QUFDcEIsVUFBSSxVQUFVLEtBQUs7QUFDbEIsY0FBTSxjQUFjLEtBQUssTUFBTSxJQUFJLEdBQUcsQ0FBQztBQUN2QyxpQkFBUyxPQUFPLFdBQVc7QUFBQSxNQUM1QjtBQUNBLFVBQUksSUFBSTtBQUNSO0FBQUEsSUFDRDtBQUdBLFFBQUksS0FBSyxDQUFDLE1BQU0sUUFBUTtBQUN2QjtBQUNBO0FBQUEsSUFDRDtBQUNBLG1CQUFlLEtBQUssQ0FBQztBQUNyQixRQUFJLFlBQVksU0FBUyxXQUFXLEdBQUc7QUFHdEMsYUFBTztBQUFBLElBQ1I7QUFDQTtBQUFBLEVBQ0Q7QUFDQSxRQUFN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
