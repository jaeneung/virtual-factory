import { app } from "./app.js";
import { resumeRunningConnectors, stopAllConnectors } from "./connectors/pollingScheduler.js";
import { startAutoEmit, stopAutoEmit } from "./mockApi/generator.js";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "127.0.0.1";
const server = app.listen(PORT, HOST, () => {
  console.log(`Virtual Factory server listening on http://localhost:${PORT}`);
  resumeRunningConnectors();
  if (process.env.MOCK_API_AUTO_EMIT !== "false") startAutoEmit();
});

function shutdown() {
  stopAllConnectors();
  stopAutoEmit();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

