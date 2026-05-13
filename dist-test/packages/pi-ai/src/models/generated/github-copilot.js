const GITHUB_COPILOT_MODELS = {
  "claude-haiku-4.5": {
    id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    api: "anthropic-messages",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 144e3,
    maxTokens: 32e3
  },
  "claude-opus-4.5": {
    id: "claude-opus-4.5",
    name: "Claude Opus 4.5",
    api: "anthropic-messages",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 16e4,
    maxTokens: 32e3
  },
  "claude-opus-4.6": {
    id: "claude-opus-4.6",
    name: "Claude Opus 4.6",
    api: "anthropic-messages",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 144e3,
    maxTokens: 64e3
  },
  "claude-sonnet-4": {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    api: "anthropic-messages",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 216e3,
    maxTokens: 16e3
  },
  "claude-sonnet-4.5": {
    id: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    api: "anthropic-messages",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 144e3,
    maxTokens: 32e3
  },
  "claude-sonnet-4.6": {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 32e3
  },
  "gemini-2.5-pro": {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    api: "openai-completions",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    compat: { "supportsStore": false, "supportsDeveloperRole": false, "supportsReasoningEffort": false },
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 64e3
  },
  "gemini-3-flash-preview": {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash",
    api: "openai-completions",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    compat: { "supportsStore": false, "supportsDeveloperRole": false, "supportsReasoningEffort": false },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 64e3
  },
  "gemini-3-pro-preview": {
    id: "gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    api: "openai-completions",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    compat: { "supportsStore": false, "supportsDeveloperRole": false, "supportsReasoningEffort": false },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 64e3
  },
  "gemini-3.1-pro-preview": {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    api: "openai-completions",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    compat: { "supportsStore": false, "supportsDeveloperRole": false, "supportsReasoningEffort": false },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 64e3
  },
  "gpt-4.1": {
    id: "gpt-4.1",
    name: "GPT-4.1",
    api: "openai-completions",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    compat: { "supportsStore": false, "supportsDeveloperRole": false, "supportsReasoningEffort": false },
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  "gpt-4o": {
    id: "gpt-4o",
    name: "GPT-4o",
    api: "openai-completions",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    compat: { "supportsStore": false, "supportsDeveloperRole": false, "supportsReasoningEffort": false },
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "gpt-5": {
    id: "gpt-5",
    name: "GPT-5",
    api: "openai-responses",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 128e3
  },
  "gpt-5-mini": {
    id: "gpt-5-mini",
    name: "GPT-5-mini",
    api: "openai-responses",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 264e3,
    maxTokens: 64e3
  },
  "gpt-5.1": {
    id: "gpt-5.1",
    name: "GPT-5.1",
    api: "openai-responses",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 264e3,
    maxTokens: 64e3
  },
  "gpt-5.1-codex": {
    id: "gpt-5.1-codex",
    name: "GPT-5.1-Codex",
    api: "openai-responses",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.1-codex-max": {
    id: "gpt-5.1-codex-max",
    name: "GPT-5.1-Codex-max",
    api: "openai-responses",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.1-codex-mini": {
    id: "gpt-5.1-codex-mini",
    name: "GPT-5.1-Codex-mini",
    api: "openai-responses",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.2": {
    id: "gpt-5.2",
    name: "GPT-5.2",
    api: "openai-responses",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 264e3,
    maxTokens: 64e3
  },
  "gpt-5.2-codex": {
    id: "gpt-5.2-codex",
    name: "GPT-5.2-Codex",
    api: "openai-responses",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.3-codex": {
    id: "gpt-5.3-codex",
    name: "GPT-5.3-Codex",
    api: "openai-responses",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.4": {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-responses",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.4-mini": {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    api: "openai-responses",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "grok-code-fast-1": {
    id: "grok-code-fast-1",
    name: "Grok Code Fast 1",
    api: "openai-completions",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: { "User-Agent": "GitHubCopilotChat/0.35.0", "Editor-Version": "vscode/1.107.0", "Editor-Plugin-Version": "copilot-chat/0.35.0", "Copilot-Integration-Id": "vscode-chat" },
    compat: { "supportsStore": false, "supportsDeveloperRole": false, "supportsReasoningEffort": false },
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 64e3
  }
};
export {
  GITHUB_COPILOT_MODELS
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL21vZGVscy9nZW5lcmF0ZWQvZ2l0aHViLWNvcGlsb3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFRoaXMgZmlsZSBpcyBhdXRvLWdlbmVyYXRlZCBieSBzY3JpcHRzL2dlbmVyYXRlLW1vZGVscy50c1xuLy8gRG8gbm90IGVkaXQgbWFudWFsbHkgLSBydW4gJ25wbSBydW4gZ2VuZXJhdGUtbW9kZWxzJyB0byB1cGRhdGVcblxuaW1wb3J0IHR5cGUgeyBNb2RlbCB9IGZyb20gXCIuLi8uLi90eXBlcy5qc1wiO1xuXG5leHBvcnQgY29uc3QgR0lUSFVCX0NPUElMT1RfTU9ERUxTID0ge1xuXHRcdFwiY2xhdWRlLWhhaWt1LTQuNVwiOiB7XG5cdFx0XHRpZDogXCJjbGF1ZGUtaGFpa3UtNC41XCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBIYWlrdSA0LjVcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcImdpdGh1Yi1jb3BpbG90XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLmluZGl2aWR1YWwuZ2l0aHViY29waWxvdC5jb21cIixcblx0XHRcdGhlYWRlcnM6IHtcIlVzZXItQWdlbnRcIjpcIkdpdEh1YkNvcGlsb3RDaGF0LzAuMzUuMFwiLFwiRWRpdG9yLVZlcnNpb25cIjpcInZzY29kZS8xLjEwNy4wXCIsXCJFZGl0b3ItUGx1Z2luLVZlcnNpb25cIjpcImNvcGlsb3QtY2hhdC8wLjM1LjBcIixcIkNvcGlsb3QtSW50ZWdyYXRpb24tSWRcIjpcInZzY29kZS1jaGF0XCJ9LFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDE0NDAwMCxcblx0XHRcdG1heFRva2VuczogMzIwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJjbGF1ZGUtb3B1cy00LjVcIjoge1xuXHRcdFx0aWQ6IFwiY2xhdWRlLW9wdXMtNC41XCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBPcHVzIDQuNVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ2l0aHViLWNvcGlsb3RcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkuaW5kaXZpZHVhbC5naXRodWJjb3BpbG90LmNvbVwiLFxuXHRcdFx0aGVhZGVyczoge1wiVXNlci1BZ2VudFwiOlwiR2l0SHViQ29waWxvdENoYXQvMC4zNS4wXCIsXCJFZGl0b3ItVmVyc2lvblwiOlwidnNjb2RlLzEuMTA3LjBcIixcIkVkaXRvci1QbHVnaW4tVmVyc2lvblwiOlwiY29waWxvdC1jaGF0LzAuMzUuMFwiLFwiQ29waWxvdC1JbnRlZ3JhdGlvbi1JZFwiOlwidnNjb2RlLWNoYXRcIn0sXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTYwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImNsYXVkZS1vcHVzLTQuNlwiOiB7XG5cdFx0XHRpZDogXCJjbGF1ZGUtb3B1cy00LjZcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIE9wdXMgNC42XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnaXRodWItY29waWxvdFwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5pbmRpdmlkdWFsLmdpdGh1YmNvcGlsb3QuY29tXCIsXG5cdFx0XHRoZWFkZXJzOiB7XCJVc2VyLUFnZW50XCI6XCJHaXRIdWJDb3BpbG90Q2hhdC8wLjM1LjBcIixcIkVkaXRvci1WZXJzaW9uXCI6XCJ2c2NvZGUvMS4xMDcuMFwiLFwiRWRpdG9yLVBsdWdpbi1WZXJzaW9uXCI6XCJjb3BpbG90LWNoYXQvMC4zNS4wXCIsXCJDb3BpbG90LUludGVncmF0aW9uLUlkXCI6XCJ2c2NvZGUtY2hhdFwifSxcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxNDQwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiY2xhdWRlLXNvbm5ldC00XCI6IHtcblx0XHRcdGlkOiBcImNsYXVkZS1zb25uZXQtNFwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgU29ubmV0IDRcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcImdpdGh1Yi1jb3BpbG90XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLmluZGl2aWR1YWwuZ2l0aHViY29waWxvdC5jb21cIixcblx0XHRcdGhlYWRlcnM6IHtcIlVzZXItQWdlbnRcIjpcIkdpdEh1YkNvcGlsb3RDaGF0LzAuMzUuMFwiLFwiRWRpdG9yLVZlcnNpb25cIjpcInZzY29kZS8xLjEwNy4wXCIsXCJFZGl0b3ItUGx1Z2luLVZlcnNpb25cIjpcImNvcGlsb3QtY2hhdC8wLjM1LjBcIixcIkNvcGlsb3QtSW50ZWdyYXRpb24tSWRcIjpcInZzY29kZS1jaGF0XCJ9LFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIxNjAwMCxcblx0XHRcdG1heFRva2VuczogMTYwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJjbGF1ZGUtc29ubmV0LTQuNVwiOiB7XG5cdFx0XHRpZDogXCJjbGF1ZGUtc29ubmV0LTQuNVwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgU29ubmV0IDQuNVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ2l0aHViLWNvcGlsb3RcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkuaW5kaXZpZHVhbC5naXRodWJjb3BpbG90LmNvbVwiLFxuXHRcdFx0aGVhZGVyczoge1wiVXNlci1BZ2VudFwiOlwiR2l0SHViQ29waWxvdENoYXQvMC4zNS4wXCIsXCJFZGl0b3ItVmVyc2lvblwiOlwidnNjb2RlLzEuMTA3LjBcIixcIkVkaXRvci1QbHVnaW4tVmVyc2lvblwiOlwiY29waWxvdC1jaGF0LzAuMzUuMFwiLFwiQ29waWxvdC1JbnRlZ3JhdGlvbi1JZFwiOlwidnNjb2RlLWNoYXRcIn0sXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTQ0MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImNsYXVkZS1zb25uZXQtNC42XCI6IHtcblx0XHRcdGlkOiBcImNsYXVkZS1zb25uZXQtNC42XCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBTb25uZXQgNC42XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnaXRodWItY29waWxvdFwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5pbmRpdmlkdWFsLmdpdGh1YmNvcGlsb3QuY29tXCIsXG5cdFx0XHRoZWFkZXJzOiB7XCJVc2VyLUFnZW50XCI6XCJHaXRIdWJDb3BpbG90Q2hhdC8wLjM1LjBcIixcIkVkaXRvci1WZXJzaW9uXCI6XCJ2c2NvZGUvMS4xMDcuMFwiLFwiRWRpdG9yLVBsdWdpbi1WZXJzaW9uXCI6XCJjb3BpbG90LWNoYXQvMC4zNS4wXCIsXCJDb3BpbG90LUludGVncmF0aW9uLUlkXCI6XCJ2c2NvZGUtY2hhdFwifSxcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDMyMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiZ2VtaW5pLTIuNS1wcm9cIjoge1xuXHRcdFx0aWQ6IFwiZ2VtaW5pLTIuNS1wcm9cIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIDIuNSBQcm9cIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcImdpdGh1Yi1jb3BpbG90XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLmluZGl2aWR1YWwuZ2l0aHViY29waWxvdC5jb21cIixcblx0XHRcdGhlYWRlcnM6IHtcIlVzZXItQWdlbnRcIjpcIkdpdEh1YkNvcGlsb3RDaGF0LzAuMzUuMFwiLFwiRWRpdG9yLVZlcnNpb25cIjpcInZzY29kZS8xLjEwNy4wXCIsXCJFZGl0b3ItUGx1Z2luLVZlcnNpb25cIjpcImNvcGlsb3QtY2hhdC8wLjM1LjBcIixcIkNvcGlsb3QtSW50ZWdyYXRpb24tSWRcIjpcInZzY29kZS1jaGF0XCJ9LFxuXHRcdFx0Y29tcGF0OiB7XCJzdXBwb3J0c1N0b3JlXCI6ZmFsc2UsXCJzdXBwb3J0c0RldmVsb3BlclJvbGVcIjpmYWxzZSxcInN1cHBvcnRzUmVhc29uaW5nRWZmb3J0XCI6ZmFsc2V9LFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiZ2VtaW5pLTMtZmxhc2gtcHJldmlld1wiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMy1mbGFzaC1wcmV2aWV3XCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAzIEZsYXNoXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnaXRodWItY29waWxvdFwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5pbmRpdmlkdWFsLmdpdGh1YmNvcGlsb3QuY29tXCIsXG5cdFx0XHRoZWFkZXJzOiB7XCJVc2VyLUFnZW50XCI6XCJHaXRIdWJDb3BpbG90Q2hhdC8wLjM1LjBcIixcIkVkaXRvci1WZXJzaW9uXCI6XCJ2c2NvZGUvMS4xMDcuMFwiLFwiRWRpdG9yLVBsdWdpbi1WZXJzaW9uXCI6XCJjb3BpbG90LWNoYXQvMC4zNS4wXCIsXCJDb3BpbG90LUludGVncmF0aW9uLUlkXCI6XCJ2c2NvZGUtY2hhdFwifSxcblx0XHRcdGNvbXBhdDoge1wic3VwcG9ydHNTdG9yZVwiOmZhbHNlLFwic3VwcG9ydHNEZXZlbG9wZXJSb2xlXCI6ZmFsc2UsXCJzdXBwb3J0c1JlYXNvbmluZ0VmZm9ydFwiOmZhbHNlfSxcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiZ2VtaW5pLTMtcHJvLXByZXZpZXdcIjoge1xuXHRcdFx0aWQ6IFwiZ2VtaW5pLTMtcHJvLXByZXZpZXdcIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIDMgUHJvIFByZXZpZXdcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcImdpdGh1Yi1jb3BpbG90XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLmluZGl2aWR1YWwuZ2l0aHViY29waWxvdC5jb21cIixcblx0XHRcdGhlYWRlcnM6IHtcIlVzZXItQWdlbnRcIjpcIkdpdEh1YkNvcGlsb3RDaGF0LzAuMzUuMFwiLFwiRWRpdG9yLVZlcnNpb25cIjpcInZzY29kZS8xLjEwNy4wXCIsXCJFZGl0b3ItUGx1Z2luLVZlcnNpb25cIjpcImNvcGlsb3QtY2hhdC8wLjM1LjBcIixcIkNvcGlsb3QtSW50ZWdyYXRpb24tSWRcIjpcInZzY29kZS1jaGF0XCJ9LFxuXHRcdFx0Y29tcGF0OiB7XCJzdXBwb3J0c1N0b3JlXCI6ZmFsc2UsXCJzdXBwb3J0c0RldmVsb3BlclJvbGVcIjpmYWxzZSxcInN1cHBvcnRzUmVhc29uaW5nRWZmb3J0XCI6ZmFsc2V9LFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJnZW1pbmktMy4xLXByby1wcmV2aWV3XCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS0zLjEtcHJvLXByZXZpZXdcIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIDMuMSBQcm8gUHJldmlld1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ2l0aHViLWNvcGlsb3RcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkuaW5kaXZpZHVhbC5naXRodWJjb3BpbG90LmNvbVwiLFxuXHRcdFx0aGVhZGVyczoge1wiVXNlci1BZ2VudFwiOlwiR2l0SHViQ29waWxvdENoYXQvMC4zNS4wXCIsXCJFZGl0b3ItVmVyc2lvblwiOlwidnNjb2RlLzEuMTA3LjBcIixcIkVkaXRvci1QbHVnaW4tVmVyc2lvblwiOlwiY29waWxvdC1jaGF0LzAuMzUuMFwiLFwiQ29waWxvdC1JbnRlZ3JhdGlvbi1JZFwiOlwidnNjb2RlLWNoYXRcIn0sXG5cdFx0XHRjb21wYXQ6IHtcInN1cHBvcnRzU3RvcmVcIjpmYWxzZSxcInN1cHBvcnRzRGV2ZWxvcGVyUm9sZVwiOmZhbHNlLFwic3VwcG9ydHNSZWFzb25pbmdFZmZvcnRcIjpmYWxzZX0sXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImdwdC00LjFcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTQuMVwiLFxuXHRcdFx0bmFtZTogXCJHUFQtNC4xXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnaXRodWItY29waWxvdFwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5pbmRpdmlkdWFsLmdpdGh1YmNvcGlsb3QuY29tXCIsXG5cdFx0XHRoZWFkZXJzOiB7XCJVc2VyLUFnZW50XCI6XCJHaXRIdWJDb3BpbG90Q2hhdC8wLjM1LjBcIixcIkVkaXRvci1WZXJzaW9uXCI6XCJ2c2NvZGUvMS4xMDcuMFwiLFwiRWRpdG9yLVBsdWdpbi1WZXJzaW9uXCI6XCJjb3BpbG90LWNoYXQvMC4zNS4wXCIsXCJDb3BpbG90LUludGVncmF0aW9uLUlkXCI6XCJ2c2NvZGUtY2hhdFwifSxcblx0XHRcdGNvbXBhdDoge1wic3VwcG9ydHNTdG9yZVwiOmZhbHNlLFwic3VwcG9ydHNEZXZlbG9wZXJSb2xlXCI6ZmFsc2UsXCJzdXBwb3J0c1JlYXNvbmluZ0VmZm9ydFwiOmZhbHNlfSxcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxNjM4NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImdwdC00b1wiOiB7XG5cdFx0XHRpZDogXCJncHQtNG9cIixcblx0XHRcdG5hbWU6IFwiR1BULTRvXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnaXRodWItY29waWxvdFwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5pbmRpdmlkdWFsLmdpdGh1YmNvcGlsb3QuY29tXCIsXG5cdFx0XHRoZWFkZXJzOiB7XCJVc2VyLUFnZW50XCI6XCJHaXRIdWJDb3BpbG90Q2hhdC8wLjM1LjBcIixcIkVkaXRvci1WZXJzaW9uXCI6XCJ2c2NvZGUvMS4xMDcuMFwiLFwiRWRpdG9yLVBsdWdpbi1WZXJzaW9uXCI6XCJjb3BpbG90LWNoYXQvMC4zNS4wXCIsXCJDb3BpbG90LUludGVncmF0aW9uLUlkXCI6XCJ2c2NvZGUtY2hhdFwifSxcblx0XHRcdGNvbXBhdDoge1wic3VwcG9ydHNTdG9yZVwiOmZhbHNlLFwic3VwcG9ydHNEZXZlbG9wZXJSb2xlXCI6ZmFsc2UsXCJzdXBwb3J0c1JlYXNvbmluZ0VmZm9ydFwiOmZhbHNlfSxcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiZ3B0LTVcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTVcIixcblx0XHRcdG5hbWU6IFwiR1BULTVcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnaXRodWItY29waWxvdFwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5pbmRpdmlkdWFsLmdpdGh1YmNvcGlsb3QuY29tXCIsXG5cdFx0XHRoZWFkZXJzOiB7XCJVc2VyLUFnZW50XCI6XCJHaXRIdWJDb3BpbG90Q2hhdC8wLjM1LjBcIixcIkVkaXRvci1WZXJzaW9uXCI6XCJ2c2NvZGUvMS4xMDcuMFwiLFwiRWRpdG9yLVBsdWdpbi1WZXJzaW9uXCI6XCJjb3BpbG90LWNoYXQvMC4zNS4wXCIsXCJDb3BpbG90LUludGVncmF0aW9uLUlkXCI6XCJ2c2NvZGUtY2hhdFwifSxcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS1taW5pXCI6IHtcblx0XHRcdGlkOiBcImdwdC01LW1pbmlcIixcblx0XHRcdG5hbWU6IFwiR1BULTUtbWluaVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcImdpdGh1Yi1jb3BpbG90XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLmluZGl2aWR1YWwuZ2l0aHViY29waWxvdC5jb21cIixcblx0XHRcdGhlYWRlcnM6IHtcIlVzZXItQWdlbnRcIjpcIkdpdEh1YkNvcGlsb3RDaGF0LzAuMzUuMFwiLFwiRWRpdG9yLVZlcnNpb25cIjpcInZzY29kZS8xLjEwNy4wXCIsXCJFZGl0b3ItUGx1Z2luLVZlcnNpb25cIjpcImNvcGlsb3QtY2hhdC8wLjM1LjBcIixcIkNvcGlsb3QtSW50ZWdyYXRpb24tSWRcIjpcInZzY29kZS1jaGF0XCJ9LFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2NDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwiZ3B0LTUuMVwiOiB7XG5cdFx0XHRpZDogXCJncHQtNS4xXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LjFcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnaXRodWItY29waWxvdFwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5pbmRpdmlkdWFsLmdpdGh1YmNvcGlsb3QuY29tXCIsXG5cdFx0XHRoZWFkZXJzOiB7XCJVc2VyLUFnZW50XCI6XCJHaXRIdWJDb3BpbG90Q2hhdC8wLjM1LjBcIixcIkVkaXRvci1WZXJzaW9uXCI6XCJ2c2NvZGUvMS4xMDcuMFwiLFwiRWRpdG9yLVBsdWdpbi1WZXJzaW9uXCI6XCJjb3BpbG90LWNoYXQvMC4zNS4wXCIsXCJDb3BpbG90LUludGVncmF0aW9uLUlkXCI6XCJ2c2NvZGUtY2hhdFwifSxcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjQwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LjEtY29kZXhcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUuMS1jb2RleFwiLFxuXHRcdFx0bmFtZTogXCJHUFQtNS4xLUNvZGV4XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ2l0aHViLWNvcGlsb3RcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkuaW5kaXZpZHVhbC5naXRodWJjb3BpbG90LmNvbVwiLFxuXHRcdFx0aGVhZGVyczoge1wiVXNlci1BZ2VudFwiOlwiR2l0SHViQ29waWxvdENoYXQvMC4zNS4wXCIsXCJFZGl0b3ItVmVyc2lvblwiOlwidnNjb2RlLzEuMTA3LjBcIixcIkVkaXRvci1QbHVnaW4tVmVyc2lvblwiOlwiY29waWxvdC1jaGF0LzAuMzUuMFwiLFwiQ29waWxvdC1JbnRlZ3JhdGlvbi1JZFwiOlwidnNjb2RlLWNoYXRcIn0sXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwiZ3B0LTUuMS1jb2RleC1tYXhcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUuMS1jb2RleC1tYXhcIixcblx0XHRcdG5hbWU6IFwiR1BULTUuMS1Db2RleC1tYXhcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnaXRodWItY29waWxvdFwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5pbmRpdmlkdWFsLmdpdGh1YmNvcGlsb3QuY29tXCIsXG5cdFx0XHRoZWFkZXJzOiB7XCJVc2VyLUFnZW50XCI6XCJHaXRIdWJDb3BpbG90Q2hhdC8wLjM1LjBcIixcIkVkaXRvci1WZXJzaW9uXCI6XCJ2c2NvZGUvMS4xMDcuMFwiLFwiRWRpdG9yLVBsdWdpbi1WZXJzaW9uXCI6XCJjb3BpbG90LWNoYXQvMC4zNS4wXCIsXCJDb3BpbG90LUludGVncmF0aW9uLUlkXCI6XCJ2c2NvZGUtY2hhdFwifSxcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS4xLWNvZGV4LW1pbmlcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUuMS1jb2RleC1taW5pXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LjEtQ29kZXgtbWluaVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcImdpdGh1Yi1jb3BpbG90XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLmluZGl2aWR1YWwuZ2l0aHViY29waWxvdC5jb21cIixcblx0XHRcdGhlYWRlcnM6IHtcIlVzZXItQWdlbnRcIjpcIkdpdEh1YkNvcGlsb3RDaGF0LzAuMzUuMFwiLFwiRWRpdG9yLVZlcnNpb25cIjpcInZzY29kZS8xLjEwNy4wXCIsXCJFZGl0b3ItUGx1Z2luLVZlcnNpb25cIjpcImNvcGlsb3QtY2hhdC8wLjM1LjBcIixcIkNvcGlsb3QtSW50ZWdyYXRpb24tSWRcIjpcInZzY29kZS1jaGF0XCJ9LFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LjJcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUuMlwiLFxuXHRcdFx0bmFtZTogXCJHUFQtNS4yXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ2l0aHViLWNvcGlsb3RcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkuaW5kaXZpZHVhbC5naXRodWJjb3BpbG90LmNvbVwiLFxuXHRcdFx0aGVhZGVyczoge1wiVXNlci1BZ2VudFwiOlwiR2l0SHViQ29waWxvdENoYXQvMC4zNS4wXCIsXCJFZGl0b3ItVmVyc2lvblwiOlwidnNjb2RlLzEuMTA3LjBcIixcIkVkaXRvci1QbHVnaW4tVmVyc2lvblwiOlwiY29waWxvdC1jaGF0LzAuMzUuMFwiLFwiQ29waWxvdC1JbnRlZ3JhdGlvbi1JZFwiOlwidnNjb2RlLWNoYXRcIn0sXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjY0MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS4yLWNvZGV4XCI6IHtcblx0XHRcdGlkOiBcImdwdC01LjItY29kZXhcIixcblx0XHRcdG5hbWU6IFwiR1BULTUuMi1Db2RleFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcImdpdGh1Yi1jb3BpbG90XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLmluZGl2aWR1YWwuZ2l0aHViY29waWxvdC5jb21cIixcblx0XHRcdGhlYWRlcnM6IHtcIlVzZXItQWdlbnRcIjpcIkdpdEh1YkNvcGlsb3RDaGF0LzAuMzUuMFwiLFwiRWRpdG9yLVZlcnNpb25cIjpcInZzY29kZS8xLjEwNy4wXCIsXCJFZGl0b3ItUGx1Z2luLVZlcnNpb25cIjpcImNvcGlsb3QtY2hhdC8wLjM1LjBcIixcIkNvcGlsb3QtSW50ZWdyYXRpb24tSWRcIjpcInZzY29kZS1jaGF0XCJ9LFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LjMtY29kZXhcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUuMy1jb2RleFwiLFxuXHRcdFx0bmFtZTogXCJHUFQtNS4zLUNvZGV4XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ2l0aHViLWNvcGlsb3RcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkuaW5kaXZpZHVhbC5naXRodWJjb3BpbG90LmNvbVwiLFxuXHRcdFx0aGVhZGVyczoge1wiVXNlci1BZ2VudFwiOlwiR2l0SHViQ29waWxvdENoYXQvMC4zNS4wXCIsXCJFZGl0b3ItVmVyc2lvblwiOlwidnNjb2RlLzEuMTA3LjBcIixcIkVkaXRvci1QbHVnaW4tVmVyc2lvblwiOlwiY29waWxvdC1jaGF0LzAuMzUuMFwiLFwiQ29waWxvdC1JbnRlZ3JhdGlvbi1JZFwiOlwidnNjb2RlLWNoYXRcIn0sXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwiZ3B0LTUuNFwiOiB7XG5cdFx0XHRpZDogXCJncHQtNS40XCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LjRcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnaXRodWItY29waWxvdFwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5pbmRpdmlkdWFsLmdpdGh1YmNvcGlsb3QuY29tXCIsXG5cdFx0XHRoZWFkZXJzOiB7XCJVc2VyLUFnZW50XCI6XCJHaXRIdWJDb3BpbG90Q2hhdC8wLjM1LjBcIixcIkVkaXRvci1WZXJzaW9uXCI6XCJ2c2NvZGUvMS4xMDcuMFwiLFwiRWRpdG9yLVBsdWdpbi1WZXJzaW9uXCI6XCJjb3BpbG90LWNoYXQvMC4zNS4wXCIsXCJDb3BpbG90LUludGVncmF0aW9uLUlkXCI6XCJ2c2NvZGUtY2hhdFwifSxcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS40LW1pbmlcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUuNC1taW5pXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LjQgTWluaVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcImdpdGh1Yi1jb3BpbG90XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLmluZGl2aWR1YWwuZ2l0aHViY29waWxvdC5jb21cIixcblx0XHRcdGhlYWRlcnM6IHtcIlVzZXItQWdlbnRcIjpcIkdpdEh1YkNvcGlsb3RDaGF0LzAuMzUuMFwiLFwiRWRpdG9yLVZlcnNpb25cIjpcInZzY29kZS8xLjEwNy4wXCIsXCJFZGl0b3ItUGx1Z2luLVZlcnNpb25cIjpcImNvcGlsb3QtY2hhdC8wLjM1LjBcIixcIkNvcGlsb3QtSW50ZWdyYXRpb24tSWRcIjpcInZzY29kZS1jaGF0XCJ9LFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdyb2stY29kZS1mYXN0LTFcIjoge1xuXHRcdFx0aWQ6IFwiZ3Jvay1jb2RlLWZhc3QtMVwiLFxuXHRcdFx0bmFtZTogXCJHcm9rIENvZGUgRmFzdCAxXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnaXRodWItY29waWxvdFwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5pbmRpdmlkdWFsLmdpdGh1YmNvcGlsb3QuY29tXCIsXG5cdFx0XHRoZWFkZXJzOiB7XCJVc2VyLUFnZW50XCI6XCJHaXRIdWJDb3BpbG90Q2hhdC8wLjM1LjBcIixcIkVkaXRvci1WZXJzaW9uXCI6XCJ2c2NvZGUvMS4xMDcuMFwiLFwiRWRpdG9yLVBsdWdpbi1WZXJzaW9uXCI6XCJjb3BpbG90LWNoYXQvMC4zNS4wXCIsXCJDb3BpbG90LUludGVncmF0aW9uLUlkXCI6XCJ2c2NvZGUtY2hhdFwifSxcblx0XHRcdGNvbXBhdDoge1wic3VwcG9ydHNTdG9yZVwiOmZhbHNlLFwic3VwcG9ydHNEZXZlbG9wZXJSb2xlXCI6ZmFsc2UsXCJzdXBwb3J0c1JlYXNvbmluZ0VmZm9ydFwiOmZhbHNlfSxcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0fSBhcyBjb25zdCBzYXRpc2ZpZXMgUmVjb3JkPHN0cmluZywgTW9kZWw8YW55Pj47XG4iXSwKICAibWFwcGluZ3MiOiAiQUFLTyxNQUFNLHdCQUF3QjtBQUFBLEVBQ25DLG9CQUFvQjtBQUFBLElBQ25CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFNBQVMsRUFBQyxjQUFhLDRCQUEyQixrQkFBaUIsa0JBQWlCLHlCQUF3Qix1QkFBc0IsMEJBQXlCLGNBQWE7QUFBQSxJQUN4SyxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxtQkFBbUI7QUFBQSxJQUNsQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxTQUFTLEVBQUMsY0FBYSw0QkFBMkIsa0JBQWlCLGtCQUFpQix5QkFBd0IsdUJBQXNCLDBCQUF5QixjQUFhO0FBQUEsSUFDeEssV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsbUJBQW1CO0FBQUEsSUFDbEIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsU0FBUyxFQUFDLGNBQWEsNEJBQTJCLGtCQUFpQixrQkFBaUIseUJBQXdCLHVCQUFzQiwwQkFBeUIsY0FBYTtBQUFBLElBQ3hLLFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLG1CQUFtQjtBQUFBLElBQ2xCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFNBQVMsRUFBQyxjQUFhLDRCQUEyQixrQkFBaUIsa0JBQWlCLHlCQUF3Qix1QkFBc0IsMEJBQXlCLGNBQWE7QUFBQSxJQUN4SyxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxxQkFBcUI7QUFBQSxJQUNwQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxTQUFTLEVBQUMsY0FBYSw0QkFBMkIsa0JBQWlCLGtCQUFpQix5QkFBd0IsdUJBQXNCLDBCQUF5QixjQUFhO0FBQUEsSUFDeEssV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EscUJBQXFCO0FBQUEsSUFDcEIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsU0FBUyxFQUFDLGNBQWEsNEJBQTJCLGtCQUFpQixrQkFBaUIseUJBQXdCLHVCQUFzQiwwQkFBeUIsY0FBYTtBQUFBLElBQ3hLLFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGtCQUFrQjtBQUFBLElBQ2pCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFNBQVMsRUFBQyxjQUFhLDRCQUEyQixrQkFBaUIsa0JBQWlCLHlCQUF3Qix1QkFBc0IsMEJBQXlCLGNBQWE7QUFBQSxJQUN4SyxRQUFRLEVBQUMsaUJBQWdCLE9BQU0seUJBQXdCLE9BQU0sMkJBQTBCLE1BQUs7QUFBQSxJQUM1RixXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSwwQkFBMEI7QUFBQSxJQUN6QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxTQUFTLEVBQUMsY0FBYSw0QkFBMkIsa0JBQWlCLGtCQUFpQix5QkFBd0IsdUJBQXNCLDBCQUF5QixjQUFhO0FBQUEsSUFDeEssUUFBUSxFQUFDLGlCQUFnQixPQUFNLHlCQUF3QixPQUFNLDJCQUEwQixNQUFLO0FBQUEsSUFDNUYsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0Esd0JBQXdCO0FBQUEsSUFDdkIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsU0FBUyxFQUFDLGNBQWEsNEJBQTJCLGtCQUFpQixrQkFBaUIseUJBQXdCLHVCQUFzQiwwQkFBeUIsY0FBYTtBQUFBLElBQ3hLLFFBQVEsRUFBQyxpQkFBZ0IsT0FBTSx5QkFBd0IsT0FBTSwyQkFBMEIsTUFBSztBQUFBLElBQzVGLFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDBCQUEwQjtBQUFBLElBQ3pCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFNBQVMsRUFBQyxjQUFhLDRCQUEyQixrQkFBaUIsa0JBQWlCLHlCQUF3Qix1QkFBc0IsMEJBQXlCLGNBQWE7QUFBQSxJQUN4SyxRQUFRLEVBQUMsaUJBQWdCLE9BQU0seUJBQXdCLE9BQU0sMkJBQTBCLE1BQUs7QUFBQSxJQUM1RixXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxXQUFXO0FBQUEsSUFDVixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxTQUFTLEVBQUMsY0FBYSw0QkFBMkIsa0JBQWlCLGtCQUFpQix5QkFBd0IsdUJBQXNCLDBCQUF5QixjQUFhO0FBQUEsSUFDeEssUUFBUSxFQUFDLGlCQUFnQixPQUFNLHlCQUF3QixPQUFNLDJCQUEwQixNQUFLO0FBQUEsSUFDNUYsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsVUFBVTtBQUFBLElBQ1QsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsU0FBUyxFQUFDLGNBQWEsNEJBQTJCLGtCQUFpQixrQkFBaUIseUJBQXdCLHVCQUFzQiwwQkFBeUIsY0FBYTtBQUFBLElBQ3hLLFFBQVEsRUFBQyxpQkFBZ0IsT0FBTSx5QkFBd0IsT0FBTSwyQkFBMEIsTUFBSztBQUFBLElBQzVGLFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLFNBQVM7QUFBQSxJQUNSLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFNBQVMsRUFBQyxjQUFhLDRCQUEyQixrQkFBaUIsa0JBQWlCLHlCQUF3Qix1QkFBc0IsMEJBQXlCLGNBQWE7QUFBQSxJQUN4SyxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxjQUFjO0FBQUEsSUFDYixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxTQUFTLEVBQUMsY0FBYSw0QkFBMkIsa0JBQWlCLGtCQUFpQix5QkFBd0IsdUJBQXNCLDBCQUF5QixjQUFhO0FBQUEsSUFDeEssV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsV0FBVztBQUFBLElBQ1YsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsU0FBUyxFQUFDLGNBQWEsNEJBQTJCLGtCQUFpQixrQkFBaUIseUJBQXdCLHVCQUFzQiwwQkFBeUIsY0FBYTtBQUFBLElBQ3hLLFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGlCQUFpQjtBQUFBLElBQ2hCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFNBQVMsRUFBQyxjQUFhLDRCQUEyQixrQkFBaUIsa0JBQWlCLHlCQUF3Qix1QkFBc0IsMEJBQXlCLGNBQWE7QUFBQSxJQUN4SyxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxxQkFBcUI7QUFBQSxJQUNwQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxTQUFTLEVBQUMsY0FBYSw0QkFBMkIsa0JBQWlCLGtCQUFpQix5QkFBd0IsdUJBQXNCLDBCQUF5QixjQUFhO0FBQUEsSUFDeEssV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0Esc0JBQXNCO0FBQUEsSUFDckIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsU0FBUyxFQUFDLGNBQWEsNEJBQTJCLGtCQUFpQixrQkFBaUIseUJBQXdCLHVCQUFzQiwwQkFBeUIsY0FBYTtBQUFBLElBQ3hLLFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLFdBQVc7QUFBQSxJQUNWLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFNBQVMsRUFBQyxjQUFhLDRCQUEyQixrQkFBaUIsa0JBQWlCLHlCQUF3Qix1QkFBc0IsMEJBQXlCLGNBQWE7QUFBQSxJQUN4SyxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxpQkFBaUI7QUFBQSxJQUNoQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxTQUFTLEVBQUMsY0FBYSw0QkFBMkIsa0JBQWlCLGtCQUFpQix5QkFBd0IsdUJBQXNCLDBCQUF5QixjQUFhO0FBQUEsSUFDeEssV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsaUJBQWlCO0FBQUEsSUFDaEIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsU0FBUyxFQUFDLGNBQWEsNEJBQTJCLGtCQUFpQixrQkFBaUIseUJBQXdCLHVCQUFzQiwwQkFBeUIsY0FBYTtBQUFBLElBQ3hLLFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLFdBQVc7QUFBQSxJQUNWLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFNBQVMsRUFBQyxjQUFhLDRCQUEyQixrQkFBaUIsa0JBQWlCLHlCQUF3Qix1QkFBc0IsMEJBQXlCLGNBQWE7QUFBQSxJQUN4SyxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxnQkFBZ0I7QUFBQSxJQUNmLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFNBQVMsRUFBQyxjQUFhLDRCQUEyQixrQkFBaUIsa0JBQWlCLHlCQUF3Qix1QkFBc0IsMEJBQXlCLGNBQWE7QUFBQSxJQUN4SyxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxvQkFBb0I7QUFBQSxJQUNuQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxTQUFTLEVBQUMsY0FBYSw0QkFBMkIsa0JBQWlCLGtCQUFpQix5QkFBd0IsdUJBQXNCLDBCQUF5QixjQUFhO0FBQUEsSUFDeEssUUFBUSxFQUFDLGlCQUFnQixPQUFNLHlCQUF3QixPQUFNLDJCQUEwQixNQUFLO0FBQUEsSUFDNUYsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLE1BQU07QUFBQSxJQUNkLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUNEOyIsCiAgIm5hbWVzIjogW10KfQo=
