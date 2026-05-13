import { createRequire } from "node:module";
import { debugTime, debugCount, debugPeak } from "../gsd/debug-logger.js";
const _require = createRequire(import.meta.url);
const picomatch = _require("picomatch");
let nativeTtsr = null;
try {
  const native = await import("@gsd/native");
  if (native.ttsrCompileRules && native.ttsrCheckBuffer && native.ttsrFreeRules) {
    nativeTtsr = {
      ttsrCompileRules: native.ttsrCompileRules,
      ttsrCheckBuffer: native.ttsrCheckBuffer,
      ttsrFreeRules: native.ttsrFreeRules
    };
  }
} catch {
}
const DEFAULT_SETTINGS = {
  enabled: true,
  contextMode: "discard",
  interruptMode: "always",
  repeatMode: "once",
  repeatGap: 10
};
const MAX_BUFFER_BYTES = 512 * 1024;
const JS_FALLBACK_CHECK_INTERVAL_MS = 50;
const DEFAULT_SCOPE = {
  allowText: true,
  allowThinking: false,
  allowAnyTool: true,
  toolScopes: []
};
class TtsrManager {
  #settings;
  #rules = /* @__PURE__ */ new Map();
  #injectionRecords = /* @__PURE__ */ new Map();
  #buffers = /* @__PURE__ */ new Map();
  /** Tracks last JS-fallback check time per buffer key to throttle CPU (#468). */
  #lastJsCheckAt = /* @__PURE__ */ new Map();
  #messageCount = 0;
  #nativeHandle = null;
  #nativeDirty = false;
  constructor(settings) {
    this.#settings = { ...DEFAULT_SETTINGS, ...settings };
  }
  #canTrigger(ruleName) {
    const record = this.#injectionRecords.get(ruleName);
    if (!record) return true;
    if (this.#settings.repeatMode === "once") return false;
    const gap = this.#messageCount - record.lastInjectedAt;
    return gap >= this.#settings.repeatGap;
  }
  #compileConditions(rule) {
    const compiled = [];
    for (const pattern of rule.condition ?? []) {
      try {
        compiled.push(new RegExp(pattern));
      } catch (err) {
        console.warn(`[ttsr] Rule "${rule.name}": invalid regex "${pattern}" \u2014 ${err.message}`);
      }
    }
    return compiled;
  }
  #compileGlobalPathMatchers(globs) {
    if (!globs || globs.length === 0) return void 0;
    const matchers = globs.map((g) => g.trim()).filter((g) => g.length > 0).map((g) => picomatch(g));
    return matchers.length > 0 ? matchers : void 0;
  }
  #parseToolScopeToken(token) {
    const match = /^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i.exec(token);
    if (!match) return void 0;
    const groups = match.groups;
    const hasToolPrefix = groups?.prefix !== void 0;
    const toolName = (groups?.tool ?? (hasToolPrefix ? void 0 : groups?.bare))?.trim().toLowerCase();
    const pathPattern = groups?.path?.trim();
    if (!pathPattern) return { toolName };
    return {
      toolName,
      pathPattern,
      pathMatcher: picomatch(pathPattern)
    };
  }
  #buildScope(rule) {
    if (!rule.scope || rule.scope.length === 0) {
      return {
        allowText: DEFAULT_SCOPE.allowText,
        allowThinking: DEFAULT_SCOPE.allowThinking,
        allowAnyTool: DEFAULT_SCOPE.allowAnyTool,
        toolScopes: [...DEFAULT_SCOPE.toolScopes]
      };
    }
    const scope = {
      allowText: false,
      allowThinking: false,
      allowAnyTool: false,
      toolScopes: []
    };
    for (const rawToken of rule.scope) {
      const token = rawToken.trim();
      const normalized = token.toLowerCase();
      if (token.length === 0) continue;
      if (normalized === "text") {
        scope.allowText = true;
        continue;
      }
      if (normalized === "thinking") {
        scope.allowThinking = true;
        continue;
      }
      if (normalized === "tool" || normalized === "toolcall") {
        scope.allowAnyTool = true;
        continue;
      }
      const toolScope = this.#parseToolScopeToken(token);
      if (!toolScope) continue;
      if (!toolScope.toolName && !toolScope.pathMatcher) {
        scope.allowAnyTool = true;
        continue;
      }
      scope.toolScopes.push(toolScope);
    }
    return scope;
  }
  #hasReachableScope(scope) {
    return scope.allowText || scope.allowThinking || scope.allowAnyTool || scope.toolScopes.length > 0;
  }
  #bufferKey(context) {
    if (context.streamKey && context.streamKey.trim().length > 0) return context.streamKey;
    if (context.source !== "tool") return context.source;
    const toolName = context.toolName?.trim().toLowerCase();
    return toolName ? `tool:${toolName}` : "tool";
  }
  #normalizePath(pathValue) {
    return pathValue.replaceAll("\\", "/");
  }
  #matchesGlob(matcher, filePaths) {
    if (!filePaths || filePaths.length === 0) return false;
    for (const filePath of filePaths) {
      const normalized = this.#normalizePath(filePath);
      if (matcher(normalized)) return true;
      const slashIndex = normalized.lastIndexOf("/");
      const basename = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
      if (basename !== normalized && matcher(basename)) return true;
    }
    return false;
  }
  #matchesGlobalPaths(entry, context) {
    if (!entry.globalPathMatchers || entry.globalPathMatchers.length === 0) return true;
    for (const matcher of entry.globalPathMatchers) {
      if (this.#matchesGlob(matcher, context.filePaths)) return true;
    }
    return false;
  }
  #matchesScope(entry, context) {
    if (context.source === "text") return entry.scope.allowText;
    if (context.source === "thinking") return entry.scope.allowThinking;
    if (entry.scope.allowAnyTool) return true;
    const toolName = context.toolName?.trim().toLowerCase();
    for (const toolScope of entry.scope.toolScopes) {
      if (toolScope.toolName && toolScope.toolName !== toolName) continue;
      if (toolScope.pathMatcher && !this.#matchesGlob(toolScope.pathMatcher, context.filePaths)) continue;
      return true;
    }
    return false;
  }
  #matchesCondition(entry, streamBuffer) {
    for (const condition of entry.conditions) {
      condition.lastIndex = 0;
      if (condition.test(streamBuffer)) return true;
    }
    return false;
  }
  /** Compile (or recompile) the native RegexSet from all current rules. */
  #compileNative() {
    if (!nativeTtsr || !this.#nativeDirty) return;
    if (this.#nativeHandle !== null) {
      try {
        nativeTtsr.ttsrFreeRules(this.#nativeHandle);
      } catch {
      }
      this.#nativeHandle = null;
    }
    const ruleInputs = [];
    for (const [, entry] of this.#rules) {
      ruleInputs.push({
        name: entry.rule.name,
        conditions: entry.rule.condition
      });
    }
    if (ruleInputs.length === 0) {
      this.#nativeDirty = false;
      return;
    }
    try {
      this.#nativeHandle = nativeTtsr.ttsrCompileRules(ruleInputs);
    } catch (err) {
      console.warn(`[ttsr] Native compilation failed, using JS fallback: ${err.message}`);
      this.#nativeHandle = null;
    }
    this.#nativeDirty = false;
  }
  /** Add a TTSR rule to be monitored. */
  addRule(rule) {
    if (this.#rules.has(rule.name)) return false;
    const conditions = this.#compileConditions(rule);
    if (conditions.length === 0) return false;
    const scope = this.#buildScope(rule);
    if (!this.#hasReachableScope(scope)) return false;
    const globalPathMatchers = this.#compileGlobalPathMatchers(rule.globs);
    this.#rules.set(rule.name, { rule, conditions, scope, globalPathMatchers });
    this.#nativeDirty = true;
    return true;
  }
  /**
   * Add a stream chunk to its scoped buffer and return matching rules.
   *
   * Buffers are isolated by source/tool key so matches don't bleed across
   * assistant prose, thinking text, and unrelated tool argument streams.
   *
   * When the native Rust engine is available, all regex conditions are tested
   * in a single DFA pass via RegexSet. Scope, glob, and repeat-gate checks
   * remain in JS as they are lightweight and context-dependent.
   */
  checkDelta(delta, context) {
    const stopTimer = debugTime("ttsr-check");
    const bufferKey = this.#bufferKey(context);
    let nextBuffer = `${this.#buffers.get(bufferKey) ?? ""}${delta}`;
    if (nextBuffer.length > MAX_BUFFER_BYTES) {
      nextBuffer = nextBuffer.slice(-MAX_BUFFER_BYTES);
    }
    this.#buffers.set(bufferKey, nextBuffer);
    debugPeak("ttsrPeakBuffer", nextBuffer.length);
    if (this.#nativeDirty) this.#compileNative();
    if (nativeTtsr && this.#nativeHandle !== null) {
      const regexMatchedNames = nativeTtsr.ttsrCheckBuffer(this.#nativeHandle, nextBuffer);
      const regexMatchedSet = new Set(regexMatchedNames);
      const matches2 = [];
      for (const [name, entry] of this.#rules) {
        if (!regexMatchedSet.has(name)) continue;
        if (!this.#canTrigger(name)) continue;
        if (!this.#matchesScope(entry, context)) continue;
        if (!this.#matchesGlobalPaths(entry, context)) continue;
        matches2.push(entry.rule);
      }
      debugCount("ttsrChecks");
      stopTimer({ bufferSize: nextBuffer.length, native: true, rulesChecked: this.#rules.size, matched: matches2.map((m) => m.name) });
      return matches2;
    }
    const now = Date.now();
    const lastCheck = this.#lastJsCheckAt.get(bufferKey) ?? 0;
    if (now - lastCheck < JS_FALLBACK_CHECK_INTERVAL_MS) {
      stopTimer({ bufferSize: nextBuffer.length, throttled: true });
      return [];
    }
    this.#lastJsCheckAt.set(bufferKey, now);
    const matches = [];
    for (const [name, entry] of this.#rules) {
      if (!this.#canTrigger(name)) continue;
      if (!this.#matchesScope(entry, context)) continue;
      if (!this.#matchesGlobalPaths(entry, context)) continue;
      if (!this.#matchesCondition(entry, nextBuffer)) continue;
      matches.push(entry.rule);
    }
    debugCount("ttsrChecks");
    stopTimer({ bufferSize: nextBuffer.length, native: false, rulesChecked: this.#rules.size, matched: matches.map((m) => m.name) });
    return matches;
  }
  /** Mark rules as injected (won't trigger again until conditions allow). */
  markInjected(rulesToMark) {
    this.markInjectedByNames(rulesToMark.map((r) => r.name));
  }
  /** Mark rule names as injected. */
  markInjectedByNames(ruleNames) {
    for (const rawName of ruleNames) {
      const ruleName = rawName.trim();
      if (ruleName.length === 0) continue;
      const record = this.#injectionRecords.get(ruleName);
      if (!record) {
        this.#injectionRecords.set(ruleName, { lastInjectedAt: this.#messageCount });
      } else {
        record.lastInjectedAt = this.#messageCount;
      }
    }
  }
  /** Get names of all injected rules (for persistence). */
  getInjectedRuleNames() {
    return Array.from(this.#injectionRecords.keys());
  }
  /** Restore injected state from a list of rule names. */
  restoreInjected(ruleNames) {
    for (const name of ruleNames) {
      this.#injectionRecords.set(name, { lastInjectedAt: 0 });
    }
  }
  /** Reset stream buffers (called on new turn). */
  resetBuffer() {
    this.#buffers.clear();
    this.#lastJsCheckAt.clear();
  }
  /** Check if any TTSR rules are registered. */
  hasRules() {
    return this.#rules.size > 0;
  }
  /** Increment message counter (call after each turn). */
  incrementMessageCount() {
    this.#messageCount++;
  }
  /** Get current message count. */
  getMessageCount() {
    return this.#messageCount;
  }
  /** Get settings. */
  getSettings() {
    return this.#settings;
  }
}
export {
  TtsrManager
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3R0c3IvdHRzci1tYW5hZ2VyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFRpbWUgVHJhdmVsaW5nIFN0cmVhbSBSdWxlcyAoVFRTUikgTWFuYWdlclxuICpcbiAqIE1hbmFnZXMgcnVsZXMgdGhhdCBnZXQgaW5qZWN0ZWQgbWlkLXN0cmVhbSB3aGVuIHRoZWlyIGNvbmRpdGlvbiBwYXR0ZXJuIG1hdGNoZXNcbiAqIHRoZSBhZ2VudCdzIG91dHB1dC4gV2hlbiBhIG1hdGNoIG9jY3VycywgdGhlIHN0cmVhbSBpcyBhYm9ydGVkLCB0aGUgcnVsZSBpc1xuICogaW5qZWN0ZWQgYXMgYSBzeXN0ZW0gcmVtaW5kZXIsIGFuZCB0aGUgcmVxdWVzdCBpcyByZXRyaWVkLlxuICpcbiAqIFRoZSByZWdleCBob3QtcGF0aCBpcyBkZWxlZ2F0ZWQgdG8gYSBuYXRpdmUgUnVzdCBSZWdleFNldCBlbmdpbmUgd2hlblxuICogYXZhaWxhYmxlLCB0ZXN0aW5nIGFsbCBwYXR0ZXJucyBpbiBhIHNpbmdsZSBERkEgcGFzcy4gRmFsbHMgYmFjayB0b1xuICogcGVyLXJ1bGUgSlMgUmVnRXhwIGl0ZXJhdGlvbiB3aGVuIHRoZSBuYXRpdmUgbW9kdWxlIGlzIG5vdCBsb2FkZWQuXG4gKi9cbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tIFwibm9kZTptb2R1bGVcIjtcbmltcG9ydCB7IGRlYnVnVGltZSwgZGVidWdDb3VudCwgZGVidWdQZWFrIH0gZnJvbSBcIi4uL2dzZC9kZWJ1Zy1sb2dnZXIuanNcIjtcblxuY29uc3QgX3JlcXVpcmUgPSBjcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XG50eXBlIFBpY29tYXRjaE1hdGNoZXIgPSAoaW5wdXQ6IHN0cmluZykgPT4gYm9vbGVhbjtcbnR5cGUgUGljb21hdGNoRm4gPSAocGF0dGVybjogc3RyaW5nKSA9PiBQaWNvbWF0Y2hNYXRjaGVyO1xuY29uc3QgcGljb21hdGNoID0gX3JlcXVpcmUoXCJwaWNvbWF0Y2hcIikgYXMgUGljb21hdGNoRm47XG5cbi8vIFx1MjUwMFx1MjUwMCBOYXRpdmUgVFRTUiBlbmdpbmUgKG9wdGlvbmFsKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmxldCBuYXRpdmVUdHNyOiB7XG5cdHR0c3JDb21waWxlUnVsZXM6IChydWxlczogeyBuYW1lOiBzdHJpbmc7IGNvbmRpdGlvbnM6IHN0cmluZ1tdIH1bXSkgPT4gbnVtYmVyO1xuXHR0dHNyQ2hlY2tCdWZmZXI6IChoYW5kbGU6IG51bWJlciwgYnVmZmVyOiBzdHJpbmcpID0+IHN0cmluZ1tdO1xuXHR0dHNyRnJlZVJ1bGVzOiAoaGFuZGxlOiBudW1iZXIpID0+IHZvaWQ7XG59IHwgbnVsbCA9IG51bGw7XG5cbnRyeSB7XG5cdC8vIER5bmFtaWMgaW1wb3J0IHRvIGF2b2lkIGhhcmQgZGVwZW5kZW5jeSBcdTIwMTQgZ3JhY2VmdWxseSBkZWdyYWRlcyB0byBKUy5cblx0Y29uc3QgbmF0aXZlID0gYXdhaXQgaW1wb3J0KFwiQGdzZC9uYXRpdmVcIik7XG5cdGlmIChuYXRpdmUudHRzckNvbXBpbGVSdWxlcyAmJiBuYXRpdmUudHRzckNoZWNrQnVmZmVyICYmIG5hdGl2ZS50dHNyRnJlZVJ1bGVzKSB7XG5cdFx0bmF0aXZlVHRzciA9IHtcblx0XHRcdHR0c3JDb21waWxlUnVsZXM6IG5hdGl2ZS50dHNyQ29tcGlsZVJ1bGVzLFxuXHRcdFx0dHRzckNoZWNrQnVmZmVyOiBuYXRpdmUudHRzckNoZWNrQnVmZmVyLFxuXHRcdFx0dHRzckZyZWVSdWxlczogbmF0aXZlLnR0c3JGcmVlUnVsZXMsXG5cdFx0fTtcblx0fVxufSBjYXRjaCB7XG5cdC8vIE5hdGl2ZSBtb2R1bGUgbm90IGF2YWlsYWJsZSBcdTIwMTQgSlMgZmFsbGJhY2sgd2lsbCBiZSB1c2VkLlxufVxuXG5leHBvcnQgdHlwZSBUdHNyTWF0Y2hTb3VyY2UgPSBcInRleHRcIiB8IFwidGhpbmtpbmdcIiB8IFwidG9vbFwiO1xuXG4vKiogQ29udGV4dCBhYm91dCB0aGUgc3RyZWFtIGNvbnRlbnQgY3VycmVudGx5IGJlaW5nIGNoZWNrZWQgYWdhaW5zdCBUVFNSIHJ1bGVzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBUdHNyTWF0Y2hDb250ZXh0IHtcblx0c291cmNlOiBUdHNyTWF0Y2hTb3VyY2U7XG5cdC8qKiBUb29sIG5hbWUgZm9yIHRvb2wgYXJndW1lbnQgZGVsdGFzLCBlLmcuIFwiZWRpdFwiIG9yIFwid3JpdGVcIi4gKi9cblx0dG9vbE5hbWU/OiBzdHJpbmc7XG5cdC8qKiBDYW5kaWRhdGUgZmlsZSBwYXRocyBhc3NvY2lhdGVkIHdpdGggdGhlIGN1cnJlbnQgc3RyZWFtIGNodW5rLiAqL1xuXHRmaWxlUGF0aHM/OiBzdHJpbmdbXTtcblx0LyoqIFN0YWJsZSBrZXkgdG8gaXNvbGF0ZSBidWZmZXJpbmcgKGZvciBleGFtcGxlIGEgdG9vbCBjYWxsIElEKS4gKi9cblx0c3RyZWFtS2V5Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJ1bGUge1xuXHRuYW1lOiBzdHJpbmc7XG5cdHBhdGg6IHN0cmluZztcblx0Y29udGVudDogc3RyaW5nO1xuXHRjb25kaXRpb246IHN0cmluZ1tdO1xuXHRzY29wZT86IHN0cmluZ1tdO1xuXHRnbG9icz86IHN0cmluZ1tdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFR0c3JTZXR0aW5ncyB7XG5cdGVuYWJsZWQ/OiBib29sZWFuO1xuXHRjb250ZXh0TW9kZT86IFwiZGlzY2FyZFwiIHwgXCJrZWVwXCI7XG5cdGludGVycnVwdE1vZGU/OiBcImFsd2F5c1wiIHwgXCJmaXJzdFwiO1xuXHRyZXBlYXRNb2RlPzogXCJvbmNlXCIgfCBcImdhcFwiO1xuXHRyZXBlYXRHYXA/OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBUb29sU2NvcGUge1xuXHR0b29sTmFtZT86IHN0cmluZztcblx0cGF0aE1hdGNoZXI/OiBQaWNvbWF0Y2hNYXRjaGVyO1xuXHRwYXRoUGF0dGVybj86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFR0c3JTY29wZSB7XG5cdGFsbG93VGV4dDogYm9vbGVhbjtcblx0YWxsb3dUaGlua2luZzogYm9vbGVhbjtcblx0YWxsb3dBbnlUb29sOiBib29sZWFuO1xuXHR0b29sU2NvcGVzOiBUb29sU2NvcGVbXTtcbn1cblxuaW50ZXJmYWNlIFR0c3JFbnRyeSB7XG5cdHJ1bGU6IFJ1bGU7XG5cdGNvbmRpdGlvbnM6IFJlZ0V4cFtdO1xuXHRzY29wZTogVHRzclNjb3BlO1xuXHRnbG9iYWxQYXRoTWF0Y2hlcnM/OiBQaWNvbWF0Y2hNYXRjaGVyW107XG59XG5cbi8qKiBUcmFja3Mgd2hlbiBhIHJ1bGUgd2FzIGxhc3QgaW5qZWN0ZWQgKGZvciByZXBlYXQgZ2F0aW5nKS4gKi9cbmludGVyZmFjZSBJbmplY3Rpb25SZWNvcmQge1xuXHRsYXN0SW5qZWN0ZWRBdDogbnVtYmVyO1xufVxuXG5jb25zdCBERUZBVUxUX1NFVFRJTkdTOiBSZXF1aXJlZDxUdHNyU2V0dGluZ3M+ID0ge1xuXHRlbmFibGVkOiB0cnVlLFxuXHRjb250ZXh0TW9kZTogXCJkaXNjYXJkXCIsXG5cdGludGVycnVwdE1vZGU6IFwiYWx3YXlzXCIsXG5cdHJlcGVhdE1vZGU6IFwib25jZVwiLFxuXHRyZXBlYXRHYXA6IDEwLFxufTtcblxuLyoqIENhcCBwZXItc3RyZWFtIGJ1ZmZlciBhdCA1MTJLQiB0byBwcmV2ZW50IHVuYm91bmRlZCBtZW1vcnkgZ3Jvd3RoLiAqL1xuY29uc3QgTUFYX0JVRkZFUl9CWVRFUyA9IDUxMiAqIDEwMjQ7XG5cbi8qKlxuICogTWluaW11bSBpbnRlcnZhbCAobXMpIGJldHdlZW4gSlMtZmFsbGJhY2sgcmVnZXggY2hlY2tzIG9uIHRoZSBzYW1lIGJ1ZmZlci5cbiAqIFByZXZlbnRzIENQVSBzcGlubmluZyB3aGVuIGRlbHRhcyBhcnJpdmUgZmFzdGVyIHRoYW4gcmVnZXggZXZhbHVhdGlvbiAoIzQ2OCkuXG4gKi9cbmNvbnN0IEpTX0ZBTExCQUNLX0NIRUNLX0lOVEVSVkFMX01TID0gNTA7XG5cbmNvbnN0IERFRkFVTFRfU0NPUEU6IFR0c3JTY29wZSA9IHtcblx0YWxsb3dUZXh0OiB0cnVlLFxuXHRhbGxvd1RoaW5raW5nOiBmYWxzZSxcblx0YWxsb3dBbnlUb29sOiB0cnVlLFxuXHR0b29sU2NvcGVzOiBbXSxcbn07XG5cbmV4cG9ydCBjbGFzcyBUdHNyTWFuYWdlciB7XG5cdHJlYWRvbmx5ICNzZXR0aW5nczogUmVxdWlyZWQ8VHRzclNldHRpbmdzPjtcblx0cmVhZG9ubHkgI3J1bGVzID0gbmV3IE1hcDxzdHJpbmcsIFR0c3JFbnRyeT4oKTtcblx0cmVhZG9ubHkgI2luamVjdGlvblJlY29yZHMgPSBuZXcgTWFwPHN0cmluZywgSW5qZWN0aW9uUmVjb3JkPigpO1xuXHRyZWFkb25seSAjYnVmZmVycyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG5cdC8qKiBUcmFja3MgbGFzdCBKUy1mYWxsYmFjayBjaGVjayB0aW1lIHBlciBidWZmZXIga2V5IHRvIHRocm90dGxlIENQVSAoIzQ2OCkuICovXG5cdHJlYWRvbmx5ICNsYXN0SnNDaGVja0F0ID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcblx0I21lc3NhZ2VDb3VudCA9IDA7XG5cdCNuYXRpdmVIYW5kbGU6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXHQjbmF0aXZlRGlydHkgPSBmYWxzZTtcblxuXHRjb25zdHJ1Y3RvcihzZXR0aW5ncz86IFR0c3JTZXR0aW5ncykge1xuXHRcdHRoaXMuI3NldHRpbmdzID0geyAuLi5ERUZBVUxUX1NFVFRJTkdTLCAuLi5zZXR0aW5ncyB9O1xuXHR9XG5cblx0I2NhblRyaWdnZXIocnVsZU5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRcdGNvbnN0IHJlY29yZCA9IHRoaXMuI2luamVjdGlvblJlY29yZHMuZ2V0KHJ1bGVOYW1lKTtcblx0XHRpZiAoIXJlY29yZCkgcmV0dXJuIHRydWU7XG5cdFx0aWYgKHRoaXMuI3NldHRpbmdzLnJlcGVhdE1vZGUgPT09IFwib25jZVwiKSByZXR1cm4gZmFsc2U7XG5cdFx0Y29uc3QgZ2FwID0gdGhpcy4jbWVzc2FnZUNvdW50IC0gcmVjb3JkLmxhc3RJbmplY3RlZEF0O1xuXHRcdHJldHVybiBnYXAgPj0gdGhpcy4jc2V0dGluZ3MucmVwZWF0R2FwO1xuXHR9XG5cblx0I2NvbXBpbGVDb25kaXRpb25zKHJ1bGU6IFJ1bGUpOiBSZWdFeHBbXSB7XG5cdFx0Y29uc3QgY29tcGlsZWQ6IFJlZ0V4cFtdID0gW107XG5cdFx0Zm9yIChjb25zdCBwYXR0ZXJuIG9mIHJ1bGUuY29uZGl0aW9uID8/IFtdKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb21waWxlZC5wdXNoKG5ldyBSZWdFeHAocGF0dGVybikpO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGNvbnNvbGUud2FybihgW3R0c3JdIFJ1bGUgXCIke3J1bGUubmFtZX1cIjogaW52YWxpZCByZWdleCBcIiR7cGF0dGVybn1cIiBcdTIwMTQgJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRyZXR1cm4gY29tcGlsZWQ7XG5cdH1cblxuXHQjY29tcGlsZUdsb2JhbFBhdGhNYXRjaGVycyhnbG9iczogUnVsZVtcImdsb2JzXCJdKTogUGljb21hdGNoTWF0Y2hlcltdIHwgdW5kZWZpbmVkIHtcblx0XHRpZiAoIWdsb2JzIHx8IGdsb2JzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblx0XHRjb25zdCBtYXRjaGVycyA9IGdsb2JzXG5cdFx0XHQubWFwKChnKSA9PiBnLnRyaW0oKSlcblx0XHRcdC5maWx0ZXIoKGcpID0+IGcubGVuZ3RoID4gMClcblx0XHRcdC5tYXAoKGcpID0+IHBpY29tYXRjaChnKSk7XG5cdFx0cmV0dXJuIG1hdGNoZXJzLmxlbmd0aCA+IDAgPyBtYXRjaGVycyA6IHVuZGVmaW5lZDtcblx0fVxuXG5cdCNwYXJzZVRvb2xTY29wZVRva2VuKHRva2VuOiBzdHJpbmcpOiBUb29sU2NvcGUgfCB1bmRlZmluZWQge1xuXHRcdGNvbnN0IG1hdGNoID1cblx0XHRcdC9eKD86KD88cHJlZml4PnRvb2wpKD86Oig/PHRvb2w+W2EtejAtOV8tXSspKT98KD88YmFyZT5bYS16MC05Xy1dKykpKD86XFwoKD88cGF0aD5bXildKylcXCkpPyQvaS5leGVjKHRva2VuKTtcblx0XHRpZiAoIW1hdGNoKSByZXR1cm4gdW5kZWZpbmVkO1xuXG5cdFx0Y29uc3QgZ3JvdXBzID0gbWF0Y2guZ3JvdXBzO1xuXHRcdGNvbnN0IGhhc1Rvb2xQcmVmaXggPSBncm91cHM/LnByZWZpeCAhPT0gdW5kZWZpbmVkO1xuXHRcdGNvbnN0IHRvb2xOYW1lID0gKGdyb3Vwcz8udG9vbCA/PyAoaGFzVG9vbFByZWZpeCA/IHVuZGVmaW5lZCA6IGdyb3Vwcz8uYmFyZSkpPy50cmltKCkudG9Mb3dlckNhc2UoKTtcblx0XHRjb25zdCBwYXRoUGF0dGVybiA9IGdyb3Vwcz8ucGF0aD8udHJpbSgpO1xuXG5cdFx0aWYgKCFwYXRoUGF0dGVybikgcmV0dXJuIHsgdG9vbE5hbWUgfTtcblxuXHRcdHJldHVybiB7XG5cdFx0XHR0b29sTmFtZSxcblx0XHRcdHBhdGhQYXR0ZXJuLFxuXHRcdFx0cGF0aE1hdGNoZXI6IHBpY29tYXRjaChwYXRoUGF0dGVybiksXG5cdFx0fTtcblx0fVxuXG5cdCNidWlsZFNjb3BlKHJ1bGU6IFJ1bGUpOiBUdHNyU2NvcGUge1xuXHRcdGlmICghcnVsZS5zY29wZSB8fCBydWxlLnNjb3BlLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0YWxsb3dUZXh0OiBERUZBVUxUX1NDT1BFLmFsbG93VGV4dCxcblx0XHRcdFx0YWxsb3dUaGlua2luZzogREVGQVVMVF9TQ09QRS5hbGxvd1RoaW5raW5nLFxuXHRcdFx0XHRhbGxvd0FueVRvb2w6IERFRkFVTFRfU0NPUEUuYWxsb3dBbnlUb29sLFxuXHRcdFx0XHR0b29sU2NvcGVzOiBbLi4uREVGQVVMVF9TQ09QRS50b29sU2NvcGVzXSxcblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0Y29uc3Qgc2NvcGU6IFR0c3JTY29wZSA9IHtcblx0XHRcdGFsbG93VGV4dDogZmFsc2UsXG5cdFx0XHRhbGxvd1RoaW5raW5nOiBmYWxzZSxcblx0XHRcdGFsbG93QW55VG9vbDogZmFsc2UsXG5cdFx0XHR0b29sU2NvcGVzOiBbXSxcblx0XHR9O1xuXG5cdFx0Zm9yIChjb25zdCByYXdUb2tlbiBvZiBydWxlLnNjb3BlKSB7XG5cdFx0XHRjb25zdCB0b2tlbiA9IHJhd1Rva2VuLnRyaW0oKTtcblx0XHRcdGNvbnN0IG5vcm1hbGl6ZWQgPSB0b2tlbi50b0xvd2VyQ2FzZSgpO1xuXHRcdFx0aWYgKHRva2VuLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG5cblx0XHRcdGlmIChub3JtYWxpemVkID09PSBcInRleHRcIikge1xuXHRcdFx0XHRzY29wZS5hbGxvd1RleHQgPSB0cnVlO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdGlmIChub3JtYWxpemVkID09PSBcInRoaW5raW5nXCIpIHtcblx0XHRcdFx0c2NvcGUuYWxsb3dUaGlua2luZyA9IHRydWU7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0aWYgKG5vcm1hbGl6ZWQgPT09IFwidG9vbFwiIHx8IG5vcm1hbGl6ZWQgPT09IFwidG9vbGNhbGxcIikge1xuXHRcdFx0XHRzY29wZS5hbGxvd0FueVRvb2wgPSB0cnVlO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgdG9vbFNjb3BlID0gdGhpcy4jcGFyc2VUb29sU2NvcGVUb2tlbih0b2tlbik7XG5cdFx0XHRpZiAoIXRvb2xTY29wZSkgY29udGludWU7XG5cblx0XHRcdGlmICghdG9vbFNjb3BlLnRvb2xOYW1lICYmICF0b29sU2NvcGUucGF0aE1hdGNoZXIpIHtcblx0XHRcdFx0c2NvcGUuYWxsb3dBbnlUb29sID0gdHJ1ZTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdHNjb3BlLnRvb2xTY29wZXMucHVzaCh0b29sU2NvcGUpO1xuXHRcdH1cblxuXHRcdHJldHVybiBzY29wZTtcblx0fVxuXG5cdCNoYXNSZWFjaGFibGVTY29wZShzY29wZTogVHRzclNjb3BlKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHNjb3BlLmFsbG93VGV4dCB8fCBzY29wZS5hbGxvd1RoaW5raW5nIHx8IHNjb3BlLmFsbG93QW55VG9vbCB8fCBzY29wZS50b29sU2NvcGVzLmxlbmd0aCA+IDA7XG5cdH1cblxuXHQjYnVmZmVyS2V5KGNvbnRleHQ6IFR0c3JNYXRjaENvbnRleHQpOiBzdHJpbmcge1xuXHRcdGlmIChjb250ZXh0LnN0cmVhbUtleSAmJiBjb250ZXh0LnN0cmVhbUtleS50cmltKCkubGVuZ3RoID4gMCkgcmV0dXJuIGNvbnRleHQuc3RyZWFtS2V5O1xuXHRcdGlmIChjb250ZXh0LnNvdXJjZSAhPT0gXCJ0b29sXCIpIHJldHVybiBjb250ZXh0LnNvdXJjZTtcblx0XHRjb25zdCB0b29sTmFtZSA9IGNvbnRleHQudG9vbE5hbWU/LnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuXHRcdHJldHVybiB0b29sTmFtZSA/IGB0b29sOiR7dG9vbE5hbWV9YCA6IFwidG9vbFwiO1xuXHR9XG5cblx0I25vcm1hbGl6ZVBhdGgocGF0aFZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdHJldHVybiBwYXRoVmFsdWUucmVwbGFjZUFsbChcIlxcXFxcIiwgXCIvXCIpO1xuXHR9XG5cblx0I21hdGNoZXNHbG9iKG1hdGNoZXI6IFBpY29tYXRjaE1hdGNoZXIsIGZpbGVQYXRoczogc3RyaW5nW10gfCB1bmRlZmluZWQpOiBib29sZWFuIHtcblx0XHRpZiAoIWZpbGVQYXRocyB8fCBmaWxlUGF0aHMubGVuZ3RoID09PSAwKSByZXR1cm4gZmFsc2U7XG5cdFx0Zm9yIChjb25zdCBmaWxlUGF0aCBvZiBmaWxlUGF0aHMpIHtcblx0XHRcdGNvbnN0IG5vcm1hbGl6ZWQgPSB0aGlzLiNub3JtYWxpemVQYXRoKGZpbGVQYXRoKTtcblx0XHRcdGlmIChtYXRjaGVyKG5vcm1hbGl6ZWQpKSByZXR1cm4gdHJ1ZTtcblx0XHRcdGNvbnN0IHNsYXNoSW5kZXggPSBub3JtYWxpemVkLmxhc3RJbmRleE9mKFwiL1wiKTtcblx0XHRcdGNvbnN0IGJhc2VuYW1lID0gc2xhc2hJbmRleCA9PT0gLTEgPyBub3JtYWxpemVkIDogbm9ybWFsaXplZC5zbGljZShzbGFzaEluZGV4ICsgMSk7XG5cdFx0XHRpZiAoYmFzZW5hbWUgIT09IG5vcm1hbGl6ZWQgJiYgbWF0Y2hlcihiYXNlbmFtZSkpIHJldHVybiB0cnVlO1xuXHRcdH1cblx0XHRyZXR1cm4gZmFsc2U7XG5cdH1cblxuXHQjbWF0Y2hlc0dsb2JhbFBhdGhzKGVudHJ5OiBUdHNyRW50cnksIGNvbnRleHQ6IFR0c3JNYXRjaENvbnRleHQpOiBib29sZWFuIHtcblx0XHRpZiAoIWVudHJ5Lmdsb2JhbFBhdGhNYXRjaGVycyB8fCBlbnRyeS5nbG9iYWxQYXRoTWF0Y2hlcnMubGVuZ3RoID09PSAwKSByZXR1cm4gdHJ1ZTtcblx0XHRmb3IgKGNvbnN0IG1hdGNoZXIgb2YgZW50cnkuZ2xvYmFsUGF0aE1hdGNoZXJzKSB7XG5cdFx0XHRpZiAodGhpcy4jbWF0Y2hlc0dsb2IobWF0Y2hlciwgY29udGV4dC5maWxlUGF0aHMpKSByZXR1cm4gdHJ1ZTtcblx0XHR9XG5cdFx0cmV0dXJuIGZhbHNlO1xuXHR9XG5cblx0I21hdGNoZXNTY29wZShlbnRyeTogVHRzckVudHJ5LCBjb250ZXh0OiBUdHNyTWF0Y2hDb250ZXh0KTogYm9vbGVhbiB7XG5cdFx0aWYgKGNvbnRleHQuc291cmNlID09PSBcInRleHRcIikgcmV0dXJuIGVudHJ5LnNjb3BlLmFsbG93VGV4dDtcblx0XHRpZiAoY29udGV4dC5zb3VyY2UgPT09IFwidGhpbmtpbmdcIikgcmV0dXJuIGVudHJ5LnNjb3BlLmFsbG93VGhpbmtpbmc7XG5cdFx0aWYgKGVudHJ5LnNjb3BlLmFsbG93QW55VG9vbCkgcmV0dXJuIHRydWU7XG5cblx0XHRjb25zdCB0b29sTmFtZSA9IGNvbnRleHQudG9vbE5hbWU/LnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuXHRcdGZvciAoY29uc3QgdG9vbFNjb3BlIG9mIGVudHJ5LnNjb3BlLnRvb2xTY29wZXMpIHtcblx0XHRcdGlmICh0b29sU2NvcGUudG9vbE5hbWUgJiYgdG9vbFNjb3BlLnRvb2xOYW1lICE9PSB0b29sTmFtZSkgY29udGludWU7XG5cdFx0XHRpZiAodG9vbFNjb3BlLnBhdGhNYXRjaGVyICYmICF0aGlzLiNtYXRjaGVzR2xvYih0b29sU2NvcGUucGF0aE1hdGNoZXIsIGNvbnRleHQuZmlsZVBhdGhzKSkgY29udGludWU7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9XG5cdFx0cmV0dXJuIGZhbHNlO1xuXHR9XG5cblx0I21hdGNoZXNDb25kaXRpb24oZW50cnk6IFR0c3JFbnRyeSwgc3RyZWFtQnVmZmVyOiBzdHJpbmcpOiBib29sZWFuIHtcblx0XHRmb3IgKGNvbnN0IGNvbmRpdGlvbiBvZiBlbnRyeS5jb25kaXRpb25zKSB7XG5cdFx0XHRjb25kaXRpb24ubGFzdEluZGV4ID0gMDtcblx0XHRcdGlmIChjb25kaXRpb24udGVzdChzdHJlYW1CdWZmZXIpKSByZXR1cm4gdHJ1ZTtcblx0XHR9XG5cdFx0cmV0dXJuIGZhbHNlO1xuXHR9XG5cblx0LyoqIENvbXBpbGUgKG9yIHJlY29tcGlsZSkgdGhlIG5hdGl2ZSBSZWdleFNldCBmcm9tIGFsbCBjdXJyZW50IHJ1bGVzLiAqL1xuXHQjY29tcGlsZU5hdGl2ZSgpOiB2b2lkIHtcblx0XHRpZiAoIW5hdGl2ZVR0c3IgfHwgIXRoaXMuI25hdGl2ZURpcnR5KSByZXR1cm47XG5cblx0XHQvLyBGcmVlIHByZXZpb3VzIGhhbmRsZSBpZiBhbnkuXG5cdFx0aWYgKHRoaXMuI25hdGl2ZUhhbmRsZSAhPT0gbnVsbCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0bmF0aXZlVHRzci50dHNyRnJlZVJ1bGVzKHRoaXMuI25hdGl2ZUhhbmRsZSk7XG5cdFx0XHR9IGNhdGNoIHsgLyogaWdub3JlICovIH1cblx0XHRcdHRoaXMuI25hdGl2ZUhhbmRsZSA9IG51bGw7XG5cdFx0fVxuXG5cdFx0Y29uc3QgcnVsZUlucHV0czogeyBuYW1lOiBzdHJpbmc7IGNvbmRpdGlvbnM6IHN0cmluZ1tdIH1bXSA9IFtdO1xuXHRcdGZvciAoY29uc3QgWywgZW50cnldIG9mIHRoaXMuI3J1bGVzKSB7XG5cdFx0XHRydWxlSW5wdXRzLnB1c2goe1xuXHRcdFx0XHRuYW1lOiBlbnRyeS5ydWxlLm5hbWUsXG5cdFx0XHRcdGNvbmRpdGlvbnM6IGVudHJ5LnJ1bGUuY29uZGl0aW9uLFxuXHRcdFx0fSk7XG5cdFx0fVxuXG5cdFx0aWYgKHJ1bGVJbnB1dHMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHR0aGlzLiNuYXRpdmVEaXJ0eSA9IGZhbHNlO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdHRyeSB7XG5cdFx0XHR0aGlzLiNuYXRpdmVIYW5kbGUgPSBuYXRpdmVUdHNyLnR0c3JDb21waWxlUnVsZXMocnVsZUlucHV0cyk7XG5cdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFt0dHNyXSBOYXRpdmUgY29tcGlsYXRpb24gZmFpbGVkLCB1c2luZyBKUyBmYWxsYmFjazogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuXHRcdFx0dGhpcy4jbmF0aXZlSGFuZGxlID0gbnVsbDtcblx0XHR9XG5cdFx0dGhpcy4jbmF0aXZlRGlydHkgPSBmYWxzZTtcblx0fVxuXG5cdC8qKiBBZGQgYSBUVFNSIHJ1bGUgdG8gYmUgbW9uaXRvcmVkLiAqL1xuXHRhZGRSdWxlKHJ1bGU6IFJ1bGUpOiBib29sZWFuIHtcblx0XHRpZiAodGhpcy4jcnVsZXMuaGFzKHJ1bGUubmFtZSkpIHJldHVybiBmYWxzZTtcblxuXHRcdGNvbnN0IGNvbmRpdGlvbnMgPSB0aGlzLiNjb21waWxlQ29uZGl0aW9ucyhydWxlKTtcblx0XHRpZiAoY29uZGl0aW9ucy5sZW5ndGggPT09IDApIHJldHVybiBmYWxzZTtcblxuXHRcdGNvbnN0IHNjb3BlID0gdGhpcy4jYnVpbGRTY29wZShydWxlKTtcblx0XHRpZiAoIXRoaXMuI2hhc1JlYWNoYWJsZVNjb3BlKHNjb3BlKSkgcmV0dXJuIGZhbHNlO1xuXG5cdFx0Y29uc3QgZ2xvYmFsUGF0aE1hdGNoZXJzID0gdGhpcy4jY29tcGlsZUdsb2JhbFBhdGhNYXRjaGVycyhydWxlLmdsb2JzKTtcblx0XHR0aGlzLiNydWxlcy5zZXQocnVsZS5uYW1lLCB7IHJ1bGUsIGNvbmRpdGlvbnMsIHNjb3BlLCBnbG9iYWxQYXRoTWF0Y2hlcnMgfSk7XG5cdFx0dGhpcy4jbmF0aXZlRGlydHkgPSB0cnVlO1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cblx0LyoqXG5cdCAqIEFkZCBhIHN0cmVhbSBjaHVuayB0byBpdHMgc2NvcGVkIGJ1ZmZlciBhbmQgcmV0dXJuIG1hdGNoaW5nIHJ1bGVzLlxuXHQgKlxuXHQgKiBCdWZmZXJzIGFyZSBpc29sYXRlZCBieSBzb3VyY2UvdG9vbCBrZXkgc28gbWF0Y2hlcyBkb24ndCBibGVlZCBhY3Jvc3Ncblx0ICogYXNzaXN0YW50IHByb3NlLCB0aGlua2luZyB0ZXh0LCBhbmQgdW5yZWxhdGVkIHRvb2wgYXJndW1lbnQgc3RyZWFtcy5cblx0ICpcblx0ICogV2hlbiB0aGUgbmF0aXZlIFJ1c3QgZW5naW5lIGlzIGF2YWlsYWJsZSwgYWxsIHJlZ2V4IGNvbmRpdGlvbnMgYXJlIHRlc3RlZFxuXHQgKiBpbiBhIHNpbmdsZSBERkEgcGFzcyB2aWEgUmVnZXhTZXQuIFNjb3BlLCBnbG9iLCBhbmQgcmVwZWF0LWdhdGUgY2hlY2tzXG5cdCAqIHJlbWFpbiBpbiBKUyBhcyB0aGV5IGFyZSBsaWdodHdlaWdodCBhbmQgY29udGV4dC1kZXBlbmRlbnQuXG5cdCAqL1xuXHRjaGVja0RlbHRhKGRlbHRhOiBzdHJpbmcsIGNvbnRleHQ6IFR0c3JNYXRjaENvbnRleHQpOiBSdWxlW10ge1xuXHRcdGNvbnN0IHN0b3BUaW1lciA9IGRlYnVnVGltZShcInR0c3ItY2hlY2tcIik7XG5cdFx0Y29uc3QgYnVmZmVyS2V5ID0gdGhpcy4jYnVmZmVyS2V5KGNvbnRleHQpO1xuXHRcdGxldCBuZXh0QnVmZmVyID0gYCR7dGhpcy4jYnVmZmVycy5nZXQoYnVmZmVyS2V5KSA/PyBcIlwifSR7ZGVsdGF9YDtcblx0XHQvLyBDYXAgYnVmZmVyIHNpemUgXHUyMDE0IGtlZXAgdGhlIHRhaWwgc28gcGF0dGVybnMgc3RpbGwgbWF0Y2ggcmVjZW50IG91dHB1dFxuXHRcdGlmIChuZXh0QnVmZmVyLmxlbmd0aCA+IE1BWF9CVUZGRVJfQllURVMpIHtcblx0XHRcdG5leHRCdWZmZXIgPSBuZXh0QnVmZmVyLnNsaWNlKC1NQVhfQlVGRkVSX0JZVEVTKTtcblx0XHR9XG5cdFx0dGhpcy4jYnVmZmVycy5zZXQoYnVmZmVyS2V5LCBuZXh0QnVmZmVyKTtcblx0XHRkZWJ1Z1BlYWsoXCJ0dHNyUGVha0J1ZmZlclwiLCBuZXh0QnVmZmVyLmxlbmd0aCk7XG5cblx0XHQvLyBMYXppbHkgY29tcGlsZSBuYXRpdmUgZW5naW5lIGlmIHJ1bGVzIGNoYW5nZWQuXG5cdFx0aWYgKHRoaXMuI25hdGl2ZURpcnR5KSB0aGlzLiNjb21waWxlTmF0aXZlKCk7XG5cblx0XHQvLyBcdTI1MDBcdTI1MDAgTmF0aXZlIHBhdGg6IHNpbmdsZS1wYXNzIFJlZ2V4U2V0IG1hdGNoIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXHRcdGlmIChuYXRpdmVUdHNyICYmIHRoaXMuI25hdGl2ZUhhbmRsZSAhPT0gbnVsbCkge1xuXHRcdFx0Y29uc3QgcmVnZXhNYXRjaGVkTmFtZXMgPSBuYXRpdmVUdHNyLnR0c3JDaGVja0J1ZmZlcih0aGlzLiNuYXRpdmVIYW5kbGUsIG5leHRCdWZmZXIpO1xuXHRcdFx0Y29uc3QgcmVnZXhNYXRjaGVkU2V0ID0gbmV3IFNldChyZWdleE1hdGNoZWROYW1lcyk7XG5cblx0XHRcdGNvbnN0IG1hdGNoZXM6IFJ1bGVbXSA9IFtdO1xuXHRcdFx0Zm9yIChjb25zdCBbbmFtZSwgZW50cnldIG9mIHRoaXMuI3J1bGVzKSB7XG5cdFx0XHRcdGlmICghcmVnZXhNYXRjaGVkU2V0LmhhcyhuYW1lKSkgY29udGludWU7XG5cdFx0XHRcdGlmICghdGhpcy4jY2FuVHJpZ2dlcihuYW1lKSkgY29udGludWU7XG5cdFx0XHRcdGlmICghdGhpcy4jbWF0Y2hlc1Njb3BlKGVudHJ5LCBjb250ZXh0KSkgY29udGludWU7XG5cdFx0XHRcdGlmICghdGhpcy4jbWF0Y2hlc0dsb2JhbFBhdGhzKGVudHJ5LCBjb250ZXh0KSkgY29udGludWU7XG5cdFx0XHRcdG1hdGNoZXMucHVzaChlbnRyeS5ydWxlKTtcblx0XHRcdH1cblx0XHRcdGRlYnVnQ291bnQoXCJ0dHNyQ2hlY2tzXCIpO1xuXHRcdFx0c3RvcFRpbWVyKHsgYnVmZmVyU2l6ZTogbmV4dEJ1ZmZlci5sZW5ndGgsIG5hdGl2ZTogdHJ1ZSwgcnVsZXNDaGVja2VkOiB0aGlzLiNydWxlcy5zaXplLCBtYXRjaGVkOiBtYXRjaGVzLm1hcChtID0+IG0ubmFtZSkgfSk7XG5cdFx0XHRyZXR1cm4gbWF0Y2hlcztcblx0XHR9XG5cblx0XHQvLyBcdTI1MDBcdTI1MDAgSlMgZmFsbGJhY2s6IHBlci1ydWxlIHJlZ2V4IGl0ZXJhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblx0XHQvLyBUaHJvdHRsZSBKUyByZWdleCBjaGVja3MgdG8gcHJldmVudCBDUFUgc3Bpbm5pbmcgb24gZmFzdCB0b2tlblxuXHRcdC8vIHN0cmVhbXMgXHUyMDE0IHJlZ2V4IG9uIGEgZ3Jvd2luZyBidWZmZXIgaXMgTyhydWxlcyBcdTAwRDcgYnVmZmVyX3NpemUpICgjNDY4KS5cblx0XHRjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuXHRcdGNvbnN0IGxhc3RDaGVjayA9IHRoaXMuI2xhc3RKc0NoZWNrQXQuZ2V0KGJ1ZmZlcktleSkgPz8gMDtcblx0XHRpZiAobm93IC0gbGFzdENoZWNrIDwgSlNfRkFMTEJBQ0tfQ0hFQ0tfSU5URVJWQUxfTVMpIHtcblx0XHRcdHN0b3BUaW1lcih7IGJ1ZmZlclNpemU6IG5leHRCdWZmZXIubGVuZ3RoLCB0aHJvdHRsZWQ6IHRydWUgfSk7XG5cdFx0XHRyZXR1cm4gW107XG5cdFx0fVxuXHRcdHRoaXMuI2xhc3RKc0NoZWNrQXQuc2V0KGJ1ZmZlcktleSwgbm93KTtcblxuXHRcdGNvbnN0IG1hdGNoZXM6IFJ1bGVbXSA9IFtdO1xuXHRcdGZvciAoY29uc3QgW25hbWUsIGVudHJ5XSBvZiB0aGlzLiNydWxlcykge1xuXHRcdFx0aWYgKCF0aGlzLiNjYW5UcmlnZ2VyKG5hbWUpKSBjb250aW51ZTtcblx0XHRcdGlmICghdGhpcy4jbWF0Y2hlc1Njb3BlKGVudHJ5LCBjb250ZXh0KSkgY29udGludWU7XG5cdFx0XHRpZiAoIXRoaXMuI21hdGNoZXNHbG9iYWxQYXRocyhlbnRyeSwgY29udGV4dCkpIGNvbnRpbnVlO1xuXHRcdFx0aWYgKCF0aGlzLiNtYXRjaGVzQ29uZGl0aW9uKGVudHJ5LCBuZXh0QnVmZmVyKSkgY29udGludWU7XG5cdFx0XHRtYXRjaGVzLnB1c2goZW50cnkucnVsZSk7XG5cdFx0fVxuXHRcdGRlYnVnQ291bnQoXCJ0dHNyQ2hlY2tzXCIpO1xuXHRcdHN0b3BUaW1lcih7IGJ1ZmZlclNpemU6IG5leHRCdWZmZXIubGVuZ3RoLCBuYXRpdmU6IGZhbHNlLCBydWxlc0NoZWNrZWQ6IHRoaXMuI3J1bGVzLnNpemUsIG1hdGNoZWQ6IG1hdGNoZXMubWFwKG0gPT4gbS5uYW1lKSB9KTtcblx0XHRyZXR1cm4gbWF0Y2hlcztcblx0fVxuXG5cdC8qKiBNYXJrIHJ1bGVzIGFzIGluamVjdGVkICh3b24ndCB0cmlnZ2VyIGFnYWluIHVudGlsIGNvbmRpdGlvbnMgYWxsb3cpLiAqL1xuXHRtYXJrSW5qZWN0ZWQocnVsZXNUb01hcms6IFJ1bGVbXSk6IHZvaWQge1xuXHRcdHRoaXMubWFya0luamVjdGVkQnlOYW1lcyhydWxlc1RvTWFyay5tYXAoKHIpID0+IHIubmFtZSkpO1xuXHR9XG5cblx0LyoqIE1hcmsgcnVsZSBuYW1lcyBhcyBpbmplY3RlZC4gKi9cblx0bWFya0luamVjdGVkQnlOYW1lcyhydWxlTmFtZXM6IHN0cmluZ1tdKTogdm9pZCB7XG5cdFx0Zm9yIChjb25zdCByYXdOYW1lIG9mIHJ1bGVOYW1lcykge1xuXHRcdFx0Y29uc3QgcnVsZU5hbWUgPSByYXdOYW1lLnRyaW0oKTtcblx0XHRcdGlmIChydWxlTmFtZS5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuXHRcdFx0Y29uc3QgcmVjb3JkID0gdGhpcy4jaW5qZWN0aW9uUmVjb3Jkcy5nZXQocnVsZU5hbWUpO1xuXHRcdFx0aWYgKCFyZWNvcmQpIHtcblx0XHRcdFx0dGhpcy4jaW5qZWN0aW9uUmVjb3Jkcy5zZXQocnVsZU5hbWUsIHsgbGFzdEluamVjdGVkQXQ6IHRoaXMuI21lc3NhZ2VDb3VudCB9KTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHJlY29yZC5sYXN0SW5qZWN0ZWRBdCA9IHRoaXMuI21lc3NhZ2VDb3VudDtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHQvKiogR2V0IG5hbWVzIG9mIGFsbCBpbmplY3RlZCBydWxlcyAoZm9yIHBlcnNpc3RlbmNlKS4gKi9cblx0Z2V0SW5qZWN0ZWRSdWxlTmFtZXMoKTogc3RyaW5nW10ge1xuXHRcdHJldHVybiBBcnJheS5mcm9tKHRoaXMuI2luamVjdGlvblJlY29yZHMua2V5cygpKTtcblx0fVxuXG5cdC8qKiBSZXN0b3JlIGluamVjdGVkIHN0YXRlIGZyb20gYSBsaXN0IG9mIHJ1bGUgbmFtZXMuICovXG5cdHJlc3RvcmVJbmplY3RlZChydWxlTmFtZXM6IHN0cmluZ1tdKTogdm9pZCB7XG5cdFx0Zm9yIChjb25zdCBuYW1lIG9mIHJ1bGVOYW1lcykge1xuXHRcdFx0dGhpcy4jaW5qZWN0aW9uUmVjb3Jkcy5zZXQobmFtZSwgeyBsYXN0SW5qZWN0ZWRBdDogMCB9KTtcblx0XHR9XG5cdH1cblxuXHQvKiogUmVzZXQgc3RyZWFtIGJ1ZmZlcnMgKGNhbGxlZCBvbiBuZXcgdHVybikuICovXG5cdHJlc2V0QnVmZmVyKCk6IHZvaWQge1xuXHRcdHRoaXMuI2J1ZmZlcnMuY2xlYXIoKTtcblx0XHR0aGlzLiNsYXN0SnNDaGVja0F0LmNsZWFyKCk7XG5cdH1cblxuXHQvKiogQ2hlY2sgaWYgYW55IFRUU1IgcnVsZXMgYXJlIHJlZ2lzdGVyZWQuICovXG5cdGhhc1J1bGVzKCk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLiNydWxlcy5zaXplID4gMDtcblx0fVxuXG5cdC8qKiBJbmNyZW1lbnQgbWVzc2FnZSBjb3VudGVyIChjYWxsIGFmdGVyIGVhY2ggdHVybikuICovXG5cdGluY3JlbWVudE1lc3NhZ2VDb3VudCgpOiB2b2lkIHtcblx0XHR0aGlzLiNtZXNzYWdlQ291bnQrKztcblx0fVxuXG5cdC8qKiBHZXQgY3VycmVudCBtZXNzYWdlIGNvdW50LiAqL1xuXHRnZXRNZXNzYWdlQ291bnQoKTogbnVtYmVyIHtcblx0XHRyZXR1cm4gdGhpcy4jbWVzc2FnZUNvdW50O1xuXHR9XG5cblx0LyoqIEdldCBzZXR0aW5ncy4gKi9cblx0Z2V0U2V0dGluZ3MoKTogUmVxdWlyZWQ8VHRzclNldHRpbmdzPiB7XG5cdFx0cmV0dXJuIHRoaXMuI3NldHRpbmdzO1xuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFXQSxTQUFTLHFCQUFxQjtBQUM5QixTQUFTLFdBQVcsWUFBWSxpQkFBaUI7QUFFakQsTUFBTSxXQUFXLGNBQWMsWUFBWSxHQUFHO0FBRzlDLE1BQU0sWUFBWSxTQUFTLFdBQVc7QUFHdEMsSUFBSSxhQUlPO0FBRVgsSUFBSTtBQUVILFFBQU0sU0FBUyxNQUFNLE9BQU8sYUFBYTtBQUN6QyxNQUFJLE9BQU8sb0JBQW9CLE9BQU8sbUJBQW1CLE9BQU8sZUFBZTtBQUM5RSxpQkFBYTtBQUFBLE1BQ1osa0JBQWtCLE9BQU87QUFBQSxNQUN6QixpQkFBaUIsT0FBTztBQUFBLE1BQ3hCLGVBQWUsT0FBTztBQUFBLElBQ3ZCO0FBQUEsRUFDRDtBQUNELFFBQVE7QUFFUjtBQXlEQSxNQUFNLG1CQUEyQztBQUFBLEVBQ2hELFNBQVM7QUFBQSxFQUNULGFBQWE7QUFBQSxFQUNiLGVBQWU7QUFBQSxFQUNmLFlBQVk7QUFBQSxFQUNaLFdBQVc7QUFDWjtBQUdBLE1BQU0sbUJBQW1CLE1BQU07QUFNL0IsTUFBTSxnQ0FBZ0M7QUFFdEMsTUFBTSxnQkFBMkI7QUFBQSxFQUNoQyxXQUFXO0FBQUEsRUFDWCxlQUFlO0FBQUEsRUFDZixjQUFjO0FBQUEsRUFDZCxZQUFZLENBQUM7QUFDZDtBQUVPLE1BQU0sWUFBWTtBQUFBLEVBQ2Y7QUFBQSxFQUNBLFNBQVMsb0JBQUksSUFBdUI7QUFBQSxFQUNwQyxvQkFBb0Isb0JBQUksSUFBNkI7QUFBQSxFQUNyRCxXQUFXLG9CQUFJLElBQW9CO0FBQUE7QUFBQSxFQUVuQyxpQkFBaUIsb0JBQUksSUFBb0I7QUFBQSxFQUNsRCxnQkFBZ0I7QUFBQSxFQUNoQixnQkFBK0I7QUFBQSxFQUMvQixlQUFlO0FBQUEsRUFFZixZQUFZLFVBQXlCO0FBQ3BDLFNBQUss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
