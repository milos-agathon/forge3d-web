import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stopBrowserRoute } from "./manage-browser-route.mjs";
import { enforceHostUpdatePolicy, closeUpdateWindow } from "./manage-browser-update-window.mjs";

export async function cleanupBrowserHardware({
  routeStatePath,
  updateStatePath,
  processRegistryPath,
  outputPath,
  updateHelper,
  dependencies = productionDependencies(),
}) {
  const result = {
    schemaVersion: 1,
    updatesRestored: false,
    browserDriversStopped: false,
    appiumStopped: false,
    fixturesStopped: false,
    tunnelsStopped: false,
    completedAt: null,
  };
  const errors = [];

  if (routeStatePath && existsSync(routeStatePath)) {
    try {
      const route = await stopBrowserRoute({
        statePath: routeStatePath,
        dependencies: dependencies.route,
      });
      const processes = route.cleanup.stopped;
      result.fixturesStopped = processes
        .filter(({ name }) => name.startsWith("fixture-"))
        .every(({ stopped, exitObserved }) => stopped && exitObserved);
      result.tunnelsStopped = processes
        .filter(({ name }) => name === "cloudflared")
        .every(({ stopped, exitObserved }) => stopped && exitObserved);
    } catch (error) {
      errors.push(error);
    }
  } else {
    result.fixturesStopped = true;
    result.tunnelsStopped = true;
  }

  if (processRegistryPath && existsSync(processRegistryPath)) {
    const registry = JSON.parse(readFileSync(processRegistryPath, "utf8"));
    for (const processRecord of registry.processes) {
      if (processRecord.stopped !== true) {
        try {
          const stopped = await dependencies.stopProcess(processRecord.pid);
          processRecord.stopped =
            stopped.stopped === true && stopped.exitObserved === true;
        } catch (error) {
          errors.push(error);
        }
      }
    }
    writeFileSync(
      processRegistryPath,
      `${JSON.stringify(registry, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    result.browserDriversStopped = registry.processes
      .filter(({ name }) => name !== "appium")
      .every(({ stopped }) => stopped);
    result.appiumStopped = registry.processes
      .filter(({ name }) => name === "appium")
      .every(({ stopped }) => stopped);
  } else {
    result.browserDriversStopped = true;
    result.appiumStopped = true;
  }

  if (updateStatePath && existsSync(updateStatePath)) {
    try {
      const update = JSON.parse(readFileSync(updateStatePath, "utf8"));
      const enforcement = enforceHostUpdatePolicy({
        helper: updateHelper,
        operation: "unfreeze",
        assetId: update.assetId,
        resolvedChannels: update.resolvedChannels,
        execute: dependencies.execute,
      });
      const closed = closeUpdateWindow(update, dependencies.now(), enforcement);
      writeFileSync(
        updateStatePath,
        `${JSON.stringify(closed, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      result.updatesRestored = closed.state === "unfrozen";
    } catch (error) {
      errors.push(error);
    }
  } else {
    result.updatesRestored = true;
  }

  result.completedAt = dependencies.now().toISOString();
  result.errors = errors.map((error) => String(error.message ?? error));
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (
    errors.length > 0 ||
    Object.entries(result)
      .filter(([name]) => name.endsWith("Stopped") || name === "updatesRestored")
      .some(([, passed]) => passed !== true)
  ) {
    throw new Error(`hardware cleanup failed: ${result.errors.join("; ")}`);
  }
  return result;
}

function productionDependencies() {
  const stopProcess = async (pid) => {
    if (!Number.isInteger(pid) || pid < 2) {
      throw new Error("refusing to stop an invalid process ID");
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error.code === "ESRCH") return { stopped: true, exitObserved: true };
      throw error;
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") return { stopped: true, exitObserved: true };
        throw error;
      }
    }
    throw new Error(`process ${pid} did not exit after SIGTERM`);
  };
  return {
    now: () => new Date(),
    execute: undefined,
    stopProcess,
    route: {
      now: () => new Date(),
      stopProcess,
    },
  };
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
  await cleanupBrowserHardware({
    routeStatePath: args.get("--route-state"),
    updateStatePath: args.get("--update-state"),
    processRegistryPath: args.get("--process-registry"),
    outputPath: args.get("--output"),
    updateHelper: process.env.FORGE3D_UPDATE_CONTROL_HELPER,
  });
}
