import { EmbedBuilder, ComponentType } from "discord.js";
import { MessageBatcher } from "./message-batcher.js";
import { VerbosityManager } from "./verbosity.js";
import {
  formatEvent,
  formatBlocker,
  formatSessionStarted,
  formatError,
  formatCompletion
} from "./event-formatter.js";
import { isAuthorized } from "./discord-bot.js";
const BLOCKER_COLLECTOR_TIMEOUT_MS = 24 * 60 * 60 * 1e3;
class EventBridge {
  sessionManager;
  channelManager;
  client;
  config;
  logger;
  ownerId;
  /** sessionId → channelId */
  sessionToChannel = /* @__PURE__ */ new Map();
  /** channelId → sessionId */
  channelToSession = /* @__PURE__ */ new Map();
  /** sessionId → MessageBatcher */
  batchers = /* @__PURE__ */ new Map();
  /** sessionId → TextChannel (cached for send operations) */
  channels = /* @__PURE__ */ new Map();
  verbosity = new VerbosityManager();
  /** Bound event handlers for cleanup */
  boundHandlers = null;
  constructor(opts) {
    this.sessionManager = opts.sessionManager;
    this.channelManager = opts.channelManager;
    this.client = opts.client;
    this.config = opts.config;
    this.logger = opts.logger;
    this.ownerId = opts.ownerId;
  }
  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------
  /** Subscribe to SessionManager events and Discord messageCreate. */
  start() {
    if (this.boundHandlers) return;
    this.boundHandlers = {
      started: (data) => {
        void this.onSessionStarted(data);
      },
      event: (data) => {
        void this.onSessionEvent(data);
      },
      blocked: (data) => {
        void this.onSessionBlocked(data);
      },
      completed: (data) => {
        void this.onSessionCompleted(data);
      },
      error: (data) => {
        void this.onSessionError(data);
      },
      messageCreate: (msg) => {
        void this.handleMessageCreate(msg);
      }
    };
    this.sessionManager.on("session:started", this.boundHandlers.started);
    this.sessionManager.on("session:event", this.boundHandlers.event);
    this.sessionManager.on("session:blocked", this.boundHandlers.blocked);
    this.sessionManager.on("session:completed", this.boundHandlers.completed);
    this.sessionManager.on("session:error", this.boundHandlers.error);
    this.client.on("messageCreate", this.boundHandlers.messageCreate);
    this.logger.info("event bridge started");
  }
  /** Unsubscribe from all events, destroy batchers, clear mappings. */
  async stop() {
    if (this.boundHandlers) {
      this.sessionManager.off("session:started", this.boundHandlers.started);
      this.sessionManager.off("session:event", this.boundHandlers.event);
      this.sessionManager.off("session:blocked", this.boundHandlers.blocked);
      this.sessionManager.off("session:completed", this.boundHandlers.completed);
      this.sessionManager.off("session:error", this.boundHandlers.error);
      this.client.off("messageCreate", this.boundHandlers.messageCreate);
      this.boundHandlers = null;
    }
    const destroyPromises = [];
    for (const batcher of this.batchers.values()) {
      destroyPromises.push(batcher.destroy());
    }
    await Promise.allSettled(destroyPromises);
    this.batchers.clear();
    this.sessionToChannel.clear();
    this.channelToSession.clear();
    this.channels.clear();
    this.logger.info("event bridge stopped");
  }
  /** Expose the verbosity manager for slash-command integration. */
  getVerbosityManager() {
    return this.verbosity;
  }
  // -----------------------------------------------------------------------
  // SessionManager event handlers
  // -----------------------------------------------------------------------
  async onSessionStarted(data) {
    const { sessionId, projectDir, projectName } = data;
    try {
      const channel = await this.channelManager.createProjectChannel(projectDir);
      const batcher = new MessageBatcher(
        async (payload) => {
          await channel.send(payload);
        },
        this.logger
      );
      batcher.start();
      this.sessionToChannel.set(sessionId, channel.id);
      this.channelToSession.set(channel.id, sessionId);
      this.batchers.set(sessionId, batcher);
      this.channels.set(sessionId, channel);
      const welcome = formatSessionStarted(projectName);
      batcher.enqueue(welcome);
      this.logger.info("bridge: session channel created", {
        sessionId,
        channelId: channel.id,
        projectName
      });
    } catch (err) {
      this.logger.error("bridge: channel creation failed", {
        sessionId,
        projectDir,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  async onSessionEvent(data) {
    const { sessionId, event } = data;
    const channelId = this.sessionToChannel.get(sessionId);
    if (!channelId) return;
    const eventType = event.type;
    if (!this.verbosity.shouldShow(channelId, eventType)) return;
    const formatted = formatEvent(event, this.ownerId);
    const batcher = this.batchers.get(sessionId);
    if (batcher) {
      batcher.enqueue(formatted);
    }
  }
  async onSessionBlocked(data) {
    const { sessionId, projectName, blocker } = data;
    const channel = this.channels.get(sessionId);
    if (!channel) return;
    const formatted = formatBlocker(blocker, this.ownerId);
    const batcher = this.batchers.get(sessionId);
    if (batcher) {
      await batcher.enqueueImmediate(formatted);
    }
    if (blocker.method === "select" || blocker.method === "confirm") {
      this.createButtonCollector(sessionId, channel, blocker);
    }
    if (this.config.discord?.dm_on_blocker) {
      await this.sendBlockerDM(sessionId, projectName, blocker);
    }
  }
  async onSessionCompleted(data) {
    const { sessionId, projectName } = data;
    const batcher = this.batchers.get(sessionId);
    if (!batcher) return;
    const completion = formatCompletion({
      type: "execution_complete",
      status: "completed"
    });
    batcher.enqueue(completion);
    await this.cleanupSession(sessionId);
    this.logger.info("bridge: session completed", { sessionId, projectName });
  }
  async onSessionError(data) {
    const { sessionId, projectName, error } = data;
    const batcher = this.batchers.get(sessionId);
    if (!batcher) return;
    const errorEmbed = formatError(sessionId, error);
    batcher.enqueue(errorEmbed);
    await this.cleanupSession(sessionId);
    this.logger.info("bridge: session error", { sessionId, projectName, error });
  }
  // -----------------------------------------------------------------------
  // Blocker resolution — button collector
  // -----------------------------------------------------------------------
  createButtonCollector(sessionId, channel, blocker) {
    try {
      const collector = channel.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: BLOCKER_COLLECTOR_TIMEOUT_MS,
        filter: (interaction) => {
          return interaction.customId.startsWith(`blocker:${blocker.id}:`);
        }
      });
      collector.on("collect", async (interaction) => {
        if (!isAuthorized(interaction.user.id, this.ownerId)) {
          await interaction.reply({
            content: "\u26D4 Only the project owner can respond to blockers.",
            ephemeral: true
          }).catch(() => {
          });
          return;
        }
        const parts = interaction.customId.split(":");
        const value = parts[3] ?? "";
        try {
          await this.sessionManager.resolveBlocker(sessionId, value);
          await interaction.update({
            content: `\u2705 Blocker resolved with: ${value}`,
            components: []
          }).catch(() => {
          });
          collector.stop("resolved");
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.logger.error("bridge: blocker resolve failed", { sessionId, error: errMsg });
          await interaction.reply({
            content: `\u274C Failed to resolve blocker: ${errMsg}`,
            ephemeral: true
          }).catch(() => {
          });
        }
      });
      collector.on("end", (_collected, reason) => {
        if (reason === "time") {
          this.logger.info("bridge: blocker collector timed out", { sessionId, blockerId: blocker.id });
          const batcher = this.batchers.get(sessionId);
          if (batcher) {
            batcher.enqueue({
              content: `\u23F0 Blocker response timed out after 24h. Re-posting...`,
              embed: new EmbedBuilder().setColor(15844367).setTitle("\u23F0 Blocker Expired").setDescription(blocker.message).setTimestamp()
            });
          }
        }
      });
    } catch (err) {
      this.logger.error("bridge: collector creation failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  // -----------------------------------------------------------------------
  // DM backup
  // -----------------------------------------------------------------------
  async sendBlockerDM(sessionId, projectName, blocker) {
    try {
      const user = await this.client.users.fetch(this.ownerId);
      await user.send({
        content: `\u26A0\uFE0F **Blocker** in **${projectName}** \u2014 ${blocker.message}

Respond in the project channel.`
      });
      this.logger.debug("bridge: DM sent for blocker", { sessionId, blockerId: blocker.id });
    } catch (err) {
      this.logger.warn("bridge: DM send failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  // -----------------------------------------------------------------------
  // Conversation relay — Discord → GSD
  // -----------------------------------------------------------------------
  async handleMessageCreate(message) {
    if (message.author.bot) return;
    const sessionId = this.channelToSession.get(message.channelId);
    if (!sessionId) return;
    if (!isAuthorized(message.author.id, this.ownerId)) return;
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;
    if (session.pendingBlocker && (session.pendingBlocker.method === "input" || session.pendingBlocker.method === "editor")) {
      try {
        await this.sessionManager.resolveBlocker(sessionId, message.content);
        await message.react("\u2705").catch(() => {
        });
        this.logger.info("bridge: blocker resolved via relay", {
          sessionId,
          method: session.pendingBlocker.method
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error("bridge: relay blocker resolve failed", { sessionId, error: errMsg });
        await message.reply(`\u274C Failed to resolve blocker: ${errMsg}`).catch(() => {
        });
      }
      return;
    }
    try {
      if (session.status === "running") {
        await session.client.steer(message.content);
      } else {
        await session.client.prompt(message.content);
      }
      await message.react("\u{1F4E8}").catch(() => {
      });
      this.logger.info("bridge: message relayed to session", {
        sessionId,
        method: session.status === "running" ? "steer" : "prompt"
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error("bridge: relay failed", { sessionId, error: errMsg });
      await message.reply(`\u274C Failed to relay message: ${errMsg}`).catch(() => {
      });
    }
  }
  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------
  async cleanupSession(sessionId) {
    const batcher = this.batchers.get(sessionId);
    if (batcher) {
      await batcher.destroy();
      this.batchers.delete(sessionId);
    }
    const channelId = this.sessionToChannel.get(sessionId);
    if (channelId) {
      this.channelToSession.delete(channelId);
    }
    this.sessionToChannel.delete(sessionId);
    this.channels.delete(sessionId);
  }
}
export {
  EventBridge
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvZGFlbW9uL3NyYy9ldmVudC1icmlkZ2UudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogZXZlbnQtYnJpZGdlLnRzIFx1MjAxNCBPcmNoZXN0cmF0b3Igd2lyaW5nIFNlc3Npb25NYW5hZ2VyIGV2ZW50cyB0aHJvdWdoXG4gKiBmb3JtYXR0ZXIgXHUyMTkyIGJhdGNoZXIgXHUyMTkyIERpc2NvcmQgY2hhbm5lbHMuXG4gKlxuICogSGFuZGxlczpcbiAqICAgLSBTZXNzaW9uIGxpZmVjeWNsZSBcdTIxOTIgRGlzY29yZCBjaGFubmVsIGNyZWF0aW9uIGFuZCBjbGVhbnVwXG4gKiAgIC0gRXZlbnQgc3RyZWFtaW5nIFx1MjE5MiBmb3JtYXQgKyB2ZXJib3NpdHkgZmlsdGVyICsgYmF0Y2hlclxuICogICAtIEJsb2NrZXIgcmVzb2x1dGlvbiBcdTIxOTIgaW50ZXJhY3RpdmUgYnV0dG9ucyArIHRleHQgcmVsYXlcbiAqICAgLSBDb252ZXJzYXRpb24gcmVsYXkgXHUyMTkyIERpc2NvcmQgbWVzc2FnZXMgZm9yd2FyZGVkIHRvIEdTRCBzZXNzaW9uc1xuICogICAtIERNIGJhY2t1cCBcdTIxOTIgb3duZXIgZ2V0cyBETSBvbiBibG9ja2VyIHdoZW4gZG1fb25fYmxvY2tlciBjb25maWd1cmVkXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBDbGllbnQsIE1lc3NhZ2UsIFRleHRDaGFubmVsLCBNZXNzYWdlQ29tcG9uZW50SW50ZXJhY3Rpb24gfSBmcm9tICdkaXNjb3JkLmpzJztcbmltcG9ydCB7IEVtYmVkQnVpbGRlciwgQ29tcG9uZW50VHlwZSB9IGZyb20gJ2Rpc2NvcmQuanMnO1xuaW1wb3J0IHR5cGUgeyBTZGtBZ2VudEV2ZW50IH0gZnJvbSAnQGdzZC1idWlsZC9jb250cmFjdHMnO1xuaW1wb3J0IHR5cGUgeyBMb2dnZXIgfSBmcm9tICcuL2xvZ2dlci5qcyc7XG5pbXBvcnQgdHlwZSB7IERhZW1vbkNvbmZpZywgUGVuZGluZ0Jsb2NrZXIgfSBmcm9tICcuL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgU2Vzc2lvbk1hbmFnZXIgfSBmcm9tICcuL3Nlc3Npb24tbWFuYWdlci5qcyc7XG5pbXBvcnQgdHlwZSB7IENoYW5uZWxNYW5hZ2VyIH0gZnJvbSAnLi9jaGFubmVsLW1hbmFnZXIuanMnO1xuaW1wb3J0IHsgTWVzc2FnZUJhdGNoZXIgfSBmcm9tICcuL21lc3NhZ2UtYmF0Y2hlci5qcyc7XG5pbXBvcnQgeyBWZXJib3NpdHlNYW5hZ2VyIH0gZnJvbSAnLi92ZXJib3NpdHkuanMnO1xuaW1wb3J0IHtcbiAgZm9ybWF0RXZlbnQsXG4gIGZvcm1hdEJsb2NrZXIsXG4gIGZvcm1hdFNlc3Npb25TdGFydGVkLFxuICBmb3JtYXRFcnJvcixcbiAgZm9ybWF0Q29tcGxldGlvbixcbn0gZnJvbSAnLi9ldmVudC1mb3JtYXR0ZXIuanMnO1xuaW1wb3J0IHsgaXNBdXRob3JpemVkIH0gZnJvbSAnLi9kaXNjb3JkLWJvdC5qcyc7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVHlwZXNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogTWluaW1hbCBpbnRlcmZhY2UgZm9yIGEgRGlzY29yZCBjbGllbnQgXHUyMDE0IGV4dHJhY3RlZCBmb3IgdGVzdGFiaWxpdHkuICovXG5leHBvcnQgaW50ZXJmYWNlIEJyaWRnZUNsaWVudCB7XG4gIG9uKGV2ZW50OiAnbWVzc2FnZUNyZWF0ZScsIGxpc3RlbmVyOiAobWVzc2FnZTogTWVzc2FnZSkgPT4gdm9pZCk6IHZvaWQ7XG4gIG9mZihldmVudDogJ21lc3NhZ2VDcmVhdGUnLCBsaXN0ZW5lcjogKG1lc3NhZ2U6IE1lc3NhZ2UpID0+IHZvaWQpOiB2b2lkO1xuICB1c2VyczogeyBmZXRjaChpZDogc3RyaW5nKTogUHJvbWlzZTx7IHNlbmQob3B0czogdW5rbm93bik6IFByb21pc2U8dW5rbm93bj4gfT4gfTtcbn1cblxuLyoqIE9wdGlvbnMgZm9yIGNyZWF0aW5nIGFuIEV2ZW50QnJpZGdlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBFdmVudEJyaWRnZU9wdGlvbnMge1xuICBzZXNzaW9uTWFuYWdlcjogU2Vzc2lvbk1hbmFnZXI7XG4gIGNoYW5uZWxNYW5hZ2VyOiBDaGFubmVsTWFuYWdlcjtcbiAgY2xpZW50OiBCcmlkZ2VDbGllbnQ7XG4gIGNvbmZpZzogRGFlbW9uQ29uZmlnO1xuICBsb2dnZXI6IExvZ2dlcjtcbiAgb3duZXJJZDogc3RyaW5nO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIENvbGxlY3RvciB0aW1lb3V0XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuY29uc3QgQkxPQ0tFUl9DT0xMRUNUT1JfVElNRU9VVF9NUyA9IDI0ICogNjAgKiA2MCAqIDEwMDA7IC8vIDI0IGhvdXJzXG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gRXZlbnRCcmlkZ2Vcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgY2xhc3MgRXZlbnRCcmlkZ2Uge1xuICBwcml2YXRlIHJlYWRvbmx5IHNlc3Npb25NYW5hZ2VyOiBTZXNzaW9uTWFuYWdlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBjaGFubmVsTWFuYWdlcjogQ2hhbm5lbE1hbmFnZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgY2xpZW50OiBCcmlkZ2VDbGllbnQ7XG4gIHByaXZhdGUgcmVhZG9ubHkgY29uZmlnOiBEYWVtb25Db25maWc7XG4gIHByaXZhdGUgcmVhZG9ubHkgbG9nZ2VyOiBMb2dnZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgb3duZXJJZDogc3RyaW5nO1xuXG4gIC8qKiBzZXNzaW9uSWQgXHUyMTkyIGNoYW5uZWxJZCAqL1xuICBwcml2YXRlIHJlYWRvbmx5IHNlc3Npb25Ub0NoYW5uZWwgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAvKiogY2hhbm5lbElkIFx1MjE5MiBzZXNzaW9uSWQgKi9cbiAgcHJpdmF0ZSByZWFkb25seSBjaGFubmVsVG9TZXNzaW9uID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgLyoqIHNlc3Npb25JZCBcdTIxOTIgTWVzc2FnZUJhdGNoZXIgKi9cbiAgcHJpdmF0ZSByZWFkb25seSBiYXRjaGVycyA9IG5ldyBNYXA8c3RyaW5nLCBNZXNzYWdlQmF0Y2hlcj4oKTtcbiAgLyoqIHNlc3Npb25JZCBcdTIxOTIgVGV4dENoYW5uZWwgKGNhY2hlZCBmb3Igc2VuZCBvcGVyYXRpb25zKSAqL1xuICBwcml2YXRlIHJlYWRvbmx5IGNoYW5uZWxzID0gbmV3IE1hcDxzdHJpbmcsIFRleHRDaGFubmVsPigpO1xuXG4gIHByaXZhdGUgcmVhZG9ubHkgdmVyYm9zaXR5ID0gbmV3IFZlcmJvc2l0eU1hbmFnZXIoKTtcblxuICAvKiogQm91bmQgZXZlbnQgaGFuZGxlcnMgZm9yIGNsZWFudXAgKi9cbiAgcHJpdmF0ZSBib3VuZEhhbmRsZXJzOiB7XG4gICAgc3RhcnRlZDogKC4uLmFyZ3M6IHVua25vd25bXSkgPT4gdm9pZDtcbiAgICBldmVudDogKC4uLmFyZ3M6IHVua25vd25bXSkgPT4gdm9pZDtcbiAgICBibG9ja2VkOiAoLi4uYXJnczogdW5rbm93bltdKSA9PiB2b2lkO1xuICAgIGNvbXBsZXRlZDogKC4uLmFyZ3M6IHVua25vd25bXSkgPT4gdm9pZDtcbiAgICBlcnJvcjogKC4uLmFyZ3M6IHVua25vd25bXSkgPT4gdm9pZDtcbiAgICBtZXNzYWdlQ3JlYXRlOiAobXNnOiBNZXNzYWdlKSA9PiB2b2lkO1xuICB9IHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3RydWN0b3Iob3B0czogRXZlbnRCcmlkZ2VPcHRpb25zKSB7XG4gICAgdGhpcy5zZXNzaW9uTWFuYWdlciA9IG9wdHMuc2Vzc2lvbk1hbmFnZXI7XG4gICAgdGhpcy5jaGFubmVsTWFuYWdlciA9IG9wdHMuY2hhbm5lbE1hbmFnZXI7XG4gICAgdGhpcy5jbGllbnQgPSBvcHRzLmNsaWVudDtcbiAgICB0aGlzLmNvbmZpZyA9IG9wdHMuY29uZmlnO1xuICAgIHRoaXMubG9nZ2VyID0gb3B0cy5sb2dnZXI7XG4gICAgdGhpcy5vd25lcklkID0gb3B0cy5vd25lcklkO1xuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gTGlmZWN5Y2xlXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgLyoqIFN1YnNjcmliZSB0byBTZXNzaW9uTWFuYWdlciBldmVudHMgYW5kIERpc2NvcmQgbWVzc2FnZUNyZWF0ZS4gKi9cbiAgc3RhcnQoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuYm91bmRIYW5kbGVycykgcmV0dXJuOyAvLyBhbHJlYWR5IHN0YXJ0ZWRcblxuICAgIHRoaXMuYm91bmRIYW5kbGVycyA9IHtcbiAgICAgIHN0YXJ0ZWQ6IChkYXRhOiB1bmtub3duKSA9PiB7XG4gICAgICAgIHZvaWQgdGhpcy5vblNlc3Npb25TdGFydGVkKGRhdGEgYXMgU2Vzc2lvblN0YXJ0ZWRQYXlsb2FkKTtcbiAgICAgIH0sXG4gICAgICBldmVudDogKGRhdGE6IHVua25vd24pID0+IHtcbiAgICAgICAgdm9pZCB0aGlzLm9uU2Vzc2lvbkV2ZW50KGRhdGEgYXMgU2Vzc2lvbkV2ZW50UGF5bG9hZCk7XG4gICAgICB9LFxuICAgICAgYmxvY2tlZDogKGRhdGE6IHVua25vd24pID0+IHtcbiAgICAgICAgdm9pZCB0aGlzLm9uU2Vzc2lvbkJsb2NrZWQoZGF0YSBhcyBTZXNzaW9uQmxvY2tlZFBheWxvYWQpO1xuICAgICAgfSxcbiAgICAgIGNvbXBsZXRlZDogKGRhdGE6IHVua25vd24pID0+IHtcbiAgICAgICAgdm9pZCB0aGlzLm9uU2Vzc2lvbkNvbXBsZXRlZChkYXRhIGFzIFNlc3Npb25Db21wbGV0ZWRQYXlsb2FkKTtcbiAgICAgIH0sXG4gICAgICBlcnJvcjogKGRhdGE6IHVua25vd24pID0+IHtcbiAgICAgICAgdm9pZCB0aGlzLm9uU2Vzc2lvbkVycm9yKGRhdGEgYXMgU2Vzc2lvbkVycm9yUGF5bG9hZCk7XG4gICAgICB9LFxuICAgICAgbWVzc2FnZUNyZWF0ZTogKG1zZzogTWVzc2FnZSkgPT4ge1xuICAgICAgICB2b2lkIHRoaXMuaGFuZGxlTWVzc2FnZUNyZWF0ZShtc2cpO1xuICAgICAgfSxcbiAgICB9O1xuXG4gICAgdGhpcy5zZXNzaW9uTWFuYWdlci5vbignc2Vzc2lvbjpzdGFydGVkJywgdGhpcy5ib3VuZEhhbmRsZXJzLnN0YXJ0ZWQpO1xuICAgIHRoaXMuc2Vzc2lvbk1hbmFnZXIub24oJ3Nlc3Npb246ZXZlbnQnLCB0aGlzLmJvdW5kSGFuZGxlcnMuZXZlbnQpO1xuICAgIHRoaXMuc2Vzc2lvbk1hbmFnZXIub24oJ3Nlc3Npb246YmxvY2tlZCcsIHRoaXMuYm91bmRIYW5kbGVycy5ibG9ja2VkKTtcbiAgICB0aGlzLnNlc3Npb25NYW5hZ2VyLm9uKCdzZXNzaW9uOmNvbXBsZXRlZCcsIHRoaXMuYm91bmRIYW5kbGVycy5jb21wbGV0ZWQpO1xuICAgIHRoaXMuc2Vzc2lvbk1hbmFnZXIub24oJ3Nlc3Npb246ZXJyb3InLCB0aGlzLmJvdW5kSGFuZGxlcnMuZXJyb3IpO1xuICAgIHRoaXMuY2xpZW50Lm9uKCdtZXNzYWdlQ3JlYXRlJywgdGhpcy5ib3VuZEhhbmRsZXJzLm1lc3NhZ2VDcmVhdGUpO1xuXG4gICAgdGhpcy5sb2dnZXIuaW5mbygnZXZlbnQgYnJpZGdlIHN0YXJ0ZWQnKTtcbiAgfVxuXG4gIC8qKiBVbnN1YnNjcmliZSBmcm9tIGFsbCBldmVudHMsIGRlc3Ryb3kgYmF0Y2hlcnMsIGNsZWFyIG1hcHBpbmdzLiAqL1xuICBhc3luYyBzdG9wKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLmJvdW5kSGFuZGxlcnMpIHtcbiAgICAgIHRoaXMuc2Vzc2lvbk1hbmFnZXIub2ZmKCdzZXNzaW9uOnN0YXJ0ZWQnLCB0aGlzLmJvdW5kSGFuZGxlcnMuc3RhcnRlZCk7XG4gICAgICB0aGlzLnNlc3Npb25NYW5hZ2VyLm9mZignc2Vzc2lvbjpldmVudCcsIHRoaXMuYm91bmRIYW5kbGVycy5ldmVudCk7XG4gICAgICB0aGlzLnNlc3Npb25NYW5hZ2VyLm9mZignc2Vzc2lvbjpibG9ja2VkJywgdGhpcy5ib3VuZEhhbmRsZXJzLmJsb2NrZWQpO1xuICAgICAgdGhpcy5zZXNzaW9uTWFuYWdlci5vZmYoJ3Nlc3Npb246Y29tcGxldGVkJywgdGhpcy5ib3VuZEhhbmRsZXJzLmNvbXBsZXRlZCk7XG4gICAgICB0aGlzLnNlc3Npb25NYW5hZ2VyLm9mZignc2Vzc2lvbjplcnJvcicsIHRoaXMuYm91bmRIYW5kbGVycy5lcnJvcik7XG4gICAgICB0aGlzLmNsaWVudC5vZmYoJ21lc3NhZ2VDcmVhdGUnLCB0aGlzLmJvdW5kSGFuZGxlcnMubWVzc2FnZUNyZWF0ZSk7XG4gICAgICB0aGlzLmJvdW5kSGFuZGxlcnMgPSBudWxsO1xuICAgIH1cblxuICAgIC8vIERlc3Ryb3kgYWxsIGJhdGNoZXJzXG4gICAgY29uc3QgZGVzdHJveVByb21pc2VzOiBQcm9taXNlPHZvaWQ+W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGJhdGNoZXIgb2YgdGhpcy5iYXRjaGVycy52YWx1ZXMoKSkge1xuICAgICAgZGVzdHJveVByb21pc2VzLnB1c2goYmF0Y2hlci5kZXN0cm95KCkpO1xuICAgIH1cbiAgICBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQoZGVzdHJveVByb21pc2VzKTtcblxuICAgIHRoaXMuYmF0Y2hlcnMuY2xlYXIoKTtcbiAgICB0aGlzLnNlc3Npb25Ub0NoYW5uZWwuY2xlYXIoKTtcbiAgICB0aGlzLmNoYW5uZWxUb1Nlc3Npb24uY2xlYXIoKTtcbiAgICB0aGlzLmNoYW5uZWxzLmNsZWFyKCk7XG5cbiAgICB0aGlzLmxvZ2dlci5pbmZvKCdldmVudCBicmlkZ2Ugc3RvcHBlZCcpO1xuICB9XG5cbiAgLyoqIEV4cG9zZSB0aGUgdmVyYm9zaXR5IG1hbmFnZXIgZm9yIHNsYXNoLWNvbW1hbmQgaW50ZWdyYXRpb24uICovXG4gIGdldFZlcmJvc2l0eU1hbmFnZXIoKTogVmVyYm9zaXR5TWFuYWdlciB7XG4gICAgcmV0dXJuIHRoaXMudmVyYm9zaXR5O1xuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gU2Vzc2lvbk1hbmFnZXIgZXZlbnQgaGFuZGxlcnNcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICBwcml2YXRlIGFzeW5jIG9uU2Vzc2lvblN0YXJ0ZWQoZGF0YTogU2Vzc2lvblN0YXJ0ZWRQYXlsb2FkKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgeyBzZXNzaW9uSWQsIHByb2plY3REaXIsIHByb2plY3ROYW1lIH0gPSBkYXRhO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNoYW5uZWwgPSBhd2FpdCB0aGlzLmNoYW5uZWxNYW5hZ2VyLmNyZWF0ZVByb2plY3RDaGFubmVsKHByb2plY3REaXIpO1xuXG4gICAgICAvLyBDcmVhdGUgYmF0Y2hlciB3aXRoIGNoYW5uZWwuc2VuZCBhcyB0aGUgc2VuZCBmdW5jdGlvblxuICAgICAgY29uc3QgYmF0Y2hlciA9IG5ldyBNZXNzYWdlQmF0Y2hlcihcbiAgICAgICAgYXN5bmMgKHBheWxvYWQpID0+IHtcbiAgICAgICAgICBhd2FpdCBjaGFubmVsLnNlbmQocGF5bG9hZCBhcyBQYXJhbWV0ZXJzPFRleHRDaGFubmVsWydzZW5kJ10+WzBdKTtcbiAgICAgICAgfSxcbiAgICAgICAgdGhpcy5sb2dnZXIsXG4gICAgICApO1xuICAgICAgYmF0Y2hlci5zdGFydCgpO1xuXG4gICAgICAvLyBSZWdpc3RlciBiaWRpcmVjdGlvbmFsIG1hcHBpbmdcbiAgICAgIHRoaXMuc2Vzc2lvblRvQ2hhbm5lbC5zZXQoc2Vzc2lvbklkLCBjaGFubmVsLmlkKTtcbiAgICAgIHRoaXMuY2hhbm5lbFRvU2Vzc2lvbi5zZXQoY2hhbm5lbC5pZCwgc2Vzc2lvbklkKTtcbiAgICAgIHRoaXMuYmF0Y2hlcnMuc2V0KHNlc3Npb25JZCwgYmF0Y2hlcik7XG4gICAgICB0aGlzLmNoYW5uZWxzLnNldChzZXNzaW9uSWQsIGNoYW5uZWwpO1xuXG4gICAgICAvLyBQb3N0IHdlbGNvbWUgZW1iZWRcbiAgICAgIGNvbnN0IHdlbGNvbWUgPSBmb3JtYXRTZXNzaW9uU3RhcnRlZChwcm9qZWN0TmFtZSk7XG4gICAgICBiYXRjaGVyLmVucXVldWUod2VsY29tZSk7XG5cbiAgICAgIHRoaXMubG9nZ2VyLmluZm8oJ2JyaWRnZTogc2Vzc2lvbiBjaGFubmVsIGNyZWF0ZWQnLCB7XG4gICAgICAgIHNlc3Npb25JZCxcbiAgICAgICAgY2hhbm5lbElkOiBjaGFubmVsLmlkLFxuICAgICAgICBwcm9qZWN0TmFtZSxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgLy8gRmFpbHVyZSBtb2RlOiBsb2cgZXJyb3IsIHNraXAgc3RyZWFtaW5nIGZvciB0aGlzIHNlc3Npb25cbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKCdicmlkZ2U6IGNoYW5uZWwgY3JlYXRpb24gZmFpbGVkJywge1xuICAgICAgICBzZXNzaW9uSWQsXG4gICAgICAgIHByb2plY3REaXIsXG4gICAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIG9uU2Vzc2lvbkV2ZW50KGRhdGE6IFNlc3Npb25FdmVudFBheWxvYWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB7IHNlc3Npb25JZCwgZXZlbnQgfSA9IGRhdGE7XG4gICAgY29uc3QgY2hhbm5lbElkID0gdGhpcy5zZXNzaW9uVG9DaGFubmVsLmdldChzZXNzaW9uSWQpO1xuICAgIGlmICghY2hhbm5lbElkKSByZXR1cm47IC8vIG5vIGNoYW5uZWwgZm9yIHRoaXMgc2Vzc2lvblxuXG4gICAgLy8gVmVyYm9zaXR5IGZpbHRlclxuICAgIGNvbnN0IGV2ZW50VHlwZSA9IChldmVudCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikudHlwZSBhcyBzdHJpbmc7XG4gICAgaWYgKCF0aGlzLnZlcmJvc2l0eS5zaG91bGRTaG93KGNoYW5uZWxJZCwgZXZlbnRUeXBlKSkgcmV0dXJuO1xuXG4gICAgY29uc3QgZm9ybWF0dGVkID0gZm9ybWF0RXZlbnQoZXZlbnQsIHRoaXMub3duZXJJZCk7XG4gICAgY29uc3QgYmF0Y2hlciA9IHRoaXMuYmF0Y2hlcnMuZ2V0KHNlc3Npb25JZCk7XG4gICAgaWYgKGJhdGNoZXIpIHtcbiAgICAgIGJhdGNoZXIuZW5xdWV1ZShmb3JtYXR0ZWQpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgb25TZXNzaW9uQmxvY2tlZChkYXRhOiBTZXNzaW9uQmxvY2tlZFBheWxvYWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB7IHNlc3Npb25JZCwgcHJvamVjdE5hbWUsIGJsb2NrZXIgfSA9IGRhdGE7XG4gICAgY29uc3QgY2hhbm5lbCA9IHRoaXMuY2hhbm5lbHMuZ2V0KHNlc3Npb25JZCk7XG4gICAgaWYgKCFjaGFubmVsKSByZXR1cm47XG5cbiAgICBjb25zdCBmb3JtYXR0ZWQgPSBmb3JtYXRCbG9ja2VyKGJsb2NrZXIsIHRoaXMub3duZXJJZCk7XG5cbiAgICAvLyBTZW5kIGltbWVkaWF0ZWx5IChieXBhc3NlcyBiYXRjaGluZyBmb3IgYmxvY2tlcnMpXG4gICAgY29uc3QgYmF0Y2hlciA9IHRoaXMuYmF0Y2hlcnMuZ2V0KHNlc3Npb25JZCk7XG4gICAgaWYgKGJhdGNoZXIpIHtcbiAgICAgIGF3YWl0IGJhdGNoZXIuZW5xdWV1ZUltbWVkaWF0ZShmb3JtYXR0ZWQpO1xuICAgIH1cblxuICAgIC8vIEZvciBzZWxlY3QvY29uZmlybSBtZXRob2RzLCBzZXQgdXAgYnV0dG9uIGNvbGxlY3RvclxuICAgIGlmIChibG9ja2VyLm1ldGhvZCA9PT0gJ3NlbGVjdCcgfHwgYmxvY2tlci5tZXRob2QgPT09ICdjb25maXJtJykge1xuICAgICAgdGhpcy5jcmVhdGVCdXR0b25Db2xsZWN0b3Ioc2Vzc2lvbklkLCBjaGFubmVsLCBibG9ja2VyKTtcbiAgICB9XG5cbiAgICAvLyBETSBiYWNrdXBcbiAgICBpZiAodGhpcy5jb25maWcuZGlzY29yZD8uZG1fb25fYmxvY2tlcikge1xuICAgICAgYXdhaXQgdGhpcy5zZW5kQmxvY2tlckRNKHNlc3Npb25JZCwgcHJvamVjdE5hbWUsIGJsb2NrZXIpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgb25TZXNzaW9uQ29tcGxldGVkKGRhdGE6IFNlc3Npb25Db21wbGV0ZWRQYXlsb2FkKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgeyBzZXNzaW9uSWQsIHByb2plY3ROYW1lIH0gPSBkYXRhO1xuICAgIGNvbnN0IGJhdGNoZXIgPSB0aGlzLmJhdGNoZXJzLmdldChzZXNzaW9uSWQpO1xuICAgIGlmICghYmF0Y2hlcikgcmV0dXJuO1xuXG4gICAgY29uc3QgY29tcGxldGlvbiA9IGZvcm1hdENvbXBsZXRpb24oe1xuICAgICAgdHlwZTogJ2V4ZWN1dGlvbl9jb21wbGV0ZScsXG4gICAgICBzdGF0dXM6ICdjb21wbGV0ZWQnLFxuICAgIH0gYXMgU2RrQWdlbnRFdmVudCk7XG5cbiAgICAvLyBGbHVzaCB0aHJvdWdoIGJhdGNoZXIgdGhlbiBjbGVhbnVwXG4gICAgYmF0Y2hlci5lbnF1ZXVlKGNvbXBsZXRpb24pO1xuICAgIGF3YWl0IHRoaXMuY2xlYW51cFNlc3Npb24oc2Vzc2lvbklkKTtcblxuICAgIHRoaXMubG9nZ2VyLmluZm8oJ2JyaWRnZTogc2Vzc2lvbiBjb21wbGV0ZWQnLCB7IHNlc3Npb25JZCwgcHJvamVjdE5hbWUgfSk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIG9uU2Vzc2lvbkVycm9yKGRhdGE6IFNlc3Npb25FcnJvclBheWxvYWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB7IHNlc3Npb25JZCwgcHJvamVjdE5hbWUsIGVycm9yIH0gPSBkYXRhO1xuICAgIGNvbnN0IGJhdGNoZXIgPSB0aGlzLmJhdGNoZXJzLmdldChzZXNzaW9uSWQpO1xuICAgIGlmICghYmF0Y2hlcikgcmV0dXJuO1xuXG4gICAgY29uc3QgZXJyb3JFbWJlZCA9IGZvcm1hdEVycm9yKHNlc3Npb25JZCwgZXJyb3IpO1xuICAgIGJhdGNoZXIuZW5xdWV1ZShlcnJvckVtYmVkKTtcbiAgICBhd2FpdCB0aGlzLmNsZWFudXBTZXNzaW9uKHNlc3Npb25JZCk7XG5cbiAgICB0aGlzLmxvZ2dlci5pbmZvKCdicmlkZ2U6IHNlc3Npb24gZXJyb3InLCB7IHNlc3Npb25JZCwgcHJvamVjdE5hbWUsIGVycm9yIH0pO1xuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gQmxvY2tlciByZXNvbHV0aW9uIFx1MjAxNCBidXR0b24gY29sbGVjdG9yXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgcHJpdmF0ZSBjcmVhdGVCdXR0b25Db2xsZWN0b3IoXG4gICAgc2Vzc2lvbklkOiBzdHJpbmcsXG4gICAgY2hhbm5lbDogVGV4dENoYW5uZWwsXG4gICAgYmxvY2tlcjogUGVuZGluZ0Jsb2NrZXIsXG4gICk6IHZvaWQge1xuICAgIC8vIENyZWF0ZSBhIG1lc3NhZ2UgY29sbGVjdG9yIG9uIHRoZSBjaGFubmVsIGZvciBidXR0b24gaW50ZXJhY3Rpb25zXG4gICAgLy8gV2UgdXNlIGNyZWF0ZU1lc3NhZ2VDb21wb25lbnRDb2xsZWN0b3Igb24gdGhlIGNoYW5uZWxcbiAgICB0cnkge1xuICAgICAgY29uc3QgY29sbGVjdG9yID0gY2hhbm5lbC5jcmVhdGVNZXNzYWdlQ29tcG9uZW50Q29sbGVjdG9yKHtcbiAgICAgICAgY29tcG9uZW50VHlwZTogQ29tcG9uZW50VHlwZS5CdXR0b24sXG4gICAgICAgIHRpbWU6IEJMT0NLRVJfQ09MTEVDVE9SX1RJTUVPVVRfTVMsXG4gICAgICAgIGZpbHRlcjogKGludGVyYWN0aW9uOiBNZXNzYWdlQ29tcG9uZW50SW50ZXJhY3Rpb24pID0+IHtcbiAgICAgICAgICByZXR1cm4gaW50ZXJhY3Rpb24uY3VzdG9tSWQuc3RhcnRzV2l0aChgYmxvY2tlcjoke2Jsb2NrZXIuaWR9OmApO1xuICAgICAgICB9LFxuICAgICAgfSk7XG5cbiAgICAgIGNvbGxlY3Rvci5vbignY29sbGVjdCcsIGFzeW5jIChpbnRlcmFjdGlvbjogTWVzc2FnZUNvbXBvbmVudEludGVyYWN0aW9uKSA9PiB7XG4gICAgICAgIC8vIEF1dGggZ3VhcmRcbiAgICAgICAgaWYgKCFpc0F1dGhvcml6ZWQoaW50ZXJhY3Rpb24udXNlci5pZCwgdGhpcy5vd25lcklkKSkge1xuICAgICAgICAgIGF3YWl0IGludGVyYWN0aW9uLnJlcGx5KHtcbiAgICAgICAgICAgIGNvbnRlbnQ6ICdcdTI2RDQgT25seSB0aGUgcHJvamVjdCBvd25lciBjYW4gcmVzcG9uZCB0byBibG9ja2Vycy4nLFxuICAgICAgICAgICAgZXBoZW1lcmFsOiB0cnVlLFxuICAgICAgICAgIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICAvLyBQYXJzZSBjdXN0b21JZDogYmxvY2tlcjp7aWR9OnttZXRob2R9Ont2YWx1ZX1cbiAgICAgICAgY29uc3QgcGFydHMgPSBpbnRlcmFjdGlvbi5jdXN0b21JZC5zcGxpdCgnOicpO1xuICAgICAgICBjb25zdCB2YWx1ZSA9IHBhcnRzWzNdID8/ICcnO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgdGhpcy5zZXNzaW9uTWFuYWdlci5yZXNvbHZlQmxvY2tlcihzZXNzaW9uSWQsIHZhbHVlKTtcbiAgICAgICAgICBhd2FpdCBpbnRlcmFjdGlvbi51cGRhdGUoe1xuICAgICAgICAgICAgY29udGVudDogYFx1MjcwNSBCbG9ja2VyIHJlc29sdmVkIHdpdGg6ICR7dmFsdWV9YCxcbiAgICAgICAgICAgIGNvbXBvbmVudHM6IFtdLFxuICAgICAgICAgIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICBjb2xsZWN0b3Iuc3RvcCgncmVzb2x2ZWQnKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgY29uc3QgZXJyTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKCdicmlkZ2U6IGJsb2NrZXIgcmVzb2x2ZSBmYWlsZWQnLCB7IHNlc3Npb25JZCwgZXJyb3I6IGVyck1zZyB9KTtcbiAgICAgICAgICBhd2FpdCBpbnRlcmFjdGlvbi5yZXBseSh7XG4gICAgICAgICAgICBjb250ZW50OiBgXHUyNzRDIEZhaWxlZCB0byByZXNvbHZlIGJsb2NrZXI6ICR7ZXJyTXNnfWAsXG4gICAgICAgICAgICBlcGhlbWVyYWw6IHRydWUsXG4gICAgICAgICAgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgY29sbGVjdG9yLm9uKCdlbmQnLCAoX2NvbGxlY3RlZCwgcmVhc29uKSA9PiB7XG4gICAgICAgIGlmIChyZWFzb24gPT09ICd0aW1lJykge1xuICAgICAgICAgIC8vIFRpbWVvdXQ6IGVkaXQgdG8gc2hvdyBleHBpcmVkXG4gICAgICAgICAgdGhpcy5sb2dnZXIuaW5mbygnYnJpZGdlOiBibG9ja2VyIGNvbGxlY3RvciB0aW1lZCBvdXQnLCB7IHNlc3Npb25JZCwgYmxvY2tlcklkOiBibG9ja2VyLmlkIH0pO1xuICAgICAgICAgIC8vIFBvc3QgYSBuZXcgbWVzc2FnZSBpbmRpY2F0aW5nIGV4cGlyeSBcdTIwMTQgZWRpdGluZyBvcmlnaW5hbCBtYXkgZmFpbFxuICAgICAgICAgIGNvbnN0IGJhdGNoZXIgPSB0aGlzLmJhdGNoZXJzLmdldChzZXNzaW9uSWQpO1xuICAgICAgICAgIGlmIChiYXRjaGVyKSB7XG4gICAgICAgICAgICBiYXRjaGVyLmVucXVldWUoe1xuICAgICAgICAgICAgICBjb250ZW50OiBgXHUyM0YwIEJsb2NrZXIgcmVzcG9uc2UgdGltZWQgb3V0IGFmdGVyIDI0aC4gUmUtcG9zdGluZy4uLmAsXG4gICAgICAgICAgICAgIGVtYmVkOiBuZXcgRW1iZWRCdWlsZGVyKClcbiAgICAgICAgICAgICAgICAuc2V0Q29sb3IoMHhmMWM0MGYpXG4gICAgICAgICAgICAgICAgLnNldFRpdGxlKCdcdTIzRjAgQmxvY2tlciBFeHBpcmVkJylcbiAgICAgICAgICAgICAgICAuc2V0RGVzY3JpcHRpb24oYmxvY2tlci5tZXNzYWdlKVxuICAgICAgICAgICAgICAgIC5zZXRUaW1lc3RhbXAoKSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcignYnJpZGdlOiBjb2xsZWN0b3IgY3JlYXRpb24gZmFpbGVkJywge1xuICAgICAgICBzZXNzaW9uSWQsXG4gICAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBETSBiYWNrdXBcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICBwcml2YXRlIGFzeW5jIHNlbmRCbG9ja2VyRE0oXG4gICAgc2Vzc2lvbklkOiBzdHJpbmcsXG4gICAgcHJvamVjdE5hbWU6IHN0cmluZyxcbiAgICBibG9ja2VyOiBQZW5kaW5nQmxvY2tlcixcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHVzZXIgPSBhd2FpdCB0aGlzLmNsaWVudC51c2Vycy5mZXRjaCh0aGlzLm93bmVySWQpO1xuICAgICAgYXdhaXQgdXNlci5zZW5kKHtcbiAgICAgICAgY29udGVudDogYFx1MjZBMFx1RkUwRiAqKkJsb2NrZXIqKiBpbiAqKiR7cHJvamVjdE5hbWV9KiogXHUyMDE0ICR7YmxvY2tlci5tZXNzYWdlfVxcblxcblJlc3BvbmQgaW4gdGhlIHByb2plY3QgY2hhbm5lbC5gLFxuICAgICAgfSk7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZygnYnJpZGdlOiBETSBzZW50IGZvciBibG9ja2VyJywgeyBzZXNzaW9uSWQsIGJsb2NrZXJJZDogYmxvY2tlci5pZCB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIC8vIERNIGZhaWx1cmUgaXMgbm9uLWZhdGFsIFx1MjAxNCBjaGFubmVsIG1lc3NhZ2UgaXMgdGhlIHByaW1hcnkgcGF0aFxuICAgICAgdGhpcy5sb2dnZXIud2FybignYnJpZGdlOiBETSBzZW5kIGZhaWxlZCcsIHtcbiAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gQ29udmVyc2F0aW9uIHJlbGF5IFx1MjAxNCBEaXNjb3JkIFx1MjE5MiBHU0RcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICBwcml2YXRlIGFzeW5jIGhhbmRsZU1lc3NhZ2VDcmVhdGUobWVzc2FnZTogTWVzc2FnZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIC8vIEZpbHRlcjogYm90IG1lc3NhZ2VzXG4gICAgaWYgKG1lc3NhZ2UuYXV0aG9yLmJvdCkgcmV0dXJuO1xuXG4gICAgLy8gRmlsdGVyOiBtdXN0IGJlIGluIGEgcHJvamVjdCBjaGFubmVsXG4gICAgY29uc3Qgc2Vzc2lvbklkID0gdGhpcy5jaGFubmVsVG9TZXNzaW9uLmdldChtZXNzYWdlLmNoYW5uZWxJZCk7XG4gICAgaWYgKCFzZXNzaW9uSWQpIHJldHVybjtcblxuICAgIC8vIEZpbHRlcjogbXVzdCBiZSBhdXRob3JpemVkXG4gICAgaWYgKCFpc0F1dGhvcml6ZWQobWVzc2FnZS5hdXRob3IuaWQsIHRoaXMub3duZXJJZCkpIHJldHVybjtcblxuICAgIGNvbnN0IHNlc3Npb24gPSB0aGlzLnNlc3Npb25NYW5hZ2VyLmdldFNlc3Npb24oc2Vzc2lvbklkKTtcbiAgICBpZiAoIXNlc3Npb24pIHJldHVybjtcblxuICAgIC8vIElmIHNlc3Npb24gaGFzIGEgcGVuZGluZyBibG9ja2VyIHdpdGggaW5wdXQvZWRpdG9yIG1ldGhvZCwgcmVzb2x2ZSBpdFxuICAgIGlmIChzZXNzaW9uLnBlbmRpbmdCbG9ja2VyICYmIChzZXNzaW9uLnBlbmRpbmdCbG9ja2VyLm1ldGhvZCA9PT0gJ2lucHV0JyB8fCBzZXNzaW9uLnBlbmRpbmdCbG9ja2VyLm1ldGhvZCA9PT0gJ2VkaXRvcicpKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCB0aGlzLnNlc3Npb25NYW5hZ2VyLnJlc29sdmVCbG9ja2VyKHNlc3Npb25JZCwgbWVzc2FnZS5jb250ZW50KTtcbiAgICAgICAgYXdhaXQgbWVzc2FnZS5yZWFjdCgnXHUyNzA1JykuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICB0aGlzLmxvZ2dlci5pbmZvKCdicmlkZ2U6IGJsb2NrZXIgcmVzb2x2ZWQgdmlhIHJlbGF5Jywge1xuICAgICAgICAgIHNlc3Npb25JZCxcbiAgICAgICAgICBtZXRob2Q6IHNlc3Npb24ucGVuZGluZ0Jsb2NrZXIubWV0aG9kLFxuICAgICAgICB9KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zdCBlcnJNc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICAgIHRoaXMubG9nZ2VyLmVycm9yKCdicmlkZ2U6IHJlbGF5IGJsb2NrZXIgcmVzb2x2ZSBmYWlsZWQnLCB7IHNlc3Npb25JZCwgZXJyb3I6IGVyck1zZyB9KTtcbiAgICAgICAgYXdhaXQgbWVzc2FnZS5yZXBseShgXHUyNzRDIEZhaWxlZCB0byByZXNvbHZlIGJsb2NrZXI6ICR7ZXJyTXNnfWApLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBPdGhlcndpc2UsIHJlbGF5IHRoZSBtZXNzYWdlIHRvIHRoZSBHU0Qgc2Vzc2lvblxuICAgIC8vIFVzZSBzdGVlcigpIHdoZW4gcnVubmluZyAoaW5qZWN0cyBtaWQtdHVybiksIHByb21wdCgpIG90aGVyd2lzZSAoc3RhcnRzIG5ldyB0dXJuKVxuICAgIHRyeSB7XG4gICAgICBpZiAoc2Vzc2lvbi5zdGF0dXMgPT09ICdydW5uaW5nJykge1xuICAgICAgICBhd2FpdCBzZXNzaW9uLmNsaWVudC5zdGVlcihtZXNzYWdlLmNvbnRlbnQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYXdhaXQgc2Vzc2lvbi5jbGllbnQucHJvbXB0KG1lc3NhZ2UuY29udGVudCk7XG4gICAgICB9XG4gICAgICBhd2FpdCBtZXNzYWdlLnJlYWN0KCdcdUQ4M0RcdURDRTgnKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICB0aGlzLmxvZ2dlci5pbmZvKCdicmlkZ2U6IG1lc3NhZ2UgcmVsYXllZCB0byBzZXNzaW9uJywge1xuICAgICAgICBzZXNzaW9uSWQsXG4gICAgICAgIG1ldGhvZDogc2Vzc2lvbi5zdGF0dXMgPT09ICdydW5uaW5nJyA/ICdzdGVlcicgOiAncHJvbXB0JyxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgZXJyTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoJ2JyaWRnZTogcmVsYXkgZmFpbGVkJywgeyBzZXNzaW9uSWQsIGVycm9yOiBlcnJNc2cgfSk7XG4gICAgICBhd2FpdCBtZXNzYWdlLnJlcGx5KGBcdTI3NEMgRmFpbGVkIHRvIHJlbGF5IG1lc3NhZ2U6ICR7ZXJyTXNnfWApLmNhdGNoKCgpID0+IHt9KTtcbiAgICB9XG4gIH1cblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBDbGVhbnVwXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgcHJpdmF0ZSBhc3luYyBjbGVhbnVwU2Vzc2lvbihzZXNzaW9uSWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGJhdGNoZXIgPSB0aGlzLmJhdGNoZXJzLmdldChzZXNzaW9uSWQpO1xuICAgIGlmIChiYXRjaGVyKSB7XG4gICAgICBhd2FpdCBiYXRjaGVyLmRlc3Ryb3koKTtcbiAgICAgIHRoaXMuYmF0Y2hlcnMuZGVsZXRlKHNlc3Npb25JZCk7XG4gICAgfVxuXG4gICAgY29uc3QgY2hhbm5lbElkID0gdGhpcy5zZXNzaW9uVG9DaGFubmVsLmdldChzZXNzaW9uSWQpO1xuICAgIGlmIChjaGFubmVsSWQpIHtcbiAgICAgIHRoaXMuY2hhbm5lbFRvU2Vzc2lvbi5kZWxldGUoY2hhbm5lbElkKTtcbiAgICB9XG4gICAgdGhpcy5zZXNzaW9uVG9DaGFubmVsLmRlbGV0ZShzZXNzaW9uSWQpO1xuICAgIHRoaXMuY2hhbm5lbHMuZGVsZXRlKHNlc3Npb25JZCk7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBJbnRlcm5hbCBldmVudCBwYXlsb2FkIHR5cGVzIChtYXRjaGluZyBTZXNzaW9uTWFuYWdlciBlbWlzc2lvbnMpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuaW50ZXJmYWNlIFNlc3Npb25TdGFydGVkUGF5bG9hZCB7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICBwcm9qZWN0RGlyOiBzdHJpbmc7XG4gIHByb2plY3ROYW1lOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBTZXNzaW9uRXZlbnRQYXlsb2FkIHtcbiAgc2Vzc2lvbklkOiBzdHJpbmc7XG4gIHByb2plY3REaXI6IHN0cmluZztcbiAgZXZlbnQ6IFNka0FnZW50RXZlbnQ7XG59XG5cbmludGVyZmFjZSBTZXNzaW9uQmxvY2tlZFBheWxvYWQge1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgcHJvamVjdERpcjogc3RyaW5nO1xuICBwcm9qZWN0TmFtZTogc3RyaW5nO1xuICBibG9ja2VyOiBQZW5kaW5nQmxvY2tlcjtcbn1cblxuaW50ZXJmYWNlIFNlc3Npb25Db21wbGV0ZWRQYXlsb2FkIHtcbiAgc2Vzc2lvbklkOiBzdHJpbmc7XG4gIHByb2plY3REaXI6IHN0cmluZztcbiAgcHJvamVjdE5hbWU6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFNlc3Npb25FcnJvclBheWxvYWQge1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgcHJvamVjdERpcjogc3RyaW5nO1xuICBwcm9qZWN0TmFtZTogc3RyaW5nO1xuICBlcnJvcjogc3RyaW5nO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBYUEsU0FBUyxjQUFjLHFCQUFxQjtBQU01QyxTQUFTLHNCQUFzQjtBQUMvQixTQUFTLHdCQUF3QjtBQUNqQztBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsb0JBQW9CO0FBMkI3QixNQUFNLCtCQUErQixLQUFLLEtBQUssS0FBSztBQU03QyxNQUFNLFlBQVk7QUFBQSxFQUNOO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQTtBQUFBLEVBR0EsbUJBQW1CLG9CQUFJLElBQW9CO0FBQUE7QUFBQSxFQUUzQyxtQkFBbUIsb0JBQUksSUFBb0I7QUFBQTtBQUFBLEVBRTNDLFdBQVcsb0JBQUksSUFBNEI7QUFBQTtBQUFBLEVBRTNDLFdBQVcsb0JBQUksSUFBeUI7QUFBQSxFQUV4QyxZQUFZLElBQUksaUJBQWlCO0FBQUE7QUFBQSxFQUcxQyxnQkFPRztBQUFBLEVBRVgsWUFBWSxNQUEwQjtBQUNwQyxTQUFLLGlCQUFpQixLQUFLO0FBQzNCLFNBQUssaUJBQWlCLEtBQUs7QUFDM0IsU0FBSyxTQUFTLEtBQUs7QUFD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
