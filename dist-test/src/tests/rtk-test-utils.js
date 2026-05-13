import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function shellQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function createFakeRtk(mapping) {
  const dir = mkdtempSync(join(tmpdir(), "gsd-fake-rtk-"));
  const payload = JSON.stringify(mapping);
  const jsSource = `#!/usr/bin/env node
const mapping = ${payload};
const args = process.argv.slice(2);
const fullInput = args.join(' ');
const rewriteInput = args[0] === 'rewrite' ? args.slice(1).join(' ') : null;
const match = mapping[fullInput] ?? (rewriteInput !== null ? mapping[rewriteInput] : undefined);
if (match === undefined) process.exit(1);
if (typeof match === 'string') {
  process.stdout.write(match);
  process.exit(0);
}
if (match.stdout) process.stdout.write(match.stdout);
process.exit(match.status ?? 0);
`;
  if (process.platform === "win32") {
    const jsPath = join(dir, "fake-rtk.js");
    const cmdPath = join(dir, "rtk.cmd");
    writeFileSync(jsPath, jsSource, "utf-8");
    writeFileSync(cmdPath, `@echo off\r
"${process.execPath}" "${jsPath}" %*\r
`, "utf-8");
    return {
      path: cmdPath,
      cleanup: () => rmSync(dir, { recursive: true, force: true })
    };
  }
  const binaryPath = join(dir, "rtk");
  const cases = Object.entries(mapping).map(([key, response], index) => {
    const output = typeof response === "string" ? response : response.stdout ?? "";
    const status = typeof response === "string" ? 0 : response.status ?? 0;
    return `
if [ "$full_input" = ${shellQuote(key)} ]; then
  printf '%s' ${shellQuote(output)}
  exit ${status}
fi
if [ -n "$rewrite_input" ] && [ "$rewrite_input" = ${shellQuote(key)} ]; then
  printf '%s' ${shellQuote(output)}
  exit ${status}
fi`.trimStart();
  }).join("\n\n");
  const shellSource = `#!/bin/sh
full_input="$*"
rewrite_input=""
if [ "$1" = "rewrite" ]; then
  shift
  rewrite_input="$*"
fi

${cases}

exit 1
`;
  writeFileSync(binaryPath, shellSource, "utf-8");
  chmodSync(binaryPath, 493);
  return {
    path: binaryPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}
export {
  createFakeRtk
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3Rlc3RzL3J0ay10ZXN0LXV0aWxzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJpbXBvcnQgeyBjaG1vZFN5bmMsIG1rZHRlbXBTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmV4cG9ydCB0eXBlIEZha2VSdGtSZXNwb25zZSA9IHN0cmluZyB8IHsgc3RhdHVzPzogbnVtYmVyOyBzdGRvdXQ/OiBzdHJpbmcgfTtcblxuZnVuY3Rpb24gc2hlbGxRdW90ZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAnJHt2YWx1ZS5yZXBsYWNlKC8nL2csIGAnXFxcIidcXFwiJ2ApfSdgO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRmFrZVJ0ayhtYXBwaW5nOiBSZWNvcmQ8c3RyaW5nLCBGYWtlUnRrUmVzcG9uc2U+KTogeyBwYXRoOiBzdHJpbmc7IGNsZWFudXA6ICgpID0+IHZvaWQgfSB7XG4gIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWZha2UtcnRrLVwiKSk7XG4gIGNvbnN0IHBheWxvYWQgPSBKU09OLnN0cmluZ2lmeShtYXBwaW5nKTtcblxuICBjb25zdCBqc1NvdXJjZSA9IGAjIS91c3IvYmluL2VudiBub2RlXG5jb25zdCBtYXBwaW5nID0gJHtwYXlsb2FkfTtcbmNvbnN0IGFyZ3MgPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMik7XG5jb25zdCBmdWxsSW5wdXQgPSBhcmdzLmpvaW4oJyAnKTtcbmNvbnN0IHJld3JpdGVJbnB1dCA9IGFyZ3NbMF0gPT09ICdyZXdyaXRlJyA/IGFyZ3Muc2xpY2UoMSkuam9pbignICcpIDogbnVsbDtcbmNvbnN0IG1hdGNoID0gbWFwcGluZ1tmdWxsSW5wdXRdID8/IChyZXdyaXRlSW5wdXQgIT09IG51bGwgPyBtYXBwaW5nW3Jld3JpdGVJbnB1dF0gOiB1bmRlZmluZWQpO1xuaWYgKG1hdGNoID09PSB1bmRlZmluZWQpIHByb2Nlc3MuZXhpdCgxKTtcbmlmICh0eXBlb2YgbWF0Y2ggPT09ICdzdHJpbmcnKSB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKG1hdGNoKTtcbiAgcHJvY2Vzcy5leGl0KDApO1xufVxuaWYgKG1hdGNoLnN0ZG91dCkgcHJvY2Vzcy5zdGRvdXQud3JpdGUobWF0Y2guc3Rkb3V0KTtcbnByb2Nlc3MuZXhpdChtYXRjaC5zdGF0dXMgPz8gMCk7XG5gO1xuXG4gIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIpIHtcbiAgICBjb25zdCBqc1BhdGggPSBqb2luKGRpciwgXCJmYWtlLXJ0ay5qc1wiKTtcbiAgICBjb25zdCBjbWRQYXRoID0gam9pbihkaXIsIFwicnRrLmNtZFwiKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpzUGF0aCwganNTb3VyY2UsIFwidXRmLThcIik7XG4gICAgLy8gVXNlIHRoZSBhYnNvbHV0ZSBqc1BhdGggc28gdGhlIC5jbWQgd29ya3MgZXZlbiB3aGVuIGNvcGllZCB0byBhbm90aGVyIGRpcmVjdG9yeS5cbiAgICB3cml0ZUZpbGVTeW5jKGNtZFBhdGgsIGBAZWNobyBvZmZcXHJcXG5cIiR7cHJvY2Vzcy5leGVjUGF0aH1cIiBcIiR7anNQYXRofVwiICUqXFxyXFxuYCwgXCJ1dGYtOFwiKTtcbiAgICByZXR1cm4ge1xuICAgICAgcGF0aDogY21kUGF0aCxcbiAgICAgIGNsZWFudXA6ICgpID0+IHJtU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgYmluYXJ5UGF0aCA9IGpvaW4oZGlyLCBcInJ0a1wiKTtcbiAgY29uc3QgY2FzZXMgPSBPYmplY3QuZW50cmllcyhtYXBwaW5nKS5tYXAoKFtrZXksIHJlc3BvbnNlXSwgaW5kZXgpID0+IHtcbiAgICBjb25zdCBvdXRwdXQgPSB0eXBlb2YgcmVzcG9uc2UgPT09IFwic3RyaW5nXCIgPyByZXNwb25zZSA6IChyZXNwb25zZS5zdGRvdXQgPz8gXCJcIik7XG4gICAgY29uc3Qgc3RhdHVzID0gdHlwZW9mIHJlc3BvbnNlID09PSBcInN0cmluZ1wiID8gMCA6IChyZXNwb25zZS5zdGF0dXMgPz8gMCk7XG4gICAgcmV0dXJuIGBcbmlmIFsgXCIkZnVsbF9pbnB1dFwiID0gJHtzaGVsbFF1b3RlKGtleSl9IF07IHRoZW5cbiAgcHJpbnRmICclcycgJHtzaGVsbFF1b3RlKG91dHB1dCl9XG4gIGV4aXQgJHtzdGF0dXN9XG5maVxuaWYgWyAtbiBcIiRyZXdyaXRlX2lucHV0XCIgXSAmJiBbIFwiJHJld3JpdGVfaW5wdXRcIiA9ICR7c2hlbGxRdW90ZShrZXkpfSBdOyB0aGVuXG4gIHByaW50ZiAnJXMnICR7c2hlbGxRdW90ZShvdXRwdXQpfVxuICBleGl0ICR7c3RhdHVzfVxuZmlgLnRyaW1TdGFydCgpO1xuICB9KS5qb2luKFwiXFxuXFxuXCIpO1xuXG4gIGNvbnN0IHNoZWxsU291cmNlID0gYCMhL2Jpbi9zaFxuZnVsbF9pbnB1dD1cIiQqXCJcbnJld3JpdGVfaW5wdXQ9XCJcIlxuaWYgWyBcIiQxXCIgPSBcInJld3JpdGVcIiBdOyB0aGVuXG4gIHNoaWZ0XG4gIHJld3JpdGVfaW5wdXQ9XCIkKlwiXG5maVxuXG4ke2Nhc2VzfVxuXG5leGl0IDFcbmA7XG4gIHdyaXRlRmlsZVN5bmMoYmluYXJ5UGF0aCwgc2hlbGxTb3VyY2UsIFwidXRmLThcIik7XG4gIGNobW9kU3luYyhiaW5hcnlQYXRoLCAwbzc1NSk7XG4gIHJldHVybiB7XG4gICAgcGF0aDogYmluYXJ5UGF0aCxcbiAgICBjbGVhbnVwOiAoKSA9PiBybVN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSksXG4gIH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFBQSxTQUFTLFdBQVcsYUFBYSxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBSXJCLFNBQVMsV0FBVyxPQUF1QjtBQUN6QyxTQUFPLElBQUksTUFBTSxRQUFRLE1BQU0sT0FBUyxDQUFDO0FBQzNDO0FBRU8sU0FBUyxjQUFjLFNBQWlGO0FBQzdHLFFBQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxHQUFHLGVBQWUsQ0FBQztBQUN2RCxRQUFNLFVBQVUsS0FBSyxVQUFVLE9BQU87QUFFdEMsUUFBTSxXQUFXO0FBQUEsa0JBQ0QsT0FBTztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQWN2QixNQUFJLFFBQVEsYUFBYSxTQUFTO0FBQ2hDLFVBQU0sU0FBUyxLQUFLLEtBQUssYUFBYTtBQUN0QyxVQUFNLFVBQVUsS0FBSyxLQUFLLFNBQVM7QUFDbkMsa0JBQWMsUUFBUSxVQUFVLE9BQU87QUFFdkMsa0JBQWMsU0FBUztBQUFBLEdBQWlCLFFBQVEsUUFBUSxNQUFNLE1BQU07QUFBQSxHQUFZLE9BQU87QUFDdkYsV0FBTztBQUFBLE1BQ0wsTUFBTTtBQUFBLE1BQ04sU0FBUyxNQUFNLE9BQU8sS0FBSyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQzdEO0FBQUEsRUFDRjtBQUVBLFFBQU0sYUFBYSxLQUFLLEtBQUssS0FBSztBQUNsQyxRQUFNLFFBQVEsT0FBTyxRQUFRLE9BQU8sRUFBRSxJQUFJLENBQUMsQ0FBQyxLQUFLLFFBQVEsR0FBRyxVQUFVO0FBQ3BFLFVBQU0sU0FBUyxPQUFPLGFBQWEsV0FBVyxXQUFZLFNBQVMsVUFBVTtBQUM3RSxVQUFNLFNBQVMsT0FBTyxhQUFhLFdBQVcsSUFBSyxTQUFTLFVBQVU7QUFDdEUsV0FBTztBQUFBLHVCQUNZLFdBQVcsR0FBRyxDQUFDO0FBQUEsZ0JBQ3RCLFdBQVcsTUFBTSxDQUFDO0FBQUEsU0FDekIsTUFBTTtBQUFBO0FBQUEscURBRXNDLFdBQVcsR0FBRyxDQUFDO0FBQUEsZ0JBQ3BELFdBQVcsTUFBTSxDQUFDO0FBQUEsU0FDekIsTUFBTTtBQUFBLElBQ1gsVUFBVTtBQUFBLEVBQ1osQ0FBQyxFQUFFLEtBQUssTUFBTTtBQUVkLFFBQU0sY0FBYztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFRcEIsS0FBSztBQUFBO0FBQUE7QUFBQTtBQUlMLGdCQUFjLFlBQVksYUFBYSxPQUFPO0FBQzlDLFlBQVUsWUFBWSxHQUFLO0FBQzNCLFNBQU87QUFBQSxJQUNMLE1BQU07QUFBQSxJQUNOLFNBQVMsTUFBTSxPQUFPLEtBQUssRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUM3RDtBQUNGOyIsCiAgIm5hbWVzIjogW10KfQo=
