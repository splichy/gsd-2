import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import ollamaExtension, { probeAndRegister } from "./index.js";
function makeMockPi() {
  const calls = {
    registerProvider: [],
    unregisterProvider: [],
    registerTool: [],
    onHandlers: /* @__PURE__ */ new Map()
  };
  const pi = {
    registerProvider(id, spec) {
      calls.registerProvider.push([id, spec]);
    },
    unregisterProvider(id) {
      calls.unregisterProvider.push(id);
    },
    registerTool(tool) {
      calls.registerTool.push(tool);
    },
    registerCommand() {
    },
    on(event, handler) {
      if (!calls.onHandlers.has(event)) calls.onHandlers.set(event, []);
      calls.onHandlers.get(event).push(handler);
    }
  };
  return { pi, calls };
}
let server;
let serverMode = "empty";
let savedHost;
before(async () => {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200);
      res.end("Ollama is running");
      return;
    }
    if (req.method === "GET" && req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (serverMode === "empty") {
        res.end(JSON.stringify({ models: [] }));
      } else {
        res.end(
          JSON.stringify({
            models: [
              {
                name: "llama3:latest",
                modified_at: (/* @__PURE__ */ new Date()).toISOString(),
                size: 1e6,
                digest: "abc",
                details: {
                  parent_model: "",
                  format: "gguf",
                  family: "llama",
                  families: ["llama"],
                  parameter_size: "8B",
                  quantization_level: "Q4_0"
                }
              }
            ]
          })
        );
      }
      return;
    }
    if (req.method === "POST" && req.url === "/api/show") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          modelfile: "",
          parameters: "",
          template: "",
          details: {
            parent_model: "",
            format: "gguf",
            family: "llama",
            families: ["llama"],
            parameter_size: "8B",
            quantization_level: "Q4_0"
          },
          model_info: { "llama.context_length": 8192 },
          capabilities: []
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  savedHost = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = `http://127.0.0.1:${port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
  if (savedHost === void 0) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = savedHost;
});
test("probeAndRegister returns false when no Ollama models are discovered", async () => {
  serverMode = "empty";
  const { pi, calls } = makeMockPi();
  const found = await probeAndRegister(pi);
  assert.equal(found, false, "no models should be reported as unavailable");
  assert.equal(
    calls.registerProvider.length,
    0,
    "provider must not be registered when no models are discoverable"
  );
});
test("probeAndRegister returns true when Ollama has at least one model", async () => {
  serverMode = "loaded";
  const { pi, calls } = makeMockPi();
  const found = await probeAndRegister(pi);
  assert.equal(found, true);
  assert.equal(calls.registerProvider.length, 1);
});
test("interactive session sets ollama status based on probeAndRegister result", async () => {
  {
    serverMode = "loaded";
    const { pi, calls } = makeMockPi();
    ollamaExtension(pi);
    const handlers = calls.onHandlers.get("session_start") ?? [];
    assert.equal(handlers.length, 1, "extension registers one session_start handler");
    const statusCalls = [];
    const ctx = {
      hasUI: true,
      ui: {
        setStatus: (slot, value) => {
          statusCalls.push([slot, value]);
        },
        notify: () => {
        }
      }
    };
    await handlers[0]({}, ctx);
    for (let i = 0; i < 50; i++) {
      if (statusCalls.length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(
      statusCalls,
      [["ollama", "Ollama"]],
      "status should be set to 'Ollama' when probe reports available"
    );
  }
  {
    serverMode = "empty";
    const { pi, calls } = makeMockPi();
    ollamaExtension(pi);
    const handlers = calls.onHandlers.get("session_start") ?? [];
    const statusCalls = [];
    const ctx = {
      hasUI: true,
      ui: {
        setStatus: (slot, value) => {
          statusCalls.push([slot, value]);
        },
        notify: () => {
        }
      }
    };
    await handlers[0]({}, ctx);
    for (let i = 0; i < 50; i++) {
      if (statusCalls.length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(
      statusCalls,
      [["ollama", void 0]],
      "status must be cleared (undefined) when probe reports unavailable"
    );
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL29sbGFtYS9vbGxhbWEtc3RhdHVzLWluZGljYXRvci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlZ3Jlc3Npb24gdGVzdDogZG9uJ3Qgc2hvdyBhbiBPbGxhbWEgZm9vdGVyIHN0YXR1cyB1bmxlc3MgT2xsYW1hIGlzXG4gKiBhY3R1YWxseSB1c2FibGUgKHJ1bm5pbmcgd2l0aCBhdCBsZWFzdCBvbmUgZGlzY292ZXJlZCBtb2RlbCkuXG4gKlxuICogQmVoYXZpb3VyIHRlc3RzOlxuICogICAxLiBwcm9iZUFuZFJlZ2lzdGVyIHJldHVybnMgZmFsc2Ugd2hlbiAvYXBpL3RhZ3MgcmV0dXJucyBubyBtb2RlbHNcbiAqICAgICAgKHJ1bm5pbmctd2l0aG91dC1tb2RlbHMgc2hvdWxkIG5vdCBiZSB0cmVhdGVkIGFzIGF2YWlsYWJsZSkuXG4gKiAgIDIuIFRoZSBzZXNzaW9uX3N0YXJ0IGhhbmRsZXIgY2FsbHMgY3R4LnVpLnNldFN0YXR1cyhcIm9sbGFtYVwiLCBcIk9sbGFtYVwiKVxuICogICAgICB3aGVuIHByb2JlQW5kUmVnaXN0ZXIgcmVwb3J0cyB0cnVlLCBhbmQgc2V0U3RhdHVzKFwib2xsYW1hXCIsIHVuZGVmaW5lZClcbiAqICAgICAgd2hlbiBpdCByZXBvcnRzIGZhbHNlIFx1MjAxNCBrZWVwaW5nIHRoZSBmb290ZXIgY2xlYW4gb24gdW5hdmFpbGFibGUgT2xsYW1hLlxuICovXG5pbXBvcnQgeyB0ZXN0LCBiZWZvcmUsIGFmdGVyIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBjcmVhdGVTZXJ2ZXIsIHR5cGUgU2VydmVyIH0gZnJvbSBcIm5vZGU6aHR0cFwiO1xuaW1wb3J0IHR5cGUgeyBBZGRyZXNzSW5mbyB9IGZyb20gXCJub2RlOm5ldFwiO1xuXG5pbXBvcnQgb2xsYW1hRXh0ZW5zaW9uLCB7IHByb2JlQW5kUmVnaXN0ZXIgfSBmcm9tIFwiLi9pbmRleC5qc1wiO1xuXG50eXBlIFJlZ2lzdGVyQ2FsbCA9IFtzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+XTtcblxuZnVuY3Rpb24gbWFrZU1vY2tQaSgpIHtcblx0Y29uc3QgY2FsbHM6IHtcblx0XHRyZWdpc3RlclByb3ZpZGVyOiBSZWdpc3RlckNhbGxbXTtcblx0XHR1bnJlZ2lzdGVyUHJvdmlkZXI6IHN0cmluZ1tdO1xuXHRcdHJlZ2lzdGVyVG9vbDogdW5rbm93bltdO1xuXHRcdG9uSGFuZGxlcnM6IE1hcDxzdHJpbmcsIEFycmF5PCguLi5hcmdzOiB1bmtub3duW10pID0+IHVua25vd24+Pjtcblx0fSA9IHtcblx0XHRyZWdpc3RlclByb3ZpZGVyOiBbXSxcblx0XHR1bnJlZ2lzdGVyUHJvdmlkZXI6IFtdLFxuXHRcdHJlZ2lzdGVyVG9vbDogW10sXG5cdFx0b25IYW5kbGVyczogbmV3IE1hcCgpLFxuXHR9O1xuXHRjb25zdCBwaSA9IHtcblx0XHRyZWdpc3RlclByb3ZpZGVyKGlkOiBzdHJpbmcsIHNwZWM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG5cdFx0XHRjYWxscy5yZWdpc3RlclByb3ZpZGVyLnB1c2goW2lkLCBzcGVjXSk7XG5cdFx0fSxcblx0XHR1bnJlZ2lzdGVyUHJvdmlkZXIoaWQ6IHN0cmluZykge1xuXHRcdFx0Y2FsbHMudW5yZWdpc3RlclByb3ZpZGVyLnB1c2goaWQpO1xuXHRcdH0sXG5cdFx0cmVnaXN0ZXJUb29sKHRvb2w6IHVua25vd24pIHtcblx0XHRcdGNhbGxzLnJlZ2lzdGVyVG9vbC5wdXNoKHRvb2wpO1xuXHRcdH0sXG5cdFx0cmVnaXN0ZXJDb21tYW5kKCkge1xuXHRcdFx0Lyogbm8tb3AgKi9cblx0XHR9LFxuXHRcdG9uKGV2ZW50OiBzdHJpbmcsIGhhbmRsZXI6ICguLi5hcmdzOiB1bmtub3duW10pID0+IHVua25vd24pIHtcblx0XHRcdGlmICghY2FsbHMub25IYW5kbGVycy5oYXMoZXZlbnQpKSBjYWxscy5vbkhhbmRsZXJzLnNldChldmVudCwgW10pO1xuXHRcdFx0Y2FsbHMub25IYW5kbGVycy5nZXQoZXZlbnQpIS5wdXNoKGhhbmRsZXIpO1xuXHRcdH0sXG5cdH0gYXMgdW5rbm93biBhcyBQYXJhbWV0ZXJzPHR5cGVvZiBwcm9iZUFuZFJlZ2lzdGVyPlswXTtcblx0cmV0dXJuIHsgcGksIGNhbGxzIH07XG59XG5cbi8vIFNlcnZlciBtb2RlOlxuLy8gICBcImVtcHR5XCIgIFx1MjE5MiAvYXBpL3RhZ3MgcmV0dXJucyB7IG1vZGVsczogW10gfVxuLy8gICBcImxvYWRlZFwiIFx1MjE5MiAvYXBpL3RhZ3MgcmV0dXJucyBvbmUgbW9kZWwgKyAvYXBpL3Nob3cgd2l0aCA4ayBjb250ZXh0XG5sZXQgc2VydmVyOiBTZXJ2ZXI7XG5sZXQgc2VydmVyTW9kZTogXCJlbXB0eVwiIHwgXCJsb2FkZWRcIiA9IFwiZW1wdHlcIjtcbmxldCBzYXZlZEhvc3Q6IHN0cmluZyB8IHVuZGVmaW5lZDtcblxuYmVmb3JlKGFzeW5jICgpID0+IHtcblx0c2VydmVyID0gY3JlYXRlU2VydmVyKChyZXEsIHJlcykgPT4ge1xuXHRcdGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHJlcS51cmwgPT09IFwiL1wiKSB7XG5cdFx0XHRyZXMud3JpdGVIZWFkKDIwMCk7XG5cdFx0XHRyZXMuZW5kKFwiT2xsYW1hIGlzIHJ1bm5pbmdcIik7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHJlcS51cmwgPT09IFwiL2FwaS90YWdzXCIpIHtcblx0XHRcdHJlcy53cml0ZUhlYWQoMjAwLCB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0pO1xuXHRcdFx0aWYgKHNlcnZlck1vZGUgPT09IFwiZW1wdHlcIikge1xuXHRcdFx0XHRyZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgbW9kZWxzOiBbXSB9KSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRyZXMuZW5kKFxuXHRcdFx0XHRcdEpTT04uc3RyaW5naWZ5KHtcblx0XHRcdFx0XHRcdG1vZGVsczogW1xuXHRcdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdFx0bmFtZTogXCJsbGFtYTM6bGF0ZXN0XCIsXG5cdFx0XHRcdFx0XHRcdFx0bW9kaWZpZWRfYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRcdFx0XHRcdFx0XHRzaXplOiAxXzAwMF8wMDAsXG5cdFx0XHRcdFx0XHRcdFx0ZGlnZXN0OiBcImFiY1wiLFxuXHRcdFx0XHRcdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHRcdFx0XHRcdHBhcmVudF9tb2RlbDogXCJcIixcblx0XHRcdFx0XHRcdFx0XHRcdGZvcm1hdDogXCJnZ3VmXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRmYW1pbHk6IFwibGxhbWFcIixcblx0XHRcdFx0XHRcdFx0XHRcdGZhbWlsaWVzOiBbXCJsbGFtYVwiXSxcblx0XHRcdFx0XHRcdFx0XHRcdHBhcmFtZXRlcl9zaXplOiBcIjhCXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRxdWFudGl6YXRpb25fbGV2ZWw6IFwiUTRfMFwiLFxuXHRcdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRdLFxuXHRcdFx0XHRcdH0pLFxuXHRcdFx0XHQpO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAocmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcmVxLnVybCA9PT0gXCIvYXBpL3Nob3dcIikge1xuXHRcdFx0cmVzLndyaXRlSGVhZCgyMDAsIHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSk7XG5cdFx0XHRyZXMuZW5kKFxuXHRcdFx0XHRKU09OLnN0cmluZ2lmeSh7XG5cdFx0XHRcdFx0bW9kZWxmaWxlOiBcIlwiLFxuXHRcdFx0XHRcdHBhcmFtZXRlcnM6IFwiXCIsXG5cdFx0XHRcdFx0dGVtcGxhdGU6IFwiXCIsXG5cdFx0XHRcdFx0ZGV0YWlsczoge1xuXHRcdFx0XHRcdFx0cGFyZW50X21vZGVsOiBcIlwiLFxuXHRcdFx0XHRcdFx0Zm9ybWF0OiBcImdndWZcIixcblx0XHRcdFx0XHRcdGZhbWlseTogXCJsbGFtYVwiLFxuXHRcdFx0XHRcdFx0ZmFtaWxpZXM6IFtcImxsYW1hXCJdLFxuXHRcdFx0XHRcdFx0cGFyYW1ldGVyX3NpemU6IFwiOEJcIixcblx0XHRcdFx0XHRcdHF1YW50aXphdGlvbl9sZXZlbDogXCJRNF8wXCIsXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRtb2RlbF9pbmZvOiB7IFwibGxhbWEuY29udGV4dF9sZW5ndGhcIjogODE5MiB9LFxuXHRcdFx0XHRcdGNhcGFiaWxpdGllczogW10sXG5cdFx0XHRcdH0pLFxuXHRcdFx0KTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0cmVzLndyaXRlSGVhZCg0MDQpO1xuXHRcdHJlcy5lbmQoKTtcblx0fSk7XG5cdGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiBzZXJ2ZXIubGlzdGVuKDAsIFwiMTI3LjAuMC4xXCIsIHJlc29sdmUpKTtcblx0Y29uc3QgeyBwb3J0IH0gPSBzZXJ2ZXIuYWRkcmVzcygpIGFzIEFkZHJlc3NJbmZvO1xuXHRzYXZlZEhvc3QgPSBwcm9jZXNzLmVudi5PTExBTUFfSE9TVDtcblx0cHJvY2Vzcy5lbnYuT0xMQU1BX0hPU1QgPSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YDtcbn0pO1xuXG5hZnRlcihhc3luYyAoKSA9PiB7XG5cdGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiBzZXJ2ZXIuY2xvc2UoKCkgPT4gcmVzb2x2ZSgpKSk7XG5cdGlmIChzYXZlZEhvc3QgPT09IHVuZGVmaW5lZCkgZGVsZXRlIHByb2Nlc3MuZW52Lk9MTEFNQV9IT1NUO1xuXHRlbHNlIHByb2Nlc3MuZW52Lk9MTEFNQV9IT1NUID0gc2F2ZWRIb3N0O1xufSk7XG5cbnRlc3QoXCJwcm9iZUFuZFJlZ2lzdGVyIHJldHVybnMgZmFsc2Ugd2hlbiBubyBPbGxhbWEgbW9kZWxzIGFyZSBkaXNjb3ZlcmVkXCIsIGFzeW5jICgpID0+IHtcblx0c2VydmVyTW9kZSA9IFwiZW1wdHlcIjtcblx0Y29uc3QgeyBwaSwgY2FsbHMgfSA9IG1ha2VNb2NrUGkoKTtcblx0Y29uc3QgZm91bmQgPSBhd2FpdCBwcm9iZUFuZFJlZ2lzdGVyKHBpKTtcblx0YXNzZXJ0LmVxdWFsKGZvdW5kLCBmYWxzZSwgXCJubyBtb2RlbHMgc2hvdWxkIGJlIHJlcG9ydGVkIGFzIHVuYXZhaWxhYmxlXCIpO1xuXHRhc3NlcnQuZXF1YWwoXG5cdFx0Y2FsbHMucmVnaXN0ZXJQcm92aWRlci5sZW5ndGgsXG5cdFx0MCxcblx0XHRcInByb3ZpZGVyIG11c3Qgbm90IGJlIHJlZ2lzdGVyZWQgd2hlbiBubyBtb2RlbHMgYXJlIGRpc2NvdmVyYWJsZVwiLFxuXHQpO1xufSk7XG5cbnRlc3QoXCJwcm9iZUFuZFJlZ2lzdGVyIHJldHVybnMgdHJ1ZSB3aGVuIE9sbGFtYSBoYXMgYXQgbGVhc3Qgb25lIG1vZGVsXCIsIGFzeW5jICgpID0+IHtcblx0c2VydmVyTW9kZSA9IFwibG9hZGVkXCI7XG5cdGNvbnN0IHsgcGksIGNhbGxzIH0gPSBtYWtlTW9ja1BpKCk7XG5cdGNvbnN0IGZvdW5kID0gYXdhaXQgcHJvYmVBbmRSZWdpc3RlcihwaSk7XG5cdGFzc2VydC5lcXVhbChmb3VuZCwgdHJ1ZSk7XG5cdGFzc2VydC5lcXVhbChjYWxscy5yZWdpc3RlclByb3ZpZGVyLmxlbmd0aCwgMSk7XG59KTtcblxudGVzdChcImludGVyYWN0aXZlIHNlc3Npb24gc2V0cyBvbGxhbWEgc3RhdHVzIGJhc2VkIG9uIHByb2JlQW5kUmVnaXN0ZXIgcmVzdWx0XCIsIGFzeW5jICgpID0+IHtcblx0Ly8gTG9hZCBjYXNlOiBzdGF0dXMgc2hvdWxkIGJlIHNldCB0byBcIk9sbGFtYVwiLlxuXHR7XG5cdFx0c2VydmVyTW9kZSA9IFwibG9hZGVkXCI7XG5cdFx0Y29uc3QgeyBwaSwgY2FsbHMgfSA9IG1ha2VNb2NrUGkoKTtcblx0XHRvbGxhbWFFeHRlbnNpb24ocGkpO1xuXHRcdGNvbnN0IGhhbmRsZXJzID0gY2FsbHMub25IYW5kbGVycy5nZXQoXCJzZXNzaW9uX3N0YXJ0XCIpID8/IFtdO1xuXHRcdGFzc2VydC5lcXVhbChoYW5kbGVycy5sZW5ndGgsIDEsIFwiZXh0ZW5zaW9uIHJlZ2lzdGVycyBvbmUgc2Vzc2lvbl9zdGFydCBoYW5kbGVyXCIpO1xuXG5cdFx0Y29uc3Qgc3RhdHVzQ2FsbHM6IEFycmF5PFtzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZF0+ID0gW107XG5cdFx0Y29uc3QgY3R4ID0ge1xuXHRcdFx0aGFzVUk6IHRydWUsXG5cdFx0XHR1aToge1xuXHRcdFx0XHRzZXRTdGF0dXM6IChzbG90OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQpID0+IHtcblx0XHRcdFx0XHRzdGF0dXNDYWxscy5wdXNoKFtzbG90LCB2YWx1ZV0pO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHRub3RpZnk6ICgpID0+IHt9LFxuXHRcdFx0fSxcblx0XHR9O1xuXG5cdFx0Ly8gRmlyZSBzZXNzaW9uX3N0YXJ0OyB3YWl0IGEgdGljayBmb3IgdGhlIGludGVybmFsIHByb21pc2UgY2hhaW4gdG8gcmVzb2x2ZS5cblx0XHRhd2FpdCBoYW5kbGVyc1swXSh7fSwgY3R4KTtcblx0XHQvLyBHaXZlIHByb2JlQW5kUmVnaXN0ZXIgKyAudGhlbihzZXRTdGF0dXMpIHRpbWUgdG8gY29tcGxldGUuXG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCA1MDsgaSsrKSB7XG5cdFx0XHRpZiAoc3RhdHVzQ2FsbHMubGVuZ3RoID4gMCkgYnJlYWs7XG5cdFx0XHRhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAyMCkpO1xuXHRcdH1cblx0XHRhc3NlcnQuZGVlcEVxdWFsKFxuXHRcdFx0c3RhdHVzQ2FsbHMsXG5cdFx0XHRbW1wib2xsYW1hXCIsIFwiT2xsYW1hXCJdXSxcblx0XHRcdFwic3RhdHVzIHNob3VsZCBiZSBzZXQgdG8gJ09sbGFtYScgd2hlbiBwcm9iZSByZXBvcnRzIGF2YWlsYWJsZVwiLFxuXHRcdCk7XG5cdH1cblxuXHQvLyBVbmF2YWlsYWJsZSBjYXNlOiBzdGF0dXMgc2hvdWxkIGJlIGNsZWFyZWQgKHVuZGVmaW5lZCkuXG5cdHtcblx0XHRzZXJ2ZXJNb2RlID0gXCJlbXB0eVwiO1xuXHRcdGNvbnN0IHsgcGksIGNhbGxzIH0gPSBtYWtlTW9ja1BpKCk7XG5cdFx0b2xsYW1hRXh0ZW5zaW9uKHBpKTtcblx0XHRjb25zdCBoYW5kbGVycyA9IGNhbGxzLm9uSGFuZGxlcnMuZ2V0KFwic2Vzc2lvbl9zdGFydFwiKSA/PyBbXTtcblxuXHRcdGNvbnN0IHN0YXR1c0NhbGxzOiBBcnJheTxbc3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWRdPiA9IFtdO1xuXHRcdGNvbnN0IGN0eCA9IHtcblx0XHRcdGhhc1VJOiB0cnVlLFxuXHRcdFx0dWk6IHtcblx0XHRcdFx0c2V0U3RhdHVzOiAoc2xvdDogc3RyaW5nLCB2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkKSA9PiB7XG5cdFx0XHRcdFx0c3RhdHVzQ2FsbHMucHVzaChbc2xvdCwgdmFsdWVdKTtcblx0XHRcdFx0fSxcblx0XHRcdFx0bm90aWZ5OiAoKSA9PiB7fSxcblx0XHRcdH0sXG5cdFx0fTtcblxuXHRcdGF3YWl0IGhhbmRsZXJzWzBdKHt9LCBjdHgpO1xuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgNTA7IGkrKykge1xuXHRcdFx0aWYgKHN0YXR1c0NhbGxzLmxlbmd0aCA+IDApIGJyZWFrO1xuXHRcdFx0YXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMjApKTtcblx0XHR9XG5cdFx0YXNzZXJ0LmRlZXBFcXVhbChcblx0XHRcdHN0YXR1c0NhbGxzLFxuXHRcdFx0W1tcIm9sbGFtYVwiLCB1bmRlZmluZWRdXSxcblx0XHRcdFwic3RhdHVzIG11c3QgYmUgY2xlYXJlZCAodW5kZWZpbmVkKSB3aGVuIHByb2JlIHJlcG9ydHMgdW5hdmFpbGFibGVcIixcblx0XHQpO1xuXHR9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVdBLFNBQVMsTUFBTSxRQUFRLGFBQWE7QUFDcEMsT0FBTyxZQUFZO0FBQ25CLFNBQVMsb0JBQWlDO0FBRzFDLE9BQU8sbUJBQW1CLHdCQUF3QjtBQUlsRCxTQUFTLGFBQWE7QUFDckIsUUFBTSxRQUtGO0FBQUEsSUFDSCxrQkFBa0IsQ0FBQztBQUFBLElBQ25CLG9CQUFvQixDQUFDO0FBQUEsSUFDckIsY0FBYyxDQUFDO0FBQUEsSUFDZixZQUFZLG9CQUFJLElBQUk7QUFBQSxFQUNyQjtBQUNBLFFBQU0sS0FBSztBQUFBLElBQ1YsaUJBQWlCLElBQVksTUFBK0I7QUFDM0QsWUFBTSxpQkFBaUIsS0FBSyxDQUFDLElBQUksSUFBSSxDQUFDO0FBQUEsSUFDdkM7QUFBQSxJQUNBLG1CQUFtQixJQUFZO0FBQzlCLFlBQU0sbUJBQW1CLEtBQUssRUFBRTtBQUFBLElBQ2pDO0FBQUEsSUFDQSxhQUFhLE1BQWU7QUFDM0IsWUFBTSxhQUFhLEtBQUssSUFBSTtBQUFBLElBQzdCO0FBQUEsSUFDQSxrQkFBa0I7QUFBQSxJQUVsQjtBQUFBLElBQ0EsR0FBRyxPQUFlLFNBQTBDO0FBQzNELFVBQUksQ0FBQyxNQUFNLFdBQVcsSUFBSSxLQUFLLEVBQUcsT0FBTSxXQUFXLElBQUksT0FBTyxDQUFDLENBQUM7QUFDaEUsWUFBTSxXQUFXLElBQUksS0FBSyxFQUFHLEtBQUssT0FBTztBQUFBLElBQzFDO0FBQUEsRUFDRDtBQUNBLFNBQU8sRUFBRSxJQUFJLE1BQU07QUFDcEI7QUFLQSxJQUFJO0FBQ0osSUFBSSxhQUFpQztBQUNyQyxJQUFJO0FBRUosT0FBTyxZQUFZO0FBQ2xCLFdBQVMsYUFBYSxDQUFDLEtBQUssUUFBUTtBQUNuQyxRQUFJLElBQUksV0FBVyxTQUFTLElBQUksUUFBUSxLQUFLO0FBQzVDLFVBQUksVUFB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
