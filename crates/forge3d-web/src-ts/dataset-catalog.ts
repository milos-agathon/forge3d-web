// Generated from native datasets.py by scripts/generate-w14-fixtures.py.
import type { DatasetMetadata } from "./dataset-types.js";
export const DATASET_CATALOG: readonly DatasetMetadata[] = [
  {
    "name": "mini_dem",
    "kind": "dem",
    "bundled": true,
    "filename": "mini_dem.npy",
    "relativeUrl": "mini_dem.npy",
    "sha256": "083abe86bfcfd672e87d57cb386b5fb0960be87312f267f8f51375e213eb5534",
    "byteLength": 262272,
    "description": "Native synthetic 256×256 float32 DEM.",
    "format": "npy"
  },
  {
    "name": "sample_boundaries",
    "kind": "vector",
    "bundled": true,
    "filename": "sample_boundaries.geojson",
    "relativeUrl": "sample_boundaries.geojson",
    "sha256": "03b08af4692a3e32a256004a8b191c62df181f4cf41e8138f7766d52b1208b52",
    "byteLength": 1361,
    "description": "Native tutorial boundary polygons in normalized terrain coordinates.",
    "format": "geojson",
    "coordinateSpace": "normalized"
  },
  {
    "name": "fuji",
    "kind": "dem",
    "bundled": false,
    "filename": "Mount_Fuji_30m.tif",
    "relativeUrl": "tif/Mount_Fuji_30m.tif",
    "sha256": "cff39b4e02d7ba13c48f3d8b1a4080d40ada753ade62fa951459fe4e01e98b48",
    "description": "Mount Fuji DEM used in labels and buildings examples.",
    "format": "tif"
  },
  {
    "name": "luxembourg",
    "kind": "dem",
    "bundled": false,
    "filename": "luxembourg_dem.tif",
    "relativeUrl": "tif/luxembourg_dem.tif",
    "sha256": "c332f7abb41a911449596f86277e05ef340cef37620115c1c78a56af35cc83e8",
    "description": "Luxembourg DEM used with the rail overlay gallery example.",
    "format": "tif"
  },
  {
    "name": "luxembourg-rail",
    "kind": "vector",
    "bundled": false,
    "filename": "luxembourg_rail.gpkg",
    "relativeUrl": "gpkg/luxembourg_rail.gpkg",
    "sha256": "980dc1659c712c67a80c9b57acf31eb3b26b14213f69a5c6c7f7ffb84385e1ec",
    "description": "Rail network overlay used in the Luxembourg gallery scene.",
    "format": "gpkg"
  },
  {
    "name": "mount-fuji-buildings",
    "kind": "geojson",
    "bundled": false,
    "filename": "mount_fuji_buildings.geojson",
    "relativeUrl": "geojson/mount_fuji_buildings.geojson",
    "sha256": "19a124e80b12c7cd7181020d70e1b2e2004acc7a8b8a72b3463a701575c07f6e",
    "description": "GeoJSON building footprints used in the Mount Fuji buildings demo.",
    "format": "geojson"
  },
  {
    "name": "mount-fuji-places",
    "kind": "vector",
    "bundled": false,
    "filename": "Mount_Fuji_places.gpkg",
    "relativeUrl": "gpkg/Mount_Fuji_places.gpkg",
    "sha256": "9e46ad2e55ba9b945b3dc5c29ad29e80d881a32d4a90ecf8a2637f864567a530",
    "description": "Sample placenames around Mount Fuji for labels and callouts.",
    "format": "gpkg"
  },
  {
    "name": "mt-st-helens",
    "kind": "copc",
    "bundled": false,
    "filename": "MtStHelens.laz",
    "relativeUrl": "lidar/MtStHelens.laz",
    "sha256": "4474530433fda8c40fbb621ed4dd78b02c9c90cbe4ef33588a73883663d5bd57",
    "description": "LAZ point cloud used in the point cloud tutorial and gallery entry.",
    "format": "laz"
  },
  {
    "name": "rainier",
    "kind": "dem",
    "bundled": false,
    "filename": "dem_rainier.tif",
    "relativeUrl": "tif/dem_rainier.tif",
    "sha256": "875b243474b151175f76037acd60c2149ac2e46fba9ba2bbce0c9a6998015dd3",
    "description": "Mount Rainier DEM used in viewer tutorials and gallery scenes.",
    "format": "tif"
  },
  {
    "name": "sample-buildings",
    "kind": "cityjson",
    "bundled": false,
    "filename": "sample_buildings.city.json",
    "relativeUrl": "geojson/sample_buildings.city.json",
    "sha256": "378a25afdd4932de4038b310216078181fb7eb9b19bb0f658045893371ba91c7",
    "description": "Small CityJSON building set for tutorial and test scenes.",
    "format": "json"
  },
  {
    "name": "swiss",
    "kind": "dem",
    "bundled": false,
    "filename": "switzerland_dem.tif",
    "relativeUrl": "tif/switzerland_dem.tif",
    "sha256": "d09d229fa265749720a6b4bd40c440799f43286bf2d401d732ea77f89d0bd478",
    "description": "Swiss Alps DEM used in overlay and legend examples.",
    "format": "tif"
  },
  {
    "name": "swiss-land-cover",
    "kind": "overlay",
    "bundled": false,
    "filename": "switzerland_land_cover.tif",
    "relativeUrl": "tif/switzerland_land_cover.tif",
    "sha256": "6b254585be4982ed9e8da63b8536ecc2f5fa4c64c6545db06c73eb1fe39a8f7f",
    "description": "Swiss land-cover raster used as a draped terrain overlay.",
    "format": "tif"
  }
];
