// Entry point of the standalone box server (plain Node, no Electron):
//   node dist/box-server/main.cjs [--data-dir <dir>] [--host <address>] [--port <n>] [--config <file>]
// See config.ts for every setting and docs/remote-box.md for deployment.
import { readFileSync } from "node:fs";
import pkg from "../../package.json";
import { readServerSettings, USAGE, UsageError } from "./config";
import { startBoxServer } from "./server";

const log = (line: string) => process.stderr.write(`box-server: ${line}\n`);

async function main(): Promise<void> {
  const settings = readServerSettings(process.env, process.argv.slice(2), (path) => readFileSync(path, "utf8"));
  const server = await startBoxServer({ settings, env: process.env, version: pkg.version, log });
  log(`box ${pkg.version} serving ${server.url} (data: ${settings.dataDir})`);
  if (server.createdTokenFile != null) log(`created a gateway token in ${server.createdTokenFile}; paste it into the app (Settings → Box) with this server's address`);
  if (!settings.admin) log("the admin endpoint is off: models and keys come only from the environment and the config file");

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log(`${signal}: stopping`);
    server.close();
    // Running turns end with the process; their transcripts were written as they streamed.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  if (error instanceof UsageError) {
    const help = error.message === USAGE;
    (help ? process.stdout : process.stderr).write(`${error.message}\n`);
    process.exit(help ? 0 : 2);
  }
  log(`failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
