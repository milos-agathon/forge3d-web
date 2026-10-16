// Exact hashes are opt-in because WebGPU arithmetic varies by adapter/driver.
export function checkPreservationProfile(contract, requested, observed) {
  if (!requested) return false;
  const profile = contract.profile;
  if (requested !== profile?.id) throw new Error(`Unknown W10 pinned hash profile: ${requested}`);
  for (const key of ["platform", "browser"]) {
    if (observed[key] !== profile[key]) throw new Error(`W10 pinned hash profile ${key} mismatch: ${observed[key]}`);
  }
  for (const [key, value] of Object.entries(profile.adapter)) {
    if (observed.adapter[key] !== value) throw new Error(`W10 pinned hash profile adapter ${key} mismatch: ${observed.adapter[key]}`);
  }
  return true;
}
