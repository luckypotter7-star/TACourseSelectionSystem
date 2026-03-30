# TA选课系统 Windows 服务器部署手册 v1

## 1. 适用范围

本手册适用于当前 TA 选课系统的 Windows 服务器部署版本。  
当前系统技术栈如下：

- Node.js
- SQLite
- 服务端渲染 HTML
- 文件上传目录：`uploads/`
- 静态资源目录：`assets/`
- 邮件发送：SMTP

当前项目核心文件：

- 启动文件：`server.js`
- 依赖文件：`package.json`
- 数据库文件：`ta_system_node.db`
- 上传目录：`uploads`
- 资源目录：`assets`
- 配置文件：`.env.local`

## 2. 部署目标

部署完成后，应达到以下效果：

1. 用户可通过服务器地址或正式域名访问 TA 系统。
2. 系统可稳定运行，不依赖手工打开命令行窗口。
3. 附件上传、邮件通知、日志与数据库可持续保存。
4. 服务器重启后，系统可自动恢复运行。

## 3. 部署前准备

### 3.1 服务器信息确认

请先确认以下信息：

- 服务器操作系统版本
- 是否有管理员权限
- 服务器内网 IP
- 是否有公网访问需求
- 是否已有正式域名
- 是否计划启用 HTTPS

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
│   ├── assets
│   ├── uploads
│   ├── ta_system_node.db
│   └── .env.local
├── logs
└── backups
```

说明：

- `app`：应用主目录
- `logs`：运行日志目录
- `backups`：数据库与附件备份目录

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

### 4.3 PM2

用于管理 Node 进程。

安装命令：

```powershell
npm install -g pm2
```

确认命令：

```powershell
pm2 -v
```

### 4.4 IIS 与 URL Rewrite（推荐）

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

## 6. 准备运行文件

### 6.1 数据库文件

当前系统使用 SQLite。  
请将现有数据库文件复制到：

```text
D:\TASystem\app\ta_system_node.db
```

如果不复制，系统会按当前代码初始化空库或种子数据。

### 6.2 上传目录

请确认目录存在：

```text
D:\TASystem\app\uploads
```

若不存在，请创建：

```powershell
mkdir D:\TASystem\app\uploads
```

### 6.3 静态资源目录

请确认目录存在：

```text
D:\TASystem\app\assets
```

此目录中应包含当前使用的 SAIF Logo 等资源文件。

## 7. 配置 `.env.local`

在 `D:\TASystem\app` 下创建：

```text
.env.local
```

建议至少包含以下配置：

```env
HOST=0.0.0.0
PORT=3000
PUBLIC_BASE_URL=https://你的正式域名

SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=你的邮箱
SMTP_PASS=你的SMTP授权码
SMTP_FROM=你的邮箱
```

说明：

- `HOST=0.0.0.0`：允许其他机器访问
- `PORT=3000`：Node 服务监听端口
- `PUBLIC_BASE_URL`：邮件链接、免登录链接等使用的外部访问地址
- SMTP 配置：用于系统邮件发送

如果当前没有正式域名，可临时写成：

```env
PUBLIC_BASE_URL=http://服务器IP:3000
```

但正式环境建议使用：

- 正式域名
- HTTPS

## 8. 本机直接启动测试

先在服务器上直接启动，确认系统本身可运行：

```powershell
cd D:\TASystem\app
node server.js
```

若控制台显示类似：

```text
Server running at http://0.0.0.0:3000
```

说明服务已经启动。

然后在服务器本机浏览器访问：

```text
http://127.0.0.1:3000
```

再从内网其他电脑访问：

```text
http://服务器IP:3000
```

## 9. 防火墙放行

如果其他机器无法访问，请检查 Windows 防火墙。

可放行 3000 端口：

```powershell
New-NetFirewallRule -DisplayName "TA System 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

如果后续走 IIS 反向代理，通常只需开放：

- 80
- 443

## 10. 使用 PM2 守护进程

### 10.1 启动应用

