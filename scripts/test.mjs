// Bundles test/unit/*.test.ts with esbuild (sources use bundler-style
// imports) and runs them with the Node test runner.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".test-dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "wasm"), { recursive: true });
cpSync(join(root, "node_modules/web-tree-sitter/tree-sitter.wasm"), join(out, "wasm/tree-sitter.wasm"));
cpSync(join(root, "node_modules/tree-sitter-bash/tree-sitter-bash.wasm"), join(out, "wasm/tree-sitter-bash.wasm"));

const tests = readdirSync(join(root, "test/unit")).filter((name) => name.endsWith(".test.ts"));
await build({
  entryPoints: tests.map((name) => join(root, "test/unit", name)),
  outdir: out,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // esbuild's API finds its binary relative to its own package, so tests load it from node_modules.
  external: ["esbuild"],
  sourcemap: "inline",
  logLevel: "warning",
  banner: { js: "const __import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  define: { "import.meta.url": "__import_meta_url", "process.env.TEST_WASM_DIR": JSON.stringify(join(out, "wasm")) },
});

const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...tests.map((name) => join(out, name.replace(/\.ts$/, ".cjs")))], { stdio: "inherit" });
process.exit(result.status ?? 1);
