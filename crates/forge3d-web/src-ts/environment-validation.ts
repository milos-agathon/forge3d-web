import type {
  EnvironmentInput,
  EnvironmentSnapshot,
  DensityVolumeInput,
  WaterLayerInput,
} from "./environment-types.js";
import { num, fail, vec, rgb, choice } from "./environment-input.js";
import { sunPosition } from "./sun-position.js";
export function normalizeEnvironment(
  input: EnvironmentInput | EnvironmentSnapshot,
): EnvironmentSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("environment must be an object");
  for (const key of ["sky", "fog", "clouds", "sun", "sunClock"] as const) {
    const v = (input as EnvironmentInput)[key];
    if (v != null && (typeof v !== "object" || Array.isArray(v)))
      fail(`${key} must be an object`);
  }
  if (input.volumes !== undefined && !Array.isArray(input.volumes))
    fail("volumes must be an array");
  if (input.water !== undefined && !Array.isArray(input.water))
    fail("water must be an array");
  const q = "quality" in input ? (input.quality ?? "medium") : "medium";
  choice(q, ["low", "medium", "high", "ultra"], "quality");
  const sky =
    input.sky == null
      ? null
      : {
          model: choice(
            input.sky.model ?? "hosek-wilkie",
            ["preetham", "hosek-wilkie"],
            "sky model",
          ),
          turbidity: num(input.sky.turbidity ?? 2, 1, 10, "turbidity"),
          groundAlbedo: num(input.sky.groundAlbedo ?? 0.3, 0, 1, "albedo"),
          sunSize: num(input.sky.sunSize ?? 1, 0, 100, "sun size"),
          exposure: num(input.sky.exposure ?? 1, 0, 100, "exposure"),
          sunIntensity: num(input.sky.sunIntensity ?? 1, 0, 1000, "sky sun intensity"),
          aerialPerspective: input.sky.aerialPerspective ?? true,
          aerialDensity: num(input.sky.aerialDensity ?? 1, 0, 100, "aerial density"),
        };
  const fog =
    input.fog == null
      ? null
      : {
          mode: choice(
            input.fog.mode ?? "uniform",
            ["uniform", "height", "exponential"],
            "fog mode",
          ),
          scattering: num(input.fog.scattering ?? 0.5, 0, 1, "scattering"),
          absorption: num(input.fog.absorption ?? 0.1, 0, 1, "absorption"),
          density: num(input.fog.density ?? 0.01, 0, 100, "fog density"),
          height: num(input.fog.height ?? 0, -1e7, 1e7, "fog height"),
          falloff: num(input.fog.falloff ?? 0.1, 0, 100, "fog falloff"),
          color: rgb(input.fog.color ?? [0.6, 0.7, 0.8], "fog color"),
          anisotropy: num(
            input.fog.anisotropy ?? 0,
            -1,
            1,
            "fog anisotropy",
          ),
          godRays: input.fog.godRays ?? false,
          shaftIntensity: num(input.fog.shaftIntensity ?? 1, 0, 10, "shaft intensity"),
          shaftSamples: num(input.fog.shaftSamples ?? 32, 8, 128, "shaft samples"),
          useShadows: input.fog.useShadows ?? true,
        };
  if (sky && typeof sky.aerialPerspective !== "boolean") fail("aerialPerspective must be boolean");
  if (fog && (typeof fog.godRays !== "boolean" || typeof fog.useShadows !== "boolean" || !Number.isInteger(fog.shaftSamples))) fail("invalid shaft controls");
  const c = input.clouds;
  const preset = c && "preset" in c ? (c.preset ?? "moderate") : "moderate";
  choice(preset, ["static", "gentle", "moderate", "stormy"], "cloud preset");
  const speed = { static: 0, gentle: 0.2, moderate: 0.5, stormy: 1.2 }[preset];
  const clouds =
    c == null
      ? null
      : {
          renderPath: choice(c.renderPath ?? "world", ["native", "world"], "cloud render path"),
          color: rgb(c.color ?? [0.6, 0.8, 1], "cloud color"),
          scatterStrength: num(
            c.scatterStrength ?? 1.2,
            0,
            100,
            "cloud scatter strength",
          ),
          mode: choice(
            c.mode ?? "hybrid",
            ["billboard", "volumetric", "hybrid"],
            "cloud mode",
          ),
          density: num(c.density ?? 0.8, 0, 100, "cloud density"),
          coverage: num(c.coverage ?? 0.6, 0, 1, "coverage"),
          scale: num(c.scale ?? 200, 0.001, 1e7, "cloud scale"),
          height: num(c.height ?? 150, -1e7, 1e7, "cloud height"),
          thickness: num(c.thickness ?? 80, 0.001, 1e7, "cloud thickness"),
          wind: vec(c.wind ?? [speed, 0], 2, "cloud wind") as [number, number],
          animationSpeed: num(c.animationSpeed ?? { static: 0, gentle: 0.3, moderate: 0.8, stormy: 2 }[preset], 0, 100, "animation speed"),
          seed: num(c.seed ?? 0, 0, 4294967295, "seed"),
          shadowStrength: num(
            c.shadowStrength ?? 0.5,
            0,
            1,
            "cloud shadow strength",
          ),
          absorption: num(c.absorption ?? 0.8, 0, 100, "absorption"),
          anisotropy: num(c.anisotropy ?? 0.3, -1, 1, "cloud anisotropy"),
          ambient: num(c.ambient ?? 0.4, 0, 100, "ambient"),
          fadeDistance: num(
            c.fadeDistance ?? 1000,
            0.001,
            1e7,
            "fade distance",
          ),
        };
  if (clouds && !Number.isInteger(clouds.seed))
    fail("cloud seed must be integer");
  const volumes = (input.volumes ?? []).map((v) => {
    const bounds = vec(
      v.bounds,
      6,
      "volume bounds",
    ) as DensityVolumeInput["bounds"];
    if ([0, 1, 2].some((i) => bounds[i]! >= bounds[i + 3]!))
      fail("empty volume bounds");
    const dimensions = vec(
      v.dimensions ?? [1, 1, 1],
      3,
      "volume dimensions",
    ) as [number, number, number];
    if (dimensions.some((x) => !Number.isInteger(x) || x < 1))
      fail("volume dimensions");
    const count = dimensions.reduce((a, b) => a * b, 1);
    if (count > 2097152) fail("volume exceeds voxel budget");
    const data = Array.from(v.data ?? [1]);
    if (data.length !== count) fail("volume data length");
    data.forEach((x) => num(x, 0, 1, "volume sample"));
    return {
      bounds,
      dimensions,
      data,
      density: num(v.density ?? 0.01, 0, 100, "volume density"),
      color: rgb(v.color ?? [0.8, 0.8, 0.8], "volume color"),
      anisotropy: num(v.anisotropy ?? 0, -1, 1, "volume anisotropy"),
    };
  });
  if (
    volumes.length > 8 ||
    volumes.reduce((a, v) => a + v.data.length, 0) > 2097152
  )
    fail("volume budget");
  const water = (input.water ?? []).map((w) => {
    const bounds = vec(
      w.bounds,
      4,
      "water bounds",
    ) as WaterLayerInput["bounds"];
    if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) fail("water bounds");
    const maskDimensions = vec(
      w.maskDimensions ?? [1, 1],
      2,
      "mask dimensions",
    ) as [number, number];
    if (maskDimensions.some((x) => !Number.isInteger(x) || x < 1))
      fail("mask dimensions");
    const count = maskDimensions[0] * maskDimensions[1];
    if (count > 2097152) fail("water mask budget");
    const mask = Array.from(w.mask ?? [1]);
    if (mask.length !== count) fail("water mask length");
    mask.forEach((x) => num(x, 0, 1, "water mask"));
    return {
      bounds,
      height: num(w.height ?? 0, -1e7, 1e7, "water height"),
      terrainMask: w.terrainMask ?? false,
      foamNoiseScale: num(w.foamNoiseScale ?? 20, 1, 1e5, "foam noise scale"),
      mode: choice(w.mode ?? "transparent", ["disabled", "transparent", "reflective", "animated"], "water mode"),
      fresnelPower: num(w.fresnelPower ?? 5, 0.01, 100, "fresnel power"),
      hueShift: num(w.hueShift ?? 0, -100, 100, "hue shift"),
      tintColor: rgb(w.tintColor ?? [0, 0.8, 1], "tint color"),
      tintStrength: num(w.tintStrength ?? 0, 0, 1, "tint strength"),
      rippleScale: num(w.rippleScale ?? 0, 0, 1e5, "ripple scale"),
      rippleSpeed: num(w.rippleSpeed ?? 0.5, -1e5, 1e5, "ripple speed"),
      refractionStrength: num(w.refractionStrength ?? 0, 0, 1, "refraction strength"),
      shoreAttenuationWidth: num(w.shoreAttenuationWidth ?? 0.3, 0, 1e7, "shore attenuation width"),
      waveDistortionStrength: num(w.waveDistortionStrength ?? 0.02, 0, 100, "wave distortion strength"),
      shallowColor: rgb(w.shallowColor ?? [0.1, 0.3, 0.5], "shallow color"),
      deepColor: rgb(w.deepColor ?? [0.02, 0.08, 0.2], "deep color"),
      depthScale: num(w.depthScale ?? 10, 0.001, 1e7, "depth scale"),
      alpha: num(w.alpha ?? 0.8, 0, 1, "water alpha"),
      waveAmplitude: num(w.waveAmplitude ?? 0.05, 0, 1e5, "wave amplitude"),
      waveFrequency: num(w.waveFrequency ?? 3, 0, 1e5, "wave frequency"),
      waveSpeed: num(w.waveSpeed ?? 0.5, -1e5, 1e5, "wave speed"),
      flow: vec(w.flow ?? [1, 0], 2, "flow") as [number, number],
      roughness: num(w.roughness ?? 0.1, 0, 1, "water roughness"),
      reflection: choice(
        w.reflection ?? "sky",
        ["sky", "screen", "planar"],
        "reflection",
      ),
      reflectionStrength: num(
        w.reflectionStrength ?? 0.6,
        0,
        1,
        "reflection strength",
      ),
      foamWidth: num(w.foamWidth ?? 1, 0, 1e7, "foam width"),
      foamIntensity: num(w.foamIntensity ?? 0.5, 0, 1, "foam intensity"),
      maskDimensions,
      mask,
    };
  });
  if (water.some(w => typeof w.terrainMask !== "boolean")) fail("terrainMask must be boolean");
  if (water.filter(w => w.terrainMask).length > 1) fail("at most one masked-terrain reflection layer");
  if (water.length > 4) fail("at most four water layers");
  const sun =
    "sun" in input && input.sun
      ? sunPosition(input.sun.latitude, input.sun.longitude, input.sun.utc)
      : undefined;
  const d = vec(
    sun?.direction ?? input.sunDirection ?? [0.3, 0.7, 0.2],
    3,
    "sun direction",
  );
  const length = Math.hypot(...d);
  if (length < 1e-6) fail("sun direction cannot be zero");
  const si = "sun" in input ? input.sun : undefined;
  const steps = num(
    input.steps ?? { low: 16, medium: 32, high: 64, ultra: 128 }[q],
    8,
    128,
    "steps",
  );
  if (!Number.isInteger(steps)) fail("steps must be integer");
  const sunClock = si
    ? {
        latitude: si.latitude,
        longitude: si.longitude,
        unixSeconds:
          new Date(si.utc.endsWith("Z") ? si.utc : si.utc + "Z").getTime() /
          1000,
        timeScale: si.timeScale ?? 1,
      }
    : (input.sunClock ?? null);
  if (sunClock) {
    num(sunClock.latitude, -1e9, 1e9, "latitude");
    num(sunClock.longitude, -1e9, 1e9, "longitude");
    num(sunClock.unixSeconds, -8.64e12, 8.64e12, "sun epoch");
    num(sunClock.timeScale, -1e8, 1e8, "sun timeScale");
  }
  return {
    sunClock: structuredClone(sunClock),
    sky,
    fog,
    clouds,
    volumes,
    water,
    sunDirection: d.map((x) => x / length) as [number, number, number],
    sunColor: rgb(si?.color ?? input.sunColor ?? [1, 0.95, 0.85], "sun color"),
    sunIntensity: num(
      si?.intensity ?? input.sunIntensity ?? 1,
      0,
      1000,
      "sun intensity",
    ),
    resolutionScale:
      ([0.5, 1].includes(input.resolutionScale ?? 0.5)
        ? input.resolutionScale
        : fail("resolutionScale must be 0.5 or 1")) ??
      (q === "low" || q === "medium" ? 0.5 : 1),
    steps,
    volumetricMode: choice(
      input.volumetricMode ?? "raymarch",
      ["raymarch", "froxel"],
      "volumetric mode",
    ),
    temporalWeight: num(input.temporalWeight ?? 0, 0, 0.95, "temporal weight"),
    maxDistance: num(input.maxDistance ?? 10000, 0.01, 1e7, "max distance"),
    debug: choice(
      input.debug ?? "none",
      ["none", "transmittance", "clouds", "water-mask", "foam", "reflection"],
      "debug",
    ),
  };
}
