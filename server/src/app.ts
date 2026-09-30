import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./db/client.js";
import { uploadRouter } from "./routes/upload.js";
import { overviewRouter } from "./routes/overview.js";
import { streamRouter } from "./routes/stream.js";
import { replayRouter } from "./routes/replay.js";
import { connectorsRouter } from "./routes/connectors.js";
import { simulationRouter } from "./routes/simulation.js";
import { mockApiRouter } from "./mockApi/router.js";

// Demo-only credentials for the built-in mock API. Real connectors must reference their own
// server-side environment variables (see README); these are not secrets.
process.env.MOCK_API_KEY ??= "demo-api-key-12345";
process.env.MOCK_API_BEARER_TOKEN ??= "demo-bearer-token-67890";

runMigrations();

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api/upload", uploadRouter);
app.use("/api/overview", overviewRouter);
app.use("/api/stream", streamRouter);
app.use("/api/replay", replayRouter);
app.use("/api/connectors", connectorsRouter);
app.use("/api/simulation", simulationRouter);
app.use("/mock-api", mockApiRouter);

// Serve the built web UI (npm run build) from the same origin when present.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (fs.existsSync(path.join(webDist, "index.html"))) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|mock-api).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

export { app };
