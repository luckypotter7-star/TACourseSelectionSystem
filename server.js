const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const querystring = require("node:querystring");
const { DatabaseSync } = require("node:sqlite");
const XLSX = require("xlsx");

const BASE_DIR = __dirname;
const DB_PATH = path.join(BASE_DIR, "ta_system_node.db");
const UPLOAD_DIR = path.join(BASE_DIR, "uploads");
const PORT = 3000;
const sessions = new Map();
const importReports = new Map();
const MAX_UPLOAD_SIZE = 5 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".doc", ".docx"]);
const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/octet-stream"
]);

const statusLabels = {
  PendingTAAdmin: "待 TAAdmin 审批",
  RejectedByTAAdmin: "TAAdmin 拒绝",
  PendingProfessor: "待教授审批",
  RejectedByProfessor: "教授拒绝",
  Approved: "已通过",
  Withdrawn: "已撤销"
};

const adminOverrideStatuses = [
  "PendingTAAdmin",
  "PendingProfessor",
  "Approved",
  "RejectedByTAAdmin",
  "RejectedByProfessor",
  "Withdrawn"
];

function nowStr() {
  const date = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function nowMinuteStr() {
  const date = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getDb() {
  return new DatabaseSync(DB_PATH);
}

function initDb() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const db = getDb();
  db.exec(`
    create table if not exists users (
      user_id integer primary key autoincrement,
      user_name text not null,
      login_name text not null unique,
      email text not null,
      password text not null,
      role text not null,
      is_allowed_to_apply text not null default 'N',
      resume_name text,
      resume_path text
    );

    create table if not exists classes (
      class_id integer primary key autoincrement,
      class_code text not null unique,
      class_abbr text,
      class_name text not null,
      course_name text not null,
      teaching_language text not null,
      teacher_user_id text not null,
      teacher_name text not null,
      class_intro text,
      memo text,
      maximum_number_of_tas_admitted integer not null default 1,
      ta_applications_allowed text not null default 'Y',
      is_conflict_allowed text not null default 'N',
      apply_start_at text,
      apply_end_at text,
      semester text not null
    );

    create table if not exists class_schedules (
      schedule_id integer primary key autoincrement,
      class_id integer not null,
      lesson_date text not null,
      start_time text not null,
      end_time text not null,
      section text not null,
      is_exam text
    );

    create table if not exists applications (
      application_id integer primary key autoincrement,
      applier_user_id integer not null,
      applier_name text not null,
      class_id integer not null,
      class_name text not null,
      teacher_user_id text not null,
      teacher_name text not null,
      application_reason text not null,
      resume_name text not null,
      resume_path text,
      status text not null,
      submitted_at text not null,
      ta_comment text,
      ta_acted_at text,
      prof_comment text,
      prof_acted_at text
    );

    create table if not exists approval_logs (
      approval_log_id integer primary key autoincrement,
      application_id integer not null,
      approval_stage text not null,
      approver_user_id integer not null,
      approver_name text not null,
      result text not null,
      comments text,
      acted_at text not null
    );

    create table if not exists notifications (
      notification_id integer primary key autoincrement,
      user_id integer not null,
      title text not null,
      content text not null,
      target_path text,
      is_read text not null default 'N',
      created_at text not null
    );

    create table if not exists login_tokens (
      token text primary key,
      user_id integer not null,
      target_path text not null,
      expires_at text not null,
      used_at text
    );
  `);

  const applicationColumns = db.prepare("pragma table_info(applications)").all();
  if (!applicationColumns.some((column) => column.name === "resume_path")) {
    db.exec("alter table applications add column resume_path text");
  }
  const userColumns = db.prepare("pragma table_info(users)").all();
  if (!userColumns.some((column) => column.name === "resume_name")) {
    db.exec("alter table users add column resume_name text");
  }
  if (!userColumns.some((column) => column.name === "resume_path")) {
    db.exec("alter table users add column resume_path text");
  }
  const notificationColumns = db.prepare("pragma table_info(notifications)").all();
  if (!notificationColumns.some((column) => column.name === "target_path")) {
    db.exec("alter table notifications add column target_path text");
  }
  const classColumns = db.prepare("pragma table_info(classes)").all();
  if (!classColumns.some((column) => column.name === "class_abbr")) {
    db.exec("alter table classes add column class_abbr text");
  }
  if (!classColumns.some((column) => column.name === "apply_start_at")) {
    db.exec("alter table classes add column apply_start_at text");
  }
  if (!classColumns.some((column) => column.name === "apply_end_at")) {
    db.exec("alter table classes add column apply_end_at text");
  }
  if (!classColumns.some((column) => column.name === "is_conflict_allowed")) {
    db.exec("alter table classes add column is_conflict_allowed text not null default 'N'");
  }
  db.exec(`
    update classes
    set apply_start_at = coalesce(apply_start_at, '2026-03-01 00:00'),
        apply_end_at = coalesce(apply_end_at, '2026-12-31 23:59')
    where apply_start_at is null or apply_end_at is null
  `);
  db.exec(`
    update classes
    set is_conflict_allowed = coalesce(is_conflict_allowed, 'N')
    where is_conflict_allowed is null
  `);
  db.exec(`
    update classes
    set class_abbr = coalesce(nullif(class_abbr, ''), class_code)
    where class_abbr is null or class_abbr = ''
  `);

  const count = db.prepare("select count(*) as count from users").get().count;
  if (count === 0) {
    const insertUser = db.prepare(`
      insert into users (user_name, login_name, email, password, role, is_allowed_to_apply)
      values (?, ?, ?, ?, ?, ?)
    `);
    [
      ["Alice TA", "ta1", "ta1@example.com", "123456", "TA", "Y"],
      ["Bob TA", "ta2", "ta2@example.com", "123456", "TA", "N"],
      ["Cathy Admin", "taadmin1", "taadmin1@example.com", "123456", "TAAdmin", "N"],
      ["Prof Zhang", "prof1", "prof1@example.com", "123456", "Professor", "N"],
      ["Course Admin", "courseadmin1", "courseadmin1@example.com", "123456", "CourseAdmin", "N"]
    ].forEach((row) => insertUser.run(...row));

    const prof = db.prepare("select * from users where login_name = 'prof1'").get();
    const result = db.prepare(`
      insert into classes (
        class_code, class_abbr, class_name, course_name, teaching_language, teacher_user_id,
        teacher_name, class_intro, memo, maximum_number_of_tas_admitted,
        ta_applications_allowed, is_conflict_allowed, apply_start_at, apply_end_at, semester
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "FIN101-A",
      "FIN101",
      "金融学A班",
      "金融学",
      "中文",
      String(prof.user_id),
      prof.user_name,
      "金融学基础教学班",
      "周中晚课",
      2,
      "Y",
      "N",
      "2026-03-01 00:00",
      "2026-12-31 23:59",
      "2026Fall"
    );
    const insertSchedule = db.prepare(`
      insert into class_schedules (class_id, lesson_date, start_time, end_time, section, is_exam)
      values (?, ?, ?, ?, ?, ?)
    `);
    insertSchedule.run(result.lastInsertRowid, "2026-09-01", "18:30", "20:30", "晚上", null);
    insertSchedule.run(result.lastInsertRowid, "2026-09-08", "18:30", "20:30", "晚上", null);
  }
  db.close();
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf("=");
        return [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
      })
  );
}

function getCurrentUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid || !sessions.has(sid)) {
    return null;
  }
  const db = getDb();
  const user = db.prepare("select * from users where user_id = ?").get(sessions.get(sid));
  db.close();
  return user ?? null;
}

function sendHtml(res, html, headers = {}) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(html);
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: encodeURI(location), ...headers });
  res.end();
}

function consumeLoginToken(res, token) {
  const db = getDb();
  const row = db.prepare("select * from login_tokens where token = ? and used_at is null").get(token);
  if (!row) {
    db.close();
    return redirect(res, "/?notice=登录链接无效或已失效");
  }
  if (row.expires_at < nowStr()) {
    db.close();
    return redirect(res, "/?notice=登录链接已过期");
  }
  const user = db.prepare("select * from users where user_id = ?").get(row.user_id);
  if (!user) {
    db.close();
    return redirect(res, "/?notice=用户不存在");
  }
  db.prepare("update login_tokens set used_at = ? where token = ?").run(nowStr(), token);
  db.close();
  const sid = crypto.randomBytes(16).toString("hex");
  sessions.set(sid, user.user_id);
  return redirect(res, row.target_path, { "Set-Cookie": `sid=${sid}; Path=/; HttpOnly` });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(querystring.parse(body)));
  });
}

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function sanitizeFilename(filename) {
  const base = path.basename(String(filename || "").trim());
  return base.replace(/[^A-Za-z0-9._-]/g, "_");
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) {
    throw new Error("缺少 multipart boundary");
  }
  const boundary = `--${match[1] || match[2]}`;
  const text = buffer.toString("binary");
  const parts = text.split(boundary).slice(1, -1);
  const fields = {};
  const files = {};
  for (const rawPart of parts) {
    const part = rawPart.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd);
    const bodyBinary = part.slice(headerEnd + 4);
    const headers = headerText.split("\r\n");
    const disposition = headers.find((line) => /^content-disposition:/i.test(line));
    if (!disposition) continue;
    const nameMatch = /name="([^"]+)"/i.exec(disposition);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    const fileMatch = /filename="([^"]*)"/i.exec(disposition);
    const contentTypeHeader = headers.find((line) => /^content-type:/i.test(line));
    if (fileMatch) {
      files[fieldName] = {
        filename: fileMatch[1],
        contentType: contentTypeHeader ? contentTypeHeader.split(":")[1].trim() : "application/octet-stream",
        buffer: Buffer.from(bodyBinary, "binary")
      };
    } else {
      fields[fieldName] = Buffer.from(bodyBinary, "binary").toString("utf8");
    }
  }
  return { fields, files };
}

function saveUploadedFile(file) {
  const safeName = sanitizeFilename(file.filename);
  if (!safeName) {
    throw new Error("附件文件名无效");
  }
  const extension = path.extname(safeName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error("简历仅支持 pdf、doc、docx");
  }
  if (!ALLOWED_CONTENT_TYPES.has(file.contentType)) {
    throw new Error("附件类型不受支持");
  }
  if (!file.buffer || file.buffer.length === 0) {
    throw new Error("附件不能为空");
  }
  if (file.buffer.length > MAX_UPLOAD_SIZE) {
    throw new Error("附件大小不能超过 5MB");
  }
  const storedName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${safeName}`;
  const targetPath = path.join(UPLOAD_DIR, storedName);
  fs.writeFileSync(targetPath, file.buffer);
  return {
    originalName: safeName,
    storedName,
    relativePath: `/uploads/${storedName}`
  };
}

function attachmentLink(app) {
  if (!app.resume_path) {
    return escapeHtml(app.resume_name || "");
  }
  return `<a href="${escapeHtml(app.resume_path)}" target="_blank" rel="noreferrer">${escapeHtml(app.resume_name)}</a>`;
}

function normalizeDateTimeInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.replace("T", " ").slice(0, 16);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)) {
    throw new Error("开放申请时间格式错误");
  }
  return normalized;
}

function datetimeValueForInput(value) {
  return value ? String(value).replace(" ", "T").slice(0, 16) : "";
}

function validateApplyWindow(startAt, endAt) {
  if (!startAt || !endAt) {
    throw new Error("请完整填写开放申请开始和结束时间");
  }
  if (startAt >= endAt) {
    throw new Error("开放申请结束时间必须晚于开始时间");
  }
}

function isClassOpenForApply(classRow) {
  if (!classRow || classRow.ta_applications_allowed !== "Y") return false;
  if (!classRow.apply_start_at || !classRow.apply_end_at) return false;
  const now = nowMinuteStr();
  return classRow.apply_start_at <= now && now <= classRow.apply_end_at;
}

function applyWindowText(classRow) {
  if (!classRow.apply_start_at || !classRow.apply_end_at) {
    return "未设置";
  }
  return `${escapeHtml(classRow.apply_start_at)} 至 ${escapeHtml(classRow.apply_end_at)}`;
}

function isClassCapacityReached(classRow, approvedCount) {
  return Number(approvedCount || 0) >= Number(classRow?.maximum_number_of_tas_admitted || 0);
}

function syncClassApplyAvailabilityByCapacity(db, classId) {
  const classRow = db.prepare("select class_id, maximum_number_of_tas_admitted, ta_applications_allowed from classes where class_id = ?").get(classId);
  if (!classRow) return false;
  const approvedCount = db.prepare("select count(*) as count from applications where class_id = ? and status = 'Approved'").get(classId).count;
  const isFull = isClassCapacityReached(classRow, approvedCount);
  if (isFull && classRow.ta_applications_allowed !== "N") {
    db.prepare("update classes set ta_applications_allowed = 'N' where class_id = ?").run(classId);
  }
  return isFull;
}

function classOpenStatus(classRow) {
  if (classRow.ta_applications_allowed !== "Y") return "closed";
  if (!classRow.apply_start_at || !classRow.apply_end_at) return "unset";
  const now = nowMinuteStr();
  if (now < classRow.apply_start_at) return "upcoming";
  if (now > classRow.apply_end_at) return "expired";
  return "open";
}

function classOpenStatusLabel(classRow) {
  const status = classOpenStatus(classRow);
  const labels = {
    open: "开放中",
    upcoming: "未开始",
    expired: "已过期",
    closed: "已关闭",
    unset: "未设置"
  };
  return labels[status] || status;
}

