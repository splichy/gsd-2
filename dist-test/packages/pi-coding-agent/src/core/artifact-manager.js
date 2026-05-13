import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
class ArtifactManager {
  #nextId = 0;
  #dir;
  #dirCreated = false;
  #initialized = false;
  /**
   * @param sessionFile Path to the session .jsonl file
   */
  constructor(sessionFile) {
    this.#dir = sessionFile.slice(0, -6);
  }
  /**
   * Artifact directory path.
   * Directory may not exist until first artifact is saved.
   */
  get dir() {
    return this.#dir;
  }
  #ensureDir() {
    if (!this.#dirCreated) {
      mkdirSync(this.#dir, { recursive: true });
      this.#dirCreated = true;
    }
    if (!this.#initialized) {
      this.#scanExistingIds();
      this.#initialized = true;
    }
  }
  /**
   * Scan existing artifact files to find the next available ID.
   * Ensures we don't overwrite artifacts when resuming a session.
   */
  #scanExistingIds() {
    const files = this.listFiles();
    let maxId = -1;
    for (const file of files) {
      const match = file.match(/^(\d+)\..*\.log$/);
      if (match) {
        const id = parseInt(match[1], 10);
        if (id > maxId) maxId = id;
      }
    }
    this.#nextId = maxId + 1;
  }
  /** Atomically allocate next artifact ID. */
  allocateId() {
    return this.#nextId++;
  }
  /**
   * Allocate a new artifact path and ID without writing content.
   * @param toolType Tool name for file extension (e.g., "bash", "fetch")
   */
  allocatePath(toolType) {
    this.#ensureDir();
    const id = String(this.allocateId());
    const filename = `${id}.${toolType}.log`;
    return { id, path: join(this.#dir, filename) };
  }
  /**
   * Save content as an artifact and return the artifact ID.
   * @param content Full content to save
   * @param toolType Tool name for file extension (e.g., "bash", "fetch")
   * @returns Artifact ID (numeric string)
   */
  save(content, toolType) {
    const { id, path } = this.allocatePath(toolType);
    writeFileSync(path, content);
    return id;
  }
  /**
   * Check if an artifact exists.
   * @param id Artifact ID (numeric string)
   */
  exists(id) {
    const files = this.listFiles();
    return files.some((f) => f.startsWith(`${id}.`));
  }
  /**
   * List all artifact files in the directory.
   * Returns empty array if directory doesn't exist.
   */
  listFiles() {
    try {
      return readdirSync(this.#dir);
    } catch {
      return [];
    }
  }
  /**
   * Get the full path to an artifact file.
   * Returns null if artifact doesn't exist.
   * @param id Artifact ID (numeric string)
   */
  getPath(id) {
    const files = this.listFiles();
    const match = files.find((f) => f.startsWith(`${id}.`));
    return match ? join(this.#dir, match) : null;
  }
}
export {
  ArtifactManager
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2FydGlmYWN0LW1hbmFnZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogU2Vzc2lvbi1zY29wZWQgYXJ0aWZhY3Qgc3RvcmFnZSBmb3IgdHJ1bmNhdGVkIHRvb2wgb3V0cHV0cy5cbiAqXG4gKiBBcnRpZmFjdHMgYXJlIHN0b3JlZCBpbiBhIGRpcmVjdG9yeSBhbG9uZ3NpZGUgdGhlIHNlc3Npb24gZmlsZSxcbiAqIGFjY2Vzc2libGUgdmlhIGFydGlmYWN0Oi8vIFVSTHMuXG4gKi9cbmltcG9ydCB7IG1rZGlyU3luYywgcmVhZGRpclN5bmMsIHdyaXRlRmlsZVN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuLyoqXG4gKiBNYW5hZ2VzIGFydGlmYWN0IHN0b3JhZ2UgZm9yIGEgc2Vzc2lvbi5cbiAqXG4gKiBBcnRpZmFjdHMgYXJlIHN0b3JlZCB3aXRoIHNlcXVlbnRpYWwgSURzIGluIHRoZSBzZXNzaW9uJ3MgYXJ0aWZhY3QgZGlyZWN0b3J5LlxuICogVGhlIGRpcmVjdG9yeSBpcyBjcmVhdGVkIGxhemlseSBvbiBmaXJzdCB3cml0ZS5cbiAqL1xuZXhwb3J0IGNsYXNzIEFydGlmYWN0TWFuYWdlciB7XG5cdCNuZXh0SWQgPSAwO1xuXHRyZWFkb25seSAjZGlyOiBzdHJpbmc7XG5cdCNkaXJDcmVhdGVkID0gZmFsc2U7XG5cdCNpbml0aWFsaXplZCA9IGZhbHNlO1xuXG5cdC8qKlxuXHQgKiBAcGFyYW0gc2Vzc2lvbkZpbGUgUGF0aCB0byB0aGUgc2Vzc2lvbiAuanNvbmwgZmlsZVxuXHQgKi9cblx0Y29uc3RydWN0b3Ioc2Vzc2lvbkZpbGU6IHN0cmluZykge1xuXHRcdC8vIEFydGlmYWN0IGRpcmVjdG9yeSBpcyBzZXNzaW9uIGZpbGUgcGF0aCB3aXRob3V0IC5qc29ubCBleHRlbnNpb25cblx0XHR0aGlzLiNkaXIgPSBzZXNzaW9uRmlsZS5zbGljZSgwLCAtNik7XG5cdH1cblxuXHQvKipcblx0ICogQXJ0aWZhY3QgZGlyZWN0b3J5IHBhdGguXG5cdCAqIERpcmVjdG9yeSBtYXkgbm90IGV4aXN0IHVudGlsIGZpcnN0IGFydGlmYWN0IGlzIHNhdmVkLlxuXHQgKi9cblx0Z2V0IGRpcigpOiBzdHJpbmcge1xuXHRcdHJldHVybiB0aGlzLiNkaXI7XG5cdH1cblxuXHQjZW5zdXJlRGlyKCk6IHZvaWQge1xuXHRcdGlmICghdGhpcy4jZGlyQ3JlYXRlZCkge1xuXHRcdFx0bWtkaXJTeW5jKHRoaXMuI2RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cdFx0XHR0aGlzLiNkaXJDcmVhdGVkID0gdHJ1ZTtcblx0XHR9XG5cdFx0aWYgKCF0aGlzLiNpbml0aWFsaXplZCkge1xuXHRcdFx0dGhpcy4jc2NhbkV4aXN0aW5nSWRzKCk7XG5cdFx0XHR0aGlzLiNpbml0aWFsaXplZCA9IHRydWU7XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIFNjYW4gZXhpc3RpbmcgYXJ0aWZhY3QgZmlsZXMgdG8gZmluZCB0aGUgbmV4dCBhdmFpbGFibGUgSUQuXG5cdCAqIEVuc3VyZXMgd2UgZG9uJ3Qgb3ZlcndyaXRlIGFydGlmYWN0cyB3aGVuIHJlc3VtaW5nIGEgc2Vzc2lvbi5cblx0ICovXG5cdCNzY2FuRXhpc3RpbmdJZHMoKTogdm9pZCB7XG5cdFx0Y29uc3QgZmlsZXMgPSB0aGlzLmxpc3RGaWxlcygpO1xuXHRcdGxldCBtYXhJZCA9IC0xO1xuXHRcdGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xuXHRcdFx0Y29uc3QgbWF0Y2ggPSBmaWxlLm1hdGNoKC9eKFxcZCspXFwuLipcXC5sb2ckLyk7XG5cdFx0XHRpZiAobWF0Y2gpIHtcblx0XHRcdFx0Y29uc3QgaWQgPSBwYXJzZUludChtYXRjaFsxXSwgMTApO1xuXHRcdFx0XHRpZiAoaWQgPiBtYXhJZCkgbWF4SWQgPSBpZDtcblx0XHRcdH1cblx0XHR9XG5cdFx0dGhpcy4jbmV4dElkID0gbWF4SWQgKyAxO1xuXHR9XG5cblx0LyoqIEF0b21pY2FsbHkgYWxsb2NhdGUgbmV4dCBhcnRpZmFjdCBJRC4gKi9cblx0YWxsb2NhdGVJZCgpOiBudW1iZXIge1xuXHRcdHJldHVybiB0aGlzLiNuZXh0SWQrKztcblx0fVxuXG5cdC8qKlxuXHQgKiBBbGxvY2F0ZSBhIG5ldyBhcnRpZmFjdCBwYXRoIGFuZCBJRCB3aXRob3V0IHdyaXRpbmcgY29udGVudC5cblx0ICogQHBhcmFtIHRvb2xUeXBlIFRvb2wgbmFtZSBmb3IgZmlsZSBleHRlbnNpb24gKGUuZy4sIFwiYmFzaFwiLCBcImZldGNoXCIpXG5cdCAqL1xuXHRhbGxvY2F0ZVBhdGgodG9vbFR5cGU6IHN0cmluZyk6IHsgaWQ6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0ge1xuXHRcdHRoaXMuI2Vuc3VyZURpcigpO1xuXHRcdGNvbnN0IGlkID0gU3RyaW5nKHRoaXMuYWxsb2NhdGVJZCgpKTtcblx0XHRjb25zdCBmaWxlbmFtZSA9IGAke2lkfS4ke3Rvb2xUeXBlfS5sb2dgO1xuXHRcdHJldHVybiB7IGlkLCBwYXRoOiBqb2luKHRoaXMuI2RpciwgZmlsZW5hbWUpIH07XG5cdH1cblxuXHQvKipcblx0ICogU2F2ZSBjb250ZW50IGFzIGFuIGFydGlmYWN0IGFuZCByZXR1cm4gdGhlIGFydGlmYWN0IElELlxuXHQgKiBAcGFyYW0gY29udGVudCBGdWxsIGNvbnRlbnQgdG8gc2F2ZVxuXHQgKiBAcGFyYW0gdG9vbFR5cGUgVG9vbCBuYW1lIGZvciBmaWxlIGV4dGVuc2lvbiAoZS5nLiwgXCJiYXNoXCIsIFwiZmV0Y2hcIilcblx0ICogQHJldHVybnMgQXJ0aWZhY3QgSUQgKG51bWVyaWMgc3RyaW5nKVxuXHQgKi9cblx0c2F2ZShjb250ZW50OiBzdHJpbmcsIHRvb2xUeXBlOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdGNvbnN0IHsgaWQsIHBhdGggfSA9IHRoaXMuYWxsb2NhdGVQYXRoKHRvb2xUeXBlKTtcblx0XHR3cml0ZUZpbGVTeW5jKHBhdGgsIGNvbnRlbnQpO1xuXHRcdHJldHVybiBpZDtcblx0fVxuXG5cdC8qKlxuXHQgKiBDaGVjayBpZiBhbiBhcnRpZmFjdCBleGlzdHMuXG5cdCAqIEBwYXJhbSBpZCBBcnRpZmFjdCBJRCAobnVtZXJpYyBzdHJpbmcpXG5cdCAqL1xuXHRleGlzdHMoaWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRcdGNvbnN0IGZpbGVzID0gdGhpcy5saXN0RmlsZXMoKTtcblx0XHRyZXR1cm4gZmlsZXMuc29tZSgoZikgPT4gZi5zdGFydHNXaXRoKGAke2lkfS5gKSk7XG5cdH1cblxuXHQvKipcblx0ICogTGlzdCBhbGwgYXJ0aWZhY3QgZmlsZXMgaW4gdGhlIGRpcmVjdG9yeS5cblx0ICogUmV0dXJucyBlbXB0eSBhcnJheSBpZiBkaXJlY3RvcnkgZG9lc24ndCBleGlzdC5cblx0ICovXG5cdGxpc3RGaWxlcygpOiBzdHJpbmdbXSB7XG5cdFx0dHJ5IHtcblx0XHRcdHJldHVybiByZWFkZGlyU3luYyh0aGlzLiNkaXIpO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0cmV0dXJuIFtdO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgdGhlIGZ1bGwgcGF0aCB0byBhbiBhcnRpZmFjdCBmaWxlLlxuXHQgKiBSZXR1cm5zIG51bGwgaWYgYXJ0aWZhY3QgZG9lc24ndCBleGlzdC5cblx0ICogQHBhcmFtIGlkIEFydGlmYWN0IElEIChudW1lcmljIHN0cmluZylcblx0ICovXG5cdGdldFBhdGgoaWQ6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuXHRcdGNvbnN0IGZpbGVzID0gdGhpcy5saXN0RmlsZXMoKTtcblx0XHRjb25zdCBtYXRjaCA9IGZpbGVzLmZpbmQoKGYpID0+IGYuc3RhcnRzV2l0aChgJHtpZH0uYCkpO1xuXHRcdHJldHVybiBtYXRjaCA/IGpvaW4odGhpcy4jZGlyLCBtYXRjaCkgOiBudWxsO1xuXHR9XG59XG4i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
