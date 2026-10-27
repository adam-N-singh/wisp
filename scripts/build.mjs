// Builds every process bundle into dist/:
//   dist/main/main.cjs            Electron main process
//   dist/preload/*.cjs            preloads (sandboxed, so fully bundled)
//   dist/coordinator/main.cjs     node-agent-coordinator utility process
//   dist/box/main.cjs             box host utility process (agent harness + gateway)
//   dist/local-exec/main.cjs      local-exec daemon utility process
//   dist/claude-bridge/main.cjs   stdio MCP server Claude Code loads for the app's tools
//   dist/box-server/main.cjs      the box host as a standalone Node server (no Electron)
//   dist/renderer/                React UI (Vite)
//   dist/wasm/                    tree-sitter runtime + bash grammar
//   dist/assets/                  tray and app icons
// `--box-server` builds only the standalone server and the bridge it runs
// (what the Docker image needs) and leaves the rest of dist/ alone.
import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");
const boxServerOnly = process.argv.includes("--box-server");

/** The standalone server must run on plain Node: importing Electron anywhere in it fails the build. */
const noElectron = {
  name: "no-electron",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^electron$/ }, (args) => ({ errors: [{ text: `The box server can't import electron (from ${args.importer}).` }] }));
  },
};

// CommonJS bundles have no import.meta; dependencies such as web-tree-sitter
// call createRequire(import.meta.url), so main and the utility processes get
// `__import_meta_url` from __filename.
// Sandboxed preloads can't require node:url, and don't need it.
const IMPORT_META_BANNER = "const __import_meta_url = require('node:url').pathToFileURL(__filename).href;";
const nodeTarget = { platform: "node", format: "cjs", target: "node22", bundle: true, sourcemap: "linked", logLevel: "info" };

const entries = [
  { in: "src/main/main.ts", out: "dist/main/main.cjs", external: ["electron"], shim: true },
  { in: "src/preload/preload.ts", out: "dist/preload/preload.cjs", external: ["electron"], shim: false },
  { in: "src/preload/panel-preload.ts", out: "dist/preload/panel-preload.cjs", external: ["electron"], shim: false },
  { in: "src/preload/overlay-preload.ts", out: "dist/preload/overlay-preload.cjs", external: ["electron"], shim: false },
  { in: "src/preload/agent-browser-preload.ts", out: "dist/preload/agent-browser-preload.cjs", external: ["electron"], shim: false },
  { in: "src/coordinator/main.ts", out: "dist/coordinator/main.cjs", external: ["electron"], shim: true },
  { in: "src/box/main.ts", out: "dist/box/main.cjs", external: ["electron"], shim: true },
  { in: "src/local-exec/main.ts", out: "dist/local-exec/main.cjs", external: ["electron"], shim: true },
  { in: "src/claude-bridge/main.ts", out: "dist/claude-bridge/main.cjs", external: [], shim: false, boxServer: true },
  { in: "src/box-server/main.ts", out: "dist/box-server/main.cjs", external: [], shim: true, boxServer: true, plugins: [noElectron] },
];

async function buildNode() {
  const configs = entries
    .filter((entry) => !boxServerOnly || entry.boxServer)
    .map((entry) => ({
      ...nodeTarget,
      entryPoints: [join(root, entry.in)],
      outfile: join(root, entry.out),
      external: entry.external,
      plugins: entry.plugins ?? [],
      minify: production,
      ...(entry.shim ? { banner: { js: IMPORT_META_BANNER } } : {}),
      define: { ...(entry.shim ? { "import.meta.url": "__import_meta_url" } : {}), "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
    }));
  if (watch) {
    for (const config of configs) await (await context(config)).watch();
  } else {
    await Promise.all(configs.map((config) => build(config)));
  }
}

async function buildRenderer() {
  const { build: viteBuild } = await import("vite");
  await viteBuild({ configFile: join(root, "vite.config.mjs"), mode: production ? "production" : "development", build: { watch: watch ? {} : null } });
}

async function copyStatic() {
  await mkdir(join(root, "dist/wasm"), { recursive: true });
  await cp(join(root, "node_modules/web-tree-sitter/tree-sitter.wasm"), join(root, "dist/wasm/tree-sitter.wasm"));
  await cp(join(root, "node_modules/tree-sitter-bash/tree-sitter-bash.wasm"), join(root, "dist/wasm/tree-sitter-bash.wasm"));
  await cp(join(root, "assets"), join(root, "dist/assets"), { recursive: true });
}

if (boxServerOnly) {
  await buildNode();
  console.log("box server build complete");
} else {
  if (!watch) await rm(join(root, "dist"), { recursive: true, force: true });
  await copyStatic();
  await Promise.all([buildNode(), buildRenderer()]);
  if (!watch) console.log("build complete");
}
