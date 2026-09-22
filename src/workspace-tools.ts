import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_FILES = 200;
const MAX_GIT_OUTPUT_CHARS = 12000;

async function resolveInsideRoot(
  root: string,
  workspace: string,
  requestedPath: string,
): Promise<string> {
  const absoluteRoot = await realpath(path.resolve(root));
  const target = path.resolve(workspace, requestedPath || ".");
  const relative = path.relative(absoluteRoot, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("路径必须位于当前聊天的 workspace 内。");
  }

  const absoluteTarget = await realpath(target);
  const resolvedRelative = path.relative(absoluteRoot, absoluteTarget);
  if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
    throw new Error("符号链接目标超出了当前 workspace。");
  }

  return absoluteTarget;
}

export async function listWorkspaceFiles(
  root: string,
  workspace: string,
  requestedPath: string,
): Promise<string> {
  const target = await resolveInsideRoot(root, workspace, requestedPath);
  const targetStats = await stat(target);
  if (!targetStats.isDirectory()) {
    throw new Error("`/files` 只能查看目录。");
  }

  const entries = await readdir(target, { withFileTypes: true });
  entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) {
      return left.isDirectory() ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  const relativeTarget = path.relative(path.resolve(root), target) || ".";
  const visible = entries.slice(0, MAX_FILES).map((entry) => {
    const suffix = entry.isDirectory() ? "/" : "";
    return `${entry.name}${suffix}`;
  });

  if (visible.length === 0) {
    return `目录：\`${relativeTarget}\`\n\n目录为空。`;
  }

  const omitted = entries.length - visible.length;
  return [
    `目录：\`${relativeTarget}\``,
    "",
    ...visible.map((entry) => `- ${entry}`),
    ...(omitted > 0 ? ["", `... 另有 ${omitted} 项未显示。`] : []),
  ].join("\n");
}

export async function runWorkspaceGit(
  workspace: string,
  operation: string,
): Promise<string> {
  const argsByOperation: Record<string, string[]> = {
    status: ["status", "--short", "--branch"],
    log: ["log", "--oneline", "--decorate", "-n", "10"],
    diff: ["diff", "--stat"],
  };

  const args = argsByOperation[operation];
  if (!args) {
    throw new Error("`/git` 仅支持 `status`、`log`、`diff`。");
  }

  try {
    const repositoryCheck = await execFileAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      {
        cwd: workspace,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (repositoryCheck.stdout.trim() !== "true") {
      throw new Error("当前 workspace 不是 Git 仓库。");
    }

    const result = await execFileAsync("git", args, {
      cwd: workspace,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    const output = result.stdout.trimEnd();
    return output || "命令执行成功，没有输出。";
  } catch (error) {
    const candidate = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const detail = (
      candidate.stderr ||
      candidate.stdout ||
      candidate.message ||
      "Git 命令执行失败。"
    ).trim();
    throw new Error(detail.slice(0, MAX_GIT_OUTPUT_CHARS));
  }
}
