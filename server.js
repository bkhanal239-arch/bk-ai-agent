require("dotenv").config({ override: true });

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const crypto  = require("crypto");
const fs      = require("fs");
const multer  = require("multer");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Anthropic = require("@anthropic-ai/sdk");
const OpenAI    = require("openai");
const Stripe    = require("stripe");
const bcrypt    = require("bcrypt");

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
if (rawClaudeKey) console.log(`🤖  Claude key loaded    → ${rawClaudeKey.slice(0,20)}...${rawClaudeKey.slice(-4)}`);
else              console.log("⚠️   No ANTHROPIC_API_KEY found");

const rawGptKey = (process.env.OPENAI_API_KEY || "").trim();
const openai = rawGptKey ? new OpenAI({ apiKey: rawGptKey }) : null;
if (rawGptKey) console.log(`💬  OpenAI key loaded    → ${rawGptKey.slice(0,20)}...`);
else           console.log("⚠️   No OPENAI_API_KEY found");

const rawDeepSeekKey = (process.env.DEEPSEEK_API_KEY || "").trim();
const deepseek = (rawDeepSeekKey && rawDeepSeekKey !== "your_deepseek_api_key_here")
  ? new OpenAI({ apiKey: rawDeepSeekKey, baseURL: "https://api.deepseek.com" })
  : null;
if (deepseek) console.log(`🔵  DeepSeek key loaded  → ${rawDeepSeekKey.slice(0,20)}...`);
else          console.log("⚠️   No DEEPSEEK_API_KEY found");

const rawStripeKey = (process.env.STRIPE_SECRET_KEY || "").trim();
const stripe = rawStripeKey ? new Stripe(rawStripeKey, { apiVersion:"2024-04-10" }) : null;
if (stripe) console.log(`💳  Stripe loaded        → ${rawStripeKey.slice(0,14)}...`);
else        console.log("⚠️   No STRIPE_SECRET_KEY — payments disabled");
const STRIPE_PRICES = {
  basic:   (process.env.STRIPE_PRICE_BASIC   || "").trim(),
  premium: (process.env.STRIPE_PRICE_PREMIUM || "").trim(),
};
const APP_URL = (process.env.APP_URL || "http://localhost:3000").trim();

// ── Data storage ───────────────────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const ORG_FILE   = path.join(DATA_DIR, "org.json");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");

function loadUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE,"utf8")); } catch { return []; } }
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u,null,2)); }
function loadOrg()    { try { return JSON.parse(fs.readFileSync(ORG_FILE,  "utf8")); } catch { return { name:"AI EXO verse",logo:"🤖",createdAt:new Date().toISOString() }; } }
function saveOrg(o)   { fs.writeFileSync(ORG_FILE,   JSON.stringify(o,null,2)); }
function loadUsage()  { try { return JSON.parse(fs.readFileSync(USAGE_FILE,"utf8")); } catch { return {}; } }
function saveUsage(d) { fs.writeFileSync(USAGE_FILE, JSON.stringify(d,null,2)); }

// Init data folder on first run
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive:true });
if (!fs.existsSync(USERS_FILE)) {
  const adminHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD.trim(), 10);
  saveUsers([{
    id: crypto.randomUUID(),
    username: process.env.ADMIN_USERNAME.trim(),
    password: adminHash,
    role: "admin", plan: "enterprise", active: true,
    stripeCustomerId: null, stripeSubscriptionId: null, subscriptionStatus: null,
    createdAt: new Date().toISOString(), lastLogin: null
  }]);
  console.log("📁  Created data/users.json with admin user");
}
if (!fs.existsSync(ORG_FILE)) {
  saveOrg({ name:"AI EXO verse", logo:"🤖", createdAt:new Date().toISOString() });
  console.log("📁  Created data/org.json");
}

// ── Migrate existing users: add tokenBudget if missing ─────────────────────
(function migrateUsers() {
  const users = loadUsers();
  let changed = false;
  for (const u of users) {
    if (!u.tokenBudget) {
      u.tokenBudget = {
        cycleStartDate: (u.createdAt || new Date().toISOString()).slice(0,10),
        spentUsd:       0,
        rechargeCredits: 0,
      };
      changed = true;
    }
  }
  if (changed) { saveUsers(users); console.log("🔄  Migrated user records: added tokenBudget field"); }
})();

// ── Migrate plaintext passwords → bcrypt hashes ────────────────────────────
(function migratePasswords() {
  const users = loadUsers();
  let changed = false;
  for (const u of users) {
    if (u.password && !u.password.startsWith("$2b$") && !u.password.startsWith("$2a$")) {
      u.password = bcrypt.hashSync(u.password, 10);
      changed = true;
    }
  }
  if (changed) { saveUsers(users); console.log("🔒  Migrated plaintext passwords to bcrypt hashes"); }
})();

