import { marked } from "marked";
import { isImageLine } from "../terminal-image.js";
import { applyBackgroundToLine, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.js";
class Markdown {
  constructor(text, paddingX, paddingY, theme, defaultTextStyle) {
    this.text = text;
    this.paddingX = paddingX;
    this.paddingY = paddingY;
    this.theme = theme;
    this.defaultTextStyle = defaultTextStyle;
  }
  setText(text) {
    this.text = text;
    this.invalidate();
  }
  invalidate() {
    this.cachedText = void 0;
    this.cachedWidth = void 0;
    this.cachedMaxLines = void 0;
    this.cachedLines = void 0;
  }
  render(width) {
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width && this.cachedMaxLines === this.maxLines) {
      return this.cachedLines;
    }
    const contentWidth = Math.max(1, width - this.paddingX * 2);
    if (!this.text || this.text.trim() === "") {
      const result2 = [];
      this.cachedText = this.text;
      this.cachedWidth = width;
      this.cachedMaxLines = this.maxLines;
      this.cachedLines = result2;
      return result2;
    }
    const normalizedText = this.text.replace(/\t/g, "   ");
    const tokens = marked.lexer(normalizedText);
    const renderedLines = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const nextToken = tokens[i + 1];
      const tokenLines = this.renderToken(token, contentWidth, nextToken?.type);
      for (let j = 0; j < tokenLines.length; j++) renderedLines.push(tokenLines[j]);
    }
    while (renderedLines.length > 0 && renderedLines[renderedLines.length - 1] === "") {
      renderedLines.pop();
    }
    const wrappedLines = [];
    for (const line of renderedLines) {
      if (isImageLine(line)) {
        wrappedLines.push(line);
      } else {
        const wrapped = wrapTextWithAnsi(line, contentWidth);
        for (const wl of wrapped) {
          wrappedLines.push(visibleWidth(wl) > contentWidth ? truncateToWidth(wl, contentWidth, "") : wl);
        }
      }
    }
    if (this.maxLines !== void 0 && wrappedLines.length > this.maxLines) {
      const keep = Math.max(1, this.maxLines - 1);
      const truncated = wrappedLines.length - keep;
      wrappedLines.splice(0, truncated, `\u2026 ${truncated} line${truncated !== 1 ? "s" : ""} above`);
    }
    const leftMargin = " ".repeat(this.paddingX);
    const rightMargin = " ".repeat(this.paddingX);
    const bgFn = this.defaultTextStyle?.bgColor;
    const contentLines = [];
    for (const line of wrappedLines) {
      if (isImageLine(line)) {
        contentLines.push(line);
        continue;
      }
      const lineWithMargins = leftMargin + line + rightMargin;
      if (bgFn) {
        contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
      } else {
        const visibleLen = visibleWidth(lineWithMargins);
        const paddingNeeded = Math.max(0, width - visibleLen);
        contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
      }
    }
    const emptyLine = " ".repeat(width);
    const emptyLines = [];
    for (let i = 0; i < this.paddingY; i++) {
      const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
      emptyLines.push(line);
    }
    const result = [...emptyLines, ...contentLines, ...emptyLines];
    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedMaxLines = this.maxLines;
    this.cachedLines = result;
    return result.length > 0 ? result : [""];
  }
  /**
   * Apply default text style to a string.
   * This is the base styling applied to all text content.
   * NOTE: Background color is NOT applied here - it's applied at the padding stage
   * to ensure it extends to the full line width.
   */
  applyDefaultStyle(text) {
    if (!this.defaultTextStyle) {
      return text;
    }
    let styled = text;
    if (this.defaultTextStyle.color) {
      styled = this.defaultTextStyle.color(styled);
    }
    if (this.defaultTextStyle.bold) {
      styled = this.theme.bold(styled);
    }
    if (this.defaultTextStyle.italic) {
      styled = this.theme.italic(styled);
    }
    if (this.defaultTextStyle.strikethrough) {
      styled = this.theme.strikethrough(styled);
    }
    if (this.defaultTextStyle.underline) {
      styled = this.theme.underline(styled);
    }
    return styled;
  }
  getDefaultStylePrefix() {
    if (!this.defaultTextStyle) {
      return "";
    }
    if (this.defaultStylePrefix !== void 0) {
      return this.defaultStylePrefix;
    }
    const sentinel = "\0";
    let styled = sentinel;
    if (this.defaultTextStyle.color) {
      styled = this.defaultTextStyle.color(styled);
    }
    if (this.defaultTextStyle.bold) {
      styled = this.theme.bold(styled);
    }
    if (this.defaultTextStyle.italic) {
      styled = this.theme.italic(styled);
    }
    if (this.defaultTextStyle.strikethrough) {
      styled = this.theme.strikethrough(styled);
    }
    if (this.defaultTextStyle.underline) {
      styled = this.theme.underline(styled);
    }
    const sentinelIndex = styled.indexOf(sentinel);
    this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
    return this.defaultStylePrefix;
  }
  getStylePrefix(styleFn) {
    const sentinel = "\0";
    const styled = styleFn(sentinel);
    const sentinelIndex = styled.indexOf(sentinel);
    return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
  }
  getDefaultInlineStyleContext() {
    return {
      applyText: (text) => this.applyDefaultStyle(text),
      stylePrefix: this.getDefaultStylePrefix()
    };
  }
  renderToken(token, width, nextTokenType, styleContext) {
    const lines = [];
    switch (token.type) {
      case "heading": {
        const headingLevel = token.depth;
        const headingPrefix = `${"#".repeat(headingLevel)} `;
        const headingText = this.renderInlineTokens(token.tokens || [], styleContext);
        let styledHeading;
        if (headingLevel === 1) {
          styledHeading = this.theme.heading(this.theme.bold(this.theme.underline(headingText)));
        } else if (headingLevel === 2) {
          styledHeading = this.theme.heading(this.theme.bold(headingText));
        } else {
          styledHeading = this.theme.heading(this.theme.bold(headingPrefix + headingText));
        }
        lines.push(styledHeading);
        if (nextTokenType !== "space") {
          lines.push("");
        }
        break;
      }
      case "paragraph": {
        const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
        lines.push(paragraphText);
        if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
          lines.push("");
        }
        break;
      }
      case "code": {
        const codeBlockLines = this.renderCodeBlock(token.text, token.lang);
        for (let j = 0; j < codeBlockLines.length; j++) lines.push(codeBlockLines[j]);
        if (nextTokenType !== "space") {
          lines.push("");
        }
        break;
      }
      case "list": {
        const listLines = this.renderList(token, 0, styleContext);
        for (let j = 0; j < listLines.length; j++) lines.push(listLines[j]);
        break;
      }
      case "table": {
        const tableLines = this.renderTable(token, width, styleContext);
        for (let j = 0; j < tableLines.length; j++) lines.push(tableLines[j]);
        break;
      }
      case "blockquote": {
        const quoteStyle = (text) => this.theme.quote(this.theme.italic(text));
        const quoteStylePrefix = this.getStylePrefix(quoteStyle);
        const applyQuoteStyle = (line) => {
          if (!quoteStylePrefix) {
            return quoteStyle(line);
          }
          const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1B[0m${quoteStylePrefix}`);
          return quoteStyle(lineWithReappliedStyle);
        };
        const quoteContentWidth = Math.max(1, width - 2);
        const quoteInlineStyleContext = {
          applyText: (text) => text,
          stylePrefix: ""
        };
        const quoteTokens = token.tokens || [];
        const renderedQuoteLines = [];
        for (let i = 0; i < quoteTokens.length; i++) {
          const quoteToken = quoteTokens[i];
          const nextQuoteToken = quoteTokens[i + 1];
          renderedQuoteLines.push(
            ...this.renderToken(quoteToken, quoteContentWidth, nextQuoteToken?.type, quoteInlineStyleContext)
          );
        }
        while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
          renderedQuoteLines.pop();
        }
        for (const quoteLine of renderedQuoteLines) {
          const styledLine = applyQuoteStyle(quoteLine);
          const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
          for (const wrappedLine of wrappedLines) {
            lines.push(this.theme.quoteBorder("\u2502 ") + wrappedLine);
          }
        }
        if (nextTokenType !== "space") {
          lines.push("");
        }
        break;
      }
      case "hr":
        lines.push(this.theme.hr("\u2500".repeat(Math.min(width, 80))));
        if (nextTokenType !== "space") {
          lines.push("");
        }
        break;
      case "html":
        if ("raw" in token && typeof token.raw === "string") {
          lines.push(this.applyDefaultStyle(token.raw.trim()));
        }
        break;
      case "space":
        lines.push("");
        break;
      default:
        if ("text" in token && typeof token.text === "string") {
          lines.push(token.text);
        }
    }
    return lines;
  }
  renderInlineTokens(tokens, styleContext) {
    let result = "";
    const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
    const { applyText, stylePrefix } = resolvedStyleContext;
    const applyTextWithNewlines = (text) => {
      const segments = text.split("\n");
      return segments.map((segment) => applyText(segment)).join("\n");
    };
    for (const token of tokens) {
      switch (token.type) {
        case "text":
          if (token.tokens && token.tokens.length > 0) {
            result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
          } else {
            result += applyTextWithNewlines(token.text);
          }
          break;
        case "paragraph":
          result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
          break;
        case "strong": {
          const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
          result += this.theme.bold(boldContent) + stylePrefix;
          break;
        }
        case "em": {
          const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
          result += this.theme.italic(italicContent) + stylePrefix;
          break;
        }
        case "codespan":
          result += this.theme.code(token.text) + stylePrefix;
          break;
        case "link": {
          const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
          const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
          if (token.text === token.href || token.text === hrefForComparison) {
            result += this.theme.link(this.theme.underline(linkText)) + stylePrefix;
          } else {
            result += this.theme.link(this.theme.underline(linkText)) + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
          }
          break;
        }
        case "br":
          result += "\n";
          break;
        case "del": {
          const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
          result += this.theme.strikethrough(delContent) + stylePrefix;
          break;
        }
        case "html":
          if ("raw" in token && typeof token.raw === "string") {
            result += applyTextWithNewlines(token.raw);
          }
          break;
        default:
          if ("text" in token && typeof token.text === "string") {
            result += applyTextWithNewlines(token.text);
          }
      }
    }
    return result;
  }
  /**
   * Render a list with proper nesting support
   */
  renderList(token, depth, styleContext) {
    const lines = [];
    const indent = "  ".repeat(depth);
    const startNumber = token.start ?? 1;
    for (let i = 0; i < token.items.length; i++) {
      const item = token.items[i];
      const bullet = token.ordered ? `${startNumber + i}. ` : "- ";
      const itemLines = this.renderListItem(item.tokens || [], depth, styleContext);
      if (itemLines.length > 0) {
        const firstLine = itemLines[0];
        const isNestedList = /^\s+\x1b\[36m[-\d]/.test(firstLine);
        if (isNestedList) {
          lines.push(firstLine);
        } else {
          lines.push(indent + this.theme.listBullet(bullet) + firstLine);
        }
        for (let j = 1; j < itemLines.length; j++) {
          const line = itemLines[j];
          const isNestedListLine = /^\s+\x1b\[36m[-\d]/.test(line);
          if (isNestedListLine) {
            lines.push(line);
          } else {
            lines.push(`${indent}  ${line}`);
          }
        }
      } else {
        lines.push(indent + this.theme.listBullet(bullet));
      }
    }
    return lines;
  }
  /**
   * Render list item tokens, handling nested lists
   * Returns lines WITHOUT the parent indent (renderList will add it)
   */
  renderListItem(tokens, parentDepth, styleContext) {
    const lines = [];
    for (const token of tokens) {
      if (token.type === "list") {
        const nestedLines = this.renderList(token, parentDepth + 1, styleContext);
        for (let j = 0; j < nestedLines.length; j++) lines.push(nestedLines[j]);
      } else if (token.type === "text") {
        const text = token.tokens && token.tokens.length > 0 ? this.renderInlineTokens(token.tokens, styleContext) : token.text || "";
        lines.push(text);
      } else if (token.type === "paragraph") {
        const text = this.renderInlineTokens(token.tokens || [], styleContext);
        lines.push(text);
      } else if (token.type === "code") {
        const codeLines = this.renderCodeBlock(token.text, token.lang);
        for (let j = 0; j < codeLines.length; j++) lines.push(codeLines[j]);
      } else {
        const text = this.renderInlineTokens([token], styleContext);
        if (text) {
          lines.push(text);
        }
      }
    }
    return lines;
  }
  /**
   * Render a fenced code block with syntax highlighting support.
   * Used by both renderToken (top-level code blocks) and renderListItem (code blocks inside lists).
   */
  renderCodeBlock(code, lang) {
    const lines = [];
    const indent = this.theme.codeBlockIndent ?? "  ";
    lines.push(this.theme.codeBlockBorder(`\`\`\`${lang || ""}`));
    if (this.theme.highlightCode) {
      const highlightedLines = this.theme.highlightCode(code, lang);
      for (const hlLine of highlightedLines) {
        lines.push(`${indent}${hlLine}`);
      }
    } else {
      const codeLines = code.split("\n");
      for (const codeLine of codeLines) {
        lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
      }
    }
    lines.push(this.theme.codeBlockBorder("```"));
    return lines;
  }
  /**
   * Get the visible width of the longest word in a string.
   */
  getLongestWordWidth(text, maxWidth) {
    const words = text.split(/\s+/).filter((word) => word.length > 0);
    let longest = 0;
    for (const word of words) {
      longest = Math.max(longest, visibleWidth(word));
    }
    if (maxWidth === void 0) {
      return longest;
    }
    return Math.min(longest, maxWidth);
  }
  /**
   * Wrap a table cell to fit into a column.
   *
   * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
   * consistently with the rest of the renderer.
   */
  wrapCellText(text, maxWidth) {
    return wrapTextWithAnsi(text, Math.max(1, maxWidth));
  }
  /**
   * Render a table with width-aware cell wrapping.
   * Cells that don't fit are wrapped to multiple lines.
   */
  renderTable(token, availableWidth, styleContext) {
    const lines = [];
    const numCols = token.header.length;
    if (numCols === 0) {
      return lines;
    }
    const borderOverhead = 3 * numCols + 1;
    const availableForCells = availableWidth - borderOverhead;
    if (availableForCells < numCols) {
      const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
      fallbackLines.push("");
      return fallbackLines;
    }
    const maxUnbrokenWordWidth = 30;
    const naturalWidths = [];
    const minWordWidths = [];
    for (let i = 0; i < numCols; i++) {
      const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
      naturalWidths[i] = visibleWidth(headerText);
      minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
    }
    for (const row of token.rows) {
      for (let i = 0; i < row.length; i++) {
        const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
        naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
        minWordWidths[i] = Math.max(
          minWordWidths[i] || 1,
          this.getLongestWordWidth(cellText, maxUnbrokenWordWidth)
        );
      }
    }
    let minColumnWidths = minWordWidths;
    let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
    if (minCellsWidth > availableForCells) {
      minColumnWidths = new Array(numCols).fill(1);
      const remaining = availableForCells - numCols;
      if (remaining > 0) {
        const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
        const growth = minWordWidths.map((width) => {
          const weight = Math.max(0, width - 1);
          return totalWeight > 0 ? Math.floor(weight / totalWeight * remaining) : 0;
        });
        for (let i = 0; i < numCols; i++) {
          minColumnWidths[i] += growth[i] ?? 0;
        }
        const allocated = growth.reduce((total, width) => total + width, 0);
        let leftover = remaining - allocated;
        for (let i = 0; leftover > 0 && i < numCols; i++) {
          minColumnWidths[i]++;
          leftover--;
        }
      }
      minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
    }
    const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
    let columnWidths;
    if (totalNaturalWidth <= availableWidth) {
      columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
    } else {
      const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
        return total + Math.max(0, width - minColumnWidths[index]);
      }, 0);
      const extraWidth = Math.max(0, availableForCells - minCellsWidth);
      columnWidths = minColumnWidths.map((minWidth, index) => {
        const naturalWidth = naturalWidths[index];
        const minWidthDelta = Math.max(0, naturalWidth - minWidth);
        let grow = 0;
        if (totalGrowPotential > 0) {
          grow = Math.floor(minWidthDelta / totalGrowPotential * extraWidth);
        }
        return minWidth + grow;
      });
      const allocated = columnWidths.reduce((a, b) => a + b, 0);
      let remaining = availableForCells - allocated;
      while (remaining > 0) {
        let grew = false;
        for (let i = 0; i < numCols && remaining > 0; i++) {
          if (columnWidths[i] < naturalWidths[i]) {
            columnWidths[i]++;
            remaining--;
            grew = true;
          }
        }
        if (!grew) {
          break;
        }
      }
    }
    const topBorderCells = columnWidths.map((w) => "\u2500".repeat(w));
    lines.push(`\u250C\u2500${topBorderCells.join("\u2500\u252C\u2500")}\u2500\u2510`);
    const headerCellLines = token.header.map((cell, i) => {
      const text = this.renderInlineTokens(cell.tokens || [], styleContext);
      return this.wrapCellText(text, columnWidths[i]);
    });
    const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));
    for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
      const rowParts = headerCellLines.map((cellLines, colIdx) => {
        const text = cellLines[lineIdx] || "";
        const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
        return this.theme.bold(padded);
      });
      lines.push(`\u2502 ${rowParts.join(" \u2502 ")} \u2502`);
    }
    const separatorCells = columnWidths.map((w) => "\u2500".repeat(w));
    const separatorLine = `\u251C\u2500${separatorCells.join("\u2500\u253C\u2500")}\u2500\u2524`;
    lines.push(separatorLine);
    for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
      const row = token.rows[rowIndex];
      const rowCellLines = row.map((cell, i) => {
        const text = this.renderInlineTokens(cell.tokens || [], styleContext);
        return this.wrapCellText(text, columnWidths[i]);
      });
      const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));
      for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
        const rowParts = rowCellLines.map((cellLines, colIdx) => {
          const text = cellLines[lineIdx] || "";
          return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
        });
        lines.push(`\u2502 ${rowParts.join(" \u2502 ")} \u2502`);
      }
      if (rowIndex < token.rows.length - 1) {
        lines.push(separatorLine);
      }
    }
    const bottomBorderCells = columnWidths.map((w) => "\u2500".repeat(w));
    lines.push(`\u2514\u2500${bottomBorderCells.join("\u2500\u2534\u2500")}\u2500\u2518`);
    lines.push("");
    return lines;
  }
}
export {
  Markdown
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktdHVpL3NyYy9jb21wb25lbnRzL21hcmtkb3duLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBtYXJrZWQsIHR5cGUgVG9rZW4gfSBmcm9tIFwibWFya2VkXCI7XG5pbXBvcnQgeyBpc0ltYWdlTGluZSB9IGZyb20gXCIuLi90ZXJtaW5hbC1pbWFnZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBDb21wb25lbnQgfSBmcm9tIFwiLi4vdHVpLmpzXCI7XG5pbXBvcnQgeyBhcHBseUJhY2tncm91bmRUb0xpbmUsIHRydW5jYXRlVG9XaWR0aCwgdmlzaWJsZVdpZHRoLCB3cmFwVGV4dFdpdGhBbnNpIH0gZnJvbSBcIi4uL3V0aWxzLmpzXCI7XG5cbi8qKlxuICogRGVmYXVsdCB0ZXh0IHN0eWxpbmcgZm9yIG1hcmtkb3duIGNvbnRlbnQuXG4gKiBBcHBsaWVkIHRvIGFsbCB0ZXh0IHVubGVzcyBvdmVycmlkZGVuIGJ5IG1hcmtkb3duIGZvcm1hdHRpbmcuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRGVmYXVsdFRleHRTdHlsZSB7XG5cdC8qKiBGb3JlZ3JvdW5kIGNvbG9yIGZ1bmN0aW9uICovXG5cdGNvbG9yPzogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nO1xuXHQvKiogQmFja2dyb3VuZCBjb2xvciBmdW5jdGlvbiAqL1xuXHRiZ0NvbG9yPzogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nO1xuXHQvKiogQm9sZCB0ZXh0ICovXG5cdGJvbGQ/OiBib29sZWFuO1xuXHQvKiogSXRhbGljIHRleHQgKi9cblx0aXRhbGljPzogYm9vbGVhbjtcblx0LyoqIFN0cmlrZXRocm91Z2ggdGV4dCAqL1xuXHRzdHJpa2V0aHJvdWdoPzogYm9vbGVhbjtcblx0LyoqIFVuZGVybGluZSB0ZXh0ICovXG5cdHVuZGVybGluZT86IGJvb2xlYW47XG59XG5cbi8qKlxuICogVGhlbWUgZnVuY3Rpb25zIGZvciBtYXJrZG93biBlbGVtZW50cy5cbiAqIEVhY2ggZnVuY3Rpb24gdGFrZXMgdGV4dCBhbmQgcmV0dXJucyBzdHlsZWQgdGV4dCB3aXRoIEFOU0kgY29kZXMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTWFya2Rvd25UaGVtZSB7XG5cdGhlYWRpbmc6ICh0ZXh0OiBzdHJpbmcpID0+IHN0cmluZztcblx0bGluazogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nO1xuXHRsaW5rVXJsOiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmc7XG5cdGNvZGU6ICh0ZXh0OiBzdHJpbmcpID0+IHN0cmluZztcblx0Y29kZUJsb2NrOiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmc7XG5cdGNvZGVCbG9ja0JvcmRlcjogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nO1xuXHRxdW90ZTogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nO1xuXHRxdW90ZUJvcmRlcjogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nO1xuXHRocjogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nO1xuXHRsaXN0QnVsbGV0OiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmc7XG5cdGJvbGQ6ICh0ZXh0OiBzdHJpbmcpID0+IHN0cmluZztcblx0aXRhbGljOiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmc7XG5cdHN0cmlrZXRocm91Z2g6ICh0ZXh0OiBzdHJpbmcpID0+IHN0cmluZztcblx0dW5kZXJsaW5lOiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmc7XG5cdGhpZ2hsaWdodENvZGU/OiAoY29kZTogc3RyaW5nLCBsYW5nPzogc3RyaW5nKSA9PiBzdHJpbmdbXTtcblx0LyoqIFByZWZpeCBhcHBsaWVkIHRvIGVhY2ggcmVuZGVyZWQgY29kZSBibG9jayBsaW5lIChkZWZhdWx0OiBcIiAgXCIpICovXG5cdGNvZGVCbG9ja0luZGVudD86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIElubGluZVN0eWxlQ29udGV4dCB7XG5cdGFwcGx5VGV4dDogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nO1xuXHRzdHlsZVByZWZpeDogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgTWFya2Rvd24gaW1wbGVtZW50cyBDb21wb25lbnQge1xuXHRwcml2YXRlIHRleHQ6IHN0cmluZztcblx0cHJpdmF0ZSBwYWRkaW5nWDogbnVtYmVyOyAvLyBMZWZ0L3JpZ2h0IHBhZGRpbmdcblx0cHJpdmF0ZSBwYWRkaW5nWTogbnVtYmVyOyAvLyBUb3AvYm90dG9tIHBhZGRpbmdcblx0cHJpdmF0ZSBkZWZhdWx0VGV4dFN0eWxlPzogRGVmYXVsdFRleHRTdHlsZTtcblx0cHJpdmF0ZSB0aGVtZTogTWFya2Rvd25UaGVtZTtcblx0cHJpdmF0ZSBkZWZhdWx0U3R5bGVQcmVmaXg/OiBzdHJpbmc7XG5cdC8qKiBNYXhpbXVtIHJlbmRlcmVkIGxpbmVzIChleGNsdWRpbmcgcGFkZGluZykuIFdoZW4gc2V0LCBjb250ZW50IGlzIHRydW5jYXRlZCBmcm9tIHRoZSB0b3Agd2l0aCBhbiBlbGxpcHNpcyBpbmRpY2F0b3Igc28gdGhlIG1vc3QgcmVjZW50IG91dHB1dCByZW1haW5zIHZpc2libGUuICovXG5cdG1heExpbmVzPzogbnVtYmVyO1xuXG5cdC8vIENhY2hlIGZvciByZW5kZXJlZCBvdXRwdXRcblx0cHJpdmF0ZSBjYWNoZWRUZXh0Pzogc3RyaW5nO1xuXHRwcml2YXRlIGNhY2hlZFdpZHRoPzogbnVtYmVyO1xuXHRwcml2YXRlIGNhY2hlZE1heExpbmVzPzogbnVtYmVyO1xuXHRwcml2YXRlIGNhY2hlZExpbmVzPzogc3RyaW5nW107XG5cblx0Y29uc3RydWN0b3IoXG5cdFx0dGV4dDogc3RyaW5nLFxuXHRcdHBhZGRpbmdYOiBudW1iZXIsXG5cdFx0cGFkZGluZ1k6IG51bWJlcixcblx0XHR0aGVtZTogTWFya2Rvd25UaGVtZSxcblx0XHRkZWZhdWx0VGV4dFN0eWxlPzogRGVmYXVsdFRleHRTdHlsZSxcblx0KSB7XG5cdFx0dGhpcy50ZXh0ID0gdGV4dDtcblx0XHR0aGlzLnBhZGRpbmdYID0gcGFkZGluZ1g7XG5cdFx0dGhpcy5wYWRkaW5nWSA9IHBhZGRpbmdZO1xuXHRcdHRoaXMudGhlbWUgPSB0aGVtZTtcblx0XHR0aGlzLmRlZmF1bHRUZXh0U3R5bGUgPSBkZWZhdWx0VGV4dFN0eWxlO1xuXHR9XG5cblx0c2V0VGV4dCh0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcblx0XHR0aGlzLnRleHQgPSB0ZXh0O1xuXHRcdHRoaXMuaW52YWxpZGF0ZSgpO1xuXHR9XG5cblx0aW52YWxpZGF0ZSgpOiB2b2lkIHtcblx0XHR0aGlzLmNhY2hlZFRleHQgPSB1bmRlZmluZWQ7XG5cdFx0dGhpcy5jYWNoZWRXaWR0aCA9IHVuZGVmaW5lZDtcblx0XHR0aGlzLmNhY2hlZE1heExpbmVzID0gdW5kZWZpbmVkO1xuXHRcdHRoaXMuY2FjaGVkTGluZXMgPSB1bmRlZmluZWQ7XG5cdH1cblxuXHRyZW5kZXIod2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcblx0XHQvLyBDaGVjayBjYWNoZVxuXHRcdGlmICh0aGlzLmNhY2hlZExpbmVzICYmIHRoaXMuY2FjaGVkVGV4dCA9PT0gdGhpcy50ZXh0ICYmIHRoaXMuY2FjaGVkV2lkdGggPT09IHdpZHRoICYmIHRoaXMuY2FjaGVkTWF4TGluZXMgPT09IHRoaXMubWF4TGluZXMpIHtcblx0XHRcdHJldHVybiB0aGlzLmNhY2hlZExpbmVzO1xuXHRcdH1cblxuXHRcdC8vIENhbGN1bGF0ZSBhdmFpbGFibGUgd2lkdGggZm9yIGNvbnRlbnQgKHN1YnRyYWN0IGhvcml6b250YWwgcGFkZGluZylcblx0XHRjb25zdCBjb250ZW50V2lkdGggPSBNYXRoLm1heCgxLCB3aWR0aCAtIHRoaXMucGFkZGluZ1ggKiAyKTtcblxuXHRcdC8vIERvbid0IHJlbmRlciBhbnl0aGluZyBpZiB0aGVyZSdzIG5vIGFjdHVhbCB0ZXh0XG5cdFx0aWYgKCF0aGlzLnRleHQgfHwgdGhpcy50ZXh0LnRyaW0oKSA9PT0gXCJcIikge1xuXHRcdFx0Y29uc3QgcmVzdWx0OiBzdHJpbmdbXSA9IFtdO1xuXHRcdFx0Ly8gVXBkYXRlIGNhY2hlXG5cdFx0XHR0aGlzLmNhY2hlZFRleHQgPSB0aGlzLnRleHQ7XG5cdFx0XHR0aGlzLmNhY2hlZFdpZHRoID0gd2lkdGg7XG5cdFx0XHR0aGlzLmNhY2hlZE1heExpbmVzID0gdGhpcy5tYXhMaW5lcztcblx0XHRcdHRoaXMuY2FjaGVkTGluZXMgPSByZXN1bHQ7XG5cdFx0XHRyZXR1cm4gcmVzdWx0O1xuXHRcdH1cblxuXHRcdC8vIFJlcGxhY2UgdGFicyB3aXRoIDMgc3BhY2VzIGZvciBjb25zaXN0ZW50IHJlbmRlcmluZ1xuXHRcdGNvbnN0IG5vcm1hbGl6ZWRUZXh0ID0gdGhpcy50ZXh0LnJlcGxhY2UoL1xcdC9nLCBcIiAgIFwiKTtcblxuXHRcdC8vIFBhcnNlIG1hcmtkb3duIHRvIEhUTUwtbGlrZSB0b2tlbnNcblx0XHRjb25zdCB0b2tlbnMgPSBtYXJrZWQubGV4ZXIobm9ybWFsaXplZFRleHQpO1xuXG5cdFx0Ly8gQ29udmVydCB0b2tlbnMgdG8gc3R5bGVkIHRlcm1pbmFsIG91dHB1dFxuXHRcdGNvbnN0IHJlbmRlcmVkTGluZXM6IHN0cmluZ1tdID0gW107XG5cblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHRva2Vucy5sZW5ndGg7IGkrKykge1xuXHRcdFx0Y29uc3QgdG9rZW4gPSB0b2tlbnNbaV07XG5cdFx0XHRjb25zdCBuZXh0VG9rZW4gPSB0b2tlbnNbaSArIDFdO1xuXHRcdFx0Y29uc3QgdG9rZW5MaW5lcyA9IHRoaXMucmVuZGVyVG9rZW4odG9rZW4sIGNvbnRlbnRXaWR0aCwgbmV4dFRva2VuPy50eXBlKTtcblx0XHRcdGZvciAobGV0IGogPSAwOyBqIDwgdG9rZW5MaW5lcy5sZW5ndGg7IGorKykgcmVuZGVyZWRMaW5lcy5wdXNoKHRva2VuTGluZXNbal0pO1xuXHRcdH1cblxuXHRcdC8vIFRyaW0gdHJhaWxpbmcgZW1wdHkgbGluZXMgXHUyMDE0IGludGVyLWJsb2NrIHNwYWNpbmcgYXQgdGhlIGVuZCBqdXN0IGFkZHNcblx0XHQvLyB1bndhbnRlZCB3aGl0ZXNwYWNlIGJlZm9yZSB3aGF0ZXZlciBmb2xsb3dzIChlLmcuIHBpbm5lZCBvdXRwdXQgYm9yZGVyKS5cblx0XHR3aGlsZSAocmVuZGVyZWRMaW5lcy5sZW5ndGggPiAwICYmIHJlbmRlcmVkTGluZXNbcmVuZGVyZWRMaW5lcy5sZW5ndGggLSAxXSA9PT0gXCJcIikge1xuXHRcdFx0cmVuZGVyZWRMaW5lcy5wb3AoKTtcblx0XHR9XG5cblx0XHQvLyBXcmFwIGxpbmVzIChOTyBwYWRkaW5nLCBOTyBiYWNrZ3JvdW5kIHlldClcblx0XHRjb25zdCB3cmFwcGVkTGluZXM6IHN0cmluZ1tdID0gW107XG5cdFx0Zm9yIChjb25zdCBsaW5lIG9mIHJlbmRlcmVkTGluZXMpIHtcblx0XHRcdGlmIChpc0ltYWdlTGluZShsaW5lKSkge1xuXHRcdFx0XHR3cmFwcGVkTGluZXMucHVzaChsaW5lKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGNvbnN0IHdyYXBwZWQgPSB3cmFwVGV4dFdpdGhBbnNpKGxpbmUsIGNvbnRlbnRXaWR0aCk7XG5cdFx0XHRcdGZvciAoY29uc3Qgd2wgb2Ygd3JhcHBlZCkge1xuXHRcdFx0XHRcdC8vIFNhZmV0eSBuZXQ6IHNpbGVudGx5IHRydW5jYXRlIGxpbmVzIHRoYXQgc3RpbGwgZXhjZWVkIGNvbnRlbnRXaWR0aC5cblx0XHRcdFx0XHQvLyBUaGlzIGhhbmRsZXMgZWRnZSBjYXNlcyBsaWtlIGNvZGUgYmxvY2tzIHdpdGggdmVyeSBsb25nIHdoaXRlc3BhY2Vcblx0XHRcdFx0XHQvLyBzZXF1ZW5jZXMgb3IgdG9rZW5zIHRoYXQgd3JhcFRleHRXaXRoQW5zaSBjYW5ub3Qgc3BsaXQgZnVydGhlci5cblx0XHRcdFx0XHQvLyBObyBlbGxpcHNpcyBpcyB1c2VkIChlbXB0eSBzdHJpbmcpIHRvIGF2b2lkIHZpc3VhbCBub2lzZSBpbiBjb2RlIG91dHB1dDtcblx0XHRcdFx0XHQvLyB0aGUgdHJ1bmNhdGlvbiBpcyBpbnRlbnRpb25hbCBhbmQgbWF0Y2hlcyB0aGUgdGVybWluYWwtd2lkdGggc2FmZXR5XG5cdFx0XHRcdFx0Ly8gYmVoYXZpb3IgZXhwZWN0ZWQgZnJvbSBhbGwgVFVJIGNvbXBvbmVudHMuXG5cdFx0XHRcdFx0d3JhcHBlZExpbmVzLnB1c2godmlzaWJsZVdpZHRoKHdsKSA+IGNvbnRlbnRXaWR0aCA/IHRydW5jYXRlVG9XaWR0aCh3bCwgY29udGVudFdpZHRoLCBcIlwiKSA6IHdsKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIFRydW5jYXRlIGZyb20gdGhlIHRvcCB3aGVuIG1heExpbmVzIGlzIHNldCBzbyB0aGUgbW9zdCByZWNlbnQgY29udGVudFxuXHRcdC8vIHN0YXlzIHZpc2libGUuIFRoaXMgcHJldmVudHMgdGhlIHBpbm5lZCBvdXRwdXQgem9uZSBmcm9tIGV4Y2VlZGluZyB0aGVcblx0XHQvLyB0ZXJtaW5hbCBoZWlnaHQgYW5kIGNhdXNpbmcgcmVuZGVyIGZsYXNoaW5nLlxuXHRcdGlmICh0aGlzLm1heExpbmVzICE9PSB1bmRlZmluZWQgJiYgd3JhcHBlZExpbmVzLmxlbmd0aCA+IHRoaXMubWF4TGluZXMpIHtcblx0XHRcdGNvbnN0IGtlZXAgPSBNYXRoLm1heCgxLCB0aGlzLm1heExpbmVzIC0gMSk7IC8vIFJlc2VydmUgb25lIGxpbmUgZm9yIHRoZSBlbGxpcHNpcyBpbmRpY2F0b3Jcblx0XHRcdGNvbnN0IHRydW5jYXRlZCA9IHdyYXBwZWRMaW5lcy5sZW5ndGggLSBrZWVwO1xuXHRcdFx0d3JhcHBlZExpbmVzLnNwbGljZSgwLCB0cnVuY2F0ZWQsIGBcdTIwMjYgJHt0cnVuY2F0ZWR9IGxpbmUke3RydW5jYXRlZCAhPT0gMSA/IFwic1wiIDogXCJcIn0gYWJvdmVgKTtcblx0XHR9XG5cblx0XHQvLyBBZGQgbWFyZ2lucyBhbmQgYmFja2dyb3VuZCB0byBlYWNoIHdyYXBwZWQgbGluZVxuXHRcdGNvbnN0IGxlZnRNYXJnaW4gPSBcIiBcIi5yZXBlYXQodGhpcy5wYWRkaW5nWCk7XG5cdFx0Y29uc3QgcmlnaHRNYXJnaW4gPSBcIiBcIi5yZXBlYXQodGhpcy5wYWRkaW5nWCk7XG5cdFx0Y29uc3QgYmdGbiA9IHRoaXMuZGVmYXVsdFRleHRTdHlsZT8uYmdDb2xvcjtcblx0XHRjb25zdCBjb250ZW50TGluZXM6IHN0cmluZ1tdID0gW107XG5cblx0XHRmb3IgKGNvbnN0IGxpbmUgb2Ygd3JhcHBlZExpbmVzKSB7XG5cdFx0XHRpZiAoaXNJbWFnZUxpbmUobGluZSkpIHtcblx0XHRcdFx0Y29udGVudExpbmVzLnB1c2gobGluZSk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBsaW5lV2l0aE1hcmdpbnMgPSBsZWZ0TWFyZ2luICsgbGluZSArIHJpZ2h0TWFyZ2luO1xuXG5cdFx0XHRpZiAoYmdGbikge1xuXHRcdFx0XHRjb250ZW50TGluZXMucHVzaChhcHBseUJhY2tncm91bmRUb0xpbmUobGluZVdpdGhNYXJnaW5zLCB3aWR0aCwgYmdGbikpO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Ly8gTm8gYmFja2dyb3VuZCAtIGp1c3QgcGFkIHRvIHdpZHRoXG5cdFx0XHRcdGNvbnN0IHZpc2libGVMZW4gPSB2aXNpYmxlV2lkdGgobGluZVdpdGhNYXJnaW5zKTtcblx0XHRcdFx0Y29uc3QgcGFkZGluZ05lZWRlZCA9IE1hdGgubWF4KDAsIHdpZHRoIC0gdmlzaWJsZUxlbik7XG5cdFx0XHRcdGNvbnRlbnRMaW5lcy5wdXNoKGxpbmVXaXRoTWFyZ2lucyArIFwiIFwiLnJlcGVhdChwYWRkaW5nTmVlZGVkKSk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gQWRkIHRvcC9ib3R0b20gcGFkZGluZyAoZW1wdHkgbGluZXMpXG5cdFx0Y29uc3QgZW1wdHlMaW5lID0gXCIgXCIucmVwZWF0KHdpZHRoKTtcblx0XHRjb25zdCBlbXB0eUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgdGhpcy5wYWRkaW5nWTsgaSsrKSB7XG5cdFx0XHRjb25zdCBsaW5lID0gYmdGbiA/IGFwcGx5QmFja2dyb3VuZFRvTGluZShlbXB0eUxpbmUsIHdpZHRoLCBiZ0ZuKSA6IGVtcHR5TGluZTtcblx0XHRcdGVtcHR5TGluZXMucHVzaChsaW5lKTtcblx0XHR9XG5cblx0XHQvLyBDb21iaW5lIHRvcCBwYWRkaW5nLCBjb250ZW50LCBhbmQgYm90dG9tIHBhZGRpbmdcblx0XHRjb25zdCByZXN1bHQgPSBbLi4uZW1wdHlMaW5lcywgLi4uY29udGVudExpbmVzLCAuLi5lbXB0eUxpbmVzXTtcblxuXHRcdC8vIFVwZGF0ZSBjYWNoZVxuXHRcdHRoaXMuY2FjaGVkVGV4dCA9IHRoaXMudGV4dDtcblx0XHR0aGlzLmNhY2hlZFdpZHRoID0gd2lkdGg7XG5cdFx0dGhpcy5jYWNoZWRNYXhMaW5lcyA9IHRoaXMubWF4TGluZXM7XG5cdFx0dGhpcy5jYWNoZWRMaW5lcyA9IHJlc3VsdDtcblxuXHRcdHJldHVybiByZXN1bHQubGVuZ3RoID4gMCA/IHJlc3VsdCA6IFtcIlwiXTtcblx0fVxuXG5cdC8qKlxuXHQgKiBBcHBseSBkZWZhdWx0IHRleHQgc3R5bGUgdG8gYSBzdHJpbmcuXG5cdCAqIFRoaXMgaXMgdGhlIGJhc2Ugc3R5bGluZyBhcHBsaWVkIHRvIGFsbCB0ZXh0IGNvbnRlbnQuXG5cdCAqIE5PVEU6IEJhY2tncm91bmQgY29sb3IgaXMgTk9UIGFwcGxpZWQgaGVyZSAtIGl0J3MgYXBwbGllZCBhdCB0aGUgcGFkZGluZyBzdGFnZVxuXHQgKiB0byBlbnN1cmUgaXQgZXh0ZW5kcyB0byB0aGUgZnVsbCBsaW5lIHdpZHRoLlxuXHQgKi9cblx0cHJpdmF0ZSBhcHBseURlZmF1bHRTdHlsZSh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdGlmICghdGhpcy5kZWZhdWx0VGV4dFN0eWxlKSB7XG5cdFx0XHRyZXR1cm4gdGV4dDtcblx0XHR9XG5cblx0XHRsZXQgc3R5bGVkID0gdGV4dDtcblxuXHRcdC8vIEFwcGx5IGZvcmVncm91bmQgY29sb3IgKE5PVCBiYWNrZ3JvdW5kIC0gdGhhdCdzIGFwcGxpZWQgYXQgcGFkZGluZyBzdGFnZSlcblx0XHRpZiAodGhpcy5kZWZhdWx0VGV4dFN0eWxlLmNvbG9yKSB7XG5cdFx0XHRzdHlsZWQgPSB0aGlzLmRlZmF1bHRUZXh0U3R5bGUuY29sb3Ioc3R5bGVkKTtcblx0XHR9XG5cblx0XHQvLyBBcHBseSB0ZXh0IGRlY29yYXRpb25zIHVzaW5nIHRoaXMudGhlbWVcblx0XHRpZiAodGhpcy5kZWZhdWx0VGV4dFN0eWxlLmJvbGQpIHtcblx0XHRcdHN0eWxlZCA9IHRoaXMudGhlbWUuYm9sZChzdHlsZWQpO1xuXHRcdH1cblx0XHRpZiAodGhpcy5kZWZhdWx0VGV4dFN0eWxlLml0YWxpYykge1xuXHRcdFx0c3R5bGVkID0gdGhpcy50aGVtZS5pdGFsaWMoc3R5bGVkKTtcblx0XHR9XG5cdFx0aWYgKHRoaXMuZGVmYXVsdFRleHRTdHlsZS5zdHJpa2V0aHJvdWdoKSB7XG5cdFx0XHRzdHlsZWQgPSB0aGlzLnRoZW1lLnN0cmlrZXRocm91Z2goc3R5bGVkKTtcblx0XHR9XG5cdFx0aWYgKHRoaXMuZGVmYXVsdFRleHRTdHlsZS51bmRlcmxpbmUpIHtcblx0XHRcdHN0eWxlZCA9IHRoaXMudGhlbWUudW5kZXJsaW5lKHN0eWxlZCk7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHN0eWxlZDtcblx0fVxuXG5cdHByaXZhdGUgZ2V0RGVmYXVsdFN0eWxlUHJlZml4KCk6IHN0cmluZyB7XG5cdFx0aWYgKCF0aGlzLmRlZmF1bHRUZXh0U3R5bGUpIHtcblx0XHRcdHJldHVybiBcIlwiO1xuXHRcdH1cblxuXHRcdGlmICh0aGlzLmRlZmF1bHRTdHlsZVByZWZpeCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRyZXR1cm4gdGhpcy5kZWZhdWx0U3R5bGVQcmVmaXg7XG5cdFx0fVxuXG5cdFx0Y29uc3Qgc2VudGluZWwgPSBcIlxcdTAwMDBcIjtcblx0XHRsZXQgc3R5bGVkID0gc2VudGluZWw7XG5cblx0XHRpZiAodGhpcy5kZWZhdWx0VGV4dFN0eWxlLmNvbG9yKSB7XG5cdFx0XHRzdHlsZWQgPSB0aGlzLmRlZmF1bHRUZXh0U3R5bGUuY29sb3Ioc3R5bGVkKTtcblx0XHR9XG5cblx0XHRpZiAodGhpcy5kZWZhdWx0VGV4dFN0eWxlLmJvbGQpIHtcblx0XHRcdHN0eWxlZCA9IHRoaXMudGhlbWUuYm9sZChzdHlsZWQpO1xuXHRcdH1cblx0XHRpZiAodGhpcy5kZWZhdWx0VGV4dFN0eWxlLml0YWxpYykge1xuXHRcdFx0c3R5bGVkID0gdGhpcy50aGVtZS5pdGFsaWMoc3R5bGVkKTtcblx0XHR9XG5cdFx0aWYgKHRoaXMuZGVmYXVsdFRleHRTdHlsZS5zdHJpa2V0aHJvdWdoKSB7XG5cdFx0XHRzdHlsZWQgPSB0aGlzLnRoZW1lLnN0cmlrZXRocm91Z2goc3R5bGVkKTtcblx0XHR9XG5cdFx0aWYgKHRoaXMuZGVmYXVsdFRleHRTdHlsZS51bmRlcmxpbmUpIHtcblx0XHRcdHN0eWxlZCA9IHRoaXMudGhlbWUudW5kZXJsaW5lKHN0eWxlZCk7XG5cdFx0fVxuXG5cdFx0Y29uc3Qgc2VudGluZWxJbmRleCA9IHN0eWxlZC5pbmRleE9mKHNlbnRpbmVsKTtcblx0XHR0aGlzLmRlZmF1bHRTdHlsZVByZWZpeCA9IHNlbnRpbmVsSW5kZXggPj0gMCA/IHN0eWxlZC5zbGljZSgwLCBzZW50aW5lbEluZGV4KSA6IFwiXCI7XG5cdFx0cmV0dXJuIHRoaXMuZGVmYXVsdFN0eWxlUHJlZml4O1xuXHR9XG5cblx0cHJpdmF0ZSBnZXRTdHlsZVByZWZpeChzdHlsZUZuOiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdGNvbnN0IHNlbnRpbmVsID0gXCJcXHUwMDAwXCI7XG5cdFx0Y29uc3Qgc3R5bGVkID0gc3R5bGVGbihzZW50aW5lbCk7XG5cdFx0Y29uc3Qgc2VudGluZWxJbmRleCA9IHN0eWxlZC5pbmRleE9mKHNlbnRpbmVsKTtcblx0XHRyZXR1cm4gc2VudGluZWxJbmRleCA+PSAwID8gc3R5bGVkLnNsaWNlKDAsIHNlbnRpbmVsSW5kZXgpIDogXCJcIjtcblx0fVxuXG5cdHByaXZhdGUgZ2V0RGVmYXVsdElubGluZVN0eWxlQ29udGV4dCgpOiBJbmxpbmVTdHlsZUNvbnRleHQge1xuXHRcdHJldHVybiB7XG5cdFx0XHRhcHBseVRleHQ6ICh0ZXh0OiBzdHJpbmcpID0+IHRoaXMuYXBwbHlEZWZhdWx0U3R5bGUodGV4dCksXG5cdFx0XHRzdHlsZVByZWZpeDogdGhpcy5nZXREZWZhdWx0U3R5bGVQcmVmaXgoKSxcblx0XHR9O1xuXHR9XG5cblx0cHJpdmF0ZSByZW5kZXJUb2tlbihcblx0XHR0b2tlbjogVG9rZW4sXG5cdFx0d2lkdGg6IG51bWJlcixcblx0XHRuZXh0VG9rZW5UeXBlPzogc3RyaW5nLFxuXHRcdHN0eWxlQ29udGV4dD86IElubGluZVN0eWxlQ29udGV4dCxcblx0KTogc3RyaW5nW10ge1xuXHRcdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdFx0c3dpdGNoICh0b2tlbi50eXBlKSB7XG5cdFx0XHRjYXNlIFwiaGVhZGluZ1wiOiB7XG5cdFx0XHRcdGNvbnN0IGhlYWRpbmdMZXZlbCA9IHRva2VuLmRlcHRoO1xuXHRcdFx0XHRjb25zdCBoZWFkaW5nUHJlZml4ID0gYCR7XCIjXCIucmVwZWF0KGhlYWRpbmdMZXZlbCl9IGA7XG5cdFx0XHRcdGNvbnN0IGhlYWRpbmdUZXh0ID0gdGhpcy5yZW5kZXJJbmxpbmVUb2tlbnModG9rZW4udG9rZW5zIHx8IFtdLCBzdHlsZUNvbnRleHQpO1xuXHRcdFx0XHRsZXQgc3R5bGVkSGVhZGluZzogc3RyaW5nO1xuXHRcdFx0XHRpZiAoaGVhZGluZ0xldmVsID09PSAxKSB7XG5cdFx0XHRcdFx0c3R5bGVkSGVhZGluZyA9IHRoaXMudGhlbWUuaGVhZGluZyh0aGlzLnRoZW1lLmJvbGQodGhpcy50aGVtZS51bmRlcmxpbmUoaGVhZGluZ1RleHQpKSk7XG5cdFx0XHRcdH0gZWxzZSBpZiAoaGVhZGluZ0xldmVsID09PSAyKSB7XG5cdFx0XHRcdFx0c3R5bGVkSGVhZGluZyA9IHRoaXMudGhlbWUuaGVhZGluZyh0aGlzLnRoZW1lLmJvbGQoaGVhZGluZ1RleHQpKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRzdHlsZWRIZWFkaW5nID0gdGhpcy50aGVtZS5oZWFkaW5nKHRoaXMudGhlbWUuYm9sZChoZWFkaW5nUHJlZml4ICsgaGVhZGluZ1RleHQpKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRsaW5lcy5wdXNoKHN0eWxlZEhlYWRpbmcpO1xuXHRcdFx0XHRpZiAobmV4dFRva2VuVHlwZSAhPT0gXCJzcGFjZVwiKSB7XG5cdFx0XHRcdFx0bGluZXMucHVzaChcIlwiKTsgLy8gQWRkIHNwYWNpbmcgYWZ0ZXIgaGVhZGluZ3MgKHVubGVzcyBzcGFjZSB0b2tlbiBmb2xsb3dzKVxuXHRcdFx0XHR9XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwicGFyYWdyYXBoXCI6IHtcblx0XHRcdFx0Y29uc3QgcGFyYWdyYXBoVGV4dCA9IHRoaXMucmVuZGVySW5saW5lVG9rZW5zKHRva2VuLnRva2VucyB8fCBbXSwgc3R5bGVDb250ZXh0KTtcblx0XHRcdFx0bGluZXMucHVzaChwYXJhZ3JhcGhUZXh0KTtcblx0XHRcdFx0Ly8gRG9uJ3QgYWRkIHNwYWNpbmcgaWYgbmV4dCB0b2tlbiBpcyBzcGFjZSBvciBsaXN0XG5cdFx0XHRcdGlmIChuZXh0VG9rZW5UeXBlICYmIG5leHRUb2tlblR5cGUgIT09IFwibGlzdFwiICYmIG5leHRUb2tlblR5cGUgIT09IFwic3BhY2VcIikge1xuXHRcdFx0XHRcdGxpbmVzLnB1c2goXCJcIik7XG5cdFx0XHRcdH1cblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cblx0XHRcdGNhc2UgXCJjb2RlXCI6IHtcblx0XHRcdFx0Y29uc3QgY29kZUJsb2NrTGluZXMgPSB0aGlzLnJlbmRlckNvZGVCbG9jayh0b2tlbi50ZXh0LCB0b2tlbi5sYW5nKTtcblx0XHRcdFx0Zm9yIChsZXQgaiA9IDA7IGogPCBjb2RlQmxvY2tMaW5lcy5sZW5ndGg7IGorKykgbGluZXMucHVzaChjb2RlQmxvY2tMaW5lc1tqXSk7XG5cdFx0XHRcdGlmIChuZXh0VG9rZW5UeXBlICE9PSBcInNwYWNlXCIpIHtcblx0XHRcdFx0XHRsaW5lcy5wdXNoKFwiXCIpOyAvLyBBZGQgc3BhY2luZyBhZnRlciBjb2RlIGJsb2NrcyAodW5sZXNzIHNwYWNlIHRva2VuIGZvbGxvd3MpXG5cdFx0XHRcdH1cblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cblx0XHRcdGNhc2UgXCJsaXN0XCI6IHtcblx0XHRcdFx0Y29uc3QgbGlzdExpbmVzID0gdGhpcy5yZW5kZXJMaXN0KHRva2VuIGFzIGFueSwgMCwgc3R5bGVDb250ZXh0KTtcblx0XHRcdFx0Zm9yIChsZXQgaiA9IDA7IGogPCBsaXN0TGluZXMubGVuZ3RoOyBqKyspIGxpbmVzLnB1c2gobGlzdExpbmVzW2pdKTtcblx0XHRcdFx0Ly8gRG9uJ3QgYWRkIHNwYWNpbmcgYWZ0ZXIgbGlzdHMgaWYgYSBzcGFjZSB0b2tlbiBmb2xsb3dzXG5cdFx0XHRcdC8vICh0aGUgc3BhY2UgdG9rZW4gd2lsbCBoYW5kbGUgaXQpXG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwidGFibGVcIjoge1xuXHRcdFx0XHRjb25zdCB0YWJsZUxpbmVzID0gdGhpcy5yZW5kZXJUYWJsZSh0b2tlbiBhcyBhbnksIHdpZHRoLCBzdHlsZUNvbnRleHQpO1xuXHRcdFx0XHRmb3IgKGxldCBqID0gMDsgaiA8IHRhYmxlTGluZXMubGVuZ3RoOyBqKyspIGxpbmVzLnB1c2godGFibGVMaW5lc1tqXSk7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwiYmxvY2txdW90ZVwiOiB7XG5cdFx0XHRcdGNvbnN0IHF1b3RlU3R5bGUgPSAodGV4dDogc3RyaW5nKSA9PiB0aGlzLnRoZW1lLnF1b3RlKHRoaXMudGhlbWUuaXRhbGljKHRleHQpKTtcblx0XHRcdFx0Y29uc3QgcXVvdGVTdHlsZVByZWZpeCA9IHRoaXMuZ2V0U3R5bGVQcmVmaXgocXVvdGVTdHlsZSk7XG5cdFx0XHRcdGNvbnN0IGFwcGx5UXVvdGVTdHlsZSA9IChsaW5lOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuXHRcdFx0XHRcdGlmICghcXVvdGVTdHlsZVByZWZpeCkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHF1b3RlU3R5bGUobGluZSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGNvbnN0IGxpbmVXaXRoUmVhcHBsaWVkU3R5bGUgPSBsaW5lLnJlcGxhY2UoL1xceDFiXFxbMG0vZywgYFxceDFiWzBtJHtxdW90ZVN0eWxlUHJlZml4fWApO1xuXHRcdFx0XHRcdHJldHVybiBxdW90ZVN0eWxlKGxpbmVXaXRoUmVhcHBsaWVkU3R5bGUpO1xuXHRcdFx0XHR9O1xuXG5cdFx0XHRcdC8vIENhbGN1bGF0ZSBhdmFpbGFibGUgd2lkdGggZm9yIHF1b3RlIGNvbnRlbnQgKHN1YnRyYWN0IGJvcmRlciBcIlx1MjUwMiBcIiA9IDIgY2hhcnMpXG5cdFx0XHRcdGNvbnN0IHF1b3RlQ29udGVudFdpZHRoID0gTWF0aC5tYXgoMSwgd2lkdGggLSAyKTtcblxuXHRcdFx0XHQvLyBCbG9ja3F1b3RlcyBjb250YWluIGJsb2NrLWxldmVsIHRva2VucyAocGFyYWdyYXBoLCBsaXN0LCBjb2RlLCBldGMuKSwgc28gcmVuZGVyXG5cdFx0XHRcdC8vIGNoaWxkcmVuIHdpdGggcmVuZGVyVG9rZW4oKSBpbnN0ZWFkIG9mIHJlbmRlcklubGluZVRva2VucygpLlxuXHRcdFx0XHQvLyBEZWZhdWx0IG1lc3NhZ2Ugc3R5bGUgc2hvdWxkIG5vdCBhcHBseSBpbnNpZGUgYmxvY2txdW90ZXMuXG5cdFx0XHRcdGNvbnN0IHF1b3RlSW5saW5lU3R5bGVDb250ZXh0OiBJbmxpbmVTdHlsZUNvbnRleHQgPSB7XG5cdFx0XHRcdFx0YXBwbHlUZXh0OiAodGV4dDogc3RyaW5nKSA9PiB0ZXh0LFxuXHRcdFx0XHRcdHN0eWxlUHJlZml4OiBcIlwiLFxuXHRcdFx0XHR9O1xuXHRcdFx0XHRjb25zdCBxdW90ZVRva2VucyA9IHRva2VuLnRva2VucyB8fCBbXTtcblx0XHRcdFx0Y29uc3QgcmVuZGVyZWRRdW90ZUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdFx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHF1b3RlVG9rZW5zLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRcdFx0Y29uc3QgcXVvdGVUb2tlbiA9IHF1b3RlVG9rZW5zW2ldO1xuXHRcdFx0XHRcdGNvbnN0IG5leHRRdW90ZVRva2VuID0gcXVvdGVUb2tlbnNbaSArIDFdO1xuXHRcdFx0XHRcdHJlbmRlcmVkUXVvdGVMaW5lcy5wdXNoKFxuXHRcdFx0XHRcdFx0Li4udGhpcy5yZW5kZXJUb2tlbihxdW90ZVRva2VuLCBxdW90ZUNvbnRlbnRXaWR0aCwgbmV4dFF1b3RlVG9rZW4/LnR5cGUsIHF1b3RlSW5saW5lU3R5bGVDb250ZXh0KSxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gQXZvaWQgcmVuZGVyaW5nIGFuIGV4dHJhIGVtcHR5IHF1b3RlIGxpbmUgYmVmb3JlIHRoZSBvdXRlciBibG9ja3F1b3RlIHNwYWNpbmcuXG5cdFx0XHRcdHdoaWxlIChyZW5kZXJlZFF1b3RlTGluZXMubGVuZ3RoID4gMCAmJiByZW5kZXJlZFF1b3RlTGluZXNbcmVuZGVyZWRRdW90ZUxpbmVzLmxlbmd0aCAtIDFdID09PSBcIlwiKSB7XG5cdFx0XHRcdFx0cmVuZGVyZWRRdW90ZUxpbmVzLnBvcCgpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Zm9yIChjb25zdCBxdW90ZUxpbmUgb2YgcmVuZGVyZWRRdW90ZUxpbmVzKSB7XG5cdFx0XHRcdFx0Y29uc3Qgc3R5bGVkTGluZSA9IGFwcGx5UXVvdGVTdHlsZShxdW90ZUxpbmUpO1xuXHRcdFx0XHRcdGNvbnN0IHdyYXBwZWRMaW5lcyA9IHdyYXBUZXh0V2l0aEFuc2koc3R5bGVkTGluZSwgcXVvdGVDb250ZW50V2lkdGgpO1xuXHRcdFx0XHRcdGZvciAoY29uc3Qgd3JhcHBlZExpbmUgb2Ygd3JhcHBlZExpbmVzKSB7XG5cdFx0XHRcdFx0XHRsaW5lcy5wdXNoKHRoaXMudGhlbWUucXVvdGVCb3JkZXIoXCJcdTI1MDIgXCIpICsgd3JhcHBlZExpbmUpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAobmV4dFRva2VuVHlwZSAhPT0gXCJzcGFjZVwiKSB7XG5cdFx0XHRcdFx0bGluZXMucHVzaChcIlwiKTsgLy8gQWRkIHNwYWNpbmcgYWZ0ZXIgYmxvY2txdW90ZXMgKHVubGVzcyBzcGFjZSB0b2tlbiBmb2xsb3dzKVxuXHRcdFx0XHR9XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwiaHJcIjpcblx0XHRcdFx0bGluZXMucHVzaCh0aGlzLnRoZW1lLmhyKFwiXHUyNTAwXCIucmVwZWF0KE1hdGgubWluKHdpZHRoLCA4MCkpKSk7XG5cdFx0XHRcdGlmIChuZXh0VG9rZW5UeXBlICE9PSBcInNwYWNlXCIpIHtcblx0XHRcdFx0XHRsaW5lcy5wdXNoKFwiXCIpOyAvLyBBZGQgc3BhY2luZyBhZnRlciBob3Jpem9udGFsIHJ1bGVzICh1bmxlc3Mgc3BhY2UgdG9rZW4gZm9sbG93cylcblx0XHRcdFx0fVxuXHRcdFx0XHRicmVhaztcblxuXHRcdFx0Y2FzZSBcImh0bWxcIjpcblx0XHRcdFx0Ly8gUmVuZGVyIEhUTUwgYXMgcGxhaW4gdGV4dCAoZXNjYXBlZCBmb3IgdGVybWluYWwpXG5cdFx0XHRcdGlmIChcInJhd1wiIGluIHRva2VuICYmIHR5cGVvZiB0b2tlbi5yYXcgPT09IFwic3RyaW5nXCIpIHtcblx0XHRcdFx0XHRsaW5lcy5wdXNoKHRoaXMuYXBwbHlEZWZhdWx0U3R5bGUodG9rZW4ucmF3LnRyaW0oKSkpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGJyZWFrO1xuXG5cdFx0XHRjYXNlIFwic3BhY2VcIjpcblx0XHRcdFx0Ly8gU3BhY2UgdG9rZW5zIHJlcHJlc2VudCBibGFuayBsaW5lcyBpbiBtYXJrZG93blxuXHRcdFx0XHRsaW5lcy5wdXNoKFwiXCIpO1xuXHRcdFx0XHRicmVhaztcblxuXHRcdFx0ZGVmYXVsdDpcblx0XHRcdFx0Ly8gSGFuZGxlIGFueSBvdGhlciB0b2tlbiB0eXBlcyBhcyBwbGFpbiB0ZXh0XG5cdFx0XHRcdGlmIChcInRleHRcIiBpbiB0b2tlbiAmJiB0eXBlb2YgdG9rZW4udGV4dCA9PT0gXCJzdHJpbmdcIikge1xuXHRcdFx0XHRcdGxpbmVzLnB1c2godG9rZW4udGV4dCk7XG5cdFx0XHRcdH1cblx0XHR9XG5cblx0XHRyZXR1cm4gbGluZXM7XG5cdH1cblxuXHRwcml2YXRlIHJlbmRlcklubGluZVRva2Vucyh0b2tlbnM6IFRva2VuW10sIHN0eWxlQ29udGV4dD86IElubGluZVN0eWxlQ29udGV4dCk6IHN0cmluZyB7XG5cdFx0bGV0IHJlc3VsdCA9IFwiXCI7XG5cdFx0Y29uc3QgcmVzb2x2ZWRTdHlsZUNvbnRleHQgPSBzdHlsZUNvbnRleHQgPz8gdGhpcy5nZXREZWZhdWx0SW5saW5lU3R5bGVDb250ZXh0KCk7XG5cdFx0Y29uc3QgeyBhcHBseVRleHQsIHN0eWxlUHJlZml4IH0gPSByZXNvbHZlZFN0eWxlQ29udGV4dDtcblx0XHRjb25zdCBhcHBseVRleHRXaXRoTmV3bGluZXMgPSAodGV4dDogc3RyaW5nKTogc3RyaW5nID0+IHtcblx0XHRcdGNvbnN0IHNlZ21lbnRzOiBzdHJpbmdbXSA9IHRleHQuc3BsaXQoXCJcXG5cIik7XG5cdFx0XHRyZXR1cm4gc2VnbWVudHMubWFwKChzZWdtZW50OiBzdHJpbmcpID0+IGFwcGx5VGV4dChzZWdtZW50KSkuam9pbihcIlxcblwiKTtcblx0XHR9O1xuXG5cdFx0Zm9yIChjb25zdCB0b2tlbiBvZiB0b2tlbnMpIHtcblx0XHRcdHN3aXRjaCAodG9rZW4udHlwZSkge1xuXHRcdFx0XHRjYXNlIFwidGV4dFwiOlxuXHRcdFx0XHRcdC8vIFRleHQgdG9rZW5zIGluIGxpc3QgaXRlbXMgY2FuIGhhdmUgbmVzdGVkIHRva2VucyBmb3IgaW5saW5lIGZvcm1hdHRpbmdcblx0XHRcdFx0XHRpZiAodG9rZW4udG9rZW5zICYmIHRva2VuLnRva2Vucy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0XHRyZXN1bHQgKz0gdGhpcy5yZW5kZXJJbmxpbmVUb2tlbnModG9rZW4udG9rZW5zLCByZXNvbHZlZFN0eWxlQ29udGV4dCk7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdHJlc3VsdCArPSBhcHBseVRleHRXaXRoTmV3bGluZXModG9rZW4udGV4dCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGJyZWFrO1xuXG5cdFx0XHRcdGNhc2UgXCJwYXJhZ3JhcGhcIjpcblx0XHRcdFx0XHQvLyBQYXJhZ3JhcGggdG9rZW5zIGNvbnRhaW4gbmVzdGVkIGlubGluZSB0b2tlbnNcblx0XHRcdFx0XHRyZXN1bHQgKz0gdGhpcy5yZW5kZXJJbmxpbmVUb2tlbnModG9rZW4udG9rZW5zIHx8IFtdLCByZXNvbHZlZFN0eWxlQ29udGV4dCk7XG5cdFx0XHRcdFx0YnJlYWs7XG5cblx0XHRcdFx0Y2FzZSBcInN0cm9uZ1wiOiB7XG5cdFx0XHRcdFx0Y29uc3QgYm9sZENvbnRlbnQgPSB0aGlzLnJlbmRlcklubGluZVRva2Vucyh0b2tlbi50b2tlbnMgfHwgW10sIHJlc29sdmVkU3R5bGVDb250ZXh0KTtcblx0XHRcdFx0XHRyZXN1bHQgKz0gdGhpcy50aGVtZS5ib2xkKGJvbGRDb250ZW50KSArIHN0eWxlUHJlZml4O1xuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y2FzZSBcImVtXCI6IHtcblx0XHRcdFx0XHRjb25zdCBpdGFsaWNDb250ZW50ID0gdGhpcy5yZW5kZXJJbmxpbmVUb2tlbnModG9rZW4udG9rZW5zIHx8IFtdLCByZXNvbHZlZFN0eWxlQ29udGV4dCk7XG5cdFx0XHRcdFx0cmVzdWx0ICs9IHRoaXMudGhlbWUuaXRhbGljKGl0YWxpY0NvbnRlbnQpICsgc3R5bGVQcmVmaXg7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjYXNlIFwiY29kZXNwYW5cIjpcblx0XHRcdFx0XHRyZXN1bHQgKz0gdGhpcy50aGVtZS5jb2RlKHRva2VuLnRleHQpICsgc3R5bGVQcmVmaXg7XG5cdFx0XHRcdFx0YnJlYWs7XG5cblx0XHRcdFx0Y2FzZSBcImxpbmtcIjoge1xuXHRcdFx0XHRcdGNvbnN0IGxpbmtUZXh0ID0gdGhpcy5yZW5kZXJJbmxpbmVUb2tlbnModG9rZW4udG9rZW5zIHx8IFtdLCByZXNvbHZlZFN0eWxlQ29udGV4dCk7XG5cdFx0XHRcdFx0Ly8gSWYgbGluayB0ZXh0IG1hdGNoZXMgaHJlZiwgb25seSBzaG93IHRoZSBsaW5rIG9uY2Vcblx0XHRcdFx0XHQvLyBDb21wYXJlIHJhdyB0ZXh0ICh0b2tlbi50ZXh0KSBub3Qgc3R5bGVkIHRleHQgKGxpbmtUZXh0KSBzaW5jZSBsaW5rVGV4dCBoYXMgQU5TSSBjb2Rlc1xuXHRcdFx0XHRcdC8vIEZvciBtYWlsdG86IGxpbmtzLCBzdHJpcCB0aGUgcHJlZml4IGJlZm9yZSBjb21wYXJpbmcgKGF1dG9saW5rZWQgZW1haWxzIGhhdmVcblx0XHRcdFx0XHQvLyB0ZXh0PVwiZm9vQGJhci5jb21cIiBidXQgaHJlZj1cIm1haWx0bzpmb29AYmFyLmNvbVwiKVxuXHRcdFx0XHRcdGNvbnN0IGhyZWZGb3JDb21wYXJpc29uID0gdG9rZW4uaHJlZi5zdGFydHNXaXRoKFwibWFpbHRvOlwiKSA/IHRva2VuLmhyZWYuc2xpY2UoNykgOiB0b2tlbi5ocmVmO1xuXHRcdFx0XHRcdGlmICh0b2tlbi50ZXh0ID09PSB0b2tlbi5ocmVmIHx8IHRva2VuLnRleHQgPT09IGhyZWZGb3JDb21wYXJpc29uKSB7XG5cdFx0XHRcdFx0XHRyZXN1bHQgKz0gdGhpcy50aGVtZS5saW5rKHRoaXMudGhlbWUudW5kZXJsaW5lKGxpbmtUZXh0KSkgKyBzdHlsZVByZWZpeDtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0cmVzdWx0ICs9XG5cdFx0XHRcdFx0XHRcdHRoaXMudGhlbWUubGluayh0aGlzLnRoZW1lLnVuZGVybGluZShsaW5rVGV4dCkpICtcblx0XHRcdFx0XHRcdFx0dGhpcy50aGVtZS5saW5rVXJsKGAgKCR7dG9rZW4uaHJlZn0pYCkgK1xuXHRcdFx0XHRcdFx0XHRzdHlsZVByZWZpeDtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjYXNlIFwiYnJcIjpcblx0XHRcdFx0XHRyZXN1bHQgKz0gXCJcXG5cIjtcblx0XHRcdFx0XHRicmVhaztcblxuXHRcdFx0XHRjYXNlIFwiZGVsXCI6IHtcblx0XHRcdFx0XHRjb25zdCBkZWxDb250ZW50ID0gdGhpcy5yZW5kZXJJbmxpbmVUb2tlbnModG9rZW4udG9rZW5zIHx8IFtdLCByZXNvbHZlZFN0eWxlQ29udGV4dCk7XG5cdFx0XHRcdFx0cmVzdWx0ICs9IHRoaXMudGhlbWUuc3RyaWtldGhyb3VnaChkZWxDb250ZW50KSArIHN0eWxlUHJlZml4O1xuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y2FzZSBcImh0bWxcIjpcblx0XHRcdFx0XHQvLyBSZW5kZXIgaW5saW5lIEhUTUwgYXMgcGxhaW4gdGV4dFxuXHRcdFx0XHRcdGlmIChcInJhd1wiIGluIHRva2VuICYmIHR5cGVvZiB0b2tlbi5yYXcgPT09IFwic3RyaW5nXCIpIHtcblx0XHRcdFx0XHRcdHJlc3VsdCArPSBhcHBseVRleHRXaXRoTmV3bGluZXModG9rZW4ucmF3KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0YnJlYWs7XG5cblx0XHRcdFx0ZGVmYXVsdDpcblx0XHRcdFx0XHQvLyBIYW5kbGUgYW55IG90aGVyIGlubGluZSB0b2tlbiB0eXBlcyBhcyBwbGFpbiB0ZXh0XG5cdFx0XHRcdFx0aWYgKFwidGV4dFwiIGluIHRva2VuICYmIHR5cGVvZiB0b2tlbi50ZXh0ID09PSBcInN0cmluZ1wiKSB7XG5cdFx0XHRcdFx0XHRyZXN1bHQgKz0gYXBwbHlUZXh0V2l0aE5ld2xpbmVzKHRva2VuLnRleHQpO1xuXHRcdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHRyZXR1cm4gcmVzdWx0O1xuXHR9XG5cblx0LyoqXG5cdCAqIFJlbmRlciBhIGxpc3Qgd2l0aCBwcm9wZXIgbmVzdGluZyBzdXBwb3J0XG5cdCAqL1xuXHRwcml2YXRlIHJlbmRlckxpc3QoXG5cdFx0dG9rZW46IFRva2VuICYgeyBpdGVtczogYW55W107IG9yZGVyZWQ6IGJvb2xlYW47IHN0YXJ0PzogbnVtYmVyIH0sXG5cdFx0ZGVwdGg6IG51bWJlcixcblx0XHRzdHlsZUNvbnRleHQ/OiBJbmxpbmVTdHlsZUNvbnRleHQsXG5cdCk6IHN0cmluZ1tdIHtcblx0XHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblx0XHRjb25zdCBpbmRlbnQgPSBcIiAgXCIucmVwZWF0KGRlcHRoKTtcblx0XHQvLyBVc2UgdGhlIGxpc3QncyBzdGFydCBwcm9wZXJ0eSAoZGVmYXVsdHMgdG8gMSBmb3Igb3JkZXJlZCBsaXN0cylcblx0XHRjb25zdCBzdGFydE51bWJlciA9IHRva2VuLnN0YXJ0ID8/IDE7XG5cblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHRva2VuLml0ZW1zLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRjb25zdCBpdGVtID0gdG9rZW4uaXRlbXNbaV07XG5cdFx0XHRjb25zdCBidWxsZXQgPSB0b2tlbi5vcmRlcmVkID8gYCR7c3RhcnROdW1iZXIgKyBpfS4gYCA6IFwiLSBcIjtcblxuXHRcdFx0Ly8gUHJvY2VzcyBpdGVtIHRva2VucyB0byBoYW5kbGUgbmVzdGVkIGxpc3RzXG5cdFx0XHRjb25zdCBpdGVtTGluZXMgPSB0aGlzLnJlbmRlckxpc3RJdGVtKGl0ZW0udG9rZW5zIHx8IFtdLCBkZXB0aCwgc3R5bGVDb250ZXh0KTtcblxuXHRcdFx0aWYgKGl0ZW1MaW5lcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdC8vIEZpcnN0IGxpbmUgLSBjaGVjayBpZiBpdCdzIGEgbmVzdGVkIGxpc3Rcblx0XHRcdFx0Ly8gQSBuZXN0ZWQgbGlzdCB3aWxsIHN0YXJ0IHdpdGggaW5kZW50IChzcGFjZXMpIGZvbGxvd2VkIGJ5IGN5YW4gYnVsbGV0XG5cdFx0XHRcdGNvbnN0IGZpcnN0TGluZSA9IGl0ZW1MaW5lc1swXTtcblx0XHRcdFx0Y29uc3QgaXNOZXN0ZWRMaXN0ID0gL15cXHMrXFx4MWJcXFszNm1bLVxcZF0vLnRlc3QoZmlyc3RMaW5lKTsgLy8gc3RhcnRzIHdpdGggc3BhY2VzICsgY3lhbiArIGJ1bGxldCBjaGFyXG5cblx0XHRcdFx0aWYgKGlzTmVzdGVkTGlzdCkge1xuXHRcdFx0XHRcdC8vIFRoaXMgaXMgYSBuZXN0ZWQgbGlzdCwganVzdCBhZGQgaXQgYXMtaXMgKGFscmVhZHkgaGFzIGZ1bGwgaW5kZW50KVxuXHRcdFx0XHRcdGxpbmVzLnB1c2goZmlyc3RMaW5lKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHQvLyBSZWd1bGFyIHRleHQgY29udGVudCAtIGFkZCBpbmRlbnQgYW5kIGJ1bGxldFxuXHRcdFx0XHRcdGxpbmVzLnB1c2goaW5kZW50ICsgdGhpcy50aGVtZS5saXN0QnVsbGV0KGJ1bGxldCkgKyBmaXJzdExpbmUpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gUmVzdCBvZiB0aGUgbGluZXNcblx0XHRcdFx0Zm9yIChsZXQgaiA9IDE7IGogPCBpdGVtTGluZXMubGVuZ3RoOyBqKyspIHtcblx0XHRcdFx0XHRjb25zdCBsaW5lID0gaXRlbUxpbmVzW2pdO1xuXHRcdFx0XHRcdGNvbnN0IGlzTmVzdGVkTGlzdExpbmUgPSAvXlxccytcXHgxYlxcWzM2bVstXFxkXS8udGVzdChsaW5lKTsgLy8gc3RhcnRzIHdpdGggc3BhY2VzICsgY3lhbiArIGJ1bGxldCBjaGFyXG5cblx0XHRcdFx0XHRpZiAoaXNOZXN0ZWRMaXN0TGluZSkge1xuXHRcdFx0XHRcdFx0Ly8gTmVzdGVkIGxpc3QgbGluZSAtIGFscmVhZHkgaGFzIGZ1bGwgaW5kZW50XG5cdFx0XHRcdFx0XHRsaW5lcy5wdXNoKGxpbmUpO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHQvLyBSZWd1bGFyIGNvbnRlbnQgLSBhZGQgcGFyZW50IGluZGVudCArIDIgc3BhY2VzIGZvciBjb250aW51YXRpb25cblx0XHRcdFx0XHRcdGxpbmVzLnB1c2goYCR7aW5kZW50fSAgJHtsaW5lfWApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0bGluZXMucHVzaChpbmRlbnQgKyB0aGlzLnRoZW1lLmxpc3RCdWxsZXQoYnVsbGV0KSk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0cmV0dXJuIGxpbmVzO1xuXHR9XG5cblx0LyoqXG5cdCAqIFJlbmRlciBsaXN0IGl0ZW0gdG9rZW5zLCBoYW5kbGluZyBuZXN0ZWQgbGlzdHNcblx0ICogUmV0dXJucyBsaW5lcyBXSVRIT1VUIHRoZSBwYXJlbnQgaW5kZW50IChyZW5kZXJMaXN0IHdpbGwgYWRkIGl0KVxuXHQgKi9cblx0cHJpdmF0ZSByZW5kZXJMaXN0SXRlbSh0b2tlbnM6IFRva2VuW10sIHBhcmVudERlcHRoOiBudW1iZXIsIHN0eWxlQ29udGV4dD86IElubGluZVN0eWxlQ29udGV4dCk6IHN0cmluZ1tdIHtcblx0XHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblxuXHRcdGZvciAoY29uc3QgdG9rZW4gb2YgdG9rZW5zKSB7XG5cdFx0XHRpZiAodG9rZW4udHlwZSA9PT0gXCJsaXN0XCIpIHtcblx0XHRcdFx0Ly8gTmVzdGVkIGxpc3QgLSByZW5kZXIgd2l0aCBvbmUgYWRkaXRpb25hbCBpbmRlbnQgbGV2ZWxcblx0XHRcdFx0Ly8gVGhlc2UgbGluZXMgd2lsbCBoYXZlIHRoZWlyIG93biBpbmRlbnQsIHNvIHdlIGp1c3QgYWRkIHRoZW0gYXMtaXNcblx0XHRcdFx0Y29uc3QgbmVzdGVkTGluZXMgPSB0aGlzLnJlbmRlckxpc3QodG9rZW4gYXMgYW55LCBwYXJlbnREZXB0aCArIDEsIHN0eWxlQ29udGV4dCk7XG5cdFx0XHRcdGZvciAobGV0IGogPSAwOyBqIDwgbmVzdGVkTGluZXMubGVuZ3RoOyBqKyspIGxpbmVzLnB1c2gobmVzdGVkTGluZXNbal0pO1xuXHRcdFx0fSBlbHNlIGlmICh0b2tlbi50eXBlID09PSBcInRleHRcIikge1xuXHRcdFx0XHQvLyBUZXh0IGNvbnRlbnQgKG1heSBoYXZlIGlubGluZSB0b2tlbnMpXG5cdFx0XHRcdGNvbnN0IHRleHQgPVxuXHRcdFx0XHRcdHRva2VuLnRva2VucyAmJiB0b2tlbi50b2tlbnMubGVuZ3RoID4gMFxuXHRcdFx0XHRcdFx0PyB0aGlzLnJlbmRlcklubGluZVRva2Vucyh0b2tlbi50b2tlbnMsIHN0eWxlQ29udGV4dClcblx0XHRcdFx0XHRcdDogdG9rZW4udGV4dCB8fCBcIlwiO1xuXHRcdFx0XHRsaW5lcy5wdXNoKHRleHQpO1xuXHRcdFx0fSBlbHNlIGlmICh0b2tlbi50eXBlID09PSBcInBhcmFncmFwaFwiKSB7XG5cdFx0XHRcdC8vIFBhcmFncmFwaCBpbiBsaXN0IGl0ZW1cblx0XHRcdFx0Y29uc3QgdGV4dCA9IHRoaXMucmVuZGVySW5saW5lVG9rZW5zKHRva2VuLnRva2VucyB8fCBbXSwgc3R5bGVDb250ZXh0KTtcblx0XHRcdFx0bGluZXMucHVzaCh0ZXh0KTtcblx0XHRcdH0gZWxzZSBpZiAodG9rZW4udHlwZSA9PT0gXCJjb2RlXCIpIHtcblx0XHRcdFx0Ly8gQ29kZSBibG9jayBpbiBsaXN0IGl0ZW1cblx0XHRcdFx0Y29uc3QgY29kZUxpbmVzID0gdGhpcy5yZW5kZXJDb2RlQmxvY2sodG9rZW4udGV4dCwgdG9rZW4ubGFuZyk7XG5cdFx0XHRcdGZvciAobGV0IGogPSAwOyBqIDwgY29kZUxpbmVzLmxlbmd0aDsgaisrKSBsaW5lcy5wdXNoKGNvZGVMaW5lc1tqXSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHQvLyBPdGhlciB0b2tlbiB0eXBlcyAtIHRyeSB0byByZW5kZXIgYXMgaW5saW5lXG5cdFx0XHRcdGNvbnN0IHRleHQgPSB0aGlzLnJlbmRlcklubGluZVRva2VucyhbdG9rZW5dLCBzdHlsZUNvbnRleHQpO1xuXHRcdFx0XHRpZiAodGV4dCkge1xuXHRcdFx0XHRcdGxpbmVzLnB1c2godGV4dCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHRyZXR1cm4gbGluZXM7XG5cdH1cblxuXHQvKipcblx0ICogUmVuZGVyIGEgZmVuY2VkIGNvZGUgYmxvY2sgd2l0aCBzeW50YXggaGlnaGxpZ2h0aW5nIHN1cHBvcnQuXG5cdCAqIFVzZWQgYnkgYm90aCByZW5kZXJUb2tlbiAodG9wLWxldmVsIGNvZGUgYmxvY2tzKSBhbmQgcmVuZGVyTGlzdEl0ZW0gKGNvZGUgYmxvY2tzIGluc2lkZSBsaXN0cykuXG5cdCAqL1xuXHRwcml2YXRlIHJlbmRlckNvZGVCbG9jayhjb2RlOiBzdHJpbmcsIGxhbmc/OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG5cdFx0Y29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cdFx0Y29uc3QgaW5kZW50ID0gdGhpcy50aGVtZS5jb2RlQmxvY2tJbmRlbnQgPz8gXCIgIFwiO1xuXHRcdGxpbmVzLnB1c2godGhpcy50aGVtZS5jb2RlQmxvY2tCb3JkZXIoYFxcYFxcYFxcYCR7bGFuZyB8fCBcIlwifWApKTtcblx0XHRpZiAodGhpcy50aGVtZS5oaWdobGlnaHRDb2RlKSB7XG5cdFx0XHRjb25zdCBoaWdobGlnaHRlZExpbmVzID0gdGhpcy50aGVtZS5oaWdobGlnaHRDb2RlKGNvZGUsIGxhbmcpO1xuXHRcdFx0Zm9yIChjb25zdCBobExpbmUgb2YgaGlnaGxpZ2h0ZWRMaW5lcykge1xuXHRcdFx0XHRsaW5lcy5wdXNoKGAke2luZGVudH0ke2hsTGluZX1gKTtcblx0XHRcdH1cblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc3QgY29kZUxpbmVzID0gY29kZS5zcGxpdChcIlxcblwiKTtcblx0XHRcdGZvciAoY29uc3QgY29kZUxpbmUgb2YgY29kZUxpbmVzKSB7XG5cdFx0XHRcdGxpbmVzLnB1c2goYCR7aW5kZW50fSR7dGhpcy50aGVtZS5jb2RlQmxvY2soY29kZUxpbmUpfWApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRsaW5lcy5wdXNoKHRoaXMudGhlbWUuY29kZUJsb2NrQm9yZGVyKFwiYGBgXCIpKTtcblx0XHRyZXR1cm4gbGluZXM7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IHRoZSB2aXNpYmxlIHdpZHRoIG9mIHRoZSBsb25nZXN0IHdvcmQgaW4gYSBzdHJpbmcuXG5cdCAqL1xuXHRwcml2YXRlIGdldExvbmdlc3RXb3JkV2lkdGgodGV4dDogc3RyaW5nLCBtYXhXaWR0aD86IG51bWJlcik6IG51bWJlciB7XG5cdFx0Y29uc3Qgd29yZHMgPSB0ZXh0LnNwbGl0KC9cXHMrLykuZmlsdGVyKCh3b3JkKSA9PiB3b3JkLmxlbmd0aCA+IDApO1xuXHRcdGxldCBsb25nZXN0ID0gMDtcblx0XHRmb3IgKGNvbnN0IHdvcmQgb2Ygd29yZHMpIHtcblx0XHRcdGxvbmdlc3QgPSBNYXRoLm1heChsb25nZXN0LCB2aXNpYmxlV2lkdGgod29yZCkpO1xuXHRcdH1cblx0XHRpZiAobWF4V2lkdGggPT09IHVuZGVmaW5lZCkge1xuXHRcdFx0cmV0dXJuIGxvbmdlc3Q7XG5cdFx0fVxuXHRcdHJldHVybiBNYXRoLm1pbihsb25nZXN0LCBtYXhXaWR0aCk7XG5cdH1cblxuXHQvKipcblx0ICogV3JhcCBhIHRhYmxlIGNlbGwgdG8gZml0IGludG8gYSBjb2x1bW4uXG5cdCAqXG5cdCAqIERlbGVnYXRlcyB0byB3cmFwVGV4dFdpdGhBbnNpKCkgc28gQU5TSSBjb2RlcyArIGxvbmcgdG9rZW5zIGFyZSBoYW5kbGVkXG5cdCAqIGNvbnNpc3RlbnRseSB3aXRoIHRoZSByZXN0IG9mIHRoZSByZW5kZXJlci5cblx0ICovXG5cdHByaXZhdGUgd3JhcENlbGxUZXh0KHRleHQ6IHN0cmluZywgbWF4V2lkdGg6IG51bWJlcik6IHN0cmluZ1tdIHtcblx0XHRyZXR1cm4gd3JhcFRleHRXaXRoQW5zaSh0ZXh0LCBNYXRoLm1heCgxLCBtYXhXaWR0aCkpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFJlbmRlciBhIHRhYmxlIHdpdGggd2lkdGgtYXdhcmUgY2VsbCB3cmFwcGluZy5cblx0ICogQ2VsbHMgdGhhdCBkb24ndCBmaXQgYXJlIHdyYXBwZWQgdG8gbXVsdGlwbGUgbGluZXMuXG5cdCAqL1xuXHRwcml2YXRlIHJlbmRlclRhYmxlKFxuXHRcdHRva2VuOiBUb2tlbiAmIHsgaGVhZGVyOiBhbnlbXTsgcm93czogYW55W11bXTsgcmF3Pzogc3RyaW5nIH0sXG5cdFx0YXZhaWxhYmxlV2lkdGg6IG51bWJlcixcblx0XHRzdHlsZUNvbnRleHQ/OiBJbmxpbmVTdHlsZUNvbnRleHQsXG5cdCk6IHN0cmluZ1tdIHtcblx0XHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblx0XHRjb25zdCBudW1Db2xzID0gdG9rZW4uaGVhZGVyLmxlbmd0aDtcblxuXHRcdGlmIChudW1Db2xzID09PSAwKSB7XG5cdFx0XHRyZXR1cm4gbGluZXM7XG5cdFx0fVxuXG5cdFx0Ly8gQ2FsY3VsYXRlIGJvcmRlciBvdmVyaGVhZDogXCJcdTI1MDIgXCIgKyAobi0xKSAqIFwiIFx1MjUwMiBcIiArIFwiIFx1MjUwMlwiXG5cdFx0Ly8gPSAyICsgKG4tMSkgKiAzICsgMiA9IDNuICsgMVxuXHRcdGNvbnN0IGJvcmRlck92ZXJoZWFkID0gMyAqIG51bUNvbHMgKyAxO1xuXHRcdGNvbnN0IGF2YWlsYWJsZUZvckNlbGxzID0gYXZhaWxhYmxlV2lkdGggLSBib3JkZXJPdmVyaGVhZDtcblx0XHRpZiAoYXZhaWxhYmxlRm9yQ2VsbHMgPCBudW1Db2xzKSB7XG5cdFx0XHQvLyBUb28gbmFycm93IHRvIHJlbmRlciBhIHN0YWJsZSB0YWJsZS4gRmFsbCBiYWNrIHRvIHJhdyBtYXJrZG93bi5cblx0XHRcdGNvbnN0IGZhbGxiYWNrTGluZXMgPSB0b2tlbi5yYXcgPyB3cmFwVGV4dFdpdGhBbnNpKHRva2VuLnJhdywgYXZhaWxhYmxlV2lkdGgpIDogW107XG5cdFx0XHRmYWxsYmFja0xpbmVzLnB1c2goXCJcIik7XG5cdFx0XHRyZXR1cm4gZmFsbGJhY2tMaW5lcztcblx0XHR9XG5cblx0XHRjb25zdCBtYXhVbmJyb2tlbldvcmRXaWR0aCA9IDMwO1xuXG5cdFx0Ly8gQ2FsY3VsYXRlIG5hdHVyYWwgY29sdW1uIHdpZHRocyAod2hhdCBlYWNoIGNvbHVtbiBuZWVkcyB3aXRob3V0IGNvbnN0cmFpbnRzKVxuXHRcdGNvbnN0IG5hdHVyYWxXaWR0aHM6IG51bWJlcltdID0gW107XG5cdFx0Y29uc3QgbWluV29yZFdpZHRoczogbnVtYmVyW10gPSBbXTtcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IG51bUNvbHM7IGkrKykge1xuXHRcdFx0Y29uc3QgaGVhZGVyVGV4dCA9IHRoaXMucmVuZGVySW5saW5lVG9rZW5zKHRva2VuLmhlYWRlcltpXS50b2tlbnMgfHwgW10sIHN0eWxlQ29udGV4dCk7XG5cdFx0XHRuYXR1cmFsV2lkdGhzW2ldID0gdmlzaWJsZVdpZHRoKGhlYWRlclRleHQpO1xuXHRcdFx0bWluV29yZFdpZHRoc1tpXSA9IE1hdGgubWF4KDEsIHRoaXMuZ2V0TG9uZ2VzdFdvcmRXaWR0aChoZWFkZXJUZXh0LCBtYXhVbmJyb2tlbldvcmRXaWR0aCkpO1xuXHRcdH1cblx0XHRmb3IgKGNvbnN0IHJvdyBvZiB0b2tlbi5yb3dzKSB7XG5cdFx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHJvdy5sZW5ndGg7IGkrKykge1xuXHRcdFx0XHRjb25zdCBjZWxsVGV4dCA9IHRoaXMucmVuZGVySW5saW5lVG9rZW5zKHJvd1tpXS50b2tlbnMgfHwgW10sIHN0eWxlQ29udGV4dCk7XG5cdFx0XHRcdG5hdHVyYWxXaWR0aHNbaV0gPSBNYXRoLm1heChuYXR1cmFsV2lkdGhzW2ldIHx8IDAsIHZpc2libGVXaWR0aChjZWxsVGV4dCkpO1xuXHRcdFx0XHRtaW5Xb3JkV2lkdGhzW2ldID0gTWF0aC5tYXgoXG5cdFx0XHRcdFx0bWluV29yZFdpZHRoc1tpXSB8fCAxLFxuXHRcdFx0XHRcdHRoaXMuZ2V0TG9uZ2VzdFdvcmRXaWR0aChjZWxsVGV4dCwgbWF4VW5icm9rZW5Xb3JkV2lkdGgpLFxuXHRcdFx0XHQpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGxldCBtaW5Db2x1bW5XaWR0aHMgPSBtaW5Xb3JkV2lkdGhzO1xuXHRcdGxldCBtaW5DZWxsc1dpZHRoID0gbWluQ29sdW1uV2lkdGhzLnJlZHVjZSgoYSwgYikgPT4gYSArIGIsIDApO1xuXG5cdFx0aWYgKG1pbkNlbGxzV2lkdGggPiBhdmFpbGFibGVGb3JDZWxscykge1xuXHRcdFx0bWluQ29sdW1uV2lkdGhzID0gbmV3IEFycmF5KG51bUNvbHMpLmZpbGwoMSk7XG5cdFx0XHRjb25zdCByZW1haW5pbmcgPSBhdmFpbGFibGVGb3JDZWxscyAtIG51bUNvbHM7XG5cblx0XHRcdGlmIChyZW1haW5pbmcgPiAwKSB7XG5cdFx0XHRcdGNvbnN0IHRvdGFsV2VpZ2h0ID0gbWluV29yZFdpZHRocy5yZWR1Y2UoKHRvdGFsLCB3aWR0aCkgPT4gdG90YWwgKyBNYXRoLm1heCgwLCB3aWR0aCAtIDEpLCAwKTtcblx0XHRcdFx0Y29uc3QgZ3Jvd3RoID0gbWluV29yZFdpZHRocy5tYXAoKHdpZHRoKSA9PiB7XG5cdFx0XHRcdFx0Y29uc3Qgd2VpZ2h0ID0gTWF0aC5tYXgoMCwgd2lkdGggLSAxKTtcblx0XHRcdFx0XHRyZXR1cm4gdG90YWxXZWlnaHQgPiAwID8gTWF0aC5mbG9vcigod2VpZ2h0IC8gdG90YWxXZWlnaHQpICogcmVtYWluaW5nKSA6IDA7XG5cdFx0XHRcdH0pO1xuXG5cdFx0XHRcdGZvciAobGV0IGkgPSAwOyBpIDwgbnVtQ29sczsgaSsrKSB7XG5cdFx0XHRcdFx0bWluQ29sdW1uV2lkdGhzW2ldICs9IGdyb3d0aFtpXSA/PyAwO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgYWxsb2NhdGVkID0gZ3Jvd3RoLnJlZHVjZSgodG90YWwsIHdpZHRoKSA9PiB0b3RhbCArIHdpZHRoLCAwKTtcblx0XHRcdFx0bGV0IGxlZnRvdmVyID0gcmVtYWluaW5nIC0gYWxsb2NhdGVkO1xuXHRcdFx0XHRmb3IgKGxldCBpID0gMDsgbGVmdG92ZXIgPiAwICYmIGkgPCBudW1Db2xzOyBpKyspIHtcblx0XHRcdFx0XHRtaW5Db2x1bW5XaWR0aHNbaV0rKztcblx0XHRcdFx0XHRsZWZ0b3Zlci0tO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdG1pbkNlbGxzV2lkdGggPSBtaW5Db2x1bW5XaWR0aHMucmVkdWNlKChhLCBiKSA9PiBhICsgYiwgMCk7XG5cdFx0fVxuXG5cdFx0Ly8gQ2FsY3VsYXRlIGNvbHVtbiB3aWR0aHMgdGhhdCBmaXQgd2l0aGluIGF2YWlsYWJsZSB3aWR0aFxuXHRcdGNvbnN0IHRvdGFsTmF0dXJhbFdpZHRoID0gbmF0dXJhbFdpZHRocy5yZWR1Y2UoKGEsIGIpID0+IGEgKyBiLCAwKSArIGJvcmRlck92ZXJoZWFkO1xuXHRcdGxldCBjb2x1bW5XaWR0aHM6IG51bWJlcltdO1xuXG5cdFx0aWYgKHRvdGFsTmF0dXJhbFdpZHRoIDw9IGF2YWlsYWJsZVdpZHRoKSB7XG5cdFx0XHQvLyBFdmVyeXRoaW5nIGZpdHMgbmF0dXJhbGx5XG5cdFx0XHRjb2x1bW5XaWR0aHMgPSBuYXR1cmFsV2lkdGhzLm1hcCgod2lkdGgsIGluZGV4KSA9PiBNYXRoLm1heCh3aWR0aCwgbWluQ29sdW1uV2lkdGhzW2luZGV4XSkpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBOZWVkIHRvIHNocmluayBjb2x1bW5zIHRvIGZpdFxuXHRcdFx0Y29uc3QgdG90YWxHcm93UG90ZW50aWFsID0gbmF0dXJhbFdpZHRocy5yZWR1Y2UoKHRvdGFsLCB3aWR0aCwgaW5kZXgpID0+IHtcblx0XHRcdFx0cmV0dXJuIHRvdGFsICsgTWF0aC5tYXgoMCwgd2lkdGggLSBtaW5Db2x1bW5XaWR0aHNbaW5kZXhdKTtcblx0XHRcdH0sIDApO1xuXHRcdFx0Y29uc3QgZXh0cmFXaWR0aCA9IE1hdGgubWF4KDAsIGF2YWlsYWJsZUZvckNlbGxzIC0gbWluQ2VsbHNXaWR0aCk7XG5cdFx0XHRjb2x1bW5XaWR0aHMgPSBtaW5Db2x1bW5XaWR0aHMubWFwKChtaW5XaWR0aCwgaW5kZXgpID0+IHtcblx0XHRcdFx0Y29uc3QgbmF0dXJhbFdpZHRoID0gbmF0dXJhbFdpZHRoc1tpbmRleF07XG5cdFx0XHRcdGNvbnN0IG1pbldpZHRoRGVsdGEgPSBNYXRoLm1heCgwLCBuYXR1cmFsV2lkdGggLSBtaW5XaWR0aCk7XG5cdFx0XHRcdGxldCBncm93ID0gMDtcblx0XHRcdFx0aWYgKHRvdGFsR3Jvd1BvdGVudGlhbCA+IDApIHtcblx0XHRcdFx0XHRncm93ID0gTWF0aC5mbG9vcigobWluV2lkdGhEZWx0YSAvIHRvdGFsR3Jvd1BvdGVudGlhbCkgKiBleHRyYVdpZHRoKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4gbWluV2lkdGggKyBncm93O1xuXHRcdFx0fSk7XG5cblx0XHRcdC8vIEFkanVzdCBmb3Igcm91bmRpbmcgZXJyb3JzIC0gZGlzdHJpYnV0ZSByZW1haW5pbmcgc3BhY2Vcblx0XHRcdGNvbnN0IGFsbG9jYXRlZCA9IGNvbHVtbldpZHRocy5yZWR1Y2UoKGEsIGIpID0+IGEgKyBiLCAwKTtcblx0XHRcdGxldCByZW1haW5pbmcgPSBhdmFpbGFibGVGb3JDZWxscyAtIGFsbG9jYXRlZDtcblx0XHRcdHdoaWxlIChyZW1haW5pbmcgPiAwKSB7XG5cdFx0XHRcdGxldCBncmV3ID0gZmFsc2U7XG5cdFx0XHRcdGZvciAobGV0IGkgPSAwOyBpIDwgbnVtQ29scyAmJiByZW1haW5pbmcgPiAwOyBpKyspIHtcblx0XHRcdFx0XHRpZiAoY29sdW1uV2lkdGhzW2ldIDwgbmF0dXJhbFdpZHRoc1tpXSkge1xuXHRcdFx0XHRcdFx0Y29sdW1uV2lkdGhzW2ldKys7XG5cdFx0XHRcdFx0XHRyZW1haW5pbmctLTtcblx0XHRcdFx0XHRcdGdyZXcgPSB0cnVlO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoIWdyZXcpIHtcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIFJlbmRlciB0b3AgYm9yZGVyXG5cdFx0Y29uc3QgdG9wQm9yZGVyQ2VsbHMgPSBjb2x1bW5XaWR0aHMubWFwKCh3KSA9PiBcIlx1MjUwMFwiLnJlcGVhdCh3KSk7XG5cdFx0bGluZXMucHVzaChgXHUyNTBDXHUyNTAwJHt0b3BCb3JkZXJDZWxscy5qb2luKFwiXHUyNTAwXHUyNTJDXHUyNTAwXCIpfVx1MjUwMFx1MjUxMGApO1xuXG5cdFx0Ly8gUmVuZGVyIGhlYWRlciB3aXRoIHdyYXBwaW5nXG5cdFx0Y29uc3QgaGVhZGVyQ2VsbExpbmVzOiBzdHJpbmdbXVtdID0gdG9rZW4uaGVhZGVyLm1hcCgoY2VsbCwgaSkgPT4ge1xuXHRcdFx0Y29uc3QgdGV4dCA9IHRoaXMucmVuZGVySW5saW5lVG9rZW5zKGNlbGwudG9rZW5zIHx8IFtdLCBzdHlsZUNvbnRleHQpO1xuXHRcdFx0cmV0dXJuIHRoaXMud3JhcENlbGxUZXh0KHRleHQsIGNvbHVtbldpZHRoc1tpXSk7XG5cdFx0fSk7XG5cdFx0Y29uc3QgaGVhZGVyTGluZUNvdW50ID0gTWF0aC5tYXgoLi4uaGVhZGVyQ2VsbExpbmVzLm1hcCgoYykgPT4gYy5sZW5ndGgpKTtcblxuXHRcdGZvciAobGV0IGxpbmVJZHggPSAwOyBsaW5lSWR4IDwgaGVhZGVyTGluZUNvdW50OyBsaW5lSWR4KyspIHtcblx0XHRcdGNvbnN0IHJvd1BhcnRzID0gaGVhZGVyQ2VsbExpbmVzLm1hcCgoY2VsbExpbmVzLCBjb2xJZHgpID0+IHtcblx0XHRcdFx0Y29uc3QgdGV4dCA9IGNlbGxMaW5lc1tsaW5lSWR4XSB8fCBcIlwiO1xuXHRcdFx0XHRjb25zdCBwYWRkZWQgPSB0ZXh0ICsgXCIgXCIucmVwZWF0KE1hdGgubWF4KDAsIGNvbHVtbldpZHRoc1tjb2xJZHhdIC0gdmlzaWJsZVdpZHRoKHRleHQpKSk7XG5cdFx0XHRcdHJldHVybiB0aGlzLnRoZW1lLmJvbGQocGFkZGVkKTtcblx0XHRcdH0pO1xuXHRcdFx0bGluZXMucHVzaChgXHUyNTAyICR7cm93UGFydHMuam9pbihcIiBcdTI1MDIgXCIpfSBcdTI1MDJgKTtcblx0XHR9XG5cblx0XHQvLyBSZW5kZXIgc2VwYXJhdG9yXG5cdFx0Y29uc3Qgc2VwYXJhdG9yQ2VsbHMgPSBjb2x1bW5XaWR0aHMubWFwKCh3KSA9PiBcIlx1MjUwMFwiLnJlcGVhdCh3KSk7XG5cdFx0Y29uc3Qgc2VwYXJhdG9yTGluZSA9IGBcdTI1MUNcdTI1MDAke3NlcGFyYXRvckNlbGxzLmpvaW4oXCJcdTI1MDBcdTI1M0NcdTI1MDBcIil9XHUyNTAwXHUyNTI0YDtcblx0XHRsaW5lcy5wdXNoKHNlcGFyYXRvckxpbmUpO1xuXG5cdFx0Ly8gUmVuZGVyIHJvd3Mgd2l0aCB3cmFwcGluZ1xuXHRcdGZvciAobGV0IHJvd0luZGV4ID0gMDsgcm93SW5kZXggPCB0b2tlbi5yb3dzLmxlbmd0aDsgcm93SW5kZXgrKykge1xuXHRcdFx0Y29uc3Qgcm93ID0gdG9rZW4ucm93c1tyb3dJbmRleF07XG5cdFx0XHRjb25zdCByb3dDZWxsTGluZXM6IHN0cmluZ1tdW10gPSByb3cubWFwKChjZWxsLCBpKSA9PiB7XG5cdFx0XHRcdGNvbnN0IHRleHQgPSB0aGlzLnJlbmRlcklubGluZVRva2VucyhjZWxsLnRva2VucyB8fCBbXSwgc3R5bGVDb250ZXh0KTtcblx0XHRcdFx0cmV0dXJuIHRoaXMud3JhcENlbGxUZXh0KHRleHQsIGNvbHVtbldpZHRoc1tpXSk7XG5cdFx0XHR9KTtcblx0XHRcdGNvbnN0IHJvd0xpbmVDb3VudCA9IE1hdGgubWF4KC4uLnJvd0NlbGxMaW5lcy5tYXAoKGMpID0+IGMubGVuZ3RoKSk7XG5cblx0XHRcdGZvciAobGV0IGxpbmVJZHggPSAwOyBsaW5lSWR4IDwgcm93TGluZUNvdW50OyBsaW5lSWR4KyspIHtcblx0XHRcdFx0Y29uc3Qgcm93UGFydHMgPSByb3dDZWxsTGluZXMubWFwKChjZWxsTGluZXMsIGNvbElkeCkgPT4ge1xuXHRcdFx0XHRcdGNvbnN0IHRleHQgPSBjZWxsTGluZXNbbGluZUlkeF0gfHwgXCJcIjtcblx0XHRcdFx0XHRyZXR1cm4gdGV4dCArIFwiIFwiLnJlcGVhdChNYXRoLm1heCgwLCBjb2x1bW5XaWR0aHNbY29sSWR4XSAtIHZpc2libGVXaWR0aCh0ZXh0KSkpO1xuXHRcdFx0XHR9KTtcblx0XHRcdFx0bGluZXMucHVzaChgXHUyNTAyICR7cm93UGFydHMuam9pbihcIiBcdTI1MDIgXCIpfSBcdTI1MDJgKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKHJvd0luZGV4IDwgdG9rZW4ucm93cy5sZW5ndGggLSAxKSB7XG5cdFx0XHRcdGxpbmVzLnB1c2goc2VwYXJhdG9yTGluZSk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gUmVuZGVyIGJvdHRvbSBib3JkZXJcblx0XHRjb25zdCBib3R0b21Cb3JkZXJDZWxscyA9IGNvbHVtbldpZHRocy5tYXAoKHcpID0+IFwiXHUyNTAwXCIucmVwZWF0KHcpKTtcblx0XHRsaW5lcy5wdXNoKGBcdTI1MTRcdTI1MDAke2JvdHRvbUJvcmRlckNlbGxzLmpvaW4oXCJcdTI1MDBcdTI1MzRcdTI1MDBcIil9XHUyNTAwXHUyNTE4YCk7XG5cblx0XHRsaW5lcy5wdXNoKFwiXCIpOyAvLyBBZGQgc3BhY2luZyBhZnRlciB0YWJsZVxuXHRcdHJldHVybiBsaW5lcztcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxjQUEwQjtBQUNuQyxTQUFTLG1CQUFtQjtBQUU1QixTQUFTLHVCQUF1QixpQkFBaUIsY0FBYyx3QkFBd0I7QUFrRGhGLE1BQU0sU0FBOEI7QUFBQSxFQWdCMUMsWUFDQyxNQUNBLFVBQ0EsVUFDQSxPQUNBLGtCQUNDO0FBQ0QsU0FBSyxPQUFPO0FBQ1osU0FBSyxXQUFXO0FBQ2hCLFNBQUssV0FBVztBQUNoQixTQUFLLFFBQVE7QUFDYixTQUFLLG1CQUFtQjtBQUFBLEVBQ3pCO0FBQUEsRUFFQSxRQUFRLE1BQW9CO0FBQzNCLFNBQUssT0FBTztBQUNaLFNBQUssV0FBVztBQUFBLEVBQ2pCO0FBQUEsRUFFQSxhQUFt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
