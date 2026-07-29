# Forge3D Browser Lab Broker

This service exposes only:

- `POST /v1/jit-config`
- `POST /v1/cleanup-runner`

Both endpoints require a controller certificate trusted by the broker CA and a
canonical ECDSA P-256 request signed by the matching public key in the checked
hardware matrix. The caller supplies an authorization digest and one-time
nonce; it cannot supply a repository, runner name, label list, runner group,
work folder, runner ID, workflow run ID, or workflow job ID.

The broker fixes the repository to `milos-agathon/forge3d-web`, derives all
runner fields from an attested canonical authorization, verifies live
protected-main policy and the exact queued job, and calls only GitHub's
repository JIT configuration, exact runner get/delete, exact job/run get, and
bound-run cancel endpoints. It never calls the generic registration-token
endpoint.

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
