const STATE_TRANSITION_MATRIX = [
  {
    from: "needs-discussion",
    event: "context-ready",
    guard: "CONTEXT artifact exists or PRD/context express path produced context",
    to: "researching",
    onFail: "needs-discussion",
    reasonCode: "state"
  },
  {
    from: "researching",
    event: "research-ready",
    guard: "RESEARCH artifact exists or research is explicitly skipped",
    to: "planning",
    onFail: "researching",
    reasonCode: "state"
  },
  {
    from: "planning",
    event: "plan-ready",
    guard: "ROADMAP/PLAN artifacts exist and plan gate passes",
    to: "executing",
    onFail: "replanning-slice",
    reasonCode: "state"
  },
  {
    from: "executing",
    event: "task-dispatched",
    guard: "task inputs are ready and dependencies are closed",
    to: "executing",
    onFail: "blocked",
    reasonCode: "dependency"
  },
  {
    from: "executing",
    event: "slice-complete",
    guard: "all slice tasks are closed and verification gate passes",
    to: "summarizing",
    onFail: "validating-milestone",
    reasonCode: "state"
  },
  {
    from: "summarizing",
    event: "summary-ready",
    guard: "SUMMARY artifact exists for the completed work unit",
    to: "validating-milestone",
    onFail: "summarizing",
    reasonCode: "state"
  },
  {
    from: "validating-milestone",
    event: "validation-pass",
    guard: "validation verdict is terminal and not remediation-required",
    to: "completing-milestone",
    onFail: "blocked",
    reasonCode: "state"
  },
  {
    from: "blocked",
    event: "recovery-plan-ready",
    guard: "reassessment produced an executable next action",
    to: "executing",
    onFail: "blocked",
    reasonCode: "recovery"
  },
  {
    from: "replanning-slice",
    event: "replan-ready",
    guard: "replacement slice/task plan exists and plan gate passes",
    to: "executing",
    onFail: "blocked",
    reasonCode: "recovery"
  },
  {
    from: "completing-milestone",
    event: "closeout-complete",
    guard: "closeout gate passes and git transaction succeeds",
    to: "complete",
    onFail: "blocked",
    reasonCode: "state"
  },
  {
    from: "*",
    event: "manual-block",
    guard: "operator or hard gate requested manual attention",
    to: "blocked",
    onFail: "manual-attention",
    reasonCode: "manual"
  },
  {
    from: "*",
    event: "retryable-failure",
    guard: "retry budget remains for failure class",
    to: "executing",
    onFail: "blocked",
    reasonCode: "retry"
  }
];
function findTransition(from, event) {
  return STATE_TRANSITION_MATRIX.find(
    (entry) => (entry.from === from || entry.from === "*") && entry.event === event
  );
}
function validateTransitionMatrix(requiredEvents) {
  const seen = /* @__PURE__ */ new Set();
  const duplicateKeys = [];
  for (const entry of STATE_TRANSITION_MATRIX) {
    const key = `${entry.from}:${entry.event}`;
    if (seen.has(key)) duplicateKeys.push(key);
    seen.add(key);
  }
  const availableEvents = new Set(STATE_TRANSITION_MATRIX.map((entry) => entry.event));
  const missingEvents = requiredEvents.filter((event) => !availableEvents.has(event));
  return {
    ok: missingEvents.length === 0 && duplicateKeys.length === 0,
    missingEvents,
    duplicateKeys
  };
}
export {
  STATE_TRANSITION_MATRIX,
  findTransition,
  validateTransitionMatrix
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9zdGF0ZS10cmFuc2l0aW9uLW1hdHJpeC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUgeyBQaGFzZSB9IGZyb20gXCIuL3R5cGVzLmpzXCI7XG5cbmV4cG9ydCB0eXBlIFN0YXRlVHJhbnNpdGlvblJlYXNvbkNvZGUgPVxuICB8IFwic3RhdGVcIlxuICB8IFwibWFudWFsXCJcbiAgfCBcInJlY292ZXJ5XCJcbiAgfCBcImRlcGVuZGVuY3lcIlxuICB8IFwicG9saWN5XCJcbiAgfCBcInJldHJ5XCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3RhdGVUcmFuc2l0aW9uRW50cnkge1xuICBmcm9tOiBQaGFzZSB8IFwiKlwiO1xuICBldmVudDogc3RyaW5nO1xuICBndWFyZDogc3RyaW5nO1xuICB0bzogUGhhc2U7XG4gIG9uRmFpbDogUGhhc2UgfCBcIm1hbnVhbC1hdHRlbnRpb25cIiB8IFwiYmxvY2tlZFwiIHwgXCJuby10cmFuc2l0aW9uXCI7XG4gIHJlYXNvbkNvZGU6IFN0YXRlVHJhbnNpdGlvblJlYXNvbkNvZGU7XG59XG5cbmV4cG9ydCBjb25zdCBTVEFURV9UUkFOU0lUSU9OX01BVFJJWDogcmVhZG9ubHkgU3RhdGVUcmFuc2l0aW9uRW50cnlbXSA9IFtcbiAge1xuICAgIGZyb206IFwibmVlZHMtZGlzY3Vzc2lvblwiLFxuICAgIGV2ZW50OiBcImNvbnRleHQtcmVhZHlcIixcbiAgICBndWFyZDogXCJDT05URVhUIGFydGlmYWN0IGV4aXN0cyBvciBQUkQvY29udGV4dCBleHByZXNzIHBhdGggcHJvZHVjZWQgY29udGV4dFwiLFxuICAgIHRvOiBcInJlc2VhcmNoaW5nXCIsXG4gICAgb25GYWlsOiBcIm5lZWRzLWRpc2N1c3Npb25cIixcbiAgICByZWFzb25Db2RlOiBcInN0YXRlXCIsXG4gIH0sXG4gIHtcbiAgICBmcm9tOiBcInJlc2VhcmNoaW5nXCIsXG4gICAgZXZlbnQ6IFwicmVzZWFyY2gtcmVhZHlcIixcbiAgICBndWFyZDogXCJSRVNFQVJDSCBhcnRpZmFjdCBleGlzdHMgb3IgcmVzZWFyY2ggaXMgZXhwbGljaXRseSBza2lwcGVkXCIsXG4gICAgdG86IFwicGxhbm5pbmdcIixcbiAgICBvbkZhaWw6IFwicmVzZWFyY2hpbmdcIixcbiAgICByZWFzb25Db2RlOiBcInN0YXRlXCIsXG4gIH0sXG4gIHtcbiAgICBmcm9tOiBcInBsYW5uaW5nXCIsXG4gICAgZXZlbnQ6IFwicGxhbi1yZWFkeVwiLFxuICAgIGd1YXJkOiBcIlJPQURNQVAvUExBTiBhcnRpZmFjdHMgZXhpc3QgYW5kIHBsYW4gZ2F0ZSBwYXNzZXNcIixcbiAgICB0bzogXCJleGVjdXRpbmdcIixcbiAgICBvbkZhaWw6IFwicmVwbGFubmluZy1zbGljZVwiLFxuICAgIHJlYXNvbkNvZGU6IFwic3RhdGVcIixcbiAgfSxcbiAge1xuICAgIGZyb206IFwiZXhlY3V0aW5nXCIsXG4gICAgZXZlbnQ6IFwidGFzay1kaXNwYXRjaGVkXCIsXG4gICAgZ3VhcmQ6IFwidGFzayBpbnB1dHMgYXJlIHJlYWR5IGFuZCBkZXBlbmRlbmNpZXMgYXJlIGNsb3NlZFwiLFxuICAgIHRvOiBcImV4ZWN1dGluZ1wiLFxuICAgIG9uRmFpbDogXCJibG9ja2VkXCIsXG4gICAgcmVhc29uQ29kZTogXCJkZXBlbmRlbmN5XCIsXG4gIH0sXG4gIHtcbiAgICBmcm9tOiBcImV4ZWN1dGluZ1wiLFxuICAgIGV2ZW50OiBcInNsaWNlLWNvbXBsZXRlXCIsXG4gICAgZ3VhcmQ6IFwiYWxsIHNsaWNlIHRhc2tzIGFyZSBjbG9zZWQgYW5kIHZlcmlmaWNhdGlvbiBnYXRlIHBhc3Nlc1wiLFxuICAgIHRvOiBcInN1bW1hcml6aW5nXCIsXG4gICAgb25GYWlsOiBcInZhbGlkYXRpbmctbWlsZXN0b25lXCIsXG4gICAgcmVhc29uQ29kZTogXCJzdGF0ZVwiLFxuICB9LFxuICB7XG4gICAgZnJvbTogXCJzdW1tYXJpemluZ1wiLFxuICAgIGV2ZW50OiBcInN1bW1hcnktcmVhZHlcIixcbiAgICBndWFyZDogXCJTVU1NQVJZIGFydGlmYWN0IGV4aXN0cyBmb3IgdGhlIGNvbXBsZXRlZCB3b3JrIHVuaXRcIixcbiAgICB0bzogXCJ2YWxpZGF0aW5nLW1pbGVzdG9uZVwiLFxuICAgIG9uRmFpbDogXCJzdW1tYXJpemluZ1wiLFxuICAgIHJlYXNvbkNvZGU6IFwic3RhdGVcIixcbiAgfSxcbiAge1xuICAgIGZyb206IFwidmFsaWRhdGluZy1taWxlc3RvbmVcIixcbiAgICBldmVudDogXCJ2YWxpZGF0aW9uLXBhc3NcIixcbiAgICBndWFyZDogXCJ2YWxpZGF0aW9uIHZlcmRpY3QgaXMgdGVybWluYWwgYW5kIG5vdCByZW1lZGlhdGlvbi1yZXF1aXJlZFwiLFxuICAgIHRvOiBcImNvbXBsZXRpbmctbWlsZXN0b25lXCIsXG4gICAgb25GYWlsOiBcImJsb2NrZWRcIixcbiAgICByZWFzb25Db2RlOiBcInN0YXRlXCIsXG4gIH0sXG4gIHtcbiAgICBmcm9tOiBcImJsb2NrZWRcIixcbiAgICBldmVudDogXCJyZWNvdmVyeS1wbGFuLXJlYWR5XCIsXG4gICAgZ3VhcmQ6IFwicmVhc3Nlc3NtZW50IHByb2R1Y2VkIGFuIGV4ZWN1dGFibGUgbmV4dCBhY3Rpb25cIixcbiAgICB0bzogXCJleGVjdXRpbmdcIixcbiAgICBvbkZhaWw6IFwiYmxvY2tlZFwiLFxuICAgIHJlYXNvbkNvZGU6IFwicmVjb3ZlcnlcIixcbiAgfSxcbiAge1xuICAgIGZyb206IFwicmVwbGFubmluZy1zbGljZVwiLFxuICAgIGV2ZW50OiBcInJlcGxhbi1yZWFkeVwiLFxuICAgIGd1YXJkOiBcInJlcGxhY2VtZW50IHNsaWNlL3Rhc2sgcGxhbiBleGlzdHMgYW5kIHBsYW4gZ2F0ZSBwYXNzZXNcIixcbiAgICB0bzogXCJleGVjdXRpbmdcIixcbiAgICBvbkZhaWw6IFwiYmxvY2tlZFwiLFxuICAgIHJlYXNvbkNvZGU6IFwicmVjb3ZlcnlcIixcbiAgfSxcbiAge1xuICAgIGZyb206IFwiY29tcGxldGluZy1taWxlc3RvbmVcIixcbiAgICBldmVudDogXCJjbG9zZW91dC1jb21wbGV0ZVwiLFxuICAgIGd1YXJkOiBcImNsb3Nlb3V0IGdhdGUgcGFzc2VzIGFuZCBnaXQgdHJhbnNhY3Rpb24gc3VjY2VlZHNcIixcbiAgICB0bzogXCJjb21wbGV0ZVwiLFxuICAgIG9uRmFpbDogXCJibG9ja2VkXCIsXG4gICAgcmVhc29uQ29kZTogXCJzdGF0ZVwiLFxuICB9LFxuICB7XG4gICAgZnJvbTogXCIqXCIsXG4gICAgZXZlbnQ6IFwibWFudWFsLWJsb2NrXCIsXG4gICAgZ3VhcmQ6IFwib3BlcmF0b3Igb3IgaGFyZCBnYXRlIHJlcXVlc3RlZCBtYW51YWwgYXR0ZW50aW9uXCIsXG4gICAgdG86IFwiYmxvY2tlZFwiLFxuICAgIG9uRmFpbDogXCJtYW51YWwtYXR0ZW50aW9uXCIsXG4gICAgcmVhc29uQ29kZTogXCJtYW51YWxcIixcbiAgfSxcbiAge1xuICAgIGZyb206IFwiKlwiLFxuICAgIGV2ZW50OiBcInJldHJ5YWJsZS1mYWlsdXJlXCIsXG4gICAgZ3VhcmQ6IFwicmV0cnkgYnVkZ2V0IHJlbWFpbnMgZm9yIGZhaWx1cmUgY2xhc3NcIixcbiAgICB0bzogXCJleGVjdXRpbmdcIixcbiAgICBvbkZhaWw6IFwiYmxvY2tlZFwiLFxuICAgIHJlYXNvbkNvZGU6IFwicmV0cnlcIixcbiAgfSxcbl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBpbnRlcmZhY2UgTWF0cml4VmFsaWRhdGlvblJlc3VsdCB7XG4gIG9rOiBib29sZWFuO1xuICBtaXNzaW5nRXZlbnRzOiBzdHJpbmdbXTtcbiAgZHVwbGljYXRlS2V5czogc3RyaW5nW107XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmaW5kVHJhbnNpdGlvbihcbiAgZnJvbTogUGhhc2UsXG4gIGV2ZW50OiBzdHJpbmcsXG4pOiBTdGF0ZVRyYW5zaXRpb25FbnRyeSB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiBTVEFURV9UUkFOU0lUSU9OX01BVFJJWC5maW5kKChlbnRyeSkgPT5cbiAgICAoZW50cnkuZnJvbSA9PT0gZnJvbSB8fCBlbnRyeS5mcm9tID09PSBcIipcIikgJiYgZW50cnkuZXZlbnQgPT09IGV2ZW50LFxuICApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVUcmFuc2l0aW9uTWF0cml4KHJlcXVpcmVkRXZlbnRzOiByZWFkb25seSBzdHJpbmdbXSk6IE1hdHJpeFZhbGlkYXRpb25SZXN1bHQge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGR1cGxpY2F0ZUtleXM6IHN0cmluZ1tdID0gW107XG5cbiAgZm9yIChjb25zdCBlbnRyeSBvZiBTVEFURV9UUkFOU0lUSU9OX01BVFJJWCkge1xuICAgIGNvbnN0IGtleSA9IGAke2VudHJ5LmZyb219OiR7ZW50cnkuZXZlbnR9YDtcbiAgICBpZiAoc2Vlbi5oYXMoa2V5KSkgZHVwbGljYXRlS2V5cy5wdXNoKGtleSk7XG4gICAgc2Vlbi5hZGQoa2V5KTtcbiAgfVxuXG4gIGNvbnN0IGF2YWlsYWJsZUV2ZW50cyA9IG5ldyBTZXQoU1RBVEVfVFJBTlNJVElPTl9NQVRSSVgubWFwKChlbnRyeSkgPT4gZW50cnkuZXZlbnQpKTtcbiAgY29uc3QgbWlzc2luZ0V2ZW50cyA9IHJlcXVpcmVkRXZlbnRzLmZpbHRlcigoZXZlbnQpID0+ICFhdmFpbGFibGVFdmVudHMuaGFzKGV2ZW50KSk7XG5cbiAgcmV0dXJuIHtcbiAgICBvazogbWlzc2luZ0V2ZW50cy5sZW5ndGggPT09IDAgJiYgZHVwbGljYXRlS2V5cy5sZW5ndGggPT09IDAsXG4gICAgbWlzc2luZ0V2ZW50cyxcbiAgICBkdXBsaWNhdGVLZXlzLFxuICB9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBbUJPLE1BQU0sMEJBQTJEO0FBQUEsRUFDdEU7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLE9BQU87QUFBQSxJQUNQLElBQUk7QUFBQSxJQUNKLFFBQVE7QUFBQSxJQUNSLFlBQVk7QUFBQSxFQUNkO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsT0FBTztBQUFBLElBQ1AsSUFBSTtBQUFBLElBQ0osUUFBUTtBQUFBLElBQ1IsWUFBWTtBQUFBLEVBQ2Q7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxPQUFPO0FBQUEsSUFDUCxJQUFJO0FBQUEsSUFDSixRQUFRO0FBQUEsSUFDUixZQUFZO0FBQUEsRUFDZDtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLE9BQU87QUFBQSxJQUNQLElBQUk7QUFBQSxJQUNKLFFBQVE7QUFBQSxJQUNSLFlBQVk7QUFBQSxFQUNkO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsT0FBTztBQUFBLElBQ1AsSUFBSTtBQUFBLElBQ0osUUFBUTtBQUFBLElBQ1IsWUFBWTtBQUFBLEVBQ2Q7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxPQUFPO0FBQUEsSUFDUCxJQUFJO0FBQUEsSUFDSixRQUFRO0FBQUEsSUFDUixZQUFZO0FBQUEsRUFDZDtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLE9BQU87QUFBQSxJQUNQLElBQUk7QUFBQSxJQUNKLFFBQVE7QUFBQSxJQUNSLFlBQVk7QUFBQSxFQUNkO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsT0FBTztBQUFBLElBQ1AsSUFBSTtBQUFBLElBQ0osUUFBUTtBQUFBLElBQ1IsWUFBWTtBQUFBLEVBQ2Q7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxPQUFPO0FBQUEsSUFDUCxJQUFJO0FBQUEsSUFDSixRQUFRO0FBQUEsSUFDUixZQUFZO0FBQUEsRUFDZDtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLE9BQU87QUFBQSxJQUNQLElBQUk7QUFBQSxJQUNKLFFBQVE7QUFBQSxJQUNSLFlBQVk7QUFBQSxFQUNkO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsT0FBTztBQUFBLElBQ1AsSUFBSTtBQUFBLElBQ0osUUFBUTtBQUFBLElBQ1IsWUFBWTtBQUFBLEVBQ2Q7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxPQUFPO0FBQUEsSUFDUCxJQUFJO0FBQUEsSUFDSixRQUFRO0FBQUEsSUFDUixZQUFZO0FBQUEsRUFDZDtBQUNGO0FBUU8sU0FBUyxlQUNkLE1BQ0EsT0FDa0M7QUFDbEMsU0FBTyx3QkFBd0I7QUFBQSxJQUFLLENBQUMsV0FDbEMsTUFBTSxTQUFTLFFBQVEsTUFBTSxTQUFTLFFBQVEsTUFBTSxVQUFVO0FBQUEsRUFDakU7QUFDRjtBQUVPLFNBQVMseUJBQXlCLGdCQUEyRDtBQUNsRyxRQUFNLE9BQU8sb0JBQUksSUFBWTtBQUM3QixRQUFNLGdCQUEwQixDQUFDO0FBRWpDLGFBQVcsU0FBUyx5QkFBeUI7QUFDM0MsVUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLElBQUksTUFBTSxLQUFLO0FBQ3hDLFFBQUksS0FBSyxJQUFJLEdBQUcsRUFBRyxlQUFjLEtBQUssR0FBRztBQUN6QyxTQUFLLElBQUksR0FBRztBQUFBLEVBQ2Q7QUFFQSxRQUFNLGtCQUFrQixJQUFJLElBQUksd0JBQXdCLElBQUksQ0FBQyxVQUFVLE1BQU0sS0FBSyxDQUFDO0FBQ25GLFFBQU0sZ0JBQWdCLGVBQWUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxnQkFBZ0IsSUFBSSxLQUFLLENBQUM7QUFFbEYsU0FBTztBQUFBLElBQ0wsSUFBSSxjQUFjLFdBQVcsS0FBSyxjQUFjLFdBQVc7QUFBQSxJQUMzRDtBQUFBLElBQ0E7QUFBQSxFQUNGO0FBQ0Y7IiwKICAibmFtZXMiOiBbXQp9Cg==
