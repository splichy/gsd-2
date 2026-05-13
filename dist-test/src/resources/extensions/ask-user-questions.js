import { sanitizeError } from "./shared/sanitize.js";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  showInterviewRound
} from "./shared/tui.js";
const OptionSchema = Type.Object({
  label: Type.String({ description: "User-facing label (1-5 words)" }),
  description: Type.String({ description: "One short sentence explaining impact/tradeoff if selected" }),
  preview: Type.Optional(
    Type.String({
      description: "Optional markdown content shown in a side-by-side preview panel when this option is highlighted. Use for showing code samples, config snippets, or detailed explanations. Keep under ~20 lines \u2014 longer content is truncated."
    })
  )
});
const QuestionSchema = Type.Object({
  id: Type.String({ description: "Stable identifier for mapping answers (snake_case)" }),
  header: Type.String({ description: "Short header label shown in the UI (12 or fewer chars)" }),
  question: Type.String({ description: "Single-sentence prompt shown to the user" }),
  options: Type.Array(OptionSchema, {
    description: 'Provide 2-3 mutually exclusive choices for single-select, or any number for multi-select. Put the recommended option first and suffix its label with "(Recommended)". Each option can include an optional "preview" field with markdown content shown in a side panel. Do not include an "Other" option for single-select; the client adds a free-form "None of the above" option automatically.'
  }),
  allowMultiple: Type.Optional(
    Type.Boolean({
      description: "If true, the user can select multiple options using SPACE to toggle and ENTER to confirm. No 'None of the above' option is added. Default: false."
    })
  )
});
const AskUserQuestionsParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: "Questions to show the user. Prefer 1 and do not exceed 3."
  })
});
import { createHash } from "node:crypto";
const turnCache = /* @__PURE__ */ new Map();
function questionSignature(questions) {
  const canonical = questions.map((q) => ({
    id: q.id,
    header: q.header,
    question: q.question,
    options: (q.options || []).map((o) => ({ label: o.label, description: o.description })),
    allowMultiple: !!q.allowMultiple
  })).sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}
