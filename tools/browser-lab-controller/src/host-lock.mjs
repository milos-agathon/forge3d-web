import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function acquireFileHostLock(path) {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  let descriptor;
  try {
    descriptor = openSync(resolved, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") return null;
    throw error;
  }
  let released = false;
  return {
    path: resolved,
    release() {
      if (released) throw new Error("host lock was already released");
      closeSync(descriptor);
      unlinkSync(resolved);
      released = true;
    },
  };
}
