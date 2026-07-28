import { createHash } from "node:crypto";

export function canonicalJson(value) {
  return serialize(value);
}

export function canonicalJsonBytes(value) {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function sha256Hex(value) {
  const bytes =
    typeof value === "string" || Buffer.isBuffer(value)
      ? value
      : canonicalJsonBytes(value);
  return createHash("sha256").update(bytes).digest("hex");
}

function serialize(value) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON does not permit non-finite numbers");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        if (value[key] === undefined) {
          throw new TypeError(`canonical JSON property ${key} is undefined`);
        }
        return `${JSON.stringify(key)}:${serialize(value[key])}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot serialize ${typeof value}`);
}
