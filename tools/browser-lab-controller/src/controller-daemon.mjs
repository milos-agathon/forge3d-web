import { resolveAuthorizationForQueuedJob } from "./authorization-source.mjs";

export async function pollControllerOnce({
  hostId,
  expectedHardwareLabel,
  github,
  controller,
  inFlight = new Set(),
  now = new Date(),
  audit = defaultAudit,
}) {
  const runs = await github.listCandidateRuns();
  let executed = 0;
  for (const run of runs) {
    const key = `${run.id}:${run.attempt}`;
    if (inFlight.has(key)) continue;
    const jobs = await github.listRunAttemptJobs(run.id, run.attempt);
    const matchesHost = jobs.some(
      (job) =>
        job.name === "Browser Hardware / Ephemeral Execution" &&
        job.status === "queued" &&
        job.labels?.includes("forge3d-web") &&
        job.labels?.includes(expectedHardwareLabel) &&
        job.labels?.some((label) => /^jit-[0-9a-f]{32}$/u.test(label)),
    );
    if (!matchesHost) continue;
    inFlight.add(key);
    try {
      const resolved = await resolveAuthorizationForQueuedJob({
        hostId,
        expectedHardwareLabel,
        run,
        jobsClient: {
          listRunAttemptJobs: (runId, runAttempt) =>
            github.listRunAttemptJobs(runId, runAttempt),
        },
        artifactClient: {
          listRunArtifacts: async (runId) =>
            (await github.listRunArtifacts(runId)).map((artifact) => ({
              ...artifact,
              runAttempt: artifact.runAttempt ?? run.attempt,
            })),
          downloadById: (id) => github.downloadArtifactById(id),
        },
        attestationVerifier: {
          verify: (request) => github.verifyAttestation(request),
        },
        now,
      });
      audit({
        operation: "execute-authorization",
        hostId,
        runId: run.id,
        runAttempt: run.attempt,
        authorizationArtifactId: resolved.authorizationArtifactId,
        authorizationDigest: resolved.authorizationDigest,
        state: "started",
      });
      const result = await controller.execute(resolved.authorization);
      executed += 1;
      audit({
        operation: "execute-authorization",
        hostId,
        runId: run.id,
        runAttempt: run.attempt,
        authorizationDigest: resolved.authorizationDigest,
        runnerId: result.runnerId,
        state: "completed",
      });
    } catch (error) {
      audit({
        operation: "execute-authorization",
        hostId,
        runId: run.id,
        runAttempt: run.attempt,
        state: "rejected",
        error: String(error.message ?? error),
      });
      throw error;
    } finally {
      inFlight.delete(key);
    }
  }
  return { scanned: runs.length, executed };
}

export function startControllerPolling({
  hostId,
  expectedHardwareLabel,
  github,
  controller,
  intervalMs = 5_000,
  audit = defaultAudit,
}) {
  const inFlight = new Set();
  let stopped = false;
  let timer = null;
  const cycle = async () => {
    if (stopped) return;
    try {
      await pollControllerOnce({
        hostId,
        expectedHardwareLabel,
        github,
        controller,
        inFlight,
        audit,
      });
    } catch (error) {
      audit({
        operation: "controller-poll",
        hostId,
        state: "rejected",
        error: String(error.message ?? error),
      });
    } finally {
      if (!stopped) timer = setTimeout(cycle, intervalMs);
    }
  };
  void cycle();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

function defaultAudit(value) {
  process.stdout.write(
    `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`,
  );
}
