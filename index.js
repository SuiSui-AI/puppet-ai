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
const GLOBAL_INTERVAL = 10 * 1000; // 10 sec gap between replies

let lastReplyTime = 0;
const userCooldown = new Map();

// ---------- TRIGGERS ----------
const TRIGGERS = ["!suisui", "!hellosuisui", "!hello suisui", "!sui"];

// ---------- START ROUTE ----------
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
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();

    // Load cookies if available
    if (fs.existsSync("cookies.json")) {
      const cookies = JSON.parse(fs.readFileSync("cookies.json"));
      await page.setCookie(...cookies);
      console.log("✅ Cookies loaded");
    }

    // Open YouTube live chat
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

      // Cooldown check
      if (userCooldown.has(user) && now - userCooldown.get(user) < COOLDOWN_MS) return;
      if (now - lastReplyTime < GLOBAL_INTERVAL) return;

      if (Math.random() > REPLY_PROBABILITY) return;

      userCooldown.set(user, now);
      lastReplyTime = now;

      try {
        const result = await model.generateContent(
          `YouTube live chat message: "${msg}". Reply in short, fun Hinglish style.`
        );
        const reply = result.response.text();

        console.log(`🤖 Replying: ${reply}`);

        // Type reply into chat box
        await page.type("#input", reply);
        await page.keyboard.press("Enter");
      } catch (err) {
        console.error("❌ Gemini reply error:", err);
      }
    });

    // Inject script to detect messages
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        document.querySelectorAll("#message").forEach((el) => {
          const user = el.closest("#chat-metadata")?.innerText || "Unknown";
          const msg = el.innerText;
          window.handleNewMessage(user, msg);
        });
      });
      observer.observe(document.querySelector("#item-scroller"), {
        childList: true,
        subtree: true,
      });
    });

    res.send("🤖 Bot started successfully!");
  } catch (error) {
    console.error("❌ Error starting bot:", error);
    res.status(500).send("Bot failed to start.");
  }
});

// ---------- SERVER LISTEN ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
