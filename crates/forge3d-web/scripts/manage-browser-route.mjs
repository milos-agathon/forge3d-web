import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function startBrowserRoute({
  fixtureRoot,
  serverModule,
  cloudflared,
  tunnelToken,
  originPolicy,
  hostId,
  nonceRecord,
  packageSha256,
  applicationPort,
  assetPort,
  statePath,
  logDirectory,
  dependencies = productionDependencies(),
}) {
  const host = originPolicy.hosts.find(
    (candidate) => candidate.hostAssetId === hostId,
  );
  if (
    !host ||
    !isAbsolute(fixtureRoot ?? "") ||
    !isAbsolute(serverModule ?? "") ||
    !isAbsolute(cloudflared ?? "") ||
    !/^[A-Za-z0-9._~-]{20,}$/u.test(tunnelToken ?? "") ||
    !/^[0-9a-f]{64}$/u.test(packageSha256 ?? "") ||
    nonceRecord.basePath !==
      `/runs/${nonceRecord.runId}/${nonceRecord.jobId}/${nonceRecord.nonce}/`
  ) {
    throw new Error("browser route configuration is invalid");
  }
  const logs = resolve(logDirectory);
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const children = [];
  try {
    children.push(
      dependencies.spawnProcess({
        name: "fixture-application",
        command: process.execPath,
        args: fixtureArguments({
          serverModule,
          role: "application",
          fixtureRoot,
          host,
          basePath: nonceRecord.basePath,
          port: applicationPort,
        }),
        logPath: resolve(logs, "fixture-application.log"),
      }),
      dependencies.spawnProcess({
        name: "fixture-asset",
        command: process.execPath,
        args: fixtureArguments({
          serverModule,
          role: "asset",
          fixtureRoot,
          host,
          basePath: nonceRecord.basePath,
          port: assetPort,
        }),
        logPath: resolve(logs, "fixture-asset.log"),
      }),
    );
    await dependencies.waitForLocalFixture({
      port: applicationPort,
      host: host.applicationHost,
      path: `${nonceRecord.basePath}package.sha256`,
      expectedBodyPrefix: packageSha256,
    });
    await dependencies.waitForLocalFixture({
      port: assetPort,
      host: host.assetHost,
      path: `${nonceRecord.basePath}cors/allow/terrain.bin`,
      origin: `https://${host.applicationHost}`,
    });
    children.push(
      dependencies.spawnProcess({
        name: "cloudflared",
        command: cloudflared,
        args: ["tunnel", "--no-autoupdate", "run"],
        environment: { TUNNEL_TOKEN: tunnelToken },
        logPath: resolve(logs, "cloudflared.log"),
      }),
    );
    const binding = {
      schemaVersion: 1,
      applicationHost: host.applicationHost,
      assetHost: host.assetHost,
      basePath: nonceRecord.basePath,
      applicationUrl: `https://${host.applicationHost}${nonceRecord.basePath}`,
      assetUrl: `https://${host.assetHost}${nonceRecord.basePath}`,
      expectedPackageSha256: packageSha256,
    };
    const state = {
      schemaVersion: 1,
      hostId,
      binding,
      processes: children.map(({ name, pid }) => ({ name, pid })),
      startedAt: dependencies.now().toISOString(),
      cleanup: null,
    };
    writeJson(statePath, state);
    return state;
  } catch (error) {
    for (const child of children.reverse()) {
      await dependencies.stopProcess(child.pid).catch(() => undefined);
    }
    throw error;
  }
}

export async function stopBrowserRoute({
  statePath,
  dependencies = productionDependencies(),
}) {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const stopped = [];
  for (const processRecord of [...state.processes].reverse()) {
    const result = await dependencies.stopProcess(processRecord.pid);
    stopped.push({
      ...processRecord,
      stopped: result.stopped === true,
      exitObserved: result.exitObserved === true,
    });
  }
  if (stopped.some((entry) => !entry.stopped || !entry.exitObserved)) {
    throw new Error("fixture or tunnel process cleanup was not proven");
  }
  state.cleanup = {
    stopped,
    completedAt: dependencies.now().toISOString(),
  };
  writeJson(statePath, state);
  return state;
}

function productionDependencies() {
  return {
    now: () => new Date(),
    spawnProcess({ name, command, args, environment = {}, logPath }) {
      const descriptor = openSync(logPath, "a", 0o600);
      const child = spawn(command, args, {
        detached: true,
        shell: false,
        stdio: ["ignore", descriptor, descriptor],
        env: { ...routeProcessEnvironment(process.env), ...environment },
      });
      closeSync(descriptor);
      child.unref();
      return { name, pid: child.pid };
    },
    async waitForLocalFixture({
      port,
      host,
      path,
      origin = undefined,
      expectedBodyPrefix = undefined,
    }) {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          headers: {
            Host: host,
            ...(origin ? { Origin: origin } : {}),
          },
        }).catch(() => null);
        if (response?.ok) {
          const body = await response.text();
          if (!expectedBodyPrefix || body.startsWith(expectedBodyPrefix)) return;
        }
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, 250),
        );
      }
      throw new Error(`local fixture did not become ready on port ${port}`);
    },
    async stopProcess(pid) {
      if (!Number.isInteger(pid) || pid < 2) {
        throw new Error("refusing to stop an invalid process ID");
      }
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (error.code === "ESRCH") {
          return { stopped: true, exitObserved: true };
        }
        throw error;
      }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, 250),
        );
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") {
            return { stopped: true, exitObserved: true };
          }
          throw error;
        }
      }
      throw new Error(`process ${pid} did not exit after SIGTERM`);
    },
  };
}

function routeProcessEnvironment(environment) {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "TMP",
    "TEMP",
    "TMPDIR",
    "LANG",
  ]);
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => allowed.has(name)),
  );
}

function fixtureArguments({
  serverModule,
  role,
  fixtureRoot,
  host,
  basePath,
  port,
}) {
  return [
    serverModule,
    "--role",
    role,
    "--fixture-root",
    fixtureRoot,
    "--application-host",
    host.applicationHost,
    "--asset-host",
    host.assetHost,
    "--base-path",
    basePath,
    "--port",
    String(port),
  ];
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function parseArguments(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || result.has(key)) {
      throw new Error(`invalid or duplicate argument near ${key ?? "<end>"}`);
    }
    result.set(key, value);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  if (args.get("--operation") === "stop") {
    await stopBrowserRoute({ statePath: args.get("--state") });
  } else if (args.get("--operation") === "start") {
    await startBrowserRoute({
      fixtureRoot: args.get("--fixture-root"),
      serverModule: args.get("--server-module"),
      cloudflared: args.get("--cloudflared"),
      tunnelToken: process.env.FORGE3D_CLOUDFLARED_TOKEN,
      originPolicy: JSON.parse(readFileSync(args.get("--origin-policy"), "utf8")),
      hostId: args.get("--host-id"),
      nonceRecord: JSON.parse(readFileSync(args.get("--nonce"), "utf8")),
      packageSha256: args.get("--package-sha256"),
      applicationPort: Number(args.get("--application-port")),
      assetPort: Number(args.get("--asset-port")),
      statePath: args.get("--state"),
      logDirectory: args.get("--log-directory"),
    });
  } else {
    throw new Error("--operation start|stop is required");
  }
}
