# TA 选课系统

一个基于 Node 服务端渲染的 TA 申请与审批系统，当前默认使用 MySQL 运行，并保留 SQLite 兼容回退能力。

## 启动

```bash
./node-v22.22.1-darwin-arm64/bin/node server.js
```

启动后访问 [http://127.0.0.1:3000](http://127.0.0.1:3000)。

如果你需要临时回退到 SQLite：

```bash
DB_CLIENT=sqlite ./node-v22.22.1-darwin-arm64/bin/node server.js
```

## 数据库

- 默认：`MySQL`
- 回退：`SQLite`
- MySQL 配置请填写在 `.env.local`
- 配置模板见 `.env.local.example`

## 演示账号

- `ta1 / 123456`
- `taadmin1 / 123456`
- `prof1 / 123456`
- `courseadmin1 / 123456`

## 当前已实现

- 登录与按角色导航
- TA 查看开放教学班
- TA 冲突校验与提交申请
- TA 个人简历维护与自动带出
- TA 查看申请并撤销
- TAAdmin 审批
- TAAdmin 发布至 Professor 与邮件通知
- Professor 审批与名额限制
- CourseAdmin 教学班、人员、报表、审计、导入导出
- 邮件通知与站内通知
- 移动端适配

## 说明

- Node 二进制放在 `node-v22.22.1-darwin-arm64/`
- SQLite 数据库存储在 `ta_system_node.db`
- 上传附件存储在 `uploads/`
- 静态资源存储在 `assets/`
- 当前为服务端渲染 HTML
- 简历附件仅支持 `pdf/doc/docx`，大小不超过 `5MB`
