const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { URL } = require("node:url");
const querystring = require("node:querystring");
const { DatabaseSync } = require("node:sqlite");
const { BASE_DIR, DB_PATH, UPLOAD_DIR, ASSET_DIR, DB_CLIENT, PORT, HOST } = require("./config/runtime");
const dbGateway = require("./db/gateway");
const XLSX = require("xlsx");
let nodemailer = null;
try {
  nodemailer = require("nodemailer");
} catch (_error) {
  nodemailer = null;
}

const SAIF_LOGO_HORIZONTAL = `/assets/${encodeURIComponent("学院logo金色版2-英文横版.png")}`;
const SAIF_LOGO_VERTICAL = `/assets/${encodeURIComponent("学院logo金色版7-原竖版.png")}`;
const sessions = new Map();
const ssoStates = new Map();

function isSsoConfigured() {
  return Boolean(String(process.env.SSO_AUTH_URL || "").trim() && String(process.env.SSO_CLIENT_ID || "").trim());
}

function getSsoScope() {
  return String(process.env.SSO_SCOPE || "openid profile").trim() || "openid profile";
}

function getSsoLoginNameField() {
  return String(process.env.SSO_LOGIN_NAME_FIELD || "account").trim() || "account";
}

function getSsoRedirectUri(req) {
  const configured = String(process.env.SSO_REDIRECT_URI || "").trim();
  if (configured) return configured;
  return `${getExternalBaseUrl(req)}/login/sso/callback`;
}

function cleanupSsoStates() {
  const now = Date.now();
  for (const [state, meta] of ssoStates.entries()) {
    if (!meta || meta.expiresAt <= now) {
      ssoStates.delete(state);
    }
  }
}

function createSsoState(targetPath) {
  cleanupSsoStates();
  const state = crypto.randomBytes(16).toString("hex");
  ssoStates.set(state, {
    targetPath: targetPath || "/",
    expiresAt: Date.now() + 10 * 60 * 1000
  });
  return state;
}

function consumeSsoState(state) {
  cleanupSsoStates();
  const meta = ssoStates.get(state);
  if (!meta) return null;
  ssoStates.delete(state);
  if (meta.expiresAt <= Date.now()) return null;
  return meta;
}

function parseJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const normalized = payload + "=".repeat((4 - (payload.length % 4 || 4)) % 4);
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
  } catch (_) {
    return null;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

function buildSsoAuthorizeUrl(req, state) {
  const authUrl = String(process.env.SSO_AUTH_URL || "").trim();
  const clientId = String(process.env.SSO_CLIENT_ID || "").trim();
  const redirectUri = getSsoRedirectUri(req);
  const scope = getSsoScope();
  const encodedScope = encodeURIComponent(scope).replace(/%20/g, "+");
  const encodedClientId = encodeURIComponent(clientId);
  const encodedState = encodeURIComponent(state);
  const authorizationUrl = `${authUrl}?client_id=${encodedClientId}&response_type=code&redirect_uri=${redirectUri}&scope=${encodedScope}&state=${encodedState}`;

  const loginUrl = String(process.env.SSO_LOGIN_URL || "").trim();
  if (!loginUrl) {
    return authorizationUrl;
  }
  const wrapper = new URL(loginUrl);
  if (String(process.env.SSO_LOGIN_X_STARTED || "").trim().toUpperCase() === "Y") {
    wrapper.searchParams.set("x_started", "true");
  }
  wrapper.searchParams.set("redirect_uri", authorizationUrl);
  return wrapper.toString();
}

async function exchangeSsoCodeForToken(req, code) {
  const tokenUrl = String(process.env.SSO_TOKEN_URL || "").trim();
  const clientId = String(process.env.SSO_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.SSO_CLIENT_SECRET || "").trim();
  const redirectUri = getSsoRedirectUri(req);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: String(code || ""),
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret
  });
  return fetchJson(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: body.toString()
  });
}

async function fetchSsoProfile(accessToken) {
  const profileUrl = String(process.env.SSO_USERINFO_URL || "").trim();
  if (!profileUrl) return null;
  return fetchJson(profileUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });
}

function extractSsoLoginName(profile, accessToken) {
  const field = getSsoLoginNameField();
  const candidateKeys = Array.from(new Set([
    field,
    "account",
    "login_name",
    "loginName",
    "username",
    "userName",
    "uid",
    "sub"
  ]));
  const containers = [];
  if (profile && typeof profile === "object") {
    containers.push(profile);
    for (const key of ["data", "result", "profile", "user", "me"]) {
      if (profile[key] && typeof profile[key] === "object") {
        containers.push(profile[key]);
      }
    }
    if (Array.isArray(profile.entities)) {
      for (const entity of profile.entities) {
        if (entity && typeof entity === "object") {
          containers.push(entity);
        }
      }
    }
  }
  for (const container of containers) {
    for (const key of candidateKeys) {
      if (container[key]) {
        return String(container[key]).trim();
      }
    }
  }
  const payload = parseJwtPayload(accessToken);
  if (payload && typeof payload === "object") {
    const payloadContainers = [payload];
    for (const key of ["data", "result", "profile", "user", "me"]) {
      if (payload[key] && typeof payload[key] === "object") {
        payloadContainers.push(payload[key]);
      }
    }
    if (Array.isArray(payload.entities)) {
      for (const entity of payload.entities) {
        if (entity && typeof entity === "object") {
          payloadContainers.push(entity);
        }
      }
    }
    for (const container of payloadContainers) {
      for (const key of candidateKeys) {
        if (container[key]) {
          return String(container[key]).trim();
        }
      }
    }
  }
  return "";
}

async function startSsoLogin(req, res) {
  if (!isSsoConfigured()) {
    return redirect(res, "/?notice=SSO 尚未配置完成");
  }
  const targetPath = "/";
  const state = createSsoState(targetPath);
  return redirect(res, buildSsoAuthorizeUrl(req, state));
}

async function handleSsoCallback(req, res, url) {
  if (!isSsoConfigured()) {
    return redirect(res, "/?notice=SSO 尚未配置完成");
  }
  const code = String(url.searchParams.get("code") || "").trim();
  const state = String(url.searchParams.get("state") || "").trim();
  if (!code || !state) {
    return redirect(res, "/?notice=SSO 回调缺少必要参数");
  }
  const stateMeta = consumeSsoState(state);
  if (!stateMeta) {
    return redirect(res, "/?notice=SSO 登录状态已失效，请重新登录");
  }
  try {
    const tokenData = await exchangeSsoCodeForToken(req, code);
    const accessToken = String(tokenData.access_token || "").trim();
    if (!accessToken) {
      return redirect(res, "/?notice=SSO 未返回 access token");
    }
    let profile = null;
    try {
      profile = await fetchSsoProfile(accessToken);
    } catch (_) {
      profile = null;
    }
    const loginName = extractSsoLoginName(profile, accessToken);
    if (!loginName) {
      const payload = parseJwtPayload(accessToken);
      console.warn("[sso] 可识别账号字段缺失", {
        profileKeys: profile && typeof profile === "object" ? Object.keys(profile) : [],
        profileDataKeys: profile && profile.data && typeof profile.data === "object" ? Object.keys(profile.data) : [],
        profileResultKeys: profile && profile.result && typeof profile.result === "object" ? Object.keys(profile.result) : [],
        profileEntityKeys: profile && Array.isArray(profile.entities) && profile.entities[0] && typeof profile.entities[0] === "object" ? Object.keys(profile.entities[0]) : [],
        payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
        payloadDataKeys: payload && payload.data && typeof payload.data === "object" ? Object.keys(payload.data) : [],
        loginField: getSsoLoginNameField()
      });
      return redirect(res, "/?notice=SSO 未返回可识别的账号字段");
    }
    const user = await dbGateway.findUserByLoginName(loginName);
    if (!user) {
      return redirect(res, "/?notice=SSO 用户未在本系统开通");
    }
    const sid = crypto.randomBytes(16).toString("hex");
    sessions.set(sid, user.user_id);
    return redirect(res, `${stateMeta.targetPath || "/"}?notice=${user.user_name} 已通过 SSO 登录`, {
      "Set-Cookie": `sid=${sid}; Path=/; HttpOnly`
    });
  } catch (error) {
    return redirect(res, `/?notice=SSO 登录失败：${error.message}`);
  }
}
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

const activeApplicationStatuses = new Set([
  "PendingTAAdmin",
  "PendingProfessor",
  "Approved"
]);

const reapplyAllowedStatuses = new Set([
  "Withdrawn",
  "RejectedByTAAdmin",
  "RejectedByProfessor"
]);

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

function comparableDateTimeValue(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDateTime(value).slice(0, 16);
  }
  const raw = String(value).trim();
  if (!raw) return "";
  if (raw.includes("T")) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      return formatDateTime(date).slice(0, 16);
    }
  }
  return raw.replace("T", " ").slice(0, 16);
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
      credit real,
      maximum_number_of_tas_admitted integer not null default 1,
      ta_applications_allowed text not null default 'Y',
      is_conflict_allowed text not null default 'N',
      published_to_professor text not null default 'N',
      professor_notified_at text,
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

    create table if not exists audit_logs (
      audit_log_id integer primary key autoincrement,
      actor_user_id integer,
      actor_name text,
      actor_role text,
      action_type text not null,
      target_type text not null,
      target_id text,
      target_name text,
      details text,
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
  if (!classColumns.some((column) => column.name === "credit")) {
    db.exec("alter table classes add column credit real");
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
  if (!classColumns.some((column) => column.name === "published_to_professor")) {
    db.exec("alter table classes add column published_to_professor text not null default 'N'");
  }
  if (!classColumns.some((column) => column.name === "professor_notified_at")) {
    db.exec("alter table classes add column professor_notified_at text");
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
    set published_to_professor = coalesce(published_to_professor, 'N')
    where published_to_professor is null
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

async function getCurrentUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid || !sessions.has(sid)) {
    return null;
  }
  return (await dbGateway.findUserById(sessions.get(sid))) ?? null;
}

function sendHtml(res, html, headers = {}, statusCode = 200) {
  Promise.resolve(html)
    .then((resolvedHtml) => {
      if (res.writableEnded) return;
      res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8", ...headers });
      res.end(resolvedHtml);
    })
    .catch((error) => {
      if (res.writableEnded) return;
      fs.writeFileSync(path.join(BASE_DIR, "server-error.log"), `${nowStr()} ${error.stack}\n`, { flag: "a" });
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<section style="padding:24px;font-family:system-ui,sans-serif;"><h2>服务异常</h2><pre style="white-space:pre-wrap;">${escapeHtml(error.stack || error.message || error)}</pre></section>`);
    });
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: encodeURI(location), ...headers });
  res.end();
}

async function consumeLoginToken(res, token) {
  const row = await dbGateway.findUnusedLoginToken(token);
  if (!row) {
    return redirect(res, "/?notice=登录链接无效或已失效");
  }
  if (row.expires_at < nowStr()) {
    return redirect(res, "/?notice=登录链接已过期");
  }
  const user = await dbGateway.findUserById(row.user_id);
  if (!user) {
    return redirect(res, "/?notice=用户不存在");
  }
  await dbGateway.markLoginTokenUsed(token, nowStr());
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
  return base.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_");
}

function decodeMultipartFilename(filename) {
  const raw = String(filename || "");
  if (!raw) return "";
  try {
    const decoded = Buffer.from(raw, "latin1").toString("utf8");
    if (decoded && !decoded.includes("\uFFFD")) {
      return decoded;
    }
  } catch {}
  return raw;
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
      const decodedFilename = decodeMultipartFilename(fileMatch[1]);
      files[fieldName] = {
        filename: decodedFilename,
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
  const originalName = path.basename(String(file.filename || "").trim());
  const safeName = sanitizeFilename(originalName);
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
    originalName: originalName,
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
  const normalized = comparableDateTimeValue(value);
  return normalized ? normalized.replace(" ", "T").slice(0, 16) : "";
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
  return comparableDateTimeValue(classRow.apply_start_at) <= now && now <= comparableDateTimeValue(classRow.apply_end_at);
}

function applyWindowText(classRow) {
  if (!classRow.apply_start_at || !classRow.apply_end_at) {
    return "未设置";
  }
  return `${escapeHtml(normalizeDisplayDateTime(classRow.apply_start_at))} 至 ${escapeHtml(normalizeDisplayDateTime(classRow.apply_end_at))}`;
}

function compactApplyWindowText(classRow) {
  if (!classRow.apply_start_at || !classRow.apply_end_at) {
    return "未设置";
  }
  const start = normalizeDisplayDateTime(classRow.apply_start_at);
  const end = normalizeDisplayDateTime(classRow.apply_end_at);
  if (start.slice(0, 10) === end.slice(0, 10)) {
    return `${start.slice(0, 10)} ${start.slice(11, 16)}-${end.slice(11, 16)}`;
  }
  return `${start.slice(5, 16)} - ${end.slice(5, 16)}`;
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
  const startAt = comparableDateTimeValue(classRow.apply_start_at);
  const endAt = comparableDateTimeValue(classRow.apply_end_at);
  if (now < startAt) return "upcoming";
  if (now > endAt) return "expired";
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

function ynPill(value, yesLabel = "是", noLabel = "否") {
  const normalized = String(value || "").toUpperCase() === "Y";
  return `<span class="pill ${normalized ? "ok" : "muted"}">${normalized ? yesLabel : noLabel}</span>`;
}

function classOpenStatusPill(classRow) {
  const status = classOpenStatus(classRow);
  const tone =
    status === "open" ? "ok" :
    status === "upcoming" ? "gold" :
    status === "expired" ? "bad" :
    "muted";
  return `<span class="pill ${tone}">${escapeHtml(classOpenStatusLabel(classRow))}</span>`;
}

function classCapacityPill(isFull) {
  return `<span class="pill ${isFull ? "gold" : "muted"}">${isFull ? "已满" : "未满"}</span>`;
}

function metricPill(value, tone = "muted") {
  return `<span class="pill ${tone}" style="min-width:0; padding:5px 10px; font-size:12px;">${escapeHtml(value)}</span>`;
}

function namePills(value) {
  const names = String(value || "")
    .split("；")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!names.length) return '<span class="pill muted">-</span>';
  return `<div class="pill-stack">${names.map((name) => `<span class="pill muted">${escapeHtml(name)}</span>`).join("")}</div>`;
}

function parseBatchClassRefs(value) {
  return Array.from(new Set(
    String(value || "")
      .split(/[\s,，]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

function parseIdList(value) {
  return Array.from(new Set(
    String(value || "")
      .split(/[\s,，]+/)
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isInteger(item) && item > 0)
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

function createAuditLog(db, { actor = null, actionType, targetType, targetId = "", targetName = "", details = "" }) {
  db.prepare(`
    insert into audit_logs (
      actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actor?.user_id ?? null,
    actor?.user_name ?? "系统",
    actor?.role ?? "System",
    actionType,
    targetType,
    String(targetId || ""),
    String(targetName || ""),
    String(details || ""),
    nowStr()
  );
}

const auditActionLabels = {
  TA_APPLY: "TA提交申请",
  TA_WITHDRAW: "TA撤销申请",
  TAADMIN_APPROVE: "TAAdmin通过申请",
  TAADMIN_REJECT: "TAAdmin拒绝申请",
  PROFESSOR_APPROVE: "Professor通过申请",
  PROFESSOR_REJECT: "Professor拒绝申请",
  AUTO_REJECT_CAPACITY: "名额已满自动拒绝",
  ADMIN_OVERRIDE_STATUS: "管理员改申请状态",
  CLASS_CREATE: "创建教学班",
  CLASS_UPDATE: "修改教学班",
  CLASS_DELETE: "删除教学班",
  CLASS_PUBLISH_TO_PROFESSOR: "发布教学班到Professor",
  CLASS_PUBLISH_STATUS_UPDATE: "批量修改发布状态",
  CLASS_APPLY_WINDOW_UPDATE: "批量修改申请时间",
  CLASS_APPLY_TOGGLE: "批量修改开放申请",
  TA_TOGGLE_APPLY_QUALIFICATION: "修改TA申请资格",
  USER_CREATE: "创建人员",
  USER_UPDATE: "修改人员",
  USER_DELETE: "删除人员",
  USER_IMPORT: "导入人员",
  USER_IMPORT_FAILED: "导入人员失败",
  CLASS_IMPORT: "导入教学班",
  CLASS_IMPORT_FAILED: "导入教学班失败",
  PROFESSOR_EMAIL_SEND_FAILED: "发送Professor邮件失败",
  EMAIL_PARTIAL_FAILURE: "邮件部分发送失败"
};

const auditActionTones = {
  TA_APPLY: "info",
  TA_WITHDRAW: "muted",
  TAADMIN_APPROVE: "approve",
  TAADMIN_REJECT: "reject",
  PROFESSOR_APPROVE: "approve",
  PROFESSOR_REJECT: "reject",
  AUTO_REJECT_CAPACITY: "reject",
  ADMIN_OVERRIDE_STATUS: "admin",
  USER_IMPORT_FAILED: "reject",
  CLASS_IMPORT_FAILED: "reject",
  PROFESSOR_EMAIL_SEND_FAILED: "reject",
  EMAIL_PARTIAL_FAILURE: "warn"
};

function auditActionTone(actionType) {
  return auditActionTones[actionType] || "neutral";
}

function renderAuditActionBadge(actionType) {
  const tone = auditActionTone(actionType);
  const label = auditActionLabels[actionType] || actionType;
  return `<span class="audit-badge audit-badge-${tone}">${escapeHtml(label)}</span>`;
}

function renderAuditDetails(value) {
  return escapeHtml(value || "-").replace(/\n/g, "<br>");
}

async function unreadNotificationCount(userId) {
  return dbGateway.unreadNotificationCountByUser(userId);
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

function normalizeDisplayDateTime(value) {
  if (!value) return "";
  if (value instanceof Date) {
    return formatDateTime(value).slice(0, 16);
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)) {
    return text.slice(0, 16);
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return formatDateTime(parsed).slice(0, 16);
  }
  return text;
}

function normalizeDisplayDate(value) {
  const text = normalizeDisplayDateTime(value);
  return text ? text.slice(0, 10) : "";
}

function normalizeMonthValue(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}$/.test(text)) {
    return text;
  }
  const now = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

function shiftMonthValue(monthValue, offset) {
  const [yearText, monthText] = normalizeMonthValue(monthValue).split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const date = new Date(year, monthIndex + Number(offset || 0), 1);
  const pad = (v) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function monthLabel(monthValue) {
  const [yearText, monthText] = normalizeMonthValue(monthValue).split("-");
  return `${yearText}年${Number(monthText)}月`;
}

function timeToMinutes(value) {
  const text = String(value || "").trim();
  const matched = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!matched) return null;
  return Number(matched[1]) * 60 + Number(matched[2]);
}

function schedulesOverlap(a, b) {
  const aStart = timeToMinutes(a.start_time);
  const aEnd = timeToMinutes(a.end_time);
  const bStart = timeToMinutes(b.start_time);
  const bEnd = timeToMinutes(b.end_time);
  if ([aStart, aEnd, bStart, bEnd].some((item) => item === null)) return false;
  return aStart < bEnd && bStart < aEnd;
}

function buildClassCalendarData(rows, schedulesByClass, monthValue) {
  const normalizedMonth = normalizeMonthValue(monthValue);
  const [yearText, monthText] = normalizedMonth.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const firstDay = new Date(year, monthIndex, 1);
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const monthStartWeekday = (firstDay.getDay() + 6) % 7;
  const gridStart = new Date(year, monthIndex, 1 - monthStartWeekday);
  const rowById = new Map(rows.map((row) => [Number(row.class_id), row]));
  const entriesByDate = new Map();

  for (const [classIdRaw, scheduleRows] of schedulesByClass.entries()) {
    const classId = Number(classIdRaw);
    const row = rowById.get(classId);
    if (!row) continue;
    for (const schedule of scheduleRows || []) {
      const lessonDate = normalizeDisplayDate(schedule.lesson_date);
      if (!lessonDate.startsWith(`${normalizedMonth}-`)) continue;
      if (!entriesByDate.has(lessonDate)) {
        entriesByDate.set(lessonDate, []);
      }
      entriesByDate.get(lessonDate).push({
        class_id: classId,
        class_code: row.class_code,
        class_name: row.class_name,
        course_name: row.course_name,
        teacher_name: row.teacher_name,
        start_time: String(schedule.start_time || ""),
        end_time: String(schedule.end_time || ""),
        section: String(schedule.section || ""),
        is_exam: String(schedule.is_exam || ""),
        ta_count: Number(row.approved_count || 0),
        ta_limit: Number(row.maximum_number_of_tas_admitted || 0)
      });
    }
  }

  let conflictDayCount = 0;
  let conflictItemCount = 0;
  for (const entries of entriesByDate.values()) {
    entries.sort((a, b) => {
      const aStart = timeToMinutes(a.start_time) ?? 0;
      const bStart = timeToMinutes(b.start_time) ?? 0;
      return aStart - bStart || String(a.class_name).localeCompare(String(b.class_name), "zh-Hans-CN");
    });
    let hasConflict = false;
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        if (schedulesOverlap(entries[i], entries[j])) {
          entries[i].is_conflict = true;
          entries[j].is_conflict = true;
          hasConflict = true;
        }
      }
    }
    if (hasConflict) {
      conflictDayCount += 1;
      conflictItemCount += entries.filter((item) => item.is_conflict).length;
    }
  }

  const weeks = [];
  for (let weekIndex = 0; weekIndex < 6; weekIndex += 1) {
    const days = [];
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + weekIndex * 7 + dayIndex);
      const pad = (v) => String(v).padStart(2, "0");
      const dateKey = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      const isCurrentMonth = date.getMonth() === monthIndex;
      days.push({
        dateKey,
        dateNumber: date.getDate(),
        isCurrentMonth,
        entries: entriesByDate.get(dateKey) || []
      });
    }
    weeks.push(days);
  }

  return {
    monthValue: normalizedMonth,
    monthLabel: monthLabel(normalizedMonth),
    daysInMonth,
    totalClasses: rows.length,
    totalSchedules: Array.from(entriesByDate.values()).reduce((sum, items) => sum + items.length, 0),
    conflictDayCount,
    conflictItemCount,
    weeks
  };
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

function detectLanIpAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const items of Object.values(interfaces)) {
    for (const item of items || []) {
      if (!item || item.family !== "IPv4" || item.internal) continue;
      candidates.push(item.address);
    }
  }
  const privateCandidate = candidates.find((address) =>
    address.startsWith("10.") ||
    address.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)
  );
  return privateCandidate || candidates[0] || "127.0.0.1";
}

function getExternalBaseUrl(req) {
  const configuredBaseUrl = String(process.env.PUBLIC_BASE_URL || "").trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, "");
  }
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || "http";
  const hostHeader = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (hostHeader && !/^0\.0\.0\.0(?::|$)/.test(hostHeader) && !/^127\.0\.0\.1(?::|$)/.test(hostHeader) && !/^localhost(?::|$)/i.test(hostHeader)) {
    return `${protocol}://${hostHeader}`;
  }
  return `${protocol}://${detectLanIpAddress()}:${PORT}`;
}

function buildProfessorEmailDraft(professor, selectedClasses, accessLink) {
  const greeting = `${professor.user_name}教授您好`;
  const classLines = selectedClasses.map((row) => `- ${row.course_name} / ${row.class_name}（${row.class_code}）`).join("\n");
  const contactNote = "如有任何疑问或需要获取更多信息，请联系此次负责 TA 招募的同事：course.coordination@saif.sjtu.edu.cn。";
  const body = `${greeting}，\n\n你任教的以下教学班已完成TA申请的前置审核，请点击以下链接进入系统进行最终审核：\n${accessLink}\n\n${classLines}\n\n${contactNote}\n\n请勿将本邮件及其中链接转发给其他人员，以免造成学生申请信息、审核信息等敏感数据泄露。如邮件误收或不再负责相关审核工作，请及时删除并通知系统管理员。\n`;
  return {
    to: professor.email,
    subject: "TA申请前置审核已完成",
    text: body,
    html: buildBrandedEmailHtml({
      eyebrow: "TA 终审提醒",
      title: "TA 申请前置审核已完成",
      greeting,
      intro: "你任教的以下教学班已完成 TA 申请前置审核，请进入系统进行最终审核。",
      facts: [
        { label: "审核入口", value: `<a href="${escapeHtml(accessLink)}" style="color:#1A2287;text-decoration:none;font-weight:700;">点击进入系统</a>` }
      ],
      listTitle: "待审核教学班",
      listItems: selectedClasses.map((row) => `${row.course_name} / ${row.class_name}（${row.class_code}）`),
      footer: `${contactNote}\n\n请勿将本邮件及其中链接转发给其他人员，以免造成学生申请信息、审核信息等敏感数据泄露。如邮件误收或不再负责相关审核工作，请及时删除并通知系统管理员。`
    })
  };
}

function createMailer() {
  if (!nodemailer) {
    throw new Error("尚未安装 nodemailer，暂时无法直接发送邮件");
  }
  const smtpHost = String(process.env.SMTP_HOST || "").trim();
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  const smtpUser = String(process.env.SMTP_USER || "").trim();
  const smtpPass = String(process.env.SMTP_PASS || "").trim();
  const smtpSecure = String(process.env.SMTP_SECURE || "true").trim() !== "false";
  if (smtpHost && smtpUser && smtpPass) {
    return nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });
  }
  if (String(process.env.MAIL_USE_SENDMAIL || "").trim().toUpperCase() !== "Y") {
    throw new Error("未配置 SMTP。请在项目根目录创建 .env.local 并填写 SMTP_HOST、SMTP_PORT、SMTP_USER、SMTP_PASS、SMTP_FROM");
  }
  return nodemailer.createTransport({
    sendmail: true,
    newline: "unix",
    path: "/usr/sbin/sendmail"
  });
}

function buildBrandedEmailHtml({ eyebrow, title, greeting, intro, facts = [], listTitle = "", listItems = [], footer = "" }) {
  const footerHtml = String(footer || "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p style="margin:0 0 12px 0;">${escapeHtml(paragraph)}</p>`)
    .join("");
  const factsHtml = facts.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;margin-top:18px;">
      ${facts.map((item) => `<tr>
        <td width="112" style="padding:10px 0;border-top:1px solid #E8E0D4;color:#887F6F;font-size:13px;line-height:18px;vertical-align:top;">${escapeHtml(item.label)}</td>
        <td style="padding:10px 0;border-top:1px solid #E8E0D4;color:#2B231B;font-size:14px;line-height:22px;vertical-align:top;">${item.value}</td>
      </tr>`).join("")}
    </table>`
    : "";
  const listHtml = listItems.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;margin-top:20px;">
        <tr>
          <td style="padding:0 0 10px 0;color:#887F6F;font-size:13px;line-height:18px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">${escapeHtml(listTitle || "相关信息")}</td>
        </tr>
        ${listItems.map((item) => `<tr>
          <td style="padding:4px 0;color:#2B231B;font-size:14px;line-height:22px;">&#8226; ${escapeHtml(item)}</td>
        </tr>`).join("")}
      </table>`
    : "";
  return `<!doctype html>
  <html lang="zh-CN">
    <head>
      <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
      <meta name="x-apple-disable-message-reformatting">
      <meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
    </head>
    <body style="margin:0;padding:0;background-color:#F6F1E7;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F6F1E7" style="width:100%;border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;">
        <tr>
          <td align="center" style="padding:24px 12px;">
            <table role="presentation" width="680" cellspacing="0" cellpadding="0" border="0" bgcolor="#FFFFFF" style="width:680px;max-width:680px;border-collapse:collapse;border:1px solid #E8E0D4;mso-table-lspace:0pt;mso-table-rspace:0pt;">
              <tr>
                <td bgcolor="#1A2287" style="padding:20px 28px;background-color:#1A2287;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
                    <tr>
                      <td style="color:#D2AA6E;font-size:12px;line-height:18px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">${escapeHtml(eyebrow || "SAIF TA System")}</td>
                    </tr>
                    <tr>
                      <td style="padding-top:10px;color:#FFFFFF;font-size:28px;line-height:36px;font-weight:700;">${escapeHtml(title)}</td>
                    </tr>
                    <tr>
                      <td style="padding-top:6px;color:#D9DDF8;font-size:14px;line-height:20px;">上海高级金融学院 TA 选课申请系统</td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:28px;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
                    <tr>
                      <td style="color:#2B231B;font-size:16px;line-height:24px;font-weight:700;">${escapeHtml(greeting)}</td>
                    </tr>
                    <tr>
                      <td style="padding-top:12px;color:#4B4034;font-size:14px;line-height:24px;">${escapeHtml(intro)}</td>
                    </tr>
                    <tr>
                      <td>${factsHtml}${listHtml}</td>
                    </tr>
                    ${footer ? `<tr>
                      <td style="padding-top:22px;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F6F1E7" style="border-collapse:collapse;background-color:#F6F1E7;">
                          <tr>
                            <td style="padding:14px 16px;color:#6D6257;font-size:13px;line-height:22px;">${footerHtml}</td>
                          </tr>
                        </table>
                      </td>
                    </tr>` : ""}
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>`;
}

async function sendPlainTextEmail({ to, subject, text, html, cc }) {
  if (!to) return;
  const transporter = createMailer();
  const fromAddress = String(process.env.SMTP_FROM || process.env.SMTP_USER || "").trim();
  if (!fromAddress && String(process.env.SMTP_HOST || "").trim()) {
    throw new Error("已配置 SMTP，但缺少 SMTP_FROM 发件人地址");
  }
  const message = { to, subject, text, html };
  if (fromAddress) {
    message.from = fromAddress;
  }
  if (cc) {
    message.cc = cc;
  }
  await transporter.sendMail(message);
}

function buildTaAdminNewApplicationEmail(admin, applicant, classRow) {
  return {
    to: admin.email,
    subject: "有新的 TA 申请待审核",
    text: `${admin.user_name}老师您好，\n\n申请人 ${applicant.user_name} 已提交教学班《${classRow.class_name}》的 TA 申请，请尽快进入系统查看并完成初审。\n\n课程：${classRow.course_name}\n教学班：${classRow.class_name}\n教授：${classRow.teacher_name}\n\n请在系统中查看详细申请信息。`,
    html: buildBrandedEmailHtml({
      eyebrow: "新申请到达",
      title: "有新的 TA 申请待审核",
      greeting: `${admin.user_name}老师您好`,
      intro: `申请人 ${applicant.user_name} 已提交新的 TA 申请，请尽快进入系统完成初审。`,
      facts: [
        { label: "课程", value: escapeHtml(classRow.course_name) },
        { label: "教学班", value: escapeHtml(classRow.class_name) },
        { label: "教授", value: escapeHtml(classRow.teacher_name) },
        { label: "申请人", value: escapeHtml(applicant.user_name) }
      ]
    })
  };
}

function buildTaDecisionEmail(applicant, app, result, comments) {
  const isApproved = result === "Approved";
  const intro = isApproved
    ? `你的申请《${app.class_name}》已通过 TAAdmin 预审，待发布给 Professor 后进入最终审核。`
    : `你的申请《${app.class_name}》未通过 TAAdmin 审核。`;
  return {
    to: applicant.email,
    subject: isApproved ? "TA 预审通过通知" : "TA 预审结果通知",
    text: `${applicant.user_name}你好，\n\n${intro}${comments ? `\nTAAdmin 备注：${comments}` : ""}\n\n教学班：${app.class_name}\n教授：${app.teacher_name}\n\n请进入系统查看申请详情。`,
    html: buildBrandedEmailHtml({
      eyebrow: "TA 预审结果",
      title: isApproved ? "你的申请已通过 TAAdmin 预审" : "你的申请未通过 TAAdmin 审核",
      greeting: `${applicant.user_name}你好`,
      intro,
      facts: [
        { label: "教学班", value: escapeHtml(app.class_name) },
        { label: "教授", value: escapeHtml(app.teacher_name) },
        ...(comments ? [{ label: "TAAdmin 备注", value: escapeHtml(comments) }] : [])
      ]
    })
  };
}

function buildProfessorDecisionEmail(applicant, app, result, comments) {
  const isApproved = result === "Approved";
  const intro = isApproved
    ? `你的申请《${app.class_name}》已通过 Professor 审批。`
    : `你的申请《${app.class_name}》未通过 Professor 审批。`;
  return {
    to: applicant.email,
    subject: isApproved ? "Professor 审批通过通知" : "Professor 审批结果通知",
    text: `${applicant.user_name}你好，\n\n${intro}${comments ? `\nProfessor 备注：${comments}` : ""}\n\n教学班：${app.class_name}\n教授：${app.teacher_name}\n\n请进入系统查看申请详情。`,
    html: buildBrandedEmailHtml({
      eyebrow: "Professor 终审结果",
      title: isApproved ? "你的申请已通过 Professor 审批" : "你的申请未通过 Professor 审批",
      greeting: `${applicant.user_name}你好`,
      intro,
      facts: [
        { label: "教学班", value: escapeHtml(app.class_name) },
        { label: "教授", value: escapeHtml(app.teacher_name) },
        ...(comments ? [{ label: "Professor 备注", value: escapeHtml(comments) }] : [])
      ]
    })
  };
}

function buildClassCapacityRejectedEmail(applicant, app) {
  return {
    to: applicant.email,
    subject: "TA 申请结果通知",
    text: `${applicant.user_name}你好，\n\n你的申请《${app.class_name}》因课程 TA 名额已满被系统自动拒绝。\n\n教学班：${app.class_name}\n教授：${app.teacher_name}\n拒绝原因：该课程TA已满\n\n请进入系统查看申请详情。`,
    html: buildBrandedEmailHtml({
      eyebrow: "系统自动处理",
      title: "你的申请因 TA 名额已满被自动拒绝",
      greeting: `${applicant.user_name}你好`,
      intro: `你的申请《${app.class_name}》因课程 TA 名额已满，被系统自动拒绝。`,
      facts: [
        { label: "教学班", value: escapeHtml(app.class_name) },
        { label: "教授", value: escapeHtml(app.teacher_name) },
        { label: "拒绝原因", value: "该课程TA已满" }
      ]
    })
  };
}

async function sendEmailsAndCollectErrors(emailJobs) {
  const errors = [];
  for (const job of emailJobs) {
    if (!job || !job.to) continue;
    try {
      await sendPlainTextEmail(job);
    } catch (error) {
      errors.push(`${job.to}: ${error.message}`);
    }
  }
  return errors;
}

async function sendProfessorNotificationEmails(db, classes, taAdmin, baseUrl) {
  const grouped = new Map();
  const findProfessor = db.prepare("select user_id, user_name, email from users where user_id = ? and role = 'Professor'");
  for (const classRow of classes) {
    for (const professorId of normalizeTeacherUserIds(classRow.teacher_user_id)) {
      const professor = findProfessor.get(professorId);
      if (!professor || !professor.email) continue;
      if (!grouped.has(professor.user_id)) {
        grouped.set(professor.user_id, { professor, classes: [] });
      }
      grouped.get(professor.user_id).classes.push(classRow);
    }
  }
  if (!grouped.size) {
    throw new Error("所选教学班未匹配到可用的 Professor 邮箱");
  }
  const transporter = createMailer();
  const fromAddress = String(process.env.SMTP_FROM || process.env.SMTP_USER || "").trim();
  if (!fromAddress && String(process.env.SMTP_HOST || "").trim()) {
    throw new Error("已配置 SMTP，但缺少 SMTP_FROM 发件人地址");
  }
  for (const { professor, classes: selectedClasses } of grouped.values()) {
    const token = createLoginToken(db, professor.user_id, "/professor/pending");
    const accessLink = `${baseUrl}/magic-login?token=${token}`;
    const emailDraft = buildProfessorEmailDraft(professor, selectedClasses, accessLink);
    const message = {
      to: emailDraft.to,
      subject: emailDraft.subject,
      text: emailDraft.text,
      html: emailDraft.html
    };
    if (fromAddress) {
      message.from = fromAddress;
    }
    if (taAdmin?.email) {
      message.cc = taAdmin.email;
    }
    await transporter.sendMail(message);
    const classSummary = selectedClasses
      .map((row) => row.class_name)
      .filter(Boolean)
      .join("、");
    createNotification(
      db,
      professor.user_id,
      "TA申请待终审",
      `以下教学班已由 TAAdmin 完成前置审核，并发布给你进行最终审核：${classSummary || "相关教学班"}。请进入系统完成审批。`,
      "/professor/pending"
    );
  }
  const classIds = classes.map((row) => row.class_id);
  for (const classId of classIds) {
    db.prepare("update classes set published_to_professor = 'Y', professor_notified_at = ? where class_id = ?").run(nowStr(), classId);
  }
  for (const row of classes) {
    createAuditLog(db, {
      actor: taAdmin,
      actionType: "CLASS_PUBLISH_TO_PROFESSOR",
      targetType: "Class",
      targetId: row.class_id,
      targetName: `${row.course_name} / ${row.class_name}`,
      details: `教学班代码：${row.class_code}\n教授：${row.teacher_name}\n操作结果：已发送Professor提醒邮件并抄送TAAdmin`
    });
  }
}

async function pageLayout(title, body, user, notice) {
  let nav = "";
  if (user) {
    const links = ['<a href="/">首页</a>', '<a href="/logout" onclick="return confirm(\'确认退出当前账号吗？\')">退出</a>'];
    const unreadCount = await unreadNotificationCount(user.user_id);
    const isNotificationPage = String(title || "").includes("通知");
    const notificationLabel = isNotificationPage ? "通知" : `通知${unreadCount ? `(${unreadCount})` : ""}`;
    links.splice(1, 0, `<a href="/notifications">${notificationLabel}</a>`);
    if (user.role === "TA") {
      links.splice(1, 0, '<a href="/ta/classes">可申请教学班</a>', '<a href="/ta/applications">我的申请</a>', '<a href="/ta/profile">个人资料</a>');
    } else if (user.role === "TAAdmin") {
      links.splice(1, 0, '<a href="/course/reports">报表视图</a>', '<a href="/admin/ta/pending">待初审申请</a>', '<a href="/admin/ta/applications">全部申请</a>', '<a href="/admin/ta/application-logs">申请日志</a>', '<a href="/admin/ta/classes">全部教学班</a>', '<a href="/admin/ta/users">TA 管理</a>');
    } else if (user.role === "Professor") {
      links.splice(1, 0, '<a href="/professor/pending">待教授审批</a>');
    } else if (user.role === "CourseAdmin") {
      links.splice(1, 0, '<a href="/course/reports">报表视图</a>', '<a href="/course/applications">全部申请</a>', '<a href="/course/application-logs">申请日志</a>', '<a href="/course/classes">教学班管理</a>', '<a href="/course/users">人员管理</a>', '<a href="/course/audit-logs">审计日志</a>');
    }
    nav = `<nav class="nav-links">${links.join("")}</nav>`;
  }
  const noticeBlock = notice ? `<div class="notice">${escapeHtml(notice)}</div>` : "";
  const backButton = `<button class="back-button" type="button" onclick="if (window.history.length > 1) { window.history.back(); } else { window.location.href = '/'; }" aria-label="返回上一页">返回</button>`;
  const pageClass = title === "登录" ? "page-login" : "";
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        --bg: #f7f4ef;
        --panel: #ffffff;
        --panel-soft: #f8f5f0;
        --ink: #2b2620;
        --muted: #6e665c;
        --line: #ddd5ca;
        --accent: #1a2287;
        --accent-soft: #ebe9fb;
        --brand-red: #c8161e;
        --brand-red-soft: #f7d8da;
        --brand-gold: #d2aa6e;
        --brand-gold-soft: #f5ebdc;
        --brand-light-gray: #bbb0a3;
        --brand-dark-gray: #887f6f;
        --ok: #1a2287;
        --bad: #c8161e;
        --shadow: 0 2px 6px rgba(68, 52, 36, 0.08), 0 8px 24px rgba(68, 52, 36, 0.1);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Google Sans", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
        background:
          radial-gradient(circle at top left, rgba(26, 34, 135, 0.08), transparent 26%),
          radial-gradient(circle at top right, rgba(210, 170, 110, 0.14), transparent 22%),
          linear-gradient(180deg, #fbf8f3, var(--bg));
        color: var(--ink);
      }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      header {
        position: sticky;
        top: 0;
        z-index: 10;
        backdrop-filter: blur(16px);
        background: rgba(251, 248, 243, 0.92);
        border-bottom: 1px solid rgba(221, 213, 202, 0.95);
      }
      .topbar {
        max-width: 1360px;
        margin: 0 auto;
        padding: 14px 28px 10px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
      }
      .topbar-left {
        display: flex;
        align-items: center;
        gap: 14px;
        min-width: 0;
        flex: 1 1 auto;
      }
      .back-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        min-width: 72px;
        height: 38px;
        padding: 0 14px;
        border-radius: 999px;
        border: 1px solid rgba(26, 34, 135, 0.16);
        background: linear-gradient(180deg, rgba(255,255,255,0.96), rgba(243,239,233,0.96));
        color: var(--accent);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 6px 14px rgba(68, 52, 36, 0.08);
      }
      .back-button:hover {
        background: var(--accent-soft);
      }
      .back-button.is-hidden {
        display: none !important;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 16px;
        min-width: 420px;
        flex: 0 0 auto;
      }
      .brand-logo {
        display: block;
        flex-shrink: 0;
        width: 300px;
        max-width: min(40vw, 300px);
        aspect-ratio: 4339 / 832;
        height: auto;
        object-fit: contain;
        object-position: left center;
      }
      .brand-text {
        min-width: 0;
      }
      .brand-text h1 {
        margin: 0;
        font-size: 22px;
        font-weight: 700;
        letter-spacing: -0.02em;
        white-space: nowrap;
      }
      .brand-text p {
        margin: 6px 0 0;
        color: var(--muted);
        font-size: 13px;
      }
      .brand-text .role-line {
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
      }
      .brand-text .role-line div {
        white-space: nowrap;
      }
      .nav-links {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 10px;
        min-width: 0;
        flex: 1 1 auto;
      }
      .nav-links a {
        padding: 8px 12px;
        border-radius: 999px;
        color: var(--accent);
        background: transparent;
        font-weight: 500;
        font-size: 14px;
        white-space: nowrap;
        flex: 0 0 auto;
      }
      .nav-links a:hover {
        background: var(--accent-soft);
        text-decoration: none;
      }
      .nav-links a.active,
      .nav-links a[aria-current="page"] {
        background: linear-gradient(180deg, rgba(210, 170, 110, 0.22), rgba(210, 170, 110, 0.12));
        color: var(--accent);
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
      .card.card-soft-purple {
        background: #edf2ff;
        border-color: #cfd6fb;
      }
      .card.card-soft-red {
        background: #f6f1ec;
        border-color: #ddd4ca;
      }
      .card.card-brand {
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 245, 240, 0.94));
        border-color: #e6d7bf;
      }
      h1, h2, h3 { margin: 0 0 14px; }
      h2 { font-size: 22px; letter-spacing: -0.01em; }
      h3 { font-size: 18px; letter-spacing: -0.01em; }
      table { width: 100%; border-collapse: collapse; background: var(--panel); }
      table.fixed-layout {
        table-layout: fixed;
      }
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
        background: linear-gradient(180deg, #f8efe4, #f6f0e8);
        border-bottom-color: #d8c9b1;
      }
      th a {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 6px 8px;
        border-radius: 10px;
        color: inherit;
        font-weight: 600;
      }
      th a:hover {
        background: #eef3fd;
        text-decoration: none;
      }
      th a.active-sort {
        background: var(--accent-soft);
        color: var(--accent);
      }
      tr:hover td { background: #fcfaf5; }
      tr.row-soft-purple td { background: #edf2ff; }
      tr.row-soft-purple:hover td { background: #e3ebff; }
      tr.row-soft-red td { background: #f6f1ec; }
      tr.row-soft-red:hover td { background: #efe6de; }
      .table-wrap {
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }
      .table-wrap table th,
      .detail-table-wrap table th {
        font-size: 11px;
        padding: 10px 8px;
      }
      .table-wrap table td,
      .detail-table-wrap table td {
        font-size: 13px;
        padding: 10px 8px;
        line-height: 1.45;
      }
      .table-wrap.list-scroll {
        max-height: min(62vh, 760px);
        overflow: auto;
        border: 1px solid var(--line);
        border-radius: 18px;
        background: var(--panel);
        scrollbar-gutter: stable;
      }
      .table-wrap.list-scroll table {
        margin: 0;
      }
      .table-wrap.list-scroll th {
        position: sticky;
        top: 0;
        z-index: 4;
        background: linear-gradient(180deg, #f8efe4, #f6f0e8);
        box-shadow: inset 0 -1px 0 #d8c9b1;
      }
      .course-classes-table.freeze-to-tafull th:nth-child(-n+9),
      .course-classes-table.freeze-to-tafull td:nth-child(-n+9),
      .taadmin-classes-table.freeze-to-tafull th:nth-child(-n+8),
      .taadmin-classes-table.freeze-to-tafull td:nth-child(-n+8) {
        position: sticky;
        background: var(--panel);
        z-index: 3;
      }
      .course-classes-table.freeze-to-tafull th:nth-child(-n+9),
      .taadmin-classes-table.freeze-to-tafull th:nth-child(-n+8) {
        z-index: 7;
        background: linear-gradient(180deg, #f8efe4, #f6f0e8);
      }
      .course-classes-table.freeze-to-tafull th:nth-child(1),
      .course-classes-table.freeze-to-tafull td:nth-child(1),
      .taadmin-classes-table.freeze-to-tafull th:nth-child(1),
      .taadmin-classes-table.freeze-to-tafull td:nth-child(1) { left: 0; }
      .course-classes-table.freeze-to-tafull th:nth-child(2),
      .course-classes-table.freeze-to-tafull td:nth-child(2),
      .taadmin-classes-table.freeze-to-tafull th:nth-child(2),
      .taadmin-classes-table.freeze-to-tafull td:nth-child(2) { left: 56px; }
      .course-classes-table.freeze-to-tafull th:nth-child(3),
      .course-classes-table.freeze-to-tafull td:nth-child(3) { left: 166px; }
      .course-classes-table.freeze-to-tafull th:nth-child(4),
      .course-classes-table.freeze-to-tafull td:nth-child(4) { left: 248px; }
      .course-classes-table.freeze-to-tafull th:nth-child(5),
      .course-classes-table.freeze-to-tafull td:nth-child(5) { left: 416px; }
      .course-classes-table.freeze-to-tafull th:nth-child(6),
      .course-classes-table.freeze-to-tafull td:nth-child(6) { left: 488px; }
      .course-classes-table.freeze-to-tafull th:nth-child(7),
      .course-classes-table.freeze-to-tafull td:nth-child(7) { left: 596px; }
      .course-classes-table.freeze-to-tafull th:nth-child(8),
      .course-classes-table.freeze-to-tafull td:nth-child(8) { left: 688px; }
      .course-classes-table.freeze-to-tafull th:nth-child(9),
      .course-classes-table.freeze-to-tafull td:nth-child(9) {
        left: 776px;
        box-shadow: 8px 0 12px -12px rgba(46, 37, 24, 0.45), inset 0 -1px 0 var(--line);
      }
      .taadmin-classes-table.freeze-to-tafull th:nth-child(3),
      .taadmin-classes-table.freeze-to-tafull td:nth-child(3) { left: 162px; }
      .taadmin-classes-table.freeze-to-tafull th:nth-child(4),
      .taadmin-classes-table.freeze-to-tafull td:nth-child(4) { left: 242px; }
      .taadmin-classes-table.freeze-to-tafull th:nth-child(5),
      .taadmin-classes-table.freeze-to-tafull td:nth-child(5) { left: 402px; }
      .taadmin-classes-table.freeze-to-tafull th:nth-child(6),
      .taadmin-classes-table.freeze-to-tafull td:nth-child(6) { left: 520px; }
      .taadmin-classes-table.freeze-to-tafull th:nth-child(7),
      .taadmin-classes-table.freeze-to-tafull td:nth-child(7) { left: 608px; }
      .taadmin-classes-table.freeze-to-tafull th:nth-child(8),
      .taadmin-classes-table.freeze-to-tafull td:nth-child(8) {
        left: 694px;
        box-shadow: 8px 0 12px -12px rgba(46, 37, 24, 0.45), inset 0 -1px 0 var(--line);
      }
      .course-classes-table.freeze-to-tafull tr:hover td:nth-child(-n+9),
      .taadmin-classes-table.freeze-to-tafull tr:hover td:nth-child(-n+8) {
        background: #fcfaf5;
      }
      .course-classes-table.freeze-to-tafull tr.row-soft-purple td:nth-child(-n+9),
      .taadmin-classes-table.freeze-to-tafull tr.row-soft-purple td:nth-child(-n+8) {
        background: #edf2ff;
      }
      .course-classes-table.freeze-to-tafull tr.row-soft-purple:hover td:nth-child(-n+9),
      .taadmin-classes-table.freeze-to-tafull tr.row-soft-purple:hover td:nth-child(-n+8) {
        background: #e3ebff;
      }
      .detail-table-wrap {
        overflow-x: auto;
        overflow-y: visible;
        -webkit-overflow-scrolling: touch;
        border: 1px solid var(--line);
        border-radius: 18px;
        background: var(--panel);
        padding: 0;
      }
      .detail-table-wrap table {
        min-width: 760px;
        margin: 0;
      }
      .detail-table-wrap th,
      .detail-table-wrap td {
        white-space: nowrap;
      }
      .detail-table-wrap .audit-log-table td:last-child,
      .detail-table-wrap .audit-log-table th:last-child {
        white-space: normal;
      }
      table.wide { min-width: 1320px; }
      table.compact-table th {
        font-size: 11px;
        padding: 10px 8px;
        vertical-align: middle;
        line-height: 1.2;
        white-space: nowrap;
      }
      table.compact-table td {
        font-size: 13px;
        padding: 10px 8px;
        vertical-align: middle;
      }
      table.fixed-layout th,
      table.fixed-layout td {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
      .class-card-grid {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      }
      .class-card {
        padding: 14px 14px 12px;
        border-radius: 18px;
      }
      .class-card h3 {
        font-size: 16px;
        line-height: 1.3;
        margin-bottom: 8px;
      }
      .class-card p {
        margin: 0 0 6px;
        font-size: 12px;
        line-height: 1.55;
      }
      .class-card .actions {
        margin-top: 8px;
      }
      .class-card .schedule-meta {
        font-size: 11px;
      }
      .class-card-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 0 0 8px;
      }
      .class-card-meta span {
        display: inline-flex;
        align-items: center;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(26, 115, 232, 0.08);
        color: #355070;
        font-size: 11px;
        line-height: 1.2;
      }
      .ta-summary-grid {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        margin-bottom: 18px;
      }
      .ta-summary-card {
        border: 1px solid var(--line);
        border-radius: 18px;
        background: linear-gradient(180deg, #fffdf9, #faf4eb);
        padding: 14px 16px;
        box-shadow: 0 1px 2px rgba(60, 64, 67, 0.06);
      }
      .ta-summary-card .summary-label {
        font-size: 12px;
        color: var(--muted);
        margin-bottom: 6px;
      }
      .ta-summary-card .summary-value {
        font-size: 28px;
        font-weight: 800;
        color: var(--text);
        line-height: 1.1;
      }
      .ta-summary-card .summary-footnote {
        margin-top: 6px;
        font-size: 12px;
        color: var(--muted);
      }
      @media (min-width: 721px) {
        #ta-class-filters {
          position: sticky;
          top: 86px;
          z-index: 6;
          box-shadow: 0 10px 22px rgba(80, 62, 42, 0.08);
        }
      }
      .calendar-toolbar {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 16px;
      }
      .calendar-toolbar h2 {
        margin: 0;
      }
      .calendar-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .calendar-meta-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        margin-bottom: 18px;
      }
      .calendar-meta-card {
        padding: 14px 16px;
        border-radius: 18px;
        background: linear-gradient(180deg, #fffefb, #f8f3ec);
        border: 1px solid #e6d7bf;
      }
      .calendar-meta-label {
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 6px;
      }
      .calendar-meta-value {
        font-size: 28px;
        font-weight: 700;
        letter-spacing: -0.03em;
      }
      .calendar-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 16px;
      }
      .calendar-legend-item {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--muted);
        font-size: 13px;
      }
      .calendar-legend-swatch {
        width: 14px;
        height: 14px;
        border-radius: 6px;
        border: 1px solid var(--line);
      }
      .calendar-wrap {
        overflow: auto;
        border: 1px solid var(--line);
        border-radius: 22px;
        background: var(--panel);
      }
      .calendar-table {
        width: 100%;
        min-width: 1120px;
        border-collapse: separate;
        border-spacing: 0;
      }
      .calendar-table th,
      .calendar-table td {
        border-right: 1px solid var(--line);
        border-bottom: 1px solid var(--line);
        padding: 0;
        vertical-align: top;
        text-align: left;
        overflow: visible;
        text-overflow: clip;
      }
      .calendar-table th:last-child,
      .calendar-table td:last-child {
        border-right: 0;
      }
      .calendar-table tr:last-child td {
        border-bottom: 0;
      }
      .calendar-table th {
        position: sticky;
        top: 0;
        z-index: 2;
        background: linear-gradient(180deg, #f8efe4, #f6f0e8);
        padding: 12px 14px;
        font-size: 12px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .calendar-day {
        min-height: 180px;
        padding: 12px;
        background: #fff;
      }
      .calendar-day.is-outside {
        background: #faf8f3;
      }
      .calendar-day.is-outside .calendar-day-number {
        color: #b8ad9e;
      }
      .calendar-day-header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 8px;
        margin-bottom: 10px;
      }
      .calendar-day-number {
        font-size: 18px;
        font-weight: 700;
      }
      .calendar-day-count {
        color: var(--muted);
        font-size: 11px;
      }
      .calendar-day-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .calendar-entry {
        border-radius: 14px;
        border: 1px solid #d8dff8;
        background: #edf2ff;
        padding: 9px 10px;
        box-shadow: 0 1px 0 rgba(26, 34, 135, 0.04);
      }
      .calendar-entry.is-conflict {
        border-color: #d9b98a;
        background: #fbedd9;
      }
      .calendar-entry-time {
        font-size: 12px;
        font-weight: 700;
        color: var(--accent);
      }
      .calendar-entry.is-conflict .calendar-entry-time {
        color: #8a5f22;
      }
      .calendar-entry-name {
        margin-top: 4px;
        font-size: 13px;
        font-weight: 600;
        line-height: 1.35;
      }
      .calendar-entry-meta {
        margin-top: 4px;
        color: var(--muted);
        font-size: 11px;
        line-height: 1.4;
      }
      .calendar-empty {
        color: #b3aa9f;
        font-size: 12px;
      }
      .filters-grid {
        display: grid;
        gap: 12px 14px;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        align-items: end;
      }
      .filters-shell {
        padding: 18px;
        border-radius: 18px;
        background: linear-gradient(180deg, #fcfaf6, #f7f1e8);
        border: 1px solid #e4d5bd;
      }
      .filters-grid .actions {
        justify-content: flex-start;
        align-items: center;
      }
      .filters-actions-row {
        display: flex;
        flex-wrap: nowrap;
        gap: 8px;
        align-items: center;
      }
      .filters-actions-row .action-button {
        min-width: 110px;
        justify-content: center;
        text-align: center;
      }
      .filters-grid.pending-filters {
        grid-template-columns: repeat(3, minmax(0, 1fr)) auto;
      }
      .filters-grid.pending-filters .actions {
        white-space: nowrap;
      }
      .filters-shell.ta-compact-filters {
        padding: 12px 14px;
        border-radius: 16px;
      }
      .filters-grid.ta-compact-filters-grid {
        gap: 8px 10px;
        grid-template-columns: repeat(5, minmax(0, 1fr)) auto;
      }
      .filters-grid.ta-compact-filters-grid p {
        margin: 0;
      }
      .filters-grid.ta-compact-filters-grid label {
        font-size: 12px;
      }
      .filters-grid.ta-compact-filters-grid input,
      .filters-grid.ta-compact-filters-grid select {
        min-height: 42px;
        padding: 10px 12px;
        font-size: 13px;
      }
      .filters-grid.ta-compact-filters-grid .actions {
        align-self: end;
        white-space: nowrap;
        gap: 8px;
      }
      .filters-grid.ta-compact-filters-grid .actions .action-button {
        min-width: 88px;
        min-height: 42px;
        padding: 10px 14px;
      }
      .filters-grid.settings-inline {
        grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.2fr) auto;
      }
      .filters-grid.settings-inline .actions {
        white-space: nowrap;
      }
      @media (max-width: 1100px) {
        .filters-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .filters-grid.pending-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .filters-grid.ta-compact-filters-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .filters-grid.settings-inline { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 720px) {
        .filters-grid { grid-template-columns: 1fr; }
        .filters-grid.pending-filters { grid-template-columns: 1fr; }
        .filters-grid.ta-compact-filters-grid { grid-template-columns: 1fr; }
        .filters-grid.settings-inline { grid-template-columns: 1fr; }
        .class-card-grid { grid-template-columns: 1fr; }
        .report-grid { grid-template-columns: 1fr; }
        .report-row { grid-template-columns: 1fr; }
        .report-row-side { text-align: left; }
        .calendar-toolbar {
          align-items: flex-start;
        }
        .calendar-actions {
          width: 100%;
        }
        .calendar-meta-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .notice {
        max-width: 1360px;
        margin: 20px auto 0;
        padding: 14px 16px;
        border-radius: 16px;
        background: linear-gradient(180deg, #f4efe7, #fbf8f3);
        border: 1px solid #dcccb3;
        color: #6a532d;
        box-shadow: var(--shadow);
      }
      .notice strong {
        color: var(--accent);
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
        color: var(--accent);
        font-size: 13px;
        font-weight: 600;
      }
      .pill.nowrap {
        white-space: nowrap;
      }
      .pill.ok {
        background: rgba(26, 34, 135, 0.1);
        color: var(--accent);
      }
      .pill.bad {
        background: rgba(200, 22, 30, 0.12);
        color: var(--brand-red);
      }
      .pill.gold {
        background: rgba(210, 170, 110, 0.2);
        color: #8a5f22;
      }
      .pill.muted {
        background: rgba(136, 127, 111, 0.14);
        color: #6e665c;
      }
      .pill-stack {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
      }
      .pill-stack .pill {
        padding: 4px 9px;
        font-size: 12px;
      }
      .audit-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 6px 12px;
        border-radius: 999px;
        font-size: 12px;
        line-height: 1.2;
        font-weight: 700;
        letter-spacing: 0.01em;
        white-space: nowrap;
      }
      .audit-badge-info {
        background: rgba(26, 34, 135, 0.1);
        color: var(--accent);
      }
      .audit-badge-approve {
        background: rgba(26, 34, 135, 0.12);
        color: var(--accent);
      }
      .audit-badge-reject {
        background: rgba(200, 22, 30, 0.12);
        color: var(--brand-red);
      }
      .audit-badge-admin {
        background: rgba(210, 170, 110, 0.22);
        color: #8a5f22;
      }
      .audit-badge-warn {
        background: rgba(210, 170, 110, 0.18);
        color: #8a5f22;
      }
      .audit-badge-muted {
        background: rgba(136, 127, 111, 0.14);
        color: #6e665c;
      }
      .audit-badge-neutral {
        background: rgba(136, 127, 111, 0.12);
        color: #6e665c;
      }
      .audit-log-table td:nth-child(4),
      .audit-log-table th:nth-child(4) {
        white-space: nowrap;
      }
      .audit-log-table tr.audit-row-approve td {
        background: rgba(26, 34, 135, 0.03);
      }
      .audit-log-table tr.audit-row-reject td {
        background: rgba(200, 22, 30, 0.035);
      }
      .audit-log-table tr.audit-row-admin td,
      .audit-log-table tr.audit-row-warn td {
        background: rgba(210, 170, 110, 0.08);
      }
      .audit-log-table tr.audit-row-muted td {
        background: rgba(136, 127, 111, 0.05);
      }
      .audit-timeline {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 280px;
      }
      .audit-timeline-item {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px 10px;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: #fffdfa;
      }
      .audit-timeline-meta {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .audit-timeline-time {
        font-size: 12px;
        color: var(--muted);
      }
      .audit-timeline-actor {
        font-size: 12px;
        color: var(--muted);
      }
      .audit-timeline-empty {
        color: var(--muted);
      }
      .audit-summary-count {
        font-size: 12px;
        color: var(--muted);
        margin-top: 6px;
      }
      .stats-grid {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        margin-bottom: 20px;
      }
      .stat-card {
        padding: 18px;
        border-radius: 18px;
        border: 1px solid #e6d7bf;
        background: linear-gradient(180deg, #fffdf8, #f8f2ea);
      }
      .stat-card .stat-label {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
        margin-bottom: 8px;
      }
      .stat-card .stat-value {
        font-size: 30px;
        line-height: 1;
        font-weight: 800;
        letter-spacing: -0.03em;
        color: var(--ink);
      }
      .stat-card .stat-footnote {
        margin-top: 8px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.5;
      }
      .report-grid {
        display: grid;
        gap: 18px;
        grid-template-columns: 1.3fr 1fr;
        margin-top: 20px;
      }
      .report-card {
        border: 1px solid #e6d7bf;
        border-radius: 20px;
        background: #fff;
        padding: 18px;
      }
      .report-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .report-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 120px;
        gap: 12px;
        align-items: center;
      }
      .report-row-main {
        min-width: 0;
      }
      .report-row-title {
        font-weight: 600;
        line-height: 1.45;
      }
      .report-row-title a {
        color: var(--ink);
        text-decoration: none;
      }
      .report-row-title a:hover {
        color: var(--accent);
        text-decoration: underline;
      }
      .report-row-meta {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.5;
      }
      .report-row-side {
        text-align: right;
        white-space: nowrap;
      }
      .bar-track {
        margin-top: 6px;
        height: 8px;
        border-radius: 999px;
        background: #f1eadf;
        overflow: hidden;
      }
      .bar-fill {
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, var(--accent), var(--brand-gold));
      }
      .bar-fill.red {
        background: linear-gradient(90deg, #d6636c, var(--brand-red));
      }
      .bar-fill.gold {
        background: linear-gradient(90deg, #d8b57a, var(--brand-gold));
      }
      .report-kicker {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 8px;
      }
      .schedule-summary {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 200px;
        max-width: 260px;
      }
      .schedule-summary.schedule-summary-compact {
        min-width: 0;
        max-width: none;
        align-items: center;
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
        background: #fcfaf5;
        border: 1px solid #e9dece;
        line-height: 1.5;
      }
      .schedule-meta {
        font-size: 12px;
        color: var(--muted);
      }
      .schedule-trigger {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 34px;
        height: 30px;
        padding: 0 10px;
        border-radius: 10px;
        border: 1px solid #e4d5bd;
        background: #f7ecda;
        color: #6d4b17;
        font-size: 13px;
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
        white-space: nowrap;
      }
      .schedule-trigger:hover {
        background: #f3e3c8;
      }
      .schedule-dialog {
        border: 0;
        border-radius: 24px;
        padding: 0;
        width: min(720px, calc(100vw - 32px));
        max-height: min(88vh, 900px);
        box-shadow: 0 20px 60px rgba(32, 33, 36, 0.24);
      }
      .schedule-dialog::backdrop {
        background: rgba(32, 33, 36, 0.45);
        backdrop-filter: blur(2px);
      }
      .schedule-dialog-body {
        padding: 22px;
        overflow-y: auto;
        max-height: min(88vh, 900px);
      }
      .compact-stack {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .compact-note {
        margin-top: 8px;
        font-size: 12px;
        color: var(--muted);
        line-height: 1.6;
      }
      .submit-hint {
        display: none;
        margin-top: 12px;
        padding: 10px 12px;
        border-radius: 12px;
        background: #efe8dc;
        color: #7d5726;
        font-size: 13px;
        line-height: 1.6;
      }
      .submit-hint.show {
        display: block;
      }
      .ok { color: var(--ok); }
      .bad { color: var(--bad); }
      form.inline { display: inline; }
      label { display: block; color: var(--muted); font-size: 14px; font-weight: 500; }
      input, select, textarea {
        width: 100%;
        margin-top: 8px;
        padding: 12px 14px;
        border: 1px solid #cbbfad;
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
      select {
        appearance: none;
        background: #faf7f2;
      }
      select[multiple] {
        appearance: auto;
        min-height: 172px;
        padding: 6px 8px;
        background: #fff;
        overflow-y: auto;
      }
      select[multiple] option {
        padding: 6px 8px;
        color: var(--ink);
      }
      .multi-select-list {
        appearance: auto !important;
        -webkit-appearance: listbox !important;
        width: 100%;
        height: 244px;
        min-height: 244px;
        padding: 8px 10px;
        border: 1px solid #cbbfad;
        border-radius: 14px;
        background: #fff;
        color: var(--ink);
        line-height: 1.45;
        font-size: 14px;
        box-sizing: border-box;
        overflow-x: hidden;
        overflow-y: auto;
      }
      .multi-select-list option {
        display: block;
        min-height: 28px;
        padding: 6px 10px;
        line-height: 1.4;
        white-space: normal;
        color: var(--ink);
      }
      .multi-select-list:focus {
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
        border-radius: 12px;
        background: var(--accent);
        color: white;
        padding: 10px 16px;
        cursor: pointer;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
        font-size: 14px;
        line-height: 1.2;
        letter-spacing: 0.01em;
        box-shadow: 0 1px 2px rgba(26, 115, 232, 0.3);
        min-width: 84px;
      }
      button:hover, .button-link:hover {
        text-decoration: none;
        filter: brightness(0.98);
      }
      button.secondary {
        background: #f5ebdc;
        color: #7d5726;
        box-shadow: none;
      }
      .button-link.danger,
      button.danger {
        background: #f7d8da;
        color: var(--brand-red);
        box-shadow: none;
      }
      .button-link.text-link,
      button.text-link {
        background: transparent;
        color: var(--accent);
        box-shadow: none;
        padding-left: 0;
        padding-right: 0;
        min-width: auto;
      }
      .button-link.rect,
      button.rect {
        border-radius: 12px;
      }
      .button-link.tertiary,
      button.tertiary {
        background: #6c4dd6;
        color: #fff;
        box-shadow: none;
      }
      .action-button {
        min-width: 88px;
      }
      .table-actions-compact {
        display: flex;
        gap: 6px;
        flex-wrap: nowrap;
        justify-content: center;
      }
      .cell-compact {
        font-size: 13px;
        line-height: 1.35;
      }
      .cell-compact .name-pill-wrap {
        gap: 4px;
      }
      .table-actions-compact .action-button {
        min-width: 58px;
        padding: 7px 9px;
        font-size: 12px;
        border-radius: 9px;
      }
      .actions a,
      .actions button {
        white-space: nowrap;
      }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .table-action-cell {
        vertical-align: middle;
        text-align: center;
        overflow: visible !important;
        text-overflow: clip !important;
      }
      .table-action-cell .table-action-inner {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        flex-wrap: wrap;
        min-height: 100%;
      }
      .table-action-cell .table-action-inner.table-actions-compact {
        flex-wrap: nowrap !important;
      }
      .taadmin-classes-table .table-action-cell {
        min-width: 138px;
      }
      .taadmin-classes-table .table-actions-compact {
        width: 100%;
      }
      .table-action-inner.notifications-actions {
        display: inline-grid;
        grid-template-columns: repeat(2, minmax(84px, max-content));
        gap: 8px;
        align-items: center;
        justify-content: center;
      }
      .notification-table th,
      .notification-table td {
        white-space: nowrap;
      }
      .notification-table th:nth-child(3),
      .notification-table td:nth-child(3) {
        white-space: normal;
      }
      .notification-table .table-action-inner.notifications-actions button,
      .notification-table .table-action-inner.notifications-actions a {
        white-space: nowrap;
      }
      .table-action-inner.application-actions {
        display: inline-grid;
        grid-template-columns: repeat(2, minmax(84px, max-content));
        gap: 8px;
        align-items: center;
        justify-content: center;
      }
      .table-action-inner.notifications-actions .action-placeholder {
        display: inline-block;
        min-width: 84px;
        height: 36px;
      }
      .table-action-inner.application-actions .action-placeholder {
        display: inline-block;
        min-width: 84px;
        height: 36px;
      }
      .compact-note.reapply-note {
        color: #8a4b0f;
      }
      .mobile-only { display: none !important; }
      .notification-mobile-only { display: none !important; }
      .mobile-fab {
        position: fixed;
        right: 16px;
        bottom: 18px;
        z-index: 28;
        display: none;
        align-items: center;
        justify-content: center;
        min-width: 0;
        padding: 12px 16px;
        border-radius: 999px;
        border: 1px solid rgba(26, 34, 135, 0.18);
        background: linear-gradient(180deg, #1a2287, #2b36a3);
        color: #fff;
        box-shadow: 0 14px 28px rgba(26, 34, 135, 0.22);
        font-size: 13px;
        font-weight: 700;
      }
      .mobile-fab:hover {
        color: #fff;
        text-decoration: none;
        transform: translateY(-1px);
      }
      .filter-dialog {
        width: min(480px, calc(100vw - 16px));
        border: none;
        border-radius: 20px;
        padding: 0;
        box-shadow: 0 24px 48px rgba(0, 0, 0, 0.2);
      }
      .filter-dialog::backdrop {
        background: rgba(34, 37, 66, 0.3);
        backdrop-filter: blur(3px);
      }
      .filter-dialog-body {
        padding: 18px;
      }
      .filter-dialog-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 12px;
      }
      .filter-dialog-header h3 {
        margin: 0;
      }
      .notification-card-list {
        display: grid;
        gap: 12px;
      }
      .notification-card {
        border: 1px solid var(--line);
        border-radius: 16px;
        background: #fff;
        padding: 14px;
      }
      .notification-card-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 8px;
      }
      .notification-card h3 {
        margin: 0;
        font-size: 15px;
        line-height: 1.35;
      }
      .notification-card p {
        margin: 0 0 8px;
        font-size: 13px;
        line-height: 1.55;
        color: var(--text);
      }
      .notification-card-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 10px;
        color: var(--muted);
        font-size: 12px;
      }
      .notification-card-actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .notification-card-actions .action-placeholder {
        display: block;
        min-height: 36px;
      }
      .desktop-only { display: block !important; }
      .notification-desktop-only { display: block !important; }
      .mobile-card-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .mobile-data-card {
        border: 1px solid var(--line);
        border-radius: 18px;
        background: #fff;
        padding: 14px;
        box-shadow: 0 1px 2px rgba(60, 64, 67, 0.08);
      }
      .mobile-data-card h3 {
        margin: 0 0 10px;
        font-size: 16px;
        line-height: 1.35;
      }
      .mobile-data-card .mobile-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 10px;
      }
      .mobile-data-card .mobile-meta span {
        display: inline-flex;
        align-items: center;
        padding: 4px 8px;
        border-radius: 999px;
        background: #eef3fd;
        color: #355070;
        font-size: 11px;
      }
      .mobile-data-list {
        display: grid;
        gap: 8px;
      }
      .mobile-data-row {
        display: grid;
        grid-template-columns: 88px minmax(0, 1fr);
        gap: 10px;
        align-items: start;
      }
      .mobile-data-label {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.5;
      }
      .mobile-data-value {
        font-size: 13px;
        line-height: 1.55;
        word-break: break-word;
      }
      .split { display: grid; grid-template-columns: 2fr 1fr; gap: 18px; }
      .hero {
        display: grid;
        grid-template-columns: minmax(280px, 0.92fr) minmax(320px, 430px);
        gap: 20px;
        align-items: stretch;
      }
      .feature-card {
        position: relative;
        overflow: hidden;
      }
      .feature-card::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        width: 4px;
        background: linear-gradient(180deg, var(--brand-red), var(--brand-gold));
      }
      .feature-card h3 {
        margin-bottom: 8px;
      }
      .feature-card p {
        color: var(--muted);
        margin: 0 0 14px;
        line-height: 1.6;
        font-size: 14px;
      }
      .feature-card .actions {
        margin-top: auto;
      }
      .home-summary {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) auto;
        gap: 18px;
        align-items: center;
      }
      .home-summary-main {
        min-width: 0;
      }
      .home-summary-title {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
      }
      .home-summary-title h2 {
        margin: 0;
      }
      .home-summary-subtitle {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
      }
      .home-role-chip {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--brand-gold-soft);
        color: #7d5726;
        font-size: 12px;
        font-weight: 700;
      }
      .home-user-name {
        font-size: 18px;
        font-weight: 700;
        color: var(--ink);
      }
      .dashboard-grid {
        display: grid;
        gap: 14px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .dashboard-grid .feature-card {
        min-height: 186px;
        padding: 20px;
      }
      .dashboard-grid .button-link {
        min-width: 72px;
        padding: 9px 14px;
      }
      .hero-panel {
        min-height: 360px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        background:
          linear-gradient(135deg, rgba(26, 34, 135, 0.95), rgba(26, 34, 135, 0.82) 48%, rgba(200, 22, 30, 0.78)),
          linear-gradient(160deg, var(--brand-gold-soft), #fff);
        color: #fff;
        padding: 28px 34px;
      }
      .hero-panel::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at 18% 22%, rgba(255,255,255,0.16), transparent 22%),
          radial-gradient(circle at 80% 14%, rgba(255,255,255,0.1), transparent 18%),
          linear-gradient(135deg, transparent 0 58%, rgba(255,255,255,0.06) 58% 72%, transparent 72%);
        pointer-events: none;
      }
      .hero-panel > * {
        position: relative;
        z-index: 1;
      }
      .hero-logo {
        width: min(250px, 48%);
        max-width: 100%;
        aspect-ratio: 1457 / 2279;
        height: auto;
        margin: 0 0 16px;
        object-fit: contain;
        object-position: left top;
        filter: drop-shadow(0 10px 24px rgba(0, 0, 0, 0.18));
      }
      .hero-panel .hero-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 8px;
      }
      .hero-panel .hero-pills span {
        display: inline-flex;
        align-items: center;
        padding: 5px 10px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.16);
        color: #fff;
        font-size: 11px;
        font-weight: 600;
        border: 1px solid rgba(255,255,255,0.18);
      }
      .hero-panel h2 {
        font-size: 28px;
        line-height: 1.15;
        margin-bottom: 12px;
      }
      .hero-panel p {
        margin: 0 0 10px;
        color: rgba(255, 255, 255, 0.9);
        line-height: 1.6;
        font-size: 14px;
      }
      .login-card {
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-height: 360px;
        background: linear-gradient(180deg, #ffffff, #fbf8f3);
        padding: 28px 32px;
      }
      .page-login main {
        max-width: 1280px;
      }
      .page-login .hero {
        position: relative;
        display: block;
      }
      .page-login .hero-panel {
        min-height: 560px;
        padding: 34px 470px 32px 36px;
        border-radius: 32px;
      }
      .page-login .login-card {
        position: absolute;
        top: 50%;
        right: 32px;
        z-index: 2;
        transform: translateY(-50%);
        width: min(440px, calc(100% - 64px));
        margin-left: 0;
        min-height: auto;
        padding: 34px 30px;
        border-radius: 28px;
        background: linear-gradient(180deg, rgba(255,255,255,0.80), rgba(255,255,255,0.68));
        border: 1px solid rgba(255,255,255,0.62);
        backdrop-filter: blur(18px) saturate(1.08);
        -webkit-backdrop-filter: blur(18px) saturate(1.08);
        box-shadow: 0 18px 36px rgba(32, 30, 60, 0.16);
      }
      .page-login .login-shell {
        width: 100%;
      }
      .page-login .login-card .actions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .page-login .login-card .actions .button-link,
      .page-login .login-card .actions button {
        width: 100%;
        justify-content: center;
      }
      .login-card .muted {
        margin-bottom: 18px;
      }
      .page-login .login-card h2 {
        font-size: 20px;
      }
      .page-login .login-card .muted {
        font-size: 14px;
        line-height: 1.55;
      }
      .page-login .login-card form p {
        margin-bottom: 16px;
      }
      .page-login .login-card input {
        min-height: 44px;
      }
      .page-login .login-card .actions {
        margin-top: 10px;
      }
      .page-login .mobile-login-copy {
        display: none;
      }
      .login-card form p {
        margin: 0 0 14px;
      }
      .login-card input {
        margin-top: 6px;
      }
      .login-card .actions {
        margin-top: 6px;
      }
      .login-shell {
        width: min(100%, 360px);
      }
      .login-shell h2 {
        margin-bottom: 10px;
      }
      .login-shell .button-link,
      .login-shell button {
        min-width: 104px;
      }
      @media (max-width: 900px) {
        .topbar { padding-left: 18px; padding-right: 18px; align-items: flex-start; flex-direction: column; }
        main { padding-left: 18px; padding-right: 18px; }
        .split, .hero { grid-template-columns: 1fr; }
        .hero-panel, .login-card { min-height: auto; padding: 22px 22px; }
        .login-shell { width: 100%; }
        .page-login .hero {
          display: grid;
          grid-template-columns: 1fr;
          gap: 12px;
        }
        .page-login .hero-panel {
          min-height: auto;
          padding: 22px 20px 20px;
          border-radius: 24px;
        }
        .page-login .login-card {
          position: relative;
          top: auto;
          right: auto;
          transform: none;
          width: 100%;
          margin-left: 0;
          padding: 20px 18px;
          border-radius: 24px;
          background: linear-gradient(180deg, rgba(255,255,255,0.96), rgba(251,248,243,0.94));
          border-color: rgba(221,213,202,0.92);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          box-shadow: var(--shadow);
        }
        .nav-links {
          width: 100%;
          flex-wrap: nowrap;
          overflow-x: auto;
          padding-bottom: 4px;
          justify-content: flex-start;
        }
        .nav-links::-webkit-scrollbar {
          height: 6px;
        }
        .nav-links::-webkit-scrollbar-thumb {
          background: #d6dfef;
          border-radius: 999px;
        }
        .card {
          padding: 18px;
          border-radius: 20px;
        }
        .table-wrap {
          margin-left: -6px;
          margin-right: -6px;
          padding-left: 6px;
          padding-right: 6px;
        }
        table.compact-table th {
          font-size: 10px;
          padding: 9px 7px;
        }
        table.compact-table td {
          font-size: 12px;
          padding: 9px 7px;
        }
        button, .button-link {
          min-width: 76px;
          padding: 10px 14px;
          font-size: 13px;
        }
      }
      @media (max-width: 720px) {
        body {
          font-size: 14px;
        }
        #ta-class-filters {
          display: none !important;
        }
        .site-header {
          position: sticky;
          top: 0;
          z-index: 30;
          backdrop-filter: blur(10px);
        }
        .topbar {
          padding: 12px 14px 10px;
          gap: 10px;
        }
        .topbar-left {
          width: 100%;
          align-items: flex-start;
          gap: 10px;
        }
        .back-button {
          min-width: 62px;
          height: 34px;
          padding: 0 12px;
          font-size: 12px;
        }
        .brand {
          width: 100%;
          align-items: flex-start;
          min-width: 0;
          flex: 1 1 auto;
          gap: 10px;
        }
        .brand-logo {
          width: 208px;
          max-width: 52vw;
        }
        .brand h1,
        .brand-text h1 {
          font-size: 18px;
          white-space: normal;
          line-height: 1.15;
        }
        .brand p,
        .brand-text p {
          font-size: 11px;
        }
        .brand-text .role-line div {
          white-space: normal;
        }
        .nav-links {
          gap: 6px;
          padding-bottom: 2px;
          align-items: center;
        }
        .nav-links a {
          font-size: 12px;
          padding: 8px 10px;
          border-radius: 999px;
          flex: 0 0 auto;
        }
        main {
          padding: 14px 12px 28px;
        }
        .notice {
          margin-top: 10px;
          border-radius: 14px;
          padding: 10px 12px;
          font-size: 13px;
        }
        .card {
          padding: 14px;
          border-radius: 16px;
          margin-bottom: 12px;
        }
        .home-summary {
          grid-template-columns: 1fr;
          gap: 10px;
        }
        .dashboard-grid {
          grid-template-columns: 1fr;
        }
        .dashboard-grid .feature-card {
          min-height: auto;
        }
        .hero-logo {
          width: min(180px, 54%);
        }
        .hero-panel h2 {
          font-size: 21px;
        }
        .hero-panel p {
          font-size: 12px;
        }
        h2 {
          font-size: 19px;
        }
        h3 {
          font-size: 16px;
        }
        .grid {
          grid-template-columns: 1fr;
        }
        .class-card-grid {
          grid-template-columns: 1fr;
          gap: 12px;
        }
        .hero-logo {
          width: min(190px, 72%);
          margin-bottom: 14px;
        }
        .hero-panel .hero-pills span {
          font-size: 11px;
          padding: 5px 8px;
        }
        .class-card {
          padding: 13px 13px 11px;
        }
        .feature-card::before {
          width: 3px;
        }
        .class-card h3 {
          font-size: 15px;
        }
        .class-card p {
          font-size: 12px;
          margin-bottom: 5px;
        }
        .class-card-meta {
          gap: 5px;
          margin-bottom: 6px;
        }
        .class-card-meta span {
          font-size: 10px;
          padding: 4px 7px;
        }
        label {
          font-size: 13px;
        }
        input, select, textarea {
          padding: 10px 11px;
          border-radius: 12px;
        }
        .login-card input,
        .login-card select,
        .login-card textarea {
          font-size: 16px;
        }
        .hero-panel,
        .login-card {
          padding: 18px 16px;
        }
        .page-login .topbar {
          padding-top: 10px;
          padding-bottom: 8px;
        }
        .page-login .topbar-left {
          gap: 8px;
        }
        .page-login .brand {
          gap: 10px;
          min-width: 0;
        }
        .page-login .brand-logo {
          width: 180px;
          max-width: 44vw;
        }
        .page-login .brand-text h1 {
          font-size: 17px;
        }
        .page-login .brand-text p {
          font-size: 10px;
          line-height: 1.35;
        }
        .page-login .hero-panel {
          min-height: auto;
          padding: 16px 14px 14px;
        }
        .page-login .login-card {
          min-height: auto;
          padding: 14px 14px 16px;
        }
        .page-login .hero {
          display: block;
          overflow: visible;
          border-radius: 0;
          background: transparent;
          box-shadow: none;
        }
        .page-login .hero-panel,
        .page-login .login-card {
          margin: 0;
          box-shadow: var(--shadow);
        }
        .page-login .hero {
          display: block;
          overflow: visible;
          border-radius: 0;
          background: transparent;
          box-shadow: none;
          padding-top: 0;
          margin: 0;
        }
        .page-login .hero-panel {
          position: relative;
          min-height: 620px;
          padding: 18px 16px 160px;
          border-radius: 22px;
          box-shadow: var(--shadow);
          overflow: hidden;
        }
        .page-login .login-card {
          position: absolute;
          left: 16px;
          right: 16px;
          top: 210px;
          margin: 0 auto;
          width: auto;
          border-top: 0;
          border-radius: 22px;
          background: linear-gradient(180deg, rgba(255,255,255,0.82), rgba(251,248,243,0.76));
          border: 1px solid rgba(255,255,255,0.6);
          backdrop-filter: blur(18px) saturate(1.06);
          -webkit-backdrop-filter: blur(18px) saturate(1.06);
          box-shadow: 0 16px 28px rgba(32, 30, 60, 0.14);
          z-index: 2;
        }
        .page-login .hero-panel h2,
        .page-login .hero-panel p,
        .page-login .hero-panel .hero-pills {
          display: none;
        }
        .page-login .hero-logo {
          display: block;
          width: min(164px, 48%);
          margin-bottom: 0;
        }
        .page-login .login-shell h2 {
          margin-bottom: 10px;
        }
        .page-login .login-card .muted {
          margin-bottom: 12px;
          font-size: 12px;
        }
        .login-shell {
          max-width: 100%;
        }
        .login-shell .actions {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        .filters-shell,
        .filters-card {
          padding: 14px;
        }
        .filters-shell.ta-compact-filters {
          padding: 10px 12px;
        }
        .filters-actions-row,
        .filters-actions {
          width: 100%;
          justify-content: stretch;
          gap: 8px;
          flex-wrap: wrap;
        }
        .filters-actions-row button,
        .filters-actions-row a,
        .filters-actions button,
        .filters-actions a {
          flex: 1 1 calc(50% - 4px);
          min-width: 0;
        }
        .filters-grid.ta-compact-filters-grid {
          gap: 8px;
        }
        .filters-grid.ta-compact-filters-grid .actions {
          width: 100%;
        }
        .filters-grid.ta-compact-filters-grid .actions .action-button {
          min-width: 0;
        }
        .actions {
          width: 100%;
          gap: 8px;
        }
        .actions a,
        .actions button {
          flex: 1 1 auto;
        }
        .schedule-dialog {
          width: calc(100vw - 16px);
          border-radius: 18px;
        }
        .schedule-dialog-body {
          padding: 16px;
        }
        .desktop-only {
          display: none !important;
        }
        .mobile-only {
          display: block !important;
        }
        .notification-desktop-only {
          display: none !important;
        }
        .notification-mobile-only {
          display: block !important;
        }
        .mobile-data-card {
          padding: 12px;
          border-radius: 16px;
        }
        .mobile-data-card h3 {
          font-size: 15px;
          margin-bottom: 8px;
        }
        .mobile-data-row {
          grid-template-columns: 72px minmax(0, 1fr);
          gap: 8px;
        }
        .mobile-data-label {
          font-size: 11px;
        }
        .mobile-data-value {
          font-size: 12px;
        }
        .mobile-fab {
          display: inline-flex;
        }
        .ta-summary-grid,
        .stats-grid,
        .calendar-meta-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }
        .summary-card,
        .stat-card,
        .calendar-meta-card {
          padding: 12px;
          min-height: auto;
        }
        .summary-value,
        .stat-value,
        .calendar-meta-value {
          font-size: 24px;
        }
        .report-grid {
          grid-template-columns: 1fr;
          gap: 12px;
        }
        .report-card {
          padding: 14px;
        }
        .calendar-shell {
          padding: 14px;
        }
        .calendar-grid {
          gap: 8px;
        }
        .calendar-day {
          min-height: 120px;
          padding: 10px;
        }
        .calendar-event {
          font-size: 11px;
          padding: 6px 7px;
        }
        .notification-card {
          padding: 12px;
        }
        .notification-card-actions {
          grid-template-columns: 1fr;
        }
        .page-login .mobile-login-copy {
          display: block;
          position: absolute;
          left: 16px;
          right: 16px;
          bottom: 16px;
          margin: 0;
          padding: 0;
          border-radius: 0;
          background: transparent;
          color: #fff;
          box-shadow: none;
          z-index: 1;
        }
        .page-login .mobile-login-copy h3 {
          margin: 0 0 8px;
          font-size: 15px;
          line-height: 1.2;
        }
        .page-login .mobile-login-copy p {
          margin: 0 0 10px;
          font-size: 11px;
          line-height: 1.5;
          color: rgba(255,255,255,0.88);
        }
        .page-login .mobile-login-copy .hero-pills {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .page-login .mobile-login-copy .hero-pills span {
          display: inline-flex;
          align-items: center;
          padding: 4px 8px;
          border-radius: 999px;
          background: rgba(255,255,255,0.16);
          color: #fff;
          font-size: 10px;
          font-weight: 600;
          border: 1px solid rgba(255,255,255,0.18);
        }
      }
      @media (max-width: 520px) {
        .topbar {
          padding: 10px 10px 8px;
        }
        .topbar-left {
          gap: 8px;
        }
        .back-button {
          min-width: 56px;
          height: 32px;
          padding: 0 10px;
          font-size: 11px;
        }
        .brand-logo {
          width: 168px;
          max-width: 46vw;
        }
        .brand h1,
        .brand-text h1 {
          font-size: 16px;
        }
        .nav-links a {
          font-size: 11px;
          padding: 7px 9px;
        }
        main {
          padding: 12px 10px 24px;
        }
        .card,
        .filters-shell,
        .filters-card,
        .report-card,
        .calendar-shell {
          padding: 12px;
        }
        .login-shell .actions,
        .filters-actions-row button,
        .filters-actions-row a,
        .filters-actions button,
        .filters-actions a {
          flex-basis: 100%;
        }
        .ta-summary-grid,
        .stats-grid,
        .calendar-meta-grid {
          grid-template-columns: 1fr;
        }
        .summary-value,
        .stat-value,
        .calendar-meta-value {
          font-size: 22px;
        }
        .calendar-day {
          min-height: 102px;
          padding: 8px;
        }
        .mobile-data-row {
          grid-template-columns: 64px minmax(0, 1fr);
        }
        .mobile-fab {
          right: 12px;
          bottom: 14px;
          padding: 11px 14px;
          font-size: 12px;
        }
        .notification-card h3 {
          font-size: 14px;
        }
        .notification-card p {
          font-size: 12px;
        }
        .page-login .brand-logo {
          width: 150px;
          max-width: 40vw;
        }
        .page-login .brand-text h1 {
          font-size: 15px;
        }
        .page-login .brand-text p {
          font-size: 9px;
        }
        .page-login .hero-panel,
        .page-login .login-card,
        .page-login .card {
          padding: 12px;
        }
        .page-login .hero {
          border-radius: 0;
          padding-top: 0;
        }
        .page-login .hero-panel {
          border-radius: 18px;
          min-height: 540px;
          padding: 14px 14px 104px;
        }
        .page-login .login-card {
          position: absolute;
          left: 12px;
          right: 12px;
          top: 74px;
          margin: 0 auto;
          padding-top: 12px;
          border-radius: 18px;
        }
        .page-login .login-shell .actions {
          grid-template-columns: 1fr;
        }
        .page-login .mobile-login-copy {
          left: 12px;
          right: 12px;
          bottom: 12px;
          padding: 0;
          border-radius: 0;
        }
        .page-login .hero-logo {
          width: min(150px, 46%);
        }
        .page-login .mobile-login-copy h3 {
          font-size: 14px;
        }
        .page-login .mobile-login-copy p {
          font-size: 10px;
        }
      }
    </style>
  </head>
  <body class="${pageClass}">
    <header>
      <div class="topbar">
        <div class="topbar-left">
          ${backButton}
          <div class="brand">
            <img class="brand-logo" src="${SAIF_LOGO_HORIZONTAL}" alt="SAIF Logo">
            <div class="brand-text">
              <h1>TA 选课系统</h1>
              ${user
                ? `<div class="role-line"><div>当前角色：${escapeHtml(user.role)}</div><div>· ${escapeHtml(user.user_name)}</div></div>`
                : `<p>上海高级金融学院 Teaching Assistant Course Assignment Platform</p>`}
            </div>
          </div>
        </div>
        ${nav}
      </div>
    </header>
    ${noticeBlock}
    <main>${body}</main>
    <script>
      const backButton = document.querySelector('.back-button');
      if (backButton && (window.location.pathname === '/' || window.location.pathname === '/login')) {
        backButton.classList.add('is-hidden');
      }
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
      document.addEventListener('submit', (event) => {
        const form = event.target.closest('form[data-disable-on-submit]');
        if (!form) return;
        const submitButton = form.querySelector('button[type="submit"]');
        if (submitButton) {
          submitButton.disabled = true;
          submitButton.textContent = '提交中...';
        }
        const hintTarget = form.getAttribute('data-submit-hint-target');
        if (hintTarget) {
          const hint = document.getElementById(hintTarget);
          if (hint) hint.classList.add('show');
        }
      });
    </script>
  </body>
  </html>`;
}

function loginPage(res, notice) {
  const ssoEnabled = isSsoConfigured();
  const body = `
    <div class="hero">
      <section class="card hero-panel">
        <img class="hero-logo" src="${SAIF_LOGO_VERTICAL}" alt="SAIF Logo">
        <h2>TA选课申请系统</h2>
        <p>系统覆盖 TA 申请、TAAdmin 初审、Professor 终审、教学班开放时间控制，以及课程与人员管理。</p>
        <p>当前版本已支持多条排课记录、附件上传、站内通知、批量设置和批量删除等核心流程。</p>
        <div class="hero-pills">
          <span>TA 申请</span>
          <span>TAAdmin 审核</span>
          <span>Professor 终审</span>
          <span>手机端可用</span>
        </div>
      </section>
      <section class="card login-card">
        <div class="login-shell">
          <h2>登录</h2>
          <p class="muted">你可以选择本地账号密码登录，或通过 SSO 统一身份认证登录。</p>
          <form method="post" action="/login">
            <p><label>账号<input name="login_name" autocomplete="username" required /></label></p>
            <p><label>密码<input name="password" type="password" autocomplete="current-password" required /></label></p>
            <div class="actions">
              <button type="submit">登录</button>
              ${ssoEnabled ? `<a class="button-link secondary action-button" href="/login/sso">SSO 登录</a>` : ""}
            </div>
          </form>
          ${!ssoEnabled ? `<p class="muted" style="margin-top:12px;">当前未配置 SSO，暂仅支持本地登录。</p>` : ""}
        </div>
      </section>
      <section class="mobile-login-copy">
        <h3>TA选课申请系统</h3>
        <p>系统覆盖 TA 申请、TAAdmin 初审、Professor 终审、教学班开放时间控制，以及课程与人员管理。</p>
        <div class="hero-pills">
          <span>TA 申请</span>
          <span>TAAdmin 审核</span>
          <span>Professor 终审</span>
        </div>
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
  const rows = schedules.map((row) => `<tr><td>${escapeHtml(normalizeDisplayDate(row.lesson_date))}</td><td>${escapeHtml(row.start_time)}</td><td>${escapeHtml(row.end_time)}</td><td>${escapeHtml(row.section)}</td><td>${escapeHtml(row.is_exam || "")}</td></tr>`).join("");
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
        if (normalizeDisplayDate(t.lesson_date) === normalizeDisplayDate(e.lesson_date) && hasTimeConflict(t.start_time, t.end_time, e.start_time, e.end_time)) {
          matches.push(`${normalizeDisplayDate(t.lesson_date)} ${t.start_time}-${t.end_time} vs ${e.start_time}-${e.end_time}`);
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
        if (normalizeDisplayDate(t.lesson_date) === normalizeDisplayDate(e.lesson_date) && hasTimeConflict(t.start_time, t.end_time, e.start_time, e.end_time)) {
          matches.push(`${normalizeDisplayDate(t.lesson_date)} ${t.start_time}-${t.end_time} vs ${e.start_time}-${e.end_time}`);
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

function isActiveApplicationStatus(status) {
  return activeApplicationStatuses.has(String(status || ""));
}

function isReapplyAllowedStatus(status) {
  return reapplyAllowedStatuses.has(String(status || ""));
}

function getLatestApplicationMap(db, taUserId) {
  const rows = db.prepare(`
    select *
    from applications
    where applier_user_id = ?
    order by submitted_at desc, application_id desc
  `).all(taUserId);
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.class_id)) {
      map.set(row.class_id, row);
    }
  }
  return map;
}

function getLatestApplicationMapFromRows(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!map.has(row.class_id)) {
      map.set(row.class_id, row);
    }
  }
  return map;
}

function buildScheduleMapFromRows(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!map.has(row.class_id)) map.set(row.class_id, []);
    map.get(row.class_id).push(row);
  }
  return map;
}

function buildClassMapFromRows(rows) {
  return new Map((rows || []).map((row) => [row.class_id, row]));
}

function getAppliedConflictsFromData(applications, classMap, scheduleMap, classId) {
  const target = scheduleMap.get(classId) || [];
  return (applications || []).flatMap((app) => {
    if (["RejectedByTAAdmin", "RejectedByProfessor", "Withdrawn"].includes(app.status)) {
      return [];
    }
    if (app.class_id === classId) {
      return [];
    }
    const existing = scheduleMap.get(app.class_id) || [];
    const matches = [];
    for (const t of target) {
      for (const e of existing) {
        if (normalizeDisplayDate(t.lesson_date) === normalizeDisplayDate(e.lesson_date) && hasTimeConflict(t.start_time, t.end_time, e.start_time, e.end_time)) {
          matches.push(`${normalizeDisplayDate(t.lesson_date)} ${t.start_time}-${t.end_time} vs ${e.start_time}-${e.end_time}`);
        }
      }
    }
    if (!matches.length) return [];
    return [{
      ...app,
      is_conflict_allowed: classMap.get(app.class_id)?.is_conflict_allowed || "N",
      matches
    }];
  });
}

function getOpenClassConflictsFromData(openClasses, applications, scheduleMap, classId) {
  const target = scheduleMap.get(classId) || [];
  return (openClasses || []).flatMap((classRow) => {
    if (classRow.class_id === classId) return [];
    const existing = scheduleMap.get(classRow.class_id) || [];
    const matches = [];
    for (const t of target) {
      for (const e of existing) {
        if (normalizeDisplayDate(t.lesson_date) === normalizeDisplayDate(e.lesson_date) && hasTimeConflict(t.start_time, t.end_time, e.start_time, e.end_time)) {
          matches.push(`${normalizeDisplayDate(t.lesson_date)} ${t.start_time}-${t.end_time} vs ${e.start_time}-${e.end_time}`);
        }
      }
    }
    if (!matches.length) return [];
    const relatedApplication = (applications || []).find((app) => app.class_id === classRow.class_id) || null;
    return [{
      classRow,
      relatedApplication,
      matches
    }];
  });
}

function compactScheduleList(schedules) {
  if (!schedules.length) {
    return "<p class='muted'>暂无排课信息。</p>";
  }
  return `<div class="compact-stack">${schedules.map((row) => `
    <div class="schedule-item">
      <div>${escapeHtml(normalizeDisplayDate(row.lesson_date))} ${escapeHtml(row.start_time)}-${escapeHtml(row.end_time)}</div>
      <div class="schedule-meta">${escapeHtml(row.section)}${row.is_exam ? ` · ${escapeHtml(row.is_exam)}` : ""}</div>
    </div>
  `).join("")}</div>`;
}

function compactConflictList(conflicts) {
  if (!conflicts.length) {
    return "<p class='ok'>当前无冲突。</p>";
  }
  return `<div class="compact-stack">${conflicts.map(({ classRow, relatedApplication, matches }) => `
    <div class="schedule-item">
      <div>${escapeHtml(classRow.class_name)}</div>
      <div class="schedule-meta">${escapeHtml(classRow.course_name)} / ${escapeHtml(classRow.teacher_name)}</div>
      <div class="schedule-meta">我的状态：${escapeHtml(relatedApplication ? (statusLabels[relatedApplication.status] || relatedApplication.status) : "未申请")}</div>
      <div class="schedule-meta">${matches.map(escapeHtml).join("<br>")}</div>
    </div>
  `).join("")}</div>`;
}

function renderAppliedConflictSection(appliedConflicts, isConflictAllowed) {
  if (!appliedConflicts.length) {
    return "";
  }
  const noticeStyle = isConflictAllowed === "Y"
    ? "margin: 0 0 16px; background: #fff6e8; border-color: #ead0a0; color: #8b5b00;"
    : "margin: 0 0 16px; background: #fce8e6; border-color: #f7c8c3; color: #a50e0e;";
  const noticeText = isConflictAllowed === "Y"
    ? "检测到你已申请的教学班与当前教学班存在时间冲突，但本教学班已设置为允许冲突申请，因此你仍可继续提交申请。"
    : "检测到你已申请的教学班与当前教学班存在时间冲突，且本教学班未设置为允许冲突申请，因此当前不能提交申请。";
  const rows = appliedConflicts.map((app) => `<tr><td>${escapeHtml(app.class_name)}</td><td>${escapeHtml(statusLabels[app.status] || app.status)}</td><td>${escapeHtml(app.is_conflict_allowed || "N")}</td><td>${app.matches.map(escapeHtml).join("<br>")}</td></tr>`).join("");
  return `
    <div class="notice" style="${noticeStyle}">
      ${noticeText}
    </div>
    <table><tr><th>已申请冲突教学班</th><th>当前状态</th><th>是否允许冲突申请</th><th>冲突时间</th></tr>${rows}</table>
  `;
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
    <section class="card card-brand">
      <div class="home-summary">
        <div class="home-summary-main">
          <div class="home-summary-title">
            <h2>当前用户</h2>
            <span class="home-role-chip">${escapeHtml(user.role)}</span>
          </div>
          <div class="home-user-name">${escapeHtml(user.user_name)}</div>
          <p class="home-summary-subtitle">当前系统已接入 TA 申请、TAAdmin 审核、Professor 终审、教学班与人员管理，并支持邮件通知、导入和手机端访问。</p>
        </div>
      </div>
    </section>
  `;
  if (user.role === "TA") {
    body += `<section class="dashboard-grid">
      <article class="card card-brand feature-card"><h3>可申请教学班</h3><p>浏览开放教学班、查看冲突情况并提交申请。</p><div class="actions"><a class="button-link" href="/ta/classes">进入</a></div></article>
      <article class="card card-brand feature-card"><h3>我的申请</h3><p>查看申请状态，并在 TAAdmin 审批前撤销申请。</p><div class="actions"><a class="button-link" href="/ta/applications">进入</a></div></article>
      <article class="card card-brand feature-card"><h3>个人资料</h3><p>维护个人简历，申请时自动带出最新简历。</p><div class="actions"><a class="button-link" href="/ta/profile">进入</a></div></article>
    </section>`;
  } else if (user.role === "TAAdmin") {
    body += `<section class="dashboard-grid">
      <article class="card card-brand feature-card"><h3>报表视图</h3><p>集中查看申请、审批、教学班开放与名额使用情况。</p><div class="actions"><a class="button-link" href="/course/reports">进入</a></div></article>
      <article class="card card-brand feature-card"><h3>待初审申请</h3><p>集中处理当前待 TAAdmin 审批的学生申请。</p><div class="actions"><a class="button-link" href="/admin/ta/pending">进入</a></div></article>
      <article class="card card-brand feature-card"><h3>全部申请</h3><p>查看所有 TA 申请状态并追踪历史审批情况。</p><div class="actions"><a class="button-link" href="/admin/ta/applications">进入</a></div></article>
      <article class="card card-brand feature-card"><h3>全部教学班</h3><p>按教学班查看申请、发布至教授并发送邮件。</p><div class="actions"><a class="button-link" href="/admin/ta/classes">进入</a></div></article>
      <article class="card card-brand feature-card"><h3>TA 管理</h3><p>查看 TA 名单并维护 TA 申请资格。</p><div class="actions"><a class="button-link" href="/admin/ta/users">进入</a></div></article>
    </section>`;
  } else if (user.role === "Professor") {
    body += `<section class="dashboard-grid"><article class="card card-brand feature-card"><h3>待教授审批</h3><p>按教学班查看待终审申请，并在达到名额上限时自动完成其余申请处理。</p><div class="actions"><a class="button-link" href="/professor/pending">进入</a></div></article></section>`;
  } else if (user.role === "CourseAdmin") {
    body += `<section class="dashboard-grid">
      <article class="card card-brand feature-card"><h3>报表视图</h3><p>集中查看申请、审批、教学班开放与名额使用情况。</p><div class="actions"><a class="button-link" href="/course/reports">进入</a></div></article>
      <article class="card card-brand feature-card"><h3>全部申请</h3><p>查看全量申请并在必要时进行管理性状态调整。</p><div class="actions"><a class="button-link" href="/course/applications">进入</a></div></article>
      <article class="card card-brand feature-card"><h3>教学班管理</h3><p>维护教学班、排课、导入和批量操作。</p><div class="actions"><a class="button-link" href="/course/classes">进入</a></div></article>
      <article class="card card-brand feature-card"><h3>人员管理</h3><p>新增、编辑、导入和维护系统角色人员。</p><div class="actions"><a class="button-link" href="/course/users">进入</a></div></article>
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

function buildQueryString(params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value) !== "") {
      search.set(key, String(value));
    }
  });
  const result = search.toString();
  return result ? `?${result}` : "";
}

function sortableHeader(label, field, basePath, filters, currentSortBy, currentSortOrder) {
  const nextOrder = currentSortBy === field && currentSortOrder === "asc" ? "desc" : "asc";
  const arrow = currentSortBy === field ? (currentSortOrder === "asc" ? " ↑" : " ↓") : "";
  const href = `${basePath}${buildQueryString({ ...filters, sort_by: field, sort_order: nextOrder })}`;
  const activeClass = currentSortBy === field ? "active-sort" : "";
  return `<a class="${activeClass}" href="${href}">${escapeHtml(label)}${arrow}</a>`;
}

function loadCourseAdminClassRows(db, filters = {}) {
  const classCodeFilter = String(filters.class_code || "").trim().toLowerCase();
  const classNameFilter = String(filters.class_name || "").trim().toLowerCase();
  const teacherFilter = String(filters.teacher_name || "").trim().toLowerCase();
  const statusFilter = String(filters.status_filter || "").trim();
  const taFullFilter = String(filters.ta_full || "").trim();
  const sortBy = String(filters.sort_by || "class_code");
  const sortOrder = String(filters.sort_order || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  const rowsRaw = db.prepare(`
    select c.*,
      (select count(*) from applications a where a.class_id = c.class_id) as application_count,
      (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count,
      (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingTAAdmin') as pending_taadmin_count,
      (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingProfessor') as pending_professor_count,
      (select group_concat(a.applier_name, '；') from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_ta_names
    from classes c
  `).all();
  const sortValueMap = {
    class_code: (row) => String(row.class_code || "").toLowerCase(),
    class_name: (row) => String(row.class_name || "").toLowerCase(),
    teacher_name: (row) => String(row.teacher_name || "").toLowerCase(),
    ta_full: (row) => (Number(row.approved_count || 0) >= Number(row.maximum_number_of_tas_admitted || 0) ? 1 : 0),
    status_filter: (row) => String(classOpenStatus(row)),
    approved_count: (row) => Number(row.approved_count || 0),
    application_count: (row) => Number(row.application_count || 0)
  };
  return rowsRaw
    .filter((row) => !classCodeFilter || String(row.class_code || "").toLowerCase().includes(classCodeFilter))
    .filter((row) => !classNameFilter || String(row.class_name || "").toLowerCase().includes(classNameFilter))
    .filter((row) => !teacherFilter || String(row.teacher_name || "").toLowerCase().includes(teacherFilter))
    .filter((row) => !statusFilter || classOpenStatus(row) === statusFilter)
    .filter((row) => {
      const isFull = Number(row.approved_count || 0) >= Number(row.maximum_number_of_tas_admitted || 0);
      if (!taFullFilter) return true;
      return taFullFilter === "Y" ? isFull : !isFull;
    })
    .sort((a, b) => {
      const getter = sortValueMap[sortBy] || sortValueMap.class_code;
      const av = getter(a);
      const bv = getter(b);
      if (av < bv) return sortOrder === "asc" ? -1 : 1;
      if (av > bv) return sortOrder === "asc" ? 1 : -1;
      return String(a.class_code || "").localeCompare(String(b.class_code || ""), "zh-Hans-CN");
    });
}

function loadTaAdminClassRows(db, filters = {}) {
  const professorFilter = String(filters.professor_name || "").trim().toLowerCase();
  const classNameFilter = String(filters.class_name || "").trim().toLowerCase();
  const semesterFilter = String(filters.semester || "").trim().toLowerCase();
  const taFullFilter = String(filters.ta_full || "").trim();
  const hasPendingFilter = String(filters.has_pending || "").trim();
  const publishedFilter = String(filters.published_to_professor || "").trim();
  const taAllowedFilter = String(filters.ta_applications_allowed || "").trim();
  const conflictAllowedFilter = String(filters.is_conflict_allowed || "").trim();
  const rowsRaw = db.prepare(`
    select c.*,
      (select count(*) from applications a where a.class_id = c.class_id) as application_count,
      (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingTAAdmin') as pending_taadmin_count,
      (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingProfessor') as pending_professor_count,
      (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count,
      (select group_concat(a.applier_name, '；') from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_ta_names
    from classes c
    order by c.semester, c.course_name, c.class_name
  `).all();
  for (const row of rowsRaw) {
    if (isClassCapacityReached(row, row.approved_count) && row.ta_applications_allowed !== "N") {
      row.ta_applications_allowed = "N";
    }
    if (Number(row.pending_taadmin_count || 0) > 0 && row.published_to_professor === "Y") {
      row.published_to_professor = "N";
      row.professor_notified_at = null;
    }
  }
  return rowsRaw.filter((row) => {
    const matchesProfessor = !professorFilter || String(row.teacher_name || "").toLowerCase().includes(professorFilter);
    const matchesClassName = !classNameFilter || String(row.class_name || "").toLowerCase().includes(classNameFilter);
    const matchesSemester = !semesterFilter || String(row.semester || "").toLowerCase().includes(semesterFilter);
    const isFull = isClassCapacityReached(row, row.approved_count);
    const matchesTaFull = !taFullFilter || (taFullFilter === "Y" ? isFull : !isFull);
    const hasPending = Number(row.pending_taadmin_count || 0) > 0;
    const matchesPending = !hasPendingFilter || (hasPendingFilter === "Y" ? hasPending : !hasPending);
    const matchesPublished = !publishedFilter || String(row.published_to_professor || "N") === publishedFilter;
    const matchesTaAllowed = !taAllowedFilter || String(row.ta_applications_allowed || "N") === taAllowedFilter;
    const matchesConflictAllowed = !conflictAllowedFilter || String(row.is_conflict_allowed || "N") === conflictAllowedFilter;
    return matchesProfessor && matchesClassName && matchesSemester && matchesTaFull && matchesPending && matchesPublished && matchesTaAllowed && matchesConflictAllowed;
  });
}

function classTaExportWorkbookBufferFromRows(classRows, approvedApps) {
  const classMap = new Map(classRows.map((row) => [Number(row.class_id), row]));
  const matchRows = approvedApps.map((app) => {
    const classRow = classMap.get(Number(app.class_id));
    return {
      class_id: classRow?.class_id ?? app.class_id,
      class_code: classRow?.class_code || "",
      class_abbr: classRow?.class_abbr || "",
      course_name: classRow?.course_name || "",
      class_name: classRow?.class_name || app.class_name || "",
      semester: classRow?.semester || "",
      teacher_name: classRow?.teacher_name || app.teacher_name || "",
      maximum_number_of_tas_admitted: classRow?.maximum_number_of_tas_admitted || "",
      published_to_professor: classRow?.published_to_professor || "",
      ta_applications_allowed: classRow?.ta_applications_allowed || "",
      ta_name: app.applier_name || "",
      ta_login_name: app.ta_login_name || "",
      ta_email: app.ta_email || "",
      application_id: app.application_id,
      approved_at: app.prof_acted_at || ""
    };
  });
  const summaryRows = classRows.map((row) => ({
    class_id: row.class_id,
    class_code: row.class_code,
    class_abbr: row.class_abbr || "",
    course_name: row.course_name,
    class_name: row.class_name,
    semester: row.semester,
    teacher_name: row.teacher_name,
    maximum_number_of_tas_admitted: row.maximum_number_of_tas_admitted,
    approved_count: row.approved_count || 0,
    application_count: row.application_count || 0,
    pending_taadmin_count: row.pending_taadmin_count || 0,
    pending_professor_count: row.pending_professor_count || 0,
    ta_full: isClassCapacityReached(row, row.approved_count) ? "Y" : "N",
    published_to_professor: row.published_to_professor || "N",
    ta_applications_allowed: row.ta_applications_allowed || "N",
    is_conflict_allowed: row.is_conflict_allowed || "N"
  }));
  const workbook = XLSX.utils.book_new();
  const matchesSheet = XLSX.utils.json_to_sheet(matchRows.length ? matchRows : [{
    class_id: "",
    class_code: "",
    class_abbr: "",
    course_name: "",
    class_name: "",
    semester: "",
    teacher_name: "",
    maximum_number_of_tas_admitted: "",
    published_to_professor: "",
    ta_applications_allowed: "",
    ta_name: "",
    ta_login_name: "",
    ta_email: "",
    application_id: "",
    approved_at: ""
  }]);
  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(workbook, matchesSheet, "MatchedTA");
  XLSX.utils.book_append_sheet(workbook, summarySheet, "ClassSummary");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

function classTaExportWorkbookBuffer(db, classRows) {
  const classIds = Array.from(new Set(classRows.map((row) => Number(row.class_id)).filter(Boolean)));
  const approvedApps = classIds.length
    ? db.prepare(`
      select
        a.application_id,
        a.class_id,
        a.class_name,
        a.applier_user_id,
        a.applier_name,
        a.teacher_name,
        a.prof_acted_at,
        u.login_name as ta_login_name,
        u.email as ta_email
      from applications a
      left join users u on u.user_id = a.applier_user_id
      where a.status = 'Approved'
        and a.class_id in (${classIds.map(() => "?").join(",")})
      order by a.class_id, a.applier_name
    `).all(...classIds)
    : [];
  return classTaExportWorkbookBufferFromRows(classRows, approvedApps);
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

async function resolveProfessorSelectionGateway(rawValue) {
  const ids = normalizeTeacherUserIds(rawValue);
  if (!ids.length) {
    throw new Error("请至少选择一位 Professor");
  }
  const professorRows = await dbGateway.getProfessorUsers();
  const professorMap = new Map(professorRows.map((row) => [Number(row.user_id), row]));
  const rows = ids.map((id) => professorMap.get(id)).filter(Boolean);
  if (rows.length !== ids.length) {
    throw new Error("Professor 不存在");
  }
  return {
    ids: rows.map((row) => Number(row.user_id)),
    idText: rows.map((row) => Number(row.user_id)).join(","),
    nameText: rows.map((row) => row.user_name).join(" / ")
  };
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
    if (parts.length < 3 || parts.length > 5) {
      throw new Error(`第 ${index + 1} 条排课格式错误，应为 日期,开始时间,结束时间[,节次][,考试类型]`);
    }
    const [lessonDate, startTime, endTime, rawSection = "", examValue = ""] = parts;
    const section = String(rawSection || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(lessonDate)) {
      throw new Error(`第 ${index + 1} 条排课日期格式错误`);
    }
    if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
      throw new Error(`第 ${index + 1} 条排课时间格式错误`);
    }
    if (endTime <= startTime) {
      throw new Error(`第 ${index + 1} 条排课结束时间必须晚于开始时间`);
    }
    if (section && !["上午", "下午", "晚上"].includes(section)) {
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
    "credit",
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
    const credit = Number(get("credit"));
    if (!Number.isFinite(credit) || credit < 0) {
      errors.push(`第 ${rowNo} 行失败：credit 必须是大于等于 0 的数字`);
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
      credit,
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
      const comparableKeys = ["classAbbr", "courseName", "className", "teachingLanguage", "semester", "credit", "maximumNumber", "taAllowed", "isConflictAllowed", "applyStartAt", "applyEndAt", "classIntro", "memo"];
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
    const teachesClasses = classCountByTeacher.get(String(existing.user_id)).count;
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
      const classes = db.prepare("select class_id, teacher_user_id from classes where (',' || teacher_user_id || ',') like '%,' || ? || ',%'").all(String(existing.user_id));
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
      teacher_name, class_intro, memo, credit, maximum_number_of_tas_admitted,
      ta_applications_allowed, is_conflict_allowed, apply_start_at, apply_end_at, semester
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateClass = db.prepare(`
    update classes
    set class_abbr = ?, class_name = ?, course_name = ?, teaching_language = ?, teacher_user_id = ?,
        teacher_name = ?, class_intro = ?, memo = ?, credit = ?, maximum_number_of_tas_admitted = ?,
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
        item.credit,
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
        item.credit,
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

function scheduleSummary(rows, key, options = {}) {
  if (!rows.length) {
    return "<span class='muted'>暂无排课</span>";
  }
  const showPreview = options.showPreview !== false;
  const triggerLabel = options.triggerLabel || "查看排课";
  const compact = !showPreview;
  const renderItem = (row) => `
    <div class="schedule-item">
      <div>${escapeHtml(normalizeDisplayDate(row.lesson_date))} ${escapeHtml(row.start_time)}-${escapeHtml(row.end_time)}</div>
      <div class="schedule-meta">${escapeHtml(row.section)}${row.is_exam ? ` · ${escapeHtml(row.is_exam)}` : ""}</div>
    </div>
  `;
  const previewText = escapeHtml(`${normalizeDisplayDate(rows[0].lesson_date)} ${rows[0].start_time}-${rows[0].end_time}`);
  const extraCount = rows.length - 1;
  const fullItems = rows.map(renderItem).join("");
  const dialogId = `schedule-dialog-${escapeHtml(String(key || crypto.randomBytes(4).toString("hex")))}`;
  return `
    <div class="schedule-summary${compact ? " schedule-summary-compact" : ""}">
      ${showPreview ? `
      <div class="schedule-preview">
        <div class="schedule-item">
          <div>${previewText}</div>
          <div class="schedule-meta">${extraCount > 0 ? `另有 ${extraCount} 条排课` : `${escapeHtml(rows[0].section)}${rows[0].is_exam ? ` · ${escapeHtml(rows[0].is_exam)}` : ""}`}</div>
        </div>
      </div>` : ""}
      <div class="actions">
        <button class="${compact ? "schedule-trigger" : "secondary rect"}" type="button" data-open-schedule="${dialogId}">${escapeHtml(triggerLabel)}</button>
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
    .map((row) => [normalizeDisplayDate(row.lesson_date), row.start_time, row.end_time, row.section, row.is_exam || ""].filter((value, index) => index < 4 || value).join(","))
    .join("\n");
}

function renderClassCalendarGrid(calendar) {
  const weekdayHeaders = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const rowsMarkup = calendar.weeks.map((week) => `
    <tr>
      ${week.map((day) => {
        const entriesMarkup = day.entries.length
          ? `<div class="calendar-day-list">${day.entries.map((entry) => `
              <div class="calendar-entry${entry.is_conflict ? " is-conflict" : ""}">
                <div class="calendar-entry-time">${escapeHtml(entry.start_time)}-${escapeHtml(entry.end_time)}${entry.section ? ` · ${escapeHtml(entry.section)}` : ""}</div>
                <div class="calendar-entry-name">${escapeHtml(entry.course_name)} / ${escapeHtml(entry.class_name)}</div>
                <div class="calendar-entry-meta">${escapeHtml(entry.class_code)} · ${escapeHtml(entry.teacher_name)} · TA ${entry.ta_count}/${entry.ta_limit}${entry.is_exam ? ` · ${escapeHtml(entry.is_exam)}` : ""}</div>
              </div>
            `).join("")}</div>`
          : `<div class="calendar-empty">暂无排课</div>`;
        return `
          <td>
            <div class="calendar-day${day.isCurrentMonth ? "" : " is-outside"}">
              <div class="calendar-day-header">
                <div class="calendar-day-number">${day.dateNumber}</div>
                <div class="calendar-day-count">${day.entries.length ? `${day.entries.length} 条排课` : ""}</div>
              </div>
              ${entriesMarkup}
            </div>
          </td>
        `;
      }).join("")}
    </tr>
  `).join("");
  return `
    <div class="calendar-wrap">
      <table class="calendar-table">
        <thead><tr>${weekdayHeaders.map((label) => `<th>${label}</th>`).join("")}</tr></thead>
        <tbody>${rowsMarkup}</tbody>
      </table>
    </div>
  `;
}

function renderClassCalendarPageContent(options) {
  const {
    title,
    basePath,
    listPath,
    filters,
    calendar,
    rows,
    filterFields,
    legendNote
  } = options;
  const queryBase = { ...filterFields, month: calendar.monthValue };
  const prevMonth = shiftMonthValue(calendar.monthValue, -1);
  const nextMonth = shiftMonthValue(calendar.monthValue, 1);
  return `
    <section class="card card-brand">
      <div class="calendar-toolbar">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <p class="muted" style="margin:8px 0 0;">以月视图展示当前筛选范围内的全部排课。橙色条目代表同一天内存在时间重叠，方便快速识别教学班冲突。</p>
        </div>
        <div class="calendar-actions">
          <a class="button-link secondary action-button" href="${basePath}${buildQueryString({ ...filterFields, month: prevMonth })}">上个月</a>
          <form method="get" action="${basePath}" style="display:flex; gap:10px; align-items:center;">
            ${Object.entries(filterFields).map(([key, value]) => {
              if (value === undefined || value === null || value === "") return "";
              return `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`;
            }).join("")}
            <input name="month" type="month" value="${escapeHtml(calendar.monthValue)}" />
            <button class="secondary action-button" type="submit">查看月份</button>
          </form>
          <a class="button-link secondary action-button" href="${basePath}${buildQueryString({ ...filterFields, month: nextMonth })}">下个月</a>
          <a class="button-link secondary action-button" href="${listPath}${buildQueryString(filterFields)}">返回列表</a>
        </div>
      </div>
      <div class="calendar-meta-grid">
        <div class="calendar-meta-card">
          <div class="calendar-meta-label">当前月份</div>
          <div class="calendar-meta-value">${escapeHtml(calendar.monthLabel)}</div>
        </div>
        <div class="calendar-meta-card">
          <div class="calendar-meta-label">教学班数</div>
          <div class="calendar-meta-value">${calendar.totalClasses}</div>
        </div>
        <div class="calendar-meta-card">
          <div class="calendar-meta-label">本月排课数</div>
          <div class="calendar-meta-value">${calendar.totalSchedules}</div>
        </div>
        <div class="calendar-meta-card">
          <div class="calendar-meta-label">冲突日期数</div>
          <div class="calendar-meta-value">${calendar.conflictDayCount}</div>
        </div>
      </div>
      <div class="calendar-legend">
        <span class="calendar-legend-item"><span class="calendar-legend-swatch" style="background:#edf2ff; border-color:#d8dff8;"></span>正常排课</span>
        <span class="calendar-legend-item"><span class="calendar-legend-swatch" style="background:#fbedd9; border-color:#d9b98a;"></span>存在时间冲突</span>
        <span class="calendar-legend-item"><span class="calendar-legend-swatch" style="background:#faf8f3; border-color:#ddd5ca;"></span>非本月日期</span>
      </div>
      <p class="muted" style="margin:0 0 16px;">${escapeHtml(legendNote)} 当前筛选共 ${rows.length} 个教学班，本月检测到 ${calendar.conflictItemCount} 条冲突排课。</p>
      ${renderClassCalendarGrid(calendar)}
    </section>
  `;
}

async function courseClassesCalendarPage(res, user, notice, filters = {}) {
  const rows = DB_CLIENT === "mysql"
    ? await dbGateway.getCourseAdminClassRows(filters)
    : (() => {
        const db = getDb();
        try {
          return loadCourseAdminClassRows(db, filters);
        } finally {
          db.close();
        }
      })();
  const classIds = rows.map((row) => Number(row.class_id)).filter(Boolean);
  const allSchedules = DB_CLIENT === "mysql"
    ? await dbGateway.getSchedulesForClassIds(classIds)
    : (() => {
        const db = getDb();
        try {
          const stmt = db.prepare(`
            select class_id, lesson_date, start_time, end_time, section, is_exam
            from class_schedules
            where class_id = ?
            order by lesson_date, start_time
          `);
          return classIds.flatMap((classId) => stmt.all(classId));
        } finally {
          db.close();
        }
      })();
  const schedulesByClass = new Map();
  for (const schedule of allSchedules) {
    const classId = Number(schedule.class_id);
    if (!schedulesByClass.has(classId)) {
      schedulesByClass.set(classId, []);
    }
    schedulesByClass.get(classId).push(schedule);
  }
  const calendar = buildClassCalendarData(rows, schedulesByClass, filters.month);
  sendHtml(res, pageLayout("教学班日历视图", renderClassCalendarPageContent({
    title: "教学班日历视图",
    basePath: "/course/classes/calendar",
    listPath: "/course/classes",
    filters,
    calendar,
    rows,
    filterFields: {
      class_code: filters.class_code || "",
      class_name: filters.class_name || "",
      teacher_name: filters.teacher_name || "",
      ta_full: filters.ta_full || "",
      status_filter: filters.status_filter || "",
      sort_by: filters.sort_by || "",
      sort_order: filters.sort_order || ""
    },
    legendNote: "本页不改变任何排课或申请逻辑，只提供教学班排课的月历总览。"
  }), user, notice));
}

async function taAdminClassesCalendarPage(res, user, notice, filters = {}) {
  const rows = DB_CLIENT === "mysql"
    ? await dbGateway.getTaAdminClassRows(filters)
    : (() => {
        const db = getDb();
        try {
          return loadTaAdminClassRows(db, filters);
        } finally {
          db.close();
        }
      })();
  const classIds = rows.map((row) => Number(row.class_id)).filter(Boolean);
  const allSchedules = DB_CLIENT === "mysql"
    ? await dbGateway.getSchedulesForClassIds(classIds)
    : (() => {
        const db = getDb();
        try {
          const stmt = db.prepare(`
            select class_id, lesson_date, start_time, end_time, section, is_exam
            from class_schedules
            where class_id = ?
            order by lesson_date, start_time
          `);
          return classIds.flatMap((classId) => stmt.all(classId));
        } finally {
          db.close();
        }
      })();
  const schedulesByClass = new Map();
  for (const schedule of allSchedules) {
    const classId = Number(schedule.class_id);
    if (!schedulesByClass.has(classId)) {
      schedulesByClass.set(classId, []);
    }
    schedulesByClass.get(classId).push(schedule);
  }
  const calendar = buildClassCalendarData(rows, schedulesByClass, filters.month);
  sendHtml(res, pageLayout("全部教学班日历视图", renderClassCalendarPageContent({
    title: "全部教学班日历视图",
    basePath: "/admin/ta/classes/calendar",
    listPath: "/admin/ta/classes",
    filters,
    calendar,
    rows,
    filterFields: {
      professor_name: filters.professor_name || "",
      class_name: filters.class_name || "",
      ta_full: filters.ta_full || "",
      has_pending: filters.has_pending || ""
    },
    legendNote: "本页用于直观看教学班排课冲突和当前待审教学班的时间分布，不影响现有审批逻辑。"
  }), user, notice));
}

function renderTaClassesFilterForm(filters, options = {}) {
  const isDialog = options.dialog === true;
  return `
    <form method="get" action="/ta/classes">
      ${isDialog ? `
        <div class="filter-dialog-header">
          <h3>搜索教学班</h3>
          <button class="secondary rect" type="button" onclick="this.closest('dialog').close()">关闭</button>
        </div>
      ` : ""}
      <div class="filters-shell ta-compact-filters">
        <div class="filters-grid ta-compact-filters-grid">
          <p><label>是否可申请<select name="apply_status">
            <option value="" ${!filters.apply_status ? "selected" : ""}>全部</option>
            <option value="可申请" ${filters.apply_status === "可申请" ? "selected" : ""}>可申请</option>
            <option value="有冲突" ${filters.apply_status === "有冲突" ? "selected" : ""}>有冲突</option>
            <option value="已申请" ${filters.apply_status === "已申请" ? "selected" : ""}>已申请</option>
            <option value="被拒绝" ${filters.apply_status === "被拒绝" ? "selected" : ""}>被拒绝</option>
          </select></label></p>
          <p><label>教授名<input name="professor_name" value="${escapeHtml(filters.professor_name || "")}" /></label></p>
          <p><label>课程名称<input name="course_name" value="${escapeHtml(filters.course_name || "")}" /></label></p>
          <p><label>教学班名称<input name="class_name" value="${escapeHtml(filters.class_name || "")}" /></label></p>
          <p><label>授课语言<select name="teaching_language">
            <option value="" ${!filters.teaching_language ? "selected" : ""}>全部</option>
            ${["中文", "英文", "双语"].map((item) => `<option value="${item}" ${filters.teaching_language === item ? "selected" : ""}>${item}</option>`).join("")}
          </select></label></p>
          <div class="actions">
            <button class="secondary action-button" type="submit">筛选</button>
            <a class="button-link secondary action-button" href="/ta/classes">重置</a>
            ${isDialog ? `<button class="secondary action-button" type="button" onclick="this.closest('dialog').close()">取消</button>` : ""}
          </div>
        </div>
      </div>
    </form>
  `;
}

async function taClassesPage(res, user, notice, filters = {}) {
  if (DB_CLIENT === "mysql") {
    const snapshot = await dbGateway.getTaClassesSnapshot(user.user_id);
    const latestApplicationMap = getLatestApplicationMapFromRows(snapshot.applications);
    const scheduleMap = buildScheduleMapFromRows(snapshot.schedules);
    const classMap = buildClassMapFromRows(snapshot.classMeta);
    const applyStatusFilter = String(filters.apply_status || "").trim();
    const professorFilter = String(filters.professor_name || "").trim().toLowerCase();
    const courseFilter = String(filters.course_name || "").trim().toLowerCase();
    const classNameFilter = String(filters.class_name || "").trim().toLowerCase();
    const languageFilter = String(filters.teaching_language || "").trim();
    const visibleClasses = snapshot.classes
      .filter((row) => isClassOpenForApply(row))
      .map((row) => {
        const schedules = scheduleMap.get(row.class_id) || [];
        const conflicts = getOpenClassConflictsFromData(snapshot.classes, snapshot.applications, scheduleMap, row.class_id);
        const appliedConflicts = getAppliedConflictsFromData(snapshot.applications, classMap, scheduleMap, row.class_id);
        const latestApplication = latestApplicationMap.get(row.class_id) || null;
        const activeApplication = latestApplication && isActiveApplicationStatus(latestApplication.status) ? latestApplication : null;
        const cardStatus = activeApplication
          ? "已申请"
          : (latestApplication && ["RejectedByTAAdmin", "RejectedByProfessor"].includes(latestApplication.status)
            ? "被拒绝"
            : (appliedConflicts.length && row.is_conflict_allowed !== "Y" ? "有冲突" : "可申请"));
        return {
          ...row,
          schedules,
          conflicts,
          appliedConflicts,
          latestApplication,
          activeApplication,
          cardStatus
        };
      })
      .filter((row) => !applyStatusFilter || row.cardStatus === applyStatusFilter)
      .filter((row) => !professorFilter || String(row.teacher_name || "").toLowerCase().includes(professorFilter))
      .filter((row) => !courseFilter || String(row.course_name || "").toLowerCase().includes(courseFilter))
      .filter((row) => !classNameFilter || String(row.class_name || "").toLowerCase().includes(classNameFilter))
      .filter((row) => !languageFilter || String(row.teaching_language || "") === languageFilter);
    const body = visibleClasses.map((row) => {
      const labelClass = row.cardStatus === "有冲突"
        ? "pill bad"
        : row.cardStatus === "已申请"
          ? "pill"
          : row.cardStatus === "被拒绝"
            ? "pill gold"
            : "pill ok";
      const cardClass = row.cardStatus === "有冲突" ? "card-soft-red" : row.cardStatus === "已申请" ? "card-soft-purple" : "";
      const dialogId = `ta-conflicts-${row.class_id}`;
      const actionHint = row.activeApplication
        ? `<p class="compact-note">已提交申请，请到“我的申请”查看；若仍处于 TAAdmin 审批前，可在“我的申请”中撤销。</p>`
        : (row.cardStatus === "被拒绝"
          ? `<p class="compact-note reapply-note">该教学班上一条申请已被拒绝，你可以重新申请。</p>`
          : (row.appliedConflicts?.length
            ? (row.is_conflict_allowed === "Y"
              ? `<p class="compact-note" style="color:#8b5b00;">存在时间冲突，但本教学班允许冲突申请，可继续提交。</p>`
              : `<p class="compact-note bad">存在时间冲突，当前不可提交申请。</p>`)
            : ""))
      ;
      return `<article class="card class-card ${cardClass}">
        <h3>${escapeHtml(row.course_name)} / ${escapeHtml(row.class_name)}</h3>
        <p><span class="${labelClass}">${escapeHtml(row.cardStatus)}</span></p>
        <div class="class-card-meta">
          <span>${escapeHtml(row.teacher_name)}</span>
          <span>${escapeHtml(row.teaching_language)}</span>
          <span>${escapeHtml(Number(row.credit || 0) > 0 ? `${Number(row.credit)} 学分` : "未设置学分")}</span>
        </div>
        <p>待初审申请数：${row.pending_taadmin_count || 0}</p>
        <p class="muted">开放申请：${escapeHtml(compactApplyWindowText(row))}</p>
        ${actionHint}
        <div class="actions">
          <a class="button-link action-button" href="/ta/classes/${row.class_id}">查看详情</a>
          <button class="secondary rect action-button" type="button" data-open-schedule="${dialogId}">查看冲突</button>
        </div>
        <dialog class="schedule-dialog" id="${dialogId}">
          <div class="schedule-dialog-body">
            <div class="actions" style="justify-content:space-between; align-items:center; margin-bottom:12px;">
              <h3 style="margin:0;">${escapeHtml(row.class_name)}：排课与冲突</h3>
              <button class="secondary rect" type="button" data-close-schedule="${dialogId}">关闭</button>
            </div>
            <section style="margin-bottom:14px;">
              <h3 style="font-size:16px; margin-bottom:10px;">排课信息</h3>
              ${compactScheduleList(row.schedules)}
            </section>
            <section>
              <h3 style="font-size:16px; margin-bottom:10px;">冲突信息</h3>
              ${compactConflictList(row.conflicts)}
            </section>
          </div>
        </dialog>
      </article>`;
    }).join("");
    return sendHtml(res, pageLayout("可申请教学班", `
      <section class="card" id="ta-class-filters">
        <h2>筛选教学班</h2>
        ${renderTaClassesFilterForm(filters)}
      </section>
      <section class="card">
        <h2>开放教学班</h2>
        <p class="muted">当前共匹配 <strong>${visibleClasses.length}</strong> 个教学班。浅紫色表示已申请，浅红色表示存在阻断性时间冲突。</p>
        ${body ? `<div class="class-card-grid">${body}</div>` : `<p class="muted">当前没有符合条件的开放教学班。</p>`}
      </section>
      <a class="mobile-fab" href="#ta-class-filters" onclick="event.preventDefault();document.getElementById('ta-class-filter-dialog')?.showModal();">搜索筛选</a>
      <dialog class="filter-dialog" id="ta-class-filter-dialog">
        <div class="filter-dialog-body">
          ${renderTaClassesFilterForm(filters, { dialog: true })}
        </div>
      </dialog>
    `, user, notice));
  }
  const db = getDb();
  const classes = db.prepare(`
    select c.*,
      (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count
    from classes c
    where c.ta_applications_allowed = 'Y'
    order by c.semester, c.course_name, c.class_name
  `).all();
  const latestApplicationMap = getLatestApplicationMap(db, user.user_id);
  const applyStatusFilter = String(filters.apply_status || "").trim();
  const professorFilter = String(filters.professor_name || "").trim().toLowerCase();
  const courseFilter = String(filters.course_name || "").trim().toLowerCase();
  const classNameFilter = String(filters.class_name || "").trim().toLowerCase();
  const languageFilter = String(filters.teaching_language || "").trim();
  const visibleClasses = classes
    .filter((row) => isClassOpenForApply(row))
      .map((row) => {
        const schedules = fetchSchedules(db, row.class_id);
        const conflicts = getOpenClassConflicts(db, user.user_id, row.class_id);
        const appliedConflicts = getAppliedConflicts(db, user.user_id, row.class_id);
        const latestApplication = latestApplicationMap.get(row.class_id) || null;
        const activeApplication = latestApplication && isActiveApplicationStatus(latestApplication.status) ? latestApplication : null;
      const cardStatus = activeApplication
        ? "已申请"
        : (latestApplication && ["RejectedByTAAdmin", "RejectedByProfessor"].includes(latestApplication.status)
          ? "被拒绝"
          : (appliedConflicts.length && row.is_conflict_allowed !== "Y" ? "有冲突" : "可申请"));
      return {
        ...row,
        schedules,
        conflicts,
        appliedConflicts,
        latestApplication,
        activeApplication,
        cardStatus
      };
    })
    .filter((row) => !applyStatusFilter || row.cardStatus === applyStatusFilter)
    .filter((row) => !professorFilter || String(row.teacher_name || "").toLowerCase().includes(professorFilter))
    .filter((row) => !courseFilter || String(row.course_name || "").toLowerCase().includes(courseFilter))
    .filter((row) => !classNameFilter || String(row.class_name || "").toLowerCase().includes(classNameFilter))
    .filter((row) => !languageFilter || String(row.teaching_language || "") === languageFilter);
  const body = visibleClasses.map((row) => {
    const labelClass = row.cardStatus === "有冲突"
      ? "pill bad"
      : row.cardStatus === "已申请"
        ? "pill"
        : row.cardStatus === "被拒绝"
          ? "pill gold"
          : "pill ok";
    const cardClass = row.cardStatus === "有冲突" ? "card-soft-red" : row.cardStatus === "已申请" ? "card-soft-purple" : "";
    const dialogId = `ta-conflicts-${row.class_id}`;
    const actionHint = row.activeApplication
      ? `<p class="compact-note">已提交申请，请到“我的申请”查看；若仍处于 TAAdmin 审批前，可在“我的申请”中撤销。</p>`
      : (row.cardStatus === "被拒绝"
        ? `<p class="compact-note reapply-note">该教学班上一条申请已被拒绝，你可以重新申请。</p>`
        : (row.appliedConflicts?.length
          ? (row.is_conflict_allowed === "Y"
            ? `<p class="compact-note" style="color:#8b5b00;">存在时间冲突，但本教学班允许冲突申请，可继续提交。</p>`
            : `<p class="compact-note bad">存在时间冲突，当前不可提交申请。</p>`)
          : ""));
    return `<article class="card class-card ${cardClass}">
      <h3>${escapeHtml(row.course_name)} / ${escapeHtml(row.class_name)}</h3>
      <p><span class="${labelClass}">${escapeHtml(row.cardStatus)}</span></p>
      <div class="class-card-meta">
        <span>${escapeHtml(row.teacher_name)}</span>
        <span>${escapeHtml(row.teaching_language)}</span>
        <span>${escapeHtml(Number(row.credit || 0) > 0 ? `${Number(row.credit)} 学分` : "未设置学分")}</span>
      </div>
      <p>待初审申请数：${row.pending_taadmin_count || 0}</p>
      <p class="muted">开放申请：${escapeHtml(compactApplyWindowText(row))}</p>
      ${actionHint}
      <div class="actions">
        <a class="button-link action-button" href="/ta/classes/${row.class_id}">查看详情</a>
        <button class="secondary rect action-button" type="button" data-open-schedule="${dialogId}">查看冲突</button>
      </div>
      <dialog class="schedule-dialog" id="${dialogId}">
        <div class="schedule-dialog-body">
          <div class="actions" style="justify-content:space-between; align-items:center; margin-bottom:12px;">
            <h3 style="margin:0;">${escapeHtml(row.class_name)}：排课与冲突</h3>
            <button class="secondary rect" type="button" data-close-schedule="${dialogId}">关闭</button>
          </div>
          <section style="margin-bottom:14px;">
            <h3 style="font-size:16px; margin-bottom:10px;">排课信息</h3>
            ${compactScheduleList(row.schedules)}
          </section>
          <section>
            <h3 style="font-size:16px; margin-bottom:10px;">冲突信息</h3>
            ${compactConflictList(row.conflicts)}
          </section>
        </div>
      </dialog>
    </article>`;
  }).join("");
  db.close();
  sendHtml(res, pageLayout("可申请教学班", `
    <section class="card" id="ta-class-filters">
      <h2>筛选教学班</h2>
      ${renderTaClassesFilterForm(filters)}
    </section>
    <section class="card">
      <h2>开放教学班</h2>
      <p class="muted">当前共匹配 <strong>${visibleClasses.length}</strong> 个教学班。浅紫色表示已申请，浅红色表示存在阻断性时间冲突。</p>
      ${body ? `<div class="class-card-grid">${body}</div>` : `<p class="muted">当前没有符合条件的开放教学班。</p>`}
    </section>
    <a class="mobile-fab" href="#ta-class-filters" onclick="event.preventDefault();document.getElementById('ta-class-filter-dialog')?.showModal();">搜索筛选</a>
    <dialog class="filter-dialog" id="ta-class-filter-dialog">
      <div class="filter-dialog-body">
        ${renderTaClassesFilterForm(filters, { dialog: true })}
      </div>
    </dialog>
  `, user, notice));
}

async function taClassDetailPage(res, user, classId, notice) {
  if (DB_CLIENT === "mysql") {
    const snapshot = await dbGateway.getTaClassesSnapshot(user.user_id);
    const row = snapshot.classes.find((item) => item.class_id === classId) || null;
    if (!row || !isClassOpenForApply(row)) {
      return sendHtml(res, pageLayout("未找到", '<section class="card">教学班不存在，或当前不在开放申请时间内。</section>', user, notice), {}, 404);
    }
    const scheduleMap = buildScheduleMapFromRows(snapshot.schedules);
    const classMap = buildClassMapFromRows(snapshot.classMeta);
    const schedules = scheduleMap.get(classId) || [];
    const appliedConflicts = getAppliedConflictsFromData(snapshot.applications, classMap, scheduleMap, classId);
    const conflicts = getOpenClassConflictsFromData(snapshot.classes, snapshot.applications, scheduleMap, classId);
    const existingApplication = (snapshot.applications || []).find((app) =>
      app.class_id === classId &&
      !["Withdrawn", "RejectedByTAAdmin", "RejectedByProfessor"].includes(app.status)
    ) || null;
    const hasBlockingConflicts = appliedConflicts.length > 0 && row.is_conflict_allowed !== "Y";
    const canSubmit = Boolean(user.resume_path) && !hasBlockingConflicts && !existingApplication;
    const resumeSection = user.resume_path
      ? `<p>个人简历：${attachmentLink(user)}</p><p class="muted">提交申请时将自动带出当前个人简历。</p>`
      : `<p class="bad">你还没有上传个人简历，请先到 <a href="/ta/profile">个人资料</a> 上传后再申请。</p>`;
    const existingApplicationSection = existingApplication
      ? `<div class="notice" style="margin: 0 0 16px; background: #f3ecff; border-color: #ddccff; color: #5b33a3;">
          你已经提交过该教学班申请，当前状态为“${escapeHtml(statusLabels[existingApplication.status] || existingApplication.status)}”。为避免重复提交，当前按钮已停用。
          ${existingApplication.status === "PendingTAAdmin" ? `在 TAAdmin 审批前，你可以进入 <a href="/ta/applications">我的申请</a> 模块撤销申请。` : `请进入 <a href="/ta/applications">我的申请</a> 模块查看当前状态。`}
        </div>`
      : "";
    const appliedConflictSection = renderAppliedConflictSection(appliedConflicts, row.is_conflict_allowed || "N");
    const conflictSection = `
        <div style="margin: 0 0 16px;">
          <h3 style="margin-bottom:8px;">冲突信息</h3>
          <p class="muted">以下展示当前教学班与所有开放教学班的冲突情况。</p>
          ${compactConflictList(conflicts)}
        </div>`;
    return sendHtml(res, pageLayout("教学班详情", `
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
      <section class="card">
        <h3>提交申请</h3>
        ${existingApplicationSection}
        ${resumeSection}
        ${appliedConflictSection}
        ${conflictSection}
        <form method="post" action="/ta/applications" data-disable-on-submit="1" data-submit-hint-target="ta-submit-hint">
          <input type="hidden" name="class_id" value="${row.class_id}" />
          <p><label>申请原因<textarea name="application_reason"></textarea></label></p>
          <button type="submit" ${canSubmit ? "" : "disabled"}>提交申请</button>
        </form>
        <div class="submit-hint" id="ta-submit-hint">申请正在提交。提交后按钮会暂时停用，避免重复提交。在 TAAdmin 审批前，你可以进入“我的申请”模块撤销申请。</div>
      </section>
    `, user, notice));
  }
  const db = getDb();
  const row = db.prepare("select * from classes where class_id = ?").get(classId);
  if (!row || !isClassOpenForApply(row)) {
    db.close();
    return sendHtml(res, pageLayout("未找到", '<section class="card">教学班不存在，或当前不在开放申请时间内。</section>', user, notice), {}, 404);
    return;
  }
  const schedules = fetchSchedules(db, classId);
  const appliedConflicts = getAppliedConflicts(db, user.user_id, classId);
  const conflicts = getOpenClassConflicts(db, user.user_id, classId);
  const existingApplication = db.prepare(`
    select *
    from applications
    where applier_user_id = ?
      and class_id = ?
      and status not in ('Withdrawn', 'RejectedByTAAdmin', 'RejectedByProfessor')
    order by submitted_at desc, application_id desc
    limit 1
  `).get(user.user_id, classId);
  const hasBlockingConflicts = appliedConflicts.length > 0 && row.is_conflict_allowed !== "Y";
  const canSubmit = Boolean(user.resume_path) && !hasBlockingConflicts && !existingApplication;
  const resumeSection = user.resume_path
    ? `<p>个人简历：${attachmentLink(user)}</p><p class="muted">提交申请时将自动带出当前个人简历。</p>`
    : `<p class="bad">你还没有上传个人简历，请先到 <a href="/ta/profile">个人资料</a> 上传后再申请。</p>`;
  const existingApplicationSection = existingApplication
    ? `<div class="notice" style="margin: 0 0 16px; background: #f3ecff; border-color: #ddccff; color: #5b33a3;">
        你已经提交过该教学班申请，当前状态为“${escapeHtml(statusLabels[existingApplication.status] || existingApplication.status)}”。为避免重复提交，当前按钮已停用。
        ${existingApplication.status === "PendingTAAdmin" ? `在 TAAdmin 审批前，你可以进入 <a href="/ta/applications">我的申请</a> 模块撤销申请。` : `请进入 <a href="/ta/applications">我的申请</a> 模块查看当前状态。`}
      </div>`
    : "";
  const appliedConflictSection = renderAppliedConflictSection(
    appliedConflicts.map(({ app, matches }) => ({ ...app, matches })),
    row.is_conflict_allowed || "N"
  );
  const conflictSection = `
      <div style="margin: 0 0 16px;">
        <h3 style="margin-bottom:8px;">冲突信息</h3>
        <p class="muted">以下展示当前教学班与所有开放教学班的冲突情况。</p>
        ${compactConflictList(conflicts)}
      </div>`;
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
    <section class="card">
      <h3>提交申请</h3>
      ${existingApplicationSection}
      ${resumeSection}
      ${appliedConflictSection}
      ${conflictSection}
      <form method="post" action="/ta/applications" data-disable-on-submit="1" data-submit-hint-target="ta-submit-hint">
        <input type="hidden" name="class_id" value="${row.class_id}" />
        <p><label>申请原因<textarea name="application_reason"></textarea></label></p>
        <button type="submit" ${canSubmit ? "" : "disabled"}>提交申请</button>
      </form>
      <div class="submit-hint" id="ta-submit-hint">申请正在提交。提交后按钮会暂时停用，避免重复提交。在 TAAdmin 审批前，你可以进入“我的申请”模块撤销申请。</div>
    </section>
  `, user, notice));
}

async function createApplication(req, res, user) {
  const fields = await readBody(req);
  const classId = Number(fields.class_id || 0);
  const reason = String(fields.application_reason || "").trim();

  if (DB_CLIENT === "mysql") {
    const result = await dbGateway.createTaApplication(user, classId, reason, nowStr());
    if (!result.ok) {
      return redirect(res, result.redirect);
    }
    const emailJobs = (result.taAdmins || []).map((admin) => buildTaAdminNewApplicationEmail(admin, user, result.classRow));
    const emailErrors = await sendEmailsAndCollectErrors(emailJobs);
    return redirect(res, `/ta/applications?notice=${emailErrors.length ? "申请已提交，站内通知已发送，部分邮件发送失败" : "申请已提交，站内通知和邮件已发送"}`);
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
  const exists = db.prepare(`
    select 1
    from applications
    where applier_user_id = ?
      and class_id = ?
      and status not in ('Withdrawn', 'RejectedByTAAdmin', 'RejectedByProfessor')
  `).get(user.user_id, classId);
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
    return redirect(res, `/ta/classes/${classId}?notice=存在时间冲突，无法申请`);
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
  db.prepare("update classes set published_to_professor = 'N', professor_notified_at = null where class_id = ?").run(classId);
  const applicationId = insertResult.lastInsertRowid;
  const taAdmins = db.prepare("select user_id, user_name, email from users where role = 'TAAdmin'").all();
  for (const admin of taAdmins) {
    createNotification(
      db,
      admin.user_id,
      "有新的 TA 待初审申请",
      `${user.user_name} 提交了《${classRow.class_name}》的 TA 申请，请尽快初审。`,
      `/admin/ta/pending/${applicationId}`
    );
  }
  createAuditLog(db, {
    actor: user,
    actionType: "TA_APPLY",
    targetType: "Application",
    targetId: applicationId,
    targetName: `${classRow.course_name} / ${classRow.class_name}`,
    details: `申请人：${user.user_name}\n教学班：${classRow.class_name}\n教授：${classRow.teacher_name}${reason ? `\n申请原因：${reason}` : ""}`
  });
  const emailJobs = taAdmins.map((admin) => buildTaAdminNewApplicationEmail(admin, user, classRow));
  db.close();
  const emailErrors = await sendEmailsAndCollectErrors(emailJobs);
  redirect(res, `/ta/applications?notice=${emailErrors.length ? "申请已提交，站内通知已发送，部分邮件发送失败" : "申请已提交，站内通知和邮件已发送"}`);
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
  const result = await dbGateway.updateTaResume(user.user_id, storedFile.originalName, storedFile.relativePath);
  if (result?.previousResumePath) {
    const oldFilePath = path.join(UPLOAD_DIR, path.basename(result.previousResumePath));
    if (fs.existsSync(oldFilePath)) {
      fs.unlinkSync(oldFilePath);
    }
  }
  redirect(res, "/ta/profile?notice=个人简历已更新");
}

async function taApplicationsPage(res, user, notice) {
  const apps = await dbGateway.getTaApplications(user.user_id);
  const pendingApps = apps.filter((app) => ["PendingTAAdmin", "PendingProfessor"].includes(app.status));
  const approvedApps = apps.filter((app) => app.status === "Approved");
  const pendingCredit = pendingApps.reduce((sum, app) => sum + Number(app.class_credit || 0), 0);
  const approvedCredit = approvedApps.reduce((sum, app) => sum + Number(app.class_credit || 0), 0);
  const summaryCards = `
    <div class="ta-summary-grid">
      <article class="ta-summary-card">
        <div class="summary-label">待审批教学班数</div>
        <div class="summary-value">${pendingApps.length}</div>
        <div class="summary-footnote">包含待 TAAdmin 与待 Professor 审批</div>
      </article>
      <article class="ta-summary-card">
        <div class="summary-label">待审批申请学分</div>
        <div class="summary-value">${pendingCredit.toFixed(1)}</div>
        <div class="summary-footnote">当前所有待处理申请对应学分合计</div>
      </article>
      <article class="ta-summary-card">
        <div class="summary-label">已通过教学班数</div>
        <div class="summary-value">${approvedApps.length}</div>
        <div class="summary-footnote">最终通过的教学班数量</div>
      </article>
      <article class="ta-summary-card">
        <div class="summary-label">已通过教学学分合计</div>
        <div class="summary-value">${approvedCredit.toFixed(1)}</div>
        <div class="summary-footnote">当前已通过申请的学分合计</div>
      </article>
    </div>
  `;
  const rows = apps.map((app) => `<tr>
    <td>${escapeHtml(app.class_name)}</td>
    <td>${escapeHtml(app.teacher_name || "-")}</td>
    <td>${escapeHtml(Number(app.class_credit || 0) > 0 ? Number(app.class_credit).toFixed(1) : "-")}</td>
    <td>${escapeHtml(normalizeDisplayDateTime(app.submitted_at))}</td>
    <td>${escapeHtml(statusLabels[app.status])}</td>
    <td>${escapeHtml(app.ta_comment || "")}</td>
    <td>${escapeHtml(app.prof_comment || "")}</td>
    <td class="table-action-cell"><div class="table-action-inner application-actions">
      <a class="button-link secondary action-button" href="/ta/applications/${app.application_id}">详情</a>
      ${app.status === "PendingTAAdmin" ? `<form class="inline" method="post" action="/ta/applications/${app.application_id}/withdraw" onsubmit="return confirm('确认撤销这条申请吗？撤销后需要重新提交申请。');"><button class="danger action-button" type="submit">撤销</button></form>` : `<span class="action-placeholder" aria-hidden="true"></span>`}
    </div></td>
  </tr>`).join("");
  const cards = apps.map((app) => `
    <article class="mobile-data-card">
      <h3>${escapeHtml(app.class_name)}</h3>
      <div class="mobile-meta">
        <span>${escapeHtml(statusLabels[app.status])}</span>
        <span>${escapeHtml(normalizeDisplayDateTime(app.submitted_at))}</span>
      </div>
      <div class="mobile-data-list">
        <div class="mobile-data-row">
          <div class="mobile-data-label">教授</div>
          <div class="mobile-data-value">${escapeHtml(app.teacher_name || "-")}</div>
        </div>
        <div class="mobile-data-row">
          <div class="mobile-data-label">学分</div>
          <div class="mobile-data-value">${escapeHtml(Number(app.class_credit || 0) > 0 ? Number(app.class_credit).toFixed(1) : "-")}</div>
        </div>
        <div class="mobile-data-row">
          <div class="mobile-data-label">TA备注</div>
          <div class="mobile-data-value">${escapeHtml(app.ta_comment || "-")}</div>
        </div>
        <div class="mobile-data-row">
          <div class="mobile-data-label">教授备注</div>
          <div class="mobile-data-value">${escapeHtml(app.prof_comment || "-")}</div>
        </div>
      </div>
      <div class="actions" style="margin-top:12px;">
        <a class="button-link secondary action-button" href="/ta/applications/${app.application_id}">详情</a>
        ${app.status === "PendingTAAdmin" ? `<form class="inline" method="post" action="/ta/applications/${app.application_id}/withdraw" onsubmit="return confirm('确认撤销这条申请吗？撤销后需要重新提交申请。');"><button class="danger action-button" type="submit">撤销</button></form>` : ""}
      </div>
    </article>
  `).join("");
  sendHtml(res, pageLayout("我的申请", `
    <section class="card">
      <h2>我的申请</h2>
      ${summaryCards}
      <div class="desktop-only">
        <div class="table-wrap">
          <table>
            <tr><th>教学班</th><th>教授</th><th>学分</th><th>申请时间</th><th>状态</th><th>TAAdmin 备注</th><th>Professor 备注</th><th>操作</th></tr>${rows}
          </table>
        </div>
      </div>
      <div class="mobile-only">
        ${cards ? `<div class="mobile-card-list">${cards}</div>` : `<p class="muted">你还没有提交过申请。</p>`}
      </div>
    </section>
  `, user, notice));
}

async function taApplicationDetailPage(res, user, applicationId, notice) {
  const { app, logs, auditRows } = await dbGateway.getTaApplicationDetail(applicationId, user.user_id);
  if (!app) {
    return sendHtml(res, pageLayout("未找到", '<section class="card">申请不存在。</section>', user, notice), {}, 404);
  }
  const logRows = logs.map((log) => `<tr><td>${escapeHtml(log.approval_stage)}</td><td>${escapeHtml(log.approver_name)}</td><td>${escapeHtml(log.result)}</td><td>${escapeHtml(log.comments || "")}</td><td>${escapeHtml(normalizeDisplayDateTime(log.acted_at))}</td></tr>`).join("");
  sendHtml(res, pageLayout("申请详情", `
    <section class="card">
      <h2>${escapeHtml(app.class_name)}</h2>
      <p>当前状态：<span class="pill">${escapeHtml(statusLabels[app.status])}</span></p>
      <p>申请原因：${escapeHtml(app.application_reason || "-")}</p>
      <p>简历：${attachmentLink(app)}</p>
      <p>TAAdmin 备注：${escapeHtml(app.ta_comment || "")}</p>
      <p>Professor 备注：${escapeHtml(app.prof_comment || "")}</p>
      ${app.status === "PendingTAAdmin" ? `<form method="post" action="/ta/applications/${applicationId}/withdraw" onsubmit="return confirm('确认撤销这条申请吗？撤销后需要重新提交申请。');"><button class="danger action-button" type="submit">撤销申请</button></form>` : ""}
    </section>
    <section class="card">
      <h3>审批日志</h3>
      <div class="detail-table-wrap"><table><tr><th>阶段</th><th>审批人</th><th>结果</th><th>备注</th><th>时间</th></tr>${logRows}</table></div>
    </section>
    ${renderApplicationAuditSection(auditRows)}
  `, user, notice));
}

async function withdrawApplication(res, user, applicationId) {
  const result = await dbGateway.withdrawTaApplication(user, applicationId);
  if (!result.ok) {
    return redirect(res, `/ta/applications?notice=${result.notice}`);
  }
  redirect(res, "/ta/applications?notice=申请已撤销");
}

async function taAdminPendingPage(res, user, notice, filters = {}) {
  if (DB_CLIENT === "mysql") {
    const apps = await dbGateway.getTaAdminPendingApplications(filters);
    const rows = apps.map((app) => `<tr>
      <td><input class="pending-app-select" type="checkbox" value="${app.application_id}" /></td>
      <td>${escapeHtml(app.applier_name)}</td>
      <td>${escapeHtml(app.class_name)}</td>
      <td>${escapeHtml(app.teacher_name)}</td>
      <td>${escapeHtml(normalizeDisplayDateTime(app.submitted_at))}</td>
      <td>${escapeHtml(app.application_reason)}</td>
      <td class="table-action-cell"><div class="table-action-inner"><a class="button-link secondary action-button" href="/admin/ta/pending/${app.application_id}">详情</a></div></td>
    </tr>`).join("");
    return sendHtml(res, pageLayout("待初审申请", `
      <section class="card">
        <h2>筛选待审批申请</h2>
        <form method="get" action="/admin/ta/pending">
          <div class="filters-shell">
          <div class="filters-grid">
            <p><label>申请学生<input name="applier_name" value="${escapeHtml(filters.applier_name || "")}" /></label></p>
            <p><label>教学班<input name="class_name" value="${escapeHtml(filters.class_name || "")}" /></label></p>
            <p><label>教授<input name="teacher_name" value="${escapeHtml(filters.teacher_name || "")}" /></label></p>
            <div class="actions">
              <button class="secondary action-button" type="submit">筛选</button>
              <a class="button-link secondary action-button" href="/admin/ta/pending">重置</a>
            </div>
          </div>
          </div>
        </form>
      </section>
      <section class="card">
        <h2>批量审批</h2>
        <form method="post" action="/admin/ta/pending/batch-approve" onsubmit="return submitSelectedPendingApplications(this);">
          <input type="hidden" name="application_ids" value="" />
          <div class="grid">
            <p><label>审批结果
              <select name="result">
                <option value="Approved">通过</option>
                <option value="Rejected">拒绝</option>
              </select>
            </label></p>
            <p><label>审批备注<textarea name="comments"></textarea></label></p>
          </div>
          <div class="actions">
            <button type="submit">批量审批</button>
            <span class="muted">当前已选 <strong id="selected-pending-count">0</strong> 条申请</span>
          </div>
        </form>
      </section>
      <section class="card">
        <h2>待 TAAdmin 审批</h2>
        <div class="actions" style="margin-bottom:12px;">
          <label><input type="checkbox" id="select-all-pending-apps" /> 全选当前列表</label>
        </div>
        <div class="table-wrap list-scroll"><table><tr><th style="width:56px;">选择</th><th>申请人</th><th>教学班</th><th>教授</th><th>申请时间</th><th>申请原因</th><th>操作</th></tr>${rows}</table></div>
      </section>
      <script>
        (() => {
          const checkboxes = Array.from(document.querySelectorAll('.pending-app-select'));
          const selectAll = document.getElementById('select-all-pending-apps');
          const countNode = document.getElementById('selected-pending-count');
          const refresh = () => {
            const checked = checkboxes.filter((item) => item.checked);
            if (countNode) countNode.textContent = String(checked.length);
            if (selectAll) {
              selectAll.checked = checked.length > 0 && checked.length === checkboxes.length;
              selectAll.indeterminate = checked.length > 0 && checked.length < checkboxes.length;
            }
          };
          if (selectAll) {
            selectAll.addEventListener('change', () => {
              checkboxes.forEach((item) => { item.checked = selectAll.checked; });
              refresh();
            });
          }
          checkboxes.forEach((item) => item.addEventListener('change', refresh));
          window.submitSelectedPendingApplications = (form) => {
            const selected = checkboxes.filter((item) => item.checked).map((item) => item.value);
            if (!selected.length) {
              window.alert('请先勾选至少一条申请');
              return false;
            }
            form.querySelector('input[name="application_ids"]').value = selected.join(',');
            return true;
          };
          refresh();
        })();
      </script>
    `, user, notice));
  }
  const db = getDb();
  const studentFilter = String(filters.applier_name || "").trim().toLowerCase();
  const classFilter = String(filters.class_name || "").trim().toLowerCase();
  const teacherFilter = String(filters.teacher_name || "").trim().toLowerCase();
  const apps = db.prepare("select * from applications where status = 'PendingTAAdmin' order by submitted_at").all()
    .filter((app) => !studentFilter || String(app.applier_name || "").toLowerCase().includes(studentFilter))
    .filter((app) => !classFilter || String(app.class_name || "").toLowerCase().includes(classFilter))
    .filter((app) => !teacherFilter || String(app.teacher_name || "").toLowerCase().includes(teacherFilter));
  db.close();
  const rows = apps.map((app) => `<tr>
    <td><input class="pending-app-select" type="checkbox" value="${app.application_id}" /></td>
    <td>${escapeHtml(app.applier_name)}</td>
    <td>${escapeHtml(app.class_name)}</td>
    <td>${escapeHtml(app.teacher_name)}</td>
    <td>${escapeHtml(normalizeDisplayDateTime(app.submitted_at))}</td>
    <td>${escapeHtml(app.application_reason)}</td>
    <td class="table-action-cell"><div class="table-action-inner"><a class="button-link secondary action-button" href="/admin/ta/pending/${app.application_id}">详情</a></div></td>
  </tr>`).join("");
  sendHtml(res, pageLayout("待初审申请", `
    <section class="card">
      <h2>筛选待审批申请</h2>
      <form method="get" action="/admin/ta/pending">
        <div class="filters-shell">
        <div class="filters-grid">
          <p><label>申请学生<input name="applier_name" value="${escapeHtml(filters.applier_name || "")}" /></label></p>
          <p><label>教学班<input name="class_name" value="${escapeHtml(filters.class_name || "")}" /></label></p>
          <p><label>教授<input name="teacher_name" value="${escapeHtml(filters.teacher_name || "")}" /></label></p>
          <div class="actions">
            <button class="secondary action-button" type="submit">筛选</button>
            <a class="button-link secondary action-button" href="/admin/ta/pending">重置</a>
          </div>
        </div>
        </div>
      </form>
    </section>
    <section class="card">
      <h2>批量审批</h2>
      <form method="post" action="/admin/ta/pending/batch-approve" onsubmit="return submitSelectedPendingApplications(this);">
        <input type="hidden" name="application_ids" value="" />
        <div class="grid">
          <p><label>审批结果
            <select name="result">
              <option value="Approved">通过</option>
              <option value="Rejected">拒绝</option>
            </select>
          </label></p>
          <p><label>审批备注<textarea name="comments"></textarea></label></p>
        </div>
        <div class="actions">
          <button type="submit">批量审批</button>
          <span class="muted">当前已选 <strong id="selected-pending-count">0</strong> 条申请</span>
        </div>
      </form>
    </section>
    <section class="card">
      <h2>待 TAAdmin 审批</h2>
      <div class="actions" style="margin-bottom:12px;">
        <label><input type="checkbox" id="select-all-pending-apps" /> 全选当前列表</label>
      </div>
      <div class="table-wrap list-scroll"><table><tr><th style="width:56px;">选择</th><th>申请人</th><th>教学班</th><th>教授</th><th>申请时间</th><th>申请原因</th><th>操作</th></tr>${rows}</table></div>
    </section>
    <script>
      (() => {
        const checkboxes = Array.from(document.querySelectorAll('.pending-app-select'));
        const selectAll = document.getElementById('select-all-pending-apps');
        const countNode = document.getElementById('selected-pending-count');
        const refresh = () => {
          const checked = checkboxes.filter((item) => item.checked);
          if (countNode) countNode.textContent = String(checked.length);
          if (selectAll) {
            selectAll.checked = checked.length > 0 && checked.length === checkboxes.length;
            selectAll.indeterminate = checked.length > 0 && checked.length < checkboxes.length;
          }
        };
        if (selectAll) {
          selectAll.addEventListener('change', () => {
            checkboxes.forEach((item) => { item.checked = selectAll.checked; });
            refresh();
          });
        }
        checkboxes.forEach((item) => item.addEventListener('change', refresh));
        window.submitSelectedPendingApplications = (form) => {
          const selected = checkboxes.filter((item) => item.checked).map((item) => item.value);
          if (!selected.length) {
            window.alert('请先勾选至少一条申请');
            return false;
          }
          form.querySelector('input[name="application_ids"]').value = selected.join(',');
          return true;
        };
        refresh();
      })();
    </script>
  `, user, notice));
}

async function taAdminDetailPage(res, user, applicationId, notice) {
  if (DB_CLIENT === "mysql") {
    const app = await dbGateway.getApplicationById(applicationId);
    if (!app) {
      return sendHtml(res, pageLayout("未找到", '<section class="card">申请不存在。</section>', user, notice), {}, 404);
    }
    const conflictApps = await dbGateway.getApplicationConflicts(app.applier_user_id, app.class_id);
    const auditRows = await dbGateway.getApplicationAuditRows(applicationId);
    const conflictSection = conflictApps.length
      ? `<section class="card">
          <h3>该学生已申请的冲突教学班</h3>
          <table><tr><th>教学班</th><th>当前状态</th><th>是否允许冲突申请</th><th>冲突时间</th></tr>${
            conflictApps.map((conflictApp) => `<tr><td>${escapeHtml(conflictApp.class_name)}</td><td>${escapeHtml(statusLabels[conflictApp.status] || conflictApp.status)}</td><td>${escapeHtml(conflictApp.is_conflict_allowed || "N")}</td><td>${conflictApp.matches.map(escapeHtml).join("<br>")}</td></tr>`).join("")
          }</table>
        </section>`
      : `<section class="card"><h3>该学生已申请的冲突教学班</h3><p class="muted">当前未发现该学生已申请的冲突教学班。</p></section>`;
    return sendHtml(res, pageLayout("TAAdmin 审批", `
      <section class="card">
        <h2>${escapeHtml(app.applier_name)} - ${escapeHtml(app.class_name)}</h2>
        <p>状态：${escapeHtml(statusLabels[app.status])}</p>
        <p>申请原因：${escapeHtml(app.application_reason || "-")}</p>
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
      ${renderApplicationAuditSection(auditRows)}
      ${adminOverrideSection(`/admin/ta/applications/${applicationId}/override-status`, app.status)}
    `, user, notice));
  }
  const db = getDb();
  const app = db.prepare("select * from applications where application_id = ?").get(applicationId);
  if (!app) {
    db.close();
    return sendHtml(res, pageLayout("未找到", '<section class="card">申请不存在。</section>', user, notice), {}, 404);
    return;
  }
  const conflictApps = getAppliedConflicts(db, app.applier_user_id, app.class_id);
  const auditRows = applicationAuditRows(db, applicationId);
  db.close();
  const conflictSection = conflictApps.length
    ? `<section class="card">
        <h3>该学生已申请的冲突教学班</h3>
        <table><tr><th>教学班</th><th>当前状态</th><th>是否允许冲突申请</th><th>冲突时间</th></tr>${
          conflictApps.map((item) => {
            const conflictApp = item.app || item;
            const matches = item.matches || [];
            return `<tr><td>${escapeHtml(conflictApp.class_name || "-")}</td><td>${escapeHtml(statusLabels[conflictApp.status] || conflictApp.status || "-")}</td><td>${escapeHtml(conflictApp.is_conflict_allowed || "N")}</td><td>${matches.map(escapeHtml).join("<br>")}</td></tr>`;
          }).join("")
        }</table>
      </section>`
    : `<section class="card"><h3>该学生已申请的冲突教学班</h3><p class="muted">当前未发现该学生已申请的冲突教学班。</p></section>`;
  sendHtml(res, pageLayout("TAAdmin 审批", `
    <section class="card">
      <h2>${escapeHtml(app.applier_name)} - ${escapeHtml(app.class_name)}</h2>
      <p>状态：${escapeHtml(statusLabels[app.status])}</p>
      <p>申请原因：${escapeHtml(app.application_reason || "-")}</p>
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
    ${renderApplicationAuditSection(auditRows)}
    ${adminOverrideSection(`/admin/ta/applications/${applicationId}/override-status`, app.status)}
  `, user, notice));
}

function applyTaAdminDecision(db, approver, app, result, comments) {
  const actedAt = nowStr();
  const nextStatus = result === "Approved" ? "PendingProfessor" : "RejectedByTAAdmin";
  db.prepare(`
    update applications
    set status = ?, ta_comment = ?, ta_acted_at = ?
    where application_id = ? and status = 'PendingTAAdmin'
  `).run(nextStatus, comments, actedAt, app.application_id);
  db.prepare(`
    insert into approval_logs (application_id, approval_stage, approver_user_id, approver_name, result, comments, acted_at)
    values (?, 'TAAdmin', ?, ?, ?, ?, ?)
  `).run(app.application_id, approver.user_id, approver.user_name, result, comments, actedAt);
  createAuditLog(db, {
    actor: approver,
    actionType: result === "Approved" ? "TAADMIN_APPROVE" : "TAADMIN_REJECT",
    targetType: "Application",
    targetId: app.application_id,
    targetName: app.class_name,
    details: `申请人：${app.applier_name}\n审批结果：${result === "Approved" ? "通过" : "拒绝"}\n新状态：${statusLabels[nextStatus] || nextStatus}${comments ? `\n备注：${comments}` : ""}`
  });
  if (result === "Approved") {
    createNotification(db, app.applier_user_id, "TA 预审通过", `你的申请《${app.class_name}》已通过 TAAdmin 预审，待发布给 Professor 后进入最终审核。`, `/ta/applications/${app.application_id}`);
  } else {
    createNotification(db, app.applier_user_id, "TA 审批未通过", `你的申请《${app.class_name}》被 TAAdmin 拒绝。`, `/ta/applications/${app.application_id}`);
  }
  return nextStatus;
}

async function taAdminApprove(req, res, user, applicationId) {
  const body = await readBody(req);
  const result = String(body.result || "Rejected");
  const comments = String(body.comments || "").trim();
  if (DB_CLIENT === "mysql") {
    const decision = await dbGateway.applyTaAdminDecision(user, applicationId, result, comments, nowStr());
    if (!decision.ok) {
      return redirect(res, "/admin/ta/pending?notice=申请已被处理");
    }
    const emailErrors = await sendEmailsAndCollectErrors([buildTaDecisionEmail(decision.applicant, decision.app, result, comments)]);
    if (emailErrors.length) {
      await dbGateway.appendAuditLog({
        actor: user,
        actionType: "EMAIL_PARTIAL_FAILURE",
        targetType: "Application",
        targetId: applicationId,
        targetName: decision.app.class_name,
        details: `场景：TAAdmin单条审批\n失败邮件：\n${emailErrors.join("\n")}`,
        createdAt: nowStr()
      });
    }
    return redirect(res, `/admin/ta/pending?notice=${emailErrors.length ? "审批已完成，站内通知已发送，部分邮件发送失败" : "审批已完成，站内通知和邮件已发送"}`);
  }
  const db = getDb();
  const app = db.prepare("select * from applications where application_id = ?").get(applicationId);
  if (!app || app.status !== "PendingTAAdmin") {
    db.close();
    return redirect(res, "/admin/ta/pending?notice=申请已被处理");
  }
  const applicant = db.prepare("select user_id, user_name, email from users where user_id = ?").get(app.applier_user_id);
  try {
    applyTaAdminDecision(db, user, app, result, comments);
  } catch (error) {
    db.close();
    return redirect(res, `/admin/ta/pending/${applicationId}?notice=${error.message}`);
  }
  db.close();
  const emailErrors = await sendEmailsAndCollectErrors([buildTaDecisionEmail(applicant, app, result, comments)]);
  if (emailErrors.length) {
    const auditDb = getDb();
    createAuditLog(auditDb, {
      actor: user,
      actionType: "EMAIL_PARTIAL_FAILURE",
      targetType: "Application",
      targetId: applicationId,
      targetName: app.class_name,
      details: `场景：TAAdmin单条审批\n失败邮件：\n${emailErrors.join("\n")}`
    });
    auditDb.close();
  }
  redirect(res, `/admin/ta/pending?notice=${emailErrors.length ? "审批已完成，站内通知已发送，部分邮件发送失败" : "审批已完成，站内通知和邮件已发送"}`);
}

async function taAdminBatchApprove(req, res, user) {
  const body = await readBody(req);
  const applicationIds = parseIdList(body.application_ids);
  const result = String(body.result || "Rejected");
  const comments = String(body.comments || "").trim();
  if (!applicationIds.length) {
    return redirect(res, "/admin/ta/pending?notice=请先勾选至少一条申请");
  }
  if (DB_CLIENT === "mysql") {
    const batchResult = await dbGateway.batchApplyTaAdminDecision(user, applicationIds, result, comments, nowStr());
    const emailJobs = batchResult.emailPayloads.map((item) => buildTaDecisionEmail(item.applicant, item.app, result, comments));
    const emailErrors = await sendEmailsAndCollectErrors(emailJobs);
    if (emailErrors.length) {
      await dbGateway.appendAuditLog({
        actor: user,
        actionType: "EMAIL_PARTIAL_FAILURE",
        targetType: "Application",
        targetId: applicationIds.join(","),
        targetName: "TAAdmin批量审批",
        details: `场景：TAAdmin批量审批\n失败邮件：\n${emailErrors.join("\n")}`,
        createdAt: nowStr()
      });
    }
    return redirect(res, `/admin/ta/pending?notice=${emailErrors.length ? `批量审批完成：成功 ${batchResult.processed} 条，跳过 ${batchResult.skipped} 条；部分邮件发送失败` : `批量审批完成：成功 ${batchResult.processed} 条，跳过 ${batchResult.skipped} 条；站内通知和邮件已发送`}`);
  }
  const db = getDb();
  const selectApp = db.prepare("select * from applications where application_id = ?");
  const selectApplicant = db.prepare("select user_id, user_name, email from users where user_id = ?");
  let processed = 0;
  let skipped = 0;
  const emailJobs = [];
  try {
    db.exec("BEGIN");
    for (const applicationId of applicationIds) {
      const app = selectApp.get(applicationId);
      if (!app || app.status !== "PendingTAAdmin") {
        skipped += 1;
        continue;
      }
      applyTaAdminDecision(db, user, app, result, comments);
      emailJobs.push(buildTaDecisionEmail(selectApplicant.get(app.applier_user_id), app, result, comments));
      processed += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    return redirect(res, `/admin/ta/pending?notice=${error.message}`);
  }
  db.close();
  const emailErrors = await sendEmailsAndCollectErrors(emailJobs);
  if (emailErrors.length) {
    const auditDb = getDb();
    createAuditLog(auditDb, {
      actor: user,
      actionType: "EMAIL_PARTIAL_FAILURE",
      targetType: "Application",
      targetId: applicationIds.join(","),
      targetName: "TAAdmin批量审批",
      details: `场景：TAAdmin批量审批\n失败邮件：\n${emailErrors.join("\n")}`
    });
    auditDb.close();
  }
  redirect(res, `/admin/ta/pending?notice=${emailErrors.length ? `批量审批完成：成功 ${processed} 条，跳过 ${skipped} 条；部分邮件发送失败` : `批量审批完成：成功 ${processed} 条，跳过 ${skipped} 条；站内通知和邮件已发送`}`);
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
  createAuditLog(db, {
    actor,
    actionType: "ADMIN_OVERRIDE_STATUS",
    targetType: "Application",
    targetId: app.application_id,
    targetName: app.class_name,
    details: `申请人：${app.applier_name}\n原状态：${statusLabels[app.status] || app.status}\n新状态：${statusLabels[nextStatus] || nextStatus}\n调整说明：${comments}`
  });
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

async function taUsersPage(res, user, notice) {
  const rows = await dbGateway.getTaUsersManagementRows();
  const htmlRows = rows.map((row) => `<tr>
    <td>${escapeHtml(row.user_name)}</td>
    <td>${escapeHtml(row.login_name)}</td>
    <td>${escapeHtml(row.email)}</td>
    <td>${escapeHtml(row.is_allowed_to_apply)}</td>
    <td>${row.application_count}</td>
    <td>${row.approved_count}</td>
    <td class="table-action-cell"><div class="table-action-inner"><form class="inline" method="post" action="/admin/ta/users/${row.user_id}/toggle"><button type="submit">${row.is_allowed_to_apply === "Y" ? "关闭资格" : "开启资格"}</button></form></div></td>
  </tr>`).join("");
  sendHtml(res, pageLayout("TA 管理", `<section class="card"><h2>TA 管理</h2><div class="table-wrap list-scroll"><table><tr><th>姓名</th><th>账号</th><th>邮箱</th><th>允许申请</th><th>申请数</th><th>已通过</th><th>操作</th></tr>${htmlRows}</table></div></section>`, user, notice));
}

async function notificationsPage(res, user, notice) {
  const rows = await dbGateway.getNotificationsByUser(user.user_id);
  const tableRows = rows.map((row) => `<tr>
    <td>${row.notification_id}</td>
    <td>${escapeHtml(row.title)}</td>
    <td>${escapeHtml(row.content)}</td>
    <td>${escapeHtml(normalizeDisplayDateTime(row.created_at))}</td>
    <td>${row.is_read === "Y" ? "已读" : "未读"}</td>
    <td class="table-action-cell"><div class="table-action-inner notifications-actions">${row.target_path ? `<a class="button-link secondary action-button" href="${escapeHtml(row.target_path)}">查看</a>` : `<span class="action-placeholder" aria-hidden="true"></span>`}${row.is_read === "N" ? `<form class="inline" method="post" action="/notifications/${row.notification_id}/read"><button class="secondary action-button" type="submit">标为已读</button></form>` : `<span class="action-placeholder" aria-hidden="true"></span>`}</div></td>
  </tr>`).join("");
  const mobileCards = rows.map((row) => `
    <article class="notification-card">
      <div class="notification-card-header">
        <h3>${escapeHtml(row.title)}</h3>
        ${row.is_read === "Y" ? `<span class="pill">已读</span>` : `<span class="pill ok">未读</span>`}
      </div>
      <p>${escapeHtml(row.content)}</p>
      <div class="notification-card-meta">
        <span>ID ${row.notification_id}</span>
        <span>${escapeHtml(normalizeDisplayDateTime(row.created_at))}</span>
      </div>
      <div class="notification-card-actions">
        ${row.target_path ? `<a class="button-link secondary action-button" href="${escapeHtml(row.target_path)}">查看</a>` : `<span class="action-placeholder" aria-hidden="true"></span>`}
        ${row.is_read === "N" ? `<form class="inline" method="post" action="/notifications/${row.notification_id}/read"><button class="secondary action-button" type="submit">标为已读</button></form>` : `<span class="action-placeholder" aria-hidden="true"></span>`}
      </div>
    </article>
  `).join("");
  sendHtml(res, pageLayout("通知中心", `
    <section class="card">
      <h2>通知中心</h2>
      <div class="table-wrap list-scroll desktop-only notification-desktop-only"><table class="notification-table"><tr><th>ID</th><th>标题</th><th>内容</th><th>时间</th><th>状态</th><th>操作</th></tr>${tableRows}</table></div>
      <div class="mobile-only notification-mobile-only notification-card-list">${mobileCards || `<p class="muted">当前没有通知。</p>`}</div>
    </section>
  `, user, notice));
}

async function courseAuditLogsPage(res, user, notice, filters = {}) {
  const actionType = String(filters.action_type || "").trim();
  const actorName = String(filters.actor_name || "").trim().toLowerCase();
  const targetType = String(filters.target_type || "").trim();
  const rows = await dbGateway.getAuditLogs(filters);
  const actionOptions = Object.entries(auditActionLabels)
    .map(([value, label]) => `<option value="${value}" ${actionType === value ? "selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
  const rowsHtml = rows.map((row) => `<tr class="audit-row-${auditActionTone(row.action_type)}">
    <td>${escapeHtml(normalizeDisplayDateTime(row.created_at))}</td>
    <td>${escapeHtml(row.actor_name || "系统")}</td>
    <td>${escapeHtml(row.actor_role || "System")}</td>
    <td>${renderAuditActionBadge(row.action_type)}</td>
    <td>${escapeHtml(row.target_type)}</td>
    <td>${escapeHtml(row.target_name || row.target_id || "-")}</td>
    <td>${renderAuditDetails(row.details)}</td>
  </tr>`).join("");
  sendHtml(res, pageLayout("审计日志", `
    <section class="card">
      <h2>审计日志</h2>
      <form method="get" action="/course/audit-logs">
        <div class="filters-shell">
          <div class="filters-grid">
            <p><label>操作人<input name="actor_name" value="${escapeHtml(filters.actor_name || "")}" /></label></p>
            <p><label>动作类型<select name="action_type"><option value="">全部</option>${actionOptions}</select></label></p>
            <p><label>对象类型<select name="target_type">
              <option value="">全部</option>
              <option value="Application" ${targetType === "Application" ? "selected" : ""}>Application</option>
              <option value="Class" ${targetType === "Class" ? "selected" : ""}>Class</option>
              <option value="User" ${targetType === "User" ? "selected" : ""}>User</option>
            </select></label></p>
            <p><label>关键字<input name="keyword" value="${escapeHtml(filters.keyword || "")}" /></label></p>
            <div class="actions">
              <button class="secondary action-button" type="submit">筛选</button>
              <a class="button-link secondary action-button" href="/course/audit-logs">重置</a>
            </div>
          </div>
        </div>
      </form>
    </section>
    <section class="card">
      <h3>操作记录</h3>
      <div class="table-wrap list-scroll">
        <table class="wide audit-log-table">
          <tr><th>时间</th><th>操作人</th><th>角色</th><th>动作</th><th>对象类型</th><th>对象</th><th>详情</th></tr>
          ${rowsHtml || '<tr><td colspan="7" class="muted">暂无审计日志。</td></tr>'}
        </table>
      </div>
    </section>
  `, user, notice));
}

function applicationAuditRows(db, applicationId) {
  return db.prepare(`
    select created_at, actor_name, actor_role, action_type, target_name, details
    from audit_logs
    where target_type = 'Application'
      and target_id = ?
    order by created_at, audit_log_id
  `).all(String(applicationId));
}

function renderApplicationAuditSection(rows) {
  const rowHtml = rows.map((row) => `<tr class="audit-row-${auditActionTone(row.action_type)}">
    <td>${escapeHtml(normalizeDisplayDateTime(row.created_at))}</td>
    <td>${escapeHtml(row.actor_name || "系统")}</td>
    <td>${escapeHtml(row.actor_role || "System")}</td>
    <td>${renderAuditActionBadge(row.action_type)}</td>
    <td>${renderAuditDetails(row.details)}</td>
  </tr>`).join("");
  return `
    <section class="card">
      <h3>申请业务日志</h3>
      <div class="detail-table-wrap"><table class="audit-log-table">
        <tr><th>时间</th><th>操作人</th><th>角色</th><th>动作</th><th>详情</th></tr>
        ${rowHtml || '<tr><td colspan="5" class="muted">暂无业务日志。</td></tr>'}
      </table></div>
    </section>
  `;
}

function buildApplicationAuditMap(db) {
  const rows = db.prepare(`
    select target_id, created_at, actor_name, actor_role, action_type, details
    from audit_logs
    where target_type = 'Application'
    order by created_at desc, audit_log_id desc
  `).all();
  const map = new Map();
  rows.forEach((row) => {
    const key = String(row.target_id || "");
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
}

function renderApplicationAuditTimeline(rows) {
  if (!rows || !rows.length) {
    return '<div class="audit-timeline-empty">暂无申请日志</div>';
  }
  const preview = rows.slice(0, 3).map((row) => `
    <div class="audit-timeline-item audit-row-${auditActionTone(row.action_type)}">
      <div class="audit-timeline-meta">
        ${renderAuditActionBadge(row.action_type)}
        <span class="audit-timeline-time">${escapeHtml(normalizeDisplayDateTime(row.created_at))}</span>
      </div>
      <div class="audit-timeline-actor">${escapeHtml(row.actor_name || "系统")} · ${escapeHtml(row.actor_role || "System")}</div>
    </div>
  `).join("");
  return `
    <div class="audit-timeline">
      ${preview}
      ${rows.length > 3 ? `<div class="audit-summary-count">共 ${rows.length} 条日志，最近显示 3 条</div>` : ""}
    </div>
  `;
}

function applicationStatusPillClass(status) {
  if (status === "PendingTAAdmin") return "pill gold";
  if (status === "Approved" || status === "PendingProfessor") return "pill ok";
  if (status === "RejectedByTAAdmin" || status === "RejectedByProfessor") return "pill bad";
  return "pill muted";
}

async function applicationLogListPage(res, user, notice, filters = {}, options) {
  if (DB_CLIENT === "mysql") {
    const studentFilter = String(filters.applier_name || "").trim().toLowerCase();
    const classFilter = String(filters.class_name || "").trim().toLowerCase();
    const teacherFilter = String(filters.teacher_name || "").trim().toLowerCase();
    const statusFilter = String(filters.status || "").trim();
    const submittedFrom = String(filters.submitted_from || "").trim();
    const submittedTo = String(filters.submitted_to || "").trim();
    const [apps, auditRows] = await Promise.all([
      dbGateway.getAllApplications(),
      dbGateway.getAllApplicationAuditRows()
    ]);
    const auditMap = new Map();
    auditRows.forEach((row) => {
      const key = String(row.target_id || "");
      if (!auditMap.has(key)) auditMap.set(key, []);
      auditMap.get(key).push(row);
    });
    const rows = apps
      .filter((app) => !studentFilter || String(app.applier_name || "").toLowerCase().includes(studentFilter))
      .filter((app) => !classFilter || String(app.class_name || "").toLowerCase().includes(classFilter))
      .filter((app) => !teacherFilter || String(app.teacher_name || "").toLowerCase().includes(teacherFilter))
      .filter((app) => !statusFilter || String(app.status || "") === statusFilter)
      .filter((app) => !submittedFrom || normalizeDisplayDate(app.submitted_at) >= submittedFrom)
      .filter((app) => !submittedTo || normalizeDisplayDate(app.submitted_at) <= submittedTo)
      .map((app) => ({ ...app, auditRows: auditMap.get(String(app.application_id)) || [] }));
    const tableRows = rows.map((app) => {
      const latest = app.auditRows[0];
      return `<tr>
        <td>${app.application_id}</td>
        <td>${escapeHtml(app.applier_name)}</td>
        <td>${escapeHtml(app.class_name)}</td>
        <td>${escapeHtml(app.teacher_name)}</td>
        <td><span class="${applicationStatusPillClass(app.status)}">${escapeHtml(statusLabels[app.status] || app.status)}</span></td>
        <td>${latest ? `${renderAuditActionBadge(latest.action_type)}<div class="audit-summary-count">${escapeHtml(normalizeDisplayDateTime(latest.created_at))}</div>` : '<span class="muted">暂无</span>'}</td>
        <td>${renderApplicationAuditTimeline(app.auditRows)}</td>
        <td class="table-action-cell"><div class="table-action-inner"><a class="button-link secondary action-button" href="${options.detailBasePath}/${app.application_id}">查看详情</a></div></td>
      </tr>`;
    }).join("");
    return sendHtml(res, pageLayout(options.title, `
      <section class="card">
        <h2>筛选申请日志</h2>
        <form method="get" action="${options.listPath}">
          <div class="filters-shell">
            <div class="filters-grid">
              <p><label>申请学生<input name="applier_name" value="${escapeHtml(filters.applier_name || "")}" /></label></p>
              <p><label>教学班<input name="class_name" value="${escapeHtml(filters.class_name || "")}" /></label></p>
              <p><label>教授<input name="teacher_name" value="${escapeHtml(filters.teacher_name || "")}" /></label></p>
              <p><label>状态<select name="status">
                <option value="" ${!filters.status ? "selected" : ""}>全部</option>
                ${Object.entries(statusLabels).map(([key, label]) => `<option value="${key}" ${filters.status === key ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
              </select></label></p>
              <p><label>申请时间起<input type="date" name="submitted_from" value="${escapeHtml(filters.submitted_from || "")}" /></label></p>
              <p><label>申请时间止<input type="date" name="submitted_to" value="${escapeHtml(filters.submitted_to || "")}" /></label></p>
              <div class="actions">
                <button class="secondary action-button" type="submit">筛选</button>
                <a class="button-link secondary action-button" href="${options.listPath}">重置</a>
              </div>
            </div>
          </div>
        </form>
      </section>
      <section class="card">
        <h2>${escapeHtml(options.heading)}</h2>
        <div class="table-wrap list-scroll">
          <table class="wide">
            <tr><th>ID</th><th>申请人</th><th>教学班</th><th>教授</th><th>当前状态</th><th>最新动作</th><th>日志摘要</th><th>操作</th></tr>
            ${tableRows || '<tr><td colspan="8" class="muted">暂无符合条件的申请日志。</td></tr>'}
          </table>
        </div>
      </section>
    `, user, notice));
  }
  const studentFilter = String(filters.applier_name || "").trim().toLowerCase();
  const classFilter = String(filters.class_name || "").trim().toLowerCase();
  const teacherFilter = String(filters.teacher_name || "").trim().toLowerCase();
  const statusFilter = String(filters.status || "").trim();
  const submittedFrom = String(filters.submitted_from || "").trim();
  const submittedTo = String(filters.submitted_to || "").trim();
  const db = getDb();
  const auditMap = buildApplicationAuditMap(db);
  const rows = db.prepare("select * from applications order by submitted_at desc, application_id desc").all()
    .filter((app) => !studentFilter || String(app.applier_name || "").toLowerCase().includes(studentFilter))
    .filter((app) => !classFilter || String(app.class_name || "").toLowerCase().includes(classFilter))
    .filter((app) => !teacherFilter || String(app.teacher_name || "").toLowerCase().includes(teacherFilter))
    .filter((app) => !statusFilter || String(app.status || "") === statusFilter)
    .filter((app) => !submittedFrom || normalizeDisplayDate(app.submitted_at) >= submittedFrom)
    .filter((app) => !submittedTo || normalizeDisplayDate(app.submitted_at) <= submittedTo)
    .map((app) => ({ ...app, auditRows: auditMap.get(String(app.application_id)) || [] }));
  db.close();
  const tableRows = rows.map((app) => {
    const latest = app.auditRows[0];
    return `<tr>
      <td>${app.application_id}</td>
      <td>${escapeHtml(app.applier_name)}</td>
      <td>${escapeHtml(app.class_name)}</td>
      <td>${escapeHtml(app.teacher_name)}</td>
      <td><span class="${applicationStatusPillClass(app.status)}">${escapeHtml(statusLabels[app.status] || app.status)}</span></td>
      <td>${latest ? `${renderAuditActionBadge(latest.action_type)}<div class="audit-summary-count">${escapeHtml(normalizeDisplayDateTime(latest.created_at))}</div>` : '<span class="muted">暂无</span>'}</td>
      <td>${renderApplicationAuditTimeline(app.auditRows)}</td>
      <td class="table-action-cell"><div class="table-action-inner"><a class="button-link secondary action-button" href="${options.detailBasePath}/${app.application_id}">查看详情</a></div></td>
    </tr>`;
  }).join("");
  sendHtml(res, pageLayout(options.title, `
    <section class="card">
      <h2>筛选申请日志</h2>
      <form method="get" action="${options.listPath}">
        <div class="filters-shell">
          <div class="filters-grid">
            <p><label>申请学生<input name="applier_name" value="${escapeHtml(filters.applier_name || "")}" /></label></p>
            <p><label>教学班<input name="class_name" value="${escapeHtml(filters.class_name || "")}" /></label></p>
            <p><label>教授<input name="teacher_name" value="${escapeHtml(filters.teacher_name || "")}" /></label></p>
            <p><label>状态<select name="status">
              <option value="" ${!filters.status ? "selected" : ""}>全部</option>
              ${Object.entries(statusLabels).map(([key, label]) => `<option value="${key}" ${filters.status === key ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
            </select></label></p>
            <p><label>申请时间起<input type="date" name="submitted_from" value="${escapeHtml(filters.submitted_from || "")}" /></label></p>
            <p><label>申请时间止<input type="date" name="submitted_to" value="${escapeHtml(filters.submitted_to || "")}" /></label></p>
            <div class="actions">
              <button class="secondary action-button" type="submit">筛选</button>
              <a class="button-link secondary action-button" href="${options.listPath}">重置</a>
            </div>
          </div>
        </div>
      </form>
    </section>
    <section class="card">
      <h2>${escapeHtml(options.heading)}</h2>
      <div class="table-wrap list-scroll">
        <table class="wide">
          <tr><th>ID</th><th>申请人</th><th>教学班</th><th>教授</th><th>当前状态</th><th>最新动作</th><th>日志摘要</th><th>操作</th></tr>
          ${tableRows || '<tr><td colspan="8" class="muted">暂无符合条件的申请日志。</td></tr>'}
        </table>
      </div>
    </section>
  `, user, notice));
}

async function markNotificationRead(res, user, notificationId) {
  await dbGateway.markNotificationReadById(notificationId, user.user_id);
  redirect(res, "/notifications?notice=通知已标记为已读");
}

async function toggleTaUser(res, actor, userId) {
  const result = await dbGateway.toggleTaUserApplyQualification(actor, userId);
  redirect(res, `/admin/ta/users?notice=${result.notice}`);
}

async function professorPendingPage(res, user, notice) {
  if (DB_CLIENT === "mysql") {
    const rows = await dbGateway.getProfessorPendingClassRows(user.user_id);
    const schedules = await dbGateway.getSchedulesForClassIds ? await dbGateway.getSchedulesForClassIds(rows.map((row) => row.class_id)) : [];
    const schedulesByClass = new Map();
    for (const schedule of schedules) {
      if (!schedulesByClass.has(schedule.class_id)) schedulesByClass.set(schedule.class_id, []);
      schedulesByClass.get(schedule.class_id).push(schedule);
    }
    const body = rows.length
      ? rows.map((row) => {
        const remaining = Math.max(0, Number(row.maximum_number_of_tas_admitted) - Number(row.approved_count));
        return `<section class="card">
          <h2>${escapeHtml(row.course_name)} / ${escapeHtml(row.class_name)}</h2>
          <div class="class-card-meta">
            <span>${escapeHtml(row.semester)}</span>
            <span>${escapeHtml(row.teacher_name)}</span>
            <span>待审核 ${row.pending_count}</span>
          </div>
          <p class="muted">当前共有 <strong>${row.application_count}</strong> 份申请，其中待审核 <strong>${row.pending_count}</strong> 份，已通过 <strong>${row.approved_count}</strong> / ${row.maximum_number_of_tas_admitted}，剩余名额 <strong>${remaining}</strong> 个。</p>
          <p class="muted">当你继续通过申请并达到该教学班 TA 上限时，系统会自动拒绝该教学班其余待审核申请，拒绝理由为“该课程TA已满”。</p>
          ${scheduleSummary(schedulesByClass.get(row.class_id) || [], `professor-${row.class_id}`)}
          <div class="actions" style="margin-top:12px;">
            <a class="button-link rect" href="/professor/classes/${row.class_id}">进入教学班审核</a>
          </div>
        </section>`;
      }).join("")
      : '<section class="card"><h2>待教授审批</h2><p class="muted">当前没有待教授审核的教学班。</p></section>';
    return sendHtml(res, pageLayout("待教授审批", body, user, notice));
  }
  const db = getDb();
  const rows = db.prepare(`
    select c.*,
      (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingProfessor') as pending_count,
      (select count(*) from applications a where a.class_id = c.class_id) as application_count,
      (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count
    from classes c
    where (',' || c.teacher_user_id || ',') like '%,' || ? || ',%'
      and c.published_to_professor = 'Y'
      and exists (
        select 1 from applications a
        where a.class_id = c.class_id and a.status = 'PendingProfessor'
      )
    order by c.semester, c.course_name, c.class_name
  `).all(String(user.user_id));
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
  `).all(String(user.user_id));
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
        <div class="class-card-meta">
          <span>${escapeHtml(row.semester)}</span>
          <span>${escapeHtml(row.teacher_name)}</span>
          <span>待审核 ${row.pending_count}</span>
        </div>
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

async function professorClassReviewPage(res, user, classId, notice) {
  if (DB_CLIENT === "mysql") {
    const { classRow, schedules, apps, approvedCount } = await dbGateway.getProfessorClassReviewData(user.user_id, classId);
    if (classRow && classRow.published_to_professor !== "Y") {
      return sendHtml(res, pageLayout("未找到", '<section class="card">教学班尚未发布至 Professor。</section>', user, notice), {}, 404);
    }
    if (!classRow) {
      return sendHtml(res, pageLayout("未找到", '<section class="card">教学班不存在，或你无权查看。</section>', user, notice), {}, 404);
    }
    const remaining = Math.max(0, Number(classRow.maximum_number_of_tas_admitted) - Number(approvedCount));
    const rows = apps.map((app) => `<tr>
      <td>${escapeHtml(app.applier_name)}</td>
      <td>${escapeHtml(normalizeDisplayDateTime(app.submitted_at))}</td>
      <td>${escapeHtml(statusLabels[app.status] || app.status)}</td>
      <td>${escapeHtml(app.ta_comment || "")}</td>
      <td class="table-action-cell"><div class="table-action-inner"><a class="button-link secondary action-button" href="/professor/pending/${app.application_id}">查看申请</a></div></td>
    </tr>`).join("");
    const cards = apps.map((app) => `
      <article class="mobile-data-card">
        <h3>${escapeHtml(app.applier_name)}</h3>
        <div class="mobile-meta">
          <span>${escapeHtml(statusLabels[app.status] || app.status)}</span>
          <span>${escapeHtml(normalizeDisplayDateTime(app.submitted_at))}</span>
        </div>
        <div class="mobile-data-list">
          <div class="mobile-data-row">
            <div class="mobile-data-label">TA备注</div>
            <div class="mobile-data-value">${escapeHtml(app.ta_comment || "-")}</div>
          </div>
        </div>
        <div class="actions" style="margin-top:12px;">
          <a class="button-link secondary action-button" href="/professor/pending/${app.application_id}">查看申请</a>
        </div>
      </article>
    `).join("");
    return sendHtml(res, pageLayout("教学班审核", `
      <section class="card">
        <h2>${escapeHtml(classRow.course_name)} / ${escapeHtml(classRow.class_name)}</h2>
        <div class="class-card-meta">
          <span>${escapeHtml(classRow.semester)}</span>
          <span>${escapeHtml(classRow.teacher_name)}</span>
        </div>
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
        <div class="desktop-only">
          <div class="table-wrap list-scroll">
            <table><tr><th>申请人</th><th>申请时间</th><th>状态</th><th>TAAdmin 备注</th><th>操作</th></tr>${rows}</table>
          </div>
        </div>
        <div class="mobile-only">
          ${cards ? `<div class="mobile-card-list">${cards}</div>` : `<p class="muted">当前没有申请记录。</p>`}
        </div>
      </section>
    `, user, notice));
  }
  const db = getDb();
  const classRow = db.prepare("select * from classes where class_id = ? and (',' || teacher_user_id || ',') like '%,' || ? || ',%'").get(classId, String(user.user_id));
  if (classRow && classRow.published_to_professor !== "Y") {
    db.close();
    return sendHtml(res, pageLayout("未找到", '<section class="card">教学班尚未发布至 Professor。</section>', user, notice), {}, 404);
    return;
  }
  if (!classRow) {
    db.close();
    return sendHtml(res, pageLayout("未找到", '<section class="card">教学班不存在，或你无权查看。</section>', user, notice), {}, 404);
    return;
  }
  const schedules = fetchSchedules(db, classId);
  const apps = db.prepare(`
    select *
    from applications
    where class_id = ?
      and status != 'Withdrawn'
    order by case when status = 'PendingProfessor' then 0 else 1 end, submitted_at, application_id
  `).all(classId);
  const approvedCount = db.prepare("select count(*) as count from applications where class_id = ? and status = 'Approved'").get(classId).count;
  db.close();
  const remaining = Math.max(0, Number(classRow.maximum_number_of_tas_admitted) - Number(approvedCount));
  const rows = apps.map((app) => `<tr>
    <td>${escapeHtml(app.applier_name)}</td>
    <td>${escapeHtml(normalizeDisplayDateTime(app.submitted_at))}</td>
    <td>${escapeHtml(statusLabels[app.status] || app.status)}</td>
    <td>${escapeHtml(app.ta_comment || "")}</td>
    <td class="table-action-cell"><div class="table-action-inner"><a class="button-link secondary action-button" href="/professor/pending/${app.application_id}">查看申请</a></div></td>
  </tr>`).join("");
  const cards = apps.map((app) => `
    <article class="mobile-data-card">
      <h3>${escapeHtml(app.applier_name)}</h3>
      <div class="mobile-meta">
        <span>${escapeHtml(statusLabels[app.status] || app.status)}</span>
        <span>${escapeHtml(normalizeDisplayDateTime(app.submitted_at))}</span>
      </div>
      <div class="mobile-data-list">
        <div class="mobile-data-row">
          <div class="mobile-data-label">TA备注</div>
          <div class="mobile-data-value">${escapeHtml(app.ta_comment || "-")}</div>
        </div>
      </div>
      <div class="actions" style="margin-top:12px;">
        <a class="button-link secondary action-button" href="/professor/pending/${app.application_id}">查看申请</a>
      </div>
    </article>
  `).join("");
  sendHtml(res, pageLayout("教学班审核", `
    <section class="card">
      <h2>${escapeHtml(classRow.course_name)} / ${escapeHtml(classRow.class_name)}</h2>
      <div class="class-card-meta">
        <span>${escapeHtml(classRow.semester)}</span>
        <span>${escapeHtml(classRow.teacher_name)}</span>
      </div>
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
      <div class="desktop-only">
        <div class="table-wrap list-scroll">
          <table><tr><th>申请人</th><th>申请时间</th><th>状态</th><th>TAAdmin 备注</th><th>操作</th></tr>${rows}</table>
        </div>
      </div>
      <div class="mobile-only">
        ${cards ? `<div class="mobile-card-list">${cards}</div>` : `<p class="muted">当前没有申请记录。</p>`}
      </div>
    </section>
  `, user, notice));
}

async function professorDetailPage(res, user, applicationId, notice) {
  if (DB_CLIENT === "mysql") {
    const { app, classRow, approvedCount, auditRows } = await dbGateway.getProfessorApplicationDetail(user.user_id, applicationId);
    if (!app) {
      return sendHtml(res, pageLayout("未找到", '<section class="card">申请不存在。</section>', user, notice), {}, 404);
    }
    const willAutoRejectOthers = approvedCount + (app.status === "PendingProfessor" ? 1 : 0) >= classRow.maximum_number_of_tas_admitted;
    return sendHtml(res, pageLayout("教授审批", `
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
      ${renderApplicationAuditSection(auditRows)}
    `, user, notice));
  }
  const db = getDb();
  const app = db.prepare(`
    select a.*
    from applications a
    left join classes c on c.class_id = a.class_id
    where a.application_id = ?
      and a.status != 'Withdrawn'
      and (',' || a.teacher_user_id || ',') like '%,' || ? || ',%'
      and c.published_to_professor = 'Y'
  `).get(applicationId, String(user.user_id));
  if (!app) {
    db.close();
    return sendHtml(res, pageLayout("未找到", '<section class="card">申请不存在。</section>', user, notice), {}, 404);
    return;
  }
  const classRow = db.prepare("select * from classes where class_id = ?").get(app.class_id);
  const approvedCount = db.prepare("select count(*) as count from applications where class_id = ? and status = 'Approved'").get(app.class_id).count;
  const auditRows = applicationAuditRows(db, applicationId);
  db.close();
  const willAutoRejectOthers = approvedCount + (app.status === "PendingProfessor" ? 1 : 0) >= classRow.maximum_number_of_tas_admitted;
  sendHtml(res, pageLayout("教授审批", `
    <section class="card">
      <h2>${escapeHtml(app.applier_name)} - ${escapeHtml(app.class_name)}</h2>
      <p>申请原因：${escapeHtml(app.application_reason || "-")}</p>
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
    ${renderApplicationAuditSection(auditRows)}
  `, user, notice));
}

async function professorApprove(req, res, user, applicationId) {
  const body = await readBody(req);
  const result = String(body.result || "Rejected");
  const comments = String(body.comments || "").trim();
  if (DB_CLIENT === "mysql") {
    const decision = await dbGateway.applyProfessorDecision(user, applicationId, result, comments, nowStr());
    if (!decision.ok) {
      return redirect(res, decision.redirectToDetail ? `/professor/pending/${applicationId}?notice=${decision.notice}` : `/professor/pending?notice=${decision.notice}`);
    }
    const emailJobs = [buildProfessorDecisionEmail(decision.applicant, decision.app, result, comments)]
      .concat(decision.autoRejected.map((item) => buildClassCapacityRejectedEmail(item.applicant, item.app)));
    const emailErrors = await sendEmailsAndCollectErrors(emailJobs);
    if (emailErrors.length) {
      await dbGateway.appendAuditLog({
        actor: user,
        actionType: "EMAIL_PARTIAL_FAILURE",
        targetType: "Application",
        targetId: applicationId,
        targetName: decision.app.class_name,
        details: `场景：Professor审批\n失败邮件：\n${emailErrors.join("\n")}`,
        createdAt: nowStr()
      });
    }
    return redirect(res, `/professor/pending?notice=${emailErrors.length ? "终审已完成，站内通知已发送，部分邮件发送失败" : "终审已完成，站内通知和邮件已发送"}`);
  }
  const db = getDb();
  const app = db.prepare(`
    select a.*
    from applications a
    left join classes c on c.class_id = a.class_id
    where a.application_id = ?
      and (',' || a.teacher_user_id || ',') like '%,' || ? || ',%'
      and c.published_to_professor = 'Y'
  `).get(applicationId, String(user.user_id));
  if (!app || app.status !== "PendingProfessor") {
    db.close();
    return redirect(res, "/professor/pending?notice=申请已被处理");
  }
  const applicant = db.prepare("select user_id, user_name, email from users where user_id = ?").get(app.applier_user_id);
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
  createAuditLog(db, {
    actor: user,
    actionType: result === "Approved" ? "PROFESSOR_APPROVE" : "PROFESSOR_REJECT",
    targetType: "Application",
    targetId: applicationId,
    targetName: app.class_name,
    details: `申请人：${app.applier_name}\n审批结果：${result === "Approved" ? "通过" : "拒绝"}\n新状态：${statusLabels[nextStatus] || nextStatus}${comments ? `\n备注：${comments}` : ""}`
  });
  const emailJobs = [buildProfessorDecisionEmail(applicant, app, result, comments)];
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
      const selectApplicant = db.prepare("select user_id, user_name, email from users where user_id = ?");
      for (const other of otherApps) {
        rejectStmt.run(rejectReason, nowStr(), other.application_id);
        rejectLog.run(other.application_id, user.user_id, user.user_name, rejectReason, nowStr());
        createAuditLog(db, {
          actor: user,
          actionType: "AUTO_REJECT_CAPACITY",
          targetType: "Application",
          targetId: other.application_id,
          targetName: other.class_name,
          details: `申请人：${other.applier_name}\n触发来源：${app.applier_name} 的申请通过后名额已满\n拒绝原因：${rejectReason}`
        });
        createNotification(db, other.applier_user_id, "TA 申请被拒绝", `你的申请《${other.class_name}》因课程 TA 名额已满被自动拒绝。`, `/ta/applications/${other.application_id}`);
        emailJobs.push(buildClassCapacityRejectedEmail(selectApplicant.get(other.applier_user_id), other));
      }
    }
    syncClassApplyAvailabilityByCapacity(db, app.class_id);
  } else {
    createNotification(db, app.applier_user_id, "Professor 审批未通过", `你的申请《${app.class_name}》被 Professor 拒绝。`, `/ta/applications/${applicationId}`);
  }
  db.close();
  const emailErrors = await sendEmailsAndCollectErrors(emailJobs);
  if (emailErrors.length) {
    const auditDb = getDb();
    createAuditLog(auditDb, {
      actor: user,
      actionType: "EMAIL_PARTIAL_FAILURE",
      targetType: "Application",
      targetId: applicationId,
      targetName: app.class_name,
      details: `场景：Professor审批\n失败邮件：\n${emailErrors.join("\n")}`
    });
    auditDb.close();
  }
  redirect(res, `/professor/pending?notice=${emailErrors.length ? "终审已完成，站内通知已发送，部分邮件发送失败" : "终审已完成，站内通知和邮件已发送"}`);
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

function professorMultiOptionsFromRows(rows, selectedUserIds) {
  const selected = new Set(normalizeTeacherUserIds(selectedUserIds));
  return rows.map((row) => `<option value="${row.user_id}" ${selected.has(Number(row.user_id)) ? "selected" : ""}>${escapeHtml(row.user_name)}</option>`).join("");
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

async function courseClassesPage(res, user, notice, filters = {}) {
  const statusFilter = String(filters.status_filter || "").trim();
  const sortBy = String(filters.sort_by || "class_code");
  const sortOrder = String(filters.sort_order || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  const schedulesByClass = new Map();
  const professorRows = await dbGateway.getProfessorUsers();
  const professorOptionsMarkup = professorMultiOptionsFromRows(professorRows, []);

  let rows;
  if (DB_CLIENT === "mysql") {
    rows = await dbGateway.getCourseAdminClassRows(filters);
    const classIds = rows.map((row) => Number(row.class_id)).filter(Boolean);
    const allSchedules = await dbGateway.getSchedulesForClassIds(classIds);
    for (const schedule of allSchedules) {
      if (!schedulesByClass.has(schedule.class_id)) {
        schedulesByClass.set(schedule.class_id, []);
      }
      schedulesByClass.get(schedule.class_id).push(schedule);
    }
    for (const row of rows) {
      const isFull = Number(row.approved_count || 0) >= Number(row.maximum_number_of_tas_admitted || 0);
      if (isFull && row.ta_applications_allowed !== "N") {
        row.ta_applications_allowed = "N";
      }
    }
  } else {
    const db = getDb();
    rows = loadCourseAdminClassRows(db, filters);
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
  }
  const headerFilters = {
    class_code: filters.class_code || "",
    class_name: filters.class_name || "",
    teacher_name: filters.teacher_name || "",
    ta_full: filters.ta_full || "",
    status_filter: filters.status_filter || ""
  };
  const tableRows = rows.map((row) => {
    const scheduleRows = schedulesByClass.get(row.class_id) || [];
    const isFull = Number(row.approved_count || 0) >= Number(row.maximum_number_of_tas_admitted || 0);
    const creditText = row.credit === null || row.credit === undefined || row.credit === "" ? "-" : escapeHtml(String(Number(row.credit)));
    return `<tr class="${isFull ? "row-soft-purple" : ""}">
    <td><input type="checkbox" class="class-select" value="${row.class_id}" /></td>
    <td>${escapeHtml(row.class_code)}</td>
    <td>${escapeHtml(row.class_abbr || "")}</td>
    <td>${escapeHtml(row.class_name)}</td>
    <td>${creditText}</td>
    <td class="cell-compact">${escapeHtml(row.teacher_name)}</td>
    <td>${escapeHtml(row.semester)}</td>
    <td>${classOpenStatusPill(row)}</td>
    <td>${classCapacityPill(isFull)}</td>
    <td>${scheduleSummary(scheduleRows, `course-${row.class_id}`, { showPreview: false, triggerLabel: String(scheduleRows.length) })}</td>
    <td class="cell-compact">${namePills(row.approved_ta_names || "-")}</td>
    <td>${metricPill(`${row.approved_count} / ${row.maximum_number_of_tas_admitted}`, isFull ? "gold" : "ok")}</td>
    <td>${metricPill(row.application_count, "muted")}</td>
    <td>${ynPill(row.ta_applications_allowed, "Y", "N")}</td>
    <td>${ynPill(row.is_conflict_allowed || "N", "Y", "N")}</td>
    <td class="table-action-cell">
      <div class="table-action-inner table-actions-compact">
        <a class="button-link secondary action-button" href="/course/classes/${row.class_id}">修改</a>
        <a class="button-link secondary action-button" href="/course/classes/${row.class_id}/applications">查看</a>
        <a class="button-link danger action-button" href="/course/classes/${row.class_id}/delete">删除</a>
      </div>
    </td>
  </tr>`;
  }).join("");
  const mobileCards = rows.map((row) => {
    const scheduleRows = schedulesByClass.get(row.class_id) || [];
    const isFull = Number(row.approved_count || 0) >= Number(row.maximum_number_of_tas_admitted || 0);
    return `
      <article class="mobile-data-card ${isFull ? "card-soft-purple" : ""}">
        <div class="actions" style="justify-content:space-between; align-items:center; margin-bottom:10px;">
          <label><input type="checkbox" class="class-select" value="${row.class_id}" /> 选择</label>
          ${isFull ? classCapacityPill(true) : classOpenStatusPill(row)}
        </div>
        <h3>${escapeHtml(row.class_name)}</h3>
        <div class="mobile-meta">
          <span>${escapeHtml(row.class_code)}</span>
          ${row.class_abbr ? `<span>${escapeHtml(row.class_abbr)}</span>` : ""}
          <span>${escapeHtml(row.semester)}</span>
        </div>
        <div class="mobile-data-list">
          <div class="mobile-data-row">
            <div class="mobile-data-label">教授</div>
            <div class="mobile-data-value">${escapeHtml(row.teacher_name)}</div>
          </div>
          <div class="mobile-data-row">
            <div class="mobile-data-label">学分</div>
            <div class="mobile-data-value">${row.credit === null || row.credit === undefined || row.credit === "" ? "-" : escapeHtml(String(Number(row.credit)))}</div>
          </div>
          <div class="mobile-data-row">
            <div class="mobile-data-label">已通过</div>
            <div class="mobile-data-value">${row.approved_count} / ${row.maximum_number_of_tas_admitted}</div>
          </div>
          <div class="mobile-data-row">
            <div class="mobile-data-label">申请数</div>
            <div class="mobile-data-value">${row.application_count}</div>
          </div>
          <div class="mobile-data-row">
            <div class="mobile-data-label">TA</div>
            <div class="mobile-data-value">${namePills(row.approved_ta_names || "-")}</div>
          </div>
          <div class="mobile-data-row">
            <div class="mobile-data-label">开放申请</div>
            <div class="mobile-data-value">${ynPill(row.ta_applications_allowed, "开放", "关闭")} / 允许冲突 ${ynPill(row.is_conflict_allowed || "N", "Y", "N")}</div>
          </div>
          <div class="mobile-data-row">
            <div class="mobile-data-label">排课数</div>
            <div class="mobile-data-value">${scheduleSummary(scheduleRows, `course-mobile-count-${row.class_id}`, { showPreview: false, triggerLabel: `${scheduleRows.length} 条` })}</div>
          </div>
        </div>
        <div class="actions" style="margin-top:12px;">
          <a class="button-link secondary action-button" href="/course/classes/${row.class_id}">修改</a>
          <a class="button-link secondary action-button" href="/course/classes/${row.class_id}/applications">查看</a>
          <a class="button-link danger action-button" href="/course/classes/${row.class_id}/delete">删除</a>
        </div>
      </article>
    `;
  }).join("");
  sendHtml(res, pageLayout("教学班管理", `
    <section class="card">
      <details>
        <summary style="cursor:pointer; font-weight:600; color:#174ea6;">展开导入教学班与排课</summary>
        <div style="margin-top:16px;">
          <section class="card" style="margin:0; box-shadow:none;">
            <h3>导入教学班与排课</h3>
            <form method="post" action="/course/classes/import" enctype="multipart/form-data">
              <p><label>导入文件<input name="classes_file" type="file" accept=".xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></label></p>
              <div class="actions">
                <button type="submit">导入 Excel</button>
                <a class="button-link secondary" href="/course/classes/import/template">下载模板</a>
              </div>
            </form>
            <p class="muted">当前导入格式为 Excel。同一个 class_code 可出现多行，每行代表一条排课。导入时按 class_code 覆盖教学班基础信息并重建该教学班的全部排课。排课节次可留空。</p>
            <div class="field-order">
              字段顺序：<br>
              class_code, class_abbr, course_name, class_name, teaching_language, teacher_login_name, semester, credit, maximum_number, ta_allowed, is_conflict_allowed<br>
              apply_start_at, apply_end_at, lesson_date, start_time, end_time, section, is_exam, class_intro, memo
            </div>
          </section>
        </div>
      </details>
    </section>
    <section class="card">
      <h2>筛选教学班</h2>
      <form method="get" action="/course/classes">
        <div class="filters-shell">
        <div class="filters-grid">
          <p><label>教学班代码<input name="class_code" value="${escapeHtml(filters.class_code || "")}" /></label></p>
          <p><label>教学班名称<input name="class_name" value="${escapeHtml(filters.class_name || "")}" /></label></p>
          <p><label>教授<input name="teacher_name" value="${escapeHtml(filters.teacher_name || "")}" /></label></p>
          <p><label>TA已满<select name="ta_full">
            <option value="" ${!filters.ta_full ? "selected" : ""}>全部</option>
            <option value="Y" ${filters.ta_full === "Y" ? "selected" : ""}>已满</option>
            <option value="N" ${filters.ta_full === "N" ? "selected" : ""}>未满</option>
          </select></label></p>
          <p><label>开放状态<select name="status_filter">
            <option value="" ${!statusFilter ? "selected" : ""}>全部</option>
            <option value="open" ${statusFilter === "open" ? "selected" : ""}>开放中</option>
            <option value="upcoming" ${statusFilter === "upcoming" ? "selected" : ""}>未开始</option>
            <option value="expired" ${statusFilter === "expired" ? "selected" : ""}>已过期</option>
            <option value="closed" ${statusFilter === "closed" ? "selected" : ""}>已关闭</option>
            <option value="unset" ${statusFilter === "unset" ? "selected" : ""}>未设置</option>
          </select></label></p>
          <div class="actions filters-actions-row">
            <button class="secondary action-button" type="submit">筛选</button>
            <a class="button-link secondary action-button" href="/course/classes/calendar${buildQueryString({ class_code: filters.class_code || "", class_name: filters.class_name || "", teacher_name: filters.teacher_name || "", ta_full: filters.ta_full || "", status_filter: filters.status_filter || "", sort_by: sortBy, sort_order: sortOrder })}">日历视图</a>
            <a class="button-link secondary action-button" href="/course/classes/ta-export${buildQueryString({ class_code: filters.class_code || "", class_name: filters.class_name || "", teacher_name: filters.teacher_name || "", ta_full: filters.ta_full || "", status_filter: filters.status_filter || "", sort_by: sortBy, sort_order: sortOrder })}">导出教学班TA</a>
            <a class="button-link secondary action-button" href="/course/classes">重置</a>
          </div>
        </div>
        </div>
      </form>
    </section>
    <section class="card">
      <details>
        <summary style="cursor:pointer; font-weight:600; color:#174ea6;">展开批量操作</summary>
        <div style="margin-top:16px; display:grid; gap:16px;">
          <section class="card" style="margin:0; box-shadow:none;">
            <h3>批量开关申请权限</h3>
            <form method="post" action="/course/classes/batch-toggle" onsubmit="return submitSelectedClasses(this);">
              <input type="hidden" name="class_refs" />
              <div class="grid">
                <p><label>申请权限<select name="ta_allowed"><option value="Y">开启</option><option value="N">关闭</option></select></label></p>
              </div>
              <button class="secondary action-button" type="submit">更新</button>
            </form>
            <p class="muted">基于当前勾选的教学班执行。只更新是否允许申请，不修改申请时间窗。</p>
          </section>
          <section class="card" style="margin:0; box-shadow:none;">
            <h3>批量设置开放申请时间</h3>
            <form method="post" action="/course/classes/batch-window" onsubmit="return submitSelectedClasses(this);">
              <input type="hidden" name="class_refs" />
              <div class="grid">
                <p><label>开放开始时间<input name="apply_start_at" type="datetime-local" required /></label></p>
                <p><label>开放结束时间<input name="apply_end_at" type="datetime-local" required /></label></p>
              </div>
              <button class="secondary action-button" type="submit">设置</button>
            </form>
            <p class="muted">基于当前勾选的教学班执行。</p>
          </section>
          <section class="card" style="margin:0; box-shadow:none;">
            <h3>批量删除教学班</h3>
            <form method="post" action="/course/classes/batch-delete" onsubmit="return submitSelectedClasses(this);">
              <input type="hidden" name="class_refs" />
              <button class="secondary action-button" type="submit">删除</button>
            </form>
            <p class="muted">基于当前勾选的教学班执行，会先进入确认页，再统一删除关联排课、申请、审批记录和附件。</p>
          </section>
        </div>
      </details>
    </section>
    <section class="card">
      <details>
        <summary style="cursor:pointer; font-weight:600; color:#174ea6;">展开新增教学班</summary>
        <div style="margin-top:16px;">
          <section class="card" style="margin:0; box-shadow:none;">
            <h3>新增教学班</h3>
            <form method="post" action="/course/classes/create">
              <div class="grid">
                <p><label>ClassCode<input name="class_code" required /></label></p>
                <p><label>教学班缩写<input name="class_abbr" required /></label></p>
                <p><label>课程名<input name="course_name" required /></label></p>
                <p><label>教学班名称<input name="class_name" required /></label></p>
                <p><label>授课语言<select name="teaching_language"><option value="中文">中文</option><option value="英文">英文</option></select></label></p>
                <p><label>Professor（可多选）<select class="multi-select-list" name="teacher_user_id" multiple size="10">${professorOptionsMarkup}</select></label></p>
                <p><label>学期<input name="semester" value="2026Fall" required /></label></p>
                <p><label>学分<input name="credit" type="number" step="0.1" min="0" value="0" required /></label></p>
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
              <p class="muted">一行一条排课，格式：YYYY-MM-DD,HH:MM,HH:MM[,节次][,考试类型]。节次可留空；如填写，仅支持“上午/下午/晚上”。考试类型可留空或填写“期中考试/期末考试”。</p>
              <button type="submit">创建教学班</button>
            </form>
          </section>
        </div>
      </details>
    </section>
    <section class="card">
      <h2>教学班列表</h2>
      <div class="actions" style="margin-bottom:12px;">
        <label><input type="checkbox" id="select-all-classes" /> 全选当前列表</label>
        <span class="muted">已选 <strong id="selected-class-count">0</strong> 个教学班</span>
      </div>
      <div class="desktop-only">
        <div class="table-wrap list-scroll">
          <table class="wide compact-table fixed-layout course-classes-table freeze-to-tafull">
            <colgroup>
            <col style="width:56px;" />
            <col style="width:110px;" />
            <col style="width:82px;" />
            <col style="width:168px;" />
            <col style="width:72px;" />
            <col style="width:108px;" />
            <col style="width:92px;" />
            <col style="width:88px;" />
            <col style="width:86px;" />
            <col style="width:88px;" />
            <col style="width:84px;" />
            <col style="width:98px;" />
            <col style="width:78px;" />
            <col style="width:82px;" />
            <col style="width:86px;" />
              <col style="width:236px;" />
            </colgroup>
            <tr><th>选择</th><th>${sortableHeader("教学班代码", "class_code", "/course/classes", headerFilters, sortBy, sortOrder)}</th><th>缩写</th><th>${sortableHeader("教学班名称", "class_name", "/course/classes", headerFilters, sortBy, sortOrder)}</th><th>学分</th><th>${sortableHeader("教授", "teacher_name", "/course/classes", headerFilters, sortBy, sortOrder)}</th><th>学期</th><th>${sortableHeader("开放状态", "status_filter", "/course/classes", headerFilters, sortBy, sortOrder)}</th><th>${sortableHeader("TA已满", "ta_full", "/course/classes", headerFilters, sortBy, sortOrder)}</th><th>排课数</th><th>TA</th><th>${sortableHeader("已通过/上限", "approved_count", "/course/classes", headerFilters, sortBy, sortOrder)}</th><th>${sortableHeader("申请数", "application_count", "/course/classes", headerFilters, sortBy, sortOrder)}</th><th>开放申请</th><th>允许冲突</th><th>单条操作</th></tr>${tableRows}
          </table>
        </div>
      </div>
      <div class="mobile-only">
        ${mobileCards ? `<div class="mobile-card-list">${mobileCards}</div>` : `<p class="muted">当前没有符合条件的教学班。</p>`}
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

async function taAdminAllApplicationsPage(res, user, notice, filters = {}) {
  const studentFilter = String(filters.applier_name || "").trim().toLowerCase();
  const classFilter = String(filters.class_name || "").trim().toLowerCase();
  const teacherFilter = String(filters.teacher_name || "").trim().toLowerCase();
  const statusFilter = String(filters.status || "").trim();
  const rows = (await dbGateway.getAllApplications())
    .filter((app) => !studentFilter || String(app.applier_name || "").toLowerCase().includes(studentFilter))
    .filter((app) => !classFilter || String(app.class_name || "").toLowerCase().includes(classFilter))
    .filter((app) => !teacherFilter || String(app.teacher_name || "").toLowerCase().includes(teacherFilter))
    .filter((app) => !statusFilter || String(app.status || "") === statusFilter);
  const tableRows = rows.map((app) => `<tr>
    <td>${app.application_id}</td>
    <td>${escapeHtml(app.applier_name)}</td>
    <td>${escapeHtml(app.class_name)}</td>
    <td>${escapeHtml(app.teacher_name)}</td>
    <td>${escapeHtml(normalizeDisplayDateTime(app.submitted_at))}</td>
    <td>${escapeHtml(statusLabels[app.status] || app.status)}</td>
    <td>${attachmentLink(app)}</td>
    <td class="table-action-cell"><div class="table-action-inner"><a class="button-link secondary action-button" href="/admin/ta/pending/${app.application_id}">详情</a></div></td>
  </tr>`).join("");
  sendHtml(res, pageLayout("全部申请", `
    <section class="card">
      <h2>筛选全部申请</h2>
      <form method="get" action="/admin/ta/applications">
        <div class="filters-shell">
        <div class="filters-grid">
          <p><label>申请学生<input name="applier_name" value="${escapeHtml(filters.applier_name || "")}" /></label></p>
          <p><label>教学班<input name="class_name" value="${escapeHtml(filters.class_name || "")}" /></label></p>
          <p><label>教授<input name="teacher_name" value="${escapeHtml(filters.teacher_name || "")}" /></label></p>
          <p><label>状态<select name="status">
            <option value="" ${!filters.status ? "selected" : ""}>全部</option>
            ${Object.entries(statusLabels).map(([key, label]) => `<option value="${key}" ${filters.status === key ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
          </select></label></p>
          <div class="actions">
            <button class="secondary action-button" type="submit">筛选</button>
            <a class="button-link secondary action-button" href="/admin/ta/applications">重置</a>
          </div>
        </div>
        </div>
      </form>
    </section>
    <section class="card">
      <h2>全部 TA 申请</h2>
      <div class="table-wrap list-scroll"><table><tr><th>ID</th><th>申请人</th><th>教学班</th><th>教授</th><th>申请时间</th><th>状态</th><th>简历</th><th>操作</th></tr>${tableRows}</table></div>
    </section>
  `, user, notice));
}

async function courseAdminAllApplicationsPage(res, user, notice) {
  if (DB_CLIENT === "mysql") {
    const rows = await dbGateway.getAllApplications();
    const tableRows = rows.map((app) => `<tr>
      <td>${app.application_id}</td>
      <td>${escapeHtml(app.applier_name)}</td>
      <td>${escapeHtml(app.class_name)}</td>
      <td>${escapeHtml(app.teacher_name)}</td>
      <td>${escapeHtml(normalizeDisplayDateTime(app.submitted_at))}</td>
      <td>${escapeHtml(statusLabels[app.status] || app.status)}</td>
      <td>${attachmentLink(app)}</td>
      <td class="table-action-cell"><div class="table-action-inner"><a class="button-link secondary action-button" href="/course/applications/${app.application_id}">详情</a></div></td>
    </tr>`).join("");
    return sendHtml(res, pageLayout("全部申请", `
      <section class="card">
        <h2>全部 TA 申请</h2>
        <div class="table-wrap list-scroll"><table><tr><th>ID</th><th>申请人</th><th>教学班</th><th>教授</th><th>申请时间</th><th>状态</th><th>简历</th><th>操作</th></tr>${tableRows}</table></div>
      </section>
    `, user, notice));
  }
  const db = getDb();
  const rows = db.prepare("select * from applications order by submitted_at desc").all();
  db.close();
  const tableRows = rows.map((app) => `<tr>
    <td>${app.application_id}</td>
    <td>${escapeHtml(app.applier_name)}</td>
    <td>${escapeHtml(app.class_name)}</td>
    <td>${escapeHtml(app.teacher_name)}</td>
    <td>${escapeHtml(normalizeDisplayDateTime(app.submitted_at))}</td>
    <td>${escapeHtml(statusLabels[app.status] || app.status)}</td>
    <td>${attachmentLink(app)}</td>
    <td class="table-action-cell"><div class="table-action-inner"><a class="button-link secondary action-button" href="/course/applications/${app.application_id}">详情</a></div></td>
  </tr>`).join("");
  sendHtml(res, pageLayout("全部申请", `
    <section class="card">
      <h2>全部 TA 申请</h2>
      <div class="table-wrap list-scroll"><table><tr><th>ID</th><th>申请人</th><th>教学班</th><th>教授</th><th>申请时间</th><th>状态</th><th>简历</th><th>操作</th></tr>${tableRows}</table></div>
    </section>
  `, user, notice));
}

function taAdminApplicationLogsPage(res, user, notice, filters = {}) {
  return applicationLogListPage(res, user, notice, filters, {
    title: "申请日志",
    heading: "TA 申请日志",
    listPath: "/admin/ta/application-logs",
    detailBasePath: "/admin/ta/pending"
  });
}

function courseAdminApplicationLogsPage(res, user, notice, filters = {}) {
  return applicationLogListPage(res, user, notice, filters, {
    title: "申请日志",
    heading: "TA 申请日志",
    listPath: "/course/application-logs",
    detailBasePath: "/course/applications"
  });
}

async function buildCourseReportData(filters = {}) {
  const submittedFrom = String(filters.submitted_from || "").trim();
  const submittedTo = String(filters.submitted_to || "").trim();
  const semesterFilter = String(filters.semester || "").trim();
  const teacherFilter = String(filters.teacher_name || "").trim().toLowerCase();
  const snapshot = await dbGateway.getCourseReportSnapshot(filters);
  const classes = snapshot.classes;
  const allowedClassIds = new Set(classes.map((row) => row.class_id));
  const allApplications = snapshot.applications;
  const applications = allApplications
    .filter((app) => allowedClassIds.has(app.class_id))
    .filter((app) => !submittedFrom || normalizeDisplayDate(app.submitted_at) >= submittedFrom)
    .filter((app) => !submittedTo || normalizeDisplayDate(app.submitted_at) <= submittedTo)
    .filter((app) => !teacherFilter || String(app.teacher_name || "").toLowerCase().includes(teacherFilter));
  const semesterOptions = Array.from(new Set(
    classes.map((row) => String(row.semester || "").trim()).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  const statusCounts = {
    PendingTAAdmin: 0,
    PendingProfessor: 0,
    Approved: 0,
    RejectedByTAAdmin: 0,
    RejectedByProfessor: 0,
    Withdrawn: 0
  };
  applications.forEach((app) => {
    if (Object.hasOwn(statusCounts, app.status)) {
      statusCounts[app.status] += 1;
    }
  });
  const totalApplications = applications.length;
  const totalClasses = classes.length;
  const openClasses = classes.filter((row) => classOpenStatus(row) === "open").length;
  const fullClasses = classes.filter((row) => Number(row.approved_count || 0) >= Number(row.maximum_number_of_tas_admitted || 0)).length;
  const publishedClasses = classes.filter((row) => row.published_to_professor === "Y").length;
  const pendingTaAdmin = statusCounts.PendingTAAdmin;
  const pendingProfessor = statusCounts.PendingProfessor;
  const approvedApplications = statusCounts.Approved;
  const rejectedApplications = statusCounts.RejectedByTAAdmin + statusCounts.RejectedByProfessor;
  const withdrawnApplications = statusCounts.Withdrawn;
  const uniqueApplicants = new Set(applications.map((app) => app.applier_user_id)).size;
  const approvalRate = totalApplications ? Math.round((approvedApplications / totalApplications) * 100) : 0;
  const averagePerClass = totalClasses ? (totalApplications / totalClasses).toFixed(1) : "0.0";

  const topClasses = [...classes]
    .sort((a, b) => Number(b.application_count || 0) - Number(a.application_count || 0) || String(a.class_name || "").localeCompare(String(b.class_name || "")))
    .slice(0, 8);

  const capacityTopClasses = [...classes]
    .map((row) => {
      const taLimit = Number(row.maximum_number_of_tas_admitted || 0);
      const approvedCount = Number(row.approved_count || 0);
      const usageRate = taLimit > 0 ? Math.round((approvedCount / taLimit) * 100) : 0;
      return {
        ...row,
        ta_limit: taLimit,
        approved_count_number: approvedCount,
        usage_rate: usageRate
      };
    })
    .sort((a, b) => b.usage_rate - a.usage_rate || b.approved_count_number - a.approved_count_number || String(a.class_name || "").localeCompare(String(b.class_name || "")))
    .slice(0, 8);

  const professorSummaryMap = new Map();
  classes.forEach((row) => {
    const key = String(row.teacher_name || "未设置教授");
    if (!professorSummaryMap.has(key)) {
      professorSummaryMap.set(key, { teacher_name: key, class_count: 0, application_count: 0, pending_professor_count: 0, approved_count: 0 });
    }
    const item = professorSummaryMap.get(key);
    item.class_count += 1;
    item.application_count += Number(row.application_count || 0);
    item.pending_professor_count += Number(row.pending_professor_count || 0);
    item.approved_count += Number(row.approved_count || 0);
  });
  const professorSummary = Array.from(professorSummaryMap.values())
    .sort((a, b) => b.application_count - a.application_count || b.pending_professor_count - a.pending_professor_count)
    .slice(0, 8);

  const applicantSummaryMap = new Map();
  applications.forEach((app) => {
    const key = String(app.applier_name || "未知申请人");
    if (!applicantSummaryMap.has(key)) {
      applicantSummaryMap.set(key, { applier_name: key, application_count: 0, approved_count: 0, pending_count: 0 });
    }
    const item = applicantSummaryMap.get(key);
    item.application_count += 1;
    if (app.status === "Approved") item.approved_count += 1;
    if (app.status === "PendingTAAdmin" || app.status === "PendingProfessor") item.pending_count += 1;
  });
  const applicantSummary = Array.from(applicantSummaryMap.values())
    .sort((a, b) => b.application_count - a.application_count || b.approved_count - a.approved_count)
    .slice(0, 8);

  const dayMap = new Map();
  applications.forEach((app) => {
    const day = normalizeDisplayDate(app.submitted_at);
    if (!day) return;
    dayMap.set(day, (dayMap.get(day) || 0) + 1);
  });
  const recentDays = Array.from(dayMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-7);
  const maxDayCount = Math.max(1, ...recentDays.map(([, count]) => count));

  const topClassMax = Math.max(1, ...topClasses.map((row) => Number(row.application_count || 0)));
  const capacityUsageMax = Math.max(1, ...capacityTopClasses.map((row) => Number(row.usage_rate || 0)));
  const professorMax = Math.max(1, ...professorSummary.map((row) => Number(row.application_count || 0)));
  const applicantMax = Math.max(1, ...applicantSummary.map((row) => Number(row.application_count || 0)));

  const topClassRows = topClasses.map((row) => `
    <div class="report-row">
      <div class="report-row-main">
        <div class="report-row-title"><a href="/course/classes/${row.class_id}/applications">${escapeHtml(row.class_name)}</a></div>
        <div class="report-row-meta">${escapeHtml(row.class_code)} · ${escapeHtml(row.teacher_name)} · 已通过 ${row.approved_count}/${row.maximum_number_of_tas_admitted}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(8, Math.round(Number(row.application_count || 0) / topClassMax * 100))}%"></div></div>
      </div>
      <div class="report-row-side">${row.application_count} 份申请</div>
    </div>
  `).join("");

  const professorRows = professorSummary.map((row) => `
    <div class="report-row">
      <div class="report-row-main">
        <div class="report-row-title"><a href="/course/classes?teacher_name=${encodeURIComponent(row.teacher_name)}">${escapeHtml(row.teacher_name)}</a></div>
        <div class="report-row-meta">教学班 ${row.class_count} · 待教授审批 ${row.pending_professor_count} · 已通过 ${row.approved_count}</div>
        <div class="bar-track"><div class="bar-fill gold" style="width:${Math.max(8, Math.round(Number(row.application_count || 0) / professorMax * 100))}%"></div></div>
      </div>
      <div class="report-row-side">${row.application_count} 份申请</div>
    </div>
  `).join("");

  const capacityRows = capacityTopClasses.map((row) => `
    <div class="report-row">
      <div class="report-row-main">
        <div class="report-row-title"><a href="/course/classes/${row.class_id}">${escapeHtml(row.class_name)}</a></div>
        <div class="report-row-meta">${escapeHtml(row.class_code)} · ${escapeHtml(row.teacher_name)} · 已通过 ${row.approved_count_number}/${row.ta_limit}</div>
        <div class="bar-track"><div class="bar-fill gold" style="width:${Math.max(8, Math.round(Number(row.usage_rate || 0) / capacityUsageMax * 100))}%"></div></div>
      </div>
      <div class="report-row-side">${row.usage_rate}%</div>
    </div>
  `).join("");

  const applicantRows = applicantSummary.map((row) => `
    <div class="report-row">
      <div class="report-row-main">
        <div class="report-row-title"><a href="/course/application-logs?applier_name=${encodeURIComponent(row.applier_name)}">${escapeHtml(row.applier_name)}</a></div>
        <div class="report-row-meta">申请 ${row.application_count} · 已通过 ${row.approved_count} · 待处理 ${row.pending_count}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(8, Math.round(Number(row.application_count || 0) / applicantMax * 100))}%"></div></div>
      </div>
      <div class="report-row-side">${row.application_count} 份申请</div>
    </div>
  `).join("");

  const dayRows = recentDays.map(([day, count]) => `
    <div class="report-row">
      <div class="report-row-main">
        <div class="report-row-title">${escapeHtml(day)}</div>
        <div class="bar-track"><div class="bar-fill red" style="width:${Math.max(8, Math.round(count / maxDayCount * 100))}%"></div></div>
      </div>
      <div class="report-row-side">${count} 份</div>
    </div>
  `).join("");

  return {
    submittedFrom,
    submittedTo,
    semesterFilter,
    teacherFilter,
    semesterOptions,
    applications,
    classes,
    statusCounts,
    totalApplications,
    totalClasses,
    openClasses,
    fullClasses,
    publishedClasses,
    pendingTaAdmin,
    pendingProfessor,
    approvedApplications,
    rejectedApplications,
    withdrawnApplications,
    uniqueApplicants,
    approvalRate,
    averagePerClass,
    topClasses,
    capacityTopClasses,
    professorSummary,
    applicantSummary,
    recentDays,
    topClassRows,
    capacityRows,
    professorRows,
    applicantRows,
    dayRows
  };
}

async function courseReportsExport(res, filters = {}) {
  const report = await buildCourseReportData(filters);
  const workbook = XLSX.utils.book_new();
  const filterRows = [
    { 条件: "申请时间起", 值: report.submittedFrom || "全部" },
    { 条件: "申请时间止", 值: report.submittedTo || "全部" },
    { 条件: "学期", 值: report.semesterFilter || "全部" },
    { 条件: "教授", 值: filters.teacher_name || "全部" }
  ];
  const summaryRows = [
    { 指标: "申请总数", 数值: report.totalApplications },
    { 指标: "待TAAdmin审批", 数值: report.pendingTaAdmin },
    { 指标: "待Professor审批", 数值: report.pendingProfessor },
    { 指标: "已通过申请", 数值: report.approvedApplications },
    { 指标: "已拒绝申请", 数值: report.rejectedApplications },
    { 指标: "已撤销申请", 数值: report.withdrawnApplications },
    { 指标: "教学班总数", 数值: report.totalClasses },
    { 指标: "开放中教学班", 数值: report.openClasses },
    { 指标: "TA已满教学班", 数值: report.fullClasses },
    { 指标: "已发布至Professor", 数值: report.publishedClasses },
    { 指标: "申请TA人数", 数值: report.uniqueApplicants },
    { 指标: "最终通过率", 数值: `${report.approvalRate}%` },
    { 指标: "班均申请数", 数值: report.averagePerClass }
  ];
  const classRows = report.classes.map((row) => ({
    教学班ID: row.class_id,
    教学班代码: row.class_code,
    教学班缩写: row.class_abbr || "",
    课程名称: row.course_name,
    教学班名称: row.class_name,
    教授: row.teacher_name,
    学期: row.semester,
    开放状态: classOpenStatusLabel(row),
    TA已满: Number(row.approved_count || 0) >= Number(row.maximum_number_of_tas_admitted || 0) ? "是" : "否",
    已通过人数: Number(row.approved_count || 0),
    TA上限: Number(row.maximum_number_of_tas_admitted || 0),
    申请总数: Number(row.application_count || 0),
    待TAAdmin审批: Number(row.pending_taadmin_count || 0),
    待Professor审批: Number(row.pending_professor_count || 0),
    已发布至Professor: row.published_to_professor === "Y" ? "是" : "否",
    开放申请: row.ta_applications_allowed === "Y" ? "是" : "否",
    允许冲突申请: row.is_conflict_allowed === "Y" ? "是" : "否"
  }));
  const applicationRows = report.applications.map((app) => ({
    申请ID: app.application_id,
    申请学生: app.applier_name,
    学生用户ID: app.applier_user_id,
    教学班名称: app.class_name,
    教授: app.teacher_name,
    申请时间: app.submitted_at,
    当前状态: statusLabels[app.status] || app.status,
    TAAdmin备注: app.ta_comment || "",
    Professor备注: app.prof_comment || ""
  }));
  const professorRows = report.professorSummary.map((row) => ({
    教授: row.teacher_name,
    教学班数量: row.class_count,
    申请总数: row.application_count,
    待Professor审批: row.pending_professor_count,
    已通过数量: row.approved_count
  }));
  const capacityRows = report.capacityTopClasses.map((row) => ({
    教学班代码: row.class_code,
    教学班名称: row.class_name,
    教授: row.teacher_name,
    已通过人数: row.approved_count_number,
    TA上限: row.ta_limit,
    名额使用率: `${row.usage_rate}%`
  }));
  const applicantRows = report.applicantSummary.map((row) => ({
    申请学生: row.applier_name,
    申请总数: row.application_count,
    已通过数量: row.approved_count,
    待处理数量: row.pending_count
  }));
  const trendRows = report.recentDays.map(([day, count]) => ({
    日期: day,
    申请数量: count
  }));

  const filterSheet = XLSX.utils.json_to_sheet(filterRows);
  const filterSummaryText = `当前筛选：申请时间 ${report.submittedFrom || "全部"} 至 ${report.submittedTo || "全部"}；学期 ${report.semesterFilter || "全部"}；教授 ${filters.teacher_name || "全部"}`;
  const summaryAoa = [
    ["TA选课系统报表摘要"],
    [`导出时间：${nowStr()}`],
    [filterSummaryText],
    [],
    ["筛选条件", ""],
    ["申请时间起", report.submittedFrom || "全部"],
    ["申请时间止", report.submittedTo || "全部"],
    ["学期", report.semesterFilter || "全部"],
    ["教授", filters.teacher_name || "全部"],
    [],
    ["核心指标", "", "核心指标", ""]
  ];
  for (let index = 0; index < summaryRows.length; index += 2) {
    const left = summaryRows[index];
    const right = summaryRows[index + 1];
    summaryAoa.push([
      left?.指标 || "",
      left?.数值 || "",
      right?.指标 || "",
      right?.数值 || ""
    ]);
  }
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryAoa);
  const classSheet = XLSX.utils.json_to_sheet(classRows);
  const applicationSheet = XLSX.utils.json_to_sheet(applicationRows);
  const professorSheet = XLSX.utils.json_to_sheet(professorRows);
  const capacitySheet = XLSX.utils.json_to_sheet(capacityRows);
  const applicantSheet = XLSX.utils.json_to_sheet(applicantRows);
  const trendSheet = XLSX.utils.json_to_sheet(trendRows);

  summarySheet["!cols"] = [
    { wch: 20 },
    { wch: 14 },
    { wch: 20 },
    { wch: 14 }
  ];
  summarySheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 3 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 3 } },
    { s: { r: 4, c: 0 }, e: { r: 4, c: 1 } },
    { s: { r: 10, c: 0 }, e: { r: 10, c: 1 } },
    { s: { r: 10, c: 2 }, e: { r: 10, c: 3 } }
  ];

  classSheet["!cols"] = [
    { wch: 10 },
    { wch: 18 },
    { wch: 14 },
    { wch: 18 },
    { wch: 24 },
    { wch: 20 },
    { wch: 14 },
    { wch: 12 },
    { wch: 10 },
    { wch: 12 },
    { wch: 10 },
    { wch: 10 },
    { wch: 14 },
    { wch: 16 },
    { wch: 14 },
    { wch: 12 },
    { wch: 14 }
  ];
  applicationSheet["!cols"] = [
    { wch: 10 },
    { wch: 14 },
    { wch: 12 },
    { wch: 24 },
    { wch: 20 },
    { wch: 20 },
    { wch: 16 },
    { wch: 24 },
    { wch: 24 }
  ];

  XLSX.utils.book_append_sheet(workbook, filterSheet, "筛选条件");
  XLSX.utils.book_append_sheet(workbook, summarySheet, "汇总指标");
  XLSX.utils.book_append_sheet(workbook, classSheet, "教学班报表");
  XLSX.utils.book_append_sheet(workbook, applicationSheet, "申请明细");
  XLSX.utils.book_append_sheet(workbook, professorSheet, "教授维度");
  XLSX.utils.book_append_sheet(workbook, capacitySheet, "名额使用率");
  XLSX.utils.book_append_sheet(workbook, applicantSheet, "TA活跃度");
  XLSX.utils.book_append_sheet(workbook, trendSheet, "申请趋势");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const filename = `course_reports_${nowStr().slice(0, 10)}.xlsx`;
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`
  });
  res.end(buffer);
}

async function courseReportsPage(res, user, notice, filters = {}) {
  const report = await buildCourseReportData(filters);
  const exportQuery = querystring.stringify({
    submitted_from: report.submittedFrom,
    submitted_to: report.submittedTo,
    semester: report.semesterFilter,
    teacher_name: filters.teacher_name || ""
  });
  const statusReportLink = (status) => {
    const query = querystring.stringify({
      status,
      submitted_from: report.submittedFrom,
      submitted_to: report.submittedTo,
      teacher_name: filters.teacher_name || ""
    });
    return `/course/application-logs${query ? `?${query}` : ""}`;
  };

  sendHtml(res, pageLayout("报表视图", `
    <section class="card card-brand">
      <h2>${user.role === "TAAdmin" ? "TAAdmin 报表视图" : "CourseAdmin 报表视图"}</h2>
      <p class="muted">集中查看申请、审批、教学班开放与名额使用情况。当前报表按申请提交时间统计。</p>
      <form method="get" action="/course/reports">
        <div class="filters-shell">
          <div class="filters-grid">
            <p><label>申请时间起<input type="date" name="submitted_from" value="${escapeHtml(report.submittedFrom)}" /></label></p>
            <p><label>申请时间止<input type="date" name="submitted_to" value="${escapeHtml(report.submittedTo)}" /></label></p>
            <p><label>学期<select name="semester">
              <option value="">全部学期</option>
              ${report.semesterOptions.map((item) => `<option value="${escapeHtml(item)}" ${report.semesterFilter === item ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}
            </select></label></p>
            <p><label>教授<input name="teacher_name" value="${escapeHtml(filters.teacher_name || "")}" placeholder="按教授名过滤" /></label></p>
            <div class="actions">
              <button class="secondary action-button" type="submit">更新报表</button>
              <a class="button-link secondary action-button" href="/course/reports/export${exportQuery ? `?${exportQuery}` : ""}">导出Excel</a>
              <a class="button-link secondary action-button" href="/course/reports">重置</a>
            </div>
          </div>
        </div>
      </form>
    </section>

    <section class="stats-grid">
      <article class="stat-card"><div class="stat-label">申请总数</div><div class="stat-value">${report.totalApplications}</div><div class="stat-footnote">当前筛选范围内全部 TA 申请</div></article>
      <article class="stat-card"><div class="stat-label">待 TAAdmin 审批</div><div class="stat-value">${report.pendingTaAdmin}</div><div class="stat-footnote">仍停留在初审阶段</div></article>
      <article class="stat-card"><div class="stat-label">待 Professor 审批</div><div class="stat-value">${report.pendingProfessor}</div><div class="stat-footnote">已初审通过，待终审</div></article>
      <article class="stat-card"><div class="stat-label">已通过申请</div><div class="stat-value">${report.approvedApplications}</div><div class="stat-footnote">最终通过的申请数量</div></article>
      <article class="stat-card"><div class="stat-label">已拒绝申请</div><div class="stat-value">${report.rejectedApplications}</div><div class="stat-footnote">TAAdmin 或 Professor 拒绝合计</div></article>
      <article class="stat-card"><div class="stat-label">已撤销申请</div><div class="stat-value">${report.withdrawnApplications}</div><div class="stat-footnote">学生主动撤销的申请</div></article>
      <article class="stat-card"><div class="stat-label">教学班总数</div><div class="stat-value">${report.totalClasses}</div><div class="stat-footnote">系统内全部教学班</div></article>
      <article class="stat-card"><div class="stat-label">开放中教学班</div><div class="stat-value">${report.openClasses}</div><div class="stat-footnote">当前开放且可申请</div></article>
      <article class="stat-card"><div class="stat-label">TA 已满教学班</div><div class="stat-value">${report.fullClasses}</div><div class="stat-footnote">已通过人数达到上限</div></article>
      <article class="stat-card"><div class="stat-label">已发布至 Professor</div><div class="stat-value">${report.publishedClasses}</div><div class="stat-footnote">已发送教授邮件的教学班</div></article>
      <article class="stat-card"><div class="stat-label">申请 TA 人数</div><div class="stat-value">${report.uniqueApplicants}</div><div class="stat-footnote">当前筛选范围内的唯一申请学生</div></article>
      <article class="stat-card"><div class="stat-label">最终通过率</div><div class="stat-value">${report.approvalRate}%</div><div class="stat-footnote">已通过申请占全部申请比例</div></article>
      <article class="stat-card"><div class="stat-label">班均申请数</div><div class="stat-value">${report.averagePerClass}</div><div class="stat-footnote">平均每个教学班收到的申请数量</div></article>
    </section>

    <section class="report-grid">
      <article class="report-card">
        <div class="report-kicker">热门教学班</div>
        <h3>申请量最高的教学班</h3>
        <div class="report-list">
          ${report.topClassRows || '<div class="muted">暂无数据</div>'}
        </div>
      </article>
      <article class="report-card">
        <div class="report-kicker">名额使用率</div>
        <h3>Top N 教学班</h3>
        <div class="report-list">
          ${report.capacityRows || '<div class="muted">暂无数据</div>'}
        </div>
      </article>
      <article class="report-card">
        <div class="report-kicker">教授维度</div>
        <h3>教授名下申请分布</h3>
        <div class="report-list">
          ${report.professorRows || '<div class="muted">暂无数据</div>'}
        </div>
      </article>
      <article class="report-card">
        <div class="report-kicker">TA活跃度</div>
        <h3>申请最活跃的 TA</h3>
        <div class="report-list">
          ${report.applicantRows || '<div class="muted">暂无数据</div>'}
        </div>
      </article>
    </section>

    <section class="report-grid">
      <article class="report-card">
        <div class="report-kicker">状态分布</div>
        <h3>申请状态概览</h3>
        <table>
          <tr><th>状态</th><th>数量</th></tr>
          <tr><td><a href="${statusReportLink("PendingTAAdmin")}"><span class="${applicationStatusPillClass("PendingTAAdmin")}">${escapeHtml(statusLabels.PendingTAAdmin)}</span></a></td><td>${report.statusCounts.PendingTAAdmin}</td></tr>
          <tr><td><a href="${statusReportLink("PendingProfessor")}"><span class="${applicationStatusPillClass("PendingProfessor")}">${escapeHtml(statusLabels.PendingProfessor)}</span></a></td><td>${report.statusCounts.PendingProfessor}</td></tr>
          <tr><td><a href="${statusReportLink("Approved")}"><span class="${applicationStatusPillClass("Approved")}">${escapeHtml(statusLabels.Approved)}</span></a></td><td>${report.statusCounts.Approved}</td></tr>
          <tr><td><a href="${statusReportLink("RejectedByTAAdmin")}"><span class="${applicationStatusPillClass("RejectedByTAAdmin")}">${escapeHtml(statusLabels.RejectedByTAAdmin)}</span></a></td><td>${report.statusCounts.RejectedByTAAdmin}</td></tr>
          <tr><td><a href="${statusReportLink("RejectedByProfessor")}"><span class="${applicationStatusPillClass("RejectedByProfessor")}">${escapeHtml(statusLabels.RejectedByProfessor)}</span></a></td><td>${report.statusCounts.RejectedByProfessor}</td></tr>
          <tr><td><a href="${statusReportLink("Withdrawn")}"><span class="${applicationStatusPillClass("Withdrawn")}">${escapeHtml(statusLabels.Withdrawn)}</span></a></td><td>${report.statusCounts.Withdrawn}</td></tr>
        </table>
      </article>
      <article class="report-card">
        <div class="report-kicker">近 7 个申请日</div>
        <h3>申请提交趋势</h3>
        <div class="report-list">
          ${report.dayRows || '<div class="muted">暂无数据</div>'}
        </div>
      </article>
    </section>
  `, user, notice));
}

async function courseClassTaExport(res, filters = {}) {
  let buffer;
  if (DB_CLIENT === "mysql") {
    const rows = await dbGateway.getCourseAdminClassRows(filters);
    const classIds = rows.map((row) => Number(row.class_id)).filter(Boolean);
    const approvedApps = await dbGateway.getApprovedApplicationsForClasses(classIds);
    buffer = classTaExportWorkbookBufferFromRows(rows, approvedApps);
  } else {
    const db = getDb();
    const rows = loadCourseAdminClassRows(db, filters);
    buffer = classTaExportWorkbookBuffer(db, rows);
    db.close();
  }
  const filename = `class_ta_export_${nowStr().slice(0, 10)}.xlsx`;
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`
  });
  res.end(buffer);
}

async function taAdminClassTaExport(res, filters = {}) {
  let buffer;
  if (DB_CLIENT === "mysql") {
    const rows = await dbGateway.getTaAdminClassRows(filters);
    const classIds = rows.map((row) => Number(row.class_id)).filter(Boolean);
    const approvedApps = await dbGateway.getApprovedApplicationsForClasses(classIds);
    buffer = classTaExportWorkbookBufferFromRows(rows, approvedApps);
  } else {
    const db = getDb();
    const rows = loadTaAdminClassRows(db, filters);
    buffer = classTaExportWorkbookBuffer(db, rows);
    db.close();
  }
  const filename = `class_ta_export_${nowStr().slice(0, 10)}.xlsx`;
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`
  });
  res.end(buffer);
}

async function courseAdminApplicationDetailPage(res, user, applicationId, notice) {
  if (DB_CLIENT === "mysql") {
    const [app, logs, auditRows] = await Promise.all([
      dbGateway.getApplicationById(applicationId),
      dbGateway.getApprovalLogs(applicationId),
      dbGateway.getApplicationAuditRows(applicationId)
    ]);
    if (!app) {
      return sendHtml(res, pageLayout("未找到", '<section class="card">申请不存在。</section>', user, notice), {}, 404);
    }
    const logRows = logs.map((log) => `<tr>
      <td>${escapeHtml(log.approval_stage)}</td>
      <td>${escapeHtml(log.approver_name)}</td>
      <td>${escapeHtml(log.result)}</td>
      <td>${escapeHtml(log.comments || "")}</td>
      <td>${escapeHtml(normalizeDisplayDateTime(log.acted_at))}</td>
    </tr>`).join("");
    return sendHtml(res, pageLayout("申请详情", `
      <section class="card">
        <h2>${escapeHtml(app.applier_name)} - ${escapeHtml(app.class_name)}</h2>
        <p>教授：${escapeHtml(app.teacher_name)}</p>
        <p>状态：${escapeHtml(statusLabels[app.status] || app.status)}</p>
        <p>申请时间：${escapeHtml(normalizeDisplayDateTime(app.submitted_at))}</p>
        <p>申请原因：${escapeHtml(app.application_reason || "-")}</p>
        <p>简历：${attachmentLink(app)}</p>
        <p>TAAdmin 备注：${escapeHtml(app.ta_comment || "")}</p>
        <p>Professor 备注：${escapeHtml(app.prof_comment || "")}</p>
      </section>
      <section class="card">
        <h3>审批记录</h3>
        <div class="detail-table-wrap"><table><tr><th>阶段</th><th>审批人</th><th>结果</th><th>备注</th><th>时间</th></tr>${logRows || "<tr><td colspan=\"5\">暂无审批记录</td></tr>"}</table></div>
      </section>
      ${renderApplicationAuditSection(auditRows)}
      ${adminOverrideSection(`/course/applications/${applicationId}/override-status`, app.status)}
    `, user, notice));
  }
  const db = getDb();
  const app = db.prepare("select * from applications where application_id = ?").get(applicationId);
  const logs = db.prepare(`
    select approval_stage, approver_name, result, comments, acted_at
    from approval_logs
    where application_id = ?
    order by acted_at, approval_log_id
  `).all(applicationId);
  const auditRows = applicationAuditRows(db, applicationId);
  db.close();
  if (!app) {
    return sendHtml(res, pageLayout("未找到", '<section class="card">申请不存在。</section>', user, notice), {}, 404);
    return;
  }
  const logRows = logs.map((log) => `<tr>
    <td>${escapeHtml(log.approval_stage)}</td>
    <td>${escapeHtml(log.approver_name)}</td>
    <td>${escapeHtml(log.result)}</td>
    <td>${escapeHtml(log.comments || "")}</td>
    <td>${escapeHtml(normalizeDisplayDateTime(log.acted_at))}</td>
  </tr>`).join("");
  sendHtml(res, pageLayout("申请详情", `
    <section class="card">
      <h2>${escapeHtml(app.applier_name)} - ${escapeHtml(app.class_name)}</h2>
      <p>教授：${escapeHtml(app.teacher_name)}</p>
      <p>状态：${escapeHtml(statusLabels[app.status] || app.status)}</p>
      <p>申请时间：${escapeHtml(normalizeDisplayDateTime(app.submitted_at))}</p>
      <p>申请原因：${escapeHtml(app.application_reason || "-")}</p>
      <p>简历：${attachmentLink(app)}</p>
      <p>TAAdmin 备注：${escapeHtml(app.ta_comment || "")}</p>
      <p>Professor 备注：${escapeHtml(app.prof_comment || "")}</p>
    </section>
    <section class="card">
      <h3>审批记录</h3>
      <div class="detail-table-wrap"><table><tr><th>阶段</th><th>审批人</th><th>结果</th><th>备注</th><th>时间</th></tr>${logRows || "<tr><td colspan=\"5\">暂无审批记录</td></tr>"}</table></div>
    </section>
    ${renderApplicationAuditSection(auditRows)}
    ${adminOverrideSection(`/course/applications/${applicationId}/override-status`, app.status)}
  `, user, notice));
}

function classesImportResultPage(res, user, reportId, notice) {
  const report = importReports.get(reportId);
  if (!report) {
    return sendHtml(res, pageLayout("未找到", '<section class="card">导入结果不存在或已过期。</section>', user, notice), {}, 404);
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
    return sendHtml(res, pageLayout("未找到", '<section class="card">导入结果不存在或已过期。</section>', user, notice), {}, 404);
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

async function taAdminAllClassesPage(res, user, notice, filters = {}) {
  let rows;
  let schedulesByClass = new Map();
  if (DB_CLIENT === "mysql") {
    rows = await dbGateway.getTaAdminClassRows(filters);
    const classIds = rows.map((row) => Number(row.class_id)).filter(Boolean);
    const allSchedules = await dbGateway.getSchedulesForClassIds(classIds);
    for (const schedule of allSchedules) {
      if (!schedulesByClass.has(schedule.class_id)) {
        schedulesByClass.set(schedule.class_id, []);
      }
      schedulesByClass.get(schedule.class_id).push(schedule);
    }
  } else {
    const db = getDb();
    const rowsRaw = loadTaAdminClassRows(db, filters);
    for (const row of rowsRaw) {
      if (row.published_to_professor === "Y") {
        db.prepare("update classes set ta_applications_allowed = 'N' where class_id = ?").run(row.class_id);
        row.ta_applications_allowed = "N";
      }
      if (isClassCapacityReached(row, row.approved_count) && row.ta_applications_allowed !== "N") {
        db.prepare("update classes set ta_applications_allowed = 'N' where class_id = ?").run(row.class_id);
        row.ta_applications_allowed = "N";
      }
    }
    const professors = db.prepare("select user_id, email from users where role = 'Professor'").all();
    const professorEmailMap = new Map(professors.map((row) => [row.user_id, row.email]));
    rows = rowsRaw.map((row) => ({
      ...row,
      professor_emails: normalizeTeacherUserIds(row.teacher_user_id).map((id) => professorEmailMap.get(id)).filter(Boolean).join(",")
    }));
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
  }
  const tableRows = rows.map((row) => {
    const scheduleRows = schedulesByClass.get(row.class_id) || [];
    const isFull = isClassCapacityReached(row, row.approved_count);
    return `<tr class="${isFull ? "row-soft-purple" : ""}">
      <td><input type="checkbox" class="ta-class-select" value="${row.class_id}" /></td>
      <td>${escapeHtml(row.class_code)}</td>
      <td>${escapeHtml(row.class_abbr || "")}</td>
      <td>${escapeHtml(row.class_name)}</td>
      <td>${escapeHtml(row.teacher_name)}</td>
      <td>${escapeHtml(row.semester)}</td>
      <td>${classOpenStatusPill(row)}</td>
      <td>${classCapacityPill(isFull)}</td>
      <td>${scheduleSummary(scheduleRows, `taadmin-count-${row.class_id}`, { showPreview: false, triggerLabel: String(scheduleRows.length) })}</td>
      <td>${namePills(row.approved_ta_names || "-")}</td>
      <td>${metricPill(`${row.approved_count} / ${row.maximum_number_of_tas_admitted}`, isFull ? "gold" : "ok")}</td>
      <td>${metricPill(row.application_count, "muted")}</td>
      <td>${metricPill(row.pending_taadmin_count, Number(row.pending_taadmin_count || 0) > 0 ? "gold" : "muted")}</td>
      <td>${ynPill(row.published_to_professor, "已发送", "否")}</td>
      <td>${ynPill(row.ta_applications_allowed, "Y", "N")}</td>
      <td>${ynPill(row.is_conflict_allowed || "N", "Y", "N")}</td>
      <td class="table-action-cell"><div class="table-action-inner table-actions-compact"><a class="button-link tertiary rect action-button" href="/admin/ta/classes/${row.class_id}">修改</a><a class="button-link secondary rect action-button" href="/admin/ta/classes/${row.class_id}/applications">审核</a></div></td>
    </tr>`;
  }).join("");
  const mobileCards = rows.map((row) => {
    const scheduleRows = schedulesByClass.get(row.class_id) || [];
    const isFull = isClassCapacityReached(row, row.approved_count);
    return `
      <article class="mobile-data-card ${isFull ? "card-soft-purple" : ""}">
        <div class="actions" style="justify-content:space-between; align-items:center; margin-bottom:10px;">
          <label><input type="checkbox" class="ta-class-select" value="${row.class_id}" /> 选择</label>
          ${ynPill(row.published_to_professor, "已发送", "未发送")}
        </div>
        <h3>${escapeHtml(row.class_name)}</h3>
        <div class="mobile-meta">
          <span>${escapeHtml(row.teacher_name)}</span>
          <span>${escapeHtml(row.semester)}</span>
          <span>${isFull ? "TA已满" : "未满"}</span>
        </div>
        <div class="mobile-data-list">
          <div class="mobile-data-row">
            <div class="mobile-data-label">教学班代码</div>
            <div class="mobile-data-value">${escapeHtml(row.class_code)}${row.class_abbr ? ` / ${escapeHtml(row.class_abbr)}` : ""}</div>
          </div>
          <div class="mobile-data-row">
            <div class="mobile-data-label">开放状态</div>
            <div class="mobile-data-value">${classOpenStatusPill(row)}</div>
          </div>
          <div class="mobile-data-row">
            <div class="mobile-data-label">已通过/上限</div>
            <div class="mobile-data-value">${row.approved_count} / ${row.maximum_number_of_tas_admitted}</div>
          </div>
          <div class="mobile-data-row">
            <div class="mobile-data-label">申请情况</div>
            <div class="mobile-data-value">总申请 ${row.application_count}，待TAAdmin ${row.pending_taadmin_count}</div>
          </div>
          <div class="mobile-data-row">
            <div class="mobile-data-label">TA</div>
            <div class="mobile-data-value">${namePills(row.approved_ta_names || "-")}</div>
          </div>
          <div class="mobile-data-row">
            <div class="mobile-data-label">发布至教授</div>
            <div class="mobile-data-value">${ynPill(row.published_to_professor, "已发送", "否")}</div>
          </div>
          <div class="mobile-data-row">
            <div class="mobile-data-label">开放申请</div>
            <div class="mobile-data-value">${ynPill(row.ta_applications_allowed, "开放", "关闭")} / 允许冲突 ${ynPill(row.is_conflict_allowed || "N", "Y", "N")}</div>
          </div>
          <div class="mobile-data-row">
            <div class="mobile-data-label">排课安排</div>
            <div class="mobile-data-value">${scheduleSummary(scheduleRows, `taadmin-mobile-count-${row.class_id}`, { showPreview: false, triggerLabel: `${scheduleRows.length} 条` })}</div>
          </div>
        </div>
        <div class="actions" style="margin-top:12px;">
          <a class="button-link tertiary rect action-button" href="/admin/ta/classes/${row.class_id}">修改</a>
          <a class="button-link secondary rect action-button" href="/admin/ta/classes/${row.class_id}/applications">审核</a>
        </div>
      </article>
    `;
  }).join("");
  const filterQuery = buildQueryString({
    professor_name: filters.professor_name || "",
    class_name: filters.class_name || "",
    semester: filters.semester || "",
    ta_full: filters.ta_full || "",
    has_pending: filters.has_pending || "",
    published_to_professor: filters.published_to_professor || "",
    ta_applications_allowed: filters.ta_applications_allowed || "",
    is_conflict_allowed: filters.is_conflict_allowed || ""
  });
  sendHtml(res, pageLayout("全部教学班", `
    <section class="card">
      <h2>筛选教学班</h2>
      <form method="get" action="/admin/ta/classes">
        <div class="filters-shell">
        <div class="filters-grid">
          <p><label>教授名<input name="professor_name" value="${escapeHtml(filters.professor_name || "")}" /></label></p>
          <p><label>教学班名称<input name="class_name" value="${escapeHtml(filters.class_name || "")}" /></label></p>
          <p><label>学期<input name="semester" value="${escapeHtml(filters.semester || "")}" /></label></p>
          <p><label>TA 已满<select name="ta_full">
            <option value="" ${!filters.ta_full ? "selected" : ""}>全部</option>
            <option value="Y" ${filters.ta_full === "Y" ? "selected" : ""}>已满</option>
            <option value="N" ${filters.ta_full === "N" ? "selected" : ""}>未满</option>
          </select></label></p>
          <p><label>有待TAAdmin申请<select name="has_pending">
            <option value="" ${!filters.has_pending ? "selected" : ""}>全部</option>
            <option value="Y" ${filters.has_pending === "Y" ? "selected" : ""}>有</option>
            <option value="N" ${filters.has_pending === "N" ? "selected" : ""}>无</option>
          </select></label></p>
          <p><label>发送至教授<select name="published_to_professor">
            <option value="" ${!filters.published_to_professor ? "selected" : ""}>全部</option>
            <option value="Y" ${filters.published_to_professor === "Y" ? "selected" : ""}>已发送</option>
            <option value="N" ${filters.published_to_professor === "N" ? "selected" : ""}>未发送</option>
          </select></label></p>
          <p><label>开放申请<select name="ta_applications_allowed">
            <option value="" ${!filters.ta_applications_allowed ? "selected" : ""}>全部</option>
            <option value="Y" ${filters.ta_applications_allowed === "Y" ? "selected" : ""}>Y</option>
            <option value="N" ${filters.ta_applications_allowed === "N" ? "selected" : ""}>N</option>
          </select></label></p>
          <p><label>允许冲突<select name="is_conflict_allowed">
            <option value="" ${!filters.is_conflict_allowed ? "selected" : ""}>全部</option>
            <option value="Y" ${filters.is_conflict_allowed === "Y" ? "selected" : ""}>Y</option>
            <option value="N" ${filters.is_conflict_allowed === "N" ? "selected" : ""}>N</option>
          </select></label></p>
        </div>
        <div class="actions filters-actions-row" style="margin-top:12px;">
          <button class="secondary action-button" type="submit">筛选</button>
          <a class="button-link secondary rect action-button" href="/admin/ta/classes/calendar${filterQuery}">日历视图</a>
          <a class="button-link secondary rect action-button" href="/admin/ta/classes/ta-export${filterQuery}">导出教学班TA</a>
          <a class="button-link secondary rect action-button" href="/admin/ta/classes">重置</a>
        </div>
        </div>
      </form>
    </section>
    <details class="card">
      <summary style="cursor:pointer; font-weight:600; color:#174ea6;">展开教学班设置</summary>
      <form method="post" action="/admin/ta/classes/batch-window" onsubmit="return submitSelectedTaClasses(this);">
        <input type="hidden" name="class_refs" />
        <div class="filters-grid settings-inline">
          <p><label>开放开始时间<input type="datetime-local" name="apply_start_at" /></label></p>
          <p><label>开放结束时间<input type="datetime-local" name="apply_end_at" /></label></p>
          <div class="actions"><button class="secondary rect action-button" type="submit">批量设置开放时间</button></div>
        </div>
      </form>
      <form method="post" action="/admin/ta/classes/batch-settings" onsubmit="return submitSelectedTaClasses(this);" style="margin-top:16px;">
        <input type="hidden" name="class_refs" />
        <div class="filters-grid settings-inline">
          <p><label>开放申请
            <select name="ta_allowed">
              <option value="Y">Y</option>
              <option value="N">N</option>
            </select>
          </label></p>
          <p><label>允许冲突
            <select name="is_conflict_allowed">
              <option value="N">N</option>
              <option value="Y">Y</option>
            </select>
          </label></p>
          <div class="actions"><button class="secondary rect action-button" type="submit">批量更新开放设置</button></div>
        </div>
      </form>
    </details>
    <details class="card">
      <summary style="cursor:pointer; font-weight:600; color:#174ea6;">展开发布至教授</summary>
      <form method="post" action="/admin/ta/classes/email-preview" onsubmit="return submitSelectedTaClasses(this);">
        <input type="hidden" name="class_refs" />
        <p class="muted">勾选一个或多个教学班后，先生成发给 Professor 的邮件预览。检查无误后，可在预览页点击“发送邮件”。系统会按教授分别发送，并 CC 当前 TAAdmin。</p>
        <div class="actions">
          <button type="submit">生成邮件预览</button>
        </div>
      </form>
      <form method="post" action="/admin/ta/classes/batch-publish" onsubmit="return submitSelectedTaClasses(this);" style="margin-top:16px;">
        <input type="hidden" name="class_refs" />
        <div class="grid">
          <p><label>发布至教授
            <select name="published_to_professor">
              <option value="Y">已发送</option>
              <option value="N">未通知</option>
            </select>
          </label></p>
        </div>
        <div class="actions">
          <button class="secondary rect" type="submit">批量修改发布状态</button>
        </div>
      </form>
    </details>
    <section class="card">
      <h2>全部教学班与排课安排</h2>
      <div class="actions" style="margin-bottom:12px;">
        <label><input type="checkbox" id="select-all-ta-classes" /> 全选当前列表</label>
        <span class="muted">已选 <strong id="selected-ta-class-count">0</strong> 个教学班</span>
      </div>
      <div class="desktop-only">
        <div class="table-wrap list-scroll">
          <table class="wide compact-table fixed-layout taadmin-classes-table freeze-to-tafull">
            <colgroup>
              <col style="width:56px;" />
              <col style="width:106px;" />
              <col style="width:80px;" />
              <col style="width:160px;" />
              <col style="width:118px;" />
              <col style="width:88px;" />
              <col style="width:86px;" />
              <col style="width:74px;" />
              <col style="width:84px;" />
              <col style="width:112px;" />
              <col style="width:96px;" />
              <col style="width:76px;" />
              <col style="width:104px;" />
              <col style="width:110px;" />
              <col style="width:82px;" />
              <col style="width:86px;" />
              <col style="width:146px;" />
            </colgroup>
            <tr><th>选择</th><th>代码</th><th>缩写</th><th>教学班</th><th>教授</th><th>学期</th><th>开放状态</th><th>TA已满</th><th>排课数</th><th>TA</th><th>已通过/上限</th><th>申请数</th><th>待TAAdmin审批</th><th>发布至教授</th><th>开放申请</th><th>允许冲突</th><th>操作</th></tr>${tableRows}
          </table>
        </div>
      </div>
      <div class="mobile-only">
        ${mobileCards ? `<div class="mobile-card-list">${mobileCards}</div>` : `<p class="muted">当前没有符合条件的教学班。</p>`}
      </div>
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
  if (DB_CLIENT === "mysql") {
    const selectedClasses = await dbGateway.getClassRowsByRefs(refs);
    if (!selectedClasses.length) {
      return redirect(res, "/admin/ta/classes?notice=未匹配到任何教学班");
    }
    const classRows = selectedClasses.map((row) => `<tr><td>${escapeHtml(row.class_code)}</td><td>${escapeHtml(row.course_name)}</td><td>${escapeHtml(row.class_name)}</td><td>${escapeHtml(row.teacher_name)}</td></tr>`).join("");
    const professorRows = await dbGateway.getProfessorUsers();
    const professorMap = new Map(professorRows.map((row) => [Number(row.user_id), row]));
    const grouped = new Map();
    for (const classRow of selectedClasses) {
      for (const professorId of normalizeTeacherUserIds(classRow.teacher_user_id)) {
        const professor = professorMap.get(professorId);
        if (!professor || !professor.email) continue;
        if (!grouped.has(professor.user_id)) {
          grouped.set(professor.user_id, { professor, classes: [] });
        }
        grouped.get(professor.user_id).classes.push(classRow);
      }
    }
    const baseUrl = getExternalBaseUrl(req);
    const draftCards = [];
    for (const { professor, classes } of grouped.values()) {
      const token = await dbGateway.createLoginTokenRecord(professor.user_id, "/professor/pending");
      const accessLink = `${baseUrl}/magic-login?token=${token}`;
      const emailDraft = buildProfessorEmailDraft(professor, classes, accessLink);
      draftCards.push(`
        <section class="card">
          <h3>${escapeHtml(professor.user_name)}</h3>
          <p>收件人：${escapeHtml(emailDraft.to)}</p>
          <p>抄送：${escapeHtml(user.email || "未设置")}</p>
          <p>主题：${escapeHtml(emailDraft.subject)}</p>
          <pre style="white-space:pre-wrap;">${escapeHtml(emailDraft.text)}</pre>
        </section>
      `);
    }
    return sendHtml(res, pageLayout("邮件预览", `
      <section class="card">
        <h2>Professor 邮件预览</h2>
        <p class="muted">系统会按教授分别生成专属邮件和免登录审核链接，并 CC 当前 TAAdmin。请勿转发邮件内容和链接。</p>
        <form method="post" action="/admin/ta/classes/send-email">
          <input type="hidden" name="class_refs" value="${escapeHtml(selectedClasses.map((row) => row.class_id).join(","))}" />
          <div class="actions">
            <button type="submit">发送邮件</button>
            <a class="button-link secondary" href="/admin/ta/classes">返回全部教学班</a>
          </div>
        </form>
      </section>
      ${draftCards.join("") || `<section class="card"><p class="muted">所选教学班未匹配到可用的 Professor 邮箱。</p></section>`}
      <section class="card">
        <h3>本次邮件包含的教学班</h3>
        <table><tr><th>代码</th><th>课程名</th><th>教学班</th><th>教授</th></tr>${classRows}</table>
      </section>
    `, user, notice));
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
  const baseUrl = getExternalBaseUrl(req);
  const draftCards = Array.from(grouped.values()).map(({ professor, classes }) => {
    const token = createLoginToken(db, professor.user_id, "/professor/pending");
    const accessLink = `${baseUrl}/magic-login?token=${token}`;
    const emailDraft = buildProfessorEmailDraft(professor, classes, accessLink);
    return `
      <section class="card">
        <h3>${escapeHtml(professor.user_name)}</h3>
        <p>收件人：${escapeHtml(emailDraft.to)}</p>
        <p>抄送：${escapeHtml(user.email || "未设置")}</p>
        <p>主题：${escapeHtml(emailDraft.subject)}</p>
        <pre style="white-space:pre-wrap;">${escapeHtml(emailDraft.text)}</pre>
      </section>
    `;
  }).join("");
  db.close();
  sendHtml(res, pageLayout("邮件预览", `
    <section class="card">
      <h2>Professor 邮件预览</h2>
      <p class="muted">系统会按教授分别生成专属邮件和免登录审核链接，并 CC 当前 TAAdmin。请勿转发邮件内容和链接。</p>
      <form method="post" action="/admin/ta/classes/send-email">
        <input type="hidden" name="class_refs" value="${escapeHtml(selectedClasses.map((row) => row.class_id).join(","))}" />
        <div class="actions">
          <button type="submit">发送邮件</button>
          <a class="button-link secondary" href="/admin/ta/classes">返回全部教学班</a>
        </div>
      </form>
    </section>
    ${draftCards || `<section class="card"><p class="muted">所选教学班未匹配到可用的 Professor 邮箱。</p></section>`}
    <section class="card">
      <h3>本次邮件包含的教学班</h3>
      <table><tr><th>代码</th><th>课程名</th><th>教学班</th><th>教授</th></tr>${classRows}</table>
    </section>
  `, user, notice));
}

async function taAdminSendProfessorEmails(req, res, user) {
  const body = await readBody(req);
  const refs = parseBatchClassRefs(body.class_refs);
  if (!refs.length) {
    return redirect(res, "/admin/ta/classes?notice=请先勾选至少一个教学班");
  }
  if (DB_CLIENT === "mysql") {
    const selectedClasses = await dbGateway.getClassRowsByRefs(refs);
    if (!selectedClasses.length) {
      return redirect(res, "/admin/ta/classes?notice=未匹配到任何教学班");
    }
    const professorRows = await dbGateway.getProfessorUsers();
    const professorMap = new Map(professorRows.map((row) => [Number(row.user_id), row]));
    const grouped = new Map();
    for (const classRow of selectedClasses) {
      for (const professorId of normalizeTeacherUserIds(classRow.teacher_user_id)) {
        const professor = professorMap.get(professorId);
        if (!professor || !professor.email) continue;
        if (!grouped.has(professor.user_id)) {
          grouped.set(professor.user_id, { professor, classes: [] });
        }
        grouped.get(professor.user_id).classes.push(classRow);
      }
    }
    if (!grouped.size) {
      return redirect(res, "/admin/ta/classes?notice=所选教学班未匹配到可用的 Professor 邮箱");
    }
    const transporter = createMailer();
    const fromAddress = String(process.env.SMTP_FROM || process.env.SMTP_USER || "").trim();
    if (!fromAddress && String(process.env.SMTP_HOST || "").trim()) {
      return redirect(res, "/admin/ta/classes?notice=已配置 SMTP，但缺少 SMTP_FROM 发件人地址");
    }
    const baseUrl = getExternalBaseUrl(req);
    const professorSummaries = [];
    try {
      for (const { professor, classes } of grouped.values()) {
        const token = await dbGateway.createLoginTokenRecord(professor.user_id, "/professor/pending");
        const accessLink = `${baseUrl}/magic-login?token=${token}`;
        const emailDraft = buildProfessorEmailDraft(professor, classes, accessLink);
        const message = {
          to: emailDraft.to,
          subject: emailDraft.subject,
          text: emailDraft.text,
          html: emailDraft.html
        };
        if (fromAddress) message.from = fromAddress;
        if (user?.email) message.cc = user.email;
        await transporter.sendMail(message);
        professorSummaries.push({
          user_id: professor.user_id,
          classSummary: classes.map((row) => row.class_name).filter(Boolean).join("、")
        });
      }
      await dbGateway.markClassesPublishedToProfessor(user, selectedClasses, professorSummaries, nowStr());
    } catch (error) {
      await dbGateway.appendAuditLog({
        actor: user,
        actionType: "PROFESSOR_EMAIL_SEND_FAILED",
        targetType: "Class",
        targetId: selectedClasses.map((row) => row.class_id).join(","),
        targetName: "发布至Professor失败",
        details: `教学班数：${selectedClasses.length}\n失败原因：${error.message}`,
        createdAt: nowStr()
      });
      return redirect(res, `/admin/ta/classes?notice=${error.message}`);
    }
    return redirect(res, "/admin/ta/classes?notice=邮件已发送，教学班已发布至 Professor");
  }
  const db = getDb();
  const selectedClasses = loadClassRowsByRefs(db, refs);
  if (!selectedClasses.length) {
    db.close();
    return redirect(res, "/admin/ta/classes?notice=未匹配到任何教学班");
  }
  const baseUrl = getExternalBaseUrl(req);
  try {
    await sendProfessorNotificationEmails(db, selectedClasses, user, baseUrl);
  } catch (error) {
    createAuditLog(db, {
      actor: user,
      actionType: "PROFESSOR_EMAIL_SEND_FAILED",
      targetType: "Class",
      targetId: selectedClasses.map((row) => row.class_id).join(","),
      targetName: "发布至Professor失败",
      details: `教学班数：${selectedClasses.length}\n失败原因：${error.message}`
    });
    db.close();
    return redirect(res, `/admin/ta/classes?notice=${error.message}`);
  }
  db.close();
  redirect(res, "/admin/ta/classes?notice=邮件已发送，教学班已发布至 Professor");
}

async function batchUpdateProfessorPublishStatus(req, res, user) {
  const body = await readBody(req);
  const refs = parseBatchClassRefs(body.class_refs);
  const nextValue = String(body.published_to_professor || "N").trim() === "Y" ? "Y" : "N";
  if (!refs.length) {
    return redirect(res, "/admin/ta/classes?notice=请先勾选至少一个教学班");
  }
  if (DB_CLIENT === "mysql") {
    const selectedClasses = await dbGateway.getClassRowsByRefs(refs);
    if (!selectedClasses.length) {
      return redirect(res, "/admin/ta/classes?notice=未匹配到任何教学班");
    }
    await dbGateway.updateProfessorPublishStatus(user, selectedClasses, nextValue, nowStr());
    return redirect(res, `/admin/ta/classes?notice=已批量更新 ${selectedClasses.length} 个教学班的发布状态`);
  }
  const db = getDb();
  const selectedClasses = loadClassRowsByRefs(db, refs);
  if (!selectedClasses.length) {
    db.close();
    return redirect(res, "/admin/ta/classes?notice=未匹配到任何教学班");
  }
  const updateStmt = db.prepare("update classes set published_to_professor = ?, professor_notified_at = ?, ta_applications_allowed = case when ? = 'Y' then 'N' else ta_applications_allowed end where class_id = ?");
  for (const row of selectedClasses) {
    updateStmt.run(nextValue, nextValue === "Y" ? nowStr() : null, nextValue, row.class_id);
    createAuditLog(db, {
      actor: user,
      actionType: "CLASS_PUBLISH_STATUS_UPDATE",
      targetType: "Class",
      targetId: row.class_id,
      targetName: `${row.course_name} / ${row.class_name}`,
      details: `教学班代码：${row.class_code}\n新发布状态：${nextValue === "Y" ? "已发送" : "未发送"}`
    });
  }
  db.close();
  redirect(res, `/admin/ta/classes?notice=已批量更新 ${selectedClasses.length} 个教学班的发布状态`);
}

async function taAdminBatchUpdateClassWindow(req, res, user) {
  const body = await readBody(req);
  const refs = parseBatchClassRefs(body.class_refs);
  let applyStartAt;
  let applyEndAt;
  try {
    applyStartAt = normalizeDateTimeInput(body.apply_start_at);
    applyEndAt = normalizeDateTimeInput(body.apply_end_at);
    validateApplyWindow(applyStartAt, applyEndAt);
  } catch (error) {
    return redirect(res, `/admin/ta/classes?notice=${error.message}`);
  }
  if (!refs.length) {
    return redirect(res, "/admin/ta/classes?notice=请先勾选至少一个教学班");
  }
  if (DB_CLIENT === "mysql") {
    const result = await dbGateway.batchUpdateCourseClassWindow(user, refs, applyStartAt, applyEndAt);
    if (result.changed === 0) {
      return redirect(res, "/admin/ta/classes?notice=未匹配到任何教学班");
    }
    return redirect(res, `/admin/ta/classes?notice=已批量更新 ${result.changed} 个教学班的开放申请时间`);
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
  const changedRows = loadClassRowsByRefs(db, refs);
  for (const row of changedRows) {
    createAuditLog(db, {
      actor: user,
      actionType: "CLASS_APPLY_WINDOW_UPDATE",
      targetType: "Class",
      targetId: row.class_id,
      targetName: `${row.course_name} / ${row.class_name}`,
      details: `教学班代码：${row.class_code}\n开放开始：${applyStartAt}\n开放结束：${applyEndAt}`
    });
  }
  db.close();
  if (changed === 0) {
    return redirect(res, "/admin/ta/classes?notice=未匹配到任何教学班");
  }
  redirect(res, `/admin/ta/classes?notice=已批量更新 ${changed} 个教学班的开放申请时间`);
}

async function taAdminBatchUpdateClassSettings(req, res, user) {
  const body = await readBody(req);
  const refs = parseBatchClassRefs(body.class_refs);
  const taAllowed = String(body.ta_allowed || "Y");
  const isConflictAllowed = String(body.is_conflict_allowed || "N");
  if (!["Y", "N"].includes(taAllowed) || !["Y", "N"].includes(isConflictAllowed)) {
    return redirect(res, "/admin/ta/classes?notice=开放设置取值不合法");
  }
  if (!refs.length) {
    return redirect(res, "/admin/ta/classes?notice=请先勾选至少一个教学班");
  }
  if (DB_CLIENT === "mysql") {
    const selectedClasses = await dbGateway.getClassRowsByRefs(refs);
    if (!selectedClasses.length) {
      return redirect(res, "/admin/ta/classes?notice=未匹配到任何教学班");
    }
    if (taAllowed === "Y" && selectedClasses.some((row) => row.published_to_professor === "Y")) {
      return redirect(res, "/admin/ta/classes?notice=已发送至教授的教学班不能重新开放申请，请先将发布状态改为未发送");
    }
    const toggleResult = await dbGateway.batchToggleCourseClassApply(user, refs, taAllowed);
    const conflictResult = await dbGateway.batchUpdateCourseClassConflict(user, refs, isConflictAllowed);
    return redirect(res, `/admin/ta/classes?notice=已批量更新 ${Math.max(toggleResult.changed, conflictResult.changed)} 个教学班的开放设置`);
  }
  const db = getDb();
  const selectedClasses = loadClassRowsByRefs(db, refs);
  if (!selectedClasses.length) {
    db.close();
    return redirect(res, "/admin/ta/classes?notice=未匹配到任何教学班");
  }
  if (taAllowed === "Y" && selectedClasses.some((row) => row.published_to_professor === "Y")) {
    db.close();
    return redirect(res, "/admin/ta/classes?notice=已发送至教授的教学班不能重新开放申请，请先将发布状态改为未发送");
  }
  const updateStmt = db.prepare(`
    update classes
    set ta_applications_allowed = ?, is_conflict_allowed = ?
    where class_id = ? or class_code = ?
  `);
  let changed = 0;
  for (const ref of refs) {
    const id = Number(ref);
    const result = updateStmt.run(taAllowed, isConflictAllowed, Number.isInteger(id) && id > 0 ? id : -1, ref);
    changed += result.changes;
  }
  for (const row of selectedClasses) {
    createAuditLog(db, {
      actor: user,
      actionType: "CLASS_APPLY_TOGGLE",
      targetType: "Class",
      targetId: row.class_id,
      targetName: `${row.course_name} / ${row.class_name}`,
      details: `教学班代码：${row.class_code}\n新开放申请状态：${taAllowed}\n新允许冲突状态：${isConflictAllowed}`
    });
  }
  db.close();
  redirect(res, `/admin/ta/classes?notice=已批量更新 ${changed} 个教学班的开放设置`);
}

async function taAdminClassApplicationsPage(res, user, classId, notice) {
  let classRow;
  let apps;
  const statusPillClass = (status) => {
    if (status === "PendingTAAdmin") return "pill gold";
    if (status === "Approved" || status === "PendingProfessor") return "pill ok";
    if (status === "RejectedByTAAdmin" || status === "RejectedByProfessor") return "pill bad";
    return "pill muted";
  };
  if (DB_CLIENT === "mysql") {
    const classData = await dbGateway.getCourseClassApplications(classId);
    classRow = classData.classRow;
    apps = classData.apps;
    if (!classRow) {
      return sendHtml(res, pageLayout("未找到", '<section class="card">教学班不存在。</section>', user, notice), {}, 404);
    }
  } else {
    const db = getDb();
    classRow = db.prepare("select * from classes where class_id = ?").get(classId);
    if (!classRow) {
      db.close();
      return sendHtml(res, pageLayout("未找到", '<section class="card">教学班不存在。</section>', user, notice), {}, 404);
    }
    apps = db.prepare(`
      select *
      from applications
      where class_id = ?
      order by submitted_at desc
    `).all(classId);
    db.close();
  }
  const conflictMap = new Map();
  if (DB_CLIENT === "mysql") {
    for (const app of apps) {
      conflictMap.set(app.application_id, await dbGateway.getApplicationConflicts(app.applier_user_id, classId));
    }
  }
  const rows = apps.map((app) => `<tr>
    <td>${app.application_id}</td>
    <td>${escapeHtml(app.applier_name)}</td>
    <td>${escapeHtml(normalizeDisplayDateTime(app.submitted_at))}</td>
    <td><span class="${statusPillClass(app.status)} nowrap">${escapeHtml(statusLabels[app.status] || app.status)}</span></td>
    <td>${escapeHtml(app.application_reason)}</td>
    <td>${(() => {
      const conflicts = DB_CLIENT === "mysql"
        ? (conflictMap.get(app.application_id) || [])
        : (() => {
            const db = getDb();
            const rows = getAppliedConflicts(db, app.applier_user_id, classId);
            db.close();
            return rows;
          })();
      if (!conflicts.length) {
        return "<span class='muted'>无冲突</span>";
      }
      return conflicts.map((item) => {
        const conflictApp = item.app || item;
        const matches = item.matches || [];
        return `${escapeHtml(conflictApp.class_name || "-")}（${escapeHtml(statusLabels[conflictApp.status] || conflictApp.status || "-")} / 允许冲突:${escapeHtml(conflictApp.is_conflict_allowed || "N")}）<br>${matches.map(escapeHtml).join("<br>")}`;
      }).join("<br><br>");
    })()}</td>
    <td>${attachmentLink(app)}</td>
    <td>${escapeHtml(app.ta_comment || "")}</td>
    <td class="table-action-cell"><div class="table-action-inner">${app.status === "PendingTAAdmin" ? `<a class="button-link secondary rect action-button" href="/admin/ta/pending/${app.application_id}">单独审批</a>` : `<span class="pill muted">已处理</span>`}</div></td>
  </tr>`).join("");
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
      <div class="table-wrap">
        <table class="wide compact-table fixed-layout">
          <colgroup>
            <col style="width:68px;" />
            <col style="width:96px;" />
            <col style="width:160px;" />
            <col style="width:132px;" />
            <col style="width:240px;" />
            <col style="width:360px;" />
            <col style="width:190px;" />
            <col style="width:190px;" />
            <col style="width:120px;" />
          </colgroup>
          <tr><th>ID</th><th>申请人</th><th>申请时间</th><th>状态</th><th>申请原因</th><th>冲突教学班摘要</th><th>简历</th><th>TAAdmin 备注</th><th>操作</th></tr>${rows}
        </table>
      </div>
    </section>
  `, user, notice));
}

async function taAdminBatchApproveByClass(req, res, user, classId) {
  const body = await readBody(req);
  const result = String(body.result || "Rejected");
  const comments = String(body.comments || "").trim();
  if (DB_CLIENT === "mysql") {
    const classData = await dbGateway.getCourseClassApplications(classId);
    if (!classData.classRow) {
      return redirect(res, "/admin/ta/classes?notice=教学班不存在");
    }
    const pendingIds = classData.apps
      .filter((app) => app.status === "PendingTAAdmin")
      .map((app) => Number(app.application_id))
      .filter(Boolean);
    if (!pendingIds.length) {
      return redirect(res, `/admin/ta/classes/${classId}/applications?notice=当前教学班没有待审批申请`);
    }
    const batchResult = await dbGateway.batchApplyTaAdminDecision(user, pendingIds, result, comments, nowStr());
    const emailJobs = batchResult.emailPayloads.map((item) => buildTaDecisionEmail(item.applicant, item.app, result, comments));
    const emailErrors = await sendEmailsAndCollectErrors(emailJobs);
    if (emailErrors.length) {
      await dbGateway.appendAuditLog({
        actor: user,
        actionType: "EMAIL_PARTIAL_FAILURE",
        targetType: "Application",
        targetId: pendingIds.join(","),
        targetName: "TAAdmin按教学班批量审批",
        details: `场景：TAAdmin按教学班批量审批\n失败邮件：\n${emailErrors.join("\n")}`,
        createdAt: nowStr()
      });
    }
    return redirect(res, `/admin/ta/classes/${classId}/applications?notice=${emailErrors.length ? "批量审批已完成，部分邮件发送失败" : "批量审批已完成，站内通知和邮件已发送"}`);
  }
  const db = getDb();
  const selectApplicant = db.prepare("select user_id, user_name, email from users where user_id = ?");
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
  const emailJobs = [];
  try {
    for (const app of apps) {
      applyTaAdminDecision(db, user, app, result, comments);
      emailJobs.push(buildTaDecisionEmail(selectApplicant.get(app.applier_user_id), app, result, comments));
    }
  } catch (error) {
    db.close();
    return redirect(res, `/admin/ta/classes/${classId}/applications?notice=${error.message}`);
  }
  db.close();
  const emailErrors = await sendEmailsAndCollectErrors(emailJobs);
  redirect(res, `/admin/ta/classes/${classId}/applications?notice=${emailErrors.length ? "批量审批已完成，部分邮件发送失败" : "批量审批已完成，站内通知和邮件已发送"}`);
}

async function renderCourseClassEditPage(res, user, classId, notice, options = {}) {
  const listPath = options.listPath || "/course/classes";
  const applicationsPath = options.applicationsPath || `/course/classes/${classId}/applications`;
  const deletePath = options.deletePath || `/course/classes/${classId}/delete`;
  const submitPath = options.submitPath || `/course/classes/${classId}/update`;
  const showDelete = options.showDelete !== false;
  const { classRow: row, schedules, applicationCount, approvedCount } = await dbGateway.getCourseClassDetail(classId);
  if (!row) {
    return sendHtml(res, pageLayout("未找到", '<section class="card">教学班不存在。</section>', user, notice), {}, 404);
  }
  const professorRows = await dbGateway.getProfessorUsers();
  const selectedProfessorIds = new Set(normalizeTeacherUserIds(row.teacher_user_id));
  const professorOptionsMarkup = professorRows.map((professor) => `<option value="${professor.user_id}" ${selectedProfessorIds.has(Number(professor.user_id)) ? "selected" : ""}>${escapeHtml(professor.user_name)}</option>`).join("");
  sendHtml(res, pageLayout("编辑教学班", `
    <section class="card">
      <h2>编辑教学班</h2>
      <p class="muted">申请数：${applicationCount}，已通过：${approvedCount} / ${row.maximum_number_of_tas_admitted}</p>
      <div class="actions">
        <a class="button-link secondary" href="${listPath}">返回教学班列表</a>
        <a class="button-link secondary" href="${applicationsPath}">查看关联申请</a>
        ${showDelete ? `<a class="button-link danger" href="${deletePath}">删除教学班</a>` : ""}
      </div>
      <form method="post" action="${submitPath}">
        <div class="grid">
          <p><label>ClassCode<input name="class_code" value="${escapeHtml(row.class_code)}" required /></label></p>
          <p><label>教学班缩写<input name="class_abbr" value="${escapeHtml(row.class_abbr || row.class_code)}" required /></label></p>
          <p><label>课程名<input name="course_name" value="${escapeHtml(row.course_name)}" required /></label></p>
          <p><label>教学班名称<input name="class_name" value="${escapeHtml(row.class_name)}" required /></label></p>
          <p><label>授课语言<select name="teaching_language"><option value="中文" ${row.teaching_language === "中文" ? "selected" : ""}>中文</option><option value="英文" ${row.teaching_language === "英文" ? "selected" : ""}>英文</option></select></label></p>
          <p><label>Professor（可多选）<select class="multi-select-list" name="teacher_user_id" multiple size="10">${professorOptionsMarkup}</select></label></p>
          <p><label>学期<input name="semester" value="${escapeHtml(row.semester)}" required /></label></p>
          <p><label>学分<input name="credit" type="number" step="0.1" min="0" value="${escapeHtml(String(row.credit ?? 0))}" required /></label></p>
          <p><label>最大录取人数<input name="maximum_number" type="number" value="${row.maximum_number_of_tas_admitted}" min="1" required /></label></p>
          <p><label>允许 TA 申请<select name="ta_allowed"><option value="Y" ${row.ta_applications_allowed === "Y" ? "selected" : ""}>Y</option><option value="N" ${row.ta_applications_allowed === "N" ? "selected" : ""}>N</option></select></label></p>
          <p><label>允许冲突申请<select name="is_conflict_allowed"><option value="N" ${row.is_conflict_allowed === "N" ? "selected" : ""}>N</option><option value="Y" ${row.is_conflict_allowed === "Y" ? "selected" : ""}>Y</option></select></label></p>
          <p><label>开放开始时间<input name="apply_start_at" type="datetime-local" value="${escapeHtml(datetimeValueForInput(row.apply_start_at))}" required /></label></p>
          <p><label>开放结束时间<input name="apply_end_at" type="datetime-local" value="${escapeHtml(datetimeValueForInput(row.apply_end_at))}" required /></label></p>
        </div>
        <p><label>课程介绍<textarea name="class_intro">${escapeHtml(row.class_intro || "")}</textarea></label></p>
        <p><label>备注<textarea name="memo">${escapeHtml(row.memo || "")}</textarea></label></p>
        <p><label>排课记录<textarea name="schedule_lines" required>${escapeHtml(scheduleLinesValue(schedules))}</textarea></label></p>
        <p class="muted">一行一条排课，格式：YYYY-MM-DD,HH:MM,HH:MM[,节次][,考试类型]。节次可留空。</p>
        <button type="submit">保存教学班</button>
      </form>
    </section>
    <section class="card">
      <h3>当前排课预览</h3>
      ${schedulesTable(schedules)}
    </section>
  `, user, notice));
}

async function courseClassDetailPage(res, user, classId, notice) {
  return renderCourseClassEditPage(res, user, classId, notice, {
    listPath: "/course/classes",
    applicationsPath: `/course/classes/${classId}/applications`,
    deletePath: `/course/classes/${classId}/delete`,
    submitPath: `/course/classes/${classId}/update`,
    showDelete: true
  });
}

async function taAdminClassEditPage(res, user, classId, notice) {
  return renderCourseClassEditPage(res, user, classId, notice, {
    listPath: "/admin/ta/classes",
    applicationsPath: `/admin/ta/classes/${classId}/applications`,
    submitPath: `/admin/ta/classes/${classId}/update`,
    showDelete: false
  });
}

async function courseClassApplicationsPage(res, user, classId, notice) {
  const { classRow, apps } = await dbGateway.getCourseClassApplications(classId);
  if (!classRow) {
    return sendHtml(res, pageLayout("未找到", '<section class="card">教学班不存在。</section>', user, notice), {}, 404);
  }
  const rows = apps.map((app) => `<tr>
    <td>${app.application_id}</td>
    <td>${escapeHtml(app.applier_name)}</td>
    <td>${escapeHtml(normalizeDisplayDateTime(app.submitted_at))}</td>
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

async function courseClassDeleteConfirmPage(res, user, classId, notice) {
  const { classRow } = await dbGateway.getCourseClassDetail(classId);
  if (!classRow) {
    return sendHtml(res, pageLayout("未找到", '<section class="card">教学班不存在。</section>', user, notice), {}, 404);
  }
  const impact = await dbGateway.getClassDeleteImpact(classId);
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

async function courseUsersPage(res, user, notice, filters = {}) {
  const roleFilter = String(filters.role || "").trim();
  const sortBy = String(filters.sort_by || "user_name");
  const sortOrder = String(filters.sort_order || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  const users = await dbGateway.getCourseUsers(filters);
  const headerFilters = {
    user_name: filters.user_name || "",
    login_name: filters.login_name || "",
    email: filters.email || "",
    role: filters.role || "",
    is_allowed_to_apply: filters.is_allowed_to_apply || ""
  };
  const rows = users.map((row, index) => `<tr>
    <td>${index + 1}</td>
    <td>${escapeHtml(row.user_name)}</td>
    <td>${escapeHtml(row.login_name)}</td>
    <td>${escapeHtml(row.email)}</td>
    <td>${escapeHtml(row.role)}</td>
    <td>${escapeHtml(row.is_allowed_to_apply)}</td>
    <td>${row.application_count}</td>
    <td>${row.class_count}</td>
    <td>
      <div class="actions">
        <a class="button-link secondary action-button" href="/course/users/${row.user_id}">编辑</a>
        <form class="inline" method="post" action="/course/users/${row.user_id}/delete">
          <button class="danger action-button" type="submit">删除</button>
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
      <h2>筛选人员</h2>
      <form method="get" action="/course/users">
        <div class="filters-shell">
        <div class="filters-grid">
          <p><label>姓名<input name="user_name" value="${escapeHtml(filters.user_name || "")}" /></label></p>
          <p><label>登录名<input name="login_name" value="${escapeHtml(filters.login_name || "")}" /></label></p>
          <p><label>邮箱<input name="email" value="${escapeHtml(filters.email || "")}" /></label></p>
          <p><label>角色<select name="role">
            <option value="" ${!filters.role ? "selected" : ""}>全部</option>
            <option value="TA" ${filters.role === "TA" ? "selected" : ""}>TA</option>
            <option value="TAAdmin" ${filters.role === "TAAdmin" ? "selected" : ""}>TAAdmin</option>
            <option value="Professor" ${filters.role === "Professor" ? "selected" : ""}>Professor</option>
            <option value="CourseAdmin" ${filters.role === "CourseAdmin" ? "selected" : ""}>CourseAdmin</option>
          </select></label></p>
          <p><label>允许申请<select name="is_allowed_to_apply">
            <option value="" ${!filters.is_allowed_to_apply ? "selected" : ""}>全部</option>
            <option value="Y" ${filters.is_allowed_to_apply === "Y" ? "selected" : ""}>Y</option>
            <option value="N" ${filters.is_allowed_to_apply === "N" ? "selected" : ""}>N</option>
          </select></label></p>
          <div class="actions">
            <button class="secondary action-button" type="submit">筛选</button>
            <a class="button-link secondary action-button" href="/course/users">重置</a>
          </div>
        </div>
        </div>
      </form>
    </section>
    <section class="card">
      <h2>人员列表</h2>
      <div class="table-wrap list-scroll"><table>
        <tr>
          <th>序号</th>
          <th>${sortableHeader("姓名", "user_name", "/course/users", headerFilters, sortBy, sortOrder)}</th>
          <th>${sortableHeader("登录名", "login_name", "/course/users", headerFilters, sortBy, sortOrder)}</th>
          <th>${sortableHeader("邮箱", "email", "/course/users", headerFilters, sortBy, sortOrder)}</th>
          <th>${sortableHeader("角色", "role", "/course/users", headerFilters, sortBy, sortOrder)}</th>
          <th>${sortableHeader("允许申请", "is_allowed_to_apply", "/course/users", headerFilters, sortBy, sortOrder)}</th>
          <th>${sortableHeader("申请数", "application_count", "/course/users", headerFilters, sortBy, sortOrder)}</th>
          <th>${sortableHeader("授课班级", "class_count", "/course/users", headerFilters, sortBy, sortOrder)}</th>
          <th>操作</th>
        </tr>
        ${rows}
      </table></div>
    </section>
  `, user, notice));
}

async function courseUserDetailPage(res, user, userId, notice) {
  const { target, classes, applications } = await dbGateway.getCourseUserDetail(userId);
  if (!target) {
    return sendHtml(res, pageLayout("未找到", '<section class="card">人员不存在。</section>', user, notice), {}, 404);
  }
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

async function createCourseUser(req, res, user) {
  const body = await readBody(req);
  const role = String(body.role || "TA");
  const isAllowed = role === "TA" ? String(body.is_allowed_to_apply || "N") : "N";
  if (DB_CLIENT === "mysql") {
    try {
      await dbGateway.createCourseUser(user, {
        user_name: String(body.user_name || "").trim(),
        login_name: String(body.login_name || "").trim(),
        email: String(body.email || "").trim(),
        password: String(body.password || "123456").trim(),
        role,
        is_allowed_to_apply: isAllowed
      });
    } catch (error) {
      return redirect(res, "/course/users?notice=创建失败，登录名可能已存在");
    }
    return redirect(res, "/course/users?notice=人员已创建");
  }
  const db = getDb();
  try {
    const result = db.prepare(`
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
    createAuditLog(db, {
      actor: user,
      actionType: "USER_CREATE",
      targetType: "User",
      targetId: result.lastInsertRowid,
      targetName: String(body.user_name || "").trim(),
      details: `登录名：${String(body.login_name || "").trim()}\n角色：${role}\n邮箱：${String(body.email || "").trim()}\n允许申请：${isAllowed}`
    });
  } catch (error) {
    db.close();
    return redirect(res, "/course/users?notice=创建失败，登录名可能已存在");
  }
  db.close();
  redirect(res, "/course/users?notice=人员已创建");
}

async function importCourseUsers(req, res, user) {
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
    if (DB_CLIENT === "mysql") {
      await dbGateway.appendAuditLog({
        actor: user,
        actionType: "USER_IMPORT_FAILED",
        targetType: "Import",
        targetId: file.filename,
        targetName: "人员导入失败",
        details: `文件名：${file.filename}\n失败原因：${error.message}`
      });
    } else {
      const failedDb = getDb();
      createAuditLog(failedDb, {
        actor: user,
        actionType: "USER_IMPORT_FAILED",
        targetType: "Import",
        targetId: file.filename,
        targetName: "人员导入失败",
        details: `文件名：${file.filename}\n失败原因：${error.message}`
      });
      failedDb.close();
    }
    const reportId = saveImportReport({
      status: "failed",
      errorMessage: error.message,
      errors: error.importErrors || [error.message]
    });
    return redirect(res, `/course/users/import/result/${reportId}?notice=导入失败`);
  }
  if (DB_CLIENT === "mysql") {
    try {
      const result = await dbGateway.upsertImportedUsers(user, importedUsers, file.filename);
      const reportId = saveImportReport({
        status: "success",
        ...result
      });
      return redirect(res, `/course/users/import/result/${reportId}?notice=导入完成`);
    } catch (error) {
      await dbGateway.appendAuditLog({
        actor: user,
        actionType: "USER_IMPORT_FAILED",
        targetType: "Import",
        targetId: file.filename,
        targetName: "人员导入失败",
        details: `文件名：${file.filename}\n失败原因：${error.message}`
      });
      const reportId = saveImportReport({
        status: "failed",
        errorMessage: error.message,
        errors: error.importErrors || [error.message]
      });
      return redirect(res, `/course/users/import/result/${reportId}?notice=导入失败`);
    }
  }
  const db = getDb();
  try {
    const result = upsertImportedUsers(db, importedUsers);
    createAuditLog(db, {
      actor: user,
      actionType: "USER_IMPORT",
      targetType: "Import",
      targetId: file.filename,
      targetName: "人员导入",
      details: `文件名：${file.filename}\n新增人员：${result.createdCount}\n更新人员：${result.updatedCount}`
    });
    db.close();
    const reportId = saveImportReport({
      status: "success",
      ...result
    });
    return redirect(res, `/course/users/import/result/${reportId}?notice=导入完成`);
  } catch (error) {
    createAuditLog(db, {
      actor: user,
      actionType: "USER_IMPORT_FAILED",
      targetType: "Import",
      targetId: file.filename,
      targetName: "人员导入失败",
      details: `文件名：${file.filename}\n失败原因：${error.message}`
    });
    db.close();
    const reportId = saveImportReport({
      status: "failed",
      errorMessage: error.message,
      errors: error.importErrors || [error.message]
    });
    return redirect(res, `/course/users/import/result/${reportId}?notice=导入失败`);
  }
}

async function updateCourseUser(req, res, user, userId) {
  const body = await readBody(req);
  const role = String(body.role || "TA");
  const isAllowed = role === "TA" ? String(body.is_allowed_to_apply || "N") : "N";
  if (DB_CLIENT === "mysql") {
    try {
      const result = await dbGateway.updateCourseUser(user, userId, {
        user_name: String(body.user_name || "").trim(),
        login_name: String(body.login_name || "").trim(),
        email: String(body.email || "").trim(),
        password: String(body.password || "123456").trim(),
        role,
        is_allowed_to_apply: isAllowed
      });
      if (result?.notFound) {
        return redirect(res, "/course/users?notice=人员不存在");
      }
      if (result?.roleConflict) {
        return redirect(res, `/course/users/${userId}?notice=该用户已关联教学班，不能改为非 Professor`);
      }
    } catch (error) {
      return redirect(res, `/course/users/${userId}?notice=更新失败，登录名可能已存在`);
    }
    return redirect(res, `/course/users/${userId}?notice=人员信息已更新`);
  }
  const db = getDb();
  const target = db.prepare("select * from users where user_id = ?").get(userId);
  if (!target) {
    db.close();
    return redirect(res, "/course/users?notice=人员不存在");
  }
  const teachesClasses = db.prepare("select count(*) as count from classes where (',' || teacher_user_id || ',') like '%,' || ? || ',%'").get(String(userId)).count;
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
      const classes = db.prepare("select class_id, teacher_user_id from classes where (',' || teacher_user_id || ',') like '%,' || ? || ',%'").all(String(userId));
      const findProfessor = db.prepare("select user_id, user_name from users where user_id = ? and role = 'Professor'");
      for (const row of classes) {
        const ids = normalizeTeacherUserIds(row.teacher_user_id);
        const names = ids.map((id) => findProfessor.get(id)?.user_name).filter(Boolean).join(" / ");
        db.prepare("update classes set teacher_name = ? where class_id = ?").run(names, row.class_id);
      }
    }
    createAuditLog(db, {
      actor: user,
      actionType: "USER_UPDATE",
      targetType: "User",
      targetId: userId,
      targetName: String(body.user_name || "").trim(),
      details: `原登录名：${target.login_name}\n新登录名：${String(body.login_name || "").trim()}\n角色：${role}\n邮箱：${String(body.email || "").trim()}\n允许申请：${isAllowed}`
    });
  } catch (error) {
    db.close();
    return redirect(res, `/course/users/${userId}?notice=更新失败，登录名可能已存在`);
  }
  db.close();
  redirect(res, `/course/users/${userId}?notice=人员信息已更新`);
}

async function deleteCourseUser(res, user, userId) {
  if (DB_CLIENT === "mysql") {
    try {
      const result = await dbGateway.deleteCourseUser(user, userId);
      if (result?.notFound) {
        return redirect(res, "/course/users?notice=人员不存在");
      }
      if (result?.blocked) {
        return redirect(res, "/course/users?notice=该用户已有关联业务数据，当前不允许删除");
      }
    } catch (error) {
      return redirect(res, "/course/users?notice=删除失败");
    }
    return redirect(res, "/course/users?notice=人员已删除");
  }
  const db = getDb();
  const target = db.prepare("select * from users where user_id = ?").get(userId);
  if (!target) {
    db.close();
    return redirect(res, "/course/users?notice=人员不存在");
  }
  const applicationCount = db.prepare("select count(*) as count from applications where applier_user_id = ? or (',' || teacher_user_id || ',') like '%,' || ? || ',%'").get(userId, String(userId)).count;
  const classCount = db.prepare("select count(*) as count from classes where (',' || teacher_user_id || ',') like '%,' || ? || ',%'").get(String(userId)).count;
  const approvalCount = db.prepare("select count(*) as count from approval_logs where approver_user_id = ?").get(userId).count;
  if (applicationCount > 0 || classCount > 0 || approvalCount > 0) {
    db.close();
    return redirect(res, "/course/users?notice=该用户已有关联业务数据，当前不允许删除");
  }
  createAuditLog(db, {
    actor: user,
    actionType: "USER_DELETE",
    targetType: "User",
    targetId: userId,
    targetName: target.user_name,
    details: `登录名：${target.login_name}\n角色：${target.role}\n邮箱：${target.email}`
  });
  db.prepare("delete from users where user_id = ?").run(userId);
  db.close();
  redirect(res, "/course/users?notice=人员已删除");
}

async function createClass(req, res, user) {
  const body = await readBody(req);
  const maximumNumber = Number(body.maximum_number || 1);
  const credit = Number(body.credit || 0);
  const isConflictAllowed = String(body.is_conflict_allowed || "N");
  let applyStartAt;
  let applyEndAt;
  if (!["Y", "N"].includes(isConflictAllowed)) {
    return redirect(res, "/course/classes?notice=允许冲突申请取值不合法");
  }
  if (!Number.isFinite(credit) || credit < 0) {
    return redirect(res, "/course/classes?notice=学分必须是大于等于 0 的数字");
  }
  let professorSelection;
  try {
    applyStartAt = normalizeDateTimeInput(body.apply_start_at);
    applyEndAt = normalizeDateTimeInput(body.apply_end_at);
    validateApplyWindow(applyStartAt, applyEndAt);
  } catch (error) {
    return redirect(res, `/course/classes?notice=${error.message}`);
  }
  let scheduleRows;
  try {
    scheduleRows = parseScheduleLines(body.schedule_lines);
  } catch (error) {
    return redirect(res, `/course/classes?notice=${error.message}`);
  }
  if (DB_CLIENT === "mysql") {
    try {
      professorSelection = await resolveProfessorSelectionGateway(body.teacher_user_id);
    } catch (error) {
      return redirect(res, `/course/classes?notice=${error.message}`);
    }
    try {
      await dbGateway.createCourseClass(user, {
        class_code: String(body.class_code || "").trim(),
        class_abbr: String(body.class_abbr || body.class_code || "").trim(),
        class_name: String(body.class_name || "").trim(),
        course_name: String(body.course_name || "").trim(),
        teaching_language: String(body.teaching_language || "中文"),
        teacher_user_id: professorSelection.idText,
        teacher_name: professorSelection.nameText,
        class_intro: String(body.class_intro || "").trim(),
        memo: String(body.memo || "").trim(),
        credit,
        maximum_number_of_tas_admitted: maximumNumber,
        ta_applications_allowed: String(body.ta_allowed || "Y"),
        is_conflict_allowed: isConflictAllowed,
        apply_start_at: applyStartAt,
        apply_end_at: applyEndAt,
        semester: String(body.semester || "").trim()
      }, scheduleRows);
    } catch (error) {
      return redirect(res, "/course/classes?notice=ClassCode 已存在或字段非法");
    }
    return redirect(res, "/course/classes?notice=教学班已创建");
  }
  const db = getDb();
  try {
    professorSelection = resolveProfessorSelection(db, body.teacher_user_id);
  } catch (error) {
    db.close();
    return redirect(res, `/course/classes?notice=${error.message}`);
  }
  try {
    const result = db.prepare(`
      insert into classes (
        class_code, class_abbr, class_name, course_name, teaching_language, teacher_user_id,
        teacher_name, class_intro, memo, credit, maximum_number_of_tas_admitted,
        ta_applications_allowed, is_conflict_allowed, apply_start_at, apply_end_at, semester
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      credit,
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
    createAuditLog(db, {
      actor: user,
      actionType: "CLASS_CREATE",
      targetType: "Class",
      targetId: result.lastInsertRowid,
      targetName: `${String(body.course_name || "").trim()} / ${String(body.class_name || "").trim()}`,
      details: `教学班代码：${String(body.class_code || "").trim()}\n教授：${professorSelection.nameText}\n学期：${String(body.semester || "").trim()}\n学分：${credit}\nTA上限：${maximumNumber}\n排课数：${scheduleRows.length}`
    });
  } catch (error) {
    db.close();
    return redirect(res, "/course/classes?notice=ClassCode 已存在或字段非法");
  }
  db.close();
  redirect(res, "/course/classes?notice=教学班已创建");
}

async function importClasses(req, res, user) {
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
    if (DB_CLIENT === "mysql") {
      await dbGateway.appendAuditLog({
        actor: user,
        actionType: "CLASS_IMPORT_FAILED",
        targetType: "Import",
        targetId: file.filename,
        targetName: "教学班导入失败",
        details: `文件名：${file.filename}\n失败原因：${error.message}`
      });
    } else {
      const failedDb = getDb();
      createAuditLog(failedDb, {
        actor: user,
        actionType: "CLASS_IMPORT_FAILED",
        targetType: "Import",
        targetId: file.filename,
        targetName: "教学班导入失败",
        details: `文件名：${file.filename}\n失败原因：${error.message}`
      });
      failedDb.close();
    }
    const reportId = saveImportReport({
      status: "failed",
      errorMessage: error.message,
      errors: error.importErrors || [error.message]
    });
    return redirect(res, `/course/classes/import/result/${reportId}?notice=导入失败`);
  }
  if (DB_CLIENT === "mysql") {
    try {
      const result = await dbGateway.upsertImportedClasses(user, importedClasses, file.filename);
      const reportId = saveImportReport({
        status: "success",
        ...result
      });
      return redirect(res, `/course/classes/import/result/${reportId}?notice=导入完成`);
    } catch (error) {
      await dbGateway.appendAuditLog({
        actor: user,
        actionType: "CLASS_IMPORT_FAILED",
        targetType: "Import",
        targetId: file.filename,
        targetName: "教学班导入失败",
        details: `文件名：${file.filename}\n失败原因：${error.message}`
      });
      const reportId = saveImportReport({
        status: "failed",
        errorMessage: error.message,
        errors: error.importErrors || [error.message]
      });
      return redirect(res, `/course/classes/import/result/${reportId}?notice=导入失败`);
    }
  }
  const db = getDb();
  try {
    const result = upsertImportedClasses(db, importedClasses);
    createAuditLog(db, {
      actor: user,
      actionType: "CLASS_IMPORT",
      targetType: "Import",
      targetId: file.filename,
      targetName: "教学班导入",
      details: `文件名：${file.filename}\n新增教学班：${result.createdCount}\n更新教学班：${result.updatedCount}`
    });
    db.close();
    const reportId = saveImportReport({
      status: "success",
      ...result
    });
    return redirect(res, `/course/classes/import/result/${reportId}?notice=导入完成`);
  } catch (error) {
    createAuditLog(db, {
      actor: user,
      actionType: "CLASS_IMPORT_FAILED",
      targetType: "Import",
      targetId: file.filename,
      targetName: "教学班导入失败",
      details: `文件名：${file.filename}\n失败原因：${error.message}`
    });
    db.close();
    const reportId = saveImportReport({
      status: "failed",
      errorMessage: error.message,
      errors: error.importErrors || [error.message]
    });
    return redirect(res, `/course/classes/import/result/${reportId}?notice=导入失败`);
  }
}

async function updateClass(req, res, user, classId, options = {}) {
  const basePath = options.basePath || "/course/classes";
  const detailPath = `${basePath}/${classId}`;
  const body = await readBody(req);
  const maximumNumber = Number(body.maximum_number || 1);
  const credit = Number(body.credit || 0);
  const isConflictAllowed = String(body.is_conflict_allowed || "N");
  let applyStartAt;
  let applyEndAt;
  if (!["Y", "N"].includes(isConflictAllowed)) {
    return redirect(res, `${detailPath}?notice=允许冲突申请取值不合法`);
  }
  if (!Number.isFinite(credit) || credit < 0) {
    return redirect(res, `${detailPath}?notice=学分必须是大于等于 0 的数字`);
  }
  try {
    applyStartAt = normalizeDateTimeInput(body.apply_start_at);
    applyEndAt = normalizeDateTimeInput(body.apply_end_at);
    validateApplyWindow(applyStartAt, applyEndAt);
  } catch (error) {
    return redirect(res, `${detailPath}?notice=${error.message}`);
  }
  let scheduleRows;
  try {
    scheduleRows = parseScheduleLines(body.schedule_lines);
  } catch (error) {
    return redirect(res, `${detailPath}?notice=${error.message}`);
  }
  if (DB_CLIENT === "mysql") {
    let professorSelection;
    try {
      professorSelection = await resolveProfessorSelectionGateway(body.teacher_user_id);
    } catch (error) {
      return redirect(res, `${detailPath}?notice=${error.message}`);
    }
    try {
      const result = await dbGateway.updateCourseClass(user, classId, {
        class_code: String(body.class_code || "").trim(),
        class_abbr: String(body.class_abbr || body.class_code || "").trim(),
        class_name: String(body.class_name || "").trim(),
        course_name: String(body.course_name || "").trim(),
        teaching_language: String(body.teaching_language || "中文"),
        teacher_user_id: professorSelection.idText,
        teacher_name: professorSelection.nameText,
        class_intro: String(body.class_intro || "").trim(),
        memo: String(body.memo || "").trim(),
        credit,
        maximum_number_of_tas_admitted: maximumNumber,
        ta_applications_allowed: String(body.ta_allowed || "Y"),
        is_conflict_allowed: isConflictAllowed,
        apply_start_at: applyStartAt,
        apply_end_at: applyEndAt,
        semester: String(body.semester || "").trim()
      }, scheduleRows);
      if (result?.notFound) {
        return redirect(res, `${basePath}?notice=教学班不存在`);
      }
    } catch (error) {
      return redirect(res, `${detailPath}?notice=更新失败，ClassCode 可能已存在`);
    }
    return redirect(res, `${detailPath}?notice=教学班已更新`);
  }
  const db = getDb();
  const currentClass = db.prepare("select * from classes where class_id = ?").get(classId);
  if (!currentClass) {
    db.close();
    return redirect(res, `${basePath}?notice=教学班不存在`);
  }
  let professorSelection;
  try {
    professorSelection = resolveProfessorSelection(db, body.teacher_user_id);
  } catch (error) {
    db.close();
    return redirect(res, `${detailPath}?notice=${error.message}`);
  }
  try {
    db.prepare(`
      update classes
      set class_code = ?, class_abbr = ?, class_name = ?, course_name = ?, teaching_language = ?, teacher_user_id = ?,
          teacher_name = ?, class_intro = ?, memo = ?, credit = ?, maximum_number_of_tas_admitted = ?, ta_applications_allowed = ?, is_conflict_allowed = ?, apply_start_at = ?, apply_end_at = ?, semester = ?
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
      credit,
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
    createAuditLog(db, {
      actor: user,
      actionType: "CLASS_UPDATE",
      targetType: "Class",
      targetId: classId,
      targetName: `${String(body.course_name || "").trim()} / ${String(body.class_name || "").trim()}`,
      details: `教学班代码：${String(body.class_code || "").trim()}\n教授：${professorSelection.nameText}\n学期：${String(body.semester || "").trim()}\n学分：${credit}\nTA上限：${maximumNumber}\n排课数：${scheduleRows.length}`
    });
  } catch (error) {
    db.close();
    return redirect(res, `${detailPath}?notice=更新失败，ClassCode 可能已存在`);
  }
  db.close();
  redirect(res, `${detailPath}?notice=教学班已更新`);
}

async function batchUpdateClassWindow(req, res, user) {
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
  if (DB_CLIENT === "mysql") {
    const result = await dbGateway.batchUpdateCourseClassWindow(user, refs, applyStartAt, applyEndAt);
    if (result.changed === 0) {
      return redirect(res, "/course/classes?notice=未匹配到任何教学班");
    }
    return redirect(res, `/course/classes?notice=已批量更新 ${result.changed} 个教学班的开放申请时间`);
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
  const changedRows = loadClassRowsByRefs(db, refs);
  for (const row of changedRows) {
    createAuditLog(db, {
      actor: user,
      actionType: "CLASS_APPLY_WINDOW_UPDATE",
      targetType: "Class",
      targetId: row.class_id,
      targetName: `${row.course_name} / ${row.class_name}`,
      details: `教学班代码：${row.class_code}\n开放开始：${applyStartAt}\n开放结束：${applyEndAt}`
    });
  }
  db.close();
  if (changed === 0) {
    return redirect(res, "/course/classes?notice=未匹配到任何教学班");
  }
  redirect(res, `/course/classes?notice=已批量更新 ${changed} 个教学班的开放申请时间`);
}

async function batchToggleClassApply(req, res, user) {
  const body = await readBody(req);
  const refs = parseBatchClassRefs(body.class_refs);
  const taAllowed = String(body.ta_allowed || "Y");
  if (!["Y", "N"].includes(taAllowed)) {
    return redirect(res, "/course/classes?notice=申请权限取值不合法");
  }
  if (!refs.length) {
    return redirect(res, "/course/classes?notice=请填写至少一个教学班 ID 或 ClassCode");
  }
  if (DB_CLIENT === "mysql") {
    const result = await dbGateway.batchToggleCourseClassApply(user, refs, taAllowed);
    if (result.changed === 0) {
      return redirect(res, "/course/classes?notice=未匹配到任何教学班");
    }
    return redirect(res, `/course/classes?notice=已批量更新 ${result.changed} 个教学班的申请权限`);
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
  const changedRows = loadClassRowsByRefs(db, refs);
  for (const row of changedRows) {
    createAuditLog(db, {
      actor: user,
      actionType: "CLASS_APPLY_TOGGLE",
      targetType: "Class",
      targetId: row.class_id,
      targetName: `${row.course_name} / ${row.class_name}`,
      details: `教学班代码：${row.class_code}\n新开放申请状态：${taAllowed}`
    });
  }
  db.close();
  if (changed === 0) {
    return redirect(res, "/course/classes?notice=未匹配到任何教学班");
  }
  redirect(res, `/course/classes?notice=已批量更新 ${changed} 个教学班的申请权限`);
}

function deleteClassesByIds(classIds, actor = null) {
  const ids = Array.from(new Set(
    classIds
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0)
  ));
  if (!ids.length) {
    return { deletedCount: 0 };
  }
  if (DB_CLIENT === "mysql") {
    throw new Error("deleteClassesByIds must use deleteClassesByIdsAsync in mysql mode");
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
    const classRow = db.prepare("select * from classes where class_id = ?").get(classId);
    if (!classRow) continue;
    const impact = classDeleteImpact(db, classId);
    const apps = selectApps.all(classId);
    for (const app of apps) {
      deleteApproval.run(app.application_id);
      if (app.resume_path) {
        filesToDelete.push(path.join(UPLOAD_DIR, path.basename(app.resume_path)));
      }
    }
    deleteApps.run(classId);
    deleteSchedules.run(classId);
    createAuditLog(db, {
      actor,
      actionType: "CLASS_DELETE",
      targetType: "Class",
      targetId: classId,
      targetName: `${classRow.course_name} / ${classRow.class_name}`,
      details: `教学班代码：${classRow.class_code}\n教授：${classRow.teacher_name}\n排课数：${impact.scheduleCount}\n申请数：${impact.applicationCount}\n审批日志数：${impact.approvalCount}`
    });
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

async function deleteClassesByIdsAsync(classIds, actor = null) {
  if (DB_CLIENT === "mysql") {
    const result = await dbGateway.deleteCourseClasses(actor, classIds);
    for (const filePath of result.filesToDelete || []) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    return { deletedCount: result.deletedCount || 0 };
  }
  return deleteClassesByIds(classIds, actor);
}

async function deleteClass(res, user, classId) {
  const result = await deleteClassesByIdsAsync([classId], user);
  if (result.deletedCount === 0) {
    return redirect(res, "/course/classes?notice=教学班不存在");
  }
  redirect(res, "/course/classes?notice=教学班及其关联排课、申请、审批记录已删除");
}

async function batchDeleteClasses(req, res, user) {
  const body = await readBody(req);
  const refs = parseBatchClassRefs(body.class_refs);
  if (!refs.length) {
    return redirect(res, "/course/classes?notice=请先勾选至少一个教学班");
  }
  let classRows;
  if (DB_CLIENT === "mysql") {
    classRows = await dbGateway.getClassRowsByRefs(refs);
  } else {
    const db = getDb();
    classRows = loadClassRowsByRefs(db, refs);
    db.close();
  }
  if (!classRows.length) {
    return redirect(res, "/course/classes?notice=未匹配到任何教学班");
  }
  const result = await deleteClassesByIdsAsync(classRows.map((row) => row.class_id), user);
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
  const user = await getCurrentUser(req);

  if (pathname.startsWith("/assets/")) {
    const fileName = path.basename(decodeURIComponent(pathname.replace("/assets/", "")));
    const filePath = path.join(ASSET_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("file not found");
      return;
    }
    const ext = path.extname(fileName).toLowerCase();
    const contentTypes = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".webp": "image/webp"
    };
    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream",
      "Cache-Control": "public, max-age=3600"
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (pathname.startsWith("/uploads/")) {
    const fileName = path.basename(decodeURIComponent(pathname.replace("/uploads/", "")));
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
    const row = await dbGateway.findUserByLoginAndPassword(String(body.login_name || ""), String(body.password || ""));
    if (!row) {
      return loginPage(res, "账号或密码错误");
    }
    const sid = crypto.randomBytes(16).toString("hex");
    sessions.set(sid, row.user_id);
    return redirect(res, `/?notice=${row.user_name} 已登录`, { "Set-Cookie": `sid=${sid}; Path=/; HttpOnly` });
  }

  if (pathname === "/login/sso") {
    return startSsoLogin(req, res);
  }

  if (pathname === "/login/sso/callback") {
    return handleSsoCallback(req, res, url);
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
    return taClassesPage(res, user, notice, {
      apply_status: url.searchParams.get("apply_status") || "",
      professor_name: url.searchParams.get("professor_name") || "",
      course_name: url.searchParams.get("course_name") || "",
      class_name: url.searchParams.get("class_name") || "",
      teaching_language: url.searchParams.get("teaching_language") || ""
    });
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
    return taClassDetailPage(res, user, Number(pathname.split("/").pop()), notice);
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
    return taAdminPendingPage(res, user, notice, {
      applier_name: url.searchParams.get("applier_name") || "",
      class_name: url.searchParams.get("class_name") || "",
      teacher_name: url.searchParams.get("teacher_name") || ""
    });
  }
  if (pathname === "/admin/ta/applications") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminAllApplicationsPage(res, user, notice, {
      applier_name: url.searchParams.get("applier_name") || "",
      class_name: url.searchParams.get("class_name") || "",
      teacher_name: url.searchParams.get("teacher_name") || "",
      status: url.searchParams.get("status") || ""
    });
  }
  if (pathname === "/admin/ta/application-logs") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminApplicationLogsPage(res, user, notice, {
      applier_name: url.searchParams.get("applier_name") || "",
      class_name: url.searchParams.get("class_name") || "",
      teacher_name: url.searchParams.get("teacher_name") || "",
      status: url.searchParams.get("status") || "",
      submitted_from: url.searchParams.get("submitted_from") || "",
      submitted_to: url.searchParams.get("submitted_to") || ""
    });
  }
  if (pathname === "/admin/ta/pending/batch-approve" && req.method === "POST") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminBatchApprove(req, res, user);
  }
  if (/^\/admin\/ta\/applications\/\d+\/override-status$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return overrideApplicationStatus(req, res, user, Number(pathname.split("/")[4]), "/admin/ta/pending");
  }
  if (pathname === "/admin/ta/classes") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminAllClassesPage(res, user, notice, {
      professor_name: url.searchParams.get("professor_name") || "",
      class_name: url.searchParams.get("class_name") || "",
      semester: url.searchParams.get("semester") || "",
      ta_full: url.searchParams.get("ta_full") || "",
      has_pending: url.searchParams.get("has_pending") || "",
      published_to_professor: url.searchParams.get("published_to_professor") || "",
      ta_applications_allowed: url.searchParams.get("ta_applications_allowed") || "",
      is_conflict_allowed: url.searchParams.get("is_conflict_allowed") || ""
    });
  }
  if (pathname === "/admin/ta/classes/calendar") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminClassesCalendarPage(res, user, notice, {
      professor_name: url.searchParams.get("professor_name") || "",
      class_name: url.searchParams.get("class_name") || "",
      semester: url.searchParams.get("semester") || "",
      ta_full: url.searchParams.get("ta_full") || "",
      has_pending: url.searchParams.get("has_pending") || "",
      published_to_professor: url.searchParams.get("published_to_professor") || "",
      ta_applications_allowed: url.searchParams.get("ta_applications_allowed") || "",
      is_conflict_allowed: url.searchParams.get("is_conflict_allowed") || "",
      month: url.searchParams.get("month") || ""
    });
  }
  if (pathname === "/admin/ta/classes/ta-export") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminClassTaExport(res, {
      professor_name: url.searchParams.get("professor_name") || "",
      class_name: url.searchParams.get("class_name") || "",
      semester: url.searchParams.get("semester") || "",
      ta_full: url.searchParams.get("ta_full") || "",
      has_pending: url.searchParams.get("has_pending") || "",
      published_to_professor: url.searchParams.get("published_to_professor") || "",
      ta_applications_allowed: url.searchParams.get("ta_applications_allowed") || "",
      is_conflict_allowed: url.searchParams.get("is_conflict_allowed") || ""
    });
  }
  if (/^\/admin\/ta\/classes\/\d+$/.test(pathname)) {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminClassEditPage(res, user, Number(pathname.split("/").pop()), notice);
  }
  if (/^\/admin\/ta\/classes\/\d+\/applications$/.test(pathname)) {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminClassApplicationsPage(res, user, Number(pathname.split("/")[4]), notice);
  }
  if (/^\/admin\/ta\/classes\/\d+\/update$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return updateClass(req, res, user, Number(pathname.split("/")[4]), { basePath: "/admin/ta/classes" });
  }
  if (pathname === "/admin/ta/classes/email-preview" && req.method === "POST") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminProfessorEmailPreview(req, res, user, notice);
  }
  if (pathname === "/admin/ta/classes/send-email" && req.method === "POST") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminSendProfessorEmails(req, res, user);
  }
  if (pathname === "/admin/ta/classes/batch-publish" && req.method === "POST") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return batchUpdateProfessorPublishStatus(req, res, user);
  }
  if (pathname === "/admin/ta/classes/batch-window" && req.method === "POST") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminBatchUpdateClassWindow(req, res, user);
  }
  if (pathname === "/admin/ta/classes/batch-settings" && req.method === "POST") {
    if (!requireRole(res, user, ["TAAdmin"])) return;
    return taAdminBatchUpdateClassSettings(req, res, user);
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
    return toggleTaUser(res, user, Number(pathname.split("/")[4]));
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
    if (!requireRole(res, user, ["CourseAdmin", "TAAdmin"])) return;
    return courseClassesPage(res, user, notice, {
      class_code: url.searchParams.get("class_code") || "",
      class_name: url.searchParams.get("class_name") || "",
      teacher_name: url.searchParams.get("teacher_name") || "",
      ta_full: url.searchParams.get("ta_full") || "",
      status_filter: url.searchParams.get("status_filter") || "",
      sort_by: url.searchParams.get("sort_by") || "class_code",
      sort_order: url.searchParams.get("sort_order") || "asc"
    });
  }
  if (pathname === "/course/classes/calendar") {
    if (!requireRole(res, user, ["CourseAdmin", "TAAdmin"])) return;
    return courseClassesCalendarPage(res, user, notice, {
      class_code: url.searchParams.get("class_code") || "",
      class_name: url.searchParams.get("class_name") || "",
      teacher_name: url.searchParams.get("teacher_name") || "",
      ta_full: url.searchParams.get("ta_full") || "",
      status_filter: url.searchParams.get("status_filter") || "",
      sort_by: url.searchParams.get("sort_by") || "class_code",
      sort_order: url.searchParams.get("sort_order") || "asc",
      month: url.searchParams.get("month") || ""
    });
  }
  if (pathname === "/course/classes/ta-export") {
    if (!requireRole(res, user, ["CourseAdmin", "TAAdmin"])) return;
    return courseClassTaExport(res, {
      class_code: url.searchParams.get("class_code") || "",
      class_name: url.searchParams.get("class_name") || "",
      teacher_name: url.searchParams.get("teacher_name") || "",
      ta_full: url.searchParams.get("ta_full") || "",
      status_filter: url.searchParams.get("status_filter") || "",
      sort_by: url.searchParams.get("sort_by") || "class_code",
      sort_order: url.searchParams.get("sort_order") || "asc"
    });
  }
  if (pathname === "/course/reports") {
    if (!requireRole(res, user, ["CourseAdmin", "TAAdmin"])) return;
    return courseReportsPage(res, user, notice, {
      submitted_from: url.searchParams.get("submitted_from") || "",
      submitted_to: url.searchParams.get("submitted_to") || "",
      semester: url.searchParams.get("semester") || "",
      teacher_name: url.searchParams.get("teacher_name") || ""
    });
  }
  if (pathname === "/course/reports/export") {
    if (!requireRole(res, user, ["CourseAdmin", "TAAdmin"])) return;
    return courseReportsExport(res, {
      submitted_from: url.searchParams.get("submitted_from") || "",
      submitted_to: url.searchParams.get("submitted_to") || "",
      semester: url.searchParams.get("semester") || "",
      teacher_name: url.searchParams.get("teacher_name") || ""
    });
  }
  if (pathname === "/course/audit-logs") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return courseAuditLogsPage(res, user, notice, {
      actor_name: url.searchParams.get("actor_name") || "",
      action_type: url.searchParams.get("action_type") || "",
      target_type: url.searchParams.get("target_type") || "",
      keyword: url.searchParams.get("keyword") || ""
    });
  }
  if (pathname === "/course/application-logs") {
    if (!requireRole(res, user, ["CourseAdmin", "TAAdmin"])) return;
    return courseAdminApplicationLogsPage(res, user, notice, {
      applier_name: url.searchParams.get("applier_name") || "",
      class_name: url.searchParams.get("class_name") || "",
      teacher_name: url.searchParams.get("teacher_name") || "",
      status: url.searchParams.get("status") || "",
      submitted_from: url.searchParams.get("submitted_from") || "",
      submitted_to: url.searchParams.get("submitted_to") || ""
    });
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
        credit: 3.0,
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
        credit: 3.0,
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
    return createClass(req, res, user);
  }
  if (pathname === "/course/classes/import" && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return importClasses(req, res, user);
  }
  if (pathname === "/course/classes/batch-toggle" && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return batchToggleClassApply(req, res, user);
  }
  if (pathname === "/course/classes/batch-window" && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return batchUpdateClassWindow(req, res, user);
  }
  if (pathname === "/course/classes/batch-delete" && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return batchDeleteClassesConfirmPage(req, res, user, notice);
  }
  if (pathname === "/course/classes/batch-delete/confirm" && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return batchDeleteClasses(req, res, user);
  }
  if (/^\/course\/classes\/\d+$/.test(pathname)) {
    if (!requireRole(res, user, ["CourseAdmin", "TAAdmin"])) return;
    return courseClassDetailPage(res, user, Number(pathname.split("/").pop()), notice);
  }
  if (/^\/course\/classes\/\d+\/applications$/.test(pathname)) {
    if (!requireRole(res, user, ["CourseAdmin", "TAAdmin"])) return;
    return courseClassApplicationsPage(res, user, Number(pathname.split("/")[3]), notice);
  }
  if (/^\/course\/classes\/\d+\/delete$/.test(pathname)) {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return courseClassDeleteConfirmPage(res, user, Number(pathname.split("/")[3]), notice);
  }
  if (/^\/course\/classes\/\d+\/delete\/confirm$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return deleteClass(res, user, Number(pathname.split("/")[3]));
  }
  if (/^\/course\/classes\/\d+\/update$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return updateClass(req, res, user, Number(pathname.split("/")[3]));
  }
  if (pathname === "/course/users") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return courseUsersPage(res, user, notice, {
      user_name: url.searchParams.get("user_name") || "",
      login_name: url.searchParams.get("login_name") || "",
      email: url.searchParams.get("email") || "",
      role: url.searchParams.get("role") || "",
      is_allowed_to_apply: url.searchParams.get("is_allowed_to_apply") || "",
      sort_by: url.searchParams.get("sort_by") || "user_name",
      sort_order: url.searchParams.get("sort_order") || "asc"
    });
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
    return importCourseUsers(req, res, user);
  }
  if (/^\/course\/users\/import\/result\/[A-Za-z0-9]+$/.test(pathname)) {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return usersImportResultPage(res, user, pathname.split("/").pop(), notice);
  }
  if (pathname === "/course/users/create" && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return createCourseUser(req, res, user);
  }
  if (/^\/course\/users\/\d+$/.test(pathname)) {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return courseUserDetailPage(res, user, Number(pathname.split("/").pop()), notice);
  }
  if (/^\/course\/users\/\d+\/update$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return updateCourseUser(req, res, user, Number(pathname.split("/")[3]));
  }
  if (/^\/course\/users\/\d+\/delete$/.test(pathname) && req.method === "POST") {
    if (!requireRole(res, user, ["CourseAdmin"])) return;
    return deleteCourseUser(res, user, Number(pathname.split("/")[3]));
  }

  return sendHtml(res, pageLayout("未找到", '<section class="card">页面不存在。</section>', user, notice), {}, 404);
}

initDb();
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    fs.writeFileSync(path.join(BASE_DIR, "server-error.log"), `${nowStr()} ${error.stack}\n`, { flag: "a" });
    sendHtml(res, getCurrentUser(req).then((user) =>
      pageLayout("错误", `<section class="card"><h2>服务异常</h2><pre>${escapeHtml(error.stack)}</pre></section>`, user)
    ), {}, 500);
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`TA system MVP running at http://${HOST}:${PORT}`);
    if (DB_CLIENT === "mysql") {
      console.log("[db] 默认数据库：MySQL。当前主流程、管理主链、报表、审计与导入已切换到 MySQL。");
      console.log("[db] 如需临时回退 SQLite，可在启动前显式设置 DB_CLIENT=sqlite。");
    } else {
      console.log("[db] 当前显式使用 SQLite 兼容模式运行。");
    }
  });
}

module.exports = { initDb, handleRequest, server };
