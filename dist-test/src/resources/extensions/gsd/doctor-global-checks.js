import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readRepoMeta, externalProjectsRoot } from "./repo-identity.js";
async function checkGlobalHealth(issues, fixesApplied, shouldFix) {
  try {
    const projectsDir = externalProjectsRoot();
    if (!existsSync(projectsDir)) return;
    let entries;
    try {
      entries = readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return;
    }
    if (entries.length === 0) return;
    const orphaned = [];
    let unknownCount = 0;
    for (const hash of entries) {
      const dirPath = join(projectsDir, hash);
      const meta = readRepoMeta(dirPath);
      if (!meta) {
        unknownCount++;
        continue;
      }
      if (!existsSync(meta.gitRoot)) {
        orphaned.push({ hash, gitRoot: meta.gitRoot, remoteUrl: meta.remoteUrl });
      }
    }
    if (orphaned.length === 0) return;
    const labels = orphaned.slice(0, 3).map((o) => o.gitRoot).join(", ");
    const overflow = orphaned.length > 3 ? ` (+${orphaned.length - 3} more)` : "";
    const unknownNote = unknownCount > 0 ? ` \u2014 ${unknownCount} additional director${unknownCount === 1 ? "y" : "ies"} have no metadata yet (open those repos once to register them)` : "";
    issues.push({
      severity: "info",
      code: "orphaned_project_state",
      scope: "project",
      unitId: "global",
      message: `${orphaned.length} orphaned GSD project state director${orphaned.length === 1 ? "y" : "ies"} in ${projectsDir} whose git root no longer exists: ${labels}${overflow}${unknownNote}. Run /gsd cleanup projects to audit or /gsd cleanup projects --fix to reclaim disk space.`,
      file: projectsDir,
      fixable: true
    });
    if (shouldFix("orphaned_project_state")) {
      let removed = 0;
      for (const { hash } of orphaned) {
        try {
          rmSync(join(projectsDir, hash), { recursive: true, force: true });
          removed++;
        } catch {
        }
      }
      fixesApplied.push(`removed ${removed} orphaned project state director${removed === 1 ? "y" : "ies"} from ${projectsDir}`);
    }
  } catch {
  }
}
export {
  checkGlobalHealth
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kb2N0b3ItZ2xvYmFsLWNoZWNrcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZGRpclN5bmMsIHJtU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgdHlwZSB7IERvY3Rvcklzc3VlLCBEb2N0b3JJc3N1ZUNvZGUgfSBmcm9tIFwiLi9kb2N0b3ItdHlwZXMuanNcIjtcbmltcG9ydCB7IHJlYWRSZXBvTWV0YSwgZXh0ZXJuYWxQcm9qZWN0c1Jvb3QgfSBmcm9tIFwiLi9yZXBvLWlkZW50aXR5LmpzXCI7XG5cbi8qKlxuICogQ2hlY2sgZm9yIG9ycGhhbmVkIHByb2plY3Qgc3RhdGUgZGlyZWN0b3JpZXMgaW4gfi8uZ3NkL3Byb2plY3RzLy5cbiAqXG4gKiBBIHByb2plY3QgZGlyZWN0b3J5IGlzIG9ycGhhbmVkIHdoZW4gaXRzIHJlY29yZGVkIGdpdFJvb3Qgbm8gbG9uZ2VyIGV4aXN0c1xuICogb24gZGlzayBcdTIwMTQgdGhlIHJlcG8gd2FzIGRlbGV0ZWQsIG1vdmVkLCBvciB0aGUgZXh0ZXJuYWwgZHJpdmUgd2FzIHVubW91bnRlZC5cbiAqIFRoZXNlIGRpcmVjdG9yaWVzIGFjY3VtdWxhdGUgc2lsZW50bHkgYW5kIHdhc3RlIGRpc2sgc3BhY2UuXG4gKlxuICogU2V2ZXJpdHk6IGluZm8gXHUyMDE0IG9ycGhhbmVkIHN0YXRlIGlzIGhhcm1sZXNzIGJ1dCB0YWtlcyBkaXNrIHNwYWNlLlxuICogRml4YWJsZTogeWVzIFx1MjAxNCBybVN5bmMgdGhlIGRpcmVjdG9yeS4gTmV2ZXIgYXV0by1maXhlZCBhdCBmaXhMZXZlbD1cInRhc2tcIi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNoZWNrR2xvYmFsSGVhbHRoKFxuICBpc3N1ZXM6IERvY3Rvcklzc3VlW10sXG4gIGZpeGVzQXBwbGllZDogc3RyaW5nW10sXG4gIHNob3VsZEZpeDogKGNvZGU6IERvY3Rvcklzc3VlQ29kZSkgPT4gYm9vbGVhbixcbik6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHByb2plY3RzRGlyID0gZXh0ZXJuYWxQcm9qZWN0c1Jvb3QoKTtcblxuICAgIGlmICghZXhpc3RzU3luYyhwcm9qZWN0c0RpcikpIHJldHVybjtcblxuICAgIGxldCBlbnRyaWVzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgZW50cmllcyA9IHJlYWRkaXJTeW5jKHByb2plY3RzRGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSlcbiAgICAgICAgLmZpbHRlcihlID0+IGUuaXNEaXJlY3RvcnkoKSlcbiAgICAgICAgLm1hcChlID0+IGUubmFtZSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm47IC8vIENhbid0IHJlYWQgZGlyZWN0b3J5IFx1MjAxNCBza2lwXG4gICAgfVxuXG4gICAgaWYgKGVudHJpZXMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICBjb25zdCBvcnBoYW5lZDogQXJyYXk8eyBoYXNoOiBzdHJpbmc7IGdpdFJvb3Q6IHN0cmluZzsgcmVtb3RlVXJsOiBzdHJpbmcgfT4gPSBbXTtcbiAgICBsZXQgdW5rbm93bkNvdW50ID0gMDtcblxuICAgIGZvciAoY29uc3QgaGFzaCBvZiBlbnRyaWVzKSB7XG4gICAgICBjb25zdCBkaXJQYXRoID0gam9pbihwcm9qZWN0c0RpciwgaGFzaCk7XG4gICAgICBjb25zdCBtZXRhID0gcmVhZFJlcG9NZXRhKGRpclBhdGgpO1xuICAgICAgaWYgKCFtZXRhKSB7XG4gICAgICAgIHVua25vd25Db3VudCsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmICghZXhpc3RzU3luYyhtZXRhLmdpdFJvb3QpKSB7XG4gICAgICAgIG9ycGhhbmVkLnB1c2goeyBoYXNoLCBnaXRSb290OiBtZXRhLmdpdFJvb3QsIHJlbW90ZVVybDogbWV0YS5yZW1vdGVVcmwgfSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKG9ycGhhbmVkLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuXG4gICAgY29uc3QgbGFiZWxzID0gb3JwaGFuZWQuc2xpY2UoMCwgMykubWFwKG8gPT4gby5naXRSb290KS5qb2luKFwiLCBcIik7XG4gICAgY29uc3Qgb3ZlcmZsb3cgPSBvcnBoYW5lZC5sZW5ndGggPiAzID8gYCAoKyR7b3JwaGFuZWQubGVuZ3RoIC0gM30gbW9yZSlgIDogXCJcIjtcbiAgICBjb25zdCB1bmtub3duTm90ZSA9IHVua25vd25Db3VudCA+IDAgPyBgIFx1MjAxNCAke3Vua25vd25Db3VudH0gYWRkaXRpb25hbCBkaXJlY3RvciR7dW5rbm93bkNvdW50ID09PSAxID8gXCJ5XCIgOiBcImllc1wifSBoYXZlIG5vIG1ldGFkYXRhIHlldCAob3BlbiB0aG9zZSByZXBvcyBvbmNlIHRvIHJlZ2lzdGVyIHRoZW0pYCA6IFwiXCI7XG5cbiAgICBpc3N1ZXMucHVzaCh7XG4gICAgICBzZXZlcml0eTogXCJpbmZvXCIsXG4gICAgICBjb2RlOiBcIm9ycGhhbmVkX3Byb2plY3Rfc3RhdGVcIixcbiAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgIHVuaXRJZDogXCJnbG9iYWxcIixcbiAgICAgIG1lc3NhZ2U6IGAke29ycGhhbmVkLmxlbmd0aH0gb3JwaGFuZWQgR1NEIHByb2plY3Qgc3RhdGUgZGlyZWN0b3Ike29ycGhhbmVkLmxlbmd0aCA9PT0gMSA/IFwieVwiIDogXCJpZXNcIn0gaW4gJHtwcm9qZWN0c0Rpcn0gd2hvc2UgZ2l0IHJvb3Qgbm8gbG9uZ2VyIGV4aXN0czogJHtsYWJlbHN9JHtvdmVyZmxvd30ke3Vua25vd25Ob3RlfS4gUnVuIC9nc2QgY2xlYW51cCBwcm9qZWN0cyB0byBhdWRpdCBvciAvZ3NkIGNsZWFudXAgcHJvamVjdHMgLS1maXggdG8gcmVjbGFpbSBkaXNrIHNwYWNlLmAsXG4gICAgICBmaWxlOiBwcm9qZWN0c0RpcixcbiAgICAgIGZpeGFibGU6IHRydWUsXG4gICAgfSk7XG5cbiAgICBpZiAoc2hvdWxkRml4KFwib3JwaGFuZWRfcHJvamVjdF9zdGF0ZVwiKSkge1xuICAgICAgbGV0IHJlbW92ZWQgPSAwO1xuICAgICAgZm9yIChjb25zdCB7IGhhc2ggfSBvZiBvcnBoYW5lZCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJtU3luYyhqb2luKHByb2plY3RzRGlyLCBoYXNoKSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgICAgIHJlbW92ZWQrKztcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLy8gSW5kaXZpZHVhbCByZW1vdmFsIGZhaWx1cmUgaXMgbm9uLWZhdGFsIFx1MjAxNCBjb250aW51ZSB3aXRoIHJlbWFpbmluZ1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBmaXhlc0FwcGxpZWQucHVzaChgcmVtb3ZlZCAke3JlbW92ZWR9IG9ycGhhbmVkIHByb2plY3Qgc3RhdGUgZGlyZWN0b3Ike3JlbW92ZWQgPT09IDEgPyBcInlcIiA6IFwiaWVzXCJ9IGZyb20gJHtwcm9qZWN0c0Rpcn1gKTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgZ2xvYmFsIGhlYWx0aCBjaGVjayBtdXN0IG5vdCBibG9jayBwZXItcHJvamVjdCBkb2N0b3JcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBUyxZQUFZLGFBQWEsY0FBYztBQUNoRCxTQUFTLFlBQVk7QUFHckIsU0FBUyxjQUFjLDRCQUE0QjtBQVluRCxlQUFzQixrQkFDcEIsUUFDQSxjQUNBLFdBQ2U7QUFDZixNQUFJO0FBQ0YsVUFBTSxjQUFjLHFCQUFxQjtBQUV6QyxRQUFJLENBQUMsV0FBVyxXQUFXLEVBQUc7QUFFOUIsUUFBSTtBQUNKLFFBQUk7QUFDRixnQkFBVSxZQUFZLGFBQWEsRUFBRSxlQUFlLEtBQUssQ0FBQyxFQUN2RCxPQUFPLE9BQUssRUFBRSxZQUFZLENBQUMsRUFDM0IsSUFBSSxPQUFLLEVBQUUsSUFBSTtBQUFBLElBQ3BCLFFBQVE7QUFDTjtBQUFBLElBQ0Y7QUFFQSxRQUFJLFFBQVEsV0FBVyxFQUFHO0FBRTFCLFVBQU0sV0FBd0UsQ0FBQztBQUMvRSxRQUFJLGVBQWU7QUFFbkIsZUFBVyxRQUFRLFNBQVM7QUFDMUIsWUFBTSxVQUFVLEtBQUssYUFBYSxJQUFJO0FBQ3RDLFlBQU0sT0FBTyxhQUFhLE9BQU87QUFDakMsVUFBSSxDQUFDLE1BQU07QUFDVDtBQUNBO0FBQUEsTUFDRjtBQUNBLFVBQUksQ0FBQyxXQUFXLEtBQUssT0FBTyxHQUFHO0FBQzdCLGlCQUFTLEtBQUssRUFBRSxNQUFNLFNBQVMsS0FBSyxTQUFTLFdBQVcsS0FBSyxVQUFVLENBQUM7QUFBQSxNQUMxRTtBQUFBLElBQ0Y7QUFFQSxRQUFJLFNBQVMsV0FBVyxFQUFHO0FBRTNCLFVBQU0sU0FBUyxTQUFTLE1BQU0sR0FBRyxDQUFDLEVBQUUsSUFBSSxPQUFLLEVBQUUsT0FBTyxFQUFFLEtBQUssSUFBSTtBQUNqRSxVQUFNLFdBQVcsU0FBUyxTQUFTLElBQUksTUFBTSxTQUFTLFNBQVMsQ0FBQyxXQUFXO0FBQzNFLFVBQU0sY0FBYyxlQUFlLElBQUksV0FBTSxZQUFZLHVCQUF1QixpQkFBaUIsSUFBSSxNQUFNLEtBQUssbUVBQW1FO0FBRW5MLFdBQU8sS0FBSztBQUFBLE1BQ1YsVUFBVTtBQUFBLE1BQ1YsTUFBTTtBQUFBLE1BQ04sT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsU0FBUyxHQUFHLFNBQVMsTUFBTSx1Q0FBdUMsU0FBUyxXQUFXLElBQUksTUFBTSxLQUFLLE9BQU8sV0FBVyxxQ0FBcUMsTUFBTSxHQUFHLFFBQVEsR0FBRyxXQUFXO0FBQUEsTUFDM0wsTUFBTTtBQUFBLE1BQ04sU0FBUztBQUFBLElBQ1gsQ0FBQztBQUVELFFBQUksVUFBVSx3QkFBd0IsR0FBRztBQUN2QyxVQUFJLFVBQVU7QUFDZCxpQkFBVyxFQUFFLEtBQUssS0FBSyxVQUFVO0FBQy9CLFlBQUk7QUFDRixpQkFBTyxLQUFLLGFBQWEsSUFBSSxHQUFHLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQ2hFO0FBQUEsUUFDRixRQUFRO0FBQUEsUUFFUjtBQUFBLE1BQ0Y7QUFDQSxtQkFBYSxLQUFLLFdBQVcsT0FBTyxtQ0FBbUMsWUFBWSxJQUFJLE1BQU0sS0FBSyxTQUFTLFdBQVcsRUFBRTtBQUFBLElBQzFIO0FBQUEsRUFDRixRQUFRO0FBQUEsRUFFUjtBQUNGOyIsCiAgIm5hbWVzIjogW10KfQo=
