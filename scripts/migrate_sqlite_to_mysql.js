const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const mysql = require("mysql2/promise");

function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function normalizeValue(value) {
  return value === undefined ? null : value;
}

async function main() {
  const baseDir = path.resolve(__dirname, "..");
  loadLocalEnv(path.join(baseDir, ".env.local"));

  const sqlitePath = path.join(baseDir, "ta_system_node.db");
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  const mysqlConnection = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "ta_system",
    multipleStatements: true
  });

  try {
    await mysqlConnection.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of [
      "approval_logs",
      "applications",
      "class_schedules",
      "notifications",
      "audit_logs",
      "login_tokens",
      "classes",
      "users"
    ]) {
      await mysqlConnection.query(`TRUNCATE TABLE ${table}`);
    }
    await mysqlConnection.query("SET FOREIGN_KEY_CHECKS = 1");

    const users = sqlite.prepare("select * from users order by user_id").all();
    for (const row of users) {
      await mysqlConnection.execute(
        `INSERT INTO users (user_id, user_name, login_name, email, password, role, is_allowed_to_apply, resume_name, resume_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.user_id,
          row.user_name,
          row.login_name,
          row.email,
          row.password,
          row.role,
          row.is_allowed_to_apply,
          normalizeValue(row.resume_name),
          normalizeValue(row.resume_path)
        ]
      );
    }

    const classes = sqlite.prepare("select * from classes order by class_id").all();
    for (const row of classes) {
      await mysqlConnection.execute(
        `INSERT INTO classes (
          class_id, class_code, class_abbr, class_name, course_name, teaching_language, teacher_user_id,
          teacher_name, class_intro, memo, maximum_number_of_tas_admitted, ta_applications_allowed,
          is_conflict_allowed, published_to_professor, professor_notified_at, apply_start_at, apply_end_at, semester
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.class_id,
          row.class_code,
          normalizeValue(row.class_abbr),
          row.class_name,
          row.course_name,
          row.teaching_language,
          row.teacher_user_id,
          row.teacher_name,
          normalizeValue(row.class_intro),
          normalizeValue(row.memo),
          row.maximum_number_of_tas_admitted,
          row.ta_applications_allowed,
          row.is_conflict_allowed,
          row.published_to_professor,
          normalizeValue(row.professor_notified_at),
          normalizeValue(row.apply_start_at),
          normalizeValue(row.apply_end_at),
          row.semester
        ]
      );
    }

    const schedules = sqlite.prepare("select * from class_schedules order by schedule_id").all();
    for (const row of schedules) {
      await mysqlConnection.execute(
        `INSERT INTO class_schedules (schedule_id, class_id, lesson_date, start_time, end_time, section, is_exam)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          row.schedule_id,
          row.class_id,
          row.lesson_date,
          row.start_time,
          row.end_time,
          row.section,
          normalizeValue(row.is_exam)
        ]
      );
    }

    const applications = sqlite.prepare("select * from applications order by application_id").all();
    for (const row of applications) {
      await mysqlConnection.execute(
        `INSERT INTO applications (
          application_id, applier_user_id, applier_name, class_id, class_name, teacher_user_id, teacher_name,
          application_reason, resume_name, resume_path, status, submitted_at, ta_comment, ta_acted_at, prof_comment, prof_acted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.application_id,
          row.applier_user_id,
          row.applier_name,
          row.class_id,
          row.class_name,
          row.teacher_user_id,
          row.teacher_name,
          row.application_reason,
          row.resume_name,
          normalizeValue(row.resume_path),
          row.status,
          row.submitted_at,
          normalizeValue(row.ta_comment),
          normalizeValue(row.ta_acted_at),
          normalizeValue(row.prof_comment),
          normalizeValue(row.prof_acted_at)
        ]
      );
    }

    const approvalLogs = sqlite.prepare("select * from approval_logs order by approval_log_id").all();
    for (const row of approvalLogs) {
      await mysqlConnection.execute(
        `INSERT INTO approval_logs (
          approval_log_id, application_id, approval_stage, approver_user_id, approver_name, result, comments, acted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.approval_log_id,
          row.application_id,
          row.approval_stage,
          row.approver_user_id,
          row.approver_name,
          row.result,
          normalizeValue(row.comments),
          row.acted_at
        ]
      );
    }

    const notifications = sqlite.prepare("select * from notifications order by notification_id").all();
    for (const row of notifications) {
      await mysqlConnection.execute(
        `INSERT INTO notifications (
          notification_id, user_id, title, content, target_path, is_read, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          row.notification_id,
          row.user_id,
          row.title,
          row.content,
          normalizeValue(row.target_path),
          row.is_read,
          row.created_at
        ]
      );
    }

    const auditLogs = sqlite.prepare("select * from audit_logs order by audit_log_id").all();
    for (const row of auditLogs) {
      await mysqlConnection.execute(
        `INSERT INTO audit_logs (
          audit_log_id, actor_user_id, actor_name, actor_role, action_type, target_type, target_id, target_name, details, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.audit_log_id,
          normalizeValue(row.actor_user_id),
          normalizeValue(row.actor_name),
          normalizeValue(row.actor_role),
          row.action_type,
          row.target_type,
          normalizeValue(row.target_id),
          normalizeValue(row.target_name),
          normalizeValue(row.details),
          row.created_at
        ]
      );
    }

    const loginTokens = sqlite.prepare("select * from login_tokens order by token").all();
    for (const row of loginTokens) {
      await mysqlConnection.execute(
        `INSERT INTO login_tokens (token, user_id, target_path, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          row.token,
          row.user_id,
          row.target_path,
          row.expires_at,
          normalizeValue(row.used_at)
        ]
      );
    }

    await mysqlConnection.query("ALTER TABLE users AUTO_INCREMENT = 1");
    await mysqlConnection.query("ALTER TABLE classes AUTO_INCREMENT = 1");
    await mysqlConnection.query("ALTER TABLE class_schedules AUTO_INCREMENT = 1");
    await mysqlConnection.query("ALTER TABLE applications AUTO_INCREMENT = 1");
    await mysqlConnection.query("ALTER TABLE approval_logs AUTO_INCREMENT = 1");
    await mysqlConnection.query("ALTER TABLE notifications AUTO_INCREMENT = 1");
    await mysqlConnection.query("ALTER TABLE audit_logs AUTO_INCREMENT = 1");

    console.log("SQLite data migrated to MySQL successfully.");
  } finally {
    sqlite.close();
    await mysqlConnection.end();
  }
}

main().catch((error) => {
  console.error("Failed to migrate SQLite data to MySQL.");
  console.error(error);
  process.exit(1);
});
