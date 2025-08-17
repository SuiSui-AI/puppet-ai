import express from "express";
import puppeteer from "puppeteer";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs-extra";

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- GEMINI SETUP ----------
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// ---------- ANTI-SPAM CONFIG ----------
const REPLY_PROBABILITY = 0.7; // 70% chance when trigger is used
const COOLDOWN_MS = 60 * 1000; // 1 min cooldown per user
const GLOBAL_INTERVAL = 10 * 1000; // 10 sec global cooldown

let lastReplyTime = 0;
const userCooldown = new Map();

// ---------- TRIGGERS ----------
const TRIGGERS = ["!suisui", "!hellosuisui", "!hello suisui", "!sui"];

// ---------- MAIN ROUTE ----------
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

    // Load cookies if available
    if (fs.existsSync("cookies.json")) {
      const cookies = JSON.parse(await fs.readFile("cookies.json"));
      await page.setCookie(...cookies);
      console.log("✅ Cookies loaded");
    }

    // Open YouTube Live Chat
    await page.goto("https://www.youtube.com/live_chat?is_popout=1&v=VIDEO_ID", {
      waitUntil: "networkidle2",
    });
    console.log("✅ Connected to Live Chat!");

    // Expose message handler
    await page.exposeFunction("handleNewMessage", async (user, msg) => {
      console.log(`💬 ${user}: ${msg}`);

      const now = Date.now();
      const lowerMsg = msg.toLowerCase();

      // Trigger check
      if (!TRIGGERS.some(t => lowerMsg.includes(t))) return;

      // User cooldown check
      if (userCooldown.has(user) && now - userCooldown.get(user) < COOLDOWN_MS) {
        console.log(`⏳ Cooldown active for ${user}`);
        return;
      }

      // Global cooldown check
      if (now - lastReplyTime < GLOBAL_INTERVAL) {
        console.log("⏳ Global cooldown active");
        return;
      }

      // Random probability check
      if (Math.random() > REPLY_PROBABILITY) {
        console.log("⚡ Reply skipped by probability");
        return;
      }

      // Generate reply with Gemini
      const result = await model.generateContent(`Reply fun and short to: ${msg}`);
      const reply = result.response.text();
      console.log(`🤖 Replying: ${reply}`);

      // Send message in chat
      await page.type("#input.yt-live-chat-text-input-field-renderer", reply);
      await page.keyboard.press("Enter");

      lastReplyTime = now;
      userCooldown.set(user, now);
    });

    // Watch chat messages
    await page.evaluate(() => {
      const chat = document.querySelector("#item-offset");
      const observer = new MutationObserver(() => {
        document.querySelectorAll("#message").forEach(el => {
          const msg = el.innerText;
          const user = el.closest("#author-name")?.innerText || "Unknown";
          window.handleNewMessage(user, msg);
        });
      });
      observer.observe(chat, { childList: true, subtree: true });
    });

    res.send("✅ Bot started and connected to chat!");
  } catch (err) {
    console.error("❌ Error starting bot:", err);
    res.status(500).send("Bot error: " + err.message);
  }
});

// ---------- KEEP SERVER RUNNING ----------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
