import { GSDNoProjectError, withCommandCwd } from "./context.js";
import { handleAutoCommand } from "./handlers/auto.js";
import { handleCoreCommand } from "./handlers/core.js";
import { handleOpsCommand } from "./handlers/ops.js";
import { handleParallelCommand } from "./handlers/parallel.js";
import { handleWorkflowCommand } from "./handlers/workflow.js";
async function handleGSDCommand(args, ctx, pi) {
  const trimmed = (typeof args === "string" ? args : "").trim();
  const handlers = [
    () => handleCoreCommand(trimmed, ctx, pi),
    () => handleAutoCommand(trimmed, ctx, pi),
    () => handleParallelCommand(trimmed, ctx, pi),
    () => handleWorkflowCommand(trimmed, ctx, pi),
    () => handleOpsCommand(trimmed, ctx, pi)
  ];
  let handled = false;
  try {
    handled = await withCommandCwd(ctx.cwd, async () => {
      for (const handler of handlers) {
        if (await handler()) {
          return true;
        }
      }
      return false;
    });
  } catch (err) {
    if (err instanceof GSDNoProjectError) {
      ctx.ui.notify(
        `${err.message} \`cd\` into a project directory first.`,
        "warning"
      );
      return;
    }
    throw err;
  }
  if (handled) return;
  if (trimmed.includes(" ")) {
    const { handleDo } = await import("../commands-do.js");
    await handleDo(trimmed, ctx, pi);
    return;
  }
  ctx.ui.notify(`Unknown: /gsd ${trimmed}. Run /gsd help for available commands.`, "warning");
}
export {
  handleGSDCommand
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9jb21tYW5kcy9kaXNwYXRjaGVyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSwgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcblxuaW1wb3J0IHsgR1NETm9Qcm9qZWN0RXJyb3IsIHdpdGhDb21tYW5kQ3dkIH0gZnJvbSBcIi4vY29udGV4dC5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlQXV0b0NvbW1hbmQgfSBmcm9tIFwiLi9oYW5kbGVycy9hdXRvLmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVDb3JlQ29tbWFuZCB9IGZyb20gXCIuL2hhbmRsZXJzL2NvcmUuanNcIjtcbmltcG9ydCB7IGhhbmRsZU9wc0NvbW1hbmQgfSBmcm9tIFwiLi9oYW5kbGVycy9vcHMuanNcIjtcbmltcG9ydCB7IGhhbmRsZVBhcmFsbGVsQ29tbWFuZCB9IGZyb20gXCIuL2hhbmRsZXJzL3BhcmFsbGVsLmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVXb3JrZmxvd0NvbW1hbmQgfSBmcm9tIFwiLi9oYW5kbGVycy93b3JrZmxvdy5qc1wiO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlR1NEQ29tbWFuZChcbiAgYXJnczogc3RyaW5nLFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBwaTogRXh0ZW5zaW9uQVBJLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRyaW1tZWQgPSAodHlwZW9mIGFyZ3MgPT09IFwic3RyaW5nXCIgPyBhcmdzIDogXCJcIikudHJpbSgpO1xuXG4gIGNvbnN0IGhhbmRsZXJzID0gW1xuICAgICgpID0+IGhhbmRsZUNvcmVDb21tYW5kKHRyaW1tZWQsIGN0eCwgcGkpLFxuICAgICgpID0+IGhhbmRsZUF1dG9Db21tYW5kKHRyaW1tZWQsIGN0eCwgcGkpLFxuICAgICgpID0+IGhhbmRsZVBhcmFsbGVsQ29tbWFuZCh0cmltbWVkLCBjdHgsIHBpKSxcbiAgICAoKSA9PiBoYW5kbGVXb3JrZmxvd0NvbW1hbmQodHJpbW1lZCwgY3R4LCBwaSksXG4gICAgKCkgPT4gaGFuZGxlT3BzQ29tbWFuZCh0cmltbWVkLCBjdHgsIHBpKSxcbiAgXTtcblxuICBsZXQgaGFuZGxlZCA9IGZhbHNlO1xuICB0cnkge1xuICAgIGhhbmRsZWQgPSBhd2FpdCB3aXRoQ29tbWFuZEN3ZChjdHguY3dkLCBhc3luYyAoKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IGhhbmRsZXIgb2YgaGFuZGxlcnMpIHtcbiAgICAgICAgaWYgKGF3YWl0IGhhbmRsZXIoKSkge1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmIChlcnIgaW5zdGFuY2VvZiBHU0ROb1Byb2plY3RFcnJvcikge1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgYCR7ZXJyLm1lc3NhZ2V9IFxcYGNkXFxgIGludG8gYSBwcm9qZWN0IGRpcmVjdG9yeSBmaXJzdC5gLFxuICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxuXG4gIGlmIChoYW5kbGVkKSByZXR1cm47XG5cbiAgaWYgKHRyaW1tZWQuaW5jbHVkZXMoXCIgXCIpKSB7XG4gICAgY29uc3QgeyBoYW5kbGVEbyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vY29tbWFuZHMtZG8uanNcIik7XG4gICAgYXdhaXQgaGFuZGxlRG8odHJpbW1lZCwgY3R4LCBwaSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY3R4LnVpLm5vdGlmeShgVW5rbm93bjogL2dzZCAke3RyaW1tZWR9LiBSdW4gL2dzZCBoZWxwIGZvciBhdmFpbGFibGUgY29tbWFuZHMuYCwgXCJ3YXJuaW5nXCIpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBRUEsU0FBUyxtQkFBbUIsc0JBQXNCO0FBQ2xELFNBQVMseUJBQXlCO0FBQ2xDLFNBQVMseUJBQXlCO0FBQ2xDLFNBQVMsd0JBQXdCO0FBQ2pDLFNBQVMsNkJBQTZCO0FBQ3RDLFNBQVMsNkJBQTZCO0FBRXRDLGVBQXNCLGlCQUNwQixNQUNBLEtBQ0EsSUFDZTtBQUNmLFFBQU0sV0FBVyxPQUFPLFNBQVMsV0FBVyxPQUFPLElBQUksS0FBSztBQUU1RCxRQUFNLFdBQVc7QUFBQSxJQUNmLE1BQU0sa0JBQWtCLFNBQVMsS0FBSyxFQUFFO0FBQUEsSUFDeEMsTUFBTSxrQkFBa0IsU0FBUyxLQUFLLEVBQUU7QUFBQSxJQUN4QyxNQUFNLHNCQUFzQixTQUFTLEtBQUssRUFBRTtBQUFBLElBQzVDLE1BQU0sc0JBQXNCLFNBQVMsS0FBSyxFQUFFO0FBQUEsSUFDNUMsTUFBTSxpQkFBaUIsU0FBUyxLQUFLLEVBQUU7QUFBQSxFQUN6QztBQUVBLE1BQUksVUFBVTtBQUNkLE1BQUk7QUFDRixjQUFVLE1BQU0sZUFBZSxJQUFJLEtBQUssWUFBWTtBQUNsRCxpQkFBVyxXQUFXLFVBQVU7QUFDOUIsWUFBSSxNQUFNLFFBQVEsR0FBRztBQUNuQixpQkFBTztBQUFBLFFBQ1Q7QUFBQSxNQUNGO0FBQ0EsYUFBTztBQUFBLElBQ1QsQ0FBQztBQUFBLEVBQ0gsU0FBUyxLQUFLO0FBQ1osUUFBSSxlQUFlLG1CQUFtQjtBQUNwQyxVQUFJLEdBQUc7QUFBQSxRQUNMLEdBQUcsSUFBSSxPQUFPO0FBQUEsUUFDZDtBQUFBLE1BQ0Y7QUFDQTtBQUFBLElBQ0Y7QUFDQSxVQUFNO0FBQUEsRUFDUjtBQUVBLE1BQUksUUFBUztBQUViLE1BQUksUUFBUSxTQUFTLEdBQUcsR0FBRztBQUN6QixVQUFNLEVBQUUsU0FBUyxJQUFJLE1BQU0sT0FBTyxtQkFBbUI7QUFDckQsVUFBTSxTQUFTLFNBQVMsS0FBSyxFQUFFO0FBQy9CO0FBQUEsRUFDRjtBQUVBLE1BQUksR0FBRyxPQUFPLGlCQUFpQixPQUFPLDJDQUEyQyxTQUFTO0FBQzVGOyIsCiAgIm5hbWVzIjogW10KfQo=
