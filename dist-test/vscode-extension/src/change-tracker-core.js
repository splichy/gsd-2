import * as path from "node:path";
function getToolInput(evt) {
  const input = evt.args ?? evt.toolInput ?? evt.input ?? {};
  return input && typeof input === "object" ? input : {};
}
function getToolUseId(evt) {
  return String(evt.toolCallId ?? evt.toolUseId ?? "");
}
function normalizeToolName(toolName) {
  return String(toolName ?? "").toLowerCase();
}
function isFileMutationTool(toolName) {
  return toolName === "write" || toolName === "write_file" || toolName === "edit";
}
function resolveToolPath(workspaceRoot, input) {
  const rawPath = String(input.file_path ?? input.path ?? "");
  if (!rawPath) return "";
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(workspaceRoot, rawPath);
}
function captureOriginalContent(filePath, fsImpl) {
  try {
    return fsImpl.existsSync(filePath) ? fsImpl.readFileSync(filePath, "utf8") : null;
  } catch {
    return void 0;
  }
}
function captureCurrentSnapshots(filePaths, fsImpl) {
  const snapshots = /* @__PURE__ */ new Map();
  for (const filePath of filePaths) {
    try {
      snapshots.set(filePath, fsImpl.existsSync(filePath) ? fsImpl.readFileSync(filePath, "utf8") : null);
    } catch {
      snapshots.set(filePath, null);
    }
  }
  return snapshots;
}
function describeAction(toolName, input) {
  switch (toolName.toLowerCase()) {
    case "read": {
      const p = String(input.file_path ?? input.path ?? "");
      return `Read ${p.split(/[\\/]/).pop() ?? p}`;
    }
    case "write":
    case "write_file": {
      const p = String(input.file_path ?? "");
      return `Write ${p.split(/[\\/]/).pop() ?? p}`;
    }
    case "edit": {
      const p = String(input.file_path ?? "");
      return `Edit ${p.split(/[\\/]/).pop() ?? p}`;
    }
    case "bash":
      return `$ ${String(input.command ?? "").slice(0, 40)}`;
    case "grep":
      return `Grep: ${String(input.pattern ?? "").slice(0, 30)}`;
    case "glob":
      return `Glob: ${String(input.pattern ?? "").slice(0, 30)}`;
    default:
      return toolName;
  }
}
export {
  captureCurrentSnapshots,
  captureOriginalContent,
  describeAction,
  getToolInput,
  getToolUseId,
  isFileMutationTool,
  normalizeToolName,
  resolveToolPath
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvY2hhbmdlLXRyYWNrZXItY29yZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFZTIENvZGUgY2hhbmdlLXRyYWNrZXIgZXZlbnQgYW5kIHNuYXBzaG90IGhlbHBlcnMuXG5cbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIENoYW5nZVRyYWNrZXJBZ2VudEV2ZW50IHtcblx0dHlwZTogc3RyaW5nO1xuXHRba2V5OiBzdHJpbmddOiB1bmtub3duO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENoYW5nZVRyYWNrZXJGaWxlU3lzdGVtIHtcblx0ZXhpc3RzU3luYyhmaWxlUGF0aDogc3RyaW5nKTogYm9vbGVhbjtcblx0cmVhZEZpbGVTeW5jKGZpbGVQYXRoOiBzdHJpbmcsIGVuY29kaW5nOiBcInV0ZjhcIik6IHN0cmluZztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFRvb2xJbnB1dChldnQ6IENoYW5nZVRyYWNrZXJBZ2VudEV2ZW50KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuXHRjb25zdCBpbnB1dCA9IGV2dC5hcmdzID8/IGV2dC50b29sSW5wdXQgPz8gZXZ0LmlucHV0ID8/IHt9O1xuXHRyZXR1cm4gaW5wdXQgJiYgdHlwZW9mIGlucHV0ID09PSBcIm9iamVjdFwiID8gaW5wdXQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gOiB7fTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFRvb2xVc2VJZChldnQ6IENoYW5nZVRyYWNrZXJBZ2VudEV2ZW50KTogc3RyaW5nIHtcblx0cmV0dXJuIFN0cmluZyhldnQudG9vbENhbGxJZCA/PyBldnQudG9vbFVzZUlkID8/IFwiXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplVG9vbE5hbWUodG9vbE5hbWU6IHVua25vd24pOiBzdHJpbmcge1xuXHRyZXR1cm4gU3RyaW5nKHRvb2xOYW1lID8/IFwiXCIpLnRvTG93ZXJDYXNlKCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0ZpbGVNdXRhdGlvblRvb2wodG9vbE5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRyZXR1cm4gdG9vbE5hbWUgPT09IFwid3JpdGVcIiB8fCB0b29sTmFtZSA9PT0gXCJ3cml0ZV9maWxlXCIgfHwgdG9vbE5hbWUgPT09IFwiZWRpdFwiO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVRvb2xQYXRoKHdvcmtzcGFjZVJvb3Q6IHN0cmluZywgaW5wdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHtcblx0Y29uc3QgcmF3UGF0aCA9IFN0cmluZyhpbnB1dC5maWxlX3BhdGggPz8gaW5wdXQucGF0aCA/PyBcIlwiKTtcblx0aWYgKCFyYXdQYXRoKSByZXR1cm4gXCJcIjtcblx0cmV0dXJuIHBhdGguaXNBYnNvbHV0ZShyYXdQYXRoKSA/IHJhd1BhdGggOiBwYXRoLnJlc29sdmUod29ya3NwYWNlUm9vdCwgcmF3UGF0aCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjYXB0dXJlT3JpZ2luYWxDb250ZW50KGZpbGVQYXRoOiBzdHJpbmcsIGZzSW1wbDogQ2hhbmdlVHJhY2tlckZpbGVTeXN0ZW0pOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkIHtcblx0dHJ5IHtcblx0XHRyZXR1cm4gZnNJbXBsLmV4aXN0c1N5bmMoZmlsZVBhdGgpID8gZnNJbXBsLnJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGY4XCIpIDogbnVsbDtcblx0fSBjYXRjaCB7XG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fVxufVxuXG5leHBvcnQgZnVuY3Rpb24gY2FwdHVyZUN1cnJlbnRTbmFwc2hvdHMoXG5cdGZpbGVQYXRoczogSXRlcmFibGU8c3RyaW5nPixcblx0ZnNJbXBsOiBDaGFuZ2VUcmFja2VyRmlsZVN5c3RlbSxcbik6IE1hcDxzdHJpbmcsIHN0cmluZyB8IG51bGw+IHtcblx0Y29uc3Qgc25hcHNob3RzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZyB8IG51bGw+KCk7XG5cdGZvciAoY29uc3QgZmlsZVBhdGggb2YgZmlsZVBhdGhzKSB7XG5cdFx0dHJ5IHtcblx0XHRcdHNuYXBzaG90cy5zZXQoZmlsZVBhdGgsIGZzSW1wbC5leGlzdHNTeW5jKGZpbGVQYXRoKSA/IGZzSW1wbC5yZWFkRmlsZVN5bmMoZmlsZVBhdGgsIFwidXRmOFwiKSA6IG51bGwpO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0c25hcHNob3RzLnNldChmaWxlUGF0aCwgbnVsbCk7XG5cdFx0fVxuXHR9XG5cdHJldHVybiBzbmFwc2hvdHM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBkZXNjcmliZUFjdGlvbih0b29sTmFtZTogc3RyaW5nLCBpbnB1dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBzdHJpbmcge1xuXHRzd2l0Y2ggKHRvb2xOYW1lLnRvTG93ZXJDYXNlKCkpIHtcblx0XHRjYXNlIFwicmVhZFwiOiB7XG5cdFx0XHRjb25zdCBwID0gU3RyaW5nKGlucHV0LmZpbGVfcGF0aCA/PyBpbnB1dC5wYXRoID8/IFwiXCIpO1xuXHRcdFx0cmV0dXJuIGBSZWFkICR7cC5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpID8/IHB9YDtcblx0XHR9XG5cdFx0Y2FzZSBcIndyaXRlXCI6XG5cdFx0Y2FzZSBcIndyaXRlX2ZpbGVcIjoge1xuXHRcdFx0Y29uc3QgcCA9IFN0cmluZyhpbnB1dC5maWxlX3BhdGggPz8gXCJcIik7XG5cdFx0XHRyZXR1cm4gYFdyaXRlICR7cC5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpID8/IHB9YDtcblx0XHR9XG5cdFx0Y2FzZSBcImVkaXRcIjoge1xuXHRcdFx0Y29uc3QgcCA9IFN0cmluZyhpbnB1dC5maWxlX3BhdGggPz8gXCJcIik7XG5cdFx0XHRyZXR1cm4gYEVkaXQgJHtwLnNwbGl0KC9bXFxcXC9dLykucG9wKCkgPz8gcH1gO1xuXHRcdH1cblx0XHRjYXNlIFwiYmFzaFwiOlxuXHRcdFx0cmV0dXJuIGAkICR7U3RyaW5nKGlucHV0LmNvbW1hbmQgPz8gXCJcIikuc2xpY2UoMCwgNDApfWA7XG5cdFx0Y2FzZSBcImdyZXBcIjpcblx0XHRcdHJldHVybiBgR3JlcDogJHtTdHJpbmcoaW5wdXQucGF0dGVybiA/PyBcIlwiKS5zbGljZSgwLCAzMCl9YDtcblx0XHRjYXNlIFwiZ2xvYlwiOlxuXHRcdFx0cmV0dXJuIGBHbG9iOiAke1N0cmluZyhpbnB1dC5wYXR0ZXJuID8/IFwiXCIpLnNsaWNlKDAsIDMwKX1gO1xuXHRcdGRlZmF1bHQ6XG5cdFx0XHRyZXR1cm4gdG9vbE5hbWU7XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLFlBQVksVUFBVTtBQVlmLFNBQVMsYUFBYSxLQUF1RDtBQUNuRixRQUFNLFFBQVEsSUFBSSxRQUFRLElBQUksYUFBYSxJQUFJLFNBQVMsQ0FBQztBQUN6RCxTQUFPLFNBQVMsT0FBTyxVQUFVLFdBQVcsUUFBbUMsQ0FBQztBQUNqRjtBQUVPLFNBQVMsYUFBYSxLQUFzQztBQUNsRSxTQUFPLE9BQU8sSUFBSSxjQUFjLElBQUksYUFBYSxFQUFFO0FBQ3BEO0FBRU8sU0FBUyxrQkFBa0IsVUFBMkI7QUFDNUQsU0FBTyxPQUFPLFlBQVksRUFBRSxFQUFFLFlBQVk7QUFDM0M7QUFFTyxTQUFTLG1CQUFtQixVQUEyQjtBQUM3RCxTQUFPLGFBQWEsV0FBVyxhQUFhLGdCQUFnQixhQUFhO0FBQzFFO0FBRU8sU0FBUyxnQkFBZ0IsZUFBdUIsT0FBd0M7QUFDOUYsUUFBTSxVQUFVLE9BQU8sTUFBTSxhQUFhLE1BQU0sUUFBUSxFQUFFO0FBQzFELE1BQUksQ0FBQyxRQUFTLFFBQU87QUFDckIsU0FBTyxLQUFLLFdBQVcsT0FBTyxJQUFJLFVBQVUsS0FBSyxRQUFRLGVBQWUsT0FBTztBQUNoRjtBQUVPLFNBQVMsdUJBQXVCLFVBQWtCLFFBQTREO0FBQ3BILE1BQUk7QUFDSCxXQUFPLE9BQU8sV0FBVyxRQUFRLElBQUksT0FBTyxhQUFhLFVBQVUsTUFBTSxJQUFJO0FBQUEsRUFDOUUsUUFBUTtBQUNQLFdBQU87QUFBQSxFQUNSO0FBQ0Q7QUFFTyxTQUFTLHdCQUNmLFdBQ0EsUUFDNkI7QUFDN0IsUUFBTSxZQUFZLG9CQUFJLElBQTJCO0FBQ2pELGFBQVcsWUFBWSxXQUFXO0FBQ2pDLFFBQUk7QUFDSCxnQkFBVSxJQUFJLFVBQVUsT0FBTyxXQUFXLFFBQVEsSUFBSSxPQUFPLGFBQWEsVUFBVSxNQUFNLElBQUksSUFBSTtBQUFBLElBQ25HLFFBQVE7QUFDUCxnQkFBVSxJQUFJLFVBQVUsSUFBSTtBQUFBLElBQzdCO0FBQUEsRUFDRDtBQUNBLFNBQU87QUFDUjtBQUVPLFNBQVMsZUFBZSxVQUFrQixPQUF3QztBQUN4RixVQUFRLFNBQVMsWUFBWSxHQUFHO0FBQUEsSUFDL0IsS0FBSyxRQUFRO0FBQ1osWUFBTSxJQUFJLE9BQU8sTUFBTSxhQUFhLE1BQU0sUUFBUSxFQUFFO0FBQ3BELGFBQU8sUUFBUSxFQUFFLE1BQU0sT0FBTyxFQUFFLElBQUksS0FBSyxDQUFDO0FBQUEsSUFDM0M7QUFBQSxJQUNBLEtBQUs7QUFBQSxJQUNMLEtBQUssY0FBYztBQUNsQixZQUFNLElBQUksT0FBTyxNQUFNLGFBQWEsRUFBRTtBQUN0QyxhQUFPLFNBQVMsRUFBRSxNQUFNLE9BQU8sRUFBRSxJQUFJLEtBQUssQ0FBQztBQUFBLElBQzVDO0FBQUEsSUFDQSxLQUFLLFFBQVE7QUFDWixZQUFNLElBQUksT0FBTyxNQUFNLGFBQWEsRUFBRTtBQUN0QyxhQUFPLFFBQVEsRUFBRSxNQUFNLE9BQU8sRUFBRSxJQUFJLEtBQUssQ0FBQztBQUFBLElBQzNDO0FBQUEsSUFDQSxLQUFLO0FBQ0osYUFBTyxLQUFLLE9BQU8sTUFBTSxXQUFXLEVBQUUsRUFBRSxNQUFNLEdBQUcsRUFBRSxDQUFDO0FBQUEsSUFDckQsS0FBSztBQUNKLGFBQU8sU0FBUyxPQUFPLE1BQU0sV0FBVyxFQUFFLEVBQUUsTUFBTSxHQUFHLEVBQUUsQ0FBQztBQUFBLElBQ3pELEtBQUs7QUFDSixhQUFPLFNBQVMsT0FBTyxNQUFNLFdBQVcsRUFBRSxFQUFFLE1BQU0sR0FBRyxFQUFFLENBQUM7QUFBQSxJQUN6RDtBQUNDLGFBQU87QUFBQSxFQUNUO0FBQ0Q7IiwKICAibmFtZXMiOiBbXQp9Cg==
