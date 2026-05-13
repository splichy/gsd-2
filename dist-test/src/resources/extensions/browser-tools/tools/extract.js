import { Type } from "@sinclair/typebox";
function registerExtractTools(pi, deps) {
  pi.registerTool({
    name: "browser_extract",
    label: "Browser Extract",
    description: "Extract structured data from the current page using CSS selectors and validate against a JSON Schema. Provide a schema describing the shape of data you want. The tool extracts data by evaluating CSS selectors in the page context, then validates the result against your schema. Supports extracting single objects or arrays of items. Waits for network idle before extraction.",
    parameters: Type.Object({
      schema: Type.Record(Type.String(), Type.Unknown(), {
        description: "JSON Schema describing the data shape to extract. Properties should include '_selector' (CSS selector) and '_attribute' (attribute to read, default: 'textContent') hints. Example: { type: 'object', properties: { title: { _selector: 'h1', _attribute: 'textContent' }, price: { _selector: '.price', _attribute: 'textContent' } } }"
      }),
      selector: Type.Optional(
        Type.String({ description: "CSS selector to scope extraction to a specific container element." })
      ),
      multiple: Type.Optional(
        Type.Boolean({
          description: "If true, extract an array of items. The 'selector' parameter becomes the item container selector, and schema properties are extracted relative to each matched container."
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { page: p } = await deps.ensureBrowser();
        await p.waitForLoadState("networkidle", { timeout: 1e4 }).catch(() => {
        });
        const schema = params.schema;
        const scopeSelector = params.selector;
        const multiple = params.multiple ?? false;
        const extractionPlan = buildExtractionPlan(schema);
        const rawData = await p.evaluate(
          ({ plan, scope, multi }) => {
            function extractFromContainer(container, fields) {
              const result = {};
              for (const field of fields) {
                const el = container.querySelector(field.selector);
                if (!el) {
                  result[field.name] = null;
                  continue;
                }
                let value;
                switch (field.attribute) {
                  case "textContent":
                    value = (el.textContent ?? "").trim();
                    break;
                  case "innerText":
                    value = (el.innerText ?? "").trim();
                    break;
                  case "innerHTML":
                    value = el.innerHTML;
                    break;
                  case "href":
                    value = el.href ?? el.getAttribute("href");
                    break;
                  case "src":
                    value = el.src ?? el.getAttribute("src");
                    break;
                  case "value":
                    value = el.value;
                    break;
                  default:
                    value = el.getAttribute(field.attribute) ?? (el.textContent ?? "").trim();
                }
                if (field.type === "number" && typeof value === "string") {
                  const num = parseFloat(value.replace(/[^0-9.-]/g, ""));
                  value = isNaN(num) ? value : num;
                } else if (field.type === "boolean" && typeof value === "string") {
                  value = value.toLowerCase() === "true" || value === "1";
                }
                result[field.name] = value;
              }
              return result;
            }
            const root = scope ? document.querySelector(scope) : document.body;
            if (!root) return { data: null, error: `Scope selector "${scope}" not found` };
            if (multi) {
              const containers = scope ? document.querySelectorAll(scope) : [document.body];
              const items = Array.from(containers).map(
                (container) => extractFromContainer(container, plan)
              );
              return { data: items, error: null };
            } else {
              return { data: extractFromContainer(root, plan), error: null };
            }
          },
          { plan: extractionPlan, scope: scopeSelector, multi: multiple }
        );
        if (rawData.error) {
          return {
            content: [{ type: "text", text: `Extraction failed: ${rawData.error}` }],
            details: { error: rawData.error },
            isError: true
          };
        }
        const validationErrors = await validateData(rawData.data, schema, multiple);
        const resultText = JSON.stringify(rawData.data, null, 2);
        const truncated = resultText.length > 4e3 ? resultText.slice(0, 4e3) + "\n...(truncated)" : resultText;
        return {
          content: [{
            type: "text",
            text: validationErrors.length > 0 ? `Extracted data (with ${validationErrors.length} validation warning(s)):
${truncated}

Validation warnings:
${validationErrors.join("\n")}` : `Extracted data:
${truncated}`
          }],
          details: {
            data: rawData.data,
            validationErrors: validationErrors.length > 0 ? validationErrors : void 0,
            fieldCount: extractionPlan.length,
            itemCount: multiple ? rawData.data?.length ?? 0 : 1
          }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Extraction failed: ${err.message}` }],
          details: { error: err.message },
          isError: true
        };
      }
    }
  });
}
function buildExtractionPlan(schema) {
  const fields = [];
  if (!schema || typeof schema !== "object") return fields;
  const properties = schema.properties ?? schema;
  for (const [name, propSchema] of Object.entries(properties)) {
    const prop = propSchema;
    if (!prop || typeof prop !== "object") continue;
    if (name === "type" || name === "required" || name === "properties" || name === "$schema") continue;
    const selector = prop._selector ?? prop.selector ?? `[data-field="${name}"], .${name}, #${name}`;
    const attribute = prop._attribute ?? prop.attribute ?? "textContent";
    const type = prop.type ?? "string";
    fields.push({ name, selector, attribute, type });
  }
  return fields;
}
async function validateData(data, schema, isArray) {
  const errors = [];
  try {
    const ajvModule = await import("ajv");
    const Ajv = ajvModule.default ?? ajvModule;
    const ajv = new Ajv({ allErrors: true, strict: false });
    const cleanSchema = cleanSchemaForValidation(schema);
    const validationSchema = isArray ? { type: "array", items: cleanSchema } : cleanSchema;
    const validate = ajv.compile(validationSchema);
    const valid = validate(data);
    if (!valid && validate.errors) {
      for (const err of validate.errors) {
        errors.push(`${err.instancePath || "/"}: ${err.message}`);
      }
    }
  } catch (err) {
    errors.push(`Schema validation setup failed: ${err.message}`);
  }
  return errors;
}
function cleanSchemaForValidation(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchemaForValidation);
  const cleaned = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key.startsWith("_")) continue;
    if (key === "selector" && typeof value === "string") continue;
    if (key === "attribute" && typeof value === "string") continue;
    cleaned[key] = cleanSchemaForValidation(value);
  }
  return cleaned;
}
export {
  registerExtractTools
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Jyb3dzZXItdG9vbHMvdG9vbHMvZXh0cmFjdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IFR5cGUgfSBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCB0eXBlIHsgVG9vbERlcHMgfSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcblxuLyoqXG4gKiBTdHJ1Y3R1cmVkIGRhdGEgZXh0cmFjdGlvbiB3aXRoIEpTT04gU2NoZW1hIHZhbGlkYXRpb24uXG4gKi9cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyRXh0cmFjdFRvb2xzKHBpOiBFeHRlbnNpb25BUEksIGRlcHM6IFRvb2xEZXBzKTogdm9pZCB7XG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJicm93c2VyX2V4dHJhY3RcIixcblx0XHRsYWJlbDogXCJCcm93c2VyIEV4dHJhY3RcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiRXh0cmFjdCBzdHJ1Y3R1cmVkIGRhdGEgZnJvbSB0aGUgY3VycmVudCBwYWdlIHVzaW5nIENTUyBzZWxlY3RvcnMgYW5kIHZhbGlkYXRlIGFnYWluc3QgYSBKU09OIFNjaGVtYS4gXCIgK1xuXHRcdFx0XCJQcm92aWRlIGEgc2NoZW1hIGRlc2NyaWJpbmcgdGhlIHNoYXBlIG9mIGRhdGEgeW91IHdhbnQuIFRoZSB0b29sIGV4dHJhY3RzIGRhdGEgYnkgZXZhbHVhdGluZyBcIiArXG5cdFx0XHRcIkNTUyBzZWxlY3RvcnMgaW4gdGhlIHBhZ2UgY29udGV4dCwgdGhlbiB2YWxpZGF0ZXMgdGhlIHJlc3VsdCBhZ2FpbnN0IHlvdXIgc2NoZW1hLiBcIiArXG5cdFx0XHRcIlN1cHBvcnRzIGV4dHJhY3Rpbmcgc2luZ2xlIG9iamVjdHMgb3IgYXJyYXlzIG9mIGl0ZW1zLiBXYWl0cyBmb3IgbmV0d29yayBpZGxlIGJlZm9yZSBleHRyYWN0aW9uLlwiLFxuXHRcdHBhcmFtZXRlcnM6IFR5cGUuT2JqZWN0KHtcblx0XHRcdHNjaGVtYTogVHlwZS5SZWNvcmQoVHlwZS5TdHJpbmcoKSwgVHlwZS5Vbmtub3duKCksIHtcblx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XCJKU09OIFNjaGVtYSBkZXNjcmliaW5nIHRoZSBkYXRhIHNoYXBlIHRvIGV4dHJhY3QuIFByb3BlcnRpZXMgc2hvdWxkIGluY2x1ZGUgXCIgK1xuXHRcdFx0XHRcdFwiJ19zZWxlY3RvcicgKENTUyBzZWxlY3RvcikgYW5kICdfYXR0cmlidXRlJyAoYXR0cmlidXRlIHRvIHJlYWQsIGRlZmF1bHQ6ICd0ZXh0Q29udGVudCcpIGhpbnRzLiBcIiArXG5cdFx0XHRcdFx0XCJFeGFtcGxlOiB7IHR5cGU6ICdvYmplY3QnLCBwcm9wZXJ0aWVzOiB7IHRpdGxlOiB7IF9zZWxlY3RvcjogJ2gxJywgX2F0dHJpYnV0ZTogJ3RleHRDb250ZW50JyB9LCBwcmljZTogeyBfc2VsZWN0b3I6ICcucHJpY2UnLCBfYXR0cmlidXRlOiAndGV4dENvbnRlbnQnIH0gfSB9XCIsXG5cdFx0XHR9KSxcblx0XHRcdHNlbGVjdG9yOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkNTUyBzZWxlY3RvciB0byBzY29wZSBleHRyYWN0aW9uIHRvIGEgc3BlY2lmaWMgY29udGFpbmVyIGVsZW1lbnQuXCIgfSksXG5cdFx0XHQpLFxuXHRcdFx0bXVsdGlwbGU6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuQm9vbGVhbih7XG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFx0XHRcIklmIHRydWUsIGV4dHJhY3QgYW4gYXJyYXkgb2YgaXRlbXMuIFRoZSAnc2VsZWN0b3InIHBhcmFtZXRlciBiZWNvbWVzIHRoZSBpdGVtIGNvbnRhaW5lciBzZWxlY3RvciwgXCIgK1xuXHRcdFx0XHRcdFx0XCJhbmQgc2NoZW1hIHByb3BlcnRpZXMgYXJlIGV4dHJhY3RlZCByZWxhdGl2ZSB0byBlYWNoIG1hdGNoZWQgY29udGFpbmVyLlwiLFxuXHRcdFx0XHR9KSxcblx0XHRcdCksXG5cdFx0fSksXG5cblx0XHRhc3luYyBleGVjdXRlKF90b29sQ2FsbElkLCBwYXJhbXMsIF9zaWduYWwsIF9vblVwZGF0ZSwgX2N0eCkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgeyBwYWdlOiBwIH0gPSBhd2FpdCBkZXBzLmVuc3VyZUJyb3dzZXIoKTtcblxuXHRcdFx0XHQvLyBXYWl0IGZvciBuZXR3b3JrIGlkbGUgYmVmb3JlIGV4dHJhY3Rpb25cblx0XHRcdFx0YXdhaXQgcC53YWl0Rm9yTG9hZFN0YXRlKFwibmV0d29ya2lkbGVcIiwgeyB0aW1lb3V0OiAxMDAwMCB9KS5jYXRjaCgoKSA9PiB7IC8qIG5ldHdvcmtpZGxlIHRpbWVvdXQgXHUyMDE0IG5vbi1mYXRhbCwgcGFnZSBtYXkgc3RpbGwgYmUgdXNhYmxlICovIH0pO1xuXG5cdFx0XHRcdGNvbnN0IHNjaGVtYSA9IHBhcmFtcy5zY2hlbWEgYXMgYW55O1xuXHRcdFx0XHRjb25zdCBzY29wZVNlbGVjdG9yID0gcGFyYW1zLnNlbGVjdG9yO1xuXHRcdFx0XHRjb25zdCBtdWx0aXBsZSA9IHBhcmFtcy5tdWx0aXBsZSA/PyBmYWxzZTtcblxuXHRcdFx0XHQvLyBCdWlsZCBleHRyYWN0aW9uIHBsYW4gZnJvbSBzY2hlbWFcblx0XHRcdFx0Y29uc3QgZXh0cmFjdGlvblBsYW4gPSBidWlsZEV4dHJhY3Rpb25QbGFuKHNjaGVtYSk7XG5cblx0XHRcdFx0Ly8gRXhlY3V0ZSBleHRyYWN0aW9uIGluIHBhZ2UgY29udGV4dFxuXHRcdFx0XHRjb25zdCByYXdEYXRhID0gYXdhaXQgcC5ldmFsdWF0ZShcblx0XHRcdFx0XHQoeyBwbGFuLCBzY29wZSwgbXVsdGkgfTogeyBwbGFuOiBFeHRyYWN0aW9uRmllbGRbXTsgc2NvcGU6IHN0cmluZyB8IHVuZGVmaW5lZDsgbXVsdGk6IGJvb2xlYW4gfSkgPT4ge1xuXHRcdFx0XHRcdFx0ZnVuY3Rpb24gZXh0cmFjdEZyb21Db250YWluZXIoY29udGFpbmVyOiBFbGVtZW50LCBmaWVsZHM6IHR5cGVvZiBwbGFuKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuXHRcdFx0XHRcdFx0XHRjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG5cdFx0XHRcdFx0XHRcdGZvciAoY29uc3QgZmllbGQgb2YgZmllbGRzKSB7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgZWwgPSBjb250YWluZXIucXVlcnlTZWxlY3RvcihmaWVsZC5zZWxlY3Rvcik7XG5cdFx0XHRcdFx0XHRcdFx0aWYgKCFlbCkge1xuXHRcdFx0XHRcdFx0XHRcdFx0cmVzdWx0W2ZpZWxkLm5hbWVdID0gbnVsbDtcblx0XHRcdFx0XHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHRsZXQgdmFsdWU6IHVua25vd247XG5cdFx0XHRcdFx0XHRcdFx0c3dpdGNoIChmaWVsZC5hdHRyaWJ1dGUpIHtcblx0XHRcdFx0XHRcdFx0XHRcdGNhc2UgXCJ0ZXh0Q29udGVudFwiOlxuXHRcdFx0XHRcdFx0XHRcdFx0XHR2YWx1ZSA9IChlbC50ZXh0Q29udGVudCA/PyBcIlwiKS50cmltKCk7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0XHRcdFx0Y2FzZSBcImlubmVyVGV4dFwiOlxuXHRcdFx0XHRcdFx0XHRcdFx0XHR2YWx1ZSA9ICgoZWwgYXMgSFRNTEVsZW1lbnQpLmlubmVyVGV4dCA/PyBcIlwiKS50cmltKCk7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0XHRcdFx0Y2FzZSBcImlubmVySFRNTFwiOlxuXHRcdFx0XHRcdFx0XHRcdFx0XHR2YWx1ZSA9IGVsLmlubmVySFRNTDtcblx0XHRcdFx0XHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0XHRcdFx0XHRjYXNlIFwiaHJlZlwiOlxuXHRcdFx0XHRcdFx0XHRcdFx0XHR2YWx1ZSA9IChlbCBhcyBIVE1MQW5jaG9yRWxlbWVudCkuaHJlZiA/PyBlbC5nZXRBdHRyaWJ1dGUoXCJocmVmXCIpO1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0XHRcdFx0XHRcdGNhc2UgXCJzcmNcIjpcblx0XHRcdFx0XHRcdFx0XHRcdFx0dmFsdWUgPSAoZWwgYXMgSFRNTEltYWdlRWxlbWVudCkuc3JjID8/IGVsLmdldEF0dHJpYnV0ZShcInNyY1wiKTtcblx0XHRcdFx0XHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdFx0XHRcdFx0XHRjYXNlIFwidmFsdWVcIjpcblx0XHRcdFx0XHRcdFx0XHRcdFx0dmFsdWUgPSAoZWwgYXMgSFRNTElucHV0RWxlbWVudCkudmFsdWU7XG5cdFx0XHRcdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0XHRcdFx0ZGVmYXVsdDpcblx0XHRcdFx0XHRcdFx0XHRcdFx0dmFsdWUgPSBlbC5nZXRBdHRyaWJ1dGUoZmllbGQuYXR0cmlidXRlKSA/PyAoZWwudGV4dENvbnRlbnQgPz8gXCJcIikudHJpbSgpO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0XHQvLyBUeXBlIGNvZXJjaW9uXG5cdFx0XHRcdFx0XHRcdFx0aWYgKGZpZWxkLnR5cGUgPT09IFwibnVtYmVyXCIgJiYgdHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb25zdCBudW0gPSBwYXJzZUZsb2F0KHZhbHVlLnJlcGxhY2UoL1teMC05Li1dL2csIFwiXCIpKTtcblx0XHRcdFx0XHRcdFx0XHRcdHZhbHVlID0gaXNOYU4obnVtKSA/IHZhbHVlIDogbnVtO1xuXHRcdFx0XHRcdFx0XHRcdH0gZWxzZSBpZiAoZmllbGQudHlwZSA9PT0gXCJib29sZWFuXCIgJiYgdHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHR2YWx1ZSA9IHZhbHVlLnRvTG93ZXJDYXNlKCkgPT09IFwidHJ1ZVwiIHx8IHZhbHVlID09PSBcIjFcIjtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdFx0cmVzdWx0W2ZpZWxkLm5hbWVdID0gdmFsdWU7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0cmV0dXJuIHJlc3VsdDtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Y29uc3Qgcm9vdCA9IHNjb3BlID8gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzY29wZSkgOiBkb2N1bWVudC5ib2R5O1xuXHRcdFx0XHRcdFx0aWYgKCFyb290KSByZXR1cm4geyBkYXRhOiBudWxsLCBlcnJvcjogYFNjb3BlIHNlbGVjdG9yIFwiJHtzY29wZX1cIiBub3QgZm91bmRgIH07XG5cblx0XHRcdFx0XHRcdGlmIChtdWx0aSkge1xuXHRcdFx0XHRcdFx0XHQvLyBGb3IgbXVsdGlwbGUgaXRlbXMsIHNjb3BlIGlzIHRoZSBpdGVtIHNlbGVjdG9yXG5cdFx0XHRcdFx0XHRcdGNvbnN0IGNvbnRhaW5lcnMgPSBzY29wZVxuXHRcdFx0XHRcdFx0XHRcdD8gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChzY29wZSlcblx0XHRcdFx0XHRcdFx0XHQ6IFtkb2N1bWVudC5ib2R5XTtcblx0XHRcdFx0XHRcdFx0Y29uc3QgaXRlbXMgPSBBcnJheS5mcm9tKGNvbnRhaW5lcnMpLm1hcCgoY29udGFpbmVyKSA9PlxuXHRcdFx0XHRcdFx0XHRcdGV4dHJhY3RGcm9tQ29udGFpbmVyKGNvbnRhaW5lciwgcGxhbiksXG5cdFx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB7IGRhdGE6IGl0ZW1zLCBlcnJvcjogbnVsbCB9O1xuXHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHsgZGF0YTogZXh0cmFjdEZyb21Db250YWluZXIocm9vdCwgcGxhbiksIGVycm9yOiBudWxsIH07XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XHR7IHBsYW46IGV4dHJhY3Rpb25QbGFuLCBzY29wZTogc2NvcGVTZWxlY3RvciwgbXVsdGk6IG11bHRpcGxlIH0sXG5cdFx0XHRcdCk7XG5cblx0XHRcdFx0aWYgKHJhd0RhdGEuZXJyb3IpIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBFeHRyYWN0aW9uIGZhaWxlZDogJHtyYXdEYXRhLmVycm9yfWAgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGVycm9yOiByYXdEYXRhLmVycm9yIH0sXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBWYWxpZGF0ZSBhZ2FpbnN0IHNjaGVtYSB1c2luZyBhanZcblx0XHRcdFx0Y29uc3QgdmFsaWRhdGlvbkVycm9ycyA9IGF3YWl0IHZhbGlkYXRlRGF0YShyYXdEYXRhLmRhdGEsIHNjaGVtYSwgbXVsdGlwbGUpO1xuXG5cdFx0XHRcdGNvbnN0IHJlc3VsdFRleHQgPSBKU09OLnN0cmluZ2lmeShyYXdEYXRhLmRhdGEsIG51bGwsIDIpO1xuXHRcdFx0XHRjb25zdCB0cnVuY2F0ZWQgPSByZXN1bHRUZXh0Lmxlbmd0aCA+IDQwMDAgPyByZXN1bHRUZXh0LnNsaWNlKDAsIDQwMDApICsgXCJcXG4uLi4odHJ1bmNhdGVkKVwiIDogcmVzdWx0VGV4dDtcblxuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7XG5cdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdHRleHQ6IHZhbGlkYXRpb25FcnJvcnMubGVuZ3RoID4gMFxuXHRcdFx0XHRcdFx0XHQ/IGBFeHRyYWN0ZWQgZGF0YSAod2l0aCAke3ZhbGlkYXRpb25FcnJvcnMubGVuZ3RofSB2YWxpZGF0aW9uIHdhcm5pbmcocykpOlxcbiR7dHJ1bmNhdGVkfVxcblxcblZhbGlkYXRpb24gd2FybmluZ3M6XFxuJHt2YWxpZGF0aW9uRXJyb3JzLmpvaW4oXCJcXG5cIil9YFxuXHRcdFx0XHRcdFx0XHQ6IGBFeHRyYWN0ZWQgZGF0YTpcXG4ke3RydW5jYXRlZH1gLFxuXHRcdFx0XHRcdH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IHtcblx0XHRcdFx0XHRcdGRhdGE6IHJhd0RhdGEuZGF0YSxcblx0XHRcdFx0XHRcdHZhbGlkYXRpb25FcnJvcnM6IHZhbGlkYXRpb25FcnJvcnMubGVuZ3RoID4gMCA/IHZhbGlkYXRpb25FcnJvcnMgOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0XHRmaWVsZENvdW50OiBleHRyYWN0aW9uUGxhbi5sZW5ndGgsXG5cdFx0XHRcdFx0XHRpdGVtQ291bnQ6IG11bHRpcGxlID8gKHJhd0RhdGEuZGF0YSBhcyBhbnlbXSk/Lmxlbmd0aCA/PyAwIDogMSxcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9O1xuXHRcdFx0fSBjYXRjaCAoZXJyOiBhbnkpIHtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEV4dHJhY3Rpb24gZmFpbGVkOiAke2Vyci5tZXNzYWdlfWAgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogeyBlcnJvcjogZXJyLm1lc3NhZ2UgfSxcblx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXHRcdH0sXG5cdH0pO1xufVxuXG5pbnRlcmZhY2UgRXh0cmFjdGlvbkZpZWxkIHtcblx0bmFtZTogc3RyaW5nO1xuXHRzZWxlY3Rvcjogc3RyaW5nO1xuXHRhdHRyaWJ1dGU6IHN0cmluZztcblx0dHlwZTogc3RyaW5nO1xufVxuXG5mdW5jdGlvbiBidWlsZEV4dHJhY3Rpb25QbGFuKHNjaGVtYTogYW55KTogRXh0cmFjdGlvbkZpZWxkW10ge1xuXHRjb25zdCBmaWVsZHM6IEV4dHJhY3Rpb25GaWVsZFtdID0gW107XG5cblx0aWYgKCFzY2hlbWEgfHwgdHlwZW9mIHNjaGVtYSAhPT0gXCJvYmplY3RcIikgcmV0dXJuIGZpZWxkcztcblxuXHRjb25zdCBwcm9wZXJ0aWVzID0gc2NoZW1hLnByb3BlcnRpZXMgPz8gc2NoZW1hO1xuXG5cdGZvciAoY29uc3QgW25hbWUsIHByb3BTY2hlbWFdIG9mIE9iamVjdC5lbnRyaWVzKHByb3BlcnRpZXMpKSB7XG5cdFx0Y29uc3QgcHJvcCA9IHByb3BTY2hlbWEgYXMgYW55O1xuXHRcdGlmICghcHJvcCB8fCB0eXBlb2YgcHJvcCAhPT0gXCJvYmplY3RcIikgY29udGludWU7XG5cblx0XHQvLyBTa2lwIG1ldGEgZmllbGRzXG5cdFx0aWYgKG5hbWUgPT09IFwidHlwZVwiIHx8IG5hbWUgPT09IFwicmVxdWlyZWRcIiB8fCBuYW1lID09PSBcInByb3BlcnRpZXNcIiB8fCBuYW1lID09PSBcIiRzY2hlbWFcIikgY29udGludWU7XG5cblx0XHRjb25zdCBzZWxlY3RvciA9IHByb3AuX3NlbGVjdG9yID8/IHByb3Auc2VsZWN0b3IgPz8gYFtkYXRhLWZpZWxkPVwiJHtuYW1lfVwiXSwgLiR7bmFtZX0sICMke25hbWV9YDtcblx0XHRjb25zdCBhdHRyaWJ1dGUgPSBwcm9wLl9hdHRyaWJ1dGUgPz8gcHJvcC5hdHRyaWJ1dGUgPz8gXCJ0ZXh0Q29udGVudFwiO1xuXHRcdGNvbnN0IHR5cGUgPSBwcm9wLnR5cGUgPz8gXCJzdHJpbmdcIjtcblxuXHRcdGZpZWxkcy5wdXNoKHsgbmFtZSwgc2VsZWN0b3IsIGF0dHJpYnV0ZSwgdHlwZSB9KTtcblx0fVxuXG5cdHJldHVybiBmaWVsZHM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHZhbGlkYXRlRGF0YShkYXRhOiB1bmtub3duLCBzY2hlbWE6IGFueSwgaXNBcnJheTogYm9vbGVhbik6IFByb21pc2U8c3RyaW5nW10+IHtcblx0Y29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdHRyeSB7XG5cdFx0Y29uc3QgYWp2TW9kdWxlID0gYXdhaXQgaW1wb3J0KFwiYWp2XCIpO1xuXHRcdGNvbnN0IEFqdiA9IGFqdk1vZHVsZS5kZWZhdWx0ID8/IGFqdk1vZHVsZTtcblx0XHRjb25zdCBhanYgPSBuZXcgKEFqdiBhcyBhbnkpKHsgYWxsRXJyb3JzOiB0cnVlLCBzdHJpY3Q6IGZhbHNlIH0pO1xuXG5cdFx0Ly8gQ2xlYW4gc2NoZW1hIFx1MjAxNCByZW1vdmUgb3VyIGN1c3RvbSBfc2VsZWN0b3IvX2F0dHJpYnV0ZSBoaW50cyBiZWZvcmUgdmFsaWRhdGlvblxuXHRcdGNvbnN0IGNsZWFuU2NoZW1hID0gY2xlYW5TY2hlbWFGb3JWYWxpZGF0aW9uKHNjaGVtYSk7XG5cblx0XHQvLyBXcmFwIGluIGFycmF5IHNjaGVtYSBpZiBtdWx0aXBsZVxuXHRcdGNvbnN0IHZhbGlkYXRpb25TY2hlbWEgPSBpc0FycmF5XG5cdFx0XHQ/IHsgdHlwZTogXCJhcnJheVwiLCBpdGVtczogY2xlYW5TY2hlbWEgfVxuXHRcdFx0OiBjbGVhblNjaGVtYTtcblxuXHRcdGNvbnN0IHZhbGlkYXRlID0gYWp2LmNvbXBpbGUodmFsaWRhdGlvblNjaGVtYSk7XG5cdFx0Y29uc3QgdmFsaWQgPSB2YWxpZGF0ZShkYXRhKTtcblxuXHRcdGlmICghdmFsaWQgJiYgdmFsaWRhdGUuZXJyb3JzKSB7XG5cdFx0XHRmb3IgKGNvbnN0IGVyciBvZiB2YWxpZGF0ZS5lcnJvcnMpIHtcblx0XHRcdFx0ZXJyb3JzLnB1c2goYCR7ZXJyLmluc3RhbmNlUGF0aCB8fCBcIi9cIn06ICR7ZXJyLm1lc3NhZ2V9YCk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdGVycm9ycy5wdXNoKGBTY2hlbWEgdmFsaWRhdGlvbiBzZXR1cCBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCk7XG5cdH1cblxuXHRyZXR1cm4gZXJyb3JzO1xufVxuXG5mdW5jdGlvbiBjbGVhblNjaGVtYUZvclZhbGlkYXRpb24oc2NoZW1hOiBhbnkpOiBhbnkge1xuXHRpZiAoIXNjaGVtYSB8fCB0eXBlb2Ygc2NoZW1hICE9PSBcIm9iamVjdFwiKSByZXR1cm4gc2NoZW1hO1xuXHRpZiAoQXJyYXkuaXNBcnJheShzY2hlbWEpKSByZXR1cm4gc2NoZW1hLm1hcChjbGVhblNjaGVtYUZvclZhbGlkYXRpb24pO1xuXG5cdGNvbnN0IGNsZWFuZWQ6IGFueSA9IHt9O1xuXHRmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhzY2hlbWEpKSB7XG5cdFx0aWYgKGtleS5zdGFydHNXaXRoKFwiX1wiKSkgY29udGludWU7IC8vIFJlbW92ZSBvdXIgY3VzdG9tIGhpbnRzXG5cdFx0aWYgKGtleSA9PT0gXCJzZWxlY3RvclwiICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIikgY29udGludWU7IC8vIEFsc28gcmVtb3ZlIHBsYWluICdzZWxlY3Rvcidcblx0XHRpZiAoa2V5ID09PSBcImF0dHJpYnV0ZVwiICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIikgY29udGludWU7IC8vIEFsc28gcmVtb3ZlIHBsYWluICdhdHRyaWJ1dGUnXG5cdFx0Y2xlYW5lZFtrZXldID0gY2xlYW5TY2hlbWFGb3JWYWxpZGF0aW9uKHZhbHVlKTtcblx0fVxuXHRyZXR1cm4gY2xlYW5lZDtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUNBLFNBQVMsWUFBWTtBQU9kLFNBQVMscUJBQXFCLElBQWtCLE1BQXNCO0FBQzVFLEtBQUcsYUFBYTtBQUFBLElBQ2YsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDQztBQUFBLElBSUQsWUFBWSxLQUFLLE9BQU87QUFBQSxNQUN2QixRQUFRLEtBQUssT0FBTyxLQUFLLE9BQU8sR0FBRyxLQUFLLFFBQVEsR0FBRztBQUFBLFFBQ2xELGFBQ0M7QUFBQSxNQUdGLENBQUM7QUFBQSxNQUNELFVBQVUsS0FBSztBQUFBLFFBQ2QsS0FBSyxPQUFPLEVBQUUsYUFBYSxvRUFBb0UsQ0FBQztBQUFBLE1BQ2pH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
