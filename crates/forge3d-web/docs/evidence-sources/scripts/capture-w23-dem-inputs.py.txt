"""Capture bounded windows of available original example DEMs for offline CI.

Authoring command only. Rechecking numerical oracles consumes the committed
windows and never requires the external source archive or network access.
"""
import hashlib,json
from pathlib import Path
import numpy as np
import rasterio
from rasterio.windows import Window
ROOT=Path(__file__).resolve().parents[1]
ARCHIVE=Path('D:/forge3d')
sources={
    'pnoa_river_showcase.py':'assets/tif/Bryce_Canyon.tif',
    'pnoa_river_showcase_video.py':'assets/tif/dem_rainier.tif',
    'bryce_canyon_storm_timelapse.py':'assets/tif/Bryce_Canyon.tif',
    'luxembourg_rail_overlay.py':'assets/tif/luxembourg_dem.tif',
    'swiss_terrain_landcover_viewer.py':'assets/tif/switzerland_dem.tif',
    'belgium_bivariate_climate_map.py':'examples/.cache/belgium_bivariate_climate/belgium_terrarium_dem_z10_3857.tif',
    'california_wildfire_smoke_video.py':'examples/.cache/california_wildfire_smoke/california_osm_r165475_terrarium_z8_max1700.tif',
}
out={}
for index,(name,relative)in enumerate(sources.items()):
    path=ARCHIVE/relative
    with rasterio.open(path)as src:
        # Choose a finite interior patch without changing the data values.
        rows=[src.height//2,src.height//3,src.height*2//3]
        cols=[src.width//2+index*7,src.width//3,src.width*2//3]
        for row in rows:
            for col in cols:
                window=Window(min(col,src.width-16),min(row,src.height-16),16,16)
                data=src.read(1,window=window,masked=True)
                if not np.any(data.mask)and np.all(np.isfinite(data))and float(data.max())>float(data.min()):break
            else:continue
            break
        assert not np.any(data.mask)and np.all(np.isfinite(data)),path
        payload=np.ascontiguousarray(data,dtype='<f4')
        source={'path':relative,'archive':'original Forge3D example data archive','sourceSha256':hashlib.file_digest(path.open('rb'),'sha256').hexdigest(),'window':[int(window.col_off),int(window.row_off),16,16],'bounds':list(rasterio.windows.bounds(window,src.transform)),'crs':src.crs.to_string()if src.crs else None,'convertedSha256':hashlib.sha256(payload.tobytes()).hexdigest(),'conversion':'Read band 1 in the recorded window; cast to little-endian float32; no geographic resampling or synthetic replacement.'}
        out[name]={'width':16,'height':16,'data':payload.ravel().tolist(),'source':source}
target=ROOT/'tests/fixtures/w23/regional-dem-inputs.json'
target.write_text(json.dumps({'generator':'crates/forge3d-web/scripts/capture-w23-dem-inputs.py','examples':out},indent=2)+'\n',encoding='utf8',newline='\n')
print(json.dumps({'capturedOriginalExampleDems':len(out)}))
