import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export function materializeSeleniumHarness({ promotionDirectory, outputDirectory }) {
  const promotion = realpathSync(resolve(promotionDirectory));
  const output = resolve(outputDirectory);
  const manifest = readJson(join(promotion, "browser-package-manifest.json"));
  const lockPath = join(promotion, "selenium-harness-lock.json");
  const archivePath = join(promotion, "selenium-harness.tar.gz");
  for (const [name, path] of [["selenium-harness-lock.json", lockPath],
    ["selenium-harness.tar.gz", archivePath]]) {
    const entries = manifest.files?.filter((entry) => entry.name === name) ?? [];
    if (entries.length !== 1 || !/^[0-9a-f]{64}$/u.test(entries[0].sha256 ?? "") ||
        sha256(promotedBytes(path, name)) !== entries[0].sha256) {
      throw new Error(`promoted Selenium artifact is missing or tampered: ${name}`);
    }
  }
  const lock = readJson(lockPath);
  if (lock.schemaVersion !== 1 || lock.rootPackage !== "selenium-webdriver" ||
      lock.rootVersion !== "4.35.0" || !/^[0-9a-f]{64}$/u.test(lock.archiveSha256 ?? "") ||
      sha256(readFileSync(archivePath)) !== lock.archiveSha256 || !Array.isArray(lock.packages) ||
      lock.packages.length === 0 || Object.keys(lock).sort().join(",") !==
        ["archiveSha256", "packages", "rootPackage", "rootVersion", "schemaVersion"].sort().join(",")) {
    throw new Error("promoted Selenium lock is invalid or does not bind the archive");
  }
  const paths = new Set();
  for (const entry of lock.packages) {
    if (!entry || Object.keys(entry).sort().join(",") !== ["integrity", "name", "path", "version"].sort().join(",") ||
        entry.path !== `node_modules/${entry.name}` || !/^sha512-/u.test(entry.integrity ?? "") ||
        typeof entry.version !== "string" || paths.has(entry.path)) {
      throw new Error("promoted Selenium lock contains an invalid package entry");
    }
    paths.add(entry.path);
  }
  if (!paths.has("node_modules/selenium-webdriver")) throw new Error("promoted Selenium lock omits its root package");
  mkdirSync(output, { recursive: false });
  const extraction = spawnSync("tar", ["-xzf", archivePath, "-C", output], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (extraction.status !== 0) throw new Error(`promoted Selenium archive extraction failed: ${extraction.stderr.trim()}`);
  const outputReal = realpathSync(output);
  for (const entry of lock.packages) {
    const directory = join(outputReal, entry.path);
    const packagePath = join(directory, "package.json");
    const stats = lstatSync(packagePath);
    if (!stats.isFile() || stats.isSymbolicLink() || relative(outputReal, realpathSync(packagePath)).startsWith("..")) {
      throw new Error(`promoted Selenium package is unsafe: ${entry.name}`);
    }
    const installed = readJson(packagePath);
    if (installed.name !== entry.name || installed.version !== entry.version) {
      throw new Error(`promoted Selenium package does not match its lock: ${entry.name}`);
    }
  }
  const discovered = topLevelPackages(join(outputReal, "node_modules"));
  if (discovered.sort().join(",") !== [...paths].sort().join(",")) {
    throw new Error("promoted Selenium archive contains missing or unbound packages");
  }
  const modulePath = join(outputReal, "node_modules", "selenium-webdriver", "index.js");
  const moduleStats = lstatSync(modulePath);
  if (!moduleStats.isFile() || moduleStats.isSymbolicLink()) throw new Error("promoted Selenium root module is unsafe");
  return modulePath;
}

function promotedBytes(path, name) {
  try { return readFileSync(path); } catch { throw new Error(`promoted Selenium artifact is missing or tampered: ${name}`); }
}

function topLevelPackages(nodeModules) {
  return readdirSync(nodeModules).flatMap((name) => {
    const path = join(nodeModules, name);
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("promoted Selenium archive has unsafe package entries");
    return name.startsWith("@") ? readdirSync(path).map((child) => `node_modules/${name}/${child}`) : [`node_modules/${name}`];
  });
}

function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function parseArguments(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || result.has(key)) throw new Error(`invalid argument near ${key ?? "<end>"}`);
    result.set(key, value);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  console.log(materializeSeleniumHarness({
    promotionDirectory: args.get("--promotion"), outputDirectory: args.get("--output"),
  }));
}
