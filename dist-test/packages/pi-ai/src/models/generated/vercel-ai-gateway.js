const VERCEL_AI_GATEWAY_MODELS = {
  "alibaba/qwen-3-14b": {
    id: "alibaba/qwen-3-14b",
    name: "Qwen3-14B",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.12,
      output: 0.24,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 40960,
    maxTokens: 16384
  },
  "alibaba/qwen-3-235b": {
    id: "alibaba/qwen-3-235b",
    name: "Qwen3 235B A22b Instruct 2507",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.6,
      output: 1.2,
      cacheRead: 0.6,
      cacheWrite: 0
    },
    contextWindow: 131e3,
    maxTokens: 4e4
  },
  "alibaba/qwen-3-30b": {
    id: "alibaba/qwen-3-30b",
    name: "Qwen3-30B-A3B",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.08,
      output: 0.29,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 40960,
    maxTokens: 16384
  },
  "alibaba/qwen-3-32b": {
    id: "alibaba/qwen-3-32b",
    name: "Qwen 3 32B",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.16,
      output: 0.64,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 8192
  },
  "alibaba/qwen3-235b-a22b-thinking": {
    id: "alibaba/qwen3-235b-a22b-thinking",
    name: "Qwen3 235B A22B Thinking 2507",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.22999999999999998,
      output: 2.3,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 262114,
    maxTokens: 262114
  },
  "alibaba/qwen3-coder": {
    id: "alibaba/qwen3-coder",
    name: "Qwen3 Coder 480B A35B Instruct",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 1.5,
      output: 7.5,
      cacheRead: 0.3,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 65536
  },
  "alibaba/qwen3-coder-30b-a3b": {
    id: "alibaba/qwen3-coder-30b-a3b",
    name: "Qwen 3 Coder 30B A3B Instruct",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 8192
  },
  "alibaba/qwen3-coder-next": {
    id: "alibaba/qwen3-coder-next",
    name: "Qwen3 Coder Next",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.5,
      output: 1.2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 256e3
  },
  "alibaba/qwen3-coder-plus": {
    id: "alibaba/qwen3-coder-plus",
    name: "Qwen3 Coder Plus",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 1,
      output: 5,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 65536
  },
  "alibaba/qwen3-max": {
    id: "alibaba/qwen3-max",
    name: "Qwen3 Max",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 1.2,
      output: 6,
      cacheRead: 0.24,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 32768
  },
  "alibaba/qwen3-max-preview": {
    id: "alibaba/qwen3-max-preview",
    name: "Qwen3 Max Preview",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 1.2,
      output: 6,
      cacheRead: 0.24,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 32768
  },
  "alibaba/qwen3-max-thinking": {
    id: "alibaba/qwen3-max-thinking",
    name: "Qwen 3 Max Thinking",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1.2,
      output: 6,
      cacheRead: 0.24,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 65536
  },
  "alibaba/qwen3-vl-thinking": {
    id: "alibaba/qwen3-vl-thinking",
    name: "Qwen3 VL 235B A22B Thinking",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.39999999999999997,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 32768
  },
  "alibaba/qwen3.5-flash": {
    id: "alibaba/qwen3.5-flash",
    name: "Qwen 3.5 Flash",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.09999999999999999,
      output: 0.39999999999999997,
      cacheRead: 1e-3,
      cacheWrite: 0.125
    },
    contextWindow: 1e6,
    maxTokens: 64e3
  },
  "alibaba/qwen3.5-plus": {
    id: "alibaba/qwen3.5-plus",
    name: "Qwen 3.5 Plus",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.39999999999999997,
      output: 2.4,
      cacheRead: 0.04,
      cacheWrite: 0.5
    },
    contextWindow: 1e6,
    maxTokens: 64e3
  },
  "alibaba/qwen3.6-plus": {
    id: "alibaba/qwen3.6-plus",
    name: "Qwen 3.6 Plus",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.5,
      output: 3,
      cacheRead: 0.09999999999999999,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 64e3
  },
  "anthropic/claude-3-haiku": {
    id: "anthropic/claude-3-haiku",
    name: "Claude 3 Haiku",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.25,
      output: 1.25,
      cacheRead: 0.03,
      cacheWrite: 0.3
    },
    contextWindow: 2e5,
    maxTokens: 4096
  },
  "anthropic/claude-3.5-haiku": {
    id: "anthropic/claude-3.5-haiku",
    name: "Claude 3.5 Haiku",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.7999999999999999,
      output: 4,
      cacheRead: 0.08,
      cacheWrite: 1
    },
    contextWindow: 2e5,
    maxTokens: 8192
  },
  "anthropic/claude-3.7-sonnet": {
    id: "anthropic/claude-3.7-sonnet",
    name: "Claude 3.7 Sonnet",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75
    },
    contextWindow: 2e5,
    maxTokens: 8192
  },
  "anthropic/claude-haiku-4.5": {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1,
      output: 5,
      cacheRead: 0.09999999999999999,
      cacheWrite: 1.25
    },
    contextWindow: 2e5,
    maxTokens: 64e3
  },
  "anthropic/claude-opus-4": {
    id: "anthropic/claude-opus-4",
    name: "Claude Opus 4",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "anthropic/claude-opus-4.1": {
    id: "anthropic/claude-opus-4.1",
    name: "Claude Opus 4.1",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "anthropic/claude-opus-4.5": {
    id: "anthropic/claude-opus-4.5",
    name: "Claude Opus 4.5",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "anthropic/claude-opus-4.6": {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "anthropic/claude-sonnet-4": {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "anthropic/claude-sonnet-4.5": {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "anthropic/claude-sonnet-4.6": {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75
    },
    contextWindow: 1e6,
    maxTokens: 128e3
  },
  "arcee-ai/trinity-large-preview": {
    id: "arcee-ai/trinity-large-preview",
    name: "Trinity Large Preview",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.25,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131e3,
    maxTokens: 131e3
  },
  "arcee-ai/trinity-large-thinking": {
    id: "arcee-ai/trinity-large-thinking",
    name: "Trinity Large Thinking",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.25,
      output: 0.8999999999999999,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262100,
    maxTokens: 8e4
  },
  "bytedance/seed-1.6": {
    id: "bytedance/seed-1.6",
    name: "Seed 1.6",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.25,
      output: 2,
      cacheRead: 0.049999999999999996,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 32e3
  },
  "cohere/command-a": {
    id: "cohere/command-a",
    name: "Command A",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 2.5,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 8e3
  },
  "deepseek/deepseek-r1": {
    id: "deepseek/deepseek-r1",
    name: "DeepSeek-R1",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1.35,
      output: 5.4,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 8192
  },
  "deepseek/deepseek-v3": {
    id: "deepseek/deepseek-v3",
    name: "DeepSeek V3 0324",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.77,
      output: 0.77,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 163840,
    maxTokens: 16384
  },
  "deepseek/deepseek-v3.1": {
    id: "deepseek/deepseek-v3.1",
    name: "DeepSeek-V3.1",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.56,
      output: 1.68,
      cacheRead: 0.28,
      cacheWrite: 0
    },
    contextWindow: 163840,
    maxTokens: 8192
  },
  "deepseek/deepseek-v3.1-terminus": {
    id: "deepseek/deepseek-v3.1-terminus",
    name: "DeepSeek V3.1 Terminus",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.27,
      output: 1,
      cacheRead: 0.135,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 65536
  },
  "deepseek/deepseek-v3.2": {
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek V3.2",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.28,
      output: 0.42,
      cacheRead: 0.028,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 8e3
  },
  "deepseek/deepseek-v3.2-thinking": {
    id: "deepseek/deepseek-v3.2-thinking",
    name: "DeepSeek V3.2 Thinking",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.28,
      output: 0.42,
      cacheRead: 0.028,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 64e3
  },
  "google/gemini-2.0-flash": {
    id: "google/gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.024999999999999998,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 8192
  },
  "google/gemini-2.0-flash-lite": {
    id: "google/gemini-2.0-flash-lite",
    name: "Gemini 2.0 Flash Lite",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.075,
      output: 0.3,
      cacheRead: 0.02,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 8192
  },
  "google/gemini-2.5-flash": {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.3,
      output: 2.5,
      cacheRead: 0.03,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 65536
  },
  "google/gemini-2.5-flash-lite": {
    id: "google/gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.09999999999999999,
      output: 0.39999999999999997,
      cacheRead: 0.01,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "google/gemini-2.5-pro": {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "google/gemini-3-flash": {
    id: "google/gemini-3-flash",
    name: "Gemini 3 Flash",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.5,
      output: 3,
      cacheRead: 0.049999999999999996,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 65e3
  },
  "google/gemini-3-pro-preview": {
    id: "google/gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 12,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 64e3
  },
  "google/gemini-3.1-flash-lite-preview": {
    id: "google/gemini-3.1-flash-lite-preview",
    name: "Gemini 3.1 Flash Lite Preview",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.25,
      output: 1.5,
      cacheRead: 0.03,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 65e3
  },
  "google/gemini-3.1-pro-preview": {
    id: "google/gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 12,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 64e3
  },
  "google/gemma-4-26b-a4b-it": {
    id: "google/gemma-4-26b-a4b-it",
    name: "Gemma 4 26B A4B IT",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.13,
      output: 0.39999999999999997,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 131072
  },
  "google/gemma-4-31b-it": {
    id: "google/gemma-4-31b-it",
    name: "Gemma 4 31B IT",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.14,
      output: 0.39999999999999997,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 131072
  },
  "inception/mercury-2": {
    id: "inception/mercury-2",
    name: "Mercury 2",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.25,
      output: 0.75,
      cacheRead: 0.024999999999999998,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 128e3
  },
  "inception/mercury-coder-small": {
    id: "inception/mercury-coder-small",
    name: "Mercury Coder Small Beta",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.25,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 32e3,
    maxTokens: 16384
  },
  "kwaipilot/kat-coder-pro-v2": {
    id: "kwaipilot/kat-coder-pro-v2",
    name: "Kat Coder Pro V2",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.06,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 256e3
  },
  "meituan/longcat-flash-chat": {
    id: "meituan/longcat-flash-chat",
    name: "LongCat Flash Chat",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 1e5
  },
  "meta/llama-3.1-70b": {
    id: "meta/llama-3.1-70b",
    name: "Llama 3.1 70B Instruct",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.72,
      output: 0.72,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 8192
  },
  "meta/llama-3.1-8b": {
    id: "meta/llama-3.1-8b",
    name: "Llama 3.1 8B Instruct",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.22,
      output: 0.22,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 8192
  },
  "meta/llama-3.2-11b": {
    id: "meta/llama-3.2-11b",
    name: "Llama 3.2 11B Vision Instruct",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.16,
      output: 0.16,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 8192
  },
  "meta/llama-3.2-90b": {
    id: "meta/llama-3.2-90b",
    name: "Llama 3.2 90B Vision Instruct",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.72,
      output: 0.72,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 8192
  },
  "meta/llama-3.3-70b": {
    id: "meta/llama-3.3-70b",
    name: "Llama 3.3 70B Instruct",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.72,
      output: 0.72,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 8192
  },
  "meta/llama-4-maverick": {
    id: "meta/llama-4-maverick",
    name: "Llama 4 Maverick 17B Instruct",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.24,
      output: 0.9700000000000001,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 8192
  },
  "meta/llama-4-scout": {
    id: "meta/llama-4-scout",
    name: "Llama 4 Scout 17B Instruct",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.16999999999999998,
      output: 0.66,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 8192
  },
  "minimax/minimax-m2": {
    id: "minimax/minimax-m2",
    name: "MiniMax M2",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.03,
      cacheWrite: 0.375
    },
    contextWindow: 205e3,
    maxTokens: 205e3
  },
  "minimax/minimax-m2.1": {
    id: "minimax/minimax-m2.1",
    name: "MiniMax M2.1",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.03,
      cacheWrite: 0.375
    },
    contextWindow: 204800,
    maxTokens: 131072
  },
  "minimax/minimax-m2.1-lightning": {
    id: "minimax/minimax-m2.1-lightning",
    name: "MiniMax M2.1 Lightning",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 2.4,
      cacheRead: 0.03,
      cacheWrite: 0.375
    },
    contextWindow: 204800,
    maxTokens: 131072
  },
  "minimax/minimax-m2.5": {
    id: "minimax/minimax-m2.5",
    name: "MiniMax M2.5",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.03,
      cacheWrite: 0.375
    },
    contextWindow: 204800,
    maxTokens: 131e3
  },
  "minimax/minimax-m2.5-highspeed": {
    id: "minimax/minimax-m2.5-highspeed",
    name: "MiniMax M2.5 High Speed",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.6,
      output: 2.4,
      cacheRead: 0.03,
      cacheWrite: 0.375
    },
    contextWindow: 204800,
    maxTokens: 131e3
  },
  "minimax/minimax-m2.7": {
    id: "minimax/minimax-m2.7",
    name: "Minimax M2.7",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.06,
      cacheWrite: 0.375
    },
    contextWindow: 204800,
    maxTokens: 131e3
  },
  "minimax/minimax-m2.7-highspeed": {
    id: "minimax/minimax-m2.7-highspeed",
    name: "MiniMax M2.7 High Speed",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.6,
      output: 2.4,
      cacheRead: 0.06,
      cacheWrite: 0.375
    },
    contextWindow: 204800,
    maxTokens: 131100
  },
  "mistral/codestral": {
    id: "mistral/codestral",
    name: "Mistral Codestral",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 0.8999999999999999,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4e3
  },
  "mistral/devstral-2": {
    id: "mistral/devstral-2",
    name: "Devstral 2",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.39999999999999997,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 256e3
  },
  "mistral/devstral-small": {
    id: "mistral/devstral-small",
    name: "Devstral Small 1.1",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.09999999999999999,
      output: 0.3,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 64e3
  },
  "mistral/devstral-small-2": {
    id: "mistral/devstral-small-2",
    name: "Devstral Small 2",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.09999999999999999,
      output: 0.3,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 256e3
  },
  "mistral/ministral-3b": {
    id: "mistral/ministral-3b",
    name: "Ministral 3B",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.09999999999999999,
      output: 0.09999999999999999,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4e3
  },
  "mistral/ministral-8b": {
    id: "mistral/ministral-8b",
    name: "Ministral 8B",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.15,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4e3
  },
  "mistral/mistral-medium": {
    id: "mistral/mistral-medium",
    name: "Mistral Medium 3.1",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.39999999999999997,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 64e3
  },
  "mistral/mistral-small": {
    id: "mistral/mistral-small",
    name: "Mistral Small",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.09999999999999999,
      output: 0.3,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 32e3,
    maxTokens: 4e3
  },
  "mistral/pixtral-12b": {
    id: "mistral/pixtral-12b",
    name: "Pixtral 12B 2409",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.15,
      output: 0.15,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4e3
  },
  "mistral/pixtral-large": {
    id: "mistral/pixtral-large",
    name: "Pixtral Large",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4e3
  },
  "moonshotai/kimi-k2": {
    id: "moonshotai/kimi-k2",
    name: "Kimi K2 Instruct",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.5700000000000001,
      output: 2.3,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 131072
  },
  "moonshotai/kimi-k2-0905": {
    id: "moonshotai/kimi-k2-0905",
    name: "Kimi K2 0905",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.6,
      output: 2.5,
      cacheRead: 0.3,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 128e3
  },
  "moonshotai/kimi-k2-thinking": {
    id: "moonshotai/kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.6,
      output: 2.5,
      cacheRead: 0.15,
      cacheWrite: 0
    },
    contextWindow: 262114,
    maxTokens: 262114
  },
  "moonshotai/kimi-k2-thinking-turbo": {
    id: "moonshotai/kimi-k2-thinking-turbo",
    name: "Kimi K2 Thinking Turbo",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1.15,
      output: 8,
      cacheRead: 0.15,
      cacheWrite: 0
    },
    contextWindow: 262114,
    maxTokens: 262114
  },
  "moonshotai/kimi-k2-turbo": {
    id: "moonshotai/kimi-k2-turbo",
    name: "Kimi K2 Turbo",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 1.15,
      output: 8,
      cacheRead: 0.15,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 16384
  },
  "moonshotai/kimi-k2.5": {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.6,
      output: 3,
      cacheRead: 0.09999999999999999,
      cacheWrite: 0
    },
    contextWindow: 262114,
    maxTokens: 262114
  },
  "nvidia/nemotron-nano-12b-v2-vl": {
    id: "nvidia/nemotron-nano-12b-v2-vl",
    name: "Nvidia Nemotron Nano 12B V2 VL",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.19999999999999998,
      output: 0.6,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 131072
  },
  "nvidia/nemotron-nano-9b-v2": {
    id: "nvidia/nemotron-nano-9b-v2",
    name: "Nvidia Nemotron Nano 9B V2",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.06,
      output: 0.22999999999999998,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 131072
  },
  "openai/gpt-4-turbo": {
    id: "openai/gpt-4-turbo",
    name: "GPT-4 Turbo",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-4.1": {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-4.1-mini": {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 mini",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.39999999999999997,
      output: 1.5999999999999999,
      cacheRead: 0.09999999999999999,
      cacheWrite: 0
    },
    contextWindow: 1047576,
    maxTokens: 32768
  },
  "openai/gpt-4.1-nano": {
    id: "openai/gpt-4.1-nano",
    name: "GPT-4.1 nano",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.09999999999999999,
      output: 0.39999999999999997,
      cacheRead: 0.024999999999999998,
      cacheWrite: 0
    },
    contextWindow: 1047576,
    maxTokens: 32768
  },
  "openai/gpt-4o": {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-4o-mini": {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o mini",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.075,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  "openai/gpt-5": {
    id: "openai/gpt-5",
    name: "GPT-5",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-5-chat": {
    id: "openai/gpt-5-chat",
    name: "GPT 5 Chat",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-5-codex": {
    id: "openai/gpt-5-codex",
    name: "GPT-5-Codex",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "openai/gpt-5-mini": {
    id: "openai/gpt-5-mini",
    name: "GPT-5 mini",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.25,
      output: 2,
      cacheRead: 0.024999999999999998,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "openai/gpt-5-nano": {
    id: "openai/gpt-5-nano",
    name: "GPT-5 nano",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.049999999999999996,
      output: 0.39999999999999997,
      cacheRead: 5e-3,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "openai/gpt-5-pro": {
    id: "openai/gpt-5-pro",
    name: "GPT-5 pro",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-5.1-codex": {
    id: "openai/gpt-5.1-codex",
    name: "GPT-5.1-Codex",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-5.1-codex-max": {
    id: "openai/gpt-5.1-codex-max",
    name: "GPT 5.1 Codex Max",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-5.1-codex-mini": {
    id: "openai/gpt-5.1-codex-mini",
    name: "GPT 5.1 Codex Mini",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.25,
      output: 2,
      cacheRead: 0.024999999999999998,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "openai/gpt-5.1-instant": {
    id: "openai/gpt-5.1-instant",
    name: "GPT-5.1 Instant",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-5.1-thinking": {
    id: "openai/gpt-5.1-thinking",
    name: "GPT 5.1 Thinking",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-5.2": {
    id: "openai/gpt-5.2",
    name: "GPT 5.2",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-5.2-chat": {
    id: "openai/gpt-5.2-chat",
    name: "GPT 5.2 Chat",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-5.2-codex": {
    id: "openai/gpt-5.2-codex",
    name: "GPT 5.2 Codex",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-5.2-pro": {
    id: "openai/gpt-5.2-pro",
    name: "GPT 5.2 ",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-5.3-chat": {
    id: "openai/gpt-5.3-chat",
    name: "GPT-5.3 Chat",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-5.3-codex": {
    id: "openai/gpt-5.3-codex",
    name: "GPT 5.3 Codex",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-5.4": {
    id: "openai/gpt-5.4",
    name: "GPT 5.4",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 0
    },
    contextWindow: 105e4,
    maxTokens: 128e3
  },
  "openai/gpt-5.4-mini": {
    id: "openai/gpt-5.4-mini",
    name: "GPT 5.4 Mini",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-5.4-nano": {
    id: "openai/gpt-5.4-nano",
    name: "GPT 5.4 Nano",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.19999999999999998,
      output: 1.25,
      cacheRead: 0.02,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "openai/gpt-5.4-pro": {
    id: "openai/gpt-5.4-pro",
    name: "GPT 5.4 Pro",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/gpt-oss-20b": {
    id: "openai/gpt-oss-20b",
    name: "gpt-oss-20b",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.049999999999999996,
      output: 0.19999999999999998,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 8192
  },
  "openai/gpt-oss-safeguard-20b": {
    id: "openai/gpt-oss-safeguard-20b",
    name: "gpt-oss-safeguard-20b",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.075,
      output: 0.3,
      cacheRead: 0.037,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 65536
  },
  "openai/o1": {
    id: "openai/o1",
    name: "o1",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/o3": {
    id: "openai/o3",
    name: "o3",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/o3-deep-research": {
    id: "openai/o3-deep-research",
    name: "o3-deep-research",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/o3-mini": {
    id: "openai/o3-mini",
    name: "o3-mini",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/o3-pro": {
    id: "openai/o3-pro",
    name: "o3 Pro",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
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
  "openai/o4-mini": {
    id: "openai/o4-mini",
    name: "o4-mini",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.1,
      output: 4.4,
      cacheRead: 0.275,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 1e5
  },
  "perplexity/sonar": {
    id: "perplexity/sonar",
    name: "Sonar",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 127e3,
    maxTokens: 8e3
  },
  "perplexity/sonar-pro": {
    id: "perplexity/sonar-pro",
    name: "Sonar Pro",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 8e3
  },
  "prime-intellect/intellect-3": {
    id: "prime-intellect/intellect-3",
    name: "INTELLECT 3",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.19999999999999998,
      output: 1.1,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 131072
  },
  "xai/grok-3": {
    id: "xai/grok-3",
    name: "Grok 3 Beta",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.75,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 131072
  },
  "xai/grok-3-fast": {
    id: "xai/grok-3-fast",
    name: "Grok 3 Fast Beta",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 5,
      output: 25,
      cacheRead: 1.25,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 131072
  },
  "xai/grok-3-mini": {
    id: "xai/grok-3-mini",
    name: "Grok 3 Mini Beta",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 0.5,
      cacheRead: 0.075,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 131072
  },
  "xai/grok-3-mini-fast": {
    id: "xai/grok-3-mini-fast",
    name: "Grok 3 Mini Fast Beta",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.6,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 131072
  },
  "xai/grok-4": {
    id: "xai/grok-4",
    name: "Grok 4",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.75,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 256e3
  },
  "xai/grok-4-fast-non-reasoning": {
    id: "xai/grok-4-fast-non-reasoning",
    name: "Grok 4 Fast Non-Reasoning",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.19999999999999998,
      output: 0.5,
      cacheRead: 0.049999999999999996,
      cacheWrite: 0
    },
    contextWindow: 2e6,
    maxTokens: 256e3
  },
  "xai/grok-4-fast-reasoning": {
    id: "xai/grok-4-fast-reasoning",
    name: "Grok 4 Fast Reasoning",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.19999999999999998,
      output: 0.5,
      cacheRead: 0.049999999999999996,
      cacheWrite: 0
    },
    contextWindow: 2e6,
    maxTokens: 256e3
  },
  "xai/grok-4.1-fast-non-reasoning": {
    id: "xai/grok-4.1-fast-non-reasoning",
    name: "Grok 4.1 Fast Non-Reasoning",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.19999999999999998,
      output: 0.5,
      cacheRead: 0.049999999999999996,
      cacheWrite: 0
    },
    contextWindow: 2e6,
    maxTokens: 3e4
  },
  "xai/grok-4.1-fast-reasoning": {
    id: "xai/grok-4.1-fast-reasoning",
    name: "Grok 4.1 Fast Reasoning",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.19999999999999998,
      output: 0.5,
      cacheRead: 0.049999999999999996,
      cacheWrite: 0
    },
    contextWindow: 2e6,
    maxTokens: 3e4
  },
  "xai/grok-4.20-multi-agent": {
    id: "xai/grok-4.20-multi-agent",
    name: "Grok 4.20 Multi-Agent",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 2e6,
    maxTokens: 2e6
  },
  "xai/grok-4.20-multi-agent-beta": {
    id: "xai/grok-4.20-multi-agent-beta",
    name: "Grok 4.20 Multi Agent Beta",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 2e6,
    maxTokens: 2e6
  },
  "xai/grok-4.20-non-reasoning": {
    id: "xai/grok-4.20-non-reasoning",
    name: "Grok 4.20 Non-Reasoning",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 2e6,
    maxTokens: 2e6
  },
  "xai/grok-4.20-non-reasoning-beta": {
    id: "xai/grok-4.20-non-reasoning-beta",
    name: "Grok 4.20 Beta Non-Reasoning",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 2e6,
    maxTokens: 2e6
  },
  "xai/grok-4.20-reasoning": {
    id: "xai/grok-4.20-reasoning",
    name: "Grok 4.20 Reasoning",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 2e6,
    maxTokens: 2e6
  },
  "xai/grok-4.20-reasoning-beta": {
    id: "xai/grok-4.20-reasoning-beta",
    name: "Grok 4.20 Beta Reasoning",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 2e6,
    maxTokens: 2e6
  },
  "xai/grok-code-fast-1": {
    id: "xai/grok-code-fast-1",
    name: "Grok Code Fast 1",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.19999999999999998,
      output: 1.5,
      cacheRead: 0.02,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 256e3
  },
  "xiaomi/mimo-v2-flash": {
    id: "xiaomi/mimo-v2-flash",
    name: "MiMo V2 Flash",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.09,
      output: 0.29,
      cacheRead: 0.045,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 32e3
  },
  "xiaomi/mimo-v2-pro": {
    id: "xiaomi/mimo-v2-pro",
    name: "MiMo V2 Pro",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1,
      output: 3,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 128e3
  },
  "zai/glm-4.5": {
    id: "zai/glm-4.5",
    name: "GLM-4.5",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.6,
      output: 2.2,
      cacheRead: 0.11,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 96e3
  },
  "zai/glm-4.5-air": {
    id: "zai/glm-4.5-air",
    name: "GLM 4.5 Air",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.19999999999999998,
      output: 1.1,
      cacheRead: 0.03,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 96e3
  },
  "zai/glm-4.5v": {
    id: "zai/glm-4.5v",
    name: "GLM 4.5V",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.6,
      output: 1.7999999999999998,
      cacheRead: 0.11,
      cacheWrite: 0
    },
    contextWindow: 66e3,
    maxTokens: 16e3
  },
  "zai/glm-4.6": {
    id: "zai/glm-4.6",
    name: "GLM 4.6",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.6,
      output: 2.2,
      cacheRead: 0.11,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 96e3
  },
  "zai/glm-4.6v": {
    id: "zai/glm-4.6v",
    name: "GLM-4.6V",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.3,
      output: 0.8999999999999999,
      cacheRead: 0.049999999999999996,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 24e3
  },
  "zai/glm-4.6v-flash": {
    id: "zai/glm-4.6v-flash",
    name: "GLM-4.6V-Flash",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 24e3
  },
  "zai/glm-4.7": {
    id: "zai/glm-4.7",
    name: "GLM 4.7",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 2.25,
      output: 2.75,
      cacheRead: 2.25,
      cacheWrite: 0
    },
    contextWindow: 131e3,
    maxTokens: 4e4
  },
  "zai/glm-4.7-flash": {
    id: "zai/glm-4.7-flash",
    name: "GLM 4.7 Flash",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.07,
      output: 0.39999999999999997,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 131e3
  },
  "zai/glm-4.7-flashx": {
    id: "zai/glm-4.7-flashx",
    name: "GLM 4.7 FlashX",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.06,
      output: 0.39999999999999997,
      cacheRead: 0.01,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 128e3
  },
  "zai/glm-5": {
    id: "zai/glm-5",
    name: "GLM 5",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1,
      output: 3.1999999999999997,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 202800,
    maxTokens: 131100
  },
  "zai/glm-5-turbo": {
    id: "zai/glm-5-turbo",
    name: "GLM 5 Turbo",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1.2,
      output: 4,
      cacheRead: 0.24,
      cacheWrite: 0
    },
    contextWindow: 202800,
    maxTokens: 131100
  },
  "zai/glm-5.1": {
    id: "zai/glm-5.1",
    name: "GLM 5.1",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1.4,
      output: 4.4,
      cacheRead: 0.26,
      cacheWrite: 0
    },
    contextWindow: 202800,
    maxTokens: 64e3
  },
  "zai/glm-5v-turbo": {
    id: "zai/glm-5v-turbo",
    name: "GLM 5V Turbo",
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.2,
      output: 4,
      cacheRead: 0.24,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 128e3
  }
};
export {
  VERCEL_AI_GATEWAY_MODELS
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL21vZGVscy9nZW5lcmF0ZWQvdmVyY2VsLWFpLWdhdGV3YXkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFRoaXMgZmlsZSBpcyBhdXRvLWdlbmVyYXRlZCBieSBzY3JpcHRzL2dlbmVyYXRlLW1vZGVscy50c1xuLy8gRG8gbm90IGVkaXQgbWFudWFsbHkgLSBydW4gJ25wbSBydW4gZ2VuZXJhdGUtbW9kZWxzJyB0byB1cGRhdGVcblxuaW1wb3J0IHR5cGUgeyBNb2RlbCB9IGZyb20gXCIuLi8uLi90eXBlcy5qc1wiO1xuXG5leHBvcnQgY29uc3QgVkVSQ0VMX0FJX0dBVEVXQVlfTU9ERUxTID0ge1xuXHRcdFwiYWxpYmFiYS9xd2VuLTMtMTRiXCI6IHtcblx0XHRcdGlkOiBcImFsaWJhYmEvcXdlbi0zLTE0YlwiLFxuXHRcdFx0bmFtZTogXCJRd2VuMy0xNEJcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xMixcblx0XHRcdFx0b3V0cHV0OiAwLjI0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDA5NjAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiYWxpYmFiYS9xd2VuLTMtMjM1YlwiOiB7XG5cdFx0XHRpZDogXCJhbGliYWJhL3F3ZW4tMy0yMzViXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW4zIDIzNUIgQTIyYiBJbnN0cnVjdCAyNTA3XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjYsXG5cdFx0XHRcdG91dHB1dDogMS4yLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuNixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiYWxpYmFiYS9xd2VuLTMtMzBiXCI6IHtcblx0XHRcdGlkOiBcImFsaWJhYmEvcXdlbi0zLTMwYlwiLFxuXHRcdFx0bmFtZTogXCJRd2VuMy0zMEItQTNCXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDgsXG5cdFx0XHRcdG91dHB1dDogMC4yOSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwOTYwLFxuXHRcdFx0bWF4VG9rZW5zOiAxNjM4NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImFsaWJhYmEvcXdlbi0zLTMyYlwiOiB7XG5cdFx0XHRpZDogXCJhbGliYWJhL3F3ZW4tMy0zMmJcIixcblx0XHRcdG5hbWU6IFwiUXdlbiAzIDMyQlwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE2LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNjQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJhbGliYWJhL3F3ZW4zLTIzNWItYTIyYi10aGlua2luZ1wiOiB7XG5cdFx0XHRpZDogXCJhbGliYWJhL3F3ZW4zLTIzNWItYTIyYi10aGlua2luZ1wiLFxuXHRcdFx0bmFtZTogXCJRd2VuMyAyMzVCIEEyMkIgVGhpbmtpbmcgMjUwN1wiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjI5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdG91dHB1dDogMi4zLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTE0LFxuXHRcdFx0bWF4VG9rZW5zOiAyNjIxMTQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJhbGliYWJhL3F3ZW4zLWNvZGVyXCI6IHtcblx0XHRcdGlkOiBcImFsaWJhYmEvcXdlbjMtY29kZXJcIixcblx0XHRcdG5hbWU6IFwiUXdlbjMgQ29kZXIgNDgwQiBBMzVCIEluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjUsXG5cdFx0XHRcdG91dHB1dDogNy41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIxNDQsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiYWxpYmFiYS9xd2VuMy1jb2Rlci0zMGItYTNiXCI6IHtcblx0XHRcdGlkOiBcImFsaWJhYmEvcXdlbjMtY29kZXItMzBiLWEzYlwiLFxuXHRcdFx0bmFtZTogXCJRd2VuIDMgQ29kZXIgMzBCIEEzQiBJbnN0cnVjdFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE1LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImFsaWJhYmEvcXdlbjMtY29kZXItbmV4dFwiOiB7XG5cdFx0XHRpZDogXCJhbGliYWJhL3F3ZW4zLWNvZGVyLW5leHRcIixcblx0XHRcdG5hbWU6IFwiUXdlbjMgQ29kZXIgTmV4dFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC41LFxuXHRcdFx0XHRvdXRwdXQ6IDEuMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI1NjAwMCxcblx0XHRcdG1heFRva2VuczogMjU2MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiYWxpYmFiYS9xd2VuMy1jb2Rlci1wbHVzXCI6IHtcblx0XHRcdGlkOiBcImFsaWJhYmEvcXdlbjMtY29kZXItcGx1c1wiLFxuXHRcdFx0bmFtZTogXCJRd2VuMyBDb2RlciBQbHVzXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLFxuXHRcdFx0XHRvdXRwdXQ6IDUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xOTk5OTk5OTk5OTk5OTk5OCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImFsaWJhYmEvcXdlbjMtbWF4XCI6IHtcblx0XHRcdGlkOiBcImFsaWJhYmEvcXdlbjMtbWF4XCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW4zIE1heFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4yLFxuXHRcdFx0XHRvdXRwdXQ6IDYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4yNCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIxNDQsXG5cdFx0XHRtYXhUb2tlbnM6IDMyNzY4LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiYWxpYmFiYS9xd2VuMy1tYXgtcHJldmlld1wiOiB7XG5cdFx0XHRpZDogXCJhbGliYWJhL3F3ZW4zLW1heC1wcmV2aWV3XCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW4zIE1heCBQcmV2aWV3XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjIsXG5cdFx0XHRcdG91dHB1dDogNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjI0LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogMzI3NjgsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJhbGliYWJhL3F3ZW4zLW1heC10aGlua2luZ1wiOiB7XG5cdFx0XHRpZDogXCJhbGliYWJhL3F3ZW4zLW1heC10aGlua2luZ1wiLFxuXHRcdFx0bmFtZTogXCJRd2VuIDMgTWF4IFRoaW5raW5nXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMixcblx0XHRcdFx0b3V0cHV0OiA2LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMjQsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjU2MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImFsaWJhYmEvcXdlbjMtdmwtdGhpbmtpbmdcIjoge1xuXHRcdFx0aWQ6IFwiYWxpYmFiYS9xd2VuMy12bC10aGlua2luZ1wiLFxuXHRcdFx0bmFtZTogXCJRd2VuMyBWTCAyMzVCIEEyMkIgVGhpbmtpbmdcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjM5OTk5OTk5OTk5OTk5OTk3LFxuXHRcdFx0XHRvdXRwdXQ6IDQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDMyNzY4LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiYWxpYmFiYS9xd2VuMy41LWZsYXNoXCI6IHtcblx0XHRcdGlkOiBcImFsaWJhYmEvcXdlbjMuNS1mbGFzaFwiLFxuXHRcdFx0bmFtZTogXCJRd2VuIDMuNSBGbGFzaFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDk5OTk5OTk5OTk5OTk5OTksXG5cdFx0XHRcdG91dHB1dDogMC4zOTk5OTk5OTk5OTk5OTk5Nyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAwMSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMC4xMjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJhbGliYWJhL3F3ZW4zLjUtcGx1c1wiOiB7XG5cdFx0XHRpZDogXCJhbGliYWJhL3F3ZW4zLjUtcGx1c1wiLFxuXHRcdFx0bmFtZTogXCJRd2VuIDMuNSBQbHVzXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zOTk5OTk5OTk5OTk5OTk5Nyxcblx0XHRcdFx0b3V0cHV0OiAyLjQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wNCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMC41LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiYWxpYmFiYS9xd2VuMy42LXBsdXNcIjoge1xuXHRcdFx0aWQ6IFwiYWxpYmFiYS9xd2VuMy42LXBsdXNcIixcblx0XHRcdG5hbWU6IFwiUXdlbiAzLjYgUGx1c1wiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNSxcblx0XHRcdFx0b3V0cHV0OiAzLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDk5OTk5OTk5OTk5OTk5OTksXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJhbnRocm9waWMvY2xhdWRlLTMtaGFpa3VcIjoge1xuXHRcdFx0aWQ6IFwiYW50aHJvcGljL2NsYXVkZS0zLWhhaWt1XCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSAzIEhhaWt1XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjUsXG5cdFx0XHRcdG91dHB1dDogMS4yNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAzLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLjMsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiYW50aHJvcGljL2NsYXVkZS0zLjUtaGFpa3VcIjoge1xuXHRcdFx0aWQ6IFwiYW50aHJvcGljL2NsYXVkZS0zLjUtaGFpa3VcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIDMuNSBIYWlrdVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjc5OTk5OTk5OTk5OTk5OTksXG5cdFx0XHRcdG91dHB1dDogNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA4LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAxLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImFudGhyb3BpYy9jbGF1ZGUtMy43LXNvbm5ldFwiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMvY2xhdWRlLTMuNy1zb25uZXRcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIDMuNyBTb25uZXRcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAzLFxuXHRcdFx0XHRvdXRwdXQ6IDE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMy43NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJhbnRocm9waWMvY2xhdWRlLWhhaWt1LTQuNVwiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMvY2xhdWRlLWhhaWt1LTQuNVwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgSGFpa3UgNC41XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMSxcblx0XHRcdFx0b3V0cHV0OiA1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDk5OTk5OTk5OTk5OTk5OTksXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDEuMjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImFudGhyb3BpYy9jbGF1ZGUtb3B1cy00XCI6IHtcblx0XHRcdGlkOiBcImFudGhyb3BpYy9jbGF1ZGUtb3B1cy00XCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBPcHVzIDRcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxNSxcblx0XHRcdFx0b3V0cHV0OiA3NSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAxLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDE4Ljc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMzIwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJhbnRocm9waWMvY2xhdWRlLW9wdXMtNC4xXCI6IHtcblx0XHRcdGlkOiBcImFudGhyb3BpYy9jbGF1ZGUtb3B1cy00LjFcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIE9wdXMgNC4xXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMTUsXG5cdFx0XHRcdG91dHB1dDogNzUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMS41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAxOC43NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDMyMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiYW50aHJvcGljL2NsYXVkZS1vcHVzLTQuNVwiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMvY2xhdWRlLW9wdXMtNC41XCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBPcHVzIDQuNVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDUsXG5cdFx0XHRcdG91dHB1dDogMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiA2LjI1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJhbnRocm9waWMvY2xhdWRlLW9wdXMtNC42XCI6IHtcblx0XHRcdGlkOiBcImFudGhyb3BpYy9jbGF1ZGUtb3B1cy00LjZcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIE9wdXMgNC42XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogNSxcblx0XHRcdFx0b3V0cHV0OiAyNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDYuMjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiYW50aHJvcGljL2NsYXVkZS1zb25uZXQtNFwiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMvY2xhdWRlLXNvbm5ldC00XCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBTb25uZXQgNFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDMsXG5cdFx0XHRcdG91dHB1dDogMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4zLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAzLjc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiYW50aHJvcGljL2NsYXVkZS1zb25uZXQtNC41XCI6IHtcblx0XHRcdGlkOiBcImFudGhyb3BpYy9jbGF1ZGUtc29ubmV0LTQuNVwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgU29ubmV0IDQuNVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDMsXG5cdFx0XHRcdG91dHB1dDogMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4zLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAzLjc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiYW50aHJvcGljL2NsYXVkZS1zb25uZXQtNC42XCI6IHtcblx0XHRcdGlkOiBcImFudGhyb3BpYy9jbGF1ZGUtc29ubmV0LTQuNlwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgU29ubmV0IDQuNlwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDMsXG5cdFx0XHRcdG91dHB1dDogMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4zLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAzLjc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImFyY2VlLWFpL3RyaW5pdHktbGFyZ2UtcHJldmlld1wiOiB7XG5cdFx0XHRpZDogXCJhcmNlZS1haS90cmluaXR5LWxhcmdlLXByZXZpZXdcIixcblx0XHRcdG5hbWU6IFwiVHJpbml0eSBMYXJnZSBQcmV2aWV3XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDEsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImFyY2VlLWFpL3RyaW5pdHktbGFyZ2UtdGhpbmtpbmdcIjoge1xuXHRcdFx0aWQ6IFwiYXJjZWUtYWkvdHJpbml0eS1sYXJnZS10aGlua2luZ1wiLFxuXHRcdFx0bmFtZTogXCJUcmluaXR5IExhcmdlIFRoaW5raW5nXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjUsXG5cdFx0XHRcdG91dHB1dDogMC44OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTAwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImJ5dGVkYW5jZS9zZWVkLTEuNlwiOiB7XG5cdFx0XHRpZDogXCJieXRlZGFuY2Uvc2VlZC0xLjZcIixcblx0XHRcdG5hbWU6IFwiU2VlZCAxLjZcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4yNSxcblx0XHRcdFx0b3V0cHV0OiAyLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDQ5OTk5OTk5OTk5OTk5OTk2LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI1NjAwMCxcblx0XHRcdG1heFRva2VuczogMzIwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJjb2hlcmUvY29tbWFuZC1hXCI6IHtcblx0XHRcdGlkOiBcImNvaGVyZS9jb21tYW5kLWFcIixcblx0XHRcdG5hbWU6IFwiQ29tbWFuZCBBXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNTYwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJkZWVwc2Vlay9kZWVwc2Vlay1yMVwiOiB7XG5cdFx0XHRpZDogXCJkZWVwc2Vlay9kZWVwc2Vlay1yMVwiLFxuXHRcdFx0bmFtZTogXCJEZWVwU2Vlay1SMVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjM1LFxuXHRcdFx0XHRvdXRwdXQ6IDUuNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImRlZXBzZWVrL2RlZXBzZWVrLXYzXCI6IHtcblx0XHRcdGlkOiBcImRlZXBzZWVrL2RlZXBzZWVrLXYzXCIsXG5cdFx0XHRuYW1lOiBcIkRlZXBTZWVrIFYzIDAzMjRcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNzcsXG5cdFx0XHRcdG91dHB1dDogMC43Nyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDE2Mzg0MCxcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJkZWVwc2Vlay9kZWVwc2Vlay12My4xXCI6IHtcblx0XHRcdGlkOiBcImRlZXBzZWVrL2RlZXBzZWVrLXYzLjFcIixcblx0XHRcdG5hbWU6IFwiRGVlcFNlZWstVjMuMVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjU2LFxuXHRcdFx0XHRvdXRwdXQ6IDEuNjgsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4yOCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxNjM4NDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJkZWVwc2Vlay9kZWVwc2Vlay12My4xLXRlcm1pbnVzXCI6IHtcblx0XHRcdGlkOiBcImRlZXBzZWVrL2RlZXBzZWVrLXYzLjEtdGVybWludXNcIixcblx0XHRcdG5hbWU6IFwiRGVlcFNlZWsgVjMuMSBUZXJtaW51c1wiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI3LFxuXHRcdFx0XHRvdXRwdXQ6IDEsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImRlZXBzZWVrL2RlZXBzZWVrLXYzLjJcIjoge1xuXHRcdFx0aWQ6IFwiZGVlcHNlZWsvZGVlcHNlZWstdjMuMlwiLFxuXHRcdFx0bmFtZTogXCJEZWVwU2VlayBWMy4yXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI4LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNDIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMjgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiZGVlcHNlZWsvZGVlcHNlZWstdjMuMi10aGlua2luZ1wiOiB7XG5cdFx0XHRpZDogXCJkZWVwc2Vlay9kZWVwc2Vlay12My4yLXRoaW5raW5nXCIsXG5cdFx0XHRuYW1lOiBcIkRlZXBTZWVrIFYzLjIgVGhpbmtpbmdcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4yOCxcblx0XHRcdFx0b3V0cHV0OiAwLjQyLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDI4LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJnb29nbGUvZ2VtaW5pLTIuMC1mbGFzaFwiOiB7XG5cdFx0XHRpZDogXCJnb29nbGUvZ2VtaW5pLTIuMC1mbGFzaFwiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMi4wIEZsYXNoXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTUsXG5cdFx0XHRcdG91dHB1dDogMC42LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDI0OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJnb29nbGUvZ2VtaW5pLTIuMC1mbGFzaC1saXRlXCI6IHtcblx0XHRcdGlkOiBcImdvb2dsZS9nZW1pbmktMi4wLWZsYXNoLWxpdGVcIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIDIuMCBGbGFzaCBMaXRlXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDc1LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAyLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJnb29nbGUvZ2VtaW5pLTIuNS1mbGFzaFwiOiB7XG5cdFx0XHRpZDogXCJnb29nbGUvZ2VtaW5pLTIuNS1mbGFzaFwiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMi41IEZsYXNoXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zLFxuXHRcdFx0XHRvdXRwdXQ6IDIuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAzLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiZ29vZ2xlL2dlbWluaS0yLjUtZmxhc2gtbGl0ZVwiOiB7XG5cdFx0XHRpZDogXCJnb29nbGUvZ2VtaW5pLTIuNS1mbGFzaC1saXRlXCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAyLjUgRmxhc2ggTGl0ZVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDk5OTk5OTk5OTk5OTk5OTksXG5cdFx0XHRcdG91dHB1dDogMC4zOTk5OTk5OTk5OTk5OTk5Nyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAxLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiZ29vZ2xlL2dlbWluaS0yLjUtcHJvXCI6IHtcblx0XHRcdGlkOiBcImdvb2dsZS9nZW1pbmktMi41LXByb1wiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMi41IFByb1wiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJnb29nbGUvZ2VtaW5pLTMtZmxhc2hcIjoge1xuXHRcdFx0aWQ6IFwiZ29vZ2xlL2dlbWluaS0zLWZsYXNoXCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAzIEZsYXNoXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC41LFxuXHRcdFx0XHRvdXRwdXQ6IDMsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wNDk5OTk5OTk5OTk5OTk5OTYsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjUwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJnb29nbGUvZ2VtaW5pLTMtcHJvLXByZXZpZXdcIjoge1xuXHRcdFx0aWQ6IFwiZ29vZ2xlL2dlbWluaS0zLXByby1wcmV2aWV3XCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAzIFBybyBQcmV2aWV3XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMixcblx0XHRcdFx0b3V0cHV0OiAxMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiZ29vZ2xlL2dlbWluaS0zLjEtZmxhc2gtbGl0ZS1wcmV2aWV3XCI6IHtcblx0XHRcdGlkOiBcImdvb2dsZS9nZW1pbmktMy4xLWZsYXNoLWxpdGUtcHJldmlld1wiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMy4xIEZsYXNoIExpdGUgUHJldmlld1wiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjUsXG5cdFx0XHRcdG91dHB1dDogMS41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjUwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJnb29nbGUvZ2VtaW5pLTMuMS1wcm8tcHJldmlld1wiOiB7XG5cdFx0XHRpZDogXCJnb29nbGUvZ2VtaW5pLTMuMS1wcm8tcHJldmlld1wiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMy4xIFBybyBQcmV2aWV3XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMixcblx0XHRcdFx0b3V0cHV0OiAxMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiZ29vZ2xlL2dlbW1hLTQtMjZiLWE0Yi1pdFwiOiB7XG5cdFx0XHRpZDogXCJnb29nbGUvZ2VtbWEtNC0yNmItYTRiLWl0XCIsXG5cdFx0XHRuYW1lOiBcIkdlbW1hIDQgMjZCIEE0QiBJVFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjEzLFxuXHRcdFx0XHRvdXRwdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIxNDQsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTA3Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImdvb2dsZS9nZW1tYS00LTMxYi1pdFwiOiB7XG5cdFx0XHRpZDogXCJnb29nbGUvZ2VtbWEtNC0zMWItaXRcIixcblx0XHRcdG5hbWU6IFwiR2VtbWEgNCAzMUIgSVRcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNCxcblx0XHRcdFx0b3V0cHV0OiAwLjM5OTk5OTk5OTk5OTk5OTk3LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTQ0LFxuXHRcdFx0bWF4VG9rZW5zOiAxMzEwNzIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJpbmNlcHRpb24vbWVyY3VyeS0yXCI6IHtcblx0XHRcdGlkOiBcImluY2VwdGlvbi9tZXJjdXJ5LTJcIixcblx0XHRcdG5hbWU6IFwiTWVyY3VyeSAyXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjUsXG5cdFx0XHRcdG91dHB1dDogMC43NSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAyNDk5OTk5OTk5OTk5OTk5OCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcImluY2VwdGlvbi9tZXJjdXJ5LWNvZGVyLXNtYWxsXCI6IHtcblx0XHRcdGlkOiBcImluY2VwdGlvbi9tZXJjdXJ5LWNvZGVyLXNtYWxsXCIsXG5cdFx0XHRuYW1lOiBcIk1lcmN1cnkgQ29kZXIgU21hbGwgQmV0YVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4yNSxcblx0XHRcdFx0b3V0cHV0OiAxLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMzIwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwia3dhaXBpbG90L2thdC1jb2Rlci1wcm8tdjJcIjoge1xuXHRcdFx0aWQ6IFwia3dhaXBpbG90L2thdC1jb2Rlci1wcm8tdjJcIixcblx0XHRcdG5hbWU6IFwiS2F0IENvZGVyIFBybyBWMlwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjMsXG5cdFx0XHRcdG91dHB1dDogMS4yLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDYsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjU2MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAyNTYwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJtZWl0dWFuL2xvbmdjYXQtZmxhc2gtY2hhdFwiOiB7XG5cdFx0XHRpZDogXCJtZWl0dWFuL2xvbmdjYXQtZmxhc2gtY2hhdFwiLFxuXHRcdFx0bmFtZTogXCJMb25nQ2F0IEZsYXNoIENoYXRcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogMTAwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwibWV0YS9sbGFtYS0zLjEtNzBiXCI6IHtcblx0XHRcdGlkOiBcIm1ldGEvbGxhbWEtMy4xLTcwYlwiLFxuXHRcdFx0bmFtZTogXCJMbGFtYSAzLjEgNzBCIEluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjcyLFxuXHRcdFx0XHRvdXRwdXQ6IDAuNzIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJtZXRhL2xsYW1hLTMuMS04YlwiOiB7XG5cdFx0XHRpZDogXCJtZXRhL2xsYW1hLTMuMS04YlwiLFxuXHRcdFx0bmFtZTogXCJMbGFtYSAzLjEgOEIgSW5zdHJ1Y3RcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjIsXG5cdFx0XHRcdG91dHB1dDogMC4yMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm1ldGEvbGxhbWEtMy4yLTExYlwiOiB7XG5cdFx0XHRpZDogXCJtZXRhL2xsYW1hLTMuMi0xMWJcIixcblx0XHRcdG5hbWU6IFwiTGxhbWEgMy4yIDExQiBWaXNpb24gSW5zdHJ1Y3RcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNixcblx0XHRcdFx0b3V0cHV0OiAwLjE2LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwibWV0YS9sbGFtYS0zLjItOTBiXCI6IHtcblx0XHRcdGlkOiBcIm1ldGEvbGxhbWEtMy4yLTkwYlwiLFxuXHRcdFx0bmFtZTogXCJMbGFtYSAzLjIgOTBCIFZpc2lvbiBJbnN0cnVjdFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjcyLFxuXHRcdFx0XHRvdXRwdXQ6IDAuNzIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJtZXRhL2xsYW1hLTMuMy03MGJcIjoge1xuXHRcdFx0aWQ6IFwibWV0YS9sbGFtYS0zLjMtNzBiXCIsXG5cdFx0XHRuYW1lOiBcIkxsYW1hIDMuMyA3MEIgSW5zdHJ1Y3RcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNzIsXG5cdFx0XHRcdG91dHB1dDogMC43Mixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm1ldGEvbGxhbWEtNC1tYXZlcmlja1wiOiB7XG5cdFx0XHRpZDogXCJtZXRhL2xsYW1hLTQtbWF2ZXJpY2tcIixcblx0XHRcdG5hbWU6IFwiTGxhbWEgNCBNYXZlcmljayAxN0IgSW5zdHJ1Y3RcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4yNCxcblx0XHRcdFx0b3V0cHV0OiAwLjk3MDAwMDAwMDAwMDAwMDEsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJtZXRhL2xsYW1hLTQtc2NvdXRcIjoge1xuXHRcdFx0aWQ6IFwibWV0YS9sbGFtYS00LXNjb3V0XCIsXG5cdFx0XHRuYW1lOiBcIkxsYW1hIDQgU2NvdXQgMTdCIEluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTY5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdG91dHB1dDogMC42Nixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm1pbmltYXgvbWluaW1heC1tMlwiOiB7XG5cdFx0XHRpZDogXCJtaW5pbWF4L21pbmltYXgtbTJcIixcblx0XHRcdG5hbWU6IFwiTWluaU1heCBNMlwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjMsXG5cdFx0XHRcdG91dHB1dDogMS4yLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAuMzc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwNTAwMCxcblx0XHRcdG1heFRva2VuczogMjA1MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwibWluaW1heC9taW5pbWF4LW0yLjFcIjoge1xuXHRcdFx0aWQ6IFwibWluaW1heC9taW5pbWF4LW0yLjFcIixcblx0XHRcdG5hbWU6IFwiTWluaU1heCBNMi4xXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMyxcblx0XHRcdFx0b3V0cHV0OiAxLjIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMC4zNzUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjA0ODAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMzEwNzIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJtaW5pbWF4L21pbmltYXgtbTIuMS1saWdodG5pbmdcIjoge1xuXHRcdFx0aWQ6IFwibWluaW1heC9taW5pbWF4LW0yLjEtbGlnaHRuaW5nXCIsXG5cdFx0XHRuYW1lOiBcIk1pbmlNYXggTTIuMSBMaWdodG5pbmdcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zLFxuXHRcdFx0XHRvdXRwdXQ6IDIuNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAzLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLjM3NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDQ4MDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTA3Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm1pbmltYXgvbWluaW1heC1tMi41XCI6IHtcblx0XHRcdGlkOiBcIm1pbmltYXgvbWluaW1heC1tMi41XCIsXG5cdFx0XHRuYW1lOiBcIk1pbmlNYXggTTIuNVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjMsXG5cdFx0XHRcdG91dHB1dDogMS4yLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAuMzc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwNDgwMCxcblx0XHRcdG1heFRva2VuczogMTMxMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwibWluaW1heC9taW5pbWF4LW0yLjUtaGlnaHNwZWVkXCI6IHtcblx0XHRcdGlkOiBcIm1pbmltYXgvbWluaW1heC1tMi41LWhpZ2hzcGVlZFwiLFxuXHRcdFx0bmFtZTogXCJNaW5pTWF4IE0yLjUgSGlnaCBTcGVlZFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjYsXG5cdFx0XHRcdG91dHB1dDogMi40LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAuMzc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwNDgwMCxcblx0XHRcdG1heFRva2VuczogMTMxMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwibWluaW1heC9taW5pbWF4LW0yLjdcIjoge1xuXHRcdFx0aWQ6IFwibWluaW1heC9taW5pbWF4LW0yLjdcIixcblx0XHRcdG5hbWU6IFwiTWluaW1heCBNMi43XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zLFxuXHRcdFx0XHRvdXRwdXQ6IDEuMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA2LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLjM3NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDQ4MDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm1pbmltYXgvbWluaW1heC1tMi43LWhpZ2hzcGVlZFwiOiB7XG5cdFx0XHRpZDogXCJtaW5pbWF4L21pbmltYXgtbTIuNy1oaWdoc3BlZWRcIixcblx0XHRcdG5hbWU6IFwiTWluaU1heCBNMi43IEhpZ2ggU3BlZWRcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjYsXG5cdFx0XHRcdG91dHB1dDogMi40LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDYsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAuMzc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwNDgwMCxcblx0XHRcdG1heFRva2VuczogMTMxMTAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwibWlzdHJhbC9jb2Rlc3RyYWxcIjoge1xuXHRcdFx0aWQ6IFwibWlzdHJhbC9jb2Rlc3RyYWxcIixcblx0XHRcdG5hbWU6IFwiTWlzdHJhbCBDb2Rlc3RyYWxcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMyxcblx0XHRcdFx0b3V0cHV0OiAwLjg5OTk5OTk5OTk5OTk5OTksXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJtaXN0cmFsL2RldnN0cmFsLTJcIjoge1xuXHRcdFx0aWQ6IFwibWlzdHJhbC9kZXZzdHJhbC0yXCIsXG5cdFx0XHRuYW1lOiBcIkRldnN0cmFsIDJcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdG91dHB1dDogMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI1NjAwMCxcblx0XHRcdG1heFRva2VuczogMjU2MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwibWlzdHJhbC9kZXZzdHJhbC1zbWFsbFwiOiB7XG5cdFx0XHRpZDogXCJtaXN0cmFsL2RldnN0cmFsLXNtYWxsXCIsXG5cdFx0XHRuYW1lOiBcIkRldnN0cmFsIFNtYWxsIDEuMVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wOTk5OTk5OTk5OTk5OTk5OSxcblx0XHRcdFx0b3V0cHV0OiAwLjMsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwibWlzdHJhbC9kZXZzdHJhbC1zbWFsbC0yXCI6IHtcblx0XHRcdGlkOiBcIm1pc3RyYWwvZGV2c3RyYWwtc21hbGwtMlwiLFxuXHRcdFx0bmFtZTogXCJEZXZzdHJhbCBTbWFsbCAyXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI1NjAwMCxcblx0XHRcdG1heFRva2VuczogMjU2MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwibWlzdHJhbC9taW5pc3RyYWwtM2JcIjoge1xuXHRcdFx0aWQ6IFwibWlzdHJhbC9taW5pc3RyYWwtM2JcIixcblx0XHRcdG5hbWU6IFwiTWluaXN0cmFsIDNCXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMDk5OTk5OTk5OTk5OTk5OTksXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJtaXN0cmFsL21pbmlzdHJhbC04YlwiOiB7XG5cdFx0XHRpZDogXCJtaXN0cmFsL21pbmlzdHJhbC04YlwiLFxuXHRcdFx0bmFtZTogXCJNaW5pc3RyYWwgOEJcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTUsXG5cdFx0XHRcdG91dHB1dDogMC4xNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogNDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm1pc3RyYWwvbWlzdHJhbC1tZWRpdW1cIjoge1xuXHRcdFx0aWQ6IFwibWlzdHJhbC9taXN0cmFsLW1lZGl1bVwiLFxuXHRcdFx0bmFtZTogXCJNaXN0cmFsIE1lZGl1bSAzLjFcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zOTk5OTk5OTk5OTk5OTk5Nyxcblx0XHRcdFx0b3V0cHV0OiAyLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm1pc3RyYWwvbWlzdHJhbC1zbWFsbFwiOiB7XG5cdFx0XHRpZDogXCJtaXN0cmFsL21pc3RyYWwtc21hbGxcIixcblx0XHRcdG5hbWU6IFwiTWlzdHJhbCBTbWFsbFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDMyMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwibWlzdHJhbC9waXh0cmFsLTEyYlwiOiB7XG5cdFx0XHRpZDogXCJtaXN0cmFsL3BpeHRyYWwtMTJiXCIsXG5cdFx0XHRuYW1lOiBcIlBpeHRyYWwgMTJCIDI0MDlcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNSxcblx0XHRcdFx0b3V0cHV0OiAwLjE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwibWlzdHJhbC9waXh0cmFsLWxhcmdlXCI6IHtcblx0XHRcdGlkOiBcIm1pc3RyYWwvcGl4dHJhbC1sYXJnZVwiLFxuXHRcdFx0bmFtZTogXCJQaXh0cmFsIExhcmdlXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIsXG5cdFx0XHRcdG91dHB1dDogNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogNDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm1vb25zaG90YWkva2ltaS1rMlwiOiB7XG5cdFx0XHRpZDogXCJtb29uc2hvdGFpL2tpbWktazJcIixcblx0XHRcdG5hbWU6IFwiS2ltaSBLMiBJbnN0cnVjdFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC41NzAwMDAwMDAwMDAwMDAxLFxuXHRcdFx0XHRvdXRwdXQ6IDIuMyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogMTMxMDcyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwibW9vbnNob3RhaS9raW1pLWsyLTA5MDVcIjoge1xuXHRcdFx0aWQ6IFwibW9vbnNob3RhaS9raW1pLWsyLTA5MDVcIixcblx0XHRcdG5hbWU6IFwiS2ltaSBLMiAwOTA1XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjYsXG5cdFx0XHRcdG91dHB1dDogMi41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNTYwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm1vb25zaG90YWkva2ltaS1rMi10aGlua2luZ1wiOiB7XG5cdFx0XHRpZDogXCJtb29uc2hvdGFpL2tpbWktazItdGhpbmtpbmdcIixcblx0XHRcdG5hbWU6IFwiS2ltaSBLMiBUaGlua2luZ1wiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjYsXG5cdFx0XHRcdG91dHB1dDogMi41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTE0LFxuXHRcdFx0bWF4VG9rZW5zOiAyNjIxMTQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJtb29uc2hvdGFpL2tpbWktazItdGhpbmtpbmctdHVyYm9cIjoge1xuXHRcdFx0aWQ6IFwibW9vbnNob3RhaS9raW1pLWsyLXRoaW5raW5nLXR1cmJvXCIsXG5cdFx0XHRuYW1lOiBcIktpbWkgSzIgVGhpbmtpbmcgVHVyYm9cIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4xNSxcblx0XHRcdFx0b3V0cHV0OiA4LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTE0LFxuXHRcdFx0bWF4VG9rZW5zOiAyNjIxMTQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJtb29uc2hvdGFpL2tpbWktazItdHVyYm9cIjoge1xuXHRcdFx0aWQ6IFwibW9vbnNob3RhaS9raW1pLWsyLXR1cmJvXCIsXG5cdFx0XHRuYW1lOiBcIktpbWkgSzIgVHVyYm9cIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMTUsXG5cdFx0XHRcdG91dHB1dDogOCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjE1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI1NjAwMCxcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJtb29uc2hvdGFpL2tpbWktazIuNVwiOiB7XG5cdFx0XHRpZDogXCJtb29uc2hvdGFpL2tpbWktazIuNVwiLFxuXHRcdFx0bmFtZTogXCJLaW1pIEsyLjVcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjYsXG5cdFx0XHRcdG91dHB1dDogMyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjExNCxcblx0XHRcdG1heFRva2VuczogMjYyMTE0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwibnZpZGlhL25lbW90cm9uLW5hbm8tMTJiLXYyLXZsXCI6IHtcblx0XHRcdGlkOiBcIm52aWRpYS9uZW1vdHJvbi1uYW5vLTEyYi12Mi12bFwiLFxuXHRcdFx0bmFtZTogXCJOdmlkaWEgTmVtb3Ryb24gTmFubyAxMkIgVjIgVkxcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogMTMxMDcyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwibnZpZGlhL25lbW90cm9uLW5hbm8tOWItdjJcIjoge1xuXHRcdFx0aWQ6IFwibnZpZGlhL25lbW90cm9uLW5hbm8tOWItdjJcIixcblx0XHRcdG5hbWU6IFwiTnZpZGlhIE5lbW90cm9uIE5hbm8gOUIgVjJcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNixcblx0XHRcdFx0b3V0cHV0OiAwLjIyOTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiAxMzEwNzIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTQtdHVyYm9cIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC00LXR1cmJvXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC00IFR1cmJvXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEwLFxuXHRcdFx0XHRvdXRwdXQ6IDMwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwib3BlbmFpL2dwdC00LjFcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC00LjFcIixcblx0XHRcdG5hbWU6IFwiR1BULTQuMVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLFxuXHRcdFx0XHRvdXRwdXQ6IDgsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDc1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDMyNzY4LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwib3BlbmFpL2dwdC00LjEtbWluaVwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTQuMS1taW5pXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC00LjEgbWluaVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjM5OTk5OTk5OTk5OTk5OTk3LFxuXHRcdFx0XHRvdXRwdXQ6IDEuNTk5OTk5OTk5OTk5OTk5OSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDc1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDMyNzY4LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwib3BlbmFpL2dwdC00LjEtbmFub1wiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTQuMS1uYW5vXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC00LjEgbmFub1wiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMjQ5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0NzU3Nixcblx0XHRcdG1heFRva2VuczogMzI3NjgsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTRvXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNG9cIixcblx0XHRcdG5hbWU6IFwiR1BULTRvXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIuNSxcblx0XHRcdFx0b3V0cHV0OiAxMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAxLjI1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTRvLW1pbmlcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC00by1taW5pXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC00byBtaW5pXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTUsXG5cdFx0XHRcdG91dHB1dDogMC42LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTVcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01XCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4yNSxcblx0XHRcdFx0b3V0cHV0OiAxMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjEyNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS1jaGF0XCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNS1jaGF0XCIsXG5cdFx0XHRuYW1lOiBcIkdQVCA1IENoYXRcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDEwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTI1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTUtY29kZXhcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01LWNvZGV4XCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LUNvZGV4XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTUtbWluaVwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUtbWluaVwiLFxuXHRcdFx0bmFtZTogXCJHUFQtNSBtaW5pXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4yNSxcblx0XHRcdFx0b3V0cHV0OiAyLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDI0OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwib3BlbmFpL2dwdC01LW5hbm9cIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01LW5hbm9cIixcblx0XHRcdG5hbWU6IFwiR1BULTUgbmFub1wiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDQ5OTk5OTk5OTk5OTk5OTk2LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMDUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTUtcHJvXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNS1wcm9cIixcblx0XHRcdG5hbWU6IFwiR1BULTUgcHJvXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMTUsXG5cdFx0XHRcdG91dHB1dDogMTIwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAyNzIwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTUuMS1jb2RleFwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUuMS1jb2RleFwiLFxuXHRcdFx0bmFtZTogXCJHUFQtNS4xLUNvZGV4XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4yNSxcblx0XHRcdFx0b3V0cHV0OiAxMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjEyNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS4xLWNvZGV4LW1heFwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUuMS1jb2RleC1tYXhcIixcblx0XHRcdG5hbWU6IFwiR1BUIDUuMSBDb2RleCBNYXhcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDEwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTI1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwib3BlbmFpL2dwdC01LjEtY29kZXgtbWluaVwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUuMS1jb2RleC1taW5pXCIsXG5cdFx0XHRuYW1lOiBcIkdQVCA1LjEgQ29kZXggTWluaVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjUsXG5cdFx0XHRcdG91dHB1dDogMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAyNDk5OTk5OTk5OTk5OTk5OCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS4xLWluc3RhbnRcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01LjEtaW5zdGFudFwiLFxuXHRcdFx0bmFtZTogXCJHUFQtNS4xIEluc3RhbnRcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDEwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTI1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTUuMS10aGlua2luZ1wiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUuMS10aGlua2luZ1wiLFxuXHRcdFx0bmFtZTogXCJHUFQgNS4xIFRoaW5raW5nXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4yNSxcblx0XHRcdFx0b3V0cHV0OiAxMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjEyNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS4yXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNS4yXCIsXG5cdFx0XHRuYW1lOiBcIkdQVCA1LjJcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjc1LFxuXHRcdFx0XHRvdXRwdXQ6IDE0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwib3BlbmFpL2dwdC01LjItY2hhdFwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUuMi1jaGF0XCIsXG5cdFx0XHRuYW1lOiBcIkdQVCA1LjIgQ2hhdFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuNzUsXG5cdFx0XHRcdG91dHB1dDogMTQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxNjM4NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS4yLWNvZGV4XCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNS4yLWNvZGV4XCIsXG5cdFx0XHRuYW1lOiBcIkdQVCA1LjIgQ29kZXhcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjc1LFxuXHRcdFx0XHRvdXRwdXQ6IDE0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwib3BlbmFpL2dwdC01LjItcHJvXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNS4yLXByb1wiLFxuXHRcdFx0bmFtZTogXCJHUFQgNS4yIFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIxLFxuXHRcdFx0XHRvdXRwdXQ6IDE2OCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwib3BlbmFpL2dwdC01LjMtY2hhdFwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUuMy1jaGF0XCIsXG5cdFx0XHRuYW1lOiBcIkdQVC01LjMgQ2hhdFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuNzUsXG5cdFx0XHRcdG91dHB1dDogMTQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxNjM4NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS4zLWNvZGV4XCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNS4zLWNvZGV4XCIsXG5cdFx0XHRuYW1lOiBcIkdQVCA1LjMgQ29kZXhcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjc1LFxuXHRcdFx0XHRvdXRwdXQ6IDE0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwib3BlbmFpL2dwdC01LjRcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01LjRcIixcblx0XHRcdG5hbWU6IFwiR1BUIDUuNFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIuNSxcblx0XHRcdFx0b3V0cHV0OiAxNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjI1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNTAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS40LW1pbmlcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01LjQtbWluaVwiLFxuXHRcdFx0bmFtZTogXCJHUFQgNS40IE1pbmlcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjc1LFxuXHRcdFx0XHRvdXRwdXQ6IDQuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA3NSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS40LW5hbm9cIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01LjQtbmFub1wiLFxuXHRcdFx0bmFtZTogXCJHUFQgNS40IE5hbm9cIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRvdXRwdXQ6IDEuMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS40LXByb1wiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUuNC1wcm9cIixcblx0XHRcdG5hbWU6IFwiR1BUIDUuNCBQcm9cIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAzMCxcblx0XHRcdFx0b3V0cHV0OiAxODAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDUwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LW9zcy0yMGJcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC1vc3MtMjBiXCIsXG5cdFx0XHRuYW1lOiBcImdwdC1vc3MtMjBiXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDQ5OTk5OTk5OTk5OTk5OTk2LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LW9zcy1zYWZlZ3VhcmQtMjBiXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtb3NzLXNhZmVndWFyZC0yMGJcIixcblx0XHRcdG5hbWU6IFwiZ3B0LW9zcy1zYWZlZ3VhcmQtMjBiXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDc1LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAzNyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwib3BlbmFpL28xXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9vMVwiLFxuXHRcdFx0bmFtZTogXCJvMVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDE1LFxuXHRcdFx0XHRvdXRwdXQ6IDYwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDcuNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEwMDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm9wZW5haS9vM1wiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvbzNcIixcblx0XHRcdG5hbWU6IFwibzNcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLFxuXHRcdFx0XHRvdXRwdXQ6IDgsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTAwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwib3BlbmFpL28zLWRlZXAtcmVzZWFyY2hcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL28zLWRlZXAtcmVzZWFyY2hcIixcblx0XHRcdG5hbWU6IFwibzMtZGVlcC1yZXNlYXJjaFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEwLFxuXHRcdFx0XHRvdXRwdXQ6IDQwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDIuNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEwMDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcIm9wZW5haS9vMy1taW5pXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9vMy1taW5pXCIsXG5cdFx0XHRuYW1lOiBcIm8zLW1pbmlcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4xLFxuXHRcdFx0XHRvdXRwdXQ6IDQuNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjU1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTAwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwib3BlbmFpL28zLXByb1wiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvbzMtcHJvXCIsXG5cdFx0XHRuYW1lOiBcIm8zIFByb1wiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIwLFxuXHRcdFx0XHRvdXRwdXQ6IDgwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMDAwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJvcGVuYWkvbzQtbWluaVwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvbzQtbWluaVwiLFxuXHRcdFx0bmFtZTogXCJvNC1taW5pXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4xLFxuXHRcdFx0XHRvdXRwdXQ6IDQuNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjI3NSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEwMDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcInBlcnBsZXhpdHkvc29uYXJcIjoge1xuXHRcdFx0aWQ6IFwicGVycGxleGl0eS9zb25hclwiLFxuXHRcdFx0bmFtZTogXCJTb25hclwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjcwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJwZXJwbGV4aXR5L3NvbmFyLXByb1wiOiB7XG5cdFx0XHRpZDogXCJwZXJwbGV4aXR5L3NvbmFyLXByb1wiLFxuXHRcdFx0bmFtZTogXCJTb25hciBQcm9cIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwicHJpbWUtaW50ZWxsZWN0L2ludGVsbGVjdC0zXCI6IHtcblx0XHRcdGlkOiBcInByaW1lLWludGVsbGVjdC9pbnRlbGxlY3QtM1wiLFxuXHRcdFx0bmFtZTogXCJJTlRFTExFQ1QgM1wiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRvdXRwdXQ6IDEuMSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogMTMxMDcyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwieGFpL2dyb2stM1wiOiB7XG5cdFx0XHRpZDogXCJ4YWkvZ3Jvay0zXCIsXG5cdFx0XHRuYW1lOiBcIkdyb2sgMyBCZXRhXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAzLFxuXHRcdFx0XHRvdXRwdXQ6IDE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiAxMzEwNzIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJ4YWkvZ3Jvay0zLWZhc3RcIjoge1xuXHRcdFx0aWQ6IFwieGFpL2dyb2stMy1mYXN0XCIsXG5cdFx0XHRuYW1lOiBcIkdyb2sgMyBGYXN0IEJldGFcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDUsXG5cdFx0XHRcdG91dHB1dDogMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMS4yNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTA3Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcInhhaS9ncm9rLTMtbWluaVwiOiB7XG5cdFx0XHRpZDogXCJ4YWkvZ3Jvay0zLW1pbmlcIixcblx0XHRcdG5hbWU6IFwiR3JvayAzIE1pbmkgQmV0YVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zLFxuXHRcdFx0XHRvdXRwdXQ6IDAuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA3NSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTA3Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcInhhaS9ncm9rLTMtbWluaS1mYXN0XCI6IHtcblx0XHRcdGlkOiBcInhhaS9ncm9rLTMtbWluaS1mYXN0XCIsXG5cdFx0XHRuYW1lOiBcIkdyb2sgMyBNaW5pIEZhc3QgQmV0YVwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC42LFxuXHRcdFx0XHRvdXRwdXQ6IDQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTA3Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcInhhaS9ncm9rLTRcIjoge1xuXHRcdFx0aWQ6IFwieGFpL2dyb2stNFwiLFxuXHRcdFx0bmFtZTogXCJHcm9rIDRcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAzLFxuXHRcdFx0XHRvdXRwdXQ6IDE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjU2MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAyNTYwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJ4YWkvZ3Jvay00LWZhc3Qtbm9uLXJlYXNvbmluZ1wiOiB7XG5cdFx0XHRpZDogXCJ4YWkvZ3Jvay00LWZhc3Qtbm9uLXJlYXNvbmluZ1wiLFxuXHRcdFx0bmFtZTogXCJHcm9rIDQgRmFzdCBOb24tUmVhc29uaW5nXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA0OTk5OTk5OTk5OTk5OTk5Nixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAyNTYwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJ4YWkvZ3Jvay00LWZhc3QtcmVhc29uaW5nXCI6IHtcblx0XHRcdGlkOiBcInhhaS9ncm9rLTQtZmFzdC1yZWFzb25pbmdcIixcblx0XHRcdG5hbWU6IFwiR3JvayA0IEZhc3QgUmVhc29uaW5nXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdG91dHB1dDogMC41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDQ5OTk5OTk5OTk5OTk5OTk2LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDI1NjAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcInhhaS9ncm9rLTQuMS1mYXN0LW5vbi1yZWFzb25pbmdcIjoge1xuXHRcdFx0aWQ6IFwieGFpL2dyb2stNC4xLWZhc3Qtbm9uLXJlYXNvbmluZ1wiLFxuXHRcdFx0bmFtZTogXCJHcm9rIDQuMSBGYXN0IE5vbi1SZWFzb25pbmdcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdG91dHB1dDogMC41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDQ5OTk5OTk5OTk5OTk5OTk2LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDMwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwieGFpL2dyb2stNC4xLWZhc3QtcmVhc29uaW5nXCI6IHtcblx0XHRcdGlkOiBcInhhaS9ncm9rLTQuMS1mYXN0LXJlYXNvbmluZ1wiLFxuXHRcdFx0bmFtZTogXCJHcm9rIDQuMSBGYXN0IFJlYXNvbmluZ1wiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA0OTk5OTk5OTk5OTk5OTk5Nixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAzMDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcInhhaS9ncm9rLTQuMjAtbXVsdGktYWdlbnRcIjoge1xuXHRcdFx0aWQ6IFwieGFpL2dyb2stNC4yMC1tdWx0aS1hZ2VudFwiLFxuXHRcdFx0bmFtZTogXCJHcm9rIDQuMjAgTXVsdGktQWdlbnRcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMixcblx0XHRcdFx0b3V0cHV0OiA2LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwMCxcblx0XHRcdG1heFRva2VuczogMjAwMDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcInhhaS9ncm9rLTQuMjAtbXVsdGktYWdlbnQtYmV0YVwiOiB7XG5cdFx0XHRpZDogXCJ4YWkvZ3Jvay00LjIwLW11bHRpLWFnZW50LWJldGFcIixcblx0XHRcdG5hbWU6IFwiR3JvayA0LjIwIE11bHRpIEFnZW50IEJldGFcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMixcblx0XHRcdFx0b3V0cHV0OiA2LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwMCxcblx0XHRcdG1heFRva2VuczogMjAwMDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcInhhaS9ncm9rLTQuMjAtbm9uLXJlYXNvbmluZ1wiOiB7XG5cdFx0XHRpZDogXCJ4YWkvZ3Jvay00LjIwLW5vbi1yZWFzb25pbmdcIixcblx0XHRcdG5hbWU6IFwiR3JvayA0LjIwIE5vbi1SZWFzb25pbmdcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMixcblx0XHRcdFx0b3V0cHV0OiA2LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwMCxcblx0XHRcdG1heFRva2VuczogMjAwMDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcInhhaS9ncm9rLTQuMjAtbm9uLXJlYXNvbmluZy1iZXRhXCI6IHtcblx0XHRcdGlkOiBcInhhaS9ncm9rLTQuMjAtbm9uLXJlYXNvbmluZy1iZXRhXCIsXG5cdFx0XHRuYW1lOiBcIkdyb2sgNC4yMCBCZXRhIE5vbi1SZWFzb25pbmdcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMixcblx0XHRcdFx0b3V0cHV0OiA2LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwMCxcblx0XHRcdG1heFRva2VuczogMjAwMDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcInhhaS9ncm9rLTQuMjAtcmVhc29uaW5nXCI6IHtcblx0XHRcdGlkOiBcInhhaS9ncm9rLTQuMjAtcmVhc29uaW5nXCIsXG5cdFx0XHRuYW1lOiBcIkdyb2sgNC4yMCBSZWFzb25pbmdcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLFxuXHRcdFx0XHRvdXRwdXQ6IDYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xOTk5OTk5OTk5OTk5OTk5OCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAyMDAwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwieGFpL2dyb2stNC4yMC1yZWFzb25pbmctYmV0YVwiOiB7XG5cdFx0XHRpZDogXCJ4YWkvZ3Jvay00LjIwLXJlYXNvbmluZy1iZXRhXCIsXG5cdFx0XHRuYW1lOiBcIkdyb2sgNC4yMCBCZXRhIFJlYXNvbmluZ1wiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIsXG5cdFx0XHRcdG91dHB1dDogNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDIwMDAwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJ4YWkvZ3Jvay1jb2RlLWZhc3QtMVwiOiB7XG5cdFx0XHRpZDogXCJ4YWkvZ3Jvay1jb2RlLWZhc3QtMVwiLFxuXHRcdFx0bmFtZTogXCJHcm9rIENvZGUgRmFzdCAxXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdG91dHB1dDogMS41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDIsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjU2MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAyNTYwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJ4aWFvbWkvbWltby12Mi1mbGFzaFwiOiB7XG5cdFx0XHRpZDogXCJ4aWFvbWkvbWltby12Mi1mbGFzaFwiLFxuXHRcdFx0bmFtZTogXCJNaU1vIFYyIEZsYXNoXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDksXG5cdFx0XHRcdG91dHB1dDogMC4yOSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA0NSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIxNDQsXG5cdFx0XHRtYXhUb2tlbnM6IDMyMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwieGlhb21pL21pbW8tdjItcHJvXCI6IHtcblx0XHRcdGlkOiBcInhpYW9taS9taW1vLXYyLXByb1wiLFxuXHRcdFx0bmFtZTogXCJNaU1vIFYyIFByb1wiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLFxuXHRcdFx0XHRvdXRwdXQ6IDMsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xOTk5OTk5OTk5OTk5OTk5OCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJ6YWkvZ2xtLTQuNVwiOiB7XG5cdFx0XHRpZDogXCJ6YWkvZ2xtLTQuNVwiLFxuXHRcdFx0bmFtZTogXCJHTE0tNC41XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNixcblx0XHRcdFx0b3V0cHV0OiAyLjIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDk2MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiemFpL2dsbS00LjUtYWlyXCI6IHtcblx0XHRcdGlkOiBcInphaS9nbG0tNC41LWFpclwiLFxuXHRcdFx0bmFtZTogXCJHTE0gNC41IEFpclwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRvdXRwdXQ6IDEuMSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAzLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogOTYwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJ6YWkvZ2xtLTQuNXZcIjoge1xuXHRcdFx0aWQ6IFwiemFpL2dsbS00LjV2XCIsXG5cdFx0XHRuYW1lOiBcIkdMTSA0LjVWXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNixcblx0XHRcdFx0b3V0cHV0OiAxLjc5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA2NjAwMCxcblx0XHRcdG1heFRva2VuczogMTYwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJ6YWkvZ2xtLTQuNlwiOiB7XG5cdFx0XHRpZDogXCJ6YWkvZ2xtLTQuNlwiLFxuXHRcdFx0bmFtZTogXCJHTE0gNC42XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNixcblx0XHRcdFx0b3V0cHV0OiAyLjIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDk2MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiemFpL2dsbS00LjZ2XCI6IHtcblx0XHRcdGlkOiBcInphaS9nbG0tNC42dlwiLFxuXHRcdFx0bmFtZTogXCJHTE0tNC42VlwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMyxcblx0XHRcdFx0b3V0cHV0OiAwLjg5OTk5OTk5OTk5OTk5OTksXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wNDk5OTk5OTk5OTk5OTk5OTYsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAyNDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcInphaS9nbG0tNC42di1mbGFzaFwiOiB7XG5cdFx0XHRpZDogXCJ6YWkvZ2xtLTQuNnYtZmxhc2hcIixcblx0XHRcdG5hbWU6IFwiR0xNLTQuNlYtRmxhc2hcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDI0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiemFpL2dsbS00LjdcIjoge1xuXHRcdFx0aWQ6IFwiemFpL2dsbS00LjdcIixcblx0XHRcdG5hbWU6IFwiR0xNIDQuN1wiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDIuNzUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMi4yNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiemFpL2dsbS00LjctZmxhc2hcIjoge1xuXHRcdFx0aWQ6IFwiemFpL2dsbS00LjctZmxhc2hcIixcblx0XHRcdG5hbWU6IFwiR0xNIDQuNyBGbGFzaFwiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA3LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImFudGhyb3BpYy1tZXNzYWdlc1wiPixcblx0XHRcInphaS9nbG0tNC43LWZsYXNoeFwiOiB7XG5cdFx0XHRpZDogXCJ6YWkvZ2xtLTQuNy1mbGFzaHhcIixcblx0XHRcdG5hbWU6IFwiR0xNIDQuNyBGbGFzaFhcIixcblx0XHRcdGFwaTogXCJhbnRocm9waWMtbWVzc2FnZXNcIixcblx0XHRcdHByb3ZpZGVyOiBcInZlcmNlbC1haS1nYXRld2F5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYWktZ2F0ZXdheS52ZXJjZWwuc2hcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNixcblx0XHRcdFx0b3V0cHV0OiAwLjM5OTk5OTk5OTk5OTk5OTk3LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDEsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJ6YWkvZ2xtLTVcIjoge1xuXHRcdFx0aWQ6IFwiemFpL2dsbS01XCIsXG5cdFx0XHRuYW1lOiBcIkdMTSA1XCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEsXG5cdFx0XHRcdG91dHB1dDogMy4xOTk5OTk5OTk5OTk5OTk3LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAyODAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMzExMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJ6YWkvZ2xtLTUtdHVyYm9cIjoge1xuXHRcdFx0aWQ6IFwiemFpL2dsbS01LXR1cmJvXCIsXG5cdFx0XHRuYW1lOiBcIkdMTSA1IFR1cmJvXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMixcblx0XHRcdFx0b3V0cHV0OiA0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMjQsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAyODAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMzExMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdFx0XCJ6YWkvZ2xtLTUuMVwiOiB7XG5cdFx0XHRpZDogXCJ6YWkvZ2xtLTUuMVwiLFxuXHRcdFx0bmFtZTogXCJHTE0gNS4xXCIsXG5cdFx0XHRhcGk6IFwiYW50aHJvcGljLW1lc3NhZ2VzXCIsXG5cdFx0XHRwcm92aWRlcjogXCJ2ZXJjZWwtYWktZ2F0ZXdheVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2FpLWdhdGV3YXkudmVyY2VsLnNoXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuNCxcblx0XHRcdFx0b3V0cHV0OiA0LjQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4yNixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDI4MDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYW50aHJvcGljLW1lc3NhZ2VzXCI+LFxuXHRcdFwiemFpL2dsbS01di10dXJib1wiOiB7XG5cdFx0XHRpZDogXCJ6YWkvZ2xtLTV2LXR1cmJvXCIsXG5cdFx0XHRuYW1lOiBcIkdMTSA1ViBUdXJib1wiLFxuXHRcdFx0YXBpOiBcImFudGhyb3BpYy1tZXNzYWdlc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwidmVyY2VsLWFpLWdhdGV3YXlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9haS1nYXRld2F5LnZlcmNlbC5zaFwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMixcblx0XHRcdFx0b3V0cHV0OiA0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMjQsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJhbnRocm9waWMtbWVzc2FnZXNcIj4sXG5cdH0gYXMgY29uc3Qgc2F0aXNmaWVzIFJlY29yZDxzdHJpbmcsIE1vZGVsPGFueT4+O1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBS08sTUFBTSwyQkFBMkI7QUFBQSxFQUN0QyxzQkFBc0I7QUFBQSxJQUNyQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx1QkFBdUI7QUFBQSxJQUN0QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxzQkFBc0I7QUFBQSxJQUNyQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEs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
