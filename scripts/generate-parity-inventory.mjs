import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptRoot, "..");
const planPath = "docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md";
const commits = {
  deepNative: "bf8db93233e5158f6d226991fc5d230832c2d806",
  release: "0cec80d765672f8f6f58a51fcd779c9638df574e",
  reconciliation: "1f4084af428dc699bdcd108b029736cb73903926",
  finalContract: "a55911f021925a3264e476374ce43d1b204f1073",
  browserBaseline: "36c1ac251e2a0b1721227f4abd19fbb864636faa",
};
const requiredFixtureIds = [
  "dem-synthetic-v1",
  "terrain-material-v1",
  "clipmap-seam-v1",
  "volume-temporal-v1",
  "crs-epsg-v1",
  "mesh-io-v1",
  "copc-ept-tiles-v1",
  "trace-sdf-v1",
  "offline-denoise-v1",
];
const requiredHardwareProfileIds = ["reference-discrete", "reference-integrated"];
const requiredDependencyIds = [
  "harfbuzzjs",
  "proj-wasm",
  "geotiff",
  "laz-perf",
  "ktx-parse",
  "basis-universal",
  "exr",
  "mediabunny",
  "fflate",
  "pdf-lib",
  "pdf-lib-fontkit",
  "noble-ed25519",
];
const equivalentCapabilityIds = new Set(["R09", "R11", "C06", "C08", "G01", "G08", "M04", "M05", "M06", "M08"]);
const capabilityXcLinks = {
  R09: ["E01"],
  R10: ["E01", "E02"],
  R11: ["E01", "E03"],
  C06: ["E05"],
  C08: ["E05"],
  T10: ["E03", "E05"],
  P05: ["E05"],
  P06: ["E03"],
  G01: ["E03", "E06"],
  G02: ["E03", "E05"],
  G08: ["E03", "E05"],
  M04: ["E03"],
  M05: ["E03"],
  M06: ["E03"],
  M08: ["E05"],
};
const rootModuleOwners = {
  accel: "G09",
  animation: "C03",
  bin: "R10",
  bundle: "M04",
  camera: "C01",
  cli: "R10",
  colormap: "M07",
  converters: "R11",
  core: "R05",
  export: "M06",
  external_image: "R02",
  formats: "G08",
  geo: "G01",
  geometry: "G07",
  import: "G08",
  io: "G08",
  labels: "V05",
  license: "M08",
  lighting: "P01",
  loaders: "G08",
  mesh: "G07",
  offscreen: "R11",
  p5: "P11",
  passes: "P11",
  path_tracing: "G11",
  picking: "V04",
  pipeline: "P04",
  pointcloud: "G02",
  py_functions: "R12",
  py_module: "R12",
  py_types: "R12",
  render: "R05",
  renderer: "R04",
  scene: "R05",
  sdf: "G10",
  shaders: "P04",
  shadows: "P07",
  style: "M03",
  terrain: "T01",
  tiles3d: "G04",
  util: "M09",
  uv: "G07",
  vector: "V01",
  viewer: "R10",
};
const sceneFamilyOwners = {
  base: "R04",
  bloom: "P13",
  cloud_shadows: "P10",
  clouds: "P10",
  dof: "P13",
  ground_plane: "R05",
  ibl: "P06",
  instanced_mesh: "T13",
  native_overlays: "T11",
  native_text: "V05",
  oit: "P12",
  point_spot_lights_core: "P01",
  point_spot_lights_query: "P02",
  point_spot_lights_update: "P01",
  raster_overlay: "T11",
  rect_area_lights: "P03",
  reflections: "T16",
  shoreline: "T16",
  soft_light: "P02",
  ssgi: "P11",
  ssr: "P11",
  stats: "R06",
  text_mesh: "V05",
  water_surface: "T16",
};
const records = [];
const mappings = [];
const idSet = new Set();
const fileCache = new Map();
const sourceCache = new Map();

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function show(ref, path) {
  const key = `${ref}:${path}`;
  if (!fileCache.has(key)) {
    fileCache.set(key, execFileSync("git", ["show", key], {
      cwd: repositoryRoot,
      maxBuffer: 256 * 1024 * 1024,
    }));
  }
  return fileCache.get(key);
}

