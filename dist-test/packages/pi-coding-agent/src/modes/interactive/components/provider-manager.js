import {
  Container,
  getEditorKeybindings,
  Spacer,
  Text
} from "@gsd/pi-tui";
import { getDiscoverableProviders, getDiscoveryAdapter } from "../../../core/model-discovery.js";
import { providerDisplayName } from "./model-selector.js";
import { ModelsJsonWriter } from "../../../core/models-json-writer.js";
import { theme } from "../theme/theme.js";
import { rawKeyHint } from "./keybinding-hints.js";
class ProviderManagerComponent extends Container {
  constructor(tui, authStorage, modelRegistry, onDone, onDiscover, onSetupAuth) {
    super();
    this._focused = false;
    this.providers = [];
    this.selectedIndex = 0;
    this.confirmingRemove = false;
    this.tui = tui;
    this.authStorage = authStorage;
    this.modelRegistry = modelRegistry;
    this.modelsJsonWriter = new ModelsJsonWriter(this.modelRegistry.modelsJsonPath);
    this.onDone = onDone;
    this.onDiscover = onDiscover;
    this.onSetupAuth = onSetupAuth ?? (() => {
    });
    this.addChild(new Text(theme.fg("accent", "Provider Manager"), 0, 0));
    this.addChild(new Spacer(1));
    this.hintsContainer = new Container();
    this.addChild(this.hintsContainer);
    this.updateHints();
    this.addChild(new Spacer(1));
    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.loadProviders();
    this.updateList();
  }
  get focused() {
    return this._focused;
  }
  set focused(value) {
    this._focused = value;
  }
  loadProviders() {
    const discoverableSet = new Set(getDiscoverableProviders());
    const allModels = this.modelRegistry.getAll();
    const providerModelCounts = /* @__PURE__ */ new Map();
    for (const model of allModels) {
      providerModelCounts.set(model.provider, (providerModelCounts.get(model.provider) ?? 0) + 1);
    }
    const providerNames = /* @__PURE__ */ new Set([
      ...providerModelCounts.keys(),
      ...discoverableSet
    ]);
    this.providers = Array.from(providerNames).sort().map((name) => {
      const providerApis = new Set(
        allModels.filter((m) => m.provider === name).map((m) => m.api).filter((api) => typeof api === "string" && api.length > 0)
      );
      return {
        name,
        hasAuth: this.authStorage.hasAuth(name),
        supportsDiscovery: discoverableSet.has(name) || getDiscoveryAdapter(name, providerApis).supportsDiscovery,
        modelCount: providerModelCounts.get(name) ?? 0
      };
    });
    this.clampSelectedIndex();
  }
  clampSelectedIndex() {
    if (this.providers.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = Math.min(this.selectedIndex, this.providers.length - 1);
  }
  updateHints() {
    this.hintsContainer.clear();
    if (this.confirmingRemove) {
      const hints = [
        rawKeyHint("r", "confirm removal"),
        rawKeyHint("esc", "cancel")
      ].join("  ");
      this.hintsContainer.addChild(new Text(hints, 0, 0));
    } else {
      const hints = [
        rawKeyHint("enter", "setup auth"),
        rawKeyHint("d", "discover"),
        rawKeyHint("r", "remove auth"),
        rawKeyHint("esc", "close")
      ].join("  ");
      this.hintsContainer.addChild(new Text(hints, 0, 0));
    }
  }
  updateList() {
    this.listContainer.clear();
    for (let i = 0; i < this.providers.length; i++) {
      const p = this.providers[i];
      const isSelected = i === this.selectedIndex;
      const authBadge = p.hasAuth ? theme.fg("success", "[auth]") : theme.fg("muted", "[no auth]");
      const discoveryBadge = p.supportsDiscovery ? theme.fg("accent", "[discovery]") : "";
      const countBadge = theme.fg("muted", `(${p.modelCount} models)`);
      const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
      const nameText = isSelected ? theme.fg("accent", providerDisplayName(p.name)) : providerDisplayName(p.name);
      const parts = [prefix, nameText, " ", authBadge];
      if (discoveryBadge) parts.push(" ", discoveryBadge);
      parts.push(" ", countBadge);
      this.listContainer.addChild(new Text(parts.join(""), 0, 0));
    }
    if (this.providers.length === 0) {
      this.listContainer.addChild(new Text(theme.fg("muted", "  No providers configured"), 0, 0));
    }
  }
  handleInput(keyData) {
    const kb = getEditorKeybindings();
    if (kb.matches(keyData, "selectUp")) {
      if (this.providers.length === 0) return;
      this.selectedIndex = this.selectedIndex === 0 ? this.providers.length - 1 : this.selectedIndex - 1;
      this.updateList();
      this.tui.requestRender();
    } else if (kb.matches(keyData, "selectDown")) {
      if (this.providers.length === 0) return;
      this.selectedIndex = this.selectedIndex === this.providers.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
      this.tui.requestRender();
    } else if (kb.matches(keyData, "selectCancel")) {
      if (this.confirmingRemove) {
        this.confirmingRemove = false;
        this.updateHints();
        this.tui.requestRender();
      } else {
        this.onDone();
      }
    } else if (keyData === "d" || keyData === "D") {
      const provider = this.providers[this.selectedIndex];
      if (provider?.supportsDiscovery) {
        this.onDiscover(provider.name);
      }
    } else if (keyData === "r" || keyData === "R") {
      const provider = this.providers[this.selectedIndex];
      if (provider?.hasAuth) {
        if (this.confirmingRemove) {
          this.confirmingRemove = false;
          this.authStorage.remove(provider.name);
          this.modelsJsonWriter.removeProvider(provider.name);
          this.modelRegistry.refresh();
          this.loadProviders();
          this.updateHints();
          this.updateList();
          this.tui.requestRender();
        } else {
          this.confirmingRemove = true;
          this.updateHints();
          this.tui.requestRender();
        }
      }
    } else if (kb.matches(keyData, "selectConfirm")) {
      const provider = this.providers[this.selectedIndex];
      if (provider) {
        this.onSetupAuth(provider.name);
      }
    }
  }
}
export {
  ProviderManagerComponent
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9jb21wb25lbnRzL3Byb3ZpZGVyLW1hbmFnZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVFVJIGNvbXBvbmVudCBmb3IgbWFuYWdpbmcgcHJvdmlkZXIgY29uZmlndXJhdGlvbnMuXG4gKiBTaG93cyBwcm92aWRlcnMgd2l0aCBhdXRoIHN0YXR1cywgZGlzY292ZXJ5IHN1cHBvcnQsIGFuZCBtb2RlbCBjb3VudHMuXG4gKi9cblxuaW1wb3J0IHtcblx0Q29udGFpbmVyLFxuXHR0eXBlIEZvY3VzYWJsZSxcblx0Z2V0RWRpdG9yS2V5YmluZGluZ3MsXG5cdFNwYWNlcixcblx0VGV4dCxcblx0dHlwZSBUVUksXG59IGZyb20gXCJAZ3NkL3BpLXR1aVwiO1xuaW1wb3J0IHR5cGUgeyBBdXRoU3RvcmFnZSB9IGZyb20gXCIuLi8uLi8uLi9jb3JlL2F1dGgtc3RvcmFnZS5qc1wiO1xuaW1wb3J0IHsgZ2V0RGlzY292ZXJhYmxlUHJvdmlkZXJzLCBnZXREaXNjb3ZlcnlBZGFwdGVyIH0gZnJvbSBcIi4uLy4uLy4uL2NvcmUvbW9kZWwtZGlzY292ZXJ5LmpzXCI7XG5pbXBvcnQgeyBwcm92aWRlckRpc3BsYXlOYW1lIH0gZnJvbSBcIi4vbW9kZWwtc2VsZWN0b3IuanNcIjtcbmltcG9ydCB0eXBlIHsgTW9kZWxSZWdpc3RyeSB9IGZyb20gXCIuLi8uLi8uLi9jb3JlL21vZGVsLXJlZ2lzdHJ5LmpzXCI7XG5pbXBvcnQgeyBNb2RlbHNKc29uV3JpdGVyIH0gZnJvbSBcIi4uLy4uLy4uL2NvcmUvbW9kZWxzLWpzb24td3JpdGVyLmpzXCI7XG5pbXBvcnQgeyB0aGVtZSB9IGZyb20gXCIuLi90aGVtZS90aGVtZS5qc1wiO1xuaW1wb3J0IHsgcmF3S2V5SGludCB9IGZyb20gXCIuL2tleWJpbmRpbmctaGludHMuanNcIjtcblxuaW50ZXJmYWNlIFByb3ZpZGVySW5mbyB7XG5cdG5hbWU6IHN0cmluZztcblx0aGFzQXV0aDogYm9vbGVhbjtcblx0c3VwcG9ydHNEaXNjb3Zlcnk6IGJvb2xlYW47XG5cdG1vZGVsQ291bnQ6IG51bWJlcjtcbn1cblxuZXhwb3J0IGNsYXNzIFByb3ZpZGVyTWFuYWdlckNvbXBvbmVudCBleHRlbmRzIENvbnRhaW5lciBpbXBsZW1lbnRzIEZvY3VzYWJsZSB7XG5cdHByaXZhdGUgX2ZvY3VzZWQgPSBmYWxzZTtcblx0Z2V0IGZvY3VzZWQoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuX2ZvY3VzZWQ7XG5cdH1cblx0c2V0IGZvY3VzZWQodmFsdWU6IGJvb2xlYW4pIHtcblx0XHR0aGlzLl9mb2N1c2VkID0gdmFsdWU7XG5cdH1cblxuXHRwcml2YXRlIHByb3ZpZGVyczogUHJvdmlkZXJJbmZvW10gPSBbXTtcblx0cHJpdmF0ZSBzZWxlY3RlZEluZGV4ID0gMDtcblx0cHJpdmF0ZSBsaXN0Q29udGFpbmVyOiBDb250YWluZXI7XG5cdHByaXZhdGUgdHVpOiBUVUk7XG5cdHByaXZhdGUgYXV0aFN0b3JhZ2U6IEF1dGhTdG9yYWdlO1xuXHRwcml2YXRlIG1vZGVsUmVnaXN0cnk6IE1vZGVsUmVnaXN0cnk7XG5cdHByaXZhdGUgbW9kZWxzSnNvbldyaXRlcjogTW9kZWxzSnNvbldyaXRlcjtcblx0cHJpdmF0ZSBvbkRvbmU6ICgpID0+IHZvaWQ7XG5cdHByaXZhdGUgb25EaXNjb3ZlcjogKHByb3ZpZGVyOiBzdHJpbmcpID0+IHZvaWQ7XG5cdHByaXZhdGUgb25TZXR1cEF1dGg6IChwcm92aWRlcjogc3RyaW5nKSA9PiB2b2lkO1xuXHRwcml2YXRlIGNvbmZpcm1pbmdSZW1vdmUgPSBmYWxzZTtcblx0cHJpdmF0ZSBoaW50c0NvbnRhaW5lcjogQ29udGFpbmVyO1xuXG5cdGNvbnN0cnVjdG9yKFxuXHRcdHR1aTogVFVJLFxuXHRcdGF1dGhTdG9yYWdlOiBBdXRoU3RvcmFnZSxcblx0XHRtb2RlbFJlZ2lzdHJ5OiBNb2RlbFJlZ2lzdHJ5LFxuXHRcdG9uRG9uZTogKCkgPT4gdm9pZCxcblx0XHRvbkRpc2NvdmVyOiAocHJvdmlkZXI6IHN0cmluZykgPT4gdm9pZCxcblx0XHRvblNldHVwQXV0aD86IChwcm92aWRlcjogc3RyaW5nKSA9PiB2b2lkLFxuXHQpIHtcblx0XHRzdXBlcigpO1xuXG5cdFx0dGhpcy50dWkgPSB0dWk7XG5cdFx0dGhpcy5hdXRoU3RvcmFnZSA9IGF1dGhTdG9yYWdlO1xuXHRcdHRoaXMubW9kZWxSZWdpc3RyeSA9IG1vZGVsUmVnaXN0cnk7XG5cdFx0dGhpcy5tb2RlbHNKc29uV3JpdGVyID0gbmV3IE1vZGVsc0pzb25Xcml0ZXIodGhpcy5tb2RlbFJlZ2lzdHJ5Lm1vZGVsc0pzb25QYXRoKTtcblx0XHR0aGlzLm9uRG9uZSA9IG9uRG9uZTtcblx0XHR0aGlzLm9uRGlzY292ZXIgPSBvbkRpc2NvdmVyO1xuXHRcdHRoaXMub25TZXR1cEF1dGggPSBvblNldHVwQXV0aCA/PyAoKCkgPT4ge30pO1xuXG5cdFx0Ly8gSGVhZGVyXG5cdFx0dGhpcy5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5mZyhcImFjY2VudFwiLCBcIlByb3ZpZGVyIE1hbmFnZXJcIiksIDAsIDApKTtcblx0XHR0aGlzLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXG5cdFx0Ly8gSGludHNcblx0XHR0aGlzLmhpbnRzQ29udGFpbmVyID0gbmV3IENvbnRhaW5lcigpO1xuXHRcdHRoaXMuYWRkQ2hpbGQodGhpcy5oaW50c0NvbnRhaW5lcik7XG5cdFx0dGhpcy51cGRhdGVIaW50cygpO1xuXHRcdHRoaXMuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cblx0XHQvLyBMaXN0XG5cdFx0dGhpcy5saXN0Q29udGFpbmVyID0gbmV3IENvbnRhaW5lcigpO1xuXHRcdHRoaXMuYWRkQ2hpbGQodGhpcy5saXN0Q29udGFpbmVyKTtcblxuXHRcdHRoaXMubG9hZFByb3ZpZGVycygpO1xuXHRcdHRoaXMudXBkYXRlTGlzdCgpO1xuXHR9XG5cblx0cHJpdmF0ZSBsb2FkUHJvdmlkZXJzKCk6IHZvaWQge1xuXHRcdGNvbnN0IGRpc2NvdmVyYWJsZVNldCA9IG5ldyBTZXQoZ2V0RGlzY292ZXJhYmxlUHJvdmlkZXJzKCkpO1xuXHRcdGNvbnN0IGFsbE1vZGVscyA9IHRoaXMubW9kZWxSZWdpc3RyeS5nZXRBbGwoKTtcblxuXHRcdC8vIEdyb3VwIG1vZGVscyBieSBwcm92aWRlclxuXHRcdGNvbnN0IHByb3ZpZGVyTW9kZWxDb3VudHMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuXHRcdGZvciAoY29uc3QgbW9kZWwgb2YgYWxsTW9kZWxzKSB7XG5cdFx0XHRwcm92aWRlck1vZGVsQ291bnRzLnNldChtb2RlbC5wcm92aWRlciwgKHByb3ZpZGVyTW9kZWxDb3VudHMuZ2V0KG1vZGVsLnByb3ZpZGVyKSA/PyAwKSArIDEpO1xuXHRcdH1cblxuXHRcdC8vIEJ1aWxkIHByb3ZpZGVyIGxpc3QgZnJvbSBhbGwga25vd24gcHJvdmlkZXJzXG5cdFx0Y29uc3QgcHJvdmlkZXJOYW1lcyA9IG5ldyBTZXQoW1xuXHRcdFx0Li4ucHJvdmlkZXJNb2RlbENvdW50cy5rZXlzKCksXG5cdFx0XHQuLi5kaXNjb3ZlcmFibGVTZXQsXG5cdFx0XSk7XG5cblx0XHR0aGlzLnByb3ZpZGVycyA9IEFycmF5LmZyb20ocHJvdmlkZXJOYW1lcylcblx0XHRcdC5zb3J0KClcblx0XHRcdC5tYXAoKG5hbWUpID0+IHtcblx0XHRcdFx0Y29uc3QgcHJvdmlkZXJBcGlzID0gbmV3IFNldChcblx0XHRcdFx0XHRhbGxNb2RlbHNcblx0XHRcdFx0XHRcdC5maWx0ZXIoKG0pID0+IG0ucHJvdmlkZXIgPT09IG5hbWUpXG5cdFx0XHRcdFx0XHQubWFwKChtKSA9PiBtLmFwaSlcblx0XHRcdFx0XHRcdC5maWx0ZXIoKGFwaSk6IGFwaSBpcyBzdHJpbmcgPT4gdHlwZW9mIGFwaSA9PT0gXCJzdHJpbmdcIiAmJiBhcGkubGVuZ3RoID4gMCksXG5cdFx0XHRcdCk7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0bmFtZSxcblx0XHRcdFx0XHRoYXNBdXRoOiB0aGlzLmF1dGhTdG9yYWdlLmhhc0F1dGgobmFtZSksXG5cdFx0XHRcdFx0c3VwcG9ydHNEaXNjb3Zlcnk6XG5cdFx0XHRcdFx0XHRkaXNjb3ZlcmFibGVTZXQuaGFzKG5hbWUpIHx8IGdldERpc2NvdmVyeUFkYXB0ZXIobmFtZSwgcHJvdmlkZXJBcGlzKS5zdXBwb3J0c0Rpc2NvdmVyeSxcblx0XHRcdFx0XHRtb2RlbENvdW50OiBwcm92aWRlck1vZGVsQ291bnRzLmdldChuYW1lKSA/PyAwLFxuXHRcdFx0XHR9O1xuXHRcdFx0fSk7XG5cdFx0dGhpcy5jbGFtcFNlbGVjdGVkSW5kZXgoKTtcblx0fVxuXG5cdHByaXZhdGUgY2xhbXBTZWxlY3RlZEluZGV4KCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLnByb3ZpZGVycy5sZW5ndGggPT09IDApIHtcblx0XHRcdHRoaXMuc2VsZWN0ZWRJbmRleCA9IDA7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdHRoaXMuc2VsZWN0ZWRJbmRleCA9IE1hdGgubWluKHRoaXMuc2VsZWN0ZWRJbmRleCwgdGhpcy5wcm92aWRlcnMubGVuZ3RoIC0gMSk7XG5cdH1cblxuXHRwcml2YXRlIHVwZGF0ZUhpbnRzKCk6IHZvaWQge1xuXHRcdHRoaXMuaGludHNDb250YWluZXIuY2xlYXIoKTtcblx0XHRpZiAodGhpcy5jb25maXJtaW5nUmVtb3ZlKSB7XG5cdFx0XHRjb25zdCBoaW50cyA9IFtcblx0XHRcdFx0cmF3S2V5SGludChcInJcIiwgXCJjb25maXJtIHJlbW92YWxcIiksXG5cdFx0XHRcdHJhd0tleUhpbnQoXCJlc2NcIiwgXCJjYW5jZWxcIiksXG5cdFx0XHRdLmpvaW4oXCIgIFwiKTtcblx0XHRcdHRoaXMuaGludHNDb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQoaGludHMsIDAsIDApKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc3QgaGludHMgPSBbXG5cdFx0XHRcdHJhd0tleUhpbnQoXCJlbnRlclwiLCBcInNldHVwIGF1dGhcIiksXG5cdFx0XHRcdHJhd0tleUhpbnQoXCJkXCIsIFwiZGlzY292ZXJcIiksXG5cdFx0XHRcdHJhd0tleUhpbnQoXCJyXCIsIFwicmVtb3ZlIGF1dGhcIiksXG5cdFx0XHRcdHJhd0tleUhpbnQoXCJlc2NcIiwgXCJjbG9zZVwiKSxcblx0XHRcdF0uam9pbihcIiAgXCIpO1xuXHRcdFx0dGhpcy5oaW50c0NvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dChoaW50cywgMCwgMCkpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgdXBkYXRlTGlzdCgpOiB2b2lkIHtcblx0XHR0aGlzLmxpc3RDb250YWluZXIuY2xlYXIoKTtcblxuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgdGhpcy5wcm92aWRlcnMubGVuZ3RoOyBpKyspIHtcblx0XHRcdGNvbnN0IHAgPSB0aGlzLnByb3ZpZGVyc1tpXTtcblx0XHRcdGNvbnN0IGlzU2VsZWN0ZWQgPSBpID09PSB0aGlzLnNlbGVjdGVkSW5kZXg7XG5cblx0XHRcdGNvbnN0IGF1dGhCYWRnZSA9IHAuaGFzQXV0aCA/IHRoZW1lLmZnKFwic3VjY2Vzc1wiLCBcIlthdXRoXVwiKSA6IHRoZW1lLmZnKFwibXV0ZWRcIiwgXCJbbm8gYXV0aF1cIik7XG5cdFx0XHRjb25zdCBkaXNjb3ZlcnlCYWRnZSA9IHAuc3VwcG9ydHNEaXNjb3ZlcnkgPyB0aGVtZS5mZyhcImFjY2VudFwiLCBcIltkaXNjb3ZlcnldXCIpIDogXCJcIjtcblx0XHRcdGNvbnN0IGNvdW50QmFkZ2UgPSB0aGVtZS5mZyhcIm11dGVkXCIsIGAoJHtwLm1vZGVsQ291bnR9IG1vZGVscylgKTtcblxuXHRcdFx0Y29uc3QgcHJlZml4ID0gaXNTZWxlY3RlZCA/IHRoZW1lLmZnKFwiYWNjZW50XCIsIFwiPiBcIikgOiBcIiAgXCI7XG5cdFx0XHRjb25zdCBuYW1lVGV4dCA9IGlzU2VsZWN0ZWQgPyB0aGVtZS5mZyhcImFjY2VudFwiLCBwcm92aWRlckRpc3BsYXlOYW1lKHAubmFtZSkpIDogcHJvdmlkZXJEaXNwbGF5TmFtZShwLm5hbWUpO1xuXG5cdFx0XHRjb25zdCBwYXJ0cyA9IFtwcmVmaXgsIG5hbWVUZXh0LCBcIiBcIiwgYXV0aEJhZGdlXTtcblx0XHRcdGlmIChkaXNjb3ZlcnlCYWRnZSkgcGFydHMucHVzaChcIiBcIiwgZGlzY292ZXJ5QmFkZ2UpO1xuXHRcdFx0cGFydHMucHVzaChcIiBcIiwgY291bnRCYWRnZSk7XG5cblx0XHRcdHRoaXMubGlzdENvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dChwYXJ0cy5qb2luKFwiXCIpLCAwLCAwKSk7XG5cdFx0fVxuXG5cdFx0aWYgKHRoaXMucHJvdmlkZXJzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0dGhpcy5saXN0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBUZXh0KHRoZW1lLmZnKFwibXV0ZWRcIiwgXCIgIE5vIHByb3ZpZGVycyBjb25maWd1cmVkXCIpLCAwLCAwKSk7XG5cdFx0fVxuXHR9XG5cblx0aGFuZGxlSW5wdXQoa2V5RGF0YTogc3RyaW5nKTogdm9pZCB7XG5cdFx0Y29uc3Qga2IgPSBnZXRFZGl0b3JLZXliaW5kaW5ncygpO1xuXG5cdFx0aWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJzZWxlY3RVcFwiKSkge1xuXHRcdFx0aWYgKHRoaXMucHJvdmlkZXJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuXHRcdFx0dGhpcy5zZWxlY3RlZEluZGV4ID0gdGhpcy5zZWxlY3RlZEluZGV4ID09PSAwID8gdGhpcy5wcm92aWRlcnMubGVuZ3RoIC0gMSA6IHRoaXMuc2VsZWN0ZWRJbmRleCAtIDE7XG5cdFx0XHR0aGlzLnVwZGF0ZUxpc3QoKTtcblx0XHRcdHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHR9IGVsc2UgaWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJzZWxlY3REb3duXCIpKSB7XG5cdFx0XHRpZiAodGhpcy5wcm92aWRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cdFx0XHR0aGlzLnNlbGVjdGVkSW5kZXggPSB0aGlzLnNlbGVjdGVkSW5kZXggPT09IHRoaXMucHJvdmlkZXJzLmxlbmd0aCAtIDEgPyAwIDogdGhpcy5zZWxlY3RlZEluZGV4ICsgMTtcblx0XHRcdHRoaXMudXBkYXRlTGlzdCgpO1xuXHRcdFx0dGhpcy50dWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdH0gZWxzZSBpZiAoa2IubWF0Y2hlcyhrZXlEYXRhLCBcInNlbGVjdENhbmNlbFwiKSkge1xuXHRcdFx0aWYgKHRoaXMuY29uZmlybWluZ1JlbW92ZSkge1xuXHRcdFx0XHR0aGlzLmNvbmZpcm1pbmdSZW1vdmUgPSBmYWxzZTtcblx0XHRcdFx0dGhpcy51cGRhdGVIaW50cygpO1xuXHRcdFx0XHR0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHR0aGlzLm9uRG9uZSgpO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAoa2V5RGF0YSA9PT0gXCJkXCIgfHwga2V5RGF0YSA9PT0gXCJEXCIpIHtcblx0XHRcdGNvbnN0IHByb3ZpZGVyID0gdGhpcy5wcm92aWRlcnNbdGhpcy5zZWxlY3RlZEluZGV4XTtcblx0XHRcdGlmIChwcm92aWRlcj8uc3VwcG9ydHNEaXNjb3ZlcnkpIHtcblx0XHRcdFx0dGhpcy5vbkRpc2NvdmVyKHByb3ZpZGVyLm5hbWUpO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAoa2V5RGF0YSA9PT0gXCJyXCIgfHwga2V5RGF0YSA9PT0gXCJSXCIpIHtcblx0XHRcdGNvbnN0IHByb3ZpZGVyID0gdGhpcy5wcm92aWRlcnNbdGhpcy5zZWxlY3RlZEluZGV4XTtcblx0XHRcdGlmIChwcm92aWRlcj8uaGFzQXV0aCkge1xuXHRcdFx0XHRpZiAodGhpcy5jb25maXJtaW5nUmVtb3ZlKSB7XG5cdFx0XHRcdFx0dGhpcy5jb25maXJtaW5nUmVtb3ZlID0gZmFsc2U7XG5cdFx0XHRcdFx0dGhpcy5hdXRoU3RvcmFnZS5yZW1vdmUocHJvdmlkZXIubmFtZSk7XG5cdFx0XHRcdFx0dGhpcy5tb2RlbHNKc29uV3JpdGVyLnJlbW92ZVByb3ZpZGVyKHByb3ZpZGVyLm5hbWUpO1xuXHRcdFx0XHRcdHRoaXMubW9kZWxSZWdpc3RyeS5yZWZyZXNoKCk7XG5cdFx0XHRcdFx0dGhpcy5sb2FkUHJvdmlkZXJzKCk7XG5cdFx0XHRcdFx0dGhpcy51cGRhdGVIaW50cygpO1xuXHRcdFx0XHRcdHRoaXMudXBkYXRlTGlzdCgpO1xuXHRcdFx0XHRcdHRoaXMudHVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHR0aGlzLmNvbmZpcm1pbmdSZW1vdmUgPSB0cnVlO1xuXHRcdFx0XHRcdHRoaXMudXBkYXRlSGludHMoKTtcblx0XHRcdFx0XHR0aGlzLnR1aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKGtiLm1hdGNoZXMoa2V5RGF0YSwgXCJzZWxlY3RDb25maXJtXCIpKSB7XG5cdFx0XHQvLyBFbnRlciBrZXkgXHUyMTkyIGluaXRpYXRlIGF1dGggc2V0dXAgZm9yIHRoZSBzZWxlY3RlZCBwcm92aWRlciAoIzM1NzkpXG5cdFx0XHRjb25zdCBwcm92aWRlciA9IHRoaXMucHJvdmlkZXJzW3RoaXMuc2VsZWN0ZWRJbmRleF07XG5cdFx0XHRpZiAocHJvdmlkZXIpIHtcblx0XHRcdFx0dGhpcy5vblNldHVwQXV0aChwcm92aWRlci5uYW1lKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUtBO0FBQUEsRUFDQztBQUFBLEVBRUE7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BRU07QUFFUCxTQUFTLDBCQUEwQiwyQkFBMkI7QUFDOUQsU0FBUywyQkFBMkI7QUFFcEMsU0FBUyx3QkFBd0I7QUFDakMsU0FBUyxhQUFhO0FBQ3RCLFNBQVMsa0JBQWtCO0FBU3BCLE1BQU0saUNBQWlDLFVBQStCO0FBQUEsRUFzQjVFLFlBQ0Ms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
