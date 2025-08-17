import express from "express";
import puppeteer from "puppeteer";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

const app = express();

// ---------- GEMINI SETUP ----------
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// ---------- ANTI-SPAM CONFIG ----------
const REPLY_PROBABILITY = 0.7; // 70% chance, since trigger word used
const COOLDOWN_MS = 60 * 1000; // 1 min cooldown per user
const GLOBAL_INTERVAL = 10 * 1000; // 10 sec interval between replies

let lastReplyTime = 0;
const userCooldown = new Map();

// ---------- TRIGGERS ----------
const TRIGGERS = ["!suisui", "!hellosuisui", "!hello suisui", "!sui"];

// ---------- PUPPETEER ROUTE ----------
app.get("/start", async (req, res) => {
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu"
      ],
    });

    const page = await browser.newPage();

    // Load cookies (pehle se saved)
    if (fs.existsSync("cookies.json")) {
      const cookies = JSON.parse(fs.readFileSync("cookies.json"));
      await page.setCookie(...cookies);
      console.log("✅ Cookies loaded");
    }

    // YouTube live chat page open
    await page.goto("https://www.youtube.com/live_chat?is_popout=1&v=VIDEO_ID", {
      waitUntil: "networkidle2",
    });

    console.log("✅ Connected to Live Chat!");

    // Observe chat messages
    await page.exposeFunction("handleNewMessage", async (user, msg) => {
      console.log(`💬 ${user}: ${msg}`);

      const now = Date.now();
      const lowerMsg = msg.toLowerCase();

      // Trigger check
      if (!TRIGGERS.some(t => lowerMsg.includes(t))) return;

      // Cooldown check
      if (userCooldown.has(user) && now - userCooldown.get(user) < COOLDOWN_MS) return;
      if (now - lastReplyTime < GLOBAL_INTERVAL) return;

      userCooldown.set(user, now);
      lastReplyTime = now;

      if (Math.random() > REPLY_PROBABILITY) return;

      try {
        const result = await model.generateContent(`Reply in a fun, friendly way to: "${msg}"`);
        const reply = result.response.text();

        console.log(`🤖 Replying to ${user}: ${reply}`);

        await page.evaluate((reply) => {
          const input = document.querySelector("#input.yt-live-chat-text-input-field-renderer");
          const btn = document.querySelector("#send-button button");
          if (input && btn) {
            input.innerText = reply;
            btn.click();
          }
        }, reply);

      } catch (err) {
        console.error("❌ Gemini error:", err);
      }
    });

    res.send("✅ Bot started and connected to chat!");
  } catch (err) {
    console.error("❌ Puppeteer error:", err);
    res.status(500).send("Bot failed to start.");
  }
});

app.listen(3000, () => console.log("🚀 Server running on port 3000"));
