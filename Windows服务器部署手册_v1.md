# TA选课系统 Windows 服务器部署手册 v1

## 1. 适用范围

本手册适用于当前 TA 选课系统的 Windows 服务器部署版本。  
当前系统默认以 **MySQL** 作为主数据库运行，并保留 SQLite 兼容回退能力。

当前项目技术栈如下：

- Node.js 22
- MySQL 8.4 LTS 或更稳定的企业可用版本
- 服务端渲染 HTML
- 文件上传目录：`uploads/`
- 静态资源目录：`assets/`
- 邮件发送：SMTP

当前项目核心文件：

- 启动文件：`server.js`
- 依赖文件：`package.json`
- MySQL 结构脚本：`db/mysql_schema.sql`
- 上传目录：`uploads`
- 资源目录：`assets`
- 配置文件：`.env.local`

## 2. 部署目标

部署完成后，应达到以下效果：

1. 用户可通过服务器地址或正式域名访问 TA 系统。
2. 系统默认连接 MySQL 数据库运行。
3. 附件上传、邮件通知、日志与数据库可持续保存。
4. 服务器重启后，系统可自动恢复运行。
5. 后续可继续接入 IIS / HTTPS / 域名 / SSO。

## 3. 部署前准备

### 3.1 服务器信息确认

请先确认以下信息：

- 服务器操作系统版本
- 是否有管理员权限
- 服务器内网 IP
- 是否有公网访问需求
- 是否已有正式域名
- 是否计划启用 HTTPS
- MySQL 是否计划与应用部署在同一台服务器

建议至少准备：

- 一台可远程桌面登录的 Windows Server
- 管理员权限
- 一个固定部署目录，例如：`D:\TASystem`

### 3.2 建议目录结构

建议部署目录如下：

```text
D:\TASystem
├── app
│   ├── server.js
│   ├── package.json
│   ├── package-lock.json
│   ├── config
│   ├── db
│   ├── scripts
│   ├── assets
│   ├── uploads
│   └── .env.local
├── logs
└── backups
```

说明：

- `app`：应用主目录
- `logs`：运行日志目录
- `backups`：数据库、附件和配置备份目录

## 4. 软件安装清单

Windows 服务器上建议安装以下软件：

### 4.1 Node.js

建议安装 Node.js 22 LTS。

安装完成后，在 `PowerShell` 中确认：

```powershell
node -v
npm -v
```

### 4.2 Git

用于从 GitHub 拉取代码。

确认命令：

```powershell
git --version
```

### 4.3 MySQL Server

建议安装：

- **MySQL Community Server 8.4 LTS**

安装建议：

- 端口：`3306`
- 字符集：后续建库时统一使用 `utf8mb4`
- 为 TA 系统单独创建数据库，例如：`ta_system`

安装完成后，建议确认：

```powershell
mysql --version
```

### 4.4 PM2

用于管理 Node 进程。

安装命令：

```powershell
npm install -g pm2
```

确认命令：

```powershell
pm2 -v
```

### 4.5 IIS 与 URL Rewrite（推荐）

如果计划使用正式域名和 HTTPS，建议启用：

- IIS
- URL Rewrite
- Application Request Routing（ARR）

用途：

- 反向代理到 Node 服务
- 处理 80/443 对外访问
- 配置 HTTPS 证书

## 5. 获取代码

### 5.1 创建部署目录

```powershell
mkdir D:\TASystem
mkdir D:\TASystem\app
mkdir D:\TASystem\logs
mkdir D:\TASystem\backups
```

### 5.2 拉取代码

如果服务器能直接访问 GitHub：

```powershell
cd D:\TASystem\app
git clone https://github.com/luckypotter7-star/TACourseSelectionSystem.git .
```

如果已经有代码压缩包，也可以直接复制到 `D:\TASystem\app`。

### 5.3 安装依赖

```powershell
cd D:\TASystem\app
npm install
```

## 6. 准备数据库

### 6.1 创建 MySQL 数据库

建议创建：

```sql
CREATE DATABASE ta_system CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 6.2 初始化表结构

在项目根目录执行：

```powershell
node scripts\init_mysql.js
```

该脚本会根据：

```text
db\mysql_schema.sql
```

初始化当前系统的 MySQL 表结构。

### 6.3 迁移现有 SQLite 数据（如有）

如果你已有本地或测试环境的 SQLite 数据，希望迁到 MySQL，可执行：

```powershell
node scripts\migrate_sqlite_to_mysql.js
```

执行前建议先备份 SQLite 数据和 MySQL 空库。

## 7. 准备运行目录

### 7.1 上传目录

请确认目录存在：

```text
D:\TASystem\app\uploads
```

若不存在，请创建：

```powershell
mkdir D:\TASystem\app\uploads
```

### 7.2 静态资源目录

请确认目录存在：

```text
D:\TASystem\app\assets
```

此目录中应包含当前使用的 SAIF Logo 等资源文件。

## 8. 配置 `.env.local`

在 `D:\TASystem\app` 下创建：

```text
.env.local
```

建议至少包含以下配置：

```env
DB_CLIENT=mysql

