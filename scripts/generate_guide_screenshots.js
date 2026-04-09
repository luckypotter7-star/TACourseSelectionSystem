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

async function captureTaClasses(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 2 });
  await login(page, "ta1", "123456");
  await page.goto(`${BASE}/ta/classes`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "ta_classes_current.png"), fullPage: true });
  await context.close();
}

async function captureTaProfile(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 2 });
  await login(page, "ta1", "123456");
  await page.goto(`${BASE}/ta/profile`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "ta_profile_current.png"), fullPage: true });
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

async function captureTaAdminPending(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 2 });
  await login(page, "taadmin1", "123456");
  await page.goto(`${BASE}/admin/ta/pending`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "taadmin_pending_current.png"), fullPage: true });
  await context.close();
}

async function captureTaAdminManage(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 2 });
  await login(page, "taadmin1", "123456");
  await page.goto(`${BASE}/admin/ta/manage`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "taadmin_manage_current.png"), fullPage: true });
  await context.close();
}

async function captureTaAdminClasses(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1300, deviceScaleFactor: 2 });
  await login(page, "taadmin1", "123456");
  await page.goto(`${BASE}/admin/ta/classes`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "taadmin_classes_current.png"), fullPage: true });
  await context.close();
}

async function captureCourseAdminUsers(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 2 });
  await login(page, "courseadmin1", "123456");
  await page.goto(`${BASE}/course/users`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "courseadmin_users_current.png"), fullPage: true });
  await context.close();
}

async function captureCourseAdminClasses(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1300, deviceScaleFactor: 2 });
  await login(page, "courseadmin1", "123456");
  await page.goto(`${BASE}/course/classes`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "courseadmin_classes_current.png"), fullPage: true });
  await context.close();
}

async function captureCourseAdminApplications(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 2 });
  await login(page, "courseadmin1", "123456");
  await page.goto(`${BASE}/course/applications`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "courseadmin_applications_current.png"), fullPage: true });
  await context.close();
}

async function captureCourseAdminReports(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1400, deviceScaleFactor: 2 });
  await login(page, "courseadmin1", "123456");
  await page.goto(`${BASE}/course/reports`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "courseadmin_reports_current.png"), fullPage: true });
  await context.close();
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: CHROME_PATH,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  try {
    await captureTaClasses(browser);
    await captureTaApplications(browser);
    await captureTaProfile(browser);
    await captureTaAdminPending(browser);
    await captureTaAdminManage(browser);
    await captureTaAdminClasses(browser);
    await captureProfessorPending(browser);
    await captureMailPreview(browser);
    await captureCourseAdminClasses(browser);
    await captureCourseAdminUsers(browser);
    await captureCourseAdminApplications(browser);
    await captureCourseAdminReports(browser);
    console.log("screenshots_done");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
