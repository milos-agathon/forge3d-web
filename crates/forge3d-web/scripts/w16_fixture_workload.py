"""W16-designed spatial stress fixtures; W00 pins dimensions, not this layout."""
import hashlib
import io
import json
import struct
from pathlib import Path

import laspy
import lazrs
import numpy as np


def digest(data):
    return hashlib.sha256(data).hexdigest()


def key_text(key):
    return "-".join(map(str, key))


def child(key, octant):
    d, x, y, z = key
    return (d + 1, 2*x + (octant & 1), 2*y + ((octant >> 1) & 1), 2*z + ((octant >> 2) & 1))


def build_branching_ept(source, destination):
    folder = destination / "workload-ept"
    data_dir = folder / "ept-data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (folder / "ept-hierarchy").mkdir(exist_ok=True)
    # Remove only old generated point files inside this exact fixture folder.
    for old in data_dir.glob("*.bin"):
        assert old.resolve().parent == data_dir.resolve()
        old.unlink()
    levels = [[(0, 0, 0, 0)]]
    for depth in range(8):
        nodes = []
        for key in levels[-1]:
            if depth < 2:
                octants = range(8)
            else:
                octant = (key[1] + 3*key[2] + 5*key[3] + depth) % 8
                octants = [octant, octant ^ 7] if depth % 2 == 0 else [octant]
            nodes.extend(child(key, o) for o in octants)
        levels.append(nodes)
    base_counts = [1024, 1024, 1024, 1024, 1024, 768, 512, 384]
    remaining = 1_000_000 - sum(len(levels[d])*base_counts[d] for d in range(8))
    leaf_count, extras = divmod(remaining, len(levels[8]))
    origin = np.array([636000., 848000., 0.])
    span = 1024.
    xyz = np.column_stack((source.x, source.y, source.z))
    normalized = (xyz - xyz.min(axis=0)) / (xyz.max(axis=0) - xyz.min(axis=0))
    colors = (np.column_stack((source.red, source.green, source.blue)).astype(np.uint16) >> 8).astype(np.uint8)
    dtype = np.dtype([(n, '<i4') for n in ['X','Y','Z']] + [(n, 'u1') for n in ['Red','Green','Blue']] + [('Intensity','<u2'),('Classification','u1')])
    hierarchy, records, ordinal = {}, [], 0
    for depth, level in enumerate(levels):
        for index, key in enumerate(level):
            count = base_counts[depth] if depth < 8 else leaf_count + (index < extras)
            indices = (np.arange(count) + ordinal*811) % len(source.points)
            width = span / 2**depth
            base = origin + np.array(key[1:])*width
            positions = base + (normalized[indices]*.8 + .1)*width
            coordinates = np.rint((positions-origin)/.001).astype('<i4')
            decoded = coordinates.astype(np.float64)*.001 + origin
            binary = np.empty(count, dtype=dtype)
            for axis, name in enumerate(['X','Y','Z']):
                binary[name] = coordinates[:,axis]
            for axis, name in enumerate(['Red','Green','Blue']):
                binary[name] = colors[indices,axis]
            binary['Intensity'] = source.intensity[indices]
            binary['Classification'] = source.classification[indices]
            name = key_text(key)
            (data_dir / (name+'.bin')).write_bytes(binary.tobytes())
            hierarchy[name] = count
            records.append({'key':name,'count':count,'positionsSha256':digest(decoded.astype('<f8').tobytes()),'colorsSha256':digest(colors[indices].tobytes())})
            ordinal += 1
    schema = [{'name':n,'type':'signed','size':4,'scale':.001,'offset':float(origin[i])} for i,n in enumerate(['X','Y','Z'])]
    schema += [{'name':n,'type':'unsigned','size':1} for n in ['Red','Green','Blue']]
    schema += [{'name':'Intensity','type':'unsigned','size':2},{'name':'Classification','type':'unsigned','size':1}]
    (folder/'ept.json').write_text(json.dumps({'bounds':list(origin)+list(origin+span),'points':1_000_000,'span':128,'schema':schema,'dataType':'binary','hierarchyType':'json','srs':{'authority':'EPSG','horizontal':2992}}),encoding='utf8')
    (folder/'ept-hierarchy/0-0-0-0.json').write_text(json.dumps(hierarchy),encoding='utf8')
    branch_nodes = sum(1 for depth, level in enumerate(levels[:-1]) for key in level if sum(key_text(child(key,o)) in hierarchy for o in range(8)) > 1)
    return {'count':1_000_000,'hierarchyDepth':8,'cameraKeyframes':64,'design':'W16 synthetic branching spatial layout of independently rescaled Autzen samples; W00 specifies only dimensions and budgets','nodes':records,'topology':{'nodeCount':len(records),'branchNodes':branch_nodes,'nodesByDepth':[len(level) for level in levels]}}


