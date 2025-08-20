import express from "express";
import fs from "fs-extra";
import puppeteer from "puppeteer";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const PORT = process.env.PORT || 10000;

// -------------------- CONFIG --------------------
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
if (!GEMINI_KEY) {
  console.warn("⚠️ GEMINI_API_KEY missing. Replies will be default text.");
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

// -------------------- HELPERS --------------------
function toPopoutUrl(input) {
  try {
    if (input.includes("live_chat")) return input;
    const u = new URL(input);
    const v = u.searchParams.get("v");
    if (v) return `https://www.youtube.com/live_chat?is_popout=1&v=${v}`;
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
  if (!genAI) return "Sui Sui! 😄";
  const model = genAI.getGenerativeModel({ model: MODEL_ID });
  const prompt =
    `You are a casual, friendly YouTube live chat bot.\n` +
    `Reply briefly in Hinglish, fun but not spammy.\n` +
    `User message: "${text}"\n` +
    `Your reply (max ~1 line):`;
  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

async function typeAndSend(chatCtx, text) {
  const selectors = [
    "#input #contenteditable-root",
    "yt-live-chat-text-input-field-renderer #input #contenteditable-root",
    "#input",
    "#contenteditable-root"
  ];
  for (const sel of selectors) {
    try {
      await chatCtx.waitForSelector(sel, { timeout: 5000 });
      await chatCtx.focus(sel);
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
  await chatCtx.exposeFunction("___onNewMsg", (user, msg) => onMessage(user, msg));
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
          if (
            node.tagName?.toLowerCase() === "yt-live-chat-text-message-renderer" &&
            !seen.has(node)
          ) {
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
async function runBotOnUrl(liveUrl, cookies = []) {
  const url = toPopoutUrl(liveUrl);
  console.log(`🚀 Starting bot on: ${url}`);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      "/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
  );

  if (cookies.length) {
    try {
      await page.setCookie(...cookies);
      console.log("✅ Cookies applied");
    } catch (e) {
      console.warn("⚠️ Failed to set cookies:", e.message);
    }
  }

  await page.goto(url, { waitUntil: "networkidle2", timeout: 90_000 });
  console.log("✅ Live chat loaded");

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
      console.log(`🤖 Replying: ${reply}`);
      const ok = await typeAndSend(page, reply);
      if (ok) {
        lastGlobalReply = now;
        userCooldown.set(user, now);
      }
    } catch (e) {
      console.error("❌ Reply error:", e.message);
    }
  });

  process.on("SIGINT", async () => {
    const c = await page.cookies();
    await fs.writeJSON("cookies.json", c, { spaces: 2 });
    await browser.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    const c = await page.cookies();
    await fs.writeJSON("cookies.json", c, { spaces: 2 });
    await browser.close();
    process.exit(0);
  });

  console.log("👂 Bot is now listening…");
}

// -------------------- INIT + ROUTES --------------------
async function init() {
  const CHANNELS_FILE = "channels.json";
  let channels = [];
  if (await fs.pathExists(CHANNELS_FILE)) {
    channels = await fs.readJSON(CHANNELS_FILE).catch(() => []);
  }

  let cookies = [];
  if (await fs.pathExists("cookies.json")) {
    cookies = await fs.readJSON("cookies.json").catch(() => []);
    console.log(`🍪 cookies.json loaded (${cookies.length} cookies)`);
  }

  // Routes
  app.get("/", (_req, res) => res.send("✅ YT AI Bot is running."));

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
    const toStart = singleUrl ? [{ url: singleUrl }] : channels;
    if (!toStart.length) {
      return res.status(400).send("No channels saved. Use /addChannel?url=...");
    }
    toStart.forEach(({ url }) =>
      runBotOnUrl(url, cookies).catch((e) => console.error("❌ Bot failed:", e.message))
    );
    res.send(`🚀 Starting bot on ${toStart.length} chat(s)…`);
  });

  app.listen(PORT, () => console.log(`🌐 Server running on ${PORT}`));
}

init();
