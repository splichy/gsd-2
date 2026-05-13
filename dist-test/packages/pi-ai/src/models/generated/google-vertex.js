const GOOGLE_VERTEX_MODELS = {
  "gemini-1.5-flash": {
    id: "gemini-1.5-flash",
    name: "Gemini 1.5 Flash (Vertex)",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
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
    name: "Gemini 1.5 Flash-8B (Vertex)",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
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
    name: "Gemini 1.5 Pro (Vertex)",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
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
    name: "Gemini 2.0 Flash (Vertex)",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0.0375,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 8192
  },
  "gemini-2.0-flash-lite": {
    id: "gemini-2.0-flash-lite",
    name: "Gemini 2.0 Flash Lite (Vertex)",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.075,
      output: 0.3,
      cacheRead: 0.01875,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-2.5-flash": {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash (Vertex)",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.3,
      output: 2.5,
      cacheRead: 0.03,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-2.5-flash-lite": {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite (Vertex)",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.1,
      output: 0.4,
      cacheRead: 0.01,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-2.5-flash-lite-preview-09-2025": {
    id: "gemini-2.5-flash-lite-preview-09-2025",
    name: "Gemini 2.5 Flash Lite Preview 09-25 (Vertex)",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.1,
      output: 0.4,
      cacheRead: 0.01,
      cacheWrite: 0
    },
    contextWindow: 1048576,
    maxTokens: 65536
  },
  "gemini-2.5-pro": {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro (Vertex)",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
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
  "gemini-3-flash-preview": {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview (Vertex)",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
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
    name: "Gemini 3 Pro Preview (Vertex)",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
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
  "gemini-3.1-pro-preview": {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview (Vertex)",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
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
  }
};
export {
  GOOGLE_VERTEX_MODELS
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL21vZGVscy9nZW5lcmF0ZWQvZ29vZ2xlLXZlcnRleC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gVGhpcyBmaWxlIGlzIGF1dG8tZ2VuZXJhdGVkIGJ5IHNjcmlwdHMvZ2VuZXJhdGUtbW9kZWxzLnRzXG4vLyBEbyBub3QgZWRpdCBtYW51YWxseSAtIHJ1biAnbnBtIHJ1biBnZW5lcmF0ZS1tb2RlbHMnIHRvIHVwZGF0ZVxuXG5pbXBvcnQgdHlwZSB7IE1vZGVsIH0gZnJvbSBcIi4uLy4uL3R5cGVzLmpzXCI7XG5cbmV4cG9ydCBjb25zdCBHT09HTEVfVkVSVEVYX01PREVMUyA9IHtcblx0XHRcImdlbWluaS0xLjUtZmxhc2hcIjoge1xuXHRcdFx0aWQ6IFwiZ2VtaW5pLTEuNS1mbGFzaFwiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMS41IEZsYXNoIChWZXJ0ZXgpXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLXZlcnRleFwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ29vZ2xlLXZlcnRleFwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL3tsb2NhdGlvbn0tYWlwbGF0Zm9ybS5nb29nbGVhcGlzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjA3NSxcblx0XHRcdFx0b3V0cHV0OiAwLjMsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMTg3NSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA4MTkyLFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLXZlcnRleFwiPixcblx0XHRcImdlbWluaS0xLjUtZmxhc2gtOGJcIjoge1xuXHRcdFx0aWQ6IFwiZ2VtaW5pLTEuNS1mbGFzaC04YlwiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMS41IEZsYXNoLThCIChWZXJ0ZXgpXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLXZlcnRleFwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ29vZ2xlLXZlcnRleFwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL3tsb2NhdGlvbn0tYWlwbGF0Zm9ybS5nb29nbGVhcGlzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiBmYWxzZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAwLjAzNzUsXG5cdFx0XHRcdG91dHB1dDogMC4xNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAxLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwMDAwMDAsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtdmVydGV4XCI+LFxuXHRcdFwiZ2VtaW5pLTEuNS1wcm9cIjoge1xuXHRcdFx0aWQ6IFwiZ2VtaW5pLTEuNS1wcm9cIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIDEuNSBQcm8gKFZlcnRleClcIixcblx0XHRcdGFwaTogXCJnb29nbGUtdmVydGV4XCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGUtdmVydGV4XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8ve2xvY2F0aW9ufS1haXBsYXRmb3JtLmdvb2dsZWFwaXMuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IGZhbHNlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMjUsXG5cdFx0XHRcdG91dHB1dDogNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjMxMjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTAwMDAwMCxcblx0XHRcdG1heFRva2VuczogODE5Mixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS12ZXJ0ZXhcIj4sXG5cdFx0XCJnZW1pbmktMi4wLWZsYXNoXCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS0yLjAtZmxhc2hcIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIDIuMCBGbGFzaCAoVmVydGV4KVwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS12ZXJ0ZXhcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZS12ZXJ0ZXhcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly97bG9jYXRpb259LWFpcGxhdGZvcm0uZ29vZ2xlYXBpcy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogZmFsc2UsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xNSxcblx0XHRcdFx0b3V0cHV0OiAwLjYsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMzc1LFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDgxOTIsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtdmVydGV4XCI+LFxuXHRcdFwiZ2VtaW5pLTIuMC1mbGFzaC1saXRlXCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS0yLjAtZmxhc2gtbGl0ZVwiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMi4wIEZsYXNoIExpdGUgKFZlcnRleClcIixcblx0XHRcdGFwaTogXCJnb29nbGUtdmVydGV4XCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGUtdmVydGV4XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8ve2xvY2F0aW9ufS1haXBsYXRmb3JtLmdvb2dsZWFwaXMuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4wNzUsXG5cdFx0XHRcdG91dHB1dDogMC4zLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMDE4NzUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtdmVydGV4XCI+LFxuXHRcdFwiZ2VtaW5pLTIuNS1mbGFzaFwiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMi41LWZsYXNoXCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAyLjUgRmxhc2ggKFZlcnRleClcIixcblx0XHRcdGFwaTogXCJnb29nbGUtdmVydGV4XCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGUtdmVydGV4XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8ve2xvY2F0aW9ufS1haXBsYXRmb3JtLmdvb2dsZWFwaXMuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4zLFxuXHRcdFx0XHRvdXRwdXQ6IDIuNSxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAzLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLXZlcnRleFwiPixcblx0XHRcImdlbWluaS0yLjUtZmxhc2gtbGl0ZVwiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMi41LWZsYXNoLWxpdGVcIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIDIuNSBGbGFzaCBMaXRlIChWZXJ0ZXgpXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLXZlcnRleFwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ29vZ2xlLXZlcnRleFwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL3tsb2NhdGlvbn0tYWlwbGF0Zm9ybS5nb29nbGVhcGlzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDAuMSxcblx0XHRcdFx0b3V0cHV0OiAwLjQsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wMSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS12ZXJ0ZXhcIj4sXG5cdFx0XCJnZW1pbmktMi41LWZsYXNoLWxpdGUtcHJldmlldy0wOS0yMDI1XCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS0yLjUtZmxhc2gtbGl0ZS1wcmV2aWV3LTA5LTIwMjVcIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIDIuNSBGbGFzaCBMaXRlIFByZXZpZXcgMDktMjUgKFZlcnRleClcIixcblx0XHRcdGFwaTogXCJnb29nbGUtdmVydGV4XCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGUtdmVydGV4XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8ve2xvY2F0aW9ufS1haXBsYXRmb3JtLmdvb2dsZWFwaXMuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC4xLFxuXHRcdFx0XHRvdXRwdXQ6IDAuNCxcblx0XHRcdFx0Y2FjaGVSZWFkOiAwLjAxLFxuXHRcdFx0XHRjYWNoZVdyaXRlOiAwLFxuXHRcdFx0fSxcblx0XHRcdGNvbnRleHRXaW5kb3c6IDEwNDg1NzYsXG5cdFx0XHRtYXhUb2tlbnM6IDY1NTM2LFxuXHRcdH0gc2F0aXNmaWVzIE1vZGVsPFwiZ29vZ2xlLXZlcnRleFwiPixcblx0XHRcImdlbWluaS0yLjUtcHJvXCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS0yLjUtcHJvXCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAyLjUgUHJvIChWZXJ0ZXgpXCIsXG5cdFx0XHRhcGk6IFwiZ29vZ2xlLXZlcnRleFwiLFxuXHRcdFx0cHJvdmlkZXI6IFwiZ29vZ2xlLXZlcnRleFwiLFxuXHRcdFx0YmFzZVVybDogXCJodHRwczovL3tsb2NhdGlvbn0tYWlwbGF0Zm9ybS5nb29nbGVhcGlzLmNvbVwiLFxuXHRcdFx0cmVhc29uaW5nOiB0cnVlLFxuXHRcdFx0aW5wdXQ6IFtcInRleHRcIiwgXCJpbWFnZVwiXSxcblx0XHRcdGNvc3Q6IHtcblx0XHRcdFx0aW5wdXQ6IDEuMjUsXG5cdFx0XHRcdG91dHB1dDogMTAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4xMjUsXG5cdFx0XHRcdGNhY2hlV3JpdGU6IDAsXG5cdFx0XHR9LFxuXHRcdFx0Y29udGV4dFdpbmRvdzogMTA0ODU3Nixcblx0XHRcdG1heFRva2VuczogNjU1MzYsXG5cdFx0fSBzYXRpc2ZpZXMgTW9kZWw8XCJnb29nbGUtdmVydGV4XCI+LFxuXHRcdFwiZ2VtaW5pLTMtZmxhc2gtcHJldmlld1wiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMy1mbGFzaC1wcmV2aWV3XCIsXG5cdFx0XHRuYW1lOiBcIkdlbWluaSAzIEZsYXNoIFByZXZpZXcgKFZlcnRleClcIixcblx0XHRcdGFwaTogXCJnb29nbGUtdmVydGV4XCIsXG5cdFx0XHRwcm92aWRlcjogXCJnb29nbGUtdmVydGV4XCIsXG5cdFx0XHRiYXNlVXJsOiBcImh0dHBzOi8ve2xvY2F0aW9ufS1haXBsYXRmb3JtLmdvb2dsZWFwaXMuY29tXCIsXG5cdFx0XHRyZWFzb25pbmc6IHRydWUsXG5cdFx0XHRpbnB1dDogW1widGV4dFwiLCBcImltYWdlXCJdLFxuXHRcdFx0Y29zdDoge1xuXHRcdFx0XHRpbnB1dDogMC41LFxuXHRcdFx0XHRvdXRwdXQ6IDMsXG5cdFx0XHRcdGNhY2hlUmVhZDogMC4wNSxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS12ZXJ0ZXhcIj4sXG5cdFx0XCJnZW1pbmktMy1wcm8tcHJldmlld1wiOiB7XG5cdFx0XHRpZDogXCJnZW1pbmktMy1wcm8tcHJldmlld1wiLFxuXHRcdFx0bmFtZTogXCJHZW1pbmkgMyBQcm8gUHJldmlldyAoVmVydGV4KVwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS12ZXJ0ZXhcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZS12ZXJ0ZXhcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly97bG9jYXRpb259LWFpcGxhdGZvcm0uZ29vZ2xlYXBpcy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLFxuXHRcdFx0XHRvdXRwdXQ6IDEyLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDAwMDAwLFxuXHRcdFx0bWF4VG9rZW5zOiA2NDAwMCxcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS12ZXJ0ZXhcIj4sXG5cdFx0XCJnZW1pbmktMy4xLXByby1wcmV2aWV3XCI6IHtcblx0XHRcdGlkOiBcImdlbWluaS0zLjEtcHJvLXByZXZpZXdcIixcblx0XHRcdG5hbWU6IFwiR2VtaW5pIDMuMSBQcm8gUHJldmlldyAoVmVydGV4KVwiLFxuXHRcdFx0YXBpOiBcImdvb2dsZS12ZXJ0ZXhcIixcblx0XHRcdHByb3ZpZGVyOiBcImdvb2dsZS12ZXJ0ZXhcIixcblx0XHRcdGJhc2VVcmw6IFwiaHR0cHM6Ly97bG9jYXRpb259LWFpcGxhdGZvcm0uZ29vZ2xlYXBpcy5jb21cIixcblx0XHRcdHJlYXNvbmluZzogdHJ1ZSxcblx0XHRcdGlucHV0OiBbXCJ0ZXh0XCIsIFwiaW1hZ2VcIl0sXG5cdFx0XHRjb3N0OiB7XG5cdFx0XHRcdGlucHV0OiAyLFxuXHRcdFx0XHRvdXRwdXQ6IDEyLFxuXHRcdFx0XHRjYWNoZVJlYWQ6IDAuMixcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdH0sXG5cdFx0XHRjb250ZXh0V2luZG93OiAxMDQ4NTc2LFxuXHRcdFx0bWF4VG9rZW5zOiA2NTUzNixcblx0XHR9IHNhdGlzZmllcyBNb2RlbDxcImdvb2dsZS12ZXJ0ZXhcIj4sXG5cdH0gYXMgY29uc3Qgc2F0aXNmaWVzIFJlY29yZDxzdHJpbmcsIE1vZGVsPGFueT4+O1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBS08sTUFBTSx1QkFBdUI7QUFBQSxFQUNsQyxvQkFBb0I7QUFBQSxJQUNuQixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIsTUFBTTtBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsUUFBUTtBQUFBLE1BQ1IsV0FBVztBQUFBLE1BQ1gsWUFBWTtBQUFBLElBQ2I7QUFBQSxJQUNBLGVBQWU7QUFBQSxJQUNmLFdBQVc7QUFBQSxFQUNaO0FBQUEsRUFDQSx1QkFBdUI7QUFBQSxJQUN0QixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxXQUFXO0FBQUEsSUFDWCxPQUFPLENBQUMsUUFBUSxPQUFPO0FBQUEsSUFDdkIs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
