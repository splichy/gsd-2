import { Type } from "@sinclair/typebox";
const STATE_DIR = ".gsd/browser-state";
function registerStatePersistenceTools(pi, deps) {
  pi.registerTool({
    name: "browser_save_state",
    label: "Browser Save State",
    description: "Save cookies, localStorage, and sessionStorage to disk so authenticated sessions survive browser restarts. State files are written to .gsd/browser-state/ and should be gitignored (may contain auth tokens). Never displays secret values in output.",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: "Name for the state file (default: 'default'). Used as the filename stem." })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { context: ctx, page: p } = await deps.ensureBrowser();
        const name = deps.sanitizeArtifactName(params.name ?? "default", "default");
        const { mkdir, writeFile } = await import("node:fs/promises");
        const path = await import("node:path");
        const stateDir = path.resolve(process.cwd(), STATE_DIR);
        await mkdir(stateDir, { recursive: true });
        const storageState = await ctx.storageState();
        const sessionStorageData = {};
        try {
          const origin = new URL(p.url()).origin;
          const ssData = await p.evaluate(() => {
            const data = {};
            for (let i = 0; i < sessionStorage.length; i++) {
              const key = sessionStorage.key(i);
              if (key) data[key] = sessionStorage.getItem(key) ?? "";
            }
            return data;
          });
          if (Object.keys(ssData).length > 0) {
            sessionStorageData[origin] = ssData;
          }
        } catch {
        }
        const combined = {
          storageState,
          sessionStorage: sessionStorageData,
          savedAt: (/* @__PURE__ */ new Date()).toISOString(),
          url: p.url()
        };
        const filePath = path.join(stateDir, `${name}.json`);
        await writeFile(filePath, JSON.stringify(combined, null, 2));
        const gitignorePath = path.resolve(process.cwd(), STATE_DIR, ".gitignore");
        await writeFile(gitignorePath, "*\n!.gitignore\n").catch(() => {
        });
        const cookieCount = storageState.cookies?.length ?? 0;
        const localStorageOrigins = storageState.origins?.length ?? 0;
        const sessionStorageOrigins = Object.keys(sessionStorageData).length;
        return {
          content: [{
            type: "text",
            text: `State saved: ${filePath}
Cookies: ${cookieCount}
localStorage origins: ${localStorageOrigins}
sessionStorage origins: ${sessionStorageOrigins}`
          }],
          details: {
            path: filePath,
            cookieCount,
            localStorageOrigins,
            sessionStorageOrigins
          }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Save state failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "browser_restore_state",
    label: "Browser Restore State",
    description: "Restore cookies, localStorage, and sessionStorage from a previously saved state file. Injects cookies via context.addCookies() and storage via page.evaluate(). For full fidelity, restore before navigating to the target site.",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: "Name of the state file to restore (default: 'default')." })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { context: ctx, page: p } = await deps.ensureBrowser();
        const name = deps.sanitizeArtifactName(params.name ?? "default", "default");
        const { readFile } = await import("node:fs/promises");
        const path = await import("node:path");
        const filePath = path.join(process.cwd(), STATE_DIR, `${name}.json`);
        let raw;
        try {
          raw = await readFile(filePath, "utf-8");
        } catch {
          return {
            content: [{ type: "text", text: `State file not found: ${filePath}` }],
            details: { error: "file_not_found", path: filePath },
            isError: true
          };
        }
        const combined = JSON.parse(raw);
        const storageState = combined.storageState;
        const sessionStorageData = combined.sessionStorage ?? {};
        let cookieCount = 0;
        if (storageState?.cookies?.length) {
          await ctx.addCookies(storageState.cookies);
          cookieCount = storageState.cookies.length;
        }
        let localStorageOrigins = 0;
        if (storageState?.origins?.length) {
          for (const origin of storageState.origins) {
            try {
              await p.evaluate((items) => {
                for (const { name: name2, value } of items) {
                  localStorage.setItem(name2, value);
                }
              }, origin.localStorage ?? []);
              localStorageOrigins++;
            } catch {
            }
          }
        }
        let sessionStorageOrigins = 0;
        for (const [_origin, data] of Object.entries(sessionStorageData)) {
          try {
            await p.evaluate((items) => {
              for (const [key, value] of Object.entries(items)) {
                sessionStorage.setItem(key, value);
              }
            }, data);
            sessionStorageOrigins++;
          } catch {
          }
        }
        return {
          content: [{
            type: "text",
            text: `State restored from: ${filePath}
Cookies: ${cookieCount}
localStorage origins: ${localStorageOrigins}
sessionStorage origins: ${sessionStorageOrigins}
Saved at: ${combined.savedAt ?? "unknown"}`
          }],
          details: {
            path: filePath,
            cookieCount,
            localStorageOrigins,
            sessionStorageOrigins,
            savedAt: combined.savedAt,
            savedUrl: combined.url
          }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Restore state failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
}
export {
  registerStatePersistenceTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvc3RhdGUtcGVyc2lzdGVuY2UudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgdHlwZSB7IFRvb2xEZXBzIH0gZnJvbSBcIi4uL3N0YXRlLmpzXCI7XG5cbi8qKlxuICogU3RhdGUgcGVyc2lzdGVuY2UgdG9vbHMgXHUyMDE0IHNhdmUvcmVzdG9yZSBjb29raWVzLCBsb2NhbFN0b3JhZ2UsIHNlc3Npb25TdG9yYWdlLlxuICovXG5cbmNvbnN0IFNUQVRFX0RJUiA9IFwiLmdzZC9icm93c2VyLXN0YXRlXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlclN0YXRlUGVyc2lzdGVuY2VUb29scyhwaTogRXh0ZW5zaW9uQVBJLCBkZXBzOiBUb29sRGVwcyk6IHZvaWQge1xuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdC8vIGJyb3dzZXJfc2F2ZV9zdGF0ZVxuXHQvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX3NhdmVfc3RhdGVcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIFNhdmUgU3RhdGVcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiU2F2ZSBjb29raWVzLCBsb2NhbFN0b3JhZ2UsIGFuZCBzZXNzaW9uU3RvcmFnZSB0byBkaXNrIHNvIGF1dGhlbnRpY2F0ZWQgc2Vzc2lvbnMgc3Vydml2ZSBicm93c2VyIHJlc3RhcnRzLiBcIiArXG5cdFx0XHRcIlN0YXRlIGZpbGVzIGFyZSB3cml0dGVuIHRvIC5nc2QvYnJvd3Nlci1zdGF0ZS8gYW5kIHNob3VsZCBiZSBnaXRpZ25vcmVkIChtYXkgY29udGFpbiBhdXRoIHRva2VucykuIFwiICtcblx0XHRcdFwiTmV2ZXIgZGlzcGxheXMgc2VjcmV0IHZhbHVlcyBpbiBvdXRwdXQuXCIsXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0bmFtZTogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJOYW1lIGZvciB0aGUgc3RhdGUgZmlsZSAoZGVmYXVsdDogJ2RlZmF1bHQnKS4gVXNlZCBhcyB0aGUgZmlsZW5hbWUgc3RlbS5cIiB9KSxcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBjb250ZXh0OiBjdHgsIHBhZ2U6IHAgfSA9IGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCBuYW1lID0gZGVwcy5zYW5pdGl6ZUFydGlmYWN0TmFtZShwYXJhbXMubmFtZSA/PyBcImRlZmF1bHRcIiwgXCJkZWZhdWx0XCIpO1xuXG5cdFx0XHRcdGNvbnN0IHsgbWtkaXIsIHdyaXRlRmlsZSB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTpmcy9wcm9taXNlc1wiKTtcblx0XHRcdFx0Y29uc3QgcGF0aCA9IGF3YWl0IGltcG9ydChcIm5vZGU6cGF0aFwiKTtcblx0XHRcdFx0Y29uc3Qgc3RhdGVEaXIgPSBwYXRoLnJlc29sdmUocHJvY2Vzcy5jd2QoKSwgU1RBVEVfRElSKTtcblx0XHRcdFx0YXdhaXQgbWtkaXIoc3RhdGVEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG5cdFx0XHRcdC8vIDEuIFBsYXl3cmlnaHQgc3RvcmFnZVN0YXRlOiBjb29raWVzICsgbG9jYWxTdG9yYWdlXG5cdFx0XHRcdGNvbnN0IHN0b3JhZ2VTdGF0ZSA9IGF3YWl0IGN0eC5zdG9yYWdlU3RhdGUoKTtcblxuXHRcdFx0XHQvLyAyLiBzZXNzaW9uU3RvcmFnZTogbXVzdCBiZSBleHRyYWN0ZWQgcGVyLW9yaWdpbiB2aWEgcGFnZS5ldmFsdWF0ZVxuXHRcdFx0XHRjb25zdCBzZXNzaW9uU3RvcmFnZURhdGE6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHN0cmluZz4+ID0ge307XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0Y29uc3Qgb3JpZ2luID0gbmV3IFVSTChwLnVybCgpKS5vcmlnaW47XG5cdFx0XHRcdFx0Y29uc3Qgc3NEYXRhID0gYXdhaXQgcC5ldmFsdWF0ZSgoKSA9PiB7XG5cdFx0XHRcdFx0XHRjb25zdCBkYXRhOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG5cdFx0XHRcdFx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHNlc3Npb25TdG9yYWdlLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGtleSA9IHNlc3Npb25TdG9yYWdlLmtleShpKTtcblx0XHRcdFx0XHRcdFx0aWYgKGtleSkgZGF0YVtrZXldID0gc2Vzc2lvblN0b3JhZ2UuZ2V0SXRlbShrZXkpID8/IFwiXCI7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRyZXR1cm4gZGF0YTtcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRpZiAoT2JqZWN0LmtleXMoc3NEYXRhKS5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0XHRzZXNzaW9uU3RvcmFnZURhdGFbb3JpZ2luXSA9IHNzRGF0YTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdC8vIFBhZ2UgbWF5IG5vdCBoYXZlIGEgdmFsaWQgb3JpZ2luIChhYm91dDpibGFuaywgZXRjLilcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGNvbWJpbmVkID0ge1xuXHRcdFx0XHRcdHN0b3JhZ2VTdGF0ZSxcblx0XHRcdFx0XHRzZXNzaW9uU3RvcmFnZTogc2Vzc2lvblN0b3JhZ2VEYXRhLFxuXHRcdFx0XHRcdHNhdmVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRcdFx0XHR1cmw6IHAudXJsKCksXG5cdFx0XHRcdH07XG5cblx0XHRcdFx0Y29uc3QgZmlsZVBhdGggPSBwYXRoLmpvaW4oc3RhdGVEaXIsIGAke25hbWV9Lmpzb25gKTtcblx0XHRcdFx0YXdhaXQgd3JpdGVGaWxlKGZpbGVQYXRoLCBKU09OLnN0cmluZ2lmeShjb21iaW5lZCwgbnVsbCwgMikpO1xuXG5cdFx0XHRcdC8vIEVuc3VyZSAuZ2l0aWdub3JlIGNvdmVycyB0aGUgc3RhdGUgZGlyXG5cdFx0XHRcdGNvbnN0IGdpdGlnbm9yZVBhdGggPSBwYXRoLnJlc29sdmUocHJvY2Vzcy5jd2QoKSwgU1RBVEVfRElSLCBcIi5naXRpZ25vcmVcIik7XG5cdFx0XHRcdGF3YWl0IHdyaXRlRmlsZShnaXRpZ25vcmVQYXRoLCBcIipcXG4hLmdpdGlnbm9yZVxcblwiKS5jYXRjaCgoKSA9PiB7IC8qIGJlc3QtZWZmb3J0IFx1MjAxNCAuZ2l0aWdub3JlIG1heSBhbHJlYWR5IGV4aXN0IG9yIGRpciBtYXkgYmUgcmVhZC1vbmx5ICovIH0pO1xuXG5cdFx0XHRcdGNvbnN0IGNvb2tpZUNvdW50ID0gc3RvcmFnZVN0YXRlLmNvb2tpZXM/Lmxlbmd0aCA/PyAwO1xuXHRcdFx0XHRjb25zdCBsb2NhbFN0b3JhZ2VPcmlnaW5zID0gc3RvcmFnZVN0YXRlLm9yaWdpbnM/Lmxlbmd0aCA/PyAwO1xuXHRcdFx0XHRjb25zdCBzZXNzaW9uU3RvcmFnZU9yaWdpbnMgPSBPYmplY3Qua2V5cyhzZXNzaW9uU3RvcmFnZURhdGEpLmxlbmd0aDtcblxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdHRleHQ6IGBTdGF0ZSBzYXZlZDogJHtmaWxlUGF0aH1cXG5Db29raWVzOiAke2Nvb2tpZUNvdW50fVxcbmxvY2FsU3RvcmFnZSBvcmlnaW5zOiAke2xvY2FsU3RvcmFnZU9yaWdpbnN9XFxuc2Vzc2lvblN0b3JhZ2Ugb3JpZ2luczogJHtzZXNzaW9uU3RvcmFnZU9yaWdpbnN9YCxcblx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7XG5cdFx0XHRcdFx0XHRwYXRoOiBmaWxlUGF0aCxcblx0XHRcdFx0XHRcdGNvb2tpZUNvdW50LFxuXHRcdFx0XHRcdFx0bG9jYWxTdG9yYWdlT3JpZ2lucyxcblx0XHRcdFx0XHRcdHNlc3Npb25TdG9yYWdlT3JpZ2lucyxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFNhdmUgc3RhdGUgZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xuXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0Ly8gYnJvd3Nlcl9yZXN0b3JlX3N0YXRlXG5cdC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblx0cGkucmVnaXN0ZXJUb29sKHtcblx0XHRuYW1lOiBcImJyb3dzZXJfcmVzdG9yZV9zdGF0ZVwiLFxuXHRcdGxhYmVsOiBcIkJyb3dzZXIgUmVzdG9yZSBTdGF0ZVwiLFxuXHRcdGRlc2NyaXB0aW9uOlxuXHRcdFx0XCJSZXN0b3JlIGNvb2tpZXMsIGxvY2FsU3RvcmFnZSwgYW5kIHNlc3Npb25TdG9yYWdlIGZyb20gYSBwcmV2aW91c2x5IHNhdmVkIHN0YXRlIGZpbGUuIFwiICtcblx0XHRcdFwiSW5qZWN0cyBjb29raWVzIHZpYSBjb250ZXh0LmFkZENvb2tpZXMoKSBhbmQgc3RvcmFnZSB2aWEgcGFnZS5ldmFsdWF0ZSgpLiBcIiArXG5cdFx0XHRcIkZvciBmdWxsIGZpZGVsaXR5LCByZXN0b3JlIGJlZm9yZSBuYXZpZ2F0aW5nIHRvIHRoZSB0YXJnZXQgc2l0ZS5cIixcblx0XHRwYXJhbWV0ZXJzOiBUeXBlLk9iamVjdCh7XG5cdFx0XHRuYW1lOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk5hbWUgb2YgdGhlIHN0YXRlIGZpbGUgdG8gcmVzdG9yZSAoZGVmYXVsdDogJ2RlZmF1bHQnKS5cIiB9KSxcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBjb250ZXh0OiBjdHgsIHBhZ2U6IHAgfSA9IGF3YWl0IGRlcHMuZW5zdXJlQnJvd3NlcigpO1xuXHRcdFx0XHRjb25zdCBuYW1lID0gZGVwcy5zYW5pdGl6ZUFydGlmYWN0TmFtZShwYXJhbXMubmFtZSA/PyBcImRlZmF1bHRcIiwgXCJkZWZhdWx0XCIpO1xuXG5cdFx0XHRcdGNvbnN0IHsgcmVhZEZpbGUgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6ZnMvcHJvbWlzZXNcIik7XG5cdFx0XHRcdGNvbnN0IHBhdGggPSBhd2FpdCBpbXBvcnQoXCJub2RlOnBhdGhcIik7XG5cdFx0XHRcdGNvbnN0IGZpbGVQYXRoID0gcGF0aC5qb2luKHByb2Nlc3MuY3dkKCksIFNUQVRFX0RJUiwgYCR7bmFtZX0uanNvbmApO1xuXG5cdFx0XHRcdGxldCByYXc6IHN0cmluZztcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRyYXcgPSBhd2FpdCByZWFkRmlsZShmaWxlUGF0aCwgXCJ1dGYtOFwiKTtcblx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgU3RhdGUgZmlsZSBub3QgZm91bmQ6ICR7ZmlsZVBhdGh9YCB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgZXJyb3I6IFwiZmlsZV9ub3RfZm91bmRcIiwgcGF0aDogZmlsZVBhdGggfSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGNvbWJpbmVkID0gSlNPTi5wYXJzZShyYXcpO1xuXHRcdFx0XHRjb25zdCBzdG9yYWdlU3RhdGUgPSBjb21iaW5lZC5zdG9yYWdlU3RhdGU7XG5cdFx0XHRcdGNvbnN0IHNlc3Npb25TdG9yYWdlRGF0YTogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgc3RyaW5nPj4gPSBjb21iaW5lZC5zZXNzaW9uU3RvcmFnZSA/PyB7fTtcblxuXHRcdFx0XHQvLyAxLiBSZXN0b3JlIGNvb2tpZXNcblx0XHRcdFx0bGV0IGNvb2tpZUNvdW50ID0gMDtcblx0XHRcdFx0aWYgKHN0b3JhZ2VTdGF0ZT8uY29va2llcz8ubGVuZ3RoKSB7XG5cdFx0XHRcdFx0YXdhaXQgY3R4LmFkZENvb2tpZXMoc3RvcmFnZVN0YXRlLmNvb2tpZXMpO1xuXHRcdFx0XHRcdGNvb2tpZUNvdW50ID0gc3RvcmFnZVN0YXRlLmNvb2tpZXMubGVuZ3RoO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gMi4gUmVzdG9yZSBsb2NhbFN0b3JhZ2UgdmlhIHBhZ2UuZXZhbHVhdGVcblx0XHRcdFx0bGV0IGxvY2FsU3RvcmFnZU9yaWdpbnMgPSAwO1xuXHRcdFx0XHRpZiAoc3RvcmFnZVN0YXRlPy5vcmlnaW5zPy5sZW5ndGgpIHtcblx0XHRcdFx0XHRmb3IgKGNvbnN0IG9yaWdpbiBvZiBzdG9yYWdlU3RhdGUub3JpZ2lucykge1xuXHRcdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdFx0YXdhaXQgcC5ldmFsdWF0ZSgoaXRlbXM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyB2YWx1ZTogc3RyaW5nIH0+KSA9PiB7XG5cdFx0XHRcdFx0XHRcdFx0Zm9yIChjb25zdCB7IG5hbWUsIHZhbHVlIH0gb2YgaXRlbXMpIHtcblx0XHRcdFx0XHRcdFx0XHRcdGxvY2FsU3RvcmFnZS5zZXRJdGVtKG5hbWUsIHZhbHVlKTtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdH0sIG9yaWdpbi5sb2NhbFN0b3JhZ2UgPz8gW10pO1xuXHRcdFx0XHRcdFx0XHRsb2NhbFN0b3JhZ2VPcmlnaW5zKys7XG5cdFx0XHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRcdFx0Ly8gT3JpZ2luIG1pc21hdGNoIFx1MjAxNCBsb2NhbFN0b3JhZ2UgY2FuIG9ubHkgYmUgc2V0IG9uIG1hdGNoaW5nIG9yaWdpblxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIDMuIFJlc3RvcmUgc2Vzc2lvblN0b3JhZ2UgdmlhIHBhZ2UuZXZhbHVhdGVcblx0XHRcdFx0bGV0IHNlc3Npb25TdG9yYWdlT3JpZ2lucyA9IDA7XG5cdFx0XHRcdGZvciAoY29uc3QgW19vcmlnaW4sIGRhdGFdIG9mIE9iamVjdC5lbnRyaWVzKHNlc3Npb25TdG9yYWdlRGF0YSkpIHtcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0YXdhaXQgcC5ldmFsdWF0ZSgoaXRlbXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4pID0+IHtcblx0XHRcdFx0XHRcdFx0Zm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoaXRlbXMpKSB7XG5cdFx0XHRcdFx0XHRcdFx0c2Vzc2lvblN0b3JhZ2Uuc2V0SXRlbShrZXksIHZhbHVlKTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fSwgZGF0YSk7XG5cdFx0XHRcdFx0XHRzZXNzaW9uU3RvcmFnZU9yaWdpbnMrKztcblx0XHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHRcdC8vIE9yaWdpbiBtaXNtYXRjaFxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3tcblx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0dGV4dDogYFN0YXRlIHJlc3RvcmVkIGZyb206ICR7ZmlsZVBhdGh9XFxuQ29va2llczogJHtjb29raWVDb3VudH1cXG5sb2NhbFN0b3JhZ2Ugb3JpZ2luczogJHtsb2NhbFN0b3JhZ2VPcmlnaW5zfVxcbnNlc3Npb25TdG9yYWdlIG9yaWdpbnM6ICR7c2Vzc2lvblN0b3JhZ2VPcmlnaW5zfVxcblNhdmVkIGF0OiAke2NvbWJpbmVkLnNhdmVkQXQgPz8gXCJ1bmtub3duXCJ9YCxcblx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7XG5cdFx0XHRcdFx0XHRwYXRoOiBmaWxlUGF0aCxcblx0XHRcdFx0XHRcdGNvb2tpZUNvdW50LFxuXHRcdFx0XHRcdFx0bG9jYWxTdG9yYWdlT3JpZ2lucyxcblx0XHRcdFx0XHRcdHNlc3Npb25TdG9yYWdlT3JpZ2lucyxcblx0XHRcdFx0XHRcdHNhdmVkQXQ6IGNvbWJpbmVkLnNhdmVkQXQsXG5cdFx0XHRcdFx0XHRzYXZlZFVybDogY29tYmluZWQudXJsLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgUmVzdG9yZSBzdGF0ZSBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCB9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiBlcnIubWVzc2FnZSB9LFxuXHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLFlBQVk7QUFPckIsTUFBTSxZQUFZO0FBRVgsU0FBUyw4QkFBOEIsSUFBa0IsTUFBc0I7QUFJckYsS0FBRyxhQUFhO0FBQUEsSUFDZixNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUNDO0FBQUEsSUFHRCxZQUFZLEtBQUssT0FBTztBQUFBLE1BQ3ZCLE1BQU0sS0FBSztBQUFBLFFBQ1YsS0FBSyxPQUFPLEVBQUUsYUFBYSwyRUFBMkUsQ0FBQztBQUFBLE1BQ3hHO0FBQUEsSUFDRCxDQUFDO0FBQUEsSUFFRCxNQUFNLFFBQVEsYUFBYSxRQUFRLFNBQVMsV0FBVyxNQUFNO0FBQzVELFVBQUk7QUFDSCxjQUFNLEVBQUUsU0FBUyxLQUFLLE1BQU0sRUFBRSxJQUFJLE1BQU0sS0FBSyxjQUFjO0FBQzNELGNBQU0sT0FBTyxLQUFLLHFCQUFxQixPQUFPLFFBQVEsV0FBVyxTQUFTO0FBRTFFLGNBQU0sRUFBRSxPQUFPLFVBQVUsSUFBSSxNQUFNLE9BQU8sa0JBQWtCO0FBQzVELGNBQU0sT0FBTyxNQUFNLE9BQU8sV0FBVztBQUNyQyxjQUFNLFdBQVcsS0FBSyxRQUFRLFFBQVEsSUFBSSxHQUFHLFNBQVM7QUFDdEQsY0FBTSxNQUFNLFVBQVUsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUd6QyxjQUFNLGVBQWUsTUFBTSxJQUFJLGFBQWE7QUFHNUMsY0FBTSxxQkFBNkQsQ0FBQztBQUNwRSxZQUFJO0FBQ0gsZ0JBQU0sU0FBUyxJQUFJLElBQUksRUFBRSxJQUFJLENBQUMsRUFBRTtBQUNoQyxnQkFBTSxTQUFTLE1BQU0sRUFBRSxTQUFTLE1BQU07QUFDckMsa0JBQU0sT0FBK0IsQ0FBQztBQUN0QyxxQkFBUyxJQUFJLEdBQUcsSUFBSSxlQUFlLFFBQVEsS0FBSztBQUMvQyxvQkFBTSxNQUFNLGVBQWUsSUFBSSxDQUFDO0FBQ2hDLGtCQUFJLElBQUssTUFBSyxHQUFHLElBQUksZUFBZSxRQUFRLEdBQUcsS0FBSztBQUFBLFlBQ3JEO0FBQ0EsbUJBQU87QUFBQSxVQUNSLENBQUM7QUFDRCxjQUFJLE9BQU8sS0FBSyxNQUFNLEVBQUUsU0FBUyxHQUFHO0FBQ25DLCtCQUFtQixNQUFNLElBQUk7QUFBQSxVQUM5QjtBQUFBLFFBQ0QsUUFBUTtBQUFBLFFBRVI7QUFFQSxjQUFNLFdBQVc7QUFBQSxVQUNoQjtBQUFBLFVBQ0EsZ0JBQWdCO0FBQUEsVUFDaEIsVUFBUyxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLFVBQ2hDLEtBQUssRUFBRSxJQUFJO0FBQUEsUUFDWjtBQUVBLGNBQU0sV0FBVyxLQUFLLEtBQUssVUFBVSxHQUFHLElBQUksT0FBTztBQUNuRCxjQUFNLFVBQVUsVUFBVSxLQUFLLFVBQVUsVUFBVSxNQUFNLENBQUMsQ0FBQztBQUczRCxjQUFNLGdCQUFnQixLQUFLLFFBQVEsUUFBUSxJQUFJLEdBQUcsV0FBVyxZQUFZO0FBQ3pFLGNBQU0sVUFBVSxlQUFlLGtCQUFrQixFQUFFLE1BQU0sTUFBTTtBQUFBLFFBQTJFLENBQUM7QUFFM0ksY0FBTSxjQUFjLGFBQWEsU0FBUyxVQUFVO0FBQ3BELGNBQU0sc0JBQXNCLGFBQWEsU0FBUyxVQUFVO0FBQzVELGNBQU0sd0JBQXdCLE9BQU8sS0FBSyxrQkFBa0IsRUFBRTtBQUU5RCxlQUFPO0FBQUEsVUFDTixTQUFTLENBQUM7QUFBQSxZQUNULE1BQU07QUFBQSxZQUNOLE1BQU0sZ0JBQWdCLFFBQVE7QUFBQSxXQUFjLFdBQVc7QUFBQSx3QkFBMkIsbUJBQW1CO0FBQUEsMEJBQTZCLHFCQUFxQjtBQUFBLFVBQ3hKLENBQUM7QUFBQSxVQUNELFNBQVM7QUFBQSxZQUNSLE1BQU07QUFBQSxZQUNOO0FBQUEsWUFDQTtBQUFBLFlBQ0E7QUFBQSxVQUNEO0FBQUEsUUFDRDtBQUFBLE1BQ0QsU0FBUyxLQUFVO0FBQ2xCLGVBQU87QUFBQSxVQUNOLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLHNCQUFzQixJQUFJLE9BQU8sR0FBRyxDQUFDO0FBQUEsVUFDckUsU0FBUyxFQUFFLE9BQU8sSUFBSSxRQUFRO0FBQUEsVUFDOUIsU0FBUztBQUFBLFFBQ1Y7QUFBQSxNQUNEO0FBQUEsSUFDRDtBQUFBLEVBQ0QsQ0FBQztBQUtELEtBQUcsYUFBYTtBQUFBLElBQ2YsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDQztBQUFBLElBR0QsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN2QixNQUFNLEtBQUs7QUFBQSxRQUNWLEtBQUssT0FBTyxFQUFFLGFBQWEsMERBQTBELENBQUM7QUFBQSxNQUN2RjtBQUFBLElBQ0QsQ0FBQztBQUFBLElBRUQsTUFBTSxRQUFRLGFBQWEsUUFBUSxTQUFTLFdBQVcsTUFBTTtBQUM1RCxVQUFJO0FBQ0gsY0FBTSxFQUFFLFNBQVMsS0FBSyxNQUFNLEVBQUUsSUFBSSxNQUFNLEtBQUssY0FBYztBQUMzRCxjQUFNLE9BQU8sS0FBSyxxQkFBcUIsT0FBTyxRQUFRLFdBQVcsU0FBUztBQUUxRSxjQUFNLEVBQUUsU0FBUyxJQUFJLE1BQU0sT0FBTyxrQkFBa0I7QUFDcEQsY0FBTSxPQUFPLE1BQU0sT0FBTyxXQUFXO0FBQ3JDLGNBQU0sV0FBVyxLQUFLLEtBQUssUUFBUSxJQUFJLEdBQUcsV0FBVyxHQUFHLElBQUksT0FBTztBQUVuRSxZQUFJO0FBQ0osWUFBSTtBQUNILGdCQUFNLE1BQU0sU0FBUyxVQUFVLE9BQU87QUFBQSxRQUN2QyxRQUFRO0FBQ1AsaUJBQU87QUFBQSxZQUNOLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBUSxNQUFNLHlCQUF5QixRQUFRLEdBQUcsQ0FBQztBQUFBLFlBQ3JFLFNBQVMsRUFBRSxPQUFPLGtCQUFrQixNQUFNLFNBQVM7QUFBQSxZQUNuRCxTQUFTO0FBQUEsVUFDVjtBQUFBLFFBQ0Q7QUFFQSxjQUFNLFdBQVcsS0FBSyxNQUFNLEdBQUc7QUFDL0IsY0FBTSxlQUFlLFNBQVM7QUFDOUIsY0FBTSxxQkFBNkQsU0FBUyxrQkFBa0IsQ0FBQztBQUcvRixZQUFJLGNBQWM7QUFDbEIsWUFBSSxjQUFjLFNBQVMsUUFBUTtBQUNsQyxnQkFBTSxJQUFJLFdBQVcsYUFBYSxPQUFPO0FBQ3pDLHdCQUFjLGFBQWEsUUFBUTtBQUFBLFFBQ3BDO0FBR0EsWUFBSSxzQkFBc0I7QUFDMUIsWUFBSSxjQUFjLFNBQVMsUUFBUTtBQUNsQyxxQkFBVyxVQUFVLGFBQWEsU0FBUztBQUMxQyxnQkFBSTtBQUNILG9CQUFNLEVBQUUsU0FBUyxDQUFDLFVBQWtEO0FBQ25FLDJCQUFXLEVBQUUsTUFBQUEsT0FBTSxNQUFNLEtBQUssT0FBTztBQUNwQywrQkFBYSxRQUFRQSxPQUFNLEtBQUs7QUFBQSxnQkFDakM7QUFBQSxjQUNELEdBQUcsT0FBTyxnQkFBZ0IsQ0FBQyxDQUFDO0FBQzVCO0FBQUEsWUFDRCxRQUFRO0FBQUEsWUFFUjtBQUFBLFVBQ0Q7QUFBQSxRQUNEO0FBR0EsWUFBSSx3QkFBd0I7QUFDNUIsbUJBQVcsQ0FBQyxTQUFTLElBQUksS0FBSyxPQUFPLFFBQVEsa0JBQWtCLEdBQUc7QUFDakUsY0FBSTtBQUNILGtCQUFNLEVBQUUsU0FBUyxDQUFDLFVBQWtDO0FBQ25ELHlCQUFXLENBQUMsS0FBSyxLQUFLLEtBQUssT0FBTyxRQUFRLEtBQUssR0FBRztBQUNqRCwrQkFBZSxRQUFRLEtBQUssS0FBSztBQUFBLGNBQ2xDO0FBQUEsWUFDRCxHQUFHLElBQUk7QUFDUDtBQUFBLFVBQ0QsUUFBUTtBQUFBLFVBRVI7QUFBQSxRQUNEO0FBRUEsZUFBTztBQUFBLFVBQ04sU0FBUyxDQUFDO0FBQUEsWUFDVCxNQUFNO0FBQUEsWUFDTixNQUFNLHdCQUF3QixRQUFRO0FBQUEsV0FBYyxXQUFXO0FBQUEsd0JBQTJCLG1CQUFtQjtBQUFBLDBCQUE2QixxQkFBcUI7QUFBQSxZQUFlLFNBQVMsV0FBVyxTQUFTO0FBQUEsVUFDNU0sQ0FBQztBQUFBLFVBQ0QsU0FBUztBQUFBLFlBQ1IsTUFBTTtBQUFBLFlBQ047QUFBQSxZQUNBO0FBQUEsWUFDQTtBQUFBLFlBQ0EsU0FBUyxTQUFTO0FBQUEsWUFDbEIsVUFBVSxTQUFTO0FBQUEsVUFDcEI7QUFBQSxRQUNEO0FBQUEsTUFDRCxTQUFTLEtBQVU7QUFDbEIsZUFBTztBQUFBLFVBQ04sU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFRLE1BQU0seUJBQXlCLElBQUksT0FBTyxHQUFHLENBQUM7QUFBQSxVQUN4RSxTQUFTLEVBQUUsT0FBTyxJQUFJLFFBQVE7QUFBQSxVQUM5QixTQUFTO0FBQUEsUUFDVjtBQUFBLE1BQ0Q7QUFBQSxJQUNEO0FBQUEsRUFDRCxDQUFDO0FBQ0Y7IiwKICAibmFtZXMiOiBbIm5hbWUiXQp9Cg==
