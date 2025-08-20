import express from "express";
import fs from "fs-extra";
import puppeteer from "puppeteer";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const PORT = process.env.PORT || 10000;

/* -------------------- CONFIG -------------------- */
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
if (!GEMINI_KEY) {
  console.warn("⚠️  GEMINI_API_KEY missing. Replies will be fallback text.");
}
const MODEL_ID = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const REPLY_PROBABILITY = Number(process.env.REPLY_PROBABILITY ?? 0.7); // 70%
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 60_000);          // 1 min
const GLOBAL_INTERVAL_MS = Number(process.env.GLOBAL_INTERVAL_MS ?? 10_000);
const CHANNELS_FILE = "channels.json";
const COOKIES_FILE = "cookies.json";

// default triggers (runtime me /setTriggers se change ho sakte)
let TRIGGERS = (process.env.TRIGGERS || "!suisui,!hellosuisui,!hello suisui,!sui")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

let lastGlobalReply = 0;
const userCooldown = new Map(); // user -> lastReplyTs

let channels = [];  // [{url}]
let cookies = [];   // from cookies.json
let browser = null; // single browser, multiple pages

// Gemini setup (lazy)
const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

/* -------------------- HELPERS -------------------- */
function toPopoutUrl(input) {
  try {
    if (!input) return input;
    if (input.includes("live_chat")) return input; // already popout
    const u = new URL(input);
    const v = u.searchParams.get("v");
    if (v) return `https://www.youtube.com/live_chat?is_popout=1&v=${v}`;
    // If full /live URL provided, still try popout with same param if present
    return input;
  } catch {
    // maybe directly a video id
    if (/^[\w-]{8,}$/.test(input)) {
      return `https://www.youtube.com/live_chat?is_popout=1&v=${input}`;
    }
    return input;
  }
}

function hasTrigger(msg) {
  const m = String(msg || "").toLowerCase();
  return TRIGGERS.some((t) => m.includes(t.toLowerCase()));
}

async function aiReply(text) {
  // fallback if no key
  if (!genAI) return "Sui Sui! 😄";
  try {
    const model = genAI.getGenerativeModel({ model: MODEL_ID });
    const prompt =
      `You are a casual, friendly YouTube live chat bot.\n` +
      `Reply briefly in Hinglish, fun but not spammy.\n` +
      `Avoid emojis overload; 1 max; no hashtags.\n` +
      `User: "${text}"\n` +
      `Bot (<= 1 line):`;
    const res = await model.generateContent(prompt);
    return (res.response.text() || "Sui Sui!").trim();
  } catch (e) {
    console.error("❌ Gemini error:", e.message);
    return "Sui Sui! (ai issue)";
  }
}

async function typeAndSend(chatCtx, text) {
  // Try multiple selectors for YT popout input
  const selectors = [
    "yt-live-chat-text-input-field-renderer #input #contenteditable-root",
    "#input #contenteditable-root",
    "#contenteditable-root",
    "#input"
  ];
  for (const sel of selectors) {
    try {
      await chatCtx.waitForSelector(sel, { timeout: 7000 });
      await chatCtx.focus(sel);
      // clear any residual text
      await chatCtx.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (!el) return;
        const range = document.createRange();
        range.selectNodeContents(el);
        const selObj = window.getSelection();
        selObj.removeAllRanges();
        selObj.addRange(range);
        document.execCommand("delete");
      }, sel);
      await chatCtx.keyboard.type(text);
      await chatCtx.keyboard.press("Enter");
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

async function observeChat(chatCtx, onMessage) {
  await chatCtx.exposeFunction("__onMsg__", (user, msg) => onMessage(user, msg));
  await chatCtx.evaluate(() => {
    const getAuthor = (node) =>
      node?.querySelector?.("#author-name")?.innerText?.trim() || "Someone";
    const getMsg = (node) =>
      node?.querySelector?.("#message")?.innerText?.trim() || "";

    const list =
      document.querySelector("yt-live-chat-item-list-renderer #items") ||
      document.querySelector("#item-list") ||
      document.body;

    const seen = new WeakSet();

    // fire existing
    document.querySelectorAll("yt-live-chat-text-message-renderer").forEach((n) => {
      if (!seen.has(n)) {
        seen.add(n);
        const u = getAuthor(n);
        const m = getMsg(n);
        if (m) window.__onMsg__(u, m);
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
            if (msg) window.__onMsg__(u, msg);
          }
        });
      }
    });
    mo.observe(list, { childList: true, subtree: true });
  });
}

