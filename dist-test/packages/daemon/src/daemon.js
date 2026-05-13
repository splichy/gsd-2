import { SessionManager } from "./session-manager.js";
import { scanForProjects } from "./project-scanner.js";
import { DiscordBot, validateDiscordConfig } from "./discord-bot.js";
import { EventBridge } from "./event-bridge.js";
import { Orchestrator } from "./orchestrator.js";
class Daemon {
  constructor(config, logger, healthIntervalMs = 3e5) {
    this.config = config;
    this.logger = logger;
    this.healthIntervalMs = healthIntervalMs;
    this.onSigterm = () => void this.shutdown();
    this.onSigint = () => void this.shutdown();
  }
  shuttingDown = false;
  keepaliveTimer;
  healthTimer;
  onSigterm;
  onSigint;
  sessionManager;
  discordBot;
  eventBridge;
  orchestrator;
  /** Start the daemon: log startup info, register signal handlers, start keepalive. */
  async start() {
    this.sessionManager = new SessionManager(this.logger);
    this.logger.info("daemon started", {
      log_level: this.config.log.level,
      scan_roots: this.config.projects.scan_roots.length,
      discord_configured: !!this.config.discord
    });
    process.on("SIGTERM", this.onSigterm);
    process.on("SIGINT", this.onSigint);
    this.keepaliveTimer = setInterval(() => {
    }, 6e4);
    if (this.config.discord?.token) {
      try {
        validateDiscordConfig(this.config.discord);
        this.discordBot = new DiscordBot({
          config: this.config.discord,
          logger: this.logger,
          sessionManager: this.sessionManager,
          scanProjects: () => this.scanProjects()
        });
        await this.discordBot.login();
        const channelManager = this.discordBot.getChannelManager();
        const client = this.discordBot.getClient();
        if (channelManager && client) {
          this.eventBridge = new EventBridge({
            sessionManager: this.sessionManager,
            channelManager,
            client,
            config: this.config,
            logger: this.logger,
            ownerId: this.config.discord.owner_id
          });
          this.discordBot.setEventBridge(this.eventBridge);
          this.eventBridge.start();
          this.logger.info("event bridge wired");
          if (this.config.discord.control_channel_id) {
            this.orchestrator = new Orchestrator({
              sessionManager: this.sessionManager,
              channelManager,
              scanProjects: () => this.scanProjects(),
              config: {
                model: this.config.discord.orchestrator?.model ?? "claude-haiku-4-5-20251001",
                max_tokens: this.config.discord.orchestrator?.max_tokens ?? 1024,
                control_channel_id: this.config.discord.control_channel_id
              },
              logger: this.logger,
              ownerId: this.config.discord.owner_id
            });
            client.on("messageCreate", (message) => {
              void this.orchestrator.handleMessage(message);
            });
            this.logger.info("orchestrator wired", {
              control_channel_id: this.config.discord.control_channel_id
            });
          }
        } else {
          this.logger.warn("event bridge skipped \u2014 channel manager or client not available");
        }
      } catch (err) {
        this.logger.error("discord bot login failed", {
          error: err instanceof Error ? err.message : String(err)
        });
        this.discordBot = void 0;
      }
    }
    const startTime = Date.now();
    this.healthTimer = setInterval(() => {
      const sessions = this.sessionManager?.getAllSessions() ?? [];
      const activeSessions = sessions.filter(
        (s) => s.status === "running" || s.status === "blocked"
      ).length;
      this.logger.info("health", {
        uptime_s: Math.floor((Date.now() - startTime) / 1e3),
        active_sessions: activeSessions,
        discord_connected: !!this.discordBot?.getClient()?.isReady(),
        memory_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024)
      });
    }, this.healthIntervalMs);
  }
  /** Scan configured project roots for project directories. */
  async scanProjects() {
    return scanForProjects(this.config.projects.scan_roots);
  }
  /** Accessor for the session manager (available after start()). */
  getSessionManager() {
    if (!this.sessionManager) {
      throw new Error("Daemon not started \u2014 call start() before accessing the session manager");
    }
    return this.sessionManager;
  }
  /** Accessor for the event bridge (available after start() with Discord configured). */
  getEventBridge() {
    return this.eventBridge;
  }
  /** Accessor for the orchestrator (available after start() with control_channel_id configured). */
  getOrchestrator() {
    return this.orchestrator;
  }
  /** Idempotent shutdown: log, cleanup sessions, close logger, exit. */
  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.logger.info("daemon shutting down");
    process.removeListener("SIGTERM", this.onSigterm);
    process.removeListener("SIGINT", this.onSigint);
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = void 0;
    }
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = void 0;
    }
    if (this.orchestrator) {
      this.orchestrator.stop();
      this.orchestrator = void 0;
    }
    if (this.eventBridge) {
      await this.eventBridge.stop();
      this.eventBridge = void 0;
    }
    if (this.discordBot) {
      await this.discordBot.destroy();
      this.discordBot = void 0;
    }
    if (this.sessionManager) {
      await this.sessionManager.cleanup();
    }
    await this.logger.close();
    process.exit(0);
  }
}
export {
  Daemon
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvZGFlbW9uL3NyYy9kYWVtb24udHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0eXBlIHsgRGFlbW9uQ29uZmlnLCBQcm9qZWN0SW5mbyB9IGZyb20gJy4vdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBMb2dnZXIgfSBmcm9tICcuL2xvZ2dlci5qcyc7XG5pbXBvcnQgeyBTZXNzaW9uTWFuYWdlciB9IGZyb20gJy4vc2Vzc2lvbi1tYW5hZ2VyLmpzJztcbmltcG9ydCB7IHNjYW5Gb3JQcm9qZWN0cyB9IGZyb20gJy4vcHJvamVjdC1zY2FubmVyLmpzJztcbmltcG9ydCB7IERpc2NvcmRCb3QsIHZhbGlkYXRlRGlzY29yZENvbmZpZyB9IGZyb20gJy4vZGlzY29yZC1ib3QuanMnO1xuaW1wb3J0IHsgRXZlbnRCcmlkZ2UgfSBmcm9tICcuL2V2ZW50LWJyaWRnZS5qcyc7XG5pbXBvcnQgeyBPcmNoZXN0cmF0b3IgfSBmcm9tICcuL29yY2hlc3RyYXRvci5qcyc7XG5cbi8qKlxuICogQ29yZSBkYWVtb24gY2xhc3MgXHUyMDE0IHRpZXMgY29uZmlnICsgbG9nZ2VyIHRvZ2V0aGVyIHdpdGggbGlmZWN5Y2xlIG1hbmFnZW1lbnQuXG4gKiBSZWdpc3RlcnMgU0lHVEVSTS9TSUdJTlQgaGFuZGxlcnMgZm9yIGNsZWFuIHNodXRkb3duLlxuICovXG5leHBvcnQgY2xhc3MgRGFlbW9uIHtcbiAgcHJpdmF0ZSBzaHV0dGluZ0Rvd24gPSBmYWxzZTtcbiAgcHJpdmF0ZSBrZWVwYWxpdmVUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgdW5kZWZpbmVkO1xuICBwcml2YXRlIGhlYWx0aFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCB1bmRlZmluZWQ7XG4gIHByaXZhdGUgcmVhZG9ubHkgb25TaWd0ZXJtOiAoKSA9PiB2b2lkO1xuICBwcml2YXRlIHJlYWRvbmx5IG9uU2lnaW50OiAoKSA9PiB2b2lkO1xuICBwcml2YXRlIHNlc3Npb25NYW5hZ2VyOiBTZXNzaW9uTWFuYWdlciB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSBkaXNjb3JkQm90OiBEaXNjb3JkQm90IHwgdW5kZWZpbmVkO1xuICBwcml2YXRlIGV2ZW50QnJpZGdlOiBFdmVudEJyaWRnZSB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSBvcmNoZXN0cmF0b3I6IE9yY2hlc3RyYXRvciB8IHVuZGVmaW5lZDtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIHJlYWRvbmx5IGNvbmZpZzogRGFlbW9uQ29uZmlnLFxuICAgIHByaXZhdGUgcmVhZG9ubHkgbG9nZ2VyOiBMb2dnZXIsXG4gICAgcHJpdmF0ZSByZWFkb25seSBoZWFsdGhJbnRlcnZhbE1zOiBudW1iZXIgPSAzMDBfMDAwLFxuICApIHtcbiAgICB0aGlzLm9uU2lndGVybSA9ICgpID0+IHZvaWQgdGhpcy5zaHV0ZG93bigpO1xuICAgIHRoaXMub25TaWdpbnQgPSAoKSA9PiB2b2lkIHRoaXMuc2h1dGRvd24oKTtcbiAgfVxuXG4gIC8qKiBTdGFydCB0aGUgZGFlbW9uOiBsb2cgc3RhcnR1cCBpbmZvLCByZWdpc3RlciBzaWduYWwgaGFuZGxlcnMsIHN0YXJ0IGtlZXBhbGl2ZS4gKi9cbiAgYXN5bmMgc3RhcnQoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5zZXNzaW9uTWFuYWdlciA9IG5ldyBTZXNzaW9uTWFuYWdlcih0aGlzLmxvZ2dlcik7XG5cbiAgICB0aGlzLmxvZ2dlci5pbmZvKCdkYWVtb24gc3RhcnRlZCcsIHtcbiAgICAgIGxvZ19sZXZlbDogdGhpcy5jb25maWcubG9nLmxldmVsLFxuICAgICAgc2Nhbl9yb290czogdGhpcy5jb25maWcucHJvamVjdHMuc2Nhbl9yb290cy5sZW5ndGgsXG4gICAgICBkaXNjb3JkX2NvbmZpZ3VyZWQ6ICEhdGhpcy5jb25maWcuZGlzY29yZCxcbiAgICB9KTtcblxuICAgIHByb2Nlc3Mub24oJ1NJR1RFUk0nLCB0aGlzLm9uU2lndGVybSk7XG4gICAgcHJvY2Vzcy5vbignU0lHSU5UJywgdGhpcy5vblNpZ2ludCk7XG5cbiAgICAvLyBLZWVwIHRoZSBldmVudCBsb29wIGFsaXZlLiBUaGUgd3JpdGUgc3RyZWFtIGFsb25lIGRvZXNuJ3QgaG9sZCBhIHJlZlxuICAgIC8vIHdoZW4gdGhlcmUncyBubyBwZW5kaW5nIEkvTywgc28gd2UgbmVlZCBhbiBleHBsaWNpdCB0aW1lci5cbiAgICB0aGlzLmtlZXBhbGl2ZVRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4ge30sIDYwXzAwMCk7XG5cbiAgICAvLyBDb25kaXRpb25hbGx5IHN0YXJ0IERpc2NvcmQgYm90IGlmIGNvbmZpZyBpcyBwcmVzZW50IGFuZCB2YWxpZFxuICAgIGlmICh0aGlzLmNvbmZpZy5kaXNjb3JkPy50b2tlbikge1xuICAgICAgdHJ5IHtcbiAgICAgICAgdmFsaWRhdGVEaXNjb3JkQ29uZmlnKHRoaXMuY29uZmlnLmRpc2NvcmQpO1xuICAgICAgICB0aGlzLmRpc2NvcmRCb3QgPSBuZXcgRGlzY29yZEJvdCh7XG4gICAgICAgICAgY29uZmlnOiB0aGlzLmNvbmZpZy5kaXNjb3JkLFxuICAgICAgICAgIGxvZ2dlcjogdGhpcy5sb2dnZXIsXG4gICAgICAgICAgc2Vzc2lvbk1hbmFnZXI6IHRoaXMuc2Vzc2lvbk1hbmFnZXIsXG4gICAgICAgICAgc2NhblByb2plY3RzOiAoKSA9PiB0aGlzLnNjYW5Qcm9qZWN0cygpLFxuICAgICAgICB9KTtcbiAgICAgICAgYXdhaXQgdGhpcy5kaXNjb3JkQm90LmxvZ2luKCk7XG5cbiAgICAgICAgLy8gV2lyZSB1cCBFdmVudEJyaWRnZSBhZnRlciBib3QgaXMgcmVhZHlcbiAgICAgICAgY29uc3QgY2hhbm5lbE1hbmFnZXIgPSB0aGlzLmRpc2NvcmRCb3QuZ2V0Q2hhbm5lbE1hbmFnZXIoKTtcbiAgICAgICAgY29uc3QgY2xpZW50ID0gdGhpcy5kaXNjb3JkQm90LmdldENsaWVudCgpO1xuICAgICAgICBpZiAoY2hhbm5lbE1hbmFnZXIgJiYgY2xpZW50KSB7XG4gICAgICAgICAgdGhpcy5ldmVudEJyaWRnZSA9IG5ldyBFdmVudEJyaWRnZSh7XG4gICAgICAgICAgICBzZXNzaW9uTWFuYWdlcjogdGhpcy5zZXNzaW9uTWFuYWdlcixcbiAgICAgICAgICAgIGNoYW5uZWxNYW5hZ2VyLFxuICAgICAgICAgICAgY2xpZW50LFxuICAgICAgICAgICAgY29uZmlnOiB0aGlzLmNvbmZpZyxcbiAgICAgICAgICAgIGxvZ2dlcjogdGhpcy5sb2dnZXIsXG4gICAgICAgICAgICBvd25lcklkOiB0aGlzLmNvbmZpZy5kaXNjb3JkLm93bmVyX2lkLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHRoaXMuZGlzY29yZEJvdC5zZXRFdmVudEJyaWRnZSh0aGlzLmV2ZW50QnJpZGdlKTtcbiAgICAgICAgICB0aGlzLmV2ZW50QnJpZGdlLnN0YXJ0KCk7XG4gICAgICAgICAgdGhpcy5sb2dnZXIuaW5mbygnZXZlbnQgYnJpZGdlIHdpcmVkJyk7XG5cbiAgICAgICAgICAvLyBXaXJlIHVwIE9yY2hlc3RyYXRvciBpZiBjb250cm9sX2NoYW5uZWxfaWQgaXMgY29uZmlndXJlZFxuICAgICAgICAgIGlmICh0aGlzLmNvbmZpZy5kaXNjb3JkLmNvbnRyb2xfY2hhbm5lbF9pZCkge1xuICAgICAgICAgICAgdGhpcy5vcmNoZXN0cmF0b3IgPSBuZXcgT3JjaGVzdHJhdG9yKHtcbiAgICAgICAgICAgICAgc2Vzc2lvbk1hbmFnZXI6IHRoaXMuc2Vzc2lvbk1hbmFnZXIsXG4gICAgICAgICAgICAgIGNoYW5uZWxNYW5hZ2VyLFxuICAgICAgICAgICAgICBzY2FuUHJvamVjdHM6ICgpID0+IHRoaXMuc2NhblByb2plY3RzKCksXG4gICAgICAgICAgICAgIGNvbmZpZzoge1xuICAgICAgICAgICAgICAgIG1vZGVsOiB0aGlzLmNvbmZpZy5kaXNjb3JkLm9yY2hlc3RyYXRvcj8ubW9kZWwgPz8gJ2NsYXVkZS1oYWlrdS00LTUtMjAyNTEwMDEnLFxuICAgICAgICAgICAgICAgIG1heF90b2tlbnM6IHRoaXMuY29uZmlnLmRpc2NvcmQub3JjaGVzdHJhdG9yPy5tYXhfdG9rZW5zID8/IDEwMjQsXG4gICAgICAgICAgICAgICAgY29udHJvbF9jaGFubmVsX2lkOiB0aGlzLmNvbmZpZy5kaXNjb3JkLmNvbnRyb2xfY2hhbm5lbF9pZCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgbG9nZ2VyOiB0aGlzLmxvZ2dlcixcbiAgICAgICAgICAgICAgb3duZXJJZDogdGhpcy5jb25maWcuZGlzY29yZC5vd25lcl9pZCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY2xpZW50Lm9uKCdtZXNzYWdlQ3JlYXRlJywgKG1lc3NhZ2UpID0+IHtcbiAgICAgICAgICAgICAgdm9pZCB0aGlzLm9yY2hlc3RyYXRvciEuaGFuZGxlTWVzc2FnZShtZXNzYWdlKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgdGhpcy5sb2dnZXIuaW5mbygnb3JjaGVzdHJhdG9yIHdpcmVkJywge1xuICAgICAgICAgICAgICBjb250cm9sX2NoYW5uZWxfaWQ6IHRoaXMuY29uZmlnLmRpc2NvcmQuY29udHJvbF9jaGFubmVsX2lkLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRoaXMubG9nZ2VyLndhcm4oJ2V2ZW50IGJyaWRnZSBza2lwcGVkIFx1MjAxNCBjaGFubmVsIG1hbmFnZXIgb3IgY2xpZW50IG5vdCBhdmFpbGFibGUnKTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIC8vIExvZyBlcnJvciBidXQgZG9uJ3QgYWJvcnQgZGFlbW9uIHN0YXJ0dXAgXHUyMDE0IGJvdCBpcyBvcHRpb25hbFxuICAgICAgICB0aGlzLmxvZ2dlci5lcnJvcignZGlzY29yZCBib3QgbG9naW4gZmFpbGVkJywge1xuICAgICAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgIH0pO1xuICAgICAgICB0aGlzLmRpc2NvcmRCb3QgPSB1bmRlZmluZWQ7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gSGVhbHRoIGhlYXJ0YmVhdCBcdTIwMTQgbG9ncyB1cHRpbWUsIHNlc3Npb24gY291bnQsIERpc2NvcmQgc3RhdHVzLCBtZW1vcnlcbiAgICBjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuICAgIHRoaXMuaGVhbHRoVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICBjb25zdCBzZXNzaW9ucyA9IHRoaXMuc2Vzc2lvbk1hbmFnZXI/LmdldEFsbFNlc3Npb25zKCkgPz8gW107XG4gICAgICBjb25zdCBhY3RpdmVTZXNzaW9ucyA9IHNlc3Npb25zLmZpbHRlcihcbiAgICAgICAgKHMpID0+IHMuc3RhdHVzID09PSAncnVubmluZycgfHwgcy5zdGF0dXMgPT09ICdibG9ja2VkJyxcbiAgICAgICkubGVuZ3RoO1xuICAgICAgdGhpcy5sb2dnZXIuaW5mbygnaGVhbHRoJywge1xuICAgICAgICB1cHRpbWVfczogTWF0aC5mbG9vcigoRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSkgLyAxMDAwKSxcbiAgICAgICAgYWN0aXZlX3Nlc3Npb25zOiBhY3RpdmVTZXNzaW9ucyxcbiAgICAgICAgZGlzY29yZF9jb25uZWN0ZWQ6ICEhdGhpcy5kaXNjb3JkQm90Py5nZXRDbGllbnQoKT8uaXNSZWFkeSgpLFxuICAgICAgICBtZW1vcnlfcnNzX21iOiBNYXRoLnJvdW5kKHByb2Nlc3MubWVtb3J5VXNhZ2UoKS5yc3MgLyAxMDI0IC8gMTAyNCksXG4gICAgICB9KTtcbiAgICB9LCB0aGlzLmhlYWx0aEludGVydmFsTXMpO1xuICB9XG5cbiAgLyoqIFNjYW4gY29uZmlndXJlZCBwcm9qZWN0IHJvb3RzIGZvciBwcm9qZWN0IGRpcmVjdG9yaWVzLiAqL1xuICBhc3luYyBzY2FuUHJvamVjdHMoKTogUHJvbWlzZTxQcm9qZWN0SW5mb1tdPiB7XG4gICAgcmV0dXJuIHNjYW5Gb3JQcm9qZWN0cyh0aGlzLmNvbmZpZy5wcm9qZWN0cy5zY2FuX3Jvb3RzKTtcbiAgfVxuXG4gIC8qKiBBY2Nlc3NvciBmb3IgdGhlIHNlc3Npb24gbWFuYWdlciAoYXZhaWxhYmxlIGFmdGVyIHN0YXJ0KCkpLiAqL1xuICBnZXRTZXNzaW9uTWFuYWdlcigpOiBTZXNzaW9uTWFuYWdlciB7XG4gICAgaWYgKCF0aGlzLnNlc3Npb25NYW5hZ2VyKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0RhZW1vbiBub3Qgc3RhcnRlZCBcdTIwMTQgY2FsbCBzdGFydCgpIGJlZm9yZSBhY2Nlc3NpbmcgdGhlIHNlc3Npb24gbWFuYWdlcicpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5zZXNzaW9uTWFuYWdlcjtcbiAgfVxuXG4gIC8qKiBBY2Nlc3NvciBmb3IgdGhlIGV2ZW50IGJyaWRnZSAoYXZhaWxhYmxlIGFmdGVyIHN0YXJ0KCkgd2l0aCBEaXNjb3JkIGNvbmZpZ3VyZWQpLiAqL1xuICBnZXRFdmVudEJyaWRnZSgpOiBFdmVudEJyaWRnZSB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuZXZlbnRCcmlkZ2U7XG4gIH1cblxuICAvKiogQWNjZXNzb3IgZm9yIHRoZSBvcmNoZXN0cmF0b3IgKGF2YWlsYWJsZSBhZnRlciBzdGFydCgpIHdpdGggY29udHJvbF9jaGFubmVsX2lkIGNvbmZpZ3VyZWQpLiAqL1xuICBnZXRPcmNoZXN0cmF0b3IoKTogT3JjaGVzdHJhdG9yIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5vcmNoZXN0cmF0b3I7XG4gIH1cblxuICAvKiogSWRlbXBvdGVudCBzaHV0ZG93bjogbG9nLCBjbGVhbnVwIHNlc3Npb25zLCBjbG9zZSBsb2dnZXIsIGV4aXQuICovXG4gIGFzeW5jIHNodXRkb3duKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLnNodXR0aW5nRG93bikgcmV0dXJuO1xuICAgIHRoaXMuc2h1dHRpbmdEb3duID0gdHJ1ZTtcblxuICAgIHRoaXMubG9nZ2VyLmluZm8oJ2RhZW1vbiBzaHV0dGluZyBkb3duJyk7XG5cbiAgICAvLyBSZW1vdmUgc2lnbmFsIGhhbmRsZXJzIHRvIGF2b2lkIGRvdWJsZS1maXJlXG4gICAgcHJvY2Vzcy5yZW1vdmVMaXN0ZW5lcignU0lHVEVSTScsIHRoaXMub25TaWd0ZXJtKTtcbiAgICBwcm9jZXNzLnJlbW92ZUxpc3RlbmVyKCdTSUdJTlQnLCB0aGlzLm9uU2lnaW50KTtcblxuICAgIC8vIENsZWFyIGhlYWx0aCBoZWFydGJlYXQgdGltZXJcbiAgICBpZiAodGhpcy5oZWFsdGhUaW1lcikge1xuICAgICAgY2xlYXJJbnRlcnZhbCh0aGlzLmhlYWx0aFRpbWVyKTtcbiAgICAgIHRoaXMuaGVhbHRoVGltZXIgPSB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgLy8gQ2xlYXIga2VlcGFsaXZlIHNvIHRoZSBldmVudCBsb29wIGNhbiBkcmFpblxuICAgIGlmICh0aGlzLmtlZXBhbGl2ZVRpbWVyKSB7XG4gICAgICBjbGVhckludGVydmFsKHRoaXMua2VlcGFsaXZlVGltZXIpO1xuICAgICAgdGhpcy5rZWVwYWxpdmVUaW1lciA9IHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICAvLyBTdG9wIE9yY2hlc3RyYXRvciBmaXJzdFxuICAgIGlmICh0aGlzLm9yY2hlc3RyYXRvcikge1xuICAgICAgdGhpcy5vcmNoZXN0cmF0b3Iuc3RvcCgpO1xuICAgICAgdGhpcy5vcmNoZXN0cmF0b3IgPSB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgLy8gU3RvcCBFdmVudEJyaWRnZSBiZWZvcmUgRGlzY29yZCBib3QgZGVzdHJveVxuICAgIGlmICh0aGlzLmV2ZW50QnJpZGdlKSB7XG4gICAgICBhd2FpdCB0aGlzLmV2ZW50QnJpZGdlLnN0b3AoKTtcbiAgICAgIHRoaXMuZXZlbnRCcmlkZ2UgPSB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgLy8gRGVzdHJveSBEaXNjb3JkIGJvdCBiZWZvcmUgc2Vzc2lvbiBjbGVhbnVwXG4gICAgaWYgKHRoaXMuZGlzY29yZEJvdCkge1xuICAgICAgYXdhaXQgdGhpcy5kaXNjb3JkQm90LmRlc3Ryb3koKTtcbiAgICAgIHRoaXMuZGlzY29yZEJvdCA9IHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICAvLyBDbGVhbiB1cCBhY3RpdmUgc2Vzc2lvbnMgYmVmb3JlIGNsb3NpbmcgbG9nZ2VyXG4gICAgaWYgKHRoaXMuc2Vzc2lvbk1hbmFnZXIpIHtcbiAgICAgIGF3YWl0IHRoaXMuc2Vzc2lvbk1hbmFnZXIuY2xlYW51cCgpO1xuICAgIH1cblxuICAgIGF3YWl0IHRoaXMubG9nZ2VyLmNsb3NlKCk7XG4gICAgcHJvY2Vzcy5leGl0KDApO1xuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFFQSxTQUFTLHNCQUFzQjtBQUMvQixTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLFlBQVksNkJBQTZCO0FBQ2xELFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMsb0JBQW9CO0FBTXRCLE1BQU0sT0FBTztBQUFBLEVBV2xCLFlBQ21CLFFBQ0EsUUFDQSxtQkFBMkIsS0FDNUM7QUFIaUI7QUFDQTtBQUNBO0FBRWpCLFNBQUssWUFBWSxNQUFNLEtBQUssS0FBSyxTQUFTO0FBQzFDLFNBQUssV0FBVyxNQUFNLEtBQUssS0FBSyxTQUFTO0FBQUEsRUFDM0M7QUFBQSxFQWpCUSxlQUFlO0FBQUEsRUFDZjtBQUFBLEVBQ0E7QUFBQSxFQUNTO0FBQUEsRUFDQTtBQUFBLEVBQ1Q7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQTtBQUFBLEVBWVIsTUFBTSxRQUF1QjtBQUMzQixTQUFLLGlCQUFpQixJQUFJLGVBQWUsS0FBSyxNQUFNO0FBRXBELFNBQUssT0FBTyxLQUFLLGtCQUFrQjtBQUFBLE1BQ2pDLFdBQVcsS0FBSyxPQUFPLElBQUk7QUFBQSxNQUMzQixZQUFZLEtBQUssT0FBTyxTQUFTLFdBQVc7QUFBQSxNQUM1QyxvQkFBb0IsQ0FBQyxD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
