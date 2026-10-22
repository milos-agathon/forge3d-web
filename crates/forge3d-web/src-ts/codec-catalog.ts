// Generated from complete runtime source/build inputs and W00 codec pins.
import type { CodecDescriptor } from './codec-types.js';
export const CODEC_CATALOG: readonly CodecDescriptor[] = [
  {
    "id": "geotiff",
    "format": "tiff",
    "owner": "W08",
    "revision": "5cd4bc871d7c5f779a0027a67b1b5671de135763028cc5014d0dcfdde69fe080",
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
    "revision": "9d108f57d6dc51112d5265a97c62f0abb1541b617fd46dfd08bc0b8217b2ce03",
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
    "revision": "ac02c6406f7952e15ae6c53c2ec209b4b4b803cef43f1c676980ab3a07abde4f",
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
    "revision": "b1ceb8b3dc6ebdd3e596ff5d89ea0589641ba2505d8b0166f1e3117eef1d2edf",
    "dependencies": []
  },
  {
    "id": "exr-wasm",
    "format": "exr",
    "owner": "W06",
    "revision": "cd5262212bea327b7eafa73542b229d81146c78ba784b47ea3f33bf3f195b4a3",
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
    "revision": "b1ceb8b3dc6ebdd3e596ff5d89ea0589641ba2505d8b0166f1e3117eef1d2edf",
    "dependencies": []
  },
  {
    "id": "mapbox-glyph-pbf",
    "format": "glyph-pbf",
    "owner": "W13/W19",
    "revision": "b1ceb8b3dc6ebdd3e596ff5d89ea0589641ba2505d8b0166f1e3117eef1d2edf",
    "dependencies": []
  }
];
export const DENOISER_REVISION = '495e0c916f12122b9798abc64ffc4a341d6c9c70c1afd9326621616ba59ca687';
