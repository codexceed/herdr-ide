// Renders an HTML file to a PNG for the editor's HTML preview (mods/ide-editor/main.js).
// Herdr mods have no web view, so the page is laid out by headless Chrome, scripts and all,
// and shown as an image. Puppeteer comes from mermaid-cli, which the installer already sets up.
//
//   node html_shot.cjs <page.html> <out.png> <width> <dark|light>
//
// Prints "<width> <height>" in CSS pixels; the PNG is twice that (SCALE).
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const puppeteer = require("puppeteer");

const SCALE = 2, MAX_HEIGHT = 12000, SETTLE_MS = 5000;

(async () => {
  const [page_, out, width, look] = process.argv.slice(2);
  const browser = await puppeteer.launch({ headless: "shell" });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: Math.max(200, Number(width) || 800), height: 100, deviceScaleFactor: SCALE });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: look === "light" ? "light" : "dark" }]);
    // Wait for the page's own requests (fonts, scripts from a CDN) a few seconds at most.
    // A URL, not "file://" + path: "#", "?" and "%" in a file name are path, not URL syntax.
    await page.goto(pathToFileURL(path.resolve(page_)).href, { waitUntil: "networkidle0", timeout: SETTLE_MS })
      .catch(e => { if (!/timeout/i.test(String(e?.message))) throw e; });
    const size = await page.evaluate(() => {
      const d = document.documentElement, b = document.body;
      return { w: Math.ceil(d.clientWidth), h: Math.ceil(Math.max(d.scrollHeight, b?.scrollHeight ?? 0)) };
    });
    const h = Math.max(1, Math.min(size.h, MAX_HEIGHT));
    const tmp = `${out}.${process.pid}.png`;
    await page.screenshot({ path: tmp, clip: { x: 0, y: 0, width: size.w, height: h }, captureBeyondViewport: true });
    fs.renameSync(tmp, out);
    process.stdout.write(`${size.w} ${h}${size.h > MAX_HEIGHT ? " cut" : ""}\n`);
  } finally {
    await browser.close();
  }
})().catch(e => { process.stderr.write(String(e?.message ?? e) + "\n"); process.exit(1); });
