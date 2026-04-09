# Windows Server MySQL 安装设置手册（初学者版）v1

## 1. 这份手册适合谁

这份手册是给 **第一次在 Windows Server 上安装 MySQL** 的人准备的。  
目标不是讲原理，而是让你按步骤操作，最后能把 MySQL 装好，并给 TA 选课系统使用。

如果你现在的状态是：

- Windows Server 刚装好
- MySQL 安装包刚下载好或刚开始安装
- 还不太清楚每一步该怎么选

那这份手册就是给你的。

---

## 2. 先确认你需要安装什么

对当前 TA 系统，我们建议安装：

- **MySQL Community Server 8.4 LTS**

如果你用的是 Windows 的图形安装器，通常会看到：

- `MySQL Installer`
- `MySQL Server 8.4`

你这次最重要的是：

- **把 MySQL Server 装好**

其他像：

- MySQL Workbench
- MySQL Shell
- Documentation

都不是必须的。  
如果你已经有 DBeaver，那么更不必为了图形管理再额外依赖 Workbench。

---

## 3. 安装前准备

在正式安装前，先准备这几样：

### 3.1 管理员权限

你需要使用：

- Windows 管理员账号

因为安装 MySQL 服务时，需要写入系统服务。

### 3.2 确认端口

默认 MySQL 端口是：

```text
3306
```

你可以先按默认值，不需要改。

### 3.3 如果安装器提示缺少 VC++ 运行库

你前面已经遇到过这个提示：

```text
This application requires Visual Studio 2019 x64 Redistributable
```

这时要先安装：

- **Microsoft Visual C++ Redistributable for Visual Studio 2015–2022 (x64)**

装完后再回到 MySQL 安装器继续。

---

## 4. 安装 MySQL 时每一步怎么选

下面按最常见的 MySQL Windows 安装器流程来写。

### 4.1 选择安装类型

如果安装器问你：

- `Developer Default`
- `Server only`
- `Client only`
- `Full`
- `Custom`

对服务器来说，建议选：

```text
Server only
```

原因：

- 你当前最核心是把数据库服务装起来
- 不需要装一大堆开发工具

如果你已经在安装器里，没看到这个选项，也没关系，只要最终能确保 `MySQL Server 8.4` 被安装即可。

---

### 4.2 Type and Networking（类型和网络）

安装过程中通常会让你选：

- `Config Type`
- `Connectivity`
- `Port`

建议这样选：

#### Config Type

选：

```text
Server Computer
```

如果没有这个选项，也可以选最接近“服务器”的那个。

#### Connectivity

保持勾选：

- `TCP/IP`

#### Port

填：

```text
3306
```

如果 `3306` 没被占用，就不要改。

#### Open Windows Firewall for network access

如果你未来需要别的机器访问这个 MySQL，可以勾选。  
如果你暂时只让本机应用访问，也可以先不勾。

对当前 TA 系统，如果：

- MySQL 和 Node 应用部署在同一台 Windows Server

那 **不开放外部 MySQL 端口也完全可以**。  
这是更稳更安全的做法。

---

### 4.3 Authentication Method（认证方式）

安装器一般会问你认证方式。

建议选：

```text
Use Strong Password Encryption
```

也就是默认推荐的强密码方式。

不要为了图省事切到旧版兼容模式，除非你后面真的碰到客户端兼容问题。  
你现在的 Node 项目用 `mysql2`，通常没有必要退回旧模式。

---

### 4.4 Accounts and Roles（账号和角色）

这一步最重要的是：

- 给 `root` 设一个你记得住、但足够强的密码

建议：

- 先把 `root` 密码记到安全地方
- 不要跳过这一步

例如你至少要保证：

- 有大写字母
- 有小写字母
- 有数字
- 最好有特殊字符

这里先只配：

- `root`

后面我们再另外创建一个专门给 TA 系统使用的应用账号。  
这样比直接长期用 root 跑应用更规范。

---

### 4.5 Windows Service（Windows 服务）

安装器通常会问：

- 服务名
- 是否开机自启动
- 运行账户

建议这样选：

#### 服务名

默认即可，例如：

```text
MySQL84
```

#### Start the MySQL Server at System Startup

建议：

```text
勾选
```

这样服务器重启后 MySQL 会自动起来。

#### Run Windows Service as

一般保持默认即可。  
初学者阶段不建议在这里做复杂自定义。

---

### 4.6 Apply Configuration（应用配置）

这一步会执行：

- 写配置
- 初始化数据库目录
- 注册 Windows 服务
- 启动 MySQL 服务

你只需要点：

```text
Execute
```

然后等全部显示成功。

如果有某一步失败，先不要硬往下点，把报错记下来。

---

## 5. 安装完成后先做的 3 个检查

安装完不要急着接项目，先确认 MySQL 自己是好的。

### 5.1 检查 MySQL 命令能否使用

在 PowerShell 里执行：

```powershell
mysql --version
```

如果能看到版本号，说明客户端基本可用。

---

### 5.2 检查服务是否运行

执行：

