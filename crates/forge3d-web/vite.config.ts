import { defineConfig } from "vite";

let cancelledTerrainReaders = 0;
let cancelledOversizedReaders = 0;

export default defineConfig({
  plugins: [
    {
      name: "forge3d-source-wasm-route",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url === "/tests/slow-terrain-status") {
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                cancelledTerrainReaders,
                cancelledOversizedReaders,
              }),
            );
            return;
          }
          if (request.url === "/tests/oversized-terrain.f32le") {
            response.statusCode = 200;
            response.setHeader("content-type", "application/octet-stream");
            response.write(Buffer.alloc(16));
            let completed = false;
            const overflow = setTimeout(() => {
              response.write(Buffer.alloc(4));
            }, 50);
            const finish = setTimeout(() => {
              completed = true;
              response.end();
            }, 5_000);
            response.once("close", () => {
              clearTimeout(overflow);
              clearTimeout(finish);
              if (!completed) {
                cancelledOversizedReaders += 1;
              }
            });
            return;
          }
          if (request.url === "/tests/slow-terrain.f32le") {
            response.statusCode = 200;
            response.setHeader("content-type", "application/octet-stream");
            response.setHeader("content-length", "16");
            response.write(Buffer.alloc(4));
            let completed = false;
            const finish = setTimeout(() => {
              completed = true;
              response.end(Buffer.alloc(12));
            }, 5_000);
            response.once("close", () => {
              clearTimeout(finish);
              if (!completed) {
                cancelledTerrainReaders += 1;
              }
            });
            return;
          }
          if (
            request.url === "/src-ts/forge3d_web_bg.wasm" ||
            request.url?.startsWith("/src-ts/forge3d_web_bg.wasm?")
          ) {
            request.url = request.url.replace(
              "/src-ts/forge3d_web_bg.wasm",
              "/pkg/forge3d_web_bg.wasm",
            );
          }
          next();
        });
      },
    },
  ],
  build: {
    target: "es2022"
  }
});
