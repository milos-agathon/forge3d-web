const allowedPlatforms = new Set(["darwin", "linux", "win32"]);

export function bindReviewedHelperDigests({ policy, helpers, platform }) {
  assertExactKeys(policy, [
    "schemaVersion",
    "provisioningState",
    "requiredIdentities",
    "allowlist",
  ]);
  if (
    policy.schemaVersion !== 1 ||
    !allowedPlatforms.has(platform) ||
    !Array.isArray(policy.requiredIdentities) ||
    !Array.isArray(policy.allowlist) ||
    new Set(policy.requiredIdentities).size !== policy.requiredIdentities.length ||
    policy.requiredIdentities.some(
      (identity) => !/^FORGE3D_[A-Z0-9_]+$/u.test(identity),
    ) ||
    [...policy.requiredIdentities].sort().some(
      (identity, index) => identity !== policy.requiredIdentities[index],
    )
  ) {
    throw new Error("controller helper digest policy is invalid");
  }
  const external = helpers.filter((helper) => helper.packagePath === null);
  const identities = [...new Set(external.map((helper) => helper.identity))].sort();
  if (
    identities.length !== external.length ||
    identities.length !== policy.requiredIdentities.length ||
    identities.some((identity, index) => identity !== policy.requiredIdentities[index])
  ) {
    throw new Error("controller helper digest policy does not close required identities");
  }
  const tuples = new Set();
  for (const entry of policy.allowlist) {
    assertExactKeys(entry, ["identity", "platform", "version", "sha256"]);
    const tuple = `${entry.identity}\0${entry.platform}\0${entry.version ?? ""}`;
    if (
      !policy.requiredIdentities.includes(entry.identity) ||
      !allowedPlatforms.has(entry.platform) ||
      (entry.version !== null &&
        (typeof entry.version !== "string" || entry.version.length === 0)) ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256 ?? "") ||
      tuples.has(tuple)
    ) {
      throw new Error("controller helper digest allowlist is invalid");
    }
    tuples.add(tuple);
  }
  if (policy.provisioningState !== "active") {
    throw new Error("controller helper digest policy is not active");
  }
  return helpers.map((helper) => {
    if (helper.packagePath !== null) return { ...helper };
    const matches = policy.allowlist.filter(
      (entry) =>
        entry.identity === helper.identity &&
        entry.platform === platform &&
        entry.version === helper.version,
    );
    if (matches.length !== 1) {
      throw new Error(
        `controller helper ${helper.identity} lacks one reviewed digest`,
      );
    }
    return { ...helper, sha256: matches[0].sha256 };
  });
}

function assertExactKeys(value, expected) {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error("controller helper digest policy contains unreviewed fields");
  }
}
