# TA选课系统 `.env.local` 配置说明 v1

## 1. 适用范围

本说明用于统一当前 TA 选课系统的运行配置方式。  
当前项目默认从项目根目录读取：

```text
.env.local
```

建议：

- 开发环境、本机测试环境、服务器正式环境都使用同一个文件名
- 不同环境只修改值，不修改字段名

## 2. 文件位置

本地开发环境：

```text
/Users/yanren/Documents/Playground/.env.local
```

Windows 服务器建议位置：

```text
D:\TASystem\app\.env.local
```

## 3. 当前统一推荐模板

```env
# 服务监听
HOST=0.0.0.0
PORT=3000

# 系统对外访问地址
PUBLIC_BASE_URL=http://127.0.0.1:3000

# 邮件发送
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your_account@qq.com
SMTP_PASS=your_smtp_passcode
SMTP_FROM=your_account@qq.com

# 如果明确使用系统 sendmail，可改为 Y；一般正式环境建议继续用 SMTP
MAIL_USE_SENDMAIL=N
```

## 4. 字段说明

### 4.1 `HOST`

用途：

- 控制 Node 服务监听地址

建议值：

- 本机调试：`127.0.0.1`
- 局域网访问/服务器部署：`0.0.0.0`

说明：

- 如果要让内网其他设备访问，必须使用 `0.0.0.0`

### 4.2 `PORT`

用途：

- 控制 Node 服务监听端口

建议值：

- 默认：`3000`

说明：

- 如果后续通过 IIS 反向代理，也可以继续保持 `3000`

### 4.3 `PUBLIC_BASE_URL`

用途：

- 生成系统内的外部访问链接
- 用于邮件中的跳转地址
- 用于免登录链接的基础域名

开发环境示例：

```env
PUBLIC_BASE_URL=http://127.0.0.1:3000
```

内网测试示例：

```env
PUBLIC_BASE_URL=http://172.16.132.196:3000
```

正式环境示例：

```env
PUBLIC_BASE_URL=https://ta.saif.sjtu.edu.cn
```

说明：

- 这个值必须是“用户真正访问系统的地址”
- 不要写成 `0.0.0.0`
- 正式环境推荐使用 `https + 正式域名`

### 4.4 `SMTP_HOST`

用途：

- SMTP 服务器地址

示例：

```env
SMTP_HOST=smtp.qq.com
```

### 4.5 `SMTP_PORT`

用途：

- SMTP 端口

常见值：

- `465`：SSL
- `587`：TLS/STARTTLS

当前 QQ 邮箱示例：

```env
SMTP_PORT=465
```

### 4.6 `SMTP_SECURE`

用途：

- 是否使用安全 SMTP 连接

常见值：

- `true`
- `false`

当前 QQ 邮箱示例：

```env
SMTP_SECURE=true
```

### 4.7 `SMTP_USER`

用途：

- 发信账号

示例：

```env
SMTP_USER=179038726@qq.com
```

### 4.8 `SMTP_PASS`

用途：

- SMTP 密码或授权码

说明：

- QQ 邮箱应填写 SMTP 授权码
- 不建议直接写邮箱网页登录密码

### 4.9 `SMTP_FROM`

用途：

- 邮件发件人地址

建议：

- 与 `SMTP_USER` 保持一致

示例：

```env
SMTP_FROM=179038726@qq.com
```

### 4.10 `MAIL_USE_SENDMAIL`

用途：

- 是否改用系统 sendmail

建议值：

- 常规环境：`N`
- 只有明确要走系统邮件代理时才设为 `Y`

说明：

- 当前项目已经实测 SMTP 正常可用
- 一般不建议正式环境切到 sendmail

## 5. 按场景推荐配置

### 5.1 本机开发

```env
HOST=127.0.0.1
PORT=3000
PUBLIC_BASE_URL=http://127.0.0.1:3000
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=你的邮箱
SMTP_PASS=你的授权码
SMTP_FROM=你的邮箱
MAIL_USE_SENDMAIL=N
```

### 5.2 内网测试

```env
HOST=0.0.0.0
PORT=3000
PUBLIC_BASE_URL=http://服务器内网IP:3000
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=你的邮箱
SMTP_PASS=你的授权码
SMTP_FROM=你的邮箱
MAIL_USE_SENDMAIL=N
```

### 5.3 正式部署

```env
HOST=0.0.0.0
PORT=3000
PUBLIC_BASE_URL=https://你的正式域名
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=你的邮箱
SMTP_PASS=你的授权码
SMTP_FROM=你的邮箱
MAIL_USE_SENDMAIL=N
```

## 6. 当前系统实际依赖这些字段的功能

### 6.1 `PUBLIC_BASE_URL` 影响的功能

- 教授邮件中的系统链接
- 免登录审核链接
- 所有邮件中的系统访问地址

### 6.2 SMTP 相关字段影响的功能

- TA 提交申请后通知 TAAdmin
- TAAdmin 审批后通知 TA
- Professor 审批后通知 TA
- 发布教学班给 Professor 的邮件

### 6.3 `HOST/PORT` 影响的功能

- 是否能从内网访问系统
- Node 服务监听地址

## 7. 配置检查建议

修改 `.env.local` 后，建议检查以下几点：

1. 服务是否能正常启动
2. 系统首页是否可访问
3. 邮件是否可成功发送
4. 邮件中的链接是否跳转正确
5. 内网其他设备是否可访问

## 8. 修改 `.env.local` 后的操作

修改完成后，需要重启服务，配置才会生效。

本机启动示例：

```bash
cd /Users/yanren/Documents/Playground
HOST=0.0.0.0 ./node-v22.22.1-darwin-arm64/bin/node server.js
```

Windows 服务器示例：

```powershell
cd D:\TASystem\app
pm2 restart ta-system
```

## 9. 配置文件管理建议

建议遵守以下规则：

1. `.env.local` 不提交到 GitHub
2. 正式环境与测试环境分别备份
3. 修改后记录修改时间和用途
4. SMTP 授权码变更后及时同步更新