```powershell
Get-Service *mysql*
```

你应该看到类似：

- `Running`

如果不是运行状态，可以尝试：

```powershell
Start-Service MySQL84
```

注意：

- 服务名不一定是 `MySQL84`
- 以你机器上的实际服务名为准

---

### 5.3 用 root 登录一次

执行：

```powershell
mysql -u root -p
```

输入你刚才安装时设置的 root 密码。

登录成功后，执行：

```sql
SELECT VERSION();
SHOW DATABASES;
```

如果能正常返回结果，说明 MySQL 已经装好并能使用。

---

## 6. 为 TA 系统创建数据库

登录 MySQL 后，执行：

```sql
CREATE DATABASE IF NOT EXISTS ta_system
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
```

然后确认：

```sql
SHOW DATABASES LIKE 'ta_system';
```

这一步的目的是：

- 给 TA 系统单独准备数据库

---

## 7. 为 TA 系统创建专用账号

不建议让 Node 应用长期直接用 root。

建议执行：

```sql
CREATE USER IF NOT EXISTS 'ta_system_user'@'localhost' IDENTIFIED BY '你的正式数据库密码';
GRANT ALL PRIVILEGES ON ta_system.* TO 'ta_system_user'@'localhost';
FLUSH PRIVILEGES;
```

说明：

- 如果 MySQL 和 TA 系统在同一台服务器，`localhost` 就够了
- 这样后面应用连接更规范

然后你可以试一下这个账号：

```sql
EXIT;
```

再登录：

```powershell
mysql -u ta_system_user -p
```

登录后执行：

```sql
SHOW DATABASES;
USE ta_system;
```

只要能进入 `ta_system`，就说明这个应用账号已经可以用了。

---

## 8. 给 TA 系统准备 `.env.local`

在项目目录下创建：

```text
D:\TASystem\app\.env.local
```

推荐内容：

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

这一步的重点是：

- `DB_CLIENT=mysql`
- `MYSQL_*` 这几项一定要填对

---

## 9. 初始化 TA 系统表结构

进入项目目录：

```powershell
cd D:\TASystem\app
```

执行：

```powershell
node scripts\init_mysql.js
```

如果成功，你会看到类似：

```text
MySQL schema initialized successfully.
```

这一步会根据项目里的：

```text
db\mysql_schema.sql
```

自动创建系统需要的表。

---

## 10. 如果你有旧数据，执行迁移

如果你已经在本地或测试环境里用过 SQLite，希望把旧数据带到 MySQL：

```powershell
node scripts\migrate_sqlite_to_mysql.js
```

执行前建议：

- 先备份当前 MySQL 空库
- 先备份原 SQLite 数据

---

## 11. 启动 TA 系统测试

在项目目录执行：

```powershell
node server.js
```

如果一切正常，你会看到类似：

```text
TA system MVP running at http://0.0.0.0:3000
[db] 默认数据库：MySQL。当前主流程、管理主链、报表、审计与导入已切换到 MySQL。
```

然后浏览器访问：

```text
http://127.0.0.1:3000
```

如果首页能打开，说明：

- MySQL 已能被应用正常连接

---

## 12. 初学者最容易踩的坑

### 12.1 忘记记 root 密码

解决方式：

- 安装时就记录
- 不要装完才临时想

### 12.2 `.env.local` 没放到项目根目录

当前项目是从：

```text
项目根目录\.env.local
```

读取配置的。  
如果放错位置，应用就会连不上 MySQL。

### 12.3 建了数据库，但没执行 `init_mysql.js`

只建 `ta_system` 数据库还不够。  
你还必须执行：

```powershell
node scripts\init_mysql.js
```

否则表不会自动出现。

### 12.4 用错数据库账号

例如：

- `.env.local` 里写的是 `ta_system_user`
- 但这个账号没有权限

这时应用就会报登录 MySQL 失败。

### 12.5 想让别的机器访问 MySQL

对当前 TA 系统，如果：

- Node 应用和 MySQL 在同一台服务器

那通常不需要开放 MySQL 到外网或内网。  
应用直接连：

```text
127.0.0.1:3306
```

会更安全。

---

## 13. 最推荐的实际顺序

如果你现在刚装完 MySQL，我建议你按这个顺序做：

1. `mysql --version`
2. `Get-Service *mysql*`
3. `mysql -u root -p`
4. 创建 `ta_system`
5. 创建 `ta_system_user`
6. 配 `.env.local`
7. 执行 `node scripts\init_mysql.js`
8. 如果有旧数据，执行 `node scripts\migrate_sqlite_to_mysql.js`
9. 执行 `node server.js`
10. 打开浏览器验证首页

---

## 14. 一句话结论

对你当前这套 TA 系统来说，Windows Server 上的 MySQL 安装设置，最关键就三步：

1. **把 MySQL 服务装好并能登录**
2. **创建 `ta_system` 数据库和应用账号**
3. **在项目里配好 `.env.local` 并执行 `node scripts\init_mysql.js`**

只要这三步做对了，后面 TA 系统连上 MySQL 就不会太难。
