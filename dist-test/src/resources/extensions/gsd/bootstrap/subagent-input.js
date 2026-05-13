function extractSubagentAgentClasses(input) {
  if (!input || typeof input !== "object") return [];
  const agentClasses = [];
  const visited = /* @__PURE__ */ new WeakSet();
  const addAgentClass = (value) => {
    if (typeof value !== "string") return;
    const normalized = value.trim().replace(/\.md$/i, "");
    if (normalized.length > 0) agentClasses.push(normalized);
  };
  const visitItems = (value) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      visit(item);
    }
  };
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    const record = value;
    addAgentClass(record.agent);
    visitItems(record.tasks);
    visitItems(record.chain);
    visitItems(record.parallel);
  };
  visit(input);
  return agentClasses;
}
export {
  extractSubagentAgentClasses
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9ib290c3RyYXAvc3ViYWdlbnQtaW5wdXQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImV4cG9ydCBmdW5jdGlvbiBleHRyYWN0U3ViYWdlbnRBZ2VudENsYXNzZXMoaW5wdXQ6IHVua25vd24pOiBzdHJpbmdbXSB7XG4gIGlmICghaW5wdXQgfHwgdHlwZW9mIGlucHV0ICE9PSBcIm9iamVjdFwiKSByZXR1cm4gW107XG5cbiAgY29uc3QgYWdlbnRDbGFzc2VzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB2aXNpdGVkID0gbmV3IFdlYWtTZXQ8b2JqZWN0PigpO1xuICBjb25zdCBhZGRBZ2VudENsYXNzID0gKHZhbHVlOiB1bmtub3duKTogdm9pZCA9PiB7XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIikgcmV0dXJuO1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSB2YWx1ZS50cmltKCkucmVwbGFjZSgvXFwubWQkL2ksIFwiXCIpO1xuICAgIGlmIChub3JtYWxpemVkLmxlbmd0aCA+IDApIGFnZW50Q2xhc3Nlcy5wdXNoKG5vcm1hbGl6ZWQpO1xuICB9O1xuXG4gIGNvbnN0IHZpc2l0SXRlbXMgPSAodmFsdWU6IHVua25vd24pOiB2b2lkID0+IHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm47XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIHZhbHVlKSB7XG4gICAgICB2aXNpdChpdGVtKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgdmlzaXQgPSAodmFsdWU6IHVua25vd24pOiB2b2lkID0+IHtcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIikgcmV0dXJuO1xuICAgIGlmICh2aXNpdGVkLmhhcyh2YWx1ZSkpIHJldHVybjtcbiAgICB2aXNpdGVkLmFkZCh2YWx1ZSk7XG4gICAgY29uc3QgcmVjb3JkID0gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgYWRkQWdlbnRDbGFzcyhyZWNvcmQuYWdlbnQpO1xuICAgIHZpc2l0SXRlbXMocmVjb3JkLnRhc2tzKTtcbiAgICB2aXNpdEl0ZW1zKHJlY29yZC5jaGFpbik7XG4gICAgdmlzaXRJdGVtcyhyZWNvcmQucGFyYWxsZWwpO1xuICB9O1xuXG4gIHZpc2l0KGlucHV0KTtcbiAgcmV0dXJuIGFnZW50Q2xhc3Nlcztcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFPLFNBQVMsNEJBQTRCLE9BQTBCO0FBQ3BFLE1BQUksQ0FBQyxTQUFTLE9BQU8sVUFBVSxTQUFVLFFBQU8sQ0FBQztBQUVqRCxRQUFNLGVBQXlCLENBQUM7QUFDaEMsUUFBTSxVQUFVLG9CQUFJLFFBQWdCO0FBQ3BDLFFBQU0sZ0JBQWdCLENBQUMsVUFBeUI7QUFDOUMsUUFBSSxPQUFPLFVBQVUsU0FBVTtBQUMvQixVQUFNLGFBQWEsTUFBTSxLQUFLLEVBQUUsUUFBUSxVQUFVLEVBQUU7QUFDcEQsUUFBSSxXQUFXLFNBQVMsRUFBRyxjQUFhLEtBQUssVUFBVTtBQUFBLEVBQ3pEO0FBRUEsUUFBTSxhQUFhLENBQUMsVUFBeUI7QUFDM0MsUUFBSSxDQUFDLE1BQU0sUUFBUSxLQUFLLEVBQUc7QUFDM0IsZUFBVyxRQUFRLE9BQU87QUFDeEIsWUFBTSxJQUFJO0FBQUEsSUFDWjtBQUFBLEVBQ0Y7QUFFQSxRQUFNLFFBQVEsQ0FBQyxVQUF5QjtBQUN0QyxRQUFJLENBQUMsU0FBUyxPQUFPLFVBQVUsU0FBVTtBQUN6QyxRQUFJLFFBQVEsSUFBSSxLQUFLLEVBQUc7QUFDeEIsWUFBUSxJQUFJLEtBQUs7QUFDakIsVUFBTSxTQUFTO0FBQ2Ysa0JBQWMsT0FBTyxLQUFLO0FBQzFCLGVBQVcsT0FBTyxLQUFLO0FBQ3ZCLGVBQVcsT0FBTyxLQUFLO0FBQ3ZCLGVBQVcsT0FBTyxRQUFRO0FBQUEsRUFDNUI7QUFFQSxRQUFNLEtBQUs7QUFDWCxTQUFPO0FBQ1Q7IiwKICAibmFtZXMiOiBbXQp9Cg==
