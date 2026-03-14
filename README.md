# TA 选课系统 MVP

一个基于 Node 标准库和 SQLite 的轻量 MVP，用来验证 TA 申请、两级审批和教学班管理主流程。

## 启动

```bash
./node-v22.22.1-darwin-arm64/bin/node server.js
```

启动后访问 [http://127.0.0.1:3000](http://127.0.0.1:3000)。

## 演示账号

- `ta1 / 123456`
- `taadmin1 / 123456`
- `prof1 / 123456`
- `courseadmin1 / 123456`

## 当前已实现

- 登录与按角色导航
- TA 查看开放教学班
- TA 冲突校验与提交申请
- TA 上传简历附件
- TA 查看申请并撤销
- TAAdmin 审批
- Professor 审批与名额限制
- CourseAdmin 新增教学班和查看列表

## 说明

- Node 二进制放在 `node-v22.22.1-darwin-arm64/`
- 数据库存储在 `ta_system_node.db`
- 上传附件存储在 `uploads/`
- 当前为服务端渲染 HTML
- 简历附件仅支持 `pdf/doc/docx`，大小不超过 `5MB`
