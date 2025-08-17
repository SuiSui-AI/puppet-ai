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
  ]
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

      // ----- Trigger Check -----
      if (!TRIGGERS.some(t => lowerMsg.includes(t))) {
        console.log("⏭️ No trigger, skipped");
        return;
      }

      // ----- Anti-Spam Check -----
      if (Math.random() > REPLY_PROBABILITY) {
        console.log("⏭️ Skipped (probability)");
        return;
      }
      if (now - lastReplyTime < GLOBAL_INTERVAL) {
        console.log("⏭️ Skipped (global interval)");
        return;
      }
      if (userCooldown.has(user) && now - userCooldown.get(user) < COOLDOWN_MS) {
        console.log("⏭️ Skipped (user cooldown)");
        return;
      }

      // ----- AI Response -----
      try {
        const result = await model.generateContent(
          `User said: "${msg}". Reply casually in Hinglish, friendly and short.`
        );
        const reply = result.response.text();
        console.log("🤖 AI:", reply);

        // Send reply
        await page.type("#input.yt-live-chat-text-input-field-renderer", reply);
        await page.keyboard.press("Enter");

        // Update trackers
        lastReplyTime = now;
        userCooldown.set(user, now);
      } catch (err) {
        console.log("⚠️ Message send failed:", err.message);
      }
    });

    // Observe DOM for new chat lines
    await page.evaluate(() => {
      const chat = document.querySelector("#item-scroller");
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((m) => {
          m.addedNodes.forEach((node) => {
            const userNode = node.querySelector("#author-name");
            const textNode = node.querySelector("#message");
            if (userNode && textNode) {
              window.handleNewMessage(userNode.innerText, textNode.innerText);
            }
          });
        });
      });
      observer.observe(chat, { childList: true });
    });

    res.send("🤖 Bot started with trigger system + anti-spam!");
  } catch (err) {
    console.error("❌ Error:", err);
    res.send("❌ Bot error: " + err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
