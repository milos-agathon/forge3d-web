export type EvidenceMode = "required" | "probe";

export function resolveEvidenceMode(value: string | undefined): EvidenceMode {
  const mode = value ?? "required";
  if (mode !== "required" && mode !== "probe") {
    throw new Error("evidence mode must be either required or probe");
  }
  return mode;
}
