// Generated from complete runtime source/build inputs and W00 codec pins.
import type { CodecDescriptor } from './codec-types.js';
export const CODEC_CATALOG: readonly CodecDescriptor[] = [
  {
    "id": "geotiff",
    "format": "tiff",
    "owner": "W08",
    "revision": "05ec4f7f4cf3361f3741ce578218019edb6b7ba2df93b1be6f1da943913f4cd4",
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
    "revision": "8d034db362632d9ceba62cee68f26aba63205acd563c308741e0db35d3a5513c",
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
    "revision": "2a9da7999f0d3a241f1e77f81f3918f2b4faa9f5bc3be3fcf28711eb1ce0064d",
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
    "revision": "09acfd6b01db25912af6b2d1165863ae5f90f4d1d59c9deebc5e31f0eb9fcd44",
    "dependencies": []
  },
  {
    "id": "exr-wasm",
    "format": "exr",
    "owner": "W06",
    "revision": "a7380bb04ddace92e45e6188ce11b0b6434fed1bf113c774b7cf41bad243cc5f",
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
    "revision": "09acfd6b01db25912af6b2d1165863ae5f90f4d1d59c9deebc5e31f0eb9fcd44",
    "dependencies": []
  },
  {
    "id": "mapbox-glyph-pbf",
    "format": "glyph-pbf",
    "owner": "W13/W19",
    "revision": "09acfd6b01db25912af6b2d1165863ae5f90f4d1d59c9deebc5e31f0eb9fcd44",
    "dependencies": []
  }
];
export const DENOISER_REVISION = '2f74cb6d3c81380d37dae5ec0896a1f5f4019c55f0300b1ffa691bb877b01349';
