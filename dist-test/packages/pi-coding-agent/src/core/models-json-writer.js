import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.js";
class ModelsJsonWriter {
  constructor(modelsJsonPath) {
    this.modelsJsonPath = modelsJsonPath ?? join(getAgentDir(), "models.json");
  }
  /**
   * Add a model to a provider. Creates the provider if it doesn't exist.
   */
  addModel(provider, model, providerConfig) {
    this.withLock((config) => {
      if (!config.providers[provider]) {
        config.providers[provider] = {
          ...providerConfig,
          models: []
        };
      }
      const providerEntry = config.providers[provider];
      if (!providerEntry.models) {
        providerEntry.models = [];
      }
      const existingIndex = providerEntry.models.findIndex((m) => m.id === model.id);
      if (existingIndex >= 0) {
        providerEntry.models[existingIndex] = model;
      } else {
        providerEntry.models.push(model);
      }
      return config;
    });
  }
  /**
   * Remove a model from a provider. Removes the provider if no models remain.
   */
  removeModel(provider, modelId) {
    this.withLock((config) => {
      const providerEntry = config.providers[provider];
      if (!providerEntry?.models) return config;
      providerEntry.models = providerEntry.models.filter((m) => m.id !== modelId);
      if (providerEntry.models.length === 0 && !providerEntry.modelOverrides) {
        delete config.providers[provider];
      }
      return config;
    });
  }
  /**
   * Set or update an entire provider configuration.
   */
  setProvider(provider, providerConfig) {
    this.withLock((config) => {
      config.providers[provider] = providerConfig;
      return config;
    });
  }
  /**
   * Remove a provider and all its models.
   */
  removeProvider(provider) {
    this.withLock((config) => {
      delete config.providers[provider];
      return config;
    });
  }
  /**
   * List all providers and their configurations.
   */
  listProviders() {
    return this.readConfig();
  }
  readConfig() {
    if (!existsSync(this.modelsJsonPath)) {
      return { providers: {} };
    }
    try {
      const content = readFileSync(this.modelsJsonPath, "utf-8");
      return JSON.parse(content);
    } catch {
      return { providers: {} };
    }
  }
  writeConfig(config) {
    const dir = dirname(this.modelsJsonPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.modelsJsonPath, JSON.stringify(config, null, 2), "utf-8");
  }
  acquireLockWithRetry() {
    const maxAttempts = 10;
    const delayMs = 20;
    let lastError;
    const dir = dirname(this.modelsJsonPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(this.modelsJsonPath)) {
      writeFileSync(this.modelsJsonPath, JSON.stringify({ providers: {} }, null, 2), "utf-8");
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return lockfile.lockSync(this.modelsJsonPath, { realpath: false });
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : void 0;
        if (code !== "ELOCKED" || attempt === maxAttempts) {
          throw error;
        }
        lastError = error;
        const start = Date.now();
        while (Date.now() - start < delayMs) {
        }
      }
    }
    throw lastError ?? new Error("Failed to acquire models.json lock");
  }
  withLock(fn) {
    let release;
    try {
      release = this.acquireLockWithRetry();
      const config = this.readConfig();
      const updated = fn(config);
      this.writeConfig(updated);
    } finally {
      if (release) {
        release();
      }
    }
  }
}
export {
  ModelsJsonWriter
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL21vZGVscy1qc29uLXdyaXRlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBTYWZlIHJlYWQtbW9kaWZ5LXdyaXRlIGZvciBtb2RlbHMuanNvbiB3aXRoIGZpbGUgbG9ja2luZy5cbiAqIFByZXZlbnRzIGNvbmN1cnJlbnQgd3JpdGVzIGZyb20gY29ycnVwdGluZyB0aGUgY29uZmlnIGZpbGUuXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwiZnNcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwicGF0aFwiO1xuaW1wb3J0IGxvY2tmaWxlIGZyb20gXCJwcm9wZXItbG9ja2ZpbGVcIjtcbmltcG9ydCB7IGdldEFnZW50RGlyIH0gZnJvbSBcIi4uL2NvbmZpZy5qc1wiO1xuXG5pbnRlcmZhY2UgTW9kZWxEZWZpbml0aW9uIHtcblx0aWQ6IHN0cmluZztcblx0bmFtZT86IHN0cmluZztcblx0YXBpPzogc3RyaW5nO1xuXHRiYXNlVXJsPzogc3RyaW5nO1xuXHRyZWFzb25pbmc/OiBib29sZWFuO1xuXHRpbnB1dD86IChcInRleHRcIiB8IFwiaW1hZ2VcIilbXTtcblx0Y29zdD86IHsgaW5wdXQ6IG51bWJlcjsgb3V0cHV0OiBudW1iZXI7IGNhY2hlUmVhZDogbnVtYmVyOyBjYWNoZVdyaXRlOiBudW1iZXIgfTtcblx0Y29udGV4dFdpbmRvdz86IG51bWJlcjtcblx0bWF4VG9rZW5zPzogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgUHJvdmlkZXJDb25maWcge1xuXHRiYXNlVXJsPzogc3RyaW5nO1xuXHRhcGlLZXk/OiBzdHJpbmc7XG5cdGFwaT86IHN0cmluZztcblx0aGVhZGVycz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cdGF1dGhIZWFkZXI/OiBib29sZWFuO1xuXHRtb2RlbHM/OiBNb2RlbERlZmluaXRpb25bXTtcblx0bW9kZWxPdmVycmlkZXM/OiBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG59XG5cbmludGVyZmFjZSBNb2RlbHNDb25maWcge1xuXHRwcm92aWRlcnM6IFJlY29yZDxzdHJpbmcsIFByb3ZpZGVyQ29uZmlnPjtcbn1cblxuZXhwb3J0IGNsYXNzIE1vZGVsc0pzb25Xcml0ZXIge1xuXHRwcml2YXRlIG1vZGVsc0pzb25QYXRoOiBzdHJpbmc7XG5cblx0Y29uc3RydWN0b3IobW9kZWxzSnNvblBhdGg/OiBzdHJpbmcpIHtcblx0XHR0aGlzLm1vZGVsc0pzb25QYXRoID0gbW9kZWxzSnNvblBhdGggPz8gam9pbihnZXRBZ2VudERpcigpLCBcIm1vZGVscy5qc29uXCIpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEFkZCBhIG1vZGVsIHRvIGEgcHJvdmlkZXIuIENyZWF0ZXMgdGhlIHByb3ZpZGVyIGlmIGl0IGRvZXNuJ3QgZXhpc3QuXG5cdCAqL1xuXHRhZGRNb2RlbChwcm92aWRlcjogc3RyaW5nLCBtb2RlbDogTW9kZWxEZWZpbml0aW9uLCBwcm92aWRlckNvbmZpZz86IFBhcnRpYWw8UHJvdmlkZXJDb25maWc+KTogdm9pZCB7XG5cdFx0dGhpcy53aXRoTG9jaygoY29uZmlnKSA9PiB7XG5cdFx0XHRpZiAoIWNvbmZpZy5wcm92aWRlcnNbcHJvdmlkZXJdKSB7XG5cdFx0XHRcdGNvbmZpZy5wcm92aWRlcnNbcHJvdmlkZXJdID0ge1xuXHRcdFx0XHRcdC4uLnByb3ZpZGVyQ29uZmlnLFxuXHRcdFx0XHRcdG1vZGVsczogW10sXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHByb3ZpZGVyRW50cnkgPSBjb25maWcucHJvdmlkZXJzW3Byb3ZpZGVyXTtcblx0XHRcdGlmICghcHJvdmlkZXJFbnRyeS5tb2RlbHMpIHtcblx0XHRcdFx0cHJvdmlkZXJFbnRyeS5tb2RlbHMgPSBbXTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gUmVwbGFjZSBleGlzdGluZyBtb2RlbCB3aXRoIHNhbWUgaWQsIG9yIGFwcGVuZFxuXHRcdFx0Y29uc3QgZXhpc3RpbmdJbmRleCA9IHByb3ZpZGVyRW50cnkubW9kZWxzLmZpbmRJbmRleCgobSkgPT4gbS5pZCA9PT0gbW9kZWwuaWQpO1xuXHRcdFx0aWYgKGV4aXN0aW5nSW5kZXggPj0gMCkge1xuXHRcdFx0XHRwcm92aWRlckVudHJ5Lm1vZGVsc1tleGlzdGluZ0luZGV4XSA9IG1vZGVsO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0cHJvdmlkZXJFbnRyeS5tb2RlbHMucHVzaChtb2RlbCk7XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiBjb25maWc7XG5cdFx0fSk7XG5cdH1cblxuXHQvKipcblx0ICogUmVtb3ZlIGEgbW9kZWwgZnJvbSBhIHByb3ZpZGVyLiBSZW1vdmVzIHRoZSBwcm92aWRlciBpZiBubyBtb2RlbHMgcmVtYWluLlxuXHQgKi9cblx0cmVtb3ZlTW9kZWwocHJvdmlkZXI6IHN0cmluZywgbW9kZWxJZDogc3RyaW5nKTogdm9pZCB7XG5cdFx0dGhpcy53aXRoTG9jaygoY29uZmlnKSA9PiB7XG5cdFx0XHRjb25zdCBwcm92aWRlckVudHJ5ID0gY29uZmlnLnByb3ZpZGVyc1twcm92aWRlcl07XG5cdFx0XHRpZiAoIXByb3ZpZGVyRW50cnk/Lm1vZGVscykgcmV0dXJuIGNvbmZpZztcblxuXHRcdFx0cHJvdmlkZXJFbnRyeS5tb2RlbHMgPSBwcm92aWRlckVudHJ5Lm1vZGVscy5maWx0ZXIoKG0pID0+IG0uaWQgIT09IG1vZGVsSWQpO1xuXG5cdFx0XHQvLyBDbGVhbiB1cCBlbXB0eSBwcm92aWRlciAobm8gbW9kZWxzIGFuZCBubyBvdmVycmlkZXMpXG5cdFx0XHRpZiAocHJvdmlkZXJFbnRyeS5tb2RlbHMubGVuZ3RoID09PSAwICYmICFwcm92aWRlckVudHJ5Lm1vZGVsT3ZlcnJpZGVzKSB7XG5cdFx0XHRcdGRlbGV0ZSBjb25maWcucHJvdmlkZXJzW3Byb3ZpZGVyXTtcblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIGNvbmZpZztcblx0XHR9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgb3IgdXBkYXRlIGFuIGVudGlyZSBwcm92aWRlciBjb25maWd1cmF0aW9uLlxuXHQgKi9cblx0c2V0UHJvdmlkZXIocHJvdmlkZXI6IHN0cmluZywgcHJvdmlkZXJDb25maWc6IFByb3ZpZGVyQ29uZmlnKTogdm9pZCB7XG5cdFx0dGhpcy53aXRoTG9jaygoY29uZmlnKSA9PiB7XG5cdFx0XHRjb25maWcucHJvdmlkZXJzW3Byb3ZpZGVyXSA9IHByb3ZpZGVyQ29uZmlnO1xuXHRcdFx0cmV0dXJuIGNvbmZpZztcblx0XHR9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBSZW1vdmUgYSBwcm92aWRlciBhbmQgYWxsIGl0cyBtb2RlbHMuXG5cdCAqL1xuXHRyZW1vdmVQcm92aWRlcihwcm92aWRlcjogc3RyaW5nKTogdm9pZCB7XG5cdFx0dGhpcy53aXRoTG9jaygoY29uZmlnKSA9PiB7XG5cdFx0XHRkZWxldGUgY29uZmlnLnByb3ZpZGVyc1twcm92aWRlcl07XG5cdFx0XHRyZXR1cm4gY29uZmlnO1xuXHRcdH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIExpc3QgYWxsIHByb3ZpZGVycyBhbmQgdGhlaXIgY29uZmlndXJhdGlvbnMuXG5cdCAqL1xuXHRsaXN0UHJvdmlkZXJzKCk6IE1vZGVsc0NvbmZpZyB7XG5cdFx0cmV0dXJuIHRoaXMucmVhZENvbmZpZygpO1xuXHR9XG5cblx0cHJpdmF0ZSByZWFkQ29uZmlnKCk6IE1vZGVsc0NvbmZpZyB7XG5cdFx0aWYgKCFleGlzdHNTeW5jKHRoaXMubW9kZWxzSnNvblBhdGgpKSB7XG5cdFx0XHRyZXR1cm4geyBwcm92aWRlcnM6IHt9IH07XG5cdFx0fVxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKHRoaXMubW9kZWxzSnNvblBhdGgsIFwidXRmLThcIik7XG5cdFx0XHRyZXR1cm4gSlNPTi5wYXJzZShjb250ZW50KSBhcyBNb2RlbHNDb25maWc7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHRyZXR1cm4geyBwcm92aWRlcnM6IHt9IH07XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSB3cml0ZUNvbmZpZyhjb25maWc6IE1vZGVsc0NvbmZpZyk6IHZvaWQge1xuXHRcdGNvbnN0IGRpciA9IGRpcm5hbWUodGhpcy5tb2RlbHNKc29uUGF0aCk7XG5cdFx0aWYgKCFleGlzdHNTeW5jKGRpcikpIHtcblx0XHRcdG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXHRcdH1cblx0XHR3cml0ZUZpbGVTeW5jKHRoaXMubW9kZWxzSnNvblBhdGgsIEpTT04uc3RyaW5naWZ5KGNvbmZpZywgbnVsbCwgMiksIFwidXRmLThcIik7XG5cdH1cblxuXHRwcml2YXRlIGFjcXVpcmVMb2NrV2l0aFJldHJ5KCk6ICgpID0+IHZvaWQge1xuXHRcdGNvbnN0IG1heEF0dGVtcHRzID0gMTA7XG5cdFx0Y29uc3QgZGVsYXlNcyA9IDIwO1xuXHRcdGxldCBsYXN0RXJyb3I6IHVua25vd247XG5cblx0XHQvLyBFbnN1cmUgZmlsZSBleGlzdHMgZm9yIGxvY2tpbmdcblx0XHRjb25zdCBkaXIgPSBkaXJuYW1lKHRoaXMubW9kZWxzSnNvblBhdGgpO1xuXHRcdGlmICghZXhpc3RzU3luYyhkaXIpKSB7XG5cdFx0XHRta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHR9XG5cdFx0aWYgKCFleGlzdHNTeW5jKHRoaXMubW9kZWxzSnNvblBhdGgpKSB7XG5cdFx0XHR3cml0ZUZpbGVTeW5jKHRoaXMubW9kZWxzSnNvblBhdGgsIEpTT04uc3RyaW5naWZ5KHsgcHJvdmlkZXJzOiB7fSB9LCBudWxsLCAyKSwgXCJ1dGYtOFwiKTtcblx0XHR9XG5cblx0XHRmb3IgKGxldCBhdHRlbXB0ID0gMTsgYXR0ZW1wdCA8PSBtYXhBdHRlbXB0czsgYXR0ZW1wdCsrKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRyZXR1cm4gbG9ja2ZpbGUubG9ja1N5bmModGhpcy5tb2RlbHNKc29uUGF0aCwgeyByZWFscGF0aDogZmFsc2UgfSk7XG5cdFx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0XHRjb25zdCBjb2RlID1cblx0XHRcdFx0XHR0eXBlb2YgZXJyb3IgPT09IFwib2JqZWN0XCIgJiYgZXJyb3IgIT09IG51bGwgJiYgXCJjb2RlXCIgaW4gZXJyb3Jcblx0XHRcdFx0XHRcdD8gU3RyaW5nKChlcnJvciBhcyB7IGNvZGU/OiB1bmtub3duIH0pLmNvZGUpXG5cdFx0XHRcdFx0XHQ6IHVuZGVmaW5lZDtcblx0XHRcdFx0aWYgKGNvZGUgIT09IFwiRUxPQ0tFRFwiIHx8IGF0dGVtcHQgPT09IG1heEF0dGVtcHRzKSB7XG5cdFx0XHRcdFx0dGhyb3cgZXJyb3I7XG5cdFx0XHRcdH1cblx0XHRcdFx0bGFzdEVycm9yID0gZXJyb3I7XG5cdFx0XHRcdGNvbnN0IHN0YXJ0ID0gRGF0ZS5ub3coKTtcblx0XHRcdFx0d2hpbGUgKERhdGUubm93KCkgLSBzdGFydCA8IGRlbGF5TXMpIHtcblx0XHRcdFx0XHQvLyBCdXN5LXdhaXQgKHNhbWUgcGF0dGVybiBhcyBhdXRoLXN0b3JhZ2UudHMpXG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHR0aHJvdyAobGFzdEVycm9yIGFzIEVycm9yKSA/PyBuZXcgRXJyb3IoXCJGYWlsZWQgdG8gYWNxdWlyZSBtb2RlbHMuanNvbiBsb2NrXCIpO1xuXHR9XG5cblx0cHJpdmF0ZSB3aXRoTG9jayhmbjogKGNvbmZpZzogTW9kZWxzQ29uZmlnKSA9PiBNb2RlbHNDb25maWcpOiB2b2lkIHtcblx0XHRsZXQgcmVsZWFzZTogKCgpID0+IHZvaWQpIHwgdW5kZWZpbmVkO1xuXHRcdHRyeSB7XG5cdFx0XHRyZWxlYXNlID0gdGhpcy5hY3F1aXJlTG9ja1dpdGhSZXRyeSgpO1xuXHRcdFx0Y29uc3QgY29uZmlnID0gdGhpcy5yZWFkQ29uZmlnKCk7XG5cdFx0XHRjb25zdCB1cGRhdGVkID0gZm4oY29uZmlnKTtcblx0XHRcdHRoaXMud3JpdGVDb25maWcodXBkYXRlZCk7XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdGlmIChyZWxlYXNlKSB7XG5cdFx0XHRcdHJlbGVhc2UoKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUtBLFNBQVMsWUFBWSxXQUFXLGNBQWMscUJBQXFCO0FBQ25FLFNBQVMsU0FBUyxZQUFZO0FBQzlCLE9BQU8sY0FBYztBQUNyQixTQUFTLG1CQUFtQjtBQTRCckIsTUFBTSxpQkFBaUI7QUFBQSxFQUc3QixZQUFZLGdCQUF5QjtBQUNwQyxTQUFLLGlCQUFpQixrQkFBa0IsS0FBSyxZQUFZLEdBQUcsYUFBYTtBQUFBLEVBQzFFO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFLQSxTQUFTLFVBQWtCLE9BQXdCLGdCQUFnRDtBQUNsRyxTQUFLLFNBQVMsQ0FBQyxXQUFXO0FBQ3pCLFVBQUksQ0FBQyxPQUFPLFVBQVUsUUFBUSxHQUFHO0FBQ2hDLGVBQU8sVUFBVSxRQUFRLElBQUk7QUFBQSxVQUM1QixHQUFHO0FBQUEsVUFDSCxRQUFRLENBQUM7QUFBQSxRQUNWO0FBQUEsTUFDRDtBQUVBLFlBQU0sZ0JBQWdCLE9BQU8sVUFBVSxRQUFRO0FBQy9DLFVBQUksQ0FBQyxjQUFjLFFBQVE7QUFDMUIsc0JBQWMsU0FBUyxDQUFDO0FBQUEsTUFDekI7QUFHQSxZQUFNLGdCQUFnQixjQUFjLE9BQU8sVUFBVSxDQUFDLE1BQU0sRUFBRSxPQUFPLE1BQU0sRUFBRTtBQUM3RSxVQUFJLGlCQUFpQixHQUFHO0FBQ3ZCLHNCQUFjLE9BQU8sYUFBYSxJQUFJO0FBQUEsTUFDdkMsT0FBTztBQUNOLHNCQUFjLE9BQU8sS0FBSyxLQUFLO0FBQUEsTUFDaEM7QUFFQSxhQUFPO0FBQUEsSUFDUixDQUFDO0FBQUEsRUFDRjtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBS0EsWUFBWSxVQUFrQixTQUF1QjtBQUNwRCxTQUFLLFNB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
