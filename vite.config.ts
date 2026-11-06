import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Serve the same /api the production server does, straight from source.
const api = (): Plugin => ({
  name: "stribog-api",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith("/api/")) return next();
      const mod = (await server.ssrLoadModule("/src/server/server.ts")) as typeof import("./src/server/server.ts");
      if (!(await mod.handleApi(req, res))) next();
    });
  },
});

export default defineConfig({
  plugins: [react(), api()],
  server: { port: 4517, host: "127.0.0.1" },
  test: { include: ["tests/**/*.test.ts"] },
});
