import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  source = join(root, "node_modules/laz-perf"),
  dest = join(root, "assets/laz");
const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
if (pkg.version !== "0.0.7")
  throw Error("W16 requires lock-pinned laz-perf@0.0.7");
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"))
  .packages["node_modules/laz-perf"];
const normative = JSON.parse(
  readFileSync(join(root, "../../docs/parity/dependency-lock.json"), "utf8"),
).assets.find((d) => d.id === "laz-perf");
if (lock.integrity !== normative.source.integrity)
  throw Error("LAZ npm integrity differs from W00 lock");
mkdirSync(dest, { recursive: true });
// Keep upstream factory bytes. The only adapter is an ESM export after its UMD footer.
writeFileSync(
  join(dest, "laz-perf.js"),
  readFileSync(join(source, "lib/web/laz-perf.js"), "utf8") +
    "\nexport default createLazPerf;\n",
);
copyFileSync(
  join(source, "lib/web/laz-perf.wasm"),
  join(dest, "laz-perf.wasm"),
);
// The npm 0.0.7 archive omits its license; retain the pinned upstream Apache-2.0 text.
copyFileSync(
  join(root, "tests/fixtures/w16/laz-perf.LICENSE"),
  join(dest, "laz-perf.LICENSE"),
);
const assets = ["laz-perf.js", "laz-perf.wasm", "laz-perf.LICENSE"].map(
  (file) => ({
    file,
    sha256: createHash("sha256")
      .update(readFileSync(join(dest, file)))
      .digest("hex"),
  }),
);
writeFileSync(
  join(dest, "provenance.json"),
  JSON.stringify(
    {
      package: "laz-perf",
      version: pkg.version,
      integrity: lock.integrity,
      adapter: "UMD factory plus ESM export",
      assets,
    },
    null,
    2,
  ) + "\n",
);
