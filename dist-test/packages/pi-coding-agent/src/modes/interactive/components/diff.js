import * as Diff from "diff";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.js";
function parseDiffLine(line) {
  const match = line.match(/^([+\- ])(\s*\d*)\s(.*)$/);
  if (!match) return null;
  return { prefix: match[1], lineNum: match[2], content: match[3] };
}
function replaceTabs(text) {
  return text.replace(/\t/g, "    ");
}
function renderIntraLineDiff(oldContent, newContent) {
  const wordDiff = Diff.diffWords(oldContent, newContent);
  let removedLine = "";
  let addedLine = "";
  let isFirstRemoved = true;
  let isFirstAdded = true;
  for (const part of wordDiff) {
    if (part.removed) {
      let value = part.value;
      if (isFirstRemoved) {
        const leadingWs = value.match(/^(\s*)/)?.[1] || "";
        value = value.slice(leadingWs.length);
        removedLine += leadingWs;
        isFirstRemoved = false;
      }
      if (value) {
        removedLine += theme.inverse(value);
      }
    } else if (part.added) {
      let value = part.value;
      if (isFirstAdded) {
        const leadingWs = value.match(/^(\s*)/)?.[1] || "";
        value = value.slice(leadingWs.length);
        addedLine += leadingWs;
        isFirstAdded = false;
      }
      if (value) {
        addedLine += theme.inverse(value);
      }
    } else {
      removedLine += part.value;
      addedLine += part.value;
    }
  }
  return { removedLine, addedLine };
}
function syntaxLine(content, lang) {
  if (!lang) return content;
  return highlightCode(content, lang)[0] ?? content;
}
function renderDiff(diffText, options = {}) {
  const lines = diffText.split("\n");
  const result = [];
  const lang = options.filePath ? getLanguageFromPath(options.filePath) : void 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const parsed = parseDiffLine(line);
    if (!parsed) {
      result.push(theme.fg("toolDiffContext", line));
      i++;
      continue;
    }
    if (parsed.prefix === "-") {
      const removedLines = [];
      while (i < lines.length) {
        const p = parseDiffLine(lines[i]);
        if (!p || p.prefix !== "-") break;
        removedLines.push({ lineNum: p.lineNum, content: p.content });
        i++;
      }
      const addedLines = [];
      while (i < lines.length) {
        const p = parseDiffLine(lines[i]);
        if (!p || p.prefix !== "+") break;
        addedLines.push({ lineNum: p.lineNum, content: p.content });
        i++;
      }
      if (removedLines.length === 1 && addedLines.length === 1) {
        const removed = removedLines[0];
        const added = addedLines[0];
        const { removedLine, addedLine } = renderIntraLineDiff(
          replaceTabs(removed.content),
          replaceTabs(added.content)
        );
        result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`));
        result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`));
      } else {
        for (const removed of removedLines) {
          result.push(`${theme.fg("toolDiffRemoved", `-${removed.lineNum} `)}${syntaxLine(replaceTabs(removed.content), lang)}`);
        }
        for (const added of addedLines) {
          result.push(`${theme.fg("toolDiffAdded", `+${added.lineNum} `)}${syntaxLine(replaceTabs(added.content), lang)}`);
        }
      }
    } else if (parsed.prefix === "+") {
      result.push(`${theme.fg("toolDiffAdded", `+${parsed.lineNum} `)}${syntaxLine(replaceTabs(parsed.content), lang)}`);
      i++;
    } else {
      result.push(`${theme.fg("toolDiffContext", ` ${parsed.lineNum} `)}${syntaxLine(replaceTabs(parsed.content), lang)}`);
      i++;
    }
  }
  return result.join("\n");
}
export {
  renderDiff
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL2RpZmYudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCAqIGFzIERpZmYgZnJvbSBcImRpZmZcIjtcbmltcG9ydCB7IGdldExhbmd1YWdlRnJvbVBhdGgsIGhpZ2hsaWdodENvZGUsIHRoZW1lIH0gZnJvbSBcIi4uL3RoZW1lL3RoZW1lLmpzXCI7XG5cbi8qKlxuICogUGFyc2UgZGlmZiBsaW5lIHRvIGV4dHJhY3QgcHJlZml4LCBsaW5lIG51bWJlciwgYW5kIGNvbnRlbnQuXG4gKiBGb3JtYXQ6IFwiKzEyMyBjb250ZW50XCIgb3IgXCItMTIzIGNvbnRlbnRcIiBvciBcIiAxMjMgY29udGVudFwiIG9yIFwiICAgICAuLi5cIlxuICovXG5mdW5jdGlvbiBwYXJzZURpZmZMaW5lKGxpbmU6IHN0cmluZyk6IHsgcHJlZml4OiBzdHJpbmc7IGxpbmVOdW06IHN0cmluZzsgY29udGVudDogc3RyaW5nIH0gfCBudWxsIHtcblx0Y29uc3QgbWF0Y2ggPSBsaW5lLm1hdGNoKC9eKFsrXFwtIF0pKFxccypcXGQqKVxccyguKikkLyk7XG5cdGlmICghbWF0Y2gpIHJldHVybiBudWxsO1xuXHRyZXR1cm4geyBwcmVmaXg6IG1hdGNoWzFdLCBsaW5lTnVtOiBtYXRjaFsyXSwgY29udGVudDogbWF0Y2hbM10gfTtcbn1cblxuLyoqXG4gKiBSZXBsYWNlIHRhYnMgd2l0aCBzcGFjZXMgZm9yIGNvbnNpc3RlbnQgcmVuZGVyaW5nLlxuICovXG5mdW5jdGlvbiByZXBsYWNlVGFicyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdGV4dC5yZXBsYWNlKC9cXHQvZywgXCIgICAgXCIpO1xufVxuXG4vKipcbiAqIENvbXB1dGUgd29yZC1sZXZlbCBkaWZmIGFuZCByZW5kZXIgd2l0aCBpbnZlcnNlIG9uIGNoYW5nZWQgcGFydHMuXG4gKiBVc2VzIGRpZmZXb3JkcyB3aGljaCBncm91cHMgd2hpdGVzcGFjZSB3aXRoIGFkamFjZW50IHdvcmRzIGZvciBjbGVhbmVyIGhpZ2hsaWdodGluZy5cbiAqIFN0cmlwcyBsZWFkaW5nIHdoaXRlc3BhY2UgZnJvbSBpbnZlcnNlIHRvIGF2b2lkIGhpZ2hsaWdodGluZyBpbmRlbnRhdGlvbi5cbiAqL1xuZnVuY3Rpb24gcmVuZGVySW50cmFMaW5lRGlmZihvbGRDb250ZW50OiBzdHJpbmcsIG5ld0NvbnRlbnQ6IHN0cmluZyk6IHsgcmVtb3ZlZExpbmU6IHN0cmluZzsgYWRkZWRMaW5lOiBzdHJpbmcgfSB7XG5cdGNvbnN0IHdvcmREaWZmID0gRGlmZi5kaWZmV29yZHMob2xkQ29udGVudCwgbmV3Q29udGVudCk7XG5cblx0bGV0IHJlbW92ZWRMaW5lID0gXCJcIjtcblx0bGV0IGFkZGVkTGluZSA9IFwiXCI7XG5cdGxldCBpc0ZpcnN0UmVtb3ZlZCA9IHRydWU7XG5cdGxldCBpc0ZpcnN0QWRkZWQgPSB0cnVlO1xuXG5cdGZvciAoY29uc3QgcGFydCBvZiB3b3JkRGlmZikge1xuXHRcdGlmIChwYXJ0LnJlbW92ZWQpIHtcblx0XHRcdGxldCB2YWx1ZSA9IHBhcnQudmFsdWU7XG5cdFx0XHQvLyBTdHJpcCBsZWFkaW5nIHdoaXRlc3BhY2UgZnJvbSB0aGUgZmlyc3QgcmVtb3ZlZCBwYXJ0XG5cdFx0XHRpZiAoaXNGaXJzdFJlbW92ZWQpIHtcblx0XHRcdFx0Y29uc3QgbGVhZGluZ1dzID0gdmFsdWUubWF0Y2goL14oXFxzKikvKT8uWzFdIHx8IFwiXCI7XG5cdFx0XHRcdHZhbHVlID0gdmFsdWUuc2xpY2UobGVhZGluZ1dzLmxlbmd0aCk7XG5cdFx0XHRcdHJlbW92ZWRMaW5lICs9IGxlYWRpbmdXcztcblx0XHRcdFx0aXNGaXJzdFJlbW92ZWQgPSBmYWxzZTtcblx0XHRcdH1cblx0XHRcdGlmICh2YWx1ZSkge1xuXHRcdFx0XHRyZW1vdmVkTGluZSArPSB0aGVtZS5pbnZlcnNlKHZhbHVlKTtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKHBhcnQuYWRkZWQpIHtcblx0XHRcdGxldCB2YWx1ZSA9IHBhcnQudmFsdWU7XG5cdFx0XHQvLyBTdHJpcCBsZWFkaW5nIHdoaXRlc3BhY2UgZnJvbSB0aGUgZmlyc3QgYWRkZWQgcGFydFxuXHRcdFx0aWYgKGlzRmlyc3RBZGRlZCkge1xuXHRcdFx0XHRjb25zdCBsZWFkaW5nV3MgPSB2YWx1ZS5tYXRjaCgvXihcXHMqKS8pPy5bMV0gfHwgXCJcIjtcblx0XHRcdFx0dmFsdWUgPSB2YWx1ZS5zbGljZShsZWFkaW5nV3MubGVuZ3RoKTtcblx0XHRcdFx0YWRkZWRMaW5lICs9IGxlYWRpbmdXcztcblx0XHRcdFx0aXNGaXJzdEFkZGVkID0gZmFsc2U7XG5cdFx0XHR9XG5cdFx0XHRpZiAodmFsdWUpIHtcblx0XHRcdFx0YWRkZWRMaW5lICs9IHRoZW1lLmludmVyc2UodmFsdWUpO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSB7XG5cdFx0XHRyZW1vdmVkTGluZSArPSBwYXJ0LnZhbHVlO1xuXHRcdFx0YWRkZWRMaW5lICs9IHBhcnQudmFsdWU7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIHsgcmVtb3ZlZExpbmUsIGFkZGVkTGluZSB9O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlbmRlckRpZmZPcHRpb25zIHtcblx0LyoqIEZpbGUgcGF0aCB1c2VkIHRvIGNob29zZSBzeW50YXggaGlnaGxpZ2h0aW5nIGZvciBjaGFuZ2VkIGNvbnRlbnQuICovXG5cdGZpbGVQYXRoPzogc3RyaW5nO1xufVxuXG5mdW5jdGlvbiBzeW50YXhMaW5lKGNvbnRlbnQ6IHN0cmluZywgbGFuZzogc3RyaW5nIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcblx0aWYgKCFsYW5nKSByZXR1cm4gY29udGVudDtcblx0cmV0dXJuIGhpZ2hsaWdodENvZGUoY29udGVudCwgbGFuZylbMF0gPz8gY29udGVudDtcbn1cblxuLyoqXG4gKiBSZW5kZXIgYSBkaWZmIHN0cmluZyB3aXRoIGNvbG9yZWQgbGluZXMgYW5kIGludHJhLWxpbmUgY2hhbmdlIGhpZ2hsaWdodGluZy5cbiAqIC0gQ29udGV4dCBsaW5lczogZGltL2dyYXlcbiAqIC0gUmVtb3ZlZCBsaW5lczogcmVkLCB3aXRoIGludmVyc2Ugb24gY2hhbmdlZCB0b2tlbnNcbiAqIC0gQWRkZWQgbGluZXM6IGdyZWVuLCB3aXRoIGludmVyc2Ugb24gY2hhbmdlZCB0b2tlbnNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlckRpZmYoZGlmZlRleHQ6IHN0cmluZywgb3B0aW9uczogUmVuZGVyRGlmZk9wdGlvbnMgPSB7fSk6IHN0cmluZyB7XG5cdGNvbnN0IGxpbmVzID0gZGlmZlRleHQuc3BsaXQoXCJcXG5cIik7XG5cdGNvbnN0IHJlc3VsdDogc3RyaW5nW10gPSBbXTtcblx0Y29uc3QgbGFuZyA9IG9wdGlvbnMuZmlsZVBhdGggPyBnZXRMYW5ndWFnZUZyb21QYXRoKG9wdGlvbnMuZmlsZVBhdGgpIDogdW5kZWZpbmVkO1xuXG5cdGxldCBpID0gMDtcblx0d2hpbGUgKGkgPCBsaW5lcy5sZW5ndGgpIHtcblx0XHRjb25zdCBsaW5lID0gbGluZXNbaV07XG5cdFx0Y29uc3QgcGFyc2VkID0gcGFyc2VEaWZmTGluZShsaW5lKTtcblxuXHRcdGlmICghcGFyc2VkKSB7XG5cdFx0XHRyZXN1bHQucHVzaCh0aGVtZS5mZyhcInRvb2xEaWZmQ29udGV4dFwiLCBsaW5lKSk7XG5cdFx0XHRpKys7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRpZiAocGFyc2VkLnByZWZpeCA9PT0gXCItXCIpIHtcblx0XHRcdC8vIENvbGxlY3QgY29uc2VjdXRpdmUgcmVtb3ZlZCBsaW5lc1xuXHRcdFx0Y29uc3QgcmVtb3ZlZExpbmVzOiB7IGxpbmVOdW06IHN0cmluZzsgY29udGVudDogc3RyaW5nIH1bXSA9IFtdO1xuXHRcdFx0d2hpbGUgKGkgPCBsaW5lcy5sZW5ndGgpIHtcblx0XHRcdFx0Y29uc3QgcCA9IHBhcnNlRGlmZkxpbmUobGluZXNbaV0pO1xuXHRcdFx0XHRpZiAoIXAgfHwgcC5wcmVmaXggIT09IFwiLVwiKSBicmVhaztcblx0XHRcdFx0cmVtb3ZlZExpbmVzLnB1c2goeyBsaW5lTnVtOiBwLmxpbmVOdW0sIGNvbnRlbnQ6IHAuY29udGVudCB9KTtcblx0XHRcdFx0aSsrO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBDb2xsZWN0IGNvbnNlY3V0aXZlIGFkZGVkIGxpbmVzXG5cdFx0XHRjb25zdCBhZGRlZExpbmVzOiB7IGxpbmVOdW06IHN0cmluZzsgY29udGVudDogc3RyaW5nIH1bXSA9IFtdO1xuXHRcdFx0d2hpbGUgKGkgPCBsaW5lcy5sZW5ndGgpIHtcblx0XHRcdFx0Y29uc3QgcCA9IHBhcnNlRGlmZkxpbmUobGluZXNbaV0pO1xuXHRcdFx0XHRpZiAoIXAgfHwgcC5wcmVmaXggIT09IFwiK1wiKSBicmVhaztcblx0XHRcdFx0YWRkZWRMaW5lcy5wdXNoKHsgbGluZU51bTogcC5saW5lTnVtLCBjb250ZW50OiBwLmNvbnRlbnQgfSk7XG5cdFx0XHRcdGkrKztcblx0XHRcdH1cblxuXHRcdFx0Ly8gT25seSBkbyBpbnRyYS1saW5lIGRpZmZpbmcgd2hlbiB0aGVyZSdzIGV4YWN0bHkgb25lIHJlbW92ZWQgYW5kIG9uZSBhZGRlZCBsaW5lXG5cdFx0XHQvLyAoaW5kaWNhdGluZyBhIHNpbmdsZSBsaW5lIG1vZGlmaWNhdGlvbikuIE90aGVyd2lzZSwgc2hvdyBsaW5lcyBhcy1pcy5cblx0XHRcdGlmIChyZW1vdmVkTGluZXMubGVuZ3RoID09PSAxICYmIGFkZGVkTGluZXMubGVuZ3RoID09PSAxKSB7XG5cdFx0XHRcdGNvbnN0IHJlbW92ZWQgPSByZW1vdmVkTGluZXNbMF07XG5cdFx0XHRcdGNvbnN0IGFkZGVkID0gYWRkZWRMaW5lc1swXTtcblxuXHRcdFx0XHRjb25zdCB7IHJlbW92ZWRMaW5lLCBhZGRlZExpbmUgfSA9IHJlbmRlckludHJhTGluZURpZmYoXG5cdFx0XHRcdFx0cmVwbGFjZVRhYnMocmVtb3ZlZC5jb250ZW50KSxcblx0XHRcdFx0XHRyZXBsYWNlVGFicyhhZGRlZC5jb250ZW50KSxcblx0XHRcdFx0KTtcblxuXHRcdFx0XHRyZXN1bHQucHVzaCh0aGVtZS5mZyhcInRvb2xEaWZmUmVtb3ZlZFwiLCBgLSR7cmVtb3ZlZC5saW5lTnVtfSAke3JlbW92ZWRMaW5lfWApKTtcblx0XHRcdFx0cmVzdWx0LnB1c2godGhlbWUuZmcoXCJ0b29sRGlmZkFkZGVkXCIsIGArJHthZGRlZC5saW5lTnVtfSAke2FkZGVkTGluZX1gKSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHQvLyBTaG93IGFsbCByZW1vdmVkIGxpbmVzIGZpcnN0LCB0aGVuIGFsbCBhZGRlZCBsaW5lc1xuXHRcdFx0XHRmb3IgKGNvbnN0IHJlbW92ZWQgb2YgcmVtb3ZlZExpbmVzKSB7XG5cdFx0XHRcdFx0cmVzdWx0LnB1c2goYCR7dGhlbWUuZmcoXCJ0b29sRGlmZlJlbW92ZWRcIiwgYC0ke3JlbW92ZWQubGluZU51bX0gYCl9JHtzeW50YXhMaW5lKHJlcGxhY2VUYWJzKHJlbW92ZWQuY29udGVudCksIGxhbmcpfWApO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGZvciAoY29uc3QgYWRkZWQgb2YgYWRkZWRMaW5lcykge1xuXHRcdFx0XHRcdHJlc3VsdC5wdXNoKGAke3RoZW1lLmZnKFwidG9vbERpZmZBZGRlZFwiLCBgKyR7YWRkZWQubGluZU51bX0gYCl9JHtzeW50YXhMaW5lKHJlcGxhY2VUYWJzKGFkZGVkLmNvbnRlbnQpLCBsYW5nKX1gKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAocGFyc2VkLnByZWZpeCA9PT0gXCIrXCIpIHtcblx0XHRcdC8vIFN0YW5kYWxvbmUgYWRkZWQgbGluZVxuXHRcdFx0cmVzdWx0LnB1c2goYCR7dGhlbWUuZmcoXCJ0b29sRGlmZkFkZGVkXCIsIGArJHtwYXJzZWQubGluZU51bX0gYCl9JHtzeW50YXhMaW5lKHJlcGxhY2VUYWJzKHBhcnNlZC5jb250ZW50KSwgbGFuZyl9YCk7XG5cdFx0XHRpKys7XG5cdFx0fSBlbHNlIHtcblx0XHRcdC8vIENvbnRleHQgbGluZVxuXHRcdFx0cmVzdWx0LnB1c2goYCR7dGhlbWUuZmcoXCJ0b29sRGlmZkNvbnRleHRcIiwgYCAke3BhcnNlZC5saW5lTnVtfSBgKX0ke3N5bnRheExpbmUocmVwbGFjZVRhYnMocGFyc2VkLmNvbnRlbnQpLCBsYW5nKX1gKTtcblx0XHRcdGkrKztcblx0XHR9XG5cdH1cblxuXHRyZXR1cm4gcmVzdWx0LmpvaW4oXCJcXG5cIik7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxZQUFZLFVBQVU7QUFDdEIsU0FBUyxxQkFBcUIsZUFBZSxhQUFhO0FBTTFELFNBQVMsY0FBYyxNQUEyRTtBQUNqRyxRQUFNLFFBQVEsS0FBSyxNQUFNLDBCQUEwQjtBQUNuRCxNQUFJLENBQUMsTUFBTyxRQUFPO0FBQ25CLFNBQU8sRUFBRSxRQUFRLE1BQU0sQ0FBQyxHQUFHLFNBQVMsTUFBTSxDQUFDLEdBQUcsU0FBUyxNQUFNLENBQUMsRUFBRTtBQUNqRTtBQUtBLFNBQVMsWUFBWSxNQUFzQjtBQUMxQyxTQUFPLEtBQUssUUFBUSxPQUFPLE1BQU07QUFDbEM7QUFPQSxTQUFTLG9CQUFvQixZQUFvQixZQUFnRTtBQUNoSCxRQUFNLFdBQVcsS0FBSyxVQUFVLFlBQVksVUFBVTtBQUV0RCxNQUFJLGNBQWM7QUFDbEIsTUFBSSxZQUFZO0FBQ2hCLE1BQUksaUJBQWlCO0FBQ3JCLE1BQUksZUFBZTtBQUVuQixhQUFXLFFBQVEsVUFBVTtBQUM1QixRQUFJLEtBQUssU0FBUztBQUNqQixVQUFJLFFBQVEsS0FBSztBQUVqQixVQUFJLGdCQUFnQjtBQUNuQixjQUFNLFlBQVksTUFBTSxNQUFNLFFBQVEsSUFBSSxDQUFDLEtBQUs7QUFDaEQsZ0JBQVEsTUFBTSxNQUFNLFVBQVUsTUFBTTtBQUNwQyx1QkFBZTtBQUNmLHlCQUFpQjtBQUFBLE1BQ2xCO0FBQ0EsVUFBSSxPQUFPO0FBQ1YsdUJBQWUsTUFBTSxRQUFRLEtBQUs7QUFBQSxN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
