import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface SessionRecord {
  threadId: string;
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
    data.sessions[chatId] = {
      threadId,
      updatedAt: new Date().toISOString(),
    };
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
