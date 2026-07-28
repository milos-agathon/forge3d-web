export function resolvePackageGateMode(
  value = process.env.FORGE3D_PACKAGE_GATE_MODE,
) {
  const mode = value ?? "required";
  if (mode !== "required" && mode !== "probe") {
    throw new Error(
      "FORGE3D_PACKAGE_GATE_MODE must be either required or probe",
    );
  }
  return mode;
}
