"""Execute original pure native tests and record their observable API calls.

Wrappers call the unmodified originals. They record only inputs and returned
values, never replace the algorithm or copy a web expectation into a fixture.
"""
import copy
from dataclasses import asdict
import inspect
import json
from pathlib import Path
import tempfile
import zipfile


def record_native_tests(gen, style, expressions, bundle, output):
    calls, replays, current = [], [], None
    saved_paths, mutations = {}, {}
    def push(kind, value):
        if current is not None:
            calls.append({'operation': kind, **json.loads(json.dumps(value))})
    def context(ctx):
        return {'properties': ctx.properties, 'zoom': ctx.zoom, 'geometryType': ctx.geometry_type}
    def props(value):
        return {k.replace('_', '-'): v for k, v in asdict(value).items() if v is not None}
    def layer(value):
        return {'id': value.id, 'type': value.layer_type, 'source': value.source,
                'source-layer': value.source_layer, 'paint': props(value.paint),
                'layout': props(value.layout), 'filter': value.filter,
                'minzoom': value.minzoom, 'maxzoom': value.maxzoom}
    def spec(value):
        return {'version': value.version, 'name': value.name, 'sources': value.sources,
                'layers': [layer(l) for l in value.layers], 'sprite': value.sprite, 'glyphs': value.glyphs}
    def wrap(owner, name, capture):
        original = getattr(owner, name)
        def traced(*args, **kwargs):
            try:
                result = original(*args, **kwargs)
            except (ValueError, TypeError) as error:
                if name == 'parse_style': push('parse-error', {'input': args[0]})
                raise
            capture(args, kwargs, result)
            return result
        setattr(owner, name, traced)
    for name in ['fill_layers', 'line_layers', 'symbol_layers', 'layers_for_source_layer', 'layer_by_id']:
        wrap(style.StyleSpec, name, lambda a,k,r,n=name: push('query', {'input':spec(a[0]), 'method':n, 'argument':a[1] if len(a)>1 else None, 'expected':[v.id for v in r] if isinstance(r,list) else r.id if r else None}))
    wrap(style, 'parse_style', lambda a,k,r: push('parse', {'input':a[0], 'expected':spec(r)}))
    wrap(style, 'paint_to_vector_style', lambda a,k,r: push('paint', {'paint':props(a[0]), 'context':{'properties':a[1] if len(a)>1 else k.get('properties',{}), 'zoom':a[2] if len(a)>2 else k.get('zoom',10)}, 'expected':asdict(r)}))
    wrap(style, 'layout_to_label_style', lambda a,k,r: push('label', {'layout':props(a[0]), 'paint':props(a[1]), 'context':{'properties':a[2] if len(a)>2 else k.get('properties',{}), 'zoom':a[3] if len(a)>3 else k.get('zoom',10)}, 'expected':asdict(r)}))
    wrap(style, 'parse_color', lambda a,k,r: push('color', {'input':a[0], 'expected':r}))
    wrap(style, '_evaluate_filter', lambda a,k,r: push('filter', {'input':a[0], 'properties':a[1], 'expected':r}))
    wrap(style.StyleLayer, 'is_visible', lambda a,k,r: push('visible', {'layer':layer(a[0]), 'expected':r}))
    wrap(style.StyleLayer, 'in_zoom_range', lambda a,k,r: push('zoom-range', {'layer':layer(a[0]), 'zoom':a[1], 'expected':r}))
    wrap(expressions, 'evaluate', lambda a,k,r: push('expression', {'input':a[0], 'context':context(a[1]) if len(a)>1 else {}, 'expected':r}))
    def support_input(value):
        if not isinstance(value, style.StyleSpec): return value
        result=spec(value)
        for original, entry in zip(value.layers,result['layers']):
            entry['unsupported_paint_fields']=list(original.unsupported_paint_fields); entry['unsupported_layout_fields']=list(original.unsupported_layout_fields)
        return result
    wrap(style, 'validate_style_support', lambda a,k,r: push('support', {'input':support_input(a[0]), 'expected':r.to_dict()}))
    wrap(style, 'label_layer_contracts_from_style', lambda a,k,r: push('label-contract', {'input':spec(a[0]) if isinstance(a[0],style.StyleSpec) else a[0], 'expected':r}))
    def overlays(a,k,r):
        push('overlay', {'input':spec(a[0]) if isinstance(a[0],style.StyleSpec) else a[0], 'features':a[1], 'expected':[{'layer':o.name.split('.')[1], 'primitive':o.primitive.value, 'positions':[[v.x,v.y,v.z] for v in o.vertices], 'color':[o.vertices[0].r,o.vertices[0].g,o.vertices[0].b,o.vertices[0].a], 'lineWidth':o.line_width if o.primitive.value=='lines' else None, 'pointSize':o.point_size if o.primitive.value=='points' else None} for o in r]})
    wrap(style, 'vector_overlay_configs_from_style', overlays)
    import sys
    diagnostics = sys.modules['forge3d.diagnostics']
    wrap(diagnostics.Diagnostic, 'to_dict', lambda a,k,r: push('diagnostic', {'expected':r}))
    wrap(diagnostics.ValidationReport, 'to_dict', lambda a,k,r: push('report', {'expected':r}))
    def save(a,k,r):
        if current is None: return
        folder = output/'native-cases'/current[1]
        folder.mkdir(parents=True,exist_ok=True)
        destination=folder/f'{len(calls)}.forge3d'
        files={f.relative_to(r).as_posix():f.read_bytes() for f in sorted(r.rglob('*')) if f.is_file()}
        manifest=json.loads(files['manifest.json']); manifest['created_at']='2026-06-04T00:00:00Z'; files['manifest.json']=json.dumps(manifest).encode()
        with zipfile.ZipFile(destination,'w',zipfile.ZIP_DEFLATED) as archive:
            for name,raw in files.items():
                info=zipfile.ZipInfo(name,date_time=(2026,6,4,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED; archive.writestr(info,raw)
        saved_paths[str(r.resolve())]=destination.relative_to(output).as_posix()
        push('bundle-save', {'archive':destination.relative_to(output).as_posix(), 'expected':json.loads(files['scene/state.json']), 'manifest':manifest})
    wrap(bundle, 'save_bundle', save)
    def mutation(name):
        original=getattr(bundle.LoadedBundle,name)
        def traced(self,*args):
            archive=saved_paths.get(str(self.path.resolve()))
            command={'method':name,'args':list(args)}
            commands=mutations.setdefault(id(self),[])
            try: result=original(self,*args)
            except ValueError:
                if archive: push('mutation-error',{'archive':archive,'commands':commands+[command]})
                raise
            commands.append(command)
            effective=self.effective_scene_state()
            if archive: push('mutation',{'archive':archive,'commands':commands,'active':self.get_active_variant_id(),'labels':[l['text'] for l in effective.labels], 'rasterCount':len(effective.raster_overlays),'vectorCount':len(effective.vector_overlays),'preset':effective.preset})
            return result
        setattr(bundle.LoadedBundle,name,traced)
    mutation('apply_variant'); mutation('set_review_layer_visible')
    paths=['test_style_parser.py','test_style_render.py','test_style_pixel_diff.py','test_style_visual.py','test_diagnostics_style_support.py','test_diagnostics_bundle_serialization.py','test_bundle_roundtrip.py','test_bundle_render.py']
    for path in paths:
        native=gen.module('native_test_'+path[:-3], gen.source('tests/'+path))
        functions=[(name,fn) for name,fn in vars(native).items() if name.startswith('test_') and callable(fn)]
        for name,cls in vars(native).items():
            if name.startswith('Test') and inspect.isclass(cls):
                instance=cls(); functions.extend((n,getattr(instance,n)) for n in vars(cls) if n.startswith('test_'))
        for name,fn in functions:
            current=('tests/'+path,name); calls.clear(); mutations.clear(); saved_paths.clear()
            with tempfile.TemporaryDirectory() as tmp:
                args={}
                for argument in inspect.signature(fn).parameters:
                    if argument=='tmp_path': args[argument]=Path(tmp)
                    else: raise RuntimeError('Unsupported native fixture '+argument)
                fn(**args)
            replays.append({'source':current[0], 'test':name, 'calls':copy.deepcopy(calls)})
            current=None
    return replays
