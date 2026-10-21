// Generated from complete runtime source/build inputs and W00 codec pins.
import type { CodecDescriptor } from './codec-types.js';
export const CODEC_CATALOG: readonly CodecDescriptor[] = [
  {
    "id": "geotiff",
    "format": "tiff",
    "owner": "W08",
    "revision": "8a0eee6e7a32424d65b4a6e0396bb8c313b1b1b41cebe11fcab5bfe6e0c8bce7",
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
    "revision": "3e0f3682170f5b8561c732442ee4bec998a4340efa2130a02e88b91c0ec847e5",
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
    "revision": "c42dca6fcac2aa60fbc59c6c25e80c71042917dc1734eb81185a7b42b2f3daeb",
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
    "revision": "702824bf89f63c9ba9131cd90830ac401d28e146d81aed6326c711fccb11e0fc",
    "dependencies": []
  },
  {
    "id": "exr-wasm",
    "format": "exr",
    "owner": "W06",
    "revision": "007f774819fbfc4bcc822ae43cf538fb5707fd01999f655d74f63ab881d228e1",
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
    "revision": "702824bf89f63c9ba9131cd90830ac401d28e146d81aed6326c711fccb11e0fc",
    "dependencies": []
  },
  {
    "id": "mapbox-glyph-pbf",
    "format": "glyph-pbf",
    "owner": "W13/W19",
    "revision": "702824bf89f63c9ba9131cd90830ac401d28e146d81aed6326c711fccb11e0fc",
    "dependencies": []
  }
];
export const DENOISER_REVISION = '74dc651060577fccc3476e81ac171e7af4d333f5a0d724192ad0b2ffae2c34fe';
