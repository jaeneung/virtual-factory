import { Router } from "express";
import { createReplaySession, listReplaySessions, getReplaySession, play, pause, reset, setSpeed } from "../replay/replayEngine.js";
import { getOverview } from "../domain/overview.js";

export const replayRouter = Router();

replayRouter.get("/", (_req, res) => res.json(listReplaySessions()));

replayRouter.post("/", (req, res) => {
  const { name, rangeFrom, rangeTo, speed } = req.body;
  if (!name || !rangeFrom || !rangeTo) return res.status(400).json({ error: "name, rangeFrom, rangeTo are required" });
  res.json(createReplaySession(name, rangeFrom, rangeTo, speed));
});

replayRouter.get("/:id", (req, res) => {
  const session = getReplaySession(req.params.id);
  if (!session) return res.status(404).json({ error: "not found" });
  res.json(session);
});

replayRouter.post("/:id/play", (req, res) => {
  try {
    res.json(play(req.params.id));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

replayRouter.post("/:id/pause", (req, res) => {
  try {
    res.json(pause(req.params.id));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

replayRouter.post("/:id/reset", (req, res) => {
  try {
    res.json(reset(req.params.id));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

replayRouter.post("/:id/speed", (req, res) => {
  try {
    res.json(setSpeed(req.params.id, Number(req.body.speed)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

replayRouter.get("/:id/overview", (req, res) => {
  const session = getReplaySession(req.params.id);
  if (!session) return res.status(404).json({ error: "not found" });
  res.json(getOverview({ from: session.range_from, asOf: session.cursor_ts }));
});
