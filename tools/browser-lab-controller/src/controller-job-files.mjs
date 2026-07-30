import {
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export function readUniqueJson(root, name) {
  const matches = findFiles(root, name);
  if (matches.length !== 1) {
    throw new Error(`controller expected exactly one ${name}`);
  }
  return JSON.parse(readFileSync(matches[0], "utf8"));
}

export function safeChild(parent, name) {
  const child = resolve(parent, name);
  assertOwnedJobRoot(parent, child);
  return child;
}

export function assertOwnedJobRoot(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  if (
    path === "" ||
    path === ".." ||
    path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error("controller path escapes its owned jobs root");
  }
}

export function requiredAbsolute(value, label) {
  if (!isAbsolute(value ?? "")) throw new Error(`${label} must be absolute`);
  return resolve(value);
}

function findFiles(directory, name) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`controller job root contains a symlink: ${path}`);
    }
    if (entry.isDirectory()) return findFiles(path, name);
    return entry.isFile() && basename(path) === name ? [path] : [];
  });
}
