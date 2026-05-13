import { xxHash32 } from "@gsd/native/xxhash";
const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";
const DICT = Array.from({ length: 256 }, (_, i) => {
  const h = i >>> 4;
  const l = i & 15;
  return `${NIBBLE_STR[h]}${NIBBLE_STR[l]}`;
});
const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;
function computeLineHash(idx, line) {
  line = line.replace(/\r/g, "").trimEnd();
  let seed = 0;
  if (!RE_SIGNIFICANT.test(line)) {
    seed = idx;
  }
  return DICT[xxHash32(line, seed) & 255];
}
function formatLineTag(line, text) {
  return `${line}#${computeLineHash(line, text)}`;
}
function formatHashLines(text, startLine = 1) {
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const num = startLine + i;
    return `${formatLineTag(num, line)}:${line}`;
  }).join("\n");
}
function parseTag(ref) {
  const match = ref.match(/^\s*[>+-]*\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/);
  if (!match) {
    throw new Error(`Invalid line reference "${ref}". Expected format "LINE#ID" (e.g. "5#QQ").`);
  }
  const line = Number.parseInt(match[1], 10);
  if (line < 1) {
    throw new Error(`Line number must be >= 1, got ${line} in "${ref}".`);
  }
  return { line, hash: match[2] };
}
const MISMATCH_CONTEXT = 2;
class HashlineMismatchError extends Error {
  constructor(mismatches, fileLines) {
    super(HashlineMismatchError.formatMessage(mismatches, fileLines));
    this.name = "HashlineMismatchError";
    this.mismatches = mismatches;
    this.fileLines = fileLines;
    const remaps = /* @__PURE__ */ new Map();
    for (const m of mismatches) {
      const actual = computeLineHash(m.line, fileLines[m.line - 1]);
      remaps.set(`${m.line}#${m.expected}`, `${m.line}#${actual}`);
    }
    this.remaps = remaps;
  }
  static formatMessage(mismatches, fileLines) {
    const mismatchSet = /* @__PURE__ */ new Map();
    for (const m of mismatches) {
      mismatchSet.set(m.line, m);
    }
    const displayLines = /* @__PURE__ */ new Set();
    for (const m of mismatches) {
      const lo = Math.max(1, m.line - MISMATCH_CONTEXT);
      const hi = Math.min(fileLines.length, m.line + MISMATCH_CONTEXT);
      for (let i = lo; i <= hi; i++) {
        displayLines.add(i);
      }
    }
    const sorted = [...displayLines].sort((a, b) => a - b);
    const lines = [];
    lines.push(
      `${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. Use the updated LINE#ID references shown below (>>> marks changed lines).`
    );
    lines.push("");
    let prevLine = -1;
    for (const lineNum of sorted) {
      if (prevLine !== -1 && lineNum > prevLine + 1) {
        lines.push("    ...");
      }
      prevLine = lineNum;
      const text = fileLines[lineNum - 1];
      const hash = computeLineHash(lineNum, text);
      const prefix = `${lineNum}#${hash}`;
      if (mismatchSet.has(lineNum)) {
        lines.push(`>>> ${prefix}:${text}`);
      } else {
        lines.push(`    ${prefix}:${text}`);
      }
    }
    return lines.join("\n");
  }
}
function validateLineRef(ref, fileLines) {
  if (ref.line < 1 || ref.line > fileLines.length) {
    throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
  }
  const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
  if (actualHash !== ref.hash) {
    throw new HashlineMismatchError([{ line: ref.line, expected: ref.hash, actual: actualHash }], fileLines);
  }
}
const HASHLINE_PREFIX_RE = /^\s*(?:>>>|>>)?\s*(?:\d+\s*#\s*|#\s*)[ZPMQVRWSNKTXJBYH]{2}:/;
const DIFF_PLUS_RE = /^[+](?![+])/;
function stripNewLinePrefixes(lines) {
  let hashPrefixCount = 0;
  let diffPlusCount = 0;
  let nonEmpty = 0;
  for (const l of lines) {
    if (l.length === 0) continue;
    nonEmpty++;
    if (HASHLINE_PREFIX_RE.test(l)) hashPrefixCount++;
    if (DIFF_PLUS_RE.test(l)) diffPlusCount++;
  }
  if (nonEmpty === 0) return lines;
  const stripHash = hashPrefixCount > 0 && hashPrefixCount === nonEmpty;
  const stripPlus = !stripHash && diffPlusCount > 0 && diffPlusCount >= nonEmpty * 0.5;
  if (!stripHash && !stripPlus) return lines;
  return lines.map((l) => {
    if (stripHash) return l.replace(HASHLINE_PREFIX_RE, "");
    if (stripPlus) return l.replace(DIFF_PLUS_RE, "");
    return l;
  });
}
function parseHashlineText(edit) {
  if (edit === null) return [];
  if (typeof edit === "string") {
    const normalizedEdit = edit.endsWith("\n") ? edit.slice(0, -1) : edit;
    edit = normalizedEdit.replaceAll("\r", "").split("\n");
  }
  return stripNewLinePrefixes(edit);
}
function maybeAutocorrectEscapedTabIndentation(edits, warnings) {
  for (const edit of edits) {
    if (edit.lines.length === 0) continue;
    const hasEscapedTabs = edit.lines.some((line) => line.includes("\\t"));
    if (!hasEscapedTabs) continue;
    const hasRealTabs = edit.lines.some((line) => line.includes("	"));
    if (hasRealTabs) continue;
    let correctedCount = 0;
    const corrected = edit.lines.map(
      (line) => line.replace(/^((?:\\t)+)/, (escaped) => {
        correctedCount += escaped.length / 2;
        return "	".repeat(escaped.length / 2);
      })
    );
    if (correctedCount === 0) continue;
    edit.lines = corrected;
    warnings.push(
      `Auto-corrected escaped tab indentation in edit: converted leading \\t sequence(s) to real tab characters`
    );
  }
}
const MIN_AUTOCORRECT_LENGTH = 2;
function shouldAutocorrect(line, otherLine) {
  if (!line || line !== otherLine) return false;
  line = line.trim();
  if (line.length < MIN_AUTOCORRECT_LENGTH) {
    return line.endsWith("}") || line.endsWith(")");
  }
  return true;
}
function applyHashlineEdits(text, edits) {
  if (edits.length === 0) {
    return { lines: text, firstChangedLine: void 0 };
  }
  const fileLines = text.split("\n");
  const originalFileLines = [...fileLines];
  let firstChangedLine;
  const noopEdits = [];
  const warnings = [];
  const mismatches = [];
  function validateRef(ref) {
    if (ref.line < 1 || ref.line > fileLines.length) {
      throw new Error(`Line ${ref.line} does not exist (file has ${fileLines.length} lines)`);
    }
    const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
    if (actualHash === ref.hash) {
      return true;
    }
    mismatches.push({ line: ref.line, expected: ref.hash, actual: actualHash });
    return false;
  }
  for (const edit of edits) {
    switch (edit.op) {
      case "replace": {
        if (edit.end) {
          const startValid = validateRef(edit.pos);
          const endValid = validateRef(edit.end);
          if (!startValid || !endValid) continue;
          if (edit.pos.line > edit.end.line) {
            throw new Error(`Range start line ${edit.pos.line} must be <= end line ${edit.end.line}`);
          }
        } else {
          if (!validateRef(edit.pos)) continue;
        }
        break;
      }
      case "append": {
        if (edit.pos && !validateRef(edit.pos)) continue;
        if (edit.lines.length === 0) {
          edit.lines = [""];
        }
        break;
      }
      case "prepend": {
        if (edit.pos && !validateRef(edit.pos)) continue;
        if (edit.lines.length === 0) {
          edit.lines = [""];
        }
        break;
      }
    }
  }
  if (mismatches.length > 0) {
    throw new HashlineMismatchError(mismatches, fileLines);
  }
  maybeAutocorrectEscapedTabIndentation(edits, warnings);
  const seenEditKeys = /* @__PURE__ */ new Map();
  const dedupIndices = /* @__PURE__ */ new Set();
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    let lineKey;
    switch (edit.op) {
      case "replace":
        lineKey = edit.end ? `r:${edit.pos.line}:${edit.end.line}` : `s:${edit.pos.line}`;
        break;
      case "append":
        lineKey = edit.pos ? `i:${edit.pos.line}` : "ieof";
        break;
      case "prepend":
        lineKey = edit.pos ? `ib:${edit.pos.line}` : "ibef";
        break;
    }
    const dstKey = `${lineKey}:${edit.lines.join("\n")}`;
    if (seenEditKeys.has(dstKey)) {
      dedupIndices.add(i);
    } else {
      seenEditKeys.set(dstKey, i);
    }
  }
  if (dedupIndices.size > 0) {
    for (let i = edits.length - 1; i >= 0; i--) {
      if (dedupIndices.has(i)) edits.splice(i, 1);
    }
  }
  const annotated = edits.map((edit, idx) => {
    let sortLine;
    let precedence;
    switch (edit.op) {
      case "replace":
        sortLine = edit.end ? edit.end.line : edit.pos.line;
        precedence = 0;
        break;
      case "append":
        sortLine = edit.pos ? edit.pos.line : fileLines.length + 1;
        precedence = 1;
        break;
      case "prepend":
        sortLine = edit.pos ? edit.pos.line : 0;
        precedence = 2;
        break;
    }
    return { edit, idx, sortLine, precedence };
  });
  annotated.sort((a, b) => b.sortLine - a.sortLine || a.precedence - b.precedence || a.idx - b.idx);
  function trackFirstChanged(line) {
    if (firstChangedLine === void 0 || line < firstChangedLine) {
      firstChangedLine = line;
    }
  }
  for (const { edit, idx } of annotated) {
    switch (edit.op) {
      case "replace": {
        if (!edit.end) {
          const origLines = originalFileLines.slice(edit.pos.line - 1, edit.pos.line);
          const newLines = edit.lines;
          if (origLines.length === newLines.length && origLines.every((line, i) => line === newLines[i])) {
            noopEdits.push({
              editIndex: idx,
              loc: `${edit.pos.line}#${edit.pos.hash}`,
              current: origLines.join("\n")
            });
            break;
          }
          fileLines.splice(edit.pos.line - 1, 1, ...newLines);
          trackFirstChanged(edit.pos.line);
        } else {
          const count = edit.end.line - edit.pos.line + 1;
          const newLines = [...edit.lines];
          const trailingReplacementLine = newLines[newLines.length - 1]?.trimEnd();
          const nextSurvivingLine = fileLines[edit.end.line]?.trimEnd();
          if (shouldAutocorrect(trailingReplacementLine, nextSurvivingLine) && fileLines[edit.end.line - 1]?.trimEnd() !== trailingReplacementLine) {
            newLines.pop();
            warnings.push(
              `Auto-corrected range replace ${edit.pos.line}#${edit.pos.hash}-${edit.end.line}#${edit.end.hash}: removed trailing replacement line "${trailingReplacementLine}" that duplicated next surviving line`
            );
          }
          const leadingReplacementLine = newLines[0]?.trimEnd();
          const prevSurvivingLine = fileLines[edit.pos.line - 2]?.trimEnd();
          if (shouldAutocorrect(leadingReplacementLine, prevSurvivingLine) && fileLines[edit.pos.line - 1]?.trimEnd() !== leadingReplacementLine) {
            newLines.shift();
            warnings.push(
              `Auto-corrected range replace ${edit.pos.line}#${edit.pos.hash}-${edit.end.line}#${edit.end.hash}: removed leading replacement line "${leadingReplacementLine}" that duplicated preceding surviving line`
            );
          }
          fileLines.splice(edit.pos.line - 1, count, ...newLines);
          trackFirstChanged(edit.pos.line);
        }
        break;
      }
      case "append": {
        const inserted = edit.lines;
        if (inserted.length === 0) {
          noopEdits.push({
            editIndex: idx,
            loc: edit.pos ? `${edit.pos.line}#${edit.pos.hash}` : "EOF",
            current: edit.pos ? originalFileLines[edit.pos.line - 1] : ""
          });
          break;
        }
        if (edit.pos) {
          fileLines.splice(edit.pos.line, 0, ...inserted);
          trackFirstChanged(edit.pos.line + 1);
        } else {
          if (fileLines.length === 1 && fileLines[0] === "") {
            fileLines.splice(0, 1, ...inserted);
            trackFirstChanged(1);
          } else {
            fileLines.splice(fileLines.length, 0, ...inserted);
            trackFirstChanged(fileLines.length - inserted.length + 1);
          }
        }
        break;
      }
      case "prepend": {
        const inserted = edit.lines;
        if (inserted.length === 0) {
          noopEdits.push({
            editIndex: idx,
            loc: edit.pos ? `${edit.pos.line}#${edit.pos.hash}` : "BOF",
            current: edit.pos ? originalFileLines[edit.pos.line - 1] : ""
          });
          break;
        }
        if (edit.pos) {
          fileLines.splice(edit.pos.line - 1, 0, ...inserted);
          trackFirstChanged(edit.pos.line);
        } else {
          if (fileLines.length === 1 && fileLines[0] === "") {
            fileLines.splice(0, 1, ...inserted);
          } else {
            fileLines.splice(0, 0, ...inserted);
          }
          trackFirstChanged(1);
        }
        break;
      }
    }
  }
  return {
    lines: fileLines.join("\n"),
    firstChangedLine,
    ...warnings.length > 0 ? { warnings } : {},
    ...noopEdits.length > 0 ? { noopEdits } : {}
  };
}
export {
  HashlineMismatchError,
  applyHashlineEdits,
  computeLineHash,
  formatHashLines,
  formatLineTag,
  parseHashlineText,
  parseTag,
  stripNewLinePrefixes,
  validateLineRef
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL2hhc2hsaW5lLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEhhc2hsaW5lIGVkaXQgbW9kZSBcdTIwMTQgYSBsaW5lLWFkZHJlc3NhYmxlIGVkaXQgZm9ybWF0IHVzaW5nIGNvbnRlbnQtaGFzaCBhbmNob3JzLlxuICpcbiAqIEVhY2ggbGluZSBpbiBhIGZpbGUgaXMgaWRlbnRpZmllZCBieSBpdHMgMS1pbmRleGVkIGxpbmUgbnVtYmVyIGFuZCBhIHNob3J0XG4gKiBoYXNoIGRlcml2ZWQgZnJvbSB0aGUgbm9ybWFsaXplZCBsaW5lIHRleHQgKHh4SGFzaDMyLCB0cnVuY2F0ZWQgdG8gMiBjaGFyc1xuICogZnJvbSBhIGN1c3RvbSBuaWJibGUgYWxwaGFiZXQpLlxuICpcbiAqIFRoZSBjb21iaW5lZCBgTElORSNJRGAgcmVmZXJlbmNlIGFjdHMgYXMgYm90aCBhbiBhZGRyZXNzIGFuZCBhIHN0YWxlbmVzcyBjaGVjazpcbiAqIGlmIHRoZSBmaWxlIGhhcyBjaGFuZ2VkIHNpbmNlIHRoZSBjYWxsZXIgbGFzdCByZWFkIGl0LCBoYXNoIG1pc21hdGNoZXMgYXJlIGNhdWdodFxuICogYmVmb3JlIGFueSBtdXRhdGlvbiBvY2N1cnMuXG4gKlxuICogRGlzcGxheWVkIGZvcm1hdDogYExJTkVOVU0jSEFTSDpURVhUYFxuICogUmVmZXJlbmNlIGZvcm1hdDogYFwiTElORU5VTSNIQVNIXCJgIChlLmcuIGBcIjUjUVFcImApXG4gKlxuICogQWRhcHRlZCBmcm9tIE9oIE15IFBpJ3MgaGFzaGxpbmUgaW1wbGVtZW50YXRpb24gZm9yIE5vZGUuanMgKG5vIEJ1biBkZXBlbmRlbmN5KS5cbiAqL1xuXG5pbXBvcnQgeyB4eEhhc2gzMiB9IGZyb20gXCJAZ3NkL25hdGl2ZS94eGhhc2hcIjtcblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBIYXNoIENvbXB1dGF0aW9uXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuZXhwb3J0IHR5cGUgQW5jaG9yID0geyBsaW5lOiBudW1iZXI7IGhhc2g6IHN0cmluZyB9O1xuZXhwb3J0IHR5cGUgSGFzaGxpbmVFZGl0ID1cblx0fCB7IG9wOiBcInJlcGxhY2VcIjsgcG9zOiBBbmNob3I7IGVuZD86IEFuY2hvcjsgbGluZXM6IHN0cmluZ1tdIH1cblx0fCB7IG9wOiBcImFwcGVuZFwiOyBwb3M/OiBBbmNob3I7IGxpbmVzOiBzdHJpbmdbXSB9XG5cdHwgeyBvcDogXCJwcmVwZW5kXCI7IHBvcz86IEFuY2hvcjsgbGluZXM6IHN0cmluZ1tdIH07XG5cbmNvbnN0IE5JQkJMRV9TVFIgPSBcIlpQTVFWUldTTktUWEpCWUhcIjtcblxuY29uc3QgRElDVCA9IEFycmF5LmZyb20oeyBsZW5ndGg6IDI1NiB9LCAoXywgaSkgPT4ge1xuXHRjb25zdCBoID0gaSA+Pj4gNDtcblx0Y29uc3QgbCA9IGkgJiAweDBmO1xuXHRyZXR1cm4gYCR7TklCQkxFX1NUUltoXX0ke05JQkJMRV9TVFJbbF19YDtcbn0pO1xuXG5jb25zdCBSRV9TSUdOSUZJQ0FOVCA9IC9bXFxwe0x9XFxwe059XS91O1xuXG4vKipcbiAqIENvbXB1dGUgYSBzaG9ydCBoYXNoIG9mIGEgc2luZ2xlIGxpbmUuXG4gKlxuICogVXNlcyB4eEhhc2gzMiBvbiBhIHRyYWlsaW5nLXdoaXRlc3BhY2UtdHJpbW1lZCwgQ1Itc3RyaXBwZWQgbGluZSwgdHJ1bmNhdGVkIHRvIDIgY2hhcnNcbiAqIGZyb20gdGhlIG5pYmJsZSBhbHBoYWJldC4gRm9yIGxpbmVzIGNvbnRhaW5pbmcgbm8gYWxwaGFudW1lcmljIGNoYXJhY3RlcnMgKG9ubHlcbiAqIHB1bmN0dWF0aW9uL3N5bWJvbHMvd2hpdGVzcGFjZSksIHRoZSBsaW5lIG51bWJlciBpcyBtaXhlZCBpbiB0byByZWR1Y2UgaGFzaCBjb2xsaXNpb25zLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY29tcHV0ZUxpbmVIYXNoKGlkeDogbnVtYmVyLCBsaW5lOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRsaW5lID0gbGluZS5yZXBsYWNlKC9cXHIvZywgXCJcIikudHJpbUVuZCgpO1xuXG5cdGxldCBzZWVkID0gMDtcblx0aWYgKCFSRV9TSUdOSUZJQ0FOVC50ZXN0KGxpbmUpKSB7XG5cdFx0c2VlZCA9IGlkeDtcblx0fVxuXHRyZXR1cm4gRElDVFt4eEhhc2gzMihsaW5lLCBzZWVkKSAmIDB4ZmZdO1xufVxuXG4vKipcbiAqIEZvcm1hdHMgYSB0YWcgZ2l2ZW4gdGhlIGxpbmUgbnVtYmVyIGFuZCB0ZXh0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0TGluZVRhZyhsaW5lOiBudW1iZXIsIHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiBgJHtsaW5lfSMke2NvbXB1dGVMaW5lSGFzaChsaW5lLCB0ZXh0KX1gO1xufVxuXG4vKipcbiAqIEZvcm1hdCBmaWxlIHRleHQgd2l0aCBoYXNobGluZSBwcmVmaXhlcyBmb3IgZGlzcGxheS5cbiAqXG4gKiBFYWNoIGxpbmUgYmVjb21lcyBgTElORU5VTSNIQVNIOlRFWFRgIHdoZXJlIExJTkVOVU0gaXMgMS1pbmRleGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0SGFzaExpbmVzKHRleHQ6IHN0cmluZywgc3RhcnRMaW5lID0gMSk6IHN0cmluZyB7XG5cdGNvbnN0IGxpbmVzID0gdGV4dC5zcGxpdChcIlxcblwiKTtcblx0cmV0dXJuIGxpbmVzXG5cdFx0Lm1hcCgobGluZSwgaSkgPT4ge1xuXHRcdFx0Y29uc3QgbnVtID0gc3RhcnRMaW5lICsgaTtcblx0XHRcdHJldHVybiBgJHtmb3JtYXRMaW5lVGFnKG51bSwgbGluZSl9OiR7bGluZX1gO1xuXHRcdH0pXG5cdFx0LmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKlxuICogUGFyc2UgYSBsaW5lIHJlZmVyZW5jZSBzdHJpbmcgbGlrZSBgXCI1I1FRXCJgIGludG8gc3RydWN0dXJlZCBmb3JtLlxuICpcbiAqIEB0aHJvd3MgRXJyb3IgaWYgdGhlIGZvcm1hdCBpcyBpbnZhbGlkXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVRhZyhyZWY6IHN0cmluZyk6IEFuY2hvciB7XG5cdGNvbnN0IG1hdGNoID0gcmVmLm1hdGNoKC9eXFxzKls+Ky1dKlxccyooXFxkKylcXHMqI1xccyooW1pQTVFWUldTTktUWEpCWUhdezJ9KS8pO1xuXHRpZiAoIW1hdGNoKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGxpbmUgcmVmZXJlbmNlIFwiJHtyZWZ9XCIuIEV4cGVjdGVkIGZvcm1hdCBcIkxJTkUjSURcIiAoZS5nLiBcIjUjUVFcIikuYCk7XG5cdH1cblx0Y29uc3QgbGluZSA9IE51bWJlci5wYXJzZUludChtYXRjaFsxXSwgMTApO1xuXHRpZiAobGluZSA8IDEpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoYExpbmUgbnVtYmVyIG11c3QgYmUgPj0gMSwgZ290ICR7bGluZX0gaW4gXCIke3JlZn1cIi5gKTtcblx0fVxuXHRyZXR1cm4geyBsaW5lLCBoYXNoOiBtYXRjaFsyXSB9O1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIEhhc2ggTWlzbWF0Y2ggRXJyb3Jcbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5leHBvcnQgaW50ZXJmYWNlIEhhc2hNaXNtYXRjaCB7XG5cdGxpbmU6IG51bWJlcjtcblx0ZXhwZWN0ZWQ6IHN0cmluZztcblx0YWN0dWFsOiBzdHJpbmc7XG59XG5cbmNvbnN0IE1JU01BVENIX0NPTlRFWFQgPSAyO1xuXG4vKipcbiAqIEVycm9yIHRocm93biB3aGVuIG9uZSBvciBtb3JlIGhhc2hsaW5lIHJlZmVyZW5jZXMgaGF2ZSBzdGFsZSBoYXNoZXMuXG4gKiBEaXNwbGF5cyBncmVwLXN0eWxlIG91dHB1dCB3aXRoIGA+Pj5gIG1hcmtlcnMgb24gbWlzbWF0Y2hlZCBsaW5lcyxcbiAqIHNob3dpbmcgdGhlIGNvcnJlY3QgYExJTkUjSURgIHNvIHRoZSBjYWxsZXIgY2FuIGZpeCBhbGwgcmVmcyBhdCBvbmNlLlxuICovXG5leHBvcnQgY2xhc3MgSGFzaGxpbmVNaXNtYXRjaEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuXHRyZWFkb25seSBtaXNtYXRjaGVzOiBIYXNoTWlzbWF0Y2hbXTtcblx0cmVhZG9ubHkgZmlsZUxpbmVzOiBzdHJpbmdbXTtcblx0cmVhZG9ubHkgcmVtYXBzOiBSZWFkb25seU1hcDxzdHJpbmcsIHN0cmluZz47XG5cdGNvbnN0cnVjdG9yKFxuXHRcdG1pc21hdGNoZXM6IEhhc2hNaXNtYXRjaFtdLFxuXHRcdGZpbGVMaW5lczogc3RyaW5nW10sXG5cdCkge1xuXHRcdHN1cGVyKEhhc2hsaW5lTWlzbWF0Y2hFcnJvci5mb3JtYXRNZXNzYWdlKG1pc21hdGNoZXMsIGZpbGVMaW5lcykpO1xuXHRcdHRoaXMubmFtZSA9IFwiSGFzaGxpbmVNaXNtYXRjaEVycm9yXCI7XG5cdFx0dGhpcy5taXNtYXRjaGVzID0gbWlzbWF0Y2hlcztcblx0XHR0aGlzLmZpbGVMaW5lcyA9IGZpbGVMaW5lcztcblx0XHRjb25zdCByZW1hcHMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuXHRcdGZvciAoY29uc3QgbSBvZiBtaXNtYXRjaGVzKSB7XG5cdFx0XHRjb25zdCBhY3R1YWwgPSBjb21wdXRlTGluZUhhc2gobS5saW5lLCBmaWxlTGluZXNbbS5saW5lIC0gMV0pO1xuXHRcdFx0cmVtYXBzLnNldChgJHttLmxpbmV9IyR7bS5leHBlY3RlZH1gLCBgJHttLmxpbmV9IyR7YWN0dWFsfWApO1xuXHRcdH1cblx0XHR0aGlzLnJlbWFwcyA9IHJlbWFwcztcblx0fVxuXG5cdHN0YXRpYyBmb3JtYXRNZXNzYWdlKG1pc21hdGNoZXM6IEhhc2hNaXNtYXRjaFtdLCBmaWxlTGluZXM6IHN0cmluZ1tdKTogc3RyaW5nIHtcblx0XHRjb25zdCBtaXNtYXRjaFNldCA9IG5ldyBNYXA8bnVtYmVyLCBIYXNoTWlzbWF0Y2g+KCk7XG5cdFx0Zm9yIChjb25zdCBtIG9mIG1pc21hdGNoZXMpIHtcblx0XHRcdG1pc21hdGNoU2V0LnNldChtLmxpbmUsIG0pO1xuXHRcdH1cblxuXHRcdGNvbnN0IGRpc3BsYXlMaW5lcyA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuXHRcdGZvciAoY29uc3QgbSBvZiBtaXNtYXRjaGVzKSB7XG5cdFx0XHRjb25zdCBsbyA9IE1hdGgubWF4KDEsIG0ubGluZSAtIE1JU01BVENIX0NPTlRFWFQpO1xuXHRcdFx0Y29uc3QgaGkgPSBNYXRoLm1pbihmaWxlTGluZXMubGVuZ3RoLCBtLmxpbmUgKyBNSVNNQVRDSF9DT05URVhUKTtcblx0XHRcdGZvciAobGV0IGkgPSBsbzsgaSA8PSBoaTsgaSsrKSB7XG5cdFx0XHRcdGRpc3BsYXlMaW5lcy5hZGQoaSk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Y29uc3Qgc29ydGVkID0gWy4uLmRpc3BsYXlMaW5lc10uc29ydCgoYSwgYikgPT4gYSAtIGIpO1xuXHRcdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdFx0bGluZXMucHVzaChcblx0XHRcdGAke21pc21hdGNoZXMubGVuZ3RofSBsaW5lJHttaXNtYXRjaGVzLmxlbmd0aCA+IDEgPyBcInMgaGF2ZVwiIDogXCIgaGFzXCJ9IGNoYW5nZWQgc2luY2UgbGFzdCByZWFkLiBVc2UgdGhlIHVwZGF0ZWQgTElORSNJRCByZWZlcmVuY2VzIHNob3duIGJlbG93ICg+Pj4gbWFya3MgY2hhbmdlZCBsaW5lcykuYCxcblx0XHQpO1xuXHRcdGxpbmVzLnB1c2goXCJcIik7XG5cblx0XHRsZXQgcHJldkxpbmUgPSAtMTtcblx0XHRmb3IgKGNvbnN0IGxpbmVOdW0gb2Ygc29ydGVkKSB7XG5cdFx0XHRpZiAocHJldkxpbmUgIT09IC0xICYmIGxpbmVOdW0gPiBwcmV2TGluZSArIDEpIHtcblx0XHRcdFx0bGluZXMucHVzaChcIiAgICAuLi5cIik7XG5cdFx0XHR9XG5cdFx0XHRwcmV2TGluZSA9IGxpbmVOdW07XG5cblx0XHRcdGNvbnN0IHRleHQgPSBmaWxlTGluZXNbbGluZU51bSAtIDFdO1xuXHRcdFx0Y29uc3QgaGFzaCA9IGNvbXB1dGVMaW5lSGFzaChsaW5lTnVtLCB0ZXh0KTtcblx0XHRcdGNvbnN0IHByZWZpeCA9IGAke2xpbmVOdW19IyR7aGFzaH1gO1xuXG5cdFx0XHRpZiAobWlzbWF0Y2hTZXQuaGFzKGxpbmVOdW0pKSB7XG5cdFx0XHRcdGxpbmVzLnB1c2goYD4+PiAke3ByZWZpeH06JHt0ZXh0fWApO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0bGluZXMucHVzaChgICAgICR7cHJlZml4fToke3RleHR9YCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xuXHR9XG59XG5cbi8qKlxuICogVmFsaWRhdGUgdGhhdCBhIGxpbmUgcmVmZXJlbmNlIHBvaW50cyB0byBhbiBleGlzdGluZyBsaW5lIHdpdGggYSBtYXRjaGluZyBoYXNoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVMaW5lUmVmKHJlZjogQW5jaG9yLCBmaWxlTGluZXM6IHN0cmluZ1tdKTogdm9pZCB7XG5cdGlmIChyZWYubGluZSA8IDEgfHwgcmVmLmxpbmUgPiBmaWxlTGluZXMubGVuZ3RoKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKGBMaW5lICR7cmVmLmxpbmV9IGRvZXMgbm90IGV4aXN0IChmaWxlIGhhcyAke2ZpbGVMaW5lcy5sZW5ndGh9IGxpbmVzKWApO1xuXHR9XG5cdGNvbnN0IGFjdHVhbEhhc2ggPSBjb21wdXRlTGluZUhhc2gocmVmLmxpbmUsIGZpbGVMaW5lc1tyZWYubGluZSAtIDFdKTtcblx0aWYgKGFjdHVhbEhhc2ggIT09IHJlZi5oYXNoKSB7XG5cdFx0dGhyb3cgbmV3IEhhc2hsaW5lTWlzbWF0Y2hFcnJvcihbeyBsaW5lOiByZWYubGluZSwgZXhwZWN0ZWQ6IHJlZi5oYXNoLCBhY3R1YWw6IGFjdHVhbEhhc2ggfV0sIGZpbGVMaW5lcyk7XG5cdH1cbn1cblxuLy8gXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXHUyNTUwXG4vLyBQcmVmaXggU3RyaXBwaW5nXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcblxuLyoqIFBhdHRlcm4gbWF0Y2hpbmcgaGFzaGxpbmUgZGlzcGxheSBmb3JtYXQgcHJlZml4ZXM6IGBMSU5FI0lEOkNPTlRFTlRgIGFuZCBgI0lEOkNPTlRFTlRgICovXG5jb25zdCBIQVNITElORV9QUkVGSVhfUkUgPSAvXlxccyooPzo+Pj58Pj4pP1xccyooPzpcXGQrXFxzKiNcXHMqfCNcXHMqKVtaUE1RVlJXU05LVFhKQllIXXsyfTovO1xuXG4vKiogUGF0dGVybiBtYXRjaGluZyBhIHVuaWZpZWQtZGlmZiBhZGRlZC1saW5lIGArYCBwcmVmaXggKGJ1dCBub3QgYCsrYCkuICovXG5jb25zdCBESUZGX1BMVVNfUkUgPSAvXlsrXSg/IVsrXSkvO1xuXG4vKipcbiAqIFN0cmlwIGhhc2hsaW5lIGRpc3BsYXkgcHJlZml4ZXMgYW5kIGRpZmYgYCtgIG1hcmtlcnMgZnJvbSByZXBsYWNlbWVudCBsaW5lcy5cbiAqXG4gKiBNb2RlbHMgZnJlcXVlbnRseSBjb3B5IHRoZSBgTElORSNJRGAgcHJlZml4IGZyb20gcmVhZCBvdXRwdXQgaW50byB0aGVpclxuICogcmVwbGFjZW1lbnQgY29udGVudC4gVGhpcyBzdHJpcHMgdGhlbSBoZXVyaXN0aWNhbGx5IGJlZm9yZSBhcHBsaWNhdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0cmlwTmV3TGluZVByZWZpeGVzKGxpbmVzOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcblx0bGV0IGhhc2hQcmVmaXhDb3VudCA9IDA7XG5cdGxldCBkaWZmUGx1c0NvdW50ID0gMDtcblx0bGV0IG5vbkVtcHR5ID0gMDtcblx0Zm9yIChjb25zdCBsIG9mIGxpbmVzKSB7XG5cdFx0aWYgKGwubGVuZ3RoID09PSAwKSBjb250aW51ZTtcblx0XHRub25FbXB0eSsrO1xuXHRcdGlmIChIQVNITElORV9QUkVGSVhfUkUudGVzdChsKSkgaGFzaFByZWZpeENvdW50Kys7XG5cdFx0aWYgKERJRkZfUExVU19SRS50ZXN0KGwpKSBkaWZmUGx1c0NvdW50Kys7XG5cdH1cblx0aWYgKG5vbkVtcHR5ID09PSAwKSByZXR1cm4gbGluZXM7XG5cblx0Y29uc3Qgc3RyaXBIYXNoID0gaGFzaFByZWZpeENvdW50ID4gMCAmJiBoYXNoUHJlZml4Q291bnQgPT09IG5vbkVtcHR5O1xuXHRjb25zdCBzdHJpcFBsdXMgPSAhc3RyaXBIYXNoICYmIGRpZmZQbHVzQ291bnQgPiAwICYmIGRpZmZQbHVzQ291bnQgPj0gbm9uRW1wdHkgKiAwLjU7XG5cdGlmICghc3RyaXBIYXNoICYmICFzdHJpcFBsdXMpIHJldHVybiBsaW5lcztcblxuXHRyZXR1cm4gbGluZXMubWFwKGwgPT4ge1xuXHRcdGlmIChzdHJpcEhhc2gpIHJldHVybiBsLnJlcGxhY2UoSEFTSExJTkVfUFJFRklYX1JFLCBcIlwiKTtcblx0XHRpZiAoc3RyaXBQbHVzKSByZXR1cm4gbC5yZXBsYWNlKERJRkZfUExVU19SRSwgXCJcIik7XG5cdFx0cmV0dXJuIGw7XG5cdH0pO1xufVxuXG4vKipcbiAqIFBhcnNlIGVkaXQgY29udGVudCBcdTIwMTQgaGFuZGxlcyBzdHJpbmcsIGFycmF5LCBvciBudWxsIGlucHV0LlxuICogU3RyaXBzIGhhc2hsaW5lIHByZWZpeGVzIGFuZCBkaWZmIG1hcmtlcnMgZnJvbSBtb2RlbCBvdXRwdXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUhhc2hsaW5lVGV4dChlZGl0OiBzdHJpbmdbXSB8IHN0cmluZyB8IG51bGwpOiBzdHJpbmdbXSB7XG5cdGlmIChlZGl0ID09PSBudWxsKSByZXR1cm4gW107XG5cdGlmICh0eXBlb2YgZWRpdCA9PT0gXCJzdHJpbmdcIikge1xuXHRcdGNvbnN0IG5vcm1hbGl6ZWRFZGl0ID0gZWRpdC5lbmRzV2l0aChcIlxcblwiKSA/IGVkaXQuc2xpY2UoMCwgLTEpIDogZWRpdDtcblx0XHRlZGl0ID0gbm9ybWFsaXplZEVkaXQucmVwbGFjZUFsbChcIlxcclwiLCBcIlwiKS5zcGxpdChcIlxcblwiKTtcblx0fVxuXHRyZXR1cm4gc3RyaXBOZXdMaW5lUHJlZml4ZXMoZWRpdCk7XG59XG5cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuLy8gQXV0by1jb3JyZWN0aW9uIEhldXJpc3RpY3Ncbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG5mdW5jdGlvbiBtYXliZUF1dG9jb3JyZWN0RXNjYXBlZFRhYkluZGVudGF0aW9uKGVkaXRzOiBIYXNobGluZUVkaXRbXSwgd2FybmluZ3M6IHN0cmluZ1tdKTogdm9pZCB7XG5cdGZvciAoY29uc3QgZWRpdCBvZiBlZGl0cykge1xuXHRcdGlmIChlZGl0LmxpbmVzLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG5cdFx0Y29uc3QgaGFzRXNjYXBlZFRhYnMgPSBlZGl0LmxpbmVzLnNvbWUobGluZSA9PiBsaW5lLmluY2x1ZGVzKFwiXFxcXHRcIikpO1xuXHRcdGlmICghaGFzRXNjYXBlZFRhYnMpIGNvbnRpbnVlO1xuXHRcdGNvbnN0IGhhc1JlYWxUYWJzID0gZWRpdC5saW5lcy5zb21lKGxpbmUgPT4gbGluZS5pbmNsdWRlcyhcIlxcdFwiKSk7XG5cdFx0aWYgKGhhc1JlYWxUYWJzKSBjb250aW51ZTtcblx0XHRsZXQgY29ycmVjdGVkQ291bnQgPSAwO1xuXHRcdGNvbnN0IGNvcnJlY3RlZCA9IGVkaXQubGluZXMubWFwKGxpbmUgPT5cblx0XHRcdGxpbmUucmVwbGFjZSgvXigoPzpcXFxcdCkrKS8sIGVzY2FwZWQgPT4ge1xuXHRcdFx0XHRjb3JyZWN0ZWRDb3VudCArPSBlc2NhcGVkLmxlbmd0aCAvIDI7XG5cdFx0XHRcdHJldHVybiBcIlxcdFwiLnJlcGVhdChlc2NhcGVkLmxlbmd0aCAvIDIpO1xuXHRcdFx0fSksXG5cdFx0KTtcblx0XHRpZiAoY29ycmVjdGVkQ291bnQgPT09IDApIGNvbnRpbnVlO1xuXHRcdGVkaXQubGluZXMgPSBjb3JyZWN0ZWQ7XG5cdFx0d2FybmluZ3MucHVzaChcblx0XHRcdGBBdXRvLWNvcnJlY3RlZCBlc2NhcGVkIHRhYiBpbmRlbnRhdGlvbiBpbiBlZGl0OiBjb252ZXJ0ZWQgbGVhZGluZyBcXFxcdCBzZXF1ZW5jZShzKSB0byByZWFsIHRhYiBjaGFyYWN0ZXJzYCxcblx0XHQpO1xuXHR9XG59XG5cbmNvbnN0IE1JTl9BVVRPQ09SUkVDVF9MRU5HVEggPSAyO1xuXG5mdW5jdGlvbiBzaG91bGRBdXRvY29ycmVjdChsaW5lOiBzdHJpbmcsIG90aGVyTGluZTogc3RyaW5nKTogYm9vbGVhbiB7XG5cdGlmICghbGluZSB8fCBsaW5lICE9PSBvdGhlckxpbmUpIHJldHVybiBmYWxzZTtcblx0bGluZSA9IGxpbmUudHJpbSgpO1xuXHRpZiAobGluZS5sZW5ndGggPCBNSU5fQVVUT0NPUlJFQ1RfTEVOR1RIKSB7XG5cdFx0cmV0dXJuIGxpbmUuZW5kc1dpdGgoXCJ9XCIpIHx8IGxpbmUuZW5kc1dpdGgoXCIpXCIpO1xuXHR9XG5cdHJldHVybiB0cnVlO1xufVxuXG4vLyBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcdTI1NTBcbi8vIEVkaXQgQXBwbGljYXRpb25cbi8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxuXG4vKipcbiAqIEFwcGx5IGFuIGFycmF5IG9mIGhhc2hsaW5lIGVkaXRzIHRvIGZpbGUgY29udGVudC5cbiAqXG4gKiBFYWNoIGVkaXQgb3BlcmF0aW9uIGlkZW50aWZpZXMgdGFyZ2V0IGxpbmVzIGRpcmVjdGx5IChgcmVwbGFjZWAsXG4gKiBgYXBwZW5kYCwgYHByZXBlbmRgKS4gTGluZSByZWZlcmVuY2VzIGFyZSByZXNvbHZlZCB2aWEgcGFyc2VUYWdcbiAqIGFuZCBoYXNoZXMgdmFsaWRhdGVkIGJlZm9yZSBhbnkgbXV0YXRpb24uXG4gKlxuICogRWRpdHMgYXJlIHNvcnRlZCBib3R0b20tdXAgKGhpZ2hlc3QgZWZmZWN0aXZlIGxpbmUgZmlyc3QpIHNvIGVhcmxpZXJcbiAqIHNwbGljZXMgZG9uJ3QgaW52YWxpZGF0ZSBsYXRlciBsaW5lIG51bWJlcnMuXG4gKlxuICogQHJldHVybnMgVGhlIG1vZGlmaWVkIGNvbnRlbnQgYW5kIHRoZSAxLWluZGV4ZWQgZmlyc3QgY2hhbmdlZCBsaW5lIG51bWJlclxuICovXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlIYXNobGluZUVkaXRzKFxuXHR0ZXh0OiBzdHJpbmcsXG5cdGVkaXRzOiBIYXNobGluZUVkaXRbXSxcbik6IHtcblx0bGluZXM6IHN0cmluZztcblx0Zmlyc3RDaGFuZ2VkTGluZTogbnVtYmVyIHwgdW5kZWZpbmVkO1xuXHR3YXJuaW5ncz86IHN0cmluZ1tdO1xuXHRub29wRWRpdHM/OiBBcnJheTx7IGVkaXRJbmRleDogbnVtYmVyOyBsb2M6IHN0cmluZzsgY3VycmVudDogc3RyaW5nIH0+O1xufSB7XG5cdGlmIChlZGl0cy5sZW5ndGggPT09IDApIHtcblx0XHRyZXR1cm4geyBsaW5lczogdGV4dCwgZmlyc3RDaGFuZ2VkTGluZTogdW5kZWZpbmVkIH07XG5cdH1cblxuXHRjb25zdCBmaWxlTGluZXMgPSB0ZXh0LnNwbGl0KFwiXFxuXCIpO1xuXHRjb25zdCBvcmlnaW5hbEZpbGVMaW5lcyA9IFsuLi5maWxlTGluZXNdO1xuXHRsZXQgZmlyc3RDaGFuZ2VkTGluZTogbnVtYmVyIHwgdW5kZWZpbmVkO1xuXHRjb25zdCBub29wRWRpdHM6IEFycmF5PHsgZWRpdEluZGV4OiBudW1iZXI7IGxvYzogc3RyaW5nOyBjdXJyZW50OiBzdHJpbmcgfT4gPSBbXTtcblx0Y29uc3Qgd2FybmluZ3M6IHN0cmluZ1tdID0gW107XG5cblx0Ly8gUHJlLXZhbGlkYXRlOiBjb2xsZWN0IGFsbCBoYXNoIG1pc21hdGNoZXMgYmVmb3JlIG11dGF0aW5nXG5cdGNvbnN0IG1pc21hdGNoZXM6IEhhc2hNaXNtYXRjaFtdID0gW107XG5cdGZ1bmN0aW9uIHZhbGlkYXRlUmVmKHJlZjogQW5jaG9yKTogYm9vbGVhbiB7XG5cdFx0aWYgKHJlZi5saW5lIDwgMSB8fCByZWYubGluZSA+IGZpbGVMaW5lcy5sZW5ndGgpIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihgTGluZSAke3JlZi5saW5lfSBkb2VzIG5vdCBleGlzdCAoZmlsZSBoYXMgJHtmaWxlTGluZXMubGVuZ3RofSBsaW5lcylgKTtcblx0XHR9XG5cdFx0Y29uc3QgYWN0dWFsSGFzaCA9IGNvbXB1dGVMaW5lSGFzaChyZWYubGluZSwgZmlsZUxpbmVzW3JlZi5saW5lIC0gMV0pO1xuXHRcdGlmIChhY3R1YWxIYXNoID09PSByZWYuaGFzaCkge1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fVxuXHRcdG1pc21hdGNoZXMucHVzaCh7IGxpbmU6IHJlZi5saW5lLCBleHBlY3RlZDogcmVmLmhhc2gsIGFjdHVhbDogYWN0dWFsSGFzaCB9KTtcblx0XHRyZXR1cm4gZmFsc2U7XG5cdH1cblx0Zm9yIChjb25zdCBlZGl0IG9mIGVkaXRzKSB7XG5cdFx0c3dpdGNoIChlZGl0Lm9wKSB7XG5cdFx0XHRjYXNlIFwicmVwbGFjZVwiOiB7XG5cdFx0XHRcdGlmIChlZGl0LmVuZCkge1xuXHRcdFx0XHRcdGNvbnN0IHN0YXJ0VmFsaWQgPSB2YWxpZGF0ZVJlZihlZGl0LnBvcyk7XG5cdFx0XHRcdFx0Y29uc3QgZW5kVmFsaWQgPSB2YWxpZGF0ZVJlZihlZGl0LmVuZCk7XG5cdFx0XHRcdFx0aWYgKCFzdGFydFZhbGlkIHx8ICFlbmRWYWxpZCkgY29udGludWU7XG5cdFx0XHRcdFx0aWYgKGVkaXQucG9zLmxpbmUgPiBlZGl0LmVuZC5saW5lKSB7XG5cdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYFJhbmdlIHN0YXJ0IGxpbmUgJHtlZGl0LnBvcy5saW5lfSBtdXN0IGJlIDw9IGVuZCBsaW5lICR7ZWRpdC5lbmQubGluZX1gKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0aWYgKCF2YWxpZGF0ZVJlZihlZGl0LnBvcykpIGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdFx0Y2FzZSBcImFwcGVuZFwiOiB7XG5cdFx0XHRcdGlmIChlZGl0LnBvcyAmJiAhdmFsaWRhdGVSZWYoZWRpdC5wb3MpKSBjb250aW51ZTtcblx0XHRcdFx0aWYgKGVkaXQubGluZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0ZWRpdC5saW5lcyA9IFtcIlwiXTtcblx0XHRcdFx0fVxuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHRcdGNhc2UgXCJwcmVwZW5kXCI6IHtcblx0XHRcdFx0aWYgKGVkaXQucG9zICYmICF2YWxpZGF0ZVJlZihlZGl0LnBvcykpIGNvbnRpbnVlO1xuXHRcdFx0XHRpZiAoZWRpdC5saW5lcy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHRlZGl0LmxpbmVzID0gW1wiXCJdO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXHRpZiAobWlzbWF0Y2hlcy5sZW5ndGggPiAwKSB7XG5cdFx0dGhyb3cgbmV3IEhhc2hsaW5lTWlzbWF0Y2hFcnJvcihtaXNtYXRjaGVzLCBmaWxlTGluZXMpO1xuXHR9XG5cdG1heWJlQXV0b2NvcnJlY3RFc2NhcGVkVGFiSW5kZW50YXRpb24oZWRpdHMsIHdhcm5pbmdzKTtcblxuXHQvLyBEZWR1cGxpY2F0ZSBpZGVudGljYWwgZWRpdHMgdGFyZ2V0aW5nIHRoZSBzYW1lIGxpbmUocylcblx0Y29uc3Qgc2VlbkVkaXRLZXlzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcblx0Y29uc3QgZGVkdXBJbmRpY2VzID0gbmV3IFNldDxudW1iZXI+KCk7XG5cdGZvciAobGV0IGkgPSAwOyBpIDwgZWRpdHMubGVuZ3RoOyBpKyspIHtcblx0XHRjb25zdCBlZGl0ID0gZWRpdHNbaV07XG5cdFx0bGV0IGxpbmVLZXk6IHN0cmluZztcblx0XHRzd2l0Y2ggKGVkaXQub3ApIHtcblx0XHRcdGNhc2UgXCJyZXBsYWNlXCI6XG5cdFx0XHRcdGxpbmVLZXkgPSBlZGl0LmVuZCA/IGByOiR7ZWRpdC5wb3MubGluZX06JHtlZGl0LmVuZC5saW5lfWAgOiBgczoke2VkaXQucG9zLmxpbmV9YDtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHRjYXNlIFwiYXBwZW5kXCI6XG5cdFx0XHRcdGxpbmVLZXkgPSBlZGl0LnBvcyA/IGBpOiR7ZWRpdC5wb3MubGluZX1gIDogXCJpZW9mXCI7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0Y2FzZSBcInByZXBlbmRcIjpcblx0XHRcdFx0bGluZUtleSA9IGVkaXQucG9zID8gYGliOiR7ZWRpdC5wb3MubGluZX1gIDogXCJpYmVmXCI7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdH1cblx0XHRjb25zdCBkc3RLZXkgPSBgJHtsaW5lS2V5fToke2VkaXQubGluZXMuam9pbihcIlxcblwiKX1gO1xuXHRcdGlmIChzZWVuRWRpdEtleXMuaGFzKGRzdEtleSkpIHtcblx0XHRcdGRlZHVwSW5kaWNlcy5hZGQoaSk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHNlZW5FZGl0S2V5cy5zZXQoZHN0S2V5LCBpKTtcblx0XHR9XG5cdH1cblx0aWYgKGRlZHVwSW5kaWNlcy5zaXplID4gMCkge1xuXHRcdGZvciAobGV0IGkgPSBlZGl0cy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuXHRcdFx0aWYgKGRlZHVwSW5kaWNlcy5oYXMoaSkpIGVkaXRzLnNwbGljZShpLCAxKTtcblx0XHR9XG5cdH1cblxuXHQvLyBDb21wdXRlIHNvcnQga2V5IChkZXNjZW5kaW5nKSBcdTIwMTQgYm90dG9tLXVwIGFwcGxpY2F0aW9uXG5cdGNvbnN0IGFubm90YXRlZCA9IGVkaXRzLm1hcCgoZWRpdCwgaWR4KSA9PiB7XG5cdFx0bGV0IHNvcnRMaW5lOiBudW1iZXI7XG5cdFx0bGV0IHByZWNlZGVuY2U6IG51bWJlcjtcblx0XHRzd2l0Y2ggKGVkaXQub3ApIHtcblx0XHRcdGNhc2UgXCJyZXBsYWNlXCI6XG5cdFx0XHRcdHNvcnRMaW5lID0gZWRpdC5lbmQgPyBlZGl0LmVuZC5saW5lIDogZWRpdC5wb3MubGluZTtcblx0XHRcdFx0cHJlY2VkZW5jZSA9IDA7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0Y2FzZSBcImFwcGVuZFwiOlxuXHRcdFx0XHRzb3J0TGluZSA9IGVkaXQucG9zID8gZWRpdC5wb3MubGluZSA6IGZpbGVMaW5lcy5sZW5ndGggKyAxO1xuXHRcdFx0XHRwcmVjZWRlbmNlID0gMTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHRjYXNlIFwicHJlcGVuZFwiOlxuXHRcdFx0XHRzb3J0TGluZSA9IGVkaXQucG9zID8gZWRpdC5wb3MubGluZSA6IDA7XG5cdFx0XHRcdHByZWNlZGVuY2UgPSAyO1xuXHRcdFx0XHRicmVhaztcblx0XHR9XG5cdFx0cmV0dXJuIHsgZWRpdCwgaWR4LCBzb3J0TGluZSwgcHJlY2VkZW5jZSB9O1xuXHR9KTtcblxuXHRhbm5vdGF0ZWQuc29ydCgoYSwgYikgPT4gYi5zb3J0TGluZSAtIGEuc29ydExpbmUgfHwgYS5wcmVjZWRlbmNlIC0gYi5wcmVjZWRlbmNlIHx8IGEuaWR4IC0gYi5pZHgpO1xuXG5cdGZ1bmN0aW9uIHRyYWNrRmlyc3RDaGFuZ2VkKGxpbmU6IG51bWJlcik6IHZvaWQge1xuXHRcdGlmIChmaXJzdENoYW5nZWRMaW5lID09PSB1bmRlZmluZWQgfHwgbGluZSA8IGZpcnN0Q2hhbmdlZExpbmUpIHtcblx0XHRcdGZpcnN0Q2hhbmdlZExpbmUgPSBsaW5lO1xuXHRcdH1cblx0fVxuXG5cdC8vIEFwcGx5IGVkaXRzIGJvdHRvbS11cFxuXHRmb3IgKGNvbnN0IHsgZWRpdCwgaWR4IH0gb2YgYW5ub3RhdGVkKSB7XG5cdFx0c3dpdGNoIChlZGl0Lm9wKSB7XG5cdFx0XHRjYXNlIFwicmVwbGFjZVwiOiB7XG5cdFx0XHRcdGlmICghZWRpdC5lbmQpIHtcblx0XHRcdFx0XHRjb25zdCBvcmlnTGluZXMgPSBvcmlnaW5hbEZpbGVMaW5lcy5zbGljZShlZGl0LnBvcy5saW5lIC0gMSwgZWRpdC5wb3MubGluZSk7XG5cdFx0XHRcdFx0Y29uc3QgbmV3TGluZXMgPSBlZGl0LmxpbmVzO1xuXHRcdFx0XHRcdGlmIChvcmlnTGluZXMubGVuZ3RoID09PSBuZXdMaW5lcy5sZW5ndGggJiYgb3JpZ0xpbmVzLmV2ZXJ5KChsaW5lLCBpKSA9PiBsaW5lID09PSBuZXdMaW5lc1tpXSkpIHtcblx0XHRcdFx0XHRcdG5vb3BFZGl0cy5wdXNoKHtcblx0XHRcdFx0XHRcdFx0ZWRpdEluZGV4OiBpZHgsXG5cdFx0XHRcdFx0XHRcdGxvYzogYCR7ZWRpdC5wb3MubGluZX0jJHtlZGl0LnBvcy5oYXNofWAsXG5cdFx0XHRcdFx0XHRcdGN1cnJlbnQ6IG9yaWdMaW5lcy5qb2luKFwiXFxuXCIpLFxuXHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0ZmlsZUxpbmVzLnNwbGljZShlZGl0LnBvcy5saW5lIC0gMSwgMSwgLi4ubmV3TGluZXMpO1xuXHRcdFx0XHRcdHRyYWNrRmlyc3RDaGFuZ2VkKGVkaXQucG9zLmxpbmUpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGNvbnN0IGNvdW50ID0gZWRpdC5lbmQubGluZSAtIGVkaXQucG9zLmxpbmUgKyAxO1xuXHRcdFx0XHRcdGNvbnN0IG5ld0xpbmVzID0gWy4uLmVkaXQubGluZXNdO1xuXHRcdFx0XHRcdGNvbnN0IHRyYWlsaW5nUmVwbGFjZW1lbnRMaW5lID0gbmV3TGluZXNbbmV3TGluZXMubGVuZ3RoIC0gMV0/LnRyaW1FbmQoKTtcblx0XHRcdFx0XHRjb25zdCBuZXh0U3Vydml2aW5nTGluZSA9IGZpbGVMaW5lc1tlZGl0LmVuZC5saW5lXT8udHJpbUVuZCgpO1xuXHRcdFx0XHRcdGlmIChcblx0XHRcdFx0XHRcdHNob3VsZEF1dG9jb3JyZWN0KHRyYWlsaW5nUmVwbGFjZW1lbnRMaW5lLCBuZXh0U3Vydml2aW5nTGluZSkgJiZcblx0XHRcdFx0XHRcdGZpbGVMaW5lc1tlZGl0LmVuZC5saW5lIC0gMV0/LnRyaW1FbmQoKSAhPT0gdHJhaWxpbmdSZXBsYWNlbWVudExpbmVcblx0XHRcdFx0XHQpIHtcblx0XHRcdFx0XHRcdG5ld0xpbmVzLnBvcCgpO1xuXHRcdFx0XHRcdFx0d2FybmluZ3MucHVzaChcblx0XHRcdFx0XHRcdFx0YEF1dG8tY29ycmVjdGVkIHJhbmdlIHJlcGxhY2UgJHtlZGl0LnBvcy5saW5lfSMke2VkaXQucG9zLmhhc2h9LSR7ZWRpdC5lbmQubGluZX0jJHtlZGl0LmVuZC5oYXNofTogcmVtb3ZlZCB0cmFpbGluZyByZXBsYWNlbWVudCBsaW5lIFwiJHt0cmFpbGluZ1JlcGxhY2VtZW50TGluZX1cIiB0aGF0IGR1cGxpY2F0ZWQgbmV4dCBzdXJ2aXZpbmcgbGluZWAsXG5cdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRjb25zdCBsZWFkaW5nUmVwbGFjZW1lbnRMaW5lID0gbmV3TGluZXNbMF0/LnRyaW1FbmQoKTtcblx0XHRcdFx0XHRjb25zdCBwcmV2U3Vydml2aW5nTGluZSA9IGZpbGVMaW5lc1tlZGl0LnBvcy5saW5lIC0gMl0/LnRyaW1FbmQoKTtcblx0XHRcdFx0XHRpZiAoXG5cdFx0XHRcdFx0XHRzaG91bGRBdXRvY29ycmVjdChsZWFkaW5nUmVwbGFjZW1lbnRMaW5lLCBwcmV2U3Vydml2aW5nTGluZSkgJiZcblx0XHRcdFx0XHRcdGZpbGVMaW5lc1tlZGl0LnBvcy5saW5lIC0gMV0/LnRyaW1FbmQoKSAhPT0gbGVhZGluZ1JlcGxhY2VtZW50TGluZVxuXHRcdFx0XHRcdCkge1xuXHRcdFx0XHRcdFx0bmV3TGluZXMuc2hpZnQoKTtcblx0XHRcdFx0XHRcdHdhcm5pbmdzLnB1c2goXG5cdFx0XHRcdFx0XHRcdGBBdXRvLWNvcnJlY3RlZCByYW5nZSByZXBsYWNlICR7ZWRpdC5wb3MubGluZX0jJHtlZGl0LnBvcy5oYXNofS0ke2VkaXQuZW5kLmxpbmV9IyR7ZWRpdC5lbmQuaGFzaH06IHJlbW92ZWQgbGVhZGluZyByZXBsYWNlbWVudCBsaW5lIFwiJHtsZWFkaW5nUmVwbGFjZW1lbnRMaW5lfVwiIHRoYXQgZHVwbGljYXRlZCBwcmVjZWRpbmcgc3Vydml2aW5nIGxpbmVgLFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0ZmlsZUxpbmVzLnNwbGljZShlZGl0LnBvcy5saW5lIC0gMSwgY291bnQsIC4uLm5ld0xpbmVzKTtcblx0XHRcdFx0XHR0cmFja0ZpcnN0Q2hhbmdlZChlZGl0LnBvcy5saW5lKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHRcdGNhc2UgXCJhcHBlbmRcIjoge1xuXHRcdFx0XHRjb25zdCBpbnNlcnRlZCA9IGVkaXQubGluZXM7XG5cdFx0XHRcdGlmIChpbnNlcnRlZC5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHRub29wRWRpdHMucHVzaCh7XG5cdFx0XHRcdFx0XHRlZGl0SW5kZXg6IGlkeCxcblx0XHRcdFx0XHRcdGxvYzogZWRpdC5wb3MgPyBgJHtlZGl0LnBvcy5saW5lfSMke2VkaXQucG9zLmhhc2h9YCA6IFwiRU9GXCIsXG5cdFx0XHRcdFx0XHRjdXJyZW50OiBlZGl0LnBvcyA/IG9yaWdpbmFsRmlsZUxpbmVzW2VkaXQucG9zLmxpbmUgLSAxXSA6IFwiXCIsXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKGVkaXQucG9zKSB7XG5cdFx0XHRcdFx0ZmlsZUxpbmVzLnNwbGljZShlZGl0LnBvcy5saW5lLCAwLCAuLi5pbnNlcnRlZCk7XG5cdFx0XHRcdFx0dHJhY2tGaXJzdENoYW5nZWQoZWRpdC5wb3MubGluZSArIDEpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGlmIChmaWxlTGluZXMubGVuZ3RoID09PSAxICYmIGZpbGVMaW5lc1swXSA9PT0gXCJcIikge1xuXHRcdFx0XHRcdFx0ZmlsZUxpbmVzLnNwbGljZSgwLCAxLCAuLi5pbnNlcnRlZCk7XG5cdFx0XHRcdFx0XHR0cmFja0ZpcnN0Q2hhbmdlZCgxKTtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0ZmlsZUxpbmVzLnNwbGljZShmaWxlTGluZXMubGVuZ3RoLCAwLCAuLi5pbnNlcnRlZCk7XG5cdFx0XHRcdFx0XHR0cmFja0ZpcnN0Q2hhbmdlZChmaWxlTGluZXMubGVuZ3RoIC0gaW5zZXJ0ZWQubGVuZ3RoICsgMSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdFx0Y2FzZSBcInByZXBlbmRcIjoge1xuXHRcdFx0XHRjb25zdCBpbnNlcnRlZCA9IGVkaXQubGluZXM7XG5cdFx0XHRcdGlmIChpbnNlcnRlZC5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHRub29wRWRpdHMucHVzaCh7XG5cdFx0XHRcdFx0XHRlZGl0SW5kZXg6IGlkeCxcblx0XHRcdFx0XHRcdGxvYzogZWRpdC5wb3MgPyBgJHtlZGl0LnBvcy5saW5lfSMke2VkaXQucG9zLmhhc2h9YCA6IFwiQk9GXCIsXG5cdFx0XHRcdFx0XHRjdXJyZW50OiBlZGl0LnBvcyA/IG9yaWdpbmFsRmlsZUxpbmVzW2VkaXQucG9zLmxpbmUgLSAxXSA6IFwiXCIsXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKGVkaXQucG9zKSB7XG5cdFx0XHRcdFx0ZmlsZUxpbmVzLnNwbGljZShlZGl0LnBvcy5saW5lIC0gMSwgMCwgLi4uaW5zZXJ0ZWQpO1xuXHRcdFx0XHRcdHRyYWNrRmlyc3RDaGFuZ2VkKGVkaXQucG9zLmxpbmUpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGlmIChmaWxlTGluZXMubGVuZ3RoID09PSAxICYmIGZpbGVMaW5lc1swXSA9PT0gXCJcIikge1xuXHRcdFx0XHRcdFx0ZmlsZUxpbmVzLnNwbGljZSgwLCAxLCAuLi5pbnNlcnRlZCk7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdGZpbGVMaW5lcy5zcGxpY2UoMCwgMCwgLi4uaW5zZXJ0ZWQpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHR0cmFja0ZpcnN0Q2hhbmdlZCgxKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdGxpbmVzOiBmaWxlTGluZXMuam9pbihcIlxcblwiKSxcblx0XHRmaXJzdENoYW5nZWRMaW5lLFxuXHRcdC4uLih3YXJuaW5ncy5sZW5ndGggPiAwID8geyB3YXJuaW5ncyB9IDoge30pLFxuXHRcdC4uLihub29wRWRpdHMubGVuZ3RoID4gMCA/IHsgbm9vcEVkaXRzIH0gOiB7fSksXG5cdH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFpQkEs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
