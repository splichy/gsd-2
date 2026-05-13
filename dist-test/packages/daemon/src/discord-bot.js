import {
  Client,
  GatewayIntentBits,
  REST,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ComponentType
} from "discord.js";
import { ChannelManager } from "./channel-manager.js";
import { buildCommands, registerGuildCommands, formatSessionStatus } from "./commands.js";
function isAuthorized(userId, ownerId) {
  if (!ownerId || !userId) return false;
  return userId === ownerId;
}
function validateDiscordConfig(config) {
  if (!config) {
    throw new Error("Discord config is undefined");
  }
  if (!config.token || config.token.trim() === "") {
    throw new Error("Discord config missing required field: token");
  }
  if (!config.guild_id || config.guild_id.trim() === "") {
    throw new Error("Discord config missing required field: guild_id");
  }
  if (!config.owner_id || config.owner_id.trim() === "") {
    throw new Error("Discord config missing required field: owner_id");
  }
}
class DiscordBot {
  client = null;
  destroyed = false;
  channelManager = null;
  eventBridge = null;
  config;
  logger;
  sessionManager;
  scanProjects;
  constructor(opts) {
    this.config = opts.config;
    this.logger = opts.logger;
    this.sessionManager = opts.sessionManager;
    this.scanProjects = opts.scanProjects;
  }
  /**
   * Create the discord.js Client, register event handlers, and log in.
   * Throws on login failure — the caller (Daemon) decides whether to continue without the bot.
   */
  async login() {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    });
    client.once("ready", (readyClient) => {
      const guildNames = readyClient.guilds.cache.map((g) => g.name).join(", ");
      this.logger.info("bot ready", {
        username: readyClient.user.tag,
        guilds: guildNames
      });
      const rest = new REST({ version: "10" }).setToken(this.config.token);
      const commands = buildCommands();
      registerGuildCommands(
        rest,
        readyClient.user.id,
        this.config.guild_id,
        commands,
        this.logger
      ).catch((err) => {
        this.logger.warn("unexpected command registration error", {
          error: err instanceof Error ? err.message : String(err)
        });
      });
    });
    client.on("interactionCreate", (interaction) => {
      this.handleInteraction(interaction);
    });
    client.on("messageCreate", (msg) => {
      this.logger.debug("raw messageCreate", {
        authorId: msg.author.id,
        authorBot: msg.author.bot,
        channelId: msg.channelId,
        contentLength: msg.content.length,
        hasContent: msg.content.length > 0
      });
    });
    client.on("shardError", (error) => {
      this.logger.error("discord shard error", { error: error.message });
    });
    client.on("shardDisconnect", (event, shardId) => {
      this.logger.warn("discord shard disconnected", { shardId, code: event.code });
    });
    client.on("shardReconnecting", (shardId) => {
      this.logger.info("discord shard reconnecting", { shardId });
    });
    client.on("shardResume", (shardId, replayedEvents) => {
      this.logger.info("discord shard resumed", { shardId, replayedEvents });
    });
    client.on("warn", (message) => {
      this.logger.warn("discord warning", { message });
    });
    client.on("error", (error) => {
      this.logger.error("discord error", { error: error.message });
    });
    let readyTimeout;
    let readySettled = false;
    const readyPromise = new Promise((resolve, reject) => {
      readyTimeout = setTimeout(() => {
        if (!readySettled) {
          readySettled = true;
          reject(new Error("Discord ready timeout (30s)"));
        }
      }, 3e4);
      const cleanup = () => {
        if (readyTimeout) {
          clearTimeout(readyTimeout);
          readyTimeout = void 0;
        }
      };
      client.once("ready", () => {
        cleanup();
        if (!readySettled) {
          readySettled = true;
          resolve();
        }
      });
      client.once("error", (err) => {
        cleanup();
        if (!readySettled) {
          readySettled = true;
          reject(err);
        }
      });
      client.once("shardDisconnect", (event) => {
        cleanup();
        if (!readySettled) {
          readySettled = true;
          reject(new Error(`Shard disconnected: ${event.code}`));
        }
      });
    });
    try {
      await client.login(this.config.token);
    } catch (err) {
      if (readyTimeout) {
        clearTimeout(readyTimeout);
        readyTimeout = void 0;
      }
      readySettled = true;
      throw err;
    }
    await readyPromise;
    this.client = client;
    this.destroyed = false;
  }
  /**
   * Destroy the discord.js Client. Idempotent — safe to call multiple times
   * or before login().
   */
  async destroy() {
    if (this.destroyed || !this.client) {
      this.destroyed = true;
      return;
    }
    try {
      this.client.destroy();
      this.logger.info("bot destroyed");
    } catch (err) {
      this.logger.debug("bot destroy error (swallowed)", {
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      this.client = null;
      this.destroyed = true;
    }
  }
  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------
  /**
   * Lazily create a ChannelManager from the configured guild.
   * Returns null if the client isn't ready or the guild isn't found.
   */
  getChannelManager() {
    if (this.channelManager) return this.channelManager;
    if (!this.client?.isReady()) return null;
    const guild = this.client.guilds.cache.get(this.config.guild_id);
    if (!guild) {
      this.logger.warn("guild not found for channel manager", { guildId: this.config.guild_id });
      return null;
    }
    this.channelManager = new ChannelManager({ guild, logger: this.logger });
    return this.channelManager;
  }
  /**
   * Return the underlying discord.js Client, or null if not logged in.
   * Used by Daemon to pass to EventBridge as BridgeClient.
   */
  getClient() {
    return this.client;
  }
  /**
   * Set the EventBridge reference so the bot can dispatch /gsd-verbose commands.
   * Called by Daemon after creating the EventBridge.
   */
  setEventBridge(bridge) {
    this.eventBridge = bridge;
  }
  // ---------------------------------------------------------------------------
  // Private: interaction handling
  // ---------------------------------------------------------------------------
  handleInteraction(interaction) {
    if (!isAuthorized(interaction.user.id, this.config.owner_id)) {
      this.logger.debug("auth rejected", { userId: interaction.user.id });
      return;
    }
    if (!interaction.isChatInputCommand()) {
      this.logger.debug("non-command interaction", {
        type: interaction.type,
        userId: interaction.user.id
      });
      return;
    }
    const { commandName } = interaction;
    this.logger.info("command handled", { commandName, userId: interaction.user.id });
    switch (commandName) {
      case "gsd-status": {
        const sessions = this.sessionManager.getAllSessions();
        const content = formatSessionStatus(sessions);
        interaction.reply({ content, ephemeral: true }).catch((err) => {
          this.logger.warn("gsd-status reply failed", {
            error: err instanceof Error ? err.message : String(err)
          });
        });
        break;
      }
      case "gsd-start":
        this.handleGsdStart(interaction).catch((err) => {
          this.logger.warn("gsd-start handler error", {
            error: err instanceof Error ? err.message : String(err)
          });
        });
        break;
      case "gsd-stop":
        this.handleGsdStop(interaction).catch((err) => {
          this.logger.warn("gsd-stop handler error", {
            error: err instanceof Error ? err.message : String(err)
          });
        });
        break;
      case "gsd-verbose": {
        if (!this.eventBridge) {
          interaction.reply({ content: "Event bridge not available.", ephemeral: true }).catch((err) => {
            this.logger.warn("gsd-verbose reply failed", {
              error: err instanceof Error ? err.message : String(err)
            });
          });
          break;
        }
        const level = interaction.options.getString("level") ?? "default";
        const channelId = interaction.channelId;
        this.eventBridge.getVerbosityManager().setLevel(channelId, level);
        interaction.reply({ content: `Verbosity set to **${level}** for this channel.`, ephemeral: true }).catch((err) => {
          this.logger.warn("gsd-verbose reply failed", {
            error: err instanceof Error ? err.message : String(err)
          });
        });
        break;
      }
      default:
        interaction.reply({ content: "Unknown command", ephemeral: true }).catch((err) => {
          this.logger.warn("unknown command reply failed", {
            error: err instanceof Error ? err.message : String(err)
          });
        });
        break;
    }
  }
  // ---------------------------------------------------------------------------
  // Private: /gsd-start handler
  // ---------------------------------------------------------------------------
  async handleGsdStart(interaction) {
    await interaction.deferReply({ ephemeral: true });
    this.logger.info("gsd-start: scanning projects");
    if (!this.scanProjects) {
      await interaction.editReply({ content: "Project scanning not available." });
      return;
    }
    let projects;
    try {
      projects = await this.scanProjects();
    } catch (err) {
      this.logger.error("gsd-start: scan failed", {
        error: err instanceof Error ? err.message : String(err)
      });
      await interaction.editReply({ content: "Failed to scan for projects." });
      return;
    }
    if (projects.length === 0) {
      await interaction.editReply({ content: "No projects found." });
      return;
    }
    const truncated = projects.slice(0, 25);
    const select = new StringSelectMenuBuilder().setCustomId("gsd-start-select").setPlaceholder("Select a project to start").addOptions(
      truncated.map((p) => ({
        label: p.name.slice(0, 100),
        // Discord label max 100 chars
        value: p.path,
        description: p.markers.join(", ").slice(0, 100) || void 0
      }))
    );
    const row = new ActionRowBuilder().addComponents(select);
    const reply = await interaction.editReply({
      content: `Select a project to start (${truncated.length}${projects.length > 25 ? ` of ${projects.length}` : ""} projects):`,
      components: [row]
    });
    try {
      const collected = await reply.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        time: 6e4,
        filter: (i) => i.user.id === interaction.user.id
      });
      const projectPath = collected.values[0];
      this.logger.info("gsd-start: project selected", { projectPath });
      await collected.deferUpdate();
      try {
        const sessionId = await this.sessionManager.startSession({ projectDir: projectPath });
        await interaction.editReply({
          content: `\u2705 Session started for **${projectPath}** (ID: \`${sessionId}\`)`,
          components: []
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error("gsd-start: startSession failed", { error: errMsg, projectPath });
        await interaction.editReply({
          content: `\u274C Failed to start session: ${errMsg}`,
          components: []
        });
      }
    } catch {
      this.logger.info("gsd-start: selection timed out");
      await interaction.editReply({ content: "Selection timed out.", components: [] });
    }
  }
  // ---------------------------------------------------------------------------
  // Private: /gsd-stop handler
  // ---------------------------------------------------------------------------
  async handleGsdStop(interaction) {
    await interaction.deferReply({ ephemeral: true });
    this.logger.info("gsd-stop: listing sessions");
    const allSessions = this.sessionManager.getAllSessions();
    const activeSessions = allSessions.filter(
      (s) => s.status === "running" || s.status === "blocked" || s.status === "starting"
    );
    if (activeSessions.length === 0) {
      await interaction.editReply({ content: "No active sessions." });
      return;
    }
    const truncated = activeSessions.slice(0, 25);
    const select = new StringSelectMenuBuilder().setCustomId("gsd-stop-select").setPlaceholder("Select a session to stop").addOptions(
      truncated.map((s) => ({
        label: `${s.projectName} (${s.status})`.slice(0, 100),
        value: s.sessionId
      }))
    );
    const row = new ActionRowBuilder().addComponents(select);
    const reply = await interaction.editReply({
      content: `Select a session to stop (${truncated.length} active):`,
      components: [row]
    });
    try {
      const collected = await reply.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        time: 6e4,
        filter: (i) => i.user.id === interaction.user.id
      });
      const sessionId = collected.values[0];
      this.logger.info("gsd-stop: session selected", { sessionId });
      try {
        await this.sessionManager.cancelSession(sessionId);
        await collected.update({
          content: `\u2705 Session \`${sessionId}\` stopped.`,
          components: []
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error("gsd-stop: cancelSession failed", { error: errMsg, sessionId });
        await collected.update({
          content: `\u274C Failed to stop session: ${errMsg}`,
          components: []
        });
      }
    } catch {
      this.logger.info("gsd-stop: selection timed out");
      await interaction.editReply({ content: "Selection timed out.", components: [] });
    }
  }
}
export {
  DiscordBot,
  isAuthorized,
  validateDiscordConfig
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvZGFlbW9uL3NyYy9kaXNjb3JkLWJvdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBEaXNjb3JkQm90IFx1MjAxNCB3cmFwcyBkaXNjb3JkLmpzIENsaWVudCB3aXRoIGxvZ2luL2Rlc3Ryb3kgbGlmZWN5Y2xlLCBhdXRoIGd1YXJkLFxuICogYW5kIGludGVncmF0aW9uIHdpdGggdGhlIGRhZW1vbidzIFNlc3Npb25NYW5hZ2VyLlxuICpcbiAqIEF1dGggbW9kZWwgKEQwMTYpOiBzaW5nbGUgRGlzY29yZCB1c2VyIElEIGFsbG93bGlzdC4gQWxsIG5vbi1vd25lciBpbnRlcmFjdGlvbnNcbiAqIHNpbGVudGx5IGlnbm9yZWQ7IHJlamVjdGlvbnMgbG9nZ2VkIGF0IGRlYnVnIGxldmVsICh1c2VySWQgb25seSwgbm8gUElJKS5cbiAqL1xuXG5pbXBvcnQge1xuICBDbGllbnQsXG4gIEdhdGV3YXlJbnRlbnRCaXRzLFxuICBSRVNULFxuICBTdHJpbmdTZWxlY3RNZW51QnVpbGRlcixcbiAgQWN0aW9uUm93QnVpbGRlcixcbiAgQ29tcG9uZW50VHlwZSxcbiAgdHlwZSBJbnRlcmFjdGlvbixcbiAgdHlwZSBHdWlsZCxcbiAgdHlwZSBTdHJpbmdTZWxlY3RNZW51SW50ZXJhY3Rpb24sXG59IGZyb20gJ2Rpc2NvcmQuanMnO1xuaW1wb3J0IHR5cGUgeyBEYWVtb25Db25maWcsIFZlcmJvc2l0eUxldmVsLCBQcm9qZWN0SW5mbyB9IGZyb20gJy4vdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBMb2dnZXIgfSBmcm9tICcuL2xvZ2dlci5qcyc7XG5pbXBvcnQgdHlwZSB7IFNlc3Npb25NYW5hZ2VyIH0gZnJvbSAnLi9zZXNzaW9uLW1hbmFnZXIuanMnO1xuaW1wb3J0IHsgQ2hhbm5lbE1hbmFnZXIgfSBmcm9tICcuL2NoYW5uZWwtbWFuYWdlci5qcyc7XG5pbXBvcnQgeyBidWlsZENvbW1hbmRzLCByZWdpc3Rlckd1aWxkQ29tbWFuZHMsIGZvcm1hdFNlc3Npb25TdGF0dXMgfSBmcm9tICcuL2NvbW1hbmRzLmpzJztcbmltcG9ydCB0eXBlIHsgRXZlbnRCcmlkZ2UgfSBmcm9tICcuL2V2ZW50LWJyaWRnZS5qcyc7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUHVyZSBoZWxwZXJzIFx1MjAxNCBleHBvcnRlZCBmb3IgdGVzdGFiaWxpdHlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIEF1dGggZ3VhcmQ6IHJldHVybnMgdHJ1ZSBpZmYgdXNlcklkIG1hdGNoZXMgdGhlIGNvbmZpZ3VyZWQgb3duZXJfaWQuXG4gKiBSZWplY3RzIGVtcHR5IG9yIG1pc3Npbmcgb3duZXJJZCB0byBmYWlsIGNsb3NlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQXV0aG9yaXplZCh1c2VySWQ6IHN0cmluZywgb3duZXJJZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmICghb3duZXJJZCB8fCAhdXNlcklkKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiB1c2VySWQgPT09IG93bmVySWQ7XG59XG5cbi8qKlxuICogVmFsaWRhdGVzIHRoYXQgYWxsIHJlcXVpcmVkIGRpc2NvcmQgY29uZmlnIGZpZWxkcyBhcmUgcHJlc2VudC5cbiAqIFRocm93cyB3aXRoIGEgZGVzY3JpcHRpdmUgbWVzc2FnZSBvbiB0aGUgZmlyc3QgbWlzc2luZyBmaWVsZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlRGlzY29yZENvbmZpZyhcbiAgY29uZmlnOiBEYWVtb25Db25maWdbJ2Rpc2NvcmQnXSxcbik6IGFzc2VydHMgY29uZmlnIGlzIE5vbk51bGxhYmxlPERhZW1vbkNvbmZpZ1snZGlzY29yZCddPiB7XG4gIGlmICghY29uZmlnKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdEaXNjb3JkIGNvbmZpZyBpcyB1bmRlZmluZWQnKTtcbiAgfVxuICBpZiAoIWNvbmZpZy50b2tlbiB8fCBjb25maWcudG9rZW4udHJpbSgpID09PSAnJykge1xuICAgIHRocm93IG5ldyBFcnJvcignRGlzY29yZCBjb25maWcgbWlzc2luZyByZXF1aXJlZCBmaWVsZDogdG9rZW4nKTtcbiAgfVxuICBpZiAoIWNvbmZpZy5ndWlsZF9pZCB8fCBjb25maWcuZ3VpbGRfaWQudHJpbSgpID09PSAnJykge1xuICAgIHRocm93IG5ldyBFcnJvcignRGlzY29yZCBjb25maWcgbWlzc2luZyByZXF1aXJlZCBmaWVsZDogZ3VpbGRfaWQnKTtcbiAgfVxuICBpZiAoIWNvbmZpZy5vd25lcl9pZCB8fCBjb25maWcub3duZXJfaWQudHJpbSgpID09PSAnJykge1xuICAgIHRocm93IG5ldyBFcnJvcignRGlzY29yZCBjb25maWcgbWlzc2luZyByZXF1aXJlZCBmaWVsZDogb3duZXJfaWQnKTtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIERpc2NvcmRCb3QgY2xhc3Ncbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgaW50ZXJmYWNlIERpc2NvcmRCb3RPcHRpb25zIHtcbiAgY29uZmlnOiBOb25OdWxsYWJsZTxEYWVtb25Db25maWdbJ2Rpc2NvcmQnXT47XG4gIGxvZ2dlcjogTG9nZ2VyO1xuICBzZXNzaW9uTWFuYWdlcjogU2Vzc2lvbk1hbmFnZXI7XG4gIC8qKiBPcHRpb25hbCBmdW5jdGlvbiB0byBzY2FuIGZvciBwcm9qZWN0cyAocGFzc2VkIGZyb20gRGFlbW9uKS4gKi9cbiAgc2NhblByb2plY3RzPzogKCkgPT4gUHJvbWlzZTxQcm9qZWN0SW5mb1tdPjtcbn1cblxuZXhwb3J0IGNsYXNzIERpc2NvcmRCb3Qge1xuICBwcml2YXRlIGNsaWVudDogQ2xpZW50IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgZGVzdHJveWVkID0gZmFsc2U7XG4gIHByaXZhdGUgY2hhbm5lbE1hbmFnZXI6IENoYW5uZWxNYW5hZ2VyIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgZXZlbnRCcmlkZ2U6IEV2ZW50QnJpZGdlIHwgbnVsbCA9IG51bGw7XG5cbiAgcHJpdmF0ZSByZWFkb25seSBjb25maWc6IE5vbk51bGxhYmxlPERhZW1vbkNvbmZpZ1snZGlzY29yZCddPjtcbiAgcHJpdmF0ZSByZWFkb25seSBsb2dnZXI6IExvZ2dlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBzZXNzaW9uTWFuYWdlcjogU2Vzc2lvbk1hbmFnZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgc2NhblByb2plY3RzPzogKCkgPT4gUHJvbWlzZTxQcm9qZWN0SW5mb1tdPjtcblxuICBjb25zdHJ1Y3RvcihvcHRzOiBEaXNjb3JkQm90T3B0aW9ucykge1xuICAgIHRoaXMuY29uZmlnID0gb3B0cy5jb25maWc7XG4gICAgdGhpcy5sb2dnZXIgPSBvcHRzLmxvZ2dlcjtcbiAgICB0aGlzLnNlc3Npb25NYW5hZ2VyID0gb3B0cy5zZXNzaW9uTWFuYWdlcjtcbiAgICB0aGlzLnNjYW5Qcm9qZWN0cyA9IG9wdHMuc2NhblByb2plY3RzO1xuICB9XG5cbiAgLyoqXG4gICAqIENyZWF0ZSB0aGUgZGlzY29yZC5qcyBDbGllbnQsIHJlZ2lzdGVyIGV2ZW50IGhhbmRsZXJzLCBhbmQgbG9nIGluLlxuICAgKiBUaHJvd3Mgb24gbG9naW4gZmFpbHVyZSBcdTIwMTQgdGhlIGNhbGxlciAoRGFlbW9uKSBkZWNpZGVzIHdoZXRoZXIgdG8gY29udGludWUgd2l0aG91dCB0aGUgYm90LlxuICAgKi9cbiAgYXN5bmMgbG9naW4oKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgY2xpZW50ID0gbmV3IENsaWVudCh7XG4gICAgICBpbnRlbnRzOiBbXG4gICAgICAgIEdhdGV3YXlJbnRlbnRCaXRzLkd1aWxkcyxcbiAgICAgICAgR2F0ZXdheUludGVudEJpdHMuR3VpbGRNZXNzYWdlcyxcbiAgICAgICAgR2F0ZXdheUludGVudEJpdHMuTWVzc2FnZUNvbnRlbnQsXG4gICAgICBdLFxuICAgIH0pO1xuXG4gICAgY2xpZW50Lm9uY2UoJ3JlYWR5JywgKHJlYWR5Q2xpZW50KSA9PiB7XG4gICAgICBjb25zdCBndWlsZE5hbWVzID0gcmVhZHlDbGllbnQuZ3VpbGRzLmNhY2hlLm1hcCgoZykgPT4gZy5uYW1lKS5qb2luKCcsICcpO1xuICAgICAgdGhpcy5sb2dnZXIuaW5mbygnYm90IHJlYWR5Jywge1xuICAgICAgICB1c2VybmFtZTogcmVhZHlDbGllbnQudXNlci50YWcsXG4gICAgICAgIGd1aWxkczogZ3VpbGROYW1lcyxcbiAgICAgIH0pO1xuXG4gICAgICAvLyBSZWdpc3RlciBzbGFzaCBjb21tYW5kcyBmb3IgdGhlIGNvbmZpZ3VyZWQgZ3VpbGRcbiAgICAgIGNvbnN0IHJlc3QgPSBuZXcgUkVTVCh7IHZlcnNpb246ICcxMCcgfSkuc2V0VG9rZW4odGhpcy5jb25maWcudG9rZW4pO1xuICAgICAgY29uc3QgY29tbWFuZHMgPSBidWlsZENvbW1hbmRzKCk7XG4gICAgICByZWdpc3Rlckd1aWxkQ29tbWFuZHMoXG4gICAgICAgIHJlc3QsXG4gICAgICAgIHJlYWR5Q2xpZW50LnVzZXIuaWQsXG4gICAgICAgIHRoaXMuY29uZmlnLmd1aWxkX2lkLFxuICAgICAgICBjb21tYW5kcyxcbiAgICAgICAgdGhpcy5sb2dnZXIsXG4gICAgICApLmNhdGNoKChlcnIpID0+IHtcbiAgICAgICAgLy8gU2hvdWxkIG5vdCByZWFjaCBoZXJlIFx1MjAxNCByZWdpc3Rlckd1aWxkQ29tbWFuZHMgY2F0Y2hlcyBpbnRlcm5hbGx5XG4gICAgICAgIHRoaXMubG9nZ2VyLndhcm4oJ3VuZXhwZWN0ZWQgY29tbWFuZCByZWdpc3RyYXRpb24gZXJyb3InLCB7XG4gICAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIGNsaWVudC5vbignaW50ZXJhY3Rpb25DcmVhdGUnLCAoaW50ZXJhY3Rpb246IEludGVyYWN0aW9uKSA9PiB7XG4gICAgICB0aGlzLmhhbmRsZUludGVyYWN0aW9uKGludGVyYWN0aW9uKTtcbiAgICB9KTtcblxuICAgIC8vIERlYnVnOiBsb2cgYWxsIGluY29taW5nIG1lc3NhZ2VzIGF0IGRlYnVnIGxldmVsXG4gICAgY2xpZW50Lm9uKCdtZXNzYWdlQ3JlYXRlJywgKG1zZykgPT4ge1xuICAgICAgdGhpcy5sb2dnZXIuZGVidWcoJ3JhdyBtZXNzYWdlQ3JlYXRlJywge1xuICAgICAgICBhdXRob3JJZDogbXNnLmF1dGhvci5pZCxcbiAgICAgICAgYXV0aG9yQm90OiBtc2cuYXV0aG9yLmJvdCxcbiAgICAgICAgY2hhbm5lbElkOiBtc2cuY2hhbm5lbElkLFxuICAgICAgICBjb250ZW50TGVuZ3RoOiBtc2cuY29udGVudC5sZW5ndGgsXG4gICAgICAgIGhhc0NvbnRlbnQ6IG1zZy5jb250ZW50Lmxlbmd0aCA+IDAsXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIC8vIFJlY29ubmVjdGlvbiBvYnNlcnZhYmlsaXR5IFx1MjAxNCBzdHJ1Y3R1cmVkIGxvZ2dpbmcgZm9yIGFsbCBzaGFyZCBsaWZlY3ljbGUgZXZlbnRzIChSMDI3KVxuICAgIGNsaWVudC5vbignc2hhcmRFcnJvcicsIChlcnJvcikgPT4ge1xuICAgICAgdGhpcy5sb2dnZXIuZXJyb3IoJ2Rpc2NvcmQgc2hhcmQgZXJyb3InLCB7IGVycm9yOiBlcnJvci5tZXNzYWdlIH0pO1xuICAgIH0pO1xuICAgIGNsaWVudC5vbignc2hhcmREaXNjb25uZWN0JywgKGV2ZW50LCBzaGFyZElkKSA9PiB7XG4gICAgICB0aGlzLmxvZ2dlci53YXJuKCdkaXNjb3JkIHNoYXJkIGRpc2Nvbm5lY3RlZCcsIHsgc2hhcmRJZCwgY29kZTogZXZlbnQuY29kZSB9KTtcbiAgICB9KTtcbiAgICBjbGllbnQub24oJ3NoYXJkUmVjb25uZWN0aW5nJywgKHNoYXJkSWQpID0+IHtcbiAgICAgIHRoaXMubG9nZ2VyLmluZm8oJ2Rpc2NvcmQgc2hhcmQgcmVjb25uZWN0aW5nJywgeyBzaGFyZElkIH0pO1xuICAgIH0pO1xuICAgIGNsaWVudC5vbignc2hhcmRSZXN1bWUnLCAoc2hhcmRJZCwgcmVwbGF5ZWRFdmVudHMpID0+IHtcbiAgICAgIHRoaXMubG9nZ2VyLmluZm8oJ2Rpc2NvcmQgc2hhcmQgcmVzdW1lZCcsIHsgc2hhcmRJZCwgcmVwbGF5ZWRFdmVudHMgfSk7XG4gICAgfSk7XG4gICAgY2xpZW50Lm9uKCd3YXJuJywgKG1lc3NhZ2UpID0+IHtcbiAgICAgIHRoaXMubG9nZ2VyLndhcm4oJ2Rpc2NvcmQgd2FybmluZycsIHsgbWVzc2FnZSB9KTtcbiAgICB9KTtcbiAgICBjbGllbnQub24oJ2Vycm9yJywgKGVycm9yKSA9PiB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcignZGlzY29yZCBlcnJvcicsIHsgZXJyb3I6IGVycm9yLm1lc3NhZ2UgfSk7XG4gICAgfSk7XG5cbiAgICAvLyBXYWl0IGZvciBib3RoIGxvZ2luIEFORCB0aGUgJ3JlYWR5JyBldmVudC5cbiAgICAvLyBjbGllbnQubG9naW4oKSByZXNvbHZlcyBvbiBXZWJTb2NrZXQgYXV0aCwgYnV0IHRoZSAncmVhZHknIGV2ZW50IGZpcmVzXG4gICAgLy8gYXN5bmNocm9ub3VzbHkgbGF0ZXIuIFdlIG5lZWQgJ3JlYWR5JyBiZWZvcmUgZ2V0Q2hhbm5lbE1hbmFnZXIoKSB3b3Jrcy5cbiAgICBsZXQgcmVhZHlUaW1lb3V0OiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcbiAgICBsZXQgcmVhZHlTZXR0bGVkID0gZmFsc2U7XG4gICAgY29uc3QgcmVhZHlQcm9taXNlID0gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgcmVhZHlUaW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIGlmICghcmVhZHlTZXR0bGVkKSB7IHJlYWR5U2V0dGxlZCA9IHRydWU7IHJlamVjdChuZXcgRXJyb3IoJ0Rpc2NvcmQgcmVhZHkgdGltZW91dCAoMzBzKScpKTsgfVxuICAgICAgfSwgMzBfMDAwKTtcbiAgICAgIGNvbnN0IGNsZWFudXAgPSAoKSA9PiB7XG4gICAgICAgIGlmIChyZWFkeVRpbWVvdXQpIHsgY2xlYXJUaW1lb3V0KHJlYWR5VGltZW91dCk7IHJlYWR5VGltZW91dCA9IHVuZGVmaW5lZDsgfVxuICAgICAgfTtcbiAgICAgIGNsaWVudC5vbmNlKCdyZWFkeScsICgpID0+IHtcbiAgICAgICAgY2xlYW51cCgpO1xuICAgICAgICBpZiAoIXJlYWR5U2V0dGxlZCkgeyByZWFkeVNldHRsZWQgPSB0cnVlOyByZXNvbHZlKCk7IH1cbiAgICAgIH0pO1xuICAgICAgY2xpZW50Lm9uY2UoJ2Vycm9yJywgKGVycikgPT4ge1xuICAgICAgICBjbGVhbnVwKCk7XG4gICAgICAgIGlmICghcmVhZHlTZXR0bGVkKSB7IHJlYWR5U2V0dGxlZCA9IHRydWU7IHJlamVjdChlcnIpOyB9XG4gICAgICB9KTtcbiAgICAgIC8vIHNoYXJkRGlzY29ubmVjdCBmaXJlcyBvbiBmYXRhbCBnYXRld2F5IGVycm9ycyAoZS5nLiA0MDE0IGRpc2FsbG93ZWQgaW50ZW50cylcbiAgICAgIGNsaWVudC5vbmNlKCdzaGFyZERpc2Nvbm5lY3QnLCAoZXZlbnQpID0+IHtcbiAgICAgICAgY2xlYW51cCgpO1xuICAgICAgICBpZiAoIXJlYWR5U2V0dGxlZCkgeyByZWFkeVNldHRsZWQgPSB0cnVlOyByZWplY3QobmV3IEVycm9yKGBTaGFyZCBkaXNjb25uZWN0ZWQ6ICR7ZXZlbnQuY29kZX1gKSk7IH1cbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGNsaWVudC5sb2dpbih0aGlzLmNvbmZpZy50b2tlbik7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAvLyBMb2dpbiBpdHNlbGYgZmFpbGVkIFx1MjAxNCBjbGVhbiB1cCB0aGUgcmVhZHkgdGltZXIgc28gaXQgZG9lc24ndCBmaXJlIGFzIHVuaGFuZGxlZCByZWplY3Rpb25cbiAgICAgIGlmIChyZWFkeVRpbWVvdXQpIHsgY2xlYXJUaW1lb3V0KHJlYWR5VGltZW91dCk7IHJlYWR5VGltZW91dCA9IHVuZGVmaW5lZDsgfVxuICAgICAgcmVhZHlTZXR0bGVkID0gdHJ1ZTtcbiAgICAgIHRocm93IGVycjtcbiAgICB9XG4gICAgYXdhaXQgcmVhZHlQcm9taXNlO1xuICAgIHRoaXMuY2xpZW50ID0gY2xpZW50O1xuICAgIHRoaXMuZGVzdHJveWVkID0gZmFsc2U7XG4gIH1cblxuICAvKipcbiAgICogRGVzdHJveSB0aGUgZGlzY29yZC5qcyBDbGllbnQuIElkZW1wb3RlbnQgXHUyMDE0IHNhZmUgdG8gY2FsbCBtdWx0aXBsZSB0aW1lc1xuICAgKiBvciBiZWZvcmUgbG9naW4oKS5cbiAgICovXG4gIGFzeW5jIGRlc3Ryb3koKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMuZGVzdHJveWVkIHx8ICF0aGlzLmNsaWVudCkge1xuICAgICAgdGhpcy5kZXN0cm95ZWQgPSB0cnVlO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICAvLyBkaXNjb3JkLmpzIGRlc3Ryb3koKSBpcyBzeW5jaHJvbm91cyBidXQgbWF5IHRocm93IG9uIGRvdWJsZS1kZXN0cm95XG4gICAgICB0aGlzLmNsaWVudC5kZXN0cm95KCk7XG4gICAgICB0aGlzLmxvZ2dlci5pbmZvKCdib3QgZGVzdHJveWVkJyk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAvLyBTd2FsbG93IGNsZWFudXAgZXJyb3JzIFx1MjAxNCBzaHV0ZG93biBtdXN0IG5vdCBmYWlsXG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZygnYm90IGRlc3Ryb3kgZXJyb3IgKHN3YWxsb3dlZCknLCB7XG4gICAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICB9KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdGhpcy5jbGllbnQgPSBudWxsO1xuICAgICAgdGhpcy5kZXN0cm95ZWQgPSB0cnVlO1xuICAgIH1cbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBQdWJsaWMgYWNjZXNzb3JzXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gIC8qKlxuICAgKiBMYXppbHkgY3JlYXRlIGEgQ2hhbm5lbE1hbmFnZXIgZnJvbSB0aGUgY29uZmlndXJlZCBndWlsZC5cbiAgICogUmV0dXJucyBudWxsIGlmIHRoZSBjbGllbnQgaXNuJ3QgcmVhZHkgb3IgdGhlIGd1aWxkIGlzbid0IGZvdW5kLlxuICAgKi9cbiAgZ2V0Q2hhbm5lbE1hbmFnZXIoKTogQ2hhbm5lbE1hbmFnZXIgfCBudWxsIHtcbiAgICBpZiAodGhpcy5jaGFubmVsTWFuYWdlcikgcmV0dXJuIHRoaXMuY2hhbm5lbE1hbmFnZXI7XG4gICAgaWYgKCF0aGlzLmNsaWVudD8uaXNSZWFkeSgpKSByZXR1cm4gbnVsbDtcblxuICAgIGNvbnN0IGd1aWxkID0gdGhpcy5jbGllbnQuZ3VpbGRzLmNhY2hlLmdldCh0aGlzLmNvbmZpZy5ndWlsZF9pZCk7XG4gICAgaWYgKCFndWlsZCkge1xuICAgICAgdGhpcy5sb2dnZXIud2FybignZ3VpbGQgbm90IGZvdW5kIGZvciBjaGFubmVsIG1hbmFnZXInLCB7IGd1aWxkSWQ6IHRoaXMuY29uZmlnLmd1aWxkX2lkIH0pO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgdGhpcy5jaGFubmVsTWFuYWdlciA9IG5ldyBDaGFubmVsTWFuYWdlcih7IGd1aWxkLCBsb2dnZXI6IHRoaXMubG9nZ2VyIH0pO1xuICAgIHJldHVybiB0aGlzLmNoYW5uZWxNYW5hZ2VyO1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybiB0aGUgdW5kZXJseWluZyBkaXNjb3JkLmpzIENsaWVudCwgb3IgbnVsbCBpZiBub3QgbG9nZ2VkIGluLlxuICAgKiBVc2VkIGJ5IERhZW1vbiB0byBwYXNzIHRvIEV2ZW50QnJpZGdlIGFzIEJyaWRnZUNsaWVudC5cbiAgICovXG4gIGdldENsaWVudCgpOiBDbGllbnQgfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5jbGllbnQ7XG4gIH1cblxuICAvKipcbiAgICogU2V0IHRoZSBFdmVudEJyaWRnZSByZWZlcmVuY2Ugc28gdGhlIGJvdCBjYW4gZGlzcGF0Y2ggL2dzZC12ZXJib3NlIGNvbW1hbmRzLlxuICAgKiBDYWxsZWQgYnkgRGFlbW9uIGFmdGVyIGNyZWF0aW5nIHRoZSBFdmVudEJyaWRnZS5cbiAgICovXG4gIHNldEV2ZW50QnJpZGdlKGJyaWRnZTogRXZlbnRCcmlkZ2UpOiB2b2lkIHtcbiAgICB0aGlzLmV2ZW50QnJpZGdlID0gYnJpZGdlO1xuICB9XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIFByaXZhdGU6IGludGVyYWN0aW9uIGhhbmRsaW5nXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4gIHByaXZhdGUgaGFuZGxlSW50ZXJhY3Rpb24oaW50ZXJhY3Rpb246IEludGVyYWN0aW9uKTogdm9pZCB7XG4gICAgaWYgKCFpc0F1dGhvcml6ZWQoaW50ZXJhY3Rpb24udXNlci5pZCwgdGhpcy5jb25maWcub3duZXJfaWQpKSB7XG4gICAgICB0aGlzLmxvZ2dlci5kZWJ1ZygnYXV0aCByZWplY3RlZCcsIHsgdXNlcklkOiBpbnRlcmFjdGlvbi51c2VyLmlkIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIE9ubHkgaGFuZGxlIGNoYXQgaW5wdXQgKHNsYXNoKSBjb21tYW5kc1xuICAgIGlmICghaW50ZXJhY3Rpb24uaXNDaGF0SW5wdXRDb21tYW5kKCkpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmRlYnVnKCdub24tY29tbWFuZCBpbnRlcmFjdGlvbicsIHtcbiAgICAgICAgdHlwZTogaW50ZXJhY3Rpb24udHlwZSxcbiAgICAgICAgdXNlcklkOiBpbnRlcmFjdGlvbi51c2VyLmlkLFxuICAgICAgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgeyBjb21tYW5kTmFtZSB9ID0gaW50ZXJhY3Rpb247XG4gICAgdGhpcy5sb2dnZXIuaW5mbygnY29tbWFuZCBoYW5kbGVkJywgeyBjb21tYW5kTmFtZSwgdXNlcklkOiBpbnRlcmFjdGlvbi51c2VyLmlkIH0pO1xuXG4gICAgc3dpdGNoIChjb21tYW5kTmFtZSkge1xuICAgICAgY2FzZSAnZ3NkLXN0YXR1cyc6IHtcbiAgICAgICAgY29uc3Qgc2Vzc2lvbnMgPSB0aGlzLnNlc3Npb25NYW5hZ2VyLmdldEFsbFNlc3Npb25zKCk7XG4gICAgICAgIGNvbnN0IGNvbnRlbnQgPSBmb3JtYXRTZXNzaW9uU3RhdHVzKHNlc3Npb25zKTtcbiAgICAgICAgaW50ZXJhY3Rpb24ucmVwbHkoeyBjb250ZW50LCBlcGhlbWVyYWw6IHRydWUgfSkuY2F0Y2goKGVycikgPT4ge1xuICAgICAgICAgIHRoaXMubG9nZ2VyLndhcm4oJ2dzZC1zdGF0dXMgcmVwbHkgZmFpbGVkJywge1xuICAgICAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY2FzZSAnZ3NkLXN0YXJ0JzpcbiAgICAgICAgdGhpcy5oYW5kbGVHc2RTdGFydChpbnRlcmFjdGlvbikuY2F0Y2goKGVycikgPT4ge1xuICAgICAgICAgIHRoaXMubG9nZ2VyLndhcm4oJ2dzZC1zdGFydCBoYW5kbGVyIGVycm9yJywge1xuICAgICAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnZ3NkLXN0b3AnOlxuICAgICAgICB0aGlzLmhhbmRsZUdzZFN0b3AoaW50ZXJhY3Rpb24pLmNhdGNoKChlcnIpID0+IHtcbiAgICAgICAgICB0aGlzLmxvZ2dlci53YXJuKCdnc2Qtc3RvcCBoYW5kbGVyIGVycm9yJywge1xuICAgICAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnZ3NkLXZlcmJvc2UnOiB7XG4gICAgICAgIGlmICghdGhpcy5ldmVudEJyaWRnZSkge1xuICAgICAgICAgIGludGVyYWN0aW9uLnJlcGx5KHsgY29udGVudDogJ0V2ZW50IGJyaWRnZSBub3QgYXZhaWxhYmxlLicsIGVwaGVtZXJhbDogdHJ1ZSB9KS5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmxvZ2dlci53YXJuKCdnc2QtdmVyYm9zZSByZXBseSBmYWlsZWQnLCB7XG4gICAgICAgICAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBsZXZlbCA9IChpbnRlcmFjdGlvbi5vcHRpb25zLmdldFN0cmluZygnbGV2ZWwnKSA/PyAnZGVmYXVsdCcpIGFzIFZlcmJvc2l0eUxldmVsO1xuICAgICAgICBjb25zdCBjaGFubmVsSWQgPSBpbnRlcmFjdGlvbi5jaGFubmVsSWQ7XG4gICAgICAgIHRoaXMuZXZlbnRCcmlkZ2UuZ2V0VmVyYm9zaXR5TWFuYWdlcigpLnNldExldmVsKGNoYW5uZWxJZCwgbGV2ZWwpO1xuICAgICAgICBpbnRlcmFjdGlvbi5yZXBseSh7IGNvbnRlbnQ6IGBWZXJib3NpdHkgc2V0IHRvICoqJHtsZXZlbH0qKiBmb3IgdGhpcyBjaGFubmVsLmAsIGVwaGVtZXJhbDogdHJ1ZSB9KS5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICAgICAgdGhpcy5sb2dnZXIud2FybignZ3NkLXZlcmJvc2UgcmVwbHkgZmFpbGVkJywge1xuICAgICAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgaW50ZXJhY3Rpb24ucmVwbHkoeyBjb250ZW50OiAnVW5rbm93biBjb21tYW5kJywgZXBoZW1lcmFsOiB0cnVlIH0pLmNhdGNoKChlcnIpID0+IHtcbiAgICAgICAgICB0aGlzLmxvZ2dlci53YXJuKCd1bmtub3duIGNvbW1hbmQgcmVwbHkgZmFpbGVkJywge1xuICAgICAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBQcml2YXRlOiAvZ3NkLXN0YXJ0IGhhbmRsZXJcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgcHJpdmF0ZSBhc3luYyBoYW5kbGVHc2RTdGFydChpbnRlcmFjdGlvbjogaW1wb3J0KCdkaXNjb3JkLmpzJykuQ2hhdElucHV0Q29tbWFuZEludGVyYWN0aW9uKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgaW50ZXJhY3Rpb24uZGVmZXJSZXBseSh7IGVwaGVtZXJhbDogdHJ1ZSB9KTtcbiAgICB0aGlzLmxvZ2dlci5pbmZvKCdnc2Qtc3RhcnQ6IHNjYW5uaW5nIHByb2plY3RzJyk7XG5cbiAgICBpZiAoIXRoaXMuc2NhblByb2plY3RzKSB7XG4gICAgICBhd2FpdCBpbnRlcmFjdGlvbi5lZGl0UmVwbHkoeyBjb250ZW50OiAnUHJvamVjdCBzY2FubmluZyBub3QgYXZhaWxhYmxlLicgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgbGV0IHByb2plY3RzOiBQcm9qZWN0SW5mb1tdO1xuICAgIHRyeSB7XG4gICAgICBwcm9qZWN0cyA9IGF3YWl0IHRoaXMuc2NhblByb2plY3RzKCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcignZ3NkLXN0YXJ0OiBzY2FuIGZhaWxlZCcsIHtcbiAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgaW50ZXJhY3Rpb24uZWRpdFJlcGx5KHsgY29udGVudDogJ0ZhaWxlZCB0byBzY2FuIGZvciBwcm9qZWN0cy4nIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChwcm9qZWN0cy5sZW5ndGggPT09IDApIHtcbiAgICAgIGF3YWl0IGludGVyYWN0aW9uLmVkaXRSZXBseSh7IGNvbnRlbnQ6ICdObyBwcm9qZWN0cyBmb3VuZC4nIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIERpc2NvcmQgc2VsZWN0IG1lbnVzIHN1cHBvcnQgbWF4IDI1IG9wdGlvbnNcbiAgICBjb25zdCB0cnVuY2F0ZWQgPSBwcm9qZWN0cy5zbGljZSgwLCAyNSk7XG4gICAgY29uc3Qgc2VsZWN0ID0gbmV3IFN0cmluZ1NlbGVjdE1lbnVCdWlsZGVyKClcbiAgICAgIC5zZXRDdXN0b21JZCgnZ3NkLXN0YXJ0LXNlbGVjdCcpXG4gICAgICAuc2V0UGxhY2Vob2xkZXIoJ1NlbGVjdCBhIHByb2plY3QgdG8gc3RhcnQnKVxuICAgICAgLmFkZE9wdGlvbnMoXG4gICAgICAgIHRydW5jYXRlZC5tYXAoKHApID0+ICh7XG4gICAgICAgICAgbGFiZWw6IHAubmFtZS5zbGljZSgwLCAxMDApLCAvLyBEaXNjb3JkIGxhYmVsIG1heCAxMDAgY2hhcnNcbiAgICAgICAgICB2YWx1ZTogcC5wYXRoLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBwLm1hcmtlcnMuam9pbignLCAnKS5zbGljZSgwLCAxMDApIHx8IHVuZGVmaW5lZCxcbiAgICAgICAgfSkpLFxuICAgICAgKTtcblxuICAgIGNvbnN0IHJvdyA9IG5ldyBBY3Rpb25Sb3dCdWlsZGVyPFN0cmluZ1NlbGVjdE1lbnVCdWlsZGVyPigpLmFkZENvbXBvbmVudHMoc2VsZWN0KTtcbiAgICBjb25zdCByZXBseSA9IGF3YWl0IGludGVyYWN0aW9uLmVkaXRSZXBseSh7XG4gICAgICBjb250ZW50OiBgU2VsZWN0IGEgcHJvamVjdCB0byBzdGFydCAoJHt0cnVuY2F0ZWQubGVuZ3RofSR7cHJvamVjdHMubGVuZ3RoID4gMjUgPyBgIG9mICR7cHJvamVjdHMubGVuZ3RofWAgOiAnJ30gcHJvamVjdHMpOmAsXG4gICAgICBjb21wb25lbnRzOiBbcm93XSxcbiAgICB9KTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBjb2xsZWN0ZWQgPSBhd2FpdCByZXBseS5hd2FpdE1lc3NhZ2VDb21wb25lbnQoe1xuICAgICAgICBjb21wb25lbnRUeXBlOiBDb21wb25lbnRUeXBlLlN0cmluZ1NlbGVjdCxcbiAgICAgICAgdGltZTogNjBfMDAwLFxuICAgICAgICBmaWx0ZXI6IChpKSA9PiBpLnVzZXIuaWQgPT09IGludGVyYWN0aW9uLnVzZXIuaWQsXG4gICAgICB9KSBhcyBTdHJpbmdTZWxlY3RNZW51SW50ZXJhY3Rpb247XG5cbiAgICAgIGNvbnN0IHByb2plY3RQYXRoID0gY29sbGVjdGVkLnZhbHVlc1swXTtcbiAgICAgIHRoaXMubG9nZ2VyLmluZm8oJ2dzZC1zdGFydDogcHJvamVjdCBzZWxlY3RlZCcsIHsgcHJvamVjdFBhdGggfSk7XG5cbiAgICAgIC8vIERlZmVyIHRoZSB1cGRhdGUgaW1tZWRpYXRlbHkgXHUyMDE0IHN0YXJ0U2Vzc2lvbiBjYW4gdGFrZSAxMC0zMHMgdG8gc3Bhd24gdGhlIEdTRCBwcm9jZXNzLFxuICAgICAgLy8gYW5kIERpc2NvcmQncyBjb21wb25lbnQgaW50ZXJhY3Rpb24gdG9rZW4gZXhwaXJlcyBpbiAzIHNlY29uZHMgd2l0aG91dCBkZWZlcnJhbC5cbiAgICAgIGF3YWl0IGNvbGxlY3RlZC5kZWZlclVwZGF0ZSgpO1xuXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBzZXNzaW9uSWQgPSBhd2FpdCB0aGlzLnNlc3Npb25NYW5hZ2VyLnN0YXJ0U2Vzc2lvbih7IHByb2plY3REaXI6IHByb2plY3RQYXRoIH0pO1xuICAgICAgICBhd2FpdCBpbnRlcmFjdGlvbi5lZGl0UmVwbHkoe1xuICAgICAgICAgIGNvbnRlbnQ6IGBcdTI3MDUgU2Vzc2lvbiBzdGFydGVkIGZvciAqKiR7cHJvamVjdFBhdGh9KiogKElEOiBcXGAke3Nlc3Npb25JZH1cXGApYCxcbiAgICAgICAgICBjb21wb25lbnRzOiBbXSxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc3QgZXJyTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcignZ3NkLXN0YXJ0OiBzdGFydFNlc3Npb24gZmFpbGVkJywgeyBlcnJvcjogZXJyTXNnLCBwcm9qZWN0UGF0aCB9KTtcbiAgICAgICAgYXdhaXQgaW50ZXJhY3Rpb24uZWRpdFJlcGx5KHtcbiAgICAgICAgICBjb250ZW50OiBgXHUyNzRDIEZhaWxlZCB0byBzdGFydCBzZXNzaW9uOiAke2Vyck1zZ31gLFxuICAgICAgICAgIGNvbXBvbmVudHM6IFtdLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFRpbWVvdXQgb3Igb3RoZXIgY29sbGVjdG9yIGVycm9yXG4gICAgICB0aGlzLmxvZ2dlci5pbmZvKCdnc2Qtc3RhcnQ6IHNlbGVjdGlvbiB0aW1lZCBvdXQnKTtcbiAgICAgIGF3YWl0IGludGVyYWN0aW9uLmVkaXRSZXBseSh7IGNvbnRlbnQ6ICdTZWxlY3Rpb24gdGltZWQgb3V0LicsIGNvbXBvbmVudHM6IFtdIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBQcml2YXRlOiAvZ3NkLXN0b3AgaGFuZGxlclxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuICBwcml2YXRlIGFzeW5jIGhhbmRsZUdzZFN0b3AoaW50ZXJhY3Rpb246IGltcG9ydCgnZGlzY29yZC5qcycpLkNoYXRJbnB1dENvbW1hbmRJbnRlcmFjdGlvbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IGludGVyYWN0aW9uLmRlZmVyUmVwbHkoeyBlcGhlbWVyYWw6IHRydWUgfSk7XG4gICAgdGhpcy5sb2dnZXIuaW5mbygnZ3NkLXN0b3A6IGxpc3Rpbmcgc2Vzc2lvbnMnKTtcblxuICAgIGNvbnN0IGFsbFNlc3Npb25zID0gdGhpcy5zZXNzaW9uTWFuYWdlci5nZXRBbGxTZXNzaW9ucygpO1xuICAgIGNvbnN0IGFjdGl2ZVNlc3Npb25zID0gYWxsU2Vzc2lvbnMuZmlsdGVyKFxuICAgICAgKHMpID0+IHMuc3RhdHVzID09PSAncnVubmluZycgfHwgcy5zdGF0dXMgPT09ICdibG9ja2VkJyB8fCBzLnN0YXR1cyA9PT0gJ3N0YXJ0aW5nJyxcbiAgICApO1xuXG4gICAgaWYgKGFjdGl2ZVNlc3Npb25zLmxlbmd0aCA9PT0gMCkge1xuICAgICAgYXdhaXQgaW50ZXJhY3Rpb24uZWRpdFJlcGx5KHsgY29udGVudDogJ05vIGFjdGl2ZSBzZXNzaW9ucy4nIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIERpc2NvcmQgc2VsZWN0IG1lbnVzIHN1cHBvcnQgbWF4IDI1IG9wdGlvbnNcbiAgICBjb25zdCB0cnVuY2F0ZWQgPSBhY3RpdmVTZXNzaW9ucy5zbGljZSgwLCAyNSk7XG4gICAgY29uc3Qgc2VsZWN0ID0gbmV3IFN0cmluZ1NlbGVjdE1lbnVCdWlsZGVyKClcbiAgICAgIC5zZXRDdXN0b21JZCgnZ3NkLXN0b3Atc2VsZWN0JylcbiAgICAgIC5zZXRQbGFjZWhvbGRlcignU2VsZWN0IGEgc2Vzc2lvbiB0byBzdG9wJylcbiAgICAgIC5hZGRPcHRpb25zKFxuICAgICAgICB0cnVuY2F0ZWQubWFwKChzKSA9PiAoe1xuICAgICAgICAgIGxhYmVsOiBgJHtzLnByb2plY3ROYW1lfSAoJHtzLnN0YXR1c30pYC5zbGljZSgwLCAxMDApLFxuICAgICAgICAgIHZhbHVlOiBzLnNlc3Npb25JZCxcbiAgICAgICAgfSkpLFxuICAgICAgKTtcblxuICAgIGNvbnN0IHJvdyA9IG5ldyBBY3Rpb25Sb3dCdWlsZGVyPFN0cmluZ1NlbGVjdE1lbnVCdWlsZGVyPigpLmFkZENvbXBvbmVudHMoc2VsZWN0KTtcbiAgICBjb25zdCByZXBseSA9IGF3YWl0IGludGVyYWN0aW9uLmVkaXRSZXBseSh7XG4gICAgICBjb250ZW50OiBgU2VsZWN0IGEgc2Vzc2lvbiB0byBzdG9wICgke3RydW5jYXRlZC5sZW5ndGh9IGFjdGl2ZSk6YCxcbiAgICAgIGNvbXBvbmVudHM6IFtyb3ddLFxuICAgIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNvbGxlY3RlZCA9IGF3YWl0IHJlcGx5LmF3YWl0TWVzc2FnZUNvbXBvbmVudCh7XG4gICAgICAgIGNvbXBvbmVudFR5cGU6IENvbXBvbmVudFR5cGUuU3RyaW5nU2VsZWN0LFxuICAgICAgICB0aW1lOiA2MF8wMDAsXG4gICAgICAgIGZpbHRlcjogKGkpID0+IGkudXNlci5pZCA9PT0gaW50ZXJhY3Rpb24udXNlci5pZCxcbiAgICAgIH0pIGFzIFN0cmluZ1NlbGVjdE1lbnVJbnRlcmFjdGlvbjtcblxuICAgICAgY29uc3Qgc2Vzc2lvbklkID0gY29sbGVjdGVkLnZhbHVlc1swXTtcbiAgICAgIHRoaXMubG9nZ2VyLmluZm8oJ2dzZC1zdG9wOiBzZXNzaW9uIHNlbGVjdGVkJywgeyBzZXNzaW9uSWQgfSk7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHRoaXMuc2Vzc2lvbk1hbmFnZXIuY2FuY2VsU2Vzc2lvbihzZXNzaW9uSWQpO1xuICAgICAgICBhd2FpdCBjb2xsZWN0ZWQudXBkYXRlKHtcbiAgICAgICAgICBjb250ZW50OiBgXHUyNzA1IFNlc3Npb24gXFxgJHtzZXNzaW9uSWR9XFxgIHN0b3BwZWQuYCxcbiAgICAgICAgICBjb21wb25lbnRzOiBbXSxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc3QgZXJyTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcignZ3NkLXN0b3A6IGNhbmNlbFNlc3Npb24gZmFpbGVkJywgeyBlcnJvcjogZXJyTXNnLCBzZXNzaW9uSWQgfSk7XG4gICAgICAgIGF3YWl0IGNvbGxlY3RlZC51cGRhdGUoe1xuICAgICAgICAgIGNvbnRlbnQ6IGBcdTI3NEMgRmFpbGVkIHRvIHN0b3Agc2Vzc2lvbjogJHtlcnJNc2d9YCxcbiAgICAgICAgICBjb21wb25lbnRzOiBbXSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBUaW1lb3V0IG9yIG90aGVyIGNvbGxlY3RvciBlcnJvclxuICAgICAgdGhpcy5sb2dnZXIuaW5mbygnZ3NkLXN0b3A6IHNlbGVjdGlvbiB0aW1lZCBvdXQnKTtcbiAgICAgIGF3YWl0IGludGVyYWN0aW9uLmVkaXRSZXBseSh7IGNvbnRlbnQ6ICdTZWxlY3Rpb24gdGltZWQgb3V0LicsIGNvbXBvbmVudHM6IFtdIH0pO1xuICAgIH1cbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBUUE7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUlLO0FBSVAsU0FBUyxzQkFBc0I7QUFDL0IsU0FBUyxlQUFlLHVCQUF1QiwyQkFBMkI7QUFXbkUsU0FBUyxhQUFhLFFBQWdCLFNBQTBCO0FBQ3JFLE1BQUksQ0FBQyxXQUFXLENBQUMsT0FBUSxRQUFPO0FBQ2hDLFNBQU8sV0FBVztBQUNwQjtBQU1PLFNBQVMsc0JBQ2QsUUFDd0Q7QUFDeEQsTUFBSSxDQUFDLFFBQVE7QUFDWCxVQUFNLElBQUksTUFBTSw2QkFBNkI7QUFBQSxFQUMvQztBQUNBLE1BQUksQ0FBQyxPQUFPLFNBQVMsT0FBTyxNQUFNLEtBQUssTUFBTSxJQUFJO0FBQy9DLFVBQU0sSUFBSSxNQUFNLDhDQUE4QztBQUFBLEVBQ2hFO0FBQ0EsTUFBSSxDQUFDLE9BQU8sWUFBWSxPQUFPLFNBQVMsS0FBSyxNQUFNLElBQUk7QUFDckQsVUFBTSxJQUFJ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
