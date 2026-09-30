import { Router } from "express";
import multer from "multer";
import { CATEGORIES, getCategory } from "../ingestion/categories.js";
import { MAX_FILE_SIZE_BYTES, ParseError } from "../ingestion/parsers/index.js";
import { previewUpload, validateUpload, commitUpload, listImportBatches, getImportBatch } from "../ingestion/importService.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE_BYTES } });

export const uploadRouter = Router();

uploadRouter.get("/categories", (_req, res) => {
  res.json(Object.values(CATEGORIES));
});

uploadRouter.post("/preview", upload.single("file"), async (req, res) => {
  try {
    const category = String(req.body.category ?? "");
    if (!category) return res.status(400).json({ error: "category is required" });
    getCategory(category); // throws if unknown
    if (!req.file) return res.status(400).json({ error: "file is required" });
    const result = await previewUpload(category, req.file.originalname, req.file.buffer);
    res.json(result);
  } catch (err) {
    const status = err instanceof ParseError ? 400 : 400;
    res.status(status).json({ error: (err as Error).message });
  }
});

uploadRouter.post("/validate", (req, res) => {
  try {
    const { category, previewToken, mapping } = req.body;
    const result = validateUpload(category, previewToken, mapping);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

uploadRouter.post("/commit", (req, res) => {
  try {
    const { category, previewToken, mapping, filename } = req.body;
    const result = commitUpload(category, previewToken, mapping, filename ?? "upload");
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

uploadRouter.get("/batches", (_req, res) => {
  res.json(listImportBatches());
});

uploadRouter.get("/batches/:id", (req, res) => {
  const result = getImportBatch(req.params.id);
  if (!result) return res.status(404).json({ error: "not found" });
  res.json(result);
});
