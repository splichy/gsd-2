let _createServer = null;
let _httpImportPromise = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
  _httpImportPromise = import("node:http").then((m) => {
    _createServer = m.createServer;
  });
}
async function getNodeCreateServer(providerName) {
  if (_createServer) return _createServer;
  if (_httpImportPromise) {
    await _httpImportPromise;
  }
  if (_createServer) return _createServer;
  throw new Error(`${providerName} OAuth is only available in Node.js environments`);
}
async function startCallbackServer(port, callbackPath, providerName) {
  const createServer = await getNodeCreateServer(providerName);
  return new Promise((resolve, reject) => {
    let result = null;
    let cancelled = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url || "", `http://localhost:${port}`);
      if (url.pathname === callbackPath) {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h1>Authentication Failed</h1><p>Error: ${error}</p><p>You can close this window.</p></body></html>`
          );
          return;
        }
        if (code && state) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h1>Authentication Successful</h1><p>You can close this window and return to the terminal.</p></body></html>`
          );
          result = { code, state };
        } else {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h1>Authentication Failed</h1><p>Missing code or state parameter.</p></body></html>`
          );
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.on("error", (err) => {
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        cancelWait: () => {
          cancelled = true;
        },
        waitForCode: async () => {
          const sleep = () => new Promise((r) => setTimeout(r, 100));
          while (!result && !cancelled) {
            await sleep();
          }
          return result;
        }
      });
    });
  });
}
function parseRedirectUrl(input) {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? void 0,
      state: url.searchParams.get("state") ?? void 0
    };
  } catch {
    return {};
  }
}
async function getGoogleUserEmail(accessToken) {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      signal: AbortSignal.timeout(3e4)
    });
    if (response.ok) {
      const data = await response.json();
      return data.email;
    }
  } catch {
  }
  return void 0;
}
async function refreshGoogleOAuthToken(refreshToken, clientId, clientSecret, providerName, extraFields) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }),
    signal: AbortSignal.timeout(3e4)
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`${providerName} token refresh failed: ${error}`);
  }
  const data = await response.json();
  return {
    refresh: data.refresh_token || refreshToken,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1e3 - 5 * 60 * 1e3,
    ...extraFields
  };
}
export {
  getGoogleUserEmail,
  parseRedirectUrl,
  refreshGoogleOAuthToken,
  startCallbackServer
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3V0aWxzL29hdXRoL2dvb2dsZS1vYXV0aC11dGlscy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBTaGFyZWQgdXRpbGl0aWVzIGZvciBHb29nbGUgT0F1dGggcHJvdmlkZXJzIChHZW1pbmkgQ0xJIGFuZCBBbnRpZ3Jhdml0eSkuXG4gKlxuICogTk9URTogVGhpcyBtb2R1bGUgdXNlcyBOb2RlLmpzIGh0dHAuY3JlYXRlU2VydmVyIGZvciB0aGUgT0F1dGggY2FsbGJhY2suXG4gKiBJdCBpcyBvbmx5IGludGVuZGVkIGZvciBDTEkgdXNlLCBub3QgYnJvd3NlciBlbnZpcm9ubWVudHMuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTZXJ2ZXIgfSBmcm9tIFwibm9kZTpodHRwXCI7XG5pbXBvcnQgdHlwZSB7IE9BdXRoQ3JlZGVudGlhbHMgfSBmcm9tIFwiLi90eXBlcy5qc1wiO1xuXG4vLyBMYXp5LWxvYWRlZCBodHRwLmNyZWF0ZVNlcnZlciBmb3IgTm9kZS5qcyBlbnZpcm9ubWVudHNcbmxldCBfY3JlYXRlU2VydmVyOiB0eXBlb2YgaW1wb3J0KFwibm9kZTpodHRwXCIpLmNyZWF0ZVNlcnZlciB8IG51bGwgPSBudWxsO1xubGV0IF9odHRwSW1wb3J0UHJvbWlzZTogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xuaWYgKHR5cGVvZiBwcm9jZXNzICE9PSBcInVuZGVmaW5lZFwiICYmIChwcm9jZXNzLnZlcnNpb25zPy5ub2RlIHx8IHByb2Nlc3MudmVyc2lvbnM/LmJ1bikpIHtcblx0X2h0dHBJbXBvcnRQcm9taXNlID0gaW1wb3J0KFwibm9kZTpodHRwXCIpLnRoZW4oKG0pID0+IHtcblx0XHRfY3JlYXRlU2VydmVyID0gbS5jcmVhdGVTZXJ2ZXI7XG5cdH0pO1xufVxuXG5leHBvcnQgdHlwZSBDYWxsYmFja1NlcnZlckluZm8gPSB7XG5cdHNlcnZlcjogU2VydmVyO1xuXHRjYW5jZWxXYWl0OiAoKSA9PiB2b2lkO1xuXHR3YWl0Rm9yQ29kZTogKCkgPT4gUHJvbWlzZTx7IGNvZGU6IHN0cmluZzsgc3RhdGU6IHN0cmluZyB9IHwgbnVsbD47XG59O1xuXG4vKipcbiAqIEdldCB0aGUgbGF6aWx5IGltcG9ydGVkIE5vZGUuanMgY3JlYXRlU2VydmVyIGZ1bmN0aW9uLlxuICogVGhyb3dzIGlmIG5vdCBydW5uaW5nIGluIGEgTm9kZS5qcyBlbnZpcm9ubWVudC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2V0Tm9kZUNyZWF0ZVNlcnZlcihcblx0cHJvdmlkZXJOYW1lOiBzdHJpbmcsXG4pOiBQcm9taXNlPHR5cGVvZiBpbXBvcnQoXCJub2RlOmh0dHBcIikuY3JlYXRlU2VydmVyPiB7XG5cdGlmIChfY3JlYXRlU2VydmVyKSByZXR1cm4gX2NyZWF0ZVNlcnZlcjtcblx0aWYgKF9odHRwSW1wb3J0UHJvbWlzZSkge1xuXHRcdGF3YWl0IF9odHRwSW1wb3J0UHJvbWlzZTtcblx0fVxuXHRpZiAoX2NyZWF0ZVNlcnZlcikgcmV0dXJuIF9jcmVhdGVTZXJ2ZXI7XG5cdHRocm93IG5ldyBFcnJvcihgJHtwcm92aWRlck5hbWV9IE9BdXRoIGlzIG9ubHkgYXZhaWxhYmxlIGluIE5vZGUuanMgZW52aXJvbm1lbnRzYCk7XG59XG5cbi8qKlxuICogU3RhcnQgYSBsb2NhbCBIVFRQIHNlcnZlciB0byByZWNlaXZlIHRoZSBPQXV0aCBjYWxsYmFjay5cbiAqXG4gKiBAcGFyYW0gcG9ydCAtIFRoZSBwb3J0IHRvIGxpc3RlbiBvbiAoZS5nLiA4MDg1LCA1MTEyMSlcbiAqIEBwYXJhbSBjYWxsYmFja1BhdGggLSBUaGUgVVJMIHBhdGggZm9yIHRoZSBjYWxsYmFjayAoZS5nLiBcIi9vYXV0aDJjYWxsYmFja1wiLCBcIi9vYXV0aC1jYWxsYmFja1wiKVxuICogQHBhcmFtIHByb3ZpZGVyTmFtZSAtIEh1bWFuLXJlYWRhYmxlIHByb3ZpZGVyIG5hbWUgZm9yIGVycm9yIG1lc3NhZ2VzXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdGFydENhbGxiYWNrU2VydmVyKFxuXHRwb3J0OiBudW1iZXIsXG5cdGNhbGxiYWNrUGF0aDogc3RyaW5nLFxuXHRwcm92aWRlck5hbWU6IHN0cmluZyxcbik6IFByb21pc2U8Q2FsbGJhY2tTZXJ2ZXJJbmZvPiB7XG5cdGNvbnN0IGNyZWF0ZVNlcnZlciA9IGF3YWl0IGdldE5vZGVDcmVhdGVTZXJ2ZXIocHJvdmlkZXJOYW1lKTtcblxuXHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdGxldCByZXN1bHQ6IHsgY29kZTogc3RyaW5nOyBzdGF0ZTogc3RyaW5nIH0gfCBudWxsID0gbnVsbDtcblx0XHRsZXQgY2FuY2VsbGVkID0gZmFsc2U7XG5cblx0XHRjb25zdCBzZXJ2ZXIgPSBjcmVhdGVTZXJ2ZXIoKHJlcSwgcmVzKSA9PiB7XG5cdFx0XHRjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwgfHwgXCJcIiwgYGh0dHA6Ly9sb2NhbGhvc3Q6JHtwb3J0fWApO1xuXG5cdFx0XHRpZiAodXJsLnBhdGhuYW1lID09PSBjYWxsYmFja1BhdGgpIHtcblx0XHRcdFx0Y29uc3QgY29kZSA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiY29kZVwiKTtcblx0XHRcdFx0Y29uc3Qgc3RhdGUgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcInN0YXRlXCIpO1xuXHRcdFx0XHRjb25zdCBlcnJvciA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiZXJyb3JcIik7XG5cblx0XHRcdFx0aWYgKGVycm9yKSB7XG5cdFx0XHRcdFx0cmVzLndyaXRlSGVhZCg0MDAsIHsgXCJDb250ZW50LVR5cGVcIjogXCJ0ZXh0L2h0bWxcIiB9KTtcblx0XHRcdFx0XHRyZXMuZW5kKFxuXHRcdFx0XHRcdFx0YDxodG1sPjxib2R5PjxoMT5BdXRoZW50aWNhdGlvbiBGYWlsZWQ8L2gxPjxwPkVycm9yOiAke2Vycm9yfTwvcD48cD5Zb3UgY2FuIGNsb3NlIHRoaXMgd2luZG93LjwvcD48L2JvZHk+PC9odG1sPmAsXG5cdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoY29kZSAmJiBzdGF0ZSkge1xuXHRcdFx0XHRcdHJlcy53cml0ZUhlYWQoMjAwLCB7IFwiQ29udGVudC1UeXBlXCI6IFwidGV4dC9odG1sXCIgfSk7XG5cdFx0XHRcdFx0cmVzLmVuZChcblx0XHRcdFx0XHRcdGA8aHRtbD48Ym9keT48aDE+QXV0aGVudGljYXRpb24gU3VjY2Vzc2Z1bDwvaDE+PHA+WW91IGNhbiBjbG9zZSB0aGlzIHdpbmRvdyBhbmQgcmV0dXJuIHRvIHRoZSB0ZXJtaW5hbC48L3A+PC9ib2R5PjwvaHRtbD5gLFxuXHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0cmVzdWx0ID0geyBjb2RlLCBzdGF0ZSB9O1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdHJlcy53cml0ZUhlYWQoNDAwLCB7IFwiQ29udGVudC1UeXBlXCI6IFwidGV4dC9odG1sXCIgfSk7XG5cdFx0XHRcdFx0cmVzLmVuZChcblx0XHRcdFx0XHRcdGA8aHRtbD48Ym9keT48aDE+QXV0aGVudGljYXRpb24gRmFpbGVkPC9oMT48cD5NaXNzaW5nIGNvZGUgb3Igc3RhdGUgcGFyYW1ldGVyLjwvcD48L2JvZHk+PC9odG1sPmAsXG5cdFx0XHRcdFx0KTtcblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0cmVzLndyaXRlSGVhZCg0MDQpO1xuXHRcdFx0XHRyZXMuZW5kKCk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cblx0XHRzZXJ2ZXIub24oXCJlcnJvclwiLCAoZXJyKSA9PiB7XG5cdFx0XHRyZWplY3QoZXJyKTtcblx0XHR9KTtcblxuXHRcdHNlcnZlci5saXN0ZW4ocG9ydCwgXCIxMjcuMC4wLjFcIiwgKCkgPT4ge1xuXHRcdFx0cmVzb2x2ZSh7XG5cdFx0XHRcdHNlcnZlcixcblx0XHRcdFx0Y2FuY2VsV2FpdDogKCkgPT4ge1xuXHRcdFx0XHRcdGNhbmNlbGxlZCA9IHRydWU7XG5cdFx0XHRcdH0sXG5cdFx0XHRcdHdhaXRGb3JDb2RlOiBhc3luYyAoKSA9PiB7XG5cdFx0XHRcdFx0Y29uc3Qgc2xlZXAgPSAoKSA9PiBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMDApKTtcblx0XHRcdFx0XHR3aGlsZSAoIXJlc3VsdCAmJiAhY2FuY2VsbGVkKSB7XG5cdFx0XHRcdFx0XHRhd2FpdCBzbGVlcCgpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRyZXR1cm4gcmVzdWx0O1xuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cdFx0fSk7XG5cdH0pO1xufVxuXG4vKipcbiAqIFBhcnNlIGEgcmVkaXJlY3QgVVJMIHRvIGV4dHJhY3QgdGhlIGF1dGhvcml6YXRpb24gY29kZSBhbmQgc3RhdGUgcGFyYW1ldGVycy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUmVkaXJlY3RVcmwoaW5wdXQ6IHN0cmluZyk6IHsgY29kZT86IHN0cmluZzsgc3RhdGU/OiBzdHJpbmcgfSB7XG5cdGNvbnN0IHZhbHVlID0gaW5wdXQudHJpbSgpO1xuXHRpZiAoIXZhbHVlKSByZXR1cm4ge307XG5cblx0dHJ5IHtcblx0XHRjb25zdCB1cmwgPSBuZXcgVVJMKHZhbHVlKTtcblx0XHRyZXR1cm4ge1xuXHRcdFx0Y29kZTogdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJjb2RlXCIpID8/IHVuZGVmaW5lZCxcblx0XHRcdHN0YXRlOiB1cmwuc2VhcmNoUGFyYW1zLmdldChcInN0YXRlXCIpID8/IHVuZGVmaW5lZCxcblx0XHR9O1xuXHR9IGNhdGNoIHtcblx0XHQvLyBOb3QgYSBVUkwsIHJldHVybiBlbXB0eVxuXHRcdHJldHVybiB7fTtcblx0fVxufVxuXG4vKipcbiAqIEdldCB0aGUgdXNlcidzIGVtYWlsIGFkZHJlc3MgZnJvbSBhIEdvb2dsZSBPQXV0aCBhY2Nlc3MgdG9rZW4uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRHb29nbGVVc2VyRW1haWwoYWNjZXNzVG9rZW46IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPiB7XG5cdHRyeSB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcImh0dHBzOi8vd3d3Lmdvb2dsZWFwaXMuY29tL29hdXRoMi92MS91c2VyaW5mbz9hbHQ9anNvblwiLCB7XG5cdFx0XHRoZWFkZXJzOiB7XG5cdFx0XHRcdEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHthY2Nlc3NUb2tlbn1gLFxuXHRcdFx0fSxcblx0XHRcdHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgzMF8wMDApLFxuXHRcdH0pO1xuXG5cdFx0aWYgKHJlc3BvbnNlLm9rKSB7XG5cdFx0XHRjb25zdCBkYXRhID0gKGF3YWl0IHJlc3BvbnNlLmpzb24oKSkgYXMgeyBlbWFpbD86IHN0cmluZyB9O1xuXHRcdFx0cmV0dXJuIGRhdGEuZW1haWw7XG5cdFx0fVxuXHR9IGNhdGNoIHtcblx0XHQvLyBJZ25vcmUgZXJyb3JzLCBlbWFpbCBpcyBvcHRpb25hbFxuXHR9XG5cdHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogUmVmcmVzaCBhIEdvb2dsZSBPQXV0aCB0b2tlbiB1c2luZyB0aGUgc3RhbmRhcmQgR29vZ2xlIHRva2VuIGVuZHBvaW50LlxuICpcbiAqIEBwYXJhbSByZWZyZXNoVG9rZW4gLSBUaGUgcmVmcmVzaCB0b2tlblxuICogQHBhcmFtIGNsaWVudElkIC0gVGhlIE9BdXRoIGNsaWVudCBJRFxuICogQHBhcmFtIGNsaWVudFNlY3JldCAtIFRoZSBPQXV0aCBjbGllbnQgc2VjcmV0XG4gKiBAcGFyYW0gcHJvdmlkZXJOYW1lIC0gSHVtYW4tcmVhZGFibGUgcHJvdmlkZXIgbmFtZSBmb3IgZXJyb3IgbWVzc2FnZXNcbiAqIEBwYXJhbSBleHRyYUZpZWxkcyAtIEFkZGl0aW9uYWwgZmllbGRzIHRvIGluY2x1ZGUgaW4gdGhlIHJldHVybmVkIGNyZWRlbnRpYWxzXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWZyZXNoR29vZ2xlT0F1dGhUb2tlbihcblx0cmVmcmVzaFRva2VuOiBzdHJpbmcsXG5cdGNsaWVudElkOiBzdHJpbmcsXG5cdGNsaWVudFNlY3JldDogc3RyaW5nLFxuXHRwcm92aWRlck5hbWU6IHN0cmluZyxcblx0ZXh0cmFGaWVsZHM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbik6IFByb21pc2U8T0F1dGhDcmVkZW50aWFscz4ge1xuXHRjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFwiaHR0cHM6Ly9vYXV0aDIuZ29vZ2xlYXBpcy5jb20vdG9rZW5cIiwge1xuXHRcdG1ldGhvZDogXCJQT1NUXCIsXG5cdFx0aGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL3gtd3d3LWZvcm0tdXJsZW5jb2RlZFwiIH0sXG5cdFx0Ym9keTogbmV3IFVSTFNlYXJjaFBhcmFtcyh7XG5cdFx0XHRjbGllbnRfaWQ6IGNsaWVudElkLFxuXHRcdFx0Y2xpZW50X3NlY3JldDogY2xpZW50U2VjcmV0LFxuXHRcdFx0cmVmcmVzaF90b2tlbjogcmVmcmVzaFRva2VuLFxuXHRcdFx0Z3JhbnRfdHlwZTogXCJyZWZyZXNoX3Rva2VuXCIsXG5cdFx0fSksXG5cdFx0c2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDMwXzAwMCksXG5cdH0pO1xuXG5cdGlmICghcmVzcG9uc2Uub2spIHtcblx0XHRjb25zdCBlcnJvciA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcblx0XHR0aHJvdyBuZXcgRXJyb3IoYCR7cHJvdmlkZXJOYW1lfSB0b2tlbiByZWZyZXNoIGZhaWxlZDogJHtlcnJvcn1gKTtcblx0fVxuXG5cdGNvbnN0IGRhdGEgPSAoYXdhaXQgcmVzcG9uc2UuanNvbigpKSBhcyB7XG5cdFx0YWNjZXNzX3Rva2VuOiBzdHJpbmc7XG5cdFx0ZXhwaXJlc19pbjogbnVtYmVyO1xuXHRcdHJlZnJlc2hfdG9rZW4/OiBzdHJpbmc7XG5cdH07XG5cblx0cmV0dXJuIHtcblx0XHRyZWZyZXNoOiBkYXRhLnJlZnJlc2hfdG9rZW4gfHwgcmVmcmVzaFRva2VuLFxuXHRcdGFjY2VzczogZGF0YS5hY2Nlc3NfdG9rZW4sXG5cdFx0ZXhwaXJlczogRGF0ZS5ub3coKSArIGRhdGEuZXhwaXJlc19pbiAqIDEwMDAgLSA1ICogNjAgKiAxMDAwLFxuXHRcdC4uLmV4dHJhRmllbGRzLFxuXHR9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBV0EsSUFBSSxnQkFBZ0U7QUFDcEUsSUFBSSxxQkFBMkM7QUFDL0MsSUFBSSxPQUFPLFlBQVksZ0JBQWdCLFFBQVEsVUFBVSxRQUFRLFFBQVEsVUFBVSxNQUFNO0FBQ3hGLHVCQUFxQixPQUFPLFdBQVcsRUFBRSxLQUFLLENBQUMsTUFBTTtBQUNwRCxvQkFBZ0IsRUFBRTtBQUFBLEVBQ25CLENBQUM7QUFDRjtBQVlBLGVBQWUsb0JBQ2QsY0FDbUQ7QUFDbkQsTUFBSSxjQUFlLFFBQU87QUFDMUIsTUFBSSxvQkFBb0I7QUFDdkIsVUFBTTtBQUFBLEVBQ1A7QUFDQSxNQUFJLGNBQWUsUUFBTztBQUMxQixRQUFNLElBQUksTUFBTSxHQUFHLFlBQVksa0RBQWtEO0FBQ2xGO0FBU0EsZUFBc0Isb0JBQ3JCLE1BQ0EsY0FDQSxjQUM4QjtBQUM5QixRQUFNLGVBQWUsTUFBTSxvQkFBb0IsWUFBWTtBQUUzRCxTQUFPLElBQUksUUFBUSxDQUFDLFNBQVMsV0FBVztBQUN2QyxRQUFJLFNBQWlEO0FBQ3JELFFBQUksWUFBWTtBQUVoQixVQUFNLFNBQVMsYUFBYSxDQUFDLEtBQUssUUFBUTtBQUN6QyxZQUFNLE1BQU0sSUFBSSxJQUFJLElBQUksT0FBTyxJQUFJLG9CQUFvQixJQUFJLEVBQUU7QUFFN0QsVUFBSSxJQUFJLGFBQWEsY0FBYztBQUNsQyxjQUFNLE9BQU8sSUFBSSxhQUFhLElBQUksTUFBTTtBQUN4QyxjQUFNLFFBQVEsSUFBSSxhQUFhLElBQUksT0FBTztBQUMxQyxjQUFNLFFBQVEsSUFBSSxhQUFhLElBQUksT0FBTztBQUUxQyxZQUFJLE9BQU87QUFD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
