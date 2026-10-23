import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export async function stopChild(child) {
  if (!child || !Number.isInteger(child.pid)) return; // spawn failed before acquisition
  const absent = () => {
    try { process.kill(child.pid, 0); return false; }
    catch (error) { if (error.code === "ESRCH") return true; throw error; }
  };
  if (absent()) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 100 && !absent(); i++) await delay(100);
  if (absent()) return;
  child.kill("SIGKILL");
  for (let i = 0; i < 50 && !absent(); i++) await delay(100);
  if (!absent()) throw new Error("INFRA_ERROR DRIVER_PROCESS_ABSENCE_UNPROVEN");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function registerProcess(path, name, pid) {
  if (!path) return;
  if (!Number.isInteger(pid) || pid < 2) {
    throw new Error(`cannot register invalid ${name} process`);
  }
  const registry = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { schemaVersion: 1, processes: [] };
  if (
    registry.schemaVersion !== 1 ||
    !Array.isArray(registry.processes) ||
    registry.processes.some((entry) => entry.pid === pid)
  ) {
    throw new Error("browser process registry is invalid");
  }
  registry.processes.push({ name, pid, stopped: false });
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  writeJson(path, registry);
}

export function markProcessStopped(path, pid) {
  if (!path || !existsSync(path)) return;
  const registry = JSON.parse(readFileSync(path, "utf8"));
  const entry = registry.processes.find((candidate) => candidate.pid === pid);
  if (!entry) throw new Error("browser process was not registered");
  entry.stopped = true;
  writeJson(path, registry);
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
