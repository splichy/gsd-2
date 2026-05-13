import { parse } from "yaml";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
function validateDefinition(parsed) {
  const errors = [];
  if (parsed == null || typeof parsed !== "object") {
    return { valid: false, errors: ["Definition must be a non-null object"] };
  }
  const def = parsed;
  if (def.version === void 0 || def.version === null) {
    errors.push("Missing required field: version");
  } else if (def.version !== 1) {
    errors.push(`Unsupported version: ${def.version} (expected 1)`);
  }
  if (typeof def.name !== "string" || def.name.trim() === "") {
    errors.push("Missing or empty required field: name");
  }
  if (!Array.isArray(def.steps)) {
    errors.push("Missing required field: steps (must be an array)");
  } else if (def.steps.length === 0) {
    errors.push("steps must contain at least one step");
  } else {
    let allStepIdsValid = true;
    for (let i = 0; i < def.steps.length; i++) {
      const step = def.steps[i];
      if (step == null || typeof step !== "object") {
        errors.push(`Step at index ${i} is not an object`);
        allStepIdsValid = false;
        continue;
      }
      if (typeof step.id !== "string" || step.id.trim() === "") {
        errors.push(`Step at index ${i} missing required field: id`);
        allStepIdsValid = false;
      }
      if (typeof step.name !== "string" || step.name.trim() === "") {
        errors.push(`Step at index ${i} missing required field: name`);
      }
      if (typeof step.prompt !== "string" || step.prompt.trim() === "") {
        errors.push(`Step at index ${i} missing required field: prompt`);
      }
      if (Array.isArray(step.produces)) {
        for (const p of step.produces) {
          if (typeof p === "string" && p.includes("..")) {
            errors.push(`Step "${step.id}" produces path contains disallowed '..': ${p}`);
          }
        }
      }
      if (step.iterate !== void 0) {
        const it = step.iterate;
        const sid = typeof step.id === "string" ? step.id : `index ${i}`;
        if (it == null || typeof it !== "object" || Array.isArray(it)) {
          errors.push(`Step "${sid}" iterate must be an object with "source" and "pattern" fields`);
        } else {
          const itObj = it;
          if (typeof itObj.source !== "string" || itObj.source.trim() === "") {
            errors.push(`Step "${sid}" iterate.source must be a non-empty string`);
          } else if (itObj.source.includes("..")) {
            errors.push(`Step "${sid}" iterate.source contains disallowed '..' path traversal`);
          }
          if (typeof itObj.pattern !== "string" || itObj.pattern.trim() === "") {
            errors.push(`Step "${sid}" iterate.pattern must be a non-empty string`);
          } else {
            const pat = itObj.pattern;
            let regexValid = true;
            try {
              new RegExp(pat);
            } catch {
              regexValid = false;
              errors.push(`Step "${sid}" iterate.pattern is not a valid regex: ${pat}`);
            }
            if (regexValid && !/\((?!\?)/.test(pat)) {
              errors.push(`Step "${sid}" iterate.pattern must contain at least one capture group`);
            }
          }
        }
      }
      if (step.verify !== void 0) {
        const v = step.verify;
        const sid = typeof step.id === "string" ? step.id : `index ${i}`;
        if (v == null || typeof v !== "object" || Array.isArray(v)) {
          errors.push(`Step "${sid}" verify must be an object with a "policy" field`);
        } else {
          const vObj = v;
          const VALID_POLICIES = ["content-heuristic", "shell-command", "prompt-verify", "human-review"];
          if (typeof vObj.policy !== "string" || !VALID_POLICIES.includes(vObj.policy)) {
            errors.push(`Step "${sid}" verify.policy must be one of: ${VALID_POLICIES.join(", ")}`);
          } else {
            if (vObj.policy === "shell-command") {
              if (typeof vObj.command !== "string" || vObj.command.trim() === "") {
                errors.push(`Step "${sid}" verify policy "shell-command" requires a non-empty "command" field`);
              }
            }
            if (vObj.policy === "prompt-verify") {
              if (typeof vObj.prompt !== "string" || vObj.prompt.trim() === "") {
                errors.push(`Step "${sid}" verify policy "prompt-verify" requires a non-empty "prompt" field`);
              }
            }
          }
        }
      }
    }
    if (allStepIdsValid) {
      const steps = def.steps;
      const idCounts = /* @__PURE__ */ new Map();
      for (const step of steps) {
        const id = step.id;
        idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
      }
      for (const [id, count] of idCounts) {
        if (count > 1) {
          errors.push(`Duplicate step id: ${id}`);
        }
      }
      const validIds = new Set(steps.map((s) => s.id));
      for (const step of steps) {
        const sid = step.id;
        const deps = Array.isArray(step.requires) ? step.requires : Array.isArray(step.depends_on) ? step.depends_on : [];
        for (const depId of deps) {
          if (depId === sid) {
            errors.push(`Step '${sid}' depends on itself`);
          } else if (!validIds.has(depId)) {
            errors.push(`Step '${sid}' requires unknown step '${depId}'`);
          }
        }
      }
      if (![...idCounts.values()].some((c) => c > 1)) {
        let dfs2 = function(node) {
          color.set(node, GRAY);
          for (const dep of adj.get(node) ?? []) {
            if (color.get(dep) === GRAY) {
              const cycle = [dep, node];
              let cur = node;
              while (parent.has(cur) && parent.get(cur) !== null && parent.get(cur) !== dep) {
                cur = parent.get(cur);
                cycle.push(cur);
              }
              cycle.push(dep);
              cycle.reverse();
              return cycle;
            }
            if (color.get(dep) === WHITE) {
              parent.set(dep, node);
              const result = dfs2(dep);
              if (result) return result;
            }
          }
          color.set(node, BLACK);
          return null;
        };
        var dfs = dfs2;
        const adj = /* @__PURE__ */ new Map();
        for (const step of steps) {
          const sid = step.id;
          const deps = Array.isArray(step.requires) ? step.requires : Array.isArray(step.depends_on) ? step.depends_on : [];
          adj.set(sid, deps.filter((d) => validIds.has(d) && d !== sid));
        }
        const WHITE = 0, GRAY = 1, BLACK = 2;
        const color = /* @__PURE__ */ new Map();
        for (const id of validIds) color.set(id, WHITE);
        const parent = /* @__PURE__ */ new Map();
        for (const id of validIds) {
          if (color.get(id) === WHITE) {
            parent.set(id, null);
            const cycle = dfs2(id);
            if (cycle) {
              errors.push(`Cycle detected: ${cycle.join(" \u2192 ")}`);
              break;
            }
          }
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
function loadDefinition(defsDir, name) {
  const filePath = join(defsDir, `${name}.yaml`);
  return loadDefinitionFromFile(filePath);
}
function loadDefinitionFromFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Definition file not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf-8");
  let parsed;
  try {
    parsed = parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to parse YAML in ${filePath}: ${msg}`);
  }
  const { valid, errors } = validateDefinition(parsed);
  if (!valid) {
    throw new Error(`Invalid workflow definition in ${filePath}:
  - ${errors.join("\n  - ")}`);
  }
  const yamlDef = parsed;
  const yamlSteps = yamlDef.steps;
  return {
    version: yamlDef.version,
    name: yamlDef.name,
    description: typeof yamlDef.description === "string" ? yamlDef.description : void 0,
    params: yamlDef.params != null && typeof yamlDef.params === "object" ? Object.fromEntries(
      Object.entries(yamlDef.params).map(
        ([k, v]) => [k, String(v)]
      )
    ) : void 0,
    steps: yamlSteps.map((s) => ({
      id: s.id,
      name: s.name,
      prompt: s.prompt,
      requires: Array.isArray(s.requires) ? s.requires : Array.isArray(s.depends_on) ? s.depends_on : [],
      produces: Array.isArray(s.produces) ? s.produces : [],
      contextFrom: Array.isArray(s.context_from) ? s.context_from : void 0,
      verify: s.verify,
      iterate: s.iterate != null && typeof s.iterate === "object" ? s.iterate : void 0
    }))
  };
}
const PARAM_PATTERN = /\{\{(\w+)\}\}/g;
function substitutePromptString(prompt, merged) {
  return prompt.replace(PARAM_PATTERN, (match, key) => {
    const value = merged[key];
    return value !== void 0 ? value : match;
  });
}
function substituteParams(definition, overrides) {
  const merged = {
    ...definition.params ?? {},
    ...overrides ?? {}
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value.includes("..")) {
      throw new Error(
        `Parameter "${key}" contains disallowed '..' (path traversal): ${value}`
      );
    }
  }
  const substitutedSteps = definition.steps.map((step) => ({
    ...step,
    prompt: substitutePromptString(step.prompt, merged)
  }));
  const unresolved = /* @__PURE__ */ new Set();
  for (const step of substitutedSteps) {
    let m;
    const re = new RegExp(PARAM_PATTERN.source, "g");
    while ((m = re.exec(step.prompt)) !== null) {
      unresolved.add(m[1]);
    }
  }
  if (unresolved.size > 0) {
    const keys = [...unresolved].sort().join(", ");
    throw new Error(`Unresolved parameter(s) in step prompts: ${keys}`);
  }
  return {
    ...definition,
    steps: substitutedSteps
  };
}
export {
  loadDefinition,
  loadDefinitionFromFile,
  substituteParams,
  substitutePromptString,
  validateDefinition
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kZWZpbml0aW9uLWxvYWRlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBkZWZpbml0aW9uLWxvYWRlci50cyBcdTIwMTQgUGFyc2UgYW5kIHZhbGlkYXRlIFYxIFlBTUwgd29ya2Zsb3cgZGVmaW5pdGlvbnMuXG4gKlxuICogTG9hZHMgZGVmaW5pdGlvbiBZQU1MIGZpbGVzIGZyb20gYC5nc2Qvd29ya2Zsb3ctZGVmcy9gLCB2YWxpZGF0ZXMgdGhlXG4gKiBWMSBzY2hlbWEgc2hhcGUsIGFuZCByZXR1cm5zIHR5cGVkIFR5cGVTY3JpcHQgb2JqZWN0cy4gUHVyZSBmdW5jdGlvbnNcbiAqIHdpdGggbm8gZW5naW5lIG9yIHJ1bnRpbWUgZGVwZW5kZW5jaWVzIFx1MjAxNCBqdXN0IGB5YW1sYCBhbmQgYG5vZGU6ZnNgLlxuICpcbiAqIFlBTUwgdXNlcyBzbmFrZV9jYXNlIChgZGVwZW5kc19vbmAsIGBjb250ZXh0X2Zyb21gKSBwZXIgcHJvamVjdCBjb252ZW50aW9uIChQMDA1KS5cbiAqIFR5cGVTY3JpcHQgdXNlcyBjYW1lbENhc2UgKGBkZXBlbmRzT25gLCBgY29udGV4dEZyb21gKS5cbiAqXG4gKiBPYnNlcnZhYmlsaXR5OiBBbGwgdmFsaWRhdGlvbiBlcnJvcnMgYXJlIGNvbGxlY3RlZCBpbnRvIGEgc3RyaW5nW10gXHUyMDE0IGNhbGxlcnNcbiAqIGNhbiBsb2csIHN1cmZhY2UgaW4gZGFzaGJvYXJkcywgb3IgcmV0dXJuIHRvIGFnZW50cyBmb3Igc2VsZi1yZXBhaXIuXG4gKiBzdWJzdGl0dXRlUGFyYW1zIGVycm9ycyBpbmNsdWRlIHRoZSBvZmZlbmRpbmcga2V5IG5hbWUgZm9yIHRyYWNlYWJpbGl0eS5cbiAqL1xuXG5pbXBvcnQgeyBwYXJzZSB9IGZyb20gXCJ5YW1sXCI7XG5pbXBvcnQgeyByZWFkRmlsZVN5bmMsIGV4aXN0c1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFB1YmxpYyBUeXBlU2NyaXB0IFR5cGVzIChjYW1lbENhc2UpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgdHlwZSBWZXJpZnlQb2xpY3kgPVxuICB8IHsgcG9saWN5OiBcImNvbnRlbnQtaGV1cmlzdGljXCI7IG1pblNpemU/OiBudW1iZXI7IHBhdHRlcm4/OiBzdHJpbmcgfVxuICB8IHsgcG9saWN5OiBcInNoZWxsLWNvbW1hbmRcIjsgY29tbWFuZDogc3RyaW5nIH1cbiAgfCB7IHBvbGljeTogXCJwcm9tcHQtdmVyaWZ5XCI7IHByb21wdDogc3RyaW5nIH1cbiAgfCB7IHBvbGljeTogXCJodW1hbi1yZXZpZXdcIiB9O1xuXG5leHBvcnQgaW50ZXJmYWNlIEl0ZXJhdGVDb25maWcge1xuICAvKiogQXJ0aWZhY3QgcGF0aCAocmVsYXRpdmUgdG8gcnVuIGRpcikgdG8gcmVhZCBhbmQgbWF0Y2ggYWdhaW5zdC4gKi9cbiAgc291cmNlOiBzdHJpbmc7XG4gIC8qKiBSZWdleCBwYXR0ZXJuIHN0cmluZy4gTXVzdCBjb250YWluIGF0IGxlYXN0IG9uZSBjYXB0dXJlIGdyb3VwLiBBcHBsaWVkIHdpdGggZ2xvYmFsIGZsYWcuICovXG4gIHBhdHRlcm46IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTdGVwRGVmaW5pdGlvbiB7XG4gIC8qKiBVbmlxdWUgc3RlcCBpZGVudGlmaWVyIHdpdGhpbiB0aGUgd29ya2Zsb3cuICovXG4gIGlkOiBzdHJpbmc7XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSBzdGVwIG5hbWUuICovXG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIFRoZSBwcm9tcHQgdG8gZGlzcGF0Y2ggZm9yIHRoaXMgc3RlcC4gKi9cbiAgcHJvbXB0OiBzdHJpbmc7XG4gIC8qKiBJRHMgb2Ygc3RlcHMgdGhhdCBtdXN0IGNvbXBsZXRlIGJlZm9yZSB0aGlzIHN0ZXAgY2FuIHJ1bi4gKi9cbiAgcmVxdWlyZXM6IHN0cmluZ1tdO1xuICAvKiogQXJ0aWZhY3QgcGF0aHMgcHJvZHVjZWQgYnkgdGhpcyBzdGVwIChyZWxhdGl2ZSB0byBydW4gZGlyKS4gKi9cbiAgcHJvZHVjZXM6IHN0cmluZ1tdO1xuICAvKiogU3RlcCBJRHMgd2hvc2UgYXJ0aWZhY3RzIHRvIGluY2x1ZGUgYXMgY29udGV4dCAoUzA1IFx1MjAxNCBhY2NlcHRlZCwgbm90IHByb2Nlc3NlZCkuICovXG4gIGNvbnRleHRGcm9tPzogc3RyaW5nW107XG4gIC8qKiBWZXJpZmljYXRpb24gcG9saWN5IGZvciB0aGlzIHN0ZXAgKFMwNSBcdTIwMTQgdHlwZWQgKyB2YWxpZGF0ZWQpLiAqL1xuICB2ZXJpZnk/OiBWZXJpZnlQb2xpY3k7XG4gIC8qKiBJdGVyYXRpb24gY29uZmlnIGZvciB0aGlzIHN0ZXAgKFMwNiBcdTIwMTQgdHlwZWQgKyB2YWxpZGF0ZWQpLiAqL1xuICBpdGVyYXRlPzogSXRlcmF0ZUNvbmZpZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXb3JrZmxvd0RlZmluaXRpb24ge1xuICAvKiogU2NoZW1hIHZlcnNpb24gXHUyMDE0IG11c3QgYmUgMS4gKi9cbiAgdmVyc2lvbjogbnVtYmVyO1xuICAvKiogV29ya2Zsb3cgbmFtZS4gKi9cbiAgbmFtZTogc3RyaW5nO1xuICAvKiogT3B0aW9uYWwgZGVzY3JpcHRpb24uICovXG4gIGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuICAvKiogT3B0aW9uYWwgcGFyYW1ldGVyIG1hcCBmb3IgdGVtcGxhdGUgc3Vic3RpdHV0aW9uIChTMDcpLiAqL1xuICBwYXJhbXM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAvKiogT3JkZXJlZCBsaXN0IG9mIHN0ZXBzLiAqL1xuICBzdGVwczogU3RlcERlZmluaXRpb25bXTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEludGVybmFsIFlBTUwgVHlwZXMgKHNuYWtlX2Nhc2UpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5pbnRlcmZhY2UgWWFtbFN0ZXBEZWYge1xuICBpZD86IHVua25vd247XG4gIG5hbWU/OiB1bmtub3duO1xuICBwcm9tcHQ/OiB1bmtub3duO1xuICByZXF1aXJlcz86IHVua25vd247XG4gIGRlcGVuZHNfb24/OiB1bmtub3duO1xuICBwcm9kdWNlcz86IHVua25vd247XG4gIGNvbnRleHRfZnJvbT86IHVua25vd247XG4gIHZlcmlmeT86IHVua25vd247XG4gIGl0ZXJhdGU/OiB1bmtub3duO1xuICBba2V5OiBzdHJpbmddOiB1bmtub3duOyAvLyBGb3J3YXJkLWNvbXBhdDogdW5rbm93biBmaWVsZHMgYWNjZXB0ZWQgc2lsZW50bHlcbn1cblxuaW50ZXJmYWNlIFlhbWxXb3JrZmxvd0RlZiB7XG4gIHZlcnNpb24/OiB1bmtub3duO1xuICBuYW1lPzogdW5rbm93bjtcbiAgZGVzY3JpcHRpb24/OiB1bmtub3duO1xuICBwYXJhbXM/OiB1bmtub3duO1xuICBzdGVwcz86IHVua25vd247XG4gIFtrZXk6IHN0cmluZ106IHVua25vd247IC8vIEZvcndhcmQtY29tcGF0OiB1bmtub3duIGZpZWxkcyBhY2NlcHRlZCBzaWxlbnRseVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVmFsaWRhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBWYWxpZGF0ZSBhIHBhcnNlZCAoYnV0IHVudHlwZWQpIFlBTUwgb2JqZWN0IGFnYWluc3QgdGhlIFYxIHdvcmtmbG93IHNjaGVtYS5cbiAqXG4gKiBDb2xsZWN0cyBhbGwgZXJyb3JzIChkb2VzIG5vdCBzaG9ydC1jaXJjdWl0KSBzbyBhIHNpbmdsZSBjYWxsIHJldmVhbHNcbiAqIGV2ZXJ5IHByb2JsZW0gd2l0aCB0aGUgZGVmaW5pdGlvbi5cbiAqXG4gKiBVbmtub3duIGZpZWxkcyBhcmUgc2lsZW50bHkgYWNjZXB0ZWQgZm9yIGZvcndhcmQgY29tcGF0aWJpbGl0eSB3aXRoXG4gKiBTMDUvUzA2IGZlYXR1cmVzIChgY29udGV4dF9mcm9tYCwgYHZlcmlmeWAsIGBpdGVyYXRlYCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZURlZmluaXRpb24ocGFyc2VkOiB1bmtub3duKTogeyB2YWxpZDogYm9vbGVhbjsgZXJyb3JzOiBzdHJpbmdbXSB9IHtcbiAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGlmIChwYXJzZWQgPT0gbnVsbCB8fCB0eXBlb2YgcGFyc2VkICE9PSBcIm9iamVjdFwiKSB7XG4gICAgcmV0dXJuIHsgdmFsaWQ6IGZhbHNlLCBlcnJvcnM6IFtcIkRlZmluaXRpb24gbXVzdCBiZSBhIG5vbi1udWxsIG9iamVjdFwiXSB9O1xuICB9XG5cbiAgY29uc3QgZGVmID0gcGFyc2VkIGFzIFlhbWxXb3JrZmxvd0RlZjtcblxuICAvLyB2ZXJzaW9uOiBtdXN0IGJlIDEgKG51bWJlcilcbiAgaWYgKGRlZi52ZXJzaW9uID09PSB1bmRlZmluZWQgfHwgZGVmLnZlcnNpb24gPT09IG51bGwpIHtcbiAgICBlcnJvcnMucHVzaChcIk1pc3NpbmcgcmVxdWlyZWQgZmllbGQ6IHZlcnNpb25cIik7XG4gIH0gZWxzZSBpZiAoZGVmLnZlcnNpb24gIT09IDEpIHtcbiAgICBlcnJvcnMucHVzaChgVW5zdXBwb3J0ZWQgdmVyc2lvbjogJHtkZWYudmVyc2lvbn0gKGV4cGVjdGVkIDEpYCk7XG4gIH1cblxuICAvLyBuYW1lOiBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZ1xuICBpZiAodHlwZW9mIGRlZi5uYW1lICE9PSBcInN0cmluZ1wiIHx8IGRlZi5uYW1lLnRyaW0oKSA9PT0gXCJcIikge1xuICAgIGVycm9ycy5wdXNoKFwiTWlzc2luZyBvciBlbXB0eSByZXF1aXJlZCBmaWVsZDogbmFtZVwiKTtcbiAgfVxuXG4gIC8vIHN0ZXBzOiBtdXN0IGJlIGEgbm9uLWVtcHR5IGFycmF5XG4gIGlmICghQXJyYXkuaXNBcnJheShkZWYuc3RlcHMpKSB7XG4gICAgZXJyb3JzLnB1c2goXCJNaXNzaW5nIHJlcXVpcmVkIGZpZWxkOiBzdGVwcyAobXVzdCBiZSBhbiBhcnJheSlcIik7XG4gIH0gZWxzZSBpZiAoZGVmLnN0ZXBzLmxlbmd0aCA9PT0gMCkge1xuICAgIGVycm9ycy5wdXNoKFwic3RlcHMgbXVzdCBjb250YWluIGF0IGxlYXN0IG9uZSBzdGVwXCIpO1xuICB9IGVsc2Uge1xuICAgIC8vIFRyYWNrIHdoZXRoZXIgYWxsIHN0ZXBzIGhhdmUgdmFsaWQgSURzIFx1MjAxNCBncmFwaC1sZXZlbCBjaGVja3Mgb25seSBydW4gd2hlbiB0cnVlXG4gICAgbGV0IGFsbFN0ZXBJZHNWYWxpZCA9IHRydWU7XG5cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGRlZi5zdGVwcy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3Qgc3RlcCA9IGRlZi5zdGVwc1tpXSBhcyBZYW1sU3RlcERlZjtcbiAgICAgIGlmIChzdGVwID09IG51bGwgfHwgdHlwZW9mIHN0ZXAgIT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgZXJyb3JzLnB1c2goYFN0ZXAgYXQgaW5kZXggJHtpfSBpcyBub3QgYW4gb2JqZWN0YCk7XG4gICAgICAgIGFsbFN0ZXBJZHNWYWxpZCA9IGZhbHNlO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gUmVxdWlyZWQgc3RlcCBmaWVsZHNcbiAgICAgIGlmICh0eXBlb2Ygc3RlcC5pZCAhPT0gXCJzdHJpbmdcIiB8fCBzdGVwLmlkLnRyaW0oKSA9PT0gXCJcIikge1xuICAgICAgICBlcnJvcnMucHVzaChgU3RlcCBhdCBpbmRleCAke2l9IG1pc3NpbmcgcmVxdWlyZWQgZmllbGQ6IGlkYCk7XG4gICAgICAgIGFsbFN0ZXBJZHNWYWxpZCA9IGZhbHNlO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBzdGVwLm5hbWUgIT09IFwic3RyaW5nXCIgfHwgc3RlcC5uYW1lLnRyaW0oKSA9PT0gXCJcIikge1xuICAgICAgICBlcnJvcnMucHVzaChgU3RlcCBhdCBpbmRleCAke2l9IG1pc3NpbmcgcmVxdWlyZWQgZmllbGQ6IG5hbWVgKTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2Ygc3RlcC5wcm9tcHQgIT09IFwic3RyaW5nXCIgfHwgc3RlcC5wcm9tcHQudHJpbSgpID09PSBcIlwiKSB7XG4gICAgICAgIGVycm9ycy5wdXNoKGBTdGVwIGF0IGluZGV4ICR7aX0gbWlzc2luZyByZXF1aXJlZCBmaWVsZDogcHJvbXB0YCk7XG4gICAgICB9XG5cbiAgICAgIC8vIHByb2R1Y2VzOiBwYXRoIHRyYXZlcnNhbCBndWFyZFxuICAgICAgaWYgKEFycmF5LmlzQXJyYXkoc3RlcC5wcm9kdWNlcykpIHtcbiAgICAgICAgZm9yIChjb25zdCBwIG9mIHN0ZXAucHJvZHVjZXMpIHtcbiAgICAgICAgICBpZiAodHlwZW9mIHAgPT09IFwic3RyaW5nXCIgJiYgcC5pbmNsdWRlcyhcIi4uXCIpKSB7XG4gICAgICAgICAgICBlcnJvcnMucHVzaChgU3RlcCBcIiR7c3RlcC5pZH1cIiBwcm9kdWNlcyBwYXRoIGNvbnRhaW5zIGRpc2FsbG93ZWQgJy4uJzogJHtwfWApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBpdGVyYXRlOiBvcHRpb25hbCwgYnV0IGlmIHByZXNlbnQgbXVzdCBjb25mb3JtIHRvIEl0ZXJhdGVDb25maWcgc2hhcGVcbiAgICAgIGlmIChzdGVwLml0ZXJhdGUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBjb25zdCBpdCA9IHN0ZXAuaXRlcmF0ZTtcbiAgICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHN0ZXAuaWQgPT09IFwic3RyaW5nXCIgPyBzdGVwLmlkIDogYGluZGV4ICR7aX1gO1xuICAgICAgICBpZiAoaXQgPT0gbnVsbCB8fCB0eXBlb2YgaXQgIT09IFwib2JqZWN0XCIgfHwgQXJyYXkuaXNBcnJheShpdCkpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChgU3RlcCBcIiR7c2lkfVwiIGl0ZXJhdGUgbXVzdCBiZSBhbiBvYmplY3Qgd2l0aCBcInNvdXJjZVwiIGFuZCBcInBhdHRlcm5cIiBmaWVsZHNgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCBpdE9iaiA9IGl0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICAgIGlmICh0eXBlb2YgaXRPYmouc291cmNlICE9PSBcInN0cmluZ1wiIHx8IChpdE9iai5zb3VyY2UgYXMgc3RyaW5nKS50cmltKCkgPT09IFwiXCIpIHtcbiAgICAgICAgICAgIGVycm9ycy5wdXNoKGBTdGVwIFwiJHtzaWR9XCIgaXRlcmF0ZS5zb3VyY2UgbXVzdCBiZSBhIG5vbi1lbXB0eSBzdHJpbmdgKTtcbiAgICAgICAgICB9IGVsc2UgaWYgKChpdE9iai5zb3VyY2UgYXMgc3RyaW5nKS5pbmNsdWRlcyhcIi4uXCIpKSB7XG4gICAgICAgICAgICBlcnJvcnMucHVzaChgU3RlcCBcIiR7c2lkfVwiIGl0ZXJhdGUuc291cmNlIGNvbnRhaW5zIGRpc2FsbG93ZWQgJy4uJyBwYXRoIHRyYXZlcnNhbGApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodHlwZW9mIGl0T2JqLnBhdHRlcm4gIT09IFwic3RyaW5nXCIgfHwgKGl0T2JqLnBhdHRlcm4gYXMgc3RyaW5nKS50cmltKCkgPT09IFwiXCIpIHtcbiAgICAgICAgICAgIGVycm9ycy5wdXNoKGBTdGVwIFwiJHtzaWR9XCIgaXRlcmF0ZS5wYXR0ZXJuIG11c3QgYmUgYSBub24tZW1wdHkgc3RyaW5nYCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnN0IHBhdCA9IGl0T2JqLnBhdHRlcm4gYXMgc3RyaW5nO1xuICAgICAgICAgICAgbGV0IHJlZ2V4VmFsaWQgPSB0cnVlO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgbmV3IFJlZ0V4cChwYXQpO1xuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgIHJlZ2V4VmFsaWQgPSBmYWxzZTtcbiAgICAgICAgICAgICAgZXJyb3JzLnB1c2goYFN0ZXAgXCIke3NpZH1cIiBpdGVyYXRlLnBhdHRlcm4gaXMgbm90IGEgdmFsaWQgcmVnZXg6ICR7cGF0fWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHJlZ2V4VmFsaWQgJiYgIS9cXCgoPyFcXD8pLy50ZXN0KHBhdCkpIHtcbiAgICAgICAgICAgICAgZXJyb3JzLnB1c2goYFN0ZXAgXCIke3NpZH1cIiBpdGVyYXRlLnBhdHRlcm4gbXVzdCBjb250YWluIGF0IGxlYXN0IG9uZSBjYXB0dXJlIGdyb3VwYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIHZlcmlmeTogb3B0aW9uYWwsIGJ1dCBpZiBwcmVzZW50IG11c3QgY29uZm9ybSB0byBWZXJpZnlQb2xpY3kgc2hhcGVcbiAgICAgIGlmIChzdGVwLnZlcmlmeSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGNvbnN0IHYgPSBzdGVwLnZlcmlmeTtcbiAgICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHN0ZXAuaWQgPT09IFwic3RyaW5nXCIgPyBzdGVwLmlkIDogYGluZGV4ICR7aX1gO1xuICAgICAgICBpZiAodiA9PSBudWxsIHx8IHR5cGVvZiB2ICE9PSBcIm9iamVjdFwiIHx8IEFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICBlcnJvcnMucHVzaChgU3RlcCBcIiR7c2lkfVwiIHZlcmlmeSBtdXN0IGJlIGFuIG9iamVjdCB3aXRoIGEgXCJwb2xpY3lcIiBmaWVsZGApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNvbnN0IHZPYmogPSB2IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICAgIGNvbnN0IFZBTElEX1BPTElDSUVTID0gW1wiY29udGVudC1oZXVyaXN0aWNcIiwgXCJzaGVsbC1jb21tYW5kXCIsIFwicHJvbXB0LXZlcmlmeVwiLCBcImh1bWFuLXJldmlld1wiXTtcbiAgICAgICAgICBpZiAodHlwZW9mIHZPYmoucG9saWN5ICE9PSBcInN0cmluZ1wiIHx8ICFWQUxJRF9QT0xJQ0lFUy5pbmNsdWRlcyh2T2JqLnBvbGljeSkpIHtcbiAgICAgICAgICAgIGVycm9ycy5wdXNoKGBTdGVwIFwiJHtzaWR9XCIgdmVyaWZ5LnBvbGljeSBtdXN0IGJlIG9uZSBvZjogJHtWQUxJRF9QT0xJQ0lFUy5qb2luKFwiLCBcIil9YCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIFBvbGljeS1zcGVjaWZpYyByZXF1aXJlZCBmaWVsZCBjaGVja3NcbiAgICAgICAgICAgIGlmICh2T2JqLnBvbGljeSA9PT0gXCJzaGVsbC1jb21tYW5kXCIpIHtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2T2JqLmNvbW1hbmQgIT09IFwic3RyaW5nXCIgfHwgKHZPYmouY29tbWFuZCBhcyBzdHJpbmcpLnRyaW0oKSA9PT0gXCJcIikge1xuICAgICAgICAgICAgICAgIGVycm9ycy5wdXNoKGBTdGVwIFwiJHtzaWR9XCIgdmVyaWZ5IHBvbGljeSBcInNoZWxsLWNvbW1hbmRcIiByZXF1aXJlcyBhIG5vbi1lbXB0eSBcImNvbW1hbmRcIiBmaWVsZGApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodk9iai5wb2xpY3kgPT09IFwicHJvbXB0LXZlcmlmeVwiKSB7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2Ygdk9iai5wcm9tcHQgIT09IFwic3RyaW5nXCIgfHwgKHZPYmoucHJvbXB0IGFzIHN0cmluZykudHJpbSgpID09PSBcIlwiKSB7XG4gICAgICAgICAgICAgICAgZXJyb3JzLnB1c2goYFN0ZXAgXCIke3NpZH1cIiB2ZXJpZnkgcG9saWN5IFwicHJvbXB0LXZlcmlmeVwiIHJlcXVpcmVzIGEgbm9uLWVtcHR5IFwicHJvbXB0XCIgZmllbGRgKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBHcmFwaC1sZXZlbCB2YWxpZGF0aW9ucyAob25seSB3aGVuIGFsbCBzdGVwIElEcyBhcmUgdmFsaWQpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIGlmIChhbGxTdGVwSWRzVmFsaWQpIHtcbiAgICAgIGNvbnN0IHN0ZXBzID0gZGVmLnN0ZXBzIGFzIFlhbWxTdGVwRGVmW107XG5cbiAgICAgIC8vIDEuIER1cGxpY2F0ZSBzdGVwIElEIGNoZWNrXG4gICAgICBjb25zdCBpZENvdW50cyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gICAgICBmb3IgKGNvbnN0IHN0ZXAgb2Ygc3RlcHMpIHtcbiAgICAgICAgY29uc3QgaWQgPSBzdGVwLmlkIGFzIHN0cmluZztcbiAgICAgICAgaWRDb3VudHMuc2V0KGlkLCAoaWRDb3VudHMuZ2V0KGlkKSA/PyAwKSArIDEpO1xuICAgICAgfVxuICAgICAgZm9yIChjb25zdCBbaWQsIGNvdW50XSBvZiBpZENvdW50cykge1xuICAgICAgICBpZiAoY291bnQgPiAxKSB7XG4gICAgICAgICAgZXJyb3JzLnB1c2goYER1cGxpY2F0ZSBzdGVwIGlkOiAke2lkfWApO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEJ1aWxkIHZhbGlkIElEIHNldCBmb3IgcmVtYWluaW5nIGNoZWNrc1xuICAgICAgY29uc3QgdmFsaWRJZHMgPSBuZXcgU2V0KHN0ZXBzLm1hcCgocykgPT4gcy5pZCBhcyBzdHJpbmcpKTtcblxuICAgICAgLy8gMi4gRGFuZ2xpbmcgZGVwZW5kZW5jeSBjaGVjayArIDMuIFNlbGYtcmVmZXJlbmNpbmcgZGVwZW5kZW5jeSBjaGVja1xuICAgICAgZm9yIChjb25zdCBzdGVwIG9mIHN0ZXBzKSB7XG4gICAgICAgIGNvbnN0IHNpZCA9IHN0ZXAuaWQgYXMgc3RyaW5nO1xuICAgICAgICBjb25zdCBkZXBzID0gQXJyYXkuaXNBcnJheShzdGVwLnJlcXVpcmVzKVxuICAgICAgICAgID8gKHN0ZXAucmVxdWlyZXMgYXMgc3RyaW5nW10pXG4gICAgICAgICAgOiBBcnJheS5pc0FycmF5KHN0ZXAuZGVwZW5kc19vbilcbiAgICAgICAgICAgID8gKHN0ZXAuZGVwZW5kc19vbiBhcyBzdHJpbmdbXSlcbiAgICAgICAgICAgIDogW107XG5cbiAgICAgICAgZm9yIChjb25zdCBkZXBJZCBvZiBkZXBzKSB7XG4gICAgICAgICAgaWYgKGRlcElkID09PSBzaWQpIHtcbiAgICAgICAgICAgIGVycm9ycy5wdXNoKGBTdGVwICcke3NpZH0nIGRlcGVuZHMgb24gaXRzZWxmYCk7XG4gICAgICAgICAgfSBlbHNlIGlmICghdmFsaWRJZHMuaGFzKGRlcElkKSkge1xuICAgICAgICAgICAgZXJyb3JzLnB1c2goYFN0ZXAgJyR7c2lkfScgcmVxdWlyZXMgdW5rbm93biBzdGVwICcke2RlcElkfSdgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gNC4gQ3ljbGUgZGV0ZWN0aW9uIChERlMpIFx1MjAxNCBvbmx5IHdoZW4gbm8gZHVwbGljYXRlIElEc1xuICAgICAgaWYgKCFbLi4uaWRDb3VudHMudmFsdWVzKCldLnNvbWUoKGM6IG51bWJlcikgPT4gYyA+IDEpKSB7XG4gICAgICAgIC8vIEJ1aWxkIGFkamFjZW5jeSBsaXN0OiBzdGVwIFx1MjE5MiBpdHMgZGVwZW5kZW5jaWVzXG4gICAgICAgIGNvbnN0IGFkaiA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmdbXT4oKTtcbiAgICAgICAgZm9yIChjb25zdCBzdGVwIG9mIHN0ZXBzKSB7XG4gICAgICAgICAgY29uc3Qgc2lkID0gc3RlcC5pZCBhcyBzdHJpbmc7XG4gICAgICAgICAgY29uc3QgZGVwcyA9IEFycmF5LmlzQXJyYXkoc3RlcC5yZXF1aXJlcylcbiAgICAgICAgICAgID8gKHN0ZXAucmVxdWlyZXMgYXMgc3RyaW5nW10pXG4gICAgICAgICAgICA6IEFycmF5LmlzQXJyYXkoc3RlcC5kZXBlbmRzX29uKVxuICAgICAgICAgICAgICA/IChzdGVwLmRlcGVuZHNfb24gYXMgc3RyaW5nW10pXG4gICAgICAgICAgICAgIDogW107XG4gICAgICAgICAgYWRqLnNldChzaWQsIGRlcHMuZmlsdGVyKChkKSA9PiB2YWxpZElkcy5oYXMoZCkgJiYgZCAhPT0gc2lkKSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBXSElURSA9IDAsIEdSQVkgPSAxLCBCTEFDSyA9IDI7XG4gICAgICAgIGNvbnN0IGNvbG9yID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgICAgICAgZm9yIChjb25zdCBpZCBvZiB2YWxpZElkcykgY29sb3Iuc2V0KGlkLCBXSElURSk7XG5cbiAgICAgICAgY29uc3QgcGFyZW50ID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZyB8IG51bGw+KCk7XG5cbiAgICAgICAgZnVuY3Rpb24gZGZzKG5vZGU6IHN0cmluZyk6IHN0cmluZ1tdIHwgbnVsbCB7XG4gICAgICAgICAgY29sb3Iuc2V0KG5vZGUsIEdSQVkpO1xuICAgICAgICAgIGZvciAoY29uc3QgZGVwIG9mIGFkai5nZXQobm9kZSkgPz8gW10pIHtcbiAgICAgICAgICAgIGlmIChjb2xvci5nZXQoZGVwKSA9PT0gR1JBWSkge1xuICAgICAgICAgICAgICAvLyBCYWNrIGVkZ2UgZm91bmQgXHUyMDE0IHJlY29uc3RydWN0IGN5Y2xlIHBhdGhcbiAgICAgICAgICAgICAgY29uc3QgY3ljbGU6IHN0cmluZ1tdID0gW2RlcCwgbm9kZV07XG4gICAgICAgICAgICAgIGxldCBjdXIgPSBub2RlO1xuICAgICAgICAgICAgICB3aGlsZSAocGFyZW50LmhhcyhjdXIpICYmIHBhcmVudC5nZXQoY3VyKSAhPT0gbnVsbCAmJiBwYXJlbnQuZ2V0KGN1cikgIT09IGRlcCkge1xuICAgICAgICAgICAgICAgIGN1ciA9IHBhcmVudC5nZXQoY3VyKSE7XG4gICAgICAgICAgICAgICAgY3ljbGUucHVzaChjdXIpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGN5Y2xlLnB1c2goZGVwKTtcbiAgICAgICAgICAgICAgY3ljbGUucmV2ZXJzZSgpO1xuICAgICAgICAgICAgICByZXR1cm4gY3ljbGU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoY29sb3IuZ2V0KGRlcCkgPT09IFdISVRFKSB7XG4gICAgICAgICAgICAgIHBhcmVudC5zZXQoZGVwLCBub2RlKTtcbiAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gZGZzKGRlcCk7XG4gICAgICAgICAgICAgIGlmIChyZXN1bHQpIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbG9yLnNldChub2RlLCBCTEFDSyk7XG4gICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cblxuICAgICAgICBmb3IgKGNvbnN0IGlkIG9mIHZhbGlkSWRzKSB7XG4gICAgICAgICAgaWYgKGNvbG9yLmdldChpZCkgPT09IFdISVRFKSB7XG4gICAgICAgICAgICBwYXJlbnQuc2V0KGlkLCBudWxsKTtcbiAgICAgICAgICAgIGNvbnN0IGN5Y2xlID0gZGZzKGlkKTtcbiAgICAgICAgICAgIGlmIChjeWNsZSkge1xuICAgICAgICAgICAgICBlcnJvcnMucHVzaChgQ3ljbGUgZGV0ZWN0ZWQ6ICR7Y3ljbGUuam9pbihcIiBcdTIxOTIgXCIpfWApO1xuICAgICAgICAgICAgICBicmVhazsgLy8gT25lIGN5Y2xlIGVycm9yIGlzIGVub3VnaFxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IHZhbGlkOiBlcnJvcnMubGVuZ3RoID09PSAwLCBlcnJvcnMgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIExvYWRpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogTG9hZCBhbmQgdmFsaWRhdGUgYSBZQU1MIHdvcmtmbG93IGRlZmluaXRpb24gZnJvbSB0aGUgZmlsZXN5c3RlbS5cbiAqXG4gKiBSZWFkcyBgPGRlZnNEaXI+LzxuYW1lPi55YW1sYCwgcGFyc2VzIFlBTUwsIHZhbGlkYXRlcyB0aGUgVjEgc2NoZW1hLFxuICogYW5kIGNvbnZlcnRzIHNuYWtlX2Nhc2UgWUFNTCBrZXlzIHRvIGNhbWVsQ2FzZSBUeXBlU2NyaXB0IHR5cGVzLlxuICpcbiAqIEBwYXJhbSBkZWZzRGlyIFx1MjAxNCBkaXJlY3RvcnkgY29udGFpbmluZyBkZWZpbml0aW9uIFlBTUwgZmlsZXNcbiAqIEBwYXJhbSBuYW1lIFx1MjAxNCBkZWZpbml0aW9uIGZpbGVuYW1lIHdpdGhvdXQgZXh0ZW5zaW9uXG4gKiBAcmV0dXJucyBQYXJzZWQgYW5kIHZhbGlkYXRlZCBXb3JrZmxvd0RlZmluaXRpb25cbiAqIEB0aHJvd3MgRXJyb3IgaWYgZmlsZSBpcyBtaXNzaW5nLCBZQU1MIGlzIG1hbGZvcm1lZCwgb3Igc2NoZW1hIGlzIGludmFsaWRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvYWREZWZpbml0aW9uKGRlZnNEaXI6IHN0cmluZywgbmFtZTogc3RyaW5nKTogV29ya2Zsb3dEZWZpbml0aW9uIHtcbiAgY29uc3QgZmlsZVBhdGggPSBqb2luKGRlZnNEaXIsIGAke25hbWV9LnlhbWxgKTtcbiAgcmV0dXJuIGxvYWREZWZpbml0aW9uRnJvbUZpbGUoZmlsZVBhdGgpO1xufVxuXG4vKipcbiAqIExvYWQgYW5kIHZhbGlkYXRlIGEgWUFNTCB3b3JrZmxvdyBkZWZpbml0aW9uIGZyb20gYW4gYWJzb2x1dGUgZmlsZSBwYXRoLlxuICogQWNjZXB0cyBib3RoIGAueWFtbGAgYW5kIGAueW1sYCBleHRlbnNpb25zLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbG9hZERlZmluaXRpb25Gcm9tRmlsZShmaWxlUGF0aDogc3RyaW5nKTogV29ya2Zsb3dEZWZpbml0aW9uIHtcbiAgaWYgKCFleGlzdHNTeW5jKGZpbGVQYXRoKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgRGVmaW5pdGlvbiBmaWxlIG5vdCBmb3VuZDogJHtmaWxlUGF0aH1gKTtcbiAgfVxuXG4gIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgXCJ1dGYtOFwiKTtcbiAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBwYXJzZShyYXcpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgbXNnID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIHBhcnNlIFlBTUwgaW4gJHtmaWxlUGF0aH06ICR7bXNnfWApO1xuICB9XG5cbiAgY29uc3QgeyB2YWxpZCwgZXJyb3JzIH0gPSB2YWxpZGF0ZURlZmluaXRpb24ocGFyc2VkKTtcbiAgaWYgKCF2YWxpZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCB3b3JrZmxvdyBkZWZpbml0aW9uIGluICR7ZmlsZVBhdGh9OlxcbiAgLSAke2Vycm9ycy5qb2luKFwiXFxuICAtIFwiKX1gKTtcbiAgfVxuXG4gIC8vIENvbnZlcnQgc25ha2VfY2FzZSBZQU1MIFx1MjE5MiBjYW1lbENhc2UgVHlwZVNjcmlwdFxuICBjb25zdCB5YW1sRGVmID0gcGFyc2VkIGFzIFlhbWxXb3JrZmxvd0RlZjtcbiAgY29uc3QgeWFtbFN0ZXBzID0geWFtbERlZi5zdGVwcyBhcyBZYW1sU3RlcERlZltdO1xuXG4gIHJldHVybiB7XG4gICAgdmVyc2lvbjogeWFtbERlZi52ZXJzaW9uIGFzIG51bWJlcixcbiAgICBuYW1lOiB5YW1sRGVmLm5hbWUgYXMgc3RyaW5nLFxuICAgIGRlc2NyaXB0aW9uOiB0eXBlb2YgeWFtbERlZi5kZXNjcmlwdGlvbiA9PT0gXCJzdHJpbmdcIiA/IHlhbWxEZWYuZGVzY3JpcHRpb24gOiB1bmRlZmluZWQsXG4gICAgcGFyYW1zOiB5YW1sRGVmLnBhcmFtcyAhPSBudWxsICYmIHR5cGVvZiB5YW1sRGVmLnBhcmFtcyA9PT0gXCJvYmplY3RcIlxuICAgICAgPyBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICAgICAgT2JqZWN0LmVudHJpZXMoeWFtbERlZi5wYXJhbXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLm1hcChcbiAgICAgICAgICAgIChbaywgdl0pID0+IFtrLCBTdHJpbmcodildLFxuICAgICAgICAgICksXG4gICAgICAgIClcbiAgICAgIDogdW5kZWZpbmVkLFxuICAgIHN0ZXBzOiB5YW1sU3RlcHMubWFwKChzKSA9PiAoe1xuICAgICAgaWQ6IHMuaWQgYXMgc3RyaW5nLFxuICAgICAgbmFtZTogcy5uYW1lIGFzIHN0cmluZyxcbiAgICAgIHByb21wdDogcy5wcm9tcHQgYXMgc3RyaW5nLFxuICAgICAgcmVxdWlyZXM6IEFycmF5LmlzQXJyYXkocy5yZXF1aXJlcylcbiAgICAgICAgPyAocy5yZXF1aXJlcyBhcyBzdHJpbmdbXSlcbiAgICAgICAgOiBBcnJheS5pc0FycmF5KHMuZGVwZW5kc19vbilcbiAgICAgICAgICA/IChzLmRlcGVuZHNfb24gYXMgc3RyaW5nW10pXG4gICAgICAgICAgOiBbXSxcbiAgICAgIHByb2R1Y2VzOiBBcnJheS5pc0FycmF5KHMucHJvZHVjZXMpID8gKHMucHJvZHVjZXMgYXMgc3RyaW5nW10pIDogW10sXG4gICAgICBjb250ZXh0RnJvbTogQXJyYXkuaXNBcnJheShzLmNvbnRleHRfZnJvbSkgPyAocy5jb250ZXh0X2Zyb20gYXMgc3RyaW5nW10pIDogdW5kZWZpbmVkLFxuICAgICAgdmVyaWZ5OiBzLnZlcmlmeSBhcyBWZXJpZnlQb2xpY3kgfCB1bmRlZmluZWQsXG4gICAgICBpdGVyYXRlOiAocy5pdGVyYXRlICE9IG51bGwgJiYgdHlwZW9mIHMuaXRlcmF0ZSA9PT0gXCJvYmplY3RcIilcbiAgICAgICAgPyBzLml0ZXJhdGUgYXMgSXRlcmF0ZUNvbmZpZ1xuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICB9KSksXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQYXJhbWV0ZXIgU3Vic3RpdHV0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogUmVnZXggbWF0Y2hpbmcgYHt7a2V5fX1gIHBsYWNlaG9sZGVycyBcdTIwMTQgY2FwdHVyZXMgdGhlIGtleSBuYW1lLiAqL1xuY29uc3QgUEFSQU1fUEFUVEVSTiA9IC9cXHtcXHsoXFx3KylcXH1cXH0vZztcblxuLyoqXG4gKiBSZXBsYWNlIGB7e2tleX19YCBwbGFjZWhvbGRlcnMgaW4gYSBzaW5nbGUgcHJvbXB0IHN0cmluZy5cbiAqXG4gKiBFeHBvcnRlZCBmb3IgdXNlIGJ5IHRoZSBlbmdpbmUgb24gaXRlcmF0aW9uLWluc3RhbmNlIHByb21wdHMgdGhhdCBsaXZlXG4gKiBpbiBHUkFQSC55YW1sIChvdXRzaWRlIHRoZSBkZWZpbml0aW9uJ3Mgc3RlcCBsaXN0KS5cbiAqXG4gKiBAdGhyb3dzIEVycm9yIGlmIGFueSBtZXJnZWQgcGFyYW0gdmFsdWUgY29udGFpbnMgYC4uYCAocGF0aC10cmF2ZXJzYWwgZ3VhcmQpXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdWJzdGl0dXRlUHJvbXB0U3RyaW5nKFxuICBwcm9tcHQ6IHN0cmluZyxcbiAgbWVyZ2VkOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIHByb21wdC5yZXBsYWNlKFBBUkFNX1BBVFRFUk4sIChtYXRjaCwga2V5OiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCB2YWx1ZSA9IG1lcmdlZFtrZXldO1xuICAgIHJldHVybiB2YWx1ZSAhPT0gdW5kZWZpbmVkID8gdmFsdWUgOiBtYXRjaDtcbiAgfSk7XG59XG5cbi8qKlxuICogUmVwbGFjZSBge3trZXl9fWAgcGxhY2Vob2xkZXJzIGluIGFsbCBzdGVwIHByb21wdHMgd2l0aCBwYXJhbSB2YWx1ZXMuXG4gKlxuICogTWVyZ2Ugb3JkZXI6IGBkZWZpbml0aW9uLnBhcmFtc2AgKGRlZmF1bHRzKSBcdTIxOTAgYG92ZXJyaWRlc2AgKENMSSB3aW5zKS5cbiAqIFJldHVybnMgYSAqKm5ldyoqIFdvcmtmbG93RGVmaW5pdGlvbiBcdTIwMTQgdGhlIGlucHV0IGlzIG5ldmVyIG11dGF0ZWQuXG4gKlxuICogQHRocm93cyBFcnJvciBpZiBhbnkgcGFyYW0gdmFsdWUgY29udGFpbnMgYC4uYCAocGF0aC10cmF2ZXJzYWwgZ3VhcmQpXG4gKiBAdGhyb3dzIEVycm9yIGlmIGFueSBge3trZXl9fWAgcmVtYWlucyB1bnJlc29sdmVkIGFmdGVyIHN1YnN0aXR1dGlvblxuICovXG5leHBvcnQgZnVuY3Rpb24gc3Vic3RpdHV0ZVBhcmFtcyhcbiAgZGVmaW5pdGlvbjogV29ya2Zsb3dEZWZpbml0aW9uLFxuICBvdmVycmlkZXM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxuKTogV29ya2Zsb3dEZWZpbml0aW9uIHtcbiAgY29uc3QgbWVyZ2VkOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAgIC4uLihkZWZpbml0aW9uLnBhcmFtcyA/PyB7fSksXG4gICAgLi4uKG92ZXJyaWRlcyA/PyB7fSksXG4gIH07XG5cbiAgLy8gUGF0aC10cmF2ZXJzYWwgZ3VhcmQ6IHJlamVjdCBhbnkgdmFsdWUgY29udGFpbmluZyBcIi4uXCJcbiAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMobWVyZ2VkKSkge1xuICAgIGlmICh2YWx1ZS5pbmNsdWRlcyhcIi4uXCIpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBQYXJhbWV0ZXIgXCIke2tleX1cIiBjb250YWlucyBkaXNhbGxvd2VkICcuLicgKHBhdGggdHJhdmVyc2FsKTogJHt2YWx1ZX1gLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvLyBTdWJzdGl0dXRlIGluIGVhY2ggc3RlcCBwcm9tcHRcbiAgY29uc3Qgc3Vic3RpdHV0ZWRTdGVwcyA9IGRlZmluaXRpb24uc3RlcHMubWFwKChzdGVwKSA9PiAoe1xuICAgIC4uLnN0ZXAsXG4gICAgcHJvbXB0OiBzdWJzdGl0dXRlUHJvbXB0U3RyaW5nKHN0ZXAucHJvbXB0LCBtZXJnZWQpLFxuICB9KSk7XG5cbiAgLy8gQ2hlY2sgZm9yIHVucmVzb2x2ZWQgcGxhY2Vob2xkZXJzXG4gIGNvbnN0IHVucmVzb2x2ZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBzdGVwIG9mIHN1YnN0aXR1dGVkU3RlcHMpIHtcbiAgICBsZXQgbTogUmVnRXhwRXhlY0FycmF5IHwgbnVsbDtcbiAgICBjb25zdCByZSA9IG5ldyBSZWdFeHAoUEFSQU1fUEFUVEVSTi5zb3VyY2UsIFwiZ1wiKTtcbiAgICB3aGlsZSAoKG0gPSByZS5leGVjKHN0ZXAucHJvbXB0KSkgIT09IG51bGwpIHtcbiAgICAgIHVucmVzb2x2ZWQuYWRkKG1bMV0pO1xuICAgIH1cbiAgfVxuXG4gIGlmICh1bnJlc29sdmVkLnNpemUgPiAwKSB7XG4gICAgY29uc3Qga2V5cyA9IFsuLi51bnJlc29sdmVkXS5zb3J0KCkuam9pbihcIiwgXCIpO1xuICAgIHRocm93IG5ldyBFcnJvcihgVW5yZXNvbHZlZCBwYXJhbWV0ZXIocykgaW4gc3RlcCBwcm9tcHRzOiAke2tleXN9YCk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIC4uLmRlZmluaXRpb24sXG4gICAgc3RlcHM6IHN1YnN0aXR1dGVkU3RlcHMsXG4gIH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFlQSxTQUFTLGFBQWE7QUFDdEIsU0FBUyxjQUFjLGtCQUFrQjtBQUN6QyxTQUFTLFlBQVk7QUFvRmQsU0FBUyxtQkFBbUIsUUFBdUQ7QUFDeEYsUUFBTSxTQUFtQixDQUFDO0FBRTFCLE1BQUksVUFBVSxRQUFRLE9BQU8sV0FBVyxVQUFVO0FBQ2hELFdBQU8sRUFBRSxPQUFPLE9BQU8sUUFBUSxDQUFDLHNDQUFzQyxFQUFFO0FBQUEsRUFDMUU7QUFFQSxRQUFNLE1BQU07QUFHWixNQUFJLElBQUksWUFBWSxVQUFhLElBQUksWUFBWSxNQUFNO0FBQ3JELFdBQU8sS0FBSyxpQ0FBaUM7QUFBQSxFQUMvQyxXQUFXLElBQUksWUFBWSxHQUFHO0FBQzVCLFdBQU8sS0FBSyx3QkFBd0IsSUFBSSxPQUFPLGVBQWU7QUFBQSxFQUNoRTtBQUdBLE1BQUksT0FBTyxJQUFJLFNBQVMsWUFBWSxJQUFJLEtBQUssS0FBSyxNQUFNLElBQUk7QUFDMUQsV0FBTyxLQUFLLHVDQUF1QztBQUFBLEVBQ3JEO0FBR0EsTUFBSSxDQUFDLE1BQU0sUUFBUSxJQUFJLEtBQUssR0FBRztBQUM3QixXQUFPLEtBQUssa0RBQWtEO0FBQUEsRUFDaEUsV0FBVyxJQUFJLE1BQU0sV0FBVyxHQUFHO0FBQ2pDLFdBQU8sS0FBSyxzQ0FBc0M7QUFBQSxFQUNwRCxPQUFPO0FBRUwsUUFBSSxrQkFBa0I7QUFFdEIsYUFBUyxJQUFJLEdBQUcsSUFBSSxJQUFJLE1BQU0sUUFBUSxLQUFLO0FBQ3pDLFlBQU0sT0FBTyxJQUFJLE1BQU0sQ0FBQztBQUN4QixVQUFJLFFBQVEsUUFBUSxPQUFPLFNBQVMsVUFBVTtBQUM1QyxlQUFPLEtBQUssaUJBQWlCLENBQUMsbUJBQW1CO0FBQ2pELDBCQUFrQjtBQUNsQjtBQUFBLE1BQ0Y7QUFHQSxVQUFJLE9BQU8sS0FBSyxPQUFPLFlB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
