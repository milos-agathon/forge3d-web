import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureHostInventory,
  observeLiveOsBuild,
  observeLiveSession,
} from "./capture-host-inventory.mjs";

export function resolveHostRuntime({
  helper,
  lane,
  hostId,
  policy,
  platform = process.platform,
  execute = execFileSync,
  environment = process.env,
  now = new Date(),
}) {
  if (
    !isAbsolute(helper ?? "") ||
    !/^[a-z0-9-]+$/u.test(lane ?? "") ||
    !/^FW-(?:MAC|WIN|LNX)-[A-Z0-9-]+$/u.test(hostId ?? "")
  ) {
    throw new Error("host runtime resolution requires a checked helper/lane/host");
  }
  const observed = JSON.parse(
    execute(
      helper,
      ["capture", "--lane", lane, "--host-id", hostId],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    ),
  );
  if (
    observed.schemaVersion !== 1 ||
    observed.hostId !== hostId ||
    observed.lane !== lane ||
    observed.platform !== platform ||
    observed.session !== undefined ||
    observed.osBuild !== undefined
  ) {
    throw new Error("host runtime helper returned an invalid or synthesized record");
  }
  const inventory = captureHostInventory({
    assetId: hostId,
    platform,
    osBuild: observeLiveOsBuild(platform, { execute }),
    displayServer:
      observed.displayServer ??
      (platform === "darwin"
        ? "WindowServer"
        : platform === "win32"
          ? "Desktop Window Manager"
          : "GNOME Wayland"),
    session: observeLiveSession(platform, { execute, environment }),
    browsers: observed.browsers,
    tools: observed.tools,
    launchArguments: observed.launchArguments ?? [],
    capturedAt: now,
    policy,
  });
  return {
    inventory,
    resolvedChannels: inventory.browsers.map(({ id, version }) => ({
      id,
      version,
    })),
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
  const result = resolveHostRuntime({
    helper: process.env.FORGE3D_BROWSER_INVENTORY_HELPER,
    lane: args.get("--lane"),
    hostId: args.get("--host-id"),
    policy: JSON.parse(readFileSync(args.get("--policy"), "utf8")),
  });
  writeFileSync(
    args.get("--inventory-output"),
    `${JSON.stringify(result.inventory, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    args.get("--channels-output"),
    `${JSON.stringify(result.resolvedChannels, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}
