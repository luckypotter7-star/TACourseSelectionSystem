# TA选课系统 Windows 服务器拉取 GitHub 代码操作手册 v1

## 1. 适用场景

这份手册适用于当前这种情况：

- 你已经有一台 Windows Server
- 服务器上已经安装好了 MySQL
- 你准备把 TA 选课系统代码从 GitHub 拉到服务器
- 你的服务器只有 `C` 盘

这份手册的目标是：

1. 在服务器上创建合适的项目目录
2. 安装拉代码所需的软件
3. 从 GitHub 拉取当前项目代码
4. 安装 Node 依赖
5. 为下一步启动系统做好准备

---

## 2. 先确认你需要准备什么

在开始前，请确认服务器上已经具备：

- Windows Server 可正常登录
- 你有管理员权限
- MySQL 已安装完成

还需要额外准备：

- Node.js 22
- Git for Windows

如果这两样还没装，请先装。

---

## 3. 推荐目录结构（只有 C 盘版本）

因为你的服务器只有 `C` 盘，所以建议统一放到：

```text
C:\TASystem
```

建议目录结构如下：

```text
C:\TASystem
├── app
├── logs
└── backups
```

说明：

- `app`：项目代码目录
- `logs`：运行日志目录
- `backups`：数据库、附件、配置备份目录

---

## 4. 第一步：安装 Node.js

### 4.1 下载 Node.js

建议安装：

- **Node.js 22 LTS**

安装完成后，打开 PowerShell，执行：

```powershell
node -v
npm -v
```

预期：

- 能看到版本号

例如：

```text
v22.x.x
10.x.x
```

如果这里报错，说明 Node 还没装好，先不要继续下面步骤。

---

## 5. 第二步：安装 Git

### 5.1 下载 Git for Windows

安装完成后，打开 PowerShell，执行：

```powershell
git --version
```

预期：

- 能看到 Git 版本号

如果这里报错，说明 Git 还没装好。

---

## 6. 第三步：创建项目目录

在 PowerShell 里执行：

```powershell
mkdir C:\TASystem
mkdir C:\TASystem\app
mkdir C:\TASystem\logs
mkdir C:\TASystem\backups
```

执行完成后，你可以打开资源管理器确认这几个目录已经存在。

---

## 7. 第四步：从 GitHub 拉代码

### 7.1 进入代码目录

在 PowerShell 中执行：

```powershell
cd C:\TASystem\app
```

### 7.2 从 GitHub 克隆代码

当前仓库地址是：

