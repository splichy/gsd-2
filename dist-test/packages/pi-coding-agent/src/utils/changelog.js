import { existsSync, readFileSync } from "fs";
function parseChangelog(changelogPath) {
  if (!existsSync(changelogPath)) {
    return [];
  }
  try {
    const content = readFileSync(changelogPath, "utf-8");
    const lines = content.split("\n");
    const entries = [];
    let currentLines = [];
    let currentVersion = null;
    for (const line of lines) {
      if (line.startsWith("## ")) {
        if (currentVersion && currentLines.length > 0) {
          entries.push({
            ...currentVersion,
            content: currentLines.join("\n").trim()
          });
        }
        const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
        if (versionMatch) {
          currentVersion = {
            major: Number.parseInt(versionMatch[1], 10),
            minor: Number.parseInt(versionMatch[2], 10),
            patch: Number.parseInt(versionMatch[3], 10)
          };
          currentLines = [line];
        } else {
          currentVersion = null;
          currentLines = [];
        }
      } else if (currentVersion) {
        currentLines.push(line);
      }
    }
    if (currentVersion && currentLines.length > 0) {
      entries.push({
        ...currentVersion,
        content: currentLines.join("\n").trim()
      });
    }
    return entries;
  } catch (error) {
    console.error(`Warning: Could not parse changelog: ${error}`);
    return [];
  }
}
function compareVersions(v1, v2) {
  if (v1.major !== v2.major) return v1.major - v2.major;
  if (v1.minor !== v2.minor) return v1.minor - v2.minor;
  return v1.patch - v2.patch;
}
function getNewEntries(entries, lastVersion) {
  const parts = lastVersion.split(".").map(Number);
  const last = {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    content: ""
  };
  return entries.filter((entry) => compareVersions(entry, last) > 0);
}
import { getChangelogPath } from "../config.js";
export {
  getChangelogPath,
  getNewEntries,
  parseChangelog
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy91dGlscy9jaGFuZ2Vsb2cudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJmc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIENoYW5nZWxvZ0VudHJ5IHtcblx0bWFqb3I6IG51bWJlcjtcblx0bWlub3I6IG51bWJlcjtcblx0cGF0Y2g6IG51bWJlcjtcblx0Y29udGVudDogc3RyaW5nO1xufVxuXG4vKipcbiAqIFBhcnNlIGNoYW5nZWxvZyBlbnRyaWVzIGZyb20gQ0hBTkdFTE9HLm1kXG4gKiBTY2FucyBmb3IgIyMgbGluZXMgYW5kIGNvbGxlY3RzIGNvbnRlbnQgdW50aWwgbmV4dCAjIyBvciBFT0ZcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ2hhbmdlbG9nKGNoYW5nZWxvZ1BhdGg6IHN0cmluZyk6IENoYW5nZWxvZ0VudHJ5W10ge1xuXHRpZiAoIWV4aXN0c1N5bmMoY2hhbmdlbG9nUGF0aCkpIHtcblx0XHRyZXR1cm4gW107XG5cdH1cblxuXHR0cnkge1xuXHRcdGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoY2hhbmdlbG9nUGF0aCwgXCJ1dGYtOFwiKTtcblx0XHRjb25zdCBsaW5lcyA9IGNvbnRlbnQuc3BsaXQoXCJcXG5cIik7XG5cdFx0Y29uc3QgZW50cmllczogQ2hhbmdlbG9nRW50cnlbXSA9IFtdO1xuXG5cdFx0bGV0IGN1cnJlbnRMaW5lczogc3RyaW5nW10gPSBbXTtcblx0XHRsZXQgY3VycmVudFZlcnNpb246IHsgbWFqb3I6IG51bWJlcjsgbWlub3I6IG51bWJlcjsgcGF0Y2g6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XG5cblx0XHRmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcblx0XHRcdC8vIENoZWNrIGlmIHRoaXMgaXMgYSB2ZXJzaW9uIGhlYWRlciAoIyMgW3gueS56XSAuLi4pXG5cdFx0XHRpZiAobGluZS5zdGFydHNXaXRoKFwiIyMgXCIpKSB7XG5cdFx0XHRcdC8vIFNhdmUgcHJldmlvdXMgZW50cnkgaWYgZXhpc3RzXG5cdFx0XHRcdGlmIChjdXJyZW50VmVyc2lvbiAmJiBjdXJyZW50TGluZXMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRcdGVudHJpZXMucHVzaCh7XG5cdFx0XHRcdFx0XHQuLi5jdXJyZW50VmVyc2lvbixcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IGN1cnJlbnRMaW5lcy5qb2luKFwiXFxuXCIpLnRyaW0oKSxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIFRyeSB0byBwYXJzZSB2ZXJzaW9uIGZyb20gdGhpcyBsaW5lXG5cdFx0XHRcdGNvbnN0IHZlcnNpb25NYXRjaCA9IGxpbmUubWF0Y2goLyMjXFxzK1xcWz8oXFxkKylcXC4oXFxkKylcXC4oXFxkKylcXF0/Lyk7XG5cdFx0XHRcdGlmICh2ZXJzaW9uTWF0Y2gpIHtcblx0XHRcdFx0XHRjdXJyZW50VmVyc2lvbiA9IHtcblx0XHRcdFx0XHRcdG1ham9yOiBOdW1iZXIucGFyc2VJbnQodmVyc2lvbk1hdGNoWzFdLCAxMCksXG5cdFx0XHRcdFx0XHRtaW5vcjogTnVtYmVyLnBhcnNlSW50KHZlcnNpb25NYXRjaFsyXSwgMTApLFxuXHRcdFx0XHRcdFx0cGF0Y2g6IE51bWJlci5wYXJzZUludCh2ZXJzaW9uTWF0Y2hbM10sIDEwKSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdGN1cnJlbnRMaW5lcyA9IFtsaW5lXTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHQvLyBSZXNldCBpZiB3ZSBjYW4ndCBwYXJzZSB2ZXJzaW9uXG5cdFx0XHRcdFx0Y3VycmVudFZlcnNpb24gPSBudWxsO1xuXHRcdFx0XHRcdGN1cnJlbnRMaW5lcyA9IFtdO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGVsc2UgaWYgKGN1cnJlbnRWZXJzaW9uKSB7XG5cdFx0XHRcdC8vIENvbGxlY3QgbGluZXMgZm9yIGN1cnJlbnQgdmVyc2lvblxuXHRcdFx0XHRjdXJyZW50TGluZXMucHVzaChsaW5lKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBTYXZlIGxhc3QgZW50cnlcblx0XHRpZiAoY3VycmVudFZlcnNpb24gJiYgY3VycmVudExpbmVzLmxlbmd0aCA+IDApIHtcblx0XHRcdGVudHJpZXMucHVzaCh7XG5cdFx0XHRcdC4uLmN1cnJlbnRWZXJzaW9uLFxuXHRcdFx0XHRjb250ZW50OiBjdXJyZW50TGluZXMuam9pbihcIlxcblwiKS50cmltKCksXG5cdFx0XHR9KTtcblx0XHR9XG5cblx0XHRyZXR1cm4gZW50cmllcztcblx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRjb25zb2xlLmVycm9yKGBXYXJuaW5nOiBDb3VsZCBub3QgcGFyc2UgY2hhbmdlbG9nOiAke2Vycm9yfWApO1xuXHRcdHJldHVybiBbXTtcblx0fVxufVxuXG4vKipcbiAqIENvbXBhcmUgdmVyc2lvbnMuIFJldHVybnM6IC0xIGlmIHYxIDwgdjIsIDAgaWYgdjEgPT09IHYyLCAxIGlmIHYxID4gdjJcbiAqL1xuZnVuY3Rpb24gY29tcGFyZVZlcnNpb25zKHYxOiBDaGFuZ2Vsb2dFbnRyeSwgdjI6IENoYW5nZWxvZ0VudHJ5KTogbnVtYmVyIHtcblx0aWYgKHYxLm1ham9yICE9PSB2Mi5tYWpvcikgcmV0dXJuIHYxLm1ham9yIC0gdjIubWFqb3I7XG5cdGlmICh2MS5taW5vciAhPT0gdjIubWlub3IpIHJldHVybiB2MS5taW5vciAtIHYyLm1pbm9yO1xuXHRyZXR1cm4gdjEucGF0Y2ggLSB2Mi5wYXRjaDtcbn1cblxuLyoqXG4gKiBHZXQgZW50cmllcyBuZXdlciB0aGFuIGxhc3RWZXJzaW9uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXROZXdFbnRyaWVzKGVudHJpZXM6IENoYW5nZWxvZ0VudHJ5W10sIGxhc3RWZXJzaW9uOiBzdHJpbmcpOiBDaGFuZ2Vsb2dFbnRyeVtdIHtcblx0Ly8gUGFyc2UgbGFzdFZlcnNpb25cblx0Y29uc3QgcGFydHMgPSBsYXN0VmVyc2lvbi5zcGxpdChcIi5cIikubWFwKE51bWJlcik7XG5cdGNvbnN0IGxhc3Q6IENoYW5nZWxvZ0VudHJ5ID0ge1xuXHRcdG1ham9yOiBwYXJ0c1swXSB8fCAwLFxuXHRcdG1pbm9yOiBwYXJ0c1sxXSB8fCAwLFxuXHRcdHBhdGNoOiBwYXJ0c1syXSB8fCAwLFxuXHRcdGNvbnRlbnQ6IFwiXCIsXG5cdH07XG5cblx0cmV0dXJuIGVudHJpZXMuZmlsdGVyKChlbnRyeSkgPT4gY29tcGFyZVZlcnNpb25zKGVudHJ5LCBsYXN0KSA+IDApO1xufVxuXG4vLyBSZS1leHBvcnQgZ2V0Q2hhbmdlbG9nUGF0aCBmcm9tIHBhdGhzLnRzIGZvciBjb252ZW5pZW5jZVxuZXhwb3J0IHsgZ2V0Q2hhbmdlbG9nUGF0aCB9IGZyb20gXCIuLi9jb25maWcuanNcIjtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsWUFBWSxvQkFBb0I7QUFhbEMsU0FBUyxlQUFlLGVBQXlDO0FBQ3ZFLE1BQUksQ0FBQyxXQUFXLGFBQWEsR0FBRztBQUMvQixXQUFPLENBQUM7QUFBQSxFQUNUO0FBRUEsTUFBSTtBQUNILFVBQU0sVUFBVSxhQUFhLGVBQWUsT0FBTztBQUNuRCxVQUFNLFFBQVEsUUFBUSxNQUFNLElBQUk7QUFDaEMsVUFBTSxVQUE0QixDQUFDO0FBRW5DLFFBQUksZUFBeUIsQ0FBQztBQUM5QixRQUFJLGlCQUF5RTtBQUU3RSxlQUFXLFFBQVEsT0FBTztBQUV6QixVQUFJLEtBQUssV0FBVyxLQUFLLEdBQUc7QUFFM0IsWUFBSSxrQkFBa0IsYUFBYSxTQUFTLEdBQUc7QUFDOUMsa0JBQVEsS0FBSztBQUFBLFlBQ1osR0FBRztBQUFBLFlBQ0gsU0FBUyxhQUFhLEtBQUssSUFBSSxFQUFFLEtBQUs7QUFBQSxVQUN2QyxDQUFDO0FBQUEsUUFDRjtBQUdBLGNBQU0sZUFBZSxLQUFLLE1BQU0sZ0NBQWdDO0FBQ2hFLFlBQUksY0FBYztBQUNqQiwyQkFBaUI7QUFBQSxZQUNoQixPQUFPLE9BQU8sU0FBUyxhQUFhLENBQUMsR0FBRyxFQUFFO0FBQUEsWUFDMUMsT0FBTyxPQUFPLFNBQVMsYUFBYSxDQUFDLEdBQUcsRUFBRTtBQUFBLFlBQzFDLE9BQU8sT0FBTyxTQUFTLGFBQWEsQ0FBQyxHQUFHLEVBQUU7QUFBQSxVQUMzQztBQUNBLHlCQUFlLENBQUMsSUFBSTtBQUFBLFFBQ3JCLE9BQU87QUFFTiwyQkFBaUI7QUFDakIseUJBQWUsQ0FBQztBQUFBLFFBQ2pCO0FBQUEsTUFDRCxXQUFXLGdCQUFnQjtBQUUxQixxQkFBYSxLQUFLLElBQUk7QUFBQSxNQUN2QjtBQUFBLElBQ0Q7QUFHQSxRQUFJLGtCQUFrQixhQUFhLFNBQVMsR0FBRztBQUM5QyxjQUFRLEtBQUs7QUFBQSxRQUNaLEdBQUc7QUFBQSxRQUNILFNBQVMsYUFBYSxLQUFLLElBQUksRUFBRSxLQUFLO0FBQUEsTUFDdkMsQ0FBQztBQUFBLElBQ0Y7QUFFQSxXQUFPO0FBQUEsRUFDUixTQUFTLE9BQU87QUFDZixZQUFRLE1BQU0sdUNBQXVDLEtBQUssRUFBRTtBQUM1RCxXQUFPLENBQUM7QUFBQSxFQUNUO0FBQ0Q7QUFLQSxTQUFTLGdCQUFnQixJQUFvQixJQUE0QjtBQUN4RSxNQUFJLEdBQUcsVUFBVSxHQUFHLE1BQU8sUUFBTyxHQUFHLFFBQVEsR0FBRztBQUNoRCxNQUFJLEdBQUcsVUFBVSxHQUFHLE1BQU8sUUFBTyxHQUFHLFFBQVEsR0FBRztBQUNoRCxTQUFPLEdBQUcsUUFBUSxHQUFHO0FBQ3RCO0FBS08sU0FBUyxjQUFjLFNBQTJCLGFBQXVDO0FBRS9GLFFBQU0sUUFBUSxZQUFZLE1BQU0sR0FBRyxFQUFFLElBQUksTUFBTTtBQUMvQyxRQUFNLE9BQXVCO0FBQUEsSUFDNUIsT0FBTyxNQUFNLENBQUMsS0FBSztBQUFBLElBQ25CLE9BQU8sTUFBTSxDQUFDLEtBQUs7QUFBQSxJQUNuQixPQUFPLE1BQU0sQ0FBQyxLQUFLO0FBQUEsSUFDbkIsU0FBUztBQUFBLEVBQ1Y7QUFFQSxTQUFPLFFBQVEsT0FBTyxDQUFDLFVBQVUsZ0JBQWdCLE9BQU8sSUFBSSxJQUFJLENBQUM7QUFDbEU7QUFHQSxTQUFTLHdCQUF3QjsiLAogICJuYW1lcyI6IFtdCn0K
