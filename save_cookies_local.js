// run locally: node save_cookies_local.js
import puppeteer from "puppeteer";
import fs from "fs";

(async () => {
  const browser = await puppeteer.launch({ headless: false, args: ["--no-sandbox"] });
  const page = await browser.newPage();

  console.log("Opening YouTube. Please sign in manually in the opened browser window.");
  await page.goto("https://www.youtube.com", { waitUntil: "networkidle2" });

  console.log("After you complete sign-in (including 2FA if any), press Enter here in terminal to save cookies.");
  await new Promise(resolve => process.stdin.once("data", resolve));

  const cookies = await page.cookies();
  fs.writeFileSync("cookies.json", JSON.stringify(cookies, null, 2));
  console.log("Saved cookies.json — keep it safe!");

  await browser.close();
  process.exit(0);
})();
