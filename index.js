import express from "express";
import fs from "fs-extra";
import puppeteer from "puppeteer";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const PORT = process.env.PORT || 10000;

// -------------------- CONFIG --------------------
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
if (!GEMINI_KEY) {
  console.warn("⚠️  GEMINI_API_KEY missing. Replies won't be AI-generated.");
}
const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;
const MODEL_ID = process.env.GEMINI_MODEL || "gemini-1.5-flash";

// Triggers & anti-spam
const TRIGGERS = ["!suisui", "!hellosuisui", "!hello suisui", "!sui"];
const REPLY_PROBABILITY = 0.7;        // 70% chance if trigger matched
const COOLDOWN_MS = 60 * 1000;        // per-user cooldown
const GLOBAL_INTERVAL_MS = 10 * 1000; // min gap between any two replies

let lastGlobalReply = 0;
const userCooldown = new Map();

// Channels storage
const CHANNELS_FILE = "channels.json";
let channels = [];
if (await fs.pathExists(CHANNELS_FILE)) {
  channels = await fs.readJSON(CHANNELS_FILE).catch(() => []);
}

// Load cookies if present (to SEND chat messages)
let cookies = [];
if (await fs.pathExists("cookies.json")) {
  cookies = await fs.readJSON("cookies.json").catch(() => []);
  console.log(`🍪 cookies.json loaded with ${cookies.length} cookies`);
}

// -------------------- HELPERS --------------------
function toPopoutUrl(input) {
  try {
    // Accept: full watch URL or live_chat URL or full live URL
    // Normalize to popout live chat
    if (input.includes("live_chat")) return input;
    const u = new URL(input);
    // If watch?v=VIDEO_ID
    const v = u.searchParams.get("v");
    if (v) {
      return `https://www.youtube.com/live_chat?is_popout=1&v=${v}`;
    }
    // Fallback: return as-is
    return input;
  } catch {
    return input;
  }
}

function hasTrigger(msg) {
  const m = msg.toLowerCase();
  return TRIGGERS.some((t) => m.includes(t));
}

async function aiReply(text) {
  if (!genAI) {
    // Fallback: simple canned reply
    return "Sui Sui! 😄";
  }
  const model = genAI.getGenerativeModel({ model: MODEL_ID });
  const prompt =
    `You are a casual, friendly YouTube live chat bot.\n` +
    `Reply briefly in Hinglish, fun but not spammy.\n` +
    `User message: "${text}"\n` +
    `Your reply (max ~1 line, no hashtags):`;
  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

async function typeAndSend(chatCtx, text) {
  // chatCtx is a Page (popout) or a Frame (embedded)
  // Try common selectors for YT live chat input
  const selectors = [
    // popout composer
    "#input #contenteditable-root",
    "yt-live-chat-text-input-field-renderer #input #contenteditable-root",
    // fallback older selectors
    "#input",
    "#contenteditable-root"
  ];
  for (const sel of selectors) {
    try {
      await chatCtx.waitForSelector(sel, { timeout: 5000 });
      await chatCtx.focus(sel);
      // Clear any placeholder text
      await chatCtx.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (el && el.innerText) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const selObj = window.getSelection();
          selObj.removeAllRanges();
          selObj.addRange(range);
          document.execCommand("delete");
        }
      }, sel);
      await chatCtx.keyboard.type(text);
      await chatCtx.keyboard.press("Enter");
      return true;
    } catch {
      // try next selector
    }
  }
  return false;
}

async function observeChat(chatCtx, onMessage) {
  // chatCtx is a Page (for popout) or Frame (for embedded iframe)
  await chatCtx.exposeFunction("___onNewMsg", (user, msg) => onMessage(user, msg));
  await chatCtx.evaluate(() => {
    const getAuthor = (node) =>
      node?.querySelector?.("#author-name")?.innerText?.trim() || "Someone";
    const getMsg = (node) =>
      node?.querySelector?.("#message")?.innerText?.trim() || "";

    const list = document.querySelector("yt-live-chat-item-list-renderer #items")
              || document.querySelector("#item-list")
              || document.body;

    const seen = new WeakSet();

    // Scan existing once
    document.querySelectorAll("yt-live-chat-text-message-renderer").forEach((n) => {
      if (!seen.has(n)) {
        seen.add(n);
        const u = getAuthor(n);
        const m = getMsg(n);
        if (m) window.___onNewMsg(u, m);
      }
    });

    const mo = new MutationObserver((mut) => {
      for (const m of mut) {
        m.addedNodes?.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.tagName?.toLowerCase() === "yt-live-chat-text-message-renderer" && !seen.has(node)) {
            seen.add(node);
            const u = getAuthor(node);
            const msg = getMsg(node);
            if (msg) window.___onNewMsg(u, msg);
          }
        });
      }
    });
    mo.observe(list, { childList: true, subtree: true });
  });
}

