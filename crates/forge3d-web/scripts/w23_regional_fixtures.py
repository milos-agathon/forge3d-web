"""Execute original regional helpers on separate, bounded inputs.

No browser implementation is imported. File I/O adapters are confined to
temporary raster/image files. Numerical function bodies are unchanged ASTs.
"""
from __future__ import annotations
import ast
from dataclasses import dataclass
import hashlib
import heapq
import math
from pathlib import Path
import random
import re
import subprocess
import tempfile
from types import SimpleNamespace
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin

ROOT=Path(__file__).resolve().parents[1]
REPO=ROOT.parents[1]
REF='1f4084af428dc699bdcd108b029736cb73903926'
SOURCES={}

def native(filename, requested, bindings=None):
    raw=subprocess.check_output(['git','show',f'{REF}:examples/{filename}'],cwd=REPO)
    tree=ast.parse(raw.decode('utf8'))
    definitions={}
    for node in tree.body:
        if isinstance(node,(ast.FunctionDef,ast.ClassDef)):
            definitions[node.name]=node
        elif isinstance(node,(ast.Assign,ast.AnnAssign)):
            targets=node.targets if isinstance(node,ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target,ast.Name):definitions[target.id]=node
    selected=set(requested)
    pending=list(requested)
    while pending:
        name=pending.pop()
        for reference in ast.walk(definitions[name]):
            if isinstance(reference,ast.Name) and isinstance(reference.ctx,ast.Load) and reference.id in definitions and reference.id not in selected and reference.id not in (bindings or {}):
                selected.add(reference.id);pending.append(reference.id)
    nodes=sorted({definitions[name] for name in selected},key=lambda n:n.lineno)
    space={'__name__':__name__,'__file__':str(ROOT/'examples'/filename),'np':np,'math':math,'heapq':heapq,'dataclass':dataclass,'Path':Path,'random':random,'re':re,'Image':Image,'ImageDraw':ImageDraw,'ImageFilter':ImageFilter,'rasterio':rasterio,'Resampling':Resampling,'from_origin':from_origin,**(bindings or {})}
    exec(compile('from __future__ import annotations\n'+'\n'.join(ast.unparse(n) for n in nodes),filename,'exec'),space)
    previous=SOURCES.get(filename,{}).get('helpers',[])
    SOURCES[filename]={'ref':REF,'path':'examples/'+filename,'sha256':hashlib.sha256(raw).hexdigest(),'helpers':sorted(set(previous+requested))}
    return space

def flat(values):return np.asarray(values).reshape(-1).tolist()

def operation(kernel, filename, functions, inputs, expected, tolerance=1e-5):
    return {'kernel':kernel,'native':{**SOURCES[filename],'helpers':functions},'input':inputs,'expected':expected,'tolerance':tolerance}

def raster(path,data):
    data=np.asarray(data)
    with rasterio.open(path,'w',driver='GTiff',width=data.shape[1],height=data.shape[0],count=1,dtype=str(data.dtype),transform=from_origin(0,data.shape[0],1,1),nodata=0) as dst:dst.write(data,1)

def input_dem(filename,index):
    captured=__import__('json').loads((ROOT/'tests/fixtures/w23/regional-dem-inputs.json').read_text(encoding='utf8'))['examples']
    if filename in captured:
        control=captured[filename];data=np.asarray(control['data'],dtype='<f4').reshape(control['height'],control['width'])
        assert hashlib.sha256(data.tobytes()).hexdigest()==control['source']['convertedSha256'],filename+' captured DEM window digest'
        assert np.all(np.isfinite(data)) and len(control['source']['sourceSha256'])==64,filename
        return control,data
    # Separate recorded windows of the actual native mini_dem data, never the
    # Colorado interpolation fixture's ramp. The source is explicitly a bounded
    # control rather than a claim to restore a publication's downloaded dataset.
    data=np.load(ROOT/'assets/datasets/mini_dem.npy')
    size=16; row=(index*29)%(data.shape[0]-size);col=(index*43)%(data.shape[1]-size)
    crop=np.ascontiguousarray(data[row:row+size,col:col+size],dtype=np.float32)
    return {'width':size,'height':size,'data':flat(crop),'source':{'ref':REF,'path':'python/forge3d/data/mini_dem.npy','sha256':hashlib.sha256((ROOT/'assets/datasets/mini_dem.npy').read_bytes()).hexdigest(),'window':[col,row,size,size],'use':'bounded numerical/rendering control; not the regional publication DEM'}},crop

