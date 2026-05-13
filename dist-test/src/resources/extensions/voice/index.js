import { shortcutDesc } from "../shared/mod.js";
import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@gsd/pi-tui";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { linuxPython, diagnoseSounddeviceError, ensureVoiceVenv } from "./linux-ready.js";
import { homedir } from "node:os";
const __extensionDir = import.meta.dirname;
const SWIFT_SRC = path.join(__extensionDir, "speech-recognizer.swift");
const RECOGNIZER_BIN = path.join(__extensionDir, "speech-recognizer");
const PYTHON_SCRIPT = path.join(__extensionDir, "speech-recognizer.py");
const IS_DARWIN = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";
function ensureBinary() {
  if (fs.existsSync(RECOGNIZER_BIN)) return true;
  try {
    execFileSync("swiftc", [SWIFT_SRC, "-o", RECOGNIZER_BIN, "-framework", "Speech", "-framework", "AVFoundation"], {
      timeout: 6e4
    });
    return true;
  } catch {
    return false;
  }
}
let linuxReady = false;
function ensureLinuxReady(ctx) {
  if (linuxReady) return true;
  if (!process.env.GROQ_API_KEY) {
    ctx.ui.notify("Voice: GROQ_API_KEY not set \u2014 run 'gsd config' to configure", "error");
    return false;
  }
  try {
    execFileSync("which", ["python3"], { stdio: "pipe" });
  } catch {
    ctx.ui.notify("Voice: python3 not found \u2014 install with: sudo apt install python3", "error");
    return false;
  }
  const py = linuxPython();
  try {
    execFileSync(py, ["-c", "import sounddevice"], {
      stdio: "pipe",
      timeout: 1e4
    });
  } catch (err) {
    const stderr = err?.stderr?.toString() ?? "";
    const diagnosis = diagnoseSounddeviceError(stderr);
    if (diagnosis === "missing-module") {
      if (!ensureVoiceVenv({ notify: (msg, level) => ctx.ui.notify(msg, level) })) {
        return false;
      }
      linuxReady = true;
      return true;
    } else if (diagnosis === "missing-portaudio") {
      ctx.ui.notify("Voice: install libportaudio2 with: sudo apt install libportaudio2", "error");
    } else {
      ctx.ui.notify(`Voice: dependency check failed \u2014 ${stderr.split("\n")[0] || "unknown error"}`, "error");
    }
    return false;
  }
  linuxReady = true;
  return true;
}
function voice_default(pi) {
  if (!IS_DARWIN && !IS_LINUX) return;
  let active = false;
  let recognizerProcess = null;
  let flashOn = true;
  let flashTimer = null;
  let footerTui = null;
  function setVoiceFooter(ctx, on) {
    if (!on) {
      stopFlash();
      ctx.ui.setFooter(void 0);
      return;
    }
    flashOn = true;
    flashTimer = setInterval(() => {
      flashOn = !flashOn;
      footerTui?.requestRender();
    }, 500);
    ctx.ui.setFooter((tui, theme, footerData) => {
      footerTui = tui;
      const branchUnsub = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: branchUnsub,
        invalidate() {
        },
        render(width) {
          let pwd = process.cwd();
          const home = homedir();
          if (pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
          const branch = footerData.getGitBranch();
          if (branch) pwd = `${pwd} (${branch})`;
          const dot = flashOn ? theme.fg("error", "\u25CF") : theme.fg("dim", "\u25CF");
          const voiceTag = `${dot} ${theme.fg("error", "transcribing")}`;
          const voiceTagWidth = visibleWidth(voiceTag);
          const maxPwdWidth = width - voiceTagWidth - 2;
          const pwdStr = truncateToWidth(theme.fg("dim", pwd), maxPwdWidth, theme.fg("dim", "..."));
          const pad1 = " ".repeat(Math.max(1, width - visibleWidth(pwdStr) - voiceTagWidth));
          const row1 = truncateToWidth(pwdStr + pad1 + voiceTag, width);
          let totalInput = 0, totalOutput = 0, totalCost = 0;
          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              const m = entry.message;
              totalInput += m.usage.input;
              totalOutput += m.usage.output;
              totalCost += m.usage.cost.total;
            }
          }
          const fmt = (n) => n < 1e3 ? `${n}` : n < 1e4 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n / 1e3)}k`;
          const parts = [];
          if (totalInput) parts.push(`\u2191${fmt(totalInput)}`);
          if (totalOutput) parts.push(`\u2193${fmt(totalOutput)}`);
          if (totalCost) parts.push(`$${totalCost.toFixed(3)}`);
          const usage = ctx.getContextUsage();
          const ctxPct = usage?.percent !== null && usage?.percent !== void 0 ? `${usage.percent.toFixed(1)}%` : "?";
          const ctxWin = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          parts.push(`${ctxPct}/${fmt(ctxWin)}`);
          const statsLeft = theme.fg("dim", parts.join(" "));
          const modelRight = theme.fg("dim", ctx.model?.id || "no-model");
          const statsLeftW = visibleWidth(statsLeft);
          const modelRightW = visibleWidth(modelRight);
          const pad2 = " ".repeat(Math.max(2, width - statsLeftW - modelRightW));
          const row2 = truncateToWidth(statsLeft + pad2 + modelRight, width);
          return [row1, row2];
        }
      };
    });
  }
  function stopFlash() {
    if (flashTimer) {
      clearInterval(flashTimer);
      flashTimer = null;
    }
    footerTui = null;
  }
  async function toggleVoice(ctx) {
    if (active) {
      killRecognizer();
      active = false;
      setVoiceFooter(ctx, false);
      return;
    }
    if (IS_DARWIN) {
      if (!ensureBinary()) {
        ctx.ui.notify("Voice: failed to compile speech recognizer (need Xcode CLI tools)", "error");
        return;
      }
    } else if (IS_LINUX) {
      if (!ensureLinuxReady(ctx)) {
        return;
      }
    }
    active = true;
    setVoiceFooter(ctx, true);
    await runVoiceSession(ctx);
  }
  pi.registerCommand("voice", {
    description: "Toggle voice mode",
    handler: async (_args, ctx) => toggleVoice(ctx)
  });
  pi.registerShortcut("ctrl+alt+v", {
    description: shortcutDesc("Toggle voice mode", "/voice"),
    handler: async (ctx) => toggleVoice(ctx)
  });
  function killRecognizer() {
    if (recognizerProcess) {
      recognizerProcess.kill("SIGTERM");
      recognizerProcess = null;
    }
  }
  function startRecognizer(onPartial, onFinal, onError, onReady) {
    if (IS_LINUX) {
      recognizerProcess = spawn(linuxPython(), [PYTHON_SCRIPT], {
        stdio: ["pipe", "pipe", "pipe"]
      });
    } else {
      recognizerProcess = spawn(RECOGNIZER_BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
    }
    const rl = readline.createInterface({ input: recognizerProcess.stdout });
    rl.on("line", (line) => {
      if (line === "READY") {
        onReady();
        return;
      }
      if (line.startsWith("PARTIAL:")) onPartial(line.slice(8));
      else if (line.startsWith("FINAL:")) onFinal(line.slice(6));
      else if (line.startsWith("ERROR:")) onError(line.slice(6));
    });
    recognizerProcess.on("error", (err) => onError(err.message));
    recognizerProcess.on("exit", () => {
      recognizerProcess = null;
    });
  }
  async function runVoiceSession(ctx) {
    return new Promise((resolve) => {
      startRecognizer(
        (text) => {
          ctx.ui.setEditorText(text);
        },
        (text) => {
          ctx.ui.setEditorText(text);
        },
        (msg) => ctx.ui.notify(`Voice: ${msg}`, "error"),
        () => {
        }
      );
      ctx.ui.custom(
        (_tui, _theme, _kb, done) => ({
          render() {
            return [];
          },
          handleInput(data) {
            if (isKeyRelease(data)) return;
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
              killRecognizer();
              active = false;
              setVoiceFooter(ctx, false);
              done();
            }
          },
          invalidate() {
          }
        }),
        { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%" } }
      ).then(() => resolve());
    });
  }
}
export {
  voice_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3ZvaWNlL2luZGV4LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSwgRXh0ZW5zaW9uQ29udGV4dCB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgc2hvcnRjdXREZXNjIH0gZnJvbSBcIi4uL3NoYXJlZC9tb2QuanNcIjtcbmltcG9ydCB0eXBlIHsgQXNzaXN0YW50TWVzc2FnZSB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgeyBpc0tleVJlbGVhc2UsIEtleSwgbWF0Y2hlc0tleSwgdHJ1bmNhdGVUb1dpZHRoLCB2aXNpYmxlV2lkdGggfSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB7IHNwYXduLCBleGVjRmlsZVN5bmMsIHR5cGUgQ2hpbGRQcm9jZXNzIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0ICogYXMgZnMgZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0ICogYXMgcmVhZGxpbmUgZnJvbSBcIm5vZGU6cmVhZGxpbmVcIjtcbmltcG9ydCB7IGxpbnV4UHl0aG9uLCBkaWFnbm9zZVNvdW5kZGV2aWNlRXJyb3IsIGVuc3VyZVZvaWNlVmVudiwgVk9JQ0VfVkVOVl9QWVRIT04gfSBmcm9tIFwiLi9saW51eC1yZWFkeS5qc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmNvbnN0IF9fZXh0ZW5zaW9uRGlyID0gaW1wb3J0Lm1ldGEuZGlybmFtZSE7XG5jb25zdCBTV0lGVF9TUkMgPSBwYXRoLmpvaW4oX19leHRlbnNpb25EaXIsIFwic3BlZWNoLXJlY29nbml6ZXIuc3dpZnRcIik7XG5jb25zdCBSRUNPR05JWkVSX0JJTiA9IHBhdGguam9pbihfX2V4dGVuc2lvbkRpciwgXCJzcGVlY2gtcmVjb2duaXplclwiKTtcbmNvbnN0IFBZVEhPTl9TQ1JJUFQgPSBwYXRoLmpvaW4oX19leHRlbnNpb25EaXIsIFwic3BlZWNoLXJlY29nbml6ZXIucHlcIik7XG5cbmNvbnN0IElTX0RBUldJTiA9IHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCI7XG5jb25zdCBJU19MSU5VWCA9IHByb2Nlc3MucGxhdGZvcm0gPT09IFwibGludXhcIjtcblxuZnVuY3Rpb24gZW5zdXJlQmluYXJ5KCk6IGJvb2xlYW4ge1xuXHRpZiAoZnMuZXhpc3RzU3luYyhSRUNPR05JWkVSX0JJTikpIHJldHVybiB0cnVlO1xuXHR0cnkge1xuXHRcdGV4ZWNGaWxlU3luYyhcInN3aWZ0Y1wiLCBbU1dJRlRfU1JDLCBcIi1vXCIsIFJFQ09HTklaRVJfQklOLCBcIi1mcmFtZXdvcmtcIiwgXCJTcGVlY2hcIiwgXCItZnJhbWV3b3JrXCIsIFwiQVZGb3VuZGF0aW9uXCJdLCB7XG5cdFx0XHR0aW1lb3V0OiA2MDAwMCxcblx0XHR9KTtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fSBjYXRjaCB7XG5cdFx0cmV0dXJuIGZhbHNlO1xuXHR9XG59XG5cbmxldCBsaW51eFJlYWR5ID0gZmFsc2U7XG5cbmZ1bmN0aW9uIGVuc3VyZUxpbnV4UmVhZHkoY3R4OiBFeHRlbnNpb25Db250ZXh0KTogYm9vbGVhbiB7XG5cdGlmIChsaW51eFJlYWR5KSByZXR1cm4gdHJ1ZTtcblxuXHQvLyBDaGVjayBHUk9RX0FQSV9LRVkgaXMgYXZhaWxhYmxlXG5cdGlmICghcHJvY2Vzcy5lbnYuR1JPUV9BUElfS0VZKSB7XG5cdFx0Y3R4LnVpLm5vdGlmeShcIlZvaWNlOiBHUk9RX0FQSV9LRVkgbm90IHNldCBcdTIwMTQgcnVuICdnc2QgY29uZmlnJyB0byBjb25maWd1cmVcIiwgXCJlcnJvclwiKTtcblx0XHRyZXR1cm4gZmFsc2U7XG5cdH1cblxuXHQvLyBDaGVjayBweXRob24zIGV4aXN0c1xuXHR0cnkge1xuXHRcdGV4ZWNGaWxlU3luYyhcIndoaWNoXCIsIFtcInB5dGhvbjNcIl0sIHsgc3RkaW86IFwicGlwZVwiIH0pO1xuXHR9IGNhdGNoIHtcblx0XHRjdHgudWkubm90aWZ5KFwiVm9pY2U6IHB5dGhvbjMgbm90IGZvdW5kIFx1MjAxNCBpbnN0YWxsIHdpdGg6IHN1ZG8gYXB0IGluc3RhbGwgcHl0aG9uM1wiLCBcImVycm9yXCIpO1xuXHRcdHJldHVybiBmYWxzZTtcblx0fVxuXG5cdC8vIENoZWNrIHRoYXQgc291bmRkZXZpY2UgaXMgaW1wb3J0YWJsZVxuXHRjb25zdCBweSA9IGxpbnV4UHl0aG9uKCk7XG5cdHRyeSB7XG5cdFx0ZXhlY0ZpbGVTeW5jKHB5LCBbXCItY1wiLCBcImltcG9ydCBzb3VuZGRldmljZVwiXSwge1xuXHRcdFx0c3RkaW86IFwicGlwZVwiLFxuXHRcdFx0dGltZW91dDogMTAwMDAsXG5cdFx0fSk7XG5cdH0gY2F0Y2ggKGVycjogdW5rbm93bikge1xuXHRcdGNvbnN0IHN0ZGVyciA9IChlcnIgYXMgeyBzdGRlcnI/OiBCdWZmZXIgfSk/LnN0ZGVycj8udG9TdHJpbmcoKSA/PyBcIlwiO1xuXHRcdGNvbnN0IGRpYWdub3NpcyA9IGRpYWdub3NlU291bmRkZXZpY2VFcnJvcihzdGRlcnIpO1xuXG5cdFx0aWYgKGRpYWdub3NpcyA9PT0gXCJtaXNzaW5nLW1vZHVsZVwiKSB7XG5cdFx0XHQvLyBNb2R1bGUgbm90IGluc3RhbGxlZCBcdTIwMTQgYXV0by1jcmVhdGUgdmVudiAoaGFuZGxlcyBQRVAgNjY4IHN5c3RlbXNcblx0XHRcdC8vIHdoZXJlIHN5c3RlbSBwaXAgaXMgYmxvY2tlZCkuIFNlZSAjMjQwMy5cblx0XHRcdGlmICghZW5zdXJlVm9pY2VWZW52KHsgbm90aWZ5OiAobXNnLCBsZXZlbCkgPT4gY3R4LnVpLm5vdGlmeShtc2csIGxldmVsKSB9KSkge1xuXHRcdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0XHR9XG5cdFx0XHRsaW51eFJlYWR5ID0gdHJ1ZTtcblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH0gZWxzZSBpZiAoZGlhZ25vc2lzID09PSBcIm1pc3NpbmctcG9ydGF1ZGlvXCIpIHtcblx0XHRcdGN0eC51aS5ub3RpZnkoXCJWb2ljZTogaW5zdGFsbCBsaWJwb3J0YXVkaW8yIHdpdGg6IHN1ZG8gYXB0IGluc3RhbGwgbGlicG9ydGF1ZGlvMlwiLCBcImVycm9yXCIpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRjdHgudWkubm90aWZ5KGBWb2ljZTogZGVwZW5kZW5jeSBjaGVjayBmYWlsZWQgXHUyMDE0ICR7c3RkZXJyLnNwbGl0KFwiXFxuXCIpWzBdIHx8IFwidW5rbm93biBlcnJvclwifWAsIFwiZXJyb3JcIik7XG5cdFx0fVxuXHRcdHJldHVybiBmYWxzZTtcblx0fVxuXG5cdGxpbnV4UmVhZHkgPSB0cnVlO1xuXHRyZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gKHBpOiBFeHRlbnNpb25BUEkpIHtcblx0aWYgKCFJU19EQVJXSU4gJiYgIUlTX0xJTlVYKSByZXR1cm47XG5cblx0bGV0IGFjdGl2ZSA9IGZhbHNlO1xuXHRsZXQgcmVjb2duaXplclByb2Nlc3M6IENoaWxkUHJvY2VzcyB8IG51bGwgPSBudWxsO1xuXHRsZXQgZmxhc2hPbiA9IHRydWU7XG5cdGxldCBmbGFzaFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCBudWxsID0gbnVsbDtcblx0bGV0IGZvb3RlclR1aTogeyByZXF1ZXN0UmVuZGVyOiAoKSA9PiB2b2lkIH0gfCBudWxsID0gbnVsbDtcblxuXHRmdW5jdGlvbiBzZXRWb2ljZUZvb3RlcihjdHg6IEV4dGVuc2lvbkNvbnRleHQsIG9uOiBib29sZWFuKSB7XG5cdFx0aWYgKCFvbikge1xuXHRcdFx0c3RvcEZsYXNoKCk7XG5cdFx0XHRjdHgudWkuc2V0Rm9vdGVyKHVuZGVmaW5lZCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Zmxhc2hPbiA9IHRydWU7XG5cdFx0Zmxhc2hUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcblx0XHRcdGZsYXNoT24gPSAhZmxhc2hPbjtcblx0XHRcdGZvb3RlclR1aT8ucmVxdWVzdFJlbmRlcigpO1xuXHRcdH0sIDUwMCk7XG5cblx0XHRjdHgudWkuc2V0Rm9vdGVyKCh0dWksIHRoZW1lLCBmb290ZXJEYXRhKSA9PiB7XG5cdFx0XHRmb290ZXJUdWkgPSB0dWk7XG5cdFx0XHRjb25zdCBicmFuY2hVbnN1YiA9IGZvb3RlckRhdGEub25CcmFuY2hDaGFuZ2UoKCkgPT4gdHVpLnJlcXVlc3RSZW5kZXIoKSk7XG5cblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdGRpc3Bvc2U6IGJyYW5jaFVuc3ViLFxuXHRcdFx0XHRpbnZhbGlkYXRlKCkge30sXG5cdFx0XHRcdHJlbmRlcih3aWR0aDogbnVtYmVyKTogc3RyaW5nW10ge1xuXHRcdFx0XHRcdC8vIFJvdyAxOiBwd2QgKGJyYW5jaCkgLi4uIFx1MjVDRiB0cmFuc2NyaWJpbmdcblx0XHRcdFx0XHRsZXQgcHdkID0gcHJvY2Vzcy5jd2QoKTtcblx0XHRcdFx0XHRjb25zdCBob21lID0gaG9tZWRpcigpO1xuXHRcdFx0XHRcdGlmIChwd2Quc3RhcnRzV2l0aChob21lKSkgcHdkID0gYH4ke3B3ZC5zbGljZShob21lLmxlbmd0aCl9YDtcblx0XHRcdFx0XHRjb25zdCBicmFuY2ggPSBmb290ZXJEYXRhLmdldEdpdEJyYW5jaCgpO1xuXHRcdFx0XHRcdGlmIChicmFuY2gpIHB3ZCA9IGAke3B3ZH0gKCR7YnJhbmNofSlgO1xuXG5cdFx0XHRcdFx0Y29uc3QgZG90ID0gZmxhc2hPbiA/IHRoZW1lLmZnKFwiZXJyb3JcIiwgXCJcdTI1Q0ZcIikgOiB0aGVtZS5mZyhcImRpbVwiLCBcIlx1MjVDRlwiKTtcblx0XHRcdFx0XHRjb25zdCB2b2ljZVRhZyA9IGAke2RvdH0gJHt0aGVtZS5mZyhcImVycm9yXCIsIFwidHJhbnNjcmliaW5nXCIpfWA7XG5cdFx0XHRcdFx0Y29uc3Qgdm9pY2VUYWdXaWR0aCA9IHZpc2libGVXaWR0aCh2b2ljZVRhZyk7XG5cblx0XHRcdFx0XHRjb25zdCBtYXhQd2RXaWR0aCA9IHdpZHRoIC0gdm9pY2VUYWdXaWR0aCAtIDI7XG5cdFx0XHRcdFx0Y29uc3QgcHdkU3RyID0gdHJ1bmNhdGVUb1dpZHRoKHRoZW1lLmZnKFwiZGltXCIsIHB3ZCksIG1heFB3ZFdpZHRoLCB0aGVtZS5mZyhcImRpbVwiLCBcIi4uLlwiKSk7XG5cdFx0XHRcdFx0Y29uc3QgcGFkMSA9IFwiIFwiLnJlcGVhdChNYXRoLm1heCgxLCB3aWR0aCAtIHZpc2libGVXaWR0aChwd2RTdHIpIC0gdm9pY2VUYWdXaWR0aCkpO1xuXHRcdFx0XHRcdGNvbnN0IHJvdzEgPSB0cnVuY2F0ZVRvV2lkdGgocHdkU3RyICsgcGFkMSArIHZvaWNlVGFnLCB3aWR0aCk7XG5cblx0XHRcdFx0XHQvLyBSb3cgMjogc3RhdHMgLi4uIG1vZGVsXG5cdFx0XHRcdFx0bGV0IHRvdGFsSW5wdXQgPSAwLCB0b3RhbE91dHB1dCA9IDAsIHRvdGFsQ29zdCA9IDA7XG5cdFx0XHRcdFx0Zm9yIChjb25zdCBlbnRyeSBvZiBjdHguc2Vzc2lvbk1hbmFnZXIuZ2V0RW50cmllcygpKSB7XG5cdFx0XHRcdFx0XHRpZiAoZW50cnkudHlwZSA9PT0gXCJtZXNzYWdlXCIgJiYgZW50cnkubWVzc2FnZS5yb2xlID09PSBcImFzc2lzdGFudFwiKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IG0gPSBlbnRyeS5tZXNzYWdlIGFzIEFzc2lzdGFudE1lc3NhZ2U7XG5cdFx0XHRcdFx0XHRcdHRvdGFsSW5wdXQgKz0gbS51c2FnZS5pbnB1dDtcblx0XHRcdFx0XHRcdFx0dG90YWxPdXRwdXQgKz0gbS51c2FnZS5vdXRwdXQ7XG5cdFx0XHRcdFx0XHRcdHRvdGFsQ29zdCArPSBtLnVzYWdlLmNvc3QudG90YWw7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y29uc3QgZm10ID0gKG46IG51bWJlcikgPT4gbiA8IDEwMDAgPyBgJHtufWAgOiBuIDwgMTAwMDAgPyBgJHsobiAvIDEwMDApLnRvRml4ZWQoMSl9a2AgOiBgJHtNYXRoLnJvdW5kKG4gLyAxMDAwKX1rYDtcblx0XHRcdFx0XHRjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcblx0XHRcdFx0XHRpZiAodG90YWxJbnB1dCkgcGFydHMucHVzaChgXHUyMTkxJHtmbXQodG90YWxJbnB1dCl9YCk7XG5cdFx0XHRcdFx0aWYgKHRvdGFsT3V0cHV0KSBwYXJ0cy5wdXNoKGBcdTIxOTMke2ZtdCh0b3RhbE91dHB1dCl9YCk7XG5cdFx0XHRcdFx0aWYgKHRvdGFsQ29zdCkgcGFydHMucHVzaChgJCR7dG90YWxDb3N0LnRvRml4ZWQoMyl9YCk7XG5cblx0XHRcdFx0XHRjb25zdCB1c2FnZSA9IGN0eC5nZXRDb250ZXh0VXNhZ2UoKTtcblx0XHRcdFx0XHRjb25zdCBjdHhQY3QgPSB1c2FnZT8ucGVyY2VudCAhPT0gbnVsbCAmJiB1c2FnZT8ucGVyY2VudCAhPT0gdW5kZWZpbmVkID8gYCR7dXNhZ2UucGVyY2VudC50b0ZpeGVkKDEpfSVgIDogXCI/XCI7XG5cdFx0XHRcdFx0Y29uc3QgY3R4V2luID0gdXNhZ2U/LmNvbnRleHRXaW5kb3cgPz8gY3R4Lm1vZGVsPy5jb250ZXh0V2luZG93ID8/IDA7XG5cdFx0XHRcdFx0cGFydHMucHVzaChgJHtjdHhQY3R9LyR7Zm10KGN0eFdpbil9YCk7XG5cblx0XHRcdFx0XHRjb25zdCBzdGF0c0xlZnQgPSB0aGVtZS5mZyhcImRpbVwiLCBwYXJ0cy5qb2luKFwiIFwiKSk7XG5cdFx0XHRcdFx0Y29uc3QgbW9kZWxSaWdodCA9IHRoZW1lLmZnKFwiZGltXCIsIGN0eC5tb2RlbD8uaWQgfHwgXCJuby1tb2RlbFwiKTtcblx0XHRcdFx0XHRjb25zdCBzdGF0c0xlZnRXID0gdmlzaWJsZVdpZHRoKHN0YXRzTGVmdCk7XG5cdFx0XHRcdFx0Y29uc3QgbW9kZWxSaWdodFcgPSB2aXNpYmxlV2lkdGgobW9kZWxSaWdodCk7XG5cdFx0XHRcdFx0Y29uc3QgcGFkMiA9IFwiIFwiLnJlcGVhdChNYXRoLm1heCgyLCB3aWR0aCAtIHN0YXRzTGVmdFcgLSBtb2RlbFJpZ2h0VykpO1xuXHRcdFx0XHRcdGNvbnN0IHJvdzIgPSB0cnVuY2F0ZVRvV2lkdGgoc3RhdHNMZWZ0ICsgcGFkMiArIG1vZGVsUmlnaHQsIHdpZHRoKTtcblxuXHRcdFx0XHRcdHJldHVybiBbcm93MSwgcm93Ml07XG5cdFx0XHRcdH0sXG5cdFx0XHR9O1xuXHRcdH0pO1xuXHR9XG5cblx0ZnVuY3Rpb24gc3RvcEZsYXNoKCkge1xuXHRcdGlmIChmbGFzaFRpbWVyKSB7IGNsZWFySW50ZXJ2YWwoZmxhc2hUaW1lcik7IGZsYXNoVGltZXIgPSBudWxsOyB9XG5cdFx0Zm9vdGVyVHVpID0gbnVsbDtcblx0fVxuXG5cdGFzeW5jIGZ1bmN0aW9uIHRvZ2dsZVZvaWNlKGN0eDogRXh0ZW5zaW9uQ29udGV4dCkge1xuXHRcdGlmIChhY3RpdmUpIHtcblx0XHRcdGtpbGxSZWNvZ25pemVyKCk7XG5cdFx0XHRhY3RpdmUgPSBmYWxzZTtcblx0XHRcdHNldFZvaWNlRm9vdGVyKGN0eCwgZmFsc2UpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGlmIChJU19EQVJXSU4pIHtcblx0XHRcdGlmICghZW5zdXJlQmluYXJ5KCkpIHtcblx0XHRcdFx0Y3R4LnVpLm5vdGlmeShcIlZvaWNlOiBmYWlsZWQgdG8gY29tcGlsZSBzcGVlY2ggcmVjb2duaXplciAobmVlZCBYY29kZSBDTEkgdG9vbHMpXCIsIFwiZXJyb3JcIik7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKElTX0xJTlVYKSB7XG5cdFx0XHRpZiAoIWVuc3VyZUxpbnV4UmVhZHkoY3R4KSkge1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0YWN0aXZlID0gdHJ1ZTtcblx0XHRzZXRWb2ljZUZvb3RlcihjdHgsIHRydWUpO1xuXHRcdGF3YWl0IHJ1blZvaWNlU2Vzc2lvbihjdHgpO1xuXHR9XG5cblx0cGkucmVnaXN0ZXJDb21tYW5kKFwidm9pY2VcIiwge1xuXHRcdGRlc2NyaXB0aW9uOiBcIlRvZ2dsZSB2b2ljZSBtb2RlXCIsXG5cdFx0aGFuZGxlcjogYXN5bmMgKF9hcmdzLCBjdHgpID0+IHRvZ2dsZVZvaWNlKGN0eCksXG5cdH0pO1xuXG5cdHBpLnJlZ2lzdGVyU2hvcnRjdXQoXCJjdHJsK2FsdCt2XCIsIHtcblx0XHRkZXNjcmlwdGlvbjogc2hvcnRjdXREZXNjKFwiVG9nZ2xlIHZvaWNlIG1vZGVcIiwgXCIvdm9pY2VcIiksXG5cdFx0aGFuZGxlcjogYXN5bmMgKGN0eCkgPT4gdG9nZ2xlVm9pY2UoY3R4KSxcblx0fSk7XG5cblx0ZnVuY3Rpb24ga2lsbFJlY29nbml6ZXIoKSB7XG5cdFx0aWYgKHJlY29nbml6ZXJQcm9jZXNzKSB7IHJlY29nbml6ZXJQcm9jZXNzLmtpbGwoXCJTSUdURVJNXCIpOyByZWNvZ25pemVyUHJvY2VzcyA9IG51bGw7IH1cblx0fVxuXG5cdGZ1bmN0aW9uIHN0YXJ0UmVjb2duaXplcihcblx0XHRvblBhcnRpYWw6ICh0ZXh0OiBzdHJpbmcpID0+IHZvaWQsXG5cdFx0b25GaW5hbDogKHRleHQ6IHN0cmluZykgPT4gdm9pZCxcblx0XHRvbkVycm9yOiAobXNnOiBzdHJpbmcpID0+IHZvaWQsXG5cdFx0b25SZWFkeTogKCkgPT4gdm9pZCxcblx0KSB7XG5cdFx0aWYgKElTX0xJTlVYKSB7XG5cdFx0XHRyZWNvZ25pemVyUHJvY2VzcyA9IHNwYXduKGxpbnV4UHl0aG9uKCksIFtQWVRIT05fU0NSSVBUXSwge1xuXHRcdFx0XHRzdGRpbzogW1wicGlwZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuXHRcdFx0fSk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHJlY29nbml6ZXJQcm9jZXNzID0gc3Bhd24oUkVDT0dOSVpFUl9CSU4sIFtdLCB7IHN0ZGlvOiBbXCJwaXBlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0gfSk7XG5cdFx0fVxuXHRcdGNvbnN0IHJsID0gcmVhZGxpbmUuY3JlYXRlSW50ZXJmYWNlKHsgaW5wdXQ6IHJlY29nbml6ZXJQcm9jZXNzLnN0ZG91dCEgfSk7XG5cdFx0cmwub24oXCJsaW5lXCIsIChsaW5lOiBzdHJpbmcpID0+IHtcblx0XHRcdGlmIChsaW5lID09PSBcIlJFQURZXCIpIHsgb25SZWFkeSgpOyByZXR1cm47IH1cblx0XHRcdGlmIChsaW5lLnN0YXJ0c1dpdGgoXCJQQVJUSUFMOlwiKSkgb25QYXJ0aWFsKGxpbmUuc2xpY2UoOCkpO1xuXHRcdFx0ZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKFwiRklOQUw6XCIpKSBvbkZpbmFsKGxpbmUuc2xpY2UoNikpO1xuXHRcdFx0ZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKFwiRVJST1I6XCIpKSBvbkVycm9yKGxpbmUuc2xpY2UoNikpO1xuXHRcdH0pO1xuXHRcdHJlY29nbml6ZXJQcm9jZXNzLm9uKFwiZXJyb3JcIiwgKGVycikgPT4gb25FcnJvcihlcnIubWVzc2FnZSkpO1xuXHRcdHJlY29nbml6ZXJQcm9jZXNzLm9uKFwiZXhpdFwiLCAoKSA9PiB7IHJlY29nbml6ZXJQcm9jZXNzID0gbnVsbDsgfSk7XG5cdH1cblxuXHRhc3luYyBmdW5jdGlvbiBydW5Wb2ljZVNlc3Npb24oY3R4OiBFeHRlbnNpb25Db250ZXh0KTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG5cdFx0XHQvLyBUaGUgU3dpZnQgcmVjb2duaXplciBoYW5kbGVzIGFjY3VtdWxhdGlvbiBhY3Jvc3MgcGF1c2UtaW5kdWNlZFxuXHRcdFx0Ly8gdHJhbnNjcmlwdGlvbiByZXNldHMuIEJvdGggUEFSVElBTCBhbmQgRklOQUwgbWVzc2FnZXMgY29udGFpblxuXHRcdFx0Ly8gdGhlIGZ1bGwgYWNjdW11bGF0ZWQgdGV4dCwgc28gd2UganVzdCBwYXNzIHRoZW0gdGhyb3VnaC5cblx0XHRcdHN0YXJ0UmVjb2duaXplcihcblx0XHRcdFx0KHRleHQpID0+IHtcblx0XHRcdFx0XHRjdHgudWkuc2V0RWRpdG9yVGV4dCh0ZXh0KTtcblx0XHRcdFx0fSxcblx0XHRcdFx0KHRleHQpID0+IHtcblx0XHRcdFx0XHRjdHgudWkuc2V0RWRpdG9yVGV4dCh0ZXh0KTtcblx0XHRcdFx0fSxcblx0XHRcdFx0KG1zZykgPT4gY3R4LnVpLm5vdGlmeShgVm9pY2U6ICR7bXNnfWAsIFwiZXJyb3JcIiksXG5cdFx0XHRcdCgpID0+IHt9LFxuXHRcdFx0KTtcblxuXHRcdFx0Y3R4LnVpLmN1c3RvbTx2b2lkPihcblx0XHRcdFx0KF90dWksIF90aGVtZSwgX2tiLCBkb25lKSA9PiAoe1xuXHRcdFx0XHRcdHJlbmRlcigpOiBzdHJpbmdbXSB7IHJldHVybiBbXTsgfSxcblx0XHRcdFx0XHRoYW5kbGVJbnB1dChkYXRhOiBzdHJpbmcpIHtcblx0XHRcdFx0XHRcdGlmIChpc0tleVJlbGVhc2UoZGF0YSkpIHJldHVybjtcblx0XHRcdFx0XHRcdGlmIChtYXRjaGVzS2V5KGRhdGEsIEtleS5lc2NhcGUpIHx8IG1hdGNoZXNLZXkoZGF0YSwgS2V5LmVudGVyKSkge1xuXHRcdFx0XHRcdFx0XHRraWxsUmVjb2duaXplcigpO1xuXHRcdFx0XHRcdFx0XHRhY3RpdmUgPSBmYWxzZTtcblx0XHRcdFx0XHRcdFx0c2V0Vm9pY2VGb290ZXIoY3R4LCBmYWxzZSk7XG5cdFx0XHRcdFx0XHRcdGRvbmUoKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdGludmFsaWRhdGUoKSB7fSxcblx0XHRcdFx0fSksXG5cdFx0XHRcdHsgb3ZlcmxheTogdHJ1ZSwgb3ZlcmxheU9wdGlvbnM6IHsgYW5jaG9yOiBcImJvdHRvbS1jZW50ZXJcIiwgd2lkdGg6IFwiMTAwJVwiIH0gfSxcblx0XHRcdCkudGhlbigoKSA9PiByZXNvbHZlKCkpO1xuXHRcdH0pO1xuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLG9CQUFvQjtBQUU3QixTQUFTLGNBQWMsS0FBSyxZQUFZLGlCQUFpQixvQkFBb0I7QUFDN0UsU0FBUyxPQUFPLG9CQUF1QztBQUN2RCxZQUFZLFFBQVE7QUFDcEIsWUFBWSxVQUFVO0FBQ3RCLFlBQVksY0FBYztBQUMxQixTQUFTLGFBQWEsMEJBQTBCLHVCQUEwQztBQUMxRixTQUFTLGVBQWU7QUFFeEIsTUFBTSxpQkFBaUIsWUFBWTtBQUNuQyxNQUFNLFlBQVksS0FBSyxLQUFLLGdCQUFnQix5QkFBeUI7QUFDckUsTUFBTSxpQkFBaUIsS0FBSyxLQUFLLGdCQUFnQixtQkFBbUI7QUFDcEUsTUFBTSxnQkFBZ0IsS0FBSyxLQUFLLGdCQUFnQixzQkFBc0I7QUFFdEUsTUFBTSxZQUFZLFFBQVEsYUFBYTtBQUN2QyxNQUFNLFdBQVcsUUFBUSxhQUFhO0FBRXRDLFNBQVMsZUFBd0I7QUFDaEMsTUFBSSxHQUFHLFdBQVcsY0FBYyxFQUFHLFFBQU87QUFDMUMsTUFBSTtBQUNILGlCQUFhLFVBQVUsQ0FBQyxXQUFXLE1BQU0sZ0JBQWdCLGNBQWMsVUFBVSxjQUFjLGNBQWMsR0FBRztBQUFBLE1BQy9HLFNBQVM7QUFBQSxJQUNWLENBQUM7QUFDRCxXQUFPO0FBQUEsRUFDUixRQUFRO0FBQ1AsV0FBTztBQUFBLEVBQ1I7QUFDRDtBQUVBLElBQUksYUFBYTtBQUVqQixTQUFTLGlCQUFpQixLQUFnQztBQUN6RCxNQUFJLFdBQVksUUFBTztBQUd2QixNQUFJLENBQUMsUUFBUSxJQUFJLGNBQWM7QUFDOUIsUUFBSSxHQUFHLE9BQU8sb0VBQStELE9BQU87QUFDcEYsV0FBTztBQUFBLEVBQ1I7QUFHQSxNQUFJO0FBQ0gsaUJBQWEsU0FBUyxDQUFDLFNBQVMsR0FBRyxFQUFFLE9BQU8sT0FBTyxDQUFDO0FBQUEsRUFDckQsUUFBUTtBQUNQLFFBQUksR0FBRyxPQUFPLDBFQUFxRSxPQUFPO0FBQzFGLFdBQU87QUFBQSxFQUNSO0FBR0EsUUFBTSxLQUFLLFlBQVk7QUFDdkIsTUFBSTtBQUNILGlCQUFhLElBQUksQ0FBQyxNQUFNLG9CQUFvQixHQUFHO0FBQUEsTUFDOUMsT0FBTztBQUFBLE1BQ1AsU0FBUztBQUFBLElBQ1YsQ0FBQztBQUFBLEVBQ0YsU0FBUyxLQUFjO0FBQ3RCLFVBQU0sU0FBVSxLQUE2QixRQUFRLFNBQVMsS0FBSztBQUNuRSxVQUFNLFlBQVkseUJBQXlCLE1BQU07QUFFakQsUUFBSSxjQUFjLGtCQUFrQjtBQUduQyxVQUFJLENBQUMsZ0JBQWdCLEVBQUUsUUFBUSxDQUFDLEtBQUssVUFBVSxJQUFJLEdBQUcsT0FBTyxLQUFLLEtBQUssRUFBRSxDQUFDLEdBQUc7QUFDNUUsZUFBTztBQUFBLE1BQ1I7QUFDQSxtQkFBYTtBQUNiLGFBQU87QUFBQSxJQUNSLFdBQVcsY0FBYyxxQkFBcUI7QUFDN0MsVUFBSSxHQUFHLE9BQU8scUVBQXFFLE9BQU87QUFBQSxJQUMzRixPQUFPO0FBQ04sVUFBSSxHQUFHLE9BQU8seUNBQW9DLE9BQU8sTUFBTSxJQUFJLEVBQUUsQ0FBQyxLQUFLLGVBQWUsSUFBSSxPQUFPO0FBQUEsSUFDdEc7QUFDQSxXQUFPO0FBQUEsRUFDUjtBQUVBLGVBQWE7QUFDYixTQUFPO0FBQ1I7QUFFZSxTQUFSLGNBQWtCLElBQWtCO0FBQzFDLE1BQUksQ0FBQyxhQUFhLENBQUMsU0FBVTtBQUU3QixNQUFJLFNBQVM7QUFDYixNQUFJLG9CQUF5QztBQUM3QyxNQUFJLFVBQVU7QUFDZCxNQUFJLGFBQW9EO0FBQ3hELE1BQUksWUFBa0Q7QUFFdEQsV0FBUyxlQUFlLEtBQXVCLElBQWE7QUFDM0QsUUFBSSxDQUFDLElBQUk7QUFDUixnQkFBVTtBQUNWLFVBQUksR0FBRyxVQUFVLE1BQVM7QUFDMUI7QUFBQSxJQUNEO0FBRUEsY0FBVTtBQUNWLGlCQUFhLFlBQVksTUFBTTtBQUM5QixnQkFBVSxDQUFDO0FBQ1gsaUJBQVcsY0FBYztBQUFBLElBQzFCLEdBQUcsR0FBRztBQUVOLFFBQUksR0FBRyxVQUFVLENBQUMsS0FBSyxPQUFPLGVBQWU7QUFDNUMsa0JBQVk7QUFDWixZQUFNLGNBQWMsV0FBVyxlQUFlLE1BQU0sSUFBSSxjQUFjLENBQUM7QUFFdkUsYUFBTztBQUFBLFFBQ04sU0FBUztBQUFBLFFBQ1QsYUFBYTtBQUFBLFFBQUM7QUFBQSxRQUNkLE9BQU8sT0FBeUI7QUFFL0IsY0FBSSxNQUFNLFFBQVEsSUFBSTtBQUN0QixnQkFBTSxPQUFPLFFBQVE7QUFDckIsY0FBSSxJQUFJLFdBQVcsSUFBSSxFQUFHLE9BQU0sSUFBSSxJQUFJLE1BQU0sS0FBSyxNQUFNLENBQUM7QUFDMUQsZ0JBQU0sU0FBUyxXQUFXLGFBQWE7QUFDdkMsY0FBSSxPQUFRLE9BQU0sR0FBRyxHQUFHLEtBQUssTUFBTTtBQUVuQyxnQkFBTSxNQUFNLFVBQVUsTUFBTSxHQUFHLFNBQVMsUUFBRyxJQUFJLE1BQU0sR0FBRyxPQUFPLFFBQUc7QUFDbEUsZ0JBQU0sV0FBVyxHQUFHLEdBQUcsSUFBSSxNQUFNLEdBQUcsU0FBUyxjQUFjLENBQUM7QUFDNUQsZ0JBQU0sZ0JBQWdCLGFBQWEsUUFBUTtBQUUzQyxnQkFBTSxjQUFjLFFBQVEsZ0JBQWdCO0FBQzVDLGdCQUFNLFNBQVMsZ0JBQWdCLE1BQU0sR0FBRyxPQUFPLEdBQUcsR0FBRyxhQUFhLE1BQU0sR0FBRyxPQUFPLEtBQUssQ0FBQztBQUN4RixnQkFBTSxPQUFPLElBQUksT0FBTyxLQUFLLElBQUksR0FBRyxRQUFRLGFBQWEsTUFBTSxJQUFJLGFBQWEsQ0FBQztBQUNqRixnQkFBTSxPQUFPLGdCQUFnQixTQUFTLE9BQU8sVUFBVSxLQUFLO0FBRzVELGNBQUksYUFBYSxHQUFHLGNBQWMsR0FBRyxZQUFZO0FBQ2pELHFCQUFXLFNBQVMsSUFBSSxlQUFlLFdBQVcsR0FBRztBQUNwRCxnQkFBSSxNQUFNLFNBQVMsYUFBYSxNQUFNLFFBQVEsU0FBUyxhQUFhO0FBQ25FLG9CQUFNLElBQUksTUFBTTtBQUNoQiw0QkFBYyxFQUFFLE1BQU07QUFDdEIsNkJBQWUsRUFBRSxNQUFNO0FBQ3ZCLDJCQUFhLEVBQUUsTUFBTSxLQUFLO0FBQUEsWUFDM0I7QUFBQSxVQUNEO0FBRUEsZ0JBQU0sTUFBTSxDQUFDLE1BQWMsSUFBSSxNQUFPLEdBQUcsQ0FBQyxLQUFLLElBQUksTUFBUSxJQUFJLElBQUksS0FBTSxRQUFRLENBQUMsQ0FBQyxNQUFNLEdBQUcsS0FBSyxNQUFNLElBQUksR0FBSSxDQUFDO0FBQ2hILGdCQUFNLFFBQWtCLENBQUM7QUFDekIsY0FBSSxXQUFZLE9BQU0sS0FBSyxTQUFJLElBQUksVUFBVSxDQUFDLEVBQUU7QUFDaEQsY0FBSSxZQUFhLE9BQU0sS0FBSyxTQUFJLElBQUksV0FBVyxDQUFDLEVBQUU7QUFDbEQsY0FBSSxVQUFXLE9BQU0sS0FBSyxJQUFJLFVBQVUsUUFBUSxDQUFDLENBQUMsRUFBRTtBQUVwRCxnQkFBTSxRQUFRLElBQUksZ0JBQWdCO0FBQ2xDLGdCQUFNLFNBQVMsT0FBTyxZQUFZLFFBQVEsT0FBTyxZQUFZLFNBQVksR0FBRyxNQUFNLFFBQVEsUUFBUSxDQUFDLENBQUMsTUFBTTtBQUMxRyxnQkFBTSxTQUFTLE9BQU8saUJBQWlCLElBQUksT0FBTyxpQkFBaUI7QUFDbkUsZ0JBQU0sS0FBSyxHQUFHLE1BQU0sSUFBSSxJQUFJLE1BQU0sQ0FBQyxFQUFFO0FBRXJDLGdCQUFNLFlBQVksTUFBTSxHQUFHLE9BQU8sTUFBTSxLQUFLLEdBQUcsQ0FBQztBQUNqRCxnQkFBTSxhQUFhLE1BQU0sR0FBRyxPQUFPLElBQUksT0FBTyxNQUFNLFVBQVU7QUFDOUQsZ0JBQU0sYUFBYSxhQUFhLFNBQVM7QUFDekMsZ0JBQU0sY0FBYyxhQUFhLFVBQVU7QUFDM0MsZ0JBQU0sT0FBTyxJQUFJLE9BQU8sS0FBSyxJQUFJLEdBQUcsUUFBUSxhQUFhLFdBQVcsQ0FBQztBQUNyRSxnQkFBTSxPQUFPLGdCQUFnQixZQUFZLE9BQU8sWUFBWSxLQUFLO0FBRWpFLGlCQUFPLENBQUMsTUFBTSxJQUFJO0FBQUEsUUFDbkI7QUFBQSxNQUNEO0FBQUEsSUFDRCxDQUFDO0FBQUEsRUFDRjtBQUVBLFdBQVMsWUFBWTtBQUNwQixRQUFJLFlBQVk7QUFBRSxvQkFBYyxVQUFVO0FBQUcsbUJBQWE7QUFBQSxJQUFNO0FBQ2hFLGdCQUFZO0FBQUEsRUFDYjtBQUVBLGlCQUFlLFlBQVksS0FBdUI7QUFDakQsUUFBSSxRQUFRO0FBQ1gscUJBQWU7QUFDZixlQUFTO0FBQ1QscUJBQWUsS0FBSyxLQUFLO0FBQ3pCO0FBQUEsSUFDRDtBQUVBLFFBQUksV0FBVztBQUNkLFVBQUksQ0FBQyxhQUFhLEdBQUc7QUFDcEIsWUFBSSxHQUFHLE9BQU8scUVBQXFFLE9BQU87QUFDMUY7QUFBQSxNQUNEO0FBQUEsSUFDRCxXQUFXLFVBQVU7QUFDcEIsVUFBSSxDQUFDLGlCQUFpQixHQUFHLEdBQUc7QUFDM0I7QUFBQSxNQUNEO0FBQUEsSUFDRDtBQUVBLGFBQVM7QUFDVCxtQkFBZSxLQUFLLElBQUk7QUFDeEIsVUFBTSxnQkFBZ0IsR0FBRztBQUFBLEVBQzFCO0FBRUEsS0FBRyxnQkFBZ0IsU0FBUztBQUFBLElBQzNCLGFBQWE7QUFBQSxJQUNiLFNBQVMsT0FBTyxPQUFPLFFBQVEsWUFBWSxHQUFHO0FBQUEsRUFDL0MsQ0FBQztBQUVELEtBQUcsaUJBQWlCLGNBQWM7QUFBQSxJQUNqQyxhQUFhLGFBQWEscUJBQXFCLFFBQVE7QUFBQSxJQUN2RCxTQUFTLE9BQU8sUUFBUSxZQUFZLEdBQUc7QUFBQSxFQUN4QyxDQUFDO0FBRUQsV0FBUyxpQkFBaUI7QUFDekIsUUFBSSxtQkFBbUI7QUFBRSx3QkFBa0IsS0FBSyxTQUFTO0FBQUcsMEJBQW9CO0FBQUEsSUFBTTtBQUFBLEVBQ3ZGO0FBRUEsV0FBUyxnQkFDUixXQUNBLFNBQ0EsU0FDQSxTQUNDO0FBQ0QsUUFBSSxVQUFVO0FBQ2IsMEJBQW9CLE1BQU0sWUFBWSxHQUFHLENBQUMsYUFBYSxHQUFHO0FBQUEsUUFDekQsT0FBTyxDQUFDLFFBQVEsUUFBUSxNQUFNO0FBQUEsTUFDL0IsQ0FBQztBQUFBLElBQ0YsT0FBTztBQUNOLDBCQUFvQixNQUFNLGdCQUFnQixDQUFDLEdBQUcsRUFBRSxPQUFPLENBQUMsUUFBUSxRQUFRLE1BQU0sRUFBRSxDQUFDO0FBQUEsSUFDbEY7QUFDQSxVQUFNLEtBQUssU0FBUyxnQkFBZ0IsRUFBRSxPQUFPLGtCQUFrQixPQUFRLENBQUM7QUFDeEUsT0FBRyxHQUFHLFFBQVEsQ0FBQyxTQUFpQjtBQUMvQixVQUFJLFNBQVMsU0FBUztBQUFFLGdCQUFRO0FBQUc7QUFBQSxNQUFRO0FBQzNDLFVBQUksS0FBSyxXQUFXLFVBQVUsRUFBRyxXQUFVLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQSxlQUMvQyxLQUFLLFdBQVcsUUFBUSxFQUFHLFNBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUFBLGVBQ2hELEtBQUssV0FBVyxRQUFRLEVBQUcsU0FBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUEsSUFDMUQsQ0FBQztBQUNELHNCQUFrQixHQUFHLFNBQVMsQ0FBQyxRQUFRLFFBQVEsSUFBSSxPQUFPLENBQUM7QUFDM0Qsc0JBQWtCLEdBQUcsUUFBUSxNQUFNO0FBQUUsMEJBQW9CO0FBQUEsSUFBTSxDQUFDO0FBQUEsRUFDakU7QUFFQSxpQkFBZSxnQkFBZ0IsS0FBc0M7QUFDcEUsV0FBTyxJQUFJLFFBQWMsQ0FBQyxZQUFZO0FBSXJDO0FBQUEsUUFDQyxDQUFDLFNBQVM7QUFDVCxjQUFJLEdBQUcsY0FBYyxJQUFJO0FBQUEsUUFDMUI7QUFBQSxRQUNBLENBQUMsU0FBUztBQUNULGNBQUksR0FBRyxjQUFjLElBQUk7QUFBQSxRQUMxQjtBQUFBLFFBQ0EsQ0FBQyxRQUFRLElBQUksR0FBRyxPQUFPLFVBQVUsR0FBRyxJQUFJLE9BQU87QUFBQSxRQUMvQyxNQUFNO0FBQUEsUUFBQztBQUFBLE1BQ1I7QUFFQSxVQUFJLEdBQUc7QUFBQSxRQUNOLENBQUMsTUFBTSxRQUFRLEtBQUssVUFBVTtBQUFBLFVBQzdCLFNBQW1CO0FBQUUsbUJBQU8sQ0FBQztBQUFBLFVBQUc7QUFBQSxVQUNoQyxZQUFZLE1BQWM7QUFDekIsZ0JBQUksYUFBYSxJQUFJLEVBQUc7QUFDeEIsZ0JBQUksV0FBVyxNQUFNLElBQUksTUFBTSxLQUFLLFdBQVcsTUFBTSxJQUFJLEtBQUssR0FBRztBQUNoRSw2QkFBZTtBQUNmLHVCQUFTO0FBQ1QsNkJBQWUsS0FBSyxLQUFLO0FBQ3pCLG1CQUFLO0FBQUEsWUFDTjtBQUFBLFVBQ0Q7QUFBQSxVQUNBLGFBQWE7QUFBQSxVQUFDO0FBQUEsUUFDZjtBQUFBLFFBQ0EsRUFBRSxTQUFTLE1BQU0sZ0JBQWdCLEVBQUUsUUFBUSxpQkFBaUIsT0FBTyxPQUFPLEVBQUU7QUFBQSxNQUM3RSxFQUFFLEtBQUssTUFBTSxRQUFRLENBQUM7QUFBQSxJQUN2QixDQUFDO0FBQUEsRUFDRjtBQUNEOyIsCiAgIm5hbWVzIjogW10KfQo=
