import express from "express";
import puppeteer from "puppeteer-core";
import chrome from "chrome-aws-lambda";
import fs from "fs";

const app = express();

app.get("/start", async (req, res) => {
  try {
    const browser = await puppeteer.launch({
      args: chrome.args,
      executablePath: await chrome.executablePath,
      headless: chrome.headless,
    });

    const page = await browser.newPage();

    // Load cookies agar file exist karti hai
    if (fs.existsSync("cookies.json")) {
      const cookies = JSON.parse(fs.readFileSync("cookies.json"));
      await page.setCookie(...cookies);
      console.log("✅ Cookies loaded");
    }

    await page.goto("https://www.youtube.com", { waitUntil: "networkidle2" });

    res.send("✅ Puppeteer started on Render");
  } catch (err) {
    console.error("❌ Puppeteer launch failed:", err);
    res.status(500).send("Error: " + err.message);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("✅ Server running on port", process.env.PORT || 3000);
});