function resetAskUserQuestionsCache() {
  turnCache.clear();
}
async function raceRemoteAndLocal(startRemote, startLocal, controller, questions) {
  const localPromise = startLocal().then((result) => {
    if (!result || Object.keys(result.answers).length === 0) return null;
    return {
      content: [{ type: "text", text: formatForLLM(result) }],
      details: { questions, response: result, cancelled: false }
    };
  }).catch(() => null);
  const remotePromise = startRemote().then((result) => {
    if (!result) return null;
    const details = result.details;
    if (details?.timed_out || details?.error) return null;
    return result;
  }).catch(() => null);
  const winner = await Promise.race([
    localPromise.then((r) => r ? { source: "local", result: r } : null),
    remotePromise.then((r) => r ? { source: "remote", result: r } : null)
  ]);
  if (winner) {
    controller.abort();
    return winner.result;
  }
  const [localResult, remoteResult] = await Promise.all([localPromise, remotePromise]);
  controller.abort();
  return localResult ?? remoteResult;
}
const OTHER_OPTION_LABEL = "None of the above";
function errorResult(message, questions = []) {
  return {
    content: [{ type: "text", text: sanitizeError(message) }],
    details: { questions, response: null, cancelled: true }
  };
}
function formatForLLM(result) {
  const answers = {};
  for (const [id, answer] of Object.entries(result.answers)) {
    const list = [];
    if (Array.isArray(answer.selected)) {
      list.push(...answer.selected);
    } else {
      list.push(answer.selected);
    }
    if (answer.notes) {
      list.push(`user_note: ${answer.notes}`);
    }
    answers[id] = { answers: list };
  }
  return JSON.stringify({ answers });
}
function AskUserQuestions(pi) {
  pi.registerTool({
    name: "ask_user_questions",
    label: "Request User Input",
    description: "Request user input for one to three short questions and wait for the response. Single-select questions have 2-3 mutually exclusive options with a free-form 'None of the above' added automatically. Multi-select questions (allowMultiple: true) let the user toggle multiple options with SPACE and confirm with ENTER. Options can include an optional 'preview' field with markdown content shown in a side-by-side panel when highlighted.",
    promptGuidelines: [
      "Use ask_user_questions when you need the user to choose between concrete alternatives before proceeding.",
      "Keep questions to 1 when possible; never exceed 3.",
      "For single-select: each question must have 2-3 options. Put the recommended option first with '(Recommended)' suffix. Do not include an 'Other' or 'None of the above' option - the client adds one automatically.",
      "For multi-select: set allowMultiple: true. The user can pick any number of options. No 'None of the above' is added.",
      "When options involve code patterns, config choices, or architecture decisions, add a 'preview' field with markdown content (code blocks, lists, headers, etc.). The preview renders in a side-by-side panel when the option is highlighted.",
      "Preview content is rendered in a fixed-height panel (max ~20 lines visible). Keep previews concise \u2014 show the most relevant snippet, not exhaustive examples. Longer content is truncated with a '+N lines hidden' indicator."
    ],
    parameters: AskUserQuestionsParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sig = questionSignature(params.questions);
      const cached = turnCache.get(sig);
      if (cached) {
        return {
          content: [{ type: "text", text: cached.content[0].text + "\n(Returned cached answer \u2014 this question set was already asked this turn.)" }],
          details: cached.details
        };
      }
      if (params.questions.length === 0 || params.questions.length > 3) {
        return errorResult("Error: questions must contain 1-3 items", params.questions);
      }
      for (const q of params.questions) {
        if (!q.options || q.options.length === 0) {
          return errorResult(
            `Error: ask_user_questions requires non-empty options for every question (question "${q.id}" has none)`,
            params.questions
          );
        }
      }
      const { tryRemoteQuestions, isRemoteConfigured } = await import("./remote-questions/manager.js");
      const hasRemote = isRemoteConfigured();
      if (hasRemote && ctx.hasUI) {
        const raceController = new AbortController();
        const onParentAbort = () => raceController.abort();
        signal?.addEventListener("abort", onParentAbort, { once: true });
        const raceSignal = raceController.signal;
        const raceResult = await raceRemoteAndLocal(
          () => tryRemoteQuestions(params.questions, raceSignal),
          () => showInterviewRound(params.questions, { signal: raceSignal }, ctx),
          raceController,
          params.questions
        );
        signal?.removeEventListener("abort", onParentAbort);
        if (raceResult) {
          const details = raceResult.details;
          if (details && !details.timed_out && !details.error && !details.cancelled) {
            turnCache.set(sig, raceResult);
          }
          return { ...raceResult, details: raceResult.details };
        }
        return errorResult("ask_user_questions: no response received from local UI or remote channel", params.questions);
      }
      if (hasRemote && !ctx.hasUI) {
        const remoteResult = await tryRemoteQuestions(params.questions, signal);
        if (remoteResult) {
          const remoteDetails = remoteResult.details;
          if (remoteDetails && !remoteDetails.timed_out && !remoteDetails.error) {
            turnCache.set(sig, remoteResult);
          }
          return { ...remoteResult, details: remoteResult.details };
        }
        return errorResult("Error: remote channel configured but returned no result", params.questions);
      }
      if (!ctx.hasUI) {
        return errorResult("Error: UI not available (non-interactive mode)", params.questions);
      }
      const result = await showInterviewRound(params.questions, {}, ctx);
      if (!result) {
        const answers = {};
        for (const q of params.questions) {
          const options = q.options.map((o) => o.label);
          if (!q.allowMultiple) {
            options.push(OTHER_OPTION_LABEL);
          }
          const selected = await ctx.ui.select(
            `${q.header}: ${q.question}`,
            options,
            { signal, ...q.allowMultiple ? { allowMultiple: true } : {} }
          );
          if (selected === void 0) {
            return errorResult("ask_user_questions was cancelled", params.questions);
          }
          let freeTextNote = "";
          const selectedStr = Array.isArray(selected) ? selected[0] : selected;
          if (!q.allowMultiple && selectedStr === OTHER_OPTION_LABEL) {
            const note = await ctx.ui.input(
              `${q.header}: Please explain in your own words`,
              "Type your answer here\u2026"
            );
            if (note) {
              freeTextNote = note;
            }
          }
          const answerList = Array.isArray(selected) ? selected : [selected];
          if (freeTextNote) {
            answerList.push(`user_note: ${freeTextNote}`);
          }
          answers[q.id] = { answers: answerList };
        }
        const roundResult = {
          endInterview: false,
          answers: Object.fromEntries(
            Object.entries(answers).map(([id, a]) => [
              id,
              { selected: a.answers.length === 1 ? a.answers[0] : a.answers, notes: "" }
            ])
          )
        };
        const fallbackResult = {
          content: [{ type: "text", text: JSON.stringify({ answers }) }],
          details: {
            questions: params.questions,
            response: roundResult,
            cancelled: false
          }
        };
        turnCache.set(sig, fallbackResult);
        return fallbackResult;
      }
      const hasAnswers = Object.keys(result.answers).length > 0;
      if (!hasAnswers) {
        return {
          content: [{ type: "text", text: "ask_user_questions was cancelled before receiving a response" }],
          details: { questions: params.questions, response: null, cancelled: true }
        };
      }
      const successResult = {
        content: [{ type: "text", text: formatForLLM(result) }],
        details: { questions: params.questions, response: result, cancelled: false }
      };
      turnCache.set(sig, successResult);
      return successResult;
    },
    // ─── Rendering ────────────────────────────────────────────────────────
    renderCall(args, theme) {
      const qs = args.questions || [];
      let text = theme.fg("toolTitle", theme.bold("ask_user_questions "));
      text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
      if (qs.length > 0) {
        const headers = qs.map((q) => q.header).join(", ");
        text += theme.fg("dim", ` (${headers})`);
      }
      const previewCount = qs.reduce(
        (acc, q) => acc + (q.options || []).filter((o) => o.preview).length,
        0
      );
      if (previewCount > 0) {
        text += theme.fg("accent", ` [${previewCount} preview${previewCount !== 1 ? "s" : ""}]`);
      }
      for (const q of qs) {
        const multiSel = !!q.allowMultiple;
        text += `
  ${theme.fg("text", q.question)}`;
        const optLabels = multiSel ? (q.options || []).map((o) => o.label) : [...(q.options || []).map((o) => o.label), OTHER_OPTION_LABEL];
        const prefix = multiSel ? "\u2610" : "";
        const numbered = optLabels.map((l, i) => `${prefix}${i + 1}. ${l}`).join(", ");
        text += `
  ${theme.fg("dim", numbered)}`;
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.remote) {
        if (details.timed_out) {
          return new Text(
            `${theme.fg("warning", `${details.channel} \u2014 timed out`)}${details.threadUrl ? theme.fg("dim", ` ${details.threadUrl}`) : ""}`,
            0,
            0
          );
        }
        const questions = details.questions ?? [];
        const lines2 = [];
        lines2.push(theme.fg("dim", details.channel));
        if (details.response) {
          for (const q of questions) {
            const answer = details.response.answers[q.id];
            if (!answer) {
              lines2.push(`${theme.fg("accent", q.header)}: ${theme.fg("dim", "(no answer)")}`);
              continue;
            }
            const selected = answer.selected;
            const answerText = Array.isArray(selected) ? selected.length > 0 ? selected.join(", ") : "(custom)" : selected || "(custom)";
            let line = `${theme.fg("success", "\u2713 ")}${theme.fg("accent", q.header)}: ${answerText}`;
            if (answer.notes) {
              line += ` ${theme.fg("muted", `[note: ${answer.notes}]`)}`;
            }
            lines2.push(line);
          }
        }
        return new Text(lines2.join("\n"), 0, 0);
      }
      if (details.cancelled || !details.response) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }
      const lines = [];
      for (const q of details.questions) {
        const answer = details.response.answers[q.id];
        if (!answer) {
          lines.push(`${theme.fg("accent", q.header)}: ${theme.fg("dim", "(no answer)")}`);
          continue;
        }
        const selected = answer.selected;
        const notes = answer.notes;
        const multiSel = !!q.allowMultiple;
        const answerText = multiSel && Array.isArray(selected) ? selected.join(", ") : (Array.isArray(selected) ? selected[0] : selected) ?? "(no answer)";
        let line = `${theme.fg("success", "\u2713 ")}${theme.fg("accent", q.header)}: ${answerText}`;
        if (notes) {
          line += ` ${theme.fg("muted", `[note: ${notes}]`)}`;
        }
        lines.push(line);
      }
      return new Text(lines.join("\n"), 0, 0);
    }
  });
}
export {
  AskUserQuestions as default,
  questionSignature,
  resetAskUserQuestionsCache
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Fzay11c2VyLXF1ZXN0aW9ucy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSZXF1ZXN0IFVzZXIgSW5wdXQgXHUyMDE0IExMTSB0b29sIGZvciBhc2tpbmcgdGhlIHVzZXIgcXVlc3Rpb25zXG4gKlxuICogVGhpbiB3cmFwcGVyIGFyb3VuZCB0aGUgc2hhcmVkIGludGVydmlldy11aS4gVGhlIExMTSBwcmVzZW50cyAxLTNcbiAqIHF1ZXN0aW9ucyB3aXRoIDItMyBvcHRpb25zIGVhY2guIEVhY2ggcXVlc3Rpb24gY2FuIGJlIHNpbmdsZS1zZWxlY3QgKGRlZmF1bHQpXG4gKiBvciBtdWx0aS1zZWxlY3QgKGFsbG93TXVsdGlwbGU6IHRydWUpLiBBIGZyZWUtZm9ybSBcIk5vbmUgb2YgdGhlIGFib3ZlXCIgb3B0aW9uXG4gKiBpcyBhZGRlZCBhdXRvbWF0aWNhbGx5IHRvIHNpbmdsZS1zZWxlY3QgcXVlc3Rpb25zLlxuICpcbiAqIEJhc2VkIG9uOiBodHRwczovL2dpdGh1Yi5jb20vb3BlbmFpL2NvZGV4IChjb2RleC1ycy9jb3JlL3NyYy90b29scy9oYW5kbGVycy9hc2tfdXNlcl9xdWVzdGlvbnMucnMpXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IHNhbml0aXplRXJyb3IgfSBmcm9tIFwiLi9zaGFyZWQvc2FuaXRpemUuanNcIjtcbmltcG9ydCB7IFRleHQgfSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB7XG5cdHNob3dJbnRlcnZpZXdSb3VuZCxcblx0dHlwZSBRdWVzdGlvbixcblx0dHlwZSBRdWVzdGlvbk9wdGlvbixcblx0dHlwZSBSb3VuZFJlc3VsdCxcbn0gZnJvbSBcIi4vc2hhcmVkL3R1aS5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVHlwZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmludGVyZmFjZSBMb2NhbFJlc3VsdERldGFpbHMge1xuXHRyZW1vdGU/OiBmYWxzZTtcblx0cXVlc3Rpb25zOiBRdWVzdGlvbltdO1xuXHRyZXNwb25zZTogUm91bmRSZXN1bHQgfCBudWxsO1xuXHRjYW5jZWxsZWQ6IGJvb2xlYW47XG59XG5cbmludGVyZmFjZSBSZW1vdGVSZXN1bHREZXRhaWxzIHtcblx0cmVtb3RlOiB0cnVlO1xuXHRjaGFubmVsOiBzdHJpbmc7XG5cdHRpbWVkX291dDogYm9vbGVhbjtcblx0cHJvbXB0SWQ/OiBzdHJpbmc7XG5cdHRocmVhZFVybD86IHN0cmluZztcblx0c3RhdHVzPzogc3RyaW5nO1xuXHRxdWVzdGlvbnM/OiBRdWVzdGlvbltdO1xuXHRyZXNwb25zZT86IFJvdW5kUmVzdWx0O1xuXHRlcnJvcj86IGJvb2xlYW47XG59XG5cbnR5cGUgQXNrVXNlclF1ZXN0aW9uc0RldGFpbHMgPSBMb2NhbFJlc3VsdERldGFpbHMgfCBSZW1vdGVSZXN1bHREZXRhaWxzO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2NoZW1hIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBPcHRpb25TY2hlbWEgPSBUeXBlLk9iamVjdCh7XG5cdGxhYmVsOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlVzZXItZmFjaW5nIGxhYmVsICgxLTUgd29yZHMpXCIgfSksXG5cdGRlc2NyaXB0aW9uOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk9uZSBzaG9ydCBzZW50ZW5jZSBleHBsYWluaW5nIGltcGFjdC90cmFkZW9mZiBpZiBzZWxlY3RlZFwiIH0pLFxuXHRwcmV2aWV3OiBUeXBlLk9wdGlvbmFsKFxuXHRcdFR5cGUuU3RyaW5nKHtcblx0XHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XHRcIk9wdGlvbmFsIG1hcmtkb3duIGNvbnRlbnQgc2hvd24gaW4gYSBzaWRlLWJ5LXNpZGUgcHJldmlldyBwYW5lbCB3aGVuIHRoaXMgb3B0aW9uIGlzIGhpZ2hsaWdodGVkLiBVc2UgZm9yIHNob3dpbmcgY29kZSBzYW1wbGVzLCBjb25maWcgc25pcHBldHMsIG9yIGRldGFpbGVkIGV4cGxhbmF0aW9ucy4gS2VlcCB1bmRlciB+MjAgbGluZXMgXHUyMDE0IGxvbmdlciBjb250ZW50IGlzIHRydW5jYXRlZC5cIixcblx0XHR9KSxcblx0KSxcbn0pO1xuXG5jb25zdCBRdWVzdGlvblNjaGVtYSA9IFR5cGUuT2JqZWN0KHtcblx0aWQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiU3RhYmxlIGlkZW50aWZpZXIgZm9yIG1hcHBpbmcgYW5zd2VycyAoc25ha2VfY2FzZSlcIiB9KSxcblx0aGVhZGVyOiBUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlNob3J0IGhlYWRlciBsYWJlbCBzaG93biBpbiB0aGUgVUkgKDEyIG9yIGZld2VyIGNoYXJzKVwiIH0pLFxuXHRxdWVzdGlvbjogVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJTaW5nbGUtc2VudGVuY2UgcHJvbXB0IHNob3duIHRvIHRoZSB1c2VyXCIgfSksXG5cdG9wdGlvbnM6IFR5cGUuQXJyYXkoT3B0aW9uU2NoZW1hLCB7XG5cdFx0ZGVzY3JpcHRpb246XG5cdFx0XHQnUHJvdmlkZSAyLTMgbXV0dWFsbHkgZXhjbHVzaXZlIGNob2ljZXMgZm9yIHNpbmdsZS1zZWxlY3QsIG9yIGFueSBudW1iZXIgZm9yIG11bHRpLXNlbGVjdC4gUHV0IHRoZSByZWNvbW1lbmRlZCBvcHRpb24gZmlyc3QgYW5kIHN1ZmZpeCBpdHMgbGFiZWwgd2l0aCBcIihSZWNvbW1lbmRlZClcIi4gRWFjaCBvcHRpb24gY2FuIGluY2x1ZGUgYW4gb3B0aW9uYWwgXCJwcmV2aWV3XCIgZmllbGQgd2l0aCBtYXJrZG93biBjb250ZW50IHNob3duIGluIGEgc2lkZSBwYW5lbC4gRG8gbm90IGluY2x1ZGUgYW4gXCJPdGhlclwiIG9wdGlvbiBmb3Igc2luZ2xlLXNlbGVjdDsgdGhlIGNsaWVudCBhZGRzIGEgZnJlZS1mb3JtIFwiTm9uZSBvZiB0aGUgYWJvdmVcIiBvcHRpb24gYXV0b21hdGljYWxseS4nLFxuXHR9KSxcblx0YWxsb3dNdWx0aXBsZTogVHlwZS5PcHRpb25hbChcblx0XHRUeXBlLkJvb2xlYW4oe1xuXHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFwiSWYgdHJ1ZSwgdGhlIHVzZXIgY2FuIHNlbGVjdCBtdWx0aXBsZSBvcHRpb25zIHVzaW5nIFNQQUNFIHRvIHRvZ2dsZSBhbmQgRU5URVIgdG8gY29uZmlybS4gTm8gJ05vbmUgb2YgdGhlIGFib3ZlJyBvcHRpb24gaXMgYWRkZWQuIERlZmF1bHQ6IGZhbHNlLlwiLFxuXHRcdH0pLFxuXHQpLFxufSk7XG5cbmNvbnN0IEFza1VzZXJRdWVzdGlvbnNQYXJhbXMgPSBUeXBlLk9iamVjdCh7XG5cdHF1ZXN0aW9uczogVHlwZS5BcnJheShRdWVzdGlvblNjaGVtYSwge1xuXHRcdGRlc2NyaXB0aW9uOiBcIlF1ZXN0aW9ucyB0byBzaG93IHRoZSB1c2VyLiBQcmVmZXIgMSBhbmQgZG8gbm90IGV4Y2VlZCAzLlwiLFxuXHR9KSxcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUGVyLXR1cm4gZGVkdXBsaWNhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIFByZXZlbnRzIGR1cGxpY2F0ZSBxdWVzdGlvbiBkaXNwYXRjaGVzIChlc3BlY2lhbGx5IHRvIHJlbW90ZSBjaGFubmVscyBsaWtlXG4vLyBEaXNjb3JkKSB3aGVuIHRoZSBMTE0gY2FsbHMgYXNrX3VzZXJfcXVlc3Rpb25zIG11bHRpcGxlIHRpbWVzIHdpdGggdGhlIHNhbWVcbi8vIHF1ZXN0aW9ucyBpbiBhIHNpbmdsZSB0dXJuLiBLZXllZCBieSBmdWxsIGNhbm9uaWNhbGl6ZWQgcGF5bG9hZCAoaWQsIGhlYWRlcixcbi8vIHF1ZXN0aW9uLCBvcHRpb25zLCBhbGxvd011bHRpcGxlKSBcdTIwMTQgbm90IGp1c3QgSURzIFx1MjAxNCBzbyB0aGF0IGNhbGxzIHdpdGggdGhlXG4vLyBzYW1lIElEcyBidXQgZGlmZmVyZW50IHRleHQvb3B0aW9ucyBhcmUgdHJlYXRlZCBhcyBkaXN0aW5jdC5cblxuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuXG5pbnRlcmZhY2UgQ2FjaGVkUmVzdWx0IHtcblx0Y29udGVudDogeyB0eXBlOiBcInRleHRcIjsgdGV4dDogc3RyaW5nIH1bXTtcblx0ZGV0YWlsczogQXNrVXNlclF1ZXN0aW9uc0RldGFpbHM7XG59XG5cbmNvbnN0IHR1cm5DYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBDYWNoZWRSZXN1bHQ+KCk7XG5cbi8qKiBAaW50ZXJuYWwgRXhwb3J0ZWQgZm9yIHRlc3Rpbmcgb25seS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBxdWVzdGlvblNpZ25hdHVyZShxdWVzdGlvbnM6IFF1ZXN0aW9uW10pOiBzdHJpbmcge1xuXHRjb25zdCBjYW5vbmljYWwgPSBxdWVzdGlvbnNcblx0XHQubWFwKChxKSA9PiAoe1xuXHRcdFx0aWQ6IHEuaWQsXG5cdFx0XHRoZWFkZXI6IHEuaGVhZGVyLFxuXHRcdFx0cXVlc3Rpb246IHEucXVlc3Rpb24sXG5cdFx0XHRvcHRpb25zOiAocS5vcHRpb25zIHx8IFtdKS5tYXAoKG8pID0+ICh7IGxhYmVsOiBvLmxhYmVsLCBkZXNjcmlwdGlvbjogby5kZXNjcmlwdGlvbiB9KSksXG5cdFx0XHRhbGxvd011bHRpcGxlOiAhIXEuYWxsb3dNdWx0aXBsZSxcblx0XHR9KSlcblx0XHQuc29ydCgoYSwgYikgPT4gYS5pZC5sb2NhbGVDb21wYXJlKGIuaWQpKTtcblx0cmV0dXJuIGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKEpTT04uc3RyaW5naWZ5KGNhbm9uaWNhbCkpLmRpZ2VzdChcImhleFwiKS5zbGljZSgwLCAxNik7XG59XG5cbi8qKiBSZXNldCB0aGUgZGVkdXAgY2FjaGUuIENhbGxlZCBvbiBzZXNzaW9uIGJvdW5kYXJpZXMuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzZXRBc2tVc2VyUXVlc3Rpb25zQ2FjaGUoKTogdm9pZCB7XG5cdHR1cm5DYWNoZS5jbGVhcigpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmFjZSBoZWxwZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmludGVyZmFjZSBSYWNlYWJsZVJlc3VsdCB7XG5cdGNvbnRlbnQ6IHsgdHlwZTogXCJ0ZXh0XCI7IHRleHQ6IHN0cmluZyB9W107XG5cdGRldGFpbHM/OiB1bmtub3duO1xufVxuXG4vKipcbiAqIFJhY2UgYSByZW1vdGUgY2hhbm5lbCBkaXNwYXRjaCBhZ2FpbnN0IHRoZSBsb2NhbCBUVUkuIFRoZSBmaXJzdCB0byBwcm9kdWNlXG4gKiBhIHZhbGlkIChub24tZXJyb3IsIG5vbi10aW1lb3V0KSByZXN1bHQgd2lucy4gVGhlIGxvc2VyIGlzIGNhbmNlbGxlZCB2aWFcbiAqIHRoZSBzaGFyZWQgQWJvcnRDb250cm9sbGVyLlxuICpcbiAqIElmIHRoZSBsb2NhbCBUVUkgcmVzcG9uZHMgZmlyc3QsIHRoZSByZW1vdGUgcG9sbCBpcyBhYm9ydGVkICh0aGUgbWVzc2FnZVxuICogc3RheXMgaW4gRGlzY29yZC9TbGFjayBidXQgcG9sbGluZyBzdG9wcykuIElmIHJlbW90ZSByZXNwb25kcyBmaXJzdCwgdGhlXG4gKiBsb2NhbCBUVUkgcHJvbXB0IGlzIGNhbmNlbGxlZC5cbiAqXG4gKiBSZXR1cm5zIG51bGwgb25seSB3aGVuIGJvdGggc2lkZXMgZmFpbCBvciBhcmUgY2FuY2VsbGVkLlxuICovXG5hc3luYyBmdW5jdGlvbiByYWNlUmVtb3RlQW5kTG9jYWwoXG5cdHN0YXJ0UmVtb3RlOiAoKSA9PiBQcm9taXNlPFJhY2VhYmxlUmVzdWx0IHwgbnVsbD4sXG5cdHN0YXJ0TG9jYWw6ICgpID0+IFByb21pc2U8Um91bmRSZXN1bHQgfCBudWxsIHwgdW5kZWZpbmVkPixcblx0Y29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyLFxuXHRxdWVzdGlvbnM6IFF1ZXN0aW9uW10sXG4pOiBQcm9taXNlPFJhY2VhYmxlUmVzdWx0IHwgbnVsbD4ge1xuXHQvLyBXcmFwIGxvY2FsIFRVSSByZXN1bHQgaW50byB0aGUgc2FtZSBzaGFwZSBhcyByZW1vdGUgcmVzdWx0c1xuXHRjb25zdCBsb2NhbFByb21pc2UgPSBzdGFydExvY2FsKCkudGhlbigocmVzdWx0KTogUmFjZWFibGVSZXN1bHQgfCBudWxsID0+IHtcblx0XHRpZiAoIXJlc3VsdCB8fCBPYmplY3Qua2V5cyhyZXN1bHQuYW5zd2VycykubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcblx0XHRyZXR1cm4ge1xuXHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGZvcm1hdEZvckxMTShyZXN1bHQpIH1dLFxuXHRcdFx0ZGV0YWlsczogeyBxdWVzdGlvbnMsIHJlc3BvbnNlOiByZXN1bHQsIGNhbmNlbGxlZDogZmFsc2UgfSBzYXRpc2ZpZXMgTG9jYWxSZXN1bHREZXRhaWxzLFxuXHRcdH07XG5cdH0pLmNhdGNoKCgpID0+IG51bGwpO1xuXG5cdGNvbnN0IHJlbW90ZVByb21pc2UgPSBzdGFydFJlbW90ZSgpLnRoZW4oKHJlc3VsdCk6IFJhY2VhYmxlUmVzdWx0IHwgbnVsbCA9PiB7XG5cdFx0aWYgKCFyZXN1bHQpIHJldHVybiBudWxsO1xuXHRcdGNvbnN0IGRldGFpbHMgPSByZXN1bHQuZGV0YWlscyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcblx0XHQvLyBUcmVhdCB0aW1lb3V0cyBhbmQgZXJyb3JzIGFzIG5vbi13aW5zIFx1MjAxNCBsZXQgdGhlIGxvY2FsIFRVSSB3aW4gaW5zdGVhZFxuXHRcdGlmIChkZXRhaWxzPy50aW1lZF9vdXQgfHwgZGV0YWlscz8uZXJyb3IpIHJldHVybiBudWxsO1xuXHRcdHJldHVybiByZXN1bHQ7XG5cdH0pLmNhdGNoKCgpID0+IG51bGwpO1xuXG5cdC8vIFJhY2U6IGZpcnN0IG5vbi1udWxsIHJlc3VsdCB3aW5zXG5cdGNvbnN0IHdpbm5lciA9IGF3YWl0IFByb21pc2UucmFjZShbXG5cdFx0bG9jYWxQcm9taXNlLnRoZW4oKHIpID0+IHIgPyB7IHNvdXJjZTogXCJsb2NhbFwiIGFzIGNvbnN0LCByZXN1bHQ6IHIgfSA6IG51bGwpLFxuXHRcdHJlbW90ZVByb21pc2UudGhlbigocikgPT4gciA/IHsgc291cmNlOiBcInJlbW90ZVwiIGFzIGNvbnN0LCByZXN1bHQ6IHIgfSA6IG51bGwpLFxuXHRdKTtcblxuXHRpZiAod2lubmVyKSB7XG5cdFx0Ly8gQ2FuY2VsIHRoZSBsb3NlclxuXHRcdGNvbnRyb2xsZXIuYWJvcnQoKTtcblx0XHRyZXR1cm4gd2lubmVyLnJlc3VsdDtcblx0fVxuXG5cdC8vIEZpcnN0IHRvIHJlc29sdmUgd2FzIG51bGwgXHUyMDE0IHdhaXQgZm9yIHRoZSBvdGhlclxuXHRjb25zdCBbbG9jYWxSZXN1bHQsIHJlbW90ZVJlc3VsdF0gPSBhd2FpdCBQcm9taXNlLmFsbChbbG9jYWxQcm9taXNlLCByZW1vdGVQcm9taXNlXSk7XG5cdGNvbnRyb2xsZXIuYWJvcnQoKTtcblx0cmV0dXJuIGxvY2FsUmVzdWx0ID8/IHJlbW90ZVJlc3VsdDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnN0IE9USEVSX09QVElPTl9MQUJFTCA9IFwiTm9uZSBvZiB0aGUgYWJvdmVcIjtcblxuZnVuY3Rpb24gZXJyb3JSZXN1bHQoXG5cdG1lc3NhZ2U6IHN0cmluZyxcblx0cXVlc3Rpb25zOiBRdWVzdGlvbltdID0gW10sXG4pOiB7IGNvbnRlbnQ6IHsgdHlwZTogXCJ0ZXh0XCI7IHRleHQ6IHN0cmluZyB9W107IGRldGFpbHM6IEFza1VzZXJRdWVzdGlvbnNEZXRhaWxzIH0ge1xuXHRyZXR1cm4ge1xuXHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBzYW5pdGl6ZUVycm9yKG1lc3NhZ2UpIH1dLFxuXHRcdGRldGFpbHM6IHsgcXVlc3Rpb25zLCByZXNwb25zZTogbnVsbCwgY2FuY2VsbGVkOiB0cnVlIH0sXG5cdH07XG59XG5cbi8qKiBDb252ZXJ0IHRoZSBzaGFyZWQgUm91bmRSZXN1bHQgaW50byB0aGUgSlNPTiB0aGUgTExNIGV4cGVjdHMuICovXG5mdW5jdGlvbiBmb3JtYXRGb3JMTE0ocmVzdWx0OiBSb3VuZFJlc3VsdCk6IHN0cmluZyB7XG5cdGNvbnN0IGFuc3dlcnM6IFJlY29yZDxzdHJpbmcsIHsgYW5zd2Vyczogc3RyaW5nW10gfT4gPSB7fTtcblx0Zm9yIChjb25zdCBbaWQsIGFuc3dlcl0gb2YgT2JqZWN0LmVudHJpZXMocmVzdWx0LmFuc3dlcnMpKSB7XG5cdFx0Y29uc3QgbGlzdDogc3RyaW5nW10gPSBbXTtcblx0XHRpZiAoQXJyYXkuaXNBcnJheShhbnN3ZXIuc2VsZWN0ZWQpKSB7XG5cdFx0XHRsaXN0LnB1c2goLi4uYW5zd2VyLnNlbGVjdGVkKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0bGlzdC5wdXNoKGFuc3dlci5zZWxlY3RlZCk7XG5cdFx0fVxuXHRcdGlmIChhbnN3ZXIubm90ZXMpIHtcblx0XHRcdGxpc3QucHVzaChgdXNlcl9ub3RlOiAke2Fuc3dlci5ub3Rlc31gKTtcblx0XHR9XG5cdFx0YW5zd2Vyc1tpZF0gPSB7IGFuc3dlcnM6IGxpc3QgfTtcblx0fVxuXHRyZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBhbnN3ZXJzIH0pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRXh0ZW5zaW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbiBBc2tVc2VyUXVlc3Rpb25zKHBpOiBFeHRlbnNpb25BUEkpIHtcblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImFza191c2VyX3F1ZXN0aW9uc1wiLFxuXHRcdGxhYmVsOiBcIlJlcXVlc3QgVXNlciBJbnB1dFwiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJSZXF1ZXN0IHVzZXIgaW5wdXQgZm9yIG9uZSB0byB0aHJlZSBzaG9ydCBxdWVzdGlvbnMgYW5kIHdhaXQgZm9yIHRoZSByZXNwb25zZS4gU2luZ2xlLXNlbGVjdCBxdWVzdGlvbnMgaGF2ZSAyLTMgbXV0dWFsbHkgZXhjbHVzaXZlIG9wdGlvbnMgd2l0aCBhIGZyZWUtZm9ybSAnTm9uZSBvZiB0aGUgYWJvdmUnIGFkZGVkIGF1dG9tYXRpY2FsbHkuIE11bHRpLXNlbGVjdCBxdWVzdGlvbnMgKGFsbG93TXVsdGlwbGU6IHRydWUpIGxldCB0aGUgdXNlciB0b2dnbGUgbXVsdGlwbGUgb3B0aW9ucyB3aXRoIFNQQUNFIGFuZCBjb25maXJtIHdpdGggRU5URVIuIE9wdGlvbnMgY2FuIGluY2x1ZGUgYW4gb3B0aW9uYWwgJ3ByZXZpZXcnIGZpZWxkIHdpdGggbWFya2Rvd24gY29udGVudCBzaG93biBpbiBhIHNpZGUtYnktc2lkZSBwYW5lbCB3aGVuIGhpZ2hsaWdodGVkLlwiLFxuXHRcdHByb21wdEd1aWRlbGluZXM6IFtcblx0XHRcdFwiVXNlIGFza191c2VyX3F1ZXN0aW9ucyB3aGVuIHlvdSBuZWVkIHRoZSB1c2VyIHRvIGNob29zZSBiZXR3ZWVuIGNvbmNyZXRlIGFsdGVybmF0aXZlcyBiZWZvcmUgcHJvY2VlZGluZy5cIixcblx0XHRcdFwiS2VlcCBxdWVzdGlvbnMgdG8gMSB3aGVuIHBvc3NpYmxlOyBuZXZlciBleGNlZWQgMy5cIixcblx0XHRcdFwiRm9yIHNpbmdsZS1zZWxlY3Q6IGVhY2ggcXVlc3Rpb24gbXVzdCBoYXZlIDItMyBvcHRpb25zLiBQdXQgdGhlIHJlY29tbWVuZGVkIG9wdGlvbiBmaXJzdCB3aXRoICcoUmVjb21tZW5kZWQpJyBzdWZmaXguIERvIG5vdCBpbmNsdWRlIGFuICdPdGhlcicgb3IgJ05vbmUgb2YgdGhlIGFib3ZlJyBvcHRpb24gLSB0aGUgY2xpZW50IGFkZHMgb25lIGF1dG9tYXRpY2FsbHkuXCIsXG5cdFx0XHRcIkZvciBtdWx0aS1zZWxlY3Q6IHNldCBhbGxvd011bHRpcGxlOiB0cnVlLiBUaGUgdXNlciBjYW4gcGljayBhbnkgbnVtYmVyIG9mIG9wdGlvbnMuIE5vICdOb25lIG9mIHRoZSBhYm92ZScgaXMgYWRkZWQuXCIsXG5cdFx0XHRcIldoZW4gb3B0aW9ucyBpbnZvbHZlIGNvZGUgcGF0dGVybnMsIGNvbmZpZyBjaG9pY2VzLCBvciBhcmNoaXRlY3R1cmUgZGVjaXNpb25zLCBhZGQgYSAncHJldmlldycgZmllbGQgd2l0aCBtYXJrZG93biBjb250ZW50IChjb2RlIGJsb2NrcywgbGlzdHMsIGhlYWRlcnMsIGV0Yy4pLiBUaGUgcHJldmlldyByZW5kZXJzIGluIGEgc2lkZS1ieS1zaWRlIHBhbmVsIHdoZW4gdGhlIG9wdGlvbiBpcyBoaWdobGlnaHRlZC5cIixcblx0XHRcdFwiUHJldmlldyBjb250ZW50IGlzIHJlbmRlcmVkIGluIGEgZml4ZWQtaGVpZ2h0IHBhbmVsIChtYXggfjIwIGxpbmVzIHZpc2libGUpLiBLZWVwIHByZXZpZXdzIGNvbmNpc2UgXHUyMDE0IHNob3cgdGhlIG1vc3QgcmVsZXZhbnQgc25pcHBldCwgbm90IGV4aGF1c3RpdmUgZXhhbXBsZXMuIExvbmdlciBjb250ZW50IGlzIHRydW5jYXRlZCB3aXRoIGEgJytOIGxpbmVzIGhpZGRlbicgaW5kaWNhdG9yLlwiLFxuXHRcdF0sXG5cdFx0cGFyYW1ldGVyczogQXNrVXNlclF1ZXN0aW9uc1BhcmFtcyxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgc2lnbmFsLCBfb25VcGRhdGUsIGN0eCkge1xuXHRcdFx0Ly8gXHUyNTAwXHUyNTAwIFBlci10dXJuIGRlZHVwOiByZXR1cm4gY2FjaGVkIHJlc3VsdCBmb3IgaWRlbnRpY2FsIHF1ZXN0aW9uIHNldHMgXHUyNTAwXHUyNTAwXG5cdFx0XHRjb25zdCBzaWcgPSBxdWVzdGlvblNpZ25hdHVyZShwYXJhbXMucXVlc3Rpb25zKTtcblx0XHRcdGNvbnN0IGNhY2hlZCA9IHR1cm5DYWNoZS5nZXQoc2lnKTtcblx0XHRcdGlmIChjYWNoZWQpIHtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogY2FjaGVkLmNvbnRlbnRbMF0udGV4dCArIFwiXFxuKFJldHVybmVkIGNhY2hlZCBhbnN3ZXIgXHUyMDE0IHRoaXMgcXVlc3Rpb24gc2V0IHdhcyBhbHJlYWR5IGFza2VkIHRoaXMgdHVybi4pXCIgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogY2FjaGVkLmRldGFpbHMsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cblx0XHRcdC8vIFZhbGlkYXRpb25cblx0XHRcdGlmIChwYXJhbXMucXVlc3Rpb25zLmxlbmd0aCA9PT0gMCB8fCBwYXJhbXMucXVlc3Rpb25zLmxlbmd0aCA+IDMpIHtcblx0XHRcdFx0cmV0dXJuIGVycm9yUmVzdWx0KFwiRXJyb3I6IHF1ZXN0aW9ucyBtdXN0IGNvbnRhaW4gMS0zIGl0ZW1zXCIsIHBhcmFtcy5xdWVzdGlvbnMpO1xuXHRcdFx0fVxuXG5cdFx0XHRmb3IgKGNvbnN0IHEgb2YgcGFyYW1zLnF1ZXN0aW9ucykge1xuXHRcdFx0XHRpZiAoIXEub3B0aW9ucyB8fCBxLm9wdGlvbnMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0cmV0dXJuIGVycm9yUmVzdWx0KFxuXHRcdFx0XHRcdFx0YEVycm9yOiBhc2tfdXNlcl9xdWVzdGlvbnMgcmVxdWlyZXMgbm9uLWVtcHR5IG9wdGlvbnMgZm9yIGV2ZXJ5IHF1ZXN0aW9uIChxdWVzdGlvbiBcIiR7cS5pZH1cIiBoYXMgbm9uZSlgLFxuXHRcdFx0XHRcdFx0cGFyYW1zLnF1ZXN0aW9ucyxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIFx1MjUwMFx1MjUwMCBSb3V0aW5nOiByYWNlIHJlbW90ZSArIGxvY2FsLCByZW1vdGUtb25seSwgb3IgbG9jYWwtb25seSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblx0XHRcdGNvbnN0IHsgdHJ5UmVtb3RlUXVlc3Rpb25zLCBpc1JlbW90ZUNvbmZpZ3VyZWQgfSA9IGF3YWl0IGltcG9ydChcIi4vcmVtb3RlLXF1ZXN0aW9ucy9tYW5hZ2VyLmpzXCIpO1xuXHRcdFx0Y29uc3QgaGFzUmVtb3RlID0gaXNSZW1vdGVDb25maWd1cmVkKCk7XG5cblx0XHRcdC8vIENhc2UgMTogQm90aCByZW1vdGUgYW5kIGxvY2FsIFVJIGF2YWlsYWJsZSBcdTIwMTQgcmFjZSB0aGVtLlxuXHRcdFx0Ly8gVGhlIGZpcnN0IHJlc3BvbnNlIHdpbnM7IHRoZSBsb3NlciBpcyBjYW5jZWxsZWQgdmlhIEFib3J0Q29udHJvbGxlci5cblx0XHRcdGlmIChoYXNSZW1vdGUgJiYgY3R4Lmhhc1VJKSB7XG5cdFx0XHRcdGNvbnN0IHJhY2VDb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuXHRcdFx0XHQvLyBNZXJnZSB0aGUgcGFyZW50IHNpZ25hbCBzbyBleHRlcm5hbCBjYW5jZWxsYXRpb24gcHJvcGFnYXRlcy5cblx0XHRcdFx0Y29uc3Qgb25QYXJlbnRBYm9ydCA9ICgpID0+IHJhY2VDb250cm9sbGVyLmFib3J0KCk7XG5cdFx0XHRcdHNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uUGFyZW50QWJvcnQsIHsgb25jZTogdHJ1ZSB9KTtcblx0XHRcdFx0Y29uc3QgcmFjZVNpZ25hbCA9IHJhY2VDb250cm9sbGVyLnNpZ25hbDtcblxuXHRcdFx0XHRjb25zdCByYWNlUmVzdWx0ID0gYXdhaXQgcmFjZVJlbW90ZUFuZExvY2FsKFxuXHRcdFx0XHRcdCgpID0+IHRyeVJlbW90ZVF1ZXN0aW9ucyhwYXJhbXMucXVlc3Rpb25zLCByYWNlU2lnbmFsKSxcblx0XHRcdFx0XHQoKSA9PiBzaG93SW50ZXJ2aWV3Um91bmQocGFyYW1zLnF1ZXN0aW9ucywgeyBzaWduYWw6IHJhY2VTaWduYWwgfSwgY3R4IGFzIGFueSksXG5cdFx0XHRcdFx0cmFjZUNvbnRyb2xsZXIsXG5cdFx0XHRcdFx0cGFyYW1zLnF1ZXN0aW9ucyxcblx0XHRcdFx0KTtcblxuXHRcdFx0XHRzaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvblBhcmVudEFib3J0KTtcblxuXHRcdFx0XHRpZiAocmFjZVJlc3VsdCkge1xuXHRcdFx0XHRcdGNvbnN0IGRldGFpbHMgPSByYWNlUmVzdWx0LmRldGFpbHMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0aWYgKGRldGFpbHMgJiYgIWRldGFpbHMudGltZWRfb3V0ICYmICFkZXRhaWxzLmVycm9yICYmICFkZXRhaWxzLmNhbmNlbGxlZCkge1xuXHRcdFx0XHRcdFx0dHVybkNhY2hlLnNldChzaWcsIHJhY2VSZXN1bHQgYXMgdW5rbm93biBhcyBDYWNoZWRSZXN1bHQpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRyZXR1cm4geyAuLi5yYWNlUmVzdWx0LCBkZXRhaWxzOiByYWNlUmVzdWx0LmRldGFpbHMgYXMgdW5rbm93biB9O1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIEJvdGggc2lkZXMgZmFpbGVkL2NhbmNlbGxlZCBcdTIwMTQgZmFsbCB0aHJvdWdoIHRvIGVycm9yXG5cdFx0XHRcdHJldHVybiBlcnJvclJlc3VsdChcImFza191c2VyX3F1ZXN0aW9uczogbm8gcmVzcG9uc2UgcmVjZWl2ZWQgZnJvbSBsb2NhbCBVSSBvciByZW1vdGUgY2hhbm5lbFwiLCBwYXJhbXMucXVlc3Rpb25zKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gQ2FzZSAyOiBSZW1vdGUgY29uZmlndXJlZCBidXQgbm8gbG9jYWwgVUkgKGhlYWRsZXNzKSBcdTIwMTQgcmVtb3RlIG9ubHkuXG5cdFx0XHRpZiAoaGFzUmVtb3RlICYmICFjdHguaGFzVUkpIHtcblx0XHRcdFx0Y29uc3QgcmVtb3RlUmVzdWx0ID0gYXdhaXQgdHJ5UmVtb3RlUXVlc3Rpb25zKHBhcmFtcy5xdWVzdGlvbnMsIHNpZ25hbCk7XG5cdFx0XHRcdGlmIChyZW1vdGVSZXN1bHQpIHtcblx0XHRcdFx0XHRjb25zdCByZW1vdGVEZXRhaWxzID0gcmVtb3RlUmVzdWx0LmRldGFpbHMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0aWYgKHJlbW90ZURldGFpbHMgJiYgIXJlbW90ZURldGFpbHMudGltZWRfb3V0ICYmICFyZW1vdGVEZXRhaWxzLmVycm9yKSB7XG5cdFx0XHRcdFx0XHR0dXJuQ2FjaGUuc2V0KHNpZywgcmVtb3RlUmVzdWx0IGFzIHVua25vd24gYXMgQ2FjaGVkUmVzdWx0KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuIHsgLi4ucmVtb3RlUmVzdWx0LCBkZXRhaWxzOiByZW1vdGVSZXN1bHQuZGV0YWlscyBhcyB1bmtub3duIH07XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIGVycm9yUmVzdWx0KFwiRXJyb3I6IHJlbW90ZSBjaGFubmVsIGNvbmZpZ3VyZWQgYnV0IHJldHVybmVkIG5vIHJlc3VsdFwiLCBwYXJhbXMucXVlc3Rpb25zKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gQ2FzZSAzOiBObyByZW1vdGUgXHUyMDE0IGxvY2FsIFVJIG9ubHkuXG5cdFx0XHRpZiAoIWN0eC5oYXNVSSkge1xuXHRcdFx0XHRyZXR1cm4gZXJyb3JSZXN1bHQoXCJFcnJvcjogVUkgbm90IGF2YWlsYWJsZSAobm9uLWludGVyYWN0aXZlIG1vZGUpXCIsIHBhcmFtcy5xdWVzdGlvbnMpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBEZWxlZ2F0ZSB0byBzaGFyZWQgaW50ZXJ2aWV3IFVJXG5cdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBzaG93SW50ZXJ2aWV3Um91bmQocGFyYW1zLnF1ZXN0aW9ucywge30sIGN0eCBhcyBhbnkpO1xuXG5cdFx0XHQvLyBSUEMgbW9kZSBmYWxsYmFjazogY3VzdG9tKCkgcmV0dXJucyB1bmRlZmluZWQsIHNvIHNob3dJbnRlcnZpZXdSb3VuZFxuXHRcdFx0Ly8gbWF5IHJldHVybiB1bmRlZmluZWQuIEZhbGwgYmFjayB0byBzZXF1ZW50aWFsIGN0eC51aS5zZWxlY3QoKSBjYWxscy5cblx0XHRcdGlmICghcmVzdWx0KSB7XG5cdFx0XHRcdGNvbnN0IGFuc3dlcnM6IFJlY29yZDxzdHJpbmcsIHsgYW5zd2Vyczogc3RyaW5nW10gfT4gPSB7fTtcblx0XHRcdFx0Zm9yIChjb25zdCBxIG9mIHBhcmFtcy5xdWVzdGlvbnMpIHtcblx0XHRcdFx0XHRjb25zdCBvcHRpb25zID0gcS5vcHRpb25zLm1hcCgobykgPT4gby5sYWJlbCk7XG5cdFx0XHRcdFx0aWYgKCFxLmFsbG93TXVsdGlwbGUpIHtcblx0XHRcdFx0XHRcdG9wdGlvbnMucHVzaChPVEhFUl9PUFRJT05fTEFCRUwpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRjb25zdCBzZWxlY3RlZCA9IGF3YWl0IGN0eC51aS5zZWxlY3QoXG5cdFx0XHRcdFx0XHRgJHtxLmhlYWRlcn06ICR7cS5xdWVzdGlvbn1gLFxuXHRcdFx0XHRcdFx0b3B0aW9ucyxcblx0XHRcdFx0XHRcdHsgc2lnbmFsLCAuLi4ocS5hbGxvd011bHRpcGxlID8geyBhbGxvd011bHRpcGxlOiB0cnVlIH0gOiB7fSkgfSxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdGlmIChzZWxlY3RlZCA9PT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4gZXJyb3JSZXN1bHQoXCJhc2tfdXNlcl9xdWVzdGlvbnMgd2FzIGNhbmNlbGxlZFwiLCBwYXJhbXMucXVlc3Rpb25zKTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHQvLyBXaGVuIHRoZSB1c2VyIHBpY2tzIFwiTm9uZSBvZiB0aGUgYWJvdmVcIiBvbiBhIHNpbmdsZS1zZWxlY3Rcblx0XHRcdFx0XHQvLyBxdWVzdGlvbiwgcHJvbXB0IGZvciBhIGZyZWUtdGV4dCBleHBsYW5hdGlvbiBzbyB0aGV5IGFyZSBub3Rcblx0XHRcdFx0XHQvLyB0cmFwcGVkIGluIGEgcmUtYXNraW5nIGxvb3AgKGJ1ZyAjMjcxNSkuXG5cdFx0XHRcdFx0bGV0IGZyZWVUZXh0Tm90ZSA9IFwiXCI7XG5cdFx0XHRcdFx0Y29uc3Qgc2VsZWN0ZWRTdHIgPSBBcnJheS5pc0FycmF5KHNlbGVjdGVkKSA/IHNlbGVjdGVkWzBdIDogc2VsZWN0ZWQ7XG5cdFx0XHRcdFx0aWYgKCFxLmFsbG93TXVsdGlwbGUgJiYgc2VsZWN0ZWRTdHIgPT09IE9USEVSX09QVElPTl9MQUJFTCkge1xuXHRcdFx0XHRcdFx0Y29uc3Qgbm90ZSA9IGF3YWl0IGN0eC51aS5pbnB1dChcblx0XHRcdFx0XHRcdFx0YCR7cS5oZWFkZXJ9OiBQbGVhc2UgZXhwbGFpbiBpbiB5b3VyIG93biB3b3Jkc2AsXG5cdFx0XHRcdFx0XHRcdFwiVHlwZSB5b3VyIGFuc3dlciBoZXJlXHUyMDI2XCIsXG5cdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0aWYgKG5vdGUpIHtcblx0XHRcdFx0XHRcdFx0ZnJlZVRleHROb3RlID0gbm90ZTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjb25zdCBhbnN3ZXJMaXN0ID0gQXJyYXkuaXNBcnJheShzZWxlY3RlZCkgPyBzZWxlY3RlZCA6IFtzZWxlY3RlZF07XG5cdFx0XHRcdFx0aWYgKGZyZWVUZXh0Tm90ZSkge1xuXHRcdFx0XHRcdFx0YW5zd2VyTGlzdC5wdXNoKGB1c2VyX25vdGU6ICR7ZnJlZVRleHROb3RlfWApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRhbnN3ZXJzW3EuaWRdID0geyBhbnN3ZXJzOiBhbnN3ZXJMaXN0IH07XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3Qgcm91bmRSZXN1bHQ6IFJvdW5kUmVzdWx0ID0ge1xuXHRcdFx0XHRcdGVuZEludGVydmlldzogZmFsc2UsXG5cdFx0XHRcdFx0YW5zd2VyczogT2JqZWN0LmZyb21FbnRyaWVzKFxuXHRcdFx0XHRcdFx0T2JqZWN0LmVudHJpZXMoYW5zd2VycykubWFwKChbaWQsIGFdKSA9PiBbXG5cdFx0XHRcdFx0XHRcdGlkLFxuXHRcdFx0XHRcdFx0XHR7IHNlbGVjdGVkOiBhLmFuc3dlcnMubGVuZ3RoID09PSAxID8gYS5hbnN3ZXJzWzBdIDogYS5hbnN3ZXJzLCBub3RlczogXCJcIiB9LFxuXHRcdFx0XHRcdFx0XSksXG5cdFx0XHRcdFx0KSxcblx0XHRcdFx0fTtcblx0XHRcdFx0Y29uc3QgZmFsbGJhY2tSZXN1bHQgPSB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IEpTT04uc3RyaW5naWZ5KHsgYW5zd2VycyB9KSB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7XG5cdFx0XHRcdFx0XHRxdWVzdGlvbnM6IHBhcmFtcy5xdWVzdGlvbnMsXG5cdFx0XHRcdFx0XHRyZXNwb25zZTogcm91bmRSZXN1bHQsXG5cdFx0XHRcdFx0XHRjYW5jZWxsZWQ6IGZhbHNlLFxuXHRcdFx0XHRcdH0gc2F0aXNmaWVzIExvY2FsUmVzdWx0RGV0YWlscyxcblx0XHRcdFx0fTtcblx0XHRcdFx0dHVybkNhY2hlLnNldChzaWcsIGZhbGxiYWNrUmVzdWx0KTtcblx0XHRcdFx0cmV0dXJuIGZhbGxiYWNrUmVzdWx0O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBDaGVjayBpZiBjYW5jZWxsZWQgKGVtcHR5IGFuc3dlcnMgPSB1c2VyIGV4aXRlZClcblx0XHRcdGNvbnN0IGhhc0Fuc3dlcnMgPSBPYmplY3Qua2V5cyhyZXN1bHQuYW5zd2VycykubGVuZ3RoID4gMDtcblx0XHRcdGlmICghaGFzQW5zd2Vycykge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcImFza191c2VyX3F1ZXN0aW9ucyB3YXMgY2FuY2VsbGVkIGJlZm9yZSByZWNlaXZpbmcgYSByZXNwb25zZVwiIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHsgcXVlc3Rpb25zOiBwYXJhbXMucXVlc3Rpb25zLCByZXNwb25zZTogbnVsbCwgY2FuY2VsbGVkOiB0cnVlIH0gc2F0aXNmaWVzIExvY2FsUmVzdWx0RGV0YWlscyxcblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3Qgc3VjY2Vzc1Jlc3VsdCA9IHtcblx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGZvcm1hdEZvckxMTShyZXN1bHQpIH1dLFxuXHRcdFx0XHRkZXRhaWxzOiB7IHF1ZXN0aW9uczogcGFyYW1zLnF1ZXN0aW9ucywgcmVzcG9uc2U6IHJlc3VsdCwgY2FuY2VsbGVkOiBmYWxzZSB9IHNhdGlzZmllcyBMb2NhbFJlc3VsdERldGFpbHMsXG5cdFx0XHR9O1xuXHRcdFx0dHVybkNhY2hlLnNldChzaWcsIHN1Y2Nlc3NSZXN1bHQpO1xuXHRcdFx0cmV0dXJuIHN1Y2Nlc3NSZXN1bHQ7XG5cdFx0fSxcblxuXHRcdC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBSZW5kZXJpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cblx0XHRyZW5kZXJDYWxsKGFyZ3MsIHRoZW1lKSB7XG5cdFx0XHRjb25zdCBxcyA9IChhcmdzLnF1ZXN0aW9ucyBhcyBRdWVzdGlvbltdKSB8fCBbXTtcblx0XHRcdGxldCB0ZXh0ID0gdGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChcImFza191c2VyX3F1ZXN0aW9ucyBcIikpO1xuXHRcdFx0dGV4dCArPSB0aGVtZS5mZyhcIm11dGVkXCIsIGAke3FzLmxlbmd0aH0gcXVlc3Rpb24ke3FzLmxlbmd0aCAhPT0gMSA/IFwic1wiIDogXCJcIn1gKTtcblx0XHRcdGlmIChxcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdGNvbnN0IGhlYWRlcnMgPSBxcy5tYXAoKHEpID0+IHEuaGVhZGVyKS5qb2luKFwiLCBcIik7XG5cdFx0XHRcdHRleHQgKz0gdGhlbWUuZmcoXCJkaW1cIiwgYCAoJHtoZWFkZXJzfSlgKTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IHByZXZpZXdDb3VudCA9IHFzLnJlZHVjZShcblx0XHRcdFx0KGFjYywgcSkgPT4gYWNjICsgKHEub3B0aW9ucyB8fCBbXSkuZmlsdGVyKChvOiBRdWVzdGlvbk9wdGlvbikgPT4gby5wcmV2aWV3KS5sZW5ndGgsXG5cdFx0XHRcdDAsXG5cdFx0XHQpO1xuXHRcdFx0aWYgKHByZXZpZXdDb3VudCA+IDApIHtcblx0XHRcdFx0dGV4dCArPSB0aGVtZS5mZyhcImFjY2VudFwiLCBgIFske3ByZXZpZXdDb3VudH0gcHJldmlldyR7cHJldmlld0NvdW50ICE9PSAxID8gXCJzXCIgOiBcIlwifV1gKTtcblx0XHRcdH1cblx0XHRcdGZvciAoY29uc3QgcSBvZiBxcykge1xuXHRcdFx0XHRjb25zdCBtdWx0aVNlbCA9ICEhcS5hbGxvd011bHRpcGxlO1xuXHRcdFx0XHR0ZXh0ICs9IGBcXG4gICR7dGhlbWUuZmcoXCJ0ZXh0XCIsIHEucXVlc3Rpb24pfWA7XG5cdFx0XHRcdGNvbnN0IG9wdExhYmVscyA9IG11bHRpU2VsXG5cdFx0XHRcdFx0PyAocS5vcHRpb25zIHx8IFtdKS5tYXAoKG86IFF1ZXN0aW9uT3B0aW9uKSA9PiBvLmxhYmVsKVxuXHRcdFx0XHRcdDogWy4uLihxLm9wdGlvbnMgfHwgW10pLm1hcCgobzogUXVlc3Rpb25PcHRpb24pID0+IG8ubGFiZWwpLCBPVEhFUl9PUFRJT05fTEFCRUxdO1xuXHRcdFx0XHRjb25zdCBwcmVmaXggPSBtdWx0aVNlbCA/IFwiXHUyNjEwXCIgOiBcIlwiO1xuXHRcdFx0XHRjb25zdCBudW1iZXJlZCA9IG9wdExhYmVscy5tYXAoKGwsIGkpID0+IGAke3ByZWZpeH0ke2kgKyAxfS4gJHtsfWApLmpvaW4oXCIsIFwiKTtcblx0XHRcdFx0dGV4dCArPSBgXFxuICAke3RoZW1lLmZnKFwiZGltXCIsIG51bWJlcmVkKX1gO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuXHRcdH0sXG5cblx0XHRyZW5kZXJSZXN1bHQocmVzdWx0LCBfb3B0aW9ucywgdGhlbWUpIHtcblx0XHRcdGNvbnN0IGRldGFpbHMgPSByZXN1bHQuZGV0YWlscyBhcyBBc2tVc2VyUXVlc3Rpb25zRGV0YWlscyB8IHVuZGVmaW5lZDtcblx0XHRcdGlmICghZGV0YWlscykge1xuXHRcdFx0XHRjb25zdCB0ZXh0ID0gcmVzdWx0LmNvbnRlbnRbMF07XG5cdFx0XHRcdHJldHVybiBuZXcgVGV4dCh0ZXh0Py50eXBlID09PSBcInRleHRcIiA/IHRleHQudGV4dCA6IFwiXCIsIDAsIDApO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBSZW1vdGUgY2hhbm5lbCByZXN1bHQgKGRpc2NyaW1pbmF0ZWQgb24gZGV0YWlscy5yZW1vdGUgPT09IHRydWUpXG5cdFx0XHRpZiAoZGV0YWlscy5yZW1vdGUpIHtcblx0XHRcdFx0aWYgKGRldGFpbHMudGltZWRfb3V0KSB7XG5cdFx0XHRcdFx0cmV0dXJuIG5ldyBUZXh0KFxuXHRcdFx0XHRcdFx0YCR7dGhlbWUuZmcoXCJ3YXJuaW5nXCIsIGAke2RldGFpbHMuY2hhbm5lbH0gXHUyMDE0IHRpbWVkIG91dGApfSR7ZGV0YWlscy50aHJlYWRVcmwgPyB0aGVtZS5mZyhcImRpbVwiLCBgICR7ZGV0YWlscy50aHJlYWRVcmx9YCkgOiBcIlwifWAsXG5cdFx0XHRcdFx0XHQwLFxuXHRcdFx0XHRcdFx0MCxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgcXVlc3Rpb25zID0gKGRldGFpbHMucXVlc3Rpb25zID8/IFtdKSBhcyBRdWVzdGlvbltdO1xuXHRcdFx0XHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblx0XHRcdFx0bGluZXMucHVzaCh0aGVtZS5mZyhcImRpbVwiLCBkZXRhaWxzLmNoYW5uZWwpKTtcblx0XHRcdFx0aWYgKGRldGFpbHMucmVzcG9uc2UpIHtcblx0XHRcdFx0XHRmb3IgKGNvbnN0IHEgb2YgcXVlc3Rpb25zKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBhbnN3ZXIgPSBkZXRhaWxzLnJlc3BvbnNlLmFuc3dlcnNbcS5pZF07XG5cdFx0XHRcdFx0XHRpZiAoIWFuc3dlcikge1xuXHRcdFx0XHRcdFx0XHRsaW5lcy5wdXNoKGAke3RoZW1lLmZnKFwiYWNjZW50XCIsIHEuaGVhZGVyKX06ICR7dGhlbWUuZmcoXCJkaW1cIiwgXCIobm8gYW5zd2VyKVwiKX1gKTtcblx0XHRcdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRjb25zdCBzZWxlY3RlZCA9IGFuc3dlci5zZWxlY3RlZDtcblx0XHRcdFx0XHRcdGNvbnN0IGFuc3dlclRleHQgPSBBcnJheS5pc0FycmF5KHNlbGVjdGVkKVxuXHRcdFx0XHRcdFx0XHQ/IChzZWxlY3RlZC5sZW5ndGggPiAwID8gc2VsZWN0ZWQuam9pbihcIiwgXCIpIDogXCIoY3VzdG9tKVwiKVxuXHRcdFx0XHRcdFx0XHQ6IChzZWxlY3RlZCB8fCBcIihjdXN0b20pXCIpO1xuXHRcdFx0XHRcdFx0bGV0IGxpbmUgPSBgJHt0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgXCJcdTI3MTMgXCIpfSR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgcS5oZWFkZXIpfTogJHthbnN3ZXJUZXh0fWA7XG5cdFx0XHRcdFx0XHRpZiAoYW5zd2VyLm5vdGVzKSB7XG5cdFx0XHRcdFx0XHRcdGxpbmUgKz0gYCAke3RoZW1lLmZnKFwibXV0ZWRcIiwgYFtub3RlOiAke2Fuc3dlci5ub3Rlc31dYCl9YDtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGxpbmVzLnB1c2gobGluZSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiBuZXcgVGV4dChsaW5lcy5qb2luKFwiXFxuXCIpLCAwLCAwKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKGRldGFpbHMuY2FuY2VsbGVkIHx8ICFkZXRhaWxzLnJlc3BvbnNlKSB7XG5cdFx0XHRcdHJldHVybiBuZXcgVGV4dCh0aGVtZS5mZyhcIndhcm5pbmdcIiwgXCJDYW5jZWxsZWRcIiksIDAsIDApO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblx0XHRcdGZvciAoY29uc3QgcSBvZiBkZXRhaWxzLnF1ZXN0aW9ucykge1xuXHRcdFx0XHRjb25zdCBhbnN3ZXIgPSAoZGV0YWlscy5yZXNwb25zZSBhcyBSb3VuZFJlc3VsdCkuYW5zd2Vyc1txLmlkXTtcblx0XHRcdFx0aWYgKCFhbnN3ZXIpIHtcblx0XHRcdFx0XHRsaW5lcy5wdXNoKGAke3RoZW1lLmZnKFwiYWNjZW50XCIsIHEuaGVhZGVyKX06ICR7dGhlbWUuZmcoXCJkaW1cIiwgXCIobm8gYW5zd2VyKVwiKX1gKTtcblx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBzZWxlY3RlZCA9IGFuc3dlci5zZWxlY3RlZDtcblx0XHRcdFx0Y29uc3Qgbm90ZXMgPSBhbnN3ZXIubm90ZXM7XG5cdFx0XHRcdGNvbnN0IG11bHRpU2VsID0gISFxLmFsbG93TXVsdGlwbGU7XG5cdFx0XHRcdGNvbnN0IGFuc3dlclRleHQgPSBtdWx0aVNlbCAmJiBBcnJheS5pc0FycmF5KHNlbGVjdGVkKVxuXHRcdFx0XHRcdD8gc2VsZWN0ZWQuam9pbihcIiwgXCIpXG5cdFx0XHRcdFx0OiAoQXJyYXkuaXNBcnJheShzZWxlY3RlZCkgPyBzZWxlY3RlZFswXSA6IHNlbGVjdGVkKSA/PyBcIihubyBhbnN3ZXIpXCI7XG5cdFx0XHRcdGxldCBsaW5lID0gYCR7dGhlbWUuZmcoXCJzdWNjZXNzXCIsIFwiXHUyNzEzIFwiKX0ke3RoZW1lLmZnKFwiYWNjZW50XCIsIHEuaGVhZGVyKX06ICR7YW5zd2VyVGV4dH1gO1xuXHRcdFx0XHRpZiAobm90ZXMpIHtcblx0XHRcdFx0XHRsaW5lICs9IGAgJHt0aGVtZS5mZyhcIm11dGVkXCIsIGBbbm90ZTogJHtub3Rlc31dYCl9YDtcblx0XHRcdFx0fVxuXHRcdFx0XHRsaW5lcy5wdXNoKGxpbmUpO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIG5ldyBUZXh0KGxpbmVzLmpvaW4oXCJcXG5cIiksIDAsIDApO1xuXHRcdH0sXG5cdH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBWUEsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsWUFBWTtBQUNyQjtBQUFBLEVBQ0M7QUFBQSxPQUlNO0FBMkJQLE1BQU0sZUFBZSxLQUFLLE9BQU87QUFBQSxFQUNoQyxPQUFPLEtBQUssT0FBTyxFQUFFLGFBQWEsZ0NBQWdDLENBQUM7QUFBQSxFQUNuRSxhQUFhLEtBQUssT0FBTyxFQUFFLGFBQWEsNERBQTRELENBQUM7QUFBQSxFQUNyRyxTQUFTLEtBQUs7QUFBQSxJ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
