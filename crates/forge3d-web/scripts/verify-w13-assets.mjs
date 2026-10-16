import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(root, p));
const json = (p) => JSON.parse(read(p));
const sha = (p) => createHash("sha256").update(read(p)).digest("hex");
const assert = (ok, message) => {
  if (!ok) throw Error(message);
};
const dependency = json("../../docs/parity/dependency-lock.json").assets.find(
  (a) => a.id === "harfbuzzjs",
);
const lock = json("package-lock.json").packages["node_modules/harfbuzzjs"];
assert(
  lock.version === "1.6.0" && lock.integrity === dependency.source.integrity,
  "HarfBuzz must match the W00 exact package lock",
);
for (const family of ["fonts", "harfbuzz"]) {
  const provenance = json(`assets/${family}/provenance.json`);
  for (const asset of provenance.assets)
    assert(
      sha(`assets/${family}/${asset.file}`) === asset.sha256,
      `W13 asset integrity mismatch: ${asset.file}`,
    );
}
const fonts = json("assets/fonts/provenance.json");
assert(
  sha("assets/fonts/OFL.txt") === fonts.licenseSha256,
  "Noto license changed",
);
const hb = json("assets/harfbuzz/provenance.json");
assert(hb.version === "1.6.0", "HarfBuzz version changed");
assert(
  /Permission is hereby granted, free of charge/.test(
    read("assets/harfbuzz/LICENSE").toString(),
  ),
  "Missing HarfBuzz MIT notice",
);
if (existsSync(resolve(root, "node_modules/harfbuzzjs/dist/index.mjs"))) {
  assert(
    sha("node_modules/harfbuzzjs/dist/index.mjs") === hb.upstreamIndexSha256,
    "HarfBuzz adapter upstream changed",
  );
  for (const file of ["harfbuzz.js", "harfbuzz.wasm"])
    assert(
      sha(`node_modules/harfbuzzjs/dist/${file}`) ===
        sha(`assets/harfbuzz/${file}`),
      `HarfBuzz upstream ${file} differs`,
    );
}
console.log(
  "W13 exact dependency, shaping assets, deterministic fonts and licenses verified",
);
