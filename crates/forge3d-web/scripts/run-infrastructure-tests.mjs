import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testDirectories = [
  resolve(packageRoot, "tests", "infrastructure"),
  resolve(packageRoot, "..", "..", "tools", "browser-lab-broker", "test"),
  resolve(packageRoot, "..", "..", "tools", "browser-lab-controller", "test"),
];
const testFiles = testDirectories
  .flatMap((directory) =>
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
      .map((entry) => resolve(directory, entry.name)),
  )
  .sort();

if (testFiles.length === 0) {
  throw new Error("No infrastructure test files were discovered");
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: packageRoot,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
