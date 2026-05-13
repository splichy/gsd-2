const DEFAULT_BASH_INTERCEPTOR_RULES = [
  {
    // cat/head/tail for file viewing — excludes heredoc syntax (cat <<)
    pattern: "^\\s*(cat(?!\\s*<<)|head|tail|less|more)\\s+",
    tool: "read",
    message: "Use the read tool to view file contents instead of shell commands."
  },
  {
    pattern: "^\\s*(grep|rg|ripgrep|ag|ack)\\s+",
    tool: "grep",
    message: "Use the grep tool for searching file contents instead of shell commands."
  },
  {
    pattern: "^\\s*(find|fd|locate)\\s+.*(-name|-iname|-type|--type|-glob)",
    tool: "find",
    message: "Use the find tool for locating files by name/type instead of shell commands."
  },
  {
    pattern: "^\\s*sed\\s+(-i|--in-place)",
    tool: "edit",
    message: "Use the edit tool for in-place file modifications instead of sed."
  },
  {
    pattern: "^\\s*perl\\s+.*-[pn]?i",
    tool: "edit",
    message: "Use the edit tool for in-place file modifications instead of perl."
  },
  {
    pattern: "^\\s*awk\\s+.*-i\\s+inplace",
    tool: "edit",
    message: "Use the edit tool for in-place file modifications instead of awk."
  },
  {
    // echo/printf/heredoc writing to a file via > (not >> append, not 2> stderr redirect)
    // Matches a single > not preceded by |, >, or a digit (fd redirect like 2>)
    pattern: "^\\s*(echo|printf|cat\\s*<<)\\s+.*(?<![|>\\d])>(?!>)\\s*\\S",
    tool: "write",
    message: "Use the write tool to create/overwrite files instead of shell redirects."
  }
];
function compileInterceptor(rules) {
  const compiled = rules.flatMap((rule) => {
    try {
      return [{ regex: new RegExp(rule.pattern, rule.flags), rule }];
    } catch {
      return [];
    }
  });
  return {
    check(command, availableTools) {
      const trimmed = command.trim();
      for (const { regex, rule } of compiled) {
        if (regex.test(trimmed) && availableTools.includes(rule.tool)) {
          return {
            block: true,
            message: `Blocked: ${rule.message}

Original command: ${command}`,
            suggestedTool: rule.tool
          };
        }
      }
      return { block: false };
    }
  };
}
function checkBashInterception(command, availableTools, rules) {
  const effectiveRules = rules ?? DEFAULT_BASH_INTERCEPTOR_RULES;
  return compileInterceptor(effectiveRules).check(command, availableTools);
}
export {
  DEFAULT_BASH_INTERCEPTOR_RULES,
  checkBashInterception,
  compileInterceptor
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL3Rvb2xzL2Jhc2gtaW50ZXJjZXB0b3IudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogQmFzaCBjb21tYW5kIGludGVyY2VwdG9yIFx1MjAxNCBibG9ja3Mgc2hlbGwgY29tbWFuZHMgdGhhdCBkdXBsaWNhdGUgZGVkaWNhdGVkIHRvb2xzLlxuICpcbiAqIEVhY2ggcnVsZSBkZWZpbmVzIGEgcmVnZXggcGF0dGVybiwgYSBzdWdnZXN0ZWQgcmVwbGFjZW1lbnQgdG9vbCwgYW5kIGEgbWVzc2FnZS5cbiAqIEEgY29tbWFuZCBpcyBvbmx5IGJsb2NrZWQgd2hlbiB0aGUgc3VnZ2VzdGVkIHRvb2wgZXhpc3RzIGluIHRoZSBzZXNzaW9uJ3MgYWN0aXZlIHRvb2wgbGlzdC5cbiAqL1xuXG5leHBvcnQgaW50ZXJmYWNlIEJhc2hJbnRlcmNlcHRvclJ1bGUge1xuXHRwYXR0ZXJuOiBzdHJpbmc7XG5cdGZsYWdzPzogc3RyaW5nO1xuXHR0b29sOiBzdHJpbmc7XG5cdG1lc3NhZ2U6IHN0cmluZztcbn1cblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfQkFTSF9JTlRFUkNFUFRPUl9SVUxFUzogQmFzaEludGVyY2VwdG9yUnVsZVtdID0gW1xuXHR7XG5cdFx0Ly8gY2F0L2hlYWQvdGFpbCBmb3IgZmlsZSB2aWV3aW5nIFx1MjAxNCBleGNsdWRlcyBoZXJlZG9jIHN5bnRheCAoY2F0IDw8KVxuXHRcdHBhdHRlcm46IFwiXlxcXFxzKihjYXQoPyFcXFxccyo8PCl8aGVhZHx0YWlsfGxlc3N8bW9yZSlcXFxccytcIixcblx0XHR0b29sOiBcInJlYWRcIixcblx0XHRtZXNzYWdlOiBcIlVzZSB0aGUgcmVhZCB0b29sIHRvIHZpZXcgZmlsZSBjb250ZW50cyBpbnN0ZWFkIG9mIHNoZWxsIGNvbW1hbmRzLlwiLFxuXHR9LFxuXHR7XG5cdFx0cGF0dGVybjogXCJeXFxcXHMqKGdyZXB8cmd8cmlwZ3JlcHxhZ3xhY2spXFxcXHMrXCIsXG5cdFx0dG9vbDogXCJncmVwXCIsXG5cdFx0bWVzc2FnZTogXCJVc2UgdGhlIGdyZXAgdG9vbCBmb3Igc2VhcmNoaW5nIGZpbGUgY29udGVudHMgaW5zdGVhZCBvZiBzaGVsbCBjb21tYW5kcy5cIixcblx0fSxcblx0e1xuXHRcdHBhdHRlcm46IFwiXlxcXFxzKihmaW5kfGZkfGxvY2F0ZSlcXFxccysuKigtbmFtZXwtaW5hbWV8LXR5cGV8LS10eXBlfC1nbG9iKVwiLFxuXHRcdHRvb2w6IFwiZmluZFwiLFxuXHRcdG1lc3NhZ2U6IFwiVXNlIHRoZSBmaW5kIHRvb2wgZm9yIGxvY2F0aW5nIGZpbGVzIGJ5IG5hbWUvdHlwZSBpbnN0ZWFkIG9mIHNoZWxsIGNvbW1hbmRzLlwiLFxuXHR9LFxuXHR7XG5cdFx0cGF0dGVybjogXCJeXFxcXHMqc2VkXFxcXHMrKC1pfC0taW4tcGxhY2UpXCIsXG5cdFx0dG9vbDogXCJlZGl0XCIsXG5cdFx0bWVzc2FnZTogXCJVc2UgdGhlIGVkaXQgdG9vbCBmb3IgaW4tcGxhY2UgZmlsZSBtb2RpZmljYXRpb25zIGluc3RlYWQgb2Ygc2VkLlwiLFxuXHR9LFxuXHR7XG5cdFx0cGF0dGVybjogXCJeXFxcXHMqcGVybFxcXFxzKy4qLVtwbl0/aVwiLFxuXHRcdHRvb2w6IFwiZWRpdFwiLFxuXHRcdG1lc3NhZ2U6IFwiVXNlIHRoZSBlZGl0IHRvb2wgZm9yIGluLXBsYWNlIGZpbGUgbW9kaWZpY2F0aW9ucyBpbnN0ZWFkIG9mIHBlcmwuXCIsXG5cdH0sXG5cdHtcblx0XHRwYXR0ZXJuOiBcIl5cXFxccyphd2tcXFxccysuKi1pXFxcXHMraW5wbGFjZVwiLFxuXHRcdHRvb2w6IFwiZWRpdFwiLFxuXHRcdG1lc3NhZ2U6IFwiVXNlIHRoZSBlZGl0IHRvb2wgZm9yIGluLXBsYWNlIGZpbGUgbW9kaWZpY2F0aW9ucyBpbnN0ZWFkIG9mIGF3ay5cIixcblx0fSxcblx0e1xuXHRcdC8vIGVjaG8vcHJpbnRmL2hlcmVkb2Mgd3JpdGluZyB0byBhIGZpbGUgdmlhID4gKG5vdCA+PiBhcHBlbmQsIG5vdCAyPiBzdGRlcnIgcmVkaXJlY3QpXG5cdFx0Ly8gTWF0Y2hlcyBhIHNpbmdsZSA+IG5vdCBwcmVjZWRlZCBieSB8LCA+LCBvciBhIGRpZ2l0IChmZCByZWRpcmVjdCBsaWtlIDI+KVxuXHRcdHBhdHRlcm46IFwiXlxcXFxzKihlY2hvfHByaW50ZnxjYXRcXFxccyo8PClcXFxccysuKig/PCFbfD5cXFxcZF0pPig/IT4pXFxcXHMqXFxcXFNcIixcblx0XHR0b29sOiBcIndyaXRlXCIsXG5cdFx0bWVzc2FnZTogXCJVc2UgdGhlIHdyaXRlIHRvb2wgdG8gY3JlYXRlL292ZXJ3cml0ZSBmaWxlcyBpbnN0ZWFkIG9mIHNoZWxsIHJlZGlyZWN0cy5cIixcblx0fSxcbl07XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW50ZXJjZXB0aW9uUmVzdWx0IHtcblx0YmxvY2s6IGJvb2xlYW47XG5cdG1lc3NhZ2U/OiBzdHJpbmc7XG5cdHN1Z2dlc3RlZFRvb2w/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tcGlsZWRJbnRlcmNlcHRvciB7XG5cdGNoZWNrOiAoY29tbWFuZDogc3RyaW5nLCBhdmFpbGFibGVUb29sczogc3RyaW5nW10pID0+IEludGVyY2VwdGlvblJlc3VsdDtcbn1cblxuLyoqXG4gKiBDb21waWxlIHJ1bGVzIGludG8gYW4gaW50ZXJjZXB0b3Igd2l0aCBwcmUtYnVpbHQgcmVnZXggb2JqZWN0cy5cbiAqIFNpbGVudGx5IHNraXBzIHJ1bGVzIHdpdGggaW52YWxpZCBwYXR0ZXJucy5cbiAqXG4gKiBQcmUtY29tcGlsaW5nIGF0IGNvbnN0cnVjdGlvbiB0aW1lIGF2b2lkcyByZXBlYXRlZCBgbmV3IFJlZ0V4cCgpYCBjYWxsc1xuICogb24gZXZlcnkgYmFzaCBjb21tYW5kIGludm9jYXRpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21waWxlSW50ZXJjZXB0b3IocnVsZXM6IEJhc2hJbnRlcmNlcHRvclJ1bGVbXSk6IENvbXBpbGVkSW50ZXJjZXB0b3Ige1xuXHRjb25zdCBjb21waWxlZCA9IHJ1bGVzLmZsYXRNYXAoKHJ1bGUpID0+IHtcblx0XHR0cnkge1xuXHRcdFx0cmV0dXJuIFt7IHJlZ2V4OiBuZXcgUmVnRXhwKHJ1bGUucGF0dGVybiwgcnVsZS5mbGFncyksIHJ1bGUgfV07XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHRyZXR1cm4gW107IC8vIHNraXAgaW52YWxpZCByZWdleFxuXHRcdH1cblx0fSk7XG5cblx0cmV0dXJuIHtcblx0XHRjaGVjayhjb21tYW5kOiBzdHJpbmcsIGF2YWlsYWJsZVRvb2xzOiBzdHJpbmdbXSk6IEludGVyY2VwdGlvblJlc3VsdCB7XG5cdFx0XHRjb25zdCB0cmltbWVkID0gY29tbWFuZC50cmltKCk7XG5cdFx0XHRmb3IgKGNvbnN0IHsgcmVnZXgsIHJ1bGUgfSBvZiBjb21waWxlZCkge1xuXHRcdFx0XHRpZiAocmVnZXgudGVzdCh0cmltbWVkKSAmJiBhdmFpbGFibGVUb29scy5pbmNsdWRlcyhydWxlLnRvb2wpKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGJsb2NrOiB0cnVlLFxuXHRcdFx0XHRcdFx0bWVzc2FnZTogYEJsb2NrZWQ6ICR7cnVsZS5tZXNzYWdlfVxcblxcbk9yaWdpbmFsIGNvbW1hbmQ6ICR7Y29tbWFuZH1gLFxuXHRcdFx0XHRcdFx0c3VnZ2VzdGVkVG9vbDogcnVsZS50b29sLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdHJldHVybiB7IGJsb2NrOiBmYWxzZSB9O1xuXHRcdH0sXG5cdH07XG59XG5cbi8qKlxuICogQ2hlY2sgd2hldGhlciBhIGJhc2ggY29tbWFuZCBzaG91bGQgYmUgaW50ZXJjZXB0ZWQuXG4gKlxuICogQ29tcGlsZXMgcnVsZXMgb24gZWFjaCBjYWxsIFx1MjAxNCBwcmVmZXIgYGNvbXBpbGVJbnRlcmNlcHRvcigpYCBmb3IgcmVwZWF0ZWQgdXNlLlxuICpcbiAqIEBwYXJhbSBjb21tYW5kIC0gVGhlIHNoZWxsIGNvbW1hbmQgdG8gY2hlY2tcbiAqIEBwYXJhbSBhdmFpbGFibGVUb29scyAtIFRvb2wgbmFtZXMgcHJlc2VudCBpbiB0aGUgY3VycmVudCBzZXNzaW9uXG4gKiBAcGFyYW0gcnVsZXMgLSBPdmVycmlkZSB0aGUgZGVmYXVsdCBydWxlIHNldCAob3B0aW9uYWwpXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjaGVja0Jhc2hJbnRlcmNlcHRpb24oXG5cdGNvbW1hbmQ6IHN0cmluZyxcblx0YXZhaWxhYmxlVG9vbHM6IHN0cmluZ1tdLFxuXHRydWxlcz86IEJhc2hJbnRlcmNlcHRvclJ1bGVbXSxcbik6IEludGVyY2VwdGlvblJlc3VsdCB7XG5cdGNvbnN0IGVmZmVjdGl2ZVJ1bGVzID0gcnVsZXMgPz8gREVGQVVMVF9CQVNIX0lOVEVSQ0VQVE9SX1JVTEVTO1xuXHRyZXR1cm4gY29tcGlsZUludGVyY2VwdG9yKGVmZmVjdGl2ZVJ1bGVzKS5jaGVjayhjb21tYW5kLCBhdmFpbGFibGVUb29scyk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFjTyxNQUFNLGlDQUF3RDtBQUFBLEVBQ3BFO0FBQUE7QUFBQSxJQUVDLFNBQVM7QUFBQSxJQUNULE1BQU07QUFBQSxJQUNOLFNBQVM7QUFBQSxFQUNWO0FBQUEsRUFDQTtBQUFBLElBQ0MsU0FBUztBQUFBLElBQ1QsTUFBTTtBQUFBLElBQ04sU0FBUztBQUFBLEVBQ1Y7QUFBQSxFQUNBO0FBQUEsSUFDQyxTQUFTO0FBQUEsSUFDVCxNQUFNO0FBQUEsSUFDTixTQUFTO0FBQUEsRUFDVjtBQUFBLEVBQ0E7QUFBQSxJQUNDLFNBQVM7QUFBQSxJQUNULE1BQU07QUFBQSxJQUNOLFNBQVM7QUFBQSxFQUNWO0FBQUEsRUFDQTtBQUFBLElBQ0MsU0FBUztBQUFBLElBQ1QsTUFBTTtBQUFBLElBQ04sU0FBUztBQUFBLEVBQ1Y7QUFBQSxFQUNBO0FBQUEsSUFDQyxTQUFTO0FBQUEsSUFDVCxNQUFNO0FBQUEsSUFDTixTQUFTO0FBQUEsRUFDVjtBQUFBLEVBQ0E7QUFBQTtBQUFBO0FBQUEsSUFHQyxTQUFTO0FBQUEsSUFDVCxNQUFNO0FBQUEsSUFDTixTQUFTO0FBQUEsRUFDVjtBQUNEO0FBbUJPLFNBQVMsbUJBQW1CLE9BQW1EO0FBQ3JGLFFBQU0sV0FBVyxNQUFNLFFBQVEsQ0FBQyxTQUFTO0FBQ3hDLFFBQUk7QUFDSCxhQUFPLENBQUMsRUFBRSxPQUFPLElBQUksT0FBTyxLQUFLLFNBQVMsS0FBSyxLQUFLLEdBQUcsS0FBSyxDQUFDO0FBQUEsSUFDOUQsUUFBUTtBQUNQLGFBQU8sQ0FBQztBQUFBLElBQ1Q7QUFBQSxFQUNELENBQUM7QUFFRCxTQUFPO0FBQUEsSUFDTixNQUFNLFNBQWlCLGdCQUE4QztBQUNwRSxZQUFNLFVBQVUsUUFBUSxLQUFLO0FBQzdCLGlCQUFXLEVBQUUsT0FBTyxLQUFLLEtBQUssVUFBVTtBQUN2QyxZQUFJLE1BQU0sS0FBSyxPQUFPLEtBQUssZUFBZSxTQUFTLEtBQUssSUFBSSxHQUFHO0FBQzlELGlCQUFPO0FBQUEsWUFDTixPQUFPO0FBQUEsWUFDUCxTQUFTLFlBQVksS0FBSyxPQUFPO0FBQUE7QUFBQSxvQkFBeUIsT0FBTztBQUFBLFlBQ2pFLGVBQWUsS0FBSztBQUFBLFVBQ3JCO0FBQUEsUUFDRDtBQUFBLE1BQ0Q7QUFDQSxhQUFPLEVBQUUsT0FBTyxNQUFNO0FBQUEsSUFDdkI7QUFBQSxFQUNEO0FBQ0Q7QUFXTyxTQUFTLHNCQUNmLFNBQ0EsZ0JBQ0EsT0FDcUI7QUFDckIsUUFBTSxpQkFBaUIsU0FBUztBQUNoQyxTQUFPLG1CQUFtQixjQUFjLEVBQUUsTUFBTSxTQUFTLGNBQWM7QUFDeEU7IiwKICAibmFtZXMiOiBbXQp9Cg==
