import express from "express";
import puppeteer from "puppeteer";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs-extra";

const app = express();

// ---------- GEMINI SETUP ----------
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// ---------- ANTI-SPAM CONFIG ----------
const REPLY_PROBABILITY = 0.7;
const COOLDOWN_MS = 60 * 1000;
const GLOBAL_INTERVAL = 10 * 1000;

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
      ]
    });

    const page = await browser.newPage();

    // Load cookies
    if (fs.existsSync("cookies.json")) {
      const cookies = JSON.parse(fs.readFileSync("cookies.json"));
      await page.setCookie(...cookies);
      console.log("✅ Cookies loaded");
    }

    await page.goto("https://www.youtube.com/live_chat?is_popout=1&v=VIDEO_ID", {
      waitUntil: "networkidle2",
    });

    console.log("✅ Connected to Live Chat!");

    // Expose handler
    await page.exposeFunction("handleNewMessage", async (user, msg) => {
      console.log(`💬 ${user}: ${msg}`);
      const now = Date.now();
      const lowerMsg = msg.toLowerCase();

      if (TRIGGERS.some(t => lowerMsg.includes(t))) {
        if (now - lastReplyTime < GLOBAL_INTERVAL) return;
        if (userCooldown.has(user) && now - userCooldown.get(user) < COOLDOWN_MS) return;

        if (Math.random() < REPLY_PROBABILITY) {
          const result = await model.generateContent(`Reply to: ${msg}`);
          const reply = result.response.text();
          console.log(`🤖 Replying: ${reply}`);

          await page.type("#input", reply);
          await page.keyboard.press("Enter");

          lastReplyTime = now;
          userCooldown.set(user, now);
        }
      }
    });

    // Inject observer into chat
    await page.evaluate(() => {
      const chat = document.querySelector("#item-scroller");
      const observer = new MutationObserver(muts => {
        muts.forEach(m => {
          m.addedNodes.forEach(n => {
            const author = n.querySelector("#author-name")?.innerText || "Unknown";
            const msg = n.querySelector("#message")?.innerText;
            if (msg) {
              window.handleNewMessage(author, msg);
            }
          });
        });
      });
      observer.observe(chat, { childList: true, subtree: true });
    });

    res.send("✅ Bot started and connected to live chat!");
  } catch (err) {
    console.error("❌ Bot error:", err);
    res.status(500).send("Error: " + err.message);
  }
});

app.listen(3000, () => console.log("🚀 Server running on port 3000"));
