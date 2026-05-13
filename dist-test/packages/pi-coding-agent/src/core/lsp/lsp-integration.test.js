import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
function encodeMessage(msg) {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r
\r
${body}`;
}
class LspHarness {
  constructor(command, args, cwd) {
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.pending = /* @__PURE__ */ new Map();
    this.notifications = [];
    this.proc = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    this.proc.stderr.on("data", (chunk) => {
    });
  }
  drain() {
    while (true) {
      const headerEnd = this.findHeaderEnd();
      if (headerEnd === -1) return;
      const headerText = this.buffer.subarray(0, headerEnd).toString("utf-8");
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) return;
      const contentLength = parseInt(match[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) return;
      const body = this.buffer.subarray(messageStart, messageEnd).toString("utf-8");
      this.buffer = Buffer.from(this.buffer.subarray(messageEnd));
      const msg = JSON.parse(body);
      if (msg.id !== void 0 && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          p.resolve(msg.result);
        }
      } else if (msg.method) {
        this.notifications.push({ method: msg.method, params: msg.params });
        if (msg.id !== void 0) {
          this.respond(msg.id, null);
        }
      }
    }
  }
  findHeaderEnd() {
    for (let i = 0; i < this.buffer.length - 3; i++) {
      if (this.buffer[i] === 13 && this.buffer[i + 1] === 10 && this.buffer[i + 2] === 13 && this.buffer[i + 3] === 10) {
        return i;
      }
    }
    return -1;
  }
  respond(id, result) {
    const msg = { jsonrpc: "2.0", id, result };
    this.proc.stdin.write(encodeMessage(msg));
  }
  async request(method, params, timeoutMs = 15e3) {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    this.proc.stdin.write(encodeMessage(msg));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      });
    });
  }
  notify(method, params) {
    const msg = { jsonrpc: "2.0", method, params };
    this.proc.stdin.write(encodeMessage(msg));
  }
  getNotifications(method) {
    if (!method) return this.notifications;
    return this.notifications.filter((n) => n.method === method);
  }
  async shutdown() {
    try {
      await this.request("shutdown", null, 5e3);
      this.notify("exit", null);
    } catch {
    }
    this.proc.kill();
  }
}
function createTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "commonjs",
          strict: true,
          outDir: "./dist",
          rootDir: "./src"
        },
        include: ["src/**/*.ts"]
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "lsp-test-project", version: "1.0.0" }, null, 2)
  );
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(
    path.join(dir, "src", "math.ts"),
    `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export interface Calculator {
  add(a: number, b: number): number;
  subtract(a: number, b: number): number;
}
`
  );
  fs.writeFileSync(
    path.join(dir, "src", "main.ts"),
    `import { add, subtract, Calculator } from "./math";

const result: number = add(1, 2);
const diff: number = subtract(5, 3);

// Intentional type error: string assigned to number
const bad: number = "not a number";

export function compute(calc: Calculator): number {
  return calc.add(1, 2) + calc.subtract(5, 3);
}
`
  );
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}
function fileToUri(filePath) {
  return `file://${path.resolve(filePath)}`;
}
function hasTypescriptLanguageServer() {
  const probe = spawnSync("typescript-language-server", ["--help"], {
    stdio: "ignore"
  });
  return probe.status === 0 || probe.status === 1;
}
test("LSP integration: typescript-language-server", async (t) => {
  if (!hasTypescriptLanguageServer()) {
    t.skip("typescript-language-server not installed in this environment");
    return;
  }
  const { dir, cleanup } = createTempProject();
  const mainPath = path.join(dir, "src", "main.ts");
  const mathPath = path.join(dir, "src", "math.ts");
  const mainUri = fileToUri(mainPath);
  const mathUri = fileToUri(mathPath);
  const lsp = new LspHarness("typescript-language-server", ["--stdio"], dir);
  try {
    await t.test("initialize handshake", async () => {
      const result = await lsp.request("initialize", {
        processId: process.pid,
        rootUri: fileToUri(dir),
        rootPath: dir,
        capabilities: {
          textDocument: {
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            publishDiagnostics: { relatedInformation: true }
          }
        },
        workspaceFolders: [{ uri: fileToUri(dir), name: "test" }]
      });
      assert.ok(result, "initialize should return a result");
      assert.ok(result.capabilities, "result should have capabilities");
      assert.ok(result.capabilities.hoverProvider !== void 0, "should support hover");
      assert.ok(result.capabilities.definitionProvider !== void 0, "should support definition");
    });
    lsp.notify("initialized", {});
    const mainContent = fs.readFileSync(mainPath, "utf-8");
    const mathContent = fs.readFileSync(mathPath, "utf-8");
    lsp.notify("textDocument/didOpen", {
      textDocument: { uri: mainUri, languageId: "typescript", version: 1, text: mainContent }
    });
    lsp.notify("textDocument/didOpen", {
      textDocument: { uri: mathUri, languageId: "typescript", version: 1, text: mathContent }
    });
    const INDEX_DEADLINE_MS = 15e3;
    const indexDeadline = Date.now() + INDEX_DEADLINE_MS;
    while (Date.now() < indexDeadline) {
      const diags = lsp.getNotifications("textDocument/publishDiagnostics").filter((n) => n.params.uri === mainUri);
      if (diags.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await t.test("hover on 'add' call", async () => {
      const result = await lsp.request("textDocument/hover", {
        textDocument: { uri: mainUri },
        position: { line: 2, character: 24 }
        // on 'add' in "add(1, 2)"
      });
      assert.ok(result, "hover should return a result");
      assert.ok(result.contents, "hover should have contents");
      const text = JSON.stringify(result.contents);
      assert.ok(
        text.includes("add") || text.includes("number"),
        `hover text should mention 'add' or 'number', got: ${text.slice(0, 200)}`
      );
    });
    await t.test("go to definition of 'add'", async () => {
      const result = await lsp.request("textDocument/definition", {
        textDocument: { uri: mainUri },
        position: { line: 2, character: 24 }
        // on 'add'
      });
      assert.ok(result, "definition should return a result");
      const locations = Array.isArray(result) ? result : [result];
      assert.ok(locations.length > 0, "should find at least one definition");
      const loc = locations[0];
      const uri = loc.uri ?? loc.targetUri;
      assert.ok(uri, `definition should have uri or targetUri, got keys: ${Object.keys(loc).join(", ")}`);
      assert.ok(
        uri.includes("math.ts"),
        `definition should point to math.ts, got: ${uri}`
      );
    });
    await t.test("find references of 'add'", async () => {
      const result = await lsp.request("textDocument/references", {
        textDocument: { uri: mathUri },
        position: { line: 0, character: 16 },
        // on 'add' definition
        context: { includeDeclaration: true }
      });
      assert.ok(result, "references should return a result");
      assert.ok(result.length >= 2, `should find at least 2 references (decl + usage), got ${result.length}`);
    });
    await t.test("document symbols in math.ts", async () => {
      const result = await lsp.request("textDocument/documentSymbol", {
        textDocument: { uri: mathUri }
      });
      assert.ok(result, "documentSymbol should return a result");
      assert.ok(result.length >= 2, `should find at least 2 symbols, got ${result.length}`);
      const names = result.map((s) => s.name);
      assert.ok(names.includes("add"), `symbols should include 'add', got: ${names.join(", ")}`);
      assert.ok(names.includes("subtract"), `symbols should include 'subtract', got: ${names.join(", ")}`);
    });
    await t.test("diagnostics for type error", async () => {
      const DIAG_DEADLINE_MS = 1e4;
      const diagDeadline = Date.now() + DIAG_DEADLINE_MS;
      while (Date.now() < diagDeadline) {
        const candidates = lsp.getNotifications("textDocument/publishDiagnostics").filter((n) => n.params.uri === mainUri).flatMap(
          (n) => n.params.diagnostics
        );
        if (candidates.some(
          (d) => d.message.includes("not assignable") || d.message.includes("Type")
        )) {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      const diagNotifications = lsp.getNotifications("textDocument/publishDiagnostics");
      const mainDiags = diagNotifications.filter(
        (n) => n.params.uri === mainUri
      );
      assert.ok(mainDiags.length > 0, "should receive diagnostics for main.ts");
      const lastDiag = mainDiags[mainDiags.length - 1];
      const diagnostics = lastDiag.params.diagnostics;
      const typeError = diagnostics.find(
        (d) => d.message.includes("not assignable") || d.message.includes("Type")
      );
      assert.ok(
        typeError,
        `should find type error diagnostic, got: ${diagnostics.map((d) => d.message).join("; ")}`
      );
    });
    await t.test("clean shutdown", async () => {
      await lsp.shutdown();
    });
  } catch (err) {
    await lsp.shutdown().catch(() => {
    });
    cleanup();
    throw err;
  }
  cleanup();
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2xzcC9sc3AtaW50ZWdyYXRpb24udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBJbnRlZ3JhdGlvbiB0ZXN0IGZvciB0aGUgTFNQIHRvb2wgcG9ydC5cbiAqXG4gKiBTcGlucyB1cCB0eXBlc2NyaXB0LWxhbmd1YWdlLXNlcnZlciBhZ2FpbnN0IGEgdGVtcCBUeXBlU2NyaXB0IHByb2plY3RcbiAqIGFuZCBleGVyY2lzZXM6IGluaXRpYWxpemUsIGRpZE9wZW4sIGhvdmVyLCBkZWZpbml0aW9uLCByZWZlcmVuY2VzLFxuICogZG9jdW1lbnRTeW1ib2wsIGRpYWdub3N0aWNzLCBhbmQgc2h1dGRvd24uXG4gKlxuICogUnVuOiBub2RlIC0tZXhwZXJpbWVudGFsLXN0cmlwLXR5cGVzIC0tdGVzdCBzcmMvY29yZS9sc3AvbHNwLWludGVncmF0aW9uLnRlc3QudHNcbiAqIChmcm9tIHBhY2thZ2VzL3BpLWNvZGluZy1hZ2VudC8pXG4gKi9cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgKiBhcyBmcyBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgKiBhcyBvcyBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgc3Bhd25TeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEhlbHBlcnMgXHUyMDE0IGxpZ2h0d2VpZ2h0IEpTT04tUlBDIG92ZXIgc3RkaW8gKG5vIGRlcGVuZGVuY3kgb24gb3VyIExTUCBjb2RlKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmludGVyZmFjZSBKc29uUnBjUmVxdWVzdCB7XG5cdGpzb25ycGM6IFwiMi4wXCI7XG5cdGlkOiBudW1iZXI7XG5cdG1ldGhvZDogc3RyaW5nO1xuXHRwYXJhbXM6IHVua25vd247XG59XG5cbmludGVyZmFjZSBKc29uUnBjTm90aWZpY2F0aW9uIHtcblx0anNvbnJwYzogXCIyLjBcIjtcblx0bWV0aG9kOiBzdHJpbmc7XG5cdHBhcmFtcz86IHVua25vd247XG59XG5cbmludGVyZmFjZSBKc29uUnBjUmVzcG9uc2Uge1xuXHRqc29ucnBjOiBcIjIuMFwiO1xuXHRpZD86IG51bWJlcjtcblx0cmVzdWx0PzogdW5rbm93bjtcblx0ZXJyb3I/OiB7IGNvZGU6IG51bWJlcjsgbWVzc2FnZTogc3RyaW5nIH07XG59XG5cbmZ1bmN0aW9uIGVuY29kZU1lc3NhZ2UobXNnOiBKc29uUnBjUmVxdWVzdCB8IEpzb25ScGNOb3RpZmljYXRpb24gfCBKc29uUnBjUmVzcG9uc2UpOiBzdHJpbmcge1xuXHRjb25zdCBib2R5ID0gSlNPTi5zdHJpbmdpZnkobXNnKTtcblx0cmV0dXJuIGBDb250ZW50LUxlbmd0aDogJHtCdWZmZXIuYnl0ZUxlbmd0aChib2R5LCBcInV0Zi04XCIpfVxcclxcblxcclxcbiR7Ym9keX1gO1xufVxuXG4vKipcbiAqIE1pbmltYWwgTFNQIGhhcm5lc3M6IHNwYXducyBhIGxhbmd1YWdlIHNlcnZlciwgc2VuZHMgcmVxdWVzdHMsIGNvbGxlY3RzIHJlc3BvbnNlcy5cbiAqL1xuY2xhc3MgTHNwSGFybmVzcyB7XG5cdHByaXZhdGUgcHJvYztcblx0cHJpdmF0ZSBuZXh0SWQgPSAxO1xuXHRwcml2YXRlIGJ1ZmZlciA9IEJ1ZmZlci5hbGxvYygwKTtcblx0cHJpdmF0ZSBwZW5kaW5nID0gbmV3IE1hcDxudW1iZXIsIHsgcmVzb2x2ZTogKHY6IHVua25vd24pID0+IHZvaWQ7IHJlamVjdDogKGU6IEVycm9yKSA9PiB2b2lkIH0+KCk7XG5cdHByaXZhdGUgbm90aWZpY2F0aW9uczogQXJyYXk8eyBtZXRob2Q6IHN0cmluZzsgcGFyYW1zOiB1bmtub3duIH0+ID0gW107XG5cblx0Y29uc3RydWN0b3IoY29tbWFuZDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSwgY3dkOiBzdHJpbmcpIHtcblx0XHR0aGlzLnByb2MgPSBzcGF3bihjb21tYW5kLCBhcmdzLCB7XG5cdFx0XHRjd2QsXG5cdFx0XHRzdGRpbzogW1wicGlwZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuXHRcdH0pO1xuXG5cdFx0dGhpcy5wcm9jLnN0ZG91dCEub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG5cdFx0XHR0aGlzLmJ1ZmZlciA9IEJ1ZmZlci5jb25jYXQoW3RoaXMuYnVmZmVyLCBjaHVua10pO1xuXHRcdFx0dGhpcy5kcmFpbigpO1xuXHRcdH0pO1xuXG5cdFx0dGhpcy5wcm9jLnN0ZGVyciEub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG5cdFx0XHQvLyBTd2FsbG93IHN0ZGVyciAoc2VydmVyIGxvZ3MpXG5cdFx0fSk7XG5cdH1cblxuXHRwcml2YXRlIGRyYWluKCk6IHZvaWQge1xuXHRcdHdoaWxlICh0cnVlKSB7XG5cdFx0XHRjb25zdCBoZWFkZXJFbmQgPSB0aGlzLmZpbmRIZWFkZXJFbmQoKTtcblx0XHRcdGlmIChoZWFkZXJFbmQgPT09IC0xKSByZXR1cm47XG5cblx0XHRcdGNvbnN0IGhlYWRlclRleHQgPSB0aGlzLmJ1ZmZlci5zdWJhcnJheSgwLCBoZWFkZXJFbmQpLnRvU3RyaW5nKFwidXRmLThcIik7XG5cdFx0XHRjb25zdCBtYXRjaCA9IGhlYWRlclRleHQubWF0Y2goL0NvbnRlbnQtTGVuZ3RoOlxccyooXFxkKykvaSk7XG5cdFx0XHRpZiAoIW1hdGNoKSByZXR1cm47XG5cblx0XHRcdGNvbnN0IGNvbnRlbnRMZW5ndGggPSBwYXJzZUludChtYXRjaFsxXSwgMTApO1xuXHRcdFx0Y29uc3QgbWVzc2FnZVN0YXJ0ID0gaGVhZGVyRW5kICsgNDsgLy8gcGFzdCBcXHJcXG5cXHJcXG5cblx0XHRcdGNvbnN0IG1lc3NhZ2VFbmQgPSBtZXNzYWdlU3RhcnQgKyBjb250ZW50TGVuZ3RoO1xuXHRcdFx0aWYgKHRoaXMuYnVmZmVyLmxlbmd0aCA8IG1lc3NhZ2VFbmQpIHJldHVybjtcblxuXHRcdFx0Y29uc3QgYm9keSA9IHRoaXMuYnVmZmVyLnN1YmFycmF5KG1lc3NhZ2VTdGFydCwgbWVzc2FnZUVuZCkudG9TdHJpbmcoXCJ1dGYtOFwiKTtcblx0XHRcdHRoaXMuYnVmZmVyID0gQnVmZmVyLmZyb20odGhpcy5idWZmZXIuc3ViYXJyYXkobWVzc2FnZUVuZCkpO1xuXG5cdFx0XHRjb25zdCBtc2cgPSBKU09OLnBhcnNlKGJvZHkpIGFzIEpzb25ScGNSZXNwb25zZSAmIHsgbWV0aG9kPzogc3RyaW5nOyBwYXJhbXM/OiB1bmtub3duIH07XG5cblx0XHRcdGlmIChtc2cuaWQgIT09IHVuZGVmaW5lZCAmJiB0aGlzLnBlbmRpbmcuaGFzKG1zZy5pZCkpIHtcblx0XHRcdFx0Y29uc3QgcCA9IHRoaXMucGVuZGluZy5nZXQobXNnLmlkKSE7XG5cdFx0XHRcdHRoaXMucGVuZGluZy5kZWxldGUobXNnLmlkKTtcblx0XHRcdFx0aWYgKG1zZy5lcnJvcikge1xuXHRcdFx0XHRcdHAucmVqZWN0KG5ldyBFcnJvcihgTFNQIGVycm9yICR7bXNnLmVycm9yLmNvZGV9OiAke21zZy5lcnJvci5tZXNzYWdlfWApKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRwLnJlc29sdmUobXNnLnJlc3VsdCk7XG5cdFx0XHRcdH1cblx0XHRcdH0gZWxzZSBpZiAobXNnLm1ldGhvZCkge1xuXHRcdFx0XHQvLyBTZXJ2ZXIgcmVxdWVzdCBvciBub3RpZmljYXRpb25cblx0XHRcdFx0dGhpcy5ub3RpZmljYXRpb25zLnB1c2goeyBtZXRob2Q6IG1zZy5tZXRob2QsIHBhcmFtczogbXNnLnBhcmFtcyB9KTtcblx0XHRcdFx0Ly8gQXV0by1yZXNwb25kIHRvIHNlcnZlciByZXF1ZXN0cyB0aGF0IGhhdmUgYW4gaWRcblx0XHRcdFx0aWYgKG1zZy5pZCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0dGhpcy5yZXNwb25kKG1zZy5pZCwgbnVsbCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGZpbmRIZWFkZXJFbmQoKTogbnVtYmVyIHtcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHRoaXMuYnVmZmVyLmxlbmd0aCAtIDM7IGkrKykge1xuXHRcdFx0aWYgKFxuXHRcdFx0XHR0aGlzLmJ1ZmZlcltpXSA9PT0gMTMgJiZcblx0XHRcdFx0dGhpcy5idWZmZXJbaSArIDFdID09PSAxMCAmJlxuXHRcdFx0XHR0aGlzLmJ1ZmZlcltpICsgMl0gPT09IDEzICYmXG5cdFx0XHRcdHRoaXMuYnVmZmVyW2kgKyAzXSA9PT0gMTBcblx0XHRcdCkge1xuXHRcdFx0XHRyZXR1cm4gaTtcblx0XHRcdH1cblx0XHR9XG5cdFx0cmV0dXJuIC0xO1xuXHR9XG5cblx0cHJpdmF0ZSByZXNwb25kKGlkOiBudW1iZXIsIHJlc3VsdDogdW5rbm93bik6IHZvaWQge1xuXHRcdGNvbnN0IG1zZzogSnNvblJwY1Jlc3BvbnNlID0geyBqc29ucnBjOiBcIjIuMFwiLCBpZCwgcmVzdWx0IH07XG5cdFx0dGhpcy5wcm9jLnN0ZGluIS53cml0ZShlbmNvZGVNZXNzYWdlKG1zZykpO1xuXHR9XG5cblx0YXN5bmMgcmVxdWVzdChtZXRob2Q6IHN0cmluZywgcGFyYW1zOiB1bmtub3duLCB0aW1lb3V0TXMgPSAxNTAwMCk6IFByb21pc2U8dW5rbm93bj4ge1xuXHRcdGNvbnN0IGlkID0gdGhpcy5uZXh0SWQrKztcblx0XHRjb25zdCBtc2c6IEpzb25ScGNSZXF1ZXN0ID0geyBqc29ucnBjOiBcIjIuMFwiLCBpZCwgbWV0aG9kLCBwYXJhbXMgfTtcblx0XHR0aGlzLnByb2Muc3RkaW4hLndyaXRlKGVuY29kZU1lc3NhZ2UobXNnKSk7XG5cblx0XHRyZXR1cm4gbmV3IFByb21pc2U8dW5rbm93bj4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdFx0Y29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0dGhpcy5wZW5kaW5nLmRlbGV0ZShpZCk7XG5cdFx0XHRcdHJlamVjdChuZXcgRXJyb3IoYFJlcXVlc3QgJHttZXRob2R9IHRpbWVkIG91dCBhZnRlciAke3RpbWVvdXRNc31tc2ApKTtcblx0XHRcdH0sIHRpbWVvdXRNcyk7XG5cblx0XHRcdHRoaXMucGVuZGluZy5zZXQoaWQsIHtcblx0XHRcdFx0cmVzb2x2ZTogKHYpID0+IHtcblx0XHRcdFx0XHRjbGVhclRpbWVvdXQodGltZXIpO1xuXHRcdFx0XHRcdHJlc29sdmUodik7XG5cdFx0XHRcdH0sXG5cdFx0XHRcdHJlamVjdDogKGUpID0+IHtcblx0XHRcdFx0XHRjbGVhclRpbWVvdXQodGltZXIpO1xuXHRcdFx0XHRcdHJlamVjdChlKTtcblx0XHRcdFx0fSxcblx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9XG5cblx0bm90aWZ5KG1ldGhvZDogc3RyaW5nLCBwYXJhbXM6IHVua25vd24pOiB2b2lkIHtcblx0XHRjb25zdCBtc2c6IEpzb25ScGNOb3RpZmljYXRpb24gPSB7IGpzb25ycGM6IFwiMi4wXCIsIG1ldGhvZCwgcGFyYW1zIH07XG5cdFx0dGhpcy5wcm9jLnN0ZGluIS53cml0ZShlbmNvZGVNZXNzYWdlKG1zZykpO1xuXHR9XG5cblx0Z2V0Tm90aWZpY2F0aW9ucyhtZXRob2Q/OiBzdHJpbmcpOiBBcnJheTx7IG1ldGhvZDogc3RyaW5nOyBwYXJhbXM6IHVua25vd24gfT4ge1xuXHRcdGlmICghbWV0aG9kKSByZXR1cm4gdGhpcy5ub3RpZmljYXRpb25zO1xuXHRcdHJldHVybiB0aGlzLm5vdGlmaWNhdGlvbnMuZmlsdGVyKChuKSA9PiBuLm1ldGhvZCA9PT0gbWV0aG9kKTtcblx0fVxuXG5cdGFzeW5jIHNodXRkb3duKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdHRyeSB7XG5cdFx0XHRhd2FpdCB0aGlzLnJlcXVlc3QoXCJzaHV0ZG93blwiLCBudWxsLCA1MDAwKTtcblx0XHRcdHRoaXMubm90aWZ5KFwiZXhpdFwiLCBudWxsKTtcblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIEJlc3QgZWZmb3J0XG5cdFx0fVxuXHRcdHRoaXMucHJvYy5raWxsKCk7XG5cdH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUZXN0IGZpeHR1cmVzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gY3JlYXRlVGVtcFByb2plY3QoKTogeyBkaXI6IHN0cmluZzsgY2xlYW51cDogKCkgPT4gdm9pZCB9IHtcblx0Y29uc3QgZGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCBcImxzcC10ZXN0LVwiKSk7XG5cblx0Ly8gdHNjb25maWcuanNvblxuXHRmcy53cml0ZUZpbGVTeW5jKFxuXHRcdHBhdGguam9pbihkaXIsIFwidHNjb25maWcuanNvblwiKSxcblx0XHRKU09OLnN0cmluZ2lmeShcblx0XHRcdHtcblx0XHRcdFx0Y29tcGlsZXJPcHRpb25zOiB7XG5cdFx0XHRcdFx0dGFyZ2V0OiBcIkVTMjAyMlwiLFxuXHRcdFx0XHRcdG1vZHVsZTogXCJjb21tb25qc1wiLFxuXHRcdFx0XHRcdHN0cmljdDogdHJ1ZSxcblx0XHRcdFx0XHRvdXREaXI6IFwiLi9kaXN0XCIsXG5cdFx0XHRcdFx0cm9vdERpcjogXCIuL3NyY1wiLFxuXHRcdFx0XHR9LFxuXHRcdFx0XHRpbmNsdWRlOiBbXCJzcmMvKiovKi50c1wiXSxcblx0XHRcdH0sXG5cdFx0XHRudWxsLFxuXHRcdFx0Mixcblx0XHQpLFxuXHQpO1xuXG5cdC8vIHBhY2thZ2UuanNvblxuXHRmcy53cml0ZUZpbGVTeW5jKFxuXHRcdHBhdGguam9pbihkaXIsIFwicGFja2FnZS5qc29uXCIpLFxuXHRcdEpTT04uc3RyaW5naWZ5KHsgbmFtZTogXCJsc3AtdGVzdC1wcm9qZWN0XCIsIHZlcnNpb246IFwiMS4wLjBcIiB9LCBudWxsLCAyKSxcblx0KTtcblxuXHRmcy5ta2RpclN5bmMocGF0aC5qb2luKGRpciwgXCJzcmNcIikpO1xuXG5cdC8vIHNyYy9tYXRoLnRzIFx1MjAxNCBtb2R1bGUgd2l0aCBleHBvcnRlZCBmdW5jdGlvbnNcblx0ZnMud3JpdGVGaWxlU3luYyhcblx0XHRwYXRoLmpvaW4oZGlyLCBcInNyY1wiLCBcIm1hdGgudHNcIiksXG5cdFx0YGV4cG9ydCBmdW5jdGlvbiBhZGQoYTogbnVtYmVyLCBiOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYSArIGI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzdWJ0cmFjdChhOiBudW1iZXIsIGI6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBhIC0gYjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDYWxjdWxhdG9yIHtcbiAgYWRkKGE6IG51bWJlciwgYjogbnVtYmVyKTogbnVtYmVyO1xuICBzdWJ0cmFjdChhOiBudW1iZXIsIGI6IG51bWJlcik6IG51bWJlcjtcbn1cbmAsXG5cdCk7XG5cblx0Ly8gc3JjL21haW4udHMgXHUyMDE0IGltcG9ydHMgZnJvbSBtYXRoLCBoYXMgYSB0eXBlIGVycm9yXG5cdGZzLndyaXRlRmlsZVN5bmMoXG5cdFx0cGF0aC5qb2luKGRpciwgXCJzcmNcIiwgXCJtYWluLnRzXCIpLFxuXHRcdGBpbXBvcnQgeyBhZGQsIHN1YnRyYWN0LCBDYWxjdWxhdG9yIH0gZnJvbSBcIi4vbWF0aFwiO1xuXG5jb25zdCByZXN1bHQ6IG51bWJlciA9IGFkZCgxLCAyKTtcbmNvbnN0IGRpZmY6IG51bWJlciA9IHN1YnRyYWN0KDUsIDMpO1xuXG4vLyBJbnRlbnRpb25hbCB0eXBlIGVycm9yOiBzdHJpbmcgYXNzaWduZWQgdG8gbnVtYmVyXG5jb25zdCBiYWQ6IG51bWJlciA9IFwibm90IGEgbnVtYmVyXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBjb21wdXRlKGNhbGM6IENhbGN1bGF0b3IpOiBudW1iZXIge1xuICByZXR1cm4gY2FsYy5hZGQoMSwgMikgKyBjYWxjLnN1YnRyYWN0KDUsIDMpO1xufVxuYCxcblx0KTtcblxuXHRyZXR1cm4ge1xuXHRcdGRpcixcblx0XHRjbGVhbnVwOiAoKSA9PiBmcy5ybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSksXG5cdH07XG59XG5cbmZ1bmN0aW9uIGZpbGVUb1VyaShmaWxlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIGBmaWxlOi8vJHtwYXRoLnJlc29sdmUoZmlsZVBhdGgpfWA7XG59XG5cbmZ1bmN0aW9uIGhhc1R5cGVzY3JpcHRMYW5ndWFnZVNlcnZlcigpOiBib29sZWFuIHtcblx0Y29uc3QgcHJvYmUgPSBzcGF3blN5bmMoXCJ0eXBlc2NyaXB0LWxhbmd1YWdlLXNlcnZlclwiLCBbXCItLWhlbHBcIl0sIHtcblx0XHRzdGRpbzogXCJpZ25vcmVcIixcblx0fSk7XG5cdHJldHVybiBwcm9iZS5zdGF0dXMgPT09IDAgfHwgcHJvYmUuc3RhdHVzID09PSAxO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRlc3RzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxudGVzdChcIkxTUCBpbnRlZ3JhdGlvbjogdHlwZXNjcmlwdC1sYW5ndWFnZS1zZXJ2ZXJcIiwgYXN5bmMgKHQpID0+IHtcblx0aWYgKCFoYXNUeXBlc2NyaXB0TGFuZ3VhZ2VTZXJ2ZXIoKSkge1xuXHRcdHQuc2tpcChcInR5cGVzY3JpcHQtbGFuZ3VhZ2Utc2VydmVyIG5vdCBpbnN0YWxsZWQgaW4gdGhpcyBlbnZpcm9ubWVudFwiKTtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRjb25zdCB7IGRpciwgY2xlYW51cCB9ID0gY3JlYXRlVGVtcFByb2plY3QoKTtcblx0Y29uc3QgbWFpblBhdGggPSBwYXRoLmpvaW4oZGlyLCBcInNyY1wiLCBcIm1haW4udHNcIik7XG5cdGNvbnN0IG1hdGhQYXRoID0gcGF0aC5qb2luKGRpciwgXCJzcmNcIiwgXCJtYXRoLnRzXCIpO1xuXHRjb25zdCBtYWluVXJpID0gZmlsZVRvVXJpKG1haW5QYXRoKTtcblx0Y29uc3QgbWF0aFVyaSA9IGZpbGVUb1VyaShtYXRoUGF0aCk7XG5cblx0Y29uc3QgbHNwID0gbmV3IExzcEhhcm5lc3MoXCJ0eXBlc2NyaXB0LWxhbmd1YWdlLXNlcnZlclwiLCBbXCItLXN0ZGlvXCJdLCBkaXIpO1xuXG5cdHRyeSB7XG5cdFx0Ly8gLS0tLSBJbml0aWFsaXplIC0tLS1cblx0XHRhd2FpdCB0LnRlc3QoXCJpbml0aWFsaXplIGhhbmRzaGFrZVwiLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRjb25zdCByZXN1bHQgPSAoYXdhaXQgbHNwLnJlcXVlc3QoXCJpbml0aWFsaXplXCIsIHtcblx0XHRcdFx0cHJvY2Vzc0lkOiBwcm9jZXNzLnBpZCxcblx0XHRcdFx0cm9vdFVyaTogZmlsZVRvVXJpKGRpciksXG5cdFx0XHRcdHJvb3RQYXRoOiBkaXIsXG5cdFx0XHRcdGNhcGFiaWxpdGllczoge1xuXHRcdFx0XHRcdHRleHREb2N1bWVudDoge1xuXHRcdFx0XHRcdFx0aG92ZXI6IHsgY29udGVudEZvcm1hdDogW1wibWFya2Rvd25cIiwgXCJwbGFpbnRleHRcIl0gfSxcblx0XHRcdFx0XHRcdGRlZmluaXRpb246IHsgbGlua1N1cHBvcnQ6IHRydWUgfSxcblx0XHRcdFx0XHRcdHJlZmVyZW5jZXM6IHt9LFxuXHRcdFx0XHRcdFx0ZG9jdW1lbnRTeW1ib2w6IHsgaGllcmFyY2hpY2FsRG9jdW1lbnRTeW1ib2xTdXBwb3J0OiB0cnVlIH0sXG5cdFx0XHRcdFx0XHRwdWJsaXNoRGlhZ25vc3RpY3M6IHsgcmVsYXRlZEluZm9ybWF0aW9uOiB0cnVlIH0sXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSxcblx0XHRcdFx0d29ya3NwYWNlRm9sZGVyczogW3sgdXJpOiBmaWxlVG9VcmkoZGlyKSwgbmFtZTogXCJ0ZXN0XCIgfV0sXG5cdFx0XHR9KSkgYXMgeyBjYXBhYmlsaXRpZXM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9O1xuXG5cdFx0XHRhc3NlcnQub2socmVzdWx0LCBcImluaXRpYWxpemUgc2hvdWxkIHJldHVybiBhIHJlc3VsdFwiKTtcblx0XHRcdGFzc2VydC5vayhyZXN1bHQuY2FwYWJpbGl0aWVzLCBcInJlc3VsdCBzaG91bGQgaGF2ZSBjYXBhYmlsaXRpZXNcIik7XG5cdFx0XHRhc3NlcnQub2socmVzdWx0LmNhcGFiaWxpdGllcy5ob3ZlclByb3ZpZGVyICE9PSB1bmRlZmluZWQsIFwic2hvdWxkIHN1cHBvcnQgaG92ZXJcIik7XG5cdFx0XHRhc3NlcnQub2socmVzdWx0LmNhcGFiaWxpdGllcy5kZWZpbml0aW9uUHJvdmlkZXIgIT09IHVuZGVmaW5lZCwgXCJzaG91bGQgc3VwcG9ydCBkZWZpbml0aW9uXCIpO1xuXHRcdH0pO1xuXG5cdFx0bHNwLm5vdGlmeShcImluaXRpYWxpemVkXCIsIHt9KTtcblxuXHRcdC8vIE9wZW4gYm90aCBmaWxlc1xuXHRcdGNvbnN0IG1haW5Db250ZW50ID0gZnMucmVhZEZpbGVTeW5jKG1haW5QYXRoLCBcInV0Zi04XCIpO1xuXHRcdGNvbnN0IG1hdGhDb250ZW50ID0gZnMucmVhZEZpbGVTeW5jKG1hdGhQYXRoLCBcInV0Zi04XCIpO1xuXG5cdFx0bHNwLm5vdGlmeShcInRleHREb2N1bWVudC9kaWRPcGVuXCIsIHtcblx0XHRcdHRleHREb2N1bWVudDogeyB1cmk6IG1haW5VcmksIGxhbmd1YWdlSWQ6IFwidHlwZXNjcmlwdFwiLCB2ZXJzaW9uOiAxLCB0ZXh0OiBtYWluQ29udGVudCB9LFxuXHRcdH0pO1xuXHRcdGxzcC5ub3RpZnkoXCJ0ZXh0RG9jdW1lbnQvZGlkT3BlblwiLCB7XG5cdFx0XHR0ZXh0RG9jdW1lbnQ6IHsgdXJpOiBtYXRoVXJpLCBsYW5ndWFnZUlkOiBcInR5cGVzY3JpcHRcIiwgdmVyc2lvbjogMSwgdGV4dDogbWF0aENvbnRlbnQgfSxcblx0XHR9KTtcblxuXHRcdC8vIFBvbGwgZm9yIGEgcHVibGlzaGVkIGRpYWdub3N0aWNzIG5vdGlmaWNhdGlvbiBvbiBtYWluLnRzLCB3aGljaFxuXHRcdC8vIGlzIHRoZSBvYnNlcnZhYmxlIHNpZ25hbCB0aGF0IFR5cGVTY3JpcHQgaGFzIGZpbmlzaGVkIGluZGV4aW5nXG5cdFx0Ly8gdGhlIG9wZW5lZCBmaWxlLiBQcmV2aW91cyBtYWdpYy1zbGVlcCAoMzAwMG1zKSB3YXMgdG9vIHNob3J0IG9uXG5cdFx0Ly8gc2xvdyBDSSBtYWNoaW5lcyBhbmQgd2FzdGVmdWwgb24gZmFzdCBvbmVzICgjNDc5OCkuXG5cdFx0Y29uc3QgSU5ERVhfREVBRExJTkVfTVMgPSAxNV8wMDA7XG5cdFx0Y29uc3QgaW5kZXhEZWFkbGluZSA9IERhdGUubm93KCkgKyBJTkRFWF9ERUFETElORV9NUztcblx0XHR3aGlsZSAoRGF0ZS5ub3coKSA8IGluZGV4RGVhZGxpbmUpIHtcblx0XHRcdGNvbnN0IGRpYWdzID0gbHNwXG5cdFx0XHRcdC5nZXROb3RpZmljYXRpb25zKFwidGV4dERvY3VtZW50L3B1Ymxpc2hEaWFnbm9zdGljc1wiKVxuXHRcdFx0XHQuZmlsdGVyKChuKSA9PiAobi5wYXJhbXMgYXMgeyB1cmk6IHN0cmluZyB9KS51cmkgPT09IG1haW5VcmkpO1xuXHRcdFx0aWYgKGRpYWdzLmxlbmd0aCA+IDApIGJyZWFrO1xuXHRcdFx0YXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcblx0XHR9XG5cblx0XHQvLyAtLS0tIEhvdmVyIC0tLS1cblx0XHRhd2FpdCB0LnRlc3QoXCJob3ZlciBvbiAnYWRkJyBjYWxsXCIsIGFzeW5jICgpID0+IHtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IChhd2FpdCBsc3AucmVxdWVzdChcInRleHREb2N1bWVudC9ob3ZlclwiLCB7XG5cdFx0XHRcdHRleHREb2N1bWVudDogeyB1cmk6IG1haW5VcmkgfSxcblx0XHRcdFx0cG9zaXRpb246IHsgbGluZTogMiwgY2hhcmFjdGVyOiAyNCB9LCAvLyBvbiAnYWRkJyBpbiBcImFkZCgxLCAyKVwiXG5cdFx0XHR9KSkgYXMgeyBjb250ZW50cz86IHVua25vd24gfSB8IG51bGw7XG5cblx0XHRcdGFzc2VydC5vayhyZXN1bHQsIFwiaG92ZXIgc2hvdWxkIHJldHVybiBhIHJlc3VsdFwiKTtcblx0XHRcdGFzc2VydC5vayhyZXN1bHQuY29udGVudHMsIFwiaG92ZXIgc2hvdWxkIGhhdmUgY29udGVudHNcIik7XG5cdFx0XHRjb25zdCB0ZXh0ID0gSlNPTi5zdHJpbmdpZnkocmVzdWx0LmNvbnRlbnRzKTtcblx0XHRcdGFzc2VydC5vayhcblx0XHRcdFx0dGV4dC5pbmNsdWRlcyhcImFkZFwiKSB8fCB0ZXh0LmluY2x1ZGVzKFwibnVtYmVyXCIpLFxuXHRcdFx0XHRgaG92ZXIgdGV4dCBzaG91bGQgbWVudGlvbiAnYWRkJyBvciAnbnVtYmVyJywgZ290OiAke3RleHQuc2xpY2UoMCwgMjAwKX1gLFxuXHRcdFx0KTtcblx0XHR9KTtcblxuXHRcdC8vIC0tLS0gR28gdG8gRGVmaW5pdGlvbiAtLS0tXG5cdFx0YXdhaXQgdC50ZXN0KFwiZ28gdG8gZGVmaW5pdGlvbiBvZiAnYWRkJ1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRjb25zdCByZXN1bHQgPSAoYXdhaXQgbHNwLnJlcXVlc3QoXCJ0ZXh0RG9jdW1lbnQvZGVmaW5pdGlvblwiLCB7XG5cdFx0XHRcdHRleHREb2N1bWVudDogeyB1cmk6IG1haW5VcmkgfSxcblx0XHRcdFx0cG9zaXRpb246IHsgbGluZTogMiwgY2hhcmFjdGVyOiAyNCB9LCAvLyBvbiAnYWRkJ1xuXHRcdFx0fSkpIGFzIHVua25vd247XG5cblx0XHRcdGFzc2VydC5vayhyZXN1bHQsIFwiZGVmaW5pdGlvbiBzaG91bGQgcmV0dXJuIGEgcmVzdWx0XCIpO1xuXHRcdFx0Y29uc3QgbG9jYXRpb25zID0gQXJyYXkuaXNBcnJheShyZXN1bHQpID8gcmVzdWx0IDogW3Jlc3VsdF07XG5cdFx0XHRhc3NlcnQub2sobG9jYXRpb25zLmxlbmd0aCA+IDAsIFwic2hvdWxkIGZpbmQgYXQgbGVhc3Qgb25lIGRlZmluaXRpb25cIik7XG5cdFx0XHQvLyBSZXNwb25zZSBjYW4gYmUgTG9jYXRpb24gKHVyaSkgb3IgTG9jYXRpb25MaW5rICh0YXJnZXRVcmkpXG5cdFx0XHRjb25zdCBsb2MgPSBsb2NhdGlvbnNbMF0gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cdFx0XHRjb25zdCB1cmkgPSAobG9jLnVyaSA/PyBsb2MudGFyZ2V0VXJpKSBhcyBzdHJpbmc7XG5cdFx0XHRhc3NlcnQub2sodXJpLCBgZGVmaW5pdGlvbiBzaG91bGQgaGF2ZSB1cmkgb3IgdGFyZ2V0VXJpLCBnb3Qga2V5czogJHtPYmplY3Qua2V5cyhsb2MpLmpvaW4oXCIsIFwiKX1gKTtcblx0XHRcdGFzc2VydC5vayhcblx0XHRcdFx0dXJpLmluY2x1ZGVzKFwibWF0aC50c1wiKSxcblx0XHRcdFx0YGRlZmluaXRpb24gc2hvdWxkIHBvaW50IHRvIG1hdGgudHMsIGdvdDogJHt1cml9YCxcblx0XHRcdCk7XG5cdFx0fSk7XG5cblx0XHQvLyAtLS0tIFJlZmVyZW5jZXMgLS0tLVxuXHRcdGF3YWl0IHQudGVzdChcImZpbmQgcmVmZXJlbmNlcyBvZiAnYWRkJ1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRjb25zdCByZXN1bHQgPSAoYXdhaXQgbHNwLnJlcXVlc3QoXCJ0ZXh0RG9jdW1lbnQvcmVmZXJlbmNlc1wiLCB7XG5cdFx0XHRcdHRleHREb2N1bWVudDogeyB1cmk6IG1hdGhVcmkgfSxcblx0XHRcdFx0cG9zaXRpb246IHsgbGluZTogMCwgY2hhcmFjdGVyOiAxNiB9LCAvLyBvbiAnYWRkJyBkZWZpbml0aW9uXG5cdFx0XHRcdGNvbnRleHQ6IHsgaW5jbHVkZURlY2xhcmF0aW9uOiB0cnVlIH0sXG5cdFx0XHR9KSkgYXMgQXJyYXk8eyB1cmk6IHN0cmluZzsgcmFuZ2U6IHVua25vd24gfT4gfCBudWxsO1xuXG5cdFx0XHRhc3NlcnQub2socmVzdWx0LCBcInJlZmVyZW5jZXMgc2hvdWxkIHJldHVybiBhIHJlc3VsdFwiKTtcblx0XHRcdGFzc2VydC5vayhyZXN1bHQubGVuZ3RoID49IDIsIGBzaG91bGQgZmluZCBhdCBsZWFzdCAyIHJlZmVyZW5jZXMgKGRlY2wgKyB1c2FnZSksIGdvdCAke3Jlc3VsdC5sZW5ndGh9YCk7XG5cdFx0fSk7XG5cblx0XHQvLyAtLS0tIERvY3VtZW50IFN5bWJvbHMgLS0tLVxuXHRcdGF3YWl0IHQudGVzdChcImRvY3VtZW50IHN5bWJvbHMgaW4gbWF0aC50c1wiLCBhc3luYyAoKSA9PiB7XG5cdFx0XHRjb25zdCByZXN1bHQgPSAoYXdhaXQgbHNwLnJlcXVlc3QoXCJ0ZXh0RG9jdW1lbnQvZG9jdW1lbnRTeW1ib2xcIiwge1xuXHRcdFx0XHR0ZXh0RG9jdW1lbnQ6IHsgdXJpOiBtYXRoVXJpIH0sXG5cdFx0XHR9KSkgYXMgQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGtpbmQ6IG51bWJlciB9PiB8IG51bGw7XG5cblx0XHRcdGFzc2VydC5vayhyZXN1bHQsIFwiZG9jdW1lbnRTeW1ib2wgc2hvdWxkIHJldHVybiBhIHJlc3VsdFwiKTtcblx0XHRcdGFzc2VydC5vayhyZXN1bHQubGVuZ3RoID49IDIsIGBzaG91bGQgZmluZCBhdCBsZWFzdCAyIHN5bWJvbHMsIGdvdCAke3Jlc3VsdC5sZW5ndGh9YCk7XG5cdFx0XHRjb25zdCBuYW1lcyA9IHJlc3VsdC5tYXAoKHMpID0+IHMubmFtZSk7XG5cdFx0XHRhc3NlcnQub2sobmFtZXMuaW5jbHVkZXMoXCJhZGRcIiksIGBzeW1ib2xzIHNob3VsZCBpbmNsdWRlICdhZGQnLCBnb3Q6ICR7bmFtZXMuam9pbihcIiwgXCIpfWApO1xuXHRcdFx0YXNzZXJ0Lm9rKG5hbWVzLmluY2x1ZGVzKFwic3VidHJhY3RcIiksIGBzeW1ib2xzIHNob3VsZCBpbmNsdWRlICdzdWJ0cmFjdCcsIGdvdDogJHtuYW1lcy5qb2luKFwiLCBcIil9YCk7XG5cdFx0fSk7XG5cblx0XHQvLyAtLS0tIERpYWdub3N0aWNzIChwdWJsaXNoZWQgdmlhIG5vdGlmaWNhdGlvbikgLS0tLVxuXHRcdGF3YWl0IHQudGVzdChcImRpYWdub3N0aWNzIGZvciB0eXBlIGVycm9yXCIsIGFzeW5jICgpID0+IHtcblx0XHRcdC8vIFBvbGwgZm9yIHRoZSBzcGVjaWZpYyB0eXBlLWVycm9yIGRpYWdub3N0aWMgb24gbWFpbi50c1xuXHRcdFx0Ly8gaW5zdGVhZCBvZiBzbGVlcGluZyBhIGZpeGVkIDJzLiB0c3NlcnZlciBwdXNoZXMgZGlhZ25vc3RpY3Ncblx0XHRcdC8vIGluY3JlbWVudGFsbHkgXHUyMDE0IHdlIG5lZWQgdG8gd2FpdCB1bnRpbCBhdCBsZWFzdCBvbmUgZGlhZ1xuXHRcdFx0Ly8gY29udGFpbnMgYSB0eXBlLWVycm9yIHNpZ25hbCwgbm90IGp1c3QgYW55IGRpYWcuXG5cdFx0XHRjb25zdCBESUFHX0RFQURMSU5FX01TID0gMTBfMDAwO1xuXHRcdFx0Y29uc3QgZGlhZ0RlYWRsaW5lID0gRGF0ZS5ub3coKSArIERJQUdfREVBRExJTkVfTVM7XG5cdFx0XHR3aGlsZSAoRGF0ZS5ub3coKSA8IGRpYWdEZWFkbGluZSkge1xuXHRcdFx0XHRjb25zdCBjYW5kaWRhdGVzID0gbHNwXG5cdFx0XHRcdFx0LmdldE5vdGlmaWNhdGlvbnMoXCJ0ZXh0RG9jdW1lbnQvcHVibGlzaERpYWdub3N0aWNzXCIpXG5cdFx0XHRcdFx0LmZpbHRlcigobikgPT4gKG4ucGFyYW1zIGFzIHsgdXJpOiBzdHJpbmcgfSkudXJpID09PSBtYWluVXJpKVxuXHRcdFx0XHRcdC5mbGF0TWFwKFxuXHRcdFx0XHRcdFx0KG4pID0+IChuLnBhcmFtcyBhcyB7IGRpYWdub3N0aWNzOiBBcnJheTx7IG1lc3NhZ2U6IHN0cmluZyB9PiB9KS5kaWFnbm9zdGljcyxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHRpZiAoXG5cdFx0XHRcdFx0Y2FuZGlkYXRlcy5zb21lKFxuXHRcdFx0XHRcdFx0KGQpID0+IGQubWVzc2FnZS5pbmNsdWRlcyhcIm5vdCBhc3NpZ25hYmxlXCIpIHx8IGQubWVzc2FnZS5pbmNsdWRlcyhcIlR5cGVcIiksXG5cdFx0XHRcdFx0KVxuXHRcdFx0XHQpIHtcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0fVxuXHRcdFx0XHRhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBkaWFnTm90aWZpY2F0aW9ucyA9IGxzcC5nZXROb3RpZmljYXRpb25zKFwidGV4dERvY3VtZW50L3B1Ymxpc2hEaWFnbm9zdGljc1wiKTtcblx0XHRcdGNvbnN0IG1haW5EaWFncyA9IGRpYWdOb3RpZmljYXRpb25zLmZpbHRlcihcblx0XHRcdFx0KG4pID0+IChuLnBhcmFtcyBhcyB7IHVyaTogc3RyaW5nIH0pLnVyaSA9PT0gbWFpblVyaSxcblx0XHRcdCk7XG5cblx0XHRcdGFzc2VydC5vayhtYWluRGlhZ3MubGVuZ3RoID4gMCwgXCJzaG91bGQgcmVjZWl2ZSBkaWFnbm9zdGljcyBmb3IgbWFpbi50c1wiKTtcblxuXHRcdFx0Y29uc3QgbGFzdERpYWcgPSBtYWluRGlhZ3NbbWFpbkRpYWdzLmxlbmd0aCAtIDFdO1xuXHRcdFx0Y29uc3QgZGlhZ25vc3RpY3MgPSAobGFzdERpYWcucGFyYW1zIGFzIHsgZGlhZ25vc3RpY3M6IEFycmF5PHsgbWVzc2FnZTogc3RyaW5nOyByYW5nZTogdW5rbm93biB9PiB9KVxuXHRcdFx0XHQuZGlhZ25vc3RpY3M7XG5cblx0XHRcdC8vIFNob3VsZCBjYXRjaCB0aGUgdHlwZSBlcnJvcjogc3RyaW5nIGFzc2lnbmVkIHRvIG51bWJlclxuXHRcdFx0Y29uc3QgdHlwZUVycm9yID0gZGlhZ25vc3RpY3MuZmluZChcblx0XHRcdFx0KGQpID0+IGQubWVzc2FnZS5pbmNsdWRlcyhcIm5vdCBhc3NpZ25hYmxlXCIpIHx8IGQubWVzc2FnZS5pbmNsdWRlcyhcIlR5cGVcIiksXG5cdFx0XHQpO1xuXHRcdFx0YXNzZXJ0Lm9rKFxuXHRcdFx0XHR0eXBlRXJyb3IsXG5cdFx0XHRcdGBzaG91bGQgZmluZCB0eXBlIGVycm9yIGRpYWdub3N0aWMsIGdvdDogJHtkaWFnbm9zdGljcy5tYXAoKGQpID0+IGQubWVzc2FnZSkuam9pbihcIjsgXCIpfWAsXG5cdFx0XHQpO1xuXHRcdH0pO1xuXG5cdFx0Ly8gLS0tLSBTaHV0ZG93biAtLS0tXG5cdFx0YXdhaXQgdC50ZXN0KFwiY2xlYW4gc2h1dGRvd25cIiwgYXN5bmMgKCkgPT4ge1xuXHRcdFx0Ly8gU2hvdWxkIG5vdCB0aHJvd1xuXHRcdFx0YXdhaXQgbHNwLnNodXRkb3duKCk7XG5cdFx0fSk7XG5cdH0gY2F0Y2ggKGVycikge1xuXHRcdGF3YWl0IGxzcC5zaHV0ZG93bigpLmNhdGNoKCgpID0+IHt9KTtcblx0XHRjbGVhbnVwKCk7XG5cdFx0dGhyb3cgZXJyO1xuXHR9XG5cblx0Y2xlYW51cCgpO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFVQSxPQUFPLFVBQVU7QUFDakIsT0FBTyxZQUFZO0FBQ25CLFNBQVMsYUFBYTtBQUN0QixZQUFZLFFBQVE7QUFDcEIsWUFBWSxVQUFVO0FBQ3RCLFlBQVksUUFBUTtBQUNwQixTQUFTLGlCQUFpQjtBQTBCMUIsU0FBUyxjQUFjLEtBQXFFO0FBQzNGLFFBQU0sT0FBTyxLQUFLLFVBQVUsR0FBRztBQUMvQixTQUFPLG1CQUFtQixPQUFPLFdBQVcsTUFBTSxPQUFP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
