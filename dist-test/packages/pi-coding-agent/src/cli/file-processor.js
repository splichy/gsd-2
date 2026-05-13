import { access, readFile, stat } from "node:fs/promises";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.js";
import { formatDimensionNote, resizeImage } from "../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.js";
async function processFileArguments(fileArgs, options) {
  const autoResizeImages = options?.autoResizeImages ?? true;
  let text = "";
  const images = [];
  for (const fileArg of fileArgs) {
    const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));
    try {
      await access(absolutePath);
    } catch {
      console.error(chalk.red(`Error: File not found: ${absolutePath}`));
      process.exit(1);
    }
    const stats = await stat(absolutePath);
    if (stats.size === 0) {
      continue;
    }
    const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
    if (mimeType) {
      const content = await readFile(absolutePath);
      const base64Content = content.toString("base64");
      let attachment;
      let dimensionNote;
      if (autoResizeImages) {
        const resized = await resizeImage({ type: "image", data: base64Content, mimeType });
        dimensionNote = formatDimensionNote(resized);
        attachment = {
          type: "image",
          mimeType: resized.mimeType,
          data: resized.data
        };
      } else {
        attachment = {
          type: "image",
          mimeType,
          data: base64Content
        };
      }
      images.push(attachment);
      if (dimensionNote) {
        text += `<file name="${absolutePath}">${dimensionNote}</file>
`;
      } else {
        text += `<file name="${absolutePath}"></file>
`;
      }
    } else {
      try {
        const content = await readFile(absolutePath, "utf-8");
        text += `<file name="${absolutePath}">
${content}
</file>
`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
        process.exit(1);
      }
    }
  }
  return { text, images };
}
export {
  processFileArguments
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jbGkvZmlsZS1wcm9jZXNzb3IudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUHJvY2VzcyBAZmlsZSBDTEkgYXJndW1lbnRzIGludG8gdGV4dCBjb250ZW50IGFuZCBpbWFnZSBhdHRhY2htZW50c1xuICovXG5cbmltcG9ydCB7IGFjY2VzcywgcmVhZEZpbGUsIHN0YXQgfSBmcm9tIFwibm9kZTpmcy9wcm9taXNlc1wiO1xuaW1wb3J0IHR5cGUgeyBJbWFnZUNvbnRlbnQgfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuaW1wb3J0IGNoYWxrIGZyb20gXCJjaGFsa1wiO1xuaW1wb3J0IHsgcmVzb2x2ZSB9IGZyb20gXCJwYXRoXCI7XG5pbXBvcnQgeyByZXNvbHZlUmVhZFBhdGggfSBmcm9tIFwiLi4vY29yZS90b29scy9wYXRoLXV0aWxzLmpzXCI7XG5pbXBvcnQgeyBmb3JtYXREaW1lbnNpb25Ob3RlLCByZXNpemVJbWFnZSB9IGZyb20gXCIuLi91dGlscy9pbWFnZS1yZXNpemUuanNcIjtcbmltcG9ydCB7IGRldGVjdFN1cHBvcnRlZEltYWdlTWltZVR5cGVGcm9tRmlsZSB9IGZyb20gXCIuLi91dGlscy9taW1lLmpzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJvY2Vzc2VkRmlsZXMge1xuXHR0ZXh0OiBzdHJpbmc7XG5cdGltYWdlczogSW1hZ2VDb250ZW50W107XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJvY2Vzc0ZpbGVPcHRpb25zIHtcblx0LyoqIFdoZXRoZXIgdG8gYXV0by1yZXNpemUgaW1hZ2VzIHRvIDIwMDB4MjAwMCBtYXguIERlZmF1bHQ6IHRydWUgKi9cblx0YXV0b1Jlc2l6ZUltYWdlcz86IGJvb2xlYW47XG59XG5cbi8qKiBQcm9jZXNzIEBmaWxlIGFyZ3VtZW50cyBpbnRvIHRleHQgY29udGVudCBhbmQgaW1hZ2UgYXR0YWNobWVudHMgKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwcm9jZXNzRmlsZUFyZ3VtZW50cyhmaWxlQXJnczogc3RyaW5nW10sIG9wdGlvbnM/OiBQcm9jZXNzRmlsZU9wdGlvbnMpOiBQcm9taXNlPFByb2Nlc3NlZEZpbGVzPiB7XG5cdGNvbnN0IGF1dG9SZXNpemVJbWFnZXMgPSBvcHRpb25zPy5hdXRvUmVzaXplSW1hZ2VzID8/IHRydWU7XG5cdGxldCB0ZXh0ID0gXCJcIjtcblx0Y29uc3QgaW1hZ2VzOiBJbWFnZUNvbnRlbnRbXSA9IFtdO1xuXG5cdGZvciAoY29uc3QgZmlsZUFyZyBvZiBmaWxlQXJncykge1xuXHRcdC8vIEV4cGFuZCBhbmQgcmVzb2x2ZSBwYXRoIChoYW5kbGVzIH4gZXhwYW5zaW9uIGFuZCBtYWNPUyBzY3JlZW5zaG90IFVuaWNvZGUgc3BhY2VzKVxuXHRcdGNvbnN0IGFic29sdXRlUGF0aCA9IHJlc29sdmUocmVzb2x2ZVJlYWRQYXRoKGZpbGVBcmcsIHByb2Nlc3MuY3dkKCkpKTtcblxuXHRcdC8vIENoZWNrIGlmIGZpbGUgZXhpc3RzXG5cdFx0dHJ5IHtcblx0XHRcdGF3YWl0IGFjY2VzcyhhYnNvbHV0ZVBhdGgpO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Y29uc29sZS5lcnJvcihjaGFsay5yZWQoYEVycm9yOiBGaWxlIG5vdCBmb3VuZDogJHthYnNvbHV0ZVBhdGh9YCkpO1xuXHRcdFx0cHJvY2Vzcy5leGl0KDEpO1xuXHRcdH1cblxuXHRcdC8vIENoZWNrIGlmIGZpbGUgaXMgZW1wdHlcblx0XHRjb25zdCBzdGF0cyA9IGF3YWl0IHN0YXQoYWJzb2x1dGVQYXRoKTtcblx0XHRpZiAoc3RhdHMuc2l6ZSA9PT0gMCkge1xuXHRcdFx0Ly8gU2tpcCBlbXB0eSBmaWxlc1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXG5cdFx0Y29uc3QgbWltZVR5cGUgPSBhd2FpdCBkZXRlY3RTdXBwb3J0ZWRJbWFnZU1pbWVUeXBlRnJvbUZpbGUoYWJzb2x1dGVQYXRoKTtcblxuXHRcdGlmIChtaW1lVHlwZSkge1xuXHRcdFx0Ly8gSGFuZGxlIGltYWdlIGZpbGVcblx0XHRcdGNvbnN0IGNvbnRlbnQgPSBhd2FpdCByZWFkRmlsZShhYnNvbHV0ZVBhdGgpO1xuXHRcdFx0Y29uc3QgYmFzZTY0Q29udGVudCA9IGNvbnRlbnQudG9TdHJpbmcoXCJiYXNlNjRcIik7XG5cblx0XHRcdGxldCBhdHRhY2htZW50OiBJbWFnZUNvbnRlbnQ7XG5cdFx0XHRsZXQgZGltZW5zaW9uTm90ZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXG5cdFx0XHRpZiAoYXV0b1Jlc2l6ZUltYWdlcykge1xuXHRcdFx0XHRjb25zdCByZXNpemVkID0gYXdhaXQgcmVzaXplSW1hZ2UoeyB0eXBlOiBcImltYWdlXCIsIGRhdGE6IGJhc2U2NENvbnRlbnQsIG1pbWVUeXBlIH0pO1xuXHRcdFx0XHRkaW1lbnNpb25Ob3RlID0gZm9ybWF0RGltZW5zaW9uTm90ZShyZXNpemVkKTtcblx0XHRcdFx0YXR0YWNobWVudCA9IHtcblx0XHRcdFx0XHR0eXBlOiBcImltYWdlXCIsXG5cdFx0XHRcdFx0bWltZVR5cGU6IHJlc2l6ZWQubWltZVR5cGUsXG5cdFx0XHRcdFx0ZGF0YTogcmVzaXplZC5kYXRhLFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0YXR0YWNobWVudCA9IHtcblx0XHRcdFx0XHR0eXBlOiBcImltYWdlXCIsXG5cdFx0XHRcdFx0bWltZVR5cGUsXG5cdFx0XHRcdFx0ZGF0YTogYmFzZTY0Q29udGVudCxcblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0aW1hZ2VzLnB1c2goYXR0YWNobWVudCk7XG5cblx0XHRcdC8vIEFkZCB0ZXh0IHJlZmVyZW5jZSB0byBpbWFnZSB3aXRoIG9wdGlvbmFsIGRpbWVuc2lvbiBub3RlXG5cdFx0XHRpZiAoZGltZW5zaW9uTm90ZSkge1xuXHRcdFx0XHR0ZXh0ICs9IGA8ZmlsZSBuYW1lPVwiJHthYnNvbHV0ZVBhdGh9XCI+JHtkaW1lbnNpb25Ob3RlfTwvZmlsZT5cXG5gO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0dGV4dCArPSBgPGZpbGUgbmFtZT1cIiR7YWJzb2x1dGVQYXRofVwiPjwvZmlsZT5cXG5gO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBIYW5kbGUgdGV4dCBmaWxlXG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBjb250ZW50ID0gYXdhaXQgcmVhZEZpbGUoYWJzb2x1dGVQYXRoLCBcInV0Zi04XCIpO1xuXHRcdFx0XHR0ZXh0ICs9IGA8ZmlsZSBuYW1lPVwiJHthYnNvbHV0ZVBhdGh9XCI+XFxuJHtjb250ZW50fVxcbjwvZmlsZT5cXG5gO1xuXHRcdFx0fSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcblx0XHRcdFx0Y29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihjaGFsay5yZWQoYEVycm9yOiBDb3VsZCBub3QgcmVhZCBmaWxlICR7YWJzb2x1dGVQYXRofTogJHttZXNzYWdlfWApKTtcblx0XHRcdFx0cHJvY2Vzcy5leGl0KDEpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHJldHVybiB7IHRleHQsIGltYWdlcyB9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBSUEsU0FBUyxRQUFRLFVBQVUsWUFBWTtBQUV2QyxPQUFPLFdBQVc7QUFDbEIsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsdUJBQXVCO0FBQ2hDLFNBQVMscUJBQXFCLG1CQUFtQjtBQUNqRCxTQUFTLDRDQUE0QztBQWFyRCxlQUFzQixxQkFBcUIsVUFBb0IsU0FBdUQ7QUFDckgsUUFBTSxtQkFBbUIsU0FBUyxvQkFBb0I7QUFDdEQsTUFBSSxPQUFPO0FBQ1gsUUFBTSxTQUF5QixDQUFDO0FBRWhDLGFBQVcsV0FBVyxVQUFVO0FBRS9CLFVBQU0sZUFBZSxRQUFRLGdCQUFnQixTQUFTLFFBQVEsSUFBSSxDQUFDLENBQUM7QUFHcEUsUUFBSTtBQUNILFlBQU0sT0FBTyxZQUFZO0FBQUEsSUFDMUIsUUFBUTtBQUNQLGNBQVEsTUFBTSxNQUFNLElBQUksMEJBQTBCLFlBQVksRUFBRSxDQUFDO0FBQ2pFLGNBQVEsS0FBSyxDQUFDO0FBQUEsSUFDZjtBQUdBLFVBQU0sUUFBUSxNQUFNLEtBQUssWUFBWTtBQUNyQyxRQUFJLE1BQU0sU0FBUyxHQUFHO0FBRXJCO0FBQUEsSUFDRDtBQUVBLFVBQU0sV0FBVyxNQUFNLHFDQUFxQyxZQUFZO0FBRXhFLFFBQUksVUFBVTtBQUViLFlBQU0sVUFBVSxNQUFNLFNBQVMsWUFBWTtBQUMzQyxZQUFNLGdCQUFnQixRQUFRLFNBQVMsUUFBUTtBQUUvQyxVQUFJO0FBQ0osVUFBSTtBQUVKLFVBQUksa0JBQWtCO0FBQ3JCLGNBQU0sVUFBVSxNQUFNLFlBQVksRUFBRSxNQUFNLFNBQVMsTUFBTSxlQUFlLFNBQVMsQ0FBQztBQUNsRix3QkFBZ0Isb0JBQW9CLE9BQU87QUFDM0MscUJBQWE7QUFBQSxVQUNaLE1BQU07QUFBQSxVQUNOLFVBQVUsUUFBUTtBQUFBLFVBQ2xCLE1BQU0sUUFBUTtBQUFBLFFBQ2Y7QUFBQSxNQUNELE9BQU87QUFDTixxQkFBYTtBQUFBLFVBQ1osTUFBTTtBQUFBLFVBQ047QUFBQSxVQUNBLE1BQU07QUFBQSxRQUNQO0FBQUEsTUFDRDtBQUVBLGFBQU8sS0FBSyxVQUFVO0FBR3RCLFVBQUksZUFBZTtBQUNsQixnQkFBUSxlQUFlLFlBQVksS0FBSyxhQUFhO0FBQUE7QUFBQSxNQUN0RCxPQUFPO0FBQ04sZ0JBQVEsZUFBZSxZQUFZO0FBQUE7QUFBQSxNQUNwQztBQUFBLElBQ0QsT0FBTztBQUVOLFVBQUk7QUFDSCxjQUFNLFVBQVUsTUFBTSxTQUFTLGNBQWMsT0FBTztBQUNwRCxnQkFBUSxlQUFlLFlBQVk7QUFBQSxFQUFPLE9BQU87QUFBQTtBQUFBO0FBQUEsTUFDbEQsU0FBUyxPQUFnQjtBQUN4QixjQUFNLFVBQVUsaUJBQWlCLFFBQVEsTUFBTSxVQUFVLE9BQU8sS0FBSztBQUNyRSxnQkFBUSxNQUFNLE1BQU0sSUFBSSw4QkFBOEIsWUFBWSxLQUFLLE9BQU8sRUFBRSxDQUFDO0FBQ2pGLGdCQUFRLEtBQUssQ0FBQztBQUFBLE1BQ2Y7QUFBQSxJQUNEO0FBQUEsRUFDRDtBQUVBLFNBQU8sRUFBRSxNQUFNLE9BQU87QUFDdkI7IiwKICAibmFtZXMiOiBbXQp9Cg==
