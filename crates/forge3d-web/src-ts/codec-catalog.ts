// Generated from complete runtime source/build inputs and W00 codec pins.
import type { CodecDescriptor } from './codec-types.js';
export const CODEC_CATALOG: readonly CodecDescriptor[] = [
  {
    "id": "geotiff",
    "format": "tiff",
    "owner": "W08",
    "revision": "4e735c490d360b7fa9fc9905be6c1ab7b4f05dbab975823eb84af6b975bf76bd",
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
    "revision": "4ba820a53c5726d533a8f21cfc718c10caed82458a0ec06dc26c7dfc0be1a4c0",
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
    "revision": "7be7973423022c4624c0d7b0c9ed34b84e1265fe6e9f7a83f8d2367d14149009",
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
    "revision": "9ff5ad878c9a9fdd014d37b9dd8539373d65e9be0b44758e8645095ddf0eaa9d",
    "dependencies": []
  },
  {
    "id": "exr-wasm",
    "format": "exr",
    "owner": "W06",
    "revision": "659721ead7b0315651ec5466556281f7ea4cdc9187643ba0a1b484d393d3160e",
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
    "revision": "9ff5ad878c9a9fdd014d37b9dd8539373d65e9be0b44758e8645095ddf0eaa9d",
    "dependencies": []
  },
  {
    "id": "mapbox-glyph-pbf",
    "format": "glyph-pbf",
    "owner": "W13/W19",
    "revision": "9ff5ad878c9a9fdd014d37b9dd8539373d65e9be0b44758e8645095ddf0eaa9d",
    "dependencies": []
  }
];
export const DENOISER_REVISION = '5ee5d22b194e95fc0864b5109fb36a48d9fc802c5297f3b3cf21e478359695ef';
