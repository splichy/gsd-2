import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  resolveGsdRoot,
  findMilestoneIds,
  resolveMilestoneDir,
  resolveMilestoneFile,
  findSliceIds,
  resolveSliceDir
} from "./paths.js";
function graphsDir(gsdRoot) {
  return join(gsdRoot, "graphs");
}
function graphJsonPath(gsdRoot) {
  return join(graphsDir(gsdRoot), "graph.json");
}
function graphTmpPath(gsdRoot) {
  return join(graphsDir(gsdRoot), "graph.tmp.json");
}
function snapshotPath(gsdRoot) {
  return join(graphsDir(gsdRoot), ".last-build-snapshot.json");
}
function parseStateFile(gsdRoot, nodes, _edges) {
  const statePath = join(gsdRoot, "STATE.md");
  if (!existsSync(statePath)) return;
  let content;
  try {
    content = readFileSync(statePath, "utf-8");
  } catch {
    return;
  }
  const activeMilestoneMatch = content.match(/\*\*Active Milestone:\*\*\s+([A-Z]\d+):\s+(.+)/i);
  if (activeMilestoneMatch) {
    const [, milestoneId, title] = activeMilestoneMatch;
    const id = `milestone:${milestoneId}`;
    if (!nodes.some((n) => n.id === id)) {
      nodes.push({
        id,
        label: `${milestoneId}: ${title.trim()}`,
        type: "milestone",
        description: `Active milestone: ${milestoneId}`,
        confidence: "EXTRACTED",
        sourceFile: "STATE.md"
      });
    }
  }
  const phaseMatch = content.match(/\*\*Phase:\*\*\s+(\S+)/i);
  if (phaseMatch) {
    const phase = phaseMatch[1].trim();
    nodes.push({
      id: `concept:phase:${phase}`,
      label: `Phase: ${phase}`,
      type: "concept",
      confidence: "EXTRACTED",
      sourceFile: "STATE.md"
    });
  }
}
function parseKnowledgeFile(gsdRoot, nodes, _edges) {
  const knowledgePath = join(gsdRoot, "KNOWLEDGE.md");
  if (!existsSync(knowledgePath)) return;
  let content;
  try {
    content = readFileSync(knowledgePath, "utf-8");
  } catch {
    return;
  }
  const rulesMatch = content.match(/## Rules\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (rulesMatch) {
    for (const line of rulesMatch[1].split("\n")) {
      if (!line.includes("|")) continue;
      const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length < 3) continue;
      if (cells[0].startsWith("#") || cells[0].startsWith("-")) continue;
      const id = cells[0];
      if (!/^K\d+$/i.test(id)) continue;
      nodes.push({
        id: `rule:${id}`,
        label: id,
        type: "rule",
        description: cells[2] ?? "",
        confidence: "EXTRACTED",
        sourceFile: "KNOWLEDGE.md"
      });
    }
  }
  const patternsMatch = content.match(/## Patterns\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (patternsMatch) {
    for (const line of patternsMatch[1].split("\n")) {
      if (!line.includes("|")) continue;
      const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      if (cells[0].startsWith("#") || cells[0].startsWith("-")) continue;
      const id = cells[0];
      if (!/^P\d+$/i.test(id)) continue;
      nodes.push({
        id: `pattern:${id}`,
        label: id,
        type: "pattern",
        description: cells[1] ?? "",
        confidence: "EXTRACTED",
        sourceFile: "KNOWLEDGE.md"
      });
    }
  }
  const lessonsMatch = content.match(/## Lessons Learned\s*\n([\s\S]*?)(?=\n## |$)/i);
  if (lessonsMatch) {
    for (const line of lessonsMatch[1].split("\n")) {
      if (!line.includes("|")) continue;
      const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      if (cells[0].startsWith("#") || cells[0].startsWith("-")) continue;
      const id = cells[0];
      if (!/^L\d+$/i.test(id)) continue;
      nodes.push({
        id: `lesson:${id}`,
        label: id,
        type: "lesson",
        description: cells[1] ?? "",
        confidence: "EXTRACTED",
        sourceFile: "KNOWLEDGE.md"
      });
    }
  }
}
function parseMilestoneFiles(gsdRoot, nodes, edges) {
  const milestoneIds = findMilestoneIds(gsdRoot);
  for (const milestoneId of milestoneIds) {
    try {
      parseSingleMilestone(gsdRoot, milestoneId, nodes, edges);
    } catch {
    }
  }
}
function parseSingleMilestone(gsdRoot, milestoneId, nodes, edges) {
  const mDir = resolveMilestoneDir(gsdRoot, milestoneId);
  if (!mDir) return;
  const milestoneNodeId = `milestone:${milestoneId}`;
  const roadmapPath = resolveMilestoneFile(gsdRoot, milestoneId, "ROADMAP");
  let roadmapContent = null;
  if (roadmapPath && existsSync(roadmapPath)) {
    try {
      roadmapContent = readFileSync(roadmapPath, "utf-8");
    } catch {
    }
  }
  let milestoneTitle = milestoneId;
  if (roadmapContent) {
    const titleMatch = roadmapContent.match(/^#\s+[A-Z]\d+:\s+(.+)/m);
    if (titleMatch) milestoneTitle = `${milestoneId}: ${titleMatch[1].trim()}`;
  }
  if (!nodes.some((n) => n.id === milestoneNodeId)) {
    nodes.push({
      id: milestoneNodeId,
      label: milestoneTitle,
      type: "milestone",
      confidence: "EXTRACTED",
      sourceFile: roadmapContent ? `milestones/${milestoneId}/${basename(roadmapPath)}` : void 0
    });
  }
  const sliceIds = findSliceIds(gsdRoot, milestoneId);
  for (const sliceId of sliceIds) {
    try {
      parseSingleSlice(gsdRoot, milestoneId, sliceId, milestoneNodeId, nodes, edges);
    } catch {
    }
  }
}
function parseSingleSlice(gsdRoot, milestoneId, sliceId, milestoneNodeId, nodes, edges) {
  const sDir = resolveSliceDir(gsdRoot, milestoneId, sliceId);
  if (!sDir) return;
  const sliceNodeId = `slice:${milestoneId}:${sliceId}`;
  const planPath = join(sDir, `${sliceId}-PLAN.md`);
  let sliceTitle = `${milestoneId}/${sliceId}`;
  let planContent = null;
  if (existsSync(planPath)) {
    try {
      planContent = readFileSync(planPath, "utf-8");
      const titleMatch = planContent.match(/^#\s+[A-Z]\d+:\s+(.+)/m);
      if (titleMatch) sliceTitle = `${sliceId}: ${titleMatch[1].trim()}`;
    } catch {
    }
  }
  nodes.push({
    id: sliceNodeId,
    label: sliceTitle,
    type: "slice",
    confidence: "EXTRACTED",
    sourceFile: planContent ? `milestones/${milestoneId}/slices/${sliceId}/${sliceId}-PLAN.md` : void 0
  });
  edges.push({
    from: milestoneNodeId,
    to: sliceNodeId,
    type: "contains",
    confidence: "EXTRACTED"
  });
  if (planContent) {
    parseTasksFromPlan(planContent, milestoneId, sliceId, sliceNodeId, nodes, edges);
  }
}
function parseTasksFromPlan(content, milestoneId, sliceId, sliceNodeId, nodes, edges) {
  const taskPattern = /[-*]\s+\[[ x]\]\s+\*\*(T\d+):\s*([^*]+)\*\*/g;
  let match;
  while ((match = taskPattern.exec(content)) !== null) {
    const [, taskId, taskTitle] = match;
    const taskNodeId = `task:${milestoneId}:${sliceId}:${taskId}`;
    nodes.push({
      id: taskNodeId,
      label: `${taskId}: ${taskTitle.trim()}`,
      type: "task",
      confidence: "EXTRACTED"
    });
    edges.push({
      from: sliceNodeId,
      to: taskNodeId,
      type: "contains",
      confidence: "EXTRACTED"
    });
  }
}
function parseLearningsFiles(gsdRoot, nodes, edges) {
  const milestoneIds = findMilestoneIds(gsdRoot);
  for (const milestoneId of milestoneIds) {
    try {
      parseSingleLearningsFile(gsdRoot, milestoneId, nodes, edges);
    } catch {
    }
  }
}
function parseSingleLearningsFile(gsdRoot, milestoneId, nodes, edges) {
  const mDir = resolveMilestoneDir(gsdRoot, milestoneId);
  if (!mDir) return;
  const learningsPath = join(mDir, `${milestoneId}-LEARNINGS.md`);
  if (!existsSync(learningsPath)) return;
  let content;
  try {
    content = readFileSync(learningsPath, "utf-8");
  } catch {
    return;
  }
  const withoutFrontmatter = content.replace(/^---[\s\S]*?---\n?/, "");
  const milestoneNodeId = `milestone:${milestoneId}`;
  const sourceFile = `milestones/${milestoneId}/${milestoneId}-LEARNINGS.md`;
  const sections = [
    ["Decisions", "decision", "decision"],
    ["Lessons", "lesson", "lesson"],
    ["Patterns", "pattern", "pattern"],
    ["Surprises", "lesson", "surprise"]
  ];
  for (const [sectionName, nodeType, idPrefix] of sections) {
    const sectionMatch = withoutFrontmatter.match(
      new RegExp(`##\\s+${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i")
    );
    if (!sectionMatch) continue;
    const sectionContent = sectionMatch[1];
    parseLearningsSection(
      sectionContent,
      milestoneId,
      idPrefix,
      nodeType,
      milestoneNodeId,
      sourceFile,
      nodes,
      edges
    );
  }
}
function parseLearningsSection(sectionContent, milestoneId, idPrefix, nodeType, milestoneNodeId, sourceFile, nodes, edges) {
  const lines = sectionContent.split("\n");
  let itemIndex = 0;
  let currentText = null;
  let currentSource = null;
  const flushItem = () => {
    if (!currentText) return;
    itemIndex += 1;
    const nodeId = `${idPrefix}:${milestoneId}:${itemIndex}`;
    const description = currentSource ? `${currentSource}` : void 0;
    nodes.push({
      id: nodeId,
      label: currentText,
      type: nodeType,
      description,
      confidence: "EXTRACTED",
      sourceFile
    });
    edges.push({
      from: milestoneNodeId,
      to: nodeId,
      type: "relates_to",
      confidence: "EXTRACTED"
    });
    currentText = null;
    currentSource = null;
  };
  for (const line of lines) {
    const bulletMatch = line.match(/^[-*]\s+(.+)/);
    if (bulletMatch) {
      flushItem();
      currentText = bulletMatch[1].trim();
      continue;
    }
    const sourceMatch = line.match(/^\s+Source:\s+(.+)/i);
    if (sourceMatch && currentText !== null) {
      currentSource = `Source: ${sourceMatch[1].trim()}`;
      continue;
    }
    const continuationMatch = line.match(/^\s{2,}(.+)/);
    if (continuationMatch && currentText !== null && currentSource === null) {
      currentText += " " + continuationMatch[1].trim();
    }
  }
  flushItem();
}
async function buildGraph(projectDir) {
  const gsdRoot = resolveGsdRoot(resolve(projectDir));
  const nodes = [];
  const edges = [];
  const parsers = [
    parseStateFile,
    parseKnowledgeFile,
    parseMilestoneFiles,
    parseLearningsFiles
  ];
  for (const parser of parsers) {
    try {
      parser(gsdRoot, nodes, edges);
    } catch {
      nodes.push({
        id: `error:${parser.name}:${Date.now()}`,
        label: `Parse error in ${parser.name}`,
        type: "concept",
        confidence: "AMBIGUOUS"
      });
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const dedupedNodes = nodes.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
  return {
    nodes: dedupedNodes,
    edges,
    builtAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function writeGraph(gsdRoot, graph) {
  const dir = graphsDir(gsdRoot);
  mkdirSync(dir, { recursive: true });
  const tmp = graphTmpPath(gsdRoot);
  const final = graphJsonPath(gsdRoot);
  writeFileSync(tmp, JSON.stringify(graph, null, 2), "utf-8");
  renameSync(tmp, final);
}
async function writeSnapshot(gsdRoot) {
  const src = graphJsonPath(gsdRoot);
  if (!existsSync(src)) return;
  const dir = graphsDir(gsdRoot);
  mkdirSync(dir, { recursive: true });
  const raw = readFileSync(src, "utf-8");
  let graph;
  try {
    graph = JSON.parse(raw);
  } catch {
    return;
  }
  const snapshot = { ...graph, snapshotAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeFileSync(snapshotPath(gsdRoot), JSON.stringify(snapshot, null, 2), "utf-8");
}
async function graphStatus(projectDir) {
  const gsdRoot = resolveGsdRoot(resolve(projectDir));
  const graphPath = graphJsonPath(gsdRoot);
  if (!existsSync(graphPath)) {
    return { exists: false };
  }
  try {
    const raw = readFileSync(graphPath, "utf-8");
    const graph = JSON.parse(raw);
    const builtAt = graph.builtAt;
    const ageMs = Date.now() - new Date(builtAt).getTime();
    const ageHours = ageMs / (1e3 * 60 * 60);
    const stale = ageHours > 24;
    return {
      exists: true,
      lastBuild: builtAt,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      stale,
      ageHours
    };
  } catch {
    return { exists: false };
  }
}
function applyBudget(graph, seedIds, budget) {
  const reachable = new Set(seedIds);
  const queue = [...seedIds];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const edge of graph.edges) {
      if (edge.from === current && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  let resultNodes = graph.nodes.filter((n) => reachable.has(n.id));
  let resultEdges = graph.edges.filter(
    (e) => reachable.has(e.from) && reachable.has(e.to)
  );
  const estimate = () => resultNodes.length * 20 + resultEdges.length * 10;
  if (estimate() > budget) {
    resultEdges = resultEdges.filter((e) => e.confidence !== "AMBIGUOUS");
  }
  if (estimate() > budget) {
    resultEdges = resultEdges.filter((e) => e.confidence !== "INFERRED");
  }
  if (estimate() > budget) {
    const seedNodes = resultNodes.filter((n) => seedIds.has(n.id));
    const seedEdges = resultEdges.filter(
      (e) => seedIds.has(e.from) && e.confidence === "EXTRACTED"
    );
    return { nodes: seedNodes, edges: seedEdges };
  }
  return { nodes: resultNodes, edges: resultEdges };
}
async function graphQuery(projectDir, term, budget = 4e3) {
  const gsdRoot = resolveGsdRoot(resolve(projectDir));
  const graphPath = graphJsonPath(gsdRoot);
  if (!existsSync(graphPath)) {
    return { nodes: [], edges: [], term, budget };
  }
  let graph;
  try {
    const raw = readFileSync(graphPath, "utf-8");
    graph = JSON.parse(raw);
  } catch {
    return { nodes: [], edges: [], term, budget };
  }
  if (!term || term.trim() === "") {
    return { nodes: [], edges: [], term, budget };
  }
  const lower = term.toLowerCase();
  const seedIds = new Set(
    graph.nodes.filter((n) => {
      const labelMatch = n.label.toLowerCase().includes(lower);
      const descMatch = n.description?.toLowerCase().includes(lower) ?? false;
      return labelMatch || descMatch;
    }).map((n) => n.id)
  );
  if (seedIds.size === 0) {
    return { nodes: [], edges: [], term, budget };
  }
  const result = applyBudget(graph, seedIds, budget);
  return { ...result, term, budget };
}
async function graphDiff(projectDir) {
  const gsdRoot = resolveGsdRoot(resolve(projectDir));
  const empty = {
    nodes: { added: [], removed: [], changed: [] },
    edges: { added: [], removed: [] }
  };
  const graphPath = graphJsonPath(gsdRoot);
  const snap = snapshotPath(gsdRoot);
  if (!existsSync(graphPath)) return empty;
  if (!existsSync(snap)) return empty;
  let current;
  let snapshot;
  try {
    current = JSON.parse(readFileSync(graphPath, "utf-8"));
  } catch {
    return empty;
  }
  try {
    snapshot = JSON.parse(readFileSync(snap, "utf-8"));
  } catch {
    return empty;
  }
  const currentNodeIds = new Set(current.nodes.map((n) => n.id));
  const snapshotNodeIds = new Set(snapshot.nodes.map((n) => n.id));
  const added = current.nodes.filter((n) => !snapshotNodeIds.has(n.id)).map((n) => n.id);
  const removed = snapshot.nodes.filter((n) => !currentNodeIds.has(n.id)).map((n) => n.id);
  const snapshotNodeMap = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const changed = current.nodes.filter((n) => {
    const snap2 = snapshotNodeMap.get(n.id);
    if (!snap2) return false;
    return n.label !== snap2.label || n.description !== snap2.description;
  }).map((n) => n.id);
  const edgeKey = (e) => `${e.from}->${e.to}:${e.type}`;
  const currentEdgeKeys = new Set(current.edges.map(edgeKey));
  const snapshotEdgeKeys = new Set(snapshot.edges.map(edgeKey));
  const edgesAdded = current.edges.filter((e) => !snapshotEdgeKeys.has(edgeKey(e))).map(edgeKey);
  const edgesRemoved = snapshot.edges.filter((e) => !currentEdgeKeys.has(edgeKey(e))).map(edgeKey);
  return {
    nodes: { added, removed, changed },
    edges: { added: edgesAdded, removed: edgesRemoved }
  };
}
export {
  buildGraph,
  graphDiff,
  graphQuery,
  graphStatus,
  writeGraph,
  writeSnapshot
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvbWNwLXNlcnZlci9zcmMvcmVhZGVycy9ncmFwaC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEIE1DUCBTZXJ2ZXIgXHUyMDE0IGtub3dsZWRnZSBncmFwaCByZWFkZXJcbi8vIENvcHlyaWdodCAoYykgMjAyNiBKZXJlbXkgTWNTcGFkZGVuIDxqZXJlbXlAZmx1eGxhYnMubmV0PlxuXG4vKipcbiAqIEtub3dsZWRnZSBHcmFwaCBmb3IgR1NEIHByb2plY3RzLlxuICpcbiAqIFBhcnNlcyAuZ3NkLyBhcnRpZmFjdHMgKFNUQVRFLm1kLCBtaWxlc3RvbmUgUk9BRE1BUHMsIHNsaWNlIFBMQU5zLFxuICogS05PV0xFREdFLm1kKSBpbnRvIGEgZ3JhcGggb2Ygbm9kZXMgYW5kIGVkZ2VzLiBQYXJzZSBlcnJvcnMgaW4gYW55XG4gKiBzaW5nbGUgYXJ0aWZhY3QgYXJlIGNhdWdodCBhbmQgbmV2ZXIgcHJvcGFnYXRlIFx1MjAxNCB0aGUgYXJ0aWZhY3QgaXMgc2tpcHBlZFxuICogYW5kIHRoZSByZXN0IG9mIHRoZSBncmFwaCBpcyByZXR1cm5lZC5cbiAqXG4gKiB3cml0ZUdyYXBoKCkgaXMgYXRvbWljOiB3cml0ZXMgdG8gZ3JhcGgudG1wLmpzb24gdGhlbiByZW5hbWVzIHRvIGdyYXBoLmpzb24uXG4gKi9cblxuaW1wb3J0IHsgcmVhZEZpbGVTeW5jLCB3cml0ZUZpbGVTeW5jLCByZW5hbWVTeW5jLCBleGlzdHNTeW5jLCBta2RpclN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGJhc2VuYW1lLCBqb2luLCByZXNvbHZlIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7XG4gIHJlc29sdmVHc2RSb290LFxuICBmaW5kTWlsZXN0b25lSWRzLFxuICByZXNvbHZlTWlsZXN0b25lRGlyLFxuICByZXNvbHZlTWlsZXN0b25lRmlsZSxcbiAgZmluZFNsaWNlSWRzLFxuICByZXNvbHZlU2xpY2VEaXIsXG59IGZyb20gJy4vcGF0aHMuanMnO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFR5cGVzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IHR5cGUgTm9kZVR5cGUgPVxuICB8ICdtaWxlc3RvbmUnXG4gIHwgJ3NsaWNlJ1xuICB8ICd0YXNrJ1xuICB8ICdydWxlJ1xuICB8ICdwYXR0ZXJuJ1xuICB8ICdsZXNzb24nXG4gIHwgJ2NvbmNlcHQnXG4gIHwgJ2RlY2lzaW9uJztcblxuZXhwb3J0IHR5cGUgRWRnZVR5cGUgPVxuICB8ICdjb250YWlucydcbiAgfCAnZGVwZW5kc19vbidcbiAgfCAncmVsYXRlc190bydcbiAgfCAnaW1wbGVtZW50cyc7XG5cbmV4cG9ydCB0eXBlIENvbmZpZGVuY2VUaWVyID0gJ0VYVFJBQ1RFRCcgfCAnSU5GRVJSRUQnIHwgJ0FNQklHVU9VUyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgR3JhcGhOb2RlIHtcbiAgaWQ6IHN0cmluZztcbiAgbGFiZWw6IHN0cmluZztcbiAgdHlwZTogTm9kZVR5cGU7XG4gIGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuICBjb25maWRlbmNlOiBDb25maWRlbmNlVGllcjtcbiAgc291cmNlRmlsZT86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBHcmFwaEVkZ2Uge1xuICBmcm9tOiBzdHJpbmc7XG4gIHRvOiBzdHJpbmc7XG4gIHR5cGU6IEVkZ2VUeXBlO1xuICBjb25maWRlbmNlOiBDb25maWRlbmNlVGllcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBLbm93bGVkZ2VHcmFwaCB7XG4gIG5vZGVzOiBHcmFwaE5vZGVbXTtcbiAgZWRnZXM6IEdyYXBoRWRnZVtdO1xuICBidWlsdEF0OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgR3JhcGhTdGF0dXNSZXN1bHQge1xuICBleGlzdHM6IGJvb2xlYW47XG4gIGxhc3RCdWlsZD86IHN0cmluZztcbiAgbm9kZUNvdW50PzogbnVtYmVyO1xuICBlZGdlQ291bnQ/OiBudW1iZXI7XG4gIHN0YWxlPzogYm9vbGVhbjtcbiAgYWdlSG91cnM/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgR3JhcGhRdWVyeVJlc3VsdCB7XG4gIG5vZGVzOiBHcmFwaE5vZGVbXTtcbiAgZWRnZXM6IEdyYXBoRWRnZVtdO1xuICB0ZXJtOiBzdHJpbmc7XG4gIGJ1ZGdldDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEdyYXBoRGlmZlJlc3VsdCB7XG4gIG5vZGVzOiB7XG4gICAgYWRkZWQ6IHN0cmluZ1tdO1xuICAgIHJlbW92ZWQ6IHN0cmluZ1tdO1xuICAgIGNoYW5nZWQ6IHN0cmluZ1tdO1xuICB9O1xuICBlZGdlczoge1xuICAgIGFkZGVkOiBzdHJpbmdbXTtcbiAgICByZW1vdmVkOiBzdHJpbmdbXTtcbiAgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBHcmFwaCBmaWxlIHBhdGhzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gZ3JhcGhzRGlyKGdzZFJvb3Q6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKGdzZFJvb3QsICdncmFwaHMnKTtcbn1cblxuZnVuY3Rpb24gZ3JhcGhKc29uUGF0aChnc2RSb290OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihncmFwaHNEaXIoZ3NkUm9vdCksICdncmFwaC5qc29uJyk7XG59XG5cbmZ1bmN0aW9uIGdyYXBoVG1wUGF0aChnc2RSb290OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihncmFwaHNEaXIoZ3NkUm9vdCksICdncmFwaC50bXAuanNvbicpO1xufVxuXG5mdW5jdGlvbiBzbmFwc2hvdFBhdGgoZ3NkUm9vdDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4oZ3JhcGhzRGlyKGdzZFJvb3QpLCAnLmxhc3QtYnVpbGQtc25hcHNob3QuanNvbicpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFBhcnNlcnMgXHUyMDE0IGVhY2ggcmV0dXJucyBub2Rlcy9lZGdlcyBhbmQgbmV2ZXIgdGhyb3dzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBQYXJzZSBTVEFURS5tZCBmb3IgYWN0aXZlIG1pbGVzdG9uZSBhbmQgcGhhc2UgY29uY2VwdHMuXG4gKi9cbmZ1bmN0aW9uIHBhcnNlU3RhdGVGaWxlKGdzZFJvb3Q6IHN0cmluZywgbm9kZXM6IEdyYXBoTm9kZVtdLCBfZWRnZXM6IEdyYXBoRWRnZVtdKTogdm9pZCB7XG4gIGNvbnN0IHN0YXRlUGF0aCA9IGpvaW4oZ3NkUm9vdCwgJ1NUQVRFLm1kJyk7XG4gIGlmICghZXhpc3RzU3luYyhzdGF0ZVBhdGgpKSByZXR1cm47XG5cbiAgbGV0IGNvbnRlbnQ6IHN0cmluZztcbiAgdHJ5IHtcbiAgICBjb250ZW50ID0gcmVhZEZpbGVTeW5jKHN0YXRlUGF0aCwgJ3V0Zi04Jyk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEV4dHJhY3QgYWN0aXZlIG1pbGVzdG9uZVxuICBjb25zdCBhY3RpdmVNaWxlc3RvbmVNYXRjaCA9IGNvbnRlbnQubWF0Y2goL1xcKlxcKkFjdGl2ZSBNaWxlc3RvbmU6XFwqXFwqXFxzKyhbQS1aXVxcZCspOlxccysoLispL2kpO1xuICBpZiAoYWN0aXZlTWlsZXN0b25lTWF0Y2gpIHtcbiAgICBjb25zdCBbLCBtaWxlc3RvbmVJZCwgdGl0bGVdID0gYWN0aXZlTWlsZXN0b25lTWF0Y2g7XG4gICAgY29uc3QgaWQgPSBgbWlsZXN0b25lOiR7bWlsZXN0b25lSWR9YDtcbiAgICBpZiAoIW5vZGVzLnNvbWUoKG4pID0+IG4uaWQgPT09IGlkKSkge1xuICAgICAgbm9kZXMucHVzaCh7XG4gICAgICAgIGlkLFxuICAgICAgICBsYWJlbDogYCR7bWlsZXN0b25lSWR9OiAke3RpdGxlLnRyaW0oKX1gLFxuICAgICAgICB0eXBlOiAnbWlsZXN0b25lJyxcbiAgICAgICAgZGVzY3JpcHRpb246IGBBY3RpdmUgbWlsZXN0b25lOiAke21pbGVzdG9uZUlkfWAsXG4gICAgICAgIGNvbmZpZGVuY2U6ICdFWFRSQUNURUQnLFxuICAgICAgICBzb3VyY2VGaWxlOiAnU1RBVEUubWQnLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gRXh0cmFjdCBwaGFzZSBhcyBjb25jZXB0XG4gIGNvbnN0IHBoYXNlTWF0Y2ggPSBjb250ZW50Lm1hdGNoKC9cXCpcXCpQaGFzZTpcXCpcXCpcXHMrKFxcUyspL2kpO1xuICBpZiAocGhhc2VNYXRjaCkge1xuICAgIGNvbnN0IHBoYXNlID0gcGhhc2VNYXRjaFsxXS50cmltKCk7XG4gICAgbm9kZXMucHVzaCh7XG4gICAgICBpZDogYGNvbmNlcHQ6cGhhc2U6JHtwaGFzZX1gLFxuICAgICAgbGFiZWw6IGBQaGFzZTogJHtwaGFzZX1gLFxuICAgICAgdHlwZTogJ2NvbmNlcHQnLFxuICAgICAgY29uZmlkZW5jZTogJ0VYVFJBQ1RFRCcsXG4gICAgICBzb3VyY2VGaWxlOiAnU1RBVEUubWQnLFxuICAgIH0pO1xuICB9XG59XG5cbi8qKlxuICogUGFyc2UgS05PV0xFREdFLm1kIGZvciBydWxlcywgcGF0dGVybnMsIGFuZCBsZXNzb25zLlxuICovXG5mdW5jdGlvbiBwYXJzZUtub3dsZWRnZUZpbGUoZ3NkUm9vdDogc3RyaW5nLCBub2RlczogR3JhcGhOb2RlW10sIF9lZGdlczogR3JhcGhFZGdlW10pOiB2b2lkIHtcbiAgY29uc3Qga25vd2xlZGdlUGF0aCA9IGpvaW4oZ3NkUm9vdCwgJ0tOT1dMRURHRS5tZCcpO1xuICBpZiAoIWV4aXN0c1N5bmMoa25vd2xlZGdlUGF0aCkpIHJldHVybjtcblxuICBsZXQgY29udGVudDogc3RyaW5nO1xuICB0cnkge1xuICAgIGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoa25vd2xlZGdlUGF0aCwgJ3V0Zi04Jyk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFBhcnNlIFJ1bGVzIHRhYmxlXG4gIGNvbnN0IHJ1bGVzTWF0Y2ggPSBjb250ZW50Lm1hdGNoKC8jIyBSdWxlc1xccypcXG4oW1xcc1xcU10qPykoPz1cXG4jIyB8JCkvaSk7XG4gIGlmIChydWxlc01hdGNoKSB7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIHJ1bGVzTWF0Y2hbMV0uc3BsaXQoJ1xcbicpKSB7XG4gICAgICBpZiAoIWxpbmUuaW5jbHVkZXMoJ3wnKSkgY29udGludWU7XG4gICAgICBjb25zdCBjZWxscyA9IGxpbmUuc3BsaXQoJ3wnKS5tYXAoKGMpID0+IGMudHJpbSgpKS5maWx0ZXIoQm9vbGVhbik7XG4gICAgICBpZiAoY2VsbHMubGVuZ3RoIDwgMykgY29udGludWU7XG4gICAgICBpZiAoY2VsbHNbMF0uc3RhcnRzV2l0aCgnIycpIHx8IGNlbGxzWzBdLnN0YXJ0c1dpdGgoJy0nKSkgY29udGludWU7XG4gICAgICBjb25zdCBpZCA9IGNlbGxzWzBdO1xuICAgICAgaWYgKCEvXktcXGQrJC9pLnRlc3QoaWQpKSBjb250aW51ZTtcbiAgICAgIG5vZGVzLnB1c2goe1xuICAgICAgICBpZDogYHJ1bGU6JHtpZH1gLFxuICAgICAgICBsYWJlbDogaWQsXG4gICAgICAgIHR5cGU6ICdydWxlJyxcbiAgICAgICAgZGVzY3JpcHRpb246IGNlbGxzWzJdID8/ICcnLFxuICAgICAgICBjb25maWRlbmNlOiAnRVhUUkFDVEVEJyxcbiAgICAgICAgc291cmNlRmlsZTogJ0tOT1dMRURHRS5tZCcsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICAvLyBQYXJzZSBQYXR0ZXJucyB0YWJsZVxuICBjb25zdCBwYXR0ZXJuc01hdGNoID0gY29udGVudC5tYXRjaCgvIyMgUGF0dGVybnNcXHMqXFxuKFtcXHNcXFNdKj8pKD89XFxuIyMgfCQpL2kpO1xuICBpZiAocGF0dGVybnNNYXRjaCkge1xuICAgIGZvciAoY29uc3QgbGluZSBvZiBwYXR0ZXJuc01hdGNoWzFdLnNwbGl0KCdcXG4nKSkge1xuICAgICAgaWYgKCFsaW5lLmluY2x1ZGVzKCd8JykpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgY2VsbHMgPSBsaW5lLnNwbGl0KCd8JykubWFwKChjKSA9PiBjLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pO1xuICAgICAgaWYgKGNlbGxzLmxlbmd0aCA8IDIpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNlbGxzWzBdLnN0YXJ0c1dpdGgoJyMnKSB8fCBjZWxsc1swXS5zdGFydHNXaXRoKCctJykpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgaWQgPSBjZWxsc1swXTtcbiAgICAgIGlmICghL15QXFxkKyQvaS50ZXN0KGlkKSkgY29udGludWU7XG4gICAgICBub2Rlcy5wdXNoKHtcbiAgICAgICAgaWQ6IGBwYXR0ZXJuOiR7aWR9YCxcbiAgICAgICAgbGFiZWw6IGlkLFxuICAgICAgICB0eXBlOiAncGF0dGVybicsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBjZWxsc1sxXSA/PyAnJyxcbiAgICAgICAgY29uZmlkZW5jZTogJ0VYVFJBQ1RFRCcsXG4gICAgICAgIHNvdXJjZUZpbGU6ICdLTk9XTEVER0UubWQnLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gUGFyc2UgTGVzc29ucyBMZWFybmVkIHRhYmxlXG4gIGNvbnN0IGxlc3NvbnNNYXRjaCA9IGNvbnRlbnQubWF0Y2goLyMjIExlc3NvbnMgTGVhcm5lZFxccypcXG4oW1xcc1xcU10qPykoPz1cXG4jIyB8JCkvaSk7XG4gIGlmIChsZXNzb25zTWF0Y2gpIHtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGVzc29uc01hdGNoWzFdLnNwbGl0KCdcXG4nKSkge1xuICAgICAgaWYgKCFsaW5lLmluY2x1ZGVzKCd8JykpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgY2VsbHMgPSBsaW5lLnNwbGl0KCd8JykubWFwKChjKSA9PiBjLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pO1xuICAgICAgaWYgKGNlbGxzLmxlbmd0aCA8IDIpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNlbGxzWzBdLnN0YXJ0c1dpdGgoJyMnKSB8fCBjZWxsc1swXS5zdGFydHNXaXRoKCctJykpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgaWQgPSBjZWxsc1swXTtcbiAgICAgIGlmICghL15MXFxkKyQvaS50ZXN0KGlkKSkgY29udGludWU7XG4gICAgICBub2Rlcy5wdXNoKHtcbiAgICAgICAgaWQ6IGBsZXNzb246JHtpZH1gLFxuICAgICAgICBsYWJlbDogaWQsXG4gICAgICAgIHR5cGU6ICdsZXNzb24nLFxuICAgICAgICBkZXNjcmlwdGlvbjogY2VsbHNbMV0gPz8gJycsXG4gICAgICAgIGNvbmZpZGVuY2U6ICdFWFRSQUNURUQnLFxuICAgICAgICBzb3VyY2VGaWxlOiAnS05PV0xFREdFLm1kJyxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufVxuXG4vKipcbiAqIFBhcnNlIG1pbGVzdG9uZSBST0FETUFQLm1kIGZpbGVzIGZvciBtaWxlc3RvbmVzIGFuZCBzbGljZXMuXG4gKi9cbmZ1bmN0aW9uIHBhcnNlTWlsZXN0b25lRmlsZXMoXG4gIGdzZFJvb3Q6IHN0cmluZyxcbiAgbm9kZXM6IEdyYXBoTm9kZVtdLFxuICBlZGdlczogR3JhcGhFZGdlW10sXG4pOiB2b2lkIHtcbiAgY29uc3QgbWlsZXN0b25lSWRzID0gZmluZE1pbGVzdG9uZUlkcyhnc2RSb290KTtcblxuICBmb3IgKGNvbnN0IG1pbGVzdG9uZUlkIG9mIG1pbGVzdG9uZUlkcykge1xuICAgIHRyeSB7XG4gICAgICBwYXJzZVNpbmdsZU1pbGVzdG9uZShnc2RSb290LCBtaWxlc3RvbmVJZCwgbm9kZXMsIGVkZ2VzKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFNraXAgdGhpcyBtaWxlc3RvbmUgb24gYW55IGVycm9yXG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHBhcnNlU2luZ2xlTWlsZXN0b25lKFxuICBnc2RSb290OiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4gIG5vZGVzOiBHcmFwaE5vZGVbXSxcbiAgZWRnZXM6IEdyYXBoRWRnZVtdLFxuKTogdm9pZCB7XG4gIGNvbnN0IG1EaXIgPSByZXNvbHZlTWlsZXN0b25lRGlyKGdzZFJvb3QsIG1pbGVzdG9uZUlkKTtcbiAgaWYgKCFtRGlyKSByZXR1cm47XG5cbiAgY29uc3QgbWlsZXN0b25lTm9kZUlkID0gYG1pbGVzdG9uZToke21pbGVzdG9uZUlkfWA7XG5cbiAgLy8gVHJ5IHRvIHJlYWQgdGhlIHJvYWRtYXAgZmlsZS4gQWNjZXB0IGJvdGggY2Fub25pY2FsIE0jIyMtUk9BRE1BUC5tZCBhbmRcbiAgLy8gbGVnYWN5IFJPQURNQVAubWQgdmlhIHRoZSBzaGFyZWQgcmVzb2x2ZXIuXG4gIGNvbnN0IHJvYWRtYXBQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoZ3NkUm9vdCwgbWlsZXN0b25lSWQsICdST0FETUFQJyk7XG4gIGxldCByb2FkbWFwQ29udGVudDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGlmIChyb2FkbWFwUGF0aCAmJiBleGlzdHNTeW5jKHJvYWRtYXBQYXRoKSkge1xuICAgIHRyeSB7XG4gICAgICByb2FkbWFwQ29udGVudCA9IHJlYWRGaWxlU3luYyhyb2FkbWFwUGF0aCwgJ3V0Zi04Jyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBTa2lwXG4gICAgfVxuICB9XG5cbiAgLy8gRXh0cmFjdCBtaWxlc3RvbmUgdGl0bGUgZnJvbSByb2FkbWFwXG4gIGxldCBtaWxlc3RvbmVUaXRsZSA9IG1pbGVzdG9uZUlkO1xuICBpZiAocm9hZG1hcENvbnRlbnQpIHtcbiAgICBjb25zdCB0aXRsZU1hdGNoID0gcm9hZG1hcENvbnRlbnQubWF0Y2goL14jXFxzK1tBLVpdXFxkKzpcXHMrKC4rKS9tKTtcbiAgICBpZiAodGl0bGVNYXRjaCkgbWlsZXN0b25lVGl0bGUgPSBgJHttaWxlc3RvbmVJZH06ICR7dGl0bGVNYXRjaFsxXS50cmltKCl9YDtcbiAgfVxuXG4gIC8vIEVuc3VyZSBtaWxlc3RvbmUgbm9kZSBleGlzdHNcbiAgaWYgKCFub2Rlcy5zb21lKChuKSA9PiBuLmlkID09PSBtaWxlc3RvbmVOb2RlSWQpKSB7XG4gICAgbm9kZXMucHVzaCh7XG4gICAgICBpZDogbWlsZXN0b25lTm9kZUlkLFxuICAgICAgbGFiZWw6IG1pbGVzdG9uZVRpdGxlLFxuICAgICAgdHlwZTogJ21pbGVzdG9uZScsXG4gICAgICBjb25maWRlbmNlOiAnRVhUUkFDVEVEJyxcbiAgICAgIHNvdXJjZUZpbGU6IHJvYWRtYXBDb250ZW50ID8gYG1pbGVzdG9uZXMvJHttaWxlc3RvbmVJZH0vJHtiYXNlbmFtZShyb2FkbWFwUGF0aCEpfWAgOiB1bmRlZmluZWQsXG4gICAgfSk7XG4gIH1cblxuICAvLyBQYXJzZSBzbGljZXMgZnJvbSByb2FkbWFwIHRhYmxlIG9yIGZpbGVzeXN0ZW1cbiAgY29uc3Qgc2xpY2VJZHMgPSBmaW5kU2xpY2VJZHMoZ3NkUm9vdCwgbWlsZXN0b25lSWQpO1xuICBmb3IgKGNvbnN0IHNsaWNlSWQgb2Ygc2xpY2VJZHMpIHtcbiAgICB0cnkge1xuICAgICAgcGFyc2VTaW5nbGVTbGljZShnc2RSb290LCBtaWxlc3RvbmVJZCwgc2xpY2VJZCwgbWlsZXN0b25lTm9kZUlkLCBub2RlcywgZWRnZXMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gU2tpcCB0aGlzIHNsaWNlIG9uIGFueSBlcnJvclxuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBwYXJzZVNpbmdsZVNsaWNlKFxuICBnc2RSb290OiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4gIHNsaWNlSWQ6IHN0cmluZyxcbiAgbWlsZXN0b25lTm9kZUlkOiBzdHJpbmcsXG4gIG5vZGVzOiBHcmFwaE5vZGVbXSxcbiAgZWRnZXM6IEdyYXBoRWRnZVtdLFxuKTogdm9pZCB7XG4gIGNvbnN0IHNEaXIgPSByZXNvbHZlU2xpY2VEaXIoZ3NkUm9vdCwgbWlsZXN0b25lSWQsIHNsaWNlSWQpO1xuICBpZiAoIXNEaXIpIHJldHVybjtcblxuICBjb25zdCBzbGljZU5vZGVJZCA9IGBzbGljZToke21pbGVzdG9uZUlkfToke3NsaWNlSWR9YDtcblxuICAvLyBUcnkgdG8gcmVhZCB0aGUgc2xpY2UgcGxhblxuICBjb25zdCBwbGFuUGF0aCA9IGpvaW4oc0RpciwgYCR7c2xpY2VJZH0tUExBTi5tZGApO1xuICBsZXQgc2xpY2VUaXRsZSA9IGAke21pbGVzdG9uZUlkfS8ke3NsaWNlSWR9YDtcbiAgbGV0IHBsYW5Db250ZW50OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICBpZiAoZXhpc3RzU3luYyhwbGFuUGF0aCkpIHtcbiAgICB0cnkge1xuICAgICAgcGxhbkNvbnRlbnQgPSByZWFkRmlsZVN5bmMocGxhblBhdGgsICd1dGYtOCcpO1xuICAgICAgY29uc3QgdGl0bGVNYXRjaCA9IHBsYW5Db250ZW50Lm1hdGNoKC9eI1xccytbQS1aXVxcZCs6XFxzKyguKykvbSk7XG4gICAgICBpZiAodGl0bGVNYXRjaCkgc2xpY2VUaXRsZSA9IGAke3NsaWNlSWR9OiAke3RpdGxlTWF0Y2hbMV0udHJpbSgpfWA7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBVc2UgZGVmYXVsdCB0aXRsZVxuICAgIH1cbiAgfVxuXG4gIG5vZGVzLnB1c2goe1xuICAgIGlkOiBzbGljZU5vZGVJZCxcbiAgICBsYWJlbDogc2xpY2VUaXRsZSxcbiAgICB0eXBlOiAnc2xpY2UnLFxuICAgIGNvbmZpZGVuY2U6ICdFWFRSQUNURUQnLFxuICAgIHNvdXJjZUZpbGU6IHBsYW5Db250ZW50ID8gYG1pbGVzdG9uZXMvJHttaWxlc3RvbmVJZH0vc2xpY2VzLyR7c2xpY2VJZH0vJHtzbGljZUlkfS1QTEFOLm1kYCA6IHVuZGVmaW5lZCxcbiAgfSk7XG5cbiAgLy8gRWRnZTogbWlsZXN0b25lIGNvbnRhaW5zIHNsaWNlXG4gIGVkZ2VzLnB1c2goe1xuICAgIGZyb206IG1pbGVzdG9uZU5vZGVJZCxcbiAgICB0bzogc2xpY2VOb2RlSWQsXG4gICAgdHlwZTogJ2NvbnRhaW5zJyxcbiAgICBjb25maWRlbmNlOiAnRVhUUkFDVEVEJyxcbiAgfSk7XG5cbiAgLy8gUGFyc2UgdGFza3MgZnJvbSB0aGUgc2xpY2UgcGxhblxuICBpZiAocGxhbkNvbnRlbnQpIHtcbiAgICBwYXJzZVRhc2tzRnJvbVBsYW4ocGxhbkNvbnRlbnQsIG1pbGVzdG9uZUlkLCBzbGljZUlkLCBzbGljZU5vZGVJZCwgbm9kZXMsIGVkZ2VzKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBwYXJzZVRhc2tzRnJvbVBsYW4oXG4gIGNvbnRlbnQ6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgc2xpY2VJZDogc3RyaW5nLFxuICBzbGljZU5vZGVJZDogc3RyaW5nLFxuICBub2RlczogR3JhcGhOb2RlW10sXG4gIGVkZ2VzOiBHcmFwaEVkZ2VbXSxcbik6IHZvaWQge1xuICAvLyBNYXRjaCBsaW5lcyBsaWtlOiAtIFsgXSAqKlQwMTogVGl0bGUqKiBcdTIwMTQgZGVzY3JpcHRpb25cbiAgY29uc3QgdGFza1BhdHRlcm4gPSAvWy0qXVxccytcXFtbIHhdXFxdXFxzK1xcKlxcKihUXFxkKyk6XFxzKihbXipdKylcXCpcXCovZztcbiAgbGV0IG1hdGNoOiBSZWdFeHBFeGVjQXJyYXkgfCBudWxsO1xuXG4gIHdoaWxlICgobWF0Y2ggPSB0YXNrUGF0dGVybi5leGVjKGNvbnRlbnQpKSAhPT0gbnVsbCkge1xuICAgIGNvbnN0IFssIHRhc2tJZCwgdGFza1RpdGxlXSA9IG1hdGNoO1xuICAgIGNvbnN0IHRhc2tOb2RlSWQgPSBgdGFzazoke21pbGVzdG9uZUlkfToke3NsaWNlSWR9OiR7dGFza0lkfWA7XG5cbiAgICBub2Rlcy5wdXNoKHtcbiAgICAgIGlkOiB0YXNrTm9kZUlkLFxuICAgICAgbGFiZWw6IGAke3Rhc2tJZH06ICR7dGFza1RpdGxlLnRyaW0oKX1gLFxuICAgICAgdHlwZTogJ3Rhc2snLFxuICAgICAgY29uZmlkZW5jZTogJ0VYVFJBQ1RFRCcsXG4gICAgfSk7XG5cbiAgICBlZGdlcy5wdXNoKHtcbiAgICAgIGZyb206IHNsaWNlTm9kZUlkLFxuICAgICAgdG86IHRhc2tOb2RlSWQsXG4gICAgICB0eXBlOiAnY29udGFpbnMnLFxuICAgICAgY29uZmlkZW5jZTogJ0VYVFJBQ1RFRCcsXG4gICAgfSk7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBMRUFSTklOR1MubWQgcGFyc2VyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBQYXJzZSBhbGwgKi1MRUFSTklOR1MubWQgZmlsZXMgZm91bmQgaW4gbWlsZXN0b25lIGRpcmVjdG9yaWVzLlxuICogRXh0cmFjdHMgRGVjaXNpb25zLCBMZXNzb25zLCBQYXR0ZXJucywgYW5kIFN1cnByaXNlcyBhcyB0eXBlZCBncmFwaCBub2Rlcy5cbiAqIFN1cnByaXNlcyBhcmUgbWFwcGVkIHRvIHRoZSAnbGVzc29uJyBOb2RlVHlwZSAobm8gZGlzdGluY3QgdHlwZSBleGlzdHMpLlxuICogUGFyc2UgZXJyb3JzIHBlciBmaWxlIGFyZSBjYXVnaHQgXHUyMDE0IHRoZSBmaWxlIGlzIHNraXBwZWQsIG5ldmVyIHJldGhyb3dzLlxuICovXG5mdW5jdGlvbiBwYXJzZUxlYXJuaW5nc0ZpbGVzKGdzZFJvb3Q6IHN0cmluZywgbm9kZXM6IEdyYXBoTm9kZVtdLCBlZGdlczogR3JhcGhFZGdlW10pOiB2b2lkIHtcbiAgY29uc3QgbWlsZXN0b25lSWRzID0gZmluZE1pbGVzdG9uZUlkcyhnc2RSb290KTtcblxuICBmb3IgKGNvbnN0IG1pbGVzdG9uZUlkIG9mIG1pbGVzdG9uZUlkcykge1xuICAgIHRyeSB7XG4gICAgICBwYXJzZVNpbmdsZUxlYXJuaW5nc0ZpbGUoZ3NkUm9vdCwgbWlsZXN0b25lSWQsIG5vZGVzLCBlZGdlcyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBTa2lwIHRoaXMgbWlsZXN0b25lJ3MgTEVBUk5JTkdTLm1kIG9uIGFueSBlcnJvclxuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBwYXJzZVNpbmdsZUxlYXJuaW5nc0ZpbGUoXG4gIGdzZFJvb3Q6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgbm9kZXM6IEdyYXBoTm9kZVtdLFxuICBlZGdlczogR3JhcGhFZGdlW10sXG4pOiB2b2lkIHtcbiAgY29uc3QgbURpciA9IHJlc29sdmVNaWxlc3RvbmVEaXIoZ3NkUm9vdCwgbWlsZXN0b25lSWQpO1xuICBpZiAoIW1EaXIpIHJldHVybjtcblxuICBjb25zdCBsZWFybmluZ3NQYXRoID0gam9pbihtRGlyLCBgJHttaWxlc3RvbmVJZH0tTEVBUk5JTkdTLm1kYCk7XG4gIGlmICghZXhpc3RzU3luYyhsZWFybmluZ3NQYXRoKSkgcmV0dXJuO1xuXG4gIGxldCBjb250ZW50OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgY29udGVudCA9IHJlYWRGaWxlU3luYyhsZWFybmluZ3NQYXRoLCAndXRmLTgnKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gU3RyaXAgWUFNTCBmcm9udG1hdHRlciBpZiBwcmVzZW50XG4gIGNvbnN0IHdpdGhvdXRGcm9udG1hdHRlciA9IGNvbnRlbnQucmVwbGFjZSgvXi0tLVtcXHNcXFNdKj8tLS1cXG4/LywgJycpO1xuXG4gIGNvbnN0IG1pbGVzdG9uZU5vZGVJZCA9IGBtaWxlc3RvbmU6JHttaWxlc3RvbmVJZH1gO1xuICBjb25zdCBzb3VyY2VGaWxlID0gYG1pbGVzdG9uZXMvJHttaWxlc3RvbmVJZH0vJHttaWxlc3RvbmVJZH0tTEVBUk5JTkdTLm1kYDtcblxuICAvLyBQYXJzZSBlYWNoIHNlY3Rpb246IFtzZWN0aW9uTmFtZSwgbm9kZVR5cGUsIGlkUHJlZml4XVxuICBjb25zdCBzZWN0aW9uczogQXJyYXk8W3N0cmluZywgTm9kZVR5cGUsIHN0cmluZ10+ID0gW1xuICAgIFsnRGVjaXNpb25zJywgJ2RlY2lzaW9uJywgJ2RlY2lzaW9uJ10sXG4gICAgWydMZXNzb25zJywgJ2xlc3NvbicsICdsZXNzb24nXSxcbiAgICBbJ1BhdHRlcm5zJywgJ3BhdHRlcm4nLCAncGF0dGVybiddLFxuICAgIFsnU3VycHJpc2VzJywgJ2xlc3NvbicsICdzdXJwcmlzZSddLFxuICBdO1xuXG4gIGZvciAoY29uc3QgW3NlY3Rpb25OYW1lLCBub2RlVHlwZSwgaWRQcmVmaXhdIG9mIHNlY3Rpb25zKSB7XG4gICAgY29uc3Qgc2VjdGlvbk1hdGNoID0gd2l0aG91dEZyb250bWF0dGVyLm1hdGNoKFxuICAgICAgbmV3IFJlZ0V4cChgIyNcXFxccyske3NlY3Rpb25OYW1lfVxcXFxzKlxcXFxuKFtcXFxcc1xcXFxTXSo/KSg/PVxcXFxuIyNcXFxcc3wkKWAsICdpJyksXG4gICAgKTtcbiAgICBpZiAoIXNlY3Rpb25NYXRjaCkgY29udGludWU7XG5cbiAgICBjb25zdCBzZWN0aW9uQ29udGVudCA9IHNlY3Rpb25NYXRjaFsxXTtcbiAgICBwYXJzZUxlYXJuaW5nc1NlY3Rpb24oXG4gICAgICBzZWN0aW9uQ29udGVudCxcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgaWRQcmVmaXgsXG4gICAgICBub2RlVHlwZSxcbiAgICAgIG1pbGVzdG9uZU5vZGVJZCxcbiAgICAgIHNvdXJjZUZpbGUsXG4gICAgICBub2RlcyxcbiAgICAgIGVkZ2VzLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcGFyc2VMZWFybmluZ3NTZWN0aW9uKFxuICBzZWN0aW9uQ29udGVudDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICBpZFByZWZpeDogc3RyaW5nLFxuICBub2RlVHlwZTogTm9kZVR5cGUsXG4gIG1pbGVzdG9uZU5vZGVJZDogc3RyaW5nLFxuICBzb3VyY2VGaWxlOiBzdHJpbmcsXG4gIG5vZGVzOiBHcmFwaE5vZGVbXSxcbiAgZWRnZXM6IEdyYXBoRWRnZVtdLFxuKTogdm9pZCB7XG4gIC8vIEVhY2ggaXRlbSBpcyBhIGJ1bGxldCBsaW5lIHN0YXJ0aW5nIHdpdGggXCItIFwiIGZvbGxvd2VkIGJ5IG9wdGlvbmFsXG4gIC8vIGluZGVudGVkIFwiU291cmNlOiAuLi5cIiBsaW5lLlxuICAvLyBXZSBjb2xsZWN0IGJ1bGxldCBpdGVtcyBhbmQgdGhlaXIgYXNzb2NpYXRlZCBzb3VyY2UgYXR0cmlidXRpb24uXG4gIGNvbnN0IGxpbmVzID0gc2VjdGlvbkNvbnRlbnQuc3BsaXQoJ1xcbicpO1xuICBsZXQgaXRlbUluZGV4ID0gMDtcbiAgbGV0IGN1cnJlbnRUZXh0OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgbGV0IGN1cnJlbnRTb3VyY2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4gIGNvbnN0IGZsdXNoSXRlbSA9ICgpOiB2b2lkID0+IHtcbiAgICBpZiAoIWN1cnJlbnRUZXh0KSByZXR1cm47XG4gICAgaXRlbUluZGV4ICs9IDE7XG4gICAgY29uc3Qgbm9kZUlkID0gYCR7aWRQcmVmaXh9OiR7bWlsZXN0b25lSWR9OiR7aXRlbUluZGV4fWA7XG4gICAgY29uc3QgZGVzY3JpcHRpb24gPSBjdXJyZW50U291cmNlID8gYCR7Y3VycmVudFNvdXJjZX1gIDogdW5kZWZpbmVkO1xuXG4gICAgbm9kZXMucHVzaCh7XG4gICAgICBpZDogbm9kZUlkLFxuICAgICAgbGFiZWw6IGN1cnJlbnRUZXh0LFxuICAgICAgdHlwZTogbm9kZVR5cGUsXG4gICAgICBkZXNjcmlwdGlvbixcbiAgICAgIGNvbmZpZGVuY2U6ICdFWFRSQUNURUQnLFxuICAgICAgc291cmNlRmlsZSxcbiAgICB9KTtcblxuICAgIC8vIEVkZ2U6IG1pbGVzdG9uZSByZWxhdGVzX3RvIHRoaXMgbGVhcm5pbmcgbm9kZVxuICAgIGVkZ2VzLnB1c2goe1xuICAgICAgZnJvbTogbWlsZXN0b25lTm9kZUlkLFxuICAgICAgdG86IG5vZGVJZCxcbiAgICAgIHR5cGU6ICdyZWxhdGVzX3RvJyxcbiAgICAgIGNvbmZpZGVuY2U6ICdFWFRSQUNURUQnLFxuICAgIH0pO1xuXG4gICAgY3VycmVudFRleHQgPSBudWxsO1xuICAgIGN1cnJlbnRTb3VyY2UgPSBudWxsO1xuICB9O1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGNvbnN0IGJ1bGxldE1hdGNoID0gbGluZS5tYXRjaCgvXlstKl1cXHMrKC4rKS8pO1xuICAgIGlmIChidWxsZXRNYXRjaCkge1xuICAgICAgZmx1c2hJdGVtKCk7XG4gICAgICBjdXJyZW50VGV4dCA9IGJ1bGxldE1hdGNoWzFdLnRyaW0oKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIEluZGVudGVkIHNvdXJjZSBhdHRyaWJ1dGlvbjogXCIgIFNvdXJjZTogLi4uXCJcbiAgICBjb25zdCBzb3VyY2VNYXRjaCA9IGxpbmUubWF0Y2goL15cXHMrU291cmNlOlxccysoLispL2kpO1xuICAgIGlmIChzb3VyY2VNYXRjaCAmJiBjdXJyZW50VGV4dCAhPT0gbnVsbCkge1xuICAgICAgY3VycmVudFNvdXJjZSA9IGBTb3VyY2U6ICR7c291cmNlTWF0Y2hbMV0udHJpbSgpfWA7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBDb250aW51YXRpb24gb2YgY3VycmVudCBpdGVtIHRleHQgKGluZGVudGVkIG5vbi1zb3VyY2UgbGluZSlcbiAgICBjb25zdCBjb250aW51YXRpb25NYXRjaCA9IGxpbmUubWF0Y2goL15cXHN7Mix9KC4rKS8pO1xuICAgIGlmIChjb250aW51YXRpb25NYXRjaCAmJiBjdXJyZW50VGV4dCAhPT0gbnVsbCAmJiBjdXJyZW50U291cmNlID09PSBudWxsKSB7XG4gICAgICBjdXJyZW50VGV4dCArPSAnICcgKyBjb250aW51YXRpb25NYXRjaFsxXS50cmltKCk7XG4gICAgfVxuICB9XG5cbiAgZmx1c2hJdGVtKCk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gYnVpbGRHcmFwaFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogQnVpbGQgYSBLbm93bGVkZ2VHcmFwaCBieSBwYXJzaW5nIGFsbCAuZ3NkLyBhcnRpZmFjdHMuXG4gKlxuICogUGFyc2UgZXJyb3JzIGluIGFueSBzaW5nbGUgYXJ0aWZhY3QgYXJlIGNhdWdodCBcdTIwMTQgdGhlIGFydGlmYWN0IGlzIHNraXBwZWRcbiAqIGFuZCBuZXZlciBjYXVzZXMgYnVpbGRHcmFwaCgpIHRvIHRocm93LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYnVpbGRHcmFwaChwcm9qZWN0RGlyOiBzdHJpbmcpOiBQcm9taXNlPEtub3dsZWRnZUdyYXBoPiB7XG4gIGNvbnN0IGdzZFJvb3QgPSByZXNvbHZlR3NkUm9vdChyZXNvbHZlKHByb2plY3REaXIpKTtcblxuICBjb25zdCBub2RlczogR3JhcGhOb2RlW10gPSBbXTtcbiAgY29uc3QgZWRnZXM6IEdyYXBoRWRnZVtdID0gW107XG5cbiAgLy8gRWFjaCBwYXJzZXIgaXMgd3JhcHBlZCBzbyBhIGNyYXNoIGluIG9uZSBuZXZlciBzdG9wcyBvdGhlcnNcbiAgY29uc3QgcGFyc2VyczogQXJyYXk8KGc6IHN0cmluZywgbjogR3JhcGhOb2RlW10sIGU6IEdyYXBoRWRnZVtdKSA9PiB2b2lkPiA9IFtcbiAgICBwYXJzZVN0YXRlRmlsZSxcbiAgICBwYXJzZUtub3dsZWRnZUZpbGUsXG4gICAgcGFyc2VNaWxlc3RvbmVGaWxlcyxcbiAgICBwYXJzZUxlYXJuaW5nc0ZpbGVzLFxuICBdO1xuXG4gIGZvciAoY29uc3QgcGFyc2VyIG9mIHBhcnNlcnMpIHtcbiAgICB0cnkge1xuICAgICAgcGFyc2VyKGdzZFJvb3QsIG5vZGVzLCBlZGdlcyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBQYXJzaW5nIGVycm9yIFx1MjAxNCBza2lwIHRoaXMgYXJ0aWZhY3QsIG1hcmsgYXMgYW1iaWd1b3VzXG4gICAgICBub2Rlcy5wdXNoKHtcbiAgICAgICAgaWQ6IGBlcnJvcjoke3BhcnNlci5uYW1lfToke0RhdGUubm93KCl9YCxcbiAgICAgICAgbGFiZWw6IGBQYXJzZSBlcnJvciBpbiAke3BhcnNlci5uYW1lfWAsXG4gICAgICAgIHR5cGU6ICdjb25jZXB0JyxcbiAgICAgICAgY29uZmlkZW5jZTogJ0FNQklHVU9VUycsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICAvLyBEZWR1cGxpY2F0ZSBub2RlcyBieSBpZCAoa2VlcCBmaXJzdCBvY2N1cnJlbmNlKVxuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGRlZHVwZWROb2RlcyA9IG5vZGVzLmZpbHRlcigobikgPT4ge1xuICAgIGlmIChzZWVuLmhhcyhuLmlkKSkgcmV0dXJuIGZhbHNlO1xuICAgIHNlZW4uYWRkKG4uaWQpO1xuICAgIHJldHVybiB0cnVlO1xuICB9KTtcblxuICByZXR1cm4ge1xuICAgIG5vZGVzOiBkZWR1cGVkTm9kZXMsXG4gICAgZWRnZXMsXG4gICAgYnVpbHRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIHdyaXRlR3JhcGggXHUyMDE0IGF0b21pYyB3cml0ZSB2aWEgdG1wICsgcmVuYW1lXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBXcml0ZSB0aGUgZ3JhcGggdG8gLmdzZC9ncmFwaHMvZ3JhcGguanNvbiBhdG9taWNhbGx5LlxuICpcbiAqIFdyaXRlcyB0byBncmFwaC50bXAuanNvbiBmaXJzdCwgdGhlbiByZW5hbWVzIHRvIGdyYXBoLmpzb24uXG4gKiBDcmVhdGVzIHRoZSBncmFwaHMvIGRpcmVjdG9yeSBpZiBpdCBkb2VzIG5vdCBleGlzdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdyaXRlR3JhcGgoZ3NkUm9vdDogc3RyaW5nLCBncmFwaDogS25vd2xlZGdlR3JhcGgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZGlyID0gZ3JhcGhzRGlyKGdzZFJvb3QpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICBjb25zdCB0bXAgPSBncmFwaFRtcFBhdGgoZ3NkUm9vdCk7XG4gIGNvbnN0IGZpbmFsID0gZ3JhcGhKc29uUGF0aChnc2RSb290KTtcblxuICB3cml0ZUZpbGVTeW5jKHRtcCwgSlNPTi5zdHJpbmdpZnkoZ3JhcGgsIG51bGwsIDIpLCAndXRmLTgnKTtcbiAgcmVuYW1lU3luYyh0bXAsIGZpbmFsKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyB3cml0ZVNuYXBzaG90XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBDb3B5IHRoZSBjdXJyZW50IGdyYXBoLmpzb24gdG8gLmxhc3QtYnVpbGQtc25hcHNob3QuanNvbi5cbiAqIEFkZHMgYSBzbmFwc2hvdEF0IHRpbWVzdGFtcCB0byB0aGUgY29weS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdyaXRlU25hcHNob3QoZ3NkUm9vdDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNyYyA9IGdyYXBoSnNvblBhdGgoZ3NkUm9vdCk7XG4gIGlmICghZXhpc3RzU3luYyhzcmMpKSByZXR1cm47XG5cbiAgY29uc3QgZGlyID0gZ3JhcGhzRGlyKGdzZFJvb3QpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoc3JjLCAndXRmLTgnKTtcbiAgbGV0IGdyYXBoOiBLbm93bGVkZ2VHcmFwaDtcbiAgdHJ5IHtcbiAgICBncmFwaCA9IEpTT04ucGFyc2UocmF3KSBhcyBLbm93bGVkZ2VHcmFwaDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHNuYXBzaG90ID0geyAuLi5ncmFwaCwgc25hcHNob3RBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH07XG5cbiAgd3JpdGVGaWxlU3luYyhzbmFwc2hvdFBhdGgoZ3NkUm9vdCksIEpTT04uc3RyaW5naWZ5KHNuYXBzaG90LCBudWxsLCAyKSwgJ3V0Zi04Jyk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZ3JhcGhTdGF0dXNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIFJldHVybiBzdGF0dXMgb2YgdGhlIGdyYXBoOiB3aGV0aGVyIGl0IGV4aXN0cywgaXRzIGFnZSwgYW5kIHdoZXRoZXIgaXQgaXMgc3RhbGUuXG4gKiBTdGFsZSBtZWFucyBidWlsdEF0IGlzIG9sZGVyIHRoYW4gMjQgaG91cnMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBncmFwaFN0YXR1cyhwcm9qZWN0RGlyOiBzdHJpbmcpOiBQcm9taXNlPEdyYXBoU3RhdHVzUmVzdWx0PiB7XG4gIGNvbnN0IGdzZFJvb3QgPSByZXNvbHZlR3NkUm9vdChyZXNvbHZlKHByb2plY3REaXIpKTtcbiAgY29uc3QgZ3JhcGhQYXRoID0gZ3JhcGhKc29uUGF0aChnc2RSb290KTtcblxuICBpZiAoIWV4aXN0c1N5bmMoZ3JhcGhQYXRoKSkge1xuICAgIHJldHVybiB7IGV4aXN0czogZmFsc2UgfTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGdyYXBoUGF0aCwgJ3V0Zi04Jyk7XG4gICAgY29uc3QgZ3JhcGggPSBKU09OLnBhcnNlKHJhdykgYXMgS25vd2xlZGdlR3JhcGg7XG5cbiAgICBjb25zdCBidWlsdEF0ID0gZ3JhcGguYnVpbHRBdDtcbiAgICBjb25zdCBhZ2VNcyA9IERhdGUubm93KCkgLSBuZXcgRGF0ZShidWlsdEF0KS5nZXRUaW1lKCk7XG4gICAgY29uc3QgYWdlSG91cnMgPSBhZ2VNcyAvICgxMDAwICogNjAgKiA2MCk7XG4gICAgY29uc3Qgc3RhbGUgPSBhZ2VIb3VycyA+IDI0O1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIGV4aXN0czogdHJ1ZSxcbiAgICAgIGxhc3RCdWlsZDogYnVpbHRBdCxcbiAgICAgIG5vZGVDb3VudDogZ3JhcGgubm9kZXMubGVuZ3RoLFxuICAgICAgZWRnZUNvdW50OiBncmFwaC5lZGdlcy5sZW5ndGgsXG4gICAgICBzdGFsZSxcbiAgICAgIGFnZUhvdXJzLFxuICAgIH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7IGV4aXN0czogZmFsc2UgfTtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGFwcGx5QnVkZ2V0IFx1MjAxNCB0cmltIGVkZ2VzIHRvIHN0YXkgd2l0aGluIHRva2VuIGJ1ZGdldFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogR2l2ZW4gYSBzZXQgb2Ygc2VlZCBub2RlIElEcyBhbmQgdGhlIGZ1bGwgZ3JhcGgsIGFwcGx5IEJGUyB0byBjb2xsZWN0XG4gKiByZWFjaGFibGUgbm9kZXMgYW5kIGVkZ2VzLiBUcmltcyBBTUJJR1VPVVMgZWRnZXMgZmlyc3QsIHRoZW4gSU5GRVJSRUQsXG4gKiBzdG9wcGluZyB3aGVuIHRoZSBlc3RpbWF0ZWQgdG9rZW4gY291bnQgZHJvcHMgd2l0aGluIGJ1ZGdldC5cbiAqXG4gKiBCdWRnZXQgaXMgYSByb3VnaCB0b2tlbiBlc3RpbWF0ZTogMSBub2RlIFx1MjI0OCAyMCB0b2tlbnMsIDEgZWRnZSBcdTIyNDggMTAgdG9rZW5zLlxuICovXG5mdW5jdGlvbiBhcHBseUJ1ZGdldChcbiAgZ3JhcGg6IEtub3dsZWRnZUdyYXBoLFxuICBzZWVkSWRzOiBTZXQ8c3RyaW5nPixcbiAgYnVkZ2V0OiBudW1iZXIsXG4pOiB7IG5vZGVzOiBHcmFwaE5vZGVbXTsgZWRnZXM6IEdyYXBoRWRnZVtdIH0ge1xuICAvLyBCRlMgdG8gY29sbGVjdCByZWFjaGFibGUgbm9kZXMgKHN0YXJ0IGZyb20gc2VlZHMpXG4gIGNvbnN0IHJlYWNoYWJsZSA9IG5ldyBTZXQ8c3RyaW5nPihzZWVkSWRzKTtcbiAgY29uc3QgcXVldWUgPSBbLi4uc2VlZElkc107XG5cbiAgd2hpbGUgKHF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBjdXJyZW50ID0gcXVldWUuc2hpZnQoKSE7XG4gICAgZm9yIChjb25zdCBlZGdlIG9mIGdyYXBoLmVkZ2VzKSB7XG4gICAgICBpZiAoZWRnZS5mcm9tID09PSBjdXJyZW50ICYmICFyZWFjaGFibGUuaGFzKGVkZ2UudG8pKSB7XG4gICAgICAgIHJlYWNoYWJsZS5hZGQoZWRnZS50byk7XG4gICAgICAgIHF1ZXVlLnB1c2goZWRnZS50byk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgbGV0IHJlc3VsdE5vZGVzID0gZ3JhcGgubm9kZXMuZmlsdGVyKChuKSA9PiByZWFjaGFibGUuaGFzKG4uaWQpKTtcbiAgbGV0IHJlc3VsdEVkZ2VzID0gZ3JhcGguZWRnZXMuZmlsdGVyKFxuICAgIChlKSA9PiByZWFjaGFibGUuaGFzKGUuZnJvbSkgJiYgcmVhY2hhYmxlLmhhcyhlLnRvKSxcbiAgKTtcblxuICAvLyBFc3RpbWF0ZSB0b2tlbnMgYW5kIHRyaW0gaWYgb3ZlciBidWRnZXRcbiAgLy8gVHJpbSBBTUJJR1VPVVMgZWRnZXMgZmlyc3QsIHRoZW4gSU5GRVJSRURcbiAgY29uc3QgZXN0aW1hdGUgPSAoKTogbnVtYmVyID0+XG4gICAgcmVzdWx0Tm9kZXMubGVuZ3RoICogMjAgKyByZXN1bHRFZGdlcy5sZW5ndGggKiAxMDtcblxuICBpZiAoZXN0aW1hdGUoKSA+IGJ1ZGdldCkge1xuICAgIHJlc3VsdEVkZ2VzID0gcmVzdWx0RWRnZXMuZmlsdGVyKChlKSA9PiBlLmNvbmZpZGVuY2UgIT09ICdBTUJJR1VPVVMnKTtcbiAgfVxuICBpZiAoZXN0aW1hdGUoKSA+IGJ1ZGdldCkge1xuICAgIHJlc3VsdEVkZ2VzID0gcmVzdWx0RWRnZXMuZmlsdGVyKChlKSA9PiBlLmNvbmZpZGVuY2UgIT09ICdJTkZFUlJFRCcpO1xuICB9XG4gIGlmIChlc3RpbWF0ZSgpID4gYnVkZ2V0KSB7XG4gICAgLy8gSGFyZCB0cmltIFx1MjAxNCBrZWVwIG9ubHkgc2VlZCBub2RlcyBhbmQgdGhlaXIgRVhUUkFDVEVEIGVkZ2VzXG4gICAgY29uc3Qgc2VlZE5vZGVzID0gcmVzdWx0Tm9kZXMuZmlsdGVyKChuKSA9PiBzZWVkSWRzLmhhcyhuLmlkKSk7XG4gICAgY29uc3Qgc2VlZEVkZ2VzID0gcmVzdWx0RWRnZXMuZmlsdGVyKFxuICAgICAgKGUpID0+IHNlZWRJZHMuaGFzKGUuZnJvbSkgJiYgZS5jb25maWRlbmNlID09PSAnRVhUUkFDVEVEJyxcbiAgICApO1xuICAgIHJldHVybiB7IG5vZGVzOiBzZWVkTm9kZXMsIGVkZ2VzOiBzZWVkRWRnZXMgfTtcbiAgfVxuXG4gIHJldHVybiB7IG5vZGVzOiByZXN1bHROb2RlcywgZWRnZXM6IHJlc3VsdEVkZ2VzIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZ3JhcGhRdWVyeVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogUXVlcnkgdGhlIGdyYXBoIGZvciBub2RlcyBtYXRjaGluZyBhIHRlcm0gKGNhc2UtaW5zZW5zaXRpdmUgb24gbGFiZWwgKyBkZXNjcmlwdGlvbikuXG4gKiBCRlMgZnJvbSBzZWVkIG5vZGVzLCBhcHBseWluZyBidWRnZXQgdHJpbW1pbmcuXG4gKlxuICogUmVhZHMgZnJvbSB0aGUgcHJlLWJ1aWx0IGdyYXBoLmpzb24uIEZhbGxzIGJhY2sgdG8gYW4gZW1wdHkgcmVzdWx0IGlmIG5vXG4gKiBncmFwaCBleGlzdHMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBncmFwaFF1ZXJ5KFxuICBwcm9qZWN0RGlyOiBzdHJpbmcsXG4gIHRlcm06IHN0cmluZyxcbiAgYnVkZ2V0ID0gNDAwMCxcbik6IFByb21pc2U8R3JhcGhRdWVyeVJlc3VsdD4ge1xuICBjb25zdCBnc2RSb290ID0gcmVzb2x2ZUdzZFJvb3QocmVzb2x2ZShwcm9qZWN0RGlyKSk7XG4gIGNvbnN0IGdyYXBoUGF0aCA9IGdyYXBoSnNvblBhdGgoZ3NkUm9vdCk7XG5cbiAgaWYgKCFleGlzdHNTeW5jKGdyYXBoUGF0aCkpIHtcbiAgICByZXR1cm4geyBub2RlczogW10sIGVkZ2VzOiBbXSwgdGVybSwgYnVkZ2V0IH07XG4gIH1cblxuICBsZXQgZ3JhcGg6IEtub3dsZWRnZUdyYXBoO1xuICB0cnkge1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhncmFwaFBhdGgsICd1dGYtOCcpO1xuICAgIGdyYXBoID0gSlNPTi5wYXJzZShyYXcpIGFzIEtub3dsZWRnZUdyYXBoO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBub2RlczogW10sIGVkZ2VzOiBbXSwgdGVybSwgYnVkZ2V0IH07XG4gIH1cblxuICBpZiAoIXRlcm0gfHwgdGVybS50cmltKCkgPT09ICcnKSB7XG4gICAgLy8gRW1wdHkgdGVybSBcdTIwMTQgcmV0dXJuIGVtcHR5IHJlc3VsdFxuICAgIHJldHVybiB7IG5vZGVzOiBbXSwgZWRnZXM6IFtdLCB0ZXJtLCBidWRnZXQgfTtcbiAgfVxuXG4gIGNvbnN0IGxvd2VyID0gdGVybS50b0xvd2VyQ2FzZSgpO1xuXG4gIC8vIEZpbmQgc2VlZCBub2RlcyB0aGF0IG1hdGNoIHRoZSB0ZXJtXG4gIGNvbnN0IHNlZWRJZHMgPSBuZXcgU2V0PHN0cmluZz4oXG4gICAgZ3JhcGgubm9kZXNcbiAgICAgIC5maWx0ZXIoKG4pID0+IHtcbiAgICAgICAgY29uc3QgbGFiZWxNYXRjaCA9IG4ubGFiZWwudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhsb3dlcik7XG4gICAgICAgIGNvbnN0IGRlc2NNYXRjaCA9IG4uZGVzY3JpcHRpb24/LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMobG93ZXIpID8/IGZhbHNlO1xuICAgICAgICByZXR1cm4gbGFiZWxNYXRjaCB8fCBkZXNjTWF0Y2g7XG4gICAgICB9KVxuICAgICAgLm1hcCgobikgPT4gbi5pZCksXG4gICk7XG5cbiAgaWYgKHNlZWRJZHMuc2l6ZSA9PT0gMCkge1xuICAgIHJldHVybiB7IG5vZGVzOiBbXSwgZWRnZXM6IFtdLCB0ZXJtLCBidWRnZXQgfTtcbiAgfVxuXG4gIGNvbnN0IHJlc3VsdCA9IGFwcGx5QnVkZ2V0KGdyYXBoLCBzZWVkSWRzLCBidWRnZXQpO1xuICByZXR1cm4geyAuLi5yZXN1bHQsIHRlcm0sIGJ1ZGdldCB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGdyYXBoRGlmZlxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogQ29tcGFyZSB0aGUgY3VycmVudCBncmFwaC5qc29uIHdpdGggLmxhc3QtYnVpbGQtc25hcHNob3QuanNvbi5cbiAqIFJldHVybnMgYWRkZWQvcmVtb3ZlZC9jaGFuZ2VkIG5vZGVzIGFuZCBhZGRlZC9yZW1vdmVkIGVkZ2VzLlxuICpcbiAqIElmIG5vIHNuYXBzaG90IGV4aXN0cywgcmV0dXJucyBlbXB0eSBkaWZmIGFycmF5cy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdyYXBoRGlmZihwcm9qZWN0RGlyOiBzdHJpbmcpOiBQcm9taXNlPEdyYXBoRGlmZlJlc3VsdD4ge1xuICBjb25zdCBnc2RSb290ID0gcmVzb2x2ZUdzZFJvb3QocmVzb2x2ZShwcm9qZWN0RGlyKSk7XG4gIGNvbnN0IGVtcHR5OiBHcmFwaERpZmZSZXN1bHQgPSB7XG4gICAgbm9kZXM6IHsgYWRkZWQ6IFtdLCByZW1vdmVkOiBbXSwgY2hhbmdlZDogW10gfSxcbiAgICBlZGdlczogeyBhZGRlZDogW10sIHJlbW92ZWQ6IFtdIH0sXG4gIH07XG5cbiAgY29uc3QgZ3JhcGhQYXRoID0gZ3JhcGhKc29uUGF0aChnc2RSb290KTtcbiAgY29uc3Qgc25hcCA9IHNuYXBzaG90UGF0aChnc2RSb290KTtcblxuICBpZiAoIWV4aXN0c1N5bmMoZ3JhcGhQYXRoKSkgcmV0dXJuIGVtcHR5O1xuICBpZiAoIWV4aXN0c1N5bmMoc25hcCkpIHJldHVybiBlbXB0eTtcblxuICBsZXQgY3VycmVudDogS25vd2xlZGdlR3JhcGg7XG4gIGxldCBzbmFwc2hvdDogS25vd2xlZGdlR3JhcGg7XG5cbiAgdHJ5IHtcbiAgICBjdXJyZW50ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoZ3JhcGhQYXRoLCAndXRmLTgnKSkgYXMgS25vd2xlZGdlR3JhcGg7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBlbXB0eTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgc25hcHNob3QgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhzbmFwLCAndXRmLTgnKSkgYXMgS25vd2xlZGdlR3JhcGg7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBlbXB0eTtcbiAgfVxuXG4gIGNvbnN0IGN1cnJlbnROb2RlSWRzID0gbmV3IFNldChjdXJyZW50Lm5vZGVzLm1hcCgobikgPT4gbi5pZCkpO1xuICBjb25zdCBzbmFwc2hvdE5vZGVJZHMgPSBuZXcgU2V0KHNuYXBzaG90Lm5vZGVzLm1hcCgobikgPT4gbi5pZCkpO1xuXG4gIGNvbnN0IGFkZGVkID0gY3VycmVudC5ub2Rlcy5maWx0ZXIoKG4pID0+ICFzbmFwc2hvdE5vZGVJZHMuaGFzKG4uaWQpKS5tYXAoKG4pID0+IG4uaWQpO1xuICBjb25zdCByZW1vdmVkID0gc25hcHNob3Qubm9kZXMuZmlsdGVyKChuKSA9PiAhY3VycmVudE5vZGVJZHMuaGFzKG4uaWQpKS5tYXAoKG4pID0+IG4uaWQpO1xuXG4gIC8vIENoYW5nZWQ6IHNhbWUgaWQgYnV0IGRpZmZlcmVudCBsYWJlbCBvciBkZXNjcmlwdGlvblxuICBjb25zdCBzbmFwc2hvdE5vZGVNYXAgPSBuZXcgTWFwKHNuYXBzaG90Lm5vZGVzLm1hcCgobikgPT4gW24uaWQsIG5dKSk7XG4gIGNvbnN0IGNoYW5nZWQgPSBjdXJyZW50Lm5vZGVzXG4gICAgLmZpbHRlcigobikgPT4ge1xuICAgICAgY29uc3Qgc25hcCA9IHNuYXBzaG90Tm9kZU1hcC5nZXQobi5pZCk7XG4gICAgICBpZiAoIXNuYXApIHJldHVybiBmYWxzZTtcbiAgICAgIHJldHVybiBuLmxhYmVsICE9PSBzbmFwLmxhYmVsIHx8IG4uZGVzY3JpcHRpb24gIT09IHNuYXAuZGVzY3JpcHRpb247XG4gICAgfSlcbiAgICAubWFwKChuKSA9PiBuLmlkKTtcblxuICAvLyBFZGdlcyBcdTIwMTQgY29tcGFyZSBieSBzdHJpbmcga2V5IFwiZnJvbS0+dG86dHlwZVwiXG4gIGNvbnN0IGVkZ2VLZXkgPSAoZTogR3JhcGhFZGdlKTogc3RyaW5nID0+IGAke2UuZnJvbX0tPiR7ZS50b306JHtlLnR5cGV9YDtcbiAgY29uc3QgY3VycmVudEVkZ2VLZXlzID0gbmV3IFNldChjdXJyZW50LmVkZ2VzLm1hcChlZGdlS2V5KSk7XG4gIGNvbnN0IHNuYXBzaG90RWRnZUtleXMgPSBuZXcgU2V0KHNuYXBzaG90LmVkZ2VzLm1hcChlZGdlS2V5KSk7XG5cbiAgY29uc3QgZWRnZXNBZGRlZCA9IGN1cnJlbnQuZWRnZXMuZmlsdGVyKChlKSA9PiAhc25hcHNob3RFZGdlS2V5cy5oYXMoZWRnZUtleShlKSkpLm1hcChlZGdlS2V5KTtcbiAgY29uc3QgZWRnZXNSZW1vdmVkID0gc25hcHNob3QuZWRnZXMuZmlsdGVyKChlKSA9PiAhY3VycmVudEVkZ2VLZXlzLmhhcyhlZGdlS2V5KGUpKSkubWFwKGVkZ2VLZXkpO1xuXG4gIHJldHVybiB7XG4gICAgbm9kZXM6IHsgYWRkZWQsIHJlbW92ZWQsIGNoYW5nZWQgfSxcbiAgICBlZGdlczogeyBhZGRlZDogZWRnZXNBZGRlZCwgcmVtb3ZlZDogZWRnZXNSZW1vdmVkIH0sXG4gIH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFjQSxTQUFTLGNBQWMsZUFBZSxZQUFZLFlBQVksaUJBQWlCO0FBQy9FLFNBQVMsVUFBVSxNQUFNLGVBQWU7QUFDeEM7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBOEVQ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QUFNLGFBQWEsTUFBTSxPQUFPLENBQUM7QUFBQSxFQUNuRCxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFFQSxRQUFNLGlCQUFpQixJQUFJLElBQUksUUFBUSxNQUFNLElBQUksQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDO0FBQzdELFFBQU0sa0JBQWtCLElBQUksSUFBSSxTQUFTLE1BQU0sSUFBSSxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUM7QUFFL0QsUUFBTSxRQUFRLFFBQVEsTUFBTSxPQUFPLENBQUMsTUFBTSxDQUFDLGdCQUFnQixJQUFJLEVBQUUsRUFBRSxDQUFDLEVBQUUsSUFBSSxDQUFDLE1BQU0sRUFBRSxFQUFFO0FBQ3JGLFFBQU0sVUFBVSxTQUFTLE1BQU0sT0FBTyxDQUFDLE1BQU0sQ0FBQyxlQUFlLElBQUksRUFBRSxFQUFFLENBQUMsRUFBRSxJQUFJLENBQUMsTUFBTSxFQUFFLEVBQUU7QUFHdkYsUUFBTSxrQkFBa0IsSUFBSSxJQUFJLFNBQVMsTUFBTSxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQztBQUNwRSxRQUFNLFVBQVUsUUFBUSxNQUNyQixPQUFPLENBQUMsTUFBTTtBQUNiLFVBQU1BLFFBQU8sZ0JBQWdCLElBQUksRUFBRSxFQUFFO0FBQ3JDLFFBQUksQ0FBQ0EsTUFBTSxRQUFPO0FBQ2xCLFdBQU8sRUFBRSxVQUFVQSxNQUFLLFNBQVMsRUFBRSxnQkFBZ0JBLE1BQUs7QUFBQSxFQUMxRCxDQUFDLEVBQ0EsSUFBSSxDQUFDLE1BQU0sRUFBRSxFQUFFO0FBR2xCLFFBQU0sVUFBVSxDQUFDLE1BQXlCLEdBQUcsRUFBRSxJQUFJLEtBQUssRUFBRSxFQUFFLElBQUksRUFBRSxJQUFJO0FBQ3RFLFFBQU0sa0JBQWtCLElBQUksSUFBSSxRQUFRLE1BQU0sSUFBSSxPQUFPLENBQUM7QUFDMUQsUUFBTSxtQkFBbUIsSUFBSSxJQUFJLFNBQVMsTUFBTSxJQUFJLE9BQU8sQ0FBQztBQUU1RCxRQUFNLGFBQWEsUUFBUSxNQUFNLE9BQU8sQ0FBQyxNQUFNLENBQUMsaUJBQWlCLElBQUksUUFBUSxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksT0FBTztBQUM3RixRQUFNLGVBQWUsU0FBUyxNQUFNLE9BQU8sQ0FBQyxNQUFNLENBQUMsZ0JBQWdCLElBQUksUUFBUSxDQUFDLENBQUMsQ0FBQyxFQUFFLElBQUksT0FBTztBQUUvRixTQUFPO0FBQUEsSUFDTCxPQUFPLEVBQUUsT0FBTyxTQUFTLFFBQVE7QUFBQSxJQUNqQyxPQUFPLEVBQUUsT0FBTyxZQUFZLFNBQVMsYUFBYTtBQUFBLEVBQ3BEO0FBQ0Y7IiwKICAibmFtZXMiOiBbInNuYXAiXQp9Cg==
