import { readFileSync } from "node:fs";
import { serializeJsonLine } from "@gsd/pi-coding-agent";
function loadAndValidateAnswerFile(path) {
  const raw = readFileSync(path, "utf-8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in answer file: ${path}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Answer file must be a JSON object");
  }
  const obj = parsed;
  if (obj.questions !== void 0) {
    if (typeof obj.questions !== "object" || obj.questions === null || Array.isArray(obj.questions)) {
      throw new Error('Answer file "questions" must be an object');
    }
    const questions = obj.questions;
    for (const [key, value] of Object.entries(questions)) {
      if (typeof value === "string") continue;
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) continue;
      throw new Error(`Answer file "questions.${key}" must be a string or string[]`);
    }
  }
  if (obj.secrets !== void 0) {
    if (typeof obj.secrets !== "object" || obj.secrets === null || Array.isArray(obj.secrets)) {
      throw new Error('Answer file "secrets" must be an object');
    }
    const secrets = obj.secrets;
    for (const [key, value] of Object.entries(secrets)) {
      if (typeof value !== "string") {
        throw new Error(`Answer file "secrets.${key}" must be a string`);
      }
    }
  }
  if (obj.defaults !== void 0) {
    if (typeof obj.defaults !== "object" || obj.defaults === null || Array.isArray(obj.defaults)) {
      throw new Error('Answer file "defaults" must be an object');
    }
    const defaults = obj.defaults;
    if (defaults.strategy !== void 0) {
      if (defaults.strategy !== "first_option" && defaults.strategy !== "cancel") {
        throw new Error('Answer file "defaults.strategy" must be "first_option" or "cancel"');
      }
    }
  }
  return obj;
}
class AnswerInjector {
  answerFile;
  questionMetaByTitle = /* @__PURE__ */ new Map();
  deferredEvents = /* @__PURE__ */ new Map();
  usedQuestionIds = /* @__PURE__ */ new Set();
  usedSecretKeys = /* @__PURE__ */ new Set();
  stats = {
    questionsAnswered: 0,
    questionsDefaulted: 0,
    secretsProvided: 0
  };
  constructor(answerFile) {
    this.answerFile = answerFile;
  }
  /**
   * Observe every event for question metadata (tool_execution_start of ask_user_questions).
   */
  observeEvent(event) {
    if (event.type !== "tool_execution_start" || event.toolName !== "ask_user_questions") return;
    const input = event.input ?? event.args;
    const questions = input?.questions;
    if (!Array.isArray(questions)) return;
    for (const q of questions) {
      const header = String(q.header ?? "");
      const question = String(q.question ?? "");
      const title = `${header}: ${question}`;
      const options = Array.isArray(q.options) ? q.options.map((o) => String(o.label ?? "")) : [];
      this.questionMetaByTitle.set(title, {
        id: String(q.id ?? ""),
        header,
        question,
        options,
        allowMultiple: !!q.allowMultiple
      });
    }
    for (const [title, deferred] of Array.from(this.deferredEvents)) {
      if (this.questionMetaByTitle.has(title)) {
        clearTimeout(deferred.timer);
        this.deferredEvents.delete(title);
        this.processWithMeta(deferred.event, deferred.writeToStdin);
      }
    }
  }
  /**
   * Try to handle an extension_ui_request with pre-supplied answers.
   * Returns true if the event was handled (or deferred for async handling).
   */
  tryHandle(event, writeToStdin) {
    const method = String(event.method ?? "");
    if (method !== "select") return false;
    const title = String(event.title ?? "");
    const meta = this.questionMetaByTitle.get(title);
    if (meta) {
      return this.processWithMeta(event, writeToStdin);
    }
    const strategy = this.answerFile.defaults?.strategy ?? "first_option";
    const timer = setTimeout(() => {
      this.deferredEvents.delete(title);
      this.stats.questionsDefaulted++;
      if (strategy === "cancel") {
        const response = { type: "extension_ui_response", id: event.id, cancelled: true };
        writeToStdin(serializeJsonLine(response));
      } else {
        const options = event.options;
        const response = { type: "extension_ui_response", id: event.id, value: options?.[0] ?? "" };
        writeToStdin(serializeJsonLine(response));
      }
    }, 500);
    this.deferredEvents.set(title, { event, writeToStdin, timer });
    return true;
  }
  /**
   * Get secret environment variables to inject into the RPC child process.
   */
  getSecretEnvVars() {
    return this.answerFile.secrets ?? {};
  }
  /**
   * Get a copy of the current stats.
   */
  getStats() {
    return { ...this.stats };
  }
  /**
   * Get warnings for unused question IDs and secret keys.
   */
  getUnusedWarnings() {
    const warnings = [];
    if (this.answerFile.questions) {
      for (const id of Object.keys(this.answerFile.questions)) {
        if (!this.usedQuestionIds.has(id)) {
          warnings.push(`[answers] Warning: question ID '${id}' was never matched`);
        }
      }
    }
    if (this.answerFile.secrets) {
      for (const key of Object.keys(this.answerFile.secrets)) {
        if (!this.usedSecretKeys.has(key)) {
          warnings.push(`[answers] Warning: secret '${key}' was provided but never requested`);
        }
      }
    }
    return warnings;
  }
  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------
  processWithMeta(event, writeToStdin) {
    const title = String(event.title ?? "");
    const meta = this.questionMetaByTitle.get(title);
    if (!meta) return false;
    const answer = this.answerFile.questions?.[meta.id];
    const eventOptions = event.options;
    if (answer !== void 0) {
      if (meta.allowMultiple) {
        const values = Array.isArray(answer) ? answer : [answer];
        const valid = values.every((v) => eventOptions?.includes(v));
        if (valid) {
          const response = { type: "extension_ui_response", id: event.id, values };
          writeToStdin(serializeJsonLine(response));
          this.usedQuestionIds.add(meta.id);
          this.stats.questionsAnswered++;
          return true;
        }
      } else {
        const value = Array.isArray(answer) ? answer[0] : answer;
        if (eventOptions?.includes(value)) {
          const response = { type: "extension_ui_response", id: event.id, value };
          writeToStdin(serializeJsonLine(response));
          this.usedQuestionIds.add(meta.id);
          this.stats.questionsAnswered++;
          return true;
        }
      }
    }
    const strategy = this.answerFile.defaults?.strategy ?? "first_option";
    this.stats.questionsDefaulted++;
    if (strategy === "cancel") {
      const response = { type: "extension_ui_response", id: event.id, cancelled: true };
      writeToStdin(serializeJsonLine(response));
      return true;
    }
    return false;
  }
}
export {
  AnswerInjector,
  loadAndValidateAnswerFile
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2hlYWRsZXNzLWFuc3dlcnMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogQW5zd2VyIEluamVjdG9yIFx1MjAxNCBwcmUtc3VwcGx5IGFuc3dlcnMgdG8gaGVhZGxlc3MgbW9kZSBxdWVzdGlvbnMuXG4gKlxuICogTG9hZHMgYSBKU09OIGFuc3dlciBmaWxlIGFuZCBpbnRlcmNlcHRzIGV4dGVuc2lvbl91aV9yZXF1ZXN0IGV2ZW50c1xuICogdG8gYXV0b21hdGljYWxseSByZXNwb25kIHdpdGggcHJlLWNvbmZpZ3VyZWQgYW5zd2VycywgYnlwYXNzaW5nIHRoZVxuICogZGVmYXVsdCBhdXRvLXJlc3BvbmRlciBvciBzdXBlcnZpc2VkIG1vZGUuXG4gKi9cblxuaW1wb3J0IHsgcmVhZEZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcydcbmltcG9ydCB7IHNlcmlhbGl6ZUpzb25MaW5lIH0gZnJvbSAnQGdzZC9waS1jb2RpbmctYWdlbnQnXG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVHlwZXNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgaW50ZXJmYWNlIEFuc3dlckZpbGUge1xuICBxdWVzdGlvbnM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBzdHJpbmdbXT5cbiAgc2VjcmV0cz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz5cbiAgZGVmYXVsdHM/OiB7IHN0cmF0ZWd5PzogJ2ZpcnN0X29wdGlvbicgfCAnY2FuY2VsJyB9XG59XG5cbmludGVyZmFjZSBRdWVzdGlvbk1ldGEge1xuICBpZDogc3RyaW5nXG4gIGhlYWRlcjogc3RyaW5nXG4gIHF1ZXN0aW9uOiBzdHJpbmdcbiAgb3B0aW9uczogc3RyaW5nW11cbiAgYWxsb3dNdWx0aXBsZT86IGJvb2xlYW5cbn1cblxuZXhwb3J0IGludGVyZmFjZSBBbnN3ZXJJbmplY3RvclN0YXRzIHtcbiAgcXVlc3Rpb25zQW5zd2VyZWQ6IG51bWJlclxuICBxdWVzdGlvbnNEZWZhdWx0ZWQ6IG51bWJlclxuICBzZWNyZXRzUHJvdmlkZWQ6IG51bWJlclxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEFuc3dlciBGaWxlIExvYWRlclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBmdW5jdGlvbiBsb2FkQW5kVmFsaWRhdGVBbnN3ZXJGaWxlKHBhdGg6IHN0cmluZyk6IEFuc3dlckZpbGUge1xuICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMocGF0aCwgJ3V0Zi04JylcbiAgbGV0IHBhcnNlZDogdW5rbm93blxuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KVxuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgSlNPTiBpbiBhbnN3ZXIgZmlsZTogJHtwYXRofWApXG4gIH1cblxuICBpZiAodHlwZW9mIHBhcnNlZCAhPT0gJ29iamVjdCcgfHwgcGFyc2VkID09PSBudWxsIHx8IEFycmF5LmlzQXJyYXkocGFyc2VkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcignQW5zd2VyIGZpbGUgbXVzdCBiZSBhIEpTT04gb2JqZWN0JylcbiAgfVxuXG4gIGNvbnN0IG9iaiA9IHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPlxuXG4gIGlmIChvYmoucXVlc3Rpb25zICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAodHlwZW9mIG9iai5xdWVzdGlvbnMgIT09ICdvYmplY3QnIHx8IG9iai5xdWVzdGlvbnMgPT09IG51bGwgfHwgQXJyYXkuaXNBcnJheShvYmoucXVlc3Rpb25zKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdBbnN3ZXIgZmlsZSBcInF1ZXN0aW9uc1wiIG11c3QgYmUgYW4gb2JqZWN0JylcbiAgICB9XG4gICAgY29uc3QgcXVlc3Rpb25zID0gb2JqLnF1ZXN0aW9ucyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPlxuICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHF1ZXN0aW9ucykpIHtcbiAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSBjb250aW51ZVxuICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpICYmIHZhbHVlLmV2ZXJ5KCh2KSA9PiB0eXBlb2YgdiA9PT0gJ3N0cmluZycpKSBjb250aW51ZVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBbnN3ZXIgZmlsZSBcInF1ZXN0aW9ucy4ke2tleX1cIiBtdXN0IGJlIGEgc3RyaW5nIG9yIHN0cmluZ1tdYClcbiAgICB9XG4gIH1cblxuICBpZiAob2JqLnNlY3JldHMgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICh0eXBlb2Ygb2JqLnNlY3JldHMgIT09ICdvYmplY3QnIHx8IG9iai5zZWNyZXRzID09PSBudWxsIHx8IEFycmF5LmlzQXJyYXkob2JqLnNlY3JldHMpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Fuc3dlciBmaWxlIFwic2VjcmV0c1wiIG11c3QgYmUgYW4gb2JqZWN0JylcbiAgICB9XG4gICAgY29uc3Qgc2VjcmV0cyA9IG9iai5zZWNyZXRzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+XG4gICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoc2VjcmV0cykpIHtcbiAgICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgQW5zd2VyIGZpbGUgXCJzZWNyZXRzLiR7a2V5fVwiIG11c3QgYmUgYSBzdHJpbmdgKVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGlmIChvYmouZGVmYXVsdHMgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICh0eXBlb2Ygb2JqLmRlZmF1bHRzICE9PSAnb2JqZWN0JyB8fCBvYmouZGVmYXVsdHMgPT09IG51bGwgfHwgQXJyYXkuaXNBcnJheShvYmouZGVmYXVsdHMpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Fuc3dlciBmaWxlIFwiZGVmYXVsdHNcIiBtdXN0IGJlIGFuIG9iamVjdCcpXG4gICAgfVxuICAgIGNvbnN0IGRlZmF1bHRzID0gb2JqLmRlZmF1bHRzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+XG4gICAgaWYgKGRlZmF1bHRzLnN0cmF0ZWd5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChkZWZhdWx0cy5zdHJhdGVneSAhPT0gJ2ZpcnN0X29wdGlvbicgJiYgZGVmYXVsdHMuc3RyYXRlZ3kgIT09ICdjYW5jZWwnKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignQW5zd2VyIGZpbGUgXCJkZWZhdWx0cy5zdHJhdGVneVwiIG11c3QgYmUgXCJmaXJzdF9vcHRpb25cIiBvciBcImNhbmNlbFwiJylcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gb2JqIGFzIHVua25vd24gYXMgQW5zd2VyRmlsZVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEFuc3dlciBJbmplY3RvclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmludGVyZmFjZSBEZWZlcnJlZEV2ZW50IHtcbiAgZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+XG4gIHdyaXRlVG9TdGRpbjogKGRhdGE6IHN0cmluZykgPT4gdm9pZFxuICB0aW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD5cbn1cblxuZXhwb3J0IGNsYXNzIEFuc3dlckluamVjdG9yIHtcbiAgcHJpdmF0ZSByZWFkb25seSBhbnN3ZXJGaWxlOiBBbnN3ZXJGaWxlXG4gIHByaXZhdGUgcmVhZG9ubHkgcXVlc3Rpb25NZXRhQnlUaXRsZSA9IG5ldyBNYXA8c3RyaW5nLCBRdWVzdGlvbk1ldGE+KClcbiAgcHJpdmF0ZSByZWFkb25seSBkZWZlcnJlZEV2ZW50cyA9IG5ldyBNYXA8c3RyaW5nLCBEZWZlcnJlZEV2ZW50PigpXG4gIHByaXZhdGUgcmVhZG9ubHkgdXNlZFF1ZXN0aW9uSWRzID0gbmV3IFNldDxzdHJpbmc+KClcbiAgcHJpdmF0ZSByZWFkb25seSB1c2VkU2VjcmV0S2V5cyA9IG5ldyBTZXQ8c3RyaW5nPigpXG4gIHByaXZhdGUgcmVhZG9ubHkgc3RhdHM6IEFuc3dlckluamVjdG9yU3RhdHMgPSB7XG4gICAgcXVlc3Rpb25zQW5zd2VyZWQ6IDAsXG4gICAgcXVlc3Rpb25zRGVmYXVsdGVkOiAwLFxuICAgIHNlY3JldHNQcm92aWRlZDogMCxcbiAgfVxuXG4gIGNvbnN0cnVjdG9yKGFuc3dlckZpbGU6IEFuc3dlckZpbGUpIHtcbiAgICB0aGlzLmFuc3dlckZpbGUgPSBhbnN3ZXJGaWxlXG4gIH1cblxuICAvKipcbiAgICogT2JzZXJ2ZSBldmVyeSBldmVudCBmb3IgcXVlc3Rpb24gbWV0YWRhdGEgKHRvb2xfZXhlY3V0aW9uX3N0YXJ0IG9mIGFza191c2VyX3F1ZXN0aW9ucykuXG4gICAqL1xuICBvYnNlcnZlRXZlbnQoZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogdm9pZCB7XG4gICAgaWYgKGV2ZW50LnR5cGUgIT09ICd0b29sX2V4ZWN1dGlvbl9zdGFydCcgfHwgZXZlbnQudG9vbE5hbWUgIT09ICdhc2tfdXNlcl9xdWVzdGlvbnMnKSByZXR1cm5cblxuICAgIC8vIEV4dHJhY3QgcXVlc3Rpb25zIGZyb20gZXZlbnQuaW5wdXQucXVlc3Rpb25zIG9yIGV2ZW50LmFyZ3M/LnF1ZXN0aW9uc1xuICAgIGNvbnN0IGlucHV0ID0gKGV2ZW50LmlucHV0ID8/IGV2ZW50LmFyZ3MpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkXG4gICAgY29uc3QgcXVlc3Rpb25zID0gKGlucHV0Py5xdWVzdGlvbnMpIGFzIEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB8IHVuZGVmaW5lZFxuICAgIGlmICghQXJyYXkuaXNBcnJheShxdWVzdGlvbnMpKSByZXR1cm5cblxuICAgIGZvciAoY29uc3QgcSBvZiBxdWVzdGlvbnMpIHtcbiAgICAgIGNvbnN0IGhlYWRlciA9IFN0cmluZyhxLmhlYWRlciA/PyAnJylcbiAgICAgIGNvbnN0IHF1ZXN0aW9uID0gU3RyaW5nKHEucXVlc3Rpb24gPz8gJycpXG4gICAgICBjb25zdCB0aXRsZSA9IGAke2hlYWRlcn06ICR7cXVlc3Rpb259YFxuICAgICAgY29uc3Qgb3B0aW9ucyA9IEFycmF5LmlzQXJyYXkocS5vcHRpb25zKVxuICAgICAgICA/IChxLm9wdGlvbnMgYXMgQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KS5tYXAoKG8pID0+IFN0cmluZyhvLmxhYmVsID8/ICcnKSlcbiAgICAgICAgOiBbXVxuXG4gICAgICB0aGlzLnF1ZXN0aW9uTWV0YUJ5VGl0bGUuc2V0KHRpdGxlLCB7XG4gICAgICAgIGlkOiBTdHJpbmcocS5pZCA/PyAnJyksXG4gICAgICAgIGhlYWRlcixcbiAgICAgICAgcXVlc3Rpb24sXG4gICAgICAgIG9wdGlvbnMsXG4gICAgICAgIGFsbG93TXVsdGlwbGU6ICEhcS5hbGxvd011bHRpcGxlLFxuICAgICAgfSlcbiAgICB9XG5cbiAgICAvLyBQcm9jZXNzIGFueSBkZWZlcnJlZCBldmVudHMgdGhhdCBub3cgaGF2ZSBtZXRhZGF0YVxuICAgIGZvciAoY29uc3QgW3RpdGxlLCBkZWZlcnJlZF0gb2YgQXJyYXkuZnJvbSh0aGlzLmRlZmVycmVkRXZlbnRzKSkge1xuICAgICAgaWYgKHRoaXMucXVlc3Rpb25NZXRhQnlUaXRsZS5oYXModGl0bGUpKSB7XG4gICAgICAgIGNsZWFyVGltZW91dChkZWZlcnJlZC50aW1lcilcbiAgICAgICAgdGhpcy5kZWZlcnJlZEV2ZW50cy5kZWxldGUodGl0bGUpXG4gICAgICAgIHRoaXMucHJvY2Vzc1dpdGhNZXRhKGRlZmVycmVkLmV2ZW50LCBkZWZlcnJlZC53cml0ZVRvU3RkaW4pXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFRyeSB0byBoYW5kbGUgYW4gZXh0ZW5zaW9uX3VpX3JlcXVlc3Qgd2l0aCBwcmUtc3VwcGxpZWQgYW5zd2Vycy5cbiAgICogUmV0dXJucyB0cnVlIGlmIHRoZSBldmVudCB3YXMgaGFuZGxlZCAob3IgZGVmZXJyZWQgZm9yIGFzeW5jIGhhbmRsaW5nKS5cbiAgICovXG4gIHRyeUhhbmRsZShldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIHdyaXRlVG9TdGRpbjogKGRhdGE6IHN0cmluZykgPT4gdm9pZCk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IG1ldGhvZCA9IFN0cmluZyhldmVudC5tZXRob2QgPz8gJycpXG5cbiAgICAvLyBPbmx5IGhhbmRsZSAnc2VsZWN0JyBcdTIwMTQgbGV0IGF1dG8tcmVzcG9uZGVyIGhhbmRsZSBjb25maXJtLCBpbnB1dCwgZXRjLlxuICAgIGlmIChtZXRob2QgIT09ICdzZWxlY3QnKSByZXR1cm4gZmFsc2VcblxuICAgIGNvbnN0IHRpdGxlID0gU3RyaW5nKGV2ZW50LnRpdGxlID8/ICcnKVxuICAgIGNvbnN0IG1ldGEgPSB0aGlzLnF1ZXN0aW9uTWV0YUJ5VGl0bGUuZ2V0KHRpdGxlKVxuXG4gICAgaWYgKG1ldGEpIHtcbiAgICAgIHJldHVybiB0aGlzLnByb2Nlc3NXaXRoTWV0YShldmVudCwgd3JpdGVUb1N0ZGluKVxuICAgIH1cblxuICAgIC8vIE5vIG1ldGFkYXRhIHlldCAob3V0LW9mLW9yZGVyKSBcdTIwMTQgZGVmZXIgYW5kIGhhbmRsZSBhc3luY2hyb25vdXNseVxuICAgIGNvbnN0IHN0cmF0ZWd5ID0gdGhpcy5hbnN3ZXJGaWxlLmRlZmF1bHRzPy5zdHJhdGVneSA/PyAnZmlyc3Rfb3B0aW9uJ1xuICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB0aGlzLmRlZmVycmVkRXZlbnRzLmRlbGV0ZSh0aXRsZSlcbiAgICAgIHRoaXMuc3RhdHMucXVlc3Rpb25zRGVmYXVsdGVkKytcblxuICAgICAgaWYgKHN0cmF0ZWd5ID09PSAnY2FuY2VsJykge1xuICAgICAgICBjb25zdCByZXNwb25zZSA9IHsgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXNwb25zZScsIGlkOiBldmVudC5pZCwgY2FuY2VsbGVkOiB0cnVlIH1cbiAgICAgICAgd3JpdGVUb1N0ZGluKHNlcmlhbGl6ZUpzb25MaW5lKHJlc3BvbnNlKSlcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIGZpcnN0X29wdGlvbiBcdTIwMTQgc2VuZCBmaXJzdCBvcHRpb24gYXMgcmVzcG9uc2VcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IGV2ZW50Lm9wdGlvbnMgYXMgc3RyaW5nW10gfCB1bmRlZmluZWRcbiAgICAgICAgY29uc3QgcmVzcG9uc2UgPSB7IHR5cGU6ICdleHRlbnNpb25fdWlfcmVzcG9uc2UnLCBpZDogZXZlbnQuaWQsIHZhbHVlOiBvcHRpb25zPy5bMF0gPz8gJycgfVxuICAgICAgICB3cml0ZVRvU3RkaW4oc2VyaWFsaXplSnNvbkxpbmUocmVzcG9uc2UpKVxuICAgICAgfVxuICAgIH0sIDUwMClcblxuICAgIHRoaXMuZGVmZXJyZWRFdmVudHMuc2V0KHRpdGxlLCB7IGV2ZW50LCB3cml0ZVRvU3RkaW4sIHRpbWVyIH0pXG4gICAgcmV0dXJuIHRydWVcbiAgfVxuXG4gIC8qKlxuICAgKiBHZXQgc2VjcmV0IGVudmlyb25tZW50IHZhcmlhYmxlcyB0byBpbmplY3QgaW50byB0aGUgUlBDIGNoaWxkIHByb2Nlc3MuXG4gICAqL1xuICBnZXRTZWNyZXRFbnZWYXJzKCk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuICAgIHJldHVybiB0aGlzLmFuc3dlckZpbGUuc2VjcmV0cyA/PyB7fVxuICB9XG5cbiAgLyoqXG4gICAqIEdldCBhIGNvcHkgb2YgdGhlIGN1cnJlbnQgc3RhdHMuXG4gICAqL1xuICBnZXRTdGF0cygpOiBBbnN3ZXJJbmplY3RvclN0YXRzIHtcbiAgICByZXR1cm4geyAuLi50aGlzLnN0YXRzIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBHZXQgd2FybmluZ3MgZm9yIHVudXNlZCBxdWVzdGlvbiBJRHMgYW5kIHNlY3JldCBrZXlzLlxuICAgKi9cbiAgZ2V0VW51c2VkV2FybmluZ3MoKTogc3RyaW5nW10ge1xuICAgIGNvbnN0IHdhcm5pbmdzOiBzdHJpbmdbXSA9IFtdXG5cbiAgICBpZiAodGhpcy5hbnN3ZXJGaWxlLnF1ZXN0aW9ucykge1xuICAgICAgZm9yIChjb25zdCBpZCBvZiBPYmplY3Qua2V5cyh0aGlzLmFuc3dlckZpbGUucXVlc3Rpb25zKSkge1xuICAgICAgICBpZiAoIXRoaXMudXNlZFF1ZXN0aW9uSWRzLmhhcyhpZCkpIHtcbiAgICAgICAgICB3YXJuaW5ncy5wdXNoKGBbYW5zd2Vyc10gV2FybmluZzogcXVlc3Rpb24gSUQgJyR7aWR9JyB3YXMgbmV2ZXIgbWF0Y2hlZGApXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodGhpcy5hbnN3ZXJGaWxlLnNlY3JldHMpIHtcbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHRoaXMuYW5zd2VyRmlsZS5zZWNyZXRzKSkge1xuICAgICAgICBpZiAoIXRoaXMudXNlZFNlY3JldEtleXMuaGFzKGtleSkpIHtcbiAgICAgICAgICB3YXJuaW5ncy5wdXNoKGBbYW5zd2Vyc10gV2FybmluZzogc2VjcmV0ICcke2tleX0nIHdhcyBwcm92aWRlZCBidXQgbmV2ZXIgcmVxdWVzdGVkYClcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB3YXJuaW5nc1xuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBQcml2YXRlXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICBwcml2YXRlIHByb2Nlc3NXaXRoTWV0YShldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIHdyaXRlVG9TdGRpbjogKGRhdGE6IHN0cmluZykgPT4gdm9pZCk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IHRpdGxlID0gU3RyaW5nKGV2ZW50LnRpdGxlID8/ICcnKVxuICAgIGNvbnN0IG1ldGEgPSB0aGlzLnF1ZXN0aW9uTWV0YUJ5VGl0bGUuZ2V0KHRpdGxlKVxuICAgIGlmICghbWV0YSkgcmV0dXJuIGZhbHNlXG5cbiAgICBjb25zdCBhbnN3ZXIgPSB0aGlzLmFuc3dlckZpbGUucXVlc3Rpb25zPy5bbWV0YS5pZF1cbiAgICBjb25zdCBldmVudE9wdGlvbnMgPSBldmVudC5vcHRpb25zIGFzIHN0cmluZ1tdIHwgdW5kZWZpbmVkXG5cbiAgICBpZiAoYW5zd2VyICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChtZXRhLmFsbG93TXVsdGlwbGUpIHtcbiAgICAgICAgLy8gTXVsdGktc2VsZWN0OiBhbnN3ZXIgbXVzdCBiZSBhbiBhcnJheVxuICAgICAgICBjb25zdCB2YWx1ZXMgPSBBcnJheS5pc0FycmF5KGFuc3dlcikgPyBhbnN3ZXIgOiBbYW5zd2VyXVxuICAgICAgICBjb25zdCB2YWxpZCA9IHZhbHVlcy5ldmVyeSgodikgPT4gZXZlbnRPcHRpb25zPy5pbmNsdWRlcyh2KSlcbiAgICAgICAgaWYgKHZhbGlkKSB7XG4gICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSB7IHR5cGU6ICdleHRlbnNpb25fdWlfcmVzcG9uc2UnLCBpZDogZXZlbnQuaWQsIHZhbHVlcyB9XG4gICAgICAgICAgd3JpdGVUb1N0ZGluKHNlcmlhbGl6ZUpzb25MaW5lKHJlc3BvbnNlKSlcbiAgICAgICAgICB0aGlzLnVzZWRRdWVzdGlvbklkcy5hZGQobWV0YS5pZClcbiAgICAgICAgICB0aGlzLnN0YXRzLnF1ZXN0aW9uc0Fuc3dlcmVkKytcbiAgICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBTaW5nbGUtc2VsZWN0OiBhbnN3ZXIgbXVzdCBiZSBhIHN0cmluZyBpbiB0aGUgb3B0aW9uc1xuICAgICAgICBjb25zdCB2YWx1ZSA9IEFycmF5LmlzQXJyYXkoYW5zd2VyKSA/IGFuc3dlclswXSA6IGFuc3dlclxuICAgICAgICBpZiAoZXZlbnRPcHRpb25zPy5pbmNsdWRlcyh2YWx1ZSkpIHtcbiAgICAgICAgICBjb25zdCByZXNwb25zZSA9IHsgdHlwZTogJ2V4dGVuc2lvbl91aV9yZXNwb25zZScsIGlkOiBldmVudC5pZCwgdmFsdWUgfVxuICAgICAgICAgIHdyaXRlVG9TdGRpbihzZXJpYWxpemVKc29uTGluZShyZXNwb25zZSkpXG4gICAgICAgICAgdGhpcy51c2VkUXVlc3Rpb25JZHMuYWRkKG1ldGEuaWQpXG4gICAgICAgICAgdGhpcy5zdGF0cy5xdWVzdGlvbnNBbnN3ZXJlZCsrXG4gICAgICAgICAgcmV0dXJuIHRydWVcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIEFuc3dlciBub3QgZm91bmQgb3Igbm90IHZhbGlkIFx1MjAxNCBhcHBseSBkZWZhdWx0IHN0cmF0ZWd5XG4gICAgY29uc3Qgc3RyYXRlZ3kgPSB0aGlzLmFuc3dlckZpbGUuZGVmYXVsdHM/LnN0cmF0ZWd5ID8/ICdmaXJzdF9vcHRpb24nXG4gICAgdGhpcy5zdGF0cy5xdWVzdGlvbnNEZWZhdWx0ZWQrK1xuXG4gICAgaWYgKHN0cmF0ZWd5ID09PSAnY2FuY2VsJykge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSB7IHR5cGU6ICdleHRlbnNpb25fdWlfcmVzcG9uc2UnLCBpZDogZXZlbnQuaWQsIGNhbmNlbGxlZDogdHJ1ZSB9XG4gICAgICB3cml0ZVRvU3RkaW4oc2VyaWFsaXplSnNvbkxpbmUocmVzcG9uc2UpKVxuICAgICAgcmV0dXJuIHRydWVcbiAgICB9XG5cbiAgICAvLyBmaXJzdF9vcHRpb246IHJldHVybiBmYWxzZSB0byBsZXQgdGhlIGF1dG8tcmVzcG9uZGVyIGhhbmRsZSBpdFxuICAgIHJldHVybiBmYWxzZVxuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFRQSxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLHlCQUF5QjtBQThCM0IsU0FBUywwQkFBMEIsTUFBMEI7QUFDbEUsUUFBTSxNQUFNLGFBQWEsTUFBTSxPQUFPO0FBQ3RDLE1BQUk7QUFDSixNQUFJO0FBQ0YsYUFBUyxLQUFLLE1BQU0sR0FBRztBQUFBLEVBQ3pCLFFBQVE7QUFDTixVQUFNLElBQUksTUFBTSxnQ0FBZ0MsSUFBSSxFQUFFO0FBQUEsRUFDeEQ7QUFFQSxNQUFJLE9BQU8sV0FBVyxZQUFZLFdBQVcsUUFBUSxNQUFNLFFBQVEsTUFBTSxHQUFHO0FBQzFFLFVBQU0sSUFBSSxNQUFNLG1DQUFtQztBQUFBLEVBQ3JEO0FBRUEsUUFBTSxNQUFNO0FBRVosTUFBSSxJQUFJLGNBQWMsUUFBVztBQUMvQixRQUFJLE9BQU8sSUFBSSxjQUFjLFlBQVksSUFBSSxjQUFjLFFBQVEsTUFBTSxRQUFRLElBQUksU0FBUyxHQUFHO0FBQy9GLFlBQU0sSUFBSSxNQUFNLDJDQUEyQztBQUFBLElBQzdEO0FBQ0EsVUFBTSxZQUFZLElBQUk7QUFDdEIsZUFBVyxDQUFDLEtBQUssS0FBSyxLQUFLLE9BQU8sUUFBUSxTQUFTLEdBQUc7QUFDcEQsVUFBSSxPQUFPLFVBQVUsU0FBVTtBQUMvQixVQUFJLE1BQU0sUUFBUSxLQUFLLEtBQUssTUFBTSxNQUFNLENBQUMsTUFBTSxPQUFPLE1BQU0sUUFBUSxF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
