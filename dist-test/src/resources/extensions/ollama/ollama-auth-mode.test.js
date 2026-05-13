import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { probeAndRegister } from "./index.js";
function makeMockPi() {
  const calls = {
    registerProvider: [],
    unregisterProvider: []
  };
  const pi = {
    registerProvider(id, spec) {
      calls.registerProvider.push([id, spec]);
    },
    unregisterProvider(id) {
      calls.unregisterProvider.push(id);
    }
  };
  return { pi, calls };
}
let server;
let savedHost;
before(async () => {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Ollama is running");
      return;
    }
    if (req.method === "GET" && req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
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
beforeEach(() => {
});
test("Ollama registers with authMode apiKey, not none (#3440)", async () => {
  const { pi, calls } = makeMockPi();
  const found = await probeAndRegister(pi);
  assert.equal(found, true, "probeAndRegister should return true when models are discovered");
  assert.equal(calls.registerProvider.length, 1, "registerProvider should be called exactly once");
  const [providerId, spec] = calls.registerProvider[0];
  assert.equal(providerId, "ollama");
  assert.equal(
    spec.authMode,
    "apiKey",
    "authMode must be apiKey so the core doesn't require streamSimple for every model"
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL29sbGFtYS9vbGxhbWEtYXV0aC1tb2RlLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUmVncmVzc2lvbiB0ZXN0IGZvciAjMzQ0MDogT2xsYW1hIGV4dGVuc2lvbiBtdXN0IHJlZ2lzdGVyIHdpdGhcbiAqIGF1dGhNb2RlIFwiYXBpS2V5XCIgKG5vdCBcIm5vbmVcIiksIG90aGVyd2lzZSB0aGUgY29yZSBiYWlscyBvdXQgYmVjYXVzZVxuICogdGhlIHByb3ZpZGVyIGhhcyBubyBzdHJlYW1TaW1wbGUuXG4gKlxuICogQmVoYXZpb3VyIHRlc3Q6IHNwaW4gdXAgYSBmYWtlIE9sbGFtYSBlbmRwb2ludCwgcG9pbnQgT0xMQU1BX0hPU1QgYXRcbiAqIGl0LCBhbmQgaW52b2tlIHByb2JlQW5kUmVnaXN0ZXIgd2l0aCBhIG1vY2sgcGkuIEFzc2VydCB0aGF0XG4gKiByZWdpc3RlclByb3ZpZGVyIHdhcyBjYWxsZWQgd2l0aCBhdXRoTW9kZSBcImFwaUtleVwiLlxuICovXG5pbXBvcnQgeyB0ZXN0LCBiZWZvcmUsIGFmdGVyLCBiZWZvcmVFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBjcmVhdGVTZXJ2ZXIsIHR5cGUgU2VydmVyIH0gZnJvbSBcIm5vZGU6aHR0cFwiO1xuaW1wb3J0IHR5cGUgeyBBZGRyZXNzSW5mbyB9IGZyb20gXCJub2RlOm5ldFwiO1xuXG5pbXBvcnQgeyBwcm9iZUFuZFJlZ2lzdGVyIH0gZnJvbSBcIi4vaW5kZXguanNcIjtcblxudHlwZSBSZWdpc3RlckNhbGwgPSBbc3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPl07XG5cbmZ1bmN0aW9uIG1ha2VNb2NrUGkoKSB7XG5cdGNvbnN0IGNhbGxzOiB7IHJlZ2lzdGVyUHJvdmlkZXI6IFJlZ2lzdGVyQ2FsbFtdOyB1bnJlZ2lzdGVyUHJvdmlkZXI6IHN0cmluZ1tdIH0gPSB7XG5cdFx0cmVnaXN0ZXJQcm92aWRlcjogW10sXG5cdFx0dW5yZWdpc3RlclByb3ZpZGVyOiBbXSxcblx0fTtcblx0Y29uc3QgcGkgPSB7XG5cdFx0cmVnaXN0ZXJQcm92aWRlcihpZDogc3RyaW5nLCBzcGVjOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuXHRcdFx0Y2FsbHMucmVnaXN0ZXJQcm92aWRlci5wdXNoKFtpZCwgc3BlY10pO1xuXHRcdH0sXG5cdFx0dW5yZWdpc3RlclByb3ZpZGVyKGlkOiBzdHJpbmcpIHtcblx0XHRcdGNhbGxzLnVucmVnaXN0ZXJQcm92aWRlci5wdXNoKGlkKTtcblx0XHR9LFxuXHR9IGFzIHVua25vd24gYXMgUGFyYW1ldGVyczx0eXBlb2YgcHJvYmVBbmRSZWdpc3Rlcj5bMF07XG5cdHJldHVybiB7IHBpLCBjYWxscyB9O1xufVxuXG5sZXQgc2VydmVyOiBTZXJ2ZXI7XG5sZXQgc2F2ZWRIb3N0OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cbmJlZm9yZShhc3luYyAoKSA9PiB7XG5cdC8vIEZha2UgT2xsYW1hIGVuZHBvaW50IHRoYXQ6XG5cdC8vICAgR0VUIC8gICAgICAgICAgXHUyMTkyIDIwMCAoaXNSdW5uaW5nIHByb2JlKVxuXHQvLyAgIEdFVCAvYXBpL3RhZ3MgIFx1MjE5MiBvbmUgbW9kZWxcblx0Ly8gICBQT1NUIC9hcGkvc2hvdyBcdTIxOTIgbWluaW1hbCBjYXBhYmlsaXR5IGluZm9cblx0c2VydmVyID0gY3JlYXRlU2VydmVyKChyZXEsIHJlcykgPT4ge1xuXHRcdGlmIChyZXEubWV0aG9kID09PSBcIkdFVFwiICYmIHJlcS51cmwgPT09IFwiL1wiKSB7XG5cdFx0XHRyZXMud3JpdGVIZWFkKDIwMCwgeyBcIkNvbnRlbnQtVHlwZVwiOiBcInRleHQvcGxhaW5cIiB9KTtcblx0XHRcdHJlcy5lbmQoXCJPbGxhbWEgaXMgcnVubmluZ1wiKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0aWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcmVxLnVybCA9PT0gXCIvYXBpL3RhZ3NcIikge1xuXHRcdFx0cmVzLndyaXRlSGVhZCgyMDAsIHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSk7XG5cdFx0XHRyZXMuZW5kKFxuXHRcdFx0XHRKU09OLnN0cmluZ2lmeSh7XG5cdFx0XHRcdFx0bW9kZWxzOiBbXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdG5hbWU6IFwibGxhbWEzOmxhdGVzdFwiLFxuXHRcdFx0XHRcdFx0XHRtb2RpZmllZF9hdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdFx0XHRcdFx0XHRzaXplOiAxXzAwMF8wMDAsXG5cdFx0XHRcdFx0XHRcdGRpZ2VzdDogXCJhYmNcIixcblx0XHRcdFx0XHRcdFx0ZGV0YWlsczoge1xuXHRcdFx0XHRcdFx0XHRcdHBhcmVudF9tb2RlbDogXCJcIixcblx0XHRcdFx0XHRcdFx0XHRmb3JtYXQ6IFwiZ2d1ZlwiLFxuXHRcdFx0XHRcdFx0XHRcdGZhbWlseTogXCJsbGFtYVwiLFxuXHRcdFx0XHRcdFx0XHRcdGZhbWlsaWVzOiBbXCJsbGFtYVwiXSxcblx0XHRcdFx0XHRcdFx0XHRwYXJhbWV0ZXJfc2l6ZTogXCI4QlwiLFxuXHRcdFx0XHRcdFx0XHRcdHF1YW50aXphdGlvbl9sZXZlbDogXCJRNF8wXCIsXG5cdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdF0sXG5cdFx0XHRcdH0pLFxuXHRcdFx0KTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0aWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHJlcS51cmwgPT09IFwiL2FwaS9zaG93XCIpIHtcblx0XHRcdHJlcy53cml0ZUhlYWQoMjAwLCB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0pO1xuXHRcdFx0cmVzLmVuZChcblx0XHRcdFx0SlNPTi5zdHJpbmdpZnkoe1xuXHRcdFx0XHRcdG1vZGVsZmlsZTogXCJcIixcblx0XHRcdFx0XHRwYXJhbWV0ZXJzOiBcIlwiLFxuXHRcdFx0XHRcdHRlbXBsYXRlOiBcIlwiLFxuXHRcdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHRcdHBhcmVudF9tb2RlbDogXCJcIixcblx0XHRcdFx0XHRcdGZvcm1hdDogXCJnZ3VmXCIsXG5cdFx0XHRcdFx0XHRmYW1pbHk6IFwibGxhbWFcIixcblx0XHRcdFx0XHRcdGZhbWlsaWVzOiBbXCJsbGFtYVwiXSxcblx0XHRcdFx0XHRcdHBhcmFtZXRlcl9zaXplOiBcIjhCXCIsXG5cdFx0XHRcdFx0XHRxdWFudGl6YXRpb25fbGV2ZWw6IFwiUTRfMFwiLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0bW9kZWxfaW5mbzogeyBcImxsYW1hLmNvbnRleHRfbGVuZ3RoXCI6IDgxOTIgfSxcblx0XHRcdFx0XHRjYXBhYmlsaXRpZXM6IFtdLFxuXHRcdFx0XHR9KSxcblx0XHRcdCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdHJlcy53cml0ZUhlYWQoNDA0KTtcblx0XHRyZXMuZW5kKCk7XG5cdH0pO1xuXHRhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4gc2VydmVyLmxpc3RlbigwLCBcIjEyNy4wLjAuMVwiLCByZXNvbHZlKSk7XG5cdGNvbnN0IHsgcG9ydCB9ID0gc2VydmVyLmFkZHJlc3MoKSBhcyBBZGRyZXNzSW5mbztcblx0c2F2ZWRIb3N0ID0gcHJvY2Vzcy5lbnYuT0xMQU1BX0hPU1Q7XG5cdHByb2Nlc3MuZW52Lk9MTEFNQV9IT1NUID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fWA7XG59KTtcblxuYWZ0ZXIoYXN5bmMgKCkgPT4ge1xuXHRhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4gc2VydmVyLmNsb3NlKCgpID0+IHJlc29sdmUoKSkpO1xuXHRpZiAoc2F2ZWRIb3N0ID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5PTExBTUFfSE9TVDtcblx0ZWxzZSBwcm9jZXNzLmVudi5PTExBTUFfSE9TVCA9IHNhdmVkSG9zdDtcbn0pO1xuXG5iZWZvcmVFYWNoKCgpID0+IHtcblx0Ly8gRWFjaCB0ZXN0IHN0YXJ0cyBmcm9tIGEgY2xlYW4gcHJvdmlkZXJSZWdpc3RlcmVkIHN0YXRlIGluIHRoZSBtb2R1bGUuXG5cdC8vIHByb2JlQW5kUmVnaXN0ZXIgaXMgaWRlbXBvdGVudCBcdTIwMTQgY2FsbGluZyBpdCBpcyBzYWZlIHJlZ2FyZGxlc3MuXG59KTtcblxudGVzdChcIk9sbGFtYSByZWdpc3RlcnMgd2l0aCBhdXRoTW9kZSBhcGlLZXksIG5vdCBub25lICgjMzQ0MClcIiwgYXN5bmMgKCkgPT4ge1xuXHRjb25zdCB7IHBpLCBjYWxscyB9ID0gbWFrZU1vY2tQaSgpO1xuXG5cdGNvbnN0IGZvdW5kID0gYXdhaXQgcHJvYmVBbmRSZWdpc3RlcihwaSk7XG5cdGFzc2VydC5lcXVhbChmb3VuZCwgdHJ1ZSwgXCJwcm9iZUFuZFJlZ2lzdGVyIHNob3VsZCByZXR1cm4gdHJ1ZSB3aGVuIG1vZGVscyBhcmUgZGlzY292ZXJlZFwiKTtcblxuXHRhc3NlcnQuZXF1YWwoY2FsbHMucmVnaXN0ZXJQcm92aWRlci5sZW5ndGgsIDEsIFwicmVnaXN0ZXJQcm92aWRlciBzaG91bGQgYmUgY2FsbGVkIGV4YWN0bHkgb25jZVwiKTtcblx0Y29uc3QgW3Byb3ZpZGVySWQsIHNwZWNdID0gY2FsbHMucmVnaXN0ZXJQcm92aWRlclswXTtcblx0YXNzZXJ0LmVxdWFsKHByb3ZpZGVySWQsIFwib2xsYW1hXCIpO1xuXHRhc3NlcnQuZXF1YWwoXG5cdFx0c3BlYy5hdXRoTW9kZSxcblx0XHRcImFwaUtleVwiLFxuXHRcdFwiYXV0aE1vZGUgbXVzdCBiZSBhcGlLZXkgc28gdGhlIGNvcmUgZG9lc24ndCByZXF1aXJlIHN0cmVhbVNpbXBsZSBmb3IgZXZlcnkgbW9kZWxcIixcblx0KTtcbn0pO1xuIl0sCiAgIm1hcHBp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
