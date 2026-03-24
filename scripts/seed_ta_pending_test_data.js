const { DatabaseSync } = require("node:sqlite");

const DB_PATH = "/Users/yanren/Documents/Playground/ta_system_node.db";
const TARGET_DATE_START = "2026-03-21 00:00";
const TARGET_DATE_END = "2026-03-21 23:59";

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDateTime(date) {
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds())
  ].join("");
}

function hasTimeConflict(a, b) {
  return a.lesson_date === b.lesson_date && !(a.end_time <= b.start_time || b.end_time <= a.start_time);
}

function pickNonConflictingClasses(db, limit) {
  const classes = db.prepare(`
    select class_id, class_code, class_name, teacher_user_id, teacher_name
    from classes
    where ta_applications_allowed = 'Y'
      and apply_start_at <= ?
      and apply_end_at >= ?
    order by class_id
  `).all(TARGET_DATE_END, TARGET_DATE_START);
  const scheduleStmt = db.prepare(`
    select lesson_date, start_time, end_time, section, is_exam
    from class_schedules
    where class_id = ?
    order by lesson_date, start_time
  `);
  const usable = classes
    .map((row) => ({ ...row, schedules: scheduleStmt.all(row.class_id) }))
    .filter((row) => row.schedules.length > 0);

  const selected = [];
  for (const row of usable) {
    const conflict = selected.some((picked) =>
      row.schedules.some((schedule) => picked.schedules.some((other) => hasTimeConflict(schedule, other)))
    );
    if (!conflict) {
      selected.push(row);
      if (selected.length === limit) break;
    }
  }
  return selected;
}

function main() {
  const db = new DatabaseSync(DB_PATH);
  const tas = db.prepare(`
    select user_id, user_name, login_name, resume_name, resume_path
    from users
    where role = 'TA'
      and is_allowed_to_apply = 'Y'
    order by user_id
    limit 10
  `).all();
  const classes = pickNonConflictingClasses(db, 5);

  if (tas.length < 10) {
    throw new Error(`可用 TA 不足 10 个，当前只有 ${tas.length} 个`);
  }
  if (classes.length < 5) {
    throw new Error(`无法找到 5 个互不冲突的开放教学班，当前只找到 ${classes.length} 个`);
  }

  const insertApplication = db.prepare(`
    insert into applications (
      applier_user_id,
      applier_name,
      class_id,
      class_name,
      teacher_user_id,
      teacher_name,
      application_reason,
      resume_name,
      resume_path,
      status,
      submitted_at,
      ta_comment,
      ta_acted_at,
      prof_comment,
      prof_acted_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PendingTAAdmin', ?, null, null, null, null)
  `);

  const startedAt = new Date();

  db.exec("BEGIN");
  try {
    db.exec("delete from approval_logs");
    db.exec("delete from notifications");
    db.exec("delete from applications");
    db.exec("update classes set published_to_professor = 'N', professor_notified_at = null");

    let sequence = 0;
    for (const ta of tas) {
      for (const clazz of classes) {
        const submittedAt = new Date(startedAt.getTime() + sequence * 60_000);
        insertApplication.run(
          ta.user_id,
          ta.user_name,
          clazz.class_id,
          clazz.class_name,
          clazz.teacher_user_id,
          clazz.teacher_name,
          `测试数据：${ta.login_name} 申请 ${clazz.class_code}`,
          ta.resume_name || "test_resume.pdf",
          ta.resume_path || null,
          formatDateTime(submittedAt)
        );
        sequence += 1;
      }
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const summary = {
    taCount: tas.length,
    classCount: classes.length,
    pendingTaAdminCount: db.prepare("select count(*) as count from applications where status = 'PendingTAAdmin'").get().count,
    totalApplicationCount: db.prepare("select count(*) as count from applications").get().count,
    selectedTAs: tas.map((row) => ({
      user_id: row.user_id,
      login_name: row.login_name,
      user_name: row.user_name
    })),
    selectedClasses: classes.map((row) => ({
      class_id: row.class_id,
      class_code: row.class_code,
      class_name: row.class_name
    }))
  };
  db.close();
  console.log(JSON.stringify(summary, null, 2));
}

main();
