import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import process from "node:process";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import {
  CodexRunner,
  RunCancelledError,
  type RunProgress,
} from "./codex-runner.js";
import { isSupportedSandbox, loadConfig } from "./config.js";
import {
  parseSlashCommand,
  truncateText,
  workspaceForChat,
  type ParsedSlashCommand,
} from "./util.js";
import {
  listWorkspaceFiles,
  runWorkspaceGit,
} from "./workspace-tools.js";

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    }),
  );
}

function markdownCode(value: string): string {
  return value.replaceAll("`", "'");
}

const config = loadConfig();
const runner = new CodexRunner({
  workspaceRoot: config.workspaceRoot,
  sessionsFile: config.sessionsFile,
  sandbox: config.codexSandbox,
  networkAccess: config.codexNetworkAccess,
  maxConcurrentRuns: config.maxConcurrentRuns,
  ...(config.codexModel ? { model: config.codexModel } : {}),
});

const disabledGroupAllowlist = ["__group_chat_not_enabled__"];
const channel = createLarkChannel({
  appId: config.larkAppId,
  appSecret: config.larkAppSecret,
  transport: "websocket",
  source: "feishu-codex-agent",
  loggerLevel: LoggerLevel.info,
  includeRawEvent: false,
  policy: {
    dmMode: "allowlist",
    dmAllowlist: config.allowedOpenIds,
    groupAllowlist:
      config.allowedChatIds.length > 0
        ? config.allowedChatIds
        : disabledGroupAllowlist,
    requireMention: true,
    respondToMentionAll: false,
  },
  safety: {
    dedup: {
      ttl: 6 * 60 * 60 * 1000,
      maxEntries: 10000,
    },
    // CodexRunner owns per-chat ordering. Keeping the Lark queue off allows
    // control commands such as /cancel to run while a Codex turn is active.
    chatQueue: {
      enabled: false,
    },
    batch: {
      text: {
        delayMs: 300,
        maxMessages: 8,
        maxChars: 12000,
      },
    },
  },
  outbound: {
    textChunkLimit: 20000,
    allowedFileDirs: [config.workspaceRoot],
  },
});

let ready = false;
const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok\n");
    return;
  }

  if (request.url === "/readyz") {
    const wsState = channel.getConnectionStatus()?.state;
    const healthy = ready && wsState === "connected";
    response.writeHead(healthy ? 200 : 503, {
      "content-type": "text/plain; charset=utf-8",
    });
    response.end(healthy ? "ready\n" : "not ready\n");
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found\n");
});

const helpText = [
  "**会话**",
  "- `/new`：清空当前 Codex 会话，保留模型和模式",
  "- `/status`：查看会话、模型、模式、目录和运行状态",
  "- `/cancel`：取消当前正在执行的 Codex 任务",
  "",
  "**开发**",
  "- `/files [路径]`：查看当前 workspace 内的文件",
  "- `/git status|log|diff`：查看 Git 状态、提交或变更统计",
  "- `/review [要求]`：让 Codex 审查当前 workspace",
  "",
  "**配置**",
  "- `/model`：查看当前模型",
  "- `/model <名称>`：切换当前聊天模型",
  "- `/model default`：恢复服务默认模型",
  "- `/mode`：查看当前沙箱模式",
  "- `/mode read-only|workspace-write|danger-full-access`：切换当前聊天模式",
  "- `/mode default`：恢复服务默认模式",
  "- `/network`：查看当前会话网络权限",
  "- `/network on|off`：切换当前会话网络权限",
  "- `/network default`：恢复服务默认网络设置",
  "",
  "**多轮对话与进度**",
  "- 私聊直接连续发送，群聊每条 @ 机器人；同一聊天会自动延续上下文。",
  "- 不同私聊或群聊是独立会话，各自保存线程和 workspace。",
  "- `/new` 只清对话上下文，不删除文件和配置。",
  "- 任务执行中会显示分析、命令、文件和工具调用进度，结束后返回最终结果。",
  "",
  "其他消息会交给远程 Codex。群聊需要先授权，并 @ 机器人。",
].join("\n");

interface ReplyTarget {
  chatId: string;
  messageId: string;
  threadId?: string;
}

async function sendText(
  target: ReplyTarget,
  text: string,
): Promise<void> {
  await channel.send(target.chatId, { text }, {
    replyTo: target.messageId,
    ...(target.threadId ? { replyInThread: true } : {}),
  });
}

async function sendMarkdown(
  target: ReplyTarget,
  markdown: string,
): Promise<void> {
  await channel.send(target.chatId, { markdown }, {
    replyTo: target.messageId,
    ...(target.threadId ? { replyInThread: true } : {}),
  });
}

