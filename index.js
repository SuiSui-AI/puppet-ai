import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const PORT = process.env.PORT || 10000;

// Load channels.json
let channels = [];
if (fs.existsSync("channels.json")) {
  channels = JSON.parse(fs.readFileSync("channels.json", "utf-8"));
}

// AI setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper: run Puppeteer bot
async function runBot(liveUrl) {
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
    await page.goto(liveUrl, { waitUntil: "networkidle2", timeout: 60000 });

    console.log(`✅ Bot started on ${liveUrl}`);

    // Example: Read live chat or interact
    await page.waitForTimeout(5000);

    await browser.close();
  } catch (err) {
    console.error("❌ Bot failed:", err);
  }
}

// Route: Start bot for all channels
app.get("/start", async (req, res) => {
  if (channels.length === 0) {
    return res.status(400).send("No channels found. Add channel first.");
  }

  for (const ch of channels) {
    runBot(ch.url);
  }

  res.send("✅ Bot started for all channels");
});

// Route: Add new channel
app.get("/addChannel", (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Channel URL required");

  channels.push({ url });
  fs.writeFileSync("channels.json", JSON.stringify(channels, null, 2));

  res.send(`✅ Channel added: ${url}`);
});

// Root
app.get("/", (req, res) => {
  res.send("🚀 YT Bot is live!");
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
