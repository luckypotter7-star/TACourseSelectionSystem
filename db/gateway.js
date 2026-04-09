const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { DB_PATH, DB_CLIENT } = require("../config/runtime");
const mysqlDb = require("./mysql");
const path = require("path");
const { UPLOAD_DIR } = require("../config/runtime");

function getSqliteDb() {
  return new DatabaseSync(DB_PATH);
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

function addHours(date, hours) {
  const next = new Date(date);
  next.setHours(next.getHours() + hours);
  return next;
}

function formatDateTime(date) {
  const pad = (v) => String(v).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function normalizeDisplayDate(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDateTime(value).slice(0, 10);
  }
  const raw = String(value).trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return formatDateTime(parsed).slice(0, 10);
  }
  return raw.slice(0, 10);
}

function isClassOpenForApply(classRow) {
  if (!classRow || classRow.ta_applications_allowed !== "Y") return false;
  if (!classRow.apply_start_at || !classRow.apply_end_at) return false;
  const now = nowMinuteStr();
  return comparableDateTimeValue(classRow.apply_start_at) <= now && now <= comparableDateTimeValue(classRow.apply_end_at);
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

function hasTimeConflict(aStart, aEnd, bStart, bEnd) {
  return !(aEnd <= bStart || bEnd <= aStart);
}

function buildSchedulesByClass(scheduleRows) {
  const map = new Map();
  for (const row of scheduleRows) {
    if (!map.has(row.class_id)) map.set(row.class_id, []);
    map.get(row.class_id).push(row);
  }
  return map;
}

function buildClassMetaById(rows) {
  return new Map(rows.map((row) => [row.class_id, row]));
}

function getBlockingConflicts(applications, classMetaById, schedulesByClass, classId) {
  const target = schedulesByClass.get(classId) || [];
  const results = [];
  for (const app of applications) {
    if (["RejectedByTAAdmin", "RejectedByProfessor", "Withdrawn"].includes(app.status)) continue;
    if (app.class_id === classId) continue;
    const existing = schedulesByClass.get(app.class_id) || [];
    const matches = [];
    for (const t of target) {
      for (const e of existing) {
        if (normalizeDisplayDate(t.lesson_date) === normalizeDisplayDate(e.lesson_date) && hasTimeConflict(t.start_time, t.end_time, e.start_time, e.end_time)) {
          matches.push(`${normalizeDisplayDate(t.lesson_date)} ${t.start_time}-${t.end_time} vs ${e.start_time}-${e.end_time}`);
        }
      }
    }
    if (matches.length) {
      results.push({
        ...app,
        is_conflict_allowed: classMetaById.get(app.class_id)?.is_conflict_allowed || "N",
        matches
      });
    }
  }
  return results;
}

async function getTaClassesSnapshot(taUserId) {
  if (DB_CLIENT === "mysql") {
    const classes = await mysqlDb.query(`
      select c.*,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingTAAdmin') as pending_taadmin_count
      from classes c
      where c.ta_applications_allowed = 'Y'
      order by c.semester, c.course_name, c.class_name
    `);
    const applications = await mysqlDb.query(`
      select *
      from applications
      where applier_user_id = ?
      order by submitted_at desc, application_id desc
    `, [taUserId]);
    const classIds = Array.from(new Set([
      ...classes.map((row) => row.class_id),
      ...applications.map((row) => row.class_id)
    ]));
    let classMeta = [];
    let schedules = [];
    if (classIds.length) {
      const placeholders = classIds.map(() => "?").join(",");
      classMeta = await mysqlDb.query(
        `select class_id, class_code, class_name, course_name, teacher_name, is_conflict_allowed from classes where class_id in (${placeholders})`,
        classIds
      );
      schedules = await mysqlDb.query(
        `select * from class_schedules where class_id in (${placeholders}) order by lesson_date, start_time`,
        classIds
      );
    }
    return { classes, applications, classMeta, schedules };
  }
  const db = getSqliteDb();
  try {
    const classes = db.prepare(`
      select c.*,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingTAAdmin') as pending_taadmin_count
      from classes c
      where c.ta_applications_allowed = 'Y'
      order by c.semester, c.course_name, c.class_name
    `).all();
    const applications = db.prepare(`
      select *
      from applications
      where applier_user_id = ?
      order by submitted_at desc, application_id desc
    `).all(taUserId);
    const classIds = Array.from(new Set([
      ...classes.map((row) => row.class_id),
      ...applications.map((row) => row.class_id)
    ]));
    const classMeta = [];
    const schedules = [];
    const getClass = db.prepare("select class_id, class_code, class_name, course_name, teacher_name, is_conflict_allowed from classes where class_id = ?");
    const getSchedules = db.prepare("select * from class_schedules where class_id = ? order by lesson_date, start_time");
    for (const classId of classIds) {
      const row = getClass.get(classId);
      if (row) classMeta.push(row);
      schedules.push(...getSchedules.all(classId));
    }
    return { classes, applications, classMeta, schedules };
  } finally {
    db.close();
  }
}

async function createTaApplication(user, classId, reason, submittedAt) {
  if (DB_CLIENT !== "mysql") {
    throw new Error("createTaApplication currently supports mysql runtime only");
  }
  return mysqlDb.withTransaction(async (conn) => {
    if (user.is_allowed_to_apply !== "Y") {
      return { ok: false, redirect: "/ta/classes?notice=当前 TA 不允许申请" };
    }
    const [classRows] = await conn.execute("select * from classes where class_id = ?", [classId]);
    const classRow = classRows[0];
    if (!classRow || !isClassOpenForApply(classRow)) {
      return { ok: false, redirect: "/ta/classes?notice=教学班当前未开放申请，或不在申请时间内" };
    }
    const [existsRows] = await conn.execute(`
      select 1
      from applications
      where applier_user_id = ?
        and class_id = ?
        and status not in ('Withdrawn', 'RejectedByTAAdmin', 'RejectedByProfessor')
      limit 1
    `, [user.user_id, classId]);
    if (existsRows.length) {
      return { ok: false, redirect: `/ta/classes/${classId}?notice=不可重复申请` };
    }
    if (!user.resume_name || !user.resume_path) {
      return { ok: false, redirect: "/ta/profile?notice=请先上传个人简历后再申请" };
    }

    const [applications] = await conn.execute(`
      select *
      from applications
      where applier_user_id = ?
      order by submitted_at desc, application_id desc
    `, [user.user_id]);
    const relatedClassIds = Array.from(new Set([
      classId,
      ...applications.map((row) => row.class_id)
    ]));
    const placeholders = relatedClassIds.map(() => "?").join(",");
    const [classMeta] = relatedClassIds.length
      ? await conn.execute(
          `select class_id, class_code, class_name, course_name, teacher_name, is_conflict_allowed from classes where class_id in (${placeholders})`,
          relatedClassIds
        )
      : [[]];
    const [scheduleRows] = relatedClassIds.length
      ? await conn.execute(
          `select * from class_schedules where class_id in (${placeholders}) order by lesson_date, start_time`,
          relatedClassIds
        )
      : [[]];
    const classMetaById = buildClassMetaById(classMeta);
    const schedulesByClass = buildSchedulesByClass(scheduleRows);
    const conflicts = getBlockingConflicts(applications, classMetaById, schedulesByClass, classId);
    if (conflicts.length && classRow.is_conflict_allowed !== "Y") {
      return { ok: false, redirect: `/ta/classes/${classId}?notice=存在时间冲突，无法申请` };
    }

    const [insertResult] = await conn.execute(`
      insert into applications (
        applier_user_id, applier_name, class_id, class_name, teacher_user_id,
        teacher_name, application_reason, resume_name, resume_path, status, submitted_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PendingTAAdmin', ?)
    `, [
      user.user_id,
      user.user_name,
      classRow.class_id,
      classRow.class_name,
      classRow.teacher_user_id,
      classRow.teacher_name,
      reason,
      user.resume_name,
      user.resume_path,
      submittedAt
    ]);
    const applicationId = insertResult.insertId;
    await conn.execute("update classes set published_to_professor = 'N', professor_notified_at = null where class_id = ?", [classId]);

    const [taAdmins] = await conn.execute("select user_id, user_name, email from users where role = 'TAAdmin'");
    for (const admin of taAdmins) {
      await conn.execute(`
        insert into notifications (user_id, title, content, target_path, is_read, created_at)
        values (?, ?, ?, ?, 'N', ?)
      `, [
        admin.user_id,
        "有新的 TA 待初审申请",
        `${user.user_name} 提交了《${classRow.class_name}》的 TA 申请，请尽快初审。`,
        `/admin/ta/pending/${applicationId}`,
        submittedAt
      ]);
    }
    await conn.execute(`
      insert into audit_logs (
        actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      user.user_id,
      user.user_name,
      user.role,
      "TA_APPLY",
      "Application",
      String(applicationId),
      `${classRow.course_name} / ${classRow.class_name}`,
      `申请人：${user.user_name}\n教学班：${classRow.class_name}\n教授：${classRow.teacher_name}${reason ? `\n申请原因：${reason}` : ""}`,
      submittedAt
    ]);

    return {
      ok: true,
      applicationId,
      classRow,
      taAdmins
    };
  });
}

async function getApplicationAuditRows(applicationId) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.query(`
      select created_at, actor_name, actor_role, action_type, target_name, details
      from audit_logs
      where target_type = 'Application'
        and target_id = ?
      order by created_at, audit_log_id
    `, [String(applicationId)]);
  }
  const db = getSqliteDb();
  try {
    return db.prepare(`
      select created_at, actor_name, actor_role, action_type, target_name, details
      from audit_logs
      where target_type = 'Application'
        and target_id = ?
      order by created_at, audit_log_id
    `).all(String(applicationId));
  } finally {
    db.close();
  }
}

async function getApplicationConflicts(applierUserId, classId) {
  if (DB_CLIENT === "mysql") {
    const [applications, classMeta, schedules] = await Promise.all([
      mysqlDb.query(`
        select *
        from applications
        where applier_user_id = ?
        order by submitted_at desc, application_id desc
      `, [applierUserId]),
      mysqlDb.query("select class_id, class_code, class_name, course_name, teacher_name, is_conflict_allowed from classes"),
      mysqlDb.query("select * from class_schedules order by lesson_date, start_time")
    ]);
    return getBlockingConflicts(applications, buildClassMetaById(classMeta), buildSchedulesByClass(schedules), classId);
  }
  const db = getSqliteDb();
  try {
    const applications = db.prepare(`
      select *
      from applications
      where applier_user_id = ?
      order by submitted_at desc, application_id desc
    `).all(applierUserId);
    const classMeta = db.prepare("select class_id, class_code, class_name, course_name, teacher_name, is_conflict_allowed from classes").all();
    const schedules = db.prepare("select * from class_schedules order by lesson_date, start_time").all();
    return getBlockingConflicts(applications, buildClassMetaById(classMeta), buildSchedulesByClass(schedules), classId);
  } finally {
    db.close();
  }
}

async function updateTaResume(userId, resumeName, resumePath) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      const [currentRows] = await conn.execute("select resume_path from users where user_id = ?", [userId]);
      const current = currentRows[0] || null;
      await conn.execute("update users set resume_name = ?, resume_path = ? where user_id = ?", [resumeName, resumePath, userId]);
      await conn.execute("update applications set resume_name = ?, resume_path = ? where applier_user_id = ?", [resumeName, resumePath, userId]);
      return { previousResumePath: current?.resume_path || "" };
    });
  }
  const db = getSqliteDb();
  try {
    const current = db.prepare("select resume_path from users where user_id = ?").get(userId);
    db.prepare("update users set resume_name = ?, resume_path = ? where user_id = ?").run(resumeName, resumePath, userId);
    db.prepare("update applications set resume_name = ?, resume_path = ? where applier_user_id = ?").run(resumeName, resumePath, userId);
    return { previousResumePath: current?.resume_path || "" };
  } finally {
    db.close();
  }
}

async function getTaAdminPendingApplications(filters = {}) {
  const studentFilter = String(filters.applier_name || "").trim().toLowerCase();
  const classFilter = String(filters.class_name || "").trim().toLowerCase();
  const teacherFilter = String(filters.teacher_name || "").trim().toLowerCase();
  if (DB_CLIENT === "mysql") {
    const rows = await mysqlDb.query("select * from applications where status = 'PendingTAAdmin' order by submitted_at");
    return rows
      .filter((app) => !studentFilter || String(app.applier_name || "").toLowerCase().includes(studentFilter))
      .filter((app) => !classFilter || String(app.class_name || "").toLowerCase().includes(classFilter))
      .filter((app) => !teacherFilter || String(app.teacher_name || "").toLowerCase().includes(teacherFilter));
  }
  const db = getSqliteDb();
  try {
    return db.prepare("select * from applications where status = 'PendingTAAdmin' order by submitted_at").all()
      .filter((app) => !studentFilter || String(app.applier_name || "").toLowerCase().includes(studentFilter))
      .filter((app) => !classFilter || String(app.class_name || "").toLowerCase().includes(classFilter))
      .filter((app) => !teacherFilter || String(app.teacher_name || "").toLowerCase().includes(teacherFilter));
  } finally {
    db.close();
  }
}

async function getApplicationById(applicationId) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.one("select * from applications where application_id = ?", [applicationId]);
  }
  const db = getSqliteDb();
  try {
    return db.prepare("select * from applications where application_id = ?").get(applicationId) ?? null;
  } finally {
    db.close();
  }
}

async function getApplicantById(userId) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.one("select user_id, user_name, email from users where user_id = ?", [userId]);
  }
  const db = getSqliteDb();
  try {
    return db.prepare("select user_id, user_name, email from users where user_id = ?").get(userId) ?? null;
  } finally {
    db.close();
  }
}

async function applyTaAdminDecision(approver, applicationId, result, comments, actedAt) {
  if (DB_CLIENT !== "mysql") {
    throw new Error("applyTaAdminDecision currently supports mysql runtime only");
  }
  return mysqlDb.withTransaction(async (conn) => {
    const [appRows] = await conn.execute("select * from applications where application_id = ? for update", [applicationId]);
    const app = appRows[0];
    if (!app || app.status !== "PendingTAAdmin") {
      return { ok: false, notice: "申请已被处理" };
    }
    const nextStatus = result === "Approved" ? "PendingProfessor" : "RejectedByTAAdmin";
    await conn.execute(`
      update applications
      set status = ?, ta_comment = ?, ta_acted_at = ?
      where application_id = ? and status = 'PendingTAAdmin'
    `, [nextStatus, comments, actedAt, app.application_id]);
    await conn.execute(`
      insert into approval_logs (application_id, approval_stage, approver_user_id, approver_name, result, comments, acted_at)
      values (?, 'TAAdmin', ?, ?, ?, ?, ?)
    `, [app.application_id, approver.user_id, approver.user_name, result, comments, actedAt]);
    await conn.execute(`
      insert into audit_logs (
        actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      approver.user_id,
      approver.user_name,
      approver.role,
      result === "Approved" ? "TAADMIN_APPROVE" : "TAADMIN_REJECT",
      "Application",
      String(app.application_id),
      app.class_name,
      `申请人：${app.applier_name}\n审批结果：${result === "Approved" ? "通过" : "拒绝"}\n新状态：${nextStatus}${comments ? `\n备注：${comments}` : ""}`,
      actedAt
    ]);
    await conn.execute(`
      insert into notifications (user_id, title, content, target_path, is_read, created_at)
      values (?, ?, ?, ?, 'N', ?)
    `, [
      app.applier_user_id,
      result === "Approved" ? "TA 预审通过" : "TA 审批未通过",
      result === "Approved"
        ? `你的申请《${app.class_name}》已通过 TAAdmin 预审，待发布给 Professor 后进入最终审核。`
        : `你的申请《${app.class_name}》被 TAAdmin 拒绝。`,
      `/ta/applications/${app.application_id}`,
      actedAt
    ]);
    const [applicantRows] = await conn.execute("select user_id, user_name, email from users where user_id = ?", [app.applier_user_id]);
    return {
      ok: true,
      app: { ...app, status: nextStatus, ta_comment: comments, ta_acted_at: actedAt },
      applicant: applicantRows[0] || null
    };
  });
}

async function batchApplyTaAdminDecision(approver, applicationIds, result, comments, actedAt) {
  if (DB_CLIENT !== "mysql") {
    throw new Error("batchApplyTaAdminDecision currently supports mysql runtime only");
  }
  return mysqlDb.withTransaction(async (conn) => {
    let processed = 0;
    let skipped = 0;
    const emailPayloads = [];
    for (const applicationId of applicationIds) {
      const [appRows] = await conn.execute("select * from applications where application_id = ? for update", [applicationId]);
      const app = appRows[0];
      if (!app || app.status !== "PendingTAAdmin") {
        skipped += 1;
        continue;
      }
      const nextStatus = result === "Approved" ? "PendingProfessor" : "RejectedByTAAdmin";
      await conn.execute(`
        update applications
        set status = ?, ta_comment = ?, ta_acted_at = ?
        where application_id = ? and status = 'PendingTAAdmin'
      `, [nextStatus, comments, actedAt, app.application_id]);
      await conn.execute(`
        insert into approval_logs (application_id, approval_stage, approver_user_id, approver_name, result, comments, acted_at)
        values (?, 'TAAdmin', ?, ?, ?, ?, ?)
      `, [app.application_id, approver.user_id, approver.user_name, result, comments, actedAt]);
      await conn.execute(`
        insert into audit_logs (
          actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        approver.user_id,
        approver.user_name,
        approver.role,
        result === "Approved" ? "TAADMIN_APPROVE" : "TAADMIN_REJECT",
        "Application",
        String(app.application_id),
        app.class_name,
        `申请人：${app.applier_name}\n审批结果：${result === "Approved" ? "通过" : "拒绝"}\n新状态：${nextStatus}${comments ? `\n备注：${comments}` : ""}`,
        actedAt
      ]);
      await conn.execute(`
        insert into notifications (user_id, title, content, target_path, is_read, created_at)
        values (?, ?, ?, ?, 'N', ?)
      `, [
        app.applier_user_id,
        result === "Approved" ? "TA 预审通过" : "TA 审批未通过",
        result === "Approved"
          ? `你的申请《${app.class_name}》已通过 TAAdmin 预审，待发布给 Professor 后进入最终审核。`
          : `你的申请《${app.class_name}》被 TAAdmin 拒绝。`,
        `/ta/applications/${app.application_id}`,
        actedAt
      ]);
      const [applicantRows] = await conn.execute("select user_id, user_name, email from users where user_id = ?", [app.applier_user_id]);
      emailPayloads.push({
        app: { ...app, status: nextStatus, ta_comment: comments, ta_acted_at: actedAt },
        applicant: applicantRows[0] || null
      });
      processed += 1;
    }
    return { ok: true, processed, skipped, emailPayloads };
  });
}

async function appendAuditLog({ actor = null, actionType, targetType, targetId = "", targetName = "", details = "", createdAt }) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.execute(`
      insert into audit_logs (
        actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      actor?.user_id ?? null,
      actor?.user_name ?? "系统",
      actor?.role ?? "System",
      actionType,
      targetType,
      String(targetId || ""),
      String(targetName || ""),
      String(details || ""),
      createdAt || nowMinuteStr() + ":00"
    ]);
  }
  const db = getSqliteDb();
  try {
    return db.prepare(`
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
      createdAt || nowMinuteStr() + ":00"
    );
  } finally {
    db.close();
  }
}

async function findUserByLoginAndPassword(loginName, password) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.one(
      "select * from users where login_name = ? and password = ?",
      [String(loginName || ""), String(password || "")]
    );
  }
  const db = getSqliteDb();
  try {
    return db.prepare("select * from users where login_name = ? and password = ?").get(String(loginName || ""), String(password || "")) ?? null;
  } finally {
    db.close();
  }
}

async function findUserById(userId) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.one("select * from users where user_id = ?", [userId]);
  }
  const db = getSqliteDb();
  try {
    return db.prepare("select * from users where user_id = ?").get(userId) ?? null;
  } finally {
    db.close();
  }
}

async function findUserByLoginName(loginName) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.one("select * from users where login_name = ?", [String(loginName || "")]);
  }
  const db = getSqliteDb();
  try {
    return db.prepare("select * from users where login_name = ?").get(String(loginName || "")) ?? null;
  } finally {
    db.close();
  }
}

async function findUnusedLoginToken(token) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.one("select * from login_tokens where token = ? and used_at is null", [token]);
  }
  const db = getSqliteDb();
  try {
    return db.prepare("select * from login_tokens where token = ? and used_at is null").get(token) ?? null;
  } finally {
    db.close();
  }
}

async function markLoginTokenUsed(token, usedAt) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.execute("update login_tokens set used_at = ? where token = ?", [usedAt, token]);
  }
  const db = getSqliteDb();
  try {
    return db.prepare("update login_tokens set used_at = ? where token = ?").run(usedAt, token);
  } finally {
    db.close();
  }
}

async function unreadNotificationCountByUser(userId) {
  if (DB_CLIENT === "mysql") {
    const row = await mysqlDb.one(
      "select count(*) as count from notifications where user_id = ? and is_read = 'N'",
      [userId]
    );
    return Number(row?.count || 0);
  }
  const db = getSqliteDb();
  try {
    const row = db.prepare("select count(*) as count from notifications where user_id = ? and is_read = 'N'").get(userId);
    return Number(row?.count || 0);
  } finally {
    db.close();
  }
}

async function getNotificationsByUser(userId) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.query(
      "select * from notifications where user_id = ? order by created_at desc, notification_id desc",
      [userId]
    );
  }
  const db = getSqliteDb();
  try {
    return db.prepare("select * from notifications where user_id = ? order by created_at desc, notification_id desc").all(userId);
  } finally {
    db.close();
  }
}

async function markNotificationReadById(notificationId, userId) {
  if (DB_CLIENT === "mysql") {
    await mysqlDb.execute(
      "update notifications set is_read = 'Y' where notification_id = ? and user_id = ?",
      [notificationId, userId]
    );
    return;
  }
  const db = getSqliteDb();
  try {
    db.prepare("update notifications set is_read = 'Y' where notification_id = ? and user_id = ?").run(notificationId, userId);
  } finally {
    db.close();
  }
}

async function getProfessorPendingClassRows(professorUserId) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.query(`
      select c.*,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingProfessor') as pending_count,
        (select count(*) from applications a where a.class_id = c.class_id) as application_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count
      from classes c
      where find_in_set(?, c.teacher_user_id)
        and c.published_to_professor = 'Y'
        and exists (
          select 1 from applications a
          where a.class_id = c.class_id and a.status = 'PendingProfessor'
        )
      order by c.semester, c.course_name, c.class_name
    `, [String(professorUserId)]);
  }
  const db = getSqliteDb();
  try {
    return db.prepare(`
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
    `).all(String(professorUserId));
  } finally {
    db.close();
  }
}

async function getAllApplications() {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.query("select * from applications order by submitted_at desc, application_id desc");
  }
  const db = getSqliteDb();
  try {
    return db.prepare("select * from applications order by submitted_at desc, application_id desc").all();
  } finally {
    db.close();
  }
}

async function getTaUsersManagementRows() {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.query(`
      select u.*,
        (select count(*) from applications a where a.applier_user_id = u.user_id) as application_count,
        (select count(*) from applications a where a.applier_user_id = u.user_id and a.status = 'Approved') as approved_count
      from users u
      where u.role = 'TA'
      order by u.user_name, u.user_id
    `);
  }
  const db = getSqliteDb();
  try {
    return db.prepare(`
      select u.*,
        (select count(*) from applications a where a.applier_user_id = u.user_id) as application_count,
        (select count(*) from applications a where a.applier_user_id = u.user_id and a.status = 'Approved') as approved_count
      from users u
      where u.role = 'TA'
      order by u.user_name, u.user_id
    `).all();
  } finally {
    db.close();
  }
}

async function toggleTaUserApplyQualification(actor, userId) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      const [rows] = await conn.execute("select * from users where user_id = ? and role = 'TA'", [userId]);
      const row = rows[0] || null;
      if (!row) return { ok: false, notice: "TA 不存在" };
      const nextValue = row.is_allowed_to_apply === "Y" ? "N" : "Y";
      await conn.execute("update users set is_allowed_to_apply = ? where user_id = ?", [nextValue, userId]);
      await conn.execute(`
        insert into audit_logs (
          actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        actor.user_id,
        actor.user_name,
        actor.role,
        "TA_TOGGLE_APPLY_QUALIFICATION",
        "User",
        String(userId),
        row.user_name,
        `登录名：${row.login_name}\n新允许申请状态：${nextValue}`,
        nowMinuteStr() + ":00"
      ]);
      return { ok: true, notice: "TA 资格已更新" };
    });
  }
  const db = getSqliteDb();
  try {
    const row = db.prepare("select * from users where user_id = ? and role = 'TA'").get(userId);
    if (!row) return { ok: false, notice: "TA 不存在" };
    const nextValue = row.is_allowed_to_apply === "Y" ? "N" : "Y";
    db.prepare("update users set is_allowed_to_apply = ? where user_id = ?").run(nextValue, userId);
    db.prepare(`
      insert into audit_logs (
        actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actor.user_id,
      actor.user_name,
      actor.role,
      "TA_TOGGLE_APPLY_QUALIFICATION",
      "User",
      String(userId),
      row.user_name,
      `登录名：${row.login_name}\n新允许申请状态：${nextValue}`,
      nowMinuteStr() + ":00"
    );
    return { ok: true, notice: "TA 资格已更新" };
  } finally {
    db.close();
  }
}

async function getTaApplications(applierUserId) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.query(
      `select a.*, c.credit as class_credit
       from applications a
       left join classes c on c.class_id = a.class_id
       where a.applier_user_id = ?
       order by a.submitted_at desc, a.application_id desc`,
      [applierUserId]
    );
  }
  const db = getSqliteDb();
  try {
    return db.prepare(`
      select a.*, c.credit as class_credit
      from applications a
      left join classes c on c.class_id = a.class_id
      where a.applier_user_id = ?
      order by a.submitted_at desc, a.application_id desc
    `).all(applierUserId);
  } finally {
    db.close();
  }
}

async function getTaApplicationDetail(applicationId, applierUserId) {
  if (DB_CLIENT === "mysql") {
    const [app, logs, auditRows] = await Promise.all([
      mysqlDb.one("select * from applications where application_id = ? and applier_user_id = ?", [applicationId, applierUserId]),
      mysqlDb.query("select * from approval_logs where application_id = ? order by acted_at, approval_log_id", [applicationId]),
      getApplicationAuditRows(applicationId)
    ]);
    return { app, logs, auditRows };
  }
  const db = getSqliteDb();
  try {
    const app = db.prepare("select * from applications where application_id = ? and applier_user_id = ?").get(applicationId, applierUserId) ?? null;
    const logs = app ? db.prepare("select * from approval_logs where application_id = ? order by acted_at, approval_log_id").all(applicationId) : [];
    const auditRows = app ? db.prepare(`
      select created_at, actor_name, actor_role, action_type, target_name, details
      from audit_logs
      where target_type = 'Application' and target_id = ?
      order by created_at, audit_log_id
    `).all(String(applicationId)) : [];
    return { app, logs, auditRows };
  } finally {
    db.close();
  }
}

async function withdrawTaApplication(user, applicationId) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      const [rows] = await conn.execute(
        "select * from applications where application_id = ? and applier_user_id = ?",
        [applicationId, user.user_id]
      );
      const app = rows[0] || null;
      if (!app) {
        return { ok: false, notice: "申请不存在" };
      }
      if (app.status !== "PendingTAAdmin") {
        return { ok: false, notice: "当前状态不可撤销" };
      }
      await conn.execute("update applications set status = 'Withdrawn' where application_id = ?", [applicationId]);
      await conn.execute(`
        insert into audit_logs (
          actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        user.user_id,
        user.user_name,
        user.role,
        "TA_WITHDRAW",
        "Application",
        String(applicationId),
        app.class_name,
        `申请人：${app.applier_name}\n原状态：${app.status}\n操作结果：已撤销`,
        nowMinuteStr() + ":00"
      ]);
      return { ok: true };
    });
  }
  const db = getSqliteDb();
  try {
    const app = db.prepare("select * from applications where application_id = ? and applier_user_id = ?").get(applicationId, user.user_id);
    if (!app) return { ok: false, notice: "申请不存在" };
    if (app.status !== "PendingTAAdmin") return { ok: false, notice: "当前状态不可撤销" };
    db.prepare("update applications set status = 'Withdrawn' where application_id = ?").run(applicationId);
    db.prepare(`
      insert into audit_logs (
        actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.user_id,
      user.user_name,
      user.role,
      "TA_WITHDRAW",
      "Application",
      String(applicationId),
      app.class_name,
      `申请人：${app.applier_name}\n原状态：${app.status}\n操作结果：已撤销`,
      nowMinuteStr() + ":00"
    );
    return { ok: true };
  } finally {
    db.close();
  }
}

async function getCourseAdminClassRows(filters = {}) {
  const classCodeFilter = String(filters.class_code || "").trim().toLowerCase();
  const classNameFilter = String(filters.class_name || "").trim().toLowerCase();
  const teacherFilter = String(filters.teacher_name || "").trim().toLowerCase();
  const statusFilter = String(filters.status_filter || "").trim();
  const taFullFilter = String(filters.ta_full || "").trim();
  const sortBy = String(filters.sort_by || "class_code");
  const sortOrder = String(filters.sort_order || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  const sortValueMap = {
    class_code: (row) => String(row.class_code || "").toLowerCase(),
    class_name: (row) => String(row.class_name || "").toLowerCase(),
    teacher_name: (row) => String(row.teacher_name || "").toLowerCase(),
    ta_full: (row) => (Number(row.approved_count || 0) >= Number(row.maximum_number_of_tas_admitted || 0) ? 1 : 0),
    status_filter: (row) => String(classOpenStatus(row)),
    approved_count: (row) => Number(row.approved_count || 0),
    application_count: (row) => Number(row.application_count || 0)
  };

  if (DB_CLIENT === "mysql") {
    const rowsRaw = await mysqlDb.query(`
      select c.*,
        (select count(*) from applications a where a.class_id = c.class_id) as application_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingTAAdmin') as pending_taadmin_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingProfessor') as pending_professor_count,
        (
          select group_concat(a.applier_name separator '；')
          from applications a
          where a.class_id = c.class_id and a.status = 'Approved'
        ) as approved_ta_names
      from classes c
    `);
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

  const db = getSqliteDb();
  try {
    const rowsRaw = db.prepare(`
      select c.*,
        (select count(*) from applications a where a.class_id = c.class_id) as application_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingTAAdmin') as pending_taadmin_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingProfessor') as pending_professor_count,
        (select group_concat(a.applier_name, '；') from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_ta_names
      from classes c
    `).all();
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
  } finally {
    db.close();
  }
}

async function getTaAdminClassRows(filters = {}) {
  const professorFilter = String(filters.professor_name || "").trim().toLowerCase();
  const classNameFilter = String(filters.class_name || "").trim().toLowerCase();
  const taFullFilter = String(filters.ta_full || "").trim();
  const hasPendingFilter = String(filters.has_pending || "").trim();

  if (DB_CLIENT === "mysql") {
    const rowsRaw = await mysqlDb.query(`
      select c.*,
        (select count(*) from applications a where a.class_id = c.class_id) as application_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingTAAdmin') as pending_taadmin_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingProfessor') as pending_professor_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count,
        (
          select group_concat(a.applier_name separator '；')
          from applications a
          where a.class_id = c.class_id and a.status = 'Approved'
        ) as approved_ta_names
      from classes c
      order by c.semester, c.course_name, c.class_name
    `);
    for (const row of rowsRaw) {
      if (row.published_to_professor === "Y") {
        row.ta_applications_allowed = "N";
      }
      if (Number(row.approved_count || 0) >= Number(row.maximum_number_of_tas_admitted || 0) && row.ta_applications_allowed !== "N") {
        row.ta_applications_allowed = "N";
      }
    }
    return rowsRaw.filter((row) => {
      const matchesProfessor = !professorFilter || String(row.teacher_name || "").toLowerCase().includes(professorFilter);
      const matchesClassName = !classNameFilter || String(row.class_name || "").toLowerCase().includes(classNameFilter);
      const isFull = Number(row.approved_count || 0) >= Number(row.maximum_number_of_tas_admitted || 0);
      const matchesTaFull = !taFullFilter || (taFullFilter === "Y" ? isFull : !isFull);
      const hasPending = Number(row.pending_taadmin_count || 0) > 0;
      const matchesPending = !hasPendingFilter || (hasPendingFilter === "Y" ? hasPending : !hasPending);
      return matchesProfessor && matchesClassName && matchesTaFull && matchesPending;
    });
  }

  const db = getSqliteDb();
  try {
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
      if (row.published_to_professor === "Y") {
        row.ta_applications_allowed = "N";
      }
      if (Number(row.approved_count || 0) >= Number(row.maximum_number_of_tas_admitted || 0) && row.ta_applications_allowed !== "N") {
        row.ta_applications_allowed = "N";
      }
    }
    return rowsRaw.filter((row) => {
      const matchesProfessor = !professorFilter || String(row.teacher_name || "").toLowerCase().includes(professorFilter);
      const matchesClassName = !classNameFilter || String(row.class_name || "").toLowerCase().includes(classNameFilter);
      const isFull = Number(row.approved_count || 0) >= Number(row.maximum_number_of_tas_admitted || 0);
      const matchesTaFull = !taFullFilter || (taFullFilter === "Y" ? isFull : !isFull);
      const hasPending = Number(row.pending_taadmin_count || 0) > 0;
      const matchesPending = !hasPendingFilter || (hasPendingFilter === "Y" ? hasPending : !hasPending);
      return matchesProfessor && matchesClassName && matchesTaFull && matchesPending;
    });
  } finally {
    db.close();
  }
}

async function getClassRowsByRefs(refs) {
  const cleanRefs = Array.from(new Set((refs || []).map((item) => String(item || "").trim()).filter(Boolean)));
  if (!cleanRefs.length) return [];
  if (DB_CLIENT === "mysql") {
    const rows = [];
    const seen = new Set();
    for (const ref of cleanRefs) {
      const numericId = Number(ref);
      const row = Number.isInteger(numericId) && numericId > 0
        ? await mysqlDb.one("select * from classes where class_id = ?", [numericId])
        : await mysqlDb.one("select * from classes where class_code = ?", [ref]);
      if (row && !seen.has(Number(row.class_id))) {
        rows.push(row);
        seen.add(Number(row.class_id));
      }
    }
    return rows;
  }
  const db = getSqliteDb();
  try {
    const selectById = db.prepare("select * from classes where class_id = ?");
    const selectByCode = db.prepare("select * from classes where class_code = ?");
    const rows = [];
    const seen = new Set();
    for (const ref of cleanRefs) {
      const numericId = Number(ref);
      const row = Number.isInteger(numericId) && numericId > 0 ? selectById.get(numericId) : selectByCode.get(ref);
      if (row && !seen.has(Number(row.class_id))) {
        rows.push(row);
        seen.add(Number(row.class_id));
      }
    }
    return rows;
  } finally {
    db.close();
  }
}

async function createLoginTokenRecord(userId, targetPath) {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = formatDateTime(addHours(new Date(), 72));
  if (DB_CLIENT === "mysql") {
    await mysqlDb.execute(`
      insert into login_tokens (token, user_id, target_path, expires_at, used_at)
      values (?, ?, ?, ?, null)
    `, [token, userId, targetPath, expiresAt]);
    return token;
  }
  const db = getSqliteDb();
  try {
    db.prepare(`
      insert into login_tokens (token, user_id, target_path, expires_at, used_at)
      values (?, ?, ?, ?, null)
    `).run(token, userId, targetPath, expiresAt);
    return token;
  } finally {
    db.close();
  }
}

async function updateProfessorPublishStatus(actor, classRows, nextValue, actedAt) {
  const rows = Array.isArray(classRows) ? classRows : [];
  if (!rows.length) return 0;
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      for (const row of rows) {
        await conn.execute(
          "update classes set published_to_professor = ?, professor_notified_at = ?, ta_applications_allowed = case when ? = 'Y' then 'N' else ta_applications_allowed end where class_id = ?",
          [nextValue, nextValue === "Y" ? actedAt : null, nextValue, row.class_id]
        );
        await conn.execute(`
          insert into audit_logs (
            actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
          ) values (?, ?, ?, 'CLASS_PUBLISH_STATUS_UPDATE', 'Class', ?, ?, ?, ?)
        `, [
          actor?.user_id ?? null,
          actor?.user_name ?? "系统",
          actor?.role ?? "System",
          String(row.class_id),
          `${row.course_name} / ${row.class_name}`,
          `教学班代码：${row.class_code}\n新发布状态：${nextValue === "Y" ? "已发送" : "未发送"}`,
          actedAt
        ]);
      }
      return rows.length;
    });
  }
  const db = getSqliteDb();
  try {
    const updateStmt = db.prepare("update classes set published_to_professor = ?, professor_notified_at = ?, ta_applications_allowed = case when ? = 'Y' then 'N' else ta_applications_allowed end where class_id = ?");
    for (const row of rows) {
      updateStmt.run(nextValue, nextValue === "Y" ? actedAt : null, nextValue, row.class_id);
      db.prepare(`
        insert into audit_logs (
          actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
        ) values (?, ?, ?, 'CLASS_PUBLISH_STATUS_UPDATE', 'Class', ?, ?, ?, ?)
      `).run(
        actor?.user_id ?? null,
        actor?.user_name ?? "系统",
        actor?.role ?? "System",
        String(row.class_id),
        `${row.course_name} / ${row.class_name}`,
        `教学班代码：${row.class_code}\n新发布状态：${nextValue === "Y" ? "已发送" : "未发送"}`,
        actedAt
      );
    }
    return rows.length;
  } finally {
    db.close();
  }
}

async function markClassesPublishedToProfessor(actor, classRows, professorSummaries, actedAt) {
  const rows = Array.isArray(classRows) ? classRows : [];
  if (!rows.length) return 0;
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      for (const row of rows) {
        await conn.execute(
          "update classes set published_to_professor = 'Y', professor_notified_at = ?, ta_applications_allowed = 'N' where class_id = ?",
          [actedAt, row.class_id]
        );
        await conn.execute(`
          insert into audit_logs (
            actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
          ) values (?, ?, ?, 'CLASS_PUBLISH_TO_PROFESSOR', 'Class', ?, ?, ?, ?)
        `, [
          actor?.user_id ?? null,
          actor?.user_name ?? "系统",
          actor?.role ?? "System",
          String(row.class_id),
          `${row.course_name} / ${row.class_name}`,
          `教学班代码：${row.class_code}\n教授：${row.teacher_name}\n操作结果：已发送Professor提醒邮件并抄送TAAdmin`,
          actedAt
        ]);
      }
      for (const item of professorSummaries || []) {
        await conn.execute(`
          insert into notifications (user_id, title, content, target_path, is_read, created_at)
          values (?, 'TA申请待终审', ?, '/professor/pending', 'N', ?)
        `, [item.user_id, `以下教学班已由 TAAdmin 完成前置审核，并发布给你进行最终审核：${item.classSummary || "相关教学班"}。请进入系统完成审批。`, actedAt]);
      }
      return rows.length;
    });
  }
  const db = getSqliteDb();
  try {
    const updateStmt = db.prepare("update classes set published_to_professor = 'Y', professor_notified_at = ?, ta_applications_allowed = 'N' where class_id = ?");
    for (const row of rows) {
      updateStmt.run(actedAt, row.class_id);
      db.prepare(`
        insert into audit_logs (
          actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
        ) values (?, ?, ?, 'CLASS_PUBLISH_TO_PROFESSOR', 'Class', ?, ?, ?, ?)
      `).run(
        actor?.user_id ?? null,
        actor?.user_name ?? "系统",
        actor?.role ?? "System",
        String(row.class_id),
        `${row.course_name} / ${row.class_name}`,
        `教学班代码：${row.class_code}\n教授：${row.teacher_name}\n操作结果：已发送Professor提醒邮件并抄送TAAdmin`,
        actedAt
      );
    }
    for (const item of professorSummaries || []) {
      db.prepare(`
        insert into notifications (user_id, title, content, target_path, is_read, created_at)
        values (?, 'TA申请待终审', ?, '/professor/pending', 'N', ?)
      `).run(item.user_id, `以下教学班已由 TAAdmin 完成前置审核，并发布给你进行最终审核：${item.classSummary || "相关教学班"}。请进入系统完成审批。`, actedAt);
    }
    return rows.length;
  } finally {
    db.close();
  }
}

async function batchUpdateCourseClassConflict(actor, refs, isConflictAllowed) {
  const rows = await getClassRowsByRefs(refs);
  if (!rows.length) return { changed: 0, changedRows: [] };
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      for (const row of rows) {
        await conn.execute(`
          update classes
          set is_conflict_allowed = ?
          where class_id = ?
        `, [isConflictAllowed, row.class_id]);
        await conn.execute(`
          insert into audit_logs (
            actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
          ) values (?, ?, ?, 'CLASS_CONFLICT_TOGGLE', 'Class', ?, ?, ?, ?)
        `, [
          actor?.user_id ?? null,
          actor?.user_name ?? "系统",
          actor?.role ?? "System",
          String(row.class_id),
          `${row.course_name} / ${row.class_name}`,
          `教学班代码：${row.class_code}\n新允许冲突状态：${isConflictAllowed}`,
          nowMinuteStr()
        ]);
      }
      return { changed: rows.length, changedRows: rows };
    });
  }
  throw new Error("batchUpdateCourseClassConflict only supports mysql during migration");
}

async function getCourseUsers(filters = {}) {
  const roleFilter = String(filters.role || "").trim();
  const userNameFilter = String(filters.user_name || "").trim().toLowerCase();
  const loginNameFilter = String(filters.login_name || "").trim().toLowerCase();
  const emailFilter = String(filters.email || "").trim().toLowerCase();
  const taAllowedFilter = String(filters.is_allowed_to_apply || "").trim();
  const sortBy = String(filters.sort_by || "user_name");
  const sortOrder = String(filters.sort_order || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  const roleWeight = (role) => ({
    CourseAdmin: 1,
    TAAdmin: 2,
    Professor: 3,
    TA: 4
  }[role] || 9);
  const sortValueMap = {
    user_name: (row) => String(row.user_name || "").toLowerCase(),
    login_name: (row) => String(row.login_name || "").toLowerCase(),
    email: (row) => String(row.email || "").toLowerCase(),
    role: (row) => roleWeight(row.role),
    is_allowed_to_apply: (row) => String(row.is_allowed_to_apply || ""),
    application_count: (row) => Number(row.application_count || 0),
    class_count: (row) => Number(row.class_count || 0)
  };
  if (DB_CLIENT === "mysql") {
    const usersRaw = await mysqlDb.query(`
      select u.*,
        (select count(*) from applications a where a.applier_user_id = u.user_id) as application_count,
        (select count(*) from classes c where find_in_set(u.user_id, c.teacher_user_id)) as class_count
      from users u
    `);
    return usersRaw
      .filter((row) => !roleFilter || row.role === roleFilter)
      .filter((row) => !userNameFilter || String(row.user_name || "").toLowerCase().includes(userNameFilter))
      .filter((row) => !loginNameFilter || String(row.login_name || "").toLowerCase().includes(loginNameFilter))
      .filter((row) => !emailFilter || String(row.email || "").toLowerCase().includes(emailFilter))
      .filter((row) => !taAllowedFilter || String(row.is_allowed_to_apply || "") === taAllowedFilter)
      .sort((a, b) => {
        const getter = sortValueMap[sortBy] || sortValueMap.user_name;
        const av = getter(a);
        const bv = getter(b);
        if (av < bv) return sortOrder === "asc" ? -1 : 1;
        if (av > bv) return sortOrder === "asc" ? 1 : -1;
        return String(a.user_name || "").localeCompare(String(b.user_name || ""), "zh-Hans-CN");
      });
  }
  const db = getSqliteDb();
  try {
    const usersRaw = db.prepare(`
      select u.*,
        (select count(*) from applications a where a.applier_user_id = u.user_id) as application_count,
        (select count(*) from classes c where (',' || c.teacher_user_id || ',') like '%,' || u.user_id || ',%') as class_count
      from users u
    `).all();
    return usersRaw
      .filter((row) => !roleFilter || row.role === roleFilter)
      .filter((row) => !userNameFilter || String(row.user_name || "").toLowerCase().includes(userNameFilter))
      .filter((row) => !loginNameFilter || String(row.login_name || "").toLowerCase().includes(loginNameFilter))
      .filter((row) => !emailFilter || String(row.email || "").toLowerCase().includes(emailFilter))
      .filter((row) => !taAllowedFilter || String(row.is_allowed_to_apply || "") === taAllowedFilter)
      .sort((a, b) => {
        const getter = sortValueMap[sortBy] || sortValueMap.user_name;
        const av = getter(a);
        const bv = getter(b);
        if (av < bv) return sortOrder === "asc" ? -1 : 1;
        if (av > bv) return sortOrder === "asc" ? 1 : -1;
        return String(a.user_name || "").localeCompare(String(b.user_name || ""), "zh-Hans-CN");
      });
  } finally {
    db.close();
  }
}

async function getCourseUserDetail(userId) {
  if (DB_CLIENT === "mysql") {
    const target = await mysqlDb.one("select * from users where user_id = ?", [userId]);
    if (!target) return { target: null, classes: [], applications: [] };
    const [classes, applications] = await Promise.all([
      mysqlDb.query(`
        select class_code, class_name
        from classes
        where find_in_set(?, teacher_user_id)
        order by class_name
      `, [String(userId)]),
      mysqlDb.query(`
        select application_id, class_name, status
        from applications
        where applier_user_id = ?
        order by application_id desc
      `, [userId])
    ]);
    return { target, classes, applications };
  }
  const db = getSqliteDb();
  try {
    const target = db.prepare("select * from users where user_id = ?").get(userId);
    if (!target) return { target: null, classes: [], applications: [] };
    const classes = db.prepare("select class_code, class_name from classes where (',' || teacher_user_id || ',') like '%,' || ? || ',%' order by class_name").all(String(userId));
    const applications = db.prepare("select application_id, class_name, status from applications where applier_user_id = ? order by application_id desc").all(userId);
    return { target, classes, applications };
  } finally {
    db.close();
  }
}

async function getCourseReportSnapshot(filters = {}) {
  const semesterFilter = String(filters.semester || "").trim();
  const teacherFilter = String(filters.teacher_name || "").trim().toLowerCase();
  if (DB_CLIENT === "mysql") {
    const classes = await mysqlDb.query(`
      select c.*,
        (select count(*) from applications a where a.class_id = c.class_id) as application_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingTAAdmin') as pending_taadmin_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingProfessor') as pending_professor_count
      from classes c
      order by c.class_code
    `);
    const filteredClasses = classes
      .filter((row) => !semesterFilter || String(row.semester || "") === semesterFilter)
      .filter((row) => !teacherFilter || String(row.teacher_name || "").toLowerCase().includes(teacherFilter));
    const applications = await mysqlDb.query("select * from applications order by submitted_at desc, application_id desc");
    return { classes: filteredClasses, applications };
  }
  const db = getSqliteDb();
  try {
    const classes = db.prepare(`
      select c.*,
        (select count(*) from applications a where a.class_id = c.class_id) as application_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') as approved_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingTAAdmin') as pending_taadmin_count,
        (select count(*) from applications a where a.class_id = c.class_id and a.status = 'PendingProfessor') as pending_professor_count
      from classes c
      order by c.class_code
    `).all()
      .filter((row) => !semesterFilter || String(row.semester || "") === semesterFilter)
      .filter((row) => !teacherFilter || String(row.teacher_name || "").toLowerCase().includes(teacherFilter));
    const applications = db.prepare("select * from applications order by submitted_at desc, application_id desc").all();
    return { classes, applications };
  } finally {
    db.close();
  }
}

async function getAuditLogs(filters = {}) {
  const actionType = String(filters.action_type || "").trim();
  const actorName = String(filters.actor_name || "").trim().toLowerCase();
  const targetType = String(filters.target_type || "").trim();
  const keyword = String(filters.keyword || "").trim().toLowerCase();
  if (DB_CLIENT === "mysql") {
    const rows = await mysqlDb.query("select * from audit_logs order by created_at desc, audit_log_id desc");
    return rows
      .filter((row) => !actionType || row.action_type === actionType)
      .filter((row) => !targetType || row.target_type === targetType)
      .filter((row) => !actorName || String(row.actor_name || "").toLowerCase().includes(actorName))
      .filter((row) => !keyword || [row.target_name, row.details, row.target_id].some((value) => String(value || "").toLowerCase().includes(keyword)));
  }
  const db = getSqliteDb();
  try {
    const rows = db.prepare("select * from audit_logs order by created_at desc, audit_log_id desc").all();
    return rows
      .filter((row) => !actionType || row.action_type === actionType)
      .filter((row) => !targetType || row.target_type === targetType)
      .filter((row) => !actorName || String(row.actor_name || "").toLowerCase().includes(actorName))
      .filter((row) => !keyword || [row.target_name, row.details, row.target_id].some((value) => String(value || "").toLowerCase().includes(keyword)));
  } finally {
    db.close();
  }
}

async function createCourseUser(actor, payload) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      const [insertResult] = await conn.execute(`
        insert into users (user_name, login_name, email, password, role, is_allowed_to_apply)
        values (?, ?, ?, ?, ?, ?)
      `, [
        payload.user_name,
        payload.login_name,
        payload.email,
        payload.password,
        payload.role,
        payload.is_allowed_to_apply
      ]);
      const userId = Number(insertResult.insertId);
      await conn.execute(`
        insert into audit_logs (
          actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
        ) values (?, ?, ?, 'USER_CREATE', 'User', ?, ?, ?, ?)
      `, [
        actor?.user_id ?? null,
        actor?.user_name ?? "系统",
        actor?.role ?? "System",
        String(userId),
        payload.user_name,
        `登录名：${payload.login_name}\n角色：${payload.role}\n邮箱：${payload.email}\n允许申请：${payload.is_allowed_to_apply}`,
        nowMinuteStr()
      ]);
      return { userId };
    });
  }
  throw new Error("createCourseUser only supports mysql during migration");
}

async function updateCourseUser(actor, userId, payload) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      const target = await conn.execute("select * from users where user_id = ?", [userId]).then(([rows]) => rows[0] || null);
      if (!target) return { notFound: true };
      const teachesClassesRow = await conn.execute(
        "select count(*) as count from classes where find_in_set(?, teacher_user_id)",
        [String(userId)]
      ).then(([rows]) => rows[0] || null);
      const teachesClasses = Number(teachesClassesRow?.count || 0);
      if (teachesClasses > 0 && payload.role !== "Professor") {
        return { roleConflict: true };
      }
      await conn.execute(`
        update users
        set user_name = ?, login_name = ?, email = ?, password = ?, role = ?, is_allowed_to_apply = ?
        where user_id = ?
      `, [
        payload.user_name,
        payload.login_name,
        payload.email,
        payload.password,
        payload.role,
        payload.is_allowed_to_apply,
        userId
      ]);
      if (payload.role === "Professor") {
        const classes = await conn.execute(
          "select class_id, teacher_user_id from classes where find_in_set(?, teacher_user_id)",
          [String(userId)]
        ).then(([rows]) => rows);
        for (const row of classes) {
          const ids = String(row.teacher_user_id || "")
            .split(",")
            .map((item) => Number(String(item).trim()))
            .filter((item) => Number.isInteger(item) && item > 0);
          if (!ids.length) continue;
          const placeholders = ids.map(() => "?").join(",");
          const professorRows = await conn.execute(
            `select user_id, user_name from users where role = 'Professor' and user_id in (${placeholders}) order by user_name`,
            ids
          ).then(([rows]) => rows);
          const names = professorRows.map((item) => item.user_name).join(" / ");
          await conn.execute("update classes set teacher_name = ? where class_id = ?", [names, row.class_id]);
        }
      }
      await conn.execute(`
        insert into audit_logs (
          actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
        ) values (?, ?, ?, 'USER_UPDATE', 'User', ?, ?, ?, ?)
      `, [
        actor?.user_id ?? null,
        actor?.user_name ?? "系统",
        actor?.role ?? "System",
        String(userId),
        payload.user_name,
        `原登录名：${target.login_name}\n新登录名：${payload.login_name}\n角色：${payload.role}\n邮箱：${payload.email}\n允许申请：${payload.is_allowed_to_apply}`,
        nowMinuteStr()
      ]);
      return { ok: true };
    });
  }
  throw new Error("updateCourseUser only supports mysql during migration");
}

async function deleteCourseUser(actor, userId) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      const target = await conn.execute("select * from users where user_id = ?", [userId]).then(([rows]) => rows[0] || null);
      if (!target) return { notFound: true };
      const [applicationCountRow, classCountRow, approvalCountRow] = await Promise.all([
        conn.execute(
          "select count(*) as count from applications where applier_user_id = ? or find_in_set(?, teacher_user_id)",
          [userId, String(userId)]
        ).then(([rows]) => rows[0] || null),
        conn.execute(
          "select count(*) as count from classes where find_in_set(?, teacher_user_id)",
          [String(userId)]
        ).then(([rows]) => rows[0] || null),
        conn.execute(
          "select count(*) as count from approval_logs where approver_user_id = ?",
          [userId]
        ).then(([rows]) => rows[0] || null)
      ]);
      const applicationCount = Number(applicationCountRow?.count || 0);
      const classCount = Number(classCountRow?.count || 0);
      const approvalCount = Number(approvalCountRow?.count || 0);
      if (applicationCount > 0 || classCount > 0 || approvalCount > 0) {
        return { blocked: true };
      }
      await conn.execute(`
        insert into audit_logs (
          actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
        ) values (?, ?, ?, 'USER_DELETE', 'User', ?, ?, ?, ?)
      `, [
        actor?.user_id ?? null,
        actor?.user_name ?? "系统",
        actor?.role ?? "System",
        String(userId),
        target.user_name,
        `登录名：${target.login_name}\n角色：${target.role}\n邮箱：${target.email}`,
        nowMinuteStr()
      ]);
      const [deleteResult] = await conn.execute("delete from users where user_id = ?", [userId]);
      return { deleted: Number(deleteResult.affectedRows || 0) };
    });
  }
  throw new Error("deleteCourseUser only supports mysql during migration");
}

async function upsertImportedUsers(actor, importedUsers, sourceName = "users_import") {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      const errors = [];
      for (const item of importedUsers) {
        const existing = await conn.execute(
          "select * from users where login_name = ?",
          [item.loginName]
        ).then(([rows]) => rows[0] || null);
        if (!existing) continue;
        const teachesClassesRow = await conn.execute(
          "select count(*) as count from classes where find_in_set(?, teacher_user_id)",
          [String(existing.user_id)]
        ).then(([rows]) => rows[0] || null);
        const teachesClasses = Number(teachesClassesRow?.count || 0);
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
        const existing = await conn.execute(
          "select * from users where login_name = ?",
          [item.loginName]
        ).then(([rows]) => rows[0] || null);
        if (!existing) {
          await conn.execute(`
            insert into users (user_name, login_name, email, password, role, is_allowed_to_apply)
            values (?, ?, ?, ?, ?, ?)
          `, [
            item.userName,
            item.loginName,
            item.email,
            item.password,
            item.role,
            item.isAllowedToApply
          ]);
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

        await conn.execute(`
          update users
          set user_name = ?, email = ?, password = ?, role = ?, is_allowed_to_apply = ?
          where user_id = ?
        `, [
          item.userName,
          item.email,
          item.password,
          item.role,
          item.isAllowedToApply,
          existing.user_id
        ]);

        if (item.role === "Professor") {
          const classes = await conn.execute(
            "select class_id, teacher_user_id from classes where find_in_set(?, teacher_user_id)",
            [String(existing.user_id)]
          ).then(([rows]) => rows);
          for (const row of classes) {
            const ids = String(row.teacher_user_id || "")
              .split(",")
              .map((value) => Number(String(value).trim()))
              .filter((value) => Number.isInteger(value) && value > 0);
            if (!ids.length) continue;
            const placeholders = ids.map(() => "?").join(",");
            const professorRows = await conn.execute(
              `select user_id, user_name from users where role = 'Professor' and user_id in (${placeholders}) order by user_name`,
              ids
            ).then(([rows]) => rows);
            const names = professorRows.map((entry) => entry.user_name).join(" / ");
            await conn.execute("update classes set teacher_name = ? where class_id = ?", [names, row.class_id]);
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

      await conn.execute(`
        insert into audit_logs (
          actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
        ) values (?, ?, ?, 'USER_IMPORT', 'Import', ?, '人员导入', ?, ?)
      `, [
        actor?.user_id ?? null,
        actor?.user_name ?? "系统",
        actor?.role ?? "System",
        String(sourceName || "users_import"),
        `文件名：${sourceName}\n新增人员：${createdCount}\n更新人员：${updatedCount}`,
        nowMinuteStr()
      ]);

      return { createdCount, updatedCount, details };
    });
  }
  throw new Error("upsertImportedUsers only supports mysql during migration");
}

async function upsertImportedClasses(actor, importedClasses, sourceName = "classes_import") {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      const errors = [];
      for (const item of importedClasses) {
        const missing = [];
        for (const loginName of item.teacherLoginNames) {
          const professor = await conn.execute(
            "select user_id, user_name from users where login_name = ? and role = 'Professor'",
            [loginName]
          ).then(([rows]) => rows[0] || null);
          if (!professor) missing.push(loginName);
        }
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
        const professors = [];
        for (const loginName of item.teacherLoginNames) {
          const professor = await conn.execute(
            "select user_id, user_name from users where login_name = ? and role = 'Professor'",
            [loginName]
          ).then(([rows]) => rows[0] || null);
          if (professor) professors.push(professor);
        }
        const teacherUserIds = professors.map((row) => row.user_id).join(",");
        const teacherNames = professors.map((row) => row.user_name).join(" / ");
        const existing = await conn.execute(
          "select * from classes where class_code = ?",
          [item.classCode]
        ).then(([rows]) => rows[0] || null);
        let classId;
        if (existing) {
          classId = Number(existing.class_id);
          await conn.execute(`
            update classes
            set class_abbr = ?, class_name = ?, course_name = ?, teaching_language = ?, teacher_user_id = ?,
                teacher_name = ?, class_intro = ?, memo = ?, credit = ?, maximum_number_of_tas_admitted = ?,
                ta_applications_allowed = ?, is_conflict_allowed = ?, apply_start_at = ?, apply_end_at = ?, semester = ?
            where class_id = ?
          `, [
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
          ]);
          await conn.execute(`
            update applications
            set teacher_user_id = ?, teacher_name = ?, class_name = ?
            where class_id = ?
          `, [teacherUserIds, teacherNames, item.className, classId]);
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
          const [insertResult] = await conn.execute(`
            insert into classes (
              class_code, class_abbr, class_name, course_name, teaching_language, teacher_user_id,
              teacher_name, class_intro, memo, credit, maximum_number_of_tas_admitted,
              ta_applications_allowed, is_conflict_allowed, apply_start_at, apply_end_at, semester,
              published_to_professor, professor_notified_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'N', null)
          `, [
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
          ]);
          classId = Number(insertResult.insertId);
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
        await conn.execute("delete from class_schedules where class_id = ?", [classId]);
        for (const schedule of item.schedules) {
          await conn.execute(`
            insert into class_schedules (class_id, lesson_date, start_time, end_time, section, is_exam)
            values (?, ?, ?, ?, ?, ?)
          `, [
            classId,
            schedule.lessonDate,
            schedule.startTime,
            schedule.endTime,
            schedule.section,
            schedule.isExam
          ]);
        }
      }

      await conn.execute(`
        insert into audit_logs (
          actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
        ) values (?, ?, ?, 'CLASS_IMPORT', 'Import', ?, '教学班导入', ?, ?)
      `, [
        actor?.user_id ?? null,
        actor?.user_name ?? "系统",
        actor?.role ?? "System",
        String(sourceName || "classes_import"),
        `文件名：${sourceName}\n新增教学班：${createdCount}\n更新教学班：${updatedCount}`,
        nowMinuteStr()
      ]);

      return { createdCount, updatedCount, details };
    });
  }
  throw new Error("upsertImportedClasses only supports mysql during migration");
}

async function getApprovalLogs(applicationId) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.query(`
      select approval_stage, approver_name, result, comments, acted_at
      from approval_logs
      where application_id = ?
      order by acted_at, approval_log_id
    `, [applicationId]);
  }
  const db = getSqliteDb();
  try {
    return db.prepare(`
      select approval_stage, approver_name, result, comments, acted_at
      from approval_logs
      where application_id = ?
      order by acted_at, approval_log_id
    `).all(applicationId);
  } finally {
    db.close();
  }
}

async function getAllApplicationAuditRows() {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.query(`
      select target_id, created_at, actor_name, actor_role, action_type, details
      from audit_logs
      where target_type = 'Application'
      order by created_at desc, audit_log_id desc
    `);
  }
  const db = getSqliteDb();
  try {
    return db.prepare(`
      select target_id, created_at, actor_name, actor_role, action_type, details
      from audit_logs
      where target_type = 'Application'
      order by created_at desc, audit_log_id desc
    `).all();
  } finally {
    db.close();
  }
}

async function getSchedulesForClassIds(classIds) {
  if (!classIds.length) return [];
  if (DB_CLIENT === "mysql") {
    const placeholders = classIds.map(() => "?").join(",");
    return mysqlDb.query(
      `select class_id, lesson_date, start_time, end_time, section, is_exam
       from class_schedules
       where class_id in (${placeholders})
       order by lesson_date, start_time`,
      classIds
    );
  }
  const db = getSqliteDb();
  try {
    const stmt = db.prepare("select class_id, lesson_date, start_time, end_time, section, is_exam from class_schedules where class_id = ? order by lesson_date, start_time");
    return classIds.flatMap((classId) => stmt.all(classId));
  } finally {
    db.close();
  }
}

async function getApprovedApplicationsForClasses(classIds) {
  if (!classIds.length) return [];
  if (DB_CLIENT === "mysql") {
    const placeholders = classIds.map(() => "?").join(",");
    return mysqlDb.query(`
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
        and a.class_id in (${placeholders})
      order by a.class_id, a.applier_name
    `, classIds);
  }
  const db = getSqliteDb();
  try {
    return db.prepare(`
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
    `).all(...classIds);
  } finally {
    db.close();
  }
}

async function getProfessorUsers() {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.query("select user_id, user_name, login_name, email, role from users where role = 'Professor' order by user_name");
  }
  const db = getSqliteDb();
  try {
    return db.prepare("select user_id, user_name, login_name, email, role from users where role = 'Professor' order by user_name").all();
  } finally {
    db.close();
  }
}

async function getCourseClassDetail(classId) {
  if (DB_CLIENT === "mysql") {
    const classRow = await mysqlDb.one("select * from classes where class_id = ?", [classId]);
    if (!classRow) return { classRow: null, schedules: [], applicationCount: 0, approvedCount: 0 };
    const schedules = await getSchedulesForClassIds([classId]);
    const [applicationCountRow, approvedCountRow] = await Promise.all([
      mysqlDb.one("select count(*) as count from applications where class_id = ?", [classId]),
      mysqlDb.one("select count(*) as count from applications where class_id = ? and status = 'Approved'", [classId])
    ]);
    return {
      classRow,
      schedules,
      applicationCount: Number(applicationCountRow?.count || 0),
      approvedCount: Number(approvedCountRow?.count || 0)
    };
  }
  const db = getSqliteDb();
  try {
    const classRow = db.prepare("select * from classes where class_id = ?").get(classId);
    if (!classRow) return { classRow: null, schedules: [], applicationCount: 0, approvedCount: 0 };
    const schedules = db.prepare(`
      select lesson_date, start_time, end_time, section, is_exam
      from class_schedules
      where class_id = ?
      order by lesson_date, start_time
    `).all(classId);
    const applicationCount = Number(db.prepare("select count(*) as count from applications where class_id = ?").get(classId).count || 0);
    const approvedCount = Number(db.prepare("select count(*) as count from applications where class_id = ? and status = 'Approved'").get(classId).count || 0);
    return { classRow, schedules, applicationCount, approvedCount };
  } finally {
    db.close();
  }
}

async function getCourseClassApplications(classId) {
  if (DB_CLIENT === "mysql") {
    const classRow = await mysqlDb.one("select * from classes where class_id = ?", [classId]);
    if (!classRow) return { classRow: null, apps: [] };
    const apps = await mysqlDb.query(`
      select *
      from applications
      where class_id = ?
      order by submitted_at desc
    `, [classId]);
    return { classRow, apps };
  }
  const db = getSqliteDb();
  try {
    const classRow = db.prepare("select * from classes where class_id = ?").get(classId);
    if (!classRow) return { classRow: null, apps: [] };
    const apps = db.prepare(`
      select *
      from applications
      where class_id = ?
      order by submitted_at desc
    `).all(classId);
    return { classRow, apps };
  } finally {
    db.close();
  }
}

async function getClassDeleteImpact(classId) {
  if (DB_CLIENT === "mysql") {
    const [scheduleCountRow, applicationCountRow, approvalCountRow] = await Promise.all([
      mysqlDb.one("select count(*) as count from class_schedules where class_id = ?", [classId]),
      mysqlDb.one("select count(*) as count from applications where class_id = ?", [classId]),
      mysqlDb.one(`
        select count(*) as count
        from approval_logs al
        inner join applications a on a.application_id = al.application_id
        where a.class_id = ?
      `, [classId])
    ]);
    return {
      scheduleCount: Number(scheduleCountRow?.count || 0),
      applicationCount: Number(applicationCountRow?.count || 0),
      approvalCount: Number(approvalCountRow?.count || 0)
    };
  }
  const db = getSqliteDb();
  try {
    const scheduleCount = Number(db.prepare("select count(*) as count from class_schedules where class_id = ?").get(classId).count || 0);
    const appRows = db.prepare("select application_id from applications where class_id = ?").all(classId);
    let approvalCount = 0;
    if (appRows.length) {
      const countStmt = db.prepare("select count(*) as count from approval_logs where application_id = ?");
      for (const row of appRows) {
        approvalCount += Number(countStmt.get(row.application_id).count || 0);
      }
    }
    return {
      scheduleCount,
      applicationCount: appRows.length,
      approvalCount
    };
  } finally {
    db.close();
  }
}

async function createCourseClass(actor, payload, scheduleRows) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      const [insertResult] = await conn.execute(`
        insert into classes (
          class_code, class_abbr, class_name, course_name, teaching_language, teacher_user_id,
          teacher_name, class_intro, memo, credit, maximum_number_of_tas_admitted,
          ta_applications_allowed, is_conflict_allowed, apply_start_at, apply_end_at, semester,
          published_to_professor, professor_notified_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'N', null)
      `, [
        payload.class_code,
        payload.class_abbr,
        payload.class_name,
        payload.course_name,
        payload.teaching_language,
        payload.teacher_user_id,
        payload.teacher_name,
        payload.class_intro,
        payload.memo,
        payload.credit,
        payload.maximum_number_of_tas_admitted,
        payload.ta_applications_allowed,
        payload.is_conflict_allowed,
        payload.apply_start_at,
        payload.apply_end_at,
        payload.semester
      ]);
      const classId = Number(insertResult.insertId);
      for (const schedule of scheduleRows) {
        await conn.execute(`
          insert into class_schedules (class_id, lesson_date, start_time, end_time, section, is_exam)
          values (?, ?, ?, ?, ?, ?)
        `, [
          classId,
          schedule.lessonDate,
          schedule.startTime,
          schedule.endTime,
          schedule.section,
          schedule.isExam
        ]);
      }
      await conn.execute(`
        insert into audit_logs (
          actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
        ) values (?, ?, ?, 'CLASS_CREATE', 'Class', ?, ?, ?, ?)
      `, [
        actor?.user_id ?? null,
        actor?.user_name ?? "系统",
        actor?.role ?? "System",
        String(classId),
        `${payload.course_name} / ${payload.class_name}`,
        `教学班代码：${payload.class_code}\n教授：${payload.teacher_name}\n学期：${payload.semester}\n学分：${payload.credit}\nTA上限：${payload.maximum_number_of_tas_admitted}\n排课数：${scheduleRows.length}`,
        nowMinuteStr()
      ]);
      return { classId };
    });
  }
  throw new Error("createCourseClass only supports mysql during migration");
}

async function updateCourseClass(actor, classId, payload, scheduleRows) {
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      const existing = await conn.execute("select class_id from classes where class_id = ?", [classId]).then(([rows]) => rows[0] || null);
      if (!existing) {
        return { notFound: true };
      }
      await conn.execute(`
        update classes
        set class_code = ?, class_abbr = ?, class_name = ?, course_name = ?, teaching_language = ?, teacher_user_id = ?,
            teacher_name = ?, class_intro = ?, memo = ?, credit = ?, maximum_number_of_tas_admitted = ?, ta_applications_allowed = ?, is_conflict_allowed = ?, apply_start_at = ?, apply_end_at = ?, semester = ?
        where class_id = ?
      `, [
        payload.class_code,
        payload.class_abbr,
        payload.class_name,
        payload.course_name,
        payload.teaching_language,
        payload.teacher_user_id,
        payload.teacher_name,
        payload.class_intro,
        payload.memo,
        payload.credit,
        payload.maximum_number_of_tas_admitted,
        payload.ta_applications_allowed,
        payload.is_conflict_allowed,
        payload.apply_start_at,
        payload.apply_end_at,
        payload.semester,
        classId
      ]);
      await conn.execute("delete from class_schedules where class_id = ?", [classId]);
      for (const schedule of scheduleRows) {
        await conn.execute(`
          insert into class_schedules (class_id, lesson_date, start_time, end_time, section, is_exam)
          values (?, ?, ?, ?, ?, ?)
        `, [
          classId,
          schedule.lessonDate,
          schedule.startTime,
          schedule.endTime,
          schedule.section,
          schedule.isExam
        ]);
      }
      await conn.execute(`
        update applications
        set teacher_user_id = ?, teacher_name = ?, class_name = ?
        where class_id = ?
      `, [
        payload.teacher_user_id,
        payload.teacher_name,
        payload.class_name,
        classId
      ]);
      await conn.execute(`
        insert into audit_logs (
          actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
        ) values (?, ?, ?, 'CLASS_UPDATE', 'Class', ?, ?, ?, ?)
      `, [
        actor?.user_id ?? null,
        actor?.user_name ?? "系统",
        actor?.role ?? "System",
        String(classId),
        `${payload.course_name} / ${payload.class_name}`,
        `教学班代码：${payload.class_code}\n教授：${payload.teacher_name}\n学期：${payload.semester}\n学分：${payload.credit}\nTA上限：${payload.maximum_number_of_tas_admitted}\n排课数：${scheduleRows.length}`,
        nowMinuteStr()
      ]);
      return { ok: true };
    });
  }
  throw new Error("updateCourseClass only supports mysql during migration");
}

async function deleteCourseClasses(actor, classIds) {
  const ids = Array.from(new Set(classIds.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)));
  if (!ids.length) {
    return { deletedCount: 0, filesToDelete: [] };
  }
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      const filesToDelete = [];
      let deletedCount = 0;
      for (const classId of ids) {
        const classRow = await conn.execute("select * from classes where class_id = ?", [classId]).then(([rows]) => rows[0] || null);
        if (!classRow) continue;
        const [scheduleCountRow, appRows, approvalCountRow] = await Promise.all([
          conn.execute("select count(*) as count from class_schedules where class_id = ?", [classId]).then(([rows]) => rows[0] || null),
          conn.execute("select application_id, resume_path from applications where class_id = ?", [classId]).then(([rows]) => rows),
          conn.execute(`
            select count(*) as count
            from approval_logs al
            inner join applications a on a.application_id = al.application_id
            where a.class_id = ?
          `, [classId]).then(([rows]) => rows[0] || null)
        ]);
        for (const app of appRows) {
          if (app.resume_path) {
            filesToDelete.push(path.join(UPLOAD_DIR, path.basename(app.resume_path)));
          }
        }
        await conn.execute("delete from approval_logs where application_id in (select application_id from applications where class_id = ?)", [classId]);
        await conn.execute("delete from applications where class_id = ?", [classId]);
        await conn.execute("delete from class_schedules where class_id = ?", [classId]);
        await conn.execute(`
          insert into audit_logs (
            actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
          ) values (?, ?, ?, 'CLASS_DELETE', 'Class', ?, ?, ?, ?)
        `, [
          actor?.user_id ?? null,
          actor?.user_name ?? "系统",
          actor?.role ?? "System",
          String(classId),
          `${classRow.course_name} / ${classRow.class_name}`,
          `教学班代码：${classRow.class_code}\n教授：${classRow.teacher_name}\n排课数：${Number(scheduleCountRow?.count || 0)}\n申请数：${appRows.length}\n审批日志数：${Number(approvalCountRow?.count || 0)}`,
          nowMinuteStr()
        ]);
        const [deleteResult] = await conn.execute("delete from classes where class_id = ?", [classId]);
        deletedCount += Number(deleteResult.affectedRows || 0);
      }
      return { deletedCount, filesToDelete };
    });
  }
  throw new Error("deleteCourseClasses only supports mysql during migration");
}

async function batchUpdateCourseClassWindow(actor, refs, applyStartAt, applyEndAt) {
  const rows = await getClassRowsByRefs(refs);
  if (!rows.length) return { changed: 0, changedRows: [] };
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      for (const row of rows) {
        await conn.execute(`
          update classes
          set apply_start_at = ?, apply_end_at = ?
          where class_id = ?
        `, [applyStartAt, applyEndAt, row.class_id]);
        await conn.execute(`
          insert into audit_logs (
            actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
          ) values (?, ?, ?, 'CLASS_APPLY_WINDOW_UPDATE', 'Class', ?, ?, ?, ?)
        `, [
          actor?.user_id ?? null,
          actor?.user_name ?? "系统",
          actor?.role ?? "System",
          String(row.class_id),
          `${row.course_name} / ${row.class_name}`,
          `教学班代码：${row.class_code}\n开放开始：${applyStartAt}\n开放结束：${applyEndAt}`,
          nowMinuteStr()
        ]);
      }
      return { changed: rows.length, changedRows: rows };
    });
  }
  throw new Error("batchUpdateCourseClassWindow only supports mysql during migration");
}

async function batchToggleCourseClassApply(actor, refs, taAllowed) {
  const rows = await getClassRowsByRefs(refs);
  if (!rows.length) return { changed: 0, changedRows: [] };
  if (DB_CLIENT === "mysql") {
    return mysqlDb.withTransaction(async (conn) => {
      for (const row of rows) {
        await conn.execute(`
          update classes
          set ta_applications_allowed = ?
          where class_id = ?
        `, [taAllowed, row.class_id]);
        await conn.execute(`
          insert into audit_logs (
            actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
          ) values (?, ?, ?, 'CLASS_APPLY_TOGGLE', 'Class', ?, ?, ?, ?)
        `, [
          actor?.user_id ?? null,
          actor?.user_name ?? "系统",
          actor?.role ?? "System",
          String(row.class_id),
          `${row.course_name} / ${row.class_name}`,
          `教学班代码：${row.class_code}\n新开放申请状态：${taAllowed}`,
          nowMinuteStr()
        ]);
      }
      return { changed: rows.length, changedRows: rows };
    });
  }
  throw new Error("batchToggleCourseClassApply only supports mysql during migration");
}

async function getProfessorClassReviewData(professorUserId, classId) {
  if (DB_CLIENT === "mysql") {
    const classRow = await mysqlDb.one(
      "select * from classes where class_id = ? and find_in_set(?, teacher_user_id)",
      [classId, String(professorUserId)]
    );
    if (!classRow) return { classRow: null, schedules: [], apps: [], approvedCount: 0 };
    const schedules = await getSchedulesForClassIds([classId]);
    const apps = await mysqlDb.query(`
      select *
      from applications
      where class_id = ?
        and status != 'Withdrawn'
      order by case when status = 'PendingProfessor' then 0 else 1 end, submitted_at, application_id
    `, [classId]);
    const approvedRow = await mysqlDb.one("select count(*) as count from applications where class_id = ? and status = 'Approved'", [classId]);
    return { classRow, schedules, apps, approvedCount: Number(approvedRow?.count || 0) };
  }
  const db = getSqliteDb();
  try {
    const classRow = db.prepare("select * from classes where class_id = ? and (',' || teacher_user_id || ',') like '%,' || ? || ',%'").get(classId, String(professorUserId));
    if (!classRow) return { classRow: null, schedules: [], apps: [], approvedCount: 0 };
    const schedules = db.prepare("select * from class_schedules where class_id = ? order by lesson_date, start_time").all(classId);
    const apps = db.prepare(`
      select *
      from applications
      where class_id = ?
        and status != 'Withdrawn'
      order by case when status = 'PendingProfessor' then 0 else 1 end, submitted_at, application_id
    `).all(classId);
    const approvedCount = Number(db.prepare("select count(*) as count from applications where class_id = ? and status = 'Approved'").get(classId).count || 0);
    return { classRow, schedules, apps, approvedCount };
  } finally {
    db.close();
  }
}

async function getProfessorApplicationDetail(professorUserId, applicationId) {
  if (DB_CLIENT === "mysql") {
    const app = await mysqlDb.one(`
      select a.*
      from applications a
      left join classes c on c.class_id = a.class_id
      where a.application_id = ?
        and a.status != 'Withdrawn'
        and find_in_set(?, a.teacher_user_id)
        and c.published_to_professor = 'Y'
    `, [applicationId, String(professorUserId)]);
    if (!app) return { app: null, classRow: null, approvedCount: 0, auditRows: [] };
    const classRow = await mysqlDb.one("select * from classes where class_id = ?", [app.class_id]);
    const approvedRow = await mysqlDb.one("select count(*) as count from applications where class_id = ? and status = 'Approved'", [app.class_id]);
    const auditRows = await getApplicationAuditRows(applicationId);
    return { app, classRow, approvedCount: Number(approvedRow?.count || 0), auditRows };
  }
  const db = getSqliteDb();
  try {
    const app = db.prepare(`
      select a.*
      from applications a
      left join classes c on c.class_id = a.class_id
      where a.application_id = ?
        and a.status != 'Withdrawn'
        and (',' || a.teacher_user_id || ',') like '%,' || ? || ',%'
        and c.published_to_professor = 'Y'
    `).get(applicationId, String(professorUserId));
    if (!app) return { app: null, classRow: null, approvedCount: 0, auditRows: [] };
    const classRow = db.prepare("select * from classes where class_id = ?").get(app.class_id);
    const approvedCount = Number(db.prepare("select count(*) as count from applications where class_id = ? and status = 'Approved'").get(app.class_id).count || 0);
    const auditRows = db.prepare(`
      select created_at, actor_name, actor_role, action_type, target_name, details
      from audit_logs
      where target_type = 'Application'
        and target_id = ?
      order by created_at, audit_log_id
    `).all(String(applicationId));
    return { app, classRow, approvedCount, auditRows };
  } finally {
    db.close();
  }
}

async function applyProfessorDecision(approver, applicationId, result, comments, actedAt) {
  if (DB_CLIENT !== "mysql") {
    throw new Error("applyProfessorDecision currently supports mysql runtime only");
  }
  return mysqlDb.withTransaction(async (conn) => {
    const [appRows] = await conn.execute(`
      select a.*, c.published_to_professor, c.maximum_number_of_tas_admitted
      from applications a
      left join classes c on c.class_id = a.class_id
      where a.application_id = ?
        and find_in_set(?, a.teacher_user_id)
        and c.published_to_professor = 'Y'
      for update
    `, [applicationId, String(approver.user_id)]);
    const app = appRows[0];
    if (!app || app.status !== "PendingProfessor") {
      return { ok: false, notice: "申请已被处理" };
    }
    const classRow = await conn.execute("select * from classes where class_id = ? for update", [app.class_id]).then(([rows]) => rows[0] || null);
    if (!classRow) {
      return { ok: false, notice: "教学班不存在" };
    }
    if (result === "Approved") {
      const approvedRow = await conn.execute("select count(*) as count from applications where class_id = ? and status = 'Approved'", [app.class_id]).then(([rows]) => rows[0] || { count: 0 });
      if (Number(approvedRow.count || 0) >= Number(classRow.maximum_number_of_tas_admitted || 0)) {
        return { ok: false, notice: "该教学班 TA 名额已满", redirectToDetail: true };
      }
    }
    const nextStatus = result === "Approved" ? "Approved" : "RejectedByProfessor";
    await conn.execute(`
      update applications
      set status = ?, prof_comment = ?, prof_acted_at = ?
      where application_id = ? and status = 'PendingProfessor'
    `, [nextStatus, comments, actedAt, applicationId]);
    await conn.execute(`
      insert into approval_logs (application_id, approval_stage, approver_user_id, approver_name, result, comments, acted_at)
      values (?, 'Professor', ?, ?, ?, ?, ?)
    `, [applicationId, approver.user_id, approver.user_name, result, comments, actedAt]);
    await conn.execute(`
      insert into audit_logs (
        actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      approver.user_id,
      approver.user_name,
      approver.role,
      result === "Approved" ? "PROFESSOR_APPROVE" : "PROFESSOR_REJECT",
      "Application",
      String(applicationId),
      app.class_name,
      `申请人：${app.applier_name}\n审批结果：${result === "Approved" ? "通过" : "拒绝"}\n新状态：${nextStatus}${comments ? `\n备注：${comments}` : ""}`,
      actedAt
    ]);

    const emailTargets = [];
    await conn.execute(`
      insert into notifications (user_id, title, content, target_path, is_read, created_at)
      values (?, ?, ?, ?, 'N', ?)
    `, [
      app.applier_user_id,
      result === "Approved" ? "Professor 审批通过" : "Professor 审批未通过",
      result === "Approved"
        ? `你的申请《${app.class_name}》已通过 Professor 审批。`
        : `你的申请《${app.class_name}》被 Professor 拒绝。`,
      `/ta/applications/${applicationId}`,
      actedAt
    ]);
    const applicant = await conn.execute("select user_id, user_name, email from users where user_id = ?", [app.applier_user_id]).then(([rows]) => rows[0] || null);
    emailTargets.push({ type: "main", applicant, app: { ...app, status: nextStatus, prof_comment: comments, prof_acted_at: actedAt }, result, comments });

    const autoRejected = [];
    if (result === "Approved") {
      const finalApprovedRow = await conn.execute("select count(*) as count from applications where class_id = ? and status = 'Approved'", [app.class_id]).then(([rows]) => rows[0] || { count: 0 });
      if (Number(finalApprovedRow.count || 0) >= Number(classRow.maximum_number_of_tas_admitted || 0)) {
        const [otherApps] = await conn.execute(`
          select *
          from applications
          where class_id = ?
            and application_id != ?
            and status in ('PendingTAAdmin', 'PendingProfessor')
        `, [app.class_id, applicationId]);
        const rejectReason = "该课程TA已满";
        for (const other of otherApps) {
          await conn.execute(`
            update applications
            set status = 'RejectedByProfessor', prof_comment = ?, prof_acted_at = ?
            where application_id = ?
          `, [rejectReason, actedAt, other.application_id]);
          await conn.execute(`
            insert into approval_logs (application_id, approval_stage, approver_user_id, approver_name, result, comments, acted_at)
            values (?, 'Professor', ?, ?, 'Rejected', ?, ?)
          `, [other.application_id, approver.user_id, approver.user_name, rejectReason, actedAt]);
          await conn.execute(`
            insert into audit_logs (
              actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            approver.user_id,
            approver.user_name,
            approver.role,
            "AUTO_REJECT_CAPACITY",
            "Application",
            String(other.application_id),
            other.class_name,
            `申请人：${other.applier_name}\n触发来源：${app.applier_name} 的申请通过后名额已满\n拒绝原因：${rejectReason}`,
            actedAt
          ]);
          await conn.execute(`
            insert into notifications (user_id, title, content, target_path, is_read, created_at)
            values (?, ?, ?, ?, 'N', ?)
          `, [
            other.applier_user_id,
            "TA 申请被拒绝",
            `你的申请《${other.class_name}》因课程 TA 名额已满被自动拒绝。`,
            `/ta/applications/${other.application_id}`,
            actedAt
          ]);
          const rejectedApplicant = await conn.execute("select user_id, user_name, email from users where user_id = ?", [other.applier_user_id]).then(([rows]) => rows[0] || null);
          autoRejected.push({ applicant: rejectedApplicant, app: { ...other, status: "RejectedByProfessor", prof_comment: rejectReason, prof_acted_at: actedAt } });
        }
        if (classRow.ta_applications_allowed !== "N") {
          await conn.execute("update classes set ta_applications_allowed = 'N' where class_id = ?", [app.class_id]);
        }
      }
    }

    return {
      ok: true,
      app: { ...app, status: nextStatus, prof_comment: comments, prof_acted_at: actedAt },
      applicant,
      autoRejected
    };
  });
}

module.exports = {
  applyTaAdminDecision,
  applyProfessorDecision,
  createTaApplication,
  appendAuditLog,
  batchApplyTaAdminDecision,
  findUserByLoginAndPassword,
  findUserByLoginName,
  findUserById,
  getAllApplications,
  getAllApplicationAuditRows,
  getApprovedApplicationsForClasses,
  getApplicantById,
  getApprovalLogs,
  getApplicationAuditRows,
  getApplicationById,
  getApplicationConflicts,
  createCourseClass,
  createCourseUser,
  batchToggleCourseClassApply,
  batchUpdateCourseClassConflict,
  batchUpdateCourseClassWindow,
  deleteCourseUser,
  deleteCourseClasses,
  getClassDeleteImpact,
  getClassRowsByRefs,
  createLoginTokenRecord,
  getCourseAdminClassRows,
  getTaAdminClassRows,
  getCourseClassApplications,
  getCourseClassDetail,
  getCourseReportSnapshot,
  getCourseUserDetail,
  getCourseUsers,
  getAuditLogs,
  getProfessorUsers,
  getProfessorApplicationDetail,
  getProfessorClassReviewData,
  getProfessorPendingClassRows,
  getNotificationsByUser,
  getSchedulesForClassIds,
  getTaAdminPendingApplications,
  getTaUsersManagementRows,
  getTaApplications,
  getTaApplicationDetail,
  getTaClassesSnapshot,
  findUnusedLoginToken,
  markNotificationReadById,
  markLoginTokenUsed,
  unreadNotificationCountByUser,
  updateCourseClass,
  updateCourseUser,
  toggleTaUserApplyQualification,
  updateTaResume,
  withdrawTaApplication,
  updateProfessorPublishStatus,
  markClassesPublishedToProfessor,
  upsertImportedClasses,
  upsertImportedUsers
};
