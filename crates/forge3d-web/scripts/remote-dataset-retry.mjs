// Live-gate transport retries only; integrity and runtime policies stay in DatasetRegistry.
const attempts = 3;
const deadlineMs = 120000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchRemoteDatasetWithRetry(registry, name, {
  wait = sleep,
  onFailure = (failure) => console.error(JSON.stringify(failure)),
} = {}) {
  const url = registry.url(name).href;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await registry.fetch(name, { signal: AbortSignal.timeout(deadlineMs) });
    } catch (error) {
      const interrupted = error?.code === "IO_ERROR"
        && error?.details?.kind === "asset-io"
        && error?.details?.asset === name
        && error?.details?.reason === "TypeError: terminated";
      const retrying = interrupted && attempt < attempts;
      onFailure({ event: "remote-dataset-attempt-failed", checkedAt: new Date().toISOString(),
        name, url, attempt, maxAttempts: attempts, deadlineMs, retrying,
        code: error?.code ?? null, details: error?.details ?? null, error: String(error) });
      if (!retrying) throw error;
      await wait(attempt * 1000);
    }
  }
}
