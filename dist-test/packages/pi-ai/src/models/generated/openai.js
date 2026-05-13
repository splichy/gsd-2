const OPENAI_MODELS = {
  "codex-mini-latest": {
    id: "codex-mini-latest",
    name: "Codex Mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1.5,
      output: 6,
      cacheRead: 0.375,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 1e5
  },
  "gpt-4": {
    id: "gpt-4",
    name: "GPT-4",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 30,
      output: 60,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 8192,
    maxTokens: 8192
  },
  "gpt-4-turbo": {
    id: "gpt-4-turbo",
    name: "GPT-4 Turbo",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 10,
      output: 30,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "gpt-4.1": {
    id: "gpt-4.1",
    name: "GPT-4.1",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 8,
      cacheRead: 0.5,
      cacheWrite: 0
    },
    contextWindow: 1047576,
    maxTokens: 32768
  },
  "gpt-4.1-mini": {
    id: "gpt-4.1-mini",
    name: "GPT-4.1 mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.4,
      output: 1.6,
      cacheRead: 0.1,
      cacheWrite: 0
    },
    contextWindow: 1047576,
    maxTokens: 32768
  },
  "gpt-4.1-nano": {
    id: "gpt-4.1-nano",
    name: "GPT-4.1 nano",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.1,
      output: 0.4,
      cacheRead: 0.03,
      cacheWrite: 0
    },
    contextWindow: 1047576,
    maxTokens: 32768
  },
  "gpt-4o": {
    id: "gpt-4o",
    name: "GPT-4o",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 2.5,
      output: 10,
      cacheRead: 1.25,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  "gpt-4o-2024-05-13": {
    id: "gpt-4o-2024-05-13",
    name: "GPT-4o (2024-05-13)",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 5,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "gpt-4o-2024-08-06": {
    id: "gpt-4o-2024-08-06",
    name: "GPT-4o (2024-08-06)",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 2.5,
      output: 10,
      cacheRead: 1.25,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  "gpt-4o-2024-11-20": {
    id: "gpt-4o-2024-11-20",
    name: "GPT-4o (2024-11-20)",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 2.5,
      output: 10,
      cacheRead: 1.25,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  "gpt-4o-mini": {
    id: "gpt-4o-mini",
    name: "GPT-4o mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.08,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  "gpt-5": {
    id: "gpt-5",
    name: "GPT-5",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
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
  "gpt-5-chat-latest": {
    id: "gpt-5-chat-latest",
    name: "GPT-5 Chat Latest",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  "gpt-5-codex": {
    id: "gpt-5-codex",
    name: "GPT-5-Codex",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
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
  "gpt-5-mini": {
    id: "gpt-5-mini",
    name: "GPT-5 Mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
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
  "gpt-5-nano": {
    id: "gpt-5-nano",
    name: "GPT-5 Nano",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.05,
      output: 0.4,
      cacheRead: 5e-3,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5-pro": {
    id: "gpt-5-pro",
    name: "GPT-5 Pro",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 15,
      output: 120,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 272e3
  },
  "gpt-5.1": {
    id: "gpt-5.1",
    name: "GPT-5.1",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.25,
      output: 10,
      cacheRead: 0.13,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.1-chat-latest": {
    id: "gpt-5.1-chat-latest",
    name: "GPT-5.1 Chat",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  "gpt-5.1-codex": {
    id: "gpt-5.1-codex",
    name: "GPT-5.1 Codex",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
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
  "gpt-5.1-codex-max": {
    id: "gpt-5.1-codex-max",
    name: "GPT-5.1 Codex Max",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
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
    name: "GPT-5.1 Codex mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
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
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
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
  "gpt-5.2-chat-latest": {
    id: "gpt-5.2-chat-latest",
    name: "GPT-5.2 Chat",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.75,
      output: 14,
      cacheRead: 0.175,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  "gpt-5.2-codex": {
    id: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
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
  "gpt-5.2-pro": {
    id: "gpt-5.2-pro",
    name: "GPT-5.2 Pro",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 21,
      output: 168,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "gpt-5.3-chat-latest": {
    id: "gpt-5.3-chat-latest",
    name: "GPT-5.3 Chat (latest)",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 1.75,
      output: 14,
      cacheRead: 0.175,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  "gpt-5.3-codex": {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
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
  "gpt-5.3-codex-spark": {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.75,
      output: 14,
      cacheRead: 0.175,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 32e3
  },
  "gpt-5.4": {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
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
  "gpt-5.5": {
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 128e3
  },
  "gpt-5.4-mini": {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
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
    name: "GPT-5.4 nano",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
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
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 30,
      output: 180,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 105e4,
    maxTokens: 128e3
  },
  "o1": {
    id: "o1",
    name: "o1",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 15,
      output: 60,
      cacheRead: 7.5,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 1e5
  },
  "o1-pro": {
    id: "o1-pro",
    name: "o1-pro",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 150,
      output: 600,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 1e5
  },
  "o3": {
    id: "o3",
    name: "o3",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 8,
      cacheRead: 0.5,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 1e5
  },
  "o3-deep-research": {
    id: "o3-deep-research",
    name: "o3-deep-research",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 10,
      output: 40,
      cacheRead: 2.5,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 1e5
  },
  "o3-mini": {
    id: "o3-mini",
    name: "o3-mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1.1,
      output: 4.4,
      cacheRead: 0.55,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 1e5
  },
  "o3-pro": {
    id: "o3-pro",
    name: "o3-pro",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 20,
      output: 80,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 1e5
  },
  "o4-mini": {
    id: "o4-mini",
    name: "o4-mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.1,
      output: 4.4,
      cacheRead: 0.28,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 1e5
  },
  "o4-mini-deep-research": {
    id: "o4-mini-deep-research",
    name: "o4-mini-deep-research",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 8,
      cacheRead: 0.5,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 1e5
  }
};
export {
  OPENAI_MODELS
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL21vZGVscy9nZW5lcmF0ZWQvb3BlbmFpLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBUaGlzIGZpbGUgaXMgYXV0by1nZW5lcmF0ZWQgYnkgc2NyaXB0cy9nZW5lcmF0ZS1tb2RlbHMudHNcbi8vIERvIG5vdCBlZGl0IG1hbnVhbGx5IC0gcnVuICducG0gcnVuIGdlbmVyYXRlLW1vZGVscycgdG8gdXBkYXRlXG5cbmltcG9ydCB0eXBlIHsgTW9kZWwgfSBmcm9tIFwiLi4vLi4vdHlwZXMuanNcIjtcblxuZXhwb3J0IGNvbnN0IE9QRU5BSV9NT0RFTFMgPSB7XG5cdFx0XCJjb2RleC1taW5pLWxhdGVzdFwiOiB7XG5cdFx0XHRpZDogXCJjb2RleC1taW5pLWxhdGVzdFwiLFxuXHRcdFx0bmFtZTogXCJDb2RleCBNaW5pXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS41LFxuXHRcdFx0XHRvdXRwdXQ6IDYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4zNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMDAwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwiZ3B0LTRcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTRcIixcblx0XHRcdG5hbWU6IFwiR1BULTRcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuYWlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMzAsXG5cdFx0XHRcdG91dHB1dDogNjAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA4MTkyLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC00LXR1cmJvXCI6IHtcblx0XHRcdGlkOiBcImdwdC00LXR1cmJvXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC00IFR1cmJvXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMTAsXG5cdFx0XHRcdG91dHB1dDogMzAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwiZ3B0LTQuMVwiOiB7XG5cdFx0XHRpZDogXCJncHQtNC4xXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC00LjFcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuYWlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLFxuXHRcdFx0XHRvdXRwdXQ6IDgsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDc1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDMyNzY4LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC00LjEtbWluaVwiOiB7XG5cdFx0XHRpZDogXCJncHQtNC4xLW1pbmlcIixcblx0XHRcdG5hbWU6IFwiR1BULTQuMSBtaW5pXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC40LFxuXHRcdFx0XHRvdXRwdXQ6IDEuNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjEsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0NzU3Nixcblx0XHRcdG1heFRva2VuczogMzI3NjgsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwiZ3B0LTQuMS1uYW5vXCI6IHtcblx0XHRcdGlkOiBcImdwdC00LjEtbmFub1wiLFxuXHRcdFx0bmFtZTogXCJHUFQtNC4xIG5hbm9cIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuYWlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjEsXG5cdFx0XHRcdG91dHB1dDogMC40LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0NzU3Nixcblx0XHRcdG1heFRva2VuczogMzI3NjgsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwiZ3B0LTRvXCI6IHtcblx0XHRcdGlkOiBcImdwdC00b1wiLFxuXHRcdFx0bmFtZTogXCJHUFQtNG9cIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuYWlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMS4yNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC00by0yMDI0LTA1LTEzXCI6IHtcblx0XHRcdGlkOiBcImdwdC00by0yMDI0LTA1LTEzXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC00byAoMjAyNC0wNS0xMylcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuYWlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiA1LFxuXHRcdFx0XHRvdXRwdXQ6IDE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC00by0yMDI0LTA4LTA2XCI6IHtcblx0XHRcdGlkOiBcImdwdC00by0yMDI0LTA4LTA2XCIsXG5cdFx0XHRuYW1lOiBcIkdQVC00byAoMjAyNC0wOC0wNilcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuYWlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMS4yNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC00by0yMDI0LTExLTIwXCI6IHtcblx0XHRcdGlkOiBcImdwdC00by0yMDI0LTExLTIwXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC00byAoMjAyNC0xMS0yMClcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuYWlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMS4yNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC00by1taW5pXCI6IHtcblx0XHRcdGlkOiBcImdwdC00by1taW5pXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC00byBtaW5pXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNSxcblx0XHRcdFx0b3V0cHV0OiAwLjYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wOCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01XCI6IHtcblx0XHRcdGlkOiBcImdwdC01XCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDEwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTI1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LWNoYXQtbGF0ZXN0XCI6IHtcblx0XHRcdGlkOiBcImdwdC01LWNoYXQtbGF0ZXN0XCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01IENoYXQgTGF0ZXN0XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4yNSxcblx0XHRcdFx0b3V0cHV0OiAxMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjEyNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LWNvZGV4XCI6IHtcblx0XHRcdGlkOiBcImdwdC01LWNvZGV4XCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LUNvZGV4XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDEwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTI1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LW1pbmlcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUtbWluaVwiLFxuXHRcdFx0bmFtZTogXCJHUFQtNSBNaW5pXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwiZ3B0LTUtbmFub1wiOiB7XG5cdFx0XHRpZDogXCJncHQtNS1uYW5vXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01IE5hbm9cIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuYWlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDUsXG5cdFx0XHRcdG91dHB1dDogMC40LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDA1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LXByb1wiOiB7XG5cdFx0XHRpZDogXCJncHQtNS1wcm9cIixcblx0XHRcdG5hbWU6IFwiR1BULTUgUHJvXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxNSxcblx0XHRcdFx0b3V0cHV0OiAxMjAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDI3MjAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS4xXCI6IHtcblx0XHRcdGlkOiBcImdwdC01LjFcIixcblx0XHRcdG5hbWU6IFwiR1BULTUuMVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5haVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4yNSxcblx0XHRcdFx0b3V0cHV0OiAxMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjEzLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LjEtY2hhdC1sYXRlc3RcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUuMS1jaGF0LWxhdGVzdFwiLFxuXHRcdFx0bmFtZTogXCJHUFQtNS4xIENoYXRcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuYWlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxNjM4NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS4xLWNvZGV4XCI6IHtcblx0XHRcdGlkOiBcImdwdC01LjEtY29kZXhcIixcblx0XHRcdG5hbWU6IFwiR1BULTUuMSBDb2RleFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5haVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4yNSxcblx0XHRcdFx0b3V0cHV0OiAxMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjEyNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS4xLWNvZGV4LW1heFwiOiB7XG5cdFx0XHRpZDogXCJncHQtNS4xLWNvZGV4LW1heFwiLFxuXHRcdFx0bmFtZTogXCJHUFQtNS4xIENvZGV4IE1heFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5haVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4yNSxcblx0XHRcdFx0b3V0cHV0OiAxMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjEyNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS4xLWNvZGV4LW1pbmlcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUuMS1jb2RleC1taW5pXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LjEgQ29kZXggbWluaVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5haVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4yNSxcblx0XHRcdFx0b3V0cHV0OiAyLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDI1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LjJcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUuMlwiLFxuXHRcdFx0bmFtZTogXCJHUFQtNS4yXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjc1LFxuXHRcdFx0XHRvdXRwdXQ6IDE0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LjItY2hhdC1sYXRlc3RcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUuMi1jaGF0LWxhdGVzdFwiLFxuXHRcdFx0bmFtZTogXCJHUFQtNS4yIENoYXRcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuYWlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuNzUsXG5cdFx0XHRcdG91dHB1dDogMTQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxNjM4NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS4yLWNvZGV4XCI6IHtcblx0XHRcdGlkOiBcImdwdC01LjItY29kZXhcIixcblx0XHRcdG5hbWU6IFwiR1BULTUuMiBDb2RleFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5haVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS43NSxcblx0XHRcdFx0b3V0cHV0OiAxNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjE3NSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS4yLXByb1wiOiB7XG5cdFx0XHRpZDogXCJncHQtNS4yLXByb1wiLFxuXHRcdFx0bmFtZTogXCJHUFQtNS4yIFByb1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5haVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMjEsXG5cdFx0XHRcdG91dHB1dDogMTY4LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwiZ3B0LTUuMy1jaGF0LWxhdGVzdFwiOiB7XG5cdFx0XHRpZDogXCJncHQtNS4zLWNoYXQtbGF0ZXN0XCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LjMgQ2hhdCAobGF0ZXN0KVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5haVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuNzUsXG5cdFx0XHRcdG91dHB1dDogMTQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxNjM4NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS4zLWNvZGV4XCI6IHtcblx0XHRcdGlkOiBcImdwdC01LjMtY29kZXhcIixcblx0XHRcdG5hbWU6IFwiR1BULTUuMyBDb2RleFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5haVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS43NSxcblx0XHRcdFx0b3V0cHV0OiAxNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjE3NSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS4zLWNvZGV4LXNwYXJrXCI6IHtcblx0XHRcdGlkOiBcImdwdC01LjMtY29kZXgtc3BhcmtcIixcblx0XHRcdG5hbWU6IFwiR1BULTUuMyBDb2RleCBTcGFya1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5haVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS43NSxcblx0XHRcdFx0b3V0cHV0OiAxNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjE3NSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDMyMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LjRcIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUuNFwiLFxuXHRcdFx0bmFtZTogXCJHUFQtNS40XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLjUsXG5cdFx0XHRcdG91dHB1dDogMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4yNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNzIwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS41XCI6IHtcblx0XHRcdGlkOiBcImdwdC01LjVcIixcblx0XHRcdG5hbWU6IFwiR1BULTUuNVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5haVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogNSxcblx0XHRcdFx0b3V0cHV0OiAzMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcImdwdC01LjQtbWluaVwiOiB7XG5cdFx0XHRpZDogXCJncHQtNS40LW1pbmlcIixcblx0XHRcdG5hbWU6IFwiR1BULTUuNCBtaW5pXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjc1LFxuXHRcdFx0XHRvdXRwdXQ6IDQuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA3NSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS40LW5hbm9cIjoge1xuXHRcdFx0aWQ6IFwiZ3B0LTUuNC1uYW5vXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LjQgbmFub1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5haVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4yLFxuXHRcdFx0XHRvdXRwdXQ6IDEuMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJncHQtNS40LXByb1wiOiB7XG5cdFx0XHRpZDogXCJncHQtNS40LXByb1wiLFxuXHRcdFx0bmFtZTogXCJHUFQtNS40IFByb1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5haVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMzAsXG5cdFx0XHRcdG91dHB1dDogMTgwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA1MDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcIm8xXCI6IHtcblx0XHRcdGlkOiBcIm8xXCIsXG5cdFx0XHRuYW1lOiBcIm8xXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxNSxcblx0XHRcdFx0b3V0cHV0OiA2MCxcblx0XHRcdFx0Y2FjaGVSZWFkOiA3LjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMDAwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwibzEtcHJvXCI6IHtcblx0XHRcdGlkOiBcIm8xLXByb1wiLFxuXHRcdFx0bmFtZTogXCJvMS1wcm9cIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuYWlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDE1MCxcblx0XHRcdFx0b3V0cHV0OiA2MDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEwMDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJvM1wiOiB7XG5cdFx0XHRpZDogXCJvM1wiLFxuXHRcdFx0bmFtZTogXCJvM1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5haVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMixcblx0XHRcdFx0b3V0cHV0OiA4LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEwMDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1yZXNwb25zZXNcIj4sXG5cdFx0XCJvMy1kZWVwLXJlc2VhcmNoXCI6IHtcblx0XHRcdGlkOiBcIm8zLWRlZXAtcmVzZWFyY2hcIixcblx0XHRcdG5hbWU6IFwibzMtZGVlcC1yZXNlYXJjaFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1yZXNwb25zZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5haVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FwaS5vcGVuYWkuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMTAsXG5cdFx0XHRcdG91dHB1dDogNDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMi41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTAwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcIm8zLW1pbmlcIjoge1xuXHRcdFx0aWQ6IFwibzMtbWluaVwiLFxuXHRcdFx0bmFtZTogXCJvMy1taW5pXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4xLFxuXHRcdFx0XHRvdXRwdXQ6IDQuNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjU1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTAwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcIm8zLXByb1wiOiB7XG5cdFx0XHRpZDogXCJvMy1wcm9cIixcblx0XHRcdG5hbWU6IFwibzMtcHJvXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyMCxcblx0XHRcdFx0b3V0cHV0OiA4MCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTAwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLXJlc3BvbnNlc1wiPixcblx0XHRcIm80LW1pbmlcIjoge1xuXHRcdFx0aWQ6IFwibzQtbWluaVwiLFxuXHRcdFx0bmFtZTogXCJvNC1taW5pXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLXJlc3BvbnNlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbmFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLm9wZW5haS5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjEsXG5cdFx0XHRcdG91dHB1dDogNC40LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMjgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMDAwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHRcdFwibzQtbWluaS1kZWVwLXJlc2VhcmNoXCI6IHtcblx0XHRcdGlkOiBcIm80LW1pbmktZGVlcC1yZXNlYXJjaFwiLFxuXHRcdFx0bmFtZTogXCJvNC1taW5pLWRlZXAtcmVzZWFyY2hcIixcblx0XHRcdGFwaTogXCJvcGVuYWktcmVzcG9uc2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVuYWlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIsXG5cdFx0XHRcdG91dHB1dDogOCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMDAwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktcmVzcG9uc2VzXCI+LFxuXHR9IGFzIGNvbnN0IHNhdGlzZmllcyBSZWNvcmQ8c3RyaW5nLCBNb2RlbDxhbnk+PjtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUtPLE1BQU0sZ0JBQWdCO0FBQUEsRUFDM0IscUJBQXFCO0FBQUEsSUFDcEIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLE1BQU07QUFBQSxJQUNkLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsU0FBUztBQUFBLElBQ1IsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLE1BQU07QUFBQSxJQUNkLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxN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