function textAt(ref, path) {
  return show(ref, path).toString("utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function listTree(ref, prefix) {
  return git(["ls-tree", "-r", "--name-only", ref, "--", prefix])
    .split(/\r?\n/u)
    .filter(Boolean);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sourceFor(ref, path, line, endLine) {
  const key = `${ref}:${path}`;
  if (!sourceCache.has(key)) {
    sourceCache.set(key, {
      ref,
      path,
      sha256: sha256(show(ref, path)),
      gitBlob: git(["rev-parse", key]).trim(),
    });
  }
  const source = { ...sourceCache.get(key) };
  if (line !== undefined) source.line = line;
  if (endLine !== undefined) source.endLine = endLine;
  return source;
}

function sourceForWorkingTree(path, line, endLine) {
  const bytes = readFileSync(join(repositoryRoot, path));
  const source = { ref: "working-tree", path, sha256: sha256(bytes) };
  if (line !== undefined) source.line = line;
  if (endLine !== undefined) source.endLine = endLine;
  return source;
}

function artifactId(kind, layer, source, qualifiedName) {
  return `${kind}:${sha256(`${kind}\0${layer}\0${source.ref}\0${source.path}\0${source.line ?? 0}\0${qualifiedName}`).slice(0, 24)}`;
}

function addArtifact({ kind, layer, name, qualifiedName = name, source, details, classification }) {
  const id = artifactId(kind, layer, source, qualifiedName);
  if (idSet.has(id)) throw new Error(`duplicate generated artifact id ${id}`);
  idSet.add(id);
  const result = classification ?? classifyArtifact({ kind, name, qualifiedName, path: source.path, details });
  if (!result?.capabilityId || !result?.rule) {
    throw new Error(`unclassified ${kind} artifact ${source.path}:${qualifiedName}`);
  }
  const record = { id, kind, layer, name, qualifiedName, source };
  if (details !== undefined) record.details = details;
  records.push(record);
  mappings.push({
    artifactId: id,
    capabilityId: result.capabilityId,
    targetId: result.targetId ?? `target:${result.capabilityId}`,
    xcLinks: [...new Set(result.xcLinks ?? capabilityXcLinks[result.capabilityId] ?? [])].sort(),
    classificationRule: result.rule,
  });
  return id;
}

function classified(capabilityId, rule, xcLinks = undefined, targetId = undefined) {
  return { capabilityId, rule, xcLinks, targetId };
}

function classifyArtifact(artifact) {
  if (artifact.kind === "package-root-export" || artifact.kind.startsWith("pyo3-")) {
    return classifySymbol(artifact.name);
  }
  if (artifact.kind === "scene-method") {
    const family = artifact.path.split("/").at(-1).replace(/\.rs$/u, "");
    const capabilityId = sceneFamilyOwners[family];
    return capabilityId ? classified(capabilityId, `scene-family:${family}`) : undefined;
  }
  if (artifact.kind === "native-module-root" || artifact.kind === "inactive-module-root") {
    const prefix = artifact.kind;
    if (artifact.name === "converters") return classified("R11", `${prefix}:converters`, ["E04"]);
    if (artifact.name === "external_image") return classified("R02", `${prefix}:external_image`, ["E07"]);
    const capabilityId = rootModuleOwners[artifact.name];
    return capabilityId ? classified(capabilityId, `${prefix}:${artifact.name}`) : undefined;
  }
  if (artifact.kind === "python-api-file" || artifact.kind === "python-public-definition") {
    return classifyPythonArtifact(artifact.path, artifact.name);
  }
  if (artifact.kind.startsWith("native-test") || artifact.kind === "native-example" || artifact.kind.startsWith("native-doc")) {
    return classifyPathArtifact(artifact.path, artifact.name, artifact.kind);
  }
  if (artifact.kind.startsWith("changelog-")) {
    return classifyText(artifact.details?.context ?? artifact.name, "changelog");
  }
  if (artifact.kind.startsWith("browser-")) {
    if (artifact.kind === "browser-declaration") return classifySymbol(artifact.name);
    return classifyPathArtifact(artifact.path, artifact.name, artifact.kind);
  }
  return undefined;
}

function classifySymbol(name) {
  const lower = name.toLowerCase();
  const rules = [
    ["R12", /^(?:__version__|version|scene|session|engine_info)$/u, "public-contract"],
    ["R03", /forge3druntimecapabilities/u, "browser-runtime-capabilities"],
    ["R01", /forge3d(?:runtime|error)/u, "browser-runtime"],
    ["R10", /resizeinput|interactive|widgets?/u, "browser-viewer"],
    ["C01", /camerainput/u, "camera-input"],
    ["C02", /orbitview|orbitcamera|orbitcontrols/u, "orbit-camera"],
    ["T01", /terrainbytesource|terrainheightmapsourceinput/u, "terrain-source"],
    ["T02", /terrainheightmapinput|terraincolorrampinput|terrainspike/u, "terrain-input"],
    ["T04", /heightaosettings|sunvisibilitysettings/u, "terrain-visibility"],
    ["T16", /reflectionsettings/u, "terrain-reflection"],
    ["P13", /camera_dof_params/u, "camera-dof"],
    ["V01", /vectoroverlay/u, "vector-overlay"],
    ["M03", /parse_color/u, "style-color"],
    ["M04", /scenebasestate/u, "bundle-state"],
    ["R03", /adapter|device_probe|get_device|has_gpu/u, "gpu-diagnostics"],
    ["R07", /memory|budget|utilization/u, "memory-policy"],
    ["R10", /viewer|labelbatchresult/u, "viewer"],
    ["R11", /offscreen/u, "offscreen"],
    ["R02", /(?:numpy_to_png|png_to_numpy|rgba_to_png|save_png|frame$)/u, "readback-png"],
    ["R04", /renderer|config|preset/u, "renderer-config"],
    ["C01", /camera_(?:look_at|perspective|orthographic|view_proj)|make_camera|camerastate/u, "camera"],
    ["C03", /camera(?:keyframe|animation)|animation/u, "camera-animation"],
    ["C04", /camera_rig/u, "camera-rig"],
    ["C05", /framedumper|dump_frame/u, "frame-sequence"],
    ["C07", /aovframe|hdrframe/u, "aov-hdr"],
    ["C08", /offline|oidn|denoise/u, "offline-render"],
    ["T01", /dem_stats|terrainsource/u, "dem"],
    ["T02", /terrainrenderer|colormap1d|terrainrenderparams$/u, "terrain-render"],
    ["T05", /terrainrenderparamsconfig|pomsettings|triplanarsettings|samplingsettings|clampsettings/u, "terrain-material"],
    ["T06", /material(?:noise|layer)settings/u, "terrain-layer-material"],
    ["T07", /detailsettings/u, "terrain-detail"],
    ["T08", /clipmap|triangle_reduction|lodsettings/u, "clipmap"],
    ["T11", /rasteroverlay|overlaylayer/u, "raster-overlay"],
    ["T13", /terrain_scatter|unsupported_instancing/u, "scatter"],
    ["T14b", /vt_unsupported|validate_terrain_vt_support|vtlayerfamily/u, "vt-diagnostic"],
    ["T14a", /terrainvtsettings/u, "virtual-texture"],
    ["T15", /probesettings|reflectionprobesettings/u, "terrain-probes"],
    ["P01", /lightsettings|lightingpreset/u, "lighting"],
    ["P05", /materialset|texture/u, "pbr-texture"],
    ["P06", /^ibl|iblsettings/u, "ibl"],
    ["P07", /shadowsettings|configure_csm/u, "shadow"],
    ["P08", /sunposition|sun_position/u, "sun-ephemeris"],
    ["P09", /fogsettings/u, "fog"],
    ["P11", /ssgi|ssr/u, "screen-space"],
    ["V05", /fontatlas|fontfallback|labellayer|labelstyle|labelflags/u, "labels"],
    ["V07", /labelplan|labelcandidate|acceptedlabel|rejectedlabel|priorityclass|keepout|typography|validate_label/u, "label-plan"],
    ["G01", /(?:proj_available|transform_coords|reproject|crs_|dataset|mini_dem|sample_boundaries|fetch_dem|fetch_cityjson|fetch_copc)/u, "crs-dataset"],
    ["G02", /copc|laz/u, "pointcloud-codec"],
    ["G03", /pointbuffer|pointcloudlayer/u, "pointcloud-render"],
    ["G04", /tiles3d|3dtiles/u, "tiles3d"],
    ["G05a", /building|roof|material_from_tags|material_from_name/u, "buildings"],
    ["G06", /geometry_generate_(?:primitive|tube|ribbon|thick_polyline)|geometry_extrude/u, "geometry-construction"],
    ["G07", /geometry_|mesh_generate|translate|rotate_|^scale$|geometry$/u, "mesh-processing"],
    ["G08", /io_import|io_export|^io$/u, "mesh-io"],
    ["G10", /sdf/u, "sdf"],
    ["G11", /pathtracer|hybrid_render/u, "path-tracing"],
    ["M01", /diagnostic|supportmatrix|validationreport|severitypolicy|renderfailurepolicy|layersummary|required_diagnostic|p2_feature/u, "diagnostics"],
    ["M02b", /unavailable_cache_lod|python_public_3dtiles|placeholder_fallback/u, "mapscene-diagnostic"],
    ["M02a", /mapscene|scenerecipe|mapfurniture|orbitscamera|outputspec|reproducibility/u, "map-scene"],
    ["M03", /style|paintprops|layoutprops/u, "mapbox-style"],
    ["T18", /scenevariant|reviewlayer/u, "terrain-variant"],
    ["M04", /bundle|camerabookmark|scenestate|terrainmeta/u, "bundle"],
    ["M05", /mapplate|plate|legend|scalebar|northarrow|bbox/u, "map-plate"],
    ["M06", /vectorscene|exportvector|exportlabel|exportpolygon|exportpolyline|exportbounds|svg|pdf/u, "vector-export"],
    ["M07", /colormap|available_colormaps|colors/u, "colormap"],
    ["M08", /license|pro_gated/u, "license"],
  ];
  for (const [capabilityId, pattern, rule] of rules) {
    if (pattern.test(lower)) {
      if (rule === "viewer" && /widget/u.test(lower)) return classified("R10", `symbol:${rule}`, ["E04"]);
      if (rule === "viewer" && /ipc/u.test(lower)) return classified("R10", `symbol:${rule}`, ["E02"]);
      if (rule === "readback-png") return classified(capabilityId, `symbol:${rule}`, ["E07"]);
      if (rule === "crs-dataset" && /dataset|mini_dem|sample|fetch_/u.test(lower)) return classified(capabilityId, `symbol:${rule}`, ["E06"]);
      return classified(capabilityId, `symbol:${rule}`);
    }
  }
  return undefined;
}

function classifyPythonArtifact(path, name) {
  const normalized = path.replaceAll("\\", "/");
  const module = normalized.replace(/^python\/forge3d\//u, "").replace(/\.(?:py|pyi)$/u, "");
  const first = module.split("/")[0];
  const fixed = {
    "__init__": "R12",
    _ed25519: "M08",
    _gpu: "R03",
    _license: "M08",
    _memory: "R07",
    _native: "R12",
    _png: "R02",
    _validate: "R04",
    _viewer_binary: "R10",
    _viewer_entry: "R10",
    animation: "C03",
    bench: "M09",
    buildings: "G05a",
    bundle: "M04",
    camera_rigs: "C04",
    cog: "T10",
    colormaps: "M07",
    colors: "M07",
    config: "R04",
    crs: "G01",
    datasets: "G01",
    denoise: "C08",
    denoise_oidn: "C08",
    diagnostics: "M01",
    export: "M06",
    guiding: "G11",
    interactive: "R10",
    label_plan: "V07",
    legend: "M05",
    lighting: "P01",
    map_plate: "M05",
    map_scene: "M02a",
    materials: "P04",
    mem: "R07",
    north_arrow: "M05",
    offline: "C08",
    path_tracing: "G11",
    presets: "R04",
    scale_bar: "M05",
    sdf: "G10",
    style: "M03",
    style_expressions: "M03",
    terrain_demo: "T02",
    terrain_params: "T05",
    terrain_pbr_pom: "T05",
    terrain_scatter: "T13",
    textures: "P05",
    tiles3d: "G04",
    vector: "V01",
    viewer: "R10",
    viewer_ipc: "R10",
    widgets: "R10",
  };
  if (first === "helpers") {
    if (module.endsWith("aov_io")) return classified("C07", `python-module:${module}`);
    if (module.endsWith("frame_dump")) return classified("C05", `python-module:${module}`);
    if (module.endsWith("offscreen")) return classified("R11", `python-module:${module}`, ["E03"]);
    if (module.endsWith("ipython_display") || module.endsWith("mpl_display")) return classified("R10", `python-module:${module}`, ["E04"]);
    return classified("R12", `python-module:${module}`);
  }
  if (first === "geometry") {
    return /primitive|extrude|tube|ribbon|polyline/u.test(name.toLowerCase())
      ? classified("G06", "python-module:geometry-construction")
      : classified("G07", "python-module:geometry-processing");
  }
  if (first === "io") {
    return /dem|height|raster/u.test(name.toLowerCase())
      ? classified("T01", "python-module:io-dem", ["E03"])
      : classified("G08", "python-module:io", ["E03"]);
  }
  if (first === "mesh") return classified("G07", "python-module:mesh");
  if (first === "pointcloud") {
    return /render|lod|budget|style/u.test(name.toLowerCase())
      ? classified("G03", "python-module:pointcloud-render", ["E05"])
      : classified("G02", "python-module:pointcloud-io", ["E03", "E05"]);
  }
  const capabilityId = fixed[first];
  if (!capabilityId) return undefined;
  const links = first === "datasets" ? ["E06"] : first === "_png" ? ["E07"] : first === "viewer_ipc" ? ["E02"] : first === "widgets" ? ["E04"] : undefined;
  return classified(capabilityId, `python-module:${first}`, links);
}

function classifyPathArtifact(path, name, kind) {
  const text = `${path} ${name}`.toLowerCase();
  const pathRules = [
    ["R12", /api_contract|phase15|fixture_inventory|prerequisite|install_(?:smoke|compatible_wheel)|requirements|conftest|helpers_namespace|smoke_test|_import_shim|release-hardening|public-api|emitted-facade|package-contract|index\.d\.ts|feature_map|competitive_positioning|architecture|migration|superpowers|api_reference|top-level package|docs\/examples\/index|examples catalog|foundational sanity|support files in|where to go next|docs\/gallery\/index|docs\/index\.rst|where to start|tutorials\/index|python-track\/index|gis-track\/index/u, "contract"],
    ["R01", /device_loss|realm_coordination|webgpu_diagnostics|evidence-mode|playwright-config|playwright-launch|playwright-project|source-launch|clear\.spec|test-clear/u, "runtime-lifecycle"],
    ["R02", /screenshot|png_io|png_numpy|_png\.py|aov/u, "readback"],
    ["R03", /adapter|device_probe/u, "device-diagnostics"],
    ["R04", /preset|renderer|config|triangle_png|rendering_and_analysis|rendering and analysis|native rendering and quality/u, "renderer-config"],
    ["R07", /memory|viewer_resources/u, "memory"],
    ["R10", /viewer_ipc|viewer-controls|interactive_viewer|interactive-viewer|viewer_lifecycle|viewer\.test|viewer-interaction|viewer-visibility|render-scheduler|resize-controller|camera[_-]resize|lifecycle-away|saf02_page|viewer\/index|viewer-first|viewer, notebook|\bnotebooks\b|notebook integration|cli.oriented|cli and integration|widgets/u, "viewer"],
    ["R11", /native and offscreen|offscreen rendering/u, "offscreen"],
    ["C01", /perspective|camera_resize|cam_phi/u, "camera"],
    ["C02", /orbit-controller/u, "camera-controls"],
    ["C03", /animation_mvp|camera_animation|animation and camera automation/u, "camera-animation"],
    ["C04", /camera_rigs|camera-flyover/u, "camera-rig"],
    ["C05", /frame_dump|frame sequences|output_and_integration|timelapse|video/u, "frame-sequence"],
    ["C07", /exr|aov|hdr/u, "aov-hdr"],
    ["C08", /offline|oidn|denoise|accumulation/u, "offline"],
    ["T01", /dem_loading|first-dem|terrain_data_revision|terrain[_-]sources/u, "dem"],
    ["T02", /terrain_renderer|terrain_runtime|terrain_demo|terrain_single_tile|terrain[_-]hill|terrain\.spec|terrain_explorer|terrain_viewer_interactive|first.3d.terrain|python-01-first-terrain|highres|colorado_rem|platte_rem|rainier|barcelona_travel/u, "terrain"],
    ["T03", /terrain_analysis|heightfield_compute/u, "terrain-analysis"],
    ["T04", /heightfield_ao|sun_visibility/u, "terrain-ao"],
    ["T05", /terrain_pbr|terrain_materials|terrain_viewer_pbr|terrain_pom|terrain_visual|terrain_tv24/u, "terrain-material"],
    ["T06", /tv4|tv10|subsurface|material_variation/u, "terrain-layers"],
    ["T07", /micro-detail|normal anti|terrain_render_color/u, "terrain-detail"],
    ["T08", /clipmap|geomorph|gpu_lod/u, "clipmap"],
    ["T09", /large_scene_bottleneck|stream/u, "terrain-stream"],
    ["T10", /cog|cloud-native/u, "cog"],
    ["T11", /landcover|overlay_stack|raster|drape-overlays|gis-02-overlays/u, "raster-overlay"],
    ["T12", /vector_drape|vector_overlay_drape|luxembourg/u, "vector-drape"],
    ["T13", /scatter|tv13|tv21|tv22|instancing/u, "scatter"],
    ["T14b", /vt_family|vt_docs/u, "vt-diagnostic"],
    ["T14a", /virtual_texturing|tv20/u, "virtual-texture"],
    ["T15", /terrain_probe|reflection_probe/u, "terrain-probe"],
    ["T16", /water|shoreline/u, "water"],
    ["T17", /terrain_atmosphere|terrain_sky/u, "terrain-atmosphere"],
    ["P01", /light_feature|lighting_alignment|lighting_preset|camera-lighting/u, "lighting"],
    ["P05", /mesh_tbn|gltf|texture/u, "pbr-texture"],
    ["P07", /shadow_techniques|shadow-comparison|solar.potential/u, "shadow"],
    ["P08", /sun_ephemeris|daycycle/u, "sun"],
    ["P09", /volumetric|fog|smoke|storm/u, "volumetric"],
    ["P10", /cloud/u, "cloud"],
    ["P11", /ssgi|ssr|screen.space/u, "screen-space"],
    ["P12", /oit_transparency/u, "oit"],
    ["P13", /bloom|dof|lens_effect/u, "post-fx"],
    ["P14", /motion_blur|motion_vector|taa|jitter/u, "temporal"],
    ["P15", /tonemap|color_space|blender_quality/u, "color"],
    ["V03", /vector_overlay_rendering/u, "vector-pick-composite"],
    ["V04", /picking/u, "picking"],
    ["V06b", /advanced_labels|line_curved|label_plan_terrain/u, "advanced-label-diagnostic"],
    ["V06a", /line_edge|callout/u, "line-label"],
    ["V07", /label_plan|typography|complex_shaping|label_expressions/u, "label-plan"],
    ["V05", /label|fuji/u, "label"],
    ["V01", /river_basins|population_spikes|lighthouse_map/u, "vector-workflow"],
    ["G01", /crs|reproject|dataset|bundled_datasets/u, "crs-dataset"],
    ["G02", /copc|laz|ept/u, "pointcloud-io"],
    ["G03", /pointcloud|point-cloud|large_scene_(?:cache|lod|memory)/u, "pointcloud-render"],
    ["G04", /3dtiles|tiles3d/u, "tiles3d"],
    ["G05b", /building_texture/u, "building-diagnostic"],
    ["G05a", /building|cityjson|osm_city|f2_city_demo/u, "building"],
    ["G06", /extrude|thick_polyline|ribbon|primitive/u, "geometry-construction"],
    ["G07", /mesh|geometry|tbn/u, "mesh-processing"],
    ["G08", /obj|stl|gltf|image.*io/u, "mesh-io"],
    ["G10", /sdf/u, "sdf"],
    ["G11", /path_trac|raytrace|restir|guiding|media_hg/u, "path-tracing"],
    ["M01", /diagnostic|support_matrices|support_matrix|support-matrix|support_docs|quickstart|support_paths|no_op_policy|docs_support|determinism_noop/u, "diagnostics"],
    ["M02b", /mapscene_support_status|large[_ -]scene[_ -](?:docs|support)|textured_building_mapscene/u, "mapscene-diagnostic"],
    ["M02a", /mapscene|map_scene|scene_workflow|3d.map.project|example map/u, "mapscene"],
    ["M03", /style|mapbox/u, "style"],
    ["M04", /bundle/u, "bundle"],
    ["M05", /map_plate|map-plate|map plates|cartograph|legend|north_arrow|scale_bar/u, "map-plate"],
    ["M06", /export_svg|export_projection|vector[- ]export/u, "vector-export"],
    ["M07", /colormap|bivariate/u, "colormap"],
    ["M08", /license|pro_gating/u, "license"],
    ["M09", /benchmark|perf/u, "benchmark"],
  ];
  for (const [capabilityId, pattern, rule] of pathRules) {
    if (pattern.test(text)) {
      const links = rule === "crs-dataset" && /dataset/u.test(text) ? ["E06"] : rule === "readback" && /png/u.test(text) ? ["E07"] : rule === "viewer" && /widget/u.test(text) ? ["E04"] : undefined;
      return classified(capabilityId, `${kind}:${rule}`, links);
    }
  }
  if (/dask_stub/u.test(path)) return classified("R10", `${kind}:array-equivalent`, ["E04"]);
  if (/pnoa_river/u.test(path)) return classified("T11", `${kind}:raster-workflow`);
  if (path.includes("docs/assets/logo") || path.endsWith("docs/conf.py") || path.endsWith("docs/Makefile")) return classified("R12", `${kind}:documentation-shell`);
  if (path.includes("tests/golden/terrain")) return classified("T05", `${kind}:terrain-golden`);
  if (path.includes("tests/fixtures")) return classified("M03", `${kind}:style-fixture`);
  if (/^tests\/(?:__init__|_ssim|_terrain_runtime|validate_terrain)/u.test(path)) return classified("R12", `${kind}:test-support`);
  return undefined;
}

function classifyText(text, namespace) {
  const value = text.toLowerCase();
  const directRules = [
    ["T13", /tv13|lod_count|impostor/u, "scatter-lod"],
    ["T15", /terrain_probe|terrain probe/u, "terrain-probe"],
    ["T06", /tv10|tv4 terrain|terrain material workflow/u, "terrain-material-workflow"],
    ["T02", /tv1.tv3|terrain.workflow|terrain normalization|terrain uniforms|terrainuniforms|terrainpipeline|height texture|r32float|grid generation/u, "terrain-foundation"],
    ["T11", /draped terrain overlay|terrain_overlays|altitude overlay|overlays infrastructure|basemap|xyz_wmts|cartopy|tile mosaic/u, "terrain-overlay"],
    ["T09", /real data ingestion|async tile|async io|async loader|cancellation and lod.aware|coalescing rules/u, "terrain-streaming"],
    ["M05", /title.compass.scale.text|compass overlay|compass rose|text and scale overlay/u, "map-furniture"],
    ["P13", /post.process infrastructure|full.screen post.process|ping.pong texture/u, "post-process-infrastructure"],
    ["T04", /ambient occlusion enhancement/u, "terrain-ambient-occlusion"],
    ["P09", /half.res mode|step.count heuristic/u, "volumetric-quality"],
    ["V01", /datashader/u, "datashader-vector-outcome"],
    ["G08", /geometry & io|geometry and io/u, "geometry-io-workstream"],
    ["G07", /model transform|compose_trs|transform functions|matrix utilities|transforms\.rs|normal matrix|compute_normal_matrix|mathematical tests/u, "mesh-transform"],
    ["G11", /queue compaction|progressive tiling|rng & determinism|rng plumbing|xorshift|participating media/u, "tracing-internals"],
    ["R08", /scene cache|scene.dependent precomputation|descriptor indexing|texture array support/u, "resource-substrate"],
    ["P04", /material.shader interop|pbr material constructor|cpu pbr|materials module policy/u, "material-routing"],
    ["P05", /texture processing/u, "texture-processing"],
    ["P15", /srgb color target/u, "color-target"],
  ];
  for (const [capabilityId, pattern, rule] of directRules) {
    if (pattern.test(value)) return classified(capabilityId, `${namespace}:${rule}`);
  }
  if (/matplotlib|numpy interop|zero.copy|imshow_rgba|mpl_/u.test(value)) return classified("R11", `${namespace}:array-display-equivalent`, ["E04"]);
  if (/pathlike|file.backed reader/u.test(value)) return classified("G08", `${namespace}:filesystem-equivalent`, ["E03"]);
  if (/package version|version bump|bumped (?:the )?version|full test suite|packaging|wheel|pypi|maturin|abi3|python support floor|public api|api consolidation|test safety|documentation|docs & api|readme|changelog|ci\/cd|github actions|dependency monitoring|input validation|error handling|import path|pymodule|vshade|compatibility shim|no functional code changes|module docstring|api policy|launch readiness|pro.boundary|developer.platform/u.test(value)) {
    return classified("R12", `${namespace}:release-engineering-metadata`);
  }
  const rules = [
    ["G02", /copc|laz|ept|point cloud.*(?:load|decode|hierarch)/u, "pointcloud-io"],
    ["G03", /point cloud|pointcloud|octree|sse budget/u, "pointcloud-render"],
    ["G04", /3d tiles|tiles3d|b3dm|pnts/u, "tiles3d"],
    ["G05b", /textured building/u, "building-diagnostic"],
    ["G05a", /building|cityjson|roof/u, "buildings"],
    ["G10", /\bsdf\b|signed distance|csg/u, "sdf"],
    ["G11", /path trac|ray trac|restir|wavefront|firefly|guiding|bent.normal/u, "path-tracing"],
    ["G01", /\bcrs\b|reproject|epsg|proj/u, "crs"],
    ["G08", /\bgltf\b|\bglb\b|\bobj\b|\bstl\b|mesh io|image io|hdr io/u, "mesh-io"],
    ["G06", /primitive|extrud|thick polyline|ribbon|tube/u, "geometry-construction"],
    ["G07", /mesh|tangent|tbn|subdiv|simplif|weld|uv/u, "mesh-processing"],
    ["V04", /pick|selection|lasso|highlight/u, "picking"],
    ["V06b", /curved label|repeated.path|terrain.elevated/u, "advanced-label"],
    ["V06a", /callout|line label/u, "line-label"],
    ["V07", /typograph|harfbuzz|shaping|label plan|declutter|keepout/u, "typography"],
    ["V05", /label|font atlas|text mesh/u, "labels"],
    ["M04", /bundle|bookmark|variant|review layer/u, "bundle"],
    ["M03", /mapbox|style spec|style parser|sprite|glyph/u, "style"],
    ["M05", /map plate|legend|scale bar|north arrow|map furniture/u, "map-plate"],
    ["M06", /\bsvg\b|\bpdf\b|vector export/u, "vector-export"],
    ["M07", /colormap|palette|\bcpt\b/u, "colormap"],
    ["M08", /license|ed25519|pro gat/u, "license"],
    ["M09", /benchmark|performance tool|perf sanity/u, "benchmark"],
    ["M02b", /underdeveloped|large.scene support|mapscene support/u, "mapscene-diagnostic"],
    ["M02a", /mapscene|scene recipe/u, "mapscene"],
    ["M01", /diagnostic|support matrix|failure policy|severity/u, "diagnostics"],
    ["T14b", /vt.*(?:normal|mask).*unsupported|unsupported.*vt/u, "vt-diagnostic"],
    ["T14a", /virtual textur|page table|residency/u, "virtual-texture"],
    ["T16", /water|shoreline|foam|planar reflection/u, "water"],
    ["T17", /terrain atmosphere|aerial perspective/u, "terrain-atmosphere"],
    ["T15", /reflection probe|irradiance probe|\bsh l2\b/u, "terrain-probes"],
    ["T13", /scatter|hlod|qem|wind/u, "scatter"],
    ["T12", /vector.*drape|draped vector/u, "vector-drape"],
    ["T11", /raster overlay|landcover|overlay stack/u, "raster-overlay"],
    ["T10", /\bcog\b|geotiff|cloud.native/u, "cog"],
    ["T09", /tile cache|prefetch|backpressure|streaming/u, "terrain-stream"],
    ["T08", /clipmap|geomorph|gpu lod/u, "clipmap"],
    ["T07", /micro.detail|normal anti|specular aa/u, "terrain-detail"],
    ["T06", /material layer|subsurface|snow|rock|wetness|material variation/u, "terrain-layers"],
    ["T05", /terrain pbr|pom|triplanar/u, "terrain-material"],
    ["T04", /heightfield ao|sun visibility/u, "terrain-ao"],
    ["T03", /slope|aspect|contour|terrain query/u, "terrain-analysis"],
    ["T01", /\bdem\b|nodata|heightmap stats/u, "dem"],
    ["T02", /terrain render|grid mesh|heightmap|terrain demo/u, "terrain-render"],
    ["P12", /\boit\b|transparency/u, "oit"],
    ["P14", /\btaa\b|motion vector|motion blur|jitter/u, "temporal"],
    ["P13", /bloom|depth of field|\bdof\b|lens effect|vignette|chromatic/u, "post-fx"],
    ["P15", /tonemap|tone map|\bhdr\b|color space|lut/u, "color"],
    ["P11", /ssao|gtao|ssgi|ssr|screen.space|g.buffer|hzb/u, "screen-space"],
    ["P10", /cloud/u, "cloud"],
    ["P09", /volumetric|fog|god ray|preetham|hosek|sky/u, "atmosphere"],
    ["P08", /ephemeris|sun position|time.of.day/u, "sun"],
    ["P07", /shadow|csm|pcf|pcss|vsm|evsm|msm/u, "shadow"],
    ["P06", /\bibl\b|irradiance|brdf lut|environment map/u, "ibl"],
    ["P05", /ktx|basis|compressed texture|normal map|pbr texture/u, "texture"],
    ["P04", /brdf|material routing|ggx|beckmann|lambert|phong/u, "brdf"],
    ["P03", /ltc|rectangle light|rect area/u, "area-light"],
    ["P02", /soft light|light radius|falloff/u, "soft-light"],
    ["P01", /light|illumination/u, "lighting"],
    ["C08", /offline|denois|oidn|accumulation/u, "offline"],
    ["C07", /aov|exr|depth output/u, "aov"],
    ["C06", /mp4|ffmpeg|webcodecs|video/u, "video"],
    ["C05", /snapshot|frame sequence/u, "frames"],
    ["C04", /camera rig|rail|follow|clearance/u, "camera-rig"],
    ["C03", /camera animation|keyframe/u, "camera-animation"],
    ["C02", /fps camera|fly camera|orbit control/u, "camera-control"],
    ["C01", /camera|perspective|orthographic|projection/u, "camera"],
    ["R11", /offscreen|headless/u, "offscreen"],
    ["R10", /viewer|window|event loop|ipc/u, "viewer"],
    ["R09", /thread pool|worker pool/u, "workers"],
    ["R08", /staging|buffer|fence|async compute|sampler|mipmap/u, "resource-substrate"],
    ["R07", /memory|budget|downscale/u, "memory"],
    ["R06", /timing|render bundle|scene stats/u, "timing"],
    ["R05", /scene graph|framegraph|render graph|resource tracker/u, "scene-graph"],
    ["R04", /renderer|session|config|preset/u, "renderer-config"],
    ["R03", /adapter|device probe/u, "device-probe"],
    ["R02", /readback|render rgba|screenshot|png/u, "readback"],
    ["R01", /gpu|device|webgpu|surface/u, "gpu"],
  ];
  for (const [capabilityId, pattern, rule] of rules) {
    if (pattern.test(value)) return classified(capabilityId, `${namespace}:${rule}`);
  }
  return classified("R12", `${namespace}:release-engineering-metadata`);
}

function parsePlan(planText) {
  const taskContracts = new Map();
  const taskPattern = /^### (W\d{2}) — ([^\n]+)\n([\s\S]*?)(?=^### W\d{2} — |^## Global Verification Commands)/gmu;
  for (const match of planText.matchAll(taskPattern)) {
    const body = match[3];
    taskContracts.set(match[1], {
      title: match[2].trim(),
      tests: extractBulletField(body, "Tests"),
      acceptance: extractBulletField(body, "Acceptance"),
    });
  }
  const rows = [];
  for (const line of planText.split("\n")) {
    if (!/^\|\s*(?:R|C|T|P|V|G|M|E)\d/u.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 6) continue;
    const [id, lifeEvidence, nativeCapability, requiredWebOutcome, status, ownerTask] = cells;
    if (!/^(?:R|C|T|P|V|G|M|E)\d/u.test(id)) continue;
    const [lifecycle, evidenceGrade] = lifeEvidence.split("/");
    const contract = taskContracts.get(ownerTask);
    if (!contract?.tests || !contract?.acceptance) throw new Error(`missing task contract for ${id}/${ownerTask}`);
    const nativeEvidence = [...nativeCapability.matchAll(/`([^`]+)`/gu)].map((item) => item[1]);
    if (nativeEvidence.length === 0) nativeEvidence.push(`plan:${id}:native-capability`);
    rows.push({
      id,
      title: stripMarkdown(nativeCapability.split(":")[0]),
      lifecycle,
      evidenceGrade,
      status,
      ownerTask,
      nativeCapability: stripMarkdown(nativeCapability),
      requiredWebOutcome: stripMarkdown(requiredWebOutcome),
      nativeEvidence,
      requiredTests: [stripMarkdown(contract.tests)],
      acceptance: [stripMarkdown(contract.acceptance)],
      targetId: `target:${id}`,
      ...(lifecycle === "XC" ? {} : { xcLinks: capabilityXcLinks[id] ?? [] }),
    });
  }
  return rows;
}

function extractBulletField(body, field) {
  const match = body.match(new RegExp(`^- ${field}:\\s*([\\s\\S]*?)(?=^- [A-Z][A-Za-z ]+:|(?![\\s\\S]))`, "mu"));
  return match?.[1].replace(/\n\s+/gu, " ").trim();
}

function stripMarkdown(value) {
  return value.replaceAll("`", "").replace(/\s+/gu, " ").trim();
}

function addPackageRootExports() {
  const path = "python/forge3d/__init__.py";
  const text = textAt(commits.finalContract, path);
  const literalMatch = text.match(/__all__\s*=\s*\[([\s\S]*?)\]\s*\n__all__\.extend/u);
  if (!literalMatch) throw new Error("cannot parse package __all__");
  const literalNames = [...literalMatch[1].matchAll(/["']([^"']+)["']/gu)].map((match) => match[1]);
  const bundleMatch = text.match(/_BUNDLE_EXPORT_NAMES\s*=\s*\(([\s\S]*?)\)/u);
  if (!bundleMatch) throw new Error("cannot parse bundle exports");
  const bundleNames = [...bundleMatch[1].matchAll(/["']([^"']+)["']/gu)].map((match) => match[1]);
  const names = [...literalNames, ...bundleNames.filter((name) => !literalNames.includes(name))];
  if (names.length !== 220) throw new Error(`expected 220 package exports, got ${names.length}`);
  for (const name of names) {
    const line = lineOf(text, name);
    addArtifact({ kind: "package-root-export", layer: "final-contract", name, source: sourceFor(commits.finalContract, path, line), details: { literal: literalNames.includes(name) } });
  }
}

function addPyo3Registrations() {
  const path = "crates/forge3d-python/src/lib.rs";
  const text = textAt(commits.finalContract, path);
  const classes = [...text.matchAll(/m\.add_class::<([A-Za-z0-9_]+)>/gu)];
  const functions = [...text.matchAll(/m\.add_function\(wrap_pyfunction!\(([A-Za-z0-9_]+),\s*m\)/gu)];
  if (classes.length !== 28 || functions.length !== 44) throw new Error(`unexpected PyO3 registration counts ${classes.length}/${functions.length}`);
  for (const match of classes) addArtifact({ kind: "pyo3-class", layer: "final-contract", name: match[1], source: sourceFor(commits.finalContract, path, lineAt(text, match.index)) });
  for (const match of functions) addArtifact({ kind: "pyo3-function", layer: "final-contract", name: match[1], source: sourceFor(commits.finalContract, path, lineAt(text, match.index)) });
}

function addSceneMethods() {
  const paths = listTree(commits.finalContract, "src/scene/py_api").filter((path) => path.endsWith(".rs"));
  let count = 0;
  for (const path of paths) {
    const text = textAt(commits.finalContract, path);
    if (!text.includes("#[pymethods]") || !/impl\s+Scene\b/u.test(text)) continue;
    for (const match of text.matchAll(/^\s*(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gmu)) {
      addArtifact({ kind: "scene-method", layer: "final-contract", name: match[1], qualifiedName: `Scene.${match[1]}@${path}`, source: sourceFor(commits.finalContract, path, lineAt(text, match.index)) });
      count += 1;
    }
  }
  if (count < 80) throw new Error(`expected at least 80 Scene methods, got ${count}`);
  return count;
}

function addPythonApi() {
  const paths = listTree(commits.reconciliation, "python/forge3d").filter((path) => /\.(?:py|pyi)$/u.test(path));
  if (paths.length !== 72) throw new Error(`expected 72 Python API files, got ${paths.length}`);
  for (const path of paths) {
    const text = textAt(commits.reconciliation, path);
    addArtifact({ kind: "python-api-file", layer: "reconciliation", name: path.split("/").at(-1), qualifiedName: path, source: sourceFor(commits.reconciliation, path) });
    for (const match of text.matchAll(/^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gmu)) {
      if (match[3].startsWith("_")) continue;
      const line = lineAt(text, match.index);
      addArtifact({ kind: "python-public-definition", layer: "reconciliation", name: match[3], qualifiedName: `${path}:${line}:${match[3]}`, source: sourceFor(commits.reconciliation, path, line), details: { definitionKind: match[2], indentation: match[1].replaceAll("\t", "    ").length } });
    }
  }
}

function addNativeTests() {
  const paths = listTree(commits.reconciliation, "tests");
  if (paths.length !== 211) throw new Error(`expected 211 test files, got ${paths.length}`);
  const named = paths.filter((path) => /^tests\/test_.*\.py$/u.test(path));
  if (named.length !== 191) throw new Error(`expected 191 named test files, got ${named.length}`);
  let definitions = 0;
  for (const path of paths) {
    const bytes = show(commits.reconciliation, path);
    addArtifact({ kind: "native-test-file", layer: "reconciliation", name: path.split("/").at(-1), qualifiedName: path, source: sourceFor(commits.reconciliation, path) });
    if (!path.endsWith(".py")) continue;
    const text = bytes.toString("utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    for (const match of text.matchAll(/^\s*(?:async\s+)?def\s+(test[A-Za-z0-9_]*)\s*\(/gmu)) {
      const line = lineAt(text, match.index);
      addArtifact({ kind: "native-test-definition", layer: "reconciliation", name: match[1], qualifiedName: `${path}:${line}:${match[1]}`, source: sourceFor(commits.reconciliation, path, line) });
      definitions += 1;
    }
  }
  if (definitions !== 1792) throw new Error(`expected 1792 native test definitions, got ${definitions}`);
}

function addNativeExamples() {
  const paths = listTree(commits.reconciliation, "examples");
  if (paths.length !== 54) throw new Error(`expected 54 examples, got ${paths.length}`);
  for (const path of paths) addArtifact({ kind: "native-example", layer: "reconciliation", name: path.split("/").at(-1), qualifiedName: path, source: sourceFor(commits.reconciliation, path) });
}

function addNativeDocs() {
  const paths = listTree(commits.reconciliation, "docs");
  if (paths.length !== 88) throw new Error(`expected 88 documentation assets, got ${paths.length}`);
  const pages = paths.filter((path) => /\.(?:md|rst)$/iu.test(path));
  if (pages.length !== 53) throw new Error(`expected 53 documentation pages, got ${pages.length}`);
  for (const path of paths) {
    addArtifact({ kind: "native-doc-asset", layer: "reconciliation", name: path.split("/").at(-1), qualifiedName: path, source: sourceFor(commits.reconciliation, path) });
    if (!/\.(?:md|rst)$/iu.test(path)) continue;
    const text = textAt(commits.reconciliation, path);
    for (const heading of extractHeadings(text, path.endsWith(".rst"))) {
      addArtifact({ kind: "native-doc-feature", layer: "reconciliation", name: heading.title, qualifiedName: `${path}:${heading.line}:${heading.title}`, source: sourceFor(commits.reconciliation, path, heading.line, heading.endLine) });
    }
  }
}

function extractHeadings(text, rst) {
  const lines = text.split("\n");
  const headings = [];
  if (rst) {
    for (let index = 0; index + 1 < lines.length; index += 1) {
      if (lines[index].trim() && /^([=\-~^"`:+*#])\1{2,}\s*$/u.test(lines[index + 1])) headings.push({ title: lines[index].trim(), line: index + 1 });
    }
  } else {
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^#{1,6}\s+(.+?)\s*#*$/u);
      if (match) headings.push({ title: match[1].trim(), line: index + 1 });
    }
  }
  return headings.map((heading, index) => ({ ...heading, endLine: (headings[index + 1]?.line ?? lines.length + 1) - 1 }));
}

function addChangelog() {
  const path = "CHANGELOG.md";
  const text = textAt(commits.reconciliation, path);
  const lines = text.split("\n");
  let release = "Unversioned";
  let subsection = "Release";
  const bulletStack = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^(#{2,4})\s+(.+)$/u);
    if (heading) {
      if (heading[1].length === 2) release = heading[2].trim();
      else subsection = heading[2].trim();
      const context = `${release} ${subsection} ${heading[2]}`;
      addArtifact({ kind: "changelog-heading", layer: "reconciliation", name: heading[2].trim(), qualifiedName: `${path}:${index + 1}:${heading[2].trim()}`, source: sourceFor(commits.reconciliation, path, index + 1), details: { release, subsection, context } });
      continue;
    }
    const bullet = line.match(/^(\s*)[-*]\s+(.+)$/u);
    if (!bullet) continue;
    const indent = bullet[1].replaceAll("\t", "    ").length;
    while (bulletStack.length && bulletStack.at(-1).indent >= indent) bulletStack.pop();
    const ancestors = bulletStack.map((entry) => entry.text);
    const context = `${release} ${subsection} ${ancestors.join(" ")} ${bullet[2]}`;
    const classification = classifyText(context, "changelog");
    addArtifact({ kind: "changelog-addition", layer: "reconciliation", name: bullet[2], qualifiedName: `${path}:${index + 1}:${bullet[2]}`, source: sourceFor(commits.reconciliation, path, index + 1), details: { release, subsection, indent, context }, classification });
    bulletStack.push({ indent, text: bullet[2], capabilityId: classification.capabilityId });
  }
}

function addModuleRoots() {
  const roots = git(["ls-tree", "-d", "--name-only", `${commits.deepNative}:src`]).split(/\r?\n/u).filter(Boolean);
  for (const root of roots) {
    const tree = git(["rev-parse", `${commits.deepNative}:src/${root}`]).trim();
    const source = { ref: commits.deepNative, path: `src/${root}`, sha256: sha256(tree), gitBlob: tree };
    addArtifact({ kind: "native-module-root", layer: "deep-native", name: root, qualifiedName: `src/${root}`, source });
  }
  for (const familyPath of ["src/vector/extrusion.rs", "src/vector/batch", "src/vector/indirect", "src/vector/gpu_extrusion"]) {
    const object = git(["rev-parse", `${commits.deepNative}:${familyPath}`]).trim();
    const objectType = git(["cat-file", "-t", object]).trim();
    const source = objectType === "blob"
      ? sourceFor(commits.deepNative, familyPath)
      : { ref: commits.deepNative, path: familyPath, sha256: sha256(object), gitBlob: object };
    addArtifact({ kind: "native-implementation-family", layer: "deep-native", name: familyPath.split("/").at(-1).replace(/\.rs$/u, ""), qualifiedName: familyPath, source, classification: classified("V02", "native-vector-implementation-family") });
  }
  const path = "crates/forge3d-core/src/feature_gates.rs";
  const text = textAt(commits.browserBaseline, path);
  const body = text.match(/DEFAULT_WASM_INACTIVE_MODULE_ROOTS:[\s\S]*?=\s*&\[([\s\S]*?)\];/u)?.[1];
  if (!body) throw new Error("cannot parse inactive module roots");
  const matches = [...body.matchAll(/["']([^"']+)["']/gu)];
  if (matches.length !== 40) throw new Error(`expected 40 inactive module roots, got ${matches.length}`);
  for (const match of matches) {
    const absoluteIndex = text.indexOf(body) + match.index;
    addArtifact({ kind: "inactive-module-root", layer: "browser-baseline", name: match[1], qualifiedName: `inactive:${match[1]}`, source: sourceFor(commits.browserBaseline, path, lineAt(text, absoluteIndex)) });
  }
}

function addBrowserBaseline() {
  const typesPath = "crates/forge3d-web/types/index.d.ts";
  const typesText = textAt(commits.browserBaseline, typesPath);
  const declarations = [...typesText.matchAll(/^export\s+(?:declare\s+)?(interface|type|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gmu)];
  if (declarations.length !== 26) throw new Error(`expected 26 browser declarations, got ${declarations.length}`);
  for (const match of declarations) addArtifact({ kind: "browser-declaration", layer: "browser-baseline", name: match[2], qualifiedName: `${match[1]}:${match[2]}`, source: sourceFor(commits.browserBaseline, typesPath, lineAt(typesText, match.index)), details: { declarationKind: match[1] } });

  const unitPaths = listTree(commits.browserBaseline, "crates/forge3d-web/tests/unit");
  if (unitPaths.length !== 12) throw new Error(`expected 12 browser unit files, got ${unitPaths.length}`);
  let unitCases = 0;
  for (const path of unitPaths) {
    addArtifact({ kind: "browser-unit-file", layer: "browser-baseline", name: path.split("/").at(-1), qualifiedName: path, source: sourceFor(commits.browserBaseline, path) });
    const text = textAt(commits.browserBaseline, path);
    for (const match of text.matchAll(/\bit\s*\(\s*(["'`])([^"'`]+)\1/gu)) {
      addArtifact({ kind: "browser-unit-case", layer: "browser-baseline", name: match[2], qualifiedName: `${path}:${lineAt(text, match.index)}:${match[2]}`, source: sourceFor(commits.browserBaseline, path, lineAt(text, match.index)) });
      unitCases += 1;
    }
  }
  if (unitCases !== 80) throw new Error(`expected 80 browser unit cases, got ${unitCases}`);

  const playwrightPaths = listTree(commits.browserBaseline, "crates/forge3d-web/tests/playwright");
  if (playwrightPaths.length !== 14) throw new Error(`expected 14 Playwright specs, got ${playwrightPaths.length}`);
  let literalCases = 0;
  for (const path of playwrightPaths) {
    addArtifact({ kind: "browser-playwright-file", layer: "browser-baseline", name: path.split("/").at(-1), qualifiedName: path, source: sourceFor(commits.browserBaseline, path) });
    const text = textAt(commits.browserBaseline, path);
    for (const match of text.matchAll(/\btest\s*\(\s*(["'`])([^"'`]+)\1/gu)) {
      addArtifact({ kind: "browser-playwright-case", layer: "browser-baseline", name: match[2], qualifiedName: `${path}:${lineAt(text, match.index)}:${match[2]}`, source: sourceFor(commits.browserBaseline, path, lineAt(text, match.index)) });
      literalCases += 1;
    }
  }
  if (literalCases !== 38) throw new Error(`expected 38 literal Playwright cases, got ${literalCases}`);
  const generatedPath = "crates/forge3d-web/tests/playwright/terrain_sources.spec.ts";
  addArtifact({ kind: "browser-playwright-generated-case", layer: "browser-baseline", name: "loads Blob and File source variants", qualifiedName: `${generatedPath}:generated:Blob+File`, source: sourceFor(commits.browserBaseline, generatedPath), details: { generatedCount: 2, literalDeclarationCount: 1 } });

  const apiPaths = listTree(commits.browserBaseline, "crates/forge3d-web/tests/api");
  if (apiPaths.length !== 6) throw new Error(`expected 6 browser API artifacts, got ${apiPaths.length}`);
  for (const path of apiPaths) addArtifact({ kind: "browser-api-artifact", layer: "browser-baseline", name: path.split("/").at(-1), qualifiedName: path, source: sourceFor(commits.browserBaseline, path) });

  const htmlPaths = listTree(commits.browserBaseline, "crates/forge3d-web/examples").filter((path) => path.endsWith(".html") && !path.includes("/vite/"));
  if (htmlPaths.length !== 7) throw new Error(`expected 7 browser HTML fixtures, got ${htmlPaths.length}`);
  for (const path of htmlPaths) addArtifact({ kind: "browser-html-fixture", layer: "browser-baseline", name: path.split("/").at(-1), qualifiedName: path, source: sourceFor(commits.browserBaseline, path) });
}

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function lineOf(text, token) {
  const index = text.indexOf(`"${token}"`);
  return lineAt(text, index >= 0 ? index : text.indexOf(`'${token}'`));
}

const tombstoneSpecs = [
  ["render-raster", "render_raster", "R04", "historically-shipped-then-removed", "1f4084a:CHANGELOG.md:192-197", "Do not restore the removed top-level helper; implement its renderer outcome through R04."],
  ["render-polygons", "render_polygons", "V01", "historically-shipped-then-removed", "1f4084a:CHANGELOG.md:192-197", "Do not restore the removed helper; implement polygon outcomes through V01."],
  ["render-raytrace-mesh", "render_raytrace_mesh", "G11", "historically-shipped-then-removed", "1f4084a:CHANGELOG.md:192-197", "Do not restore the removed helper; implement tracing outcomes through G11."],
  ["csm-filter-value", "CSM as a shadow-filter value", "P07", "diagnostic-only", "1f4084a:tests/test_shadow_techniques.py", "CSM remains a cascade mode and must be rejected as a filter enum."],
  ["vt-normal-mask", "VT normal/mask paging", "T14b", "diagnostic-only", "1f4084a:tests/test_tv20_virtual_texturing.py", "Preserve exact unsupported-family diagnostics."],
  ["textured-buildings", "Textured building output", "G05b", "diagnostic-only", "1f4084a:tests/test_p2_building_texture_diagnostics.py", "Do not report scalar fallback as textured success."],
  ["experimental-label-cases", "Experimental curved/repeated/terrain labels", "V06b", "diagnostic-only", "1f4084a:tests/test_p2_advanced_labels_repeated_curved.py", "Preserve exact experimental diagnostics until promoted by runtime evidence."],
  ["mapscene-underdeveloped", "MapScene point-cloud/product-instancing/large-scene summaries", "M02b", "diagnostic-only", "1f4084a:tests/test_mapscene_support_status.py", "Preserve underdeveloped diagnostics until integrated behavior passes."],
  ["ply-import", "PLY import", "G08", "intended-unverified", "1f4084a:CHANGELOG.md F13", "Not a parity claim; any implementation is a separately versioned feature."],
  ["draco-decode", "Draco decode", "G08", "intended-unverified", "1f4084a:tests/test_api_contracts.py", "Not a parity claim; preserve final rejection diagnostics."],
  ["tv11-page-shadows", "TV11 page-based terrain shadowing", "P07", "intended-unverified", "design commits de6e014,5f27c21,779f94f,ef79523", "Design-only history remains outside the parity denominator."],
  ["automatic-dem-water", "Automatic DEM water detection", "T16", "historically-shipped-then-removed", "e6427c1", "Tombstone; explicit water masks remain T16."],
  ["hud", "HUD", "R10", "historically-shipped-then-removed", "771ba4f and 2af9223", "Use accessible DOM diagnostics rather than recreating the HUD."],
  ["rasterio-adapters", "Rasterio/xarray/Dask adapters", "T10", "historically-shipped-then-removed", "8065223 and f5ee458", "Observable COG/chunk/typed-array outcomes remain tracked without restoring Python adapters."],
  ["xyz-wmts-cartopy", "XYZ/WMTS/Cartopy adapters", "T11", "historically-shipped-then-removed", "8065223 and f5ee458", "Browser layer outcomes remain tracked without restoring Python adapters."],
  ["datashader", "Datashader adapter", "V01", "historically-shipped-then-removed", "8065223 and f5ee458", "Vector outcomes remain tracked without restoring the Python adapter."],
  ["svgf-hair-anisotropic", "Historical SVGF/hair/anisotropic experiments", "G11", "historically-shipped-then-removed", "2025 cleanup history", "Do not represent removed experiments as final public APIs."],
  ["python-native-packaging", "Python wheels/PyO3/NumPy/CMake delivery", "R12", "delivery-mechanism", "86daa089bcf8a13b1c67342e32cd8cfcae0a2f53", "Browser outcomes map to XC constraints; the native ABI is not emulated."],
  ["vshade-alias", "vshade Python compatibility re-export", "R12", "delivery-mechanism", "1f4084a:python/vshade/__init__.py", "Do not invent an npm namespace alias."],
  ["webgl-fallback", "WebGL fallback", "R01", "product-boundary", "current support matrix", "WebGPU browser execution remains the product boundary."],
  ["node-rendering", "Node rendering", "R11", "product-boundary", "current support matrix", "Node rendering remains outside the browser execution boundary."],
];

function addTombstones() {
  const result = [];
  for (const [id, title, capabilityId, lifecycle, evidence, disposition] of tombstoneSpecs) {
    const targetId = `target:tombstone:${id}`;
    const source = sourceForWorkingTree(planPath, 334, 348);
    addArtifact({ kind: "tombstone", layer: "tombstone-ledger", name: title, qualifiedName: id, source, details: { lifecycle, evidence, disposition }, classification: classified(capabilityId, `tombstone:${id}`, [], targetId) });
    result.push({ id, title, capabilityId, lifecycle, evidence: [evidence], disposition, targetId });
  }
  return result;
}

function fixture(id, ownerTasks, capabilityIds, provenance, parameters, tolerances, discrete, integrated) {
  const generator = { kind: "deterministic-contract-spec", version: "1", seed: 0, parameters };
  generator.sha256 = sha256(canonicalJson(generator));
  return {
    id,
    ownerTasks,
    capabilityIds,
    provenance,
    generator,
    tolerances,
    budgets: [
      { profileId: "reference-discrete", cpuBytes: discrete.cpuBytes, gpuBytes: discrete.gpuBytes, frameTimeP95Ms: discrete.frameTimeP95Ms, durationSeconds: discrete.durationSeconds },
      { profileId: "reference-integrated", cpuBytes: integrated.cpuBytes, gpuBytes: integrated.gpuBytes, frameTimeP95Ms: integrated.frameTimeP95Ms, durationSeconds: integrated.durationSeconds },
    ],
  };
}

function buildFixtureContracts() {
  const MiB = 1024 * 1024;
  return {
    schemaVersion: 1,
    fixtures: [
      fixture("dem-synthetic-v1", ["W03"], ["T01", "T02", "T03", "T04"], ["1f4084a:tests/test_dem_loading.py", "1f4084a:tests/test_terrain_analysis_api.py", "analytic 257x257 height field"], { width: 257, height: 257, expression: "sin(x/16)+cos(y/32)+0.001*x*y", nodataCells: [[0, 0], [128, 128]], spacingMeters: [30, 30] }, { scalarAbsRel: 1e-6, slopeAspectRadians: 1e-4, contourHausdorffCells: 0.25, aoSunMaxAbs: 0.02 }, { cpuBytes: 64 * MiB, gpuBytes: 128 * MiB, frameTimeP95Ms: 16.7, durationSeconds: 60 }, { cpuBytes: 64 * MiB, gpuBytes: 96 * MiB, frameTimeP95Ms: 33.3, durationSeconds: 60 }),
      fixture("terrain-material-v1", ["W04", "W07"], ["P01", "P02", "P03", "P04", "P05", "P06", "P07", "T05", "T06", "T07"], ["1f4084a:tests/golden/terrain/terrain_pbr.png", "1f4084a:tests/test_terrain_materials.py"], { width: 1024, height: 1024, materialToggles: ["pbr", "pom", "triplanar", "detail", "snow", "rock", "wetness", "subsurface"], lightPreset: "golden-noon" }, { ssimMinimum: 0.98, enabledPixelDeltaMinimum: 0.00392156862745098, attributeMaxAbs: 1e-5 }, { cpuBytes: 512 * MiB, gpuBytes: 2048 * MiB, frameTimeP95Ms: 16.7, durationSeconds: 600 }, { cpuBytes: 384 * MiB, gpuBytes: 1024 * MiB, frameTimeP95Ms: 33.3, durationSeconds: 600 }),
      fixture("clipmap-seam-v1", ["W08"], ["T08", "T09", "T10", "T11", "T14a", "T14b"], ["1f4084a:tests/test_clipmap_structure.py", "1f4084a:tests/test_geomorph_seams.py"], { virtualWidth: 16385, virtualHeight: 16385, ringCount: 8, tileSize: 256, overlayCount: 3 }, { budgetRelative: 0.05, crackPixels: 0.5, heightDiscontinuityRange: 1e-4, overlayDeterministic: true }, { cpuBytes: 1024 * MiB, gpuBytes: 3072 * MiB, frameTimeP95Ms: 16.7, durationSeconds: 600 }, { cpuBytes: 768 * MiB, gpuBytes: 1536 * MiB, frameTimeP95Ms: 33.3, durationSeconds: 600 }),
      fixture("volume-temporal-v1", ["W10", "W11"], ["T16", "T17", "P08", "P09", "P10", "P11", "P13", "P14", "P15"], ["1f4084a:tests/test_volumetrics_sky.py", "1f4084a:tests/test_taa_convergence.py"], { width: 1920, height: 1080, frames: 64, disocclusionFrame: 16, boundedVolume: [-10, -5, -10, 10, 20, 10] }, { ssimMinimum: 0.98, outsideVolumeMax: 0.00392156862745098, errorDecayEightFrames: 0.95, convergedFlickerMax: 0.00392156862745098 }, { cpuBytes: 768 * MiB, gpuBytes: 3072 * MiB, frameTimeP95Ms: 16.7, durationSeconds: 600 }, { cpuBytes: 512 * MiB, gpuBytes: 1536 * MiB, frameTimeP95Ms: 33.3, durationSeconds: 600 }),
      fixture("crs-epsg-v1", ["W14"], ["G01"], ["1f4084a:tests/test_crs_reproject.py", "EPSG:4326/EPSG:3857/EPSG:32632 published control points"], { geographicCrs: "EPSG:4326", projectedCrs: ["EPSG:3857", "EPSG:32632"], pointCount: 32, includesAxisOrderCases: true }, { geographicDegrees: 1e-7, projectedMeters: 0.01, roundTripMeters: 0.02, missingGridMustFail: true }, { cpuBytes: 256 * MiB, gpuBytes: 64 * MiB, frameTimeP95Ms: 16.7, durationSeconds: 60 }, { cpuBytes: 256 * MiB, gpuBytes: 64 * MiB, frameTimeP95Ms: 33.3, durationSeconds: 60 }),
      fixture("mesh-io-v1", ["W15"], ["G05a", "G05b", "G06", "G07", "G08"], ["1f4084a:tests/test_mesh_tbn.py", "1f4084a:tests/test_buildings_cityjson.py"], { primitives: ["cube", "plane", "tube", "ribbon", "extrusion"], formats: ["OBJ", "STL", "glTF", "GLB"], indexed: true }, { countsTopologyExact: true, attributeMaxAbs: 1e-5, boundsMaxAbs: 1e-5, hausdorffSceneDiagonal: 1e-5 }, { cpuBytes: 512 * MiB, gpuBytes: 1024 * MiB, frameTimeP95Ms: 16.7, durationSeconds: 120 }, { cpuBytes: 384 * MiB, gpuBytes: 768 * MiB, frameTimeP95Ms: 33.3, durationSeconds: 120 }),
      fixture("copc-ept-tiles-v1", ["W16"], ["G02", "G03", "G04"], ["1f4084a:tests/test_copc_laz_fixture.py", "1f4084a:tests/test_3dtiles_sse.py"], { pointCount: 1000000, hierarchyDepth: 8, cameraKeyframes: 64, formats: ["COPC", "EPT", "b3dm", "pnts"] }, { countsColorsSelectionsExact: true, boundsDatasetSpan: 1e-5, initialRangeFractionMax: 0.25, nonRangeBodyFetches: 0 }, { cpuBytes: 1536 * MiB, gpuBytes: 3072 * MiB, frameTimeP95Ms: 16.7, durationSeconds: 600 }, { cpuBytes: 1024 * MiB, gpuBytes: 2048 * MiB, frameTimeP95Ms: 33.3, durationSeconds: 600 }),
      fixture("trace-sdf-v1", ["W17"], ["G09", "G10", "G11"], ["1f4084a:tests/test_path_tracing_api.py", "1f4084a:tests/test_sdf_python.py"], { triangles: 65536, sdfPrimitives: 128, rays: 1048576, spp: [1, 4, 16, 64], seed: 1597463007 }, { hitIdsExact: true, fixedSeedHashesExact: true, rayParameterMaxAbs: 1e-5, barycentricMaxAbs: 1e-5, sdfSceneDiagonal: 1e-4, materialExact: true, ssimAt64Spp: 0.98 }, { cpuBytes: 1536 * MiB, gpuBytes: 4096 * MiB, frameTimeP95Ms: 16.7, durationSeconds: 600 }, { cpuBytes: 1024 * MiB, gpuBytes: 2048 * MiB, frameTimeP95Ms: 33.3, durationSeconds: 600 }),
      fixture("offline-denoise-v1", ["W06", "W22"], ["R02", "C05", "C06", "C07", "C08"], ["1f4084a:tests/test_tv12_offline_quality.py", "1f4084a:tests/test_exr_output.py"], { width: 1920, height: 1080, samples: [1, 4, 16, 64], aovs: ["color", "albedo", "normal", "depth", "id", "motion"], frames: 120 }, { floatColorAovMaxAbs: 1e-5, depthMaxAbs: 1e-6, denoiseSsimGainMin: 0.02, denoiseMseReductionMin: 0.2, convergedSsimRegressionMax: 0.005, nativeGoldenSsimMin: 0.98 }, { cpuBytes: 1536 * MiB, gpuBytes: 4096 * MiB, frameTimeP95Ms: 16.7, durationSeconds: 600 }, { cpuBytes: 1024 * MiB, gpuBytes: 2048 * MiB, frameTimeP95Ms: 33.3, durationSeconds: 600 }),
    ],
  };
}

function buildHardwareProfiles() {
  return {
    schemaVersion: 1,
    profiles: [
      {
        id: "reference-discrete",
        hardwareMatrixAssetId: "FW-LNX-NV-01",
        adapter: { name: "NVIDIA GeForce RTX 3070", vendor: "NVIDIA", architecture: "Ampere GA104", dedicatedMemory: "8 GiB" },
        driver: { name: "NVIDIA Linux x86_64", version: "580.82.09", api: "Vulkan 1.4.313" },
        os: { name: "Ubuntu", version: "24.04.3 LTS", build: "2025-08-07 amd64", kernel: "6.8.0-79-generic" },
        adapterBudgetBytes: 8589934592,
        effectiveBudgetBytes: 6442450944,
        requiredFeatures: ["timestamp-query", "texture-compression-bc"],
        viewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
        provenance: ["crates/forge3d-web/tests/infrastructure/hardware-matrix.json:FW-LNX-NV-01", "qualification baseline pinned by W00; each run must attest exact adapter/driver/OS before evidence is accepted"],
      },
      {
        id: "reference-integrated",
        hardwareMatrixAssetId: "FW-WIN-I12-01",
        adapter: { name: "Intel Iris Xe Graphics (Core i5-1240P)", vendor: "Intel", architecture: "Xe-LP Gen12.2", sharedMemory: "16 GiB" },
        driver: { name: "Intel Graphics Windows DCH", version: "32.0.101.6987", api: "Direct3D 12 feature level 12_1" },
        os: { name: "Windows 11 Pro", version: "25H2", build: "26200.6584", kernel: "Windows NT 10.0.26200.6584" },
        adapterBudgetBytes: 17179869184,
        effectiveBudgetBytes: 4294967296,
        requiredFeatures: ["shader-f16-or-fallback", "timestamp-query-or-cpu-fallback"],
        viewport: { width: 1920, height: 1080, devicePixelRatio: 1 },
        provenance: ["crates/forge3d-web/tests/infrastructure/hardware-matrix.json:FW-WIN-I12-01", "qualification baseline pinned by W00; each run must attest exact adapter/driver/OS before evidence is accepted"],
      },
    ],
  };
}

const npmSources = {
  harfbuzzjs: ["harfbuzzjs", "1.6.0", "MIT", "https://registry.npmjs.org/harfbuzzjs/-/harfbuzzjs-1.6.0.tgz", "c1e2c37480396d8d8721f909f2a7fce42153bbbc26cdd712c611d498311a2088", "sha512-fNnYg+CX5MBzckYZpqBJKs9qIVMH9vMhFNo9I81wp1QFu7jI3DOvtf1+VDwH4vsfnCylAFBNSX3gio9uNGPk/w==", ["W13", "W22"], ["1f4084a:tests/test_p1_typography_font_support.py"], []],
  "proj-wasm": ["proj-wasm", "0.1.0-alpha9", "MIT", "https://registry.npmjs.org/proj-wasm/-/proj-wasm-0.1.0-alpha9.tgz", "5e453ddded6fb5bebdbf89b29fd41779437a2040ac3ec9dc20c3e930774b26e2", "sha512-+UlFw7XxZD2jPelQUaNBOV5v3OB4VIFWgLhQCQniGkkzjBtVCIUpEwFJSinmfIPj1BvTEnOLOGBwZ5sVt1Ee8g==", ["W14", "W22"], ["1f4084a:tests/test_crs_reproject.py"], ["crs-epsg-v1"]],
  geotiff: ["geotiff", "3.0.5", "MIT", "https://registry.npmjs.org/geotiff/-/geotiff-3.0.5.tgz", "9b3628c4fd2357cddef76a511fc4df3c054ad3a2a9393a0d79797a052f888355", "sha512-OWcL9S9+yDZ6iAlXMt32T1iwUApJM8UiD47xbm6ZP1h33d10fqkPs14EG/ttT5EnefpZSx3G15iDFC5FxUNUwA==", ["W08", "W22"], ["1f4084a:tests/test_cog_streaming.py"], ["clipmap-seam-v1"]],
  "laz-perf": ["laz-perf", "0.0.7", "Apache-2.0", "https://registry.npmjs.org/laz-perf/-/laz-perf-0.0.7.tgz", "7585aa5e425443c639a2580548ebb8c3eed3124bacd7eebbf3ab0fbde2d8e0c4", "sha512-2xRqm/f/2UqDS5qqkjOyDb6uVIjkVw6SGmQlMoTQliVWkZhPfIbUJTubUl3mTloaWqKcjlS/urmP1CYoxelsEg==", ["W16", "W22"], ["1f4084a:tests/test_copc_laz_fixture.py"], ["copc-ept-tiles-v1"]],
  "ktx-parse": ["ktx-parse", "1.1.0", "MIT", "https://registry.npmjs.org/ktx-parse/-/ktx-parse-1.1.0.tgz", "9d4303bbd807faa4e0455f8115f6d75cee7036ec9d5160b6911363074d3ee003", "sha512-mKp3y+FaYgR7mXWAbyyzpa/r1zDWeaunH+INJO4fou3hb45XuNSwar+7llrRyvpMWafxSIi99RNFJ05MHedaJQ==", ["W04", "W22"], ["1f4084a:tests/test_mesh_tbn.py"], ["terrain-material-v1"]],
  mediabunny: ["mediabunny", "1.58.0", "MPL-2.0", "https://registry.npmjs.org/mediabunny/-/mediabunny-1.58.0.tgz", "15dc5b43638894812eb5801edd453a1d28febb260a7df957844d91912b55785c", "sha512-0jW6vSDVqWwNe3+WBryrMzC2mUBfk6E5KQLGXLdKVGzclceXXIsbayEkAsNDCuoTcoMiVI62sPDnkkFDxiMjGw==", ["W06", "W22"], ["1f4084a:tests/test_animation_mvp.py"], ["offline-denoise-v1"]],
  fflate: ["fflate", "0.8.3", "MIT", "https://registry.npmjs.org/fflate/-/fflate-0.8.3.tgz", "38c2cd824402407b43153c782274aec2ea83ea688e4aa0b743c5f2c305857d92", "sha512-tbZNuJrLwGUp3zshBtdy4W+ORxZuIh8a5ilyIEQDC5rY1f3U20JMry0Ll3WBzU58EZKsEuJFXhb5gwv8CsPvgA==", ["W19", "W22"], ["1f4084a:tests/test_bundle_roundtrip.py"], []],
  "pdf-lib": ["pdf-lib", "1.17.1", "MIT", "https://registry.npmjs.org/pdf-lib/-/pdf-lib-1.17.1.tgz", "a7cc1eaf12e41e612a7be581162a63b18118aefc01e90f6a1f35347b1f324a1c", "sha512-V/mpyJAoTsN4cnP31vc0wfNA1+p20evqqnap0KLoRUN0Yk/p3wN52DOEsL4oBFcLdb76hlpKPtzJIgo67j/XLw==", ["W20", "W22"], ["1f4084a:tests/test_export_projection.py"], []],
  "pdf-lib-fontkit": ["@pdf-lib/fontkit", "1.1.1", "MIT", "https://registry.npmjs.org/@pdf-lib/fontkit/-/fontkit-1.1.1.tgz", "6dd0ae9209fce419b2ed76c97166863167b4df56d75fbe3c7f1d1e6e49c85867", "sha512-KjMd7grNapIWS/Dm0gvfHEilSyAmeLvrEGVcqLGi0VYebuqqzTbgF29efCx7tvx+IEbG3zQciRSWl3GkUSvjZg==", ["W20", "W22"], ["1f4084a:tests/test_export_svg.py"], []],
  "noble-ed25519": ["@noble/ed25519", "3.2.0", "MIT", "https://registry.npmjs.org/@noble/ed25519/-/ed25519-3.2.0.tgz", "aaae5d6bc1aa92b798dc2017f2ff1f834f6d8a1e339fdc3e08915ec336006bd8", "sha512-criDgRlnUA09hchYrTy/JUWPIEap5rZxQe6wDWzRx51oWWpDRcUpuNzlgPxDJaOK6AsW9c0wKcj3rKRv6t+bPQ==", ["W21", "W22"], ["1f4084a:tests/test_license.py"], []],
};

function npmAsset(id, values) {
  const [packageName, version, license, uri, digest, integrity, consumingTasks, fixtureProvenance, manifestFixtureIds] = values;
  const risky = id === "proj-wasm" || id === "laz-perf";
  return {
    id,
    package: packageName,
    version,
    ecosystem: "npm",
    source: { uri, sha256: digest, integrity },
    license: { spdx: license, provenance: `registry package metadata and LICENSE content in ${packageName}@${version}`, review: `SPDX ${license} is compatible with Forge3D distribution when notices are retained` },
    build: { provenance: `immutable npm registry tarball ${packageName}@${version}`, toolchain: "npm 11 with package-lock integrity verification", flags: ["exact-version", "ignore-lifecycle-scripts-during-audit"], artifacts: [{ name: `${packageName}-${version}.tgz`, sha256: digest, sri: integrity }] },
    fixtureProvenance,
    ...(manifestFixtureIds.length ? { manifestFixtureIds } : {}),
    delivery: { mode: "bundled-self-hosted", cspRule: "Package code and WASM must be emitted under script-src 'self'; worker assets must use worker-src 'self'; no dependency CDN is permitted", sriRule: `Acquire only the registry tarball matching ${integrity}; emitted self-hosted assets retain a SHA-256 entry in the package asset manifest`, runtimeRemoteFetch: false },
    consumingTasks,
    consumerTokens: [packageName],
    review: {
      security: risky ? "Experimental dependency: fixture conformance, corrupt-input tests and a security review are mandatory before consumption" : "Run fixture conformance, corrupt-input tests and dependency advisory review before consumption",
      maintenance: risky ? "Experimental/maintenance-risk; substitution requires an ADR and the same fixtures" : "Exact version is frozen; substitution requires an ADR and the same fixtures",
      license: `Retain ${license} license text and notices in the published package`,
    },
  };
}

function buildDependencyLock() {
  const assets = Object.entries(npmSources).map(([id, values]) => npmAsset(id, values));
  assets.push({
    id: "basis-universal",
    package: "basis_universal",
    version: "2.0.3",
    ecosystem: "upstream-wasm",
    source: { uri: "https://codeload.github.com/BinomialLLC/basis_universal/tar.gz/refs/tags/v2_0_3", sha256: "eb9ac9ec933524b3c97720368b5cb423fa8767bfc409029d4864063e0d078bec", integrity: "git-commit-21fb6e242b1e425a7557c5655bb1b475f71933ca" },
    license: { spdx: "Apache-2.0", provenance: "LICENSE in basis_universal commit 21fb6e242b1e425a7557c5655bb1b475f71933ca", review: "Apache-2.0 notice and attribution must ship with the WASM/JS pair" },
    build: { provenance: "upstream checked-in webgl/transcoder/build artifacts at commit 21fb6e242b1e425a7557c5655bb1b475f71933ca; locally rebuilt output is rejected unless an ADR pins an Emscripten toolchain", toolchain: "upstream Emscripten WebGL transcoder build, artifact-locked", flags: ["single-threaded", "webgl-transcoder", "no-runtime-cdn"], artifacts: [{ name: "basis_transcoder.js", sha256: "697ab2b61e257f4e62e68bb021bd667d7e5c2bef9fa359600b76804f52f26a80", sri: "sha384-prKJ+b7t+CEoKkHut7HYRUZ1Jye8M+e/1b6QGseIm98QtLNX9G48aBCyYT3jP8IH" }, { name: "basis_transcoder.wasm", sha256: "5139f8299b2c4ff691877e2e8809fabdd64d029af061bbb95d8ea8d1acabd522", sri: "sha384-IzrxHljMzPSJUYnPQfAp46lGBIDE9h02UUF0W0WQqHY+Q65k+weklhRFX/FlxqWL" }] },
    fixtureProvenance: ["1f4084a:src/loaders/ktx2", "1f4084a:tests/test_mesh_tbn.py"],
    manifestFixtureIds: ["terrain-material-v1"],
    delivery: { mode: "bundled-self-hosted-wasm", cspRule: "Serve JS/WASM from 'self' with application/wasm; script-src 'self'; connect-src 'self'; no CDN fallback", sriRule: "Both checked-in upstream artifacts must match the recorded SHA-256 and SHA-384 values before packaging", runtimeRemoteFetch: false },
    consumingTasks: ["W04", "W22"],
    consumerTokens: ["basis_universal", "basis_transcoder.wasm", "basis_transcoder.js"],
    review: { security: "Run KTX2 corrupt-input and decompression-bound tests before consumption", maintenance: "Exact upstream commit and artifacts are frozen; substitution requires an ADR and the same fixtures", license: "Retain Apache-2.0 license and notices" },
  });
  assets.push({
    id: "exr",
    package: "exr",
    version: "1.74.2",
    ecosystem: "crates.io",
    source: { uri: "https://static.crates.io/crates/exr/exr-1.74.2.crate", sha256: "711fe42c9964295e01ee3fba3f9fe0e1d24b98886950d68efe81b1c76e21adf3", integrity: "sha256-711fe42c9964295e01ee3fba3f9fe0e1d24b98886950d68efe81b1c76e21adf3" },
    license: { spdx: "BSD-3-Clause", provenance: "crates.io metadata and LICENSE.md in exr 1.74.2", review: "BSD-3-Clause notice must ship with the WASM package" },
    build: { provenance: "crates.io source compiled by the workspace for wasm32-unknown-unknown", toolchain: "Rust >=1.83.0, workspace stable toolchain", flags: ["--no-default-features", "default-rayon-disabled", "--target=wasm32-unknown-unknown"], artifacts: [{ name: "exr-1.74.2.crate", sha256: "711fe42c9964295e01ee3fba3f9fe0e1d24b98886950d68efe81b1c76e21adf3", sri: "sha256-711fe42c9964295e01ee3fba3f9fe0e1d24b98886950d68efe81b1c76e21adf3" }] },
    fixtureProvenance: ["1f4084a:tests/test_exr_output.py"],
    manifestFixtureIds: ["offline-denoise-v1"],
    delivery: { mode: "compiled-into-self-hosted-wasm", cspRule: "Only the Forge3D self-hosted WASM module is loaded; connect-src and script-src remain 'self'", sriRule: "Cargo source checksum and final Forge3D WASM package digest must both match their locks", runtimeRemoteFetch: false },
    consumingTasks: ["W06", "W22"],
    consumerTokens: ["exr =", "exr::"],
    review: { security: "Run malformed EXR, dimension-limit and allocation-bound tests before consumption", maintenance: "Default rayon remains disabled for WASM; version substitution requires an ADR and the same fixtures", license: "Retain BSD-3-Clause license text" },
  });
  assets.sort((left, right) => requiredDependencyIds.indexOf(left.id) - requiredDependencyIds.indexOf(right.id));
  return { schemaVersion: 1, lockId: "forge3d-parity-dependencies-v1", policy: "Every lock-controlled codec, shaping, projection, archive, document, video or cryptographic asset is exact-version and exact-digest pinned. Substitution requires an ADR, license/security review and the same fixture suite.", assets };
}

function countRecords() {
  return Object.fromEntries([...new Set(records.map((record) => record.kind))].sort().map((kind) => [kind, records.filter((record) => record.kind === kind).length]));
}

function writeJson(path, value) {
  const absolute = join(repositoryRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  writeFileSync(absolute, bytes);
  return { path, sha256: sha256(bytes), bytes };
}

function main() {
  for (const commit of Object.values(commits)) git(["cat-file", "-e", `${commit}^{commit}`]);
  const planText = readFileSync(join(repositoryRoot, planPath), "utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const rows = parsePlan(planText);
  const capabilities = rows.filter((row) => row.lifecycle !== "XC");
  const constraints = rows.filter((row) => row.lifecycle === "XC");
  if (capabilities.length !== 84 || constraints.length !== 7) throw new Error(`expected 84 capabilities and 7 constraints, got ${capabilities.length}/${constraints.length}`);

  addPackageRootExports();
  addPyo3Registrations();
  const sceneMethods = addSceneMethods();
  addPythonApi();
  addNativeTests();
  addNativeExamples();
  addNativeDocs();
  addChangelog();
  addModuleRoots();
  addBrowserBaseline();
  const tombstones = addTombstones();

  const inventory = { schemaVersion: 1, sourceDate: "2026-09-20", records: records.sort((left, right) => left.id.localeCompare(right.id)), counts: countRecords() };
  const fixtureContracts = buildFixtureContracts();
  const hardwareProfiles = buildHardwareProfiles();
  const dependencyLock = buildDependencyLock();
  const inventoryFile = writeJson("crates/forge3d-web/tests/parity/composite-inventory.json", inventory);
  const fixtureFile = writeJson("crates/forge3d-web/tests/parity/fixture-contracts.json", fixtureContracts);
  const hardwareFile = writeJson("crates/forge3d-web/tests/parity/hardware-profiles.json", hardwareProfiles);
  const dependencyFile = writeJson("docs/parity/dependency-lock.json", dependencyLock);

  const targetRows = [...capabilities, ...constraints].map((row) => ({
    id: row.targetId,
    capabilityId: row.id,
    kind: row.lifecycle === "XC" || equivalentCapabilityIds.has(row.id) ? "equivalent" : "web-api",
    contract: row.requiredWebOutcome,
    owner: row.ownerTask,
    evidence: row.status === "I" ? [`current browser baseline and ${planPath}:${row.id}`] : [`tracked ${row.status} closure state in ${planPath}:${row.id}`],
    tests: row.requiredTests,
  }));
  const tombstoneTargets = tombstones.map((item) => ({ id: item.targetId, capabilityId: item.capabilityId, kind: "tombstone", contract: item.disposition, owner: capabilities.find((row) => row.id === item.capabilityId)?.ownerTask ?? "W00", evidence: item.evidence, tests: [`W00 tombstone ledger contract for ${item.id}`] }));
  const manifest = {
    $schema: "./schema.json",
    schemaVersion: 1,
    manifestId: "forge3d-composite-baseline-v1",
    sourcePlan: { path: planPath, sha256: sha256(Buffer.from(planText, "utf8")) },
    baselineLayers: [
      { id: "deep-native", commit: commits.deepNative, tree: git(["rev-parse", `${commits.deepNative}^{tree}`]).trim(), role: "Deepest compiled monolithic native semantics; earlier release evidence remains authoritative where behavior predates this snapshot", evidenceGrades: ["A", "B", "C", "D"], supportingCommits: [commits.release] },
      { id: "reconciliation", commit: commits.reconciliation, tree: git(["rev-parse", `${commits.reconciliation}^{tree}`]).trim(), role: "Post-split compatibility reconciliation, complete native tests/examples/docs and named restoration surface", evidenceGrades: ["A", "B", "C", "D"], supportingCommits: [] },
      { id: "final-contract", commit: commits.finalContract, tree: git(["rev-parse", `${commits.finalContract}^{tree}`]).trim(), role: "Normative final package-root exports, PyO3 registrations, signatures and diagnostics immediately before native deletion", evidenceGrades: ["B", "C", "D"], supportingCommits: [] },
      { id: "browser-baseline", commit: commits.browserBaseline, tree: git(["rev-parse", `${commits.browserBaseline}^{tree}`]).trim(), role: "Browser-only APIs, lifecycle behavior, tests, package evidence and support infrastructure retained by parity work", evidenceGrades: ["A", "B", "C", "D"], supportingCommits: [] },
    ],
    counts: {
      capabilities: 84,
      constraints: 7,
      packageRootExports: 220,
      registeredClasses: 28,
      registeredFunctions: 44,
      sceneMethods,
      pythonApiFiles: 72,
      nativeTestFiles: 211,
      namedNativeTestFiles: 191,
      nativeTestDefinitions: 1792,
      nativeExamples: 54,
      nativeDocumentationAssets: 88,
      nativeDocumentationPages: 53,
      browserDeclarations: 26,
      browserUnitFiles: 12,
      browserUnitCases: 80,
      browserPlaywrightSpecs: 14,
      browserPlaywrightLiteralCases: 38,
      browserPlaywrightGeneratedCases: 39,
      browserApiArtifacts: 6,
      browserHtmlFixtures: 7,
    },
    capabilities,
    constraints,
    webTargets: [...targetRows, ...tombstoneTargets],
    tombstones,
    inventorySources: [
      { kind: "composite-inventory", path: inventoryFile.path, sha256: inventoryFile.sha256, recordCount: inventory.records.length },
      { kind: "fixture-contracts", path: fixtureFile.path, sha256: fixtureFile.sha256, recordCount: fixtureContracts.fixtures.length },
      { kind: "hardware-profiles", path: hardwareFile.path, sha256: hardwareFile.sha256, recordCount: hardwareProfiles.profiles.length },
    ],
    mappings: mappings.sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
    requiredFixtureIds,
    requiredHardwareProfileIds,
    dependencyLock: { path: dependencyFile.path, sha256: dependencyFile.sha256, requiredAssetIds: requiredDependencyIds },
  };
  writeJson("docs/parity/forge3d-composite-baseline.json", manifest);
  const releaseMetadataChangelog = mappings.filter((mapping) => mapping.classificationRule === "changelog:release-engineering-metadata").length;
  console.log(JSON.stringify({ ok: true, artifactCount: records.length, mappingCount: mappings.length, sceneMethods, unresolvedClassifications: 0, releaseMetadataChangelog, counts: inventory.counts }, null, 2));
}

main();
