import { fileURLToPath } from "node:url";
const ROOT = new URL("../../../../../", import.meta.url);
const PACKAGES_ROOT = fileURLToPath(new URL("packages/", ROOT));
function resolve(specifier, context, nextResolve) {
  let tsSpecifier = specifier;
  if (specifier.includes("@gsd/")) {
    tsSpecifier = specifier.replace("@gsd/", PACKAGES_ROOT).replace("/dist/", "/src/");
    if (tsSpecifier.includes("/packages/pi-ai") && !tsSpecifier.endsWith(".ts")) {
      tsSpecifier = tsSpecifier.replace(/\/packages\/pi-ai$/, "/packages/pi-ai/src/index.ts");
    } else if (!tsSpecifier.includes("/src/") && !tsSpecifier.endsWith(".ts")) {
      tsSpecifier = tsSpecifier.replace(/\/packages\/([^\/]+)$/, "/packages/$1/src/index.ts");
    } else if (!tsSpecifier.endsWith(".ts") && !tsSpecifier.endsWith(".js") && !tsSpecifier.endsWith(".mjs")) {
      tsSpecifier += "/index.ts";
    }
  } else if (specifier.endsWith(".js")) {
    tsSpecifier = specifier.replace(/\.js$/, ".ts");
  }
  return nextResolve(tsSpecifier, context);
}
export {
  resolve
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9yZXNvbHZlLXRzLWhvb2tzLm1qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gJ25vZGU6dXJsJztcblxuY29uc3QgUk9PVCA9IG5ldyBVUkwoXCIuLi8uLi8uLi8uLi8uLi9cIiwgaW1wb3J0Lm1ldGEudXJsKTtcbmNvbnN0IFBBQ0tBR0VTX1JPT1QgPSBmaWxlVVJMVG9QYXRoKG5ldyBVUkwoXCJwYWNrYWdlcy9cIiwgUk9PVCkpO1xuXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZShzcGVjaWZpZXIsIGNvbnRleHQsIG5leHRSZXNvbHZlKSB7XG4gIGxldCB0c1NwZWNpZmllciA9IHNwZWNpZmllcjtcbiAgaWYgKHNwZWNpZmllci5pbmNsdWRlcygnQGdzZC8nKSkge1xuICAgIHRzU3BlY2lmaWVyID0gc3BlY2lmaWVyLnJlcGxhY2UoJ0Bnc2QvJywgUEFDS0FHRVNfUk9PVCkucmVwbGFjZSgnL2Rpc3QvJywgJy9zcmMvJyk7XG4gICAgaWYgKHRzU3BlY2lmaWVyLmluY2x1ZGVzKCcvcGFja2FnZXMvcGktYWknKSAmJiAhdHNTcGVjaWZpZXIuZW5kc1dpdGgoJy50cycpKSB7XG4gICAgICAgIHRzU3BlY2lmaWVyID0gdHNTcGVjaWZpZXIucmVwbGFjZSgvXFwvcGFja2FnZXNcXC9waS1haSQvLCAnL3BhY2thZ2VzL3BpLWFpL3NyYy9pbmRleC50cycpO1xuICAgIH0gZWxzZSBpZiAoIXRzU3BlY2lmaWVyLmluY2x1ZGVzKCcvc3JjLycpICYmICF0c1NwZWNpZmllci5lbmRzV2l0aCgnLnRzJykpIHtcbiAgICAgICAgLy8gRmFsbGJhY2sgZm9yIG90aGVyIGdzZCBwYWNrYWdlcyBsaWtlIHBpLWNvZGluZy1hZ2VudCwgcGktdHVpLCBwaS1hZ2VudC1jb3JlXG4gICAgICAgIHRzU3BlY2lmaWVyID0gdHNTcGVjaWZpZXIucmVwbGFjZSgvXFwvcGFja2FnZXNcXC8oW15cXC9dKykkLywgJy9wYWNrYWdlcy8kMS9zcmMvaW5kZXgudHMnKTtcbiAgICB9IGVsc2UgaWYgKCF0c1NwZWNpZmllci5lbmRzV2l0aCgnLnRzJykgJiYgIXRzU3BlY2lmaWVyLmVuZHNXaXRoKCcuanMnKSAmJiAhdHNTcGVjaWZpZXIuZW5kc1dpdGgoJy5tanMnKSkge1xuICAgICAgICB0c1NwZWNpZmllciArPSAnL2luZGV4LnRzJztcbiAgICB9XG4gIH0gZWxzZSBpZiAoc3BlY2lmaWVyLmVuZHNXaXRoKCcuanMnKSkge1xuICAgIHRzU3BlY2lmaWVyID0gc3BlY2lmaWVyLnJlcGxhY2UoL1xcLmpzJC8sICcudHMnKTtcbiAgfVxuXG4gIHJldHVybiBuZXh0UmVzb2x2ZSh0c1NwZWNpZmllciwgY29udGV4dCk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLHFCQUFxQjtBQUU5QixNQUFNLE9BQU8sSUFBSSxJQUFJLG1CQUFtQixZQUFZLEdBQUc7QUFDdkQsTUFBTSxnQkFBZ0IsY0FBYyxJQUFJLElBQUksYUFBYSxJQUFJLENBQUM7QUFFdkQsU0FBUyxRQUFRLFdBQVcsU0FBUyxhQUFhO0FBQ3ZELE1BQUksY0FBYztBQUNsQixNQUFJLFVBQVUsU0FBUyxPQUFPLEdBQUc7QUFDL0Isa0JBQWMsVUFBVSxRQUFRLFNBQVMsYUFBYSxFQUFFLFFBQVEsVUFBVSxPQUFPO0FBQ2pGLFFBQUksWUFBWSxTQUFTLGlCQUFpQixLQUFLLENBQUMsWUFBWSxTQUFTLEtBQUssR0FBRztBQUN6RSxvQkFBYyxZQUFZLFFBQVEsc0JBQXNCLDhCQUE4QjtBQUFBLElBQzFGLFdBQVcsQ0FBQyxZQUFZLFNBQVMsT0FBTyxLQUFLLENBQUMsWUFBWSxTQUFTLEtBQUssR0FBRztBQUV2RSxvQkFBYyxZQUFZLFFBQVEseUJBQXlCLDJCQUEyQjtBQUFBLElBQzFGLFdBQVcsQ0FBQyxZQUFZLFNBQVMsS0FBSyxLQUFLLENBQUMsWUFBWSxTQUFTLEtBQUssS0FBSyxDQUFDLFlBQVksU0FBUyxNQUFNLEdBQUc7QUFDdEcscUJBQWU7QUFBQSxJQUNuQjtBQUFBLEVBQ0YsV0FBVyxVQUFVLFNBQVMsS0FBSyxHQUFHO0FBQ3BDLGtCQUFjLFVBQVUsUUFBUSxTQUFTLEtBQUs7QUFBQSxFQUNoRDtBQUVBLFNBQU8sWUFBWSxhQUFhLE9BQU87QUFDekM7IiwKICAibmFtZXMiOiBbXQp9Cg==
