import { execSync } from "node:child_process";
import { compareSemver, fetchLatestVersionFromRegistry, resolveInstallCommand } from "./update-check.js";
const NPM_PACKAGE = "gsd-pi";
async function runUpdate() {
  const current = process.env.GSD_VERSION || "0.0.0";
  const bold = "\x1B[1m";
  const dim = "\x1B[2m";
  const green = "\x1B[32m";
  const yellow = "\x1B[33m";
  const reset = "\x1B[0m";
  process.stdout.write(`${dim}Current version:${reset} v${current}
`);
  process.stdout.write(`${dim}Checking npm registry...${reset}
`);
  const latest = await fetchLatestVersionFromRegistry();
  if (!latest) {
    process.stderr.write(`${yellow}Failed to reach npm registry.${reset}
`);
    process.exit(1);
  }
  process.stdout.write(`${dim}Latest version:${reset}  v${latest}
`);
  if (compareSemver(latest, current) <= 0) {
    process.stdout.write(`${green}Already up to date.${reset}
`);
    return;
  }
  process.stdout.write(`${dim}Updating:${reset} v${current} \u2192 ${bold}v${latest}${reset}
`);
  const installCmd = resolveInstallCommand(`${NPM_PACKAGE}@latest`);
  try {
    execSync(installCmd, {
      stdio: "inherit"
    });
    process.stdout.write(`
${green}${bold}Updated to v${latest}${reset}
`);
  } catch {
    process.stderr.write(`
${yellow}Update failed. Try manually: ${installCmd}${reset}
`);
    process.exit(1);
  }
}
export {
  runUpdate
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL3VwZGF0ZS1jbWQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImltcG9ydCB7IGV4ZWNTeW5jIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJ1xuaW1wb3J0IHsgY29tcGFyZVNlbXZlciwgZmV0Y2hMYXRlc3RWZXJzaW9uRnJvbVJlZ2lzdHJ5LCByZXNvbHZlSW5zdGFsbENvbW1hbmQgfSBmcm9tICcuL3VwZGF0ZS1jaGVjay5qcydcblxuY29uc3QgTlBNX1BBQ0tBR0UgPSAnZ3NkLXBpJ1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuVXBkYXRlKCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjdXJyZW50ID0gcHJvY2Vzcy5lbnYuR1NEX1ZFUlNJT04gfHwgJzAuMC4wJ1xuICBjb25zdCBib2xkID0gJ1xceDFiWzFtJ1xuICBjb25zdCBkaW0gPSAnXFx4MWJbMm0nXG4gIGNvbnN0IGdyZWVuID0gJ1xceDFiWzMybSdcbiAgY29uc3QgeWVsbG93ID0gJ1xceDFiWzMzbSdcbiAgY29uc3QgcmVzZXQgPSAnXFx4MWJbMG0nXG5cbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7ZGltfUN1cnJlbnQgdmVyc2lvbjoke3Jlc2V0fSB2JHtjdXJyZW50fVxcbmApXG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2RpbX1DaGVja2luZyBucG0gcmVnaXN0cnkuLi4ke3Jlc2V0fVxcbmApXG5cbiAgY29uc3QgbGF0ZXN0ID0gYXdhaXQgZmV0Y2hMYXRlc3RWZXJzaW9uRnJvbVJlZ2lzdHJ5KClcbiAgaWYgKCFsYXRlc3QpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgJHt5ZWxsb3d9RmFpbGVkIHRvIHJlYWNoIG5wbSByZWdpc3RyeS4ke3Jlc2V0fVxcbmApXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cblxuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtkaW19TGF0ZXN0IHZlcnNpb246JHtyZXNldH0gIHYke2xhdGVzdH1cXG5gKVxuXG4gIGlmIChjb21wYXJlU2VtdmVyKGxhdGVzdCwgY3VycmVudCkgPD0gMCkge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2dyZWVufUFscmVhZHkgdXAgdG8gZGF0ZS4ke3Jlc2V0fVxcbmApXG4gICAgcmV0dXJuXG4gIH1cblxuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtkaW19VXBkYXRpbmc6JHtyZXNldH0gdiR7Y3VycmVudH0gXHUyMTkyICR7Ym9sZH12JHtsYXRlc3R9JHtyZXNldH1cXG5gKVxuXG4gIGNvbnN0IGluc3RhbGxDbWQgPSByZXNvbHZlSW5zdGFsbENvbW1hbmQoYCR7TlBNX1BBQ0tBR0V9QGxhdGVzdGApXG4gIHRyeSB7XG4gICAgZXhlY1N5bmMoaW5zdGFsbENtZCwge1xuICAgICAgc3RkaW86ICdpbmhlcml0JyxcbiAgICB9KVxuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGBcXG4ke2dyZWVufSR7Ym9sZH1VcGRhdGVkIHRvIHYke2xhdGVzdH0ke3Jlc2V0fVxcbmApXG4gIH0gY2F0Y2gge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBcXG4ke3llbGxvd31VcGRhdGUgZmFpbGVkLiBUcnkgbWFudWFsbHk6ICR7aW5zdGFsbENtZH0ke3Jlc2V0fVxcbmApXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsZ0JBQWdCO0FBQ3pCLFNBQVMsZUFBZSxnQ0FBZ0MsNkJBQTZCO0FBRXJGLE1BQU0sY0FBYztBQUVwQixlQUFzQixZQUEyQjtBQUMvQyxRQUFNLFVBQVUsUUFBUSxJQUFJLGVBQWU7QUFDM0MsUUFBTSxPQUFPO0FBQ2IsUUFBTSxNQUFNO0FBQ1osUUFBTSxRQUFRO0FBQ2QsUUFBTSxTQUFTO0FBQ2YsUUFBTSxRQUFRO0FBRWQsVUFBUSxPQUFPLE1BQU0sR0FBRyxHQUFHLG1CQUFtQixLQUFLLEtBQUssT0FBTztBQUFBLENBQUk7QUFDbkUsVUFBUSxPQUFPLE1BQU0sR0FBRyxHQUFHLDJCQUEyQixLQUFLO0FBQUEsQ0FBSTtBQUUvRCxRQUFNLFNBQVMsTUFBTSwrQkFBK0I7QUFDcEQsTUFBSSxDQUFDLFFBQVE7QUFDWCxZQUFRLE9BQU8sTUFBTSxHQUFHLE1BQU0sZ0NBQWdDLEtBQUs7QUFBQSxDQUFJO0FBQ3ZFLFlBQVEsS0FBSyxDQUFDO0FBQUEsRUFDaEI7QUFFQSxVQUFRLE9BQU8sTUFBTSxHQUFHLEdBQUcsa0JBQWtCLEtBQUssTUFBTSxNQUFNO0FBQUEsQ0FBSTtBQUVsRSxNQUFJLGNBQWMsUUFBUSxPQUFPLEtBQUssR0FBRztBQUN2QyxZQUFRLE9BQU8sTUFBTSxHQUFHLEtBQUssc0JBQXNCLEtBQUs7QUFBQSxDQUFJO0FBQzVEO0FBQUEsRUFDRjtBQUVBLFVBQVEsT0FBTyxNQUFNLEdBQUcsR0FBRyxZQUFZLEtBQUssS0FBSyxPQUFPLFdBQU0sSUFBSSxJQUFJLE1BQU0sR0FBRyxLQUFLO0FBQUEsQ0FBSTtBQUV4RixRQUFNLGFBQWEsc0JBQXNCLEdBQUcsV0FBVyxTQUFTO0FBQ2hFLE1BQUk7QUFDRixhQUFTLFlBQVk7QUFBQSxNQUNuQixPQUFPO0FBQUEsSUFDVCxDQUFDO0FBQ0QsWUFBUSxPQUFPLE1BQU07QUFBQSxFQUFLLEtBQUssR0FBRyxJQUFJLGVBQWUsTUFBTSxHQUFHLEtBQUs7QUFBQSxDQUFJO0FBQUEsRUFDekUsUUFBUTtBQUNOLFlBQVEsT0FBTyxNQUFNO0FBQUEsRUFBSyxNQUFNLGdDQUFnQyxVQUFVLEdBQUcsS0FBSztBQUFBLENBQUk7QUFDdEYsWUFBUSxLQUFLLENBQUM7QUFBQSxFQUNoQjtBQUNGOyIsCiAgIm5hbWVzIjogW10KfQo=
