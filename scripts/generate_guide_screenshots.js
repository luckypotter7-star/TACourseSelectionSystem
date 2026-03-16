const path = require("node:path");
const puppeteer = require("puppeteer-core");

const BASE = "http://127.0.0.1:3000";
const SCREENSHOT_DIR = "/Users/yanren/Documents/Playground/screenshots";
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function login(page, loginName, password) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
  await page.type('input[name="login_name"]', loginName);
  await page.type('input[name="password"]', password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click('button[type="submit"]')
  ]);
}

async function captureTaApplications(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1080, deviceScaleFactor: 2 });
  await login(page, "ta1", "123456");
  await page.goto(`${BASE}/ta/applications`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "ta_my_applications.png"), fullPage: true });
  await context.close();
}

async function captureProfessorPending(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1080, deviceScaleFactor: 2 });
  await login(page, "prof1", "123456");
  await page.goto(`${BASE}/professor/pending`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "professor_pending.png"), fullPage: true });
  await context.close();
}

async function captureMailPreview(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 2 });
  await login(page, "taadmin1", "123456");
  await page.goto(`${BASE}/admin/ta/classes`, { waitUntil: "networkidle2" });
  await page.click('.ta-class-select[value="2"]');
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click('form[action="/admin/ta/classes/email-preview"] button[type="submit"]')
  ]);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "taadmin_email_preview.png"), fullPage: true });
  await context.close();
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: CHROME_PATH,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  try {
    await captureTaApplications(browser);
    await captureProfessorPending(browser);
    await captureMailPreview(browser);
    console.log("screenshots_done");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
