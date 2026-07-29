# Forge3D browser lab controller

This controller runs outside the repository and GitHub Actions runner folders.
It accepts only a valid, unexpired, GitHub-hosted-attested
`runner-authorization.json`, acquires the owning host lock, verifies the pinned
runner distribution, requests one broker-created repository JIT configuration
over mTLS, and launches only `run.sh|run.cmd --jitconfig <opaque-value>`.

It never receives a GitHub App private key, installation token, runner
registration/remove token, repository secret, or source checkout. The host lock
is released only after broker-confirmed exact-ID absence, distribution
verification, external diagnostic forwarding, host cleanup, and complete
per-job work-root removal. Otherwise the host is quarantined.

For an `infrastructure-canary` host run, the controller reads the neutral
browser/route/inventory observations before wiping the job root, waits for
broker-proven exact runner absence, signs one canonical host-canary receipt,
and stores it outside the runner tree. The mTLS service exposes that immutable
receipt only by exact run ID and attempt. A GitHub-hosted trust finalizer must
verify the checked controller public key before it can convert the receipt into
attested laboratory evidence.
