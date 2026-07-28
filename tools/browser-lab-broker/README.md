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
state transitions, observations, listener-stop proof, and cleanup decision.
Request nonces are persistent and fail on replay.

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
