import { mkdir } from "node:fs/promises";
import {
  Codex,
  type ModelReasoningEffort,
  type Thread,
  type ThreadItem,
} from "@openai/codex-sdk";
import type { SupportedSandbox } from "./config.js";
import { SessionStore } from "./session-store.js";
import { workspaceForChat } from "./util.js";

export interface CodexRunnerOptions {
  workspaceRoot: string;
  sessionsFile: string;
  sandbox: SupportedSandbox;
  networkAccess: boolean;
  model?: string;
  maxConcurrentRuns: number;
}

export interface RunOutput {
  finalResponse: string;
  threadId: string;
  workspace: string;
}

export interface ChatRunStatus {
  threadId?: string;
  model: string;
  sandbox: SupportedSandbox;
  networkAccess: boolean;
  workspace: string;
  active: boolean;
  pending: number;
}

export type RunProgressKind =
  | "analysis"
  | "command"
  | "file"
  | "tool"
  | "search"
  | "plan"
  | "error";

export interface RunProgress {
  kind: RunProgressKind;
  message: string;
}

export type RunProgressHandler = (progress: RunProgress) => void;

interface RunSettings {
  model?: string;
  sandbox: SupportedSandbox;
  networkAccess: boolean;
}

export class RunCancelledError extends Error {
  constructor() {
    super("Codex run cancelled.");
    this.name = "RunCancelledError";
  }
}

export class CodexRunner {
  private readonly codex = new Codex();
  private readonly store: SessionStore;
  private readonly workspaceRoot: string;
  private readonly defaultSandbox: SupportedSandbox;
  private readonly defaultNetworkAccess: boolean;
  private readonly defaultModel?: string;
  private readonly maxConcurrentRuns: number;
  private activeRuns = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly chatQueues = new Map<string, Promise<void>>();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly pendingRuns = new Map<string, number>();

  constructor(options: CodexRunnerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.store = new SessionStore(options.sessionsFile);
    this.defaultSandbox = options.sandbox;
    this.defaultNetworkAccess = options.networkAccess;
    this.maxConcurrentRuns = options.maxConcurrentRuns;
    if (options.model) {
      this.defaultModel = options.model;
    }
  }

  async getThreadId(chatId: string): Promise<string | undefined> {
    return (await this.store.get(chatId))?.threadId;
  }

  async getStatus(chatId: string): Promise<ChatRunStatus> {
    const record = await this.store.get(chatId);
    const settings = this.resolveSettings(record);
    return {
      ...(record?.threadId ? { threadId: record.threadId } : {}),
      model: settings.model ?? "Codex 默认配置",
      sandbox: settings.sandbox,
      networkAccess: settings.networkAccess,
      workspace: workspaceForChat(this.workspaceRoot, chatId),
      active: this.activeControllers.has(chatId),
      pending: this.pendingRuns.get(chatId) ?? 0,
    };
  }

  async reset(chatId: string): Promise<void> {
    await this.store.resetThread(chatId);
  }

  async setModel(chatId: string, model: string | undefined): Promise<void> {
    await this.store.setModel(chatId, model);
  }

  async setSandbox(
    chatId: string,
    sandbox: SupportedSandbox | undefined,
  ): Promise<void> {
    await this.store.setSandbox(chatId, sandbox);
  }

  async setNetworkAccess(
    chatId: string,
    networkAccess: boolean | undefined,
  ): Promise<void> {
    await this.store.setNetworkAccess(chatId, networkAccess);
  }

  cancel(chatId: string): boolean {
    const controller = this.activeControllers.get(chatId);
    if (!controller) {
      return false;
    }

    controller.abort();
    return true;
  }

  cancelAll(): number {
    const controllers = [...this.activeControllers.values()];
    for (const controller of controllers) {
      controller.abort();
    }
    return controllers.length;
  }

  async run(
    chatId: string,
    prompt: string,
    onProgress?: RunProgressHandler,
  ): Promise<RunOutput> {
    this.pendingRuns.set(chatId, (this.pendingRuns.get(chatId) ?? 0) + 1);

    return this.enqueueForChat(chatId, async () => {
      const controller = new AbortController();
      this.activeControllers.set(chatId, controller);
      await this.acquireRunSlot();

      try {
        const workspace = workspaceForChat(this.workspaceRoot, chatId);
        await mkdir(workspace, { recursive: true });

        const record = await this.store.get(chatId);
        const settings = this.resolveSettings(record);
        let thread = this.createThread(record?.threadId, workspace, settings);

        let finalResponse: string;
        try {
          finalResponse = await this.runStreamed(
            thread,
            prompt,
            controller.signal,
            onProgress,
          );
        } catch (error) {
          if (controller.signal.aborted) {
            throw new RunCancelledError();
          }

          if (!record?.threadId || !this.isMissingThreadError(error)) {
            throw error;
          }

          thread = this.createThread(undefined, workspace, settings);
          finalResponse = await this.runStreamed(
            thread,
            prompt,
            controller.signal,
            onProgress,
          );
        }

        if (controller.signal.aborted) {
          throw new RunCancelledError();
        }

        if (thread.id) {
          await this.store.setThreadId(chatId, thread.id);
        }

        return {
          finalResponse,
          threadId: thread.id ?? record?.threadId ?? "",
          workspace,
        };
      } finally {
        this.activeControllers.delete(chatId);
        this.releaseRunSlot();
        this.decrementPending(chatId);
      }
    });
  }

