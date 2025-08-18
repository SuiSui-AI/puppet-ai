import express from "express";
import puppeteer from "puppeteer";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";

const app = express();

// ---------- GEMINI SETUP ----------
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// ---------- ANTI-SPAM CONFIG ----------
const REPLY_PROBABILITY = 0.7; // 70% chance
const COOLDOWN_MS = 60 * 1000; // 1 min cooldown per user
const GLOBAL_INTERVAL = 10 * 1000; // 10 sec between replies

let lastReplyTime = 0;
const userCooldown = new Map();

// ---------- TRIGGERS ----------
const TRIGGERS = ["!suisui", "!hellosuisui", "!hello suisui", "!sui"];

// ---------- START BOT ----------
app.get("/start", async (req, res) => {
  try {
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();

    // Load cookies (if available)
    if (fs.existsSync("cookies.json")) {
      const cookies = JSON.parse(fs.readFileSync("cookies.json"));
      if (cookies.length > 0) {
        await page.setCookie(...cookies);
        console.log("✅ Cookies loaded");
      }
    }

    // YouTube Live Chat (replace VIDEO_ID)
    await page.goto("https://www.youtube.com/live/oJDmPhb4YRw?si=KDsHaNoVmcaRaLxD", {
      waitUntil: "networkidle2",
    });

    console.log("✅ Connected to Live Chat!");

    // Observe chat messages
    await page.exposeFunction("handleNewMessage", async (user, msg) => {
      console.log(`💬 ${user}: ${msg}`);

      const now = Date.now();
      const lowerMsg = msg.toLowerCase();

      // Trigger check
      if (!TRIGGERS.some((t) => lowerMsg.includes(t))) return;

      // Global cooldown
      if (now - lastReplyTime < GLOBAL_INTERVAL) return;

      // User cooldown
      if (userCooldown.has(user) && now - userCooldown.get(user) < COOLDOWN_MS) return;

      // Probability
      if (Math.random() > REPLY_PROBABILITY) return;

      try {
        const aiReply = await model.generateContent(
          `User: ${msg}\nBot: (reply in casual Hinglish, short and funny)`
        );

        const replyText = aiReply.response.text();
        console.log(`🤖 Replying: ${replyText}`);

        await page.type("#input", replyText);
        await page.keyboard.press("Enter");

        // update timers
        lastReplyTime = now;
        userCooldown.set(user, now);
      } catch (err) {
        console.error("❌ AI error:", err);
      }
    });

    // Inject script to listen to chat
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        const items = document.querySelectorAll("#message");
        const lastItem = items[items.length - 1];
        if (lastItem) {
          const user = lastItem.closest("yt-live-chat-text-message-renderer")?.querySelector("#author-name")?.innerText;
          const msg = lastItem.innerText;
          if (user && msg) {
            window.handleNewMessage(user, msg);
          }
        }
      });
      observer.observe(document.querySelector("#item-list"), { childList: true });
    });

    // Save cookies before exit
    process.on("SIGINT", async () => {
      const cookies = await page.cookies();
      fs.writeFileSync("cookies.json", JSON.stringify(cookies, null, 2));
      console.log("💾 Cookies saved!");
      await browser.close();
      process.exit();
    });

    res.send("✅ Bot started!");
  } catch (err) {
    console.error("❌ Bot failed:", err);
    res.status(500).send("Bot failed to start.");
  }
});

// ---------- SERVER LISTEN ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