function parseBatchClassRefs(value) {
  return Array.from(new Set(
    String(value || "")
      .split(/[\s,，]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

function loadClassRowsByRefs(db, refs) {
  const selectById = db.prepare("select * from classes where class_id = ?");
  const selectByCode = db.prepare("select * from classes where class_code = ?");
  const rows = [];
  const seen = new Set();
  for (const ref of refs) {
    const numericId = Number(ref);
    const row = Number.isInteger(numericId) && numericId > 0 ? selectById.get(numericId) : selectByCode.get(ref);
    if (row && !seen.has(row.class_id)) {
      rows.push(row);
      seen.add(row.class_id);
    }
  }
  return rows;
}

function classDeleteImpact(db, classId) {
  const scheduleCount = db.prepare("select count(*) as count from class_schedules where class_id = ?").get(classId).count;
  const appRows = db.prepare("select application_id from applications where class_id = ?").all(classId);
  let approvalCount = 0;
  if (appRows.length) {
    const countStmt = db.prepare("select count(*) as count from approval_logs where application_id = ?");
    for (const row of appRows) {
      approvalCount += countStmt.get(row.application_id).count;
    }
  }
  return {
    scheduleCount,
    applicationCount: appRows.length,
    approvalCount
  };
}

function createNotification(db, userId, title, content, targetPath = null) {
  db.prepare(`
    insert into notifications (user_id, title, content, target_path, is_read, created_at)
    values (?, ?, ?, ?, 'N', ?)
  `).run(userId, title, content, targetPath, nowStr());
}

function unreadNotificationCount(userId) {
  const db = getDb();
  const count = db.prepare("select count(*) as count from notifications where user_id = ? and is_read = 'N'").get(userId).count;
  db.close();
  return count;
}

function saveImportReport(report) {
  const reportId = crypto.randomBytes(10).toString("hex");
  importReports.set(reportId, { ...report, createdAt: nowStr() });
  if (importReports.size > 20) {
    const oldestKey = importReports.keys().next().value;
    importReports.delete(oldestKey);
  }
  return reportId;
}

function addHours(date, hours) {
  const next = new Date(date);
  next.setHours(next.getHours() + hours);
  return next;
}

function formatDateTime(date) {
  const pad = (v) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function createLoginToken(db, userId, targetPath) {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = formatDateTime(addHours(new Date(), 72));
  db.prepare(`
    insert into login_tokens (token, user_id, target_path, expires_at, used_at)
    values (?, ?, ?, ?, null)
  `).run(token, userId, targetPath, expiresAt);
  return token;
}

function buildProfessorEmailDraft(professor, selectedClasses, accessLink) {
  const greeting = `${professor.user_name}教授您好`;
  const classLines = selectedClasses.map((row) => `- ${row.course_name} / ${row.class_name}（${row.class_code}）`).join("\n");
  const body = `${greeting}，\n\n你任教的以下教学班已完成TA申请的前置审核，请点击以下链接进入系统进行最终审核：\n${accessLink}\n\n${classLines}\n\n请勿将本邮件及其中链接转发给其他人员，以免造成学生申请信息、审核信息等敏感数据泄露。如邮件误收或不再负责相关审核工作，请及时删除并通知系统管理员。\n`;
  return {
    to: professor.email,
    subject: "TA申请前置审核已完成",
    body
  };
}

function pageLayout(title, body, user, notice) {
  let nav = "";
  if (user) {
    const links = ['<a href="/">首页</a>', '<a href="/logout">退出</a>'];
    const unreadCount = unreadNotificationCount(user.user_id);
    links.splice(1, 0, `<a href="/notifications">通知${unreadCount ? `(${unreadCount})` : ""}</a>`);
    if (user.role === "TA") {
      links.splice(1, 0, '<a href="/ta/classes">可申请教学班</a>', '<a href="/ta/applications">我的申请</a>', '<a href="/ta/profile">个人资料</a>');
    } else if (user.role === "TAAdmin") {
      links.splice(1, 0, '<a href="/admin/ta/pending">待初审申请</a>', '<a href="/admin/ta/applications">全部申请</a>', '<a href="/admin/ta/classes">全部教学班</a>', '<a href="/admin/ta/users">TA 管理</a>');
    } else if (user.role === "Professor") {
      links.splice(1, 0, '<a href="/professor/pending">待教授审批</a>');
    } else if (user.role === "CourseAdmin") {
      links.splice(1, 0, '<a href="/course/applications">全部申请</a>', '<a href="/course/classes">教学班管理</a>', '<a href="/course/users">人员管理</a>');
    }
    nav = `<nav class="nav-links">${links.join("")}</nav>`;
  }
  const noticeBlock = notice ? `<div class="notice">${escapeHtml(notice)}</div>` : "";
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        --bg: #f6f8fc;
        --panel: #ffffff;
        --panel-soft: #f8fafd;
        --ink: #202124;
        --muted: #5f6368;
        --line: #dfe3eb;
        --accent: #1a73e8;
        --accent-soft: #e8f0fe;
        --ok: #137333;
        --bad: #c5221f;
        --shadow: 0 1px 2px rgba(60, 64, 67, 0.1), 0 2px 6px rgba(60, 64, 67, 0.15);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Google Sans", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
        background:
          radial-gradient(circle at top left, rgba(26, 115, 232, 0.08), transparent 24%),
          radial-gradient(circle at top right, rgba(52, 168, 83, 0.08), transparent 20%),
          linear-gradient(180deg, #f8fbff, var(--bg));
        color: var(--ink);
      }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      header {
        position: sticky;
        top: 0;
        z-index: 10;
        backdrop-filter: blur(16px);
        background: rgba(246, 248, 252, 0.9);
        border-bottom: 1px solid rgba(223, 227, 235, 0.9);
      }
      .topbar {
        max-width: 1360px;
        margin: 0 auto;
        padding: 18px 32px 14px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 20px;
      }
      .brand h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
      .brand p { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
      .nav-links {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 10px;
      }
      .nav-links a {
        padding: 10px 14px;
        border-radius: 999px;
        color: #174ea6;
        background: transparent;
        font-weight: 500;
      }
      .nav-links a:hover {
        background: var(--accent-soft);
        text-decoration: none;
      }
      main {
        max-width: 1360px;
        margin: 0 auto;
        padding: 28px 32px 56px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 24px;
        margin-bottom: 20px;
        box-shadow: var(--shadow);
      }
      h1, h2, h3 { margin: 0 0 14px; }
      h2 { font-size: 22px; letter-spacing: -0.01em; }
      h3 { font-size: 18px; letter-spacing: -0.01em; }
      table { width: 100%; border-collapse: collapse; background: var(--panel); }
      th, td {
        border-bottom: 1px solid var(--line);
        padding: 12px 10px;
        vertical-align: top;
        text-align: left;
      }
      th {
        color: var(--muted);
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: #fafbff;
      }
      tr:hover td { background: #fafcff; }
      tr.row-soft-purple td { background: #f3ecff; }
      tr.row-soft-purple:hover td { background: #ede1ff; }
      .table-wrap { overflow-x: auto; }
      table.wide { min-width: 1320px; }
      .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
      .notice {
        max-width: 1360px;
        margin: 20px auto 0;
        padding: 14px 16px;
        border-radius: 16px;
        background: #e8f0fe;
        border: 1px solid #d2e3fc;
        color: #174ea6;
        box-shadow: var(--shadow);
      }
      .muted { color: var(--muted); }
      .field-order {
        margin: 12px 0 0;
        padding: 12px 14px;
        border-radius: 14px;
        background: #f8fbff;
        border: 1px solid var(--line);
        color: var(--muted);
        font-size: 13px;
        line-height: 1.7;
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .pill {
        display: inline-block;
        padding: 6px 12px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: #174ea6;
        font-size: 13px;
        font-weight: 600;
      }
      .schedule-summary {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 200px;
        max-width: 260px;
      }
      .schedule-preview {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .schedule-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .schedule-item {
        padding: 8px 10px;
        border-radius: 12px;
        background: #f8fbff;
        border: 1px solid #e3ebf8;
        line-height: 1.5;
      }
      .schedule-meta {
        font-size: 12px;
        color: var(--muted);
      }
      .schedule-dialog {
        border: 0;
        border-radius: 24px;
        padding: 0;
        width: min(720px, calc(100vw - 32px));
        box-shadow: 0 20px 60px rgba(32, 33, 36, 0.24);
      }
      .schedule-dialog::backdrop {
        background: rgba(32, 33, 36, 0.45);
        backdrop-filter: blur(2px);
      }
      .schedule-dialog-body {
        padding: 22px;
      }
      .ok { color: var(--ok); }
      .bad { color: var(--bad); }
      form.inline { display: inline; }
      label { display: block; color: var(--muted); font-size: 14px; font-weight: 500; }
      input, select, textarea {
        width: 100%;
        margin-top: 8px;
        padding: 12px 14px;
        border: 1px solid #c7cdd4;
        border-radius: 14px;
        background: #fff;
        color: var(--ink);
        transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
      }
      input:focus, select:focus, textarea:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 4px rgba(26, 115, 232, 0.12);
      }
      input[type="checkbox"] {
        width: 18px;
        height: 18px;
        margin-top: 0;
        accent-color: var(--accent);
      }
      textarea { min-height: 100px; }
      button, .button-link {
        border: 0;
        border-radius: 999px;
        background: var(--accent);
        color: white;
        padding: 11px 18px;
        cursor: pointer;
        text-decoration: none;
        display: inline-block;
        font-weight: 600;
        letter-spacing: 0.01em;
        box-shadow: 0 1px 2px rgba(26, 115, 232, 0.3);
      }
      button:hover, .button-link:hover {
        text-decoration: none;
        filter: brightness(0.98);
      }
      button.secondary {
        background: #eef3fd;
        color: #174ea6;
        box-shadow: none;
      }
      .button-link.danger,
      button.danger {
        background: #fce8e6;
        color: #c5221f;
        box-shadow: none;
      }
      .button-link.rect,
      button.rect {
        border-radius: 12px;
      }
      .actions a,
      .actions button {
        white-space: nowrap;
      }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .split { display: grid; grid-template-columns: 2fr 1fr; gap: 18px; }
      .hero {
        display: grid;
        grid-template-columns: minmax(280px, 1.1fr) minmax(320px, 420px);
        gap: 24px;
        align-items: stretch;
      }
      .hero-panel {
        min-height: 420px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        background: linear-gradient(135deg, #e8f0fe, #f8fbff 58%, #e6f4ea);
      }
      .hero-panel h2 {
        font-size: 34px;
        line-height: 1.15;
        margin-bottom: 16px;
      }
      .hero-panel p {
        margin: 0 0 12px;
        color: #475467;
        line-height: 1.7;
      }
      .login-card {
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-height: 420px;
      }
      @media (max-width: 900px) {
        .topbar { padding-left: 18px; padding-right: 18px; align-items: flex-start; flex-direction: column; }
        main { padding-left: 18px; padding-right: 18px; }
        .split, .hero { grid-template-columns: 1fr; }
        .hero-panel, .login-card { min-height: auto; }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="topbar">
        <div class="brand">
          <h1>TA 选课系统</h1>
          <p>${user ? `当前角色：${escapeHtml(user.role)} · ${escapeHtml(user.user_name)}` : "Teaching Assistant Course Assignment Platform"}</p>
        </div>
        ${nav}
      </div>
    </header>
    ${noticeBlock}
    <main>${body}</main>
    <script>
      document.addEventListener('click', (event) => {
        const openButton = event.target.closest('[data-open-schedule]');
        if (openButton) {
          const dialog = document.getElementById(openButton.getAttribute('data-open-schedule'));
          if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
        }
        const closeButton = event.target.closest('[data-close-schedule]');
        if (closeButton) {
          const dialog = document.getElementById(closeButton.getAttribute('data-close-schedule'));
          if (dialog) dialog.close();
        }
      });
      document.addEventListener('click', (event) => {
        if (event.target instanceof HTMLDialogElement) {
          event.target.close();
        }
      });
    </script>
  </body>
  </html>`;
}

function loginPage(res, notice) {
  const body = `
    <div class="hero">
      <section class="card hero-panel">
        <h2>TA选课申请系统</h2>
        <p>系统覆盖 TA 申请、TAAdmin 初审、Professor 终审、教学班开放时间控制，以及课程与人员管理。</p>
        <p>当前版本已支持多条排课记录、附件上传、站内通知、批量设置和批量删除等核心流程。</p>
      </section>
      <section class="card login-card">
        <h2>登录</h2>
        <p class="muted">请输入账号和密码进入系统。</p>
        <form method="post" action="/login">
          <p><label>账号<input name="login_name" autocomplete="username" required /></label></p>
          <p><label>密码<input name="password" type="password" autocomplete="current-password" required /></label></p>
          <div class="actions">
            <button type="submit">登录</button>
          </div>
        </form>
      </section>
    </div>`;
  sendHtml(res, pageLayout("登录", body, null, notice));
}

function fetchSchedules(db, classId) {
  return db.prepare("select * from class_schedules where class_id = ? order by lesson_date, start_time").all(classId);
}

function schedulesTable(schedules) {
  if (!schedules.length) {
    return "<p class='muted'>暂无排课。</p>";
  }
  const rows = schedules.map((row) => `<tr><td>${escapeHtml(row.lesson_date)}</td><td>${escapeHtml(row.start_time)}</td><td>${escapeHtml(row.end_time)}</td><td>${escapeHtml(row.section)}</td><td>${escapeHtml(row.is_exam || "")}</td></tr>`).join("");
  return `<table><tr><th>日期</th><th>开始</th><th>结束</th><th>节次</th><th>考试</th></tr>${rows}</table>`;
}

function hasTimeConflict(aStart, aEnd, bStart, bEnd) {
  return !(aEnd <= bStart || bEnd <= aStart);
}

function getAppliedConflicts(db, taUserId, classId) {
  const target = fetchSchedules(db, classId);
  const apps = db.prepare(`
    select a.*, c.is_conflict_allowed
    from applications a
    left join classes c on c.class_id = a.class_id
    where a.applier_user_id = ?
      and a.status not in ('RejectedByTAAdmin', 'RejectedByProfessor', 'Withdrawn')
      and a.class_id != ?
  `).all(taUserId, classId);
  return apps.flatMap((app) => {
    const existing = fetchSchedules(db, app.class_id);
    const matches = [];
    for (const t of target) {
      for (const e of existing) {
        if (t.lesson_date === e.lesson_date && hasTimeConflict(t.start_time, t.end_time, e.start_time, e.end_time)) {
          matches.push(`${t.lesson_date} ${t.start_time}-${t.end_time} vs ${e.start_time}-${e.end_time}`);
        }
      }
    }
    return matches.length ? [{ app, matches }] : [];
  });
}

function getOpenClassConflicts(db, taUserId, classId) {
  const target = fetchSchedules(db, classId);
  const classes = db.prepare(`
    select c.*
    from classes c
    where c.ta_applications_allowed = 'Y'
      and c.class_id != ?
    order by c.semester, c.course_name, c.class_name
  `).all(classId).filter((row) => isClassOpenForApply(row));
  const applications = db.prepare(`
    select *
    from applications
    where applier_user_id = ?
    order by submitted_at desc, application_id desc
  `).all(taUserId);
  return classes.flatMap((classRow) => {
    const existing = fetchSchedules(db, classRow.class_id);
    const matches = [];
    for (const t of target) {
      for (const e of existing) {
        if (t.lesson_date === e.lesson_date && hasTimeConflict(t.start_time, t.end_time, e.start_time, e.end_time)) {
          matches.push(`${t.lesson_date} ${t.start_time}-${t.end_time} vs ${e.start_time}-${e.end_time}`);
        }
      }
    }
    if (!matches.length) {
      return [];
    }
    const relatedApplication = applications.find((app) => app.class_id === classRow.class_id) || null;
    return [{
      classRow,
      relatedApplication,
      matches
    }];
  });
}

function requireRole(res, user, roles) {
  if (!user) {
    redirect(res, "/?notice=请先登录");
    return false;
  }
  if (!roles.includes(user.role)) {
    sendHtml(res, pageLayout("无权限", '<section class="card">无权限访问该页面。</section>', user));
    return false;
  }
  return true;
}

function homePage(res, user, notice) {
  if (!user) {
    return loginPage(res, notice);
  }
  let body = `
    <section class="card">
      <h2>当前用户</h2>
      <p><span class="pill">${escapeHtml(user.role)}</span> ${escapeHtml(user.user_name)}</p>
      <p class="muted">当前实现的是 Node + SQLite 的服务端渲染 MVP。</p>
    </section>
  `;
  if (user.role === "TA") {
    body += `<section class="grid">
      <article class="card"><h3>可申请教学班</h3><p>浏览开放课程并提交申请。</p><a href="/ta/classes">进入</a></article>
      <article class="card"><h3>我的申请</h3><p>查看状态并在初审前撤销。</p><a href="/ta/applications">进入</a></article>
      <article class="card"><h3>个人资料</h3><p>维护个人简历，申请时自动带出。</p><a href="/ta/profile">进入</a></article>
    </section>`;
  } else if (user.role === "TAAdmin") {
    body += `<section class="grid">
      <article class="card"><h3>待初审申请</h3><p>处理 TA 初审。</p><a href="/admin/ta/pending">进入</a></article>
      <article class="card"><h3>全部申请</h3><p>查看所有 TA 申请状态。</p><a href="/admin/ta/applications">进入</a></article>
      <article class="card"><h3>全部教学班</h3><p>查看所有教学班和排课安排。</p><a href="/admin/ta/classes">进入</a></article>
      <article class="card"><h3>TA 管理</h3><p>维护申请资格。</p><a href="/admin/ta/users">进入</a></article>
    </section>`;
  } else if (user.role === "Professor") {
    body += `<section class="card"><h3>待教授审批</h3><p>处理终审。</p><a href="/professor/pending">进入</a></section>`;
  } else if (user.role === "CourseAdmin") {
    body += `<section class="grid">
      <article class="card"><h3>全部申请</h3><p>查看所有 TA 申请状态。</p><a href="/course/applications">进入</a></article>
      <article class="card"><h3>教学班管理</h3><p>维护教学班与排课。</p><a href="/course/classes">进入</a></article>
      <article class="card"><h3>人员管理</h3><p>新增、编辑和删除系统人员。</p><a href="/course/users">进入</a></article>
    </section>`;
  }
  sendHtml(res, pageLayout("首页", body, user, notice));
}

function roleOptions(selectedRole) {
  return ["TA", "TAAdmin", "Professor", "CourseAdmin"]
    .map((role) => `<option value="${role}" ${selectedRole === role ? "selected" : ""}>${role}</option>`)
    .join("");
}

function taAllowedOptions(selectedValue) {
  return ["Y", "N"]
    .map((value) => `<option value="${value}" ${selectedValue === value ? "selected" : ""}>${value}</option>`)
    .join("");
}

function adminOverrideStatusOptions(selectedStatus) {
  return adminOverrideStatuses
    .map((status) => `<option value="${status}" ${selectedStatus === status ? "selected" : ""}>${escapeHtml(statusLabels[status] || status)}</option>`)
    .join("");
}

function normalizeExamValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (["期中考试", "MidTermExam", "Mid-term Exam"].includes(raw)) return "期中考试";
  if (["期末考试", "FinalExam", "Final Exam"].includes(raw)) return "期末考试";
  throw new Error("考试类型仅支持空、期中考试、期末考试");
}

function parseDelimitedValues(value) {
  return Array.from(new Set(
    toArray(value)
      .flatMap((item) => String(item || "").split(/[,\n;]+/))
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

function normalizeTeacherUserIds(value) {
  return parseDelimitedValues(value)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function parseScheduleLines(scheduleText) {
  const lines = String(scheduleText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    throw new Error("请至少填写一条排课记录");
  }
  return lines.map((line, index) => {
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length < 4 || parts.length > 5) {
      throw new Error(`第 ${index + 1} 条排课格式错误，应为 日期,开始时间,结束时间,节次[,考试类型]`);
    }
    const [lessonDate, startTime, endTime, section, examValue] = parts;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lessonDate)) {
      throw new Error(`第 ${index + 1} 条排课日期格式错误`);
    }
    if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
      throw new Error(`第 ${index + 1} 条排课时间格式错误`);
    }
    if (endTime <= startTime) {
      throw new Error(`第 ${index + 1} 条排课结束时间必须晚于开始时间`);
    }
    if (!["上午", "下午", "晚上"].includes(section)) {
      throw new Error(`第 ${index + 1} 条排课节次仅支持 上午/下午/晚上`);
    }
    return {
      lessonDate,
      startTime,
      endTime,
      section,
      isExam: normalizeExamValue(examValue)
    };
  });
}

function parseImportedClassesRows(rows) {
  if (!rows.length) {
    throw new Error("导入文件没有数据");
  }
  const requiredHeaders = [
    "class_code",
    "class_abbr",
    "course_name",
    "class_name",
    "teaching_language",
    "teacher_login_name",
    "semester",
    "maximum_number",
    "ta_allowed",
    "is_conflict_allowed",
    "apply_start_at",
    "apply_end_at",
    "lesson_date",
    "start_time",
    "end_time",
    "section",
    "is_exam",
    "class_intro",
    "memo"
  ];
  const firstRow = rows[0];
  for (const header of requiredHeaders) {
    if (!(header in firstRow)) {
      throw new Error(`导入模板缺少字段：${header}`);
    }
  }
  const grouped = new Map();
  const errors = [];
  for (let i = 0; i < rows.length; i += 1) {
    const rowNo = i + 2;
    const row = rows[i];
    const get = (name) => String(row[name] || "").trim();
    const classCode = get("class_code");
    let hasRowError = false;
    if (!classCode) {
      errors.push(`第 ${rowNo} 行失败：缺少 class_code`);
      hasRowError = true;
    }
    const lessonDate = get("lesson_date");
    const startTime = get("start_time");
    const endTime = get("end_time");
    const section = get("section");
    const isExam = get("is_exam");
    let parsedSchedule;
    try {
      const scheduleLine = [lessonDate, startTime, endTime, section, isExam].filter((value, index) => index < 4 || value).join(",");
      parsedSchedule = parseScheduleLines(scheduleLine)[0];
    } catch (error) {
      errors.push(`第 ${rowNo} 行失败：${error.message}`);
      hasRowError = true;
    }
    const maximumNumber = Number(get("maximum_number"));
    if (!Number.isInteger(maximumNumber) || maximumNumber <= 0) {
      errors.push(`第 ${rowNo} 行失败：maximum_number 必须是大于 0 的整数`);
      hasRowError = true;
    }
    const taAllowed = get("ta_allowed") || "Y";
    if (!["Y", "N"].includes(taAllowed)) {
      errors.push(`第 ${rowNo} 行失败：ta_allowed 仅支持 Y 或 N`);
      hasRowError = true;
    }
    const isConflictAllowed = get("is_conflict_allowed") || "N";
    if (!["Y", "N"].includes(isConflictAllowed)) {
      errors.push(`第 ${rowNo} 行失败：is_conflict_allowed 仅支持 Y 或 N`);
      hasRowError = true;
    }
    let applyStartAt;
    let applyEndAt;
    try {
      applyStartAt = normalizeDateTimeInput(get("apply_start_at"));
      applyEndAt = normalizeDateTimeInput(get("apply_end_at"));
      validateApplyWindow(applyStartAt, applyEndAt);
    } catch (error) {
      errors.push(`第 ${rowNo} 行失败：${error.message}`);
      hasRowError = true;
    }
    const base = {
      rowNo,
      classCode,
      classAbbr: get("class_abbr") || classCode,
      courseName: get("course_name"),
      className: get("class_name"),
      teachingLanguage: get("teaching_language") || "中文",
      teacherLoginNames: parseDelimitedValues(get("teacher_login_name")),
      semester: get("semester"),
      maximumNumber,
      taAllowed,
      isConflictAllowed,
      applyStartAt,
      applyEndAt,
      classIntro: get("class_intro"),
      memo: get("memo")
    };
    if (!base.courseName || !base.className || !base.teacherLoginNames.length || !base.semester) {
      errors.push(`第 ${rowNo} 行失败：存在必填字段为空`);
      hasRowError = true;
    }
    if (hasRowError) {
      continue;
    }
    if (!grouped.has(classCode)) {
      grouped.set(classCode, { ...base, schedules: [] });
    } else {
      const current = grouped.get(classCode);
      const comparableKeys = ["classAbbr", "courseName", "className", "teachingLanguage", "semester", "maximumNumber", "taAllowed", "isConflictAllowed", "applyStartAt", "applyEndAt", "classIntro", "memo"];
      for (const key of comparableKeys) {
        if (String(current[key] ?? "") !== String(base[key] ?? "")) {
          errors.push(`第 ${rowNo} 行失败：class_code ${classCode} 的基础信息不一致`);
          hasRowError = true;
          break;
        }
      }
      if (!hasRowError && current.teacherLoginNames.join(",") !== base.teacherLoginNames.join(",")) {
        errors.push(`第 ${rowNo} 行失败：class_code ${classCode} 的 teacher_login_name 不一致`);
        hasRowError = true;
      }
    }
    if (hasRowError) {
      continue;
    }
    grouped.get(classCode).schedules.push(parsedSchedule);
  }
  if (errors.length) {
    const error = new Error(errors.join("\n"));
    error.importErrors = errors;
    throw error;
  }
  return Array.from(grouped.values());
}

function parseImportedClassesWorkbook(file) {
  const workbook = XLSX.read(file.buffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("导入文件为空");
  }
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], { defval: "" });
  return parseImportedClassesRows(rows);
}

function parseImportedUsersWorkbook(file) {
  const extension = path.extname(String(file.filename || "")).toLowerCase();
  const workbook = XLSX.read(file.buffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("导入文件为空");
  }
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], { defval: "" });
  if (!rows.length) {
    throw new Error("导入文件没有数据");
  }
  const allowedRoles = new Set(["TA", "TAAdmin", "Professor", "CourseAdmin"]);
  const importedUsers = [];
  const seenLoginNames = new Map();
  const errors = [];
  for (let index = 0; index < rows.length; index += 1) {
    const rowNo = index + 2;
    const row = rows[index];
    const loginName = String(row.login_name || "").trim();
    const userName = String(row.user_name || "").trim();
    const email = String(row.email || "").trim();
    const password = String(row.password || "").trim() || "123456";
    const role = String(row.role || "").trim();
    const isAllowedToApply = String(row.is_allowed_to_apply || "").trim() || "N";
    let hasRowError = false;
    if (!loginName || !userName || !email || !role) {
      errors.push(`第 ${rowNo} 行失败：存在必填字段为空`);
      hasRowError = true;
    }
    if (loginName && seenLoginNames.has(loginName)) {
      errors.push(`第 ${rowNo} 行失败：login_name ${loginName} 与第 ${seenLoginNames.get(loginName)} 行重复`);
      hasRowError = true;
    } else if (loginName) {
      seenLoginNames.set(loginName, rowNo);
    }
    if (!allowedRoles.has(role)) {
      errors.push(`第 ${rowNo} 行失败：role 不合法，仅支持 TA/TAAdmin/Professor/CourseAdmin`);
      hasRowError = true;
    }
    if (!["Y", "N"].includes(isAllowedToApply)) {
      errors.push(`第 ${rowNo} 行失败：is_allowed_to_apply 仅支持 Y 或 N`);
      hasRowError = true;
    }
    if (hasRowError) {
      continue;
    }
    importedUsers.push({
      rowNo,
      loginName,
      userName,
      email,
      password,
      role,
      isAllowedToApply: role === "TA" ? isAllowedToApply : "N",
      sourceType: extension
    });
  }
  if (errors.length) {
    const error = new Error(errors.join("\n"));
    error.importErrors = errors;
    throw error;
  }
  return importedUsers;
}

function upsertImportedUsers(db, importedUsers) {
  const findUser = db.prepare("select * from users where login_name = ?");
  const insertUser = db.prepare(`
    insert into users (user_name, login_name, email, password, role, is_allowed_to_apply)
    values (?, ?, ?, ?, ?, ?)
  `);
  const updateUser = db.prepare(`
    update users
    set user_name = ?, email = ?, password = ?, role = ?, is_allowed_to_apply = ?
    where user_id = ?
  `);
  const classCountByTeacher = db.prepare("select count(*) as count from classes where (',' || teacher_user_id || ',') like '%,' || ? || ',%'");
  const errors = [];
  for (const item of importedUsers) {
    const existing = findUser.get(item.loginName);
    if (!existing) continue;
    const teachesClasses = classCountByTeacher.get(existing.user_id).count;
    if (teachesClasses > 0 && item.role !== "Professor") {
      errors.push(`第 ${item.rowNo} 行失败：登录名 ${item.loginName} 已关联教学班，不能覆盖为非 Professor`);
    }
  }
  if (errors.length) {
    const error = new Error(errors.join("\n"));
    error.importErrors = errors;
    throw error;
  }
  let createdCount = 0;
  let updatedCount = 0;
  const details = [];
  for (const item of importedUsers) {
    const existing = findUser.get(item.loginName);
    if (!existing) {
      insertUser.run(item.userName, item.loginName, item.email, item.password, item.role, item.isAllowedToApply);
      createdCount += 1;
      details.push({
        action: "新增",
        loginName: item.loginName,
        userName: item.userName,
        role: item.role,
        email: item.email
      });
      continue;
    }
    updateUser.run(item.userName, item.email, item.password, item.role, item.isAllowedToApply, existing.user_id);
    if (item.role === "Professor") {
      const classes = db.prepare("select class_id, teacher_user_id from classes where (',' || teacher_user_id || ',') like '%,' || ? || ',%'").all(existing.user_id);
      const findProfessorById = db.prepare("select user_id, user_name from users where user_id = ? and role = 'Professor'");
      for (const row of classes) {
        const names = normalizeTeacherUserIds(row.teacher_user_id).map((id) => findProfessorById.get(id)?.user_name).filter(Boolean).join(" / ");
        db.prepare("update classes set teacher_name = ? where class_id = ?").run(names, row.class_id);
      }
    }
    updatedCount += 1;
    details.push({
      action: "更新",
      loginName: item.loginName,
      userName: item.userName,
      role: item.role,
      email: item.email
    });
  }
  return { createdCount, updatedCount, details };
}

function upsertImportedClasses(db, importedClasses) {
  const findProfessor = db.prepare("select * from users where login_name = ? and role = 'Professor'");
  const findClass = db.prepare("select * from classes where class_code = ?");
  const insertClass = db.prepare(`
    insert into classes (
      class_code, class_abbr, class_name, course_name, teaching_language, teacher_user_id,
      teacher_name, class_intro, memo, maximum_number_of_tas_admitted,
      ta_applications_allowed, is_conflict_allowed, apply_start_at, apply_end_at, semester
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateClass = db.prepare(`
    update classes
    set class_abbr = ?, class_name = ?, course_name = ?, teaching_language = ?, teacher_user_id = ?,
        teacher_name = ?, class_intro = ?, memo = ?, maximum_number_of_tas_admitted = ?,
        ta_applications_allowed = ?, is_conflict_allowed = ?, apply_start_at = ?, apply_end_at = ?, semester = ?
    where class_id = ?
  `);
  const deleteSchedules = db.prepare("delete from class_schedules where class_id = ?");
  const insertSchedule = db.prepare(`
    insert into class_schedules (class_id, lesson_date, start_time, end_time, section, is_exam)
    values (?, ?, ?, ?, ?, ?)
  `);
  const updateApplications = db.prepare(`
    update applications
    set teacher_user_id = ?, teacher_name = ?, class_name = ?
    where class_id = ?
  `);
  const errors = [];
  for (const item of importedClasses) {
    const missing = item.teacherLoginNames.filter((loginName) => !findProfessor.get(loginName));
    if (missing.length) {
      errors.push(`第 ${item.rowNo} 行失败：Professor 不存在：${missing.join(",")}`);
    }
  }
  if (errors.length) {
    const error = new Error(errors.join("\n"));
    error.importErrors = errors;
    throw error;
  }
  let createdCount = 0;
  let updatedCount = 0;
  const details = [];
  for (const item of importedClasses) {
    const professors = item.teacherLoginNames.map((loginName) => findProfessor.get(loginName)).filter(Boolean);
    const teacherUserIds = professors.map((row) => row.user_id).join(",");
    const teacherNames = professors.map((row) => row.user_name).join(" / ");
    const existing = findClass.get(item.classCode);
    let classId;
    if (existing) {
      classId = existing.class_id;
      updateClass.run(
        item.classAbbr,
        item.className,
        item.courseName,
        item.teachingLanguage,
        teacherUserIds,
        teacherNames,
        item.classIntro,
        item.memo,
        item.maximumNumber,
        item.taAllowed,
        item.isConflictAllowed,
        item.applyStartAt,
        item.applyEndAt,
        item.semester,
        classId
      );
      updateApplications.run(teacherUserIds, teacherNames, item.className, classId);
      updatedCount += 1;
      details.push({
        action: "更新",
        classCode: item.classCode,
        courseName: item.courseName,
        className: item.className,
        teacherName: teacherNames,
        scheduleCount: item.schedules.length
      });
    } else {
      const result = insertClass.run(
        item.classCode,
        item.classAbbr,
        item.className,
        item.courseName,
        item.teachingLanguage,
        teacherUserIds,
        teacherNames,
        item.classIntro,
        item.memo,
        item.maximumNumber,
        item.taAllowed,
        item.isConflictAllowed,
        item.applyStartAt,
        item.applyEndAt,
        item.semester
      );
      classId = result.lastInsertRowid;
      createdCount += 1;
      details.push({
        action: "新增",
        classCode: item.classCode,
        courseName: item.courseName,
        className: item.className,
        teacherName: teacherNames,
        scheduleCount: item.schedules.length
      });
    }
    deleteSchedules.run(classId);
    for (const schedule of item.schedules) {
      insertSchedule.run(classId, schedule.lessonDate, schedule.startTime, schedule.endTime, schedule.section, schedule.isExam);
    }
  }
  return { createdCount, updatedCount, details };
}

function scheduleSummary(rows, key) {
  if (!rows.length) {
    return "<span class='muted'>暂无排课</span>";
  }
  const renderItem = (row) => `
    <div class="schedule-item">
      <div>${escapeHtml(row.lesson_date)} ${escapeHtml(row.start_time)}-${escapeHtml(row.end_time)}</div>
      <div class="schedule-meta">${escapeHtml(row.section)}${row.is_exam ? ` · ${escapeHtml(row.is_exam)}` : ""}</div>
    </div>
  `;
  const previewText = escapeHtml(`${rows[0].lesson_date} ${rows[0].start_time}-${rows[0].end_time}`);
  const extraCount = rows.length - 1;
  const fullItems = rows.map(renderItem).join("");
  const dialogId = `schedule-dialog-${escapeHtml(String(key || crypto.randomBytes(4).toString("hex")))}`;
  return `
    <div class="schedule-summary">
      <div class="schedule-preview">
        <div class="schedule-item">
          <div>${previewText}</div>
          <div class="schedule-meta">${extraCount > 0 ? `另有 ${extraCount} 条排课` : `${escapeHtml(rows[0].section)}${rows[0].is_exam ? ` · ${escapeHtml(rows[0].is_exam)}` : ""}`}</div>
        </div>
      </div>
      <div class="actions">
        <button class="secondary rect" type="button" data-open-schedule="${dialogId}">查看排课</button>
      </div>
      <dialog class="schedule-dialog" id="${dialogId}">
        <div class="schedule-dialog-body">
          <div class="actions" style="justify-content:space-between; align-items:center; margin-bottom:12px;">
            <h3 style="margin:0;">全部排课安排</h3>
            <button class="secondary rect" type="button" data-close-schedule="${dialogId}">关闭</button>
          </div>
          <div class="schedule-list">${fullItems}</div>
        </div>
      </dialog>
    </div>
  `;
}

function scheduleLinesValue(rows) {
  return rows
    .map((row) => [row.lesson_date, row.start_time, row.end_time, row.section, row.is_exam || ""].filter((value, index) => index < 4 || value).join(","))
    .join("\n");
}

function taClassesPage(res, user, notice) {
  const db = getDb();
  const classes = db.prepare(`
    select c.*,
      (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count
    from classes c
    where c.ta_applications_allowed = 'Y'
    order by c.semester, c.course_name, c.class_name
  `).all();
  const visibleClasses = classes.filter((row) => isClassOpenForApply(row));
  const body = visibleClasses.map((row) => {
    const conflicts = getAppliedConflicts(db, user.user_id, row.class_id);
    const label = conflicts.length ? "<span class='pill bad'>有冲突</span>" : "<span class='pill ok'>可申请</span>";
    return `<article class="card">
      <h3>${escapeHtml(row.course_name)} / ${escapeHtml(row.class_name)}</h3>
      <p>${label} 教授：${escapeHtml(row.teacher_name)} | 学期：${escapeHtml(row.semester)}</p>
      <p class="muted">授课语言：${escapeHtml(row.teaching_language)} | 已通过：${row.approved_count} / ${row.maximum_number_of_tas_admitted}</p>
      <p class="muted">开放申请时间：${applyWindowText(row)}</p>
      <div class="actions">
        <a href="/ta/classes/${row.class_id}">查看详情</a>
        <a href="/ta/classes/${row.class_id}?show_conflicts=1">查看冲突</a>
      </div>
    </article>`;
  }).join("");
  db.close();
  sendHtml(res, pageLayout("可申请教学班", body || '<section class="card">当前没有在开放申请时间内的教学班。</section>', user, notice));
}

function taClassDetailPage(res, user, classId, notice, showConflicts) {
  const db = getDb();
  const row = db.prepare("select * from classes where class_id = ?").get(classId);
  if (!row || !isClassOpenForApply(row)) {
    db.close();
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageLayout("未找到", '<section class="card">教学班不存在，或当前不在开放申请时间内。</section>', user, notice));
    return;
  }
  const schedules = fetchSchedules(db, classId);
  const appliedConflicts = getAppliedConflicts(db, user.user_id, classId);
  const conflicts = getOpenClassConflicts(db, user.user_id, classId);
  const hasBlockingConflicts = appliedConflicts.length > 0 && row.is_conflict_allowed !== "Y";
  const canSubmit = Boolean(user.resume_path) && !hasBlockingConflicts;
  const resumeSection = user.resume_path
    ? `<p>个人简历：${attachmentLink(user)}</p><p class="muted">提交申请时将自动带出当前个人简历。</p>`
    : `<p class="bad">你还没有上传个人简历，请先到 <a href="/ta/profile">个人资料</a> 上传后再申请。</p>`;
  const submitGuardSection = hasBlockingConflicts
    ? `<div class="notice" style="margin: 0 0 16px; background: #fce8e6; border-color: #f7c8c3; color: #a50e0e;">
        检测到你已申请的教学班与当前教学班存在时间冲突，且本教学班未设置为允许冲突申请，因此当前不能提交申请。
      </div>
      <table><tr><th>已申请冲突教学班</th><th>当前状态</th><th>是否允许冲突申请</th><th>冲突时间</th></tr>${
        appliedConflicts.map(({ app, matches }) => `<tr><td>${escapeHtml(app.class_name)}</td><td>${escapeHtml(statusLabels[app.status] || app.status)}</td><td>${escapeHtml(app.is_conflict_allowed || "N")}</td><td>${matches.map(escapeHtml).join("<br>")}</td></tr>`).join("")
      }</table>`
    : "";
  const conflictSection = showConflicts
    ? (conflicts.length
      ? `<section class="card"><h3>冲突信息</h3><p class="muted">以下为当前教学班与所有开放申请中的教学班的冲突情况。</p><table><tr><th>冲突教学班</th><th>课程/教授</th><th>我的状态</th><th>冲突时间</th></tr>${
          conflicts.map(({ classRow, relatedApplication, matches }) => `<tr><td>${escapeHtml(classRow.class_name)}</td><td>${escapeHtml(classRow.course_name)} / ${escapeHtml(classRow.teacher_name)}</td><td>${escapeHtml(relatedApplication ? (statusLabels[relatedApplication.status] || relatedApplication.status) : "未申请")}</td><td>${matches.map(escapeHtml).join("<br>")}</td></tr>`).join("")
        }</table></section>`
      : `<section class="card"><h3>冲突信息</h3><p class="ok">当前无冲突。</p></section>`)
    : "";
  db.close();
  sendHtml(res, pageLayout("教学班详情", `
    <section class="card">
      <h2>${escapeHtml(row.course_name)} / ${escapeHtml(row.class_name)}</h2>
      <p>教学班代码：${escapeHtml(row.class_code)}</p>
      <p>教学班缩写：${escapeHtml(row.class_abbr || row.class_code)}</p>
      <p>教授：${escapeHtml(row.teacher_name)} | 授课语言：${escapeHtml(row.teaching_language)} | 学期：${escapeHtml(row.semester)}</p>
      <p>最大录取人数：${row.maximum_number_of_tas_admitted}</p>
      <p>允许冲突申请：${escapeHtml(row.is_conflict_allowed || "N")}</p>
      <p>开放申请时间：${applyWindowText(row)}</p>
      <p>${escapeHtml(row.class_intro || "")}</p>
      <p class="muted">${escapeHtml(row.memo || "")}</p>
    </section>
    <section class="card">
      <h3>排课信息</h3>
      ${schedulesTable(schedules)}
    </section>
    ${conflictSection}
    <section class="card">
      <h3>提交申请</h3>
      ${resumeSection}
      ${submitGuardSection}
      <form method="post" action="/ta/applications">
        <input type="hidden" name="class_id" value="${row.class_id}" />
        <p><label>申请原因<textarea name="application_reason" required></textarea></label></p>
        <button type="submit" ${canSubmit ? "" : "disabled"}>提交申请</button>
      </form>
    </section>
  `, user, notice));
}

async function createApplication(req, res, user) {
  const fields = await readBody(req);
  const classId = Number(fields.class_id || 0);
  const reason = String(fields.application_reason || "").trim();
  if (!reason) {
    return redirect(res, `/ta/classes/${classId}?notice=申请原因必填`);
  }

  const db = getDb();
  if (user.is_allowed_to_apply !== "Y") {
    db.close();
    return redirect(res, "/ta/classes?notice=当前 TA 不允许申请");
  }
  const classRow = db.prepare("select * from classes where class_id = ?").get(classId);
  if (!classRow || !isClassOpenForApply(classRow)) {
    db.close();
    return redirect(res, "/ta/classes?notice=教学班当前未开放申请，或不在申请时间内");
  }
  const exists = db.prepare("select 1 from applications where applier_user_id = ? and class_id = ?").get(user.user_id, classId);
  if (exists) {
    db.close();
    return redirect(res, `/ta/classes/${classId}?notice=不可重复申请`);
  }
  if (!user.resume_name || !user.resume_path) {
    db.close();
    return redirect(res, `/ta/profile?notice=请先上传个人简历后再申请`);
  }
  const conflicts = getAppliedConflicts(db, user.user_id, classId);
  if (conflicts.length && classRow.is_conflict_allowed !== "Y") {
    db.close();
    return redirect(res, `/ta/classes/${classId}?show_conflicts=1&notice=存在时间冲突，无法申请`);
  }
  const insertResult = db.prepare(`
    insert into applications (
      applier_user_id, applier_name, class_id, class_name, teacher_user_id,
      teacher_name, application_reason, resume_name, resume_path, status, submitted_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PendingTAAdmin', ?)
  `).run(
    user.user_id,
    user.user_name,
    classRow.class_id,
    classRow.class_name,
    classRow.teacher_user_id,
    classRow.teacher_name,
    reason,
    user.resume_name,
    user.resume_path,
    nowStr()
  );
  const applicationId = insertResult.lastInsertRowid;
  const taAdmins = db.prepare("select user_id from users where role = 'TAAdmin'").all();
  for (const admin of taAdmins) {
    createNotification(
      db,
      admin.user_id,
      "有新的 TA 待初审申请",
      `${user.user_name} 提交了《${classRow.class_name}》的 TA 申请，请尽快初审。`,
      `/admin/ta/pending/${applicationId}`
    );
  }
  db.close();
  redirect(res, "/ta/applications?notice=申请已提交");
}

function taProfilePage(res, user, notice) {
  const resumeBlock = user.resume_path
    ? `
      <p>当前个人简历：${attachmentLink(user)}</p>
      <p class="muted">重新上传后，后续新的 TA 申请和你已有的申请记录都会显示最新简历。</p>
    `
    : `<p class="muted">当前尚未上传个人简历。上传后，提交 TA 申请时会自动带出，无需再次手动上传。</p>`;
  sendHtml(res, pageLayout("个人资料", `
    <section class="card">
      <h2>个人资料</h2>
      <p>姓名：${escapeHtml(user.user_name)}</p>
      <p>账号：${escapeHtml(user.login_name)}</p>
      <p>邮箱：${escapeHtml(user.email)}</p>
      ${resumeBlock}
    </section>
    <section class="card">
      <h3>上传个人简历</h3>
      <form method="post" action="/ta/profile/resume" enctype="multipart/form-data">
        <p><label>简历附件<input name="resume_file" type="file" accept=".pdf,.doc,.docx" required /></label></p>
        <p class="muted">仅支持 pdf、doc、docx，且文件大小不超过 5MB。</p>
        <button type="submit">保存个人简历</button>
      </form>
    </section>
  `, user, notice));
}

async function updateTaResume(req, res, user) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.startsWith("multipart/form-data")) {
    return redirect(res, "/ta/profile?notice=请通过表单上传简历");
  }
  const rawBody = await readRawBody(req);
  const { files } = parseMultipart(rawBody, contentType);
  const resumeFile = files.resume_file;
  if (!resumeFile || !resumeFile.filename) {
    return redirect(res, "/ta/profile?notice=请选择简历文件");
  }
  let storedFile;
  try {
    storedFile = saveUploadedFile(resumeFile);
  } catch (error) {
    return redirect(res, `/ta/profile?notice=${error.message}`);
  }
  const db = getDb();
  const current = db.prepare("select resume_path from users where user_id = ?").get(user.user_id);
  db.prepare("update users set resume_name = ?, resume_path = ? where user_id = ?").run(storedFile.originalName, storedFile.relativePath, user.user_id);
  db.prepare("update applications set resume_name = ?, resume_path = ? where applier_user_id = ?").run(storedFile.originalName, storedFile.relativePath, user.user_id);
  db.close();
  if (current && current.resume_path) {
    const oldFilePath = path.join(UPLOAD_DIR, path.basename(current.resume_path));
    if (fs.existsSync(oldFilePath)) {
      fs.unlinkSync(oldFilePath);
    }
  }
  redirect(res, "/ta/profile?notice=个人简历已更新");
}

function taApplicationsPage(res, user, notice) {
  const db = getDb();
  const apps = db.prepare("select * from applications where applier_user_id = ? order by submitted_at desc").all(user.user_id);
  db.close();
  const rows = apps.map((app) => `<tr>
    <td>${escapeHtml(app.class_name)}</td>
    <td>${escapeHtml(app.submitted_at)}</td>
    <td>${escapeHtml(statusLabels[app.status])}</td>
    <td>${escapeHtml(app.ta_comment || "")}</td>
    <td>${escapeHtml(app.prof_comment || "")}</td>
    <td class="actions">
      <a href="/ta/applications/${app.application_id}">详情</a>
      ${app.status === "PendingTAAdmin" ? `<form class="inline" method="post" action="/ta/applications/${app.application_id}/withdraw"><button class="secondary" type="submit">撤销</button></form>` : ""}
    </td>
  </tr>`).join("");
  sendHtml(res, pageLayout("我的申请", `<section class="card"><h2>我的申请</h2><table><tr><th>教学班</th><th>申请时间</th><th>状态</th><th>TAAdmin 备注</th><th>Professor 备注</th><th>操作</th></tr>${rows}</table></section>`, user, notice));
}

function taApplicationDetailPage(res, user, applicationId, notice) {
  const db = getDb();
  const app = db.prepare("select * from applications where application_id = ? and applier_user_id = ?").get(applicationId, user.user_id);
  if (!app) {
    db.close();
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageLayout("未找到", '<section class="card">申请不存在。</section>', user, notice));
    return;
  }
  const logs = db.prepare("select * from approval_logs where application_id = ? order by acted_at").all(applicationId);
  db.close();
  const logRows = logs.map((log) => `<tr><td>${escapeHtml(log.approval_stage)}</td><td>${escapeHtml(log.approver_name)}</td><td>${escapeHtml(log.result)}</td><td>${escapeHtml(log.comments || "")}</td><td>${escapeHtml(log.acted_at)}</td></tr>`).join("");
  sendHtml(res, pageLayout("申请详情", `
    <section class="card">
      <h2>${escapeHtml(app.class_name)}</h2>
      <p>当前状态：<span class="pill">${escapeHtml(statusLabels[app.status])}</span></p>
      <p>申请原因：${escapeHtml(app.application_reason)}</p>
      <p>简历：${attachmentLink(app)}</p>
      <p>TAAdmin 备注：${escapeHtml(app.ta_comment || "")}</p>
      <p>Professor 备注：${escapeHtml(app.prof_comment || "")}</p>
      ${app.status === "PendingTAAdmin" ? `<form method="post" action="/ta/applications/${applicationId}/withdraw"><button class="secondary" type="submit">撤销申请</button></form>` : ""}
    </section>
    <section class="card">
      <h3>审批日志</h3>
      <table><tr><th>阶段</th><th>审批人</th><th>结果</th><th>备注</th><th>时间</th></tr>${logRows}</table>
    </section>
  `, user, notice));
}

function withdrawApplication(res, user, applicationId) {
  const db = getDb();
  const app = db.prepare("select * from applications where application_id = ? and applier_user_id = ?").get(applicationId, user.user_id);
  if (!app) {
    db.close();
    return redirect(res, "/ta/applications?notice=申请不存在");
  }
  if (app.status !== "PendingTAAdmin") {
    db.close();
    return redirect(res, "/ta/applications?notice=当前状态不可撤销");
  }
  db.prepare("update applications set status = 'Withdrawn' where application_id = ?").run(applicationId);
  db.close();
  redirect(res, "/ta/applications?notice=申请已撤销");
}

function taAdminPendingPage(res, user, notice) {
  const db = getDb();
  const apps = db.prepare("select * from applications where status = 'PendingTAAdmin' order by submitted_at").all();
  db.close();
  const rows = apps.map((app) => `<tr><td>${escapeHtml(app.applier_name)}</td><td>${escapeHtml(app.class_name)}</td><td>${escapeHtml(app.submitted_at)}</td><td>${escapeHtml(app.application_reason)}</td><td><a href="/admin/ta/pending/${app.application_id}">详情</a></td></tr>`).join("");
  sendHtml(res, pageLayout("待初审申请", `<section class="card"><h2>待 TAAdmin 审批</h2><table><tr><th>申请人</th><th>教学班</th><th>申请时间</th><th>申请原因</th><th>操作</th></tr>${rows}</table></section>`, user, notice));
}

function taAdminDetailPage(res, user, applicationId, notice) {
  const db = getDb();
  const app = db.prepare("select * from applications where application_id = ?").get(applicationId);
  if (!app) {
    db.close();
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageLayout("未找到", '<section class="card">申请不存在。</section>', user, notice));
    return;
  }
  const conflictApps = getAppliedConflicts(db, app.applier_user_id, app.class_id);
  db.close();
  const conflictSection = conflictApps.length
    ? `<section class="card">
        <h3>该学生已申请的冲突教学班</h3>
        <table><tr><th>教学班</th><th>当前状态</th><th>是否允许冲突申请</th><th>冲突时间</th></tr>${
          conflictApps.map(({ app: conflictApp, matches }) => `<tr><td>${escapeHtml(conflictApp.class_name)}</td><td>${escapeHtml(statusLabels[conflictApp.status] || conflictApp.status)}</td><td>${escapeHtml(conflictApp.is_conflict_allowed || "N")}</td><td>${matches.map(escapeHtml).join("<br>")}</td></tr>`).join("")
        }</table>
      </section>`
    : `<section class="card"><h3>该学生已申请的冲突教学班</h3><p class="muted">当前未发现该学生已申请的冲突教学班。</p></section>`;
  sendHtml(res, pageLayout("TAAdmin 审批", `
    <section class="card">
      <h2>${escapeHtml(app.applier_name)} - ${escapeHtml(app.class_name)}</h2>
      <p>状态：${escapeHtml(statusLabels[app.status])}</p>
      <p>申请原因：${escapeHtml(app.application_reason)}</p>
      <p>简历：${attachmentLink(app)}</p>
      ${app.status === "PendingTAAdmin" ? `
        <form method="post" action="/admin/ta/pending/${applicationId}/approve">
          <p><label>审批结果
            <select name="result">
              <option value="Approved">通过</option>
              <option value="Rejected">拒绝</option>
            </select>
          </label></p>
          <p><label>审批备注<textarea name="comments"></textarea></label></p>
          <button type="submit">提交审批</button>
        </form>
      ` : `<p class="muted">该申请已完成处理，当前为只读状态。</p>`}
    </section>
    ${conflictSection}
    ${adminOverrideSection(`/admin/ta/applications/${applicationId}/override-status`, app.status)}
  `, user, notice));
}

function applyTaAdminDecision(db, approver, app, result, comments) {
  const actedAt = nowStr();
  const classRow = db.prepare("select * from classes where class_id = ?").get(app.class_id);
  if (!classRow) {
    throw new Error("教学班不存在");
  }
  if (result === "Approved") {
    const approvedCount = db.prepare("select count(*) as count from applications where class_id = ? and status = 'Approved'").get(app.class_id).count;
    if (approvedCount >= classRow.maximum_number_of_tas_admitted) {
      throw new Error("该教学班 TA 名额已满");
    }
  }
  const nextStatus = result === "Approved" ? "Approved" : "RejectedByTAAdmin";
  db.prepare(`
    update applications
    set status = ?, ta_comment = ?, ta_acted_at = ?
    where application_id = ? and status = 'PendingTAAdmin'
  `).run(nextStatus, comments, actedAt, app.application_id);
  db.prepare(`
    insert into approval_logs (application_id, approval_stage, approver_user_id, approver_name, result, comments, acted_at)
    values (?, 'TAAdmin', ?, ?, ?, ?, ?)
  `).run(app.application_id, approver.user_id, approver.user_name, result, comments, actedAt);
  if (result === "Approved") {
    createNotification(db, app.applier_user_id, "TA 审批通过", `你的申请《${app.class_name}》已通过 TAAdmin 审批。`, `/ta/applications/${app.application_id}`);
    if (classRow.maximum_number_of_tas_admitted === 1) {
      const others = db.prepare(`
        select * from applications
        where class_id = ?
          and application_id != ?
          and status = 'PendingTAAdmin'
      `).all(app.class_id, app.application_id);
      for (const other of others) {
        const autoReason = "该课程TA已满";
        db.prepare(`
          update applications
          set status = 'RejectedByTAAdmin', ta_comment = ?, ta_acted_at = ?
          where application_id = ?
        `).run(autoReason, actedAt, other.application_id);
        db.prepare(`
          insert into approval_logs (application_id, approval_stage, approver_user_id, approver_name, result, comments, acted_at)
          values (?, 'TAAdmin', ?, ?, 'Rejected', ?, ?)
        `).run(other.application_id, approver.user_id, approver.user_name, autoReason, actedAt);
        createNotification(db, other.applier_user_id, "TA 申请被拒绝", `你的申请《${other.class_name}》因课程 TA 名额已满被自动拒绝。`, `/ta/applications/${other.application_id}`);
      }
    }
    syncClassApplyAvailabilityByCapacity(db, app.class_id);
  } else {
    createNotification(db, app.applier_user_id, "TA 审批未通过", `你的申请《${app.class_name}》被 TAAdmin 拒绝。`, `/ta/applications/${app.application_id}`);
  }
}

async function taAdminApprove(req, res, user, applicationId) {
  const body = await readBody(req);
  const result = String(body.result || "Rejected");
  const comments = String(body.comments || "").trim();
  const db = getDb();
  const app = db.prepare("select * from applications where application_id = ?").get(applicationId);
  if (!app || app.status !== "PendingTAAdmin") {
    db.close();
    return redirect(res, "/admin/ta/pending?notice=申请已被处理");
  }
  try {
    applyTaAdminDecision(db, user, app, result, comments);
  } catch (error) {
    db.close();
    return redirect(res, `/admin/ta/pending/${applicationId}?notice=${error.message}`);
  }
  db.close();
  redirect(res, "/admin/ta/pending?notice=审批已完成");
}

function adminOverrideSection(actionPath, currentStatus) {
  return `
    <section class="card">
      <h3>管理性调整申请状态</h3>
      <p class="muted">用于修正误操作或特殊情况。系统会保留原审批记录，并追加一条管理员调整日志。</p>
      <form method="post" action="${actionPath}">
        <p><label>新状态<select name="status">${adminOverrideStatusOptions(currentStatus)}</select></label></p>
        <p><label>调整说明<textarea name="comments" required></textarea></label></p>
        <button class="secondary rect" type="submit">保存状态调整</button>
      </form>
    </section>
  `;
}

function applyAdminStatusOverride(db, actor, app, nextStatus, comments) {
  if (!adminOverrideStatuses.includes(nextStatus)) {
    throw new Error("目标状态不合法");
  }
  const classRow = db.prepare("select * from classes where class_id = ?").get(app.class_id);
  if (!classRow) {
    throw new Error("教学班不存在");
  }
  if (nextStatus === "Approved" && app.status !== "Approved") {
    const approvedCount = db.prepare("select count(*) as count from applications where class_id = ? and status = 'Approved' and application_id != ?").get(app.class_id, app.application_id).count;
    if (approvedCount >= classRow.maximum_number_of_tas_admitted) {
      throw new Error("该教学班 TA 名额已满，无法调整为已通过");
    }
  }
  const actedAt = nowStr();
  db.prepare(`
    update applications
    set status = ?, ta_acted_at = ?, prof_acted_at = ?,
        ta_comment = case when ? in ('PendingTAAdmin', 'RejectedByTAAdmin') then ? else ta_comment end,
        prof_comment = case when ? in ('PendingProfessor', 'RejectedByProfessor', 'Approved') then ? else prof_comment end
    where application_id = ?
  `).run(
    nextStatus,
    actedAt,
    actedAt,
    nextStatus,
    comments,
    nextStatus,
    comments,
    app.application_id
  );
  db.prepare(`
    insert into approval_logs (application_id, approval_stage, approver_user_id, approver_name, result, comments, acted_at)
    values (?, 'AdminOverride', ?, ?, ?, ?, ?)
  `).run(app.application_id, actor.user_id, actor.user_name, nextStatus, comments, actedAt);
  createNotification(
    db,
    app.applier_user_id,
    "申请状态已调整",
    `你的申请《${app.class_name}》已由管理员调整为「${statusLabels[nextStatus] || nextStatus}」。`,
    `/ta/applications/${app.application_id}`
  );
  syncClassApplyAvailabilityByCapacity(db, app.class_id);
}

async function overrideApplicationStatus(req, res, actor, applicationId, redirectBasePath) {
  const body = await readBody(req);
  const nextStatus = String(body.status || "").trim();
  const comments = String(body.comments || "").trim();
  if (!comments) {
    return redirect(res, `${redirectBasePath}/${applicationId}?notice=请填写调整说明`);
  }
  const db = getDb();
  const app = db.prepare("select * from applications where application_id = ?").get(applicationId);
  if (!app) {
    db.close();
    return redirect(res, `${redirectBasePath}?notice=申请不存在`);
  }
  try {
    applyAdminStatusOverride(db, actor, app, nextStatus, comments);
  } catch (error) {
    db.close();
    return redirect(res, `${redirectBasePath}/${applicationId}?notice=${error.message}`);
  }
  db.close();
  redirect(res, `${redirectBasePath}/${applicationId}?notice=申请状态已调整`);
}

function remindProfessor(res, user, applicationId) {
  const db = getDb();
  const app = db.prepare("select * from applications where application_id = ?").get(applicationId);
  if (!app) {
    db.close();
    return redirect(res, "/admin/ta/applications?notice=申请不存在");
  }
  if (app.status !== "PendingProfessor") {
    db.close();
    return redirect(res, `/admin/ta/pending/${applicationId}?notice=当前状态无需提醒 Professor`);
  }
  createNotification(db, app.teacher_user_id, "TA 审批提醒", `请尽快审批教学班《${app.class_name}》的 TA 申请。`, `/professor/pending/${applicationId}`);
  db.close();
  redirect(res, `/admin/ta/pending/${applicationId}?notice=已提醒 Professor 审批`);
}

function taUsersPage(res, user, notice) {
  const db = getDb();
  const rows = db.prepare(`
    select u.*,
      (select count(*) from applications a where a.applier_user_id = u.user_id) as application_count,
      (select count(*) from applications a where a.applier_user_id = u.user_id and a.status = 'Approved') as approved_count
    from users u
    where u.role = 'TA'
    order by u.user_name
  `).all();
  db.close();
  const htmlRows = rows.map((row) => `<tr>
    <td>${escapeHtml(row.user_name)}</td>
    <td>${escapeHtml(row.login_name)}</td>
    <td>${escapeHtml(row.email)}</td>
    <td>${escapeHtml(row.is_allowed_to_apply)}</td>
    <td>${row.application_count}</td>
    <td>${row.approved_count}</td>
    <td><form class="inline" method="post" action="/admin/ta/users/${row.user_id}/toggle"><button type="submit">${row.is_allowed_to_apply === "Y" ? "关闭资格" : "开启资格"}</button></form></td>
  </tr>`).join("");
  sendHtml(res, pageLayout("TA 管理", `<section class="card"><h2>TA 管理</h2><table><tr><th>姓名</th><th>账号</th><th>邮箱</th><th>允许申请</th><th>申请数</th><th>已通过</th><th>操作</th></tr>${htmlRows}</table></section>`, user, notice));
}

function notificationsPage(res, user, notice) {
  const db = getDb();
  const rows = db.prepare("select * from notifications where user_id = ? order by created_at desc, notification_id desc").all(user.user_id);
  db.close();
  const tableRows = rows.map((row) => `<tr>
    <td>${row.notification_id}</td>
    <td>${escapeHtml(row.title)}</td>
    <td>${escapeHtml(row.content)}</td>
    <td>${escapeHtml(row.created_at)}</td>
    <td>${row.is_read === "Y" ? "已读" : "未读"}</td>
    <td class="actions">${row.target_path ? `<a href="${escapeHtml(row.target_path)}">查看</a>` : ""}${row.is_read === "N" ? `<form class="inline" method="post" action="/notifications/${row.notification_id}/read"><button type="submit">标为已读</button></form>` : ""}</td>
  </tr>`).join("");
  sendHtml(res, pageLayout("通知中心", `
    <section class="card">
      <h2>通知中心</h2>
      <table><tr><th>ID</th><th>标题</th><th>内容</th><th>时间</th><th>状态</th><th>操作</th></tr>${tableRows}</table>
    </section>
  `, user, notice));
}

function markNotificationRead(res, user, notificationId) {
  const db = getDb();
  db.prepare("update notifications set is_read = 'Y' where notification_id = ? and user_id = ?").run(notificationId, user.user_id);
  db.close();
  redirect(res, "/notifications?notice=通知已标记为已读");
}

function toggleTaUser(res, userId) {
  const db = getDb();
  const row = db.prepare("select * from users where user_id = ? and role = 'TA'").get(userId);
  if (!row) {
    db.close();
    return redirect(res, "/admin/ta/users?notice=TA 不存在");
  }
  db.prepare("update users set is_allowed_to_apply = ? where user_id = ?").run(row.is_allowed_to_apply === "Y" ? "N" : "Y", userId);
  db.close();
  redirect(res, "/admin/ta/users?notice=TA 资格已更新");
}

function professorPendingPage(res, user, notice) {
  const db = getDb();
  const rows = db.prepare(`
    select c.*,
      (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingProfessor') as pending_count,
      (select count(*) from applications a where a.class_id = c.class_id) as application_count,
      (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count
    from classes c
    where (',' || c.teacher_user_id || ',') like '%,' || ? || ',%'
      and exists (
        select 1 from applications a
        where a.class_id = c.class_id and a.status = 'PendingProfessor'
      )
    order by c.semester, c.course_name, c.class_name
  `).all(user.user_id);
  const schedulesByClass = new Map();
  const allSchedules = db.prepare(`
    select class_id, lesson_date, start_time, end_time, section, is_exam
    from class_schedules
    where class_id in (
      select c.class_id
      from classes c
      where (',' || c.teacher_user_id || ',') like '%,' || ? || ',%'
    )
    order by lesson_date, start_time
  `).all(user.user_id);
  for (const schedule of allSchedules) {
    if (!schedulesByClass.has(schedule.class_id)) {
      schedulesByClass.set(schedule.class_id, []);
    }
    schedulesByClass.get(schedule.class_id).push(schedule);
  }
  db.close();
  const body = rows.length
    ? rows.map((row) => {
      const remaining = Math.max(0, Number(row.maximum_number_of_tas_admitted) - Number(row.approved_count));
      return `<section class="card">
        <h2>${escapeHtml(row.course_name)} / ${escapeHtml(row.class_name)}</h2>
        <p><span class="pill">${escapeHtml(row.semester)}</span> 教授：${escapeHtml(row.teacher_name)}</p>
        <p class="muted">当前共有 <strong>${row.application_count}</strong> 份申请，其中待审核 <strong>${row.pending_count}</strong> 份，已通过 <strong>${row.approved_count}</strong> / ${row.maximum_number_of_tas_admitted}，剩余名额 <strong>${remaining}</strong> 个。</p>
        <p class="muted">当你继续通过申请并达到该教学班 TA 上限时，系统会自动拒绝该教学班其余待审核申请，拒绝理由为“该课程TA已满”。</p>
        ${scheduleSummary(schedulesByClass.get(row.class_id) || [], `professor-${row.class_id}`)}
        <div class="actions" style="margin-top:12px;">
          <a class="button-link rect" href="/professor/classes/${row.class_id}">进入教学班审核</a>
        </div>
      </section>`;
    }).join("")
    : '<section class="card"><h2>待教授审批</h2><p class="muted">当前没有待教授审核的教学班。</p></section>';
  sendHtml(res, pageLayout("待教授审批", body, user, notice));
}

function professorClassReviewPage(res, user, classId, notice) {
  const db = getDb();
  const classRow = db.prepare("select * from classes where class_id = ? and (',' || teacher_user_id || ',') like '%,' || ? || ',%'").get(classId, user.user_id);
  if (!classRow) {
    db.close();
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageLayout("未找到", '<section class="card">教学班不存在，或你无权查看。</section>', user, notice));
    return;
  }
  const schedules = fetchSchedules(db, classId);
  const apps = db.prepare("select * from applications where class_id = ? order by case when status = 'PendingProfessor' then 0 else 1 end, submitted_at, application_id").all(classId);
  const approvedCount = db.prepare("select count(*) as count from applications where class_id = ? and status = 'Approved'").get(classId).count;
  db.close();
  const remaining = Math.max(0, Number(classRow.maximum_number_of_tas_admitted) - Number(approvedCount));
  const rows = apps.map((app) => `<tr>
    <td>${escapeHtml(app.applier_name)}</td>
    <td>${escapeHtml(app.submitted_at)}</td>
    <td>${escapeHtml(statusLabels[app.status] || app.status)}</td>
    <td>${escapeHtml(app.ta_comment || "")}</td>
    <td><a href="/professor/pending/${app.application_id}">查看申请</a></td>
  </tr>`).join("");
  sendHtml(res, pageLayout("教学班审核", `
    <section class="card">
      <h2>${escapeHtml(classRow.course_name)} / ${escapeHtml(classRow.class_name)}</h2>
      <p><span class="pill">${escapeHtml(classRow.semester)}</span> 教授：${escapeHtml(classRow.teacher_name)}</p>
      <p class="muted">当前已通过 <strong>${approvedCount}</strong> / ${classRow.maximum_number_of_tas_admitted}，剩余名额 <strong>${remaining}</strong> 个。</p>
      <div class="notice" style="margin:16px 0 0;">
        当你继续通过申请并达到该教学班 TA 上限时，系统会自动拒绝该教学班其余待审核申请，拒绝理由为“该课程TA已满”。
      </div>
    </section>
    <section class="card">
      <h3>排课安排</h3>
      ${schedulesTable(schedules)}
    </section>
    <section class="card">
      <h3>该教学班全部申请</h3>
      <table><tr><th>申请人</th><th>申请时间</th><th>状态</th><th>TAAdmin 备注</th><th>操作</th></tr>${rows}</table>
    </section>
  `, user, notice));
}

function professorDetailPage(res, user, applicationId, notice) {
  const db = getDb();
  const app = db.prepare("select * from applications where application_id = ? and (',' || teacher_user_id || ',') like '%,' || ? || ',%'").get(applicationId, user.user_id);
  if (!app) {
    db.close();
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageLayout("未找到", '<section class="card">申请不存在。</section>', user, notice));
    return;
  }
  const classRow = db.prepare("select * from classes where class_id = ?").get(app.class_id);
  const approvedCount = db.prepare("select count(*) as count from applications where class_id = ? and status = 'Approved'").get(app.class_id).count;
  db.close();
  const willAutoRejectOthers = approvedCount + (app.status === "PendingProfessor" ? 1 : 0) >= classRow.maximum_number_of_tas_admitted;
  sendHtml(res, pageLayout("教授审批", `
    <section class="card">
      <h2>${escapeHtml(app.applier_name)} - ${escapeHtml(app.class_name)}</h2>
      <p>申请原因：${escapeHtml(app.application_reason)}</p>
      <p>简历：${attachmentLink(app)}</p>
      <p>TAAdmin 备注：${escapeHtml(app.ta_comment || "")}</p>
      <p>当前录取人数：${approvedCount} / ${classRow.maximum_number_of_tas_admitted}</p>
      <p class="muted">同一教学班当前共有 ${classRow.maximum_number_of_tas_admitted} 个 TA 名额。</p>
      <div class="notice" style="margin:16px 0;">
        ${willAutoRejectOthers
          ? "提示：如果你现在通过这份申请，系统将达到该教学班 TA 上限，并自动拒绝该教学班其余待审核申请，拒绝理由为“该课程TA已满”。"
          : "提示：当通过人数达到该教学班 TA 上限时，系统会自动拒绝该教学班其余待审核申请，拒绝理由为“该课程TA已满”。"}
      </div>
      <form method="post" action="/professor/pending/${applicationId}/approve">
        <p><label>审批结果
          <select name="result">
            <option value="Approved">通过</option>
            <option value="Rejected">拒绝</option>
          </select>
        </label></p>
        <p><label>审批备注<textarea name="comments"></textarea></label></p>
        <button type="submit">提交终审</button>
      </form>
      <div class="actions" style="margin-top:12px;">
        <a class="button-link secondary rect" href="/professor/classes/${app.class_id}">返回教学班审核</a>
      </div>
    </section>
  `, user, notice));
}

async function professorApprove(req, res, user, applicationId) {
  const body = await readBody(req);
  const result = String(body.result || "Rejected");
  const comments = String(body.comments || "").trim();
  const db = getDb();
  const app = db.prepare("select * from applications where application_id = ? and (',' || teacher_user_id || ',') like '%,' || ? || ',%'").get(applicationId, user.user_id);
  if (!app || app.status !== "PendingProfessor") {
    db.close();
    return redirect(res, "/professor/pending?notice=申请已被处理");
  }
  const classRow = db.prepare("select * from classes where class_id = ?").get(app.class_id);
  if (result === "Approved") {
    const approvedCount = db.prepare("select count(*) as count from applications where class_id = ? and status = 'Approved'").get(app.class_id).count;
    if (approvedCount >= classRow.maximum_number_of_tas_admitted) {
      db.close();
      return redirect(res, `/professor/pending/${applicationId}?notice=该教学班 TA 名额已满`);
    }
  }
  const nextStatus = result === "Approved" ? "Approved" : "RejectedByProfessor";
  db.prepare(`
    update applications
    set status = ?, prof_comment = ?, prof_acted_at = ?
    where application_id = ? and status = 'PendingProfessor'
  `).run(nextStatus, comments, nowStr(), applicationId);
  db.prepare(`
    insert into approval_logs (application_id, approval_stage, approver_user_id, approver_name, result, comments, acted_at)
    values (?, 'Professor', ?, ?, ?, ?, ?)
  `).run(applicationId, user.user_id, user.user_name, result, comments, nowStr());
  if (result === "Approved") {
    createNotification(db, app.applier_user_id, "Professor 审批通过", `你的申请《${app.class_name}》已通过 Professor 审批。`, `/ta/applications/${applicationId}`);
    const finalApprovedCount = db.prepare("select count(*) as count from applications where class_id = ? and status = 'Approved'").get(app.class_id).count;
    if (finalApprovedCount >= classRow.maximum_number_of_tas_admitted) {
      const otherApps = db.prepare(`
        select * from applications
        where class_id = ?
          and application_id != ?
          and status in ('PendingTAAdmin', 'PendingProfessor')
      `).all(app.class_id, applicationId);
      const rejectReason = "该课程TA已满";
      const rejectStmt = db.prepare(`
        update applications
        set status = 'RejectedByProfessor', prof_comment = ?, prof_acted_at = ?
        where application_id = ?
      `);
      const rejectLog = db.prepare(`
        insert into approval_logs (application_id, approval_stage, approver_user_id, approver_name, result, comments, acted_at)
        values (?, 'Professor', ?, ?, 'Rejected', ?, ?)
      `);
      for (const other of otherApps) {
        rejectStmt.run(rejectReason, nowStr(), other.application_id);
        rejectLog.run(other.application_id, user.user_id, user.user_name, rejectReason, nowStr());
        createNotification(db, other.applier_user_id, "TA 申请被拒绝", `你的申请《${other.class_name}》因课程 TA 名额已满被自动拒绝。`, `/ta/applications/${other.application_id}`);
      }
    }
    syncClassApplyAvailabilityByCapacity(db, app.class_id);
  } else {
    createNotification(db, app.applier_user_id, "Professor 审批未通过", `你的申请《${app.class_name}》被 Professor 拒绝。`, `/ta/applications/${applicationId}`);
  }
  db.close();
  redirect(res, "/professor/pending?notice=终审已完成");
}

function professorOptions(selectedUserId) {
  const db = getDb();
  const rows = db.prepare("select * from users where role = 'Professor' order by user_name").all();
  db.close();
  return rows.map((row) => `<option value="${row.user_id}" ${Number(selectedUserId) === row.user_id ? "selected" : ""}>${escapeHtml(row.user_name)}</option>`).join("");
}

function professorMultiOptions(selectedUserIds) {
  const selected = new Set(normalizeTeacherUserIds(selectedUserIds));
  const db = getDb();
  const rows = db.prepare("select * from users where role = 'Professor' order by user_name").all();
  db.close();
  return rows.map((row) => `<option value="${row.user_id}" ${selected.has(row.user_id) ? "selected" : ""}>${escapeHtml(row.user_name)}</option>`).join("");
}

function resolveProfessorSelection(db, rawValue) {
  const ids = normalizeTeacherUserIds(rawValue);
  if (!ids.length) {
    throw new Error("请至少选择一位 Professor");
  }
  const findProfessor = db.prepare("select * from users where user_id = ? and role = 'Professor'");
  const rows = ids.map((id) => findProfessor.get(id)).filter(Boolean);
  if (rows.length !== ids.length) {
    throw new Error("Professor 不存在");
  }
  return {
    ids: rows.map((row) => row.user_id),
    idText: rows.map((row) => row.user_id).join(","),
    nameText: rows.map((row) => row.user_name).join(" / ")
  };
}

function courseClassesPage(res, user, notice, statusFilter) {
  const db = getDb();
  const rowsRaw = db.prepare(`
    select c.*,
      (select count(*) from applications a where a.class_id = c.class_id) as application_count,
      (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count
    from classes c
    order by c.semester, c.course_name, c.class_name
  `).all();
  const rows = statusFilter ? rowsRaw.filter((row) => classOpenStatus(row) === statusFilter) : rowsRaw;
  const schedulesByClass = new Map();
  const allSchedules = db.prepare(`
    select class_id, lesson_date, start_time, end_time, section, is_exam
    from class_schedules
    order by lesson_date, start_time
  `).all();
  for (const schedule of allSchedules) {
    if (!schedulesByClass.has(schedule.class_id)) {
      schedulesByClass.set(schedule.class_id, []);
    }
    schedulesByClass.get(schedule.class_id).push(schedule);
  }
  const tableRows = rows.map((row) => {
    const scheduleRows = schedulesByClass.get(row.class_id) || [];
    return `<tr>
    <td><input type="checkbox" class="class-select" value="${row.class_id}" /></td>
    <td>${escapeHtml(row.class_code)}</td>
    <td>${escapeHtml(row.class_abbr || "")}</td>
    <td>${escapeHtml(row.course_name)}</td>
    <td>${escapeHtml(row.class_name)}</td>
    <td>${escapeHtml(row.teacher_name)}</td>
    <td>${escapeHtml(row.semester)}</td>
    <td>${escapeHtml(classOpenStatusLabel(row))}</td>
    <td>${scheduleRows.length}</td>
    <td>${scheduleSummary(scheduleRows, `course-${row.class_id}`)}</td>
    <td>${row.approved_count} / ${row.maximum_number_of_tas_admitted}</td>
    <td>${row.application_count}</td>
    <td>${escapeHtml(row.ta_applications_allowed)}</td>
    <td>${escapeHtml(row.is_conflict_allowed || "N")}</td>
    <td>
      <div class="actions">
        <a class="button-link secondary" href="/course/classes/${row.class_id}">修改教学班</a>
        <a class="button-link secondary" href="/course/classes/${row.class_id}/applications">查看申请</a>
        <a class="button-link danger" href="/course/classes/${row.class_id}/delete">删除教学班</a>
      </div>
    </td>
  </tr>`;
  }).join("");
  db.close();
  sendHtml(res, pageLayout("教学班管理", `
    <section class="card">
      <h2>导入教学班与排课</h2>
      <form method="post" action="/course/classes/import" enctype="multipart/form-data">
        <p><label>导入文件<input name="classes_file" type="file" accept=".xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></label></p>
        <div class="actions">
          <button type="submit">导入 Excel</button>
          <a class="button-link secondary" href="/course/classes/import/template">下载模板</a>
        </div>
      </form>
      <p class="muted">当前导入格式为 Excel。同一个 class_code 可出现多行，每行代表一条排课。导入时按 class_code 覆盖教学班基础信息并重建该教学班的全部排课。</p>
      <div class="field-order">
        字段顺序：<br>
        class_code, class_abbr, course_name, class_name, teaching_language, teacher_login_name, semester, maximum_number, ta_allowed, is_conflict_allowed<br>
        apply_start_at, apply_end_at, lesson_date, start_time, end_time, section, is_exam, class_intro, memo
      </div>
    </section>
    <section class="card">
      <h2>筛选教学班</h2>
      <form method="get" action="/course/classes">
        <div class="grid">
          <p><label>开放状态<select name="status_filter">
            <option value="" ${!statusFilter ? "selected" : ""}>全部</option>
            <option value="open" ${statusFilter === "open" ? "selected" : ""}>开放中</option>
            <option value="upcoming" ${statusFilter === "upcoming" ? "selected" : ""}>未开始</option>
            <option value="expired" ${statusFilter === "expired" ? "selected" : ""}>已过期</option>
            <option value="closed" ${statusFilter === "closed" ? "selected" : ""}>已关闭</option>
            <option value="unset" ${statusFilter === "unset" ? "selected" : ""}>未设置</option>
          </select></label></p>
        </div>
        <button type="submit">筛选</button>
      </form>
    </section>
    <section class="card">
      <h2>批量开关申请权限</h2>
      <form method="post" action="/course/classes/batch-toggle" onsubmit="return submitSelectedClasses(this);">
        <input type="hidden" name="class_refs" />
        <div class="grid">
          <p><label>申请权限<select name="ta_allowed"><option value="Y">开启</option><option value="N">关闭</option></select></label></p>
        </div>
        <button type="submit">批量更新</button>
      </form>
      <p class="muted">基于当前勾选的教学班执行。只更新是否允许申请，不修改申请时间窗。</p>
    </section>
    <section class="card">
      <h2>批量设置开放申请时间</h2>
      <form method="post" action="/course/classes/batch-window" onsubmit="return submitSelectedClasses(this);">
        <input type="hidden" name="class_refs" />
        <div class="grid">
          <p><label>开放开始时间<input name="apply_start_at" type="datetime-local" required /></label></p>
          <p><label>开放结束时间<input name="apply_end_at" type="datetime-local" required /></label></p>
        </div>
        <button type="submit">批量设置</button>
      </form>
      <p class="muted">基于当前勾选的教学班执行。</p>
    </section>
    <section class="card">
      <h2>批量删除教学班</h2>
      <form method="post" action="/course/classes/batch-delete" onsubmit="return submitSelectedClasses(this);">
        <input type="hidden" name="class_refs" />
        <button class="secondary" type="submit">进入批量删除确认</button>
      </form>
      <p class="muted">基于当前勾选的教学班执行，会先进入确认页，再统一删除关联排课、申请、审批记录和附件。</p>
    </section>
    <section class="card">
      <h2>新增教学班</h2>
      <form method="post" action="/course/classes/create">
        <div class="grid">
          <p><label>ClassCode<input name="class_code" required /></label></p>
          <p><label>教学班缩写<input name="class_abbr" required /></label></p>
          <p><label>课程名<input name="course_name" required /></label></p>
          <p><label>教学班名称<input name="class_name" required /></label></p>
          <p><label>授课语言<select name="teaching_language"><option value="中文">中文</option><option value="英文">英文</option></select></label></p>
          <p><label>Professor（可多选）<select name="teacher_user_id" multiple size="4">${professorMultiOptions([])}</select></label></p>
          <p><label>学期<input name="semester" value="2026Fall" required /></label></p>
          <p><label>最大录取人数<input name="maximum_number" type="number" value="1" min="1" required /></label></p>
          <p><label>允许 TA 申请<select name="ta_allowed"><option value="Y">Y</option><option value="N">N</option></select></label></p>
          <p><label>允许冲突申请<select name="is_conflict_allowed"><option value="N">N</option><option value="Y">Y</option></select></label></p>
          <p><label>开放开始时间<input name="apply_start_at" type="datetime-local" value="2026-03-09T09:00" required /></label></p>
          <p><label>开放结束时间<input name="apply_end_at" type="datetime-local" value="2026-12-31T23:59" required /></label></p>
        </div>
        <p><label>课程介绍<textarea name="class_intro"></textarea></label></p>
        <p><label>备注<textarea name="memo"></textarea></label></p>
        <p><label>排课记录<textarea name="schedule_lines" required>2026-09-15,18:30,20:30,晚上
2026-09-22,18:30,20:30,晚上</textarea></label></p>
        <p class="muted">一行一条排课，格式：YYYY-MM-DD,HH:MM,HH:MM,节次[,考试类型]。节次仅支持“上午/下午/晚上”，考试类型可留空或填写“期中考试/期末考试”。</p>
        <button type="submit">创建教学班</button>
      </form>
    </section>
    <section class="card">
      <h2>教学班列表</h2>
      <div class="actions" style="margin-bottom:12px;">
        <label><input type="checkbox" id="select-all-classes" /> 全选当前列表</label>
        <span class="muted">已选 <strong id="selected-class-count">0</strong> 个教学班</span>
      </div>
      <div class="table-wrap">
        <table class="wide"><tr><th style="width:56px;">选择</th><th style="width:116px;">代码</th><th style="width:110px;">缩写</th><th style="width:136px;">课程名</th><th style="width:156px;">教学班</th><th style="width:170px;">教授</th><th style="width:100px;">学期</th><th style="width:110px;">开放状态</th><th style="width:72px;">排课数</th><th style="min-width:240px;">排课安排</th><th style="width:118px;">已通过/上限</th><th style="width:84px;">申请数</th><th style="width:88px;">开放申请</th><th style="width:100px;">允许冲突</th><th style="width:300px;">单条操作</th></tr>${tableRows}</table>
      </div>
    </section>
    <script>
      (() => {
        const checkboxes = Array.from(document.querySelectorAll('.class-select'));
        const selectAll = document.getElementById('select-all-classes');
        const countNode = document.getElementById('selected-class-count');
        const refreshSelectedState = () => {
          const checked = checkboxes.filter((item) => item.checked);
          countNode.textContent = String(checked.length);
          if (selectAll) {
            selectAll.checked = checked.length > 0 && checked.length === checkboxes.length;
            selectAll.indeterminate = checked.length > 0 && checked.length < checkboxes.length;
          }
        };
        if (selectAll) {
          selectAll.addEventListener('change', () => {
            checkboxes.forEach((item) => { item.checked = selectAll.checked; });
            refreshSelectedState();
          });
        }
        checkboxes.forEach((item) => item.addEventListener('change', refreshSelectedState));
        window.submitSelectedClasses = (form) => {
          const selected = checkboxes.filter((item) => item.checked).map((item) => item.value);
          if (!selected.length) {
            window.alert('请先勾选至少一个教学班');
            return false;
          }
          form.querySelector('input[name="class_refs"]').value = selected.join(',');
          return true;
        };
        refreshSelectedState();
      })();
    </script>
  `, user, notice));
}

function taAdminAllApplicationsPage(res, user, notice) {
  const db = getDb();
  const rows = db.prepare("select * from applications order by submitted_at desc").all();
  db.close();
  const tableRows = rows.map((app) => `<tr>
    <td>${app.application_id}</td>
    <td>${escapeHtml(app.applier_name)}</td>
    <td>${escapeHtml(app.class_name)}</td>
    <td>${escapeHtml(app.teacher_name)}</td>
    <td>${escapeHtml(app.submitted_at)}</td>
    <td>${escapeHtml(statusLabels[app.status] || app.status)}</td>
    <td>${attachmentLink(app)}</td>
    <td><a href="/admin/ta/pending/${app.application_id}">详情</a></td>
  </tr>`).join("");
  sendHtml(res, pageLayout("全部申请", `
    <section class="card">
      <h2>全部 TA 申请</h2>
      <table><tr><th>ID</th><th>申请人</th><th>教学班</th><th>教授</th><th>申请时间</th><th>状态</th><th>简历</th><th>操作</th></tr>${tableRows}</table>
    </section>
  `, user, notice));
}

function courseAdminAllApplicationsPage(res, user, notice) {
  const db = getDb();
  const rows = db.prepare("select * from applications order by submitted_at desc").all();
  db.close();
  const tableRows = rows.map((app) => `<tr>
    <td>${app.application_id}</td>
    <td>${escapeHtml(app.applier_name)}</td>
    <td>${escapeHtml(app.class_name)}</td>
    <td>${escapeHtml(app.teacher_name)}</td>
    <td>${escapeHtml(app.submitted_at)}</td>
    <td>${escapeHtml(statusLabels[app.status] || app.status)}</td>
    <td>${attachmentLink(app)}</td>
    <td><a href="/course/applications/${app.application_id}">详情</a></td>
  </tr>`).join("");
  sendHtml(res, pageLayout("全部申请", `
    <section class="card">
      <h2>全部 TA 申请</h2>
      <table><tr><th>ID</th><th>申请人</th><th>教学班</th><th>教授</th><th>申请时间</th><th>状态</th><th>简历</th><th>操作</th></tr>${tableRows}</table>
    </section>
  `, user, notice));
}

function courseAdminApplicationDetailPage(res, user, applicationId, notice) {
  const db = getDb();
  const app = db.prepare("select * from applications where application_id = ?").get(applicationId);
  const logs = db.prepare(`
    select approval_stage, approver_name, result, comments, acted_at
    from approval_logs
    where application_id = ?
    order by acted_at, approval_log_id
  `).all(applicationId);
  db.close();
  if (!app) {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageLayout("未找到", '<section class="card">申请不存在。</section>', user, notice));
    return;
  }
  const logRows = logs.map((log) => `<tr>
    <td>${escapeHtml(log.approval_stage)}</td>
    <td>${escapeHtml(log.approver_name)}</td>
    <td>${escapeHtml(log.result)}</td>
    <td>${escapeHtml(log.comments || "")}</td>
    <td>${escapeHtml(log.acted_at)}</td>
  </tr>`).join("");
  sendHtml(res, pageLayout("申请详情", `
    <section class="card">
      <h2>${escapeHtml(app.applier_name)} - ${escapeHtml(app.class_name)}</h2>
      <p>教授：${escapeHtml(app.teacher_name)}</p>
      <p>状态：${escapeHtml(statusLabels[app.status] || app.status)}</p>
      <p>申请时间：${escapeHtml(app.submitted_at)}</p>
      <p>申请原因：${escapeHtml(app.application_reason)}</p>
      <p>简历：${attachmentLink(app)}</p>
      <p>TAAdmin 备注：${escapeHtml(app.ta_comment || "")}</p>
      <p>Professor 备注：${escapeHtml(app.prof_comment || "")}</p>
    </section>
    <section class="card">
      <h3>审批记录</h3>
      <table><tr><th>阶段</th><th>审批人</th><th>结果</th><th>备注</th><th>时间</th></tr>${logRows || "<tr><td colspan=\"5\">暂无审批记录</td></tr>"}</table>
    </section>
    ${adminOverrideSection(`/course/applications/${applicationId}/override-status`, app.status)}
  `, user, notice));
}

function classesImportResultPage(res, user, reportId, notice) {
  const report = importReports.get(reportId);
  if (!report) {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageLayout("未找到", '<section class="card">导入结果不存在或已过期。</section>', user, notice));
    return;
  }
  if (report.status === "failed") {
    const errorItems = (report.errors || [report.errorMessage || "未知错误"])
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("");
    sendHtml(res, pageLayout("导入结果", `
      <section class="card">
        <h2>教学班导入失败</h2>
        <p>处理时间：${escapeHtml(report.createdAt)}</p>
        <p class="bad">本次导入发现以下问题：</p>
        <ul>${errorItems}</ul>
        <div class="actions">
          <a class="button-link secondary" href="/course/classes">返回教学班管理</a>
          <a class="button-link secondary" href="/course/classes/import/template">下载导入模板</a>
        </div>
      </section>
    `, user, notice));
    return;
  }
  const rows = report.details.map((item) => `<tr>
    <td>${escapeHtml(item.action)}</td>
    <td>${escapeHtml(item.classCode)}</td>
    <td>${escapeHtml(item.courseName)}</td>
    <td>${escapeHtml(item.className)}</td>
    <td>${escapeHtml(item.teacherName)}</td>
    <td>${item.scheduleCount}</td>
  </tr>`).join("");
  sendHtml(res, pageLayout("导入结果", `
    <section class="card">
      <h2>导入完成</h2>
      <p>导入时间：${escapeHtml(report.createdAt)}</p>
      <p>新增教学班：<strong>${report.createdCount}</strong> 个，更新教学班：<strong>${report.updatedCount}</strong> 个。</p>
      <div class="actions">
        <a class="button-link secondary" href="/course/classes">返回教学班管理</a>
        <a class="button-link secondary" href="/course/classes/import/template">下载导入模板</a>
      </div>
    </section>
    <section class="card">
      <h3>导入明细</h3>
      <table><tr><th>动作</th><th>ClassCode</th><th>课程名</th><th>教学班</th><th>教授</th><th>排课数</th></tr>${rows}</table>
    </section>
  `, user, notice));
}

function usersImportResultPage(res, user, reportId, notice) {
  const report = importReports.get(reportId);
  if (!report) {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageLayout("未找到", '<section class="card">导入结果不存在或已过期。</section>', user, notice));
    return;
  }
  if (report.status === "failed") {
    const errorItems = (report.errors || [report.errorMessage || "未知错误"])
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("");
    sendHtml(res, pageLayout("人员导入结果", `
      <section class="card">
        <h2>人员导入失败</h2>
        <p>处理时间：${escapeHtml(report.createdAt)}</p>
        <p class="bad">本次导入发现以下问题：</p>
        <ul>${errorItems}</ul>
        <div class="actions">
          <a class="button-link secondary" href="/course/users">返回人员管理</a>
          <a class="button-link secondary" href="/course/users/import/template">下载导入模板</a>
        </div>
      </section>
    `, user, notice));
    return;
  }
  const rows = report.details.map((item) => `<tr>
    <td>${escapeHtml(item.action)}</td>
    <td>${escapeHtml(item.loginName)}</td>
    <td>${escapeHtml(item.userName)}</td>
    <td>${escapeHtml(item.role)}</td>
    <td>${escapeHtml(item.email)}</td>
  </tr>`).join("");
  sendHtml(res, pageLayout("人员导入结果", `
    <section class="card">
      <h2>人员导入完成</h2>
      <p>导入时间：${escapeHtml(report.createdAt)}</p>
      <p>新增人员：<strong>${report.createdCount}</strong> 个，更新人员：<strong>${report.updatedCount}</strong> 个。</p>
      <div class="actions">
        <a class="button-link secondary" href="/course/users">返回人员管理</a>
        <a class="button-link secondary" href="/course/users/import/template">下载导入模板</a>
      </div>
    </section>
    <section class="card">
      <h3>导入明细</h3>
      <table><tr><th>动作</th><th>登录名</th><th>姓名</th><th>角色</th><th>邮箱</th></tr>${rows}</table>
    </section>
  `, user, notice));
}

function taAdminAllClassesPage(res, user, notice, professorFilter, classNameFilter) {
  const db = getDb();
  let rowsRaw = db.prepare(`
    select c.*,
      (select count(*) from applications a where a.class_id = c.class_id) as application_count,
      (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingTAAdmin') as pending_taadmin_count,
      (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count
    from classes c
    order by c.semester, c.course_name, c.class_name
  `).all();
  for (const row of rowsRaw) {
    if (isClassCapacityReached(row, row.approved_count) && row.ta_applications_allowed !== "N") {
      db.prepare("update classes set ta_applications_allowed = 'N' where class_id = ?").run(row.class_id);
      row.ta_applications_allowed = "N";
    }
  }
  const professors = db.prepare("select user_id, email from users where role = 'Professor'").all();
  const professorEmailMap = new Map(professors.map((row) => [row.user_id, row.email]));
  const rows = rowsRaw.filter((row) => {
    const matchesProfessor = !professorFilter || String(row.teacher_name || "").toLowerCase().includes(professorFilter.toLowerCase());
    const matchesClassName = !classNameFilter || String(row.class_name || "").toLowerCase().includes(classNameFilter.toLowerCase());
    return matchesProfessor && matchesClassName;
  }).map((row) => ({
    ...row,
    professor_emails: normalizeTeacherUserIds(row.teacher_user_id).map((id) => professorEmailMap.get(id)).filter(Boolean).join(",")
  }));
  const schedulesByClass = new Map();
  const allSchedules = db.prepare(`
    select class_id, lesson_date, start_time, end_time, section, is_exam
    from class_schedules
    order by lesson_date, start_time
  `).all();
  for (const schedule of allSchedules) {
    if (!schedulesByClass.has(schedule.class_id)) {
      schedulesByClass.set(schedule.class_id, []);
    }
    schedulesByClass.get(schedule.class_id).push(schedule);
  }
  db.close();
  const tableRows = rows.map((row) => {
    const scheduleRows = schedulesByClass.get(row.class_id) || [];
    const isFull = isClassCapacityReached(row, row.approved_count);
    return `<tr class="${isFull ? "row-soft-purple" : ""}">
      <td><input type="checkbox" class="ta-class-select" value="${row.class_id}" /></td>
      <td>${escapeHtml(row.class_code)}</td>
      <td>${escapeHtml(row.class_abbr || "")}</td>
      <td>${escapeHtml(row.course_name)}</td>
      <td>${escapeHtml(row.class_name)}</td>
      <td>${escapeHtml(row.teacher_name)}</td>
      <td>${escapeHtml(row.semester)}</td>
      <td>${applyWindowText(row)}</td>
      <td>${scheduleRows.length}</td>
      <td>${scheduleSummary(scheduleRows, `taadmin-${row.class_id}`)}</td>
      <td>${row.approved_count} / ${row.maximum_number_of_tas_admitted}</td>
      <td>${row.application_count}</td>
      <td>${row.pending_taadmin_count}</td>
      <td>${escapeHtml(row.ta_applications_allowed)}</td>
      <td>${escapeHtml(row.is_conflict_allowed || "N")}</td>
      <td><a class="button-link secondary rect" href="/admin/ta/classes/${row.class_id}/applications">查看并审核</a></td>
    </tr>`;
  }).join("");
  sendHtml(res, pageLayout("全部教学班", `
    <section class="card">
      <h2>筛选教学班</h2>
      <form method="get" action="/admin/ta/classes">
        <div class="grid">
          <p><label>教授名<input name="professor_name" value="${escapeHtml(professorFilter || "")}" /></label></p>
          <p><label>教学班名称<input name="class_name" value="${escapeHtml(classNameFilter || "")}" /></label></p>
        </div>
        <div class="actions">
          <button type="submit">筛选</button>
          <a class="button-link secondary rect" href="/admin/ta/classes">重置</a>
        </div>
      </form>
    </section>
    <section class="card">
      <h2>邮件提醒 Professor</h2>
      <form method="post" action="/admin/ta/classes/email-preview" onsubmit="return submitSelectedTaClasses(this);">
        <input type="hidden" name="class_refs" />
        <p class="muted">勾选一个或多个教学班后，生成发给 Professor 的邮件预览。邮件正文会列出所选教学班。</p>
        <button type="submit">生成邮件</button>
      </form>
    </section>
    <section class="card">
      <h2>全部教学班与排课安排</h2>
      <div class="actions" style="margin-bottom:12px;">
        <label><input type="checkbox" id="select-all-ta-classes" /> 全选当前列表</label>
        <span class="muted">已选 <strong id="selected-ta-class-count">0</strong> 个教学班</span>
      </div>
      <table><tr><th>选择</th><th>代码</th><th>缩写</th><th>课程名</th><th>教学班</th><th>教授</th><th>学期</th><th>开放时间</th><th>排课数</th><th>排课明细</th><th>已通过/上限</th><th>申请数</th><th>待TAAdmin审批申请数</th><th>开放申请</th><th>允许冲突</th><th>操作</th></tr>${tableRows}</table>
    </section>
    <script>
      (() => {
        const checkboxes = Array.from(document.querySelectorAll('.ta-class-select'));
        const selectAll = document.getElementById('select-all-ta-classes');
        const countNode = document.getElementById('selected-ta-class-count');
        const refreshSelectedState = () => {
          const checked = checkboxes.filter((item) => item.checked);
          countNode.textContent = String(checked.length);
          if (selectAll) {
            selectAll.checked = checked.length > 0 && checked.length === checkboxes.length;
            selectAll.indeterminate = checked.length > 0 && checked.length < checkboxes.length;
          }
        };
        if (selectAll) {
          selectAll.addEventListener('change', () => {
            checkboxes.forEach((item) => { item.checked = selectAll.checked; });
            refreshSelectedState();
          });
        }
        checkboxes.forEach((item) => item.addEventListener('change', refreshSelectedState));
        window.submitSelectedTaClasses = (form) => {
          const selected = checkboxes.filter((item) => item.checked).map((item) => item.value);
          if (!selected.length) {
            window.alert('请先勾选至少一个教学班');
            return false;
          }
          form.querySelector('input[name="class_refs"]').value = selected.join(',');
          return true;
        };
        refreshSelectedState();
      })();
    </script>
  `, user, notice));
}

async function taAdminProfessorEmailPreview(req, res, user, notice) {
  const body = await readBody(req);
  const refs = parseBatchClassRefs(body.class_refs);
  if (!refs.length) {
    return redirect(res, "/admin/ta/classes?notice=请先勾选至少一个教学班");
  }
  const db = getDb();
  const selectedClasses = loadClassRowsByRefs(db, refs);
  if (!selectedClasses.length) {
    db.close();
    return redirect(res, "/admin/ta/classes?notice=未匹配到任何教学班");
  }
  const classRows = selectedClasses.map((row) => `<tr><td>${escapeHtml(row.class_code)}</td><td>${escapeHtml(row.course_name)}</td><td>${escapeHtml(row.class_name)}</td><td>${escapeHtml(row.teacher_name)}</td></tr>`).join("");
  const grouped = new Map();
  const findProfessor = db.prepare("select user_id, user_name, email from users where user_id = ? and role = 'Professor'");
  for (const classRow of selectedClasses) {
    for (const professorId of normalizeTeacherUserIds(classRow.teacher_user_id)) {
      const professor = findProfessor.get(professorId);
      if (!professor || !professor.email) continue;
      if (!grouped.has(professor.user_id)) {
        grouped.set(professor.user_id, { professor, classes: [] });
      }
      grouped.get(professor.user_id).classes.push(classRow);
    }
  }
  const baseUrl = `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
  const draftCards = Array.from(grouped.values()).map(({ professor, classes }) => {
    const token = createLoginToken(db, professor.user_id, "/professor/pending");
    const accessLink = `${baseUrl}/magic-login?token=${token}`;
    const emailDraft = buildProfessorEmailDraft(professor, classes, accessLink);
    const mailtoHref = `mailto:${professor.email}?subject=${encodeURIComponent(emailDraft.subject)}&body=${encodeURIComponent(emailDraft.body)}`;
    return `
      <section class="card">
        <h3>${escapeHtml(professor.user_name)}</h3>
        <p>收件人：${escapeHtml(emailDraft.to)}</p>
        <p>主题：${escapeHtml(emailDraft.subject)}</p>
        <p><a class="button-link rect" href="${mailtoHref}">打开邮件客户端发送</a></p>
        <pre style="white-space:pre-wrap;">${escapeHtml(emailDraft.body)}</pre>
      </section>
    `;
  }).join("");
  db.close();
  sendHtml(res, pageLayout("邮件预览", `
    <section class="card">
      <h2>Professor 邮件预览</h2>
      <p class="muted">系统会按教授分别生成专属邮件和免登录审核链接。请勿转发邮件内容和链接。</p>
    </section>
    ${draftCards || `<section class="card"><p class="muted">所选教学班未匹配到可用的 Professor 邮箱。</p></section>`}
    <section class="card">
      <h3>本次邮件包含的教学班</h3>
      <table><tr><th>代码</th><th>课程名</th><th>教学班</th><th>教授</th></tr>${classRows}</table>
    </section>
  `, user, notice));
}

function taAdminClassApplicationsPage(res, user, classId, notice) {
  const db = getDb();
  const classRow = db.prepare("select * from classes where class_id = ?").get(classId);
  if (!classRow) {
    db.close();
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageLayout("未找到", '<section class="card">教学班不存在。</section>', user, notice));
    return;
  }
  const apps = db.prepare(`
    select *
    from applications
    where class_id = ?
    order by submitted_at desc
  `).all(classId);
  const rows = apps.map((app) => `<tr>
    <td>${app.application_id}</td>
    <td>${escapeHtml(app.applier_name)}</td>
    <td>${escapeHtml(app.submitted_at)}</td>
    <td>${escapeHtml(statusLabels[app.status] || app.status)}</td>
    <td>${escapeHtml(app.application_reason)}</td>
    <td>${(() => {
      const conflicts = getAppliedConflicts(db, app.applier_user_id, classId);
      if (!conflicts.length) {
        return "<span class='muted'>无冲突</span>";
      }
      return conflicts.map(({ app: conflictApp, matches }) => `${escapeHtml(conflictApp.class_name)}（${escapeHtml(statusLabels[conflictApp.status] || conflictApp.status)} / 允许冲突:${escapeHtml(conflictApp.is_conflict_allowed || "N")}）<br>${matches.map(escapeHtml).join("<br>")}`).join("<br><br>");
    })()}</td>
    <td>${attachmentLink(app)}</td>
    <td>${escapeHtml(app.ta_comment || "")}</td>
    <td class="actions">${app.status === "PendingTAAdmin" ? `<a class="button-link secondary" href="/admin/ta/pending/${app.application_id}">单独审批</a>` : ""}</td>
  </tr>`).join("");
  db.close();
  const pendingCount = apps.filter((app) => app.status === "PendingTAAdmin").length;
  sendHtml(res, pageLayout("教学班申请审批", `
    <section class="card">
      <h2>${escapeHtml(classRow.course_name)} / ${escapeHtml(classRow.class_name)}</h2>
      <p class="muted">教学班代码：${escapeHtml(classRow.class_code)} | 当前待审批申请：${pendingCount}</p>
    </section>
    <section class="card">
      <h3>批量审批</h3>
      <form method="post" action="/admin/ta/classes/${classId}/applications/approve">
        <p><label>审批结果
          <select name="result">
            <option value="Approved">全部通过</option>
            <option value="Rejected">全部拒绝</option>
          </select>
        </label></p>
        <p><label>审批备注<textarea name="comments"></textarea></label></p>
        <button type="submit">执行批量审批</button>
      </form>
    </section>
    <section class="card">
      <h3>关联申请列表</h3>
      <table><tr><th>ID</th><th>申请人</th><th>申请时间</th><th>状态</th><th>申请原因</th><th>冲突教学班摘要</th><th>简历</th><th>TAAdmin 备注</th><th>操作</th></tr>${rows}</table>
    </section>
  `, user, notice));
}

async function taAdminBatchApproveByClass(req, res, user, classId) {
  const body = await readBody(req);
  const result = String(body.result || "Rejected");
  const comments = String(body.comments || "").trim();
  const db = getDb();
  const apps = db.prepare(`
    select *
    from applications
    where class_id = ?
      and status = 'PendingTAAdmin'
    order by submitted_at, application_id
  `).all(classId);
  if (!apps.length) {
    db.close();
    return redirect(res, `/admin/ta/classes/${classId}/applications?notice=当前教学班没有待审批申请`);
  }
  try {
    for (const app of apps) {
      applyTaAdminDecision(db, user, app, result, comments);
    }
  } catch (error) {
    db.close();
    return redirect(res, `/admin/ta/classes/${classId}/applications?notice=${error.message}`);
  }
  db.close();
  redirect(res, `/admin/ta/classes/${classId}/applications?notice=批量审批已完成`);
}

function courseClassDetailPage(res, user, classId, notice) {
  const db = getDb();
  const row = db.prepare("select * from classes where class_id = ?").get(classId);
  if (!row) {
    db.close();
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageLayout("未找到", '<section class="card">教学班不存在。</section>', user, notice));
    return;
  }
  const schedules = db.prepare(`
    select lesson_date, start_time, end_time, section, is_exam
    from class_schedules
    where class_id = ?
    order by lesson_date, start_time
  `).all(classId);
  const applicationCount = db.prepare("select count(*) as count from applications where class_id = ?").get(classId).count;
  const approvedCount = db.prepare("select count(*) as count from applications where class_id = ? and status = 'Approved'").get(classId).count;
  db.close();
  sendHtml(res, pageLayout("编辑教学班", `
    <section class="card">
      <h2>编辑教学班</h2>
      <p class="muted">申请数：${applicationCount}，已通过：${approvedCount} / ${row.maximum_number_of_tas_admitted}</p>
      <div class="actions">
        <a class="button-link secondary" href="/course/classes">返回教学班列表</a>
        <a class="button-link secondary" href="/course/classes/${classId}/applications">查看关联申请</a>
        <a class="button-link danger" href="/course/classes/${classId}/delete">删除教学班</a>
      </div>
      <form method="post" action="/course/classes/${classId}/update">
        <div class="grid">
          <p><label>ClassCode<input name="class_code" value="${escapeHtml(row.class_code)}" required /></label></p>
          <p><label>教学班缩写<input name="class_abbr" value="${escapeHtml(row.class_abbr || row.class_code)}" required /></label></p>
          <p><label>课程名<input name="course_name" value="${escapeHtml(row.course_name)}" required /></label></p>
          <p><label>教学班名称<input name="class_name" value="${escapeHtml(row.class_name)}" required /></label></p>
          <p><label>授课语言<select name="teaching_language"><option value="中文" ${row.teaching_language === "中文" ? "selected" : ""}>中文</option><option value="英文" ${row.teaching_language === "英文" ? "selected" : ""}>英文</option></select></label></p>
          <p><label>Professor（可多选）<select name="teacher_user_id" multiple size="4">${professorMultiOptions(row.teacher_user_id)}</select></label></p>
          <p><label>学期<input name="semester" value="${escapeHtml(row.semester)}" required /></label></p>
          <p><label>最大录取人数<input name="maximum_number" type="number" value="${row.maximum_number_of_tas_admitted}" min="1" required /></label></p>
          <p><label>允许 TA 申请<select name="ta_allowed"><option value="Y" ${row.ta_applications_allowed === "Y" ? "selected" : ""}>Y</option><option value="N" ${row.ta_applications_allowed === "N" ? "selected" : ""}>N</option></select></label></p>
          <p><label>允许冲突申请<select name="is_conflict_allowed"><option value="N" ${row.is_conflict_allowed === "N" ? "selected" : ""}>N</option><option value="Y" ${row.is_conflict_allowed === "Y" ? "selected" : ""}>Y</option></select></label></p>
          <p><label>开放开始时间<input name="apply_start_at" type="datetime-local" value="${escapeHtml(datetimeValueForInput(row.apply_start_at))}" required /></label></p>
          <p><label>开放结束时间<input name="apply_end_at" type="datetime-local" value="${escapeHtml(datetimeValueForInput(row.apply_end_at))}" required /></label></p>
        </div>
        <p><label>课程介绍<textarea name="class_intro">${escapeHtml(row.class_intro || "")}</textarea></label></p>
        <p><label>备注<textarea name="memo">${escapeHtml(row.memo || "")}</textarea></label></p>
        <p><label>排课记录<textarea name="schedule_lines" required>${escapeHtml(scheduleLinesValue(schedules))}</textarea></label></p>
        <p class="muted">一行一条排课，格式：YYYY-MM-DD,HH:MM,HH:MM,节次[,考试类型]。</p>
        <button type="submit">保存教学班</button>
      </form>
    </section>
    <section class="card">
      <h3>当前排课预览</h3>
      ${schedulesTable(schedules)}
    </section>
  `, user, notice));
}

function courseClassApplicationsPage(res, user, classId, notice) {
  const db = getDb();
  const classRow = db.prepare("select * from classes where class_id = ?").get(classId);
  if (!classRow) {
    db.close();
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageLayout("未找到", '<section class="card">教学班不存在。</section>', user, notice));
    return;
  }
  const apps = db.prepare(`
    select *
    from applications
    where class_id = ?
    order by submitted_at desc
  `).all(classId);
  db.close();
  const rows = apps.map((app) => `<tr>
    <td>${app.application_id}</td>
    <td>${escapeHtml(app.applier_name)}</td>
    <td>${escapeHtml(app.submitted_at)}</td>
    <td>${escapeHtml(statusLabels[app.status] || app.status)}</td>
    <td>${escapeHtml(app.application_reason)}</td>
    <td>${attachmentLink(app)}</td>
    <td>${escapeHtml(app.ta_comment || "")}</td>
    <td>${escapeHtml(app.prof_comment || "")}</td>
  </tr>`).join("");
  sendHtml(res, pageLayout("关联申请", `
    <section class="card">
      <h2>${escapeHtml(classRow.course_name)} / ${escapeHtml(classRow.class_name)}</h2>
      <p class="muted">教学班代码：${escapeHtml(classRow.class_code)} | 教授：${escapeHtml(classRow.teacher_name)}</p>
    </section>
    <section class="card">
      <h3>关联申请列表</h3>
      <table><tr><th>ID</th><th>申请人</th><th>申请时间</th><th>状态</th><th>申请原因</th><th>简历</th><th>TAAdmin 备注</th><th>Professor 备注</th></tr>${rows}</table>
    </section>
  `, user, notice));
}

function courseClassDeleteConfirmPage(res, user, classId, notice) {
  const db = getDb();
  const classRow = db.prepare("select * from classes where class_id = ?").get(classId);
  if (!classRow) {
    db.close();
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageLayout("未找到", '<section class="card">教学班不存在。</section>', user, notice));
    return;
  }
  const impact = classDeleteImpact(db, classId);
  db.close();
  sendHtml(res, pageLayout("确认删除教学班", `
    <section class="card">
      <h2>确认删除教学班</h2>
      <p>课程：${escapeHtml(classRow.course_name)} / ${escapeHtml(classRow.class_name)}</p>
      <p>教学班代码：${escapeHtml(classRow.class_code)}</p>
      <p class="bad">删除后将无法恢复。</p>
    </section>
    <section class="card">
      <h3>将被删除的数据</h3>
      <table>
        <tr><th>数据类型</th><th>数量</th></tr>
        <tr><td>教学班排课记录</td><td>${impact.scheduleCount}</td></tr>
        <tr><td>TA 申请记录</td><td>${impact.applicationCount}</td></tr>
        <tr><td>审批日志记录</td><td>${impact.approvalCount}</td></tr>
      </table>
    </section>
    <section class="card">
      <div class="actions">
        <a class="button-link" href="/course/classes/${classId}">取消</a>
        <form class="inline" method="post" action="/course/classes/${classId}/delete/confirm">
          <button class="secondary" type="submit">确认删除</button>
        </form>
      </div>
    </section>
  `, user, notice));
}

async function batchDeleteClassesConfirmPage(req, res, user, notice) {
  const body = await readBody(req);
  const refs = parseBatchClassRefs(body.class_refs);
  if (!refs.length) {
    return redirect(res, "/course/classes?notice=请先勾选至少一个教学班");
  }
  const db = getDb();
  const classRows = loadClassRowsByRefs(db, refs);
  if (!classRows.length) {
    db.close();
    return redirect(res, "/course/classes?notice=未匹配到任何教学班");
  }
  const items = classRows.map((row) => ({ ...row, impact: classDeleteImpact(db, row.class_id) }));
  const totals = items.reduce((acc, item) => {
    acc.scheduleCount += item.impact.scheduleCount;
    acc.applicationCount += item.impact.applicationCount;
    acc.approvalCount += item.impact.approvalCount;
    return acc;
  }, { scheduleCount: 0, applicationCount: 0, approvalCount: 0 });
  db.close();
  const hiddenRefs = classRows.map((row) => row.class_id).join(",");
  const itemRows = items.map((item) => `<tr>
    <td>${escapeHtml(item.class_code)}</td>
    <td>${escapeHtml(item.course_name)}</td>
    <td>${escapeHtml(item.class_name)}</td>
    <td>${escapeHtml(item.teacher_name)}</td>
    <td>${item.impact.scheduleCount}</td>
    <td>${item.impact.applicationCount}</td>
    <td>${item.impact.approvalCount}</td>
  </tr>`).join("");
  sendHtml(res, pageLayout("确认批量删除教学班", `
    <section class="card">
      <h2>确认批量删除教学班</h2>
      <p>本次将删除 <strong>${items.length}</strong> 个教学班。</p>
      <p class="bad">删除后将无法恢复，且会联动删除对应排课、申请、审批记录和已上传附件。</p>
    </section>
    <section class="card">
      <h3>本次删除明细</h3>
      <div class="table-wrap">
        <table><tr><th>代码</th><th>课程名</th><th>教学班</th><th>教授</th><th>排课</th><th>申请</th><th>审批日志</th></tr>${itemRows}</table>
      </div>
    </section>
    <section class="card">
      <h3>汇总影响</h3>
      <table>
        <tr><th>数据类型</th><th>数量</th></tr>
        <tr><td>教学班数量</td><td>${items.length}</td></tr>
        <tr><td>教学班排课记录</td><td>${totals.scheduleCount}</td></tr>
        <tr><td>TA 申请记录</td><td>${totals.applicationCount}</td></tr>
        <tr><td>审批日志记录</td><td>${totals.approvalCount}</td></tr>
      </table>
    </section>
    <section class="card">
      <div class="actions">
        <a class="button-link" href="/course/classes">取消</a>
        <form class="inline" method="post" action="/course/classes/batch-delete/confirm">
          <input type="hidden" name="class_refs" value="${escapeHtml(hiddenRefs)}" />
          <button class="secondary" type="submit">确认批量删除</button>
        </form>
      </div>
    </section>
  `, user, notice));
}

function courseUsersPage(res, user, notice) {
  const db = getDb();
  const users = db.prepare(`
    select u.*,
      (select count(*) from applications a where a.applier_user_id = u.user_id) as application_count,
      (select count(*) from classes c where (',' || c.teacher_user_id || ',') like '%,' || u.user_id || ',%') as class_count
    from users u
    order by
      case u.role
        when 'CourseAdmin' then 1
        when 'TAAdmin' then 2
        when 'Professor' then 3
        when 'TA' then 4
        else 9
      end,
      u.user_name
  `).all();
  db.close();
  const rows = users.map((row) => `<tr>
    <td>${row.user_id}</td>
    <td>${escapeHtml(row.user_name)}</td>
    <td>${escapeHtml(row.login_name)}</td>
    <td>${escapeHtml(row.email)}</td>
    <td>${escapeHtml(row.role)}</td>
    <td>${escapeHtml(row.is_allowed_to_apply)}</td>
    <td>${row.application_count}</td>
    <td>${row.class_count}</td>
    <td>
      <div class="actions">
        <a class="button-link secondary" href="/course/users/${row.user_id}">编辑人员</a>
        <form class="inline" method="post" action="/course/users/${row.user_id}/delete">
          <button class="danger" type="submit">删除人员</button>
        </form>
      </div>
    </td>
  </tr>`).join("");
  sendHtml(res, pageLayout("人员管理", `
    <section class="card">
      <h2>导入人员</h2>
      <form method="post" action="/course/users/import" enctype="multipart/form-data">
        <p><label>导入文件<input name="users_file" type="file" accept=".xlsx,.xls,.csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" required /></label></p>
        <div class="actions">
          <button type="submit">导入 Excel</button>
          <a class="button-link secondary" href="/course/users/import/template">下载模板</a>
        </div>
      </form>
      <p class="muted">按登录名 login_name 判断是否覆盖。支持 xlsx、xls、csv。推荐使用模板填写后直接导入。</p>
      <div class="field-order">
        字段顺序：<br>
        login_name, user_name, email, password, role, is_allowed_to_apply
      </div>
    </section>
    <section class="card">
      <h2>新增人员</h2>
      <form method="post" action="/course/users/create">
        <div class="grid">
          <p><label>姓名<input name="user_name" required /></label></p>
          <p><label>登录名<input name="login_name" required /></label></p>
          <p><label>邮箱<input name="email" required /></label></p>
          <p><label>密码<input name="password" value="123456" required /></label></p>
          <p><label>角色<select name="role">${roleOptions("TA")}</select></label></p>
          <p><label>允许 TA 申请<select name="is_allowed_to_apply">${taAllowedOptions("N")}</select></label></p>
        </div>
        <button type="submit">创建人员</button>
      </form>
    </section>
    <section class="card">
      <h2>人员列表</h2>
      <table>
        <tr><th>ID</th><th>姓名</th><th>登录名</th><th>邮箱</th><th>角色</th><th>允许申请</th><th>申请数</th><th>授课班级</th><th>操作</th></tr>
        ${rows}
      </table>
    </section>
  `, user, notice));
}

function courseUserDetailPage(res, user, userId, notice) {
  const db = getDb();
  const target = db.prepare("select * from users where user_id = ?").get(userId);
  if (!target) {
    db.close();
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageLayout("未找到", '<section class="card">人员不存在。</section>', user, notice));
    return;
  }
  const classes = db.prepare("select class_code, class_name from classes where (',' || teacher_user_id || ',') like '%,' || ? || ',%' order by class_name").all(userId);
  const applications = db.prepare("select application_id, class_name, status from applications where applier_user_id = ? order by application_id desc").all(userId);
  db.close();
  const classList = classes.length
    ? `<ul>${classes.map((row) => `<li>${escapeHtml(row.class_code)} / ${escapeHtml(row.class_name)}</li>`).join("")}</ul>`
    : "<p class='muted'>当前没有授课教学班。</p>";
  const appList = applications.length
    ? `<table><tr><th>申请ID</th><th>教学班</th><th>状态</th></tr>${applications.map((row) => `<tr><td>${row.application_id}</td><td>${escapeHtml(row.class_name)}</td><td>${escapeHtml(statusLabels[row.status] || row.status)}</td></tr>`).join("")}</table>`
    : "<p class='muted'>当前没有申请记录。</p>";
  sendHtml(res, pageLayout("编辑人员", `
    <section class="card">
      <h2>编辑人员</h2>
      <form method="post" action="/course/users/${userId}/update">
        <div class="grid">
          <p><label>姓名<input name="user_name" value="${escapeHtml(target.user_name)}" required /></label></p>
          <p><label>登录名<input name="login_name" value="${escapeHtml(target.login_name)}" required /></label></p>
          <p><label>邮箱<input name="email" value="${escapeHtml(target.email)}" required /></label></p>
          <p><label>密码<input name="password" value="${escapeHtml(target.password)}" required /></label></p>
          <p><label>角色<select name="role">${roleOptions(target.role)}</select></label></p>
          <p><label>允许 TA 申请<select name="is_allowed_to_apply">${taAllowedOptions(target.is_allowed_to_apply)}</select></label></p>
        </div>
        <button type="submit">保存修改</button>
      </form>
    </section>
    <section class="card">
      <h3>授课教学班</h3>
      ${classList}
    </section>
    <section class="card">
      <h3>申请记录</h3>
      ${appList}
    </section>
  `, user, notice));
}

async function createCourseUser(req, res) {
  const body = await readBody(req);
  const role = String(body.role || "TA");
  const isAllowed = role === "TA" ? String(body.is_allowed_to_apply || "N") : "N";
  const db = getDb();
  try {
    db.prepare(`
      insert into users (user_name, login_name, email, password, role, is_allowed_to_apply)
      values (?, ?, ?, ?, ?, ?)
    `).run(
      String(body.user_name || "").trim(),
      String(body.login_name || "").trim(),
      String(body.email || "").trim(),
      String(body.password || "123456").trim(),
      role,
      isAllowed
    );
  } catch (error) {
    db.close();
    return redirect(res, "/course/users?notice=创建失败，登录名可能已存在");
  }
  db.close();
  redirect(res, "/course/users?notice=人员已创建");
}

async function importCourseUsers(req, res) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.startsWith("multipart/form-data")) {
    return redirect(res, "/course/users?notice=请通过文件上传导入");
  }
  let files = {};
  try {
    const rawBody = await readRawBody(req);
    ({ files } = parseMultipart(rawBody, contentType));
  } catch (error) {
    return redirect(res, `/course/users?notice=${error.message}`);
  }
  const file = files.users_file;
  if (!file || !file.filename) {
    return redirect(res, "/course/users?notice=请先选择导入文件");
  }
  const extension = path.extname(file.filename).toLowerCase();
  if (![".xlsx", ".xls", ".csv"].includes(extension)) {
    return redirect(res, "/course/users?notice=当前仅支持 xlsx、xls、csv 文件");
  }
  let importedUsers;
  try {
    importedUsers = parseImportedUsersWorkbook(file);
  } catch (error) {
    const reportId = saveImportReport({
      status: "failed",
      errorMessage: error.message,
      errors: error.importErrors || [error.message]
    });
    return redirect(res, `/course/users/import/result/${reportId}?notice=导入失败`);
  }
  const db = getDb();
  try {
    const result = upsertImportedUsers(db, importedUsers);
    db.close();
    const reportId = saveImportReport({
      status: "success",
      ...result
    });
    return redirect(res, `/course/users/import/result/${reportId}?notice=导入完成`);
  } catch (error) {
    db.close();
    const reportId = saveImportReport({
      status: "failed",
      errorMessage: error.message,
      errors: error.importErrors || [error.message]
    });
    return redirect(res, `/course/users/import/result/${reportId}?notice=导入失败`);
  }
}

async function updateCourseUser(req, res, userId) {
  const body = await readBody(req);
  const role = String(body.role || "TA");
  const isAllowed = role === "TA" ? String(body.is_allowed_to_apply || "N") : "N";
  const db = getDb();
  const target = db.prepare("select * from users where user_id = ?").get(userId);
  if (!target) {
    db.close();
    return redirect(res, "/course/users?notice=人员不存在");
  }
  const teachesClasses = db.prepare("select count(*) as count from classes where (',' || teacher_user_id || ',') like '%,' || ? || ',%'").get(userId).count;
  if (teachesClasses > 0 && role !== "Professor") {
    db.close();
    return redirect(res, `/course/users/${userId}?notice=该用户已关联教学班，不能改为非 Professor`);
  }
  try {
    db.prepare(`
      update users
      set user_name = ?, login_name = ?, email = ?, password = ?, role = ?, is_allowed_to_apply = ?
      where user_id = ?
    `).run(
      String(body.user_name || "").trim(),
      String(body.login_name || "").trim(),
      String(body.email || "").trim(),
      String(body.password || "123456").trim(),
      role,
      isAllowed,
      userId
    );
    if (role === "Professor") {
      const classes = db.prepare("select class_id, teacher_user_id from classes where (',' || teacher_user_id || ',') like '%,' || ? || ',%'").all(userId);
      const findProfessor = db.prepare("select user_id, user_name from users where user_id = ? and role = 'Professor'");
      for (const row of classes) {
        const ids = normalizeTeacherUserIds(row.teacher_user_id);
        const names = ids.map((id) => findProfessor.get(id)?.user_name).filter(Boolean).join(" / ");
        db.prepare("update classes set teacher_name = ? where class_id = ?").run(names, row.class_id);
      }
    }
  } catch (error) {
    db.close();
    return redirect(res, `/course/users/${userId}?notice=更新失败，登录名可能已存在`);
  }
  db.close();
  redirect(res, `/course/users/${userId}?notice=人员信息已更新`);
}

function deleteCourseUser(res, userId) {
  const db = getDb();
  const target = db.prepare("select * from users where user_id = ?").get(userId);
  if (!target) {
    db.close();
    return redirect(res, "/course/users?notice=人员不存在");
  }
  const applicationCount = db.prepare("select count(*) as count from applications where applier_user_id = ? or (',' || teacher_user_id || ',') like '%,' || ? || ',%'").get(userId, userId).count;
  const classCount = db.prepare("select count(*) as count from classes where (',' || teacher_user_id || ',') like '%,' || ? || ',%'").get(userId).count;
  const approvalCount = db.prepare("select count(*) as count from approval_logs where approver_user_id = ?").get(userId).count;
  if (applicationCount > 0 || classCount > 0 || approvalCount > 0) {
    db.close();
    return redirect(res, "/course/users?notice=该用户已有关联业务数据，当前不允许删除");
  }
  db.prepare("delete from users where user_id = ?").run(userId);
  db.close();
  redirect(res, "/course/users?notice=人员已删除");
}

async function createClass(req, res) {
  const body = await readBody(req);
  const maximumNumber = Number(body.maximum_number || 1);
  const isConflictAllowed = String(body.is_conflict_allowed || "N");
  let applyStartAt;
  let applyEndAt;
  const db = getDb();
  if (!["Y", "N"].includes(isConflictAllowed)) {
    db.close();
    return redirect(res, "/course/classes?notice=允许冲突申请取值不合法");
  }
  let professorSelection;
  try {
    professorSelection = resolveProfessorSelection(db, body.teacher_user_id);
  } catch (error) {
    db.close();
    return redirect(res, `/course/classes?notice=${error.message}`);
  }
  try {
    applyStartAt = normalizeDateTimeInput(body.apply_start_at);
    applyEndAt = normalizeDateTimeInput(body.apply_end_at);
    validateApplyWindow(applyStartAt, applyEndAt);
  } catch (error) {
    db.close();
    return redirect(res, `/course/classes?notice=${error.message}`);
  }
  let scheduleRows;
  try {
    scheduleRows = parseScheduleLines(body.schedule_lines);
  } catch (error) {
    db.close();
    return redirect(res, `/course/classes?notice=${error.message}`);
  }
  try {
    const result = db.prepare(`
      insert into classes (
        class_code, class_abbr, class_name, course_name, teaching_language, teacher_user_id,
        teacher_name, class_intro, memo, maximum_number_of_tas_admitted,
        ta_applications_allowed, is_conflict_allowed, apply_start_at, apply_end_at, semester
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(body.class_code || "").trim(),
      String(body.class_abbr || body.class_code || "").trim(),
      String(body.class_name || "").trim(),
      String(body.course_name || "").trim(),
      String(body.teaching_language || "中文"),
      professorSelection.idText,
      professorSelection.nameText,
      String(body.class_intro || "").trim(),
      String(body.memo || "").trim(),
      maximumNumber,
      String(body.ta_allowed || "Y"),
      isConflictAllowed,
      applyStartAt,
      applyEndAt,
      String(body.semester || "").trim()
    );
    const insertSchedule = db.prepare(`
      insert into class_schedules (class_id, lesson_date, start_time, end_time, section, is_exam)
      values (?, ?, ?, ?, ?, ?)
    `);
    for (const schedule of scheduleRows) {
      insertSchedule.run(
        result.lastInsertRowid,
        schedule.lessonDate,
        schedule.startTime,
        schedule.endTime,
        schedule.section,
        schedule.isExam
      );
    }
  } catch (error) {
    db.close();
    return redirect(res, "/course/classes?notice=ClassCode 已存在或字段非法");
  }
  db.close();
  redirect(res, "/course/classes?notice=教学班已创建");
}

async function importClasses(req, res) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.startsWith("multipart/form-data")) {
    return redirect(res, "/course/classes?notice=请通过文件上传导入");
  }
  let fields = {};
  let files = {};
  try {
    const rawBody = await readRawBody(req);
    ({ fields, files } = parseMultipart(rawBody, contentType));
  } catch (error) {
    return redirect(res, `/course/classes?notice=${error.message}`);
  }
  const file = files.classes_file;
  if (!file || !file.filename) {
    return redirect(res, "/course/classes?notice=请先选择导入文件");
  }
  const extension = path.extname(file.filename).toLowerCase();
  if (![".xlsx", ".xls"].includes(extension)) {
    return redirect(res, "/course/classes?notice=当前仅支持导入 Excel 文件");
  }
  let importedClasses;
  try {
    importedClasses = parseImportedClassesWorkbook(file);
  } catch (error) {
    const reportId = saveImportReport({
      status: "failed",
      errorMessage: error.message,
      errors: error.importErrors || [error.message]
    });
    return redirect(res, `/course/classes/import/result/${reportId}?notice=导入失败`);
  }
  const db = getDb();
  try {
    const result = upsertImportedClasses(db, importedClasses);
    db.close();
    const reportId = saveImportReport({
      status: "success",
      ...result
    });
    return redirect(res, `/course/classes/import/result/${reportId}?notice=导入完成`);
  } catch (error) {
    db.close();
    const reportId = saveImportReport({
      status: "failed",
      errorMessage: error.message,
      errors: error.importErrors || [error.message]
    });
    return redirect(res, `/course/classes/import/result/${reportId}?notice=导入失败`);
  }
}

