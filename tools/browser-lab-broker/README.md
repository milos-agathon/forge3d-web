# Forge3D Browser Lab Broker

This service exposes only:

- `POST /v1/jit-config`
- `POST /v1/cleanup-runner`

Both endpoints require a controller certificate trusted by the broker CA and a
canonical ECDSA P-256 request signed by the matching public key in the checked
hardware matrix. The caller supplies an authorization digest and one-time
nonce; it cannot supply a repository, runner name, label list, runner group,
work folder, runner ID, workflow run ID, or workflow job ID.

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
Before the GitHub mutation, the ledger durably records a quarantining `issuing`
intent with the authorization digest, deterministic runner name and labels,
work folder, and exact run/job/host bindings. A lost response or service restart
never triggers a second JIT request: the watchdog lists repository runners,
accepts only one exact nonce-bound identity, and exact-ID deletes it only while
non-busy and still bound to the queued job. Zero matches close as
`already_absent` only from a complete listing at or after the issuance start
deadline; an earlier zero, incomplete listing, multiple or changed match, busy
runner, or non-queued job remains quarantined. The opaque configuration is
never persisted. Later ledger
states retain observations, the controller-loss latch, listener-stop proof,
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
