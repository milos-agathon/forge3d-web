// Generated from complete runtime source/build inputs and W00 codec pins.
import type { CodecDescriptor } from './codec-types.js';
export const CODEC_CATALOG: readonly CodecDescriptor[] = [
  {
    "id": "geotiff",
    "format": "tiff",
    "owner": "W08",
    "revision": "7356be35858d11e25172916782669e5d0c65b5aa3c7367ba126e390ecf4d62d9",
    "dependencies": [
      {
        "id": "geotiff",
        "version": "3.0.5",
        "sha256": "9b3628c4fd2357cddef76a511fc4df3c054ad3a2a9393a0d79797a052f888355"
      }
    ]
  },
  {
    "id": "laz-perf",
    "format": "laz",
    "owner": "W16",
    "revision": "b2e79e86ac59b0f24eebfc760dc90dee3f840493029044f0d6e4ae14bef57a5c",
    "dependencies": [
      {
        "id": "laz-perf",
        "version": "0.0.7",
        "sha256": "7585aa5e425443c639a2580548ebb8c3eed3124bacd7eebbf3ab0fbde2d8e0c4"
      }
    ]
  },
  {
    "id": "ktx2-basis",
    "format": "ktx2",
    "owner": "W04",
    "revision": "9f8e1aa6a895ea3c907d3febaf314dc3fa65303824fc74385382ed2da68122ac",
    "dependencies": [
      {
        "id": "ktx-parse",
        "version": "1.1.0",
        "sha256": "9d4303bbd807faa4e0455f8115f6d75cee7036ec9d5160b6911363074d3ee003"
      },
      {
        "id": "basis-universal",
        "version": "2.0.3",
        "sha256": "eb9ac9ec933524b3c97720368b5cb423fa8767bfc409029d4864063e0d078bec"
      }
    ]
  },
  {
    "id": "radiance-rgbe",
    "format": "hdr",
    "owner": "W04/W15",
    "revision": "87b2c07220d27be4bc68ee37d4d8b06e809b221a55a920ba784e00c1c87abfd4",
    "dependencies": []
  },
  {
    "id": "exr-wasm",
    "format": "exr",
    "owner": "W06",
    "revision": "42b5b6ab8a6a9e09c530053a0bac7f600a78963f49ae52f16bca5181f1c3b6ec",
    "dependencies": [
      {
        "id": "exr",
        "version": "1.74.2",
        "sha256": "711fe42c9964295e01ee3fba3f9fe0e1d24b98886950d68efe81b1c76e21adf3"
      }
    ]
  },
  {
    "id": "gltf2",
    "format": "glb",
    "owner": "W15",
    "revision": "87b2c07220d27be4bc68ee37d4d8b06e809b221a55a920ba784e00c1c87abfd4",
    "dependencies": []
  },
  {
    "id": "mapbox-glyph-pbf",
    "format": "glyph-pbf",
    "owner": "W13/W19",
    "revision": "87b2c07220d27be4bc68ee37d4d8b06e809b221a55a920ba784e00c1c87abfd4",
    "dependencies": []
  }
];
export const DENOISER_REVISION = '5bf0a80beed970ded89f8981cb1a6c2719e45dec3941a2b16cb4d31073f891af';
