import express from "express";
import puppeteer from "puppeteer";
import fs from "fs-extra";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const COOKIE_FILE = "./cookies.json";

app.get("/start", async (req, res) => {
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    if (fs.existsSync(COOKIE_FILE)) {
      const cookies = await fs.readJSON(COOKIE_FILE);
      await page.setCookie(...cookies);
      console.log("Cookies loaded");
    }

    await page.goto("https://www.youtube.com", { waitUntil: "networkidle2" });
    console.log("Page loaded");

    fs.writeJSONSync(COOKIE_FILE, await page.cookies(), { spaces: 2 });
    console.log("Cookies saved");

    await browser.close();
    res.send("Puppeteer ran successfully on Render!");
  } catch (err) {
    console.error("Error:", err);
    res.status(500).send("Error: " + err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
