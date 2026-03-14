require("dotenv").config({ override: true });

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const crypto  = require("crypto");
const multer  = require("multer");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI    = require("openai");

// ── Validate required env ──────────────────────────────────────────────────
const required = ["GOOGLE_GENERATIVE_AI_API_KEY", "ADMIN_USERNAME", "ADMIN_PASSWORD", "AUTH_SECRET"];
for (const key of required) {
  if (!process.env[key]) { console.error(`❌  ${key} is not set in .env`); process.exit(1); }
}

const app   = express();
const PORT  = process.env.PORT || 3000;
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY);

const rawClaudeKey = (process.env.ANTHROPIC_API_KEY || "").trim();
const anthropic = rawClaudeKey ? new Anthropic({ apiKey: rawClaudeKey }) : null;
if (rawClaudeKey) console.log(`🤖  Claude key loaded  → ${rawClaudeKey.slice(0, 20)}...${rawClaudeKey.slice(-4)}`);
else console.log("⚠️  No ANTHROPIC_API_KEY found in .env");

const rawGptKey = (process.env.OPENAI_API_KEY || "").trim();
const openai = rawGptKey ? new OpenAI({ apiKey: rawGptKey }) : null;
if (rawGptKey) console.log(`💬  OpenAI key loaded  → ${rawGptKey.slice(0, 20)}...`);

// ── Auth helpers ───────────────────────────────────────────────────────────
function makeToken(username) {
  return crypto.createHmac("sha256", process.env.AUTH_SECRET).update(username).digest("hex");
}
function validateToken(req) {
  const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
  return token === makeToken((process.env.ADMIN_USERNAME || "").trim());
}
function requireAuth(req, res, next) {
  if (!validateToken(req)) return res.status(401).json({ error: "Unauthorized. Please log in." });
  next();
}

// ── File upload ────────────────────────────────────────────────────────────
const ALLOWED_MIME_TYPES = ["image/jpeg","image/png","image/gif","image/webp","application/pdf","text/plain","text/csv","text/markdown"];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => ALLOWED_MIME_TYPES.includes(file.mimetype) ? cb(null, true) : cb(new Error(`Unsupported: ${file.mimetype}`)),
});

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Health ─────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

// ── Config ─────────────────────────────────────────────────────────────────
app.get("/api/config", (_req, res) => res.json({ claudeAvailable: !!anthropic, gptAvailable: !!openai }));

// ── Login ──────────────────────────────────────────────────────────────────
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const envUser = (process.env.ADMIN_USERNAME || "").trim();
  const envPass = (process.env.ADMIN_PASSWORD || "").trim();
  if (username === envUser && password === envPass) return res.json({ token: makeToken(envUser) });
  res.status(401).json({ error: "Invalid username or password." });
});

// ── Gemini ─────────────────────────────────────────────────────────────────
app.post("/api/chat", requireAuth, upload.single("file"), async (req, res) => {
  const message = (req.body.message || "").trim();
  const thinking = req.body.thinking === "true";
  let history = []; try { history = JSON.parse(req.body.history || "[]"); } catch {}
  if (!message && !req.file) return res.status(400).json({ error: "A message or file is required." });

  try {
    const generationConfig = thinking
      ? { maxOutputTokens: 16000, temperature: 1, thinkingConfig: { thinkingBudget: 8192 } }
      : { maxOutputTokens: 4096, temperature: 0.4 };

    // Enable Google Search grounding for real-time results (not compatible with thinking or file uploads)
    const modelConfig = {
      model: "gemini-3.1-pro-preview",
      generationConfig,
      systemInstruction: `You are a highly accurate AI assistant with real-time Google Search access. Follow these rules strictly:
1. Use search results to find the MOST RECENT information — always prefer the latest date.
2. For current events or real-time queries, state the date your information is from (e.g. "As of March 14, 2026"). Do NOT add a date for timeless facts (math, science constants, definitions, etc.).
3. Make precise distinctions — e.g. between "elected/designated" vs "formally sworn in".
4. If search results conflict, explain both sides and state which is more likely correct and why.
5. Give a DIRECT, CONCISE answer only — do NOT include sections like "Background", "Context", "Direct Answer", "Precise Distinctions", "Additional Info", or any other structural headings. No bullet-point breakdowns unless the question explicitly asks for a list.
6. Never state something as fact if it is still pending or unconfirmed — say "PM-designate" or "expected to" when appropriate.`,
    };
    if (!thinking && !req.file) modelConfig.tools = [{ googleSearch: {} }];
    const model = genAI.getGenerativeModel(modelConfig);

    const today = new Date().toISOString().slice(0, 10);
    const parts = [];
    if (req.file) parts.push({ inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } });
    // Prepend today's date so grounding searches for the most recent results
    const groundedMessage = req.file
      ? (message || "Please analyse this file.")
      : `[Today is ${today}] ${message}`;
    parts.push({ text: groundedMessage });

    const formattedHistory = history.filter(h => h.role && h.content).map(h => ({ role: h.role, parts: [{ text: h.content }] }));
    const result = await model.generateContent({ contents: [...formattedHistory, { role: "user", parts }] });

    const usage = result.response.usageMetadata;
    const tokens = usage ? (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0) : 0;
    res.json({ reply: result.response.text(), tokens });
  } catch (err) {
    console.error("Gemini error:", err.message);
    if (err.message?.includes("API_KEY_INVALID")) return res.status(401).json({ error: "Invalid Gemini API key." });
    if (err.message?.includes("quota") || err.message?.includes("429")) return res.status(429).json({ error: "Gemini quota exceeded." });
    res.status(500).json({ error: "Gemini request failed." });
  }
});

