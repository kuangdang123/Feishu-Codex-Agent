import { mkdir } from "node:fs/promises";
import { Codex, type ModelReasoningEffort, type Thread } from "@openai/codex-sdk";
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
  workspace: string;
  active: boolean;
  pending: number;
}

interface RunSettings {
  model?: string;
  sandbox: SupportedSandbox;
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
  private readonly networkAccess: boolean;
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
    this.networkAccess = options.networkAccess;
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

  async run(chatId: string, prompt: string): Promise<RunOutput> {
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

        let result;
        try {
          result = await thread.run(prompt, { signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) {
            throw new RunCancelledError();
          }

          if (!record?.threadId || !this.isMissingThreadError(error)) {
            throw error;
          }

          thread = this.createThread(undefined, workspace, settings);
          result = await thread.run(prompt, { signal: controller.signal });
        }

        if (controller.signal.aborted) {
          throw new RunCancelledError();
        }

        if (thread.id) {
          await this.store.setThreadId(chatId, thread.id);
        }

        return {
          finalResponse: result.finalResponse,
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
      networkAccessEnabled: this.networkAccess,
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