def build_overview_copc(source, destination):
    # Two translated real survey patches, with a spatially distributed coarse
    # sample and eight additive leaf buckets. This is a 200k-point COPC file.
    converted = laspy.convert(source, point_format_id=7, file_version='1.4')
    points = laspy.ScaleAwarePointRecord.zeros(200_000, header=converted.header)
    for patch in range(2):
        points.array[patch*100_000:(patch+1)*100_000] = converted.points.array[:100_000]
    points.X[100_000:] += int(round((source.x.max()-source.x.min()+200) / points.scales[0]))
    xyz = np.column_stack((points.x, points.y, points.z))
    center = (xyz.min(axis=0)+xyz.max(axis=0))/2
    span = float(max(xyz.max(axis=0)-xyz.min(axis=0)))
    octants = ((xyz[:,0]>=center[0]).astype(int) + 2*(xyz[:,1]>=center[1]).astype(int) + 4*(xyz[:,2]>=center[2]).astype(int))
    seeds = {int(np.argmin(xyz[:,a])) for a in range(3)} | {int(np.argmax(xyz[:,a])) for a in range(3)}
    seeds |= {int(np.flatnonzero(octants==o)[0]) for o in np.unique(octants)}
    for i in np.linspace(0,len(points)-1,512,dtype=int):
        if len(seeds)>=512: break
        seeds.add(int(i))
    root_indices = np.array(sorted(seeds),dtype=int)
    remaining = np.ones(len(points),dtype=bool)
    remaining[root_indices] = False
    chunks = [((0,0,0,0),points.array[root_indices])]
    for o in range(8):
        indices = np.flatnonzero(remaining & (octants==o))
        if len(indices): chunks.append((child((0,0,0,0),o),points.array[indices]))
    header = converted.header.copy()
    header.vlrs.clear()
    header.are_points_compressed = True
    header.generating_software = 'W16 laspy/lazrs fixture'
    header.global_encoding.wkt = True
    header.update(points)
    vlr = lazrs.LazVlr.new_for_compression(7,0,True)
    header.vlrs.append(laspy.VLR('copc',1,'COPC info VLR',bytes(160)))
    header.vlrs.append(laspy.VLR('laszip encoded',22204,'lazrs 0.8.2',vlr.record_data()))
    wkt = source.header.parse_crs().to_wkt() if source.header.parse_crs() is not None else 'LOCAL_CS["W16 survey coordinates",UNIT["metre",1]]'
    header.vlrs.append(laspy.VLR('LASF_Projection',2112,'WKT',wkt.encode()+b'\0'))
    output = io.BytesIO()
    header.write_to(output)
    data_offset = output.tell()
    compressor = lazrs.LasZipCompressor(output,vlr)
    compressor.reserve_offset_to_chunk_table()
    offsets = []
    # The compressor buffers writes; flush after finishing all chunks, then use
    # the independent LAZ chunk table for exact offsets/lengths.
    compressor.compress_chunks([array.tobytes() for _,array in chunks])
    compressor.done()
    output.seek(data_offset)
    table = lazrs.read_chunk_table(output,vlr)
    offset = data_offset+8
    for (key,array),(count,size) in zip(chunks,table):
        assert count==len(array)
        offsets.append((key,offset,size,count))
        offset += size
    output.seek(0,2)
    evlr_offset = output.tell()
    hierarchy = b''.join(struct.pack('<iiiiQii',*key,offset,size,count) for key,offset,size,count in offsets)
    output.write(struct.pack('<H16sHQ32s',0,b'copc',1000,len(hierarchy),b'COPC hierarchy'))
    hierarchy_offset = output.tell()
    output.write(hierarchy)
    header.start_of_first_evlr = evlr_offset
    header.number_of_evlrs = 1
    output.seek(0)
    header.write_to(output)
    info = struct.pack('<dddddQQdd',*center,span/2,span/128,hierarchy_offset,len(hierarchy),float(points.gps_time.min()),float(points.gps_time.max())) + bytes(88)
    assert len(info)==160
    output.seek(375+54)
    output.write(info)
    path = destination/'overview.copc.laz'
    path.write_bytes(output.getvalue())
    # Both whole-file and COPC query paths in an independent codec must accept it.
    decoded = laspy.read(path)
    with laspy.CopcReader.open(path) as reader:
        root = reader.query(level=0)
        assert len(root)==len(root_indices)
    assert len(decoded.points)==200_000
    return path, root, decoded, len(chunks)


