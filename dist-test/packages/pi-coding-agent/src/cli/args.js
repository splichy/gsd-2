import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../config.js";
import { allTools } from "../core/tools/index.js";
const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
function isValidThinkingLevel(level) {
  return VALID_THINKING_LEVELS.includes(level);
}
function parseArgs(args, extensionFlags) {
  const result = {
    messages: [],
    fileArgs: [],
    unknownFlags: /* @__PURE__ */ new Map()
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--version" || arg === "-v") {
      result.version = true;
    } else if (arg === "--mode" && i + 1 < args.length) {
      const mode = args[++i];
      if (mode === "text" || mode === "json" || mode === "rpc") {
        result.mode = mode;
      }
    } else if (arg === "--continue" || arg === "-c") {
      result.continue = true;
    } else if (arg === "--resume" || arg === "-r") {
      result.resume = true;
    } else if (arg === "--provider" && i + 1 < args.length) {
      result.provider = args[++i];
    } else if (arg === "--model" && i + 1 < args.length) {
      result.model = args[++i];
    } else if (arg === "--api-key" && i + 1 < args.length) {
      result.apiKey = args[++i];
    } else if (arg === "--system-prompt" && i + 1 < args.length) {
      result.systemPrompt = args[++i];
    } else if (arg === "--append-system-prompt" && i + 1 < args.length) {
      result.appendSystemPrompt = args[++i];
    } else if (arg === "--no-session") {
      result.noSession = true;
    } else if (arg === "--session" && i + 1 < args.length) {
      result.session = args[++i];
    } else if (arg === "--session-dir" && i + 1 < args.length) {
      result.sessionDir = args[++i];
    } else if (arg === "--models" && i + 1 < args.length) {
      result.models = args[++i].split(",").map((s) => s.trim());
    } else if (arg === "--no-tools") {
      result.noTools = true;
    } else if (arg === "--tools" && i + 1 < args.length) {
      const toolNames = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
      const builtinByLower = new Map(
        Object.keys(allTools).map((n) => [n.toLowerCase(), n])
      );
      const validTools = [];
      const extras = [];
      for (const name of toolNames) {
        const builtin = builtinByLower.get(name.toLowerCase());
        if (builtin) {
          validTools.push(builtin);
        } else {
          extras.push(name);
        }
      }
      result.tools = validTools;
      if (extras.length > 0) result.extraToolNames = extras;
    } else if (arg === "--thinking" && i + 1 < args.length) {
      const level = args[++i];
      if (isValidThinkingLevel(level)) {
        result.thinking = level;
      } else {
        console.error(
          chalk.yellow(
            `Warning: Invalid thinking level "${level}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`
          )
        );
      }
    } else if (arg === "--print" || arg === "-p") {
      result.print = true;
    } else if (arg === "--export" && i + 1 < args.length) {
      result.export = args[++i];
    } else if ((arg === "--extension" || arg === "-e") && i + 1 < args.length) {
      result.extensions = result.extensions ?? [];
      result.extensions.push(args[++i]);
    } else if (arg === "--no-extensions" || arg === "-ne") {
      result.noExtensions = true;
    } else if (arg === "--skill" && i + 1 < args.length) {
      result.skills = result.skills ?? [];
      result.skills.push(args[++i]);
    } else if (arg === "--prompt-template" && i + 1 < args.length) {
      result.promptTemplates = result.promptTemplates ?? [];
      result.promptTemplates.push(args[++i]);
    } else if (arg === "--theme" && i + 1 < args.length) {
      result.themes = result.themes ?? [];
      result.themes.push(args[++i]);
    } else if (arg === "--no-skills" || arg === "-ns") {
      result.noSkills = true;
    } else if (arg === "--no-prompt-templates" || arg === "-np") {
      result.noPromptTemplates = true;
    } else if (arg === "--no-themes") {
      result.noThemes = true;
    } else if (arg === "--list-models") {
      if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
        result.listModels = args[++i];
      } else {
        result.listModels = true;
      }
    } else if (arg === "--discover") {
      result.discover = true;
    } else if (arg === "--add-provider" && i + 1 < args.length) {
      result.addProvider = args[++i];
    } else if (arg === "--base-url" && i + 1 < args.length) {
      result.addProviderBaseUrl = args[++i];
    } else if (arg === "--discover-models") {
      if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
        result.discoverModels = args[++i];
      } else {
        result.discoverModels = true;
      }
    } else if (arg === "--verbose") {
      result.verbose = true;
    } else if (arg === "--bare") {
      result.bare = true;
    } else if (arg === "--offline") {
      result.offline = true;
    } else if (arg.startsWith("@")) {
      result.fileArgs.push(arg.slice(1));
    } else if (arg.startsWith("--") && extensionFlags) {
      const flagName = arg.slice(2);
      const extFlag = extensionFlags.get(flagName);
      if (extFlag) {
        if (extFlag.type === "boolean") {
          result.unknownFlags.set(flagName, true);
        } else if (extFlag.type === "string" && i + 1 < args.length) {
          result.unknownFlags.set(flagName, args[++i]);
        }
      }
    } else if (!arg.startsWith("-")) {
      result.messages.push(arg);
    }
  }
  return result;
}
function printHelp() {
  console.log(`${chalk.bold(APP_NAME)} - AI coding assistant with read, bash, edit, write tools

${chalk.bold("Usage:")}
  ${APP_NAME} [options] [@files...] [messages...]

${chalk.bold("Commands:")}
  ${APP_NAME} install <source> [-l]    Install extension source and add to settings
  ${APP_NAME} remove <source> [-l]     Remove extension source from settings
  ${APP_NAME} update [source]          Update installed extensions (skips pinned sources)
  ${APP_NAME} list                     List installed extensions from settings
  ${APP_NAME} config                   Open TUI to enable/disable package resources
  ${APP_NAME} <command> --help         Show help for install/remove/update/list

${chalk.bold("Options:")}
  --provider <name>              Provider name (default: google)
  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --api-key <key>                API key (defaults to env vars)
  --system-prompt <text>         System prompt (default: coding assistant prompt)
  --append-system-prompt <text>  Append text or file contents to the system prompt
  --mode <mode>                  Output mode: text (default), json, or rpc
  --print, -p                    Non-interactive mode: process prompt and exit
  --continue, -c                 Continue previous session
  --resume, -r                   Select a session to resume
  --session <path>               Use specific session file
  --session-dir <dir>            Directory for session storage and lookup
  --no-session                   Don't save session (ephemeral)
  --models <patterns>            Comma-separated model patterns for Ctrl+P cycling
                                 Supports globs (anthropic/*, *sonnet*) and fuzzy matching
  --no-tools                     Disable all built-in tools
  --tools <tools>                Comma-separated list of tools to enable (default: read,bash,edit,write)
                                 Available: read, bash, edit, write, lsp, grep, find, ls
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh
  --extension, -e <path>         Load an extension file (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery (explicit -e paths still work)
  --skill <path>                 Load a skill file or directory (can be used multiple times)
  --no-skills, -ns               Disable skills discovery and loading
  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)
  --no-prompt-templates, -np     Disable prompt template discovery and loading
  --theme <path>                 Load a theme file or directory (can be used multiple times)
  --no-themes                    Disable theme discovery and loading
  --export <file>                Export session file to HTML and exit
  --list-models [search]         List available models (with optional fuzzy search)
  --discover                     Include discovered models in --list-models output
  --discover-models [provider]   Discover models from provider APIs (all or specific)
  --add-provider <name>          Add a provider to models.json (use with --base-url, --api-key)
  --base-url <url>               Base URL for --add-provider
  --verbose                      Force verbose startup (overrides quietStartup setting)
  --offline                      Disable startup network operations (same as PI_OFFLINE=1)
  --help, -h                     Show this help
  --version, -v                  Show version number

Extensions can register additional flags (e.g., --plan from plan-mode extension).

${chalk.bold("Examples:")}
  # Interactive mode
  ${APP_NAME}

  # Interactive mode with initial prompt
  ${APP_NAME} "List all .ts files in src/"

  # Include files in initial message
  ${APP_NAME} @prompt.md @image.png "What color is the sky?"

  # Non-interactive mode (process and exit)
  ${APP_NAME} -p "List all .ts files in src/"

  # Multiple messages (interactive)
  ${APP_NAME} "Read package.json" "What dependencies do we have?"

  # Continue previous session
  ${APP_NAME} --continue "What did we discuss?"

  # Use different model
  ${APP_NAME} --provider openai --model gpt-4o-mini "Help me refactor this code"

  # Use model with provider prefix (no --provider needed)
  ${APP_NAME} --model openai/gpt-4o "Help me refactor this code"

  # Use model with thinking level shorthand
  ${APP_NAME} --model sonnet:high "Solve this complex problem"

  # Limit model cycling to specific models
  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o

  # Limit to a specific provider with glob pattern
  ${APP_NAME} --models "github-copilot/*"

  # Cycle models with fixed thinking levels
  ${APP_NAME} --models sonnet:high,haiku:low

  # Start with a specific thinking level
  ${APP_NAME} --thinking high "Solve this complex problem"

  # Read-only mode (no file modifications possible)
  ${APP_NAME} --tools read,grep,find,ls -p "Review the code in src/"

  # Export a session file to HTML
  ${APP_NAME} --export ~/${CONFIG_DIR_NAME}/agent/sessions/--path--/session.jsonl
  ${APP_NAME} --export session.jsonl output.html

${chalk.bold("Environment Variables:")}
  ANTHROPIC_API_KEY                - Anthropic Claude API key
  ANTHROPIC_OAUTH_TOKEN            - Anthropic OAuth token (alternative to API key)
  OPENAI_API_KEY                   - OpenAI GPT API key
  AZURE_OPENAI_API_KEY             - Azure OpenAI API key
  AZURE_OPENAI_BASE_URL            - Azure OpenAI base URL (https://{resource}.openai.azure.com/openai/v1)
  AZURE_OPENAI_RESOURCE_NAME       - Azure OpenAI resource name (alternative to base URL)
  AZURE_OPENAI_API_VERSION         - Azure OpenAI API version (default: v1)
  AZURE_OPENAI_DEPLOYMENT_NAME_MAP - Azure OpenAI model=deployment map (comma-separated)
  GEMINI_API_KEY                   - Google Gemini API key
  GROQ_API_KEY                     - Groq API key
  CEREBRAS_API_KEY                 - Cerebras API key
  XAI_API_KEY                      - xAI Grok API key
  OPENROUTER_API_KEY               - OpenRouter API key
  AI_GATEWAY_API_KEY               - Vercel AI Gateway API key
  ZAI_API_KEY                      - ZAI API key
  MISTRAL_API_KEY                  - Mistral API key
  OLLAMA_API_KEY                   - Ollama Cloud API key
  MINIMAX_API_KEY                  - MiniMax API key
  OPENCODE_API_KEY                 - OpenCode Zen/OpenCode Go API key
  KIMI_API_KEY                     - Kimi For Coding API key
  AWS_PROFILE                      - AWS profile for Amazon Bedrock
  AWS_ACCESS_KEY_ID                - AWS access key for Amazon Bedrock
  AWS_SECRET_ACCESS_KEY            - AWS secret key for Amazon Bedrock
  AWS_BEARER_TOKEN_BEDROCK         - Bedrock API key (bearer token)
  AWS_REGION                       - AWS region for Amazon Bedrock (e.g., us-east-1)
  ${ENV_AGENT_DIR.padEnd(32)} - Session storage directory (default: ~/${CONFIG_DIR_NAME}/agent)
  PI_PACKAGE_DIR                   - Override package directory (for Nix/Guix store paths)
  PI_OFFLINE                       - Disable startup network operations when set to 1/true/yes
  PI_SHARE_VIEWER_URL              - Base URL for /share command (default: https://pi.dev/session/)
  PI_AI_ANTIGRAVITY_VERSION        - Override Antigravity User-Agent version (e.g., 1.23.0)

${chalk.bold("Available Tools (default: read, bash, edit, write):")}
  read   - Read file contents
  bash   - Execute bash commands
  edit   - Edit files with find/replace
  write  - Write files (creates/overwrites)
  grep   - Search file contents (read-only, off by default)
  find   - Find files by glob pattern (read-only, off by default)
  ls     - List directory contents (read-only, off by default)
`);
}
export {
  isValidThinkingLevel,
  parseArgs,
  printHelp
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jbGkvYXJncy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBDTEkgYXJndW1lbnQgcGFyc2luZyBhbmQgaGVscCBkaXNwbGF5XG4gKi9cblxuaW1wb3J0IHR5cGUgeyBUaGlua2luZ0xldmVsIH0gZnJvbSBcIkBnc2QvcGktYWdlbnQtY29yZVwiO1xuaW1wb3J0IGNoYWxrIGZyb20gXCJjaGFsa1wiO1xuaW1wb3J0IHsgQVBQX05BTUUsIENPTkZJR19ESVJfTkFNRSwgRU5WX0FHRU5UX0RJUiB9IGZyb20gXCIuLi9jb25maWcuanNcIjtcbmltcG9ydCB7IGFsbFRvb2xzLCB0eXBlIFRvb2xOYW1lIH0gZnJvbSBcIi4uL2NvcmUvdG9vbHMvaW5kZXguanNcIjtcblxuZXhwb3J0IHR5cGUgTW9kZSA9IFwidGV4dFwiIHwgXCJqc29uXCIgfCBcInJwY1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFyZ3Mge1xuXHRwcm92aWRlcj86IHN0cmluZztcblx0bW9kZWw/OiBzdHJpbmc7XG5cdGFwaUtleT86IHN0cmluZztcblx0c3lzdGVtUHJvbXB0Pzogc3RyaW5nO1xuXHRhcHBlbmRTeXN0ZW1Qcm9tcHQ/OiBzdHJpbmc7XG5cdHRoaW5raW5nPzogVGhpbmtpbmdMZXZlbDtcblx0Y29udGludWU/OiBib29sZWFuO1xuXHRyZXN1bWU/OiBib29sZWFuO1xuXHRoZWxwPzogYm9vbGVhbjtcblx0dmVyc2lvbj86IGJvb2xlYW47XG5cdG1vZGU/OiBNb2RlO1xuXHRub1Nlc3Npb24/OiBib29sZWFuO1xuXHRzZXNzaW9uPzogc3RyaW5nO1xuXHRzZXNzaW9uRGlyPzogc3RyaW5nO1xuXHRtb2RlbHM/OiBzdHJpbmdbXTtcblx0dG9vbHM/OiBUb29sTmFtZVtdO1xuXHQvKipcblx0ICogVG9vbCBuYW1lcyBmcm9tIC0tdG9vbHMgdGhhdCBkaWQgbm90IG1hdGNoIGEgYnVpbHQtaW4uIFRoZXNlIGFyZVxuXHQgKiBkZWZlcnJlZCB0byBleHRlbnNpb24vTUNQIHRvb2wgcmVzb2x1dGlvbiBhZnRlciBleHRlbnNpb25zIHJlZ2lzdGVyXG5cdCAqIHRoZWlyIHRvb2xzIGluIHRoZSBhZ2VudCBydW50aW1lLlxuXHQgKi9cblx0ZXh0cmFUb29sTmFtZXM/OiBzdHJpbmdbXTtcblx0bm9Ub29scz86IGJvb2xlYW47XG5cdGV4dGVuc2lvbnM/OiBzdHJpbmdbXTtcblx0bm9FeHRlbnNpb25zPzogYm9vbGVhbjtcblx0cHJpbnQ/OiBib29sZWFuO1xuXHRleHBvcnQ/OiBzdHJpbmc7XG5cdG5vU2tpbGxzPzogYm9vbGVhbjtcblx0c2tpbGxzPzogc3RyaW5nW107XG5cdHByb21wdFRlbXBsYXRlcz86IHN0cmluZ1tdO1xuXHRub1Byb21wdFRlbXBsYXRlcz86IGJvb2xlYW47XG5cdHRoZW1lcz86IHN0cmluZ1tdO1xuXHRub1RoZW1lcz86IGJvb2xlYW47XG5cdGxpc3RNb2RlbHM/OiBzdHJpbmcgfCB0cnVlO1xuXHRkaXNjb3Zlcj86IGJvb2xlYW47XG5cdGFkZFByb3ZpZGVyPzogc3RyaW5nO1xuXHRhZGRQcm92aWRlckJhc2VVcmw/OiBzdHJpbmc7XG5cdGFkZFByb3ZpZGVyQXBpS2V5Pzogc3RyaW5nO1xuXHRkaXNjb3Zlck1vZGVscz86IHN0cmluZyB8IHRydWU7XG5cdG9mZmxpbmU/OiBib29sZWFuO1xuXHR2ZXJib3NlPzogYm9vbGVhbjtcblx0bWVzc2FnZXM6IHN0cmluZ1tdO1xuXHRmaWxlQXJnczogc3RyaW5nW107XG5cdC8qKiBVbmtub3duIGZsYWdzIChwb3RlbnRpYWxseSBleHRlbnNpb24gZmxhZ3MpIC0gbWFwIG9mIGZsYWcgbmFtZSB0byB2YWx1ZSAqL1xuXHR1bmtub3duRmxhZ3M6IE1hcDxzdHJpbmcsIGJvb2xlYW4gfCBzdHJpbmc+O1xuXHQvKiogLS1iYXJlOiBzdXBwcmVzcyBDTEFVREUubWQvQUdFTlRTLm1kLCB1c2VyIHNraWxscywgcHJvbXB0IHRlbXBsYXRlcywgdGhlbWVzLCBwcm9qZWN0IHByZWZlcmVuY2VzICovXG5cdGJhcmU/OiBib29sZWFuO1xufVxuXG5jb25zdCBWQUxJRF9USElOS0lOR19MRVZFTFMgPSBbXCJvZmZcIiwgXCJtaW5pbWFsXCIsIFwibG93XCIsIFwibWVkaXVtXCIsIFwiaGlnaFwiLCBcInhoaWdoXCJdIGFzIGNvbnN0O1xuXG5leHBvcnQgZnVuY3Rpb24gaXNWYWxpZFRoaW5raW5nTGV2ZWwobGV2ZWw6IHN0cmluZyk6IGxldmVsIGlzIFRoaW5raW5nTGV2ZWwge1xuXHRyZXR1cm4gVkFMSURfVEhJTktJTkdfTEVWRUxTLmluY2x1ZGVzKGxldmVsIGFzIFRoaW5raW5nTGV2ZWwpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VBcmdzKGFyZ3M6IHN0cmluZ1tdLCBleHRlbnNpb25GbGFncz86IE1hcDxzdHJpbmcsIHsgdHlwZTogXCJib29sZWFuXCIgfCBcInN0cmluZ1wiIH0+KTogQXJncyB7XG5cdGNvbnN0IHJlc3VsdDogQXJncyA9IHtcblx0XHRtZXNzYWdlczogW10sXG5cdFx0ZmlsZUFyZ3M6IFtdLFxuXHRcdHVua25vd25GbGFnczogbmV3IE1hcCgpLFxuXHR9O1xuXG5cdGZvciAobGV0IGkgPSAwOyBpIDwgYXJncy5sZW5ndGg7IGkrKykge1xuXHRcdGNvbnN0IGFyZyA9IGFyZ3NbaV07XG5cblx0XHRpZiAoYXJnID09PSBcIi0taGVscFwiIHx8IGFyZyA9PT0gXCItaFwiKSB7XG5cdFx0XHRyZXN1bHQuaGVscCA9IHRydWU7XG5cdFx0fSBlbHNlIGlmIChhcmcgPT09IFwiLS12ZXJzaW9uXCIgfHwgYXJnID09PSBcIi12XCIpIHtcblx0XHRcdHJlc3VsdC52ZXJzaW9uID0gdHJ1ZTtcblx0XHR9IGVsc2UgaWYgKGFyZyA9PT0gXCItLW1vZGVcIiAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG5cdFx0XHRjb25zdCBtb2RlID0gYXJnc1srK2ldO1xuXHRcdFx0aWYgKG1vZGUgPT09IFwidGV4dFwiIHx8IG1vZGUgPT09IFwianNvblwiIHx8IG1vZGUgPT09IFwicnBjXCIpIHtcblx0XHRcdFx0cmVzdWx0Lm1vZGUgPSBtb2RlO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAoYXJnID09PSBcIi0tY29udGludWVcIiB8fCBhcmcgPT09IFwiLWNcIikge1xuXHRcdFx0cmVzdWx0LmNvbnRpbnVlID0gdHJ1ZTtcblx0XHR9IGVsc2UgaWYgKGFyZyA9PT0gXCItLXJlc3VtZVwiIHx8IGFyZyA9PT0gXCItclwiKSB7XG5cdFx0XHRyZXN1bHQucmVzdW1lID0gdHJ1ZTtcblx0XHR9IGVsc2UgaWYgKGFyZyA9PT0gXCItLXByb3ZpZGVyXCIgJiYgaSArIDEgPCBhcmdzLmxlbmd0aCkge1xuXHRcdFx0cmVzdWx0LnByb3ZpZGVyID0gYXJnc1srK2ldO1xuXHRcdH0gZWxzZSBpZiAoYXJnID09PSBcIi0tbW9kZWxcIiAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG5cdFx0XHRyZXN1bHQubW9kZWwgPSBhcmdzWysraV07XG5cdFx0fSBlbHNlIGlmIChhcmcgPT09IFwiLS1hcGkta2V5XCIgJiYgaSArIDEgPCBhcmdzLmxlbmd0aCkge1xuXHRcdFx0cmVzdWx0LmFwaUtleSA9IGFyZ3NbKytpXTtcblx0XHR9IGVsc2UgaWYgKGFyZyA9PT0gXCItLXN5c3RlbS1wcm9tcHRcIiAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG5cdFx0XHRyZXN1bHQuc3lzdGVtUHJvbXB0ID0gYXJnc1srK2ldO1xuXHRcdH0gZWxzZSBpZiAoYXJnID09PSBcIi0tYXBwZW5kLXN5c3RlbS1wcm9tcHRcIiAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG5cdFx0XHRyZXN1bHQuYXBwZW5kU3lzdGVtUHJvbXB0ID0gYXJnc1srK2ldO1xuXHRcdH0gZWxzZSBpZiAoYXJnID09PSBcIi0tbm8tc2Vzc2lvblwiKSB7XG5cdFx0XHRyZXN1bHQubm9TZXNzaW9uID0gdHJ1ZTtcblx0XHR9IGVsc2UgaWYgKGFyZyA9PT0gXCItLXNlc3Npb25cIiAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG5cdFx0XHRyZXN1bHQuc2Vzc2lvbiA9IGFyZ3NbKytpXTtcblx0XHR9IGVsc2UgaWYgKGFyZyA9PT0gXCItLXNlc3Npb24tZGlyXCIgJiYgaSArIDEgPCBhcmdzLmxlbmd0aCkge1xuXHRcdFx0cmVzdWx0LnNlc3Npb25EaXIgPSBhcmdzWysraV07XG5cdFx0fSBlbHNlIGlmIChhcmcgPT09IFwiLS1tb2RlbHNcIiAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG5cdFx0XHRyZXN1bHQubW9kZWxzID0gYXJnc1srK2ldLnNwbGl0KFwiLFwiKS5tYXAoKHMpID0+IHMudHJpbSgpKTtcblx0XHR9IGVsc2UgaWYgKGFyZyA9PT0gXCItLW5vLXRvb2xzXCIpIHtcblx0XHRcdHJlc3VsdC5ub1Rvb2xzID0gdHJ1ZTtcblx0XHR9IGVsc2UgaWYgKGFyZyA9PT0gXCItLXRvb2xzXCIgJiYgaSArIDEgPCBhcmdzLmxlbmd0aCkge1xuXHRcdFx0Y29uc3QgdG9vbE5hbWVzID0gYXJnc1srK2ldLnNwbGl0KFwiLFwiKS5tYXAoKHMpID0+IHMudHJpbSgpKS5maWx0ZXIoQm9vbGVhbik7XG5cdFx0XHQvLyBCdWlsdC1pbiByZWdpc3RyeSBrZXlzIGFyZSBsb3dlcmNhc2UuIE1hdGNoIGNhc2UtaW5zZW5zaXRpdmVseSBzbyB0aGF0XG5cdFx0XHQvLyBmcm9udG1hdHRlciBsaWtlIGB0b29sczogUmVhZCwgQmFzaGAgcmVzb2x2ZXMgY29ycmVjdGx5LlxuXHRcdFx0Y29uc3QgYnVpbHRpbkJ5TG93ZXIgPSBuZXcgTWFwPHN0cmluZywgVG9vbE5hbWU+KFxuXHRcdFx0XHRPYmplY3Qua2V5cyhhbGxUb29scykubWFwKChuKSA9PiBbbi50b0xvd2VyQ2FzZSgpLCBuIGFzIFRvb2xOYW1lXSksXG5cdFx0XHQpO1xuXHRcdFx0Y29uc3QgdmFsaWRUb29sczogVG9vbE5hbWVbXSA9IFtdO1xuXHRcdFx0Y29uc3QgZXh0cmFzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdFx0Zm9yIChjb25zdCBuYW1lIG9mIHRvb2xOYW1lcykge1xuXHRcdFx0XHRjb25zdCBidWlsdGluID0gYnVpbHRpbkJ5TG93ZXIuZ2V0KG5hbWUudG9Mb3dlckNhc2UoKSk7XG5cdFx0XHRcdGlmIChidWlsdGluKSB7XG5cdFx0XHRcdFx0dmFsaWRUb29scy5wdXNoKGJ1aWx0aW4pO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdC8vIERlZmVyOiB0aGlzIG1heSBiZSBhbiBleHRlbnNpb24vTUNQLXByb3ZpZGVkIHRvb2wgdGhhdCBoYXMgbm90XG5cdFx0XHRcdFx0Ly8gYmVlbiByZWdpc3RlcmVkIHlldCBhdCBwYXJzZSB0aW1lLiBSZXNvbHV0aW9uIGhhcHBlbnMgYWZ0ZXJcblx0XHRcdFx0XHQvLyBleHRlbnNpb25zIGxvYWQgaW4gQWdlbnRTZXNzaW9uLl9idWlsZFJ1bnRpbWUuXG5cdFx0XHRcdFx0ZXh0cmFzLnB1c2gobmFtZSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdHJlc3VsdC50b29scyA9IHZhbGlkVG9vbHM7XG5cdFx0XHRpZiAoZXh0cmFzLmxlbmd0aCA+IDApIHJlc3VsdC5leHRyYVRvb2xOYW1lcyA9IGV4dHJhcztcblx0XHR9IGVsc2UgaWYgKGFyZyA9PT0gXCItLXRoaW5raW5nXCIgJiYgaSArIDEgPCBhcmdzLmxlbmd0aCkge1xuXHRcdFx0Y29uc3QgbGV2ZWwgPSBhcmdzWysraV07XG5cdFx0XHRpZiAoaXNWYWxpZFRoaW5raW5nTGV2ZWwobGV2ZWwpKSB7XG5cdFx0XHRcdHJlc3VsdC50aGlua2luZyA9IGxldmVsO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihcblx0XHRcdFx0XHRjaGFsay55ZWxsb3coXG5cdFx0XHRcdFx0XHRgV2FybmluZzogSW52YWxpZCB0aGlua2luZyBsZXZlbCBcIiR7bGV2ZWx9XCIuIFZhbGlkIHZhbHVlczogJHtWQUxJRF9USElOS0lOR19MRVZFTFMuam9pbihcIiwgXCIpfWAsXG5cdFx0XHRcdFx0KSxcblx0XHRcdFx0KTtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKGFyZyA9PT0gXCItLXByaW50XCIgfHwgYXJnID09PSBcIi1wXCIpIHtcblx0XHRcdHJlc3VsdC5wcmludCA9IHRydWU7XG5cdFx0fSBlbHNlIGlmIChhcmcgPT09IFwiLS1leHBvcnRcIiAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG5cdFx0XHRyZXN1bHQuZXhwb3J0ID0gYXJnc1srK2ldO1xuXHRcdH0gZWxzZSBpZiAoKGFyZyA9PT0gXCItLWV4dGVuc2lvblwiIHx8IGFyZyA9PT0gXCItZVwiKSAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG5cdFx0XHRyZXN1bHQuZXh0ZW5zaW9ucyA9IHJlc3VsdC5leHRlbnNpb25zID8/IFtdO1xuXHRcdFx0cmVzdWx0LmV4dGVuc2lvbnMucHVzaChhcmdzWysraV0pO1xuXHRcdH0gZWxzZSBpZiAoYXJnID09PSBcIi0tbm8tZXh0ZW5zaW9uc1wiIHx8IGFyZyA9PT0gXCItbmVcIikge1xuXHRcdFx0cmVzdWx0Lm5vRXh0ZW5zaW9ucyA9IHRydWU7XG5cdFx0fSBlbHNlIGlmIChhcmcgPT09IFwiLS1za2lsbFwiICYmIGkgKyAxIDwgYXJncy5sZW5ndGgpIHtcblx0XHRcdHJlc3VsdC5za2lsbHMgPSByZXN1bHQuc2tpbGxzID8/IFtdO1xuXHRcdFx0cmVzdWx0LnNraWxscy5wdXNoKGFyZ3NbKytpXSk7XG5cdFx0fSBlbHNlIGlmIChhcmcgPT09IFwiLS1wcm9tcHQtdGVtcGxhdGVcIiAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG5cdFx0XHRyZXN1bHQucHJvbXB0VGVtcGxhdGVzID0gcmVzdWx0LnByb21wdFRlbXBsYXRlcyA/PyBbXTtcblx0XHRcdHJlc3VsdC5wcm9tcHRUZW1wbGF0ZXMucHVzaChhcmdzWysraV0pO1xuXHRcdH0gZWxzZSBpZiAoYXJnID09PSBcIi0tdGhlbWVcIiAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG5cdFx0XHRyZXN1bHQudGhlbWVzID0gcmVzdWx0LnRoZW1lcyA/PyBbXTtcblx0XHRcdHJlc3VsdC50aGVtZXMucHVzaChhcmdzWysraV0pO1xuXHRcdH0gZWxzZSBpZiAoYXJnID09PSBcIi0tbm8tc2tpbGxzXCIgfHwgYXJnID09PSBcIi1uc1wiKSB7XG5cdFx0XHRyZXN1bHQubm9Ta2lsbHMgPSB0cnVlO1xuXHRcdH0gZWxzZSBpZiAoYXJnID09PSBcIi0tbm8tcHJvbXB0LXRlbXBsYXRlc1wiIHx8IGFyZyA9PT0gXCItbnBcIikge1xuXHRcdFx0cmVzdWx0Lm5vUHJvbXB0VGVtcGxhdGVzID0gdHJ1ZTtcblx0XHR9IGVsc2UgaWYgKGFyZyA9PT0gXCItLW5vLXRoZW1lc1wiKSB7XG5cdFx0XHRyZXN1bHQubm9UaGVtZXMgPSB0cnVlO1xuXHRcdH0gZWxzZSBpZiAoYXJnID09PSBcIi0tbGlzdC1tb2RlbHNcIikge1xuXHRcdFx0Ly8gQ2hlY2sgaWYgbmV4dCBhcmcgaXMgYSBzZWFyY2ggcGF0dGVybiAobm90IGEgZmxhZyBvciBmaWxlIGFyZylcblx0XHRcdGlmIChpICsgMSA8IGFyZ3MubGVuZ3RoICYmICFhcmdzW2kgKyAxXS5zdGFydHNXaXRoKFwiLVwiKSAmJiAhYXJnc1tpICsgMV0uc3RhcnRzV2l0aChcIkBcIikpIHtcblx0XHRcdFx0cmVzdWx0Lmxpc3RNb2RlbHMgPSBhcmdzWysraV07XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRyZXN1bHQubGlzdE1vZGVscyA9IHRydWU7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIGlmIChhcmcgPT09IFwiLS1kaXNjb3ZlclwiKSB7XG5cdFx0XHRyZXN1bHQuZGlzY292ZXIgPSB0cnVlO1xuXHRcdH0gZWxzZSBpZiAoYXJnID09PSBcIi0tYWRkLXByb3ZpZGVyXCIgJiYgaSArIDEgPCBhcmdzLmxlbmd0aCkge1xuXHRcdFx0cmVzdWx0LmFkZFByb3ZpZGVyID0gYXJnc1srK2ldO1xuXHRcdH0gZWxzZSBpZiAoYXJnID09PSBcIi0tYmFzZS11cmxcIiAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG5cdFx0XHRyZXN1bHQuYWRkUHJvdmlkZXJCYXNlVXJsID0gYXJnc1srK2ldO1xuXHRcdH0gZWxzZSBpZiAoYXJnID09PSBcIi0tZGlzY292ZXItbW9kZWxzXCIpIHtcblx0XHRcdGlmIChpICsgMSA8IGFyZ3MubGVuZ3RoICYmICFhcmdzW2kgKyAxXS5zdGFydHNXaXRoKFwiLVwiKSAmJiAhYXJnc1tpICsgMV0uc3RhcnRzV2l0aChcIkBcIikpIHtcblx0XHRcdFx0cmVzdWx0LmRpc2NvdmVyTW9kZWxzID0gYXJnc1srK2ldO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0cmVzdWx0LmRpc2NvdmVyTW9kZWxzID0gdHJ1ZTtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKGFyZyA9PT0gXCItLXZlcmJvc2VcIikge1xuXHRcdFx0cmVzdWx0LnZlcmJvc2UgPSB0cnVlO1xuXHRcdH0gZWxzZSBpZiAoYXJnID09PSBcIi0tYmFyZVwiKSB7XG5cdFx0XHRyZXN1bHQuYmFyZSA9IHRydWU7XG5cdFx0fSBlbHNlIGlmIChhcmcgPT09IFwiLS1vZmZsaW5lXCIpIHtcblx0XHRcdHJlc3VsdC5vZmZsaW5lID0gdHJ1ZTtcblx0XHR9IGVsc2UgaWYgKGFyZy5zdGFydHNXaXRoKFwiQFwiKSkge1xuXHRcdFx0cmVzdWx0LmZpbGVBcmdzLnB1c2goYXJnLnNsaWNlKDEpKTsgLy8gUmVtb3ZlIEAgcHJlZml4XG5cdFx0fSBlbHNlIGlmIChhcmcuc3RhcnRzV2l0aChcIi0tXCIpICYmIGV4dGVuc2lvbkZsYWdzKSB7XG5cdFx0XHQvLyBDaGVjayBpZiBpdCdzIGFuIGV4dGVuc2lvbi1yZWdpc3RlcmVkIGZsYWdcblx0XHRcdGNvbnN0IGZsYWdOYW1lID0gYXJnLnNsaWNlKDIpO1xuXHRcdFx0Y29uc3QgZXh0RmxhZyA9IGV4dGVuc2lvbkZsYWdzLmdldChmbGFnTmFtZSk7XG5cdFx0XHRpZiAoZXh0RmxhZykge1xuXHRcdFx0XHRpZiAoZXh0RmxhZy50eXBlID09PSBcImJvb2xlYW5cIikge1xuXHRcdFx0XHRcdHJlc3VsdC51bmtub3duRmxhZ3Muc2V0KGZsYWdOYW1lLCB0cnVlKTtcblx0XHRcdFx0fSBlbHNlIGlmIChleHRGbGFnLnR5cGUgPT09IFwic3RyaW5nXCIgJiYgaSArIDEgPCBhcmdzLmxlbmd0aCkge1xuXHRcdFx0XHRcdHJlc3VsdC51bmtub3duRmxhZ3Muc2V0KGZsYWdOYW1lLCBhcmdzWysraV0pO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHQvLyBVbmtub3duIGZsYWdzIHdpdGhvdXQgZXh0ZW5zaW9uRmxhZ3MgYXJlIHNpbGVudGx5IGlnbm9yZWQgKGZpcnN0IHBhc3MpXG5cdFx0fSBlbHNlIGlmICghYXJnLnN0YXJ0c1dpdGgoXCItXCIpKSB7XG5cdFx0XHRyZXN1bHQubWVzc2FnZXMucHVzaChhcmcpO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiByZXN1bHQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwcmludEhlbHAoKTogdm9pZCB7XG5cdGNvbnNvbGUubG9nKGAke2NoYWxrLmJvbGQoQVBQX05BTUUpfSAtIEFJIGNvZGluZyBhc3Npc3RhbnQgd2l0aCByZWFkLCBiYXNoLCBlZGl0LCB3cml0ZSB0b29sc1xuXG4ke2NoYWxrLmJvbGQoXCJVc2FnZTpcIil9XG4gICR7QVBQX05BTUV9IFtvcHRpb25zXSBbQGZpbGVzLi4uXSBbbWVzc2FnZXMuLi5dXG5cbiR7Y2hhbGsuYm9sZChcIkNvbW1hbmRzOlwiKX1cbiAgJHtBUFBfTkFNRX0gaW5zdGFsbCA8c291cmNlPiBbLWxdICAgIEluc3RhbGwgZXh0ZW5zaW9uIHNvdXJjZSBhbmQgYWRkIHRvIHNldHRpbmdzXG4gICR7QVBQX05BTUV9IHJlbW92ZSA8c291cmNlPiBbLWxdICAgICBSZW1vdmUgZXh0ZW5zaW9uIHNvdXJjZSBmcm9tIHNldHRpbmdzXG4gICR7QVBQX05BTUV9IHVwZGF0ZSBbc291cmNlXSAgICAgICAgICBVcGRhdGUgaW5zdGFsbGVkIGV4dGVuc2lvbnMgKHNraXBzIHBpbm5lZCBzb3VyY2VzKVxuICAke0FQUF9OQU1FfSBsaXN0ICAgICAgICAgICAgICAgICAgICAgTGlzdCBpbnN0YWxsZWQgZXh0ZW5zaW9ucyBmcm9tIHNldHRpbmdzXG4gICR7QVBQX05BTUV9IGNvbmZpZyAgICAgICAgICAgICAgICAgICBPcGVuIFRVSSB0byBlbmFibGUvZGlzYWJsZSBwYWNrYWdlIHJlc291cmNlc1xuICAke0FQUF9OQU1FfSA8Y29tbWFuZD4gLS1oZWxwICAgICAgICAgU2hvdyBoZWxwIGZvciBpbnN0YWxsL3JlbW92ZS91cGRhdGUvbGlzdFxuXG4ke2NoYWxrLmJvbGQoXCJPcHRpb25zOlwiKX1cbiAgLS1wcm92aWRlciA8bmFtZT4gICAgICAgICAgICAgIFByb3ZpZGVyIG5hbWUgKGRlZmF1bHQ6IGdvb2dsZSlcbiAgLS1tb2RlbCA8cGF0dGVybj4gICAgICAgICAgICAgIE1vZGVsIHBhdHRlcm4gb3IgSUQgKHN1cHBvcnRzIFwicHJvdmlkZXIvaWRcIiBhbmQgb3B0aW9uYWwgXCI6PHRoaW5raW5nPlwiKVxuICAtLWFwaS1rZXkgPGtleT4gICAgICAgICAgICAgICAgQVBJIGtleSAoZGVmYXVsdHMgdG8gZW52IHZhcnMpXG4gIC0tc3lzdGVtLXByb21wdCA8dGV4dD4gICAgICAgICBTeXN0ZW0gcHJvbXB0IChkZWZhdWx0OiBjb2RpbmcgYXNzaXN0YW50IHByb21wdClcbiAgLS1hcHBlbmQtc3lzdGVtLXByb21wdCA8dGV4dD4gIEFwcGVuZCB0ZXh0IG9yIGZpbGUgY29udGVudHMgdG8gdGhlIHN5c3RlbSBwcm9tcHRcbiAgLS1tb2RlIDxtb2RlPiAgICAgICAgICAgICAgICAgIE91dHB1dCBtb2RlOiB0ZXh0IChkZWZhdWx0KSwganNvbiwgb3IgcnBjXG4gIC0tcHJpbnQsIC1wICAgICAgICAgICAgICAgICAgICBOb24taW50ZXJhY3RpdmUgbW9kZTogcHJvY2VzcyBwcm9tcHQgYW5kIGV4aXRcbiAgLS1jb250aW51ZSwgLWMgICAgICAgICAgICAgICAgIENvbnRpbnVlIHByZXZpb3VzIHNlc3Npb25cbiAgLS1yZXN1bWUsIC1yICAgICAgICAgICAgICAgICAgIFNlbGVjdCBhIHNlc3Npb24gdG8gcmVzdW1lXG4gIC0tc2Vzc2lvbiA8cGF0aD4gICAgICAgICAgICAgICBVc2Ugc3BlY2lmaWMgc2Vzc2lvbiBmaWxlXG4gIC0tc2Vzc2lvbi1kaXIgPGRpcj4gICAgICAgICAgICBEaXJlY3RvcnkgZm9yIHNlc3Npb24gc3RvcmFnZSBhbmQgbG9va3VwXG4gIC0tbm8tc2Vzc2lvbiAgICAgICAgICAgICAgICAgICBEb24ndCBzYXZlIHNlc3Npb24gKGVwaGVtZXJhbClcbiAgLS1tb2RlbHMgPHBhdHRlcm5zPiAgICAgICAgICAgIENvbW1hLXNlcGFyYXRlZCBtb2RlbCBwYXR0ZXJucyBmb3IgQ3RybCtQIGN5Y2xpbmdcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFN1cHBvcnRzIGdsb2JzIChhbnRocm9waWMvKiwgKnNvbm5ldCopIGFuZCBmdXp6eSBtYXRjaGluZ1xuICAtLW5vLXRvb2xzICAgICAgICAgICAgICAgICAgICAgRGlzYWJsZSBhbGwgYnVpbHQtaW4gdG9vbHNcbiAgLS10b29scyA8dG9vbHM+ICAgICAgICAgICAgICAgIENvbW1hLXNlcGFyYXRlZCBsaXN0IG9mIHRvb2xzIHRvIGVuYWJsZSAoZGVmYXVsdDogcmVhZCxiYXNoLGVkaXQsd3JpdGUpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBBdmFpbGFibGU6IHJlYWQsIGJhc2gsIGVkaXQsIHdyaXRlLCBsc3AsIGdyZXAsIGZpbmQsIGxzXG4gIC0tdGhpbmtpbmcgPGxldmVsPiAgICAgICAgICAgICBTZXQgdGhpbmtpbmcgbGV2ZWw6IG9mZiwgbWluaW1hbCwgbG93LCBtZWRpdW0sIGhpZ2gsIHhoaWdoXG4gIC0tZXh0ZW5zaW9uLCAtZSA8cGF0aD4gICAgICAgICBMb2FkIGFuIGV4dGVuc2lvbiBmaWxlIChjYW4gYmUgdXNlZCBtdWx0aXBsZSB0aW1lcylcbiAgLS1uby1leHRlbnNpb25zLCAtbmUgICAgICAgICAgIERpc2FibGUgZXh0ZW5zaW9uIGRpc2NvdmVyeSAoZXhwbGljaXQgLWUgcGF0aHMgc3RpbGwgd29yaylcbiAgLS1za2lsbCA8cGF0aD4gICAgICAgICAgICAgICAgIExvYWQgYSBza2lsbCBmaWxlIG9yIGRpcmVjdG9yeSAoY2FuIGJlIHVzZWQgbXVsdGlwbGUgdGltZXMpXG4gIC0tbm8tc2tpbGxzLCAtbnMgICAgICAgICAgICAgICBEaXNhYmxlIHNraWxscyBkaXNjb3ZlcnkgYW5kIGxvYWRpbmdcbiAgLS1wcm9tcHQtdGVtcGxhdGUgPHBhdGg+ICAgICAgIExvYWQgYSBwcm9tcHQgdGVtcGxhdGUgZmlsZSBvciBkaXJlY3RvcnkgKGNhbiBiZSB1c2VkIG11bHRpcGxlIHRpbWVzKVxuICAtLW5vLXByb21wdC10ZW1wbGF0ZXMsIC1ucCAgICAgRGlzYWJsZSBwcm9tcHQgdGVtcGxhdGUgZGlzY292ZXJ5IGFuZCBsb2FkaW5nXG4gIC0tdGhlbWUgPHBhdGg+ICAgICAgICAgICAgICAgICBMb2FkIGEgdGhlbWUgZmlsZSBvciBkaXJlY3RvcnkgKGNhbiBiZSB1c2VkIG11bHRpcGxlIHRpbWVzKVxuICAtLW5vLXRoZW1lcyAgICAgICAgICAgICAgICAgICAgRGlzYWJsZSB0aGVtZSBkaXNjb3ZlcnkgYW5kIGxvYWRpbmdcbiAgLS1leHBvcnQgPGZpbGU+ICAgICAgICAgICAgICAgIEV4cG9ydCBzZXNzaW9uIGZpbGUgdG8gSFRNTCBhbmQgZXhpdFxuICAtLWxpc3QtbW9kZWxzIFtzZWFyY2hdICAgICAgICAgTGlzdCBhdmFpbGFibGUgbW9kZWxzICh3aXRoIG9wdGlvbmFsIGZ1enp5IHNlYXJjaClcbiAgLS1kaXNjb3ZlciAgICAgICAgICAgICAgICAgICAgIEluY2x1ZGUgZGlzY292ZXJlZCBtb2RlbHMgaW4gLS1saXN0LW1vZGVscyBvdXRwdXRcbiAgLS1kaXNjb3Zlci1tb2RlbHMgW3Byb3ZpZGVyXSAgIERpc2NvdmVyIG1vZGVscyBmcm9tIHByb3ZpZGVyIEFQSXMgKGFsbCBvciBzcGVjaWZpYylcbiAgLS1hZGQtcHJvdmlkZXIgPG5hbWU+ICAgICAgICAgIEFkZCBhIHByb3ZpZGVyIHRvIG1vZGVscy5qc29uICh1c2Ugd2l0aCAtLWJhc2UtdXJsLCAtLWFwaS1rZXkpXG4gIC0tYmFzZS11cmwgPHVybD4gICAgICAgICAgICAgICBCYXNlIFVSTCBmb3IgLS1hZGQtcHJvdmlkZXJcbiAgLS12ZXJib3NlICAgICAgICAgICAgICAgICAgICAgIEZvcmNlIHZlcmJvc2Ugc3RhcnR1cCAob3ZlcnJpZGVzIHF1aWV0U3RhcnR1cCBzZXR0aW5nKVxuICAtLW9mZmxpbmUgICAgICAgICAgICAgICAgICAgICAgRGlzYWJsZSBzdGFydHVwIG5ldHdvcmsgb3BlcmF0aW9ucyAoc2FtZSBhcyBQSV9PRkZMSU5FPTEpXG4gIC0taGVscCwgLWggICAgICAgICAgICAgICAgICAgICBTaG93IHRoaXMgaGVscFxuICAtLXZlcnNpb24sIC12ICAgICAgICAgICAgICAgICAgU2hvdyB2ZXJzaW9uIG51bWJlclxuXG5FeHRlbnNpb25zIGNhbiByZWdpc3RlciBhZGRpdGlvbmFsIGZsYWdzIChlLmcuLCAtLXBsYW4gZnJvbSBwbGFuLW1vZGUgZXh0ZW5zaW9uKS5cblxuJHtjaGFsay5ib2xkKFwiRXhhbXBsZXM6XCIpfVxuICAjIEludGVyYWN0aXZlIG1vZGVcbiAgJHtBUFBfTkFNRX1cblxuICAjIEludGVyYWN0aXZlIG1vZGUgd2l0aCBpbml0aWFsIHByb21wdFxuICAke0FQUF9OQU1FfSBcIkxpc3QgYWxsIC50cyBmaWxlcyBpbiBzcmMvXCJcblxuICAjIEluY2x1ZGUgZmlsZXMgaW4gaW5pdGlhbCBtZXNzYWdlXG4gICR7QVBQX05BTUV9IEBwcm9tcHQubWQgQGltYWdlLnBuZyBcIldoYXQgY29sb3IgaXMgdGhlIHNreT9cIlxuXG4gICMgTm9uLWludGVyYWN0aXZlIG1vZGUgKHByb2Nlc3MgYW5kIGV4aXQpXG4gICR7QVBQX05BTUV9IC1wIFwiTGlzdCBhbGwgLnRzIGZpbGVzIGluIHNyYy9cIlxuXG4gICMgTXVsdGlwbGUgbWVzc2FnZXMgKGludGVyYWN0aXZlKVxuICAke0FQUF9OQU1FfSBcIlJlYWQgcGFja2FnZS5qc29uXCIgXCJXaGF0IGRlcGVuZGVuY2llcyBkbyB3ZSBoYXZlP1wiXG5cbiAgIyBDb250aW51ZSBwcmV2aW91cyBzZXNzaW9uXG4gICR7QVBQX05BTUV9IC0tY29udGludWUgXCJXaGF0IGRpZCB3ZSBkaXNjdXNzP1wiXG5cbiAgIyBVc2UgZGlmZmVyZW50IG1vZGVsXG4gICR7QVBQX05BTUV9IC0tcHJvdmlkZXIgb3BlbmFpIC0tbW9kZWwgZ3B0LTRvLW1pbmkgXCJIZWxwIG1lIHJlZmFjdG9yIHRoaXMgY29kZVwiXG5cbiAgIyBVc2UgbW9kZWwgd2l0aCBwcm92aWRlciBwcmVmaXggKG5vIC0tcHJvdmlkZXIgbmVlZGVkKVxuICAke0FQUF9OQU1FfSAtLW1vZGVsIG9wZW5haS9ncHQtNG8gXCJIZWxwIG1lIHJlZmFjdG9yIHRoaXMgY29kZVwiXG5cbiAgIyBVc2UgbW9kZWwgd2l0aCB0aGlua2luZyBsZXZlbCBzaG9ydGhhbmRcbiAgJHtBUFBfTkFNRX0gLS1tb2RlbCBzb25uZXQ6aGlnaCBcIlNvbHZlIHRoaXMgY29tcGxleCBwcm9ibGVtXCJcblxuICAjIExpbWl0IG1vZGVsIGN5Y2xpbmcgdG8gc3BlY2lmaWMgbW9kZWxzXG4gICR7QVBQX05BTUV9IC0tbW9kZWxzIGNsYXVkZS1zb25uZXQsY2xhdWRlLWhhaWt1LGdwdC00b1xuXG4gICMgTGltaXQgdG8gYSBzcGVjaWZpYyBwcm92aWRlciB3aXRoIGdsb2IgcGF0dGVyblxuICAke0FQUF9OQU1FfSAtLW1vZGVscyBcImdpdGh1Yi1jb3BpbG90LypcIlxuXG4gICMgQ3ljbGUgbW9kZWxzIHdpdGggZml4ZWQgdGhpbmtpbmcgbGV2ZWxzXG4gICR7QVBQX05BTUV9IC0tbW9kZWxzIHNvbm5ldDpoaWdoLGhhaWt1Omxvd1xuXG4gICMgU3RhcnQgd2l0aCBhIHNwZWNpZmljIHRoaW5raW5nIGxldmVsXG4gICR7QVBQX05BTUV9IC0tdGhpbmtpbmcgaGlnaCBcIlNvbHZlIHRoaXMgY29tcGxleCBwcm9ibGVtXCJcblxuICAjIFJlYWQtb25seSBtb2RlIChubyBmaWxlIG1vZGlmaWNhdGlvbnMgcG9zc2libGUpXG4gICR7QVBQX05BTUV9IC0tdG9vbHMgcmVhZCxncmVwLGZpbmQsbHMgLXAgXCJSZXZpZXcgdGhlIGNvZGUgaW4gc3JjL1wiXG5cbiAgIyBFeHBvcnQgYSBzZXNzaW9uIGZpbGUgdG8gSFRNTFxuICAke0FQUF9OQU1FfSAtLWV4cG9ydCB+LyR7Q09ORklHX0RJUl9OQU1FfS9hZ2VudC9zZXNzaW9ucy8tLXBhdGgtLS9zZXNzaW9uLmpzb25sXG4gICR7QVBQX05BTUV9IC0tZXhwb3J0IHNlc3Npb24uanNvbmwgb3V0cHV0Lmh0bWxcblxuJHtjaGFsay5ib2xkKFwiRW52aXJvbm1lbnQgVmFyaWFibGVzOlwiKX1cbiAgQU5USFJPUElDX0FQSV9LRVkgICAgICAgICAgICAgICAgLSBBbnRocm9waWMgQ2xhdWRlIEFQSSBrZXlcbiAgQU5USFJPUElDX09BVVRIX1RPS0VOICAgICAgICAgICAgLSBBbnRocm9waWMgT0F1dGggdG9rZW4gKGFsdGVybmF0aXZlIHRvIEFQSSBrZXkpXG4gIE9QRU5BSV9BUElfS0VZICAgICAgICAgICAgICAgICAgIC0gT3BlbkFJIEdQVCBBUEkga2V5XG4gIEFaVVJFX09QRU5BSV9BUElfS0VZICAgICAgICAgICAgIC0gQXp1cmUgT3BlbkFJIEFQSSBrZXlcbiAgQVpVUkVfT1BFTkFJX0JBU0VfVVJMICAgICAgICAgICAgLSBBenVyZSBPcGVuQUkgYmFzZSBVUkwgKGh0dHBzOi8ve3Jlc291cmNlfS5vcGVuYWkuYXp1cmUuY29tL29wZW5haS92MSlcbiAgQVpVUkVfT1BFTkFJX1JFU09VUkNFX05BTUUgICAgICAgLSBBenVyZSBPcGVuQUkgcmVzb3VyY2UgbmFtZSAoYWx0ZXJuYXRpdmUgdG8gYmFzZSBVUkwpXG4gIEFaVVJFX09QRU5BSV9BUElfVkVSU0lPTiAgICAgICAgIC0gQXp1cmUgT3BlbkFJIEFQSSB2ZXJzaW9uIChkZWZhdWx0OiB2MSlcbiAgQVpVUkVfT1BFTkFJX0RFUExPWU1FTlRfTkFNRV9NQVAgLSBBenVyZSBPcGVuQUkgbW9kZWw9ZGVwbG95bWVudCBtYXAgKGNvbW1hLXNlcGFyYXRlZClcbiAgR0VNSU5JX0FQSV9LRVkgICAgICAgICAgICAgICAgICAgLSBHb29nbGUgR2VtaW5pIEFQSSBrZXlcbiAgR1JPUV9BUElfS0VZICAgICAgICAgICAgICAgICAgICAgLSBHcm9xIEFQSSBrZXlcbiAgQ0VSRUJSQVNfQVBJX0tFWSAgICAgICAgICAgICAgICAgLSBDZXJlYnJhcyBBUEkga2V5XG4gIFhBSV9BUElfS0VZICAgICAgICAgICAgICAgICAgICAgIC0geEFJIEdyb2sgQVBJIGtleVxuICBPUEVOUk9VVEVSX0FQSV9LRVkgICAgICAgICAgICAgICAtIE9wZW5Sb3V0ZXIgQVBJIGtleVxuICBBSV9HQVRFV0FZX0FQSV9LRVkgICAgICAgICAgICAgICAtIFZlcmNlbCBBSSBHYXRld2F5IEFQSSBrZXlcbiAgWkFJX0FQSV9LRVkgICAgICAgICAgICAgICAgICAgICAgLSBaQUkgQVBJIGtleVxuICBNSVNUUkFMX0FQSV9LRVkgICAgICAgICAgICAgICAgICAtIE1pc3RyYWwgQVBJIGtleVxuICBPTExBTUFfQVBJX0tFWSAgICAgICAgICAgICAgICAgICAtIE9sbGFtYSBDbG91ZCBBUEkga2V5XG4gIE1JTklNQVhfQVBJX0tFWSAgICAgICAgICAgICAgICAgIC0gTWluaU1heCBBUEkga2V5XG4gIE9QRU5DT0RFX0FQSV9LRVkgICAgICAgICAgICAgICAgIC0gT3BlbkNvZGUgWmVuL09wZW5Db2RlIEdvIEFQSSBrZXlcbiAgS0lNSV9BUElfS0VZICAgICAgICAgICAgICAgICAgICAgLSBLaW1pIEZvciBDb2RpbmcgQVBJIGtleVxuICBBV1NfUFJPRklMRSAgICAgICAgICAgICAgICAgICAgICAtIEFXUyBwcm9maWxlIGZvciBBbWF6b24gQmVkcm9ja1xuICBBV1NfQUNDRVNTX0tFWV9JRCAgICAgICAgICAgICAgICAtIEFXUyBhY2Nlc3Mga2V5IGZvciBBbWF6b24gQmVkcm9ja1xuICBBV1NfU0VDUkVUX0FDQ0VTU19LRVkgICAgICAgICAgICAtIEFXUyBzZWNyZXQga2V5IGZvciBBbWF6b24gQmVkcm9ja1xuICBBV1NfQkVBUkVSX1RPS0VOX0JFRFJPQ0sgICAgICAgICAtIEJlZHJvY2sgQVBJIGtleSAoYmVhcmVyIHRva2VuKVxuICBBV1NfUkVHSU9OICAgICAgICAgICAgICAgICAgICAgICAtIEFXUyByZWdpb24gZm9yIEFtYXpvbiBCZWRyb2NrIChlLmcuLCB1cy1lYXN0LTEpXG4gICR7RU5WX0FHRU5UX0RJUi5wYWRFbmQoMzIpfSAtIFNlc3Npb24gc3RvcmFnZSBkaXJlY3RvcnkgKGRlZmF1bHQ6IH4vJHtDT05GSUdfRElSX05BTUV9L2FnZW50KVxuICBQSV9QQUNLQUdFX0RJUiAgICAgICAgICAgICAgICAgICAtIE92ZXJyaWRlIHBhY2thZ2UgZGlyZWN0b3J5IChmb3IgTml4L0d1aXggc3RvcmUgcGF0aHMpXG4gIFBJX09GRkxJTkUgICAgICAgICAgICAgICAgICAgICAgIC0gRGlzYWJsZSBzdGFydHVwIG5ldHdvcmsgb3BlcmF0aW9ucyB3aGVuIHNldCB0byAxL3RydWUveWVzXG4gIFBJX1NIQVJFX1ZJRVdFUl9VUkwgICAgICAgICAgICAgIC0gQmFzZSBVUkwgZm9yIC9zaGFyZSBjb21tYW5kIChkZWZhdWx0OiBodHRwczovL3BpLmRldi9zZXNzaW9uLylcbiAgUElfQUlfQU5USUdSQVZJVFlfVkVSU0lPTiAgICAgICAgLSBPdmVycmlkZSBBbnRpZ3Jhdml0eSBVc2VyLUFnZW50IHZlcnNpb24gKGUuZy4sIDEuMjMuMClcblxuJHtjaGFsay5ib2xkKFwiQXZhaWxhYmxlIFRvb2xzIChkZWZhdWx0OiByZWFkLCBiYXNoLCBlZGl0LCB3cml0ZSk6XCIpfVxuICByZWFkICAgLSBSZWFkIGZpbGUgY29udGVudHNcbiAgYmFzaCAgIC0gRXhlY3V0ZSBiYXNoIGNvbW1hbmRzXG4gIGVkaXQgICAtIEVkaXQgZmlsZXMgd2l0aCBmaW5kL3JlcGxhY2VcbiAgd3JpdGUgIC0gV3JpdGUgZmlsZXMgKGNyZWF0ZXMvb3ZlcndyaXRlcylcbiAgZ3JlcCAgIC0gU2VhcmNoIGZpbGUgY29udGVudHMgKHJlYWQtb25seSwgb2ZmIGJ5IGRlZmF1bHQpXG4gIGZpbmQgICAtIEZpbmQgZmlsZXMgYnkgZ2xvYiBwYXR0ZXJuIChyZWFkLW9ubHksIG9mZiBieSBkZWZhdWx0KVxuICBscyAgICAgLSBMaXN0IGRpcmVjdG9yeSBjb250ZW50cyAocmVhZC1vbmx5LCBvZmYgYnkgZGVmYXVsdClcbmApO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBS0EsT0FBTyxXQUFXO0FBQ2xCLFNBQVMsVUFBVSxpQkFBaUIscUJBQXFCO0FBQ3pELFNBQVMsZ0JBQStCO0FBc0R4QyxNQUFNLHdCQUF3QixDQUFDLE9BQU8sV0FBVyxPQUFPLFVBQVUsUUFBUSxPQUFPO0FBRTFFLFNBQVMscUJBQXFCLE9BQXVDO0FBQzNFLFNBQU8sc0JBQXNCLFNBQVMsS0FBc0I7QUFDN0Q7QUFFTyxTQUFTLFVBQVUsTUFBZ0IsZ0JBQW9FO0FBQzdHLFFBQU0sU0FBZTtBQUFBLElBQ3BCLFVBQVUsQ0FBQztBQUFBLElBQ1gsVUFBVSxDQUFDO0FBQUEsSUFDWCxjQUFjLG9CQUFJLElBQUk7QUFBQSxFQUN2QjtBQUVBLFdBQVMsSUFBSSxHQUFHLElBQUksS0FBSyxRQUFRLEtBQUs7QUFDckMsVUFBTSxNQUFNLEtBQUssQ0FBQztBQUVsQixRQUFJLFFBQVEsWUFBWSxRQUFRLE1BQU07QUFDckMsYUFBTyxPQUFPO0FBQUEsSUFDZixXQUFXLFFBQVEsZUFBZSxRQUFRLE1BQU07QUFDL0MsYUFBTyxVQUFVO0FBQUEsSUFDbEIsV0FBVyxRQUFRLFlBQVksSUFBSSxJQUFJLEtBQUssUUFBUTtBQUNuRCxZQUFNLE9BQU8sS0FBSyxFQUFFLENBQUM7QUFDckIsVUFBSSxTQUFTLFVBQVUsU0FBUyxVQUFVLFNBQVMsT0FBTztBQUN6RCxlQUFPLE9BQU87QUFBQSxNQUNmO0FBQUEsSUFDRCxXQUFX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
