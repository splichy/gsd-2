import {
  getEnvApiKey
} from "@gsd/pi-ai";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@gsd/pi-ai/oauth";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "../config.js";
import { AUTH_LOCK_STALE_MS } from "./constants.js";
import { acquireLockAsync, acquireLockSyncWithRetry } from "./lock-utils.js";
import { resolveConfigValue } from "./resolve-config-value.js";
const GOOGLE_API_KEY_PROVIDERS = /* @__PURE__ */ new Set(["google"]);
function isGoogleOAuthToken(key) {
  return key.startsWith("ya29.");
}
function validateNotGoogleOAuthToken(provider, key) {
  if (GOOGLE_API_KEY_PROVIDERS.has(provider) && isGoogleOAuthToken(key)) {
    throw new Error(
      `The provided key for "${provider}" appears to be a Google OAuth access token (ya29.*), not a valid API key. Google AI Studio requires an API key starting with "AIza...". 

If you're using Google's Gemini CLI, its OAuth tokens are not compatible. Either:
  1. Get an API key from https://aistudio.google.com/apikey and set GEMINI_API_KEY
  2. Use '/login google-gemini-cli' to authenticate via Cloud Code Assist`
    );
  }
}
class FileAuthStorageBackend {
  constructor(authPath = join(getAgentDir(), "auth.json")) {
    this.authPath = authPath;
  }
  ensureParentDir() {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 448 });
    }
  }
  ensureFileExists() {
    if (!existsSync(this.authPath)) {
      writeFileSync(this.authPath, "{}", "utf-8");
      chmodSync(this.authPath, 384);
    }
  }
  withLock(fn) {
    this.ensureParentDir();
    this.ensureFileExists();
    let release;
    try {
      release = acquireLockSyncWithRetry(this.authPath);
      const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : void 0;
      const { result, next } = fn(current);
      if (next !== void 0) {
        writeFileSync(this.authPath, next, "utf-8");
        chmodSync(this.authPath, 384);
      }
      return result;
    } finally {
      if (release) {
        release();
      }
    }
  }
  async withLockAsync(fn) {
    this.ensureParentDir();
    this.ensureFileExists();
    let release;
    let lockCompromised = false;
    let lockCompromisedError;
    const throwIfCompromised = () => {
      if (lockCompromised) {
        throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
      }
    };
    try {
      release = await acquireLockAsync(this.authPath, {
        staleMs: AUTH_LOCK_STALE_MS,
        onCompromised: (err) => {
          lockCompromised = true;
          lockCompromisedError = err;
        }
      });
      throwIfCompromised();
      const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : void 0;
      const { result, next } = await fn(current);
      throwIfCompromised();
      if (next !== void 0) {
        writeFileSync(this.authPath, next, "utf-8");
        chmodSync(this.authPath, 384);
      }
      throwIfCompromised();
      return result;
    } finally {
      if (release) {
        try {
          await release();
        } catch {
        }
      }
    }
  }
}
class InMemoryAuthStorageBackend {
  withLock(fn) {
    const { result, next } = fn(this.value);
    if (next !== void 0) {
      this.value = next;
    }
    return result;
  }
  async withLockAsync(fn) {
    const { result, next } = await fn(this.value);
    if (next !== void 0) {
      this.value = next;
    }
    return result;
  }
}
const BACKOFF_RATE_LIMIT_MS = 3e4;
const BACKOFF_QUOTA_EXHAUSTED_MS = 30 * 6e4;
const BACKOFF_SERVER_ERROR_MS = 2e4;
const BACKOFF_DEFAULT_MS = 6e4;
function getBackoffDuration(errorType) {
  switch (errorType) {
    case "rate_limit":
      return BACKOFF_RATE_LIMIT_MS;
    case "quota_exhausted":
      return BACKOFF_QUOTA_EXHAUSTED_MS;
    case "server_error":
      return BACKOFF_SERVER_ERROR_MS;
    default:
      return BACKOFF_DEFAULT_MS;
  }
}
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char | 0;
  }
  return Math.abs(hash);
}
class AuthStorage {
  constructor(storage) {
    this.storage = storage;
    this.data = {};
    this.runtimeOverrides = /* @__PURE__ */ new Map();
    this.loadError = null;
    this.errors = [];
    this.credentialChangeListeners = /* @__PURE__ */ new Set();
    /**
     * Round-robin index per provider. Incremented on each call to getApiKey
     * when no sessionId is provided.
     */
    this.providerRoundRobinIndex = /* @__PURE__ */ new Map();
    /**
     * Backoff tracking per provider per credential index.
     * Map<provider, Map<credentialIndex, backoffExpiresAt>>
     */
    this.credentialBackoff = /* @__PURE__ */ new Map();
    /**
     * Provider-level backoff tracking.
     * Set when all credentials for a provider are backed off.
     * Map<provider, backoffExpiresAt>
     */
    this.providerBackoff = /* @__PURE__ */ new Map();
    this.reload();
  }
  static create(authPath) {
    return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")));
  }
  static fromStorage(storage) {
    return new AuthStorage(storage);
  }
  static inMemory(data = {}) {
    const storage = new InMemoryAuthStorageBackend();
    storage.withLock(() => ({ result: void 0, next: JSON.stringify(data, null, 2) }));
    return AuthStorage.fromStorage(storage);
  }
  /**
   * Set a runtime API key override (not persisted to disk).
   * Used for CLI --api-key flag.
   */
  setRuntimeApiKey(provider, apiKey) {
    this.runtimeOverrides.set(provider, apiKey);
  }
  /**
   * Remove a runtime API key override.
   */
  removeRuntimeApiKey(provider) {
    this.runtimeOverrides.delete(provider);
  }
  /**
   * Set a fallback resolver for API keys not found in auth.json or env vars.
   * Used for custom provider keys from models.json.
   */
  setFallbackResolver(resolver) {
    this.fallbackResolver = resolver;
  }
  /**
   * Register a callback to be notified when credentials change (e.g., after OAuth token refresh).
   * Returns a function to unregister the listener.
   */
  onCredentialChange(listener) {
    this.credentialChangeListeners.add(listener);
    return () => this.credentialChangeListeners.delete(listener);
  }
  notifyCredentialChange() {
    for (const listener of this.credentialChangeListeners) {
      try {
        listener();
      } catch {
      }
    }
  }
  recordError(error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.errors.push(normalizedError);
  }
  parseStorageData(content) {
    if (!content) {
      return {};
    }
    return JSON.parse(content);
  }
  /**
   * Normalize a storage entry to an array of credentials.
   * Handles both single credential (backward compat) and array formats.
   */
  getCredentialsForProvider(provider) {
    const entry = this.data[provider];
    if (!entry) return [];
    if (Array.isArray(entry)) return entry;
    return [entry];
  }
  /**
   * Reload credentials from storage.
   */
  reload() {
    let content;
    try {
      this.storage.withLock((current) => {
        content = current;
        return { result: void 0 };
      });
      this.data = this.parseStorageData(content);
      this.loadError = null;
    } catch (error) {
      this.loadError = error;
      this.recordError(error);
    }
  }
  persistProviderChange(provider, credential) {
    if (this.loadError) {
      return;
    }
    try {
      this.storage.withLock((current) => {
        const currentData = this.parseStorageData(current);
        const merged = { ...currentData };
        if (credential) {
          merged[provider] = credential;
        } else {
          delete merged[provider];
        }
        return { result: void 0, next: JSON.stringify(merged, null, 2) };
      });
    } catch (error) {
      this.recordError(error);
    }
  }
  /**
   * Get the first credential for a provider (backward-compatible).
   */
  get(provider) {
    const creds = this.getCredentialsForProvider(provider);
    return creds[0] ?? void 0;
  }
  /**
   * Set credential for a provider. For API key credentials, appends to
   * existing credentials (accumulation on duplicate login). For OAuth,
   * replaces (only one OAuth token per provider makes sense).
   */
  set(provider, credential) {
    if (credential.type === "api_key") {
      validateNotGoogleOAuthToken(provider, credential.key);
      const existing = this.getCredentialsForProvider(provider);
      const isDuplicate = existing.some(
        (c) => c.type === "api_key" && c.key === credential.key
      );
      if (isDuplicate) return;
      const updated = [...existing, credential];
      this.data[provider] = updated.length === 1 ? updated[0] : updated;
      this.persistProviderChange(provider, updated.length === 1 ? updated[0] : updated);
    } else {
      const existing = this.getCredentialsForProvider(provider);
      const apiKeys = existing.filter((c) => c.type === "api_key");
      if (apiKeys.length === 0) {
        this.data[provider] = credential;
        this.persistProviderChange(provider, credential);
      } else {
        const updated = [...apiKeys, credential];
        this.data[provider] = updated;
        this.persistProviderChange(provider, updated);
      }
    }
  }
  /**
   * Remove all credentials for a provider.
   */
  remove(provider) {
    delete this.data[provider];
    this.providerRoundRobinIndex.delete(provider);
    this.credentialBackoff.delete(provider);
    this.providerBackoff.delete(provider);
    this.persistProviderChange(provider, void 0);
  }
  /**
   * List all providers with credentials.
   */
  list() {
    return Object.keys(this.data);
  }
  /**
   * Check if credentials exist for a provider in auth.json.
   */
  has(provider) {
    return provider in this.data;
  }
  /**
   * Check if any form of auth is configured for a provider.
   * Unlike getApiKey(), this doesn't refresh OAuth tokens.
   */
  hasAuth(provider) {
    if (this.runtimeOverrides.has(provider)) return true;
    if (this.data[provider]) return true;
    if (getEnvApiKey(provider)) return true;
    if (this.fallbackResolver?.(provider)) return true;
    return false;
  }
  /**
   * Returns true if the stored credential for a provider is of type "oauth".
   * Used to detect stale OAuth credentials for providers where OAuth has been
   * removed (e.g. Anthropic, #3952) so callers can surface a targeted
   * migration message instead of a generic cooldown error.
   */
  hasLegacyOAuthCredential(provider) {
    return this.getCredentialsForProvider(provider).some((c) => c.type === "oauth");
  }
  /**
   * Remove only oauth-type credentials for a provider, preserving any api_key
   * entries. Used to self-heal stale OAuth credentials for providers where
   * OAuth support has been removed (e.g. Anthropic, #3952) without destroying
   * a user's valid API keys. Returns true if any oauth entries were removed.
   */
  removeLegacyOAuthCredential(provider) {
    const existing = this.getCredentialsForProvider(provider);
    const remaining = existing.filter((c) => c.type !== "oauth");
    if (remaining.length === existing.length) return false;
    if (remaining.length === 0) {
      delete this.data[provider];
      this.persistProviderChange(provider, void 0);
    } else {
      const next = remaining.length === 1 ? remaining[0] : remaining;
      this.data[provider] = next;
      this.persistProviderChange(provider, next);
    }
    this.providerRoundRobinIndex.delete(provider);
    this.credentialBackoff.delete(provider);
    this.providerBackoff.delete(provider);
    return true;
  }
  /**
   * Get all credentials (for passing to getOAuthApiKey).
   * Returns normalized format where each provider has a single credential
   * (the first one) for backward compatibility with OAuth refresh.
   *
   * NOTE: For providers with multiple API keys, only the first credential is
   * returned. This is intentional — callers use this for OAuth refresh only,
   * which is always single-credential. Do not use for API key enumeration.
   */
  getAll() {
    const result = {};
    for (const [provider, entry] of Object.entries(this.data)) {
      result[provider] = Array.isArray(entry) ? entry[0] : entry;
    }
    return result;
  }
  drainErrors() {
    const drained = [...this.errors];
    this.errors = [];
    return drained;
  }
  /**
   * Login to an OAuth provider.
   */
  async login(providerId, callbacks) {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${providerId}`);
    }
    const credentials = await provider.login(callbacks);
    this.set(providerId, { type: "oauth", ...credentials });
  }
  /**
   * Logout from a provider.
   */
  logout(provider) {
    this.remove(provider);
  }
  /**
   * Returns true when the provider has credentials configured but all of them
   * are currently in a backoff window (e.g. rate-limited or quota exhausted).
   * Returns false when there are no credentials or at least one is available.
   */
  areAllCredentialsBackedOff(provider) {
    const credentials = this.getCredentialsForProvider(provider);
    if (credentials.length === 0) return false;
    for (let i = 0; i < credentials.length; i++) {
      if (!this.isCredentialBackedOff(provider, i)) return false;
    }
    return true;
  }
  /**
   * Mark an entire provider as exhausted.
   * Called when all credentials for a provider are backed off.
   */
  markProviderExhausted(provider, errorType) {
    const backoffMs = getBackoffDuration(errorType);
    this.providerBackoff.set(provider, Date.now() + backoffMs);
  }
  /**
   * Check if a provider is currently available (not backed off at provider level).
   */
  isProviderAvailable(provider) {
    const expiresAt = this.providerBackoff.get(provider);
    if (expiresAt === void 0) return true;
    if (Date.now() >= expiresAt) {
      this.providerBackoff.delete(provider);
      return true;
    }
    return false;
  }
  /**
   * Get milliseconds remaining until provider backoff expires.
   * Returns 0 if provider is available.
   */
  getProviderBackoffRemaining(provider) {
    const expiresAt = this.providerBackoff.get(provider);
    if (expiresAt === void 0) return 0;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      this.providerBackoff.delete(provider);
      return 0;
    }
    return remaining;
  }
  /**
   * Get the earliest timestamp at which any credential for this provider
   * will become available again.  Returns `undefined` when no credentials
   * are backed off (i.e. all are immediately available).
   *
   * Callers can use this to sleep exactly long enough for the cooldown to
   * clear instead of using a fixed retry delay that may be shorter than the
   * backoff window.
   */
  getEarliestBackoffExpiry(provider) {
    const providerMap = this.credentialBackoff.get(provider);
    if (!providerMap || providerMap.size === 0) return void 0;
    const now = Date.now();
    let earliest;
    for (const [index, expiresAt] of providerMap) {
      if (expiresAt <= now) {
        providerMap.delete(index);
        continue;
      }
      if (earliest === void 0 || expiresAt < earliest) {
        earliest = expiresAt;
      }
    }
    return earliest;
  }
  /**
   * Check if a credential index is currently backed off.
   */
  isCredentialBackedOff(provider, index) {
    const providerBackoff = this.credentialBackoff.get(provider);
    if (!providerBackoff) return false;
    const expiresAt = providerBackoff.get(index);
    if (expiresAt === void 0) return false;
    if (Date.now() >= expiresAt) {
      providerBackoff.delete(index);
      return false;
    }
    return true;
  }
  /**
   * Select the best credential index for a provider.
   * - If sessionId is provided, uses session-sticky hashing as the starting point.
   * - Otherwise, uses round-robin as the starting point.
   * - Skips credentials that are currently backed off.
   * - Returns -1 if all credentials are backed off.
   */
  selectCredentialIndex(provider, credentials, sessionId) {
    if (credentials.length === 0) return -1;
    if (credentials.length === 1) {
      return this.isCredentialBackedOff(provider, 0) ? -1 : 0;
    }
    let startIndex;
    if (sessionId) {
      startIndex = hashString(sessionId) % credentials.length;
    } else {
      const current = this.providerRoundRobinIndex.get(provider) ?? 0;
      startIndex = current % credentials.length;
      this.providerRoundRobinIndex.set(provider, current + 1);
    }
    for (let offset = 0; offset < credentials.length; offset++) {
      const index = (startIndex + offset) % credentials.length;
      if (!this.isCredentialBackedOff(provider, index)) {
        return index;
      }
    }
    return -1;
  }
  /**
   * Mark a credential as rate-limited. Finds the credential that was most
   * recently used for this provider+session and backs it off.
   *
   * @returns true if another credential is available (caller should retry),
   *          false if all credentials for this provider are backed off.
   */
  markUsageLimitReached(provider, sessionId, options) {
    const credentials = this.getCredentialsForProvider(provider);
    if (credentials.length === 0) return false;
    const errorType = options?.errorType ?? "rate_limit";
    if (errorType === "unknown" && credentials.length === 1) {
      return false;
    }
    const backoffMs = getBackoffDuration(errorType);
    let usedIndex;
    if (credentials.length === 1) {
      usedIndex = 0;
    } else if (sessionId) {
      usedIndex = hashString(sessionId) % credentials.length;
    } else {
      const current = this.providerRoundRobinIndex.get(provider) ?? 0;
      usedIndex = ((current - 1) % credentials.length + credentials.length) % credentials.length;
    }
    let providerBackoff = this.credentialBackoff.get(provider);
    if (!providerBackoff) {
      providerBackoff = /* @__PURE__ */ new Map();
      this.credentialBackoff.set(provider, providerBackoff);
    }
    providerBackoff.set(usedIndex, Date.now() + backoffMs);
    for (let i = 0; i < credentials.length; i++) {
      if (!this.isCredentialBackedOff(provider, i)) {
        return true;
      }
    }
    return false;
  }
  /**
   * Refresh OAuth token with backend locking to prevent race conditions.
   * Multiple pi instances may try to refresh simultaneously when tokens expire.
   */
  async refreshOAuthTokenWithLock(providerId) {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      return null;
    }
    const result = await this.storage.withLockAsync(async (current) => {
      const currentData = this.parseStorageData(current);
      this.data = currentData;
      this.loadError = null;
      const creds = this.getCredentialsForProvider(providerId);
      const cred = creds.find((c) => c.type === "oauth");
      if (!cred || cred.type !== "oauth") {
        return { result: null };
      }
      if (Date.now() < cred.expires) {
        return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
      }
      const oauthCreds = {};
      for (const [key, value] of Object.entries(currentData)) {
        const first = Array.isArray(value) ? value.find((c) => c.type === "oauth") : value;
        if (first?.type === "oauth") {
          oauthCreds[key] = first;
        }
      }
      const refreshed = await getOAuthApiKey(providerId, oauthCreds);
      if (!refreshed) {
        return { result: null };
      }
      const existingEntry = currentData[providerId];
      const newOAuthCred = { type: "oauth", ...refreshed.newCredentials };
      let updatedEntry;
      if (Array.isArray(existingEntry)) {
        updatedEntry = existingEntry.map((c) => c.type === "oauth" ? newOAuthCred : c);
      } else {
        updatedEntry = newOAuthCred;
      }
      const merged = {
        ...currentData,
        [providerId]: updatedEntry
      };
      this.data = merged;
      this.loadError = null;
      return { result: refreshed, next: JSON.stringify(merged, null, 2) };
    });
    if (result) {
      queueMicrotask(() => this.notifyCredentialChange());
    }
    return result;
  }
  /**
   * Resolve an API key from a single credential.
   */
  async resolveCredentialApiKey(providerId, cred) {
    if (cred.type === "api_key") {
      return resolveConfigValue(cred.key);
    }
    if (cred.type === "oauth") {
      const provider = getOAuthProvider(providerId);
      if (!provider) return void 0;
      const needsRefresh = Date.now() >= cred.expires;
      if (needsRefresh) {
        try {
          const result = await this.refreshOAuthTokenWithLock(providerId);
          if (result) return result.apiKey;
        } catch (error) {
          this.recordError(error);
          this.reload();
          const updatedCreds = this.getCredentialsForProvider(providerId);
          const updatedOAuth = updatedCreds.find((c) => c.type === "oauth");
          if (updatedOAuth?.type === "oauth" && Date.now() < updatedOAuth.expires) {
            return provider.getApiKey(updatedOAuth);
          }
          return void 0;
        }
      } else {
        return provider.getApiKey(cred);
      }
    }
    return void 0;
  }
  /**
   * Get API key for a provider.
   * Priority:
   * 1. Runtime override (CLI --api-key)
   * 2. Credential(s) from auth.json (with round-robin / session-sticky selection)
   * 3. Environment variable
   * 4. Fallback resolver (models.json custom providers)
   *
   * @param providerId - The provider to get an API key for
   * @param sessionId - Optional session ID for sticky credential selection
   */
  async getApiKey(providerId, sessionId, options) {
    if (options?.baseUrl && !this.fallbackResolver?.(providerId)) {
      try {
        const hostname = new URL(options.baseUrl).hostname;
        if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1") {
          return "local-no-key-needed";
        }
      } catch {
        if (options.baseUrl.startsWith("unix:")) {
          return "local-no-key-needed";
        }
      }
    }
    const runtimeKey = this.runtimeOverrides.get(providerId);
    if (runtimeKey) {
      if (GOOGLE_API_KEY_PROVIDERS.has(providerId) && isGoogleOAuthToken(runtimeKey)) {
        this.recordError(
          new Error(
            `Blocked Google OAuth access token (ya29.*) for provider "${providerId}". Use an API key from https://aistudio.google.com/apikey or '/login google-gemini-cli'.`
          )
        );
        return void 0;
      }
      return runtimeKey;
    }
    const credentials = this.getCredentialsForProvider(providerId);
    if (credentials.length > 0) {
      const index = this.selectCredentialIndex(providerId, credentials, sessionId);
      if (index >= 0) {
        const resolved = await this.resolveCredentialApiKey(providerId, credentials[index]);
        if (resolved) return resolved;
      }
    }
    const envKey = getEnvApiKey(providerId);
    if (envKey) {
      if (GOOGLE_API_KEY_PROVIDERS.has(providerId) && isGoogleOAuthToken(envKey)) {
        this.recordError(
          new Error(
            `GEMINI_API_KEY contains a Google OAuth access token (ya29.*), not an API key. Get an API key from https://aistudio.google.com/apikey or use '/login google-gemini-cli'.`
          )
        );
        return void 0;
      }
      return envKey;
    }
    return this.fallbackResolver?.(providerId) ?? void 0;
  }
  /**
   * Get all registered OAuth providers
   */
  getOAuthProviders() {
    return getOAuthProviders();
  }
}
export {
  AuthStorage,
  FileAuthStorageBackend,
  InMemoryAuthStorageBackend,
  isGoogleOAuthToken
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2F1dGgtc3RvcmFnZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBDcmVkZW50aWFsIHN0b3JhZ2UgZm9yIEFQSSBrZXlzIGFuZCBPQXV0aCB0b2tlbnMuXG4gKiBIYW5kbGVzIGxvYWRpbmcsIHNhdmluZywgYW5kIHJlZnJlc2hpbmcgY3JlZGVudGlhbHMgZnJvbSBhdXRoLmpzb24uXG4gKlxuICogU3VwcG9ydHMgbXVsdGlwbGUgY3JlZGVudGlhbHMgcGVyIHByb3ZpZGVyIHdpdGggcm91bmQtcm9iaW4gc2VsZWN0aW9uLFxuICogc2Vzc2lvbi1zdGlja3kgaGFzaGluZywgYW5kIGF1dG9tYXRpYyByYXRlLWxpbWl0IGZhbGxiYWNrLlxuICpcbiAqIFVzZXMgZmlsZSBsb2NraW5nIHRvIHByZXZlbnQgcmFjZSBjb25kaXRpb25zIHdoZW4gbXVsdGlwbGUgcGkgaW5zdGFuY2VzXG4gKiB0cnkgdG8gcmVmcmVzaCB0b2tlbnMgc2ltdWx0YW5lb3VzbHkuXG4gKi9cblxuaW1wb3J0IHtcblx0Z2V0RW52QXBpS2V5LFxuXHR0eXBlIE9BdXRoQ3JlZGVudGlhbHMsXG5cdHR5cGUgT0F1dGhMb2dpbkNhbGxiYWNrcyxcblx0dHlwZSBPQXV0aFByb3ZpZGVySWQsXG59IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgeyBnZXRPQXV0aEFwaUtleSwgZ2V0T0F1dGhQcm92aWRlciwgZ2V0T0F1dGhQcm92aWRlcnMgfSBmcm9tIFwiQGdzZC9waS1haS9vYXV0aFwiO1xuaW1wb3J0IHsgY2htb2RTeW5jLCBleGlzdHNTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJmc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJwYXRoXCI7XG5pbXBvcnQgeyBnZXRBZ2VudERpciB9IGZyb20gXCIuLi9jb25maWcuanNcIjtcbmltcG9ydCB7IEFVVEhfTE9DS19TVEFMRV9NUyB9IGZyb20gXCIuL2NvbnN0YW50cy5qc1wiO1xuaW1wb3J0IHsgYWNxdWlyZUxvY2tBc3luYywgYWNxdWlyZUxvY2tTeW5jV2l0aFJldHJ5IH0gZnJvbSBcIi4vbG9jay11dGlscy5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZUNvbmZpZ1ZhbHVlIH0gZnJvbSBcIi4vcmVzb2x2ZS1jb25maWctdmFsdWUuanNcIjtcblxuZXhwb3J0IHR5cGUgQXBpS2V5Q3JlZGVudGlhbCA9IHtcblx0dHlwZTogXCJhcGlfa2V5XCI7XG5cdGtleTogc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgT0F1dGhDcmVkZW50aWFsID0ge1xuXHR0eXBlOiBcIm9hdXRoXCI7XG59ICYgT0F1dGhDcmVkZW50aWFscztcblxuZXhwb3J0IHR5cGUgQXV0aENyZWRlbnRpYWwgPSBBcGlLZXlDcmVkZW50aWFsIHwgT0F1dGhDcmVkZW50aWFsO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBHb29nbGUgT0F1dGggdG9rZW4gZGV0ZWN0aW9uXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogUHJvdmlkZXJzIHRoYXQgdXNlIEdvb2dsZSBBSSBTdHVkaW8gQVBJIGtleXMgKG5vdCBPQXV0aCB0b2tlbnMpLlxuICogT0F1dGggYWNjZXNzIHRva2VucyAoeWEyOS4qKSBhcmUgbm90IHZhbGlkIEFQSSBrZXlzIGZvciB0aGVzZSBwcm92aWRlcnMuXG4gKi9cbmNvbnN0IEdPT0dMRV9BUElfS0VZX1BST1ZJREVSUyA9IG5ldyBTZXQoW1wiZ29vZ2xlXCJdKTtcblxuLyoqXG4gKiBEZXRlY3QgaWYgYSBzdHJpbmcgaXMgYSBHb29nbGUgT0F1dGggYWNjZXNzIHRva2VuIHJhdGhlciB0aGFuIGFuIEFQSSBrZXkuXG4gKiBHb29nbGUgT0F1dGggYWNjZXNzIHRva2VucyBzdGFydCB3aXRoIFwieWEyOS5cIiBcdTIwMTQgdGhlc2UgYXJlIGlzc3VlZCBieVxuICogR29vZ2xlJ3MgT0F1dGgyIHRva2VuIGVuZHBvaW50IGFuZCBhcmUgbm90IHZhbGlkIGFzIEFJIFN0dWRpbyBBUEkga2V5cy5cbiAqXG4gKiBVc2VycyB3aG8gaW5zdGFsbGVkIEdvb2dsZSdzIEdlbWluaSBDTEkgbWF5IGhhdmUgdGhlc2UgdG9rZW5zIGFuZFxuICogbWlzdGFrZW5seSBzZXQgdGhlbSBhcyBHRU1JTklfQVBJX0tFWS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzR29vZ2xlT0F1dGhUb2tlbihrZXk6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRyZXR1cm4ga2V5LnN0YXJ0c1dpdGgoXCJ5YTI5LlwiKTtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSB0aGF0IGFuIEFQSSBrZXkgaXMgbm90IGEgR29vZ2xlIE9BdXRoIHRva2VuIGJlaW5nIHVzZWQgZm9yXG4gKiBhIHByb3ZpZGVyIHRoYXQgcmVxdWlyZXMgYWN0dWFsIEFQSSBrZXlzIChlLmcuLCBHb29nbGUgQUkgU3R1ZGlvKS5cbiAqIFRocm93cyBhIGRlc2NyaXB0aXZlIGVycm9yIGlmIHRoZSBrZXkgYXBwZWFycyB0byBiZSBhbiBPQXV0aCB0b2tlbi5cbiAqL1xuZnVuY3Rpb24gdmFsaWRhdGVOb3RHb29nbGVPQXV0aFRva2VuKHByb3ZpZGVyOiBzdHJpbmcsIGtleTogc3RyaW5nKTogdm9pZCB7XG5cdGlmIChHT09HTEVfQVBJX0tFWV9QUk9WSURFUlMuaGFzKHByb3ZpZGVyKSAmJiBpc0dvb2dsZU9BdXRoVG9rZW4oa2V5KSkge1xuXHRcdHRocm93IG5ldyBFcnJvcihcblx0XHRcdGBUaGUgcHJvdmlkZWQga2V5IGZvciBcIiR7cHJvdmlkZXJ9XCIgYXBwZWFycyB0byBiZSBhIEdvb2dsZSBPQXV0aCBhY2Nlc3MgdG9rZW4gKHlhMjkuKiksIGAgK1xuXHRcdFx0XHRgbm90IGEgdmFsaWQgQVBJIGtleS4gR29vZ2xlIEFJIFN0dWRpbyByZXF1aXJlcyBhbiBBUEkga2V5IHN0YXJ0aW5nIHdpdGggXCJBSXphLi4uXCIuIGAgK1xuXHRcdFx0XHRgXFxuXFxuSWYgeW91J3JlIHVzaW5nIEdvb2dsZSdzIEdlbWluaSBDTEksIGl0cyBPQXV0aCB0b2tlbnMgYXJlIG5vdCBjb21wYXRpYmxlLiBgICtcblx0XHRcdFx0YEVpdGhlcjpcXG5gICtcblx0XHRcdFx0YCAgMS4gR2V0IGFuIEFQSSBrZXkgZnJvbSBodHRwczovL2Fpc3R1ZGlvLmdvb2dsZS5jb20vYXBpa2V5IGFuZCBzZXQgR0VNSU5JX0FQSV9LRVlcXG5gICtcblx0XHRcdFx0YCAgMi4gVXNlICcvbG9naW4gZ29vZ2xlLWdlbWluaS1jbGknIHRvIGF1dGhlbnRpY2F0ZSB2aWEgQ2xvdWQgQ29kZSBBc3Npc3RgLFxuXHRcdCk7XG5cdH1cbn1cblxuLyoqXG4gKiBPbi1kaXNrIGZvcm1hdDogZWFjaCBwcm92aWRlciBtYXBzIHRvIGEgc2luZ2xlIGNyZWRlbnRpYWwgb3IgYW4gYXJyYXkgb2YgY3JlZGVudGlhbHMuXG4gKiBTaW5nbGUgY3JlZGVudGlhbHMgYXJlIG5vcm1hbGl6ZWQgdG8gYXJyYXlzIGF0IGxvYWQgdGltZSBmb3IgaW50ZXJuYWwgdXNlLlxuICovXG5leHBvcnQgdHlwZSBBdXRoU3RvcmFnZURhdGEgPSBSZWNvcmQ8c3RyaW5nLCBBdXRoQ3JlZGVudGlhbCB8IEF1dGhDcmVkZW50aWFsW10+O1xuXG50eXBlIExvY2tSZXN1bHQ8VD4gPSB7XG5cdHJlc3VsdDogVDtcblx0bmV4dD86IHN0cmluZztcbn07XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXV0aFN0b3JhZ2VCYWNrZW5kIHtcblx0d2l0aExvY2s8VD4oZm46IChjdXJyZW50OiBzdHJpbmcgfCB1bmRlZmluZWQpID0+IExvY2tSZXN1bHQ8VD4pOiBUO1xuXHR3aXRoTG9ja0FzeW5jPFQ+KGZuOiAoY3VycmVudDogc3RyaW5nIHwgdW5kZWZpbmVkKSA9PiBQcm9taXNlPExvY2tSZXN1bHQ8VD4+KTogUHJvbWlzZTxUPjtcbn1cblxuZXhwb3J0IGNsYXNzIEZpbGVBdXRoU3RvcmFnZUJhY2tlbmQgaW1wbGVtZW50cyBBdXRoU3RvcmFnZUJhY2tlbmQge1xuXHRjb25zdHJ1Y3Rvcihwcml2YXRlIGF1dGhQYXRoOiBzdHJpbmcgPSBqb2luKGdldEFnZW50RGlyKCksIFwiYXV0aC5qc29uXCIpKSB7fVxuXG5cdHByaXZhdGUgZW5zdXJlUGFyZW50RGlyKCk6IHZvaWQge1xuXHRcdGNvbnN0IGRpciA9IGRpcm5hbWUodGhpcy5hdXRoUGF0aCk7XG5cdFx0aWYgKCFleGlzdHNTeW5jKGRpcikpIHtcblx0XHRcdG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBtb2RlOiAwbzcwMCB9KTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGVuc3VyZUZpbGVFeGlzdHMoKTogdm9pZCB7XG5cdFx0aWYgKCFleGlzdHNTeW5jKHRoaXMuYXV0aFBhdGgpKSB7XG5cdFx0XHR3cml0ZUZpbGVTeW5jKHRoaXMuYXV0aFBhdGgsIFwie31cIiwgXCJ1dGYtOFwiKTtcblx0XHRcdGNobW9kU3luYyh0aGlzLmF1dGhQYXRoLCAwbzYwMCk7XG5cdFx0fVxuXHR9XG5cblx0d2l0aExvY2s8VD4oZm46IChjdXJyZW50OiBzdHJpbmcgfCB1bmRlZmluZWQpID0+IExvY2tSZXN1bHQ8VD4pOiBUIHtcblx0XHR0aGlzLmVuc3VyZVBhcmVudERpcigpO1xuXHRcdHRoaXMuZW5zdXJlRmlsZUV4aXN0cygpO1xuXG5cdFx0bGV0IHJlbGVhc2U6ICgoKSA9PiB2b2lkKSB8IHVuZGVmaW5lZDtcblx0XHR0cnkge1xuXHRcdFx0cmVsZWFzZSA9IGFjcXVpcmVMb2NrU3luY1dpdGhSZXRyeSh0aGlzLmF1dGhQYXRoKTtcblx0XHRcdGNvbnN0IGN1cnJlbnQgPSBleGlzdHNTeW5jKHRoaXMuYXV0aFBhdGgpID8gcmVhZEZpbGVTeW5jKHRoaXMuYXV0aFBhdGgsIFwidXRmLThcIikgOiB1bmRlZmluZWQ7XG5cdFx0XHRjb25zdCB7IHJlc3VsdCwgbmV4dCB9ID0gZm4oY3VycmVudCk7XG5cdFx0XHRpZiAobmV4dCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdHdyaXRlRmlsZVN5bmModGhpcy5hdXRoUGF0aCwgbmV4dCwgXCJ1dGYtOFwiKTtcblx0XHRcdFx0Y2htb2RTeW5jKHRoaXMuYXV0aFBhdGgsIDBvNjAwKTtcblx0XHRcdH1cblx0XHRcdHJldHVybiByZXN1bHQ7XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdGlmIChyZWxlYXNlKSB7XG5cdFx0XHRcdHJlbGVhc2UoKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRhc3luYyB3aXRoTG9ja0FzeW5jPFQ+KGZuOiAoY3VycmVudDogc3RyaW5nIHwgdW5kZWZpbmVkKSA9PiBQcm9taXNlPExvY2tSZXN1bHQ8VD4+KTogUHJvbWlzZTxUPiB7XG5cdFx0dGhpcy5lbnN1cmVQYXJlbnREaXIoKTtcblx0XHR0aGlzLmVuc3VyZUZpbGVFeGlzdHMoKTtcblxuXHRcdGxldCByZWxlYXNlOiAoKCkgPT4gUHJvbWlzZTx2b2lkPikgfCB1bmRlZmluZWQ7XG5cdFx0bGV0IGxvY2tDb21wcm9taXNlZCA9IGZhbHNlO1xuXHRcdGxldCBsb2NrQ29tcHJvbWlzZWRFcnJvcjogRXJyb3IgfCB1bmRlZmluZWQ7XG5cdFx0Y29uc3QgdGhyb3dJZkNvbXByb21pc2VkID0gKCkgPT4ge1xuXHRcdFx0aWYgKGxvY2tDb21wcm9taXNlZCkge1xuXHRcdFx0XHR0aHJvdyBsb2NrQ29tcHJvbWlzZWRFcnJvciA/PyBuZXcgRXJyb3IoXCJBdXRoIHN0b3JhZ2UgbG9jayB3YXMgY29tcHJvbWlzZWRcIik7XG5cdFx0XHR9XG5cdFx0fTtcblxuXHRcdHRyeSB7XG5cdFx0XHRyZWxlYXNlID0gYXdhaXQgYWNxdWlyZUxvY2tBc3luYyh0aGlzLmF1dGhQYXRoLCB7XG5cdFx0XHRcdHN0YWxlTXM6IEFVVEhfTE9DS19TVEFMRV9NUyxcblx0XHRcdFx0b25Db21wcm9taXNlZDogKGVycikgPT4ge1xuXHRcdFx0XHRcdGxvY2tDb21wcm9taXNlZCA9IHRydWU7XG5cdFx0XHRcdFx0bG9ja0NvbXByb21pc2VkRXJyb3IgPSBlcnI7XG5cdFx0XHRcdH0sXG5cdFx0XHR9KTtcblxuXHRcdFx0dGhyb3dJZkNvbXByb21pc2VkKCk7XG5cdFx0XHRjb25zdCBjdXJyZW50ID0gZXhpc3RzU3luYyh0aGlzLmF1dGhQYXRoKSA/IHJlYWRGaWxlU3luYyh0aGlzLmF1dGhQYXRoLCBcInV0Zi04XCIpIDogdW5kZWZpbmVkO1xuXHRcdFx0Y29uc3QgeyByZXN1bHQsIG5leHQgfSA9IGF3YWl0IGZuKGN1cnJlbnQpO1xuXHRcdFx0dGhyb3dJZkNvbXByb21pc2VkKCk7XG5cdFx0XHRpZiAobmV4dCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdHdyaXRlRmlsZVN5bmModGhpcy5hdXRoUGF0aCwgbmV4dCwgXCJ1dGYtOFwiKTtcblx0XHRcdFx0Y2htb2RTeW5jKHRoaXMuYXV0aFBhdGgsIDBvNjAwKTtcblx0XHRcdH1cblx0XHRcdHRocm93SWZDb21wcm9taXNlZCgpO1xuXHRcdFx0cmV0dXJuIHJlc3VsdDtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0aWYgKHJlbGVhc2UpIHtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRhd2FpdCByZWxlYXNlKCk7XG5cdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdC8vIElnbm9yZSB1bmxvY2sgZXJyb3JzIHdoZW4gbG9jayBpcyBjb21wcm9taXNlZC5cblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblx0fVxufVxuXG5leHBvcnQgY2xhc3MgSW5NZW1vcnlBdXRoU3RvcmFnZUJhY2tlbmQgaW1wbGVtZW50cyBBdXRoU3RvcmFnZUJhY2tlbmQge1xuXHRwcml2YXRlIHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cblx0d2l0aExvY2s8VD4oZm46IChjdXJyZW50OiBzdHJpbmcgfCB1bmRlZmluZWQpID0+IExvY2tSZXN1bHQ8VD4pOiBUIHtcblx0XHRjb25zdCB7IHJlc3VsdCwgbmV4dCB9ID0gZm4odGhpcy52YWx1ZSk7XG5cdFx0aWYgKG5leHQgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0dGhpcy52YWx1ZSA9IG5leHQ7XG5cdFx0fVxuXHRcdHJldHVybiByZXN1bHQ7XG5cdH1cblxuXHRhc3luYyB3aXRoTG9ja0FzeW5jPFQ+KGZuOiAoY3VycmVudDogc3RyaW5nIHwgdW5kZWZpbmVkKSA9PiBQcm9taXNlPExvY2tSZXN1bHQ8VD4+KTogUHJvbWlzZTxUPiB7XG5cdFx0Y29uc3QgeyByZXN1bHQsIG5leHQgfSA9IGF3YWl0IGZuKHRoaXMudmFsdWUpO1xuXHRcdGlmIChuZXh0ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdHRoaXMudmFsdWUgPSBuZXh0O1xuXHRcdH1cblx0XHRyZXR1cm4gcmVzdWx0O1xuXHR9XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEJhY2tvZmYgZHVyYXRpb25zIGZvciBkaWZmZXJlbnQgZXJyb3IgdHlwZXMgKG1pbGxpc2Vjb25kcylcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuY29uc3QgQkFDS09GRl9SQVRFX0xJTUlUX01TID0gMzBfMDAwOyAvLyAzMHMgZm9yIHJhdGUgbGltaXQgLyA0MjlcbmNvbnN0IEJBQ0tPRkZfUVVPVEFfRVhIQVVTVEVEX01TID0gMzAgKiA2MF8wMDA7IC8vIDMwbWluIGZvciBxdW90YSBleGhhdXN0ZWRcbmNvbnN0IEJBQ0tPRkZfU0VSVkVSX0VSUk9SX01TID0gMjBfMDAwOyAvLyAyMHMgZm9yIDV4eCBzZXJ2ZXIgZXJyb3JzXG5jb25zdCBCQUNLT0ZGX0RFRkFVTFRfTVMgPSA2MF8wMDA7IC8vIDYwcyBmYWxsYmFja1xuXG5leHBvcnQgdHlwZSBVc2FnZUxpbWl0RXJyb3JUeXBlID0gXCJyYXRlX2xpbWl0XCIgfCBcInF1b3RhX2V4aGF1c3RlZFwiIHwgXCJzZXJ2ZXJfZXJyb3JcIiB8IFwidW5rbm93blwiO1xuXG4vKipcbiAqIEdldCBiYWNrb2ZmIGR1cmF0aW9uIGZvciBhbiBlcnJvciB0eXBlLlxuICovXG5mdW5jdGlvbiBnZXRCYWNrb2ZmRHVyYXRpb24oZXJyb3JUeXBlOiBVc2FnZUxpbWl0RXJyb3JUeXBlKTogbnVtYmVyIHtcblx0c3dpdGNoIChlcnJvclR5cGUpIHtcblx0XHRjYXNlIFwicmF0ZV9saW1pdFwiOlxuXHRcdFx0cmV0dXJuIEJBQ0tPRkZfUkFURV9MSU1JVF9NUztcblx0XHRjYXNlIFwicXVvdGFfZXhoYXVzdGVkXCI6XG5cdFx0XHRyZXR1cm4gQkFDS09GRl9RVU9UQV9FWEhBVVNURURfTVM7XG5cdFx0Y2FzZSBcInNlcnZlcl9lcnJvclwiOlxuXHRcdFx0cmV0dXJuIEJBQ0tPRkZfU0VSVkVSX0VSUk9SX01TO1xuXHRcdGRlZmF1bHQ6XG5cdFx0XHRyZXR1cm4gQkFDS09GRl9ERUZBVUxUX01TO1xuXHR9XG59XG5cbi8qKlxuICogU2ltcGxlIHN0cmluZyBoYXNoIGZvciBzZXNzaW9uLXN0aWNreSBjcmVkZW50aWFsIHNlbGVjdGlvbi5cbiAqIFJldHVybnMgYSBwb3NpdGl2ZSBpbnRlZ2VyLlxuICovXG5mdW5jdGlvbiBoYXNoU3RyaW5nKHN0cjogc3RyaW5nKTogbnVtYmVyIHtcblx0bGV0IGhhc2ggPSAwO1xuXHRmb3IgKGxldCBpID0gMDsgaSA8IHN0ci5sZW5ndGg7IGkrKykge1xuXHRcdGNvbnN0IGNoYXIgPSBzdHIuY2hhckNvZGVBdChpKTtcblx0XHRoYXNoID0gKChoYXNoIDw8IDUpIC0gaGFzaCArIGNoYXIpIHwgMDtcblx0fVxuXHRyZXR1cm4gTWF0aC5hYnMoaGFzaCk7XG59XG5cbi8qKlxuICogQ3JlZGVudGlhbCBzdG9yYWdlIGJhY2tlZCBieSBhIEpTT04gZmlsZS5cbiAqIFN1cHBvcnRzIG11bHRpcGxlIGNyZWRlbnRpYWxzIHBlciBwcm92aWRlciB3aXRoIHJvdW5kLXJvYmluIHJvdGF0aW9uIGFuZCByYXRlLWxpbWl0IGZhbGxiYWNrLlxuICovXG5leHBvcnQgY2xhc3MgQXV0aFN0b3JhZ2Uge1xuXHRwcml2YXRlIGRhdGE6IEF1dGhTdG9yYWdlRGF0YSA9IHt9O1xuXHRwcml2YXRlIHJ1bnRpbWVPdmVycmlkZXM6IE1hcDxzdHJpbmcsIHN0cmluZz4gPSBuZXcgTWFwKCk7XG5cdHByaXZhdGUgZmFsbGJhY2tSZXNvbHZlcj86IChwcm92aWRlcjogc3RyaW5nKSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cdHByaXZhdGUgbG9hZEVycm9yOiBFcnJvciB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIGVycm9yczogRXJyb3JbXSA9IFtdO1xuXHRwcml2YXRlIGNyZWRlbnRpYWxDaGFuZ2VMaXN0ZW5lcnM6IFNldDwoKSA9PiB2b2lkPiA9IG5ldyBTZXQoKTtcblxuXHQvKipcblx0ICogUm91bmQtcm9iaW4gaW5kZXggcGVyIHByb3ZpZGVyLiBJbmNyZW1lbnRlZCBvbiBlYWNoIGNhbGwgdG8gZ2V0QXBpS2V5XG5cdCAqIHdoZW4gbm8gc2Vzc2lvbklkIGlzIHByb3ZpZGVkLlxuXHQgKi9cblx0cHJpdmF0ZSBwcm92aWRlclJvdW5kUm9iaW5JbmRleDogTWFwPHN0cmluZywgbnVtYmVyPiA9IG5ldyBNYXAoKTtcblxuXHQvKipcblx0ICogQmFja29mZiB0cmFja2luZyBwZXIgcHJvdmlkZXIgcGVyIGNyZWRlbnRpYWwgaW5kZXguXG5cdCAqIE1hcDxwcm92aWRlciwgTWFwPGNyZWRlbnRpYWxJbmRleCwgYmFja29mZkV4cGlyZXNBdD4+XG5cdCAqL1xuXHRwcml2YXRlIGNyZWRlbnRpYWxCYWNrb2ZmOiBNYXA8c3RyaW5nLCBNYXA8bnVtYmVyLCBudW1iZXI+PiA9IG5ldyBNYXAoKTtcblxuXHQvKipcblx0ICogUHJvdmlkZXItbGV2ZWwgYmFja29mZiB0cmFja2luZy5cblx0ICogU2V0IHdoZW4gYWxsIGNyZWRlbnRpYWxzIGZvciBhIHByb3ZpZGVyIGFyZSBiYWNrZWQgb2ZmLlxuXHQgKiBNYXA8cHJvdmlkZXIsIGJhY2tvZmZFeHBpcmVzQXQ+XG5cdCAqL1xuXHRwcml2YXRlIHByb3ZpZGVyQmFja29mZjogTWFwPHN0cmluZywgbnVtYmVyPiA9IG5ldyBNYXAoKTtcblxuXHRwcml2YXRlIGNvbnN0cnVjdG9yKHByaXZhdGUgc3RvcmFnZTogQXV0aFN0b3JhZ2VCYWNrZW5kKSB7XG5cdFx0dGhpcy5yZWxvYWQoKTtcblx0fVxuXG5cdHN0YXRpYyBjcmVhdGUoYXV0aFBhdGg/OiBzdHJpbmcpOiBBdXRoU3RvcmFnZSB7XG5cdFx0cmV0dXJuIG5ldyBBdXRoU3RvcmFnZShuZXcgRmlsZUF1dGhTdG9yYWdlQmFja2VuZChhdXRoUGF0aCA/PyBqb2luKGdldEFnZW50RGlyKCksIFwiYXV0aC5qc29uXCIpKSk7XG5cdH1cblxuXHRzdGF0aWMgZnJvbVN0b3JhZ2Uoc3RvcmFnZTogQXV0aFN0b3JhZ2VCYWNrZW5kKTogQXV0aFN0b3JhZ2Uge1xuXHRcdHJldHVybiBuZXcgQXV0aFN0b3JhZ2Uoc3RvcmFnZSk7XG5cdH1cblxuXHRzdGF0aWMgaW5NZW1vcnkoZGF0YTogQXV0aFN0b3JhZ2VEYXRhID0ge30pOiBBdXRoU3RvcmFnZSB7XG5cdFx0Y29uc3Qgc3RvcmFnZSA9IG5ldyBJbk1lbW9yeUF1dGhTdG9yYWdlQmFja2VuZCgpO1xuXHRcdHN0b3JhZ2Uud2l0aExvY2soKCkgPT4gKHsgcmVzdWx0OiB1bmRlZmluZWQsIG5leHQ6IEpTT04uc3RyaW5naWZ5KGRhdGEsIG51bGwsIDIpIH0pKTtcblx0XHRyZXR1cm4gQXV0aFN0b3JhZ2UuZnJvbVN0b3JhZ2Uoc3RvcmFnZSk7XG5cdH1cblxuXHQvKipcblx0ICogU2V0IGEgcnVudGltZSBBUEkga2V5IG92ZXJyaWRlIChub3QgcGVyc2lzdGVkIHRvIGRpc2spLlxuXHQgKiBVc2VkIGZvciBDTEkgLS1hcGkta2V5IGZsYWcuXG5cdCAqL1xuXHRzZXRSdW50aW1lQXBpS2V5KHByb3ZpZGVyOiBzdHJpbmcsIGFwaUtleTogc3RyaW5nKTogdm9pZCB7XG5cdFx0dGhpcy5ydW50aW1lT3ZlcnJpZGVzLnNldChwcm92aWRlciwgYXBpS2V5KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBSZW1vdmUgYSBydW50aW1lIEFQSSBrZXkgb3ZlcnJpZGUuXG5cdCAqL1xuXHRyZW1vdmVSdW50aW1lQXBpS2V5KHByb3ZpZGVyOiBzdHJpbmcpOiB2b2lkIHtcblx0XHR0aGlzLnJ1bnRpbWVPdmVycmlkZXMuZGVsZXRlKHByb3ZpZGVyKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgYSBmYWxsYmFjayByZXNvbHZlciBmb3IgQVBJIGtleXMgbm90IGZvdW5kIGluIGF1dGguanNvbiBvciBlbnYgdmFycy5cblx0ICogVXNlZCBmb3IgY3VzdG9tIHByb3ZpZGVyIGtleXMgZnJvbSBtb2RlbHMuanNvbi5cblx0ICovXG5cdHNldEZhbGxiYWNrUmVzb2x2ZXIocmVzb2x2ZXI6IChwcm92aWRlcjogc3RyaW5nKSA9PiBzdHJpbmcgfCB1bmRlZmluZWQpOiB2b2lkIHtcblx0XHR0aGlzLmZhbGxiYWNrUmVzb2x2ZXIgPSByZXNvbHZlcjtcblx0fVxuXG5cdC8qKlxuXHQgKiBSZWdpc3RlciBhIGNhbGxiYWNrIHRvIGJlIG5vdGlmaWVkIHdoZW4gY3JlZGVudGlhbHMgY2hhbmdlIChlLmcuLCBhZnRlciBPQXV0aCB0b2tlbiByZWZyZXNoKS5cblx0ICogUmV0dXJucyBhIGZ1bmN0aW9uIHRvIHVucmVnaXN0ZXIgdGhlIGxpc3RlbmVyLlxuXHQgKi9cblx0b25DcmVkZW50aWFsQ2hhbmdlKGxpc3RlbmVyOiAoKSA9PiB2b2lkKTogKCkgPT4gdm9pZCB7XG5cdFx0dGhpcy5jcmVkZW50aWFsQ2hhbmdlTGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG5cdFx0cmV0dXJuICgpID0+IHRoaXMuY3JlZGVudGlhbENoYW5nZUxpc3RlbmVycy5kZWxldGUobGlzdGVuZXIpO1xuXHR9XG5cblx0cHJpdmF0ZSBub3RpZnlDcmVkZW50aWFsQ2hhbmdlKCk6IHZvaWQge1xuXHRcdGZvciAoY29uc3QgbGlzdGVuZXIgb2YgdGhpcy5jcmVkZW50aWFsQ2hhbmdlTGlzdGVuZXJzKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRsaXN0ZW5lcigpO1xuXHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdC8vIERvbid0IGxldCBsaXN0ZW5lciBlcnJvcnMgYnJlYWsgdGhlIHJlZnJlc2ggZmxvd1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgcmVjb3JkRXJyb3IoZXJyb3I6IHVua25vd24pOiB2b2lkIHtcblx0XHRjb25zdCBub3JtYWxpemVkRXJyb3IgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSk7XG5cdFx0dGhpcy5lcnJvcnMucHVzaChub3JtYWxpemVkRXJyb3IpO1xuXHR9XG5cblx0cHJpdmF0ZSBwYXJzZVN0b3JhZ2VEYXRhKGNvbnRlbnQ6IHN0cmluZyB8IHVuZGVmaW5lZCk6IEF1dGhTdG9yYWdlRGF0YSB7XG5cdFx0aWYgKCFjb250ZW50KSB7XG5cdFx0XHRyZXR1cm4ge307XG5cdFx0fVxuXHRcdHJldHVybiBKU09OLnBhcnNlKGNvbnRlbnQpIGFzIEF1dGhTdG9yYWdlRGF0YTtcblx0fVxuXG5cdC8qKlxuXHQgKiBOb3JtYWxpemUgYSBzdG9yYWdlIGVudHJ5IHRvIGFuIGFycmF5IG9mIGNyZWRlbnRpYWxzLlxuXHQgKiBIYW5kbGVzIGJvdGggc2luZ2xlIGNyZWRlbnRpYWwgKGJhY2t3YXJkIGNvbXBhdCkgYW5kIGFycmF5IGZvcm1hdHMuXG5cdCAqL1xuXHRnZXRDcmVkZW50aWFsc0ZvclByb3ZpZGVyKHByb3ZpZGVyOiBzdHJpbmcpOiBBdXRoQ3JlZGVudGlhbFtdIHtcblx0XHRjb25zdCBlbnRyeSA9IHRoaXMuZGF0YVtwcm92aWRlcl07XG5cdFx0aWYgKCFlbnRyeSkgcmV0dXJuIFtdO1xuXHRcdGlmIChBcnJheS5pc0FycmF5KGVudHJ5KSkgcmV0dXJuIGVudHJ5O1xuXHRcdHJldHVybiBbZW50cnldO1xuXHR9XG5cblx0LyoqXG5cdCAqIFJlbG9hZCBjcmVkZW50aWFscyBmcm9tIHN0b3JhZ2UuXG5cdCAqL1xuXHRyZWxvYWQoKTogdm9pZCB7XG5cdFx0bGV0IGNvbnRlbnQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcblx0XHR0cnkge1xuXHRcdFx0dGhpcy5zdG9yYWdlLndpdGhMb2NrKChjdXJyZW50KSA9PiB7XG5cdFx0XHRcdGNvbnRlbnQgPSBjdXJyZW50O1xuXHRcdFx0XHRyZXR1cm4geyByZXN1bHQ6IHVuZGVmaW5lZCB9O1xuXHRcdFx0fSk7XG5cdFx0XHR0aGlzLmRhdGEgPSB0aGlzLnBhcnNlU3RvcmFnZURhdGEoY29udGVudCk7XG5cdFx0XHR0aGlzLmxvYWRFcnJvciA9IG51bGw7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdHRoaXMubG9hZEVycm9yID0gZXJyb3IgYXMgRXJyb3I7XG5cdFx0XHR0aGlzLnJlY29yZEVycm9yKGVycm9yKTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIHBlcnNpc3RQcm92aWRlckNoYW5nZShwcm92aWRlcjogc3RyaW5nLCBjcmVkZW50aWFsOiBBdXRoQ3JlZGVudGlhbCB8IEF1dGhDcmVkZW50aWFsW10gfCB1bmRlZmluZWQpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5sb2FkRXJyb3IpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHR0cnkge1xuXHRcdFx0dGhpcy5zdG9yYWdlLndpdGhMb2NrKChjdXJyZW50KSA9PiB7XG5cdFx0XHRcdGNvbnN0IGN1cnJlbnREYXRhID0gdGhpcy5wYXJzZVN0b3JhZ2VEYXRhKGN1cnJlbnQpO1xuXHRcdFx0XHRjb25zdCBtZXJnZWQ6IEF1dGhTdG9yYWdlRGF0YSA9IHsgLi4uY3VycmVudERhdGEgfTtcblx0XHRcdFx0aWYgKGNyZWRlbnRpYWwpIHtcblx0XHRcdFx0XHRtZXJnZWRbcHJvdmlkZXJdID0gY3JlZGVudGlhbDtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRkZWxldGUgbWVyZ2VkW3Byb3ZpZGVyXTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4geyByZXN1bHQ6IHVuZGVmaW5lZCwgbmV4dDogSlNPTi5zdHJpbmdpZnkobWVyZ2VkLCBudWxsLCAyKSB9O1xuXHRcdFx0fSk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdHRoaXMucmVjb3JkRXJyb3IoZXJyb3IpO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgdGhlIGZpcnN0IGNyZWRlbnRpYWwgZm9yIGEgcHJvdmlkZXIgKGJhY2t3YXJkLWNvbXBhdGlibGUpLlxuXHQgKi9cblx0Z2V0KHByb3ZpZGVyOiBzdHJpbmcpOiBBdXRoQ3JlZGVudGlhbCB8IHVuZGVmaW5lZCB7XG5cdFx0Y29uc3QgY3JlZHMgPSB0aGlzLmdldENyZWRlbnRpYWxzRm9yUHJvdmlkZXIocHJvdmlkZXIpO1xuXHRcdHJldHVybiBjcmVkc1swXSA/PyB1bmRlZmluZWQ7XG5cdH1cblxuXHQvKipcblx0ICogU2V0IGNyZWRlbnRpYWwgZm9yIGEgcHJvdmlkZXIuIEZvciBBUEkga2V5IGNyZWRlbnRpYWxzLCBhcHBlbmRzIHRvXG5cdCAqIGV4aXN0aW5nIGNyZWRlbnRpYWxzIChhY2N1bXVsYXRpb24gb24gZHVwbGljYXRlIGxvZ2luKS4gRm9yIE9BdXRoLFxuXHQgKiByZXBsYWNlcyAob25seSBvbmUgT0F1dGggdG9rZW4gcGVyIHByb3ZpZGVyIG1ha2VzIHNlbnNlKS5cblx0ICovXG5cdHNldChwcm92aWRlcjogc3RyaW5nLCBjcmVkZW50aWFsOiBBdXRoQ3JlZGVudGlhbCk6IHZvaWQge1xuXHRcdGlmIChjcmVkZW50aWFsLnR5cGUgPT09IFwiYXBpX2tleVwiKSB7XG5cdFx0XHQvLyBCbG9jayBHb29nbGUgT0F1dGggdG9rZW5zIGJlaW5nIHN0b3JlZCBhcyBBUEkga2V5cyBmb3IgQUkgU3R1ZGlvIHByb3ZpZGVyc1xuXHRcdFx0dmFsaWRhdGVOb3RHb29nbGVPQXV0aFRva2VuKHByb3ZpZGVyLCBjcmVkZW50aWFsLmtleSk7XG5cblx0XHRcdGNvbnN0IGV4aXN0aW5nID0gdGhpcy5nZXRDcmVkZW50aWFsc0ZvclByb3ZpZGVyKHByb3ZpZGVyKTtcblx0XHRcdC8vIERlZHVwbGljYXRlOiBkb24ndCBhZGQgaWYgc2FtZSBrZXkgYWxyZWFkeSBleGlzdHNcblx0XHRcdGNvbnN0IGlzRHVwbGljYXRlID0gZXhpc3Rpbmcuc29tZShcblx0XHRcdFx0KGMpID0+IGMudHlwZSA9PT0gXCJhcGlfa2V5XCIgJiYgYy5rZXkgPT09IGNyZWRlbnRpYWwua2V5LFxuXHRcdFx0KTtcblx0XHRcdGlmIChpc0R1cGxpY2F0ZSkgcmV0dXJuO1xuXG5cdFx0XHRjb25zdCB1cGRhdGVkID0gWy4uLmV4aXN0aW5nLCBjcmVkZW50aWFsXTtcblx0XHRcdHRoaXMuZGF0YVtwcm92aWRlcl0gPSB1cGRhdGVkLmxlbmd0aCA9PT0gMSA/IHVwZGF0ZWRbMF0gOiB1cGRhdGVkO1xuXHRcdFx0dGhpcy5wZXJzaXN0UHJvdmlkZXJDaGFuZ2UocHJvdmlkZXIsIHVwZGF0ZWQubGVuZ3RoID09PSAxID8gdXBkYXRlZFswXSA6IHVwZGF0ZWQpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBPQXV0aDogcmVwbGFjZSBhbnkgZXhpc3RpbmcgT0F1dGggY3JlZGVudGlhbCwga2VlcCBBUEkga2V5c1xuXHRcdFx0Y29uc3QgZXhpc3RpbmcgPSB0aGlzLmdldENyZWRlbnRpYWxzRm9yUHJvdmlkZXIocHJvdmlkZXIpO1xuXHRcdFx0Y29uc3QgYXBpS2V5cyA9IGV4aXN0aW5nLmZpbHRlcigoYykgPT4gYy50eXBlID09PSBcImFwaV9rZXlcIik7XG5cdFx0XHRpZiAoYXBpS2V5cy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0dGhpcy5kYXRhW3Byb3ZpZGVyXSA9IGNyZWRlbnRpYWw7XG5cdFx0XHRcdHRoaXMucGVyc2lzdFByb3ZpZGVyQ2hhbmdlKHByb3ZpZGVyLCBjcmVkZW50aWFsKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGNvbnN0IHVwZGF0ZWQgPSBbLi4uYXBpS2V5cywgY3JlZGVudGlhbF07XG5cdFx0XHRcdHRoaXMuZGF0YVtwcm92aWRlcl0gPSB1cGRhdGVkO1xuXHRcdFx0XHR0aGlzLnBlcnNpc3RQcm92aWRlckNoYW5nZShwcm92aWRlciwgdXBkYXRlZCk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIFJlbW92ZSBhbGwgY3JlZGVudGlhbHMgZm9yIGEgcHJvdmlkZXIuXG5cdCAqL1xuXHRyZW1vdmUocHJvdmlkZXI6IHN0cmluZyk6IHZvaWQge1xuXHRcdGRlbGV0ZSB0aGlzLmRhdGFbcHJvdmlkZXJdO1xuXHRcdHRoaXMucHJvdmlkZXJSb3VuZFJvYmluSW5kZXguZGVsZXRlKHByb3ZpZGVyKTtcblx0XHR0aGlzLmNyZWRlbnRpYWxCYWNrb2ZmLmRlbGV0ZShwcm92aWRlcik7XG5cdFx0dGhpcy5wcm92aWRlckJhY2tvZmYuZGVsZXRlKHByb3ZpZGVyKTtcblx0XHR0aGlzLnBlcnNpc3RQcm92aWRlckNoYW5nZShwcm92aWRlciwgdW5kZWZpbmVkKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBMaXN0IGFsbCBwcm92aWRlcnMgd2l0aCBjcmVkZW50aWFscy5cblx0ICovXG5cdGxpc3QoKTogc3RyaW5nW10ge1xuXHRcdHJldHVybiBPYmplY3Qua2V5cyh0aGlzLmRhdGEpO1xuXHR9XG5cblx0LyoqXG5cdCAqIENoZWNrIGlmIGNyZWRlbnRpYWxzIGV4aXN0IGZvciBhIHByb3ZpZGVyIGluIGF1dGguanNvbi5cblx0ICovXG5cdGhhcyhwcm92aWRlcjogc3RyaW5nKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHByb3ZpZGVyIGluIHRoaXMuZGF0YTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDaGVjayBpZiBhbnkgZm9ybSBvZiBhdXRoIGlzIGNvbmZpZ3VyZWQgZm9yIGEgcHJvdmlkZXIuXG5cdCAqIFVubGlrZSBnZXRBcGlLZXkoKSwgdGhpcyBkb2Vzbid0IHJlZnJlc2ggT0F1dGggdG9rZW5zLlxuXHQgKi9cblx0aGFzQXV0aChwcm92aWRlcjogc3RyaW5nKTogYm9vbGVhbiB7XG5cdFx0aWYgKHRoaXMucnVudGltZU92ZXJyaWRlcy5oYXMocHJvdmlkZXIpKSByZXR1cm4gdHJ1ZTtcblx0XHRpZiAodGhpcy5kYXRhW3Byb3ZpZGVyXSkgcmV0dXJuIHRydWU7XG5cdFx0aWYgKGdldEVudkFwaUtleShwcm92aWRlcikpIHJldHVybiB0cnVlO1xuXHRcdGlmICh0aGlzLmZhbGxiYWNrUmVzb2x2ZXI/Lihwcm92aWRlcikpIHJldHVybiB0cnVlO1xuXHRcdHJldHVybiBmYWxzZTtcblx0fVxuXG5cdC8qKlxuXHQgKiBSZXR1cm5zIHRydWUgaWYgdGhlIHN0b3JlZCBjcmVkZW50aWFsIGZvciBhIHByb3ZpZGVyIGlzIG9mIHR5cGUgXCJvYXV0aFwiLlxuXHQgKiBVc2VkIHRvIGRldGVjdCBzdGFsZSBPQXV0aCBjcmVkZW50aWFscyBmb3IgcHJvdmlkZXJzIHdoZXJlIE9BdXRoIGhhcyBiZWVuXG5cdCAqIHJlbW92ZWQgKGUuZy4gQW50aHJvcGljLCAjMzk1Mikgc28gY2FsbGVycyBjYW4gc3VyZmFjZSBhIHRhcmdldGVkXG5cdCAqIG1pZ3JhdGlvbiBtZXNzYWdlIGluc3RlYWQgb2YgYSBnZW5lcmljIGNvb2xkb3duIGVycm9yLlxuXHQgKi9cblx0aGFzTGVnYWN5T0F1dGhDcmVkZW50aWFsKHByb3ZpZGVyOiBzdHJpbmcpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5nZXRDcmVkZW50aWFsc0ZvclByb3ZpZGVyKHByb3ZpZGVyKS5zb21lKChjKSA9PiBjLnR5cGUgPT09IFwib2F1dGhcIik7XG5cdH1cblxuXHQvKipcblx0ICogUmVtb3ZlIG9ubHkgb2F1dGgtdHlwZSBjcmVkZW50aWFscyBmb3IgYSBwcm92aWRlciwgcHJlc2VydmluZyBhbnkgYXBpX2tleVxuXHQgKiBlbnRyaWVzLiBVc2VkIHRvIHNlbGYtaGVhbCBzdGFsZSBPQXV0aCBjcmVkZW50aWFscyBmb3IgcHJvdmlkZXJzIHdoZXJlXG5cdCAqIE9BdXRoIHN1cHBvcnQgaGFzIGJlZW4gcmVtb3ZlZCAoZS5nLiBBbnRocm9waWMsICMzOTUyKSB3aXRob3V0IGRlc3Ryb3lpbmdcblx0ICogYSB1c2VyJ3MgdmFsaWQgQVBJIGtleXMuIFJldHVybnMgdHJ1ZSBpZiBhbnkgb2F1dGggZW50cmllcyB3ZXJlIHJlbW92ZWQuXG5cdCAqL1xuXHRyZW1vdmVMZWdhY3lPQXV0aENyZWRlbnRpYWwocHJvdmlkZXI6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRcdGNvbnN0IGV4aXN0aW5nID0gdGhpcy5nZXRDcmVkZW50aWFsc0ZvclByb3ZpZGVyKHByb3ZpZGVyKTtcblx0XHRjb25zdCByZW1haW5pbmcgPSBleGlzdGluZy5maWx0ZXIoKGMpID0+IGMudHlwZSAhPT0gXCJvYXV0aFwiKTtcblx0XHRpZiAocmVtYWluaW5nLmxlbmd0aCA9PT0gZXhpc3RpbmcubGVuZ3RoKSByZXR1cm4gZmFsc2U7XG5cblx0XHRpZiAocmVtYWluaW5nLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0ZGVsZXRlIHRoaXMuZGF0YVtwcm92aWRlcl07XG5cdFx0XHR0aGlzLnBlcnNpc3RQcm92aWRlckNoYW5nZShwcm92aWRlciwgdW5kZWZpbmVkKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc3QgbmV4dCA9IHJlbWFpbmluZy5sZW5ndGggPT09IDEgPyByZW1haW5pbmdbMF0gOiByZW1haW5pbmc7XG5cdFx0XHR0aGlzLmRhdGFbcHJvdmlkZXJdID0gbmV4dDtcblx0XHRcdHRoaXMucGVyc2lzdFByb3ZpZGVyQ2hhbmdlKHByb3ZpZGVyLCBuZXh0KTtcblx0XHR9XG5cdFx0dGhpcy5wcm92aWRlclJvdW5kUm9iaW5JbmRleC5kZWxldGUocHJvdmlkZXIpO1xuXHRcdHRoaXMuY3JlZGVudGlhbEJhY2tvZmYuZGVsZXRlKHByb3ZpZGVyKTtcblx0XHR0aGlzLnByb3ZpZGVyQmFja29mZi5kZWxldGUocHJvdmlkZXIpO1xuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCBhbGwgY3JlZGVudGlhbHMgKGZvciBwYXNzaW5nIHRvIGdldE9BdXRoQXBpS2V5KS5cblx0ICogUmV0dXJucyBub3JtYWxpemVkIGZvcm1hdCB3aGVyZSBlYWNoIHByb3ZpZGVyIGhhcyBhIHNpbmdsZSBjcmVkZW50aWFsXG5cdCAqICh0aGUgZmlyc3Qgb25lKSBmb3IgYmFja3dhcmQgY29tcGF0aWJpbGl0eSB3aXRoIE9BdXRoIHJlZnJlc2guXG5cdCAqXG5cdCAqIE5PVEU6IEZvciBwcm92aWRlcnMgd2l0aCBtdWx0aXBsZSBBUEkga2V5cywgb25seSB0aGUgZmlyc3QgY3JlZGVudGlhbCBpc1xuXHQgKiByZXR1cm5lZC4gVGhpcyBpcyBpbnRlbnRpb25hbCBcdTIwMTQgY2FsbGVycyB1c2UgdGhpcyBmb3IgT0F1dGggcmVmcmVzaCBvbmx5LFxuXHQgKiB3aGljaCBpcyBhbHdheXMgc2luZ2xlLWNyZWRlbnRpYWwuIERvIG5vdCB1c2UgZm9yIEFQSSBrZXkgZW51bWVyYXRpb24uXG5cdCAqL1xuXHRnZXRBbGwoKTogUmVjb3JkPHN0cmluZywgQXV0aENyZWRlbnRpYWw+IHtcblx0XHRjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIEF1dGhDcmVkZW50aWFsPiA9IHt9O1xuXHRcdGZvciAoY29uc3QgW3Byb3ZpZGVyLCBlbnRyeV0gb2YgT2JqZWN0LmVudHJpZXModGhpcy5kYXRhKSkge1xuXHRcdFx0cmVzdWx0W3Byb3ZpZGVyXSA9IEFycmF5LmlzQXJyYXkoZW50cnkpID8gZW50cnlbMF0gOiBlbnRyeTtcblx0XHR9XG5cdFx0cmV0dXJuIHJlc3VsdDtcblx0fVxuXG5cdGRyYWluRXJyb3JzKCk6IEVycm9yW10ge1xuXHRcdGNvbnN0IGRyYWluZWQgPSBbLi4udGhpcy5lcnJvcnNdO1xuXHRcdHRoaXMuZXJyb3JzID0gW107XG5cdFx0cmV0dXJuIGRyYWluZWQ7XG5cdH1cblxuXHQvKipcblx0ICogTG9naW4gdG8gYW4gT0F1dGggcHJvdmlkZXIuXG5cdCAqL1xuXHRhc3luYyBsb2dpbihwcm92aWRlcklkOiBPQXV0aFByb3ZpZGVySWQsIGNhbGxiYWNrczogT0F1dGhMb2dpbkNhbGxiYWNrcyk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IHByb3ZpZGVyID0gZ2V0T0F1dGhQcm92aWRlcihwcm92aWRlcklkKTtcblx0XHRpZiAoIXByb3ZpZGVyKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gT0F1dGggcHJvdmlkZXI6ICR7cHJvdmlkZXJJZH1gKTtcblx0XHR9XG5cblx0XHRjb25zdCBjcmVkZW50aWFscyA9IGF3YWl0IHByb3ZpZGVyLmxvZ2luKGNhbGxiYWNrcyk7XG5cdFx0dGhpcy5zZXQocHJvdmlkZXJJZCwgeyB0eXBlOiBcIm9hdXRoXCIsIC4uLmNyZWRlbnRpYWxzIH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIExvZ291dCBmcm9tIGEgcHJvdmlkZXIuXG5cdCAqL1xuXHRsb2dvdXQocHJvdmlkZXI6IHN0cmluZyk6IHZvaWQge1xuXHRcdHRoaXMucmVtb3ZlKHByb3ZpZGVyKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBSZXR1cm5zIHRydWUgd2hlbiB0aGUgcHJvdmlkZXIgaGFzIGNyZWRlbnRpYWxzIGNvbmZpZ3VyZWQgYnV0IGFsbCBvZiB0aGVtXG5cdCAqIGFyZSBjdXJyZW50bHkgaW4gYSBiYWNrb2ZmIHdpbmRvdyAoZS5nLiByYXRlLWxpbWl0ZWQgb3IgcXVvdGEgZXhoYXVzdGVkKS5cblx0ICogUmV0dXJucyBmYWxzZSB3aGVuIHRoZXJlIGFyZSBubyBjcmVkZW50aWFscyBvciBhdCBsZWFzdCBvbmUgaXMgYXZhaWxhYmxlLlxuXHQgKi9cblx0YXJlQWxsQ3JlZGVudGlhbHNCYWNrZWRPZmYocHJvdmlkZXI6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRcdGNvbnN0IGNyZWRlbnRpYWxzID0gdGhpcy5nZXRDcmVkZW50aWFsc0ZvclByb3ZpZGVyKHByb3ZpZGVyKTtcblx0XHRpZiAoY3JlZGVudGlhbHMubGVuZ3RoID09PSAwKSByZXR1cm4gZmFsc2U7XG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBjcmVkZW50aWFscy5sZW5ndGg7IGkrKykge1xuXHRcdFx0aWYgKCF0aGlzLmlzQ3JlZGVudGlhbEJhY2tlZE9mZihwcm92aWRlciwgaSkpIHJldHVybiBmYWxzZTtcblx0XHR9XG5cdFx0cmV0dXJuIHRydWU7XG5cdH1cblxuXHQvKipcblx0ICogTWFyayBhbiBlbnRpcmUgcHJvdmlkZXIgYXMgZXhoYXVzdGVkLlxuXHQgKiBDYWxsZWQgd2hlbiBhbGwgY3JlZGVudGlhbHMgZm9yIGEgcHJvdmlkZXIgYXJlIGJhY2tlZCBvZmYuXG5cdCAqL1xuXHRtYXJrUHJvdmlkZXJFeGhhdXN0ZWQocHJvdmlkZXI6IHN0cmluZywgZXJyb3JUeXBlOiBVc2FnZUxpbWl0RXJyb3JUeXBlKTogdm9pZCB7XG5cdFx0Y29uc3QgYmFja29mZk1zID0gZ2V0QmFja29mZkR1cmF0aW9uKGVycm9yVHlwZSk7XG5cdFx0dGhpcy5wcm92aWRlckJhY2tvZmYuc2V0KHByb3ZpZGVyLCBEYXRlLm5vdygpICsgYmFja29mZk1zKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDaGVjayBpZiBhIHByb3ZpZGVyIGlzIGN1cnJlbnRseSBhdmFpbGFibGUgKG5vdCBiYWNrZWQgb2ZmIGF0IHByb3ZpZGVyIGxldmVsKS5cblx0ICovXG5cdGlzUHJvdmlkZXJBdmFpbGFibGUocHJvdmlkZXI6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRcdGNvbnN0IGV4cGlyZXNBdCA9IHRoaXMucHJvdmlkZXJCYWNrb2ZmLmdldChwcm92aWRlcik7XG5cdFx0aWYgKGV4cGlyZXNBdCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdHJ1ZTtcblx0XHRpZiAoRGF0ZS5ub3coKSA+PSBleHBpcmVzQXQpIHtcblx0XHRcdHRoaXMucHJvdmlkZXJCYWNrb2ZmLmRlbGV0ZShwcm92aWRlcik7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9XG5cdFx0cmV0dXJuIGZhbHNlO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCBtaWxsaXNlY29uZHMgcmVtYWluaW5nIHVudGlsIHByb3ZpZGVyIGJhY2tvZmYgZXhwaXJlcy5cblx0ICogUmV0dXJucyAwIGlmIHByb3ZpZGVyIGlzIGF2YWlsYWJsZS5cblx0ICovXG5cdGdldFByb3ZpZGVyQmFja29mZlJlbWFpbmluZyhwcm92aWRlcjogc3RyaW5nKTogbnVtYmVyIHtcblx0XHRjb25zdCBleHBpcmVzQXQgPSB0aGlzLnByb3ZpZGVyQmFja29mZi5nZXQocHJvdmlkZXIpO1xuXHRcdGlmIChleHBpcmVzQXQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIDA7XG5cdFx0Y29uc3QgcmVtYWluaW5nID0gZXhwaXJlc0F0IC0gRGF0ZS5ub3coKTtcblx0XHRpZiAocmVtYWluaW5nIDw9IDApIHtcblx0XHRcdHRoaXMucHJvdmlkZXJCYWNrb2ZmLmRlbGV0ZShwcm92aWRlcik7XG5cdFx0XHRyZXR1cm4gMDtcblx0XHR9XG5cdFx0cmV0dXJuIHJlbWFpbmluZztcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgdGhlIGVhcmxpZXN0IHRpbWVzdGFtcCBhdCB3aGljaCBhbnkgY3JlZGVudGlhbCBmb3IgdGhpcyBwcm92aWRlclxuXHQgKiB3aWxsIGJlY29tZSBhdmFpbGFibGUgYWdhaW4uICBSZXR1cm5zIGB1bmRlZmluZWRgIHdoZW4gbm8gY3JlZGVudGlhbHNcblx0ICogYXJlIGJhY2tlZCBvZmYgKGkuZS4gYWxsIGFyZSBpbW1lZGlhdGVseSBhdmFpbGFibGUpLlxuXHQgKlxuXHQgKiBDYWxsZXJzIGNhbiB1c2UgdGhpcyB0byBzbGVlcCBleGFjdGx5IGxvbmcgZW5vdWdoIGZvciB0aGUgY29vbGRvd24gdG9cblx0ICogY2xlYXIgaW5zdGVhZCBvZiB1c2luZyBhIGZpeGVkIHJldHJ5IGRlbGF5IHRoYXQgbWF5IGJlIHNob3J0ZXIgdGhhbiB0aGVcblx0ICogYmFja29mZiB3aW5kb3cuXG5cdCAqL1xuXHRnZXRFYXJsaWVzdEJhY2tvZmZFeHBpcnkocHJvdmlkZXI6IHN0cmluZyk6IG51bWJlciB8IHVuZGVmaW5lZCB7XG5cdFx0Y29uc3QgcHJvdmlkZXJNYXAgPSB0aGlzLmNyZWRlbnRpYWxCYWNrb2ZmLmdldChwcm92aWRlcik7XG5cdFx0aWYgKCFwcm92aWRlck1hcCB8fCBwcm92aWRlck1hcC5zaXplID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xuXG5cdFx0Y29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcblx0XHRsZXQgZWFybGllc3Q6IG51bWJlciB8IHVuZGVmaW5lZDtcblxuXHRcdGZvciAoY29uc3QgW2luZGV4LCBleHBpcmVzQXRdIG9mIHByb3ZpZGVyTWFwKSB7XG5cdFx0XHRpZiAoZXhwaXJlc0F0IDw9IG5vdykge1xuXHRcdFx0XHQvLyBBbHJlYWR5IGV4cGlyZWQgXHUyMDE0IGNsZWFuIHVwXG5cdFx0XHRcdHByb3ZpZGVyTWFwLmRlbGV0ZShpbmRleCk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0aWYgKGVhcmxpZXN0ID09PSB1bmRlZmluZWQgfHwgZXhwaXJlc0F0IDwgZWFybGllc3QpIHtcblx0XHRcdFx0ZWFybGllc3QgPSBleHBpcmVzQXQ7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0cmV0dXJuIGVhcmxpZXN0O1xuXHR9XG5cblx0LyoqXG5cdCAqIENoZWNrIGlmIGEgY3JlZGVudGlhbCBpbmRleCBpcyBjdXJyZW50bHkgYmFja2VkIG9mZi5cblx0ICovXG5cdHByaXZhdGUgaXNDcmVkZW50aWFsQmFja2VkT2ZmKHByb3ZpZGVyOiBzdHJpbmcsIGluZGV4OiBudW1iZXIpOiBib29sZWFuIHtcblx0XHRjb25zdCBwcm92aWRlckJhY2tvZmYgPSB0aGlzLmNyZWRlbnRpYWxCYWNrb2ZmLmdldChwcm92aWRlcik7XG5cdFx0aWYgKCFwcm92aWRlckJhY2tvZmYpIHJldHVybiBmYWxzZTtcblx0XHRjb25zdCBleHBpcmVzQXQgPSBwcm92aWRlckJhY2tvZmYuZ2V0KGluZGV4KTtcblx0XHRpZiAoZXhwaXJlc0F0ID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxzZTtcblx0XHRpZiAoRGF0ZS5ub3coKSA+PSBleHBpcmVzQXQpIHtcblx0XHRcdHByb3ZpZGVyQmFja29mZi5kZWxldGUoaW5kZXgpO1xuXHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdH1cblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZWxlY3QgdGhlIGJlc3QgY3JlZGVudGlhbCBpbmRleCBmb3IgYSBwcm92aWRlci5cblx0ICogLSBJZiBzZXNzaW9uSWQgaXMgcHJvdmlkZWQsIHVzZXMgc2Vzc2lvbi1zdGlja3kgaGFzaGluZyBhcyB0aGUgc3RhcnRpbmcgcG9pbnQuXG5cdCAqIC0gT3RoZXJ3aXNlLCB1c2VzIHJvdW5kLXJvYmluIGFzIHRoZSBzdGFydGluZyBwb2ludC5cblx0ICogLSBTa2lwcyBjcmVkZW50aWFscyB0aGF0IGFyZSBjdXJyZW50bHkgYmFja2VkIG9mZi5cblx0ICogLSBSZXR1cm5zIC0xIGlmIGFsbCBjcmVkZW50aWFscyBhcmUgYmFja2VkIG9mZi5cblx0ICovXG5cdHByaXZhdGUgc2VsZWN0Q3JlZGVudGlhbEluZGV4KHByb3ZpZGVyOiBzdHJpbmcsIGNyZWRlbnRpYWxzOiBBdXRoQ3JlZGVudGlhbFtdLCBzZXNzaW9uSWQ/OiBzdHJpbmcpOiBudW1iZXIge1xuXHRcdGlmIChjcmVkZW50aWFscy5sZW5ndGggPT09IDApIHJldHVybiAtMTtcblx0XHRpZiAoY3JlZGVudGlhbHMubGVuZ3RoID09PSAxKSB7XG5cdFx0XHRyZXR1cm4gdGhpcy5pc0NyZWRlbnRpYWxCYWNrZWRPZmYocHJvdmlkZXIsIDApID8gLTEgOiAwO1xuXHRcdH1cblxuXHRcdGxldCBzdGFydEluZGV4OiBudW1iZXI7XG5cdFx0aWYgKHNlc3Npb25JZCkge1xuXHRcdFx0c3RhcnRJbmRleCA9IGhhc2hTdHJpbmcoc2Vzc2lvbklkKSAlIGNyZWRlbnRpYWxzLmxlbmd0aDtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc3QgY3VycmVudCA9IHRoaXMucHJvdmlkZXJSb3VuZFJvYmluSW5kZXguZ2V0KHByb3ZpZGVyKSA/PyAwO1xuXHRcdFx0c3RhcnRJbmRleCA9IGN1cnJlbnQgJSBjcmVkZW50aWFscy5sZW5ndGg7XG5cdFx0XHR0aGlzLnByb3ZpZGVyUm91bmRSb2JpbkluZGV4LnNldChwcm92aWRlciwgY3VycmVudCArIDEpO1xuXHRcdH1cblxuXHRcdC8vIFRyeSBzdGFydGluZyBmcm9tIHRoZSBwcmVmZXJyZWQgaW5kZXgsIHdyYXBwaW5nIGFyb3VuZFxuXHRcdGZvciAobGV0IG9mZnNldCA9IDA7IG9mZnNldCA8IGNyZWRlbnRpYWxzLmxlbmd0aDsgb2Zmc2V0KyspIHtcblx0XHRcdGNvbnN0IGluZGV4ID0gKHN0YXJ0SW5kZXggKyBvZmZzZXQpICUgY3JlZGVudGlhbHMubGVuZ3RoO1xuXHRcdFx0aWYgKCF0aGlzLmlzQ3JlZGVudGlhbEJhY2tlZE9mZihwcm92aWRlciwgaW5kZXgpKSB7XG5cdFx0XHRcdHJldHVybiBpbmRleDtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBBbGwgY3JlZGVudGlhbHMgYXJlIGJhY2tlZCBvZmZcblx0XHRyZXR1cm4gLTE7XG5cdH1cblxuXHQvKipcblx0ICogTWFyayBhIGNyZWRlbnRpYWwgYXMgcmF0ZS1saW1pdGVkLiBGaW5kcyB0aGUgY3JlZGVudGlhbCB0aGF0IHdhcyBtb3N0XG5cdCAqIHJlY2VudGx5IHVzZWQgZm9yIHRoaXMgcHJvdmlkZXIrc2Vzc2lvbiBhbmQgYmFja3MgaXQgb2ZmLlxuXHQgKlxuXHQgKiBAcmV0dXJucyB0cnVlIGlmIGFub3RoZXIgY3JlZGVudGlhbCBpcyBhdmFpbGFibGUgKGNhbGxlciBzaG91bGQgcmV0cnkpLFxuXHQgKiAgICAgICAgICBmYWxzZSBpZiBhbGwgY3JlZGVudGlhbHMgZm9yIHRoaXMgcHJvdmlkZXIgYXJlIGJhY2tlZCBvZmYuXG5cdCAqL1xuXHRtYXJrVXNhZ2VMaW1pdFJlYWNoZWQoXG5cdFx0cHJvdmlkZXI6IHN0cmluZyxcblx0XHRzZXNzaW9uSWQ/OiBzdHJpbmcsXG5cdFx0b3B0aW9ucz86IHsgZXJyb3JUeXBlPzogVXNhZ2VMaW1pdEVycm9yVHlwZSB9LFxuXHQpOiBib29sZWFuIHtcblx0XHRjb25zdCBjcmVkZW50aWFscyA9IHRoaXMuZ2V0Q3JlZGVudGlhbHNGb3JQcm92aWRlcihwcm92aWRlcik7XG5cdFx0aWYgKGNyZWRlbnRpYWxzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIGZhbHNlO1xuXG5cdFx0Y29uc3QgZXJyb3JUeXBlID0gb3B0aW9ucz8uZXJyb3JUeXBlID8/IFwicmF0ZV9saW1pdFwiO1xuXG5cdFx0Ly8gRm9yIHVua25vd24vdHJhbnNwb3J0IGVycm9ycyAoZS5nLiBjb25uZWN0aW9uIHJlc2V0LCBcInRlcm1pbmF0ZWRcIiksXG5cdFx0Ly8gZG9uJ3QgYmFjayBvZmYgdGhlIG9ubHkgY3JlZGVudGlhbCBcdTIwMTQgaXQgd291bGQgbWFrZSBnZXRBcGlLZXkoKSByZXR1cm5cblx0XHQvLyB1bmRlZmluZWQgYW5kIHN1cmZhY2UgYSBtaXNsZWFkaW5nIFwiQXV0aGVudGljYXRpb24gZmFpbGVkXCIgbWVzc2FnZS5cblx0XHRpZiAoZXJyb3JUeXBlID09PSBcInVua25vd25cIiAmJiBjcmVkZW50aWFscy5sZW5ndGggPT09IDEpIHtcblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9XG5cblx0XHRjb25zdCBiYWNrb2ZmTXMgPSBnZXRCYWNrb2ZmRHVyYXRpb24oZXJyb3JUeXBlKTtcblxuXHRcdC8vIERldGVybWluZSB3aGljaCBjcmVkZW50aWFsIHdhcyBqdXN0IHVzZWQgKHNhbWUgbG9naWMgYXMgc2VsZWN0Q3JlZGVudGlhbEluZGV4XG5cdFx0Ly8gYnV0IHdpdGhvdXQgaW5jcmVtZW50aW5nIHJvdW5kLXJvYmluKVxuXHRcdGxldCB1c2VkSW5kZXg6IG51bWJlcjtcblx0XHRpZiAoY3JlZGVudGlhbHMubGVuZ3RoID09PSAxKSB7XG5cdFx0XHR1c2VkSW5kZXggPSAwO1xuXHRcdH0gZWxzZSBpZiAoc2Vzc2lvbklkKSB7XG5cdFx0XHR1c2VkSW5kZXggPSBoYXNoU3RyaW5nKHNlc3Npb25JZCkgJSBjcmVkZW50aWFscy5sZW5ndGg7XG5cdFx0fSBlbHNlIHtcblx0XHRcdC8vIFJvdW5kLXJvYmluIHdhcyBhbHJlYWR5IGluY3JlbWVudGVkIGluIGdldEFwaUtleSwgc28gdGhlIGxhc3QtdXNlZFxuXHRcdFx0Ly8gaW5kZXggaXMgKGN1cnJlbnQgLSAxKS4gTm90ZTogaW4gYSBjb25jdXJyZW50IHNjZW5hcmlvIHdoZXJlIGFub3RoZXJcblx0XHRcdC8vIGdldEFwaUtleSBjYWxsIGZpcmVzIGJldHdlZW4gdGhlIG9yaWdpbmFsIHJlcXVlc3QgYW5kIHRoaXMgYmFja29mZiBjYWxsLFxuXHRcdFx0Ly8gd2UgbWF5IGJhY2sgb2ZmIHRoZSB3cm9uZyBjcmVkZW50aWFsIGluZGV4LiBUaGlzIGlzIGFjY2VwdGFibGUgYmVjYXVzZTpcblx0XHRcdC8vIChhKSBwaSBydW5zIHNpbmdsZS10aHJlYWRlZCBldmVudCBsb29wLCAoYikgYmFja2luZyBvZmYgdGhlIHdyb25nIGtleVxuXHRcdFx0Ly8gaXMgc2FmZSBcdTIwMTQgaXQgc2VsZi1oZWFscyB3aGVuIHRoZSBiYWNrb2ZmIGV4cGlyZXMuXG5cdFx0XHRjb25zdCBjdXJyZW50ID0gdGhpcy5wcm92aWRlclJvdW5kUm9iaW5JbmRleC5nZXQocHJvdmlkZXIpID8/IDA7XG5cdFx0XHR1c2VkSW5kZXggPSAoKGN1cnJlbnQgLSAxKSAlIGNyZWRlbnRpYWxzLmxlbmd0aCArIGNyZWRlbnRpYWxzLmxlbmd0aCkgJSBjcmVkZW50aWFscy5sZW5ndGg7XG5cdFx0fVxuXG5cdFx0Ly8gU2V0IGJhY2tvZmYgZm9yIHRoaXMgY3JlZGVudGlhbFxuXHRcdGxldCBwcm92aWRlckJhY2tvZmYgPSB0aGlzLmNyZWRlbnRpYWxCYWNrb2ZmLmdldChwcm92aWRlcik7XG5cdFx0aWYgKCFwcm92aWRlckJhY2tvZmYpIHtcblx0XHRcdHByb3ZpZGVyQmFja29mZiA9IG5ldyBNYXAoKTtcblx0XHRcdHRoaXMuY3JlZGVudGlhbEJhY2tvZmYuc2V0KHByb3ZpZGVyLCBwcm92aWRlckJhY2tvZmYpO1xuXHRcdH1cblx0XHRwcm92aWRlckJhY2tvZmYuc2V0KHVzZWRJbmRleCwgRGF0ZS5ub3coKSArIGJhY2tvZmZNcyk7XG5cblx0XHQvLyBDaGVjayBpZiBhbnkgY3JlZGVudGlhbCBpcyBzdGlsbCBhdmFpbGFibGVcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IGNyZWRlbnRpYWxzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRpZiAoIXRoaXMuaXNDcmVkZW50aWFsQmFja2VkT2ZmKHByb3ZpZGVyLCBpKSkge1xuXHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdH1cblx0XHR9XG5cdFx0cmV0dXJuIGZhbHNlO1xuXHR9XG5cblx0LyoqXG5cdCAqIFJlZnJlc2ggT0F1dGggdG9rZW4gd2l0aCBiYWNrZW5kIGxvY2tpbmcgdG8gcHJldmVudCByYWNlIGNvbmRpdGlvbnMuXG5cdCAqIE11bHRpcGxlIHBpIGluc3RhbmNlcyBtYXkgdHJ5IHRvIHJlZnJlc2ggc2ltdWx0YW5lb3VzbHkgd2hlbiB0b2tlbnMgZXhwaXJlLlxuXHQgKi9cblx0cHJpdmF0ZSBhc3luYyByZWZyZXNoT0F1dGhUb2tlbldpdGhMb2NrKFxuXHRcdHByb3ZpZGVySWQ6IE9BdXRoUHJvdmlkZXJJZCxcblx0KTogUHJvbWlzZTx7IGFwaUtleTogc3RyaW5nOyBuZXdDcmVkZW50aWFsczogT0F1dGhDcmVkZW50aWFscyB9IHwgbnVsbD4ge1xuXHRcdGNvbnN0IHByb3ZpZGVyID0gZ2V0T0F1dGhQcm92aWRlcihwcm92aWRlcklkKTtcblx0XHRpZiAoIXByb3ZpZGVyKSB7XG5cdFx0XHRyZXR1cm4gbnVsbDtcblx0XHR9XG5cblx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnN0b3JhZ2Uud2l0aExvY2tBc3luYyhhc3luYyAoY3VycmVudCkgPT4ge1xuXHRcdFx0Y29uc3QgY3VycmVudERhdGEgPSB0aGlzLnBhcnNlU3RvcmFnZURhdGEoY3VycmVudCk7XG5cdFx0XHR0aGlzLmRhdGEgPSBjdXJyZW50RGF0YTtcblx0XHRcdHRoaXMubG9hZEVycm9yID0gbnVsbDtcblxuXHRcdFx0Ly8gRmluZCB0aGUgT0F1dGggY3JlZGVudGlhbCBmb3IgdGhpcyBwcm92aWRlclxuXHRcdFx0Y29uc3QgY3JlZHMgPSB0aGlzLmdldENyZWRlbnRpYWxzRm9yUHJvdmlkZXIocHJvdmlkZXJJZCk7XG5cdFx0XHRjb25zdCBjcmVkID0gY3JlZHMuZmluZCgoYykgPT4gYy50eXBlID09PSBcIm9hdXRoXCIpO1xuXHRcdFx0aWYgKCFjcmVkIHx8IGNyZWQudHlwZSAhPT0gXCJvYXV0aFwiKSB7XG5cdFx0XHRcdHJldHVybiB7IHJlc3VsdDogbnVsbCB9O1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoRGF0ZS5ub3coKSA8IGNyZWQuZXhwaXJlcykge1xuXHRcdFx0XHRyZXR1cm4geyByZXN1bHQ6IHsgYXBpS2V5OiBwcm92aWRlci5nZXRBcGlLZXkoY3JlZCksIG5ld0NyZWRlbnRpYWxzOiBjcmVkIH0gfTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3Qgb2F1dGhDcmVkczogUmVjb3JkPHN0cmluZywgT0F1dGhDcmVkZW50aWFscz4gPSB7fTtcblx0XHRcdGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGN1cnJlbnREYXRhKSkge1xuXHRcdFx0XHRjb25zdCBmaXJzdCA9IEFycmF5LmlzQXJyYXkodmFsdWUpID8gdmFsdWUuZmluZCgoYykgPT4gYy50eXBlID09PSBcIm9hdXRoXCIpIDogdmFsdWU7XG5cdFx0XHRcdGlmIChmaXJzdD8udHlwZSA9PT0gXCJvYXV0aFwiKSB7XG5cdFx0XHRcdFx0b2F1dGhDcmVkc1trZXldID0gZmlyc3Q7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgcmVmcmVzaGVkID0gYXdhaXQgZ2V0T0F1dGhBcGlLZXkocHJvdmlkZXJJZCwgb2F1dGhDcmVkcyk7XG5cdFx0XHRpZiAoIXJlZnJlc2hlZCkge1xuXHRcdFx0XHRyZXR1cm4geyByZXN1bHQ6IG51bGwgfTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gVXBkYXRlIHRoZSBPQXV0aCBjcmVkZW50aWFsIGluLXBsYWNlIHdpdGhpbiB0aGUgYXJyYXlcblx0XHRcdGNvbnN0IGV4aXN0aW5nRW50cnkgPSBjdXJyZW50RGF0YVtwcm92aWRlcklkXTtcblx0XHRcdGNvbnN0IG5ld09BdXRoQ3JlZDogT0F1dGhDcmVkZW50aWFsID0geyB0eXBlOiBcIm9hdXRoXCIsIC4uLnJlZnJlc2hlZC5uZXdDcmVkZW50aWFscyB9O1xuXHRcdFx0bGV0IHVwZGF0ZWRFbnRyeTogQXV0aENyZWRlbnRpYWwgfCBBdXRoQ3JlZGVudGlhbFtdO1xuXG5cdFx0XHRpZiAoQXJyYXkuaXNBcnJheShleGlzdGluZ0VudHJ5KSkge1xuXHRcdFx0XHR1cGRhdGVkRW50cnkgPSBleGlzdGluZ0VudHJ5Lm1hcCgoYykgPT4gKGMudHlwZSA9PT0gXCJvYXV0aFwiID8gbmV3T0F1dGhDcmVkIDogYykpO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0dXBkYXRlZEVudHJ5ID0gbmV3T0F1dGhDcmVkO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBtZXJnZWQ6IEF1dGhTdG9yYWdlRGF0YSA9IHtcblx0XHRcdFx0Li4uY3VycmVudERhdGEsXG5cdFx0XHRcdFtwcm92aWRlcklkXTogdXBkYXRlZEVudHJ5LFxuXHRcdFx0fTtcblx0XHRcdHRoaXMuZGF0YSA9IG1lcmdlZDtcblx0XHRcdHRoaXMubG9hZEVycm9yID0gbnVsbDtcblx0XHRcdHJldHVybiB7IHJlc3VsdDogcmVmcmVzaGVkLCBuZXh0OiBKU09OLnN0cmluZ2lmeShtZXJnZWQsIG51bGwsIDIpIH07XG5cdFx0fSk7XG5cblx0XHQvLyBOb3RpZnkgbGlzdGVuZXJzIGFmdGVyIGNyZWRlbnRpYWwgY2hhbmdlIChlLmcuLCBtb2RlbCByZWdpc3RyeSByZWZyZXNoKVxuXHRcdGlmIChyZXN1bHQpIHtcblx0XHRcdHF1ZXVlTWljcm90YXNrKCgpID0+IHRoaXMubm90aWZ5Q3JlZGVudGlhbENoYW5nZSgpKTtcblx0XHR9XG5cblx0XHRyZXR1cm4gcmVzdWx0O1xuXHR9XG5cblx0LyoqXG5cdCAqIFJlc29sdmUgYW4gQVBJIGtleSBmcm9tIGEgc2luZ2xlIGNyZWRlbnRpYWwuXG5cdCAqL1xuXHRwcml2YXRlIGFzeW5jIHJlc29sdmVDcmVkZW50aWFsQXBpS2V5KFxuXHRcdHByb3ZpZGVySWQ6IHN0cmluZyxcblx0XHRjcmVkOiBBdXRoQ3JlZGVudGlhbCxcblx0KTogUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+IHtcblx0XHRpZiAoY3JlZC50eXBlID09PSBcImFwaV9rZXlcIikge1xuXHRcdFx0cmV0dXJuIHJlc29sdmVDb25maWdWYWx1ZShjcmVkLmtleSk7XG5cdFx0fVxuXG5cdFx0aWYgKGNyZWQudHlwZSA9PT0gXCJvYXV0aFwiKSB7XG5cdFx0XHRjb25zdCBwcm92aWRlciA9IGdldE9BdXRoUHJvdmlkZXIocHJvdmlkZXJJZCk7XG5cdFx0XHRpZiAoIXByb3ZpZGVyKSByZXR1cm4gdW5kZWZpbmVkO1xuXG5cdFx0XHRjb25zdCBuZWVkc1JlZnJlc2ggPSBEYXRlLm5vdygpID49IGNyZWQuZXhwaXJlcztcblx0XHRcdGlmIChuZWVkc1JlZnJlc2gpIHtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnJlZnJlc2hPQXV0aFRva2VuV2l0aExvY2socHJvdmlkZXJJZCk7XG5cdFx0XHRcdFx0aWYgKHJlc3VsdCkgcmV0dXJuIHJlc3VsdC5hcGlLZXk7XG5cdFx0XHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRcdFx0dGhpcy5yZWNvcmRFcnJvcihlcnJvcik7XG5cdFx0XHRcdFx0dGhpcy5yZWxvYWQoKTtcblx0XHRcdFx0XHRjb25zdCB1cGRhdGVkQ3JlZHMgPSB0aGlzLmdldENyZWRlbnRpYWxzRm9yUHJvdmlkZXIocHJvdmlkZXJJZCk7XG5cdFx0XHRcdFx0Y29uc3QgdXBkYXRlZE9BdXRoID0gdXBkYXRlZENyZWRzLmZpbmQoKGMpID0+IGMudHlwZSA9PT0gXCJvYXV0aFwiKTtcblx0XHRcdFx0XHRpZiAodXBkYXRlZE9BdXRoPy50eXBlID09PSBcIm9hdXRoXCIgJiYgRGF0ZS5ub3coKSA8IHVwZGF0ZWRPQXV0aC5leHBpcmVzKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4gcHJvdmlkZXIuZ2V0QXBpS2V5KHVwZGF0ZWRPQXV0aCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdFx0XHRcdH1cblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHJldHVybiBwcm92aWRlci5nZXRBcGlLZXkoY3JlZCk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgQVBJIGtleSBmb3IgYSBwcm92aWRlci5cblx0ICogUHJpb3JpdHk6XG5cdCAqIDEuIFJ1bnRpbWUgb3ZlcnJpZGUgKENMSSAtLWFwaS1rZXkpXG5cdCAqIDIuIENyZWRlbnRpYWwocykgZnJvbSBhdXRoLmpzb24gKHdpdGggcm91bmQtcm9iaW4gLyBzZXNzaW9uLXN0aWNreSBzZWxlY3Rpb24pXG5cdCAqIDMuIEVudmlyb25tZW50IHZhcmlhYmxlXG5cdCAqIDQuIEZhbGxiYWNrIHJlc29sdmVyIChtb2RlbHMuanNvbiBjdXN0b20gcHJvdmlkZXJzKVxuXHQgKlxuXHQgKiBAcGFyYW0gcHJvdmlkZXJJZCAtIFRoZSBwcm92aWRlciB0byBnZXQgYW4gQVBJIGtleSBmb3Jcblx0ICogQHBhcmFtIHNlc3Npb25JZCAtIE9wdGlvbmFsIHNlc3Npb24gSUQgZm9yIHN0aWNreSBjcmVkZW50aWFsIHNlbGVjdGlvblxuXHQgKi9cblx0YXN5bmMgZ2V0QXBpS2V5KHByb3ZpZGVySWQ6IHN0cmluZywgc2Vzc2lvbklkPzogc3RyaW5nLCBvcHRpb25zPzogeyBiYXNlVXJsPzogc3RyaW5nIH0pOiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4ge1xuXHRcdC8vIElmIHRoZSBtb2RlbCBoYXMgYSBsb2NhbCBiYXNlVXJsLCByZXR1cm4gYSBkdW1teSBrZXkgdG8gYXZvaWQgYXV0aCBibG9ja2luZ1xuXHRcdGlmIChvcHRpb25zPy5iYXNlVXJsICYmICF0aGlzLmZhbGxiYWNrUmVzb2x2ZXI/Lihwcm92aWRlcklkKSkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgaG9zdG5hbWUgPSBuZXcgVVJMKG9wdGlvbnMuYmFzZVVybCkuaG9zdG5hbWU7XG5cdFx0XHRcdGlmIChob3N0bmFtZSA9PT0gXCJsb2NhbGhvc3RcIiB8fCBob3N0bmFtZSA9PT0gXCIxMjcuMC4wLjFcIiB8fCBob3N0bmFtZSA9PT0gXCIwLjAuMC4wXCIgfHwgaG9zdG5hbWUgPT09IFwiOjoxXCIpIHtcblx0XHRcdFx0XHRyZXR1cm4gXCJsb2NhbC1uby1rZXktbmVlZGVkXCI7XG5cdFx0XHRcdH1cblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRpZiAob3B0aW9ucy5iYXNlVXJsLnN0YXJ0c1dpdGgoXCJ1bml4OlwiKSkge1xuXHRcdFx0XHRcdHJldHVybiBcImxvY2FsLW5vLWtleS1uZWVkZWRcIjtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIFJ1bnRpbWUgb3ZlcnJpZGUgdGFrZXMgaGlnaGVzdCBwcmlvcml0eVxuXHRcdGNvbnN0IHJ1bnRpbWVLZXkgPSB0aGlzLnJ1bnRpbWVPdmVycmlkZXMuZ2V0KHByb3ZpZGVySWQpO1xuXHRcdGlmIChydW50aW1lS2V5KSB7XG5cdFx0XHQvLyBCbG9jayBHb29nbGUgT0F1dGggdG9rZW5zIHVzZWQgYXMgcnVudGltZSBBUEkga2V5IG92ZXJyaWRlc1xuXHRcdFx0aWYgKEdPT0dMRV9BUElfS0VZX1BST1ZJREVSUy5oYXMocHJvdmlkZXJJZCkgJiYgaXNHb29nbGVPQXV0aFRva2VuKHJ1bnRpbWVLZXkpKSB7XG5cdFx0XHRcdHRoaXMucmVjb3JkRXJyb3IoXG5cdFx0XHRcdFx0bmV3IEVycm9yKFxuXHRcdFx0XHRcdFx0YEJsb2NrZWQgR29vZ2xlIE9BdXRoIGFjY2VzcyB0b2tlbiAoeWEyOS4qKSBmb3IgcHJvdmlkZXIgXCIke3Byb3ZpZGVySWR9XCIuIGAgK1xuXHRcdFx0XHRcdFx0XHRgVXNlIGFuIEFQSSBrZXkgZnJvbSBodHRwczovL2Fpc3R1ZGlvLmdvb2dsZS5jb20vYXBpa2V5IG9yICcvbG9naW4gZ29vZ2xlLWdlbWluaS1jbGknLmAsXG5cdFx0XHRcdFx0KSxcblx0XHRcdFx0KTtcblx0XHRcdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0XHRcdH1cblx0XHRcdHJldHVybiBydW50aW1lS2V5O1xuXHRcdH1cblxuXHRcdGNvbnN0IGNyZWRlbnRpYWxzID0gdGhpcy5nZXRDcmVkZW50aWFsc0ZvclByb3ZpZGVyKHByb3ZpZGVySWQpO1xuXG5cdFx0aWYgKGNyZWRlbnRpYWxzLmxlbmd0aCA+IDApIHtcblx0XHRcdGNvbnN0IGluZGV4ID0gdGhpcy5zZWxlY3RDcmVkZW50aWFsSW5kZXgocHJvdmlkZXJJZCwgY3JlZGVudGlhbHMsIHNlc3Npb25JZCk7XG5cdFx0XHRpZiAoaW5kZXggPj0gMCkge1xuXHRcdFx0XHRjb25zdCByZXNvbHZlZCA9IGF3YWl0IHRoaXMucmVzb2x2ZUNyZWRlbnRpYWxBcGlLZXkocHJvdmlkZXJJZCwgY3JlZGVudGlhbHNbaW5kZXhdKTtcblx0XHRcdFx0aWYgKHJlc29sdmVkKSByZXR1cm4gcmVzb2x2ZWQ7XG5cdFx0XHRcdC8vIENyZWRlbnRpYWwgdW5yZXNvbHZhYmxlIChlLmcuIHR5cGU6XCJvYXV0aFwiIGZvciBhIG5vbi1PQXV0aCBwcm92aWRlcikgXHUyMDE0XG5cdFx0XHRcdC8vIGZhbGwgdGhyb3VnaCB0byBlbnYgLyBmYWxsYmFjayBpbnN0ZWFkIG9mIHJldHVybmluZyB1bmRlZmluZWQgKCMyMDgzKVxuXHRcdFx0fVxuXHRcdFx0Ly8gQWxsIGNyZWRlbnRpYWxzIGJhY2tlZCBvZmYgb3IgdW5yZXNvbHZhYmxlIC0gZmFsbCB0aHJvdWdoIHRvIGVudi9mYWxsYmFja1xuXHRcdH1cblxuXHRcdC8vIEZhbGwgYmFjayB0byBlbnZpcm9ubWVudCB2YXJpYWJsZVxuXHRcdGNvbnN0IGVudktleSA9IGdldEVudkFwaUtleShwcm92aWRlcklkKTtcblx0XHRpZiAoZW52S2V5KSB7XG5cdFx0XHQvLyBCbG9jayBHb29nbGUgT0F1dGggdG9rZW5zIGZyb20gZW52aXJvbm1lbnQgdmFyaWFibGVzIChlLmcuLCBHRU1JTklfQVBJX0tFWT15YTI5LiopXG5cdFx0XHRpZiAoR09PR0xFX0FQSV9LRVlfUFJPVklERVJTLmhhcyhwcm92aWRlcklkKSAmJiBpc0dvb2dsZU9BdXRoVG9rZW4oZW52S2V5KSkge1xuXHRcdFx0XHR0aGlzLnJlY29yZEVycm9yKFxuXHRcdFx0XHRcdG5ldyBFcnJvcihcblx0XHRcdFx0XHRcdGBHRU1JTklfQVBJX0tFWSBjb250YWlucyBhIEdvb2dsZSBPQXV0aCBhY2Nlc3MgdG9rZW4gKHlhMjkuKiksIG5vdCBhbiBBUEkga2V5LiBgICtcblx0XHRcdFx0XHRcdFx0YEdldCBhbiBBUEkga2V5IGZyb20gaHR0cHM6Ly9haXN0dWRpby5nb29nbGUuY29tL2FwaWtleSBvciB1c2UgJy9sb2dpbiBnb29nbGUtZ2VtaW5pLWNsaScuYCxcblx0XHRcdFx0XHQpLFxuXHRcdFx0XHQpO1xuXHRcdFx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIGVudktleTtcblx0XHR9XG5cblx0XHQvLyBGYWxsIGJhY2sgdG8gY3VzdG9tIHJlc29sdmVyIChlLmcuLCBtb2RlbHMuanNvbiBjdXN0b20gcHJvdmlkZXJzKVxuXHRcdHJldHVybiB0aGlzLmZhbGxiYWNrUmVzb2x2ZXI/Lihwcm92aWRlcklkKSA/PyB1bmRlZmluZWQ7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IGFsbCByZWdpc3RlcmVkIE9BdXRoIHByb3ZpZGVyc1xuXHQgKi9cblx0Z2V0T0F1dGhQcm92aWRlcnMoKSB7XG5cdFx0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