/* -------------------- BOT CORE -------------------- */
async function runBotOnUrl(liveUrl) {
  const url = toPopoutUrl(liveUrl);
  console.log(`🚀 Starting bot on: ${url}`);

  // Create one browser for all channels (if not exists)
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: puppeteer.executablePath(), // auto-detect downloaded chromium
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--lang=en-US,en"
      ]
    });

    // graceful shutdown
    const saveAndClose = async () => {
      try {
        if (browser) {
          const pages = await browser.pages();
          if (pages.length) {
            try {
              const c = await pages[0].cookies();
              await fs.writeJSON(COOKIES_FILE, c, { spaces: 2 });
              console.log("💾 cookies.json saved");
            } catch (e) {
              console.warn("⚠️ Cookie save failed:", e.message);
            }
          }
          await browser.close();
        }
      } finally {
        process.exit(0);
      }
    };
    process.on("SIGINT", saveAndClose);
    process.on("SIGTERM", saveAndClose);
  }

  const page = await browser.newPage();

  // desktop UA helps
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
  );

  // apply cookies if any
  if (cookies.length) {
    try {
      await page.setCookie(...cookies);
      console.log("✅ Cookies applied");
    } catch (e) {
      console.warn("⚠️ setCookie failed:", e.message);
    }
  }

  // open live chat (popout)
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180_000 });
  // Let network settle a bit
  await page.waitForTimeout(4000);
  console.log("✅ Live chat loaded");

  // listen & reply
  await observeChat(page, async (user, msg) => {
    console.log(`💬 ${user}: ${msg}`);

    if (!hasTrigger(msg)) return;

    const now = Date.now();
    if (now - lastGlobalReply < GLOBAL_INTERVAL_MS) return;

    const last = userCooldown.get(user) || 0;
    if (now - last < COOLDOWN_MS) return;

    if (Math.random() > REPLY_PROBABILITY) return;

    try {
      const reply = await aiReply(msg);
      console.log(`🤖 Replying to ${user}: ${reply}`);
      const ok = await typeAndSend(page, reply);
      if (!ok) {
        console.warn("⚠️  Could not find chat input (login/cookies needed).");
        return;
      }
      lastGlobalReply = now;
      userCooldown.set(user, now);
    } catch (e) {
      console.error("❌ Reply error:", e.message);
    }
  });

  console.log("👂 Listening on:", url);
}

/* -------------------- INIT + ROUTES -------------------- */
async function init() {
  // preload channels from env (optional)
  const seed = (process.env.YT_CHANNELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((url) => ({ url }));

  // load channels.json
  if (await fs.pathExists(CHANNELS_FILE)) {
    channels = await fs.readJSON(CHANNELS_FILE).catch(() => []);
  }
  if (seed.length) {
    // merge unique
    const existing = new Set(channels.map((c) => toPopoutUrl(c.url)));
    seed.forEach((c) => {
      const p = toPopoutUrl(c.url);
      if (!existing.has(p)) channels.push({ url: c.url });
    });
    await fs.writeJSON(CHANNELS_FILE, channels, { spaces: 2 });
  }

  // load cookies.json if present
  if (await fs.pathExists(COOKIES_FILE)) {
    cookies = await fs.readJSON(COOKIES_FILE).catch(() => []);
    console.log(`🍪 cookies.json loaded (${cookies.length} cookies)`);
  }

  // routes
  app.get("/", (_req, res) => {
    res.send("✅ YT Gemini Bot is up. Use /addChannel?url=... then /start");
  });

  app.get("/addChannel", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send("Missing ?url");
    channels.push({ url: String(url) });
    await fs.writeJSON(CHANNELS_FILE, channels, { spaces: 2 });
    res.send(`✅ Added: ${url}`);
  });

  app.get("/channels", (_req, res) => res.json(channels));

  app.get("/start", async (req, res) => {
    const singleUrl = req.query.url ? String(req.query.url) : null;
    const list = singleUrl ? [{ url: singleUrl }] : channels;
    if (!list.length) {
      return res.status(400).send("No channels saved. Use /addChannel?url=...");
    }
    list.forEach(({ url }) =>
      runBotOnUrl(url).catch((e) => console.error("❌ Bot failed:", e.message))
    );
    res.send(`🚀 Starting bot on ${list.length} chat(s)…`);
  });

  app.get("/triggers", (_req, res) => res.json({ triggers: TRIGGERS }));

  app.get("/setTriggers", (req, res) => {
    const raw = String(req.query.list || "");
    if (!raw) return res.status(400).send("Pass ?list=!sui,!hello suisui");
    TRIGGERS = raw.split(",").map((t) => t.trim()).filter(Boolean);
    res.json({ ok: true, triggers: TRIGGERS });
  });

  app.get("/stats", (_req, res) => {
    res.json({
      triggers: TRIGGERS,
      cooldown_ms: COOLDOWN_MS,
      global_interval_ms: GLOBAL_INTERVAL_MS,
      reply_probability: REPLY_PROBABILITY,
      userCooldownSize: userCooldown.size,
      lastGlobalReply
    });
  });

  app.listen(PORT, () => console.log(`🌐 Server listening on ${PORT}`));
}

init();
