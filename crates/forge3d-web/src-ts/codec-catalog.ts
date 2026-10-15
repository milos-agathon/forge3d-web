// Generated from feature implementations and the W00 dependency lock.
import type { CodecDescriptor } from './codec-types.js';
export const CODEC_CATALOG: readonly CodecDescriptor[] = [
  {
    "id": "geotiff",
    "format": "tiff",
    "owner": "W08",
    "revision": "763770d948e0e8ab91fc83abf9d6819c135eab7d51de3709bfa3f892d490f6d3",
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
    "revision": "4b86f8cd1587c8d3c4081efc59a792b42984bd2465018179bd5246e45edc6f8f",
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
    "revision": "ca4d9243d723fa7d27dad9a370a149ab346b7965892eaa3b213adefa92018dfc",
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
    "revision": "fcaf80ed4428b4cf2bb38742c9bbacc8ef639400278f60d1dad99a39c82cb25b",
    "dependencies": []
  },
  {
    "id": "exr-wasm",
    "format": "exr",
    "owner": "W06",
    "revision": "cb01893c71580babc88435b885a2aa985a2aff2e04379f1994f66ae56dbcb897",
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
    "revision": "21ed8c656b714bdccbaac558bd94cac38362999b6767a241a731431d5aa9d295",
    "dependencies": []
  },
  {
    "id": "mapbox-glyph-pbf",
    "format": "glyph-pbf",
    "owner": "W13/W19",
    "revision": "baaba73a617867ca78d2118000f7cea6ea3b3bc8f08f6a5778fc38452e855d4c",
    "dependencies": []
  }
];
export const DENOISER_REVISION = '913447170854f5f456a730723b878c7951340d286851ab45759d49ba7bef91b9';
