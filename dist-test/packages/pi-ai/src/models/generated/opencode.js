const OPENCODE_MODELS = {
  "big-pickle": {
    id: "big-pickle",
    name: "Big Pickle",
    api: "anthropic-messages",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 128e3
  },
  "claude-3-5-haiku": {
    id: "claude-3-5-haiku",
    name: "Claude Haiku 3.5",
    api: "anthropic-messages",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.8,
      output: 4,
      cacheRead: 0.08,
      cacheWrite: 1
    },
    contextWindow: 2e5,
    maxTokens: 8192
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    api: "anthropic-messages",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25
    },
    contextWindow: 2e5,
    maxTokens: 64e3
  },
  "claude-opus-4-1": {
    id: "claude-opus-4-1",
    name: "Claude Opus 4.1",
    api: "anthropic-messages",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 15,
      output: 75,
      cacheRead: 1.5,
      cacheWrite: 18.75
    },
    contextWindow: 2e5,
    maxTokens: 32e3
  },
  "claude-opus-4-5": {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    api: "anthropic-messages",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25
    },
    contextWindow: 2e5,
    maxTokens: 64e3
  },
  "claude-opus-4-6": {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    api: "anthropic-messages",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25
    },
    contextWindow: 1e6,
    maxTokens: 128e3
  },
  "claude-sonnet-4": {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    api: "anthropic-messages",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75
    },
    contextWindow: 2e5,
    maxTokens: 64e3
  },
  "claude-sonnet-4-5": {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    api: "anthropic-messages",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75
    },
    contextWindow: 2e5,
    maxTokens: 64e3
  },
  "claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75
    },
    contextWindow: 1e6,
    maxTokens: 64e3
  },
  "gemini-3-flash": {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    api: "google-generative-ai",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.5,
      output: 3,
      cacheRead: 0.05,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-3.1-pro": {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro Preview",
    api: "google-generative-ai",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 12,
      cacheRead: 0.2,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "glm-5": {
    id: "glm-5",
    name: "GLM-5",
    api: "openai-completions",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1,
      output: 3.2,
      cacheRead: 0.2,
      cacheWrite: 0
    },
    contextWindow: 204800,
    maxTokens: 131072
  },
  "glm-5.1": {
    id: "glm-5.1",
    name: "GLM-5.1",
    api: "openai-completions",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1.4,
      output: 4.4,
      cacheRead: 0.26,
      cacheWrite: 0
    },
    contextWindow: 204800,
    maxTokens: 131072
  },
  "gpt-5": {
    id: "gpt-5",
    name: "GPT-5",
    api: "openai-responses",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.07,
      output: 8.5,
      cacheRead: 0.107,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5-codex": {
    id: "gpt-5-codex",
    name: "GPT-5 Codex",
    api: "openai-responses",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.07,
      output: 8.5,
      cacheRead: 0.107,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5-nano": {
    id: "gpt-5-nano",
    name: "GPT-5 Nano",
    api: "openai-responses",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
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
  "gpt-5.1": {
    id: "gpt-5.1",
    name: "GPT-5.1",
    api: "openai-responses",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.07,
      output: 8.5,
      cacheRead: 0.107,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.1-codex": {
    id: "gpt-5.1-codex",
    name: "GPT-5.1 Codex",
    api: "openai-responses",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.07,
      output: 8.5,
      cacheRead: 0.107,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.1-codex-max": {
    id: "gpt-5.1-codex-max",
    name: "GPT-5.1 Codex Max",
    api: "openai-responses",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.1-codex-mini": {
    id: "gpt-5.1-codex-mini",
    name: "GPT-5.1 Codex Mini",
    api: "openai-responses",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.25,
      output: 2,
      cacheRead: 0.025,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.2": {
    id: "gpt-5.2",
    name: "GPT-5.2",
    api: "openai-responses",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.75,
      output: 14,
      cacheRead: 0.175,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.2-codex": {
    id: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    api: "openai-responses",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.75,
      output: 14,
      cacheRead: 0.175,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.3-codex": {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    api: "openai-responses",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.75,
      output: 14,
      cacheRead: 0.175,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.4": {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-responses",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 0
    },
    contextWindow: 272e3,
    maxTokens: 128e3
  },
  "gpt-5.4-mini": {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    api: "openai-responses",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.75,
      output: 4.5,
      cacheRead: 0.075,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.4-nano": {
    id: "gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    api: "openai-responses",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.2,
      output: 1.25,
      cacheRead: 0.02,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.4-pro": {
    id: "gpt-5.4-pro",
    name: "GPT-5.4 Pro",
    api: "openai-responses",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 30,
      output: 180,
      cacheRead: 30,
      cacheWrite: 0
    },
    contextWindow: 105e4,
    maxTokens: 128e3
  },
  "kimi-k2.5": {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    api: "openai-completions",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.6,
      output: 3,
      cacheRead: 0.08,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 65536
  },
  "minimax-m2.5": {
    id: "minimax-m2.5",
    name: "MiniMax M2.5",
    api: "openai-completions",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.06,
      cacheWrite: 0
    },
    contextWindow: 204800,
    maxTokens: 131072
  },
  "minimax-m2.5-free": {
    id: "minimax-m2.5-free",
    name: "MiniMax M2.5 Free",
    api: "anthropic-messages",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 204800,
    maxTokens: 131072
  },
  "nemotron-3-super-free": {
    id: "nemotron-3-super-free",
    name: "Nemotron 3 Super Free",
    api: "openai-completions",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 204800,
    maxTokens: 128e3
  }
};
export {
  OPENCODE_MODELS
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL21vZGVscy9nZW5lcmF0ZWQvb3BlbmNvZGUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFRoaXMgZmlsZSBpcyBhdXRvLWdlbmVyYXRlZCBieSBzY3JpcHRzL2dlbmVyYXRlLW1vZGVscy50c1xuLy8gRG8gbm90IGVkaXQgbWFudWFsbHkgLSBydW4gJ25wbSBydW4gZ2VuZXJhdGUtbW9kZWxzJyB0byB1cGRhdGVcblxuaW1wb3J0IHR5cGUgeyBNb2RlbCB9IGZyb20gXCIuLi8uLi90eXBlcy5qc1wiO1xuXG5leHBvcnQgY29uc3QgT1BFTkNPREVfTU9ERUxTID0ge1xuXHRcdFwiYmlnLXBpY2tsZVwiOiB7XG5cdFx0XHRpZDogXCJiaWctcGlja2xlXCIsXG5cdFx0XHRuYW1lOiBcIkJpZyBQaWNrbGVcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5jb2RlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbmNvZGUuYWkvemVuXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiY2xhdWRlLTMtNS1oYWlrdVwiOiB7XG5cdFx0XHRpZDogXCJjbGF1ZGUtMy01LWhhaWt1XCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBIYWlrdSAzLjVcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5jb2RlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbmNvZGUuYWkvemVuXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuOCxcblx0XHRcdFx0b3V0cHV0OiA0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDEsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiY2xhdWRlLWhhaWt1LTQtNVwiOiB7XG5cdFx0XHRpZDogXCJjbGF1ZGUtaGFpa3UtNC01XCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBIYWlrdSA0LjVcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5jb2RlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbmNvZGUuYWkvemVuXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMSxcblx0XHRcdFx0b3V0cHV0OiA1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMS4yNSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiY2xhdWRlLW9wdXMtNC0xXCI6IHtcblx0XHRcdGlkOiBcImNsYXVkZS1vcHVzLTQtMVwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgT3B1cyA0LjFcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5jb2RlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbmNvZGUuYWkvemVuXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMTUsXG5cdFx0XHRcdG91dHB1dDogNzUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMS41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAxOC43NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDMyMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiY2xhdWRlLW9wdXMtNC01XCI6IHtcblx0XHRcdGlkOiBcImNsYXVkZS1vcHVzLTQtNVwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgT3B1cyA0LjVcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5jb2RlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbmNvZGUuYWkvemVuXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogNSxcblx0XHRcdFx0b3V0cHV0OiAyNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDYuMjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImNsYXVkZS1vcHVzLTQtNlwiOiB7XG5cdFx0XHRpZDogXCJjbGF1ZGUtb3B1cy00LTZcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIE9wdXMgNC42XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuY29kZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5jb2RlLmFpL3plblwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDUsXG5cdFx0XHRcdG91dHB1dDogMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiA2LjI1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImNsYXVkZS1zb25uZXQtNFwiOiB7XG5cdFx0XHRpZDogXCJjbGF1ZGUtc29ubmV0LTRcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIFNvbm5ldCA0XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuY29kZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5jb2RlLmFpL3plblwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDMsXG5cdFx0XHRcdG91dHB1dDogMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4zLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAzLjc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJjbGF1ZGUtc29ubmV0LTQtNVwiOiB7XG5cdFx0XHRpZDogXCJjbGF1ZGUtc29ubmV0LTQtNVwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgU29ubmV0IDQuNVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmNvZGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVuY29kZS5haS96ZW5cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAzLFxuXHRcdFx0XHRvdXRwdXQ6IDE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMy43NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiY2xhdWRlLXNvbm5ldC00LTZcIjoge1xuXHRcdFx0aWQ6IFwiY2xhdWRlLXNvbm5ldC00LTZcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIFNvbm5ldCA0LjZcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5jb2RlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbmNvZGUuYWkvemVuXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMyxcblx0XHRcdFx0b3V0cHV0OiAxNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDMuNzUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJnZW1pbmktMy1mbGFzaFwiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMy1mbGFzaFwiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMyBGbGFzaFwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuY29kZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5jb2RlLmFpL3plbi92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNSxcblx0XHRcdFx0b3V0cHV0OiAzLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiPixcblx0XHRcImdlbWluaS0zLjEtcHJvXCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS0zLjEtcHJvXCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAzLjEgUHJvIFByZXZpZXdcIixcblx0XHRcdGFwaTogXCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmNvZGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVuY29kZS5haS96ZW4vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLFxuXHRcdFx0XHRvdXRwdXQ6IDEyLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCI+LFxuXHRcdFwiZ2xtLTVcIjoge1xuXHRcdFx0aWQ6IFwiZ2xtLTVcIixcblx0XHRcdG5hbWU6IFwiR0xNLTVcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5jb2RlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbmNvZGUuYWkvemVuL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEsXG5cdFx0XHRcdG91dHB1dDogMy4yLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDQ4MDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTA3Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImdsbS01LjFcIjoge1xuXHRcdFx0aWQ6IFwiZ2xtLTUuMVwiLFxuXHRcdFx0bmFtZTogXCJHTE0tNS4xXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuY29kZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5jb2RlLmFpL3plbi92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjQsXG5cdFx0XHRcdG91dHB1dDogNC40LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMjYsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjA0ODAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMzEwNzIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJncHQtNVwiOiB7XG5cdFx0XHRpZDogXCJncHQtNVwiLFxuXHRcdFx0bmFtZTogXCJHUFQtNVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5jb2RlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbmNvZGUuYWkvemVuL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4wNyxcblx0XHRcdFx0b3V0cHV0OiA4LjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMDcsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwiZ3B0LTUtY29kZXhcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUtY29kZXhcIixcblx0XHRcdG5hbWU6IFwiR1BULTUgQ29kZXhcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuY29kZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5jb2RlLmFpL3plbi92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMDcsXG5cdFx0XHRcdG91dHB1dDogOC41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTA3LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LW5hbm9cIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUtbmFub1wiLFxuXHRcdFx0bmFtZTogXCJHUFQtNSBOYW5vXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmNvZGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVuY29kZS5haS96ZW4vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS4xXCI6IHtcblx0XHRcdGlkOiBcImdwdC01LjFcIixcblx0XHRcdG5hbWU6IFwiR1BULTUuMVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5jb2RlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbmNvZGUuYWkvemVuL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4wNyxcblx0XHRcdFx0b3V0cHV0OiA4LjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMDcsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwiZ3B0LTUuMS1jb2RleFwiOiB7XG5cdFx0XHRpZDogXCJncHQtNS4xLWNvZGV4XCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LjEgQ29kZXhcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuY29kZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5jb2RlLmFpL3plbi92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMDcsXG5cdFx0XHRcdG91dHB1dDogOC41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTA3LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LjEtY29kZXgtbWF4XCI6IHtcblx0XHRcdGlkOiBcImdwdC01LjEtY29kZXgtbWF4XCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LjEgQ29kZXggTWF4XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmNvZGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVuY29kZS5haS96ZW4vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDEwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTI1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LjEtY29kZXgtbWluaVwiOiB7XG5cdFx0XHRpZDogXCJncHQtNS4xLWNvZGV4LW1pbmlcIixcblx0XHRcdG5hbWU6IFwiR1BULTUuMSBDb2RleCBNaW5pXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmNvZGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVuY29kZS5haS96ZW4vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwiZ3B0LTUuMlwiOiB7XG5cdFx0XHRpZDogXCJncHQtNS4yXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LjJcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuY29kZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5jb2RlLmFpL3plbi92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuNzUsXG5cdFx0XHRcdG91dHB1dDogMTQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwiZ3B0LTUuMi1jb2RleFwiOiB7XG5cdFx0XHRpZDogXCJncHQtNS4yLWNvZGV4XCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LjIgQ29kZXhcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuY29kZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5jb2RlLmFpL3plbi92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuNzUsXG5cdFx0XHRcdG91dHB1dDogMTQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwiZ3B0LTUuMy1jb2RleFwiOiB7XG5cdFx0XHRpZDogXCJncHQtNS4zLWNvZGV4XCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LjMgQ29kZXhcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuY29kZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5jb2RlLmFpL3plbi92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuNzUsXG5cdFx0XHRcdG91dHB1dDogMTQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwiZ3B0LTUuNFwiOiB7XG5cdFx0XHRpZDogXCJncHQtNS40XCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LjRcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuY29kZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5jb2RlLmFpL3plbi92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIuNSxcblx0XHRcdFx0b3V0cHV0OiAxNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjI1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI3MjAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LjQtbWluaVwiOiB7XG5cdFx0XHRpZDogXCJncHQtNS40LW1pbmlcIixcblx0XHRcdG5hbWU6IFwiR1BULTUuNCBNaW5pXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmNvZGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVuY29kZS5haS96ZW4vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjc1LFxuXHRcdFx0XHRvdXRwdXQ6IDQuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA3NSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS40LW5hbm9cIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUuNC1uYW5vXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LjQgTmFub1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5jb2RlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbmNvZGUuYWkvemVuL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4yLFxuXHRcdFx0XHRvdXRwdXQ6IDEuMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS40LXByb1wiOiB7XG5cdFx0XHRpZDogXCJncHQtNS40LXByb1wiLFxuXHRcdFx0bmFtZTogXCJHUFQtNS40IFByb1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5jb2RlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbmNvZGUuYWkvemVuL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMzAsXG5cdFx0XHRcdG91dHB1dDogMTgwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDMwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNTAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJraW1pLWsyLjVcIjoge1xuXHRcdFx0aWQ6IFwia2ltaS1rMi41XCIsXG5cdFx0XHRuYW1lOiBcIktpbWkgSzIuNVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmNvZGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVuY29kZS5haS96ZW4vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjYsXG5cdFx0XHRcdG91dHB1dDogMyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA4LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJtaW5pbWF4LW0yLjVcIjoge1xuXHRcdFx0aWQ6IFwibWluaW1heC1tMi41XCIsXG5cdFx0XHRuYW1lOiBcIk1pbmlNYXggTTIuNVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmNvZGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVuY29kZS5haS96ZW4vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zLFxuXHRcdFx0XHRvdXRwdXQ6IDEuMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA2LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwNDgwMCxcblx0XHRcdG1heFRva2VuczogMTMxMDcyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibWluaW1heC1tMi41LWZyZWVcIjoge1xuXHRcdFx0aWQ6IFwibWluaW1heC1tMi41LWZyZWVcIixcblx0XHRcdG5hbWU6IFwiTWluaU1heCBNMi41IEZyZWVcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5jb2RlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbmNvZGUuYWkvemVuXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwNDgwMCxcblx0XHRcdG1heFRva2VuczogMTMxMDcyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwibmVtb3Ryb24tMy1zdXBlci1mcmVlXCI6IHtcblx0XHRcdGlkOiBcIm5lbW90cm9uLTMtc3VwZXItZnJlZVwiLFxuXHRcdFx0bmFtZTogXCJOZW1vdHJvbiAzIFN1cGVyIEZyZWVcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5jb2RlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbmNvZGUuYWkvemVuL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwNDgwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHR9IGFzIGNvbnN0IHNhdGlzZmllcyBSZWNvcmQ8c3RyaW5nLCBNb2RlbDxhbnk+PjtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUtPLE1BQU0sa0JBQWtCO0FBQUEsRUFDN0IsY0FBYztBQUFB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
