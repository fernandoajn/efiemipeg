import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  return {
    root: resolve(process.cwd(), "apps/web"),
    plugins: [react()],
    build: { outDir: "../../dist/apps/web", emptyOutDir: true },
    server: {
      host: "127.0.0.1",
      port: Number(env.WEB_PORT ?? 4200),
      strictPort: true,
      proxy: { "/api": `http://127.0.0.1:${env.API_PORT ?? 3000}` },
    },
  };
});
