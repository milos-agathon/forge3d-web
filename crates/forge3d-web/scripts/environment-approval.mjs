export function selectEnvironmentApprovals({ approvals, environment }) {
  if (
    !Array.isArray(approvals) ||
    !/^[A-Za-z0-9_.-]+$/u.test(environment ?? "")
  ) {
    throw new Error("environment approval input is invalid");
  }
  const selected = [];
  for (const approval of approvals) {
    if (approval?.state !== "approved") continue;
    const environments = approval.environments;
    if (!Array.isArray(environments)) continue;
    const intended = environments.filter((value) => value?.name === environment);
    if (intended.length > 0 && environments.length !== 1) {
      throw new Error(`approval mixes ${environment} with another environment`);
    }
    if (intended.length === 0) continue;
    const [deploymentEnvironment] = intended;
    if (
      !Number.isInteger(approval.user?.id) ||
      approval.user.id < 1 ||
      typeof approval.user?.login !== "string" ||
      approval.user.login.length < 1 ||
      !Number.isInteger(deploymentEnvironment.id) ||
      deploymentEnvironment.id < 1
    ) {
      throw new Error("intended environment approval provenance is incomplete");
    }
    selected.push({
      state: "approved",
      user: { id: approval.user.id, login: approval.user.login },
      environment: {
        id: deploymentEnvironment.id,
        name: deploymentEnvironment.name,
      },
    });
  }
  if (selected.length < 1) {
    throw new Error(`no approval exists for environment ${environment}`);
  }
  return selected;
}

export function selectIndependentEnvironmentApprovals({
  actor,
  implementationActors,
  approvals,
  environment,
}) {
  const selected = selectEnvironmentApprovals({ approvals, environment });
  const normalizedActor = actor?.toLowerCase();
  const normalizedImplementationActors = new Set(
    implementationActors.map((value) => value.toLowerCase()),
  );
  if (
    !actor ||
    normalizedImplementationActors.has(normalizedActor) ||
    selected.some(
      (approval) =>
        approval.user.login.toLowerCase() === normalizedActor ||
        normalizedImplementationActors.has(approval.user.login.toLowerCase()),
    )
  ) {
    throw new Error("publisher and every intended-environment approval must be independent");
  }
  return selected;
}
