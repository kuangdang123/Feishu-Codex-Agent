import assert from "node:assert/strict";
import test from "node:test";
import {
  isHelpCommand,
  isNewCommand,
  isStatusCommand,
  parseSlashCommand,
  safeDirectoryName,
  truncateText,
} from "../src/util.js";

test("safeDirectoryName only emits filesystem-safe characters", () => {
  assert.equal(safeDirectoryName("oc_abc/../../secret"), "oc_abc_secret");
  assert.equal(safeDirectoryName(".."), "default");
  assert.equal(safeDirectoryName(""), "default");
});

test("truncateText reports omitted characters", () => {
  assert.equal(truncateText("abcdef", 4), "abcd\n\n... output truncated (2 chars omitted)");
  assert.equal(truncateText("abc", 4), "abc");
});

test("slash commands are exact commands", () => {
  assert.deepEqual(parseSlashCommand("/model gpt-5.5"), {
    name: "model",
    argument: "gpt-5.5",
  });
  assert.deepEqual(parseSlashCommand("  /git   status  "), {
    name: "git",
    argument: "status",
  });
  assert.equal(parseSlashCommand("hello"), undefined);
  assert.equal(isNewCommand("/new"), true);
  assert.equal(isNewCommand("/new chat"), true);
  assert.equal(isNewCommand("/clear"), true);
  assert.equal(isNewCommand("/newer"), false);
  assert.equal(isHelpCommand("/help"), true);
  assert.equal(isStatusCommand("/status now"), true);
  assert.equal(isStatusCommand("/cwd"), true);
});
