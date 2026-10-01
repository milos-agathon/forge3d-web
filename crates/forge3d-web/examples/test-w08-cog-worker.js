// W08 (G3): module worker hosting the COG decode handler. Dev-server mode
// imports the facade source; the installed-tarball consumer rewrites the
// specifier below to the packaged dist module (worker-src 'self' — no
// blob workers).
import {
  createCogWorkerHandler,
  serveForge3DMessagePort,
} from "../src-ts/index.ts";

serveForge3DMessagePort(self, {
  run: createCogWorkerHandler(),
});