  private resolveSettings(
    record: Awaited<ReturnType<SessionStore["get"]>>,
  ): RunSettings {
    const model = record?.model ?? this.defaultModel;
    return {
      ...(model ? { model } : {}),
      sandbox: record?.sandbox ?? this.defaultSandbox,
      networkAccess: record?.networkAccess ?? this.defaultNetworkAccess,
    };
  }

  private createThread(
    threadId: string | undefined,
    workspace: string,
    settings: RunSettings,
  ): Thread {
    const common: {
      sandboxMode: SupportedSandbox;
      workingDirectory: string;
      skipGitRepoCheck: true;
      networkAccessEnabled: boolean;
      approvalPolicy: "never";
      threadSource: string;
      modelReasoningEffort?: ModelReasoningEffort;
      model?: string;
    } = {
      sandboxMode: settings.sandbox,
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      networkAccessEnabled: settings.networkAccess,
      approvalPolicy: "never",
      threadSource: "feishu-codex-agent",
    };

    if (settings.model) {
      common.model = settings.model;
    }

    return threadId
      ? this.codex.resumeThread(threadId, common)
      : this.codex.startThread(common);
  }

  private async runStreamed(
    thread: Thread,
    prompt: string,
    signal: AbortSignal,
    onProgress?: RunProgressHandler,
  ): Promise<string> {
    const { events } = await thread.runStreamed(prompt, { signal });
    let finalResponse = "";

    for await (const event of events) {
      if (
        event.type === "item.started" ||
        event.type === "item.updated" ||
        event.type === "item.completed"
      ) {
        this.notifyProgress(event.item, event.type, onProgress);
        if (
          event.type === "item.completed" &&
          event.item.type === "agent_message"
        ) {
          finalResponse = event.item.text;
        }
        continue;
      }

      if (event.type === "turn.failed") {
        throw new Error(event.error.message);
      }

      if (event.type === "error") {
        throw new Error(event.message);
      }
    }

    return finalResponse;
  }

  private notifyProgress(
    item: ThreadItem,
    eventType: "item.started" | "item.updated" | "item.completed",
    onProgress?: RunProgressHandler,
  ): void {
    if (!onProgress) {
      return;
    }

    switch (item.type) {
      case "reasoning":
        if (eventType === "item.started") {
          onProgress({
            kind: "analysis",
            message: "正在分析问题并规划下一步...",
          });
        }
        return;

      case "command_execution": {
        const command = summariseProgressText(item.command);
        if (eventType === "item.started") {
          onProgress({
            kind: "command",
            message: `正在执行命令：${command}`,
          });
        } else if (eventType === "item.completed") {
          onProgress({
            kind: "command",
            message:
              item.status === "failed"
                ? `命令执行失败：${command}`
                : `命令执行完成：${command}`,
          });
        }
        return;
      }

      case "file_change":
        if (eventType === "item.completed") {
          const files = item.changes
            .slice(0, 4)
            .map((change) => change.path)
            .join(", ");
          onProgress({
            kind: "file",
            message:
              item.status === "completed"
                ? `已应用文件变更：${files || "无文件路径"}`
                : "文件变更应用失败。",
          });
        }
        return;

      case "mcp_tool_call":
        if (eventType === "item.started") {
          onProgress({
            kind: "tool",
            message: `正在调用工具：${item.server}/${item.tool}`,
          });
        } else if (eventType === "item.completed" && item.status === "failed") {
          onProgress({
            kind: "tool",
            message: `工具调用失败：${item.server}/${item.tool}`,
          });
        }
        return;

      case "web_search":
        if (eventType === "item.started" || eventType === "item.completed") {
          onProgress({
            kind: "search",
            message: `正在搜索：${summariseProgressText(item.query)}`,
          });
        }
        return;

      case "todo_list": {
        if (eventType === "item.started") {
          return;
        }
        const completed = item.items.filter((todo) => todo.completed).length;
        onProgress({
          kind: "plan",
          message: `计划进度：${completed}/${item.items.length}`,
        });
        return;
      }

      case "error":
        onProgress({
          kind: "error",
          message: `执行过程中出现错误：${summariseProgressText(item.message)}`,
        });
        return;

      case "agent_message":
        return;
    }
  }

  private enqueueForChat<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chatQueues.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.chatQueues.set(
      chatId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private decrementPending(chatId: string): void {
    const next = (this.pendingRuns.get(chatId) ?? 1) - 1;
    if (next > 0) {
      this.pendingRuns.set(chatId, next);
    } else {
      this.pendingRuns.delete(chatId);
    }
  }

  private async acquireRunSlot(): Promise<void> {
    if (this.activeRuns < this.maxConcurrentRuns) {
      this.activeRuns += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private releaseRunSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.activeRuns -= 1;
    }
  }

  private isMissingThreadError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /thread|rollout|session/i.test(message);
  }
}

function summariseProgressText(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 180
    ? `${singleLine.slice(0, 180)}...`
    : singleLine;
}
