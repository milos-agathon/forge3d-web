import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const commits = new Map<string, boolean>();
/** Frozen hashes remain mandatory; history adds an independent check when present. */
export function crossCheckNativeHistory(
  revision: string,
  path: string,
  bytes: Uint8Array,
): boolean {
  let available = commits.get(revision);
  if (available === undefined) {
    const result = spawnSync(
      "git",
      ["cat-file", "-e", `${revision}^{commit}`],
      { cwd: root, stdio: "pipe" },
    );
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT")
        return false;
      throw result.error;
    }
    if (result.signal)
      throw new Error(`Git commit probe interrupted: ${result.signal}`);
    available = result.status === 0;
    commits.set(revision, available);
  }
  if (!available) return false;
  const result = spawnSync("git", ["show", `${revision}:${path}`], {
    cwd: root,
    stdio: "pipe",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Cannot read available native Git blob: ${revision}:${path}`,
    );
  if (!result.stdout.equals(Buffer.from(bytes)))
    throw new Error(`Frozen native bytes differ from Git: ${revision}:${path}`);
  return true;
}
