import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

// The renderer is loaded from file:// inside Electron, so every asset URL is relative.
export default defineConfig({
  root: join(root, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: join(root, "dist/renderer"),
    emptyOutDir: true,
    sourcemap: true,
    target: "chrome140",
    rollupOptions: {
      input: {
        index: join(root, "src/renderer/index.html"),
        panel: join(root, "src/renderer/desktop-mount/panel.html"),
        overlay: join(root, "src/renderer/desktop-mount/overlay.html"),
        agentBrowserToolbar: join(root, "src/renderer/agent-browser/toolbar.html"),
      },
    },
  },
});