// ── Token budget config ────────────────────────────────────────────────────
// Cost per token in USD for each model (blended input+output estimate)
const MODEL_COST_PER_TOKEN = {
  "gemini-2.5-flash-lite":  0.0000000875,  // ~$0.0875 per 1M tokens
  "gemini-3.1-pro-preview": 0.000005000,   // ~$5.00 per 1M tokens
  "gpt-4.1-mini":           0.000000200,   // ~$0.20 per 1M tokens
  "gpt-5-search-api":       0.000005000,   // ~$5.00 per 1M tokens
  "claude-sonnet-4-6":      0.000003000,   // ~$3.00 per 1M tokens
  "deepseek-chat":          0.000000140,   // ~$0.14 per 1M tokens
};
const DEFAULT_COST_PER_TOKEN = 0.000000200; // fallback for unknown models

const PLAN_BUDGETS = {
  basic:   { usdPerCycle: 2.40, warnThreshold: 0.75, throttleModel: "gemini-2.5-flash-lite" },
  premium: { usdPerCycle: 5.40, warnThreshold: 0.75, throttleModel: "gemini-2.5-flash-lite" },
};

// ── Spending log ────────────────────────────────────────────────────────────
const SPENDING_FILE = path.join(DATA_DIR, "spending.json");
function loadSpending()  { try { return JSON.parse(fs.readFileSync(SPENDING_FILE,"utf8")); } catch { return []; } }
function saveSpending(d) { fs.writeFileSync(SPENDING_FILE, JSON.stringify(d,null,2)); }

function calcCostUsd(modelId, tokens) {
  const rate = MODEL_COST_PER_TOKEN[modelId] ?? DEFAULT_COST_PER_TOKEN;
  return parseFloat((rate * tokens).toFixed(8));
}

function getUserBudgetStatus(user) {
  const budget = PLAN_BUDGETS[user.plan];
  if (!budget) return { exempt: true };
  const tb = user.tokenBudget || {};
  const spentUsd     = parseFloat((tb.spentUsd || 0).toFixed(6));
  const extraCredits = parseFloat((tb.rechargeCredits || 0).toFixed(6));
  const budgetUsd    = parseFloat((budget.usdPerCycle + extraCredits).toFixed(6));
  const pctUsed      = budgetUsd > 0 ? spentUsd / budgetUsd : 0;
  const isWarning    = pctUsed >= budget.warnThreshold;
  const isHardLimit  = pctUsed >= 1.0;
  return {
    exempt:       false,
    spentUsd,
    budgetUsd,
    pctUsed:      parseFloat(pctUsed.toFixed(4)),
    isWarning,
    isHardLimit,
    throttleModel: isWarning ? budget.throttleModel : null,
    cycleStartDate: tb.cycleStartDate || null,
  };
}

function recordSpend(userId, modelId, tokens) {
  if (!tokens) return;
  const costUsd = calcCostUsd(modelId, tokens);
  // Update user's running total
  const users = loadUsers();
  const u = users.find(u => u.id === userId);
  if (u) {
    if (!u.tokenBudget) u.tokenBudget = { cycleStartDate: new Date().toISOString().slice(0,10), spentUsd: 0, rechargeCredits: 0 };
    u.tokenBudget.spentUsd = parseFloat(((u.tokenBudget.spentUsd || 0) + costUsd).toFixed(8));
    saveUsers(users);
  }
  // Append to spending log
  const log = loadSpending();
  log.push({
    userId,
    username:   u?.username || "unknown",
    plan:       u?.plan || "unknown",
    modelId,
    tokens,
    costUsd,
    timestamp:  new Date().toISOString(),
    cycleStart: u?.tokenBudget?.cycleStartDate || new Date().toISOString().slice(0,10),
  });
  saveSpending(log);
}

// ── Plan config ────────────────────────────────────────────────────────────
const PLAN_MODELS = {
  free:       ["gemini"],
  basic:      ["gemini","gpt","deepseek"],
  premium:    ["gemini","gpt","claude","deepseek"],
  enterprise: ["gemini","gpt","claude","deepseek"],
};

// Daily token limits per model per plan (-1 = unlimited, 0 = not allowed)
const PLAN_LIMITS = {
  free:       { gemini:50000,  gpt:0,      claude:0,      deepseek:0      },
  basic:      { gemini:62500,  gpt:41667,  claude:0,      deepseek:62500  },
  premium:    { gemini:200000, gpt:150000, claude:150000, deepseek:150000 },
  enterprise: { gemini:-1,     gpt:-1,     claude:-1,     deepseek:-1     },
};

