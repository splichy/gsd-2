import { describe, test } from "node:test";
import assert from "node:assert/strict";
import registerExtension from "../index.js";
function makePi(overrides = {}) {
  const registered = [];
  const registerCommand = (name, def) => {
    registered.push([name, def]);
  };
  const events = {
    on: () => {
    },
    off: () => {
    },
    emit: () => {
    }
  };
  const pi = {
    registerCommand,
    registerTool: () => {
    },
    registerHook: () => {
    },
    registerShortcut: () => {
    },
    events,
    ...overrides
  };
  return { pi, registered };
}
describe("extension bootstrap isolation (#4168, #4172)", () => {
  test("happy path: /gsd command is registered", async () => {
    const { pi, registered } = makePi();
    await registerExtension(pi);
    const names = registered.map(([n]) => n);
    assert.ok(
      names.includes("gsd"),
      `expected 'gsd' in registered commands, got ${JSON.stringify(names)}`
    );
  });
  test("degraded path: /gsd still registered when registerCommand throws for non-core commands", async () => {
    const registered = [];
    const pi = {
      registerCommand: (name, def) => {
        if (name !== "gsd" && name !== "worktree" && name !== "exit") {
        }
        if (name === "kill") throw new Error("simulated windows failure");
        registered.push([name, def]);
      },
      registerTool: () => {
      },
      registerHook: () => {
      },
      registerShortcut: () => {
      },
      events: { on: () => {
      }, off: () => {
      }, emit: () => {
      } }
    };
    await registerExtension(pi);
    const names = registered.map(([n]) => n);
    assert.ok(
      names.includes("gsd"),
      "expected 'gsd' to be registered even when a later command registration throws"
    );
  });
  test("degraded path: /gsd registered BEFORE any non-core command", async () => {
    const calls = [];
    const pi = {
      registerCommand: (name) => {
        calls.push(name);
      },
      registerTool: () => {
      },
      registerHook: () => {
      },
      registerShortcut: () => {
      },
      events: { on: () => {
      }, off: () => {
      }, emit: () => {
      } }
    };
    await registerExtension(pi);
    assert.ok(calls.length > 0, "expected at least one registerCommand call");
    assert.equal(
      calls[0],
      "gsd",
      `expected 'gsd' to be the first command registered, got ${JSON.stringify(calls)}`
    );
  });
});
import { registerGsdExtension } from "../bootstrap/register-extension.js";
describe("registerGsdExtension defensive registration", () => {
  test("a failing shortcut registration does not prevent kill command registration", async () => {
    const registered = [];
    const pi = {
      registerCommand: (name) => {
        registered.push(name);
      },
      registerTool: () => {
      },
      registerHook: () => {
      },
      registerShortcut: () => {
        throw new Error("simulated platform-specific shortcut failure");
      },
      events: { on: () => {
      }, off: () => {
      }, emit: () => {
      } }
    };
    assert.doesNotThrow(() => registerGsdExtension(pi));
    assert.ok(
      registered.includes("kill"),
      `expected 'kill' to be registered despite shortcut failure, got ${JSON.stringify(registered)}`
    );
  });
  test("does NOT register /gsd (caller's responsibility, avoids double-registration)", () => {
    const registered = [];
    const pi = {
      registerCommand: (name) => {
        registered.push(name);
      },
      registerTool: () => {
      },
      registerHook: () => {
      },
      registerShortcut: () => {
      },
      events: { on: () => {
      }, off: () => {
      }, emit: () => {
      } }
    };
    registerGsdExtension(pi);
    assert.ok(
      !registered.includes("gsd"),
      `registerGsdExtension must NOT register 'gsd' (it is registered separately by index.ts), got ${JSON.stringify(registered)}`
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9leHRlbnNpb24tYm9vdHN0cmFwLWlzb2xhdGlvbi50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBCZWhhdmlvdXJhbCBjb250cmFjdCBmb3IgR1NEIGV4dGVuc2lvbiBib290c3RyYXAgaXNvbGF0aW9uICgjNDE2OCwgIzQxNzIpLlxuLy9cbi8vIEd1YXJhbnRlZTogdGhlIGAvZ3NkYCBzbGFzaCBjb21tYW5kIG11c3QgYmUgcmVnaXN0ZXJlZCBvbiBwaSBldmVuIGlmIHRoZVxuLy8gZnVsbCBib290c3RyYXAgKHNob3J0Y3V0cywgdG9vbHMsIGhvb2tzLCBlY29zeXN0ZW0pIHRocm93cyBkdXJpbmcgaW1wb3J0IG9yXG4vLyBleGVjdXRpb24uIFByaW9yIHJlZ3Jlc3Npb25zOiBhIFdpbmRvd3Mtc3BlY2lmaWMgZmFpbHVyZSBpbiByZWdpc3Rlci1cbi8vIHNob3J0Y3V0cy50cyBzaWxlbnRseSBwcmV2ZW50ZWQgL2dzZCBmcm9tIGJlaW5nIHJlZ2lzdGVyZWQgYXQgYWxsIGJlY2F1c2Vcbi8vIHJlZ2lzdGVyR1NEQ29tbWFuZCB3YXMgY2FsbGVkIGluc2lkZSB0aGUgc2FtZSB0cnkgdGhhdCBsb2FkZWQgc2hvcnRjdXRzLlxuLy9cbi8vIFRoZXNlIHRlc3RzIGV4ZXJjaXNlIHRoZSByZWFsIGRlZmF1bHQgZXhwb3J0IG9mIGluZGV4LnRzICh3aGljaCBjYWxsc1xuLy8gcmVnaXN0ZXJHU0RDb21tYW5kIHZpYSBkeW5hbWljIGltcG9ydCwgdGhlbiBhdHRlbXB0cyB0aGUgZnVsbCBib290c3RyYXApXG4vLyB3aXRoIGEgbWluaW1hbCBtb2NrIEV4dGVuc2lvbkFQSSBhbmQgdmVyaWZ5IHRoZSBvYnNlcnZhYmxlIGJlaGF2aW91clxuLy8gZGlyZWN0bHk6IC9nc2QgaXMgcmVnaXN0ZXJlZCBpbiBib3RoIHRoZSBoYXBweSBwYXRoIGFuZCB0aGUgZGVncmFkZWQgcGF0aC5cbi8vXG4vLyBBbnRpLXJlZ3Jlc3Npb24gcHJvb2YgKGRvY3VtZW50ZWQgaW4gY29tbWl0KTpcbi8vICAgbmV1dGVyIGluZGV4LnRzIHRvIHJlZ2lzdGVyIC9nc2QgaW5zaWRlIHRoZSBzYW1lIHRyeXt9IGFzXG4vLyAgIHJlZ2lzdGVyLWV4dGVuc2lvbiBcdTIxOTIgdGhlIGRlZ3JhZGVkLXBhdGggdGVzdCBmYWlscyAobm8gL2dzZCBjb21tYW5kXG4vLyAgIHJlZ2lzdGVyZWQgd2hlbiByZWdpc3Rlci1leHRlbnNpb24gdGhyb3dzKS4gUmVzdG9yZSBcdTIxOTIgcGFzc2VzLlxuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQgcmVnaXN0ZXJFeHRlbnNpb24gZnJvbSBcIi4uL2luZGV4LnRzXCI7XG5cbnR5cGUgUmVnaXN0ZXJGbiA9IChuYW1lOiBzdHJpbmcsIGRlZjogdW5rbm93bikgPT4gdm9pZDtcblxuZnVuY3Rpb24gbWFrZVBpKG92ZXJyaWRlczogUGFydGlhbDxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4gPSB7fSkge1xuICBjb25zdCByZWdpc3RlcmVkOiBBcnJheTxbc3RyaW5nLCB1bmtub3duXT4gPSBbXTtcbiAgY29uc3QgcmVnaXN0ZXJDb21tYW5kOiBSZWdpc3RlckZuID0gKG5hbWUsIGRlZikgPT4ge1xuICAgIHJlZ2lzdGVyZWQucHVzaChbbmFtZSwgZGVmXSk7XG4gIH07XG4gIGNvbnN0IGV2ZW50cyA9IHtcbiAgICBvbjogKCkgPT4ge30sXG4gICAgb2ZmOiAoKSA9PiB7fSxcbiAgICBlbWl0OiAoKSA9PiB7fSxcbiAgfTtcbiAgY29uc3QgcGkgPSB7XG4gICAgcmVnaXN0ZXJDb21tYW5kLFxuICAgIHJlZ2lzdGVyVG9vbDogKCkgPT4ge30sXG4gICAgcmVnaXN0ZXJIb29rOiAoKSA9PiB7fSxcbiAgICByZWdpc3RlclNob3J0Y3V0OiAoKSA9PiB7fSxcbiAgICBldmVudHMsXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9O1xuICByZXR1cm4geyBwaSwgcmVnaXN0ZXJlZCB9O1xufVxuXG5kZXNjcmliZShcImV4dGVuc2lvbiBib290c3RyYXAgaXNvbGF0aW9uICgjNDE2OCwgIzQxNzIpXCIsICgpID0+IHtcbiAgdGVzdChcImhhcHB5IHBhdGg6IC9nc2QgY29tbWFuZCBpcyByZWdpc3RlcmVkXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB7IHBpLCByZWdpc3RlcmVkIH0gPSBtYWtlUGkoKTtcbiAgICBhd2FpdCByZWdpc3RlckV4dGVuc2lvbihwaSBhcyBhbnkpO1xuICAgIGNvbnN0IG5hbWVzID0gcmVnaXN0ZXJlZC5tYXAoKFtuXSkgPT4gbik7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgbmFtZXMuaW5jbHVkZXMoXCJnc2RcIiksXG4gICAgICBgZXhwZWN0ZWQgJ2dzZCcgaW4gcmVnaXN0ZXJlZCBjb21tYW5kcywgZ290ICR7SlNPTi5zdHJpbmdpZnkobmFtZXMpfWAsXG4gICAgKTtcbiAgfSk7XG5cbiAgdGVzdChcImRlZ3JhZGVkIHBhdGg6IC9nc2Qgc3RpbGwgcmVnaXN0ZXJlZCB3aGVuIHJlZ2lzdGVyQ29tbWFuZCB0aHJvd3MgZm9yIG5vbi1jb3JlIGNvbW1hbmRzXCIsIGFzeW5jICgpID0+IHtcbiAgICAvLyBTaW11bGF0ZSB0aGUgV2luZG93cy1zdHlsZSBmYWlsdXJlOiBwaS5yZWdpc3RlckNvbW1hbmQgdGhyb3dzIGZvciBhXG4gICAgLy8gc3BlY2lmaWMgbm9uLWNvcmUgY29tbWFuZCAoJ2tpbGwnIGlzIGEgc2ltcGxlIHRhcmdldCByZWdpc3RlcmVkIGJ5XG4gICAgLy8gdGhlIGZ1bGwgYm9vdHN0cmFwKSBcdTIwMTQgdGhlIGZ1bGwgYm9vdHN0cmFwIG11c3QgZmFpbCBidXQgL2dzZCBtdXN0XG4gICAgLy8gYWxyZWFkeSBiZSByZWdpc3RlcmVkIGJlZm9yZSB0aGUgZmFpbHVyZSBvY2N1cnMuXG4gICAgY29uc3QgcmVnaXN0ZXJlZDogQXJyYXk8W3N0cmluZywgdW5rbm93bl0+ID0gW107XG4gICAgY29uc3QgcGkgPSB7XG4gICAgICByZWdpc3RlckNvbW1hbmQ6IChuYW1lOiBzdHJpbmcsIGRlZjogdW5rbm93bikgPT4ge1xuICAgICAgICBpZiAobmFtZSAhPT0gXCJnc2RcIiAmJiBuYW1lICE9PSBcIndvcmt0cmVlXCIgJiYgbmFtZSAhPT0gXCJleGl0XCIpIHtcbiAgICAgICAgICAvLyBMZXQgL2dzZCwgL3dvcmt0cmVlLCAvZXhpdCBzdWNjZWVkICh0aGV5IHByZWNlZGUgdGhlIG5vbi1jb3JlXG4gICAgICAgICAgLy8gbG9vcCk7IHRocm93IHdoZW4gdGhlIGZpcnN0IG5vbi1jb3JlIHJlZ2lzdHJhdGlvbiBmaXJlcy5cbiAgICAgICAgfVxuICAgICAgICBpZiAobmFtZSA9PT0gXCJraWxsXCIpIHRocm93IG5ldyBFcnJvcihcInNpbXVsYXRlZCB3aW5kb3dzIGZhaWx1cmVcIik7XG4gICAgICAgIHJlZ2lzdGVyZWQucHVzaChbbmFtZSwgZGVmXSk7XG4gICAgICB9LFxuICAgICAgcmVnaXN0ZXJUb29sOiAoKSA9PiB7fSxcbiAgICAgIHJlZ2lzdGVySG9vazogKCkgPT4ge30sXG4gICAgICByZWdpc3RlclNob3J0Y3V0OiAoKSA9PiB7fSxcbiAgICAgIGV2ZW50czogeyBvbjogKCkgPT4ge30sIG9mZjogKCkgPT4ge30sIGVtaXQ6ICgpID0+IHt9IH0sXG4gICAgfTtcblxuICAgIC8vIHJlZ2lzdGVyRXh0ZW5zaW9uIG11c3Qgbm90IHRocm93IFx1MjAxNCB0aGUgb3V0ZXIgdHJ5L2NhdGNoIGluIGluZGV4LnRzXG4gICAgLy8gc3dhbGxvd3MgYm9vdHN0cmFwIGZhaWx1cmVzIGFmdGVyIC9nc2QgaXMgYWxyZWFkeSByZWdpc3RlcmVkLlxuICAgIGF3YWl0IHJlZ2lzdGVyRXh0ZW5zaW9uKHBpIGFzIGFueSk7XG5cbiAgICBjb25zdCBuYW1lcyA9IHJlZ2lzdGVyZWQubWFwKChbbl0pID0+IG4pO1xuICAgIGFzc2VydC5vayhcbiAgICAgIG5hbWVzLmluY2x1ZGVzKFwiZ3NkXCIpLFxuICAgICAgXCJleHBlY3RlZCAnZ3NkJyB0byBiZSByZWdpc3RlcmVkIGV2ZW4gd2hlbiBhIGxhdGVyIGNvbW1hbmQgcmVnaXN0cmF0aW9uIHRocm93c1wiLFxuICAgICk7XG4gIH0pO1xuXG4gIHRlc3QoXCJkZWdyYWRlZCBwYXRoOiAvZ3NkIHJlZ2lzdGVyZWQgQkVGT1JFIGFueSBub24tY29yZSBjb21tYW5kXCIsIGFzeW5jICgpID0+IHtcbiAgICAvLyBPcmRlcmluZyBndWFyZDogdGhlIGZpcnN0IHJlZ2lzdGVyQ29tbWFuZCBjYWxsIG11c3QgYmUgZm9yICdnc2QnLFxuICAgIC8vIGJlY2F1c2UgaW5kZXgudHMgYXdhaXRzIHJlZ2lzdGVyR1NEQ29tbWFuZChwaSkgYmVmb3JlIGltcG9ydGluZ1xuICAgIC8vIHJlZ2lzdGVyLWV4dGVuc2lvbi4gUmVncmVzc2lvbiBzY2VuYXJpbzogaWYgYSBmdXR1cmUgcmVmYWN0b3IgbW92ZXNcbiAgICAvLyByZWdpc3RlckdTRENvbW1hbmQgaW50byB0aGUgdHJ5IGJsb2NrIG9yIGFmdGVyIG90aGVyIHJlZ2lzdHJhdGlvbnMsXG4gICAgLy8gYSBmYWlsdXJlIGluIHRob3NlIGVhcmxpZXIgcmVnaXN0cmF0aW9ucyB3b3VsZCB0YWtlIC9nc2QgZG93biB0b28uXG4gICAgY29uc3QgY2FsbHM6IHN0cmluZ1tdID0gW107XG4gICAgY29uc3QgcGkgPSB7XG4gICAgICByZWdpc3RlckNvbW1hbmQ6IChuYW1lOiBzdHJpbmcpID0+IHtcbiAgICAgICAgY2FsbHMucHVzaChuYW1lKTtcbiAgICAgIH0sXG4gICAgICByZWdpc3RlclRvb2w6ICgpID0+IHt9LFxuICAgICAgcmVnaXN0ZXJIb29rOiAoKSA9PiB7fSxcbiAgICAgIHJlZ2lzdGVyU2hvcnRjdXQ6ICgpID0+IHt9LFxuICAgICAgZXZlbnRzOiB7IG9uOiAoKSA9PiB7fSwgb2ZmOiAoKSA9PiB7fSwgZW1pdDogKCkgPT4ge30gfSxcbiAgICB9O1xuICAgIGF3YWl0IHJlZ2lzdGVyRXh0ZW5zaW9uKHBpIGFzIGFueSk7XG4gICAgYXNzZXJ0Lm9rKGNhbGxzLmxlbmd0aCA+IDAsIFwiZXhwZWN0ZWQgYXQgbGVhc3Qgb25lIHJlZ2lzdGVyQ29tbWFuZCBjYWxsXCIpO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIGNhbGxzWzBdLFxuICAgICAgXCJnc2RcIixcbiAgICAgIGBleHBlY3RlZCAnZ3NkJyB0byBiZSB0aGUgZmlyc3QgY29tbWFuZCByZWdpc3RlcmVkLCBnb3QgJHtKU09OLnN0cmluZ2lmeShjYWxscyl9YCxcbiAgICApO1xuICB9KTtcbn0pO1xuXG4vLyBCZWhhdmlvdXJhbCBjb250cmFjdCBmb3IgcmVnaXN0ZXJHc2RFeHRlbnNpb24gaXRzZWxmOiBlYWNoIG5vbi1jb3JlXG4vLyByZWdpc3RyYXRpb24gaXMgd3JhcHBlZCBpbiBpdHMgb3duIHRyeS9jYXRjaCBzbyBvbmUgZmFpbHVyZSBkb2VzIG5vdFxuLy8gcHJldmVudCBzaWJsaW5ncyBmcm9tIGxvYWRpbmcuXG5cbmltcG9ydCB7IHJlZ2lzdGVyR3NkRXh0ZW5zaW9uIH0gZnJvbSBcIi4uL2Jvb3RzdHJhcC9yZWdpc3Rlci1leHRlbnNpb24udHNcIjtcblxuZGVzY3JpYmUoXCJyZWdpc3RlckdzZEV4dGVuc2lvbiBkZWZlbnNpdmUgcmVnaXN0cmF0aW9uXCIsICgpID0+IHtcbiAgdGVzdChcImEgZmFpbGluZyBzaG9ydGN1dCByZWdpc3RyYXRpb24gZG9lcyBub3QgcHJldmVudCBraWxsIGNvbW1hbmQgcmVnaXN0cmF0aW9uXCIsIGFzeW5jICgpID0+IHtcbiAgICAvLyBgc2hvcnRjdXRzYCBpcyByZWdpc3RlcmVkIHZpYSBhIG5vbi1jcml0aWNhbCBzbG90IHRoYXQgaXMgd3JhcHBlZCBpblxuICAgIC8vIGl0cyBvd24gdHJ5L2NhdGNoLiBga2lsbGAgaXMgcmVnaXN0ZXJlZCBiZWZvcmUgdGhlIG5vbi1jcml0aWNhbCBsb29wXG4gICAgLy8gYXMgYSBjcml0aWNhbCBjb21tYW5kLiBTaW11bGF0ZTogcmVnaXN0ZXJTaG9ydGN1dCB0aHJvd3MuIEV4cGVjdDpcbiAgICAvLyAna2lsbCcgaXMgc3RpbGwgcmVnaXN0ZXJlZCwgcmVnaXN0ZXJHc2RFeHRlbnNpb24gZG9lcyBub3QgdGhyb3cuXG4gICAgY29uc3QgcmVnaXN0ZXJlZDogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBwaSA9IHtcbiAgICAgIHJlZ2lzdGVyQ29tbWFuZDogKG5hbWU6IHN0cmluZykgPT4ge1xuICAgICAgICByZWdpc3RlcmVkLnB1c2gobmFtZSk7XG4gICAgICB9LFxuICAgICAgcmVnaXN0ZXJUb29sOiAoKSA9PiB7fSxcbiAgICAgIHJlZ2lzdGVySG9vazogKCkgPT4ge30sXG4gICAgICByZWdpc3RlclNob3J0Y3V0OiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcInNpbXVsYXRlZCBwbGF0Zm9ybS1zcGVjaWZpYyBzaG9ydGN1dCBmYWlsdXJlXCIpO1xuICAgICAgfSxcbiAgICAgIGV2ZW50czogeyBvbjogKCkgPT4ge30sIG9mZjogKCkgPT4ge30sIGVtaXQ6ICgpID0+IHt9IH0sXG4gICAgfTtcbiAgICBhc3NlcnQuZG9lc05vdFRocm93KCgpID0+IHJlZ2lzdGVyR3NkRXh0ZW5zaW9uKHBpIGFzIGFueSkpO1xuICAgIGFzc2VydC5vayhcbiAgICAgIHJlZ2lzdGVyZWQuaW5jbHVkZXMoXCJraWxsXCIpLFxuICAgICAgYGV4cGVjdGVkICdraWxsJyB0byBiZSByZWdpc3RlcmVkIGRlc3BpdGUgc2hvcnRjdXQgZmFpbHVyZSwgZ290ICR7SlNPTi5zdHJpbmdpZnkocmVnaXN0ZXJlZCl9YCxcbiAgICApO1xuICB9KTtcblxuICB0ZXN0KFwiZG9lcyBOT1QgcmVnaXN0ZXIgL2dzZCAoY2FsbGVyJ3MgcmVzcG9uc2liaWxpdHksIGF2b2lkcyBkb3VibGUtcmVnaXN0cmF0aW9uKVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVnaXN0ZXJlZDogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBwaSA9IHtcbiAgICAgIHJlZ2lzdGVyQ29tbWFuZDogKG5hbWU6IHN0cmluZykgPT4ge1xuICAgICAgICByZWdpc3RlcmVkLnB1c2gobmFtZSk7XG4gICAgICB9LFxuICAgICAgcmVnaXN0ZXJUb29sOiAoKSA9PiB7fSxcbiAgICAgIHJlZ2lzdGVySG9vazogKCkgPT4ge30sXG4gICAgICByZWdpc3RlclNob3J0Y3V0OiAoKSA9PiB7fSxcbiAgICAgIGV2ZW50czogeyBvbjogKCkgPT4ge30sIG9mZjogKCkgPT4ge30sIGVtaXQ6ICgpID0+IHt9IH0sXG4gICAgfTtcbiAgICByZWdpc3RlckdzZEV4dGVuc2lvbihwaSBhcyBhbnkpO1xuICAgIGFzc2VydC5vayhcbiAgICAgICFyZWdpc3RlcmVkLmluY2x1ZGVzKFwiZ3NkXCIpLFxuICAgICAgYHJlZ2lzdGVyR3NkRXh0ZW5zaW9uIG11c3QgTk9UIHJlZ2lzdGVyICdnc2QnIChpdCBpcyByZWdpc3RlcmVkIHNlcGFyYXRlbHkgYnkgaW5kZXgudHMpLCBnb3QgJHtKU09OLnN0cmluZ2lmeShyZWdpc3RlcmVkKX1gLFxuICAgICk7XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFrQkEsU0FBUyxVQUFVLFlBQVk7QUFDL0IsT0FBTyxZQUFZO0FBRW5CLE9BQU8sdUJBQXVCO0FBSTlCLFNBQVMsT0FBTyxZQUE4QyxDQUFDLEdBQUc7QUFDaEUsUUFBTSxhQUF1QyxDQUFDO0FBQzlDLFFBQU0sa0JBQThCLENBQUMsTUFBTSxRQUFRO0FBQ2pELGVBQVcsS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDO0FBQUEsRUFDN0I7QUFDQSxRQUFNLFNBQVM7QUFBQSxJQUNiLElBQUksTUFBTTtBQUFBLElBQUM7QUFBQSxJQUNYLEtBQUssTUFBTTtBQUFBLElBQUM7QUFBQSxJQUNaLE1BQU0sTUFBTTtBQUFBLElBQUM7QUFBQSxFQUNmO0FBQ0EsUUFBTSxLQUFLO0FBQUEsSUFDVDtBQUFBLElBQ0EsY0FB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
