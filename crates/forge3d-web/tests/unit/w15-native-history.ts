import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../../", import.meta.url));

interface NativeHistorySource {
  revision: string;
  path: string;
  bytes: Uint8Array;
}

/** Frozen hashes remain mandatory; history adds an independent check when present. */
export function crossCheckNativeHistoryBatch(sources: readonly NativeHistorySource[]): boolean[] {
  if (sources.length === 0) return [];
  const revisions = [...new Set(sources.map((source) => source.revision))];
  const expressions = [...revisions.map((revision) => `${revision}^{commit}`),
    ...sources.map(({ revision, path }) => `${revision}:${path}`)];
  if (expressions.some((expression) => /[\r\n\0]/u.test(expression)))
    throw new Error("Native Git batch expressions must be single lines");
  // One process avoids serial Git startup costs without replacing actual
  // historical bytes with object hashes or weakening the frozen SHA checks.
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: root, stdio: "pipe", input: expressions.join("\n") + "\n",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT")
      return sources.map(() => false);
    throw result.error;
  }
  if (result.signal) throw new Error(`Git native batch interrupted: ${result.signal}`);
  if (result.status !== 0)
    throw new Error(`Cannot read native Git batch: ${result.stderr.toString("utf8")}`);

  let offset = 0;
  const objects = expressions.map((expression, index): Buffer | undefined => {
    const newline = result.stdout.indexOf(10, offset);
    if (newline < 0) throw new Error("Truncated native Git batch header");
    const header = result.stdout.subarray(offset, newline).toString("utf8");
    offset = newline + 1;
    if (header === `${expression} missing`) return undefined;
    const fields = /^([a-f0-9]{40,64}) (commit|blob|tree|tag) (\d+)$/u.exec(header);
    const expectedType = index < revisions.length ? "commit" : "blob";
    if (!fields || fields[2] !== expectedType)
      throw new Error(`Invalid native Git batch object: ${expression}`);
    const size = Number(fields[3]);
    const end = offset + size;
    if (!Number.isSafeInteger(size) || end >= result.stdout.length || result.stdout[end] !== 10)
      throw new Error(`Truncated native Git batch object: ${expression}`);
    const bytes = result.stdout.subarray(offset, end);
    offset = end + 1;
    return bytes;
  });
  if (offset !== result.stdout.length) throw new Error("Unexpected native Git batch output");
  const commits = new Map(revisions.map((revision, index) => [revision, objects[index] !== undefined]));
  return sources.map(({ revision, path, bytes }, index) => {
    if (!commits.get(revision)) return false;
    const actual = objects[revisions.length + index];
    if (actual === undefined)
      throw new Error(`Cannot read available native Git blob: ${revision}:${path}`);
    if (!actual.equals(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)))
      throw new Error(`Frozen native bytes differ from Git: ${revision}:${path}`);
    return true;
  });
}

export function crossCheckNativeHistory(revision: string, path: string, bytes: Uint8Array): boolean {
  return crossCheckNativeHistoryBatch([{ revision, path, bytes }])[0]!;
}