```powershell
cd D:\TASystem\app
pm2 start server.js --name ta-system
```

### 10.2 查看状态

```powershell
pm2 status
```

### 10.3 查看日志

```powershell
pm2 logs ta-system
```

### 10.4 重启应用

```powershell
pm2 restart ta-system
```

### 10.5 停止应用

```powershell
pm2 stop ta-system
```

## 11. Windows 开机自动启动

Windows 下 PM2 开机自启不如 Linux 简单，建议用以下两种方式之一。

### 方案 A：使用 PM2 + 启动脚本

可在系统启动后自动执行：

```powershell
pm2 resurrect
```

然后通过“任务计划程序”在开机时运行该命令。

### 方案 B：使用 NSSM（推荐）

安装 NSSM 后，将 Node 服务注册为 Windows 服务。

示例：

- Application：`C:\Program Files\nodejs\node.exe`
- Startup directory：`D:\TASystem\app`
- Arguments：`server.js`

优点：

- 更符合 Windows 服务管理方式
- 更稳定
- 可配合服务自动重启

如果你后面决定正式上线，我建议优先使用：

- IIS 反向代理
- NSSM 管理 Node 服务

## 12. 配置 IIS 反向代理（推荐正式环境）

### 12.1 IIS 作用

IIS 负责：

- 对外暴露正式域名
- 处理 HTTPS 证书
- 将请求转发到 Node `3000`

### 12.2 推荐架构

```text
浏览器 -> IIS(80/443) -> Node.js(127.0.0.1:3000)
```

### 12.3 IIS 配置要点

1. 在 IIS 中新建站点，绑定域名
2. 安装并启用：
   - URL Rewrite
   - ARR
3. 配置反向代理到：

```text
http://127.0.0.1:3000
```

4. 绑定 HTTPS 证书

### 12.4 为什么建议用 IIS

原因：

- 统一对外入口
- 更容易接 HTTPS
- 未来若接 SSO，更容易满足回调地址要求
- 正式域名管理更规范

## 13. 正式上线前检查清单

上线前建议逐项确认：

### 13.1 基础访问

- 首页可访问
- 本地登录正常
- 各角色能正常进入首页

### 13.2 核心流程

- TA 可提交申请
- TA 可撤销申请
- TAAdmin 可审批
- 教学班可发布至 Professor
- Professor 可终审
- 名额满后可自动拒绝其他申请

### 13.3 管理功能

- 教学班新增/编辑/删除正常
- 人员新增/编辑/删除正常
- Excel 导入人员正常
- Excel 导入教学班正常

### 13.4 邮件与通知

- TA 提交申请后，TAAdmin 收到邮件
- TAAdmin 审批后，TA 收到邮件
- Professor 审批后，TA 收到邮件
- 站内通知同步正常

### 13.5 附件

- 个人简历上传正常
- 申请附件引用正常
- 下载附件正常

### 13.6 日志与审计

- 审计日志可查看
- 申请业务日志可查看
- 申请日志列表页可筛选

## 14. 备份策略

当前系统至少要备份以下内容：

### 14.1 SQLite 数据库

```text
D:\TASystem\app\ta_system_node.db
```

### 14.2 上传附件

```text
D:\TASystem\app\uploads
```

### 14.3 配置文件

```text
D:\TASystem\app\.env.local
```

### 14.4 备份频率建议

建议：

- 数据库：每日备份
- uploads：每日备份
- `.env.local`：修改后立即备份

## 15. 当前阶段建议部署方案

基于你当前系统成熟度，建议按下面顺序推进：

1. 先在 Windows 服务器上以内网方式部署
2. 先用 SQLite 跑正式试运行
3. 先把邮件、附件、日志、权限都验证稳定
4. 再考虑：
   - IIS + HTTPS
   - 正式域名
   - SSO
   - MySQL

## 16. 下一步建议

完成本手册后，建议下一步继续输出：

1. Windows 服务器部署检查清单
2. IIS 反向代理配置模板
3. `.env.local` 正式环境模板
4. 备份与恢复手册