async function updateClass(req, res, classId) {
  const body = await readBody(req);
  const maximumNumber = Number(body.maximum_number || 1);
  const isConflictAllowed = String(body.is_conflict_allowed || "N");
  let applyStartAt;
  let applyEndAt;
  const db = getDb();
  const currentClass = db.prepare("select * from classes where class_id = ?").get(classId);
  if (!currentClass) {
    db.close();
    return redirect(res, "/course/classes?notice=教学班不存在");
  }
  if (!["Y", "N"].includes(isConflictAllowed)) {
    db.close();
    return redirect(res, `/course/classes/${classId}?notice=允许冲突申请取值不合法`);
  }
  let professorSelection;
  try {
    professorSelection = resolveProfessorSelection(db, body.teacher_user_id);
  } catch (error) {
    db.close();
    return redirect(res, `/course/classes/${classId}?notice=${error.message}`);
  }
  try {
    applyStartAt = normalizeDateTimeInput(body.apply_start_at);
    applyEndAt = normalizeDateTimeInput(body.apply_end_at);
    validateApplyWindow(applyStartAt, applyEndAt);
  } catch (error) {
    db.close();
    return redirect(res, `/course/classes/${classId}?notice=${error.message}`);
  }
  let scheduleRows;
  try {
    scheduleRows = parseScheduleLines(body.schedule_lines);
  } catch (error) {
    db.close();
    return redirect(res, `/course/classes/${classId}?notice=${error.message}`);
  }
  try {
    db.prepare(`
      update classes
      set class_code = ?, class_abbr = ?, class_name = ?, course_name = ?, teaching_language = ?, teacher_user_id = ?,
          teacher_name = ?, class_intro = ?, memo = ?, maximum_number_of_tas_admitted = ?, ta_applications_allowed = ?, is_conflict_allowed = ?, apply_start_at = ?, apply_end_at = ?, semester = ?
      where class_id = ?
    `).run(
      String(body.class_code || "").trim(),
      String(body.class_abbr || body.class_code || "").trim(),
      String(body.class_name || "").trim(),
      String(body.course_name || "").trim(),
      String(body.teaching_language || "中文"),
      professorSelection.idText,
      professorSelection.nameText,
      String(body.class_intro || "").trim(),
      String(body.memo || "").trim(),
      maximumNumber,
      String(body.ta_allowed || "Y"),
      isConflictAllowed,
      applyStartAt,
      applyEndAt,
      String(body.semester || "").trim(),
      classId
    );
    db.prepare("delete from class_schedules where class_id = ?").run(classId);
    const insertSchedule = db.prepare(`
      insert into class_schedules (class_id, lesson_date, start_time, end_time, section, is_exam)
      values (?, ?, ?, ?, ?, ?)
    `);
    for (const schedule of scheduleRows) {
      insertSchedule.run(classId, schedule.lessonDate, schedule.startTime, schedule.endTime, schedule.section, schedule.isExam);
    }
    db.prepare("update applications set teacher_user_id = ?, teacher_name = ?, class_name = ? where class_id = ?").run(
      professorSelection.idText,
      professorSelection.nameText,
      String(body.class_name || "").trim(),
      classId
    );
  } catch (error) {
    db.close();
    return redirect(res, `/course/classes/${classId}?notice=更新失败，ClassCode 可能已存在`);
  }
  db.close();
  redirect(res, `/course/classes/${classId}?notice=教学班已更新`);
}

