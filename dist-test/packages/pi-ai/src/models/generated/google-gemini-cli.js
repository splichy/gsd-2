const GOOGLE_GEMINI_CLI_MODELS = {
  "gemini-2.0-flash": {
    id: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash (Cloud Code Assist)",
    api: "google-gemini-cli",
    provider: "google-gemini-cli",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 8192
  },
  "gemini-2.5-flash": {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash (Cloud Code Assist)",
    api: "google-gemini-cli",
    provider: "google-gemini-cli",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65535
  },
  "gemini-2.5-pro": {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro (Cloud Code Assist)",
    api: "google-gemini-cli",
    provider: "google-gemini-cli",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65535
  },
  "gemini-3-flash-preview": {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview (Cloud Code Assist)",
    api: "google-gemini-cli",
    provider: "google-gemini-cli",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65535
  },
  "gemini-3-pro-preview": {
    id: "gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview (Cloud Code Assist)",
    api: "google-gemini-cli",
    provider: "google-gemini-cli",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65535
  },
  "gemini-3.1-pro-preview": {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview (Cloud Code Assist)",
    api: "google-gemini-cli",
    provider: "google-gemini-cli",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65535
  }
};
export {
  GOOGLE_GEMINI_CLI_MODELS
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL21vZGVscy9nZW5lcmF0ZWQvZ29vZ2xlLWdlbWluaS1jbGkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFRoaXMgZmlsZSBpcyBhdXRvLWdlbmVyYXRlZCBieSBzY3JpcHRzL2dlbmVyYXRlLW1vZGVscy50c1xuLy8gRG8gbm90IGVkaXQgbWFudWFsbHkgLSBydW4gJ25wbSBydW4gZ2VuZXJhdGUtbW9kZWxzJyB0byB1cGRhdGVcblxuaW1wb3J0IHR5cGUgeyBNb2RlbCB9IGZyb20gXCIuLi8uLi90eXBlcy5qc1wiO1xuXG5leHBvcnQgY29uc3QgR09PR0xFX0dFTUlOSV9DTElfTU9ERUxTID0ge1xuXHRcdFwiZ2VtaW5pLTIuMC1mbGFzaFwiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMi4wLWZsYXNoXCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAyLjAgRmxhc2ggKENsb3VkIENvZGUgQXNzaXN0KVwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW1pbmktY2xpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGUtZ2VtaW5pLWNsaVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2Nsb3VkY29kZS1wYS5nb29nbGVhcGlzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbWluaS1jbGlcIj4sXG5cdFx0XCJnZW1pbmktMi41LWZsYXNoXCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS0yLjUtZmxhc2hcIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIDIuNSBGbGFzaCAoQ2xvdWQgQ29kZSBBc3Npc3QpXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbWluaS1jbGlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZS1nZW1pbmktY2xpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vY2xvdWRjb2RlLXBhLmdvb2dsZWFwaXMuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogNjU1MzUsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtZ2VtaW5pLWNsaVwiPixcblx0XHRcImdlbWluaS0yLjUtcHJvXCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS0yLjUtcHJvXCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAyLjUgUHJvIChDbG91ZCBDb2RlIEFzc2lzdClcIixcblx0XHRcdGFwaTogXCJnb29nbGUtZ2VtaW5pLWNsaVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ29vZ2xlLWdlbWluaS1jbGlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9jbG91ZGNvZGUtcGEuZ29vZ2xlYXBpcy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNSxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS1nZW1pbmktY2xpXCI+LFxuXHRcdFwiZ2VtaW5pLTMtZmxhc2gtcHJldmlld1wiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMy1mbGFzaC1wcmV2aWV3XCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAzIEZsYXNoIFByZXZpZXcgKENsb3VkIENvZGUgQXNzaXN0KVwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW1pbmktY2xpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGUtZ2VtaW5pLWNsaVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2Nsb3VkY29kZS1wYS5nb29nbGVhcGlzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAsXG5cdFx0XHRcdG91dHB1dDogMCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM1LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbWluaS1jbGlcIj4sXG5cdFx0XCJnZW1pbmktMy1wcm8tcHJldmlld1wiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMy1wcm8tcHJldmlld1wiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMyBQcm8gUHJldmlldyAoQ2xvdWQgQ29kZSBBc3Npc3QpXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbWluaS1jbGlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZS1nZW1pbmktY2xpXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vY2xvdWRjb2RlLXBhLmdvb2dsZWFwaXMuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogNjU1MzUsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtZ2VtaW5pLWNsaVwiPixcblx0XHRcImdlbWluaS0zLjEtcHJvLXByZXZpZXdcIjoge1xuXHRcdFx0aWQ6IFwiZ2VtaW5pLTMuMS1wcm8tcHJldmlld1wiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMy4xIFBybyBQcmV2aWV3IChDbG91ZCBDb2RlIEFzc2lzdClcIixcblx0XHRcdGFwaTogXCJnb29nbGUtZ2VtaW5pLWNsaVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ29vZ2xlLWdlbWluaS1jbGlcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9jbG91ZGNvZGUtcGEuZ29vZ2xlYXBpcy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNSxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS1nZW1pbmktY2xpXCI+LFxuXHR9IGFzIGNvbnN0IHNhdGlzZmllcyBSZWNvcmQ8c3RyaW5nLCBNb2RlbDxhbnk+PjtcbiJdLAog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
