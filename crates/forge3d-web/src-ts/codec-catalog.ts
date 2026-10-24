// Generated from complete runtime source/build inputs and W00 codec pins.
import type { CodecDescriptor } from './codec-types.js';
export const CODEC_CATALOG: readonly CodecDescriptor[] = [
  {
    "id": "geotiff",
    "format": "tiff",
    "owner": "W08",
    "revision": "84f346e94f9fe91da732881e502bd93c6fc923e26567ab80796743bc064720ba",
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
    "revision": "e0bc15842920fb82cd0727ea12aa3b30ffa64e35255f6e40bdf46fefaf4ba6e5",
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
    "revision": "10fbd06a512066ead64d69ee0972ee84f4885fa44b83b80c6398e1b919201903",
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
    "revision": "b82c1f77f8a4f9a79f08a72c2d7f3bc68b7d0c5c4b8649d489c053a517e0521a",
    "dependencies": []
  },
  {
    "id": "exr-wasm",
    "format": "exr",
    "owner": "W06",
    "revision": "2e1599a99384bb4b369a6b9e4a42d7b23ac4ce1e26df1a85900d8b2a4dbcd6e3",
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
    "revision": "b82c1f77f8a4f9a79f08a72c2d7f3bc68b7d0c5c4b8649d489c053a517e0521a",
    "dependencies": []
  },
  {
    "id": "mapbox-glyph-pbf",
    "format": "glyph-pbf",
    "owner": "W13/W19",
    "revision": "b82c1f77f8a4f9a79f08a72c2d7f3bc68b7d0c5c4b8649d489c053a517e0521a",
    "dependencies": []
  }
];
export const DENOISER_REVISION = '66ae265a9edc240dcb5c9c65172fa7971df68f6bc3998a1fafa8495a2553be26';
