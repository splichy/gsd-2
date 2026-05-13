import {
  Container,
  getCapabilities,
  SelectList,
  SettingsList,
  Spacer,
  Text
} from "@gsd/pi-tui";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
const THINKING_DESCRIPTIONS = {
  off: "No reasoning",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Maximum reasoning (~32k tokens)"
};
class SelectSubmenu extends Container {
  constructor(title, description, options, currentValue, onSelect, onCancel, onSelectionChange) {
    super();
    this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
    if (description) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(theme.fg("muted", description), 0, 0));
    }
    this.addChild(new Spacer(1));
    this.selectList = new SelectList(options, Math.min(options.length, 10), getSelectListTheme());
    const currentIndex = options.findIndex((o) => o.value === currentValue);
    if (currentIndex !== -1) {
      this.selectList.setSelectedIndex(currentIndex);
    }
    this.selectList.onSelect = (item) => {
      onSelect(item.value);
    };
    this.selectList.onCancel = onCancel;
    if (onSelectionChange) {
      this.selectList.onSelectionChange = (item) => {
        onSelectionChange(item.value);
      };
    }
    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "  Enter to select \xB7 Esc to go back"), 0, 0));
  }
  handleInput(data) {
    this.selectList.handleInput(data);
  }
}
class SettingsSelectorComponent extends Container {
  constructor(config, callbacks) {
    super();
    const supportsImages = getCapabilities().images;
    const items = [
      {
        id: "autocompact",
        label: "Auto-compact",
        description: "Automatically compact context when it gets too large",
        currentValue: config.autoCompact ? "true" : "false",
        values: ["true", "false"]
      },
      {
        id: "steering-mode",
        label: "Steering mode",
        description: "Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
        currentValue: config.steeringMode,
        values: ["one-at-a-time", "all"]
      },
      {
        id: "follow-up-mode",
        label: "Follow-up mode",
        description: `${process.platform === "darwin" ? "\u2325Enter" : "Alt+Enter"} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
        currentValue: config.followUpMode,
        values: ["one-at-a-time", "all"]
      },
      {
        id: "transport",
        label: "Transport",
        description: "Preferred transport for providers that support multiple transports",
        currentValue: config.transport,
        values: ["sse", "websocket", "auto"]
      },
      {
        id: "hide-thinking",
        label: "Hide thinking",
        description: "Hide thinking blocks in assistant responses",
        currentValue: config.hideThinkingBlock ? "true" : "false",
        values: ["true", "false"]
      },
      {
        id: "collapse-changelog",
        label: "Collapse changelog",
        description: "Show condensed changelog after updates",
        currentValue: config.collapseChangelog ? "true" : "false",
        values: ["true", "false"]
      },
      {
        id: "quiet-startup",
        label: "Quiet startup",
        description: "Disable verbose printing at startup",
        currentValue: config.quietStartup ? "true" : "false",
        values: ["true", "false"]
      },
      {
        id: "double-escape-action",
        label: "Double-escape action",
        description: "Action when pressing Escape twice with empty editor",
        currentValue: config.doubleEscapeAction,
        values: ["tree", "fork", "none"]
      },
      {
        id: "tree-filter-mode",
        label: "Tree filter mode",
        description: "Default filter when opening /tree",
        currentValue: config.treeFilterMode,
        values: ["default", "no-tools", "user-only", "labeled-only", "all"]
      },
      {
        id: "thinking",
        label: "Thinking level",
        description: "Reasoning depth for thinking-capable models",
        currentValue: config.thinkingLevel,
        submenu: (currentValue, done) => new SelectSubmenu(
          "Thinking Level",
          "Select reasoning depth for thinking-capable models",
          config.availableThinkingLevels.map((level) => ({
            value: level,
            label: level,
            description: THINKING_DESCRIPTIONS[level]
          })),
          currentValue,
          (value) => {
            callbacks.onThinkingLevelChange(value);
            done(value);
          },
          () => done()
        )
      },
      {
        id: "theme",
        label: "Theme",
        description: "Color theme for the interface",
        currentValue: config.currentTheme,
        submenu: (currentValue, done) => new SelectSubmenu(
          "Theme",
          "Select color theme",
          config.availableThemes.map((t) => ({
            value: t,
            label: t
          })),
          currentValue,
          (value) => {
            callbacks.onThemeChange(value);
            done(value);
          },
          () => {
            callbacks.onThemePreview?.(currentValue);
            done();
          },
          (value) => {
            callbacks.onThemePreview?.(value);
          }
        )
      }
    ];
    if (supportsImages) {
      items.splice(1, 0, {
        id: "show-images",
        label: "Show images",
        description: "Render images inline in terminal",
        currentValue: config.showImages ? "true" : "false",
        values: ["true", "false"]
      });
    }
    items.splice(supportsImages ? 2 : 1, 0, {
      id: "auto-resize-images",
      label: "Auto-resize images",
      description: "Resize large images to 2000x2000 max for better model compatibility",
      currentValue: config.autoResizeImages ? "true" : "false",
      values: ["true", "false"]
    });
    const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
    items.splice(autoResizeIndex + 1, 0, {
      id: "block-images",
      label: "Block images",
      description: "Prevent images from being sent to LLM providers",
      currentValue: config.blockImages ? "true" : "false",
      values: ["true", "false"]
    });
    const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
    items.splice(blockImagesIndex + 1, 0, {
      id: "skill-commands",
      label: "Skill commands",
      description: "Register skills as /skill:name commands",
      currentValue: config.enableSkillCommands ? "true" : "false",
      values: ["true", "false"]
    });
    const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
    items.splice(skillCommandsIndex + 1, 0, {
      id: "show-hardware-cursor",
      label: "Show hardware cursor",
      description: "Show the terminal cursor while still positioning it for IME support",
      currentValue: config.showHardwareCursor ? "true" : "false",
      values: ["true", "false"]
    });
    const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
    items.splice(hardwareCursorIndex + 1, 0, {
      id: "editor-padding",
      label: "Editor padding",
      description: "Horizontal padding for input editor (0-3)",
      currentValue: String(config.editorPaddingX),
      values: ["0", "1", "2", "3"]
    });
    const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
    items.splice(editorPaddingIndex + 1, 0, {
      id: "autocomplete-max-visible",
      label: "Autocomplete max items",
      description: "Max visible items in autocomplete dropdown (3-20)",
      currentValue: String(config.autocompleteMaxVisible),
      values: ["3", "5", "7", "10", "15", "20"]
    });
    const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
    items.splice(autocompleteIndex + 1, 0, {
      id: "clear-on-shrink",
      label: "Clear on shrink",
      description: "Clear empty rows when content shrinks (may cause flicker)",
      currentValue: config.clearOnShrink ? "true" : "false",
      values: ["true", "false"]
    });
    const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
    items.splice(clearOnShrinkIndex + 1, 0, {
      id: "respect-gitignore-in-picker",
      label: "Respect .gitignore in file picker",
      description: "When false, @ file picker shows gitignored files too",
      currentValue: config.respectGitignoreInPicker ? "true" : "false",
      values: ["true", "false"]
    });
    const gitignoreIndex = items.findIndex((item) => item.id === "respect-gitignore-in-picker");
    items.splice(gitignoreIndex + 1, 0, {
      id: "timestamp-format",
      label: "Timestamp format",
      description: "Date/time format for message timestamps",
      currentValue: config.timestampFormat,
      values: ["date-time-iso", "date-time-us"]
    });
    const timestampIndex = items.findIndex((item) => item.id === "timestamp-format");
    items.splice(timestampIndex + 1, 0, {
      id: "adaptive-mode",
      label: "TUI adaptive mode",
      description: "Auto-select or force the terminal layout mode",
      currentValue: config.adaptiveMode,
      values: ["auto", "chat", "workflow", "validation", "debug", "compact"]
    });
    this.addChild(new DynamicBorder());
    this.settingsList = new SettingsList(
      items,
      10,
      getSettingsListTheme(),
      (id, newValue) => {
        switch (id) {
          case "autocompact":
            callbacks.onAutoCompactChange(newValue === "true");
            break;
          case "show-images":
            callbacks.onShowImagesChange(newValue === "true");
            break;
          case "auto-resize-images":
            callbacks.onAutoResizeImagesChange(newValue === "true");
            break;
          case "block-images":
            callbacks.onBlockImagesChange(newValue === "true");
            break;
          case "skill-commands":
            callbacks.onEnableSkillCommandsChange(newValue === "true");
            break;
          case "steering-mode":
            callbacks.onSteeringModeChange(newValue);
            break;
          case "follow-up-mode":
            callbacks.onFollowUpModeChange(newValue);
            break;
          case "transport":
            callbacks.onTransportChange(newValue);
            break;
          case "hide-thinking":
            callbacks.onHideThinkingBlockChange(newValue === "true");
            break;
          case "collapse-changelog":
            callbacks.onCollapseChangelogChange(newValue === "true");
            break;
          case "quiet-startup":
            callbacks.onQuietStartupChange(newValue === "true");
            break;
          case "double-escape-action":
            callbacks.onDoubleEscapeActionChange(newValue);
            break;
          case "tree-filter-mode":
            callbacks.onTreeFilterModeChange(
              newValue
            );
            break;
          case "show-hardware-cursor":
            callbacks.onShowHardwareCursorChange(newValue === "true");
            break;
          case "editor-padding":
            callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
            break;
          case "autocomplete-max-visible":
            callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
            break;
          case "clear-on-shrink":
            callbacks.onClearOnShrinkChange(newValue === "true");
            break;
          case "respect-gitignore-in-picker":
            callbacks.onRespectGitignoreInPickerChange(newValue === "true");
            break;
          case "timestamp-format":
            callbacks.onTimestampFormatChange(newValue);
            break;
          case "adaptive-mode":
            callbacks.onAdaptiveModeChange(newValue);
            break;
        }
      },
      callbacks.onCancel,
      { enableSearch: true }
    );
    this.addChild(this.settingsList);
    this.addChild(new DynamicBorder());
  }
  getSettingsList() {
    return this.settingsList;
  }
}
export {
  SelectSubmenu,
  SettingsSelectorComponent,
  THINKING_DESCRIPTIONS
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL3NldHRpbmdzLXNlbGVjdG9yLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IFRoaW5raW5nTGV2ZWwgfSBmcm9tIFwiQGdzZC9waS1hZ2VudC1jb3JlXCI7XG5pbXBvcnQgdHlwZSB7IFRyYW5zcG9ydCB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgdHlwZSB7IEFkYXB0aXZlVHVpTW9kZSB9IGZyb20gXCIuLi8uLi8uLi9jb3JlL3NldHRpbmdzLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7XG5cdENvbnRhaW5lcixcblx0Z2V0Q2FwYWJpbGl0aWVzLFxuXHR0eXBlIFNlbGVjdEl0ZW0sXG5cdFNlbGVjdExpc3QsXG5cdHR5cGUgU2V0dGluZ0l0ZW0sXG5cdFNldHRpbmdzTGlzdCxcblx0U3BhY2VyLFxuXHRUZXh0LFxufSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB7IGdldFNlbGVjdExpc3RUaGVtZSwgZ2V0U2V0dGluZ3NMaXN0VGhlbWUsIHRoZW1lIH0gZnJvbSBcIi4uL3RoZW1lL3RoZW1lLmpzXCI7XG5pbXBvcnQgeyBEeW5hbWljQm9yZGVyIH0gZnJvbSBcIi4vZHluYW1pYy1ib3JkZXIuanNcIjtcblxuZXhwb3J0IGNvbnN0IFRISU5LSU5HX0RFU0NSSVBUSU9OUzogUmVjb3JkPFRoaW5raW5nTGV2ZWwsIHN0cmluZz4gPSB7XG5cdG9mZjogXCJObyByZWFzb25pbmdcIixcblx0bWluaW1hbDogXCJWZXJ5IGJyaWVmIHJlYXNvbmluZyAofjFrIHRva2VucylcIixcblx0bG93OiBcIkxpZ2h0IHJlYXNvbmluZyAofjJrIHRva2VucylcIixcblx0bWVkaXVtOiBcIk1vZGVyYXRlIHJlYXNvbmluZyAofjhrIHRva2VucylcIixcblx0aGlnaDogXCJEZWVwIHJlYXNvbmluZyAofjE2ayB0b2tlbnMpXCIsXG5cdHhoaWdoOiBcIk1heGltdW0gcmVhc29uaW5nICh+MzJrIHRva2VucylcIixcbn07XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dGluZ3NDb25maWcge1xuXHRhdXRvQ29tcGFjdDogYm9vbGVhbjtcblx0c2hvd0ltYWdlczogYm9vbGVhbjtcblx0YXV0b1Jlc2l6ZUltYWdlczogYm9vbGVhbjtcblx0YmxvY2tJbWFnZXM6IGJvb2xlYW47XG5cdGVuYWJsZVNraWxsQ29tbWFuZHM6IGJvb2xlYW47XG5cdHN0ZWVyaW5nTW9kZTogXCJhbGxcIiB8IFwib25lLWF0LWEtdGltZVwiO1xuXHRmb2xsb3dVcE1vZGU6IFwiYWxsXCIgfCBcIm9uZS1hdC1hLXRpbWVcIjtcblx0dHJhbnNwb3J0OiBUcmFuc3BvcnQ7XG5cdHRoaW5raW5nTGV2ZWw6IFRoaW5raW5nTGV2ZWw7XG5cdGF2YWlsYWJsZVRoaW5raW5nTGV2ZWxzOiBUaGlua2luZ0xldmVsW107XG5cdGN1cnJlbnRUaGVtZTogc3RyaW5nO1xuXHRhdmFpbGFibGVUaGVtZXM6IHN0cmluZ1tdO1xuXHRoaWRlVGhpbmtpbmdCbG9jazogYm9vbGVhbjtcblx0Y29sbGFwc2VDaGFuZ2Vsb2c6IGJvb2xlYW47XG5cdGRvdWJsZUVzY2FwZUFjdGlvbjogXCJmb3JrXCIgfCBcInRyZWVcIiB8IFwibm9uZVwiO1xuXHR0cmVlRmlsdGVyTW9kZTogXCJkZWZhdWx0XCIgfCBcIm5vLXRvb2xzXCIgfCBcInVzZXItb25seVwiIHwgXCJsYWJlbGVkLW9ubHlcIiB8IFwiYWxsXCI7XG5cdHNob3dIYXJkd2FyZUN1cnNvcjogYm9vbGVhbjtcblx0ZWRpdG9yUGFkZGluZ1g6IG51bWJlcjtcblx0YXV0b2NvbXBsZXRlTWF4VmlzaWJsZTogbnVtYmVyO1xuXHRyZXNwZWN0R2l0aWdub3JlSW5QaWNrZXI6IGJvb2xlYW47XG5cdHF1aWV0U3RhcnR1cDogYm9vbGVhbjtcblx0Y2xlYXJPblNocmluazogYm9vbGVhbjtcblx0dGltZXN0YW1wRm9ybWF0OiBcImRhdGUtdGltZS1pc29cIiB8IFwiZGF0ZS10aW1lLXVzXCI7XG5cdGFkYXB0aXZlTW9kZTogQWRhcHRpdmVUdWlNb2RlO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNldHRpbmdzQ2FsbGJhY2tzIHtcblx0b25BdXRvQ29tcGFjdENoYW5nZTogKGVuYWJsZWQ6IGJvb2xlYW4pID0+IHZvaWQ7XG5cdG9uU2hvd0ltYWdlc0NoYW5nZTogKGVuYWJsZWQ6IGJvb2xlYW4pID0+IHZvaWQ7XG5cdG9uQXV0b1Jlc2l6ZUltYWdlc0NoYW5nZTogKGVuYWJsZWQ6IGJvb2xlYW4pID0+IHZvaWQ7XG5cdG9uQmxvY2tJbWFnZXNDaGFuZ2U6IChibG9ja2VkOiBib29sZWFuKSA9PiB2b2lkO1xuXHRvbkVuYWJsZVNraWxsQ29tbWFuZHNDaGFuZ2U6IChlbmFibGVkOiBib29sZWFuKSA9PiB2b2lkO1xuXHRvblN0ZWVyaW5nTW9kZUNoYW5nZTogKG1vZGU6IFwiYWxsXCIgfCBcIm9uZS1hdC1hLXRpbWVcIikgPT4gdm9pZDtcblx0b25Gb2xsb3dVcE1vZGVDaGFuZ2U6IChtb2RlOiBcImFsbFwiIHwgXCJvbmUtYXQtYS10aW1lXCIpID0+IHZvaWQ7XG5cdG9uVHJhbnNwb3J0Q2hhbmdlOiAodHJhbnNwb3J0OiBUcmFuc3BvcnQpID0+IHZvaWQ7XG5cdG9uVGhpbmtpbmdMZXZlbENoYW5nZTogKGxldmVsOiBUaGlua2luZ0xldmVsKSA9PiB2b2lkO1xuXHRvblRoZW1lQ2hhbmdlOiAodGhlbWU6IHN0cmluZykgPT4gdm9pZDtcblx0b25UaGVtZVByZXZpZXc/OiAodGhlbWU6IHN0cmluZykgPT4gdm9pZDtcblx0b25IaWRlVGhpbmtpbmdCbG9ja0NoYW5nZTogKGhpZGRlbjogYm9vbGVhbikgPT4gdm9pZDtcblx0b25Db2xsYXBzZUNoYW5nZWxvZ0NoYW5nZTogKGNvbGxhcHNlZDogYm9vbGVhbikgPT4gdm9pZDtcblx0b25Eb3VibGVFc2NhcGVBY3Rpb25DaGFuZ2U6IChhY3Rpb246IFwiZm9ya1wiIHwgXCJ0cmVlXCIgfCBcIm5vbmVcIikgPT4gdm9pZDtcblx0b25UcmVlRmlsdGVyTW9kZUNoYW5nZTogKG1vZGU6IFwiZGVmYXVsdFwiIHwgXCJuby10b29sc1wiIHwgXCJ1c2VyLW9ubHlcIiB8IFwibGFiZWxlZC1vbmx5XCIgfCBcImFsbFwiKSA9PiB2b2lkO1xuXHRvblNob3dIYXJkd2FyZUN1cnNvckNoYW5nZTogKGVuYWJsZWQ6IGJvb2xlYW4pID0+IHZvaWQ7XG5cdG9uRWRpdG9yUGFkZGluZ1hDaGFuZ2U6IChwYWRkaW5nOiBudW1iZXIpID0+IHZvaWQ7XG5cdG9uQXV0b2NvbXBsZXRlTWF4VmlzaWJsZUNoYW5nZTogKG1heFZpc2libGU6IG51bWJlcikgPT4gdm9pZDtcblx0b25SZXNwZWN0R2l0aWdub3JlSW5QaWNrZXJDaGFuZ2U6IChlbmFibGVkOiBib29sZWFuKSA9PiB2b2lkO1xuXHRvblF1aWV0U3RhcnR1cENoYW5nZTogKGVuYWJsZWQ6IGJvb2xlYW4pID0+IHZvaWQ7XG5cdG9uQ2xlYXJPblNocmlua0NoYW5nZTogKGVuYWJsZWQ6IGJvb2xlYW4pID0+IHZvaWQ7XG5cdG9uVGltZXN0YW1wRm9ybWF0Q2hhbmdlOiAoZm9ybWF0OiBcImRhdGUtdGltZS1pc29cIiB8IFwiZGF0ZS10aW1lLXVzXCIpID0+IHZvaWQ7XG5cdG9uQWRhcHRpdmVNb2RlQ2hhbmdlOiAobW9kZTogQWRhcHRpdmVUdWlNb2RlKSA9PiB2b2lkO1xuXHRvbkNhbmNlbDogKCkgPT4gdm9pZDtcbn1cblxuLyoqXG4gKiBBIHN1Ym1lbnUgY29tcG9uZW50IGZvciBzZWxlY3RpbmcgZnJvbSBhIGxpc3Qgb2Ygb3B0aW9ucy5cbiAqL1xuZXhwb3J0IGNsYXNzIFNlbGVjdFN1Ym1lbnUgZXh0ZW5kcyBDb250YWluZXIge1xuXHRwcml2YXRlIHNlbGVjdExpc3Q6IFNlbGVjdExpc3Q7XG5cblx0Y29uc3RydWN0b3IoXG5cdFx0dGl0bGU6IHN0cmluZyxcblx0XHRkZXNjcmlwdGlvbjogc3RyaW5nLFxuXHRcdG9wdGlvbnM6IFNlbGVjdEl0ZW1bXSxcblx0XHRjdXJyZW50VmFsdWU6IHN0cmluZyxcblx0XHRvblNlbGVjdDogKHZhbHVlOiBzdHJpbmcpID0+IHZvaWQsXG5cdFx0b25DYW5jZWw6ICgpID0+IHZvaWQsXG5cdFx0b25TZWxlY3Rpb25DaGFuZ2U/OiAodmFsdWU6IHN0cmluZykgPT4gdm9pZCxcblx0KSB7XG5cdFx0c3VwZXIoKTtcblxuXHRcdC8vIFRpdGxlXG5cdFx0dGhpcy5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5ib2xkKHRoZW1lLmZnKFwiYWNjZW50XCIsIHRpdGxlKSksIDAsIDApKTtcblxuXHRcdC8vIERlc2NyaXB0aW9uXG5cdFx0aWYgKGRlc2NyaXB0aW9uKSB7XG5cdFx0XHR0aGlzLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdFx0dGhpcy5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5mZyhcIm11dGVkXCIsIGRlc2NyaXB0aW9uKSwgMCwgMCkpO1xuXHRcdH1cblxuXHRcdC8vIFNwYWNlclxuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cblx0XHQvLyBTZWxlY3QgbGlzdFxuXHRcdHRoaXMuc2VsZWN0TGlzdCA9IG5ldyBTZWxlY3RMaXN0KG9wdGlvbnMsIE1hdGgubWluKG9wdGlvbnMubGVuZ3RoLCAxMCksIGdldFNlbGVjdExpc3RUaGVtZSgpKTtcblxuXHRcdC8vIFByZS1zZWxlY3QgY3VycmVudCB2YWx1ZVxuXHRcdGNvbnN0IGN1cnJlbnRJbmRleCA9IG9wdGlvbnMuZmluZEluZGV4KChvKSA9PiBvLnZhbHVlID09PSBjdXJyZW50VmFsdWUpO1xuXHRcdGlmIChjdXJyZW50SW5kZXggIT09IC0xKSB7XG5cdFx0XHR0aGlzLnNlbGVjdExpc3Quc2V0U2VsZWN0ZWRJbmRleChjdXJyZW50SW5kZXgpO1xuXHRcdH1cblxuXHRcdHRoaXMuc2VsZWN0TGlzdC5vblNlbGVjdCA9IChpdGVtKSA9PiB7XG5cdFx0XHRvblNlbGVjdChpdGVtLnZhbHVlKTtcblx0XHR9O1xuXG5cdFx0dGhpcy5zZWxlY3RMaXN0Lm9uQ2FuY2VsID0gb25DYW5jZWw7XG5cblx0XHRpZiAob25TZWxlY3Rpb25DaGFuZ2UpIHtcblx0XHRcdHRoaXMuc2VsZWN0TGlzdC5vblNlbGVjdGlvbkNoYW5nZSA9IChpdGVtKSA9PiB7XG5cdFx0XHRcdG9uU2VsZWN0aW9uQ2hhbmdlKGl0ZW0udmFsdWUpO1xuXHRcdFx0fTtcblx0XHR9XG5cblx0XHR0aGlzLmFkZENoaWxkKHRoaXMuc2VsZWN0TGlzdCk7XG5cblx0XHQvLyBIaW50XG5cdFx0dGhpcy5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHR0aGlzLmFkZENoaWxkKG5ldyBUZXh0KHRoZW1lLmZnKFwiZGltXCIsIFwiICBFbnRlciB0byBzZWxlY3QgXHUwMEI3IEVzYyB0byBnbyBiYWNrXCIpLCAwLCAwKSk7XG5cdH1cblxuXHRoYW5kbGVJbnB1dChkYXRhOiBzdHJpbmcpOiB2b2lkIHtcblx0XHR0aGlzLnNlbGVjdExpc3QuaGFuZGxlSW5wdXQoZGF0YSk7XG5cdH1cbn1cblxuLyoqXG4gKiBNYWluIHNldHRpbmdzIHNlbGVjdG9yIGNvbXBvbmVudC5cbiAqL1xuZXhwb3J0IGNsYXNzIFNldHRpbmdzU2VsZWN0b3JDb21wb25lbnQgZXh0ZW5kcyBDb250YWluZXIge1xuXHRwcml2YXRlIHNldHRpbmdzTGlzdDogU2V0dGluZ3NMaXN0O1xuXG5cdGNvbnN0cnVjdG9yKGNvbmZpZzogU2V0dGluZ3NDb25maWcsIGNhbGxiYWNrczogU2V0dGluZ3NDYWxsYmFja3MpIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0Y29uc3Qgc3VwcG9ydHNJbWFnZXMgPSBnZXRDYXBhYmlsaXRpZXMoKS5pbWFnZXM7XG5cblx0XHRjb25zdCBpdGVtczogU2V0dGluZ0l0ZW1bXSA9IFtcblx0XHRcdHtcblx0XHRcdFx0aWQ6IFwiYXV0b2NvbXBhY3RcIixcblx0XHRcdFx0bGFiZWw6IFwiQXV0by1jb21wYWN0XCIsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBcIkF1dG9tYXRpY2FsbHkgY29tcGFjdCBjb250ZXh0IHdoZW4gaXQgZ2V0cyB0b28gbGFyZ2VcIixcblx0XHRcdFx0Y3VycmVudFZhbHVlOiBjb25maWcuYXV0b0NvbXBhY3QgPyBcInRydWVcIiA6IFwiZmFsc2VcIixcblx0XHRcdFx0dmFsdWVzOiBbXCJ0cnVlXCIsIFwiZmFsc2VcIl0sXG5cdFx0XHR9LFxuXHRcdFx0e1xuXHRcdFx0XHRpZDogXCJzdGVlcmluZy1tb2RlXCIsXG5cdFx0XHRcdGxhYmVsOiBcIlN0ZWVyaW5nIG1vZGVcIixcblx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XCJFbnRlciB3aGlsZSBzdHJlYW1pbmcgcXVldWVzIHN0ZWVyaW5nIG1lc3NhZ2VzLiAnb25lLWF0LWEtdGltZSc6IGRlbGl2ZXIgb25lLCB3YWl0IGZvciByZXNwb25zZS4gJ2FsbCc6IGRlbGl2ZXIgYWxsIGF0IG9uY2UuXCIsXG5cdFx0XHRcdGN1cnJlbnRWYWx1ZTogY29uZmlnLnN0ZWVyaW5nTW9kZSxcblx0XHRcdFx0dmFsdWVzOiBbXCJvbmUtYXQtYS10aW1lXCIsIFwiYWxsXCJdLFxuXHRcdFx0fSxcblx0XHRcdHtcblx0XHRcdFx0aWQ6IFwiZm9sbG93LXVwLW1vZGVcIixcblx0XHRcdFx0bGFiZWw6IFwiRm9sbG93LXVwIG1vZGVcIixcblx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0YCR7cHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIiA/IFwiXHUyMzI1RW50ZXJcIiA6IFwiQWx0K0VudGVyXCJ9IHF1ZXVlcyBmb2xsb3ctdXAgbWVzc2FnZXMgdW50aWwgYWdlbnQgc3RvcHMuICdvbmUtYXQtYS10aW1lJzogZGVsaXZlciBvbmUsIHdhaXQgZm9yIHJlc3BvbnNlLiAnYWxsJzogZGVsaXZlciBhbGwgYXQgb25jZS5gLFxuXHRcdFx0XHRjdXJyZW50VmFsdWU6IGNvbmZpZy5mb2xsb3dVcE1vZGUsXG5cdFx0XHRcdHZhbHVlczogW1wib25lLWF0LWEtdGltZVwiLCBcImFsbFwiXSxcblx0XHRcdH0sXG5cdFx0XHR7XG5cdFx0XHRcdGlkOiBcInRyYW5zcG9ydFwiLFxuXHRcdFx0XHRsYWJlbDogXCJUcmFuc3BvcnRcIixcblx0XHRcdFx0ZGVzY3JpcHRpb246IFwiUHJlZmVycmVkIHRyYW5zcG9ydCBmb3IgcHJvdmlkZXJzIHRoYXQgc3VwcG9ydCBtdWx0aXBsZSB0cmFuc3BvcnRzXCIsXG5cdFx0XHRcdGN1cnJlbnRWYWx1ZTogY29uZmlnLnRyYW5zcG9ydCxcblx0XHRcdFx0dmFsdWVzOiBbXCJzc2VcIiwgXCJ3ZWJzb2NrZXRcIiwgXCJhdXRvXCJdLFxuXHRcdFx0fSxcblx0XHRcdHtcblx0XHRcdFx0aWQ6IFwiaGlkZS10aGlua2luZ1wiLFxuXHRcdFx0XHRsYWJlbDogXCJIaWRlIHRoaW5raW5nXCIsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBcIkhpZGUgdGhpbmtpbmcgYmxvY2tzIGluIGFzc2lzdGFudCByZXNwb25zZXNcIixcblx0XHRcdFx0Y3VycmVudFZhbHVlOiBjb25maWcuaGlkZVRoaW5raW5nQmxvY2sgPyBcInRydWVcIiA6IFwiZmFsc2VcIixcblx0XHRcdFx0dmFsdWVzOiBbXCJ0cnVlXCIsIFwiZmFsc2VcIl0sXG5cdFx0XHR9LFxuXHRcdFx0e1xuXHRcdFx0XHRpZDogXCJjb2xsYXBzZS1jaGFuZ2Vsb2dcIixcblx0XHRcdFx0bGFiZWw6IFwiQ29sbGFwc2UgY2hhbmdlbG9nXCIsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBcIlNob3cgY29uZGVuc2VkIGNoYW5nZWxvZyBhZnRlciB1cGRhdGVzXCIsXG5cdFx0XHRcdGN1cnJlbnRWYWx1ZTogY29uZmlnLmNvbGxhcHNlQ2hhbmdlbG9nID8gXCJ0cnVlXCIgOiBcImZhbHNlXCIsXG5cdFx0XHRcdHZhbHVlczogW1widHJ1ZVwiLCBcImZhbHNlXCJdLFxuXHRcdFx0fSxcblx0XHRcdHtcblx0XHRcdFx0aWQ6IFwicXVpZXQtc3RhcnR1cFwiLFxuXHRcdFx0XHRsYWJlbDogXCJRdWlldCBzdGFydHVwXCIsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBcIkRpc2FibGUgdmVyYm9zZSBwcmludGluZyBhdCBzdGFydHVwXCIsXG5cdFx0XHRcdGN1cnJlbnRWYWx1ZTogY29uZmlnLnF1aWV0U3RhcnR1cCA/IFwidHJ1ZVwiIDogXCJmYWxzZVwiLFxuXHRcdFx0XHR2YWx1ZXM6IFtcInRydWVcIiwgXCJmYWxzZVwiXSxcblx0XHRcdH0sXG5cdFx0XHR7XG5cdFx0XHRcdGlkOiBcImRvdWJsZS1lc2NhcGUtYWN0aW9uXCIsXG5cdFx0XHRcdGxhYmVsOiBcIkRvdWJsZS1lc2NhcGUgYWN0aW9uXCIsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBcIkFjdGlvbiB3aGVuIHByZXNzaW5nIEVzY2FwZSB0d2ljZSB3aXRoIGVtcHR5IGVkaXRvclwiLFxuXHRcdFx0XHRjdXJyZW50VmFsdWU6IGNvbmZpZy5kb3VibGVFc2NhcGVBY3Rpb24sXG5cdFx0XHRcdHZhbHVlczogW1widHJlZVwiLCBcImZvcmtcIiwgXCJub25lXCJdLFxuXHRcdFx0fSxcblx0XHRcdHtcblx0XHRcdFx0aWQ6IFwidHJlZS1maWx0ZXItbW9kZVwiLFxuXHRcdFx0XHRsYWJlbDogXCJUcmVlIGZpbHRlciBtb2RlXCIsXG5cdFx0XHRcdGRlc2NyaXB0aW9uOiBcIkRlZmF1bHQgZmlsdGVyIHdoZW4gb3BlbmluZyAvdHJlZVwiLFxuXHRcdFx0XHRjdXJyZW50VmFsdWU6IGNvbmZpZy50cmVlRmlsdGVyTW9kZSxcblx0XHRcdFx0dmFsdWVzOiBbXCJkZWZhdWx0XCIsIFwibm8tdG9vbHNcIiwgXCJ1c2VyLW9ubHlcIiwgXCJsYWJlbGVkLW9ubHlcIiwgXCJhbGxcIl0sXG5cdFx0XHR9LFxuXHRcdFx0e1xuXHRcdFx0XHRpZDogXCJ0aGlua2luZ1wiLFxuXHRcdFx0XHRsYWJlbDogXCJUaGlua2luZyBsZXZlbFwiLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogXCJSZWFzb25pbmcgZGVwdGggZm9yIHRoaW5raW5nLWNhcGFibGUgbW9kZWxzXCIsXG5cdFx0XHRcdGN1cnJlbnRWYWx1ZTogY29uZmlnLnRoaW5raW5nTGV2ZWwsXG5cdFx0XHRcdHN1Ym1lbnU6IChjdXJyZW50VmFsdWUsIGRvbmUpID0+XG5cdFx0XHRcdFx0bmV3IFNlbGVjdFN1Ym1lbnUoXG5cdFx0XHRcdFx0XHRcIlRoaW5raW5nIExldmVsXCIsXG5cdFx0XHRcdFx0XHRcIlNlbGVjdCByZWFzb25pbmcgZGVwdGggZm9yIHRoaW5raW5nLWNhcGFibGUgbW9kZWxzXCIsXG5cdFx0XHRcdFx0XHRjb25maWcuYXZhaWxhYmxlVGhpbmtpbmdMZXZlbHMubWFwKChsZXZlbCkgPT4gKHtcblx0XHRcdFx0XHRcdFx0dmFsdWU6IGxldmVsLFxuXHRcdFx0XHRcdFx0XHRsYWJlbDogbGV2ZWwsXG5cdFx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBUSElOS0lOR19ERVNDUklQVElPTlNbbGV2ZWxdLFxuXHRcdFx0XHRcdFx0fSkpLFxuXHRcdFx0XHRcdFx0Y3VycmVudFZhbHVlLFxuXHRcdFx0XHRcdFx0KHZhbHVlKSA9PiB7XG5cdFx0XHRcdFx0XHRcdGNhbGxiYWNrcy5vblRoaW5raW5nTGV2ZWxDaGFuZ2UodmFsdWUgYXMgVGhpbmtpbmdMZXZlbCk7XG5cdFx0XHRcdFx0XHRcdGRvbmUodmFsdWUpO1xuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRcdCgpID0+IGRvbmUoKSxcblx0XHRcdFx0XHQpLFxuXHRcdFx0fSxcblx0XHRcdHtcblx0XHRcdFx0aWQ6IFwidGhlbWVcIixcblx0XHRcdFx0bGFiZWw6IFwiVGhlbWVcIixcblx0XHRcdFx0ZGVzY3JpcHRpb246IFwiQ29sb3IgdGhlbWUgZm9yIHRoZSBpbnRlcmZhY2VcIixcblx0XHRcdFx0Y3VycmVudFZhbHVlOiBjb25maWcuY3VycmVudFRoZW1lLFxuXHRcdFx0XHRzdWJtZW51OiAoY3VycmVudFZhbHVlLCBkb25lKSA9PlxuXHRcdFx0XHRcdG5ldyBTZWxlY3RTdWJtZW51KFxuXHRcdFx0XHRcdFx0XCJUaGVtZVwiLFxuXHRcdFx0XHRcdFx0XCJTZWxlY3QgY29sb3IgdGhlbWVcIixcblx0XHRcdFx0XHRcdGNvbmZpZy5hdmFpbGFibGVUaGVtZXMubWFwKCh0KSA9PiAoe1xuXHRcdFx0XHRcdFx0XHR2YWx1ZTogdCxcblx0XHRcdFx0XHRcdFx0bGFiZWw6IHQsXG5cdFx0XHRcdFx0XHR9KSksXG5cdFx0XHRcdFx0XHRjdXJyZW50VmFsdWUsXG5cdFx0XHRcdFx0XHQodmFsdWUpID0+IHtcblx0XHRcdFx0XHRcdFx0Y2FsbGJhY2tzLm9uVGhlbWVDaGFuZ2UodmFsdWUpO1xuXHRcdFx0XHRcdFx0XHRkb25lKHZhbHVlKTtcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHQoKSA9PiB7XG5cdFx0XHRcdFx0XHRcdC8vIFJlc3RvcmUgb3JpZ2luYWwgdGhlbWUgb24gY2FuY2VsXG5cdFx0XHRcdFx0XHRcdGNhbGxiYWNrcy5vblRoZW1lUHJldmlldz8uKGN1cnJlbnRWYWx1ZSk7XG5cdFx0XHRcdFx0XHRcdGRvbmUoKTtcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHQodmFsdWUpID0+IHtcblx0XHRcdFx0XHRcdFx0Ly8gUHJldmlldyB0aGVtZSBvbiBzZWxlY3Rpb24gY2hhbmdlXG5cdFx0XHRcdFx0XHRcdGNhbGxiYWNrcy5vblRoZW1lUHJldmlldz8uKHZhbHVlKTtcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0KSxcblx0XHRcdH0sXG5cdFx0XTtcblxuXHRcdC8vIE9ubHkgc2hvdyBpbWFnZSB0b2dnbGUgaWYgdGVybWluYWwgc3VwcG9ydHMgaXRcblx0XHRpZiAoc3VwcG9ydHNJbWFnZXMpIHtcblx0XHRcdC8vIEluc2VydCBhZnRlciBhdXRvY29tcGFjdFxuXHRcdFx0aXRlbXMuc3BsaWNlKDEsIDAsIHtcblx0XHRcdFx0aWQ6IFwic2hvdy1pbWFnZXNcIixcblx0XHRcdFx0bGFiZWw6IFwiU2hvdyBpbWFnZXNcIixcblx0XHRcdFx0ZGVzY3JpcHRpb246IFwiUmVuZGVyIGltYWdlcyBpbmxpbmUgaW4gdGVybWluYWxcIixcblx0XHRcdFx0Y3VycmVudFZhbHVlOiBjb25maWcuc2hvd0ltYWdlcyA/IFwidHJ1ZVwiIDogXCJmYWxzZVwiLFxuXHRcdFx0XHR2YWx1ZXM6IFtcInRydWVcIiwgXCJmYWxzZVwiXSxcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdC8vIEltYWdlIGF1dG8tcmVzaXplIHRvZ2dsZSAoYWx3YXlzIGF2YWlsYWJsZSwgYWZmZWN0cyBib3RoIGF0dGFjaGVkIGFuZCByZWFkIGltYWdlcylcblx0XHRpdGVtcy5zcGxpY2Uoc3VwcG9ydHNJbWFnZXMgPyAyIDogMSwgMCwge1xuXHRcdFx0aWQ6IFwiYXV0by1yZXNpemUtaW1hZ2VzXCIsXG5cdFx0XHRsYWJlbDogXCJBdXRvLXJlc2l6ZSBpbWFnZXNcIixcblx0XHRcdGRlc2NyaXB0aW9uOiBcIlJlc2l6ZSBsYXJnZSBpbWFnZXMgdG8gMjAwMHgyMDAwIG1heCBmb3IgYmV0dGVyIG1vZGVsIGNvbXBhdGliaWxpdHlcIixcblx0XHRcdGN1cnJlbnRWYWx1ZTogY29uZmlnLmF1dG9SZXNpemVJbWFnZXMgPyBcInRydWVcIiA6IFwiZmFsc2VcIixcblx0XHRcdHZhbHVlczogW1widHJ1ZVwiLCBcImZhbHNlXCJdLFxuXHRcdH0pO1xuXG5cdFx0Ly8gQmxvY2sgaW1hZ2VzIHRvZ2dsZSAoYWx3YXlzIGF2YWlsYWJsZSwgaW5zZXJ0IGFmdGVyIGF1dG8tcmVzaXplLWltYWdlcylcblx0XHRjb25zdCBhdXRvUmVzaXplSW5kZXggPSBpdGVtcy5maW5kSW5kZXgoKGl0ZW0pID0+IGl0ZW0uaWQgPT09IFwiYXV0by1yZXNpemUtaW1hZ2VzXCIpO1xuXHRcdGl0ZW1zLnNwbGljZShhdXRvUmVzaXplSW5kZXggKyAxLCAwLCB7XG5cdFx0XHRpZDogXCJibG9jay1pbWFnZXNcIixcblx0XHRcdGxhYmVsOiBcIkJsb2NrIGltYWdlc1wiLFxuXHRcdFx0ZGVzY3JpcHRpb246IFwiUHJldmVudCBpbWFnZXMgZnJvbSBiZWluZyBzZW50IHRvIExMTSBwcm92aWRlcnNcIixcblx0XHRcdGN1cnJlbnRWYWx1ZTogY29uZmlnLmJsb2NrSW1hZ2VzID8gXCJ0cnVlXCIgOiBcImZhbHNlXCIsXG5cdFx0XHR2YWx1ZXM6IFtcInRydWVcIiwgXCJmYWxzZVwiXSxcblx0XHR9KTtcblxuXHRcdC8vIFNraWxsIGNvbW1hbmRzIHRvZ2dsZSAoaW5zZXJ0IGFmdGVyIGJsb2NrLWltYWdlcylcblx0XHRjb25zdCBibG9ja0ltYWdlc0luZGV4ID0gaXRlbXMuZmluZEluZGV4KChpdGVtKSA9PiBpdGVtLmlkID09PSBcImJsb2NrLWltYWdlc1wiKTtcblx0XHRpdGVtcy5zcGxpY2UoYmxvY2tJbWFnZXNJbmRleCArIDEsIDAsIHtcblx0XHRcdGlkOiBcInNraWxsLWNvbW1hbmRzXCIsXG5cdFx0XHRsYWJlbDogXCJTa2lsbCBjb21tYW5kc1wiLFxuXHRcdFx0ZGVzY3JpcHRpb246IFwiUmVnaXN0ZXIgc2tpbGxzIGFzIC9za2lsbDpuYW1lIGNvbW1hbmRzXCIsXG5cdFx0XHRjdXJyZW50VmFsdWU6IGNvbmZpZy5lbmFibGVTa2lsbENvbW1hbmRzID8gXCJ0cnVlXCIgOiBcImZhbHNlXCIsXG5cdFx0XHR2YWx1ZXM6IFtcInRydWVcIiwgXCJmYWxzZVwiXSxcblx0XHR9KTtcblxuXHRcdC8vIEhhcmR3YXJlIGN1cnNvciB0b2dnbGUgKGluc2VydCBhZnRlciBza2lsbC1jb21tYW5kcylcblx0XHRjb25zdCBza2lsbENvbW1hbmRzSW5kZXggPSBpdGVtcy5maW5kSW5kZXgoKGl0ZW0pID0+IGl0ZW0uaWQgPT09IFwic2tpbGwtY29tbWFuZHNcIik7XG5cdFx0aXRlbXMuc3BsaWNlKHNraWxsQ29tbWFuZHNJbmRleCArIDEsIDAsIHtcblx0XHRcdGlkOiBcInNob3ctaGFyZHdhcmUtY3Vyc29yXCIsXG5cdFx0XHRsYWJlbDogXCJTaG93IGhhcmR3YXJlIGN1cnNvclwiLFxuXHRcdFx0ZGVzY3JpcHRpb246IFwiU2hvdyB0aGUgdGVybWluYWwgY3Vyc29yIHdoaWxlIHN0aWxsIHBvc2l0aW9uaW5nIGl0IGZvciBJTUUgc3VwcG9ydFwiLFxuXHRcdFx0Y3VycmVudFZhbHVlOiBjb25maWcuc2hvd0hhcmR3YXJlQ3Vyc29yID8gXCJ0cnVlXCIgOiBcImZhbHNlXCIsXG5cdFx0XHR2YWx1ZXM6IFtcInRydWVcIiwgXCJmYWxzZVwiXSxcblx0XHR9KTtcblxuXHRcdC8vIEVkaXRvciBwYWRkaW5nIHRvZ2dsZSAoaW5zZXJ0IGFmdGVyIHNob3ctaGFyZHdhcmUtY3Vyc29yKVxuXHRcdGNvbnN0IGhhcmR3YXJlQ3Vyc29ySW5kZXggPSBpdGVtcy5maW5kSW5kZXgoKGl0ZW0pID0+IGl0ZW0uaWQgPT09IFwic2hvdy1oYXJkd2FyZS1jdXJzb3JcIik7XG5cdFx0aXRlbXMuc3BsaWNlKGhhcmR3YXJlQ3Vyc29ySW5kZXggKyAxLCAwLCB7XG5cdFx0XHRpZDogXCJlZGl0b3ItcGFkZGluZ1wiLFxuXHRcdFx0bGFiZWw6IFwiRWRpdG9yIHBhZGRpbmdcIixcblx0XHRcdGRlc2NyaXB0aW9uOiBcIkhvcml6b250YWwgcGFkZGluZyBmb3IgaW5wdXQgZWRpdG9yICgwLTMpXCIsXG5cdFx0XHRjdXJyZW50VmFsdWU6IFN0cmluZyhjb25maWcuZWRpdG9yUGFkZGluZ1gpLFxuXHRcdFx0dmFsdWVzOiBbXCIwXCIsIFwiMVwiLCBcIjJcIiwgXCIzXCJdLFxuXHRcdH0pO1xuXG5cdFx0Ly8gQXV0b2NvbXBsZXRlIG1heCB2aXNpYmxlIHRvZ2dsZSAoaW5zZXJ0IGFmdGVyIGVkaXRvci1wYWRkaW5nKVxuXHRcdGNvbnN0IGVkaXRvclBhZGRpbmdJbmRleCA9IGl0ZW1zLmZpbmRJbmRleCgoaXRlbSkgPT4gaXRlbS5pZCA9PT0gXCJlZGl0b3ItcGFkZGluZ1wiKTtcblx0XHRpdGVtcy5zcGxpY2UoZWRpdG9yUGFkZGluZ0luZGV4ICsgMSwgMCwge1xuXHRcdFx0aWQ6IFwiYXV0b2NvbXBsZXRlLW1heC12aXNpYmxlXCIsXG5cdFx0XHRsYWJlbDogXCJBdXRvY29tcGxldGUgbWF4IGl0ZW1zXCIsXG5cdFx0XHRkZXNjcmlwdGlvbjogXCJNYXggdmlzaWJsZSBpdGVtcyBpbiBhdXRvY29tcGxldGUgZHJvcGRvd24gKDMtMjApXCIsXG5cdFx0XHRjdXJyZW50VmFsdWU6IFN0cmluZyhjb25maWcuYXV0b2NvbXBsZXRlTWF4VmlzaWJsZSksXG5cdFx0XHR2YWx1ZXM6IFtcIjNcIiwgXCI1XCIsIFwiN1wiLCBcIjEwXCIsIFwiMTVcIiwgXCIyMFwiXSxcblx0XHR9KTtcblxuXHRcdC8vIENsZWFyIG9uIHNocmluayB0b2dnbGUgKGluc2VydCBhZnRlciBhdXRvY29tcGxldGUtbWF4LXZpc2libGUpXG5cdFx0Y29uc3QgYXV0b2NvbXBsZXRlSW5kZXggPSBpdGVtcy5maW5kSW5kZXgoKGl0ZW0pID0+IGl0ZW0uaWQgPT09IFwiYXV0b2NvbXBsZXRlLW1heC12aXNpYmxlXCIpO1xuXHRcdGl0ZW1zLnNwbGljZShhdXRvY29tcGxldGVJbmRleCArIDEsIDAsIHtcblx0XHRcdGlkOiBcImNsZWFyLW9uLXNocmlua1wiLFxuXHRcdFx0bGFiZWw6IFwiQ2xlYXIgb24gc2hyaW5rXCIsXG5cdFx0XHRkZXNjcmlwdGlvbjogXCJDbGVhciBlbXB0eSByb3dzIHdoZW4gY29udGVudCBzaHJpbmtzIChtYXkgY2F1c2UgZmxpY2tlcilcIixcblx0XHRcdGN1cnJlbnRWYWx1ZTogY29uZmlnLmNsZWFyT25TaHJpbmsgPyBcInRydWVcIiA6IFwiZmFsc2VcIixcblx0XHRcdHZhbHVlczogW1widHJ1ZVwiLCBcImZhbHNlXCJdLFxuXHRcdH0pO1xuXG5cdFx0Ly8gUmVzcGVjdCAuZ2l0aWdub3JlIGluIGZpbGUgcGlja2VyIHRvZ2dsZSAoaW5zZXJ0IGFmdGVyIGNsZWFyLW9uLXNocmluaylcblx0XHRjb25zdCBjbGVhck9uU2hyaW5rSW5kZXggPSBpdGVtcy5maW5kSW5kZXgoKGl0ZW0pID0+IGl0ZW0uaWQgPT09IFwiY2xlYXItb24tc2hyaW5rXCIpO1xuXHRcdGl0ZW1zLnNwbGljZShjbGVhck9uU2hyaW5rSW5kZXggKyAxLCAwLCB7XG5cdFx0XHRpZDogXCJyZXNwZWN0LWdpdGlnbm9yZS1pbi1waWNrZXJcIixcblx0XHRcdGxhYmVsOiBcIlJlc3BlY3QgLmdpdGlnbm9yZSBpbiBmaWxlIHBpY2tlclwiLFxuXHRcdFx0ZGVzY3JpcHRpb246IFwiV2hlbiBmYWxzZSwgQCBmaWxlIHBpY2tlciBzaG93cyBnaXRpZ25vcmVkIGZpbGVzIHRvb1wiLFxuXHRcdFx0Y3VycmVudFZhbHVlOiBjb25maWcucmVzcGVjdEdpdGlnbm9yZUluUGlja2VyID8gXCJ0cnVlXCIgOiBcImZhbHNlXCIsXG5cdFx0XHR2YWx1ZXM6IFtcInRydWVcIiwgXCJmYWxzZVwiXSxcblx0XHR9KTtcblxuXHRcdC8vIFRpbWVzdGFtcCBmb3JtYXQgKGluc2VydCBhZnRlciByZXNwZWN0LWdpdGlnbm9yZS1pbi1waWNrZXIpXG5cdFx0Y29uc3QgZ2l0aWdub3JlSW5kZXggPSBpdGVtcy5maW5kSW5kZXgoKGl0ZW0pID0+IGl0ZW0uaWQgPT09IFwicmVzcGVjdC1naXRpZ25vcmUtaW4tcGlja2VyXCIpO1xuXHRcdGl0ZW1zLnNwbGljZShnaXRpZ25vcmVJbmRleCArIDEsIDAsIHtcblx0XHRcdGlkOiBcInRpbWVzdGFtcC1mb3JtYXRcIixcblx0XHRcdGxhYmVsOiBcIlRpbWVzdGFtcCBmb3JtYXRcIixcblx0XHRcdGRlc2NyaXB0aW9uOiBcIkRhdGUvdGltZSBmb3JtYXQgZm9yIG1lc3NhZ2UgdGltZXN0YW1wc1wiLFxuXHRcdFx0Y3VycmVudFZhbHVlOiBjb25maWcudGltZXN0YW1wRm9ybWF0LFxuXHRcdFx0dmFsdWVzOiBbXCJkYXRlLXRpbWUtaXNvXCIsIFwiZGF0ZS10aW1lLXVzXCJdLFxuXHRcdH0pO1xuXG5cdFx0Y29uc3QgdGltZXN0YW1wSW5kZXggPSBpdGVtcy5maW5kSW5kZXgoKGl0ZW0pID0+IGl0ZW0uaWQgPT09IFwidGltZXN0YW1wLWZvcm1hdFwiKTtcblx0XHRpdGVtcy5zcGxpY2UodGltZXN0YW1wSW5kZXggKyAxLCAwLCB7XG5cdFx0XHRpZDogXCJhZGFwdGl2ZS1tb2RlXCIsXG5cdFx0XHRsYWJlbDogXCJUVUkgYWRhcHRpdmUgbW9kZVwiLFxuXHRcdFx0ZGVzY3JpcHRpb246IFwiQXV0by1zZWxlY3Qgb3IgZm9yY2UgdGhlIHRlcm1pbmFsIGxheW91dCBtb2RlXCIsXG5cdFx0XHRjdXJyZW50VmFsdWU6IGNvbmZpZy5hZGFwdGl2ZU1vZGUsXG5cdFx0XHR2YWx1ZXM6IFtcImF1dG9cIiwgXCJjaGF0XCIsIFwid29ya2Zsb3dcIiwgXCJ2YWxpZGF0aW9uXCIsIFwiZGVidWdcIiwgXCJjb21wYWN0XCJdLFxuXHRcdH0pO1xuXG5cdFx0Ly8gQWRkIGJvcmRlcnNcblx0XHR0aGlzLmFkZENoaWxkKG5ldyBEeW5hbWljQm9yZGVyKCkpO1xuXG5cdFx0dGhpcy5zZXR0aW5nc0xpc3QgPSBuZXcgU2V0dGluZ3NMaXN0KFxuXHRcdFx0aXRlbXMsXG5cdFx0XHQxMCxcblx0XHRcdGdldFNldHRpbmdzTGlzdFRoZW1lKCksXG5cdFx0XHQoaWQsIG5ld1ZhbHVlKSA9PiB7XG5cdFx0XHRcdHN3aXRjaCAoaWQpIHtcblx0XHRcdFx0XHRjYXNlIFwiYXV0b2NvbXBhY3RcIjpcblx0XHRcdFx0XHRcdGNhbGxiYWNrcy5vbkF1dG9Db21wYWN0Q2hhbmdlKG5ld1ZhbHVlID09PSBcInRydWVcIik7XG5cdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRjYXNlIFwic2hvdy1pbWFnZXNcIjpcblx0XHRcdFx0XHRcdGNhbGxiYWNrcy5vblNob3dJbWFnZXNDaGFuZ2UobmV3VmFsdWUgPT09IFwidHJ1ZVwiKTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdGNhc2UgXCJhdXRvLXJlc2l6ZS1pbWFnZXNcIjpcblx0XHRcdFx0XHRcdGNhbGxiYWNrcy5vbkF1dG9SZXNpemVJbWFnZXNDaGFuZ2UobmV3VmFsdWUgPT09IFwidHJ1ZVwiKTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdGNhc2UgXCJibG9jay1pbWFnZXNcIjpcblx0XHRcdFx0XHRcdGNhbGxiYWNrcy5vbkJsb2NrSW1hZ2VzQ2hhbmdlKG5ld1ZhbHVlID09PSBcInRydWVcIik7XG5cdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRjYXNlIFwic2tpbGwtY29tbWFuZHNcIjpcblx0XHRcdFx0XHRcdGNhbGxiYWNrcy5vbkVuYWJsZVNraWxsQ29tbWFuZHNDaGFuZ2UobmV3VmFsdWUgPT09IFwidHJ1ZVwiKTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdGNhc2UgXCJzdGVlcmluZy1tb2RlXCI6XG5cdFx0XHRcdFx0XHRjYWxsYmFja3Mub25TdGVlcmluZ01vZGVDaGFuZ2UobmV3VmFsdWUgYXMgXCJhbGxcIiB8IFwib25lLWF0LWEtdGltZVwiKTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdGNhc2UgXCJmb2xsb3ctdXAtbW9kZVwiOlxuXHRcdFx0XHRcdFx0Y2FsbGJhY2tzLm9uRm9sbG93VXBNb2RlQ2hhbmdlKG5ld1ZhbHVlIGFzIFwiYWxsXCIgfCBcIm9uZS1hdC1hLXRpbWVcIik7XG5cdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRjYXNlIFwidHJhbnNwb3J0XCI6XG5cdFx0XHRcdFx0XHRjYWxsYmFja3Mub25UcmFuc3BvcnRDaGFuZ2UobmV3VmFsdWUgYXMgVHJhbnNwb3J0KTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdGNhc2UgXCJoaWRlLXRoaW5raW5nXCI6XG5cdFx0XHRcdFx0XHRjYWxsYmFja3Mub25IaWRlVGhpbmtpbmdCbG9ja0NoYW5nZShuZXdWYWx1ZSA9PT0gXCJ0cnVlXCIpO1xuXHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0Y2FzZSBcImNvbGxhcHNlLWNoYW5nZWxvZ1wiOlxuXHRcdFx0XHRcdFx0Y2FsbGJhY2tzLm9uQ29sbGFwc2VDaGFuZ2Vsb2dDaGFuZ2UobmV3VmFsdWUgPT09IFwidHJ1ZVwiKTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdGNhc2UgXCJxdWlldC1zdGFydHVwXCI6XG5cdFx0XHRcdFx0XHRjYWxsYmFja3Mub25RdWlldFN0YXJ0dXBDaGFuZ2UobmV3VmFsdWUgPT09IFwidHJ1ZVwiKTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdGNhc2UgXCJkb3VibGUtZXNjYXBlLWFjdGlvblwiOlxuXHRcdFx0XHRcdFx0Y2FsbGJhY2tzLm9uRG91YmxlRXNjYXBlQWN0aW9uQ2hhbmdlKG5ld1ZhbHVlIGFzIFwiZm9ya1wiIHwgXCJ0cmVlXCIpO1xuXHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0Y2FzZSBcInRyZWUtZmlsdGVyLW1vZGVcIjpcblx0XHRcdFx0XHRcdGNhbGxiYWNrcy5vblRyZWVGaWx0ZXJNb2RlQ2hhbmdlKFxuXHRcdFx0XHRcdFx0XHRuZXdWYWx1ZSBhcyBcImRlZmF1bHRcIiB8IFwibm8tdG9vbHNcIiB8IFwidXNlci1vbmx5XCIgfCBcImxhYmVsZWQtb25seVwiIHwgXCJhbGxcIixcblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRjYXNlIFwic2hvdy1oYXJkd2FyZS1jdXJzb3JcIjpcblx0XHRcdFx0XHRcdGNhbGxiYWNrcy5vblNob3dIYXJkd2FyZUN1cnNvckNoYW5nZShuZXdWYWx1ZSA9PT0gXCJ0cnVlXCIpO1xuXHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0Y2FzZSBcImVkaXRvci1wYWRkaW5nXCI6XG5cdFx0XHRcdFx0XHRjYWxsYmFja3Mub25FZGl0b3JQYWRkaW5nWENoYW5nZShwYXJzZUludChuZXdWYWx1ZSwgMTApKTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdGNhc2UgXCJhdXRvY29tcGxldGUtbWF4LXZpc2libGVcIjpcblx0XHRcdFx0XHRcdGNhbGxiYWNrcy5vbkF1dG9jb21wbGV0ZU1heFZpc2libGVDaGFuZ2UocGFyc2VJbnQobmV3VmFsdWUsIDEwKSk7XG5cdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRjYXNlIFwiY2xlYXItb24tc2hyaW5rXCI6XG5cdFx0XHRcdFx0XHRjYWxsYmFja3Mub25DbGVhck9uU2hyaW5rQ2hhbmdlKG5ld1ZhbHVlID09PSBcInRydWVcIik7XG5cdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRjYXNlIFwicmVzcGVjdC1naXRpZ25vcmUtaW4tcGlja2VyXCI6XG5cdFx0XHRcdFx0XHRjYWxsYmFja3Mub25SZXNwZWN0R2l0aWdub3JlSW5QaWNrZXJDaGFuZ2UobmV3VmFsdWUgPT09IFwidHJ1ZVwiKTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdGNhc2UgXCJ0aW1lc3RhbXAtZm9ybWF0XCI6XG5cdFx0XHRcdFx0XHRjYWxsYmFja3Mub25UaW1lc3RhbXBGb3JtYXRDaGFuZ2UobmV3VmFsdWUgYXMgXCJkYXRlLXRpbWUtaXNvXCIgfCBcImRhdGUtdGltZS11c1wiKTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdGNhc2UgXCJhZGFwdGl2ZS1tb2RlXCI6XG5cdFx0XHRcdFx0XHRjYWxsYmFja3Mub25BZGFwdGl2ZU1vZGVDaGFuZ2UobmV3VmFsdWUgYXMgQWRhcHRpdmVUdWlNb2RlKTtcblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cdFx0XHR9LFxuXHRcdFx0Y2FsbGJhY2tzLm9uQ2FuY2VsLFxuXHRcdFx0eyBlbmFibGVTZWFyY2g6IHRydWUgfSxcblx0XHQpO1xuXG5cdFx0dGhpcy5hZGRDaGlsZCh0aGlzLnNldHRpbmdzTGlzdCk7XG5cdFx0dGhpcy5hZGRDaGlsZChuZXcgRHluYW1pY0JvcmRlcigpKTtcblx0fVxuXG5cdGdldFNldHRpbmdzTGlzdCgpOiBTZXR0aW5nc0xpc3Qge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzTGlzdDtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0E7QUFBQSxFQUNDO0FBQUEsRUFDQTtBQUFBLEVBRUE7QUFBQSxFQUVBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBQ1AsU0FBUyxvQkFBb0Isc0JBQXNCLGFBQWE7QUFD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
