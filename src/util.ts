import path from "node:path";

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

export function isNewCommand(value: string): boolean {
  return /^\/(?:new|reset)(?:\s|$)/i.test(value.trim());
}

export function isHelpCommand(value: string): boolean {
  return /^\/help(?:\s|$)/i.test(value.trim());
}

export function isStatusCommand(value: string): boolean {
  return /^\/status(?:\s|$)/i.test(value.trim());
}
