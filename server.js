require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const crypto  = require("crypto");
const multer  = require("multer");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ── Validate env on startup ────────────────────────────────────────────────
const required = ["GOOGLE_GENERATIVE_AI_API_KEY", "ADMIN_USERNAME", "ADMIN_PASSWORD", "AUTH_SECRET"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌  ${key} is not set in .env`);
    process.exit(1);
  }
}

const app   = express();
const PORT  = process.env.PORT || 3000;
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY);

// ── Token helpers (stateless — works on Vercel serverless) ─────────────────
function makeToken(username) {
  return crypto
    .createHmac("sha256", process.env.AUTH_SECRET)
    .update(username)
    .digest("hex");
}

function validateToken(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.replace("Bearer ", "").trim();
  const expected = makeToken(process.env.ADMIN_USERNAME);
  return token === expected;
}

// ── File upload (4 MB — Vercel free tier limit) ────────────────────────────
const ALLOWED_MIME_TYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "application/pdf", "text/plain", "text/csv", "text/markdown",
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4 MB (Vercel compatible)
  fileFilter: (_req, file, cb) => {
    ALLOWED_MIME_TYPES.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Health check ───────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Login ──────────────────────────────────────────────────────────────────
app.post("/api/login", express.json(), (req, res) => {
  const { username, password } = req.body || {};
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    return res.json({ token: makeToken(username) });
  }
  res.status(401).json({ error: "Invalid username or password." });
});

// ── Auth middleware ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!validateToken(req)) {
    return res.status(401).json({ error: "Unauthorized. Please log in." });
  }
  next();
}

// ── Chat endpoint ──────────────────────────────────────────────────────────
app.post("/api/chat", requireAuth, upload.single("file"), async (req, res) => {
  const message = (req.body.message || "").trim();
  const thinking = req.body.thinking === "true";
  let history = [];
  try { history = JSON.parse(req.body.history || "[]"); } catch {}

  if (!message && !req.file) {
    return res.status(400).json({ error: "A message or file is required." });
  }

  try {
    const generationConfig = thinking
      ? { maxOutputTokens: 16000, temperature: 1, thinkingConfig: { thinkingBudget: 8192 } }
      : { maxOutputTokens: 2048,  temperature: 0.9 };

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", generationConfig });

    const parts = [];
    if (req.file) {
      parts.push({ inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } });
    }
    parts.push({ text: message || "Please analyse this file." });

    const formattedHistory = history
      .filter((h) => h.role && h.content)
      .map((h) => ({ role: h.role, parts: [{ text: h.content }] }));

    const result = await model.generateContent({
      contents: [...formattedHistory, { role: "user", parts }],
    });

    res.json({ reply: result.response.text() });
  } catch (err) {
    console.error("Gemini error:", err.message);
    if (err.message?.includes("API_KEY_INVALID")) return res.status(401).json({ error: "Invalid Gemini API key." });
    if (err.message?.includes("quota") || err.message?.includes("429")) return res.status(429).json({ error: "API quota exceeded. Try again shortly." });
    res.status(500).json({ error: "Gemini request failed. Please try again." });
  }
});

// ── Multer error handler ───────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message?.startsWith("Unsupported")) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: "Server error." });
});

// ── Fallback ───────────────────────────────────────────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅  BK AI Agent running → http://localhost:${PORT}`);
  console.log(`🔍  Health check        → http://localhost:${PORT}/health`);
});
