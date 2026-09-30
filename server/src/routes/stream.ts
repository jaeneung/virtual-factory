import { Router } from "express";
import { subscribe } from "../realtime/sseHub.js";

export const streamRouter = Router();

streamRouter.get("/", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  const topicsParam = String(req.query.topics ?? "overview");
  const topics = topicsParam.split(",").map((t) => t.trim()) as ("overview" | `replay:${string}`)[];
  subscribe(res, topics);

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => clearInterval(keepAlive));
});
