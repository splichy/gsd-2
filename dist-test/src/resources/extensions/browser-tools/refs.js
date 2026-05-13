import { getSnapshotModeConfig } from "./core.js";
async function buildRefSnapshot(target, options) {
  const modeConfig = options.mode ? getSnapshotModeConfig(options.mode) : null;
  return await target.evaluate(({ selector, interactiveOnly, limit, modeConfig: mc }) => {
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) {
      throw new Error(`Selector scope not found: ${selector}`);
    }
    const pi = window.__pi;
    const simpleHash = pi.simpleHash;
    const isVisible = pi.isVisible;
    const isEnabled = pi.isEnabled;
    const inferRole = pi.inferRole;
    const accessibleName = pi.accessibleName;
    const isInteractiveEl = pi.isInteractiveEl;
    const cssPath = pi.cssPath;
    const domPath = pi.domPath;
    const selectorHints = pi.selectorHints;
    const matchesMode = (el, cfg) => {
      const tag = el.tagName.toLowerCase();
      if (cfg.tags.length > 0 && cfg.tags.includes(tag)) return true;
      const role = inferRole(el);
      if (cfg.roles.length > 0 && cfg.roles.includes(role)) return true;
      for (const sel of cfg.selectors) {
        try {
          if (el.matches(sel)) return true;
        } catch {
        }
      }
      for (const attr of cfg.ariaAttributes) {
        if (el.hasAttribute(attr)) return true;
      }
      return false;
    };
    let elements = Array.from(root.querySelectorAll("*"));
    if (mc) {
      if (mc.visibleOnly) {
        elements = elements.filter((el) => isVisible(el));
      } else if (mc.useInteractiveFilter) {
        elements = elements.filter((el) => isInteractiveEl(el));
      } else if (mc.containerExpand) {
        const containers = [];
        const directMatches = [];
        for (const el of elements) {
          if (matchesMode(el, mc)) {
            const childEls = el.querySelectorAll("*");
            if (childEls.length > 0) {
              containers.push(el);
            } else {
              directMatches.push(el);
            }
          }
        }
        const result = new Set(directMatches);
        for (const container of containers) {
          result.add(container);
          const children = Array.from(container.querySelectorAll("*"));
          for (const child of children) {
            if (isInteractiveEl(child)) result.add(child);
          }
        }
        elements = Array.from(result);
      } else {
        elements = elements.filter((el) => matchesMode(el, mc));
      }
    } else if (!interactiveOnly) {
      if (root instanceof Element) elements.unshift(root);
    } else {
      elements = elements.filter((el) => isInteractiveEl(el));
    }
    const seen = /* @__PURE__ */ new Set();
    const unique = elements.filter((el) => {
      if (seen.has(el)) return false;
      seen.add(el);
      return true;
    });
    const computeNearestHeading = (el) => {
      const headingTags = /* @__PURE__ */ new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
      let current = el;
      while (current && current !== document.body) {
        let sib = current.previousElementSibling;
        while (sib) {
          if (headingTags.has(sib.tagName) || sib.getAttribute("role") === "heading") {
            return (sib.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
          }
          sib = sib.previousElementSibling;
        }
        const parent = current.parentElement;
        if (parent && (headingTags.has(parent.tagName) || parent.getAttribute("role") === "heading")) {
          return (parent.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
        }
        current = parent;
      }
      return "";
    };
    const computeFormOwnership = (el) => {
      const formAttr = el.getAttribute("form");
      if (formAttr) return formAttr;
      let current = el.parentElement;
      while (current && current !== document.body) {
        if (current.tagName === "FORM") {
          return current.id || current.name || "form";
        }
        current = current.parentElement;
      }
      return "";
    };
    return unique.slice(0, limit).map((el) => {
      const tag = el.tagName.toLowerCase();
      const role = inferRole(el);
      const textContent = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200);
      const childTags = Array.from(el.children).map((c) => c.tagName.toLowerCase());
      return {
        tag,
        role,
        name: accessibleName(el),
        selectorHints: selectorHints(el),
        isVisible: isVisible(el),
        isEnabled: isEnabled(el),
        xpathOrPath: cssPath(el),
        href: el.getAttribute("href") || void 0,
        type: el.getAttribute("type") || void 0,
        path: domPath(el),
        contentHash: simpleHash(textContent),
        structuralSignature: simpleHash(`${tag}|${role}|${childTags.join(",")}`),
        nearestHeading: computeNearestHeading(el),
        formOwnership: computeFormOwnership(el)
      };
    });
  }, { ...options, modeConfig });
}
async function resolveRefTarget(target, node) {
  return await target.evaluate((refNode) => {
    const pi = window.__pi;
    const cssPath = pi.cssPath;
    const simpleHash = pi.simpleHash;
    const byPath = () => {
      let current = document.documentElement;
      for (const idx of refNode.path || []) {
        if (!current || idx < 0 || idx >= current.children.length) return null;
        current = current.children[idx];
      }
      return current;
    };
    const nodeName = (el) => {
      return el.getAttribute("aria-label")?.trim() || el.value?.trim() || el.getAttribute("placeholder")?.trim() || (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
    };
    const pathEl = byPath();
    if (pathEl && pathEl.tagName.toLowerCase() === refNode.tag) {
      return { ok: true, selector: cssPath(pathEl) };
    }
    for (const hint of refNode.selectorHints || []) {
      try {
        const el = document.querySelector(hint);
        if (!el) continue;
        if (el.tagName.toLowerCase() !== refNode.tag) continue;
        return { ok: true, selector: cssPath(el) };
      } catch {
      }
    }
    const candidates = Array.from(document.querySelectorAll(refNode.tag));
    const matchTarget = candidates.find((el) => {
      const role = el.getAttribute("role") || "";
      const name = nodeName(el);
      const roleMatch = !refNode.role || role === refNode.role;
      const nameMatch = !!refNode.name && name.toLowerCase() === refNode.name.toLowerCase();
      return roleMatch && nameMatch;
    });
    if (matchTarget) {
      return { ok: true, selector: cssPath(matchTarget) };
    }
    if (refNode.contentHash && refNode.structuralSignature) {
      const fpMatches = [];
      for (const candidate of candidates) {
        const tag = candidate.tagName.toLowerCase();
        const role = candidate.getAttribute("role") || "";
        const textContent = (candidate.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200);
        const childTags = Array.from(candidate.children).map((c) => c.tagName.toLowerCase());
        const candidateContentHash = simpleHash(textContent);
        const candidateStructSig = simpleHash(`${tag}|${role}|${childTags.join(",")}`);
        if (candidateContentHash === refNode.contentHash && candidateStructSig === refNode.structuralSignature) {
          fpMatches.push(candidate);
        }
      }
      if (fpMatches.length === 1) {
        return { ok: true, selector: cssPath(fpMatches[0]) };
      }
      if (fpMatches.length > 1) {
        return { ok: false, reason: "multiple fingerprint matches \u2014 ambiguous" };
      }
    }
    return { ok: false, reason: "element not found in current DOM" };
  }, node);
}
export {
  buildRefSnapshot,
  resolveRefTarget
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvcmVmcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBicm93c2VyLXRvb2xzIFx1MjAxNCByZWYgc25hcHNob3QgYW5kIHJlc29sdXRpb25cbiAqXG4gKiBCdWlsZHMgZGV0ZXJtaW5pc3RpYyBlbGVtZW50IHNuYXBzaG90cyBhbmQgcmVzb2x2ZXMgcmVmIHRhcmdldHMuXG4gKiBVc2VzIHdpbmRvdy5fX3BpLiogdXRpbGl0aWVzIGluamVjdGVkIHZpYSBhZGRJbml0U2NyaXB0IChmcm9tXG4gKiBldmFsdWF0ZS1oZWxwZXJzLnRzKSBpbnN0ZWFkIG9mIHJlZGVjbGFyaW5nIGZ1bmN0aW9ucyBpbmxpbmUuXG4gKlxuICogRnVuY3Rpb25zIGtlcHQgaW5saW5lIChub3Qgc2hhcmVkL2R1cGxpY2F0ZWQpOlxuICogICAtIG1hdGNoZXNNb2RlLCBjb21wdXRlTmVhcmVzdEhlYWRpbmcsIGNvbXB1dGVGb3JtT3duZXJzaGlwXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBGcmFtZSwgUGFnZSB9IGZyb20gXCJwbGF5d3JpZ2h0XCI7XG5pbXBvcnQgdHlwZSB7IFJlZk5vZGUgfSBmcm9tIFwiLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHsgZ2V0U25hcHNob3RNb2RlQ29uZmlnIH0gZnJvbSBcIi4vY29yZS5qc1wiO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGJ1aWxkUmVmU25hcHNob3Rcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGRSZWZTbmFwc2hvdChcblx0dGFyZ2V0OiBQYWdlIHwgRnJhbWUsXG5cdG9wdGlvbnM6IHsgc2VsZWN0b3I/OiBzdHJpbmc7IGludGVyYWN0aXZlT25seTogYm9vbGVhbjsgbGltaXQ6IG51bWJlcjsgbW9kZT86IHN0cmluZyB9LFxuKTogUHJvbWlzZTxBcnJheTxPbWl0PFJlZk5vZGUsIFwicmVmXCI+Pj4ge1xuXHQvLyBSZXNvbHZlIG1vZGUgY29uZmlnIGluIE5vZGUgY29udGV4dCBhbmQgc2VyaWFsaXplIGl0IGFzIHBsYWluIGRhdGEgZm9yIHRoZSBldmFsdWF0ZSBjYWxsYmFja1xuXHRjb25zdCBtb2RlQ29uZmlnID0gb3B0aW9ucy5tb2RlID8gZ2V0U25hcHNob3RNb2RlQ29uZmlnKG9wdGlvbnMubW9kZSkgOiBudWxsO1xuXHRyZXR1cm4gYXdhaXQgdGFyZ2V0LmV2YWx1YXRlKCh7IHNlbGVjdG9yLCBpbnRlcmFjdGl2ZU9ubHksIGxpbWl0LCBtb2RlQ29uZmlnOiBtYyB9KSA9PiB7XG5cdFx0Y29uc3Qgcm9vdCA9IHNlbGVjdG9yID8gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWxlY3RvcikgOiBkb2N1bWVudC5ib2R5O1xuXHRcdGlmICghcm9vdCkge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGBTZWxlY3RvciBzY29wZSBub3QgZm91bmQ6ICR7c2VsZWN0b3J9YCk7XG5cdFx0fVxuXG5cdFx0Ly8gVXNlIGluamVjdGVkIHdpbmRvdy5fX3BpIHV0aWxpdGllc1xuXHRcdGNvbnN0IHBpID0gKHdpbmRvdyBhcyBhbnkpLl9fcGk7XG5cdFx0Y29uc3Qgc2ltcGxlSGFzaCA9IHBpLnNpbXBsZUhhc2g7XG5cdFx0Y29uc3QgaXNWaXNpYmxlID0gcGkuaXNWaXNpYmxlO1xuXHRcdGNvbnN0IGlzRW5hYmxlZCA9IHBpLmlzRW5hYmxlZDtcblx0XHRjb25zdCBpbmZlclJvbGUgPSBwaS5pbmZlclJvbGU7XG5cdFx0Y29uc3QgYWNjZXNzaWJsZU5hbWUgPSBwaS5hY2Nlc3NpYmxlTmFtZTtcblx0XHRjb25zdCBpc0ludGVyYWN0aXZlRWwgPSBwaS5pc0ludGVyYWN0aXZlRWw7XG5cdFx0Y29uc3QgY3NzUGF0aCA9IHBpLmNzc1BhdGg7XG5cdFx0Y29uc3QgZG9tUGF0aCA9IHBpLmRvbVBhdGg7XG5cdFx0Y29uc3Qgc2VsZWN0b3JIaW50cyA9IHBpLnNlbGVjdG9ySGludHM7XG5cblx0XHQvLyBNb2RlLWJhc2VkIGVsZW1lbnQgbWF0Y2hpbmcgXHUyMDE0IHVzZWQgd2hlbiBhIHNuYXBzaG90IG1vZGUgY29uZmlnIGlzIHByb3ZpZGVkXG5cdFx0Y29uc3QgbWF0Y2hlc01vZGUgPSAoZWw6IEVsZW1lbnQsIGNmZzogeyB0YWdzOiBzdHJpbmdbXTsgcm9sZXM6IHN0cmluZ1tdOyBzZWxlY3RvcnM6IHN0cmluZ1tdOyBhcmlhQXR0cmlidXRlczogc3RyaW5nW10gfSk6IGJvb2xlYW4gPT4ge1xuXHRcdFx0Y29uc3QgdGFnID0gZWwudGFnTmFtZS50b0xvd2VyQ2FzZSgpO1xuXHRcdFx0aWYgKGNmZy50YWdzLmxlbmd0aCA+IDAgJiYgY2ZnLnRhZ3MuaW5jbHVkZXModGFnKSkgcmV0dXJuIHRydWU7XG5cdFx0XHRjb25zdCByb2xlID0gaW5mZXJSb2xlKGVsKTtcblx0XHRcdGlmIChjZmcucm9sZXMubGVuZ3RoID4gMCAmJiBjZmcucm9sZXMuaW5jbHVkZXMocm9sZSkpIHJldHVybiB0cnVlO1xuXHRcdFx0Zm9yIChjb25zdCBzZWwgb2YgY2ZnLnNlbGVjdG9ycykge1xuXHRcdFx0XHR0cnkgeyBpZiAoZWwubWF0Y2hlcyhzZWwpKSByZXR1cm4gdHJ1ZTsgfSBjYXRjaCB7IC8qIGludmFsaWQgc2VsZWN0b3IsIHNraXAgKi8gfVxuXHRcdFx0fVxuXHRcdFx0Zm9yIChjb25zdCBhdHRyIG9mIGNmZy5hcmlhQXR0cmlidXRlcykge1xuXHRcdFx0XHRpZiAoZWwuaGFzQXR0cmlidXRlKGF0dHIpKSByZXR1cm4gdHJ1ZTtcblx0XHRcdH1cblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9O1xuXG5cdFx0bGV0IGVsZW1lbnRzID0gQXJyYXkuZnJvbShyb290LnF1ZXJ5U2VsZWN0b3JBbGwoXCIqXCIpKTtcblxuXHRcdGlmIChtYykge1xuXHRcdFx0Ly8gTW9kZSB0YWtlcyBwcmVjZWRlbmNlIG92ZXIgaW50ZXJhY3RpdmVPbmx5XG5cdFx0XHRpZiAobWMudmlzaWJsZU9ubHkpIHtcblx0XHRcdFx0Ly8gdmlzaWJsZV9vbmx5IG1vZGU6IGluY2x1ZGUgYWxsIGVsZW1lbnRzIHRoYXQgYXJlIHZpc2libGVcblx0XHRcdFx0ZWxlbWVudHMgPSBlbGVtZW50cy5maWx0ZXIoKGVsKSA9PiBpc1Zpc2libGUoZWwpKTtcblx0XHRcdH0gZWxzZSBpZiAobWMudXNlSW50ZXJhY3RpdmVGaWx0ZXIpIHtcblx0XHRcdFx0Ly8gaW50ZXJhY3RpdmUgbW9kZTogcmV1c2UgZXhpc3RpbmcgaXNJbnRlcmFjdGl2ZUVsXG5cdFx0XHRcdGVsZW1lbnRzID0gZWxlbWVudHMuZmlsdGVyKChlbCkgPT4gaXNJbnRlcmFjdGl2ZUVsKGVsKSk7XG5cdFx0XHR9IGVsc2UgaWYgKG1jLmNvbnRhaW5lckV4cGFuZCkge1xuXHRcdFx0XHQvLyBDb250YWluZXItZXhwYW5kaW5nIG1vZGVzIChkaWFsb2csIGVycm9ycyk6IG1hdGNoIGNvbnRhaW5lcnMsIHRoZW4gaW5jbHVkZVxuXHRcdFx0XHQvLyBhbGwgaW50ZXJhY3RpdmUgY2hpbGRyZW4gb2YgdGhvc2UgY29udGFpbmVycywgcGx1cyB0aGUgY29udGFpbmVycyB0aGVtc2VsdmVzXG5cdFx0XHRcdGNvbnN0IGNvbnRhaW5lcnM6IEVsZW1lbnRbXSA9IFtdO1xuXHRcdFx0XHRjb25zdCBkaXJlY3RNYXRjaGVzOiBFbGVtZW50W10gPSBbXTtcblx0XHRcdFx0Zm9yIChjb25zdCBlbCBvZiBlbGVtZW50cykge1xuXHRcdFx0XHRcdGlmIChtYXRjaGVzTW9kZShlbCwgbWMpKSB7XG5cdFx0XHRcdFx0XHQvLyBDaGVjayBpZiB0aGlzIGlzIGEgY29udGFpbmVyIGVsZW1lbnQgKGhhcyBjaGlsZHJlbilcblx0XHRcdFx0XHRcdGNvbnN0IGNoaWxkRWxzID0gZWwucXVlcnlTZWxlY3RvckFsbChcIipcIik7XG5cdFx0XHRcdFx0XHRpZiAoY2hpbGRFbHMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRcdFx0XHRjb250YWluZXJzLnB1c2goZWwpO1xuXHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0ZGlyZWN0TWF0Y2hlcy5wdXNoKGVsKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gQ29sbGVjdCBjb250YWluZXIgZWxlbWVudHMgKyBhbGwgaW50ZXJhY3RpdmUgY2hpbGRyZW4gaW5zaWRlIGNvbnRhaW5lcnNcblx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gbmV3IFNldDxFbGVtZW50PihkaXJlY3RNYXRjaGVzKTtcblx0XHRcdFx0Zm9yIChjb25zdCBjb250YWluZXIgb2YgY29udGFpbmVycykge1xuXHRcdFx0XHRcdHJlc3VsdC5hZGQoY29udGFpbmVyKTtcblx0XHRcdFx0XHRjb25zdCBjaGlsZHJlbiA9IEFycmF5LmZyb20oY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3JBbGwoXCIqXCIpKTtcblx0XHRcdFx0XHRmb3IgKGNvbnN0IGNoaWxkIG9mIGNoaWxkcmVuKSB7XG5cdFx0XHRcdFx0XHRpZiAoaXNJbnRlcmFjdGl2ZUVsKGNoaWxkKSkgcmVzdWx0LmFkZChjaGlsZCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdGVsZW1lbnRzID0gQXJyYXkuZnJvbShyZXN1bHQpO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Ly8gU3RhbmRhcmQgbW9kZSBmaWx0ZXJpbmcgYnkgdGFnL3JvbGUvc2VsZWN0b3IvYXJpYUF0dHJpYnV0ZVxuXHRcdFx0XHRlbGVtZW50cyA9IGVsZW1lbnRzLmZpbHRlcigoZWwpID0+IG1hdGNoZXNNb2RlKGVsLCBtYykpO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAoIWludGVyYWN0aXZlT25seSkge1xuXHRcdFx0aWYgKHJvb3QgaW5zdGFuY2VvZiBFbGVtZW50KSBlbGVtZW50cy51bnNoaWZ0KHJvb3QpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRlbGVtZW50cyA9IGVsZW1lbnRzLmZpbHRlcigoZWwpID0+IGlzSW50ZXJhY3RpdmVFbChlbCkpO1xuXHRcdH1cblxuXHRcdGNvbnN0IHNlZW4gPSBuZXcgU2V0PEVsZW1lbnQ+KCk7XG5cdFx0Y29uc3QgdW5pcXVlID0gZWxlbWVudHMuZmlsdGVyKChlbCkgPT4ge1xuXHRcdFx0aWYgKHNlZW4uaGFzKGVsKSkgcmV0dXJuIGZhbHNlO1xuXHRcdFx0c2Vlbi5hZGQoZWwpO1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fSk7XG5cblx0XHQvLyBGaW5nZXJwcmludCBoZWxwZXJzIFx1MjAxNCBjb21wdXRlZCBmb3IgZWFjaCBlbGVtZW50IGluIHRoZSBzbmFwc2hvdFxuXHRcdGNvbnN0IGNvbXB1dGVOZWFyZXN0SGVhZGluZyA9IChlbDogRWxlbWVudCk6IHN0cmluZyA9PiB7XG5cdFx0XHRjb25zdCBoZWFkaW5nVGFncyA9IG5ldyBTZXQoW1wiSDFcIiwgXCJIMlwiLCBcIkgzXCIsIFwiSDRcIiwgXCJINVwiLCBcIkg2XCJdKTtcblx0XHRcdC8vIFdhbGsgdXAgYW5jZXN0b3JzIGxvb2tpbmcgZm9yIGhlYWRpbmcgb3IgcHJlY2VkaW5nLXNpYmxpbmcgaGVhZGluZ1xuXHRcdFx0bGV0IGN1cnJlbnQ6IEVsZW1lbnQgfCBudWxsID0gZWw7XG5cdFx0XHR3aGlsZSAoY3VycmVudCAmJiBjdXJyZW50ICE9PSBkb2N1bWVudC5ib2R5KSB7XG5cdFx0XHRcdC8vIENoZWNrIHByZWNlZGluZyBzaWJsaW5ncyBvZiBjdXJyZW50XG5cdFx0XHRcdGxldCBzaWI6IEVsZW1lbnQgfCBudWxsID0gY3VycmVudC5wcmV2aW91c0VsZW1lbnRTaWJsaW5nO1xuXHRcdFx0XHR3aGlsZSAoc2liKSB7XG5cdFx0XHRcdFx0aWYgKGhlYWRpbmdUYWdzLmhhcyhzaWIudGFnTmFtZSkgfHwgc2liLmdldEF0dHJpYnV0ZShcInJvbGVcIikgPT09IFwiaGVhZGluZ1wiKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4gKHNpYi50ZXh0Q29udGVudCB8fCBcIlwiKS50cmltKCkucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikuc2xpY2UoMCwgODApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRzaWIgPSBzaWIucHJldmlvdXNFbGVtZW50U2libGluZztcblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBDaGVjayBpZiB0aGUgcGFyZW50IGl0c2VsZiBpcyBhIGhlYWRpbmcgKHVubGlrZWx5IGJ1dCBwb3NzaWJsZSlcblx0XHRcdFx0Y29uc3QgcGFyZW50OiBFbGVtZW50IHwgbnVsbCA9IGN1cnJlbnQucGFyZW50RWxlbWVudDtcblx0XHRcdFx0aWYgKHBhcmVudCAmJiAoaGVhZGluZ1RhZ3MuaGFzKHBhcmVudC50YWdOYW1lKSB8fCBwYXJlbnQuZ2V0QXR0cmlidXRlKFwicm9sZVwiKSA9PT0gXCJoZWFkaW5nXCIpKSB7XG5cdFx0XHRcdFx0cmV0dXJuIChwYXJlbnQudGV4dENvbnRlbnQgfHwgXCJcIikudHJpbSgpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnNsaWNlKDAsIDgwKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRjdXJyZW50ID0gcGFyZW50O1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIFwiXCI7XG5cdFx0fTtcblxuXHRcdGNvbnN0IGNvbXB1dGVGb3JtT3duZXJzaGlwID0gKGVsOiBFbGVtZW50KTogc3RyaW5nID0+IHtcblx0XHRcdC8vIENoZWNrIGZvcm0gYXR0cmlidXRlIChleHBsaWNpdCBmb3JtIGFzc29jaWF0aW9uKVxuXHRcdFx0Y29uc3QgZm9ybUF0dHIgPSBlbC5nZXRBdHRyaWJ1dGUoXCJmb3JtXCIpO1xuXHRcdFx0aWYgKGZvcm1BdHRyKSByZXR1cm4gZm9ybUF0dHI7XG5cdFx0XHQvLyBXYWxrIHVwIGFuY2VzdG9ycyBsb29raW5nIGZvciA8Zm9ybT5cblx0XHRcdGxldCBjdXJyZW50OiBFbGVtZW50IHwgbnVsbCA9IGVsLnBhcmVudEVsZW1lbnQ7XG5cdFx0XHR3aGlsZSAoY3VycmVudCAmJiBjdXJyZW50ICE9PSBkb2N1bWVudC5ib2R5KSB7XG5cdFx0XHRcdGlmIChjdXJyZW50LnRhZ05hbWUgPT09IFwiRk9STVwiKSB7XG5cdFx0XHRcdFx0cmV0dXJuIChjdXJyZW50IGFzIEhUTUxGb3JtRWxlbWVudCkuaWQgfHwgKGN1cnJlbnQgYXMgSFRNTEZvcm1FbGVtZW50KS5uYW1lIHx8IFwiZm9ybVwiO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGN1cnJlbnQgPSBjdXJyZW50LnBhcmVudEVsZW1lbnQ7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gXCJcIjtcblx0XHR9O1xuXG5cdFx0cmV0dXJuIHVuaXF1ZS5zbGljZSgwLCBsaW1pdCkubWFwKChlbCkgPT4ge1xuXHRcdFx0Y29uc3QgdGFnID0gZWwudGFnTmFtZS50b0xvd2VyQ2FzZSgpO1xuXHRcdFx0Y29uc3Qgcm9sZSA9IGluZmVyUm9sZShlbCk7XG5cdFx0XHRjb25zdCB0ZXh0Q29udGVudCA9IChlbC50ZXh0Q29udGVudCB8fCBcIlwiKS50cmltKCkucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikuc2xpY2UoMCwgMjAwKTtcblx0XHRcdGNvbnN0IGNoaWxkVGFncyA9IEFycmF5LmZyb20oZWwuY2hpbGRyZW4pLm1hcCgoYykgPT4gYy50YWdOYW1lLnRvTG93ZXJDYXNlKCkpO1xuXG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHR0YWcsXG5cdFx0XHRcdHJvbGUsXG5cdFx0XHRcdG5hbWU6IGFjY2Vzc2libGVOYW1lKGVsKSxcblx0XHRcdFx0c2VsZWN0b3JIaW50czogc2VsZWN0b3JIaW50cyhlbCksXG5cdFx0XHRcdGlzVmlzaWJsZTogaXNWaXNpYmxlKGVsKSxcblx0XHRcdFx0aXNFbmFibGVkOiBpc0VuYWJsZWQoZWwpLFxuXHRcdFx0XHR4cGF0aE9yUGF0aDogY3NzUGF0aChlbCksXG5cdFx0XHRcdGhyZWY6IGVsLmdldEF0dHJpYnV0ZShcImhyZWZcIikgfHwgdW5kZWZpbmVkLFxuXHRcdFx0XHR0eXBlOiBlbC5nZXRBdHRyaWJ1dGUoXCJ0eXBlXCIpIHx8IHVuZGVmaW5lZCxcblx0XHRcdFx0cGF0aDogZG9tUGF0aChlbCksXG5cdFx0XHRcdGNvbnRlbnRIYXNoOiBzaW1wbGVIYXNoKHRleHRDb250ZW50KSxcblx0XHRcdFx0c3RydWN0dXJhbFNpZ25hdHVyZTogc2ltcGxlSGFzaChgJHt0YWd9fCR7cm9sZX18JHtjaGlsZFRhZ3Muam9pbihcIixcIil9YCksXG5cdFx0XHRcdG5lYXJlc3RIZWFkaW5nOiBjb21wdXRlTmVhcmVzdEhlYWRpbmcoZWwpLFxuXHRcdFx0XHRmb3JtT3duZXJzaGlwOiBjb21wdXRlRm9ybU93bmVyc2hpcChlbCksXG5cdFx0XHR9O1xuXHRcdH0pO1xuXHR9LCB7IC4uLm9wdGlvbnMsIG1vZGVDb25maWcgfSk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gcmVzb2x2ZVJlZlRhcmdldFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXNvbHZlUmVmVGFyZ2V0KFxuXHR0YXJnZXQ6IFBhZ2UgfCBGcmFtZSxcblx0bm9kZTogUmVmTm9kZSxcbik6IFByb21pc2U8eyBvazogdHJ1ZTsgc2VsZWN0b3I6IHN0cmluZyB9IHwgeyBvazogZmFsc2U7IHJlYXNvbjogc3RyaW5nIH0+IHtcblx0cmV0dXJuIGF3YWl0IHRhcmdldC5ldmFsdWF0ZSgocmVmTm9kZSkgPT4ge1xuXHRcdC8vIFVzZSBpbmplY3RlZCB3aW5kb3cuX19waSB1dGlsaXRpZXNcblx0XHRjb25zdCBwaSA9ICh3aW5kb3cgYXMgYW55KS5fX3BpO1xuXHRcdGNvbnN0IGNzc1BhdGggPSBwaS5jc3NQYXRoO1xuXHRcdGNvbnN0IHNpbXBsZUhhc2ggPSBwaS5zaW1wbGVIYXNoO1xuXG5cdFx0Y29uc3QgYnlQYXRoID0gKCk6IEVsZW1lbnQgfCBudWxsID0+IHtcblx0XHRcdGxldCBjdXJyZW50OiBFbGVtZW50IHwgbnVsbCA9IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcblx0XHRcdGZvciAoY29uc3QgaWR4IG9mIHJlZk5vZGUucGF0aCB8fCBbXSkge1xuXHRcdFx0XHRpZiAoIWN1cnJlbnQgfHwgaWR4IDwgMCB8fCBpZHggPj0gY3VycmVudC5jaGlsZHJlbi5sZW5ndGgpIHJldHVybiBudWxsO1xuXHRcdFx0XHRjdXJyZW50ID0gY3VycmVudC5jaGlsZHJlbltpZHhdIGFzIEVsZW1lbnQ7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gY3VycmVudDtcblx0XHR9O1xuXG5cdFx0Y29uc3Qgbm9kZU5hbWUgPSAoZWw6IEVsZW1lbnQpOiBzdHJpbmcgPT4ge1xuXHRcdFx0cmV0dXJuIChcblx0XHRcdFx0ZWwuZ2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKT8udHJpbSgpIHx8XG5cdFx0XHRcdChlbCBhcyBIVE1MSW5wdXRFbGVtZW50KS52YWx1ZT8udHJpbSgpIHx8XG5cdFx0XHRcdGVsLmdldEF0dHJpYnV0ZShcInBsYWNlaG9sZGVyXCIpPy50cmltKCkgfHxcblx0XHRcdFx0KGVsLnRleHRDb250ZW50IHx8IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS5zbGljZSgwLCA4MClcblx0XHRcdCk7XG5cdFx0fTtcblxuXHRcdC8vIFRpZXIgMTogcGF0aC1iYXNlZCByZXNvbHV0aW9uXG5cdFx0Y29uc3QgcGF0aEVsID0gYnlQYXRoKCk7XG5cdFx0aWYgKHBhdGhFbCAmJiBwYXRoRWwudGFnTmFtZS50b0xvd2VyQ2FzZSgpID09PSByZWZOb2RlLnRhZykge1xuXHRcdFx0cmV0dXJuIHsgb2s6IHRydWUgYXMgY29uc3QsIHNlbGVjdG9yOiBjc3NQYXRoKHBhdGhFbCkgfTtcblx0XHR9XG5cblx0XHQvLyBUaWVyIDI6IHNlbGVjdG9yIGhpbnRzXG5cdFx0Zm9yIChjb25zdCBoaW50IG9mIHJlZk5vZGUuc2VsZWN0b3JIaW50cyB8fCBbXSkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgZWwgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKGhpbnQpO1xuXHRcdFx0XHRpZiAoIWVsKSBjb250aW51ZTtcblx0XHRcdFx0aWYgKGVsLnRhZ05hbWUudG9Mb3dlckNhc2UoKSAhPT0gcmVmTm9kZS50YWcpIGNvbnRpbnVlO1xuXHRcdFx0XHRyZXR1cm4geyBvazogdHJ1ZSBhcyBjb25zdCwgc2VsZWN0b3I6IGNzc1BhdGgoZWwpIH07XG5cdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0Ly8gaWdub3JlIG1hbGZvcm1lZCBzZWxlY3RvciBoaW50XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gVGllciAzOiByb2xlICsgbmFtZSBtYXRjaFxuXHRcdGNvbnN0IGNhbmRpZGF0ZXMgPSBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwocmVmTm9kZS50YWcpKTtcblx0XHRjb25zdCBtYXRjaFRhcmdldCA9IGNhbmRpZGF0ZXMuZmluZCgoZWwpID0+IHtcblx0XHRcdGNvbnN0IHJvbGUgPSBlbC5nZXRBdHRyaWJ1dGUoXCJyb2xlXCIpIHx8IFwiXCI7XG5cdFx0XHRjb25zdCBuYW1lID0gbm9kZU5hbWUoZWwpO1xuXHRcdFx0Y29uc3Qgcm9sZU1hdGNoID0gIXJlZk5vZGUucm9sZSB8fCByb2xlID09PSByZWZOb2RlLnJvbGU7XG5cdFx0XHRjb25zdCBuYW1lTWF0Y2ggPSAhIXJlZk5vZGUubmFtZSAmJiBuYW1lLnRvTG93ZXJDYXNlKCkgPT09IHJlZk5vZGUubmFtZS50b0xvd2VyQ2FzZSgpO1xuXHRcdFx0cmV0dXJuIHJvbGVNYXRjaCAmJiBuYW1lTWF0Y2g7XG5cdFx0fSk7XG5cdFx0aWYgKG1hdGNoVGFyZ2V0KSB7XG5cdFx0XHRyZXR1cm4geyBvazogdHJ1ZSBhcyBjb25zdCwgc2VsZWN0b3I6IGNzc1BhdGgobWF0Y2hUYXJnZXQpIH07XG5cdFx0fVxuXG5cdFx0Ly8gVGllciA0OiBzdHJ1Y3R1cmFsIHNpZ25hdHVyZSArIGNvbnRlbnQgaGFzaCBmaW5nZXJwcmludCBtYXRjaGluZ1xuXHRcdGlmIChyZWZOb2RlLmNvbnRlbnRIYXNoICYmIHJlZk5vZGUuc3RydWN0dXJhbFNpZ25hdHVyZSkge1xuXHRcdFx0Y29uc3QgZnBNYXRjaGVzOiBFbGVtZW50W10gPSBbXTtcblx0XHRcdGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGNhbmRpZGF0ZXMpIHtcblx0XHRcdFx0Y29uc3QgdGFnID0gY2FuZGlkYXRlLnRhZ05hbWUudG9Mb3dlckNhc2UoKTtcblx0XHRcdFx0Y29uc3Qgcm9sZSA9IGNhbmRpZGF0ZS5nZXRBdHRyaWJ1dGUoXCJyb2xlXCIpIHx8IFwiXCI7XG5cdFx0XHRcdGNvbnN0IHRleHRDb250ZW50ID0gKGNhbmRpZGF0ZS50ZXh0Q29udGVudCB8fCBcIlwiKS50cmltKCkucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikuc2xpY2UoMCwgMjAwKTtcblx0XHRcdFx0Y29uc3QgY2hpbGRUYWdzID0gQXJyYXkuZnJvbShjYW5kaWRhdGUuY2hpbGRyZW4pLm1hcCgoYykgPT4gYy50YWdOYW1lLnRvTG93ZXJDYXNlKCkpO1xuXHRcdFx0XHRjb25zdCBjYW5kaWRhdGVDb250ZW50SGFzaCA9IHNpbXBsZUhhc2godGV4dENvbnRlbnQpO1xuXHRcdFx0XHRjb25zdCBjYW5kaWRhdGVTdHJ1Y3RTaWcgPSBzaW1wbGVIYXNoKGAke3RhZ318JHtyb2xlfXwke2NoaWxkVGFncy5qb2luKFwiLFwiKX1gKTtcblx0XHRcdFx0aWYgKGNhbmRpZGF0ZUNvbnRlbnRIYXNoID09PSByZWZOb2RlLmNvbnRlbnRIYXNoICYmIGNhbmRpZGF0ZVN0cnVjdFNpZyA9PT0gcmVmTm9kZS5zdHJ1Y3R1cmFsU2lnbmF0dXJlKSB7XG5cdFx0XHRcdFx0ZnBNYXRjaGVzLnB1c2goY2FuZGlkYXRlKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0aWYgKGZwTWF0Y2hlcy5sZW5ndGggPT09IDEpIHtcblx0XHRcdFx0cmV0dXJuIHsgb2s6IHRydWUgYXMgY29uc3QsIHNlbGVjdG9yOiBjc3NQYXRoKGZwTWF0Y2hlc1swXSkgfTtcblx0XHRcdH1cblx0XHRcdGlmIChmcE1hdGNoZXMubGVuZ3RoID4gMSkge1xuXHRcdFx0XHRyZXR1cm4geyBvazogZmFsc2UgYXMgY29uc3QsIHJlYXNvbjogXCJtdWx0aXBsZSBmaW5nZXJwcmludCBtYXRjaGVzIFx1MjAxNCBhbWJpZ3VvdXNcIiB9O1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHJldHVybiB7IG9rOiBmYWxzZSBhcyBjb25zdCwgcmVhc29uOiBcImVsZW1lbnQgbm90IGZvdW5kIGluIGN1cnJlbnQgRE9NXCIgfTtcblx0fSwgbm9kZSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFhQSxTQUFTLDZCQUE2QjtBQU10QyxlQUFzQixpQkFDckIsUUFDQSxTQUN1QztBQUV2QyxRQUFNLGFBQWEsUUFBUSxPQUFPLHNCQUFzQixRQUFRLElBQUksSUFBSTtBQUN4RSxTQUFPLE1BQU0sT0FBTyxTQUFTLENBQUMsRUFBRSxVQUFVLGlCQUFpQixPQUFPLFlBQVksR0FBRyxNQUFNO0FBQ3RGLFVBQU0sT0FBTyxXQUFXLFNBQVMsY0FBYyxRQUFRLElBQUksU0FBUztBQUNwRSxRQUFJLENBQUMsTUFBTTtBQUNWLFlBQU0sSUFBSSxNQUFNLDZCQUE2QixRQUFRLEVBQUU7QUFBQSxJQUN4RDtBQUdBLFVBQU0sS0FBTSxPQUFlO0FBQzNCLFVBQU0sYUFBYSxHQUFHO0FBQ3RCLFVBQU0sWUFBWSxHQUFHO0FBQ3JCLFVBQU0sWUFBWSxHQUFHO0FBQ3JCLFVBQU0sWUFBWSxHQUFHO0FBQ3JCLFVBQU0saUJBQWlCLEdBQUc7QUFDMUIsVUFBTSxrQkFBa0IsR0FBRztBQUMzQixVQUFNLFVBQVUsR0FBRztBQUNuQixVQUFNLFVBQVUsR0FBRztBQUNuQixVQUFNLGdCQUFnQixHQUFHO0FBR3pCLFVBQU0sY0FBYyxDQUFDLElBQWEsUUFBcUc7QUFD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