async function batchUpdateClassWindow(req, res) {
  const body = await readBody(req);
  const refs = parseBatchClassRefs(body.class_refs);
  let applyStartAt;
  let applyEndAt;
  try {
    applyStartAt = normalizeDateTimeInput(body.apply_start_at);
    applyEndAt = normalizeDateTimeInput(body.apply_end_at);
    validateApplyWindow(applyStartAt, applyEndAt);
  } catch (error) {
    return redirect(res, `/course/classes?notice=${error.message}`);
  }
  if (!refs.length) {
    return redirect(res, "/course/classes?notice=请填写至少一个教学班 ID 或 ClassCode");
  }
  const db = getDb();
  const updateStmt = db.prepare(`
    update classes
    set apply_start_at = ?, apply_end_at = ?
    where class_id = ? or class_code = ?
  `);
  let changed = 0;
  for (const ref of refs) {
    const id = Number(ref);
    const result = updateStmt.run(applyStartAt, applyEndAt, Number.isInteger(id) && id > 0 ? id : -1, ref);
    changed += result.changes;
  }
  db.close();
  if (changed === 0) {
    return redirect(res, "/course/classes?notice=未匹配到任何教学班");
  }
  redirect(res, `/course/classes?notice=已批量更新 ${changed} 个教学班的开放申请时间`);
}