// ── Claude ─────────────────────────────────────────────────────────────────
app.post("/api/chat-claude", requireAuth, upload.single("file"), async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: "Claude API not configured. Add ANTHROPIC_API_KEY to .env" });
  const message = (req.body.message || "").trim();
  let history = []; try { history = JSON.parse(req.body.history || "[]"); } catch {}
  if (!message && !req.file) return res.status(400).json({ error: "A message or file is required." });

  try {
    const messages = [];
    for (const h of history.filter(h => h.role && h.content)) {
      messages.push({ role: h.role === "model" ? "assistant" : "user", content: h.content });
    }
    const content = [];
    if (req.file && req.file.mimetype.startsWith("image/")) {
      content.push({ type: "image", source: { type: "base64", media_type: req.file.mimetype, data: req.file.buffer.toString("base64") } });
    }
    content.push({ type: "text", text: message || "Please analyse this file." });
    messages.push({ role: "user", content });

    // web_search_20250305 gives Claude real-time web access (runs on Anthropic's servers)
    const result = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages,
    });
    // result.content is mixed: tool_use + tool_result + text blocks — extract only text
    const reply = result.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const tokens = result.usage ? (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0) : 0;
    res.json({ reply: reply || "No response generated.", tokens });
  } catch (err) {
    console.error("Claude error status:", err.status, "message:", err.message);
    if (err.status === 401) return res.status(401).json({ error: `Claude auth failed: ${err.message}` });
    if (err.status === 404) return res.status(404).json({ error: `Claude model not found: ${err.message}` });
    if (err.status === 429) return res.status(429).json({ error: "Claude quota exceeded." });
    res.status(500).json({ error: `Claude error (${err.status}): ${err.message}` });
  }
});

// ── ChatGPT (OpenAI) ───────────────────────────────────────────────────────
app.post("/api/chat-gpt", requireAuth, upload.single("file"), async (req, res) => {
  if (!openai) return res.status(503).json({ error: "OpenAI API not configured. Add OPENAI_API_KEY to .env" });
  const message = (req.body.message || "").trim();
  let history = []; try { history = JSON.parse(req.body.history || "[]"); } catch {}
  if (!message && !req.file) return res.status(400).json({ error: "A message or file is required." });

  try {
    const today = new Date().toISOString().slice(0, 10);
    const messages = [{
      role: "system",
      content: `You are a highly accurate AI assistant with real-time web search. Today's date is ${today}.
Follow these rules:
1. Search the web for the LATEST information before answering current-events questions.
2. Always state the date your information is from.
3. If your training data conflicts with search results, trust the search results.
4. Reason step-by-step on complex or factual questions.
5. Be explicit when you are uncertain — say so rather than guessing.`
    }];
    for (const h of history.filter(h => h.role && h.content)) {
      messages.push({ role: h.role === "model" ? "assistant" : "user", content: h.content });
    }
    const userContent = [];
    if (req.file && req.file.mimetype.startsWith("image/")) {
      userContent.push({ type: "image_url", image_url: { url: `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}` } });
    }
    userContent.push({ type: "text", text: message || "Please analyse this file." });
    messages.push({ role: "user", content: userContent.length === 1 ? userContent[0].text : userContent });

    // gpt-5-search-api has built-in real-time web search
    const result = await openai.chat.completions.create({
      model: "gpt-5-search-api",
      messages,
    });
    const tokens = result.usage ? result.usage.total_tokens : 0;
    res.json({ reply: result.choices[0].message.content, tokens });
  } catch (err) {
    console.error("OpenAI error:", err.message);
    if (err.status === 401) return res.status(401).json({ error: "Invalid OpenAI API key." });
    if (err.status === 429) return res.status(429).json({ error: "OpenAI quota exceeded." });
    res.status(500).json({ error: `OpenAI error: ${err.message}` });
  }
});

// ── Claude key debug test ──────────────────────────────────────────────────
app.get("/api/test-claude", async (_req, res) => {
  if (!rawClaudeKey) return res.json({ ok: false, error: "No API key set" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": rawClaudeKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    });
    const data = await r.json();
    res.json({ ok: r.ok, status: r.status, keyPrefix: rawClaudeKey.slice(0, 24), data });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Multer error handler ───────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message?.startsWith("Unsupported")) return res.status(400).json({ error: err.message });
  res.status(500).json({ error: "Server error." });
});

// ── Fallback ───────────────────────────────────────────────────────────────
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`✅  BK AI Agent running → http://localhost:${PORT}`);
  console.log(`🔍  Health check        → http://localhost:${PORT}/health`);
});
