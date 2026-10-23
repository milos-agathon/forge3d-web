// Generated from complete runtime source/build inputs and W00 codec pins.
import type { CodecDescriptor } from './codec-types.js';
export const CODEC_CATALOG: readonly CodecDescriptor[] = [
  {
    "id": "geotiff",
    "format": "tiff",
    "owner": "W08",
    "revision": "776633ad48939b8c9ca00b55e37aa664b09bd9bf69fcef93417848cad0a2b46a",
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
    "revision": "2415297f5b1c4ad4cd98d7930189fc5ac0ab66636b810258cb953cb15c6e7893",
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
    "revision": "93ab68cb4af3bd56b8bf3747f8576d58f179930756185c57f8e464d8db95d362",
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
    "revision": "738445cdefbc0a9f8c17a3db1e0eaa64cfdea1d6209b0370c8cfbb0c32d6e37f",
    "dependencies": []
  },
  {
    "id": "exr-wasm",
    "format": "exr",
    "owner": "W06",
    "revision": "13565459ae9117cb36c5a853c3f06866d9c4ca53a941c3d0a62bb78d0fbf143e",
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
    "revision": "738445cdefbc0a9f8c17a3db1e0eaa64cfdea1d6209b0370c8cfbb0c32d6e37f",
    "dependencies": []
  },
  {
    "id": "mapbox-glyph-pbf",
    "format": "glyph-pbf",
    "owner": "W13/W19",
    "revision": "738445cdefbc0a9f8c17a3db1e0eaa64cfdea1d6209b0370c8cfbb0c32d6e37f",
    "dependencies": []
  }
];
export const DENOISER_REVISION = 'ceae703cb6196fc28090da63c38d3b7ec12716c4697e62264cde076434da5be9';
