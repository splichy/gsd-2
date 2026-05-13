#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { resolveConfigPath, loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { Daemon } from "./daemon.js";
import { install, uninstall, status } from "./launchd.js";
const USAGE = `Usage: gsd-daemon [options]

Options:
  --config <path>  Path to YAML config file (default: ~/.gsd/daemon.yaml)
  --verbose        Print log entries to stderr in addition to the log file
  --install        Install the launchd LaunchAgent (auto-starts on login)
  --uninstall      Uninstall the launchd LaunchAgent
  --status         Show launchd agent status (registered, PID, exit code)
  --help           Show this help message and exit
`;
async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      verbose: { type: "boolean", short: "v", default: false },
      install: { type: "boolean", default: false },
      uninstall: { type: "boolean", default: false },
      status: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false }
    },
    strict: true
  });
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (values.install) {
    const configPath2 = resolveConfigPath(values.config);
    const thisFile = fileURLToPath(import.meta.url);
    const scriptPath = resolve(dirname(thisFile), "cli.js");
    install({
      nodePath: process.execPath,
      scriptPath,
      configPath: configPath2
    });
    process.stdout.write("gsd-daemon: launchd agent installed and loaded.\n");
    process.exit(0);
  }
  if (values.uninstall) {
    uninstall();
    process.stdout.write("gsd-daemon: launchd agent uninstalled.\n");
    process.exit(0);
  }
  if (values.status) {
    const result = status();
    if (!result.registered) {
      process.stdout.write("gsd-daemon: not registered with launchd.\n");
    } else if (result.pid != null) {
      process.stdout.write(
        `gsd-daemon: running (PID ${result.pid}, last exit status: ${result.lastExitStatus ?? "n/a"})
`
      );
    } else {
      process.stdout.write(
        `gsd-daemon: registered but not running (last exit status: ${result.lastExitStatus ?? "n/a"})
`
      );
    }
    process.exit(0);
  }
  const configPath = resolveConfigPath(values.config);
  const config = loadConfig(configPath);
  const logger = new Logger({
    filePath: config.log.file,
    level: config.log.level,
    verbose: values.verbose
  });
  const daemon = new Daemon(config, logger);
  await daemon.start();
}
main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`gsd-daemon: fatal: ${msg}
`);
  process.exit(1);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvZGFlbW9uL3NyYy9jbGkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIiMhL3Vzci9iaW4vZW52IG5vZGVcbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gJ25vZGU6dXRpbCc7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSAnbm9kZTp1cmwnO1xuaW1wb3J0IHsgcmVzb2x2ZSwgZGlybmFtZSB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyByZXNvbHZlQ29uZmlnUGF0aCwgbG9hZENvbmZpZyB9IGZyb20gJy4vY29uZmlnLmpzJztcbmltcG9ydCB7IExvZ2dlciB9IGZyb20gJy4vbG9nZ2VyLmpzJztcbmltcG9ydCB7IERhZW1vbiB9IGZyb20gJy4vZGFlbW9uLmpzJztcbmltcG9ydCB7IGluc3RhbGwsIHVuaW5zdGFsbCwgc3RhdHVzIH0gZnJvbSAnLi9sYXVuY2hkLmpzJztcblxuY29uc3QgVVNBR0UgPSBgVXNhZ2U6IGdzZC1kYWVtb24gW29wdGlvbnNdXG5cbk9wdGlvbnM6XG4gIC0tY29uZmlnIDxwYXRoPiAgUGF0aCB0byBZQU1MIGNvbmZpZyBmaWxlIChkZWZhdWx0OiB+Ly5nc2QvZGFlbW9uLnlhbWwpXG4gIC0tdmVyYm9zZSAgICAgICAgUHJpbnQgbG9nIGVudHJpZXMgdG8gc3RkZXJyIGluIGFkZGl0aW9uIHRvIHRoZSBsb2cgZmlsZVxuICAtLWluc3RhbGwgICAgICAgIEluc3RhbGwgdGhlIGxhdW5jaGQgTGF1bmNoQWdlbnQgKGF1dG8tc3RhcnRzIG9uIGxvZ2luKVxuICAtLXVuaW5zdGFsbCAgICAgIFVuaW5zdGFsbCB0aGUgbGF1bmNoZCBMYXVuY2hBZ2VudFxuICAtLXN0YXR1cyAgICAgICAgIFNob3cgbGF1bmNoZCBhZ2VudCBzdGF0dXMgKHJlZ2lzdGVyZWQsIFBJRCwgZXhpdCBjb2RlKVxuICAtLWhlbHAgICAgICAgICAgIFNob3cgdGhpcyBoZWxwIG1lc3NhZ2UgYW5kIGV4aXRcbmA7XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHsgdmFsdWVzIH0gPSBwYXJzZUFyZ3Moe1xuICAgIG9wdGlvbnM6IHtcbiAgICAgIGNvbmZpZzogeyB0eXBlOiAnc3RyaW5nJywgc2hvcnQ6ICdjJyB9LFxuICAgICAgdmVyYm9zZTogeyB0eXBlOiAnYm9vbGVhbicsIHNob3J0OiAndicsIGRlZmF1bHQ6IGZhbHNlIH0sXG4gICAgICBpbnN0YWxsOiB7IHR5cGU6ICdib29sZWFuJywgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgIHVuaW5zdGFsbDogeyB0eXBlOiAnYm9vbGVhbicsIGRlZmF1bHQ6IGZhbHNlIH0sXG4gICAgICBzdGF0dXM6IHsgdHlwZTogJ2Jvb2xlYW4nLCBkZWZhdWx0OiBmYWxzZSB9LFxuICAgICAgaGVscDogeyB0eXBlOiAnYm9vbGVhbicsIHNob3J0OiAnaCcsIGRlZmF1bHQ6IGZhbHNlIH0sXG4gICAgfSxcbiAgICBzdHJpY3Q6IHRydWUsXG4gIH0pO1xuXG4gIGlmICh2YWx1ZXMuaGVscCkge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFVTQUdFKTtcbiAgICBwcm9jZXNzLmV4aXQoMCk7XG4gIH1cblxuICAvLyAtLS0gbGF1bmNoZCBjb21tYW5kcyAoZGlzcGF0Y2ggYmVmb3JlIERhZW1vbiBjcmVhdGlvbikgLS0tXG5cbiAgaWYgKHZhbHVlcy5pbnN0YWxsKSB7XG4gICAgY29uc3QgY29uZmlnUGF0aCA9IHJlc29sdmVDb25maWdQYXRoKHZhbHVlcy5jb25maWcpO1xuICAgIGNvbnN0IHRoaXNGaWxlID0gZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpO1xuICAgIGNvbnN0IHNjcmlwdFBhdGggPSByZXNvbHZlKGRpcm5hbWUodGhpc0ZpbGUpLCAnY2xpLmpzJyk7XG5cbiAgICBpbnN0YWxsKHtcbiAgICAgIG5vZGVQYXRoOiBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgc2NyaXB0UGF0aCxcbiAgICAgIGNvbmZpZ1BhdGgsXG4gICAgfSk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoJ2dzZC1kYWVtb246IGxhdW5jaGQgYWdlbnQgaW5zdGFsbGVkIGFuZCBsb2FkZWQuXFxuJyk7XG4gICAgcHJvY2Vzcy5leGl0KDApO1xuICB9XG5cbiAgaWYgKHZhbHVlcy51bmluc3RhbGwpIHtcbiAgICB1bmluc3RhbGwoKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZSgnZ3NkLWRhZW1vbjogbGF1bmNoZCBhZ2VudCB1bmluc3RhbGxlZC5cXG4nKTtcbiAgICBwcm9jZXNzLmV4aXQoMCk7XG4gIH1cblxuICBpZiAodmFsdWVzLnN0YXR1cykge1xuICAgIGNvbnN0IHJlc3VsdCA9IHN0YXR1cygpO1xuICAgIGlmICghcmVzdWx0LnJlZ2lzdGVyZWQpIHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKCdnc2QtZGFlbW9uOiBub3QgcmVnaXN0ZXJlZCB3aXRoIGxhdW5jaGQuXFxuJyk7XG4gICAgfSBlbHNlIGlmIChyZXN1bHQucGlkICE9IG51bGwpIHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgICBgZ3NkLWRhZW1vbjogcnVubmluZyAoUElEICR7cmVzdWx0LnBpZH0sIGxhc3QgZXhpdCBzdGF0dXM6ICR7cmVzdWx0Lmxhc3RFeGl0U3RhdHVzID8/ICduL2EnfSlcXG5gLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICAgIGBnc2QtZGFlbW9uOiByZWdpc3RlcmVkIGJ1dCBub3QgcnVubmluZyAobGFzdCBleGl0IHN0YXR1czogJHtyZXN1bHQubGFzdEV4aXRTdGF0dXMgPz8gJ24vYSd9KVxcbmAsXG4gICAgICApO1xuICAgIH1cbiAgICBwcm9jZXNzLmV4aXQoMCk7XG4gIH1cblxuICAvLyAtLS0gbm9ybWFsIGRhZW1vbiBzdGFydCAtLS1cblxuICBjb25zdCBjb25maWdQYXRoID0gcmVzb2x2ZUNvbmZpZ1BhdGgodmFsdWVzLmNvbmZpZyk7XG4gIGNvbnN0IGNvbmZpZyA9IGxvYWRDb25maWcoY29uZmlnUGF0aCk7XG5cbiAgY29uc3QgbG9nZ2VyID0gbmV3IExvZ2dlcih7XG4gICAgZmlsZVBhdGg6IGNvbmZpZy5sb2cuZmlsZSxcbiAgICBsZXZlbDogY29uZmlnLmxvZy5sZXZlbCxcbiAgICB2ZXJib3NlOiB2YWx1ZXMudmVyYm9zZSxcbiAgfSk7XG5cbiAgY29uc3QgZGFlbW9uID0gbmV3IERhZW1vbihjb25maWcsIGxvZ2dlcik7XG4gIGF3YWl0IGRhZW1vbi5zdGFydCgpO1xufVxuXG5tYWluKCkuY2F0Y2goKGVycjogdW5rbm93bikgPT4ge1xuICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBnc2QtZGFlbW9uOiBmYXRhbDogJHttc2d9XFxuYCk7XG4gIHByb2Nlc3MuZXhpdCgxKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUNBLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsU0FBUyxlQUFlO0FBQ2pDLFNBQVMsbUJBQW1CLGtCQUFrQjtBQUM5QyxTQUFTLGNBQWM7QUFDdkIsU0FBUyxjQUFjO0FBQ3ZCLFNBQVMsU0FBUyxXQUFXLGNBQWM7QUFFM0MsTUFBTSxRQUFRO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBV2QsZUFBZSxPQUFzQjtBQUNuQyxRQUFNLEVBQUUsT0FBTyxJQUFJLFVBQVU7QUFBQSxJQUMzQixTQUFTO0FBQUEsTUFDUCxRQUFRLEVBQUUsTUFBTSxVQUFVLE9BQU8sSUFBSTtBQUFBLE1BQ3JDLFNBQVMsRUFBRSxNQUFNLFdBQVcsT0FBTyxLQUFLLFNBQVMsTUFBTTtBQUFBLE1BQ3ZELFNBQVMsRUFBRSxNQUFNLFdBQVcsU0FBUyxNQUFNO0FBQUEsTUFDM0MsV0FBVyxFQUFFLE1BQU0sV0FBVyxTQUFTLE1BQU07QUFBQSxNQUM3QyxRQUFRLEVBQUUsTUFBTSxXQUFXLFNBQVMsTUFBTTtBQUFBLE1BQzFDLE1BQU0sRUFBRSxNQUFNLFdBQVcsT0FBTyxLQUFLLFNBQVMsTUFBTTtBQUFBLElBQ3REO0FBQUEsSUFDQSxRQUFRO0FBQUEsRUFDVixDQUFDO0FBRUQsTUFBSSxPQUFPLE1BQU07QUFDZixZQUFRLE9BQU8sTUFBTSxLQUFLO0FBQzFCLFlBQVEsS0FBSyxDQUFDO0FBQUEsRUFDaEI7QUFJQSxNQUFJLE9BQU8sU0FBUztBQUNsQixVQUFNQSxjQUFhLGtCQUFrQixPQUFPLE1BQU07QUFDbEQsVUFBTSxXQUFXLGNBQWMsWUFBWSxHQUFHO0FBQzlDLFVBQU0sYUFBYSxRQUFRLFFBQVEsUUFBUSxHQUFHLFFBQVE7QUFFdEQsWUFBUTtBQUFBLE1BQ04sVUFBVSxRQUFRO0FBQUEsTUFDbEI7QUFBQSxNQUNBLFlBQUFBO0FBQUEsSUFDRixDQUFDO0FBQ0QsWUFBUSxPQUFPLE1BQU0sbURBQW1EO0FBQ3hFLFlBQVEsS0FBSyxDQUFDO0FBQUEsRUFDaEI7QUFFQSxNQUFJLE9BQU8sV0FBVztBQUNwQixjQUFVO0FBQ1YsWUFBUSxPQUFPLE1BQU0sMENBQTBDO0FBQy9ELFlBQVEsS0FBSyxDQUFDO0FBQUEsRUFDaEI7QUFFQSxNQUFJLE9BQU8sUUFBUTtBQUNqQixVQUFNLFNBQVMsT0FBTztBQUN0QixRQUFJLENBQUMsT0FBTyxZQUFZO0FBQ3RCLGNBQVEsT0FBTyxNQUFNLDRDQUE0QztBQUFBLElBQ25FLFdBQVcsT0FBTyxPQUFPLE1BQU07QUFDN0IsY0FBUSxPQUFPO0FBQUEsUUFDYiw0QkFBNEIsT0FBTyxHQUFHLHVCQUF1QixPQUFPLGtCQUFrQixLQUFLO0FBQUE7QUFBQSxNQUM3RjtBQUFBLElBQ0YsT0FBTztBQUNMLGNBQVEsT0FBTztBQUFBLFFBQ2IsNkRBQTZELE9BQU8sa0JBQWtCLEtBQUs7QUFBQTtBQUFBLE1BQzdGO0FBQUEsSUFDRjtBQUNBLFlBQVEsS0FBSyxDQUFDO0FBQUEsRUFDaEI7QUFJQSxRQUFNLGFBQWEsa0JBQWtCLE9BQU8sTUFBTTtBQUNsRCxRQUFNLFNBQVMsV0FBVyxVQUFVO0FBRXBDLFFBQU0sU0FBUyxJQUFJLE9BQU87QUFBQSxJQUN4QixVQUFVLE9BQU8sSUFBSTtBQUFBLElBQ3JCLE9BQU8sT0FBTyxJQUFJO0FBQUEsSUFDbEIsU0FBUyxPQUFPO0FBQUEsRUFDbEIsQ0FBQztBQUVELFFBQU0sU0FBUyxJQUFJLE9BQU8sUUFBUSxNQUFNO0FBQ3hDLFFBQU0sT0FBTyxNQUFNO0FBQ3JCO0FBRUEsS0FBSyxFQUFFLE1BQU0sQ0FBQyxRQUFpQjtBQUM3QixRQUFNLE1BQU0sZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUc7QUFDM0QsVUFBUSxPQUFPLE1BQU0sc0JBQXNCLEdBQUc7QUFBQSxDQUFJO0FBQ2xELFVBQVEsS0FBSyxDQUFDO0FBQ2hCLENBQUM7IiwKICAibmFtZXMiOiBbImNvbmZpZ1BhdGgiXQp9Cg==
