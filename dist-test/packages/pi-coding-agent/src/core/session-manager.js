import { randomUUID } from "crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync
} from "fs";
import { atomicWriteFileSync } from "./fs-utils.js";
import { readdir, readFile, stat } from "fs/promises";
import { join, resolve } from "path";
import { getAgentDir as getDefaultAgentDir, getBlobsDir, getSessionsDir } from "../config.js";
import { tryAcquireLockSync } from "./lock-utils.js";
import {
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage
} from "./messages.js";
import { BlobStore, externalizeImageData, isBlobRef, resolveImageData } from "./blob-store.js";
import { redactSecrets } from "./redact-secrets.js";
function pLimit(concurrency) {
  const queue = [];
  let active = 0;
  return (fn) => {
    return new Promise((resolve2, reject) => {
      const run = () => {
        active++;
        fn().then(resolve2, reject).finally(() => {
          active--;
          if (queue.length > 0) queue.shift()();
        });
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}
const BLOB_EXTERNALIZE_THRESHOLD = 1024;
const MAX_PERSIST_CHARS = 5e5;
const TRUNCATION_NOTICE = "\n\n[Session persistence truncated large content]";
const CURRENT_SESSION_VERSION = 3;
function createEmptyUsageTotals() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0
  };
}
function generateId(byId) {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!byId.has(id)) return id;
  }
  return randomUUID();
}
function migrateV1ToV2(entries) {
  const ids = /* @__PURE__ */ new Set();
  let prevId = null;
  for (const entry of entries) {
    if (entry.type === "session") {
      entry.version = 2;
      continue;
    }
    entry.id = generateId(ids);
    entry.parentId = prevId;
    prevId = entry.id;
    if (entry.type === "compaction") {
      const comp = entry;
      if (typeof comp.firstKeptEntryIndex === "number") {
        const targetEntry = entries[comp.firstKeptEntryIndex];
        if (targetEntry && targetEntry.type !== "session") {
          comp.firstKeptEntryId = targetEntry.id;
        }
        delete comp.firstKeptEntryIndex;
      }
    }
  }
}
function migrateV2ToV3(entries) {
  for (const entry of entries) {
    if (entry.type === "session") {
      entry.version = 3;
      continue;
    }
    if (entry.type === "message") {
      const msgEntry = entry;
      if (msgEntry.message && msgEntry.message.role === "hookMessage") {
        msgEntry.message.role = "custom";
      }
    }
  }
}
function migrateToCurrentVersion(entries) {
  const header = entries.find((e) => e.type === "session");
  const version = header?.version ?? 1;
  if (version >= CURRENT_SESSION_VERSION) return false;
  if (version < 2) migrateV1ToV2(entries);
  if (version < 3) migrateV2ToV3(entries);
  return true;
}
function migrateSessionEntries(entries) {
  migrateToCurrentVersion(entries);
}
function parseSessionEntries(content) {
  const entries = [];
  const lines = content.trim().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      entries.push(entry);
    } catch {
    }
  }
  return entries;
}
function getLatestCompactionEntry(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compaction") {
      return entries[i];
    }
  }
  return null;
}
function buildSessionContext(entries, leafId, byId) {
  if (!byId) {
    byId = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      byId.set(entry.id, entry);
    }
  }
  let leaf;
  if (leafId === null) {
    return { messages: [], thinkingLevel: "off", model: null };
  }
  if (leafId) {
    leaf = byId.get(leafId);
  }
  if (!leaf) {
    leaf = entries[entries.length - 1];
  }
  if (!leaf) {
    return { messages: [], thinkingLevel: "off", model: null };
  }
  const path = [];
  let current = leaf;
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : void 0;
  }
  let thinkingLevel = "off";
  let model = null;
  let compaction = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    } else if (entry.type === "compaction") {
      compaction = entry;
    }
  }
  const messages = [];
  const appendMessage = (entry) => {
    if (entry.type === "message") {
      messages.push(entry.message);
    } else if (entry.type === "custom_message") {
      messages.push(
        createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp)
      );
    } else if (entry.type === "branch_summary" && entry.summary) {
      messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
    }
  };
  if (compaction) {
    messages.push(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp));
    const compactionIdx = path.findIndex((e) => e.type === "compaction" && e.id === compaction.id);
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      const entry = path[i];
      if (entry.id === compaction.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (foundFirstKept) {
        appendMessage(entry);
      }
    }
    for (let i = compactionIdx + 1; i < path.length; i++) {
      const entry = path[i];
      appendMessage(entry);
    }
  } else {
    for (const entry of path) {
      appendMessage(entry);
    }
  }
  return { messages, thinkingLevel, model };
}
function getDefaultSessionDir(cwd) {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(getDefaultAgentDir(), "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}
function isImageBlock(value) {
  return typeof value === "object" && value !== null && "type" in value && value.type === "image" && "data" in value && typeof value.data === "string";
}
function truncateString(s, maxLength) {
  if (s.length <= maxLength) return s;
  if (maxLength > 0 && s.charCodeAt(maxLength - 1) >= 55296 && s.charCodeAt(maxLength - 1) <= 56319) {
    return s.slice(0, maxLength - 1);
  }
  return s.slice(0, maxLength);
}
function prepareForPersistence(obj, blobStore, key) {
  if (obj === null || obj === void 0) return obj;
  if (typeof obj === "string") {
    const isSignature = key === "thinkingSignature" || key === "thoughtSignature" || key === "textSignature";
    const redacted = isSignature ? obj : redactSecrets(obj);
    if (redacted.length > MAX_PERSIST_CHARS) {
      if (isSignature) {
        return "";
      }
      const limit = Math.max(0, MAX_PERSIST_CHARS - TRUNCATION_NOTICE.length);
      return `${truncateString(redacted, limit)}${TRUNCATION_NOTICE}`;
    }
    return redacted;
  }
  if (Array.isArray(obj)) {
    let changed = false;
    const result = obj.map((item) => {
      if (key === "content" && isImageBlock(item)) {
        if (!isBlobRef(item.data) && item.data.length >= BLOB_EXTERNALIZE_THRESHOLD) {
          changed = true;
          const blobRef = externalizeImageData(blobStore, item.data);
          return { ...item, data: blobRef };
        }
      }
      const newItem = prepareForPersistence(item, blobStore, key);
      if (newItem !== item) changed = true;
      return newItem;
    });
    return changed ? result : obj;
  }
  if (typeof obj === "object") {
    let changed = false;
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "partialJson" || k === "jsonlEvents") {
        changed = true;
        continue;
      }
      const newV = prepareForPersistence(v, blobStore, k);
      result[k] = newV;
      if (newV !== v) changed = true;
    }
    if (changed && "lineCount" in result && "content" in result && typeof result.content === "string") {
      result.lineCount = result.content.split("\n").length;
    }
    return changed ? result : obj;
  }
  return obj;
}
function resolveBlobRefsInEntries(entries, blobStore) {
  for (const entry of entries) {
    if (entry.type === "session") continue;
    let contentArray;
    if (entry.type === "message") {
      const content = entry.message.content;
      if (Array.isArray(content)) contentArray = content;
    } else if (entry.type === "custom_message" && Array.isArray(entry.content)) {
      contentArray = entry.content;
    }
    if (!contentArray) continue;
    for (const block of contentArray) {
      if (isImageBlock(block) && isBlobRef(block.data)) {
        block.data = resolveImageData(blobStore, block.data);
      }
    }
  }
}
function loadEntriesFromFile(filePath) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf8");
  const entries = [];
  const lines = content.trim().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      entries.push(entry);
    } catch {
    }
  }
  if (entries.length === 0) return entries;
  const header = entries[0];
  if (header.type !== "session" || typeof header.id !== "string") {
    return [];
  }
  return entries;
}
function isValidSessionFile(filePath) {
  try {
    const fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(512);
    const bytesRead = readSync(fd, buffer, 0, 512, 0);
    closeSync(fd);
    const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n")[0];
    if (!firstLine) return false;
    const header = JSON.parse(firstLine);
    return header.type === "session" && typeof header.id === "string";
  } catch {
    return false;
  }
}
function findMostRecentSession(sessionDir) {
  try {
    const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).map((f) => join(sessionDir, f)).filter(isValidSessionFile).map((path) => ({ path, mtime: statSync(path).mtime })).sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return files[0]?.path || null;
  } catch {
    return null;
  }
}
function isMessageWithContent(message) {
  return typeof message.role === "string" && "content" in message;
}
function extractTextContent(message) {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  return content.filter((block) => block.type === "text").map((block) => block.text).join(" ");
}
function getLastActivityTime(entries) {
  let lastActivityTime;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!isMessageWithContent(message)) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const msgTimestamp = message.timestamp;
    if (typeof msgTimestamp === "number") {
      lastActivityTime = Math.max(lastActivityTime ?? 0, msgTimestamp);
      continue;
    }
    const entryTimestamp = entry.timestamp;
    if (typeof entryTimestamp === "string") {
      const t = new Date(entryTimestamp).getTime();
      if (!Number.isNaN(t)) {
        lastActivityTime = Math.max(lastActivityTime ?? 0, t);
      }
    }
  }
  return lastActivityTime;
}
function getSessionModifiedDate(entries, header, statsMtime) {
  const lastActivityTime = getLastActivityTime(entries);
  if (typeof lastActivityTime === "number" && lastActivityTime > 0) {
    return new Date(lastActivityTime);
  }
  const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
  return !Number.isNaN(headerTime) ? new Date(headerTime) : statsMtime;
}
async function buildSessionInfo(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    const entries = [];
    const lines = content.trim().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
      }
    }
    if (entries.length === 0) return null;
    const header = entries[0];
    if (header.type !== "session") return null;
    const stats = await stat(filePath);
    let messageCount = 0;
    let firstMessage = "";
    const allMessages = [];
    let name;
    for (const entry of entries) {
      if (entry.type === "session_info") {
        const infoEntry = entry;
        if (infoEntry.name) {
          name = infoEntry.name.trim();
        }
      }
      if (entry.type !== "message") continue;
      messageCount++;
      const message = entry.message;
      if (!isMessageWithContent(message)) continue;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const textContent = extractTextContent(message);
      if (!textContent) continue;
      allMessages.push(textContent);
      if (!firstMessage && message.role === "user") {
        firstMessage = textContent;
      }
    }
    const cwd = typeof header.cwd === "string" ? header.cwd : "";
    const parentSessionPath = header.parentSession;
    const modified = getSessionModifiedDate(entries, header, stats.mtime);
    return {
      path: filePath,
      id: header.id,
      cwd,
      name,
      parentSessionPath,
      created: new Date(header.timestamp),
      modified,
      messageCount,
      firstMessage: firstMessage || "(no messages)",
      allMessagesText: allMessages.join(" ")
    };
  } catch {
    return null;
  }
}
async function listSessionsFromDir(dir, onProgress, progressOffset = 0, progressTotal) {
  const sessions = [];
  if (!existsSync(dir)) {
    return sessions;
  }
  try {
    const dirEntries = await readdir(dir);
    const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
    const total = progressTotal ?? files.length;
    let loaded = 0;
    const results = await Promise.all(
      files.map(async (file) => {
        const info = await buildSessionInfo(file);
        loaded++;
        onProgress?.(progressOffset + loaded, total);
        return info;
      })
    );
    for (const info of results) {
      if (info) {
        sessions.push(info);
      }
    }
  } catch {
  }
  return sessions;
}
class SessionManager {
  constructor(cwd, sessionDir, sessionFile, persist) {
    this.sessionId = "";
    this.flushed = false;
    this.fileEntries = [];
    this.sessionEntries = [];
    this.byId = /* @__PURE__ */ new Map();
    this.labelsById = /* @__PURE__ */ new Map();
    this.leafId = null;
    this.usageTotals = createEmptyUsageTotals();
    this.cwd = cwd;
    this.sessionDir = sessionDir;
    this.persist = persist;
    this.blobStore = new BlobStore(getBlobsDir());
    if (persist && sessionDir && !existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    if (sessionFile) {
      this.setSessionFile(sessionFile);
    } else {
      this.newSession();
    }
  }
  /**
   * Check if the last assistant turn in the session appears to have been
   * interrupted (e.g., the last message is from the assistant with tool_use
   * blocks but no subsequent tool_result message).
   */
  wasInterrupted() {
    for (let i = this.fileEntries.length - 1; i >= 0; i--) {
      const entry = this.fileEntries[i];
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role === "user") return false;
      if (msg.role === "assistant") {
        const content = Array.isArray(msg.content) ? msg.content : [];
        const hasToolUse = content.some(
          (block) => block.type === "toolCall"
        );
        if (hasToolUse) {
          return true;
        }
        return false;
      }
      return false;
    }
    return false;
  }
  /** Switch to a different session file (used for resume and branching) */
  setSessionFile(sessionFile) {
    this.sessionFile = resolve(sessionFile);
    if (existsSync(this.sessionFile)) {
      this.fileEntries = loadEntriesFromFile(this.sessionFile);
      if (this.fileEntries.length === 0) {
        const explicitPath = this.sessionFile;
        this.newSession();
        this.sessionFile = explicitPath;
        this._rewriteFile();
        this.flushed = true;
        return;
      }
      const header = this.fileEntries.find((e) => e.type === "session");
      this.sessionId = header?.id ?? randomUUID();
      if (migrateToCurrentVersion(this.fileEntries)) {
        this._rewriteFile();
      }
      this._buildIndex();
      resolveBlobRefsInEntries(this.fileEntries, this.blobStore);
      this.flushed = true;
    } else {
      const explicitPath = this.sessionFile;
      this.newSession();
      this.sessionFile = explicitPath;
    }
  }
  newSession(options) {
    this.sessionId = randomUUID();
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: this.sessionId,
      timestamp,
      cwd: this.cwd,
      parentSession: options?.parentSession
    };
    this.fileEntries = [header];
    this.sessionEntries = [];
    this.byId.clear();
    this.labelsById.clear();
    this.leafId = null;
    this.usageTotals = createEmptyUsageTotals();
    this.flushed = false;
    if (this.persist) {
      const fileTimestamp = timestamp.replace(/[:.]/g, "-");
      this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
    }
    return this.sessionFile;
  }
  _buildIndex() {
    this.sessionEntries = [];
    this.byId.clear();
    this.labelsById.clear();
    this.leafId = null;
    this.usageTotals = createEmptyUsageTotals();
    for (const entry of this.fileEntries) {
      if (entry.type === "session") continue;
      this.sessionEntries.push(entry);
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;
      this._accumulateUsage(entry);
      if (entry.type === "label") {
        if (entry.label) {
          this.labelsById.set(entry.targetId, entry.label);
        } else {
          this.labelsById.delete(entry.targetId);
        }
      }
    }
  }
  _rewriteFile() {
    if (!this.persist || !this.sessionFile) return;
    const content = `${this.fileEntries.map((e) => JSON.stringify(prepareForPersistence(e, this.blobStore))).join("\n")}
`;
    let release;
    try {
      release = tryAcquireLockSync(this.sessionFile);
      atomicWriteFileSync(this.sessionFile, content);
    } finally {
      release?.();
    }
  }
  isPersisted() {
    return this.persist;
  }
  getCwd() {
    return this.cwd;
  }
  getSessionDir() {
    return this.sessionDir;
  }
  getSessionId() {
    return this.sessionId;
  }
  getSessionFile() {
    return this.sessionFile;
  }
  _persist(entry) {
    if (!this.persist || !this.sessionFile) return;
    const hasAssistant = this.fileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
    if (!hasAssistant) {
      this.flushed = false;
      return;
    }
    let release;
    try {
      release = tryAcquireLockSync(this.sessionFile);
      if (!this.flushed) {
        for (const e of this.fileEntries) {
          const prepared = prepareForPersistence(e, this.blobStore);
          appendFileSync(this.sessionFile, `${JSON.stringify(prepared)}
`);
        }
        this.flushed = true;
      } else {
        const prepared = prepareForPersistence(entry, this.blobStore);
        appendFileSync(this.sessionFile, `${JSON.stringify(prepared)}
`);
      }
    } finally {
      release?.();
    }
  }
  _appendEntry(entry) {
    this.fileEntries.push(entry);
    this.sessionEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this._accumulateUsage(entry);
    this._persist(entry);
  }
  _accumulateUsage(entry) {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      return;
    }
    const usage = entry.message.usage;
    if (!usage) {
      return;
    }
    this.usageTotals.input += usage.input;
    this.usageTotals.output += usage.output;
    this.usageTotals.cacheRead += usage.cacheRead;
    this.usageTotals.cacheWrite += usage.cacheWrite;
    this.usageTotals.cost += usage.cost.total;
  }
  /** Append a message as child of current leaf, then advance leaf. Returns entry id.
   * Does not allow writing CompactionSummaryMessage and BranchSummaryMessage directly.
   * Reason: we want these to be top-level entries in the session, not message session entries,
   * so it is easier to find them.
   * These need to be appended via appendCompaction() and appendBranchSummary() methods.
   */
  appendMessage(message) {
    const entry = {
      type: "message",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      message
    };
    this._appendEntry(entry);
    return entry.id;
  }
  /** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
  appendThinkingLevelChange(thinkingLevel) {
    const entry = {
      type: "thinking_level_change",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      thinkingLevel
    };
    this._appendEntry(entry);
    return entry.id;
  }
  /** Append a model change as child of current leaf, then advance leaf. Returns entry id. */
  appendModelChange(provider, modelId) {
    const entry = {
      type: "model_change",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      provider,
      modelId
    };
    this._appendEntry(entry);
    return entry.id;
  }
  /** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
  appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook) {
    const entry = {
      type: "compaction",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook
    };
    this._appendEntry(entry);
    return entry.id;
  }
  /** Append a custom entry (for extensions) as child of current leaf, then advance leaf. Returns entry id. */
  appendCustomEntry(customType, data) {
    const entry = {
      type: "custom",
      customType,
      data,
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    this._appendEntry(entry);
    return entry.id;
  }
  /** Append a session info entry (e.g., display name). Returns entry id. */
  appendSessionInfo(name) {
    const entry = {
      type: "session_info",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      name: name.trim()
    };
    this._appendEntry(entry);
    return entry.id;
  }
  /** Get the current session name from the latest session_info entry, if any. */
  getSessionName() {
    const entries = this.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "session_info" && entry.name) {
        return entry.name;
      }
    }
    return void 0;
  }
  /**
   * Append a custom message entry (for extensions) that participates in LLM context.
   * @param customType Extension identifier for filtering on reload
   * @param content Message content (string or TextContent/ImageContent array)
   * @param display Whether to show in TUI (true = styled display, false = hidden)
   * @param details Optional extension-specific metadata (not sent to LLM)
   * @returns Entry id
   */
  appendCustomMessageEntry(customType, content, display, details) {
    const entry = {
      type: "custom_message",
      customType,
      content,
      display,
      details,
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    this._appendEntry(entry);
    return entry.id;
  }
  // =========================================================================
  // Tree Traversal
  // =========================================================================
  getLeafId() {
    return this.leafId;
  }
  getLeafEntry() {
    return this.leafId ? this.byId.get(this.leafId) : void 0;
  }
  getEntry(id) {
    return this.byId.get(id);
  }
  /**
   * Get all direct children of an entry.
   */
  getChildren(parentId) {
    const children = [];
    for (const entry of this.byId.values()) {
      if (entry.parentId === parentId) {
        children.push(entry);
      }
    }
    return children;
  }
  /**
   * Get the label for an entry, if any.
   */
  getLabel(id) {
    return this.labelsById.get(id);
  }
  /**
   * Set or clear a label on an entry.
   * Labels are user-defined markers for bookmarking/navigation.
   * Pass undefined or empty string to clear the label.
   */
  appendLabelChange(targetId, label) {
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }
    const entry = {
      type: "label",
      id: generateId(this.byId),
      parentId: this.leafId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      targetId,
      label
    };
    this._appendEntry(entry);
    if (label) {
      this.labelsById.set(targetId, label);
    } else {
      this.labelsById.delete(targetId);
    }
    return entry.id;
  }
  /**
   * Walk from entry to root, returning all entries in path order.
   * Includes all entry types (messages, compaction, model changes, etc.).
   * Use buildSessionContext() to get the resolved messages for the LLM.
   */
  getBranch(fromId) {
    const path = [];
    const startId = fromId ?? this.leafId;
    let current = startId ? this.byId.get(startId) : void 0;
    while (current) {
      path.unshift(current);
      current = current.parentId ? this.byId.get(current.parentId) : void 0;
    }
    return path;
  }
  /**
   * Build the session context (what gets sent to the LLM).
   * Uses tree traversal from current leaf.
   */
  buildSessionContext() {
    return buildSessionContext(this.getEntries(), this.leafId, this.byId);
  }
  /**
   * Get session header.
   */
  getHeader() {
    const h = this.fileEntries.find((e) => e.type === "session");
    return h ? h : null;
  }
  /**
   * Get all session entries (excludes header). Returns a shallow copy.
   * The session is append-only: use appendXXX() to add entries, branch() to
   * change the leaf pointer. Entries cannot be modified or deleted.
   */
  getEntries() {
    return [...this.sessionEntries];
  }
  getUsageTotals() {
    return { ...this.usageTotals };
  }
  /**
   * Get the session as a tree structure. Returns a shallow defensive copy of all entries.
   * A well-formed session has exactly one root (first entry with parentId === null).
   * Orphaned entries (broken parent chain) are also returned as roots.
   */
  getTree() {
    const entries = this.getEntries();
    const nodeMap = /* @__PURE__ */ new Map();
    const roots = [];
    for (const entry of entries) {
      const label = this.labelsById.get(entry.id);
      nodeMap.set(entry.id, { entry, children: [], label });
    }
    for (const entry of entries) {
      const node = nodeMap.get(entry.id);
      if (entry.parentId === null || entry.parentId === entry.id) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(entry.parentId);
        if (parent) {
          parent.children.push(node);
        } else {
          roots.push(node);
        }
      }
    }
    const stack = [...roots];
    while (stack.length > 0) {
      const node = stack.pop();
      node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
      stack.push(...node.children);
    }
    return roots;
  }
  // =========================================================================
  // Branching
  // =========================================================================
  /**
   * Start a new branch from an earlier entry.
   * Moves the leaf pointer to the specified entry. The next appendXXX() call
   * will create a child of that entry, forming a new branch. Existing entries
   * are not modified or deleted.
   */
  branch(branchFromId) {
    if (!this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
  }
  /**
   * Reset the leaf pointer to null (before any entries).
   * The next appendXXX() call will create a new root entry (parentId = null).
   * Use this when navigating to re-edit the first user message.
   */
  resetLeaf() {
    this.leafId = null;
  }
  /**
   * Start a new branch with a summary of the abandoned path.
   * Same as branch(), but also appends a branch_summary entry that captures
   * context from the abandoned conversation path.
   */
  branchWithSummary(branchFromId, summary, details, fromHook) {
    if (branchFromId !== null && !this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
    const entry = {
      type: "branch_summary",
      id: generateId(this.byId),
      parentId: branchFromId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      fromId: branchFromId ?? "root",
      summary,
      details,
      fromHook
    };
    this._appendEntry(entry);
    return entry.id;
  }
  /**
   * Create a new session file containing only the path from root to the specified leaf.
   * Useful for extracting a single conversation path from a branched session.
   * Returns the new session file path, or undefined if not persisting.
   */
  createBranchedSession(leafId) {
    const previousSessionFile = this.sessionFile;
    const path = this.getBranch(leafId);
    if (path.length === 0) {
      throw new Error(`Entry ${leafId} not found`);
    }
    const pathWithoutLabels = path.filter((e) => e.type !== "label");
    const newSessionId = randomUUID();
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    const newSessionFile = join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: newSessionId,
      timestamp,
      cwd: this.cwd,
      parentSession: this.persist ? previousSessionFile : void 0
    };
    const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
    const labelsToWrite = [];
    for (const [targetId, label] of this.labelsById) {
      if (pathEntryIds.has(targetId)) {
        labelsToWrite.push({ targetId, label });
      }
    }
    if (this.persist) {
      const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
      let parentId2 = lastEntryId;
      const labelEntries2 = [];
      for (const { targetId, label } of labelsToWrite) {
        const labelEntry = {
          type: "label",
          id: generateId(new Set(pathEntryIds)),
          parentId: parentId2,
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          targetId,
          label
        };
        pathEntryIds.add(labelEntry.id);
        labelEntries2.push(labelEntry);
        parentId2 = labelEntry.id;
      }
      this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries2];
      this.sessionId = newSessionId;
      this.sessionFile = newSessionFile;
      this._buildIndex();
      const hasAssistant = this.fileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
      if (hasAssistant) {
        this._rewriteFile();
        this.flushed = true;
      } else {
        this.flushed = false;
      }
      return newSessionFile;
    }
    const labelEntries = [];
    let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
    for (const { targetId, label } of labelsToWrite) {
      const labelEntry = {
        type: "label",
        id: generateId(/* @__PURE__ */ new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
        parentId,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        targetId,
        label
      };
      labelEntries.push(labelEntry);
      parentId = labelEntry.id;
    }
    this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
    this.sessionId = newSessionId;
    this._buildIndex();
    return void 0;
  }
  /**
   * Create a new session.
   * @param cwd Working directory (stored in session header)
   * @param sessionDir Optional session directory. If omitted, uses default (~/.pi/agent/sessions/<encoded-cwd>/).
   */
  static create(cwd, sessionDir) {
    const dir = sessionDir ?? getDefaultSessionDir(cwd);
    return new SessionManager(cwd, dir, void 0, true);
  }
  /**
   * Open a specific session file.
   * @param path Path to session file
   * @param sessionDir Optional session directory for /new or /branch. If omitted, derives from file's parent.
   */
  static open(path, sessionDir) {
    const entries = loadEntriesFromFile(path);
    const header = entries.find((e) => e.type === "session");
    const cwd = header?.cwd ?? process.cwd();
    const dir = sessionDir ?? resolve(path, "..");
    return new SessionManager(cwd, dir, path, true);
  }
  /**
   * Continue the most recent session, or create new if none.
   * @param cwd Working directory
   * @param sessionDir Optional session directory. If omitted, uses default (~/.pi/agent/sessions/<encoded-cwd>/).
   */
  static continueRecent(cwd, sessionDir) {
    const dir = sessionDir ?? getDefaultSessionDir(cwd);
    const mostRecent = findMostRecentSession(dir);
    if (mostRecent) {
      return new SessionManager(cwd, dir, mostRecent, true);
    }
    return new SessionManager(cwd, dir, void 0, true);
  }
  /** Create an in-memory session (no file persistence) */
  static inMemory(cwd = process.cwd()) {
    return new SessionManager(cwd, "", void 0, false);
  }
  /**
   * Fork a session from another project directory into the current project.
   * Creates a new session in the target cwd with the full history from the source session.
   * @param sourcePath Path to the source session file
   * @param targetCwd Target working directory (where the new session will be stored)
   * @param sessionDir Optional session directory. If omitted, uses default for targetCwd.
   */
  static forkFrom(sourcePath, targetCwd, sessionDir) {
    const sourceEntries = loadEntriesFromFile(sourcePath);
    if (sourceEntries.length === 0) {
      throw new Error(`Cannot fork: source session file is empty or invalid: ${sourcePath}`);
    }
    const sourceHeader = sourceEntries.find((e) => e.type === "session");
    if (!sourceHeader) {
      throw new Error(`Cannot fork: source session has no header: ${sourcePath}`);
    }
    const dir = sessionDir ?? getDefaultSessionDir(targetCwd);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const newSessionId = randomUUID();
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    const newSessionFile = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);
    const newHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: newSessionId,
      timestamp,
      cwd: targetCwd,
      parentSession: sourcePath
    };
    const lines = [JSON.stringify(newHeader)];
    for (const entry of sourceEntries) {
      if (entry.type !== "session") {
        lines.push(JSON.stringify(entry));
      }
    }
    atomicWriteFileSync(newSessionFile, lines.join("\n") + "\n");
    return new SessionManager(targetCwd, dir, newSessionFile, true);
  }
  /**
   * List all sessions for a directory.
   * @param cwd Working directory (used to compute default session directory)
   * @param sessionDir Optional session directory. If omitted, uses default (~/.pi/agent/sessions/<encoded-cwd>/).
   * @param onProgress Optional callback for progress updates (loaded, total)
   */
  static async list(cwd, sessionDir, onProgress) {
    const dir = sessionDir ?? getDefaultSessionDir(cwd);
    const sessions = await listSessionsFromDir(dir, onProgress);
    sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    return sessions;
  }
  /**
   * List all sessions across all project directories.
   * @param onProgress Optional callback for progress updates (loaded, total)
   */
  static async listAll(onProgress) {
    const sessionsDir = getSessionsDir();
    try {
      if (!existsSync(sessionsDir)) {
        return [];
      }
      const entries = await readdir(sessionsDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(sessionsDir, e.name));
      let totalFiles = 0;
      const dirFiles = [];
      for (const dir of dirs) {
        try {
          const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
          dirFiles.push(files.map((f) => join(dir, f)));
          totalFiles += files.length;
        } catch {
          dirFiles.push([]);
        }
      }
      let loaded = 0;
      const sessions = [];
      const allFiles = dirFiles.flat();
      const limit = pLimit(10);
      const results = await Promise.all(
        allFiles.map(
          (file) => limit(async () => {
            const info = await buildSessionInfo(file);
            loaded++;
            onProgress?.(loaded, totalFiles);
            return info;
          })
        )
      );
      for (const info of results) {
        if (info) {
          sessions.push(info);
        }
      }
      sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
      return sessions;
    } catch {
      return [];
    }
  }
}
export {
  CURRENT_SESSION_VERSION,
  SessionManager,
  buildSessionContext,
  getLatestCompactionEntry,
  migrateSessionEntries,
  parseSessionEntries
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Nlc3Npb24tbWFuYWdlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBBZ2VudE1lc3NhZ2UgfSBmcm9tIFwiQGdzZC9waS1hZ2VudC1jb3JlXCI7XG5pbXBvcnQgdHlwZSB7IEltYWdlQ29udGVudCwgTWVzc2FnZSwgVGV4dENvbnRlbnQgfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gXCJjcnlwdG9cIjtcbmltcG9ydCB7XG5cdGFwcGVuZEZpbGVTeW5jLFxuXHRjbG9zZVN5bmMsXG5cdGV4aXN0c1N5bmMsXG5cdG1rZGlyU3luYyxcblx0b3BlblN5bmMsXG5cdHJlYWRkaXJTeW5jLFxuXHRyZWFkRmlsZVN5bmMsXG5cdHJlYWRTeW5jLFxuXHRzdGF0U3luYyxcblx0d3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcImZzXCI7XG5pbXBvcnQgeyBhdG9taWNXcml0ZUZpbGVTeW5jIH0gZnJvbSBcIi4vZnMtdXRpbHMuanNcIjtcbmltcG9ydCB7IHJlYWRkaXIsIHJlYWRGaWxlLCBzdGF0IH0gZnJvbSBcImZzL3Byb21pc2VzXCI7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSBcInBhdGhcIjtcbmltcG9ydCB7IGdldEFnZW50RGlyIGFzIGdldERlZmF1bHRBZ2VudERpciwgZ2V0QmxvYnNEaXIsIGdldFNlc3Npb25zRGlyIH0gZnJvbSBcIi4uL2NvbmZpZy5qc1wiO1xuaW1wb3J0IHsgdHJ5QWNxdWlyZUxvY2tTeW5jIH0gZnJvbSBcIi4vbG9jay11dGlscy5qc1wiO1xuaW1wb3J0IHtcblx0dHlwZSBCYXNoRXhlY3V0aW9uTWVzc2FnZSxcblx0dHlwZSBDdXN0b21NZXNzYWdlLFxuXHRjcmVhdGVCcmFuY2hTdW1tYXJ5TWVzc2FnZSxcblx0Y3JlYXRlQ29tcGFjdGlvblN1bW1hcnlNZXNzYWdlLFxuXHRjcmVhdGVDdXN0b21NZXNzYWdlLFxufSBmcm9tIFwiLi9tZXNzYWdlcy5qc1wiO1xuaW1wb3J0IHsgQmxvYlN0b3JlLCBleHRlcm5hbGl6ZUltYWdlRGF0YSwgaXNCbG9iUmVmLCByZXNvbHZlSW1hZ2VEYXRhIH0gZnJvbSBcIi4vYmxvYi1zdG9yZS5qc1wiO1xuaW1wb3J0IHsgcmVkYWN0U2VjcmV0cyB9IGZyb20gXCIuL3JlZGFjdC1zZWNyZXRzLmpzXCI7XG5cbi8qKiBJbmxpbmUgY29uY3VycmVuY3kgbGltaXRlciB0byBjYXAgcGFyYWxsZWwgYXN5bmMgb3BlcmF0aW9ucy4gKi9cbmZ1bmN0aW9uIHBMaW1pdChjb25jdXJyZW5jeTogbnVtYmVyKSB7XG5cdGNvbnN0IHF1ZXVlOiAoKCkgPT4gdm9pZClbXSA9IFtdO1xuXHRsZXQgYWN0aXZlID0gMDtcblx0cmV0dXJuIDxUPihmbjogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4gPT4ge1xuXHRcdHJldHVybiBuZXcgUHJvbWlzZTxUPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0XHRjb25zdCBydW4gPSAoKSA9PiB7XG5cdFx0XHRcdGFjdGl2ZSsrO1xuXHRcdFx0XHRmbigpLnRoZW4ocmVzb2x2ZSwgcmVqZWN0KS5maW5hbGx5KCgpID0+IHtcblx0XHRcdFx0XHRhY3RpdmUtLTtcblx0XHRcdFx0XHRpZiAocXVldWUubGVuZ3RoID4gMCkgcXVldWUuc2hpZnQoKSEoKTtcblx0XHRcdFx0fSk7XG5cdFx0XHR9O1xuXHRcdFx0aWYgKGFjdGl2ZSA8IGNvbmN1cnJlbmN5KSBydW4oKTtcblx0XHRcdGVsc2UgcXVldWUucHVzaChydW4pO1xuXHRcdH0pO1xuXHR9O1xufVxuXG5jb25zdCBCTE9CX0VYVEVSTkFMSVpFX1RIUkVTSE9MRCA9IDEwMjQ7IC8vIDFLQiBtaW5pbXVtIHRvIGV4dGVybmFsaXplXG5jb25zdCBNQVhfUEVSU0lTVF9DSEFSUyA9IDUwMF8wMDA7XG5jb25zdCBUUlVOQ0FUSU9OX05PVElDRSA9IFwiXFxuXFxuW1Nlc3Npb24gcGVyc2lzdGVuY2UgdHJ1bmNhdGVkIGxhcmdlIGNvbnRlbnRdXCI7XG5cbmV4cG9ydCBjb25zdCBDVVJSRU5UX1NFU1NJT05fVkVSU0lPTiA9IDM7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2Vzc2lvbkhlYWRlciB7XG5cdHR5cGU6IFwic2Vzc2lvblwiO1xuXHR2ZXJzaW9uPzogbnVtYmVyOyAvLyB2MSBzZXNzaW9ucyBkb24ndCBoYXZlIHRoaXNcblx0aWQ6IHN0cmluZztcblx0dGltZXN0YW1wOiBzdHJpbmc7XG5cdGN3ZDogc3RyaW5nO1xuXHRwYXJlbnRTZXNzaW9uPzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIE5ld1Nlc3Npb25PcHRpb25zIHtcblx0cGFyZW50U2Vzc2lvbj86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZXNzaW9uRW50cnlCYXNlIHtcblx0dHlwZTogc3RyaW5nO1xuXHRpZDogc3RyaW5nO1xuXHRwYXJlbnRJZDogc3RyaW5nIHwgbnVsbDtcblx0dGltZXN0YW1wOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2Vzc2lvbk1lc3NhZ2VFbnRyeSBleHRlbmRzIFNlc3Npb25FbnRyeUJhc2Uge1xuXHR0eXBlOiBcIm1lc3NhZ2VcIjtcblx0bWVzc2FnZTogQWdlbnRNZXNzYWdlO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRoaW5raW5nTGV2ZWxDaGFuZ2VFbnRyeSBleHRlbmRzIFNlc3Npb25FbnRyeUJhc2Uge1xuXHR0eXBlOiBcInRoaW5raW5nX2xldmVsX2NoYW5nZVwiO1xuXHR0aGlua2luZ0xldmVsOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTW9kZWxDaGFuZ2VFbnRyeSBleHRlbmRzIFNlc3Npb25FbnRyeUJhc2Uge1xuXHR0eXBlOiBcIm1vZGVsX2NoYW5nZVwiO1xuXHRwcm92aWRlcjogc3RyaW5nO1xuXHRtb2RlbElkOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tcGFjdGlvbkVudHJ5PFQgPSB1bmtub3duPiBleHRlbmRzIFNlc3Npb25FbnRyeUJhc2Uge1xuXHR0eXBlOiBcImNvbXBhY3Rpb25cIjtcblx0c3VtbWFyeTogc3RyaW5nO1xuXHRmaXJzdEtlcHRFbnRyeUlkOiBzdHJpbmc7XG5cdHRva2Vuc0JlZm9yZTogbnVtYmVyO1xuXHQvKiogRXh0ZW5zaW9uLXNwZWNpZmljIGRhdGEgKGUuZy4sIEFydGlmYWN0SW5kZXgsIHZlcnNpb24gbWFya2VycyBmb3Igc3RydWN0dXJlZCBjb21wYWN0aW9uKSAqL1xuXHRkZXRhaWxzPzogVDtcblx0LyoqIFRydWUgaWYgZ2VuZXJhdGVkIGJ5IGFuIGV4dGVuc2lvbiwgdW5kZWZpbmVkL2ZhbHNlIGlmIHBpLWdlbmVyYXRlZCAoYmFja3dhcmQgY29tcGF0aWJsZSkgKi9cblx0ZnJvbUhvb2s/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEJyYW5jaFN1bW1hcnlFbnRyeTxUID0gdW5rbm93bj4gZXh0ZW5kcyBTZXNzaW9uRW50cnlCYXNlIHtcblx0dHlwZTogXCJicmFuY2hfc3VtbWFyeVwiO1xuXHRmcm9tSWQ6IHN0cmluZztcblx0c3VtbWFyeTogc3RyaW5nO1xuXHQvKiogRXh0ZW5zaW9uLXNwZWNpZmljIGRhdGEgKG5vdCBzZW50IHRvIExMTSkgKi9cblx0ZGV0YWlscz86IFQ7XG5cdC8qKiBUcnVlIGlmIGdlbmVyYXRlZCBieSBhbiBleHRlbnNpb24sIGZhbHNlIGlmIHBpLWdlbmVyYXRlZCAqL1xuXHRmcm9tSG9vaz86IGJvb2xlYW47XG59XG5cbi8qKlxuICogQ3VzdG9tIGVudHJ5IGZvciBleHRlbnNpb25zIHRvIHN0b3JlIGV4dGVuc2lvbi1zcGVjaWZpYyBkYXRhIGluIHRoZSBzZXNzaW9uLlxuICogVXNlIGN1c3RvbVR5cGUgdG8gaWRlbnRpZnkgeW91ciBleHRlbnNpb24ncyBlbnRyaWVzLlxuICpcbiAqIFB1cnBvc2U6IFBlcnNpc3QgZXh0ZW5zaW9uIHN0YXRlIGFjcm9zcyBzZXNzaW9uIHJlbG9hZHMuIE9uIHJlbG9hZCwgZXh0ZW5zaW9ucyBjYW5cbiAqIHNjYW4gZW50cmllcyBmb3IgdGhlaXIgY3VzdG9tVHlwZSBhbmQgcmVjb25zdHJ1Y3QgaW50ZXJuYWwgc3RhdGUuXG4gKlxuICogRG9lcyBOT1QgcGFydGljaXBhdGUgaW4gTExNIGNvbnRleHQgKGlnbm9yZWQgYnkgYnVpbGRTZXNzaW9uQ29udGV4dCkuXG4gKiBGb3IgaW5qZWN0aW5nIGNvbnRlbnQgaW50byBjb250ZXh0LCBzZWUgQ3VzdG9tTWVzc2FnZUVudHJ5LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEN1c3RvbUVudHJ5PFQgPSB1bmtub3duPiBleHRlbmRzIFNlc3Npb25FbnRyeUJhc2Uge1xuXHR0eXBlOiBcImN1c3RvbVwiO1xuXHRjdXN0b21UeXBlOiBzdHJpbmc7XG5cdGRhdGE/OiBUO1xufVxuXG4vKiogTGFiZWwgZW50cnkgZm9yIHVzZXItZGVmaW5lZCBib29rbWFya3MvbWFya2VycyBvbiBlbnRyaWVzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBMYWJlbEVudHJ5IGV4dGVuZHMgU2Vzc2lvbkVudHJ5QmFzZSB7XG5cdHR5cGU6IFwibGFiZWxcIjtcblx0dGFyZ2V0SWQ6IHN0cmluZztcblx0bGFiZWw6IHN0cmluZyB8IHVuZGVmaW5lZDtcbn1cblxuLyoqIFNlc3Npb24gbWV0YWRhdGEgZW50cnkgKGUuZy4sIHVzZXItZGVmaW5lZCBkaXNwbGF5IG5hbWUpLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTZXNzaW9uSW5mb0VudHJ5IGV4dGVuZHMgU2Vzc2lvbkVudHJ5QmFzZSB7XG5cdHR5cGU6IFwic2Vzc2lvbl9pbmZvXCI7XG5cdG5hbWU/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogQ3VzdG9tIG1lc3NhZ2UgZW50cnkgZm9yIGV4dGVuc2lvbnMgdG8gaW5qZWN0IG1lc3NhZ2VzIGludG8gTExNIGNvbnRleHQuXG4gKiBVc2UgY3VzdG9tVHlwZSB0byBpZGVudGlmeSB5b3VyIGV4dGVuc2lvbidzIGVudHJpZXMuXG4gKlxuICogVW5saWtlIEN1c3RvbUVudHJ5LCB0aGlzIERPRVMgcGFydGljaXBhdGUgaW4gTExNIGNvbnRleHQuXG4gKiBUaGUgY29udGVudCBpcyBjb252ZXJ0ZWQgdG8gYSB1c2VyIG1lc3NhZ2UgaW4gYnVpbGRTZXNzaW9uQ29udGV4dCgpLlxuICogVXNlIGRldGFpbHMgZm9yIGV4dGVuc2lvbi1zcGVjaWZpYyBtZXRhZGF0YSAobm90IHNlbnQgdG8gTExNKS5cbiAqXG4gKiBkaXNwbGF5IGNvbnRyb2xzIFRVSSByZW5kZXJpbmc6XG4gKiAtIGZhbHNlOiBoaWRkZW4gZW50aXJlbHlcbiAqIC0gdHJ1ZTogcmVuZGVyZWQgd2l0aCBkaXN0aW5jdCBzdHlsaW5nIChkaWZmZXJlbnQgZnJvbSB1c2VyIG1lc3NhZ2VzKVxuICovXG5leHBvcnQgaW50ZXJmYWNlIEN1c3RvbU1lc3NhZ2VFbnRyeTxUID0gdW5rbm93bj4gZXh0ZW5kcyBTZXNzaW9uRW50cnlCYXNlIHtcblx0dHlwZTogXCJjdXN0b21fbWVzc2FnZVwiO1xuXHRjdXN0b21UeXBlOiBzdHJpbmc7XG5cdGNvbnRlbnQ6IHN0cmluZyB8IChUZXh0Q29udGVudCB8IEltYWdlQ29udGVudClbXTtcblx0ZGV0YWlscz86IFQ7XG5cdGRpc3BsYXk6IGJvb2xlYW47XG59XG5cbi8qKiBTZXNzaW9uIGVudHJ5IC0gaGFzIGlkL3BhcmVudElkIGZvciB0cmVlIHN0cnVjdHVyZSAocmV0dXJuZWQgYnkgXCJyZWFkXCIgbWV0aG9kcyBpbiBTZXNzaW9uTWFuYWdlcikgKi9cbmV4cG9ydCB0eXBlIFNlc3Npb25FbnRyeSA9XG5cdHwgU2Vzc2lvbk1lc3NhZ2VFbnRyeVxuXHR8IFRoaW5raW5nTGV2ZWxDaGFuZ2VFbnRyeVxuXHR8IE1vZGVsQ2hhbmdlRW50cnlcblx0fCBDb21wYWN0aW9uRW50cnlcblx0fCBCcmFuY2hTdW1tYXJ5RW50cnlcblx0fCBDdXN0b21FbnRyeVxuXHR8IEN1c3RvbU1lc3NhZ2VFbnRyeVxuXHR8IExhYmVsRW50cnlcblx0fCBTZXNzaW9uSW5mb0VudHJ5O1xuXG4vKiogUmF3IGZpbGUgZW50cnkgKGluY2x1ZGVzIGhlYWRlcikgKi9cbmV4cG9ydCB0eXBlIEZpbGVFbnRyeSA9IFNlc3Npb25IZWFkZXIgfCBTZXNzaW9uRW50cnk7XG5cbi8qKiBUcmVlIG5vZGUgZm9yIGdldFRyZWUoKSAtIGRlZmVuc2l2ZSBjb3B5IG9mIHNlc3Npb24gc3RydWN0dXJlICovXG5leHBvcnQgaW50ZXJmYWNlIFNlc3Npb25UcmVlTm9kZSB7XG5cdGVudHJ5OiBTZXNzaW9uRW50cnk7XG5cdGNoaWxkcmVuOiBTZXNzaW9uVHJlZU5vZGVbXTtcblx0LyoqIFJlc29sdmVkIGxhYmVsIGZvciB0aGlzIGVudHJ5LCBpZiBhbnkgKi9cblx0bGFiZWw/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2Vzc2lvbkNvbnRleHQge1xuXHRtZXNzYWdlczogQWdlbnRNZXNzYWdlW107XG5cdHRoaW5raW5nTGV2ZWw6IHN0cmluZztcblx0bW9kZWw6IHsgcHJvdmlkZXI6IHN0cmluZzsgbW9kZWxJZDogc3RyaW5nIH0gfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNlc3Npb25JbmZvIHtcblx0cGF0aDogc3RyaW5nO1xuXHRpZDogc3RyaW5nO1xuXHQvKiogV29ya2luZyBkaXJlY3Rvcnkgd2hlcmUgdGhlIHNlc3Npb24gd2FzIHN0YXJ0ZWQuIEVtcHR5IHN0cmluZyBmb3Igb2xkIHNlc3Npb25zLiAqL1xuXHRjd2Q6IHN0cmluZztcblx0LyoqIFVzZXItZGVmaW5lZCBkaXNwbGF5IG5hbWUgZnJvbSBzZXNzaW9uX2luZm8gZW50cmllcy4gKi9cblx0bmFtZT86IHN0cmluZztcblx0LyoqIFBhdGggdG8gdGhlIHBhcmVudCBzZXNzaW9uIChpZiB0aGlzIHNlc3Npb24gd2FzIGZvcmtlZCkuICovXG5cdHBhcmVudFNlc3Npb25QYXRoPzogc3RyaW5nO1xuXHRjcmVhdGVkOiBEYXRlO1xuXHRtb2RpZmllZDogRGF0ZTtcblx0bWVzc2FnZUNvdW50OiBudW1iZXI7XG5cdGZpcnN0TWVzc2FnZTogc3RyaW5nO1xuXHRhbGxNZXNzYWdlc1RleHQ6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZXNzaW9uVXNhZ2VUb3RhbHMge1xuXHRpbnB1dDogbnVtYmVyO1xuXHRvdXRwdXQ6IG51bWJlcjtcblx0Y2FjaGVSZWFkOiBudW1iZXI7XG5cdGNhY2hlV3JpdGU6IG51bWJlcjtcblx0Y29zdDogbnVtYmVyO1xufVxuXG5leHBvcnQgdHlwZSBSZWFkb25seVNlc3Npb25NYW5hZ2VyID0gUGljazxcblx0U2Vzc2lvbk1hbmFnZXIsXG5cdHwgXCJnZXRDd2RcIlxuXHR8IFwiZ2V0U2Vzc2lvbkRpclwiXG5cdHwgXCJnZXRTZXNzaW9uSWRcIlxuXHR8IFwiZ2V0U2Vzc2lvbkZpbGVcIlxuXHR8IFwiZ2V0TGVhZklkXCJcblx0fCBcImdldExlYWZFbnRyeVwiXG5cdHwgXCJnZXRFbnRyeVwiXG5cdHwgXCJnZXRMYWJlbFwiXG5cdHwgXCJnZXRCcmFuY2hcIlxuXHR8IFwiZ2V0SGVhZGVyXCJcblx0fCBcImdldEVudHJpZXNcIlxuXHR8IFwiZ2V0VXNhZ2VUb3RhbHNcIlxuXHR8IFwiZ2V0VHJlZVwiXG5cdHwgXCJnZXRTZXNzaW9uTmFtZVwiXG4+O1xuXG5mdW5jdGlvbiBjcmVhdGVFbXB0eVVzYWdlVG90YWxzKCk6IFNlc3Npb25Vc2FnZVRvdGFscyB7XG5cdHJldHVybiB7XG5cdFx0aW5wdXQ6IDAsXG5cdFx0b3V0cHV0OiAwLFxuXHRcdGNhY2hlUmVhZDogMCxcblx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdGNvc3Q6IDAsXG5cdH07XG59XG5cbi8qKiBHZW5lcmF0ZSBhIHVuaXF1ZSBzaG9ydCBJRCAoOCBoZXggY2hhcnMsIGNvbGxpc2lvbi1jaGVja2VkKSAqL1xuZnVuY3Rpb24gZ2VuZXJhdGVJZChieUlkOiB7IGhhcyhpZDogc3RyaW5nKTogYm9vbGVhbiB9KTogc3RyaW5nIHtcblx0Zm9yIChsZXQgaSA9IDA7IGkgPCAxMDA7IGkrKykge1xuXHRcdGNvbnN0IGlkID0gcmFuZG9tVVVJRCgpLnNsaWNlKDAsIDgpO1xuXHRcdGlmICghYnlJZC5oYXMoaWQpKSByZXR1cm4gaWQ7XG5cdH1cblx0Ly8gRmFsbGJhY2sgdG8gZnVsbCBVVUlEIGlmIHNvbWVob3cgd2UgaGF2ZSBjb2xsaXNpb25zXG5cdHJldHVybiByYW5kb21VVUlEKCk7XG59XG5cbi8qKiBNaWdyYXRlIHYxIFx1MjE5MiB2MjogYWRkIGlkL3BhcmVudElkIHRyZWUgc3RydWN0dXJlLiBNdXRhdGVzIGluIHBsYWNlLiAqL1xuZnVuY3Rpb24gbWlncmF0ZVYxVG9WMihlbnRyaWVzOiBGaWxlRW50cnlbXSk6IHZvaWQge1xuXHRjb25zdCBpZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0bGV0IHByZXZJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cblx0Zm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG5cdFx0aWYgKGVudHJ5LnR5cGUgPT09IFwic2Vzc2lvblwiKSB7XG5cdFx0XHRlbnRyeS52ZXJzaW9uID0gMjtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGVudHJ5LmlkID0gZ2VuZXJhdGVJZChpZHMpO1xuXHRcdGVudHJ5LnBhcmVudElkID0gcHJldklkO1xuXHRcdHByZXZJZCA9IGVudHJ5LmlkO1xuXG5cdFx0Ly8gQ29udmVydCBmaXJzdEtlcHRFbnRyeUluZGV4IHRvIGZpcnN0S2VwdEVudHJ5SWQgZm9yIGNvbXBhY3Rpb25cblx0XHRpZiAoZW50cnkudHlwZSA9PT0gXCJjb21wYWN0aW9uXCIpIHtcblx0XHRcdGNvbnN0IGNvbXAgPSBlbnRyeSBhcyBDb21wYWN0aW9uRW50cnkgJiB7IGZpcnN0S2VwdEVudHJ5SW5kZXg/OiBudW1iZXIgfTtcblx0XHRcdGlmICh0eXBlb2YgY29tcC5maXJzdEtlcHRFbnRyeUluZGV4ID09PSBcIm51bWJlclwiKSB7XG5cdFx0XHRcdGNvbnN0IHRhcmdldEVudHJ5ID0gZW50cmllc1tjb21wLmZpcnN0S2VwdEVudHJ5SW5kZXhdO1xuXHRcdFx0XHRpZiAodGFyZ2V0RW50cnkgJiYgdGFyZ2V0RW50cnkudHlwZSAhPT0gXCJzZXNzaW9uXCIpIHtcblx0XHRcdFx0XHRjb21wLmZpcnN0S2VwdEVudHJ5SWQgPSB0YXJnZXRFbnRyeS5pZDtcblx0XHRcdFx0fVxuXHRcdFx0XHRkZWxldGUgY29tcC5maXJzdEtlcHRFbnRyeUluZGV4O1xuXHRcdFx0fVxuXHRcdH1cblx0fVxufVxuXG4vKiogTWlncmF0ZSB2MiBcdTIxOTIgdjM6IHJlbmFtZSBob29rTWVzc2FnZSByb2xlIHRvIGN1c3RvbS4gTXV0YXRlcyBpbiBwbGFjZS4gKi9cbmZ1bmN0aW9uIG1pZ3JhdGVWMlRvVjMoZW50cmllczogRmlsZUVudHJ5W10pOiB2b2lkIHtcblx0Zm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG5cdFx0aWYgKGVudHJ5LnR5cGUgPT09IFwic2Vzc2lvblwiKSB7XG5cdFx0XHRlbnRyeS52ZXJzaW9uID0gMztcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdC8vIFVwZGF0ZSBtZXNzYWdlIGVudHJpZXMgd2l0aCBob29rTWVzc2FnZSByb2xlXG5cdFx0aWYgKGVudHJ5LnR5cGUgPT09IFwibWVzc2FnZVwiKSB7XG5cdFx0XHRjb25zdCBtc2dFbnRyeSA9IGVudHJ5IGFzIFNlc3Npb25NZXNzYWdlRW50cnk7XG5cdFx0XHRpZiAobXNnRW50cnkubWVzc2FnZSAmJiAobXNnRW50cnkubWVzc2FnZSBhcyB7IHJvbGU6IHN0cmluZyB9KS5yb2xlID09PSBcImhvb2tNZXNzYWdlXCIpIHtcblx0XHRcdFx0KG1zZ0VudHJ5Lm1lc3NhZ2UgYXMgeyByb2xlOiBzdHJpbmcgfSkucm9sZSA9IFwiY3VzdG9tXCI7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG59XG5cbi8qKlxuICogUnVuIGFsbCBuZWNlc3NhcnkgbWlncmF0aW9ucyB0byBicmluZyBlbnRyaWVzIHRvIGN1cnJlbnQgdmVyc2lvbi5cbiAqIE11dGF0ZXMgZW50cmllcyBpbiBwbGFjZS4gUmV0dXJucyB0cnVlIGlmIGFueSBtaWdyYXRpb24gd2FzIGFwcGxpZWQuXG4gKi9cbmZ1bmN0aW9uIG1pZ3JhdGVUb0N1cnJlbnRWZXJzaW9uKGVudHJpZXM6IEZpbGVFbnRyeVtdKTogYm9vbGVhbiB7XG5cdGNvbnN0IGhlYWRlciA9IGVudHJpZXMuZmluZCgoZSkgPT4gZS50eXBlID09PSBcInNlc3Npb25cIikgYXMgU2Vzc2lvbkhlYWRlciB8IHVuZGVmaW5lZDtcblx0Y29uc3QgdmVyc2lvbiA9IGhlYWRlcj8udmVyc2lvbiA/PyAxO1xuXG5cdGlmICh2ZXJzaW9uID49IENVUlJFTlRfU0VTU0lPTl9WRVJTSU9OKSByZXR1cm4gZmFsc2U7XG5cblx0aWYgKHZlcnNpb24gPCAyKSBtaWdyYXRlVjFUb1YyKGVudHJpZXMpO1xuXHRpZiAodmVyc2lvbiA8IDMpIG1pZ3JhdGVWMlRvVjMoZW50cmllcyk7XG5cblx0cmV0dXJuIHRydWU7XG59XG5cbi8qKiBFeHBvcnRlZCBmb3IgdGVzdGluZyAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1pZ3JhdGVTZXNzaW9uRW50cmllcyhlbnRyaWVzOiBGaWxlRW50cnlbXSk6IHZvaWQge1xuXHRtaWdyYXRlVG9DdXJyZW50VmVyc2lvbihlbnRyaWVzKTtcbn1cblxuLyoqIEV4cG9ydGVkIGZvciBjb21wYWN0aW9uLnRlc3QudHMgKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNlc3Npb25FbnRyaWVzKGNvbnRlbnQ6IHN0cmluZyk6IEZpbGVFbnRyeVtdIHtcblx0Y29uc3QgZW50cmllczogRmlsZUVudHJ5W10gPSBbXTtcblx0Y29uc3QgbGluZXMgPSBjb250ZW50LnRyaW0oKS5zcGxpdChcIlxcblwiKTtcblxuXHRmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcblx0XHRpZiAoIWxpbmUudHJpbSgpKSBjb250aW51ZTtcblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgZW50cnkgPSBKU09OLnBhcnNlKGxpbmUpIGFzIEZpbGVFbnRyeTtcblx0XHRcdGVudHJpZXMucHVzaChlbnRyeSk7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBTa2lwIG1hbGZvcm1lZCBsaW5lc1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiBlbnRyaWVzO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0TGF0ZXN0Q29tcGFjdGlvbkVudHJ5KGVudHJpZXM6IFNlc3Npb25FbnRyeVtdKTogQ29tcGFjdGlvbkVudHJ5IHwgbnVsbCB7XG5cdGZvciAobGV0IGkgPSBlbnRyaWVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG5cdFx0aWYgKGVudHJpZXNbaV0udHlwZSA9PT0gXCJjb21wYWN0aW9uXCIpIHtcblx0XHRcdHJldHVybiBlbnRyaWVzW2ldIGFzIENvbXBhY3Rpb25FbnRyeTtcblx0XHR9XG5cdH1cblx0cmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIHNlc3Npb24gY29udGV4dCBmcm9tIGVudHJpZXMgdXNpbmcgdHJlZSB0cmF2ZXJzYWwuXG4gKiBJZiBsZWFmSWQgaXMgcHJvdmlkZWQsIHdhbGtzIGZyb20gdGhhdCBlbnRyeSB0byByb290LlxuICogSGFuZGxlcyBjb21wYWN0aW9uIGFuZCBicmFuY2ggc3VtbWFyaWVzIGFsb25nIHRoZSBwYXRoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTZXNzaW9uQ29udGV4dChcblx0ZW50cmllczogU2Vzc2lvbkVudHJ5W10sXG5cdGxlYWZJZD86IHN0cmluZyB8IG51bGwsXG5cdGJ5SWQ/OiBNYXA8c3RyaW5nLCBTZXNzaW9uRW50cnk+LFxuKTogU2Vzc2lvbkNvbnRleHQge1xuXHQvLyBCdWlsZCB1dWlkIGluZGV4IGlmIG5vdCBhdmFpbGFibGVcblx0aWYgKCFieUlkKSB7XG5cdFx0YnlJZCA9IG5ldyBNYXA8c3RyaW5nLCBTZXNzaW9uRW50cnk+KCk7XG5cdFx0Zm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG5cdFx0XHRieUlkLnNldChlbnRyeS5pZCwgZW50cnkpO1xuXHRcdH1cblx0fVxuXG5cdC8vIEZpbmQgbGVhZlxuXHRsZXQgbGVhZjogU2Vzc2lvbkVudHJ5IHwgdW5kZWZpbmVkO1xuXHRpZiAobGVhZklkID09PSBudWxsKSB7XG5cdFx0Ly8gRXhwbGljaXRseSBudWxsIC0gcmV0dXJuIG5vIG1lc3NhZ2VzIChuYXZpZ2F0ZWQgdG8gYmVmb3JlIGZpcnN0IGVudHJ5KVxuXHRcdHJldHVybiB7IG1lc3NhZ2VzOiBbXSwgdGhpbmtpbmdMZXZlbDogXCJvZmZcIiwgbW9kZWw6IG51bGwgfTtcblx0fVxuXHRpZiAobGVhZklkKSB7XG5cdFx0bGVhZiA9IGJ5SWQuZ2V0KGxlYWZJZCk7XG5cdH1cblx0aWYgKCFsZWFmKSB7XG5cdFx0Ly8gRmFsbGJhY2sgdG8gbGFzdCBlbnRyeSAod2hlbiBsZWFmSWQgaXMgdW5kZWZpbmVkKVxuXHRcdGxlYWYgPSBlbnRyaWVzW2VudHJpZXMubGVuZ3RoIC0gMV07XG5cdH1cblxuXHRpZiAoIWxlYWYpIHtcblx0XHRyZXR1cm4geyBtZXNzYWdlczogW10sIHRoaW5raW5nTGV2ZWw6IFwib2ZmXCIsIG1vZGVsOiBudWxsIH07XG5cdH1cblxuXHQvLyBXYWxrIGZyb20gbGVhZiB0byByb290LCBjb2xsZWN0aW5nIHBhdGhcblx0Y29uc3QgcGF0aDogU2Vzc2lvbkVudHJ5W10gPSBbXTtcblx0bGV0IGN1cnJlbnQ6IFNlc3Npb25FbnRyeSB8IHVuZGVmaW5lZCA9IGxlYWY7XG5cdHdoaWxlIChjdXJyZW50KSB7XG5cdFx0cGF0aC51bnNoaWZ0KGN1cnJlbnQpO1xuXHRcdGN1cnJlbnQgPSBjdXJyZW50LnBhcmVudElkID8gYnlJZC5nZXQoY3VycmVudC5wYXJlbnRJZCkgOiB1bmRlZmluZWQ7XG5cdH1cblxuXHQvLyBFeHRyYWN0IHNldHRpbmdzIGFuZCBmaW5kIGNvbXBhY3Rpb25cblx0bGV0IHRoaW5raW5nTGV2ZWwgPSBcIm9mZlwiO1xuXHRsZXQgbW9kZWw6IHsgcHJvdmlkZXI6IHN0cmluZzsgbW9kZWxJZDogc3RyaW5nIH0gfCBudWxsID0gbnVsbDtcblx0bGV0IGNvbXBhY3Rpb246IENvbXBhY3Rpb25FbnRyeSB8IG51bGwgPSBudWxsO1xuXG5cdGZvciAoY29uc3QgZW50cnkgb2YgcGF0aCkge1xuXHRcdGlmIChlbnRyeS50eXBlID09PSBcInRoaW5raW5nX2xldmVsX2NoYW5nZVwiKSB7XG5cdFx0XHR0aGlua2luZ0xldmVsID0gZW50cnkudGhpbmtpbmdMZXZlbDtcblx0XHR9IGVsc2UgaWYgKGVudHJ5LnR5cGUgPT09IFwibW9kZWxfY2hhbmdlXCIpIHtcblx0XHRcdG1vZGVsID0geyBwcm92aWRlcjogZW50cnkucHJvdmlkZXIsIG1vZGVsSWQ6IGVudHJ5Lm1vZGVsSWQgfTtcblx0XHR9IGVsc2UgaWYgKGVudHJ5LnR5cGUgPT09IFwibWVzc2FnZVwiICYmIGVudHJ5Lm1lc3NhZ2Uucm9sZSA9PT0gXCJhc3Npc3RhbnRcIikge1xuXHRcdFx0bW9kZWwgPSB7IHByb3ZpZGVyOiBlbnRyeS5tZXNzYWdlLnByb3ZpZGVyLCBtb2RlbElkOiBlbnRyeS5tZXNzYWdlLm1vZGVsIH07XG5cdFx0fSBlbHNlIGlmIChlbnRyeS50eXBlID09PSBcImNvbXBhY3Rpb25cIikge1xuXHRcdFx0Y29tcGFjdGlvbiA9IGVudHJ5O1xuXHRcdH1cblx0fVxuXG5cdC8vIEJ1aWxkIG1lc3NhZ2VzIGFuZCBjb2xsZWN0IGNvcnJlc3BvbmRpbmcgZW50cmllc1xuXHQvLyBXaGVuIHRoZXJlJ3MgYSBjb21wYWN0aW9uLCB3ZSBuZWVkIHRvOlxuXHQvLyAxLiBFbWl0IHN1bW1hcnkgZmlyc3QgKGVudHJ5ID0gY29tcGFjdGlvbilcblx0Ly8gMi4gRW1pdCBrZXB0IG1lc3NhZ2VzIChmcm9tIGZpcnN0S2VwdEVudHJ5SWQgdXAgdG8gY29tcGFjdGlvbilcblx0Ly8gMy4gRW1pdCBtZXNzYWdlcyBhZnRlciBjb21wYWN0aW9uXG5cdGNvbnN0IG1lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSA9IFtdO1xuXG5cdGNvbnN0IGFwcGVuZE1lc3NhZ2UgPSAoZW50cnk6IFNlc3Npb25FbnRyeSkgPT4ge1xuXHRcdGlmIChlbnRyeS50eXBlID09PSBcIm1lc3NhZ2VcIikge1xuXHRcdFx0bWVzc2FnZXMucHVzaChlbnRyeS5tZXNzYWdlKTtcblx0XHR9IGVsc2UgaWYgKGVudHJ5LnR5cGUgPT09IFwiY3VzdG9tX21lc3NhZ2VcIikge1xuXHRcdFx0bWVzc2FnZXMucHVzaChcblx0XHRcdFx0Y3JlYXRlQ3VzdG9tTWVzc2FnZShlbnRyeS5jdXN0b21UeXBlLCBlbnRyeS5jb250ZW50LCBlbnRyeS5kaXNwbGF5LCBlbnRyeS5kZXRhaWxzLCBlbnRyeS50aW1lc3RhbXApLFxuXHRcdFx0KTtcblx0XHR9IGVsc2UgaWYgKGVudHJ5LnR5cGUgPT09IFwiYnJhbmNoX3N1bW1hcnlcIiAmJiBlbnRyeS5zdW1tYXJ5KSB7XG5cdFx0XHRtZXNzYWdlcy5wdXNoKGNyZWF0ZUJyYW5jaFN1bW1hcnlNZXNzYWdlKGVudHJ5LnN1bW1hcnksIGVudHJ5LmZyb21JZCwgZW50cnkudGltZXN0YW1wKSk7XG5cdFx0fVxuXHR9O1xuXG5cdGlmIChjb21wYWN0aW9uKSB7XG5cdFx0Ly8gRW1pdCBzdW1tYXJ5IGZpcnN0XG5cdFx0bWVzc2FnZXMucHVzaChjcmVhdGVDb21wYWN0aW9uU3VtbWFyeU1lc3NhZ2UoY29tcGFjdGlvbi5zdW1tYXJ5LCBjb21wYWN0aW9uLnRva2Vuc0JlZm9yZSwgY29tcGFjdGlvbi50aW1lc3RhbXApKTtcblxuXHRcdC8vIEZpbmQgY29tcGFjdGlvbiBpbmRleCBpbiBwYXRoXG5cdFx0Y29uc3QgY29tcGFjdGlvbklkeCA9IHBhdGguZmluZEluZGV4KChlKSA9PiBlLnR5cGUgPT09IFwiY29tcGFjdGlvblwiICYmIGUuaWQgPT09IGNvbXBhY3Rpb24uaWQpO1xuXG5cdFx0Ly8gRW1pdCBrZXB0IG1lc3NhZ2VzIChiZWZvcmUgY29tcGFjdGlvbiwgc3RhcnRpbmcgZnJvbSBmaXJzdEtlcHRFbnRyeUlkKVxuXHRcdGxldCBmb3VuZEZpcnN0S2VwdCA9IGZhbHNlO1xuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgY29tcGFjdGlvbklkeDsgaSsrKSB7XG5cdFx0XHRjb25zdCBlbnRyeSA9IHBhdGhbaV07XG5cdFx0XHRpZiAoZW50cnkuaWQgPT09IGNvbXBhY3Rpb24uZmlyc3RLZXB0RW50cnlJZCkge1xuXHRcdFx0XHRmb3VuZEZpcnN0S2VwdCA9IHRydWU7XG5cdFx0XHR9XG5cdFx0XHRpZiAoZm91bmRGaXJzdEtlcHQpIHtcblx0XHRcdFx0YXBwZW5kTWVzc2FnZShlbnRyeSk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gRW1pdCBtZXNzYWdlcyBhZnRlciBjb21wYWN0aW9uXG5cdFx0Zm9yIChsZXQgaSA9IGNvbXBhY3Rpb25JZHggKyAxOyBpIDwgcGF0aC5sZW5ndGg7IGkrKykge1xuXHRcdFx0Y29uc3QgZW50cnkgPSBwYXRoW2ldO1xuXHRcdFx0YXBwZW5kTWVzc2FnZShlbnRyeSk7XG5cdFx0fVxuXHR9IGVsc2Uge1xuXHRcdC8vIE5vIGNvbXBhY3Rpb24gLSBlbWl0IGFsbCBtZXNzYWdlcywgaGFuZGxlIGJyYW5jaCBzdW1tYXJpZXMgYW5kIGN1c3RvbSBtZXNzYWdlc1xuXHRcdGZvciAoY29uc3QgZW50cnkgb2YgcGF0aCkge1xuXHRcdFx0YXBwZW5kTWVzc2FnZShlbnRyeSk7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIHsgbWVzc2FnZXMsIHRoaW5raW5nTGV2ZWwsIG1vZGVsIH07XG59XG5cbi8qKlxuICogQ29tcHV0ZSB0aGUgZGVmYXVsdCBzZXNzaW9uIGRpcmVjdG9yeSBmb3IgYSBjd2QuXG4gKiBFbmNvZGVzIGN3ZCBpbnRvIGEgc2FmZSBkaXJlY3RvcnkgbmFtZSB1bmRlciB+Ly5waS9hZ2VudC9zZXNzaW9ucy8uXG4gKi9cbmZ1bmN0aW9uIGdldERlZmF1bHRTZXNzaW9uRGlyKGN3ZDogc3RyaW5nKTogc3RyaW5nIHtcblx0Y29uc3Qgc2FmZVBhdGggPSBgLS0ke2N3ZC5yZXBsYWNlKC9eWy9cXFxcXS8sIFwiXCIpLnJlcGxhY2UoL1svXFxcXDpdL2csIFwiLVwiKX0tLWA7XG5cdGNvbnN0IHNlc3Npb25EaXIgPSBqb2luKGdldERlZmF1bHRBZ2VudERpcigpLCBcInNlc3Npb25zXCIsIHNhZmVQYXRoKTtcblx0aWYgKCFleGlzdHNTeW5jKHNlc3Npb25EaXIpKSB7XG5cdFx0bWtkaXJTeW5jKHNlc3Npb25EaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHR9XG5cdHJldHVybiBzZXNzaW9uRGlyO1xufVxuXG5mdW5jdGlvbiBpc0ltYWdlQmxvY2sodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyB7IHR5cGU6IFwiaW1hZ2VcIjsgZGF0YTogc3RyaW5nOyBtaW1lVHlwZT86IHN0cmluZyB9IHtcblx0cmV0dXJuIChcblx0XHR0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgJiZcblx0XHR2YWx1ZSAhPT0gbnVsbCAmJlxuXHRcdFwidHlwZVwiIGluIHZhbHVlICYmXG5cdFx0KHZhbHVlIGFzIHsgdHlwZT86IHN0cmluZyB9KS50eXBlID09PSBcImltYWdlXCIgJiZcblx0XHRcImRhdGFcIiBpbiB2YWx1ZSAmJlxuXHRcdHR5cGVvZiAodmFsdWUgYXMgeyBkYXRhPzogc3RyaW5nIH0pLmRhdGEgPT09IFwic3RyaW5nXCJcblx0KTtcbn1cblxuZnVuY3Rpb24gdHJ1bmNhdGVTdHJpbmcoczogc3RyaW5nLCBtYXhMZW5ndGg6IG51bWJlcik6IHN0cmluZyB7XG5cdGlmIChzLmxlbmd0aCA8PSBtYXhMZW5ndGgpIHJldHVybiBzO1xuXHQvLyBBdm9pZCBzcGxpdHRpbmcgc3Vycm9nYXRlIHBhaXJzXG5cdGlmIChtYXhMZW5ndGggPiAwICYmIHMuY2hhckNvZGVBdChtYXhMZW5ndGggLSAxKSA+PSAweGQ4MDAgJiYgcy5jaGFyQ29kZUF0KG1heExlbmd0aCAtIDEpIDw9IDB4ZGJmZikge1xuXHRcdHJldHVybiBzLnNsaWNlKDAsIG1heExlbmd0aCAtIDEpO1xuXHR9XG5cdHJldHVybiBzLnNsaWNlKDAsIG1heExlbmd0aCk7XG59XG5cbi8qKlxuICogUHJlcGFyZSBhbiBlbnRyeSBmb3IgSlNPTkwgcGVyc2lzdGVuY2U6IGV4dGVybmFsaXplIGxhcmdlIGltYWdlcyB0byBibG9iIHN0b3JlLFxuICogdHJ1bmNhdGUgb3ZlcnNpemVkIHN0cmluZ3MsIHN0cmlwIHRyYW5zaWVudCBmaWVsZHMuXG4gKi9cbmZ1bmN0aW9uIHByZXBhcmVGb3JQZXJzaXN0ZW5jZShvYmo6IHVua25vd24sIGJsb2JTdG9yZTogQmxvYlN0b3JlLCBrZXk/OiBzdHJpbmcpOiB1bmtub3duIHtcblx0aWYgKG9iaiA9PT0gbnVsbCB8fCBvYmogPT09IHVuZGVmaW5lZCkgcmV0dXJuIG9iajtcblxuXHRpZiAodHlwZW9mIG9iaiA9PT0gXCJzdHJpbmdcIikge1xuXHRcdC8vIENyeXB0b2dyYXBoaWMgc2lnbmF0dXJlcyBtdXN0IGJlIHByZXNlcnZlZCBieXRlLWV4YWN0IFx1MjAxNCBuZXZlciByZWRhY3Qgb3IgdHJ1bmNhdGVcblx0XHQvLyB0aGVpciBjb250ZW50cywgb25seSB0aGUgb3ZlcnNpemUtY2xlYXIgcGF0aCBiZWxvdyBoYW5kbGVzIHRoZW0uXG5cdFx0Y29uc3QgaXNTaWduYXR1cmUgPSBrZXkgPT09IFwidGhpbmtpbmdTaWduYXR1cmVcIiB8fCBrZXkgPT09IFwidGhvdWdodFNpZ25hdHVyZVwiIHx8IGtleSA9PT0gXCJ0ZXh0U2lnbmF0dXJlXCI7XG5cdFx0Y29uc3QgcmVkYWN0ZWQgPSBpc1NpZ25hdHVyZSA/IG9iaiA6IHJlZGFjdFNlY3JldHMob2JqKTtcblx0XHRpZiAocmVkYWN0ZWQubGVuZ3RoID4gTUFYX1BFUlNJU1RfQ0hBUlMpIHtcblx0XHRcdGlmIChpc1NpZ25hdHVyZSkge1xuXHRcdFx0XHRyZXR1cm4gXCJcIjtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGxpbWl0ID0gTWF0aC5tYXgoMCwgTUFYX1BFUlNJU1RfQ0hBUlMgLSBUUlVOQ0FUSU9OX05PVElDRS5sZW5ndGgpO1xuXHRcdFx0cmV0dXJuIGAke3RydW5jYXRlU3RyaW5nKHJlZGFjdGVkLCBsaW1pdCl9JHtUUlVOQ0FUSU9OX05PVElDRX1gO1xuXHRcdH1cblx0XHRyZXR1cm4gcmVkYWN0ZWQ7XG5cdH1cblxuXHRpZiAoQXJyYXkuaXNBcnJheShvYmopKSB7XG5cdFx0bGV0IGNoYW5nZWQgPSBmYWxzZTtcblx0XHRjb25zdCByZXN1bHQgPSBvYmoubWFwKChpdGVtKSA9PiB7XG5cdFx0XHQvLyBFeHRlcm5hbGl6ZSBvdmVyc2l6ZWQgaW1hZ2VzIHRvIGJsb2Igc3RvcmVcblx0XHRcdGlmIChrZXkgPT09IFwiY29udGVudFwiICYmIGlzSW1hZ2VCbG9jayhpdGVtKSkge1xuXHRcdFx0XHRpZiAoIWlzQmxvYlJlZihpdGVtLmRhdGEpICYmIGl0ZW0uZGF0YS5sZW5ndGggPj0gQkxPQl9FWFRFUk5BTElaRV9USFJFU0hPTEQpIHtcblx0XHRcdFx0XHRjaGFuZ2VkID0gdHJ1ZTtcblx0XHRcdFx0XHRjb25zdCBibG9iUmVmID0gZXh0ZXJuYWxpemVJbWFnZURhdGEoYmxvYlN0b3JlLCBpdGVtLmRhdGEpO1xuXHRcdFx0XHRcdHJldHVybiB7IC4uLml0ZW0sIGRhdGE6IGJsb2JSZWYgfTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0Y29uc3QgbmV3SXRlbSA9IHByZXBhcmVGb3JQZXJzaXN0ZW5jZShpdGVtLCBibG9iU3RvcmUsIGtleSk7XG5cdFx0XHRpZiAobmV3SXRlbSAhPT0gaXRlbSkgY2hhbmdlZCA9IHRydWU7XG5cdFx0XHRyZXR1cm4gbmV3SXRlbTtcblx0XHR9KTtcblx0XHRyZXR1cm4gY2hhbmdlZCA/IHJlc3VsdCA6IG9iajtcblx0fVxuXG5cdGlmICh0eXBlb2Ygb2JqID09PSBcIm9iamVjdFwiKSB7XG5cdFx0bGV0IGNoYW5nZWQgPSBmYWxzZTtcblx0XHRjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG5cdFx0Zm9yIChjb25zdCBbaywgdl0gb2YgT2JqZWN0LmVudHJpZXMob2JqIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuXHRcdFx0Ly8gU3RyaXAgdHJhbnNpZW50IHByb3BlcnRpZXNcblx0XHRcdGlmIChrID09PSBcInBhcnRpYWxKc29uXCIgfHwgayA9PT0gXCJqc29ubEV2ZW50c1wiKSB7XG5cdFx0XHRcdGNoYW5nZWQgPSB0cnVlO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IG5ld1YgPSBwcmVwYXJlRm9yUGVyc2lzdGVuY2UodiwgYmxvYlN0b3JlLCBrKTtcblx0XHRcdHJlc3VsdFtrXSA9IG5ld1Y7XG5cdFx0XHRpZiAobmV3ViAhPT0gdikgY2hhbmdlZCA9IHRydWU7XG5cdFx0fVxuXHRcdC8vIFVwZGF0ZSBsaW5lQ291bnQgaWYgY29udGVudCB3YXMgdHJ1bmNhdGVkIChmb3IgRmlsZU1lbnRpb25GaWxlKVxuXHRcdGlmIChjaGFuZ2VkICYmIFwibGluZUNvdW50XCIgaW4gcmVzdWx0ICYmIFwiY29udGVudFwiIGluIHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0LmNvbnRlbnQgPT09IFwic3RyaW5nXCIpIHtcblx0XHRcdHJlc3VsdC5saW5lQ291bnQgPSAocmVzdWx0LmNvbnRlbnQgYXMgc3RyaW5nKS5zcGxpdChcIlxcblwiKS5sZW5ndGg7XG5cdFx0fVxuXHRcdHJldHVybiBjaGFuZ2VkID8gcmVzdWx0IDogb2JqO1xuXHR9XG5cblx0cmV0dXJuIG9iajtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIGJsb2IgcmVmZXJlbmNlcyBpbiBsb2FkZWQgZW50cmllcywgcmVwbGFjaW5nIGBibG9iOnNoYTI1Njo8aGFzaD5gIGRhdGFcbiAqIGZpZWxkcyB3aXRoIGFjdHVhbCBiYXNlNjQgY29udGVudC4gTXV0YXRlcyBlbnRyaWVzIGluIHBsYWNlLlxuICovXG5mdW5jdGlvbiByZXNvbHZlQmxvYlJlZnNJbkVudHJpZXMoZW50cmllczogRmlsZUVudHJ5W10sIGJsb2JTdG9yZTogQmxvYlN0b3JlKTogdm9pZCB7XG5cdGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuXHRcdGlmIChlbnRyeS50eXBlID09PSBcInNlc3Npb25cIikgY29udGludWU7XG5cblx0XHRsZXQgY29udGVudEFycmF5OiB1bmtub3duW10gfCB1bmRlZmluZWQ7XG5cdFx0aWYgKGVudHJ5LnR5cGUgPT09IFwibWVzc2FnZVwiKSB7XG5cdFx0XHRjb25zdCBjb250ZW50ID0gKChlbnRyeSBhcyBTZXNzaW9uTWVzc2FnZUVudHJ5KS5tZXNzYWdlIGFzIHsgY29udGVudD86IHVua25vd24gfSkuY29udGVudDtcblx0XHRcdGlmIChBcnJheS5pc0FycmF5KGNvbnRlbnQpKSBjb250ZW50QXJyYXkgPSBjb250ZW50O1xuXHRcdH0gZWxzZSBpZiAoZW50cnkudHlwZSA9PT0gXCJjdXN0b21fbWVzc2FnZVwiICYmIEFycmF5LmlzQXJyYXkoKGVudHJ5IGFzIGFueSkuY29udGVudCkpIHtcblx0XHRcdGNvbnRlbnRBcnJheSA9IChlbnRyeSBhcyBhbnkpLmNvbnRlbnQ7XG5cdFx0fVxuXG5cdFx0aWYgKCFjb250ZW50QXJyYXkpIGNvbnRpbnVlO1xuXG5cdFx0Zm9yIChjb25zdCBibG9jayBvZiBjb250ZW50QXJyYXkpIHtcblx0XHRcdGlmIChpc0ltYWdlQmxvY2soYmxvY2spICYmIGlzQmxvYlJlZihibG9jay5kYXRhKSkge1xuXHRcdFx0XHQoYmxvY2sgYXMgeyBkYXRhOiBzdHJpbmcgfSkuZGF0YSA9IHJlc29sdmVJbWFnZURhdGEoYmxvYlN0b3JlLCBibG9jay5kYXRhKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cbn1cblxuZnVuY3Rpb24gbG9hZEVudHJpZXNGcm9tRmlsZShmaWxlUGF0aDogc3RyaW5nKTogRmlsZUVudHJ5W10ge1xuXHRpZiAoIWV4aXN0c1N5bmMoZmlsZVBhdGgpKSByZXR1cm4gW107XG5cblx0Y29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGY4XCIpO1xuXHRjb25zdCBlbnRyaWVzOiBGaWxlRW50cnlbXSA9IFtdO1xuXHRjb25zdCBsaW5lcyA9IGNvbnRlbnQudHJpbSgpLnNwbGl0KFwiXFxuXCIpO1xuXG5cdGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuXHRcdGlmICghbGluZS50cmltKCkpIGNvbnRpbnVlO1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBlbnRyeSA9IEpTT04ucGFyc2UobGluZSkgYXMgRmlsZUVudHJ5O1xuXHRcdFx0ZW50cmllcy5wdXNoKGVudHJ5KTtcblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIFNraXAgbWFsZm9ybWVkIGxpbmVzXG5cdFx0fVxuXHR9XG5cblx0Ly8gVmFsaWRhdGUgc2Vzc2lvbiBoZWFkZXJcblx0aWYgKGVudHJpZXMubGVuZ3RoID09PSAwKSByZXR1cm4gZW50cmllcztcblx0Y29uc3QgaGVhZGVyID0gZW50cmllc1swXTtcblx0aWYgKGhlYWRlci50eXBlICE9PSBcInNlc3Npb25cIiB8fCB0eXBlb2YgKGhlYWRlciBhcyBhbnkpLmlkICE9PSBcInN0cmluZ1wiKSB7XG5cdFx0cmV0dXJuIFtdO1xuXHR9XG5cblx0cmV0dXJuIGVudHJpZXM7XG59XG5cbmZ1bmN0aW9uIGlzVmFsaWRTZXNzaW9uRmlsZShmaWxlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG5cdHRyeSB7XG5cdFx0Y29uc3QgZmQgPSBvcGVuU3luYyhmaWxlUGF0aCwgXCJyXCIpO1xuXHRcdGNvbnN0IGJ1ZmZlciA9IEJ1ZmZlci5hbGxvYyg1MTIpO1xuXHRcdGNvbnN0IGJ5dGVzUmVhZCA9IHJlYWRTeW5jKGZkLCBidWZmZXIsIDAsIDUxMiwgMCk7XG5cdFx0Y2xvc2VTeW5jKGZkKTtcblx0XHRjb25zdCBmaXJzdExpbmUgPSBidWZmZXIudG9TdHJpbmcoXCJ1dGY4XCIsIDAsIGJ5dGVzUmVhZCkuc3BsaXQoXCJcXG5cIilbMF07XG5cdFx0aWYgKCFmaXJzdExpbmUpIHJldHVybiBmYWxzZTtcblx0XHRjb25zdCBoZWFkZXIgPSBKU09OLnBhcnNlKGZpcnN0TGluZSk7XG5cdFx0cmV0dXJuIGhlYWRlci50eXBlID09PSBcInNlc3Npb25cIiAmJiB0eXBlb2YgaGVhZGVyLmlkID09PSBcInN0cmluZ1wiO1xuXHR9IGNhdGNoIHtcblx0XHRyZXR1cm4gZmFsc2U7XG5cdH1cbn1cblxuZnVuY3Rpb24gZmluZE1vc3RSZWNlbnRTZXNzaW9uKHNlc3Npb25EaXI6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuXHR0cnkge1xuXHRcdGNvbnN0IGZpbGVzID0gcmVhZGRpclN5bmMoc2Vzc2lvbkRpcilcblx0XHRcdC5maWx0ZXIoKGYpID0+IGYuZW5kc1dpdGgoXCIuanNvbmxcIikpXG5cdFx0XHQubWFwKChmKSA9PiBqb2luKHNlc3Npb25EaXIsIGYpKVxuXHRcdFx0LmZpbHRlcihpc1ZhbGlkU2Vzc2lvbkZpbGUpXG5cdFx0XHQubWFwKChwYXRoKSA9PiAoeyBwYXRoLCBtdGltZTogc3RhdFN5bmMocGF0aCkubXRpbWUgfSkpXG5cdFx0XHQuc29ydCgoYSwgYikgPT4gYi5tdGltZS5nZXRUaW1lKCkgLSBhLm10aW1lLmdldFRpbWUoKSk7XG5cblx0XHRyZXR1cm4gZmlsZXNbMF0/LnBhdGggfHwgbnVsbDtcblx0fSBjYXRjaCB7XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cbn1cblxuZnVuY3Rpb24gaXNNZXNzYWdlV2l0aENvbnRlbnQobWVzc2FnZTogQWdlbnRNZXNzYWdlKTogbWVzc2FnZSBpcyBNZXNzYWdlIHtcblx0cmV0dXJuIHR5cGVvZiAobWVzc2FnZSBhcyBNZXNzYWdlKS5yb2xlID09PSBcInN0cmluZ1wiICYmIFwiY29udGVudFwiIGluIG1lc3NhZ2U7XG59XG5cbmZ1bmN0aW9uIGV4dHJhY3RUZXh0Q29udGVudChtZXNzYWdlOiBNZXNzYWdlKTogc3RyaW5nIHtcblx0Y29uc3QgY29udGVudCA9IG1lc3NhZ2UuY29udGVudDtcblx0aWYgKHR5cGVvZiBjb250ZW50ID09PSBcInN0cmluZ1wiKSB7XG5cdFx0cmV0dXJuIGNvbnRlbnQ7XG5cdH1cblx0cmV0dXJuIGNvbnRlbnRcblx0XHQuZmlsdGVyKChibG9jayk6IGJsb2NrIGlzIFRleHRDb250ZW50ID0+IGJsb2NrLnR5cGUgPT09IFwidGV4dFwiKVxuXHRcdC5tYXAoKGJsb2NrKSA9PiBibG9jay50ZXh0KVxuXHRcdC5qb2luKFwiIFwiKTtcbn1cblxuZnVuY3Rpb24gZ2V0TGFzdEFjdGl2aXR5VGltZShlbnRyaWVzOiBGaWxlRW50cnlbXSk6IG51bWJlciB8IHVuZGVmaW5lZCB7XG5cdGxldCBsYXN0QWN0aXZpdHlUaW1lOiBudW1iZXIgfCB1bmRlZmluZWQ7XG5cblx0Zm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG5cdFx0aWYgKGVudHJ5LnR5cGUgIT09IFwibWVzc2FnZVwiKSBjb250aW51ZTtcblxuXHRcdGNvbnN0IG1lc3NhZ2UgPSAoZW50cnkgYXMgU2Vzc2lvbk1lc3NhZ2VFbnRyeSkubWVzc2FnZTtcblx0XHRpZiAoIWlzTWVzc2FnZVdpdGhDb250ZW50KG1lc3NhZ2UpKSBjb250aW51ZTtcblx0XHRpZiAobWVzc2FnZS5yb2xlICE9PSBcInVzZXJcIiAmJiBtZXNzYWdlLnJvbGUgIT09IFwiYXNzaXN0YW50XCIpIGNvbnRpbnVlO1xuXG5cdFx0Y29uc3QgbXNnVGltZXN0YW1wID0gKG1lc3NhZ2UgYXMgeyB0aW1lc3RhbXA/OiBudW1iZXIgfSkudGltZXN0YW1wO1xuXHRcdGlmICh0eXBlb2YgbXNnVGltZXN0YW1wID09PSBcIm51bWJlclwiKSB7XG5cdFx0XHRsYXN0QWN0aXZpdHlUaW1lID0gTWF0aC5tYXgobGFzdEFjdGl2aXR5VGltZSA/PyAwLCBtc2dUaW1lc3RhbXApO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Y29uc3QgZW50cnlUaW1lc3RhbXAgPSAoZW50cnkgYXMgU2Vzc2lvbkVudHJ5QmFzZSkudGltZXN0YW1wO1xuXHRcdGlmICh0eXBlb2YgZW50cnlUaW1lc3RhbXAgPT09IFwic3RyaW5nXCIpIHtcblx0XHRcdGNvbnN0IHQgPSBuZXcgRGF0ZShlbnRyeVRpbWVzdGFtcCkuZ2V0VGltZSgpO1xuXHRcdFx0aWYgKCFOdW1iZXIuaXNOYU4odCkpIHtcblx0XHRcdFx0bGFzdEFjdGl2aXR5VGltZSA9IE1hdGgubWF4KGxhc3RBY3Rpdml0eVRpbWUgPz8gMCwgdCk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIGxhc3RBY3Rpdml0eVRpbWU7XG59XG5cbmZ1bmN0aW9uIGdldFNlc3Npb25Nb2RpZmllZERhdGUoZW50cmllczogRmlsZUVudHJ5W10sIGhlYWRlcjogU2Vzc2lvbkhlYWRlciwgc3RhdHNNdGltZTogRGF0ZSk6IERhdGUge1xuXHRjb25zdCBsYXN0QWN0aXZpdHlUaW1lID0gZ2V0TGFzdEFjdGl2aXR5VGltZShlbnRyaWVzKTtcblx0aWYgKHR5cGVvZiBsYXN0QWN0aXZpdHlUaW1lID09PSBcIm51bWJlclwiICYmIGxhc3RBY3Rpdml0eVRpbWUgPiAwKSB7XG5cdFx0cmV0dXJuIG5ldyBEYXRlKGxhc3RBY3Rpdml0eVRpbWUpO1xuXHR9XG5cblx0Y29uc3QgaGVhZGVyVGltZSA9IHR5cGVvZiBoZWFkZXIudGltZXN0YW1wID09PSBcInN0cmluZ1wiID8gbmV3IERhdGUoaGVhZGVyLnRpbWVzdGFtcCkuZ2V0VGltZSgpIDogTmFOO1xuXHRyZXR1cm4gIU51bWJlci5pc05hTihoZWFkZXJUaW1lKSA/IG5ldyBEYXRlKGhlYWRlclRpbWUpIDogc3RhdHNNdGltZTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gYnVpbGRTZXNzaW9uSW5mbyhmaWxlUGF0aDogc3RyaW5nKTogUHJvbWlzZTxTZXNzaW9uSW5mbyB8IG51bGw+IHtcblx0dHJ5IHtcblx0XHRjb25zdCBjb250ZW50ID0gYXdhaXQgcmVhZEZpbGUoZmlsZVBhdGgsIFwidXRmOFwiKTtcblx0XHRjb25zdCBlbnRyaWVzOiBGaWxlRW50cnlbXSA9IFtdO1xuXHRcdGNvbnN0IGxpbmVzID0gY29udGVudC50cmltKCkuc3BsaXQoXCJcXG5cIik7XG5cblx0XHRmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcblx0XHRcdGlmICghbGluZS50cmltKCkpIGNvbnRpbnVlO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0ZW50cmllcy5wdXNoKEpTT04ucGFyc2UobGluZSkgYXMgRmlsZUVudHJ5KTtcblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHQvLyBTa2lwIG1hbGZvcm1lZCBsaW5lc1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGlmIChlbnRyaWVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cdFx0Y29uc3QgaGVhZGVyID0gZW50cmllc1swXTtcblx0XHRpZiAoaGVhZGVyLnR5cGUgIT09IFwic2Vzc2lvblwiKSByZXR1cm4gbnVsbDtcblxuXHRcdGNvbnN0IHN0YXRzID0gYXdhaXQgc3RhdChmaWxlUGF0aCk7XG5cdFx0bGV0IG1lc3NhZ2VDb3VudCA9IDA7XG5cdFx0bGV0IGZpcnN0TWVzc2FnZSA9IFwiXCI7XG5cdFx0Y29uc3QgYWxsTWVzc2FnZXM6IHN0cmluZ1tdID0gW107XG5cdFx0bGV0IG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZDtcblxuXHRcdGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuXHRcdFx0Ly8gRXh0cmFjdCBzZXNzaW9uIG5hbWUgKHVzZSBsYXRlc3QpXG5cdFx0XHRpZiAoZW50cnkudHlwZSA9PT0gXCJzZXNzaW9uX2luZm9cIikge1xuXHRcdFx0XHRjb25zdCBpbmZvRW50cnkgPSBlbnRyeSBhcyBTZXNzaW9uSW5mb0VudHJ5O1xuXHRcdFx0XHRpZiAoaW5mb0VudHJ5Lm5hbWUpIHtcblx0XHRcdFx0XHRuYW1lID0gaW5mb0VudHJ5Lm5hbWUudHJpbSgpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGlmIChlbnRyeS50eXBlICE9PSBcIm1lc3NhZ2VcIikgY29udGludWU7XG5cdFx0XHRtZXNzYWdlQ291bnQrKztcblxuXHRcdFx0Y29uc3QgbWVzc2FnZSA9IChlbnRyeSBhcyBTZXNzaW9uTWVzc2FnZUVudHJ5KS5tZXNzYWdlO1xuXHRcdFx0aWYgKCFpc01lc3NhZ2VXaXRoQ29udGVudChtZXNzYWdlKSkgY29udGludWU7XG5cdFx0XHRpZiAobWVzc2FnZS5yb2xlICE9PSBcInVzZXJcIiAmJiBtZXNzYWdlLnJvbGUgIT09IFwiYXNzaXN0YW50XCIpIGNvbnRpbnVlO1xuXG5cdFx0XHRjb25zdCB0ZXh0Q29udGVudCA9IGV4dHJhY3RUZXh0Q29udGVudChtZXNzYWdlKTtcblx0XHRcdGlmICghdGV4dENvbnRlbnQpIGNvbnRpbnVlO1xuXG5cdFx0XHRhbGxNZXNzYWdlcy5wdXNoKHRleHRDb250ZW50KTtcblx0XHRcdGlmICghZmlyc3RNZXNzYWdlICYmIG1lc3NhZ2Uucm9sZSA9PT0gXCJ1c2VyXCIpIHtcblx0XHRcdFx0Zmlyc3RNZXNzYWdlID0gdGV4dENvbnRlbnQ7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Y29uc3QgY3dkID0gdHlwZW9mIChoZWFkZXIgYXMgU2Vzc2lvbkhlYWRlcikuY3dkID09PSBcInN0cmluZ1wiID8gKGhlYWRlciBhcyBTZXNzaW9uSGVhZGVyKS5jd2QgOiBcIlwiO1xuXHRcdGNvbnN0IHBhcmVudFNlc3Npb25QYXRoID0gKGhlYWRlciBhcyBTZXNzaW9uSGVhZGVyKS5wYXJlbnRTZXNzaW9uO1xuXG5cdFx0Y29uc3QgbW9kaWZpZWQgPSBnZXRTZXNzaW9uTW9kaWZpZWREYXRlKGVudHJpZXMsIGhlYWRlciBhcyBTZXNzaW9uSGVhZGVyLCBzdGF0cy5tdGltZSk7XG5cblx0XHRyZXR1cm4ge1xuXHRcdFx0cGF0aDogZmlsZVBhdGgsXG5cdFx0XHRpZDogKGhlYWRlciBhcyBTZXNzaW9uSGVhZGVyKS5pZCxcblx0XHRcdGN3ZCxcblx0XHRcdG5hbWUsXG5cdFx0XHRwYXJlbnRTZXNzaW9uUGF0aCxcblx0XHRcdGNyZWF0ZWQ6IG5ldyBEYXRlKChoZWFkZXIgYXMgU2Vzc2lvbkhlYWRlcikudGltZXN0YW1wKSxcblx0XHRcdG1vZGlmaWVkLFxuXHRcdFx0bWVzc2FnZUNvdW50LFxuXHRcdFx0Zmlyc3RNZXNzYWdlOiBmaXJzdE1lc3NhZ2UgfHwgXCIobm8gbWVzc2FnZXMpXCIsXG5cdFx0XHRhbGxNZXNzYWdlc1RleHQ6IGFsbE1lc3NhZ2VzLmpvaW4oXCIgXCIpLFxuXHRcdH07XG5cdH0gY2F0Y2gge1xuXHRcdHJldHVybiBudWxsO1xuXHR9XG59XG5cbmV4cG9ydCB0eXBlIFNlc3Npb25MaXN0UHJvZ3Jlc3MgPSAobG9hZGVkOiBudW1iZXIsIHRvdGFsOiBudW1iZXIpID0+IHZvaWQ7XG5cbmFzeW5jIGZ1bmN0aW9uIGxpc3RTZXNzaW9uc0Zyb21EaXIoXG5cdGRpcjogc3RyaW5nLFxuXHRvblByb2dyZXNzPzogU2Vzc2lvbkxpc3RQcm9ncmVzcyxcblx0cHJvZ3Jlc3NPZmZzZXQgPSAwLFxuXHRwcm9ncmVzc1RvdGFsPzogbnVtYmVyLFxuKTogUHJvbWlzZTxTZXNzaW9uSW5mb1tdPiB7XG5cdGNvbnN0IHNlc3Npb25zOiBTZXNzaW9uSW5mb1tdID0gW107XG5cdGlmICghZXhpc3RzU3luYyhkaXIpKSB7XG5cdFx0cmV0dXJuIHNlc3Npb25zO1xuXHR9XG5cblx0dHJ5IHtcblx0XHRjb25zdCBkaXJFbnRyaWVzID0gYXdhaXQgcmVhZGRpcihkaXIpO1xuXHRcdGNvbnN0IGZpbGVzID0gZGlyRW50cmllcy5maWx0ZXIoKGYpID0+IGYuZW5kc1dpdGgoXCIuanNvbmxcIikpLm1hcCgoZikgPT4gam9pbihkaXIsIGYpKTtcblx0XHRjb25zdCB0b3RhbCA9IHByb2dyZXNzVG90YWwgPz8gZmlsZXMubGVuZ3RoO1xuXG5cdFx0bGV0IGxvYWRlZCA9IDA7XG5cdFx0Y29uc3QgcmVzdWx0cyA9IGF3YWl0IFByb21pc2UuYWxsKFxuXHRcdFx0ZmlsZXMubWFwKGFzeW5jIChmaWxlKSA9PiB7XG5cdFx0XHRcdGNvbnN0IGluZm8gPSBhd2FpdCBidWlsZFNlc3Npb25JbmZvKGZpbGUpO1xuXHRcdFx0XHRsb2FkZWQrKztcblx0XHRcdFx0b25Qcm9ncmVzcz8uKHByb2dyZXNzT2Zmc2V0ICsgbG9hZGVkLCB0b3RhbCk7XG5cdFx0XHRcdHJldHVybiBpbmZvO1xuXHRcdFx0fSksXG5cdFx0KTtcblx0XHRmb3IgKGNvbnN0IGluZm8gb2YgcmVzdWx0cykge1xuXHRcdFx0aWYgKGluZm8pIHtcblx0XHRcdFx0c2Vzc2lvbnMucHVzaChpbmZvKTtcblx0XHRcdH1cblx0XHR9XG5cdH0gY2F0Y2gge1xuXHRcdC8vIFJldHVybiBlbXB0eSBsaXN0IG9uIGVycm9yXG5cdH1cblxuXHRyZXR1cm4gc2Vzc2lvbnM7XG59XG5cbi8qKlxuICogTWFuYWdlcyBjb252ZXJzYXRpb24gc2Vzc2lvbnMgYXMgYXBwZW5kLW9ubHkgdHJlZXMgc3RvcmVkIGluIEpTT05MIGZpbGVzLlxuICpcbiAqIEVhY2ggc2Vzc2lvbiBlbnRyeSBoYXMgYW4gaWQgYW5kIHBhcmVudElkIGZvcm1pbmcgYSB0cmVlIHN0cnVjdHVyZS4gVGhlIFwibGVhZlwiXG4gKiBwb2ludGVyIHRyYWNrcyB0aGUgY3VycmVudCBwb3NpdGlvbi4gQXBwZW5kaW5nIGNyZWF0ZXMgYSBjaGlsZCBvZiB0aGUgY3VycmVudCBsZWFmLlxuICogQnJhbmNoaW5nIG1vdmVzIHRoZSBsZWFmIHRvIGFuIGVhcmxpZXIgZW50cnksIGFsbG93aW5nIG5ldyBicmFuY2hlcyB3aXRob3V0XG4gKiBtb2RpZnlpbmcgaGlzdG9yeS5cbiAqXG4gKiBVc2UgYnVpbGRTZXNzaW9uQ29udGV4dCgpIHRvIGdldCB0aGUgcmVzb2x2ZWQgbWVzc2FnZSBsaXN0IGZvciB0aGUgTExNLCB3aGljaFxuICogaGFuZGxlcyBjb21wYWN0aW9uIHN1bW1hcmllcyBhbmQgZm9sbG93cyB0aGUgcGF0aCBmcm9tIHJvb3QgdG8gY3VycmVudCBsZWFmLlxuICovXG5leHBvcnQgY2xhc3MgU2Vzc2lvbk1hbmFnZXIge1xuXHRwcml2YXRlIHNlc3Npb25JZDogc3RyaW5nID0gXCJcIjtcblx0cHJpdmF0ZSBzZXNzaW9uRmlsZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXHRwcml2YXRlIHNlc3Npb25EaXI6IHN0cmluZztcblx0cHJpdmF0ZSBjd2Q6IHN0cmluZztcblx0cHJpdmF0ZSBwZXJzaXN0OiBib29sZWFuO1xuXHRwcml2YXRlIGZsdXNoZWQ6IGJvb2xlYW4gPSBmYWxzZTtcblx0cHJpdmF0ZSBmaWxlRW50cmllczogRmlsZUVudHJ5W10gPSBbXTtcblx0cHJpdmF0ZSBzZXNzaW9uRW50cmllczogU2Vzc2lvbkVudHJ5W10gPSBbXTtcblx0cHJpdmF0ZSBieUlkOiBNYXA8c3RyaW5nLCBTZXNzaW9uRW50cnk+ID0gbmV3IE1hcCgpO1xuXHRwcml2YXRlIGJsb2JTdG9yZTogQmxvYlN0b3JlO1xuXHRwcml2YXRlIGxhYmVsc0J5SWQ6IE1hcDxzdHJpbmcsIHN0cmluZz4gPSBuZXcgTWFwKCk7XG5cdHByaXZhdGUgbGVhZklkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSB1c2FnZVRvdGFsczogU2Vzc2lvblVzYWdlVG90YWxzID0gY3JlYXRlRW1wdHlVc2FnZVRvdGFscygpO1xuXG5cdHByaXZhdGUgY29uc3RydWN0b3IoY3dkOiBzdHJpbmcsIHNlc3Npb25EaXI6IHN0cmluZywgc2Vzc2lvbkZpbGU6IHN0cmluZyB8IHVuZGVmaW5lZCwgcGVyc2lzdDogYm9vbGVhbikge1xuXHRcdHRoaXMuY3dkID0gY3dkO1xuXHRcdHRoaXMuc2Vzc2lvbkRpciA9IHNlc3Npb25EaXI7XG5cdFx0dGhpcy5wZXJzaXN0ID0gcGVyc2lzdDtcblx0XHR0aGlzLmJsb2JTdG9yZSA9IG5ldyBCbG9iU3RvcmUoZ2V0QmxvYnNEaXIoKSk7XG5cdFx0aWYgKHBlcnNpc3QgJiYgc2Vzc2lvbkRpciAmJiAhZXhpc3RzU3luYyhzZXNzaW9uRGlyKSkge1xuXHRcdFx0bWtkaXJTeW5jKHNlc3Npb25EaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdH1cblxuXHRcdGlmIChzZXNzaW9uRmlsZSkge1xuXHRcdFx0dGhpcy5zZXRTZXNzaW9uRmlsZShzZXNzaW9uRmlsZSk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHRoaXMubmV3U2Vzc2lvbigpO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBDaGVjayBpZiB0aGUgbGFzdCBhc3Npc3RhbnQgdHVybiBpbiB0aGUgc2Vzc2lvbiBhcHBlYXJzIHRvIGhhdmUgYmVlblxuXHQgKiBpbnRlcnJ1cHRlZCAoZS5nLiwgdGhlIGxhc3QgbWVzc2FnZSBpcyBmcm9tIHRoZSBhc3Npc3RhbnQgd2l0aCB0b29sX3VzZVxuXHQgKiBibG9ja3MgYnV0IG5vIHN1YnNlcXVlbnQgdG9vbF9yZXN1bHQgbWVzc2FnZSkuXG5cdCAqL1xuXHR3YXNJbnRlcnJ1cHRlZCgpOiBib29sZWFuIHtcblx0XHQvLyBXYWxrIGJhY2t3YXJkcyB0byBmaW5kIHRoZSBsYXN0IG1lc3NhZ2UgZW50cnlcblx0XHRmb3IgKGxldCBpID0gdGhpcy5maWxlRW50cmllcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuXHRcdFx0Y29uc3QgZW50cnkgPSB0aGlzLmZpbGVFbnRyaWVzW2ldO1xuXHRcdFx0aWYgKGVudHJ5LnR5cGUgIT09IFwibWVzc2FnZVwiKSBjb250aW51ZTtcblxuXHRcdFx0Y29uc3QgbXNnID0gZW50cnkubWVzc2FnZTtcblx0XHRcdGlmIChtc2cucm9sZSA9PT0gXCJ1c2VyXCIpIHJldHVybiBmYWxzZTsgLy8gY2xlYW4gdXNlciB0dXJuIGJvdW5kYXJ5XG5cdFx0XHRpZiAobXNnLnJvbGUgPT09IFwiYXNzaXN0YW50XCIpIHtcblx0XHRcdFx0Ly8gQ2hlY2sgaWYgdGhlIGFzc2lzdGFudCBtZXNzYWdlIGNvbnRhaW5zIHRvb2xfdXNlIGJsb2Nrc1xuXHRcdFx0XHRjb25zdCBjb250ZW50ID0gQXJyYXkuaXNBcnJheShtc2cuY29udGVudCkgPyBtc2cuY29udGVudCA6IFtdO1xuXHRcdFx0XHRjb25zdCBoYXNUb29sVXNlID0gY29udGVudC5zb21lKFxuXHRcdFx0XHRcdChibG9jaykgPT4gYmxvY2sudHlwZSA9PT0gXCJ0b29sQ2FsbFwiLFxuXHRcdFx0XHQpO1xuXHRcdFx0XHRpZiAoaGFzVG9vbFVzZSkge1xuXHRcdFx0XHRcdC8vIElmIHRoZSBsYXN0IG1lc3NhZ2UgaXMgYW4gYXNzaXN0YW50IHRvb2xfdXNlIHdpdGggbm8gZm9sbG93aW5nXG5cdFx0XHRcdFx0Ly8gdG9vbF9yZXN1bHQgbWVzc2FnZSwgdGhlIHR1cm4gd2FzIGxpa2VseSBpbnRlcnJ1cHRlZFxuXHRcdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiBmYWxzZTsgLy8gYXNzaXN0YW50IG1lc3NhZ2Ugd2l0aG91dCB0b29sX3VzZSA9IGNvbXBsZXRlZCB0ZXh0IHJlc3BvbnNlXG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0fVxuXHRcdHJldHVybiBmYWxzZTtcblx0fVxuXG5cdC8qKiBTd2l0Y2ggdG8gYSBkaWZmZXJlbnQgc2Vzc2lvbiBmaWxlICh1c2VkIGZvciByZXN1bWUgYW5kIGJyYW5jaGluZykgKi9cblx0c2V0U2Vzc2lvbkZpbGUoc2Vzc2lvbkZpbGU6IHN0cmluZyk6IHZvaWQge1xuXHRcdHRoaXMuc2Vzc2lvbkZpbGUgPSByZXNvbHZlKHNlc3Npb25GaWxlKTtcblx0XHRpZiAoZXhpc3RzU3luYyh0aGlzLnNlc3Npb25GaWxlKSkge1xuXHRcdFx0dGhpcy5maWxlRW50cmllcyA9IGxvYWRFbnRyaWVzRnJvbUZpbGUodGhpcy5zZXNzaW9uRmlsZSk7XG5cblx0XHRcdC8vIElmIGZpbGUgd2FzIGVtcHR5IG9yIGNvcnJ1cHRlZCAobm8gdmFsaWQgaGVhZGVyKSwgdHJ1bmNhdGUgYW5kIHN0YXJ0IGZyZXNoXG5cdFx0XHQvLyB0byBhdm9pZCBhcHBlbmRpbmcgbWVzc2FnZXMgd2l0aG91dCBhIHNlc3Npb24gaGVhZGVyICh3aGljaCBicmVha3MgdGhlIHNlc3Npb24pXG5cdFx0XHRpZiAodGhpcy5maWxlRW50cmllcy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0Y29uc3QgZXhwbGljaXRQYXRoID0gdGhpcy5zZXNzaW9uRmlsZTtcblx0XHRcdFx0dGhpcy5uZXdTZXNzaW9uKCk7XG5cdFx0XHRcdHRoaXMuc2Vzc2lvbkZpbGUgPSBleHBsaWNpdFBhdGg7XG5cdFx0XHRcdHRoaXMuX3Jld3JpdGVGaWxlKCk7XG5cdFx0XHRcdHRoaXMuZmx1c2hlZCA9IHRydWU7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgaGVhZGVyID0gdGhpcy5maWxlRW50cmllcy5maW5kKChlKSA9PiBlLnR5cGUgPT09IFwic2Vzc2lvblwiKSBhcyBTZXNzaW9uSGVhZGVyIHwgdW5kZWZpbmVkO1xuXHRcdFx0dGhpcy5zZXNzaW9uSWQgPSBoZWFkZXI/LmlkID8/IHJhbmRvbVVVSUQoKTtcblxuXHRcdFx0aWYgKG1pZ3JhdGVUb0N1cnJlbnRWZXJzaW9uKHRoaXMuZmlsZUVudHJpZXMpKSB7XG5cdFx0XHRcdHRoaXMuX3Jld3JpdGVGaWxlKCk7XG5cdFx0XHR9XG5cblx0XHRcdHRoaXMuX2J1aWxkSW5kZXgoKTtcblx0XHRcdHJlc29sdmVCbG9iUmVmc0luRW50cmllcyh0aGlzLmZpbGVFbnRyaWVzLCB0aGlzLmJsb2JTdG9yZSk7XG5cdFx0XHR0aGlzLmZsdXNoZWQgPSB0cnVlO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRjb25zdCBleHBsaWNpdFBhdGggPSB0aGlzLnNlc3Npb25GaWxlO1xuXHRcdFx0dGhpcy5uZXdTZXNzaW9uKCk7XG5cdFx0XHR0aGlzLnNlc3Npb25GaWxlID0gZXhwbGljaXRQYXRoOyAvLyBwcmVzZXJ2ZSBleHBsaWNpdCBwYXRoIGZyb20gLS1zZXNzaW9uIGZsYWdcblx0XHR9XG5cdH1cblxuXHRuZXdTZXNzaW9uKG9wdGlvbnM/OiBOZXdTZXNzaW9uT3B0aW9ucyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG5cdFx0dGhpcy5zZXNzaW9uSWQgPSByYW5kb21VVUlEKCk7XG5cdFx0Y29uc3QgdGltZXN0YW1wID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXHRcdGNvbnN0IGhlYWRlcjogU2Vzc2lvbkhlYWRlciA9IHtcblx0XHRcdHR5cGU6IFwic2Vzc2lvblwiLFxuXHRcdFx0dmVyc2lvbjogQ1VSUkVOVF9TRVNTSU9OX1ZFUlNJT04sXG5cdFx0XHRpZDogdGhpcy5zZXNzaW9uSWQsXG5cdFx0XHR0aW1lc3RhbXAsXG5cdFx0XHRjd2Q6IHRoaXMuY3dkLFxuXHRcdFx0cGFyZW50U2Vzc2lvbjogb3B0aW9ucz8ucGFyZW50U2Vzc2lvbixcblx0XHR9O1xuXHRcdHRoaXMuZmlsZUVudHJpZXMgPSBbaGVhZGVyXTtcblx0XHR0aGlzLnNlc3Npb25FbnRyaWVzID0gW107XG5cdFx0dGhpcy5ieUlkLmNsZWFyKCk7XG5cdFx0dGhpcy5sYWJlbHNCeUlkLmNsZWFyKCk7XG5cdFx0dGhpcy5sZWFmSWQgPSBudWxsO1xuXHRcdHRoaXMudXNhZ2VUb3RhbHMgPSBjcmVhdGVFbXB0eVVzYWdlVG90YWxzKCk7XG5cdFx0dGhpcy5mbHVzaGVkID0gZmFsc2U7XG5cblx0XHRpZiAodGhpcy5wZXJzaXN0KSB7XG5cdFx0XHRjb25zdCBmaWxlVGltZXN0YW1wID0gdGltZXN0YW1wLnJlcGxhY2UoL1s6Ll0vZywgXCItXCIpO1xuXHRcdFx0dGhpcy5zZXNzaW9uRmlsZSA9IGpvaW4odGhpcy5nZXRTZXNzaW9uRGlyKCksIGAke2ZpbGVUaW1lc3RhbXB9XyR7dGhpcy5zZXNzaW9uSWR9Lmpzb25sYCk7XG5cdFx0fVxuXHRcdHJldHVybiB0aGlzLnNlc3Npb25GaWxlO1xuXHR9XG5cblx0cHJpdmF0ZSBfYnVpbGRJbmRleCgpOiB2b2lkIHtcblx0XHR0aGlzLnNlc3Npb25FbnRyaWVzID0gW107XG5cdFx0dGhpcy5ieUlkLmNsZWFyKCk7XG5cdFx0dGhpcy5sYWJlbHNCeUlkLmNsZWFyKCk7XG5cdFx0dGhpcy5sZWFmSWQgPSBudWxsO1xuXHRcdHRoaXMudXNhZ2VUb3RhbHMgPSBjcmVhdGVFbXB0eVVzYWdlVG90YWxzKCk7XG5cdFx0Zm9yIChjb25zdCBlbnRyeSBvZiB0aGlzLmZpbGVFbnRyaWVzKSB7XG5cdFx0XHRpZiAoZW50cnkudHlwZSA9PT0gXCJzZXNzaW9uXCIpIGNvbnRpbnVlO1xuXHRcdFx0dGhpcy5zZXNzaW9uRW50cmllcy5wdXNoKGVudHJ5KTtcblx0XHRcdHRoaXMuYnlJZC5zZXQoZW50cnkuaWQsIGVudHJ5KTtcblx0XHRcdHRoaXMubGVhZklkID0gZW50cnkuaWQ7XG5cdFx0XHR0aGlzLl9hY2N1bXVsYXRlVXNhZ2UoZW50cnkpO1xuXHRcdFx0aWYgKGVudHJ5LnR5cGUgPT09IFwibGFiZWxcIikge1xuXHRcdFx0XHRpZiAoZW50cnkubGFiZWwpIHtcblx0XHRcdFx0XHR0aGlzLmxhYmVsc0J5SWQuc2V0KGVudHJ5LnRhcmdldElkLCBlbnRyeS5sYWJlbCk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0dGhpcy5sYWJlbHNCeUlkLmRlbGV0ZShlbnRyeS50YXJnZXRJZCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIF9yZXdyaXRlRmlsZSgpOiB2b2lkIHtcblx0XHRpZiAoIXRoaXMucGVyc2lzdCB8fCAhdGhpcy5zZXNzaW9uRmlsZSkgcmV0dXJuO1xuXHRcdGNvbnN0IGNvbnRlbnQgPSBgJHt0aGlzLmZpbGVFbnRyaWVzLm1hcCgoZSkgPT4gSlNPTi5zdHJpbmdpZnkocHJlcGFyZUZvclBlcnNpc3RlbmNlKGUsIHRoaXMuYmxvYlN0b3JlKSkpLmpvaW4oXCJcXG5cIil9XFxuYDtcblx0XHRsZXQgcmVsZWFzZTogKCgpID0+IHZvaWQpIHwgdW5kZWZpbmVkO1xuXHRcdHRyeSB7XG5cdFx0XHRyZWxlYXNlID0gdHJ5QWNxdWlyZUxvY2tTeW5jKHRoaXMuc2Vzc2lvbkZpbGUpO1xuXHRcdFx0YXRvbWljV3JpdGVGaWxlU3luYyh0aGlzLnNlc3Npb25GaWxlLCBjb250ZW50KTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0cmVsZWFzZT8uKCk7XG5cdFx0fVxuXHR9XG5cblx0aXNQZXJzaXN0ZWQoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMucGVyc2lzdDtcblx0fVxuXG5cdGdldEN3ZCgpOiBzdHJpbmcge1xuXHRcdHJldHVybiB0aGlzLmN3ZDtcblx0fVxuXG5cdGdldFNlc3Npb25EaXIoKTogc3RyaW5nIHtcblx0XHRyZXR1cm4gdGhpcy5zZXNzaW9uRGlyO1xuXHR9XG5cblx0Z2V0U2Vzc2lvbklkKCk6IHN0cmluZyB7XG5cdFx0cmV0dXJuIHRoaXMuc2Vzc2lvbklkO1xuXHR9XG5cblx0Z2V0U2Vzc2lvbkZpbGUoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0XHRyZXR1cm4gdGhpcy5zZXNzaW9uRmlsZTtcblx0fVxuXG5cdF9wZXJzaXN0KGVudHJ5OiBTZXNzaW9uRW50cnkpOiB2b2lkIHtcblx0XHRpZiAoIXRoaXMucGVyc2lzdCB8fCAhdGhpcy5zZXNzaW9uRmlsZSkgcmV0dXJuO1xuXG5cdFx0Y29uc3QgaGFzQXNzaXN0YW50ID0gdGhpcy5maWxlRW50cmllcy5zb21lKChlKSA9PiBlLnR5cGUgPT09IFwibWVzc2FnZVwiICYmIGUubWVzc2FnZS5yb2xlID09PSBcImFzc2lzdGFudFwiKTtcblx0XHRpZiAoIWhhc0Fzc2lzdGFudCkge1xuXHRcdFx0Ly8gTWFyayBhcyBub3QgZmx1c2hlZCBzbyB3aGVuIGFzc2lzdGFudCBhcnJpdmVzLCBhbGwgZW50cmllcyBnZXQgd3JpdHRlblxuXHRcdFx0dGhpcy5mbHVzaGVkID0gZmFsc2U7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0bGV0IHJlbGVhc2U6ICgoKSA9PiB2b2lkKSB8IHVuZGVmaW5lZDtcblx0XHR0cnkge1xuXHRcdFx0cmVsZWFzZSA9IHRyeUFjcXVpcmVMb2NrU3luYyh0aGlzLnNlc3Npb25GaWxlKTtcblx0XHRcdGlmICghdGhpcy5mbHVzaGVkKSB7XG5cdFx0XHRcdGZvciAoY29uc3QgZSBvZiB0aGlzLmZpbGVFbnRyaWVzKSB7XG5cdFx0XHRcdFx0Y29uc3QgcHJlcGFyZWQgPSBwcmVwYXJlRm9yUGVyc2lzdGVuY2UoZSwgdGhpcy5ibG9iU3RvcmUpIGFzIEZpbGVFbnRyeTtcblx0XHRcdFx0XHRhcHBlbmRGaWxlU3luYyh0aGlzLnNlc3Npb25GaWxlLCBgJHtKU09OLnN0cmluZ2lmeShwcmVwYXJlZCl9XFxuYCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0dGhpcy5mbHVzaGVkID0gdHJ1ZTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGNvbnN0IHByZXBhcmVkID0gcHJlcGFyZUZvclBlcnNpc3RlbmNlKGVudHJ5LCB0aGlzLmJsb2JTdG9yZSkgYXMgRmlsZUVudHJ5O1xuXHRcdFx0XHRhcHBlbmRGaWxlU3luYyh0aGlzLnNlc3Npb25GaWxlLCBgJHtKU09OLnN0cmluZ2lmeShwcmVwYXJlZCl9XFxuYCk7XG5cdFx0XHR9XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdHJlbGVhc2U/LigpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgX2FwcGVuZEVudHJ5KGVudHJ5OiBTZXNzaW9uRW50cnkpOiB2b2lkIHtcblx0XHR0aGlzLmZpbGVFbnRyaWVzLnB1c2goZW50cnkpO1xuXHRcdHRoaXMuc2Vzc2lvbkVudHJpZXMucHVzaChlbnRyeSk7XG5cdFx0dGhpcy5ieUlkLnNldChlbnRyeS5pZCwgZW50cnkpO1xuXHRcdHRoaXMubGVhZklkID0gZW50cnkuaWQ7XG5cdFx0dGhpcy5fYWNjdW11bGF0ZVVzYWdlKGVudHJ5KTtcblx0XHR0aGlzLl9wZXJzaXN0KGVudHJ5KTtcblx0fVxuXG5cdHByaXZhdGUgX2FjY3VtdWxhdGVVc2FnZShlbnRyeTogU2Vzc2lvbkVudHJ5KTogdm9pZCB7XG5cdFx0aWYgKGVudHJ5LnR5cGUgIT09IFwibWVzc2FnZVwiIHx8IGVudHJ5Lm1lc3NhZ2Uucm9sZSAhPT0gXCJhc3Npc3RhbnRcIikge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IHVzYWdlID0gZW50cnkubWVzc2FnZS51c2FnZTtcblx0XHRpZiAoIXVzYWdlKSB7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0dGhpcy51c2FnZVRvdGFscy5pbnB1dCArPSB1c2FnZS5pbnB1dDtcblx0XHR0aGlzLnVzYWdlVG90YWxzLm91dHB1dCArPSB1c2FnZS5vdXRwdXQ7XG5cdFx0dGhpcy51c2FnZVRvdGFscy5jYWNoZVJlYWQgKz0gdXNhZ2UuY2FjaGVSZWFkO1xuXHRcdHRoaXMudXNhZ2VUb3RhbHMuY2FjaGVXcml0ZSArPSB1c2FnZS5jYWNoZVdyaXRlO1xuXHRcdHRoaXMudXNhZ2VUb3RhbHMuY29zdCArPSB1c2FnZS5jb3N0LnRvdGFsO1xuXHR9XG5cblx0LyoqIEFwcGVuZCBhIG1lc3NhZ2UgYXMgY2hpbGQgb2YgY3VycmVudCBsZWFmLCB0aGVuIGFkdmFuY2UgbGVhZi4gUmV0dXJucyBlbnRyeSBpZC5cblx0ICogRG9lcyBub3QgYWxsb3cgd3JpdGluZyBDb21wYWN0aW9uU3VtbWFyeU1lc3NhZ2UgYW5kIEJyYW5jaFN1bW1hcnlNZXNzYWdlIGRpcmVjdGx5LlxuXHQgKiBSZWFzb246IHdlIHdhbnQgdGhlc2UgdG8gYmUgdG9wLWxldmVsIGVudHJpZXMgaW4gdGhlIHNlc3Npb24sIG5vdCBtZXNzYWdlIHNlc3Npb24gZW50cmllcyxcblx0ICogc28gaXQgaXMgZWFzaWVyIHRvIGZpbmQgdGhlbS5cblx0ICogVGhlc2UgbmVlZCB0byBiZSBhcHBlbmRlZCB2aWEgYXBwZW5kQ29tcGFjdGlvbigpIGFuZCBhcHBlbmRCcmFuY2hTdW1tYXJ5KCkgbWV0aG9kcy5cblx0ICovXG5cdGFwcGVuZE1lc3NhZ2UobWVzc2FnZTogTWVzc2FnZSB8IEN1c3RvbU1lc3NhZ2UgfCBCYXNoRXhlY3V0aW9uTWVzc2FnZSk6IHN0cmluZyB7XG5cdFx0Y29uc3QgZW50cnk6IFNlc3Npb25NZXNzYWdlRW50cnkgPSB7XG5cdFx0XHR0eXBlOiBcIm1lc3NhZ2VcIixcblx0XHRcdGlkOiBnZW5lcmF0ZUlkKHRoaXMuYnlJZCksXG5cdFx0XHRwYXJlbnRJZDogdGhpcy5sZWFmSWQsXG5cdFx0XHR0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRcdG1lc3NhZ2UsXG5cdFx0fTtcblx0XHR0aGlzLl9hcHBlbmRFbnRyeShlbnRyeSk7XG5cdFx0cmV0dXJuIGVudHJ5LmlkO1xuXHR9XG5cblx0LyoqIEFwcGVuZCBhIHRoaW5raW5nIGxldmVsIGNoYW5nZSBhcyBjaGlsZCBvZiBjdXJyZW50IGxlYWYsIHRoZW4gYWR2YW5jZSBsZWFmLiBSZXR1cm5zIGVudHJ5IGlkLiAqL1xuXHRhcHBlbmRUaGlua2luZ0xldmVsQ2hhbmdlKHRoaW5raW5nTGV2ZWw6IHN0cmluZyk6IHN0cmluZyB7XG5cdFx0Y29uc3QgZW50cnk6IFRoaW5raW5nTGV2ZWxDaGFuZ2VFbnRyeSA9IHtcblx0XHRcdHR5cGU6IFwidGhpbmtpbmdfbGV2ZWxfY2hhbmdlXCIsXG5cdFx0XHRpZDogZ2VuZXJhdGVJZCh0aGlzLmJ5SWQpLFxuXHRcdFx0cGFyZW50SWQ6IHRoaXMubGVhZklkLFxuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0XHR0aGlua2luZ0xldmVsLFxuXHRcdH07XG5cdFx0dGhpcy5fYXBwZW5kRW50cnkoZW50cnkpO1xuXHRcdHJldHVybiBlbnRyeS5pZDtcblx0fVxuXG5cdC8qKiBBcHBlbmQgYSBtb2RlbCBjaGFuZ2UgYXMgY2hpbGQgb2YgY3VycmVudCBsZWFmLCB0aGVuIGFkdmFuY2UgbGVhZi4gUmV0dXJucyBlbnRyeSBpZC4gKi9cblx0YXBwZW5kTW9kZWxDaGFuZ2UocHJvdmlkZXI6IHN0cmluZywgbW9kZWxJZDogc3RyaW5nKTogc3RyaW5nIHtcblx0XHRjb25zdCBlbnRyeTogTW9kZWxDaGFuZ2VFbnRyeSA9IHtcblx0XHRcdHR5cGU6IFwibW9kZWxfY2hhbmdlXCIsXG5cdFx0XHRpZDogZ2VuZXJhdGVJZCh0aGlzLmJ5SWQpLFxuXHRcdFx0cGFyZW50SWQ6IHRoaXMubGVhZklkLFxuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0XHRwcm92aWRlcixcblx0XHRcdG1vZGVsSWQsXG5cdFx0fTtcblx0XHR0aGlzLl9hcHBlbmRFbnRyeShlbnRyeSk7XG5cdFx0cmV0dXJuIGVudHJ5LmlkO1xuXHR9XG5cblx0LyoqIEFwcGVuZCBhIGNvbXBhY3Rpb24gc3VtbWFyeSBhcyBjaGlsZCBvZiBjdXJyZW50IGxlYWYsIHRoZW4gYWR2YW5jZSBsZWFmLiBSZXR1cm5zIGVudHJ5IGlkLiAqL1xuXHRhcHBlbmRDb21wYWN0aW9uPFQgPSB1bmtub3duPihcblx0XHRzdW1tYXJ5OiBzdHJpbmcsXG5cdFx0Zmlyc3RLZXB0RW50cnlJZDogc3RyaW5nLFxuXHRcdHRva2Vuc0JlZm9yZTogbnVtYmVyLFxuXHRcdGRldGFpbHM/OiBULFxuXHRcdGZyb21Ib29rPzogYm9vbGVhbixcblx0KTogc3RyaW5nIHtcblx0XHRjb25zdCBlbnRyeTogQ29tcGFjdGlvbkVudHJ5PFQ+ID0ge1xuXHRcdFx0dHlwZTogXCJjb21wYWN0aW9uXCIsXG5cdFx0XHRpZDogZ2VuZXJhdGVJZCh0aGlzLmJ5SWQpLFxuXHRcdFx0cGFyZW50SWQ6IHRoaXMubGVhZklkLFxuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0XHRzdW1tYXJ5LFxuXHRcdFx0Zmlyc3RLZXB0RW50cnlJZCxcblx0XHRcdHRva2Vuc0JlZm9yZSxcblx0XHRcdGRldGFpbHMsXG5cdFx0XHRmcm9tSG9vayxcblx0XHR9O1xuXHRcdHRoaXMuX2FwcGVuZEVudHJ5KGVudHJ5KTtcblx0XHRyZXR1cm4gZW50cnkuaWQ7XG5cdH1cblxuXHQvKiogQXBwZW5kIGEgY3VzdG9tIGVudHJ5IChmb3IgZXh0ZW5zaW9ucykgYXMgY2hpbGQgb2YgY3VycmVudCBsZWFmLCB0aGVuIGFkdmFuY2UgbGVhZi4gUmV0dXJucyBlbnRyeSBpZC4gKi9cblx0YXBwZW5kQ3VzdG9tRW50cnkoY3VzdG9tVHlwZTogc3RyaW5nLCBkYXRhPzogdW5rbm93bik6IHN0cmluZyB7XG5cdFx0Y29uc3QgZW50cnk6IEN1c3RvbUVudHJ5ID0ge1xuXHRcdFx0dHlwZTogXCJjdXN0b21cIixcblx0XHRcdGN1c3RvbVR5cGUsXG5cdFx0XHRkYXRhLFxuXHRcdFx0aWQ6IGdlbmVyYXRlSWQodGhpcy5ieUlkKSxcblx0XHRcdHBhcmVudElkOiB0aGlzLmxlYWZJZCxcblx0XHRcdHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdH07XG5cdFx0dGhpcy5fYXBwZW5kRW50cnkoZW50cnkpO1xuXHRcdHJldHVybiBlbnRyeS5pZDtcblx0fVxuXG5cdC8qKiBBcHBlbmQgYSBzZXNzaW9uIGluZm8gZW50cnkgKGUuZy4sIGRpc3BsYXkgbmFtZSkuIFJldHVybnMgZW50cnkgaWQuICovXG5cdGFwcGVuZFNlc3Npb25JbmZvKG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG5cdFx0Y29uc3QgZW50cnk6IFNlc3Npb25JbmZvRW50cnkgPSB7XG5cdFx0XHR0eXBlOiBcInNlc3Npb25faW5mb1wiLFxuXHRcdFx0aWQ6IGdlbmVyYXRlSWQodGhpcy5ieUlkKSxcblx0XHRcdHBhcmVudElkOiB0aGlzLmxlYWZJZCxcblx0XHRcdHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdFx0bmFtZTogbmFtZS50cmltKCksXG5cdFx0fTtcblx0XHR0aGlzLl9hcHBlbmRFbnRyeShlbnRyeSk7XG5cdFx0cmV0dXJuIGVudHJ5LmlkO1xuXHR9XG5cblx0LyoqIEdldCB0aGUgY3VycmVudCBzZXNzaW9uIG5hbWUgZnJvbSB0aGUgbGF0ZXN0IHNlc3Npb25faW5mbyBlbnRyeSwgaWYgYW55LiAqL1xuXHRnZXRTZXNzaW9uTmFtZSgpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuXHRcdC8vIFdhbGsgZW50cmllcyBpbiByZXZlcnNlIHRvIGZpbmQgdGhlIGxhdGVzdCBzZXNzaW9uX2luZm8gd2l0aCBhIG5hbWVcblx0XHRjb25zdCBlbnRyaWVzID0gdGhpcy5nZXRFbnRyaWVzKCk7XG5cdFx0Zm9yIChsZXQgaSA9IGVudHJpZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcblx0XHRcdGNvbnN0IGVudHJ5ID0gZW50cmllc1tpXTtcblx0XHRcdGlmIChlbnRyeS50eXBlID09PSBcInNlc3Npb25faW5mb1wiICYmIGVudHJ5Lm5hbWUpIHtcblx0XHRcdFx0cmV0dXJuIGVudHJ5Lm5hbWU7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1cblxuXHQvKipcblx0ICogQXBwZW5kIGEgY3VzdG9tIG1lc3NhZ2UgZW50cnkgKGZvciBleHRlbnNpb25zKSB0aGF0IHBhcnRpY2lwYXRlcyBpbiBMTE0gY29udGV4dC5cblx0ICogQHBhcmFtIGN1c3RvbVR5cGUgRXh0ZW5zaW9uIGlkZW50aWZpZXIgZm9yIGZpbHRlcmluZyBvbiByZWxvYWRcblx0ICogQHBhcmFtIGNvbnRlbnQgTWVzc2FnZSBjb250ZW50IChzdHJpbmcgb3IgVGV4dENvbnRlbnQvSW1hZ2VDb250ZW50IGFycmF5KVxuXHQgKiBAcGFyYW0gZGlzcGxheSBXaGV0aGVyIHRvIHNob3cgaW4gVFVJICh0cnVlID0gc3R5bGVkIGRpc3BsYXksIGZhbHNlID0gaGlkZGVuKVxuXHQgKiBAcGFyYW0gZGV0YWlscyBPcHRpb25hbCBleHRlbnNpb24tc3BlY2lmaWMgbWV0YWRhdGEgKG5vdCBzZW50IHRvIExMTSlcblx0ICogQHJldHVybnMgRW50cnkgaWRcblx0ICovXG5cdGFwcGVuZEN1c3RvbU1lc3NhZ2VFbnRyeTxUID0gdW5rbm93bj4oXG5cdFx0Y3VzdG9tVHlwZTogc3RyaW5nLFxuXHRcdGNvbnRlbnQ6IHN0cmluZyB8IChUZXh0Q29udGVudCB8IEltYWdlQ29udGVudClbXSxcblx0XHRkaXNwbGF5OiBib29sZWFuLFxuXHRcdGRldGFpbHM/OiBULFxuXHQpOiBzdHJpbmcge1xuXHRcdGNvbnN0IGVudHJ5OiBDdXN0b21NZXNzYWdlRW50cnk8VD4gPSB7XG5cdFx0XHR0eXBlOiBcImN1c3RvbV9tZXNzYWdlXCIsXG5cdFx0XHRjdXN0b21UeXBlLFxuXHRcdFx0Y29udGVudCxcblx0XHRcdGRpc3BsYXksXG5cdFx0XHRkZXRhaWxzLFxuXHRcdFx0aWQ6IGdlbmVyYXRlSWQodGhpcy5ieUlkKSxcblx0XHRcdHBhcmVudElkOiB0aGlzLmxlYWZJZCxcblx0XHRcdHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdH07XG5cdFx0dGhpcy5fYXBwZW5kRW50cnkoZW50cnkpO1xuXHRcdHJldHVybiBlbnRyeS5pZDtcblx0fVxuXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0Ly8gVHJlZSBUcmF2ZXJzYWxcblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdGdldExlYWZJZCgpOiBzdHJpbmcgfCBudWxsIHtcblx0XHRyZXR1cm4gdGhpcy5sZWFmSWQ7XG5cdH1cblxuXHRnZXRMZWFmRW50cnkoKTogU2Vzc2lvbkVudHJ5IHwgdW5kZWZpbmVkIHtcblx0XHRyZXR1cm4gdGhpcy5sZWFmSWQgPyB0aGlzLmJ5SWQuZ2V0KHRoaXMubGVhZklkKSA6IHVuZGVmaW5lZDtcblx0fVxuXG5cdGdldEVudHJ5KGlkOiBzdHJpbmcpOiBTZXNzaW9uRW50cnkgfCB1bmRlZmluZWQge1xuXHRcdHJldHVybiB0aGlzLmJ5SWQuZ2V0KGlkKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgYWxsIGRpcmVjdCBjaGlsZHJlbiBvZiBhbiBlbnRyeS5cblx0ICovXG5cdGdldENoaWxkcmVuKHBhcmVudElkOiBzdHJpbmcpOiBTZXNzaW9uRW50cnlbXSB7XG5cdFx0Y29uc3QgY2hpbGRyZW46IFNlc3Npb25FbnRyeVtdID0gW107XG5cdFx0Zm9yIChjb25zdCBlbnRyeSBvZiB0aGlzLmJ5SWQudmFsdWVzKCkpIHtcblx0XHRcdGlmIChlbnRyeS5wYXJlbnRJZCA9PT0gcGFyZW50SWQpIHtcblx0XHRcdFx0Y2hpbGRyZW4ucHVzaChlbnRyeSk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHJldHVybiBjaGlsZHJlbjtcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgdGhlIGxhYmVsIGZvciBhbiBlbnRyeSwgaWYgYW55LlxuXHQgKi9cblx0Z2V0TGFiZWwoaWQ6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG5cdFx0cmV0dXJuIHRoaXMubGFiZWxzQnlJZC5nZXQoaWQpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFNldCBvciBjbGVhciBhIGxhYmVsIG9uIGFuIGVudHJ5LlxuXHQgKiBMYWJlbHMgYXJlIHVzZXItZGVmaW5lZCBtYXJrZXJzIGZvciBib29rbWFya2luZy9uYXZpZ2F0aW9uLlxuXHQgKiBQYXNzIHVuZGVmaW5lZCBvciBlbXB0eSBzdHJpbmcgdG8gY2xlYXIgdGhlIGxhYmVsLlxuXHQgKi9cblx0YXBwZW5kTGFiZWxDaGFuZ2UodGFyZ2V0SWQ6IHN0cmluZywgbGFiZWw6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XG5cdFx0aWYgKCF0aGlzLmJ5SWQuaGFzKHRhcmdldElkKSkge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGBFbnRyeSAke3RhcmdldElkfSBub3QgZm91bmRgKTtcblx0XHR9XG5cdFx0Y29uc3QgZW50cnk6IExhYmVsRW50cnkgPSB7XG5cdFx0XHR0eXBlOiBcImxhYmVsXCIsXG5cdFx0XHRpZDogZ2VuZXJhdGVJZCh0aGlzLmJ5SWQpLFxuXHRcdFx0cGFyZW50SWQ6IHRoaXMubGVhZklkLFxuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0XHR0YXJnZXRJZCxcblx0XHRcdGxhYmVsLFxuXHRcdH07XG5cdFx0dGhpcy5fYXBwZW5kRW50cnkoZW50cnkpO1xuXHRcdGlmIChsYWJlbCkge1xuXHRcdFx0dGhpcy5sYWJlbHNCeUlkLnNldCh0YXJnZXRJZCwgbGFiZWwpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLmxhYmVsc0J5SWQuZGVsZXRlKHRhcmdldElkKTtcblx0XHR9XG5cdFx0cmV0dXJuIGVudHJ5LmlkO1xuXHR9XG5cblx0LyoqXG5cdCAqIFdhbGsgZnJvbSBlbnRyeSB0byByb290LCByZXR1cm5pbmcgYWxsIGVudHJpZXMgaW4gcGF0aCBvcmRlci5cblx0ICogSW5jbHVkZXMgYWxsIGVudHJ5IHR5cGVzIChtZXNzYWdlcywgY29tcGFjdGlvbiwgbW9kZWwgY2hhbmdlcywgZXRjLikuXG5cdCAqIFVzZSBidWlsZFNlc3Npb25Db250ZXh0KCkgdG8gZ2V0IHRoZSByZXNvbHZlZCBtZXNzYWdlcyBmb3IgdGhlIExMTS5cblx0ICovXG5cdGdldEJyYW5jaChmcm9tSWQ/OiBzdHJpbmcpOiBTZXNzaW9uRW50cnlbXSB7XG5cdFx0Y29uc3QgcGF0aDogU2Vzc2lvbkVudHJ5W10gPSBbXTtcblx0XHRjb25zdCBzdGFydElkID0gZnJvbUlkID8/IHRoaXMubGVhZklkO1xuXHRcdGxldCBjdXJyZW50ID0gc3RhcnRJZCA/IHRoaXMuYnlJZC5nZXQoc3RhcnRJZCkgOiB1bmRlZmluZWQ7XG5cdFx0d2hpbGUgKGN1cnJlbnQpIHtcblx0XHRcdHBhdGgudW5zaGlmdChjdXJyZW50KTtcblx0XHRcdGN1cnJlbnQgPSBjdXJyZW50LnBhcmVudElkID8gdGhpcy5ieUlkLmdldChjdXJyZW50LnBhcmVudElkKSA6IHVuZGVmaW5lZDtcblx0XHR9XG5cdFx0cmV0dXJuIHBhdGg7XG5cdH1cblxuXHQvKipcblx0ICogQnVpbGQgdGhlIHNlc3Npb24gY29udGV4dCAod2hhdCBnZXRzIHNlbnQgdG8gdGhlIExMTSkuXG5cdCAqIFVzZXMgdHJlZSB0cmF2ZXJzYWwgZnJvbSBjdXJyZW50IGxlYWYuXG5cdCAqL1xuXHRidWlsZFNlc3Npb25Db250ZXh0KCk6IFNlc3Npb25Db250ZXh0IHtcblx0XHRyZXR1cm4gYnVpbGRTZXNzaW9uQ29udGV4dCh0aGlzLmdldEVudHJpZXMoKSwgdGhpcy5sZWFmSWQsIHRoaXMuYnlJZCk7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IHNlc3Npb24gaGVhZGVyLlxuXHQgKi9cblx0Z2V0SGVhZGVyKCk6IFNlc3Npb25IZWFkZXIgfCBudWxsIHtcblx0XHRjb25zdCBoID0gdGhpcy5maWxlRW50cmllcy5maW5kKChlKSA9PiBlLnR5cGUgPT09IFwic2Vzc2lvblwiKTtcblx0XHRyZXR1cm4gaCA/IChoIGFzIFNlc3Npb25IZWFkZXIpIDogbnVsbDtcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgYWxsIHNlc3Npb24gZW50cmllcyAoZXhjbHVkZXMgaGVhZGVyKS4gUmV0dXJucyBhIHNoYWxsb3cgY29weS5cblx0ICogVGhlIHNlc3Npb24gaXMgYXBwZW5kLW9ubHk6IHVzZSBhcHBlbmRYWFgoKSB0byBhZGQgZW50cmllcywgYnJhbmNoKCkgdG9cblx0ICogY2hhbmdlIHRoZSBsZWFmIHBvaW50ZXIuIEVudHJpZXMgY2Fubm90IGJlIG1vZGlmaWVkIG9yIGRlbGV0ZWQuXG5cdCAqL1xuXHRnZXRFbnRyaWVzKCk6IFNlc3Npb25FbnRyeVtdIHtcblx0XHRyZXR1cm4gWy4uLnRoaXMuc2Vzc2lvbkVudHJpZXNdO1xuXHR9XG5cblx0Z2V0VXNhZ2VUb3RhbHMoKTogU2Vzc2lvblVzYWdlVG90YWxzIHtcblx0XHRyZXR1cm4geyAuLi50aGlzLnVzYWdlVG90YWxzIH07XG5cdH1cblxuXHQvKipcblx0ICogR2V0IHRoZSBzZXNzaW9uIGFzIGEgdHJlZSBzdHJ1Y3R1cmUuIFJldHVybnMgYSBzaGFsbG93IGRlZmVuc2l2ZSBjb3B5IG9mIGFsbCBlbnRyaWVzLlxuXHQgKiBBIHdlbGwtZm9ybWVkIHNlc3Npb24gaGFzIGV4YWN0bHkgb25lIHJvb3QgKGZpcnN0IGVudHJ5IHdpdGggcGFyZW50SWQgPT09IG51bGwpLlxuXHQgKiBPcnBoYW5lZCBlbnRyaWVzIChicm9rZW4gcGFyZW50IGNoYWluKSBhcmUgYWxzbyByZXR1cm5lZCBhcyByb290cy5cblx0ICovXG5cdGdldFRyZWUoKTogU2Vzc2lvblRyZWVOb2RlW10ge1xuXHRcdGNvbnN0IGVudHJpZXMgPSB0aGlzLmdldEVudHJpZXMoKTtcblx0XHRjb25zdCBub2RlTWFwID0gbmV3IE1hcDxzdHJpbmcsIFNlc3Npb25UcmVlTm9kZT4oKTtcblx0XHRjb25zdCByb290czogU2Vzc2lvblRyZWVOb2RlW10gPSBbXTtcblxuXHRcdC8vIENyZWF0ZSBub2RlcyB3aXRoIHJlc29sdmVkIGxhYmVsc1xuXHRcdGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuXHRcdFx0Y29uc3QgbGFiZWwgPSB0aGlzLmxhYmVsc0J5SWQuZ2V0KGVudHJ5LmlkKTtcblx0XHRcdG5vZGVNYXAuc2V0KGVudHJ5LmlkLCB7IGVudHJ5LCBjaGlsZHJlbjogW10sIGxhYmVsIH0pO1xuXHRcdH1cblxuXHRcdC8vIEJ1aWxkIHRyZWVcblx0XHRmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcblx0XHRcdGNvbnN0IG5vZGUgPSBub2RlTWFwLmdldChlbnRyeS5pZCkhO1xuXHRcdFx0aWYgKGVudHJ5LnBhcmVudElkID09PSBudWxsIHx8IGVudHJ5LnBhcmVudElkID09PSBlbnRyeS5pZCkge1xuXHRcdFx0XHRyb290cy5wdXNoKG5vZGUpO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Y29uc3QgcGFyZW50ID0gbm9kZU1hcC5nZXQoZW50cnkucGFyZW50SWQpO1xuXHRcdFx0XHRpZiAocGFyZW50KSB7XG5cdFx0XHRcdFx0cGFyZW50LmNoaWxkcmVuLnB1c2gobm9kZSk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0Ly8gT3JwaGFuIC0gdHJlYXQgYXMgcm9vdFxuXHRcdFx0XHRcdHJvb3RzLnB1c2gobm9kZSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBTb3J0IGNoaWxkcmVuIGJ5IHRpbWVzdGFtcCAob2xkZXN0IGZpcnN0LCBuZXdlc3QgYXQgYm90dG9tKVxuXHRcdC8vIFVzZSBpdGVyYXRpdmUgYXBwcm9hY2ggdG8gYXZvaWQgc3RhY2sgb3ZlcmZsb3cgb24gZGVlcCB0cmVlc1xuXHRcdGNvbnN0IHN0YWNrOiBTZXNzaW9uVHJlZU5vZGVbXSA9IFsuLi5yb290c107XG5cdFx0d2hpbGUgKHN0YWNrLmxlbmd0aCA+IDApIHtcblx0XHRcdGNvbnN0IG5vZGUgPSBzdGFjay5wb3AoKSE7XG5cdFx0XHRub2RlLmNoaWxkcmVuLnNvcnQoKGEsIGIpID0+IG5ldyBEYXRlKGEuZW50cnkudGltZXN0YW1wKS5nZXRUaW1lKCkgLSBuZXcgRGF0ZShiLmVudHJ5LnRpbWVzdGFtcCkuZ2V0VGltZSgpKTtcblx0XHRcdHN0YWNrLnB1c2goLi4ubm9kZS5jaGlsZHJlbik7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHJvb3RzO1xuXHR9XG5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHQvLyBCcmFuY2hpbmdcblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdC8qKlxuXHQgKiBTdGFydCBhIG5ldyBicmFuY2ggZnJvbSBhbiBlYXJsaWVyIGVudHJ5LlxuXHQgKiBNb3ZlcyB0aGUgbGVhZiBwb2ludGVyIHRvIHRoZSBzcGVjaWZpZWQgZW50cnkuIFRoZSBuZXh0IGFwcGVuZFhYWCgpIGNhbGxcblx0ICogd2lsbCBjcmVhdGUgYSBjaGlsZCBvZiB0aGF0IGVudHJ5LCBmb3JtaW5nIGEgbmV3IGJyYW5jaC4gRXhpc3RpbmcgZW50cmllc1xuXHQgKiBhcmUgbm90IG1vZGlmaWVkIG9yIGRlbGV0ZWQuXG5cdCAqL1xuXHRicmFuY2goYnJhbmNoRnJvbUlkOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRpZiAoIXRoaXMuYnlJZC5oYXMoYnJhbmNoRnJvbUlkKSkge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGBFbnRyeSAke2JyYW5jaEZyb21JZH0gbm90IGZvdW5kYCk7XG5cdFx0fVxuXHRcdHRoaXMubGVhZklkID0gYnJhbmNoRnJvbUlkO1xuXHR9XG5cblx0LyoqXG5cdCAqIFJlc2V0IHRoZSBsZWFmIHBvaW50ZXIgdG8gbnVsbCAoYmVmb3JlIGFueSBlbnRyaWVzKS5cblx0ICogVGhlIG5leHQgYXBwZW5kWFhYKCkgY2FsbCB3aWxsIGNyZWF0ZSBhIG5ldyByb290IGVudHJ5IChwYXJlbnRJZCA9IG51bGwpLlxuXHQgKiBVc2UgdGhpcyB3aGVuIG5hdmlnYXRpbmcgdG8gcmUtZWRpdCB0aGUgZmlyc3QgdXNlciBtZXNzYWdlLlxuXHQgKi9cblx0cmVzZXRMZWFmKCk6IHZvaWQge1xuXHRcdHRoaXMubGVhZklkID0gbnVsbDtcblx0fVxuXG5cdC8qKlxuXHQgKiBTdGFydCBhIG5ldyBicmFuY2ggd2l0aCBhIHN1bW1hcnkgb2YgdGhlIGFiYW5kb25lZCBwYXRoLlxuXHQgKiBTYW1lIGFzIGJyYW5jaCgpLCBidXQgYWxzbyBhcHBlbmRzIGEgYnJhbmNoX3N1bW1hcnkgZW50cnkgdGhhdCBjYXB0dXJlc1xuXHQgKiBjb250ZXh0IGZyb20gdGhlIGFiYW5kb25lZCBjb252ZXJzYXRpb24gcGF0aC5cblx0ICovXG5cdGJyYW5jaFdpdGhTdW1tYXJ5KGJyYW5jaEZyb21JZDogc3RyaW5nIHwgbnVsbCwgc3VtbWFyeTogc3RyaW5nLCBkZXRhaWxzPzogdW5rbm93biwgZnJvbUhvb2s/OiBib29sZWFuKTogc3RyaW5nIHtcblx0XHRpZiAoYnJhbmNoRnJvbUlkICE9PSBudWxsICYmICF0aGlzLmJ5SWQuaGFzKGJyYW5jaEZyb21JZCkpIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihgRW50cnkgJHticmFuY2hGcm9tSWR9IG5vdCBmb3VuZGApO1xuXHRcdH1cblx0XHR0aGlzLmxlYWZJZCA9IGJyYW5jaEZyb21JZDtcblx0XHRjb25zdCBlbnRyeTogQnJhbmNoU3VtbWFyeUVudHJ5ID0ge1xuXHRcdFx0dHlwZTogXCJicmFuY2hfc3VtbWFyeVwiLFxuXHRcdFx0aWQ6IGdlbmVyYXRlSWQodGhpcy5ieUlkKSxcblx0XHRcdHBhcmVudElkOiBicmFuY2hGcm9tSWQsXG5cdFx0XHR0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRcdGZyb21JZDogYnJhbmNoRnJvbUlkID8/IFwicm9vdFwiLFxuXHRcdFx0c3VtbWFyeSxcblx0XHRcdGRldGFpbHMsXG5cdFx0XHRmcm9tSG9vayxcblx0XHR9O1xuXHRcdHRoaXMuX2FwcGVuZEVudHJ5KGVudHJ5KTtcblx0XHRyZXR1cm4gZW50cnkuaWQ7XG5cdH1cblxuXHQvKipcblx0ICogQ3JlYXRlIGEgbmV3IHNlc3Npb24gZmlsZSBjb250YWluaW5nIG9ubHkgdGhlIHBhdGggZnJvbSByb290IHRvIHRoZSBzcGVjaWZpZWQgbGVhZi5cblx0ICogVXNlZnVsIGZvciBleHRyYWN0aW5nIGEgc2luZ2xlIGNvbnZlcnNhdGlvbiBwYXRoIGZyb20gYSBicmFuY2hlZCBzZXNzaW9uLlxuXHQgKiBSZXR1cm5zIHRoZSBuZXcgc2Vzc2lvbiBmaWxlIHBhdGgsIG9yIHVuZGVmaW5lZCBpZiBub3QgcGVyc2lzdGluZy5cblx0ICovXG5cdGNyZWF0ZUJyYW5jaGVkU2Vzc2lvbihsZWFmSWQ6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG5cdFx0Y29uc3QgcHJldmlvdXNTZXNzaW9uRmlsZSA9IHRoaXMuc2Vzc2lvbkZpbGU7XG5cdFx0Y29uc3QgcGF0aCA9IHRoaXMuZ2V0QnJhbmNoKGxlYWZJZCk7XG5cdFx0aWYgKHBhdGgubGVuZ3RoID09PSAwKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEVudHJ5ICR7bGVhZklkfSBub3QgZm91bmRgKTtcblx0XHR9XG5cblx0XHQvLyBGaWx0ZXIgb3V0IExhYmVsRW50cnkgZnJvbSBwYXRoIC0gd2UnbGwgcmVjcmVhdGUgdGhlbSBmcm9tIHRoZSByZXNvbHZlZCBtYXBcblx0XHRjb25zdCBwYXRoV2l0aG91dExhYmVscyA9IHBhdGguZmlsdGVyKChlKSA9PiBlLnR5cGUgIT09IFwibGFiZWxcIik7XG5cblx0XHRjb25zdCBuZXdTZXNzaW9uSWQgPSByYW5kb21VVUlEKCk7XG5cdFx0Y29uc3QgdGltZXN0YW1wID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXHRcdGNvbnN0IGZpbGVUaW1lc3RhbXAgPSB0aW1lc3RhbXAucmVwbGFjZSgvWzouXS9nLCBcIi1cIik7XG5cdFx0Y29uc3QgbmV3U2Vzc2lvbkZpbGUgPSBqb2luKHRoaXMuZ2V0U2Vzc2lvbkRpcigpLCBgJHtmaWxlVGltZXN0YW1wfV8ke25ld1Nlc3Npb25JZH0uanNvbmxgKTtcblxuXHRcdGNvbnN0IGhlYWRlcjogU2Vzc2lvbkhlYWRlciA9IHtcblx0XHRcdHR5cGU6IFwic2Vzc2lvblwiLFxuXHRcdFx0dmVyc2lvbjogQ1VSUkVOVF9TRVNTSU9OX1ZFUlNJT04sXG5cdFx0XHRpZDogbmV3U2Vzc2lvbklkLFxuXHRcdFx0dGltZXN0YW1wLFxuXHRcdFx0Y3dkOiB0aGlzLmN3ZCxcblx0XHRcdHBhcmVudFNlc3Npb246IHRoaXMucGVyc2lzdCA/IHByZXZpb3VzU2Vzc2lvbkZpbGUgOiB1bmRlZmluZWQsXG5cdFx0fTtcblxuXHRcdC8vIENvbGxlY3QgbGFiZWxzIGZvciBlbnRyaWVzIGluIHRoZSBwYXRoXG5cdFx0Y29uc3QgcGF0aEVudHJ5SWRzID0gbmV3IFNldChwYXRoV2l0aG91dExhYmVscy5tYXAoKGUpID0+IGUuaWQpKTtcblx0XHRjb25zdCBsYWJlbHNUb1dyaXRlOiBBcnJheTx7IHRhcmdldElkOiBzdHJpbmc7IGxhYmVsOiBzdHJpbmcgfT4gPSBbXTtcblx0XHRmb3IgKGNvbnN0IFt0YXJnZXRJZCwgbGFiZWxdIG9mIHRoaXMubGFiZWxzQnlJZCkge1xuXHRcdFx0aWYgKHBhdGhFbnRyeUlkcy5oYXModGFyZ2V0SWQpKSB7XG5cdFx0XHRcdGxhYmVsc1RvV3JpdGUucHVzaCh7IHRhcmdldElkLCBsYWJlbCB9KTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRpZiAodGhpcy5wZXJzaXN0KSB7XG5cdFx0XHQvLyBCdWlsZCBsYWJlbCBlbnRyaWVzXG5cdFx0XHRjb25zdCBsYXN0RW50cnlJZCA9IHBhdGhXaXRob3V0TGFiZWxzW3BhdGhXaXRob3V0TGFiZWxzLmxlbmd0aCAtIDFdPy5pZCB8fCBudWxsO1xuXHRcdFx0bGV0IHBhcmVudElkID0gbGFzdEVudHJ5SWQ7XG5cdFx0XHRjb25zdCBsYWJlbEVudHJpZXM6IExhYmVsRW50cnlbXSA9IFtdO1xuXHRcdFx0Zm9yIChjb25zdCB7IHRhcmdldElkLCBsYWJlbCB9IG9mIGxhYmVsc1RvV3JpdGUpIHtcblx0XHRcdFx0Y29uc3QgbGFiZWxFbnRyeTogTGFiZWxFbnRyeSA9IHtcblx0XHRcdFx0XHR0eXBlOiBcImxhYmVsXCIsXG5cdFx0XHRcdFx0aWQ6IGdlbmVyYXRlSWQobmV3IFNldChwYXRoRW50cnlJZHMpKSxcblx0XHRcdFx0XHRwYXJlbnRJZCxcblx0XHRcdFx0XHR0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRcdFx0XHR0YXJnZXRJZCxcblx0XHRcdFx0XHRsYWJlbCxcblx0XHRcdFx0fTtcblx0XHRcdFx0cGF0aEVudHJ5SWRzLmFkZChsYWJlbEVudHJ5LmlkKTtcblx0XHRcdFx0bGFiZWxFbnRyaWVzLnB1c2gobGFiZWxFbnRyeSk7XG5cdFx0XHRcdHBhcmVudElkID0gbGFiZWxFbnRyeS5pZDtcblx0XHRcdH1cblxuXHRcdFx0dGhpcy5maWxlRW50cmllcyA9IFtoZWFkZXIsIC4uLnBhdGhXaXRob3V0TGFiZWxzLCAuLi5sYWJlbEVudHJpZXNdO1xuXHRcdFx0dGhpcy5zZXNzaW9uSWQgPSBuZXdTZXNzaW9uSWQ7XG5cdFx0XHR0aGlzLnNlc3Npb25GaWxlID0gbmV3U2Vzc2lvbkZpbGU7XG5cdFx0XHR0aGlzLl9idWlsZEluZGV4KCk7XG5cblx0XHRcdC8vIE9ubHkgd3JpdGUgdGhlIGZpbGUgbm93IGlmIGl0IGNvbnRhaW5zIGFuIGFzc2lzdGFudCBtZXNzYWdlLlxuXHRcdFx0Ly8gT3RoZXJ3aXNlIGRlZmVyIHRvIF9wZXJzaXN0KCksIHdoaWNoIGNyZWF0ZXMgdGhlIGZpbGUgb24gdGhlXG5cdFx0XHQvLyBmaXJzdCBhc3Npc3RhbnQgcmVzcG9uc2UsIG1hdGNoaW5nIHRoZSBuZXdTZXNzaW9uKCkgY29udHJhY3Rcblx0XHRcdC8vIGFuZCBhdm9pZGluZyB0aGUgZHVwbGljYXRlLWhlYWRlciBidWcgd2hlbiBfcGVyc2lzdCgpJ3Ncblx0XHRcdC8vIG5vLWFzc2lzdGFudCBndWFyZCBsYXRlciByZXNldHMgZmx1c2hlZCB0byBmYWxzZS5cblx0XHRcdGNvbnN0IGhhc0Fzc2lzdGFudCA9IHRoaXMuZmlsZUVudHJpZXMuc29tZSgoZSkgPT4gZS50eXBlID09PSBcIm1lc3NhZ2VcIiAmJiBlLm1lc3NhZ2Uucm9sZSA9PT0gXCJhc3Npc3RhbnRcIik7XG5cdFx0XHRpZiAoaGFzQXNzaXN0YW50KSB7XG5cdFx0XHRcdHRoaXMuX3Jld3JpdGVGaWxlKCk7XG5cdFx0XHRcdHRoaXMuZmx1c2hlZCA9IHRydWU7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHR0aGlzLmZsdXNoZWQgPSBmYWxzZTtcblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIG5ld1Nlc3Npb25GaWxlO1xuXHRcdH1cblxuXHRcdC8vIEluLW1lbW9yeSBtb2RlOiByZXBsYWNlIGN1cnJlbnQgc2Vzc2lvbiB3aXRoIHRoZSBwYXRoICsgbGFiZWxzXG5cdFx0Y29uc3QgbGFiZWxFbnRyaWVzOiBMYWJlbEVudHJ5W10gPSBbXTtcblx0XHRsZXQgcGFyZW50SWQgPSBwYXRoV2l0aG91dExhYmVsc1twYXRoV2l0aG91dExhYmVscy5sZW5ndGggLSAxXT8uaWQgfHwgbnVsbDtcblx0XHRmb3IgKGNvbnN0IHsgdGFyZ2V0SWQsIGxhYmVsIH0gb2YgbGFiZWxzVG9Xcml0ZSkge1xuXHRcdFx0Y29uc3QgbGFiZWxFbnRyeTogTGFiZWxFbnRyeSA9IHtcblx0XHRcdFx0dHlwZTogXCJsYWJlbFwiLFxuXHRcdFx0XHRpZDogZ2VuZXJhdGVJZChuZXcgU2V0KFsuLi5wYXRoRW50cnlJZHMsIC4uLmxhYmVsRW50cmllcy5tYXAoKGUpID0+IGUuaWQpXSkpLFxuXHRcdFx0XHRwYXJlbnRJZCxcblx0XHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0XHRcdHRhcmdldElkLFxuXHRcdFx0XHRsYWJlbCxcblx0XHRcdH07XG5cdFx0XHRsYWJlbEVudHJpZXMucHVzaChsYWJlbEVudHJ5KTtcblx0XHRcdHBhcmVudElkID0gbGFiZWxFbnRyeS5pZDtcblx0XHR9XG5cdFx0dGhpcy5maWxlRW50cmllcyA9IFtoZWFkZXIsIC4uLnBhdGhXaXRob3V0TGFiZWxzLCAuLi5sYWJlbEVudHJpZXNdO1xuXHRcdHRoaXMuc2Vzc2lvbklkID0gbmV3U2Vzc2lvbklkO1xuXHRcdHRoaXMuX2J1aWxkSW5kZXgoKTtcblx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHR9XG5cblx0LyoqXG5cdCAqIENyZWF0ZSBhIG5ldyBzZXNzaW9uLlxuXHQgKiBAcGFyYW0gY3dkIFdvcmtpbmcgZGlyZWN0b3J5IChzdG9yZWQgaW4gc2Vzc2lvbiBoZWFkZXIpXG5cdCAqIEBwYXJhbSBzZXNzaW9uRGlyIE9wdGlvbmFsIHNlc3Npb24gZGlyZWN0b3J5LiBJZiBvbWl0dGVkLCB1c2VzIGRlZmF1bHQgKH4vLnBpL2FnZW50L3Nlc3Npb25zLzxlbmNvZGVkLWN3ZD4vKS5cblx0ICovXG5cdHN0YXRpYyBjcmVhdGUoY3dkOiBzdHJpbmcsIHNlc3Npb25EaXI/OiBzdHJpbmcpOiBTZXNzaW9uTWFuYWdlciB7XG5cdFx0Y29uc3QgZGlyID0gc2Vzc2lvbkRpciA/PyBnZXREZWZhdWx0U2Vzc2lvbkRpcihjd2QpO1xuXHRcdHJldHVybiBuZXcgU2Vzc2lvbk1hbmFnZXIoY3dkLCBkaXIsIHVuZGVmaW5lZCwgdHJ1ZSk7XG5cdH1cblxuXHQvKipcblx0ICogT3BlbiBhIHNwZWNpZmljIHNlc3Npb24gZmlsZS5cblx0ICogQHBhcmFtIHBhdGggUGF0aCB0byBzZXNzaW9uIGZpbGVcblx0ICogQHBhcmFtIHNlc3Npb25EaXIgT3B0aW9uYWwgc2Vzc2lvbiBkaXJlY3RvcnkgZm9yIC9uZXcgb3IgL2JyYW5jaC4gSWYgb21pdHRlZCwgZGVyaXZlcyBmcm9tIGZpbGUncyBwYXJlbnQuXG5cdCAqL1xuXHRzdGF0aWMgb3BlbihwYXRoOiBzdHJpbmcsIHNlc3Npb25EaXI/OiBzdHJpbmcpOiBTZXNzaW9uTWFuYWdlciB7XG5cdFx0Ly8gRXh0cmFjdCBjd2QgZnJvbSBzZXNzaW9uIGhlYWRlciBpZiBwb3NzaWJsZSwgb3RoZXJ3aXNlIHVzZSBwcm9jZXNzLmN3ZCgpXG5cdFx0Y29uc3QgZW50cmllcyA9IGxvYWRFbnRyaWVzRnJvbUZpbGUocGF0aCk7XG5cdFx0Y29uc3QgaGVhZGVyID0gZW50cmllcy5maW5kKChlKSA9PiBlLnR5cGUgPT09IFwic2Vzc2lvblwiKSBhcyBTZXNzaW9uSGVhZGVyIHwgdW5kZWZpbmVkO1xuXHRcdGNvbnN0IGN3ZCA9IGhlYWRlcj8uY3dkID8/IHByb2Nlc3MuY3dkKCk7XG5cdFx0Ly8gSWYgbm8gc2Vzc2lvbkRpciBwcm92aWRlZCwgZGVyaXZlIGZyb20gZmlsZSdzIHBhcmVudCBkaXJlY3Rvcnlcblx0XHRjb25zdCBkaXIgPSBzZXNzaW9uRGlyID8/IHJlc29sdmUocGF0aCwgXCIuLlwiKTtcblx0XHRyZXR1cm4gbmV3IFNlc3Npb25NYW5hZ2VyKGN3ZCwgZGlyLCBwYXRoLCB0cnVlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDb250aW51ZSB0aGUgbW9zdCByZWNlbnQgc2Vzc2lvbiwgb3IgY3JlYXRlIG5ldyBpZiBub25lLlxuXHQgKiBAcGFyYW0gY3dkIFdvcmtpbmcgZGlyZWN0b3J5XG5cdCAqIEBwYXJhbSBzZXNzaW9uRGlyIE9wdGlvbmFsIHNlc3Npb24gZGlyZWN0b3J5LiBJZiBvbWl0dGVkLCB1c2VzIGRlZmF1bHQgKH4vLnBpL2FnZW50L3Nlc3Npb25zLzxlbmNvZGVkLWN3ZD4vKS5cblx0ICovXG5cdHN0YXRpYyBjb250aW51ZVJlY2VudChjd2Q6IHN0cmluZywgc2Vzc2lvbkRpcj86IHN0cmluZyk6IFNlc3Npb25NYW5hZ2VyIHtcblx0XHRjb25zdCBkaXIgPSBzZXNzaW9uRGlyID8/IGdldERlZmF1bHRTZXNzaW9uRGlyKGN3ZCk7XG5cdFx0Y29uc3QgbW9zdFJlY2VudCA9IGZpbmRNb3N0UmVjZW50U2Vzc2lvbihkaXIpO1xuXHRcdGlmIChtb3N0UmVjZW50KSB7XG5cdFx0XHRyZXR1cm4gbmV3IFNlc3Npb25NYW5hZ2VyKGN3ZCwgZGlyLCBtb3N0UmVjZW50LCB0cnVlKTtcblx0XHR9XG5cdFx0cmV0dXJuIG5ldyBTZXNzaW9uTWFuYWdlcihjd2QsIGRpciwgdW5kZWZpbmVkLCB0cnVlKTtcblx0fVxuXG5cdC8qKiBDcmVhdGUgYW4gaW4tbWVtb3J5IHNlc3Npb24gKG5vIGZpbGUgcGVyc2lzdGVuY2UpICovXG5cdHN0YXRpYyBpbk1lbW9yeShjd2Q6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCkpOiBTZXNzaW9uTWFuYWdlciB7XG5cdFx0cmV0dXJuIG5ldyBTZXNzaW9uTWFuYWdlcihjd2QsIFwiXCIsIHVuZGVmaW5lZCwgZmFsc2UpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEZvcmsgYSBzZXNzaW9uIGZyb20gYW5vdGhlciBwcm9qZWN0IGRpcmVjdG9yeSBpbnRvIHRoZSBjdXJyZW50IHByb2plY3QuXG5cdCAqIENyZWF0ZXMgYSBuZXcgc2Vzc2lvbiBpbiB0aGUgdGFyZ2V0IGN3ZCB3aXRoIHRoZSBmdWxsIGhpc3RvcnkgZnJvbSB0aGUgc291cmNlIHNlc3Npb24uXG5cdCAqIEBwYXJhbSBzb3VyY2VQYXRoIFBhdGggdG8gdGhlIHNvdXJjZSBzZXNzaW9uIGZpbGVcblx0ICogQHBhcmFtIHRhcmdldEN3ZCBUYXJnZXQgd29ya2luZyBkaXJlY3RvcnkgKHdoZXJlIHRoZSBuZXcgc2Vzc2lvbiB3aWxsIGJlIHN0b3JlZClcblx0ICogQHBhcmFtIHNlc3Npb25EaXIgT3B0aW9uYWwgc2Vzc2lvbiBkaXJlY3RvcnkuIElmIG9taXR0ZWQsIHVzZXMgZGVmYXVsdCBmb3IgdGFyZ2V0Q3dkLlxuXHQgKi9cblx0c3RhdGljIGZvcmtGcm9tKHNvdXJjZVBhdGg6IHN0cmluZywgdGFyZ2V0Q3dkOiBzdHJpbmcsIHNlc3Npb25EaXI/OiBzdHJpbmcpOiBTZXNzaW9uTWFuYWdlciB7XG5cdFx0Y29uc3Qgc291cmNlRW50cmllcyA9IGxvYWRFbnRyaWVzRnJvbUZpbGUoc291cmNlUGF0aCk7XG5cdFx0aWYgKHNvdXJjZUVudHJpZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoYENhbm5vdCBmb3JrOiBzb3VyY2Ugc2Vzc2lvbiBmaWxlIGlzIGVtcHR5IG9yIGludmFsaWQ6ICR7c291cmNlUGF0aH1gKTtcblx0XHR9XG5cblx0XHRjb25zdCBzb3VyY2VIZWFkZXIgPSBzb3VyY2VFbnRyaWVzLmZpbmQoKGUpID0+IGUudHlwZSA9PT0gXCJzZXNzaW9uXCIpIGFzIFNlc3Npb25IZWFkZXIgfCB1bmRlZmluZWQ7XG5cdFx0aWYgKCFzb3VyY2VIZWFkZXIpIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihgQ2Fubm90IGZvcms6IHNvdXJjZSBzZXNzaW9uIGhhcyBubyBoZWFkZXI6ICR7c291cmNlUGF0aH1gKTtcblx0XHR9XG5cblx0XHRjb25zdCBkaXIgPSBzZXNzaW9uRGlyID8/IGdldERlZmF1bHRTZXNzaW9uRGlyKHRhcmdldEN3ZCk7XG5cdFx0aWYgKCFleGlzdHNTeW5jKGRpcikpIHtcblx0XHRcdG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdH1cblxuXHRcdC8vIENyZWF0ZSBuZXcgc2Vzc2lvbiBmaWxlIHdpdGggbmV3IElEIGJ1dCBmb3JrZWQgY29udGVudFxuXHRcdGNvbnN0IG5ld1Nlc3Npb25JZCA9IHJhbmRvbVVVSUQoKTtcblx0XHRjb25zdCB0aW1lc3RhbXAgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG5cdFx0Y29uc3QgZmlsZVRpbWVzdGFtcCA9IHRpbWVzdGFtcC5yZXBsYWNlKC9bOi5dL2csIFwiLVwiKTtcblx0XHRjb25zdCBuZXdTZXNzaW9uRmlsZSA9IGpvaW4oZGlyLCBgJHtmaWxlVGltZXN0YW1wfV8ke25ld1Nlc3Npb25JZH0uanNvbmxgKTtcblxuXHRcdC8vIFdyaXRlIG5ldyBoZWFkZXIgcG9pbnRpbmcgdG8gc291cmNlIGFzIHBhcmVudCwgd2l0aCB1cGRhdGVkIGN3ZFxuXHRcdGNvbnN0IG5ld0hlYWRlcjogU2Vzc2lvbkhlYWRlciA9IHtcblx0XHRcdHR5cGU6IFwic2Vzc2lvblwiLFxuXHRcdFx0dmVyc2lvbjogQ1VSUkVOVF9TRVNTSU9OX1ZFUlNJT04sXG5cdFx0XHRpZDogbmV3U2Vzc2lvbklkLFxuXHRcdFx0dGltZXN0YW1wLFxuXHRcdFx0Y3dkOiB0YXJnZXRDd2QsXG5cdFx0XHRwYXJlbnRTZXNzaW9uOiBzb3VyY2VQYXRoLFxuXHRcdH07XG5cdFx0Ly8gQnVpbGQgY29tcGxldGUgZm9yayBjb250ZW50IGFuZCB3cml0ZSBhdG9taWNhbGx5IHRvIHByZXZlbnQgcGFydGlhbCBmaWxlcyBvbiBjcmFzaFxuXHRcdGNvbnN0IGxpbmVzID0gW0pTT04uc3RyaW5naWZ5KG5ld0hlYWRlcildO1xuXHRcdGZvciAoY29uc3QgZW50cnkgb2Ygc291cmNlRW50cmllcykge1xuXHRcdFx0aWYgKGVudHJ5LnR5cGUgIT09IFwic2Vzc2lvblwiKSB7XG5cdFx0XHRcdGxpbmVzLnB1c2goSlNPTi5zdHJpbmdpZnkoZW50cnkpKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0YXRvbWljV3JpdGVGaWxlU3luYyhuZXdTZXNzaW9uRmlsZSwgbGluZXMuam9pbihcIlxcblwiKSArIFwiXFxuXCIpO1xuXG5cdFx0cmV0dXJuIG5ldyBTZXNzaW9uTWFuYWdlcih0YXJnZXRDd2QsIGRpciwgbmV3U2Vzc2lvbkZpbGUsIHRydWUpO1xuXHR9XG5cblx0LyoqXG5cdCAqIExpc3QgYWxsIHNlc3Npb25zIGZvciBhIGRpcmVjdG9yeS5cblx0ICogQHBhcmFtIGN3ZCBXb3JraW5nIGRpcmVjdG9yeSAodXNlZCB0byBjb21wdXRlIGRlZmF1bHQgc2Vzc2lvbiBkaXJlY3RvcnkpXG5cdCAqIEBwYXJhbSBzZXNzaW9uRGlyIE9wdGlvbmFsIHNlc3Npb24gZGlyZWN0b3J5LiBJZiBvbWl0dGVkLCB1c2VzIGRlZmF1bHQgKH4vLnBpL2FnZW50L3Nlc3Npb25zLzxlbmNvZGVkLWN3ZD4vKS5cblx0ICogQHBhcmFtIG9uUHJvZ3Jlc3MgT3B0aW9uYWwgY2FsbGJhY2sgZm9yIHByb2dyZXNzIHVwZGF0ZXMgKGxvYWRlZCwgdG90YWwpXG5cdCAqL1xuXHRzdGF0aWMgYXN5bmMgbGlzdChjd2Q6IHN0cmluZywgc2Vzc2lvbkRpcj86IHN0cmluZywgb25Qcm9ncmVzcz86IFNlc3Npb25MaXN0UHJvZ3Jlc3MpOiBQcm9taXNlPFNlc3Npb25JbmZvW10+IHtcblx0XHRjb25zdCBkaXIgPSBzZXNzaW9uRGlyID8/IGdldERlZmF1bHRTZXNzaW9uRGlyKGN3ZCk7XG5cdFx0Y29uc3Qgc2Vzc2lvbnMgPSBhd2FpdCBsaXN0U2Vzc2lvbnNGcm9tRGlyKGRpciwgb25Qcm9ncmVzcyk7XG5cdFx0c2Vzc2lvbnMuc29ydCgoYSwgYikgPT4gYi5tb2RpZmllZC5nZXRUaW1lKCkgLSBhLm1vZGlmaWVkLmdldFRpbWUoKSk7XG5cdFx0cmV0dXJuIHNlc3Npb25zO1xuXHR9XG5cblx0LyoqXG5cdCAqIExpc3QgYWxsIHNlc3Npb25zIGFjcm9zcyBhbGwgcHJvamVjdCBkaXJlY3Rvcmllcy5cblx0ICogQHBhcmFtIG9uUHJvZ3Jlc3MgT3B0aW9uYWwgY2FsbGJhY2sgZm9yIHByb2dyZXNzIHVwZGF0ZXMgKGxvYWRlZCwgdG90YWwpXG5cdCAqL1xuXHRzdGF0aWMgYXN5bmMgbGlzdEFsbChvblByb2dyZXNzPzogU2Vzc2lvbkxpc3RQcm9ncmVzcyk6IFByb21pc2U8U2Vzc2lvbkluZm9bXT4ge1xuXHRcdGNvbnN0IHNlc3Npb25zRGlyID0gZ2V0U2Vzc2lvbnNEaXIoKTtcblxuXHRcdHRyeSB7XG5cdFx0XHRpZiAoIWV4aXN0c1N5bmMoc2Vzc2lvbnNEaXIpKSB7XG5cdFx0XHRcdHJldHVybiBbXTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGVudHJpZXMgPSBhd2FpdCByZWFkZGlyKHNlc3Npb25zRGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSk7XG5cdFx0XHRjb25zdCBkaXJzID0gZW50cmllcy5maWx0ZXIoKGUpID0+IGUuaXNEaXJlY3RvcnkoKSkubWFwKChlKSA9PiBqb2luKHNlc3Npb25zRGlyLCBlLm5hbWUpKTtcblxuXHRcdFx0Ly8gQ291bnQgdG90YWwgZmlsZXMgZmlyc3QgZm9yIGFjY3VyYXRlIHByb2dyZXNzXG5cdFx0XHRsZXQgdG90YWxGaWxlcyA9IDA7XG5cdFx0XHRjb25zdCBkaXJGaWxlczogc3RyaW5nW11bXSA9IFtdO1xuXHRcdFx0Zm9yIChjb25zdCBkaXIgb2YgZGlycykge1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGNvbnN0IGZpbGVzID0gKGF3YWl0IHJlYWRkaXIoZGlyKSkuZmlsdGVyKChmKSA9PiBmLmVuZHNXaXRoKFwiLmpzb25sXCIpKTtcblx0XHRcdFx0XHRkaXJGaWxlcy5wdXNoKGZpbGVzLm1hcCgoZikgPT4gam9pbihkaXIsIGYpKSk7XG5cdFx0XHRcdFx0dG90YWxGaWxlcyArPSBmaWxlcy5sZW5ndGg7XG5cdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdGRpckZpbGVzLnB1c2goW10pO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIFByb2Nlc3MgYWxsIGZpbGVzIHdpdGggcHJvZ3Jlc3MgdHJhY2tpbmdcblx0XHRcdGxldCBsb2FkZWQgPSAwO1xuXHRcdFx0Y29uc3Qgc2Vzc2lvbnM6IFNlc3Npb25JbmZvW10gPSBbXTtcblx0XHRcdGNvbnN0IGFsbEZpbGVzID0gZGlyRmlsZXMuZmxhdCgpO1xuXG5cdFx0XHQvLyBMaW1pdCBjb25jdXJyZW5jeSB0byBhdm9pZCBtZW1vcnkgc3Bpa2VzIHdpdGggbWFueSBzZXNzaW9uIGZpbGVzXG5cdFx0XHRjb25zdCBsaW1pdCA9IHBMaW1pdCgxMCk7XG5cdFx0XHRjb25zdCByZXN1bHRzID0gYXdhaXQgUHJvbWlzZS5hbGwoXG5cdFx0XHRcdGFsbEZpbGVzLm1hcCgoZmlsZSkgPT5cblx0XHRcdFx0XHRsaW1pdChhc3luYyAoKSA9PiB7XG5cdFx0XHRcdFx0XHRjb25zdCBpbmZvID0gYXdhaXQgYnVpbGRTZXNzaW9uSW5mbyhmaWxlKTtcblx0XHRcdFx0XHRcdGxvYWRlZCsrO1xuXHRcdFx0XHRcdFx0b25Qcm9ncmVzcz8uKGxvYWRlZCwgdG90YWxGaWxlcyk7XG5cdFx0XHRcdFx0XHRyZXR1cm4gaW5mbztcblx0XHRcdFx0XHR9KSxcblx0XHRcdFx0KSxcblx0XHRcdCk7XG5cblx0XHRcdGZvciAoY29uc3QgaW5mbyBvZiByZXN1bHRzKSB7XG5cdFx0XHRcdGlmIChpbmZvKSB7XG5cdFx0XHRcdFx0c2Vzc2lvbnMucHVzaChpbmZvKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRzZXNzaW9ucy5zb3J0KChhLCBiKSA9PiBiLm1vZGlmaWVkLmdldFRpbWUoKSAtIGEubW9kaWZpZWQuZ2V0VGltZSgpKTtcblx0XHRcdHJldHVybiBzZXNzaW9ucztcblx0XHR9IGNhdGNoIHtcblx0XHRcdHJldHVybiBbXTtcblx0XHR9XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLFNBQVMsa0JBQWtCO0FBQzNCO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FFTTtBQUNQLFNBQVMsMkJBQTJCO0FBQ3BDLFNBQVMsU0FBUyxVQUFVLFlBQVk7QUFDeEMsU0FBUyxNQUFNLGVBQWU7QUFDOUIsU0FBUyxlQUFlLG9CQUFvQixhQUFhLHNCQUFzQjtBQUMvRSxTQUFTLDBCQUEwQjtBQUNuQztBQUFBLEVBR0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFDUCxTQUFTLFdBQVcsc0JBQXNCLFdBQVcsd0JBQXdCO0FBQzdFLFNBQVMscUJBQXFCO0FBRzlCLFNBQVMsT0FBTyxhQUFxQjtBQUNwQyxRQUFNLFFBQXdCLENBQUM7QUFDL0IsTUFBSSxTQUFTO0FBQ2IsU0FBTyxDQUFJLE9BQXFDO0FBQy9DLFdBQU8sSUFBSSxRQUFXLENBQUNBLFVBQVMsV0FBVztBQUMxQyxZQUFNLE1BQU0sTUFBTTtBQUNqQjtBQUNBLFdBQUcsRUFBRSxLQUFLQSxVQUFTLE1BQU0sRUFBRSxRQUFRLE1BQU07QUFDeEM7QUFDQSxjQUFJLE1BQU0sU0FBUyxFQUFHLE9BQU0sTUFBTSxFQUFHO0FBQUEsUUFDdEMsQ0FBQztBQUFBLE1BQ0Y7QUFDQSxVQUFJLFNBQVMsWUFBYSxLQUFJO0FBQUEsVUFDekIsT0FBTSxLQUFLLEdBQUc7QUFBQSxJQUNwQixDQUFDO0FBQUEsRUFDRjtBQUNEO0FBRUEsTUFBTSw2QkFBNkI7QUFDbkMsTUFBTSxvQkFBb0I7QUFDMUIsTUFBTSxvQkFBb0I7QUFFbkIsTUFBTSwwQkFBMEI7QUFtTHZDLFNBQVMseUJBQTZDO0FBQ3JELFNBQU87QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLFFBQVE7QUFBQSxJQUNSLFdBQVc7QUFBQSxJQUNYLFlBQVk7QUFBQSxJQUNaLE1BQU07QUFBQSxFQUNQO0FBQ0Q7QUFHQSxTQUFTLFdBQVcsTUFBNEM7QUFDL0QsV0FBUyxJQUFJLEdBQUcsSUFBSSxLQUFLLEtBQUs7QUFDN0IsVUFBTSxLQUFLLFdBQVcsRUFBRSxNQUFNLEdBQUcsQ0FBQztBQUNsQyxRQUFJLENBQUMsS0FBSyxJQUFJLEVBQUUsRUFBRyxRQUFPO0FBQUEsRUFDM0I7QUFFQSxTQUFPLFdBQVc7QUFDbkI7QUFHQSxTQUFTLGNBQWMsU0FBNEI7QUFDbEQsUUFBTSxNQUFNLG9CQUFJLElBQVk7QUFDNUIsTUFBSSxTQUF3QjtBQUU1QixhQUFXLFNBQVMsU0FBUztBQUM1QixRQUFJLE1BQU0sU0FBUyxXQUFXO0FBQzdCLFlBQU0sVUFBVTtBQUNoQjtBQUFBLElBQ0Q7QUFFQSxVQUFNLEtBQUssV0FBVyxHQUFHO0FBQ3pCLFVBQU0sV0FBVztBQUNqQixhQUFTLE1BQU07QUFHZixRQUFJLE1BQU0sU0FBUyxjQUFjO0FBQ2hDLFlBQU0sT0FBTztBQUNiLFVBQUksT0FBTyxLQUFLLHdCQUF3QixVQUFVO0FBQ2pELGNBQU0sY0FBYyxRQUFRLEtBQUssbUJBQW1CO0FBQ3BELFlBQUksZUFBZSxZQUFZLFNBQVMsV0FBVztBQUNsRCxlQUFLLG1CQUFtQixZQUFZO0FBQUEsUUFDckM7QUFDQSxlQUFPLEtBQUs7QUFBQSxNQUNiO0FBQUEsSUFDRDtBQUFBLEVBQ0Q7QUFDRDtBQUdBLFNBQVMsY0FBYyxTQUE0QjtBQUNsRCxhQUFXLFNBQVMsU0FBUztBQUM1QixRQUFJLE1BQU0sU0FBUyxXQUFXO0FBQzdCLFlBQU0sVUFBVTtBQUNoQjtBQUFBLElBQ0Q7QUFHQSxRQUFJLE1BQU0sU0FBUyxXQUFXO0FBQzdCLFlBQU0sV0FBVztBQUNqQixVQUFJLFNBQVMsV0FBWSxTQUFTLFFBQTZCLFNBQVMsZUFBZTtBQUN0RixRQUFDLFNBQVMsUUFBNkIsT0FBTztBQUFBLE1BQy9DO0FBQUEsSUFDRDtBQUFBLEVBQ0Q7QUFDRDtBQU1BLFNBQVMsd0JBQXdCLFNBQStCO0FBQy9ELFFBQU0sU0FBUyxRQUFRLEtBQUssQ0FBQyxNQUFNLEVBQUUsU0FBUyxTQUFTO0FBQ3ZELFFBQU0sVUFBVSxRQUFRLFdBQVc7QUFFbkMsTUFBSSxXQUFXLHdCQUF5QixRQUFPO0FBRS9DLE1BQUksVUFBVSxFQUFHLGVBQWMsT0FBTztBQUN0QyxNQUFJLFVBQVUsRUFBRyxlQUFjLE9BQU87QUFFdEMsU0FBTztBQUNSO0FBR08sU0FBUyxzQkFBc0IsU0FBNEI7QUFDakUsMEJBQXdCLE9BQU87QUFDaEM7QUFHTyxTQUFTLG9CQUFvQixTQUE4QjtBQUNqRSxRQUFNLFVBQXVCLENBQUM7QUFDOUIsUUFBTSxRQUFRLFFBQVEsS0FBSyxFQUFFLE1BQU0sSUFBSTtBQUV2QyxhQUFXLFFBQVEsT0FBTztBQUN6QixRQUFJLENBQUMsS0FBSyxLQUFLLEVBQUc7QUFDbEIsUUFBSTtBQUNILFlBQU0sUUFBUSxLQUFLLE1BQU0sSUFBSTtBQUM3QixjQUFRLEtBQUssS0FBSztBQUFBLElBQ25CLFFBQVE7QUFBQSxJQUVSO0FBQUEsRUFDRDtBQUVBLFNBQU87QUFDUjtBQUVPLFNBQVMseUJBQXlCLFNBQWlEO0FBQ3pGLFdBQVMsSUFBSSxRQUFRLFNBQVMsR0FBRyxLQUFLLEdBQUcsS0FBSztBQUM3QyxRQUFJLFFBQVEsQ0FBQyxFQUFFLFNBQVMsY0FBYztBQUNyQyxhQUFPLFFBQVEsQ0FBQztBQUFBLElBQ2pCO0FBQUEsRUFDRDtBQUNBLFNBQU87QUFDUjtBQU9PLFNBQVMsb0JBQ2YsU0FDQSxRQUNBLE1BQ2lCO0FBRWpCLE1BQUksQ0FBQyxNQUFNO0FBQ1YsV0FBTyxvQkFBSSxJQUEwQjtBQUNyQyxlQUFXLFNBQVMsU0FBUztBQUM1QixXQUFLLElBQUksTUFBTSxJQUFJLEtBQUs7QUFBQSxJQUN6QjtBQUFBLEVBQ0Q7QUFHQSxNQUFJO0FBQ0osTUFBSSxXQUFXLE1BQU07QUFFcEIsV0FBTyxFQUFFLFVBQVUsQ0FBQyxHQUFHLGVBQWUsT0FBTyxPQUFPLEtBQUs7QUFBQSxFQUMxRDtBQUNBLE1BQUksUUFBUTtBQUNYLFdBQU8sS0FBSyxJQUFJLE1BQU07QUFBQSxFQUN2QjtBQUNBLE1BQUksQ0FBQyxNQUFNO0FBRVYsV0FBTyxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBQUEsRUFDbEM7QUFFQSxNQUFJLENBQUMsTUFBTTtBQUNWLFdBQU8sRUFBRSxVQUFVLENBQUMsR0FBRyxlQUFlLE9BQU8sT0FBTyxLQUFLO0FBQUEsRUFDMUQ7QUFHQSxRQUFNLE9BQXVCLENBQUM7QUFDOUIsTUFBSSxVQUFvQztBQUN4QyxTQUFPLFNBQVM7QUFDZixTQUFLLFFBQVEsT0FBTztBQUNwQixjQUFVLFFBQVEsV0FBVyxLQUFLLElBQUksUUFBUSxRQUFRLElBQUk7QUFBQSxFQUMzRDtBQUdBLE1BQUksZ0JBQWdCO0FBQ3BCLE1BQUksUUFBc0Q7QUFDMUQsTUFBSSxhQUFxQztBQUV6QyxhQUFXLFNBQVMsTUFBTTtBQUN6QixRQUFJLE1BQU0sU0FBUyx5QkFBeUI7QUFDM0Msc0JBQWdCLE1BQU07QUFBQSxJQUN2QixXQUFXLE1BQU0sU0FBUyxnQkFBZ0I7QUFDekMsY0FBUSxFQUFFLFVBQVUsTUFBTSxVQUFVLFNBQVMsTUFBTSxRQUFRO0FBQUEsSUFDNUQsV0FBVyxNQUFNLFNBQVMsYUFBYSxNQUFNLFFBQVEsU0FBUyxhQUFhO0FBQzFFLGNBQVEsRUFBRSxVQUFVLE1BQU0sUUFBUSxVQUFVLFNBQVMsTUFBTSxRQUFRLE1BQU07QUFBQSxJQUMxRSxXQUFXLE1BQU0sU0FBUyxjQUFjO0FBQ3ZDLG1CQUFhO0FBQUEsSUFDZDtBQUFBLEVBQ0Q7QUFPQSxRQUFNLFdBQTJCLENBQUM7QUFFbEMsUUFBTSxnQkFBZ0IsQ0FBQyxVQUF3QjtBQUM5QyxRQUFJLE1BQU0sU0FBUyxXQUFXO0FBQzdCLGVBQVMsS0FBSyxNQUFNLE9BQU87QUFBQSxJQUM1QixXQUFXLE1BQU0sU0FBUyxrQkFBa0I7QUFDM0MsZUFBUztBQUFBLFFBQ1Isb0JBQW9CLE1BQU0sWUFBWSxNQUFNLFNBQVMsTUFBTSxTQUFTLE1BQU0sU0FBUyxNQUFNLFNBQVM7QUFBQSxNQUNuRztBQUFBLElBQ0QsV0FBVyxNQUFNLFNBQVMsb0JBQW9CLE1BQU0sU0FBUztBQUM1RCxlQUFTLEtBQUssMkJBQTJCLE1BQU0sU0FBUyxNQUFNLFFBQVEsTUFBTSxTQUFTLENBQUM7QUFBQSxJQUN2RjtBQUFBLEVBQ0Q7QUFFQSxNQUFJLFlBQVk7QUFFZixhQUFTLEtBQUssK0JBQStCLFdBQVcsU0FBUyxXQUFXLGNBQWMsV0FBVyxTQUFTLENBQUM7QUFHL0csVUFBTSxnQkFBZ0IsS0FBSyxVQUFVLENBQUMsTUFBTSxFQUFFLFNBQVMsZ0JBQWdCLEVBQUUsT0FBTyxXQUFXLEVBQUU7QUFHN0YsUUFBSSxpQkFBaUI7QUFDckIsYUFBUyxJQUFJLEdBQUcsSUFBSSxlQUFlLEtBQUs7QUFDdkMsWUFBTSxRQUFRLEtBQUssQ0FBQztBQUNwQixVQUFJLE1BQU0sT0FBTyxXQUFXLGtCQUFrQjtBQUM3Qyx5QkFBaUI7QUFBQSxNQUNsQjtBQUNBLFVBQUksZ0JBQWdCO0FBQ25CLHNCQUFjLEtBQUs7QUFBQSxNQUNwQjtBQUFBLElBQ0Q7QUFHQSxhQUFTLElBQUksZ0JBQWdCLEdBQUcsSUFBSSxLQUFLLFFBQVEsS0FBSztBQUNyRCxZQUFNLFFBQVEsS0FBSyxDQUFDO0FBQ3BCLG9CQUFjLEtBQUs7QUFBQSxJQUNwQjtBQUFBLEVBQ0QsT0FBTztBQUVOLGVBQVcsU0FBUyxNQUFNO0FBQ3pCLG9CQUFjLEtBQUs7QUFBQSxJQUNwQjtBQUFBLEVBQ0Q7QUFFQSxTQUFPLEVBQUUsVUFBVSxlQUFlLE1BQU07QUFDekM7QUFNQSxTQUFTLHFCQUFxQixLQUFxQjtBQUNsRCxRQUFNLFdBQVcsS0FBSyxJQUFJLFFBQVEsVUFBVSxFQUFFLEVBQUUsUUFBUSxXQUFXLEdBQUcsQ0FBQztBQUN2RSxRQUFNLGFBQWEsS0FBSyxtQkFBbUIsR0FBRyxZQUFZLFFBQVE7QUFDbEUsTUFBSSxDQUFDLFdBQVcsVUFBVSxHQUFHO0FBQzVCLGNBQVUsWUFBWSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQUEsRUFDMUM7QUFDQSxTQUFPO0FBQ1I7QUFFQSxTQUFTLGFBQWEsT0FBNkU7QUFDbEcsU0FDQyxPQUFPLFVBQVUsWUFDakIsVUFBVSxRQUNWLFVBQVUsU0FDVCxNQUE0QixTQUFTLFdBQ3RDLFVBQVUsU0FDVixPQUFRLE1BQTRCLFNBQVM7QUFFL0M7QUFFQSxTQUFTLGVBQWUsR0FBVyxXQUEyQjtBQUM3RCxNQUFJLEVBQUUsVUFBVSxVQUFXLFFBQU87QUFFbEMsTUFBSSxZQUFZLEtBQUssRUFBRSxXQUFXLFlBQVksQ0FBQyxLQUFLLFNBQVUsRUFBRSxXQUFXLFlBQVksQ0FBQyxLQUFLLE9BQVE7QUFDcEcsV0FBTyxFQUFFLE1BQU0sR0FBRyxZQUFZLENBQUM7QUFBQSxFQUNoQztBQUNBLFNBQU8sRUFBRSxNQUFNLEdBQUcsU0FBUztBQUM1QjtBQU1BLFNBQVMsc0JBQXNCLEtBQWMsV0FBc0IsS0FBdUI7QUFDekYsTUFBSSxRQUFRLFFBQVEsUUFBUSxPQUFXLFFBQU87QUFFOUMsTUFBSSxPQUFPLFFBQVEsVUFBVTtBQUc1QixVQUFNLGNBQWMsUUFBUSx1QkFBdUIsUUFBUSxzQkFBc0IsUUFBUTtBQUN6RixVQUFNLFdBQVcsY0FBYyxNQUFNLGNBQWMsR0FBRztBQUN0RCxRQUFJLFNBQVMsU0FBUyxtQkFBbUI7QUFDeEMsVUFBSSxhQUFhO0FBQ2hCLGVBQU87QUFBQSxNQUNSO0FBQ0EsWUFBTSxRQUFRLEtBQUssSUFBSSxHQUFHLG9CQUFvQixrQkFBa0IsTUFBTTtBQUN0RSxhQUFPLEdBQUcsZUFBZSxVQUFVLEtBQUssQ0FBQyxHQUFHLGlCQUFpQjtBQUFBLElBQzlEO0FBQ0EsV0FBTztBQUFBLEVBQ1I7QUFFQSxNQUFJLE1BQU0sUUFBUSxHQUFHLEdBQUc7QUFDdkIsUUFBSSxVQUFVO0FBQ2QsVUFBTSxTQUFTLElBQUksSUFBSSxDQUFDLFNBQVM7QUFFaEMsVUFBSSxRQUFRLGFBQWEsYUFBYSxJQUFJLEdBQUc7QUFDNUMsWUFBSSxDQUFDLFVBQVUsS0FBSyxJQUFJLEtBQUssS0FBSyxLQUFLLFVBQVUsNEJBQTRCO0FBQzVFLG9CQUFVO0FBQ1YsZ0JBQU0sVUFBVSxxQkFBcUIsV0FBVyxLQUFLLElBQUk7QUFDekQsaUJBQU8sRUFBRSxHQUFHLE1BQU0sTUFBTSxRQUFRO0FBQUEsUUFDakM7QUFBQSxNQUNEO0FBQ0EsWUFBTSxVQUFVLHNCQUFzQixNQUFNLFdBQVcsR0FBRztBQUMxRCxVQUFJLFlBQVksS0FBTSxXQUFVO0FBQ2hDLGFBQU87QUFBQSxJQUNSLENBQUM7QUFDRCxXQUFPLFVBQVUsU0FBUztBQUFBLEVBQzNCO0FBRUEsTUFBSSxPQUFPLFFBQVEsVUFBVTtBQUM1QixRQUFJLFVBQVU7QUFDZCxVQUFNLFNBQWtDLENBQUM7QUFDekMsZUFBVyxDQUFDLEdBQUcsQ0FBQyxLQUFLLE9BQU8sUUFBUSxHQUE4QixHQUFHO0FBRXBFLFVBQUksTUFBTSxpQkFBaUIsTUFBTSxlQUFlO0FBQy9DLGtCQUFVO0FBQ1Y7QUFBQSxNQUNEO0FBQ0EsWUFBTSxPQUFPLHNCQUFzQixHQUFHLFdBQVcsQ0FBQztBQUNsRCxhQUFPLENBQUMsSUFBSTtBQUNaLFVBQUksU0FBUyxFQUFHLFdBQVU7QUFBQSxJQUMzQjtBQUVBLFFBQUksV0FBVyxlQUFlLFVBQVUsYUFBYSxVQUFVLE9BQU8sT0FBTyxZQUFZLFVBQVU7QUFDbEcsYUFBTyxZQUFhLE9BQU8sUUFBbUIsTUFBTSxJQUFJLEVBQUU7QUFBQSxJQUMzRDtBQUNBLFdBQU8sVUFBVSxTQUFTO0FBQUEsRUFDM0I7QUFFQSxTQUFPO0FBQ1I7QUFNQSxTQUFTLHlCQUF5QixTQUFzQixXQUE0QjtBQUNuRixhQUFXLFNBQVMsU0FBUztBQUM1QixRQUFJLE1BQU0sU0FBUyxVQUFXO0FBRTlCLFFBQUk7QUFDSixRQUFJLE1BQU0sU0FBUyxXQUFXO0FBQzdCLFlBQU0sVUFBWSxNQUE4QixRQUFrQztBQUNsRixVQUFJLE1BQU0sUUFBUSxPQUFPLEVBQUcsZ0JBQWU7QUFBQSxJQUM1QyxXQUFXLE1BQU0sU0FBUyxvQkFBb0IsTUFBTSxRQUFTLE1BQWMsT0FBTyxHQUFHO0FBQ3BGLHFCQUFnQixNQUFjO0FBQUEsSUFDL0I7QUFFQSxRQUFJLENBQUMsYUFBYztBQUVuQixlQUFXLFNBQVMsY0FBYztBQUNqQyxVQUFJLGFBQWEsS0FBSyxLQUFLLFVBQVUsTUFBTSxJQUFJLEdBQUc7QUFDakQsUUFBQyxNQUEyQixPQUFPLGlCQUFpQixXQUFXLE1BQU0sSUFBSTtBQUFBLE1BQzFFO0FBQUEsSUFDRDtBQUFBLEVBQ0Q7QUFDRDtBQUVBLFNBQVMsb0JBQW9CLFVBQStCO0FBQzNELE1BQUksQ0FBQyxXQUFXLFFBQVEsRUFBRyxRQUFPLENBQUM7QUFFbkMsUUFBTSxVQUFVLGFBQWEsVUFBVSxNQUFNO0FBQzdDLFFBQU0sVUFBdUIsQ0FBQztBQUM5QixRQUFNLFFBQVEsUUFBUSxLQUFLLEVBQUUsTUFBTSxJQUFJO0FBRXZDLGFBQVcsUUFBUSxPQUFPO0FBQ3pCLFFBQUksQ0FBQyxLQUFLLEtBQUssRUFBRztBQUNsQixRQUFJO0FBQ0gsWUFBTSxRQUFRLEtBQUssTUFBTSxJQUFJO0FBQzdCLGNBQVEsS0FBSyxLQUFLO0FBQUEsSUFDbkIsUUFBUTtBQUFBLElBRVI7QUFBQSxFQUNEO0FBR0EsTUFBSSxRQUFRLFdBQVcsRUFBRyxRQUFPO0FBQ2pDLFFBQU0sU0FBUyxRQUFRLENBQUM7QUFDeEIsTUFBSSxPQUFPLFNBQVMsYUFBYSxPQUFRLE9BQWUsT0FBTyxVQUFVO0FBQ3hFLFdBQU8sQ0FBQztBQUFBLEVBQ1Q7QUFFQSxTQUFPO0FBQ1I7QUFFQSxTQUFTLG1CQUFtQixVQUEyQjtBQUN0RCxNQUFJO0FBQ0gsVUFBTSxLQUFLLFNBQVMsVUFBVSxHQUFHO0FBQ2pDLFVBQU0sU0FBUyxPQUFPLE1BQU0sR0FBRztBQUMvQixVQUFNLFlBQVksU0FBUyxJQUFJLFFBQVEsR0FBRyxLQUFLLENBQUM7QUFDaEQsY0FBVSxFQUFFO0FBQ1osVUFBTSxZQUFZLE9BQU8sU0FBUyxRQUFRLEdBQUcsU0FBUyxFQUFFLE1BQU0sSUFBSSxFQUFFLENBQUM7QUFDckUsUUFBSSxDQUFDLFVBQVcsUUFBTztBQUN2QixVQUFNLFNBQVMsS0FBSyxNQUFNLFNBQVM7QUFDbkMsV0FBTyxPQUFPLFNBQVMsYUFBYSxPQUFPLE9BQU8sT0FBTztBQUFBLEVBQzFELFFBQVE7QUFDUCxXQUFPO0FBQUEsRUFDUjtBQUNEO0FBRUEsU0FBUyxzQkFBc0IsWUFBbUM7QUFDakUsTUFBSTtBQUNILFVBQU0sUUFBUSxZQUFZLFVBQVUsRUFDbEMsT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUFTLFFBQVEsQ0FBQyxFQUNsQyxJQUFJLENBQUMsTUFBTSxLQUFLLFlBQVksQ0FBQyxDQUFDLEVBQzlCLE9BQU8sa0JBQWtCLEVBQ3pCLElBQUksQ0FBQyxVQUFVLEVBQUUsTUFBTSxPQUFPLFNBQVMsSUFBSSxFQUFFLE1BQU0sRUFBRSxFQUNyRCxLQUFLLENBQUMsR0FBRyxNQUFNLEVBQUUsTUFBTSxRQUFRLElBQUksRUFBRSxNQUFNLFFBQVEsQ0FBQztBQUV0RCxXQUFPLE1BQU0sQ0FBQyxHQUFHLFFBQVE7QUFBQSxFQUMxQixRQUFRO0FBQ1AsV0FBTztBQUFBLEVBQ1I7QUFDRDtBQUVBLFNBQVMscUJBQXFCLFNBQTJDO0FBQ3hFLFNBQU8sT0FBUSxRQUFvQixTQUFTLFlBQVksYUFBYTtBQUN0RTtBQUVBLFNBQVMsbUJBQW1CLFNBQTBCO0FBQ3JELFFBQU0sVUFBVSxRQUFRO0FBQ3hCLE1BQUksT0FBTyxZQUFZLFVBQVU7QUFDaEMsV0FBTztBQUFBLEVBQ1I7QUFDQSxTQUFPLFFBQ0wsT0FBTyxDQUFDLFVBQWdDLE1BQU0sU0FBUyxNQUFNLEVBQzdELElBQUksQ0FBQyxVQUFVLE1BQU0sSUFBSSxFQUN6QixLQUFLLEdBQUc7QUFDWDtBQUVBLFNBQVMsb0JBQW9CLFNBQTBDO0FBQ3RFLE1BQUk7QUFFSixhQUFXLFNBQVMsU0FBUztBQUM1QixRQUFJLE1BQU0sU0FBUyxVQUFXO0FBRTlCLFVBQU0sVUFBVyxNQUE4QjtBQUMvQyxRQUFJLENBQUMscUJBQXFCLE9BQU8sRUFBRztBQUNwQyxRQUFJLFFBQVEsU0FBUyxVQUFVLFFBQVEsU0FBUyxZQUFhO0FBRTdELFVBQU0sZUFBZ0IsUUFBbUM7QUFDekQsUUFBSSxPQUFPLGlCQUFpQixVQUFVO0FBQ3JDLHlCQUFtQixLQUFLLElBQUksb0JBQW9CLEdBQUcsWUFBWTtBQUMvRDtBQUFBLElBQ0Q7QUFFQSxVQUFNLGlCQUFrQixNQUEyQjtBQUNuRCxRQUFJLE9BQU8sbUJBQW1CLFVBQVU7QUFDdkMsWUFBTSxJQUFJLElBQUksS0FBSyxjQUFjLEVBQUUsUUFBUTtBQUMzQyxVQUFJLENBQUMsT0FBTyxNQUFNLENBQUMsR0FBRztBQUNyQiwyQkFBbUIsS0FBSyxJQUFJLG9CQUFvQixHQUFHLENBQUM7QUFBQSxNQUNyRDtBQUFBLElBQ0Q7QUFBQSxFQUNEO0FBRUEsU0FBTztBQUNSO0FBRUEsU0FBUyx1QkFBdUIsU0FBc0IsUUFBdUIsWUFBd0I7QUFDcEcsUUFBTSxtQkFBbUIsb0JBQW9CLE9BQU87QUFDcEQsTUFBSSxPQUFPLHFCQUFxQixZQUFZLG1CQUFtQixHQUFHO0FBQ2pFLFdBQU8sSUFBSSxLQUFLLGdCQUFnQjtBQUFBLEVBQ2pDO0FBRUEsUUFBTSxhQUFhLE9BQU8sT0FBTyxjQUFjLFdBQVcsSUFBSSxLQUFLLE9BQU8sU0FBUyxFQUFFLFFBQVEsSUFBSTtBQUNqRyxTQUFPLENBQUMsT0FBTyxNQUFNLFVBQVUsSUFBSSxJQUFJLEtBQUssVUFBVSxJQUFJO0FBQzNEO0FBRUEsZUFBZSxpQkFBaUIsVUFBK0M7QUFDOUUsTUFBSTtBQUNILFVBQU0sVUFBVSxNQUFNLFNBQVMsVUFBVSxNQUFNO0FBQy9DLFVBQU0sVUFBdUIsQ0FBQztBQUM5QixVQUFNLFFBQVEsUUFBUSxLQUFLLEVBQUUsTUFBTSxJQUFJO0FBRXZDLGVBQVcsUUFBUSxPQUFPO0FBQ3pCLFVBQUksQ0FBQyxLQUFLLEtBQUssRUFBRztBQUNsQixVQUFJO0FBQ0gsZ0JBQVEsS0FBSyxLQUFLLE1BQU0sSUFBSSxDQUFjO0FBQUEsTUFDM0MsUUFBUTtBQUFBLE1BRVI7QUFBQSxJQUNEO0FBRUEsUUFBSSxRQUFRLFdBQVcsRUFBRyxRQUFPO0FBQ2pDLFVBQU0sU0FBUyxRQUFRLENBQUM7QUFDeEIsUUFBSSxPQUFPLFNBQVMsVUFBVyxRQUFPO0FBRXRDLFVBQU0sUUFBUSxNQUFNLEtBQUssUUFBUTtBQUNqQyxRQUFJLGVBQWU7QUFDbkIsUUFBSSxlQUFlO0FBQ25CLFVBQU0sY0FBd0IsQ0FBQztBQUMvQixRQUFJO0FBRUosZUFBVyxTQUFTLFNBQVM7QUFFNUIsVUFBSSxNQUFNLFNBQVMsZ0JBQWdCO0FBQ2xDLGNBQU0sWUFBWTtBQUNsQixZQUFJLFVBQVUsTUFBTTtBQUNuQixpQkFBTyxVQUFVLEtBQUssS0FBSztBQUFBLFFBQzVCO0FBQUEsTUFDRDtBQUVBLFVBQUksTUFBTSxTQUFTLFVBQVc7QUFDOUI7QUFFQSxZQUFNLFVBQVcsTUFBOEI7QUFDL0MsVUFBSSxDQUFDLHFCQUFxQixPQUFPLEVBQUc7QUFDcEMsVUFBSSxRQUFRLFNBQVMsVUFBVSxRQUFRLFNBQVMsWUFBYTtBQUU3RCxZQUFNLGNBQWMsbUJBQW1CLE9BQU87QUFDOUMsVUFBSSxDQUFDLFlBQWE7QUFFbEIsa0JBQVksS0FBSyxXQUFXO0FBQzVCLFVBQUksQ0FBQyxnQkFBZ0IsUUFBUSxTQUFTLFFBQVE7QUFDN0MsdUJBQWU7QUFBQSxNQUNoQjtBQUFBLElBQ0Q7QUFFQSxVQUFNLE1BQU0sT0FBUSxPQUF5QixRQUFRLFdBQVksT0FBeUIsTUFBTTtBQUNoRyxVQUFNLG9CQUFxQixPQUF5QjtBQUVwRCxVQUFNLFdBQVcsdUJBQXVCLFNBQVMsUUFBeUIsTUFBTSxLQUFLO0FBRXJGLFdBQU87QUFBQSxNQUNOLE1BQU07QUFBQSxNQUNOLElBQUssT0FBeUI7QUFBQSxNQUM5QjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQSxTQUFTLElBQUksS0FBTSxPQUF5QixTQUFTO0FBQUEsTUFDckQ7QUFBQSxNQUNBO0FBQUEsTUFDQSxjQUFjLGdCQUFnQjtBQUFBLE1BQzlCLGlCQUFpQixZQUFZLEtBQUssR0FBRztBQUFBLElBQ3RDO0FBQUEsRUFDRCxRQUFRO0FBQ1AsV0FBTztBQUFBLEVBQ1I7QUFDRDtBQUlBLGVBQWUsb0JBQ2QsS0FDQSxZQUNBLGlCQUFpQixHQUNqQixlQUN5QjtBQUN6QixRQUFNLFdBQTBCLENBQUM7QUFDakMsTUFBSSxDQUFDLFdBQVcsR0FBRyxHQUFHO0FBQ3JCLFdBQU87QUFBQSxFQUNSO0FBRUEsTUFBSTtBQUNILFVBQU0sYUFBYSxNQUFNLFFBQVEsR0FBRztBQUNwQyxVQUFNLFFBQVEsV0FBVyxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQVMsUUFBUSxDQUFDLEVBQUUsSUFBSSxDQUFDLE1BQU0sS0FBSyxLQUFLLENBQUMsQ0FBQztBQUNwRixVQUFNLFFBQVEsaUJBQWlCLE1BQU07QUFFckMsUUFBSSxTQUFTO0FBQ2IsVUFBTSxVQUFVLE1BQU0sUUFBUTtBQUFBLE1BQzdCLE1BQU0sSUFBSSxPQUFPLFNBQVM7QUFDekIsY0FBTSxPQUFPLE1BQU0saUJBQWlCLElBQUk7QUFDeEM7QUFDQSxxQkFBYSxpQkFBaUIsUUFBUSxLQUFLO0FBQzNDLGVBQU87QUFBQSxNQUNSLENBQUM7QUFBQSxJQUNGO0FBQ0EsZUFBVyxRQUFRLFNBQVM7QUFDM0IsVUFBSSxNQUFNO0FBQ1QsaUJBQVMsS0FBSyxJQUFJO0FBQUEsTUFDbkI7QUFBQSxJQUNEO0FBQUEsRUFDRCxRQUFRO0FBQUEsRUFFUjtBQUVBLFNBQU87QUFDUjtBQWFPLE1BQU0sZUFBZTtBQUFBLEVBZW5CLFlBQVksS0FBYSxZQUFvQixhQUFpQyxTQUFrQjtBQWR4RyxTQUFRLFlBQW9CO0FBSzVCLFNBQVEsVUFBbUI7QUFDM0IsU0FBUSxjQUEyQixDQUFDO0FBQ3BDLFNBQVEsaUJBQWlDLENBQUM7QUFDMUMsU0FBUSxPQUFrQyxvQkFBSSxJQUFJO0FBRWxELFNBQVEsYUFBa0Msb0JBQUksSUFBSTtBQUNsRCxTQUFRLFNBQXdCO0FBQ2hDLFNBQVEsY0FBa0MsdUJBQXVCO0FBR2hFLFNBQUssTUFBTTtBQUNYLFNBQUssYUFBYTtBQUNsQixTQUFLLFVBQVU7QUFDZixTQUFLLFlBQVksSUFBSSxVQUFVLFlBQVksQ0FBQztBQUM1QyxRQUFJLFdBQVcsY0FBYyxDQUFDLFdBQVcsVUFBVSxHQUFHO0FBQ3JELGdCQUFVLFlBQVksRUFBRSxXQUFXLEtBQUssQ0FBQztBQUFBLElBQzFDO0FBRUEsUUFBSSxhQUFhO0FBQ2hCLFdBQUssZUFBZSxXQUFXO0FBQUEsSUFDaEMsT0FBTztBQUNOLFdBQUssV0FBVztBQUFBLElBQ2pCO0FBQUEsRUFDRDtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU9BLGlCQUEwQjtBQUV6QixhQUFTLElBQUksS0FBSyxZQUFZLFNBQVMsR0FBRyxLQUFLLEdBQUcsS0FBSztBQUN0RCxZQUFNLFFBQVEsS0FBSyxZQUFZLENBQUM7QUFDaEMsVUFBSSxNQUFNLFNBQVMsVUFBVztBQUU5QixZQUFNLE1BQU0sTUFBTTtBQUNsQixVQUFJLElBQUksU0FBUyxPQUFRLFFBQU87QUFDaEMsVUFBSSxJQUFJLFNBQVMsYUFBYTtBQUU3QixjQUFNLFVBQVUsTUFBTSxRQUFRLElBQUksT0FBTyxJQUFJLElBQUksVUFBVSxDQUFDO0FBQzVELGNBQU0sYUFBYSxRQUFRO0FBQUEsVUFDMUIsQ0FBQyxVQUFVLE1BQU0sU0FBUztBQUFBLFFBQzNCO0FBQ0EsWUFBSSxZQUFZO0FBR2YsaUJBQU87QUFBQSxRQUNSO0FBQ0EsZUFBTztBQUFBLE1BQ1I7QUFDQSxhQUFPO0FBQUEsSUFDUjtBQUNBLFdBQU87QUFBQSxFQUNSO0FBQUE7QUFBQSxFQUdBLGVBQWUsYUFBMkI7QUFDekMsU0FBSyxjQUFjLFFBQVEsV0FBVztBQUN0QyxRQUFJLFdBQVcsS0FBSyxXQUFXLEdBQUc7QUFDakMsV0FBSyxjQUFjLG9CQUFvQixLQUFLLFdBQVc7QUFJdkQsVUFBSSxLQUFLLFlBQVksV0FBVyxHQUFHO0FBQ2xDLGNBQU0sZUFBZSxLQUFLO0FBQzFCLGFBQUssV0FBVztBQUNoQixhQUFLLGNBQWM7QUFDbkIsYUFBSyxhQUFhO0FBQ2xCLGFBQUssVUFBVTtBQUNmO0FBQUEsTUFDRDtBQUVBLFlBQU0sU0FBUyxLQUFLLFlBQVksS0FBSyxDQUFDLE1BQU0sRUFBRSxTQUFTLFNBQVM7QUFDaEUsV0FBSyxZQUFZLFFBQVEsTUFBTSxXQUFXO0FBRTFDLFVBQUksd0JBQXdCLEtBQUssV0FBVyxHQUFHO0FBQzlDLGFBQUssYUFBYTtBQUFBLE1BQ25CO0FBRUEsV0FBSyxZQUFZO0FBQ2pCLCtCQUF5QixLQUFLLGFBQWEsS0FBSyxTQUFTO0FBQ3pELFdBQUssVUFBVTtBQUFBLElBQ2hCLE9BQU87QUFDTixZQUFNLGVBQWUsS0FBSztBQUMxQixXQUFLLFdBQVc7QUFDaEIsV0FBSyxjQUFjO0FBQUEsSUFDcEI7QUFBQSxFQUNEO0FBQUEsRUFFQSxXQUFXLFNBQWlEO0FBQzNELFNBQUssWUFBWSxXQUFXO0FBQzVCLFVBQU0sYUFBWSxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUN6QyxVQUFNLFNBQXdCO0FBQUEsTUFDN0IsTUFBTTtBQUFBLE1BQ04sU0FBUztBQUFBLE1BQ1QsSUFBSSxLQUFLO0FBQUEsTUFDVDtBQUFBLE1BQ0EsS0FBSyxLQUFLO0FBQUEsTUFDVixlQUFlLFNBQVM7QUFBQSxJQUN6QjtBQUNBLFNBQUssY0FBYyxDQUFDLE1BQU07QUFDMUIsU0FBSyxpQkFBaUIsQ0FBQztBQUN2QixTQUFLLEtBQUssTUFBTTtBQUNoQixTQUFLLFdBQVcsTUFBTTtBQUN0QixTQUFLLFNBQVM7QUFDZCxTQUFLLGNBQWMsdUJBQXVCO0FBQzFDLFNBQUssVUFBVTtBQUVmLFFBQUksS0FBSyxTQUFTO0FBQ2pCLFlBQU0sZ0JBQWdCLFVBQVUsUUFBUSxTQUFTLEdBQUc7QUFDcEQsV0FBSyxjQUFjLEtBQUssS0FBSyxjQUFjLEdBQUcsR0FBRyxhQUFhLElBQUksS0FBSyxTQUFTLFFBQVE7QUFBQSxJQUN6RjtBQUNBLFdBQU8sS0FBSztBQUFBLEVBQ2I7QUFBQSxFQUVRLGNBQW9CO0FBQzNCLFNBQUssaUJBQWlCLENBQUM7QUFDdkIsU0FBSyxLQUFLLE1BQU07QUFDaEIsU0FBSyxXQUFXLE1BQU07QUFDdEIsU0FBSyxTQUFTO0FBQ2QsU0FBSyxjQUFjLHVCQUF1QjtBQUMxQyxlQUFXLFNBQVMsS0FBSyxhQUFhO0FBQ3JDLFVBQUksTUFBTSxTQUFTLFVBQVc7QUFDOUIsV0FBSyxlQUFlLEtBQUssS0FBSztBQUM5QixXQUFLLEtBQUssSUFBSSxNQUFNLElBQUksS0FBSztBQUM3QixXQUFLLFNBQVMsTUFBTTtBQUNwQixXQUFLLGlCQUFpQixLQUFLO0FBQzNCLFVBQUksTUFBTSxTQUFTLFNBQVM7QUFDM0IsWUFBSSxNQUFNLE9BQU87QUFDaEIsZUFBSyxXQUFXLElBQUksTUFBTSxVQUFVLE1BQU0sS0FBSztBQUFBLFFBQ2hELE9BQU87QUFDTixlQUFLLFdBQVcsT0FBTyxNQUFNLFFBQVE7QUFBQSxRQUN0QztBQUFBLE1BQ0Q7QUFBQSxJQUNEO0FBQUEsRUFDRDtBQUFBLEVBRVEsZUFBcUI7QUFDNUIsUUFBSSxDQUFDLEtBQUssV0FBVyxDQUFDLEtBQUssWUFBYTtBQUN4QyxVQUFNLFVBQVUsR0FBRyxLQUFLLFlBQVksSUFBSSxDQUFDLE1BQU0sS0FBSyxVQUFVLHNCQUFzQixHQUFHLEtBQUssU0FBUyxDQUFDLENBQUMsRUFBRSxLQUFLLElBQUksQ0FBQztBQUFBO0FBQ25ILFFBQUk7QUFDSixRQUFJO0FBQ0gsZ0JBQVUsbUJBQW1CLEtBQUssV0FBVztBQUM3QywwQkFBb0IsS0FBSyxhQUFhLE9BQU87QUFBQSxJQUM5QyxVQUFFO0FBQ0QsZ0JBQVU7QUFBQSxJQUNYO0FBQUEsRUFDRDtBQUFBLEVBRUEsY0FBdUI7QUFDdEIsV0FBTyxLQUFLO0FBQUEsRUFDYjtBQUFBLEVBRUEsU0FBaUI7QUFDaEIsV0FBTyxLQUFLO0FBQUEsRUFDYjtBQUFBLEVBRUEsZ0JBQXdCO0FBQ3ZCLFdBQU8sS0FBSztBQUFBLEVBQ2I7QUFBQSxFQUVBLGVBQXVCO0FBQ3RCLFdBQU8sS0FBSztBQUFBLEVBQ2I7QUFBQSxFQUVBLGlCQUFxQztBQUNwQyxXQUFPLEtBQUs7QUFBQSxFQUNiO0FBQUEsRUFFQSxTQUFTLE9BQTJCO0FBQ25DLFFBQUksQ0FBQyxLQUFLLFdBQVcsQ0FBQyxLQUFLLFlBQWE7QUFFeEMsVUFBTSxlQUFlLEtBQUssWUFBWSxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsYUFBYSxFQUFFLFFBQVEsU0FBUyxXQUFXO0FBQ3hHLFFBQUksQ0FBQyxjQUFjO0FBRWxCLFdBQUssVUFBVTtBQUNmO0FBQUEsSUFDRDtBQUVBLFFBQUk7QUFDSixRQUFJO0FBQ0gsZ0JBQVUsbUJBQW1CLEtBQUssV0FBVztBQUM3QyxVQUFJLENBQUMsS0FBSyxTQUFTO0FBQ2xCLG1CQUFXLEtBQUssS0FBSyxhQUFhO0FBQ2pDLGdCQUFNLFdBQVcsc0JBQXNCLEdBQUcsS0FBSyxTQUFTO0FBQ3hELHlCQUFlLEtBQUssYUFBYSxHQUFHLEtBQUssVUFBVSxRQUFRLENBQUM7QUFBQSxDQUFJO0FBQUEsUUFDakU7QUFDQSxhQUFLLFVBQVU7QUFBQSxNQUNoQixPQUFPO0FBQ04sY0FBTSxXQUFXLHNCQUFzQixPQUFPLEtBQUssU0FBUztBQUM1RCx1QkFBZSxLQUFLLGFBQWEsR0FBRyxLQUFLLFVBQVUsUUFBUSxDQUFDO0FBQUEsQ0FBSTtBQUFBLE1BQ2pFO0FBQUEsSUFDRCxVQUFFO0FBQ0QsZ0JBQVU7QUFBQSxJQUNYO0FBQUEsRUFDRDtBQUFBLEVBRVEsYUFBYSxPQUEyQjtBQUMvQyxTQUFLLFlBQVksS0FBSyxLQUFLO0FBQzNCLFNBQUssZUFBZSxLQUFLLEtBQUs7QUFDOUIsU0FBSyxLQUFLLElBQUksTUFBTSxJQUFJLEtBQUs7QUFDN0IsU0FBSyxTQUFTLE1BQU07QUFDcEIsU0FBSyxpQkFBaUIsS0FBSztBQUMzQixTQUFLLFNBQVMsS0FBSztBQUFBLEVBQ3BCO0FBQUEsRUFFUSxpQkFBaUIsT0FBMkI7QUFDbkQsUUFBSSxNQUFNLFNBQVMsYUFBYSxNQUFNLFFBQVEsU0FBUyxhQUFhO0FBQ25FO0FBQUEsSUFDRDtBQUVBLFVBQU0sUUFBUSxNQUFNLFFBQVE7QUFDNUIsUUFBSSxDQUFDLE9BQU87QUFDWDtBQUFBLElBQ0Q7QUFFQSxTQUFLLFlBQVksU0FBUyxNQUFNO0FBQ2hDLFNBQUssWUFBWSxVQUFVLE1BQU07QUFDakMsU0FBSyxZQUFZLGFBQWEsTUFBTTtBQUNwQyxTQUFLLFlBQVksY0FBYyxNQUFNO0FBQ3JDLFNBQUssWUFBWSxRQUFRLE1BQU0sS0FBSztBQUFBLEVBQ3JDO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFRQSxjQUFjLFNBQWlFO0FBQzlFLFVBQU0sUUFBNkI7QUFBQSxNQUNsQyxNQUFNO0FBQUEsTUFDTixJQUFJLFdBQVcsS0FBSyxJQUFJO0FBQUEsTUFDeEIsVUFBVSxLQUFLO0FBQUEsTUFDZixZQUFXLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQUEsTUFDbEM7QUFBQSxJQUNEO0FBQ0EsU0FBSyxhQUFhLEtBQUs7QUFDdkIsV0FBTyxNQUFNO0FBQUEsRUFDZDtBQUFBO0FBQUEsRUFHQSwwQkFBMEIsZUFBK0I7QUFDeEQsVUFBTSxRQUFrQztBQUFBLE1BQ3ZDLE1BQU07QUFBQSxNQUNOLElBQUksV0FBVyxLQUFLLElBQUk7QUFBQSxNQUN4QixVQUFVLEtBQUs7QUFBQSxNQUNmLFlBQVcsb0JBQUksS0FBSyxHQUFFLFlBQVk7QUFBQSxNQUNsQztBQUFBLElBQ0Q7QUFDQSxTQUFLLGFBQWEsS0FBSztBQUN2QixXQUFPLE1BQU07QUFBQSxFQUNkO0FBQUE7QUFBQSxFQUdBLGtCQUFrQixVQUFrQixTQUF5QjtBQUM1RCxVQUFNLFFBQTBCO0FBQUEsTUFDL0IsTUFBTTtBQUFBLE1BQ04sSUFBSSxXQUFXLEtBQUssSUFBSTtBQUFBLE1BQ3hCLFVBQVUsS0FBSztBQUFBLE1BQ2YsWUFBVyxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLE1BQ2xDO0FBQUEsTUFDQTtBQUFBLElBQ0Q7QUFDQSxTQUFLLGFBQWEsS0FBSztBQUN2QixXQUFPLE1BQU07QUFBQSxFQUNkO0FBQUE7QUFBQSxFQUdBLGlCQUNDLFNBQ0Esa0JBQ0EsY0FDQSxTQUNBLFVBQ1M7QUFDVCxVQUFNLFFBQTRCO0FBQUEsTUFDakMsTUFBTTtBQUFBLE1BQ04sSUFBSSxXQUFXLEtBQUssSUFBSTtBQUFBLE1BQ3hCLFVBQVUsS0FBSztBQUFBLE1BQ2YsWUFBVyxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLE1BQ2xDO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Q7QUFDQSxTQUFLLGFBQWEsS0FBSztBQUN2QixXQUFPLE1BQU07QUFBQSxFQUNkO0FBQUE7QUFBQSxFQUdBLGtCQUFrQixZQUFvQixNQUF3QjtBQUM3RCxVQUFNLFFBQXFCO0FBQUEsTUFDMUIsTUFBTTtBQUFBLE1BQ047QUFBQSxNQUNBO0FBQUEsTUFDQSxJQUFJLFdBQVcsS0FBSyxJQUFJO0FBQUEsTUFDeEIsVUFBVSxLQUFLO0FBQUEsTUFDZixZQUFXLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQUEsSUFDbkM7QUFDQSxTQUFLLGFBQWEsS0FBSztBQUN2QixXQUFPLE1BQU07QUFBQSxFQUNkO0FBQUE7QUFBQSxFQUdBLGtCQUFrQixNQUFzQjtBQUN2QyxVQUFNLFFBQTBCO0FBQUEsTUFDL0IsTUFBTTtBQUFBLE1BQ04sSUFBSSxXQUFXLEtBQUssSUFBSTtBQUFBLE1BQ3hCLFVBQVUsS0FBSztBQUFBLE1BQ2YsWUFBVyxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLE1BQ2xDLE1BQU0sS0FBSyxLQUFLO0FBQUEsSUFDakI7QUFDQSxTQUFLLGFBQWEsS0FBSztBQUN2QixXQUFPLE1BQU07QUFBQSxFQUNkO0FBQUE7QUFBQSxFQUdBLGlCQUFxQztBQUVwQyxVQUFNLFVBQVUsS0FBSyxXQUFXO0FBQ2hDLGFBQVMsSUFBSSxRQUFRLFNBQVMsR0FBRyxLQUFLLEdBQUcsS0FBSztBQUM3QyxZQUFNLFFBQVEsUUFBUSxDQUFDO0FBQ3ZCLFVBQUksTUFBTSxTQUFTLGtCQUFrQixNQUFNLE1BQU07QUFDaEQsZUFBTyxNQUFNO0FBQUEsTUFDZDtBQUFBLElBQ0Q7QUFDQSxXQUFPO0FBQUEsRUFDUjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQVVBLHlCQUNDLFlBQ0EsU0FDQSxTQUNBLFNBQ1M7QUFDVCxVQUFNLFFBQStCO0FBQUEsTUFDcEMsTUFBTTtBQUFBLE1BQ047QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLElBQUksV0FBVyxLQUFLLElBQUk7QUFBQSxNQUN4QixVQUFVLEtBQUs7QUFBQSxNQUNmLFlBQVcsb0JBQUksS0FBSyxHQUFFLFlBQVk7QUFBQSxJQUNuQztBQUNBLFNBQUssYUFBYSxLQUFLO0FBQ3ZCLFdBQU8sTUFBTTtBQUFBLEVBQ2Q7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU1BLFlBQTJCO0FBQzFCLFdBQU8sS0FBSztBQUFBLEVBQ2I7QUFBQSxFQUVBLGVBQXlDO0FBQ3hDLFdBQU8sS0FBSyxTQUFTLEtBQUssS0FBSyxJQUFJLEtBQUssTUFBTSxJQUFJO0FBQUEsRUFDbkQ7QUFBQSxFQUVBLFNBQVMsSUFBc0M7QUFDOUMsV0FBTyxLQUFLLEtBQUssSUFBSSxFQUFFO0FBQUEsRUFDeEI7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQUtBLFlBQVksVUFBa0M7QUFDN0MsVUFBTSxXQUEyQixDQUFDO0FBQ2xDLGVBQVcsU0FBUyxLQUFLLEtBQUssT0FBTyxHQUFHO0FBQ3ZDLFVBQUksTUFBTSxhQUFhLFVBQVU7QUFDaEMsaUJBQVMsS0FBSyxLQUFLO0FBQUEsTUFDcEI7QUFBQSxJQUNEO0FBQ0EsV0FBTztBQUFBLEVBQ1I7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQUtBLFNBQVMsSUFBZ0M7QUFDeEMsV0FBTyxLQUFLLFdBQVcsSUFBSSxFQUFFO0FBQUEsRUFDOUI7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFPQSxrQkFBa0IsVUFBa0IsT0FBbUM7QUFDdEUsUUFBSSxDQUFDLEtBQUssS0FBSyxJQUFJLFFBQVEsR0FBRztBQUM3QixZQUFNLElBQUksTUFBTSxTQUFTLFFBQVEsWUFBWTtBQUFBLElBQzlDO0FBQ0EsVUFBTSxRQUFvQjtBQUFBLE1BQ3pCLE1BQU07QUFBQSxNQUNOLElBQUksV0FBVyxLQUFLLElBQUk7QUFBQSxNQUN4QixVQUFVLEtBQUs7QUFBQSxNQUNmLFlBQVcsb0JBQUksS0FBSyxHQUFFLFlBQVk7QUFBQSxNQUNsQztBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBQ0EsU0FBSyxhQUFhLEtBQUs7QUFDdkIsUUFBSSxPQUFPO0FBQ1YsV0FBSyxXQUFXLElBQUksVUFBVSxLQUFLO0FBQUEsSUFDcEMsT0FBTztBQUNOLFdBQUssV0FBVyxPQUFPLFFBQVE7QUFBQSxJQUNoQztBQUNBLFdBQU8sTUFBTTtBQUFBLEVBQ2Q7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFPQSxVQUFVLFFBQWlDO0FBQzFDLFVBQU0sT0FBdUIsQ0FBQztBQUM5QixVQUFNLFVBQVUsVUFBVSxLQUFLO0FBQy9CLFFBQUksVUFBVSxVQUFVLEtBQUssS0FBSyxJQUFJLE9BQU8sSUFBSTtBQUNqRCxXQUFPLFNBQVM7QUFDZixXQUFLLFFBQVEsT0FBTztBQUNwQixnQkFBVSxRQUFRLFdBQVcsS0FBSyxLQUFLLElBQUksUUFBUSxRQUFRLElBQUk7QUFBQSxJQUNoRTtBQUNBLFdBQU87QUFBQSxFQUNSO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU1BLHNCQUFzQztBQUNyQyxXQUFPLG9CQUFvQixLQUFLLFdBQVcsR0FBRyxLQUFLLFFBQVEsS0FBSyxJQUFJO0FBQUEsRUFDckU7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQUtBLFlBQWtDO0FBQ2pDLFVBQU0sSUFBSSxLQUFLLFlBQVksS0FBSyxDQUFDLE1BQU0sRUFBRSxTQUFTLFNBQVM7QUFDM0QsV0FBTyxJQUFLLElBQXNCO0FBQUEsRUFDbkM7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFPQSxhQUE2QjtBQUM1QixXQUFPLENBQUMsR0FBRyxLQUFLLGNBQWM7QUFBQSxFQUMvQjtBQUFBLEVBRUEsaUJBQXFDO0FBQ3BDLFdBQU8sRUFBRSxHQUFHLEtBQUssWUFBWTtBQUFBLEVBQzlCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBT0EsVUFBNkI7QUFDNUIsVUFBTSxVQUFVLEtBQUssV0FBVztBQUNoQyxVQUFNLFVBQVUsb0JBQUksSUFBNkI7QUFDakQsVUFBTSxRQUEyQixDQUFDO0FBR2xDLGVBQVcsU0FBUyxTQUFTO0FBQzVCLFlBQU0sUUFBUSxLQUFLLFdBQVcsSUFBSSxNQUFNLEVBQUU7QUFDMUMsY0FBUSxJQUFJLE1BQU0sSUFBSSxFQUFFLE9BQU8sVUFBVSxDQUFDLEdBQUcsTUFBTSxDQUFDO0FBQUEsSUFDckQ7QUFHQSxlQUFXLFNBQVMsU0FBUztBQUM1QixZQUFNLE9BQU8sUUFBUSxJQUFJLE1BQU0sRUFBRTtBQUNqQyxVQUFJLE1BQU0sYUFBYSxRQUFRLE1BQU0sYUFBYSxNQUFNLElBQUk7QUFDM0QsY0FBTSxLQUFLLElBQUk7QUFBQSxNQUNoQixPQUFPO0FBQ04sY0FBTSxTQUFTLFFBQVEsSUFBSSxNQUFNLFFBQVE7QUFDekMsWUFBSSxRQUFRO0FBQ1gsaUJBQU8sU0FBUyxLQUFLLElBQUk7QUFBQSxRQUMxQixPQUFPO0FBRU4sZ0JBQU0sS0FBSyxJQUFJO0FBQUEsUUFDaEI7QUFBQSxNQUNEO0FBQUEsSUFDRDtBQUlBLFVBQU0sUUFBMkIsQ0FBQyxHQUFHLEtBQUs7QUFDMUMsV0FBTyxNQUFNLFNBQVMsR0FBRztBQUN4QixZQUFNLE9BQU8sTUFBTSxJQUFJO0FBQ3ZCLFdBQUssU0FBUyxLQUFLLENBQUMsR0FBRyxNQUFNLElBQUksS0FBSyxFQUFFLE1BQU0sU0FBUyxFQUFFLFFBQVEsSUFBSSxJQUFJLEtBQUssRUFBRSxNQUFNLFNBQVMsRUFBRSxRQUFRLENBQUM7QUFDMUcsWUFBTSxLQUFLLEdBQUcsS0FBSyxRQUFRO0FBQUEsSUFDNUI7QUFFQSxXQUFPO0FBQUEsRUFDUjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBWUEsT0FBTyxjQUE0QjtBQUNsQyxRQUFJLENBQUMsS0FBSyxLQUFLLElBQUksWUFBWSxHQUFHO0FBQ2pDLFlBQU0sSUFBSSxNQUFNLFNBQVMsWUFBWSxZQUFZO0FBQUEsSUFDbEQ7QUFDQSxTQUFLLFNBQVM7QUFBQSxFQUNmO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBT0EsWUFBa0I7QUFDakIsU0FBSyxTQUFTO0FBQUEsRUFDZjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU9BLGtCQUFrQixjQUE2QixTQUFpQixTQUFtQixVQUE0QjtBQUM5RyxRQUFJLGlCQUFpQixRQUFRLENBQUMsS0FBSyxLQUFLLElBQUksWUFBWSxHQUFHO0FBQzFELFlBQU0sSUFBSSxNQUFNLFNBQVMsWUFBWSxZQUFZO0FBQUEsSUFDbEQ7QUFDQSxTQUFLLFNBQVM7QUFDZCxVQUFNLFFBQTRCO0FBQUEsTUFDakMsTUFBTTtBQUFBLE1BQ04sSUFBSSxXQUFXLEtBQUssSUFBSTtBQUFBLE1BQ3hCLFVBQVU7QUFBQSxNQUNWLFlBQVcsb0JBQUksS0FBSyxHQUFFLFlBQVk7QUFBQSxNQUNsQyxRQUFRLGdCQUFnQjtBQUFBLE1BQ3hCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBQ0EsU0FBSyxhQUFhLEtBQUs7QUFDdkIsV0FBTyxNQUFNO0FBQUEsRUFDZDtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU9BLHNCQUFzQixRQUFvQztBQUN6RCxVQUFNLHNCQUFzQixLQUFLO0FBQ2pDLFVBQU0sT0FBTyxLQUFLLFVBQVUsTUFBTTtBQUNsQyxRQUFJLEtBQUssV0FBVyxHQUFHO0FBQ3RCLFlBQU0sSUFBSSxNQUFNLFNBQVMsTUFBTSxZQUFZO0FBQUEsSUFDNUM7QUFHQSxVQUFNLG9CQUFvQixLQUFLLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBUyxPQUFPO0FBRS9ELFVBQU0sZUFBZSxXQUFXO0FBQ2hDLFVBQU0sYUFBWSxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUN6QyxVQUFNLGdCQUFnQixVQUFVLFFBQVEsU0FBUyxHQUFHO0FBQ3BELFVBQU0saUJBQWlCLEtBQUssS0FBSyxjQUFjLEdBQUcsR0FBRyxhQUFhLElBQUksWUFBWSxRQUFRO0FBRTFGLFVBQU0sU0FBd0I7QUFBQSxNQUM3QixNQUFNO0FBQUEsTUFDTixTQUFTO0FBQUEsTUFDVCxJQUFJO0FBQUEsTUFDSjtBQUFBLE1BQ0EsS0FBSyxLQUFLO0FBQUEsTUFDVixlQUFlLEtBQUssVUFBVSxzQkFBc0I7QUFBQSxJQUNyRDtBQUdBLFVBQU0sZUFBZSxJQUFJLElBQUksa0JBQWtCLElBQUksQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDO0FBQy9ELFVBQU0sZ0JBQTRELENBQUM7QUFDbkUsZUFBVyxDQUFDLFVBQVUsS0FBSyxLQUFLLEtBQUssWUFBWTtBQUNoRCxVQUFJLGFBQWEsSUFBSSxRQUFRLEdBQUc7QUFDL0Isc0JBQWMsS0FBSyxFQUFFLFVBQVUsTUFBTSxDQUFDO0FBQUEsTUFDdkM7QUFBQSxJQUNEO0FBRUEsUUFBSSxLQUFLLFNBQVM7QUFFakIsWUFBTSxjQUFjLGtCQUFrQixrQkFBa0IsU0FBUyxDQUFDLEdBQUcsTUFBTTtBQUMzRSxVQUFJQyxZQUFXO0FBQ2YsWUFBTUMsZ0JBQTZCLENBQUM7QUFDcEMsaUJBQVcsRUFBRSxVQUFVLE1BQU0sS0FBSyxlQUFlO0FBQ2hELGNBQU0sYUFBeUI7QUFBQSxVQUM5QixNQUFNO0FBQUEsVUFDTixJQUFJLFdBQVcsSUFBSSxJQUFJLFlBQVksQ0FBQztBQUFBLFVBQ3BDLFVBQUFEO0FBQUEsVUFDQSxZQUFXLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQUEsVUFDbEM7QUFBQSxVQUNBO0FBQUEsUUFDRDtBQUNBLHFCQUFhLElBQUksV0FBVyxFQUFFO0FBQzlCLFFBQUFDLGNBQWEsS0FBSyxVQUFVO0FBQzVCLFFBQUFELFlBQVcsV0FBVztBQUFBLE1BQ3ZCO0FBRUEsV0FBSyxjQUFjLENBQUMsUUFBUSxHQUFHLG1CQUFtQixHQUFHQyxhQUFZO0FBQ2pFLFdBQUssWUFBWTtBQUNqQixXQUFLLGNBQWM7QUFDbkIsV0FBSyxZQUFZO0FBT2pCLFlBQU0sZUFBZSxLQUFLLFlBQVksS0FBSyxDQUFDLE1BQU0sRUFBRSxTQUFTLGFBQWEsRUFBRSxRQUFRLFNBQVMsV0FBVztBQUN4RyxVQUFJLGNBQWM7QUFDakIsYUFBSyxhQUFhO0FBQ2xCLGFBQUssVUFBVTtBQUFBLE1BQ2hCLE9BQU87QUFDTixhQUFLLFVBQVU7QUFBQSxNQUNoQjtBQUVBLGFBQU87QUFBQSxJQUNSO0FBR0EsVUFBTSxlQUE2QixDQUFDO0FBQ3BDLFFBQUksV0FBVyxrQkFBa0Isa0JBQWtCLFNBQVMsQ0FBQyxHQUFHLE1BQU07QUFDdEUsZUFBVyxFQUFFLFVBQVUsTUFBTSxLQUFLLGVBQWU7QUFDaEQsWUFBTSxhQUF5QjtBQUFBLFFBQzlCLE1BQU07QUFBQSxRQUNOLElBQUksV0FBVyxvQkFBSSxJQUFJLENBQUMsR0FBRyxjQUFjLEdBQUcsYUFBYSxJQUFJLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFBQSxRQUMzRTtBQUFBLFFBQ0EsWUFBVyxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLFFBQ2xDO0FBQUEsUUFDQTtBQUFBLE1BQ0Q7QUFDQSxtQkFBYSxLQUFLLFVBQVU7QUFDNUIsaUJBQVcsV0FBVztBQUFBLElBQ3ZCO0FBQ0EsU0FBSyxjQUFjLENBQUMsUUFBUSxHQUFHLG1CQUFtQixHQUFHLFlBQVk7QUFDakUsU0FBSyxZQUFZO0FBQ2pCLFNBQUssWUFBWTtBQUNqQixXQUFPO0FBQUEsRUFDUjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU9BLE9BQU8sT0FBTyxLQUFhLFlBQXFDO0FBQy9ELFVBQU0sTUFBTSxjQUFjLHFCQUFxQixHQUFHO0FBQ2xELFdBQU8sSUFBSSxlQUFlLEtBQUssS0FBSyxRQUFXLElBQUk7QUFBQSxFQUNwRDtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU9BLE9BQU8sS0FBSyxNQUFjLFlBQXFDO0FBRTlELFVBQU0sVUFBVSxvQkFBb0IsSUFBSTtBQUN4QyxVQUFNLFNBQVMsUUFBUSxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsU0FBUztBQUN2RCxVQUFNLE1BQU0sUUFBUSxPQUFPLFFBQVEsSUFBSTtBQUV2QyxVQUFNLE1BQU0sY0FBYyxRQUFRLE1BQU0sSUFBSTtBQUM1QyxXQUFPLElBQUksZUFBZSxLQUFLLEtBQUssTUFBTSxJQUFJO0FBQUEsRUFDL0M7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFPQSxPQUFPLGVBQWUsS0FBYSxZQUFxQztBQUN2RSxVQUFNLE1BQU0sY0FBYyxxQkFBcUIsR0FBRztBQUNsRCxVQUFNLGFBQWEsc0JBQXNCLEdBQUc7QUFDNUMsUUFBSSxZQUFZO0FBQ2YsYUFBTyxJQUFJLGVBQWUsS0FBSyxLQUFLLFlBQVksSUFBSTtBQUFBLElBQ3JEO0FBQ0EsV0FBTyxJQUFJLGVBQWUsS0FBSyxLQUFLLFFBQVcsSUFBSTtBQUFBLEVBQ3BEO0FBQUE7QUFBQSxFQUdBLE9BQU8sU0FBUyxNQUFjLFFBQVEsSUFBSSxHQUFtQjtBQUM1RCxXQUFPLElBQUksZUFBZSxLQUFLLElBQUksUUFBVyxLQUFLO0FBQUEsRUFDcEQ7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBU0EsT0FBTyxTQUFTLFlBQW9CLFdBQW1CLFlBQXFDO0FBQzNGLFVBQU0sZ0JBQWdCLG9CQUFvQixVQUFVO0FBQ3BELFFBQUksY0FBYyxXQUFXLEdBQUc7QUFDL0IsWUFBTSxJQUFJLE1BQU0seURBQXlELFVBQVUsRUFBRTtBQUFBLElBQ3RGO0FBRUEsVUFBTSxlQUFlLGNBQWMsS0FBSyxDQUFDLE1BQU0sRUFBRSxTQUFTLFNBQVM7QUFDbkUsUUFBSSxDQUFDLGNBQWM7QUFDbEIsWUFBTSxJQUFJLE1BQU0sOENBQThDLFVBQVUsRUFBRTtBQUFBLElBQzNFO0FBRUEsVUFBTSxNQUFNLGNBQWMscUJBQXFCLFNBQVM7QUFDeEQsUUFBSSxDQUFDLFdBQVcsR0FBRyxHQUFHO0FBQ3JCLGdCQUFVLEtBQUssRUFBRSxXQUFXLEtBQUssQ0FBQztBQUFBLElBQ25DO0FBR0EsVUFBTSxlQUFlLFdBQVc7QUFDaEMsVUFBTSxhQUFZLG9CQUFJLEtBQUssR0FBRSxZQUFZO0FBQ3pDLFVBQU0sZ0JBQWdCLFVBQVUsUUFBUSxTQUFTLEdBQUc7QUFDcEQsVUFBTSxpQkFBaUIsS0FBSyxLQUFLLEdBQUcsYUFBYSxJQUFJLFlBQVksUUFBUTtBQUd6RSxVQUFNLFlBQTJCO0FBQUEsTUFDaEMsTUFBTTtBQUFBLE1BQ04sU0FBUztBQUFBLE1BQ1QsSUFBSTtBQUFBLE1BQ0o7QUFBQSxNQUNBLEtBQUs7QUFBQSxNQUNMLGVBQWU7QUFBQSxJQUNoQjtBQUVBLFVBQU0sUUFBUSxDQUFDLEtBQUssVUFBVSxTQUFTLENBQUM7QUFDeEMsZUFBVyxTQUFTLGVBQWU7QUFDbEMsVUFBSSxNQUFNLFNBQVMsV0FBVztBQUM3QixjQUFNLEtBQUssS0FBSyxVQUFVLEtBQUssQ0FBQztBQUFBLE1BQ2pDO0FBQUEsSUFDRDtBQUNBLHdCQUFvQixnQkFBZ0IsTUFBTSxLQUFLLElBQUksSUFBSSxJQUFJO0FBRTNELFdBQU8sSUFBSSxlQUFlLFdBQVcsS0FBSyxnQkFBZ0IsSUFBSTtBQUFBLEVBQy9EO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFRQSxhQUFhLEtBQUssS0FBYSxZQUFxQixZQUEwRDtBQUM3RyxVQUFNLE1BQU0sY0FBYyxxQkFBcUIsR0FBRztBQUNsRCxVQUFNLFdBQVcsTUFBTSxvQkFBb0IsS0FBSyxVQUFVO0FBQzFELGFBQVMsS0FBSyxDQUFDLEdBQUcsTUFBTSxFQUFFLFNBQVMsUUFBUSxJQUFJLEVBQUUsU0FBUyxRQUFRLENBQUM7QUFDbkUsV0FBTztBQUFBLEVBQ1I7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBTUEsYUFBYSxRQUFRLFlBQTBEO0FBQzlFLFVBQU0sY0FBYyxlQUFlO0FBRW5DLFFBQUk7QUFDSCxVQUFJLENBQUMsV0FBVyxXQUFXLEdBQUc7QUFDN0IsZUFBTyxDQUFDO0FBQUEsTUFDVDtBQUNBLFlBQU0sVUFBVSxNQUFNLFFBQVEsYUFBYSxFQUFFLGVBQWUsS0FBSyxDQUFDO0FBQ2xFLFlBQU0sT0FBTyxRQUFRLE9BQU8sQ0FBQyxNQUFNLEVBQUUsWUFBWSxDQUFDLEVBQUUsSUFBSSxDQUFDLE1BQU0sS0FBSyxhQUFhLEVBQUUsSUFBSSxDQUFDO0FBR3hGLFVBQUksYUFBYTtBQUNqQixZQUFNLFdBQXVCLENBQUM7QUFDOUIsaUJBQVcsT0FBTyxNQUFNO0FBQ3ZCLFlBQUk7QUFDSCxnQkFBTSxTQUFTLE1BQU0sUUFBUSxHQUFHLEdBQUcsT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUFTLFFBQVEsQ0FBQztBQUNyRSxtQkFBUyxLQUFLLE1BQU0sSUFBSSxDQUFDLE1BQU0sS0FBSyxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQzVDLHdCQUFjLE1BQU07QUFBQSxRQUNyQixRQUFRO0FBQ1AsbUJBQVMsS0FBSyxDQUFDLENBQUM7QUFBQSxRQUNqQjtBQUFBLE1BQ0Q7QUFHQSxVQUFJLFNBQVM7QUFDYixZQUFNLFdBQTBCLENBQUM7QUFDakMsWUFBTSxXQUFXLFNBQVMsS0FBSztBQUcvQixZQUFNLFFBQVEsT0FBTyxFQUFFO0FBQ3ZCLFlBQU0sVUFBVSxNQUFNLFFBQVE7QUFBQSxRQUM3QixTQUFTO0FBQUEsVUFBSSxDQUFDLFNBQ2IsTUFBTSxZQUFZO0FBQ2pCLGtCQUFNLE9BQU8sTUFBTSxpQkFBaUIsSUFBSTtBQUN4QztBQUNBLHlCQUFhLFFBQVEsVUFBVTtBQUMvQixtQkFBTztBQUFBLFVBQ1IsQ0FBQztBQUFBLFFBQ0Y7QUFBQSxNQUNEO0FBRUEsaUJBQVcsUUFBUSxTQUFTO0FBQzNCLFlBQUksTUFBTTtBQUNULG1CQUFTLEtBQUssSUFBSTtBQUFBLFFBQ25CO0FBQUEsTUFDRDtBQUVBLGVBQVMsS0FBSyxDQUFDLEdBQUcsTUFBTSxFQUFFLFNBQVMsUUFBUSxJQUFJLEVBQUUsU0FBUyxRQUFRLENBQUM7QUFDbkUsYUFBTztBQUFBLElBQ1IsUUFBUTtBQUNQLGFBQU8sQ0FBQztBQUFBLElBQ1Q7QUFBQSxFQUNEO0FBQ0Q7IiwKICAibmFtZXMiOiBbInJlc29sdmUiLCAicGFyZW50SWQiLCAibGFiZWxFbnRyaWVzIl0KfQo=
