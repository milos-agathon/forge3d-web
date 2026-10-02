import type { SunPosition } from "./environment-types.js";
import { num, fail } from "./environment-input.js";
const rad = Math.PI / 180;
/** Native NOAA ephemeris, UTC only. Native convention: east is -X, north is -Z. */
export function sunPosition(
  latitude: number,
  longitude: number,
  utc: string,
): SunPosition {
  num(latitude, -1e9, 1e9, "latitude");
  num(longitude, -1e9, 1e9, "longitude");
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z?$/.test(utc))
    fail("sun utc requires YYYY-MM-DDTHH:MM:SS[Z]");
  const canonical = utc.endsWith("Z") ? utc : utc + "Z";
  const date = new Date(canonical);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 19) !== canonical.slice(0, 19)
  )
    fail("invalid UTC calendar date");
  const lat = Math.max(-90, Math.min(90, latitude)) * rad;
  const lon = Math.max(-180, Math.min(180, longitude));
  const t = (date.getTime() / 86400000 + 2440587.5 - 2451545) / 36525;
  const l0 = (280.46646 + t * (36000.76983 + 0.0003032 * t)) % 360;
  const m = (357.52911 + t * (35999.05029 - 0.0001537 * t)) * rad;
  const ecc = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const center =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289;
  const lambda =
    (l0 +
      center -
      0.00569 -
      0.00478 * Math.sin((125.04 - 1934.136 * t) * rad)) *
    rad;
  const e =
    (23 +
      (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60 +
      0.00256 * Math.cos((125.04 - 1934.136 * t) * rad)) *
    rad;
  const decl = Math.asin(Math.sin(e) * Math.sin(lambda));
  const y = Math.tan(e / 2) ** 2;
  const eq =
    ((y * Math.sin(2 * l0 * rad) -
      2 * ecc * Math.sin(m) +
      4 * ecc * y * Math.sin(m) * Math.cos(2 * l0 * rad) -
      0.5 * y * y * Math.sin(4 * l0 * rad) -
      1.25 * ecc * ecc * Math.sin(2 * m)) /
      rad) *
    4;
  const minute =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60000;
  const ha =
    (((((minute + eq + 4 * lon) % 1440) + 1440) % 1440) / 4 - 180) * rad;
  const zenith = Math.acos(
    Math.max(
      -1,
      Math.min(
        1,
        Math.sin(lat) * Math.sin(decl) +
          Math.cos(lat) * Math.cos(decl) * Math.cos(ha),
      ),
    ),
  );
  const numerator = Math.sin(lat) * Math.cos(zenith) - Math.sin(decl);
  const denominator = Math.cos(lat) * Math.sin(zenith);
  const az =
    Math.acos(
      Math.abs(denominator) < 1e-10
        ? numerator >= 0
          ? 1
          : -1
        : Math.max(-1, Math.min(1, numerator / denominator)),
    ) / rad;
  const azimuth = (ha > 0 ? az + 180 : 540 - az) % 360;
  const elevation = 90 - zenith / rad;
  return {
    azimuth,
    elevation,
    direction: [
      -Math.sin(azimuth * rad) * Math.cos(elevation * rad),
      Math.sin(elevation * rad),
      -Math.cos(azimuth * rad) * Math.cos(elevation * rad),
    ],
    daytime: elevation > 0,
  };
}
