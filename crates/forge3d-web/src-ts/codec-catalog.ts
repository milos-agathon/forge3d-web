// Generated from complete runtime source/build inputs and W00 codec pins.
import type { CodecDescriptor } from './codec-types.js';
export const CODEC_CATALOG: readonly CodecDescriptor[] = [
  {
    "id": "geotiff",
    "format": "tiff",
    "owner": "W08",
    "revision": "0bb5779cf6933e49492981607c59f4713e4ad62ec5671b66bb823a240ebe3cd9",
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
    "revision": "5a49000b9bb43ea1947eec001a4083d409f868fb3333684a12241f4e1145acf6",
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
    "revision": "39701e9bcd142c4952f3bdbd876e92c9f9229d6fcb16b42e2e672da37b0221df",
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
    "revision": "4e33330e52a65840ae84adc61018e2a4ae000d1e5fe41cd1859e2b4b8871c539",
    "dependencies": []
  },
  {
    "id": "exr-wasm",
    "format": "exr",
    "owner": "W06",
    "revision": "b21e170342bda86284393e83eb23330d83591e5e0668099039f621b0e2fe8ac4",
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
    "revision": "4e33330e52a65840ae84adc61018e2a4ae000d1e5fe41cd1859e2b4b8871c539",
    "dependencies": []
  },
  {
    "id": "mapbox-glyph-pbf",
    "format": "glyph-pbf",
    "owner": "W13/W19",
    "revision": "4e33330e52a65840ae84adc61018e2a4ae000d1e5fe41cd1859e2b4b8871c539",
    "dependencies": []
  }
];
export const DENOISER_REVISION = 'e74b2ff41e66544bf76e6f0faf1460e254c2f16f530345a6fd63cebcd40f1cb8';
