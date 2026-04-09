# TA选课系统 Windows 服务器 MySQL 初始化操作清单 v1

## 1. 目标

这份清单用于在 Windows 服务器上完成 TA 选课系统的 MySQL 初始化准备。  
适用于当前项目默认以 **MySQL** 作为主数据库运行的版本。

完成后应达到以下结果：

1. Windows 服务器已安装并启动 MySQL
2. `ta_system` 数据库已创建
3. 项目表结构已初始化
4. Node 应用可使用 `.env.local` 正常连接 MySQL
5. 如有旧数据，可将 SQLite 数据迁入 MySQL

## 2. 前置条件

开始前请确认：

- 已登录 Windows 服务器
- 具备管理员权限
- 已安装 Node.js 22
- 已安装 Git
- 已安装 MySQL Server 8.4 LTS
- 项目代码已放到：

```text
D:\TASystem\app
```

## 3. 检查 MySQL 是否已安装并启动

在 PowerShell 中执行：

```powershell
mysql --version
```

预期：

- 能返回 MySQL 版本号

再确认 MySQL 服务是否已运行：

```powershell
Get-Service *mysql*
```

预期：

- MySQL 服务状态为 `Running`

如果未启动，可在“服务”中启动，或执行：

```powershell
Start-Service MySQL84
```

说明：

- 服务名可能不是 `MySQL84`
- 以你服务器实际安装后的服务名为准

## 4. 使用 root 登录 MySQL

在 PowerShell 中执行：

```powershell
mysql -u root -p
```

输入安装时设置的 root 密码。

登录成功后，可先执行：

```sql
SELECT VERSION();
SHOW DATABASES;
```

## 5. 创建数据库

在 MySQL 命令行中执行：

```sql
CREATE DATABASE IF NOT EXISTS ta_system
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
```

然后确认：

```sql
SHOW DATABASES LIKE 'ta_system';
```

## 6. 建议创建专用应用账号

正式环境不建议长期让 Node 应用直接使用 root。  
建议创建专用账号，例如：

```sql
CREATE USER IF NOT EXISTS 'ta_system_user'@'localhost' IDENTIFIED BY '你的正式数据库密码';
GRANT ALL PRIVILEGES ON ta_system.* TO 'ta_system_user'@'localhost';
FLUSH PRIVILEGES;
```

说明：

- 如果应用和 MySQL 在同一台服务器，`localhost` 即可
- 如果应用和数据库分离部署，再按实际来源地址授权

## 7. 配置 `.env.local`

在项目目录：

```text
D:\TASystem\app
```

创建或更新：

```text
.env.local
```

推荐最小配置：

```env
DB_CLIENT=mysql

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=ta_system_user
MYSQL_PASSWORD=你的正式数据库密码
MYSQL_DATABASE=ta_system
MYSQL_CONNECTION_LIMIT=10

HOST=0.0.0.0
PORT=3000
PUBLIC_BASE_URL=http://服务器IP:3000

SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=你的邮箱
SMTP_PASS=你的SMTP授权码
SMTP_FROM=你的邮箱

MAIL_USE_SENDMAIL=N
```

## 8. 初始化表结构

进入项目目录：

```powershell
cd D:\TASystem\app
```

执行：

```powershell
node scripts\init_mysql.js
```

预期输出类似：

```text
MySQL schema initialized successfully.
```

说明：

- 当前脚本会读取项目根目录下的 `.env.local`
- 并执行：

```text
db\mysql_schema.sql
```

## 9. 验证表结构是否创建成功

进入 MySQL 后执行：

```sql
USE ta_system;
SHOW TABLES;
```

当前预期至少应看到这些核心表：

- `users`
- `classes`
- `class_schedules`
- `applications`
- `approval_logs`
- `notifications`
- `audit_logs`
- `login_tokens`

## 10. 如有旧数据，执行数据迁移

如果你已经有现成 SQLite 数据，想迁到 MySQL，在项目目录执行：

```powershell
node scripts\migrate_sqlite_to_mysql.js
```

说明：

- 该脚本会读取当前项目下的 SQLite 数据文件
- 并按项目现有逻辑迁入 MySQL
- 执行前建议先备份空库或当前目标库

## 11. 验证迁移结果

迁移后进入 MySQL，执行：

```sql
USE ta_system;
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM classes;
SELECT COUNT(*) FROM applications;
```

如果这些表有正确数据，说明迁移已基本完成。

## 12. 启动应用验证 MySQL 连接

在项目目录执行：

```powershell
node server.js
```

当前预期启动日志类似：

```text
TA system MVP running at http://0.0.0.0:3000
[db] 默认数据库：MySQL。当前主流程、管理主链、报表、审计与导入已切换到 MySQL。
[db] 如需临时回退 SQLite，可在启动前显式设置 DB_CLIENT=sqlite。
```

说明：

- 如果这里没有报 MySQL 连接错误，说明应用侧已成功连库

## 13. 最小验证清单

应用启动后，建议至少验证：

1. 首页能打开
2. 本地登录正常
3. TA 可申请教学班页正常
4. TAAdmin 待审批页正常
5. Professor 待审批页正常
6. CourseAdmin 教学班管理页正常
7. 报表页正常
8. 审计日志页正常

## 14. 常见问题排查

### 14.1 `Access denied for user`

说明：

- `.env.local` 中的 `MYSQL_USER / MYSQL_PASSWORD` 不正确
- 或该账号没有访问 `ta_system` 的权限

处理：

- 重新检查账号密码
- 重新执行 `GRANT`

### 14.2 `Unknown database 'ta_system'`

说明：

- 数据库还没创建
- 或 `.env.local` 中数据库名写错

处理：

- 先执行第 5 步建库

### 14.3 `MySQL schema initialized successfully.` 未出现

说明：

- `scripts\init_mysql.js` 没成功连接数据库
- 或 `.env.local` 未正确放置

处理：

- 先确认 `.env.local` 在项目根目录
- 再检查 MySQL 服务是否启动

### 14.4 启动应用时报连接失败

说明：

- Node 应用未能读取到正确的 MySQL 配置

处理：

- 检查 `.env.local`
- 检查 MySQL 服务和端口
- 检查数据库名和账号权限

## 15. 当前建议顺序

建议按这个顺序执行：

1. 检查 MySQL 服务
2. 登录 MySQL
3. 创建 `ta_system`
4. 创建应用账号
5. 配置 `.env.local`
6. 执行 `node scripts\init_mysql.js`
7. 如有旧数据，执行 `node scripts\migrate_sqlite_to_mysql.js`
8. 启动 `node server.js`
9. 做最小功能验证

## 16. 当前结论

对你当前项目来说，Windows 服务器上的 MySQL 初始化最关键的是三件事：

1. `ta_system` 数据库必须先创建
2. `.env.local` 必须填写正确
3. 必须执行一次 `node scripts\init_mysql.js`

只要这三步完成，应用就已经具备以 MySQL 方式启动的基础条件。
