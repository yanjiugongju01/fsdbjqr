# dog-watch 飞书机器人 · 部署手册

这是一个通过 GitHub + Supabase 搭建的飞书机器人，接收群里 @ 指令并回复。

## 架构
- **Supabase Edge Function**（`supabase/functions/dogwatch/`）：接收飞书回调、回复"收到"
- **GitHub**（`yanjiugongju01/fsdbjqr`）：存代码
- **飞书开放平台**：dog-watch 应用，事件订阅指向 Supabase

## 当前状态：最小闭环版
只做一件事：收到 @ 指令后回复"收到"。用于验证全链路。
（搬运文档/文字、语音朗读：等最小闭环跑通后在此代码基础上扩展）

## 部署步骤（由豆包代写代码，你按需操作）

### 一、推代码到 GitHub
1. 在项目目录初始化并推送
2. 仓库：`https://github.com/yanjiugongju01/fsdbjqr`

### 二、部署到 Supabase
1. 安装 Supabase CLI
2. `supabase link --project-ref nsrpehlkadklyniqcfdj`
3. 设置环境变量：
   - `FEISHU_APP_ID`：dog-watch 应用的 App ID（飞书开放平台→应用凭证）
   - `FEISHU_APP_SECRET`：dog-watch 应用的 App Secret
4. `supabase functions deploy dogwatch`

### 三、配置飞书事件订阅
1. 飞书开放平台 dog-watch 应用 → 事件与回调
2. 订阅方式：Webhook
3. 请求地址：`https://nsrpehlkadklyniqcfdj.supabase.co/functions/v1/dogwatch`
4. 添加事件 `im.message.receive_v1`（接收消息）

### 四、发布应用
- 版本管理与发布 → 创建新版本 → 申请发布 → 审核通过
- 需开启权限：im:message、im:chat:read 等（后续扩展时再加）

## 后续扩展（跑通后再做）
- 搬运文档/文字到指定群
- edge-tts 语音朗读
- 需要增加飞书权限 scope
