import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = process.env.VF_API_PORT ?? "4000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.VF_WEB_PORT ?? 5173),
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
      "/mock-api": `http://127.0.0.1:${apiPort}`,
    },
  },
});