// Model version per plan
const MODEL_VERSION = {
  gemini:   (plan) => (plan==="premium"||plan==="enterprise") ? "gemini-3.1-pro-preview" : "gemini-2.5-flash-lite",
  gpt:      (plan) => (plan==="premium"||plan==="enterprise") ? "gpt-5-search-api"       : "gpt-4.1-mini",
  deepseek: ()     => "deepseek-chat",
  claude:   ()     => "claude-sonnet-4-6",
};

// ── Usage tracking ─────────────────────────────────────────────────────────
function getUserDailyTokens(userId, model) {
  const today = new Date().toISOString().slice(0,10);
  return loadUsage()[today]?.[userId]?.[model] || 0;
}
function addUserDailyTokens(userId, model, count) {
  if (!count) return;
  const d = loadUsage();
  const today = new Date().toISOString().slice(0,10);
  if (!d[today]) d[today] = {};
  if (!d[today][userId]) d[today][userId] = { gemini:0, gpt:0, claude:0, deepseek:0 };
  d[today][userId][model] = (d[today][userId][model]||0) + count;
  saveUsage(d);
}

// ── Auth helpers ───────────────────────────────────────────────────────────
function makeToken(username) {
  const hmac = crypto.createHmac("sha256", process.env.AUTH_SECRET).update(username).digest("hex");
  return `${username}:${hmac}`;
}
function getUserFromToken(req) {
  const raw = (req.headers["authorization"]||"").replace("Bearer ","").trim();
  const sep = raw.lastIndexOf(":");
  if (sep === -1) return null;
  const username = raw.slice(0,sep);
  const hmac     = raw.slice(sep+1);
  const expected = crypto.createHmac("sha256", process.env.AUTH_SECRET).update(username).digest("hex");
  if (hmac !== expected) return null;
  return loadUsers().find(u => u.username===username && u.active) || null;
}
function requireAuth(req, res, next) {
  const user = getUserFromToken(req);
  if (!user) return res.status(401).json({ error:"Unauthorized. Please log in." });
  req.user = user; next();
}
function requireAdmin(req, res, next) {
  const user = getUserFromToken(req);
  if (!user || user.role!=="admin") return res.status(403).json({ error:"Admin access required." });
  req.user = user; next();
}

// ── Plan enforcement ───────────────────────────────────────────────────────
function checkLimit(model) {
  return (req, res, next) => {
    const limit = PLAN_LIMITS[req.user.plan]?.[model] ?? 0;
    if (limit === -1) return next();
    if (limit === 0)  return res.status(403).json({ error:`Your ${req.user.plan} plan does not include ${model}. Upgrade to access.` });
    const used = getUserDailyTokens(req.user.id, model);
    if (used >= limit) return res.status(429).json({ error:`Daily ${model} limit reached (${limit.toLocaleString()} tokens). Resets at midnight UTC.` });
    next();
  };
}

// ── Budget enforcement ─────────────────────────────────────────────────────
function checkBudget(model) {
  return (req, res, next) => {
    const status = getUserBudgetStatus(req.user);
    if (status.exempt) return next();
    if (status.isHardLimit) {
      // Non-gemini routes: block with 402
      if (model !== "gemini") {
        return res.status(402).json({
          error: `Monthly token budget exhausted. Only Gemini 2.5 Flash Lite is available until your next billing cycle. Upgrade or wait for renewal.`,
          budgetStatus: status,
        });
      }
      // Gemini route: force flash-lite (handled inside route)
      req.forcedModel = "gemini-2.5-flash-lite";
    } else if (status.isWarning) {
      // Warn but allow; force cheap model
      if (model !== "gemini") {
        return res.status(402).json({
          error: `75% of monthly budget used. Switched to Gemini 2.5 Flash Lite to conserve budget.`,
          budgetStatus: status,
        });
      }
      req.forcedModel = "gemini-2.5-flash-lite";
    }
    req.budgetStatus = status;
    next();
  };
}

// ── File upload ────────────────────────────────────────────────────────────
const ALLOWED_MIME = ["image/jpeg","image/png","image/gif","image/webp","application/pdf","text/plain","text/csv","text/markdown"];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize:4*1024*1024 },
  fileFilter: (_req,file,cb) => ALLOWED_MIME.includes(file.mimetype) ? cb(null,true) : cb(new Error(`Unsupported: ${file.mimetype}`)),
});

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit:"1mb" }));
app.use(express.static(path.join(__dirname,"public")));

// ── Health ─────────────────────────────────────────────────────────────────
app.get("/health", (_req,res) => res.json({ status:"ok", timestamp:new Date().toISOString() }));

// ── Config ─────────────────────────────────────────────────────────────────
app.get("/api/config", (_req,res) => res.json({
  claudeAvailable:    !!anthropic,
  gptAvailable:       !!openai,
  deepseekAvailable:  !!deepseek,
}));

