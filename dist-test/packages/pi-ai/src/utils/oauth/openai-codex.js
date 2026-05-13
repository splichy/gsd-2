let _randomBytes = null;
let _http = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
  import("node:crypto").then((m) => {
    _randomBytes = m.randomBytes;
  });
  import("node:http").then((m) => {
    _http = m;
  });
}
import { generatePKCE } from "./pkce.js";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CHATGPT_UNSUPPORTED_MODEL_IDS = /* @__PURE__ */ new Set([
  "gpt-5.2-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1",
  "gpt-5"
]);
const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authentication successful</title>
</head>
<body>
  <p>Authentication successful. Return to your terminal to continue.</p>
</body>
</html>`;
function createState() {
  if (!_randomBytes) {
    throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
  }
  return _randomBytes(16).toString("hex");
}
function parseAuthorizationInput(input) {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? void 0,
      state: url.searchParams.get("state") ?? void 0
    };
  } catch {
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? void 0,
      state: params.get("state") ?? void 0
    };
  }
  return { code: value };
}
function decodeJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1] ?? "";
    const decoded = atob(payload);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}
async function exchangeAuthorizationCode(code, verifier, redirectUri = REDIRECT_URI) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri
    }),
    signal: AbortSignal.timeout(3e4)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error("[openai-codex] code->token failed:", response.status, text);
    return { type: "failed" };
  }
  const json = await response.json();
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    console.error("[openai-codex] token response missing fields:", json);
    return { type: "failed" };
  }
  return {
    type: "success",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1e3
  };
}
async function refreshAccessToken(refreshToken) {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID
      }),
      signal: AbortSignal.timeout(3e4)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("[openai-codex] Token refresh failed:", response.status, text);
      return { type: "failed" };
    }
    const json = await response.json();
    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
      console.error("[openai-codex] Token refresh response missing fields:", json);
      return { type: "failed" };
    }
    return {
      type: "success",
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1e3
    };
  } catch (error) {
    console.error("[openai-codex] Token refresh error:", error);
    return { type: "failed" };
  }
}
async function createAuthorizationFlow(originator = "pi") {
  const { verifier, challenge } = await generatePKCE();
  const state = createState();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);
  return { verifier, state, url: url.toString() };
}
function startLocalOAuthServer(state) {
  if (!_http) {
    throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
  }
  let lastCode = null;
  let cancelled = false;
  const server = _http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.statusCode = 400;
        res.end("State mismatch");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.statusCode = 400;
        res.end("Missing authorization code");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(SUCCESS_HTML);
      lastCode = code;
    } catch {
      res.statusCode = 500;
      res.end("Internal error");
    }
  });
  return new Promise((resolve) => {
    server.listen(1455, "127.0.0.1", () => {
      resolve({
        close: () => server.close(),
        cancelWait: () => {
          cancelled = true;
        },
        waitForCode: async () => {
          const sleep = () => new Promise((r) => setTimeout(r, 100));
          for (let i = 0; i < 600; i += 1) {
            if (lastCode) return { code: lastCode };
            if (cancelled) return null;
            await sleep();
          }
          return null;
        }
      });
    }).on("error", (err) => {
      console.error(
        "[openai-codex] Failed to bind http://127.0.0.1:1455 (",
        err.code,
        ") Falling back to manual paste."
      );
      resolve({
        close: () => {
          try {
            server.close();
          } catch {
          }
        },
        cancelWait: () => {
        },
        waitForCode: async () => null
      });
    });
  });
}
function getAccountId(accessToken) {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH];
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}
async function loginOpenAICodex(options) {
  const { verifier, state, url } = await createAuthorizationFlow(options.originator);
  const server = await startLocalOAuthServer(state);
  options.onAuth({ url, instructions: "A browser window should open. Complete login to finish." });
  let code;
  try {
    if (options.onManualCodeInput) {
      let manualCode;
      let manualError;
      const manualPromise = options.onManualCodeInput().then((input) => {
        manualCode = input;
        server.cancelWait();
      }).catch((err) => {
        manualError = err instanceof Error ? err : new Error(String(err));
        server.cancelWait();
      });
      const result = await server.waitForCode();
      if (manualError) {
        throw manualError;
      }
      if (result?.code) {
        code = result.code;
      } else if (manualCode) {
        const parsed = parseAuthorizationInput(manualCode);
        if (parsed.state && parsed.state !== state) {
          throw new Error("State mismatch");
        }
        code = parsed.code;
      }
      if (!code) {
        await manualPromise;
        if (manualError) {
          throw manualError;
        }
        if (manualCode) {
          const parsed = parseAuthorizationInput(manualCode);
          if (parsed.state && parsed.state !== state) {
            throw new Error("State mismatch");
          }
          code = parsed.code;
        }
      }
    } else {
      const result = await server.waitForCode();
      if (result?.code) {
        code = result.code;
      }
    }
    if (!code) {
      const input = await options.onPrompt({
        message: "Paste the authorization code (or full redirect URL):"
      });
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) {
        throw new Error("State mismatch");
      }
      code = parsed.code;
    }
    if (!code) {
      throw new Error("Missing authorization code");
    }
    const tokenResult = await exchangeAuthorizationCode(code, verifier);
    if (tokenResult.type !== "success") {
      throw new Error("Token exchange failed");
    }
    const accountId = getAccountId(tokenResult.access);
    if (!accountId) {
      throw new Error("Failed to extract accountId from token");
    }
    return {
      access: tokenResult.access,
      refresh: tokenResult.refresh,
      expires: tokenResult.expires,
      accountId
    };
  } finally {
    server.close();
  }
}
async function refreshOpenAICodexToken(refreshToken) {
  const result = await refreshAccessToken(refreshToken);
  if (result.type !== "success") {
    throw new Error("Failed to refresh OpenAI Codex token");
  }
  const accountId = getAccountId(result.access);
  if (!accountId) {
    throw new Error("Failed to extract accountId from token");
  }
  return {
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
    accountId
  };
}
const openaiCodexOAuthProvider = {
  id: "openai-codex",
  name: "ChatGPT Plus/Pro (Codex Subscription)",
  usesCallbackServer: true,
  async login(callbacks) {
    return loginOpenAICodex({
      onAuth: callbacks.onAuth,
      onPrompt: callbacks.onPrompt,
      onProgress: callbacks.onProgress,
      onManualCodeInput: callbacks.onManualCodeInput
    });
  },
  async refreshToken(credentials) {
    return refreshOpenAICodexToken(credentials.refresh);
  },
  getApiKey(credentials) {
    return credentials.access;
  },
  modifyModels(models) {
    return models.filter((model) => model.provider !== "openai-codex" || !CHATGPT_UNSUPPORTED_MODEL_IDS.has(model.id));
  }
};
export {
  loginOpenAICodex,
  openaiCodexOAuthProvider,
  refreshOpenAICodexToken
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL3V0aWxzL29hdXRoL29wZW5haS1jb2RleC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBPcGVuQUkgQ29kZXggKENoYXRHUFQgT0F1dGgpIGZsb3dcbiAqXG4gKiBOT1RFOiBUaGlzIG1vZHVsZSB1c2VzIE5vZGUuanMgY3J5cHRvIGFuZCBodHRwIGZvciB0aGUgT0F1dGggY2FsbGJhY2suXG4gKiBJdCBpcyBvbmx5IGludGVuZGVkIGZvciBDTEkgdXNlLCBub3QgYnJvd3NlciBlbnZpcm9ubWVudHMuXG4gKi9cblxuLy8gTkVWRVIgY29udmVydCB0byB0b3AtbGV2ZWwgaW1wb3J0cyAtIGJyZWFrcyBicm93c2VyL1ZpdGUgYnVpbGRzICh3ZWItdWkpXG5sZXQgX3JhbmRvbUJ5dGVzOiB0eXBlb2YgaW1wb3J0KFwibm9kZTpjcnlwdG9cIikucmFuZG9tQnl0ZXMgfCBudWxsID0gbnVsbDtcbmxldCBfaHR0cDogdHlwZW9mIGltcG9ydChcIm5vZGU6aHR0cFwiKSB8IG51bGwgPSBudWxsO1xuaWYgKHR5cGVvZiBwcm9jZXNzICE9PSBcInVuZGVmaW5lZFwiICYmIChwcm9jZXNzLnZlcnNpb25zPy5ub2RlIHx8IHByb2Nlc3MudmVyc2lvbnM/LmJ1bikpIHtcblx0aW1wb3J0KFwibm9kZTpjcnlwdG9cIikudGhlbigobSkgPT4ge1xuXHRcdF9yYW5kb21CeXRlcyA9IG0ucmFuZG9tQnl0ZXM7XG5cdH0pO1xuXHRpbXBvcnQoXCJub2RlOmh0dHBcIikudGhlbigobSkgPT4ge1xuXHRcdF9odHRwID0gbTtcblx0fSk7XG59XG5cbmltcG9ydCB7IGdlbmVyYXRlUEtDRSB9IGZyb20gXCIuL3BrY2UuanNcIjtcbmltcG9ydCB0eXBlIHsgT0F1dGhDcmVkZW50aWFscywgT0F1dGhMb2dpbkNhbGxiYWNrcywgT0F1dGhQcm9tcHQsIE9BdXRoUHJvdmlkZXJJbnRlcmZhY2UgfSBmcm9tIFwiLi90eXBlcy5qc1wiO1xuXG5jb25zdCBDTElFTlRfSUQgPSBcImFwcF9FTW9hbUVFWjczZjBDa1hhWHA3aHJhbm5cIjtcbmNvbnN0IEFVVEhPUklaRV9VUkwgPSBcImh0dHBzOi8vYXV0aC5vcGVuYWkuY29tL29hdXRoL2F1dGhvcml6ZVwiO1xuY29uc3QgVE9LRU5fVVJMID0gXCJodHRwczovL2F1dGgub3BlbmFpLmNvbS9vYXV0aC90b2tlblwiO1xuY29uc3QgUkVESVJFQ1RfVVJJID0gXCJodHRwOi8vbG9jYWxob3N0OjE0NTUvYXV0aC9jYWxsYmFja1wiO1xuY29uc3QgU0NPUEUgPSBcIm9wZW5pZCBwcm9maWxlIGVtYWlsIG9mZmxpbmVfYWNjZXNzXCI7XG5jb25zdCBKV1RfQ0xBSU1fUEFUSCA9IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS9hdXRoXCI7XG5jb25zdCBDSEFUR1BUX1VOU1VQUE9SVEVEX01PREVMX0lEUyA9IG5ldyBTZXQoW1xuXHRcImdwdC01LjItY29kZXhcIixcblx0XCJncHQtNS4xLWNvZGV4LW1pbmlcIixcblx0XCJncHQtNS4xLWNvZGV4LW1heFwiLFxuXHRcImdwdC01LjEtY29kZXhcIixcblx0XCJncHQtNS4xXCIsXG5cdFwiZ3B0LTVcIixcbl0pO1xuXG5jb25zdCBTVUNDRVNTX0hUTUwgPSBgPCFkb2N0eXBlIGh0bWw+XG48aHRtbCBsYW5nPVwiZW5cIj5cbjxoZWFkPlxuICA8bWV0YSBjaGFyc2V0PVwidXRmLThcIiAvPlxuICA8bWV0YSBuYW1lPVwidmlld3BvcnRcIiBjb250ZW50PVwid2lkdGg9ZGV2aWNlLXdpZHRoLCBpbml0aWFsLXNjYWxlPTFcIiAvPlxuICA8dGl0bGU+QXV0aGVudGljYXRpb24gc3VjY2Vzc2Z1bDwvdGl0bGU+XG48L2hlYWQ+XG48Ym9keT5cbiAgPHA+QXV0aGVudGljYXRpb24gc3VjY2Vzc2Z1bC4gUmV0dXJuIHRvIHlvdXIgdGVybWluYWwgdG8gY29udGludWUuPC9wPlxuPC9ib2R5PlxuPC9odG1sPmA7XG5cbnR5cGUgVG9rZW5TdWNjZXNzID0geyB0eXBlOiBcInN1Y2Nlc3NcIjsgYWNjZXNzOiBzdHJpbmc7IHJlZnJlc2g6IHN0cmluZzsgZXhwaXJlczogbnVtYmVyIH07XG50eXBlIFRva2VuRmFpbHVyZSA9IHsgdHlwZTogXCJmYWlsZWRcIiB9O1xudHlwZSBUb2tlblJlc3VsdCA9IFRva2VuU3VjY2VzcyB8IFRva2VuRmFpbHVyZTtcblxudHlwZSBKd3RQYXlsb2FkID0ge1xuXHRbSldUX0NMQUlNX1BBVEhdPzoge1xuXHRcdGNoYXRncHRfYWNjb3VudF9pZD86IHN0cmluZztcblx0fTtcblx0W2tleTogc3RyaW5nXTogdW5rbm93bjtcbn07XG5cbmZ1bmN0aW9uIGNyZWF0ZVN0YXRlKCk6IHN0cmluZyB7XG5cdGlmICghX3JhbmRvbUJ5dGVzKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKFwiT3BlbkFJIENvZGV4IE9BdXRoIGlzIG9ubHkgYXZhaWxhYmxlIGluIE5vZGUuanMgZW52aXJvbm1lbnRzXCIpO1xuXHR9XG5cdHJldHVybiBfcmFuZG9tQnl0ZXMoMTYpLnRvU3RyaW5nKFwiaGV4XCIpO1xufVxuXG5mdW5jdGlvbiBwYXJzZUF1dGhvcml6YXRpb25JbnB1dChpbnB1dDogc3RyaW5nKTogeyBjb2RlPzogc3RyaW5nOyBzdGF0ZT86IHN0cmluZyB9IHtcblx0Y29uc3QgdmFsdWUgPSBpbnB1dC50cmltKCk7XG5cdGlmICghdmFsdWUpIHJldHVybiB7fTtcblxuXHR0cnkge1xuXHRcdGNvbnN0IHVybCA9IG5ldyBVUkwodmFsdWUpO1xuXHRcdHJldHVybiB7XG5cdFx0XHRjb2RlOiB1cmwuc2VhcmNoUGFyYW1zLmdldChcImNvZGVcIikgPz8gdW5kZWZpbmVkLFxuXHRcdFx0c3RhdGU6IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic3RhdGVcIikgPz8gdW5kZWZpbmVkLFxuXHRcdH07XG5cdH0gY2F0Y2gge1xuXHRcdC8vIG5vdCBhIFVSTFxuXHR9XG5cblx0aWYgKHZhbHVlLmluY2x1ZGVzKFwiI1wiKSkge1xuXHRcdGNvbnN0IFtjb2RlLCBzdGF0ZV0gPSB2YWx1ZS5zcGxpdChcIiNcIiwgMik7XG5cdFx0cmV0dXJuIHsgY29kZSwgc3RhdGUgfTtcblx0fVxuXG5cdGlmICh2YWx1ZS5pbmNsdWRlcyhcImNvZGU9XCIpKSB7XG5cdFx0Y29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcyh2YWx1ZSk7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGNvZGU6IHBhcmFtcy5nZXQoXCJjb2RlXCIpID8/IHVuZGVmaW5lZCxcblx0XHRcdHN0YXRlOiBwYXJhbXMuZ2V0KFwic3RhdGVcIikgPz8gdW5kZWZpbmVkLFxuXHRcdH07XG5cdH1cblxuXHRyZXR1cm4geyBjb2RlOiB2YWx1ZSB9O1xufVxuXG5mdW5jdGlvbiBkZWNvZGVKd3QodG9rZW46IHN0cmluZyk6IEp3dFBheWxvYWQgfCBudWxsIHtcblx0dHJ5IHtcblx0XHRjb25zdCBwYXJ0cyA9IHRva2VuLnNwbGl0KFwiLlwiKTtcblx0XHRpZiAocGFydHMubGVuZ3RoICE9PSAzKSByZXR1cm4gbnVsbDtcblx0XHRjb25zdCBwYXlsb2FkID0gcGFydHNbMV0gPz8gXCJcIjtcblx0XHRjb25zdCBkZWNvZGVkID0gYXRvYihwYXlsb2FkKTtcblx0XHRyZXR1cm4gSlNPTi5wYXJzZShkZWNvZGVkKSBhcyBKd3RQYXlsb2FkO1xuXHR9IGNhdGNoIHtcblx0XHRyZXR1cm4gbnVsbDtcblx0fVxufVxuXG5hc3luYyBmdW5jdGlvbiBleGNoYW5nZUF1dGhvcml6YXRpb25Db2RlKFxuXHRjb2RlOiBzdHJpbmcsXG5cdHZlcmlmaWVyOiBzdHJpbmcsXG5cdHJlZGlyZWN0VXJpOiBzdHJpbmcgPSBSRURJUkVDVF9VUkksXG4pOiBQcm9taXNlPFRva2VuUmVzdWx0PiB7XG5cdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goVE9LRU5fVVJMLCB7XG5cdFx0bWV0aG9kOiBcIlBPU1RcIixcblx0XHRoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24veC13d3ctZm9ybS11cmxlbmNvZGVkXCIgfSxcblx0XHRib2R5OiBuZXcgVVJMU2VhcmNoUGFyYW1zKHtcblx0XHRcdGdyYW50X3R5cGU6IFwiYXV0aG9yaXphdGlvbl9jb2RlXCIsXG5cdFx0XHRjbGllbnRfaWQ6IENMSUVOVF9JRCxcblx0XHRcdGNvZGUsXG5cdFx0XHRjb2RlX3ZlcmlmaWVyOiB2ZXJpZmllcixcblx0XHRcdHJlZGlyZWN0X3VyaTogcmVkaXJlY3RVcmksXG5cdFx0fSksXG5cdFx0c2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDMwXzAwMCksXG5cdH0pO1xuXG5cdGlmICghcmVzcG9uc2Uub2spIHtcblx0XHRjb25zdCB0ZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpLmNhdGNoKCgpID0+IFwiXCIpO1xuXHRcdGNvbnNvbGUuZXJyb3IoXCJbb3BlbmFpLWNvZGV4XSBjb2RlLT50b2tlbiBmYWlsZWQ6XCIsIHJlc3BvbnNlLnN0YXR1cywgdGV4dCk7XG5cdFx0cmV0dXJuIHsgdHlwZTogXCJmYWlsZWRcIiB9O1xuXHR9XG5cblx0Y29uc3QganNvbiA9IChhd2FpdCByZXNwb25zZS5qc29uKCkpIGFzIHtcblx0XHRhY2Nlc3NfdG9rZW4/OiBzdHJpbmc7XG5cdFx0cmVmcmVzaF90b2tlbj86IHN0cmluZztcblx0XHRleHBpcmVzX2luPzogbnVtYmVyO1xuXHR9O1xuXG5cdGlmICghanNvbi5hY2Nlc3NfdG9rZW4gfHwgIWpzb24ucmVmcmVzaF90b2tlbiB8fCB0eXBlb2YganNvbi5leHBpcmVzX2luICE9PSBcIm51bWJlclwiKSB7XG5cdFx0Y29uc29sZS5lcnJvcihcIltvcGVuYWktY29kZXhdIHRva2VuIHJlc3BvbnNlIG1pc3NpbmcgZmllbGRzOlwiLCBqc29uKTtcblx0XHRyZXR1cm4geyB0eXBlOiBcImZhaWxlZFwiIH07XG5cdH1cblxuXHRyZXR1cm4ge1xuXHRcdHR5cGU6IFwic3VjY2Vzc1wiLFxuXHRcdGFjY2VzczoganNvbi5hY2Nlc3NfdG9rZW4sXG5cdFx0cmVmcmVzaDoganNvbi5yZWZyZXNoX3Rva2VuLFxuXHRcdGV4cGlyZXM6IERhdGUubm93KCkgKyBqc29uLmV4cGlyZXNfaW4gKiAxMDAwLFxuXHR9O1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoQWNjZXNzVG9rZW4ocmVmcmVzaFRva2VuOiBzdHJpbmcpOiBQcm9taXNlPFRva2VuUmVzdWx0PiB7XG5cdHRyeSB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChUT0tFTl9VUkwsIHtcblx0XHRcdG1ldGhvZDogXCJQT1NUXCIsXG5cdFx0XHRoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24veC13d3ctZm9ybS11cmxlbmNvZGVkXCIgfSxcblx0XHRcdGJvZHk6IG5ldyBVUkxTZWFyY2hQYXJhbXMoe1xuXHRcdFx0XHRncmFudF90eXBlOiBcInJlZnJlc2hfdG9rZW5cIixcblx0XHRcdFx0cmVmcmVzaF90b2tlbjogcmVmcmVzaFRva2VuLFxuXHRcdFx0XHRjbGllbnRfaWQ6IENMSUVOVF9JRCxcblx0XHRcdH0pLFxuXHRcdFx0c2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDMwXzAwMCksXG5cdFx0fSk7XG5cblx0XHRpZiAoIXJlc3BvbnNlLm9rKSB7XG5cdFx0XHRjb25zdCB0ZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpLmNhdGNoKCgpID0+IFwiXCIpO1xuXHRcdFx0Y29uc29sZS5lcnJvcihcIltvcGVuYWktY29kZXhdIFRva2VuIHJlZnJlc2ggZmFpbGVkOlwiLCByZXNwb25zZS5zdGF0dXMsIHRleHQpO1xuXHRcdFx0cmV0dXJuIHsgdHlwZTogXCJmYWlsZWRcIiB9O1xuXHRcdH1cblxuXHRcdGNvbnN0IGpzb24gPSAoYXdhaXQgcmVzcG9uc2UuanNvbigpKSBhcyB7XG5cdFx0XHRhY2Nlc3NfdG9rZW4/OiBzdHJpbmc7XG5cdFx0XHRyZWZyZXNoX3Rva2VuPzogc3RyaW5nO1xuXHRcdFx0ZXhwaXJlc19pbj86IG51bWJlcjtcblx0XHR9O1xuXG5cdFx0aWYgKCFqc29uLmFjY2Vzc190b2tlbiB8fCAhanNvbi5yZWZyZXNoX3Rva2VuIHx8IHR5cGVvZiBqc29uLmV4cGlyZXNfaW4gIT09IFwibnVtYmVyXCIpIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoXCJbb3BlbmFpLWNvZGV4XSBUb2tlbiByZWZyZXNoIHJlc3BvbnNlIG1pc3NpbmcgZmllbGRzOlwiLCBqc29uKTtcblx0XHRcdHJldHVybiB7IHR5cGU6IFwiZmFpbGVkXCIgfTtcblx0XHR9XG5cblx0XHRyZXR1cm4ge1xuXHRcdFx0dHlwZTogXCJzdWNjZXNzXCIsXG5cdFx0XHRhY2Nlc3M6IGpzb24uYWNjZXNzX3Rva2VuLFxuXHRcdFx0cmVmcmVzaDoganNvbi5yZWZyZXNoX3Rva2VuLFxuXHRcdFx0ZXhwaXJlczogRGF0ZS5ub3coKSArIGpzb24uZXhwaXJlc19pbiAqIDEwMDAsXG5cdFx0fTtcblx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRjb25zb2xlLmVycm9yKFwiW29wZW5haS1jb2RleF0gVG9rZW4gcmVmcmVzaCBlcnJvcjpcIiwgZXJyb3IpO1xuXHRcdHJldHVybiB7IHR5cGU6IFwiZmFpbGVkXCIgfTtcblx0fVxufVxuXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVBdXRob3JpemF0aW9uRmxvdyhcblx0b3JpZ2luYXRvcjogc3RyaW5nID0gXCJwaVwiLFxuKTogUHJvbWlzZTx7IHZlcmlmaWVyOiBzdHJpbmc7IHN0YXRlOiBzdHJpbmc7IHVybDogc3RyaW5nIH0+IHtcblx0Y29uc3QgeyB2ZXJpZmllciwgY2hhbGxlbmdlIH0gPSBhd2FpdCBnZW5lcmF0ZVBLQ0UoKTtcblx0Y29uc3Qgc3RhdGUgPSBjcmVhdGVTdGF0ZSgpO1xuXG5cdGNvbnN0IHVybCA9IG5ldyBVUkwoQVVUSE9SSVpFX1VSTCk7XG5cdHVybC5zZWFyY2hQYXJhbXMuc2V0KFwicmVzcG9uc2VfdHlwZVwiLCBcImNvZGVcIik7XG5cdHVybC5zZWFyY2hQYXJhbXMuc2V0KFwiY2xpZW50X2lkXCIsIENMSUVOVF9JRCk7XG5cdHVybC5zZWFyY2hQYXJhbXMuc2V0KFwicmVkaXJlY3RfdXJpXCIsIFJFRElSRUNUX1VSSSk7XG5cdHVybC5zZWFyY2hQYXJhbXMuc2V0KFwic2NvcGVcIiwgU0NPUEUpO1xuXHR1cmwuc2VhcmNoUGFyYW1zLnNldChcImNvZGVfY2hhbGxlbmdlXCIsIGNoYWxsZW5nZSk7XG5cdHVybC5zZWFyY2hQYXJhbXMuc2V0KFwiY29kZV9jaGFsbGVuZ2VfbWV0aG9kXCIsIFwiUzI1NlwiKTtcblx0dXJsLnNlYXJjaFBhcmFtcy5zZXQoXCJzdGF0ZVwiLCBzdGF0ZSk7XG5cdHVybC5zZWFyY2hQYXJhbXMuc2V0KFwiaWRfdG9rZW5fYWRkX29yZ2FuaXphdGlvbnNcIiwgXCJ0cnVlXCIpO1xuXHR1cmwuc2VhcmNoUGFyYW1zLnNldChcImNvZGV4X2NsaV9zaW1wbGlmaWVkX2Zsb3dcIiwgXCJ0cnVlXCIpO1xuXHR1cmwuc2VhcmNoUGFyYW1zLnNldChcIm9yaWdpbmF0b3JcIiwgb3JpZ2luYXRvcik7XG5cblx0cmV0dXJuIHsgdmVyaWZpZXIsIHN0YXRlLCB1cmw6IHVybC50b1N0cmluZygpIH07XG59XG5cbnR5cGUgT0F1dGhTZXJ2ZXJJbmZvID0ge1xuXHRjbG9zZTogKCkgPT4gdm9pZDtcblx0Y2FuY2VsV2FpdDogKCkgPT4gdm9pZDtcblx0d2FpdEZvckNvZGU6ICgpID0+IFByb21pc2U8eyBjb2RlOiBzdHJpbmcgfSB8IG51bGw+O1xufTtcblxuZnVuY3Rpb24gc3RhcnRMb2NhbE9BdXRoU2VydmVyKHN0YXRlOiBzdHJpbmcpOiBQcm9taXNlPE9BdXRoU2VydmVySW5mbz4ge1xuXHRpZiAoIV9odHRwKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKFwiT3BlbkFJIENvZGV4IE9BdXRoIGlzIG9ubHkgYXZhaWxhYmxlIGluIE5vZGUuanMgZW52aXJvbm1lbnRzXCIpO1xuXHR9XG5cdGxldCBsYXN0Q29kZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cdGxldCBjYW5jZWxsZWQgPSBmYWxzZTtcblx0Y29uc3Qgc2VydmVyID0gX2h0dHAuY3JlYXRlU2VydmVyKChyZXEsIHJlcykgPT4ge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwgfHwgXCJcIiwgXCJodHRwOi8vbG9jYWxob3N0XCIpO1xuXHRcdFx0aWYgKHVybC5wYXRobmFtZSAhPT0gXCIvYXV0aC9jYWxsYmFja1wiKSB7XG5cdFx0XHRcdHJlcy5zdGF0dXNDb2RlID0gNDA0O1xuXHRcdFx0XHRyZXMuZW5kKFwiTm90IGZvdW5kXCIpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHRpZiAodXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJzdGF0ZVwiKSAhPT0gc3RhdGUpIHtcblx0XHRcdFx0cmVzLnN0YXR1c0NvZGUgPSA0MDA7XG5cdFx0XHRcdHJlcy5lbmQoXCJTdGF0ZSBtaXNtYXRjaFwiKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgY29kZSA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiY29kZVwiKTtcblx0XHRcdGlmICghY29kZSkge1xuXHRcdFx0XHRyZXMuc3RhdHVzQ29kZSA9IDQwMDtcblx0XHRcdFx0cmVzLmVuZChcIk1pc3NpbmcgYXV0aG9yaXphdGlvbiBjb2RlXCIpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHRyZXMuc3RhdHVzQ29kZSA9IDIwMDtcblx0XHRcdHJlcy5zZXRIZWFkZXIoXCJDb250ZW50LVR5cGVcIiwgXCJ0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLThcIik7XG5cdFx0XHRyZXMuZW5kKFNVQ0NFU1NfSFRNTCk7XG5cdFx0XHRsYXN0Q29kZSA9IGNvZGU7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHRyZXMuc3RhdHVzQ29kZSA9IDUwMDtcblx0XHRcdHJlcy5lbmQoXCJJbnRlcm5hbCBlcnJvclwiKTtcblx0XHR9XG5cdH0pO1xuXG5cdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuXHRcdHNlcnZlclxuXHRcdFx0Lmxpc3RlbigxNDU1LCBcIjEyNy4wLjAuMVwiLCAoKSA9PiB7XG5cdFx0XHRcdHJlc29sdmUoe1xuXHRcdFx0XHRcdGNsb3NlOiAoKSA9PiBzZXJ2ZXIuY2xvc2UoKSxcblx0XHRcdFx0XHRjYW5jZWxXYWl0OiAoKSA9PiB7XG5cdFx0XHRcdFx0XHRjYW5jZWxsZWQgPSB0cnVlO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0d2FpdEZvckNvZGU6IGFzeW5jICgpID0+IHtcblx0XHRcdFx0XHRcdGNvbnN0IHNsZWVwID0gKCkgPT4gbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMTAwKSk7XG5cdFx0XHRcdFx0XHRmb3IgKGxldCBpID0gMDsgaSA8IDYwMDsgaSArPSAxKSB7XG5cdFx0XHRcdFx0XHRcdGlmIChsYXN0Q29kZSkgcmV0dXJuIHsgY29kZTogbGFzdENvZGUgfTtcblx0XHRcdFx0XHRcdFx0aWYgKGNhbmNlbGxlZCkgcmV0dXJuIG51bGw7XG5cdFx0XHRcdFx0XHRcdGF3YWl0IHNsZWVwKCk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRyZXR1cm4gbnVsbDtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9KTtcblx0XHRcdH0pXG5cdFx0XHQub24oXCJlcnJvclwiLCAoZXJyOiBOb2RlSlMuRXJybm9FeGNlcHRpb24pID0+IHtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihcblx0XHRcdFx0XHRcIltvcGVuYWktY29kZXhdIEZhaWxlZCB0byBiaW5kIGh0dHA6Ly8xMjcuMC4wLjE6MTQ1NSAoXCIsXG5cdFx0XHRcdFx0ZXJyLmNvZGUsXG5cdFx0XHRcdFx0XCIpIEZhbGxpbmcgYmFjayB0byBtYW51YWwgcGFzdGUuXCIsXG5cdFx0XHRcdCk7XG5cdFx0XHRcdHJlc29sdmUoe1xuXHRcdFx0XHRcdGNsb3NlOiAoKSA9PiB7XG5cdFx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0XHRzZXJ2ZXIuY2xvc2UoKTtcblx0XHRcdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdFx0XHQvLyBpZ25vcmVcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdGNhbmNlbFdhaXQ6ICgpID0+IHt9LFxuXHRcdFx0XHRcdHdhaXRGb3JDb2RlOiBhc3luYyAoKSA9PiBudWxsLFxuXHRcdFx0XHR9KTtcblx0XHRcdH0pO1xuXHR9KTtcbn1cblxuZnVuY3Rpb24gZ2V0QWNjb3VudElkKGFjY2Vzc1Rva2VuOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcblx0Y29uc3QgcGF5bG9hZCA9IGRlY29kZUp3dChhY2Nlc3NUb2tlbik7XG5cdGNvbnN0IGF1dGggPSBwYXlsb2FkPy5bSldUX0NMQUlNX1BBVEhdO1xuXHRjb25zdCBhY2NvdW50SWQgPSBhdXRoPy5jaGF0Z3B0X2FjY291bnRfaWQ7XG5cdHJldHVybiB0eXBlb2YgYWNjb3VudElkID09PSBcInN0cmluZ1wiICYmIGFjY291bnRJZC5sZW5ndGggPiAwID8gYWNjb3VudElkIDogbnVsbDtcbn1cblxuLyoqXG4gKiBMb2dpbiB3aXRoIE9wZW5BSSBDb2RleCBPQXV0aFxuICpcbiAqIEBwYXJhbSBvcHRpb25zLm9uQXV0aCAtIENhbGxlZCB3aXRoIFVSTCBhbmQgaW5zdHJ1Y3Rpb25zIHdoZW4gYXV0aCBzdGFydHNcbiAqIEBwYXJhbSBvcHRpb25zLm9uUHJvbXB0IC0gQ2FsbGVkIHRvIHByb21wdCB1c2VyIGZvciBtYW51YWwgY29kZSBwYXN0ZSAoZmFsbGJhY2sgaWYgbm8gb25NYW51YWxDb2RlSW5wdXQpXG4gKiBAcGFyYW0gb3B0aW9ucy5vblByb2dyZXNzIC0gT3B0aW9uYWwgcHJvZ3Jlc3MgbWVzc2FnZXNcbiAqIEBwYXJhbSBvcHRpb25zLm9uTWFudWFsQ29kZUlucHV0IC0gT3B0aW9uYWwgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHdpdGggdXNlci1wYXN0ZWQgY29kZS5cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgUmFjZXMgd2l0aCBicm93c2VyIGNhbGxiYWNrIC0gd2hpY2hldmVyIGNvbXBsZXRlcyBmaXJzdCB3aW5zLlxuICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBVc2VmdWwgZm9yIHNob3dpbmcgcGFzdGUgaW5wdXQgaW1tZWRpYXRlbHkgYWxvbmdzaWRlIGJyb3dzZXIgZmxvdy5cbiAqIEBwYXJhbSBvcHRpb25zLm9yaWdpbmF0b3IgLSBPQXV0aCBvcmlnaW5hdG9yIHBhcmFtZXRlciAoZGVmYXVsdHMgdG8gXCJwaVwiKVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9naW5PcGVuQUlDb2RleChvcHRpb25zOiB7XG5cdG9uQXV0aDogKGluZm86IHsgdXJsOiBzdHJpbmc7IGluc3RydWN0aW9ucz86IHN0cmluZyB9KSA9PiB2b2lkO1xuXHRvblByb21wdDogKHByb21wdDogT0F1dGhQcm9tcHQpID0+IFByb21pc2U8c3RyaW5nPjtcblx0b25Qcm9ncmVzcz86IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQ7XG5cdG9uTWFudWFsQ29kZUlucHV0PzogKCkgPT4gUHJvbWlzZTxzdHJpbmc+O1xuXHRvcmlnaW5hdG9yPzogc3RyaW5nO1xufSk6IFByb21pc2U8T0F1dGhDcmVkZW50aWFscz4ge1xuXHRjb25zdCB7IHZlcmlmaWVyLCBzdGF0ZSwgdXJsIH0gPSBhd2FpdCBjcmVhdGVBdXRob3JpemF0aW9uRmxvdyhvcHRpb25zLm9yaWdpbmF0b3IpO1xuXHRjb25zdCBzZXJ2ZXIgPSBhd2FpdCBzdGFydExvY2FsT0F1dGhTZXJ2ZXIoc3RhdGUpO1xuXG5cdG9wdGlvbnMub25BdXRoKHsgdXJsLCBpbnN0cnVjdGlvbnM6IFwiQSBicm93c2VyIHdpbmRvdyBzaG91bGQgb3Blbi4gQ29tcGxldGUgbG9naW4gdG8gZmluaXNoLlwiIH0pO1xuXG5cdGxldCBjb2RlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cdHRyeSB7XG5cdFx0aWYgKG9wdGlvbnMub25NYW51YWxDb2RlSW5wdXQpIHtcblx0XHRcdC8vIFJhY2UgYmV0d2VlbiBicm93c2VyIGNhbGxiYWNrIGFuZCBtYW51YWwgaW5wdXRcblx0XHRcdGxldCBtYW51YWxDb2RlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cdFx0XHRsZXQgbWFudWFsRXJyb3I6IEVycm9yIHwgdW5kZWZpbmVkO1xuXHRcdFx0Y29uc3QgbWFudWFsUHJvbWlzZSA9IG9wdGlvbnNcblx0XHRcdFx0Lm9uTWFudWFsQ29kZUlucHV0KClcblx0XHRcdFx0LnRoZW4oKGlucHV0KSA9PiB7XG5cdFx0XHRcdFx0bWFudWFsQ29kZSA9IGlucHV0O1xuXHRcdFx0XHRcdHNlcnZlci5jYW5jZWxXYWl0KCk7XG5cdFx0XHRcdH0pXG5cdFx0XHRcdC5jYXRjaCgoZXJyKSA9PiB7XG5cdFx0XHRcdFx0bWFudWFsRXJyb3IgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyKSk7XG5cdFx0XHRcdFx0c2VydmVyLmNhbmNlbFdhaXQoKTtcblx0XHRcdFx0fSk7XG5cblx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHNlcnZlci53YWl0Rm9yQ29kZSgpO1xuXG5cdFx0XHQvLyBJZiBtYW51YWwgaW5wdXQgd2FzIGNhbmNlbGxlZCwgdGhyb3cgdGhhdCBlcnJvclxuXHRcdFx0aWYgKG1hbnVhbEVycm9yKSB7XG5cdFx0XHRcdHRocm93IG1hbnVhbEVycm9yO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAocmVzdWx0Py5jb2RlKSB7XG5cdFx0XHRcdC8vIEJyb3dzZXIgY2FsbGJhY2sgd29uXG5cdFx0XHRcdGNvZGUgPSByZXN1bHQuY29kZTtcblx0XHRcdH0gZWxzZSBpZiAobWFudWFsQ29kZSkge1xuXHRcdFx0XHQvLyBNYW51YWwgaW5wdXQgd29uIChvciBjYWxsYmFjayB0aW1lZCBvdXQgYW5kIHVzZXIgaGFkIGVudGVyZWQgY29kZSlcblx0XHRcdFx0Y29uc3QgcGFyc2VkID0gcGFyc2VBdXRob3JpemF0aW9uSW5wdXQobWFudWFsQ29kZSk7XG5cdFx0XHRcdGlmIChwYXJzZWQuc3RhdGUgJiYgcGFyc2VkLnN0YXRlICE9PSBzdGF0ZSkge1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIlN0YXRlIG1pc21hdGNoXCIpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvZGUgPSBwYXJzZWQuY29kZTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gSWYgc3RpbGwgbm8gY29kZSwgd2FpdCBmb3IgbWFudWFsIHByb21pc2UgdG8gY29tcGxldGUgYW5kIHRyeSB0aGF0XG5cdFx0XHRpZiAoIWNvZGUpIHtcblx0XHRcdFx0YXdhaXQgbWFudWFsUHJvbWlzZTtcblx0XHRcdFx0aWYgKG1hbnVhbEVycm9yKSB7XG5cdFx0XHRcdFx0dGhyb3cgbWFudWFsRXJyb3I7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKG1hbnVhbENvZGUpIHtcblx0XHRcdFx0XHRjb25zdCBwYXJzZWQgPSBwYXJzZUF1dGhvcml6YXRpb25JbnB1dChtYW51YWxDb2RlKTtcblx0XHRcdFx0XHRpZiAocGFyc2VkLnN0YXRlICYmIHBhcnNlZC5zdGF0ZSAhPT0gc3RhdGUpIHtcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIlN0YXRlIG1pc21hdGNoXCIpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRjb2RlID0gcGFyc2VkLmNvZGU7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9IGVsc2Uge1xuXHRcdFx0Ly8gT3JpZ2luYWwgZmxvdzogd2FpdCBmb3IgY2FsbGJhY2ssIHRoZW4gcHJvbXB0IGlmIG5lZWRlZFxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc2VydmVyLndhaXRGb3JDb2RlKCk7XG5cdFx0XHRpZiAocmVzdWx0Py5jb2RlKSB7XG5cdFx0XHRcdGNvZGUgPSByZXN1bHQuY29kZTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBGYWxsYmFjayB0byBvblByb21wdCBpZiBzdGlsbCBubyBjb2RlXG5cdFx0aWYgKCFjb2RlKSB7XG5cdFx0XHRjb25zdCBpbnB1dCA9IGF3YWl0IG9wdGlvbnMub25Qcm9tcHQoe1xuXHRcdFx0XHRtZXNzYWdlOiBcIlBhc3RlIHRoZSBhdXRob3JpemF0aW9uIGNvZGUgKG9yIGZ1bGwgcmVkaXJlY3QgVVJMKTpcIixcblx0XHRcdH0pO1xuXHRcdFx0Y29uc3QgcGFyc2VkID0gcGFyc2VBdXRob3JpemF0aW9uSW5wdXQoaW5wdXQpO1xuXHRcdFx0aWYgKHBhcnNlZC5zdGF0ZSAmJiBwYXJzZWQuc3RhdGUgIT09IHN0YXRlKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcIlN0YXRlIG1pc21hdGNoXCIpO1xuXHRcdFx0fVxuXHRcdFx0Y29kZSA9IHBhcnNlZC5jb2RlO1xuXHRcdH1cblxuXHRcdGlmICghY29kZSkge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiTWlzc2luZyBhdXRob3JpemF0aW9uIGNvZGVcIik7XG5cdFx0fVxuXG5cdFx0Y29uc3QgdG9rZW5SZXN1bHQgPSBhd2FpdCBleGNoYW5nZUF1dGhvcml6YXRpb25Db2RlKGNvZGUsIHZlcmlmaWVyKTtcblx0XHRpZiAodG9rZW5SZXN1bHQudHlwZSAhPT0gXCJzdWNjZXNzXCIpIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihcIlRva2VuIGV4Y2hhbmdlIGZhaWxlZFwiKTtcblx0XHR9XG5cblx0XHRjb25zdCBhY2NvdW50SWQgPSBnZXRBY2NvdW50SWQodG9rZW5SZXN1bHQuYWNjZXNzKTtcblx0XHRpZiAoIWFjY291bnRJZCkge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiRmFpbGVkIHRvIGV4dHJhY3QgYWNjb3VudElkIGZyb20gdG9rZW5cIik7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHtcblx0XHRcdGFjY2VzczogdG9rZW5SZXN1bHQuYWNjZXNzLFxuXHRcdFx0cmVmcmVzaDogdG9rZW5SZXN1bHQucmVmcmVzaCxcblx0XHRcdGV4cGlyZXM6IHRva2VuUmVzdWx0LmV4cGlyZXMsXG5cdFx0XHRhY2NvdW50SWQsXG5cdFx0fTtcblx0fSBmaW5hbGx5IHtcblx0XHRzZXJ2ZXIuY2xvc2UoKTtcblx0fVxufVxuXG4vKipcbiAqIFJlZnJlc2ggT3BlbkFJIENvZGV4IE9BdXRoIHRva2VuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWZyZXNoT3BlbkFJQ29kZXhUb2tlbihyZWZyZXNoVG9rZW46IHN0cmluZyk6IFByb21pc2U8T0F1dGhDcmVkZW50aWFscz4ge1xuXHRjb25zdCByZXN1bHQgPSBhd2FpdCByZWZyZXNoQWNjZXNzVG9rZW4ocmVmcmVzaFRva2VuKTtcblx0aWYgKHJlc3VsdC50eXBlICE9PSBcInN1Y2Nlc3NcIikge1xuXHRcdHRocm93IG5ldyBFcnJvcihcIkZhaWxlZCB0byByZWZyZXNoIE9wZW5BSSBDb2RleCB0b2tlblwiKTtcblx0fVxuXG5cdGNvbnN0IGFjY291bnRJZCA9IGdldEFjY291bnRJZChyZXN1bHQuYWNjZXNzKTtcblx0aWYgKCFhY2NvdW50SWQpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoXCJGYWlsZWQgdG8gZXh0cmFjdCBhY2NvdW50SWQgZnJvbSB0b2tlblwiKTtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0YWNjZXNzOiByZXN1bHQuYWNjZXNzLFxuXHRcdHJlZnJlc2g6IHJlc3VsdC5yZWZyZXNoLFxuXHRcdGV4cGlyZXM6IHJlc3VsdC5leHBpcmVzLFxuXHRcdGFjY291bnRJZCxcblx0fTtcbn1cblxuZXhwb3J0IGNvbnN0IG9wZW5haUNvZGV4T0F1dGhQcm92aWRlcjogT0F1dGhQcm92aWRlckludGVyZmFjZSA9IHtcblx0aWQ6IFwib3BlbmFpLWNvZGV4XCIsXG5cdG5hbWU6IFwiQ2hhdEdQVCBQbHVzL1BybyAoQ29kZXggU3Vic2NyaXB0aW9uKVwiLFxuXHR1c2VzQ2FsbGJhY2tTZXJ2ZXI6IHRydWUsXG5cblx0YXN5bmMgbG9naW4oY2FsbGJhY2tzOiBPQXV0aExvZ2luQ2FsbGJhY2tzKTogUHJvbWlzZTxPQXV0aENyZWRlbnRpYWxzPiB7XG5cdFx0cmV0dXJuIGxvZ2luT3BlbkFJQ29kZXgoe1xuXHRcdFx0b25BdXRoOiBjYWxsYmFja3Mub25BdXRoLFxuXHRcdFx0b25Qcm9tcHQ6IGNhbGxiYWNrcy5vblByb21wdCxcblx0XHRcdG9uUHJvZ3Jlc3M6IGNhbGxiYWNrcy5vblByb2dyZXNzLFxuXHRcdFx0b25NYW51YWxDb2RlSW5wdXQ6IGNhbGxiYWNrcy5vbk1hbnVhbENvZGVJbnB1dCxcblx0XHR9KTtcblx0fSxcblxuXHRhc3luYyByZWZyZXNoVG9rZW4oY3JlZGVudGlhbHM6IE9BdXRoQ3JlZGVudGlhbHMpOiBQcm9taXNlPE9BdXRoQ3JlZGVudGlhbHM+IHtcblx0XHRyZXR1cm4gcmVmcmVzaE9wZW5BSUNvZGV4VG9rZW4oY3JlZGVudGlhbHMucmVmcmVzaCk7XG5cdH0sXG5cblx0Z2V0QXBpS2V5KGNyZWRlbnRpYWxzOiBPQXV0aENyZWRlbnRpYWxzKTogc3RyaW5nIHtcblx0XHRyZXR1cm4gY3JlZGVudGlhbHMuYWNjZXNzO1xuXHR9LFxuXG5cdG1vZGlmeU1vZGVscyhtb2RlbHMpIHtcblx0XHRyZXR1cm4gbW9kZWxzLmZpbHRlcigobW9kZWwpID0+IChcblx0XHRcdG1vZGVsLnByb3ZpZGVyICE9PSBcIm9wZW5haS1jb2RleFwiXG5cdFx0XHR8fCAhQ0hBVEdQVF9VTlNVUFBPUlRFRF9NT0RFTF9JRFMuaGFzKG1vZGVsLmlkKVxuXHRcdCkpO1xuXHR9LFxufTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQVFBLElBQUksZUFBZ0U7QUFDcEUsSUFBSSxRQUEyQztBQUMvQyxJQUFJLE9BQU8sWUFBWSxnQkFBZ0IsUUFBUSxVQUFVLFFBQVEsUUFBUSxVQUFVLE1BQU07QUFDeEYsU0FBTyxhQUFhLEVBQUUsS0FBSyxDQUFDLE1BQU07QUFDakMsbUJBQWUsRUFBRTtBQUFBLEVBQ2xCLENBQUM7QUFDRCxTQUFPLFdBQVcsRUFBRSxLQUFLLENBQUMsTUFBTTtBQUMvQixZQUFRO0FBQUEsRUFDVCxDQUFDO0FBQ0Y7QUFFQSxTQUFTLG9CQUFvQjtBQUc3QixNQUFNLFlBQVk7QUFDbEIsTUFBTSxnQkFBZ0I7QUFDdEIsTUFBTSxZQUFZO0FBQ2xCLE1BQU0sZUFBZTtBQUNyQixN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
