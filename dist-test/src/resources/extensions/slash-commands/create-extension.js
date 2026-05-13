import { showInterviewRound } from "../shared/tui.js";
function createExtension(pi) {
  pi.registerCommand("create-extension", {
    description: "Scaffold a new pi extension with interview-driven context gathering",
    async handler(args, ctx) {
      const inlineName = (typeof args === "string" ? args : "").trim();
      const questions = [
        ...!inlineName ? [
          {
            id: "purpose",
            header: "Purpose",
            question: "What should this extension do?",
            options: [
              {
                label: "Add a custom tool",
                description: "Register a new tool the LLM can call (like gsd_plan, plan_clarify)."
              },
              {
                label: "Add a slash command",
                description: "A /command the user types \u2014 runs logic, optionally triggers an agent turn."
              },
              {
                label: "React to agent events",
                description: "Hook into turn_end, agent_end, tool_call, etc. to observe or intercept."
              },
              {
                label: "Custom TUI component",
                description: "Render a widget, overlay, dialog, or custom editor in the terminal UI."
              }
            ]
          }
        ] : [],
        {
          id: "ui",
          header: "UI",
          question: "Does this extension need any custom UI?",
          options: [
            {
              label: "No UI",
              description: "Pure logic \u2014 no dialogs, widgets, or custom rendering needed."
            },
            {
              label: "Dialogs only",
              description: "Uses built-in ctx.ui.select / ctx.ui.input / ctx.ui.confirm dialogs."
            },
            {
              label: "Status / widget",
              description: "Shows a persistent status indicator or footer widget."
            },
            {
              label: "Full custom component",
              description: "Uses ctx.ui.custom() to render a fully bespoke TUI component."
            }
          ]
        },
        {
          id: "events",
          header: "Events",
          question: "Does it need to hook into the agent lifecycle?",
          options: [
            {
              label: "No \u2014 standalone",
              description: "Runs only when explicitly invoked \u2014 no event listeners needed."
            },
            {
              label: "Yes \u2014 tool_call",
              description: "Intercepts or observes tool calls before or after they run."
            },
            {
              label: "Yes \u2014 turn / session",
              description: "Reacts to turn_end, agent_end, session_start, or similar lifecycle events."
            },
            {
              label: "Yes \u2014 context / prompt",
              description: "Modifies the system prompt or filters messages via context / before_agent_start."
            }
          ]
        },
        {
          id: "persistence",
          header: "State",
          question: "Does this extension need to persist state across sessions?",
          options: [
            {
              label: "No state needed",
              description: "Stateless \u2014 each invocation is independent."
            },
            {
              label: "In-memory only",
              description: "Keeps state while the session is running but doesn't survive restarts."
            },
            {
              label: "Persisted to session",
              description: "Uses pi.appendEntry() to write state into the session JSONL for resume."
            }
          ]
        },
        {
          id: "complexity",
          header: "Complexity",
          question: "How complex is the implementation?",
          options: [
            {
              label: "Simple \u2014 one concern",
              description: "A single tool or command, minimal branching, easy to follow."
            },
            {
              label: "Moderate \u2014 a few parts",
              description: "A command plus an event hook, or a tool with custom rendering."
            },
            {
              label: "Complex \u2014 full extension",
              description: "Multiple tools, commands, events, UI, and state working together."
            }
          ]
        }
      ];
      const result = await showInterviewRound(
        questions,
        {
          progress: "New pi extension \xB7 Context",
          reviewHeadline: "Review your choices",
          exitHeadline: "Cancel extension creation?",
          exitLabel: "cancel"
        },
        ctx
      );
      if (!result.answers || Object.keys(result.answers).length === 0) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }
      let extensionDescription = inlineName;
      if (!extensionDescription) {
        const purpose = result.answers["purpose"];
        if (purpose) {
          extensionDescription = purpose.notes?.trim() ? purpose.notes.trim() : Array.isArray(purpose.selected) ? purpose.selected[0] : purpose.selected;
        }
      }
      if (!extensionDescription) {
        ctx.ui.notify("No description captured \u2014 add details in the notes field next time.", "warning");
        return;
      }
      sendPrompt(extensionDescription, result, pi);
    }
  });
}
function formatAnswers(result) {
  const lines = [];
  const purpose = result.answers["purpose"];
  if (purpose?.notes) {
    lines.push(`- **Extension goal (user's words)**: ${purpose.notes}`);
  }
  const ui = result.answers["ui"];
  if (ui) {
    const selected = Array.isArray(ui.selected) ? ui.selected[0] : ui.selected;
    lines.push(`- **UI needs**: ${selected}${ui.notes ? ` \u2014 ${ui.notes}` : ""}`);
  }
  const events = result.answers["events"];
  if (events) {
    const selected = Array.isArray(events.selected) ? events.selected[0] : events.selected;
    lines.push(`- **Event hooks**: ${selected}${events.notes ? ` \u2014 ${events.notes}` : ""}`);
  }
  const persistence = result.answers["persistence"];
  if (persistence) {
    const selected = Array.isArray(persistence.selected) ? persistence.selected[0] : persistence.selected;
    lines.push(`- **State persistence**: ${selected}${persistence.notes ? ` \u2014 ${persistence.notes}` : ""}`);
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
  const uiAnswer = result.answers["ui"];
  const uiSelected = uiAnswer ? Array.isArray(uiAnswer.selected) ? uiAnswer.selected[0] : uiAnswer.selected : "";
  const eventsAnswer = result.answers["events"];
  const eventsSelected = eventsAnswer ? Array.isArray(eventsAnswer.selected) ? eventsAnswer.selected[0] : eventsAnswer.selected : "";
  const persistenceAnswer = result.answers["persistence"];
  const persistenceSelected = persistenceAnswer ? Array.isArray(persistenceAnswer.selected) ? persistenceAnswer.selected[0] : persistenceAnswer.selected : "";
  const docHints = [
    "- `docs/extension-sdk/README.md` \u2014 overview, quick start, directory layout",
    "- `docs/extension-sdk/api-reference.md` \u2014 ExtensionAPI and ExtensionContext surfaces",
    "- `docs/extension-sdk/building-extensions.md` \u2014 tools, commands, events, UI, state",
    "- `docs/extension-sdk/rules.md` \u2014 non-negotiable rules and gotchas"
  ];
  if (uiSelected.includes("custom component")) {
    docHints.push("- `docs/extension-sdk/building-extensions.md#custom-components` \u2014 ctx.ui.custom() API");
    docHints.push("- `docs/dev/pi-ui-tui/06-ctx-ui-custom-full-custom-components.md` \u2014 step-by-step component guide");
    docHints.push("- `docs/dev/pi-ui-tui/07-built-in-components-the-building-blocks.md` \u2014 Text, Box, SelectList");
    docHints.push("- `docs/dev/pi-ui-tui/09-keyboard-input-how-to-handle-keys.md` \u2014 Key, matchesKey");
    docHints.push("- `docs/dev/pi-ui-tui/10-line-width-the-cardinal-rule.md` \u2014 truncation, width rules");
  } else if (uiSelected.includes("Dialogs")) {
    docHints.push("- `docs/extension-sdk/building-extensions.md#built-in-dialogs` \u2014 select, confirm, input");
  } else if (uiSelected.includes("Status")) {
    docHints.push("- `docs/extension-sdk/building-extensions.md#persistent-ui-elements` \u2014 status, widgets");
  }
  if (uiSelected.includes("tool") || result.answers["purpose"]) {
    docHints.push("- `docs/dev/extending-pi/14-custom-rendering-controlling-what-the-user-sees.md` \u2014 renderCall / renderResult");
  }
  if (eventsSelected && !eventsSelected.includes("standalone")) {
    docHints.push("- `docs/dev/extending-pi/07-events-the-nervous-system.md` \u2014 all events reference");
  }
  if (eventsSelected.includes("context / prompt")) {
    docHints.push("- `docs/dev/extending-pi/15-system-prompt-modification.md` \u2014 system prompt hooks");
  }
  if (persistenceSelected.includes("session")) {
    docHints.push("- `docs/extension-sdk/building-extensions.md#state-management` \u2014 state reconstruction, appendEntry");
  }
  const prompt = `Create a new pi extension based on this description:

"${description}"
${contextSection}
## Reference documentation

Before writing any code, read the relevant docs below. They contain the exact APIs, rules, and patterns for building pi extensions \u2014 do not guess or rely on general TypeScript knowledge alone.

${docHints.join("\n")}

## Output

Write the complete implementation as a directory-based extension:

\`~/.gsd/agent/extensions/<kebab-case-name>/index.ts\`
\`~/.gsd/agent/extensions/<kebab-case-name>/extension-manifest.json\`

The manifest must follow this format:
\`\`\`json
{
  "id": "<kebab-case-name>",
  "name": "<Human Name>",
  "version": "1.0.0",
  "description": "<one-line description>",
  "tier": "community",
  "requires": { "platform": ">=2.29.0" },
  "provides": {
    "tools": ["<tool_names_registered>"],
    "commands": ["<command_names_registered>"],
    "hooks": ["<event_names_subscribed>"],
    "shortcuts": ["<shortcut_keys_registered>"]
  }
}
\`\`\`

Only include non-empty arrays in \`provides\`. See \`docs/extension-sdk/manifest-spec.md\` for the full spec.

## Rules you must follow exactly

- Extension entry point: \`export default function <camelCaseName>(pi: ExtensionAPI): void { ... }\`
- Import type: \`import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@gsd/pi-coding-agent";\`
- \`pi\` is the registration surface \u2014 call \`pi.registerCommand\`, \`pi.registerTool\`, \`pi.on\`, \`pi.registerShortcut\` inside the default export
- \`ctx\` (ExtensionCommandContext or ExtensionContext) is passed to handlers and event callbacks \u2014 never stored, never assumed available globally
- To send a message to the agent: \`pi.sendUserMessage("...")\` or \`pi.sendMessage({ content, display }, { triggerTurn })\`
- To show UI: \`ctx.ui.notify\`, \`ctx.ui.select\`, \`ctx.ui.input\`, \`ctx.ui.confirm\`, \`ctx.ui.custom\`
- To run shell commands: \`await pi.exec("cmd", ["arg1"])\` \u2014 returns \`{ stdout, stderr, exitCode }\`
- Events use \`pi.on("event_name", async (event, ctx) => { ... })\`
- No direct file I/O without \`node:fs\` \u2014 import it explicitly if needed
- Read the gotchas file before finalising: \`22-key-rules-gotchas.md\`

After writing the files, run \`/reload\` to load the new extension.`;
  pi.sendUserMessage(prompt);
}
export {
  createExtension as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3NsYXNoLWNvbW1hbmRzL2NyZWF0ZS1leHRlbnNpb24udHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBzaG93SW50ZXJ2aWV3Um91bmQsIHR5cGUgUXVlc3Rpb24sIHR5cGUgUm91bmRSZXN1bHQgfSBmcm9tIFwiLi4vc2hhcmVkL3R1aS5qc1wiO1xuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbiBjcmVhdGVFeHRlbnNpb24ocGk6IEV4dGVuc2lvbkFQSSkge1xuXHRwaS5yZWdpc3RlckNvbW1hbmQoXCJjcmVhdGUtZXh0ZW5zaW9uXCIsIHtcblx0XHRkZXNjcmlwdGlvbjogXCJTY2FmZm9sZCBhIG5ldyBwaSBleHRlbnNpb24gd2l0aCBpbnRlcnZpZXctZHJpdmVuIGNvbnRleHQgZ2F0aGVyaW5nXCIsXG5cdFx0YXN5bmMgaGFuZGxlcihhcmdzLCBjdHgpIHtcblx0XHRcdGNvbnN0IGlubGluZU5hbWUgPSAodHlwZW9mIGFyZ3MgPT09IFwic3RyaW5nXCIgPyBhcmdzIDogXCJcIikudHJpbSgpO1xuXG5cdFx0XHQvLyBcdTI1MDBcdTI1MDAgSW50ZXJ2aWV3IFx1MjAxNCBhbHdheXMgcnVucyBmaXJzdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuXHRcdFx0Y29uc3QgcXVlc3Rpb25zOiBRdWVzdGlvbltdID0gW1xuXHRcdFx0XHQuLi4oIWlubGluZU5hbWVcblx0XHRcdFx0XHQ/IFtcblx0XHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRcdGlkOiBcInB1cnBvc2VcIixcblx0XHRcdFx0XHRcdFx0XHRoZWFkZXI6IFwiUHVycG9zZVwiLFxuXHRcdFx0XHRcdFx0XHRcdHF1ZXN0aW9uOiBcIldoYXQgc2hvdWxkIHRoaXMgZXh0ZW5zaW9uIGRvP1wiLFxuXHRcdFx0XHRcdFx0XHRcdG9wdGlvbnM6IFtcblx0XHRcdFx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0bGFiZWw6IFwiQWRkIGEgY3VzdG9tIHRvb2xcIixcblx0XHRcdFx0XHRcdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiUmVnaXN0ZXIgYSBuZXcgdG9vbCB0aGUgTExNIGNhbiBjYWxsIChsaWtlIGdzZF9wbGFuLCBwbGFuX2NsYXJpZnkpLlwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0bGFiZWw6IFwiQWRkIGEgc2xhc2ggY29tbWFuZFwiLFxuXHRcdFx0XHRcdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJBIC9jb21tYW5kIHRoZSB1c2VyIHR5cGVzIFx1MjAxNCBydW5zIGxvZ2ljLCBvcHRpb25hbGx5IHRyaWdnZXJzIGFuIGFnZW50IHR1cm4uXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRsYWJlbDogXCJSZWFjdCB0byBhZ2VudCBldmVudHNcIixcblx0XHRcdFx0XHRcdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiSG9vayBpbnRvIHR1cm5fZW5kLCBhZ2VudF9lbmQsIHRvb2xfY2FsbCwgZXRjLiB0byBvYnNlcnZlIG9yIGludGVyY2VwdC5cIixcblx0XHRcdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdGxhYmVsOiBcIkN1c3RvbSBUVUkgY29tcG9uZW50XCIsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIlJlbmRlciBhIHdpZGdldCwgb3ZlcmxheSwgZGlhbG9nLCBvciBjdXN0b20gZWRpdG9yIGluIHRoZSB0ZXJtaW5hbCBVSS5cIixcblx0XHRcdFx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRcdFx0fSBzYXRpc2ZpZXMgUXVlc3Rpb24sXG5cdFx0XHRcdFx0XHRdXG5cdFx0XHRcdFx0OiBbXSksXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRpZDogXCJ1aVwiLFxuXHRcdFx0XHRcdGhlYWRlcjogXCJVSVwiLFxuXHRcdFx0XHRcdHF1ZXN0aW9uOiBcIkRvZXMgdGhpcyBleHRlbnNpb24gbmVlZCBhbnkgY3VzdG9tIFVJP1wiLFxuXHRcdFx0XHRcdG9wdGlvbnM6IFtcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0bGFiZWw6IFwiTm8gVUlcIixcblx0XHRcdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiUHVyZSBsb2dpYyBcdTIwMTQgbm8gZGlhbG9ncywgd2lkZ2V0cywgb3IgY3VzdG9tIHJlbmRlcmluZyBuZWVkZWQuXCIsXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRsYWJlbDogXCJEaWFsb2dzIG9ubHlcIixcblx0XHRcdFx0XHRcdFx0ZGVzY3JpcHRpb246IFwiVXNlcyBidWlsdC1pbiBjdHgudWkuc2VsZWN0IC8gY3R4LnVpLmlucHV0IC8gY3R4LnVpLmNvbmZpcm0gZGlhbG9ncy5cIixcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdGxhYmVsOiBcIlN0YXR1cyAvIHdpZGdldFwiLFxuXHRcdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJTaG93cyBhIHBlcnNpc3RlbnQgc3RhdHVzIGluZGljYXRvciBvciBmb290ZXIgd2lkZ2V0LlwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0bGFiZWw6IFwiRnVsbCBjdXN0b20gY29tcG9uZW50XCIsXG5cdFx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIlVzZXMgY3R4LnVpLmN1c3RvbSgpIHRvIHJlbmRlciBhIGZ1bGx5IGJlc3Bva2UgVFVJIGNvbXBvbmVudC5cIixcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XSxcblx0XHRcdFx0fSxcblx0XHRcdFx0e1xuXHRcdFx0XHRcdGlkOiBcImV2ZW50c1wiLFxuXHRcdFx0XHRcdGhlYWRlcjogXCJFdmVudHNcIixcblx0XHRcdFx0XHRxdWVzdGlvbjogXCJEb2VzIGl0IG5lZWQgdG8gaG9vayBpbnRvIHRoZSBhZ2VudCBsaWZlY3ljbGU/XCIsXG5cdFx0XHRcdFx0b3B0aW9uczogW1xuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRsYWJlbDogXCJObyBcdTIwMTQgc3RhbmRhbG9uZVwiLFxuXHRcdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJSdW5zIG9ubHkgd2hlbiBleHBsaWNpdGx5IGludm9rZWQgXHUyMDE0IG5vIGV2ZW50IGxpc3RlbmVycyBuZWVkZWQuXCIsXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRsYWJlbDogXCJZZXMgXHUyMDE0IHRvb2xfY2FsbFwiLFxuXHRcdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJJbnRlcmNlcHRzIG9yIG9ic2VydmVzIHRvb2wgY2FsbHMgYmVmb3JlIG9yIGFmdGVyIHRoZXkgcnVuLlwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0bGFiZWw6IFwiWWVzIFx1MjAxNCB0dXJuIC8gc2Vzc2lvblwiLFxuXHRcdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJSZWFjdHMgdG8gdHVybl9lbmQsIGFnZW50X2VuZCwgc2Vzc2lvbl9zdGFydCwgb3Igc2ltaWxhciBsaWZlY3ljbGUgZXZlbnRzLlwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0bGFiZWw6IFwiWWVzIFx1MjAxNCBjb250ZXh0IC8gcHJvbXB0XCIsXG5cdFx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIk1vZGlmaWVzIHRoZSBzeXN0ZW0gcHJvbXB0IG9yIGZpbHRlcnMgbWVzc2FnZXMgdmlhIGNvbnRleHQgLyBiZWZvcmVfYWdlbnRfc3RhcnQuXCIsXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdF0sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRpZDogXCJwZXJzaXN0ZW5jZVwiLFxuXHRcdFx0XHRcdGhlYWRlcjogXCJTdGF0ZVwiLFxuXHRcdFx0XHRcdHF1ZXN0aW9uOiBcIkRvZXMgdGhpcyBleHRlbnNpb24gbmVlZCB0byBwZXJzaXN0IHN0YXRlIGFjcm9zcyBzZXNzaW9ucz9cIixcblx0XHRcdFx0XHRvcHRpb25zOiBbXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdGxhYmVsOiBcIk5vIHN0YXRlIG5lZWRlZFwiLFxuXHRcdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJTdGF0ZWxlc3MgXHUyMDE0IGVhY2ggaW52b2NhdGlvbiBpcyBpbmRlcGVuZGVudC5cIixcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdGxhYmVsOiBcIkluLW1lbW9yeSBvbmx5XCIsXG5cdFx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIktlZXBzIHN0YXRlIHdoaWxlIHRoZSBzZXNzaW9uIGlzIHJ1bm5pbmcgYnV0IGRvZXNuJ3Qgc3Vydml2ZSByZXN0YXJ0cy5cIixcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdGxhYmVsOiBcIlBlcnNpc3RlZCB0byBzZXNzaW9uXCIsXG5cdFx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIlVzZXMgcGkuYXBwZW5kRW50cnkoKSB0byB3cml0ZSBzdGF0ZSBpbnRvIHRoZSBzZXNzaW9uIEpTT05MIGZvciByZXN1bWUuXCIsXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdF0sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRpZDogXCJjb21wbGV4aXR5XCIsXG5cdFx0XHRcdFx0aGVhZGVyOiBcIkNvbXBsZXhpdHlcIixcblx0XHRcdFx0XHRxdWVzdGlvbjogXCJIb3cgY29tcGxleCBpcyB0aGUgaW1wbGVtZW50YXRpb24/XCIsXG5cdFx0XHRcdFx0b3B0aW9uczogW1xuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRsYWJlbDogXCJTaW1wbGUgXHUyMDE0IG9uZSBjb25jZXJuXCIsXG5cdFx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIkEgc2luZ2xlIHRvb2wgb3IgY29tbWFuZCwgbWluaW1hbCBicmFuY2hpbmcsIGVhc3kgdG8gZm9sbG93LlwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0bGFiZWw6IFwiTW9kZXJhdGUgXHUyMDE0IGEgZmV3IHBhcnRzXCIsXG5cdFx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBcIkEgY29tbWFuZCBwbHVzIGFuIGV2ZW50IGhvb2ssIG9yIGEgdG9vbCB3aXRoIGN1c3RvbSByZW5kZXJpbmcuXCIsXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHRsYWJlbDogXCJDb21wbGV4IFx1MjAxNCBmdWxsIGV4dGVuc2lvblwiLFxuXHRcdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJNdWx0aXBsZSB0b29scywgY29tbWFuZHMsIGV2ZW50cywgVUksIGFuZCBzdGF0ZSB3b3JraW5nIHRvZ2V0aGVyLlwiLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRdLFxuXHRcdFx0XHR9LFxuXHRcdFx0XTtcblxuXHRcdFx0Y29uc3QgcmVzdWx0OiBSb3VuZFJlc3VsdCA9IGF3YWl0IHNob3dJbnRlcnZpZXdSb3VuZChcblx0XHRcdFx0cXVlc3Rpb25zLFxuXHRcdFx0XHR7XG5cdFx0XHRcdFx0cHJvZ3Jlc3M6IFwiTmV3IHBpIGV4dGVuc2lvbiBcdTAwQjcgQ29udGV4dFwiLFxuXHRcdFx0XHRcdHJldmlld0hlYWRsaW5lOiBcIlJldmlldyB5b3VyIGNob2ljZXNcIixcblx0XHRcdFx0XHRleGl0SGVhZGxpbmU6IFwiQ2FuY2VsIGV4dGVuc2lvbiBjcmVhdGlvbj9cIixcblx0XHRcdFx0XHRleGl0TGFiZWw6IFwiY2FuY2VsXCIsXG5cdFx0XHRcdH0sXG5cdFx0XHRcdGN0eCxcblx0XHRcdCk7XG5cblx0XHRcdC8vIFVzZXIgaGl0IEVzYyBcdTIwMTQgYmFpbCBzaWxlbnRseVxuXHRcdFx0aWYgKCFyZXN1bHQuYW5zd2VycyB8fCBPYmplY3Qua2V5cyhyZXN1bHQuYW5zd2VycykubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdGN0eC51aS5ub3RpZnkoXCJDYW5jZWxsZWQuXCIsIFwiaW5mb1wiKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBcdTI1MDBcdTI1MDAgUmVzb2x2ZSBuYW1lIC8gZGVzY3JpcHRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cblx0XHRcdGxldCBleHRlbnNpb25EZXNjcmlwdGlvbiA9IGlubGluZU5hbWU7XG5cdFx0XHRpZiAoIWV4dGVuc2lvbkRlc2NyaXB0aW9uKSB7XG5cdFx0XHRcdGNvbnN0IHB1cnBvc2UgPSByZXN1bHQuYW5zd2Vyc1tcInB1cnBvc2VcIl07XG5cdFx0XHRcdGlmIChwdXJwb3NlKSB7XG5cdFx0XHRcdFx0ZXh0ZW5zaW9uRGVzY3JpcHRpb24gPSBwdXJwb3NlLm5vdGVzPy50cmltKClcblx0XHRcdFx0XHRcdD8gcHVycG9zZS5ub3Rlcy50cmltKClcblx0XHRcdFx0XHRcdDogQXJyYXkuaXNBcnJheShwdXJwb3NlLnNlbGVjdGVkKSA/IHB1cnBvc2Uuc2VsZWN0ZWRbMF0gOiBwdXJwb3NlLnNlbGVjdGVkO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGlmICghZXh0ZW5zaW9uRGVzY3JpcHRpb24pIHtcblx0XHRcdFx0Y3R4LnVpLm5vdGlmeShcIk5vIGRlc2NyaXB0aW9uIGNhcHR1cmVkIFx1MjAxNCBhZGQgZGV0YWlscyBpbiB0aGUgbm90ZXMgZmllbGQgbmV4dCB0aW1lLlwiLCBcIndhcm5pbmdcIik7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0Ly8gXHUyNTAwXHUyNTAwIEJ1aWxkIGFuZCBzZW5kIHRoZSBlbnJpY2hlZCBwcm9tcHQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cblx0XHRcdHNlbmRQcm9tcHQoZXh0ZW5zaW9uRGVzY3JpcHRpb24sIHJlc3VsdCwgcGkpO1xuXHRcdH0sXG5cdH0pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHJvbXB0IGJ1aWxkZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGZvcm1hdEFuc3dlcnMocmVzdWx0OiBSb3VuZFJlc3VsdCk6IHN0cmluZyB7XG5cdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdGNvbnN0IHB1cnBvc2UgPSByZXN1bHQuYW5zd2Vyc1tcInB1cnBvc2VcIl07XG5cdGlmIChwdXJwb3NlPy5ub3Rlcykge1xuXHRcdGxpbmVzLnB1c2goYC0gKipFeHRlbnNpb24gZ29hbCAodXNlcidzIHdvcmRzKSoqOiAke3B1cnBvc2Uubm90ZXN9YCk7XG5cdH1cblxuXHRjb25zdCB1aSA9IHJlc3VsdC5hbnN3ZXJzW1widWlcIl07XG5cdGlmICh1aSkge1xuXHRcdGNvbnN0IHNlbGVjdGVkID0gQXJyYXkuaXNBcnJheSh1aS5zZWxlY3RlZCkgPyB1aS5zZWxlY3RlZFswXSA6IHVpLnNlbGVjdGVkO1xuXHRcdGxpbmVzLnB1c2goYC0gKipVSSBuZWVkcyoqOiAke3NlbGVjdGVkfSR7dWkubm90ZXMgPyBgIFx1MjAxNCAke3VpLm5vdGVzfWAgOiBcIlwifWApO1xuXHR9XG5cblx0Y29uc3QgZXZlbnRzID0gcmVzdWx0LmFuc3dlcnNbXCJldmVudHNcIl07XG5cdGlmIChldmVudHMpIHtcblx0XHRjb25zdCBzZWxlY3RlZCA9IEFycmF5LmlzQXJyYXkoZXZlbnRzLnNlbGVjdGVkKSA/IGV2ZW50cy5zZWxlY3RlZFswXSA6IGV2ZW50cy5zZWxlY3RlZDtcblx0XHRsaW5lcy5wdXNoKGAtICoqRXZlbnQgaG9va3MqKjogJHtzZWxlY3RlZH0ke2V2ZW50cy5ub3RlcyA/IGAgXHUyMDE0ICR7ZXZlbnRzLm5vdGVzfWAgOiBcIlwifWApO1xuXHR9XG5cblx0Y29uc3QgcGVyc2lzdGVuY2UgPSByZXN1bHQuYW5zd2Vyc1tcInBlcnNpc3RlbmNlXCJdO1xuXHRpZiAocGVyc2lzdGVuY2UpIHtcblx0XHRjb25zdCBzZWxlY3RlZCA9IEFycmF5LmlzQXJyYXkocGVyc2lzdGVuY2Uuc2VsZWN0ZWQpID8gcGVyc2lzdGVuY2Uuc2VsZWN0ZWRbMF0gOiBwZXJzaXN0ZW5jZS5zZWxlY3RlZDtcblx0XHRsaW5lcy5wdXNoKGAtICoqU3RhdGUgcGVyc2lzdGVuY2UqKjogJHtzZWxlY3RlZH0ke3BlcnNpc3RlbmNlLm5vdGVzID8gYCBcdTIwMTQgJHtwZXJzaXN0ZW5jZS5ub3Rlc31gIDogXCJcIn1gKTtcblx0fVxuXG5cdGNvbnN0IGNvbXBsZXhpdHkgPSByZXN1bHQuYW5zd2Vyc1tcImNvbXBsZXhpdHlcIl07XG5cdGlmIChjb21wbGV4aXR5KSB7XG5cdFx0Y29uc3Qgc2VsZWN0ZWQgPSBBcnJheS5pc0FycmF5KGNvbXBsZXhpdHkuc2VsZWN0ZWQpID8gY29tcGxleGl0eS5zZWxlY3RlZFswXSA6IGNvbXBsZXhpdHkuc2VsZWN0ZWQ7XG5cdFx0bGluZXMucHVzaChgLSAqKkNvbXBsZXhpdHkqKjogJHtzZWxlY3RlZH0ke2NvbXBsZXhpdHkubm90ZXMgPyBgIFx1MjAxNCAke2NvbXBsZXhpdHkubm90ZXN9YCA6IFwiXCJ9YCk7XG5cdH1cblxuXHRyZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuZnVuY3Rpb24gc2VuZFByb21wdChkZXNjcmlwdGlvbjogc3RyaW5nLCByZXN1bHQ6IFJvdW5kUmVzdWx0LCBwaTogRXh0ZW5zaW9uQVBJKTogdm9pZCB7XG5cdGNvbnN0IGNvbnRleHRTZWN0aW9uID0gYFxcbiMjIENvbnRleHQgZ2F0aGVyZWQgZnJvbSB1c2VyXFxuJHtmb3JtYXRBbnN3ZXJzKHJlc3VsdCl9XFxuYDtcblxuXHQvLyBEZXRlcm1pbmUgd2hpY2ggZG9jIHNlY3Rpb25zIHRvIGhpZ2hsaWdodCBiYXNlZCBvbiBhbnN3ZXJzXG5cdGNvbnN0IHVpQW5zd2VyID0gcmVzdWx0LmFuc3dlcnNbXCJ1aVwiXTtcblx0Y29uc3QgdWlTZWxlY3RlZCA9IHVpQW5zd2VyXG5cdFx0PyAoQXJyYXkuaXNBcnJheSh1aUFuc3dlci5zZWxlY3RlZCkgPyB1aUFuc3dlci5zZWxlY3RlZFswXSA6IHVpQW5zd2VyLnNlbGVjdGVkKVxuXHRcdDogXCJcIjtcblxuXHRjb25zdCBldmVudHNBbnN3ZXIgPSByZXN1bHQuYW5zd2Vyc1tcImV2ZW50c1wiXTtcblx0Y29uc3QgZXZlbnRzU2VsZWN0ZWQgPSBldmVudHNBbnN3ZXJcblx0XHQ/IChBcnJheS5pc0FycmF5KGV2ZW50c0Fuc3dlci5zZWxlY3RlZCkgPyBldmVudHNBbnN3ZXIuc2VsZWN0ZWRbMF0gOiBldmVudHNBbnN3ZXIuc2VsZWN0ZWQpXG5cdFx0OiBcIlwiO1xuXG5cdGNvbnN0IHBlcnNpc3RlbmNlQW5zd2VyID0gcmVzdWx0LmFuc3dlcnNbXCJwZXJzaXN0ZW5jZVwiXTtcblx0Y29uc3QgcGVyc2lzdGVuY2VTZWxlY3RlZCA9IHBlcnNpc3RlbmNlQW5zd2VyXG5cdFx0PyAoQXJyYXkuaXNBcnJheShwZXJzaXN0ZW5jZUFuc3dlci5zZWxlY3RlZCkgPyBwZXJzaXN0ZW5jZUFuc3dlci5zZWxlY3RlZFswXSA6IHBlcnNpc3RlbmNlQW5zd2VyLnNlbGVjdGVkKVxuXHRcdDogXCJcIjtcblxuXHRjb25zdCBkb2NIaW50czogc3RyaW5nW10gPSBbXG5cdFx0XCItIGBkb2NzL2V4dGVuc2lvbi1zZGsvUkVBRE1FLm1kYCBcdTIwMTQgb3ZlcnZpZXcsIHF1aWNrIHN0YXJ0LCBkaXJlY3RvcnkgbGF5b3V0XCIsXG5cdFx0XCItIGBkb2NzL2V4dGVuc2lvbi1zZGsvYXBpLXJlZmVyZW5jZS5tZGAgXHUyMDE0IEV4dGVuc2lvbkFQSSBhbmQgRXh0ZW5zaW9uQ29udGV4dCBzdXJmYWNlc1wiLFxuXHRcdFwiLSBgZG9jcy9leHRlbnNpb24tc2RrL2J1aWxkaW5nLWV4dGVuc2lvbnMubWRgIFx1MjAxNCB0b29scywgY29tbWFuZHMsIGV2ZW50cywgVUksIHN0YXRlXCIsXG5cdFx0XCItIGBkb2NzL2V4dGVuc2lvbi1zZGsvcnVsZXMubWRgIFx1MjAxNCBub24tbmVnb3RpYWJsZSBydWxlcyBhbmQgZ290Y2hhc1wiLFxuXHRdO1xuXG5cdGlmICh1aVNlbGVjdGVkLmluY2x1ZGVzKFwiY3VzdG9tIGNvbXBvbmVudFwiKSkge1xuXHRcdGRvY0hpbnRzLnB1c2goXCItIGBkb2NzL2V4dGVuc2lvbi1zZGsvYnVpbGRpbmctZXh0ZW5zaW9ucy5tZCNjdXN0b20tY29tcG9uZW50c2AgXHUyMDE0IGN0eC51aS5jdXN0b20oKSBBUElcIik7XG5cdFx0ZG9jSGludHMucHVzaChcIi0gYGRvY3MvZGV2L3BpLXVpLXR1aS8wNi1jdHgtdWktY3VzdG9tLWZ1bGwtY3VzdG9tLWNvbXBvbmVudHMubWRgIFx1MjAxNCBzdGVwLWJ5LXN0ZXAgY29tcG9uZW50IGd1aWRlXCIpO1xuXHRcdGRvY0hpbnRzLnB1c2goXCItIGBkb2NzL2Rldi9waS11aS10dWkvMDctYnVpbHQtaW4tY29tcG9uZW50cy10aGUtYnVpbGRpbmctYmxvY2tzLm1kYCBcdTIwMTQgVGV4dCwgQm94LCBTZWxlY3RMaXN0XCIpO1xuXHRcdGRvY0hpbnRzLnB1c2goXCItIGBkb2NzL2Rldi9waS11aS10dWkvMDkta2V5Ym9hcmQtaW5wdXQtaG93LXRvLWhhbmRsZS1rZXlzLm1kYCBcdTIwMTQgS2V5LCBtYXRjaGVzS2V5XCIpO1xuXHRcdGRvY0hpbnRzLnB1c2goXCItIGBkb2NzL2Rldi9waS11aS10dWkvMTAtbGluZS13aWR0aC10aGUtY2FyZGluYWwtcnVsZS5tZGAgXHUyMDE0IHRydW5jYXRpb24sIHdpZHRoIHJ1bGVzXCIpO1xuXHR9IGVsc2UgaWYgKHVpU2VsZWN0ZWQuaW5jbHVkZXMoXCJEaWFsb2dzXCIpKSB7XG5cdFx0ZG9jSGludHMucHVzaChcIi0gYGRvY3MvZXh0ZW5zaW9uLXNkay9idWlsZGluZy1leHRlbnNpb25zLm1kI2J1aWx0LWluLWRpYWxvZ3NgIFx1MjAxNCBzZWxlY3QsIGNvbmZpcm0sIGlucHV0XCIpO1xuXHR9IGVsc2UgaWYgKHVpU2VsZWN0ZWQuaW5jbHVkZXMoXCJTdGF0dXNcIikpIHtcblx0XHRkb2NIaW50cy5wdXNoKFwiLSBgZG9jcy9leHRlbnNpb24tc2RrL2J1aWxkaW5nLWV4dGVuc2lvbnMubWQjcGVyc2lzdGVudC11aS1lbGVtZW50c2AgXHUyMDE0IHN0YXR1cywgd2lkZ2V0c1wiKTtcblx0fVxuXG5cdGlmICh1aVNlbGVjdGVkLmluY2x1ZGVzKFwidG9vbFwiKSB8fCByZXN1bHQuYW5zd2Vyc1tcInB1cnBvc2VcIl0pIHtcblx0XHRkb2NIaW50cy5wdXNoKFwiLSBgZG9jcy9kZXYvZXh0ZW5kaW5nLXBpLzE0LWN1c3RvbS1yZW5kZXJpbmctY29udHJvbGxpbmctd2hhdC10aGUtdXNlci1zZWVzLm1kYCBcdTIwMTQgcmVuZGVyQ2FsbCAvIHJlbmRlclJlc3VsdFwiKTtcblx0fVxuXG5cdGlmIChldmVudHNTZWxlY3RlZCAmJiAhZXZlbnRzU2VsZWN0ZWQuaW5jbHVkZXMoXCJzdGFuZGFsb25lXCIpKSB7XG5cdFx0ZG9jSGludHMucHVzaChcIi0gYGRvY3MvZGV2L2V4dGVuZGluZy1waS8wNy1ldmVudHMtdGhlLW5lcnZvdXMtc3lzdGVtLm1kYCBcdTIwMTQgYWxsIGV2ZW50cyByZWZlcmVuY2VcIik7XG5cdH1cblxuXHRpZiAoZXZlbnRzU2VsZWN0ZWQuaW5jbHVkZXMoXCJjb250ZXh0IC8gcHJvbXB0XCIpKSB7XG5cdFx0ZG9jSGludHMucHVzaChcIi0gYGRvY3MvZGV2L2V4dGVuZGluZy1waS8xNS1zeXN0ZW0tcHJvbXB0LW1vZGlmaWNhdGlvbi5tZGAgXHUyMDE0IHN5c3RlbSBwcm9tcHQgaG9va3NcIik7XG5cdH1cblxuXHRpZiAocGVyc2lzdGVuY2VTZWxlY3RlZC5pbmNsdWRlcyhcInNlc3Npb25cIikpIHtcblx0XHRkb2NIaW50cy5wdXNoKFwiLSBgZG9jcy9leHRlbnNpb24tc2RrL2J1aWxkaW5nLWV4dGVuc2lvbnMubWQjc3RhdGUtbWFuYWdlbWVudGAgXHUyMDE0IHN0YXRlIHJlY29uc3RydWN0aW9uLCBhcHBlbmRFbnRyeVwiKTtcblx0fVxuXG5cdGNvbnN0IHByb21wdCA9IGBDcmVhdGUgYSBuZXcgcGkgZXh0ZW5zaW9uIGJhc2VkIG9uIHRoaXMgZGVzY3JpcHRpb246XG5cblwiJHtkZXNjcmlwdGlvbn1cIlxuJHtjb250ZXh0U2VjdGlvbn1cbiMjIFJlZmVyZW5jZSBkb2N1bWVudGF0aW9uXG5cbkJlZm9yZSB3cml0aW5nIGFueSBjb2RlLCByZWFkIHRoZSByZWxldmFudCBkb2NzIGJlbG93LiBUaGV5IGNvbnRhaW4gdGhlIGV4YWN0IEFQSXMsIHJ1bGVzLCBhbmQgcGF0dGVybnMgZm9yIGJ1aWxkaW5nIHBpIGV4dGVuc2lvbnMgXHUyMDE0IGRvIG5vdCBndWVzcyBvciByZWx5IG9uIGdlbmVyYWwgVHlwZVNjcmlwdCBrbm93bGVkZ2UgYWxvbmUuXG5cbiR7ZG9jSGludHMuam9pbihcIlxcblwiKX1cblxuIyMgT3V0cHV0XG5cbldyaXRlIHRoZSBjb21wbGV0ZSBpbXBsZW1lbnRhdGlvbiBhcyBhIGRpcmVjdG9yeS1iYXNlZCBleHRlbnNpb246XG5cblxcYH4vLmdzZC9hZ2VudC9leHRlbnNpb25zLzxrZWJhYi1jYXNlLW5hbWU+L2luZGV4LnRzXFxgXG5cXGB+Ly5nc2QvYWdlbnQvZXh0ZW5zaW9ucy88a2ViYWItY2FzZS1uYW1lPi9leHRlbnNpb24tbWFuaWZlc3QuanNvblxcYFxuXG5UaGUgbWFuaWZlc3QgbXVzdCBmb2xsb3cgdGhpcyBmb3JtYXQ6XG5cXGBcXGBcXGBqc29uXG57XG4gIFwiaWRcIjogXCI8a2ViYWItY2FzZS1uYW1lPlwiLFxuICBcIm5hbWVcIjogXCI8SHVtYW4gTmFtZT5cIixcbiAgXCJ2ZXJzaW9uXCI6IFwiMS4wLjBcIixcbiAgXCJkZXNjcmlwdGlvblwiOiBcIjxvbmUtbGluZSBkZXNjcmlwdGlvbj5cIixcbiAgXCJ0aWVyXCI6IFwiY29tbXVuaXR5XCIsXG4gIFwicmVxdWlyZXNcIjogeyBcInBsYXRmb3JtXCI6IFwiPj0yLjI5LjBcIiB9LFxuICBcInByb3ZpZGVzXCI6IHtcbiAgICBcInRvb2xzXCI6IFtcIjx0b29sX25hbWVzX3JlZ2lzdGVyZWQ+XCJdLFxuICAgIFwiY29tbWFuZHNcIjogW1wiPGNvbW1hbmRfbmFtZXNfcmVnaXN0ZXJlZD5cIl0sXG4gICAgXCJob29rc1wiOiBbXCI8ZXZlbnRfbmFtZXNfc3Vic2NyaWJlZD5cIl0sXG4gICAgXCJzaG9ydGN1dHNcIjogW1wiPHNob3J0Y3V0X2tleXNfcmVnaXN0ZXJlZD5cIl1cbiAgfVxufVxuXFxgXFxgXFxgXG5cbk9ubHkgaW5jbHVkZSBub24tZW1wdHkgYXJyYXlzIGluIFxcYHByb3ZpZGVzXFxgLiBTZWUgXFxgZG9jcy9leHRlbnNpb24tc2RrL21hbmlmZXN0LXNwZWMubWRcXGAgZm9yIHRoZSBmdWxsIHNwZWMuXG5cbiMjIFJ1bGVzIHlvdSBtdXN0IGZvbGxvdyBleGFjdGx5XG5cbi0gRXh0ZW5zaW9uIGVudHJ5IHBvaW50OiBcXGBleHBvcnQgZGVmYXVsdCBmdW5jdGlvbiA8Y2FtZWxDYXNlTmFtZT4ocGk6IEV4dGVuc2lvbkFQSSk6IHZvaWQgeyAuLi4gfVxcYFxuLSBJbXBvcnQgdHlwZTogXFxgaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEksIEV4dGVuc2lvbkNvbnRleHQsIEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XFxgXG4tIFxcYHBpXFxgIGlzIHRoZSByZWdpc3RyYXRpb24gc3VyZmFjZSBcdTIwMTQgY2FsbCBcXGBwaS5yZWdpc3RlckNvbW1hbmRcXGAsIFxcYHBpLnJlZ2lzdGVyVG9vbFxcYCwgXFxgcGkub25cXGAsIFxcYHBpLnJlZ2lzdGVyU2hvcnRjdXRcXGAgaW5zaWRlIHRoZSBkZWZhdWx0IGV4cG9ydFxuLSBcXGBjdHhcXGAgKEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IG9yIEV4dGVuc2lvbkNvbnRleHQpIGlzIHBhc3NlZCB0byBoYW5kbGVycyBhbmQgZXZlbnQgY2FsbGJhY2tzIFx1MjAxNCBuZXZlciBzdG9yZWQsIG5ldmVyIGFzc3VtZWQgYXZhaWxhYmxlIGdsb2JhbGx5XG4tIFRvIHNlbmQgYSBtZXNzYWdlIHRvIHRoZSBhZ2VudDogXFxgcGkuc2VuZFVzZXJNZXNzYWdlKFwiLi4uXCIpXFxgIG9yIFxcYHBpLnNlbmRNZXNzYWdlKHsgY29udGVudCwgZGlzcGxheSB9LCB7IHRyaWdnZXJUdXJuIH0pXFxgXG4tIFRvIHNob3cgVUk6IFxcYGN0eC51aS5ub3RpZnlcXGAsIFxcYGN0eC51aS5zZWxlY3RcXGAsIFxcYGN0eC51aS5pbnB1dFxcYCwgXFxgY3R4LnVpLmNvbmZpcm1cXGAsIFxcYGN0eC51aS5jdXN0b21cXGBcbi0gVG8gcnVuIHNoZWxsIGNvbW1hbmRzOiBcXGBhd2FpdCBwaS5leGVjKFwiY21kXCIsIFtcImFyZzFcIl0pXFxgIFx1MjAxNCByZXR1cm5zIFxcYHsgc3Rkb3V0LCBzdGRlcnIsIGV4aXRDb2RlIH1cXGBcbi0gRXZlbnRzIHVzZSBcXGBwaS5vbihcImV2ZW50X25hbWVcIiwgYXN5bmMgKGV2ZW50LCBjdHgpID0+IHsgLi4uIH0pXFxgXG4tIE5vIGRpcmVjdCBmaWxlIEkvTyB3aXRob3V0IFxcYG5vZGU6ZnNcXGAgXHUyMDE0IGltcG9ydCBpdCBleHBsaWNpdGx5IGlmIG5lZWRlZFxuLSBSZWFkIHRoZSBnb3RjaGFzIGZpbGUgYmVmb3JlIGZpbmFsaXNpbmc6IFxcYDIyLWtleS1ydWxlcy1nb3RjaGFzLm1kXFxgXG5cbkFmdGVyIHdyaXRpbmcgdGhlIGZpbGVzLCBydW4gXFxgL3JlbG9hZFxcYCB0byBsb2FkIHRoZSBuZXcgZXh0ZW5zaW9uLmA7XG5cblx0cGkuc2VuZFVzZXJNZXNzYWdlKHByb21wdCk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLDBCQUEyRDtBQUVyRCxTQUFSLGdCQUFpQyxJQUFrQjtBQUN6RCxLQUFHLGdCQUFnQixvQkFBb0I7QUFBQSxJQUN0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
