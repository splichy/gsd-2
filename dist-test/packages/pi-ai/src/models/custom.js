const CUSTOM_MODELS = {
  // ─── Alibaba Coding Plan ─────────────────────────────────────────────
  // Direct Alibaba DashScope Coding Plan endpoint (OpenAI-compatible).
  // NOT the same as alibaba/* models on OpenRouter — different endpoint & auth.
  // Original PR: #295 | Fixes: #1003, #1055, #1057
  "alibaba-coding-plan": {
    "qwen3.5-plus": {
      id: "qwen3.5-plus",
      name: "Qwen3.5 Plus",
      api: "openai-completions",
      provider: "alibaba-coding-plan",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 983616,
      maxTokens: 65536,
      compat: { thinkingFormat: "qwen", supportsDeveloperRole: false }
    },
    "qwen3-max-2026-01-23": {
      id: "qwen3-max-2026-01-23",
      name: "Qwen3 Max 2026-01-23",
      api: "openai-completions",
      provider: "alibaba-coding-plan",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 258048,
      maxTokens: 32768,
      compat: { thinkingFormat: "qwen", supportsDeveloperRole: false }
    },
    "qwen3-coder-next": {
      id: "qwen3-coder-next",
      name: "Qwen3 Coder Next",
      api: "openai-completions",
      provider: "alibaba-coding-plan",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      reasoning: false,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 204800,
      maxTokens: 65536,
      compat: { supportsDeveloperRole: false }
    },
    "qwen3-coder-plus": {
      id: "qwen3-coder-plus",
      name: "Qwen3 Coder Plus",
      api: "openai-completions",
      provider: "alibaba-coding-plan",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      reasoning: false,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 997952,
      maxTokens: 65536,
      compat: { supportsDeveloperRole: false }
    },
    "MiniMax-M2.5": {
      id: "MiniMax-M2.5",
      name: "MiniMax M2.5",
      api: "openai-completions",
      provider: "alibaba-coding-plan",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 196608,
      maxTokens: 65536,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens"
      }
    },
    "glm-5": {
      id: "glm-5",
      name: "GLM-5",
      api: "openai-completions",
      provider: "alibaba-coding-plan",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 202752,
      maxTokens: 16384,
      compat: { thinkingFormat: "qwen", supportsDeveloperRole: false }
    },
    "glm-4.7": {
      id: "glm-4.7",
      name: "GLM-4.7",
      api: "openai-completions",
      provider: "alibaba-coding-plan",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 169984,
      maxTokens: 16384,
      compat: { thinkingFormat: "qwen", supportsDeveloperRole: false }
    },
    "kimi-k2.5": {
      id: "kimi-k2.5",
      name: "Kimi K2.5",
      api: "openai-completions",
      provider: "alibaba-coding-plan",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 258048,
      maxTokens: 32768,
      compat: { thinkingFormat: "zai", supportsDeveloperRole: false }
    }
  },
  // ─── Alibaba DashScope ───────────────────────────────────────────────
  // Regular DashScope API for users without the Coding Plan.
  // Uses the international OpenAI-compatible endpoint.
  // Requires DASHSCOPE_API_KEY from: dashscope.console.aliyun.com
  // Pricing: https://www.alibabacloud.com/help/en/model-studio/model-pricing
  "alibaba-dashscope": {
    "qwen3-max": {
      id: "qwen3-max",
      name: "Qwen3 Max",
      api: "openai-completions",
      provider: "alibaba-dashscope",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 1.2,
        output: 6,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 1e6,
      maxTokens: 32768,
      compat: { thinkingFormat: "qwen", supportsDeveloperRole: false }
    },
    "qwen3.5-plus": {
      id: "qwen3.5-plus",
      name: "Qwen3.5 Plus",
      api: "openai-completions",
      provider: "alibaba-dashscope",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0.4,
        output: 1.2,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 1e6,
      maxTokens: 65536,
      compat: { thinkingFormat: "qwen", supportsDeveloperRole: false }
    },
    "qwen3.5-flash": {
      id: "qwen3.5-flash",
      name: "Qwen3.5 Flash",
      api: "openai-completions",
      provider: "alibaba-dashscope",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      reasoning: false,
      input: ["text"],
      cost: {
        input: 0.1,
        output: 0.4,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 1e6,
      maxTokens: 32768,
      compat: { supportsDeveloperRole: false }
    },
    "qwen3-coder-plus": {
      id: "qwen3-coder-plus",
      name: "Qwen3 Coder Plus",
      api: "openai-completions",
      provider: "alibaba-dashscope",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      reasoning: false,
      input: ["text"],
      cost: {
        input: 1,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 1e6,
      maxTokens: 65536,
      compat: { supportsDeveloperRole: false }
    },
    "qwen3.6-plus": {
      id: "qwen3.6-plus",
      name: "Qwen3.6 Plus",
      api: "openai-completions",
      provider: "alibaba-dashscope",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0.5,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 1e6,
      maxTokens: 65536,
      compat: { thinkingFormat: "qwen", supportsDeveloperRole: false }
    }
  },
  // ─── Z.AI (GLM-5.1) ────────────────────────────────────────────────
  // GLM-5.1 is the latest GLM model from Zhipu AI, not yet in models.dev.
  // Uses the Z.AI Coding Plan endpoint (OpenAI-compatible).
  // Ref: https://docs.z.ai/devpack/using5.1
  "zai": {
    "glm-5.1": {
      id: "glm-5.1",
      name: "GLM-5.1",
      api: "openai-completions",
      provider: "zai",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 1,
        output: 3.2,
        cacheRead: 0.2,
        cacheWrite: 0
      },
      contextWindow: 204800,
      maxTokens: 131072,
      compat: { thinkingFormat: "zai", supportsDeveloperRole: false }
    }
  },
  // ─── MiniMax additive hotfixes ───────────────────────────────────────
  // models.dev currently omits MiniMax-M2.1-highspeed in some snapshots.
  // Keep this additive (no overrides) so generated models still win when present.
  "minimax": {
    "MiniMax-M2.1-highspeed": {
      id: "MiniMax-M2.1-highspeed",
      name: "MiniMax-M2.1-highspeed",
      api: "anthropic-messages",
      provider: "minimax",
      baseUrl: "https://api.minimax.io/anthropic",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0.6,
        output: 2.4,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 204800,
      maxTokens: 131072
    }
  },
  "minimax-cn": {
    "MiniMax-M2.1-highspeed": {
      id: "MiniMax-M2.1-highspeed",
      name: "MiniMax-M2.1-highspeed",
      api: "anthropic-messages",
      provider: "minimax-cn",
      baseUrl: "https://api.minimaxi.com/anthropic",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0.6,
        output: 2.4,
        cacheRead: 0,
        cacheWrite: 0
      },
      contextWindow: 204800,
      maxTokens: 131072
    }
  }
};
export {
  CUSTOM_MODELS
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL21vZGVscy9jdXN0b20udHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIE1hbnVhbGx5LW1haW50YWluZWQgbW9kZWwgZGVmaW5pdGlvbnMgZm9yIHByb3ZpZGVycyBOT1QgdHJhY2tlZCBieSBtb2RlbHMuZGV2LlxuLy9cbi8vIFRoZSBhdXRvLWdlbmVyYXRlZCBmaWxlcyB1bmRlciBtb2RlbHMvZ2VuZXJhdGVkLyoudHMgYXJlIHJlYnVpbHQgZnJvbSB0aGVcbi8vIG1vZGVscy5kZXYgdGhpcmQtcGFydHkgY2F0YWxvZy4gUHJvdmlkZXJzIHRoYXQgdXNlIHByb3ByaWV0YXJ5IGVuZHBvaW50cyBhbmRcbi8vIGFyZSBub3QgbGlzdGVkIG9uIG1vZGVscy5kZXYgbXVzdCBiZSBkZWZpbmVkIGhlcmUgc28gdGhleSBzdXJ2aXZlIHJlZ2VuZXJhdGlvbi5cbi8vXG4vLyBTZWU6IGh0dHBzOi8vZ2l0aHViLmNvbS9nc2QtYnVpbGQvZ3NkLTIvaXNzdWVzLzIzMzlcbi8vXG4vLyBUbyBhZGQgYSBjdXN0b20gcHJvdmlkZXI6XG4vLyAgIDEuIEFkZCBpdHMgbW9kZWwgZGVmaW5pdGlvbnMgYmVsb3cgZm9sbG93aW5nIHRoZSBleGlzdGluZyBwYXR0ZXJuLlxuLy8gICAyLiBBZGQgaXRzIEFQSSBrZXkgbWFwcGluZyB0byBlbnYtYXBpLWtleXMudHMuXG4vLyAgIDMuIEFkZCBpdHMgcHJvdmlkZXIgbmFtZSB0byBLbm93blByb3ZpZGVyIGluIHR5cGVzLnRzIChpZiBub3QgYWxyZWFkeSB0aGVyZSkuXG5cbmltcG9ydCB0eXBlIHsgTW9kZWwgfSBmcm9tIFwiLi4vdHlwZXMuanNcIjtcblxuZXhwb3J0IGNvbnN0IENVU1RPTV9NT0RFTFMgPSB7XG5cdC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBBbGliYWJhIENvZGluZyBQbGFuIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXHQvLyBEaXJlY3QgQWxpYmFiYSBEYXNoU2NvcGUgQ29kaW5nIFBsYW4gZW5kcG9pbnQgKE9wZW5BSS1jb21wYXRpYmxlKS5cblx0Ly8gTk9UIHRoZSBzYW1lIGFzIGFsaWJhYmEvKiBtb2RlbHMgb24gT3BlblJvdXRlciBcdTIwMTQgZGlmZmVyZW50IGVuZHBvaW50ICYgYXV0aC5cblx0Ly8gT3JpZ2luYWwgUFI6ICMyOTUgfCBGaXhlczogIzEwMDMsICMxMDU1LCAjMTA1N1xuXHRcImFsaWJhYmEtY29kaW5nLXBsYW5cIjoge1xuXHRcdFwicXdlbjMuNS1wbHVzXCI6IHtcblx0XHRcdGlkOiBcInF3ZW4zLjUtcGx1c1wiLFxuXHRcdFx0bmFtZTogXCJRd2VuMy41IFBsdXNcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcImFsaWJhYmEtY29kaW5nLXBsYW5cIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9jb2RpbmctaW50bC5kYXNoc2NvcGUuYWxpeXVuY3MuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDk4MzYxNixcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0XHRjb21wYXQ6IHsgdGhpbmtpbmdGb3JtYXQ6IFwicXdlblwiLCBzdXBwb3J0c0RldmVsb3BlclJvbGU6IGZhbHNlIH0sXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuMy1tYXgtMjAyNi0wMS0yM1wiOiB7XG5cdFx0XHRpZDogXCJxd2VuMy1tYXgtMjAyNi0wMS0yM1wiLFxuXHRcdFx0bmFtZTogXCJRd2VuMyBNYXggMjAyNi0wMS0yM1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYWxpYmFiYS1jb2RpbmctcGxhblwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2NvZGluZy1pbnRsLmRhc2hzY29wZS5hbGl5dW5jcy5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjU4MDQ4LFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHRcdGNvbXBhdDogeyB0aGlua2luZ0Zvcm1hdDogXCJxd2VuXCIsIHN1cHBvcnRzRGV2ZWxvcGVyUm9sZTogZmFsc2UgfSxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4zLWNvZGVyLW5leHRcIjoge1xuXHRcdFx0aWQ6IFwicXdlbjMtY29kZXItbmV4dFwiLFxuXHRcdFx0bmFtZTogXCJRd2VuMyBDb2RlciBOZXh0XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbGliYWJhLWNvZGluZy1wbGFuXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vY29kaW5nLWludGwuZGFzaHNjb3BlLmFsaXl1bmNzLmNvbS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjA0ODAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHRcdGNvbXBhdDogeyBzdXBwb3J0c0RldmVsb3BlclJvbGU6IGZhbHNlIH0sXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuMy1jb2Rlci1wbHVzXCI6IHtcblx0XHRcdGlkOiBcInF3ZW4zLWNvZGVyLXBsdXNcIixcblx0XHRcdG5hbWU6IFwiUXdlbjMgQ29kZXIgUGx1c1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYWxpYmFiYS1jb2RpbmctcGxhblwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2NvZGluZy1pbnRsLmRhc2hzY29wZS5hbGl5dW5jcy5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDk5Nzk1Mixcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0XHRjb21wYXQ6IHsgc3VwcG9ydHNEZXZlbG9wZXJSb2xlOiBmYWxzZSB9LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiTWluaU1heC1NMi41XCI6IHtcblx0XHRcdGlkOiBcIk1pbmlNYXgtTTIuNVwiLFxuXHRcdFx0bmFtZTogXCJNaW5pTWF4IE0yLjVcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcImFsaWJhYmEtY29kaW5nLXBsYW5cIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9jb2RpbmctaW50bC5kYXNoc2NvcGUuYWxpeXVuY3MuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDE5NjYwOCxcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0XHRjb21wYXQ6IHtcblx0XHRcdFx0c3VwcG9ydHNTdG9yZTogZmFsc2UsXG5cdFx0XHRcdHN1cHBvcnRzRGV2ZWxvcGVyUm9sZTogZmFsc2UsXG5cdFx0XHRcdHN1cHBvcnRzUmVhc29uaW5nRWZmb3J0OiB0cnVlLFxuXHRcdFx0XHRtYXhUb2tlbnNGaWVsZDogXCJtYXhfdG9rZW5zXCIsXG5cdFx0XHR9LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiZ2xtLTVcIjoge1xuXHRcdFx0aWQ6IFwiZ2xtLTVcIixcblx0XHRcdG5hbWU6IFwiR0xNLTVcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcImFsaWJhYmEtY29kaW5nLXBsYW5cIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9jb2RpbmctaW50bC5kYXNoc2NvcGUuYWxpeXVuY3MuY29tL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMjc1Mixcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0XHRjb21wYXQ6IHsgdGhpbmtpbmdGb3JtYXQ6IFwicXdlblwiLCBzdXBwb3J0c0RldmVsb3BlclJvbGU6IGZhbHNlIH0sXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJnbG0tNC43XCI6IHtcblx0XHRcdGlkOiBcImdsbS00LjdcIixcblx0XHRcdG5hbWU6IFwiR0xNLTQuN1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYWxpYmFiYS1jb2RpbmctcGxhblwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2NvZGluZy1pbnRsLmRhc2hzY29wZS5hbGl5dW5jcy5jb20vdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTY5OTg0LFxuXHRcdFx0bWF4VG9rZW5zOiAxNjM4NCxcblx0XHRcdGNvbXBhdDogeyB0aGlua2luZ0Zvcm1hdDogXCJxd2VuXCIsIHN1cHBvcnRzRGV2ZWxvcGVyUm9sZTogZmFsc2UgfSxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImtpbWktazIuNVwiOiB7XG5cdFx0XHRpZDogXCJraW1pLWsyLjVcIixcblx0XHRcdG5hbWU6IFwiS2ltaSBLMi41XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbGliYWJhLWNvZGluZy1wbGFuXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vY29kaW5nLWludGwuZGFzaHNjb3BlLmFsaXl1bmNzLmNvbS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNTgwNDgsXG5cdFx0XHRtYXhUb2tlbnM6IDMyNzY4LFxuXHRcdFx0Y29tcGF0OiB7IHRoaW5raW5nRm9ybWF0OiBcInphaVwiLCBzdXBwb3J0c0RldmVsb3BlclJvbGU6IGZhbHNlIH0sXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdH0sXG5cblx0Ly8gXHUyNTAwXHUyNTAwXHUyNTAwIEFsaWJhYmEgRGFzaFNjb3BlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXHQvLyBSZWd1bGFyIERhc2hTY29wZSBBUEkgZm9yIHVzZXJzIHdpdGhvdXQgdGhlIENvZGluZyBQbGFuLlxuXHQvLyBVc2VzIHRoZSBpbnRlcm5hdGlvbmFsIE9wZW5BSS1jb21wYXRpYmxlIGVuZHBvaW50LlxuXHQvLyBSZXF1aXJlcyBEQVNIU0NPUEVfQVBJX0tFWSBmcm9tOiBkYXNoc2NvcGUuY29uc29sZS5hbGl5dW4uY29tXG5cdC8vIFByaWNpbmc6IGh0dHBzOi8vd3d3LmFsaWJhYmFjbG91ZC5jb20vaGVscC9lbi9tb2RlbC1zdHVkaW8vbW9kZWwtcHJpY2luZ1xuXHRcImFsaWJhYmEtZGFzaHNjb3BlXCI6IHtcblx0XHRcInF3ZW4zLW1heFwiOiB7XG5cdFx0XHRpZDogXCJxd2VuMy1tYXhcIixcblx0XHRcdG5hbWU6IFwiUXdlbjMgTWF4XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbGliYWJhLWRhc2hzY29wZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2Rhc2hzY29wZS1pbnRsLmFsaXl1bmNzLmNvbS9jb21wYXRpYmxlLW1vZGUvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4yLFxuXHRcdFx0XHRvdXRwdXQ6IDYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHRcdGNvbXBhdDogeyB0aGlua2luZ0Zvcm1hdDogXCJxd2VuXCIsIHN1cHBvcnRzRGV2ZWxvcGVyUm9sZTogZmFsc2UgfSxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4zLjUtcGx1c1wiOiB7XG5cdFx0XHRpZDogXCJxd2VuMy41LXBsdXNcIixcblx0XHRcdG5hbWU6IFwiUXdlbjMuNSBQbHVzXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbGliYWJhLWRhc2hzY29wZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2Rhc2hzY29wZS1pbnRsLmFsaXl1bmNzLmNvbS9jb21wYXRpYmxlLW1vZGUvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC40LFxuXHRcdFx0XHRvdXRwdXQ6IDEuMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdFx0Y29tcGF0OiB7IHRoaW5raW5nRm9ybWF0OiBcInF3ZW5cIiwgc3VwcG9ydHNEZXZlbG9wZXJSb2xlOiBmYWxzZSB9LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwicXdlbjMuNS1mbGFzaFwiOiB7XG5cdFx0XHRpZDogXCJxd2VuMy41LWZsYXNoXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW4zLjUgRmxhc2hcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcImFsaWJhYmEtZGFzaHNjb3BlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vZGFzaHNjb3BlLWludGwuYWxpeXVuY3MuY29tL2NvbXBhdGlibGUtbW9kZS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xLFxuXHRcdFx0XHRvdXRwdXQ6IDAuNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDMyNzY4LFxuXHRcdFx0Y29tcGF0OiB7IHN1cHBvcnRzRGV2ZWxvcGVyUm9sZTogZmFsc2UgfSxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4zLWNvZGVyLXBsdXNcIjoge1xuXHRcdFx0aWQ6IFwicXdlbjMtY29kZXItcGx1c1wiLFxuXHRcdFx0bmFtZTogXCJRd2VuMyBDb2RlciBQbHVzXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbGliYWJhLWRhc2hzY29wZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2Rhc2hzY29wZS1pbnRsLmFsaXl1bmNzLmNvbS9jb21wYXRpYmxlLW1vZGUvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMCxcblx0XHRcdFx0b3V0cHV0OiA1LjAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHRcdGNvbXBhdDogeyBzdXBwb3J0c0RldmVsb3BlclJvbGU6IGZhbHNlIH0sXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuMy42LXBsdXNcIjoge1xuXHRcdFx0aWQ6IFwicXdlbjMuNi1wbHVzXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW4zLjYgUGx1c1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYWxpYmFiYS1kYXNoc2NvcGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9kYXNoc2NvcGUtaW50bC5hbGl5dW5jcy5jb20vY29tcGF0aWJsZS1tb2RlL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNSxcblx0XHRcdFx0b3V0cHV0OiAzLjAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHRcdGNvbXBhdDogeyB0aGlua2luZ0Zvcm1hdDogXCJxd2VuXCIsIHN1cHBvcnRzRGV2ZWxvcGVyUm9sZTogZmFsc2UgfSxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0fSxcblxuXHQvLyBcdTI1MDBcdTI1MDBcdTI1MDAgWi5BSSAoR0xNLTUuMSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cdC8vIEdMTS01LjEgaXMgdGhlIGxhdGVzdCBHTE0gbW9kZWwgZnJvbSBaaGlwdSBBSSwgbm90IHlldCBpbiBtb2RlbHMuZGV2LlxuXHQvLyBVc2VzIHRoZSBaLkFJIENvZGluZyBQbGFuIGVuZHBvaW50IChPcGVuQUktY29tcGF0aWJsZSkuXG5cdC8vIFJlZjogaHR0cHM6Ly9kb2NzLnouYWkvZGV2cGFjay91c2luZzUuMVxuXHRcInphaVwiOiB7XG5cdFx0XCJnbG0tNS4xXCI6IHtcblx0XHRcdGlkOiBcImdsbS01LjFcIixcblx0XHRcdG5hbWU6IFwiR0xNLTUuMVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwiemFpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYXBpLnouYWkvYXBpL2NvZGluZy9wYWFzL3Y0XCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEsXG5cdFx0XHRcdG91dHB1dDogMy4yLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDQ4MDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTA3Mixcblx0XHRcdGNvbXBhdDogeyB0aGlua2luZ0Zvcm1hdDogXCJ6YWlcIiwgc3VwcG9ydHNEZXZlbG9wZXJSb2xlOiBmYWxzZSB9LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHR9LFxuXG5cdC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBNaW5pTWF4IGFkZGl0aXZlIGhvdGZpeGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXHQvLyBtb2RlbHMuZGV2IGN1cnJlbnRseSBvbWl0cyBNaW5pTWF4LU0yLjEtaGlnaHNwZWVkIGluIHNvbWUgc25hcHNob3RzLlxuXHQvLyBLZWVwIHRoaXMgYWRkaXRpdmUgKG5vIG92ZXJyaWRlcykgc28gZ2VuZXJhdGVkIG1vZGVscyBzdGlsbCB3aW4gd2hlbiBwcmVzZW50LlxuXHRcIm1pbmltYXhcIjoge1xuXHRcdFwiTWluaU1heC1NMi4xLWhpZ2hzcGVlZFwiOiB7XG5cdFx0XHRpZDogXCJNaW5pTWF4LU0yLjEtaGlnaHNwZWVkXCIsXG5cdFx0XHRuYW1lOiBcIk1pbmlNYXgtTTIuMS1oaWdoc3BlZWRcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm1pbmltYXhcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkubWluaW1heC5pby9hbnRocm9waWNcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC42LFxuXHRcdFx0XHRvdXRwdXQ6IDIuNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwNDgwMCxcblx0XHRcdG1heFRva2VuczogMTMxMDcyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHR9LFxuXHRcIm1pbmltYXgtY25cIjoge1xuXHRcdFwiTWluaU1heC1NMi4xLWhpZ2hzcGVlZFwiOiB7XG5cdFx0XHRpZDogXCJNaW5pTWF4LU0yLjEtaGlnaHNwZWVkXCIsXG5cdFx0XHRuYW1lOiBcIk1pbmlNYXgtTTIuMS1oaWdoc3BlZWRcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm1pbmltYXgtY25cIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkubWluaW1heGkuY29tL2FudGhyb3BpY1wiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjYsXG5cdFx0XHRcdG91dHB1dDogMi40LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjA0ODAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMzEwNzIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdH0sXG59IGFzIGNvbnN0O1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBZU8sTUFBTSxnQkFBZ0I7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBSzVCLHVCQUF1QjtBQUFBLElBQ3RCLGdCQUFnQjtBQUFBLE1BQ2YsSUFBSTtBQUFBLE1BQ0osTUFBTTtBQUFBLE1BQ04sS0FBSztBQUFBLE1BQ0wsVUFBVTtBQUFBLE1BQ1YsU0FBUztBQUFBLE1BQ1QsV0FBVztBQUFBLE1BQ1gsT0FBTyxDQUFDLE1BQU07QUFBQSxNQUNkLE1BQU07QUFBQSxRQUNMLE9BQU87QUFBQSxRQUNQLFFBQVE7QUFBQSxRQUNSLFdBQVc7QUFBQSxRQUNYLFlBQVk7QUFBQSxNQUNiO0FBQUEsTUFDQSxlQUFlO0FBQUEsTUFDZixXQUFXO0FBQUEsTUFDWCxRQUFRLEVBQUUsZ0JBQWdCLFFBQVEsdUJBQXVCLE1BQU07QUFBQSxJQUNoRTtBQUFBLElBQ0Esd0JBQXdCO0FBQUEsTUFDdkIsSUFBSTtBQUFBLE1BQ0osTUFBTTtBQUFBLE1BQ04sS0FBSztBQUFBLE1BQ0wsVUFBVTtBQUFBLE1BQ1YsU0FBUztBQUFBLE1BQ1QsV0FBVztBQUFBLE1BQ1gsT0FBTyxDQUFDLE1BQU07QUFBQSxNQUNkLE1BQU07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