// ── Login ──────────────────────────────────────────────────────────────────
app.post("/api/login", async (req,res) => {
  const { username, password } = req.body || {};
  const users = loadUsers();
  const user  = users.find(u => u.username===(username||"").trim() && u.active);
  if (!user) return res.status(401).json({ error:"Invalid username or password." });
  const match = await bcrypt.compare((password||"").trim(), user.password);
  if (!match) return res.status(401).json({ error:"Invalid username or password." });
  user.lastLogin = new Date().toISOString();
  saveUsers(users);
  res.json({ token:makeToken(user.username), role:user.role, plan:user.plan, username:user.username });
});

// ── Register ───────────────────────────────────────────────────────────────
app.post("/api/register", async (req,res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error:"Username and password required." });
  if (username.trim().length < 3) return res.status(400).json({ error:"Username must be at least 3 characters." });
  if (password.length < 6) return res.status(400).json({ error:"Password must be at least 6 characters." });
  const users = loadUsers();
  if (users.find(u => u.username.toLowerCase() === username.trim().toLowerCase()))
    return res.status(409).json({ error:"Username already taken. Please choose another." });
  const hashed = await bcrypt.hash(password, 10);
  const newUser = {
    id: crypto.randomUUID(),
    username: username.trim(),
    password: hashed,
    role: "user", plan: "free", active: true,
    stripeCustomerId: null, stripeSubscriptionId: null, subscriptionStatus: null,
    createdAt: new Date().toISOString(), lastLogin: new Date().toISOString(),
    tokenBudget: { cycleStartDate: new Date().toISOString().slice(0,7), spentUsd: 0, rechargeCredits: 0 }
  };
  users.push(newUser);
  saveUsers(users);
  res.json({ token: makeToken(newUser.username), role: "user", plan: "free", username: newUser.username });
});

// ── Me ─────────────────────────────────────────────────────────────────────
app.get("/api/me", requireAuth, (req,res) => {
  const { username, role, plan } = req.user;
  const budgetStatus = getUserBudgetStatus(req.user);
  res.json({ username, role, plan, budgetStatus });
});

// ── Admin: Spending & Budget ────────────────────────────────────────────────
app.get("/api/admin/spending", requireAdmin, (_req, res) => {
  const users    = loadUsers();
  const spending = loadSpending();

  // Per-user budget summary
  const userSummary = users.map(u => {
    const status = getUserBudgetStatus(u);
    return {
      userId:        u.id,
      username:      u.username,
      plan:          u.plan,
      spentUsd:      status.exempt ? null : status.spentUsd,
      budgetUsd:     status.exempt ? null : status.budgetUsd,
      pctUsed:       status.exempt ? null : status.pctUsed,
      isWarning:     status.exempt ? false : status.isWarning,
      isHardLimit:   status.exempt ? false : status.isHardLimit,
      cycleStartDate: u.tokenBudget?.cycleStartDate || null,
    };
  });

  // Daily aggregate for last 30 days
  const dailyAggregate = {};
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    dailyAggregate[d.toISOString().slice(0,10)] = 0;
  }
  for (const entry of spending) {
    const day = entry.timestamp?.slice(0,10);
    if (day && dailyAggregate[day] !== undefined) {
      dailyAggregate[day] = parseFloat((dailyAggregate[day] + (entry.costUsd||0)).toFixed(6));
    }
  }

  const totalSpentAllUsers = userSummary.reduce((s, u) => s + (u.spentUsd || 0), 0);
  const todayKey = now.toISOString().slice(0,10);

  res.json({
    users: userSummary,
    dailyAggregate,
    totalSpentAllUsers: parseFloat(totalSpentAllUsers.toFixed(6)),
    spendToday:         parseFloat((dailyAggregate[todayKey] || 0).toFixed(6)),
    usersAtWarning:     userSummary.filter(u => u.isWarning && !u.isHardLimit).length,
    usersAtLimit:       userSummary.filter(u => u.isHardLimit).length,
  });
});

app.post("/api/admin/budget/reset", requireAdmin, (req, res) => {
  const { userId, action, amountUsd } = req.body || {};
  if (!userId || !action) return res.status(400).json({ error:"userId and action required." });
  const users = loadUsers();
  const u = users.find(u => u.id === userId);
  if (!u) return res.status(404).json({ error:"User not found." });
  if (!u.tokenBudget) u.tokenBudget = { cycleStartDate: new Date().toISOString().slice(0,10), spentUsd:0, rechargeCredits:0 };

  if (action === "reset") {
    u.tokenBudget.spentUsd       = 0;
    u.tokenBudget.rechargeCredits = 0;
    u.tokenBudget.cycleStartDate  = new Date().toISOString().slice(0,10);
    console.log(`🔄  Admin reset budget for ${u.username}`);
  } else if (action === "topup") {
    const amount = parseFloat(amountUsd) || 0;
    if (amount <= 0) return res.status(400).json({ error:"amountUsd must be positive." });
    u.tokenBudget.rechargeCredits = parseFloat(((u.tokenBudget.rechargeCredits||0) + amount).toFixed(6));
    console.log(`💵  Admin topped up ${u.username} by $${amount}`);
  } else {
    return res.status(400).json({ error:`Unknown action: ${action}` });
  }

  saveUsers(users);
  res.json({ ok:true, budgetStatus: getUserBudgetStatus(u) });
});

