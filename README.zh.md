# 飞书远程 Codex 助手

这个项目把飞书自建应用机器人连接到运行在云端的 Codex。服务通过飞书 WebSocket 长连接接收消息，不需要公网回调地址，也不依赖个人电脑常开。

架构：

```text
飞书用户 -> 飞书机器人 -> 飞书 WebSocket -> 远程 Node.js 服务
                                                   |
                                                   +-> Codex SDK / Codex CLI
                                                   +-> /data 持久化工作区和会话
```

## 1. 创建飞书应用

需要 Node.js 20.12 或更高版本。

```bash
npm install
npm run setup
```

终端会输出一个飞书授权链接。用飞书打开该链接，确认创建应用。脚本会自动申请：

- 机器人能力
- `im.message.receive_v1` 接收消息事件
- `im:message.p2p_msg:readonly`
- `im:message.group_at_msg:readonly`
- `im:message:send_as_bot`

成功后，App ID、App Secret 和应用创建者的 Open ID 会写入 `.env.lark`。该文件已经被 `.gitignore` 忽略。

创建后，在飞书开放平台检查应用版本和可用范围。企业环境通常还需要管理员审核并发布版本。

## 2. 配置远程运行

推荐使用一台长期在线的 Linux 云主机，例如 1 vCPU、2 GB 内存起步，并挂载持久化磁盘。飞书长连接需要常驻进程，不适合普通短生命周期 Serverless 函数。

复制示例配置：

```bash
cp .env.example .env
```

至少填写：

```dotenv
CODEX_ACCESS_TOKEN=...
CODEX_MODEL=gpt-5.5
```

Codex 访问令牌适合在远程无人值守环境中认证。官方文档说明，个人访问令牌目前面向 ChatGPT Business 和 Enterprise 工作区；服务账号适合组织级自动化。没有这类令牌时，可以在远程 Codex home 目录中完成一次交互式登录，再持久化 `/home/node/.codex`。

`CODEX_MODEL` 会作为每次运行的显式模型参数传给 Codex，因此不会随 Codex 应用里的当前对话设置或全局默认模型变化。

## 3. 启动服务

安装 Docker 和 Compose 后，在项目目录执行：

```bash
docker compose up -d --build
docker compose logs -f
```

健康检查：

```bash
curl http://127.0.0.1:3000/readyz
```

机器人连上飞书后，创建者可以直接私聊机器人。群聊默认关闭，以防机器人被加入群后对所有群消息执行任务。

## 4. 开放群聊

先把机器人加入群，并发送一条 `@机器人 /help`。未授权群会被安全策略静默拒绝，日志中会记录 `chatId`：

```bash
docker compose logs | grep message.rejected
```

把目标群 ID 写入 `.env`：

```dotenv
FEISHU_ALLOWED_CHAT_IDS=oc_xxx,oc_yyy
```

重启服务：

```bash
docker compose restart agent
```

群聊中必须 `@机器人`。`@所有人` 不会触发执行。

## 使用方式

- 私聊：直接发送任务。
- 群聊：`@机器人 任务描述`。
- `/new`：清空当前聊天对应的 Codex 会话。
- `/status`：查看会话、工作目录、沙箱和网络状态。
- `/help`：查看帮助。

每个飞书聊天使用独立的 Codex thread 和工作目录。会话索引与工作区分别保存在 Docker 卷 `agent-data` 和 `codex-home` 中。

## NAS 原生部署

如果远程 Linux 主机长期在线但没有 Docker，可以直接把项目放在 NAS 挂载目录中运行。推荐目录：

```text
/workspace/nas-data/apps/feishu-codex-agent
```

首次部署：

```bash
cd /workspace/nas-data/apps/feishu-codex-agent
npm ci
npm run build
mkdir -p .codex-home data logs run workspaces
chmod 600 .env .env.lark .codex-home/auth.json 2>/dev/null || true
```

服务管理：

```bash
bash scripts/service.sh start
bash scripts/service.sh stop
bash scripts/service.sh restart
bash scripts/service.sh status
bash scripts/service.sh logs
```

脚本会设置 `CODEX_HOME=.codex-home`、`DATA_DIR=data` 和 `WORKSPACE_ROOT=workspaces`，所有运行数据都留在项目目录内。`.codex-home/auth.json`、`.env` 和 `.env.lark` 已被 Git 忽略，不会提交。

这个模式不依赖 systemd，因此远程主机重启后需要执行一次 `bash scripts/service.sh start`。在主机持续在线的前提下，飞书机器人不依赖本机 Codex 应用是否打开。

同一个飞书应用只能运行一个长连接服务实例。部署到 NAS 后，必须停止本机或其他机器上的同应用实例，避免飞书事件被多个客户端分流。

## 安全边界

默认配置使用：

- Codex 沙箱：`workspace-write`
- Codex 网络：关闭
- 私聊：仅应用创建者和 `FEISHU_ALLOWED_OPEN_IDS` 中的用户
- 群聊：默认禁用，只响应 `FEISHU_ALLOWED_CHAT_IDS` 中的群
- Codex 审批：`never`

不要改成 `danger-full-access`，除非远程服务器是专用、隔离且可随时销毁的环境。不要把 `CODEX_ACCESS_TOKEN`、`.env` 或 `.env.lark` 提交到 Git。

## 运维限制

飞书长连接采用集群投递模式，同一个事件只会发给一个客户端。因此这个服务应当只运行一个副本。需要扩容时，应先在应用层增加分布式队列，再拆分飞书接收和 Codex 执行服务。

当前版本支持文本任务和最终结果卡片，不支持语音输入、图片附件、按钮审批或运行中取消。
