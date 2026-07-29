import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const drivers = new Set([
  "playwright-chrome",
  "playwright-edge",
  "safaridriver",
  "selenium-firefox",
  "appium-uiautomator2",
  "appium-xcuitest",
  "infrastructure-canary",
]);

export async function runBrowserLane({
  lane,
  driver,
  binding,
  adapterSmoke,
  assertions,
  cleanup,
}) {
  if (!drivers.has(driver)) {
    throw new Error(`browser driver is not a checked value: ${driver}`);
  }
  if (!binding || binding.lane !== lane) {
    throw new Error("browser-neutral harness binding does not match its lane");
  }
  let primaryError = null;
  try {
    const adapter = await adapterSmoke({ lane, driver, binding });
    if (
      !adapter.deviceCreated ||
      !adapter.surfacePresented ||
      adapter.isFallbackAdapter !== false
    ) {
      throw new Error("adapter smoke did not prove required hardware presentation");
    }
    const assertionResult =
      driver === "infrastructure-canary"
        ? { supportAssertionsExecuted: false, passed: true }
        : await assertions({ lane, driver, binding, adapter });
    if (!assertionResult.passed) {
      throw new Error("browser-owned assertion payload failed");
    }
    return {
      schemaVersion: 1,
      ...binding,
      driver,
      adapter,
      assertions: assertionResult,
      result: "PASS",
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const result = await cleanup({ lane, driver, binding }).catch((error) => ({
      ok: false,
      error: error.message,
    }));
    if (result.ok !== true && primaryError === null) {
      throw new Error(`hardware harness cleanup failed: ${result.error}`);
    }
  }
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
  const binding = JSON.parse(readFileSync(args.get("--binding"), "utf8"));
  const adapter = JSON.parse(
    readFileSync(args.get("--adapter-evidence"), "utf8"),
  );
  const assertions = JSON.parse(
    readFileSync(args.get("--assertion-result"), "utf8"),
  );
  const record = await runBrowserLane({
    lane: args.get("--lane"),
    driver: args.get("--driver"),
    binding,
    adapterSmoke: async () => adapter,
    assertions: async () => assertions,
    cleanup: async () => ({ ok: true }),
  });
  writeFileSync(args.get("--output"), `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, output: args.get("--output") }));
}