async function batchToggleClassApply(req, res) {
  const body = await readBody(req);
  const refs = parseBatchClassRefs(body.class_refs);
  const taAllowed = String(body.ta_allowed || "Y");
  if (!["Y", "N"].includes(taAllowed)) {
    return redirect(res, "/course/classes?notice=申请权限取值不合法");
  }
  if (!refs.length) {
    return redirect(res, "/course/classes?notice=请填写至少一个教学班 ID 或 ClassCode");
  }
  const db = getDb();
  const updateStmt = db.prepare(`
    update classes
    set ta_applications_allowed = ?
    where class_id = ? or class_code = ?
  `);
  let changed = 0;
  for (const ref of refs) {
    const id = Number(ref);
    const result = updateStmt.run(taAllowed, Number.isInteger(id) && id > 0 ? id : -1, ref);
    changed += result.changes;
  }
  db.close();
  if (changed === 0) {
    return redirect(res, "/course/classes?notice=未匹配到任何教学班");
  }
  redirect(res, `/course/classes?notice=已批量更新 ${changed} 个教学班的申请权限`);
}

function deleteClassesByIds(classIds) {
  const ids = Array.from(new Set(
    classIds
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0)
  ));
  if (!ids.length) {
    return { deletedCount: 0 };
  }
  const db = getDb();
  const selectApps = db.prepare("select application_id, resume_path from applications where class_id = ?");
  const deleteApproval = db.prepare("delete from approval_logs where application_id = ?");
  const deleteApps = db.prepare("delete from applications where class_id = ?");
  const deleteSchedules = db.prepare("delete from class_schedules where class_id = ?");
  const deleteClassStmt = db.prepare("delete from classes where class_id = ?");
  const filesToDelete = [];
  let deletedCount = 0;
  for (const classId of ids) {
    const classRow = db.prepare("select class_id from classes where class_id = ?").get(classId);
    if (!classRow) continue;
    const apps = selectApps.all(classId);
    for (const app of apps) {
      deleteApproval.run(app.application_id);
      if (app.resume_path) {
        filesToDelete.push(path.join(UPLOAD_DIR, path.basename(app.resume_path)));
      }
    }
    deleteApps.run(classId);
    deleteSchedules.run(classId);
    deletedCount += deleteClassStmt.run(classId).changes;
  }
  db.close();
  for (const filePath of filesToDelete) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
  return { deletedCount };
}

