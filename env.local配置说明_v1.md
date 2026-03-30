# TA选课系统 `.env.local` 配置说明 v1

## 1. 适用范围

本说明用于统一当前 TA 选课系统的运行配置方式。  
当前项目默认从项目根目录读取：

```text
.env.local
```

当前系统默认以 **MySQL** 作为运行数据库。  
SQLite 仅保留为兼容回退和本地调试用途。

建议：

- 开发环境、本机测试环境、服务器正式环境都使用同一个文件名
- 不同环境只修改值，不修改字段名
- 正式环境以 MySQL 配置为准

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
# 数据库
DB_CLIENT=mysql

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_mysql_password
MYSQL_DATABASE=ta_system
MYSQL_CONNECTION_LIMIT=10

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

### 4.1 `DB_CLIENT`

用途：

- 指定当前应用使用的数据库类型

建议值：

- 默认：`mysql`
- 临时回退：`sqlite`

说明：

- 当前正式部署建议固定为 `mysql`
- 若需要临时兼容调试，可显式设为 `sqlite`

### 4.2 `MYSQL_HOST`

用途：

- MySQL 服务地址

示例：

```env
MYSQL_HOST=127.0.0.1
```

### 4.3 `MYSQL_PORT`

用途：

- MySQL 服务端口

默认值：

```env
MYSQL_PORT=3306
```

### 4.4 `MYSQL_USER`

用途：

- MySQL 登录账号

示例：

```env
MYSQL_USER=root
```

### 4.5 `MYSQL_PASSWORD`

用途：

- MySQL 登录密码

说明：

- 正式环境应使用受控账号，不建议长期使用高权限 root 账号

### 4.6 `MYSQL_DATABASE`

用途：

- 当前系统使用的数据库名

建议值：

```env
MYSQL_DATABASE=ta_system
```

### 4.7 `MYSQL_CONNECTION_LIMIT`

用途：

- MySQL 连接池大小

建议值：

- 默认可使用 `10`
- 并发较高时可根据服务器资源再调整

### 4.8 `HOST`

用途：

- 控制 Node 服务监听地址

建议值：

- 本机调试：`127.0.0.1`
- 局域网访问/服务器部署：`0.0.0.0`

说明：

- 如果要让内网其他设备访问，必须使用 `0.0.0.0`

### 4.9 `PORT`

用途：

- 控制 Node 服务监听端口

建议值：

- 默认：`3000`

说明：

- 如果后续通过 IIS 反向代理，也可以继续保持 `3000`

### 4.10 `PUBLIC_BASE_URL`

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

### 4.11 `SMTP_HOST`

用途：

- SMTP 服务器地址

示例：

```env
SMTP_HOST=smtp.qq.com
```

### 4.12 `SMTP_PORT`

用途：

- SMTP 端口

常见值：

- `465`：SSL
- `587`：TLS/STARTTLS

当前 QQ 邮箱示例：

```env
SMTP_PORT=465
```

### 4.13 `SMTP_SECURE`

用途：

- 是否使用安全 SMTP 连接

常见值：

- `true`
- `false`

当前 QQ 邮箱示例：

```env
SMTP_SECURE=true
```

### 4.14 `SMTP_USER`

用途：

- 发信账号

### 4.15 `SMTP_PASS`

用途：

- SMTP 密码或授权码

说明：

- QQ 邮箱应填写 SMTP 授权码
- 不建议直接写邮箱网页登录密码

### 4.16 `SMTP_FROM`

用途：

- 邮件发件人地址

建议：

- 与 `SMTP_USER` 保持一致

### 4.17 `MAIL_USE_SENDMAIL`

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
DB_CLIENT=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=你的MySQL密码
MYSQL_DATABASE=ta_system
MYSQL_CONNECTION_LIMIT=10
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
DB_CLIENT=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=你的MySQL密码
MYSQL_DATABASE=ta_system
MYSQL_CONNECTION_LIMIT=10
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
DB_CLIENT=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=ta_system_user
MYSQL_PASSWORD=你的正式数据库密码
MYSQL_DATABASE=ta_system
MYSQL_CONNECTION_LIMIT=10
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

## 6. 当前建议

基于当前系统状态，推荐你后续统一采用：

1. `DB_CLIENT=mysql`
2. 开发、测试、正式环境只调整连接参数和访问地址
3. 保留 `DB_CLIENT=sqlite` 仅作为临时应急回退方案