// ── Usage ──────────────────────────────────────────────────────────────────
app.get("/api/usage", requireAuth, (req,res) => {
  const today = new Date().toISOString().slice(0,10);
  const used  = loadUsage()[today]?.[req.user.id] || { gemini:0, gpt:0, claude:0, deepseek:0 };
  res.json({ used, limits:PLAN_LIMITS[req.user.plan], plan:req.user.plan });
});

// ── Admin: Users ───────────────────────────────────────────────────────────
app.get("/api/admin/users", requireAdmin, (_req,res) => {
  res.json(loadUsers().map(u => ({ ...u, password:undefined })));
});
app.post("/api/admin/users", requireAdmin, async (req,res) => {
  const { username, password, role="user", plan="free" } = req.body||{};
  if (!username||!password) return res.status(400).json({ error:"Username and password required." });
  const users = loadUsers();
  if (users.find(u=>u.username===username)) return res.status(409).json({ error:"Username already exists." });
  const hashed = await bcrypt.hash(password, 10);
  const user = { id:crypto.randomUUID(), username, password:hashed, role, plan, active:true, stripeCustomerId:null, stripeSubscriptionId:null, subscriptionStatus:null, createdAt:new Date().toISOString(), lastLogin:null, tokenBudget:{ cycleStartDate:new Date().toISOString().slice(0,7), spentUsd:0, rechargeCredits:0 } };
  users.push(user); saveUsers(users);
  res.json({ ...user, password:undefined });
});
app.put("/api/admin/users/:id", requireAdmin, async (req,res) => {
  const users = loadUsers();
  const idx   = users.findIndex(u=>u.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error:"User not found." });
  ["role","plan","active"].forEach(k=>{ if(req.body[k]!==undefined) users[idx][k]=req.body[k]; });
  if (req.body.password) users[idx].password = await bcrypt.hash(req.body.password, 10);
  saveUsers(users);
  res.json({ ...users[idx], password:undefined });
});
app.delete("/api/admin/users/:id", requireAdmin, (req,res) => {
  const users = loadUsers();
  const idx   = users.findIndex(u=>u.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error:"User not found." });
  if (users[idx].username===req.user.username) return res.status(400).json({ error:"Cannot delete yourself." });
  users.splice(idx,1); saveUsers(users);
  res.json({ ok:true });
});

// ── Org ────────────────────────────────────────────────────────────────────
app.get("/api/org", requireAuth,  (_req,res) => res.json(loadOrg()));
app.put("/api/org", requireAdmin, (req,res) => {
  const org = loadOrg();
  if (req.body.name) org.name = req.body.name;
  if (req.body.logo) org.logo = req.body.logo;
  saveOrg(org); res.json(org);
});

// ── Subscriptions ───────────────────────────────────────────────────────────