async function executePrompt(
  target: ReplyTarget,
  prompt: string,
): Promise<void> {
  await sendText(target, "Codex 已收到任务，正在分析并执行...");

  void (async () => {
    const startedAt = Date.now();
    let lastProgressAt = 0;
    let lastProgressKey = "";
    let lastVisibleAt = Date.now();
    let progressCount = 0;
    let progressChain = Promise.resolve();

    const sendProgress = (
      message: string,
      key: string,
      force = false,
    ): void => {
      const now = Date.now();
      if (
        !force &&
        (key === lastProgressKey || now - lastProgressAt < 2500)
      ) {
        return;
      }
      if (!force && progressCount >= 40) {
        return;
      }

      lastProgressAt = now;
      lastVisibleAt = now;
      lastProgressKey = key;
      progressCount += 1;
      progressChain = progressChain
        .catch(() => undefined)
        .then(() => sendText(target, message))
        .catch((error: unknown) => {
          log("run.progress_failed", {
            chatId: target.chatId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };

    const reportProgress = (progress: RunProgress): void => {
      sendProgress(progress.message, `${progress.kind}:${progress.message}`);
    };

    const heartbeat = setInterval(() => {
      if (Date.now() - lastVisibleAt < 30000) {
        return;
      }

      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      sendProgress(
        `Codex 仍在处理，已运行约 ${elapsedSeconds} 秒。完成或失败后会继续通知。`,
        "heartbeat",
        true,
      );
    }, 5000);

    try {
      const result = await runner.run(
        target.chatId,
        prompt,
        reportProgress,
      );
      clearInterval(heartbeat);
      await progressChain;
      const responseText =
        result.finalResponse.trim() || "Codex 没有返回文本结果。";
      await sendMarkdown(
        { ...target, ...(result.threadId ? { threadId: result.threadId } : {}) },
        truncateText(responseText, 100000),
      );
      log("run.completed", {
        chatId: target.chatId,
        threadId: result.threadId,
      });
    } catch (error) {
      clearInterval(heartbeat);
      await progressChain;
      if (error instanceof RunCancelledError) {
        await sendText(target, "当前 Codex 任务已取消。");
        log("run.cancelled", { chatId: target.chatId });
        return;
      }

      const messageText =
        error instanceof Error ? error.message : String(error);
      const errorId = randomUUID();
      await sendText(
        target,
        `Codex 执行失败。请将错误编号提供给管理员：${errorId}`,
      );
      log("run.failed", {
        errorId,
        chatId: target.chatId,
        error: messageText,
      });
    }
  })();
}

async function handleCommand(
  target: ReplyTarget,
  command: ParsedSlashCommand,
): Promise<void> {
  switch (command.name) {
    case "help":
      await sendMarkdown(target, helpText);
      return;

    case "new":
    case "reset":
    case "clear":
      runner.cancel(target.chatId);
      await runner.reset(target.chatId);
      await sendText(
        target,
        "已开启新的 Codex 会话，模型、模式和网络设置保持不变。",
      );
      return;

    case "cancel": {
      const cancelled = runner.cancel(target.chatId);
      await sendText(
        target,
        cancelled ? "已请求取消当前任务。" : "当前没有正在执行的 Codex 任务。",
      );
      return;
    }

    case "status":
    case "cwd": {
      const status = await runner.getStatus(target.chatId);
      const queued = status.pending > 1 ? status.pending - 1 : 0;
      const runtime = status.active
        ? `运行中${queued > 0 ? `（另有 ${queued} 个任务排队）` : ""}`
        : queued > 0
          ? `排队中（${queued}）`
          : "空闲";
      await sendMarkdown(
        target,
        [
          `会话：${status.threadId ?? "尚未建立"}`,
          `模型：${status.model}`,
          `模式：${status.sandbox}`,
          `网络：${status.networkAccess ? "允许" : "禁止"}`,
          `状态：${runtime}`,
          `目录：\`${status.workspace}\``,
          `服务：${hostname()}`,
        ].join("\n"),
      );
      return;
    }

    case "model": {
      const status = await runner.getStatus(target.chatId);
      if (!command.argument) {
        await sendText(target, `当前模型：${status.model}`);
        return;
      }

      if (command.argument.toLowerCase() === "default") {
        await runner.setModel(target.chatId, undefined);
        const updated = await runner.getStatus(target.chatId);
        await sendText(target, `已恢复默认模型：${updated.model}`);
        return;
      }

      if (!/^[a-zA-Z0-9._:/-]{1,100}$/.test(command.argument)) {
        await sendText(target, "模型名称格式无效。");
        return;
      }

      await runner.setModel(target.chatId, command.argument);
      await sendText(target, `当前模型已切换为：${command.argument}`);
      return;
    }

    case "mode":
    case "sandbox": {
      const status = await runner.getStatus(target.chatId);
      if (!command.argument) {
        await sendText(target, `当前模式：${status.sandbox}`);
        return;
      }

      if (command.argument.toLowerCase() === "default") {
        await runner.setSandbox(target.chatId, undefined);
        const updated = await runner.getStatus(target.chatId);
        await sendText(target, `已恢复默认模式：${updated.sandbox}`);
        return;
      }

      const sandbox =
        command.argument.toLowerCase() === "full"
          ? "danger-full-access"
          : command.argument.toLowerCase();
      if (!isSupportedSandbox(sandbox)) {
        await sendText(
          target,
          "模式仅支持 `read-only`、`workspace-write` 或 `danger-full-access`。",
        );
        return;
      }

      await runner.setSandbox(target.chatId, sandbox);
      await sendText(target, `当前模式已切换为：${sandbox}`);
      return;
    }

    case "network": {
      const status = await runner.getStatus(target.chatId);
      if (!command.argument) {
        await sendText(
          target,
          `当前网络：${status.networkAccess ? "允许" : "禁止"}`,
        );
        return;
      }

      const value = command.argument.toLowerCase();
      if (value === "default") {
        await runner.setNetworkAccess(target.chatId, undefined);
        const updated = await runner.getStatus(target.chatId);
        await sendText(
          target,
          `已恢复默认网络设置：${updated.networkAccess ? "允许" : "禁止"}`,
        );
        return;
      }

      const networkAccess =
        ["on", "enable", "enabled", "true", "1"].includes(value)
          ? true
          : ["off", "disable", "disabled", "false", "0"].includes(value)
            ? false
            : undefined;
      if (networkAccess === undefined) {
        await sendText(target, "网络设置仅支持 `on`、`off` 或 `default`。");
        return;
      }

      await runner.setNetworkAccess(target.chatId, networkAccess);
      await sendText(
        target,
        `当前网络已切换为：${networkAccess ? "允许" : "禁止"}`,
      );
      return;
    }

    case "files": {
      const workspace = workspaceForChat(config.workspaceRoot, target.chatId);
      try {
        const listing = await listWorkspaceFiles(
          config.workspaceRoot,
          workspace,
          command.argument,
        );
        await sendMarkdown(target, listing);
      } catch (error) {
        await sendText(
          target,
          error instanceof Error ? error.message : "读取目录失败。",
        );
      }
      return;
    }

    case "git":
    case "diff": {
      const workspace = workspaceForChat(config.workspaceRoot, target.chatId);
      const operation =
        command.name === "diff" ? "diff" : command.argument.toLowerCase() || "status";
      try {
        const output = await runWorkspaceGit(workspace, operation);
        await sendMarkdown(
          target,
          `\`git ${markdownCode(operation)}\`\n\n\`\`\`text\n${truncateText(output, 12000)}\n\`\`\``,
        );
      } catch (error) {
        await sendText(
          target,
          error instanceof Error ? error.message : "Git 命令执行失败。",
        );
      }
      return;
    }

    case "review": {
      const extra = command.argument
        ? `\nAdditional review instructions: ${command.argument}`
        : "";
      const reviewPrompt = [
        "Review the current workspace changes and repository state.",
        "Findings first, ordered by severity. Focus on bugs, regressions, security risks, and missing tests.",
        "Inspect the diff and relevant surrounding code. Do not modify files.",
        extra,
      ].join("\n");
      await executePrompt(target, reviewPrompt);
      return;
    }

    default:
      await sendText(
        target,
        `未知命令：/${command.name}\n发送 /help 查看可用命令。`,
      );
  }
}

channel.on({
  message: async (message) => {
    const prompt = message.content.trim();
    const target: ReplyTarget = {
      chatId: message.chatId,
      messageId: message.messageId,
      ...(message.threadId ? { threadId: message.threadId } : {}),
    };

    if (!prompt) {
      await sendText(target, "请输入要交给 Codex 的任务。");
      return;
    }

    const command = parseSlashCommand(prompt);
    if (command) {
      await handleCommand(target, command);
      return;
    }

    if (prompt.length > config.maxPromptChars) {
      await sendText(
        target,
        `消息过长，当前上限为 ${config.maxPromptChars} 个字符。`,
      );
      return;
    }

    await executePrompt(target, prompt);
  },
  reject: (event) => {
    log("message.rejected", {
      chatId: event.chatId,
      senderId: event.senderId,
      reason: event.reason,
    });
  },
  error: (error) => {
    log("channel.error", {
      code: error.code,
      message: error.message,
    });
  },
  reconnecting: () => log("channel.reconnecting"),
  reconnected: () => log("channel.reconnected"),
});

server.listen(config.port, "0.0.0.0", () => {
  log("health.started", { port: config.port });
});

try {
  await channel.connect();
  ready = true;
  log("channel.connected", {
    botOpenId: channel.botIdentity?.openId,
    botName: channel.botIdentity?.name,
    sandbox: config.codexSandbox,
  });
} catch (error) {
  log("channel.connect_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  server.close();
  process.exitCode = 1;
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  ready = false;
  log("shutdown.started", { signal });
  const cancelled = runner.cancelAll();
  if (cancelled > 0) {
    log("shutdown.runs_cancelled", { count: cancelled });
  }
  await channel.disconnect().catch((error: unknown) => {
    log("shutdown.channel_error", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  log("shutdown.completed");
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
