import { getMarkdownTheme } from "@gsd/pi-coding-agent";
import {
  Editor,
  Key,
  Markdown,
  matchesKey,
  truncateToWidth
} from "@gsd/pi-tui";
import { mergeSideBySide } from "./layout-utils.js";
import { makeUI, INDENT } from "./ui.js";
const OTHER_OPTION_LABEL = "None of the above";
const OTHER_OPTION_DESCRIPTION = "Select to type your own answer.";
const MIN_PREVIEW_WIDTH = 30;
const MIN_OPTIONS_WIDTH = 30;
const PREVIEW_RATIO = 0.6;
const DIVIDER_CHARS = " \u2502 ";
const DIVIDER_WIDTH = 3;
const PREVIEW_MAX_LINES = 20;
async function showWrapUpScreen(opts, ctx) {
  return ctx.ui.custom((tui, theme, _kb, done) => {
    let cursorIdx = 1;
    let cachedLines;
    function refresh() {
      cachedLines = void 0;
      tui.requestRender();
    }
    function handleInput(data) {
      if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
        cursorIdx = 1;
        refresh();
        return;
      }
      if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) {
        cursorIdx = 0;
        refresh();
        return;
      }
      if (data === "1") {
        done({ satisfied: true });
        return;
      }
      if (data === "2") {
        done({ satisfied: false });
        return;
      }
      if (matchesKey(data, Key.escape)) {
        done({ satisfied: false });
        return;
      }
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
        done({ satisfied: cursorIdx === 1 });
        return;
      }
    }
    function render(width) {
      if (cachedLines) return cachedLines;
      const ui = makeUI(theme, width);
      const lines = [];
      const push = (...rows) => {
        for (const r of rows) lines.push(...r);
      };
      push(ui.bar(), ui.blank(), ui.header(`  ${opts.headline}`), ui.blank());
      if (opts.progress) push(ui.meta(`  ${opts.progress}`), ui.blank());
      if (cursorIdx === 1) {
        push(ui.actionSelected(1, opts.satisfiedLabel, "Wrap up now and generate the output."));
      } else {
        push(ui.actionUnselected(1, opts.satisfiedLabel, "Wrap up now and generate the output."));
      }
      push(ui.blank());
      if (cursorIdx === 0) {
        push(ui.actionSelected(2, opts.keepGoingLabel, "Continue with another batch of questions."));
      } else {
        push(ui.actionUnselected(2, opts.keepGoingLabel, "Continue with another batch of questions."));
      }
      push(
        ui.blank(),
        ui.hints(["\u2191/\u2193 to choose", "1/2 to quick-select", "enter to confirm"]),
        ui.bar()
      );
      cachedLines = lines;
      return lines;
    }
    return {
      render,
      invalidate: () => {
        cachedLines = void 0;
      },
      handleInput
    };
  });
}
async function showInterviewRound(questions, opts, ctx) {
  return ctx.ui.custom((tui, theme, _kb, done) => {
    const states = questions.map(() => ({
      cursorIndex: 0,
      committedIndex: null,
      checkedIndices: /* @__PURE__ */ new Set(),
      notes: "",
      notesVisible: false
    }));
    const isMultiQuestion = questions.length > 1;
    let currentIdx = 0;
    let focusNotes = false;
    let showingReview = false;
    let showingExitConfirm = false;
    let exitCursor = 0;
    let cachedLines;
    let completed = false;
    let removeAbortListener;
    function finish(result) {
      if (completed) return;
      completed = true;
      removeAbortListener?.();
      done(result);
    }
    if (opts.signal) {
      const onAbort = () => finish({ endInterview: false, answers: {} });
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => opts.signal?.removeEventListener("abort", onAbort);
      }
    }
    const editorRef = { current: null };
    function getEditor() {
      if (!editorRef.current) {
        editorRef.current = new Editor(tui, makeUI(theme, 80).editorTheme);
      }
      return editorRef.current;
    }
    function refresh() {
      cachedLines = void 0;
      tui.requestRender();
    }
    function isMultiSelect(qIdx) {
      return !!questions[qIdx].allowMultiple;
    }
    function totalOpts(qIdx) {
      return questions[qIdx].options.length + 1;
    }
    function noneOrDoneIdx(qIdx) {
      return questions[qIdx].options.length;
    }
    function saveEditorToState() {
      states[currentIdx].notes = getEditor().getExpandedText().trim();
    }
    function loadStateToEditor() {
      getEditor().setText(states[currentIdx].notes);
    }
    function isQuestionAnswered(idx) {
      if (isMultiSelect(idx)) return states[idx].checkedIndices.size > 0;
      return states[idx].committedIndex !== null;
    }
    function allAnswered() {
      return questions.every((_, i) => isQuestionAnswered(i));
    }
    function switchQuestion(newIdx) {
      if (newIdx === currentIdx) return;
      saveEditorToState();
      currentIdx = newIdx;
      loadStateToEditor();
      focusNotes = states[currentIdx].notesVisible && states[currentIdx].notes.length > 0;
      refresh();
    }
    function buildResult() {
      const answers = {};
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const st = states[i];
        const notes = st.notes.trim();
        if (isMultiSelect(i)) {
          const sorted = Array.from(st.checkedIndices).sort((a, b) => a - b);
          const selected = sorted.map((idx) => q.options[idx].label);
          if (selected.length > 0 || notes) answers[q.id] = { selected, notes };
        } else {
          if (st.committedIndex === null && !notes) continue;
          let selected = OTHER_OPTION_LABEL;
          if (st.committedIndex !== null) {
            const idx = st.committedIndex;
            if (idx < q.options.length) selected = q.options[idx].label;
            else if (idx === noneOrDoneIdx(i)) selected = OTHER_OPTION_LABEL;
          }
          answers[q.id] = { selected, notes };
        }
      }
      return { endInterview: false, answers };
    }
    function submit() {
      saveEditorToState();
      finish(buildResult());
    }
    function goNextOrSubmit() {
      if (!isMultiSelect(currentIdx)) {
        states[currentIdx].committedIndex = states[currentIdx].cursorIndex;
      }
      if (!isMultiSelect(currentIdx) && states[currentIdx].cursorIndex === noneOrDoneIdx(currentIdx) && !states[currentIdx].notes && !states[currentIdx].notesVisible) {
        states[currentIdx].notesVisible = true;
        focusNotes = true;
        loadStateToEditor();
        refresh();
        return;
      }
      if (isMultiQuestion && currentIdx < questions.length - 1) {
        let next = currentIdx + 1;
        for (let i = 0; i < questions.length; i++) {
          const candidate = (currentIdx + 1 + i) % questions.length;
          if (!isQuestionAnswered(candidate)) {
            next = candidate;
            break;
          }
        }
        switchQuestion(next);
      } else if (allAnswered()) {
        saveEditorToState();
        showingReview = true;
        refresh();
      }
    }
    function handleInput(data) {
      if (showingExitConfirm) {
        if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
          exitCursor = 0;
          refresh();
          return;
        }
        if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) {
          exitCursor = 1;
          refresh();
          return;
        }
        if (data === "1") {
          showingExitConfirm = false;
          refresh();
          return;
        }
        if (data === "2") {
          finish({ endInterview: false, answers: {} });
          return;
        }
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
          if (exitCursor === 0) {
            showingExitConfirm = false;
            refresh();
          } else {
            finish({ endInterview: false, answers: {} });
          }
          return;
        }
        if (matchesKey(data, Key.escape)) {
          showingExitConfirm = false;
          refresh();
          return;
        }
        return;
      }
      if (showingReview) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
          showingReview = false;
          switchQuestion(questions.length - 1);
          return;
        }
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.right) || matchesKey(data, Key.space)) {
          submit();
          return;
        }
        return;
      }
      const st = states[currentIdx];
      const optCount = totalOpts(currentIdx);
      const multiSel = isMultiSelect(currentIdx);
      if (matchesKey(data, Key.escape)) {
        if (focusNotes) {
          saveEditorToState();
          focusNotes = false;
          st.notesVisible = st.notes.length > 0;
          refresh();
        } else {
          showingExitConfirm = true;
          exitCursor = 0;
          refresh();
        }
        return;
      }
      if (focusNotes) {
        if (matchesKey(data, Key.tab)) {
          saveEditorToState();
          focusNotes = false;
          st.notesVisible = st.notes.length > 0;
          refresh();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          saveEditorToState();
          focusNotes = false;
          if (!multiSel && st.committedIndex === null) st.committedIndex = noneOrDoneIdx(currentIdx);
          goNextOrSubmit();
          return;
        }
        getEditor().handleInput(data);
        refresh();
        return;
      }
      if (isMultiQuestion) {
        if (matchesKey(data, Key.left)) {
          switchQuestion((currentIdx - 1 + questions.length) % questions.length);
          return;
        }
        if (matchesKey(data, Key.right)) {
          switchQuestion((currentIdx + 1) % questions.length);
          return;
        }
      }
      if (matchesKey(data, Key.up)) {
        st.cursorIndex = (st.cursorIndex - 1 + optCount) % optCount;
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        st.cursorIndex = (st.cursorIndex + 1) % optCount;
        refresh();
        return;
      }
      if (multiSel) {
        const doneI = noneOrDoneIdx(currentIdx);
        if (matchesKey(data, Key.space)) {
          if (st.cursorIndex < doneI) {
            if (st.checkedIndices.has(st.cursorIndex)) st.checkedIndices.delete(st.cursorIndex);
            else st.checkedIndices.add(st.cursorIndex);
            refresh();
          }
          return;
        }
        if (matchesKey(data, Key.enter)) {
          goNextOrSubmit();
          return;
        }
        if (matchesKey(data, Key.tab)) {
          st.notesVisible = true;
          focusNotes = true;
          loadStateToEditor();
          refresh();
          return;
        }
      } else {
        if (data.length === 1 && data >= "1" && data <= "9") {
          const idx = parseInt(data, 10) - 1;
          if (idx < optCount) {
            st.cursorIndex = idx;
            st.committedIndex = idx;
            goNextOrSubmit();
            return;
          }
        }
        if (matchesKey(data, Key.space)) {
          st.committedIndex = st.cursorIndex;
          refresh();
          return;
        }
        if (matchesKey(data, Key.tab)) {
          st.notesVisible = true;
          focusNotes = true;
          loadStateToEditor();
          refresh();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          goNextOrSubmit();
          return;
        }
      }
    }
    function renderReviewScreen(width) {
      const ui = makeUI(theme, width);
      const lines = [];
      const push = (...rows) => {
        for (const r of rows) lines.push(...r);
      };
      push(ui.bar(), ui.blank(), ui.header(`  ${opts.reviewHeadline ?? "Review your answers"}`), ui.blank());
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const st = states[i];
        push(ui.subtitle(`  ${q.question}`));
        if (isMultiSelect(i)) {
          const selected = Array.from(st.checkedIndices).sort((a, b) => a - b).map((idx) => q.options[idx].label);
          for (const label of selected) push(ui.answer(`    ${INDENT.cursor}${label}`));
        } else {
          let label = OTHER_OPTION_LABEL;
          if (st.committedIndex !== null && st.committedIndex < q.options.length) {
            label = q.options[st.committedIndex].label;
          }
          push(ui.answer(`    ${INDENT.cursor}${label}`));
        }
        if (st.notes) push(ui.note(`${INDENT.note}note: ${st.notes}`));
        push(ui.blank());
      }
      push(
        ui.actionSelected(0, "Submit answers"),
        ui.blank(),
        ui.hints(["\u2190 to go back and edit", "enter to submit", `esc to ${opts.exitLabel ?? "end interview"}`]),
        ui.bar()
      );
      return lines;
    }
    function renderExitConfirm(width) {
      const ui = makeUI(theme, width);
      const lines = [];
      const push = (...rows) => {
        for (const r of rows) lines.push(...r);
      };
      push(
        ui.bar(),
        ui.blank(),
        ui.header(`  ${opts.exitHeadline ?? "End interview?"}`),
        ui.blank(),
        ui.subtitle("  Answers from this batch won't be saved."),
        ui.blank()
      );
      const keepGoingLabel = "Keep going";
      const exitActionLabel = opts.exitLabel ? opts.exitLabel.charAt(0).toUpperCase() + opts.exitLabel.slice(1) : "End interview";
      if (exitCursor === 0) {
        push(ui.actionSelected(1, keepGoingLabel, "Return and keep going."));
      } else {
        push(ui.actionUnselected(1, keepGoingLabel, "Return and keep going."));
      }
      push(ui.blank());
      if (exitCursor === 1) {
        push(ui.actionSelected(2, exitActionLabel, "Exit and discard this batch of answers."));
      } else {
        push(ui.actionUnselected(2, exitActionLabel, "Exit and discard this batch of answers."));
      }
      push(
        ui.blank(),
        ui.hints(["\u2191/\u2193 to choose", "1/2 to quick-select", "enter to confirm"]),
        ui.bar()
      );
      return lines;
    }
    let mdThemeCache = null;
    let previewCache = null;
    function questionHasAnyPreview() {
      return questions[currentIdx].options.some(
        (o) => o.preview != null && o.preview.trim().length > 0
      );
    }
    function getCurrentPreview() {
      const q = questions[currentIdx];
      const idx = states[currentIdx].cursorIndex;
      if (idx < q.options.length) {
        const preview = q.options[idx].preview;
        return preview && preview.trim().length > 0 ? preview : null;
      }
      return null;
    }
    function renderOptionsColumn(optWidth) {
      const ui = makeUI(theme, optWidth);
      const col = [];
      const push = (...rows) => {
        for (const r of rows) col.push(...r);
      };
      const q = questions[currentIdx];
      const st = states[currentIdx];
      const multiSel = isMultiSelect(currentIdx);
      push(ui.question(` ${q.question}`));
      if (multiSel) push(ui.meta("  (Select all that apply)"));
      push(ui.blank());
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        const isCursor = i === st.cursorIndex;
        if (multiSel) {
          const isChecked = st.checkedIndices.has(i);
          if (isCursor && !focusNotes) push(ui.checkboxSelected(opt.label, opt.description, isChecked));
          else push(ui.checkboxUnselected(opt.label, opt.description, isChecked, focusNotes));
        } else {
          const isCommitted = i === st.committedIndex;
          if (isCursor && !focusNotes) {
            push(ui.optionSelected(i + 1, opt.label, opt.description, isCommitted));
          } else {
            push(ui.optionUnselected(i + 1, opt.label, opt.description, { isCommitted, isFocusDimmed: focusNotes }));
          }
        }
      }
      const ndIdx = noneOrDoneIdx(currentIdx);
      const ndCursor = ndIdx === st.cursorIndex;
      if (multiSel) {
        push(ui.blank());
        if (ndCursor && !focusNotes) push(ui.doneSelected());
        else push(ui.doneUnselected());
      } else {
        const ndCommitted = ndIdx === st.committedIndex;
        if (ndCursor && !focusNotes) {
          push(ui.slotSelected(OTHER_OPTION_LABEL, OTHER_OPTION_DESCRIPTION, ndCommitted));
        } else {
          push(ui.slotUnselected(OTHER_OPTION_LABEL, OTHER_OPTION_DESCRIPTION, { isCommitted: ndCommitted, isFocusDimmed: focusNotes }));
        }
      }
      if (st.notesVisible || focusNotes) {
        push(ui.blank(), ui.notesLabel(focusNotes));
        if (focusNotes) {
          for (const line of getEditor().render(optWidth - 2)) col.push(truncateToWidth(` ${line}`, optWidth));
        } else if (st.notes) {
          push(ui.notesText(st.notes));
        }
      }
      return col;
    }
    function renderPreviewColumn(markdown, previewWidth) {
      if (previewCache && previewCache.markdown === markdown && previewCache.width === previewWidth) {
        return previewCache.lines;
      }
      if (!mdThemeCache) mdThemeCache = getMarkdownTheme();
      const header = [
        truncateToWidth(theme.fg("accent", theme.bold(" Preview")), previewWidth),
        truncateToWidth(theme.fg("dim", " " + "\u2500".repeat(Math.max(0, previewWidth - 2))), previewWidth)
      ];
      const md = new Markdown(markdown, 1, 0, mdThemeCache);
      const lines = [...header, ...md.render(previewWidth)];
      previewCache = { markdown, width: previewWidth, lines };
      return lines;
    }
    function render(width) {
      if (cachedLines) return cachedLines;
      if (showingExitConfirm) {
        cachedLines = renderExitConfirm(width);
        return cachedLines;
      }
      if (showingReview) {
        cachedLines = renderReviewScreen(width);
        return cachedLines;
      }
      const useSideBySide = questionHasAnyPreview() && width >= MIN_OPTIONS_WIDTH + MIN_PREVIEW_WIDTH + DIVIDER_WIDTH;
      if (useSideBySide) {
        const ui2 = makeUI(theme, width);
        const lines2 = [];
        const push2 = (...rows) => {
          for (const r of rows) lines2.push(...r);
        };
        push2(ui2.bar());
        if (isMultiQuestion) {
          const unanswered = questions.filter((_, i) => !isQuestionAnswered(i)).length;
          const answeredSet = new Set(questions.map((_, i) => i).filter((i) => isQuestionAnswered(i)));
          push2(ui2.questionTabs(questions.map((q2) => q2.header), currentIdx, answeredSet));
          push2(ui2.blank());
          const progressParts = [
            opts.progress,
            `Question ${currentIdx + 1}/${questions.length}`,
            unanswered > 0 ? `${unanswered} unanswered` : null
          ].filter(Boolean).join("  \u2022  ");
          if (progressParts) push2(ui2.meta(`  ${progressParts}`));
          push2(ui2.blank());
        } else {
          if (opts.progress) push2(ui2.meta(`  ${opts.progress}`), ui2.blank());
        }
        const termRows = typeof process !== "undefined" && process.stdout?.rows || 24;
        const footerLines = 3;
        const tuiChrome = 5;
        const maxBody = Math.min(PREVIEW_MAX_LINES, Math.max(6, termRows - lines2.length - footerLines - tuiChrome));
        const previewWidth = Math.max(MIN_PREVIEW_WIDTH, Math.floor(width * PREVIEW_RATIO));
        const leftWidth = Math.max(MIN_OPTIONS_WIDTH, width - previewWidth - DIVIDER_WIDTH);
        const fullLeft = renderOptionsColumn(leftWidth);
        const leftLines = fullLeft.slice(0, maxBody);
        if (fullLeft.length > maxBody) {
          const n = fullLeft.length - maxBody + 1;
          const lbl = `+${n} lines hidden`;
          const d = "\u2500".repeat(Math.max(0, Math.floor((leftWidth - lbl.length - 2) / 2)));
          leftLines[maxBody - 1] = truncateToWidth(theme.fg("dim", ` ${d} ${lbl} ${d}`), leftWidth);
        }
        const preview = getCurrentPreview();
        const fullRight = preview ? renderPreviewColumn(preview, previewWidth) : [];
        const rightLines = fullRight.slice(0, maxBody);
        if (fullRight.length > maxBody) {
          const n = fullRight.length - maxBody + 1;
          const lbl = `+${n} lines hidden`;
          const d = "\u2500".repeat(Math.max(0, Math.floor((previewWidth - lbl.length - 2) / 2)));
          rightLines[maxBody - 1] = truncateToWidth(theme.fg("dim", ` ${d} ${lbl} ${d}`), previewWidth);
        }
        while (leftLines.length < maxBody) leftLines.push("");
        while (rightLines.length < maxBody) rightLines.push("");
        const divider = theme.fg("dim", DIVIDER_CHARS);
        lines2.push(...mergeSideBySide(leftLines, rightLines, leftWidth, divider, width));
        push2(ui2.blank());
        const isLast2 = !isMultiQuestion || currentIdx === questions.length - 1;
        const hints2 = [];
        if (focusNotes) {
          hints2.push("enter to confirm");
          hints2.push("tab or esc to close notes");
        } else if (isMultiSelect(currentIdx)) {
          hints2.push("space to toggle");
          if (isMultiQuestion) hints2.push("\u2190/\u2192 navigate questions");
          hints2.push("tab to add notes");
          hints2.push(isLast2 && allAnswered() ? "enter to review" : "enter to next");
        } else {
          hints2.push("tab to add notes");
          if (isMultiQuestion) hints2.push("\u2190/\u2192 navigate");
          hints2.push(isLast2 && allAnswered() ? "enter to review" : "enter to next");
        }
        hints2.push("esc to exit");
        push2(ui2.hints(hints2), ui2.bar());
        cachedLines = lines2;
        return lines2;
      }
      const ui = makeUI(theme, width);
      const lines = [];
      const push = (...rows) => {
        for (const r of rows) lines.push(...r);
      };
      const q = questions[currentIdx];
      const st = states[currentIdx];
      const multiSel = isMultiSelect(currentIdx);
      push(ui.bar());
      if (isMultiQuestion) {
        const unanswered = questions.filter((_, i) => !isQuestionAnswered(i)).length;
        const answeredSet = new Set(questions.map((_, i) => i).filter((i) => isQuestionAnswered(i)));
        push(ui.questionTabs(questions.map((q2) => q2.header), currentIdx, answeredSet));
        push(ui.blank());
        const progressParts = [
          opts.progress,
          `Question ${currentIdx + 1}/${questions.length}`,
          unanswered > 0 ? `${unanswered} unanswered` : null
        ].filter(Boolean).join("  \u2022  ");
        if (progressParts) push(ui.meta(`  ${progressParts}`));
        push(ui.blank());
      } else {
        if (opts.progress) push(ui.meta(`  ${opts.progress}`), ui.blank());
      }
      push(ui.question(` ${q.question}`));
      if (multiSel) push(ui.meta("  (Select all that apply)"));
      push(ui.blank());
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        const isCursor = i === st.cursorIndex;
        if (multiSel) {
          const isChecked = st.checkedIndices.has(i);
          if (isCursor && !focusNotes) push(ui.checkboxSelected(opt.label, opt.description, isChecked));
          else push(ui.checkboxUnselected(opt.label, opt.description, isChecked, focusNotes));
        } else {
          const isCommitted = i === st.committedIndex;
          if (isCursor && !focusNotes) {
            push(ui.optionSelected(i + 1, opt.label, opt.description, isCommitted));
          } else {
            push(ui.optionUnselected(i + 1, opt.label, opt.description, { isCommitted, isFocusDimmed: focusNotes }));
          }
        }
      }
      const ndIdx = noneOrDoneIdx(currentIdx);
      const ndCursor = ndIdx === st.cursorIndex;
      if (multiSel) {
        push(ui.blank());
        if (ndCursor && !focusNotes) push(ui.doneSelected());
        else push(ui.doneUnselected());
      } else {
        const ndCommitted = ndIdx === st.committedIndex;
        if (ndCursor && !focusNotes) {
          push(ui.slotSelected(OTHER_OPTION_LABEL, OTHER_OPTION_DESCRIPTION, ndCommitted));
        } else {
          push(ui.slotUnselected(OTHER_OPTION_LABEL, OTHER_OPTION_DESCRIPTION, { isCommitted: ndCommitted, isFocusDimmed: focusNotes }));
        }
      }
      if (st.notesVisible || focusNotes) {
        push(ui.blank(), ui.notesLabel(focusNotes));
        if (focusNotes) {
          for (const line of getEditor().render(width - 2)) lines.push(truncateToWidth(` ${line}`, width));
        } else if (st.notes) {
          push(ui.notesText(st.notes));
        }
      }
      push(ui.blank());
      const isLast = !isMultiQuestion || currentIdx === questions.length - 1;
      const hints = [];
      if (focusNotes) {
        hints.push("enter to confirm");
        hints.push("tab or esc to close notes");
      } else if (multiSel) {
        hints.push("space to toggle");
        if (isMultiQuestion) hints.push("\u2190/\u2192 navigate questions");
        hints.push("tab to add notes");
        hints.push(isLast && allAnswered() ? "enter to review" : "enter to next");
      } else {
        hints.push("tab to add notes");
        if (isMultiQuestion) hints.push("\u2190/\u2192 navigate");
        hints.push(isLast && allAnswered() ? "enter to review" : "enter to next");
      }
      hints.push("esc to exit");
      push(ui.hints(hints), ui.bar());
      cachedLines = lines;
      return lines;
    }
    return {
      render,
      invalidate: () => {
        cachedLines = void 0;
      },
      handleInput
    };
  });
}
export {
  showInterviewRound,
  showWrapUpScreen
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3NoYXJlZC9pbnRlcnZpZXctdWkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRDIgXHUyMDE0IFNoYXJlZCBpbnRlcnZpZXcgcm91bmQgVUkgd2lkZ2V0XG4vKipcbiAqIFNoYXJlZCBpbnRlcnZpZXcgcm91bmQgVUkgd2lkZ2V0LlxuICpcbiAqIFVzZWQgYnkgL2ludGVydmlldy1tZSBhbmQgL2dzZC1uZXctcHJvamVjdC5cbiAqXG4gKiBSZW5kZXJzIGEgcGFnZWQsIGtleWJvYXJkLWRyaXZlbiBxdWVzdGlvbiBVSSB3aXRoOlxuICogLSBTaW5nbGUtc2VsZWN0IChyYWRpbykgcXVlc3Rpb25zXG4gKiAtIE11bHRpLXNlbGVjdCAoY2hlY2tib3gpIHF1ZXN0aW9ucyB2aWEgYWxsb3dNdWx0aXBsZTogdHJ1ZVxuICogLSBPcHRpb25hbCBub3RlcyBmaWVsZCAoVGFiIHRvIG9wZW4pXG4gKiAtIFJldmlldyBzY3JlZW4gYmVmb3JlIHN1Ym1pdHRpbmcgXHUyMDE0IHNob3dzIGFsbCBhbnN3ZXJzLCBzaW5nbGUgc3VibWl0IGJ1dHRvblxuICogLSBFeGl0IGNvbmZpcm1hdGlvbiBvbiBFc2MgXHUyMDE0IFwiRW5kIGludGVydmlldz9cIiB3aXRoIGtlZXAtZ29pbmcgYXMgZGVmYXVsdFxuICogLSBmb2N1c05vdGVzIGRpbW1pbmc6IGNoZWNrZWQvY29tbWl0dGVkIGl0ZW1zIHN0YXkgdmlzaWJsZSwgb3RoZXJzIGRpbVxuICpcbiAqIE5hdmlnYXRpb246XG4gKiAgIFx1MjE5MC9cdTIxOTIgICAgICAgICAgbW92ZSBiZXR3ZWVuIHF1ZXN0aW9uc1xuICogICBcdTIxOTEvXHUyMTkzICAgICAgICAgIG1vdmUgY3Vyc29yIHdpdGhpbiBhIHF1ZXN0aW9uJ3Mgb3B0aW9uc1xuICogICBFbnRlci9TcGFjZSAgY29tbWl0IHNlbGVjdGlvbiBhbmQgYWR2YW5jZVxuICogICBUYWIgICAgICAgICAgb3Blbi9jbG9zZSBub3RlcyBmaWVsZFxuICogICBFc2MgICAgICAgICAgZXhpdCBjb25maXJtYXRpb24gb3ZlcmxheSAoa2VlcC1nb2luZyBpcyBkZWZhdWx0KVxuICpcbiAqIE9uIGxhc3QgcXVlc3Rpb24sIEVudGVyIGFkdmFuY2VzIHRvIGEgcmV2aWV3IHNjcmVlbiBpbnN0ZWFkIG9mIHN1Ym1pdHRpbmcgZGlyZWN0bHkuXG4gKiBGcm9tIHRoZSByZXZpZXcgc2NyZWVuOlxuICogICBcdTIxOTAgICAgICAgICAgICBiYWNrIHRvIGxhc3QgcXVlc3Rpb25cbiAqICAgRW50ZXIgLyBcdTIxOTIgICAgc3VibWl0IGFsbCBhbnN3ZXJzXG4gKiAgIEVzYyAgICAgICAgICBleGl0IGNvbmZpcm1hdGlvblxuICovXG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IGdldE1hcmtkb3duVGhlbWUsIHR5cGUgVGhlbWUgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7XG5cdEVkaXRvcixcblx0S2V5LFxuXHRNYXJrZG93bixcblx0bWF0Y2hlc0tleSxcblx0dHJ1bmNhdGVUb1dpZHRoLFxuXHR0eXBlIFRVSSxcbn0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5pbXBvcnQgeyBtZXJnZVNpZGVCeVNpZGUgfSBmcm9tIFwiLi9sYXlvdXQtdXRpbHMuanNcIjtcbmltcG9ydCB7IG1ha2VVSSwgSU5ERU5UIH0gZnJvbSBcIi4vdWkuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEV4cG9ydGVkIHR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIFF1ZXN0aW9uT3B0aW9uIHtcblx0bGFiZWw6IHN0cmluZztcblx0ZGVzY3JpcHRpb246IHN0cmluZztcblx0LyoqIE9wdGlvbmFsIG1hcmtkb3duIGNvbnRlbnQgc2hvd24gaW4gYSBzaWRlLWJ5LXNpZGUgcHJldmlldyBwYW5lbCB3aGVuIHRoaXMgb3B0aW9uIGlzIGhpZ2hsaWdodGVkLiAqL1xuXHRwcmV2aWV3Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFF1ZXN0aW9uIHtcblx0aWQ6IHN0cmluZztcblx0aGVhZGVyOiBzdHJpbmc7XG5cdHF1ZXN0aW9uOiBzdHJpbmc7XG5cdG9wdGlvbnM6IFF1ZXN0aW9uT3B0aW9uW107XG5cdC8qKiBJZiB0cnVlLCB1c2VyIGNhbiB0b2dnbGUgbXVsdGlwbGUgb3B0aW9ucyB3aXRoIFNQQUNFLCBjb25maXJtIHdpdGggRU5URVIgKi9cblx0YWxsb3dNdWx0aXBsZT86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUm91bmRSZXN1bHQge1xuXHQvKiogQWx3YXlzIGZhbHNlIFx1MjAxNCBlbmQgaXMgaGFuZGxlZCBieSBzaG93V3JhcFVwU2NyZWVuLCBub3QgcGVyLXF1ZXN0aW9uICovXG5cdGVuZEludGVydmlldzogZmFsc2U7XG5cdGFuc3dlcnM6IFJlY29yZDxzdHJpbmcsIHsgc2VsZWN0ZWQ6IHN0cmluZyB8IHN0cmluZ1tdOyBub3Rlczogc3RyaW5nIH0+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdyYXBVcFJlc3VsdCB7XG5cdC8qKiB0cnVlID0gd3JhcCB1cCBhbmQgd3JpdGUgZmlsZSwgZmFsc2UgPSBrZWVwIGdvaW5nICovXG5cdHNhdGlzZmllZDogYm9vbGVhbjtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE9wdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgSW50ZXJ2aWV3Um91bmRPcHRpb25zIHtcblx0LyoqXG5cdCAqIE9wdGlvbmFsIHByb2dyZXNzIHN0cmluZyBzaG93biBpbiB0aGUgaGVhZGVyIFx1MjAxNCBlLmcuIFwiQmF0Y2ggMi8zICBcdTIwMjIgIDEyIGFza2VkXCIuXG5cdCAqIENhbGxlciBmb3JtYXRzIGl0IGhvd2V2ZXIgbWFrZXMgc2Vuc2UgZm9yIHRoZWlyIGNvbnRleHQuXG5cdCAqIElmIG9taXR0ZWQsIG5vIHByb2dyZXNzIGxpbmUgaXMgc2hvd24uXG5cdCAqL1xuXHRwcm9ncmVzcz86IHN0cmluZztcblx0LyoqXG5cdCAqIExhYmVsIGZvciB0aGUgcmV2aWV3IHNjcmVlbiBoZWFkZXIuIERlZmF1bHRzIHRvIFwiUmV2aWV3IHlvdXIgYW5zd2Vyc1wiLlxuXHQgKi9cblx0cmV2aWV3SGVhZGxpbmU/OiBzdHJpbmc7XG5cdC8qKlxuXHQgKiBMYWJlbCBmb3IgdGhlIEVzYy1jb25maXJtIG92ZXJsYXkgaGVhZGVyLiBEZWZhdWx0cyB0byBcIkVuZCBpbnRlcnZpZXc/XCIuXG5cdCAqL1xuXHRleGl0SGVhZGxpbmU/OiBzdHJpbmc7XG5cdC8qKlxuXHQgKiBPcHRpb25hbCBBYm9ydFNpZ25hbCB0byBjYW5jZWwgdGhlIGludGVydmlldyBleHRlcm5hbGx5IChlLmcuIHdoZW4gcmFjaW5nXG5cdCAqIGFnYWluc3QgYSByZW1vdGUgcXVlc3Rpb24gY2hhbm5lbCkuIFdoZW4gYWJvcnRlZCwgdGhlIFRVSSBjbG9zZXMgYW5kIHRoZVxuXHQgKiBwcm9taXNlIHJlc29sdmVzIHdpdGggYW4gZW1wdHkgYW5zd2VycyBvYmplY3QuXG5cdCAqL1xuXHRzaWduYWw/OiBBYm9ydFNpZ25hbDtcblx0LyoqXG5cdCAqIFRleHQgZm9yIHRoZSBcImV4aXRcIiBoaW50IHNob3duIGluIHRoZSByZXZpZXcgc2NyZWVuIGZvb3RlciBhbmQgZXhpdCBjb25maXJtIG92ZXJsYXkuXG5cdCAqIERlZmF1bHRzIHRvIFwiZW5kIGludGVydmlld1wiLlxuXHQgKi9cblx0ZXhpdExhYmVsPzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdyYXBVcE9wdGlvbnMge1xuXHQvKipcblx0ICogT3B0aW9uYWwgcHJvZ3Jlc3Mgc3RyaW5nIHNob3duIGJlbG93IHRoZSBoZWFkbGluZSBcdTIwMTQgZS5nLiBcIjEyIHF1ZXN0aW9ucyBhbnN3ZXJlZCBzbyBmYXJcIi5cblx0ICogQ2FsbGVyIGZvcm1hdHMgaXQgaG93ZXZlciBtYWtlcyBzZW5zZSBmb3IgdGhlaXIgY29udGV4dC5cblx0ICogSWYgb21pdHRlZCwgbm8gcHJvZ3Jlc3MgbGluZSBpcyBzaG93bi5cblx0ICovXG5cdHByb2dyZXNzPzogc3RyaW5nO1xuXHQvKiogQ2FsbGVyLXNwZWNpZmljIHRleHQgZm9yIHRoZSB3cmFwLXVwIHNjcmVlbiBoZWFkbGluZSAqL1xuXHRoZWFkbGluZTogc3RyaW5nO1xuXHQvKiogTGFiZWwgZm9yIHRoZSBcImtlZXAgZ29pbmdcIiBvcHRpb24gKHNob3duIGZpcnN0IFx1MjAxNCBzYWZlIGRlZmF1bHQpICovXG5cdGtlZXBHb2luZ0xhYmVsOiBzdHJpbmc7XG5cdC8qKiBMYWJlbCBmb3IgdGhlIFwiSSdtIHNhdGlzZmllZFwiIG9wdGlvbiAoc2hvd24gc2Vjb25kKSAqL1xuXHRzYXRpc2ZpZWRMYWJlbDogc3RyaW5nO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ29uc3RhbnRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBPVEhFUl9PUFRJT05fTEFCRUwgPSBcIk5vbmUgb2YgdGhlIGFib3ZlXCI7XG5jb25zdCBPVEhFUl9PUFRJT05fREVTQ1JJUFRJT04gPSBcIlNlbGVjdCB0byB0eXBlIHlvdXIgb3duIGFuc3dlci5cIjtcblxuLy8gUHJldmlldyBsYXlvdXQgY29uc3RhbnRzXG5jb25zdCBNSU5fUFJFVklFV19XSURUSCA9IDMwO1xuY29uc3QgTUlOX09QVElPTlNfV0lEVEggPSAzMDtcbmNvbnN0IFBSRVZJRVdfUkFUSU8gPSAwLjYwOyAgICAgICAvLyBwcmV2aWV3IGdldHMgdGhlIG1ham9yaXR5IG9mIHRoZSB3aWR0aFxuY29uc3QgRElWSURFUl9DSEFSUyA9IFwiIFx1MjUwMiBcIjtcbmNvbnN0IERJVklERVJfV0lEVEggPSAzO1xuY29uc3QgUFJFVklFV19NQVhfTElORVMgPSAyMDsgICAgIC8vIGhhcmQgY2FwIFx1MjAxNCBrZWVwcyB0b3RhbCBcdTIyNjQgMjQgcm93cyBmb3Igc2luZ2xlLXF1ZXN0aW9uXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBXcmFwLXVwIHNjcmVlbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNob3dXcmFwVXBTY3JlZW4oXG5cdG9wdHM6IFdyYXBVcE9wdGlvbnMsXG5cdGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4pOiBQcm9taXNlPFdyYXBVcFJlc3VsdD4ge1xuXHRyZXR1cm4gY3R4LnVpLmN1c3RvbTxXcmFwVXBSZXN1bHQ+KCh0dWk6IFRVSSwgdGhlbWU6IFRoZW1lLCBfa2IsIGRvbmUpID0+IHtcblx0XHQvLyAwID0gXCJLZWVwIGdvaW5nXCIsIDEgPSBcIkknbSBzYXRpc2ZpZWRcIiBcdTIwMTQgZGVmYXVsdCB0byBzYXRpc2ZpZWQgKDEpXG5cdFx0bGV0IGN1cnNvcklkeCA9IDE7XG5cdFx0bGV0IGNhY2hlZExpbmVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcblxuXHRcdGZ1bmN0aW9uIHJlZnJlc2goKSB7XG5cdFx0XHRjYWNoZWRMaW5lcyA9IHVuZGVmaW5lZDtcblx0XHRcdHR1aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gaGFuZGxlSW5wdXQoZGF0YTogc3RyaW5nKSB7XG5cdFx0XHRpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkudXApIHx8IG1hdGNoZXNLZXkoZGF0YSwgS2V5LmxlZnQpKSB7IGN1cnNvcklkeCA9IDE7IHJlZnJlc2goKTsgcmV0dXJuOyB9XG5cdFx0XHRpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkuZG93bikgfHwgbWF0Y2hlc0tleShkYXRhLCBLZXkucmlnaHQpKSB7IGN1cnNvcklkeCA9IDA7IHJlZnJlc2goKTsgcmV0dXJuOyB9XG5cdFx0XHRpZiAoZGF0YSA9PT0gXCIxXCIpIHsgZG9uZSh7IHNhdGlzZmllZDogdHJ1ZSB9KTsgcmV0dXJuOyB9XG5cdFx0XHRpZiAoZGF0YSA9PT0gXCIyXCIpIHsgZG9uZSh7IHNhdGlzZmllZDogZmFsc2UgfSk7IHJldHVybjsgfVxuXHRcdFx0Ly8gRXNjID0gXCJrZWVwIGdvaW5nXCIgKHRoZSBzYWZlL25vbi1kZXN0cnVjdGl2ZSBkZWZhdWx0KVxuXHRcdFx0aWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LmVzY2FwZSkpIHsgZG9uZSh7IHNhdGlzZmllZDogZmFsc2UgfSk7IHJldHVybjsgfVxuXHRcdFx0aWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LmVudGVyKSB8fCBtYXRjaGVzS2V5KGRhdGEsIEtleS5zcGFjZSkpIHtcblx0XHRcdFx0ZG9uZSh7IHNhdGlzZmllZDogY3Vyc29ySWR4ID09PSAxIH0pO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gcmVuZGVyKHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG5cdFx0XHRpZiAoY2FjaGVkTGluZXMpIHJldHVybiBjYWNoZWRMaW5lcztcblx0XHRcdGNvbnN0IHVpID0gbWFrZVVJKHRoZW1lLCB3aWR0aCk7XG5cdFx0XHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblx0XHRcdGNvbnN0IHB1c2ggPSAoLi4ucm93czogc3RyaW5nW11bXSkgPT4geyBmb3IgKGNvbnN0IHIgb2Ygcm93cykgbGluZXMucHVzaCguLi5yKTsgfTtcblxuXHRcdFx0cHVzaCh1aS5iYXIoKSwgdWkuYmxhbmsoKSwgdWkuaGVhZGVyKGAgICR7b3B0cy5oZWFkbGluZX1gKSwgdWkuYmxhbmsoKSk7XG5cdFx0XHRpZiAob3B0cy5wcm9ncmVzcykgcHVzaCh1aS5tZXRhKGAgICR7b3B0cy5wcm9ncmVzc31gKSwgdWkuYmxhbmsoKSk7XG5cblx0XHRcdGlmIChjdXJzb3JJZHggPT09IDEpIHtcblx0XHRcdFx0cHVzaCh1aS5hY3Rpb25TZWxlY3RlZCgxLCBvcHRzLnNhdGlzZmllZExhYmVsLCBcIldyYXAgdXAgbm93IGFuZCBnZW5lcmF0ZSB0aGUgb3V0cHV0LlwiKSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRwdXNoKHVpLmFjdGlvblVuc2VsZWN0ZWQoMSwgb3B0cy5zYXRpc2ZpZWRMYWJlbCwgXCJXcmFwIHVwIG5vdyBhbmQgZ2VuZXJhdGUgdGhlIG91dHB1dC5cIikpO1xuXHRcdFx0fVxuXHRcdFx0cHVzaCh1aS5ibGFuaygpKTtcblx0XHRcdGlmIChjdXJzb3JJZHggPT09IDApIHtcblx0XHRcdFx0cHVzaCh1aS5hY3Rpb25TZWxlY3RlZCgyLCBvcHRzLmtlZXBHb2luZ0xhYmVsLCBcIkNvbnRpbnVlIHdpdGggYW5vdGhlciBiYXRjaCBvZiBxdWVzdGlvbnMuXCIpKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHB1c2godWkuYWN0aW9uVW5zZWxlY3RlZCgyLCBvcHRzLmtlZXBHb2luZ0xhYmVsLCBcIkNvbnRpbnVlIHdpdGggYW5vdGhlciBiYXRjaCBvZiBxdWVzdGlvbnMuXCIpKTtcblx0XHRcdH1cblx0XHRcdHB1c2goXG5cdFx0XHRcdHVpLmJsYW5rKCksXG5cdFx0XHRcdHVpLmhpbnRzKFtcIlx1MjE5MS9cdTIxOTMgdG8gY2hvb3NlXCIsIFwiMS8yIHRvIHF1aWNrLXNlbGVjdFwiLCBcImVudGVyIHRvIGNvbmZpcm1cIl0pLFxuXHRcdFx0XHR1aS5iYXIoKSxcblx0XHRcdCk7XG5cblx0XHRcdGNhY2hlZExpbmVzID0gbGluZXM7XG5cdFx0XHRyZXR1cm4gbGluZXM7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHtcblx0XHRcdHJlbmRlcixcblx0XHRcdGludmFsaWRhdGU6ICgpID0+IHsgY2FjaGVkTGluZXMgPSB1bmRlZmluZWQ7IH0sXG5cdFx0XHRoYW5kbGVJbnB1dCxcblx0XHR9O1xuXHR9KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEludGVydmlldyByb3VuZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNob3dJbnRlcnZpZXdSb3VuZChcblx0cXVlc3Rpb25zOiBRdWVzdGlvbltdLFxuXHRvcHRzOiBJbnRlcnZpZXdSb3VuZE9wdGlvbnMsXG5cdGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4pOiBQcm9taXNlPFJvdW5kUmVzdWx0PiB7XG5cdHJldHVybiBjdHgudWkuY3VzdG9tPFJvdW5kUmVzdWx0PigodHVpOiBUVUksIHRoZW1lOiBUaGVtZSwgX2tiLCBkb25lKSA9PiB7XG5cblx0XHRpbnRlcmZhY2UgUXVlc3Rpb25TdGF0ZSB7XG5cdFx0XHRjdXJzb3JJbmRleDogbnVtYmVyO1xuXHRcdFx0Y29tbWl0dGVkSW5kZXg6IG51bWJlciB8IG51bGw7XG5cdFx0XHRjaGVja2VkSW5kaWNlczogU2V0PG51bWJlcj47XG5cdFx0XHRub3Rlczogc3RyaW5nO1xuXHRcdFx0bm90ZXNWaXNpYmxlOiBib29sZWFuO1xuXHRcdH1cblxuXHRcdGNvbnN0IHN0YXRlczogUXVlc3Rpb25TdGF0ZVtdID0gcXVlc3Rpb25zLm1hcCgoKSA9PiAoe1xuXHRcdFx0Y3Vyc29ySW5kZXg6IDAsXG5cdFx0XHRjb21taXR0ZWRJbmRleDogbnVsbCxcblx0XHRcdGNoZWNrZWRJbmRpY2VzOiBuZXcgU2V0KCksXG5cdFx0XHRub3RlczogXCJcIixcblx0XHRcdG5vdGVzVmlzaWJsZTogZmFsc2UsXG5cdFx0fSkpO1xuXG5cdFx0Y29uc3QgaXNNdWx0aVF1ZXN0aW9uID0gcXVlc3Rpb25zLmxlbmd0aCA+IDE7XG5cdFx0bGV0IGN1cnJlbnRJZHggPSAwO1xuXHRcdGxldCBmb2N1c05vdGVzID0gZmFsc2U7XG5cdFx0bGV0IHNob3dpbmdSZXZpZXcgPSBmYWxzZTtcblx0XHRsZXQgc2hvd2luZ0V4aXRDb25maXJtID0gZmFsc2U7XG5cdFx0bGV0IGV4aXRDdXJzb3IgPSAwOyAvLyAwID0ga2VlcCBnb2luZyAoZGVmYXVsdCksIDEgPSBlbmQgaW50ZXJ2aWV3XG5cdFx0bGV0IGNhY2hlZExpbmVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcblx0XHRsZXQgY29tcGxldGVkID0gZmFsc2U7XG5cdFx0bGV0IHJlbW92ZUFib3J0TGlzdGVuZXI6ICgoKSA9PiB2b2lkKSB8IHVuZGVmaW5lZDtcblxuXHRcdGZ1bmN0aW9uIGZpbmlzaChyZXN1bHQ6IFJvdW5kUmVzdWx0KSB7XG5cdFx0XHRpZiAoY29tcGxldGVkKSByZXR1cm47XG5cdFx0XHRjb21wbGV0ZWQgPSB0cnVlO1xuXHRcdFx0cmVtb3ZlQWJvcnRMaXN0ZW5lcj8uKCk7XG5cdFx0XHRkb25lKHJlc3VsdCk7XG5cdFx0fVxuXG5cdFx0Ly8gRXh0ZXJuYWwgY2FuY2VsbGF0aW9uIChlLmcuIHJlbW90ZSBjaGFubmVsIHdvbiB0aGUgcmFjZSlcblx0XHRpZiAob3B0cy5zaWduYWwpIHtcblx0XHRcdGNvbnN0IG9uQWJvcnQgPSAoKSA9PiBmaW5pc2goeyBlbmRJbnRlcnZpZXc6IGZhbHNlLCBhbnN3ZXJzOiB7fSB9KTtcblx0XHRcdGlmIChvcHRzLnNpZ25hbC5hYm9ydGVkKSB7IG9uQWJvcnQoKTsgfVxuXHRcdFx0ZWxzZSB7XG5cdFx0XHRcdG9wdHMuc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0LCB7IG9uY2U6IHRydWUgfSk7XG5cdFx0XHRcdHJlbW92ZUFib3J0TGlzdGVuZXIgPSAoKSA9PiBvcHRzLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIEVkaXRvciBpcyBjcmVhdGVkIG9uY2U7IGVkaXRvclRoZW1lIGNvbWVzIGZyb20gdGhlIGRlc2lnbiBzeXN0ZW1cblx0XHRjb25zdCBlZGl0b3JSZWYgPSB7IGN1cnJlbnQ6IG51bGwgYXMgRWRpdG9yIHwgbnVsbCB9O1xuXG5cdFx0ZnVuY3Rpb24gZ2V0RWRpdG9yKCk6IEVkaXRvciB7XG5cdFx0XHRpZiAoIWVkaXRvclJlZi5jdXJyZW50KSB7XG5cdFx0XHRcdGVkaXRvclJlZi5jdXJyZW50ID0gbmV3IEVkaXRvcih0dWksIG1ha2VVSSh0aGVtZSwgODApLmVkaXRvclRoZW1lKTtcblx0XHRcdH1cblx0XHRcdHJldHVybiBlZGl0b3JSZWYuY3VycmVudDtcblx0XHR9XG5cblx0XHRmdW5jdGlvbiByZWZyZXNoKCkge1xuXHRcdFx0Y2FjaGVkTGluZXMgPSB1bmRlZmluZWQ7XG5cdFx0XHR0dWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIGlzTXVsdGlTZWxlY3QocUlkeDogbnVtYmVyKTogYm9vbGVhbiB7XG5cdFx0XHRyZXR1cm4gISFxdWVzdGlvbnNbcUlkeF0uYWxsb3dNdWx0aXBsZTtcblx0XHR9XG5cblx0XHRmdW5jdGlvbiB0b3RhbE9wdHMocUlkeDogbnVtYmVyKTogbnVtYmVyIHtcblx0XHRcdHJldHVybiBxdWVzdGlvbnNbcUlkeF0ub3B0aW9ucy5sZW5ndGggKyAxO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIG5vbmVPckRvbmVJZHgocUlkeDogbnVtYmVyKTogbnVtYmVyIHtcblx0XHRcdHJldHVybiBxdWVzdGlvbnNbcUlkeF0ub3B0aW9ucy5sZW5ndGg7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gc2F2ZUVkaXRvclRvU3RhdGUoKSB7XG5cdFx0XHRzdGF0ZXNbY3VycmVudElkeF0ubm90ZXMgPSBnZXRFZGl0b3IoKS5nZXRFeHBhbmRlZFRleHQoKS50cmltKCk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gbG9hZFN0YXRlVG9FZGl0b3IoKSB7XG5cdFx0XHRnZXRFZGl0b3IoKS5zZXRUZXh0KHN0YXRlc1tjdXJyZW50SWR4XS5ub3Rlcyk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gaXNRdWVzdGlvbkFuc3dlcmVkKGlkeDogbnVtYmVyKTogYm9vbGVhbiB7XG5cdFx0XHRpZiAoaXNNdWx0aVNlbGVjdChpZHgpKSByZXR1cm4gc3RhdGVzW2lkeF0uY2hlY2tlZEluZGljZXMuc2l6ZSA+IDA7XG5cdFx0XHRyZXR1cm4gc3RhdGVzW2lkeF0uY29tbWl0dGVkSW5kZXggIT09IG51bGw7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gYWxsQW5zd2VyZWQoKTogYm9vbGVhbiB7XG5cdFx0XHRyZXR1cm4gcXVlc3Rpb25zLmV2ZXJ5KChfLCBpKSA9PiBpc1F1ZXN0aW9uQW5zd2VyZWQoaSkpO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIHN3aXRjaFF1ZXN0aW9uKG5ld0lkeDogbnVtYmVyKSB7XG5cdFx0XHRpZiAobmV3SWR4ID09PSBjdXJyZW50SWR4KSByZXR1cm47XG5cdFx0XHRzYXZlRWRpdG9yVG9TdGF0ZSgpO1xuXHRcdFx0Y3VycmVudElkeCA9IG5ld0lkeDtcblx0XHRcdGxvYWRTdGF0ZVRvRWRpdG9yKCk7XG5cdFx0XHRmb2N1c05vdGVzID0gc3RhdGVzW2N1cnJlbnRJZHhdLm5vdGVzVmlzaWJsZSAmJiBzdGF0ZXNbY3VycmVudElkeF0ubm90ZXMubGVuZ3RoID4gMDtcblx0XHRcdHJlZnJlc2goKTtcblx0XHR9XG5cblx0XHRmdW5jdGlvbiBidWlsZFJlc3VsdCgpOiBSb3VuZFJlc3VsdCB7XG5cdFx0XHRjb25zdCBhbnN3ZXJzOiBSZWNvcmQ8c3RyaW5nLCB7IHNlbGVjdGVkOiBzdHJpbmcgfCBzdHJpbmdbXTsgbm90ZXM6IHN0cmluZyB9PiA9IHt9O1xuXHRcdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBxdWVzdGlvbnMubGVuZ3RoOyBpKyspIHtcblx0XHRcdFx0Y29uc3QgcSA9IHF1ZXN0aW9uc1tpXTtcblx0XHRcdFx0Y29uc3Qgc3QgPSBzdGF0ZXNbaV07XG5cdFx0XHRcdGNvbnN0IG5vdGVzID0gc3Qubm90ZXMudHJpbSgpO1xuXG5cdFx0XHRcdGlmIChpc011bHRpU2VsZWN0KGkpKSB7XG5cdFx0XHRcdFx0Y29uc3Qgc29ydGVkID0gQXJyYXkuZnJvbShzdC5jaGVja2VkSW5kaWNlcykuc29ydCgoYSwgYikgPT4gYSAtIGIpO1xuXHRcdFx0XHRcdGNvbnN0IHNlbGVjdGVkID0gc29ydGVkLm1hcCgoaWR4KSA9PiBxLm9wdGlvbnNbaWR4XS5sYWJlbCk7XG5cdFx0XHRcdFx0aWYgKHNlbGVjdGVkLmxlbmd0aCA+IDAgfHwgbm90ZXMpIGFuc3dlcnNbcS5pZF0gPSB7IHNlbGVjdGVkLCBub3RlcyB9O1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGlmIChzdC5jb21taXR0ZWRJbmRleCA9PT0gbnVsbCAmJiAhbm90ZXMpIGNvbnRpbnVlO1xuXHRcdFx0XHRcdGxldCBzZWxlY3RlZCA9IE9USEVSX09QVElPTl9MQUJFTDtcblx0XHRcdFx0XHRpZiAoc3QuY29tbWl0dGVkSW5kZXggIT09IG51bGwpIHtcblx0XHRcdFx0XHRcdGNvbnN0IGlkeCA9IHN0LmNvbW1pdHRlZEluZGV4O1xuXHRcdFx0XHRcdFx0aWYgKGlkeCA8IHEub3B0aW9ucy5sZW5ndGgpIHNlbGVjdGVkID0gcS5vcHRpb25zW2lkeF0ubGFiZWw7XG5cdFx0XHRcdFx0XHRlbHNlIGlmIChpZHggPT09IG5vbmVPckRvbmVJZHgoaSkpIHNlbGVjdGVkID0gT1RIRVJfT1BUSU9OX0xBQkVMO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRhbnN3ZXJzW3EuaWRdID0geyBzZWxlY3RlZCwgbm90ZXMgfTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIHsgZW5kSW50ZXJ2aWV3OiBmYWxzZSwgYW5zd2VycyB9O1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIHN1Ym1pdCgpIHtcblx0XHRcdHNhdmVFZGl0b3JUb1N0YXRlKCk7XG5cdFx0XHRmaW5pc2goYnVpbGRSZXN1bHQoKSk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gZ29OZXh0T3JTdWJtaXQoKSB7XG5cdFx0XHRpZiAoIWlzTXVsdGlTZWxlY3QoY3VycmVudElkeCkpIHtcblx0XHRcdFx0c3RhdGVzW2N1cnJlbnRJZHhdLmNvbW1pdHRlZEluZGV4ID0gc3RhdGVzW2N1cnJlbnRJZHhdLmN1cnNvckluZGV4O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBBdXRvLW9wZW4gdGhlIG5vdGVzIGZpZWxkIHdoZW4gXCJOb25lIG9mIHRoZSBhYm92ZVwiIGlzIHNlbGVjdGVkXG5cdFx0XHQvLyBzbyB0aGUgdXNlciBjYW4gaW1tZWRpYXRlbHkgcHJvdmlkZSBhIGZyZWUtdGV4dCBleHBsYW5hdGlvblxuXHRcdFx0Ly8gaW5zdGVhZCBvZiBiZWluZyB0cmFwcGVkIGluIGEgcmUtYXNraW5nIGxvb3AgKGJ1ZyAjMjcxNSkuXG5cdFx0XHQvLyBPbmx5IGF1dG8tb3BlbiBpZiB0aGUgdXNlciBoYXNuJ3QgYWxyZWFkeSBwcm92aWRlZCBub3RlcyBcdTIwMTRcblx0XHRcdC8vIG90aGVyd2lzZSBFbnRlciBmcm9tIG5vdGVzIG1vZGUgbG9vcHMgYmFjayBoZXJlIGVuZGxlc3NseS5cblx0XHRcdGlmICghaXNNdWx0aVNlbGVjdChjdXJyZW50SWR4KSAmJiBzdGF0ZXNbY3VycmVudElkeF0uY3Vyc29ySW5kZXggPT09IG5vbmVPckRvbmVJZHgoY3VycmVudElkeCkgJiYgIXN0YXRlc1tjdXJyZW50SWR4XS5ub3RlcyAmJiAhc3RhdGVzW2N1cnJlbnRJZHhdLm5vdGVzVmlzaWJsZSkge1xuXHRcdFx0XHRzdGF0ZXNbY3VycmVudElkeF0ubm90ZXNWaXNpYmxlID0gdHJ1ZTtcblx0XHRcdFx0Zm9jdXNOb3RlcyA9IHRydWU7XG5cdFx0XHRcdGxvYWRTdGF0ZVRvRWRpdG9yKCk7XG5cdFx0XHRcdHJlZnJlc2goKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoaXNNdWx0aVF1ZXN0aW9uICYmIGN1cnJlbnRJZHggPCBxdWVzdGlvbnMubGVuZ3RoIC0gMSkge1xuXHRcdFx0XHRsZXQgbmV4dCA9IGN1cnJlbnRJZHggKyAxO1xuXHRcdFx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHF1ZXN0aW9ucy5sZW5ndGg7IGkrKykge1xuXHRcdFx0XHRcdGNvbnN0IGNhbmRpZGF0ZSA9IChjdXJyZW50SWR4ICsgMSArIGkpICUgcXVlc3Rpb25zLmxlbmd0aDtcblx0XHRcdFx0XHRpZiAoIWlzUXVlc3Rpb25BbnN3ZXJlZChjYW5kaWRhdGUpKSB7IG5leHQgPSBjYW5kaWRhdGU7IGJyZWFrOyB9XG5cdFx0XHRcdH1cblx0XHRcdFx0c3dpdGNoUXVlc3Rpb24obmV4dCk7XG5cdFx0XHR9IGVsc2UgaWYgKGFsbEFuc3dlcmVkKCkpIHtcblx0XHRcdFx0c2F2ZUVkaXRvclRvU3RhdGUoKTtcblx0XHRcdFx0c2hvd2luZ1JldmlldyA9IHRydWU7XG5cdFx0XHRcdHJlZnJlc2goKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBcdTI1MDBcdTI1MDAgSW5wdXQgaGFuZGxlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuXHRcdGZ1bmN0aW9uIGhhbmRsZUlucHV0KGRhdGE6IHN0cmluZykge1xuXHRcdFx0Ly8gXHUyNTAwXHUyNTAwIEV4aXQgY29uZmlybWF0aW9uIG92ZXJsYXkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cdFx0XHRpZiAoc2hvd2luZ0V4aXRDb25maXJtKSB7XG5cdFx0XHRcdGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS51cCkgfHwgbWF0Y2hlc0tleShkYXRhLCBLZXkubGVmdCkpIHsgZXhpdEN1cnNvciA9IDA7IHJlZnJlc2goKTsgcmV0dXJuOyB9XG5cdFx0XHRcdGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS5kb3duKSB8fCBtYXRjaGVzS2V5KGRhdGEsIEtleS5yaWdodCkpIHsgZXhpdEN1cnNvciA9IDE7IHJlZnJlc2goKTsgcmV0dXJuOyB9XG5cdFx0XHRcdGlmIChkYXRhID09PSBcIjFcIikgeyBzaG93aW5nRXhpdENvbmZpcm0gPSBmYWxzZTsgcmVmcmVzaCgpOyByZXR1cm47IH1cblx0XHRcdFx0aWYgKGRhdGEgPT09IFwiMlwiKSB7IGZpbmlzaCh7IGVuZEludGVydmlldzogZmFsc2UsIGFuc3dlcnM6IHt9IH0pOyByZXR1cm47IH1cblx0XHRcdFx0aWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LmVudGVyKSB8fCBtYXRjaGVzS2V5KGRhdGEsIEtleS5zcGFjZSkpIHtcblx0XHRcdFx0XHRpZiAoZXhpdEN1cnNvciA9PT0gMCkgeyBzaG93aW5nRXhpdENvbmZpcm0gPSBmYWxzZTsgcmVmcmVzaCgpOyB9XG5cdFx0XHRcdFx0ZWxzZSB7IGZpbmlzaCh7IGVuZEludGVydmlldzogZmFsc2UsIGFuc3dlcnM6IHt9IH0pOyB9XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS5lc2NhcGUpKSB7IHNob3dpbmdFeGl0Q29uZmlybSA9IGZhbHNlOyByZWZyZXNoKCk7IHJldHVybjsgfVxuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdC8vIFx1MjUwMFx1MjUwMCBSZXZpZXcgc2NyZWVuIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXHRcdFx0aWYgKHNob3dpbmdSZXZpZXcpIHtcblx0XHRcdFx0aWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LmVzY2FwZSkgfHwgbWF0Y2hlc0tleShkYXRhLCBLZXkubGVmdCkpIHtcblx0XHRcdFx0XHRzaG93aW5nUmV2aWV3ID0gZmFsc2U7XG5cdFx0XHRcdFx0c3dpdGNoUXVlc3Rpb24ocXVlc3Rpb25zLmxlbmd0aCAtIDEpO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkuZW50ZXIpIHx8IG1hdGNoZXNLZXkoZGF0YSwgS2V5LnJpZ2h0KSB8fCBtYXRjaGVzS2V5KGRhdGEsIEtleS5zcGFjZSkpIHtcblx0XHRcdFx0XHRzdWJtaXQoKTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBzdCA9IHN0YXRlc1tjdXJyZW50SWR4XTtcblx0XHRcdGNvbnN0IG9wdENvdW50ID0gdG90YWxPcHRzKGN1cnJlbnRJZHgpO1xuXHRcdFx0Y29uc3QgbXVsdGlTZWwgPSBpc011bHRpU2VsZWN0KGN1cnJlbnRJZHgpO1xuXG5cdFx0XHQvLyBcdTI1MDBcdTI1MDAgRXNjIFx1MjE5MiBleGl0IGNvbmZpcm1hdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblx0XHRcdGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS5lc2NhcGUpKSB7XG5cdFx0XHRcdGlmIChmb2N1c05vdGVzKSB7XG5cdFx0XHRcdFx0c2F2ZUVkaXRvclRvU3RhdGUoKTtcblx0XHRcdFx0XHRmb2N1c05vdGVzID0gZmFsc2U7XG5cdFx0XHRcdFx0c3Qubm90ZXNWaXNpYmxlID0gc3Qubm90ZXMubGVuZ3RoID4gMDtcblx0XHRcdFx0XHRyZWZyZXNoKCk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0c2hvd2luZ0V4aXRDb25maXJtID0gdHJ1ZTtcblx0XHRcdFx0XHRleGl0Q3Vyc29yID0gMDtcblx0XHRcdFx0XHRyZWZyZXNoKCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBcdTI1MDBcdTI1MDAgTm90ZXMgbW9kZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblx0XHRcdGlmIChmb2N1c05vdGVzKSB7XG5cdFx0XHRcdGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS50YWIpKSB7XG5cdFx0XHRcdFx0c2F2ZUVkaXRvclRvU3RhdGUoKTtcblx0XHRcdFx0XHRmb2N1c05vdGVzID0gZmFsc2U7XG5cdFx0XHRcdFx0c3Qubm90ZXNWaXNpYmxlID0gc3Qubm90ZXMubGVuZ3RoID4gMDtcblx0XHRcdFx0XHRyZWZyZXNoKCk7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS5lbnRlcikpIHtcblx0XHRcdFx0XHRzYXZlRWRpdG9yVG9TdGF0ZSgpO1xuXHRcdFx0XHRcdGZvY3VzTm90ZXMgPSBmYWxzZTtcblx0XHRcdFx0XHRpZiAoIW11bHRpU2VsICYmIHN0LmNvbW1pdHRlZEluZGV4ID09PSBudWxsKSBzdC5jb21taXR0ZWRJbmRleCA9IG5vbmVPckRvbmVJZHgoY3VycmVudElkeCk7XG5cdFx0XHRcdFx0Z29OZXh0T3JTdWJtaXQoKTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblx0XHRcdFx0Z2V0RWRpdG9yKCkuaGFuZGxlSW5wdXQoZGF0YSk7XG5cdFx0XHRcdHJlZnJlc2goKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBcdTI1MDBcdTI1MDAgTXVsdGktcXVlc3Rpb24gbmF2aWdhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblx0XHRcdGlmIChpc011bHRpUXVlc3Rpb24pIHtcblx0XHRcdFx0aWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LmxlZnQpKSB7IHN3aXRjaFF1ZXN0aW9uKChjdXJyZW50SWR4IC0gMSArIHF1ZXN0aW9ucy5sZW5ndGgpICUgcXVlc3Rpb25zLmxlbmd0aCk7IHJldHVybjsgfVxuXHRcdFx0XHRpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkucmlnaHQpKSB7IHN3aXRjaFF1ZXN0aW9uKChjdXJyZW50SWR4ICsgMSkgJSBxdWVzdGlvbnMubGVuZ3RoKTsgcmV0dXJuOyB9XG5cdFx0XHR9XG5cblx0XHRcdC8vIFx1MjUwMFx1MjUwMCBDdXJzb3IgbmF2aWdhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblx0XHRcdGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS51cCkpIHsgc3QuY3Vyc29ySW5kZXggPSAoc3QuY3Vyc29ySW5kZXggLSAxICsgb3B0Q291bnQpICUgb3B0Q291bnQ7IHJlZnJlc2goKTsgcmV0dXJuOyB9XG5cdFx0XHRpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkuZG93bikpIHsgc3QuY3Vyc29ySW5kZXggPSAoc3QuY3Vyc29ySW5kZXggKyAxKSAlIG9wdENvdW50OyByZWZyZXNoKCk7IHJldHVybjsgfVxuXG5cdFx0XHRpZiAobXVsdGlTZWwpIHtcblx0XHRcdFx0Y29uc3QgZG9uZUkgPSBub25lT3JEb25lSWR4KGN1cnJlbnRJZHgpO1xuXHRcdFx0XHRpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkuc3BhY2UpKSB7XG5cdFx0XHRcdFx0aWYgKHN0LmN1cnNvckluZGV4IDwgZG9uZUkpIHtcblx0XHRcdFx0XHRcdGlmIChzdC5jaGVja2VkSW5kaWNlcy5oYXMoc3QuY3Vyc29ySW5kZXgpKSBzdC5jaGVja2VkSW5kaWNlcy5kZWxldGUoc3QuY3Vyc29ySW5kZXgpO1xuXHRcdFx0XHRcdFx0ZWxzZSBzdC5jaGVja2VkSW5kaWNlcy5hZGQoc3QuY3Vyc29ySW5kZXgpO1xuXHRcdFx0XHRcdFx0cmVmcmVzaCgpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LmVudGVyKSkgeyBnb05leHRPclN1Ym1pdCgpOyByZXR1cm47IH1cblx0XHRcdFx0aWYgKG1hdGNoZXNLZXkoZGF0YSwgS2V5LnRhYikpIHsgc3Qubm90ZXNWaXNpYmxlID0gdHJ1ZTsgZm9jdXNOb3RlcyA9IHRydWU7IGxvYWRTdGF0ZVRvRWRpdG9yKCk7IHJlZnJlc2goKTsgcmV0dXJuOyB9XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRpZiAoZGF0YS5sZW5ndGggPT09IDEgJiYgZGF0YSA+PSBcIjFcIiAmJiBkYXRhIDw9IFwiOVwiKSB7XG5cdFx0XHRcdFx0Y29uc3QgaWR4ID0gcGFyc2VJbnQoZGF0YSwgMTApIC0gMTtcblx0XHRcdFx0XHRpZiAoaWR4IDwgb3B0Q291bnQpIHsgc3QuY3Vyc29ySW5kZXggPSBpZHg7IHN0LmNvbW1pdHRlZEluZGV4ID0gaWR4OyBnb05leHRPclN1Ym1pdCgpOyByZXR1cm47IH1cblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkuc3BhY2UpKSB7IHN0LmNvbW1pdHRlZEluZGV4ID0gc3QuY3Vyc29ySW5kZXg7IHJlZnJlc2goKTsgcmV0dXJuOyB9XG5cdFx0XHRcdGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS50YWIpKSB7IHN0Lm5vdGVzVmlzaWJsZSA9IHRydWU7IGZvY3VzTm90ZXMgPSB0cnVlOyBsb2FkU3RhdGVUb0VkaXRvcigpOyByZWZyZXNoKCk7IHJldHVybjsgfVxuXHRcdFx0XHRpZiAobWF0Y2hlc0tleShkYXRhLCBLZXkuZW50ZXIpKSB7IGdvTmV4dE9yU3VibWl0KCk7IHJldHVybjsgfVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIFx1MjUwMFx1MjUwMCBSZXZpZXcgc2NyZWVuIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5cdFx0ZnVuY3Rpb24gcmVuZGVyUmV2aWV3U2NyZWVuKHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG5cdFx0XHRjb25zdCB1aSA9IG1ha2VVSSh0aGVtZSwgd2lkdGgpO1xuXHRcdFx0Y29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cdFx0XHRjb25zdCBwdXNoID0gKC4uLnJvd3M6IHN0cmluZ1tdW10pID0+IHsgZm9yIChjb25zdCByIG9mIHJvd3MpIGxpbmVzLnB1c2goLi4ucik7IH07XG5cblx0XHRcdHB1c2godWkuYmFyKCksIHVpLmJsYW5rKCksIHVpLmhlYWRlcihgICAke29wdHMucmV2aWV3SGVhZGxpbmUgPz8gXCJSZXZpZXcgeW91ciBhbnN3ZXJzXCJ9YCksIHVpLmJsYW5rKCkpO1xuXG5cdFx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHF1ZXN0aW9ucy5sZW5ndGg7IGkrKykge1xuXHRcdFx0XHRjb25zdCBxID0gcXVlc3Rpb25zW2ldO1xuXHRcdFx0XHRjb25zdCBzdCA9IHN0YXRlc1tpXTtcblxuXHRcdFx0XHRwdXNoKHVpLnN1YnRpdGxlKGAgICR7cS5xdWVzdGlvbn1gKSk7XG5cblx0XHRcdFx0aWYgKGlzTXVsdGlTZWxlY3QoaSkpIHtcblx0XHRcdFx0XHRjb25zdCBzZWxlY3RlZCA9IEFycmF5LmZyb20oc3QuY2hlY2tlZEluZGljZXMpLnNvcnQoKGEsIGIpID0+IGEgLSBiKS5tYXAoKGlkeCkgPT4gcS5vcHRpb25zW2lkeF0ubGFiZWwpO1xuXHRcdFx0XHRcdGZvciAoY29uc3QgbGFiZWwgb2Ygc2VsZWN0ZWQpIHB1c2godWkuYW5zd2VyKGAgICAgJHtJTkRFTlQuY3Vyc29yfSR7bGFiZWx9YCkpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGxldCBsYWJlbCA9IE9USEVSX09QVElPTl9MQUJFTDtcblx0XHRcdFx0XHRpZiAoc3QuY29tbWl0dGVkSW5kZXggIT09IG51bGwgJiYgc3QuY29tbWl0dGVkSW5kZXggPCBxLm9wdGlvbnMubGVuZ3RoKSB7XG5cdFx0XHRcdFx0XHRsYWJlbCA9IHEub3B0aW9uc1tzdC5jb21taXR0ZWRJbmRleF0ubGFiZWw7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdHB1c2godWkuYW5zd2VyKGAgICAgJHtJTkRFTlQuY3Vyc29yfSR7bGFiZWx9YCkpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKHN0Lm5vdGVzKSBwdXNoKHVpLm5vdGUoYCR7SU5ERU5ULm5vdGV9bm90ZTogJHtzdC5ub3Rlc31gKSk7XG5cdFx0XHRcdHB1c2godWkuYmxhbmsoKSk7XG5cdFx0XHR9XG5cblx0XHRcdHB1c2goXG5cdFx0XHRcdHVpLmFjdGlvblNlbGVjdGVkKDAsIFwiU3VibWl0IGFuc3dlcnNcIiksXG5cdFx0XHRcdHVpLmJsYW5rKCksXG5cdFx0XHRcdHVpLmhpbnRzKFtcIlx1MjE5MCB0byBnbyBiYWNrIGFuZCBlZGl0XCIsIFwiZW50ZXIgdG8gc3VibWl0XCIsIGBlc2MgdG8gJHtvcHRzLmV4aXRMYWJlbCA/PyBcImVuZCBpbnRlcnZpZXdcIn1gXSksXG5cdFx0XHRcdHVpLmJhcigpLFxuXHRcdFx0KTtcblxuXHRcdFx0cmV0dXJuIGxpbmVzO1xuXHRcdH1cblxuXHRcdC8vIFx1MjUwMFx1MjUwMCBFeGl0IGNvbmZpcm0gc2NyZWVuIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5cdFx0ZnVuY3Rpb24gcmVuZGVyRXhpdENvbmZpcm0od2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcblx0XHRcdGNvbnN0IHVpID0gbWFrZVVJKHRoZW1lLCB3aWR0aCk7XG5cdFx0XHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblx0XHRcdGNvbnN0IHB1c2ggPSAoLi4ucm93czogc3RyaW5nW11bXSkgPT4geyBmb3IgKGNvbnN0IHIgb2Ygcm93cykgbGluZXMucHVzaCguLi5yKTsgfTtcblxuXHRcdFx0cHVzaChcblx0XHRcdFx0dWkuYmFyKCksXG5cdFx0XHRcdHVpLmJsYW5rKCksXG5cdFx0XHRcdHVpLmhlYWRlcihgICAke29wdHMuZXhpdEhlYWRsaW5lID8/IFwiRW5kIGludGVydmlldz9cIn1gKSxcblx0XHRcdFx0dWkuYmxhbmsoKSxcblx0XHRcdFx0dWkuc3VidGl0bGUoXCIgIEFuc3dlcnMgZnJvbSB0aGlzIGJhdGNoIHdvbid0IGJlIHNhdmVkLlwiKSxcblx0XHRcdFx0dWkuYmxhbmsoKSxcblx0XHRcdCk7XG5cblx0XHRcdGNvbnN0IGtlZXBHb2luZ0xhYmVsID0gXCJLZWVwIGdvaW5nXCI7XG5cdFx0XHRjb25zdCBleGl0QWN0aW9uTGFiZWwgPSBvcHRzLmV4aXRMYWJlbFxuXHRcdFx0XHQ/IG9wdHMuZXhpdExhYmVsLmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICsgb3B0cy5leGl0TGFiZWwuc2xpY2UoMSlcblx0XHRcdFx0OiBcIkVuZCBpbnRlcnZpZXdcIjtcblx0XHRcdGlmIChleGl0Q3Vyc29yID09PSAwKSB7XG5cdFx0XHRcdHB1c2godWkuYWN0aW9uU2VsZWN0ZWQoMSwga2VlcEdvaW5nTGFiZWwsIFwiUmV0dXJuIGFuZCBrZWVwIGdvaW5nLlwiKSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRwdXNoKHVpLmFjdGlvblVuc2VsZWN0ZWQoMSwga2VlcEdvaW5nTGFiZWwsIFwiUmV0dXJuIGFuZCBrZWVwIGdvaW5nLlwiKSk7XG5cdFx0XHR9XG5cdFx0XHRwdXNoKHVpLmJsYW5rKCkpO1xuXHRcdFx0aWYgKGV4aXRDdXJzb3IgPT09IDEpIHtcblx0XHRcdFx0cHVzaCh1aS5hY3Rpb25TZWxlY3RlZCgyLCBleGl0QWN0aW9uTGFiZWwsIFwiRXhpdCBhbmQgZGlzY2FyZCB0aGlzIGJhdGNoIG9mIGFuc3dlcnMuXCIpKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHB1c2godWkuYWN0aW9uVW5zZWxlY3RlZCgyLCBleGl0QWN0aW9uTGFiZWwsIFwiRXhpdCBhbmQgZGlzY2FyZCB0aGlzIGJhdGNoIG9mIGFuc3dlcnMuXCIpKTtcblx0XHRcdH1cblx0XHRcdHB1c2goXG5cdFx0XHRcdHVpLmJsYW5rKCksXG5cdFx0XHRcdHVpLmhpbnRzKFtcIlx1MjE5MS9cdTIxOTMgdG8gY2hvb3NlXCIsIFwiMS8yIHRvIHF1aWNrLXNlbGVjdFwiLCBcImVudGVyIHRvIGNvbmZpcm1cIl0pLFxuXHRcdFx0XHR1aS5iYXIoKSxcblx0XHRcdCk7XG5cblx0XHRcdHJldHVybiBsaW5lcztcblx0XHR9XG5cblx0XHQvLyBcdTI1MDBcdTI1MDAgUHJldmlldyBoZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5cdFx0bGV0IG1kVGhlbWVDYWNoZTogUmV0dXJuVHlwZTx0eXBlb2YgZ2V0TWFya2Rvd25UaGVtZT4gfCBudWxsID0gbnVsbDtcblx0XHRsZXQgcHJldmlld0NhY2hlOiB7IG1hcmtkb3duOiBzdHJpbmc7IHdpZHRoOiBudW1iZXI7IGxpbmVzOiBzdHJpbmdbXSB9IHwgbnVsbCA9IG51bGw7XG5cblx0XHRmdW5jdGlvbiBxdWVzdGlvbkhhc0FueVByZXZpZXcoKTogYm9vbGVhbiB7XG5cdFx0XHRyZXR1cm4gcXVlc3Rpb25zW2N1cnJlbnRJZHhdLm9wdGlvbnMuc29tZShcblx0XHRcdFx0KG8pID0+IG8ucHJldmlldyAhPSBudWxsICYmIG8ucHJldmlldy50cmltKCkubGVuZ3RoID4gMCxcblx0XHRcdCk7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gZ2V0Q3VycmVudFByZXZpZXcoKTogc3RyaW5nIHwgbnVsbCB7XG5cdFx0XHRjb25zdCBxID0gcXVlc3Rpb25zW2N1cnJlbnRJZHhdO1xuXHRcdFx0Y29uc3QgaWR4ID0gc3RhdGVzW2N1cnJlbnRJZHhdLmN1cnNvckluZGV4O1xuXHRcdFx0aWYgKGlkeCA8IHEub3B0aW9ucy5sZW5ndGgpIHtcblx0XHRcdFx0Y29uc3QgcHJldmlldyA9IHEub3B0aW9uc1tpZHhdLnByZXZpZXc7XG5cdFx0XHRcdHJldHVybiBwcmV2aWV3ICYmIHByZXZpZXcudHJpbSgpLmxlbmd0aCA+IDAgPyBwcmV2aWV3IDogbnVsbDtcblx0XHRcdH1cblx0XHRcdHJldHVybiBudWxsO1xuXHRcdH1cblxuXHRcdGZ1bmN0aW9uIHJlbmRlck9wdGlvbnNDb2x1bW4ob3B0V2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcblx0XHRcdGNvbnN0IHVpID0gbWFrZVVJKHRoZW1lLCBvcHRXaWR0aCk7XG5cdFx0XHRjb25zdCBjb2w6IHN0cmluZ1tdID0gW107XG5cdFx0XHRjb25zdCBwdXNoID0gKC4uLnJvd3M6IHN0cmluZ1tdW10pID0+IHsgZm9yIChjb25zdCByIG9mIHJvd3MpIGNvbC5wdXNoKC4uLnIpOyB9O1xuXG5cdFx0XHRjb25zdCBxID0gcXVlc3Rpb25zW2N1cnJlbnRJZHhdO1xuXHRcdFx0Y29uc3Qgc3QgPSBzdGF0ZXNbY3VycmVudElkeF07XG5cdFx0XHRjb25zdCBtdWx0aVNlbCA9IGlzTXVsdGlTZWxlY3QoY3VycmVudElkeCk7XG5cblx0XHRcdHB1c2godWkucXVlc3Rpb24oYCAke3EucXVlc3Rpb259YCkpO1xuXHRcdFx0aWYgKG11bHRpU2VsKSBwdXNoKHVpLm1ldGEoXCIgIChTZWxlY3QgYWxsIHRoYXQgYXBwbHkpXCIpKTtcblx0XHRcdHB1c2godWkuYmxhbmsoKSk7XG5cblx0XHRcdGZvciAobGV0IGkgPSAwOyBpIDwgcS5vcHRpb25zLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRcdGNvbnN0IG9wdCA9IHEub3B0aW9uc1tpXTtcblx0XHRcdFx0Y29uc3QgaXNDdXJzb3IgPSBpID09PSBzdC5jdXJzb3JJbmRleDtcblx0XHRcdFx0aWYgKG11bHRpU2VsKSB7XG5cdFx0XHRcdFx0Y29uc3QgaXNDaGVja2VkID0gc3QuY2hlY2tlZEluZGljZXMuaGFzKGkpO1xuXHRcdFx0XHRcdGlmIChpc0N1cnNvciAmJiAhZm9jdXNOb3RlcykgcHVzaCh1aS5jaGVja2JveFNlbGVjdGVkKG9wdC5sYWJlbCwgb3B0LmRlc2NyaXB0aW9uLCBpc0NoZWNrZWQpKTtcblx0XHRcdFx0XHRlbHNlIHB1c2godWkuY2hlY2tib3hVbnNlbGVjdGVkKG9wdC5sYWJlbCwgb3B0LmRlc2NyaXB0aW9uLCBpc0NoZWNrZWQsIGZvY3VzTm90ZXMpKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRjb25zdCBpc0NvbW1pdHRlZCA9IGkgPT09IHN0LmNvbW1pdHRlZEluZGV4O1xuXHRcdFx0XHRcdGlmIChpc0N1cnNvciAmJiAhZm9jdXNOb3Rlcykge1xuXHRcdFx0XHRcdFx0cHVzaCh1aS5vcHRpb25TZWxlY3RlZChpICsgMSwgb3B0LmxhYmVsLCBvcHQuZGVzY3JpcHRpb24sIGlzQ29tbWl0dGVkKSk7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdHB1c2godWkub3B0aW9uVW5zZWxlY3RlZChpICsgMSwgb3B0LmxhYmVsLCBvcHQuZGVzY3JpcHRpb24sIHsgaXNDb21taXR0ZWQsIGlzRm9jdXNEaW1tZWQ6IGZvY3VzTm90ZXMgfSkpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBuZElkeCA9IG5vbmVPckRvbmVJZHgoY3VycmVudElkeCk7XG5cdFx0XHRjb25zdCBuZEN1cnNvciA9IG5kSWR4ID09PSBzdC5jdXJzb3JJbmRleDtcblx0XHRcdGlmIChtdWx0aVNlbCkge1xuXHRcdFx0XHRwdXNoKHVpLmJsYW5rKCkpO1xuXHRcdFx0XHRpZiAobmRDdXJzb3IgJiYgIWZvY3VzTm90ZXMpIHB1c2godWkuZG9uZVNlbGVjdGVkKCkpO1xuXHRcdFx0XHRlbHNlIHB1c2godWkuZG9uZVVuc2VsZWN0ZWQoKSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRjb25zdCBuZENvbW1pdHRlZCA9IG5kSWR4ID09PSBzdC5jb21taXR0ZWRJbmRleDtcblx0XHRcdFx0aWYgKG5kQ3Vyc29yICYmICFmb2N1c05vdGVzKSB7XG5cdFx0XHRcdFx0cHVzaCh1aS5zbG90U2VsZWN0ZWQoT1RIRVJfT1BUSU9OX0xBQkVMLCBPVEhFUl9PUFRJT05fREVTQ1JJUFRJT04sIG5kQ29tbWl0dGVkKSk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0cHVzaCh1aS5zbG90VW5zZWxlY3RlZChPVEhFUl9PUFRJT05fTEFCRUwsIE9USEVSX09QVElPTl9ERVNDUklQVElPTiwgeyBpc0NvbW1pdHRlZDogbmRDb21taXR0ZWQsIGlzRm9jdXNEaW1tZWQ6IGZvY3VzTm90ZXMgfSkpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGlmIChzdC5ub3Rlc1Zpc2libGUgfHwgZm9jdXNOb3Rlcykge1xuXHRcdFx0XHRwdXNoKHVpLmJsYW5rKCksIHVpLm5vdGVzTGFiZWwoZm9jdXNOb3RlcykpO1xuXHRcdFx0XHRpZiAoZm9jdXNOb3Rlcykge1xuXHRcdFx0XHRcdGZvciAoY29uc3QgbGluZSBvZiBnZXRFZGl0b3IoKS5yZW5kZXIob3B0V2lkdGggLSAyKSkgY29sLnB1c2godHJ1bmNhdGVUb1dpZHRoKGAgJHtsaW5lfWAsIG9wdFdpZHRoKSk7XG5cdFx0XHRcdH0gZWxzZSBpZiAoc3Qubm90ZXMpIHtcblx0XHRcdFx0XHRwdXNoKHVpLm5vdGVzVGV4dChzdC5ub3RlcykpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiBjb2w7XG5cdFx0fVxuXG5cdFx0ZnVuY3Rpb24gcmVuZGVyUHJldmlld0NvbHVtbihtYXJrZG93bjogc3RyaW5nLCBwcmV2aWV3V2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcblx0XHRcdGlmIChwcmV2aWV3Q2FjaGUgJiYgcHJldmlld0NhY2hlLm1hcmtkb3duID09PSBtYXJrZG93biAmJiBwcmV2aWV3Q2FjaGUud2lkdGggPT09IHByZXZpZXdXaWR0aCkge1xuXHRcdFx0XHRyZXR1cm4gcHJldmlld0NhY2hlLmxpbmVzO1xuXHRcdFx0fVxuXHRcdFx0aWYgKCFtZFRoZW1lQ2FjaGUpIG1kVGhlbWVDYWNoZSA9IGdldE1hcmtkb3duVGhlbWUoKTtcblx0XHRcdGNvbnN0IGhlYWRlciA9IFtcblx0XHRcdFx0dHJ1bmNhdGVUb1dpZHRoKHRoZW1lLmZnKFwiYWNjZW50XCIsIHRoZW1lLmJvbGQoXCIgUHJldmlld1wiKSksIHByZXZpZXdXaWR0aCksXG5cdFx0XHRcdHRydW5jYXRlVG9XaWR0aCh0aGVtZS5mZyhcImRpbVwiLCBcIiBcIiArIFwiXHUyNTAwXCIucmVwZWF0KE1hdGgubWF4KDAsIHByZXZpZXdXaWR0aCAtIDIpKSksIHByZXZpZXdXaWR0aCksXG5cdFx0XHRdO1xuXHRcdFx0Y29uc3QgbWQgPSBuZXcgTWFya2Rvd24obWFya2Rvd24sIDEsIDAsIG1kVGhlbWVDYWNoZSk7XG5cdFx0XHRjb25zdCBsaW5lcyA9IFsuLi5oZWFkZXIsIC4uLm1kLnJlbmRlcihwcmV2aWV3V2lkdGgpXTtcblx0XHRcdHByZXZpZXdDYWNoZSA9IHsgbWFya2Rvd24sIHdpZHRoOiBwcmV2aWV3V2lkdGgsIGxpbmVzIH07XG5cdFx0XHRyZXR1cm4gbGluZXM7XG5cdFx0fVxuXG5cdFx0Ly8gXHUyNTAwXHUyNTAwIE1haW4gcmVuZGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5cdFx0ZnVuY3Rpb24gcmVuZGVyKHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG5cdFx0XHRpZiAoY2FjaGVkTGluZXMpIHJldHVybiBjYWNoZWRMaW5lcztcblxuXHRcdFx0aWYgKHNob3dpbmdFeGl0Q29uZmlybSkgeyBjYWNoZWRMaW5lcyA9IHJlbmRlckV4aXRDb25maXJtKHdpZHRoKTsgcmV0dXJuIGNhY2hlZExpbmVzOyB9XG5cdFx0XHRpZiAoc2hvd2luZ1JldmlldykgeyBjYWNoZWRMaW5lcyA9IHJlbmRlclJldmlld1NjcmVlbih3aWR0aCk7IHJldHVybiBjYWNoZWRMaW5lczsgfVxuXG5cdFx0XHRjb25zdCB1c2VTaWRlQnlTaWRlID0gcXVlc3Rpb25IYXNBbnlQcmV2aWV3KClcblx0XHRcdFx0JiYgd2lkdGggPj0gKE1JTl9PUFRJT05TX1dJRFRIICsgTUlOX1BSRVZJRVdfV0lEVEggKyBESVZJREVSX1dJRFRIKTtcblxuXHRcdFx0aWYgKHVzZVNpZGVCeVNpZGUpIHtcblx0XHRcdFx0Ly8gXHUyNTAwXHUyNTAwIFByZXZpZXcgcGF0aCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblx0XHRcdFx0Y29uc3QgdWkgPSBtYWtlVUkodGhlbWUsIHdpZHRoKTtcblx0XHRcdFx0Y29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cdFx0XHRcdGNvbnN0IHB1c2ggPSAoLi4ucm93czogc3RyaW5nW11bXSkgPT4geyBmb3IgKGNvbnN0IHIgb2Ygcm93cykgbGluZXMucHVzaCguLi5yKTsgfTtcblxuXHRcdFx0XHRwdXNoKHVpLmJhcigpKTtcblxuXHRcdFx0XHRpZiAoaXNNdWx0aVF1ZXN0aW9uKSB7XG5cdFx0XHRcdFx0Y29uc3QgdW5hbnN3ZXJlZCA9IHF1ZXN0aW9ucy5maWx0ZXIoKF8sIGkpID0+ICFpc1F1ZXN0aW9uQW5zd2VyZWQoaSkpLmxlbmd0aDtcblx0XHRcdFx0XHRjb25zdCBhbnN3ZXJlZFNldCA9IG5ldyBTZXQocXVlc3Rpb25zLm1hcCgoXywgaSkgPT4gaSkuZmlsdGVyKGkgPT4gaXNRdWVzdGlvbkFuc3dlcmVkKGkpKSk7XG5cdFx0XHRcdFx0cHVzaCh1aS5xdWVzdGlvblRhYnMocXVlc3Rpb25zLm1hcChxID0+IHEuaGVhZGVyKSwgY3VycmVudElkeCwgYW5zd2VyZWRTZXQpKTtcblx0XHRcdFx0XHRwdXNoKHVpLmJsYW5rKCkpO1xuXHRcdFx0XHRcdGNvbnN0IHByb2dyZXNzUGFydHMgPSBbXG5cdFx0XHRcdFx0XHRvcHRzLnByb2dyZXNzLFxuXHRcdFx0XHRcdFx0YFF1ZXN0aW9uICR7Y3VycmVudElkeCArIDF9LyR7cXVlc3Rpb25zLmxlbmd0aH1gLFxuXHRcdFx0XHRcdFx0dW5hbnN3ZXJlZCA+IDAgPyBgJHt1bmFuc3dlcmVkfSB1bmFuc3dlcmVkYCA6IG51bGwsXG5cdFx0XHRcdFx0XS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiAgXHUyMDIyICBcIik7XG5cdFx0XHRcdFx0aWYgKHByb2dyZXNzUGFydHMpIHB1c2godWkubWV0YShgICAke3Byb2dyZXNzUGFydHN9YCkpO1xuXHRcdFx0XHRcdHB1c2godWkuYmxhbmsoKSk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0aWYgKG9wdHMucHJvZ3Jlc3MpIHB1c2godWkubWV0YShgICAke29wdHMucHJvZ3Jlc3N9YCksIHVpLmJsYW5rKCkpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gU2lkZS1ieS1zaWRlIGJvZHkgXHUyMDE0IGZpeGVkIGhlaWdodCBwZXIgcmVuZGVyLCBjYXBwZWQgdG8gdGVybWluYWwuXG5cdFx0XHRcdC8vIHR1aUNocm9tZSBhY2NvdW50cyBmb3IgZWxlbWVudHMgcmVuZGVyZWQgb3V0c2lkZSB0aGUgaW50ZXJ2aWV3XG5cdFx0XHRcdC8vIGNvbXBvbmVudDogc3Bpbm5lci9sb2FkZXIgKDEtMiksIHN0YXR1cyBsaW5lICgxKSwgdG9vbCBoZWFkZXIgKDEpLFxuXHRcdFx0XHQvLyBwbHVzIGEgc2FmZXR5IG1hcmdpbiBmb3IgZnV0dXJlIGFkZGl0aW9ucy5cblx0XHRcdFx0Y29uc3QgdGVybVJvd3MgPSAodHlwZW9mIHByb2Nlc3MgIT09IFwidW5kZWZpbmVkXCIgJiYgcHJvY2Vzcy5zdGRvdXQ/LnJvd3MpIHx8IDI0O1xuXHRcdFx0XHRjb25zdCBmb290ZXJMaW5lcyA9IDM7IC8vIGJsYW5rICsgaGludHMgKyBiYXJcblx0XHRcdFx0Y29uc3QgdHVpQ2hyb21lID0gNTtcblx0XHRcdFx0Y29uc3QgbWF4Qm9keSA9IE1hdGgubWluKFBSRVZJRVdfTUFYX0xJTkVTLCBNYXRoLm1heCg2LCB0ZXJtUm93cyAtIGxpbmVzLmxlbmd0aCAtIGZvb3RlckxpbmVzIC0gdHVpQ2hyb21lKSk7XG5cblx0XHRcdFx0Y29uc3QgcHJldmlld1dpZHRoID0gTWF0aC5tYXgoTUlOX1BSRVZJRVdfV0lEVEgsIE1hdGguZmxvb3Iod2lkdGggKiBQUkVWSUVXX1JBVElPKSk7XG5cdFx0XHRcdGNvbnN0IGxlZnRXaWR0aCA9IE1hdGgubWF4KE1JTl9PUFRJT05TX1dJRFRILCB3aWR0aCAtIHByZXZpZXdXaWR0aCAtIERJVklERVJfV0lEVEgpO1xuXG5cdFx0XHRcdGNvbnN0IGZ1bGxMZWZ0ID0gcmVuZGVyT3B0aW9uc0NvbHVtbihsZWZ0V2lkdGgpO1xuXHRcdFx0XHRjb25zdCBsZWZ0TGluZXMgPSBmdWxsTGVmdC5zbGljZSgwLCBtYXhCb2R5KTtcblx0XHRcdFx0aWYgKGZ1bGxMZWZ0Lmxlbmd0aCA+IG1heEJvZHkpIHtcblx0XHRcdFx0XHRjb25zdCBuID0gZnVsbExlZnQubGVuZ3RoIC0gbWF4Qm9keSArIDE7XG5cdFx0XHRcdFx0Y29uc3QgbGJsID0gYCske259IGxpbmVzIGhpZGRlbmA7XG5cdFx0XHRcdFx0Y29uc3QgZCA9IFwiXHUyNTAwXCIucmVwZWF0KE1hdGgubWF4KDAsIE1hdGguZmxvb3IoKGxlZnRXaWR0aCAtIGxibC5sZW5ndGggLSAyKSAvIDIpKSk7XG5cdFx0XHRcdFx0bGVmdExpbmVzW21heEJvZHkgLSAxXSA9IHRydW5jYXRlVG9XaWR0aCh0aGVtZS5mZyhcImRpbVwiLCBgICR7ZH0gJHtsYmx9ICR7ZH1gKSwgbGVmdFdpZHRoKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IHByZXZpZXcgPSBnZXRDdXJyZW50UHJldmlldygpO1xuXHRcdFx0XHRjb25zdCBmdWxsUmlnaHQgPSBwcmV2aWV3ID8gcmVuZGVyUHJldmlld0NvbHVtbihwcmV2aWV3LCBwcmV2aWV3V2lkdGgpIDogW107XG5cdFx0XHRcdGNvbnN0IHJpZ2h0TGluZXMgPSBmdWxsUmlnaHQuc2xpY2UoMCwgbWF4Qm9keSk7XG5cdFx0XHRcdGlmIChmdWxsUmlnaHQubGVuZ3RoID4gbWF4Qm9keSkge1xuXHRcdFx0XHRcdGNvbnN0IG4gPSBmdWxsUmlnaHQubGVuZ3RoIC0gbWF4Qm9keSArIDE7XG5cdFx0XHRcdFx0Y29uc3QgbGJsID0gYCske259IGxpbmVzIGhpZGRlbmA7XG5cdFx0XHRcdFx0Y29uc3QgZCA9IFwiXHUyNTAwXCIucmVwZWF0KE1hdGgubWF4KDAsIE1hdGguZmxvb3IoKHByZXZpZXdXaWR0aCAtIGxibC5sZW5ndGggLSAyKSAvIDIpKSk7XG5cdFx0XHRcdFx0cmlnaHRMaW5lc1ttYXhCb2R5IC0gMV0gPSB0cnVuY2F0ZVRvV2lkdGgodGhlbWUuZmcoXCJkaW1cIiwgYCAke2R9ICR7bGJsfSAke2R9YCksIHByZXZpZXdXaWR0aCk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHR3aGlsZSAobGVmdExpbmVzLmxlbmd0aCA8IG1heEJvZHkpIGxlZnRMaW5lcy5wdXNoKFwiXCIpO1xuXHRcdFx0XHR3aGlsZSAocmlnaHRMaW5lcy5sZW5ndGggPCBtYXhCb2R5KSByaWdodExpbmVzLnB1c2goXCJcIik7XG5cdFx0XHRcdGNvbnN0IGRpdmlkZXIgPSB0aGVtZS5mZyhcImRpbVwiLCBESVZJREVSX0NIQVJTKTtcblx0XHRcdFx0bGluZXMucHVzaCguLi5tZXJnZVNpZGVCeVNpZGUobGVmdExpbmVzLCByaWdodExpbmVzLCBsZWZ0V2lkdGgsIGRpdmlkZXIsIHdpZHRoKSk7XG5cblx0XHRcdFx0Ly8gRm9vdGVyXG5cdFx0XHRcdHB1c2godWkuYmxhbmsoKSk7XG5cdFx0XHRcdGNvbnN0IGlzTGFzdCA9ICFpc011bHRpUXVlc3Rpb24gfHwgY3VycmVudElkeCA9PT0gcXVlc3Rpb25zLmxlbmd0aCAtIDE7XG5cdFx0XHRcdGNvbnN0IGhpbnRzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdFx0XHRpZiAoZm9jdXNOb3Rlcykge1xuXHRcdFx0XHRcdGhpbnRzLnB1c2goXCJlbnRlciB0byBjb25maXJtXCIpO1xuXHRcdFx0XHRcdGhpbnRzLnB1c2goXCJ0YWIgb3IgZXNjIHRvIGNsb3NlIG5vdGVzXCIpO1xuXHRcdFx0XHR9IGVsc2UgaWYgKGlzTXVsdGlTZWxlY3QoY3VycmVudElkeCkpIHtcblx0XHRcdFx0XHRoaW50cy5wdXNoKFwic3BhY2UgdG8gdG9nZ2xlXCIpO1xuXHRcdFx0XHRcdGlmIChpc011bHRpUXVlc3Rpb24pIGhpbnRzLnB1c2goXCJcdTIxOTAvXHUyMTkyIG5hdmlnYXRlIHF1ZXN0aW9uc1wiKTtcblx0XHRcdFx0XHRoaW50cy5wdXNoKFwidGFiIHRvIGFkZCBub3Rlc1wiKTtcblx0XHRcdFx0XHRoaW50cy5wdXNoKGlzTGFzdCAmJiBhbGxBbnN3ZXJlZCgpID8gXCJlbnRlciB0byByZXZpZXdcIiA6IFwiZW50ZXIgdG8gbmV4dFwiKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRoaW50cy5wdXNoKFwidGFiIHRvIGFkZCBub3Rlc1wiKTtcblx0XHRcdFx0XHRpZiAoaXNNdWx0aVF1ZXN0aW9uKSBoaW50cy5wdXNoKFwiXHUyMTkwL1x1MjE5MiBuYXZpZ2F0ZVwiKTtcblx0XHRcdFx0XHRoaW50cy5wdXNoKGlzTGFzdCAmJiBhbGxBbnN3ZXJlZCgpID8gXCJlbnRlciB0byByZXZpZXdcIiA6IFwiZW50ZXIgdG8gbmV4dFwiKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRoaW50cy5wdXNoKFwiZXNjIHRvIGV4aXRcIik7XG5cdFx0XHRcdHB1c2godWkuaGludHMoaGludHMpLCB1aS5iYXIoKSk7XG5cblx0XHRcdFx0Y2FjaGVkTGluZXMgPSBsaW5lcztcblx0XHRcdFx0cmV0dXJuIGxpbmVzO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBcdTI1MDBcdTI1MDAgT3JpZ2luYWwgcGF0aCBcdTIwMTQgbm8gcHJldmlldywgdW50b3VjaGVkIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5cdFx0XHRjb25zdCB1aSA9IG1ha2VVSSh0aGVtZSwgd2lkdGgpO1xuXHRcdFx0Y29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cdFx0XHRjb25zdCBwdXNoID0gKC4uLnJvd3M6IHN0cmluZ1tdW10pID0+IHsgZm9yIChjb25zdCByIG9mIHJvd3MpIGxpbmVzLnB1c2goLi4ucik7IH07XG5cblx0XHRcdGNvbnN0IHEgPSBxdWVzdGlvbnNbY3VycmVudElkeF07XG5cdFx0XHRjb25zdCBzdCA9IHN0YXRlc1tjdXJyZW50SWR4XTtcblx0XHRcdGNvbnN0IG11bHRpU2VsID0gaXNNdWx0aVNlbGVjdChjdXJyZW50SWR4KTtcblxuXHRcdFx0cHVzaCh1aS5iYXIoKSk7XG5cblx0XHRcdC8vIFx1MjUwMFx1MjUwMCBQcm9ncmVzcyBoZWFkZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cdFx0XHRpZiAoaXNNdWx0aVF1ZXN0aW9uKSB7XG5cdFx0XHRcdGNvbnN0IHVuYW5zd2VyZWQgPSBxdWVzdGlvbnMuZmlsdGVyKChfLCBpKSA9PiAhaXNRdWVzdGlvbkFuc3dlcmVkKGkpKS5sZW5ndGg7XG5cdFx0XHRcdGNvbnN0IGFuc3dlcmVkU2V0ID0gbmV3IFNldChxdWVzdGlvbnMubWFwKChfLCBpKSA9PiBpKS5maWx0ZXIoaSA9PiBpc1F1ZXN0aW9uQW5zd2VyZWQoaSkpKTtcblx0XHRcdFx0cHVzaCh1aS5xdWVzdGlvblRhYnMocXVlc3Rpb25zLm1hcChxID0+IHEuaGVhZGVyKSwgY3VycmVudElkeCwgYW5zd2VyZWRTZXQpKTtcblx0XHRcdFx0cHVzaCh1aS5ibGFuaygpKTtcblx0XHRcdFx0Y29uc3QgcHJvZ3Jlc3NQYXJ0cyA9IFtcblx0XHRcdFx0XHRvcHRzLnByb2dyZXNzLFxuXHRcdFx0XHRcdGBRdWVzdGlvbiAke2N1cnJlbnRJZHggKyAxfS8ke3F1ZXN0aW9ucy5sZW5ndGh9YCxcblx0XHRcdFx0XHR1bmFuc3dlcmVkID4gMCA/IGAke3VuYW5zd2VyZWR9IHVuYW5zd2VyZWRgIDogbnVsbCxcblx0XHRcdFx0XS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiAgXHUyMDIyICBcIik7XG5cdFx0XHRcdGlmIChwcm9ncmVzc1BhcnRzKSBwdXNoKHVpLm1ldGEoYCAgJHtwcm9ncmVzc1BhcnRzfWApKTtcblx0XHRcdFx0cHVzaCh1aS5ibGFuaygpKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGlmIChvcHRzLnByb2dyZXNzKSBwdXNoKHVpLm1ldGEoYCAgJHtvcHRzLnByb2dyZXNzfWApLCB1aS5ibGFuaygpKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gXHUyNTAwXHUyNTAwIFF1ZXN0aW9uIHRleHQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cdFx0XHRwdXNoKHVpLnF1ZXN0aW9uKGAgJHtxLnF1ZXN0aW9ufWApKTtcblx0XHRcdGlmIChtdWx0aVNlbCkgcHVzaCh1aS5tZXRhKFwiICAoU2VsZWN0IGFsbCB0aGF0IGFwcGx5KVwiKSk7XG5cdFx0XHRwdXNoKHVpLmJsYW5rKCkpO1xuXG5cdFx0XHQvLyBcdTI1MDBcdTI1MDAgT3B0aW9ucyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblx0XHRcdGZvciAobGV0IGkgPSAwOyBpIDwgcS5vcHRpb25zLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRcdGNvbnN0IG9wdCA9IHEub3B0aW9uc1tpXTtcblx0XHRcdFx0Y29uc3QgaXNDdXJzb3IgPSBpID09PSBzdC5jdXJzb3JJbmRleDtcblxuXHRcdFx0XHRpZiAobXVsdGlTZWwpIHtcblx0XHRcdFx0XHRjb25zdCBpc0NoZWNrZWQgPSBzdC5jaGVja2VkSW5kaWNlcy5oYXMoaSk7XG5cdFx0XHRcdFx0aWYgKGlzQ3Vyc29yICYmICFmb2N1c05vdGVzKSBwdXNoKHVpLmNoZWNrYm94U2VsZWN0ZWQob3B0LmxhYmVsLCBvcHQuZGVzY3JpcHRpb24sIGlzQ2hlY2tlZCkpO1xuXHRcdFx0XHRcdGVsc2UgcHVzaCh1aS5jaGVja2JveFVuc2VsZWN0ZWQob3B0LmxhYmVsLCBvcHQuZGVzY3JpcHRpb24sIGlzQ2hlY2tlZCwgZm9jdXNOb3RlcykpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGNvbnN0IGlzQ29tbWl0dGVkID0gaSA9PT0gc3QuY29tbWl0dGVkSW5kZXg7XG5cdFx0XHRcdFx0aWYgKGlzQ3Vyc29yICYmICFmb2N1c05vdGVzKSB7XG5cdFx0XHRcdFx0XHRwdXNoKHVpLm9wdGlvblNlbGVjdGVkKGkgKyAxLCBvcHQubGFiZWwsIG9wdC5kZXNjcmlwdGlvbiwgaXNDb21taXR0ZWQpKTtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0cHVzaCh1aS5vcHRpb25VbnNlbGVjdGVkKGkgKyAxLCBvcHQubGFiZWwsIG9wdC5kZXNjcmlwdGlvbiwgeyBpc0NvbW1pdHRlZCwgaXNGb2N1c0RpbW1lZDogZm9jdXNOb3RlcyB9KSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIFx1MjUwMFx1MjUwMCBOb25lIC8gRG9uZSBzbG90IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXHRcdFx0Y29uc3QgbmRJZHggPSBub25lT3JEb25lSWR4KGN1cnJlbnRJZHgpO1xuXHRcdFx0Y29uc3QgbmRDdXJzb3IgPSBuZElkeCA9PT0gc3QuY3Vyc29ySW5kZXg7XG5cblx0XHRcdGlmIChtdWx0aVNlbCkge1xuXHRcdFx0XHRwdXNoKHVpLmJsYW5rKCkpO1xuXHRcdFx0XHRpZiAobmRDdXJzb3IgJiYgIWZvY3VzTm90ZXMpIHB1c2godWkuZG9uZVNlbGVjdGVkKCkpO1xuXHRcdFx0XHRlbHNlIHB1c2godWkuZG9uZVVuc2VsZWN0ZWQoKSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRjb25zdCBuZENvbW1pdHRlZCA9IG5kSWR4ID09PSBzdC5jb21taXR0ZWRJbmRleDtcblx0XHRcdFx0aWYgKG5kQ3Vyc29yICYmICFmb2N1c05vdGVzKSB7XG5cdFx0XHRcdFx0cHVzaCh1aS5zbG90U2VsZWN0ZWQoT1RIRVJfT1BUSU9OX0xBQkVMLCBPVEhFUl9PUFRJT05fREVTQ1JJUFRJT04sIG5kQ29tbWl0dGVkKSk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0cHVzaCh1aS5zbG90VW5zZWxlY3RlZChPVEhFUl9PUFRJT05fTEFCRUwsIE9USEVSX09QVElPTl9ERVNDUklQVElPTiwgeyBpc0NvbW1pdHRlZDogbmRDb21taXR0ZWQsIGlzRm9jdXNEaW1tZWQ6IGZvY3VzTm90ZXMgfSkpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIFx1MjUwMFx1MjUwMCBOb3RlcyBhcmVhIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXHRcdFx0aWYgKHN0Lm5vdGVzVmlzaWJsZSB8fCBmb2N1c05vdGVzKSB7XG5cdFx0XHRcdHB1c2godWkuYmxhbmsoKSwgdWkubm90ZXNMYWJlbChmb2N1c05vdGVzKSk7XG5cdFx0XHRcdGlmIChmb2N1c05vdGVzKSB7XG5cdFx0XHRcdFx0Zm9yIChjb25zdCBsaW5lIG9mIGdldEVkaXRvcigpLnJlbmRlcih3aWR0aCAtIDIpKSBsaW5lcy5wdXNoKHRydW5jYXRlVG9XaWR0aChgICR7bGluZX1gLCB3aWR0aCkpO1xuXHRcdFx0XHR9IGVsc2UgaWYgKHN0Lm5vdGVzKSB7XG5cdFx0XHRcdFx0cHVzaCh1aS5ub3Rlc1RleHQoc3Qubm90ZXMpKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQvLyBcdTI1MDBcdTI1MDAgRm9vdGVyIGhpbnRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXHRcdFx0cHVzaCh1aS5ibGFuaygpKTtcblx0XHRcdGNvbnN0IGlzTGFzdCA9ICFpc011bHRpUXVlc3Rpb24gfHwgY3VycmVudElkeCA9PT0gcXVlc3Rpb25zLmxlbmd0aCAtIDE7XG5cdFx0XHRjb25zdCBoaW50czogc3RyaW5nW10gPSBbXTtcblx0XHRcdGlmIChmb2N1c05vdGVzKSB7XG5cdFx0XHRcdGhpbnRzLnB1c2goXCJlbnRlciB0byBjb25maXJtXCIpO1xuXHRcdFx0XHRoaW50cy5wdXNoKFwidGFiIG9yIGVzYyB0byBjbG9zZSBub3Rlc1wiKTtcblx0XHRcdH0gZWxzZSBpZiAobXVsdGlTZWwpIHtcblx0XHRcdFx0aGludHMucHVzaChcInNwYWNlIHRvIHRvZ2dsZVwiKTtcblx0XHRcdFx0aWYgKGlzTXVsdGlRdWVzdGlvbikgaGludHMucHVzaChcIlx1MjE5MC9cdTIxOTIgbmF2aWdhdGUgcXVlc3Rpb25zXCIpO1xuXHRcdFx0XHRoaW50cy5wdXNoKFwidGFiIHRvIGFkZCBub3Rlc1wiKTtcblx0XHRcdFx0aGludHMucHVzaChpc0xhc3QgJiYgYWxsQW5zd2VyZWQoKSA/IFwiZW50ZXIgdG8gcmV2aWV3XCIgOiBcImVudGVyIHRvIG5leHRcIik7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRoaW50cy5wdXNoKFwidGFiIHRvIGFkZCBub3Rlc1wiKTtcblx0XHRcdFx0aWYgKGlzTXVsdGlRdWVzdGlvbikgaGludHMucHVzaChcIlx1MjE5MC9cdTIxOTIgbmF2aWdhdGVcIik7XG5cdFx0XHRcdGhpbnRzLnB1c2goaXNMYXN0ICYmIGFsbEFuc3dlcmVkKCkgPyBcImVudGVyIHRvIHJldmlld1wiIDogXCJlbnRlciB0byBuZXh0XCIpO1xuXHRcdFx0fVxuXHRcdFx0aGludHMucHVzaChcImVzYyB0byBleGl0XCIpO1xuXHRcdFx0cHVzaCh1aS5oaW50cyhoaW50cyksIHVpLmJhcigpKTtcblxuXHRcdFx0Y2FjaGVkTGluZXMgPSBsaW5lcztcblx0XHRcdHJldHVybiBsaW5lcztcblx0XHR9XG5cblx0XHRyZXR1cm4ge1xuXHRcdFx0cmVuZGVyLFxuXHRcdFx0aW52YWxpZGF0ZTogKCkgPT4geyBjYWNoZWRMaW5lcyA9IHVuZGVmaW5lZDsgfSxcblx0XHRcdGhhbmRsZUlucHV0LFxuXHRcdH07XG5cdH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBNkJBLFNBQVMsd0JBQW9DO0FBQzdDO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUVNO0FBQ1AsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyxRQUFRLGNBQWM7QUE4RS9CLE1BQU0scUJBQXFCO0FBQzNCLE1BQU0sMkJBQTJCO0FBR2pDLE1BQU0sb0JBQW9CO0FBQzFCLE1BQU0sb0JBQW9CO0FBQzFCLE1BQU0sZ0JBQWdCO0FBQ3RCLE1BQU0sZ0JBQWdCO0FBQ3RCLE1BQU0sZ0JBQWdCO0FBQ3RCLE1BQU0sb0JBQW9CO0FBSTFCLGVBQXNCLGlCQUNyQixNQUNBLEtBQ3dCO0FBQ3hCLFNBQU8sSUFBSSxHQUFHLE9BQXFCLENBQUMsS0FBVSxPQUFjLEtBQUssU0FBUztBQUV6RSxRQUFJLFlBQVk7QUFDaEIsUUFBSTtBQUVKLGFBQVMsVUFBVTtBQUNsQixvQkFBYztBQUNkLFVBQUksY0FBYztBQUFBLElBQ25CO0FBRUEsYUFBUyxZQUFZLE1BQWM7QUFDbEMsVUFBSSxXQUFXLE1BQU0sSUFBSSxFQUFFLEtBQUssV0FBVyxNQUFNLElBQUksSUFBSSxH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