// Create Stripe Checkout Session
app.post("/api/subscription/checkout", requireAuth, async (req,res) => {
  if (!stripe) return res.status(503).json({ error:"Payments not configured. Add STRIPE_SECRET_KEY to .env" });
  const { plan } = req.body || {};
  const priceId  = STRIPE_PRICES[plan];
  if (!priceId)         return res.status(400).json({ error:`Invalid plan: ${plan}` });
  if (req.user.plan === plan) return res.status(400).json({ error:"You are already on this plan." });

  try {
    // Get or create Stripe customer
    let customerId = req.user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.username + "@ascend.ai",
        name:  req.user.username,
        metadata: { userId: req.user.id },
      });
      customerId = customer.id;
      const users = loadUsers();
      const u = users.find(u => u.id === req.user.id);
      if (u) { u.stripeCustomerId = customerId; saveUsers(users); }
    }

    const session = await stripe.checkout.sessions.create({
      mode:      "subscription",
      customer:  customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_URL}/?checkout=cancel`,
      metadata:   { userId: req.user.id, plan },
      subscription_data: { metadata: { userId: req.user.id, plan } },
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stripe Webhook — auto-upgrade/downgrade plan
app.post("/api/stripe/webhook", express.raw({ type:"application/json" }), async (req,res) => {
  if (!stripe) return res.json({ received:true });
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET || ""
    );
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).json({ error:`Webhook error: ${err.message}` });
  }

  const users = loadUsers();

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId  = session.metadata?.userId;
    const plan    = session.metadata?.plan;
    const u = users.find(u => u.id === userId);
    if (u && plan) {
      u.plan                  = plan;
      u.stripeCustomerId      = session.customer;
      u.stripeSubscriptionId  = session.subscription;
      u.subscriptionStatus    = "active";
      // Initialize token budget for new subscription
      u.tokenBudget = {
        cycleStartDate:  new Date().toISOString().slice(0,10),
        spentUsd:        0,
        rechargeCredits: 0,
      };
      saveUsers(users);
      console.log(`✅  Plan upgraded: ${u.username} → ${plan}`);
    }
  }

  if (event.type === "invoice.paid") {
    const invoice = event.data.object;
    if (invoice.billing_reason === "subscription_cycle" || invoice.billing_reason === "subscription_create") {
      const u = users.find(u => u.stripeSubscriptionId === invoice.subscription);
      if (u) {
        u.tokenBudget = {
          cycleStartDate:  new Date().toISOString().slice(0,10),
          spentUsd:        0,
          rechargeCredits: u.tokenBudget?.rechargeCredits || 0,
        };
        saveUsers(users);
        console.log(`💰  Budget reset for ${u.username} — new billing cycle`);
      }
    }
  }

  if (event.type === "customer.subscription.updated") {
    const sub = event.data.object;
    const u   = users.find(u => u.stripeSubscriptionId === sub.id);
    if (u) {
      u.subscriptionStatus = sub.status;
      if (sub.status === "canceled" || sub.status === "unpaid") u.plan = "free";
      saveUsers(users);
      console.log(`🔄  Subscription updated: ${u.username} → ${sub.status}`);
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    const u   = users.find(u => u.stripeSubscriptionId === sub.id);
    if (u) {
      u.plan               = "free";
      u.subscriptionStatus = "canceled";
      saveUsers(users);
      console.log(`❌  Subscription canceled: ${u.username} → free`);
    }
  }

  res.json({ received: true });
});

// Customer Portal (self-service cancel/upgrade)
app.post("/api/subscription/portal", requireAuth, async (req,res) => {
  if (!stripe)                    return res.status(503).json({ error:"Payments not configured." });
  if (!req.user.stripeCustomerId) return res.status(400).json({ error:"No active subscription found." });
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   req.user.stripeCustomerId,
      return_url: APP_URL,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Subscription status
app.get("/api/subscription/status", requireAuth, (req,res) => {
  const { plan, subscriptionStatus, stripeCustomerId } = req.user;
  res.json({ plan, subscriptionStatus, hasStripe: !!stripeCustomerId });
});

// ── Gemini ─────────────────────────────────────────────────────────────────
app.post("/api/chat", requireAuth, checkLimit("gemini"), checkBudget("gemini"), upload.single("file"), async (req,res) => {
  const message = (req.body.message||"").trim();
  const thinking = req.body.thinking==="true";
  let history=[]; try{ history=JSON.parse(req.body.history||"[]"); }catch{}
  if (!message&&!req.file) return res.status(400).json({ error:"A message or file is required." });

  const ALLOWED_GEMINI = {
    free:       ["gemini-2.5-flash-lite"],
    basic:      ["gemini-2.5-flash-lite"],
    premium:    ["gemini-2.5-flash-lite","gemini-3.1-pro-preview"],
    enterprise: ["gemini-2.5-flash-lite","gemini-3.1-pro-preview"],
  };
  const requestedGemini = (req.body.modelVersion||"").trim();
  const allowedGemini   = ALLOWED_GEMINI[req.user.plan] || ["gemini-2.5-flash-lite"];
  // Budget enforcement: force cheap model if at warning/hard-limit
  const modelId = req.forcedModel || ((requestedGemini && allowedGemini.includes(requestedGemini))
    ? requestedGemini
    : MODEL_VERSION.gemini(req.user.plan));
  try {
    const generationConfig = thinking
      ? { maxOutputTokens:16000, temperature:1, thinkingConfig:{ thinkingBudget:8192 } }
      : { maxOutputTokens:4096,  temperature:0.4 };

    const modelConfig = {
      model: modelId,
      generationConfig,
      systemInstruction:`You are a highly accurate AI assistant with real-time Google Search access. Follow these rules strictly:
1. Use search results to find the MOST RECENT information — always prefer the latest date.
2. For current events or real-time queries, state the date your information is from. Do NOT add a date for timeless facts.
3. Make precise distinctions — e.g. between "elected/designated" vs "formally sworn in".
4. If search results conflict, explain both sides and state which is more likely correct and why.
5. Give a DIRECT, CONCISE answer only — no structural headings unless explicitly requested.
6. Never state something as fact if it is still pending or unconfirmed.`,
    };
    if (!thinking&&!req.file) modelConfig.tools=[{ googleSearch:{} }];
    const model = genAI.getGenerativeModel(modelConfig);

    const today = new Date().toISOString().slice(0,10);
    const parts = [];
    if (req.file) parts.push({ inlineData:{ data:req.file.buffer.toString("base64"), mimeType:req.file.mimetype } });
    parts.push({ text: req.file ? (message||"Please analyse this file.") : `[Today is ${today}] ${message}` });

    const formattedHistory = history.filter(h=>h.role&&h.content).map(h=>({ role:h.role, parts:[{ text:h.content }] }));
    const result = await model.generateContent({ contents:[...formattedHistory,{ role:"user", parts }] });

    const usage  = result.response.usageMetadata;
    const tokens = usage ? (usage.promptTokenCount||0)+(usage.candidatesTokenCount||0) : 0;
    addUserDailyTokens(req.user.id, "gemini", tokens);
    recordSpend(req.user.id, modelId, tokens);
    const budgetStatus = getUserBudgetStatus(loadUsers().find(u=>u.id===req.user.id) || req.user);
    res.json({ reply:result.response.text(), tokens, modelUsed:modelId, budgetStatus });
  } catch (err) {
    console.error("Gemini error:", err.message);
    if (err.message?.includes("API_KEY_INVALID")) return res.status(401).json({ error:"Invalid Gemini API key." });
    if (err.message?.includes("quota")||err.message?.includes("429")) return res.status(429).json({ error:"Gemini quota exceeded." });
    res.status(500).json({ error:"Gemini request failed." });
  }
});

// ── Claude ─────────────────────────────────────────────────────────────────
app.post("/api/chat-claude", requireAuth, checkLimit("claude"), checkBudget("claude"), upload.single("file"), async (req,res) => {
  if (!anthropic) return res.status(503).json({ error:"Claude API not configured. Add ANTHROPIC_API_KEY to .env" });
  const message = (req.body.message||"").trim();
  let history=[]; try{ history=JSON.parse(req.body.history||"[]"); }catch{}
  if (!message&&!req.file) return res.status(400).json({ error:"A message or file is required." });

  const modelId = MODEL_VERSION.claude();
  try {
    const messages=[];
    for (const h of history.filter(h=>h.role&&h.content)) {
      messages.push({ role:h.role==="model"?"assistant":"user", content:h.content });
    }
    const content=[];
    if (req.file&&req.file.mimetype.startsWith("image/")) {
      content.push({ type:"image", source:{ type:"base64", media_type:req.file.mimetype, data:req.file.buffer.toString("base64") } });
    }
    content.push({ type:"text", text:message||"Please analyse this file." });
    messages.push({ role:"user", content });

    const result = await anthropic.messages.create({
      model: modelId, max_tokens:4096,
      tools:[{ type:"web_search_20250305", name:"web_search", max_uses:5 }],
      messages,
    });
    const reply  = result.content.filter(b=>b.type==="text").map(b=>b.text).join("\n").trim();
    const tokens = result.usage ? (result.usage.input_tokens||0)+(result.usage.output_tokens||0) : 0;
    addUserDailyTokens(req.user.id, "claude", tokens);
    recordSpend(req.user.id, modelId, tokens);
    const budgetStatus = getUserBudgetStatus(loadUsers().find(u=>u.id===req.user.id) || req.user);
    res.json({ reply:reply||"No response generated.", tokens, modelUsed:modelId, budgetStatus });
  } catch (err) {
    console.error("Claude error:", err.status, err.message);
    if (err.status===401) return res.status(401).json({ error:`Claude auth failed: ${err.message}` });
    if (err.status===404) return res.status(404).json({ error:`Claude model not found: ${err.message}` });
    if (err.status===429) return res.status(429).json({ error:"Claude quota exceeded." });
    res.status(500).json({ error:`Claude error (${err.status}): ${err.message}` });
  }
});

// ── ChatGPT ────────────────────────────────────────────────────────────────
app.post("/api/chat-gpt", requireAuth, checkLimit("gpt"), checkBudget("gpt"), upload.single("file"), async (req,res) => {
  if (!openai) return res.status(503).json({ error:"OpenAI API not configured. Add OPENAI_API_KEY to .env" });
  const message = (req.body.message||"").trim();
  let history=[]; try{ history=JSON.parse(req.body.history||"[]"); }catch{}
  if (!message&&!req.file) return res.status(400).json({ error:"A message or file is required." });

  const ALLOWED_GPT = {
    free:       [],
    basic:      ["gpt-4.1-mini"],
    premium:    ["gpt-4.1-mini","gpt-5-search-api"],
    enterprise: ["gpt-4.1-mini","gpt-5-search-api"],
  };
  const requestedGpt = (req.body.modelVersion||"").trim();
  const allowedGpt   = ALLOWED_GPT[req.user.plan] || ["gpt-4.1-mini"];
  const modelId = (requestedGpt && allowedGpt.includes(requestedGpt))
    ? requestedGpt
    : MODEL_VERSION.gpt(req.user.plan);
  try {
    const today = new Date().toISOString().slice(0,10);
    const messages=[{ role:"system", content:`You are a highly accurate AI assistant with real-time web search. Today is ${today}. Always cite dates for current-event answers.` }];
    for (const h of history.filter(h=>h.role&&h.content)) {
      messages.push({ role:h.role==="model"?"assistant":"user", content:h.content });
    }
    const userContent=[];
    if (req.file&&req.file.mimetype.startsWith("image/")) {
      userContent.push({ type:"image_url", image_url:{ url:`data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}` } });
    }
    userContent.push({ type:"text", text:message||"Please analyse this file." });
    messages.push({ role:"user", content:userContent.length===1?userContent[0].text:userContent });

    const result = await openai.chat.completions.create({ model:modelId, messages });
    const tokens = result.usage ? result.usage.total_tokens : 0;
    addUserDailyTokens(req.user.id, "gpt", tokens);
    recordSpend(req.user.id, modelId, tokens);
    const budgetStatus = getUserBudgetStatus(loadUsers().find(u=>u.id===req.user.id) || req.user);
    res.json({ reply:result.choices[0].message.content, tokens, modelUsed:modelId, budgetStatus });
  } catch (err) {
    console.error("OpenAI error:", err.message);
    if (err.status===401) return res.status(401).json({ error:"Invalid OpenAI API key." });
    if (err.status===429) return res.status(429).json({ error:"OpenAI quota exceeded." });
    res.status(500).json({ error:`OpenAI error: ${err.message}` });
  }
});

// ── DeepSeek ───────────────────────────────────────────────────────────────
app.post("/api/chat-deepseek", requireAuth, checkLimit("deepseek"), checkBudget("deepseek"), async (req,res) => {
  if (!deepseek) return res.status(503).json({ error:"DeepSeek API not configured. Add DEEPSEEK_API_KEY to .env" });
  const message = (req.body.message||"").trim();
  let history=[]; try{ history=JSON.parse(req.body.history||"[]"); }catch{}
  if (!message) return res.status(400).json({ error:"A message is required." });

  const modelId = MODEL_VERSION.deepseek();
  try {
    const today = new Date().toISOString().slice(0,10);
    const messages=[{ role:"system", content:`You are a highly accurate and helpful AI assistant. Today is ${today}. Be concise and direct.` }];
    for (const h of history.filter(h=>h.role&&h.content)) {
      messages.push({ role:h.role==="model"?"assistant":"user", content:h.content });
    }
    messages.push({ role:"user", content:message });

    const result = await deepseek.chat.completions.create({ model:modelId, messages, max_tokens:4096 });
    const tokens = result.usage ? result.usage.total_tokens : 0;
    addUserDailyTokens(req.user.id, "deepseek", tokens);
    recordSpend(req.user.id, modelId, tokens);
    const budgetStatus = getUserBudgetStatus(loadUsers().find(u=>u.id===req.user.id) || req.user);
    res.json({ reply:result.choices[0].message.content, tokens, modelUsed:modelId, budgetStatus });
  } catch (err) {
    console.error("DeepSeek error:", err.message);
    if (err.status===401) return res.status(401).json({ error:"Invalid DeepSeek API key." });
    if (err.status===429) return res.status(429).json({ error:"DeepSeek quota exceeded." });
    res.status(500).json({ error:`DeepSeek error: ${err.message}` });
  }
});

// ── Claude debug ───────────────────────────────────────────────────────────
app.get("/api/test-claude", async (_req,res) => {
  if (!rawClaudeKey) return res.json({ ok:false, error:"No API key set" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{"x-api-key":rawClaudeKey,"anthropic-version":"2023-06-01","content-type":"application/json"},
      body:JSON.stringify({ model:"claude-sonnet-4-6", max_tokens:10, messages:[{ role:"user", content:"hi" }] }),
    });
    const data=await r.json();
    res.json({ ok:r.ok, status:r.status, keyPrefix:rawClaudeKey.slice(0,24), data });
  } catch(e){ res.json({ ok:false, error:e.message }); }
});

// ── Multer error ───────────────────────────────────────────────────────────
app.use((err,_req,res,_next) => {
  if (err instanceof multer.MulterError||err.message?.startsWith("Unsupported")) return res.status(400).json({ error:err.message });
  res.status(500).json({ error:"Server error." });
});

// ── Fallback ───────────────────────────────────────────────────────────────
app.get("*", (_req,res) => res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT, () => {
  console.log(`✅  AI EXO verse Agent running → http://localhost:${PORT}`);
  console.log(`🔍  Health check        → http://localhost:${PORT}/health`);
});
