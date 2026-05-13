const EVALUATE_HELPERS_SOURCE = `(function() {
  var pi = window.__pi = window.__pi || {};

  // -----------------------------------------------------------------------
  // 1. simpleHash \u2014 djb2 hash matching core.js computeContentHash
  // -----------------------------------------------------------------------
  pi.simpleHash = function simpleHash(str) {
    if (!str) return "0";
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  };

  // -----------------------------------------------------------------------
  // 2. isVisible
  // -----------------------------------------------------------------------
  pi.isVisible = function isVisible(el) {
    var style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  // -----------------------------------------------------------------------
  // 3. isEnabled
  // -----------------------------------------------------------------------
  pi.isEnabled = function isEnabled(el) {
    var disabledAttr = el.getAttribute("disabled") !== null;
    var ariaDisabled = (el.getAttribute("aria-disabled") || "").toLowerCase() === "true";
    return !disabledAttr && !ariaDisabled;
  };

  // -----------------------------------------------------------------------
  // 4. inferRole
  // -----------------------------------------------------------------------
  pi.inferRole = function inferRole(el) {
    var explicit = (el.getAttribute("role") || "").trim();
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === "a" && el.getAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].indexOf(type) !== -1) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    return "";
  };

  // -----------------------------------------------------------------------
  // 5. accessibleName
  // -----------------------------------------------------------------------
  pi.accessibleName = function accessibleName(el) {
    var ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy && labelledBy.trim()) {
      var text = labelledBy.trim().split(/\\s+/).map(function(id) {
        var ref = document.getElementById(id);
        return ref ? (ref.textContent || "").trim() : "";
      }).join(" ").trim();
      if (text) return text;
    }
    var placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim()) return placeholder.trim();
    var alt = el.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim();
    var value = el.value;
    if (value && typeof value === "string" && value.trim()) return value.trim().slice(0, 80);
    return (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80);
  };

  // -----------------------------------------------------------------------
  // 6. isInteractiveEl
  // -----------------------------------------------------------------------
  var interactiveRoles = {
    button: 1, link: 1, textbox: 1, searchbox: 1, combobox: 1,
    checkbox: 1, radio: 1, "switch": 1, menuitem: 1,
    menuitemcheckbox: 1, menuitemradio: 1, tab: 1, option: 1,
    slider: 1, spinbutton: 1
  };
  pi.isInteractiveEl = function isInteractiveEl(el) {
    var tag = el.tagName.toLowerCase();
    var role = pi.inferRole(el);
    if (["button", "input", "select", "textarea", "summary", "option"].indexOf(tag) !== -1) return true;
    if (tag === "a" && !!el.getAttribute("href")) return true;
    if (interactiveRoles[role]) return true;
    if (el.tabIndex >= 0) return true;
    if (el.isContentEditable) return true;
    return false;
  };

  // -----------------------------------------------------------------------
  // 7. cssPath
  // -----------------------------------------------------------------------
  pi.cssPath = function cssPath(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    var parts = [];
    var current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      var tag = current.tagName.toLowerCase();
      var part = tag;
      var parent = current.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(c) {
          return c.tagName === current.tagName;
        });
        if (siblings.length > 1) {
          var idx = siblings.indexOf(current) + 1;
          part += ":nth-of-type(" + idx + ")";
        }
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return "body > " + parts.join(" > ");
  };

  // -----------------------------------------------------------------------
  // 8. domPath
  // -----------------------------------------------------------------------
  pi.domPath = function domPath(el) {
    var path = [];
    var current = el;
    while (current && current !== document.documentElement) {
      var parent = current.parentElement;
      if (!parent) break;
      var idx = Array.from(parent.children).indexOf(current);
      path.unshift(idx);
      current = parent;
    }
    return path;
  };

  // -----------------------------------------------------------------------
  // 9. selectorHints
  // -----------------------------------------------------------------------
  pi.selectorHints = function selectorHints(el) {
    var hints = [];
    if (el.id) hints.push("#" + CSS.escape(el.id));
    var nameAttr = el.getAttribute("name");
    if (nameAttr) hints.push(el.tagName.toLowerCase() + '[name="' + CSS.escape(nameAttr) + '"]');
    var aria = el.getAttribute("aria-label");
    if (aria) hints.push(el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(aria) + '"]');
    var placeholder = el.getAttribute("placeholder");
    if (placeholder) hints.push(el.tagName.toLowerCase() + '[placeholder="' + CSS.escape(placeholder) + '"]');
    var cls = Array.from(el.classList).slice(0, 2);
    if (cls.length > 0) hints.push(el.tagName.toLowerCase() + "." + cls.map(function(c) { return CSS.escape(c); }).join("."));
    hints.push(pi.cssPath(el));
    var seen = {};
    var unique = [];
    for (var i = 0; i < hints.length; i++) {
      if (!seen[hints[i]]) {
        seen[hints[i]] = true;
        unique.push(hints[i]);
      }
    }
    return unique.slice(0, 6);
  };
})();`;
export {
  EVALUATE_HELPERS_SOURCE
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvZXZhbHVhdGUtaGVscGVycy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBicm93c2VyLXRvb2xzIFx1MjAxNCBicm93c2VyLXNpZGUgZXZhbHVhdGUgaGVscGVyc1xuICpcbiAqIEV4cG9ydHMgYSBzaW5nbGUgc3RyaW5nIGNvbnN0YW50IGBFVkFMVUFURV9IRUxQRVJTX1NPVVJDRWAgY29udGFpbmluZyBhbiBJSUZFXG4gKiB0aGF0IGF0dGFjaGVzIHV0aWxpdHkgZnVuY3Rpb25zIHRvIGB3aW5kb3cuX19waWAuICBUaGlzIGlzIGluamVjdGVkIGludG8gZXZlcnlcbiAqIG5ldyBCcm93c2VyQ29udGV4dCB2aWEgYGNvbnRleHQuYWRkSW5pdFNjcmlwdCgpYCBzbyB0aGF0IGBwYWdlLmV2YWx1YXRlKClgXG4gKiBjYWxsYmFja3MgY2FuIHJlZmVyZW5jZSBgd2luZG93Ll9fcGkuY3NzUGF0aChlbClgIGV0Yy4gaW5zdGVhZCBvZiByZWRlY2xhcmluZ1xuICogdGhlIHNhbWUgZnVuY3Rpb25zIGlubGluZS5cbiAqXG4gKiBUaGUgYHNpbXBsZUhhc2hgIGZ1bmN0aW9uIHVzZXMgdGhlIGRqYjIgYWxnb3JpdGhtIGlkZW50aWNhbCB0b1xuICogYGNvbXB1dGVDb250ZW50SGFzaGAgLyBgY29tcHV0ZVN0cnVjdHVyYWxTaWduYXR1cmVgIGluIGBjb3JlLmpzYC5cbiAqXG4gKiBGdW5jdGlvbnMgcHJvdmlkZWQgKDkpOlxuICogICBjc3NQYXRoLCBzaW1wbGVIYXNoLCBpc1Zpc2libGUsIGlzRW5hYmxlZCwgaW5mZXJSb2xlLFxuICogICBhY2Nlc3NpYmxlTmFtZSwgaXNJbnRlcmFjdGl2ZUVsLCBkb21QYXRoLCBzZWxlY3RvckhpbnRzXG4gKi9cblxuZXhwb3J0IGNvbnN0IEVWQUxVQVRFX0hFTFBFUlNfU09VUkNFID0gYChmdW5jdGlvbigpIHtcbiAgdmFyIHBpID0gd2luZG93Ll9fcGkgPSB3aW5kb3cuX19waSB8fCB7fTtcblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyAxLiBzaW1wbGVIYXNoIFx1MjAxNCBkamIyIGhhc2ggbWF0Y2hpbmcgY29yZS5qcyBjb21wdXRlQ29udGVudEhhc2hcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgcGkuc2ltcGxlSGFzaCA9IGZ1bmN0aW9uIHNpbXBsZUhhc2goc3RyKSB7XG4gICAgaWYgKCFzdHIpIHJldHVybiBcIjBcIjtcbiAgICB2YXIgaCA9IDUzODE7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBzdHIubGVuZ3RoOyBpKyspIHtcbiAgICAgIGggPSAoKGggPDwgNSkgLSBoICsgc3RyLmNoYXJDb2RlQXQoaSkpIHwgMDtcbiAgICB9XG4gICAgcmV0dXJuIChoID4+PiAwKS50b1N0cmluZygxNik7XG4gIH07XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gMi4gaXNWaXNpYmxlXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIHBpLmlzVmlzaWJsZSA9IGZ1bmN0aW9uIGlzVmlzaWJsZShlbCkge1xuICAgIHZhciBzdHlsZSA9IHdpbmRvdy5nZXRDb21wdXRlZFN0eWxlKGVsKTtcbiAgICBpZiAoc3R5bGUuZGlzcGxheSA9PT0gXCJub25lXCIgfHwgc3R5bGUudmlzaWJpbGl0eSA9PT0gXCJoaWRkZW5cIikgcmV0dXJuIGZhbHNlO1xuICAgIHZhciByZWN0ID0gZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgcmV0dXJuIHJlY3Qud2lkdGggPiAwICYmIHJlY3QuaGVpZ2h0ID4gMDtcbiAgfTtcblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyAzLiBpc0VuYWJsZWRcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgcGkuaXNFbmFibGVkID0gZnVuY3Rpb24gaXNFbmFibGVkKGVsKSB7XG4gICAgdmFyIGRpc2FibGVkQXR0ciA9IGVsLmdldEF0dHJpYnV0ZShcImRpc2FibGVkXCIpICE9PSBudWxsO1xuICAgIHZhciBhcmlhRGlzYWJsZWQgPSAoZWwuZ2V0QXR0cmlidXRlKFwiYXJpYS1kaXNhYmxlZFwiKSB8fCBcIlwiKS50b0xvd2VyQ2FzZSgpID09PSBcInRydWVcIjtcbiAgICByZXR1cm4gIWRpc2FibGVkQXR0ciAmJiAhYXJpYURpc2FibGVkO1xuICB9O1xuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIDQuIGluZmVyUm9sZVxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBwaS5pbmZlclJvbGUgPSBmdW5jdGlvbiBpbmZlclJvbGUoZWwpIHtcbiAgICB2YXIgZXhwbGljaXQgPSAoZWwuZ2V0QXR0cmlidXRlKFwicm9sZVwiKSB8fCBcIlwiKS50cmltKCk7XG4gICAgaWYgKGV4cGxpY2l0KSByZXR1cm4gZXhwbGljaXQ7XG4gICAgdmFyIHRhZyA9IGVsLnRhZ05hbWUudG9Mb3dlckNhc2UoKTtcbiAgICBpZiAodGFnID09PSBcImFcIiAmJiBlbC5nZXRBdHRyaWJ1dGUoXCJocmVmXCIpKSByZXR1cm4gXCJsaW5rXCI7XG4gICAgaWYgKHRhZyA9PT0gXCJidXR0b25cIikgcmV0dXJuIFwiYnV0dG9uXCI7XG4gICAgaWYgKHRhZyA9PT0gXCJzZWxlY3RcIikgcmV0dXJuIFwiY29tYm9ib3hcIjtcbiAgICBpZiAodGFnID09PSBcInRleHRhcmVhXCIpIHJldHVybiBcInRleHRib3hcIjtcbiAgICBpZiAodGFnID09PSBcImlucHV0XCIpIHtcbiAgICAgIHZhciB0eXBlID0gKGVsLmdldEF0dHJpYnV0ZShcInR5cGVcIikgfHwgXCJ0ZXh0XCIpLnRvTG93ZXJDYXNlKCk7XG4gICAgICBpZiAoW1wiYnV0dG9uXCIsIFwic3VibWl0XCIsIFwicmVzZXRcIl0uaW5kZXhPZih0eXBlKSAhPT0gLTEpIHJldHVybiBcImJ1dHRvblwiO1xuICAgICAgaWYgKHR5cGUgPT09IFwiY2hlY2tib3hcIikgcmV0dXJuIFwiY2hlY2tib3hcIjtcbiAgICAgIGlmICh0eXBlID09PSBcInJhZGlvXCIpIHJldHVybiBcInJhZGlvXCI7XG4gICAgICBpZiAodHlwZSA9PT0gXCJzZWFyY2hcIikgcmV0dXJuIFwic2VhcmNoYm94XCI7XG4gICAgICByZXR1cm4gXCJ0ZXh0Ym94XCI7XG4gICAgfVxuICAgIHJldHVybiBcIlwiO1xuICB9O1xuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIDUuIGFjY2Vzc2libGVOYW1lXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIHBpLmFjY2Vzc2libGVOYW1lID0gZnVuY3Rpb24gYWNjZXNzaWJsZU5hbWUoZWwpIHtcbiAgICB2YXIgYXJpYUxhYmVsID0gZWwuZ2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKTtcbiAgICBpZiAoYXJpYUxhYmVsICYmIGFyaWFMYWJlbC50cmltKCkpIHJldHVybiBhcmlhTGFiZWwudHJpbSgpO1xuICAgIHZhciBsYWJlbGxlZEJ5ID0gZWwuZ2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbGxlZGJ5XCIpO1xuICAgIGlmIChsYWJlbGxlZEJ5ICYmIGxhYmVsbGVkQnkudHJpbSgpKSB7XG4gICAgICB2YXIgdGV4dCA9IGxhYmVsbGVkQnkudHJpbSgpLnNwbGl0KC9cXFxccysvKS5tYXAoZnVuY3Rpb24oaWQpIHtcbiAgICAgICAgdmFyIHJlZiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTtcbiAgICAgICAgcmV0dXJuIHJlZiA/IChyZWYudGV4dENvbnRlbnQgfHwgXCJcIikudHJpbSgpIDogXCJcIjtcbiAgICAgIH0pLmpvaW4oXCIgXCIpLnRyaW0oKTtcbiAgICAgIGlmICh0ZXh0KSByZXR1cm4gdGV4dDtcbiAgICB9XG4gICAgdmFyIHBsYWNlaG9sZGVyID0gZWwuZ2V0QXR0cmlidXRlKFwicGxhY2Vob2xkZXJcIik7XG4gICAgaWYgKHBsYWNlaG9sZGVyICYmIHBsYWNlaG9sZGVyLnRyaW0oKSkgcmV0dXJuIHBsYWNlaG9sZGVyLnRyaW0oKTtcbiAgICB2YXIgYWx0ID0gZWwuZ2V0QXR0cmlidXRlKFwiYWx0XCIpO1xuICAgIGlmIChhbHQgJiYgYWx0LnRyaW0oKSkgcmV0dXJuIGFsdC50cmltKCk7XG4gICAgdmFyIHZhbHVlID0gZWwudmFsdWU7XG4gICAgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiB2YWx1ZS50cmltKCkpIHJldHVybiB2YWx1ZS50cmltKCkuc2xpY2UoMCwgODApO1xuICAgIHJldHVybiAoZWwudGV4dENvbnRlbnQgfHwgXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcXFxzKy9nLCBcIiBcIikuc2xpY2UoMCwgODApO1xuICB9O1xuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIDYuIGlzSW50ZXJhY3RpdmVFbFxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICB2YXIgaW50ZXJhY3RpdmVSb2xlcyA9IHtcbiAgICBidXR0b246IDEsIGxpbms6IDEsIHRleHRib3g6IDEsIHNlYXJjaGJveDogMSwgY29tYm9ib3g6IDEsXG4gICAgY2hlY2tib3g6IDEsIHJhZGlvOiAxLCBcInN3aXRjaFwiOiAxLCBtZW51aXRlbTogMSxcbiAgICBtZW51aXRlbWNoZWNrYm94OiAxLCBtZW51aXRlbXJhZGlvOiAxLCB0YWI6IDEsIG9wdGlvbjogMSxcbiAgICBzbGlkZXI6IDEsIHNwaW5idXR0b246IDFcbiAgfTtcbiAgcGkuaXNJbnRlcmFjdGl2ZUVsID0gZnVuY3Rpb24gaXNJbnRlcmFjdGl2ZUVsKGVsKSB7XG4gICAgdmFyIHRhZyA9IGVsLnRhZ05hbWUudG9Mb3dlckNhc2UoKTtcbiAgICB2YXIgcm9sZSA9IHBpLmluZmVyUm9sZShlbCk7XG4gICAgaWYgKFtcImJ1dHRvblwiLCBcImlucHV0XCIsIFwic2VsZWN0XCIsIFwidGV4dGFyZWFcIiwgXCJzdW1tYXJ5XCIsIFwib3B0aW9uXCJdLmluZGV4T2YodGFnKSAhPT0gLTEpIHJldHVybiB0cnVlO1xuICAgIGlmICh0YWcgPT09IFwiYVwiICYmICEhZWwuZ2V0QXR0cmlidXRlKFwiaHJlZlwiKSkgcmV0dXJuIHRydWU7XG4gICAgaWYgKGludGVyYWN0aXZlUm9sZXNbcm9sZV0pIHJldHVybiB0cnVlO1xuICAgIGlmIChlbC50YWJJbmRleCA+PSAwKSByZXR1cm4gdHJ1ZTtcbiAgICBpZiAoZWwuaXNDb250ZW50RWRpdGFibGUpIHJldHVybiB0cnVlO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfTtcblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyA3LiBjc3NQYXRoXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIHBpLmNzc1BhdGggPSBmdW5jdGlvbiBjc3NQYXRoKGVsKSB7XG4gICAgaWYgKGVsLmlkKSByZXR1cm4gXCIjXCIgKyBDU1MuZXNjYXBlKGVsLmlkKTtcbiAgICB2YXIgcGFydHMgPSBbXTtcbiAgICB2YXIgY3VycmVudCA9IGVsO1xuICAgIHdoaWxlIChjdXJyZW50ICYmIGN1cnJlbnQubm9kZVR5cGUgPT09IE5vZGUuRUxFTUVOVF9OT0RFICYmIGN1cnJlbnQgIT09IGRvY3VtZW50LmJvZHkpIHtcbiAgICAgIHZhciB0YWcgPSBjdXJyZW50LnRhZ05hbWUudG9Mb3dlckNhc2UoKTtcbiAgICAgIHZhciBwYXJ0ID0gdGFnO1xuICAgICAgdmFyIHBhcmVudCA9IGN1cnJlbnQucGFyZW50RWxlbWVudDtcbiAgICAgIGlmIChwYXJlbnQpIHtcbiAgICAgICAgdmFyIHNpYmxpbmdzID0gQXJyYXkuZnJvbShwYXJlbnQuY2hpbGRyZW4pLmZpbHRlcihmdW5jdGlvbihjKSB7XG4gICAgICAgICAgcmV0dXJuIGMudGFnTmFtZSA9PT0gY3VycmVudC50YWdOYW1lO1xuICAgICAgICB9KTtcbiAgICAgICAgaWYgKHNpYmxpbmdzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgICB2YXIgaWR4ID0gc2libGluZ3MuaW5kZXhPZihjdXJyZW50KSArIDE7XG4gICAgICAgICAgcGFydCArPSBcIjpudGgtb2YtdHlwZShcIiArIGlkeCArIFwiKVwiO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBwYXJ0cy51bnNoaWZ0KHBhcnQpO1xuICAgICAgY3VycmVudCA9IGN1cnJlbnQucGFyZW50RWxlbWVudDtcbiAgICB9XG4gICAgcmV0dXJuIFwiYm9keSA+IFwiICsgcGFydHMuam9pbihcIiA+IFwiKTtcbiAgfTtcblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyA4LiBkb21QYXRoXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIHBpLmRvbVBhdGggPSBmdW5jdGlvbiBkb21QYXRoKGVsKSB7XG4gICAgdmFyIHBhdGggPSBbXTtcbiAgICB2YXIgY3VycmVudCA9IGVsO1xuICAgIHdoaWxlIChjdXJyZW50ICYmIGN1cnJlbnQgIT09IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCkge1xuICAgICAgdmFyIHBhcmVudCA9IGN1cnJlbnQucGFyZW50RWxlbWVudDtcbiAgICAgIGlmICghcGFyZW50KSBicmVhaztcbiAgICAgIHZhciBpZHggPSBBcnJheS5mcm9tKHBhcmVudC5jaGlsZHJlbikuaW5kZXhPZihjdXJyZW50KTtcbiAgICAgIHBhdGgudW5zaGlmdChpZHgpO1xuICAgICAgY3VycmVudCA9IHBhcmVudDtcbiAgICB9XG4gICAgcmV0dXJuIHBhdGg7XG4gIH07XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gOS4gc2VsZWN0b3JIaW50c1xuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBwaS5zZWxlY3RvckhpbnRzID0gZnVuY3Rpb24gc2VsZWN0b3JIaW50cyhlbCkge1xuICAgIHZhciBoaW50cyA9IFtdO1xuICAgIGlmIChlbC5pZCkgaGludHMucHVzaChcIiNcIiArIENTUy5lc2NhcGUoZWwuaWQpKTtcbiAgICB2YXIgbmFtZUF0dHIgPSBlbC5nZXRBdHRyaWJ1dGUoXCJuYW1lXCIpO1xuICAgIGlmIChuYW1lQXR0cikgaGludHMucHVzaChlbC50YWdOYW1lLnRvTG93ZXJDYXNlKCkgKyAnW25hbWU9XCInICsgQ1NTLmVzY2FwZShuYW1lQXR0cikgKyAnXCJdJyk7XG4gICAgdmFyIGFyaWEgPSBlbC5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpO1xuICAgIGlmIChhcmlhKSBoaW50cy5wdXNoKGVsLnRhZ05hbWUudG9Mb3dlckNhc2UoKSArICdbYXJpYS1sYWJlbD1cIicgKyBDU1MuZXNjYXBlKGFyaWEpICsgJ1wiXScpO1xuICAgIHZhciBwbGFjZWhvbGRlciA9IGVsLmdldEF0dHJpYnV0ZShcInBsYWNlaG9sZGVyXCIpO1xuICAgIGlmIChwbGFjZWhvbGRlcikgaGludHMucHVzaChlbC50YWdOYW1lLnRvTG93ZXJDYXNlKCkgKyAnW3BsYWNlaG9sZGVyPVwiJyArIENTUy5lc2NhcGUocGxhY2Vob2xkZXIpICsgJ1wiXScpO1xuICAgIHZhciBjbHMgPSBBcnJheS5mcm9tKGVsLmNsYXNzTGlzdCkuc2xpY2UoMCwgMik7XG4gICAgaWYgKGNscy5sZW5ndGggPiAwKSBoaW50cy5wdXNoKGVsLnRhZ05hbWUudG9Mb3dlckNhc2UoKSArIFwiLlwiICsgY2xzLm1hcChmdW5jdGlvbihjKSB7IHJldHVybiBDU1MuZXNjYXBlKGMpOyB9KS5qb2luKFwiLlwiKSk7XG4gICAgaGludHMucHVzaChwaS5jc3NQYXRoKGVsKSk7XG4gICAgdmFyIHNlZW4gPSB7fTtcbiAgICB2YXIgdW5pcXVlID0gW107XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBoaW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgaWYgKCFzZWVuW2hpbnRzW2ldXSkge1xuICAgICAgICBzZWVuW2hpbnRzW2ldXSA9IHRydWU7XG4gICAgICAgIHVuaXF1ZS5wdXNoKGhpbnRzW2ldKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHVuaXF1ZS5zbGljZSgwLCA2KTtcbiAgfTtcbn0pKCk7YDtcbiJdLAogICJtYXBwaW5ncyI6ICJBQWlCTyxNQUFNLDBCQUEwQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBOyIsCiAgIm5hbWVzIjogW10KfQo=
