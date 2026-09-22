import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { CodexRunner } from "./codex-runner.js";
import { loadConfig } from "./config.js";
import {
  isHelpCommand,
  isNewCommand,
  isStatusCommand,
  truncateText,
  workspaceForChat,
} from "./util.js";

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    }),
  );
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
    chatQueue: {
      enabled: true,
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
  "可用命令：",
  "- `/new`：清空当前 Codex 会话",
  "- `/status`：查看当前会话和工作目录",
  "- `/help`：显示本帮助",
  "",
  "其他消息会转给远程 Codex。单聊默认只允许应用创建者；群聊需要先加入 `FEISHU_ALLOWED_CHAT_IDS`，并 @ 机器人。",
].join("\n");

channel.on({
  message: async (message) => {
    const prompt = message.content.trim();
    if (!prompt) {
      await channel.send(message.chatId, { text: "请输入要交给 Codex 的任务。" }, {
        replyTo: message.messageId,
      });
      return;
    }

    if (isHelpCommand(prompt)) {
      await channel.send(message.chatId, { markdown: helpText }, {
        replyTo: message.messageId,
      });
      return;
    }

    if (isNewCommand(prompt)) {
      await runner.reset(message.chatId);
      await channel.send(message.chatId, { text: "已清空当前 Codex 会话。" }, {
        replyTo: message.messageId,
      });
      return;
    }

    if (isStatusCommand(prompt)) {
      const threadId = await runner.getThreadId(message.chatId);
      const workspace = workspaceForChat(config.workspaceRoot, message.chatId);
      const status = [
        `会话：${threadId ?? "尚未建立"}`,
        `模型：${config.codexModel ?? "Codex 默认配置"}`,
        `目录：${workspace}`,
        `沙箱：${config.codexSandbox}`,
        `网络：${config.codexNetworkAccess ? "允许" : "禁止"}`,
      ].join("\n");
      await channel.send(message.chatId, { markdown: status }, {
        replyTo: message.messageId,
      });
      return;
    }

    if (prompt.length > config.maxPromptChars) {
      await channel.send(
        message.chatId,
        {
          text: `消息过长，当前上限为 ${config.maxPromptChars} 个字符。`,
        },
        { replyTo: message.messageId },
      );
      return;
    }

    await channel.send(
      message.chatId,
      { text: "Codex 已收到任务，正在处理..." },
      { replyTo: message.messageId },
    );

    try {
      const result = await runner.run(message.chatId, prompt);
      const responseText =
        result.finalResponse.trim() || "Codex 没有返回文本结果。";
      await channel.send(
        message.chatId,
        { markdown: truncateText(responseText, 100000) },
        {
          replyTo: message.messageId,
          replyInThread: Boolean(message.threadId),
        },
      );
      log("run.completed", {
        chatId: message.chatId,
        threadId: result.threadId,
      });
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : String(error);
      const errorId = randomUUID();
      await channel.send(
        message.chatId,
        {
          text: `Codex 执行失败。请将错误编号提供给管理员：${errorId}`,
        },
        { replyTo: message.messageId },
      );
      log("run.failed", {
        errorId,
        chatId: message.chatId,
        error: messageText,
      });
    }
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
