import express from "express";
import fs from "fs";
import puppeteer from "puppeteer";
import TelegramBot from "node-telegram-bot-api";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

// Env vars (set in Render)
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const COOKIE_UPLOAD_SECRET = process.env.COOKIE_UPLOAD_SECRET || "change_this";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
let ACTIVE_VIDEO = process.env.DEFAULT_VIDEO_ID || ""; // can be set via /setvideo

const COOKIES_PATH = "./cookies.json";

// ---------- Upload cookies endpoint (secure) ----------
app.post("/upload-cookies", (req, res) => {
  const key = req.header("x-cookie-key");
  if (!key || key !== COOKIE_UPLOAD_SECRET) return res.status(401).send("unauthorized");
  const cookies = req.body;
  if (!cookies || !Array.isArray(cookies)) return res.status(400).send("send an array of cookies JSON");
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  return res.send("cookies saved");
});

// ---------- Helper: Gemini generate ----------
async function generateFromGemini(prompt) {
  try {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + GEMINI_API_KEY;
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      // optional generationConfig here
    };
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return text || null;
  } catch (e) {
    console.error("Gemini error", e);
    return null;
  }
}

// ---------- Helper: send message via Puppeteer ----------
async function sendMessageToVideo(videoId, message) {
  if (!fs.existsSync(COOKIES_PATH)) throw new Error("cookies.json not found on server. Upload via /upload-cookies");
  const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH));

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--single-process",
      "--no-zygote"
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setCookie(...cookies);

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // wait sometime for chat iframe
    await page.waitForTimeout(3000);

    // find chat iframe
    const frames = page.frames();
    let chatFrame = frames.find(f => f.url().includes("live_chat"));
    if (!chatFrame) {
      // fallback: sometimes chat is in a different frame
      chatFrame = frames.find(f => f.url().includes("watch"));
    }

    // selectors to try
    const selectors = [
      "#input", // common
      "textarea#input",
      "yt-live-chat-text-input-field-renderer #input",
      "div#placeholder-area",
      "yt-live-chat-text-input-renderer textarea"
    ];

    let usedFrame = null, usedSelector = null;
    if (chatFrame) {
      for (const s of selectors) {
        const el = await chatFrame.$(s).catch(() => null);
        if (el) { usedFrame = chatFrame; usedSelector = s; break; }
      }
    }
    if (!usedFrame) {
      for (const s of selectors) {
        const el = await page.$(s).catch(() => null);
        if (el) { usedFrame = page; usedSelector = s; break; }
      }
    }
    if (!usedFrame) throw new Error("chat input not found — DOM changed or chat disabled.");

    // type like human
    const typer = usedFrame === page ? page : usedFrame;
    await typer.focus(usedSelector);
    // clear existing:
    // type char-by-char with random delay
    function rand(delayMin=50, delayMax=160){ return Math.floor(Math.random()*(delayMax-delayMin))+delayMin; }
    for (const ch of message) {
      await typer.type(usedSelector, ch, { delay: rand(40, 140) });
    }
    // press Enter
    await typer.keyboard.press("Enter");
    // small wait to ensure send
    await page.waitForTimeout(1200);

  } finally {
    await browser.close();
  }
}

// ---------- Express test route ----------
app.get("/", (req, res) => {
  res.send("YT Puppeteer Gemini server running. Use /upload-cookies and Telegram bot.");
});

// ---------- Simple API to send (protected by secret) ----------
app.post("/send", async (req, res) => {
  const key = req.header("x-cookie-key");
  if (!key || key !== COOKIE_UPLOAD_SECRET) return res.status(401).send("unauthorized");
  const { videoId, text } = req.body;
  if (!videoId || !text) return res.status(400).send("provide videoId and text");
  try {
    await sendMessageToVideo(videoId, text);
    return res.send({ status: "sent" });
  } catch (e) {
    console.error(e);
    return res.status(500).send(String(e));
  }
});

// ---------- Telegram bot integration (control) ----------
let tgBot;
if (TELEGRAM_TOKEN) {
  tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  tgBot.onText(/\/setvideo (.+)/, (msg, match) => {
    ACTIVE_VIDEO = match[1].trim();
    tgBot.sendMessage(msg.chat.id, `Active video set to: ${ACTIVE_VIDEO}`);
  });

  tgBot.onText(/\/send (.+)/, async (msg, match) => {
    const text = match[1].trim();
    if (!ACTIVE_VIDEO) return tgBot.sendMessage(msg.chat.id, "Set active video first: /setvideo <VIDEO_ID>");
    try {
      await sendMessageToVideo(ACTIVE_VIDEO, text);
      tgBot.sendMessage(msg.chat.id, `✅ Sent: ${text}`);
    } catch (e) {
      console.error(e);
      tgBot.sendMessage(msg.chat.id, `❌ Error: ${String(e).slice(0,150)}`);
    }
  });

  // If any non-command text arrives, generate via Gemini and send
  tgBot.on("message", async (msg) => {
    const txt = msg.text || "";
    if (txt.startsWith("/")) return; // handled above
    if (!ACTIVE_VIDEO) return tgBot.sendMessage(msg.chat.id, "Set active video first: /setvideo <VIDEO_ID>");
    // generate prompt for Gemini
    const prompt = `You are SuiSui, a friendly short YouTube viewer. Reply to this: "${txt}" Keep it casual, short, and ask one follow-up.`;
    const reply = await generateFromGemini(prompt) || "Sui sui! 😄";
    try {
      await sendMessageToVideo(ACTIVE_VIDEO, reply);
      tgBot.sendMessage(msg.chat.id, `Sent AI reply: ${reply}`);
    } catch (e) {
      tgBot.sendMessage(msg.chat.id, `Send failed: ${String(e).slice(0,150)}`);
    }
  });
} else {
  console.log("TELEGRAM_TOKEN not set — Telegram control disabled.");
}

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
