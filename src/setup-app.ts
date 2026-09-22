import { access, chmod, writeFile } from "node:fs/promises";
import process from "node:process";
import * as lark from "@larksuiteoapi/node-sdk";

const target = process.env.LARK_ENV_FILE ?? ".env.lark";
const force = process.argv.includes("--force");

if (!force) {
  try {
    await access(target);
    console.error(`${target} already exists. Move it or rerun with --force.`);
    process.exitCode = 1;
    process.exit();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

console.log("Creating a Feishu custom app with bot, message event, and message scopes.");

const result = await lark.registerApp({
  source: "feishu-codex-agent",
  createOnly: true,
  appPreset: {
    name: "Codex 助手",
    desc: "在飞书中远程调用 Codex 完成工程任务",
  },
  addons: {
    preset: false,
    scopes: {
      tenant: [
        "im:message.p2p_msg:readonly",
        "im:message.group_at_msg:readonly",
        "im:message:send_as_bot",
      ],
    },
    events: {
      items: {
        tenant: ["im.message.receive_v1"],
      },
    },
  },
  onQRCodeReady(info) {
    console.log("");
    console.log("Open this link in Feishu or scan its QR code:");
    console.log(info.url);
    console.log(`Link expires in ${info.expireIn} seconds.`);
    console.log("");
  },
  onStatusChange(info) {
    console.log(`Registration status: ${info.status}`);
  },
});

const lines = [
  `LARK_APP_ID=${result.client_id}`,
  `LARK_APP_SECRET=${result.client_secret}`,
];

if (result.user_info?.open_id) {
  lines.push(`LARK_OWNER_OPEN_ID=${result.user_info.open_id}`);
}

await writeFile(target, `${lines.join("\n")}\n`, {
  flag: force ? "w" : "wx",
  mode: 0o600,
});
await chmod(target, 0o600);

console.log(`Feishu app created. Credentials saved to ${target}.`);
