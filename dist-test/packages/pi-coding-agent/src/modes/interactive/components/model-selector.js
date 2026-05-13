import { modelsAreEqual } from "@gsd/pi-ai";
import {
  Container,
  fuzzyFilter,
  getEditorKeybindings,
  Input,
  Spacer,
  Text
} from "@gsd/pi-tui";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";
function providerDisplayName(provider) {
  return provider;
}
function providerAuthBadge(authMode) {
  switch (authMode) {
    case "apiKey":
      return "API key";
    case "oauth":
      return "OAuth";
    case "externalCli":
      return "CLI";
    default:
      return "";
  }
}
function formatTokenCount(count) {
  if (count >= 1e6) {
    const millions = count / 1e6;
    return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
  }
  if (count >= 1e3) {
    const thousands = count / 1e3;
    return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
  }
  return count.toString();
}
class ModelSelectorComponent extends Container {
  constructor(tui, currentModel, settingsManager, modelRegistry, scopedModels, onSelect, onCancel, initialSearchInput) {
    super();
    // Focusable implementation - propagate to searchInput for IME cursor positioning
    this._focused = false;
    this.allModels = [];
    this.scopedModelItems = [];
    this.activeModels = [];
    // Grouped (browse) state
    this.groupedRows = [];
    this.modelRowIndices = [];
    // indices into groupedRows that are "model" kind
    this.selectedGroupIndex = 0;
    // index into groupedRows (can be model or header)
    // Search (flat) state
    this.filteredModels = [];
    this.selectedFlatIndex = 0;
    this.isSearching = false;
    this.scope = "all";
    this.tui = tui;
    this.currentModel = currentModel;
    this.settingsManager = settingsManager;
    this.modelRegistry = modelRegistry;
    this.scopedModels = scopedModels;
    const hasReadyScopedModel = scopedModels.some(
      (scoped) => modelRegistry.isProviderRequestReady(scoped.model.provider)
    );
    this.scope = hasReadyScopedModel ? "scoped" : "all";
    this.onSelectCallback = onSelect;
    this.onCancelCallback = onCancel;
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    if (scopedModels.length > 0) {
      this.scopeText = new Text(this.getScopeText(), 0, 0);
      this.addChild(this.scopeText);
      this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
      this.addChild(this.scopeHintText);
    } else {
      const hintText = "Only showing models with configured credentials (API key, OAuth, or CLI). See README for details.";
      this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
    }
    this.addChild(new Spacer(1));
    this.searchInput = new Input();
    if (initialSearchInput) {
      this.searchInput.setValue(initialSearchInput);
    }
    this.searchInput.onSubmit = () => {
      if (this.isSearching) {
        if (this.filteredModels[this.selectedFlatIndex]) {
          this.handleSelect(this.filteredModels[this.selectedFlatIndex].model);
        }
      } else {
        const model = this.getSelectedModel();
        if (model) this.handleSelect(model);
      }
    };
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));
    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    this.loadModels().then(() => {
      if (initialSearchInput) {
        this.isSearching = true;
        this.filterModels(initialSearchInput);
      } else {
        this.buildGroupedRows();
        this.jumpToCurrentModel();
        this.updateList();
      }
      this.tui.requestRender();
    });
  }
  get focused() {
    return this._focused;
  }
  set focused(value) {
    this._focused = value;
    this.searchInput.focused = value;
  }
  async loadModels() {
    let models;
    this.modelRegistry.refresh();
    const loadError = this.modelRegistry.getError();
    if (loadError) {
      this.errorMessage = loadError;
    }
    try {
      const availableModels = this.modelRegistry.getAvailable();
      models = availableModels.map((model) => ({
        provider: model.provider,
        id: model.id,
        model
      }));
    } catch (error) {
      this.allModels = [];
      this.scopedModelItems = [];
      this.activeModels = [];
      this.filteredModels = [];
      this.groupedRows = [];
      this.modelRowIndices = [];
      this.errorMessage = error instanceof Error ? error.message : String(error);
      return;
    }
    this.allModels = this.sortModelsWithinProvider(models);
    this.scopedModelItems = this.sortModelsWithinProvider(
      this.scopedModels.filter((scoped) => this.modelRegistry.isProviderRequestReady(scoped.model.provider)).map((scoped) => ({
        provider: scoped.model.provider,
        id: scoped.model.id,
        model: scoped.model
      }))
    );
    this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
    this.filteredModels = this.activeModels;
  }
  /**
   * Sort models within each provider: current model first, then by name desc.
   * Provider ordering is handled separately in buildGroupedRows().
   */
  sortModelsWithinProvider(models) {
    const sorted = [...models];
    sorted.sort((a, b) => {
      const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
      const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
      const nameCmp = b.model.name.localeCompare(a.model.name);
      if (nameCmp !== 0) return nameCmp;
      return a.provider.localeCompare(b.provider);
    });
    return sorted;
  }
  /**
   * Build the grouped rows array for browse mode.
   * Current model's provider comes first; remaining providers sorted alphabetically.
   */
  buildGroupedRows() {
    const byProvider = /* @__PURE__ */ new Map();
    for (const item of this.activeModels) {
      let group = byProvider.get(item.provider);
      if (!group) {
        group = [];
        byProvider.set(item.provider, group);
      }
      group.push(item);
    }
    const currentProvider = this.currentModel?.provider;
    const providers = Array.from(byProvider.keys()).sort((a, b) => {
      if (a === currentProvider) return -1;
      if (b === currentProvider) return 1;
      return a.localeCompare(b);
    });
    const rows = [];
    const modelIndices = [];
    for (const provider of providers) {
      const items = byProvider.get(provider);
      rows.push({ kind: "header", provider, count: items.length });
      for (const item of items) {
        modelIndices.push(rows.length);
        rows.push({ kind: "model", item });
      }
    }
    this.groupedRows = rows;
    this.modelRowIndices = modelIndices;
  }
  /**
   * Move selectedGroupIndex to point at the current model (or first model).
   */
  jumpToCurrentModel() {
    if (this.groupedRows.length === 0) {
      this.selectedGroupIndex = 0;
      return;
    }
    for (let i = 0; i < this.groupedRows.length; i++) {
      const row = this.groupedRows[i];
      if (row.kind === "model" && modelsAreEqual(this.currentModel, row.item.model)) {
        this.selectedGroupIndex = i;
        return;
      }
    }
    if (this.modelRowIndices.length > 0) {
      this.selectedGroupIndex = this.modelRowIndices[0];
    }
  }
  /**
   * Get the currently selected model from grouped or flat state.
   */
  getSelectedModel() {
    if (this.isSearching) {
      return this.filteredModels[this.selectedFlatIndex]?.model;
    }
    const row = this.groupedRows[this.selectedGroupIndex];
    return row?.kind === "model" ? row.item.model : void 0;
  }
  getScopeText() {
    const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
    const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
    return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
  }
  getScopeHintText() {
    return keyHint("tab", "scope") + theme.fg("muted", " (all/scoped)");
  }
  setScope(scope) {
    if (this.scope === scope) return;
    this.scope = scope;
    this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
    if (this.isSearching) {
      this.selectedFlatIndex = 0;
      this.filterModels(this.searchInput.getValue());
    } else {
      this.buildGroupedRows();
      this.jumpToCurrentModel();
      this.updateList();
    }
    if (this.scopeText) {
      this.scopeText.setText(this.getScopeText());
    }
  }
  filterModels(query) {
    this.filteredModels = query ? fuzzyFilter(this.activeModels, query, ({ id, provider }) => `${id} ${provider}`) : this.activeModels;
    this.selectedFlatIndex = Math.min(this.selectedFlatIndex, Math.max(0, this.filteredModels.length - 1));
    this.updateList();
  }
  updateList() {
    this.listContainer.clear();
    if (this.errorMessage) {
      const errorLines = this.errorMessage.split("\n");
      for (const line of errorLines) {
        this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
      }
      return;
    }
    if (this.isSearching) {
      this.renderFlatList();
    } else {
      this.renderGroupedList();
    }
  }
  /** Flat fuzzy-search results, same as original behaviour */
  renderFlatList() {
    const maxVisible = 10;
    if (this.filteredModels.length === 0) {
      this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
      return;
    }
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedFlatIndex - Math.floor(maxVisible / 2),
        this.filteredModels.length - maxVisible
      )
    );
    const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredModels[i];
      if (!item) continue;
      const isSelected = i === this.selectedFlatIndex;
      const isCurrent = modelsAreEqual(this.currentModel, item.model);
      const ctx = formatTokenCount(item.model.contextWindow);
      const ctxBadge = theme.fg("muted", `${ctx}`);
      const authMode = this.modelRegistry.getProviderAuthMode(item.provider);
      const authLabel = providerAuthBadge(authMode);
      const providerBadgeText = authLabel ? `[${providerDisplayName(item.provider)} \xB7 ${authLabel}]` : `[${providerDisplayName(item.provider)}]`;
      const providerBadge = theme.fg("muted", providerBadgeText);
      const checkmark = isCurrent ? theme.fg("success", " \u2713") : "";
      let line;
      if (isSelected) {
        const prefix = theme.fg("accent", "\u2192 ");
        line = `${prefix}${theme.fg("accent", item.id)} ${ctxBadge} ${providerBadge}${checkmark}`;
      } else {
        line = `  ${item.id} ${ctxBadge} ${providerBadge}${checkmark}`;
      }
      this.listContainer.addChild(new Text(line, 0, 0));
    }
    if (startIndex > 0 || endIndex < this.filteredModels.length) {
      this.listContainer.addChild(
        new Text(theme.fg("muted", `  (${this.selectedFlatIndex + 1}/${this.filteredModels.length})`), 0, 0)
      );
    }
    const selected = this.filteredModels[this.selectedFlatIndex];
    if (selected) {
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(new Text(theme.fg("muted", `  ${this.modelDetailLine(selected.model)}`), 0, 0));
    }
  }
  /**
   * Grouped browse view: provider headers + model rows, windowed around selection.
   * Shows enough rows to fill ~10 visible lines; headers count as one line each.
   */
  renderGroupedList() {
    const maxVisible = 12;
    if (this.groupedRows.length === 0) {
      this.listContainer.addChild(
        new Text(theme.fg("muted", "  No providers configured."), 0, 0)
      );
      this.listContainer.addChild(
        new Text(
          theme.fg(
            "muted",
            "  Run /login (OAuth), set an API key, or install a CLI provider. See README."
          ),
          0,
          0
        )
      );
      return;
    }
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedGroupIndex - Math.floor(maxVisible / 2),
        this.groupedRows.length - maxVisible
      )
    );
    const endIndex = Math.min(startIndex + maxVisible, this.groupedRows.length);
    for (let i = startIndex; i < endIndex; i++) {
      const row = this.groupedRows[i];
      if (!row) continue;
      if (row.kind === "header") {
        const providerLabel = theme.fg("borderAccent", providerDisplayName(row.provider));
        const count = theme.fg("muted", ` (${row.count})`);
        const authMode = this.modelRegistry.getProviderAuthMode(row.provider);
        const authLabel = providerAuthBadge(authMode);
        const authText = authLabel ? theme.fg("muted", ` \xB7 via ${authLabel}`) : "";
        if (i > startIndex) {
          this.listContainer.addChild(new Text("", 0, 0));
        }
        this.listContainer.addChild(new Text(`  ${providerLabel}${count}${authText}`, 0, 0));
      } else {
        const isSelected = i === this.selectedGroupIndex;
        const isCurrent = modelsAreEqual(this.currentModel, row.item.model);
        const ctx = formatTokenCount(row.item.model.contextWindow);
        const ctxBadge = theme.fg("muted", ` ${ctx}`);
        const checkmark = isCurrent ? theme.fg("success", " \u2713") : "";
        let line;
        if (isSelected) {
          line = `  ${theme.fg("accent", "\u2192")} ${theme.fg("accent", row.item.id)}${ctxBadge}${checkmark}`;
        } else {
          line = `    ${row.item.id}${ctxBadge}${checkmark}`;
        }
        this.listContainer.addChild(new Text(line, 0, 0));
      }
    }
    if (startIndex > 0 || endIndex < this.groupedRows.length) {
      const modelPos = this.modelRowIndices.indexOf(this.selectedGroupIndex) + 1;
      const totalModels = this.modelRowIndices.length;
      this.listContainer.addChild(
        new Text(theme.fg("muted", `  (${modelPos}/${totalModels})`), 0, 0)
      );
    }
    const selectedModel = this.getSelectedModel();
    if (selectedModel) {
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(
        new Text(theme.fg("muted", `  ${this.modelDetailLine(selectedModel)}`), 0, 0)
      );
    }
  }
  modelDetailLine(m) {
    return [
      m.name,
      `ctx: ${formatTokenCount(m.contextWindow)}`,
      `out: ${formatTokenCount(m.maxTokens)}`,
      m.reasoning ? "thinking" : "",
      m.input.includes("image") ? "vision" : ""
    ].filter(Boolean).join(" \xB7 ");
  }
  handleInput(keyData) {
    const kb = getEditorKeybindings();
    if (kb.matches(keyData, "tab")) {
      if (this.scopedModelItems.length > 0) {
        const nextScope = this.scope === "all" ? "scoped" : "all";
        this.setScope(nextScope);
        if (this.scopeHintText) {
          this.scopeHintText.setText(this.getScopeHintText());
        }
      }
      return;
    }
    if (kb.matches(keyData, "selectUp")) {
      this.moveUp();
      return;
    }
    if (kb.matches(keyData, "selectDown")) {
      this.moveDown();
      return;
    }
    if (kb.matches(keyData, "selectConfirm")) {
      const model = this.getSelectedModel();
      if (model) this.handleSelect(model);
      return;
    }
    if (kb.matches(keyData, "selectCancel")) {
      this.onCancelCallback();
      return;
    }
    const prevQuery = this.searchInput.getValue();
    this.searchInput.handleInput(keyData);
    const newQuery = this.searchInput.getValue();
    if (newQuery !== prevQuery) {
      const entering = !prevQuery && !!newQuery;
      const leaving = !!prevQuery && !newQuery;
      if (entering) {
        this.isSearching = true;
        this.selectedFlatIndex = 0;
      } else if (leaving) {
        this.isSearching = false;
        this.buildGroupedRows();
        this.jumpToCurrentModel();
      }
      if (this.isSearching) {
        this.filterModels(newQuery);
      } else {
        this.updateList();
      }
    }
  }
  /** Move selection up, skipping headers in grouped mode */
  moveUp() {
    if (this.isSearching) {
      if (this.filteredModels.length === 0) return;
      this.selectedFlatIndex = this.selectedFlatIndex === 0 ? this.filteredModels.length - 1 : this.selectedFlatIndex - 1;
      this.updateList();
      return;
    }
    if (this.groupedRows.length === 0) return;
    let next = this.selectedGroupIndex - 1;
    if (next < 0) next = this.groupedRows.length - 1;
    while (next > 0 && this.groupedRows[next]?.kind === "header") {
      next--;
    }
    if (this.groupedRows[next]?.kind === "header") {
      next = this.groupedRows.length - 1;
    }
    this.selectedGroupIndex = next;
    this.updateList();
  }
  /** Move selection down, skipping headers in grouped mode */
  moveDown() {
    if (this.isSearching) {
      if (this.filteredModels.length === 0) return;
      this.selectedFlatIndex = this.selectedFlatIndex === this.filteredModels.length - 1 ? 0 : this.selectedFlatIndex + 1;
      this.updateList();
      return;
    }
    if (this.groupedRows.length === 0) return;
    let next = this.selectedGroupIndex + 1;
    if (next >= this.groupedRows.length) next = 0;
    while (next < this.groupedRows.length - 1 && this.groupedRows[next]?.kind === "header") {
      next++;
    }
    if (this.groupedRows[next]?.kind === "header") {
      next = this.modelRowIndices[0] ?? 0;
    }
    this.selectedGroupIndex = next;
    this.updateList();
  }
  handleSelect(model) {
    this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
    this.onSelectCallback(model);
  }
  getSearchInput() {
    return this.searchInput;
  }
}
export {
  ModelSelectorComponent,
  providerAuthBadge,
  providerDisplayName
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL21vZGVsLXNlbGVjdG9yLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyB0eXBlIE1vZGVsLCBtb2RlbHNBcmVFcXVhbCB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQge1xuXHRDb250YWluZXIsXG5cdHR5cGUgRm9jdXNhYmxlLFxuXHRmdXp6eUZpbHRlcixcblx0Z2V0RWRpdG9yS2V5YmluZGluZ3MsXG5cdElucHV0LFxuXHRTcGFjZXIsXG5cdFRleHQsXG5cdHR5cGUgVFVJLFxufSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB0eXBlIHsgTW9kZWxSZWdpc3RyeSwgUHJvdmlkZXJBdXRoTW9kZSB9IGZyb20gXCIuLi8uLi8uLi9jb3JlL21vZGVsLXJlZ2lzdHJ5LmpzXCI7XG5pbXBvcnQgdHlwZSB7IFNldHRpbmdzTWFuYWdlciB9IGZyb20gXCIuLi8uLi8uLi9jb3JlL3NldHRpbmdzLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7IHRoZW1lIH0gZnJvbSBcIi4uL3RoZW1lL3RoZW1lLmpzXCI7XG5pbXBvcnQgeyBEeW5hbWljQm9yZGVyIH0gZnJvbSBcIi4vZHluYW1pYy1ib3JkZXIuanNcIjtcbmltcG9ydCB7IGtleUhpbnQgfSBmcm9tIFwiLi9rZXliaW5kaW5nLWhpbnRzLmpzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBwcm92aWRlckRpc3BsYXlOYW1lKHByb3ZpZGVyOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gcHJvdmlkZXI7XG59XG5cbi8qKlxuICogU2hvcnQsIHVzZXItZmFjaW5nIGxhYmVsIGZvciBhIHByb3ZpZGVyJ3MgYXV0aCBtb2RlLiBSZXR1cm5lZCBzdHJpbmdzIGFyZVxuICogc3VpdGFibGUgZm9yIHVzZSBhcyBhIHN1ZmZpeC9iYWRnZSBhbG9uZ3NpZGUgdGhlIHByb3ZpZGVyIG5hbWUuXG4gKiBSZXR1cm5zIGFuIGVtcHR5IHN0cmluZyBmb3IgbW9kZXMgdGhhdCBkb24ndCBuZWVkIGEgYmFkZ2UgKGUuZy4gXCJub25lXCIpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcHJvdmlkZXJBdXRoQmFkZ2UoYXV0aE1vZGU/OiBQcm92aWRlckF1dGhNb2RlKTogc3RyaW5nIHtcblx0c3dpdGNoIChhdXRoTW9kZSkge1xuXHRcdGNhc2UgXCJhcGlLZXlcIjpcblx0XHRcdHJldHVybiBcIkFQSSBrZXlcIjtcblx0XHRjYXNlIFwib2F1dGhcIjpcblx0XHRcdHJldHVybiBcIk9BdXRoXCI7XG5cdFx0Y2FzZSBcImV4dGVybmFsQ2xpXCI6XG5cdFx0XHRyZXR1cm4gXCJDTElcIjtcblx0XHRkZWZhdWx0OlxuXHRcdFx0cmV0dXJuIFwiXCI7XG5cdH1cbn1cblxuZnVuY3Rpb24gZm9ybWF0VG9rZW5Db3VudChjb3VudDogbnVtYmVyKTogc3RyaW5nIHtcblx0aWYgKGNvdW50ID49IDFfMDAwXzAwMCkge1xuXHRcdGNvbnN0IG1pbGxpb25zID0gY291bnQgLyAxXzAwMF8wMDA7XG5cdFx0cmV0dXJuIG1pbGxpb25zICUgMSA9PT0gMCA/IGAke21pbGxpb25zfU1gIDogYCR7bWlsbGlvbnMudG9GaXhlZCgxKX1NYDtcblx0fVxuXHRpZiAoY291bnQgPj0gMV8wMDApIHtcblx0XHRjb25zdCB0aG91c2FuZHMgPSBjb3VudCAvIDFfMDAwO1xuXHRcdHJldHVybiB0aG91c2FuZHMgJSAxID09PSAwID8gYCR7dGhvdXNhbmRzfUtgIDogYCR7dGhvdXNhbmRzLnRvRml4ZWQoMSl9S2A7XG5cdH1cblx0cmV0dXJuIGNvdW50LnRvU3RyaW5nKCk7XG59XG5cbmludGVyZmFjZSBNb2RlbEl0ZW0ge1xuXHRwcm92aWRlcjogc3RyaW5nO1xuXHRpZDogc3RyaW5nO1xuXHRtb2RlbDogTW9kZWw8YW55Pjtcbn1cblxuaW50ZXJmYWNlIFNjb3BlZE1vZGVsSXRlbSB7XG5cdG1vZGVsOiBNb2RlbDxhbnk+O1xuXHR0aGlua2luZ0xldmVsPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIEEgbmF2aWdhYmxlIHJvdyBcdTIwMTQgZWl0aGVyIGEgcHJvdmlkZXIgZ3JvdXAgaGVhZGVyIG9yIGEgc2VsZWN0YWJsZSBtb2RlbCBlbnRyeS5cbiAqL1xudHlwZSBMaXN0Um93ID1cblx0fCB7IGtpbmQ6IFwiaGVhZGVyXCI7IHByb3ZpZGVyOiBzdHJpbmc7IGNvdW50OiBudW1iZXIgfVxuXHR8IHsga2luZDogXCJtb2RlbFwiOyBpdGVtOiBNb2RlbEl0ZW0gfTtcblxudHlwZSBNb2RlbFNjb3BlID0gXCJhbGxcIiB8IFwic2NvcGVkXCI7XG5cbi8qKlxuICogQ29tcG9uZW50IHRoYXQgcmVuZGVycyBhIGdyb3VwZWQgbW9kZWwgc2VsZWN0b3Igd2l0aCBzZWFyY2guXG4gKlxuICogQnJvd3NpbmcgKG5vIHNlYXJjaCk6IG1vZGVscyBhcmUgZ3JvdXBlZCB1bmRlciBwcm92aWRlciBoZWFkZXJzLlxuICogICAtIEN1cnJlbnQgbW9kZWwncyBwcm92aWRlciBpcyBzaG93biBmaXJzdDsgcmVtYWluaW5nIHByb3ZpZGVycyBzb3J0ZWQgYWxwaGFiZXRpY2FsbHkuXG4gKiAgIC0gQXJyb3cga2V5cyBuYXZpZ2F0ZSBhbGwgcm93czsgaGVhZGVycyBhcmUgc2tpcHBlZCBkdXJpbmcgc2VsZWN0aW9uLlxuICogU2VhcmNoaW5nOiByZXZlcnRzIHRvIGEgZmxhdCBmdXp6eS1maWx0ZXJlZCBsaXN0IChzYW1lIGFzIGJlZm9yZSksIHdpdGggW3Byb3ZpZGVyXSBiYWRnZXMuXG4gKi9cbmV4cG9ydCBjbGFzcyBNb2RlbFNlbGVjdG9yQ29tcG9uZW50IGV4dGVuZHMgQ29udGFpbmVyIGltcGxlbWVudHMgRm9jdXNhYmxlIHtcblx0cHJpdmF0ZSBzZWFyY2hJbnB1dDogSW5wdXQ7XG5cblx0Ly8gRm9jdXNhYmxlIGltcGxlbWVudGF0aW9uIC0gcHJvcGFnYXRlIHRvIHNlYXJjaElucHV0IGZvciBJTUUgY3Vyc29yIHBvc2l0aW9uaW5nXG5cdHByaXZhdGUgX2ZvY3VzZWQgPSBmYWxzZTtcblx0Z2V0IGZvY3VzZWQoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuX2ZvY3VzZWQ7XG5cdH1cblx0c2V0IGZvY3VzZWQodmFsdWU6IGJvb2xlYW4pIHtcblx0XHR0aGlzLl9mb2N1c2VkID0gdmFsdWU7XG5cdFx0dGhpcy5zZWFyY2hJbnB1dC5mb2N1c2VkID0gdmFsdWU7XG5cdH1cblx0cHJpdmF0ZSBsaXN0Q29udGFpbmVyOiBDb250YWluZXI7XG5cdHByaXZhdGUgYWxsTW9kZWxzOiBNb2RlbEl0ZW1bXSA9IFtdO1xuXHRwcml2YXRlIHNjb3BlZE1vZGVsSXRlbXM6IE1vZGVsSXRlbVtdID0gW107XG5cdHByaXZhdGUgYWN0aXZlTW9kZWxzOiBNb2RlbEl0ZW1bXSA9IFtdO1xuXG5cdC8vIEdyb3VwZWQgKGJyb3dzZSkgc3RhdGVcblx0cHJpdmF0ZSBncm91cGVkUm93czogTGlzdFJvd1tdID0gW107XG5cdHByaXZhdGUgbW9kZWxSb3dJbmRpY2VzOiBudW1iZXJbXSA9IFtdOyAvLyBpbmRpY2VzIGludG8gZ3JvdXBlZFJvd3MgdGhhdCBhcmUgXCJtb2RlbFwiIGtpbmRcblx0cHJpdmF0ZSBzZWxlY3RlZEdyb3VwSW5kZXg6IG51bWJlciA9IDA7IC8vIGluZGV4IGludG8gZ3JvdXBlZFJvd3MgKGNhbiBiZSBtb2RlbCBvciBoZWFkZXIpXG5cblx0Ly8gU2VhcmNoIChmbGF0KSBzdGF0ZVxuXHRwcml2YXRlIGZpbHRlcmVkTW9kZWxzOiBNb2RlbEl0ZW1bXSA9IFtdO1xuXHRwcml2YXRlIHNlbGVjdGVkRmxhdEluZGV4OiBudW1iZXIgPSAwO1xuXG5cdHByaXZhdGUgaXNTZWFyY2hpbmc6IGJvb2xlYW4gPSBmYWxzZTtcblx0cHJpdmF0ZSBjdXJyZW50TW9kZWw/OiBNb2RlbDxhbnk+O1xuXHRwcml2YXRlIHNldHRpbmdzTWFuYWdlcjogU2V0dGluZ3NNYW5hZ2VyO1xuXHRwcml2YXRlIG1vZGVsUmVnaXN0cnk6IE1vZGVsUmVnaXN0cnk7XG5cdHByaXZhdGUgb25TZWxlY3RDYWxsYmFjazogKG1vZGVsOiBNb2RlbDxhbnk+KSA9PiB2b2lkO1xuXHRwcml2YXRlIG9uQ2FuY2VsQ2FsbGJhY2s6ICgpID0+IHZvaWQ7XG5cdHByaXZhdGUgZXJyb3JNZXNzYWdlPzogc3RyaW5nO1xuXHRwcml2YXRlIHR1aTogVFVJO1xuXHRwcml2YXRlIHNjb3BlZE1vZGVsczogUmVhZG9ubHlBcnJheTxTY29wZWRNb2RlbEl0ZW0+O1xuXHRwcml2YXRlIHNjb3BlOiBNb2RlbFNjb3BlID0gXCJhbGxcIjtcblx0cHJpdmF0ZSBzY29wZVRleHQ/OiBUZXh0O1xuXHRwcml2YXRlIHNjb3BlSGludFRleHQ/OiBUZXh0O1xuXG5cdGNvbnN0cnVjdG9yKFxuXHRcdHR1aTogVFVJLFxuXHRcdGN1cnJlbnRNb2RlbDogTW9kZWw8YW55PiB8IHVuZGVmaW5lZCxcblx0XHRzZXR0aW5nc01hbmFnZXI6IFNldHRpbmdzTWFuYWdlcixcblx0XHRtb2RlbFJlZ2lzdHJ5OiBNb2RlbFJlZ2lzdHJ5LFxuXHRcdHNjb3BlZE1vZGVsczogUmVhZG9ubHlBcnJheTxTY29wZWRNb2RlbEl0ZW0+LFxuXHRcdG9uU2VsZWN0OiAobW9kZWw6IE1vZGVsPGFueT4pID0+IHZvaWQsXG5cdFx0b25DYW5jZWw6ICgpID0+IHZvaWQsXG5cdFx0aW5pdGlhbFNlYXJjaElucHV0Pzogc3RyaW5nLFxuXHQpIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0dGhpcy50dWkgPSB0dWk7XG5cdFx0dGhpcy5jdXJyZW50TW9kZWwgPSBjdXJyZW50TW9kZWw7XG5cdFx0dGhpcy5zZXR0aW5nc01hbmFnZXIgPSBzZXR0aW5nc01hbmFnZXI7XG5cdFx0dGhpcy5tb2RlbFJlZ2lzdHJ5ID0gbW9kZWxSZWdpc3RyeTtcblx0XHR0aGlzLnNjb3BlZE1vZGVscyA9IHNjb3BlZE1vZGVscztcblx0XHQvLyBPbmx5IGxhbmQgaW4gXCJzY29wZWRcIiB2aWV3IHdoZW4gYXQgbGVhc3Qgb25lIHNjb3BlZCBtb2RlbCBoYXMgd29ya2luZ1xuXHRcdC8vIGF1dGggXHUyMDE0IG90aGVyd2lzZSB0aGUgdXNlciB3b3VsZCBzZWUgYW4gZW1wdHkgcGlja2VyICgjdW5jb25maWd1cmVkLW1vZGVscykuXG5cdFx0Y29uc3QgaGFzUmVhZHlTY29wZWRNb2RlbCA9IHNjb3BlZE1vZGVscy5zb21lKChzY29wZWQpID0+XG5cdFx0XHRtb2RlbFJlZ2lzdHJ5LmlzUHJvdmlkZXJSZXF1ZXN0UmVhZHkoc2NvcGVkLm1vZGVsLnByb3ZpZGVyKSxcblx0XHQpO1xuXHRcdHRoaXMuc2NvcGUgPSBoYXNSZWFkeVNjb3BlZE1vZGVsID8gXCJzY29wZWRcIiA6IFwiYWxsXCI7XG5cdFx0dGhpcy5vblNlbGVjdENhbGxiYWNrID0gb25TZWxlY3Q7XG5cdFx0dGhpcy5vbkNhbmNlbENhbGxiYWNrID0gb25DYW5jZWw7XG5cblx0XHQvLyBBZGQgdG9wIGJvcmRlclxuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IER5bmFtaWNCb3JkZXIoKSk7XG5cdFx0dGhpcy5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblxuXHRcdC8vIEFkZCBoaW50IGFib3V0IG1vZGVsIGZpbHRlcmluZ1xuXHRcdGlmIChzY29wZWRNb2RlbHMubGVuZ3RoID4gMCkge1xuXHRcdFx0dGhpcy5zY29wZVRleHQgPSBuZXcgVGV4dCh0aGlzLmdldFNjb3BlVGV4dCgpLCAwLCAwKTtcblx0XHRcdHRoaXMuYWRkQ2hpbGQodGhpcy5zY29wZVRleHQpO1xuXHRcdFx0dGhpcy5zY29wZUhpbnRUZXh0ID0gbmV3IFRleHQodGhpcy5nZXRTY29wZUhpbnRUZXh0KCksIDAsIDApO1xuXHRcdFx0dGhpcy5hZGRDaGlsZCh0aGlzLnNjb3BlSGludFRleHQpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRjb25zdCBoaW50VGV4dCA9XG5cdFx0XHRcdFwiT25seSBzaG93aW5nIG1vZGVscyB3aXRoIGNvbmZpZ3VyZWQgY3JlZGVudGlhbHMgKEFQSSBrZXksIE9BdXRoLCBvciBDTEkpLiBTZWUgUkVBRE1FIGZvciBkZXRhaWxzLlwiO1xuXHRcdFx0dGhpcy5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5mZyhcIndhcm5pbmdcIiwgaGludFRleHQpLCAwLCAwKSk7XG5cdFx0fVxuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cblx0XHQvLyBDcmVhdGUgc2VhcmNoIGlucHV0XG5cdFx0dGhpcy5zZWFyY2hJbnB1dCA9IG5ldyBJbnB1dCgpO1xuXHRcdGlmIChpbml0aWFsU2VhcmNoSW5wdXQpIHtcblx0XHRcdHRoaXMuc2VhcmNoSW5wdXQuc2V0VmFsdWUoaW5pdGlhbFNlYXJjaElucHV0KTtcblx0XHR9XG5cdFx0dGhpcy5zZWFyY2hJbnB1dC5vblN1Ym1pdCA9ICgpID0+IHtcblx0XHRcdGlmICh0aGlzLmlzU2VhcmNoaW5nKSB7XG5cdFx0XHRcdGlmICh0aGlzLmZpbHRlcmVkTW9kZWxzW3RoaXMuc2VsZWN0ZWRGbGF0SW5kZXhdKSB7XG5cdFx0XHRcdFx0dGhpcy5oYW5kbGVTZWxlY3QodGhpcy5maWx0ZXJlZE1vZGVsc1t0aGlzLnNlbGVjdGVkRmxhdEluZGV4XS5tb2RlbCk7XG5cdFx0XHRcdH1cblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGNvbnN0IG1vZGVsID0gdGhpcy5nZXRTZWxlY3RlZE1vZGVsKCk7XG5cdFx0XHRcdGlmIChtb2RlbCkgdGhpcy5oYW5kbGVTZWxlY3QobW9kZWwpO1xuXHRcdFx0fVxuXHRcdH07XG5cdFx0dGhpcy5hZGRDaGlsZCh0aGlzLnNlYXJjaElucHV0KTtcblxuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cblx0XHQvLyBDcmVhdGUgbGlzdCBjb250YWluZXJcblx0XHR0aGlzLmxpc3RDb250YWluZXIgPSBuZXcgQ29udGFpbmVyKCk7XG5cdFx0dGhpcy5hZGRDaGlsZCh0aGlzLmxpc3RDb250YWluZXIpO1xuXG5cdFx0dGhpcy5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblxuXHRcdC8vIEFkZCBib3R0b20gYm9yZGVyXG5cdFx0dGhpcy5hZGRDaGlsZChuZXcgRHluYW1pY0JvcmRlcigpKTtcblxuXHRcdC8vIExvYWQgbW9kZWxzIGFuZCBkbyBpbml0aWFsIHJlbmRlclxuXHRcdHRoaXMubG9hZE1vZGVscygpLnRoZW4oKCkgPT4ge1xuXHRcdFx0aWYgKGluaXRpYWxTZWFyY2hJbnB1dCkge1xuXHRcdFx0XHR0aGlzLmlzU2VhcmNoaW5nID0gdHJ1ZTtcblx0XHRcdFx0dGhpcy5maWx0ZXJNb2RlbHMoaW5pdGlhbFNlYXJjaElucHV0KTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHRoaXMuYnVpbGRHcm91cGVkUm93cygpO1xuXHRcdFx0XHR0aGlzLmp1bXBUb0N1cnJlbnRNb2RlbCgpO1xuXHRcdFx0XHR0aGlzLnVwZGF0ZUxpc3QoKTtcblx0XHRcdH1cblx0XHRcdC8vIFJlcXVlc3QgcmUtcmVuZGVyIGFmdGVyIG1vZGVscyBhcmUgbG9hZGVkXG5cdFx0XHR0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0fSk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIGxvYWRNb2RlbHMoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0bGV0IG1vZGVsczogTW9kZWxJdGVtW107XG5cblx0XHQvLyBSZWZyZXNoIHRvIHBpY2sgdXAgYW55IGNoYW5nZXMgdG8gbW9kZWxzLmpzb25cblx0XHR0aGlzLm1vZGVsUmVnaXN0cnkucmVmcmVzaCgpO1xuXG5cdFx0Ly8gQ2hlY2sgZm9yIG1vZGVscy5qc29uIGVycm9yc1xuXHRcdGNvbnN0IGxvYWRFcnJvciA9IHRoaXMubW9kZWxSZWdpc3RyeS5nZXRFcnJvcigpO1xuXHRcdGlmIChsb2FkRXJyb3IpIHtcblx0XHRcdHRoaXMuZXJyb3JNZXNzYWdlID0gbG9hZEVycm9yO1xuXHRcdH1cblxuXHRcdC8vIExvYWQgYXZhaWxhYmxlIG1vZGVscyAoYnVpbHQtaW4gbW9kZWxzIHN0aWxsIHdvcmsgZXZlbiBpZiBtb2RlbHMuanNvbiBmYWlsZWQpXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGF2YWlsYWJsZU1vZGVscyA9IHRoaXMubW9kZWxSZWdpc3RyeS5nZXRBdmFpbGFibGUoKTtcblx0XHRcdG1vZGVscyA9IGF2YWlsYWJsZU1vZGVscy5tYXAoKG1vZGVsOiBNb2RlbDxhbnk+KSA9PiAoe1xuXHRcdFx0XHRwcm92aWRlcjogbW9kZWwucHJvdmlkZXIsXG5cdFx0XHRcdGlkOiBtb2RlbC5pZCxcblx0XHRcdFx0bW9kZWwsXG5cdFx0XHR9KSk7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdHRoaXMuYWxsTW9kZWxzID0gW107XG5cdFx0XHR0aGlzLnNjb3BlZE1vZGVsSXRlbXMgPSBbXTtcblx0XHRcdHRoaXMuYWN0aXZlTW9kZWxzID0gW107XG5cdFx0XHR0aGlzLmZpbHRlcmVkTW9kZWxzID0gW107XG5cdFx0XHR0aGlzLmdyb3VwZWRSb3dzID0gW107XG5cdFx0XHR0aGlzLm1vZGVsUm93SW5kaWNlcyA9IFtdO1xuXHRcdFx0dGhpcy5lcnJvck1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0dGhpcy5hbGxNb2RlbHMgPSB0aGlzLnNvcnRNb2RlbHNXaXRoaW5Qcm92aWRlcihtb2RlbHMpO1xuXHRcdC8vIFNjb3BlZCBtb2RlbHMgbXVzdCBhbHNvIGJlIGZpbHRlcmVkIGJ5IHByb3ZpZGVyIHJlYWRpbmVzcyBzbyB1c2Vyc1xuXHRcdC8vIGNhbid0IHBpY2sgYSBzY29wZWQgbW9kZWwgd2hvc2UgcHJvdmlkZXIgaGFzIG5vIEFQSSBrZXkgLyBPQXV0aC5cblx0XHR0aGlzLnNjb3BlZE1vZGVsSXRlbXMgPSB0aGlzLnNvcnRNb2RlbHNXaXRoaW5Qcm92aWRlcihcblx0XHRcdHRoaXMuc2NvcGVkTW9kZWxzXG5cdFx0XHRcdC5maWx0ZXIoKHNjb3BlZCkgPT4gdGhpcy5tb2RlbFJlZ2lzdHJ5LmlzUHJvdmlkZXJSZXF1ZXN0UmVhZHkoc2NvcGVkLm1vZGVsLnByb3ZpZGVyKSlcblx0XHRcdFx0Lm1hcCgoc2NvcGVkKSA9PiAoe1xuXHRcdFx0XHRcdHByb3ZpZGVyOiBzY29wZWQubW9kZWwucHJvdmlkZXIsXG5cdFx0XHRcdFx0aWQ6IHNjb3BlZC5tb2RlbC5pZCxcblx0XHRcdFx0XHRtb2RlbDogc2NvcGVkLm1vZGVsLFxuXHRcdFx0XHR9KSksXG5cdFx0KTtcblx0XHR0aGlzLmFjdGl2ZU1vZGVscyA9IHRoaXMuc2NvcGUgPT09IFwic2NvcGVkXCIgPyB0aGlzLnNjb3BlZE1vZGVsSXRlbXMgOiB0aGlzLmFsbE1vZGVscztcblx0XHR0aGlzLmZpbHRlcmVkTW9kZWxzID0gdGhpcy5hY3RpdmVNb2RlbHM7XG5cdH1cblxuXHQvKipcblx0ICogU29ydCBtb2RlbHMgd2l0aGluIGVhY2ggcHJvdmlkZXI6IGN1cnJlbnQgbW9kZWwgZmlyc3QsIHRoZW4gYnkgbmFtZSBkZXNjLlxuXHQgKiBQcm92aWRlciBvcmRlcmluZyBpcyBoYW5kbGVkIHNlcGFyYXRlbHkgaW4gYnVpbGRHcm91cGVkUm93cygpLlxuXHQgKi9cblx0cHJpdmF0ZSBzb3J0TW9kZWxzV2l0aGluUHJvdmlkZXIobW9kZWxzOiBNb2RlbEl0ZW1bXSk6IE1vZGVsSXRlbVtdIHtcblx0XHRjb25zdCBzb3J0ZWQgPSBbLi4ubW9kZWxzXTtcblx0XHRzb3J0ZWQuc29ydCgoYSwgYikgPT4ge1xuXHRcdFx0Y29uc3QgYUlzQ3VycmVudCA9IG1vZGVsc0FyZUVxdWFsKHRoaXMuY3VycmVudE1vZGVsLCBhLm1vZGVsKTtcblx0XHRcdGNvbnN0IGJJc0N1cnJlbnQgPSBtb2RlbHNBcmVFcXVhbCh0aGlzLmN1cnJlbnRNb2RlbCwgYi5tb2RlbCk7XG5cdFx0XHRpZiAoYUlzQ3VycmVudCAmJiAhYklzQ3VycmVudCkgcmV0dXJuIC0xO1xuXHRcdFx0aWYgKCFhSXNDdXJyZW50ICYmIGJJc0N1cnJlbnQpIHJldHVybiAxO1xuXHRcdFx0Ly8gV2l0aGluIHByb3ZpZGVyOiBuZXdlc3QvbGFyZ2VzdCBtb2RlbCBuYW1lIGZpcnN0XG5cdFx0XHRjb25zdCBuYW1lQ21wID0gYi5tb2RlbC5uYW1lLmxvY2FsZUNvbXBhcmUoYS5tb2RlbC5uYW1lKTtcblx0XHRcdGlmIChuYW1lQ21wICE9PSAwKSByZXR1cm4gbmFtZUNtcDtcblx0XHRcdHJldHVybiBhLnByb3ZpZGVyLmxvY2FsZUNvbXBhcmUoYi5wcm92aWRlcik7XG5cdFx0fSk7XG5cdFx0cmV0dXJuIHNvcnRlZDtcblx0fVxuXG5cdC8qKlxuXHQgKiBCdWlsZCB0aGUgZ3JvdXBlZCByb3dzIGFycmF5IGZvciBicm93c2UgbW9kZS5cblx0ICogQ3VycmVudCBtb2RlbCdzIHByb3ZpZGVyIGNvbWVzIGZpcnN0OyByZW1haW5pbmcgcHJvdmlkZXJzIHNvcnRlZCBhbHBoYWJldGljYWxseS5cblx0ICovXG5cdHByaXZhdGUgYnVpbGRHcm91cGVkUm93cygpOiB2b2lkIHtcblx0XHQvLyBHcm91cCBtb2RlbHMgYnkgcHJvdmlkZXJcblx0XHRjb25zdCBieVByb3ZpZGVyID0gbmV3IE1hcDxzdHJpbmcsIE1vZGVsSXRlbVtdPigpO1xuXHRcdGZvciAoY29uc3QgaXRlbSBvZiB0aGlzLmFjdGl2ZU1vZGVscykge1xuXHRcdFx0bGV0IGdyb3VwID0gYnlQcm92aWRlci5nZXQoaXRlbS5wcm92aWRlcik7XG5cdFx0XHRpZiAoIWdyb3VwKSB7XG5cdFx0XHRcdGdyb3VwID0gW107XG5cdFx0XHRcdGJ5UHJvdmlkZXIuc2V0KGl0ZW0ucHJvdmlkZXIsIGdyb3VwKTtcblx0XHRcdH1cblx0XHRcdGdyb3VwLnB1c2goaXRlbSk7XG5cdFx0fVxuXG5cdFx0Ly8gRGV0ZXJtaW5lIHByb3ZpZGVyIG9yZGVyOiBjdXJyZW50IG1vZGVsJ3MgcHJvdmlkZXIgZmlyc3QsIHJlc3QgYWxwaGFiZXRpY2FsbHlcblx0XHRjb25zdCBjdXJyZW50UHJvdmlkZXIgPSB0aGlzLmN1cnJlbnRNb2RlbD8ucHJvdmlkZXI7XG5cdFx0Y29uc3QgcHJvdmlkZXJzID0gQXJyYXkuZnJvbShieVByb3ZpZGVyLmtleXMoKSkuc29ydCgoYSwgYikgPT4ge1xuXHRcdFx0aWYgKGEgPT09IGN1cnJlbnRQcm92aWRlcikgcmV0dXJuIC0xO1xuXHRcdFx0aWYgKGIgPT09IGN1cnJlbnRQcm92aWRlcikgcmV0dXJuIDE7XG5cdFx0XHRyZXR1cm4gYS5sb2NhbGVDb21wYXJlKGIpO1xuXHRcdH0pO1xuXG5cdFx0Y29uc3Qgcm93czogTGlzdFJvd1tdID0gW107XG5cdFx0Y29uc3QgbW9kZWxJbmRpY2VzOiBudW1iZXJbXSA9IFtdO1xuXG5cdFx0Zm9yIChjb25zdCBwcm92aWRlciBvZiBwcm92aWRlcnMpIHtcblx0XHRcdGNvbnN0IGl0ZW1zID0gYnlQcm92aWRlci5nZXQocHJvdmlkZXIpITtcblx0XHRcdHJvd3MucHVzaCh7IGtpbmQ6IFwiaGVhZGVyXCIsIHByb3ZpZGVyLCBjb3VudDogaXRlbXMubGVuZ3RoIH0pO1xuXHRcdFx0Zm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XG5cdFx0XHRcdG1vZGVsSW5kaWNlcy5wdXNoKHJvd3MubGVuZ3RoKTtcblx0XHRcdFx0cm93cy5wdXNoKHsga2luZDogXCJtb2RlbFwiLCBpdGVtIH0pO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHRoaXMuZ3JvdXBlZFJvd3MgPSByb3dzO1xuXHRcdHRoaXMubW9kZWxSb3dJbmRpY2VzID0gbW9kZWxJbmRpY2VzO1xuXHR9XG5cblx0LyoqXG5cdCAqIE1vdmUgc2VsZWN0ZWRHcm91cEluZGV4IHRvIHBvaW50IGF0IHRoZSBjdXJyZW50IG1vZGVsIChvciBmaXJzdCBtb2RlbCkuXG5cdCAqL1xuXHRwcml2YXRlIGp1bXBUb0N1cnJlbnRNb2RlbCgpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5ncm91cGVkUm93cy5sZW5ndGggPT09IDApIHtcblx0XHRcdHRoaXMuc2VsZWN0ZWRHcm91cEluZGV4ID0gMDtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0Ly8gRmluZCB0aGUgY3VycmVudCBtb2RlbCBpbiBncm91cGVkIHJvd3Ncblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHRoaXMuZ3JvdXBlZFJvd3MubGVuZ3RoOyBpKyspIHtcblx0XHRcdGNvbnN0IHJvdyA9IHRoaXMuZ3JvdXBlZFJvd3NbaV07XG5cdFx0XHRpZiAocm93LmtpbmQgPT09IFwibW9kZWxcIiAmJiBtb2RlbHNBcmVFcXVhbCh0aGlzLmN1cnJlbnRNb2RlbCwgcm93Lml0ZW0ubW9kZWwpKSB7XG5cdFx0XHRcdHRoaXMuc2VsZWN0ZWRHcm91cEluZGV4ID0gaTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdH1cblx0XHQvLyBGYWxsIGJhY2sgdG8gZmlyc3QgbW9kZWwgcm93XG5cdFx0aWYgKHRoaXMubW9kZWxSb3dJbmRpY2VzLmxlbmd0aCA+IDApIHtcblx0XHRcdHRoaXMuc2VsZWN0ZWRHcm91cEluZGV4ID0gdGhpcy5tb2RlbFJvd0luZGljZXNbMF07XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIEdldCB0aGUgY3VycmVudGx5IHNlbGVjdGVkIG1vZGVsIGZyb20gZ3JvdXBlZCBvciBmbGF0IHN0YXRlLlxuXHQgKi9cblx0cHJpdmF0ZSBnZXRTZWxlY3RlZE1vZGVsKCk6IE1vZGVsPGFueT4gfCB1bmRlZmluZWQge1xuXHRcdGlmICh0aGlzLmlzU2VhcmNoaW5nKSB7XG5cdFx0XHRyZXR1cm4gdGhpcy5maWx0ZXJlZE1vZGVsc1t0aGlzLnNlbGVjdGVkRmxhdEluZGV4XT8ubW9kZWw7XG5cdFx0fVxuXHRcdGNvbnN0IHJvdyA9IHRoaXMuZ3JvdXBlZFJvd3NbdGhpcy5zZWxlY3RlZEdyb3VwSW5kZXhdO1xuXHRcdHJldHVybiByb3c/LmtpbmQgPT09IFwibW9kZWxcIiA/IHJvdy5pdGVtLm1vZGVsIDogdW5kZWZpbmVkO1xuXHR9XG5cblx0cHJpdmF0ZSBnZXRTY29wZVRleHQoKTogc3RyaW5nIHtcblx0XHRjb25zdCBhbGxUZXh0ID0gdGhpcy5zY29wZSA9PT0gXCJhbGxcIiA/IHRoZW1lLmZnKFwiYWNjZW50XCIsIFwiYWxsXCIpIDogdGhlbWUuZmcoXCJtdXRlZFwiLCBcImFsbFwiKTtcblx0XHRjb25zdCBzY29wZWRUZXh0ID0gdGhpcy5zY29wZSA9PT0gXCJzY29wZWRcIiA/IHRoZW1lLmZnKFwiYWNjZW50XCIsIFwic2NvcGVkXCIpIDogdGhlbWUuZmcoXCJtdXRlZFwiLCBcInNjb3BlZFwiKTtcblx0XHRyZXR1cm4gYCR7dGhlbWUuZmcoXCJtdXRlZFwiLCBcIlNjb3BlOiBcIil9JHthbGxUZXh0fSR7dGhlbWUuZmcoXCJtdXRlZFwiLCBcIiB8IFwiKX0ke3Njb3BlZFRleHR9YDtcblx0fVxuXG5cdHByaXZhdGUgZ2V0U2NvcGVIaW50VGV4dCgpOiBzdHJpbmcge1xuXHRcdHJldHVybiBrZXlIaW50KFwidGFiXCIsIFwic2NvcGVcIikgKyB0aGVtZS5mZyhcIm11dGVkXCIsIFwiIChhbGwvc2NvcGVkKVwiKTtcblx0fVxuXG5cdHByaXZhdGUgc2V0U2NvcGUoc2NvcGU6IE1vZGVsU2NvcGUpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5zY29wZSA9PT0gc2NvcGUpIHJldHVybjtcblx0XHR0aGlzLnNjb3BlID0gc2NvcGU7XG5cdFx0dGhpcy5hY3RpdmVNb2RlbHMgPSB0aGlzLnNjb3BlID09PSBcInNjb3BlZFwiID8gdGhpcy5zY29wZWRNb2RlbEl0ZW1zIDogdGhpcy5hbGxNb2RlbHM7XG5cblx0XHRpZiAodGhpcy5pc1NlYXJjaGluZykge1xuXHRcdFx0dGhpcy5zZWxlY3RlZEZsYXRJbmRleCA9IDA7XG5cdFx0XHR0aGlzLmZpbHRlck1vZGVscyh0aGlzLnNlYXJjaElucHV0LmdldFZhbHVlKCkpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLmJ1aWxkR3JvdXBlZFJvd3MoKTtcblx0XHRcdHRoaXMuanVtcFRvQ3VycmVudE1vZGVsKCk7XG5cdFx0XHR0aGlzLnVwZGF0ZUxpc3QoKTtcblx0XHR9XG5cblx0XHRpZiAodGhpcy5zY29wZVRleHQpIHtcblx0XHRcdHRoaXMuc2NvcGVUZXh0LnNldFRleHQodGhpcy5nZXRTY29wZVRleHQoKSk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBmaWx0ZXJNb2RlbHMocXVlcnk6IHN0cmluZyk6IHZvaWQge1xuXHRcdHRoaXMuZmlsdGVyZWRNb2RlbHMgPSBxdWVyeVxuXHRcdFx0PyBmdXp6eUZpbHRlcih0aGlzLmFjdGl2ZU1vZGVscywgcXVlcnksICh7IGlkLCBwcm92aWRlciB9KSA9PiBgJHtpZH0gJHtwcm92aWRlcn1gKVxuXHRcdFx0OiB0aGlzLmFjdGl2ZU1vZGVscztcblx0XHR0aGlzLnNlbGVjdGVkRmxhdEluZGV4ID0gTWF0aC5taW4odGhpcy5zZWxlY3RlZEZsYXRJbmRleCwgTWF0aC5tYXgoMCwgdGhpcy5maWx0ZXJlZE1vZGVscy5sZW5ndGggLSAxKSk7XG5cdFx0dGhpcy51cGRhdGVMaXN0KCk7XG5cdH1cblxuXHRwcml2YXRlIHVwZGF0ZUxpc3QoKTogdm9pZCB7XG5cdFx0dGhpcy5saXN0Q29udGFpbmVyLmNsZWFyKCk7XG5cblx0XHRpZiAodGhpcy5lcnJvck1lc3NhZ2UpIHtcblx0XHRcdGNvbnN0IGVycm9yTGluZXMgPSB0aGlzLmVycm9yTWVzc2FnZS5zcGxpdChcIlxcblwiKTtcblx0XHRcdGZvciAoY29uc3QgbGluZSBvZiBlcnJvckxpbmVzKSB7XG5cdFx0XHRcdHRoaXMubGlzdENvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5mZyhcImVycm9yXCIsIGxpbmUpLCAwLCAwKSk7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0aWYgKHRoaXMuaXNTZWFyY2hpbmcpIHtcblx0XHRcdHRoaXMucmVuZGVyRmxhdExpc3QoKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5yZW5kZXJHcm91cGVkTGlzdCgpO1xuXHRcdH1cblx0fVxuXG5cdC8qKiBGbGF0IGZ1enp5LXNlYXJjaCByZXN1bHRzLCBzYW1lIGFzIG9yaWdpbmFsIGJlaGF2aW91ciAqL1xuXHRwcml2YXRlIHJlbmRlckZsYXRMaXN0KCk6IHZvaWQge1xuXHRcdGNvbnN0IG1heFZpc2libGUgPSAxMDtcblxuXHRcdGlmICh0aGlzLmZpbHRlcmVkTW9kZWxzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0dGhpcy5saXN0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBUZXh0KHRoZW1lLmZnKFwibXV0ZWRcIiwgXCIgIE5vIG1hdGNoaW5nIG1vZGVsc1wiKSwgMCwgMCkpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IHN0YXJ0SW5kZXggPSBNYXRoLm1heChcblx0XHRcdDAsXG5cdFx0XHRNYXRoLm1pbihcblx0XHRcdFx0dGhpcy5zZWxlY3RlZEZsYXRJbmRleCAtIE1hdGguZmxvb3IobWF4VmlzaWJsZSAvIDIpLFxuXHRcdFx0XHR0aGlzLmZpbHRlcmVkTW9kZWxzLmxlbmd0aCAtIG1heFZpc2libGUsXG5cdFx0XHQpLFxuXHRcdCk7XG5cdFx0Y29uc3QgZW5kSW5kZXggPSBNYXRoLm1pbihzdGFydEluZGV4ICsgbWF4VmlzaWJsZSwgdGhpcy5maWx0ZXJlZE1vZGVscy5sZW5ndGgpO1xuXG5cdFx0Zm9yIChsZXQgaSA9IHN0YXJ0SW5kZXg7IGkgPCBlbmRJbmRleDsgaSsrKSB7XG5cdFx0XHRjb25zdCBpdGVtID0gdGhpcy5maWx0ZXJlZE1vZGVsc1tpXTtcblx0XHRcdGlmICghaXRlbSkgY29udGludWU7XG5cblx0XHRcdGNvbnN0IGlzU2VsZWN0ZWQgPSBpID09PSB0aGlzLnNlbGVjdGVkRmxhdEluZGV4O1xuXHRcdFx0Y29uc3QgaXNDdXJyZW50ID0gbW9kZWxzQXJlRXF1YWwodGhpcy5jdXJyZW50TW9kZWwsIGl0ZW0ubW9kZWwpO1xuXG5cdFx0XHRjb25zdCBjdHggPSBmb3JtYXRUb2tlbkNvdW50KGl0ZW0ubW9kZWwuY29udGV4dFdpbmRvdyk7XG5cdFx0XHRjb25zdCBjdHhCYWRnZSA9IHRoZW1lLmZnKFwibXV0ZWRcIiwgYCR7Y3R4fWApO1xuXHRcdFx0Y29uc3QgYXV0aE1vZGUgPSB0aGlzLm1vZGVsUmVnaXN0cnkuZ2V0UHJvdmlkZXJBdXRoTW9kZShpdGVtLnByb3ZpZGVyKTtcblx0XHRcdGNvbnN0IGF1dGhMYWJlbCA9IHByb3ZpZGVyQXV0aEJhZGdlKGF1dGhNb2RlKTtcblx0XHRcdGNvbnN0IHByb3ZpZGVyQmFkZ2VUZXh0ID0gYXV0aExhYmVsXG5cdFx0XHRcdD8gYFske3Byb3ZpZGVyRGlzcGxheU5hbWUoaXRlbS5wcm92aWRlcil9IFx1MDBCNyAke2F1dGhMYWJlbH1dYFxuXHRcdFx0XHQ6IGBbJHtwcm92aWRlckRpc3BsYXlOYW1lKGl0ZW0ucHJvdmlkZXIpfV1gO1xuXHRcdFx0Y29uc3QgcHJvdmlkZXJCYWRnZSA9IHRoZW1lLmZnKFwibXV0ZWRcIiwgcHJvdmlkZXJCYWRnZVRleHQpO1xuXHRcdFx0Y29uc3QgY2hlY2ttYXJrID0gaXNDdXJyZW50ID8gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIFwiIFx1MjcxM1wiKSA6IFwiXCI7XG5cblx0XHRcdGxldCBsaW5lOiBzdHJpbmc7XG5cdFx0XHRpZiAoaXNTZWxlY3RlZCkge1xuXHRcdFx0XHRjb25zdCBwcmVmaXggPSB0aGVtZS5mZyhcImFjY2VudFwiLCBcIlx1MjE5MiBcIik7XG5cdFx0XHRcdGxpbmUgPSBgJHtwcmVmaXh9JHt0aGVtZS5mZyhcImFjY2VudFwiLCBpdGVtLmlkKX0gJHtjdHhCYWRnZX0gJHtwcm92aWRlckJhZGdlfSR7Y2hlY2ttYXJrfWA7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRsaW5lID0gYCAgJHtpdGVtLmlkfSAke2N0eEJhZGdlfSAke3Byb3ZpZGVyQmFkZ2V9JHtjaGVja21hcmt9YDtcblx0XHRcdH1cblxuXHRcdFx0dGhpcy5saXN0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBUZXh0KGxpbmUsIDAsIDApKTtcblx0XHR9XG5cblx0XHRpZiAoc3RhcnRJbmRleCA+IDAgfHwgZW5kSW5kZXggPCB0aGlzLmZpbHRlcmVkTW9kZWxzLmxlbmd0aCkge1xuXHRcdFx0dGhpcy5saXN0Q29udGFpbmVyLmFkZENoaWxkKFxuXHRcdFx0XHRuZXcgVGV4dCh0aGVtZS5mZyhcIm11dGVkXCIsIGAgICgke3RoaXMuc2VsZWN0ZWRGbGF0SW5kZXggKyAxfS8ke3RoaXMuZmlsdGVyZWRNb2RlbHMubGVuZ3RofSlgKSwgMCwgMCksXG5cdFx0XHQpO1xuXHRcdH1cblxuXHRcdC8vIERldGFpbCBsaW5lIGZvciBzZWxlY3RlZCBtb2RlbFxuXHRcdGNvbnN0IHNlbGVjdGVkID0gdGhpcy5maWx0ZXJlZE1vZGVsc1t0aGlzLnNlbGVjdGVkRmxhdEluZGV4XTtcblx0XHRpZiAoc2VsZWN0ZWQpIHtcblx0XHRcdHRoaXMubGlzdENvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdHRoaXMubGlzdENvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5mZyhcIm11dGVkXCIsIGAgICR7dGhpcy5tb2RlbERldGFpbExpbmUoc2VsZWN0ZWQubW9kZWwpfWApLCAwLCAwKSk7XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIEdyb3VwZWQgYnJvd3NlIHZpZXc6IHByb3ZpZGVyIGhlYWRlcnMgKyBtb2RlbCByb3dzLCB3aW5kb3dlZCBhcm91bmQgc2VsZWN0aW9uLlxuXHQgKiBTaG93cyBlbm91Z2ggcm93cyB0byBmaWxsIH4xMCB2aXNpYmxlIGxpbmVzOyBoZWFkZXJzIGNvdW50IGFzIG9uZSBsaW5lIGVhY2guXG5cdCAqL1xuXHRwcml2YXRlIHJlbmRlckdyb3VwZWRMaXN0KCk6IHZvaWQge1xuXHRcdGNvbnN0IG1heFZpc2libGUgPSAxMjtcblxuXHRcdGlmICh0aGlzLmdyb3VwZWRSb3dzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0dGhpcy5saXN0Q29udGFpbmVyLmFkZENoaWxkKFxuXHRcdFx0XHRuZXcgVGV4dCh0aGVtZS5mZyhcIm11dGVkXCIsIFwiICBObyBwcm92aWRlcnMgY29uZmlndXJlZC5cIiksIDAsIDApLFxuXHRcdFx0KTtcblx0XHRcdHRoaXMubGlzdENvbnRhaW5lci5hZGRDaGlsZChcblx0XHRcdFx0bmV3IFRleHQoXG5cdFx0XHRcdFx0dGhlbWUuZmcoXG5cdFx0XHRcdFx0XHRcIm11dGVkXCIsXG5cdFx0XHRcdFx0XHRcIiAgUnVuIC9sb2dpbiAoT0F1dGgpLCBzZXQgYW4gQVBJIGtleSwgb3IgaW5zdGFsbCBhIENMSSBwcm92aWRlci4gU2VlIFJFQURNRS5cIixcblx0XHRcdFx0XHQpLFxuXHRcdFx0XHRcdDAsXG5cdFx0XHRcdFx0MCxcblx0XHRcdFx0KSxcblx0XHRcdCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gV2luZG93IGFyb3VuZCBzZWxlY3RlZEdyb3VwSW5kZXhcblx0XHRjb25zdCBzdGFydEluZGV4ID0gTWF0aC5tYXgoXG5cdFx0XHQwLFxuXHRcdFx0TWF0aC5taW4oXG5cdFx0XHRcdHRoaXMuc2VsZWN0ZWRHcm91cEluZGV4IC0gTWF0aC5mbG9vcihtYXhWaXNpYmxlIC8gMiksXG5cdFx0XHRcdHRoaXMuZ3JvdXBlZFJvd3MubGVuZ3RoIC0gbWF4VmlzaWJsZSxcblx0XHRcdCksXG5cdFx0KTtcblx0XHRjb25zdCBlbmRJbmRleCA9IE1hdGgubWluKHN0YXJ0SW5kZXggKyBtYXhWaXNpYmxlLCB0aGlzLmdyb3VwZWRSb3dzLmxlbmd0aCk7XG5cblx0XHRmb3IgKGxldCBpID0gc3RhcnRJbmRleDsgaSA8IGVuZEluZGV4OyBpKyspIHtcblx0XHRcdGNvbnN0IHJvdyA9IHRoaXMuZ3JvdXBlZFJvd3NbaV07XG5cdFx0XHRpZiAoIXJvdykgY29udGludWU7XG5cblx0XHRcdGlmIChyb3cua2luZCA9PT0gXCJoZWFkZXJcIikge1xuXHRcdFx0XHQvLyBQcm92aWRlciBncm91cCBoZWFkZXIgXHUyMDE0IGFsd2F5cyB1bnNlbGVjdGFibGVcblx0XHRcdFx0Y29uc3QgcHJvdmlkZXJMYWJlbCA9IHRoZW1lLmZnKFwiYm9yZGVyQWNjZW50XCIsIHByb3ZpZGVyRGlzcGxheU5hbWUocm93LnByb3ZpZGVyKSk7XG5cdFx0XHRcdGNvbnN0IGNvdW50ID0gdGhlbWUuZmcoXCJtdXRlZFwiLCBgICgke3Jvdy5jb3VudH0pYCk7XG5cdFx0XHRcdGNvbnN0IGF1dGhNb2RlID0gdGhpcy5tb2RlbFJlZ2lzdHJ5LmdldFByb3ZpZGVyQXV0aE1vZGUocm93LnByb3ZpZGVyKTtcblx0XHRcdFx0Y29uc3QgYXV0aExhYmVsID0gcHJvdmlkZXJBdXRoQmFkZ2UoYXV0aE1vZGUpO1xuXHRcdFx0XHRjb25zdCBhdXRoVGV4dCA9IGF1dGhMYWJlbCA/IHRoZW1lLmZnKFwibXV0ZWRcIiwgYCBcdTAwQjcgdmlhICR7YXV0aExhYmVsfWApIDogXCJcIjtcblx0XHRcdFx0Ly8gQWRkIGJsYW5rIGxpbmUgYmVmb3JlIGhlYWRlciBpZiBub3QgdGhlIHZlcnkgZmlyc3QgdmlzaWJsZSByb3dcblx0XHRcdFx0aWYgKGkgPiBzdGFydEluZGV4KSB7XG5cdFx0XHRcdFx0dGhpcy5saXN0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBUZXh0KFwiXCIsIDAsIDApKTtcblx0XHRcdFx0fVxuXHRcdFx0XHR0aGlzLmxpc3RDb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQoYCAgJHtwcm92aWRlckxhYmVsfSR7Y291bnR9JHthdXRoVGV4dH1gLCAwLCAwKSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHQvLyBNb2RlbCByb3dcblx0XHRcdFx0Y29uc3QgaXNTZWxlY3RlZCA9IGkgPT09IHRoaXMuc2VsZWN0ZWRHcm91cEluZGV4O1xuXHRcdFx0XHRjb25zdCBpc0N1cnJlbnQgPSBtb2RlbHNBcmVFcXVhbCh0aGlzLmN1cnJlbnRNb2RlbCwgcm93Lml0ZW0ubW9kZWwpO1xuXG5cdFx0XHRcdGNvbnN0IGN0eCA9IGZvcm1hdFRva2VuQ291bnQocm93Lml0ZW0ubW9kZWwuY29udGV4dFdpbmRvdyk7XG5cdFx0XHRcdGNvbnN0IGN0eEJhZGdlID0gdGhlbWUuZmcoXCJtdXRlZFwiLCBgICR7Y3R4fWApO1xuXHRcdFx0XHRjb25zdCBjaGVja21hcmsgPSBpc0N1cnJlbnQgPyB0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgXCIgXHUyNzEzXCIpIDogXCJcIjtcblxuXHRcdFx0XHRsZXQgbGluZTogc3RyaW5nO1xuXHRcdFx0XHRpZiAoaXNTZWxlY3RlZCkge1xuXHRcdFx0XHRcdGxpbmUgPSBgICAke3RoZW1lLmZnKFwiYWNjZW50XCIsIFwiXHUyMTkyXCIpfSAke3RoZW1lLmZnKFwiYWNjZW50XCIsIHJvdy5pdGVtLmlkKX0ke2N0eEJhZGdlfSR7Y2hlY2ttYXJrfWA7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0bGluZSA9IGAgICAgJHtyb3cuaXRlbS5pZH0ke2N0eEJhZGdlfSR7Y2hlY2ttYXJrfWA7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHR0aGlzLmxpc3RDb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQobGluZSwgMCwgMCkpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIFNjcm9sbCBpbmRpY2F0b3Jcblx0XHRpZiAoc3RhcnRJbmRleCA+IDAgfHwgZW5kSW5kZXggPCB0aGlzLmdyb3VwZWRSb3dzLmxlbmd0aCkge1xuXHRcdFx0Y29uc3QgbW9kZWxQb3MgPSB0aGlzLm1vZGVsUm93SW5kaWNlcy5pbmRleE9mKHRoaXMuc2VsZWN0ZWRHcm91cEluZGV4KSArIDE7XG5cdFx0XHRjb25zdCB0b3RhbE1vZGVscyA9IHRoaXMubW9kZWxSb3dJbmRpY2VzLmxlbmd0aDtcblx0XHRcdHRoaXMubGlzdENvbnRhaW5lci5hZGRDaGlsZChcblx0XHRcdFx0bmV3IFRleHQodGhlbWUuZmcoXCJtdXRlZFwiLCBgICAoJHttb2RlbFBvc30vJHt0b3RhbE1vZGVsc30pYCksIDAsIDApLFxuXHRcdFx0KTtcblx0XHR9XG5cblx0XHQvLyBEZXRhaWwgbGluZSBmb3Igc2VsZWN0ZWQgbW9kZWxcblx0XHRjb25zdCBzZWxlY3RlZE1vZGVsID0gdGhpcy5nZXRTZWxlY3RlZE1vZGVsKCk7XG5cdFx0aWYgKHNlbGVjdGVkTW9kZWwpIHtcblx0XHRcdHRoaXMubGlzdENvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdHRoaXMubGlzdENvbnRhaW5lci5hZGRDaGlsZChcblx0XHRcdFx0bmV3IFRleHQodGhlbWUuZmcoXCJtdXRlZFwiLCBgICAke3RoaXMubW9kZWxEZXRhaWxMaW5lKHNlbGVjdGVkTW9kZWwpfWApLCAwLCAwKSxcblx0XHRcdCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBtb2RlbERldGFpbExpbmUobTogTW9kZWw8YW55Pik6IHN0cmluZyB7XG5cdFx0cmV0dXJuIFtcblx0XHRcdG0ubmFtZSxcblx0XHRcdGBjdHg6ICR7Zm9ybWF0VG9rZW5Db3VudChtLmNvbnRleHRXaW5kb3cpfWAsXG5cdFx0XHRgb3V0OiAke2Zvcm1hdFRva2VuQ291bnQobS5tYXhUb2tlbnMpfWAsXG5cdFx0XHRtLnJlYXNvbmluZyA/IFwidGhpbmtpbmdcIiA6IFwiXCIsXG5cdFx0XHRtLmlucHV0LmluY2x1ZGVzKFwiaW1hZ2VcIikgPyBcInZpc2lvblwiIDogXCJcIixcblx0XHRdXG5cdFx0XHQuZmlsdGVyKEJvb2xlYW4pXG5cdFx0XHQuam9pbihcIiBcdTAwQjcgXCIpO1xuXHR9XG5cblx0aGFuZGxlSW5wdXQoa2V5RGF0YTogc3RyaW5nKTogdm9pZCB7XG5cdFx0Y29uc3Qga2IgPSBnZXRFZGl0b3JLZXliaW5kaW5ncygpO1xuXG5cdFx0Ly8gVGFiOiBzY29wZSB0b2dnbGVcblx0XHRpZiAoa2IubWF0Y2hlcyhrZXlEYXRhLCBcInRhYlwiKSkge1xuXHRcdFx0aWYgKHRoaXMuc2NvcGVkTW9kZWxJdGVtcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdGNvbnN0IG5leHRTY29wZTogTW9kZWxTY29wZSA9IHRoaXMuc2NvcGUgPT09IFwiYWxsXCIgPyBcInNjb3BlZFwiIDogXCJhbGxcIjtcblx0XHRcdFx0dGhpcy5zZXRTY29wZShuZXh0U2NvcGUpO1xuXHRcdFx0XHRpZiAodGhpcy5zY29wZUhpbnRUZXh0KSB7XG5cdFx0XHRcdFx0dGhpcy5zY29wZUhpbnRUZXh0LnNldFRleHQodGhpcy5nZXRTY29wZUhpbnRUZXh0KCkpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gTmF2aWdhdGlvbiBrZXlzXG5cdFx0aWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJzZWxlY3RVcFwiKSkge1xuXHRcdFx0dGhpcy5tb3ZlVXAoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0aWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJzZWxlY3REb3duXCIpKSB7XG5cdFx0XHR0aGlzLm1vdmVEb3duKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gQ29uZmlybVxuXHRcdGlmIChrYi5tYXRjaGVzKGtleURhdGEsIFwic2VsZWN0Q29uZmlybVwiKSkge1xuXHRcdFx0Y29uc3QgbW9kZWwgPSB0aGlzLmdldFNlbGVjdGVkTW9kZWwoKTtcblx0XHRcdGlmIChtb2RlbCkgdGhpcy5oYW5kbGVTZWxlY3QobW9kZWwpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIENhbmNlbFxuXHRcdGlmIChrYi5tYXRjaGVzKGtleURhdGEsIFwic2VsZWN0Q2FuY2VsXCIpKSB7XG5cdFx0XHR0aGlzLm9uQ2FuY2VsQ2FsbGJhY2soKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBFdmVyeXRoaW5nIGVsc2U6IGZlZWQgdG8gc2VhcmNoIGlucHV0XG5cdFx0Y29uc3QgcHJldlF1ZXJ5ID0gdGhpcy5zZWFyY2hJbnB1dC5nZXRWYWx1ZSgpO1xuXHRcdHRoaXMuc2VhcmNoSW5wdXQuaGFuZGxlSW5wdXQoa2V5RGF0YSk7XG5cdFx0Y29uc3QgbmV3UXVlcnkgPSB0aGlzLnNlYXJjaElucHV0LmdldFZhbHVlKCk7XG5cblx0XHRpZiAobmV3UXVlcnkgIT09IHByZXZRdWVyeSkge1xuXHRcdFx0Y29uc3QgZW50ZXJpbmcgPSAhcHJldlF1ZXJ5ICYmICEhbmV3UXVlcnk7XG5cdFx0XHRjb25zdCBsZWF2aW5nID0gISFwcmV2UXVlcnkgJiYgIW5ld1F1ZXJ5O1xuXG5cdFx0XHRpZiAoZW50ZXJpbmcpIHtcblx0XHRcdFx0Ly8gRW50ZXJpbmcgc2VhcmNoIG1vZGU6IHJlbWVtYmVyIGN1cnJlbnQgbW9kZWwgcG9zaXRpb25cblx0XHRcdFx0dGhpcy5pc1NlYXJjaGluZyA9IHRydWU7XG5cdFx0XHRcdHRoaXMuc2VsZWN0ZWRGbGF0SW5kZXggPSAwO1xuXHRcdFx0fSBlbHNlIGlmIChsZWF2aW5nKSB7XG5cdFx0XHRcdC8vIExlYXZpbmcgc2VhcmNoIG1vZGU6IHJldHVybiB0byBncm91cGVkIHZpZXcsIHJlc3RvcmUgcG9zaXRpb25cblx0XHRcdFx0dGhpcy5pc1NlYXJjaGluZyA9IGZhbHNlO1xuXHRcdFx0XHR0aGlzLmJ1aWxkR3JvdXBlZFJvd3MoKTtcblx0XHRcdFx0dGhpcy5qdW1wVG9DdXJyZW50TW9kZWwoKTtcblx0XHRcdH1cblx0XHRcdGlmICh0aGlzLmlzU2VhcmNoaW5nKSB7XG5cdFx0XHRcdHRoaXMuZmlsdGVyTW9kZWxzKG5ld1F1ZXJ5KTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHRoaXMudXBkYXRlTGlzdCgpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdC8qKiBNb3ZlIHNlbGVjdGlvbiB1cCwgc2tpcHBpbmcgaGVhZGVycyBpbiBncm91cGVkIG1vZGUgKi9cblx0cHJpdmF0ZSBtb3ZlVXAoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMuaXNTZWFyY2hpbmcpIHtcblx0XHRcdGlmICh0aGlzLmZpbHRlcmVkTW9kZWxzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuXHRcdFx0dGhpcy5zZWxlY3RlZEZsYXRJbmRleCA9XG5cdFx0XHRcdHRoaXMuc2VsZWN0ZWRGbGF0SW5kZXggPT09IDBcblx0XHRcdFx0XHQ/IHRoaXMuZmlsdGVyZWRNb2RlbHMubGVuZ3RoIC0gMVxuXHRcdFx0XHRcdDogdGhpcy5zZWxlY3RlZEZsYXRJbmRleCAtIDE7XG5cdFx0XHR0aGlzLnVwZGF0ZUxpc3QoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRpZiAodGhpcy5ncm91cGVkUm93cy5sZW5ndGggPT09IDApIHJldHVybjtcblx0XHRsZXQgbmV4dCA9IHRoaXMuc2VsZWN0ZWRHcm91cEluZGV4IC0gMTtcblx0XHQvLyBXcmFwXG5cdFx0aWYgKG5leHQgPCAwKSBuZXh0ID0gdGhpcy5ncm91cGVkUm93cy5sZW5ndGggLSAxO1xuXHRcdC8vIFNraXAgaGVhZGVyc1xuXHRcdHdoaWxlIChuZXh0ID4gMCAmJiB0aGlzLmdyb3VwZWRSb3dzW25leHRdPy5raW5kID09PSBcImhlYWRlclwiKSB7XG5cdFx0XHRuZXh0LS07XG5cdFx0fVxuXHRcdC8vIElmIGxhbmRlZCBvbiBoZWFkZXIgYXQgMCwgd3JhcCB0byBib3R0b21cblx0XHRpZiAodGhpcy5ncm91cGVkUm93c1tuZXh0XT8ua2luZCA9PT0gXCJoZWFkZXJcIikge1xuXHRcdFx0bmV4dCA9IHRoaXMuZ3JvdXBlZFJvd3MubGVuZ3RoIC0gMTtcblx0XHR9XG5cdFx0dGhpcy5zZWxlY3RlZEdyb3VwSW5kZXggPSBuZXh0O1xuXHRcdHRoaXMudXBkYXRlTGlzdCgpO1xuXHR9XG5cblx0LyoqIE1vdmUgc2VsZWN0aW9uIGRvd24sIHNraXBwaW5nIGhlYWRlcnMgaW4gZ3JvdXBlZCBtb2RlICovXG5cdHByaXZhdGUgbW92ZURvd24oKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMuaXNTZWFyY2hpbmcpIHtcblx0XHRcdGlmICh0aGlzLmZpbHRlcmVkTW9kZWxzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuXHRcdFx0dGhpcy5zZWxlY3RlZEZsYXRJbmRleCA9XG5cdFx0XHRcdHRoaXMuc2VsZWN0ZWRGbGF0SW5kZXggPT09IHRoaXMuZmlsdGVyZWRNb2RlbHMubGVuZ3RoIC0gMVxuXHRcdFx0XHRcdD8gMFxuXHRcdFx0XHRcdDogdGhpcy5zZWxlY3RlZEZsYXRJbmRleCArIDE7XG5cdFx0XHR0aGlzLnVwZGF0ZUxpc3QoKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRpZiAodGhpcy5ncm91cGVkUm93cy5sZW5ndGggPT09IDApIHJldHVybjtcblx0XHRsZXQgbmV4dCA9IHRoaXMuc2VsZWN0ZWRHcm91cEluZGV4ICsgMTtcblx0XHQvLyBXcmFwXG5cdFx0aWYgKG5leHQgPj0gdGhpcy5ncm91cGVkUm93cy5sZW5ndGgpIG5leHQgPSAwO1xuXHRcdC8vIFNraXAgaGVhZGVyc1xuXHRcdHdoaWxlIChuZXh0IDwgdGhpcy5ncm91cGVkUm93cy5sZW5ndGggLSAxICYmIHRoaXMuZ3JvdXBlZFJvd3NbbmV4dF0/LmtpbmQgPT09IFwiaGVhZGVyXCIpIHtcblx0XHRcdG5leHQrKztcblx0XHR9XG5cdFx0Ly8gSWYgbGFuZGVkIG9uIGhlYWRlciBhdCBlbmQsIHdyYXAgdG8gZmlyc3QgbW9kZWxcblx0XHRpZiAodGhpcy5ncm91cGVkUm93c1tuZXh0XT8ua2luZCA9PT0gXCJoZWFkZXJcIikge1xuXHRcdFx0bmV4dCA9IHRoaXMubW9kZWxSb3dJbmRpY2VzWzBdID8/IDA7XG5cdFx0fVxuXHRcdHRoaXMuc2VsZWN0ZWRHcm91cEluZGV4ID0gbmV4dDtcblx0XHR0aGlzLnVwZGF0ZUxpc3QoKTtcblx0fVxuXG5cdHByaXZhdGUgaGFuZGxlU2VsZWN0KG1vZGVsOiBNb2RlbDxhbnk+KTogdm9pZCB7XG5cdFx0Ly8gU2F2ZSBhcyBuZXcgZGVmYXVsdFxuXHRcdHRoaXMuc2V0dGluZ3NNYW5hZ2VyLnNldERlZmF1bHRNb2RlbEFuZFByb3ZpZGVyKG1vZGVsLnByb3ZpZGVyLCBtb2RlbC5pZCk7XG5cdFx0dGhpcy5vblNlbGVjdENhbGxiYWNrKG1vZGVsKTtcblx0fVxuXG5cdGdldFNlYXJjaElucHV0KCk6IElucHV0IHtcblx0XHRyZXR1cm4gdGhpcy5zZWFyY2hJbnB1dDtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBQUEsU0FBcUIsc0JBQXNCO0FBQzNDO0FBQUEsRUFDQztBQUFBLEVBRUE7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FFTTtBQUdQLFNBQVMsYUFBYTtBQUN0QixTQUFTLHFCQUFxQjtBQUM5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
