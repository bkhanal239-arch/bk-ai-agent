# Gemini AI Chatbot

A full-stack AI chatbot powered by **Google Gemini 1.5 Flash**.
Built with Node.js + Express backend and a vanilla JS frontend — no framework, no database.

**Features**
- Multi-turn conversations with full chat history
- History persists across page refreshes (browser `localStorage`)
- Markdown rendering (code blocks, lists, tables, bold, etc.)
- Mobile-responsive, dark-themed chat UI
- `/health` endpoint for uptime monitoring
- Starter prompt chips on the welcome screen

---

## Step 1 — Install Required Tools

You need **Node.js**, **Git**, and **pnpm** installed first.

### A) Install Node.js

1. Go to https://nodejs.org
2. Download the **LTS** version (big green button)
3. Run the installer — click Next through everything

Verify in Command Prompt:
```
node --version
```
Should show something like `v20.x.x`

### B) Install Git

1. Go to https://git-scm.com/download/win
2. Download and install (keep all default settings)

Verify:
```
git --version
```

### C) Install pnpm

In Command Prompt, run:
```
npm install -g pnpm
```

---

## Step 2 — Get a Gemini API Key

1. Go to https://aistudio.google.com/apikey
2. Sign in with your Google account
3. Click **"Create API Key"**
4. Copy and save it — you'll need it in Step 5

---

## Step 3 — Create a Vercel Account

1. Go to https://vercel.com/signup
2. Sign up with your **GitHub** account

> If you don't have GitHub yet, sign up at https://github.com first — it's free.

---

## Step 4 — Set Up the Project

Open **VS Code**, then press `` Ctrl + ` `` to open the terminal. Run these commands one by one:

```bash
cd "path\to\Gemini- Ai bot"
pnpm install
```

> `pnpm install` downloads all dependencies. Takes about 1–2 minutes.

---

## Step 5 — Set Up Environment Variables

In the VS Code terminal, run:

```bash
copy .env.example .env
```

Now open the `.env` file in VS Code and fill in:

```
GOOGLE_GENERATIVE_AI_API_KEY=paste_your_gemini_key_here
```

Paste the API key you got in Step 2.

---

## Step 6 — Run Locally (Optional Test)

```bash
pnpm start
```

Open http://localhost:3000 — you should see the chat UI working.

Press `Ctrl + C` to stop the server when done.

---

## Step 7 — Push to GitHub

1. Go to https://github.com/new
2. Create a new repository called `gemini-chatbot` (set it to **Public** or **Private** — either works)
3. Back in the VS Code terminal, run:

```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/gemini-chatbot.git
git push -u origin main
```

> Replace `YOUR_USERNAME` with your actual GitHub username.

---

## Step 8 — Deploy to Vercel

1. Go to https://vercel.com/new
2. Click **"Import"** next to your `gemini-chatbot` repo
3. Vercel will auto-detect it as a Node.js project — leave all settings as-is
4. Scroll down to **"Environment Variables"** and add:

| Name | Value |
|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | your Gemini API key |

5. Click **"Deploy"** 🚀

Vercel builds and deploys in about 1–2 minutes. You'll get a live URL like:

```
https://gemini-chatbot-yourname.vercel.app
```

> **Auto-deploys:** Every `git push` to `main` triggers a new deployment automatically.

---

## Project Structure

```
gemini-ai-chatbot/
├── server.js          ← Express backend + Gemini API integration
├── public/
│   └── index.html     ← Full chat UI (HTML + CSS + JS, no framework)
├── vercel.json        ← Vercel routing config (routes all requests to Express)
├── .env               ← Your secrets — never commit this file
├── .env.example       ← Safe template to share with others
├── .gitignore         ← Excludes .env and node_modules
├── package.json       ← Dependencies + scripts
└── README.md
```

---

## API Reference

### `POST /api/chat`

**Request body:**
```json
{
  "message": "What is machine learning?",
  "history": [
    { "role": "user",  "content": "Hello!" },
    { "role": "model", "content": "Hi! How can I help?" }
  ]
}
```

**Success response (`200`):**
```json
{ "reply": "Machine learning is..." }
```

**Error response:**
```json
{ "error": "Human-readable error message" }
```

### `GET /health`

Returns `200 OK` — used by Vercel for uptime monitoring.

```json
{ "status": "ok", "timestamp": "2024-01-01T00:00:00.000Z" }
```
