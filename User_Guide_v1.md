# TA选课申请系统 User Guide

## 1. 文档说明

本手册基于当前系统页面与实际流程整理，面向以下角色：

- `TA`
- `TAAdmin`
- `Professor`
- `CourseAdmin`

当前系统已采用新版 SAIF 风格页面，并支持桌面端与手机端访问。

## 2. 系统入口

- 本机访问：`http://127.0.0.1:3000`
- 局域网访问：`http://<你的电脑IP>:3000`

如果系统以 `HOST=0.0.0.0` 启动，局域网内其他设备也可以访问。

## 3. 登录页

登录页包含：

- SAIF 品牌页头
- 左侧系统介绍区
- 右侧登录表单

系统会根据登录用户角色自动进入对应功能主页。

## 4. 角色总览

### 4.1 TA

TA 可以：

- 浏览开放教学班
- 查看课程冲突情况
- 提交 TA 申请
- 查看和撤销自己的申请
- 维护个人简历

### 4.2 TAAdmin

TAAdmin 可以：

- 审批待初审申请
- 按教学班批量审批申请
- 查看全部申请
- 查看全部教学班
- 生成并发送 Professor 邮件
- 管理 TA 申请资格

### 4.3 Professor

Professor 可以：

- 按教学班查看待终审申请
- 查看某个教学班下的全部申请
- 对单个申请做最终审批

### 4.4 CourseAdmin

CourseAdmin 可以：

- 管理教学班
- 管理人员
- 查看全部申请
- 导入人员和教学班 Excel
- 执行批量设置

## 5. TA 使用说明

### 5.1 可申请教学班

TA 登录后进入 `可申请教学班` 页面。

页面能力：

- 按 `是否可申请`、`教授名`、`课程名称`、`教学班名称`、`授课语言` 筛选
- 以卡片方式浏览当前开放教学班
- 查看每个教学班的状态

教学班状态包括：

- `可申请`
- `有冲突`
- `已申请`

颜色说明：

- `已申请`：浅蓝色卡片
- `有冲突`：浅灰色卡片

操作说明：

- 点击 `查看详情`：进入教学班详情页
- 点击 `查看冲突`：弹出冲突信息

### 5.2 教学班详情与提交申请

在教学班详情页，TA 可以查看：

- 教学班基本信息
- 排课信息
- 冲突信息
- 当前个人简历
- 提交申请区域

系统规则：

- 申请时会自动带出 `个人资料` 中上传的最新简历
- 若存在阻断性冲突，且教学班 `不允许冲突申请`，则不能提交
- 提交后按钮会暂时变灰，避免重复点击
- 提交后可在 `我的申请` 中查看状态

示意图：

![TA申请页面](/Users/yanren/Documents/Playground/screenshots/ta_apply.png)

### 5.3 我的申请

在 `我的申请` 页面，TA 可以：

- 查看所有申请
- 查看申请详情
- 在 `待 TAAdmin 审批` 阶段撤销申请

说明：

- `撤销` 按钮会先弹出确认框
- `已撤销`、`TAAdmin拒绝`、`Professor拒绝` 的申请，后续可以再次申请

示意图：

![TA我的申请页面](/Users/yanren/Documents/Playground/screenshots/ta_my_applications.png)

### 5.4 个人资料

在 `个人资料` 页面，TA 可以上传和更新个人简历。

当前规则：

- 系统始终使用 TA 当前最新简历
- 提交申请时无需重复上传文件

## 6. TAAdmin 使用说明

### 6.1 待初审申请

在 `待初审申请` 页面，TAAdmin 可以：

- 按 `申请学生`、`教学班`、`教授` 过滤
- 查看当前待初审申请
- 单独进入某条申请详情页审批
- 多选申请后批量审批

批量审批支持：

- `通过`
- `拒绝`

说明：

- TAAdmin 通过后，申请状态会进入 `待教授审批`
- TAAdmin 拒绝后，申请状态会变为 `TAAdmin拒绝`

### 6.2 全部申请

在 `全部申请` 页面，TAAdmin 可以：

- 按 `申请学生`、`教学班`、`教授`、`状态` 过滤
- 查看全部申请记录
- 进入申请详情页

### 6.3 全部教学班

在 `全部教学班` 页面，TAAdmin 可以：

- 按 `教授名`、`教学班名称`、`TA已满`、`有待TAAdmin申请` 过滤
- 查看教学班申请数、待审批数、发布状态
- 查看排课
- 进入教学班审核页

关键字段：

- `待TAAdmin审批`
- `发布至教授`
- `TA已满`

说明：

- 若教学班后续出现新申请，系统会将 `发布至教授` 自动重置为未发送

示意图：

![TAAdmin全部教学班页面](/Users/yanren/Documents/Playground/screenshots/taadmin_classes.png)

### 6.4 按教学班审核申请

点击 `审核` 后，会进入某个教学班的申请审核页面。

页面中可以：

- 查看该教学班的全部申请
- 查看每个申请人的冲突教学班摘要
- 查看简历、备注和状态
- 批量审批该教学班所有待审申请
- 单独审批某条申请

说明：

