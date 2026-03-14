import html
import os
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from http import cookies
from urllib.parse import parse_qs, urlparse
from wsgiref.simple_server import make_server


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "ta_system.db")
SESSIONS = {}


STATUS_LABELS = {
    "PendingTAAdmin": "待 TAAdmin 审批",
    "RejectedByTAAdmin": "TAAdmin 拒绝",
    "PendingProfessor": "待教授审批",
    "RejectedByProfessor": "教授拒绝",
    "Approved": "已通过",
    "Withdrawn": "已撤销",
}


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def parse_body(environ):
    try:
        size = int(environ.get("CONTENT_LENGTH") or "0")
    except ValueError:
        size = 0
    body = environ["wsgi.input"].read(size).decode("utf-8")
    return {k: v[0] for k, v in parse_qs(body).items()}


def redirect(start_response, location):
    start_response("302 Found", [("Location", location)])
    return [b""]


def text_response(start_response, status, text, headers=None):
    base_headers = [("Content-Type", "text/html; charset=utf-8")]
    if headers:
        base_headers.extend(headers)
    start_response(status, base_headers)
    return [text.encode("utf-8")]


def html_page(title, body, user=None, notice=None):
    nav = ""
    if user:
        links = ['<a href="/">首页</a>', '<a href="/logout">退出</a>']
        if user["role"] == "TA":
            links.insert(1, '<a href="/ta/classes">可申请教学班</a>')
            links.insert(2, '<a href="/ta/applications">我的申请</a>')
        elif user["role"] == "TAAdmin":
            links.insert(1, '<a href="/admin/ta/pending">待初审申请</a>')
            links.insert(2, '<a href="/admin/ta/users">TA 管理</a>')
        elif user["role"] == "Professor":
            links.insert(1, '<a href="/professor/pending">待教授审批</a>')
        elif user["role"] == "CourseAdmin":
            links.insert(1, '<a href="/course/classes">教学班管理</a>')
        nav = f"<nav>{' | '.join(links)}</nav>"
    notice_block = f'<div class="notice">{html.escape(notice)}</div>' if notice else ""
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>{html.escape(title)}</title>
  <style>
    :root {{
      --bg: #f4f1ea;
      --panel: #fffdf8;
      --ink: #1f2a2e;
      --accent: #bf5b2c;
      --line: #dccfbf;
      --muted: #637176;
      --ok: #356859;
      --bad: #8a2d2d;
    }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; font-family: Georgia, "Noto Serif SC", serif; background:
      radial-gradient(circle at top left, #f8e8d3 0, transparent 28%),
      linear-gradient(180deg, var(--bg), #e8e0d4);
      color: var(--ink); }}
    header {{ padding: 24px 32px 8px; }}
    nav {{ margin-top: 8px; color: var(--muted); }}
    nav a {{ color: var(--accent); text-decoration: none; margin-right: 12px; }}
    main {{ padding: 8px 32px 48px; max-width: 1200px; }}
    .card {{ background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 20px; margin-bottom: 18px; box-shadow: 0 14px 40px rgba(70, 50, 20, 0.07); }}
    h1, h2, h3 {{ margin: 0 0 14px; }}
    table {{ width: 100%; border-collapse: collapse; }}
    th, td {{ border-bottom: 1px solid var(--line); padding: 10px 8px; vertical-align: top; text-align: left; }}
    .grid {{ display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }}
    .notice {{ margin: 0 32px 16px; padding: 12px 16px; border-radius: 12px; background: #fff4dc; border: 1px solid #efd4a6; }}
    .muted {{ color: var(--muted); }}
    .pill {{ display: inline-block; padding: 4px 10px; border-radius: 999px; background: #efe3d4; }}
    .ok {{ color: var(--ok); }}
    .bad {{ color: var(--bad); }}
    form.inline {{ display: inline; }}
    input, select, textarea {{ width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: white; }}
    textarea {{ min-height: 100px; }}
    button {{ border: 0; border-radius: 999px; background: var(--accent); color: white; padding: 10px 16px; cursor: pointer; }}
    button.secondary {{ background: #7c8a8e; }}
    .actions {{ display: flex; gap: 8px; flex-wrap: wrap; }}
    .split {{ display: grid; grid-template-columns: 2fr 1fr; gap: 18px; }}
    @media (max-width: 800px) {{ .split {{ grid-template-columns: 1fr; }} header, main {{ padding-left: 18px; padding-right: 18px; }} }}
  </style>
</head>
<body>
  <header>
    <h1>TA 选课系统 MVP</h1>
    {nav}
  </header>
  {notice_block}
  <main>{body}</main>
</body>
</html>"""


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with db() as conn:
        conn.executescript(
            """
            create table if not exists users (
                user_id integer primary key autoincrement,
                user_name text not null,
                login_name text not null unique,
                email text not null,
                password text not null,
                role text not null,
                is_allowed_to_apply text not null default 'N'
            );

            create table if not exists classes (
                class_id integer primary key autoincrement,
                class_code text not null unique,
                class_name text not null,
                course_name text not null,
                teaching_language text not null,
                teacher_user_id integer not null,
                teacher_name text not null,
                class_intro text,
                memo text,
                maximum_number_of_tas_admitted integer not null default 1,
                ta_applications_allowed text not null default 'Y',
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
                teacher_user_id integer not null,
                teacher_name text not null,
                application_reason text not null,
                resume_name text not null,
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
            """
        )

        has_users = conn.execute("select count(*) from users").fetchone()[0]
        if has_users == 0:
            conn.executemany(
                """
                insert into users (user_name, login_name, email, password, role, is_allowed_to_apply)
                values (?, ?, ?, ?, ?, ?)
                """,
                [
                    ("Alice TA", "ta1", "ta1@example.com", "123456", "TA", "Y"),
                    ("Bob TA", "ta2", "ta2@example.com", "123456", "TA", "N"),
                    ("Cathy Admin", "taadmin1", "taadmin1@example.com", "123456", "TAAdmin", "N"),
                    ("Prof Zhang", "prof1", "prof1@example.com", "123456", "Professor", "N"),
                    ("Course Admin", "courseadmin1", "courseadmin1@example.com", "123456", "CourseAdmin", "N"),
                ],
            )
            prof = conn.execute("select * from users where login_name = 'prof1'").fetchone()
            conn.execute(
                """
                insert into classes (
                    class_code, class_name, course_name, teaching_language, teacher_user_id,
                    teacher_name, class_intro, memo, maximum_number_of_tas_admitted,
                    ta_applications_allowed, semester
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "FIN101-A",
                    "金融学A班",
                    "金融学",
                    "中文",
                    prof["user_id"],
                    prof["user_name"],
                    "金融学基础教学班",
                    "周中晚课",
                    2,
                    "Y",
                    "2026Fall",
                ),
            )
            class_id = conn.execute("select class_id from classes where class_code = 'FIN101-A'").fetchone()[0]
            conn.executemany(
                """
                insert into class_schedules (class_id, lesson_date, start_time, end_time, section, is_exam)
                values (?, ?, ?, ?, ?, ?)
                """,
                [
                    (class_id, "2026-09-01", "18:30", "20:30", "晚上", None),
                    (class_id, "2026-09-08", "18:30", "20:30", "晚上", None),
                ],
            )


def get_current_user(environ):
    raw_cookie = environ.get("HTTP_COOKIE", "")
    if not raw_cookie:
        return None
    jar = cookies.SimpleCookie()
    jar.load(raw_cookie)
    session_id = jar.get("sid")
    if not session_id:
        return None
    user_id = SESSIONS.get(session_id.value)
    if not user_id:
        return None
    with db() as conn:
        user = conn.execute("select * from users where user_id = ?", (user_id,)).fetchone()
        return user


def require_role(user, roles):
    return user is not None and user["role"] in roles


def get_notice(environ):
    qs = parse_qs(environ.get("QUERY_STRING", ""))
    values = qs.get("notice")
    return values[0] if values else None


def login_page(start_response, notice=None):
    body = """
    <div class="split">
      <section class="card">
        <h2>演示账号</h2>
        <table>
          <tr><th>角色</th><th>账号</th><th>密码</th></tr>
          <tr><td>TA</td><td>ta1</td><td>123456</td></tr>
          <tr><td>TAAdmin</td><td>taadmin1</td><td>123456</td></tr>
          <tr><td>Professor</td><td>prof1</td><td>123456</td></tr>
          <tr><td>CourseAdmin</td><td>courseadmin1</td><td>123456</td></tr>
        </table>
      </section>
      <section class="card">
        <h2>登录</h2>
        <form method="post" action="/login">
          <p><label>LoginName<input name="login_name" /></label></p>
          <p><label>Password<input name="password" type="password" /></label></p>
          <button type="submit">登录</button>
        </form>
      </section>
    </div>
    """
    return text_response(start_response, "200 OK", html_page("登录", body, notice=notice))


def handle_login(environ, start_response):
    data = parse_body(environ)
    with db() as conn:
        user = conn.execute(
            "select * from users where login_name = ? and password = ?",
            (data.get("login_name", ""), data.get("password", "")),
        ).fetchone()
    if not user:
        return login_page(start_response, "账号或密码错误")
    sid = secrets.token_hex(16)
    SESSIONS[sid] = user["user_id"]
    return redirect(start_response, f"/?notice={user['user_name']} 已登录")


def logout(environ, start_response):
    raw_cookie = environ.get("HTTP_COOKIE", "")
    if raw_cookie:
        jar = cookies.SimpleCookie()
        jar.load(raw_cookie)
        sid = jar.get("sid")
        if sid:
            SESSIONS.pop(sid.value, None)
    start_response("302 Found", [("Location", "/"), ("Set-Cookie", "sid=; Path=/; Max-Age=0")])
    return [b""]


def home_page(start_response, user, notice=None):
    if not user:
        return login_page(start_response, notice)
    body = f"""
    <section class="card">
      <h2>当前用户</h2>
      <p><span class="pill">{html.escape(user['role'])}</span> {html.escape(user['user_name'])}</p>
      <p class="muted">根据角色显示对应的主流程入口。</p>
    </section>
    """
    if user["role"] == "TA":
        body += """
        <section class="grid">
          <article class="card"><h3>可申请教学班</h3><p>浏览开放课程、查看冲突并发起申请。</p><a href="/ta/classes">进入</a></article>
          <article class="card"><h3>我的申请</h3><p>查看待审、通过、拒绝和撤销记录。</p><a href="/ta/applications">进入</a></article>
        </section>
        """
    elif user["role"] == "TAAdmin":
        body += """
        <section class="grid">
          <article class="card"><h3>待初审申请</h3><p>处理 TA 初审。</p><a href="/admin/ta/pending">进入</a></article>
          <article class="card"><h3>TA 管理</h3><p>维护 TA 申请资格。</p><a href="/admin/ta/users">进入</a></article>
        </section>
        """
    elif user["role"] == "Professor":
        body += """
        <section class="card"><h3>待教授审批</h3><p>处理自己教学班的终审申请。</p><a href="/professor/pending">进入</a></section>
        """
    elif user["role"] == "CourseAdmin":
        body += """
        <section class="card"><h3>教学班管理</h3><p>新增教学班、维护排课和开放状态。</p><a href="/course/classes">进入</a></section>
        """
    headers = [("Set-Cookie", f"sid={next((k for k, v in SESSIONS.items() if v == user['user_id']), '')}; Path=/; HttpOnly")]
    return text_response(start_response, "200 OK", html_page("首页", body, user, notice), headers=headers)


def fetch_class_schedules(conn, class_id):
    return conn.execute(
        "select * from class_schedules where class_id = ? order by lesson_date, start_time",
        (class_id,),
    ).fetchall()


def schedules_html(schedules):
    if not schedules:
        return "<p class='muted'>暂无排课。</p>"
    rows = "".join(
        f"<tr><td>{html.escape(s['lesson_date'])}</td><td>{html.escape(s['start_time'])}</td><td>{html.escape(s['end_time'])}</td><td>{html.escape(s['section'])}</td><td>{html.escape(s['is_exam'] or '')}</td></tr>"
        for s in schedules
    )
    return f"<table><tr><th>日期</th><th>开始</th><th>结束</th><th>节次</th><th>考试</th></tr>{rows}</table>"


def time_overlap(start1, end1, start2, end2):
    return not (end1 <= start2 or end2 <= start1)


def get_conflicts(conn, ta_user_id, class_id):
    target_schedules = fetch_class_schedules(conn, class_id)
    apps = conn.execute(
        """
        select a.*, c.class_code from applications a
        join classes c on c.class_id = a.class_id
        where a.applier_user_id = ?
          and a.status in ('PendingTAAdmin', 'PendingProfessor', 'Approved')
          and a.class_id != ?
        """,
        (ta_user_id, class_id),
    ).fetchall()
    conflicts = []
    for app in apps:
        existing_schedules = fetch_class_schedules(conn, app["class_id"])
        overlap_points = []
        for t in target_schedules:
            for e in existing_schedules:
                if t["lesson_date"] == e["lesson_date"] and time_overlap(
                    t["start_time"], t["end_time"], e["start_time"], e["end_time"]
                ):
                    overlap_points.append(
                        f"{t['lesson_date']} {t['start_time']}-{t['end_time']} vs {e['start_time']}-{e['end_time']}"
                    )
        if overlap_points:
            conflicts.append((app, overlap_points))
    return conflicts


def ta_classes_page(start_response, user, notice=None):
    with db() as conn:
        classes = conn.execute(
            """
            select c.*,
              (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') approved_count
            from classes c
            where c.ta_applications_allowed = 'Y'
            order by c.semester, c.course_name, c.class_name
            """
        ).fetchall()
        cards = []
        for c in classes:
            conflicts = get_conflicts(conn, user["user_id"], c["class_id"])
            conflict_label = "<span class='pill bad'>有冲突</span>" if conflicts else "<span class='pill ok'>可申请</span>"
            cards.append(
                f"""
                <article class="card">
                  <h3>{html.escape(c['course_name'])} / {html.escape(c['class_name'])}</h3>
                  <p>{conflict_label} 教授：{html.escape(c['teacher_name'])} | 学期：{html.escape(c['semester'])}</p>
                  <p class="muted">授课语言：{html.escape(c['teaching_language'])} | 已通过：{c['approved_count']} / {c['maximum_number_of_tas_admitted']}</p>
                  <div class="actions">
                    <a href="/ta/classes/{c['class_id']}">查看详情</a>
                    <a href="/ta/classes/{c['class_id']}?show_conflicts=1">查看冲突</a>
                  </div>
                </article>
                """
            )
        body = "<section>" + "".join(cards) + "</section>" if cards else "<section class='card'><p>暂无开放教学班。</p></section>"
    return text_response(start_response, "200 OK", html_page("可申请教学班", body, user, notice))


def ta_class_detail_page(start_response, user, class_id, show_conflicts=False, notice=None):
    with db() as conn:
        class_row = conn.execute("select * from classes where class_id = ?", (class_id,)).fetchone()
        if not class_row or class_row["ta_applications_allowed"] != "Y":
            return text_response(start_response, "404 Not Found", html_page("未找到", "<section class='card'>教学班不存在。</section>", user))
        schedules = fetch_class_schedules(conn, class_id)
        conflicts = get_conflicts(conn, user["user_id"], class_id)
        conflict_html = ""
        if show_conflicts:
            if conflicts:
                rows = "".join(
                    f"<tr><td>{html.escape(app['class_name'])}</td><td>{html.escape(app['status'])}</td><td>{'<br>'.join(html.escape(x) for x in points)}</td></tr>"
                    for app, points in conflicts
                )
                conflict_html = f"<section class='card'><h3>冲突信息</h3><table><tr><th>已申请教学班</th><th>状态</th><th>冲突时间</th></tr>{rows}</table></section>"
            else:
                conflict_html = "<section class='card'><h3>冲突信息</h3><p class='ok'>当前无冲突。</p></section>"
        body = f"""
        <section class="card">
          <h2>{html.escape(class_row['course_name'])} / {html.escape(class_row['class_name'])}</h2>
          <p>教学班代码：{html.escape(class_row['class_code'])}</p>
          <p>教授：{html.escape(class_row['teacher_name'])} | 授课语言：{html.escape(class_row['teaching_language'])} | 学期：{html.escape(class_row['semester'])}</p>
          <p>最大录取人数：{class_row['maximum_number_of_tas_admitted']}</p>
          <p>{html.escape(class_row['class_intro'] or '')}</p>
          <p class="muted">{html.escape(class_row['memo'] or '')}</p>
        </section>
        <section class="card">
          <h3>排课信息</h3>
          {schedules_html(schedules)}
        </section>
        {conflict_html}
        <section class="card">
          <h3>提交申请</h3>
          <form method="post" action="/ta/applications">
            <input type="hidden" name="class_id" value="{class_row['class_id']}" />
            <p><label>申请原因<textarea name="application_reason" required></textarea></label></p>
            <p><label>简历文件名<input name="resume_name" placeholder="例如：alice_resume.pdf" required /></label></p>
            <button type="submit">提交申请</button>
          </form>
        </section>
        """
    return text_response(start_response, "200 OK", html_page("教学班详情", body, user, notice))


def create_application(environ, start_response, user):
    data = parse_body(environ)
    class_id = int(data.get("class_id", "0") or "0")
    reason = data.get("application_reason", "").strip()
    resume_name = data.get("resume_name", "").strip()
    if not reason or not resume_name:
        return redirect(start_response, f"/ta/classes/{class_id}?notice=申请原因和简历必填")
    with db() as conn:
        if user["is_allowed_to_apply"] != "Y":
            return redirect(start_response, "/ta/classes?notice=当前 TA 不允许申请")
        class_row = conn.execute("select * from classes where class_id = ?", (class_id,)).fetchone()
        if not class_row or class_row["ta_applications_allowed"] != "Y":
            return redirect(start_response, "/ta/classes?notice=教学班当前不开放申请")
        exists = conn.execute(
            "select 1 from applications where applier_user_id = ? and class_id = ?",
            (user["user_id"], class_id),
        ).fetchone()
        if exists:
            return redirect(start_response, f"/ta/classes/{class_id}?notice=不可重复申请")
        conflicts = get_conflicts(conn, user["user_id"], class_id)
        if conflicts:
            return redirect(start_response, f"/ta/classes/{class_id}?show_conflicts=1&notice=存在时间冲突，无法申请")
        conn.execute(
            """
            insert into applications (
                applier_user_id, applier_name, class_id, class_name, teacher_user_id,
                teacher_name, application_reason, resume_name, status, submitted_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, 'PendingTAAdmin', ?)
            """,
            (
                user["user_id"],
                user["user_name"],
                class_row["class_id"],
                class_row["class_name"],
                class_row["teacher_user_id"],
                class_row["teacher_name"],
                reason,
                resume_name,
                now_str(),
            ),
        )
    return redirect(start_response, "/ta/applications?notice=申请已提交")


def ta_applications_page(start_response, user, notice=None):
    with db() as conn:
        apps = conn.execute(
            """
            select * from applications
            where applier_user_id = ?
            order by submitted_at desc
            """,
            (user["user_id"],),
        ).fetchall()
    rows = "".join(
        f"""
        <tr>
          <td>{html.escape(app['class_name'])}</td>
          <td>{html.escape(app['submitted_at'])}</td>
          <td>{html.escape(STATUS_LABELS[app['status']])}</td>
          <td>{html.escape(app['ta_comment'] or '')}</td>
          <td>{html.escape(app['prof_comment'] or '')}</td>
          <td class="actions">
            <a href="/ta/applications/{app['application_id']}">详情</a>
            {'<form class="inline" method="post" action="/ta/applications/' + str(app['application_id']) + '/withdraw"><button class="secondary" type="submit">撤销</button></form>' if app['status'] == 'PendingTAAdmin' else ''}
          </td>
        </tr>
        """
        for app in apps
    )
    body = f"<section class='card'><h2>我的申请</h2><table><tr><th>教学班</th><th>申请时间</th><th>状态</th><th>TAAdmin 备注</th><th>Professor 备注</th><th>操作</th></tr>{rows}</table></section>"
    return text_response(start_response, "200 OK", html_page("我的申请", body, user, notice))


def ta_application_detail_page(start_response, user, application_id, notice=None):
    with db() as conn:
        app = conn.execute(
            "select * from applications where application_id = ? and applier_user_id = ?",
            (application_id, user["user_id"]),
        ).fetchone()
        if not app:
            return text_response(start_response, "404 Not Found", html_page("未找到", "<section class='card'>申请不存在。</section>", user))
        logs = conn.execute(
            "select * from approval_logs where application_id = ? order by acted_at",
            (application_id,),
        ).fetchall()
    log_rows = "".join(
        f"<tr><td>{html.escape(log['approval_stage'])}</td><td>{html.escape(log['approver_name'])}</td><td>{html.escape(log['result'])}</td><td>{html.escape(log['comments'] or '')}</td><td>{html.escape(log['acted_at'])}</td></tr>"
        for log in logs
    )
    body = f"""
    <section class="card">
      <h2>{html.escape(app['class_name'])}</h2>
      <p>当前状态：<span class="pill">{html.escape(STATUS_LABELS[app['status']])}</span></p>
      <p>申请原因：{html.escape(app['application_reason'])}</p>
      <p>简历：{html.escape(app['resume_name'])}</p>
      <p>TAAdmin 备注：{html.escape(app['ta_comment'] or '')}</p>
      <p>Professor 备注：{html.escape(app['prof_comment'] or '')}</p>
      {'<form method="post" action="/ta/applications/' + str(application_id) + '/withdraw"><button class="secondary" type="submit">撤销申请</button></form>' if app['status'] == 'PendingTAAdmin' else ''}
    </section>
    <section class="card">
      <h3>审批日志</h3>
      <table><tr><th>阶段</th><th>审批人</th><th>结果</th><th>备注</th><th>时间</th></tr>{log_rows}</table>
    </section>
    """
    return text_response(start_response, "200 OK", html_page("申请详情", body, user, notice))


def withdraw_application(start_response, user, application_id):
    with db() as conn:
        app = conn.execute(
            "select * from applications where application_id = ? and applier_user_id = ?",
            (application_id, user["user_id"]),
        ).fetchone()
        if not app:
            return redirect(start_response, "/ta/applications?notice=申请不存在")
        if app["status"] != "PendingTAAdmin":
            return redirect(start_response, "/ta/applications?notice=当前状态不可撤销")
        conn.execute(
            "update applications set status = 'Withdrawn' where application_id = ?",
            (application_id,),
        )
    return redirect(start_response, "/ta/applications?notice=申请已撤销")


def admin_ta_pending_page(start_response, user, notice=None):
    with db() as conn:
        apps = conn.execute(
            "select * from applications where status = 'PendingTAAdmin' order by submitted_at",
        ).fetchall()
    rows = "".join(
        f"""
        <tr>
          <td>{html.escape(app['applier_name'])}</td>
          <td>{html.escape(app['class_name'])}</td>
          <td>{html.escape(app['submitted_at'])}</td>
          <td>{html.escape(app['application_reason'])}</td>
          <td class="actions">
            <a href="/admin/ta/pending/{app['application_id']}">详情</a>
          </td>
        </tr>
        """
        for app in apps
    )
    body = f"<section class='card'><h2>待 TAAdmin 审批</h2><table><tr><th>申请人</th><th>教学班</th><th>申请时间</th><th>申请原因</th><th>操作</th></tr>{rows}</table></section>"
    return text_response(start_response, "200 OK", html_page("待初审申请", body, user, notice))


def admin_ta_detail_page(start_response, user, application_id, notice=None):
    with db() as conn:
        app = conn.execute("select * from applications where application_id = ?", (application_id,)).fetchone()
        if not app:
            return text_response(start_response, "404 Not Found", html_page("未找到", "<section class='card'>申请不存在。</section>", user))
    body = f"""
    <section class="card">
      <h2>{html.escape(app['applier_name'])} - {html.escape(app['class_name'])}</h2>
      <p>状态：{html.escape(STATUS_LABELS[app['status']])}</p>
      <p>申请原因：{html.escape(app['application_reason'])}</p>
      <p>简历：{html.escape(app['resume_name'])}</p>
      <form method="post" action="/admin/ta/pending/{application_id}/approve">
        <p><label>审批结果
          <select name="result">
            <option value="Approved">通过</option>
            <option value="Rejected">拒绝</option>
          </select>
        </label></p>
        <p><label>审批备注<textarea name="comments"></textarea></label></p>
        <button type="submit">提交审批</button>
      </form>
    </section>
    """
    return text_response(start_response, "200 OK", html_page("TAAdmin 审批", body, user, notice))


def approve_by_ta_admin(start_response, user, application_id, environ):
    data = parse_body(environ)
    result = data.get("result", "Rejected")
    comments = data.get("comments", "").strip()
    with db() as conn:
        app = conn.execute("select * from applications where application_id = ?", (application_id,)).fetchone()
        if not app or app["status"] != "PendingTAAdmin":
            return redirect(start_response, "/admin/ta/pending?notice=申请已被处理")
        next_status = "PendingProfessor" if result == "Approved" else "RejectedByTAAdmin"
        conn.execute(
            """
            update applications
            set status = ?, ta_comment = ?, ta_acted_at = ?
            where application_id = ? and status = 'PendingTAAdmin'
            """,
            (next_status, comments, now_str(), application_id),
        )
        conn.execute(
            """
            insert into approval_logs (application_id, approval_stage, approver_user_id, approver_name, result, comments, acted_at)
            values (?, 'TAAdmin', ?, ?, ?, ?, ?)
            """,
            (application_id, user["user_id"], user["user_name"], result, comments, now_str()),
        )
    return redirect(start_response, "/admin/ta/pending?notice=初审已完成")


def admin_ta_users_page(start_response, user, notice=None):
    with db() as conn:
        users = conn.execute(
            """
            select u.*,
              (select count(*) from applications a where a.applier_user_id = u.user_id) application_count,
              (select count(*) from applications a where a.applier_user_id = u.user_id and a.status = 'Approved') approved_count
            from users u
            where u.role = 'TA'
            order by u.user_name
            """
        ).fetchall()
    rows = "".join(
        f"""
        <tr>
          <td>{html.escape(row['user_name'])}</td>
          <td>{html.escape(row['login_name'])}</td>
          <td>{html.escape(row['email'])}</td>
          <td>{html.escape(row['is_allowed_to_apply'])}</td>
          <td>{row['application_count']}</td>
          <td>{row['approved_count']}</td>
          <td>
            <form class="inline" method="post" action="/admin/ta/users/{row['user_id']}/toggle">
              <button type="submit">{'关闭资格' if row['is_allowed_to_apply'] == 'Y' else '开启资格'}</button>
            </form>
          </td>
        </tr>
        """
        for row in users
    )
    body = f"<section class='card'><h2>TA 管理</h2><table><tr><th>姓名</th><th>账号</th><th>邮箱</th><th>允许申请</th><th>申请数</th><th>已通过</th><th>操作</th></tr>{rows}</table></section>"
    return text_response(start_response, "200 OK", html_page("TA 管理", body, user, notice))


def toggle_ta_permission(start_response, user_id):
    with db() as conn:
        row = conn.execute("select * from users where user_id = ? and role = 'TA'", (user_id,)).fetchone()
        if not row:
            return redirect(start_response, "/admin/ta/users?notice=TA 不存在")
        new_flag = "N" if row["is_allowed_to_apply"] == "Y" else "Y"
        conn.execute("update users set is_allowed_to_apply = ? where user_id = ?", (new_flag, user_id))
    return redirect(start_response, "/admin/ta/users?notice=TA 资格已更新")


def professor_pending_page(start_response, user, notice=None):
    with db() as conn:
        apps = conn.execute(
            """
            select * from applications
            where status = 'PendingProfessor' and teacher_user_id = ?
            order by submitted_at
            """,
            (user["user_id"],),
        ).fetchall()
    rows = "".join(
        f"<tr><td>{html.escape(app['applier_name'])}</td><td>{html.escape(app['class_name'])}</td><td>{html.escape(app['submitted_at'])}</td><td>{html.escape(app['ta_comment'] or '')}</td><td><a href='/professor/pending/{app['application_id']}'>详情</a></td></tr>"
        for app in apps
    )
    body = f"<section class='card'><h2>待教授审批</h2><table><tr><th>申请人</th><th>教学班</th><th>申请时间</th><th>初审备注</th><th>操作</th></tr>{rows}</table></section>"
    return text_response(start_response, "200 OK", html_page("待教授审批", body, user, notice))


def professor_detail_page(start_response, user, application_id, notice=None):
    with db() as conn:
        app = conn.execute(
            "select * from applications where application_id = ? and teacher_user_id = ?",
            (application_id, user["user_id"]),
        ).fetchone()
        if not app:
            return text_response(start_response, "404 Not Found", html_page("未找到", "<section class='card'>申请不存在。</section>", user))
        class_row = conn.execute("select * from classes where class_id = ?", (app["class_id"],)).fetchone()
        approved_count = conn.execute(
            "select count(*) from applications where class_id = ? and status = 'Approved'",
            (app["class_id"],),
        ).fetchone()[0]
    body = f"""
    <section class="card">
      <h2>{html.escape(app['applier_name'])} - {html.escape(app['class_name'])}</h2>
      <p>申请原因：{html.escape(app['application_reason'])}</p>
      <p>简历：{html.escape(app['resume_name'])}</p>
      <p>TAAdmin 备注：{html.escape(app['ta_comment'] or '')}</p>
      <p>当前录取人数：{approved_count} / {class_row['maximum_number_of_tas_admitted']}</p>
      <form method="post" action="/professor/pending/{application_id}/approve">
        <p><label>审批结果
          <select name="result">
            <option value="Approved">通过</option>
            <option value="Rejected">拒绝</option>
          </select>
        </label></p>
        <p><label>审批备注<textarea name="comments"></textarea></label></p>
        <button type="submit">提交终审</button>
      </form>
    </section>
    """
    return text_response(start_response, "200 OK", html_page("教授审批", body, user, notice))


def approve_by_professor(start_response, user, application_id, environ):
    data = parse_body(environ)
    result = data.get("result", "Rejected")
    comments = data.get("comments", "").strip()
    with db() as conn:
        app = conn.execute(
            "select * from applications where application_id = ? and teacher_user_id = ?",
            (application_id, user["user_id"]),
        ).fetchone()
        if not app or app["status"] != "PendingProfessor":
            return redirect(start_response, "/professor/pending?notice=申请已被处理")
        class_row = conn.execute("select * from classes where class_id = ?", (app["class_id"],)).fetchone()
        if result == "Approved":
            approved_count = conn.execute(
                "select count(*) from applications where class_id = ? and status = 'Approved'",
                (app["class_id"],),
            ).fetchone()[0]
            if approved_count >= class_row["maximum_number_of_tas_admitted"]:
                return redirect(start_response, f"/professor/pending/{application_id}?notice=该教学班 TA 名额已满")
        next_status = "Approved" if result == "Approved" else "RejectedByProfessor"
        conn.execute(
            """
            update applications
            set status = ?, prof_comment = ?, prof_acted_at = ?
            where application_id = ? and status = 'PendingProfessor'
            """,
            (next_status, comments, now_str(), application_id),
        )
        conn.execute(
            """
            insert into approval_logs (application_id, approval_stage, approver_user_id, approver_name, result, comments, acted_at)
            values (?, 'Professor', ?, ?, ?, ?, ?)
            """,
            (application_id, user["user_id"], user["user_name"], result, comments, now_str()),
        )
    return redirect(start_response, "/professor/pending?notice=终审已完成")


def course_classes_page(start_response, user, notice=None):
    with db() as conn:
        classes = conn.execute(
            """
            select c.*,
              (select count(*) from applications a where a.class_id = c.class_id) application_count,
              (select count(*) from applications a where a.class_id = c.class_id and a.status = 'Approved') approved_count
            from classes c
            order by c.semester, c.course_name, c.class_name
            """
        ).fetchall()
    rows = "".join(
        f"<tr><td>{html.escape(c['class_code'])}</td><td>{html.escape(c['course_name'])}</td><td>{html.escape(c['class_name'])}</td><td>{html.escape(c['teacher_name'])}</td><td>{html.escape(c['semester'])}</td><td>{c['approved_count']} / {c['maximum_number_of_tas_admitted']}</td><td>{c['application_count']}</td><td>{html.escape(c['ta_applications_allowed'])}</td></tr>"
        for c in classes
    )
    body = f"""
    <section class="card">
      <h2>新增教学班</h2>
      <form method="post" action="/course/classes/create">
        <div class="grid">
          <p><label>ClassCode<input name="class_code" required /></label></p>
          <p><label>课程名<input name="course_name" required /></label></p>
          <p><label>教学班名称<input name="class_name" required /></label></p>
          <p><label>授课语言<select name="teaching_language"><option value="中文">中文</option><option value="英文">英文</option></select></label></p>
          <p><label>Professor<select name="teacher_user_id">{professor_options()}</select></label></p>
          <p><label>学期<input name="semester" value="2026Fall" required /></label></p>
          <p><label>最大录取人数<input name="maximum_number" type="number" value="1" min="1" required /></label></p>
          <p><label>允许 TA 申请<select name="ta_allowed"><option value="Y">Y</option><option value="N">N</option></select></label></p>
          <p><label>上课日期<input name="lesson_date" value="2026-09-15" required /></label></p>
          <p><label>开始时间<input name="start_time" value="18:30" required /></label></p>
          <p><label>结束时间<input name="end_time" value="20:30" required /></label></p>
          <p><label>节次<select name="section"><option value="晚上">晚上</option><option value="下午">下午</option><option value="上午">上午</option></select></label></p>
        </div>
        <p><label>课程介绍<textarea name="class_intro"></textarea></label></p>
        <p><label>备注<textarea name="memo"></textarea></label></p>
        <button type="submit">创建教学班</button>
      </form>
    </section>
    <section class="card">
      <h2>教学班列表</h2>
      <table><tr><th>代码</th><th>课程名</th><th>教学班</th><th>教授</th><th>学期</th><th>已通过/上限</th><th>申请数</th><th>开放申请</th></tr>{rows}</table>
    </section>
    """
    return text_response(start_response, "200 OK", html_page("教学班管理", body, user, notice))


def professor_options():
    with db() as conn:
        professors = conn.execute("select * from users where role = 'Professor' order by user_name").fetchall()
    return "".join(
        f"<option value='{prof['user_id']}'>{html.escape(prof['user_name'])}</option>" for prof in professors
    )


def create_class(start_response, environ):
    data = parse_body(environ)
    try:
        maximum_number = int(data.get("maximum_number", "1"))
        teacher_user_id = int(data.get("teacher_user_id", "0"))
    except ValueError:
        return redirect(start_response, "/course/classes?notice=数字字段不合法")
    with db() as conn:
        professor = conn.execute(
            "select * from users where user_id = ? and role = 'Professor'",
            (teacher_user_id,),
        ).fetchone()
        if not professor:
            return redirect(start_response, "/course/classes?notice=Professor 不存在")
        try:
            cursor = conn.execute(
                """
                insert into classes (
                    class_code, class_name, course_name, teaching_language, teacher_user_id,
                    teacher_name, class_intro, memo, maximum_number_of_tas_admitted,
                    ta_applications_allowed, semester
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    data.get("class_code", "").strip(),
                    data.get("class_name", "").strip(),
                    data.get("course_name", "").strip(),
                    data.get("teaching_language", "中文"),
                    teacher_user_id,
                    professor["user_name"],
                    data.get("class_intro", "").strip(),
                    data.get("memo", "").strip(),
                    maximum_number,
                    data.get("ta_allowed", "Y"),
                    data.get("semester", "").strip(),
                ),
            )
        except sqlite3.IntegrityError:
            return redirect(start_response, "/course/classes?notice=ClassCode 已存在")
        conn.execute(
            """
            insert into class_schedules (class_id, lesson_date, start_time, end_time, section, is_exam)
            values (?, ?, ?, ?, ?, ?)
            """,
            (
                cursor.lastrowid,
                data.get("lesson_date", "").strip(),
                data.get("start_time", "").strip(),
                data.get("end_time", "").strip(),
                data.get("section", "晚上"),
                None,
            ),
        )
    return redirect(start_response, "/course/classes?notice=教学班已创建")


def not_found(start_response, user):
    return text_response(start_response, "404 Not Found", html_page("未找到", "<section class='card'>页面不存在。</section>", user))


def application(environ, start_response):
    init_db()
    path = urlparse(environ.get("PATH_INFO", "/")).path
    method = environ["REQUEST_METHOD"]
    notice = get_notice(environ)
    user = get_current_user(environ)

    if path == "/login" and method == "POST":
        return handle_login(environ, start_response)
    if path == "/logout":
        return logout(environ, start_response)
    if path == "/":
        return home_page(start_response, user, notice)

    if path == "/ta/classes" and require_role(user, {"TA"}):
        return ta_classes_page(start_response, user, notice)
    if path.startswith("/ta/classes/") and require_role(user, {"TA"}):
        class_id = int(path.split("/")[-1])
        show_conflicts = parse_qs(environ.get("QUERY_STRING", "")).get("show_conflicts") == ["1"]
        return ta_class_detail_page(start_response, user, class_id, show_conflicts, notice)
    if path == "/ta/applications" and method == "POST" and require_role(user, {"TA"}):
        return create_application(environ, start_response, user)
    if path == "/ta/applications" and require_role(user, {"TA"}):
        return ta_applications_page(start_response, user, notice)
    if path.startswith("/ta/applications/") and path.endswith("/withdraw") and method == "POST" and require_role(user, {"TA"}):
        application_id = int(path.split("/")[-2])
        return withdraw_application(start_response, user, application_id)
    if path.startswith("/ta/applications/") and require_role(user, {"TA"}):
        application_id = int(path.split("/")[-1])
        return ta_application_detail_page(start_response, user, application_id, notice)

    if path == "/admin/ta/pending" and require_role(user, {"TAAdmin"}):
        return admin_ta_pending_page(start_response, user, notice)
    if path.startswith("/admin/ta/pending/") and path.endswith("/approve") and method == "POST" and require_role(user, {"TAAdmin"}):
        application_id = int(path.split("/")[-2])
        return approve_by_ta_admin(start_response, user, application_id, environ)
    if path.startswith("/admin/ta/pending/") and require_role(user, {"TAAdmin"}):
        application_id = int(path.split("/")[-1])
        return admin_ta_detail_page(start_response, user, application_id, notice)
    if path == "/admin/ta/users" and require_role(user, {"TAAdmin"}):
        return admin_ta_users_page(start_response, user, notice)
    if path.startswith("/admin/ta/users/") and path.endswith("/toggle") and method == "POST" and require_role(user, {"TAAdmin"}):
        user_id = int(path.split("/")[-2])
        return toggle_ta_permission(start_response, user_id)

    if path == "/professor/pending" and require_role(user, {"Professor"}):
        return professor_pending_page(start_response, user, notice)
    if path.startswith("/professor/pending/") and path.endswith("/approve") and method == "POST" and require_role(user, {"Professor"}):
        application_id = int(path.split("/")[-2])
        return approve_by_professor(start_response, user, application_id, environ)
    if path.startswith("/professor/pending/") and require_role(user, {"Professor"}):
        application_id = int(path.split("/")[-1])
        return professor_detail_page(start_response, user, application_id, notice)

    if path == "/course/classes" and require_role(user, {"CourseAdmin"}):
        return course_classes_page(start_response, user, notice)
    if path == "/course/classes/create" and method == "POST" and require_role(user, {"CourseAdmin"}):
        return create_class(start_response, environ)

    if user is None:
        return redirect(start_response, "/?notice=请先登录")
    return not_found(start_response, user)


if __name__ == "__main__":
    init_db()
    print("Serving on http://127.0.0.1:8000")
    with make_server("127.0.0.1", 8000, application) as httpd:
        httpd.serve_forever()
