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

async function capture(browser, loginName, password, route, fileName, viewport = { width: 1440, height: 1400, deviceScaleFactor: 2 }) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(viewport);
  await login(page, loginName, password);
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, fileName), fullPage: true });
  await context.close();
}

async function captureTaAdminMailPreview(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1400, deviceScaleFactor: 2 });
  await login(page, "taadmin1", "123456");
  await page.goto(`${BASE}/admin/ta/classes`, { waitUntil: "networkidle2" });
  const checkbox = await page.$(".ta-class-select");
  if (!checkbox) {
    throw new Error("No TA class checkbox found for email preview screenshot");
  }
  await checkbox.click();
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click('form[action="/admin/ta/classes/email-preview"] button[type="submit"]')
  ]);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "taadmin_mail_preview_v2.png"), fullPage: true });
  await context.close();
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  try {
    await capture(browser, "ta1", "123456", "/ta/classes", "student_classes_v2.png");
    await capture(browser, "ta1", "123456", "/ta/applications", "student_applications_v2.png");
    await capture(browser, "ta1", "123456", "/ta/profile", "student_profile_v2.png");

    await capture(browser, "taadmin1", "123456", "/admin/ta/pending", "taadmin_pending_v2.png");
    await capture(browser, "taadmin1", "123456", "/admin/ta/all", "taadmin_all_applications_v2.png");
    await capture(browser, "taadmin1", "123456", "/admin/ta/classes", "taadmin_classes_v2.png");
    await capture(browser, "taadmin1", "123456", "/admin/ta/manage", "taadmin_manage_v2.png");
    await captureTaAdminMailPreview(browser);

    await capture(browser, "courseadmin1", "123456", "/course/classes", "courseadmin_classes_v2.png");
    await capture(browser, "courseadmin1", "123456", "/course/users", "courseadmin_users_v2.png");
    await capture(browser, "courseadmin1", "123456", "/course/applications", "courseadmin_all_applications_v2.png");
    await capture(browser, "courseadmin1", "123456", "/course/reports", "courseadmin_reports_v2.png");

    console.log("role_guide_screenshots_done");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
