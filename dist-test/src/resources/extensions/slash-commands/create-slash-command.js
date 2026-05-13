import { showInterviewRound } from "../shared/tui.js";
function createSlashCommand(pi) {
  pi.registerCommand("create-slash-command", {
    description: "Generate a new slash command extension from a plain-English description",
    async handler(args, ctx) {
      const inlineDescription = (typeof args === "string" ? args : "").trim();
      const questions = [
        ...!inlineDescription ? [
          {
            id: "purpose",
            header: "Purpose",
            question: "What should this slash command do?",
            options: [
              {
                label: "Automate git workflow",
                description: "Commit, branch, diff, stash \u2014 anything git-related."
              },
              {
                label: "Send a crafted prompt",
                description: "Build a rich context prompt and hand it to the LLM."
              },
              {
                label: "Run a shell task",
                description: "Execute CLI tools (npm, docker, etc.) and show the output."
              },
              {
                label: "Something else",
                description: "Describe it in the notes field below."
              }
            ]
          }
        ] : [],
        {
          id: "trigger",
          header: "Trigger",
          question: "How does this command kick off its work?",
          options: [
            {
              label: "Sends to agent",
              description: "Builds a prompt and hands off to the LLM to do the heavy lifting."
            },
            {
              label: "Runs shell commands",
              description: "Executes CLI commands directly (git, npm, etc.) without an LLM turn."
            },
            {
              label: "Shows a UI prompt",
              description: "Pops up a select/input dialog to gather more info, then acts."
            },
            {
              label: "Mixed \u2014 UI then agent",
              description: "Collects some info via a dialog, then sends a crafted prompt to the LLM."
            }
          ]
        },
        {
          id: "output",
          header: "Output",
          question: "How should the command communicate results to the user?",
          options: [
            {
              label: "Agent response",
              description: "The LLM writes the response \u2014 the command just triggers the turn."
            },
            {
              label: "Notification",
              description: "A brief inline notification (success/error/info) \u2014 no agent turn."
            },
            {
              label: "Command output",
              description: "Shows raw shell output or a formatted summary in the chat."
            }
          ]
        },
        {
          id: "args",
          header: "Arguments",
          question: "Does the command take arguments when invoked?",
          options: [
            {
              label: "No args needed",
              description: "Called as just /command-name \u2014 gathers everything it needs at runtime."
            },
            {
              label: "Optional freeform arg",
              description: "User can type /command-name <something>, but it works without it too."
            },
            {
              label: "Required arg",
              description: "Needs a specific value typed after the name; shows usage if missing."
            }
          ]
        },
        {
          id: "complexity",
          header: "Complexity",
          question: "How complex does the implementation need to be?",
          options: [
            {
              label: "Simple \u2014 one action",
              description: "Does one thing in a handful of lines. Easy to follow."
            },
            {
              label: "Moderate \u2014 a few steps",
              description: "Some branching, maybe a shell call or two, a conditional prompt."
            },
            {
              label: "Complex \u2014 multi-step",
              description: "Multiple async steps, error handling, state, or UI interactions."
            }
          ]
        }
      ];
      const result = await showInterviewRound(
        questions,
        {
          progress: "New slash command \xB7 Context",
          reviewHeadline: "Review your choices",
          exitHeadline: "Cancel command creation?",
          exitLabel: "cancel"
        },
        ctx
      );
      if (!result.answers || Object.keys(result.answers).length === 0) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }
      let description = inlineDescription;
      if (!description) {
        const purpose = result.answers["purpose"];
        if (purpose) {
          const selected = Array.isArray(purpose.selected) ? purpose.selected[0] : purpose.selected;
          description = purpose.notes ? purpose.notes : selected;
        }
      }
      if (!description) {
        ctx.ui.notify("No description captured \u2014 add details in the notes field next time.", "warning");
        return;
      }
      sendPrompt(description, result, pi);
    }
  });
}
function formatAnswers(result) {
  const lines = [];
  const purpose = result.answers["purpose"];
  if (purpose?.notes) {
    lines.push(`- **Command goal (user's words)**: ${purpose.notes}`);
  }
  const trigger = result.answers["trigger"];
  if (trigger) {
    const selected = Array.isArray(trigger.selected) ? trigger.selected[0] : trigger.selected;
    lines.push(`- **Trigger pattern**: ${selected}${trigger.notes ? ` \u2014 ${trigger.notes}` : ""}`);
  }
  const output = result.answers["output"];
  if (output) {
    const selected = Array.isArray(output.selected) ? output.selected[0] : output.selected;
    lines.push(`- **Output style**: ${selected}${output.notes ? ` \u2014 ${output.notes}` : ""}`);
  }
  const argsAnswer = result.answers["args"];
  if (argsAnswer) {
    const selected = Array.isArray(argsAnswer.selected) ? argsAnswer.selected[0] : argsAnswer.selected;
    lines.push(`- **Arguments**: ${selected}${argsAnswer.notes ? ` \u2014 ${argsAnswer.notes}` : ""}`);
  }
  const complexity = result.answers["complexity"];
  if (complexity) {
    const selected = Array.isArray(complexity.selected) ? complexity.selected[0] : complexity.selected;
    lines.push(`- **Complexity**: ${selected}${complexity.notes ? ` \u2014 ${complexity.notes}` : ""}`);
  }
  return lines.join("\n");
}
function sendPrompt(description, result, pi) {
  const contextSection = `
## Context gathered from user
${formatAnswers(result)}
`;
  const prompt = `Create a new pi slash command extension based on this description:

"${description}"
${contextSection}
Write the complete file contents for two files:

1. \`~/.gsd/agent/extensions/slash-commands/<name>.ts\` \u2014 the command implementation
2. Update \`~/.gsd/agent/extensions/slash-commands/index.ts\` \u2014 import and register the new command alongside existing ones

Rules you must follow exactly:
- Command registration: \`pi.registerCommand("name", { description, handler })\`
- Handler signature: \`async handler(args: string, ctx: ExtensionCommandContext)\`
- \`args\` is the raw string typed after the command name (may be empty)
- To send a message to the agent: \`pi.sendUserMessage("...")\` \u2014 this triggers an agent turn
- To show a quick notification without triggering a turn: \`ctx.ui.notify("...", "info" | "success" | "error")\`
- To run a shell command: \`await pi.exec("cmd", ["arg1", "arg2"])\` \u2014 returns \`{ stdout, stderr, exitCode }\`
- To show a select dialog: \`await ctx.ui.select("prompt", ["Option A", "Option B"])\` \u2014 returns the chosen string
- To show a text input dialog: \`await ctx.ui.input("prompt", "placeholder")\` \u2014 returns the string or null
- \`pi\` is captured in closure from the outer \`export default function(pi: ExtensionAPI)\` \u2014 use it freely inside the handler
- No \`ctx.session\`, no \`ctx.sendMessage\`, no \`args[]\` array \u2014 these do not exist
- Import type: \`import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";\`
- Export default: \`export default function <camelCaseName>(pi: ExtensionAPI) { ... }\`

After writing the files, run \`/reload\` to load the new command.`;
  pi.sendUserMessage(prompt);
}
export {
  createSlashCommand as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3NsYXNoLWNvbW1hbmRzL2NyZWF0ZS1zbGFzaC1jb21tYW5kLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgc2hvd0ludGVydmlld1JvdW5kLCB0eXBlIFF1ZXN0aW9uLCB0eXBlIFJvdW5kUmVzdWx0IH0gZnJvbSBcIi4uL3NoYXJlZC90dWkuanNcIjtcblxuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gY3JlYXRlU2xhc2hDb21tYW5kKHBpOiBFeHRlbnNpb25BUEkpIHtcblx0cGkucmVnaXN0ZXJDb21tYW5kKFwiY3JlYXRlLXNsYXNoLWNvbW1hbmRcIiwge1xuXHRcdGRlc2NyaXB0aW9uOiBcIkdlbmVyYXRlIGEgbmV3IHNsYXNoIGNvbW1hbmQgZXh0ZW5zaW9uIGZyb20gYSBwbGFpbi1FbmdsaXNoIGRlc2NyaXB0aW9uXCIsXG5cdFx0YXN5bmMgaGFuZGxlcihhcmdzLCBjdHgpIHtcblx0XHRcdGNvbnN0IGlubGluZURlc2NyaXB0aW9uID0gKHR5cGVvZiBhcmdzID09PSBcInN0cmluZ1wiID8gYXJncyA6IFwiXCIpLnRyaW0oKTtcblxuXHRcdFx0Ly8gXHUyNTAwXHUyNTAwIEludGVydmlldyBcdTIwMTQgYWx3YXlzIHJ1biwgbm8gZnJlZS10ZXh0IHN0ZXAgZmlyc3QgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cdFx0XHQvL1xuXHRcdFx0Ly8gSWYgdGhlIHVzZXIgYWxyZWFkeSB0eXBlZCBhIGRlc2NyaXB0aW9uIGFzIGFyZ3MsIHdlIHNraXAgdGhlIFwid2hhdFxuXHRcdFx0Ly8gc2hvdWxkIGl0IGRvP1wiIHF1ZXN0aW9uIGFuZCBnbyBzdHJhaWdodCB0byB0aGUgYmVoYXZpb3VyIHF1ZXN0aW9ucy5cblx0XHRcdC8vIE90aGVyd2lzZSBpdCdzIHRoZSBmaXJzdCBxdWVzdGlvbiBpbiB0aGUgcm91bmQuXG5cblx0XHRcdGNvbnN0IHF1ZXN0aW9uczogUXVlc3Rpb25bXSA9IFtcblx0XHRcdFx0Li4uKCFpbmxpbmVEZXNjcmlwdGlvblxuXHRcdFx0XHRcdD8gW1xuXHRcdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdFx0aWQ6IFwicHVycG9zZVwiLFxuXHRcdFx0XHRcdFx0XHRcdGhlYWRlcjogXCJQdXJwb3NlXCIsXG5cdFx0XHRcdFx0XHRcdFx0cXVlc3Rpb246IFwiV2hhdCBzaG91bGQgdGhpcyBzbGFzaCBjb21tYW5kIGRvP1wiLFxuXHRcdFx0XHRcdFx0XHRcdG9wdGlvbnM6IFtcblx0XHRcdFx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0bGFiZWw6IFwiQXV0b21hdGUgZ2l0IHdvcmtmbG93XCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIkNvbW1pdCwgYnJhbmNoLCBkaWZmLCBzdGFzaCBcdTIwMTQgYW55dGhpbmcgZ2l0LXJlbGF0ZWQuXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRsYWJlbDogXCJTZW5kIGEgY3JhZnRlZCBwcm9tcHRcIixcblx0XHRcdFx0XHRcdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiQnVpbGQgYSByaWNoIGNvbnRleHQgcHJvbXB0IGFuZCBoYW5kIGl0IHRvIHRoZSBMTE0uXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRsYWJlbDogXCJSdW4gYSBzaGVsbCB0YXNrXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIkV4ZWN1dGUgQ0xJIHRvb2xzIChucG0sIGRvY2tlciwgZXRjLikgYW5kIHNob3cgdGhlIG91dHB1dC5cIixcblx0XHRcdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdGxhYmVsOiBcIlNvbWV0aGluZyBlbHNlXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIkRlc2NyaWJlIGl0IGluIHRoZSBub3RlcyBmaWVsZCBiZWxvdy5cIixcblx0XHRcdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRcdFx0fSBzYXRpc2ZpZXMgUXVlc3Rpb24sXG5cdFx0XHRcdFx0XHRdXG5cdFx0XHRcdFx0OiBbXSksXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRpZDogXCJ0cmlnZ2VyXCIsXG5cdFx0XHRcdFx0aGVhZGVyOiBcIlRyaWdnZXJcIixcblx0XHRcdFx0XHRxdWVzdGlvbjogXCJIb3cgZG9lcyB0aGlzIGNvbW1hbmQga2ljayBvZmYgaXRzIHdvcms/XCIsXG5cdFx0XHRcdFx0b3B0aW9uczogW1xuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRsYWJlbDogXCJTZW5kcyB0byBhZ2VudFwiLFxuXHRcdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJCdWlsZHMgYSBwcm9tcHQgYW5kIGhhbmRzIG9mZiB0byB0aGUgTExNIHRvIGRvIHRoZSBoZWF2eSBsaWZ0aW5nLlwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0bGFiZWw6IFwiUnVucyBzaGVsbCBjb21tYW5kc1wiLFxuXHRcdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJFeGVjdXRlcyBDTEkgY29tbWFuZHMgZGlyZWN0bHkgKGdpdCwgbnBtLCBldGMuKSB3aXRob3V0IGFuIExMTSB0dXJuLlwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0bGFiZWw6IFwiU2hvd3MgYSBVSSBwcm9tcHRcIixcblx0XHRcdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiUG9wcyB1cCBhIHNlbGVjdC9pbnB1dCBkaWFsb2cgdG8gZ2F0aGVyIG1vcmUgaW5mbywgdGhlbiBhY3RzLlwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0bGFiZWw6IFwiTWl4ZWQgXHUyMDE0IFVJIHRoZW4gYWdlbnRcIixcblx0XHRcdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiQ29sbGVjdHMgc29tZSBpbmZvIHZpYSBhIGRpYWxvZywgdGhlbiBzZW5kcyBhIGNyYWZ0ZWQgcHJvbXB0IHRvIHRoZSBMTE0uXCIsXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdF0sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRpZDogXCJvdXRwdXRcIixcblx0XHRcdFx0XHRoZWFkZXI6IFwiT3V0cHV0XCIsXG5cdFx0XHRcdFx0cXVlc3Rpb246IFwiSG93IHNob3VsZCB0aGUgY29tbWFuZCBjb21tdW5pY2F0ZSByZXN1bHRzIHRvIHRoZSB1c2VyP1wiLFxuXHRcdFx0XHRcdG9wdGlvbnM6IFtcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0bGFiZWw6IFwiQWdlbnQgcmVzcG9uc2VcIixcblx0XHRcdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiVGhlIExMTSB3cml0ZXMgdGhlIHJlc3BvbnNlIFx1MjAxNCB0aGUgY29tbWFuZCBqdXN0IHRyaWdnZXJzIHRoZSB0dXJuLlwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0bGFiZWw6IFwiTm90aWZpY2F0aW9uXCIsXG5cdFx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIkEgYnJpZWYgaW5saW5lIG5vdGlmaWNhdGlvbiAoc3VjY2Vzcy9lcnJvci9pbmZvKSBcdTIwMTQgbm8gYWdlbnQgdHVybi5cIixcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdGxhYmVsOiBcIkNvbW1hbmQgb3V0cHV0XCIsXG5cdFx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIlNob3dzIHJhdyBzaGVsbCBvdXRwdXQgb3IgYSBmb3JtYXR0ZWQgc3VtbWFyeSBpbiB0aGUgY2hhdC5cIixcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0fSxcblx0XHRcdFx0e1xuXHRcdFx0XHRcdGlkOiBcImFyZ3NcIixcblx0XHRcdFx0XHRoZWFkZXI6IFwiQXJndW1lbnRzXCIsXG5cdFx0XHRcdFx0cXVlc3Rpb246IFwiRG9lcyB0aGUgY29tbWFuZCB0YWtlIGFyZ3VtZW50cyB3aGVuIGludm9rZWQ/XCIsXG5cdFx0XHRcdFx0b3B0aW9uczogW1xuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRsYWJlbDogXCJObyBhcmdzIG5lZWRlZFwiLFxuXHRcdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJDYWxsZWQgYXMganVzdCAvY29tbWFuZC1uYW1lIFx1MjAxNCBnYXRoZXJzIGV2ZXJ5dGhpbmcgaXQgbmVlZHMgYXQgcnVudGltZS5cIixcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdGxhYmVsOiBcIk9wdGlvbmFsIGZyZWVmb3JtIGFyZ1wiLFxuXHRcdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJVc2VyIGNhbiB0eXBlIC9jb21tYW5kLW5hbWUgPHNvbWV0aGluZz4sIGJ1dCBpdCB3b3JrcyB3aXRob3V0IGl0IHRvby5cIixcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdGxhYmVsOiBcIlJlcXVpcmVkIGFyZ1wiLFxuXHRcdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJOZWVkcyBhIHNwZWNpZmljIHZhbHVlIHR5cGVkIGFmdGVyIHRoZSBuYW1lOyBzaG93cyB1c2FnZSBpZiBtaXNzaW5nLlwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHR9LFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0aWQ6IFwiY29tcGxleGl0eVwiLFxuXHRcdFx0XHRcdGhlYWRlcjogXCJDb21wbGV4aXR5XCIsXG5cdFx0XHRcdFx0cXVlc3Rpb246IFwiSG93IGNvbXBsZXggZG9lcyB0aGUgaW1wbGVtZW50YXRpb24gbmVlZCB0byBiZT9cIixcblx0XHRcdFx0XHRvcHRpb25zOiBbXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdGxhYmVsOiBcIlNpbXBsZSBcdTIwMTQgb25lIGFjdGlvblwiLFxuXHRcdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJEb2VzIG9uZSB0aGluZyBpbiBhIGhhbmRmdWwgb2YgbGluZXMuIEVhc3kgdG8gZm9sbG93LlwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0bGFiZWw6IFwiTW9kZXJhdGUgXHUyMDE0IGEgZmV3IHN0ZXBzXCIsXG5cdFx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIlNvbWUgYnJhbmNoaW5nLCBtYXliZSBhIHNoZWxsIGNhbGwgb3IgdHdvLCBhIGNvbmRpdGlvbmFsIHByb21wdC5cIixcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdGxhYmVsOiBcIkNvbXBsZXggXHUyMDE0IG11bHRpLXN0ZXBcIixcblx0XHRcdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiTXVsdGlwbGUgYXN5bmMgc3RlcHMsIGVycm9yIGhhbmRsaW5nLCBzdGF0ZSwgb3IgVUkgaW50ZXJhY3Rpb25zLlwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHR9LFxuXHRcdFx0XTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0OiBSb3VuZFJlc3VsdCA9IGF3YWl0IHNob3dJbnRlcnZpZXdSb3VuZChcblx0XHRcdFx0cXVlc3Rpb25zLFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0cHJvZ3Jlc3M6IFwiTmV3IHNsYXNoIGNvbW1hbmQgXHUwMEI3IENvbnRleHRcIixcblx0XHRcdFx0XHRyZXZpZXdIZWFkbGluZTogXCJSZXZpZXcgeW91ciBjaG9pY2VzXCIsXG5cdFx0XHRcdFx0ZXhpdEhlYWRsaW5lOiBcIkNhbmNlbCBjb21tYW5kIGNyZWF0aW9uP1wiLFxuXHRcdFx0XHRcdGV4aXRMYWJlbDogXCJjYW5jZWxcIixcblx0XHRcdFx0fSxcblx0XHRcdFx0Y3R4LFxuXHRcdFx0KTtcblxuXHRcdFx0Ly8gVXNlciBoaXQgRXNjIHdpdGggbm90aGluZyBhbnN3ZXJlZCBcdTIwMTQgYmFpbCBzaWxlbnRseVxuXHRcdFx0aWYgKCFyZXN1bHQuYW5zd2VycyB8fCBPYmplY3Qua2V5cyhyZXN1bHQuYW5zd2VycykubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdGN0eC51aS5ub3RpZnkoXCJDYW5jZWxsZWQuXCIsIFwiaW5mb1wiKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBcdTI1MDBcdTI1MDAgUmVzb2x2ZSBkZXNjcmlwdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuXHRcdFx0bGV0IGRlc2NyaXB0aW9uID0gaW5saW5lRGVzY3JpcHRpb247XG5cdFx0XHRpZiAoIWRlc2NyaXB0aW9uKSB7XG5cdFx0XHRcdGNvbnN0IHB1cnBvc2UgPSByZXN1bHQuYW5zd2Vyc1tcInB1cnBvc2VcIl07XG5cdFx0XHRcdGlmIChwdXJwb3NlKSB7XG5cdFx0XHRcdFx0Y29uc3Qgc2VsZWN0ZWQgPSBBcnJheS5pc0FycmF5KHB1cnBvc2Uuc2VsZWN0ZWQpID8gcHVycG9zZS5zZWxlY3RlZFswXSA6IHB1cnBvc2Uuc2VsZWN0ZWQ7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb24gPSBwdXJwb3NlLm5vdGVzXG5cdFx0XHRcdFx0XHQ/IHB1cnBvc2Uubm90ZXMgLy8gcHJlZmVyIHRoZWlyIG93biB3b3JkcyBmcm9tIHRoZSBub3RlcyBmaWVsZFxuXHRcdFx0XHRcdFx0OiBzZWxlY3RlZDtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRpZiAoIWRlc2NyaXB0aW9uKSB7XG5cdFx0XHRcdGN0eC51aS5ub3RpZnkoXCJObyBkZXNjcmlwdGlvbiBjYXB0dXJlZCBcdTIwMTQgYWRkIGRldGFpbHMgaW4gdGhlIG5vdGVzIGZpZWxkIG5leHQgdGltZS5cIiwgXCJ3YXJuaW5nXCIpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdC8vIFx1MjUwMFx1MjUwMCBCdWlsZCBhbmQgc2VuZCB0aGUgZW5yaWNoZWQgcHJvbXB0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5cdFx0XHRzZW5kUHJvbXB0KGRlc2NyaXB0aW9uLCByZXN1bHQsIHBpKTtcblx0XHR9LFxuXHR9KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFByb21wdCBidWlsZGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBmb3JtYXRBbnN3ZXJzKHJlc3VsdDogUm91bmRSZXN1bHQpOiBzdHJpbmcge1xuXHRjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcblxuXHRjb25zdCBwdXJwb3NlID0gcmVzdWx0LmFuc3dlcnNbXCJwdXJwb3NlXCJdO1xuXHRpZiAocHVycG9zZT8ubm90ZXMpIHtcblx0XHRsaW5lcy5wdXNoKGAtICoqQ29tbWFuZCBnb2FsICh1c2VyJ3Mgd29yZHMpKio6ICR7cHVycG9zZS5ub3Rlc31gKTtcblx0fVxuXG5cdGNvbnN0IHRyaWdnZXIgPSByZXN1bHQuYW5zd2Vyc1tcInRyaWdnZXJcIl07XG5cdGlmICh0cmlnZ2VyKSB7XG5cdFx0Y29uc3Qgc2VsZWN0ZWQgPSBBcnJheS5pc0FycmF5KHRyaWdnZXIuc2VsZWN0ZWQpID8gdHJpZ2dlci5zZWxlY3RlZFswXSA6IHRyaWdnZXIuc2VsZWN0ZWQ7XG5cdFx0bGluZXMucHVzaChgLSAqKlRyaWdnZXIgcGF0dGVybioqOiAke3NlbGVjdGVkfSR7dHJpZ2dlci5ub3RlcyA/IGAgXHUyMDE0ICR7dHJpZ2dlci5ub3Rlc31gIDogXCJcIn1gKTtcblx0fVxuXG5cdGNvbnN0IG91dHB1dCA9IHJlc3VsdC5hbnN3ZXJzW1wib3V0cHV0XCJdO1xuXHRpZiAob3V0cHV0KSB7XG5cdFx0Y29uc3Qgc2VsZWN0ZWQgPSBBcnJheS5pc0FycmF5KG91dHB1dC5zZWxlY3RlZCkgPyBvdXRwdXQuc2VsZWN0ZWRbMF0gOiBvdXRwdXQuc2VsZWN0ZWQ7XG5cdFx0bGluZXMucHVzaChgLSAqKk91dHB1dCBzdHlsZSoqOiAke3NlbGVjdGVkfSR7b3V0cHV0Lm5vdGVzID8gYCBcdTIwMTQgJHtvdXRwdXQubm90ZXN9YCA6IFwiXCJ9YCk7XG5cdH1cblxuXHRjb25zdCBhcmdzQW5zd2VyID0gcmVzdWx0LmFuc3dlcnNbXCJhcmdzXCJdO1xuXHRpZiAoYXJnc0Fuc3dlcikge1xuXHRcdGNvbnN0IHNlbGVjdGVkID0gQXJyYXkuaXNBcnJheShhcmdzQW5zd2VyLnNlbGVjdGVkKSA/IGFyZ3NBbnN3ZXIuc2VsZWN0ZWRbMF0gOiBhcmdzQW5zd2VyLnNlbGVjdGVkO1xuXHRcdGxpbmVzLnB1c2goYC0gKipBcmd1bWVudHMqKjogJHtzZWxlY3RlZH0ke2FyZ3NBbnN3ZXIubm90ZXMgPyBgIFx1MjAxNCAke2FyZ3NBbnN3ZXIubm90ZXN9YCA6IFwiXCJ9YCk7XG5cdH1cblxuXHRjb25zdCBjb21wbGV4aXR5ID0gcmVzdWx0LmFuc3dlcnNbXCJjb21wbGV4aXR5XCJdO1xuXHRpZiAoY29tcGxleGl0eSkge1xuXHRcdGNvbnN0IHNlbGVjdGVkID0gQXJyYXkuaXNBcnJheShjb21wbGV4aXR5LnNlbGVjdGVkKSA/IGNvbXBsZXhpdHkuc2VsZWN0ZWRbMF0gOiBjb21wbGV4aXR5LnNlbGVjdGVkO1xuXHRcdGxpbmVzLnB1c2goYC0gKipDb21wbGV4aXR5Kio6ICR7c2VsZWN0ZWR9JHtjb21wbGV4aXR5Lm5vdGVzID8gYCBcdTIwMTQgJHtjb21wbGV4aXR5Lm5vdGVzfWAgOiBcIlwifWApO1xuXHR9XG5cblx0cmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG5cbmZ1bmN0aW9uIHNlbmRQcm9tcHQoZGVzY3JpcHRpb246IHN0cmluZywgcmVzdWx0OiBSb3VuZFJlc3VsdCwgcGk6IEV4dGVuc2lvbkFQSSk6IHZvaWQge1xuXHRjb25zdCBjb250ZXh0U2VjdGlvbiA9IGBcXG4jIyBDb250ZXh0IGdhdGhlcmVkIGZyb20gdXNlclxcbiR7Zm9ybWF0QW5zd2VycyhyZXN1bHQpfVxcbmA7XG5cblx0Y29uc3QgcHJvbXB0ID0gYENyZWF0ZSBhIG5ldyBwaSBzbGFzaCBjb21tYW5kIGV4dGVuc2lvbiBiYXNlZCBvbiB0aGlzIGRlc2NyaXB0aW9uOlxuXG5cIiR7ZGVzY3JpcHRpb259XCJcbiR7Y29udGV4dFNlY3Rpb259XG5Xcml0ZSB0aGUgY29tcGxldGUgZmlsZSBjb250ZW50cyBmb3IgdHdvIGZpbGVzOlxuXG4xLiBcXGB+Ly5nc2QvYWdlbnQvZXh0ZW5zaW9ucy9zbGFzaC1jb21tYW5kcy88bmFtZT4udHNcXGAgXHUyMDE0IHRoZSBjb21tYW5kIGltcGxlbWVudGF0aW9uXG4yLiBVcGRhdGUgXFxgfi8uZ3NkL2FnZW50L2V4dGVuc2lvbnMvc2xhc2gtY29tbWFuZHMvaW5kZXgudHNcXGAgXHUyMDE0IGltcG9ydCBhbmQgcmVnaXN0ZXIgdGhlIG5ldyBjb21tYW5kIGFsb25nc2lkZSBleGlzdGluZyBvbmVzXG5cblJ1bGVzIHlvdSBtdXN0IGZvbGxvdyBleGFjdGx5OlxuLSBDb21tYW5kIHJlZ2lzdHJhdGlvbjogXFxgcGkucmVnaXN0ZXJDb21tYW5kKFwibmFtZVwiLCB7IGRlc2NyaXB0aW9uLCBoYW5kbGVyIH0pXFxgXG4tIEhhbmRsZXIgc2lnbmF0dXJlOiBcXGBhc3luYyBoYW5kbGVyKGFyZ3M6IHN0cmluZywgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dClcXGBcbi0gXFxgYXJnc1xcYCBpcyB0aGUgcmF3IHN0cmluZyB0eXBlZCBhZnRlciB0aGUgY29tbWFuZCBuYW1lIChtYXkgYmUgZW1wdHkpXG4tIFRvIHNlbmQgYSBtZXNzYWdlIHRvIHRoZSBhZ2VudDogXFxgcGkuc2VuZFVzZXJNZXNzYWdlKFwiLi4uXCIpXFxgIFx1MjAxNCB0aGlzIHRyaWdnZXJzIGFuIGFnZW50IHR1cm5cbi0gVG8gc2hvdyBhIHF1aWNrIG5vdGlmaWNhdGlvbiB3aXRob3V0IHRyaWdnZXJpbmcgYSB0dXJuOiBcXGBjdHgudWkubm90aWZ5KFwiLi4uXCIsIFwiaW5mb1wiIHwgXCJzdWNjZXNzXCIgfCBcImVycm9yXCIpXFxgXG4tIFRvIHJ1biBhIHNoZWxsIGNvbW1hbmQ6IFxcYGF3YWl0IHBpLmV4ZWMoXCJjbWRcIiwgW1wiYXJnMVwiLCBcImFyZzJcIl0pXFxgIFx1MjAxNCByZXR1cm5zIFxcYHsgc3Rkb3V0LCBzdGRlcnIsIGV4aXRDb2RlIH1cXGBcbi0gVG8gc2hvdyBhIHNlbGVjdCBkaWFsb2c6IFxcYGF3YWl0IGN0eC51aS5zZWxlY3QoXCJwcm9tcHRcIiwgW1wiT3B0aW9uIEFcIiwgXCJPcHRpb24gQlwiXSlcXGAgXHUyMDE0IHJldHVybnMgdGhlIGNob3NlbiBzdHJpbmdcbi0gVG8gc2hvdyBhIHRleHQgaW5wdXQgZGlhbG9nOiBcXGBhd2FpdCBjdHgudWkuaW5wdXQoXCJwcm9tcHRcIiwgXCJwbGFjZWhvbGRlclwiKVxcYCBcdTIwMTQgcmV0dXJucyB0aGUgc3RyaW5nIG9yIG51bGxcbi0gXFxgcGlcXGAgaXMgY2FwdHVyZWQgaW4gY2xvc3VyZSBmcm9tIHRoZSBvdXRlciBcXGBleHBvcnQgZGVmYXVsdCBmdW5jdGlvbihwaTogRXh0ZW5zaW9uQVBJKVxcYCBcdTIwMTQgdXNlIGl0IGZyZWVseSBpbnNpZGUgdGhlIGhhbmRsZXJcbi0gTm8gXFxgY3R4LnNlc3Npb25cXGAsIG5vIFxcYGN0eC5zZW5kTWVzc2FnZVxcYCwgbm8gXFxgYXJnc1tdXFxgIGFycmF5IFx1MjAxNCB0aGVzZSBkbyBub3QgZXhpc3Rcbi0gSW1wb3J0IHR5cGU6IFxcYGltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJLCBFeHRlbnNpb25Db21tYW5kQ29udGV4dCB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xcYFxuLSBFeHBvcnQgZGVmYXVsdDogXFxgZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gPGNhbWVsQ2FzZU5hbWU+KHBpOiBFeHRlbnNpb25BUEkpIHsgLi4uIH1cXGBcblxuQWZ0ZXIgd3JpdGluZyB0aGUgZmlsZXMsIHJ1biBcXGAvcmVsb2FkXFxgIHRvIGxvYWQgdGhlIG5ldyBjb21tYW5kLmA7XG5cblx0cGkuc2VuZFVzZXJNZXNz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
