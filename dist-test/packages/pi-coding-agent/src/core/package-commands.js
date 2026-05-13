import chalk from "chalk";
import { DefaultPackageManager } from "./package-manager.js";
import { prepareLifecycleHooks, runLifecycleHooks } from "./lifecycle-hooks.js";
import { SettingsManager } from "./settings-manager.js";
function reportSettingsErrors(settingsManager, context, stderr) {
  const errors = settingsManager.drainErrors();
  for (const { scope, error } of errors) {
    stderr.write(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`) + "\n");
    if (error.stack) {
      stderr.write(chalk.dim(error.stack) + "\n");
    }
  }
}
function getPackageCommandUsage(appName, command) {
  switch (command) {
    case "install":
      return `${appName} install <source> [-l]`;
    case "remove":
      return `${appName} remove <source> [-l]`;
    case "update":
      return `${appName} update [source]`;
    case "list":
      return `${appName} list`;
  }
}
function printPackageCommandHelp(appName, command, stdout) {
  switch (command) {
    case "install":
      stdout.write(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage(appName, "install")}

Install a package, add it to settings, and run lifecycle hooks.

Options:
  -l, --local    Install project-locally (.pi/settings.json)

Examples:
  ${appName} install npm:@foo/bar
  ${appName} install git:github.com/user/repo
  ${appName} install git:git@github.com:user/repo
  ${appName} install https://github.com/user/repo
  ${appName} install ssh://git@github.com/user/repo
  ${appName} install ./local/path
`);
      return;
    case "remove":
      stdout.write(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage(appName, "remove")}

Remove a package and its source from settings.

Options:
  -l, --local    Remove from project settings (.pi/settings.json)

Example:
  ${appName} remove npm:@foo/bar
`);
      return;
    case "update":
      stdout.write(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage(appName, "update")}

Update installed packages.
If <source> is provided, only that package is updated.
`);
      return;
    case "list":
      stdout.write(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage(appName, "list")}

List installed packages from user and project settings.
`);
      return;
  }
}
function parsePackageCommand(args, allowedCommands) {
  const [command, ...rest] = args;
  if (command !== "install" && command !== "remove" && command !== "update" && command !== "list") {
    return void 0;
  }
  if (allowedCommands && !allowedCommands.has(command)) {
    return void 0;
  }
  let local = false;
  let help = false;
  let invalidOption;
  let source;
  for (const arg of rest) {
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "-l" || arg === "--local") {
      if (command === "install" || command === "remove") {
        local = true;
      } else {
        invalidOption = invalidOption ?? arg;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      invalidOption = invalidOption ?? arg;
      continue;
    }
    if (!source) {
      source = arg;
    }
  }
  return { command, source, local, help, invalidOption };
}
async function runPackageCommand(options) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const parsed = parsePackageCommand(options.args, options.allowedCommands);
  if (!parsed) {
    return { handled: false, exitCode: 0 };
  }
  if (parsed.help) {
    printPackageCommandHelp(options.appName, parsed.command, stdout);
    return { handled: true, exitCode: 0 };
  }
  if (parsed.invalidOption) {
    stderr.write(chalk.red(`Unknown option ${parsed.invalidOption} for "${parsed.command}".`) + "\n");
    stderr.write(chalk.dim(`Use "${options.appName} --help" or "${getPackageCommandUsage(options.appName, parsed.command)}".`) + "\n");
    return { handled: true, exitCode: 1 };
  }
  const source = parsed.source;
  if ((parsed.command === "install" || parsed.command === "remove") && !source) {
    stderr.write(chalk.red(`Missing ${parsed.command} source.`) + "\n");
    stderr.write(chalk.dim(`Usage: ${getPackageCommandUsage(options.appName, parsed.command)}`) + "\n");
    return { handled: true, exitCode: 1 };
  }
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
  reportSettingsErrors(settingsManager, "package command", stderr);
  const packageManager = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager
  });
  packageManager.setProgressCallback((event) => {
    if (event.type === "start" && event.message) {
      stdout.write(chalk.dim(`${event.message}
`));
    }
  });
  try {
    switch (parsed.command) {
      case "install": {
        const lifecycleOptions = {
          source,
          local: parsed.local,
          cwd: options.cwd,
          agentDir: options.agentDir,
          appName: options.appName,
          packageManager,
          stdout,
          stderr
        };
        const beforeInstallHooks = await prepareLifecycleHooks(lifecycleOptions, "source");
        const beforeInstallResult = await runLifecycleHooks(beforeInstallHooks, "beforeInstall");
        await packageManager.install(source, { local: parsed.local });
        packageManager.addSourceToSettings(source, { local: parsed.local });
        const afterInstallHooks = await prepareLifecycleHooks(lifecycleOptions, "installed", {
          verifyRuntimeDependencies: true
        });
        const afterInstallResult = await runLifecycleHooks(afterInstallHooks, "afterInstall");
        const hookErrors = beforeInstallResult.hookErrors + afterInstallResult.hookErrors;
        if (hookErrors > 0) {
          stderr.write(chalk.yellow(`Lifecycle hooks completed with ${hookErrors} hook error(s).`) + "\n");
        }
        stdout.write(chalk.green(`Installed ${source}`) + "\n");
        return { handled: true, exitCode: 0 };
      }
      case "remove": {
        const lifecycleOptions = {
          source,
          local: parsed.local,
          cwd: options.cwd,
          agentDir: options.agentDir,
          appName: options.appName,
          packageManager,
          stdout,
          stderr
        };
        const removeHooks = await prepareLifecycleHooks(lifecycleOptions, "installed");
        const beforeRemoveResult = await runLifecycleHooks(removeHooks, "beforeRemove");
        await packageManager.remove(source, { local: parsed.local });
        const removed = packageManager.removeSourceFromSettings(source, { local: parsed.local });
        const afterRemoveResult = await runLifecycleHooks(removeHooks, "afterRemove");
        const hookErrors = beforeRemoveResult.hookErrors + afterRemoveResult.hookErrors;
        if (hookErrors > 0) {
          stderr.write(chalk.yellow(`Lifecycle hooks completed with ${hookErrors} hook error(s).`) + "\n");
        }
        if (!removed) {
          stderr.write(chalk.red(`No matching package found for ${source}`) + "\n");
          return { handled: true, exitCode: 1 };
        }
        stdout.write(chalk.green(`Removed ${source}`) + "\n");
        return { handled: true, exitCode: 0 };
      }
      case "list": {
        const globalSettings = settingsManager.getGlobalSettings();
        const projectSettings = settingsManager.getProjectSettings();
        const globalPackages = globalSettings.packages ?? [];
        const projectPackages = projectSettings.packages ?? [];
        if (globalPackages.length === 0 && projectPackages.length === 0) {
          stdout.write(chalk.dim("No packages installed.") + "\n");
          return { handled: true, exitCode: 0 };
        }
        const formatPackage = (pkg, scope) => {
          const pkgSource = typeof pkg === "string" ? pkg : pkg.source;
          const filtered = typeof pkg === "object";
          const display = filtered ? `${pkgSource} (filtered)` : pkgSource;
          stdout.write(`  ${display}
`);
          const path = packageManager.getInstalledPath(pkgSource, scope);
          if (path) {
            stdout.write(chalk.dim(`    ${path}`) + "\n");
          }
        };
        if (globalPackages.length > 0) {
          stdout.write(chalk.bold("User packages:") + "\n");
          for (const pkg of globalPackages) {
            formatPackage(pkg, "user");
          }
        }
        if (projectPackages.length > 0) {
          if (globalPackages.length > 0) stdout.write("\n");
          stdout.write(chalk.bold("Project packages:") + "\n");
          for (const pkg of projectPackages) {
            formatPackage(pkg, "project");
          }
        }
        return { handled: true, exitCode: 0 };
      }
      case "update":
        await packageManager.update(source);
        if (source) {
          stdout.write(chalk.green(`Updated ${source}`) + "\n");
        } else {
          stdout.write(chalk.green("Updated packages") + "\n");
        }
        return { handled: true, exitCode: 0 };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown package command error";
    stderr.write(chalk.red(`Error: ${message}`) + "\n");
    return { handled: true, exitCode: 1 };
  }
}
export {
  getPackageCommandUsage,
  parsePackageCommand,
  runPackageCommand
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3BhY2thZ2UtY29tbWFuZHMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCBjaGFsayBmcm9tIFwiY2hhbGtcIjtcbmltcG9ydCB7IERlZmF1bHRQYWNrYWdlTWFuYWdlciB9IGZyb20gXCIuL3BhY2thZ2UtbWFuYWdlci5qc1wiO1xuaW1wb3J0IHsgcHJlcGFyZUxpZmVjeWNsZUhvb2tzLCBydW5MaWZlY3ljbGVIb29rcyB9IGZyb20gXCIuL2xpZmVjeWNsZS1ob29rcy5qc1wiO1xuaW1wb3J0IHsgU2V0dGluZ3NNYW5hZ2VyIH0gZnJvbSBcIi4vc2V0dGluZ3MtbWFuYWdlci5qc1wiO1xuXG5leHBvcnQgdHlwZSBQYWNrYWdlQ29tbWFuZCA9IFwiaW5zdGFsbFwiIHwgXCJyZW1vdmVcIiB8IFwidXBkYXRlXCIgfCBcImxpc3RcIjtcblxuZXhwb3J0IGludGVyZmFjZSBQYWNrYWdlQ29tbWFuZE9wdGlvbnMge1xuXHRjb21tYW5kOiBQYWNrYWdlQ29tbWFuZDtcblx0c291cmNlPzogc3RyaW5nO1xuXHRsb2NhbDogYm9vbGVhbjtcblx0aGVscDogYm9vbGVhbjtcblx0aW52YWxpZE9wdGlvbj86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQYWNrYWdlQ29tbWFuZFJ1bm5lck9wdGlvbnMge1xuXHRhcHBOYW1lOiBzdHJpbmc7XG5cdGFyZ3M6IHN0cmluZ1tdO1xuXHRjd2Q6IHN0cmluZztcblx0YWdlbnREaXI6IHN0cmluZztcblx0c3Rkb3V0PzogTm9kZUpTLldyaXRlU3RyZWFtO1xuXHRzdGRlcnI/OiBOb2RlSlMuV3JpdGVTdHJlYW07XG5cdGFsbG93ZWRDb21tYW5kcz86IFJlYWRvbmx5U2V0PFBhY2thZ2VDb21tYW5kPjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQYWNrYWdlQ29tbWFuZFJ1bm5lclJlc3VsdCB7XG5cdGhhbmRsZWQ6IGJvb2xlYW47XG5cdGV4aXRDb2RlOiBudW1iZXI7XG59XG5cbmZ1bmN0aW9uIHJlcG9ydFNldHRpbmdzRXJyb3JzKHNldHRpbmdzTWFuYWdlcjogU2V0dGluZ3NNYW5hZ2VyLCBjb250ZXh0OiBzdHJpbmcsIHN0ZGVycjogTm9kZUpTLldyaXRlU3RyZWFtKTogdm9pZCB7XG5cdGNvbnN0IGVycm9ycyA9IHNldHRpbmdzTWFuYWdlci5kcmFpbkVycm9ycygpO1xuXHRmb3IgKGNvbnN0IHsgc2NvcGUsIGVycm9yIH0gb2YgZXJyb3JzKSB7XG5cdFx0c3RkZXJyLndyaXRlKGNoYWxrLnllbGxvdyhgV2FybmluZyAoJHtjb250ZXh0fSwgJHtzY29wZX0gc2V0dGluZ3MpOiAke2Vycm9yLm1lc3NhZ2V9YCkgKyBcIlxcblwiKTtcblx0XHRpZiAoZXJyb3Iuc3RhY2spIHtcblx0XHRcdHN0ZGVyci53cml0ZShjaGFsay5kaW0oZXJyb3Iuc3RhY2spICsgXCJcXG5cIik7XG5cdFx0fVxuXHR9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRQYWNrYWdlQ29tbWFuZFVzYWdlKGFwcE5hbWU6IHN0cmluZywgY29tbWFuZDogUGFja2FnZUNvbW1hbmQpOiBzdHJpbmcge1xuXHRzd2l0Y2ggKGNvbW1hbmQpIHtcblx0XHRjYXNlIFwiaW5zdGFsbFwiOlxuXHRcdFx0cmV0dXJuIGAke2FwcE5hbWV9IGluc3RhbGwgPHNvdXJjZT4gWy1sXWA7XG5cdFx0Y2FzZSBcInJlbW92ZVwiOlxuXHRcdFx0cmV0dXJuIGAke2FwcE5hbWV9IHJlbW92ZSA8c291cmNlPiBbLWxdYDtcblx0XHRjYXNlIFwidXBkYXRlXCI6XG5cdFx0XHRyZXR1cm4gYCR7YXBwTmFtZX0gdXBkYXRlIFtzb3VyY2VdYDtcblx0XHRjYXNlIFwibGlzdFwiOlxuXHRcdFx0cmV0dXJuIGAke2FwcE5hbWV9IGxpc3RgO1xuXHR9XG59XG5cbmZ1bmN0aW9uIHByaW50UGFja2FnZUNvbW1hbmRIZWxwKFxuXHRhcHBOYW1lOiBzdHJpbmcsXG5cdGNvbW1hbmQ6IFBhY2thZ2VDb21tYW5kLFxuXHRzdGRvdXQ6IE5vZGVKUy5Xcml0ZVN0cmVhbSxcbik6IHZvaWQge1xuXHRzd2l0Y2ggKGNvbW1hbmQpIHtcblx0XHRjYXNlIFwiaW5zdGFsbFwiOlxuXHRcdFx0c3Rkb3V0LndyaXRlKGAke2NoYWxrLmJvbGQoXCJVc2FnZTpcIil9XG4gICR7Z2V0UGFja2FnZUNvbW1hbmRVc2FnZShhcHBOYW1lLCBcImluc3RhbGxcIil9XG5cbkluc3RhbGwgYSBwYWNrYWdlLCBhZGQgaXQgdG8gc2V0dGluZ3MsIGFuZCBydW4gbGlmZWN5Y2xlIGhvb2tzLlxuXG5PcHRpb25zOlxuICAtbCwgLS1sb2NhbCAgICBJbnN0YWxsIHByb2plY3QtbG9jYWxseSAoLnBpL3NldHRpbmdzLmpzb24pXG5cbkV4YW1wbGVzOlxuICAke2FwcE5hbWV9IGluc3RhbGwgbnBtOkBmb28vYmFyXG4gICR7YXBwTmFtZX0gaW5zdGFsbCBnaXQ6Z2l0aHViLmNvbS91c2VyL3JlcG9cbiAgJHthcHBOYW1lfSBpbnN0YWxsIGdpdDpnaXRAZ2l0aHViLmNvbTp1c2VyL3JlcG9cbiAgJHthcHBOYW1lfSBpbnN0YWxsIGh0dHBzOi8vZ2l0aHViLmNvbS91c2VyL3JlcG9cbiAgJHthcHBOYW1lfSBpbnN0YWxsIHNzaDovL2dpdEBnaXRodWIuY29tL3VzZXIvcmVwb1xuICAke2FwcE5hbWV9IGluc3RhbGwgLi9sb2NhbC9wYXRoXG5gKTtcblx0XHRcdHJldHVybjtcblx0XHRjYXNlIFwicmVtb3ZlXCI6XG5cdFx0XHRzdGRvdXQud3JpdGUoYCR7Y2hhbGsuYm9sZChcIlVzYWdlOlwiKX1cbiAgJHtnZXRQYWNrYWdlQ29tbWFuZFVzYWdlKGFwcE5hbWUsIFwicmVtb3ZlXCIpfVxuXG5SZW1vdmUgYSBwYWNrYWdlIGFuZCBpdHMgc291cmNlIGZyb20gc2V0dGluZ3MuXG5cbk9wdGlvbnM6XG4gIC1sLCAtLWxvY2FsICAgIFJlbW92ZSBmcm9tIHByb2plY3Qgc2V0dGluZ3MgKC5waS9zZXR0aW5ncy5qc29uKVxuXG5FeGFtcGxlOlxuICAke2FwcE5hbWV9IHJlbW92ZSBucG06QGZvby9iYXJcbmApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdGNhc2UgXCJ1cGRhdGVcIjpcblx0XHRcdHN0ZG91dC53cml0ZShgJHtjaGFsay5ib2xkKFwiVXNhZ2U6XCIpfVxuICAke2dldFBhY2thZ2VDb21tYW5kVXNhZ2UoYXBwTmFtZSwgXCJ1cGRhdGVcIil9XG5cblVwZGF0ZSBpbnN0YWxsZWQgcGFja2FnZXMuXG5JZiA8c291cmNlPiBpcyBwcm92aWRlZCwgb25seSB0aGF0IHBhY2thZ2UgaXMgdXBkYXRlZC5cbmApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdGNhc2UgXCJsaXN0XCI6XG5cdFx0XHRzdGRvdXQud3JpdGUoYCR7Y2hhbGsuYm9sZChcIlVzYWdlOlwiKX1cbiAgJHtnZXRQYWNrYWdlQ29tbWFuZFVzYWdlKGFwcE5hbWUsIFwibGlzdFwiKX1cblxuTGlzdCBpbnN0YWxsZWQgcGFja2FnZXMgZnJvbSB1c2VyIGFuZCBwcm9qZWN0IHNldHRpbmdzLlxuYCk7XG5cdFx0XHRyZXR1cm47XG5cdH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlUGFja2FnZUNvbW1hbmQoXG5cdGFyZ3M6IHN0cmluZ1tdLFxuXHRhbGxvd2VkQ29tbWFuZHM/OiBSZWFkb25seVNldDxQYWNrYWdlQ29tbWFuZD4sXG4pOiBQYWNrYWdlQ29tbWFuZE9wdGlvbnMgfCB1bmRlZmluZWQge1xuXHRjb25zdCBbY29tbWFuZCwgLi4ucmVzdF0gPSBhcmdzO1xuXHRpZiAoY29tbWFuZCAhPT0gXCJpbnN0YWxsXCIgJiYgY29tbWFuZCAhPT0gXCJyZW1vdmVcIiAmJiBjb21tYW5kICE9PSBcInVwZGF0ZVwiICYmIGNvbW1hbmQgIT09IFwibGlzdFwiKSB7XG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fVxuXHRpZiAoYWxsb3dlZENvbW1hbmRzICYmICFhbGxvd2VkQ29tbWFuZHMuaGFzKGNvbW1hbmQpKSB7XG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fVxuXG5cdGxldCBsb2NhbCA9IGZhbHNlO1xuXHRsZXQgaGVscCA9IGZhbHNlO1xuXHRsZXQgaW52YWxpZE9wdGlvbjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXHRsZXQgc291cmNlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cblx0Zm9yIChjb25zdCBhcmcgb2YgcmVzdCkge1xuXHRcdGlmIChhcmcgPT09IFwiLWhcIiB8fCBhcmcgPT09IFwiLS1oZWxwXCIpIHtcblx0XHRcdGhlbHAgPSB0cnVlO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXHRcdGlmIChhcmcgPT09IFwiLWxcIiB8fCBhcmcgPT09IFwiLS1sb2NhbFwiKSB7XG5cdFx0XHRpZiAoY29tbWFuZCA9PT0gXCJpbnN0YWxsXCIgfHwgY29tbWFuZCA9PT0gXCJyZW1vdmVcIikge1xuXHRcdFx0XHRsb2NhbCA9IHRydWU7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRpbnZhbGlkT3B0aW9uID0gaW52YWxpZE9wdGlvbiA/PyBhcmc7XG5cdFx0XHR9XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cdFx0aWYgKGFyZy5zdGFydHNXaXRoKFwiLVwiKSkge1xuXHRcdFx0aW52YWxpZE9wdGlvbiA9IGludmFsaWRPcHRpb24gPz8gYXJnO1xuXHRcdFx0Y29udGludWU7XG5cdFx0fVxuXHRcdGlmICghc291cmNlKSB7XG5cdFx0XHRzb3VyY2UgPSBhcmc7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIHsgY29tbWFuZCwgc291cmNlLCBsb2NhbCwgaGVscCwgaW52YWxpZE9wdGlvbiB9O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuUGFja2FnZUNvbW1hbmQoXG5cdG9wdGlvbnM6IFBhY2thZ2VDb21tYW5kUnVubmVyT3B0aW9ucyxcbik6IFByb21pc2U8UGFja2FnZUNvbW1hbmRSdW5uZXJSZXN1bHQ+IHtcblx0Y29uc3Qgc3Rkb3V0ID0gb3B0aW9ucy5zdGRvdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG5cdGNvbnN0IHN0ZGVyciA9IG9wdGlvbnMuc3RkZXJyID8/IHByb2Nlc3Muc3RkZXJyO1xuXHRjb25zdCBwYXJzZWQgPSBwYXJzZVBhY2thZ2VDb21tYW5kKG9wdGlvbnMuYXJncywgb3B0aW9ucy5hbGxvd2VkQ29tbWFuZHMpO1xuXHRpZiAoIXBhcnNlZCkge1xuXHRcdHJldHVybiB7IGhhbmRsZWQ6IGZhbHNlLCBleGl0Q29kZTogMCB9O1xuXHR9XG5cblx0aWYgKHBhcnNlZC5oZWxwKSB7XG5cdFx0cHJpbnRQYWNrYWdlQ29tbWFuZEhlbHAob3B0aW9ucy5hcHBOYW1lLCBwYXJzZWQuY29tbWFuZCwgc3Rkb3V0KTtcblx0XHRyZXR1cm4geyBoYW5kbGVkOiB0cnVlLCBleGl0Q29kZTogMCB9O1xuXHR9XG5cblx0aWYgKHBhcnNlZC5pbnZhbGlkT3B0aW9uKSB7XG5cdFx0c3RkZXJyLndyaXRlKGNoYWxrLnJlZChgVW5rbm93biBvcHRpb24gJHtwYXJzZWQuaW52YWxpZE9wdGlvbn0gZm9yIFwiJHtwYXJzZWQuY29tbWFuZH1cIi5gKSArIFwiXFxuXCIpO1xuXHRcdHN0ZGVyci53cml0ZShjaGFsay5kaW0oYFVzZSBcIiR7b3B0aW9ucy5hcHBOYW1lfSAtLWhlbHBcIiBvciBcIiR7Z2V0UGFja2FnZUNvbW1hbmRVc2FnZShvcHRpb25zLmFwcE5hbWUsIHBhcnNlZC5jb21tYW5kKX1cIi5gKSArIFwiXFxuXCIpO1xuXHRcdHJldHVybiB7IGhhbmRsZWQ6IHRydWUsIGV4aXRDb2RlOiAxIH07XG5cdH1cblxuXHRjb25zdCBzb3VyY2UgPSBwYXJzZWQuc291cmNlO1xuXHRpZiAoKHBhcnNlZC5jb21tYW5kID09PSBcImluc3RhbGxcIiB8fCBwYXJzZWQuY29tbWFuZCA9PT0gXCJyZW1vdmVcIikgJiYgIXNvdXJjZSkge1xuXHRcdHN0ZGVyci53cml0ZShjaGFsay5yZWQoYE1pc3NpbmcgJHtwYXJzZWQuY29tbWFuZH0gc291cmNlLmApICsgXCJcXG5cIik7XG5cdFx0c3RkZXJyLndyaXRlKGNoYWxrLmRpbShgVXNhZ2U6ICR7Z2V0UGFja2FnZUNvbW1hbmRVc2FnZShvcHRpb25zLmFwcE5hbWUsIHBhcnNlZC5jb21tYW5kKX1gKSArIFwiXFxuXCIpO1xuXHRcdHJldHVybiB7IGhhbmRsZWQ6IHRydWUsIGV4aXRDb2RlOiAxIH07XG5cdH1cblxuXHRjb25zdCBzZXR0aW5nc01hbmFnZXIgPSBTZXR0aW5nc01hbmFnZXIuY3JlYXRlKG9wdGlvbnMuY3dkLCBvcHRpb25zLmFnZW50RGlyKTtcblx0cmVwb3J0U2V0dGluZ3NFcnJvcnMoc2V0dGluZ3NNYW5hZ2VyLCBcInBhY2thZ2UgY29tbWFuZFwiLCBzdGRlcnIpO1xuXHRjb25zdCBwYWNrYWdlTWFuYWdlciA9IG5ldyBEZWZhdWx0UGFja2FnZU1hbmFnZXIoe1xuXHRcdGN3ZDogb3B0aW9ucy5jd2QsXG5cdFx0YWdlbnREaXI6IG9wdGlvbnMuYWdlbnREaXIsXG5cdFx0c2V0dGluZ3NNYW5hZ2VyLFxuXHR9KTtcblx0cGFja2FnZU1hbmFnZXIuc2V0UHJvZ3Jlc3NDYWxsYmFjaygoZXZlbnQpID0+IHtcblx0XHRpZiAoZXZlbnQudHlwZSA9PT0gXCJzdGFydFwiICYmIGV2ZW50Lm1lc3NhZ2UpIHtcblx0XHRcdHN0ZG91dC53cml0ZShjaGFsay5kaW0oYCR7ZXZlbnQubWVzc2FnZX1cXG5gKSk7XG5cdFx0fVxuXHR9KTtcblxuXHR0cnkge1xuXHRcdHN3aXRjaCAocGFyc2VkLmNvbW1hbmQpIHtcblx0XHRcdGNhc2UgXCJpbnN0YWxsXCI6IHtcblx0XHRcdFx0Y29uc3QgbGlmZWN5Y2xlT3B0aW9ucyA9IHtcblx0XHRcdFx0XHRzb3VyY2U6IHNvdXJjZSEsXG5cdFx0XHRcdFx0bG9jYWw6IHBhcnNlZC5sb2NhbCxcblx0XHRcdFx0XHRjd2Q6IG9wdGlvbnMuY3dkLFxuXHRcdFx0XHRcdGFnZW50RGlyOiBvcHRpb25zLmFnZW50RGlyLFxuXHRcdFx0XHRcdGFwcE5hbWU6IG9wdGlvbnMuYXBwTmFtZSxcblx0XHRcdFx0XHRwYWNrYWdlTWFuYWdlcixcblx0XHRcdFx0XHRzdGRvdXQsXG5cdFx0XHRcdFx0c3RkZXJyLFxuXHRcdFx0XHR9O1xuXG5cdFx0XHRcdGNvbnN0IGJlZm9yZUluc3RhbGxIb29rcyA9IGF3YWl0IHByZXBhcmVMaWZlY3ljbGVIb29rcyhsaWZlY3ljbGVPcHRpb25zLCBcInNvdXJjZVwiKTtcblx0XHRcdFx0Y29uc3QgYmVmb3JlSW5zdGFsbFJlc3VsdCA9IGF3YWl0IHJ1bkxpZmVjeWNsZUhvb2tzKGJlZm9yZUluc3RhbGxIb29rcywgXCJiZWZvcmVJbnN0YWxsXCIpO1xuXG5cdFx0XHRcdGF3YWl0IHBhY2thZ2VNYW5hZ2VyLmluc3RhbGwoc291cmNlISwgeyBsb2NhbDogcGFyc2VkLmxvY2FsIH0pO1xuXHRcdFx0XHRwYWNrYWdlTWFuYWdlci5hZGRTb3VyY2VUb1NldHRpbmdzKHNvdXJjZSEsIHsgbG9jYWw6IHBhcnNlZC5sb2NhbCB9KTtcblxuXHRcdFx0XHRjb25zdCBhZnRlckluc3RhbGxIb29rcyA9IGF3YWl0IHByZXBhcmVMaWZlY3ljbGVIb29rcyhsaWZlY3ljbGVPcHRpb25zLCBcImluc3RhbGxlZFwiLCB7XG5cdFx0XHRcdFx0dmVyaWZ5UnVudGltZURlcGVuZGVuY2llczogdHJ1ZSxcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGNvbnN0IGFmdGVySW5zdGFsbFJlc3VsdCA9IGF3YWl0IHJ1bkxpZmVjeWNsZUhvb2tzKGFmdGVySW5zdGFsbEhvb2tzLCBcImFmdGVySW5zdGFsbFwiKTtcblxuXHRcdFx0XHRjb25zdCBob29rRXJyb3JzID0gYmVmb3JlSW5zdGFsbFJlc3VsdC5ob29rRXJyb3JzICsgYWZ0ZXJJbnN0YWxsUmVzdWx0Lmhvb2tFcnJvcnM7XG5cdFx0XHRcdGlmIChob29rRXJyb3JzID4gMCkge1xuXHRcdFx0XHRcdHN0ZGVyci53cml0ZShjaGFsay55ZWxsb3coYExpZmVjeWNsZSBob29rcyBjb21wbGV0ZWQgd2l0aCAke2hvb2tFcnJvcnN9IGhvb2sgZXJyb3IocykuYCkgKyBcIlxcblwiKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRzdGRvdXQud3JpdGUoY2hhbGsuZ3JlZW4oYEluc3RhbGxlZCAke3NvdXJjZX1gKSArIFwiXFxuXCIpO1xuXHRcdFx0XHRyZXR1cm4geyBoYW5kbGVkOiB0cnVlLCBleGl0Q29kZTogMCB9O1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwicmVtb3ZlXCI6IHtcblx0XHRcdFx0Y29uc3QgbGlmZWN5Y2xlT3B0aW9ucyA9IHtcblx0XHRcdFx0XHRzb3VyY2U6IHNvdXJjZSEsXG5cdFx0XHRcdFx0bG9jYWw6IHBhcnNlZC5sb2NhbCxcblx0XHRcdFx0XHRjd2Q6IG9wdGlvbnMuY3dkLFxuXHRcdFx0XHRcdGFnZW50RGlyOiBvcHRpb25zLmFnZW50RGlyLFxuXHRcdFx0XHRcdGFwcE5hbWU6IG9wdGlvbnMuYXBwTmFtZSxcblx0XHRcdFx0XHRwYWNrYWdlTWFuYWdlcixcblx0XHRcdFx0XHRzdGRvdXQsXG5cdFx0XHRcdFx0c3RkZXJyLFxuXHRcdFx0XHR9O1xuXHRcdFx0XHRjb25zdCByZW1vdmVIb29rcyA9IGF3YWl0IHByZXBhcmVMaWZlY3ljbGVIb29rcyhsaWZlY3ljbGVPcHRpb25zLCBcImluc3RhbGxlZFwiKTtcblx0XHRcdFx0Y29uc3QgYmVmb3JlUmVtb3ZlUmVzdWx0ID0gYXdhaXQgcnVuTGlmZWN5Y2xlSG9va3MocmVtb3ZlSG9va3MsIFwiYmVmb3JlUmVtb3ZlXCIpO1xuXG5cdFx0XHRcdGF3YWl0IHBhY2thZ2VNYW5hZ2VyLnJlbW92ZShzb3VyY2UhLCB7IGxvY2FsOiBwYXJzZWQubG9jYWwgfSk7XG5cdFx0XHRcdGNvbnN0IHJlbW92ZWQgPSBwYWNrYWdlTWFuYWdlci5yZW1vdmVTb3VyY2VGcm9tU2V0dGluZ3Moc291cmNlISwgeyBsb2NhbDogcGFyc2VkLmxvY2FsIH0pO1xuXG5cdFx0XHRcdGNvbnN0IGFmdGVyUmVtb3ZlUmVzdWx0ID0gYXdhaXQgcnVuTGlmZWN5Y2xlSG9va3MocmVtb3ZlSG9va3MsIFwiYWZ0ZXJSZW1vdmVcIik7XG5cdFx0XHRcdGNvbnN0IGhvb2tFcnJvcnMgPSBiZWZvcmVSZW1vdmVSZXN1bHQuaG9va0Vycm9ycyArIGFmdGVyUmVtb3ZlUmVzdWx0Lmhvb2tFcnJvcnM7XG5cdFx0XHRcdGlmIChob29rRXJyb3JzID4gMCkge1xuXHRcdFx0XHRcdHN0ZGVyci53cml0ZShjaGFsay55ZWxsb3coYExpZmVjeWNsZSBob29rcyBjb21wbGV0ZWQgd2l0aCAke2hvb2tFcnJvcnN9IGhvb2sgZXJyb3IocykuYCkgKyBcIlxcblwiKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmICghcmVtb3ZlZCkge1xuXHRcdFx0XHRcdHN0ZGVyci53cml0ZShjaGFsay5yZWQoYE5vIG1hdGNoaW5nIHBhY2thZ2UgZm91bmQgZm9yICR7c291cmNlfWApICsgXCJcXG5cIik7XG5cdFx0XHRcdFx0cmV0dXJuIHsgaGFuZGxlZDogdHJ1ZSwgZXhpdENvZGU6IDEgfTtcblx0XHRcdFx0fVxuXHRcdFx0XHRzdGRvdXQud3JpdGUoY2hhbGsuZ3JlZW4oYFJlbW92ZWQgJHtzb3VyY2V9YCkgKyBcIlxcblwiKTtcblx0XHRcdFx0cmV0dXJuIHsgaGFuZGxlZDogdHJ1ZSwgZXhpdENvZGU6IDAgfTtcblx0XHRcdH1cblxuXHRcdFx0Y2FzZSBcImxpc3RcIjoge1xuXHRcdFx0XHRjb25zdCBnbG9iYWxTZXR0aW5ncyA9IHNldHRpbmdzTWFuYWdlci5nZXRHbG9iYWxTZXR0aW5ncygpO1xuXHRcdFx0XHRjb25zdCBwcm9qZWN0U2V0dGluZ3MgPSBzZXR0aW5nc01hbmFnZXIuZ2V0UHJvamVjdFNldHRpbmdzKCk7XG5cdFx0XHRcdGNvbnN0IGdsb2JhbFBhY2thZ2VzID0gZ2xvYmFsU2V0dGluZ3MucGFja2FnZXMgPz8gW107XG5cdFx0XHRcdGNvbnN0IHByb2plY3RQYWNrYWdlcyA9IHByb2plY3RTZXR0aW5ncy5wYWNrYWdlcyA/PyBbXTtcblxuXHRcdFx0XHRpZiAoZ2xvYmFsUGFja2FnZXMubGVuZ3RoID09PSAwICYmIHByb2plY3RQYWNrYWdlcy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHRzdGRvdXQud3JpdGUoY2hhbGsuZGltKFwiTm8gcGFja2FnZXMgaW5zdGFsbGVkLlwiKSArIFwiXFxuXCIpO1xuXHRcdFx0XHRcdHJldHVybiB7IGhhbmRsZWQ6IHRydWUsIGV4aXRDb2RlOiAwIH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCBmb3JtYXRQYWNrYWdlID0gKHBrZzogKHR5cGVvZiBnbG9iYWxQYWNrYWdlcylbbnVtYmVyXSwgc2NvcGU6IFwidXNlclwiIHwgXCJwcm9qZWN0XCIpID0+IHtcblx0XHRcdFx0XHRjb25zdCBwa2dTb3VyY2UgPSB0eXBlb2YgcGtnID09PSBcInN0cmluZ1wiID8gcGtnIDogcGtnLnNvdXJjZTtcblx0XHRcdFx0XHRjb25zdCBmaWx0ZXJlZCA9IHR5cGVvZiBwa2cgPT09IFwib2JqZWN0XCI7XG5cdFx0XHRcdFx0Y29uc3QgZGlzcGxheSA9IGZpbHRlcmVkID8gYCR7cGtnU291cmNlfSAoZmlsdGVyZWQpYCA6IHBrZ1NvdXJjZTtcblx0XHRcdFx0XHRzdGRvdXQud3JpdGUoYCAgJHtkaXNwbGF5fVxcbmApO1xuXHRcdFx0XHRcdGNvbnN0IHBhdGggPSBwYWNrYWdlTWFuYWdlci5nZXRJbnN0YWxsZWRQYXRoKHBrZ1NvdXJjZSwgc2NvcGUpO1xuXHRcdFx0XHRcdGlmIChwYXRoKSB7XG5cdFx0XHRcdFx0XHRzdGRvdXQud3JpdGUoY2hhbGsuZGltKGAgICAgJHtwYXRofWApICsgXCJcXG5cIik7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9O1xuXG5cdFx0XHRcdGlmIChnbG9iYWxQYWNrYWdlcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0c3Rkb3V0LndyaXRlKGNoYWxrLmJvbGQoXCJVc2VyIHBhY2thZ2VzOlwiKSArIFwiXFxuXCIpO1xuXHRcdFx0XHRcdGZvciAoY29uc3QgcGtnIG9mIGdsb2JhbFBhY2thZ2VzKSB7XG5cdFx0XHRcdFx0XHRmb3JtYXRQYWNrYWdlKHBrZywgXCJ1c2VyXCIpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChwcm9qZWN0UGFja2FnZXMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRcdGlmIChnbG9iYWxQYWNrYWdlcy5sZW5ndGggPiAwKSBzdGRvdXQud3JpdGUoXCJcXG5cIik7XG5cdFx0XHRcdFx0c3Rkb3V0LndyaXRlKGNoYWxrLmJvbGQoXCJQcm9qZWN0IHBhY2thZ2VzOlwiKSArIFwiXFxuXCIpO1xuXHRcdFx0XHRcdGZvciAoY29uc3QgcGtnIG9mIHByb2plY3RQYWNrYWdlcykge1xuXHRcdFx0XHRcdFx0Zm9ybWF0UGFja2FnZShwa2csIFwicHJvamVjdFwiKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRyZXR1cm4geyBoYW5kbGVkOiB0cnVlLCBleGl0Q29kZTogMCB9O1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwidXBkYXRlXCI6XG5cdFx0XHRcdGF3YWl0IHBhY2thZ2VNYW5hZ2VyLnVwZGF0ZShzb3VyY2UpO1xuXHRcdFx0XHRpZiAoc291cmNlKSB7XG5cdFx0XHRcdFx0c3Rkb3V0LndyaXRlKGNoYWxrLmdyZWVuKGBVcGRhdGVkICR7c291cmNlfWApICsgXCJcXG5cIik7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0c3Rkb3V0LndyaXRlKGNoYWxrLmdyZWVuKFwiVXBkYXRlZCBwYWNrYWdlc1wiKSArIFwiXFxuXCIpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiB7IGhhbmRsZWQ6IHRydWUsIGV4aXRDb2RlOiAwIH07XG5cdFx0fVxuXHR9IGNhdGNoIChlcnJvcikge1xuXHRcdGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFwiVW5rbm93biBwYWNrYWdlIGNvbW1hbmQgZXJyb3JcIjtcblx0XHRzdGRlcnIud3JpdGUoY2hhbGsucmVkKGBFcnJvcjogJHttZXNzYWdlfWApICsgXCJcXG5cIik7XG5cdFx0cmV0dXJuIHsgaGFuZGxlZDogdHJ1ZSwgZXhpdENvZGU6IDEgfTtcblx0fVxufVxu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
