import { basename, dirname, join, relative } from "node:path";
import {
  Container,
  getEditorKeybindings,
  Input,
  matchesKey,
  Spacer,
  truncateToWidth,
  visibleWidth
} from "@gsd/pi-tui";
import { CONFIG_DIR_NAME } from "../../../config.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { rawKeyHint } from "./keybinding-hints.js";
const RESOURCE_TYPE_LABELS = {
  extensions: "Extensions",
  skills: "Skills",
  prompts: "Prompts",
  themes: "Themes"
};
function getGroupLabel(metadata) {
  if (metadata.origin === "package") {
    return `${metadata.source} (${metadata.scope})`;
  }
  if (metadata.source === "auto") {
    return metadata.scope === "user" ? "User (~/.pi/agent/)" : "Project (.pi/)";
  }
  return metadata.scope === "user" ? "User settings" : "Project settings";
}
function buildGroups(resolved) {
  const groupMap = /* @__PURE__ */ new Map();
  const addToGroup = (resources, resourceType) => {
    for (const res of resources) {
      const { path, enabled, metadata } = res;
      const groupKey = `${metadata.origin}:${metadata.scope}:${metadata.source}`;
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, {
          key: groupKey,
          label: getGroupLabel(metadata),
          scope: metadata.scope,
          origin: metadata.origin,
          source: metadata.source,
          subgroups: []
        });
      }
      const group = groupMap.get(groupKey);
      const subgroupKey = `${groupKey}:${resourceType}`;
      let subgroup = group.subgroups.find((sg) => sg.type === resourceType);
      if (!subgroup) {
        subgroup = {
          type: resourceType,
          label: RESOURCE_TYPE_LABELS[resourceType],
          items: []
        };
        group.subgroups.push(subgroup);
      }
      const fileName = basename(path);
      const parentFolder = basename(dirname(path));
      let displayName;
      if (resourceType === "extensions" && parentFolder !== "extensions") {
        displayName = `${parentFolder}/${fileName}`;
      } else if (resourceType === "skills" && fileName === "SKILL.md") {
        displayName = parentFolder;
      } else {
        displayName = fileName;
      }
      subgroup.items.push({
        path,
        enabled,
        metadata,
        resourceType,
        displayName,
        groupKey,
        subgroupKey
      });
    }
  };
  addToGroup(resolved.extensions, "extensions");
  addToGroup(resolved.skills, "skills");
  addToGroup(resolved.prompts, "prompts");
  addToGroup(resolved.themes, "themes");
  const groups = Array.from(groupMap.values());
  groups.sort((a, b) => {
    if (a.origin !== b.origin) {
      return a.origin === "package" ? -1 : 1;
    }
    if (a.scope !== b.scope) {
      return a.scope === "user" ? -1 : 1;
    }
    return a.source.localeCompare(b.source);
  });
  const typeOrder = { extensions: 0, skills: 1, prompts: 2, themes: 3 };
  for (const group of groups) {
    group.subgroups.sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);
    for (const subgroup of group.subgroups) {
      subgroup.items.sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
  }
  return groups;
}
class ConfigSelectorHeader {
  invalidate() {
  }
  render(width) {
    const title = theme.bold("Resource Configuration");
    const sep = theme.fg("muted", " \xB7 ");
    const hint = rawKeyHint("space", "toggle") + sep + rawKeyHint("esc", "close");
    const hintWidth = visibleWidth(hint);
    const titleWidth = visibleWidth(title);
    const spacing = Math.max(1, width - titleWidth - hintWidth);
    return [
      truncateToWidth(`${title}${" ".repeat(spacing)}${hint}`, width, ""),
      theme.fg("muted", "Type to filter resources")
    ];
  }
}
class ResourceList {
  constructor(groups, settingsManager, cwd, agentDir) {
    this.flatItems = [];
    this.filteredItems = [];
    this.selectedIndex = 0;
    this.maxVisible = 15;
    this._focused = false;
    this.groups = groups;
    this.settingsManager = settingsManager;
    this.cwd = cwd;
    this.agentDir = agentDir;
    this.searchInput = new Input();
    this.buildFlatList();
    this.filteredItems = [...this.flatItems];
  }
  get focused() {
    return this._focused;
  }
  set focused(value) {
    this._focused = value;
    this.searchInput.focused = value;
  }
  buildFlatList() {
    this.flatItems = [];
    for (const group of this.groups) {
      this.flatItems.push({ type: "group", group });
      for (const subgroup of group.subgroups) {
        this.flatItems.push({ type: "subgroup", subgroup, group });
        for (const item of subgroup.items) {
          this.flatItems.push({ type: "item", item });
        }
      }
    }
    this.selectedIndex = this.flatItems.findIndex((e) => e.type === "item");
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }
  findNextItem(fromIndex, direction) {
    let idx = fromIndex + direction;
    while (idx >= 0 && idx < this.filteredItems.length) {
      if (this.filteredItems[idx].type === "item") {
        return idx;
      }
      idx += direction;
    }
    return fromIndex;
  }
  filterItems(query) {
    if (!query.trim()) {
      this.filteredItems = [...this.flatItems];
      this.selectFirstItem();
      return;
    }
    const lowerQuery = query.toLowerCase();
    const matchingItems = /* @__PURE__ */ new Set();
    const matchingSubgroups = /* @__PURE__ */ new Set();
    const matchingGroups = /* @__PURE__ */ new Set();
    for (const entry of this.flatItems) {
      if (entry.type === "item") {
        const item = entry.item;
        if (item.displayName.toLowerCase().includes(lowerQuery) || item.resourceType.toLowerCase().includes(lowerQuery) || item.path.toLowerCase().includes(lowerQuery)) {
          matchingItems.add(item);
        }
      }
    }
    for (const group of this.groups) {
      for (const subgroup of group.subgroups) {
        for (const item of subgroup.items) {
          if (matchingItems.has(item)) {
            matchingSubgroups.add(subgroup);
            matchingGroups.add(group);
          }
        }
      }
    }
    this.filteredItems = [];
    for (const entry of this.flatItems) {
      if (entry.type === "group" && matchingGroups.has(entry.group)) {
        this.filteredItems.push(entry);
      } else if (entry.type === "subgroup" && matchingSubgroups.has(entry.subgroup)) {
        this.filteredItems.push(entry);
      } else if (entry.type === "item" && matchingItems.has(entry.item)) {
        this.filteredItems.push(entry);
      }
    }
    this.selectFirstItem();
  }
  selectFirstItem() {
    const firstItemIndex = this.filteredItems.findIndex((e) => e.type === "item");
    this.selectedIndex = firstItemIndex >= 0 ? firstItemIndex : 0;
  }
  updateItem(item, enabled) {
    item.enabled = enabled;
    for (const group of this.groups) {
      for (const subgroup of group.subgroups) {
        const found = subgroup.items.find((i) => i.path === item.path && i.resourceType === item.resourceType);
        if (found) {
          found.enabled = enabled;
          return;
        }
      }
    }
  }
  invalidate() {
  }
  render(width) {
    const lines = [];
    lines.push(...this.searchInput.render(width));
    lines.push("");
    if (this.filteredItems.length === 0) {
      lines.push(theme.fg("muted", "  No resources found"));
      return lines;
    }
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible)
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);
    for (let i = startIndex; i < endIndex; i++) {
      const entry = this.filteredItems[i];
      const isSelected = i === this.selectedIndex;
      if (entry.type === "group") {
        const groupLine = theme.fg("accent", theme.bold(entry.group.label));
        lines.push(truncateToWidth(`  ${groupLine}`, width, ""));
      } else if (entry.type === "subgroup") {
        const subgroupLine = theme.fg("muted", entry.subgroup.label);
        lines.push(truncateToWidth(`    ${subgroupLine}`, width, ""));
      } else {
        const item = entry.item;
        const cursor = isSelected ? "> " : "  ";
        const checkbox = item.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
        const name = isSelected ? theme.bold(item.displayName) : item.displayName;
        lines.push(truncateToWidth(`${cursor}    ${checkbox} ${name}`, width, "..."));
      }
    }
    if (startIndex > 0 || endIndex < this.filteredItems.length) {
      const selectableItems = this.filteredItems.filter((e) => e.type === "item");
      const selectableTotal = selectableItems.length;
      const selectablePosition = selectableItems.findIndex(
        (e) => this.filteredItems.indexOf(e) === this.selectedIndex
      );
      lines.push(theme.fg("dim", `  (${selectablePosition + 1}/${selectableTotal})`));
    }
    return lines;
  }
  handleInput(data) {
    const kb = getEditorKeybindings();
    if (kb.matches(data, "selectUp")) {
      this.selectedIndex = this.findNextItem(this.selectedIndex, -1);
      return;
    }
    if (kb.matches(data, "selectDown")) {
      this.selectedIndex = this.findNextItem(this.selectedIndex, 1);
      return;
    }
    if (kb.matches(data, "selectPageUp")) {
      let target = Math.max(0, this.selectedIndex - this.maxVisible);
      while (target < this.filteredItems.length && this.filteredItems[target].type !== "item") {
        target++;
      }
      if (target < this.filteredItems.length) {
        this.selectedIndex = target;
      }
      return;
    }
    if (kb.matches(data, "selectPageDown")) {
      let target = Math.min(this.filteredItems.length - 1, this.selectedIndex + this.maxVisible);
      while (target >= 0 && this.filteredItems[target].type !== "item") {
        target--;
      }
      if (target >= 0) {
        this.selectedIndex = target;
      }
      return;
    }
    if (kb.matches(data, "selectCancel")) {
      this.onCancel?.();
      return;
    }
    if (matchesKey(data, "ctrl+c")) {
      this.onExit?.();
      return;
    }
    if (data === " " || kb.matches(data, "selectConfirm")) {
      const entry = this.filteredItems[this.selectedIndex];
      if (entry?.type === "item") {
        const newEnabled = !entry.item.enabled;
        this.toggleResource(entry.item, newEnabled);
        this.updateItem(entry.item, newEnabled);
        this.onToggle?.(entry.item, newEnabled);
      }
      return;
    }
    this.searchInput.handleInput(data);
    this.filterItems(this.searchInput.getValue());
  }
  toggleResource(item, enabled) {
    if (item.metadata.origin === "top-level") {
      this.toggleTopLevelResource(item, enabled);
    } else {
      this.togglePackageResource(item, enabled);
    }
  }
  toggleTopLevelResource(item, enabled) {
    const scope = item.metadata.scope;
    const settings = scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
    const arrayKey = item.resourceType;
    const current = settings[arrayKey] ?? [];
    const pattern = this.getResourcePattern(item);
    const disablePattern = `-${pattern}`;
    const enablePattern = `+${pattern}`;
    const updated = current.filter((p) => {
      const stripped = p.startsWith("!") || p.startsWith("+") || p.startsWith("-") ? p.slice(1) : p;
      return stripped !== pattern;
    });
    if (enabled) {
      updated.push(enablePattern);
    } else {
      updated.push(disablePattern);
    }
    if (scope === "project") {
      if (arrayKey === "extensions") {
        this.settingsManager.setProjectExtensionPaths(updated);
      } else if (arrayKey === "skills") {
        this.settingsManager.setProjectSkillPaths(updated);
      } else if (arrayKey === "prompts") {
        this.settingsManager.setProjectPromptTemplatePaths(updated);
      } else if (arrayKey === "themes") {
        this.settingsManager.setProjectThemePaths(updated);
      }
    } else {
      if (arrayKey === "extensions") {
        this.settingsManager.setExtensionPaths(updated);
      } else if (arrayKey === "skills") {
        this.settingsManager.setSkillPaths(updated);
      } else if (arrayKey === "prompts") {
        this.settingsManager.setPromptTemplatePaths(updated);
      } else if (arrayKey === "themes") {
        this.settingsManager.setThemePaths(updated);
      }
    }
  }
  togglePackageResource(item, enabled) {
    const scope = item.metadata.scope;
    const settings = scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
    const packages = [...settings.packages ?? []];
    const pkgIndex = packages.findIndex((pkg2) => {
      const source = typeof pkg2 === "string" ? pkg2 : pkg2.source;
      return source === item.metadata.source;
    });
    if (pkgIndex === -1) return;
    let pkg = packages[pkgIndex];
    if (typeof pkg === "string") {
      pkg = { source: pkg };
      packages[pkgIndex] = pkg;
    }
    const arrayKey = item.resourceType;
    const current = pkg[arrayKey] ?? [];
    const pattern = this.getPackageResourcePattern(item);
    const disablePattern = `-${pattern}`;
    const enablePattern = `+${pattern}`;
    const updated = current.filter((p) => {
      const stripped = p.startsWith("!") || p.startsWith("+") || p.startsWith("-") ? p.slice(1) : p;
      return stripped !== pattern;
    });
    if (enabled) {
      updated.push(enablePattern);
    } else {
      updated.push(disablePattern);
    }
    pkg[arrayKey] = updated.length > 0 ? updated : void 0;
    const hasFilters = ["extensions", "skills", "prompts", "themes"].some(
      (k) => pkg[k] !== void 0
    );
    if (!hasFilters) {
      packages[pkgIndex] = pkg.source;
    }
    if (scope === "project") {
      this.settingsManager.setProjectPackages(packages);
    } else {
      this.settingsManager.setPackages(packages);
    }
  }
  getTopLevelBaseDir(scope) {
    return scope === "project" ? join(this.cwd, CONFIG_DIR_NAME) : this.agentDir;
  }
  getResourcePattern(item) {
    const scope = item.metadata.scope;
    const baseDir = this.getTopLevelBaseDir(scope);
    return relative(baseDir, item.path);
  }
  getPackageResourcePattern(item) {
    const baseDir = item.metadata.baseDir ?? dirname(item.path);
    return relative(baseDir, item.path);
  }
}
class ConfigSelectorComponent extends Container {
  constructor(resolvedPaths, settingsManager, cwd, agentDir, onClose, onExit, requestRender) {
    super();
    this._focused = false;
    const groups = buildGroups(resolvedPaths);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(new ConfigSelectorHeader());
    this.addChild(new Spacer(1));
    this.resourceList = new ResourceList(groups, settingsManager, cwd, agentDir);
    this.resourceList.onCancel = onClose;
    this.resourceList.onExit = onExit;
    this.resourceList.onToggle = () => requestRender();
    this.addChild(this.resourceList);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
  }
  get focused() {
    return this._focused;
  }
  set focused(value) {
    this._focused = value;
    this.resourceList.focused = value;
  }
  getResourceList() {
    return this.resourceList;
  }
}
export {
  ConfigSelectorComponent
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL2NvbmZpZy1zZWxlY3Rvci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBUVUkgY29tcG9uZW50IGZvciBtYW5hZ2luZyBwYWNrYWdlIHJlc291cmNlcyAoZW5hYmxlL2Rpc2FibGUpXG4gKi9cblxuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4sIHJlbGF0aXZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHtcblx0dHlwZSBDb21wb25lbnQsXG5cdENvbnRhaW5lcixcblx0dHlwZSBGb2N1c2FibGUsXG5cdGdldEVkaXRvcktleWJpbmRpbmdzLFxuXHRJbnB1dCxcblx0bWF0Y2hlc0tleSxcblx0U3BhY2VyLFxuXHR0cnVuY2F0ZVRvV2lkdGgsXG5cdHZpc2libGVXaWR0aCxcbn0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5pbXBvcnQgeyBDT05GSUdfRElSX05BTUUgfSBmcm9tIFwiLi4vLi4vLi4vY29uZmlnLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFBhdGhNZXRhZGF0YSwgUmVzb2x2ZWRQYXRocywgUmVzb2x2ZWRSZXNvdXJjZSB9IGZyb20gXCIuLi8uLi8uLi9jb3JlL3BhY2thZ2UtbWFuYWdlci5qc1wiO1xuaW1wb3J0IHR5cGUgeyBQYWNrYWdlU291cmNlLCBTZXR0aW5nc01hbmFnZXIgfSBmcm9tIFwiLi4vLi4vLi4vY29yZS9zZXR0aW5ncy1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQgeyB0aGVtZSB9IGZyb20gXCIuLi90aGVtZS90aGVtZS5qc1wiO1xuaW1wb3J0IHsgRHluYW1pY0JvcmRlciB9IGZyb20gXCIuL2R5bmFtaWMtYm9yZGVyLmpzXCI7XG5pbXBvcnQgeyByYXdLZXlIaW50IH0gZnJvbSBcIi4va2V5YmluZGluZy1oaW50cy5qc1wiO1xuXG50eXBlIFJlc291cmNlVHlwZSA9IFwiZXh0ZW5zaW9uc1wiIHwgXCJza2lsbHNcIiB8IFwicHJvbXB0c1wiIHwgXCJ0aGVtZXNcIjtcblxuY29uc3QgUkVTT1VSQ0VfVFlQRV9MQUJFTFM6IFJlY29yZDxSZXNvdXJjZVR5cGUsIHN0cmluZz4gPSB7XG5cdGV4dGVuc2lvbnM6IFwiRXh0ZW5zaW9uc1wiLFxuXHRza2lsbHM6IFwiU2tpbGxzXCIsXG5cdHByb21wdHM6IFwiUHJvbXB0c1wiLFxuXHR0aGVtZXM6IFwiVGhlbWVzXCIsXG59O1xuXG5pbnRlcmZhY2UgUmVzb3VyY2VJdGVtIHtcblx0cGF0aDogc3RyaW5nO1xuXHRlbmFibGVkOiBib29sZWFuO1xuXHRtZXRhZGF0YTogUGF0aE1ldGFkYXRhO1xuXHRyZXNvdXJjZVR5cGU6IFJlc291cmNlVHlwZTtcblx0ZGlzcGxheU5hbWU6IHN0cmluZztcblx0Z3JvdXBLZXk6IHN0cmluZztcblx0c3ViZ3JvdXBLZXk6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlc291cmNlU3ViZ3JvdXAge1xuXHR0eXBlOiBSZXNvdXJjZVR5cGU7XG5cdGxhYmVsOiBzdHJpbmc7XG5cdGl0ZW1zOiBSZXNvdXJjZUl0ZW1bXTtcbn1cblxuaW50ZXJmYWNlIFJlc291cmNlR3JvdXAge1xuXHRrZXk6IHN0cmluZztcblx0bGFiZWw6IHN0cmluZztcblx0c2NvcGU6IFwidXNlclwiIHwgXCJwcm9qZWN0XCIgfCBcInRlbXBvcmFyeVwiO1xuXHRvcmlnaW46IFwicGFja2FnZVwiIHwgXCJ0b3AtbGV2ZWxcIjtcblx0c291cmNlOiBzdHJpbmc7XG5cdHN1Ymdyb3VwczogUmVzb3VyY2VTdWJncm91cFtdO1xufVxuXG5mdW5jdGlvbiBnZXRHcm91cExhYmVsKG1ldGFkYXRhOiBQYXRoTWV0YWRhdGEpOiBzdHJpbmcge1xuXHRpZiAobWV0YWRhdGEub3JpZ2luID09PSBcInBhY2thZ2VcIikge1xuXHRcdHJldHVybiBgJHttZXRhZGF0YS5zb3VyY2V9ICgke21ldGFkYXRhLnNjb3BlfSlgO1xuXHR9XG5cdC8vIFRvcC1sZXZlbCByZXNvdXJjZXNcblx0aWYgKG1ldGFkYXRhLnNvdXJjZSA9PT0gXCJhdXRvXCIpIHtcblx0XHRyZXR1cm4gbWV0YWRhdGEuc2NvcGUgPT09IFwidXNlclwiID8gXCJVc2VyICh+Ly5waS9hZ2VudC8pXCIgOiBcIlByb2plY3QgKC5waS8pXCI7XG5cdH1cblx0cmV0dXJuIG1ldGFkYXRhLnNjb3BlID09PSBcInVzZXJcIiA/IFwiVXNlciBzZXR0aW5nc1wiIDogXCJQcm9qZWN0IHNldHRpbmdzXCI7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkR3JvdXBzKHJlc29sdmVkOiBSZXNvbHZlZFBhdGhzKTogUmVzb3VyY2VHcm91cFtdIHtcblx0Y29uc3QgZ3JvdXBNYXAgPSBuZXcgTWFwPHN0cmluZywgUmVzb3VyY2VHcm91cD4oKTtcblxuXHRjb25zdCBhZGRUb0dyb3VwID0gKHJlc291cmNlczogUmVzb2x2ZWRSZXNvdXJjZVtdLCByZXNvdXJjZVR5cGU6IFJlc291cmNlVHlwZSkgPT4ge1xuXHRcdGZvciAoY29uc3QgcmVzIG9mIHJlc291cmNlcykge1xuXHRcdFx0Y29uc3QgeyBwYXRoLCBlbmFibGVkLCBtZXRhZGF0YSB9ID0gcmVzO1xuXHRcdFx0Y29uc3QgZ3JvdXBLZXkgPSBgJHttZXRhZGF0YS5vcmlnaW59OiR7bWV0YWRhdGEuc2NvcGV9OiR7bWV0YWRhdGEuc291cmNlfWA7XG5cblx0XHRcdGlmICghZ3JvdXBNYXAuaGFzKGdyb3VwS2V5KSkge1xuXHRcdFx0XHRncm91cE1hcC5zZXQoZ3JvdXBLZXksIHtcblx0XHRcdFx0XHRrZXk6IGdyb3VwS2V5LFxuXHRcdFx0XHRcdGxhYmVsOiBnZXRHcm91cExhYmVsKG1ldGFkYXRhKSxcblx0XHRcdFx0XHRzY29wZTogbWV0YWRhdGEuc2NvcGUsXG5cdFx0XHRcdFx0b3JpZ2luOiBtZXRhZGF0YS5vcmlnaW4sXG5cdFx0XHRcdFx0c291cmNlOiBtZXRhZGF0YS5zb3VyY2UsXG5cdFx0XHRcdFx0c3ViZ3JvdXBzOiBbXSxcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGdyb3VwID0gZ3JvdXBNYXAuZ2V0KGdyb3VwS2V5KSE7XG5cdFx0XHRjb25zdCBzdWJncm91cEtleSA9IGAke2dyb3VwS2V5fToke3Jlc291cmNlVHlwZX1gO1xuXG5cdFx0XHRsZXQgc3ViZ3JvdXAgPSBncm91cC5zdWJncm91cHMuZmluZCgoc2cpID0+IHNnLnR5cGUgPT09IHJlc291cmNlVHlwZSk7XG5cdFx0XHRpZiAoIXN1Ymdyb3VwKSB7XG5cdFx0XHRcdHN1Ymdyb3VwID0ge1xuXHRcdFx0XHRcdHR5cGU6IHJlc291cmNlVHlwZSxcblx0XHRcdFx0XHRsYWJlbDogUkVTT1VSQ0VfVFlQRV9MQUJFTFNbcmVzb3VyY2VUeXBlXSxcblx0XHRcdFx0XHRpdGVtczogW10sXG5cdFx0XHRcdH07XG5cdFx0XHRcdGdyb3VwLnN1Ymdyb3Vwcy5wdXNoKHN1Ymdyb3VwKTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgZmlsZU5hbWUgPSBiYXNlbmFtZShwYXRoKTtcblx0XHRcdGNvbnN0IHBhcmVudEZvbGRlciA9IGJhc2VuYW1lKGRpcm5hbWUocGF0aCkpO1xuXHRcdFx0bGV0IGRpc3BsYXlOYW1lOiBzdHJpbmc7XG5cdFx0XHRpZiAocmVzb3VyY2VUeXBlID09PSBcImV4dGVuc2lvbnNcIiAmJiBwYXJlbnRGb2xkZXIgIT09IFwiZXh0ZW5zaW9uc1wiKSB7XG5cdFx0XHRcdGRpc3BsYXlOYW1lID0gYCR7cGFyZW50Rm9sZGVyfS8ke2ZpbGVOYW1lfWA7XG5cdFx0XHR9IGVsc2UgaWYgKHJlc291cmNlVHlwZSA9PT0gXCJza2lsbHNcIiAmJiBmaWxlTmFtZSA9PT0gXCJTS0lMTC5tZFwiKSB7XG5cdFx0XHRcdGRpc3BsYXlOYW1lID0gcGFyZW50Rm9sZGVyO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0ZGlzcGxheU5hbWUgPSBmaWxlTmFtZTtcblx0XHRcdH1cblx0XHRcdHN1Ymdyb3VwLml0ZW1zLnB1c2goe1xuXHRcdFx0XHRwYXRoLFxuXHRcdFx0XHRlbmFibGVkLFxuXHRcdFx0XHRtZXRhZGF0YSxcblx0XHRcdFx0cmVzb3VyY2VUeXBlLFxuXHRcdFx0XHRkaXNwbGF5TmFtZSxcblx0XHRcdFx0Z3JvdXBLZXksXG5cdFx0XHRcdHN1Ymdyb3VwS2V5LFxuXHRcdFx0fSk7XG5cdFx0fVxuXHR9O1xuXG5cdGFkZFRvR3JvdXAocmVzb2x2ZWQuZXh0ZW5zaW9ucywgXCJleHRlbnNpb25zXCIpO1xuXHRhZGRUb0dyb3VwKHJlc29sdmVkLnNraWxscywgXCJza2lsbHNcIik7XG5cdGFkZFRvR3JvdXAocmVzb2x2ZWQucHJvbXB0cywgXCJwcm9tcHRzXCIpO1xuXHRhZGRUb0dyb3VwKHJlc29sdmVkLnRoZW1lcywgXCJ0aGVtZXNcIik7XG5cblx0Ly8gU29ydCBncm91cHM6IHBhY2thZ2VzIGZpcnN0LCB0aGVuIHRvcC1sZXZlbDsgdXNlciBiZWZvcmUgcHJvamVjdFxuXHRjb25zdCBncm91cHMgPSBBcnJheS5mcm9tKGdyb3VwTWFwLnZhbHVlcygpKTtcblx0Z3JvdXBzLnNvcnQoKGEsIGIpID0+IHtcblx0XHRpZiAoYS5vcmlnaW4gIT09IGIub3JpZ2luKSB7XG5cdFx0XHRyZXR1cm4gYS5vcmlnaW4gPT09IFwicGFja2FnZVwiID8gLTEgOiAxO1xuXHRcdH1cblx0XHRpZiAoYS5zY29wZSAhPT0gYi5zY29wZSkge1xuXHRcdFx0cmV0dXJuIGEuc2NvcGUgPT09IFwidXNlclwiID8gLTEgOiAxO1xuXHRcdH1cblx0XHRyZXR1cm4gYS5zb3VyY2UubG9jYWxlQ29tcGFyZShiLnNvdXJjZSk7XG5cdH0pO1xuXG5cdC8vIFNvcnQgc3ViZ3JvdXBzIHdpdGhpbiBlYWNoIGdyb3VwIGJ5IHR5cGUgb3JkZXIsIGFuZCBpdGVtcyBieSBuYW1lXG5cdGNvbnN0IHR5cGVPcmRlcjogUmVjb3JkPFJlc291cmNlVHlwZSwgbnVtYmVyPiA9IHsgZXh0ZW5zaW9uczogMCwgc2tpbGxzOiAxLCBwcm9tcHRzOiAyLCB0aGVtZXM6IDMgfTtcblx0Zm9yIChjb25zdCBncm91cCBvZiBncm91cHMpIHtcblx0XHRncm91cC5zdWJncm91cHMuc29ydCgoYSwgYikgPT4gdHlwZU9yZGVyW2EudHlwZV0gLSB0eXBlT3JkZXJbYi50eXBlXSk7XG5cdFx0Zm9yIChjb25zdCBzdWJncm91cCBvZiBncm91cC5zdWJncm91cHMpIHtcblx0XHRcdHN1Ymdyb3VwLml0ZW1zLnNvcnQoKGEsIGIpID0+IGEuZGlzcGxheU5hbWUubG9jYWxlQ29tcGFyZShiLmRpc3BsYXlOYW1lKSk7XG5cdFx0fVxuXHR9XG5cblx0cmV0dXJuIGdyb3Vwcztcbn1cblxudHlwZSBGbGF0RW50cnkgPVxuXHR8IHsgdHlwZTogXCJncm91cFwiOyBncm91cDogUmVzb3VyY2VHcm91cCB9XG5cdHwgeyB0eXBlOiBcInN1Ymdyb3VwXCI7IHN1Ymdyb3VwOiBSZXNvdXJjZVN1Ymdyb3VwOyBncm91cDogUmVzb3VyY2VHcm91cCB9XG5cdHwgeyB0eXBlOiBcIml0ZW1cIjsgaXRlbTogUmVzb3VyY2VJdGVtIH07XG5cbmNsYXNzIENvbmZpZ1NlbGVjdG9ySGVhZGVyIGltcGxlbWVudHMgQ29tcG9uZW50IHtcblx0aW52YWxpZGF0ZSgpOiB2b2lkIHt9XG5cblx0cmVuZGVyKHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG5cdFx0Y29uc3QgdGl0bGUgPSB0aGVtZS5ib2xkKFwiUmVzb3VyY2UgQ29uZmlndXJhdGlvblwiKTtcblx0XHRjb25zdCBzZXAgPSB0aGVtZS5mZyhcIm11dGVkXCIsIFwiIFx1MDBCNyBcIik7XG5cdFx0Y29uc3QgaGludCA9IHJhd0tleUhpbnQoXCJzcGFjZVwiLCBcInRvZ2dsZVwiKSArIHNlcCArIHJhd0tleUhpbnQoXCJlc2NcIiwgXCJjbG9zZVwiKTtcblx0XHRjb25zdCBoaW50V2lkdGggPSB2aXNpYmxlV2lkdGgoaGludCk7XG5cdFx0Y29uc3QgdGl0bGVXaWR0aCA9IHZpc2libGVXaWR0aCh0aXRsZSk7XG5cdFx0Y29uc3Qgc3BhY2luZyA9IE1hdGgubWF4KDEsIHdpZHRoIC0gdGl0bGVXaWR0aCAtIGhpbnRXaWR0aCk7XG5cblx0XHRyZXR1cm4gW1xuXHRcdFx0dHJ1bmNhdGVUb1dpZHRoKGAke3RpdGxlfSR7XCIgXCIucmVwZWF0KHNwYWNpbmcpfSR7aGludH1gLCB3aWR0aCwgXCJcIiksXG5cdFx0XHR0aGVtZS5mZyhcIm11dGVkXCIsIFwiVHlwZSB0byBmaWx0ZXIgcmVzb3VyY2VzXCIpLFxuXHRcdF07XG5cdH1cbn1cblxuY2xhc3MgUmVzb3VyY2VMaXN0IGltcGxlbWVudHMgQ29tcG9uZW50LCBGb2N1c2FibGUge1xuXHRwcml2YXRlIGdyb3VwczogUmVzb3VyY2VHcm91cFtdO1xuXHRwcml2YXRlIGZsYXRJdGVtczogRmxhdEVudHJ5W10gPSBbXTtcblx0cHJpdmF0ZSBmaWx0ZXJlZEl0ZW1zOiBGbGF0RW50cnlbXSA9IFtdO1xuXHRwcml2YXRlIHNlbGVjdGVkSW5kZXggPSAwO1xuXHRwcml2YXRlIHNlYXJjaElucHV0OiBJbnB1dDtcblx0cHJpdmF0ZSBtYXhWaXNpYmxlID0gMTU7XG5cdHByaXZhdGUgc2V0dGluZ3NNYW5hZ2VyOiBTZXR0aW5nc01hbmFnZXI7XG5cdHByaXZhdGUgY3dkOiBzdHJpbmc7XG5cdHByaXZhdGUgYWdlbnREaXI6IHN0cmluZztcblxuXHRwdWJsaWMgb25DYW5jZWw/OiAoKSA9PiB2b2lkO1xuXHRwdWJsaWMgb25FeGl0PzogKCkgPT4gdm9pZDtcblx0cHVibGljIG9uVG9nZ2xlPzogKGl0ZW06IFJlc291cmNlSXRlbSwgbmV3RW5hYmxlZDogYm9vbGVhbikgPT4gdm9pZDtcblxuXHRwcml2YXRlIF9mb2N1c2VkID0gZmFsc2U7XG5cdGdldCBmb2N1c2VkKCk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLl9mb2N1c2VkO1xuXHR9XG5cdHNldCBmb2N1c2VkKHZhbHVlOiBib29sZWFuKSB7XG5cdFx0dGhpcy5fZm9jdXNlZCA9IHZhbHVlO1xuXHRcdHRoaXMuc2VhcmNoSW5wdXQuZm9jdXNlZCA9IHZhbHVlO1xuXHR9XG5cblx0Y29uc3RydWN0b3IoZ3JvdXBzOiBSZXNvdXJjZUdyb3VwW10sIHNldHRpbmdzTWFuYWdlcjogU2V0dGluZ3NNYW5hZ2VyLCBjd2Q6IHN0cmluZywgYWdlbnREaXI6IHN0cmluZykge1xuXHRcdHRoaXMuZ3JvdXBzID0gZ3JvdXBzO1xuXHRcdHRoaXMuc2V0dGluZ3NNYW5hZ2VyID0gc2V0dGluZ3NNYW5hZ2VyO1xuXHRcdHRoaXMuY3dkID0gY3dkO1xuXHRcdHRoaXMuYWdlbnREaXIgPSBhZ2VudERpcjtcblx0XHR0aGlzLnNlYXJjaElucHV0ID0gbmV3IElucHV0KCk7XG5cdFx0dGhpcy5idWlsZEZsYXRMaXN0KCk7XG5cdFx0dGhpcy5maWx0ZXJlZEl0ZW1zID0gWy4uLnRoaXMuZmxhdEl0ZW1zXTtcblx0fVxuXG5cdHByaXZhdGUgYnVpbGRGbGF0TGlzdCgpOiB2b2lkIHtcblx0XHR0aGlzLmZsYXRJdGVtcyA9IFtdO1xuXHRcdGZvciAoY29uc3QgZ3JvdXAgb2YgdGhpcy5ncm91cHMpIHtcblx0XHRcdHRoaXMuZmxhdEl0ZW1zLnB1c2goeyB0eXBlOiBcImdyb3VwXCIsIGdyb3VwIH0pO1xuXHRcdFx0Zm9yIChjb25zdCBzdWJncm91cCBvZiBncm91cC5zdWJncm91cHMpIHtcblx0XHRcdFx0dGhpcy5mbGF0SXRlbXMucHVzaCh7IHR5cGU6IFwic3ViZ3JvdXBcIiwgc3ViZ3JvdXAsIGdyb3VwIH0pO1xuXHRcdFx0XHRmb3IgKGNvbnN0IGl0ZW0gb2Ygc3ViZ3JvdXAuaXRlbXMpIHtcblx0XHRcdFx0XHR0aGlzLmZsYXRJdGVtcy5wdXNoKHsgdHlwZTogXCJpdGVtXCIsIGl0ZW0gfSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cdFx0Ly8gU3RhcnQgc2VsZWN0aW9uIG9uIGZpcnN0IGl0ZW0gKG5vdCBoZWFkZXIpXG5cdFx0dGhpcy5zZWxlY3RlZEluZGV4ID0gdGhpcy5mbGF0SXRlbXMuZmluZEluZGV4KChlKSA9PiBlLnR5cGUgPT09IFwiaXRlbVwiKTtcblx0XHRpZiAodGhpcy5zZWxlY3RlZEluZGV4IDwgMCkgdGhpcy5zZWxlY3RlZEluZGV4ID0gMDtcblx0fVxuXG5cdHByaXZhdGUgZmluZE5leHRJdGVtKGZyb21JbmRleDogbnVtYmVyLCBkaXJlY3Rpb246IDEgfCAtMSk6IG51bWJlciB7XG5cdFx0bGV0IGlkeCA9IGZyb21JbmRleCArIGRpcmVjdGlvbjtcblx0XHR3aGlsZSAoaWR4ID49IDAgJiYgaWR4IDwgdGhpcy5maWx0ZXJlZEl0ZW1zLmxlbmd0aCkge1xuXHRcdFx0aWYgKHRoaXMuZmlsdGVyZWRJdGVtc1tpZHhdLnR5cGUgPT09IFwiaXRlbVwiKSB7XG5cdFx0XHRcdHJldHVybiBpZHg7XG5cdFx0XHR9XG5cdFx0XHRpZHggKz0gZGlyZWN0aW9uO1xuXHRcdH1cblx0XHRyZXR1cm4gZnJvbUluZGV4OyAvLyBTdGF5IGF0IGN1cnJlbnQgaWYgbm8gaXRlbSBmb3VuZFxuXHR9XG5cblx0cHJpdmF0ZSBmaWx0ZXJJdGVtcyhxdWVyeTogc3RyaW5nKTogdm9pZCB7XG5cdFx0aWYgKCFxdWVyeS50cmltKCkpIHtcblx0XHRcdHRoaXMuZmlsdGVyZWRJdGVtcyA9IFsuLi50aGlzLmZsYXRJdGVtc107XG5cdFx0XHR0aGlzLnNlbGVjdEZpcnN0SXRlbSgpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IGxvd2VyUXVlcnkgPSBxdWVyeS50b0xvd2VyQ2FzZSgpO1xuXHRcdGNvbnN0IG1hdGNoaW5nSXRlbXMgPSBuZXcgU2V0PFJlc291cmNlSXRlbT4oKTtcblx0XHRjb25zdCBtYXRjaGluZ1N1Ymdyb3VwcyA9IG5ldyBTZXQ8UmVzb3VyY2VTdWJncm91cD4oKTtcblx0XHRjb25zdCBtYXRjaGluZ0dyb3VwcyA9IG5ldyBTZXQ8UmVzb3VyY2VHcm91cD4oKTtcblxuXHRcdGZvciAoY29uc3QgZW50cnkgb2YgdGhpcy5mbGF0SXRlbXMpIHtcblx0XHRcdGlmIChlbnRyeS50eXBlID09PSBcIml0ZW1cIikge1xuXHRcdFx0XHRjb25zdCBpdGVtID0gZW50cnkuaXRlbTtcblx0XHRcdFx0aWYgKFxuXHRcdFx0XHRcdGl0ZW0uZGlzcGxheU5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhsb3dlclF1ZXJ5KSB8fFxuXHRcdFx0XHRcdGl0ZW0ucmVzb3VyY2VUeXBlLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMobG93ZXJRdWVyeSkgfHxcblx0XHRcdFx0XHRpdGVtLnBhdGgudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhsb3dlclF1ZXJ5KVxuXHRcdFx0XHQpIHtcblx0XHRcdFx0XHRtYXRjaGluZ0l0ZW1zLmFkZChpdGVtKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIEZpbmQgd2hpY2ggc3ViZ3JvdXBzIGFuZCBncm91cHMgY29udGFpbiBtYXRjaGluZyBpdGVtc1xuXHRcdGZvciAoY29uc3QgZ3JvdXAgb2YgdGhpcy5ncm91cHMpIHtcblx0XHRcdGZvciAoY29uc3Qgc3ViZ3JvdXAgb2YgZ3JvdXAuc3ViZ3JvdXBzKSB7XG5cdFx0XHRcdGZvciAoY29uc3QgaXRlbSBvZiBzdWJncm91cC5pdGVtcykge1xuXHRcdFx0XHRcdGlmIChtYXRjaGluZ0l0ZW1zLmhhcyhpdGVtKSkge1xuXHRcdFx0XHRcdFx0bWF0Y2hpbmdTdWJncm91cHMuYWRkKHN1Ymdyb3VwKTtcblx0XHRcdFx0XHRcdG1hdGNoaW5nR3JvdXBzLmFkZChncm91cCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0dGhpcy5maWx0ZXJlZEl0ZW1zID0gW107XG5cdFx0Zm9yIChjb25zdCBlbnRyeSBvZiB0aGlzLmZsYXRJdGVtcykge1xuXHRcdFx0aWYgKGVudHJ5LnR5cGUgPT09IFwiZ3JvdXBcIiAmJiBtYXRjaGluZ0dyb3Vwcy5oYXMoZW50cnkuZ3JvdXApKSB7XG5cdFx0XHRcdHRoaXMuZmlsdGVyZWRJdGVtcy5wdXNoKGVudHJ5KTtcblx0XHRcdH0gZWxzZSBpZiAoZW50cnkudHlwZSA9PT0gXCJzdWJncm91cFwiICYmIG1hdGNoaW5nU3ViZ3JvdXBzLmhhcyhlbnRyeS5zdWJncm91cCkpIHtcblx0XHRcdFx0dGhpcy5maWx0ZXJlZEl0ZW1zLnB1c2goZW50cnkpO1xuXHRcdFx0fSBlbHNlIGlmIChlbnRyeS50eXBlID09PSBcIml0ZW1cIiAmJiBtYXRjaGluZ0l0ZW1zLmhhcyhlbnRyeS5pdGVtKSkge1xuXHRcdFx0XHR0aGlzLmZpbHRlcmVkSXRlbXMucHVzaChlbnRyeSk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0dGhpcy5zZWxlY3RGaXJzdEl0ZW0oKTtcblx0fVxuXG5cdHByaXZhdGUgc2VsZWN0Rmlyc3RJdGVtKCk6IHZvaWQge1xuXHRcdGNvbnN0IGZpcnN0SXRlbUluZGV4ID0gdGhpcy5maWx0ZXJlZEl0ZW1zLmZpbmRJbmRleCgoZSkgPT4gZS50eXBlID09PSBcIml0ZW1cIik7XG5cdFx0dGhpcy5zZWxlY3RlZEluZGV4ID0gZmlyc3RJdGVtSW5kZXggPj0gMCA/IGZpcnN0SXRlbUluZGV4IDogMDtcblx0fVxuXG5cdHVwZGF0ZUl0ZW0oaXRlbTogUmVzb3VyY2VJdGVtLCBlbmFibGVkOiBib29sZWFuKTogdm9pZCB7XG5cdFx0aXRlbS5lbmFibGVkID0gZW5hYmxlZDtcblx0XHQvLyBVcGRhdGUgaW4gZ3JvdXBzIHRvb1xuXHRcdGZvciAoY29uc3QgZ3JvdXAgb2YgdGhpcy5ncm91cHMpIHtcblx0XHRcdGZvciAoY29uc3Qgc3ViZ3JvdXAgb2YgZ3JvdXAuc3ViZ3JvdXBzKSB7XG5cdFx0XHRcdGNvbnN0IGZvdW5kID0gc3ViZ3JvdXAuaXRlbXMuZmluZCgoaSkgPT4gaS5wYXRoID09PSBpdGVtLnBhdGggJiYgaS5yZXNvdXJjZVR5cGUgPT09IGl0ZW0ucmVzb3VyY2VUeXBlKTtcblx0XHRcdFx0aWYgKGZvdW5kKSB7XG5cdFx0XHRcdFx0Zm91bmQuZW5hYmxlZCA9IGVuYWJsZWQ7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0aW52YWxpZGF0ZSgpOiB2b2lkIHt9XG5cblx0cmVuZGVyKHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG5cdFx0Y29uc3QgbGluZXM6IHN0cmluZ1tdID0gW107XG5cblx0XHQvLyBTZWFyY2ggaW5wdXRcblx0XHRsaW5lcy5wdXNoKC4uLnRoaXMuc2VhcmNoSW5wdXQucmVuZGVyKHdpZHRoKSk7XG5cdFx0bGluZXMucHVzaChcIlwiKTtcblxuXHRcdGlmICh0aGlzLmZpbHRlcmVkSXRlbXMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRsaW5lcy5wdXNoKHRoZW1lLmZnKFwibXV0ZWRcIiwgXCIgIE5vIHJlc291cmNlcyBmb3VuZFwiKSk7XG5cdFx0XHRyZXR1cm4gbGluZXM7XG5cdFx0fVxuXG5cdFx0Ly8gQ2FsY3VsYXRlIHZpc2libGUgcmFuZ2Vcblx0XHRjb25zdCBzdGFydEluZGV4ID0gTWF0aC5tYXgoXG5cdFx0XHQwLFxuXHRcdFx0TWF0aC5taW4odGhpcy5zZWxlY3RlZEluZGV4IC0gTWF0aC5mbG9vcih0aGlzLm1heFZpc2libGUgLyAyKSwgdGhpcy5maWx0ZXJlZEl0ZW1zLmxlbmd0aCAtIHRoaXMubWF4VmlzaWJsZSksXG5cdFx0KTtcblx0XHRjb25zdCBlbmRJbmRleCA9IE1hdGgubWluKHN0YXJ0SW5kZXggKyB0aGlzLm1heFZpc2libGUsIHRoaXMuZmlsdGVyZWRJdGVtcy5sZW5ndGgpO1xuXG5cdFx0Zm9yIChsZXQgaSA9IHN0YXJ0SW5kZXg7IGkgPCBlbmRJbmRleDsgaSsrKSB7XG5cdFx0XHRjb25zdCBlbnRyeSA9IHRoaXMuZmlsdGVyZWRJdGVtc1tpXTtcblx0XHRcdGNvbnN0IGlzU2VsZWN0ZWQgPSBpID09PSB0aGlzLnNlbGVjdGVkSW5kZXg7XG5cblx0XHRcdGlmIChlbnRyeS50eXBlID09PSBcImdyb3VwXCIpIHtcblx0XHRcdFx0Ly8gTWFpbiBncm91cCBoZWFkZXIgKG5vIGN1cnNvcilcblx0XHRcdFx0Y29uc3QgZ3JvdXBMaW5lID0gdGhlbWUuZmcoXCJhY2NlbnRcIiwgdGhlbWUuYm9sZChlbnRyeS5ncm91cC5sYWJlbCkpO1xuXHRcdFx0XHRsaW5lcy5wdXNoKHRydW5jYXRlVG9XaWR0aChgICAke2dyb3VwTGluZX1gLCB3aWR0aCwgXCJcIikpO1xuXHRcdFx0fSBlbHNlIGlmIChlbnRyeS50eXBlID09PSBcInN1Ymdyb3VwXCIpIHtcblx0XHRcdFx0Ly8gU3ViZ3JvdXAgaGVhZGVyIChpbmRlbnRlZCwgbm8gY3Vyc29yKVxuXHRcdFx0XHRjb25zdCBzdWJncm91cExpbmUgPSB0aGVtZS5mZyhcIm11dGVkXCIsIGVudHJ5LnN1Ymdyb3VwLmxhYmVsKTtcblx0XHRcdFx0bGluZXMucHVzaCh0cnVuY2F0ZVRvV2lkdGgoYCAgICAke3N1Ymdyb3VwTGluZX1gLCB3aWR0aCwgXCJcIikpO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Ly8gUmVzb3VyY2UgaXRlbSAoY3Vyc29yIG9ubHkgb24gaXRlbXMpXG5cdFx0XHRcdGNvbnN0IGl0ZW0gPSBlbnRyeS5pdGVtO1xuXHRcdFx0XHRjb25zdCBjdXJzb3IgPSBpc1NlbGVjdGVkID8gXCI+IFwiIDogXCIgIFwiO1xuXHRcdFx0XHRjb25zdCBjaGVja2JveCA9IGl0ZW0uZW5hYmxlZCA/IHRoZW1lLmZnKFwic3VjY2Vzc1wiLCBcIlt4XVwiKSA6IHRoZW1lLmZnKFwiZGltXCIsIFwiWyBdXCIpO1xuXHRcdFx0XHRjb25zdCBuYW1lID0gaXNTZWxlY3RlZCA/IHRoZW1lLmJvbGQoaXRlbS5kaXNwbGF5TmFtZSkgOiBpdGVtLmRpc3BsYXlOYW1lO1xuXHRcdFx0XHRsaW5lcy5wdXNoKHRydW5jYXRlVG9XaWR0aChgJHtjdXJzb3J9ICAgICR7Y2hlY2tib3h9ICR7bmFtZX1gLCB3aWR0aCwgXCIuLi5cIikpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIFNjcm9sbCBpbmRpY2F0b3IgXHUyMDE0IGNvdW50IG9ubHkgc2VsZWN0YWJsZSBpdGVtcyAoZXhjbHVkZSBncm91cC9zdWJncm91cCBoZWFkZXJzKVxuXHRcdGlmIChzdGFydEluZGV4ID4gMCB8fCBlbmRJbmRleCA8IHRoaXMuZmlsdGVyZWRJdGVtcy5sZW5ndGgpIHtcblx0XHRcdGNvbnN0IHNlbGVjdGFibGVJdGVtcyA9IHRoaXMuZmlsdGVyZWRJdGVtcy5maWx0ZXIoKGUpID0+IGUudHlwZSA9PT0gXCJpdGVtXCIpO1xuXHRcdFx0Y29uc3Qgc2VsZWN0YWJsZVRvdGFsID0gc2VsZWN0YWJsZUl0ZW1zLmxlbmd0aDtcblx0XHRcdGNvbnN0IHNlbGVjdGFibGVQb3NpdGlvbiA9IHNlbGVjdGFibGVJdGVtcy5maW5kSW5kZXgoXG5cdFx0XHRcdChlKSA9PiB0aGlzLmZpbHRlcmVkSXRlbXMuaW5kZXhPZihlKSA9PT0gdGhpcy5zZWxlY3RlZEluZGV4LFxuXHRcdFx0KTtcblx0XHRcdGxpbmVzLnB1c2godGhlbWUuZmcoXCJkaW1cIiwgYCAgKCR7c2VsZWN0YWJsZVBvc2l0aW9uICsgMX0vJHtzZWxlY3RhYmxlVG90YWx9KWApKTtcblx0XHR9XG5cblx0XHRyZXR1cm4gbGluZXM7XG5cdH1cblxuXHRoYW5kbGVJbnB1dChkYXRhOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRjb25zdCBrYiA9IGdldEVkaXRvcktleWJpbmRpbmdzKCk7XG5cblx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcInNlbGVjdFVwXCIpKSB7XG5cdFx0XHR0aGlzLnNlbGVjdGVkSW5kZXggPSB0aGlzLmZpbmROZXh0SXRlbSh0aGlzLnNlbGVjdGVkSW5kZXgsIC0xKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJzZWxlY3REb3duXCIpKSB7XG5cdFx0XHR0aGlzLnNlbGVjdGVkSW5kZXggPSB0aGlzLmZpbmROZXh0SXRlbSh0aGlzLnNlbGVjdGVkSW5kZXgsIDEpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcInNlbGVjdFBhZ2VVcFwiKSkge1xuXHRcdFx0Ly8gSnVtcCB1cCBieSBtYXhWaXNpYmxlLCB0aGVuIGZpbmQgbmVhcmVzdCBpdGVtXG5cdFx0XHRsZXQgdGFyZ2V0ID0gTWF0aC5tYXgoMCwgdGhpcy5zZWxlY3RlZEluZGV4IC0gdGhpcy5tYXhWaXNpYmxlKTtcblx0XHRcdHdoaWxlICh0YXJnZXQgPCB0aGlzLmZpbHRlcmVkSXRlbXMubGVuZ3RoICYmIHRoaXMuZmlsdGVyZWRJdGVtc1t0YXJnZXRdLnR5cGUgIT09IFwiaXRlbVwiKSB7XG5cdFx0XHRcdHRhcmdldCsrO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHRhcmdldCA8IHRoaXMuZmlsdGVyZWRJdGVtcy5sZW5ndGgpIHtcblx0XHRcdFx0dGhpcy5zZWxlY3RlZEluZGV4ID0gdGFyZ2V0O1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAoa2IubWF0Y2hlcyhkYXRhLCBcInNlbGVjdFBhZ2VEb3duXCIpKSB7XG5cdFx0XHQvLyBKdW1wIGRvd24gYnkgbWF4VmlzaWJsZSwgdGhlbiBmaW5kIG5lYXJlc3QgaXRlbVxuXHRcdFx0bGV0IHRhcmdldCA9IE1hdGgubWluKHRoaXMuZmlsdGVyZWRJdGVtcy5sZW5ndGggLSAxLCB0aGlzLnNlbGVjdGVkSW5kZXggKyB0aGlzLm1heFZpc2libGUpO1xuXHRcdFx0d2hpbGUgKHRhcmdldCA+PSAwICYmIHRoaXMuZmlsdGVyZWRJdGVtc1t0YXJnZXRdLnR5cGUgIT09IFwiaXRlbVwiKSB7XG5cdFx0XHRcdHRhcmdldC0tO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHRhcmdldCA+PSAwKSB7XG5cdFx0XHRcdHRoaXMuc2VsZWN0ZWRJbmRleCA9IHRhcmdldDtcblx0XHRcdH1cblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0aWYgKGtiLm1hdGNoZXMoZGF0YSwgXCJzZWxlY3RDYW5jZWxcIikpIHtcblx0XHRcdHRoaXMub25DYW5jZWw/LigpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAobWF0Y2hlc0tleShkYXRhLCBcImN0cmwrY1wiKSkge1xuXHRcdFx0dGhpcy5vbkV4aXQ/LigpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAoZGF0YSA9PT0gXCIgXCIgfHwga2IubWF0Y2hlcyhkYXRhLCBcInNlbGVjdENvbmZpcm1cIikpIHtcblx0XHRcdGNvbnN0IGVudHJ5ID0gdGhpcy5maWx0ZXJlZEl0ZW1zW3RoaXMuc2VsZWN0ZWRJbmRleF07XG5cdFx0XHRpZiAoZW50cnk/LnR5cGUgPT09IFwiaXRlbVwiKSB7XG5cdFx0XHRcdGNvbnN0IG5ld0VuYWJsZWQgPSAhZW50cnkuaXRlbS5lbmFibGVkO1xuXHRcdFx0XHR0aGlzLnRvZ2dsZVJlc291cmNlKGVudHJ5Lml0ZW0sIG5ld0VuYWJsZWQpO1xuXHRcdFx0XHR0aGlzLnVwZGF0ZUl0ZW0oZW50cnkuaXRlbSwgbmV3RW5hYmxlZCk7XG5cdFx0XHRcdHRoaXMub25Ub2dnbGU/LihlbnRyeS5pdGVtLCBuZXdFbmFibGVkKTtcblx0XHRcdH1cblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBQYXNzIHRvIHNlYXJjaCBpbnB1dFxuXHRcdHRoaXMuc2VhcmNoSW5wdXQuaGFuZGxlSW5wdXQoZGF0YSk7XG5cdFx0dGhpcy5maWx0ZXJJdGVtcyh0aGlzLnNlYXJjaElucHV0LmdldFZhbHVlKCkpO1xuXHR9XG5cblx0cHJpdmF0ZSB0b2dnbGVSZXNvdXJjZShpdGVtOiBSZXNvdXJjZUl0ZW0sIGVuYWJsZWQ6IGJvb2xlYW4pOiB2b2lkIHtcblx0XHRpZiAoaXRlbS5tZXRhZGF0YS5vcmlnaW4gPT09IFwidG9wLWxldmVsXCIpIHtcblx0XHRcdHRoaXMudG9nZ2xlVG9wTGV2ZWxSZXNvdXJjZShpdGVtLCBlbmFibGVkKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy50b2dnbGVQYWNrYWdlUmVzb3VyY2UoaXRlbSwgZW5hYmxlZCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSB0b2dnbGVUb3BMZXZlbFJlc291cmNlKGl0ZW06IFJlc291cmNlSXRlbSwgZW5hYmxlZDogYm9vbGVhbik6IHZvaWQge1xuXHRcdGNvbnN0IHNjb3BlID0gaXRlbS5tZXRhZGF0YS5zY29wZSBhcyBcInVzZXJcIiB8IFwicHJvamVjdFwiO1xuXHRcdGNvbnN0IHNldHRpbmdzID1cblx0XHRcdHNjb3BlID09PSBcInByb2plY3RcIiA/IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldFByb2plY3RTZXR0aW5ncygpIDogdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0R2xvYmFsU2V0dGluZ3MoKTtcblxuXHRcdGNvbnN0IGFycmF5S2V5ID0gaXRlbS5yZXNvdXJjZVR5cGUgYXMgXCJleHRlbnNpb25zXCIgfCBcInNraWxsc1wiIHwgXCJwcm9tcHRzXCIgfCBcInRoZW1lc1wiO1xuXHRcdGNvbnN0IGN1cnJlbnQgPSAoc2V0dGluZ3NbYXJyYXlLZXldID8/IFtdKSBhcyBzdHJpbmdbXTtcblxuXHRcdC8vIEdlbmVyYXRlIHBhdHRlcm4gZm9yIHRoaXMgcmVzb3VyY2Vcblx0XHRjb25zdCBwYXR0ZXJuID0gdGhpcy5nZXRSZXNvdXJjZVBhdHRlcm4oaXRlbSk7XG5cdFx0Y29uc3QgZGlzYWJsZVBhdHRlcm4gPSBgLSR7cGF0dGVybn1gO1xuXHRcdGNvbnN0IGVuYWJsZVBhdHRlcm4gPSBgKyR7cGF0dGVybn1gO1xuXG5cdFx0Ly8gRmlsdGVyIG91dCBleGlzdGluZyBwYXR0ZXJucyBmb3IgdGhpcyByZXNvdXJjZVxuXHRcdGNvbnN0IHVwZGF0ZWQgPSBjdXJyZW50LmZpbHRlcigocCkgPT4ge1xuXHRcdFx0Y29uc3Qgc3RyaXBwZWQgPSBwLnN0YXJ0c1dpdGgoXCIhXCIpIHx8IHAuc3RhcnRzV2l0aChcIitcIikgfHwgcC5zdGFydHNXaXRoKFwiLVwiKSA/IHAuc2xpY2UoMSkgOiBwO1xuXHRcdFx0cmV0dXJuIHN0cmlwcGVkICE9PSBwYXR0ZXJuO1xuXHRcdH0pO1xuXG5cdFx0aWYgKGVuYWJsZWQpIHtcblx0XHRcdHVwZGF0ZWQucHVzaChlbmFibGVQYXR0ZXJuKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dXBkYXRlZC5wdXNoKGRpc2FibGVQYXR0ZXJuKTtcblx0XHR9XG5cblx0XHRpZiAoc2NvcGUgPT09IFwicHJvamVjdFwiKSB7XG5cdFx0XHRpZiAoYXJyYXlLZXkgPT09IFwiZXh0ZW5zaW9uc1wiKSB7XG5cdFx0XHRcdHRoaXMuc2V0dGluZ3NNYW5hZ2VyLnNldFByb2plY3RFeHRlbnNpb25QYXRocyh1cGRhdGVkKTtcblx0XHRcdH0gZWxzZSBpZiAoYXJyYXlLZXkgPT09IFwic2tpbGxzXCIpIHtcblx0XHRcdFx0dGhpcy5zZXR0aW5nc01hbmFnZXIuc2V0UHJvamVjdFNraWxsUGF0aHModXBkYXRlZCk7XG5cdFx0XHR9IGVsc2UgaWYgKGFycmF5S2V5ID09PSBcInByb21wdHNcIikge1xuXHRcdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRQcm9qZWN0UHJvbXB0VGVtcGxhdGVQYXRocyh1cGRhdGVkKTtcblx0XHRcdH0gZWxzZSBpZiAoYXJyYXlLZXkgPT09IFwidGhlbWVzXCIpIHtcblx0XHRcdFx0dGhpcy5zZXR0aW5nc01hbmFnZXIuc2V0UHJvamVjdFRoZW1lUGF0aHModXBkYXRlZCk7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIHtcblx0XHRcdGlmIChhcnJheUtleSA9PT0gXCJleHRlbnNpb25zXCIpIHtcblx0XHRcdFx0dGhpcy5zZXR0aW5nc01hbmFnZXIuc2V0RXh0ZW5zaW9uUGF0aHModXBkYXRlZCk7XG5cdFx0XHR9IGVsc2UgaWYgKGFycmF5S2V5ID09PSBcInNraWxsc1wiKSB7XG5cdFx0XHRcdHRoaXMuc2V0dGluZ3NNYW5hZ2VyLnNldFNraWxsUGF0aHModXBkYXRlZCk7XG5cdFx0XHR9IGVsc2UgaWYgKGFycmF5S2V5ID09PSBcInByb21wdHNcIikge1xuXHRcdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRQcm9tcHRUZW1wbGF0ZVBhdGhzKHVwZGF0ZWQpO1xuXHRcdFx0fSBlbHNlIGlmIChhcnJheUtleSA9PT0gXCJ0aGVtZXNcIikge1xuXHRcdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRUaGVtZVBhdGhzKHVwZGF0ZWQpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgdG9nZ2xlUGFja2FnZVJlc291cmNlKGl0ZW06IFJlc291cmNlSXRlbSwgZW5hYmxlZDogYm9vbGVhbik6IHZvaWQge1xuXHRcdGNvbnN0IHNjb3BlID0gaXRlbS5tZXRhZGF0YS5zY29wZSBhcyBcInVzZXJcIiB8IFwicHJvamVjdFwiO1xuXHRcdGNvbnN0IHNldHRpbmdzID1cblx0XHRcdHNjb3BlID09PSBcInByb2plY3RcIiA/IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldFByb2plY3RTZXR0aW5ncygpIDogdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0R2xvYmFsU2V0dGluZ3MoKTtcblxuXHRcdGNvbnN0IHBhY2thZ2VzID0gWy4uLihzZXR0aW5ncy5wYWNrYWdlcyA/PyBbXSldIGFzIFBhY2thZ2VTb3VyY2VbXTtcblx0XHRjb25zdCBwa2dJbmRleCA9IHBhY2thZ2VzLmZpbmRJbmRleCgocGtnKSA9PiB7XG5cdFx0XHRjb25zdCBzb3VyY2UgPSB0eXBlb2YgcGtnID09PSBcInN0cmluZ1wiID8gcGtnIDogcGtnLnNvdXJjZTtcblx0XHRcdHJldHVybiBzb3VyY2UgPT09IGl0ZW0ubWV0YWRhdGEuc291cmNlO1xuXHRcdH0pO1xuXG5cdFx0aWYgKHBrZ0luZGV4ID09PSAtMSkgcmV0dXJuO1xuXG5cdFx0bGV0IHBrZyA9IHBhY2thZ2VzW3BrZ0luZGV4XTtcblxuXHRcdC8vIENvbnZlcnQgc3RyaW5nIHRvIG9iamVjdCBmb3JtIGlmIG5lZWRlZFxuXHRcdGlmICh0eXBlb2YgcGtnID09PSBcInN0cmluZ1wiKSB7XG5cdFx0XHRwa2cgPSB7IHNvdXJjZTogcGtnIH07XG5cdFx0XHRwYWNrYWdlc1twa2dJbmRleF0gPSBwa2c7XG5cdFx0fVxuXG5cdFx0Ly8gR2V0IHRoZSByZXNvdXJjZSBhcnJheSBmb3IgdGhpcyB0eXBlXG5cdFx0Y29uc3QgYXJyYXlLZXkgPSBpdGVtLnJlc291cmNlVHlwZSBhcyBcImV4dGVuc2lvbnNcIiB8IFwic2tpbGxzXCIgfCBcInByb21wdHNcIiB8IFwidGhlbWVzXCI7XG5cdFx0Y29uc3QgY3VycmVudCA9IChwa2dbYXJyYXlLZXldID8/IFtdKSBhcyBzdHJpbmdbXTtcblxuXHRcdC8vIEdlbmVyYXRlIHBhdHRlcm4gcmVsYXRpdmUgdG8gcGFja2FnZSByb290XG5cdFx0Y29uc3QgcGF0dGVybiA9IHRoaXMuZ2V0UGFja2FnZVJlc291cmNlUGF0dGVybihpdGVtKTtcblx0XHRjb25zdCBkaXNhYmxlUGF0dGVybiA9IGAtJHtwYXR0ZXJufWA7XG5cdFx0Y29uc3QgZW5hYmxlUGF0dGVybiA9IGArJHtwYXR0ZXJufWA7XG5cblx0XHQvLyBGaWx0ZXIgb3V0IGV4aXN0aW5nIHBhdHRlcm5zIGZvciB0aGlzIHJlc291cmNlXG5cdFx0Y29uc3QgdXBkYXRlZCA9IGN1cnJlbnQuZmlsdGVyKChwKSA9PiB7XG5cdFx0XHRjb25zdCBzdHJpcHBlZCA9IHAuc3RhcnRzV2l0aChcIiFcIikgfHwgcC5zdGFydHNXaXRoKFwiK1wiKSB8fCBwLnN0YXJ0c1dpdGgoXCItXCIpID8gcC5zbGljZSgxKSA6IHA7XG5cdFx0XHRyZXR1cm4gc3RyaXBwZWQgIT09IHBhdHRlcm47XG5cdFx0fSk7XG5cblx0XHRpZiAoZW5hYmxlZCkge1xuXHRcdFx0dXBkYXRlZC5wdXNoKGVuYWJsZVBhdHRlcm4pO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR1cGRhdGVkLnB1c2goZGlzYWJsZVBhdHRlcm4pO1xuXHRcdH1cblxuXHRcdChwa2cgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW2FycmF5S2V5XSA9IHVwZGF0ZWQubGVuZ3RoID4gMCA/IHVwZGF0ZWQgOiB1bmRlZmluZWQ7XG5cblx0XHQvLyBDbGVhbiB1cCBlbXB0eSBmaWx0ZXIgb2JqZWN0XG5cdFx0Y29uc3QgaGFzRmlsdGVycyA9IFtcImV4dGVuc2lvbnNcIiwgXCJza2lsbHNcIiwgXCJwcm9tcHRzXCIsIFwidGhlbWVzXCJdLnNvbWUoXG5cdFx0XHQoaykgPT4gKHBrZyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilba10gIT09IHVuZGVmaW5lZCxcblx0XHQpO1xuXHRcdGlmICghaGFzRmlsdGVycykge1xuXHRcdFx0cGFja2FnZXNbcGtnSW5kZXhdID0gKHBrZyBhcyB7IHNvdXJjZTogc3RyaW5nIH0pLnNvdXJjZTtcblx0XHR9XG5cblx0XHRpZiAoc2NvcGUgPT09IFwicHJvamVjdFwiKSB7XG5cdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRQcm9qZWN0UGFja2FnZXMocGFja2FnZXMpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRQYWNrYWdlcyhwYWNrYWdlcyk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBnZXRUb3BMZXZlbEJhc2VEaXIoc2NvcGU6IFwidXNlclwiIHwgXCJwcm9qZWN0XCIpOiBzdHJpbmcge1xuXHRcdHJldHVybiBzY29wZSA9PT0gXCJwcm9qZWN0XCIgPyBqb2luKHRoaXMuY3dkLCBDT05GSUdfRElSX05BTUUpIDogdGhpcy5hZ2VudERpcjtcblx0fVxuXG5cdHByaXZhdGUgZ2V0UmVzb3VyY2VQYXR0ZXJuKGl0ZW06IFJlc291cmNlSXRlbSk6IHN0cmluZyB7XG5cdFx0Y29uc3Qgc2NvcGUgPSBpdGVtLm1ldGFkYXRhLnNjb3BlIGFzIFwidXNlclwiIHwgXCJwcm9qZWN0XCI7XG5cdFx0Y29uc3QgYmFzZURpciA9IHRoaXMuZ2V0VG9wTGV2ZWxCYXNlRGlyKHNjb3BlKTtcblx0XHRyZXR1cm4gcmVsYXRpdmUoYmFzZURpciwgaXRlbS5wYXRoKTtcblx0fVxuXG5cdHByaXZhdGUgZ2V0UGFja2FnZVJlc291cmNlUGF0dGVybihpdGVtOiBSZXNvdXJjZUl0ZW0pOiBzdHJpbmcge1xuXHRcdGNvbnN0IGJhc2VEaXIgPSBpdGVtLm1ldGFkYXRhLmJhc2VEaXIgPz8gZGlybmFtZShpdGVtLnBhdGgpO1xuXHRcdHJldHVybiByZWxhdGl2ZShiYXNlRGlyLCBpdGVtLnBhdGgpO1xuXHR9XG59XG5cbmV4cG9ydCBjbGFzcyBDb25maWdTZWxlY3RvckNvbXBvbmVudCBleHRlbmRzIENvbnRhaW5lciBpbXBsZW1lbnRzIEZvY3VzYWJsZSB7XG5cdHByaXZhdGUgcmVzb3VyY2VMaXN0OiBSZXNvdXJjZUxpc3Q7XG5cblx0cHJpdmF0ZSBfZm9jdXNlZCA9IGZhbHNlO1xuXHRnZXQgZm9jdXNlZCgpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5fZm9jdXNlZDtcblx0fVxuXHRzZXQgZm9jdXNlZCh2YWx1ZTogYm9vbGVhbikge1xuXHRcdHRoaXMuX2ZvY3VzZWQgPSB2YWx1ZTtcblx0XHR0aGlzLnJlc291cmNlTGlzdC5mb2N1c2VkID0gdmFsdWU7XG5cdH1cblxuXHRjb25zdHJ1Y3Rvcihcblx0XHRyZXNvbHZlZFBhdGhzOiBSZXNvbHZlZFBhdGhzLFxuXHRcdHNldHRpbmdzTWFuYWdlcjogU2V0dGluZ3NNYW5hZ2VyLFxuXHRcdGN3ZDogc3RyaW5nLFxuXHRcdGFnZW50RGlyOiBzdHJpbmcsXG5cdFx0b25DbG9zZTogKCkgPT4gdm9pZCxcblx0XHRvbkV4aXQ6ICgpID0+IHZvaWQsXG5cdFx0cmVxdWVzdFJlbmRlcjogKCkgPT4gdm9pZCxcblx0KSB7XG5cdFx0c3VwZXIoKTtcblxuXHRcdGNvbnN0IGdyb3VwcyA9IGJ1aWxkR3JvdXBzKHJlc29sdmVkUGF0aHMpO1xuXG5cdFx0Ly8gQWRkIGhlYWRlclxuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0dGhpcy5hZGRDaGlsZChuZXcgRHluYW1pY0JvcmRlcigpKTtcblx0XHR0aGlzLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IENvbmZpZ1NlbGVjdG9ySGVhZGVyKCkpO1xuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cblx0XHQvLyBSZXNvdXJjZSBsaXN0XG5cdFx0dGhpcy5yZXNvdXJjZUxpc3QgPSBuZXcgUmVzb3VyY2VMaXN0KGdyb3Vwcywgc2V0dGluZ3NNYW5hZ2VyLCBjd2QsIGFnZW50RGlyKTtcblx0XHR0aGlzLnJlc291cmNlTGlzdC5vbkNhbmNlbCA9IG9uQ2xvc2U7XG5cdFx0dGhpcy5yZXNvdXJjZUxpc3Qub25FeGl0ID0gb25FeGl0O1xuXHRcdHRoaXMucmVzb3VyY2VMaXN0Lm9uVG9nZ2xlID0gKCkgPT4gcmVxdWVzdFJlbmRlcigpO1xuXHRcdHRoaXMuYWRkQ2hpbGQodGhpcy5yZXNvdXJjZUxpc3QpO1xuXG5cdFx0Ly8gQm90dG9tIGJvcmRlclxuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0dGhpcy5hZGRDaGlsZChuZXcgRHluYW1pY0JvcmRlcigpKTtcblx0fVxuXG5cdGdldFJlc291cmNlTGlzdCgpOiBSZXNvdXJjZUxpc3Qge1xuXHRcdHJldHVybiB0aGlzLnJlc291cmNlTGlzdDtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBSUEsU0FBUyxVQUFVLFNBQVMsTUFBTSxnQkFBZ0I7QUFDbEQ7QUFBQSxFQUVDO0FBQUEsRUFFQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDTTtBQUNQLFNBQVMsdUJBQXVCO0FBR2hDLFNBQVMsYUFBYTtBQUN0QixTQUFTLHFCQUFxQjtBQUM5QixTQUFTLGtCQUFrQjtBQUkzQixNQUFNLHVCQUFxRDtBQUFBLEVBQzFELFlBQVk7QUFBQSxFQUNaLFFBQVE7QUFBQSxFQUNSLFNBQVM7QUFBQSxFQUNULFFBQVE7QUFDVDtBQTJCQSxTQUFTLGNBQWMsVUFBZ0M7QUFDdEQsTUFBSSxTQUFTLFdBQVcsV0FBVztBQUNsQyxXQUFPLEdBQUcsU0FBUyxNQUFNLEtBQUssU0FBUyxLQUFLO0FBQUEsRUFDN0M7QUFFQSxNQUFJLFNBQVMsV0FBVyxRQUFRO0FBQy9CLFdBQU8sU0FBUyxVQUFVLFNBQVMsd0JBQXdCO0FBQUEsRUFDNUQ7QUFDQSxTQUFPLFNBQVMsVUFBVSxTQUFTLGtCQUFrQjtBQUN0RDtBQUVBLFNBQVMsWUFBWSxVQUEwQztBQUM5RCxR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