def topdown_view(center, height, viewport_height=1080, aspect=16/9):
    x,y,z = map(float,center)
    fov = np.pi/4
    near, far = .01*height, 8*height
    focal = 1/np.tan(fov/2)
    projection = np.array([[focal/aspect,0,0,0],[0,focal,0,0],[0,0,far/(near-far),near*far/(near-far)],[0,0,-1,0]])
    eye = np.array([x,y,z+height])
    view = np.eye(4)
    view[:3,3] = -eye
    matrix = projection @ view
    return {'position':eye.tolist(),'viewportHeight':viewport_height,'fovY':float(fov),'viewProjection':matrix.reshape(-1,order='F').tolist()}


def in_frustum(bounds, view):
    matrix = np.array(view['viewProjection']).reshape((4,4),order='F')
    clips = [matrix @ np.array([bounds.max[a] if o&(1<<a) else bounds.min[a] for a in range(3)]+[1.]) for o in range(8)]
    return not any(all(value<0 for value in values) for values in [[p[3]+p[0] for p in clips],[p[3]-p[0] for p in clips],[p[3]+p[1] for p in clips],[p[3]-p[1] for p in clips],[p[2] for p in clips],[p[3]-p[2] for p in clips]])


def additive_reference(dataset, native_renderer, view, options, allow_orphans=False):
    # The native public renderer has no ADD/frustum mode. Use its unchanged
    # bounds, priority and SSE functions in an independent Python policy oracle.
    frontier = [(dataset.root_node(),0)]
    selected, used, order = [], 0, 1
    while frontier and used < options['pointBudget']:
        frontier.sort(key=lambda entry:(-native_renderer._compute_priority(entry[0].bounds,view['position']),entry[1]))
        node,_ = frontier.pop(0)
        if not in_frustum(node.bounds,view): continue
        fits = used+node.point_count <= options['pointBudget']
        if not fits and not allow_orphans: continue
        sse = float(native_renderer._compute_screen_size(node.bounds,view['position']))
        if fits:
            selected.append({'key':str(node.key),'pointCount':node.point_count,'sse':round(sse,9)})
            used += node.point_count
        if node.key.depth < options['maxDepth'] and sse > options['sseThreshold'] and node.spacing >= options['minSpacing']:
            for node in dataset.children(node.key):
                frontier.append((node,order))
                order += 1
    return selected
