import { splitFrontmatter, parseFrontmatterMap, extractBoldField } from "../files.js";
import { normalizeStringArray } from "../../shared/format-utils.js";
function extractXmlTag(content, tagName) {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = regex.exec(content);
  return match ? match[1].trim() : "";
}
function extractTasks(content) {
  const tasksBlock = extractXmlTag(content, "tasks");
  if (!tasksBlock) return [];
  const tasks = [];
  const regex = /<task>([\s\S]*?)<\/task>/gi;
  let match;
  while ((match = regex.exec(tasksBlock)) !== null) {
    const trimmed = match[1].trim();
    if (trimmed) tasks.push(trimmed);
  }
  return tasks;
}
function parsePhaseEntry(line) {
  const stripped = line.replace(/\*\*/g, "");
  const fmtPhaseColon = stripped.match(/^-\s+\[([ xX])\]\s+(?:Phase\s+)?(\d+(?:\.\d+)?)\s*:\s*(.+)$/);
  if (fmtPhaseColon) {
    let title = fmtPhaseColon[3].trim();
    title = title.replace(/\s*\(\d+\/\d+\s+plans?\)/, "").replace(/\s*--\s+.*$/, "").replace(/\s*-\s+.*$/, "").replace(/\s*\(completed.*\)$/i, "").replace(/\s*\(shipped.*\)$/i, "").trim();
    return {
      number: parseFloat(fmtPhaseColon[2]),
      title,
      done: fmtPhaseColon[1].toLowerCase() === "x",
      raw: line
    };
  }
  const fmtDash = stripped.match(/^-\s+\[([ xX])\]\s+(?:Phase\s+)?(\d+(?:\.\d+)?)\s*[—–]\s*(.+)$/);
  if (fmtDash) {
    let title = fmtDash[3].trim();
    title = title.replace(/\s*\(\d+\/\d+\s+plans?\)/, "").replace(/\s*--\s+.*$/, "").trim();
    return {
      number: parseFloat(fmtDash[2]),
      title,
      done: fmtDash[1].toLowerCase() === "x",
      raw: line
    };
  }
  const fmtVersionPhases = stripped.match(/^-\s+([✅🚧])\s+v\d+(?:\.\d+)*\s+(.+?)\s*[—–]\s*Phases?\s+(\d+(?:\.\d+)?)(?:\s*-\s*\d+(?:\.\d+)?)?(?:\s+\(.*\))?\s*$/iu);
  if (fmtVersionPhases) {
    return {
      number: parseFloat(fmtVersionPhases[3]),
      title: fmtVersionPhases[2].trim(),
      done: fmtVersionPhases[1] === "\u2705",
      raw: line
    };
  }
  return null;
}
function parseOldRoadmap(content) {
  const result = {
    raw: content,
    milestones: [],
    phases: []
  };
  const lines = content.split("\n");
  const detailsMilestones = parseDetailsBlockMilestones(lines);
  if (detailsMilestones.length > 0) {
    result.milestones = detailsMilestones;
    for (let i = 0; i < lines.length; i++) {
      const heading = lines[i].match(/^###\s+(v[\d.]+)\s+(.+?)(?:\s*\(.*\))?\s*$/);
      if (heading) {
        const id = heading[1];
        if (result.milestones.some((m) => m.id === id)) continue;
        const phases = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (/^##?\s/.test(lines[j]) || /^###\s/.test(lines[j])) break;
          const entry = parsePhaseEntry(lines[j].trim());
          if (entry) phases.push(entry);
        }
        result.milestones.push({
          id,
          title: heading[2].trim(),
          collapsed: false,
          phases
        });
      }
    }
    return result;
  }
  const milestoneHeadingRegex = /^##\s+(.+)$/;
  const milestoneHeadings = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(milestoneHeadingRegex);
    if (match) {
      const heading = match[1].trim();
      if (/^(phases?|milestones?|phase\s+details?|progress)$/i.test(heading)) continue;
      const idMatch = heading.match(/^(v[\d.]+|[\w.-]+)\s*[—–-]\s*(.+)$/);
      if (idMatch) {
        milestoneHeadings.push({ index: i, id: idMatch[1], title: idMatch[2].trim() });
      }
    }
  }
  if (milestoneHeadings.length > 0) {
    for (let m = 0; m < milestoneHeadings.length; m++) {
      const startIdx = milestoneHeadings[m].index + 1;
      const endIdx = m + 1 < milestoneHeadings.length ? milestoneHeadings[m + 1].index : lines.length;
      const sectionLines = lines.slice(startIdx, endIdx);
      const milestone = {
        id: milestoneHeadings[m].id,
        title: milestoneHeadings[m].title,
        collapsed: false,
        phases: []
      };
      const sectionText = sectionLines.join("\n");
      if (sectionText.includes("<details>")) {
        milestone.collapsed = true;
      }
      for (const line of sectionLines) {
        const entry = parsePhaseEntry(line.trim());
        if (entry) {
          milestone.phases.push(entry);
        }
      }
      result.milestones.push(milestone);
    }
  } else {
    for (const line of lines) {
      const entry = parsePhaseEntry(line.trim());
      if (entry) {
        result.phases.push(entry);
      }
    }
  }
  return result;
}
function parseDetailsBlockMilestones(lines) {
  const milestones = [];
  let inDetails = false;
  let currentMilestone = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "<details>") {
      inDetails = true;
      continue;
    }
    if (inDetails && !currentMilestone) {
      const summaryMatch = trimmed.match(/<summary>\s*(v[\d.]+)\s+(.+?)\s*(?:\(.*\))?\s*(?:--\s*.*)?\s*<\/summary>/);
      if (summaryMatch) {
        currentMilestone = {
          id: summaryMatch[1],
          title: summaryMatch[2].trim(),
          collapsed: true,
          phases: []
        };
      }
      continue;
    }
    if (trimmed === "</details>") {
      if (currentMilestone) {
        milestones.push(currentMilestone);
        currentMilestone = null;
      }
      inDetails = false;
      continue;
    }
    if (currentMilestone) {
      const entry = parsePhaseEntry(trimmed);
      if (entry) {
        currentMilestone.phases.push(entry);
      }
    }
  }
  return milestones;
}
function unquote(val) {
  const s = String(val ?? "");
  if (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  return s;
}
function parseMustHavesFromLines(fmLines) {
  const start = fmLines.findIndex((l) => /^must_haves\s*:/.test(l));
  if (start === -1) return null;
  const truths = [];
  const artifacts = [];
  const keyLinks = [];
  let currentList = null;
  for (let i = start + 1; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (/^\w/.test(line)) break;
    const subKey = line.match(/^  (\w[\w_]*):/);
    if (subKey) {
      const key = subKey[1];
      if (key === "truths") currentList = truths;
      else if (key === "artifacts") currentList = artifacts;
      else if (key === "key_links") currentList = keyLinks;
      else currentList = null;
      if (/:\s*\[\]/.test(line)) currentList = null;
      continue;
    }
    const item = line.match(/^    - (.+)$/);
    if (item && currentList) {
      currentList.push(item[1].trim());
    }
  }
  if (truths.length === 0 && artifacts.length === 0 && keyLinks.length === 0) return null;
  return { truths, artifacts, key_links: keyLinks };
}
function parsePlanFrontmatter(fm, fmLines) {
  const mustHaves = fmLines ? parseMustHavesFromLines(fmLines) : null;
  return {
    phase: unquote(fm.phase),
    plan: unquote(fm.plan),
    type: unquote(fm.type),
    wave: fm.wave !== void 0 ? Number(fm.wave) : null,
    depends_on: Array.isArray(fm.depends_on) ? fm.depends_on.map((s) => unquote(s)) : [],
    files_modified: Array.isArray(fm.files_modified) ? fm.files_modified.map((s) => unquote(s)) : [],
    autonomous: fm.autonomous === "true" || fm.autonomous === true,
    must_haves: mustHaves
  };
}
function parseOldPlan(content, fileName = "", planNumber = "") {
  const [fmLines, body] = splitFrontmatter(content);
  const fm = fmLines ? parseFrontmatterMap(fmLines) : {};
  const frontmatter = parsePlanFrontmatter(fm, fmLines);
  const objective = extractXmlTag(content, "objective");
  const tasks = extractTasks(content);
  const context = extractXmlTag(content, "context");
  const verification = extractXmlTag(content, "verification");
  const successCriteria = extractXmlTag(content, "success_criteria");
  return {
    fileName,
    planNumber: planNumber || String(fm.plan ?? ""),
    frontmatter,
    objective,
    tasks,
    context,
    verification,
    successCriteria,
    raw: content
  };
}
function parseRequiresArray(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === "object" && item !== null) {
      const obj = item;
      return { phase: obj.phase ?? "", provides: obj.provides ?? "" };
    }
    return { phase: "", provides: String(item) };
  });
}
function parseSummaryFrontmatter(fm) {
  return {
    phase: unquote(fm.phase),
    plan: unquote(fm.plan),
    subsystem: unquote(fm.subsystem),
    tags: normalizeStringArray(fm.tags),
    requires: parseRequiresArray(fm.requires),
    provides: normalizeStringArray(fm.provides),
    affects: normalizeStringArray(fm.affects),
    "tech-stack": normalizeStringArray(fm["tech-stack"]),
    "key-files": normalizeStringArray(fm["key-files"]),
    "key-decisions": normalizeStringArray(fm["key-decisions"]),
    "patterns-established": normalizeStringArray(fm["patterns-established"]),
    duration: unquote(fm.duration),
    completed: unquote(fm.completed)
  };
}
function parseOldSummary(content, fileName = "", planNumber = "") {
  const [fmLines, body] = splitFrontmatter(content);
  const fm = fmLines ? parseFrontmatterMap(fmLines) : {};
  return {
    fileName,
    planNumber: planNumber || String(fm.plan ?? ""),
    frontmatter: parseSummaryFrontmatter(fm),
    body,
    raw: content
  };
}
function parseOldRequirements(content) {
  const requirements = [];
  const lines = content.split("\n");
  let currentStatus = "";
  let currentReq = null;
  let currentRaw = [];
  function flushReq() {
    if (currentReq?.id && currentReq?.title) {
      requirements.push({
        id: currentReq.id,
        title: currentReq.title,
        status: currentReq.status || currentStatus || "unknown",
        description: currentReq.description || "",
        raw: currentRaw.join("\n").trim()
      });
    }
    currentReq = null;
    currentRaw = [];
  }
  for (const line of lines) {
    const statusMatch = line.match(/^##\s+(\w[\w\s&]*\w)\s*$/);
    if (statusMatch) {
      flushReq();
      currentStatus = statusMatch[1].toLowerCase();
      continue;
    }
    const sectionMatch = line.match(/^###\s+(.+)$/);
    if (sectionMatch) {
      const reqHeading = sectionMatch[1].match(/^(R\d+)\s*[—–-]\s*(.+)$/);
      if (reqHeading) {
        flushReq();
        currentReq = { id: reqHeading[1], title: reqHeading[2].trim(), status: currentStatus, description: "" };
        currentRaw.push(line);
        continue;
      }
      flushReq();
      continue;
    }
    const bulletReqMatch = line.match(/^-\s+\[([ xX])\]\s+\*\*([^*]+)\*\*\s*:\s*(.+)$/);
    if (bulletReqMatch) {
      flushReq();
      const done = bulletReqMatch[1].toLowerCase() === "x";
      const id = bulletReqMatch[2].trim();
      const desc = bulletReqMatch[3].trim();
      requirements.push({
        id,
        title: desc,
        status: done ? "complete" : currentStatus || "active",
        description: desc,
        raw: line
      });
      continue;
    }
    if (currentReq) {
      currentRaw.push(line);
      const descMatch = line.match(/^-\s+Description:\s*(.+)$/);
      if (descMatch) {
        currentReq.description = descMatch[1].trim();
        continue;
      }
      const statMatch = line.match(/^-\s+Status:\s*(.+)$/);
      if (statMatch) {
        currentReq.status = statMatch[1].trim();
      }
    }
  }
  flushReq();
  return requirements;
}
function parseOldProject(content) {
  return content;
}
function parseOldState(content) {
  const currentPhase = extractBoldField(content, "Current Phase");
  const status = extractBoldField(content, "Status");
  return {
    raw: content,
    currentPhase,
    status
  };
}
function parseOldConfig(content) {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}
export {
  parseOldConfig,
  parseOldPlan,
  parseOldProject,
  parseOldRequirements,
  parseOldRoadmap,
  parseOldState,
  parseOldSummary
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9taWdyYXRlL3BhcnNlcnMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIE9sZCAucGxhbm5pbmcgZm9ybWF0IHBlci1maWxlIHBhcnNlcnNcbi8vIFB1cmUgZnVuY3Rpb25zIHRoYXQgdGFrZSBmaWxlIGNvbnRlbnQgKHN0cmluZykgYW5kIHJldHVybiB0eXBlZCBkYXRhLlxuLy8gWmVybyBQaSBkZXBlbmRlbmNpZXMgXHUyMDE0IHVzZXMgb25seSBleHBvcnRlZCBoZWxwZXJzIGZyb20gZmlsZXMudHMuXG5cbmltcG9ydCB7IHNwbGl0RnJvbnRtYXR0ZXIsIHBhcnNlRnJvbnRtYXR0ZXJNYXAsIGV4dHJhY3RCb2xkRmllbGQgfSBmcm9tICcuLi9maWxlcy5qcyc7XG5pbXBvcnQgeyBub3JtYWxpemVTdHJpbmdBcnJheSB9IGZyb20gJy4uLy4uL3NoYXJlZC9mb3JtYXQtdXRpbHMuanMnO1xuXG5pbXBvcnQgdHlwZSB7XG4gIFBsYW5uaW5nUm9hZG1hcCxcbiAgUGxhbm5pbmdSb2FkbWFwTWlsZXN0b25lLFxuICBQbGFubmluZ1JvYWRtYXBFbnRyeSxcbiAgUGxhbm5pbmdQbGFuLFxuICBQbGFubmluZ1BsYW5Gcm9udG1hdHRlcixcbiAgUGxhbm5pbmdQbGFuTXVzdEhhdmVzLFxuICBQbGFubmluZ1N1bW1hcnksXG4gIFBsYW5uaW5nU3VtbWFyeUZyb250bWF0dGVyLFxuICBQbGFubmluZ1N1bW1hcnlSZXF1aXJlcyxcbiAgUGxhbm5pbmdSZXF1aXJlbWVudCxcbiAgUGxhbm5pbmdTdGF0ZSxcbiAgUGxhbm5pbmdDb25maWcsXG59IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyBSZS1leHBvcnQgUGxhbm5pbmdQcm9qZWN0TWV0YSBcdTIwMTQgbm90IGluIHR5cGVzLnRzIHlldCwgdXNlIHN0cmluZyBmb3IgcHJvamVjdCBmaWVsZFxuLy8gQWN0dWFsbHkgUGxhbm5pbmdQcm9qZWN0TWV0YSBpc24ndCBpbiB0eXBlcy50cyBcdTIwMTQgcHJvamVjdCBpcyBzdG9yZWQgYXMgc3RyaW5nIHwgbnVsbC5cbi8vIFdlJ2xsIGtlZXAgcGFyc2VPbGRQcm9qZWN0IHJldHVybmluZyBhIHNpbXBsZSBzaGFwZS5cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFhNTC1pbi1NYXJrZG93biBFeHRyYWN0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEV4dHJhY3QgY29udGVudCBiZXR3ZWVuIFhNTC1saWtlIHRhZ3MgaW4gbWFya2Rvd24uXG4gKiBOT1QgYSByZWFsIFhNTCBwYXJzZXIgXHUyMDE0IGhhbmRsZXMgYDx0YWc+Y29udGVudDwvdGFnPmAgd2l0aCBtYXJrZG93biBpbnNpZGUuXG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RYbWxUYWcoY29udGVudDogc3RyaW5nLCB0YWdOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCByZWdleCA9IG5ldyBSZWdFeHAoYDwke3RhZ05hbWV9PihbXFxcXHNcXFxcU10qPyk8XFxcXC8ke3RhZ05hbWV9PmAsICdpJyk7XG4gIGNvbnN0IG1hdGNoID0gcmVnZXguZXhlYyhjb250ZW50KTtcbiAgcmV0dXJuIG1hdGNoID8gbWF0Y2hbMV0udHJpbSgpIDogJyc7XG59XG5cbi8qKlxuICogRXh0cmFjdCBhbGwgbmVzdGVkIGA8dGFzaz5gIGVudHJpZXMgZnJvbSB3aXRoaW4gYSBgPHRhc2tzPmAgYmxvY2suXG4gKi9cbmZ1bmN0aW9uIGV4dHJhY3RUYXNrcyhjb250ZW50OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHRhc2tzQmxvY2sgPSBleHRyYWN0WG1sVGFnKGNvbnRlbnQsICd0YXNrcycpO1xuICBpZiAoIXRhc2tzQmxvY2spIHJldHVybiBbXTtcblxuICBjb25zdCB0YXNrczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgcmVnZXggPSAvPHRhc2s+KFtcXHNcXFNdKj8pPFxcL3Rhc2s+L2dpO1xuICBsZXQgbWF0Y2g6IFJlZ0V4cEV4ZWNBcnJheSB8IG51bGw7XG4gIHdoaWxlICgobWF0Y2ggPSByZWdleC5leGVjKHRhc2tzQmxvY2spKSAhPT0gbnVsbCkge1xuICAgIGNvbnN0IHRyaW1tZWQgPSBtYXRjaFsxXS50cmltKCk7XG4gICAgaWYgKHRyaW1tZWQpIHRhc2tzLnB1c2godHJpbW1lZCk7XG4gIH1cbiAgcmV0dXJuIHRhc2tzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUm9hZG1hcCBQYXJzZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBQYXJzZSBhIGNoZWNrYm94IHBoYXNlIGVudHJ5IGxpbmU6IGAtIFt4XSAyOSBcdTIwMTQgQXV0aCBTeXN0ZW1gICovXG5mdW5jdGlvbiBwYXJzZVBoYXNlRW50cnkobGluZTogc3RyaW5nKTogUGxhbm5pbmdSb2FkbWFwRW50cnkgfCBudWxsIHtcbiAgLy8gU3RyaXAgYm9sZCBtYXJrZXJzICgqKikgZm9yIHVuaWZvcm0gbWF0Y2hpbmcgXHUyMDE0IG9sZCByb2FkbWFwcyBvZnRlbiBib2xkIHBoYXNlIGVudHJpZXNcbiAgY29uc3Qgc3RyaXBwZWQgPSBsaW5lLnJlcGxhY2UoL1xcKlxcKi9nLCAnJyk7XG5cbiAgLy8gRm9ybWF0IDE6IC0gW3hdIFBoYXNlIDI1OiBUaXRsZSAoTi9OIHBsYW5zKSAtLSBjb21wbGV0ZWQgLi4uXG4gIC8vIEFsc28gaGFuZGxlczogLSBbeF0gUGhhc2UgMjU6IFRpdGxlIC0gRGVzY3JpcHRpb24gKGNvbXBsZXRlZCAuLi4pXG4gIGNvbnN0IGZtdFBoYXNlQ29sb24gPSBzdHJpcHBlZC5tYXRjaCgvXi1cXHMrXFxbKFsgeFhdKVxcXVxccysoPzpQaGFzZVxccyspPyhcXGQrKD86XFwuXFxkKyk/KVxccyo6XFxzKiguKykkLyk7XG4gIGlmIChmbXRQaGFzZUNvbG9uKSB7XG4gICAgbGV0IHRpdGxlID0gZm10UGhhc2VDb2xvblszXS50cmltKCk7XG4gICAgLy8gU3RyaXAgdHJhaWxpbmcgcGFyZW50aGV0aWNhbHMsIHBsYW4gY291bnRzLCBhbmQgY29tcGxldGlvbiBub3Rlc1xuICAgIHRpdGxlID0gdGl0bGUucmVwbGFjZSgvXFxzKlxcKFxcZCtcXC9cXGQrXFxzK3BsYW5zP1xcKS8sICcnKVxuICAgICAgICAgICAgICAgICAucmVwbGFjZSgvXFxzKi0tXFxzKy4qJC8sICcnKVxuICAgICAgICAgICAgICAgICAucmVwbGFjZSgvXFxzKi1cXHMrLiokLywgJycpICAvLyBzdHJpcCBcIi0gZGVzY3JpcHRpb25cIiBzdWZmaXhcbiAgICAgICAgICAgICAgICAgLnJlcGxhY2UoL1xccypcXChjb21wbGV0ZWQuKlxcKSQvaSwgJycpXG4gICAgICAgICAgICAgICAgIC5yZXBsYWNlKC9cXHMqXFwoc2hpcHBlZC4qXFwpJC9pLCAnJylcbiAgICAgICAgICAgICAgICAgLnRyaW0oKTtcbiAgICByZXR1cm4ge1xuICAgICAgbnVtYmVyOiBwYXJzZUZsb2F0KGZtdFBoYXNlQ29sb25bMl0pLFxuICAgICAgdGl0bGUsXG4gICAgICBkb25lOiBmbXRQaGFzZUNvbG9uWzFdLnRvTG93ZXJDYXNlKCkgPT09ICd4JyxcbiAgICAgIHJhdzogbGluZSxcbiAgICB9O1xuICB9XG5cbiAgLy8gRm9ybWF0IDI6IC0gW3hdIDI1IFx1MjAxNCBUaXRsZSAoZW0tZGFzaC9lbi1kYXNoIG9ubHkgXHUyMDE0IE5PVCBwbGFpbiBoeXBoZW4gdG8gYXZvaWQgcGxhbiBmaWxlIHJlZnMpXG4gIGNvbnN0IGZtdERhc2ggPSBzdHJpcHBlZC5tYXRjaCgvXi1cXHMrXFxbKFsgeFhdKVxcXVxccysoPzpQaGFzZVxccyspPyhcXGQrKD86XFwuXFxkKyk/KVxccypbXHUyMDE0XHUyMDEzXVxccyooLispJC8pO1xuICBpZiAoZm10RGFzaCkge1xuICAgIGxldCB0aXRsZSA9IGZtdERhc2hbM10udHJpbSgpO1xuICAgIHRpdGxlID0gdGl0bGUucmVwbGFjZSgvXFxzKlxcKFxcZCtcXC9cXGQrXFxzK3BsYW5zP1xcKS8sICcnKVxuICAgICAgICAgICAgICAgICAucmVwbGFjZSgvXFxzKi0tXFxzKy4qJC8sICcnKVxuICAgICAgICAgICAgICAgICAudHJpbSgpO1xuICAgIHJldHVybiB7XG4gICAgICBudW1iZXI6IHBhcnNlRmxvYXQoZm10RGFzaFsyXSksXG4gICAgICB0aXRsZSxcbiAgICAgIGRvbmU6IGZtdERhc2hbMV0udG9Mb3dlckNhc2UoKSA9PT0gJ3gnLFxuICAgICAgcmF3OiBsaW5lLFxuICAgIH07XG4gIH1cblxuICAvLyBGb3JtYXQgMzogLSBcdTI3MDUgdjEuMCBNVlAgXHUyMDE0IFBoYXNlcyAxLTZcbiAgY29uc3QgZm10VmVyc2lvblBoYXNlcyA9IHN0cmlwcGVkLm1hdGNoKC9eLVxccysoW1x1MjcwNVx1RDgzRFx1REVBN10pXFxzK3ZcXGQrKD86XFwuXFxkKykqXFxzKyguKz8pXFxzKltcdTIwMTRcdTIwMTNdXFxzKlBoYXNlcz9cXHMrKFxcZCsoPzpcXC5cXGQrKT8pKD86XFxzKi1cXHMqXFxkKyg/OlxcLlxcZCspPyk/KD86XFxzK1xcKC4qXFwpKT9cXHMqJC9pdSk7XG4gIGlmIChmbXRWZXJzaW9uUGhhc2VzKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG51bWJlcjogcGFyc2VGbG9hdChmbXRWZXJzaW9uUGhhc2VzWzNdKSxcbiAgICAgIHRpdGxlOiBmbXRWZXJzaW9uUGhhc2VzWzJdLnRyaW0oKSxcbiAgICAgIGRvbmU6IGZtdFZlcnNpb25QaGFzZXNbMV0gPT09ICdcdTI3MDUnLFxuICAgICAgcmF3OiBsaW5lLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBQYXJzZSBvbGQtZm9ybWF0IFJPQURNQVAubWQuXG4gKiBIYW5kbGVzIHR3byBmb3JtYXRzOlxuICogMS4gRmxhdCBwaGFzZSBsaXN0cyBcdTIwMTQgY2hlY2tib3ggbGluZXMgdW5kZXIgYSBzaW5nbGUgUGhhc2VzIGhlYWRpbmdcbiAqIDIuIE1pbGVzdG9uZS1zZWN0aW9uZWQgXHUyMDE0IGAjIyB2Mi4wIFx1MjAxNCBUaXRsZWAgaGVhZGluZ3Mgd2l0aCBvcHRpb25hbCBgPGRldGFpbHM+YCBibG9ja3NcbiAqIDMuIERldGFpbHMtc2VjdGlvbmVkIFx1MjAxNCBgPGRldGFpbHM+PHN1bW1hcnk+djEuMCBUaXRsZSAoUGhhc2VzIE4tTSk8L3N1bW1hcnk+YCBibG9ja3Mgd2l0aCBwaGFzZSBjaGVja2JveGVzIGluc2lkZVxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VPbGRSb2FkbWFwKGNvbnRlbnQ6IHN0cmluZyk6IFBsYW5uaW5nUm9hZG1hcCB7XG4gIGNvbnN0IHJlc3VsdDogUGxhbm5pbmdSb2FkbWFwID0ge1xuICAgIHJhdzogY29udGVudCxcbiAgICBtaWxlc3RvbmVzOiBbXSxcbiAgICBwaGFzZXM6IFtdLFxuICB9O1xuXG4gIGNvbnN0IGxpbmVzID0gY29udGVudC5zcGxpdCgnXFxuJyk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN0cmF0ZWd5IDE6IERldGVjdCA8ZGV0YWlscz48c3VtbWFyeT52Ti5OIFRpdGxlPC9zdW1tYXJ5PiBibG9ja3MgXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIFRoaXMgaGFuZGxlcyB0aGUgZm9ybWF0IHdoZXJlIG1pbGVzdG9uZXMgYXJlIDxkZXRhaWxzPiBibG9ja3MgY29udGFpbmluZyBwaGFzZSBjaGVja2JveGVzXG4gIGNvbnN0IGRldGFpbHNNaWxlc3RvbmVzID0gcGFyc2VEZXRhaWxzQmxvY2tNaWxlc3RvbmVzKGxpbmVzKTtcbiAgaWYgKGRldGFpbHNNaWxlc3RvbmVzLmxlbmd0aCA+IDApIHtcbiAgICByZXN1bHQubWlsZXN0b25lcyA9IGRldGFpbHNNaWxlc3RvbmVzO1xuXG4gICAgLy8gQWxzbyBjaGVjayBmb3Igbm9uLWNvbGxhcHNlZCBtaWxlc3RvbmUgc2VjdGlvbnMgKCMjIyB2My4wIFRpdGxlKVxuICAgIC8vIHRoYXQgZm9sbG93IHRoZSA8ZGV0YWlscz4gYmxvY2tzXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgaGVhZGluZyA9IGxpbmVzW2ldLm1hdGNoKC9eIyMjXFxzKyh2W1xcZC5dKylcXHMrKC4rPykoPzpcXHMqXFwoLipcXCkpP1xccyokLyk7XG4gICAgICBpZiAoaGVhZGluZykge1xuICAgICAgICAvLyBBbHJlYWR5IGNhcHR1cmVkIGFzIGEgZGV0YWlscyBibG9jaz9cbiAgICAgICAgY29uc3QgaWQgPSBoZWFkaW5nWzFdO1xuICAgICAgICBpZiAocmVzdWx0Lm1pbGVzdG9uZXMuc29tZShtID0+IG0uaWQgPT09IGlkKSkgY29udGludWU7XG5cbiAgICAgICAgLy8gQ29sbGVjdCBwaGFzZSBlbnRyaWVzIHVudGlsIG5leHQgIyMgb3IgIyMjIGhlYWRpbmdcbiAgICAgICAgY29uc3QgcGhhc2VzOiBQbGFubmluZ1JvYWRtYXBFbnRyeVtdID0gW107XG4gICAgICAgIGZvciAobGV0IGogPSBpICsgMTsgaiA8IGxpbmVzLmxlbmd0aDsgaisrKSB7XG4gICAgICAgICAgaWYgKC9eIyM/XFxzLy50ZXN0KGxpbmVzW2pdKSB8fCAvXiMjI1xccy8udGVzdChsaW5lc1tqXSkpIGJyZWFrO1xuICAgICAgICAgIGNvbnN0IGVudHJ5ID0gcGFyc2VQaGFzZUVudHJ5KGxpbmVzW2pdLnRyaW0oKSk7XG4gICAgICAgICAgaWYgKGVudHJ5KSBwaGFzZXMucHVzaChlbnRyeSk7XG4gICAgICAgIH1cbiAgICAgICAgcmVzdWx0Lm1pbGVzdG9uZXMucHVzaCh7XG4gICAgICAgICAgaWQsXG4gICAgICAgICAgdGl0bGU6IGhlYWRpbmdbMl0udHJpbSgpLFxuICAgICAgICAgIGNvbGxhcHNlZDogZmFsc2UsXG4gICAgICAgICAgcGhhc2VzLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTdHJhdGVneSAyOiBEZXRlY3QgIyMgaGVhZGluZy1zZWN0aW9uZWQgbWlsZXN0b25lcyBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3QgbWlsZXN0b25lSGVhZGluZ1JlZ2V4ID0gL14jI1xccysoLispJC87XG4gIGNvbnN0IG1pbGVzdG9uZUhlYWRpbmdzOiB7IGluZGV4OiBudW1iZXI7IGlkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmcgfVtdID0gW107XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IG1hdGNoID0gbGluZXNbaV0ubWF0Y2gobWlsZXN0b25lSGVhZGluZ1JlZ2V4KTtcbiAgICBpZiAobWF0Y2gpIHtcbiAgICAgIGNvbnN0IGhlYWRpbmcgPSBtYXRjaFsxXS50cmltKCk7XG4gICAgICAvLyBTa2lwIGdlbmVyaWMgaGVhZGluZ3MgbGlrZSBcIiMjIFBoYXNlc1wiLCBcIiMjIE1pbGVzdG9uZXNcIiwgXCIjIyBQaGFzZSBEZXRhaWxzXCIsIFwiIyMgUHJvZ3Jlc3NcIlxuICAgICAgaWYgKC9eKHBoYXNlcz98bWlsZXN0b25lcz98cGhhc2VcXHMrZGV0YWlscz98cHJvZ3Jlc3MpJC9pLnRlc3QoaGVhZGluZykpIGNvbnRpbnVlO1xuICAgICAgLy8gRXh0cmFjdCBtaWxlc3RvbmUgSUQgKGUuZy4gXCJ2Mi4wXCIgZnJvbSBcInYyLjAgXHUyMDE0IEZvdW5kYXRpb25cIilcbiAgICAgIGNvbnN0IGlkTWF0Y2ggPSBoZWFkaW5nLm1hdGNoKC9eKHZbXFxkLl0rfFtcXHcuLV0rKVxccypbXHUyMDE0XHUyMDEzLV1cXHMqKC4rKSQvKTtcbiAgICAgIGlmIChpZE1hdGNoKSB7XG4gICAgICAgIG1pbGVzdG9uZUhlYWRpbmdzLnB1c2goeyBpbmRleDogaSwgaWQ6IGlkTWF0Y2hbMV0sIHRpdGxlOiBpZE1hdGNoWzJdLnRyaW0oKSB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBpZiAobWlsZXN0b25lSGVhZGluZ3MubGVuZ3RoID4gMCkge1xuICAgIC8vIE1pbGVzdG9uZS1zZWN0aW9uZWQgZm9ybWF0XG4gICAgZm9yIChsZXQgbSA9IDA7IG0gPCBtaWxlc3RvbmVIZWFkaW5ncy5sZW5ndGg7IG0rKykge1xuICAgICAgY29uc3Qgc3RhcnRJZHggPSBtaWxlc3RvbmVIZWFkaW5nc1ttXS5pbmRleCArIDE7XG4gICAgICBjb25zdCBlbmRJZHggPSBtICsgMSA8IG1pbGVzdG9uZUhlYWRpbmdzLmxlbmd0aCA/IG1pbGVzdG9uZUhlYWRpbmdzW20gKyAxXS5pbmRleCA6IGxpbmVzLmxlbmd0aDtcbiAgICAgIGNvbnN0IHNlY3Rpb25MaW5lcyA9IGxpbmVzLnNsaWNlKHN0YXJ0SWR4LCBlbmRJZHgpO1xuXG4gICAgICBjb25zdCBtaWxlc3RvbmU6IFBsYW5uaW5nUm9hZG1hcE1pbGVzdG9uZSA9IHtcbiAgICAgICAgaWQ6IG1pbGVzdG9uZUhlYWRpbmdzW21dLmlkLFxuICAgICAgICB0aXRsZTogbWlsZXN0b25lSGVhZGluZ3NbbV0udGl0bGUsXG4gICAgICAgIGNvbGxhcHNlZDogZmFsc2UsXG4gICAgICAgIHBoYXNlczogW10sXG4gICAgICB9O1xuXG4gICAgICAvLyBDaGVjayBmb3IgPGRldGFpbHM+IGJsb2NrXG4gICAgICBjb25zdCBzZWN0aW9uVGV4dCA9IHNlY3Rpb25MaW5lcy5qb2luKCdcXG4nKTtcbiAgICAgIGlmIChzZWN0aW9uVGV4dC5pbmNsdWRlcygnPGRldGFpbHM+JykpIHtcbiAgICAgICAgbWlsZXN0b25lLmNvbGxhcHNlZCA9IHRydWU7XG4gICAgICB9XG5cbiAgICAgIC8vIEV4dHJhY3QgcGhhc2UgZW50cmllcyBmcm9tIHRoZSBzZWN0aW9uIChpbmNsdWRpbmcgaW5zaWRlIDxkZXRhaWxzPilcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBzZWN0aW9uTGluZXMpIHtcbiAgICAgICAgY29uc3QgZW50cnkgPSBwYXJzZVBoYXNlRW50cnkobGluZS50cmltKCkpO1xuICAgICAgICBpZiAoZW50cnkpIHtcbiAgICAgICAgICBtaWxlc3RvbmUucGhhc2VzLnB1c2goZW50cnkpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHJlc3VsdC5taWxlc3RvbmVzLnB1c2gobWlsZXN0b25lKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN0cmF0ZWd5IDM6IEZsYXQgZm9ybWF0IFx1MjAxNCBqdXN0IGV4dHJhY3QgYWxsIHBoYXNlIGNoZWNrYm94IGxpbmVzIFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgICAgY29uc3QgZW50cnkgPSBwYXJzZVBoYXNlRW50cnkobGluZS50cmltKCkpO1xuICAgICAgaWYgKGVudHJ5KSB7XG4gICAgICAgIHJlc3VsdC5waGFzZXMucHVzaChlbnRyeSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuLyoqXG4gKiBQYXJzZSA8ZGV0YWlscz48c3VtbWFyeT52Ti5OIFRpdGxlIChQaGFzZXMgTi1NKTwvc3VtbWFyeT4uLi48L2RldGFpbHM+IGJsb2Nrcy5cbiAqIEVhY2ggYmxvY2sgYmVjb21lcyBhIG1pbGVzdG9uZSB3aXRoIHRoZSBwaGFzZSBlbnRyaWVzIGluc2lkZSBpdC5cbiAqL1xuZnVuY3Rpb24gcGFyc2VEZXRhaWxzQmxvY2tNaWxlc3RvbmVzKGxpbmVzOiBzdHJpbmdbXSk6IFBsYW5uaW5nUm9hZG1hcE1pbGVzdG9uZVtdIHtcbiAgY29uc3QgbWlsZXN0b25lczogUGxhbm5pbmdSb2FkbWFwTWlsZXN0b25lW10gPSBbXTtcbiAgbGV0IGluRGV0YWlscyA9IGZhbHNlO1xuICBsZXQgY3VycmVudE1pbGVzdG9uZTogUGxhbm5pbmdSb2FkbWFwTWlsZXN0b25lIHwgbnVsbCA9IG51bGw7XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgY29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpO1xuXG4gICAgaWYgKHRyaW1tZWQgPT09ICc8ZGV0YWlscz4nKSB7XG4gICAgICBpbkRldGFpbHMgPSB0cnVlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWYgKGluRGV0YWlscyAmJiAhY3VycmVudE1pbGVzdG9uZSkge1xuICAgICAgLy8gTG9vayBmb3IgPHN1bW1hcnk+dk4uTiBUaXRsZSAoUGhhc2VzIE4tTSkgLS0gU1RBVFVTPC9zdW1tYXJ5PlxuICAgICAgY29uc3Qgc3VtbWFyeU1hdGNoID0gdHJpbW1lZC5tYXRjaCgvPHN1bW1hcnk+XFxzKih2W1xcZC5dKylcXHMrKC4rPylcXHMqKD86XFwoLipcXCkpP1xccyooPzotLVxccyouKik/XFxzKjxcXC9zdW1tYXJ5Pi8pO1xuICAgICAgaWYgKHN1bW1hcnlNYXRjaCkge1xuICAgICAgICBjdXJyZW50TWlsZXN0b25lID0ge1xuICAgICAgICAgIGlkOiBzdW1tYXJ5TWF0Y2hbMV0sXG4gICAgICAgICAgdGl0bGU6IHN1bW1hcnlNYXRjaFsyXS50cmltKCksXG4gICAgICAgICAgY29sbGFwc2VkOiB0cnVlLFxuICAgICAgICAgIHBoYXNlczogW10sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAodHJpbW1lZCA9PT0gJzwvZGV0YWlscz4nKSB7XG4gICAgICBpZiAoY3VycmVudE1pbGVzdG9uZSkge1xuICAgICAgICBtaWxlc3RvbmVzLnB1c2goY3VycmVudE1pbGVzdG9uZSk7XG4gICAgICAgIGN1cnJlbnRNaWxlc3RvbmUgPSBudWxsO1xuICAgICAgfVxuICAgICAgaW5EZXRhaWxzID0gZmFsc2U7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAoY3VycmVudE1pbGVzdG9uZSkge1xuICAgICAgY29uc3QgZW50cnkgPSBwYXJzZVBoYXNlRW50cnkodHJpbW1lZCk7XG4gICAgICBpZiAoZW50cnkpIHtcbiAgICAgICAgY3VycmVudE1pbGVzdG9uZS5waGFzZXMucHVzaChlbnRyeSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG1pbGVzdG9uZXM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQbGFuIFBhcnNlciAoWE1MLWluLU1hcmtkb3duKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqIFN0cmlwIHN1cnJvdW5kaW5nIHF1b3RlcyBmcm9tIFlBTUwgc3RyaW5nIHZhbHVlcyAqL1xuZnVuY3Rpb24gdW5xdW90ZSh2YWw6IHVua25vd24pOiBzdHJpbmcge1xuICBjb25zdCBzID0gU3RyaW5nKHZhbCA/PyAnJyk7XG4gIGlmICgocy5zdGFydHNXaXRoKCdcIicpICYmIHMuZW5kc1dpdGgoJ1wiJykpIHx8IChzLnN0YXJ0c1dpdGgoXCInXCIpICYmIHMuZW5kc1dpdGgoXCInXCIpKSkge1xuICAgIHJldHVybiBzLnNsaWNlKDEsIC0xKTtcbiAgfVxuICByZXR1cm4gcztcbn1cblxuLyoqXG4gKiBQYXJzZSB0aGUgbXVzdF9oYXZlcyBuZXN0ZWQgc3RydWN0dXJlIGZyb20gZnJvbnRtYXR0ZXIgbGluZXMgZGlyZWN0bHkuXG4gKiBwYXJzZUZyb250bWF0dGVyTWFwIGRvZXNuJ3QgaGFuZGxlIDMtbGV2ZWwgbmVzdGluZyB3ZWxsLCBzbyB3ZSByZS1wYXJzZS5cbiAqL1xuZnVuY3Rpb24gcGFyc2VNdXN0SGF2ZXNGcm9tTGluZXMoZm1MaW5lczogc3RyaW5nW10pOiBQbGFubmluZ1BsYW5NdXN0SGF2ZXMgfCBudWxsIHtcbiAgY29uc3Qgc3RhcnQgPSBmbUxpbmVzLmZpbmRJbmRleChsID0+IC9ebXVzdF9oYXZlc1xccyo6Ly50ZXN0KGwpKTtcbiAgaWYgKHN0YXJ0ID09PSAtMSkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgdHJ1dGhzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBhcnRpZmFjdHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGtleUxpbmtzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgY3VycmVudExpc3Q6IHN0cmluZ1tdIHwgbnVsbCA9IG51bGw7XG5cbiAgZm9yIChsZXQgaSA9IHN0YXJ0ICsgMTsgaSA8IGZtTGluZXMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBsaW5lID0gZm1MaW5lc1tpXTtcbiAgICAvLyBOZXcgdG9wLWxldmVsIGtleSBcdTIwMTQgc3RvcFxuICAgIGlmICgvXlxcdy8udGVzdChsaW5lKSkgYnJlYWs7XG4gICAgLy8gU3ViLWtleSBhdCAyLXNwYWNlIGluZGVudFxuICAgIGNvbnN0IHN1YktleSA9IGxpbmUubWF0Y2goL14gIChcXHdbXFx3X10qKTovKTtcbiAgICBpZiAoc3ViS2V5KSB7XG4gICAgICBjb25zdCBrZXkgPSBzdWJLZXlbMV07XG4gICAgICBpZiAoa2V5ID09PSAndHJ1dGhzJykgY3VycmVudExpc3QgPSB0cnV0aHM7XG4gICAgICBlbHNlIGlmIChrZXkgPT09ICdhcnRpZmFjdHMnKSBjdXJyZW50TGlzdCA9IGFydGlmYWN0cztcbiAgICAgIGVsc2UgaWYgKGtleSA9PT0gJ2tleV9saW5rcycpIGN1cnJlbnRMaXN0ID0ga2V5TGlua3M7XG4gICAgICBlbHNlIGN1cnJlbnRMaXN0ID0gbnVsbDtcbiAgICAgIC8vIENoZWNrIGZvciBpbmxpbmUgZW1wdHkgYXJyYXlcbiAgICAgIGlmICgvOlxccypcXFtcXF0vLnRlc3QobGluZSkpIGN1cnJlbnRMaXN0ID0gbnVsbDtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBBcnJheSBpdGVtIGF0IDQtc3BhY2UgaW5kZW50XG4gICAgY29uc3QgaXRlbSA9IGxpbmUubWF0Y2goL14gICAgLSAoLispJC8pO1xuICAgIGlmIChpdGVtICYmIGN1cnJlbnRMaXN0KSB7XG4gICAgICBjdXJyZW50TGlzdC5wdXNoKGl0ZW1bMV0udHJpbSgpKTtcbiAgICB9XG4gIH1cblxuICBpZiAodHJ1dGhzLmxlbmd0aCA9PT0gMCAmJiBhcnRpZmFjdHMubGVuZ3RoID09PSAwICYmIGtleUxpbmtzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7IHRydXRocywgYXJ0aWZhY3RzLCBrZXlfbGlua3M6IGtleUxpbmtzIH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlUGxhbkZyb250bWF0dGVyKGZtOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgZm1MaW5lczogc3RyaW5nW10gfCBudWxsKTogUGxhbm5pbmdQbGFuRnJvbnRtYXR0ZXIge1xuICBjb25zdCBtdXN0SGF2ZXMgPSBmbUxpbmVzID8gcGFyc2VNdXN0SGF2ZXNGcm9tTGluZXMoZm1MaW5lcykgOiBudWxsO1xuXG4gIHJldHVybiB7XG4gICAgcGhhc2U6IHVucXVvdGUoZm0ucGhhc2UpLFxuICAgIHBsYW46IHVucXVvdGUoZm0ucGxhbiksXG4gICAgdHlwZTogdW5xdW90ZShmbS50eXBlKSxcbiAgICB3YXZlOiBmbS53YXZlICE9PSB1bmRlZmluZWQgPyBOdW1iZXIoZm0ud2F2ZSkgOiBudWxsLFxuICAgIGRlcGVuZHNfb246IEFycmF5LmlzQXJyYXkoZm0uZGVwZW5kc19vbikgPyBmbS5kZXBlbmRzX29uLm1hcChzID0+IHVucXVvdGUocykpIDogW10sXG4gICAgZmlsZXNfbW9kaWZpZWQ6IEFycmF5LmlzQXJyYXkoZm0uZmlsZXNfbW9kaWZpZWQpID8gZm0uZmlsZXNfbW9kaWZpZWQubWFwKHMgPT4gdW5xdW90ZShzKSkgOiBbXSxcbiAgICBhdXRvbm9tb3VzOiBmbS5hdXRvbm9tb3VzID09PSAndHJ1ZScgfHwgZm0uYXV0b25vbW91cyA9PT0gdHJ1ZSxcbiAgICBtdXN0X2hhdmVzOiBtdXN0SGF2ZXMsXG4gIH07XG59XG5cbi8qKlxuICogUGFyc2Ugb2xkLWZvcm1hdCBwbGFuIGZpbGUgd2l0aCBZQU1MIGZyb250bWF0dGVyIGFuZCBYTUwtaW4tbWFya2Rvd24gc2VjdGlvbnMuXG4gKiBGYWxscyBiYWNrIHRvIHBsYWluIG1hcmtkb3duIGZvciBxdWljay10YXNrIHBsYW5zIHRoYXQgbGFjayBYTUwgdGFncy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlT2xkUGxhbihjb250ZW50OiBzdHJpbmcsIGZpbGVOYW1lOiBzdHJpbmcgPSAnJywgcGxhbk51bWJlcjogc3RyaW5nID0gJycpOiBQbGFubmluZ1BsYW4ge1xuICBjb25zdCBbZm1MaW5lcywgYm9keV0gPSBzcGxpdEZyb250bWF0dGVyKGNvbnRlbnQpO1xuICBjb25zdCBmbSA9IGZtTGluZXMgPyBwYXJzZUZyb250bWF0dGVyTWFwKGZtTGluZXMpIDoge307XG4gIGNvbnN0IGZyb250bWF0dGVyID0gcGFyc2VQbGFuRnJvbnRtYXR0ZXIoZm0sIGZtTGluZXMpO1xuXG4gIC8vIEV4dHJhY3QgWE1MLWluLW1hcmtkb3duIHNlY3Rpb25zXG4gIGNvbnN0IG9iamVjdGl2ZSA9IGV4dHJhY3RYbWxUYWcoY29udGVudCwgJ29iamVjdGl2ZScpO1xuICBjb25zdCB0YXNrcyA9IGV4dHJhY3RUYXNrcyhjb250ZW50KTtcbiAgY29uc3QgY29udGV4dCA9IGV4dHJhY3RYbWxUYWcoY29udGVudCwgJ2NvbnRleHQnKTtcbiAgY29uc3QgdmVyaWZpY2F0aW9uID0gZXh0cmFjdFhtbFRhZyhjb250ZW50LCAndmVyaWZpY2F0aW9uJyk7XG4gIGNvbnN0IHN1Y2Nlc3NDcml0ZXJpYSA9IGV4dHJhY3RYbWxUYWcoY29udGVudCwgJ3N1Y2Nlc3NfY3JpdGVyaWEnKTtcblxuICByZXR1cm4ge1xuICAgIGZpbGVOYW1lLFxuICAgIHBsYW5OdW1iZXI6IHBsYW5OdW1iZXIgfHwgU3RyaW5nKGZtLnBsYW4gPz8gJycpLFxuICAgIGZyb250bWF0dGVyLFxuICAgIG9iamVjdGl2ZSxcbiAgICB0YXNrcyxcbiAgICBjb250ZXh0LFxuICAgIHZlcmlmaWNhdGlvbixcbiAgICBzdWNjZXNzQ3JpdGVyaWEsXG4gICAgcmF3OiBjb250ZW50LFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU3VtbWFyeSBQYXJzZXIgKFlBTUwgRnJvbnRtYXR0ZXIpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBwYXJzZVJlcXVpcmVzQXJyYXkocmF3OiB1bmtub3duKTogUGxhbm5pbmdTdW1tYXJ5UmVxdWlyZXNbXSB7XG4gIGlmICghQXJyYXkuaXNBcnJheShyYXcpKSByZXR1cm4gW107XG4gIHJldHVybiByYXcubWFwKGl0ZW0gPT4ge1xuICAgIGlmICh0eXBlb2YgaXRlbSA9PT0gJ29iamVjdCcgJiYgaXRlbSAhPT0gbnVsbCkge1xuICAgICAgY29uc3Qgb2JqID0gaXRlbSBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAgICAgcmV0dXJuIHsgcGhhc2U6IG9iai5waGFzZSA/PyAnJywgcHJvdmlkZXM6IG9iai5wcm92aWRlcyA/PyAnJyB9O1xuICAgIH1cbiAgICByZXR1cm4geyBwaGFzZTogJycsIHByb3ZpZGVzOiBTdHJpbmcoaXRlbSkgfTtcbiAgfSk7XG59XG5cbi8vIHBhcnNlRnJvbnRtYXR0ZXJNYXAgZnJvbSBzaGFyZWQgbm93IHN1cHBvcnRzIGh5cGhlbmF0ZWQga2V5cyBuYXRpdmVseVxuXG5mdW5jdGlvbiBwYXJzZVN1bW1hcnlGcm9udG1hdHRlcihmbTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQbGFubmluZ1N1bW1hcnlGcm9udG1hdHRlciB7XG4gIHJldHVybiB7XG4gICAgcGhhc2U6IHVucXVvdGUoZm0ucGhhc2UpLFxuICAgIHBsYW46IHVucXVvdGUoZm0ucGxhbiksXG4gICAgc3Vic3lzdGVtOiB1bnF1b3RlKGZtLnN1YnN5c3RlbSksXG4gICAgdGFnczogbm9ybWFsaXplU3RyaW5nQXJyYXkoZm0udGFncyksXG4gICAgcmVxdWlyZXM6IHBhcnNlUmVxdWlyZXNBcnJheShmbS5yZXF1aXJlcyksXG4gICAgcHJvdmlkZXM6IG5vcm1hbGl6ZVN0cmluZ0FycmF5KGZtLnByb3ZpZGVzKSxcbiAgICBhZmZlY3RzOiBub3JtYWxpemVTdHJpbmdBcnJheShmbS5hZmZlY3RzKSxcbiAgICAndGVjaC1zdGFjayc6IG5vcm1hbGl6ZVN0cmluZ0FycmF5KGZtWyd0ZWNoLXN0YWNrJ10pLFxuICAgICdrZXktZmlsZXMnOiBub3JtYWxpemVTdHJpbmdBcnJheShmbVsna2V5LWZpbGVzJ10pLFxuICAgICdrZXktZGVjaXNpb25zJzogbm9ybWFsaXplU3RyaW5nQXJyYXkoZm1bJ2tleS1kZWNpc2lvbnMnXSksXG4gICAgJ3BhdHRlcm5zLWVzdGFibGlzaGVkJzogbm9ybWFsaXplU3RyaW5nQXJyYXkoZm1bJ3BhdHRlcm5zLWVzdGFibGlzaGVkJ10pLFxuICAgIGR1cmF0aW9uOiB1bnF1b3RlKGZtLmR1cmF0aW9uKSxcbiAgICBjb21wbGV0ZWQ6IHVucXVvdGUoZm0uY29tcGxldGVkKSxcbiAgfTtcbn1cblxuLyoqXG4gKiBQYXJzZSBvbGQtZm9ybWF0IHN1bW1hcnkgZmlsZSB3aXRoIFlBTUwgZnJvbnRtYXR0ZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZU9sZFN1bW1hcnkoY29udGVudDogc3RyaW5nLCBmaWxlTmFtZTogc3RyaW5nID0gJycsIHBsYW5OdW1iZXI6IHN0cmluZyA9ICcnKTogUGxhbm5pbmdTdW1tYXJ5IHtcbiAgY29uc3QgW2ZtTGluZXMsIGJvZHldID0gc3BsaXRGcm9udG1hdHRlcihjb250ZW50KTtcbiAgY29uc3QgZm0gPSBmbUxpbmVzID8gcGFyc2VGcm9udG1hdHRlck1hcChmbUxpbmVzKSA6IHt9O1xuXG4gIHJldHVybiB7XG4gICAgZmlsZU5hbWUsXG4gICAgcGxhbk51bWJlcjogcGxhbk51bWJlciB8fCBTdHJpbmcoZm0ucGxhbiA/PyAnJyksXG4gICAgZnJvbnRtYXR0ZXI6IHBhcnNlU3VtbWFyeUZyb250bWF0dGVyKGZtKSxcbiAgICBib2R5LFxuICAgIHJhdzogY29udGVudCxcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJlcXVpcmVtZW50cyBQYXJzZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogUGFyc2Ugb2xkLWZvcm1hdCBSRVFVSVJFTUVOVFMubWQuXG4gKiBFeHRyYWN0cyByZXF1aXJlbWVudCBlbnRyaWVzIGZyb20gbWFya2Rvd24gd2l0aCBzdGF0dXMgc2VjdGlvbnMgYW5kIHJlcXVpcmVtZW50IGhlYWRpbmdzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VPbGRSZXF1aXJlbWVudHMoY29udGVudDogc3RyaW5nKTogUGxhbm5pbmdSZXF1aXJlbWVudFtdIHtcbiAgY29uc3QgcmVxdWlyZW1lbnRzOiBQbGFubmluZ1JlcXVpcmVtZW50W10gPSBbXTtcbiAgY29uc3QgbGluZXMgPSBjb250ZW50LnNwbGl0KCdcXG4nKTtcblxuICBsZXQgY3VycmVudFN0YXR1cyA9ICcnO1xuICBsZXQgY3VycmVudFJlcTogUGFydGlhbDxQbGFubmluZ1JlcXVpcmVtZW50PiB8IG51bGwgPSBudWxsO1xuICBsZXQgY3VycmVudFJhdzogc3RyaW5nW10gPSBbXTtcblxuICBmdW5jdGlvbiBmbHVzaFJlcSgpIHtcbiAgICBpZiAoY3VycmVudFJlcT8uaWQgJiYgY3VycmVudFJlcT8udGl0bGUpIHtcbiAgICAgIHJlcXVpcmVtZW50cy5wdXNoKHtcbiAgICAgICAgaWQ6IGN1cnJlbnRSZXEuaWQsXG4gICAgICAgIHRpdGxlOiBjdXJyZW50UmVxLnRpdGxlLFxuICAgICAgICBzdGF0dXM6IGN1cnJlbnRSZXEuc3RhdHVzIHx8IGN1cnJlbnRTdGF0dXMgfHwgJ3Vua25vd24nLFxuICAgICAgICBkZXNjcmlwdGlvbjogY3VycmVudFJlcS5kZXNjcmlwdGlvbiB8fCAnJyxcbiAgICAgICAgcmF3OiBjdXJyZW50UmF3LmpvaW4oJ1xcbicpLnRyaW0oKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBjdXJyZW50UmVxID0gbnVsbDtcbiAgICBjdXJyZW50UmF3ID0gW107XG4gIH1cblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICAvLyBTdGF0dXMgc2VjdGlvbiBoZWFkaW5nICgjIyBBY3RpdmUsICMjIFZhbGlkYXRlZCwgIyMgRGVmZXJyZWQpXG4gICAgY29uc3Qgc3RhdHVzTWF0Y2ggPSBsaW5lLm1hdGNoKC9eIyNcXHMrKFxcd1tcXHdcXHMmXSpcXHcpXFxzKiQvKTtcbiAgICBpZiAoc3RhdHVzTWF0Y2gpIHtcbiAgICAgIGZsdXNoUmVxKCk7XG4gICAgICBjdXJyZW50U3RhdHVzID0gc3RhdHVzTWF0Y2hbMV0udG9Mb3dlckNhc2UoKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIFNlY3Rpb24gaGVhZGluZyAoIyMjIENhdGVnb3J5IE5hbWUpIFx1MjAxNCB1c2UgYXMgY29udGV4dCBmb3IgYnVsbGV0IHJlcXVpcmVtZW50c1xuICAgIGNvbnN0IHNlY3Rpb25NYXRjaCA9IGxpbmUubWF0Y2goL14jIyNcXHMrKC4rKSQvKTtcbiAgICBpZiAoc2VjdGlvbk1hdGNoKSB7XG4gICAgICAvLyBDaGVjayBpZiB0aGlzIGlzIGEgcmVxdWlyZW1lbnQgaGVhZGluZyAoIyMjIFIwMDEgXHUyMDE0IFRpdGxlKVxuICAgICAgY29uc3QgcmVxSGVhZGluZyA9IHNlY3Rpb25NYXRjaFsxXS5tYXRjaCgvXihSXFxkKylcXHMqW1x1MjAxNFx1MjAxMy1dXFxzKiguKykkLyk7XG4gICAgICBpZiAocmVxSGVhZGluZykge1xuICAgICAgICBmbHVzaFJlcSgpO1xuICAgICAgICBjdXJyZW50UmVxID0geyBpZDogcmVxSGVhZGluZ1sxXSwgdGl0bGU6IHJlcUhlYWRpbmdbMl0udHJpbSgpLCBzdGF0dXM6IGN1cnJlbnRTdGF0dXMsIGRlc2NyaXB0aW9uOiAnJyB9O1xuICAgICAgICBjdXJyZW50UmF3LnB1c2gobGluZSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgLy8gT3RoZXJ3aXNlIGp1c3Qgbm90ZSB0aGUgc2VjdGlvbiBcdTIwMTQgZG9uJ3QgZmx1c2gsIGNvdWxkIGJlIGEgY2F0ZWdvcnkgZm9yIGJ1bGxldCByZXFzXG4gICAgICBmbHVzaFJlcSgpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gQnVsbGV0LWZvcm1hdCByZXF1aXJlbWVudDogLSBbeF0gKipJRCoqOiBEZXNjcmlwdGlvblxuICAgIGNvbnN0IGJ1bGxldFJlcU1hdGNoID0gbGluZS5tYXRjaCgvXi1cXHMrXFxbKFsgeFhdKVxcXVxccytcXCpcXCooW14qXSspXFwqXFwqXFxzKjpcXHMqKC4rKSQvKTtcbiAgICBpZiAoYnVsbGV0UmVxTWF0Y2gpIHtcbiAgICAgIGZsdXNoUmVxKCk7XG4gICAgICBjb25zdCBkb25lID0gYnVsbGV0UmVxTWF0Y2hbMV0udG9Mb3dlckNhc2UoKSA9PT0gJ3gnO1xuICAgICAgY29uc3QgaWQgPSBidWxsZXRSZXFNYXRjaFsyXS50cmltKCk7XG4gICAgICBjb25zdCBkZXNjID0gYnVsbGV0UmVxTWF0Y2hbM10udHJpbSgpO1xuICAgICAgcmVxdWlyZW1lbnRzLnB1c2goe1xuICAgICAgICBpZCxcbiAgICAgICAgdGl0bGU6IGRlc2MsXG4gICAgICAgIHN0YXR1czogZG9uZSA/ICdjb21wbGV0ZScgOiAoY3VycmVudFN0YXR1cyB8fCAnYWN0aXZlJyksXG4gICAgICAgIGRlc2NyaXB0aW9uOiBkZXNjLFxuICAgICAgICByYXc6IGxpbmUsXG4gICAgICB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIERlc2NyaXB0aW9uIG9yIG1ldGFkYXRhIHdpdGhpbiBhIHJlcXVpcmVtZW50XG4gICAgaWYgKGN1cnJlbnRSZXEpIHtcbiAgICAgIGN1cnJlbnRSYXcucHVzaChsaW5lKTtcbiAgICAgIGNvbnN0IGRlc2NNYXRjaCA9IGxpbmUubWF0Y2goL14tXFxzK0Rlc2NyaXB0aW9uOlxccyooLispJC8pO1xuICAgICAgaWYgKGRlc2NNYXRjaCkge1xuICAgICAgICBjdXJyZW50UmVxLmRlc2NyaXB0aW9uID0gZGVzY01hdGNoWzFdLnRyaW0oKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBzdGF0TWF0Y2ggPSBsaW5lLm1hdGNoKC9eLVxccytTdGF0dXM6XFxzKiguKykkLyk7XG4gICAgICBpZiAoc3RhdE1hdGNoKSB7XG4gICAgICAgIGN1cnJlbnRSZXEuc3RhdHVzID0gc3RhdE1hdGNoWzFdLnRyaW0oKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBmbHVzaFJlcSgpO1xuICByZXR1cm4gcmVxdWlyZW1lbnRzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHJvamVjdCBQYXJzZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8vIFBsYW5uaW5nUHJvamVjdE1ldGEgaXNuJ3QgaW4gdHlwZXMudHMgXHUyMDE0IHByb2plY3QgZmllbGQgb24gUGxhbm5pbmdQcm9qZWN0IGlzIGBzdHJpbmcgfCBudWxsYC5cbi8vIFRoaXMgcGFyc2VyIHJldHVybnMgdGhlIHJhdyBjb250ZW50IGFzIGEgc3RyaW5nLiBUaGUgdG9wLWxldmVsIHBhcnNlciBzdG9yZXMgaXQgZGlyZWN0bHkuXG5cbi8qKlxuICogUGFyc2Ugb2xkLWZvcm1hdCBQUk9KRUNULm1kLlxuICogUmV0dXJucyB0aGUgcmF3IGNvbnRlbnQgYXMgYSBzdHJpbmcgKHN0b3JlZCBhcyBwcm9qZWN0IGZpZWxkIG9uIFBsYW5uaW5nUHJvamVjdCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZU9sZFByb2plY3QoY29udGVudDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGNvbnRlbnQ7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTdGF0ZSBQYXJzZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogUGFyc2Ugb2xkLWZvcm1hdCBTVEFURS5tZC5cbiAqIEV4dHJhY3RzIGN1cnJlbnQgcGhhc2UgYW5kIHN0YXR1cyBmcm9tIGJvbGQtZmllbGQgcGF0dGVybnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZU9sZFN0YXRlKGNvbnRlbnQ6IHN0cmluZyk6IFBsYW5uaW5nU3RhdGUge1xuICBjb25zdCBjdXJyZW50UGhhc2UgPSBleHRyYWN0Qm9sZEZpZWxkKGNvbnRlbnQsICdDdXJyZW50IFBoYXNlJyk7XG4gIGNvbnN0IHN0YXR1cyA9IGV4dHJhY3RCb2xkRmllbGQoY29udGVudCwgJ1N0YXR1cycpO1xuXG4gIHJldHVybiB7XG4gICAgcmF3OiBjb250ZW50LFxuICAgIGN1cnJlbnRQaGFzZSxcbiAgICBzdGF0dXMsXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDb25maWcgUGFyc2VyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFBhcnNlIG9sZC1mb3JtYXQgY29uZmlnLmpzb24uXG4gKiBSZXR1cm5zIG51bGwgb24gaW52YWxpZCBKU09OIChncmFjZWZ1bCBlcnJvciBoYW5kbGluZykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZU9sZENvbmZpZyhjb250ZW50OiBzdHJpbmcpOiBQbGFubmluZ0NvbmZpZyB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UoY29udGVudCk7XG4gICAgaWYgKHR5cGVvZiBwYXJzZWQgIT09ICdvYmplY3QnIHx8IHBhcnNlZCA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHBhcnNlZCBhcyBQbGFubmluZ0NvbmZpZztcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUlBLFNBQVMsa0JB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
