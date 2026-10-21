// Generated from complete runtime source/build inputs and W00 codec pins.
import type { CodecDescriptor } from './codec-types.js';
export const CODEC_CATALOG: readonly CodecDescriptor[] = [
  {
    "id": "geotiff",
    "format": "tiff",
    "owner": "W08",
    "revision": "116b18febcfc481bb4a1d5af6980dbbb548732a1f2dd2b26a669c73be87e0496",
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
    "revision": "70f59277c60f204d5e813215a2d6bce8b112d3585434b1b7dab642aa2a1da065",
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
    "revision": "7c56d3e35518d8fcd3279e71369ee3b398d839995a426a4d4b35548398bbb1a7",
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
    "revision": "bebf00edfd333f6de2246826db8b0e97568a27ea59946a32b056cd567fd205d4",
    "dependencies": []
  },
  {
    "id": "exr-wasm",
    "format": "exr",
    "owner": "W06",
    "revision": "5ae9b3f0f7ff1e1937e9ca39ab3513cd0f06ed4c093dcaaf1fbc993364bd5688",
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
    "revision": "bebf00edfd333f6de2246826db8b0e97568a27ea59946a32b056cd567fd205d4",
    "dependencies": []
  },
  {
    "id": "mapbox-glyph-pbf",
    "format": "glyph-pbf",
    "owner": "W13/W19",
    "revision": "bebf00edfd333f6de2246826db8b0e97568a27ea59946a32b056cd567fd205d4",
    "dependencies": []
  }
];
export const DENOISER_REVISION = '2bac37019488ae38fb7538054bff813b710cd20b0912cd32a9c3db9a7e8da41c';
