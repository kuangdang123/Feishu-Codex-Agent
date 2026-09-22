import path from "node:path";

export interface ParsedSlashCommand {
  name: string;
  argument: string;
}

export function safeDirectoryName(value: string): string {
  const normalised = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_");
  const bounded = normalised.slice(0, 80);
  return /[a-zA-Z0-9]/.test(bounded) ? bounded : "default";
}

export function workspaceForChat(root: string, chatId: string): string {
  return path.join(root, safeDirectoryName(chatId));
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n\n... output truncated (${omitted} chars omitted)`;
}

export function parseSlashCommand(value: string): ParsedSlashCommand | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(value.trim());
  const name = match?.[1];
  if (!name) {
    return undefined;
  }

  return {
    name: name.toLowerCase(),
    argument: match[2]?.trim() ?? "",
  };
}

export function isNewCommand(value: string): boolean {
  const command = parseSlashCommand(value)?.name;
  return command === "new" || command === "reset" || command === "clear";
}

export function isHelpCommand(value: string): boolean {
  return parseSlashCommand(value)?.name === "help";
}

export function isStatusCommand(value: string): boolean {
  const command = parseSlashCommand(value)?.name;
  return command === "status" || command === "cwd";
}
