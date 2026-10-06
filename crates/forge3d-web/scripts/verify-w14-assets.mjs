import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root));
const json = (p) => JSON.parse(read(p));
const sha = (p) => createHash("sha256").update(read(p)).digest("hex");
const assert = (ok, message) => {
  if (!ok) throw Error(message);
};
const dependency = json("../../docs/parity/dependency-lock.json").assets.find(
  (a) => a.id === "proj-wasm",
);
const npm = json("package-lock.json").packages["node_modules/proj-wasm"];
const provenance = json("assets/proj/provenance.json");
const factory = (await import(new URL("assets/proj/proj-emscripten.js", root))).default;
assert(Function.prototype.toString.call(factory) + "export default PROJModule;\n" === read("assets/proj/proj-emscripten.js").toString(),
  "Pinned module must contain only the PROJ factory declaration and export");
assert(
  npm.version === "0.1.0-alpha9" &&
    npm.integrity === dependency.source.integrity &&
    provenance.tarballSha256 === dependency.source.sha256,
  "PROJ must match the W00 dependency lock",
);
for (const asset of [
  ...provenance.assets,
  ...provenance.grids,
  ...provenance.notices,
]) {
  const path = "assets/proj/" + asset.name;
  assert(
    sha(path) === asset.sha256 && read(path).length === asset.byteLength,
    "W14 asset mismatch: " + asset.name,
  );
  assert(
    dependency.build.artifacts.some(
      (a) => a.name === path && a.sha256 === asset.sha256,
    ),
    "W00 emitted asset is not pinned: " + path,
  );
  if (
    provenance.assets.includes(asset) &&
    existsSync(new URL("node_modules/proj-wasm/dist/" + asset.name, root))
  )
    assert(
      sha("node_modules/proj-wasm/dist/" + asset.name) === asset.sha256,
      "Installed upstream PROJ changed: " + asset.name,
    );
}
for (const asset of json("assets/datasets/provenance.json").bundled)
  assert(
    sha("assets/datasets/" + asset.path) === asset.sha256,
    "Native bundled dataset changed: " + asset.path,
  );
assert(
  read("assets/proj/LICENSE")
    .toString()
    .includes("Permission is hereby granted"),
  "Missing proj-wasm MIT notice",
);
assert(
  read("assets/proj/PROJ-COPYING")
    .toString()
    .includes("Permission is hereby granted"),
  "Missing native PROJ notice",
);
assert(
  read("assets/proj/GRID-LICENSE.txt")
    .toString()
    .includes("*License*: Public Domain"),
  "Missing NOAA grid attribution",
);
console.log("W14 exact PROJ, grid, native dataset assets and notices verified");
