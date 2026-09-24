import path from "node:path";
import process from "node:process";

export const SUPPORTED_SANDBOXES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

export type SupportedSandbox = (typeof SUPPORTED_SANDBOXES)[number];

export interface AppConfig {
  larkAppId: string;
  larkAppSecret: string;
  ownerOpenId?: string;
  allowedOpenIds: string[];
  allowedChatIds: string[];
  codexModel?: string;
  codexSandbox: SupportedSandbox;
  codexNetworkAccess: boolean;
  maxConcurrentRuns: number;
  maxPromptChars: number;
  port: number;
  dataDir: string;
  workspaceRoot: string;
  sessionsFile: string;
}

function loadOptionalEnvFile(filePath: string): void {
  try {
    process.loadEnvFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function parseSandbox(value: string | undefined): SupportedSandbox {
  const sandbox = value ?? "workspace-write";
  if (isSupportedSandbox(sandbox)) {
    return sandbox;
  }

  throw new Error(
    "CODEX_SANDBOX must be read-only, workspace-write, or danger-full-access.",
  );
}

export function isSupportedSandbox(value: string): value is SupportedSandbox {
  return (SUPPORTED_SANDBOXES as readonly string[]).includes(value);
}

function requireValue(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(`${name} is required.`);
  }

  return value.trim();
}

export function loadConfig(): AppConfig {
  loadOptionalEnvFile(".env.lark");
  loadOptionalEnvFile(".env");

  const dataDir = path.resolve(process.env.DATA_DIR ?? ".data");
  const ownerOpenId = process.env.LARK_OWNER_OPEN_ID?.trim() || undefined;
  const allowedOpenIds = parseCsv(process.env.FEISHU_ALLOWED_OPEN_IDS);

  if (ownerOpenId && !allowedOpenIds.includes(ownerOpenId)) {
    allowedOpenIds.unshift(ownerOpenId);
  }

  if (allowedOpenIds.length === 0) {
    throw new Error(
      "No allowed Feishu users. Run npm run setup or set FEISHU_ALLOWED_OPEN_IDS.",
    );
  }

  return {
    larkAppId: requireValue(process.env.LARK_APP_ID, "LARK_APP_ID"),
    larkAppSecret: requireValue(process.env.LARK_APP_SECRET, "LARK_APP_SECRET"),
    ...(ownerOpenId ? { ownerOpenId } : {}),
    allowedOpenIds,
    allowedChatIds: parseCsv(process.env.FEISHU_ALLOWED_CHAT_IDS),
    ...(process.env.CODEX_MODEL?.trim()
      ? { codexModel: process.env.CODEX_MODEL.trim() }
      : {}),
    codexSandbox: parseSandbox(process.env.CODEX_SANDBOX),
    codexNetworkAccess: parseBoolean(
      process.env.CODEX_NETWORK_ACCESS,
      false,
    ),
    maxConcurrentRuns: parsePositiveInteger(
      process.env.MAX_CONCURRENT_RUNS,
      2,
      "MAX_CONCURRENT_RUNS",
    ),
    maxPromptChars: parsePositiveInteger(
      process.env.MAX_PROMPT_CHARS,
      12000,
      "MAX_PROMPT_CHARS",
    ),
    port: parsePositiveInteger(process.env.PORT, 3000, "PORT"),
    dataDir,
    workspaceRoot: path.resolve(
      process.env.WORKSPACE_ROOT ?? path.join(dataDir, "workspaces"),
    ),
    sessionsFile: path.resolve(
      process.env.SESSIONS_FILE ?? path.join(dataDir, "sessions.json"),
    ),
  };
}
