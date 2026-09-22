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

export class CodexRunner {
  private readonly codex = new Codex();
  private readonly store: SessionStore;
  private readonly workspaceRoot: string;
  private readonly sandbox: SupportedSandbox;
  private readonly networkAccess: boolean;
  private readonly model?: string;
  private readonly maxConcurrentRuns: number;
  private activeRuns = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly chatQueues = new Map<string, Promise<void>>();

  constructor(options: CodexRunnerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.store = new SessionStore(options.sessionsFile);
    this.sandbox = options.sandbox;
    this.networkAccess = options.networkAccess;
    this.maxConcurrentRuns = options.maxConcurrentRuns;
    if (options.model) {
      this.model = options.model;
    }
  }

  async getThreadId(chatId: string): Promise<string | undefined> {
    return (await this.store.get(chatId))?.threadId;
  }

  async reset(chatId: string): Promise<void> {
    await this.store.delete(chatId);
  }

  async run(chatId: string, prompt: string): Promise<RunOutput> {
    return this.enqueueForChat(chatId, async () => {
      await this.acquireRunSlot();
      try {
        const workspace = workspaceForChat(this.workspaceRoot, chatId);
        await mkdir(workspace, { recursive: true });

        const existingThreadId = await this.store.get(chatId);
        let thread = this.createThread(existingThreadId?.threadId, workspace);

        let result;
        try {
          result = await thread.run(prompt);
        } catch (error) {
          if (
            !existingThreadId?.threadId ||
            !this.isMissingThreadError(error)
          ) {
            throw error;
          }

          thread = this.createThread(undefined, workspace);
          result = await thread.run(prompt);
        }

        if (thread.id) {
          await this.store.setThreadId(chatId, thread.id);
        }

        return {
          finalResponse: result.finalResponse,
          threadId: thread.id ?? existingThreadId?.threadId ?? "",
          workspace,
        };
      } finally {
        this.releaseRunSlot();
      }
    });
  }

  private createThread(threadId: string | undefined, workspace: string): Thread {
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
      sandboxMode: this.sandbox,
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      networkAccessEnabled: this.networkAccess,
      approvalPolicy: "never",
      threadSource: "feishu-codex-agent",
    };

    if (this.model) {
      common.model = this.model;
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
