import {
  chmodSync,
  chownSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

export const unixRunnerTransientPaths = Object.freeze([
  Object.freeze({ name: "_diag", kind: "tree" }),
  Object.freeze({ name: "_work", kind: "tree" }),
  Object.freeze({ name: ".credentials", kind: "file" }),
  Object.freeze({ name: ".credentials_rsaparams", kind: "file" }),
  Object.freeze({ name: ".runner", kind: "file" }),
  Object.freeze({ name: ".env", kind: "file" }),
  Object.freeze({ name: ".path", kind: "file" }),
]);

export function prepareRunnerTransientPaths(
  runnerDirectory,
  uid,
  controllerGid,
  { chmod = chmodSync, chown = chownSync } = {},
) {
  assertHandoffIdentity(uid, controllerGid);
  const runnerRoot = realpathSync(runnerDirectory);
  for (const entry of unixRunnerTransientPaths) {
    const path = join(runnerRoot, entry.name);
    if (pathExists(path)) {
      throw new Error(`runner transient path is not clean: ${entry.name}`);
    }
    if (entry.kind === "tree") {
      mkdirSync(path, { recursive: false, mode: 0o700 });
    } else {
      writeFileSync(path, "", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
    chown(path, uid, controllerGid);
    chmod(path, entry.kind === "tree" ? 0o2770 : 0o660);
  }
}

export function grantInteractiveJobTraversal(
  runnerDirectory,
  {
    controllerUid,
    interactiveUid,
    interactiveUser,
    platform = process.platform,
    execute = execFileSync,
    stat = lstatSync,
  },
) {
  assertTraversalIdentity({
    controllerUid,
    interactiveUid,
    interactiveUser,
    platform,
  });
  const runnerRoot = realpathSync(runnerDirectory);
  const jobRoot = dirname(runnerRoot);
  if (
    basename(runnerRoot) !== "runner" ||
    !ownedDirectory(stat(jobRoot), controllerUid) ||
    !ownedDirectory(stat(runnerRoot), controllerUid)
  ) {
    throw new Error("runner traversal target is not controller-owned");
  }
  if (platform === "linux") {
    execute(
      "/usr/bin/setfacl",
      ["--modify", `user:${interactiveUid}:--x`, "--", jobRoot],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  } else {
    execute(
      "/bin/chmod",
      ["+a", `user:${interactiveUser} allow search`, jobRoot],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  }
  return jobRoot;
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertHandoffIdentity(uid, gid) {
  if (
    !Number.isInteger(uid) ||
    uid < 1 ||
    !Number.isInteger(gid) ||
    gid < 1
  ) {
    throw new Error("runner transient ownership identity is invalid");
  }
}

function assertTraversalIdentity({
  controllerUid,
  interactiveUid,
  interactiveUser,
  platform,
}) {
  if (
    !["darwin", "linux"].includes(platform) ||
    !Number.isInteger(controllerUid) ||
    controllerUid < 1 ||
    !Number.isInteger(interactiveUid) ||
    interactiveUid < 1 ||
    interactiveUid === controllerUid ||
    !/^[a-z_][a-z0-9_-]*$/u.test(interactiveUser ?? "") ||
    interactiveUser === "root"
  ) {
    throw new Error("runner traversal identity is invalid");
  }
}

function ownedDirectory(stats, controllerUid) {
  return (
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    stats.uid === controllerUid
  );
}