// -------------------- BOT CORE --------------------
async function runBotOnUrl(liveUrl) {
  const url = toPopoutUrl(liveUrl);
  console.log(`🚀 Starting bot on: ${url}`);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--lang=en-US,en"
    ]
  });

  const page = await browser.newPage();

  // Desktop UA (important for chat UI)
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
  );

  // Set cookies (if present) so we can SEND messages
  if (cookies.length) {
    try {
      await page.setCookie(...cookies);
      console.log("✅ Cookies applied");
    } catch (e) {
      console.warn("⚠️  Failed to set cookies:", e.message);
    }
  }

  // Open live chat (popout)
  await page.goto(url, { waitUntil: "networkidle2", timeout: 90_000 });
  console.log("✅ Live chat loaded");

  // In popout, there is no iframe; chat is the page itself.
  const chatCtx = page;

  await observeChat(chatCtx, async (user, msg) => {
    console.log(`💬 ${user}: ${msg}`);

    // Trigger check
    if (!hasTrigger(msg)) return;

    const now = Date.now();

    // Global spacing
    if (now - lastGlobalReply < GLOBAL_INTERVAL_MS) return;

    // Per-user cooldown
    const last = userCooldown.get(user) || 0;
    if (now - last < COOLDOWN_MS) return;

    // Randomization
    if (Math.random() > REPLY_PROBABILITY) return;

    try {
      const reply = await aiReply(msg);
      console.log(`🤖 Replying to ${user}: ${reply}`);

      const ok = await typeAndSend(chatCtx, reply);
      if (!ok) {
        console.warn("⚠️  Could not find chat input to send message.");
        return;
      }

      lastGlobalReply = now;
      userCooldown.set(user, now);
    } catch (e) {
      console.error("❌ AI/Send error:", e.message);
    }
  });

  // Graceful cookie save on shutdown
  const saveAndClose = async () => {
    try {
      const c = await page.cookies();
      await fs.writeJSON("cookies.json", c, { spaces: 2 });
      console.log("💾 cookies.json saved");
    } catch (e) {
      console.warn("⚠️  Cookie save failed:", e.message);
    }
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", saveAndClose);
  process.on("SIGTERM", saveAndClose);

  console.log("👂 Bot is now listening for messages…");
  return { browser, page };
}

// -------------------- ROUTES --------------------

// Health
app.get("/", (_req, res) => {
  res.send("✅ YT AI Bot is up. Use /addChannel?url=... then /start");
});

// Add a channel/live (stores persistently)
app.get("/addChannel", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing ?url");
  channels.push({ url: String(url) });
  await fs.writeJSON(CHANNELS_FILE, channels, { spaces: 2 });
  res.send(`✅ Added: ${url}`);
});

// List channels
app.get("/channels", (_req, res) => {
  res.json(channels);
});

// Start on all saved channels or a single one via ?url=
app.get("/start", async (req, res) => {
  const singleUrl = req.query.url ? String(req.query.url) : null;
  const toStart = singleUrl ? [{ url: singleUrl }] : channels;
  if (!toStart.length) {
    return res.status(400).send("No channels found. Add one via /addChannel?url=...");
  }
  toStart.forEach(({ url }) => {
    runBotOnUrl(url).catch((e) => console.error("❌ Bot failed:", e.message));
  });
  res.send(`🚀 Starting bot on ${toStart.length} chat(s)…`);
});

// -------------------- START SERVER --------------------
app.listen(PORT, () => {
  console.log(`🌐 Server listening on ${PORT}`);
});
