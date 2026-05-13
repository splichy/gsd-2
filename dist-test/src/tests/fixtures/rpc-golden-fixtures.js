const rpcGoldenCommands = [
  { id: "cmd-init", type: "init", protocolVersion: 2, clientId: "phase-0-fixture" },
  { id: "cmd-state", type: "get_state" },
  { id: "cmd-bash", type: "bash", command: "printf ok" },
  { id: "cmd-thinking", type: "set_thinking_level", level: "xhigh" },
  { id: "cmd-stats", type: "get_session_stats" },
  { id: "cmd-prompt", type: "prompt", message: "Summarize current status", streamingBehavior: "followUp" }
];
const rpcGoldenResponses = [
  {
    id: "cmd-init",
    type: "response",
    command: "init",
    success: true,
    data: {
      protocolVersion: 2,
      sessionId: "session-fixture",
      capabilities: {
        events: ["execution_complete", "cost_update"],
        commands: ["init", "get_state", "bash", "set_thinking_level", "get_session_stats", "prompt"]
      }
    }
  },
  {
    id: "cmd-state",
    type: "response",
    command: "get_state",
    success: true,
    data: {
      model: { provider: "fixture-provider", id: "fixture-model", contextWindow: 2e5 },
      thinkingLevel: "xhigh",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      sessionFile: "/tmp/gsd/session.json",
      sessionId: "session-fixture",
      sessionName: "Phase 0 Fixture",
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      retryInProgress: false,
      retryAttempt: 0,
      messageCount: 4,
      pendingMessageCount: 0,
      extensionsReady: true
    }
  },
  {
    id: "cmd-bash",
    type: "response",
    command: "bash",
    success: true,
    data: {
      output: "ok",
      exitCode: 0,
      cancelled: false,
      truncated: false
    }
  },
  {
    id: "cmd-stats",
    type: "response",
    command: "get_session_stats",
    success: true,
    data: {
      sessionFile: "/tmp/gsd/session.json",
      sessionId: "session-fixture",
      userMessages: 2,
      assistantMessages: 2,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 4,
      tokens: {
        input: 1e3,
        output: 400,
        cacheRead: 200,
        cacheWrite: 50,
        total: 1650
      },
      cost: 0.05
    }
  }
];
const rpcGoldenEvents = [
  {
    type: "execution_complete",
    runId: "run-fixture",
    status: "completed",
    stats: rpcGoldenResponses[3].data
  },
  {
    type: "cost_update",
    runId: "run-fixture",
    turnCost: 0.01,
    cumulativeCost: 0.05,
    tokens: {
      input: 1e3,
      output: 400,
      cacheRead: 200,
      cacheWrite: 50
    }
  }
];
const rpcGoldenRecords = [
  ...rpcGoldenCommands,
  ...rpcGoldenResponses,
  ...rpcGoldenEvents
];
export {
  rpcGoldenCommands,
  rpcGoldenEvents,
  rpcGoldenRecords,
  rpcGoldenResponses
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vc3JjL3Rlc3RzL2ZpeHR1cmVzL3JwYy1nb2xkZW4tZml4dHVyZXMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBTaGFyZWQgUlBDIHByb3RvY29sIGZpeHR1cmUgcmVjb3JkcyBmb3IgUGhhc2UgMCBjaGFyYWN0ZXJpemF0aW9uIGFuZCBQaGFzZSAxIGNvbnRyYWN0cyB3b3JrLlxuXG5leHBvcnQgY29uc3QgcnBjR29sZGVuQ29tbWFuZHMgPSBbXG4gIHsgaWQ6IFwiY21kLWluaXRcIiwgdHlwZTogXCJpbml0XCIsIHByb3RvY29sVmVyc2lvbjogMiwgY2xpZW50SWQ6IFwicGhhc2UtMC1maXh0dXJlXCIgfSxcbiAgeyBpZDogXCJjbWQtc3RhdGVcIiwgdHlwZTogXCJnZXRfc3RhdGVcIiB9LFxuICB7IGlkOiBcImNtZC1iYXNoXCIsIHR5cGU6IFwiYmFzaFwiLCBjb21tYW5kOiBcInByaW50ZiBva1wiIH0sXG4gIHsgaWQ6IFwiY21kLXRoaW5raW5nXCIsIHR5cGU6IFwic2V0X3RoaW5raW5nX2xldmVsXCIsIGxldmVsOiBcInhoaWdoXCIgfSxcbiAgeyBpZDogXCJjbWQtc3RhdHNcIiwgdHlwZTogXCJnZXRfc2Vzc2lvbl9zdGF0c1wiIH0sXG4gIHsgaWQ6IFwiY21kLXByb21wdFwiLCB0eXBlOiBcInByb21wdFwiLCBtZXNzYWdlOiBcIlN1bW1hcml6ZSBjdXJyZW50IHN0YXR1c1wiLCBzdHJlYW1pbmdCZWhhdmlvcjogXCJmb2xsb3dVcFwiIH0sXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgY29uc3QgcnBjR29sZGVuUmVzcG9uc2VzID0gW1xuICB7XG4gICAgaWQ6IFwiY21kLWluaXRcIixcbiAgICB0eXBlOiBcInJlc3BvbnNlXCIsXG4gICAgY29tbWFuZDogXCJpbml0XCIsXG4gICAgc3VjY2VzczogdHJ1ZSxcbiAgICBkYXRhOiB7XG4gICAgICBwcm90b2NvbFZlcnNpb246IDIsXG4gICAgICBzZXNzaW9uSWQ6IFwic2Vzc2lvbi1maXh0dXJlXCIsXG4gICAgICBjYXBhYmlsaXRpZXM6IHtcbiAgICAgICAgZXZlbnRzOiBbXCJleGVjdXRpb25fY29tcGxldGVcIiwgXCJjb3N0X3VwZGF0ZVwiXSxcbiAgICAgICAgY29tbWFuZHM6IFtcImluaXRcIiwgXCJnZXRfc3RhdGVcIiwgXCJiYXNoXCIsIFwic2V0X3RoaW5raW5nX2xldmVsXCIsIFwiZ2V0X3Nlc3Npb25fc3RhdHNcIiwgXCJwcm9tcHRcIl0sXG4gICAgICB9LFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBpZDogXCJjbWQtc3RhdGVcIixcbiAgICB0eXBlOiBcInJlc3BvbnNlXCIsXG4gICAgY29tbWFuZDogXCJnZXRfc3RhdGVcIixcbiAgICBzdWNjZXNzOiB0cnVlLFxuICAgIGRhdGE6IHtcbiAgICAgIG1vZGVsOiB7IHByb3ZpZGVyOiBcImZpeHR1cmUtcHJvdmlkZXJcIiwgaWQ6IFwiZml4dHVyZS1tb2RlbFwiLCBjb250ZXh0V2luZG93OiAyMDAwMDAgfSxcbiAgICAgIHRoaW5raW5nTGV2ZWw6IFwieGhpZ2hcIixcbiAgICAgIGlzU3RyZWFtaW5nOiBmYWxzZSxcbiAgICAgIGlzQ29tcGFjdGluZzogZmFsc2UsXG4gICAgICBzdGVlcmluZ01vZGU6IFwiYWxsXCIsXG4gICAgICBmb2xsb3dVcE1vZGU6IFwib25lLWF0LWEtdGltZVwiLFxuICAgICAgc2Vzc2lvbkZpbGU6IFwiL3RtcC9nc2Qvc2Vzc2lvbi5qc29uXCIsXG4gICAgICBzZXNzaW9uSWQ6IFwic2Vzc2lvbi1maXh0dXJlXCIsXG4gICAgICBzZXNzaW9uTmFtZTogXCJQaGFzZSAwIEZpeHR1cmVcIixcbiAgICAgIGF1dG9Db21wYWN0aW9uRW5hYmxlZDogdHJ1ZSxcbiAgICAgIGF1dG9SZXRyeUVuYWJsZWQ6IHRydWUsXG4gICAgICByZXRyeUluUHJvZ3Jlc3M6IGZhbHNlLFxuICAgICAgcmV0cnlBdHRlbXB0OiAwLFxuICAgICAgbWVzc2FnZUNvdW50OiA0LFxuICAgICAgcGVuZGluZ01lc3NhZ2VDb3VudDogMCxcbiAgICAgIGV4dGVuc2lvbnNSZWFkeTogdHJ1ZSxcbiAgICB9LFxuICB9LFxuICB7XG4gICAgaWQ6IFwiY21kLWJhc2hcIixcbiAgICB0eXBlOiBcInJlc3BvbnNlXCIsXG4gICAgY29tbWFuZDogXCJiYXNoXCIsXG4gICAgc3VjY2VzczogdHJ1ZSxcbiAgICBkYXRhOiB7XG4gICAgICBvdXRwdXQ6IFwib2tcIixcbiAgICAgIGV4aXRDb2RlOiAwLFxuICAgICAgY2FuY2VsbGVkOiBmYWxzZSxcbiAgICAgIHRydW5jYXRlZDogZmFsc2UsXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIGlkOiBcImNtZC1zdGF0c1wiLFxuICAgIHR5cGU6IFwicmVzcG9uc2VcIixcbiAgICBjb21tYW5kOiBcImdldF9zZXNzaW9uX3N0YXRzXCIsXG4gICAgc3VjY2VzczogdHJ1ZSxcbiAgICBkYXRhOiB7XG4gICAgICBzZXNzaW9uRmlsZTogXCIvdG1wL2dzZC9zZXNzaW9uLmpzb25cIixcbiAgICAgIHNlc3Npb25JZDogXCJzZXNzaW9uLWZpeHR1cmVcIixcbiAgICAgIHVzZXJNZXNzYWdlczogMixcbiAgICAgIGFzc2lzdGFudE1lc3NhZ2VzOiAyLFxuICAgICAgdG9vbENhbGxzOiAxLFxuICAgICAgdG9vbFJlc3VsdHM6IDEsXG4gICAgICB0b3RhbE1lc3NhZ2VzOiA0LFxuICAgICAgdG9rZW5zOiB7XG4gICAgICAgIGlucHV0OiAxMDAwLFxuICAgICAgICBvdXRwdXQ6IDQwMCxcbiAgICAgICAgY2FjaGVSZWFkOiAyMDAsXG4gICAgICAgIGNhY2hlV3JpdGU6IDUwLFxuICAgICAgICB0b3RhbDogMTY1MCxcbiAgICAgIH0sXG4gICAgICBjb3N0OiAwLjA1LFxuICAgIH0sXG4gIH0sXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgY29uc3QgcnBjR29sZGVuRXZlbnRzID0gW1xuICB7XG4gICAgdHlwZTogXCJleGVjdXRpb25fY29tcGxldGVcIixcbiAgICBydW5JZDogXCJydW4tZml4dHVyZVwiLFxuICAgIHN0YXR1czogXCJjb21wbGV0ZWRcIixcbiAgICBzdGF0czogcnBjR29sZGVuUmVzcG9uc2VzWzNdLmRhdGEsXG4gIH0sXG4gIHtcbiAgICB0eXBlOiBcImNvc3RfdXBkYXRlXCIsXG4gICAgcnVuSWQ6IFwicnVuLWZpeHR1cmVcIixcbiAgICB0dXJuQ29zdDogMC4wMSxcbiAgICBjdW11bGF0aXZlQ29zdDogMC4wNSxcbiAgICB0b2tlbnM6IHtcbiAgICAgIGlucHV0OiAxMDAwLFxuICAgICAgb3V0cHV0OiA0MDAsXG4gICAgICBjYWNoZVJlYWQ6IDIwMCxcbiAgICAgIGNhY2hlV3JpdGU6IDUwLFxuICAgIH0sXG4gIH0sXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgY29uc3QgcnBjR29sZGVuUmVjb3JkcyA9IFtcbiAgLi4ucnBjR29sZGVuQ29tbWFuZHMsXG4gIC4uLnJwY0dvbGRlblJlc3BvbnNlcyxcbiAgLi4ucnBjR29sZGVuRXZlbnRzLFxuXSBhcyBjb25zdDtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdPLE1BQU0sb0JBQW9CO0FBQUEsRUFDL0IsRUFBRSxJQUFJLFlBQVksTUFBTSxRQUFRLGlCQUFpQixHQUFHLFVBQVUsa0JBQWtCO0FBQUEsRUFDaEYsRUFBRSxJQUFJLGFBQWEsTUFBTSxZQUFZO0FBQUEsRUFDckMsRUFBRSxJQUFJLFlBQVksTUFBTSxRQUFRLFNBQVMsWUFBWTtBQUFBLEVBQ3JELEVBQUUsSUFBSSxnQkFBZ0IsTUFBTSxzQkFBc0IsT0FBTyxRQUFRO0FBQUEsRUFDakUsRUFBRSxJQUFJLGFBQWEsTUFBTSxvQkFBb0I7QUFBQSxFQUM3QyxFQUFFLElBQUksY0FBYyxNQUFNLFVBQVUsU0FBUyw0QkFBNEIsbUJBQW1CLFdBQVc7QUFDekc7QUFFTyxNQUFNLHFCQUFxQjtBQUFBLEVBQ2hDO0FBQUEsSUFDRSxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixTQUFTO0FBQUEsSUFDVCxTQUFTO0FBQUEsSUFDVCxNQUFNO0FBQUEsTUFDSixpQkFBaUI7QUFBQSxNQUNqQixXQUFXO0FBQUEsTUFDWCxjQUFjO0FBQUEsUUFDWixRQUFRLENBQUMsc0JBQXNCLGFBQWE7QUFBQSxRQUM1QyxVQUFVLENBQUMsUUFBUSxhQUFhLFFBQVEsc0JBQXNCLHFCQUFxQixRQUFRO0FBQUEsTUFDN0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0E7QUFBQSxJQUNFLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLFNBQVM7QUFBQSxJQUNULFNBQVM7QUFBQSxJQUNULE1BQU07QUFBQSxNQUNKLE9BQU8sRUFBRSxVQUFVLG9CQUFvQixJQUFJLGlCQUFpQixlQUFlLElBQU87QUFBQSxNQUNsRixlQUFlO0FBQUEsTUFDZixhQUFhO0FBQUEsTUFDYixjQUFjO0FBQUEsTUFDZCxjQUFjO0FBQUEsTUFDZCxjQUFjO0FBQUEsTUFDZCxhQUFhO0FBQUEsTUFDYixXQUFXO0FBQUEsTUFDWCxhQUFhO0FBQUEsTUFDYix1QkFBdUI7QUFBQSxNQUN2QixrQkFBa0I7QUFBQSxNQUNsQixpQkFBaUI7QUFBQSxNQUNqQixjQUFjO0FBQUEsTUFDZCxjQUFjO0FBQUEsTUFDZCxxQkFBcUI7QUFBQSxNQUNyQixpQkFBaUI7QUFBQSxJQUNuQjtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUEsSUFDRSxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixTQUFTO0FBQUEsSUFDVCxTQUFTO0FBQUEsSUFDVCxNQUFNO0FBQUEsTUFDSixRQUFRO0FBQUEsTUFDUixVQUFVO0FBQUEsTUFDVixXQUFXO0FBQUEsTUFDWCxXQUFXO0FBQUEsSUFDYjtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUEsSUFDRSxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixTQUFTO0FBQUEsSUFDVCxTQUFTO0FBQUEsSUFDVCxNQUFNO0FBQUEsTUFDSixhQUFhO0FBQUEsTUFDYixXQUFXO0FBQUEsTUFDWCxjQUFjO0FBQUEsTUFDZCxtQkFBbUI7QUFBQSxNQUNuQixXQUFXO0FBQUEsTUFDWCxhQUFhO0FBQUEsTUFDYixlQUFlO0FBQUEsTUFDZixRQUFRO0FBQUEsUUFDTixPQUFPO0FBQUEsUUFDUCxRQUFRO0FBQUEsUUFDUixXQUFXO0FBQUEsUUFDWCxZQUFZO0FBQUEsUUFDWixPQUFPO0FBQUEsTUFDVDtBQUFBLE1BQ0EsTUFBTTtBQUFBLElBQ1I7QUFBQSxFQUNGO0FBQ0Y7QUFFTyxNQUFNLGtCQUFrQjtBQUFBLEVBQzdCO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxRQUFRO0FBQUEsSUFDUixPQUFPLG1CQUFtQixDQUFDLEVBQUU7QUFBQSxFQUMvQjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLFVBQVU7QUFBQSxJQUNWLGdCQUFnQjtBQUFBLElBQ2hCLFFBQVE7QUFBQSxNQUNOLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFdBQVc7QUFBQSxNQUNYLFlBQVk7QUFBQSxJQUNkO0FBQUEsRUFDRjtBQUNGO0FBRU8sTUFBTSxtQkFBbUI7QUFBQSxFQUM5QixHQUFHO0FBQUEsRUFDSCxHQUFHO0FBQUEsRUFDSCxHQUFHO0FBQ0w7IiwKICAibmFtZXMiOiBbXQp9Cg==