HOST=0.0.0.0
PORT=3000
PUBLIC_BASE_URL=https://你的正式域名

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=你的MySQL账号
MYSQL_PASSWORD=你的MySQL密码
MYSQL_DATABASE=ta_system
MYSQL_CONNECTION_LIMIT=10

SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=你的邮箱
SMTP_PASS=你的SMTP授权码
SMTP_FROM=你的邮箱

MAIL_USE_SENDMAIL=N
```

说明：

- `DB_CLIENT=mysql`：当前正式环境默认值
- `HOST=0.0.0.0`：允许其他机器访问
- `PORT=3000`：Node 服务监听端口
- `PUBLIC_BASE_URL`：邮件链接、免登录链接等使用的外部访问地址
- `MYSQL_*`：MySQL 连接配置
- SMTP 配置：用于系统邮件发送

如果当前没有正式域名，可临时写成：

```env
PUBLIC_BASE_URL=http://服务器IP:3000
```

但正式环境建议使用：

- 正式域名
- HTTPS

## 9. 本机直接启动测试

先在服务器上直接启动，确认系统本身可运行：

```powershell
cd D:\TASystem\app
node server.js
```

若控制台显示类似：

```text
TA system MVP running at http://0.0.0.0:3000
[db] 默认数据库：MySQL。当前主流程、管理主链、报表、审计与导入已切换到 MySQL。
```

说明服务已经启动。

然后在服务器本机浏览器访问：

```text
http://127.0.0.1:3000
```

## 10. 局域网访问测试

如果要让内网其他电脑访问，请确认：

1. `.env.local` 中 `HOST=0.0.0.0`
2. Windows 防火墙已允许对应端口
3. 服务器网络策略允许内网访问

然后从其他电脑访问：

```text
http://服务器IP:3000
```

## 11. 使用 PM2 管理服务

### 11.1 启动

```powershell
cd D:\TASystem\app
pm2 start server.js --name ta-system
```

### 11.2 查看状态

```powershell
pm2 status
```

### 11.3 查看日志

```powershell
pm2 logs ta-system
```

### 11.4 保存进程列表

```powershell
pm2 save
```

### 11.5 配置开机自启动

Windows 下可结合：

- `pm2 startup`
- 或任务计划程序
- 或 `nssm`

如果你们服务器运维规范更偏 Windows 原生服务，推荐后续再评估 `nssm` 方案。

## 12. 通过 IIS 反向代理（推荐）

正式环境建议：

- IIS 对外提供 `80/443`
- Node 服务仍监听 `3000`
- IIS 反代到 `http://127.0.0.1:3000`

推荐原因：

- 更容易绑定正式域名
- 更容易接 HTTPS
- 更利于后续接 SSO
- 更适合生产发布

## 13. 上线前检查项

上线前建议至少逐项确认：

1. 本地登录正常
2. TA 申请正常
3. TAAdmin 审批正常
4. Professor 审批正常
5. 教学班管理正常
6. 人员管理正常
7. 导入导出正常
8. 审计日志正常
9. 报表页面正常
10. SMTP 发信正常
11. 附件上传、下载正常
12. MySQL 数据库连接稳定
13. 备份目录已准备

## 14. 当前推荐备份对象

当前默认 MySQL 部署下，重点备份对象为：

1. MySQL 数据库 `ta_system`
2. `uploads/`
3. `.env.local`
4. `assets/`

说明：

- 当前数据库已不再以 SQLite 为默认生产方案
- 备份数据库时建议使用 `mysqldump`

例如：

```powershell
mysqldump -h 127.0.0.1 -P 3306 -u root -p ta_system > D:\TASystem\backups\daily\ta_system_2026-03-30.sql
```

## 15. 推荐上线顺序

建议按这个顺序推进：

1. 安装 Node / Git / MySQL / PM2
2. 拉代码并安装依赖
3. 配置 `.env.local`
4. 初始化 MySQL
5. 如有旧数据，则执行迁移
6. 本机启动测试
7. 内网访问测试
8. PM2 托管
9. IIS / HTTPS / 域名接入
10. 上线前全量回归

## 16. 当前结论

就当前系统状态而言，Windows 服务器部署建议已经从：

- `SQLite 本地文件部署`

切换为：

- `MySQL 默认部署`

SQLite 仅建议保留为：

- 本地快速回退
- 历史兼容
- 紧急调试
