const GOOGLE_MODELS = {
  "gemini-1.5-flash": {
    id: "gemini-1.5-flash",
    name: "Gemini 1.5 Flash",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.075,
      output: 0.3,
      cacheRead: 0.01875,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 8192
  },
  "gemini-1.5-flash-8b": {
    id: "gemini-1.5-flash-8b",
    name: "Gemini 1.5 Flash-8B",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.0375,
      output: 0.15,
      cacheRead: 0.01,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 8192
  },
  "gemini-1.5-pro": {
    id: "gemini-1.5-pro",
    name: "Gemini 1.5 Pro",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 1.25,
      output: 5,
      cacheRead: 0.3125,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 8192
  },
  "gemini-2.0-flash": {
    id: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.1,
      output: 0.4,
      cacheRead: 0.025,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 8192
  },
  "gemini-2.0-flash-lite": {
    id: "gemini-2.0-flash-lite",
    name: "Gemini 2.0 Flash Lite",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
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
  "gemini-2.5-flash": {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.3,
      output: 2.5,
      cacheRead: 0.075,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-2.5-flash-lite": {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.1,
      output: 0.4,
      cacheRead: 0.025,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-2.5-flash-lite-preview-06-17": {
    id: "gemini-2.5-flash-lite-preview-06-17",
    name: "Gemini 2.5 Flash Lite Preview 06-17",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.1,
      output: 0.4,
      cacheRead: 0.025,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-2.5-flash-lite-preview-09-2025": {
    id: "gemini-2.5-flash-lite-preview-09-2025",
    name: "Gemini 2.5 Flash Lite Preview 09-25",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.1,
      output: 0.4,
      cacheRead: 0.025,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-2.5-flash-preview-04-17": {
    id: "gemini-2.5-flash-preview-04-17",
    name: "Gemini 2.5 Flash Preview 04-17",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.0375,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-2.5-flash-preview-05-20": {
    id: "gemini-2.5-flash-preview-05-20",
    name: "Gemini 2.5 Flash Preview 05-20",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.0375,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-2.5-flash-preview-09-2025": {
    id: "gemini-2.5-flash-preview-09-2025",
    name: "Gemini 2.5 Flash Preview 09-25",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.3,
      output: 2.5,
      cacheRead: 0.075,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-2.5-pro": {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.25,
      output: 10,
      cacheRead: 0.31,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-2.5-pro-preview-05-06": {
    id: "gemini-2.5-pro-preview-05-06",
    name: "Gemini 2.5 Pro Preview 05-06",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.25,
      output: 10,
      cacheRead: 0.31,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-2.5-pro-preview-06-05": {
    id: "gemini-2.5-pro-preview-06-05",
    name: "Gemini 2.5 Pro Preview 06-05",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.25,
      output: 10,
      cacheRead: 0.31,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-3-flash-preview": {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
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
  "gemini-3-pro-preview": {
    id: "gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 12,
      cacheRead: 0.2,
      cacheWrite: 0
    },
    contextWindow: 1e6,
    maxTokens: 64e3
  },
  "gemini-3.1-flash-lite-preview": {
    id: "gemini-3.1-flash-lite-preview",
    name: "Gemini 3.1 Flash Lite Preview",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.25,
      output: 1.5,
      cacheRead: 0.025,
      cacheWrite: 1
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-3.1-pro-preview": {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
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
  "gemini-3.1-pro-preview-customtools": {
    id: "gemini-3.1-pro-preview-customtools",
    name: "Gemini 3.1 Pro Preview Custom Tools",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
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
  "gemini-flash-latest": {
    id: "gemini-flash-latest",
    name: "Gemini Flash Latest",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.3,
      output: 2.5,
      cacheRead: 0.075,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-flash-lite-latest": {
    id: "gemini-flash-lite-latest",
    name: "Gemini Flash-Lite Latest",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.1,
      output: 0.4,
      cacheRead: 0.025,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-live-2.5-flash": {
    id: "gemini-live-2.5-flash",
    name: "Gemini Live 2.5 Flash",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.5,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128e3,
    maxTokens: 8e3
  },
  "gemini-live-2.5-flash-preview-native-audio": {
    id: "gemini-live-2.5-flash-preview-native-audio",
    name: "Gemini Live 2.5 Flash Preview Native Audio",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0.5,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 65536
  },
  "gemma-3-27b-it": {
    id: "gemma-3-27b-it",
    name: "Gemma 3 27B",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 131072,
    maxTokens: 8192
  },
  "gemma-4-26b-it": {
    id: "gemma-4-26b-it",
    name: "Gemma 4 26B",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 8192
  },
  "gemma-4-31b-it": {
    id: "gemma-4-31b-it",
    name: "Gemma 4 31B",
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 256e3,
    maxTokens: 8192
  }
};
export {
  GOOGLE_MODELS
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL21vZGVscy9nZW5lcmF0ZWQvZ29vZ2xlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBUaGlzIGZpbGUgaXMgYXV0by1nZW5lcmF0ZWQgYnkgc2NyaXB0cy9nZW5lcmF0ZS1tb2RlbHMudHNcbi8vIERvIG5vdCBlZGl0IG1hbnVhbGx5IC0gcnVuICducG0gcnVuIGdlbmVyYXRlLW1vZGVscycgdG8gdXBkYXRlXG5cbmltcG9ydCB0eXBlIHsgTW9kZWwgfSBmcm9tIFwiLi4vLi4vdHlwZXMuanNcIjtcblxuZXhwb3J0IGNvbnN0IEdPT0dMRV9NT0RFTFMgPSB7XG5cdFx0XCJnZW1pbmktMS41LWZsYXNoXCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS0xLjUtZmxhc2hcIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIDEuNSBGbGFzaFwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9nZW5lcmF0aXZlbGFuZ3VhZ2UuZ29vZ2xlYXBpcy5jb20vdjFiZXRhXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMDc1LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAxODc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiPixcblx0XHRcImdlbWluaS0xLjUtZmxhc2gtOGJcIjoge1xuXHRcdFx0aWQ6IFwiZ2VtaW5pLTEuNS1mbGFzaC04YlwiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMS41IEZsYXNoLThCXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2dlbmVyYXRpdmVsYW5ndWFnZS5nb29nbGVhcGlzLmNvbS92MWJldGFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wMzc1LFxuXHRcdFx0XHRvdXRwdXQ6IDAuMTUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIj4sXG5cdFx0XCJnZW1pbmktMS41LXByb1wiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMS41LXByb1wiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMS41IFByb1wiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9nZW5lcmF0aXZlbGFuZ3VhZ2UuZ29vZ2xlYXBpcy5jb20vdjFiZXRhXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMjUsXG5cdFx0XHRcdG91dHB1dDogNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjMxMjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCI+LFxuXHRcdFwiZ2VtaW5pLTIuMC1mbGFzaFwiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMi4wLWZsYXNoXCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAyLjAgRmxhc2hcIixcblx0XHRcdGFwaTogXCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ29vZ2xlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vZ2VuZXJhdGl2ZWxhbmd1YWdlLmdvb2dsZWFwaXMuY29tL3YxYmV0YVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjEsXG5cdFx0XHRcdG91dHB1dDogMC40LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDI1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiPixcblx0XHRcImdlbWluaS0yLjAtZmxhc2gtbGl0ZVwiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMi4wLWZsYXNoLWxpdGVcIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIDIuMCBGbGFzaCBMaXRlXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2dlbmVyYXRpdmVsYW5ndWFnZS5nb29nbGVhcGlzLmNvbS92MWJldGFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNzUsXG5cdFx0XHRcdG91dHB1dDogMC4zLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCI+LFxuXHRcdFwiZ2VtaW5pLTIuNS1mbGFzaFwiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMi41LWZsYXNoXCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAyLjUgRmxhc2hcIixcblx0XHRcdGFwaTogXCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ29vZ2xlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vZ2VuZXJhdGl2ZWxhbmd1YWdlLmdvb2dsZWFwaXMuY29tL3YxYmV0YVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMyxcblx0XHRcdFx0b3V0cHV0OiAyLjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiPixcblx0XHRcImdlbWluaS0yLjUtZmxhc2gtbGl0ZVwiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMi41LWZsYXNoLWxpdGVcIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIDIuNSBGbGFzaCBMaXRlXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2dlbmVyYXRpdmVsYW5ndWFnZS5nb29nbGVhcGlzLmNvbS92MWJldGFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjEsXG5cdFx0XHRcdG91dHB1dDogMC40LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDI1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIj4sXG5cdFx0XCJnZW1pbmktMi41LWZsYXNoLWxpdGUtcHJldmlldy0wNi0xN1wiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMi41LWZsYXNoLWxpdGUtcHJldmlldy0wNi0xN1wiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMi41IEZsYXNoIExpdGUgUHJldmlldyAwNi0xN1wiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9nZW5lcmF0aXZlbGFuZ3VhZ2UuZ29vZ2xlYXBpcy5jb20vdjFiZXRhXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xLFxuXHRcdFx0XHRvdXRwdXQ6IDAuNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAyNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCI+LFxuXHRcdFwiZ2VtaW5pLTIuNS1mbGFzaC1saXRlLXByZXZpZXctMDktMjAyNVwiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMi41LWZsYXNoLWxpdGUtcHJldmlldy0wOS0yMDI1XCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAyLjUgRmxhc2ggTGl0ZSBQcmV2aWV3IDA5LTI1XCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2dlbmVyYXRpdmVsYW5ndWFnZS5nb29nbGVhcGlzLmNvbS92MWJldGFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjEsXG5cdFx0XHRcdG91dHB1dDogMC40LFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDI1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIj4sXG5cdFx0XCJnZW1pbmktMi41LWZsYXNoLXByZXZpZXctMDQtMTdcIjoge1xuXHRcdFx0aWQ6IFwiZ2VtaW5pLTIuNS1mbGFzaC1wcmV2aWV3LTA0LTE3XCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAyLjUgRmxhc2ggUHJldmlldyAwNC0xN1wiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9nZW5lcmF0aXZlbGFuZ3VhZ2UuZ29vZ2xlYXBpcy5jb20vdjFiZXRhXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNSxcblx0XHRcdFx0b3V0cHV0OiAwLjYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMzc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIj4sXG5cdFx0XCJnZW1pbmktMi41LWZsYXNoLXByZXZpZXctMDUtMjBcIjoge1xuXHRcdFx0aWQ6IFwiZ2VtaW5pLTIuNS1mbGFzaC1wcmV2aWV3LTA1LTIwXCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAyLjUgRmxhc2ggUHJldmlldyAwNS0yMFwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9nZW5lcmF0aXZlbGFuZ3VhZ2UuZ29vZ2xlYXBpcy5jb20vdjFiZXRhXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNSxcblx0XHRcdFx0b3V0cHV0OiAwLjYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMzc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIj4sXG5cdFx0XCJnZW1pbmktMi41LWZsYXNoLXByZXZpZXctMDktMjAyNVwiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMi41LWZsYXNoLXByZXZpZXctMDktMjAyNVwiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMi41IEZsYXNoIFByZXZpZXcgMDktMjVcIixcblx0XHRcdGFwaTogXCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ29vZ2xlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vZ2VuZXJhdGl2ZWxhbmd1YWdlLmdvb2dsZWFwaXMuY29tL3YxYmV0YVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMyxcblx0XHRcdFx0b3V0cHV0OiAyLjUsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wNzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiPixcblx0XHRcImdlbWluaS0yLjUtcHJvXCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS0yLjUtcHJvXCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAyLjUgUHJvXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2dlbmVyYXRpdmVsYW5ndWFnZS5nb29nbGVhcGlzLmNvbS92MWJldGFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDEwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMzEsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiPixcblx0XHRcImdlbWluaS0yLjUtcHJvLXByZXZpZXctMDUtMDZcIjoge1xuXHRcdFx0aWQ6IFwiZ2VtaW5pLTIuNS1wcm8tcHJldmlldy0wNS0wNlwiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMi41IFBybyBQcmV2aWV3IDA1LTA2XCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2dlbmVyYXRpdmVsYW5ndWFnZS5nb29nbGVhcGlzLmNvbS92MWJldGFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDEwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMzEsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiPixcblx0XHRcImdlbWluaS0yLjUtcHJvLXByZXZpZXctMDYtMDVcIjoge1xuXHRcdFx0aWQ6IFwiZ2VtaW5pLTIuNS1wcm8tcHJldmlldy0wNi0wNVwiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMi41IFBybyBQcmV2aWV3IDA2LTA1XCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2dlbmVyYXRpdmVsYW5ndWFnZS5nb29nbGVhcGlzLmNvbS92MWJldGFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAxLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDEwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMzEsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiPixcblx0XHRcImdlbWluaS0zLWZsYXNoLXByZXZpZXdcIjoge1xuXHRcdFx0aWQ6IFwiZ2VtaW5pLTMtZmxhc2gtcHJldmlld1wiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMyBGbGFzaCBQcmV2aWV3XCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2dlbmVyYXRpdmVsYW5ndWFnZS5nb29nbGVhcGlzLmNvbS92MWJldGFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjUsXG5cdFx0XHRcdG91dHB1dDogMyxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIj4sXG5cdFx0XCJnZW1pbmktMy1wcm8tcHJldmlld1wiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMy1wcm8tcHJldmlld1wiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMyBQcm8gUHJldmlld1wiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9nZW5lcmF0aXZlbGFuZ3VhZ2UuZ29vZ2xlYXBpcy5jb20vdjFiZXRhXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMixcblx0XHRcdFx0b3V0cHV0OiAxMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjIsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogNjQwMDAsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiPixcblx0XHRcImdlbWluaS0zLjEtZmxhc2gtbGl0ZS1wcmV2aWV3XCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS0zLjEtZmxhc2gtbGl0ZS1wcmV2aWV3XCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAzLjEgRmxhc2ggTGl0ZSBQcmV2aWV3XCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2dlbmVyYXRpdmVsYW5ndWFnZS5nb29nbGVhcGlzLmNvbS92MWJldGFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjI1LFxuXHRcdFx0XHRvdXRwdXQ6IDEuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAyNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMSxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCI+LFxuXHRcdFwiZ2VtaW5pLTMuMS1wcm8tcHJldmlld1wiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMy4xLXByby1wcmV2aWV3XCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAzLjEgUHJvIFByZXZpZXdcIixcblx0XHRcdGFwaTogXCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ29vZ2xlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vZ2VuZXJhdGl2ZWxhbmd1YWdlLmdvb2dsZWFwaXMuY29tL3YxYmV0YVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIsXG5cdFx0XHRcdG91dHB1dDogMTIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4yLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIj4sXG5cdFx0XCJnZW1pbmktMy4xLXByby1wcmV2aWV3LWN1c3RvbXRvb2xzXCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS0zLjEtcHJvLXByZXZpZXctY3VzdG9tdG9vbHNcIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIDMuMSBQcm8gUHJldmlldyBDdXN0b20gVG9vbHNcIixcblx0XHRcdGFwaTogXCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ29vZ2xlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vZ2VuZXJhdGl2ZWxhbmd1YWdlLmdvb2dsZWFwaXMuY29tL3YxYmV0YVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDIsXG5cdFx0XHRcdG91dHB1dDogMTIsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4yLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIj4sXG5cdFx0XCJnZW1pbmktZmxhc2gtbGF0ZXN0XCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS1mbGFzaC1sYXRlc3RcIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIEZsYXNoIExhdGVzdFwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9nZW5lcmF0aXZlbGFuZ3VhZ2UuZ29vZ2xlYXBpcy5jb20vdjFiZXRhXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zLFxuXHRcdFx0XHRvdXRwdXQ6IDIuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjA3NSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCI+LFxuXHRcdFwiZ2VtaW5pLWZsYXNoLWxpdGUtbGF0ZXN0XCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS1mbGFzaC1saXRlLWxhdGVzdFwiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgRmxhc2gtTGl0ZSBMYXRlc3RcIixcblx0XHRcdGFwaTogXCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ29vZ2xlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vZ2VuZXJhdGl2ZWxhbmd1YWdlLmdvb2dsZWFwaXMuY29tL3YxYmV0YVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMSxcblx0XHRcdFx0b3V0cHV0OiAwLjQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiPixcblx0XHRcImdlbWluaS1saXZlLTIuNS1mbGFzaFwiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktbGl2ZS0yLjUtZmxhc2hcIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIExpdmUgMi41IEZsYXNoXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2dlbmVyYXRpdmVsYW5ndWFnZS5nb29nbGVhcGlzLmNvbS92MWJldGFcIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjUsXG5cdFx0XHRcdG91dHB1dDogMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEyODAwMCxcblx0XHRcdG1heFRva2VuczogODAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCI+LFxuXHRcdFwiZ2VtaW5pLWxpdmUtMi41LWZsYXNoLXByZXZpZXctbmF0aXZlLWF1ZGlvXCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS1saXZlLTIuNS1mbGFzaC1wcmV2aWV3LW5hdGl2ZS1hdWRpb1wiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgTGl2ZSAyLjUgRmxhc2ggUHJldmlldyBOYXRpdmUgQXVkaW9cIixcblx0XHRcdGFwaTogXCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ29vZ2xlXCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8vZ2VuZXJhdGl2ZWxhbmd1YWdlLmdvb2dsZWFwaXMuY29tL3YxYmV0YVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjUsXG5cdFx0XHRcdG91dHB1dDogMixcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEzMTA3Mixcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtZ2VuZXJhdGl2ZS1haVwiPixcblx0XHRcImdlbW1hLTMtMjdiLWl0XCI6IHtcblx0XHRcdGlkOiBcImdlbW1hLTMtMjdiLWl0XCIsXG5cdFx0XHRuYW1lOiBcIkdlbW1hIDMgMjdCXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZVwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL2dlbmVyYXRpdmVsYW5ndWFnZS5nb29nbGVhcGlzLmNvbS92MWJldGFcIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTMxMDcyLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIj4sXG5cdFx0XCJnZW1tYS00LTI2Yi1pdFwiOiB7XG5cdFx0XHRpZDogXCJnZW1tYS00LTI2Yi1pdFwiLFxuXHRcdFx0bmFtZTogXCJHZW1tYSA0IDI2QlwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9nZW5lcmF0aXZlbGFuZ3VhZ2UuZ29vZ2xlYXBpcy5jb20vdjFiZXRhXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjU2MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIj4sXG5cdFx0XCJnZW1tYS00LTMxYi1pdFwiOiB7XG5cdFx0XHRpZDogXCJnZW1tYS00LTMxYi1pdFwiLFxuXHRcdFx0bmFtZTogXCJHZW1tYSA0IDMxQlwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS1nZW5lcmF0aXZlLWFpXCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGVcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly9nZW5lcmF0aXZlbGFuZ3VhZ2UuZ29vZ2xlYXBpcy5jb20vdjFiZXRhXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMCxcblx0XHRcdFx0b3V0cHV0OiAwLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMjU2MDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLWdlbmVyYXRpdmUtYWlcIj4sXG5cdH0gYXMgY29uc3Qgc2F0aXNmaWVzIFJlY29yZDxzdHJpbmcsIE1vZGVsPGFueT4+O1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBS08sTUFBTSxnQkFBZ0I7QUFBQSxFQUMzQixvQkFBb0I7QUFBQSxJQUNuQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx1QkFBdUI7QUFBQSxJQUN0QixJQUFJO0FBQUEsSUFDSixNQUFNO0FB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
