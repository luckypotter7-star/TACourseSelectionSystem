# Windows服务器 HTTPS 配置手册 v1

本文档适用于当前 TA 选课系统在 Windows Server 上的部署场景：

- Node 应用已可通过 `http://localhost:8080` 访问
- 应用默认使用 MySQL
- 你希望外部用户通过 HTTPS 访问系统

推荐的正式结构：

- IIS 对外提供 `80 / 443`
- Node 仅监听本机，例如 `127.0.0.1:8080`
- IIS 反向代理到 Node

---

## 1. 部署目标

最终希望实现：

- 浏览器访问：`https://你的域名`
- IIS 接收请求
- IIS 转发到：`http://127.0.0.1:8080`
- Node 返回 TA 系统页面

如果你暂时没有域名，也可以先做证书和 IIS 配置预演，但正式 HTTPS 通常建议使用域名。

---

## 2. 前置条件

开始前请确认以下条件已满足：

1. Windows Server 已安装 IIS
2. Node 应用可在服务器本机通过 `http://localhost:8080` 打开
3. PM2 已能正常运行 `ta-system`
4. 外部用户已经能通过公网 IP 访问 HTTP 版本
5. 如需正式 HTTPS，建议已准备好域名

---

## 3. 推荐的 `.env.local`

正式使用 IIS 反向代理时，建议服务器上的 `.env.local` 至少这样配置：

```env
DB_CLIENT=mysql

HOST=127.0.0.1
PORT=8080
PUBLIC_BASE_URL=https://你的域名

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=ta_system_user
MYSQL_PASSWORD=你的数据库密码
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

注意：

- `HOST=127.0.0.1`
  说明 Node 只接受本机请求，由 IIS 转发
- `PUBLIC_BASE_URL`
  一定要写用户最终访问的 HTTPS 地址
- 后续邮件链接、免登录链接、SSO 回调都会依赖这个地址

---

## 4. 安装 IIS 反向代理组件

在 Windows Server 上，IIS 做反向代理通常需要这两个组件：

1. URL Rewrite
2. Application Request Routing（ARR）

安装后，在 IIS Manager 中应能看到：

- `URL Rewrite`
- `Application Request Routing Cache`

---

## 5. 启用 ARR 代理功能

打开 `IIS Manager`：

1. 选中左侧服务器根节点
2. 打开 `Application Request Routing Cache`
3. 点击右侧 `Server Proxy Settings`
4. 勾选：

```text
Enable proxy
```

5. 点击 `Apply`

如果这一步没做，IIS 不会把请求转发给 Node。

---

## 6. 创建 IIS 站点

在 IIS 中：

1. 右键 `Sites`
2. 选择 `Add Website`

建议填写：

- Site name: `TASystem`
- Physical path: `C:\TASystem\wwwroot`
- Binding type: `http`
- IP: `All Unassigned`
- Port: `80`
- Host name: 你的域名（如果还没有域名可先留空）

说明：

- `Physical path` 可以是一个空目录
- 这个站点主要用于接收请求和做反向代理

---

## 7. 配置 HTTP 到 Node 的反向代理

选中 IIS 站点 `TASystem`：

1. 打开 `URL Rewrite`
2. 选择 `Add Rule(s)...`
3. 选择 `Blank rule`

按下面填写：

### Name

```text
ReverseProxyToNode
```

### Match URL

- Requested URL: `Matches the Pattern`
- Using: `Regular Expressions`
- Pattern:

```text
(.*)
```

### Action

- Action type: `Rewrite`
- Rewrite URL:

```text
http://127.0.0.1:8080/{R:1}
```

勾选：

- `Append query string`

保存后，IIS 收到的请求就会转给 Node。

---

## 8. 先验证 HTTP 反向代理

先不要急着配 HTTPS，先验证 HTTP 路径。

### 8.1 确认 PM2 正在运行

```powershell
cd C:\TASystem\App
pm2 status
```

### 8.2 如果没启动，先启动

```powershell
pm2 start server.js --name ta-system
pm2 save
```

### 8.3 本机测试

在服务器本机打开：

```text
http://localhost
```

如果 IIS 反代配置正确，你应该看到 TA 系统首页，而不是 IIS 默认页。

---

## 9. 申请和绑定 HTTPS 证书

### 方案 A：已有正式证书

如果你已有：

- `.pfx` 证书文件
- 证书密码

可以直接在 IIS 里导入。

导入方式：

1. 打开 `Server Certificates`
2. 点击右侧 `Import`
3. 选择 `.pfx`
4. 输入密码
5. 导入完成

### 方案 B：使用 Let’s Encrypt（推荐）

如果你有正式域名，并且域名已经解析到这台服务器，推荐使用：

- `win-acme`

它适合 Windows + IIS 场景，能自动申请和续期证书。

基本流程：

1. 下载 `win-acme`
2. 运行 `wacs.exe`
3. 选择 IIS 站点
4. 选择你的域名
5. 完成 HTTP 验证
6. 自动签发并绑定证书

如果你后面需要，我可以单独再给你写一份 `win-acme` 的详细手册。

---

## 10. 在 IIS 绑定 HTTPS

证书准备好后：

1. 选中 `TASystem` 站点
2. 点击右侧 `Bindings...`
3. 点击 `Add`

建议填写：

- Type: `https`
- IP: `All Unassigned`
- Port: `443`
- Host name: 你的域名
- SSL certificate: 选择刚导入的证书

保存后，HTTPS 入口就具备了。

---

## 11. 将 HTTP 自动跳转到 HTTPS

推荐在 IIS 中增加一个重定向规则。

在站点的 `URL Rewrite` 中再新建规则：

### Name

```text
ForceHttps
```

### Match URL

```text
(.*)
```

### Conditions

添加条件：

- Condition input:

```text
{HTTPS}
```

- Pattern:

```text
^OFF$
```

### Action

- Action type: `Redirect`
- Redirect URL:

```text
https://{HTTP_HOST}/{R:1}
```

- Append query string: 勾选
- Redirect type: `Permanent (301)`

注意：

- 这个规则要放在反向代理规则前面更稳

---

## 12. 最终访问地址

到这一步，你的系统最终应通过：

```text
https://你的域名
```

访问。

不再建议继续对外暴露：

```text
http://公网IP:8080
```

---

## 13. 端口放行建议

正式 HTTPS 场景建议只放行：

- `80`
- `443`

不建议长期对外放行：

- `8080`

因为 Node 应仅供 IIS 本机转发。

---

## 14. 配置完成后的检查清单

完成后请逐项检查：

1. `http://localhost` 能打开 TA 系统
2. `https://你的域名` 能打开 TA 系统
3. 访问 `http://你的域名` 会自动跳转到 HTTPS
4. 邮件里的链接是 HTTPS 地址
5. 附件下载是 HTTPS 地址
6. 登录、通知、上传简历、邮件发送都正常

---

## 15. 与 SSO 的关系

后续如果你要接入 OAuth2 / SSO，HTTPS 很重要。

建议在接 SSO 之前，先把：

```text
PUBLIC_BASE_URL=https://你的域名
```

配置好，并确保外部可以通过 HTTPS 访问。

这样后续 SSO 回调地址就可以稳定写成：

```text
https://你的域名/login/sso/callback
```

这会比使用 IP 地址和 HTTP 稳定很多。

---

## 16. 当前最推荐的上线结构

推荐最终结构：

- IIS：对外 80 / 443
- Node：`127.0.0.1:8080`
- MySQL：`127.0.0.1:3306`
- 外部访问：`https://你的域名`

这是当前这套 TA 系统最适合正式部署的方式。
