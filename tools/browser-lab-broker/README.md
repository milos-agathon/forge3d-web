# Forge3D Browser Lab Broker

This service exposes only:

- `POST /v1/jit-config`
- `POST /v1/cleanup-runner`
- `GET /v1/deployment`

All endpoints require a controller certificate trusted by the broker CA. The
two mutating endpoints require a
canonical ECDSA P-256 request signed by the matching public key in the checked
hardware matrix. The caller supplies an authorization digest and one-time
nonce; it cannot supply a repository, runner name, label list, runner group,
work folder, runner ID, workflow run ID, or workflow job ID.

The read-only deployment endpoint returns the administrator-verified
installation receipt loaded at startup. The installed service fails closed
unless that receipt binds the exact protected-main source and workflow SHAs,
GitHub attestation identity, package-manifest digest, archive, configuration,
broker/cleanup protocol versions, and the exact package workflow run ID,
attempt, artifact ID, name, and digest. Package-manifest schema version 1
remains unchanged. The immutable artifact name ends with
`<run-id>-<run-attempt>`, and the hosted proof verifies the unchanged manifest
bytes inside that exact artifact. Attempt-unqualified artifact names are
rejected.

The service definition launches `src/bootstrap.mjs` before importing any broker
runtime module. The bootstrap verifies the full manifest/receipt identity, the
retained outer archive and its single nested npm package, and the exact current
regular-file trees under `/opt/forge3d/browser-lab-broker` and
`/etc/forge3d/browser-lab-broker-config`. Missing, extra, changed, symlinked, or
hard-linked files fail before token-provider, watchdog, or socket construction.
The archive remains at the fixed read-only
`/opt/forge3d/browser-lab-broker-package/browser-lab-broker.tar.gz` path.

The broker fixes the repository to `milos-agathon/forge3d-web`. Its protected
authorization directory receives the canonical authorization subject and
offline GitHub attestation bundle through the separately administered broker
provisioning boundary. The service resolves them only by the caller-supplied
digest, derives all runner fields from the authorization, verifies its
attestation, live protected-main policy, and exact queued job, and calls only
GitHub's repository JIT configuration, exact runner get/delete, exact job/run
get, and bound-run cancel endpoints. It never calls an Actions artifact or
generic registration-token endpoint.

`encoded_jit_config` is returned once and never written to the ledger or log.
The ledger records the authorization digest, exact runner/run/job identity,
state transitions, observations, controller-loss latch, listener-stop proof,
exact work-root-wipe proof, quarantine release, and cleanup decision. Request
nonces are persistent and fail on replay.

The five-second watchdog probes the authorization-bound controller at its
checked HTTPS health endpoint using a dedicated mTLS client identity. A valid
response must echo the exact asset and controller identities. Failed or
identity-mismatched probes count toward a checked consecutive-failure threshold;
until that threshold is reached the watchdog fails safe by treating the
controller as reachable. Only a threshold-confirmed disappearance can enter
the controller-unreachable deletion, run-cancellation, and quarantine path.
Each controller health endpoint must be served by the controller process, not a
host-independent proxy, so a successful probe proves that the responsible
controller remains reachable.
The same health request carries a size-bounded lifecycle header containing only
the ledger-bound authorization digest, host, runner ID/name, state, persisted
online/assignment window, busy latch, and last exact runner/job observations.
The controller accepts that header only from the dedicated
`broker:forge3d-browser-lab` certificate identity. This lets the controller act
on the broker-observed assignment deadline without adding a third broker API
operation or granting the controller repository-administration access.

A confirmed controller disappearance latches quarantine against the host asset,
including while its job is busy. New authorization digests cannot issue another
JIT runner for that host. The same signed cleanup protocol releases quarantine
only after the controller proves both that the listener stopped and that the
fixed `_work` root was wiped after quarantine began. Pending GitHub
cancellations advance once per watchdog cycle; per-record in-flight isolation
keeps another host from delaying the five-second cycle.

The checked service unit runs under a non-login account with a read-only
installation and a single writable state directory. App and TLS private keys
remain outside the package in the OS credential boundary. The broker App's
Administration write and Actions write permissions are coarse: compromise can
alter repository settings or workflow availability even though the service API
is narrow. Deploy only an attested protected-main archive whose source,
configuration, protocol, and archive hashes match the reviewed release.

The checked policies intentionally remain in pending state until the live
protected-branch canary, controller keys, and clean JIT canaries exist. The
server refuses to start against a pending matrix or browser policy.