- [TACourseSelectionSystem](https://github.com/luckypotter7-star/TACourseSelectionSystem)

执行：

```powershell
git clone https://github.com/luckypotter7-star/TACourseSelectionSystem.git .
```

注意最后这个点号：

```text
.
```

它的意思是：

- 把代码直接拉到当前目录 `C:\TASystem\app`

如果你不写这个点号，Git 会再多建一层子目录。

### 7.3 拉取完成后的结果

拉取完成后，`C:\TASystem\app` 目录下应该能看到类似文件：

- `server.js`
- `package.json`
- `package-lock.json`
- `config`
- `db`
- `scripts`
- `assets`

---

## 8. 如果 GitHub 拉取失败怎么办

### 8.1 常见情况一：服务器不能访问 GitHub

如果你的服务器网络不能直接访问 GitHub，会出现：

- `Could not resolve host`
- 超时
- 连接失败

这时有 2 种替代方式：

#### 方式 A：本地打包后上传

你可以在自己的电脑上把项目目录压缩，再上传到服务器：

```text
/Users/yanren/Documents/Playground
```

上传到：

```text
C:\TASystem\app
```

#### 方式 B：下载 ZIP 包后上传

也可以在本地浏览器打开 GitHub 项目，下载 ZIP，然后复制到服务器解压。

---

### 8.2 常见情况二：提示目录非空

如果执行 `git clone ... .` 时提示目录非空，通常是因为：

- `C:\TASystem\app` 里已经有文件

处理方式：

- 确认里面不是重要文件
- 清空后再执行

或者重新建一个空目录。

---

## 9. 第五步：安装项目依赖

进入项目目录：

```powershell
cd C:\TASystem\app
```

执行：

```powershell
npm install
```

这一步会安装当前项目依赖，例如：

- `mysql2`
- `xlsx`
- `nodemailer`

安装完成后，目录下会出现：

```text
node_modules
```

---

## 10. 第六步：确认关键文件是否存在

拉完代码、装完依赖后，请确认下面这些路径存在：

```text
C:\TASystem\app\server.js
C:\TASystem\app\package.json
C:\TASystem\app\db\mysql_schema.sql
C:\TASystem\app\scripts\init_mysql.js
C:\TASystem\app\scripts\migrate_sqlite_to_mysql.js
C:\TASystem\app\assets
```

如果这些文件都在，说明代码下载是完整的。

---

## 11. 第七步：创建 `.env.local`

在：

```text
C:\TASystem\app
```

目录下新建：

```text
.env.local
```

先写成这样：

```env
DB_CLIENT=mysql

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=ta_system_user
MYSQL_PASSWORD=你的数据库密码
MYSQL_DATABASE=ta_system
MYSQL_CONNECTION_LIMIT=10

HOST=127.0.0.1
PORT=3000
PUBLIC_BASE_URL=http://你的服务器IP

SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=你的邮箱
SMTP_PASS=你的SMTP授权码
SMTP_FROM=你的邮箱

MAIL_USE_SENDMAIL=N
```

说明：

- `DB_CLIENT=mysql`：当前系统默认走 MySQL
- `HOST=127.0.0.1`：配合 IIS 反向代理时更稳
- `PORT=3000`：Node 内部服务端口
- `PUBLIC_BASE_URL`：先写你当前服务器的可访问地址

---

## 12. 第八步：初始化 MySQL 表结构

进入项目目录：

```powershell
cd C:\TASystem\app
```

执行：

```powershell
node scripts\init_mysql.js
```

如果成功，应该看到：

```text
MySQL schema initialized successfully.
```

这一步非常关键。  
只把代码拉下来还不够，必须让 MySQL 表结构建出来。

---

## 13. 第九步：如果你有旧数据，再做迁移

如果你已有旧的 SQLite 数据，可以执行：

```powershell
node scripts\migrate_sqlite_to_mysql.js
```

如果你现在只是第一次部署，没有旧数据，这一步可以先跳过。

---

## 14. 第十步：先本机启动测试

进入项目目录：

```powershell
cd C:\TASystem\app
```

执行：

```powershell
node server.js
```

如果启动正常，控制台应看到类似：

```text
TA system MVP running at http://127.0.0.1:3000
[db] 默认数据库：MySQL。当前主流程、管理主链、报表、审计与导入已切换到 MySQL。
```

然后在服务器本机浏览器打开：

```text
http://127.0.0.1:3000
```

如果首页能打开，说明：

- 代码已下载成功
- 依赖已安装成功
- `.env.local` 已生效
- MySQL 连接已成功

---

## 15. 第十一步：为后续 IIS 反代做准备

你前面说服务器不允许直接用 `3000` 对外暴露。  
这没关系，正确做法是：

- Node 自己继续监听 `127.0.0.1:3000`
- IIS 对外提供：
  - `80`
  - 或 `443`
- IIS 再反代到：
  - `http://127.0.0.1:3000`

也就是说：

- `3000` 只在服务器本机内部使用
- 外部用户不会直接访问 `3000`

---

## 16. 你现在做完这份手册后，应该达到什么状态

如果你按上面做完，当前应当达到：

1. 服务器上有：
   - `C:\TASystem\app`
2. GitHub 代码已拉到本地
3. `npm install` 已完成
4. `.env.local` 已建立
5. `node scripts\init_mysql.js` 已成功
6. `node server.js` 已能启动

这时你就已经完成了：

- **代码下载和基础运行准备**

下一步就可以进入：

- IIS 反向代理
- PM2 托管
- 内网访问测试

---

## 17. 初学者最容易犯的错

### 17.1 目录建错

最常见的是把代码拉到：

```text
C:\TASystem
```

而不是：

```text
C:\TASystem\app
```

建议按这份手册固定用：

```text
C:\TASystem\app
```

---

### 17.2 `.env.local` 没建在项目根目录

必须放在：

```text
C:\TASystem\app\.env.local
```

不是：

- `C:\TASystem\.env.local`
- 也不是别的子目录

---

### 17.3 只建了数据库，没初始化表

很多人做到：

- MySQL 装好了
- `ta_system` 建好了

就以为可以了。  
实际上还必须执行：

```powershell
node scripts\init_mysql.js
```

---

### 17.4 用错数据库账号密码

如果 `.env.local` 里的：

- `MYSQL_USER`
- `MYSQL_PASSWORD`

写错了，Node 启动时会直接连不上 MySQL。

---

## 18. 一句话总结

对你当前这台只有 `C` 盘的 Windows Server，最推荐的做法就是：

1. 建目录：
   - `C:\TASystem\app`
2. 从 GitHub 拉代码到这里
3. 执行 `npm install`
4. 配 `.env.local`
5. 执行 `node scripts\init_mysql.js`
6. 执行 `node server.js`

只要这几步完成，TA 系统的代码侧部署准备就已经到位了。
