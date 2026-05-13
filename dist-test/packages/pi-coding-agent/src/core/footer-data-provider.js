import { existsSync, readFileSync, statSync, watch } from "fs";
import { dirname, join, resolve } from "path";
function findGitHeadPath() {
  let dir = process.cwd();
  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isFile()) {
          const content = readFileSync(gitPath, "utf8").trim();
          if (content.startsWith("gitdir: ")) {
            const gitDir = content.slice(8);
            const headPath = resolve(dir, gitDir, "HEAD");
            if (existsSync(headPath)) return headPath;
          }
        } else if (stat.isDirectory()) {
          const headPath = join(gitPath, "HEAD");
          if (existsSync(headPath)) return headPath;
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
class FooterDataProvider {
  constructor() {
    this.extensionStatuses = /* @__PURE__ */ new Map();
    this.cachedBranch = void 0;
    this.gitWatcher = null;
    this.branchChangeCallbacks = /* @__PURE__ */ new Set();
    this.availableProviderCount = 0;
    this.setupGitWatcher();
  }
  /** Current git branch, null if not in repo, "detached" if detached HEAD */
  getGitBranch() {
    if (this.cachedBranch !== void 0) return this.cachedBranch;
    try {
      const gitHeadPath = findGitHeadPath();
      if (!gitHeadPath) {
        this.cachedBranch = null;
        return null;
      }
      const content = readFileSync(gitHeadPath, "utf8").trim();
      this.cachedBranch = content.startsWith("ref: refs/heads/") ? content.slice(16) : "detached";
    } catch {
      this.cachedBranch = null;
    }
    return this.cachedBranch;
  }
  /** Extension status texts set via ctx.ui.setStatus() */
  getExtensionStatuses() {
    return this.extensionStatuses;
  }
  /** Subscribe to git branch changes. Returns unsubscribe function. */
  onBranchChange(callback) {
    this.branchChangeCallbacks.add(callback);
    return () => this.branchChangeCallbacks.delete(callback);
  }
  /** Internal: set extension status */
  setExtensionStatus(key, text) {
    if (text === void 0) {
      this.extensionStatuses.delete(key);
    } else {
      this.extensionStatuses.set(key, text);
    }
  }
  /** Internal: clear extension statuses */
  clearExtensionStatuses() {
    this.extensionStatuses.clear();
  }
  /** Number of unique providers with available models (for footer display) */
  getAvailableProviderCount() {
    return this.availableProviderCount;
  }
  /** Internal: update available provider count */
  setAvailableProviderCount(count) {
    this.availableProviderCount = count;
  }
  /** Internal: cleanup */
  dispose() {
    if (this.gitWatcher) {
      this.gitWatcher.close();
      this.gitWatcher = null;
    }
    this.branchChangeCallbacks.clear();
  }
  setupGitWatcher() {
    if (this.gitWatcher) {
      this.gitWatcher.close();
      this.gitWatcher = null;
    }
    const gitHeadPath = findGitHeadPath();
    if (!gitHeadPath) return;
    const gitDir = dirname(gitHeadPath);
    try {
      this.gitWatcher = watch(gitDir, (_eventType, filename) => {
        if (filename === "HEAD") {
          this.cachedBranch = void 0;
          for (const cb of this.branchChangeCallbacks) cb();
        }
      });
    } catch {
    }
  }
}
export {
  FooterDataProvider
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2Zvb3Rlci1kYXRhLXByb3ZpZGVyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBleGlzdHNTeW5jLCB0eXBlIEZTV2F0Y2hlciwgcmVhZEZpbGVTeW5jLCBzdGF0U3luYywgd2F0Y2ggfSBmcm9tIFwiZnNcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4sIHJlc29sdmUgfSBmcm9tIFwicGF0aFwiO1xuXG4vKipcbiAqIEZpbmQgdGhlIGdpdCBIRUFEIHBhdGggYnkgd2Fsa2luZyB1cCBmcm9tIGN3ZC5cbiAqIEhhbmRsZXMgYm90aCByZWd1bGFyIGdpdCByZXBvcyAoLmdpdCBpcyBhIGRpcmVjdG9yeSkgYW5kIHdvcmt0cmVlcyAoLmdpdCBpcyBhIGZpbGUpLlxuICovXG5mdW5jdGlvbiBmaW5kR2l0SGVhZFBhdGgoKTogc3RyaW5nIHwgbnVsbCB7XG5cdGxldCBkaXIgPSBwcm9jZXNzLmN3ZCgpO1xuXHR3aGlsZSAodHJ1ZSkge1xuXHRcdGNvbnN0IGdpdFBhdGggPSBqb2luKGRpciwgXCIuZ2l0XCIpO1xuXHRcdGlmIChleGlzdHNTeW5jKGdpdFBhdGgpKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBzdGF0ID0gc3RhdFN5bmMoZ2l0UGF0aCk7XG5cdFx0XHRcdGlmIChzdGF0LmlzRmlsZSgpKSB7XG5cdFx0XHRcdFx0Y29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhnaXRQYXRoLCBcInV0ZjhcIikudHJpbSgpO1xuXHRcdFx0XHRcdGlmIChjb250ZW50LnN0YXJ0c1dpdGgoXCJnaXRkaXI6IFwiKSkge1xuXHRcdFx0XHRcdFx0Y29uc3QgZ2l0RGlyID0gY29udGVudC5zbGljZSg4KTtcblx0XHRcdFx0XHRcdGNvbnN0IGhlYWRQYXRoID0gcmVzb2x2ZShkaXIsIGdpdERpciwgXCJIRUFEXCIpO1xuXHRcdFx0XHRcdFx0aWYgKGV4aXN0c1N5bmMoaGVhZFBhdGgpKSByZXR1cm4gaGVhZFBhdGg7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9IGVsc2UgaWYgKHN0YXQuaXNEaXJlY3RvcnkoKSkge1xuXHRcdFx0XHRcdGNvbnN0IGhlYWRQYXRoID0gam9pbihnaXRQYXRoLCBcIkhFQURcIik7XG5cdFx0XHRcdFx0aWYgKGV4aXN0c1N5bmMoaGVhZFBhdGgpKSByZXR1cm4gaGVhZFBhdGg7XG5cdFx0XHRcdH1cblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRyZXR1cm4gbnVsbDtcblx0XHRcdH1cblx0XHR9XG5cdFx0Y29uc3QgcGFyZW50ID0gZGlybmFtZShkaXIpO1xuXHRcdGlmIChwYXJlbnQgPT09IGRpcikgcmV0dXJuIG51bGw7XG5cdFx0ZGlyID0gcGFyZW50O1xuXHR9XG59XG5cbi8qKlxuICogUHJvdmlkZXMgZ2l0IGJyYW5jaCBhbmQgZXh0ZW5zaW9uIHN0YXR1c2VzIC0gZGF0YSBub3Qgb3RoZXJ3aXNlIGFjY2Vzc2libGUgdG8gZXh0ZW5zaW9ucy5cbiAqIFRva2VuIHN0YXRzLCBtb2RlbCBpbmZvIGF2YWlsYWJsZSB2aWEgY3R4LnNlc3Npb25NYW5hZ2VyIGFuZCBjdHgubW9kZWwuXG4gKi9cbmV4cG9ydCBjbGFzcyBGb290ZXJEYXRhUHJvdmlkZXIge1xuXHRwcml2YXRlIGV4dGVuc2lvblN0YXR1c2VzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcblx0cHJpdmF0ZSBjYWNoZWRCcmFuY2g6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQgPSB1bmRlZmluZWQ7XG5cdHByaXZhdGUgZ2l0V2F0Y2hlcjogRlNXYXRjaGVyIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgYnJhbmNoQ2hhbmdlQ2FsbGJhY2tzID0gbmV3IFNldDwoKSA9PiB2b2lkPigpO1xuXHRwcml2YXRlIGF2YWlsYWJsZVByb3ZpZGVyQ291bnQgPSAwO1xuXG5cdGNvbnN0cnVjdG9yKCkge1xuXHRcdHRoaXMuc2V0dXBHaXRXYXRjaGVyKCk7XG5cdH1cblxuXHQvKiogQ3VycmVudCBnaXQgYnJhbmNoLCBudWxsIGlmIG5vdCBpbiByZXBvLCBcImRldGFjaGVkXCIgaWYgZGV0YWNoZWQgSEVBRCAqL1xuXHRnZXRHaXRCcmFuY2goKTogc3RyaW5nIHwgbnVsbCB7XG5cdFx0aWYgKHRoaXMuY2FjaGVkQnJhbmNoICE9PSB1bmRlZmluZWQpIHJldHVybiB0aGlzLmNhY2hlZEJyYW5jaDtcblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBnaXRIZWFkUGF0aCA9IGZpbmRHaXRIZWFkUGF0aCgpO1xuXHRcdFx0aWYgKCFnaXRIZWFkUGF0aCkge1xuXHRcdFx0XHR0aGlzLmNhY2hlZEJyYW5jaCA9IG51bGw7XG5cdFx0XHRcdHJldHVybiBudWxsO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhnaXRIZWFkUGF0aCwgXCJ1dGY4XCIpLnRyaW0oKTtcblx0XHRcdHRoaXMuY2FjaGVkQnJhbmNoID0gY29udGVudC5zdGFydHNXaXRoKFwicmVmOiByZWZzL2hlYWRzL1wiKSA/IGNvbnRlbnQuc2xpY2UoMTYpIDogXCJkZXRhY2hlZFwiO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0dGhpcy5jYWNoZWRCcmFuY2ggPSBudWxsO1xuXHRcdH1cblx0XHRyZXR1cm4gdGhpcy5jYWNoZWRCcmFuY2g7XG5cdH1cblxuXHQvKiogRXh0ZW5zaW9uIHN0YXR1cyB0ZXh0cyBzZXQgdmlhIGN0eC51aS5zZXRTdGF0dXMoKSAqL1xuXHRnZXRFeHRlbnNpb25TdGF0dXNlcygpOiBSZWFkb25seU1hcDxzdHJpbmcsIHN0cmluZz4ge1xuXHRcdHJldHVybiB0aGlzLmV4dGVuc2lvblN0YXR1c2VzO1xuXHR9XG5cblx0LyoqIFN1YnNjcmliZSB0byBnaXQgYnJhbmNoIGNoYW5nZXMuIFJldHVybnMgdW5zdWJzY3JpYmUgZnVuY3Rpb24uICovXG5cdG9uQnJhbmNoQ2hhbmdlKGNhbGxiYWNrOiAoKSA9PiB2b2lkKTogKCkgPT4gdm9pZCB7XG5cdFx0dGhpcy5icmFuY2hDaGFuZ2VDYWxsYmFja3MuYWRkKGNhbGxiYWNrKTtcblx0XHRyZXR1cm4gKCkgPT4gdGhpcy5icmFuY2hDaGFuZ2VDYWxsYmFja3MuZGVsZXRlKGNhbGxiYWNrKTtcblx0fVxuXG5cdC8qKiBJbnRlcm5hbDogc2V0IGV4dGVuc2lvbiBzdGF0dXMgKi9cblx0c2V0RXh0ZW5zaW9uU3RhdHVzKGtleTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcgfCB1bmRlZmluZWQpOiB2b2lkIHtcblx0XHRpZiAodGV4dCA9PT0gdW5kZWZpbmVkKSB7XG5cdFx0XHR0aGlzLmV4dGVuc2lvblN0YXR1c2VzLmRlbGV0ZShrZXkpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLmV4dGVuc2lvblN0YXR1c2VzLnNldChrZXksIHRleHQpO1xuXHRcdH1cblx0fVxuXG5cdC8qKiBJbnRlcm5hbDogY2xlYXIgZXh0ZW5zaW9uIHN0YXR1c2VzICovXG5cdGNsZWFyRXh0ZW5zaW9uU3RhdHVzZXMoKTogdm9pZCB7XG5cdFx0dGhpcy5leHRlbnNpb25TdGF0dXNlcy5jbGVhcigpO1xuXHR9XG5cblx0LyoqIE51bWJlciBvZiB1bmlxdWUgcHJvdmlkZXJzIHdpdGggYXZhaWxhYmxlIG1vZGVscyAoZm9yIGZvb3RlciBkaXNwbGF5KSAqL1xuXHRnZXRBdmFpbGFibGVQcm92aWRlckNvdW50KCk6IG51bWJlciB7XG5cdFx0cmV0dXJuIHRoaXMuYXZhaWxhYmxlUHJvdmlkZXJDb3VudDtcblx0fVxuXG5cdC8qKiBJbnRlcm5hbDogdXBkYXRlIGF2YWlsYWJsZSBwcm92aWRlciBjb3VudCAqL1xuXHRzZXRBdmFpbGFibGVQcm92aWRlckNvdW50KGNvdW50OiBudW1iZXIpOiB2b2lkIHtcblx0XHR0aGlzLmF2YWlsYWJsZVByb3ZpZGVyQ291bnQgPSBjb3VudDtcblx0fVxuXG5cdC8qKiBJbnRlcm5hbDogY2xlYW51cCAqL1xuXHRkaXNwb3NlKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLmdpdFdhdGNoZXIpIHtcblx0XHRcdHRoaXMuZ2l0V2F0Y2hlci5jbG9zZSgpO1xuXHRcdFx0dGhpcy5naXRXYXRjaGVyID0gbnVsbDtcblx0XHR9XG5cdFx0dGhpcy5icmFuY2hDaGFuZ2VDYWxsYmFja3MuY2xlYXIoKTtcblx0fVxuXG5cdHByaXZhdGUgc2V0dXBHaXRXYXRjaGVyKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLmdpdFdhdGNoZXIpIHtcblx0XHRcdHRoaXMuZ2l0V2F0Y2hlci5jbG9zZSgpO1xuXHRcdFx0dGhpcy5naXRXYXRjaGVyID0gbnVsbDtcblx0XHR9XG5cblx0XHRjb25zdCBnaXRIZWFkUGF0aCA9IGZpbmRHaXRIZWFkUGF0aCgpO1xuXHRcdGlmICghZ2l0SGVhZFBhdGgpIHJldHVybjtcblxuXHRcdC8vIFdhdGNoIHRoZSBkaXJlY3RvcnkgY29udGFpbmluZyBIRUFELCBub3QgSEVBRCBpdHNlbGYuXG5cdFx0Ly8gR2l0IHVzZXMgYXRvbWljIHdyaXRlcyAod3JpdGUgdGVtcCwgcmVuYW1lIG92ZXIgSEVBRCksIHdoaWNoIGNoYW5nZXMgdGhlIGlub2RlLlxuXHRcdC8vIGZzLndhdGNoIG9uIGEgZmlsZSBzdG9wcyB3b3JraW5nIGFmdGVyIHRoZSBpbm9kZSBjaGFuZ2VzLlxuXHRcdGNvbnN0IGdpdERpciA9IGRpcm5hbWUoZ2l0SGVhZFBhdGgpO1xuXG5cdFx0dHJ5IHtcblx0XHRcdHRoaXMuZ2l0V2F0Y2hlciA9IHdhdGNoKGdpdERpciwgKF9ldmVudFR5cGUsIGZpbGVuYW1lKSA9PiB7XG5cdFx0XHRcdGlmIChmaWxlbmFtZSA9PT0gXCJIRUFEXCIpIHtcblx0XHRcdFx0XHR0aGlzLmNhY2hlZEJyYW5jaCA9IHVuZGVmaW5lZDtcblx0XHRcdFx0XHRmb3IgKGNvbnN0IGNiIG9mIHRoaXMuYnJhbmNoQ2hhbmdlQ2FsbGJhY2tzKSBjYigpO1xuXHRcdFx0XHR9XG5cdFx0XHR9KTtcblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIFNpbGVudGx5IGZhaWwgaWYgd2UgY2FuJ3Qgd2F0Y2hcblx0XHR9XG5cdH1cbn1cblxuLyoqIFJlYWQtb25seSB2aWV3IGZvciBleHRlbnNpb25zIC0gZXhjbHVkZXMgc2V0RXh0ZW5zaW9uU3RhdHVzLCBzZXRBdmFpbGFibGVQcm92aWRlckNvdW50IGFuZCBkaXNwb3NlICovXG5leHBvcnQgdHlwZSBSZWFkb25seUZvb3RlckRhdGFQcm92aWRlciA9IFBpY2s8XG5cdEZvb3RlckRhdGFQcm92aWRlcixcblx0XCJnZXRHaXRCcmFuY2hcIiB8IFwiZ2V0RXh0ZW5zaW9uU3RhdHVzZXNcIiB8IFwiZ2V0QXZhaWxhYmxlUHJvdmlkZXJDb3VudFwiIHwgXCJvbkJyYW5jaENoYW5nZVwiXG4+O1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxZQUE0QixjQUFjLFVBQVUsYUFBYTtBQUMxRSxTQUFTLFNBQVMsTUFBTSxlQUFlO0FBTXZDLFNBQVMsa0JBQWlDO0FBQ3pDLE1BQUksTUFBTSxRQUFRLElBQUk7QUFDdEIsU0FBTyxNQUFNO0FBQ1osVUFBTSxVQUFVLEtBQUssS0FBSyxNQUFNO0FBQ2hDLFFBQUksV0FBVyxPQUFPLEdBQUc7QUFDeEIsVUFBSTtBQUNILGNBQU0sT0FBTyxTQUFTLE9BQU87QUFDN0IsWUFBSSxLQUFLLE9BQU8sR0FBRztBQUNsQixnQkFBTSxVQUFVLGFBQWEsU0FBUyxNQUFNLEVBQUUsS0FBSztBQUNuRCxjQUFJLFFBQVEsV0FBVyxVQUFVLEdBQUc7QUFDbkMsa0JBQU0sU0FBUyxRQUFRLE1BQU0sQ0FBQztBQUM5QixrQkFBTSxXQUFXLFFBQVEsS0FBSyxRQUFRLE1BQU07QUFDNUMsZ0JBQUksV0FBVyxRQUFRLEVBQUcsUUFBTztBQUFBLFVBQ2xDO0FBQUEsUUFDRCxXQUFXLEtBQUssWUFBWSxHQUFHO0FBQzlCLGdCQUFNLFdBQVcsS0FBSyxTQUFTLE1BQU07QUFDckMsY0FBSSxXQUFXLFFBQVEsRUFBRyxRQUFPO0FBQUEsUUFDbEM7QUFBQSxNQUNELFFBQVE7QUFDUCxlQUFPO0FBQUEsTUFDUjtBQUFBLElBQ0Q7QUFDQSxVQUFNLFNBQVMsUUFBUSxHQUFHO0FBQzFCLFFBQUksV0FBVyxJQUFLLFFBQU87QUFDM0IsVUFBTTtBQUFBLEVBQ1A7QUFDRDtBQU1PLE1BQU0sbUJBQW1CO0FBQUEsRUFPL0IsY0FBYztBQU5kLFNBQVEsb0JBQW9CLG9CQUFJLElBQW9CO0FBQ3BELFNBQVEsZUFBMEM7QUFDbEQsU0FBUSxhQUErQjtBQUN2QyxTQUFRLHdCQUF3QixvQkFBSSxJQUFnQjtBQUNwRCxTQUFRLHlCQUF5QjtBQUdoQyxTQUFLLGdCQUFnQjtBQUFBLEVBQ3RCO0FBQUE7QUFBQSxFQUdBLGVBQThCO0FBQzdCLFFBQUksS0FBSyxpQkFBaUIsT0FBVyxRQUFPLEtBQUs7QUFFakQsUUFBSTtBQUNILFlBQU0sY0FBYyxnQkFBZ0I7QUFDcEMsVUFBSSxDQUFDLGFBQWE7QUFDakIsYUFBSyxlQUFlO0FBQ3BCLGVBQU87QUFBQSxNQUNSO0FBQ0EsWUFBTSxVQUFVLGFBQWEsYUFBYSxNQUFNLEVBQUUsS0FBSztBQUN2RCxXQUFLLGVBQWUsUUFBUSxXQUFXLGtCQUFrQixJQUFJLFFBQVEsTUFBTSxFQUFFLElBQUk7QUFBQSxJQUNsRixRQUFRO0FBQ1AsV0FBSyxlQUFlO0FBQUEsSUFDckI7QUFDQSxXQUFPLEtBQUs7QUFBQSxFQUNiO0FBQUE7QUFBQSxFQUdBLHVCQUFvRDtBQUNuRCxXQUFPLEtBQUs7QUFBQSxFQUNiO0FBQUE7QUFBQSxFQUdBLGVBQWUsVUFBa0M7QUFDaEQsU0FBSyxzQkFBc0IsSUFBSSxRQUFRO0FBQ3ZDLFdBQU8sTUFBTSxLQUFLLHNCQUFzQixPQUFPLFFBQVE7QUFBQSxFQUN4RDtBQUFBO0FBQUEsRUFHQSxtQkFBbUIsS0FBYSxNQUFnQztBQUMvRCxRQUFJLFNBQVMsUUFBVztBQUN2QixXQUFLLGtCQUFrQixPQUFPLEdBQUc7QUFBQSxJQUNsQyxPQUFPO0FBQ04sV0FBSyxrQkFBa0IsSUFBSSxLQUFLLElBQUk7QUFBQSxJQUNyQztBQUFBLEVBQ0Q7QUFBQTtBQUFBLEVBR0EseUJBQStCO0FBQzlCLFNBQUssa0JBQWtCLE1BQU07QUFBQSxFQUM5QjtBQUFBO0FBQUEsRUFHQSw0QkFBb0M7QUFDbkMsV0FBTyxLQUFLO0FBQUEsRUFDYjtBQUFBO0FBQUEsRUFHQSwwQkFBMEIsT0FBcUI7QUFDOUMsU0FBSyx5QkFBeUI7QUFBQSxFQUMvQjtBQUFBO0FBQUEsRUFHQSxVQUFnQjtBQUNmLFFBQUksS0FBSyxZQUFZO0FBQ3BCLFdBQUssV0FBVyxNQUFNO0FBQ3RCLFdBQUssYUFBYTtBQUFBLElBQ25CO0FBQ0EsU0FBSyxzQkFBc0IsTUFBTTtBQUFBLEVBQ2xDO0FBQUEsRUFFUSxrQkFBd0I7QUFDL0IsUUFBSSxLQUFLLFlBQVk7QUFDcEIsV0FBSyxXQUFXLE1BQU07QUFDdEIsV0FBSyxhQUFhO0FBQUEsSUFDbkI7QUFFQSxVQUFNLGNBQWMsZ0JBQWdCO0FBQ3BDLFFBQUksQ0FBQyxZQUFhO0FBS2xCLFVBQU0sU0FBUyxRQUFRLFdBQVc7QUFFbEMsUUFBSTtBQUNILFdBQUssYUFBYSxNQUFNLFFBQVEsQ0FBQyxZQUFZLGFBQWE7QUFDekQsWUFBSSxhQUFhLFFBQVE7QUFDeEIsZUFBSyxlQUFlO0FBQ3BCLHFCQUFXLE1BQU0sS0FBSyxzQkFBdUIsSUFBRztBQUFBLFFBQ2pEO0FBQUEsTUFDRCxDQUFDO0FBQUEsSUFDRixRQUFRO0FBQUEsSUFFUjtBQUFBLEVBQ0Q7QUFDRDsiLAogICJuYW1lcyI6IFtdCn0K
