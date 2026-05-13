import { z } from "zod";
function resolveAnthropicApiKey() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required. Set it in your environment or run `gsd config`."
    );
  }
  return apiKey;
}
const SYSTEM_PROMPT = `You are GSD Control \u2014 a concise, capable orchestrator for managing GSD (Get Shit Done) coding agent sessions via Discord.

You have tools to list projects, start sessions, get status, stop sessions, and inspect session details. Use them to fulfill the user's requests.

Response guidelines:
- Be terse and direct. No filler, no performed enthusiasm.
- When reporting status, use bullet points with project name, status, duration, and cost.
- When starting a session, confirm with the project name and session ID.
- When stopping a session, confirm which session was stopped.
- If something fails, say what went wrong plainly.
- Use Discord markdown formatting (bold, code blocks) for readability.
- Never expose internal error stack traces to the user \u2014 summarize the issue.`;
const TOOLS = [
  {
    name: "list_projects",
    description: "List all detected projects across configured scan roots. Returns project names, paths, and detected markers (git, node, gsd, etc.).",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "start_session",
    description: 'Start a new GSD auto-mode session for a project. Provide the absolute project path. Optionally provide a command to run instead of the default "/gsd auto".',
    input_schema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "Absolute path to the project directory" },
        command: { type: "string", description: 'Optional command to send instead of "/gsd auto"' }
      },
      required: ["projectPath"]
    }
  },
  {
    name: "get_status",
    description: "Get the current status of all active GSD sessions. Shows project name, status, duration, and cost for each.",
    input_schema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "stop_session",
    description: "Stop a running GSD session. Provide a session ID or project name \u2014 fuzzy matching is used to find the session.",
    input_schema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Session ID or project name to match" }
      },
      required: ["identifier"]
    }
  },
  {
    name: "get_session_detail",
    description: "Get detailed information about a specific session including cost breakdown, recent events, pending blockers, and error state.",
    input_schema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "The session ID to inspect" }
      },
      required: ["sessionId"]
    }
  }
];
const StartSessionInput = z.object({
  projectPath: z.string(),
  command: z.string().optional()
});
const StopSessionInput = z.object({
  identifier: z.string()
});
const GetSessionDetailInput = z.object({
  sessionId: z.string()
});
const MAX_HISTORY = 30;
class Orchestrator {
  deps;
  client;
  history = [];
  /**
   * @param deps - orchestrator dependencies (session manager, channel manager, etc.)
   * @param client - optional Anthropic client for testability; if omitted, created from env
   */
  constructor(deps, client) {
    this.deps = deps;
    this.client = client ?? null;
  }
  /**
   * Lazily initialise the Anthropic client. Dynamic import handles K007 module resolution.
   * Requires ANTHROPIC_API_KEY environment variable.
   */
  async getClient() {
    if (this.client) return this.client;
    const apiKey = resolveAnthropicApiKey();
    const { default: AnthropicSDK } = await import("@anthropic-ai/sdk");
    this.client = new AnthropicSDK({ apiKey });
    return this.client;
  }
  /**
   * Handle an incoming Discord message. Entry point called by the bot's
   * message handler for every message in every channel.
   *
   * Guards: ignores bot messages, non-owner messages, and non-control-channel messages.
   */
  async handleMessage(message) {
    if (message.author.bot) return;
    if (message.channelId !== this.deps.config.control_channel_id) return;
    if (message.author.id !== this.deps.ownerId) {
      this.deps.logger.debug("orchestrator auth rejected", { userId: message.author.id });
      return;
    }
    const content = message.content?.trim();
    if (!content) return;
    this.deps.logger.info("orchestrator message received", {
      userId: message.author.id,
      channelId: message.channelId,
      contentLength: content.length
    });
    this.history.push({ role: "user", content });
    try {
      await message.channel.sendTyping().catch(() => {
      });
      const responseText = await this.runAgentLoop();
      await message.channel.send(responseText);
      this.deps.logger.info("orchestrator response sent", {
        channelId: message.channelId,
        responseLength: responseText.length
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes("authentication") || errorMsg.includes("apiKey") || errorMsg.includes("authToken") || errorMsg.includes("401")) {
        this.client = null;
      }
      this.deps.logger.error("orchestrator error", {
        error: errorMsg,
        userId: message.author.id,
        channelId: message.channelId
      });
      try {
        await message.channel.send("\u26A0\uFE0F Something went wrong processing your request.");
      } catch (sendErr) {
        this.deps.logger.warn("orchestrator error reply failed", {
          error: sendErr instanceof Error ? sendErr.message : String(sendErr)
        });
      }
      this.history.push({ role: "assistant", content: "[error \u2014 see logs]" });
    }
    this.trimHistory();
  }
  /**
   * Run the tool-use loop: call messages.create(), execute any tool calls,
   * feed results back, repeat until the model produces a final text response.
   */
  async runAgentLoop() {
    const client = await this.getClient();
    const { model, max_tokens } = this.deps.config;
    let loopMessages = [...this.history];
    const maxIterations = 10;
    for (let i = 0; i < maxIterations; i++) {
      const response = await client.messages.create({
        model,
        max_tokens,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: loopMessages
      });
      if (response.stop_reason === "end_turn" || response.stop_reason !== "tool_use") {
        const textBlocks = response.content.filter(
          (b) => b.type === "text"
        );
        const finalText = textBlocks.map((b) => b.text).join("\n") || "(No response)";
        this.history.push({ role: "assistant", content: finalText });
        return finalText;
      }
      const toolUseBlocks = response.content.filter(
        (b) => b.type === "tool_use"
      );
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        const result = await this.executeTool(toolUse.name, toolUse.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result
        });
      }
      loopMessages = [
        ...loopMessages,
        { role: "assistant", content: response.content },
        { role: "user", content: toolResults }
      ];
    }
    return "I hit the maximum number of tool iterations. Please try a simpler request.";
  }
  /**
   * Execute a single tool by name. Returns a string result for the LLM.
   * All errors are caught and returned as error strings (the LLM can reason about them).
   */
  async executeTool(name, input) {
    try {
      switch (name) {
        case "list_projects":
          return await this.toolListProjects();
        case "start_session":
          return await this.toolStartSession(input);
        case "get_status":
          return this.toolGetStatus();
        case "get_session_detail":
          return this.toolGetSessionDetail(input);
        case "stop_session":
          return await this.toolStopSession(input);
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.logger.error("tool execution error", { tool: name, error: msg });
      return `Error: ${msg}`;
    }
  }
  // ---------------------------------------------------------------------------
  // Tool implementations
  // ---------------------------------------------------------------------------
  async toolListProjects() {
    const projects = await this.deps.scanProjects();
    if (projects.length === 0) return "No projects found.";
    return JSON.stringify(
      projects.map((p) => ({ name: p.name, path: p.path, markers: p.markers })),
      null,
      2
    );
  }
  async toolStartSession(input) {
    const parsed = StartSessionInput.parse(input);
    const sessionId = await this.deps.sessionManager.startSession({
      projectDir: parsed.projectPath,
      command: parsed.command
    });
    return `Session started: ${sessionId} for ${parsed.projectPath}`;
  }
  toolGetStatus() {
    const sessions = this.deps.sessionManager.getAllSessions();
    if (sessions.length === 0) return "No active sessions.";
    return sessions.map((s) => {
      const durationMin = Math.floor((Date.now() - s.startTime) / 6e4);
      const cost = s.cost.totalCost.toFixed(4);
      return `\u2022 ${s.projectName} \u2014 ${s.status} (${durationMin}m, $${cost})`;
    }).join("\n");
  }
  async toolStopSession(input) {
    const parsed = StopSessionInput.parse(input);
    const { identifier } = parsed;
    const byId = this.deps.sessionManager.getSession(identifier);
    if (byId) {
      await this.deps.sessionManager.cancelSession(identifier);
      return `Stopped session ${identifier} (${byId.projectName})`;
    }
    const all = this.deps.sessionManager.getAllSessions();
    const match = all.find(
      (s) => s.projectName.toLowerCase().includes(identifier.toLowerCase()) || s.projectDir.toLowerCase().includes(identifier.toLowerCase())
    );
    if (match) {
      await this.deps.sessionManager.cancelSession(match.sessionId);
      return `Stopped session ${match.sessionId} (${match.projectName})`;
    }
    return `No session found matching "${identifier}"`;
  }
  toolGetSessionDetail(input) {
    const parsed = GetSessionDetailInput.parse(input);
    const result = this.deps.sessionManager.getResult(parsed.sessionId);
    return JSON.stringify(result, null, 2);
  }
  // ---------------------------------------------------------------------------
  // History management
  // ---------------------------------------------------------------------------
  /**
   * Trim conversation history to MAX_HISTORY entries.
   * Removes the oldest user+assistant pair from the front to keep pairs aligned.
   */
  trimHistory() {
    while (this.history.length > MAX_HISTORY) {
      this.history.splice(0, 2);
    }
  }
  /**
   * Return a copy of the conversation history (for debugging / observability).
   */
  getHistory() {
    return [...this.history];
  }
  /**
   * Stop the orchestrator — clears history and nulls client reference.
   */
  stop() {
    this.history = [];
    this.client = null;
  }
}
export {
  Orchestrator
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvZGFlbW9uL3NyYy9vcmNoZXN0cmF0b3IudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogT3JjaGVzdHJhdG9yIFx1MjAxNCBMTE0tcG93ZXJlZCBhZ2VudCBmb3IgdGhlICNnc2QtY29udHJvbCBEaXNjb3JkIGNoYW5uZWwuXG4gKlxuICogUmVjZWl2ZXMgRGlzY29yZCBtZXNzYWdlcywgbWFpbnRhaW5zIGNvbnZlcnNhdGlvbiBoaXN0b3J5LCBjYWxscyB0aGVcbiAqIEFudGhyb3BpYyBtZXNzYWdlcyBBUEkgd2l0aCA1IHRvb2wgZGVmaW5pdGlvbnMgKGxpc3RfcHJvamVjdHMsIHN0YXJ0X3Nlc3Npb24sXG4gKiBnZXRfc3RhdHVzLCBzdG9wX3Nlc3Npb24sIGdldF9zZXNzaW9uX2RldGFpbCksIGFuZCBzZW5kcyB0aGUgTExNJ3MgcmVzcG9uc2VcbiAqIGJhY2sgdG8gRGlzY29yZC5cbiAqXG4gKiBVc2VzIHRoZSBzdGFuZGFyZCBtZXNzYWdlcy5jcmVhdGUoKSB0b29sLXVzZSBsb29wIChub3QgYmV0YVpvZFRvb2wgaGVscGVycyxcbiAqIHdoaWNoIGRvbid0IGV4aXN0IGluIFNESyB2MC41MikuIFpvZCBzY2hlbWFzIGFyZSB1c2VkIGZvciBpbnB1dCB2YWxpZGF0aW9uXG4gKiBhdCB0aGUgdG9vbCBleGVjdXRpb24gbGF5ZXIuXG4gKi9cblxuaW1wb3J0IHsgeiB9IGZyb20gJ3pvZCc7XG5pbXBvcnQgdHlwZSBBbnRocm9waWMgZnJvbSAnQGFudGhyb3BpYy1haS9zZGsnO1xuaW1wb3J0IHR5cGUge1xuICBNZXNzYWdlUGFyYW0sXG4gIENvbnRlbnRCbG9ja1BhcmFtLFxuICBUb29sLFxuICBUb29sUmVzdWx0QmxvY2tQYXJhbSxcbiAgVG9vbFVzZUJsb2NrLFxuICBUZXh0QmxvY2ssXG59IGZyb20gJ0BhbnRocm9waWMtYWkvc2RrL3Jlc291cmNlcy9tZXNzYWdlcy9tZXNzYWdlcyc7XG5pbXBvcnQgdHlwZSB7IFNlc3Npb25NYW5hZ2VyIH0gZnJvbSAnLi9zZXNzaW9uLW1hbmFnZXIuanMnO1xuaW1wb3J0IHR5cGUgeyBDaGFubmVsTWFuYWdlciB9IGZyb20gJy4vY2hhbm5lbC1tYW5hZ2VyLmpzJztcbmltcG9ydCB0eXBlIHsgUHJvamVjdEluZm8sIE1hbmFnZWRTZXNzaW9uIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IExvZ2dlciB9IGZyb20gJy4vbG9nZ2VyLmpzJztcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBBUEkga2V5IHJlc29sdXRpb24gXHUyMDE0IHJlcXVpcmVzIEFOVEhST1BJQ19BUElfS0VZIGVudiB2YXJcbi8vIEFudGhyb3BpYyBPQXV0aCByZW1vdmVkIHBlciBUT1MgY29tcGxpYW5jZSAoc2VlIGRvY3MvdXNlci1kb2NzL2NsYXVkZS1jb2RlLWF1dGgtY29tcGxpYW5jZS5tZClcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5mdW5jdGlvbiByZXNvbHZlQW50aHJvcGljQXBpS2V5KCk6IHN0cmluZyB7XG4gIGNvbnN0IGFwaUtleSA9IHByb2Nlc3MuZW52LkFOVEhST1BJQ19BUElfS0VZO1xuICBpZiAoIWFwaUtleSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICdBTlRIUk9QSUNfQVBJX0tFWSBpcyByZXF1aXJlZC4gU2V0IGl0IGluIHlvdXIgZW52aXJvbm1lbnQgb3IgcnVuIGBnc2QgY29uZmlnYC4nLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIGFwaUtleTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBDb25maWd1cmF0aW9uXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGludGVyZmFjZSBPcmNoZXN0cmF0b3JDb25maWcge1xuICBtb2RlbDogc3RyaW5nO1xuICBtYXhfdG9rZW5zOiBudW1iZXI7XG4gIGNvbnRyb2xfY2hhbm5lbF9pZDogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIE9yY2hlc3RyYXRvckRlcHMge1xuICBzZXNzaW9uTWFuYWdlcjogU2Vzc2lvbk1hbmFnZXI7XG4gIGNoYW5uZWxNYW5hZ2VyOiBDaGFubmVsTWFuYWdlcjtcbiAgc2NhblByb2plY3RzOiAoKSA9PiBQcm9taXNlPFByb2plY3RJbmZvW10+O1xuICBjb25maWc6IE9yY2hlc3RyYXRvckNvbmZpZztcbiAgbG9nZ2VyOiBMb2dnZXI7XG4gIG93bmVySWQ6IHN0cmluZztcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBTeXN0ZW0gUHJvbXB0XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuY29uc3QgU1lTVEVNX1BST01QVCA9IGBZb3UgYXJlIEdTRCBDb250cm9sIFx1MjAxNCBhIGNvbmNpc2UsIGNhcGFibGUgb3JjaGVzdHJhdG9yIGZvciBtYW5hZ2luZyBHU0QgKEdldCBTaGl0IERvbmUpIGNvZGluZyBhZ2VudCBzZXNzaW9ucyB2aWEgRGlzY29yZC5cblxuWW91IGhhdmUgdG9vbHMgdG8gbGlzdCBwcm9qZWN0cywgc3RhcnQgc2Vzc2lvbnMsIGdldCBzdGF0dXMsIHN0b3Agc2Vzc2lvbnMsIGFuZCBpbnNwZWN0IHNlc3Npb24gZGV0YWlscy4gVXNlIHRoZW0gdG8gZnVsZmlsbCB0aGUgdXNlcidzIHJlcXVlc3RzLlxuXG5SZXNwb25zZSBndWlkZWxpbmVzOlxuLSBCZSB0ZXJzZSBhbmQgZGlyZWN0LiBObyBmaWxsZXIsIG5vIHBlcmZvcm1lZCBlbnRodXNpYXNtLlxuLSBXaGVuIHJlcG9ydGluZyBzdGF0dXMsIHVzZSBidWxsZXQgcG9pbnRzIHdpdGggcHJvamVjdCBuYW1lLCBzdGF0dXMsIGR1cmF0aW9uLCBhbmQgY29zdC5cbi0gV2hlbiBzdGFydGluZyBhIHNlc3Npb24sIGNvbmZpcm0gd2l0aCB0aGUgcHJvamVjdCBuYW1lIGFuZCBzZXNzaW9uIElELlxuLSBXaGVuIHN0b3BwaW5nIGEgc2Vzc2lvbiwgY29uZmlybSB3aGljaCBzZXNzaW9uIHdhcyBzdG9wcGVkLlxuLSBJZiBzb21ldGhpbmcgZmFpbHMsIHNheSB3aGF0IHdlbnQgd3JvbmcgcGxhaW5seS5cbi0gVXNlIERpc2NvcmQgbWFya2Rvd24gZm9ybWF0dGluZyAoYm9sZCwgY29kZSBibG9ja3MpIGZvciByZWFkYWJpbGl0eS5cbi0gTmV2ZXIgZXhwb3NlIGludGVybmFsIGVycm9yIHN0YWNrIHRyYWNlcyB0byB0aGUgdXNlciBcdTIwMTQgc3VtbWFyaXplIHRoZSBpc3N1ZS5gO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRvb2wgRGVmaW5pdGlvbnMgKEFudGhyb3BpYyBBUEkgZm9ybWF0KVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmNvbnN0IFRPT0xTOiBUb29sW10gPSBbXG4gIHtcbiAgICBuYW1lOiAnbGlzdF9wcm9qZWN0cycsXG4gICAgZGVzY3JpcHRpb246ICdMaXN0IGFsbCBkZXRlY3RlZCBwcm9qZWN0cyBhY3Jvc3MgY29uZmlndXJlZCBzY2FuIHJvb3RzLiBSZXR1cm5zIHByb2plY3QgbmFtZXMsIHBhdGhzLCBhbmQgZGV0ZWN0ZWQgbWFya2VycyAoZ2l0LCBub2RlLCBnc2QsIGV0Yy4pLicsXG4gICAgaW5wdXRfc2NoZW1hOiB7XG4gICAgICB0eXBlOiAnb2JqZWN0JyBhcyBjb25zdCxcbiAgICAgIHByb3BlcnRpZXM6IHt9LFxuICAgICAgcmVxdWlyZWQ6IFtdLFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiAnc3RhcnRfc2Vzc2lvbicsXG4gICAgZGVzY3JpcHRpb246ICdTdGFydCBhIG5ldyBHU0QgYXV0by1tb2RlIHNlc3Npb24gZm9yIGEgcHJvamVjdC4gUHJvdmlkZSB0aGUgYWJzb2x1dGUgcHJvamVjdCBwYXRoLiBPcHRpb25hbGx5IHByb3ZpZGUgYSBjb21tYW5kIHRvIHJ1biBpbnN0ZWFkIG9mIHRoZSBkZWZhdWx0IFwiL2dzZCBhdXRvXCIuJyxcbiAgICBpbnB1dF9zY2hlbWE6IHtcbiAgICAgIHR5cGU6ICdvYmplY3QnIGFzIGNvbnN0LFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICBwcm9qZWN0UGF0aDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdBYnNvbHV0ZSBwYXRoIHRvIHRoZSBwcm9qZWN0IGRpcmVjdG9yeScgfSxcbiAgICAgICAgY29tbWFuZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdPcHRpb25hbCBjb21tYW5kIHRvIHNlbmQgaW5zdGVhZCBvZiBcIi9nc2QgYXV0b1wiJyB9LFxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbJ3Byb2plY3RQYXRoJ10sXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6ICdnZXRfc3RhdHVzJyxcbiAgICBkZXNjcmlwdGlvbjogJ0dldCB0aGUgY3VycmVudCBzdGF0dXMgb2YgYWxsIGFjdGl2ZSBHU0Qgc2Vzc2lvbnMuIFNob3dzIHByb2plY3QgbmFtZSwgc3RhdHVzLCBkdXJhdGlvbiwgYW5kIGNvc3QgZm9yIGVhY2guJyxcbiAgICBpbnB1dF9zY2hlbWE6IHtcbiAgICAgIHR5cGU6ICdvYmplY3QnIGFzIGNvbnN0LFxuICAgICAgcHJvcGVydGllczoge30sXG4gICAgICByZXF1aXJlZDogW10sXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6ICdzdG9wX3Nlc3Npb24nLFxuICAgIGRlc2NyaXB0aW9uOiAnU3RvcCBhIHJ1bm5pbmcgR1NEIHNlc3Npb24uIFByb3ZpZGUgYSBzZXNzaW9uIElEIG9yIHByb2plY3QgbmFtZSBcdTIwMTQgZnV6enkgbWF0Y2hpbmcgaXMgdXNlZCB0byBmaW5kIHRoZSBzZXNzaW9uLicsXG4gICAgaW5wdXRfc2NoZW1hOiB7XG4gICAgICB0eXBlOiAnb2JqZWN0JyBhcyBjb25zdCxcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgaWRlbnRpZmllcjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdTZXNzaW9uIElEIG9yIHByb2plY3QgbmFtZSB0byBtYXRjaCcgfSxcbiAgICAgIH0sXG4gICAgICByZXF1aXJlZDogWydpZGVudGlmaWVyJ10sXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6ICdnZXRfc2Vzc2lvbl9kZXRhaWwnLFxuICAgIGRlc2NyaXB0aW9uOiAnR2V0IGRldGFpbGVkIGluZm9ybWF0aW9uIGFib3V0IGEgc3BlY2lmaWMgc2Vzc2lvbiBpbmNsdWRpbmcgY29zdCBicmVha2Rvd24sIHJlY2VudCBldmVudHMsIHBlbmRpbmcgYmxvY2tlcnMsIGFuZCBlcnJvciBzdGF0ZS4nLFxuICAgIGlucHV0X3NjaGVtYToge1xuICAgICAgdHlwZTogJ29iamVjdCcgYXMgY29uc3QsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIHNlc3Npb25JZDogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdUaGUgc2Vzc2lvbiBJRCB0byBpbnNwZWN0JyB9LFxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbJ3Nlc3Npb25JZCddLFxuICAgIH0sXG4gIH0sXG5dO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFpvZCBzY2hlbWFzIGZvciB0b29sIGlucHV0IHZhbGlkYXRpb25cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5jb25zdCBTdGFydFNlc3Npb25JbnB1dCA9IHoub2JqZWN0KHtcbiAgcHJvamVjdFBhdGg6IHouc3RyaW5nKCksXG4gIGNvbW1hbmQ6IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbn0pO1xuXG5jb25zdCBTdG9wU2Vzc2lvbklucHV0ID0gei5vYmplY3Qoe1xuICBpZGVudGlmaWVyOiB6LnN0cmluZygpLFxufSk7XG5cbmNvbnN0IEdldFNlc3Npb25EZXRhaWxJbnB1dCA9IHoub2JqZWN0KHtcbiAgc2Vzc2lvbklkOiB6LnN0cmluZygpLFxufSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQ29udmVyc2F0aW9uIEhpc3RvcnkgQ2FwXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuY29uc3QgTUFYX0hJU1RPUlkgPSAzMDtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBPcmNoZXN0cmF0b3Jcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgY2xhc3MgT3JjaGVzdHJhdG9yIHtcbiAgcHJpdmF0ZSByZWFkb25seSBkZXBzOiBPcmNoZXN0cmF0b3JEZXBzO1xuICBwcml2YXRlIGNsaWVudDogQW50aHJvcGljIHwgbnVsbDtcbiAgcHJpdmF0ZSBoaXN0b3J5OiBNZXNzYWdlUGFyYW1bXSA9IFtdO1xuXG4gIC8qKlxuICAgKiBAcGFyYW0gZGVwcyAtIG9yY2hlc3RyYXRvciBkZXBlbmRlbmNpZXMgKHNlc3Npb24gbWFuYWdlciwgY2hhbm5lbCBtYW5hZ2VyLCBldGMuKVxuICAgKiBAcGFyYW0gY2xpZW50IC0gb3B0aW9uYWwgQW50aHJvcGljIGNsaWVudCBmb3IgdGVzdGFiaWxpdHk7IGlmIG9taXR0ZWQsIGNyZWF0ZWQgZnJvbSBlbnZcbiAgICovXG4gIGNvbnN0cnVjdG9yKGRlcHM6IE9yY2hlc3RyYXRvckRlcHMsIGNsaWVudD86IEFudGhyb3BpYykge1xuICAgIHRoaXMuZGVwcyA9IGRlcHM7XG4gICAgdGhpcy5jbGllbnQgPSBjbGllbnQgPz8gbnVsbDtcbiAgfVxuXG4gIC8qKlxuICAgKiBMYXppbHkgaW5pdGlhbGlzZSB0aGUgQW50aHJvcGljIGNsaWVudC4gRHluYW1pYyBpbXBvcnQgaGFuZGxlcyBLMDA3IG1vZHVsZSByZXNvbHV0aW9uLlxuICAgKiBSZXF1aXJlcyBBTlRIUk9QSUNfQVBJX0tFWSBlbnZpcm9ubWVudCB2YXJpYWJsZS5cbiAgICovXG4gIHByaXZhdGUgYXN5bmMgZ2V0Q2xpZW50KCk6IFByb21pc2U8QW50aHJvcGljPiB7XG4gICAgaWYgKHRoaXMuY2xpZW50KSByZXR1cm4gdGhpcy5jbGllbnQ7XG4gICAgY29uc3QgYXBpS2V5ID0gcmVzb2x2ZUFudGhyb3BpY0FwaUtleSgpO1xuICAgIGNvbnN0IHsgZGVmYXVsdDogQW50aHJvcGljU0RLIH0gPSBhd2FpdCBpbXBvcnQoJ0BhbnRocm9waWMtYWkvc2RrJyk7XG4gICAgdGhpcy5jbGllbnQgPSBuZXcgQW50aHJvcGljU0RLKHsgYXBpS2V5IH0pO1xuICAgIHJldHVybiB0aGlzLmNsaWVudDtcbiAgfVxuXG4gIC8qKlxuICAgKiBIYW5kbGUgYW4gaW5jb21pbmcgRGlzY29yZCBtZXNzYWdlLiBFbnRyeSBwb2ludCBjYWxsZWQgYnkgdGhlIGJvdCdzXG4gICAqIG1lc3NhZ2UgaGFuZGxlciBmb3IgZXZlcnkgbWVzc2FnZSBpbiBldmVyeSBjaGFubmVsLlxuICAgKlxuICAgKiBHdWFyZHM6IGlnbm9yZXMgYm90IG1lc3NhZ2VzLCBub24tb3duZXIgbWVzc2FnZXMsIGFuZCBub24tY29udHJvbC1jaGFubmVsIG1lc3NhZ2VzLlxuICAgKi9cbiAgYXN5bmMgaGFuZGxlTWVzc2FnZShtZXNzYWdlOiBEaXNjb3JkTWVzc2FnZUxpa2UpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAvLyBJZ25vcmUgYm90IG1lc3NhZ2VzXG4gICAgaWYgKG1lc3NhZ2UuYXV0aG9yLmJvdCkgcmV0dXJuO1xuXG4gICAgLy8gSWdub3JlIG5vbi1jb250cm9sLWNoYW5uZWwgbWVzc2FnZXNcbiAgICBpZiAobWVzc2FnZS5jaGFubmVsSWQgIT09IHRoaXMuZGVwcy5jb25maWcuY29udHJvbF9jaGFubmVsX2lkKSByZXR1cm47XG5cbiAgICAvLyBBdXRoIGd1YXJkIFx1MjAxNCBvbmx5IHRoZSBvd25lciBjYW4gdXNlIHRoZSBvcmNoZXN0cmF0b3JcbiAgICBpZiAobWVzc2FnZS5hdXRob3IuaWQgIT09IHRoaXMuZGVwcy5vd25lcklkKSB7XG4gICAgICB0aGlzLmRlcHMubG9nZ2VyLmRlYnVnKCdvcmNoZXN0cmF0b3IgYXV0aCByZWplY3RlZCcsIHsgdXNlcklkOiBtZXNzYWdlLmF1dGhvci5pZCB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBjb250ZW50ID0gbWVzc2FnZS5jb250ZW50Py50cmltKCk7XG4gICAgaWYgKCFjb250ZW50KSByZXR1cm47XG5cbiAgICB0aGlzLmRlcHMubG9nZ2VyLmluZm8oJ29yY2hlc3RyYXRvciBtZXNzYWdlIHJlY2VpdmVkJywge1xuICAgICAgdXNlcklkOiBtZXNzYWdlLmF1dGhvci5pZCxcbiAgICAgIGNoYW5uZWxJZDogbWVzc2FnZS5jaGFubmVsSWQsXG4gICAgICBjb250ZW50TGVuZ3RoOiBjb250ZW50Lmxlbmd0aCxcbiAgICB9KTtcblxuICAgIC8vIEFwcGVuZCB1c2VyIG1lc3NhZ2UgdG8gaGlzdG9yeVxuICAgIHRoaXMuaGlzdG9yeS5wdXNoKHsgcm9sZTogJ3VzZXInLCBjb250ZW50IH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgIC8vIFNob3cgdHlwaW5nIGluZGljYXRvciB3aGlsZSBwcm9jZXNzaW5nXG4gICAgICBhd2FpdCBtZXNzYWdlLmNoYW5uZWwuc2VuZFR5cGluZygpLmNhdGNoKCgpID0+IHt9KTtcblxuICAgICAgY29uc3QgcmVzcG9uc2VUZXh0ID0gYXdhaXQgdGhpcy5ydW5BZ2VudExvb3AoKTtcblxuICAgICAgLy8gU2VuZCByZXNwb25zZSB0byBEaXNjb3JkXG4gICAgICBhd2FpdCBtZXNzYWdlLmNoYW5uZWwuc2VuZChyZXNwb25zZVRleHQpO1xuXG4gICAgICB0aGlzLmRlcHMubG9nZ2VyLmluZm8oJ29yY2hlc3RyYXRvciByZXNwb25zZSBzZW50Jywge1xuICAgICAgICBjaGFubmVsSWQ6IG1lc3NhZ2UuY2hhbm5lbElkLFxuICAgICAgICByZXNwb25zZUxlbmd0aDogcmVzcG9uc2VUZXh0Lmxlbmd0aCxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgZXJyb3JNc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG5cbiAgICAgIC8vIEludmFsaWRhdGUgY2FjaGVkIGNsaWVudCBvbiBhdXRoIGVycm9ycyBzbyBuZXh0IGNhbGwgcmUtcmVzb2x2ZXMgT0F1dGggdG9rZW5cbiAgICAgIGlmIChlcnJvck1zZy5pbmNsdWRlcygnYXV0aGVudGljYXRpb24nKSB8fCBlcnJvck1zZy5pbmNsdWRlcygnYXBpS2V5JykgfHwgZXJyb3JNc2cuaW5jbHVkZXMoJ2F1dGhUb2tlbicpIHx8IGVycm9yTXNnLmluY2x1ZGVzKCc0MDEnKSkge1xuICAgICAgICB0aGlzLmNsaWVudCA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIHRoaXMuZGVwcy5sb2dnZXIuZXJyb3IoJ29yY2hlc3RyYXRvciBlcnJvcicsIHtcbiAgICAgICAgZXJyb3I6IGVycm9yTXNnLFxuICAgICAgICB1c2VySWQ6IG1lc3NhZ2UuYXV0aG9yLmlkLFxuICAgICAgICBjaGFubmVsSWQ6IG1lc3NhZ2UuY2hhbm5lbElkLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIFNlbmQgZXJyb3IgZmVlZGJhY2sgdG8gRGlzY29yZFxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgbWVzc2FnZS5jaGFubmVsLnNlbmQoJ1x1MjZBMFx1RkUwRiBTb21ldGhpbmcgd2VudCB3cm9uZyBwcm9jZXNzaW5nIHlvdXIgcmVxdWVzdC4nKTtcbiAgICAgIH0gY2F0Y2ggKHNlbmRFcnIpIHtcbiAgICAgICAgdGhpcy5kZXBzLmxvZ2dlci53YXJuKCdvcmNoZXN0cmF0b3IgZXJyb3IgcmVwbHkgZmFpbGVkJywge1xuICAgICAgICAgIGVycm9yOiBzZW5kRXJyIGluc3RhbmNlb2YgRXJyb3IgPyBzZW5kRXJyLm1lc3NhZ2UgOiBTdHJpbmcoc2VuZEVyciksXG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICAvLyBTdGlsbCBhcHBlbmQgYSBzeW50aGV0aWMgYXNzaXN0YW50IG1lc3NhZ2Ugc28gaGlzdG9yeSBzdGF5cyBwYWlyZWRcbiAgICAgIHRoaXMuaGlzdG9yeS5wdXNoKHsgcm9sZTogJ2Fzc2lzdGFudCcsIGNvbnRlbnQ6ICdbZXJyb3IgXHUyMDE0IHNlZSBsb2dzXScgfSk7XG4gICAgfVxuXG4gICAgdGhpcy50cmltSGlzdG9yeSgpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJ1biB0aGUgdG9vbC11c2UgbG9vcDogY2FsbCBtZXNzYWdlcy5jcmVhdGUoKSwgZXhlY3V0ZSBhbnkgdG9vbCBjYWxscyxcbiAgICogZmVlZCByZXN1bHRzIGJhY2ssIHJlcGVhdCB1bnRpbCB0aGUgbW9kZWwgcHJvZHVjZXMgYSBmaW5hbCB0ZXh0IHJlc3BvbnNlLlxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyBydW5BZ2VudExvb3AoKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBjb25zdCBjbGllbnQgPSBhd2FpdCB0aGlzLmdldENsaWVudCgpO1xuICAgIGNvbnN0IHsgbW9kZWwsIG1heF90b2tlbnMgfSA9IHRoaXMuZGVwcy5jb25maWc7XG5cbiAgICBsZXQgbG9vcE1lc3NhZ2VzOiBNZXNzYWdlUGFyYW1bXSA9IFsuLi50aGlzLmhpc3RvcnldO1xuICAgIGNvbnN0IG1heEl0ZXJhdGlvbnMgPSAxMDsgLy8gc2FmZXR5IHZhbHZlXG5cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IG1heEl0ZXJhdGlvbnM7IGkrKykge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBjbGllbnQubWVzc2FnZXMuY3JlYXRlKHtcbiAgICAgICAgbW9kZWwsXG4gICAgICAgIG1heF90b2tlbnMsXG4gICAgICAgIHN5c3RlbTogU1lTVEVNX1BST01QVCxcbiAgICAgICAgdG9vbHM6IFRPT0xTLFxuICAgICAgICBtZXNzYWdlczogbG9vcE1lc3NhZ2VzLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIElmIHRoZSBtb2RlbCBzdG9wcGVkIGZvciBlbmRfdHVybiAobm8gdG9vbCBjYWxscyksIGV4dHJhY3QgdGV4dCBhbmQgcmV0dXJuXG4gICAgICBpZiAocmVzcG9uc2Uuc3RvcF9yZWFzb24gPT09ICdlbmRfdHVybicgfHwgcmVzcG9uc2Uuc3RvcF9yZWFzb24gIT09ICd0b29sX3VzZScpIHtcbiAgICAgICAgY29uc3QgdGV4dEJsb2NrcyA9IHJlc3BvbnNlLmNvbnRlbnQuZmlsdGVyKFxuICAgICAgICAgIChiKTogYiBpcyBUZXh0QmxvY2sgPT4gYi50eXBlID09PSAndGV4dCcsXG4gICAgICAgICk7XG4gICAgICAgIGNvbnN0IGZpbmFsVGV4dCA9IHRleHRCbG9ja3MubWFwKChiKSA9PiBiLnRleHQpLmpvaW4oJ1xcbicpIHx8ICcoTm8gcmVzcG9uc2UpJztcblxuICAgICAgICAvLyBBcHBlbmQgYXNzaXN0YW50IG1lc3NhZ2UgdG8gY29udmVyc2F0aW9uIGhpc3RvcnlcbiAgICAgICAgdGhpcy5oaXN0b3J5LnB1c2goeyByb2xlOiAnYXNzaXN0YW50JywgY29udGVudDogZmluYWxUZXh0IH0pO1xuXG4gICAgICAgIHJldHVybiBmaW5hbFRleHQ7XG4gICAgICB9XG5cbiAgICAgIC8vIE1vZGVsIHdhbnRzIHRvIHVzZSB0b29scyBcdTIwMTQgZXhlY3V0ZSB0aGVtIGFsbFxuICAgICAgY29uc3QgdG9vbFVzZUJsb2NrcyA9IHJlc3BvbnNlLmNvbnRlbnQuZmlsdGVyKFxuICAgICAgICAoYik6IGIgaXMgVG9vbFVzZUJsb2NrID0+IGIudHlwZSA9PT0gJ3Rvb2xfdXNlJyxcbiAgICAgICk7XG5cbiAgICAgIC8vIEJ1aWxkIHRvb2wgcmVzdWx0c1xuICAgICAgY29uc3QgdG9vbFJlc3VsdHM6IFRvb2xSZXN1bHRCbG9ja1BhcmFtW10gPSBbXTtcbiAgICAgIGZvciAoY29uc3QgdG9vbFVzZSBvZiB0b29sVXNlQmxvY2tzKSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZVRvb2wodG9vbFVzZS5uYW1lLCB0b29sVXNlLmlucHV0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgICAgICAgdG9vbFJlc3VsdHMucHVzaCh7XG4gICAgICAgICAgdHlwZTogJ3Rvb2xfcmVzdWx0JyxcbiAgICAgICAgICB0b29sX3VzZV9pZDogdG9vbFVzZS5pZCxcbiAgICAgICAgICBjb250ZW50OiByZXN1bHQsXG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICAvLyBBcHBlbmQgdGhlIGFzc2lzdGFudCBtZXNzYWdlICh3aXRoIHRvb2xfdXNlIGJsb2NrcykgYW5kIHVzZXIgdG9vbF9yZXN1bHQgbWVzc2FnZVxuICAgICAgbG9vcE1lc3NhZ2VzID0gW1xuICAgICAgICAuLi5sb29wTWVzc2FnZXMsXG4gICAgICAgIHsgcm9sZTogJ2Fzc2lzdGFudCcsIGNvbnRlbnQ6IHJlc3BvbnNlLmNvbnRlbnQgYXMgQ29udGVudEJsb2NrUGFyYW1bXSB9LFxuICAgICAgICB7IHJvbGU6ICd1c2VyJywgY29udGVudDogdG9vbFJlc3VsdHMgfSxcbiAgICAgIF07XG4gICAgfVxuXG4gICAgLy8gSWYgd2UgaGl0IG1heCBpdGVyYXRpb25zLCByZXR1cm4gYSBmYWxsYmFja1xuICAgIHJldHVybiAnSSBoaXQgdGhlIG1heGltdW0gbnVtYmVyIG9mIHRvb2wgaXRlcmF0aW9ucy4gUGxlYXNlIHRyeSBhIHNpbXBsZXIgcmVxdWVzdC4nO1xuICB9XG5cbiAgLyoqXG4gICAqIEV4ZWN1dGUgYSBzaW5nbGUgdG9vbCBieSBuYW1lLiBSZXR1cm5zIGEgc3RyaW5nIHJlc3VsdCBmb3IgdGhlIExMTS5cbiAgICogQWxsIGVycm9ycyBhcmUgY2F1Z2h0IGFuZCByZXR1cm5lZCBhcyBlcnJvciBzdHJpbmdzICh0aGUgTExNIGNhbiByZWFzb24gYWJvdXQgdGhlbSkuXG4gICAqL1xuICBwcml2YXRlIGFzeW5jIGV4ZWN1dGVUb29sKG5hbWU6IHN0cmluZywgaW5wdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICB0cnkge1xuICAgICAgc3dpdGNoIChuYW1lKSB7XG4gICAgICAgIGNhc2UgJ2xpc3RfcHJvamVjdHMnOlxuICAgICAgICAgIHJldHVybiBhd2FpdCB0aGlzLnRvb2xMaXN0UHJvamVjdHMoKTtcbiAgICAgICAgY2FzZSAnc3RhcnRfc2Vzc2lvbic6XG4gICAgICAgICAgcmV0dXJuIGF3YWl0IHRoaXMudG9vbFN0YXJ0U2Vzc2lvbihpbnB1dCk7XG4gICAgICAgIGNhc2UgJ2dldF9zdGF0dXMnOlxuICAgICAgICAgIHJldHVybiB0aGlzLnRvb2xHZXRTdGF0dXMoKTtcbiAgICAgICAgY2FzZSAnZ2V0X3Nlc3Npb25fZGV0YWlsJzpcbiAgICAgICAgICByZXR1cm4gdGhpcy50b29sR2V0U2Vzc2lvbkRldGFpbChpbnB1dCk7XG4gICAgICAgIGNhc2UgJ3N0b3Bfc2Vzc2lvbic6XG4gICAgICAgICAgcmV0dXJuIGF3YWl0IHRoaXMudG9vbFN0b3BTZXNzaW9uKGlucHV0KTtcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICByZXR1cm4gYFVua25vd24gdG9vbDogJHtuYW1lfWA7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICB0aGlzLmRlcHMubG9nZ2VyLmVycm9yKCd0b29sIGV4ZWN1dGlvbiBlcnJvcicsIHsgdG9vbDogbmFtZSwgZXJyb3I6IG1zZyB9KTtcbiAgICAgIHJldHVybiBgRXJyb3I6ICR7bXNnfWA7XG4gICAgfVxuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIFRvb2wgaW1wbGVtZW50YXRpb25zXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gIHByaXZhdGUgYXN5bmMgdG9vbExpc3RQcm9qZWN0cygpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGNvbnN0IHByb2plY3RzID0gYXdhaXQgdGhpcy5kZXBzLnNjYW5Qcm9qZWN0cygpO1xuICAgIGlmIChwcm9qZWN0cy5sZW5ndGggPT09IDApIHJldHVybiAnTm8gcHJvamVjdHMgZm91bmQuJztcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoXG4gICAgICBwcm9qZWN0cy5tYXAoKHApID0+ICh7IG5hbWU6IHAubmFtZSwgcGF0aDogcC5wYXRoLCBtYXJrZXJzOiBwLm1hcmtlcnMgfSkpLFxuICAgICAgbnVsbCxcbiAgICAgIDIsXG4gICAgKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgdG9vbFN0YXJ0U2Vzc2lvbihpbnB1dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGNvbnN0IHBhcnNlZCA9IFN0YXJ0U2Vzc2lvbklucHV0LnBhcnNlKGlucHV0KTtcbiAgICBjb25zdCBzZXNzaW9uSWQgPSBhd2FpdCB0aGlzLmRlcHMuc2Vzc2lvbk1hbmFnZXIuc3RhcnRTZXNzaW9uKHtcbiAgICAgIHByb2plY3REaXI6IHBhcnNlZC5wcm9qZWN0UGF0aCxcbiAgICAgIGNvbW1hbmQ6IHBhcnNlZC5jb21tYW5kLFxuICAgIH0pO1xuICAgIHJldHVybiBgU2Vzc2lvbiBzdGFydGVkOiAke3Nlc3Npb25JZH0gZm9yICR7cGFyc2VkLnByb2plY3RQYXRofWA7XG4gIH1cblxuICBwcml2YXRlIHRvb2xHZXRTdGF0dXMoKTogc3RyaW5nIHtcbiAgICBjb25zdCBzZXNzaW9ucyA9IHRoaXMuZGVwcy5zZXNzaW9uTWFuYWdlci5nZXRBbGxTZXNzaW9ucygpO1xuICAgIGlmIChzZXNzaW9ucy5sZW5ndGggPT09IDApIHJldHVybiAnTm8gYWN0aXZlIHNlc3Npb25zLic7XG5cbiAgICByZXR1cm4gc2Vzc2lvbnNcbiAgICAgIC5tYXAoKHM6IE1hbmFnZWRTZXNzaW9uKSA9PiB7XG4gICAgICAgIGNvbnN0IGR1cmF0aW9uTWluID0gTWF0aC5mbG9vcigoRGF0ZS5ub3coKSAtIHMuc3RhcnRUaW1lKSAvIDYwXzAwMCk7XG4gICAgICAgIGNvbnN0IGNvc3QgPSBzLmNvc3QudG90YWxDb3N0LnRvRml4ZWQoNCk7XG4gICAgICAgIHJldHVybiBgXHUyMDIyICR7cy5wcm9qZWN0TmFtZX0gXHUyMDE0ICR7cy5zdGF0dXN9ICgke2R1cmF0aW9uTWlufW0sICQke2Nvc3R9KWA7XG4gICAgICB9KVxuICAgICAgLmpvaW4oJ1xcbicpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyB0b29sU3RvcFNlc3Npb24oaW5wdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBjb25zdCBwYXJzZWQgPSBTdG9wU2Vzc2lvbklucHV0LnBhcnNlKGlucHV0KTtcbiAgICBjb25zdCB7IGlkZW50aWZpZXIgfSA9IHBhcnNlZDtcblxuICAgIC8vIFRyeSBleGFjdCBzZXNzaW9uSWQgbWF0Y2ggZmlyc3RcbiAgICBjb25zdCBieUlkID0gdGhpcy5kZXBzLnNlc3Npb25NYW5hZ2VyLmdldFNlc3Npb24oaWRlbnRpZmllcik7XG4gICAgaWYgKGJ5SWQpIHtcbiAgICAgIGF3YWl0IHRoaXMuZGVwcy5zZXNzaW9uTWFuYWdlci5jYW5jZWxTZXNzaW9uKGlkZW50aWZpZXIpO1xuICAgICAgcmV0dXJuIGBTdG9wcGVkIHNlc3Npb24gJHtpZGVudGlmaWVyfSAoJHtieUlkLnByb2plY3ROYW1lfSlgO1xuICAgIH1cblxuICAgIC8vIEZ1enp5IG1hdGNoIGJ5IHByb2plY3QgbmFtZVxuICAgIGNvbnN0IGFsbCA9IHRoaXMuZGVwcy5zZXNzaW9uTWFuYWdlci5nZXRBbGxTZXNzaW9ucygpO1xuICAgIGNvbnN0IG1hdGNoID0gYWxsLmZpbmQoXG4gICAgICAoczogTWFuYWdlZFNlc3Npb24pID0+XG4gICAgICAgIHMucHJvamVjdE5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhpZGVudGlmaWVyLnRvTG93ZXJDYXNlKCkpIHx8XG4gICAgICAgIHMucHJvamVjdERpci50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGlkZW50aWZpZXIudG9Mb3dlckNhc2UoKSksXG4gICAgKTtcbiAgICBpZiAobWF0Y2gpIHtcbiAgICAgIGF3YWl0IHRoaXMuZGVwcy5zZXNzaW9uTWFuYWdlci5jYW5jZWxTZXNzaW9uKG1hdGNoLnNlc3Npb25JZCk7XG4gICAgICByZXR1cm4gYFN0b3BwZWQgc2Vzc2lvbiAke21hdGNoLnNlc3Npb25JZH0gKCR7bWF0Y2gucHJvamVjdE5hbWV9KWA7XG4gICAgfVxuXG4gICAgcmV0dXJuIGBObyBzZXNzaW9uIGZvdW5kIG1hdGNoaW5nIFwiJHtpZGVudGlmaWVyfVwiYDtcbiAgfVxuXG4gIHByaXZhdGUgdG9vbEdldFNlc3Npb25EZXRhaWwoaW5wdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHtcbiAgICBjb25zdCBwYXJzZWQgPSBHZXRTZXNzaW9uRGV0YWlsSW5wdXQucGFyc2UoaW5wdXQpO1xuICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuZGVwcy5zZXNzaW9uTWFuYWdlci5nZXRSZXN1bHQocGFyc2VkLnNlc3Npb25JZCk7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHJlc3VsdCwgbnVsbCwgMik7XG4gIH1cblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gSGlzdG9yeSBtYW5hZ2VtZW50XG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gIC8qKlxuICAgKiBUcmltIGNvbnZlcnNhdGlvbiBoaXN0b3J5IHRvIE1BWF9ISVNUT1JZIGVudHJpZXMuXG4gICAqIFJlbW92ZXMgdGhlIG9sZGVzdCB1c2VyK2Fzc2lzdGFudCBwYWlyIGZyb20gdGhlIGZyb250IHRvIGtlZXAgcGFpcnMgYWxpZ25lZC5cbiAgICovXG4gIHByaXZhdGUgdHJpbUhpc3RvcnkoKTogdm9pZCB7XG4gICAgd2hpbGUgKHRoaXMuaGlzdG9yeS5sZW5ndGggPiBNQVhfSElTVE9SWSkge1xuICAgICAgLy8gUmVtb3ZlIGZyb20gZnJvbnQgXHUyMDE0IHR3byBtZXNzYWdlcyBhdCBhIHRpbWUgdG8ga2VlcCB1c2VyL2Fzc2lzdGFudCBwYWlyc1xuICAgICAgdGhpcy5oaXN0b3J5LnNwbGljZSgwLCAyKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJuIGEgY29weSBvZiB0aGUgY29udmVyc2F0aW9uIGhpc3RvcnkgKGZvciBkZWJ1Z2dpbmcgLyBvYnNlcnZhYmlsaXR5KS5cbiAgICovXG4gIGdldEhpc3RvcnkoKTogTWVzc2FnZVBhcmFtW10ge1xuICAgIHJldHVybiBbLi4udGhpcy5oaXN0b3J5XTtcbiAgfVxuXG4gIC8qKlxuICAgKiBTdG9wIHRoZSBvcmNoZXN0cmF0b3IgXHUyMDE0IGNsZWFycyBoaXN0b3J5IGFuZCBudWxscyBjbGllbnQgcmVmZXJlbmNlLlxuICAgKi9cbiAgc3RvcCgpOiB2b2lkIHtcbiAgICB0aGlzLmhpc3RvcnkgPSBbXTtcbiAgICB0aGlzLmNsaWVudCA9IG51bGw7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBEaXNjb3JkIG1lc3NhZ2UgdHlwZSAobWluaW1hbCBpbnRlcmZhY2UgZm9yIHRlc3RhYmlsaXR5KVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogTWluaW1hbCBEaXNjb3JkIG1lc3NhZ2UgaW50ZXJmYWNlIFx1MjAxNCBhdm9pZHMgaW1wb3J0aW5nIGRpc2NvcmQuanMgZGlyZWN0bHksXG4gKiBtYWtpbmcgdGhlIG9yY2hlc3RyYXRvciB0ZXN0YWJsZSB3aXRob3V0IGZ1bGwgZGlzY29yZC5qcyBtb2NraW5nLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIERpc2NvcmRNZXNzYWdlTGlrZSB7XG4gIGF1dGhvcjogeyBpZDogc3RyaW5nOyBib3Q6IGJvb2xlYW4gfTtcbiAgY2hhbm5lbElkOiBzdHJpbmc7XG4gIGNvbnRlbnQ6IHN0cmluZztcbiAgY2hhbm5lbDoge1xuICAgIHNlbmQ6IChjb250ZW50OiBzdHJpbmcpID0+IFByb21pc2U8dW5rbm93bj47XG4gICAgc2VuZFR5cGluZzogKCkgPT4gUHJvbWlzZTx1bmtu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