function deleteClass(res, classId) {
  const result = deleteClassesByIds([classId]);
  if (result.deletedCount === 0) {
    return redirect(res, "/course/classes?notice=教学班不存在");
  }
  redirect(res, "/course/classes?notice=教学班及其关联排课、申请、审批记录已删除");
}

async function batchDeleteClasses(req, res) {
  const body = await readBody(req);
  const refs = parseBatchClassRefs(body.class_refs);
  if (!refs.length) {
    return redirect(res, "/course/classes?notice=请先勾选至少一个教学班");
  }
  const db = getDb();
  const classRows = loadClassRowsByRefs(db, refs);
  db.close();
  if (!classRows.length) {
    return redirect(res, "/course/classes?notice=未匹配到任何教学班");
  }
  const result = deleteClassesByIds(classRows.map((row) => row.class_id));
  if (result.deletedCount === 0) {
    return redirect(res, "/course/classes?notice=未删除任何教学班");
  }
  redirect(res, `/course/classes?notice=已批量删除 ${result.deletedCount} 个教学班及其关联数据`);
}

async function handleRequest(req, res) {
  initDb();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const notice = url.searchParams.get("notice");
  const user = getCurrentUser(req);

  if (pathname.startsWith("/uploads/")) {
    const fileName = path.basename(pathname.replace("/uploads/", ""));
    const filePath = path.join(UPLOAD_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("file not found");
      return;
    }
    const ext = path.extname(fileName).toLowerCase();
    const contentTypes = {
      ".pdf": "application/pdf",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".txt": "text/plain; charset=utf-8"
    };
    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream",
      "Content-Disposition": `inline; filename="${fileName}"`
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (pathname === "/login" && req.method === "POST") {
    const body = await readBody(req);
    const db = getDb();
    const row = db.prepare("select * from users where login_name = ? and password = ?").get(String(body.login_name || ""), String(body.password || ""));
    db.close();
    if (!row) {
      return loginPage(res, "账号或密码错误");
    }
    const sid = crypto.randomBytes(16).toString("hex");
    sessions.set(sid, row.user_id);
    return redirect(res, `/?notice=${row.user_name} 已登录`, { "Set-Cookie": `sid=${sid}; Path=/; HttpOnly` });
  }

  if (pathname === "/logout") {
    const sid = parseCookies(req).sid;
    if (sid) {
      sessions.delete(sid);
    }
    return redirect(res, "/", { "Set-Cookie": "sid=; Path=/; Max-Age=0" });
  }

  if (pathname === "/") {
    return homePage(res, user, notice);
  }

  if (pathname === "/magic-login") {
    const token = url.searchParams.get("token") || "";
    return consumeLoginToken(res, token);
  }

  if (pathname === "/notifications") {
    if (!user) return redirect(res, "/?notice=请先登录");
    return notificationsPage(res, user, notice);
  }
  if (/^\/notifications\/\d+\/read$/.test(pathname) && req.method === "POST") {
    if (!user) return redirect(res, "/?notice=请先登录");
    return markNotificationRead(res, user, Number(pathname.split("/")[2]));
  }

  if (pathname === "/ta/classes") {
    if (!requireRole(res, user, ["TA"])) return;
    return taClassesPage(res, user, notice);
  }
  if (pathname === "/ta/profile") {
    if (!requireRole(res, user, ["TA"])) return;
    return taProfilePage(res, user, notice);
  }
  if (pathname === "/ta/profile/resume" && req.method === "POST") {
    if (!requireRole(res, user, ["TA"])) return;
    return updateTaResume(req, res, user);
  }
  if (/^\/ta\/classes\/\d+$/.test(pathname)) {
    if (!requireRole(res, user, ["TA"])) return;
    return taClassDetailPage(res, user, Number(pathname.split("/").pop()), notice, url.searchParams.get("show_conflicts") === "1");
  }
  if (pathname === "/ta/applications" && req.method === "POST") {
    if (!requireRole(res, user, ["TA"])) return;
    return createApplication(req, res, user);
  }
  if (pathname === "/ta/applications") {
    if (!requireRole(res, user, ["TA"])) return;
    return taApplicationsPage(res, user, notice);
  }
  if (/^\/ta\/applications\/\d+\/withdraw$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["TA"])) return;
    return withdrawApplication(res, user, Number(pathname.split("/")[3]));
  }
  if (/^\/ta\/applications\/\d+$/.test(pathname)) {
    if (!requireRole(res, user, ["TA"])) return;
    return taApplicationDetailPage(res, user, Number(pathname.split("/").pop()), notice);
  }

  if (pathname === "/admin/ta/pending") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminPendingPage(res, user, notice);
  }
  if (pathname === "/admin/ta/applications") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminAllApplicationsPage(res, user, notice);
  }
  if (/^\/admin\/ta\/applications\/\d+\/override-status$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return overrideApplicationStatus(req, res, user, Number(pathname.split("/")[4]), "/admin/ta/pending");
  }
  if (pathname === "/admin/ta/classes") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminAllClassesPage(
      res,
      user,
      notice,
      url.searchParams.get("professor_name") || "",
      url.searchParams.get("class_name") || ""
    );
  }
  if (/^\/admin\/ta\/classes\/\d+\/applications$/.test(pathname)) {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminClassApplicationsPage(res, user, Number(pathname.split("/")[4]), notice);
  }
  if (pathname === "/admin/ta/classes/email-preview" && req.method === "POST") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminProfessorEmailPreview(req, res, user, notice);
  }
  if (/^\/admin\/ta\/classes\/\d+\/applications\/approve$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminBatchApproveByClass(req, res, user, Number(pathname.split("/")[4]));
  }
  if (/^\/admin\/ta\/pending\/\d+\/approve$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminApprove(req, res, user, Number(pathname.split("/")[4]));
  }
  if (/^\/admin\/ta\/pending\/\d+\/remind-professor$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return remindProfessor(res, user, Number(pathname.split("/")[4]));
  }
  if (/^\/admin\/ta\/pending\/\d+$/.test(pathname)) {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminDetailPage(res, user, Number(pathname.split("/").pop()), notice);
  }
  if (pathname === "/admin/ta/users") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taUsersPage(res, user, notice);
  }
  if (/^\/admin\/ta\/users\/\d+\/toggle$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return toggleTaUser(res, Number(pathname.split("/")[4]));
  }

  if (pathname === "/professor/pending") {
    if (!requireRole(res, user, ["Professor"])) return;
    return professorPendingPage(res, user, notice);
  }
  if (/^\/professor\/classes\/\d+$/.test(pathname)) {
    if (!requireRole(res, user, ["Professor"])) return;
    return professorClassReviewPage(res, user, Number(pathname.split("/").pop()), notice);
  }
  if (/^\/professor\/pending\/\d+\/approve$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["Professor"])) return;
    return professorApprove(req, res, user, Number(pathname.split("/")[3]));
  }
  if (/^\/professor\/pending\/\d+$/.test(pathname)) {
    if (!requireRole(res, user, ["Professor"])) return;
    return professorDetailPage(res, user, Number(pathname.split("/").pop()), notice);
  }

  if (pathname === "/course/classes") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return courseClassesPage(res, user, notice, url.searchParams.get("status_filter") || "");
  }
  if (/^\/course\/applications\/\d+\/override-status$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return overrideApplicationStatus(req, res, user, Number(pathname.split("/")[3]), "/course/applications");
  }
  if (pathname === "/course/classes/import/template") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet([
      {
        class_code: "FIN201-A",
        class_abbr: "FIN201",
        course_name: "公司金融",
        class_name: "公司金融A班",
        teaching_language: "中文",
        teacher_login_name: "prof1,prof2",
        semester: "2026Fall",
        maximum_number: 2,
        ta_allowed: "Y",
        is_conflict_allowed: "N",
        apply_start_at: "2026-03-09 09:00",
        apply_end_at: "2026-12-31 23:59",
        lesson_date: "2026-09-15",
        start_time: "18:30",
        end_time: "20:30",
        section: "晚上",
        is_exam: "",
        class_intro: "公司金融教学班",
        memo: "工作日晚课"
      },
      {
        class_code: "FIN201-A",
        class_abbr: "FIN201",
        course_name: "公司金融",
        class_name: "公司金融A班",
        teaching_language: "中文",
        teacher_login_name: "prof1,prof2",
        semester: "2026Fall",
        maximum_number: 2,
        ta_allowed: "Y",
        is_conflict_allowed: "N",
        apply_start_at: "2026-03-09 09:00",
        apply_end_at: "2026-12-31 23:59",
        lesson_date: "2026-09-22",
        start_time: "18:30",
        end_time: "20:30",
        section: "晚上",
        is_exam: "",
        class_intro: "公司金融教学班",
        memo: "工作日晚课"
      }
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Classes");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="classes_import_template.xlsx"'
    });
    res.end(buffer);
    return;
  }
  if (/^\/course\/classes\/import\/result\/[A-Za-z0-9]+$/.test(pathname)) {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return classesImportResultPage(res, user, pathname.split("/").pop(), notice);
  }
  if (pathname === "/course/applications") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return courseAdminAllApplicationsPage(res, user, notice);
  }
  if (/^\/course\/applications\/\d+$/.test(pathname)) {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return courseAdminApplicationDetailPage(res, user, Number(pathname.split("/").pop()), notice);
  }
  if (pathname === "/course/classes/create" && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return createClass(req, res);
  }
  if (pathname === "/course/classes/import" && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return importClasses(req, res);
  }
  if (pathname === "/course/classes/batch-toggle" && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return batchToggleClassApply(req, res);
  }
  if (pathname === "/course/classes/batch-window" && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return batchUpdateClassWindow(req, res);
  }
  if (pathname === "/course/classes/batch-delete" && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return batchDeleteClassesConfirmPage(req, res, user, notice);
  }
  if (pathname === "/course/classes/batch-delete/confirm" && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return batchDeleteClasses(req, res);
  }
  if (/^\/course\/classes\/\d+$/.test(pathname)) {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return courseClassDetailPage(res, user, Number(pathname.split("/").pop()), notice);
  }
  if (/^\/course\/classes\/\d+\/applications$/.test(pathname)) {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return courseClassApplicationsPage(res, user, Number(pathname.split("/")[3]), notice);
  }
  if (/^\/course\/classes\/\d+\/delete$/.test(pathname)) {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return courseClassDeleteConfirmPage(res, user, Number(pathname.split("/")[3]), notice);
  }
  if (/^\/course\/classes\/\d+\/delete\/confirm$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return deleteClass(res, Number(pathname.split("/")[3]));
  }
  if (/^\/course\/classes\/\d+\/update$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return updateClass(req, res, Number(pathname.split("/")[3]));
  }
  if (pathname === "/course/users") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return courseUsersPage(res, user, notice);
  }
  if (pathname === "/course/users/import/template") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet([
      {
        login_name: "ta3",
        user_name: "New TA",
        email: "ta3@example.com",
        password: "123456",
        role: "TA",
        is_allowed_to_apply: "Y"
      },
      {
        login_name: "prof2",
        user_name: "Prof Li",
        email: "prof2@example.com",
        password: "123456",
        role: "Professor",
        is_allowed_to_apply: "N"
      }
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Users");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="users_import_template.xlsx"'
    });
    res.end(buffer);
    return;
  }
  if (pathname === "/course/users/import" && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return importCourseUsers(req, res);
  }
  if (/^\/course\/users\/import\/result\/[A-Za-z0-9]+$/.test(pathname)) {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return usersImportResultPage(res, user, pathname.split("/").pop(), notice);
  }
  if (pathname === "/course/users/create" && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return createCourseUser(req, res);
  }
  if (/^\/course\/users\/\d+$/.test(pathname)) {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return courseUserDetailPage(res, user, Number(pathname.split("/").pop()), notice);
  }
  if (/^\/course\/users\/\d+\/update$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return updateCourseUser(req, res, Number(pathname.split("/")[3]));
  }
  if (/^\/course\/users\/\d+\/delete$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return deleteCourseUser(res, Number(pathname.split("/")[3]));
  }

  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
  res.end(pageLayout("未找到", '<section class="card">页面不存在。</section>', user, notice));
}

initDb();
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    fs.writeFileSync(path.join(BASE_DIR, "server-error.log"), `${nowStr()} ${error.stack}\n`, { flag: "a" });
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageLayout("错误", `<section class="card"><h2>服务异常</h2><pre>${escapeHtml(error.stack)}</pre></section>`, getCurrentUser(req)));
  });
});

if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`TA system MVP running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = { initDb, handleRequest, server };
