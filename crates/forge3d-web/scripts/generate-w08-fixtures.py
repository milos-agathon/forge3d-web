#!/usr/bin/env python3
"""Generate the deterministic W08 golden fixtures for crates/forge3d-web.

Outputs land in ``crates/forge3d-web/tests/golden/w08/``:

* ``predictor-deflate-u16.tif`` -- native predictor/DEFLATE fixture
  (16x16 uint16, values ``(arange * 3) + 7``, tiled 16x16, DEFLATE,
  predictor 2, transform ``from_origin(0, 16, 1, 1)``).
* ``rainier-cog.tif`` -- DEM COG built with the GDAL COG driver from a
  1024x1024 center crop of ``D:/forge3d/assets/tif/dem_rainier.tif``
  (BLOCKSIZE 256, DEFLATE, predictor 3, power-of-two overviews down to a
  single tile, nodata, source CRS).
* ``landcover-rgba-cog.tif`` -- 512x512 RGBA COG colorized through a fixed
  palette from a crop of
  ``D:/forge3d/assets/tif/switzerland_land_cover.tif`` (DEFLATE, overviews).
* ``<name>.json`` -- rasterio truth per fixture (IFD/overview dims, block
  sizes, bounds, CRS, nodata, geotransform, dtype, compression, exact
  sample values at fixed pixels per level, SHA-256 of the decoded
  float32 tile (0,0) at every level).
* ``w08-fixtures.json`` -- manifest (generator version, source paths and
  digests, output digests, clipmap-seam-v1 parameters).

Run ``python scripts/generate-w08-fixtures.py`` twice; output digests must
be identical.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.windows import Window

GENERATOR_VERSION = "w08-fixture-generator-v1"

SCRIPT_DIR = Path(__file__).resolve().parent
CRATE_ROOT = SCRIPT_DIR.parent
OUT_DIR = CRATE_ROOT / "tests" / "golden" / "w08"

RAINIER_SOURCE = Path("D:/forge3d/assets/tif/dem_rainier.tif")
LANDCOVER_SOURCE = Path("D:/forge3d/assets/tif/switzerland_land_cover.tif")

RAINIER_CROP_SIZE = 1024
RAINIER_FALLBACK_CROP_SIZE = 768
RAINIER_MAX_BYTES = 2 * 1024 * 1024

LANDCOVER_WINDOW = Window(11000, 5500, 512, 512)

# clipmap-seam-v1 parameters, mirrored from
# tests/parity/fixture-contracts.json so the manifest stays consistent with
# the parity contract without depending on its load path.
CLIPMAP_SEAM_V1_PARAMETERS = {
    "virtualWidth": 16385,
    "virtualHeight": 16385,
    "ringCount": 8,
    "tileSize": 256,
    "overlayCount": 3,
}
CLIPMAP_SEAM_V1_SHA256 = (
    "6ae5736c535f6f8a3a01777c0a3b23f6f47db0c5aa58308eb1ad0fd11efec4f8"
)

# Fixed 16-color palette used to colorize the landcover crop. The palette is
# part of the fixture contract; changing it changes the golden digests.
LANDCOVER_PALETTE = np.array(
    [
        (32, 32, 32),
        (64, 45, 29),
        (97, 71, 42),
        (128, 96, 60),
        (41, 84, 32),
        (63, 124, 46),
        (99, 163, 62),
        (142, 196, 90),
        (184, 150, 84),
        (215, 197, 133),
        (105, 122, 139),
        (140, 165, 184),
        (54, 96, 133),
        (88, 141, 190),
        (170, 170, 170),
        (235, 235, 235),
    ],
    dtype=np.float64,
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_predictor_fixture(path: Path) -> None:
    values = (np.arange(16 * 16, dtype=np.uint16) * 3 + 7).reshape(16, 16)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=16,
        height=16,
        count=1,
        dtype="uint16",
        tiled=True,
        blockxsize=16,
        blockysize=16,
        compress="DEFLATE",
        predictor=2,
        transform=from_origin(0, 16, 1, 1),
    ) as dataset:
        dataset.write(values, 1)


def write_rainier_cog(path: Path) -> dict:
    with rasterio.open(RAINIER_SOURCE) as source:
        for size in (RAINIER_CROP_SIZE, RAINIER_FALLBACK_CROP_SIZE):
            col = source.width // 2 - size // 2
            row = source.height // 2 - size // 2
            window = Window(col, row, size, size)
            tile = source.read(1, window=window)
            nodata_mask = np.isnan(tile) | (tile <= -3.0e38)
            clean = np.where(nodata_mask, np.nan, tile)
            if float(np.isnan(clean).mean()) > 0.25:
                continue
            transform = source.window_transform(window)
            with rasterio.open(
                path,
                "w",
                driver="COG",
                width=size,
                height=size,
                count=1,
                dtype="float32",
                crs=source.crs,
                transform=transform,
                nodata=-9999.0,
                BLOCKSIZE=256,
                COMPRESS="DEFLATE",
                PREDICTOR=3,
            ) as dataset:
                dataset.write(tile.astype(np.float32), 1)
            if path.stat().st_size <= RAINIER_MAX_BYTES:
                return {
                    "window": {"col": col, "row": row, "size": size},
                    "transform": list(transform)[:6],
                }
            path.unlink()
    raise RuntimeError("rainier-cog.tif could not be produced under 2 MiB")


def write_landcover_cog(path: Path) -> dict:
    with rasterio.open(LANDCOVER_SOURCE) as source:
        rgb = source.read(window=LANDCOVER_WINDOW).astype(np.float64)
        valid = ~np.isnan(rgb).all(axis=0)
        quantized = np.clip(np.nan_to_num(rgb, nan=0.0), 0.0, 255.0)
        # Nearest fixed-palette color per pixel (RGB Euclidean distance).
        diff = quantized.transpose(1, 2, 0)[:, :, None, :] - LANDCOVER_PALETTE[None, None, :, :]
        nearest = np.argmin((diff * diff).sum(axis=3), axis=2)
        rgba = np.zeros((4, quantized.shape[1], quantized.shape[2]), dtype=np.uint8)
        palette_u8 = LANDCOVER_PALETTE.astype(np.uint8)
        for band in range(3):
            rgba[band] = palette_u8[nearest, band]
        rgba[3] = np.where(valid, 255, 0).astype(np.uint8)
        transform = source.window_transform(LANDCOVER_WINDOW)
        with rasterio.open(
            path,
            "w",
            driver="COG",
            width=rgba.shape[2],
            height=rgba.shape[1],
            count=4,
            dtype="uint8",
            crs=source.crs,
            transform=transform,
            BLOCKSIZE=256,
            COMPRESS="DEFLATE",
            PREDICTOR=2,
            OVERVIEW_RESAMPLING="NEAREST",
        ) as dataset:
            dataset.write(rgba)
            dataset.colorinterp = [
                rasterio.enums.ColorInterp.red,
                rasterio.enums.ColorInterp.green,
                rasterio.enums.ColorInterp.blue,
                rasterio.enums.ColorInterp.alpha,
            ]
    return {
        "window": {
            "col": int(LANDCOVER_WINDOW.col_off),
            "row": int(LANDCOVER_WINDOW.row_off),
            "width": int(LANDCOVER_WINDOW.width),
            "height": int(LANDCOVER_WINDOW.height),
        },
        "transform": list(transform)[:6],
        "palette": LANDCOVER_PALETTE.astype(int).tolist(),
    }


def read_level(dataset: rasterio.DatasetReader, band: int, factor: int) -> np.ndarray:
    """Read one overview level exactly (nearest = stored overview bytes)."""
    if factor == 1:
        return dataset.read(band)
    height = int(np.ceil(dataset.height / factor))
    width = int(np.ceil(dataset.width / factor))
    return dataset.read(
        band,
        out=np.empty((height, width), dtype=dataset.dtypes[0]),
        resampling=rasterio.enums.Resampling.nearest,
    )


def truth_for(path: Path) -> dict:
    with rasterio.open(path) as dataset:
        factors = [1, *dataset.overviews(1)]
        levels = []
        tile_sha256 = []
        sample_rows = []
        for factor in factors:
            block_h, block_w = dataset.block_shapes[0]
            level_height = int(np.ceil(dataset.height / factor))
            level_width = int(np.ceil(dataset.width / factor))
            first_band = read_level(dataset, 1, factor).astype("<f4")
            tile = np.zeros((block_h, block_w), dtype="<f4")
            clip_h = min(block_h, level_height)
            clip_w = min(block_w, level_width)
            tile[:clip_h, :clip_w] = first_band[:clip_h, :clip_w]
            tile_sha256.append(hashlib.sha256(tile.tobytes()).hexdigest())
            pixels = {
                "0,0": float(first_band[0, 0]),
                "center": float(first_band[level_height // 2, level_width // 2]),
                "last": float(first_band[level_height - 1, level_width - 1]),
            }
            sample_rows.append(pixels)
            levels.append(
                {
                    "level": len(levels),
                    "factor": factor,
                    "width": level_width,
                    "height": level_height,
                    "tileWidth": block_w,
                    "tileHeight": block_h,
                    "tilesAcross": int(np.ceil(level_width / block_w)),
                    "tilesDown": int(np.ceil(level_height / block_h)),
                    "tileCount": int(
                        np.ceil(level_width / block_w)
                        * np.ceil(level_height / block_h)
                    ),
                    "bitsPerSample": dataset.dtypes[0],
                    "compression": (
                        dataset.compression.name if dataset.compression else None
                    ),
                }
            )
        try:
            epsg = dataset.crs.to_epsg() if dataset.crs else None
        except Exception:  # pragma: no cover - defensive
            epsg = None
        return {
            "file": path.name,
            "sizeBytes": path.stat().st_size,
            "sha256": sha256_file(path),
            "width": dataset.width,
            "height": dataset.height,
            "count": dataset.count,
            "dtype": dataset.dtypes,
            "nodata": dataset.nodata,
            "crs": dataset.crs.to_string() if dataset.crs else None,
            "epsg": epsg,
            "bounds": list(dataset.bounds),
            "transform": list(dataset.transform)[:6],
            "blockShapes": [list(shape) for shape in dataset.block_shapes],
            "colorInterp": [c.name for c in dataset.colorinterp],
            "overviewFactors": dataset.overviews(1),
            "levels": levels,
            "samples": sample_rows,
            "tileSha256": tile_sha256,
        }


def main() -> int:
    for required in (RAINIER_SOURCE, LANDCOVER_SOURCE):
        if not required.exists():
            raise FileNotFoundError(f"missing fixture source: {required}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    outputs = {}
    provenance = {}

    predictor_path = OUT_DIR / "predictor-deflate-u16.tif"
    write_predictor_fixture(predictor_path)
    outputs["predictor-deflate-u16.tif"] = predictor_path

    rainier_path = OUT_DIR / "rainier-cog.tif"
    provenance["rainier-cog.tif"] = {
        "source": str(RAINIER_SOURCE),
        "sourceSha256": sha256_file(RAINIER_SOURCE),
        **write_rainier_cog(rainier_path),
    }
    outputs["rainier-cog.tif"] = rainier_path

    landcover_path = OUT_DIR / "landcover-rgba-cog.tif"
    provenance["landcover-rgba-cog.tif"] = {
        "source": str(LANDCOVER_SOURCE),
        "sourceSha256": sha256_file(LANDCOVER_SOURCE),
        **write_landcover_cog(landcover_path),
    }
    outputs["landcover-rgba-cog.tif"] = landcover_path

    truth_paths = []
    for name, tif_path in outputs.items():
        truth = truth_for(tif_path)
        truth_path = tif_path.with_suffix(".json")
        truth_path.write_text(json.dumps(truth, indent=2) + "\n", encoding="utf-8")
        truth_paths.append(truth_path)

    manifest = {
        "generator": GENERATOR_VERSION,
        "rasterio": rasterio.__version__,
        "gdal": rasterio.__gdal_version__,
        "sources": {
            name: {
                "source": info["source"],
                "sourceSha256": info["sourceSha256"],
            }
            for name, info in provenance.items()
        },
        "outputs": {
            name: {
                "sizeBytes": path.stat().st_size,
                "sha256": sha256_file(path),
            }
            for name, path in outputs.items()
        },
        "provenance": provenance,
        "clipmapSeamV1": {
            "parameters": CLIPMAP_SEAM_V1_PARAMETERS,
            "sha256": CLIPMAP_SEAM_V1_SHA256,
        },
    }
    manifest_path = OUT_DIR / "w08-fixtures.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    for name, path in outputs.items():
        print(f"{name}: {path.stat().st_size} bytes sha256={sha256_file(path)}")
    for path in truth_paths:
        print(f"{path.name}: {path.stat().st_size} bytes")
    print(f"{manifest_path.name}: written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
