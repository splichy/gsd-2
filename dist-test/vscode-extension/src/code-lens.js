import * as vscode from "vscode";
const SYMBOL_PATTERNS = [
  {
    // TypeScript / JavaScript: function foo(...) | async function foo(...)
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/
  },
  {
    // TypeScript / JavaScript: class Foo
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/
  },
  {
    // TypeScript / JavaScript: method declarations inside a class
    //   foo(...) { | async foo(...) { | private foo(...): T {
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    regex: /^\s*(?:(?:public|private|protected|static|async|readonly)\s+)*(\w+)\s*\(/
  },
  {
    // Python: def foo( | async def foo(
    languages: ["python"],
    regex: /^\s*(?:async\s+)?def\s+(\w+)\s*\(/
  },
  {
    // Python: class Foo
    languages: ["python"],
    regex: /^\s*class\s+(\w+)/
  },
  {
    // Go: func foo( | func (r Receiver) foo(
    languages: ["go"],
    regex: /^\s*func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/
  },
  {
    // Rust: fn foo( | pub fn foo( | async fn foo(
    languages: ["rust"],
    regex: /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*[(<]/
  }
];
class GsdCodeLensProvider {
  constructor(client) {
    this.client = client;
    this.disposables.push(
      this._onDidChangeCodeLenses,
      client.onConnectionChange(() => this._onDidChangeCodeLenses.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("gsd.codeLens")) {
          this._onDidChangeCodeLenses.fire();
        }
      })
    );
  }
  _onDidChangeCodeLenses = new vscode.EventEmitter();
  onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  disposables = [];
  provideCodeLenses(document, _token) {
    const lenses = [];
    if (!vscode.workspace.getConfiguration("gsd").get("codeLens", true)) {
      return lenses;
    }
    const langId = document.languageId;
    const patterns = SYMBOL_PATTERNS.filter((p) => p.languages.includes(langId));
    if (patterns.length === 0) {
      return lenses;
    }
    const fileName = document.fileName.split(/[\\/]/).pop() ?? document.fileName;
    const seen = /* @__PURE__ */ new Set();
    for (let i = 0; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;
      for (const { regex } of patterns) {
        const match = regex.exec(text);
        if (match && match[1] && !seen.has(i)) {
          seen.add(i);
          const symbolName = match[1];
          const range = new vscode.Range(i, 0, i, text.length);
          const args = [symbolName, fileName, i + 1];
          lenses.push(
            new vscode.CodeLens(range, {
              title: "$(hubot) Ask GSD",
              tooltip: `Ask GSD to explain ${symbolName}`,
              command: "gsd.askAboutSymbol",
              arguments: args
            }),
            new vscode.CodeLens(range, {
              title: "$(pencil) Refactor",
              tooltip: `Refactor ${symbolName}`,
              command: "gsd.refactorSymbol",
              arguments: args
            }),
            new vscode.CodeLens(range, {
              title: "$(bug) Find Bugs",
              tooltip: `Review ${symbolName} for bugs`,
              command: "gsd.findBugsSymbol",
              arguments: args
            }),
            new vscode.CodeLens(range, {
              title: "$(beaker) Tests",
              tooltip: `Generate tests for ${symbolName}`,
              command: "gsd.generateTestsSymbol",
              arguments: args
            })
          );
        }
      }
    }
    return lenses;
  }
  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
export {
  GsdCodeLensProvider
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvY29kZS1sZW5zLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgKiBhcyB2c2NvZGUgZnJvbSBcInZzY29kZVwiO1xuaW1wb3J0IHR5cGUgeyBHc2RDbGllbnQgfSBmcm9tIFwiLi9nc2QtY2xpZW50LmpzXCI7XG5cbi8qKlxuICogUGF0dGVybnMgdGhhdCBpZGVudGlmeSB0aGUgc3RhcnQgb2YgYSBuYW1lZCBmdW5jdGlvbiwgY2xhc3MsIG9yIG1ldGhvZFxuICogZGVjbGFyYXRpb24gaW4gY29tbW9uIGxhbmd1YWdlcy4gRWFjaCBlbnRyeSBjYXB0dXJlcyB0aGUgc3ltYm9sIG5hbWUgaW5cbiAqIGNhcHR1cmUgZ3JvdXAgMS5cbiAqL1xuY29uc3QgU1lNQk9MX1BBVFRFUk5TOiB7IGxhbmd1YWdlczogc3RyaW5nW107IHJlZ2V4OiBSZWdFeHAgfVtdID0gW1xuXHR7XG5cdFx0Ly8gVHlwZVNjcmlwdCAvIEphdmFTY3JpcHQ6IGZ1bmN0aW9uIGZvbyguLi4pIHwgYXN5bmMgZnVuY3Rpb24gZm9vKC4uLilcblx0XHRsYW5ndWFnZXM6IFtcInR5cGVzY3JpcHRcIiwgXCJ0eXBlc2NyaXB0cmVhY3RcIiwgXCJqYXZhc2NyaXB0XCIsIFwiamF2YXNjcmlwdHJlYWN0XCJdLFxuXHRcdHJlZ2V4OiAvXlxccyooPzpleHBvcnRcXHMrKT8oPzphc3luY1xccyspP2Z1bmN0aW9uXFxzKyhcXHcrKVxccypbKDxdLyxcblx0fSxcblx0e1xuXHRcdC8vIFR5cGVTY3JpcHQgLyBKYXZhU2NyaXB0OiBjbGFzcyBGb29cblx0XHRsYW5ndWFnZXM6IFtcInR5cGVzY3JpcHRcIiwgXCJ0eXBlc2NyaXB0cmVhY3RcIiwgXCJqYXZhc2NyaXB0XCIsIFwiamF2YXNjcmlwdHJlYWN0XCJdLFxuXHRcdHJlZ2V4OiAvXlxccyooPzpleHBvcnRcXHMrKT8oPzphYnN0cmFjdFxccyspP2NsYXNzXFxzKyhcXHcrKS8sXG5cdH0sXG5cdHtcblx0XHQvLyBUeXBlU2NyaXB0IC8gSmF2YVNjcmlwdDogbWV0aG9kIGRlY2xhcmF0aW9ucyBpbnNpZGUgYSBjbGFzc1xuXHRcdC8vICAgZm9vKC4uLikgeyB8IGFzeW5jIGZvbyguLi4pIHsgfCBwcml2YXRlIGZvbyguLi4pOiBUIHtcblx0XHRsYW5ndWFnZXM6IFtcInR5cGVzY3JpcHRcIiwgXCJ0eXBlc2NyaXB0cmVhY3RcIiwgXCJqYXZhc2NyaXB0XCIsIFwiamF2YXNjcmlwdHJlYWN0XCJdLFxuXHRcdHJlZ2V4OiAvXlxccyooPzooPzpwdWJsaWN8cHJpdmF0ZXxwcm90ZWN0ZWR8c3RhdGljfGFzeW5jfHJlYWRvbmx5KVxccyspKihcXHcrKVxccypcXCgvLFxuXHR9LFxuXHR7XG5cdFx0Ly8gUHl0aG9uOiBkZWYgZm9vKCB8IGFzeW5jIGRlZiBmb28oXG5cdFx0bGFuZ3VhZ2VzOiBbXCJweXRob25cIl0sXG5cdFx0cmVnZXg6IC9eXFxzKig/OmFzeW5jXFxzKyk/ZGVmXFxzKyhcXHcrKVxccypcXCgvLFxuXHR9LFxuXHR7XG5cdFx0Ly8gUHl0aG9uOiBjbGFzcyBGb29cblx0XHRsYW5ndWFnZXM6IFtcInB5dGhvblwiXSxcblx0XHRyZWdleDogL15cXHMqY2xhc3NcXHMrKFxcdyspLyxcblx0fSxcblx0e1xuXHRcdC8vIEdvOiBmdW5jIGZvbyggfCBmdW5jIChyIFJlY2VpdmVyKSBmb28oXG5cdFx0bGFuZ3VhZ2VzOiBbXCJnb1wiXSxcblx0XHRyZWdleDogL15cXHMqZnVuY1xccysoPzpcXChbXildK1xcKVxccyspPyhcXHcrKVxccypcXCgvLFxuXHR9LFxuXHR7XG5cdFx0Ly8gUnVzdDogZm4gZm9vKCB8IHB1YiBmbiBmb28oIHwgYXN5bmMgZm4gZm9vKFxuXHRcdGxhbmd1YWdlczogW1wicnVzdFwiXSxcblx0XHRyZWdleDogL15cXHMqKD86cHViKD86XFwoW14pXStcXCkpP1xccyspPyg/OmFzeW5jXFxzKyk/Zm5cXHMrKFxcdyspXFxzKlsoPF0vLFxuXHR9LFxuXTtcblxuLyoqXG4gKiBDb2RlTGVuc1Byb3ZpZGVyIHRoYXQgYWRkcyBhbiBcIkFzayBHU0RcIiBsZW5zIGFib3ZlIG5hbWVkIGZ1bmN0aW9uIGFuZCBjbGFzc1xuICogZGVjbGFyYXRpb25zLiBDbGlja2luZyB0aGUgbGVucyBzZW5kcyBhIGJyaWVmIGV4cGxhbmF0aW9uIHJlcXVlc3QgdG8gdGhlIEdTRFxuICogYWdlbnQgZm9yIHRoYXQgc3BlY2lmaWMgc3ltYm9sLlxuICovXG5leHBvcnQgY2xhc3MgR3NkQ29kZUxlbnNQcm92aWRlciBpbXBsZW1lbnRzIHZzY29kZS5Db2RlTGVuc1Byb3ZpZGVyLCB2c2NvZGUuRGlzcG9zYWJsZSB7XG5cdHByaXZhdGUgcmVhZG9ubHkgX29uRGlkQ2hhbmdlQ29kZUxlbnNlcyA9IG5ldyB2c2NvZGUuRXZlbnRFbWl0dGVyPHZvaWQ+KCk7XG5cdHJlYWRvbmx5IG9uRGlkQ2hhbmdlQ29kZUxlbnNlcyA9IHRoaXMuX29uRGlkQ2hhbmdlQ29kZUxlbnNlcy5ldmVudDtcblxuXHRwcml2YXRlIGRpc3Bvc2FibGVzOiB2c2NvZGUuRGlzcG9zYWJsZVtdID0gW107XG5cblx0Y29uc3RydWN0b3IocHJpdmF0ZSByZWFkb25seSBjbGllbnQ6IEdzZENsaWVudCkge1xuXHRcdHRoaXMuZGlzcG9zYWJsZXMucHVzaChcblx0XHRcdHRoaXMuX29uRGlkQ2hhbmdlQ29kZUxlbnNlcyxcblx0XHRcdGNsaWVudC5vbkNvbm5lY3Rpb25DaGFuZ2UoKCkgPT4gdGhpcy5fb25EaWRDaGFuZ2VDb2RlTGVuc2VzLmZpcmUoKSksXG5cdFx0XHR2c2NvZGUud29ya3NwYWNlLm9uRGlkQ2hhbmdlQ29uZmlndXJhdGlvbigoZSkgPT4ge1xuXHRcdFx0XHRpZiAoZS5hZmZlY3RzQ29uZmlndXJhdGlvbihcImdzZC5jb2RlTGVuc1wiKSkge1xuXHRcdFx0XHRcdHRoaXMuX29uRGlkQ2hhbmdlQ29kZUxlbnNlcy5maXJlKCk7XG5cdFx0XHRcdH1cblx0XHRcdH0pLFxuXHRcdCk7XG5cdH1cblxuXHRwcm92aWRlQ29kZUxlbnNlcyhcblx0XHRkb2N1bWVudDogdnNjb2RlLlRleHREb2N1bWVudCxcblx0XHRfdG9rZW46IHZzY29kZS5DYW5jZWxsYXRpb25Ub2tlbixcblx0KTogdnNjb2RlLkNvZGVMZW5zW10ge1xuXHRcdGNvbnN0IGxlbnNlczogdnNjb2RlLkNvZGVMZW5zW10gPSBbXTtcblxuXHRcdGlmICghdnNjb2RlLndvcmtzcGFjZS5nZXRDb25maWd1cmF0aW9uKFwiZ3NkXCIpLmdldDxib29sZWFuPihcImNvZGVMZW5zXCIsIHRydWUpKSB7XG5cdFx0XHRyZXR1cm4gbGVuc2VzO1xuXHRcdH1cblx0XHRjb25zdCBsYW5nSWQgPSBkb2N1bWVudC5sYW5ndWFnZUlkO1xuXHRcdGNvbnN0IHBhdHRlcm5zID0gU1lNQk9MX1BBVFRFUk5TLmZpbHRlcigocCkgPT4gcC5sYW5ndWFnZXMuaW5jbHVkZXMobGFuZ0lkKSk7XG5cblx0XHRpZiAocGF0dGVybnMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRyZXR1cm4gbGVuc2VzO1xuXHRcdH1cblxuXHRcdGNvbnN0IGZpbGVOYW1lID0gZG9jdW1lbnQuZmlsZU5hbWUuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSA/PyBkb2N1bWVudC5maWxlTmFtZTtcblx0XHRjb25zdCBzZWVuID0gbmV3IFNldDxudW1iZXI+KCk7XG5cblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IGRvY3VtZW50LmxpbmVDb3VudDsgaSsrKSB7XG5cdFx0XHRjb25zdCB0ZXh0ID0gZG9jdW1lbnQubGluZUF0KGkpLnRleHQ7XG5cblx0XHRcdGZvciAoY29uc3QgeyByZWdleCB9IG9mIHBhdHRlcm5zKSB7XG5cdFx0XHRcdGNvbnN0IG1hdGNoID0gcmVnZXguZXhlYyh0ZXh0KTtcblx0XHRcdFx0aWYgKG1hdGNoICYmIG1hdGNoWzFdICYmICFzZWVuLmhhcyhpKSkge1xuXHRcdFx0XHRcdHNlZW4uYWRkKGkpO1xuXHRcdFx0XHRcdGNvbnN0IHN5bWJvbE5hbWUgPSBtYXRjaFsxXTtcblx0XHRcdFx0XHRjb25zdCByYW5nZSA9IG5ldyB2c2NvZGUuUmFuZ2UoaSwgMCwgaSwgdGV4dC5sZW5ndGgpO1xuXHRcdFx0XHRcdGNvbnN0IGFyZ3MgPSBbc3ltYm9sTmFtZSwgZmlsZU5hbWUsIGkgKyAxXTtcblxuXHRcdFx0XHRcdGxlbnNlcy5wdXNoKFxuXHRcdFx0XHRcdFx0bmV3IHZzY29kZS5Db2RlTGVucyhyYW5nZSwge1xuXHRcdFx0XHRcdFx0XHR0aXRsZTogXCIkKGh1Ym90KSBBc2sgR1NEXCIsXG5cdFx0XHRcdFx0XHRcdHRvb2x0aXA6IGBBc2sgR1NEIHRvIGV4cGxhaW4gJHtzeW1ib2xOYW1lfWAsXG5cdFx0XHRcdFx0XHRcdGNvbW1hbmQ6IFwiZ3NkLmFza0Fib3V0U3ltYm9sXCIsXG5cdFx0XHRcdFx0XHRcdGFyZ3VtZW50czogYXJncyxcblx0XHRcdFx0XHRcdH0pLFxuXHRcdFx0XHRcdFx0bmV3IHZzY29kZS5Db2RlTGVucyhyYW5nZSwge1xuXHRcdFx0XHRcdFx0XHR0aXRsZTogXCIkKHBlbmNpbCkgUmVmYWN0b3JcIixcblx0XHRcdFx0XHRcdFx0dG9vbHRpcDogYFJlZmFjdG9yICR7c3ltYm9sTmFtZX1gLFxuXHRcdFx0XHRcdFx0XHRjb21tYW5kOiBcImdzZC5yZWZhY3RvclN5bWJvbFwiLFxuXHRcdFx0XHRcdFx0XHRhcmd1bWVudHM6IGFyZ3MsXG5cdFx0XHRcdFx0XHR9KSxcblx0XHRcdFx0XHRcdG5ldyB2c2NvZGUuQ29kZUxlbnMocmFuZ2UsIHtcblx0XHRcdFx0XHRcdFx0dGl0bGU6IFwiJChidWcpIEZpbmQgQnVnc1wiLFxuXHRcdFx0XHRcdFx0XHR0b29sdGlwOiBgUmV2aWV3ICR7c3ltYm9sTmFtZX0gZm9yIGJ1Z3NgLFxuXHRcdFx0XHRcdFx0XHRjb21tYW5kOiBcImdzZC5maW5kQnVnc1N5bWJvbFwiLFxuXHRcdFx0XHRcdFx0XHRhcmd1bWVudHM6IGFyZ3MsXG5cdFx0XHRcdFx0XHR9KSxcblx0XHRcdFx0XHRcdG5ldyB2c2NvZGUuQ29kZUxlbnMocmFuZ2UsIHtcblx0XHRcdFx0XHRcdFx0dGl0bGU6IFwiJChiZWFrZXIpIFRlc3RzXCIsXG5cdFx0XHRcdFx0XHRcdHRvb2x0aXA6IGBHZW5lcmF0ZSB0ZXN0cyBmb3IgJHtzeW1ib2xOYW1lfWAsXG5cdFx0XHRcdFx0XHRcdGNvbW1hbmQ6IFwiZ3NkLmdlbmVyYXRlVGVzdHNTeW1ib2xcIixcblx0XHRcdFx0XHRcdFx0YXJndW1lbnRzOiBhcmdzLFxuXHRcdFx0XHRcdFx0fSksXG5cdFx0XHRcdFx0KTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHJldHVybiBsZW5zZXM7XG5cdH1cblxuXHRkaXNwb3NlKCk6IHZvaWQge1xuXHRcdGZvciAoY29uc3QgZCBvZiB0aGlzLmRpc3Bvc2FibGVzKSB7XG5cdFx0XHRkLmRpc3Bvc2UoKTtcblx0XHR9XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFlBQVksWUFBWTtBQVF4QixNQUFNLGtCQUE0RDtBQUFBLEVBQ2pFO0FBQUE7QUFBQSxJQUVDLFdBQVcsQ0FBQyxjQUFjLG1CQUFtQixjQUFjLGlCQUFpQjtBQUFBLElBQzVFLE9BQU87QUFBQSxFQUNSO0FBQUEsRUFDQTtBQUFBO0FBQUEsSUFFQyxXQUFXLENBQUMsY0FBYyxtQkFBbUIsY0FBYyxpQkFBaUI7QUFBQSxJQUM1RSxPQUFPO0FBQUEsRUFDUjtBQUFBLEVBQ0E7QUFBQTtBQUFBO0FBQUEsSUFHQyxXQUFXLENBQUMsY0FBYyxtQkFBbUIsY0FBYyxpQkFBaUI7QUFBQSxJQUM1RSxPQUFPO0FBQUEsRUFDUjtBQUFBLEVBQ0E7QUFBQTtBQUFBLElBRUMsV0FBVyxDQUFDLFFBQVE7QUFBQSxJQUNwQixPQUFPO0FBQUEsRUFDUjtBQUFBLEVBQ0E7QUFBQTtBQUFBLElBRUMsV0FBVyxDQUFDLFFBQVE7QUFBQSxJQUNwQixPQUFPO0FBQUEsRUFDUjtBQUFBLEVBQ0E7QUFBQTtBQUFBLElBRUMsV0FBVyxDQUFDLElBQUk7QUFBQSxJQUNoQixPQUFPO0FBQUEsRUFDUjtBQUFBLEVBQ0E7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
