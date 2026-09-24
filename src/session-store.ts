import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SupportedSandbox } from "./config.js";

export type SessionSandbox = SupportedSandbox;

export interface SessionRecord {
  threadId?: string;
  model?: string;
  sandbox?: SessionSandbox;
  networkAccess?: boolean;
  updatedAt: string;
}

interface SessionFile {
  version: 1;
  sessions: Record<string, SessionRecord>;
}

export class SessionStore {
  private readonly filePath: string;
  private data: SessionFile | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async get(chatId: string): Promise<SessionRecord | undefined> {
    const data = await this.read();
    return data.sessions[chatId];
  }

  async setThreadId(chatId: string, threadId: string): Promise<void> {
    const data = await this.read();
    const record = this.ensureRecord(data, chatId);
    record.threadId = threadId;
    record.updatedAt = new Date().toISOString();
    await this.write(data);
  }

  async setModel(chatId: string, model: string | undefined): Promise<void> {
    const data = await this.read();
    const record = this.ensureRecord(data, chatId);
    if (model) {
      record.model = model;
    } else {
      delete record.model;
    }
    record.updatedAt = new Date().toISOString();
    this.removeIfEmpty(data, chatId, record);
    await this.write(data);
  }

  async setSandbox(
    chatId: string,
    sandbox: SessionSandbox | undefined,
  ): Promise<void> {
    const data = await this.read();
    const record = this.ensureRecord(data, chatId);
    if (sandbox) {
      record.sandbox = sandbox;
    } else {
      delete record.sandbox;
    }
    record.updatedAt = new Date().toISOString();
    this.removeIfEmpty(data, chatId, record);
    await this.write(data);
  }

  async setNetworkAccess(
    chatId: string,
    networkAccess: boolean | undefined,
  ): Promise<void> {
    const data = await this.read();
    const record = this.ensureRecord(data, chatId);
    if (networkAccess === undefined) {
      delete record.networkAccess;
    } else {
      record.networkAccess = networkAccess;
    }
    record.updatedAt = new Date().toISOString();
    this.removeIfEmpty(data, chatId, record);
    await this.write(data);
  }

  async resetThread(chatId: string): Promise<void> {
    const data = await this.read();
    const record = data.sessions[chatId];
    if (!record) {
      return;
    }

    delete record.threadId;
    record.updatedAt = new Date().toISOString();
    this.removeIfEmpty(data, chatId, record);
    await this.write(data);
  }

  async delete(chatId: string): Promise<void> {
    const data = await this.read();
    if (!(chatId in data.sessions)) {
      return;
    }

    delete data.sessions[chatId];
    await this.write(data);
  }

  private ensureRecord(data: SessionFile, chatId: string): SessionRecord {
    const existing = data.sessions[chatId];
    if (existing) {
      return existing;
    }

    const record: SessionRecord = {
      updatedAt: new Date().toISOString(),
    };
    data.sessions[chatId] = record;
    return record;
  }

  private removeIfEmpty(
    data: SessionFile,
    chatId: string,
    record: SessionRecord,
  ): void {
    if (
      !record.threadId &&
      !record.model &&
      !record.sandbox &&
      record.networkAccess === undefined
    ) {
      delete data.sessions[chatId];
    }
  }

  private async read(): Promise<SessionFile> {
    if (this.data) {
      return this.data;
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionFile>;
      this.data = {
        version: 1,
        sessions: parsed.sessions ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      this.data = { version: 1, sessions: {} };
    }

    return this.data;
  }

  private async write(data: SessionFile): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporaryPath, this.filePath);
    });

    await this.writeChain;
  }
}
