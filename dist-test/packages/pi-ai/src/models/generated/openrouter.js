const OPENROUTER_MODELS = {
  "ai21/jamba-large-1.7": {
    id: "ai21/jamba-large-1.7",
    name: "AI21: Jamba Large 1.7",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 2,
      output: 8,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 4096
  },
  "alibaba/tongyi-deepresearch-30b-a3b": {
    id: "alibaba/tongyi-deepresearch-30b-a3b",
    name: "Tongyi DeepResearch 30B A3B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.09,
      output: 0.44999999999999996,
      cacheRead: 0.09,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 131072
  },
  "allenai/olmo-3.1-32b-instruct": {
    id: "allenai/olmo-3.1-32b-instruct",
    name: "AllenAI: Olmo 3.1 32B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.19999999999999998,
      output: 0.6,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 65536,
    maxTokens: 4096
  },
  "amazon/nova-2-lite-v1": {
    id: "amazon/nova-2-lite-v1",
    name: "Amazon: Nova 2 Lite",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.3,
      output: 2.5,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 65535
  },
  "amazon/nova-lite-v1": {
    id: "amazon/nova-lite-v1",
    name: "Amazon: Nova Lite 1.0",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.06,
      output: 0.24,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 3e5,
    maxTokens: 5120
  },
  "amazon/nova-micro-v1": {
    id: "amazon/nova-micro-v1",
    name: "Amazon: Nova Micro 1.0",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.035,
      output: 0.14,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 5120
  },
  "amazon/nova-premier-v1": {
    id: "amazon/nova-premier-v1",
    name: "Amazon: Nova Premier 1.0",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 2.5,
      output: 12.5,
      cacheRead: 0.625,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 32e3
  },
  "amazon/nova-pro-v1": {
    id: "amazon/nova-pro-v1",
    name: "Amazon: Nova Pro 1.0",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.7999999999999999,
      output: 3.1999999999999997,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 3e5,
    maxTokens: 5120
  },
  "anthropic/claude-3-haiku": {
    id: "anthropic/claude-3-haiku",
    name: "Anthropic: Claude 3 Haiku",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "Anthropic: Claude 3.5 Haiku",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "Anthropic: Claude 3.7 Sonnet",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75
    },
    contextWindow: 2e5,
    maxTokens: 128e3
  },
  "anthropic/claude-3.7-sonnet:thinking": {
    id: "anthropic/claude-3.7-sonnet:thinking",
    name: "Anthropic: Claude 3.7 Sonnet (thinking)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "anthropic/claude-haiku-4.5": {
    id: "anthropic/claude-haiku-4.5",
    name: "Anthropic: Claude Haiku 4.5",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "Anthropic: Claude Opus 4",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "Anthropic: Claude Opus 4.1",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "Anthropic: Claude Opus 4.5",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "Anthropic: Claude Opus 4.6",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "anthropic/claude-opus-4.7": {
    id: "anthropic/claude-opus-4.7",
    name: "Anthropic: Claude Opus 4.7",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "anthropic/claude-opus-4.6-fast": {
    id: "anthropic/claude-opus-4.6-fast",
    name: "Anthropic: Claude Opus 4.6 (Fast)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 30,
      output: 150,
      cacheRead: 3,
      cacheWrite: 37.5
    },
    contextWindow: 1e6,
    maxTokens: 128e3
  },
  "anthropic/claude-sonnet-4": {
    id: "anthropic/claude-sonnet-4",
    name: "Anthropic: Claude Sonnet 4",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "Anthropic: Claude Sonnet 4.5",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "Anthropic: Claude Sonnet 4.6",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "arcee-ai/trinity-large-preview:free": {
    id: "arcee-ai/trinity-large-preview:free",
    name: "Arcee AI: Trinity Large Preview (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131e3,
    maxTokens: 4096
  },
  "arcee-ai/trinity-large-thinking": {
    id: "arcee-ai/trinity-large-thinking",
    name: "Arcee AI: Trinity Large Thinking",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.22,
      output: 0.85,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 262144
  },
  "arcee-ai/trinity-mini": {
    id: "arcee-ai/trinity-mini",
    name: "Arcee AI: Trinity Mini",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.045,
      output: 0.15,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 131072
  },
  "arcee-ai/virtuoso-large": {
    id: "arcee-ai/virtuoso-large",
    name: "Arcee AI: Virtuoso Large",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.75,
      output: 1.2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 64e3
  },
  "auto": {
    id: "auto",
    name: "Auto",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 2e6,
    maxTokens: 3e4
  },
  "baidu/ernie-4.5-21b-a3b": {
    id: "baidu/ernie-4.5-21b-a3b",
    name: "Baidu: ERNIE 4.5 21B A3B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.07,
      output: 0.28,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 12e4,
    maxTokens: 8e3
  },
  "baidu/ernie-4.5-vl-28b-a3b": {
    id: "baidu/ernie-4.5-vl-28b-a3b",
    name: "Baidu: ERNIE 4.5 VL 28B A3B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.14,
      output: 0.56,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 3e4,
    maxTokens: 8e3
  },
  "bytedance-seed/seed-1.6": {
    id: "bytedance-seed/seed-1.6",
    name: "ByteDance Seed: Seed 1.6",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.25,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 32768
  },
  "bytedance-seed/seed-1.6-flash": {
    id: "bytedance-seed/seed-1.6-flash",
    name: "ByteDance Seed: Seed 1.6 Flash",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.075,
      output: 0.3,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 32768
  },
  "bytedance-seed/seed-2.0-lite": {
    id: "bytedance-seed/seed-2.0-lite",
    name: "ByteDance Seed: Seed-2.0-Lite",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.25,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 131072
  },
  "bytedance-seed/seed-2.0-mini": {
    id: "bytedance-seed/seed-2.0-mini",
    name: "ByteDance Seed: Seed-2.0-Mini",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.09999999999999999,
      output: 0.39999999999999997,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 131072
  },
  "cohere/command-r-08-2024": {
    id: "cohere/command-r-08-2024",
    name: "Cohere: Command R (08-2024)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4e3
  },
  "cohere/command-r-plus-08-2024": {
    id: "cohere/command-r-plus-08-2024",
    name: "Cohere: Command R+ (08-2024)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 2.5,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4e3
  },
  "deepseek/deepseek-chat": {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek: DeepSeek V3",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.32,
      output: 0.8899999999999999,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 163840,
    maxTokens: 163840
  },
  "deepseek/deepseek-chat-v3-0324": {
    id: "deepseek/deepseek-chat-v3-0324",
    name: "DeepSeek: DeepSeek V3 0324",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.19999999999999998,
      output: 0.77,
      cacheRead: 0.135,
      cacheWrite: 0
    },
    contextWindow: 163840,
    maxTokens: 4096
  },
  "deepseek/deepseek-chat-v3.1": {
    id: "deepseek/deepseek-chat-v3.1",
    name: "DeepSeek: DeepSeek V3.1",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.75,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 32768,
    maxTokens: 7168
  },
  "deepseek/deepseek-r1": {
    id: "deepseek/deepseek-r1",
    name: "DeepSeek: R1",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.7,
      output: 2.5,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 64e3,
    maxTokens: 16e3
  },
  "deepseek/deepseek-r1-0528": {
    id: "deepseek/deepseek-r1-0528",
    name: "DeepSeek: R1 0528",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.5,
      output: 2.1500000000000004,
      cacheRead: 0.35,
      cacheWrite: 0
    },
    contextWindow: 163840,
    maxTokens: 4096
  },
  "deepseek/deepseek-v3.1-terminus": {
    id: "deepseek/deepseek-v3.1-terminus",
    name: "DeepSeek: DeepSeek V3.1 Terminus",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.21,
      output: 0.7899999999999999,
      cacheRead: 0.1300000002,
      cacheWrite: 0
    },
    contextWindow: 163840,
    maxTokens: 4096
  },
  "deepseek/deepseek-v3.2": {
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek: DeepSeek V3.2",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.26,
      output: 0.38,
      cacheRead: 0.13,
      cacheWrite: 0
    },
    contextWindow: 163840,
    maxTokens: 4096
  },
  "deepseek/deepseek-v3.2-exp": {
    id: "deepseek/deepseek-v3.2-exp",
    name: "DeepSeek: DeepSeek V3.2 Exp",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.27,
      output: 0.41,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 163840,
    maxTokens: 65536
  },
  "essentialai/rnj-1-instruct": {
    id: "essentialai/rnj-1-instruct",
    name: "EssentialAI: Rnj 1 Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.15,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 32768,
    maxTokens: 4096
  },
  "google/gemini-2.0-flash-001": {
    id: "google/gemini-2.0-flash-001",
    name: "Google: Gemini 2.0 Flash",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.09999999999999999,
      output: 0.39999999999999997,
      cacheRead: 0.024999999999999998,
      cacheWrite: 0.08333333333333334
    },
    contextWindow: 1048576,
    maxTokens: 8192
  },
  "google/gemini-2.0-flash-lite-001": {
    id: "google/gemini-2.0-flash-lite-001",
    name: "Google: Gemini 2.0 Flash Lite",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.075,
      output: 0.3,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 8192
  },
  "google/gemini-2.5-flash": {
    id: "google/gemini-2.5-flash",
    name: "Google: Gemini 2.5 Flash",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.3,
      output: 2.5,
      cacheRead: 0.03,
      cacheWrite: 0.08333333333333334
    },
    contextWindow: 1048576,
    maxTokens: 65535
  },
  "google/gemini-2.5-flash-lite": {
    id: "google/gemini-2.5-flash-lite",
    name: "Google: Gemini 2.5 Flash Lite",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.09999999999999999,
      output: 0.39999999999999997,
      cacheRead: 0.01,
      cacheWrite: 0.08333333333333334
    },
    contextWindow: 1048576,
    maxTokens: 65535
  },
  "google/gemini-2.5-flash-lite-preview-09-2025": {
    id: "google/gemini-2.5-flash-lite-preview-09-2025",
    name: "Google: Gemini 2.5 Flash Lite Preview 09-2025",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.09999999999999999,
      output: 0.39999999999999997,
      cacheRead: 0.01,
      cacheWrite: 0.08333333333333334
    },
    contextWindow: 1048576,
    maxTokens: 65535
  },
  "google/gemini-2.5-pro": {
    id: "google/gemini-2.5-pro",
    name: "Google: Gemini 2.5 Pro",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      cacheWrite: 0.375
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "google/gemini-2.5-pro-preview": {
    id: "google/gemini-2.5-pro-preview",
    name: "Google: Gemini 2.5 Pro Preview 06-05",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      cacheWrite: 0.375
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "google/gemini-2.5-pro-preview-05-06": {
    id: "google/gemini-2.5-pro-preview-05-06",
    name: "Google: Gemini 2.5 Pro Preview 05-06",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      cacheWrite: 0.375
    },
    contextWindow: 1048576,
    maxTokens: 65535
  },
  "google/gemini-3-flash-preview": {
    id: "google/gemini-3-flash-preview",
    name: "Google: Gemini 3 Flash Preview",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.5,
      output: 3,
      cacheRead: 0.049999999999999996,
      cacheWrite: 0.08333333333333334
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "google/gemini-3.1-flash-lite-preview": {
    id: "google/gemini-3.1-flash-lite-preview",
    name: "Google: Gemini 3.1 Flash Lite Preview",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.25,
      output: 1.5,
      cacheRead: 0.024999999999999998,
      cacheWrite: 0.08333333333333334
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "google/gemini-3.1-pro-preview": {
    id: "google/gemini-3.1-pro-preview",
    name: "Google: Gemini 3.1 Pro Preview",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 12,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0.375
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "google/gemini-3.1-pro-preview-customtools": {
    id: "google/gemini-3.1-pro-preview-customtools",
    name: "Google: Gemini 3.1 Pro Preview Custom Tools",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 12,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0.375
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "google/gemma-4-26b-a4b-it": {
    id: "google/gemma-4-26b-a4b-it",
    name: "Google: Gemma 4 26B A4B ",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.12,
      output: 0.39999999999999997,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 262144
  },
  "google/gemma-4-26b-a4b-it:free": {
    id: "google/gemma-4-26b-a4b-it:free",
    name: "Google: Gemma 4 26B A4B  (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 32768
  },
  "google/gemma-4-31b-it": {
    id: "google/gemma-4-31b-it",
    name: "Google: Gemma 4 31B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
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
  "google/gemma-4-31b-it:free": {
    id: "google/gemma-4-31b-it:free",
    name: "Google: Gemma 4 31B (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 32768
  },
  "inception/mercury": {
    id: "inception/mercury",
    name: "Inception: Mercury",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.25,
      output: 0.75,
      cacheRead: 0.024999999999999998,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 32e3
  },
  "inception/mercury-2": {
    id: "inception/mercury-2",
    name: "Inception: Mercury 2",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.25,
      output: 0.75,
      cacheRead: 0.024999999999999998,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 5e4
  },
  "inception/mercury-coder": {
    id: "inception/mercury-coder",
    name: "Inception: Mercury Coder",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.25,
      output: 0.75,
      cacheRead: 0.024999999999999998,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 32e3
  },
  "kwaipilot/kat-coder-pro-v2": {
    id: "kwaipilot/kat-coder-pro-v2",
    name: "Kwaipilot: KAT-Coder-Pro V2",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.06,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 8e4
  },
  "meituan/longcat-flash-chat": {
    id: "meituan/longcat-flash-chat",
    name: "Meituan: LongCat Flash Chat",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.19999999999999998,
      output: 0.7999999999999999,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 131072
  },
  "meta-llama/llama-3-8b-instruct": {
    id: "meta-llama/llama-3-8b-instruct",
    name: "Meta: Llama 3 8B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.03,
      output: 0.04,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 8192,
    maxTokens: 16384
  },
  "meta-llama/llama-3.1-70b-instruct": {
    id: "meta-llama/llama-3.1-70b-instruct",
    name: "Meta: Llama 3.1 70B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.39999999999999997,
      output: 0.39999999999999997,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "meta-llama/llama-3.1-8b-instruct": {
    id: "meta-llama/llama-3.1-8b-instruct",
    name: "Meta: Llama 3.1 8B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.02,
      output: 0.049999999999999996,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 16384,
    maxTokens: 16384
  },
  "meta-llama/llama-3.3-70b-instruct": {
    id: "meta-llama/llama-3.3-70b-instruct",
    name: "Meta: Llama 3.3 70B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.09999999999999999,
      output: 0.32,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 16384
  },
  "meta-llama/llama-3.3-70b-instruct:free": {
    id: "meta-llama/llama-3.3-70b-instruct:free",
    name: "Meta: Llama 3.3 70B Instruct (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 65536,
    maxTokens: 4096
  },
  "meta-llama/llama-4-maverick": {
    id: "meta-llama/llama-4-maverick",
    name: "Meta: Llama 4 Maverick",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 16384
  },
  "meta-llama/llama-4-scout": {
    id: "meta-llama/llama-4-scout",
    name: "Meta: Llama 4 Scout",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.08,
      output: 0.3,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 327680,
    maxTokens: 16384
  },
  "minimax/minimax-m1": {
    id: "minimax/minimax-m1",
    name: "MiniMax: MiniMax M1",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.39999999999999997,
      output: 2.2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 4e4
  },
  "minimax/minimax-m2": {
    id: "minimax/minimax-m2",
    name: "MiniMax: MiniMax M2",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.255,
      output: 1,
      cacheRead: 0.03,
      cacheWrite: 0
    },
    contextWindow: 196608,
    maxTokens: 196608
  },
  "minimax/minimax-m2.1": {
    id: "minimax/minimax-m2.1",
    name: "MiniMax: MiniMax M2.1",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.29,
      output: 0.95,
      cacheRead: 0.03,
      cacheWrite: 0
    },
    contextWindow: 196608,
    maxTokens: 196608
  },
  "minimax/minimax-m2.5": {
    id: "minimax/minimax-m2.5",
    name: "MiniMax: MiniMax M2.5",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.118,
      output: 0.9900000000000001,
      cacheRead: 0.059,
      cacheWrite: 0
    },
    contextWindow: 196608,
    maxTokens: 65536
  },
  "minimax/minimax-m2.5:free": {
    id: "minimax/minimax-m2.5:free",
    name: "MiniMax: MiniMax M2.5 (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 196608,
    maxTokens: 8192
  },
  "minimax/minimax-m2.7": {
    id: "minimax/minimax-m2.7",
    name: "MiniMax: MiniMax M2.7",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.059,
      cacheWrite: 0
    },
    contextWindow: 196608,
    maxTokens: 4096
  },
  "mistralai/codestral-2508": {
    id: "mistralai/codestral-2508",
    name: "Mistral: Codestral 2508",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 0.8999999999999999,
      cacheRead: 0.03,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 4096
  },
  "mistralai/devstral-2512": {
    id: "mistralai/devstral-2512",
    name: "Mistral: Devstral 2 2512",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.39999999999999997,
      output: 2,
      cacheRead: 0.04,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 4096
  },
  "mistralai/devstral-medium": {
    id: "mistralai/devstral-medium",
    name: "Mistral: Devstral Medium",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.39999999999999997,
      output: 2,
      cacheRead: 0.04,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "mistralai/devstral-small": {
    id: "mistralai/devstral-small",
    name: "Mistral: Devstral Small 1.1",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.09999999999999999,
      output: 0.3,
      cacheRead: 0.01,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "mistralai/ministral-14b-2512": {
    id: "mistralai/ministral-14b-2512",
    name: "Mistral: Ministral 3 14B 2512",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.19999999999999998,
      output: 0.19999999999999998,
      cacheRead: 0.02,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 4096
  },
  "mistralai/ministral-3b-2512": {
    id: "mistralai/ministral-3b-2512",
    name: "Mistral: Ministral 3 3B 2512",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.09999999999999999,
      output: 0.09999999999999999,
      cacheRead: 0.01,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "mistralai/ministral-8b-2512": {
    id: "mistralai/ministral-8b-2512",
    name: "Mistral: Ministral 3 8B 2512",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.15,
      output: 0.15,
      cacheRead: 0.015,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 4096
  },
  "mistralai/mistral-large": {
    id: "mistralai/mistral-large",
    name: "Mistral Large",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "mistralai/mistral-large-2407": {
    id: "mistralai/mistral-large-2407",
    name: "Mistral Large 2407",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "mistralai/mistral-large-2411": {
    id: "mistralai/mistral-large-2411",
    name: "Mistral Large 2411",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "mistralai/mistral-large-2512": {
    id: "mistralai/mistral-large-2512",
    name: "Mistral: Mistral Large 3 2512",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.5,
      output: 1.5,
      cacheRead: 0.049999999999999996,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 4096
  },
  "mistralai/mistral-medium-3": {
    id: "mistralai/mistral-medium-3",
    name: "Mistral: Mistral Medium 3",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.39999999999999997,
      output: 2,
      cacheRead: 0.04,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "mistralai/mistral-medium-3.1": {
    id: "mistralai/mistral-medium-3.1",
    name: "Mistral: Mistral Medium 3.1",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.39999999999999997,
      output: 2,
      cacheRead: 0.04,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "mistralai/mistral-nemo": {
    id: "mistralai/mistral-nemo",
    name: "Mistral: Mistral Nemo",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.02,
      output: 0.04,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 16384
  },
  "mistralai/mistral-saba": {
    id: "mistralai/mistral-saba",
    name: "Mistral: Saba",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.19999999999999998,
      output: 0.6,
      cacheRead: 0.02,
      cacheWrite: 0
    },
    contextWindow: 32768,
    maxTokens: 4096
  },
  "mistralai/mistral-small-2603": {
    id: "mistralai/mistral-small-2603",
    name: "Mistral: Mistral Small 4",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.015,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 4096
  },
  "mistralai/mistral-small-3.2-24b-instruct": {
    id: "mistralai/mistral-small-3.2-24b-instruct",
    name: "Mistral: Mistral Small 3.2 24B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.075,
      output: 0.19999999999999998,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "mistralai/mistral-small-creative": {
    id: "mistralai/mistral-small-creative",
    name: "Mistral: Mistral Small Creative",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.09999999999999999,
      output: 0.3,
      cacheRead: 0.01,
      cacheWrite: 0
    },
    contextWindow: 32768,
    maxTokens: 4096
  },
  "mistralai/mixtral-8x22b-instruct": {
    id: "mistralai/mixtral-8x22b-instruct",
    name: "Mistral: Mixtral 8x22B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 65536,
    maxTokens: 4096
  },
  "mistralai/mixtral-8x7b-instruct": {
    id: "mistralai/mixtral-8x7b-instruct",
    name: "Mistral: Mixtral 8x7B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.54,
      output: 0.54,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 32768,
    maxTokens: 16384
  },
  "mistralai/pixtral-large-2411": {
    id: "mistralai/pixtral-large-2411",
    name: "Mistral: Pixtral Large 2411",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "mistralai/voxtral-small-24b-2507": {
    id: "mistralai/voxtral-small-24b-2507",
    name: "Mistral: Voxtral Small 24B 2507",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.09999999999999999,
      output: 0.3,
      cacheRead: 0.01,
      cacheWrite: 0
    },
    contextWindow: 32e3,
    maxTokens: 4096
  },
  "moonshotai/kimi-k2": {
    id: "moonshotai/kimi-k2",
    name: "MoonshotAI: Kimi K2 0711",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "MoonshotAI: Kimi K2 0905",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.39999999999999997,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 262144
  },
  "moonshotai/kimi-k2-thinking": {
    id: "moonshotai/kimi-k2-thinking",
    name: "MoonshotAI: Kimi K2 Thinking",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.6,
      output: 2.5,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 4096
  },
  "moonshotai/kimi-k2.5": {
    id: "moonshotai/kimi-k2.5",
    name: "MoonshotAI: Kimi K2.5",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.41,
      output: 2.06,
      cacheRead: 0.07,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 4096
  },
  "nex-agi/deepseek-v3.1-nex-n1": {
    id: "nex-agi/deepseek-v3.1-nex-n1",
    name: "Nex AGI: DeepSeek V3.1 Nex N1",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.135,
      output: 0.5,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 163840
  },
  "nvidia/llama-3.1-nemotron-70b-instruct": {
    id: "nvidia/llama-3.1-nemotron-70b-instruct",
    name: "NVIDIA: Llama 3.1 Nemotron 70B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 1.2,
      output: 1.2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 16384
  },
  "nvidia/llama-3.3-nemotron-super-49b-v1.5": {
    id: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    name: "NVIDIA: Llama 3.3 Nemotron Super 49B V1.5",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.09999999999999999,
      output: 0.39999999999999997,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "nvidia/nemotron-3-nano-30b-a3b": {
    id: "nvidia/nemotron-3-nano-30b-a3b",
    name: "NVIDIA: Nemotron 3 Nano 30B A3B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.049999999999999996,
      output: 0.19999999999999998,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 4096
  },
  "nvidia/nemotron-3-nano-30b-a3b:free": {
    id: "nvidia/nemotron-3-nano-30b-a3b:free",
    name: "NVIDIA: Nemotron 3 Nano 30B A3B (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 4096
  },
  "nvidia/nemotron-3-super-120b-a12b": {
    id: "nvidia/nemotron-3-super-120b-a12b",
    name: "NVIDIA: Nemotron 3 Super",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.09999999999999999,
      output: 0.5,
      cacheRead: 0.09999999999999999,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 4096
  },
  "nvidia/nemotron-3-super-120b-a12b:free": {
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    name: "NVIDIA: Nemotron 3 Super (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 262144
  },
  "nvidia/nemotron-nano-12b-v2-vl:free": {
    id: "nvidia/nemotron-nano-12b-v2-vl:free",
    name: "NVIDIA: Nemotron Nano 12B 2 VL (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "nvidia/nemotron-nano-9b-v2": {
    id: "nvidia/nemotron-nano-9b-v2",
    name: "NVIDIA: Nemotron Nano 9B V2",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.04,
      output: 0.16,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "nvidia/nemotron-nano-9b-v2:free": {
    id: "nvidia/nemotron-nano-9b-v2:free",
    name: "NVIDIA: Nemotron Nano 9B V2 (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "openai/gpt-3.5-turbo": {
    id: "openai/gpt-3.5-turbo",
    name: "OpenAI: GPT-3.5 Turbo",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.5,
      output: 1.5,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 16385,
    maxTokens: 4096
  },
  "openai/gpt-3.5-turbo-0613": {
    id: "openai/gpt-3.5-turbo-0613",
    name: "OpenAI: GPT-3.5 Turbo (older v0613)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 4095,
    maxTokens: 4096
  },
  "openai/gpt-3.5-turbo-16k": {
    id: "openai/gpt-3.5-turbo-16k",
    name: "OpenAI: GPT-3.5 Turbo 16k",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 3,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 16385,
    maxTokens: 4096
  },
  "openai/gpt-4": {
    id: "openai/gpt-4",
    name: "OpenAI: GPT-4",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 30,
      output: 60,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 8191,
    maxTokens: 4096
  },
  "openai/gpt-4-0314": {
    id: "openai/gpt-4-0314",
    name: "OpenAI: GPT-4 (older v0314)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 30,
      output: 60,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 8191,
    maxTokens: 4096
  },
  "openai/gpt-4-1106-preview": {
    id: "openai/gpt-4-1106-preview",
    name: "OpenAI: GPT-4 Turbo (older v1106)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 10,
      output: 30,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "openai/gpt-4-turbo": {
    id: "openai/gpt-4-turbo",
    name: "OpenAI: GPT-4 Turbo",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openai/gpt-4-turbo-preview": {
    id: "openai/gpt-4-turbo-preview",
    name: "OpenAI: GPT-4 Turbo Preview",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
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
    name: "OpenAI: GPT-4.1",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 8,
      cacheRead: 0.5,
      cacheWrite: 0
    },
    contextWindow: 1047576,
    maxTokens: 4096
  },
  "openai/gpt-4.1-mini": {
    id: "openai/gpt-4.1-mini",
    name: "OpenAI: GPT-4.1 Mini",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: GPT-4.1 Nano",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: GPT-4o",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 2.5,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  "openai/gpt-4o-2024-05-13": {
    id: "openai/gpt-4o-2024-05-13",
    name: "OpenAI: GPT-4o (2024-05-13)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openai/gpt-4o-2024-08-06": {
    id: "openai/gpt-4o-2024-08-06",
    name: "OpenAI: GPT-4o (2024-08-06)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openai/gpt-4o-2024-11-20": {
    id: "openai/gpt-4o-2024-11-20",
    name: "OpenAI: GPT-4o (2024-11-20)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openai/gpt-4o-audio-preview": {
    id: "openai/gpt-4o-audio-preview",
    name: "OpenAI: GPT-4o Audio",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 2.5,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  "openai/gpt-4o-mini": {
    id: "openai/gpt-4o-mini",
    name: "OpenAI: GPT-4o-mini",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openai/gpt-4o-mini-2024-07-18": {
    id: "openai/gpt-4o-mini-2024-07-18",
    name: "OpenAI: GPT-4o-mini (2024-07-18)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openai/gpt-4o:extended": {
    id: "openai/gpt-4o:extended",
    name: "OpenAI: GPT-4o (extended)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 6,
      output: 18,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 64e3
  },
  "openai/gpt-5": {
    id: "openai/gpt-5",
    name: "OpenAI: GPT-5",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openai/gpt-5-codex": {
    id: "openai/gpt-5-codex",
    name: "OpenAI: GPT-5 Codex",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openai/gpt-5-image": {
    id: "openai/gpt-5-image",
    name: "OpenAI: GPT-5 Image",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 10,
      output: 10,
      cacheRead: 1.25,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "openai/gpt-5-image-mini": {
    id: "openai/gpt-5-image-mini",
    name: "OpenAI: GPT-5 Image Mini",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2.5,
      output: 2,
      cacheRead: 0.25,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "openai/gpt-5-mini": {
    id: "openai/gpt-5-mini",
    name: "OpenAI: GPT-5 Mini",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: GPT-5 Nano",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.049999999999999996,
      output: 0.39999999999999997,
      cacheRead: 0.01,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 4096
  },
  "openai/gpt-5-pro": {
    id: "openai/gpt-5-pro",
    name: "OpenAI: GPT-5 Pro",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 15,
      output: 120,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "openai/gpt-5.1": {
    id: "openai/gpt-5.1",
    name: "OpenAI: GPT-5.1",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openai/gpt-5.1-chat": {
    id: "openai/gpt-5.1-chat",
    name: "OpenAI: GPT-5.1 Chat",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openai/gpt-5.1-codex": {
    id: "openai/gpt-5.1-codex",
    name: "OpenAI: GPT-5.1-Codex",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: GPT-5.1-Codex-Max",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: GPT-5.1-Codex-Mini",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.25,
      output: 2,
      cacheRead: 0.03,
      cacheWrite: 0
    },
    contextWindow: 4e5,
    maxTokens: 128e3
  },
  "openai/gpt-5.2": {
    id: "openai/gpt-5.2",
    name: "OpenAI: GPT-5.2",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: GPT-5.2 Chat",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
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
  "openai/gpt-5.2-codex": {
    id: "openai/gpt-5.2-codex",
    name: "OpenAI: GPT-5.2-Codex",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: GPT-5.2 Pro",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: GPT-5.3 Chat",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openai/gpt-5.3-codex": {
    id: "openai/gpt-5.3-codex",
    name: "OpenAI: GPT-5.3-Codex",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: GPT-5.4",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: GPT-5.4 Mini",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: GPT-5.4 Nano",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: GPT-5.4 Pro",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openai/gpt-audio": {
    id: "openai/gpt-audio",
    name: "OpenAI: GPT Audio",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 2.5,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  "openai/gpt-audio-mini": {
    id: "openai/gpt-audio-mini",
    name: "OpenAI: GPT Audio Mini",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.6,
      output: 2.4,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 16384
  },
  "openai/gpt-oss-120b": {
    id: "openai/gpt-oss-120b",
    name: "OpenAI: gpt-oss-120b",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.039,
      output: 0.19,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "openai/gpt-oss-120b:free": {
    id: "openai/gpt-oss-120b:free",
    name: "OpenAI: gpt-oss-120b (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 131072
  },
  "openai/gpt-oss-20b": {
    id: "openai/gpt-oss-20b",
    name: "OpenAI: gpt-oss-20b",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.03,
      output: 0.14,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "openai/gpt-oss-20b:free": {
    id: "openai/gpt-oss-20b:free",
    name: "OpenAI: gpt-oss-20b (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 8192
  },
  "openai/gpt-oss-safeguard-20b": {
    id: "openai/gpt-oss-safeguard-20b",
    name: "OpenAI: gpt-oss-safeguard-20b",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: o1",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: o3",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: o3 Deep Research",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: o3 Mini",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openai/o3-mini-high": {
    id: "openai/o3-mini-high",
    name: "OpenAI: o3 Mini High",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: o3 Pro",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
    name: "OpenAI: o4 Mini",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openai/o4-mini-deep-research": {
    id: "openai/o4-mini-deep-research",
    name: "OpenAI: o4 Mini Deep Research",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openai/o4-mini-high": {
    id: "openai/o4-mini-high",
    name: "OpenAI: o4 Mini High",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "openrouter/auto": {
    id: "openrouter/auto",
    name: "Auto Router",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: -1e6,
      output: -1e6,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 2e6,
    maxTokens: 4096
  },
  "openrouter/free": {
    id: "openrouter/free",
    name: "Free Models Router",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 4096
  },
  "prime-intellect/intellect-3": {
    id: "prime-intellect/intellect-3",
    name: "Prime Intellect: INTELLECT-3",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
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
  "qwen/qwen-2.5-72b-instruct": {
    id: "qwen/qwen-2.5-72b-instruct",
    name: "Qwen2.5 72B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.12,
      output: 0.39,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 32768,
    maxTokens: 16384
  },
  "qwen/qwen-2.5-7b-instruct": {
    id: "qwen/qwen-2.5-7b-instruct",
    name: "Qwen: Qwen2.5 7B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.04,
      output: 0.09999999999999999,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 32768,
    maxTokens: 32768
  },
  "qwen/qwen-max": {
    id: "qwen/qwen-max",
    name: "Qwen: Qwen-Max ",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 1.04,
      output: 4.16,
      cacheRead: 0.20800000000000002,
      cacheWrite: 0
    },
    contextWindow: 32768,
    maxTokens: 8192
  },
  "qwen/qwen-plus": {
    id: "qwen/qwen-plus",
    name: "Qwen: Qwen-Plus",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.26,
      output: 0.78,
      cacheRead: 0.052000000000000005,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 32768
  },
  "qwen/qwen-plus-2025-07-28": {
    id: "qwen/qwen-plus-2025-07-28",
    name: "Qwen: Qwen Plus 0728",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.26,
      output: 0.78,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 32768
  },
  "qwen/qwen-plus-2025-07-28:thinking": {
    id: "qwen/qwen-plus-2025-07-28:thinking",
    name: "Qwen: Qwen Plus 0728 (thinking)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.26,
      output: 0.78,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 32768
  },
  "qwen/qwen-turbo": {
    id: "qwen/qwen-turbo",
    name: "Qwen: Qwen-Turbo",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.0325,
      output: 0.13,
      cacheRead: 0.006500000000000001,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 8192
  },
  "qwen/qwen-vl-max": {
    id: "qwen/qwen-vl-max",
    name: "Qwen: Qwen VL Max",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.52,
      output: 2.08,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 32768
  },
  "qwen/qwen3-14b": {
    id: "qwen/qwen3-14b",
    name: "Qwen: Qwen3 14B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.06,
      output: 0.24,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 40960,
    maxTokens: 40960
  },
  "qwen/qwen3-235b-a22b": {
    id: "qwen/qwen3-235b-a22b",
    name: "Qwen: Qwen3 235B A22B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.45499999999999996,
      output: 1.8199999999999998,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 8192
  },
  "qwen/qwen3-235b-a22b-2507": {
    id: "qwen/qwen3-235b-a22b-2507",
    name: "Qwen: Qwen3 235B A22B Instruct 2507",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.071,
      output: 0.09999999999999999,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 4096
  },
  "qwen/qwen3-235b-a22b-thinking-2507": {
    id: "qwen/qwen3-235b-a22b-thinking-2507",
    name: "Qwen: Qwen3 235B A22B Thinking 2507",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.14950000000000002,
      output: 1.495,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "qwen/qwen3-30b-a3b": {
    id: "qwen/qwen3-30b-a3b",
    name: "Qwen: Qwen3 30B A3B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.08,
      output: 0.28,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 40960,
    maxTokens: 40960
  },
  "qwen/qwen3-30b-a3b-instruct-2507": {
    id: "qwen/qwen3-30b-a3b-instruct-2507",
    name: "Qwen: Qwen3 30B A3B Instruct 2507",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.09,
      output: 0.3,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 262144
  },
  "qwen/qwen3-30b-a3b-thinking-2507": {
    id: "qwen/qwen3-30b-a3b-thinking-2507",
    name: "Qwen: Qwen3 30B A3B Thinking 2507",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.08,
      output: 0.39999999999999997,
      cacheRead: 0.08,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 131072
  },
  "qwen/qwen3-32b": {
    id: "qwen/qwen3-32b",
    name: "Qwen: Qwen3 32B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.08,
      output: 0.24,
      cacheRead: 0.04,
      cacheWrite: 0
    },
    contextWindow: 40960,
    maxTokens: 40960
  },
  "qwen/qwen3-8b": {
    id: "qwen/qwen3-8b",
    name: "Qwen: Qwen3 8B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.049999999999999996,
      output: 0.39999999999999997,
      cacheRead: 0.049999999999999996,
      cacheWrite: 0
    },
    contextWindow: 40960,
    maxTokens: 8192
  },
  "qwen/qwen3-coder": {
    id: "qwen/qwen3-coder",
    name: "Qwen: Qwen3 Coder 480B A35B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.22,
      output: 1,
      cacheRead: 0.022,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 4096
  },
  "qwen/qwen3-coder-30b-a3b-instruct": {
    id: "qwen/qwen3-coder-30b-a3b-instruct",
    name: "Qwen: Qwen3 Coder 30B A3B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.07,
      output: 0.27,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 16e4,
    maxTokens: 32768
  },
  "qwen/qwen3-coder-flash": {
    id: "qwen/qwen3-coder-flash",
    name: "Qwen: Qwen3 Coder Flash",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.195,
      output: 0.975,
      cacheRead: 0.039,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 65536
  },
  "qwen/qwen3-coder-next": {
    id: "qwen/qwen3-coder-next",
    name: "Qwen: Qwen3 Coder Next",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.7999999999999999,
      cacheRead: 0.12,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 262144
  },
  "qwen/qwen3-coder-plus": {
    id: "qwen/qwen3-coder-plus",
    name: "Qwen: Qwen3 Coder Plus",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.65,
      output: 3.25,
      cacheRead: 0.13,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 65536
  },
  "qwen/qwen3-coder:free": {
    id: "qwen/qwen3-coder:free",
    name: "Qwen: Qwen3 Coder 480B A35B (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262e3,
    maxTokens: 262e3
  },
  "qwen/qwen3-max": {
    id: "qwen/qwen3-max",
    name: "Qwen: Qwen3 Max",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.78,
      output: 3.9,
      cacheRead: 0.156,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 32768
  },
  "qwen/qwen3-max-thinking": {
    id: "qwen/qwen3-max-thinking",
    name: "Qwen: Qwen3 Max Thinking",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.78,
      output: 3.9,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 32768
  },
  "qwen/qwen3-next-80b-a3b-instruct": {
    id: "qwen/qwen3-next-80b-a3b-instruct",
    name: "Qwen: Qwen3 Next 80B A3B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.09,
      output: 1.1,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 4096
  },
  "qwen/qwen3-next-80b-a3b-instruct:free": {
    id: "qwen/qwen3-next-80b-a3b-instruct:free",
    name: "Qwen: Qwen3 Next 80B A3B Instruct (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 4096
  },
  "qwen/qwen3-next-80b-a3b-thinking": {
    id: "qwen/qwen3-next-80b-a3b-thinking",
    name: "Qwen: Qwen3 Next 80B A3B Thinking",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.0975,
      output: 0.78,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 32768
  },
  "qwen/qwen3-vl-235b-a22b-instruct": {
    id: "qwen/qwen3-vl-235b-a22b-instruct",
    name: "Qwen: Qwen3 VL 235B A22B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.19999999999999998,
      output: 0.88,
      cacheRead: 0.11,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 4096
  },
  "qwen/qwen3-vl-235b-a22b-thinking": {
    id: "qwen/qwen3-vl-235b-a22b-thinking",
    name: "Qwen: Qwen3 VL 235B A22B Thinking",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.26,
      output: 2.6,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 32768
  },
  "qwen/qwen3-vl-30b-a3b-instruct": {
    id: "qwen/qwen3-vl-30b-a3b-instruct",
    name: "Qwen: Qwen3 VL 30B A3B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.13,
      output: 0.52,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 32768
  },
  "qwen/qwen3-vl-30b-a3b-thinking": {
    id: "qwen/qwen3-vl-30b-a3b-thinking",
    name: "Qwen: Qwen3 VL 30B A3B Thinking",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.13,
      output: 1.56,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 32768
  },
  "qwen/qwen3-vl-32b-instruct": {
    id: "qwen/qwen3-vl-32b-instruct",
    name: "Qwen: Qwen3 VL 32B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.10400000000000001,
      output: 0.41600000000000004,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 32768
  },
  "qwen/qwen3-vl-8b-instruct": {
    id: "qwen/qwen3-vl-8b-instruct",
    name: "Qwen: Qwen3 VL 8B Instruct",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.08,
      output: 0.5,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 32768
  },
  "qwen/qwen3-vl-8b-thinking": {
    id: "qwen/qwen3-vl-8b-thinking",
    name: "Qwen: Qwen3 VL 8B Thinking",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.117,
      output: 1.365,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 32768
  },
  "qwen/qwen3.5-122b-a10b": {
    id: "qwen/qwen3.5-122b-a10b",
    name: "Qwen: Qwen3.5-122B-A10B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.26,
      output: 2.08,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 65536
  },
  "qwen/qwen3.5-27b": {
    id: "qwen/qwen3.5-27b",
    name: "Qwen: Qwen3.5-27B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.195,
      output: 1.56,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 65536
  },
  "qwen/qwen3.5-35b-a3b": {
    id: "qwen/qwen3.5-35b-a3b",
    name: "Qwen: Qwen3.5-35B-A3B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.1625,
      output: 1.3,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 65536
  },
  "qwen/qwen3.5-397b-a17b": {
    id: "qwen/qwen3.5-397b-a17b",
    name: "Qwen: Qwen3.5 397B A17B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.39,
      output: 2.34,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 65536
  },
  "qwen/qwen3.5-9b": {
    id: "qwen/qwen3.5-9b",
    name: "Qwen: Qwen3.5-9B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.049999999999999996,
      output: 0.15,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 32768
  },
  "qwen/qwen3.5-flash-02-23": {
    id: "qwen/qwen3.5-flash-02-23",
    name: "Qwen: Qwen3.5-Flash",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.065,
      output: 0.26,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 65536
  },
  "qwen/qwen3.5-plus-02-15": {
    id: "qwen/qwen3.5-plus-02-15",
    name: "Qwen: Qwen3.5 Plus 2026-02-15",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.26,
      output: 1.56,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 65536
  },
  "qwen/qwen3.6-plus": {
    id: "qwen/qwen3.6-plus",
    name: "Qwen: Qwen3.6 Plus",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.325,
      output: 1.95,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 65536
  },
  "qwen/qwq-32b": {
    id: "qwen/qwq-32b",
    name: "Qwen: QwQ 32B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.58,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 131072
  },
  "rekaai/reka-edge": {
    id: "rekaai/reka-edge",
    name: "Reka Edge",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.09999999999999999,
      output: 0.09999999999999999,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 16384,
    maxTokens: 16384
  },
  "relace/relace-search": {
    id: "relace/relace-search",
    name: "Relace: Relace Search",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 1,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 128e3
  },
  "sao10k/l3-euryale-70b": {
    id: "sao10k/l3-euryale-70b",
    name: "Sao10k: Llama 3 Euryale 70B v2.1",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 1.48,
      output: 1.48,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 8192,
    maxTokens: 8192
  },
  "sao10k/l3.1-euryale-70b": {
    id: "sao10k/l3.1-euryale-70b",
    name: "Sao10K: Llama 3.1 Euryale 70B v2.2",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.85,
      output: 0.85,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 16384
  },
  "stepfun/step-3.5-flash": {
    id: "stepfun/step-3.5-flash",
    name: "StepFun: Step 3.5 Flash",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.09999999999999999,
      output: 0.3,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 65536
  },
  "thedrummer/rocinante-12b": {
    id: "thedrummer/rocinante-12b",
    name: "TheDrummer: Rocinante 12B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.16999999999999998,
      output: 0.43,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 32768,
    maxTokens: 32768
  },
  "thedrummer/unslopnemo-12b": {
    id: "thedrummer/unslopnemo-12b",
    name: "TheDrummer: UnslopNemo 12B",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.39999999999999997,
      output: 0.39999999999999997,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 32768,
    maxTokens: 32768
  },
  "tngtech/deepseek-r1t2-chimera": {
    id: "tngtech/deepseek-r1t2-chimera",
    name: "TNG: DeepSeek R1T2 Chimera",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 1.1,
      cacheRead: 0.15,
      cacheWrite: 0
    },
    contextWindow: 163840,
    maxTokens: 163840
  },
  "upstage/solar-pro-3": {
    id: "upstage/solar-pro-3",
    name: "Upstage: Solar Pro 3",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.015,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "x-ai/grok-3": {
    id: "x-ai/grok-3",
    name: "xAI: Grok 3",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.75,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "x-ai/grok-3-beta": {
    id: "x-ai/grok-3-beta",
    name: "xAI: Grok 3 Beta",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.75,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "x-ai/grok-3-mini": {
    id: "x-ai/grok-3-mini",
    name: "xAI: Grok 3 Mini",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 0.5,
      cacheRead: 0.075,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "x-ai/grok-3-mini-beta": {
    id: "x-ai/grok-3-mini-beta",
    name: "xAI: Grok 3 Mini Beta",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 0.5,
      cacheRead: 0.075,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 4096
  },
  "x-ai/grok-4": {
    id: "x-ai/grok-4",
    name: "xAI: Grok 4",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.75,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 4096
  },
  "x-ai/grok-4-fast": {
    id: "x-ai/grok-4-fast",
    name: "xAI: Grok 4 Fast",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.19999999999999998,
      output: 0.5,
      cacheRead: 0.049999999999999996,
      cacheWrite: 0
    },
    contextWindow: 2e6,
    maxTokens: 3e4
  },
  "x-ai/grok-4.1-fast": {
    id: "x-ai/grok-4.1-fast",
    name: "xAI: Grok 4.1 Fast",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.19999999999999998,
      output: 0.5,
      cacheRead: 0.049999999999999996,
      cacheWrite: 0
    },
    contextWindow: 2e6,
    maxTokens: 3e4
  },
  "x-ai/grok-4.20": {
    id: "x-ai/grok-4.20",
    name: "xAI: Grok 4.20",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 2e6,
    maxTokens: 4096
  },
  "x-ai/grok-code-fast-1": {
    id: "x-ai/grok-code-fast-1",
    name: "xAI: Grok Code Fast 1",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.19999999999999998,
      output: 1.5,
      cacheRead: 0.02,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 1e4
  },
  "xiaomi/mimo-v2-flash": {
    id: "xiaomi/mimo-v2-flash",
    name: "Xiaomi: MiMo-V2-Flash",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.09,
      output: 0.29,
      cacheRead: 0.045,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 65536
  },
  "xiaomi/mimo-v2-omni": {
    id: "xiaomi/mimo-v2-omni",
    name: "Xiaomi: MiMo-V2-Omni",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.39999999999999997,
      output: 2,
      cacheRead: 0.08,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 65536
  },
  "xiaomi/mimo-v2-pro": {
    id: "xiaomi/mimo-v2-pro",
    name: "Xiaomi: MiMo-V2-Pro",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1,
      output: 3,
      cacheRead: 0.19999999999999998,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 131072
  },
  "z-ai/glm-4-32b": {
    id: "z-ai/glm-4-32b",
    name: "Z.ai: GLM 4 32B ",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.09999999999999999,
      output: 0.09999999999999999,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "z-ai/glm-4.5": {
    id: "z-ai/glm-4.5",
    name: "Z.ai: GLM 4.5",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.6,
      output: 2.2,
      cacheRead: 0.11,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 98304
  },
  "z-ai/glm-4.5-air": {
    id: "z-ai/glm-4.5-air",
    name: "Z.ai: GLM 4.5 Air",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.13,
      output: 0.85,
      cacheRead: 0.024999999999999998,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 98304
  },
  "z-ai/glm-4.5-air:free": {
    id: "z-ai/glm-4.5-air:free",
    name: "Z.ai: GLM 4.5 Air (free)",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 96e3
  },
  "z-ai/glm-4.5v": {
    id: "z-ai/glm-4.5v",
    name: "Z.ai: GLM 4.5V",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.6,
      output: 1.7999999999999998,
      cacheRead: 0.11,
      cacheWrite: 0
    },
    contextWindow: 65536,
    maxTokens: 16384
  },
  "z-ai/glm-4.6": {
    id: "z-ai/glm-4.6",
    name: "Z.ai: GLM 4.6",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.39,
      output: 1.9,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 204800,
    maxTokens: 204800
  },
  "z-ai/glm-4.6v": {
    id: "z-ai/glm-4.6v",
    name: "Z.ai: GLM 4.6V",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.3,
      output: 0.8999999999999999,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 131072
  },
  "z-ai/glm-4.7": {
    id: "z-ai/glm-4.7",
    name: "Z.ai: GLM 4.7",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.39,
      output: 1.75,
      cacheRead: 0.195,
      cacheWrite: 0
    },
    contextWindow: 202752,
    maxTokens: 65535
  },
  "z-ai/glm-4.7-flash": {
    id: "z-ai/glm-4.7-flash",
    name: "Z.ai: GLM 4.7 Flash",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.06,
      output: 0.39999999999999997,
      cacheRead: 0.0100000002,
      cacheWrite: 0
    },
    contextWindow: 202752,
    maxTokens: 4096
  },
  "z-ai/glm-5": {
    id: "z-ai/glm-5",
    name: "Z.ai: GLM 5",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.6,
      output: 1.9,
      cacheRead: 0.119,
      cacheWrite: 0
    },
    contextWindow: 8e4,
    maxTokens: 131072
  },
  "z-ai/glm-5-turbo": {
    id: "z-ai/glm-5-turbo",
    name: "Z.ai: GLM 5 Turbo",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1.2,
      output: 4,
      cacheRead: 0.24,
      cacheWrite: 0
    },
    contextWindow: 202752,
    maxTokens: 131072
  },
  "z-ai/glm-5.1": {
    id: "z-ai/glm-5.1",
    name: "Z.ai: GLM 5.1",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.95,
      output: 3.15,
      cacheRead: 0.475,
      cacheWrite: 0
    },
    contextWindow: 202752,
    maxTokens: 65535
  },
  "z-ai/glm-5v-turbo": {
    id: "z-ai/glm-5v-turbo",
    name: "Z.ai: GLM 5V Turbo",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.2,
      output: 4,
      cacheRead: 0.24,
      cacheWrite: 0
    },
    contextWindow: 202752,
    maxTokens: 131072
  }
};
export {
  OPENROUTER_MODELS
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL21vZGVscy9nZW5lcmF0ZWQvb3BlbnJvdXRlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gVGhpcyBmaWxlIGlzIGF1dG8tZ2VuZXJhdGVkIGJ5IHNjcmlwdHMvZ2VuZXJhdGUtbW9kZWxzLnRzXG4vLyBEbyBub3QgZWRpdCBtYW51YWxseSAtIHJ1biAnbnBtIHJ1biBnZW5lcmF0ZS1tb2RlbHMnIHRvIHVwZGF0ZVxuXG5pbXBvcnQgdHlwZSB7IE1vZGVsIH0gZnJvbSBcIi4uLy4uL3R5cGVzLmpzXCI7XG5cbmV4cG9ydCBjb25zdCBPUEVOUk9VVEVSX01PREVMUyA9IHtcblx0XHRcImFpMjEvamFtYmEtbGFyZ2UtMS43XCI6IHtcblx0XHRcdGlkOiBcImFpMjEvamFtYmEtbGFyZ2UtMS43XCIsXG5cdFx0XHRuYW1lOiBcIkFJMjE6IEphbWJhIExhcmdlIDEuN1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLFxuXHRcdFx0XHRvdXRwdXQ6IDgsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNTYwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJhbGliYWJhL3Rvbmd5aS1kZWVwcmVzZWFyY2gtMzBiLWEzYlwiOiB7XG5cdFx0XHRpZDogXCJhbGliYWJhL3Rvbmd5aS1kZWVwcmVzZWFyY2gtMzBiLWEzYlwiLFxuXHRcdFx0bmFtZTogXCJUb25neWkgRGVlcFJlc2VhcmNoIDMwQiBBM0JcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA5LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNDQ5OTk5OTk5OTk5OTk5OTYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wOSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTA3Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImFsbGVuYWkvb2xtby0zLjEtMzJiLWluc3RydWN0XCI6IHtcblx0XHRcdGlkOiBcImFsbGVuYWkvb2xtby0zLjEtMzJiLWluc3RydWN0XCIsXG5cdFx0XHRuYW1lOiBcIkFsbGVuQUk6IE9sbW8gMy4xIDMyQiBJbnN0cnVjdFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDY1NTM2LFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiYW1hem9uL25vdmEtMi1saXRlLXYxXCI6IHtcblx0XHRcdGlkOiBcImFtYXpvbi9ub3ZhLTItbGl0ZS12MVwiLFxuXHRcdFx0bmFtZTogXCJBbWF6b246IE5vdmEgMiBMaXRlXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjMsXG5cdFx0XHRcdG91dHB1dDogMi41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjU1MzUsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJhbWF6b24vbm92YS1saXRlLXYxXCI6IHtcblx0XHRcdGlkOiBcImFtYXpvbi9ub3ZhLWxpdGUtdjFcIixcblx0XHRcdG5hbWU6IFwiQW1hem9uOiBOb3ZhIExpdGUgMS4wXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNixcblx0XHRcdFx0b3V0cHV0OiAwLjI0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMzAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA1MTIwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiYW1hem9uL25vdmEtbWljcm8tdjFcIjoge1xuXHRcdFx0aWQ6IFwiYW1hem9uL25vdmEtbWljcm8tdjFcIixcblx0XHRcdG5hbWU6IFwiQW1hem9uOiBOb3ZhIE1pY3JvIDEuMFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjAzNSxcblx0XHRcdFx0b3V0cHV0OiAwLjE0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA1MTIwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiYW1hem9uL25vdmEtcHJlbWllci12MVwiOiB7XG5cdFx0XHRpZDogXCJhbWF6b24vbm92YS1wcmVtaWVyLXYxXCIsXG5cdFx0XHRuYW1lOiBcIkFtYXpvbjogTm92YSBQcmVtaWVyIDEuMFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIuNSxcblx0XHRcdFx0b3V0cHV0OiAxMi41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuNjI1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDMyMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiYW1hem9uL25vdmEtcHJvLXYxXCI6IHtcblx0XHRcdGlkOiBcImFtYXpvbi9ub3ZhLXByby12MVwiLFxuXHRcdFx0bmFtZTogXCJBbWF6b246IE5vdmEgUHJvIDEuMFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNzk5OTk5OTk5OTk5OTk5OSxcblx0XHRcdFx0b3V0cHV0OiAzLjE5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAzMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDUxMjAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJhbnRocm9waWMvY2xhdWRlLTMtaGFpa3VcIjoge1xuXHRcdFx0aWQ6IFwiYW50aHJvcGljL2NsYXVkZS0zLWhhaWt1XCIsXG5cdFx0XHRuYW1lOiBcIkFudGhyb3BpYzogQ2xhdWRlIDMgSGFpa3VcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDEuMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMC4zLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImFudGhyb3BpYy9jbGF1ZGUtMy41LWhhaWt1XCI6IHtcblx0XHRcdGlkOiBcImFudGhyb3BpYy9jbGF1ZGUtMy41LWhhaWt1XCIsXG5cdFx0XHRuYW1lOiBcIkFudGhyb3BpYzogQ2xhdWRlIDMuNSBIYWlrdVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNzk5OTk5OTk5OTk5OTk5OSxcblx0XHRcdFx0b3V0cHV0OiA0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDEsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiYW50aHJvcGljL2NsYXVkZS0zLjctc29ubmV0XCI6IHtcblx0XHRcdGlkOiBcImFudGhyb3BpYy9jbGF1ZGUtMy43LXNvbm5ldFwiLFxuXHRcdFx0bmFtZTogXCJBbnRocm9waWM6IENsYXVkZSAzLjcgU29ubmV0XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAzLFxuXHRcdFx0XHRvdXRwdXQ6IDE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMy43NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImFudGhyb3BpYy9jbGF1ZGUtMy43LXNvbm5ldDp0aGlua2luZ1wiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMvY2xhdWRlLTMuNy1zb25uZXQ6dGhpbmtpbmdcIixcblx0XHRcdG5hbWU6IFwiQW50aHJvcGljOiBDbGF1ZGUgMy43IFNvbm5ldCAodGhpbmtpbmcpXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAzLFxuXHRcdFx0XHRvdXRwdXQ6IDE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMy43NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiYW50aHJvcGljL2NsYXVkZS1oYWlrdS00LjVcIjoge1xuXHRcdFx0aWQ6IFwiYW50aHJvcGljL2NsYXVkZS1oYWlrdS00LjVcIixcblx0XHRcdG5hbWU6IFwiQW50aHJvcGljOiBDbGF1ZGUgSGFpa3UgNC41XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLFxuXHRcdFx0XHRvdXRwdXQ6IDUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wOTk5OTk5OTk5OTk5OTk5OSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMS4yNSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiYW50aHJvcGljL2NsYXVkZS1vcHVzLTRcIjoge1xuXHRcdFx0aWQ6IFwiYW50aHJvcGljL2NsYXVkZS1vcHVzLTRcIixcblx0XHRcdG5hbWU6IFwiQW50aHJvcGljOiBDbGF1ZGUgT3B1cyA0XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxNSxcblx0XHRcdFx0b3V0cHV0OiA3NSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAxLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDE4Ljc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMzIwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJhbnRocm9waWMvY2xhdWRlLW9wdXMtNC4xXCI6IHtcblx0XHRcdGlkOiBcImFudGhyb3BpYy9jbGF1ZGUtb3B1cy00LjFcIixcblx0XHRcdG5hbWU6IFwiQW50aHJvcGljOiBDbGF1ZGUgT3B1cyA0LjFcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDE1LFxuXHRcdFx0XHRvdXRwdXQ6IDc1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDEuNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMTguNzUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImFudGhyb3BpYy9jbGF1ZGUtb3B1cy00LjVcIjoge1xuXHRcdFx0aWQ6IFwiYW50aHJvcGljL2NsYXVkZS1vcHVzLTQuNVwiLFxuXHRcdFx0bmFtZTogXCJBbnRocm9waWM6IENsYXVkZSBPcHVzIDQuNVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogNSxcblx0XHRcdFx0b3V0cHV0OiAyNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDYuMjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImFudGhyb3BpYy9jbGF1ZGUtb3B1cy00LjZcIjoge1xuXHRcdFx0aWQ6IFwiYW50aHJvcGljL2NsYXVkZS1vcHVzLTQuNlwiLFxuXHRcdFx0bmFtZTogXCJBbnRocm9waWM6IENsYXVkZSBPcHVzIDQuNlwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogNSxcblx0XHRcdFx0b3V0cHV0OiAyNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDYuMjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiYW50aHJvcGljL2NsYXVkZS1vcHVzLTQuN1wiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMvY2xhdWRlLW9wdXMtNC43XCIsXG5cdFx0XHRuYW1lOiBcIkFudGhyb3BpYzogQ2xhdWRlIE9wdXMgNC43XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiA1LFxuXHRcdFx0XHRvdXRwdXQ6IDI1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogNi4yNSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJhbnRocm9waWMvY2xhdWRlLW9wdXMtNC42LWZhc3RcIjoge1xuXHRcdFx0aWQ6IFwiYW50aHJvcGljL2NsYXVkZS1vcHVzLTQuNi1mYXN0XCIsXG5cdFx0XHRuYW1lOiBcIkFudGhyb3BpYzogQ2xhdWRlIE9wdXMgNC42IChGYXN0KVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMzAsXG5cdFx0XHRcdG91dHB1dDogMTUwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDM3LjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiYW50aHJvcGljL2NsYXVkZS1zb25uZXQtNFwiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMvY2xhdWRlLXNvbm5ldC00XCIsXG5cdFx0XHRuYW1lOiBcIkFudGhyb3BpYzogQ2xhdWRlIFNvbm5ldCA0XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAzLFxuXHRcdFx0XHRvdXRwdXQ6IDE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMy43NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImFudGhyb3BpYy9jbGF1ZGUtc29ubmV0LTQuNVwiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMvY2xhdWRlLXNvbm5ldC00LjVcIixcblx0XHRcdG5hbWU6IFwiQW50aHJvcGljOiBDbGF1ZGUgU29ubmV0IDQuNVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMyxcblx0XHRcdFx0b3V0cHV0OiAxNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDMuNzUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJhbnRocm9waWMvY2xhdWRlLXNvbm5ldC00LjZcIjoge1xuXHRcdFx0aWQ6IFwiYW50aHJvcGljL2NsYXVkZS1zb25uZXQtNC42XCIsXG5cdFx0XHRuYW1lOiBcIkFudGhyb3BpYzogQ2xhdWRlIFNvbm5ldCA0LjZcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDMsXG5cdFx0XHRcdG91dHB1dDogMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4zLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAzLjc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImFyY2VlLWFpL3RyaW5pdHktbGFyZ2UtcHJldmlldzpmcmVlXCI6IHtcblx0XHRcdGlkOiBcImFyY2VlLWFpL3RyaW5pdHktbGFyZ2UtcHJldmlldzpmcmVlXCIsXG5cdFx0XHRuYW1lOiBcIkFyY2VlIEFJOiBUcmluaXR5IExhcmdlIFByZXZpZXcgKGZyZWUpXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTAwMCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImFyY2VlLWFpL3RyaW5pdHktbGFyZ2UtdGhpbmtpbmdcIjoge1xuXHRcdFx0aWQ6IFwiYXJjZWUtYWkvdHJpbml0eS1sYXJnZS10aGlua2luZ1wiLFxuXHRcdFx0bmFtZTogXCJBcmNlZSBBSTogVHJpbml0eSBMYXJnZSBUaGlua2luZ1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjIsXG5cdFx0XHRcdG91dHB1dDogMC44NSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogMjYyMTQ0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiYXJjZWUtYWkvdHJpbml0eS1taW5pXCI6IHtcblx0XHRcdGlkOiBcImFyY2VlLWFpL3RyaW5pdHktbWluaVwiLFxuXHRcdFx0bmFtZTogXCJBcmNlZSBBSTogVHJpbml0eSBNaW5pXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNDUsXG5cdFx0XHRcdG91dHB1dDogMC4xNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogMTMxMDcyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiYXJjZWUtYWkvdmlydHVvc28tbGFyZ2VcIjoge1xuXHRcdFx0aWQ6IFwiYXJjZWUtYWkvdmlydHVvc28tbGFyZ2VcIixcblx0XHRcdG5hbWU6IFwiQXJjZWUgQUk6IFZpcnR1b3NvIExhcmdlXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNzUsXG5cdFx0XHRcdG91dHB1dDogMS4yLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImF1dG9cIjoge1xuXHRcdFx0aWQ6IFwiYXV0b1wiLFxuXHRcdFx0bmFtZTogXCJBdXRvXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAzMDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImJhaWR1L2VybmllLTQuNS0yMWItYTNiXCI6IHtcblx0XHRcdGlkOiBcImJhaWR1L2VybmllLTQuNS0yMWItYTNiXCIsXG5cdFx0XHRuYW1lOiBcIkJhaWR1OiBFUk5JRSA0LjUgMjFCIEEzQlwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA3LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMjgsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJiYWlkdS9lcm5pZS00LjUtdmwtMjhiLWEzYlwiOiB7XG5cdFx0XHRpZDogXCJiYWlkdS9lcm5pZS00LjUtdmwtMjhiLWEzYlwiLFxuXHRcdFx0bmFtZTogXCJCYWlkdTogRVJOSUUgNC41IFZMIDI4QiBBM0JcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTQsXG5cdFx0XHRcdG91dHB1dDogMC41Nixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDMwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiYnl0ZWRhbmNlLXNlZWQvc2VlZC0xLjZcIjoge1xuXHRcdFx0aWQ6IFwiYnl0ZWRhbmNlLXNlZWQvc2VlZC0xLjZcIixcblx0XHRcdG5hbWU6IFwiQnl0ZURhbmNlIFNlZWQ6IFNlZWQgMS42XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIxNDQsXG5cdFx0XHRtYXhUb2tlbnM6IDMyNzY4LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiYnl0ZWRhbmNlLXNlZWQvc2VlZC0xLjYtZmxhc2hcIjoge1xuXHRcdFx0aWQ6IFwiYnl0ZWRhbmNlLXNlZWQvc2VlZC0xLjYtZmxhc2hcIixcblx0XHRcdG5hbWU6IFwiQnl0ZURhbmNlIFNlZWQ6IFNlZWQgMS42IEZsYXNoXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA3NSxcblx0XHRcdFx0b3V0cHV0OiAwLjMsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIxNDQsXG5cdFx0XHRtYXhUb2tlbnM6IDMyNzY4LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiYnl0ZWRhbmNlLXNlZWQvc2VlZC0yLjAtbGl0ZVwiOiB7XG5cdFx0XHRpZDogXCJieXRlZGFuY2Utc2VlZC9zZWVkLTIuMC1saXRlXCIsXG5cdFx0XHRuYW1lOiBcIkJ5dGVEYW5jZSBTZWVkOiBTZWVkLTIuMC1MaXRlXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIxNDQsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTA3Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImJ5dGVkYW5jZS1zZWVkL3NlZWQtMi4wLW1pbmlcIjoge1xuXHRcdFx0aWQ6IFwiYnl0ZWRhbmNlLXNlZWQvc2VlZC0yLjAtbWluaVwiLFxuXHRcdFx0bmFtZTogXCJCeXRlRGFuY2UgU2VlZDogU2VlZC0yLjAtTWluaVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wOTk5OTk5OTk5OTk5OTk5OSxcblx0XHRcdFx0b3V0cHV0OiAwLjM5OTk5OTk5OTk5OTk5OTk3LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTQ0LFxuXHRcdFx0bWF4VG9rZW5zOiAxMzEwNzIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJjb2hlcmUvY29tbWFuZC1yLTA4LTIwMjRcIjoge1xuXHRcdFx0aWQ6IFwiY29oZXJlL2NvbW1hbmQtci0wOC0yMDI0XCIsXG5cdFx0XHRuYW1lOiBcIkNvaGVyZTogQ29tbWFuZCBSICgwOC0yMDI0KVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE1LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogNDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImNvaGVyZS9jb21tYW5kLXItcGx1cy0wOC0yMDI0XCI6IHtcblx0XHRcdGlkOiBcImNvaGVyZS9jb21tYW5kLXItcGx1cy0wOC0yMDI0XCIsXG5cdFx0XHRuYW1lOiBcIkNvaGVyZTogQ29tbWFuZCBSKyAoMDgtMjAyNClcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMi41LFxuXHRcdFx0XHRvdXRwdXQ6IDEwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiZGVlcHNlZWsvZGVlcHNlZWstY2hhdFwiOiB7XG5cdFx0XHRpZDogXCJkZWVwc2Vlay9kZWVwc2Vlay1jaGF0XCIsXG5cdFx0XHRuYW1lOiBcIkRlZXBTZWVrOiBEZWVwU2VlayBWM1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjMyLFxuXHRcdFx0XHRvdXRwdXQ6IDAuODg5OTk5OTk5OTk5OTk5OSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDE2Mzg0MCxcblx0XHRcdG1heFRva2VuczogMTYzODQwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiZGVlcHNlZWsvZGVlcHNlZWstY2hhdC12My0wMzI0XCI6IHtcblx0XHRcdGlkOiBcImRlZXBzZWVrL2RlZXBzZWVrLWNoYXQtdjMtMDMyNFwiLFxuXHRcdFx0bmFtZTogXCJEZWVwU2VlazogRGVlcFNlZWsgVjMgMDMyNFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdG91dHB1dDogMC43Nyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjEzNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxNjM4NDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJkZWVwc2Vlay9kZWVwc2Vlay1jaGF0LXYzLjFcIjoge1xuXHRcdFx0aWQ6IFwiZGVlcHNlZWsvZGVlcHNlZWstY2hhdC12My4xXCIsXG5cdFx0XHRuYW1lOiBcIkRlZXBTZWVrOiBEZWVwU2VlayBWMy4xXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNSxcblx0XHRcdFx0b3V0cHV0OiAwLjc1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMzI3NjgsXG5cdFx0XHRtYXhUb2tlbnM6IDcxNjgsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJkZWVwc2Vlay9kZWVwc2Vlay1yMVwiOiB7XG5cdFx0XHRpZDogXCJkZWVwc2Vlay9kZWVwc2Vlay1yMVwiLFxuXHRcdFx0bmFtZTogXCJEZWVwU2VlazogUjFcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjcsXG5cdFx0XHRcdG91dHB1dDogMi41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNjQwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiZGVlcHNlZWsvZGVlcHNlZWstcjEtMDUyOFwiOiB7XG5cdFx0XHRpZDogXCJkZWVwc2Vlay9kZWVwc2Vlay1yMS0wNTI4XCIsXG5cdFx0XHRuYW1lOiBcIkRlZXBTZWVrOiBSMSAwNTI4XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC41LFxuXHRcdFx0XHRvdXRwdXQ6IDIuMTUwMDAwMDAwMDAwMDAwNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjM1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDE2Mzg0MCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImRlZXBzZWVrL2RlZXBzZWVrLXYzLjEtdGVybWludXNcIjoge1xuXHRcdFx0aWQ6IFwiZGVlcHNlZWsvZGVlcHNlZWstdjMuMS10ZXJtaW51c1wiLFxuXHRcdFx0bmFtZTogXCJEZWVwU2VlazogRGVlcFNlZWsgVjMuMSBUZXJtaW51c1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjEsXG5cdFx0XHRcdG91dHB1dDogMC43ODk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTMwMDAwMDAwMixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxNjM4NDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJkZWVwc2Vlay9kZWVwc2Vlay12My4yXCI6IHtcblx0XHRcdGlkOiBcImRlZXBzZWVrL2RlZXBzZWVrLXYzLjJcIixcblx0XHRcdG5hbWU6IFwiRGVlcFNlZWs6IERlZXBTZWVrIFYzLjJcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI2LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMzgsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxNjM4NDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJkZWVwc2Vlay9kZWVwc2Vlay12My4yLWV4cFwiOiB7XG5cdFx0XHRpZDogXCJkZWVwc2Vlay9kZWVwc2Vlay12My4yLWV4cFwiLFxuXHRcdFx0bmFtZTogXCJEZWVwU2VlazogRGVlcFNlZWsgVjMuMiBFeHBcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI3LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNDEsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxNjM4NDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiZXNzZW50aWFsYWkvcm5qLTEtaW5zdHJ1Y3RcIjoge1xuXHRcdFx0aWQ6IFwiZXNzZW50aWFsYWkvcm5qLTEtaW5zdHJ1Y3RcIixcblx0XHRcdG5hbWU6IFwiRXNzZW50aWFsQUk6IFJuaiAxIEluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTUsXG5cdFx0XHRcdG91dHB1dDogMC4xNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDMyNzY4LFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiZ29vZ2xlL2dlbWluaS0yLjAtZmxhc2gtMDAxXCI6IHtcblx0XHRcdGlkOiBcImdvb2dsZS9nZW1pbmktMi4wLWZsYXNoLTAwMVwiLFxuXHRcdFx0bmFtZTogXCJHb29nbGU6IEdlbWluaSAyLjAgRmxhc2hcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMjQ5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAuMDgzMzMzMzMzMzMzMzMzMzQsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImdvb2dsZS9nZW1pbmktMi4wLWZsYXNoLWxpdGUtMDAxXCI6IHtcblx0XHRcdGlkOiBcImdvb2dsZS9nZW1pbmktMi4wLWZsYXNoLWxpdGUtMDAxXCIsXG5cdFx0XHRuYW1lOiBcIkdvb2dsZTogR2VtaW5pIDIuMCBGbGFzaCBMaXRlXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNzUsXG5cdFx0XHRcdG91dHB1dDogMC4zLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImdvb2dsZS9nZW1pbmktMi41LWZsYXNoXCI6IHtcblx0XHRcdGlkOiBcImdvb2dsZS9nZW1pbmktMi41LWZsYXNoXCIsXG5cdFx0XHRuYW1lOiBcIkdvb2dsZTogR2VtaW5pIDIuNSBGbGFzaFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zLFxuXHRcdFx0XHRvdXRwdXQ6IDIuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAzLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLjA4MzMzMzMzMzMzMzMzMzM0LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM1LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiZ29vZ2xlL2dlbWluaS0yLjUtZmxhc2gtbGl0ZVwiOiB7XG5cdFx0XHRpZDogXCJnb29nbGUvZ2VtaW5pLTIuNS1mbGFzaC1saXRlXCIsXG5cdFx0XHRuYW1lOiBcIkdvb2dsZTogR2VtaW5pIDIuNSBGbGFzaCBMaXRlXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMC4wODMzMzMzMzMzMzMzMzMzNCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNSxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImdvb2dsZS9nZW1pbmktMi41LWZsYXNoLWxpdGUtcHJldmlldy0wOS0yMDI1XCI6IHtcblx0XHRcdGlkOiBcImdvb2dsZS9nZW1pbmktMi41LWZsYXNoLWxpdGUtcHJldmlldy0wOS0yMDI1XCIsXG5cdFx0XHRuYW1lOiBcIkdvb2dsZTogR2VtaW5pIDIuNSBGbGFzaCBMaXRlIFByZXZpZXcgMDktMjAyNVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wOTk5OTk5OTk5OTk5OTk5OSxcblx0XHRcdFx0b3V0cHV0OiAwLjM5OTk5OTk5OTk5OTk5OTk3LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDEsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAuMDgzMzMzMzMzMzMzMzMzMzQsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogNjU1MzUsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJnb29nbGUvZ2VtaW5pLTIuNS1wcm9cIjoge1xuXHRcdFx0aWQ6IFwiZ29vZ2xlL2dlbWluaS0yLjUtcHJvXCIsXG5cdFx0XHRuYW1lOiBcIkdvb2dsZTogR2VtaW5pIDIuNSBQcm9cIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAuMzc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiZ29vZ2xlL2dlbWluaS0yLjUtcHJvLXByZXZpZXdcIjoge1xuXHRcdFx0aWQ6IFwiZ29vZ2xlL2dlbWluaS0yLjUtcHJvLXByZXZpZXdcIixcblx0XHRcdG5hbWU6IFwiR29vZ2xlOiBHZW1pbmkgMi41IFBybyBQcmV2aWV3IDA2LTA1XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDEwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTI1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLjM3NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImdvb2dsZS9nZW1pbmktMi41LXByby1wcmV2aWV3LTA1LTA2XCI6IHtcblx0XHRcdGlkOiBcImdvb2dsZS9nZW1pbmktMi41LXByby1wcmV2aWV3LTA1LTA2XCIsXG5cdFx0XHRuYW1lOiBcIkdvb2dsZTogR2VtaW5pIDIuNSBQcm8gUHJldmlldyAwNS0wNlwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4yNSxcblx0XHRcdFx0b3V0cHV0OiAxMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjEyNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMC4zNzUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogNjU1MzUsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJnb29nbGUvZ2VtaW5pLTMtZmxhc2gtcHJldmlld1wiOiB7XG5cdFx0XHRpZDogXCJnb29nbGUvZ2VtaW5pLTMtZmxhc2gtcHJldmlld1wiLFxuXHRcdFx0bmFtZTogXCJHb29nbGU6IEdlbWluaSAzIEZsYXNoIFByZXZpZXdcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNSxcblx0XHRcdFx0b3V0cHV0OiAzLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDQ5OTk5OTk5OTk5OTk5OTk2LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLjA4MzMzMzMzMzMzMzMzMzM0LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiZ29vZ2xlL2dlbWluaS0zLjEtZmxhc2gtbGl0ZS1wcmV2aWV3XCI6IHtcblx0XHRcdGlkOiBcImdvb2dsZS9nZW1pbmktMy4xLWZsYXNoLWxpdGUtcHJldmlld1wiLFxuXHRcdFx0bmFtZTogXCJHb29nbGU6IEdlbWluaSAzLjEgRmxhc2ggTGl0ZSBQcmV2aWV3XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDEuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAyNDk5OTk5OTk5OTk5OTk5OCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMC4wODMzMzMzMzMzMzMzMzMzNCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImdvb2dsZS9nZW1pbmktMy4xLXByby1wcmV2aWV3XCI6IHtcblx0XHRcdGlkOiBcImdvb2dsZS9nZW1pbmktMy4xLXByby1wcmV2aWV3XCIsXG5cdFx0XHRuYW1lOiBcIkdvb2dsZTogR2VtaW5pIDMuMSBQcm8gUHJldmlld1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMixcblx0XHRcdFx0b3V0cHV0OiAxMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLjM3NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImdvb2dsZS9nZW1pbmktMy4xLXByby1wcmV2aWV3LWN1c3RvbXRvb2xzXCI6IHtcblx0XHRcdGlkOiBcImdvb2dsZS9nZW1pbmktMy4xLXByby1wcmV2aWV3LWN1c3RvbXRvb2xzXCIsXG5cdFx0XHRuYW1lOiBcIkdvb2dsZTogR2VtaW5pIDMuMSBQcm8gUHJldmlldyBDdXN0b20gVG9vbHNcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIsXG5cdFx0XHRcdG91dHB1dDogMTIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xOTk5OTk5OTk5OTk5OTk5OCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMC4zNzUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJnb29nbGUvZ2VtbWEtNC0yNmItYTRiLWl0XCI6IHtcblx0XHRcdGlkOiBcImdvb2dsZS9nZW1tYS00LTI2Yi1hNGItaXRcIixcblx0XHRcdG5hbWU6IFwiR29vZ2xlOiBHZW1tYSA0IDI2QiBBNEIgXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjEyLFxuXHRcdFx0XHRvdXRwdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIxNDQsXG5cdFx0XHRtYXhUb2tlbnM6IDI2MjE0NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImdvb2dsZS9nZW1tYS00LTI2Yi1hNGItaXQ6ZnJlZVwiOiB7XG5cdFx0XHRpZDogXCJnb29nbGUvZ2VtbWEtNC0yNmItYTRiLWl0OmZyZWVcIixcblx0XHRcdG5hbWU6IFwiR29vZ2xlOiBHZW1tYSA0IDI2QiBBNEIgIChmcmVlKVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTQ0LFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImdvb2dsZS9nZW1tYS00LTMxYi1pdFwiOiB7XG5cdFx0XHRpZDogXCJnb29nbGUvZ2VtbWEtNC0zMWItaXRcIixcblx0XHRcdG5hbWU6IFwiR29vZ2xlOiBHZW1tYSA0IDMxQlwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNCxcblx0XHRcdFx0b3V0cHV0OiAwLjM5OTk5OTk5OTk5OTk5OTk3LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTQ0LFxuXHRcdFx0bWF4VG9rZW5zOiAxMzEwNzIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJnb29nbGUvZ2VtbWEtNC0zMWItaXQ6ZnJlZVwiOiB7XG5cdFx0XHRpZDogXCJnb29nbGUvZ2VtbWEtNC0zMWItaXQ6ZnJlZVwiLFxuXHRcdFx0bmFtZTogXCJHb29nbGU6IEdlbW1hIDQgMzFCIChmcmVlKVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTQ0LFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImluY2VwdGlvbi9tZXJjdXJ5XCI6IHtcblx0XHRcdGlkOiBcImluY2VwdGlvbi9tZXJjdXJ5XCIsXG5cdFx0XHRuYW1lOiBcIkluY2VwdGlvbjogTWVyY3VyeVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNzUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMjQ5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcImluY2VwdGlvbi9tZXJjdXJ5LTJcIjoge1xuXHRcdFx0aWQ6IFwiaW5jZXB0aW9uL21lcmN1cnktMlwiLFxuXHRcdFx0bmFtZTogXCJJbmNlcHRpb246IE1lcmN1cnkgMlwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjUsXG5cdFx0XHRcdG91dHB1dDogMC43NSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAyNDk5OTk5OTk5OTk5OTk5OCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDUwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiaW5jZXB0aW9uL21lcmN1cnktY29kZXJcIjoge1xuXHRcdFx0aWQ6IFwiaW5jZXB0aW9uL21lcmN1cnktY29kZXJcIixcblx0XHRcdG5hbWU6IFwiSW5jZXB0aW9uOiBNZXJjdXJ5IENvZGVyXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjUsXG5cdFx0XHRcdG91dHB1dDogMC43NSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAyNDk5OTk5OTk5OTk5OTk5OCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDMyMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwia3dhaXBpbG90L2thdC1jb2Rlci1wcm8tdjJcIjoge1xuXHRcdFx0aWQ6IFwia3dhaXBpbG90L2thdC1jb2Rlci1wcm8tdjJcIixcblx0XHRcdG5hbWU6IFwiS3dhaXBpbG90OiBLQVQtQ29kZXItUHJvIFYyXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMyxcblx0XHRcdFx0b3V0cHV0OiAxLjIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wNixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNTYwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibWVpdHVhbi9sb25nY2F0LWZsYXNoLWNoYXRcIjoge1xuXHRcdFx0aWQ6IFwibWVpdHVhbi9sb25nY2F0LWZsYXNoLWNoYXRcIixcblx0XHRcdG5hbWU6IFwiTWVpdHVhbjogTG9uZ0NhdCBGbGFzaCBDaGF0XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdG91dHB1dDogMC43OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiAxMzEwNzIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJtZXRhLWxsYW1hL2xsYW1hLTMtOGItaW5zdHJ1Y3RcIjoge1xuXHRcdFx0aWQ6IFwibWV0YS1sbGFtYS9sbGFtYS0zLThiLWluc3RydWN0XCIsXG5cdFx0XHRuYW1lOiBcIk1ldGE6IExsYW1hIDMgOEIgSW5zdHJ1Y3RcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wMyxcblx0XHRcdFx0b3V0cHV0OiAwLjA0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogODE5Mixcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJtZXRhLWxsYW1hL2xsYW1hLTMuMS03MGItaW5zdHJ1Y3RcIjoge1xuXHRcdFx0aWQ6IFwibWV0YS1sbGFtYS9sbGFtYS0zLjEtNzBiLWluc3RydWN0XCIsXG5cdFx0XHRuYW1lOiBcIk1ldGE6IExsYW1hIDMuMSA3MEIgSW5zdHJ1Y3RcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zOTk5OTk5OTk5OTk5OTk5Nyxcblx0XHRcdFx0b3V0cHV0OiAwLjM5OTk5OTk5OTk5OTk5OTk3LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibWV0YS1sbGFtYS9sbGFtYS0zLjEtOGItaW5zdHJ1Y3RcIjoge1xuXHRcdFx0aWQ6IFwibWV0YS1sbGFtYS9sbGFtYS0zLjEtOGItaW5zdHJ1Y3RcIixcblx0XHRcdG5hbWU6IFwiTWV0YTogTGxhbWEgMy4xIDhCIEluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDIsXG5cdFx0XHRcdG91dHB1dDogMC4wNDk5OTk5OTk5OTk5OTk5OTYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxNjM4NCxcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJtZXRhLWxsYW1hL2xsYW1hLTMuMy03MGItaW5zdHJ1Y3RcIjoge1xuXHRcdFx0aWQ6IFwibWV0YS1sbGFtYS9sbGFtYS0zLjMtNzBiLWluc3RydWN0XCIsXG5cdFx0XHRuYW1lOiBcIk1ldGE6IExsYW1hIDMuMyA3MEIgSW5zdHJ1Y3RcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wOTk5OTk5OTk5OTk5OTk5OSxcblx0XHRcdFx0b3V0cHV0OiAwLjMyLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiAxNjM4NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm1ldGEtbGxhbWEvbGxhbWEtMy4zLTcwYi1pbnN0cnVjdDpmcmVlXCI6IHtcblx0XHRcdGlkOiBcIm1ldGEtbGxhbWEvbGxhbWEtMy4zLTcwYi1pbnN0cnVjdDpmcmVlXCIsXG5cdFx0XHRuYW1lOiBcIk1ldGE6IExsYW1hIDMuMyA3MEIgSW5zdHJ1Y3QgKGZyZWUpXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDY1NTM2LFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibWV0YS1sbGFtYS9sbGFtYS00LW1hdmVyaWNrXCI6IHtcblx0XHRcdGlkOiBcIm1ldGEtbGxhbWEvbGxhbWEtNC1tYXZlcmlja1wiLFxuXHRcdFx0bmFtZTogXCJNZXRhOiBMbGFtYSA0IE1hdmVyaWNrXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNSxcblx0XHRcdFx0b3V0cHV0OiAwLjYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiAxNjM4NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm1ldGEtbGxhbWEvbGxhbWEtNC1zY291dFwiOiB7XG5cdFx0XHRpZDogXCJtZXRhLWxsYW1hL2xsYW1hLTQtc2NvdXRcIixcblx0XHRcdG5hbWU6IFwiTWV0YTogTGxhbWEgNCBTY291dFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDgsXG5cdFx0XHRcdG91dHB1dDogMC4zLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMzI3NjgwLFxuXHRcdFx0bWF4VG9rZW5zOiAxNjM4NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm1pbmltYXgvbWluaW1heC1tMVwiOiB7XG5cdFx0XHRpZDogXCJtaW5pbWF4L21pbmltYXgtbTFcIixcblx0XHRcdG5hbWU6IFwiTWluaU1heDogTWluaU1heCBNMVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdG91dHB1dDogMi4yLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogNDAwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJtaW5pbWF4L21pbmltYXgtbTJcIjoge1xuXHRcdFx0aWQ6IFwibWluaW1heC9taW5pbWF4LW0yXCIsXG5cdFx0XHRuYW1lOiBcIk1pbmlNYXg6IE1pbmlNYXggTTJcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI1NSxcblx0XHRcdFx0b3V0cHV0OiAxLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTk2NjA4LFxuXHRcdFx0bWF4VG9rZW5zOiAxOTY2MDgsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJtaW5pbWF4L21pbmltYXgtbTIuMVwiOiB7XG5cdFx0XHRpZDogXCJtaW5pbWF4L21pbmltYXgtbTIuMVwiLFxuXHRcdFx0bmFtZTogXCJNaW5pTWF4OiBNaW5pTWF4IE0yLjFcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI5LFxuXHRcdFx0XHRvdXRwdXQ6IDAuOTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxOTY2MDgsXG5cdFx0XHRtYXhUb2tlbnM6IDE5NjYwOCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm1pbmltYXgvbWluaW1heC1tMi41XCI6IHtcblx0XHRcdGlkOiBcIm1pbmltYXgvbWluaW1heC1tMi41XCIsXG5cdFx0XHRuYW1lOiBcIk1pbmlNYXg6IE1pbmlNYXggTTIuNVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTE4LFxuXHRcdFx0XHRvdXRwdXQ6IDAuOTkwMDAwMDAwMDAwMDAwMSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA1OSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxOTY2MDgsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibWluaW1heC9taW5pbWF4LW0yLjU6ZnJlZVwiOiB7XG5cdFx0XHRpZDogXCJtaW5pbWF4L21pbmltYXgtbTIuNTpmcmVlXCIsXG5cdFx0XHRuYW1lOiBcIk1pbmlNYXg6IE1pbmlNYXggTTIuNSAoZnJlZSlcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxOTY2MDgsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJtaW5pbWF4L21pbmltYXgtbTIuN1wiOiB7XG5cdFx0XHRpZDogXCJtaW5pbWF4L21pbmltYXgtbTIuN1wiLFxuXHRcdFx0bmFtZTogXCJNaW5pTWF4OiBNaW5pTWF4IE0yLjdcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjMsXG5cdFx0XHRcdG91dHB1dDogMS4yLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDU5LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDE5NjYwOCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm1pc3RyYWxhaS9jb2Rlc3RyYWwtMjUwOFwiOiB7XG5cdFx0XHRpZDogXCJtaXN0cmFsYWkvY29kZXN0cmFsLTI1MDhcIixcblx0XHRcdG5hbWU6IFwiTWlzdHJhbDogQ29kZXN0cmFsIDI1MDhcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zLFxuXHRcdFx0XHRvdXRwdXQ6IDAuODk5OTk5OTk5OTk5OTk5OSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAzLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI1NjAwMCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm1pc3RyYWxhaS9kZXZzdHJhbC0yNTEyXCI6IHtcblx0XHRcdGlkOiBcIm1pc3RyYWxhaS9kZXZzdHJhbC0yNTEyXCIsXG5cdFx0XHRuYW1lOiBcIk1pc3RyYWw6IERldnN0cmFsIDIgMjUxMlwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjM5OTk5OTk5OTk5OTk5OTk3LFxuXHRcdFx0XHRvdXRwdXQ6IDIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wNCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIxNDQsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJtaXN0cmFsYWkvZGV2c3RyYWwtbWVkaXVtXCI6IHtcblx0XHRcdGlkOiBcIm1pc3RyYWxhaS9kZXZzdHJhbC1tZWRpdW1cIixcblx0XHRcdG5hbWU6IFwiTWlzdHJhbDogRGV2c3RyYWwgTWVkaXVtXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdG91dHB1dDogMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA0LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm1pc3RyYWxhaS9kZXZzdHJhbC1zbWFsbFwiOiB7XG5cdFx0XHRpZDogXCJtaXN0cmFsYWkvZGV2c3RyYWwtc21hbGxcIixcblx0XHRcdG5hbWU6IFwiTWlzdHJhbDogRGV2c3RyYWwgU21hbGwgMS4xXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDk5OTk5OTk5OTk5OTk5OTksXG5cdFx0XHRcdG91dHB1dDogMC4zLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDEsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibWlzdHJhbGFpL21pbmlzdHJhbC0xNGItMjUxMlwiOiB7XG5cdFx0XHRpZDogXCJtaXN0cmFsYWkvbWluaXN0cmFsLTE0Yi0yNTEyXCIsXG5cdFx0XHRuYW1lOiBcIk1pc3RyYWw6IE1pbmlzdHJhbCAzIDE0QiAyNTEyXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xOTk5OTk5OTk5OTk5OTk5OCxcblx0XHRcdFx0b3V0cHV0OiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDIsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTQ0LFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibWlzdHJhbGFpL21pbmlzdHJhbC0zYi0yNTEyXCI6IHtcblx0XHRcdGlkOiBcIm1pc3RyYWxhaS9taW5pc3RyYWwtM2ItMjUxMlwiLFxuXHRcdFx0bmFtZTogXCJNaXN0cmFsOiBNaW5pc3RyYWwgMyAzQiAyNTEyXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wOTk5OTk5OTk5OTk5OTk5OSxcblx0XHRcdFx0b3V0cHV0OiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDEsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibWlzdHJhbGFpL21pbmlzdHJhbC04Yi0yNTEyXCI6IHtcblx0XHRcdGlkOiBcIm1pc3RyYWxhaS9taW5pc3RyYWwtOGItMjUxMlwiLFxuXHRcdFx0bmFtZTogXCJNaXN0cmFsOiBNaW5pc3RyYWwgMyA4QiAyNTEyXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNSxcblx0XHRcdFx0b3V0cHV0OiAwLjE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDE1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm1pc3RyYWxhaS9taXN0cmFsLWxhcmdlXCI6IHtcblx0XHRcdGlkOiBcIm1pc3RyYWxhaS9taXN0cmFsLWxhcmdlXCIsXG5cdFx0XHRuYW1lOiBcIk1pc3RyYWwgTGFyZ2VcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMixcblx0XHRcdFx0b3V0cHV0OiA2LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibWlzdHJhbGFpL21pc3RyYWwtbGFyZ2UtMjQwN1wiOiB7XG5cdFx0XHRpZDogXCJtaXN0cmFsYWkvbWlzdHJhbC1sYXJnZS0yNDA3XCIsXG5cdFx0XHRuYW1lOiBcIk1pc3RyYWwgTGFyZ2UgMjQwN1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLFxuXHRcdFx0XHRvdXRwdXQ6IDYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xOTk5OTk5OTk5OTk5OTk5OCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJtaXN0cmFsYWkvbWlzdHJhbC1sYXJnZS0yNDExXCI6IHtcblx0XHRcdGlkOiBcIm1pc3RyYWxhaS9taXN0cmFsLWxhcmdlLTI0MTFcIixcblx0XHRcdG5hbWU6IFwiTWlzdHJhbCBMYXJnZSAyNDExXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIsXG5cdFx0XHRcdG91dHB1dDogNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm1pc3RyYWxhaS9taXN0cmFsLWxhcmdlLTI1MTJcIjoge1xuXHRcdFx0aWQ6IFwibWlzdHJhbGFpL21pc3RyYWwtbGFyZ2UtMjUxMlwiLFxuXHRcdFx0bmFtZTogXCJNaXN0cmFsOiBNaXN0cmFsIExhcmdlIDMgMjUxMlwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNSxcblx0XHRcdFx0b3V0cHV0OiAxLjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wNDk5OTk5OTk5OTk5OTk5OTYsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTQ0LFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibWlzdHJhbGFpL21pc3RyYWwtbWVkaXVtLTNcIjoge1xuXHRcdFx0aWQ6IFwibWlzdHJhbGFpL21pc3RyYWwtbWVkaXVtLTNcIixcblx0XHRcdG5hbWU6IFwiTWlzdHJhbDogTWlzdHJhbCBNZWRpdW0gM1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdG91dHB1dDogMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA0LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm1pc3RyYWxhaS9taXN0cmFsLW1lZGl1bS0zLjFcIjoge1xuXHRcdFx0aWQ6IFwibWlzdHJhbGFpL21pc3RyYWwtbWVkaXVtLTMuMVwiLFxuXHRcdFx0bmFtZTogXCJNaXN0cmFsOiBNaXN0cmFsIE1lZGl1bSAzLjFcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjM5OTk5OTk5OTk5OTk5OTk3LFxuXHRcdFx0XHRvdXRwdXQ6IDIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wNCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJtaXN0cmFsYWkvbWlzdHJhbC1uZW1vXCI6IHtcblx0XHRcdGlkOiBcIm1pc3RyYWxhaS9taXN0cmFsLW5lbW9cIixcblx0XHRcdG5hbWU6IFwiTWlzdHJhbDogTWlzdHJhbCBOZW1vXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDIsXG5cdFx0XHRcdG91dHB1dDogMC4wNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJtaXN0cmFsYWkvbWlzdHJhbC1zYWJhXCI6IHtcblx0XHRcdGlkOiBcIm1pc3RyYWxhaS9taXN0cmFsLXNhYmFcIixcblx0XHRcdG5hbWU6IFwiTWlzdHJhbDogU2FiYVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAyLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDMyNzY4LFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibWlzdHJhbGFpL21pc3RyYWwtc21hbGwtMjYwM1wiOiB7XG5cdFx0XHRpZDogXCJtaXN0cmFsYWkvbWlzdHJhbC1zbWFsbC0yNjAzXCIsXG5cdFx0XHRuYW1lOiBcIk1pc3RyYWw6IE1pc3RyYWwgU21hbGwgNFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNSxcblx0XHRcdFx0b3V0cHV0OiAwLjYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMTUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTQ0LFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibWlzdHJhbGFpL21pc3RyYWwtc21hbGwtMy4yLTI0Yi1pbnN0cnVjdFwiOiB7XG5cdFx0XHRpZDogXCJtaXN0cmFsYWkvbWlzdHJhbC1zbWFsbC0zLjItMjRiLWluc3RydWN0XCIsXG5cdFx0XHRuYW1lOiBcIk1pc3RyYWw6IE1pc3RyYWwgU21hbGwgMy4yIDI0QlwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDc1LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJtaXN0cmFsYWkvbWlzdHJhbC1zbWFsbC1jcmVhdGl2ZVwiOiB7XG5cdFx0XHRpZDogXCJtaXN0cmFsYWkvbWlzdHJhbC1zbWFsbC1jcmVhdGl2ZVwiLFxuXHRcdFx0bmFtZTogXCJNaXN0cmFsOiBNaXN0cmFsIFNtYWxsIENyZWF0aXZlXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDk5OTk5OTk5OTk5OTk5OTksXG5cdFx0XHRcdG91dHB1dDogMC4zLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDEsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMzI3NjgsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJtaXN0cmFsYWkvbWl4dHJhbC04eDIyYi1pbnN0cnVjdFwiOiB7XG5cdFx0XHRpZDogXCJtaXN0cmFsYWkvbWl4dHJhbC04eDIyYi1pbnN0cnVjdFwiLFxuXHRcdFx0bmFtZTogXCJNaXN0cmFsOiBNaXh0cmFsIDh4MjJCIEluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIsXG5cdFx0XHRcdG91dHB1dDogNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDY1NTM2LFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibWlzdHJhbGFpL21peHRyYWwtOHg3Yi1pbnN0cnVjdFwiOiB7XG5cdFx0XHRpZDogXCJtaXN0cmFsYWkvbWl4dHJhbC04eDdiLWluc3RydWN0XCIsXG5cdFx0XHRuYW1lOiBcIk1pc3RyYWw6IE1peHRyYWwgOHg3QiBJbnN0cnVjdFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjU0LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNTQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAzMjc2OCxcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJtaXN0cmFsYWkvcGl4dHJhbC1sYXJnZS0yNDExXCI6IHtcblx0XHRcdGlkOiBcIm1pc3RyYWxhaS9waXh0cmFsLWxhcmdlLTI0MTFcIixcblx0XHRcdG5hbWU6IFwiTWlzdHJhbDogUGl4dHJhbCBMYXJnZSAyNDExXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMixcblx0XHRcdFx0b3V0cHV0OiA2LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibWlzdHJhbGFpL3ZveHRyYWwtc21hbGwtMjRiLTI1MDdcIjoge1xuXHRcdFx0aWQ6IFwibWlzdHJhbGFpL3ZveHRyYWwtc21hbGwtMjRiLTI1MDdcIixcblx0XHRcdG5hbWU6IFwiTWlzdHJhbDogVm94dHJhbCBTbWFsbCAyNEIgMjUwN1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAxLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDMyMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibW9vbnNob3RhaS9raW1pLWsyXCI6IHtcblx0XHRcdGlkOiBcIm1vb25zaG90YWkva2ltaS1rMlwiLFxuXHRcdFx0bmFtZTogXCJNb29uc2hvdEFJOiBLaW1pIEsyIDA3MTFcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC41NzAwMDAwMDAwMDAwMDAxLFxuXHRcdFx0XHRvdXRwdXQ6IDIuMyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogMTMxMDcyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibW9vbnNob3RhaS9raW1pLWsyLTA5MDVcIjoge1xuXHRcdFx0aWQ6IFwibW9vbnNob3RhaS9raW1pLWsyLTA5MDVcIixcblx0XHRcdG5hbWU6IFwiTW9vbnNob3RBSTogS2ltaSBLMiAwOTA1XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdG91dHB1dDogMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogMjYyMTQ0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibW9vbnNob3RhaS9raW1pLWsyLXRoaW5raW5nXCI6IHtcblx0XHRcdGlkOiBcIm1vb25zaG90YWkva2ltaS1rMi10aGlua2luZ1wiLFxuXHRcdFx0bmFtZTogXCJNb29uc2hvdEFJOiBLaW1pIEsyIFRoaW5raW5nXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC42LFxuXHRcdFx0XHRvdXRwdXQ6IDIuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm1vb25zaG90YWkva2ltaS1rMi41XCI6IHtcblx0XHRcdGlkOiBcIm1vb25zaG90YWkva2ltaS1rMi41XCIsXG5cdFx0XHRuYW1lOiBcIk1vb25zaG90QUk6IEtpbWkgSzIuNVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC40MSxcblx0XHRcdFx0b3V0cHV0OiAyLjA2LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDcsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTQ0LFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibmV4LWFnaS9kZWVwc2Vlay12My4xLW5leC1uMVwiOiB7XG5cdFx0XHRpZDogXCJuZXgtYWdpL2RlZXBzZWVrLXYzLjEtbmV4LW4xXCIsXG5cdFx0XHRuYW1lOiBcIk5leCBBR0k6IERlZXBTZWVrIFYzLjEgTmV4IE4xXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTM1LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogMTYzODQwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibnZpZGlhL2xsYW1hLTMuMS1uZW1vdHJvbi03MGItaW5zdHJ1Y3RcIjoge1xuXHRcdFx0aWQ6IFwibnZpZGlhL2xsYW1hLTMuMS1uZW1vdHJvbi03MGItaW5zdHJ1Y3RcIixcblx0XHRcdG5hbWU6IFwiTlZJRElBOiBMbGFtYSAzLjEgTmVtb3Ryb24gNzBCIEluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMixcblx0XHRcdFx0b3V0cHV0OiAxLjIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibnZpZGlhL2xsYW1hLTMuMy1uZW1vdHJvbi1zdXBlci00OWItdjEuNVwiOiB7XG5cdFx0XHRpZDogXCJudmlkaWEvbGxhbWEtMy4zLW5lbW90cm9uLXN1cGVyLTQ5Yi12MS41XCIsXG5cdFx0XHRuYW1lOiBcIk5WSURJQTogTGxhbWEgMy4zIE5lbW90cm9uIFN1cGVyIDQ5QiBWMS41XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wOTk5OTk5OTk5OTk5OTk5OSxcblx0XHRcdFx0b3V0cHV0OiAwLjM5OTk5OTk5OTk5OTk5OTk3LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibnZpZGlhL25lbW90cm9uLTMtbmFuby0zMGItYTNiXCI6IHtcblx0XHRcdGlkOiBcIm52aWRpYS9uZW1vdHJvbi0zLW5hbm8tMzBiLWEzYlwiLFxuXHRcdFx0bmFtZTogXCJOVklESUE6IE5lbW90cm9uIDMgTmFubyAzMEIgQTNCXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNDk5OTk5OTk5OTk5OTk5OTYsXG5cdFx0XHRcdG91dHB1dDogMC4xOTk5OTk5OTk5OTk5OTk5OCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm52aWRpYS9uZW1vdHJvbi0zLW5hbm8tMzBiLWEzYjpmcmVlXCI6IHtcblx0XHRcdGlkOiBcIm52aWRpYS9uZW1vdHJvbi0zLW5hbm8tMzBiLWEzYjpmcmVlXCIsXG5cdFx0XHRuYW1lOiBcIk5WSURJQTogTmVtb3Ryb24gMyBOYW5vIDMwQiBBM0IgKGZyZWUpXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjU2MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibnZpZGlhL25lbW90cm9uLTMtc3VwZXItMTIwYi1hMTJiXCI6IHtcblx0XHRcdGlkOiBcIm52aWRpYS9uZW1vdHJvbi0zLXN1cGVyLTEyMGItYTEyYlwiLFxuXHRcdFx0bmFtZTogXCJOVklESUE6IE5lbW90cm9uIDMgU3VwZXJcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm52aWRpYS9uZW1vdHJvbi0zLXN1cGVyLTEyMGItYTEyYjpmcmVlXCI6IHtcblx0XHRcdGlkOiBcIm52aWRpYS9uZW1vdHJvbi0zLXN1cGVyLTEyMGItYTEyYjpmcmVlXCIsXG5cdFx0XHRuYW1lOiBcIk5WSURJQTogTmVtb3Ryb24gMyBTdXBlciAoZnJlZSlcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIxNDQsXG5cdFx0XHRtYXhUb2tlbnM6IDI2MjE0NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm52aWRpYS9uZW1vdHJvbi1uYW5vLTEyYi12Mi12bDpmcmVlXCI6IHtcblx0XHRcdGlkOiBcIm52aWRpYS9uZW1vdHJvbi1uYW5vLTEyYi12Mi12bDpmcmVlXCIsXG5cdFx0XHRuYW1lOiBcIk5WSURJQTogTmVtb3Ryb24gTmFubyAxMkIgMiBWTCAoZnJlZSlcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibnZpZGlhL25lbW90cm9uLW5hbm8tOWItdjJcIjoge1xuXHRcdFx0aWQ6IFwibnZpZGlhL25lbW90cm9uLW5hbm8tOWItdjJcIixcblx0XHRcdG5hbWU6IFwiTlZJRElBOiBOZW1vdHJvbiBOYW5vIDlCIFYyXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNCxcblx0XHRcdFx0b3V0cHV0OiAwLjE2LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwibnZpZGlhL25lbW90cm9uLW5hbm8tOWItdjI6ZnJlZVwiOiB7XG5cdFx0XHRpZDogXCJudmlkaWEvbmVtb3Ryb24tbmFuby05Yi12MjpmcmVlXCIsXG5cdFx0XHRuYW1lOiBcIk5WSURJQTogTmVtb3Ryb24gTmFubyA5QiBWMiAoZnJlZSlcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTMuNS10dXJib1wiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTMuNS10dXJib1wiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC0zLjUgVHVyYm9cIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC41LFxuXHRcdFx0XHRvdXRwdXQ6IDEuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDE2Mzg1LFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL2dwdC0zLjUtdHVyYm8tMDYxM1wiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTMuNS10dXJiby0wNjEzXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BULTMuNSBUdXJibyAob2xkZXIgdjA2MTMpXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEsXG5cdFx0XHRcdG91dHB1dDogMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwOTUsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTMuNS10dXJiby0xNmtcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC0zLjUtdHVyYm8tMTZrXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BULTMuNSBUdXJibyAxNmtcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMyxcblx0XHRcdFx0b3V0cHV0OiA0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTYzODUsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTRcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC00XCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BULTRcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMzAsXG5cdFx0XHRcdG91dHB1dDogNjAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA4MTkxLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL2dwdC00LTAzMTRcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC00LTAzMTRcIixcblx0XHRcdG5hbWU6IFwiT3BlbkFJOiBHUFQtNCAob2xkZXIgdjAzMTQpXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDMwLFxuXHRcdFx0XHRvdXRwdXQ6IDYwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogODE5MSxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNC0xMTA2LXByZXZpZXdcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC00LTExMDYtcHJldmlld1wiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC00IFR1cmJvIChvbGRlciB2MTEwNilcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMTAsXG5cdFx0XHRcdG91dHB1dDogMzAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTQtdHVyYm9cIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC00LXR1cmJvXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BULTQgVHVyYm9cIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxMCxcblx0XHRcdFx0b3V0cHV0OiAzMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNC10dXJiby1wcmV2aWV3XCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNC10dXJiby1wcmV2aWV3XCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BULTQgVHVyYm8gUHJldmlld1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxMCxcblx0XHRcdFx0b3V0cHV0OiAzMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNC4xXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNC4xXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BULTQuMVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIsXG5cdFx0XHRcdG91dHB1dDogOCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0NzU3Nixcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNC4xLW1pbmlcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC00LjEtbWluaVwiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC00LjEgTWluaVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdG91dHB1dDogMS41OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDk5OTk5OTk5OTk5OTk5OTksXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0NzU3Nixcblx0XHRcdG1heFRva2VuczogMzI3NjgsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTQuMS1uYW5vXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNC4xLW5hbm9cIixcblx0XHRcdG5hbWU6IFwiT3BlbkFJOiBHUFQtNC4xIE5hbm9cIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMjQ5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0NzU3Nixcblx0XHRcdG1heFRva2VuczogMzI3NjgsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTRvXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNG9cIixcblx0XHRcdG5hbWU6IFwiT3BlbkFJOiBHUFQtNG9cIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL2dwdC00by0yMDI0LTA1LTEzXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNG8tMjAyNC0wNS0xM1wiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC00byAoMjAyNC0wNS0xMylcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiA1LFxuXHRcdFx0XHRvdXRwdXQ6IDE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL2dwdC00by0yMDI0LTA4LTA2XCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNG8tMjAyNC0wOC0wNlwiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC00byAoMjAyNC0wOC0wNilcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMS4yNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL2dwdC00by0yMDI0LTExLTIwXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNG8tMjAyNC0xMS0yMFwiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC00byAoMjAyNC0xMS0yMClcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMS4yNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL2dwdC00by1hdWRpby1wcmV2aWV3XCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNG8tYXVkaW8tcHJldmlld1wiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC00byBBdWRpb1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL2dwdC00by1taW5pXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNG8tbWluaVwiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC00by1taW5pXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNSxcblx0XHRcdFx0b3V0cHV0OiAwLjYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxNjM4NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNG8tbWluaS0yMDI0LTA3LTE4XCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNG8tbWluaS0yMDI0LTA3LTE4XCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BULTRvLW1pbmkgKDIwMjQtMDctMTgpXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNSxcblx0XHRcdFx0b3V0cHV0OiAwLjYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxNjM4NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNG86ZXh0ZW5kZWRcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC00bzpleHRlbmRlZFwiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC00byAoZXh0ZW5kZWQpXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogNixcblx0XHRcdFx0b3V0cHV0OiAxOCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTVcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01XCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BULTVcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTUtY29kZXhcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01LWNvZGV4XCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BULTUgQ29kZXhcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTUtaW1hZ2VcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01LWltYWdlXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BULTUgSW1hZ2VcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEwLFxuXHRcdFx0XHRvdXRwdXQ6IDEwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDEuMjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTUtaW1hZ2UtbWluaVwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUtaW1hZ2UtbWluaVwiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC01IEltYWdlIE1pbmlcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIuNSxcblx0XHRcdFx0b3V0cHV0OiAyLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTUtbWluaVwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUtbWluaVwiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC01IE1pbmlcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjUsXG5cdFx0XHRcdG91dHB1dDogMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAyNDk5OTk5OTk5OTk5OTk5OCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS1uYW5vXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNS1uYW5vXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BULTUgTmFub1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNDk5OTk5OTk5OTk5OTk5OTYsXG5cdFx0XHRcdG91dHB1dDogMC4zOTk5OTk5OTk5OTk5OTk5Nyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAxLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS1wcm9cIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01LXByb1wiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC01IFByb1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMTUsXG5cdFx0XHRcdG91dHB1dDogMTIwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTUuMVwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUuMVwiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC01LjFcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS4xLWNoYXRcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01LjEtY2hhdFwiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC01LjEgQ2hhdFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxNjM4NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS4xLWNvZGV4XCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNS4xLWNvZGV4XCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BULTUuMS1Db2RleFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4yNSxcblx0XHRcdFx0b3V0cHV0OiAxMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjEyNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS4xLWNvZGV4LW1heFwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUuMS1jb2RleC1tYXhcIixcblx0XHRcdG5hbWU6IFwiT3BlbkFJOiBHUFQtNS4xLUNvZGV4LU1heFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4yNSxcblx0XHRcdFx0b3V0cHV0OiAxMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjEyNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS4xLWNvZGV4LW1pbmlcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01LjEtY29kZXgtbWluaVwiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC01LjEtQ29kZXgtTWluaVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4yNSxcblx0XHRcdFx0b3V0cHV0OiAyLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTUuMlwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUuMlwiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC01LjJcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuNzUsXG5cdFx0XHRcdG91dHB1dDogMTQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTUuMi1jaGF0XCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNS4yLWNoYXRcIixcblx0XHRcdG5hbWU6IFwiT3BlbkFJOiBHUFQtNS4yIENoYXRcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjc1LFxuXHRcdFx0XHRvdXRwdXQ6IDE0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogMzIwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTUuMi1jb2RleFwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUuMi1jb2RleFwiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IEdQVC01LjItQ29kZXhcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuNzUsXG5cdFx0XHRcdG91dHB1dDogMTQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTUuMi1wcm9cIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01LjItcHJvXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BULTUuMiBQcm9cIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIxLFxuXHRcdFx0XHRvdXRwdXQ6IDE2OCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL2dwdC01LjMtY2hhdFwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUuMy1jaGF0XCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BULTUuMyBDaGF0XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS43NSxcblx0XHRcdFx0b3V0cHV0OiAxNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjE3NSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL2dwdC01LjMtY29kZXhcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01LjMtY29kZXhcIixcblx0XHRcdG5hbWU6IFwiT3BlbkFJOiBHUFQtNS4zLUNvZGV4XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjc1LFxuXHRcdFx0XHRvdXRwdXQ6IDE0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL2dwdC01LjRcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC01LjRcIixcblx0XHRcdG5hbWU6IFwiT3BlbkFJOiBHUFQtNS40XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLjUsXG5cdFx0XHRcdG91dHB1dDogMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4yNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDUwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LTUuNC1taW5pXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtNS40LW1pbmlcIixcblx0XHRcdG5hbWU6IFwiT3BlbkFJOiBHUFQtNS40IE1pbmlcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNzUsXG5cdFx0XHRcdG91dHB1dDogNC41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL2dwdC01LjQtbmFub1wiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUuNC1uYW5vXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BULTUuNCBOYW5vXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRvdXRwdXQ6IDEuMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9ncHQtNS40LXByb1wiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LTUuNC1wcm9cIixcblx0XHRcdG5hbWU6IFwiT3BlbkFJOiBHUFQtNS40IFByb1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMzAsXG5cdFx0XHRcdG91dHB1dDogMTgwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA1MDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL2dwdC1hdWRpb1wiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LWF1ZGlvXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BUIEF1ZGlvXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIuNSxcblx0XHRcdFx0b3V0cHV0OiAxMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LWF1ZGlvLW1pbmlcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL2dwdC1hdWRpby1taW5pXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogR1BUIEF1ZGlvIE1pbmlcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC42LFxuXHRcdFx0XHRvdXRwdXQ6IDIuNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvZ3B0LW9zcy0xMjBiXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtb3NzLTEyMGJcIixcblx0XHRcdG5hbWU6IFwiT3BlbkFJOiBncHQtb3NzLTEyMGJcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjAzOSxcblx0XHRcdFx0b3V0cHV0OiAwLjE5LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL2dwdC1vc3MtMTIwYjpmcmVlXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtb3NzLTEyMGI6ZnJlZVwiLFxuXHRcdFx0bmFtZTogXCJPcGVuQUk6IGdwdC1vc3MtMTIwYiAoZnJlZSlcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTA3Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9ncHQtb3NzLTIwYlwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LW9zcy0yMGJcIixcblx0XHRcdG5hbWU6IFwiT3BlbkFJOiBncHQtb3NzLTIwYlwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDMsXG5cdFx0XHRcdG91dHB1dDogMC4xNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9ncHQtb3NzLTIwYjpmcmVlXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9ncHQtb3NzLTIwYjpmcmVlXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogZ3B0LW9zcy0yMGIgKGZyZWUpXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL2dwdC1vc3Mtc2FmZWd1YXJkLTIwYlwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvZ3B0LW9zcy1zYWZlZ3VhcmQtMjBiXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogZ3B0LW9zcy1zYWZlZ3VhcmQtMjBiXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNzUsXG5cdFx0XHRcdG91dHB1dDogMC4zLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDM3LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJvcGVuYWkvbzFcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL28xXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogbzFcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDE1LFxuXHRcdFx0XHRvdXRwdXQ6IDYwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDcuNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEwMDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9vM1wiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvbzNcIixcblx0XHRcdG5hbWU6IFwiT3BlbkFJOiBvM1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMixcblx0XHRcdFx0b3V0cHV0OiA4LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEwMDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIm9wZW5haS9vMy1kZWVwLXJlc2VhcmNoXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS9vMy1kZWVwLXJlc2VhcmNoXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogbzMgRGVlcCBSZXNlYXJjaFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMTAsXG5cdFx0XHRcdG91dHB1dDogNDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMi41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTAwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL28zLW1pbmlcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL28zLW1pbmlcIixcblx0XHRcdG5hbWU6IFwiT3BlbkFJOiBvMyBNaW5pXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4xLFxuXHRcdFx0XHRvdXRwdXQ6IDQuNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjU1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTAwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL28zLW1pbmktaGlnaFwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvbzMtbWluaS1oaWdoXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogbzMgTWluaSBIaWdoXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4xLFxuXHRcdFx0XHRvdXRwdXQ6IDQuNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjU1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTAwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL28zLXByb1wiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvbzMtcHJvXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogbzMgUHJvXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyMCxcblx0XHRcdFx0b3V0cHV0OiA4MCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTAwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL280LW1pbmlcIjoge1xuXHRcdFx0aWQ6IFwib3BlbmFpL280LW1pbmlcIixcblx0XHRcdG5hbWU6IFwiT3BlbkFJOiBvNCBNaW5pXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjEsXG5cdFx0XHRcdG91dHB1dDogNC40LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMjc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTAwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL280LW1pbmktZGVlcC1yZXNlYXJjaFwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvbzQtbWluaS1kZWVwLXJlc2VhcmNoXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogbzQgTWluaSBEZWVwIFJlc2VhcmNoXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLFxuXHRcdFx0XHRvdXRwdXQ6IDgsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTAwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbmFpL280LW1pbmktaGlnaFwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkvbzQtbWluaS1oaWdoXCIsXG5cdFx0XHRuYW1lOiBcIk9wZW5BSTogbzQgTWluaSBIaWdoXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjEsXG5cdFx0XHRcdG91dHB1dDogNC40LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMjc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTAwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbnJvdXRlci9hdXRvXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5yb3V0ZXIvYXV0b1wiLFxuXHRcdFx0bmFtZTogXCJBdXRvIFJvdXRlclwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogLTEwMDAwMDAsXG5cdFx0XHRcdG91dHB1dDogLTEwMDAwMDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwib3BlbnJvdXRlci9mcmVlXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5yb3V0ZXIvZnJlZVwiLFxuXHRcdFx0bmFtZTogXCJGcmVlIE1vZGVscyBSb3V0ZXJcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInByaW1lLWludGVsbGVjdC9pbnRlbGxlY3QtM1wiOiB7XG5cdFx0XHRpZDogXCJwcmltZS1pbnRlbGxlY3QvaW50ZWxsZWN0LTNcIixcblx0XHRcdG5hbWU6IFwiUHJpbWUgSW50ZWxsZWN0OiBJTlRFTExFQ1QtM1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdG91dHB1dDogMS4xLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiAxMzEwNzIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuL3F3ZW4tMi41LTcyYi1pbnN0cnVjdFwiOiB7XG5cdFx0XHRpZDogXCJxd2VuL3F3ZW4tMi41LTcyYi1pbnN0cnVjdFwiLFxuXHRcdFx0bmFtZTogXCJRd2VuMi41IDcyQiBJbnN0cnVjdFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjEyLFxuXHRcdFx0XHRvdXRwdXQ6IDAuMzksXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAzMjc2OCxcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuL3F3ZW4tMi41LTdiLWluc3RydWN0XCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbi0yLjUtN2ItaW5zdHJ1Y3RcIixcblx0XHRcdG5hbWU6IFwiUXdlbjogUXdlbjIuNSA3QiBJbnN0cnVjdFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA0LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMDk5OTk5OTk5OTk5OTk5OTksXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAzMjc2OCxcblx0XHRcdG1heFRva2VuczogMzI3NjgsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuL3F3ZW4tbWF4XCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbi1tYXhcIixcblx0XHRcdG5hbWU6IFwiUXdlbjogUXdlbi1NYXggXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMDQsXG5cdFx0XHRcdG91dHB1dDogNC4xNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjIwODAwMDAwMDAwMDAwMDAyLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDMyNzY4LFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwicXdlbi9xd2VuLXBsdXNcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd2VuLXBsdXNcIixcblx0XHRcdG5hbWU6IFwiUXdlbjogUXdlbi1QbHVzXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjYsXG5cdFx0XHRcdG91dHB1dDogMC43OCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA1MjAwMDAwMDAwMDAwMDAwNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbi1wbHVzLTIwMjUtMDctMjhcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd2VuLXBsdXMtMjAyNS0wNy0yOFwiLFxuXHRcdFx0bmFtZTogXCJRd2VuOiBRd2VuIFBsdXMgMDcyOFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI2LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNzgsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbi1wbHVzLTIwMjUtMDctMjg6dGhpbmtpbmdcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd2VuLXBsdXMtMjAyNS0wNy0yODp0aGlua2luZ1wiLFxuXHRcdFx0bmFtZTogXCJRd2VuOiBRd2VuIFBsdXMgMDcyOCAodGhpbmtpbmcpXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4yNixcblx0XHRcdFx0b3V0cHV0OiAwLjc4LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogMzI3NjgsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuL3F3ZW4tdHVyYm9cIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd2VuLXR1cmJvXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4tVHVyYm9cIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wMzI1LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMTMsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMDY1MDAwMDAwMDAwMDAwMDEsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwicXdlbi9xd2VuLXZsLW1heFwiOiB7XG5cdFx0XHRpZDogXCJxd2VuL3F3ZW4tdmwtbWF4XCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4gVkwgTWF4XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC41Mixcblx0XHRcdFx0b3V0cHV0OiAyLjA4LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMtMTRiXCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbjMtMTRiXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zIDE0QlwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDYsXG5cdFx0XHRcdG91dHB1dDogMC4yNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDQwOTYwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2MCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMtMjM1Yi1hMjJiXCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbjMtMjM1Yi1hMjJiXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zIDIzNUIgQTIyQlwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNDU0OTk5OTk5OTk5OTk5OTYsXG5cdFx0XHRcdG91dHB1dDogMS44MTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwicXdlbi9xd2VuMy0yMzViLWEyMmItMjUwN1wiOiB7XG5cdFx0XHRpZDogXCJxd2VuL3F3ZW4zLTIzNWItYTIyYi0yNTA3XCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zIDIzNUIgQTIyQiBJbnN0cnVjdCAyNTA3XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNzEsXG5cdFx0XHRcdG91dHB1dDogMC4wOTk5OTk5OTk5OTk5OTk5OSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMtMjM1Yi1hMjJiLXRoaW5raW5nLTI1MDdcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd2VuMy0yMzViLWEyMmItdGhpbmtpbmctMjUwN1wiLFxuXHRcdFx0bmFtZTogXCJRd2VuOiBRd2VuMyAyMzVCIEEyMkIgVGhpbmtpbmcgMjUwN1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTQ5NTAwMDAwMDAwMDAwMDIsXG5cdFx0XHRcdG91dHB1dDogMS40OTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuL3F3ZW4zLTMwYi1hM2JcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd2VuMy0zMGItYTNiXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zIDMwQiBBM0JcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA4LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMjgsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDk2MCxcblx0XHRcdG1heFRva2VuczogNDA5NjAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuL3F3ZW4zLTMwYi1hM2ItaW5zdHJ1Y3QtMjUwN1wiOiB7XG5cdFx0XHRpZDogXCJxd2VuL3F3ZW4zLTMwYi1hM2ItaW5zdHJ1Y3QtMjUwN1wiLFxuXHRcdFx0bmFtZTogXCJRd2VuOiBRd2VuMyAzMEIgQTNCIEluc3RydWN0IDI1MDdcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wOSxcblx0XHRcdFx0b3V0cHV0OiAwLjMsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIxNDQsXG5cdFx0XHRtYXhUb2tlbnM6IDI2MjE0NCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMtMzBiLWEzYi10aGlua2luZy0yNTA3XCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbjMtMzBiLWEzYi10aGlua2luZy0yNTA3XCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zIDMwQiBBM0IgVGhpbmtpbmcgMjUwN1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDgsXG5cdFx0XHRcdG91dHB1dDogMC4zOTk5OTk5OTk5OTk5OTk5Nyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA4LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogMTMxMDcyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwicXdlbi9xd2VuMy0zMmJcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd2VuMy0zMmJcIixcblx0XHRcdG5hbWU6IFwiUXdlbjogUXdlbjMgMzJCXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wOCxcblx0XHRcdFx0b3V0cHV0OiAwLjI0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDQsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNDA5NjAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwicXdlbi9xd2VuMy04YlwiOiB7XG5cdFx0XHRpZDogXCJxd2VuL3F3ZW4zLThiXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zIDhCXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNDk5OTk5OTk5OTk5OTk5OTYsXG5cdFx0XHRcdG91dHB1dDogMC4zOTk5OTk5OTk5OTk5OTk5Nyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA0OTk5OTk5OTk5OTk5OTk5Nixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiA0MDk2MCxcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMtY29kZXJcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd2VuMy1jb2RlclwiLFxuXHRcdFx0bmFtZTogXCJRd2VuOiBRd2VuMyBDb2RlciA0ODBCIEEzNUJcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4yMixcblx0XHRcdFx0b3V0cHV0OiAxLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDIyLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMtY29kZXItMzBiLWEzYi1pbnN0cnVjdFwiOiB7XG5cdFx0XHRpZDogXCJxd2VuL3F3ZW4zLWNvZGVyLTMwYi1hM2ItaW5zdHJ1Y3RcIixcblx0XHRcdG5hbWU6IFwiUXdlbjogUXdlbjMgQ29kZXIgMzBCIEEzQiBJbnN0cnVjdFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA3LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMjcsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxNjAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDMyNzY4LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwicXdlbi9xd2VuMy1jb2Rlci1mbGFzaFwiOiB7XG5cdFx0XHRpZDogXCJxd2VuL3F3ZW4zLWNvZGVyLWZsYXNoXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zIENvZGVyIEZsYXNoXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTk1LFxuXHRcdFx0XHRvdXRwdXQ6IDAuOTc1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDM5LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwicXdlbi9xd2VuMy1jb2Rlci1uZXh0XCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbjMtY29kZXItbmV4dFwiLFxuXHRcdFx0bmFtZTogXCJRd2VuOiBRd2VuMyBDb2RlciBOZXh0XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTUsXG5cdFx0XHRcdG91dHB1dDogMC43OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTIsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTQ0LFxuXHRcdFx0bWF4VG9rZW5zOiAyNjIxNDQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuL3F3ZW4zLWNvZGVyLXBsdXNcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd2VuMy1jb2Rlci1wbHVzXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zIENvZGVyIFBsdXNcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC42NSxcblx0XHRcdFx0b3V0cHV0OiAzLjI1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuL3F3ZW4zLWNvZGVyOmZyZWVcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd2VuMy1jb2RlcjpmcmVlXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zIENvZGVyIDQ4MEIgQTM1QiAoZnJlZSlcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAyNjIwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuL3F3ZW4zLW1heFwiOiB7XG5cdFx0XHRpZDogXCJxd2VuL3F3ZW4zLW1heFwiLFxuXHRcdFx0bmFtZTogXCJRd2VuOiBRd2VuMyBNYXhcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC43OCxcblx0XHRcdFx0b3V0cHV0OiAzLjksXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xNTYsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTQ0LFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMtbWF4LXRoaW5raW5nXCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbjMtbWF4LXRoaW5raW5nXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zIE1heCBUaGlua2luZ1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNzgsXG5cdFx0XHRcdG91dHB1dDogMy45LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTQ0LFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMtbmV4dC04MGItYTNiLWluc3RydWN0XCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbjMtbmV4dC04MGItYTNiLWluc3RydWN0XCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zIE5leHQgODBCIEEzQiBJbnN0cnVjdFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA5LFxuXHRcdFx0XHRvdXRwdXQ6IDEuMSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMtbmV4dC04MGItYTNiLWluc3RydWN0OmZyZWVcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd2VuMy1uZXh0LTgwYi1hM2ItaW5zdHJ1Y3Q6ZnJlZVwiLFxuXHRcdFx0bmFtZTogXCJRd2VuOiBRd2VuMyBOZXh0IDgwQiBBM0IgSW5zdHJ1Y3QgKGZyZWUpXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMtbmV4dC04MGItYTNiLXRoaW5raW5nXCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbjMtbmV4dC04MGItYTNiLXRoaW5raW5nXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zIE5leHQgODBCIEEzQiBUaGlua2luZ1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDk3NSxcblx0XHRcdFx0b3V0cHV0OiAwLjc4LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMtdmwtMjM1Yi1hMjJiLWluc3RydWN0XCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbjMtdmwtMjM1Yi1hMjJiLWluc3RydWN0XCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zIFZMIDIzNUIgQTIyQiBJbnN0cnVjdFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdG91dHB1dDogMC44OCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjExLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMtdmwtMjM1Yi1hMjJiLXRoaW5raW5nXCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbjMtdmwtMjM1Yi1hMjJiLXRoaW5raW5nXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zIFZMIDIzNUIgQTIyQiBUaGlua2luZ1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4yNixcblx0XHRcdFx0b3V0cHV0OiAyLjYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDMyNzY4LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwicXdlbi9xd2VuMy12bC0zMGItYTNiLWluc3RydWN0XCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbjMtdmwtMzBiLWEzYi1pbnN0cnVjdFwiLFxuXHRcdFx0bmFtZTogXCJRd2VuOiBRd2VuMyBWTCAzMEIgQTNCIEluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xMyxcblx0XHRcdFx0b3V0cHV0OiAwLjUyLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMtdmwtMzBiLWEzYi10aGlua2luZ1wiOiB7XG5cdFx0XHRpZDogXCJxd2VuL3F3ZW4zLXZsLTMwYi1hM2ItdGhpbmtpbmdcIixcblx0XHRcdG5hbWU6IFwiUXdlbjogUXdlbjMgVkwgMzBCIEEzQiBUaGlua2luZ1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xMyxcblx0XHRcdFx0b3V0cHV0OiAxLjU2LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMtdmwtMzJiLWluc3RydWN0XCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbjMtdmwtMzJiLWluc3RydWN0XCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zIFZMIDMyQiBJbnN0cnVjdFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTA0MDAwMDAwMDAwMDAwMDEsXG5cdFx0XHRcdG91dHB1dDogMC40MTYwMDAwMDAwMDAwMDAwNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogMzI3NjgsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuL3F3ZW4zLXZsLThiLWluc3RydWN0XCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbjMtdmwtOGItaW5zdHJ1Y3RcIixcblx0XHRcdG5hbWU6IFwiUXdlbjogUXdlbjMgVkwgOEIgSW5zdHJ1Y3RcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA4LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogMzI3NjgsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuL3F3ZW4zLXZsLThiLXRoaW5raW5nXCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbjMtdmwtOGItdGhpbmtpbmdcIixcblx0XHRcdG5hbWU6IFwiUXdlbjogUXdlbjMgVkwgOEIgVGhpbmtpbmdcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTE3LFxuXHRcdFx0XHRvdXRwdXQ6IDEuMzY1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMuNS0xMjJiLWExMGJcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd2VuMy41LTEyMmItYTEwYlwiLFxuXHRcdFx0bmFtZTogXCJRd2VuOiBRd2VuMy41LTEyMkItQTEwQlwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4yNixcblx0XHRcdFx0b3V0cHV0OiAyLjA4LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTQ0LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMuNS0yN2JcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd2VuMy41LTI3YlwiLFxuXHRcdFx0bmFtZTogXCJRd2VuOiBRd2VuMy41LTI3QlwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xOTUsXG5cdFx0XHRcdG91dHB1dDogMS41Nixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuL3F3ZW4zLjUtMzViLWEzYlwiOiB7XG5cdFx0XHRpZDogXCJxd2VuL3F3ZW4zLjUtMzViLWEzYlwiLFxuXHRcdFx0bmFtZTogXCJRd2VuOiBRd2VuMy41LTM1Qi1BM0JcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTYyNSxcblx0XHRcdFx0b3V0cHV0OiAxLjMsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIxNDQsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwicXdlbi9xd2VuMy41LTM5N2ItYTE3YlwiOiB7XG5cdFx0XHRpZDogXCJxd2VuL3F3ZW4zLjUtMzk3Yi1hMTdiXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3ZW4zLjUgMzk3QiBBMTdCXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjM5LFxuXHRcdFx0XHRvdXRwdXQ6IDIuMzQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIxNDQsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwicXdlbi9xd2VuMy41LTliXCI6IHtcblx0XHRcdGlkOiBcInF3ZW4vcXdlbjMuNS05YlwiLFxuXHRcdFx0bmFtZTogXCJRd2VuOiBRd2VuMy41LTlCXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA0OTk5OTk5OTk5OTk5OTk5Nixcblx0XHRcdFx0b3V0cHV0OiAwLjE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjU2MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInF3ZW4vcXdlbjMuNS1mbGFzaC0wMi0yM1wiOiB7XG5cdFx0XHRpZDogXCJxd2VuL3F3ZW4zLjUtZmxhc2gtMDItMjNcIixcblx0XHRcdG5hbWU6IFwiUXdlbjogUXdlbjMuNS1GbGFzaFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNjUsXG5cdFx0XHRcdG91dHB1dDogMC4yNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwicXdlbi9xd2VuMy41LXBsdXMtMDItMTVcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd2VuMy41LXBsdXMtMDItMTVcIixcblx0XHRcdG5hbWU6IFwiUXdlbjogUXdlbjMuNSBQbHVzIDIwMjYtMDItMTVcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjYsXG5cdFx0XHRcdG91dHB1dDogMS41Nixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwicXdlbi9xd2VuMy42LXBsdXNcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd2VuMy42LXBsdXNcIixcblx0XHRcdG5hbWU6IFwiUXdlbjogUXdlbjMuNiBQbHVzXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjMyNSxcblx0XHRcdFx0b3V0cHV0OiAxLjk1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJxd2VuL3F3cS0zMmJcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi9xd3EtMzJiXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW46IFF3USAzMkJcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE1LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNTgsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTA3Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInJla2FhaS9yZWthLWVkZ2VcIjoge1xuXHRcdFx0aWQ6IFwicmVrYWFpL3Jla2EtZWRnZVwiLFxuXHRcdFx0bmFtZTogXCJSZWthIEVkZ2VcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMDk5OTk5OTk5OTk5OTk5OTksXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxNjM4NCxcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJyZWxhY2UvcmVsYWNlLXNlYXJjaFwiOiB7XG5cdFx0XHRpZDogXCJyZWxhY2UvcmVsYWNlLXNlYXJjaFwiLFxuXHRcdFx0bmFtZTogXCJSZWxhY2U6IFJlbGFjZSBTZWFyY2hcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMSxcblx0XHRcdFx0b3V0cHV0OiAzLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjU2MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJzYW8xMGsvbDMtZXVyeWFsZS03MGJcIjoge1xuXHRcdFx0aWQ6IFwic2FvMTBrL2wzLWV1cnlhbGUtNzBiXCIsXG5cdFx0XHRuYW1lOiBcIlNhbzEwazogTGxhbWEgMyBFdXJ5YWxlIDcwQiB2Mi4xXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuNDgsXG5cdFx0XHRcdG91dHB1dDogMS40OCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDgxOTIsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJzYW8xMGsvbDMuMS1ldXJ5YWxlLTcwYlwiOiB7XG5cdFx0XHRpZDogXCJzYW8xMGsvbDMuMS1ldXJ5YWxlLTcwYlwiLFxuXHRcdFx0bmFtZTogXCJTYW8xMEs6IExsYW1hIDMuMSBFdXJ5YWxlIDcwQiB2Mi4yXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuODUsXG5cdFx0XHRcdG91dHB1dDogMC44NSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJzdGVwZnVuL3N0ZXAtMy41LWZsYXNoXCI6IHtcblx0XHRcdGlkOiBcInN0ZXBmdW4vc3RlcC0zLjUtZmxhc2hcIixcblx0XHRcdG5hbWU6IFwiU3RlcEZ1bjogU3RlcCAzLjUgRmxhc2hcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJ0aGVkcnVtbWVyL3JvY2luYW50ZS0xMmJcIjoge1xuXHRcdFx0aWQ6IFwidGhlZHJ1bW1lci9yb2NpbmFudGUtMTJiXCIsXG5cdFx0XHRuYW1lOiBcIlRoZURydW1tZXI6IFJvY2luYW50ZSAxMkJcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNjk5OTk5OTk5OTk5OTk5OCxcblx0XHRcdFx0b3V0cHV0OiAwLjQzLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMzI3NjgsXG5cdFx0XHRtYXhUb2tlbnM6IDMyNzY4LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwidGhlZHJ1bW1lci91bnNsb3BuZW1vLTEyYlwiOiB7XG5cdFx0XHRpZDogXCJ0aGVkcnVtbWVyL3Vuc2xvcG5lbW8tMTJiXCIsXG5cdFx0XHRuYW1lOiBcIlRoZURydW1tZXI6IFVuc2xvcE5lbW8gMTJCXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdG91dHB1dDogMC4zOTk5OTk5OTk5OTk5OTk5Nyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDMyNzY4LFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInRuZ3RlY2gvZGVlcHNlZWstcjF0Mi1jaGltZXJhXCI6IHtcblx0XHRcdGlkOiBcInRuZ3RlY2gvZGVlcHNlZWstcjF0Mi1jaGltZXJhXCIsXG5cdFx0XHRuYW1lOiBcIlRORzogRGVlcFNlZWsgUjFUMiBDaGltZXJhXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zLFxuXHRcdFx0XHRvdXRwdXQ6IDEuMSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjE1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDE2Mzg0MCxcblx0XHRcdG1heFRva2VuczogMTYzODQwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwidXBzdGFnZS9zb2xhci1wcm8tM1wiOiB7XG5cdFx0XHRpZDogXCJ1cHN0YWdlL3NvbGFyLXByby0zXCIsXG5cdFx0XHRuYW1lOiBcIlVwc3RhZ2U6IFNvbGFyIFBybyAzXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNSxcblx0XHRcdFx0b3V0cHV0OiAwLjYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMTUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwieC1haS9ncm9rLTNcIjoge1xuXHRcdFx0aWQ6IFwieC1haS9ncm9rLTNcIixcblx0XHRcdG5hbWU6IFwieEFJOiBHcm9rIDNcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMyxcblx0XHRcdFx0b3V0cHV0OiAxNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIngtYWkvZ3Jvay0zLWJldGFcIjoge1xuXHRcdFx0aWQ6IFwieC1haS9ncm9rLTMtYmV0YVwiLFxuXHRcdFx0bmFtZTogXCJ4QUk6IEdyb2sgMyBCZXRhXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDMsXG5cdFx0XHRcdG91dHB1dDogMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC43NSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJ4LWFpL2dyb2stMy1taW5pXCI6IHtcblx0XHRcdGlkOiBcIngtYWkvZ3Jvay0zLW1pbmlcIixcblx0XHRcdG5hbWU6IFwieEFJOiBHcm9rIDMgTWluaVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMyxcblx0XHRcdFx0b3V0cHV0OiAwLjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwieC1haS9ncm9rLTMtbWluaS1iZXRhXCI6IHtcblx0XHRcdGlkOiBcIngtYWkvZ3Jvay0zLW1pbmktYmV0YVwiLFxuXHRcdFx0bmFtZTogXCJ4QUk6IEdyb2sgMyBNaW5pIEJldGFcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjMsXG5cdFx0XHRcdG91dHB1dDogMC41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcIngtYWkvZ3Jvay00XCI6IHtcblx0XHRcdGlkOiBcIngtYWkvZ3Jvay00XCIsXG5cdFx0XHRuYW1lOiBcInhBSTogR3JvayA0XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAzLFxuXHRcdFx0XHRvdXRwdXQ6IDE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjU2MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwieC1haS9ncm9rLTQtZmFzdFwiOiB7XG5cdFx0XHRpZDogXCJ4LWFpL2dyb2stNC1mYXN0XCIsXG5cdFx0XHRuYW1lOiBcInhBSTogR3JvayA0IEZhc3RcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdG91dHB1dDogMC41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDQ5OTk5OTk5OTk5OTk5OTk2LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDMwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwieC1haS9ncm9rLTQuMS1mYXN0XCI6IHtcblx0XHRcdGlkOiBcIngtYWkvZ3Jvay00LjEtZmFzdFwiLFxuXHRcdFx0bmFtZTogXCJ4QUk6IEdyb2sgNC4xIEZhc3RcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdG91dHB1dDogMC41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDQ5OTk5OTk5OTk5OTk5OTk2LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDMwMDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwieC1haS9ncm9rLTQuMjBcIjoge1xuXHRcdFx0aWQ6IFwieC1haS9ncm9rLTQuMjBcIixcblx0XHRcdG5hbWU6IFwieEFJOiBHcm9rIDQuMjBcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIsXG5cdFx0XHRcdG91dHB1dDogNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjE5OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJ4LWFpL2dyb2stY29kZS1mYXN0LTFcIjoge1xuXHRcdFx0aWQ6IFwieC1haS9ncm9rLWNvZGUtZmFzdC0xXCIsXG5cdFx0XHRuYW1lOiBcInhBSTogR3JvayBDb2RlIEZhc3QgMVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdG91dHB1dDogMS41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDIsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjU2MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInhpYW9taS9taW1vLXYyLWZsYXNoXCI6IHtcblx0XHRcdGlkOiBcInhpYW9taS9taW1vLXYyLWZsYXNoXCIsXG5cdFx0XHRuYW1lOiBcIlhpYW9taTogTWlNby1WMi1GbGFzaFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDksXG5cdFx0XHRcdG91dHB1dDogMC4yOSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA0NSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIxNDQsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwieGlhb21pL21pbW8tdjItb21uaVwiOiB7XG5cdFx0XHRpZDogXCJ4aWFvbWkvbWltby12Mi1vbW5pXCIsXG5cdFx0XHRuYW1lOiBcIlhpYW9taTogTWlNby1WMi1PbW5pXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjM5OTk5OTk5OTk5OTk5OTk3LFxuXHRcdFx0XHRvdXRwdXQ6IDIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wOCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIxNDQsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwieGlhb21pL21pbW8tdjItcHJvXCI6IHtcblx0XHRcdGlkOiBcInhpYW9taS9taW1vLXYyLXByb1wiLFxuXHRcdFx0bmFtZTogXCJYaWFvbWk6IE1pTW8tVjItUHJvXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMSxcblx0XHRcdFx0b3V0cHV0OiAzLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTk5OTk5OTk5OTk5OTk5OTgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogMTMxMDcyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiei1haS9nbG0tNC0zMmJcIjoge1xuXHRcdFx0aWQ6IFwiei1haS9nbG0tNC0zMmJcIixcblx0XHRcdG5hbWU6IFwiWi5haTogR0xNIDQgMzJCIFwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA5OTk5OTk5OTk5OTk5OTk5LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMDk5OTk5OTk5OTk5OTk5OTksXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJ6LWFpL2dsbS00LjVcIjoge1xuXHRcdFx0aWQ6IFwiei1haS9nbG0tNC41XCIsXG5cdFx0XHRuYW1lOiBcIlouYWk6IEdMTSA0LjVcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjYsXG5cdFx0XHRcdG91dHB1dDogMi4yLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTEsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA5ODMwNCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInotYWkvZ2xtLTQuNS1haXJcIjoge1xuXHRcdFx0aWQ6IFwiei1haS9nbG0tNC41LWFpclwiLFxuXHRcdFx0bmFtZTogXCJaLmFpOiBHTE0gNC41IEFpclwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTMsXG5cdFx0XHRcdG91dHB1dDogMC44NSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAyNDk5OTk5OTk5OTk5OTk5OCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDk4MzA0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiei1haS9nbG0tNC41LWFpcjpmcmVlXCI6IHtcblx0XHRcdGlkOiBcInotYWkvZ2xtLTQuNS1haXI6ZnJlZVwiLFxuXHRcdFx0bmFtZTogXCJaLmFpOiBHTE0gNC41IEFpciAoZnJlZSlcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwNzIsXG5cdFx0XHRtYXhUb2tlbnM6IDk2MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiei1haS9nbG0tNC41dlwiOiB7XG5cdFx0XHRpZDogXCJ6LWFpL2dsbS00LjV2XCIsXG5cdFx0XHRuYW1lOiBcIlouYWk6IEdMTSA0LjVWXCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjYsXG5cdFx0XHRcdG91dHB1dDogMS43OTk5OTk5OTk5OTk5OTk4LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTEsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogNjU1MzYsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiei1haS9nbG0tNC42XCI6IHtcblx0XHRcdGlkOiBcInotYWkvZ2xtLTQuNlwiLFxuXHRcdFx0bmFtZTogXCJaLmFpOiBHTE0gNC42XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zOSxcblx0XHRcdFx0b3V0cHV0OiAxLjksXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDQ4MDAsXG5cdFx0XHRtYXhUb2tlbnM6IDIwNDgwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInotYWkvZ2xtLTQuNnZcIjoge1xuXHRcdFx0aWQ6IFwiei1haS9nbG0tNC42dlwiLFxuXHRcdFx0bmFtZTogXCJaLmFpOiBHTE0gNC42VlwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zLFxuXHRcdFx0XHRvdXRwdXQ6IDAuODk5OTk5OTk5OTk5OTk5OSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogMTMxMDcyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwib3BlbmFpLWNvbXBsZXRpb25zXCI+LFxuXHRcdFwiei1haS9nbG0tNC43XCI6IHtcblx0XHRcdGlkOiBcInotYWkvZ2xtLTQuN1wiLFxuXHRcdFx0bmFtZTogXCJaLmFpOiBHTE0gNC43XCIsXG5cdFx0XHRhcGk6IFwib3BlbmFpLWNvbXBsZXRpb25zXCIsXG5cdFx0XHRwcm92aWRlcjogXCJvcGVucm91dGVyXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zOSxcblx0XHRcdFx0b3V0cHV0OiAxLjc1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMTk1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMjc1Mixcblx0XHRcdG1heFRva2VuczogNjU1MzUsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJ6LWFpL2dsbS00LjctZmxhc2hcIjoge1xuXHRcdFx0aWQ6IFwiei1haS9nbG0tNC43LWZsYXNoXCIsXG5cdFx0XHRuYW1lOiBcIlouYWk6IEdMTSA0LjcgRmxhc2hcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA2LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMzk5OTk5OTk5OTk5OTk5OTcsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMTAwMDAwMDAyLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMjc1Mixcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInotYWkvZ2xtLTVcIjoge1xuXHRcdFx0aWQ6IFwiei1haS9nbG0tNVwiLFxuXHRcdFx0bmFtZTogXCJaLmFpOiBHTE0gNVwiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNixcblx0XHRcdFx0b3V0cHV0OiAxLjksXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMTksXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogODAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTA3Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInotYWkvZ2xtLTUtdHVyYm9cIjoge1xuXHRcdFx0aWQ6IFwiei1haS9nbG0tNS10dXJib1wiLFxuXHRcdFx0bmFtZTogXCJaLmFpOiBHTE0gNSBUdXJib1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMixcblx0XHRcdFx0b3V0cHV0OiA0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMjQsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAyNzUyLFxuXHRcdFx0bWF4VG9rZW5zOiAxMzEwNzIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJvcGVuYWktY29tcGxldGlvbnNcIj4sXG5cdFx0XCJ6LWFpL2dsbS01LjFcIjoge1xuXHRcdFx0aWQ6IFwiei1haS9nbG0tNS4xXCIsXG5cdFx0XHRuYW1lOiBcIlouYWk6IEdMTSA1LjFcIixcblx0XHRcdGFwaTogXCJvcGVuYWktY29tcGxldGlvbnNcIixcblx0XHRcdHByb3ZpZGVyOiBcIm9wZW5yb3V0ZXJcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjk1LFxuXHRcdFx0XHRvdXRwdXQ6IDMuMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC40NzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAyNzUyLFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNSxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0XHRcInotYWkvZ2xtLTV2LXR1cmJvXCI6IHtcblx0XHRcdGlkOiBcInotYWkvZ2xtLTV2LXR1cmJvXCIsXG5cdFx0XHRuYW1lOiBcIlouYWk6IEdMTSA1ViBUdXJib1wiLFxuXHRcdFx0YXBpOiBcIm9wZW5haS1jb21wbGV0aW9uc1wiLFxuXHRcdFx0cHJvdmlkZXI6IFwib3BlbnJvdXRlclwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMS4yLFxuXHRcdFx0XHRvdXRwdXQ6IDQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4yNCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDI3NTIsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTA3Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcIm9wZW5haS1jb21wbGV0aW9uc1wiPixcblx0fSBhcyBjb25zdCBzYXRpc2ZpZXMgUmVjb3JkPHN0cmluZywgTW9kZWw8YW55Pj47XG4iXSwKICAibWFwcGluZ3MiOiAiQUFLTyxNQUFNLG9CQUFvQjtBQUFBLEVBQy9CLHdCQUF3QjtBQUFBLElBQ3ZCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHVDQUF1QztBQUFBLElBQ3RDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGlDQUFpQztBQUFBLElBQ2hDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHlCQUF5QjtBQUFBLElBQ3hCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHVCQUF1QjtBQUFBLElBQ3RCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHdCQUF3QjtBQUFBLElBQ3ZCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDBCQUEwQjtBQUFBLElBQ3pCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHNCQUFzQjtBQUFBLElBQ3JCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDRCQUE0QjtBQUFBLElBQzNCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDhCQUE4QjtBQUFBLElBQzdCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLCtCQUErQjtBQUFBLElBQzlCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHdDQUF3QztBQUFBLElBQ3ZDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDhCQUE4QjtBQUFBLElBQzdCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDJCQUEyQjtBQUFBLElBQzFCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDZCQUE2QjtBQUFBLElBQzVCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDZCQUE2QjtBQUFBLElBQzVCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDZCQUE2QjtBQUFBLElBQzVCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDZCQUE2QjtBQUFBLElBQzVCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGtDQUFrQztBQUFBLElBQ2pDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDZCQUE2QjtBQUFBLElBQzVCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLCtCQUErQjtBQUFBLElBQzlCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLCtCQUErQjtBQUFBLElBQzlCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHVDQUF1QztBQUFBLElBQ3RDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLG1DQUFtQztBQUFBLElBQ2xDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHlCQUF5QjtBQUFBLElBQ3hCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDJCQUEyQjtBQUFBLElBQzFCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLFFBQVE7QUFBQSxJQUNQLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDJCQUEyQjtBQUFBLElBQzFCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDhCQUE4QjtBQUFBLElBQzdCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDJCQUEyQjtBQUFBLElBQzFCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGlDQUFpQztBQUFBLElBQ2hDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGdDQUFnQztBQUFBLElBQy9CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGdDQUFnQztBQUFBLElBQy9CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDRCQUE0QjtBQUFBLElBQzNCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGlDQUFpQztBQUFBLElBQ2hDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDBCQUEwQjtBQUFBLElBQ3pCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGtDQUFrQztBQUFBLElBQ2pDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLCtCQUErQjtBQUFBLElBQzlCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHdCQUF3QjtBQUFBLElBQ3ZCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDZCQUE2QjtBQUFBLElBQzVCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLG1DQUFtQztBQUFBLElBQ2xDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDBCQUEwQjtBQUFBLElBQ3pCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDhCQUE4QjtBQUFBLElBQzdCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDhCQUE4QjtBQUFBLElBQzdCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLCtCQUErQjtBQUFBLElBQzlCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLG9DQUFvQztBQUFBLElBQ25DLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDJCQUEyQjtBQUFBLElBQzFCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGdDQUFnQztBQUFBLElBQy9CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGdEQUFnRDtBQUFBLElBQy9DLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHlCQUF5QjtBQUFBLElBQ3hCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGlDQUFpQztBQUFBLElBQ2hDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHVDQUF1QztBQUFBLElBQ3RDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGlDQUFpQztBQUFBLElBQ2hDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHdDQUF3QztBQUFBLElBQ3ZDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGlDQUFpQztBQUFBLElBQ2hDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDZDQUE2QztBQUFBLElBQzVDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDZCQUE2QjtBQUFBLElBQzVCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGtDQUFrQztBQUFBLElBQ2pDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHlCQUF5QjtBQUFBLElBQ3hCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDhCQUE4QjtBQUFBLElBQzdCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHFCQUFxQjtBQUFBLElBQ3BCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHVCQUF1QjtBQUFBLElBQ3RCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDJCQUEyQjtBQUFBLElBQzFCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDhCQUE4QjtBQUFBLElBQzdCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDhCQUE4QjtBQUFBLElBQzdCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGtDQUFrQztBQUFBLElBQ2pDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHFDQUFxQztBQUFBLElBQ3BDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLG9DQUFvQztBQUFBLElBQ25DLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHFDQUFxQztBQUFBLElBQ3BDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDBDQUEwQztBQUFBLElBQ3pDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLCtCQUErQjtBQUFBLElBQzlCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDRCQUE0QjtBQUFBLElBQzNCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHNCQUFzQjtBQUFBLElBQ3JCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHNCQUFzQjtBQUFBLElBQ3JCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHdCQUF3QjtBQUFBLElBQ3ZCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHdCQUF3QjtBQUFBLElBQ3ZCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDZCQUE2QjtBQUFBLElBQzVCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHdCQUF3QjtBQUFBLElBQ3ZCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDRCQUE0QjtBQUFBLElBQzNCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDJCQUEyQjtBQUFBLElBQzFCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDZCQUE2QjtBQUFBLElBQzVCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDRCQUE0QjtBQUFBLElBQzNCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGdDQUFnQztBQUFBLElBQy9CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLCtCQUErQjtBQUFBLElBQzlCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLCtCQUErQjtBQUFBLElBQzlCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDJCQUEyQjtBQUFBLElBQzFCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGdDQUFnQztBQUFBLElBQy9CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGdDQUFnQztBQUFBLElBQy9CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGdDQUFnQztBQUFBLElBQy9CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDhCQUE4QjtBQUFBLElBQzdCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGdDQUFnQztBQUFBLElBQy9CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDBCQUEwQjtBQUFBLElBQ3pCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDBCQUEwQjtBQUFBLElBQ3pCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGdDQUFnQztBQUFBLElBQy9CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDRDQUE0QztBQUFBLElBQzNDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLG9DQUFvQztBQUFBLElBQ25DLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLG9DQUFvQztBQUFBLElBQ25DLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLG1DQUFtQztBQUFBLElBQ2xDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGdDQUFnQztBQUFBLElBQy9CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLG9DQUFvQztBQUFBLElBQ25DLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHNCQUFzQjtBQUFBLElBQ3JCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDJCQUEyQjtBQUFBLElBQzFCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLCtCQUErQjtBQUFBLElBQzlCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHdCQUF3QjtBQUFBLElBQ3ZCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGdDQUFnQztBQUFBLElBQy9CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDBDQUEwQztBQUFBLElBQ3pDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDRDQUE0QztBQUFBLElBQzNDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGtDQUFrQztBQUFBLElBQ2pDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHVDQUF1QztBQUFBLElBQ3RDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHFDQUFxQztBQUFBLElBQ3BDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDBDQUEwQztBQUFBLElBQ3pDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHVDQUF1QztBQUFBLElBQ3RDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDhCQUE4QjtBQUFBLElBQzdCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLG1DQUFtQztBQUFBLElBQ2xDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHdCQUF3QjtBQUFBLElBQ3ZCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDZCQUE2QjtBQUFBLElBQzVCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDRCQUE0QjtBQUFBLElBQzNCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGdCQUFnQjtBQUFBLElBQ2YsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLE1BQU07QUFBQSxJQUNkLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EscUJBQXFCO0FBQUEsSUFDcEIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLE1BQU07QUFBQSxJQUNkLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsNkJBQTZCO0FBQUEsSUFDNUIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLE1BQU07QUFBQSxJQUNkLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0Esc0JBQXNCO0FBQUEsSUFDckIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsOEJBQThCO0FBQUEsSUFDN0IsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLE1BQU07QUFBQSxJQUNkLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0Esa0JBQWtCO0FBQUEsSUFDakIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsdUJBQXVCO0FBQUEsSUFDdEIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsdUJBQXVCO0FBQUEsSUFDdEIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsaUJBQWlCO0FBQUEsSUFDaEIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsNEJBQTRCO0FBQUEsSUFDM0IsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsNEJBQTRCO0FBQUEsSUFDM0IsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsNEJBQTRCO0FBQUEsSUFDM0IsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsK0JBQStCO0FBQUEsSUFDOUIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLE1BQU07QUFBQSxJQUNkLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0Esc0JBQXNCO0FBQUEsSUFDckIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsaUNBQWlDO0FBQUEsSUFDaEMsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsMEJBQTBCO0FBQUEsSUFDekIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsZ0JBQWdCO0FBQUEsSUFDZixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxzQkFBc0I7QUFBQSxJQUNyQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxzQkFBc0I7QUFBQSxJQUNyQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSwyQkFBMkI7QUFBQSxJQUMxQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxxQkFBcUI7QUFBQSxJQUNwQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxxQkFBcUI7QUFBQSxJQUNwQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxvQkFBb0I7QUFBQSxJQUNuQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxrQkFBa0I7QUFBQSxJQUNqQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx1QkFBdUI7QUFBQSxJQUN0QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx3QkFBd0I7QUFBQSxJQUN2QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSw0QkFBNEI7QUFBQSxJQUMzQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSw2QkFBNkI7QUFBQSxJQUM1QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxrQkFBa0I7QUFBQSxJQUNqQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx1QkFBdUI7QUFBQSxJQUN0QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx3QkFBd0I7QUFBQSxJQUN2QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxzQkFBc0I7QUFBQSxJQUNyQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx1QkFBdUI7QUFBQSxJQUN0QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx3QkFBd0I7QUFBQSxJQUN2QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxrQkFBa0I7QUFBQSxJQUNqQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx1QkFBdUI7QUFBQSxJQUN0QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx1QkFBdUI7QUFBQSxJQUN0QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxzQkFBc0I7QUFBQSxJQUNyQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxvQkFBb0I7QUFBQSxJQUNuQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx5QkFBeUI7QUFBQSxJQUN4QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx1QkFBdUI7QUFBQSxJQUN0QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSw0QkFBNEI7QUFBQSxJQUMzQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxzQkFBc0I7QUFBQSxJQUNyQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSwyQkFBMkI7QUFBQSxJQUMxQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxnQ0FBZ0M7QUFBQSxJQUMvQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxhQUFhO0FBQUEsSUFDWixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxhQUFhO0FBQUEsSUFDWixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSwyQkFBMkI7QUFBQSxJQUMxQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxrQkFBa0I7QUFBQSxJQUNqQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx1QkFBdUI7QUFBQSxJQUN0QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxpQkFBaUI7QUFBQSxJQUNoQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxrQkFBa0I7QUFBQSxJQUNqQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxnQ0FBZ0M7QUFBQSxJQUMvQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx1QkFBdUI7QUFBQSxJQUN0QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxtQkFBbUI7QUFBQSxJQUNsQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxtQkFBbUI7QUFBQSxJQUNsQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSwrQkFBK0I7QUFBQSxJQUM5QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSw4QkFBOEI7QUFBQSxJQUM3QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSw2QkFBNkI7QUFBQSxJQUM1QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxpQkFBaUI7QUFBQSxJQUNoQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxrQkFBa0I7QUFBQSxJQUNqQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSw2QkFBNkI7QUFBQSxJQUM1QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxzQ0FBc0M7QUFBQSxJQUNyQyxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxtQkFBbUI7QUFBQSxJQUNsQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxvQkFBb0I7QUFBQSxJQUNuQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxrQkFBa0I7QUFBQSxJQUNqQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx3QkFBd0I7QUFBQSxJQUN2QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSw2QkFBNkI7QUFBQSxJQUM1QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxzQ0FBc0M7QUFBQSxJQUNyQyxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxzQkFBc0I7QUFBQSxJQUNyQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxvQ0FBb0M7QUFBQSxJQUNuQyxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxvQ0FBb0M7QUFBQSxJQUNuQyxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxrQkFBa0I7QUFBQSxJQUNqQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxpQkFBaUI7QUFBQSxJQUNoQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxvQkFBb0I7QUFBQSxJQUNuQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxxQ0FBcUM7QUFBQSxJQUNwQyxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSwwQkFBMEI7QUFBQSxJQUN6QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx5QkFBeUI7QUFBQSxJQUN4QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx5QkFBeUI7QUFBQSxJQUN4QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx5QkFBeUI7QUFBQSxJQUN4QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxrQkFBa0I7QUFBQSxJQUNqQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSwyQkFBMkI7QUFBQSxJQUMxQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxvQ0FBb0M7QUFBQSxJQUNuQyxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx5Q0FBeUM7QUFBQSxJQUN4QyxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxvQ0FBb0M7QUFBQSxJQUNuQyxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxvQ0FBb0M7QUFBQSxJQUNuQyxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxvQ0FBb0M7QUFBQSxJQUNuQyxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxrQ0FBa0M7QUFBQSxJQUNqQyxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxrQ0FBa0M7QUFBQSxJQUNqQyxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSw4QkFBOEI7QUFBQSxJQUM3QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSw2QkFBNkI7QUFBQSxJQUM1QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSw2QkFBNkI7QUFBQSxJQUM1QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSwwQkFBMEI7QUFBQSxJQUN6QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxvQkFBb0I7QUFBQSxJQUNuQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx3QkFBd0I7QUFBQSxJQUN2QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSwwQkFBMEI7QUFBQSxJQUN6QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxtQkFBbUI7QUFBQSxJQUNsQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSw0QkFBNEI7QUFBQSxJQUMzQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSwyQkFBMkI7QUFBQSxJQUMxQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxxQkFBcUI7QUFBQSxJQUNwQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxnQkFBZ0I7QUFBQSxJQUNmLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLG9CQUFvQjtBQUFBLElBQ25CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHdCQUF3QjtBQUFBLElBQ3ZCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHlCQUF5QjtBQUFBLElBQ3hCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDJCQUEyQjtBQUFBLElBQzFCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDBCQUEwQjtBQUFBLElBQ3pCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDRCQUE0QjtBQUFBLElBQzNCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLDZCQUE2QjtBQUFBLElBQzVCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGlDQUFpQztBQUFBLElBQ2hDLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHVCQUF1QjtBQUFBLElBQ3RCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGVBQWU7QUFBQSxJQUNkLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLG9CQUFvQjtBQUFBLElBQ25CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLG9CQUFvQjtBQUFBLElBQ25CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHlCQUF5QjtBQUFBLElBQ3hCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGVBQWU7QUFBQSxJQUNkLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLG9CQUFvQjtBQUFBLElBQ25CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHNCQUFzQjtBQUFBLElBQ3JCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGtCQUFrQjtBQUFBLElBQ2pCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHlCQUF5QjtBQUFBLElBQ3hCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHdCQUF3QjtBQUFBLElBQ3ZCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHVCQUF1QjtBQUFBLElBQ3RCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxRQUFRLE9BQU87QUFBQSxJQUN2QixNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHNCQUFzQjtBQUFBLElBQ3JCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGtCQUFrQjtBQUFBLElBQ2pCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGdCQUFnQjtBQUFBLElBQ2YsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLE1BQU07QUFBQSxJQUNkLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0Esb0JBQW9CO0FBQUEsSUFDbkIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLE1BQU07QUFBQSxJQUNkLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EseUJBQXlCO0FBQUEsSUFDeEIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLE1BQU07QUFBQSxJQUNkLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsaUJBQWlCO0FBQUEsSUFDaEIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsZ0JBQWdCO0FBQUEsSUFDZixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxpQkFBaUI7QUFBQSxJQUNoQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSxnQkFBZ0I7QUFBQSxJQUNmLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLHNCQUFzQjtBQUFBLElBQ3JCLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGNBQWM7QUFBQSxJQUNiLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLG9CQUFvQjtBQUFBLElBQ25CLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULFdBQVc7QUFBQSxJQUNYLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxNQUFNO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxZQUFZO0FBQUEsSUFDYjtBQUFBLElBQ0EsZUFBZTtBQUFBLElBQ2YsV0FBVztBQUFBLEVBQ1o7QUFBQSxFQUNBLGdCQUFnQjtBQUFBLElBQ2YsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLE1BQU07QUFBQSxJQUNkLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EscUJBQXFCO0FBQUEsSUFDcEIsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUNEOyIsCiAgIm5hbWVzIjogW10KfQo=