def build_cases(legacy):
    (ROOT/'test-results').mkdir(parents=True,exist_ok=True)
    catalog=__import__('json').loads((ROOT/'examples/migration/catalog.json').read_text(encoding='utf8'))
    cases={}
    for index,entry in enumerate(e for e in catalog if 'application' in e['workflows']):
        filename=entry['name']; terrain,dem=input_dem(filename,index);ops=[];render={};kind=''
        def add(kernel,functions,inputs,expected,tolerance=1e-5,source=filename):
            ops.append(operation(kernel,source,functions,inputs,expected,tolerance))
        if filename=='colorado_rem_forge3d.py':
            kind='rem';n=native(filename,['_apply_idw_from_neighbors']);river=np.array([[0,5],[5,5],[10,8],[15,8]],dtype=np.float32);v={'coordinates':[[x,y]for y in range(16)for x in range(16)],'river':river.tolist(),'riverHeights':[float(dem[int(y),int(x)])for x,y in river],'dem':flat(dem)};d=np.asarray(v['coordinates'])[:,None,:]-river[None,:,:]
            water=n['_apply_idw_from_neighbors'](np.linalg.norm(d,axis=2).astype(np.float32),np.tile(np.arange(4),(256,1)),np.asarray(v['riverHeights'],dtype=np.float32),power=2)
            add('colorado-idw',['_apply_idw_from_neighbors'],v,{'waterSurface':flat(water),'relativeElevation':flat(dem.ravel()-water)},1e-4)
            render={'scalar':'relativeElevation'}
        elif filename=='platte_rem_forge3d.py':
            kind='platte-rem';n=native(filename,['_idw_surface']);river=np.array([[0,5],[5,5],[10,8],[15,8]],dtype=np.float32);v={'coordinates':[[x,y]for y in range(16)for x in range(16)],'river':river.tolist(),'riverHeights':[float(dem[int(y),int(x)])for x,y in river],'dem':flat(dem)};coordinates=np.asarray(v['coordinates'],dtype=np.float32)
            water=n['_idw_surface'](river,np.asarray(v['riverHeights']),coordinates[:,0].reshape(16,16),coordinates[:,1].reshape(16,16),power=2)
            add('platte-idw',['_idw_surface'],v,{'waterSurface':flat(water),'relativeElevation':flat(dem.ravel()-water.ravel())},1e-4)
            render={'scalar':'relativeElevation'}
        elif filename=='belgium_bivariate_climate_map.py':
            kind='bivariate';n=native(filename,['_quantile_breaks','_classify','_bivariate_palette_color']);v=legacy['bivariate']
            add('climate-classification',['_quantile_breaks','_classify','_bivariate_palette_color'],v,{k:v[k] for k in ['temperatureBreaks','precipitationBreaks','temperatureClasses','precipitationClasses']})
            render={'palette':v['palette']}
        elif filename=='barcelona_travel_time_3d.py':
            kind='travel';n=native(filename,['parse_maxspeed','dijkstra_seconds','select_timed_segments','project_to_pixels']);v={**legacy['travel']};points=[[2,2],[4,12],[9,9],[13,4],[15,14]];edges=[(0,1),(0,2),(1,2),(2,3),(3,4)];segments=[n['RoadSegment'](u=a,v=b,x0=points[a][0],y0=points[a][1],x1=points[b][0],y1=points[b][1],seconds=30,highway='residential')for a,b in edges];selected=n['select_timed_segments'](segments,component=set(range(5)),node_times_s={int(k):value for k,value in v['seconds'].items()},cutoff_min=1.4);v['segments']=[vars(s)for s in segments];v['cutoffMin']=1.4
            add('road-routing',['parse_maxspeed','dijkstra_seconds','select_timed_segments','project_to_pixels'],v,{'seconds':v['seconds'],'speeds':v['parsedSpeeds'],'segments':[vars(s)for s in selected],'pixels':[[*n['project_to_pixels'](s.x0,s.y0,extent=n['SquareExtent'](0,0,16,16),size=16),*n['project_to_pixels'](s.x1,s.y1,extent=n['SquareExtent'](0,0,16,16),size=16),s.tmin]for s in selected]})
        elif filename=='rotterdam_solar_potential_shadow_study.py':
            kind='solar';n=native(filename,['roof_normal_for_solar','orientation_factor'],{'city':SimpleNamespace(normalize=lambda v:v/max(np.linalg.norm(v),1e-12))});v=legacy['solar']
            add('solar-roofs',['roof_normal_for_solar','orientation_factor'],v,{'normals':v['normals'],'factors':v['factors']})
            render={'scalar':'factors'}
        elif filename=='khumbu_icefall_sentinel_timelapse.py':
            kind='satellite';n=native(filename,['build_frame_plan','normalize_rgb_to_rgba']);v=legacy['satellite']
            add('satellite-plan',['build_frame_plan'],v,{'plan':v['plan']})
            images=[];raw=[]
            for scene in range(3):
                rgb=np.stack([dem+scene*8,dem*.8+scene*4,dem*1.2+scene*3],axis=2)
                stretch=SimpleNamespace(low=[0,0,0],high=[500,500,500]);raw.append(flat(rgb));images.append(flat(n['normalize_rgb_to_rgba'](rgb,stretch)))
            add('satellite-rgb',['normalize_rgb_to_rgba'],{'width':16,'height':16,'images':raw,'low':[0,0,0],'high':[500,500,500]},{'images':images},1)
        elif filename=='pnoa_river_showcase.py':
            kind='waterways';n=native(filename,['smooth_heightmap','waterway_priority','build_waterway_masks'])
            features=[{'waterway':'river','length':11,'x':[2,13],'y':[8,8]},{'waterway':'stream','length':10,'x':[5,5],'y':[2,12]}]
            halo,core=n['build_waterway_masks'](features,(16,16));smoothed=n['smooth_heightmap'](dem,passes=1)
            add('waterway-masks',['smooth_heightmap','waterway_priority','build_waterway_masks'],{'width':16,'height':16,'dem':flat(dem),'features':features,'styles':n['WATERWAY_STYLES']},{'terrain':flat(smoothed),'halo':flat(halo),'core':flat(core),'priorities':[n['waterway_priority'](f) for f in features]},.008)
            render={'scalar':'core','terrain':'terrain'}
        elif filename=='pnoa_river_showcase_video.py':
            kind='pnoa-video';base=native('pnoa_river_showcase.py',['smooth_heightmap']);n=native(filename,['crop_hero_heightmap','sun_state'],{'smooth_heightmap':base['smooth_heightmap']})
            crop=n['crop_hero_heightmap'](dem,crop_size=16);sun=[n['sun_state'](t,duration=2) for t in [0,1,2]]
            add('pnoa-crop-sun',['crop_hero_heightmap','sun_state'],{'width':16,'height':16,'dem':flat(dem),'times':[0,1,2],'duration':2},{'terrain':flat(crop),'sunFrames':sun})
            render={'terrain':'terrain'}
        elif filename=='poland_population_spikes_height_shade.py':
            kind='population';n=native(filename,['build_height_dem']);values=np.array([0,8,30,100,14,60,250,40,80,180,500,12,900,50,20,400],dtype=np.float32).reshape(4,4);valid=values!=0
            result=n['build_height_dem'](values,900,valid)
            add('population-height',['build_height_dem'],{'values':flat(values),'valid':flat(valid),'clipMax':900,'heightFloor':n['HEIGHT_FLOOR'],'heightGamma':n['HEIGHT_GAMMA']},{'population':flat(values),'heights':flat(result)})
            terrain={'width':4,'height':4,'data':flat(result),'source':{'kind':'bounded population raster','units':'people/km2','native':'build_height_dem'}};render={'scalar':'population'}
        elif filename=='luxembourg_rail_overlay.py':
            kind='rail';n=native(filename,['_terrain_world_dimensions','_project_coord_to_terrain_world']);points=[[2,2],[6,5],[10,7],[14,12]];bounds=[0,0,16,16]
            world=[n['_project_coord_to_terrain_world'](x,y,min_x=0,max_x=16,min_y=0,max_y=16,terrain_width=16,terrain_depth=16) for x,y in points]
            add('rail-projection',['_terrain_world_dimensions','_project_coord_to_terrain_world'],{'points':points,'bounds':bounds,'width':16,'height':16},{'world':world,'dimensions':n['_terrain_world_dimensions'](16,16)})
        elif filename=='turkiye_river_basins_3d.py':
            kind='turkiye-basins';n=native(filename,['_snapshot_dimensions','_river_width_px','_combine_render_passes','_brighten_subject'])
            colors=np.array([[[40,80,130,255],[120,130,160,255]],[[255,255,255,255],[100,80,60,255]]],dtype=np.uint8);relief=np.array([[[a,a,a,255]for a in [30,100]],[[a,a,a,255]for a in [180,240]]],dtype=np.uint8)
            with tempfile.TemporaryDirectory(dir=ROOT/'test-results') as temp:
                c=Path(temp)/'colors.png';r=Path(temp)/'relief.png';Image.fromarray(colors).save(c);Image.fromarray(relief).save(r);combined=n['_combine_render_passes'](c,r);bright=n['_brighten_subject'](combined)
            add('basin-composite',['_snapshot_dimensions','_river_width_px','_combine_render_passes','_brighten_subject'],{'colors':flat(colors),'relief':flat(relief),'orders':[1,3,5,9],'canvasWidth':320,'aspect':n['REFERENCE_ASPECT']},{'rgba':flat(np.asarray(bright)),'widths':[n['_river_width_px'](v,320)for v in [1,3,5,9]],'dimensions':n['_snapshot_dimensions'](320)})
        elif filename=='poland_river_basins_forge3d.py':
            kind='poland-basins';n=native(filename,['_river_width','_decode_terrarium','_palette_for']);rgb=np.array([[[128,0,0],[128,5,128]],[[129,0,0],[127,255,0]]],dtype=np.uint8)
            # _decode_terrarium accepts a path; its I/O boundary is exercised.
            with tempfile.TemporaryDirectory(dir=ROOT/'test-results') as temp:
                path=Path(temp)/'tile.png';Image.fromarray(rgb).save(path);decoded=n['_decode_terrarium'](path)
            ids=[42,7,19,80];palette=n['_palette_for'](ids)
            add('basin-terrarium',['_river_width','_decode_terrarium','_palette_for'],{'rgb':flat(rgb),'ids':ids,'orders':[3,4,5,6,7],'paletteOrder':list(n['_palette_for'](list(range(len(n['PALETTE'])))).values())},{'decoded':flat(decoded),'widths':[n['_river_width'](v)for v in [3,4,5,6,7]],'palette':palette})
            # The native decode supplies the displayed elevation, rather than
            # becoming a disconnected assertion beside an unrelated DEM.
            terrain={'width':2,'height':2,'data':flat(decoded),'source':{'kind':'bounded Terrarium tile','rgb':flat(rgb),'native':'_decode_terrarium'}}
            render={'terrain':'decoded'}
        elif filename=='helsinki_transit_daycycle.py':
            kind='transit';n=native(filename,['parse_gtfs_time_seconds','cumulative_distances','trip_position_at_seconds','frame_seconds_for_index']);points=np.array([[-8,-6],[-4,3],[3,5],[8,-2]],dtype=np.float32);cumulative=n['cumulative_distances'](points)
            trip=SimpleNamespace(points_xy=points,cumulative_m=cumulative,start_seconds=8*3600,end_seconds=9*3600);times=[8*3600,8.5*3600,9*3600];clock=['25:10:30','08:61:00',None,'08:30:00']
            add('gtfs-transit',['parse_gtfs_time_seconds','cumulative_distances','trip_position_at_seconds','frame_seconds_for_index'],{'points':points.tolist(),'start':trip.start_seconds,'end':trip.end_seconds,'times':times,'clock':clock},{'cumulative':flat(cumulative),'positions':[flat(n['trip_position_at_seconds'](trip,t))for t in times],'clock':[n['parse_gtfs_time_seconds'](v)for v in clock],'frameSeconds':[n['frame_seconds_for_index'](i,3,8,9)for i in range(3)]})
        elif filename in ['osm_city_demo.py','osm_city_daycycle.py','osm_city_flood_daycycle.py']:
            city=native('osm_city_demo.py',['infer_building_height','building_bin','normalize']);kind={'osm_city_demo.py':'city','osm_city_daycycle.py':'daycycle','osm_city_flood_daycycle.py':'flood'}[filename];tags=[{'height':'60 ft'},{'building:levels':'7'},{'height':'120'},{}]
            add('city-buildings',['infer_building_height','building_bin'],{'tags':tags},{'heights':[city['infer_building_height'](t)for t in tags],'bins':[city['building_bin'](city['infer_building_height'](t))for t in tags]},source='osm_city_demo.py')
            if kind=='city':native(filename,['infer_building_height'])
            elif kind=='daycycle':
                n=native(filename,['sun_state_for_frame'],{'city':SimpleNamespace(normalize=city['normalize'])});states=[n['sun_state_for_frame'](i,3)for i in range(3)]
                add('city-sun',['sun_state_for_frame'],{'frames':3},{'sunFrames':[[s.azimuth_deg,s.elevation_deg]for s in states],'directions':[flat(s.light_dir)for s in states],'shadowStrength':[s.shadow_strength for s in states]})
            else:
                n=native(filename,['priority_flood_activation','flood_progress_for_frame','water_level_for_progress']);grid=np.arange(64,dtype=np.int32).reshape(8,8);threshold=np.array([.5+(i%8)*.2+(i//8)*.05 for i in range(64)],dtype=np.float32);friction=np.linspace(.01,.15,64,dtype=np.float32);channels=np.arange(0,64,8,dtype=np.int32)
                activation=n['priority_flood_activation'](index_grid=grid,channel_indices=channels,threshold_m=threshold,friction_per_m=friction,cell_size_m=2)
                progress=[n['flood_progress_for_frame'](i,3)for i in range(3)];model=SimpleNamespace(start_level_m=0,end_level_m=3)
                add('priority-flood',['priority_flood_activation','flood_progress_for_frame','water_level_for_progress'],{'width':8,'height':8,'indices':flat(grid),'channels':flat(channels),'threshold':flat(threshold),'friction':flat(friction),'cellSize':2,'startLevel':0,'endLevel':3},{'activation':flat(activation),'progress':progress,'waterLevels':[n['water_level_for_progress'](model,p)for p in progress]},1e-5)
                render={'scalar':'activation'}
        elif filename=='bryce_canyon_storm_timelapse.py':
            kind='storm';n=native(filename,['_rain_envelope','_storm_darkness','_sun_visibility','_sun_state']);progress=[0,.25,.5,.75,1]
            add('storm-envelope',['_rain_envelope','_storm_darkness','_sun_visibility','_sun_state'],{'progress':progress},{'rain':[n['_rain_envelope'](p)for p in progress],'darkness':[n['_storm_darkness'](p)for p in progress],'sunVisibility':[n['_sun_visibility'](p)for p in progress],'sunFrames':[[n['_sun_state'](p).azimuth_deg,n['_sun_state'](p).elevation_deg]for p in progress]},1e-5)
        elif filename=='california_fire_smoke_effect.py':
            kind='smoke';n=native(filename,['advect_density','inject_hotspots']);density=np.zeros((16,16),dtype=np.float32);u=np.full_like(density,.4);v=np.full_like(density,-.2);bounds=n['Bounds'](lon_min=-125,lon_max=-115,lat_min=32,lat_max=42);hotspots=[n['FireHotspot']('bounded source',-121,37,1.8,90,0,20)];frames=[]
            for frame in range(3):density=n['inject_hotspots'](n['advect_density'](density,u,v),hotspots,frame,bounds);frames.append(flat(density))
            add('smoke-injection',['advect_density','inject_hotspots'],{'width':16,'height':16,'u':flat(u),'v':flat(v),'bounds':vars(bounds),'hotspots':[vars(h)for h in hotspots],'seed':n['DEFAULT_SEED'],'frames':3},{'densityFrames':frames},2e-6)
            render={'scalar':'densityFrames'}
        elif filename=='california_wildfire_smoke_video.py':
            kind='wildfire';n=native(filename,['_advect_smoke_density','_smoke_lifecycle_alpha']);density=np.array([[math.exp(-((x-5)**2+(y-8)**2)/8)for x in range(16)]for y in range(16)],dtype=np.float32);u=np.full_like(density,.7);v=np.full_like(density,-.35);frames=[]
            for _ in range(3):density=n['_advect_smoke_density'](density,u,v);frames.append(flat(density))
            ages=[0,.2,1,3,8];alpha=[n['_smoke_lifecycle_alpha'](a)for a in ages]
            add('wildfire-advection',['_advect_smoke_density','_smoke_lifecycle_alpha'],{'width':16,'height':16,'density':flat(np.array([[math.exp(-((x-5)**2+(y-8)**2)/8)for x in range(16)]for y in range(16)],dtype=np.float32)),'u':flat(u),'v':flat(v),'ages':ages,'maxAge':n['SMOKE_PARTICLE_MAX_AGE_HOURS']},{'densityFrames':frames,'alpha':alpha},2e-6)
            render={'scalar':'densityFrames'}
        elif 'landcover' in filename:
            kind='landcover';classes=np.array([[1 if x<5 else 2 if x<10 else 5 for x in range(16)]for y in range(16)],dtype=np.uint8);classes[7,7]=7;classes[0,0]=0
            if filename=='swiss_terrain_landcover_viewer.py':
                n=native(filename,['rgb_to_classes','despeckle_landcover_classes','classes_to_rgba']);rgb=np.array([n['LANDCOVER_SOURCE_PALETTE_RGB'][int(v)%len(n['LANDCOVER_SOURCE_PALETTE_RGB'])]for v in classes.ravel()],dtype=np.uint8).reshape(16,16,3);rgb[0,0]=0;raw=n['rgb_to_classes'](rgb);clean=n['despeckle_landcover_classes'](raw);rgba=n['classes_to_rgba'](clean)
                add('swiss-landcover',['rgb_to_classes','despeckle_landcover_classes','classes_to_rgba'],{'width':16,'height':16,'rgb':flat(rgb),'palette':n['LANDCOVER_SOURCE_PALETTE_RGB'].tolist(),'display':n['landcover_palette_rgb']().tolist(),'invalidMax':n['LANDCOVER_INVALID_CHANNEL_MAX'],'passes':n['LANDCOVER_DESPECKLE_PASSES'],'maxSupport':n['LANDCOVER_DESPECKLE_MAX_SUPPORT'],'minMajority':n['LANDCOVER_DESPECKLE_MIN_MAJORITY']},{'classes':flat(clean),'rgba':flat(rgba)})
            else:
                base=native('bosnia_terrain_landcover_viewer.py',['_clean_landcover_classes','_hillshade','DISPLAY_RGB']);clean=base['_clean_landcover_classes'](classes);shade=base['_hillshade'](dem,314,22,z_factor=1.85)
                add('bosnia-landcover',['_clean_landcover_classes','_hillshade'],{'width':16,'height':16,'classes':flat(classes),'dem':flat(dem),'classIds':base['LANDCOVER_CLASS_IDS'],'despeckle':base['DESPECKLE'],'palette':base['DISPLAY_RGB'].tolist(),'azimuth':314,'elevation':22,'zFactor':1.85},{'classes':flat(clean),'shade':flat(shade)},2e-6,source='bosnia_terrain_landcover_viewer.py')
                if filename=='romania_terrain_landcover_viewer.py':
                    n=native(filename,['_trim_border_open_water'],{'base':SimpleNamespace(_is_fresh=lambda *a:False,SOURCE_COLORMAP_FULL=base.get('SOURCE_COLORMAP_FULL',{}))});classes[:,0]=0
                    with tempfile.TemporaryDirectory(dir=ROOT/'test-results') as temp:
                        folder=Path(temp);dp=folder/'dem.tif';cp=folder/'classes.tif';raster(dp,dem);raster(cp,classes);_,result=n['_trim_border_open_water'](dp,cp,folder,2,force=True)
                        with rasterio.open(result)as src:trimmed=src.read(1)
                    add('romania-border-water',['_trim_border_open_water'],{'width':16,'height':16,'classes':flat(classes),'trim':2},{'classes':flat(trimmed)})
                elif filename=='germany_terrain_landcover_viewer.py':
                    n=native(filename,['_prepare_render_overlay'],{'viewer':SimpleNamespace(_is_fresh=lambda *a:False,COUNTRY_A3='DEU')});rgba=np.tile(np.array([[[20,70,110,255],[150,180,60,255]],[[70,120,40,255],[240,150,40,255]]],dtype=np.uint8),(16,16,1))
                    with tempfile.TemporaryDirectory(dir=ROOT/'test-results')as temp:
                        folder=Path(temp);dp=folder/'dem.tif';op=folder/'overlay.png';raster(dp,dem);Image.fromarray(rgba).save(op);res=n['_prepare_render_overlay'](op,dp,folder)
                        with Image.open(res)as im:resized=np.asarray(im)
                    add('germany-overlay-grid',['_prepare_render_overlay'],{'sourceWidth':32,'sourceHeight':32,'width':16,'height':16,'rgba':flat(rgba)},{'rgba':flat(resized)})
        elif filename=='uk_ireland_lighthouse_map.py':
            kind='lighthouses';n=native(filename,['terrarium_rgb_to_height','farthest_point_indices','assign_lighthouse_glow_weights','apply_northern_relief_boost']);points=np.array([[0,0],[3000,0],[15000,2000],[50000,10000],[70000,-5000]],dtype=np.float32);lights=[SimpleNamespace(proj_x=x,proj_y=y,glow_weight=1)for x,y in points];n['assign_lighthouse_glow_weights'](lights);boosted=n['apply_northern_relief_boost'](dem,np.ones_like(dem))
            add('lighthouse-relief',['farthest_point_indices','assign_lighthouse_glow_weights','apply_northern_relief_boost'],{'width':16,'height':16,'dem':flat(dem),'points':points.tolist(),'count':3,'densityRadius':n['LIGHTHOUSE_GLOW_DENSITY_RADIUS_M']},{'selected':n['farthest_point_indices'](points,3),'weights':[v.glow_weight for v in lights],'terrain':flat(boosted)},1e-4)
            render={'terrain':'terrain'}
        else:raise AssertionError('Unimplemented original regional example '+filename)
        assert ops,filename
        # Own source is always included; dependencies are separate operation sources.
        raw=subprocess.check_output(['git','show',f'{REF}:examples/{filename}'],cwd=REPO)
        cases[filename]={'source':{'ref':REF,'path':'examples/'+filename,'sha256':hashlib.sha256(raw).hexdigest()},'kind':kind,'terrain':terrain,'operations':ops,'render':render}
    assert len(cases)==24,len(cases)
    return cases,SOURCES
