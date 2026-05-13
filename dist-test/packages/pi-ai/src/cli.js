#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { getOAuthProvider, getOAuthProviders } from "./utils/oauth/index.js";
const AUTH_FILE = "auth.json";
const PROVIDERS = getOAuthProviders();
function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}
function loadAuth() {
  if (!existsSync(AUTH_FILE)) return {};
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
  } catch {
    return {};
  }
}
function saveAuth(auth) {
  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), "utf-8");
}
async function login(providerId) {
  const provider = getOAuthProvider(providerId);
  if (!provider) {
    console.error(`Unknown provider: ${providerId}`);
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const promptFn = (msg) => prompt(rl, `${msg} `);
  try {
    const credentials = await provider.login({
      onAuth: (info) => {
        console.log(`
Open this URL in your browser:
${info.url}`);
        if (info.instructions) console.log(info.instructions);
        console.log();
      },
      onPrompt: async (p) => {
        return await promptFn(`${p.message}${p.placeholder ? ` (${p.placeholder})` : ""}:`);
      },
      onProgress: (msg) => console.log(msg)
    });
    const auth = loadAuth();
    auth[providerId] = { type: "oauth", ...credentials };
    saveAuth(auth);
    console.log(`
Credentials saved to ${AUTH_FILE}`);
  } finally {
    rl.close();
  }
}
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    const providerList = PROVIDERS.map((p) => `  ${p.id.padEnd(20)} ${p.name}`).join("\n");
    console.log(`Usage: npx @gsd/pi-ai <command> [provider]

Commands:
  login [provider]  Login to an OAuth provider
  list              List available providers

Providers:
${providerList}

Examples:
  npx @gsd/pi-ai login              # interactive provider selection
  npx @gsd/pi-ai login anthropic    # login to specific provider
  npx @gsd/pi-ai list               # list providers
`);
    return;
  }
  if (command === "list") {
    console.log("Available OAuth providers:\n");
    for (const p of PROVIDERS) {
      console.log(`  ${p.id.padEnd(20)} ${p.name}`);
    }
    return;
  }
  if (command === "login") {
    let provider = args[1];
    if (!provider) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      console.log("Select a provider:\n");
      for (let i = 0; i < PROVIDERS.length; i++) {
        console.log(`  ${i + 1}. ${PROVIDERS[i].name}`);
      }
      console.log();
      const choice = await prompt(rl, `Enter number (1-${PROVIDERS.length}): `);
      rl.close();
      const index = parseInt(choice, 10) - 1;
      if (index < 0 || index >= PROVIDERS.length) {
        console.error("Invalid selection");
        process.exit(1);
      }
      provider = PROVIDERS[index].id;
    }
    if (!PROVIDERS.some((p) => p.id === provider)) {
      console.error(`Unknown provider: ${provider}`);
      console.error(`Use 'npx @gsd/pi-ai list' to see available providers`);
      process.exit(1);
    }
    console.log(`Logging in to ${provider}...`);
    await login(provider);
    return;
  }
  console.error(`Unknown command: ${command}`);
  console.error(`Use 'npx @gsd/pi-ai --help' for usage`);
  process.exit(1);
}
main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWkvc3JjL2NsaS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiIyEvdXNyL2Jpbi9lbnYgbm9kZVxuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwiZnNcIjtcbmltcG9ydCB7IGNyZWF0ZUludGVyZmFjZSB9IGZyb20gXCJyZWFkbGluZVwiO1xuaW1wb3J0IHsgZ2V0T0F1dGhQcm92aWRlciwgZ2V0T0F1dGhQcm92aWRlcnMgfSBmcm9tIFwiLi91dGlscy9vYXV0aC9pbmRleC5qc1wiO1xuaW1wb3J0IHR5cGUgeyBPQXV0aENyZWRlbnRpYWxzLCBPQXV0aFByb3ZpZGVySWQgfSBmcm9tIFwiLi91dGlscy9vYXV0aC90eXBlcy5qc1wiO1xuXG5jb25zdCBBVVRIX0ZJTEUgPSBcImF1dGguanNvblwiO1xuY29uc3QgUFJPVklERVJTID0gZ2V0T0F1dGhQcm92aWRlcnMoKTtcblxuZnVuY3Rpb24gcHJvbXB0KHJsOiBSZXR1cm5UeXBlPHR5cGVvZiBjcmVhdGVJbnRlcmZhY2U+LCBxdWVzdGlvbjogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcblx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBybC5xdWVzdGlvbihxdWVzdGlvbiwgcmVzb2x2ZSkpO1xufVxuXG5mdW5jdGlvbiBsb2FkQXV0aCgpOiBSZWNvcmQ8c3RyaW5nLCB7IHR5cGU6IFwib2F1dGhcIiB9ICYgT0F1dGhDcmVkZW50aWFscz4ge1xuXHRpZiAoIWV4aXN0c1N5bmMoQVVUSF9GSUxFKSkgcmV0dXJuIHt9O1xuXHR0cnkge1xuXHRcdHJldHVybiBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhBVVRIX0ZJTEUsIFwidXRmLThcIikpO1xuXHR9IGNhdGNoIHtcblx0XHRyZXR1cm4ge307XG5cdH1cbn1cblxuZnVuY3Rpb24gc2F2ZUF1dGgoYXV0aDogUmVjb3JkPHN0cmluZywgeyB0eXBlOiBcIm9hdXRoXCIgfSAmIE9BdXRoQ3JlZGVudGlhbHM+KTogdm9pZCB7XG5cdHdyaXRlRmlsZVN5bmMoQVVUSF9GSUxFLCBKU09OLnN0cmluZ2lmeShhdXRoLCBudWxsLCAyKSwgXCJ1dGYtOFwiKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9naW4ocHJvdmlkZXJJZDogT0F1dGhQcm92aWRlcklkKTogUHJvbWlzZTx2b2lkPiB7XG5cdGNvbnN0IHByb3ZpZGVyID0gZ2V0T0F1dGhQcm92aWRlcihwcm92aWRlcklkKTtcblx0aWYgKCFwcm92aWRlcikge1xuXHRcdGNvbnNvbGUuZXJyb3IoYFVua25vd24gcHJvdmlkZXI6ICR7cHJvdmlkZXJJZH1gKTtcblx0XHRwcm9jZXNzLmV4aXQoMSk7XG5cdH1cblxuXHRjb25zdCBybCA9IGNyZWF0ZUludGVyZmFjZSh7IGlucHV0OiBwcm9jZXNzLnN0ZGluLCBvdXRwdXQ6IHByb2Nlc3Muc3Rkb3V0IH0pO1xuXHRjb25zdCBwcm9tcHRGbiA9IChtc2c6IHN0cmluZykgPT4gcHJvbXB0KHJsLCBgJHttc2d9IGApO1xuXG5cdHRyeSB7XG5cdFx0Y29uc3QgY3JlZGVudGlhbHMgPSBhd2FpdCBwcm92aWRlci5sb2dpbih7XG5cdFx0XHRvbkF1dGg6IChpbmZvKSA9PiB7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGBcXG5PcGVuIHRoaXMgVVJMIGluIHlvdXIgYnJvd3NlcjpcXG4ke2luZm8udXJsfWApO1xuXHRcdFx0XHRpZiAoaW5mby5pbnN0cnVjdGlvbnMpIGNvbnNvbGUubG9nKGluZm8uaW5zdHJ1Y3Rpb25zKTtcblx0XHRcdFx0Y29uc29sZS5sb2coKTtcblx0XHRcdH0sXG5cdFx0XHRvblByb21wdDogYXN5bmMgKHApID0+IHtcblx0XHRcdFx0cmV0dXJuIGF3YWl0IHByb21wdEZuKGAke3AubWVzc2FnZX0ke3AucGxhY2Vob2xkZXIgPyBgICgke3AucGxhY2Vob2xkZXJ9KWAgOiBcIlwifTpgKTtcblx0XHRcdH0sXG5cdFx0XHRvblByb2dyZXNzOiAobXNnKSA9PiBjb25zb2xlLmxvZyhtc2cpLFxuXHRcdH0pO1xuXG5cdFx0Y29uc3QgYXV0aCA9IGxvYWRBdXRoKCk7XG5cdFx0YXV0aFtwcm92aWRlcklkXSA9IHsgdHlwZTogXCJvYXV0aFwiLCAuLi5jcmVkZW50aWFscyB9O1xuXHRcdHNhdmVBdXRoKGF1dGgpO1xuXG5cdFx0Y29uc29sZS5sb2coYFxcbkNyZWRlbnRpYWxzIHNhdmVkIHRvICR7QVVUSF9GSUxFfWApO1xuXHR9IGZpbmFsbHkge1xuXHRcdHJsLmNsb3NlKCk7XG5cdH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gbWFpbigpOiBQcm9taXNlPHZvaWQ+IHtcblx0Y29uc3QgYXJncyA9IHByb2Nlc3MuYXJndi5zbGljZSgyKTtcblx0Y29uc3QgY29tbWFuZCA9IGFyZ3NbMF07XG5cblx0aWYgKCFjb21tYW5kIHx8IGNvbW1hbmQgPT09IFwiaGVscFwiIHx8IGNvbW1hbmQgPT09IFwiLS1oZWxwXCIgfHwgY29tbWFuZCA9PT0gXCItaFwiKSB7XG5cdFx0Y29uc3QgcHJvdmlkZXJMaXN0ID0gUFJPVklERVJTLm1hcCgocCkgPT4gYCAgJHtwLmlkLnBhZEVuZCgyMCl9ICR7cC5uYW1lfWApLmpvaW4oXCJcXG5cIik7XG5cdFx0Y29uc29sZS5sb2coYFVzYWdlOiBucHggQGdzZC9waS1haSA8Y29tbWFuZD4gW3Byb3ZpZGVyXVxuXG5Db21tYW5kczpcbiAgbG9naW4gW3Byb3ZpZGVyXSAgTG9naW4gdG8gYW4gT0F1dGggcHJvdmlkZXJcbiAgbGlzdCAgICAgICAgICAgICAgTGlzdCBhdmFpbGFibGUgcHJvdmlkZXJzXG5cblByb3ZpZGVyczpcbiR7cHJvdmlkZXJMaXN0fVxuXG5FeGFtcGxlczpcbiAgbnB4IEBnc2QvcGktYWkgbG9naW4gICAgICAgICAgICAgICMgaW50ZXJhY3RpdmUgcHJvdmlkZXIgc2VsZWN0aW9uXG4gIG5weCBAZ3NkL3BpLWFpIGxvZ2luIGFudGhyb3BpYyAgICAjIGxvZ2luIHRvIHNwZWNpZmljIHByb3ZpZGVyXG4gIG5weCBAZ3NkL3BpLWFpIGxpc3QgICAgICAgICAgICAgICAjIGxpc3QgcHJvdmlkZXJzXG5gKTtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRpZiAoY29tbWFuZCA9PT0gXCJsaXN0XCIpIHtcblx0XHRjb25zb2xlLmxvZyhcIkF2YWlsYWJsZSBPQXV0aCBwcm92aWRlcnM6XFxuXCIpO1xuXHRcdGZvciAoY29uc3QgcCBvZiBQUk9WSURFUlMpIHtcblx0XHRcdGNvbnNvbGUubG9nKGAgICR7cC5pZC5wYWRFbmQoMjApfSAke3AubmFtZX1gKTtcblx0XHR9XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0aWYgKGNvbW1hbmQgPT09IFwibG9naW5cIikge1xuXHRcdGxldCBwcm92aWRlciA9IGFyZ3NbMV0gYXMgT0F1dGhQcm92aWRlcklkIHwgdW5kZWZpbmVkO1xuXG5cdFx0aWYgKCFwcm92aWRlcikge1xuXHRcdFx0Y29uc3QgcmwgPSBjcmVhdGVJbnRlcmZhY2UoeyBpbnB1dDogcHJvY2Vzcy5zdGRpbiwgb3V0cHV0OiBwcm9jZXNzLnN0ZG91dCB9KTtcblx0XHRcdGNvbnNvbGUubG9nKFwiU2VsZWN0IGEgcHJvdmlkZXI6XFxuXCIpO1xuXHRcdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBQUk9WSURFUlMubGVuZ3RoOyBpKyspIHtcblx0XHRcdFx0Y29uc29sZS5sb2coYCAgJHtpICsgMX0uICR7UFJPVklERVJTW2ldLm5hbWV9YCk7XG5cdFx0XHR9XG5cdFx0XHRjb25zb2xlLmxvZygpO1xuXG5cdFx0XHRjb25zdCBjaG9pY2UgPSBhd2FpdCBwcm9tcHQocmwsIGBFbnRlciBudW1iZXIgKDEtJHtQUk9WSURFUlMubGVuZ3RofSk6IGApO1xuXHRcdFx0cmwuY2xvc2UoKTtcblxuXHRcdFx0Y29uc3QgaW5kZXggPSBwYXJzZUludChjaG9pY2UsIDEwKSAtIDE7XG5cdFx0XHRpZiAoaW5kZXggPCAwIHx8IGluZGV4ID49IFBST1ZJREVSUy5sZW5ndGgpIHtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihcIkludmFsaWQgc2VsZWN0aW9uXCIpO1xuXHRcdFx0XHRwcm9jZXNzLmV4aXQoMSk7XG5cdFx0XHR9XG5cdFx0XHRwcm92aWRlciA9IFBST1ZJREVSU1tpbmRleF0uaWQ7XG5cdFx0fVxuXG5cdFx0aWYgKCFQUk9WSURFUlMuc29tZSgocCkgPT4gcC5pZCA9PT0gcHJvdmlkZXIpKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBVbmtub3duIHByb3ZpZGVyOiAke3Byb3ZpZGVyfWApO1xuXHRcdFx0Y29uc29sZS5lcnJvcihgVXNlICducHggQGdzZC9waS1haSBsaXN0JyB0byBzZWUgYXZhaWxhYmxlIHByb3ZpZGVyc2ApO1xuXHRcdFx0cHJvY2Vzcy5leGl0KDEpO1xuXHRcdH1cblxuXHRcdGNvbnNvbGUubG9nKGBMb2dnaW5nIGluIHRvICR7cHJvdmlkZXJ9Li4uYCk7XG5cdFx0YXdhaXQgbG9naW4ocHJvdmlkZXIpO1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGNvbnNvbGUuZXJyb3IoYFVua25vd24gY29tbWFuZDogJHtjb21tYW5kfWApO1xuXHRjb25zb2xlLmVycm9yKGBVc2UgJ25weCBAZ3NkL3BpLWFpIC0taGVscCcgZm9yIHVzYWdlYCk7XG5cdHByb2Nlc3MuZXhpdCgxKTtcbn1cblxubWFpbigpLmNhdGNoKChlcnIpID0+IHtcblx0Y29uc29sZS5lcnJvcihcIkVycm9yOlwiLCBlcnIubWVzc2FnZSk7XG5cdHByb2Nlc3MuZXhpdCgxKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUVBLFNBQVMsWUFBWSxjQUFjLHFCQUFxQjtBQUN4RCxTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLGtCQUFrQix5QkFBeUI7QUFHcEQsTUFBTSxZQUFZO0FBQ2xCLE1BQU0sWUFBWSxrQkFBa0I7QUFFcEMsU0FBUyxPQUFPLElBQXdDLFVBQW1DO0FBQzFGLFNBQU8sSUFBSSxRQUFRLENBQUMsWUFBWSxHQUFHLFNBQVMsVUFBVSxPQUFPLENBQUM7QUFDL0Q7QUFFQSxTQUFTLFdBQWlFO0FBQ3pFLE1BQUks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