- 已处理的申请会显示 `已处理`
- 操作列已经按新版页面统一处理

示意图：

![TAAdmin审核页面](/Users/yanren/Documents/Playground/screenshots/taadmin_review.png)

### 6.5 发布至教授与邮件预览

TAAdmin 在 `全部教学班` 页面中可：

- 勾选一个或多个教学班
- 点击 `生成邮件预览`
- 在邮件预览页检查内容
- 点击 `发送邮件`

邮件发送后：

- 系统按教授分别发送邮件
- 若一个教学班有多个教授，则每位教授都会收到
- 当前 TAAdmin 会被抄送
- 教学班 `发布至教授` 会更新为 `已发送`

只有 `发布至教授 = 已发送` 的教学班，其待教授审批申请才会出现在 Professor 页面中。

示意图：

![TAAdmin邮件预览页面](/Users/yanren/Documents/Playground/screenshots/taadmin_email_preview.png)

## 7. Professor 使用说明

### 7.1 待教授审批

Professor 登录后进入 `待教授审批` 页面。

页面按教学班维度展示待终审内容，只显示：

- 当前教授负责的教学班
- 且该教学班已被 `发布至教授`
- 且存在 `待教授审批` 申请

Professor 可点击进入某个教学班审核。

示意图：

![Professor待教授审批页面](/Users/yanren/Documents/Playground/screenshots/professor_pending.png)

### 7.2 教学班审核

在某个教学班审核页，Professor 可以查看：

- 当前已通过人数 / TA 上限
- 剩余名额
- 该教学班的全部申请
- 每条申请的 TAAdmin 备注

Professor 可点击某条申请进入最终审批。

### 7.3 最终审批规则

Professor 对申请做最终审批时：

- `通过`：状态变为 `已通过`
- `拒绝`：状态变为 `教授拒绝`

系统规则：

- 一旦教授继续通过申请并达到该教学班 TA 上限
- 系统会自动拒绝该教学班其余待审核申请
- 自动拒绝理由统一为：`该课程TA已满`

## 8. CourseAdmin 使用说明

### 8.1 人员管理

在 `人员管理` 页面，CourseAdmin 可以：

- 新增人员
- 编辑人员
- 删除人员
- 导入人员 Excel
- 按姓名、登录名、邮箱、角色、是否允许申请筛选
- 按表头排序

### 8.2 教学班管理

在 `教学班管理` 页面，CourseAdmin 可以：

- 新增教学班
- 编辑教学班
- 删除教学班
- 查看教学班关联申请
- 查看排课
- 批量开关申请权限
- 批量设置开放申请时间
- 批量删除教学班
- 导入教学班与排课 Excel

列表中会显示：

- 开放状态
- TA已满
- 已通过/上限
- 申请数
- 是否允许冲突申请

示意图：

![教学班管理页面](/Users/yanren/Documents/Playground/screenshots/courseadmin_classes.png)

### 8.3 全部申请

CourseAdmin 可以查看所有申请，并在申请详情页进行管理性状态调整，用于修正误操作或特殊情况。

## 9. 邮件与免登录链接说明

Professor 邮件通知支持：

- TAAdmin 手动生成邮件预览
- 手动点击发送
- SMTP 发信
- 教授邮件免登录链接

当前规则：

- 免登录链接会跳转到 `待教授审批`
- 链接有效期有限
- 为避免错误地址，系统优先使用 `PUBLIC_BASE_URL`

## 10. 常见状态说明

### 10.1 申请状态

- `待 TAAdmin 审批`
- `TAAdmin 拒绝`
- `待教授审批`
- `教授拒绝`
- `已通过`
- `已撤销`

### 10.2 教学班相关状态

- `开放中`
- `未开始`
- `已过期`
- `已关闭`
- `TA已满`
- `发布至教授 = 否 / 已发送`

## 11. 推荐测试路径

建议按以下顺序验证主流程：

1. TA 登录，进入 `可申请教学班`
2. 提交一条申请
3. TAAdmin 在 `待初审申请` 中审批通过
4. TAAdmin 在 `全部教学班` 中生成邮件预览并发送给 Professor
5. Professor 通过免登录链接或正常登录进入 `待教授审批`
6. Professor 完成最终审批
7. TA 在 `我的申请` 中查看最终结果

## 12. 当前截图索引

本手册当前使用的页面截图包括：

- [TA申请页面](/Users/yanren/Documents/Playground/screenshots/ta_apply.png)
- [TA我的申请页面](/Users/yanren/Documents/Playground/screenshots/ta_my_applications.png)
- [TAAdmin全部教学班页面](/Users/yanren/Documents/Playground/screenshots/taadmin_classes.png)
- [TAAdmin审核页面](/Users/yanren/Documents/Playground/screenshots/taadmin_review.png)
- [TAAdmin邮件预览页面](/Users/yanren/Documents/Playground/screenshots/taadmin_email_preview.png)
- [Professor待教授审批页面](/Users/yanren/Documents/Playground/screenshots/professor_pending.png)
- [教学班管理页面](/Users/yanren/Documents/Playground/screenshots/courseadmin_classes.png)
