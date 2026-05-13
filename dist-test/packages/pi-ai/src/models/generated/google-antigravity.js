const GOOGLE_ANTIGRAVITY_MODELS = {
  "claude-opus-4-5-thinking": {
    id: "claude-opus-4-5-thinking",
    name: "Claude Opus 4.5 Thinking (Antigravity)",
    api: "google-gemini-cli",
    provider: "google-antigravity",
    baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
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
  "claude-opus-4-6-thinking": {
    id: "claude-opus-4-6-thinking",
    name: "Claude Opus 4.6 Thinking (Antigravity)",
    api: "google-gemini-cli",
    provider: "google-antigravity",
    baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25
    },
    contextWindow: 2e5,
    maxTokens: 128e3
  },
  "claude-opus-4-7-thinking": {
    id: "claude-opus-4-7-thinking",
    name: "Claude Opus 4.7 Thinking (Antigravity)",
    api: "google-gemini-cli",
    provider: "google-antigravity",
    baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
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
  "claude-sonnet-4-5": {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5 (Antigravity)",
    api: "google-gemini-cli",
    provider: "google-antigravity",
    baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
    reasoning: false,
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
  "claude-sonnet-4-5-thinking": {
    id: "claude-sonnet-4-5-thinking",
    name: "Claude Sonnet 4.5 Thinking (Antigravity)",
    api: "google-gemini-cli",
    provider: "google-antigravity",
    baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
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
    name: "Claude Sonnet 4.6 (Antigravity)",
    api: "google-gemini-cli",
    provider: "google-antigravity",
    baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
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
  "gemini-3-flash": {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash (Antigravity)",
    api: "google-gemini-cli",
    provider: "google-antigravity",
    baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.5,
      output: 3,
      cacheRead: 0.5,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65535
  },
  "gemini-3.1-pro-high": {
    id: "gemini-3.1-pro-high",
    name: "Gemini 3.1 Pro High (Antigravity)",
    api: "google-gemini-cli",
    provider: "google-antigravity",
    baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 12,
      cacheRead: 0.2,
      cacheWrite: 2.375
    },
    contextWindow: 1048576,
    maxTokens: 65535
  },
  "gemini-3.1-pro-low": {
    id: "gemini-3.1-pro-low",
    name: "Gemini 3.1 Pro Low (Antigravity)",
    api: "google-gemini-cli",
    provider: "google-antigravity",
    baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 12,
      cacheRead: 0.2,
      cacheWrite: 2.375
    },
    contextWindow: 1048576,
    maxTokens: 65535
  },
  "gpt-oss-120b-medium": {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B Medium (Antigravity)",
    api: "google-gemini-cli",
    provider: "google-antigravity",
    baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0.09,
      output: 0.36,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 32768
  }
};
export {
  GOOGLE_ANTIGRAVITY_MODELS
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL21vZGVscy9nZW5lcmF0ZWQvZ29vZ2xlLWFudGlncmF2aXR5LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBUaGlzIGZpbGUgaXMgYXV0by1nZW5lcmF0ZWQgYnkgc2NyaXB0cy9nZW5lcmF0ZS1tb2RlbHMudHNcbi8vIERvIG5vdCBlZGl0IG1hbnVhbGx5IC0gcnVuICducG0gcnVuIGdlbmVyYXRlLW1vZGVscycgdG8gdXBkYXRlXG5cbmltcG9ydCB0eXBlIHsgTW9kZWwgfSBmcm9tIFwiLi4vLi4vdHlwZXMuanNcIjtcblxuZXhwb3J0IGNvbnN0IEdPT0dMRV9BTlRJR1JBVklUWV9NT0RFTFMgPSB7XG5cdFx0XCJjbGF1ZGUtb3B1cy00LTUtdGhpbmtpbmdcIjoge1xuXHRcdFx0aWQ6IFwiY2xhdWRlLW9wdXMtNC01LXRoaW5raW5nXCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBPcHVzIDQuNSBUaGlua2luZyAoQW50aWdyYXZpdHkpXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbWluaS1jbGlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZS1hbnRpZ3Jhdml0eVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2RhaWx5LWNsb3VkY29kZS1wYS5zYW5kYm94Lmdvb2dsZWFwaXMuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogNSxcblx0XHRcdFx0b3V0cHV0OiAyNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDYuMjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS1nZW1pbmktY2xpXCI+LFxuXHRcdFwiY2xhdWRlLW9wdXMtNC02LXRoaW5raW5nXCI6IHtcblx0XHRcdGlkOiBcImNsYXVkZS1vcHVzLTQtNi10aGlua2luZ1wiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgT3B1cyA0LjYgVGhpbmtpbmcgKEFudGlncmF2aXR5KVwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW1pbmktY2xpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGUtYW50aWdyYXZpdHlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9kYWlseS1jbG91ZGNvZGUtcGEuc2FuZGJveC5nb29nbGVhcGlzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDUsXG5cdFx0XHRcdG91dHB1dDogMjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC41LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiA2LjI1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbWluaS1jbGlcIj4sXG5cdFx0XCJjbGF1ZGUtb3B1cy00LTctdGhpbmtpbmdcIjoge1xuXHRcdFx0aWQ6IFwiY2xhdWRlLW9wdXMtNC03LXRoaW5raW5nXCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBPcHVzIDQuNyBUaGlua2luZyAoQW50aWdyYXZpdHkpXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbWluaS1jbGlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZS1hbnRpZ3Jhdml0eVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2RhaWx5LWNsb3VkY29kZS1wYS5zYW5kYm94Lmdvb2dsZWFwaXMuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogNSxcblx0XHRcdFx0b3V0cHV0OiAyNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDYuMjUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogMTI4MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbWluaS1jbGlcIj4sXG5cdFx0XCJjbGF1ZGUtc29ubmV0LTQtNVwiOiB7XG5cdFx0XHRpZDogXCJjbGF1ZGUtc29ubmV0LTQtNVwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgU29ubmV0IDQuNSAoQW50aWdyYXZpdHkpXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbWluaS1jbGlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZS1hbnRpZ3Jhdml0eVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2RhaWx5LWNsb3VkY29kZS1wYS5zYW5kYm94Lmdvb2dsZWFwaXMuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDMsXG5cdFx0XHRcdG91dHB1dDogMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4zLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAzLjc1LFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDIwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtZ2VtaW5pLWNsaVwiPixcblx0XHRcImNsYXVkZS1zb25uZXQtNC01LXRoaW5raW5nXCI6IHtcblx0XHRcdGlkOiBcImNsYXVkZS1zb25uZXQtNC01LXRoaW5raW5nXCIsXG5cdFx0XHRuYW1lOiBcIkNsYXVkZSBTb25uZXQgNC41IFRoaW5raW5nIChBbnRpZ3Jhdml0eSlcIixcblx0XHRcdGFwaTogXCJnb29nbGUtZ2VtaW5pLWNsaVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ29vZ2xlLWFudGlncmF2aXR5XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vZGFpbHktY2xvdWRjb2RlLXBhLnNhbmRib3guZ29vZ2xlYXBpcy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAzLFxuXHRcdFx0XHRvdXRwdXQ6IDE1LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMy43NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAyMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDY0MDAwLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbWluaS1jbGlcIj4sXG5cdFx0XCJjbGF1ZGUtc29ubmV0LTQtNlwiOiB7XG5cdFx0XHRpZDogXCJjbGF1ZGUtc29ubmV0LTQtNlwiLFxuXHRcdFx0bmFtZTogXCJDbGF1ZGUgU29ubmV0IDQuNiAoQW50aWdyYXZpdHkpXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbWluaS1jbGlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZS1hbnRpZ3Jhdml0eVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2RhaWx5LWNsb3VkY29kZS1wYS5zYW5kYm94Lmdvb2dsZWFwaXMuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMyxcblx0XHRcdFx0b3V0cHV0OiAxNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjMsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDMuNzUsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS1nZW1pbmktY2xpXCI+LFxuXHRcdFwiZ2VtaW5pLTMtZmxhc2hcIjoge1xuXHRcdFx0aWQ6IFwiZ2VtaW5pLTMtZmxhc2hcIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIDMgRmxhc2ggKEFudGlncmF2aXR5KVwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW1pbmktY2xpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGUtYW50aWdyYXZpdHlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9kYWlseS1jbG91ZGNvZGUtcGEuc2FuZGJveC5nb29nbGVhcGlzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuNSxcblx0XHRcdFx0b3V0cHV0OiAzLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNSxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS1nZW1pbmktY2xpXCI+LFxuXHRcdFwiZ2VtaW5pLTMuMS1wcm8taGlnaFwiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMy4xLXByby1oaWdoXCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAzLjEgUHJvIEhpZ2ggKEFudGlncmF2aXR5KVwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW1pbmktY2xpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGUtYW50aWdyYXZpdHlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9kYWlseS1jbG91ZGNvZGUtcGEuc2FuZGJveC5nb29nbGVhcGlzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIsXG5cdFx0XHRcdG91dHB1dDogMTIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4yLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAyLjM3NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNSxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS1nZW1pbmktY2xpXCI+LFxuXHRcdFwiZ2VtaW5pLTMuMS1wcm8tbG93XCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS0zLjEtcHJvLWxvd1wiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMy4xIFBybyBMb3cgKEFudGlncmF2aXR5KVwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW1pbmktY2xpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGUtYW50aWdyYXZpdHlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9kYWlseS1jbG91ZGNvZGUtcGEuc2FuZGJveC5nb29nbGVhcGlzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIsXG5cdFx0XHRcdG91dHB1dDogMTIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4yLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAyLjM3NSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNSxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS1nZW1pbmktY2xpXCI+LFxuXHRcdFwiZ3B0LW9zcy0xMjBiLW1lZGl1bVwiOiB7XG5cdFx0XHRpZDogXCJncHQtb3NzLTEyMGItbWVkaXVtXCIsXG5cdFx0XHRuYW1lOiBcIkdQVC1PU1MgMTIwQiBNZWRpdW0gKEFudGlncmF2aXR5KVwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW1pbmktY2xpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGUtYW50aWdyYXZpdHlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9kYWlseS1jbG91ZGNvZGUtcGEuc2FuZGJveC5nb29nbGVhcGlzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wOSxcblx0XHRcdFx0b3V0cHV0OiAwLjM2LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiAzMjc2OCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS1nZW1pbmktY2xpXCI+LFxuXHR9IGFzIGNvbnN0IHNhdGlzZmllcyBSZWNvcmQ8c3RyaW5nLCBNb2RlbDxhbnk+PjtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUtPLE1BQU0sNEJBQTRCO0FBQUEsRUFDdkMsNEJBQTRCO0FBQUEsSUFDM0IsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsV0FBVztBQUFBLElBQ1gsT0FBTyxDQUFDLFFBQVEsT0FBTztBQUFBLElBQ3ZCLE1BQU07QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNiO0FBQUEsSUFDQSxlQUFlO0FBQUEsSUFDZixXQUFXO0FBQUEsRUFDWjtBQUFBLEVBQ0EsNEJBQTRCO0FBQUEsSUFDM0IsSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElB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
