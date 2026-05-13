const AMAZON_BEDROCK_MODELS = {
  "amazon.nova-2-lite-v1:0": {
    id: "amazon.nova-2-lite-v1:0",
    name: "Nova 2 Lite",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.33,
      output: 2.75,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "amazon.nova-lite-v1:0": {
    id: "amazon.nova-lite-v1:0",
    name: "Nova Lite",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.06,
      output: 0.24,
      cacheRead: 0.015,
      cacheWrite: 0
    },
    contextWindow: 3e5,
    maxTokens: 8192
  },
  "amazon.nova-micro-v1:0": {
    id: "amazon.nova-micro-v1:0",
    name: "Nova Micro",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.035,
      output: 0.14,
      cacheRead: 875e-5,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 8192
  },
  "amazon.nova-premier-v1:0": {
    id: "amazon.nova-premier-v1:0",
    name: "Nova Premier",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2.5,
      output: 12.5,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 16384
  },
  "amazon.nova-pro-v1:0": {
    id: "amazon.nova-pro-v1:0",
    name: "Nova Pro",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.8,
      output: 3.2,
      cacheRead: 0.2,
      cacheWrite: 0
    },
    contextWindow: 3e5,
    maxTokens: 8192
  },
  "anthropic.claude-3-5-haiku-20241022-v1:0": {
    id: "anthropic.claude-3-5-haiku-20241022-v1:0",
    name: "Claude Haiku 3.5",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "anthropic.claude-3-5-sonnet-20240620-v1:0": {
    id: "anthropic.claude-3-5-sonnet-20240620-v1:0",
    name: "Claude Sonnet 3.5",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
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
  "anthropic.claude-3-5-sonnet-20241022-v2:0": {
    id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    name: "Claude Sonnet 3.5 v2",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
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
  "anthropic.claude-3-7-sonnet-20250219-v1:0": {
    id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
    name: "Claude Sonnet 3.7",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
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
  "anthropic.claude-3-haiku-20240307-v1:0": {
    id: "anthropic.claude-3-haiku-20240307-v1:0",
    name: "Claude Haiku 3",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.25,
      output: 1.25,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 4096
  },
  "anthropic.claude-haiku-4-5-20251001-v1:0": {
    id: "anthropic.claude-haiku-4-5-20251001-v1:0",
    name: "Claude Haiku 4.5",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "anthropic.claude-opus-4-1-20250805-v1:0": {
    id: "anthropic.claude-opus-4-1-20250805-v1:0",
    name: "Claude Opus 4.1",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "anthropic.claude-opus-4-20250514-v1:0": {
    id: "anthropic.claude-opus-4-20250514-v1:0",
    name: "Claude Opus 4",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "anthropic.claude-opus-4-5-20251101-v1:0": {
    id: "anthropic.claude-opus-4-5-20251101-v1:0",
    name: "Claude Opus 4.5",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "anthropic.claude-opus-4-6-v1": {
    id: "anthropic.claude-opus-4-6-v1",
    name: "Claude Opus 4.6",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "anthropic.claude-opus-4-7": {
    id: "anthropic.claude-opus-4-7",
    name: "Claude Opus 4.7",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "anthropic.claude-sonnet-4-20250514-v1:0": {
    id: "anthropic.claude-sonnet-4-20250514-v1:0",
    name: "Claude Sonnet 4",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "anthropic.claude-sonnet-4-5-20250929-v1:0": {
    id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
    name: "Claude Sonnet 4.5",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "anthropic.claude-sonnet-4-6": {
    id: "anthropic.claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "deepseek.r1-v1:0": {
    id: "deepseek.r1-v1:0",
    name: "DeepSeek-R1",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1.35,
      output: 5.4,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 32768
  },
  "deepseek.v3-v1:0": {
    id: "deepseek.v3-v1:0",
    name: "DeepSeek-V3.1",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.58,
      output: 1.68,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 163840,
    maxTokens: 81920
  },
  "deepseek.v3.2": {
    id: "deepseek.v3.2",
    name: "DeepSeek-V3.2",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.62,
      output: 1.85,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 163840,
    maxTokens: 81920
  },
  "eu.anthropic.claude-haiku-4-5-20251001-v1:0": {
    id: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    name: "Claude Haiku 4.5 (EU)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "eu.anthropic.claude-opus-4-5-20251101-v1:0": {
    id: "eu.anthropic.claude-opus-4-5-20251101-v1:0",
    name: "Claude Opus 4.5 (EU)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "eu.anthropic.claude-opus-4-6-v1": {
    id: "eu.anthropic.claude-opus-4-6-v1",
    name: "Claude Opus 4.6 (EU)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "eu.anthropic.claude-opus-4-7": {
    id: "eu.anthropic.claude-opus-4-7",
    name: "Claude Opus 4.7 (EU)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "eu.anthropic.claude-sonnet-4-20250514-v1:0": {
    id: "eu.anthropic.claude-sonnet-4-20250514-v1:0",
    name: "Claude Sonnet 4 (EU)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "eu.anthropic.claude-sonnet-4-5-20250929-v1:0": {
    id: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
    name: "Claude Sonnet 4.5 (EU)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "eu.anthropic.claude-sonnet-4-6": {
    id: "eu.anthropic.claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (EU)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "global.anthropic.claude-haiku-4-5-20251001-v1:0": {
    id: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    name: "Claude Haiku 4.5 (Global)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "global.anthropic.claude-opus-4-5-20251101-v1:0": {
    id: "global.anthropic.claude-opus-4-5-20251101-v1:0",
    name: "Claude Opus 4.5 (Global)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "global.anthropic.claude-opus-4-6-v1": {
    id: "global.anthropic.claude-opus-4-6-v1",
    name: "Claude Opus 4.6 (Global)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "global.anthropic.claude-opus-4-7": {
    id: "global.anthropic.claude-opus-4-7",
    name: "Claude Opus 4.7 (Global)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "global.anthropic.claude-sonnet-4-20250514-v1:0": {
    id: "global.anthropic.claude-sonnet-4-20250514-v1:0",
    name: "Claude Sonnet 4 (Global)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "global.anthropic.claude-sonnet-4-5-20250929-v1:0": {
    id: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    name: "Claude Sonnet 4.5 (Global)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "global.anthropic.claude-sonnet-4-6": {
    id: "global.anthropic.claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Global)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "google.gemma-3-27b-it": {
    id: "google.gemma-3-27b-it",
    name: "Google Gemma 3 27B Instruct",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.12,
      output: 0.2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 202752,
    maxTokens: 8192
  },
  "google.gemma-3-4b-it": {
    id: "google.gemma-3-4b-it",
    name: "Gemma 3 4B IT",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.04,
      output: 0.08,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "meta.llama3-1-405b-instruct-v1:0": {
    id: "meta.llama3-1-405b-instruct-v1:0",
    name: "Llama 3.1 405B Instruct",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 2.4,
      output: 2.4,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "meta.llama3-1-70b-instruct-v1:0": {
    id: "meta.llama3-1-70b-instruct-v1:0",
    name: "Llama 3.1 70B Instruct",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.72,
      output: 0.72,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "meta.llama3-1-8b-instruct-v1:0": {
    id: "meta.llama3-1-8b-instruct-v1:0",
    name: "Llama 3.1 8B Instruct",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.22,
      output: 0.22,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "meta.llama3-2-11b-instruct-v1:0": {
    id: "meta.llama3-2-11b-instruct-v1:0",
    name: "Llama 3.2 11B Instruct",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.16,
      output: 0.16,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "meta.llama3-2-1b-instruct-v1:0": {
    id: "meta.llama3-2-1b-instruct-v1:0",
    name: "Llama 3.2 1B Instruct",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.1,
      output: 0.1,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131e3,
    maxTokens: 4096
  },
  "meta.llama3-2-3b-instruct-v1:0": {
    id: "meta.llama3-2-3b-instruct-v1:0",
    name: "Llama 3.2 3B Instruct",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.15,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131e3,
    maxTokens: 4096
  },
  "meta.llama3-2-90b-instruct-v1:0": {
    id: "meta.llama3-2-90b-instruct-v1:0",
    name: "Llama 3.2 90B Instruct",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.72,
      output: 0.72,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "meta.llama3-3-70b-instruct-v1:0": {
    id: "meta.llama3-3-70b-instruct-v1:0",
    name: "Llama 3.3 70B Instruct",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.72,
      output: 0.72,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "meta.llama4-maverick-17b-instruct-v1:0": {
    id: "meta.llama4-maverick-17b-instruct-v1:0",
    name: "Llama 4 Maverick 17B Instruct",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.24,
      output: 0.97,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 16384
  },
  "meta.llama4-scout-17b-instruct-v1:0": {
    id: "meta.llama4-scout-17b-instruct-v1:0",
    name: "Llama 4 Scout 17B Instruct",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.17,
      output: 0.66,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 35e5,
    maxTokens: 16384
  },
  "minimax.minimax-m2": {
    id: "minimax.minimax-m2",
    name: "MiniMax M2",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 204608,
    maxTokens: 128e3
  },
  "minimax.minimax-m2.1": {
    id: "minimax.minimax-m2.1",
    name: "MiniMax M2.1",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 204800,
    maxTokens: 131072
  },
  "minimax.minimax-m2.5": {
    id: "minimax.minimax-m2.5",
    name: "MiniMax M2.5",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 196608,
    maxTokens: 98304
  },
  "mistral.devstral-2-123b": {
    id: "mistral.devstral-2-123b",
    name: "Devstral 2 123B",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 8192
  },
  "mistral.magistral-small-2509": {
    id: "mistral.magistral-small-2509",
    name: "Magistral Small 1.2",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.5,
      output: 1.5,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4e4
  },
  "mistral.ministral-3-14b-instruct": {
    id: "mistral.ministral-3-14b-instruct",
    name: "Ministral 14B 3.0",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.2,
      output: 0.2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "mistral.ministral-3-3b-instruct": {
    id: "mistral.ministral-3-3b-instruct",
    name: "Ministral 3 3B",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.1,
      output: 0.1,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 8192
  },
  "mistral.ministral-3-8b-instruct": {
    id: "mistral.ministral-3-8b-instruct",
    name: "Ministral 3 8B",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.15,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "mistral.mistral-large-3-675b-instruct": {
    id: "mistral.mistral-large-3-675b-instruct",
    name: "Mistral Large 3",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.5,
      output: 1.5,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 8192
  },
  "mistral.pixtral-large-2502-v1:0": {
    id: "mistral.pixtral-large-2502-v1:0",
    name: "Pixtral Large (25.02)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 8192
  },
  "mistral.voxtral-mini-3b-2507": {
    id: "mistral.voxtral-mini-3b-2507",
    name: "Voxtral Mini 3B 2507",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.04,
      output: 0.04,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "mistral.voxtral-small-24b-2507": {
    id: "mistral.voxtral-small-24b-2507",
    name: "Voxtral Small 24B 2507",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.35,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 32e3,
    maxTokens: 8192
  },
  "moonshot.kimi-k2-thinking": {
    id: "moonshot.kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.6,
      output: 2.5,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 256e3
  },
  "moonshotai.kimi-k2.5": {
    id: "moonshotai.kimi-k2.5",
    name: "Kimi K2.5",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.6,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 256e3
  },
  "nvidia.nemotron-nano-12b-v2": {
    id: "nvidia.nemotron-nano-12b-v2",
    name: "NVIDIA Nemotron Nano 12B v2 VL BF16",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.2,
      output: 0.6,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "nvidia.nemotron-nano-3-30b": {
    id: "nvidia.nemotron-nano-3-30b",
    name: "NVIDIA Nemotron Nano 3 30B",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.06,
      output: 0.24,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "nvidia.nemotron-nano-9b-v2": {
    id: "nvidia.nemotron-nano-9b-v2",
    name: "NVIDIA Nemotron Nano 9B v2",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.06,
      output: 0.23,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "nvidia.nemotron-super-3-120b": {
    id: "nvidia.nemotron-super-3-120b",
    name: "NVIDIA Nemotron 3 Super 120B A12B",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.65,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 131072
  },
  "openai.gpt-oss-120b-1:0": {
    id: "openai.gpt-oss-120b-1:0",
    name: "gpt-oss-120b",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "openai.gpt-oss-20b-1:0": {
    id: "openai.gpt-oss-20b-1:0",
    name: "gpt-oss-20b",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.07,
      output: 0.3,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "openai.gpt-oss-safeguard-120b": {
    id: "openai.gpt-oss-safeguard-120b",
    name: "GPT OSS Safeguard 120B",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "openai.gpt-oss-safeguard-20b": {
    id: "openai.gpt-oss-safeguard-20b",
    name: "GPT OSS Safeguard 20B",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.07,
      output: 0.2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 4096
  },
  "qwen.qwen3-235b-a22b-2507-v1:0": {
    id: "qwen.qwen3-235b-a22b-2507-v1:0",
    name: "Qwen3 235B A22B 2507",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.22,
      output: 0.88,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 131072
  },
  "qwen.qwen3-32b-v1:0": {
    id: "qwen.qwen3-32b-v1:0",
    name: "Qwen3 32B (dense)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 16384,
    maxTokens: 16384
  },
  "qwen.qwen3-coder-30b-a3b-v1:0": {
    id: "qwen.qwen3-coder-30b-a3b-v1:0",
    name: "Qwen3 Coder 30B A3B Instruct",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262144,
    maxTokens: 131072
  },
  "qwen.qwen3-coder-480b-a35b-v1:0": {
    id: "qwen.qwen3-coder-480b-a35b-v1:0",
    name: "Qwen3 Coder 480B A35B Instruct",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.22,
      output: 1.8,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 65536
  },
  "qwen.qwen3-coder-next": {
    id: "qwen.qwen3-coder-next",
    name: "Qwen3 Coder Next",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.22,
      output: 1.8,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 65536
  },
  "qwen.qwen3-next-80b-a3b": {
    id: "qwen.qwen3-next-80b-a3b",
    name: "Qwen/Qwen3-Next-80B-A3B-Instruct",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.14,
      output: 1.4,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262e3,
    maxTokens: 262e3
  },
  "qwen.qwen3-vl-235b-a22b": {
    id: "qwen.qwen3-vl-235b-a22b",
    name: "Qwen/Qwen3-VL-235B-A22B-Instruct",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.3,
      output: 1.5,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 262e3,
    maxTokens: 262e3
  },
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
    id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    name: "Claude Haiku 4.5 (US)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "us.anthropic.claude-opus-4-1-20250805-v1:0": {
    id: "us.anthropic.claude-opus-4-1-20250805-v1:0",
    name: "Claude Opus 4.1 (US)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "us.anthropic.claude-opus-4-20250514-v1:0": {
    id: "us.anthropic.claude-opus-4-20250514-v1:0",
    name: "Claude Opus 4 (US)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "us.anthropic.claude-opus-4-5-20251101-v1:0": {
    id: "us.anthropic.claude-opus-4-5-20251101-v1:0",
    name: "Claude Opus 4.5 (US)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "us.anthropic.claude-opus-4-6-v1": {
    id: "us.anthropic.claude-opus-4-6-v1",
    name: "Claude Opus 4.6 (US)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "us.anthropic.claude-opus-4-7": {
    id: "us.anthropic.claude-opus-4-7",
    name: "Claude Opus 4.7 (US)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "us.anthropic.claude-sonnet-4-20250514-v1:0": {
    id: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    name: "Claude Sonnet 4 (US)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
    id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    name: "Claude Sonnet 4.5 (US)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "us.anthropic.claude-sonnet-4-6": {
    id: "us.anthropic.claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (US)",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
  "writer.palmyra-x4-v1:0": {
    id: "writer.palmyra-x4-v1:0",
    name: "Palmyra X4",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 2.5,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 122880,
    maxTokens: 8192
  },
  "writer.palmyra-x5-v1:0": {
    id: "writer.palmyra-x5-v1:0",
    name: "Palmyra X5",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.6,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 104e4,
    maxTokens: 8192
  },
  "zai.glm-4.7": {
    id: "zai.glm-4.7",
    name: "GLM-4.7",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.6,
      output: 2.2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 204800,
    maxTokens: 131072
  },
  "zai.glm-4.7-flash": {
    id: "zai.glm-4.7-flash",
    name: "GLM-4.7-Flash",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.07,
      output: 0.4,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 2e5,
    maxTokens: 131072
  },
  "zai.glm-5": {
    id: "zai.glm-5",
    name: "GLM-5",
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 1,
      output: 3.2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 202752,
    maxTokens: 101376
  }
};
export {
  AMAZON_BEDROCK_MODELS
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL21vZGVscy9nZW5lcmF0ZWQvYW1hem9uLWJlZHJvY2sudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFRoaXMgZmlsZSBpcyBhdXRvLWdlbmVyYXRlZCBieSBzY3JpcHRzL2dlbmVyYXRlLW1vZGVscy50c1xuLy8gRG8gbm90IGVkaXQgbWFudWFsbHkgLSBydW4gJ25wbSBydW4gZ2VuZXJhdGUtbW9kZWxzJyB0byB1cGRhdGVcblxuaW1wb3J0IHR5cGUgeyBNb2RlbCB9IGZyb20gXCIuLi8uLi90eXBlcy5qc1wiO1xuXG5leHBvcnQgY29uc3QgQU1BWk9OX0JFRFJPQ0tfTU9ERUxTID0ge1xuXHRcdFwiYW1hem9uLm5vdmEtMi1saXRlLXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwiYW1hem9uLm5vdmEtMi1saXRlLXYxOjBcIixcblx0XHRcdG5hbWU6IFwiTm92YSAyIExpdGVcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zMyxcblx0XHRcdFx0b3V0cHV0OiAyLjc1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJhbWF6b24ubm92YS1saXRlLXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwiYW1hem9uLm5vdmEtbGl0ZS12MTowXCIsXG5cdFx0XHRuYW1lOiBcIk5vdmEgTGl0ZVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA2LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMjQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMTUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMzAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJhbWF6b24ubm92YS1taWNyby12MTowXCI6IHtcblx0XHRcdGlkOiBcImFtYXpvbi5ub3ZhLW1pY3JvLXYxOjBcIixcblx0XHRcdG5hbWU6IFwiTm92YSBNaWNyb1wiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wMzUsXG5cdFx0XHRcdG91dHB1dDogMC4xNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAwODc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiYW1hem9uLm5vdmEtcHJlbWllci12MTowXCI6IHtcblx0XHRcdGlkOiBcImFtYXpvbi5ub3ZhLXByZW1pZXItdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJOb3ZhIFByZW1pZXJcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLjUsXG5cdFx0XHRcdG91dHB1dDogMTIuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJhbWF6b24ubm92YS1wcm8tdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJhbWF6b24ubm92YS1wcm8tdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJOb3ZhIFByb1wiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjgsXG5cdFx0XHRcdG91dHB1dDogMy4yLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAzMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcImFudGhyb3BpYy5jbGF1ZGUtMy01LWhhaWt1LTIwMjQxMDIyLXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwiYW50aHJvcGljLmNsYXVkZS0zLTUtaGFpa3UtMjAyNDEwMjItdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgSGFpa3UgMy41XCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuOCxcblx0XHRcdFx0b3V0cHV0OiA0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDgsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDEsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJhbnRocm9waWMuY2xhdWRlLTMtNS1zb25uZXQtMjAyNDA2MjAtdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMuY2xhdWRlLTMtNS1zb25uZXQtMjAyNDA2MjAtdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgU29ubmV0IDMuNVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAzLFxuXHRcdFx0XHRvdXRwdXQ6IDE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMy43NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcImFudGhyb3BpYy5jbGF1ZGUtMy01LXNvbm5ldC0yMDI0MTAyMi12MjowXCI6IHtcblx0XHRcdGlkOiBcImFudGhyb3BpYy5jbGF1ZGUtMy01LXNvbm5ldC0yMDI0MTAyMi12MjowXCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBTb25uZXQgMy41IHYyXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDMsXG5cdFx0XHRcdG91dHB1dDogMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4zLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAzLjc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiYW50aHJvcGljLmNsYXVkZS0zLTctc29ubmV0LTIwMjUwMjE5LXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwiYW50aHJvcGljLmNsYXVkZS0zLTctc29ubmV0LTIwMjUwMjE5LXYxOjBcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIFNvbm5ldCAzLjdcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMyxcblx0XHRcdFx0b3V0cHV0OiAxNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDMuNzUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJhbnRocm9waWMuY2xhdWRlLTMtaGFpa3UtMjAyNDAzMDctdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMuY2xhdWRlLTMtaGFpa3UtMjAyNDAzMDctdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgSGFpa3UgM1wiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDEuMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcImFudGhyb3BpYy5jbGF1ZGUtaGFpa3UtNC01LTIwMjUxMDAxLXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwiYW50aHJvcGljLmNsYXVkZS1oYWlrdS00LTUtMjAyNTEwMDEtdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgSGFpa3UgNC41XCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMSxcblx0XHRcdFx0b3V0cHV0OiA1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMS4yNSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJhbnRocm9waWMuY2xhdWRlLW9wdXMtNC0xLTIwMjUwODA1LXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwiYW50aHJvcGljLmNsYXVkZS1vcHVzLTQtMS0yMDI1MDgwNS12MTowXCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBPcHVzIDQuMVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDE1LFxuXHRcdFx0XHRvdXRwdXQ6IDc1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDEuNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMTguNzUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiYW50aHJvcGljLmNsYXVkZS1vcHVzLTQtMjAyNTA1MTQtdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMuY2xhdWRlLW9wdXMtNC0yMDI1MDUxNC12MTowXCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBPcHVzIDRcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxNSxcblx0XHRcdFx0b3V0cHV0OiA3NSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAxLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDE4Ljc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMzIwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcImFudGhyb3BpYy5jbGF1ZGUtb3B1cy00LTUtMjAyNTExMDEtdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMuY2xhdWRlLW9wdXMtNC01LTIwMjUxMTAxLXYxOjBcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIE9wdXMgNC41XCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogNSxcblx0XHRcdFx0b3V0cHV0OiAyNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDYuMjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiYW50aHJvcGljLmNsYXVkZS1vcHVzLTQtNi12MVwiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMuY2xhdWRlLW9wdXMtNC02LXYxXCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBPcHVzIDQuNlwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDUsXG5cdFx0XHRcdG91dHB1dDogMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiA2LjI1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiYW50aHJvcGljLmNsYXVkZS1vcHVzLTQtN1wiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMuY2xhdWRlLW9wdXMtNC03XCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBPcHVzIDQuN1wiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDUsXG5cdFx0XHRcdG91dHB1dDogMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiA2LjI1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNC12MTowXCI6IHtcblx0XHRcdGlkOiBcImFudGhyb3BpYy5jbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTQtdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgU29ubmV0IDRcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAzLFxuXHRcdFx0XHRvdXRwdXQ6IDE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMy43NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJhbnRocm9waWMuY2xhdWRlLXNvbm5ldC00LTUtMjAyNTA5MjktdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMuY2xhdWRlLXNvbm5ldC00LTUtMjAyNTA5MjktdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgU29ubmV0IDQuNVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDMsXG5cdFx0XHRcdG91dHB1dDogMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4zLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAzLjc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcImFudGhyb3BpYy5jbGF1ZGUtc29ubmV0LTQtNlwiOiB7XG5cdFx0XHRpZDogXCJhbnRocm9waWMuY2xhdWRlLXNvbm5ldC00LTZcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIFNvbm5ldCA0LjZcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAzLFxuXHRcdFx0XHRvdXRwdXQ6IDE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMy43NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiZGVlcHNlZWsucjEtdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJkZWVwc2Vlay5yMS12MTowXCIsXG5cdFx0XHRuYW1lOiBcIkRlZXBTZWVrLVIxXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMzUsXG5cdFx0XHRcdG91dHB1dDogNS40LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiZGVlcHNlZWsudjMtdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJkZWVwc2Vlay52My12MTowXCIsXG5cdFx0XHRuYW1lOiBcIkRlZXBTZWVrLVYzLjFcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC41OCxcblx0XHRcdFx0b3V0cHV0OiAxLjY4LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTYzODQwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiZGVlcHNlZWsudjMuMlwiOiB7XG5cdFx0XHRpZDogXCJkZWVwc2Vlay52My4yXCIsXG5cdFx0XHRuYW1lOiBcIkRlZXBTZWVrLVYzLjJcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC42Mixcblx0XHRcdFx0b3V0cHV0OiAxLjg1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTYzODQwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiZXUuYW50aHJvcGljLmNsYXVkZS1oYWlrdS00LTUtMjAyNTEwMDEtdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJldS5hbnRocm9waWMuY2xhdWRlLWhhaWt1LTQtNS0yMDI1MTAwMS12MTowXCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBIYWlrdSA0LjUgKEVVKVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEsXG5cdFx0XHRcdG91dHB1dDogNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjEsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDEuMjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiZXUuYW50aHJvcGljLmNsYXVkZS1vcHVzLTQtNS0yMDI1MTEwMS12MTowXCI6IHtcblx0XHRcdGlkOiBcImV1LmFudGhyb3BpYy5jbGF1ZGUtb3B1cy00LTUtMjAyNTExMDEtdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgT3B1cyA0LjUgKEVVKVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDUsXG5cdFx0XHRcdG91dHB1dDogMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiA2LjI1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcImV1LmFudGhyb3BpYy5jbGF1ZGUtb3B1cy00LTYtdjFcIjoge1xuXHRcdFx0aWQ6IFwiZXUuYW50aHJvcGljLmNsYXVkZS1vcHVzLTQtNi12MVwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgT3B1cyA0LjYgKEVVKVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDUsXG5cdFx0XHRcdG91dHB1dDogMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiA2LjI1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiZXUuYW50aHJvcGljLmNsYXVkZS1vcHVzLTQtN1wiOiB7XG5cdFx0XHRpZDogXCJldS5hbnRocm9waWMuY2xhdWRlLW9wdXMtNC03XCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBPcHVzIDQuNyAoRVUpXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogNSxcblx0XHRcdFx0b3V0cHV0OiAyNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDYuMjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJldS5hbnRocm9waWMuY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0LXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwiZXUuYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNC12MTowXCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBTb25uZXQgNCAoRVUpXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMyxcblx0XHRcdFx0b3V0cHV0OiAxNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDMuNzUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiZXUuYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5LXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwiZXUuYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5LXYxOjBcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIFNvbm5ldCA0LjUgKEVVKVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDMsXG5cdFx0XHRcdG91dHB1dDogMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4zLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAzLjc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcImV1LmFudGhyb3BpYy5jbGF1ZGUtc29ubmV0LTQtNlwiOiB7XG5cdFx0XHRpZDogXCJldS5hbnRocm9waWMuY2xhdWRlLXNvbm5ldC00LTZcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIFNvbm5ldCA0LjYgKEVVKVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDMsXG5cdFx0XHRcdG91dHB1dDogMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4zLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAzLjc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJnbG9iYWwuYW50aHJvcGljLmNsYXVkZS1oYWlrdS00LTUtMjAyNTEwMDEtdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJnbG9iYWwuYW50aHJvcGljLmNsYXVkZS1oYWlrdS00LTUtMjAyNTEwMDEtdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgSGFpa3UgNC41IChHbG9iYWwpXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMSxcblx0XHRcdFx0b3V0cHV0OiA1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMS4yNSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJnbG9iYWwuYW50aHJvcGljLmNsYXVkZS1vcHVzLTQtNS0yMDI1MTEwMS12MTowXCI6IHtcblx0XHRcdGlkOiBcImdsb2JhbC5hbnRocm9waWMuY2xhdWRlLW9wdXMtNC01LTIwMjUxMTAxLXYxOjBcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIE9wdXMgNC41IChHbG9iYWwpXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogNSxcblx0XHRcdFx0b3V0cHV0OiAyNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDYuMjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiZ2xvYmFsLmFudGhyb3BpYy5jbGF1ZGUtb3B1cy00LTYtdjFcIjoge1xuXHRcdFx0aWQ6IFwiZ2xvYmFsLmFudGhyb3BpYy5jbGF1ZGUtb3B1cy00LTYtdjFcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIE9wdXMgNC42IChHbG9iYWwpXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogNSxcblx0XHRcdFx0b3V0cHV0OiAyNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDYuMjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJnbG9iYWwuYW50aHJvcGljLmNsYXVkZS1vcHVzLTQtN1wiOiB7XG5cdFx0XHRpZDogXCJnbG9iYWwuYW50aHJvcGljLmNsYXVkZS1vcHVzLTQtN1wiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgT3B1cyA0LjcgKEdsb2JhbClcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiA1LFxuXHRcdFx0XHRvdXRwdXQ6IDI1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogNi4yNSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMjgwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcImdsb2JhbC5hbnRocm9waWMuY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0LXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwiZ2xvYmFsLmFudGhyb3BpYy5jbGF1ZGUtc29ubmV0LTQtMjAyNTA1MTQtdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgU29ubmV0IDQgKEdsb2JhbClcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAzLFxuXHRcdFx0XHRvdXRwdXQ6IDE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMy43NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJnbG9iYWwuYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5LXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwiZ2xvYmFsLmFudGhyb3BpYy5jbGF1ZGUtc29ubmV0LTQtNS0yMDI1MDkyOS12MTowXCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBTb25uZXQgNC41IChHbG9iYWwpXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMyxcblx0XHRcdFx0b3V0cHV0OiAxNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDMuNzUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiZ2xvYmFsLmFudGhyb3BpYy5jbGF1ZGUtc29ubmV0LTQtNlwiOiB7XG5cdFx0XHRpZDogXCJnbG9iYWwuYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC02XCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBTb25uZXQgNC42IChHbG9iYWwpXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMyxcblx0XHRcdFx0b3V0cHV0OiAxNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDMuNzUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcImdvb2dsZS5nZW1tYS0zLTI3Yi1pdFwiOiB7XG5cdFx0XHRpZDogXCJnb29nbGUuZ2VtbWEtMy0yN2ItaXRcIixcblx0XHRcdG5hbWU6IFwiR29vZ2xlIEdlbW1hIDMgMjdCIEluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTIsXG5cdFx0XHRcdG91dHB1dDogMC4yLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAyNzUyLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJnb29nbGUuZ2VtbWEtMy00Yi1pdFwiOiB7XG5cdFx0XHRpZDogXCJnb29nbGUuZ2VtbWEtMy00Yi1pdFwiLFxuXHRcdFx0bmFtZTogXCJHZW1tYSAzIDRCIElUXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDQsXG5cdFx0XHRcdG91dHB1dDogMC4wOCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwibWV0YS5sbGFtYTMtMS00MDViLWluc3RydWN0LXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwibWV0YS5sbGFtYTMtMS00MDViLWluc3RydWN0LXYxOjBcIixcblx0XHRcdG5hbWU6IFwiTGxhbWEgMy4xIDQwNUIgSW5zdHJ1Y3RcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIuNCxcblx0XHRcdFx0b3V0cHV0OiAyLjQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcIm1ldGEubGxhbWEzLTEtNzBiLWluc3RydWN0LXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwibWV0YS5sbGFtYTMtMS03MGItaW5zdHJ1Y3QtdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJMbGFtYSAzLjEgNzBCIEluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjcyLFxuXHRcdFx0XHRvdXRwdXQ6IDAuNzIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcIm1ldGEubGxhbWEzLTEtOGItaW5zdHJ1Y3QtdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJtZXRhLmxsYW1hMy0xLThiLWluc3RydWN0LXYxOjBcIixcblx0XHRcdG5hbWU6IFwiTGxhbWEgMy4xIDhCIEluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjIyLFxuXHRcdFx0XHRvdXRwdXQ6IDAuMjIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcIm1ldGEubGxhbWEzLTItMTFiLWluc3RydWN0LXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwibWV0YS5sbGFtYTMtMi0xMWItaW5zdHJ1Y3QtdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJMbGFtYSAzLjIgMTFCIEluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTYsXG5cdFx0XHRcdG91dHB1dDogMC4xNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwibWV0YS5sbGFtYTMtMi0xYi1pbnN0cnVjdC12MTowXCI6IHtcblx0XHRcdGlkOiBcIm1ldGEubGxhbWEzLTItMWItaW5zdHJ1Y3QtdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJMbGFtYSAzLjIgMUIgSW5zdHJ1Y3RcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMSxcblx0XHRcdFx0b3V0cHV0OiAwLjEsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcIm1ldGEubGxhbWEzLTItM2ItaW5zdHJ1Y3QtdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJtZXRhLmxsYW1hMy0yLTNiLWluc3RydWN0LXYxOjBcIixcblx0XHRcdG5hbWU6IFwiTGxhbWEgMy4yIDNCIEluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE1LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMzEwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcIm1ldGEubGxhbWEzLTItOTBiLWluc3RydWN0LXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwibWV0YS5sbGFtYTMtMi05MGItaW5zdHJ1Y3QtdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJMbGFtYSAzLjIgOTBCIEluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNzIsXG5cdFx0XHRcdG91dHB1dDogMC43Mixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwibWV0YS5sbGFtYTMtMy03MGItaW5zdHJ1Y3QtdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJtZXRhLmxsYW1hMy0zLTcwYi1pbnN0cnVjdC12MTowXCIsXG5cdFx0XHRuYW1lOiBcIkxsYW1hIDMuMyA3MEIgSW5zdHJ1Y3RcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNzIsXG5cdFx0XHRcdG91dHB1dDogMC43Mixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwibWV0YS5sbGFtYTQtbWF2ZXJpY2stMTdiLWluc3RydWN0LXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwibWV0YS5sbGFtYTQtbWF2ZXJpY2stMTdiLWluc3RydWN0LXYxOjBcIixcblx0XHRcdG5hbWU6IFwiTGxhbWEgNCBNYXZlcmljayAxN0IgSW5zdHJ1Y3RcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4yNCxcblx0XHRcdFx0b3V0cHV0OiAwLjk3LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcIm1ldGEubGxhbWE0LXNjb3V0LTE3Yi1pbnN0cnVjdC12MTowXCI6IHtcblx0XHRcdGlkOiBcIm1ldGEubGxhbWE0LXNjb3V0LTE3Yi1pbnN0cnVjdC12MTowXCIsXG5cdFx0XHRuYW1lOiBcIkxsYW1hIDQgU2NvdXQgMTdCIEluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTcsXG5cdFx0XHRcdG91dHB1dDogMC42Nixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDM1MDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDE2Mzg0LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJtaW5pbWF4Lm1pbmltYXgtbTJcIjoge1xuXHRcdFx0aWQ6IFwibWluaW1heC5taW5pbWF4LW0yXCIsXG5cdFx0XHRuYW1lOiBcIk1pbmlNYXggTTJcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zLFxuXHRcdFx0XHRvdXRwdXQ6IDEuMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwNDYwOCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJtaW5pbWF4Lm1pbmltYXgtbTIuMVwiOiB7XG5cdFx0XHRpZDogXCJtaW5pbWF4Lm1pbmltYXgtbTIuMVwiLFxuXHRcdFx0bmFtZTogXCJNaW5pTWF4IE0yLjFcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zLFxuXHRcdFx0XHRvdXRwdXQ6IDEuMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwNDgwMCxcblx0XHRcdG1heFRva2VuczogMTMxMDcyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJtaW5pbWF4Lm1pbmltYXgtbTIuNVwiOiB7XG5cdFx0XHRpZDogXCJtaW5pbWF4Lm1pbmltYXgtbTIuNVwiLFxuXHRcdFx0bmFtZTogXCJNaW5pTWF4IE0yLjVcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zLFxuXHRcdFx0XHRvdXRwdXQ6IDEuMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDE5NjYwOCxcblx0XHRcdG1heFRva2VuczogOTgzMDQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcIm1pc3RyYWwuZGV2c3RyYWwtMi0xMjNiXCI6IHtcblx0XHRcdGlkOiBcIm1pc3RyYWwuZGV2c3RyYWwtMi0xMjNiXCIsXG5cdFx0XHRuYW1lOiBcIkRldnN0cmFsIDIgMTIzQlwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC40LFxuXHRcdFx0XHRvdXRwdXQ6IDIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNTYwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcIm1pc3RyYWwubWFnaXN0cmFsLXNtYWxsLTI1MDlcIjoge1xuXHRcdFx0aWQ6IFwibWlzdHJhbC5tYWdpc3RyYWwtc21hbGwtMjUwOVwiLFxuXHRcdFx0bmFtZTogXCJNYWdpc3RyYWwgU21hbGwgMS4yXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC41LFxuXHRcdFx0XHRvdXRwdXQ6IDEuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogNDAwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcIm1pc3RyYWwubWluaXN0cmFsLTMtMTRiLWluc3RydWN0XCI6IHtcblx0XHRcdGlkOiBcIm1pc3RyYWwubWluaXN0cmFsLTMtMTRiLWluc3RydWN0XCIsXG5cdFx0XHRuYW1lOiBcIk1pbmlzdHJhbCAxNEIgMy4wXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjIsXG5cdFx0XHRcdG91dHB1dDogMC4yLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJtaXN0cmFsLm1pbmlzdHJhbC0zLTNiLWluc3RydWN0XCI6IHtcblx0XHRcdGlkOiBcIm1pc3RyYWwubWluaXN0cmFsLTMtM2ItaW5zdHJ1Y3RcIixcblx0XHRcdG5hbWU6IFwiTWluaXN0cmFsIDMgM0JcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xLFxuXHRcdFx0XHRvdXRwdXQ6IDAuMSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI1NjAwMCxcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwibWlzdHJhbC5taW5pc3RyYWwtMy04Yi1pbnN0cnVjdFwiOiB7XG5cdFx0XHRpZDogXCJtaXN0cmFsLm1pbmlzdHJhbC0zLThiLWluc3RydWN0XCIsXG5cdFx0XHRuYW1lOiBcIk1pbmlzdHJhbCAzIDhCXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE1LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcIm1pc3RyYWwubWlzdHJhbC1sYXJnZS0zLTY3NWItaW5zdHJ1Y3RcIjoge1xuXHRcdFx0aWQ6IFwibWlzdHJhbC5taXN0cmFsLWxhcmdlLTMtNjc1Yi1pbnN0cnVjdFwiLFxuXHRcdFx0bmFtZTogXCJNaXN0cmFsIExhcmdlIDNcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC41LFxuXHRcdFx0XHRvdXRwdXQ6IDEuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI1NjAwMCxcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwibWlzdHJhbC5waXh0cmFsLWxhcmdlLTI1MDItdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJtaXN0cmFsLnBpeHRyYWwtbGFyZ2UtMjUwMi12MTowXCIsXG5cdFx0XHRuYW1lOiBcIlBpeHRyYWwgTGFyZ2UgKDI1LjAyKVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLFxuXHRcdFx0XHRvdXRwdXQ6IDYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcIm1pc3RyYWwudm94dHJhbC1taW5pLTNiLTI1MDdcIjoge1xuXHRcdFx0aWQ6IFwibWlzdHJhbC52b3h0cmFsLW1pbmktM2ItMjUwN1wiLFxuXHRcdFx0bmFtZTogXCJWb3h0cmFsIE1pbmkgM0IgMjUwN1wiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNCxcblx0XHRcdFx0b3V0cHV0OiAwLjA0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJtaXN0cmFsLnZveHRyYWwtc21hbGwtMjRiLTI1MDdcIjoge1xuXHRcdFx0aWQ6IFwibWlzdHJhbC52b3h0cmFsLXNtYWxsLTI0Yi0yNTA3XCIsXG5cdFx0XHRuYW1lOiBcIlZveHRyYWwgU21hbGwgMjRCIDI1MDdcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTUsXG5cdFx0XHRcdG91dHB1dDogMC4zNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDMyMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJtb29uc2hvdC5raW1pLWsyLXRoaW5raW5nXCI6IHtcblx0XHRcdGlkOiBcIm1vb25zaG90LmtpbWktazItdGhpbmtpbmdcIixcblx0XHRcdG5hbWU6IFwiS2ltaSBLMiBUaGlua2luZ1wiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjYsXG5cdFx0XHRcdG91dHB1dDogMi41LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjU2MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAyNTYwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcIm1vb25zaG90YWkua2ltaS1rMi41XCI6IHtcblx0XHRcdGlkOiBcIm1vb25zaG90YWkua2ltaS1rMi41XCIsXG5cdFx0XHRuYW1lOiBcIktpbWkgSzIuNVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNixcblx0XHRcdFx0b3V0cHV0OiAzLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjU2MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAyNTYwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcIm52aWRpYS5uZW1vdHJvbi1uYW5vLTEyYi12MlwiOiB7XG5cdFx0XHRpZDogXCJudmlkaWEubmVtb3Ryb24tbmFuby0xMmItdjJcIixcblx0XHRcdG5hbWU6IFwiTlZJRElBIE5lbW90cm9uIE5hbm8gMTJCIHYyIFZMIEJGMTZcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4yLFxuXHRcdFx0XHRvdXRwdXQ6IDAuNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwibnZpZGlhLm5lbW90cm9uLW5hbm8tMy0zMGJcIjoge1xuXHRcdFx0aWQ6IFwibnZpZGlhLm5lbW90cm9uLW5hbm8tMy0zMGJcIixcblx0XHRcdG5hbWU6IFwiTlZJRElBIE5lbW90cm9uIE5hbm8gMyAzMEJcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNixcblx0XHRcdFx0b3V0cHV0OiAwLjI0LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJudmlkaWEubmVtb3Ryb24tbmFuby05Yi12MlwiOiB7XG5cdFx0XHRpZDogXCJudmlkaWEubmVtb3Ryb24tbmFuby05Yi12MlwiLFxuXHRcdFx0bmFtZTogXCJOVklESUEgTmVtb3Ryb24gTmFubyA5QiB2MlwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNixcblx0XHRcdFx0b3V0cHV0OiAwLjIzLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJudmlkaWEubmVtb3Ryb24tc3VwZXItMy0xMjBiXCI6IHtcblx0XHRcdGlkOiBcIm52aWRpYS5uZW1vdHJvbi1zdXBlci0zLTEyMGJcIixcblx0XHRcdG5hbWU6IFwiTlZJRElBIE5lbW90cm9uIDMgU3VwZXIgMTIwQiBBMTJCXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTUsXG5cdFx0XHRcdG91dHB1dDogMC42NSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogMTMxMDcyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJvcGVuYWkuZ3B0LW9zcy0xMjBiLTE6MFwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkuZ3B0LW9zcy0xMjBiLTE6MFwiLFxuXHRcdFx0bmFtZTogXCJncHQtb3NzLTEyMGJcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTUsXG5cdFx0XHRcdG91dHB1dDogMC42LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJvcGVuYWkuZ3B0LW9zcy0yMGItMTowXCI6IHtcblx0XHRcdGlkOiBcIm9wZW5haS5ncHQtb3NzLTIwYi0xOjBcIixcblx0XHRcdG5hbWU6IFwiZ3B0LW9zcy0yMGJcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDcsXG5cdFx0XHRcdG91dHB1dDogMC4zLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTI4MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA0MDk2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJvcGVuYWkuZ3B0LW9zcy1zYWZlZ3VhcmQtMTIwYlwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkuZ3B0LW9zcy1zYWZlZ3VhcmQtMTIwYlwiLFxuXHRcdFx0bmFtZTogXCJHUFQgT1NTIFNhZmVndWFyZCAxMjBCXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjE1LFxuXHRcdFx0XHRvdXRwdXQ6IDAuNixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogNDA5Nixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwib3BlbmFpLmdwdC1vc3Mtc2FmZWd1YXJkLTIwYlwiOiB7XG5cdFx0XHRpZDogXCJvcGVuYWkuZ3B0LW9zcy1zYWZlZ3VhcmQtMjBiXCIsXG5cdFx0XHRuYW1lOiBcIkdQVCBPU1MgU2FmZWd1YXJkIDIwQlwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNyxcblx0XHRcdFx0b3V0cHV0OiAwLjIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjgwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDQwOTYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcInF3ZW4ucXdlbjMtMjM1Yi1hMjJiLTI1MDctdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJxd2VuLnF3ZW4zLTIzNWItYTIyYi0yNTA3LXYxOjBcIixcblx0XHRcdG5hbWU6IFwiUXdlbjMgMjM1QiBBMjJCIDI1MDdcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjIsXG5cdFx0XHRcdG91dHB1dDogMC44OCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDI2MjE0NCxcblx0XHRcdG1heFRva2VuczogMTMxMDcyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJxd2VuLnF3ZW4zLTMyYi12MTowXCI6IHtcblx0XHRcdGlkOiBcInF3ZW4ucXdlbjMtMzJiLXYxOjBcIixcblx0XHRcdG5hbWU6IFwiUXdlbjMgMzJCIChkZW5zZSlcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNSxcblx0XHRcdFx0b3V0cHV0OiAwLjYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxNjM4NCxcblx0XHRcdG1heFRva2VuczogMTYzODQsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcInF3ZW4ucXdlbjMtY29kZXItMzBiLWEzYi12MTowXCI6IHtcblx0XHRcdGlkOiBcInF3ZW4ucXdlbjMtY29kZXItMzBiLWEzYi12MTowXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW4zIENvZGVyIDMwQiBBM0IgSW5zdHJ1Y3RcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTUsXG5cdFx0XHRcdG91dHB1dDogMC42LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMTQ0LFxuXHRcdFx0bWF4VG9rZW5zOiAxMzEwNzIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcInF3ZW4ucXdlbjMtY29kZXItNDgwYi1hMzViLXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi5xd2VuMy1jb2Rlci00ODBiLWEzNWItdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJRd2VuMyBDb2RlciA0ODBCIEEzNUIgSW5zdHJ1Y3RcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjIsXG5cdFx0XHRcdG91dHB1dDogMS44LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwicXdlbi5xd2VuMy1jb2Rlci1uZXh0XCI6IHtcblx0XHRcdGlkOiBcInF3ZW4ucXdlbjMtY29kZXItbmV4dFwiLFxuXHRcdFx0bmFtZTogXCJRd2VuMyBDb2RlciBOZXh0XCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMjIsXG5cdFx0XHRcdG91dHB1dDogMS44LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwicXdlbi5xd2VuMy1uZXh0LTgwYi1hM2JcIjoge1xuXHRcdFx0aWQ6IFwicXdlbi5xd2VuMy1uZXh0LTgwYi1hM2JcIixcblx0XHRcdG5hbWU6IFwiUXdlbi9Rd2VuMy1OZXh0LTgwQi1BM0ItSW5zdHJ1Y3RcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMTQsXG5cdFx0XHRcdG91dHB1dDogMS40LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjYyMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAyNjIwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcInF3ZW4ucXdlbjMtdmwtMjM1Yi1hMjJiXCI6IHtcblx0XHRcdGlkOiBcInF3ZW4ucXdlbjMtdmwtMjM1Yi1hMjJiXCIsXG5cdFx0XHRuYW1lOiBcIlF3ZW4vUXdlbjMtVkwtMjM1Qi1BMjJCLUluc3RydWN0XCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMyxcblx0XHRcdFx0b3V0cHV0OiAxLjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyNjIwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDI2MjAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwidXMuYW50aHJvcGljLmNsYXVkZS1oYWlrdS00LTUtMjAyNTEwMDEtdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJ1cy5hbnRocm9waWMuY2xhdWRlLWhhaWt1LTQtNS0yMDI1MTAwMS12MTowXCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBIYWlrdSA0LjUgKFVTKVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEsXG5cdFx0XHRcdG91dHB1dDogNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjEsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDEuMjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwidXMuYW50aHJvcGljLmNsYXVkZS1vcHVzLTQtMS0yMDI1MDgwNS12MTowXCI6IHtcblx0XHRcdGlkOiBcInVzLmFudGhyb3BpYy5jbGF1ZGUtb3B1cy00LTEtMjAyNTA4MDUtdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgT3B1cyA0LjEgKFVTKVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDE1LFxuXHRcdFx0XHRvdXRwdXQ6IDc1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDEuNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMTguNzUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwidXMuYW50aHJvcGljLmNsYXVkZS1vcHVzLTQtMjAyNTA1MTQtdjE6MFwiOiB7XG5cdFx0XHRpZDogXCJ1cy5hbnRocm9waWMuY2xhdWRlLW9wdXMtNC0yMDI1MDUxNC12MTowXCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBPcHVzIDQgKFVTKVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDE1LFxuXHRcdFx0XHRvdXRwdXQ6IDc1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDEuNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMTguNzUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwidXMuYW50aHJvcGljLmNsYXVkZS1vcHVzLTQtNS0yMDI1MTEwMS12MTowXCI6IHtcblx0XHRcdGlkOiBcInVzLmFudGhyb3BpYy5jbGF1ZGUtb3B1cy00LTUtMjAyNTExMDEtdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgT3B1cyA0LjUgKFVTKVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDUsXG5cdFx0XHRcdG91dHB1dDogMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiA2LjI1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcInVzLmFudGhyb3BpYy5jbGF1ZGUtb3B1cy00LTYtdjFcIjoge1xuXHRcdFx0aWQ6IFwidXMuYW50aHJvcGljLmNsYXVkZS1vcHVzLTQtNi12MVwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgT3B1cyA0LjYgKFVTKVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDUsXG5cdFx0XHRcdG91dHB1dDogMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiA2LjI1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEyODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwidXMuYW50aHJvcGljLmNsYXVkZS1vcHVzLTQtN1wiOiB7XG5cdFx0XHRpZDogXCJ1cy5hbnRocm9waWMuY2xhdWRlLW9wdXMtNC03XCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBPcHVzIDQuNyAoVVMpXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogNSxcblx0XHRcdFx0b3V0cHV0OiAyNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDYuMjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJ1cy5hbnRocm9waWMuY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0LXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwidXMuYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNC12MTowXCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBTb25uZXQgNCAoVVMpXCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMyxcblx0XHRcdFx0b3V0cHV0OiAxNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDMuNzUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwidXMuYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5LXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwidXMuYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC01LTIwMjUwOTI5LXYxOjBcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIFNvbm5ldCA0LjUgKFVTKVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDMsXG5cdFx0XHRcdG91dHB1dDogMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4zLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAzLjc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcInVzLmFudGhyb3BpYy5jbGF1ZGUtc29ubmV0LTQtNlwiOiB7XG5cdFx0XHRpZDogXCJ1cy5hbnRocm9waWMuY2xhdWRlLXNvbm5ldC00LTZcIixcblx0XHRcdG5hbWU6IFwiQ2xhdWRlIFNvbm5ldCA0LjYgKFVTKVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDMsXG5cdFx0XHRcdG91dHB1dDogMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4zLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAzLjc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdFx0XCJ3cml0ZXIucGFsbXlyYS14NC12MTowXCI6IHtcblx0XHRcdGlkOiBcIndyaXRlci5wYWxteXJhLXg0LXYxOjBcIixcblx0XHRcdG5hbWU6IFwiUGFsbXlyYSBYNFwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMjI4ODAsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcIndyaXRlci5wYWxteXJhLXg1LXYxOjBcIjoge1xuXHRcdFx0aWQ6IFwid3JpdGVyLnBhbG15cmEteDUtdjE6MFwiLFxuXHRcdFx0bmFtZTogXCJQYWxteXJhIFg1XCIsXG5cdFx0XHRhcGk6IFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIixcblx0XHRcdHByb3ZpZGVyOiBcImFtYXpvbi1iZWRyb2NrXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vYmVkcm9jay1ydW50aW1lLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNixcblx0XHRcdFx0b3V0cHV0OiA2LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0MDAwMCxcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiemFpLmdsbS00LjdcIjoge1xuXHRcdFx0aWQ6IFwiemFpLmdsbS00LjdcIixcblx0XHRcdG5hbWU6IFwiR0xNLTQuN1wiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjYsXG5cdFx0XHRcdG91dHB1dDogMi4yLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjA0ODAwLFxuXHRcdFx0bWF4VG9rZW5zOiAxMzEwNzIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiPixcblx0XHRcInphaS5nbG0tNC43LWZsYXNoXCI6IHtcblx0XHRcdGlkOiBcInphaS5nbG0tNC43LWZsYXNoXCIsXG5cdFx0XHRuYW1lOiBcIkdMTS00LjctRmxhc2hcIixcblx0XHRcdGFwaTogXCJiZWRyb2NrLWNvbnZlcnNlLXN0cmVhbVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiYW1hem9uLWJlZHJvY2tcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9iZWRyb2NrLXJ1bnRpbWUudXMtZWFzdC0xLmFtYXpvbmF3cy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNyxcblx0XHRcdFx0b3V0cHV0OiAwLjQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDEzMTA3Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCI+LFxuXHRcdFwiemFpLmdsbS01XCI6IHtcblx0XHRcdGlkOiBcInphaS5nbG0tNVwiLFxuXHRcdFx0bmFtZTogXCJHTE0tNVwiLFxuXHRcdFx0YXBpOiBcImJlZHJvY2stY29udmVyc2Utc3RyZWFtXCIsXG5cdFx0XHRwcm92aWRlcjogXCJhbWF6b24tYmVkcm9ja1wiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2JlZHJvY2stcnVudGltZS51cy1lYXN0LTEuYW1hem9uYXdzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLFxuXHRcdFx0XHRvdXRwdXQ6IDMuMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMjc1Mixcblx0XHRcdG1heFRva2VuczogMTAxMzc2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiYmVkcm9jay1jb252ZXJzZS1zdHJlYW1cIj4sXG5cdH0gYXMgY29uc3Qgc2F0aXNmaWVzIFJlY29yZDxzdHJpbmcsIE1vZGVsPGFueT4+O1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBS08sTUFBTSx3QkFBd0I7QUFBQSxFQUNuQywyQkFBMkI7QUFBQSxJQUMxQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1Is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
