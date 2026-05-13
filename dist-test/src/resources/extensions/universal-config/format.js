function formatDiscoveryForTool(result) {
  const lines = [];
  const { summary } = result;
  lines.push(`Universal Config Discovery \u2014 ${summary.toolsWithConfig}/${summary.toolsScanned} tools with config (${result.durationMs}ms)`);
  lines.push("");
  if (summary.totalItems === 0) {
    lines.push("No configuration found from any AI coding tool.");
    lines.push("");
    lines.push("Scanned for: Claude Code, Cursor, Windsurf, Gemini CLI, Codex, Cline, GitHub Copilot, VS Code");
    return lines.join("\n");
  }
  lines.push(`Found: ${summary.mcpServers} MCP server(s), ${summary.rules} rule(s), ${summary.contextFiles} context file(s), ${summary.settings} settings file(s), ${summary.claudeSkills} Claude skill(s), ${summary.claudePlugins} Claude plugin(s)`);
  lines.push("");
  for (const toolResult of result.tools) {
    if (toolResult.items.length === 0) continue;
    lines.push(`## ${toolResult.tool.name}`);
    const byType = groupByType(toolResult.items);
    if (byType["mcp-server"]?.length) {
      lines.push(`  MCP Servers (${byType["mcp-server"].length}):`);
      for (const item of byType["mcp-server"]) {
        if (item.type !== "mcp-server") continue;
        const transport = item.transport ?? (item.url ? "http" : item.command ? "stdio" : "unknown");
        const detail = item.command ? `${item.command}${item.args?.length ? ` ${item.args.join(" ")}` : ""}` : item.url ?? "no endpoint";
        lines.push(`    - ${item.name} [${transport}] ${detail} (${item.source.level})`);
      }
    }
    if (byType.rule?.length) {
      lines.push(`  Rules (${byType.rule.length}):`);
      for (const item of byType.rule) {
        if (item.type !== "rule") continue;
        const meta = [];
        if (item.alwaysApply) meta.push("always");
        if (item.globs?.length) meta.push(`globs: ${item.globs.join(", ")}`);
        const suffix = meta.length ? ` [${meta.join(", ")}]` : "";
        const preview = item.content.slice(0, 80).replace(/\n/g, " ").trim();
        lines.push(`    - ${item.name}${suffix}: ${preview}${item.content.length > 80 ? "..." : ""}`);
      }
    }
    if (byType["context-file"]?.length) {
      lines.push(`  Context Files (${byType["context-file"].length}):`);
      for (const item of byType["context-file"]) {
        if (item.type !== "context-file") continue;
        const size = item.content.length;
        lines.push(`    - ${item.name} (${size} chars, ${item.source.level}) ${item.source.path}`);
      }
    }
    if (byType.settings?.length) {
      lines.push(`  Settings (${byType.settings.length}):`);
      for (const item of byType.settings) {
        if (item.type !== "settings") continue;
        lines.push(`    - ${item.source.path} (${item.source.level})`);
      }
    }
    if (byType["claude-skill"]?.length) {
      lines.push(`  Claude Skills (${byType["claude-skill"].length}):`);
      for (const item of byType["claude-skill"]) {
        if (item.type !== "claude-skill") continue;
        lines.push(`    - ${item.name} (${item.source.level}) ${item.path}`);
      }
    }
    if (byType["claude-plugin"]?.length) {
      lines.push(`  Claude Plugins (${byType["claude-plugin"].length}):`);
      for (const item of byType["claude-plugin"]) {
        if (item.type !== "claude-plugin") continue;
        const label = item.packageName ? `${item.name} [${item.packageName}]` : item.name;
        lines.push(`    - ${label} (${item.source.level}) ${item.path}`);
      }
    }
    lines.push("");
  }
  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const w of result.warnings) {
      lines.push(`  - ${w}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
function formatDiscoveryForCommand(result) {
  const lines = [];
  const { summary } = result;
  lines.push(`--- Universal Config Discovery ---`);
  lines.push(`${summary.toolsWithConfig} of ${summary.toolsScanned} tools have configuration`);
  lines.push(`${summary.totalItems} total items discovered in ${result.durationMs}ms`);
  lines.push("");
  if (summary.totalItems === 0) {
    lines.push("No configuration found.");
    return lines;
  }
  lines.push(`  MCP Servers: ${summary.mcpServers}`);
  lines.push(`  Rules:       ${summary.rules}`);
  lines.push(`  Context:     ${summary.contextFiles}`);
  lines.push(`  Settings:    ${summary.settings}`);
  lines.push(`  Claude skills: ${summary.claudeSkills}`);
  lines.push(`  Claude plugins: ${summary.claudePlugins}`);
  lines.push("");
  for (const toolResult of result.tools) {
    if (toolResult.items.length === 0) continue;
    const counts = countByType(toolResult.items);
    const parts = [];
    if (counts["mcp-server"]) parts.push(`${counts["mcp-server"]} MCP`);
    if (counts.rule) parts.push(`${counts.rule} rules`);
    if (counts["context-file"]) parts.push(`${counts["context-file"]} context`);
    if (counts.settings) parts.push(`${counts.settings} settings`);
    if (counts["claude-skill"]) parts.push(`${counts["claude-skill"]} Claude skills`);
    if (counts["claude-plugin"]) parts.push(`${counts["claude-plugin"]} Claude plugins`);
    lines.push(`  ${toolResult.tool.name}: ${parts.join(", ")}`);
    const servers = toolResult.items.filter((i) => i.type === "mcp-server");
    for (const server of servers) {
      if (server.type !== "mcp-server") continue;
      lines.push(`    MCP: ${server.name} (${server.source.level})`);
    }
    const claudeSkills = toolResult.items.filter((i) => i.type === "claude-skill");
    for (const skill of claudeSkills) {
      if (skill.type !== "claude-skill") continue;
      lines.push(`    Skill: ${skill.name} (${skill.source.level})`);
    }
    const claudePlugins = toolResult.items.filter((i) => i.type === "claude-plugin");
    for (const plugin of claudePlugins) {
      if (plugin.type !== "claude-plugin") continue;
      lines.push(`    Plugin: ${plugin.name} (${plugin.source.level})`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push(`${result.warnings.length} warning(s) \u2014 run discover_configs tool for details`);
  }
  return lines;
}
function groupByType(items) {
  const groups = {};
  for (const item of items) {
    (groups[item.type] ??= []).push(item);
  }
  return groups;
}
function countByType(items) {
  const counts = {};
  for (const item of items) {
    counts[item.type] = (counts[item.type] ?? 0) + 1;
  }
  return counts;
}
export {
  formatDiscoveryForCommand,
  formatDiscoveryForTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3VuaXZlcnNhbC1jb25maWcvZm9ybWF0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFVuaXZlcnNhbCBDb25maWcgRGlzY292ZXJ5IFx1MjAxNCBvdXRwdXQgZm9ybWF0dGluZ1xuICpcbiAqIEZvcm1hdHMgRGlzY292ZXJ5UmVzdWx0IGludG8gaHVtYW4tcmVhZGFibGUgYW5kIExMTS1yZWFkYWJsZSBvdXRwdXQuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBEaXNjb3ZlcnlSZXN1bHQsIERpc2NvdmVyZWRJdGVtLCBUb29sRGlzY292ZXJ5UmVzdWx0IH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcblxuLyoqXG4gKiBGb3JtYXQgZGlzY292ZXJ5IHJlc3VsdCBhcyBhIGNvbXBhY3QgdGV4dCByZXBvcnQgZm9yIHRoZSBMTE0gdG9vbCByZXNwb25zZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdERpc2NvdmVyeUZvclRvb2wocmVzdWx0OiBEaXNjb3ZlcnlSZXN1bHQpOiBzdHJpbmcge1xuICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgeyBzdW1tYXJ5IH0gPSByZXN1bHQ7XG5cbiAgbGluZXMucHVzaChgVW5pdmVyc2FsIENvbmZpZyBEaXNjb3ZlcnkgXHUyMDE0ICR7c3VtbWFyeS50b29sc1dpdGhDb25maWd9LyR7c3VtbWFyeS50b29sc1NjYW5uZWR9IHRvb2xzIHdpdGggY29uZmlnICgke3Jlc3VsdC5kdXJhdGlvbk1zfW1zKWApO1xuICBsaW5lcy5wdXNoKFwiXCIpO1xuXG4gIGlmIChzdW1tYXJ5LnRvdGFsSXRlbXMgPT09IDApIHtcbiAgICBsaW5lcy5wdXNoKFwiTm8gY29uZmlndXJhdGlvbiBmb3VuZCBmcm9tIGFueSBBSSBjb2RpbmcgdG9vbC5cIik7XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgICBsaW5lcy5wdXNoKFwiU2Nhbm5lZCBmb3I6IENsYXVkZSBDb2RlLCBDdXJzb3IsIFdpbmRzdXJmLCBHZW1pbmkgQ0xJLCBDb2RleCwgQ2xpbmUsIEdpdEh1YiBDb3BpbG90LCBWUyBDb2RlXCIpO1xuICAgIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xuICB9XG5cbiAgbGluZXMucHVzaChgRm91bmQ6ICR7c3VtbWFyeS5tY3BTZXJ2ZXJzfSBNQ1Agc2VydmVyKHMpLCAke3N1bW1hcnkucnVsZXN9IHJ1bGUocyksICR7c3VtbWFyeS5jb250ZXh0RmlsZXN9IGNvbnRleHQgZmlsZShzKSwgJHtzdW1tYXJ5LnNldHRpbmdzfSBzZXR0aW5ncyBmaWxlKHMpLCAke3N1bW1hcnkuY2xhdWRlU2tpbGxzfSBDbGF1ZGUgc2tpbGwocyksICR7c3VtbWFyeS5jbGF1ZGVQbHVnaW5zfSBDbGF1ZGUgcGx1Z2luKHMpYCk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgZm9yIChjb25zdCB0b29sUmVzdWx0IG9mIHJlc3VsdC50b29scykge1xuICAgIGlmICh0b29sUmVzdWx0Lml0ZW1zLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgbGluZXMucHVzaChgIyMgJHt0b29sUmVzdWx0LnRvb2wubmFtZX1gKTtcblxuICAgIGNvbnN0IGJ5VHlwZSA9IGdyb3VwQnlUeXBlKHRvb2xSZXN1bHQuaXRlbXMpO1xuXG4gICAgaWYgKGJ5VHlwZVtcIm1jcC1zZXJ2ZXJcIl0/Lmxlbmd0aCkge1xuICAgICAgbGluZXMucHVzaChgICBNQ1AgU2VydmVycyAoJHtieVR5cGVbXCJtY3Atc2VydmVyXCJdLmxlbmd0aH0pOmApO1xuICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGJ5VHlwZVtcIm1jcC1zZXJ2ZXJcIl0pIHtcbiAgICAgICAgaWYgKGl0ZW0udHlwZSAhPT0gXCJtY3Atc2VydmVyXCIpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCB0cmFuc3BvcnQgPSBpdGVtLnRyYW5zcG9ydCA/PyAoaXRlbS51cmwgPyBcImh0dHBcIiA6IGl0ZW0uY29tbWFuZCA/IFwic3RkaW9cIiA6IFwidW5rbm93blwiKTtcbiAgICAgICAgY29uc3QgZGV0YWlsID0gaXRlbS5jb21tYW5kXG4gICAgICAgICAgPyBgJHtpdGVtLmNvbW1hbmR9JHtpdGVtLmFyZ3M/Lmxlbmd0aCA/IGAgJHtpdGVtLmFyZ3Muam9pbihcIiBcIil9YCA6IFwiXCJ9YFxuICAgICAgICAgIDogaXRlbS51cmwgPz8gXCJubyBlbmRwb2ludFwiO1xuICAgICAgICBsaW5lcy5wdXNoKGAgICAgLSAke2l0ZW0ubmFtZX0gWyR7dHJhbnNwb3J0fV0gJHtkZXRhaWx9ICgke2l0ZW0uc291cmNlLmxldmVsfSlgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoYnlUeXBlLnJ1bGU/Lmxlbmd0aCkge1xuICAgICAgbGluZXMucHVzaChgICBSdWxlcyAoJHtieVR5cGUucnVsZS5sZW5ndGh9KTpgKTtcbiAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBieVR5cGUucnVsZSkge1xuICAgICAgICBpZiAoaXRlbS50eXBlICE9PSBcInJ1bGVcIikgY29udGludWU7XG4gICAgICAgIGNvbnN0IG1ldGE6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGlmIChpdGVtLmFsd2F5c0FwcGx5KSBtZXRhLnB1c2goXCJhbHdheXNcIik7XG4gICAgICAgIGlmIChpdGVtLmdsb2JzPy5sZW5ndGgpIG1ldGEucHVzaChgZ2xvYnM6ICR7aXRlbS5nbG9icy5qb2luKFwiLCBcIil9YCk7XG4gICAgICAgIGNvbnN0IHN1ZmZpeCA9IG1ldGEubGVuZ3RoID8gYCBbJHttZXRhLmpvaW4oXCIsIFwiKX1dYCA6IFwiXCI7XG4gICAgICAgIGNvbnN0IHByZXZpZXcgPSBpdGVtLmNvbnRlbnQuc2xpY2UoMCwgODApLnJlcGxhY2UoL1xcbi9nLCBcIiBcIikudHJpbSgpO1xuICAgICAgICBsaW5lcy5wdXNoKGAgICAgLSAke2l0ZW0ubmFtZX0ke3N1ZmZpeH06ICR7cHJldmlld30ke2l0ZW0uY29udGVudC5sZW5ndGggPiA4MCA/IFwiLi4uXCIgOiBcIlwifWApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChieVR5cGVbXCJjb250ZXh0LWZpbGVcIl0/Lmxlbmd0aCkge1xuICAgICAgbGluZXMucHVzaChgICBDb250ZXh0IEZpbGVzICgke2J5VHlwZVtcImNvbnRleHQtZmlsZVwiXS5sZW5ndGh9KTpgKTtcbiAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBieVR5cGVbXCJjb250ZXh0LWZpbGVcIl0pIHtcbiAgICAgICAgaWYgKGl0ZW0udHlwZSAhPT0gXCJjb250ZXh0LWZpbGVcIikgY29udGludWU7XG4gICAgICAgIGNvbnN0IHNpemUgPSBpdGVtLmNvbnRlbnQubGVuZ3RoO1xuICAgICAgICBsaW5lcy5wdXNoKGAgICAgLSAke2l0ZW0ubmFtZX0gKCR7c2l6ZX0gY2hhcnMsICR7aXRlbS5zb3VyY2UubGV2ZWx9KSAke2l0ZW0uc291cmNlLnBhdGh9YCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGJ5VHlwZS5zZXR0aW5ncz8ubGVuZ3RoKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIFNldHRpbmdzICgke2J5VHlwZS5zZXR0aW5ncy5sZW5ndGh9KTpgKTtcbiAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBieVR5cGUuc2V0dGluZ3MpIHtcbiAgICAgICAgaWYgKGl0ZW0udHlwZSAhPT0gXCJzZXR0aW5nc1wiKSBjb250aW51ZTtcbiAgICAgICAgbGluZXMucHVzaChgICAgIC0gJHtpdGVtLnNvdXJjZS5wYXRofSAoJHtpdGVtLnNvdXJjZS5sZXZlbH0pYCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGJ5VHlwZVtcImNsYXVkZS1za2lsbFwiXT8ubGVuZ3RoKSB7XG4gICAgICBsaW5lcy5wdXNoKGAgIENsYXVkZSBTa2lsbHMgKCR7YnlUeXBlW1wiY2xhdWRlLXNraWxsXCJdLmxlbmd0aH0pOmApO1xuICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGJ5VHlwZVtcImNsYXVkZS1za2lsbFwiXSkge1xuICAgICAgICBpZiAoaXRlbS50eXBlICE9PSBcImNsYXVkZS1za2lsbFwiKSBjb250aW51ZTtcbiAgICAgICAgbGluZXMucHVzaChgICAgIC0gJHtpdGVtLm5hbWV9ICgke2l0ZW0uc291cmNlLmxldmVsfSkgJHtpdGVtLnBhdGh9YCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGJ5VHlwZVtcImNsYXVkZS1wbHVnaW5cIl0/Lmxlbmd0aCkge1xuICAgICAgbGluZXMucHVzaChgICBDbGF1ZGUgUGx1Z2lucyAoJHtieVR5cGVbXCJjbGF1ZGUtcGx1Z2luXCJdLmxlbmd0aH0pOmApO1xuICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGJ5VHlwZVtcImNsYXVkZS1wbHVnaW5cIl0pIHtcbiAgICAgICAgaWYgKGl0ZW0udHlwZSAhPT0gXCJjbGF1ZGUtcGx1Z2luXCIpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBsYWJlbCA9IGl0ZW0ucGFja2FnZU5hbWUgPyBgJHtpdGVtLm5hbWV9IFske2l0ZW0ucGFja2FnZU5hbWV9XWAgOiBpdGVtLm5hbWU7XG4gICAgICAgIGxpbmVzLnB1c2goYCAgICAtICR7bGFiZWx9ICgke2l0ZW0uc291cmNlLmxldmVsfSkgJHtpdGVtLnBhdGh9YCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgfVxuXG4gIGlmIChyZXN1bHQud2FybmluZ3MubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goXCJXYXJuaW5nczpcIik7XG4gICAgZm9yIChjb25zdCB3IG9mIHJlc3VsdC53YXJuaW5ncykge1xuICAgICAgbGluZXMucHVzaChgICAtICR7d31gKTtcbiAgICB9XG4gICAgbGluZXMucHVzaChcIlwiKTtcbiAgfVxuXG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG4vKipcbiAqIEZvcm1hdCBkaXNjb3ZlcnkgcmVzdWx0IGFzIGEgc3RydWN0dXJlZCBzdW1tYXJ5IGZvciAvY29uZmlncyBjb21tYW5kIG91dHB1dC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdERpc2NvdmVyeUZvckNvbW1hbmQocmVzdWx0OiBEaXNjb3ZlcnlSZXN1bHQpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB7IHN1bW1hcnkgfSA9IHJlc3VsdDtcblxuICBsaW5lcy5wdXNoKGAtLS0gVW5pdmVyc2FsIENvbmZpZyBEaXNjb3ZlcnkgLS0tYCk7XG4gIGxpbmVzLnB1c2goYCR7c3VtbWFyeS50b29sc1dpdGhDb25maWd9IG9mICR7c3VtbWFyeS50b29sc1NjYW5uZWR9IHRvb2xzIGhhdmUgY29uZmlndXJhdGlvbmApO1xuICBsaW5lcy5wdXNoKGAke3N1bW1hcnkudG90YWxJdGVtc30gdG90YWwgaXRlbXMgZGlzY292ZXJlZCBpbiAke3Jlc3VsdC5kdXJhdGlvbk1zfW1zYCk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgaWYgKHN1bW1hcnkudG90YWxJdGVtcyA9PT0gMCkge1xuICAgIGxpbmVzLnB1c2goXCJObyBjb25maWd1cmF0aW9uIGZvdW5kLlwiKTtcbiAgICByZXR1cm4gbGluZXM7XG4gIH1cblxuICBsaW5lcy5wdXNoKGAgIE1DUCBTZXJ2ZXJzOiAke3N1bW1hcnkubWNwU2VydmVyc31gKTtcbiAgbGluZXMucHVzaChgICBSdWxlczogICAgICAgJHtzdW1tYXJ5LnJ1bGVzfWApO1xuICBsaW5lcy5wdXNoKGAgIENvbnRleHQ6ICAgICAke3N1bW1hcnkuY29udGV4dEZpbGVzfWApO1xuICBsaW5lcy5wdXNoKGAgIFNldHRpbmdzOiAgICAke3N1bW1hcnkuc2V0dGluZ3N9YCk7XG4gIGxpbmVzLnB1c2goYCAgQ2xhdWRlIHNraWxsczogJHtzdW1tYXJ5LmNsYXVkZVNraWxsc31gKTtcbiAgbGluZXMucHVzaChgICBDbGF1ZGUgcGx1Z2luczogJHtzdW1tYXJ5LmNsYXVkZVBsdWdpbnN9YCk7XG4gIGxpbmVzLnB1c2goXCJcIik7XG5cbiAgZm9yIChjb25zdCB0b29sUmVzdWx0IG9mIHJlc3VsdC50b29scykge1xuICAgIGlmICh0b29sUmVzdWx0Lml0ZW1zLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG5cbiAgICBjb25zdCBjb3VudHMgPSBjb3VudEJ5VHlwZSh0b29sUmVzdWx0Lml0ZW1zKTtcbiAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAoY291bnRzW1wibWNwLXNlcnZlclwiXSkgcGFydHMucHVzaChgJHtjb3VudHNbXCJtY3Atc2VydmVyXCJdfSBNQ1BgKTtcbiAgICBpZiAoY291bnRzLnJ1bGUpIHBhcnRzLnB1c2goYCR7Y291bnRzLnJ1bGV9IHJ1bGVzYCk7XG4gICAgaWYgKGNvdW50c1tcImNvbnRleHQtZmlsZVwiXSkgcGFydHMucHVzaChgJHtjb3VudHNbXCJjb250ZXh0LWZpbGVcIl19IGNvbnRleHRgKTtcbiAgICBpZiAoY291bnRzLnNldHRpbmdzKSBwYXJ0cy5wdXNoKGAke2NvdW50cy5zZXR0aW5nc30gc2V0dGluZ3NgKTtcbiAgICBpZiAoY291bnRzW1wiY2xhdWRlLXNraWxsXCJdKSBwYXJ0cy5wdXNoKGAke2NvdW50c1tcImNsYXVkZS1za2lsbFwiXX0gQ2xhdWRlIHNraWxsc2ApO1xuICAgIGlmIChjb3VudHNbXCJjbGF1ZGUtcGx1Z2luXCJdKSBwYXJ0cy5wdXNoKGAke2NvdW50c1tcImNsYXVkZS1wbHVnaW5cIl19IENsYXVkZSBwbHVnaW5zYCk7XG5cbiAgICBsaW5lcy5wdXNoKGAgICR7dG9vbFJlc3VsdC50b29sLm5hbWV9OiAke3BhcnRzLmpvaW4oXCIsIFwiKX1gKTtcblxuICAgIC8vIFNob3cgTUNQIHNlcnZlciBuYW1lc1xuICAgIGNvbnN0IHNlcnZlcnMgPSB0b29sUmVzdWx0Lml0ZW1zLmZpbHRlcigoaSkgPT4gaS50eXBlID09PSBcIm1jcC1zZXJ2ZXJcIik7XG4gICAgZm9yIChjb25zdCBzZXJ2ZXIgb2Ygc2VydmVycykge1xuICAgICAgaWYgKHNlcnZlci50eXBlICE9PSBcIm1jcC1zZXJ2ZXJcIikgY29udGludWU7XG4gICAgICBsaW5lcy5wdXNoKGAgICAgTUNQOiAke3NlcnZlci5uYW1lfSAoJHtzZXJ2ZXIuc291cmNlLmxldmVsfSlgKTtcbiAgICB9XG5cbiAgICBjb25zdCBjbGF1ZGVTa2lsbHMgPSB0b29sUmVzdWx0Lml0ZW1zLmZpbHRlcigoaSkgPT4gaS50eXBlID09PSBcImNsYXVkZS1za2lsbFwiKTtcbiAgICBmb3IgKGNvbnN0IHNraWxsIG9mIGNsYXVkZVNraWxscykge1xuICAgICAgaWYgKHNraWxsLnR5cGUgIT09IFwiY2xhdWRlLXNraWxsXCIpIGNvbnRpbnVlO1xuICAgICAgbGluZXMucHVzaChgICAgIFNraWxsOiAke3NraWxsLm5hbWV9ICgke3NraWxsLnNvdXJjZS5sZXZlbH0pYCk7XG4gICAgfVxuXG4gICAgY29uc3QgY2xhdWRlUGx1Z2lucyA9IHRvb2xSZXN1bHQuaXRlbXMuZmlsdGVyKChpKSA9PiBpLnR5cGUgPT09IFwiY2xhdWRlLXBsdWdpblwiKTtcbiAgICBmb3IgKGNvbnN0IHBsdWdpbiBvZiBjbGF1ZGVQbHVnaW5zKSB7XG4gICAgICBpZiAocGx1Z2luLnR5cGUgIT09IFwiY2xhdWRlLXBsdWdpblwiKSBjb250aW51ZTtcbiAgICAgIGxpbmVzLnB1c2goYCAgICBQbHVnaW46ICR7cGx1Z2luLm5hbWV9ICgke3BsdWdpbi5zb3VyY2UubGV2ZWx9KWApO1xuICAgIH1cbiAgfVxuXG4gIGlmIChyZXN1bHQud2FybmluZ3MubGVuZ3RoID4gMCkge1xuICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgbGluZXMucHVzaChgJHtyZXN1bHQud2FybmluZ3MubGVuZ3RofSB3YXJuaW5nKHMpIFx1MjAxNCBydW4gZGlzY292ZXJfY29uZmlncyB0b29sIGZvciBkZXRhaWxzYCk7XG4gIH1cblxuICByZXR1cm4gbGluZXM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBncm91cEJ5VHlwZShpdGVtczogRGlzY292ZXJlZEl0ZW1bXSk6IFJlY29yZDxzdHJpbmcsIERpc2NvdmVyZWRJdGVtW10+IHtcbiAgY29uc3QgZ3JvdXBzOiBSZWNvcmQ8c3RyaW5nLCBEaXNjb3ZlcmVkSXRlbVtdPiA9IHt9O1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICAoZ3JvdXBzW2l0ZW0udHlwZV0gPz89IFtdKS5wdXNoKGl0ZW0pO1xuICB9XG4gIHJldHVybiBncm91cHM7XG59XG5cbmZ1bmN0aW9uIGNvdW50QnlUeXBlKGl0ZW1zOiBEaXNjb3ZlcmVkSXRlbVtdKTogUmVjb3JkPHN0cmluZywgbnVtYmVyPiB7XG4gIGNvbnN0IGNvdW50czogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICBjb3VudHNbaXRlbS50eXBlXSA9IChjb3VudHNbaXRlbS50eXBlXSA/PyAwKSArIDE7XG4gIH1cbiAgcmV0dXJuIGNvdW50cztcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQVdPLFNBQVMsdUJBQXVCLFFBQWlDO0FBQ3RFLFFBQU0sUUFBa0IsQ0FBQztBQUN6QixRQUFNLEVBQUUsUUFB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
