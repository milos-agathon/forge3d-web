// Generated from complete runtime source/build inputs and W00 codec pins.
import type { CodecDescriptor } from './codec-types.js';
export const CODEC_CATALOG: readonly CodecDescriptor[] = [
  {
    "id": "geotiff",
    "format": "tiff",
    "owner": "W08",
    "revision": "caa6cf23ac4101b34e3f050631c34ea22debd358f95ad5e67597573abd5dfa4e",
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
    "revision": "fb96b566d441514630a20dbba7782eb599116e8166a27282263549f2daf9283c",
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
    "revision": "e9e34ca277273ead4cacfb2cdf3afcb31e2b0a554723e92550759258512d0521",
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
    "revision": "8a531fb99579b42701f8cc0f175436e640b4d6da35f7f1984a848ed3ff70eb72",
    "dependencies": []
  },
  {
    "id": "exr-wasm",
    "format": "exr",
    "owner": "W06",
    "revision": "7a9273fae5d33d09853db9b041e2565a90fa3785eed47b271456048b2fd448ab",
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
    "revision": "8a531fb99579b42701f8cc0f175436e640b4d6da35f7f1984a848ed3ff70eb72",
    "dependencies": []
  },
  {
    "id": "mapbox-glyph-pbf",
    "format": "glyph-pbf",
    "owner": "W13/W19",
    "revision": "8a531fb99579b42701f8cc0f175436e640b4d6da35f7f1984a848ed3ff70eb72",
    "dependencies": []
  }
];
export const DENOISER_REVISION = '85ae1be18740ded3d8a0585f2cf72fd69f92b5db61e02f9a751ce9365934848e';
