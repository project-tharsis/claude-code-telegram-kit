import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { MODEL_ALIASES, type ModelAlias } from "./control-command.js";

export const DEFAULT_MODEL_ENV_FILE = "/etc/claude-code-telegram-kit/model.env";

export function readConfiguredModel(options: {
  path?: string;
  expectedUid?: number;
} = {}): ModelAlias {
  const path = options.path ?? DEFAULT_MODEL_ENV_FILE;
  const expectedUid = options.expectedUid ?? 0;
  let before;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "inherit";
    throw error;
  }
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.uid !== expectedUid
    || before.nlink !== 1
    || (before.mode & 0o777) !== 0o644
    || before.size > 1024
  ) throw new Error("model env metadata is invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.uid !== expectedUid
      || opened.nlink !== 1
      || (opened.mode & 0o777) !== 0o644
      || opened.size > 1024
    ) throw new Error("model env changed during validation");
    const text = readFileSync(fd, "utf8");
    const match = /^ANTHROPIC_MODEL=(opus|sonnet|haiku)\n?$/.exec(text);
    if (match === null || !MODEL_ALIASES.includes(match[1] as ModelAlias)) {
      throw new Error("model env content is invalid");
    }
    return match[1] as ModelAlias;
  } finally {
    closeSync(fd);
  }
}
