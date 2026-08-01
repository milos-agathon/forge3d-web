# Forge3D Interactive Viewer Physical Test Infrastructure Plan

Date: 2026-07-27
Repository baseline: `ffba491` (`main`)
Consumed by: CHR-03, CHR-04, SAF-02, SAF-03, SAF-04, FFX-03, MOB-02,
MOB-03, MOB-04, MOB-05, and MOB-06

## Purpose And Gate

At repository baseline `ffba491`, the repository had one GitHub-hosted
`windows-latest` workflow and no physical runner or device-lab configuration.
Live inspection at plan creation reported `main.protected: false`, protection
enforcement `off`, and no required checks. Therefore, baseline `main` was not a
trust root, and the eleven consuming
tasks' physical acceptance remains `LAB_INFRA_BLOCKED` until the protection and
laboratory gate below passes. Code and emulated preflight portions may be
implemented earlier, but none of these eleven tasks may execute physical
acceptance before that gate or satisfy its complete definition of done before
the release-matrix gate.

The canonical repository is the current personal-account repository
`milos-agathon/forge3d-web`. Repository runner groups do not exist for this
ownership type, so this plan uses repository-level ephemeral runners rather
than an organization runner group. An out-of-repository lab controller on each
host starts only a broker-created, authorization-bound JIT runner for one
already-promoted job. Workflow routing requires the exact three custom labels;
GitHub-generated read-only platform labels are non-authoritative. The JIT runner
auto-deregisters after that one job, with broker-owned exact-ID cleanup as the
fail-safe. No GitHub Actions runner is registered while a host is idle. Browser
support jobs run headed on the physical machines below. Mobile devices are
USB-attached to the Apple Silicon host. Substituting a model, browser channel,
GPU, OS family, controller, runner label, accessory, or hosting route requires
a reviewed matrix change; it cannot silently inherit the original asset's
support claim.

## Status Snapshot — 2026-07-31

This snapshot records implementation evidence separately from live physical and
administrator evidence. `CODE_COMPLETE` means the repository source, schemas,
workflows, negative controls, and documentation are implemented and locally
verified. It does not mean a physical lane ran, a controller was provisioned,
or either readiness gate passed.

| Requirement | Repository implementation | Live/physical status | Remaining proof before acceptance |
|---|---|---|---|
| INF-00 | `CODE_COMPLETE` in PR candidate `codex/lab-infra-ready-20260731`, based on `d9da44bcc3b10d7e25d04cb0803c8e0b55aa9e11` | `BLOCKED` | Complete the protected-main bootstrap and policy pin; enable immutable releases and protected environments; provision the exact four hosts, seven attached assets, broker, controllers, public keys, mTLS endpoints, and installed-service receipts; then run clean host canaries. |
| INF-01 | `CODE_COMPLETE` | `NOT_PROVEN` | Capture the checked installed branded browser, driver, OS, headed-session, prohibited-flag, and update-window evidence on every owning physical host. |
| INF-02 | `CODE_COMPLETE` | `NOT_PROVEN` | Run the exact installed package in headed physical browsers and prove a non-fallback hardware adapter plus measured present/readback evidence. Local unsafe-WebGPU, headless, SwiftShader, fallback, and emulated results remain `PROBE`. |
| INF-03 | `CODE_COMPLETE` | `NOT_PROVEN` | Serve the exact package through the nonce-bound trusted HTTPS origins and run the certificate, MIME, CORS, range, deny-route, and normalized-loader controls in every physical browser; the Mac canary must include all six real Appium device sessions. |
| INF-04 | `CODE_COMPLETE` | `NOT_PROVEN` | Install the attested broker/controller packages and reviewed helpers, activate their services and keys, then prove four authorization-bound one-job JIT canaries, external diagnostics retention, exact-ID cleanup, wipe, and zero runners at rest. |
| INF-05 | `CODE_COMPLETE` | `NOT_PROVEN` | Complete the generic authenticated manual canary with its controller-signed 20-minute session, challenge-bound media, exact intake assets, independent approval, cleanup, and retained provenance. Product manual rows remain separate. |
| INF-06 | `CODE_COMPLETE` | `NOT_PROVEN` | Publish and verify the immutable non-support lab canary, compute the exact attested readiness record, and retain the postpublication verification record described below. No release or publication workflow has yet been dispatched. |
| `LAB_INFRA_READY` | Gate implementation is `CODE_COMPLETE` and fail-closed | `LAB_INFRA_BLOCKED` | Supply one same-SHA package, four fresh host canaries, the fresh generic manual canary, immutable lab-canary publication, live trust observation, installed-service closure, and zero-runner evidence inside the checked 24-hour window. |
| `RELEASE_MATRIX_READY` | Gate implementation is `CODE_COMPLETE` and fail-closed | `NOT_PROVEN` | First obtain `LAB_INFRA_READY`, then run all 24 required physical product rows and merge the exact same-package evidence set. |

Validated repository evidence for this snapshot:

- Rust/WASM, TypeScript, distribution, and example builds passed.
- Package contracts passed, including 50 browser-harness tests and 462
  infrastructure tests with one expected real-UID ACL integration skip.
- API/type contracts passed; 97 unit tests passed.
- The local source-browser probe passed 27 tests with one intentional skip, but
  used unsafe WebGPU and a SwiftShader fallback, so it is not physical evidence.
- Independent requirements-only review found no remaining actionable source,
  schema, workflow, or test defect. Exact installed npm-tarball validation
  remains a required post-commit PR gate and is recorded in PR evidence rather
  than treated as source/static proof. Hosted CI, physical browser/GPU, Appium,
  controller, JIT, manual, release, and readiness evidence remains unproven.

### Recommended activation sequence

1. **Land and reverify the code candidate.** Merge the reviewed implementation
   only after required checks, exact installed-tarball consumer validation, and
   exact-head autoreview pass. Record the resulting implementation merge SHA; do not
   reuse pre-merge artifacts for physical acceptance.
2. **Activate the repository trust root.** Provision the read-only
   `forge3d-trust-observer` App/environment, confirm the strict App-bound checks
   and full-length action pins, run the protected-main canary in this plan, and
   merge a separate policy-pin PR that changes `bootstrapState` to `active` and
   sets `trustEpochSha` to the canary merge SHA. Verify current `main` with
   `verify-repository-trust.mjs` using a short-lived observer token.
3. **Enable the protected execution surfaces.** Enable release immutability and
   configure `forge3d-browser-lab`, `forge3d-manual-evidence`, and
   `forge3d-web-release` with independent approvers. Install the distinct broker
   App, controller mTLS material, and protected credentials without placing any
   secret or stable device identifier in Git or Actions artifacts.
4. **Provision and attest the fixed laboratory.** Acquire or assign the exact
   inventory, generate one non-exported P-256 controller key per host, install
   the attested broker/controller packages and every reviewed helper, configure
   the checked endpoints, and capture signed inventories. Change a host,
   controller, or attachment to `active` only after its live facts match the
   checked matrix; run `validate-hardware-matrix.mjs --require-provisioned` when
   all four hosts are ready.
5. **Use a two-pass JIT-policy bootstrap.** First run one otherwise-clean
   `infrastructure-canary` on every host while the transient/browser canary state
   is pending. Review the observed transient paths and deployment receipts, then
   merge a dedicated evidence PR that changes the transient policy to `verified`
   and the browser policy to `active`. Because that changes the laboratory
   digest, package the new exact `main` SHA and rerun all four host canaries; do
   not reuse the bootstrap canaries as final readiness evidence.
6. **Close the remaining non-support laboratory evidence within 24 hours.** The
   final Mac host canary must open all six real Appium sessions against the same
   nonce-bound HTTPS package. Complete the generic `infrastructure-manual-canary`
   intake/session/submission with an independent approver, publish the immutable
   non-support lab canary, and retain the postpublication CLI/API/byte proof.
7. **Dispatch laboratory readiness once with the exact IDs.** Supply the same-SHA
   package run, four final host-canary runs, manual-canary submission run, its
   intake release and hardware job, and the immutable lab-canary release. Accept
   only the attested `LAB_INFRA_READY` output whose recomputed
   `labInfrastructureDigest` matches the checked source and installed services.
8. **Then close release support separately.** Run all 24 required product rows,
   dispatch `browser-hardware-release-readiness` with the canonical sorted run
   IDs, and accept only `RELEASE_MATRIX_READY` before `publish-web-release.yml`.
   A stale, changed, quarantined, substituted, or mismatched input reruns from
   its earliest invalid boundary instead of being waived.

## Required Inventory

| Asset ID | Exact baseline | Required ephemeral labels or attachment |
|---|---|---|
| `FW-MAC-M2-01` | Mac mini (2023), Apple M2, 16 GB RAM, macOS 26 latest security patch | `forge3d-web`, `hw-mac-m2`, and the promotion-generated `jit-<runner-nonce>`; hosts `FW-TRACKPAD-01` and the six USB mobile assets |
| `FW-WIN-I12-01` | Intel NUC 12 Pro `NUC12WSHi5`, Core i5-1240P/Iris Xe, 32 GB RAM, Windows 11 25H2 | `forge3d-web`, `hw-win-intel12`, and the promotion-generated `jit-<runner-nonce>` |
| `FW-LNX-I12-01` | Intel NUC 12 Pro `NUC12WSHi5`, Core i5-1240P/Iris Xe, 32 GB RAM, Ubuntu 24.04 LTS GNOME Wayland | `forge3d-web`, `hw-linux-intel12`, and the promotion-generated `jit-<runner-nonce>` |
| `FW-LNX-NV-01` | Lenovo ThinkStation P360 Tower, Core i7-12700, NVIDIA GeForce RTX 3070 8 GB, 32 GB RAM, Ubuntu 24.04 LTS GNOME Wayland | `forge3d-web`, `hw-linux-rtx3070`, and the promotion-generated `jit-<runner-nonce>` |
| `FW-TRACKPAD-01` | Apple Magic Trackpad (USB-C, 2024), model A3120 | Accessory of `FW-MAC-M2-01`; direct USB-C-to-USB-C connection with no hub for pairing/charging, Bluetooth for the acceptance gestures |
| `FW-AND-QCOM-01` | Samsung Galaxy S23 `SM-S911B`, Snapdragon 8 Gen 2, current vendor-supported Android release | USB asset on `FW-MAC-M2-01`; Appium ID `android-qualcomm-s23` |
| `FW-AND-MALI-01` | Google Pixel 8, Tensor G3/Mali-G715, current vendor-supported Android release | USB asset on `FW-MAC-M2-01`; Appium ID `android-mali-pixel8` |
| `FW-AND-PEN-01` | Samsung Galaxy Tab S9 Wi-Fi `SM-X710`, Snapdragon 8 Gen 2, current vendor-supported Android release, with its in-box S Pen | USB asset on `FW-MAC-M2-01`; Appium ID `android-pen-tabs9` |
| `FW-IOS-OLD-01` | iPhone 11, iOS 26 latest security patch | USB asset on `FW-MAC-M2-01`; Appium ID `ios-iphone11` |
| `FW-IOS-NEW-01` | iPhone 17 Pro, iOS 26 latest security patch | USB asset on `FW-MAC-M2-01`; Appium ID `ios-iphone17pro` |
| `FW-IPAD-01` | iPad Air 11-inch (M2), iPadOS 26 latest security patch, with paired Apple Pencil Pro | USB asset on `FW-MAC-M2-01`; Appium ID `ipados-air11-m2` |

The iPhone 11 is intentionally the oldest declared iOS 26 iPhone baseline.
Apple's compatibility list includes iPhone 11, and the M2 iPad Air is in the
iPadOS 26 compatibility list. Apple lists Apple Pencil Pro as compatible with
the M2 iPad Air; Samsung specifies an in-box S Pen for the Tab S9. Compatibility
is only eligibility; the Forge3D support claim still requires this plan's
physical evidence. The trackpad row is likewise a fixed test asset: inventory
captures its installed firmware, Bluetooth transport/state, battery state, and
direct USB-C topology without recording its serial number.

## INF-00 — Provision And Register The Fixed Inventory

**Priority:** P0

**Task definition**

Create the protected-`main` repository trust root, acquire or assign the exact
assets above, provision an independently audited lab controller on each of the
four hosts, and make repository policy, inventory, and controller state
reviewable without committing serial numbers or credentials.

**Necessary code changes**

- In a one-time bootstrap PR, split `.github/workflows/web.yml` into two
  GitHub-hosted jobs with globally unique, immutable display names:
  `Web Runtime / Build And Contract Tests` and
  `Web Runtime / Browser Preflight`. The first owns Rust/WASM, TypeScript, unit,
  API, package, packed-consumer, and dry-run gates; the second `needs` the first
  and owns engine/browser preflight. Run both for `pull_request` targeting
  `main` and `push` to `main`, so the reviewed PR and resulting protected-main
  SHA each receive the two exact checks. Add a contract test that rejects a
  rename, duplicate job name, either missing trigger/filter, an added privileged
  trigger, or a non-GitHub-hosted runner for either required check.
- Add
  `crates/forge3d-web/tests/infrastructure/repository-trust-policy.json` and its
  JSON schema. Freeze canonical repository ID/name, default branch `main`,
  `requiredStatusChecks.strict: true`, the two exact check names above with
  source app slug `github-actions`, zero required approving reviews,
  stale-review dismissal for any voluntary review, no latest-push approval
  requirement, required conversation resolution, administrator enforcement,
  and `allowForcePushes: false`,
  `allowDeletions: false`, with no user/team/app bypass actor.
- Add `crates/forge3d-web/scripts/verify-repository-trust.mjs`. Using the branch
  and branch-protection REST endpoints, it must fail closed unless `main` is
  protected and the live response exactly matches the checked policy. Resolve
  the current GitHub Actions App ID and require each configured check's
  `context` and `app_id` to match; an "any source" required check is invalid.
  Authenticated live reads use the short-lived installation token of the
  read-only trust-observer App defined below; do not assume the job's
  `GITHUB_TOKEN` can read branch-protection settings.
- Add
  `crates/forge3d-web/tests/infrastructure/repository-trust-observation.schema.json`,
  `crates/forge3d-web/scripts/emit-repository-trust-observation.mjs`, and
  `crates/forge3d-web/scripts/verify-repository-trust-observation.mjs`. Every
  Actions workflow that needs a live protected-branch, required-check, release
  setting, or repository-runner read must perform it in a dedicated
  GitHub-hosted `observe-*` job whose sole environment is
  `forge3d-trust-observer`. That job checks out validation code only at
  `github.workflow_sha`, mints the short-lived observer App token, runs the live
  verifier, destroys the token, and emits canonical
  `repository-trust-observation.json`. Bind repository ID/name, operation and
  an exact non-empty set of intended consumer job/environment pairs, workflow
  path/ref/SHA, run ID/attempt,
  candidate/target SHA, current `main` SHA, `trustEpochSha`, policy and
  workflow-actions-lock digests, required-check IDs/conclusions/source App IDs,
  digests of every live API response used in the decision, a random 128-bit
  nonce, and `observedAt`/`expiresAt` no more than 30 minutes apart. Upload the
  record as the sole file in the run/attempt/operation-qualified fixed artifact
  through a full-SHA-pinned `actions/upload-artifact` step with immutable step
  ID `upload-observation`, `overwrite: false`, and
  `if-no-files-found: error`, then attest it from that observer job.
- Expose exactly four non-secret observer job outputs:
  `observation_artifact_id` as the decimal
  `steps.upload-observation.outputs.artifact-id`,
  `observation_artifact_name` as the fixed generated name,
  `observation_artifact_digest` as
  `steps.upload-observation.outputs.artifact-digest` constrained to 64
  lowercase hex characters, and
  `observation_content_sha256` as the locally computed SHA-256 of canonical
  `repository-trust-observation.json`. Never expose the App key, installation
  token, artifact URL, or any caller-supplied artifact identifier. The artifact
  ID cannot be embedded in the file that is uploaded to create that ID; it is
  instead bound to the record by the validated output tuple and the record's
  repository/workflow/run/attempt/source-SHA fields.
- Any job with a different protected environment or any mutation permission
  must `needs` its workflow's observer job and receive no observer secret. Before
  its first write, it accepts the four outputs only through `needs.<observer>`,
  rejects a non-decimal/zero artifact ID or either non-64-hex digest, and calls
  `GET /repos/milos-agathon/forge3d-web/actions/artifacts/{artifact_id}` with
  `actions: read`. Require the returned ID, fixed name,
  `digest == "sha256:" + observation_artifact_digest`, `expired: false`,
  repository ID, workflow-run ID, head repository/branch/SHA, and remaining
  output tuple to match exactly. Download only through
  `GET /repos/milos-agathon/forge3d-web/actions/artifacts/{artifact_id}/zip`;
  name-based/list lookup is not a fallback. Verify the downloaded archive
  digest, require exactly one canonical observation file, recompute its content
  SHA-256, and only then verify the GitHub-hosted attestation's repository,
  signer workflow, `refs/heads/main` source ref, `github.workflow_sha` source
  digest, and `--deny-self-hosted-runners`; then require the bound operation,
  its own job/environment pair, run ID/attempt, target SHA, current workflow
  SHA, policy/lock digests, and unexpired timestamp to match. An observation
  from a prior run/attempt, another workflow/job/environment/operation, another
  SHA, or an expired record fails before mutation; if environment approval does
  not arrive within the 30-minute validity window, the operator must rerun the
  dispatch. Non-mutating build, promotion, authorization, readiness, and
  finalizer jobs use the same handoff instead of receiving the observer secret
  unless the job itself is the enumerated observer.
- Contract fixtures fail on a missing/swapped/user-supplied artifact ID,
  ID/name/digest/content-hash disagreement, wrong run/repository/head SHA,
  expired/deleted artifact (`404`/`410`), multiple archive members, or a
  name-based lookup. Static workflow tests require all four outputs to originate
  from the fixed observer/upload step and allow no observer credential in any
  consumer.
- Add
  `crates/forge3d-web/tests/infrastructure/workflow-actions-lock.json` and a
  schema recording each reviewed external action/reusable-workflow repository,
  path, full 40-lowercase-hex commit SHA, upstream version/tag for audit only,
  and review date. Add
  `crates/forge3d-web/scripts/verify-workflow-action-pins.mjs` to parse every
  `.github/workflows/*.yml` and checked composite action. Reject every external
  step/job `uses:` value that is a tag, branch, abbreviated SHA, expression, or
  non-lockfile commit. In the required and privileged workflows named below,
  every actual `uses:` value must match
  `<owner>/<repo>[/path]@<40-lowercase-hex-commit>`; local `./...` and
  `docker://...` action references are forbidden rather than exempted. Invoke
  checked repository scripts through `run` only after the exact protected
  checkout; pin any job/service container image separately by `sha256:` digest.
  This static gate covers `web.yml`, package, observer, hardware promotion/authorization,
  controller, broker, finalizer, readiness, manual-intake/submission, canary,
  and release-publication workflows. In plan examples,
  `actions/attest@<reviewed-40-hex-commit> # v4.x.y` denotes the lockfile value,
  never the movable `v4` tag.
- As a repository-administrator prerequisite, enable GitHub's **Require actions
  to be pinned to a full-length commit SHA** policy if the current account/repo
  exposes it, and make the observer verify that live setting when readable.
  Repository-policy unavailability is recorded explicitly and never relaxes the
  required static full-SHA gate.
- After the bootstrap PR lands, a repository administrator must create the
  exact `main` protection rule through repository settings/API. No workflow or
  lab-controller credential receives authority to edit that rule. The
  separately isolated registration broker described below necessarily holds
  GitHub's coarse repository `Administration: write` permission; treat that
  broker as an explicit trust-root service because the same permission can
  alter repository settings. Run a
  post-protection canary PR that proves direct/force push and deletion fail,
  stale voluntary reviews are dismissed, zero approving reviews are required,
  no latest-push approval is required,
  both named checks are required and strict, unresolved conversations block,
  and administrators cannot bypass. Then merge a protected policy-pin PR that
  writes the canary merge SHA as `trustEpochSha`; promotion rejects that SHA
  itself and accepts only descendants.
- Add `crates/forge3d-web/tests/infrastructure/hardware-matrix.json` containing
  the public asset IDs, exact models, required labels, OS family, GPU, attached
  device/accessory IDs, required browser lanes, controller identity, and
  active/maintenance state. Each host also records a unique controller
  `signingKeyId` and ECDSA P-256 public JWK. Host label sets contain only the two
  checked static labels; the `jit-<runner-nonce>` label is generated per
  promoted job.
- Add
  `crates/forge3d-web/tests/infrastructure/hardware-matrix.schema.json` and a
  package test that rejects missing, duplicate, or unknown labels/device IDs.
- Add `crates/forge3d-web/docs/browser-lab-runbook.md` documenting physical
  custody, patching responsibility, USB/Bluetooth topology, controller and
  runner service accounts, runner-version/hash patching, externally retained
  `_diag` logs, maintenance mode, and substitution/change-control procedure.
- Add `crates/forge3d-web/scripts/capture-trackpad-inventory.mjs`. It parses
  allowlisted fields from macOS `system_profiler SPUSBDataType -json` while the
  pairing/charging cable is directly attached, then
  `system_profiler SPBluetoothDataType -json` during wireless gestures. Emit
  only asset/model, firmware, transport, battery state, capture time, and
  direct-versus-hub topology; explicitly discard serial number, Bluetooth
  address, and other stable device identifiers before logging.
- Install a trust-observer GitHub App only on
  `milos-agathon/forge3d-web`, with `Administration: read`,
  `Actions: read`, `Attestations: read`, and `Metadata: read`; grant no write,
  Contents, or Secrets permission. This is the credential used for exact live
  protection reads, because GitHub requires Administration read on that
  endpoint and repository-runner list/get reads. Store its Actions copy only in
  a separate protected `forge3d-trust-observer` environment, never
  `forge3d-browser-lab`; only the explicitly enumerated GitHub-hosted
  `observe-*` jobs and the runner-absence observer/finalizer may reference it.
  A job referencing `forge3d-manual-evidence`, `forge3d-web-release`, or
  `forge3d-browser-lab` cannot reference or inherit this environment secret.
  Controller service accounts hold their separately provisioned copy. Each
  authorized observer/controller caller mints a short-lived installation token,
  masks it from logs, passes it only to the verifier/API client, and discards it
  after the read. The ephemeral hardware job never receives this key or token.
- Run each controller under a dedicated non-login service account, outside the
  repository checkout and runner work directory. Its only GitHub authority is
  the trust-observer App above.
- Provision a separate out-of-repository registration broker under a distinct
  service identity and network boundary. Only this broker holds a second
  repository-scoped GitHub App private key with `Administration: write`,
  `Actions: write`, and `Metadata: read`. `Administration: write` is required
  for repository JIT configuration and forced runner deletion; `Actions: write`
  is used only to cancel the exact authorization-bound workflow run after an
  online-but-unassigned assignment timeout. Treat both coarse permissions as
  part of the broker trust boundary. Expose exactly two
  mTLS-authenticated operations, neither of which accepts a repository, runner
  name, label, work-folder, or runner ID chosen by the caller:
  1. `POST /v1/jit-config` accepts only a controller-signed request containing
     the digest of an unexpired, attested `runner-authorization.json` and a
     one-time request nonce. The broker independently re-verifies live
     repository protection, authorization, queued job, controller/host
     identity, and nonce; derives runner name
     `<asset-id>-<runner-nonce>`, custom labels
     `[forge3d-web, <mapped-hw-label>, jit-<runner-nonce>]`, fixed
     `work_folder: "_work"`, and checked
     `repositoryJitRunnerGroupId: 1`; calls only
     `POST /repos/milos-agathon/forge3d-web/actions/runners/generate-jitconfig`;
     verifies the returned runner ID/name/custom labels; records the runner ID
     against the authorization digest; and returns the opaque
     `encoded_jit_config` plus that runner ID/name exactly once. The ledger sets
     `startDeadline` to the earlier of authorization expiry and two minutes
     after JIT issuance. It never calls or returns the generic
     registration-token endpoint. The documented group ID is a live
     provisioning prerequisite: a non-`201` response keeps INF-00 incomplete
     rather than falling back to raw registration.
  2. `POST /v1/cleanup-runner` accepts only the authorization digest, a
     controller-signed terminal/launch-failure/online-unassigned reason, signed
     local-process stop result when applicable, and a fresh request nonce. The
     broker resolves the runner ID/name and workflow run/job IDs from its own
     issuance ledger, re-verifies the authorization and caller, and queries
     GitHub itself. It deletes exactly that runner ID only if the runner exists
     with the recorded name/labels and is not busy and one of these predicates
     holds: the authorized job is terminal; the same controller reports launch
     failure before the broker ever observes the runner online; the runner
     never came online before `startDeadline`; or `assignmentDeadline` elapsed,
     the broker never observed the runner busy/job in progress, the exact
     authorized job is still `queued`, and the local listener has been stopped.
     For that last transition, after exact-ID deletion the broker cancels only
     the ledger-bound workflow run and verifies its cancelled terminal state, so
     the job cannot remain in GitHub's queue for 24 hours. If the runner is
     already absent, cleanup succeeds idempotently; an ID/name/label mismatch,
     busy runner, non-queued job at assignment timeout, replay, or unrelated
     runner/run fails closed and alerts without deletion or cancellation.
- Add a broker watchdog that applies the same exact-ID cleanup policy when a
  controller disappears after JIT issuance. Poll the exact runner and workflow
  job every five seconds. On first observing the exact runner `online` and
  `busy: false` while the job is still `queued`, enter `online_unassigned` and
  set `assignmentDeadline` to the earlier of authorization expiry and 90
  seconds after `onlineAt`; the 90 seconds spans GitHub's documented 60-second
  assigned-but-not-picked-up requeue interval. The normal controller path stops
  the local listener at that deadline and calls `cleanup-runner`. If the
  controller is unreachable, the watchdog independently re-proves the exact job
  is still queued and the runner is not busy, exact-ID deletes it to sever the
  registration, cancels only the bound run, and quarantines the host until the
  controller later proves the listener stopped and the work root was wiped.
  Persist states
  `issued|online_unassigned|assigned|busy|assignment_timeout|terminal|deleted|already_absent|quarantined`
  with authorization digest, run/job IDs, runner ID/name, host, exact custom
  labels, issue/authorization-expiry/start/assignment-deadline times, last
  runner/job observations, local-stop evidence, deletion/cancellation results,
  and cleanup decision, but never the encoded JIT configuration. The broker
  exposes no generic GitHub proxy, workflow dispatch/rerun/artifact operation,
  registration-token, label-mutation, or repository-settings operation. Pin
  and audit the broker build, isolate its private key in a managed credential
  store, retain token-free request/decision logs, and document that compromise
  of this broker compromises repository-policy integrity and workflow
  availability despite the narrow service API.
- Add audited broker source and negative/unit tests under
  `tools/browser-lab-broker/`, its service definition under
  `tools/browser-lab-broker/services/`, and checked
  `crates/forge3d-web/tests/infrastructure/broker-protocol.schema.json` plus
  `broker-lifecycle.schema.json`. Schemas freeze the two request/response
  shapes, mTLS controller identity, authorization digest, one-time nonce,
  derived JIT request, returned runner ID/name, online/assignment timestamps,
  ledger transitions, local-stop proof, exact-run cancellation, cleanup
  decision, and redacted logging contract. Package and attest the broker from
  protected-main GitHub-hosted
  `.github/workflows/browser-lab-broker.yml`. Its
  `observe-broker-package-trust` job alone references
  `forge3d-trust-observer` and emits an exact-source observation; the separate
  `package-broker` job applies the INF-00 four-output exact-ID handoff to verify
  that record, receives no observer secret, and
  uses only `contents: read`,
  `id-token: write`, `attestations: write`, and
  `artifact-metadata: write`; deployment requires exact signer, source SHA,
  archive hash, configuration hash, and protocol version.
- Pin the Actions runner distribution version and SHA-256 in
  `crates/forge3d-web/tests/infrastructure/browser-policy.json`, together with
  `repositoryJitRunnerGroupId: 1`, `jitWorkFolder: "_work"`, and the exact
  broker JIT/cleanup protocol version. Add
  `runner-distribution-manifest.schema.json`,
  `runner-distribution-manifest.json`, and
  `runner-transient-path-policy.json`. Generate the canonical distribution
  manifest from the verified release archive: sorted normalized relative path,
  entry type, byte size, executable/mode bits, SHA-256 for each regular file,
  and target for each symlink. Bind its digest into `browser-policy.json`.
  Before each launch, a fresh extraction must match every manifest entry and
  contain no extra path.
- The immutable pre/post check verifies every manifest-listed distribution file,
  executable, and symlink remains byte/mode/target identical; it does not hash
  the mutable tree as one root. After the run, enumerate every non-manifest
  path. Permit only `_diag/**`, `_work/**`, and exact reviewed runtime paths in
  `runner-transient-path-policy.json`; broad root wildcards are forbidden. The
  initial policy is produced by an otherwise-clean pinned-version JIT canary and
  must identify the upstream runner behavior and evidence for each permitted
  path. `_diag` and `_work` are transient, never immutable distribution
  content; `_diag/Runner_*` and `_diag/Worker_*` are forwarded before wipe.
  Any unknown path outside the exact transient policy, any executable/symlink
  created outside it, or any modified/missing manifest entry is
  `INFRA_ERROR`. The controller is the only component permitted to replace the
  runner archive/manifest/transient policy after review. Record the executed
  runner version, wipe the install root, update pins through review, and rerun;
  never fall back to raw registration merely to obtain `--disableupdate`.
- Provision one non-exported ECDSA P-256 controller private key per host under
  the controller service account's OS credential store. Controller-generated
  observations use RFC 8785 JSON Canonicalization Scheme bytes and
  `SHA256withECDSA`; verification accepts only the current matrix public
  key/`signingKeyId`. Key rotation is a reviewed matrix change that changes
  `labInfrastructureDigest` and invalidates prior laboratory readiness.
- Store serial numbers, Apple UDIDs, Android device serials, encoded JIT
  configurations, tunnel tokens, and signing identifiers only in protected
  process memory or the lab inventory/GitHub environment secrets as applicable,
  never in repository files, broker ledgers, or artifacts. A raw repository
  runner registration token is never generated.

**Definition of done**

- The live branch/protection APIs report the exact checked policy, both required
  checks are bound to the GitHub Actions App rather than "any source", and
  `verify-repository-trust.mjs` passes on the current `main`.
- The canary evidence proves PR-only changes, zero required approving reviews,
  no latest-push approval requirement, configured stale-review dismissal,
  strict named checks, conversation resolution, administrator enforcement, and
  force-push/deletion rejection. A negative fixture changing any single policy
  field fails verification.
- `trustEpochSha` identifies the post-protection canary merge; it is an ancestor
  of current `main`, and neither it nor any pre-epoch commit is eligible for a
  promoted hardware or release run.
- All four lab controllers are online, but the repository reports no registered
  self-hosted runner while no promoted hardware job is queued.
- A workflow-dispatch inventory job resolves all eleven public asset IDs to one
  physical host/device/accessory relationship and schema validation passes.
- The inventory artifact records exact OS build, CPU/GPU, RAM, display server,
  attached-device/accessory model, trackpad firmware/transport, and anonymized
  asset ID; its controller signature verifies against that host's pinned key.
- One synthetic promoted job on every host starts from broker-generated JIT
  configuration with exact custom labels `forge3d-web`, its checked `hw-*`
  label, and its unique `jit-<runner-nonce>` label, accepts exactly one job,
  auto-deregisters, wipes its unique work directory, and leaves no registered
  runner behind. GitHub-generated read-only platform labels may coexist, but
  cannot replace any of the three authorization-bound custom labels or appear
  in the workflow's `runs-on` selector.
- Broker evidence proves the JIT response's runner ID/name/custom labels and
  `_work` folder match the authorization-derived request, the encoded
  configuration was returned once and not persisted, no registration-token API
  call occurred, and launch failure/start timeout/online-unassigned assignment
  timeout/normal completion each reach `deleted` or `already_absent` through
  exact-ID cleanup. The online-unassigned fixture proves local listener stop,
  queued-job revalidation, exact runner-ID deletion, and exact bound-run
  cancellation; a busy or no-longer-queued negative control permits neither
  deletion nor cancellation.
- A clean JIT canary proves every archive-listed distribution file is unchanged
  before/after execution, only reviewed transient paths appear, `_diag` logs are
  retained externally, and an injected executable, symlink, unknown root file,
  or modified distribution file fails closed.
- Static workflow tests prove all external action/reusable-workflow `uses:`
  references are lockfile-reviewed full commit SHAs, privileged workflows have
  no local/container-action exception, all job/service container images are
  digest pinned, and no consumer/mutation job can access the observer App
  secret. An exact-SHA-bound observation passes only in its intended
  run/attempt/job/environment before expiry.
- Removing a checked host label, device, trackpad, trust-observer permission,
  broker permission/policy, or controller/broker validation makes the readiness
  job fail closed.
- No secret, hardware serial number, UDID, or personal Apple account appears in
  the repository or uploaded logs.

## INF-01 — Pin Browser, Driver, And Headed-Session Policy

**Priority:** P0

**Task definition**

Define reproducible browser installation and headed-session rules while still
testing the shipping stable channel that end users receive.

**Necessary code changes**

- Add `crates/forge3d-web/tests/infrastructure/browser-policy.json` with:
  Chrome stable and Beta; Edge stable; Safari stable and Technology Preview;
  Firefox release and Nightly; driver/tool package versions; minimum allowed
  major versions; and each required/probe classification.
- On release-candidate creation, resolve channels to exact installed versions,
  freeze automatic browser/OS updates for the maximum 24-hour acceptance
  window, and write those versions to the evidence record. Re-enable updates
  immediately after the window.
- Install Playwright only for Chromium/Chrome/Edge automation, `/usr/bin/safaridriver`
  for desktop Safari, and pinned Selenium/geckodriver for branded Firefox.
  Install pinned Appium plus UiAutomator2 and XCUITest drivers on
  `FW-MAC-M2-01`.
- Configure an interactive login session on every host. Linux must run GNOME
  Wayland with a real display; Windows/macOS must not run browser acceptance in
  a disconnected or screen-locked session that disables GPU presentation.
- Add `crates/forge3d-web/scripts/capture-host-inventory.mjs` to record the
  exact versions and verify that prohibited browser flags are absent.

**Definition of done**

- Every required run is headed and records `headed: true`, display/session
  state, exact browser version, exact driver version, and OS build.
- Required Chrome/Edge/Safari/Firefox lanes use shipping stable/release
  browsers; Playwright WebKit/Firefox remain separate engine preflights.
- No required run uses an unsafe WebGPU flag, GPU-blocklist bypass, forced
  ANGLE/backend, or software-renderer flag.
- A browser version outside the checked policy fails before executing support
  assertions.
- Update freeze/unfreeze is automated and a cleanup step runs even after test
  failure.

## INF-02 — Prove A Hardware WebGPU Adapter Before Acceptance

**Priority:** P0

**Task definition**

Prevent a software adapter, disabled GPU process, or remote-session fallback
from producing false positive browser evidence.

**Necessary code changes**

- Add `crates/forge3d-web/tests/browser/adapter-attestation.ts` to record
  `navigator.gpu`, `adapter.info`, `adapter.info.isFallbackAdapter`,
  `device.adapterInfo` when the browser exposes it, required limits, device
  creation, surface presentation, and the browser's effective launch arguments.
  Empty or withheld adapter identity strings are valid and cannot alone fail a
  lane.
- Add host-side GPU evidence:
  `system_profiler SPDisplaysDataType` on macOS, PowerShell
  `Win32_VideoController` on Windows, and `lspci`, `nvidia-smi` where applicable,
  `loginctl`, `WAYLAND_DISPLAY`, and Mesa/NVIDIA driver data on Linux.
- Join page and host records by GitHub run ID, job ID, asset ID, commit, and
  package SHA-256. Treat adapter identity as test evidence, not a public runtime
  dependency.
- Fail required lanes when `adapter.info.isFallbackAdapter === true`, the
  expected physical GPU is absent, the headed session is unavailable, or a
  non-empty frame cannot be presented. If a shipping browser does not expose
  `adapter.info` or its required boolean, emit `ATTESTATION_UNAVAILABLE` and
  fail the required lane; host inventory cannot substitute for the missing
  page-level fallback determination.

**Definition of done**

- Unit negative controls for `isFallbackAdapter: true` and missing adapter
  information fail before browser acceptance. A separate
  isolated software-renderer probe may exercise the end-to-end failure path, but
  its prohibited launch flags never enter a support lane.
- Each baseline host proves the expected GPU and a non-fallback WebGPU adapter
  in the same headed job that runs the viewer; withheld descriptive strings do
  not weaken the required boolean or diagnostic corroboration.
- Intel and NVIDIA Linux records include Wayland session and installed driver
  evidence; the NVIDIA driver is no older than the May 2024 rollout boundary.
- A luma-changing presented frame and device/surface creation are both required;
  neither alone is considered hardware proof.

## INF-03 — Distribute One Packed Artifact Over Trusted HTTPS

**Priority:** P0

**Task definition**

Build once, verify once, and test the identical npm tarball on every host/device
through a publicly trusted HTTPS origin.

**Necessary code changes**

- Add `.github/workflows/browser-package.yml`, triggered by `push` to `main`
  and manually rerunnable only at `refs/heads/main`, with two GitHub-hosted
  jobs. `observe-package-trust` has
  `environment: forge3d-trust-observer`, receives the observer App key, runs
  live trust/epoch verification, and resolves the same-SHA successful
  `Web Runtime / Build And Contract Tests` and
  `Web Runtime / Browser Preflight` checks from the expected GitHub Actions
  App. It emits and attests the INF-00
  `repository-trust-observation.json`, bound to the exact protected-main source
  SHA, workflow path/ref/SHA, run ID/attempt, required-check IDs/conclusions/App
  IDs, policy/action-lock digests, and the
  `Browser Package / Build Trusted Artifact` consumer with no environment.
- The separate job with immutable display name
  `Browser Package / Build Trusted Artifact` must
  `needs: observe-package-trust`, receive no observer App key/token or
  environment, and accept `observation_artifact_id`, name, artifact digest, and
  content SHA-256 only from `needs.observe-package-trust.outputs`. It applies
  INF-00's exact-ID metadata/download checks—without a name/list fallback—then
  verifies the same-run hosted attestation,
  exact target/workflow/run/attempt/consumer binding, current
  policy/action-lock digests, and expiry before executing source or building.
  It checks out only
  the observation-bound full SHA with persisted credentials disabled, then runs
  FND-07's tarball-consumer builder exactly once and uploads:
  the `.tgz`, SHA-256 file, consumer fixture archive (including the exact test
  harness), evidence schema, commit metadata, source-tree status, and artifact
  attestation. Give `observe-package-trust` only the INF-00 observer
  permissions plus its environment-scoped App key. Give the build job only
  `actions: read`,
  `contents: read`, `id-token: write`, `attestations: write`, and
  `artifact-metadata: write`; all others are `none`. The fixed artifact name
  includes the full source SHA, not user input.
- Every physical job must download that artifact, verify SHA-256, install the
  `.tgz` into a new temporary consumer with
  `npm install --no-save <tarball>`, and refuse workspace/file dependencies.
- Use project-managed Cloudflare Tunnel as the fixed provider. Provision one
  non-load-balanced, host-scoped tunnel with two publicly trusted hostnames per
  host:
  - `mac-m2.webgpu-ci.forge3d.dev` and
    `assets-mac-m2.webgpu-ci.forge3d.dev`;
  - `win-i12.webgpu-ci.forge3d.dev` and
    `assets-win-i12.webgpu-ci.forge3d.dev`;
  - `linux-i12.webgpu-ci.forge3d.dev` and
    `assets-linux-i12.webgpu-ci.forge3d.dev`;
  - `linux-nv.webgpu-ci.forge3d.dev` and
    `assets-linux-nv.webgpu-ci.forge3d.dev`.
  The first is the application origin and the `assets-` hostname is the
  deliberately distinct CORS origin. Store each distinct, host-scoped tunnel
  token in the protected `forge3d-browser-lab` environment; never configure a
  single token as replicas across hosts.
- Add `crates/forge3d-web/scripts/create-run-nonce.mjs`, using
  `crypto.randomBytes(16).toString("hex")`, to create an independent 128-bit
  nonce for each job. Both origins serve only
  `/runs/<github-run-id>/<job-id>/<32-lowercase-hex-nonce>/`; a run ID or job ID
  alone is never a valid path. The nonce cannot be supplied as a workflow input;
  a contract test spies on `randomBytes(16)`, rejects malformed values, and
  rejects nonce reuse within a run.
- Add `crates/forge3d-web/tests/infrastructure/https-origin-policy.json` for the
  four exact host pairs and
  `crates/forge3d-web/scripts/serve-browser-fixture.mjs` to validate `Host`,
  base path, nonce, method, `Origin`, MIME, range, and route policy before
  reading a fixture. Contract tests send every allowed/denied Host/Origin/path
  combination and compare the complete response-header set.
- Serve application HTML, JavaScript, correct/wrong-MIME WASM fixtures, and
  same-origin terrain from the application origin with cache disabled and
  `.wasm -> application/wasm` except at the intentional wrong-MIME route.
  Implement these asset-origin routes exactly:
  - `/cors/allow/terrain.bin` returns
    `Access-Control-Allow-Origin: https://<exact-application-host>`,
    `Vary: Origin`, `Access-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range`,
    and `Accept-Ranges: bytes`; preflight permits `GET, HEAD, OPTIONS` and
    `Access-Control-Allow-Headers: Range`;
  - valid byte requests return `206` with the same CORS headers plus exact
    `Content-Range` and `Content-Length`;
  - `/cors/deny/terrain.bin` returns no
    `Access-Control-Allow-Origin` or related allow headers;
  - `/cors/wrong-origin/terrain.bin` returns
    `Access-Control-Allow-Origin: https://invalid.example`.
  Mirror the allow, deny, and wrong-origin policies at
  `/cors/<policy>/forge3d_web_bg.wasm`, always using
  `Content-Type: application/wasm`, so FND-01 can prove cross-origin WASM success
  and browser-enforced CORS failure independently of the wrong-MIME fixture.
  Stop the connector and delete both origins' temporary consumer/run paths in
  unconditional cleanup; pre-provisioned DNS remains.
- Add a readiness probe from each mobile device that verifies both public
  certificate chains, exact run/job/nonce path, package SHA-256, WASM MIME,
  allowed and denied cross-origin behavior, and range response before tests.

**Definition of done**

- One successful, attested `browser-package.yml` run exists at the exact
  protected-main commit; every required physical/manual job names that same
  `packageRunId` and reports the same package SHA-256. No physical promotion
  rebuilds the tarball.
- Workflow contract tests prove only `observe-package-trust` references
  `forge3d-trust-observer` or its App secret, the build job `needs` it and has no
  environment/observer credential, and its artifact ID/name/digests come only
  from the fixed observer outputs. A missing/swapped/non-decimal ID,
  ID/metadata/digest/content disagreement, name-based lookup, expired artifact,
  prior-run/attempt, wrong-SHA/check/App/policy/lock/consumer, or wrongly
  attested observation fails before source execution or package creation.
- Browser/device traffic uses a publicly trusted HTTPS certificate; no
  `--ignore-certificate-errors`, installed private CA, or insecure-context
  exception is used.
- A fixture intentionally served with the wrong WASM MIME returns
  `WASM_LOAD_FAILED`; correct MIME succeeds.
- Same-origin terrain and the exact allowed cross-origin route succeed; the
  absent-allow and wrong-origin routes fail in the browser. The range fixture
  proves both `206` success and CORS exposure of `Content-Range`.
- Cross-origin WASM succeeds only on the exact allow route; the deny and
  wrong-origin routes both return normalized `WASM_LOAD_FAILED`.
- A stale/mismatched tarball, workspace `file:` dependency, failed tunnel probe,
  invalid/predictable nonce, CORS misconfiguration, or different package hash
  fails closed.
- Tunnel processes, run-specific served paths, temporary consumers, and
  downloaded artifacts are removed from hosts after the job.

## INF-04 — Implement Trusted Physical Runner Orchestration

**Priority:** P0

**Task definition**

Provide trusted-commit workflow mechanics for physical tasks without assigning
their browser-specific assertions to this infrastructure plan or ever executing
fork-controlled code on a persistent runner.

**Necessary code changes**

- Add `.github/workflows/browser-hardware.yml` with `workflow_dispatch` as its
  only trigger. It accepts enumerated `lane`, `assetId`, `required`, plus a
  required full 40-hex `trusted_sha`, required decimal `packageRunId`, optional
  decimal `labReadinessRunId`, optional enumerated `canaryMode`, and optional
  decimal `intakeReleaseId`. Apply these closed input rules:
  - `infrastructure-canary` requires `canaryMode: host|manual`, rejects
    `labReadinessRunId`, requires `intakeReleaseId` only for `manual`, and
    rejects it for `host`;
  - a product manual-session lane rejects `canaryMode` and requires both
    `labReadinessRunId` and `intakeReleaseId`;
  - every browser-family lane rejects `canaryMode`/`intakeReleaseId` and
    requires `labReadinessRunId`.
  Promotion reads and verifies any draft intake's attested manifest rather than
  trusting duplicated session fields. Reject unless
  `github.ref == "refs/heads/main"` and the recorded workflow-definition SHA is
  a strict post-epoch commit still reachable from current protected `main`;
  this protects the workflow code independently from `trusted_sha`. The
  workflow has no `pull_request`,
  `pull_request_target`, `push`, or untrusted `workflow_call` entry point.
  Lane values are closed enumerations: `infrastructure-canary` is the only
  pre-laboratory-gate lane and performs no browser support assertion. That lane
  also owns the generic challenge-bound manual-session canary used by the
  laboratory gate; it does not dispatch either product manual-session lane.
  browser-family lanes and INF-05 product manual-session lanes download the
  exactly named manifest artifact from `labReadinessRunId`, verify its hosted
  attestation and successful workflow/job identity, and require its
  `browser-lab-infrastructure-readiness` result and
  `labInfrastructureDigest` matches the target's matrices, policies,
  workflow-actions lock, trust-observation protocol, runner distribution and
  transient-path manifests, infrastructure workflows, controller and
  registration-broker versions, HTTPS server, and evidence schemas
  byte-for-byte.
- Before any hardware job is eligible, a GitHub-hosted
  `observe-hardware-trust` job references only `forge3d-trust-observer`, runs
  `verify-repository-trust.mjs`, and emits the INF-00 observation bound to
  `trusted_sha`, this run/attempt, and the `promote-hardware` consumer job. The
  separate GitHub-hosted promotion job has no observer key/token, `needs` that
  observer, applies the INF-00 four-output exact-ID handoff, and verifies the
  exact observation before checking through the
  GitHub API and `git merge-base --is-ancestor` that `trusted_sha` exists in the
  base repository, is a strict descendant of `trustEpochSha`, is reachable from
  the observation's current protected `main`, and has successful exact-SHA runs
  for both policy-pinned required checks from the expected GitHub Actions App.
  A fork head, arbitrary branch SHA, merge ref, tag-only object, pre/at-epoch
  commit, unprotected policy, failed/missing check, unresolved abbreviated SHA,
  or missing/stale/mismatched observation fails on GitHub-hosted infrastructure.
  Promotion also resolves `packageRunId` to exactly one
  successful `.github/workflows/browser-package.yml` run at `trusted_sha` and
  `refs/heads/main`, requires its fixed job/artifact names and GitHub-hosted
  attestation, and rejects a package run from any other event, ref, SHA,
  attempt, workflow, signer, or source digest.
- The promotion job checks out only
  `repository: milos-agathon/forge3d-web`,
  `ref: <trusted_sha>`, with `persist-credentials: false` and `fetch-depth: 0`
  on the GitHub-hosted runner so reachability is testable. Grant the observer
  only `actions: read`, `checks: read`, `contents: read`, `id-token: write`,
  `attestations: write`, and `artifact-metadata: write`, plus its
  environment-scoped App key; grant promotion only
  `actions: read`, `contents: read`, `checks: read`, `id-token: write`, and
  `attestations: write` plus `artifact-metadata: write`; it downloads and
  verifies the single INF-03 package/harness, uploads a run-scoped copy plus a
  manifest binding `packageRunId` and the original subject digests, and attests
  the copied package, harness, and manifest with
  `actions/attest@<reviewed-40-hex-commit> # v4.x.y`. It never
  rebuilds the package. The
  ephemeral job performs no source checkout and
  executes only the downloaded package/harness after
  SHA-256 and `gh attestation verify` succeed with all of:
  `--repo milos-agathon/forge3d-web`,
  `--signer-workflow milos-agathon/forge3d-web/.github/workflows/browser-hardware.yml`,
  `--source-ref refs/heads/main`,
  `--source-digest <recorded-workflow-run-sha>`, and
  `--deny-self-hosted-runners`. The signed package manifest separately binds
  the validated `trusted_sha` used for the checkout.
- In the promotion job, map `assetId` to one hard-coded `hw-*` label from the
  checked matrix and its owning physical `hostId`, generate a
  cryptographically random 128-bit `runner_nonce`, and expose only
  `jit-<32-lowercase-hex-runner-nonce>` as the third runner label. Every
  Android/iOS/iPadOS asset and `FW-TRACKPAD-01` maps to host
  `FW-MAC-M2-01`. The hardware job's YAML `runs-on` list contains exactly
  `forge3d-web`, that mapped static `hw-*` label, and the promotion-job nonce
  label; no dispatch input can supply a label.
- Start two sibling jobs after promotion: the hardware job becomes queued on
  those labels, while a GitHub-hosted `authorize-runner` job polls the current
  run-attempt jobs API until exactly one queued hardware job has the expected
  name and labels. It allows up to 15 minutes for the protected-environment
  review to move the hardware job from `waiting` to `queued`, then fails on
  zero queued matches or multiple matches.
  It then writes canonical
  `crates/forge3d-web/tests/infrastructure/runner-authorization.schema.json`
  data as `runner-authorization.json`, binding schema version, repository
  ID/name, workflow path/ref/SHA, event, run ID/attempt, promotion and
  authorization job IDs, queued hardware job ID/name, validated
  `trusted_sha`, `trustEpochSha`, lane, asset ID, owning host ID, nonce label,
  derived runner name, ordered three-item custom-label set,
  `repositoryJitRunnerGroupId`, JIT work folder, package promotion run ID,
  package/harness manifest digest, issue/expiry timestamps, the verified
  laboratory-readiness run ID/digest when required, and (for a manual session)
  intake release ID/checklist/media challenge. Expiry is ten minutes after
  issue.
- The GitHub-hosted authorization job uploads that record as artifact
  `runner-authorization-<runner-nonce>` and attests it with
  `actions/attest@<reviewed-40-hex-commit> # v4.x.y`. Its only permissions are
  `actions: read`,
  `contents: read`, `id-token: write`, `attestations: write`, and
  `artifact-metadata: write`; all others are `none`. The attestation must bind
  the exact repository, signer workflow, protected source ref, and workflow-run
  source digest with `--deny-self-hosted-runners`.
- Add audited controller source and unit/negative tests under
  `tools/browser-lab-controller/` plus per-OS service definitions in
  `tools/browser-lab-controller/services/`. Add
  `.github/workflows/browser-lab-controller.yml`, dispatched only from
  protected `main` on GitHub-hosted runners. Its
  `observe-controller-package-trust` job is the only job in
  `forge3d-trust-observer`; it verifies live policy/strict post-epoch source and
  emits an observation bound to the separate `package-controller` job. That
  package job receives no observer secret, applies the INF-00 four-output
  exact-ID handoff to verify the unexpired observation, then tests/packages the
  controller and attests its versioned archive with
  `actions/attest@<reviewed-40-hex-commit> # v4.x.y` and explicit
  `contents: read`,
  `id-token: write`, `attestations: write`, and
  `artifact-metadata: write`. Each host administrator verifies the exact signer
  and digest before installing that pinned archive outside both the repository
  and Actions runner directories.
  Add its checked protocol contract in
  `crates/forge3d-web/tests/infrastructure/controller-protocol.schema.json`.
  A controller obtains the queued job's run/job IDs and nonce only from the jobs
  API, downloads the exactly named authorization artifact from that run
  attempt, validates its schema/expiry, recomputes its digest, and verifies its
  GitHub-hosted attestation and exact signer/source constraints. It then
  cross-checks every API-visible run/job field and label against the signed
  record and requires the promotion and authorization jobs to be completed
  successfully. It never attempts to infer promotion outputs or dispatch inputs
  from the jobs/run API and refuses zero or multiple matching queued jobs.
- Give the ephemeral hardware job exactly `actions: read`, `contents: read`,
  and `attestations: read`; set every other `GITHUB_TOKEN` permission to
  `none`. It performs no checkout and receives no `id-token` or repository
  write permission. Before executing, it verifies the authorization, package,
  and harness subjects by digest and exact GitHub-hosted signer/source policy;
  an offline attestation fallback is not permitted.
- Only after that validation, the controller prepares the verified runner
  archive in a fresh controller-owned
  `jobs/<runner-nonce>/runner/` install root whose relative work directory is
  `_work`, verifies the archive SHA-256 and complete immutable distribution
  manifest with no extra path, and records the pre-run manifest result. It then
  sends its signed authorization digest, queued-job identity, and one-time
  request nonce over mTLS to the broker's `/v1/jit-config` operation.
  The controller receives only the broker-returned runner ID/name and opaque
  `encoded_jit_config`; it receives no GitHub App installation token,
  registration token, remove token, or Administration-capable credential. It
  compares the returned ID/name to the authorization-derived expected name and,
  within the broker's two-minute `startDeadline`, without invoking
  `config.sh`/`config.cmd`, spawns exactly
  `./run.sh --jitconfig <encoded_jit_config>` on macOS/Linux or
  `run.cmd --jitconfig <encoded_jit_config>` on Windows as an argv vector, with
  shell tracing and command echo disabled. Hold the encoded configuration only
  in process memory until spawn, overwrite that buffer immediately afterward,
  never place it in an environment variable/file/log/artifact/child-browser
  environment, capture the runner exit status, and accept no second job.
- While the listener is running, the controller polls the exact job and broker
  state. If the runner enters `online_unassigned` and the INF-00
  `assignmentDeadline` expires without the authorized job becoming
  `in_progress`/the exact runner becoming busy, it independently proves the job
  is still queued, terminates and awaits the local runner process, signs the
  stop result, and calls `/v1/cleanup-runner` with reason
  `online_unassigned`. It never launches a replacement from the same
  authorization.
- In all controller cleanup paths, terminate the local runner process after its
  one job, launch failure, or assignment timeout and call only the broker's
  `/v1/cleanup-runner` operation; the controller never calls a repository runner
  mutation or workflow-cancellation endpoint. Re-verify every immutable
  distribution-manifest entry, reject unknown paths except the exact transient
  policy, and forward runner `_diag` logs to protected storage outside the
  install root. Wait for the broker's exact-ID
  `deleted|already_absent` decision and, for `online_unassigned`, its exact-run
  cancellation result; only then wipe the complete `jobs/<runner-nonce>/`
  directory. A broker failure or
  `quarantined`/busy result is an infrastructure failure that leaves the host
  lock held and blocks new JIT issuance for that host until broker/API
  reconciliation proves the authorized runner absent. Do not leave a warm,
  reusable, or idle registered runner.
- Add one cross-run concurrency group per owning physical host:
  `forge3d-browser-host-<hostId>`, with `cancel-in-progress: false`. The
  controller acquires the corresponding OS-level exclusive host lock before
  requesting JIT issuance and holds it through broker-confirmed runner cleanup
  plus update/tunnel/browser/Appium cleanup.
  Device-level locks may be additional but never replace the host lock. Add a
  protected
  `forge3d-browser-lab` environment with required reviewers and
  prevent-self-review, protected-branch deployment rules, a 30-minute timeout,
  for automated/infrastructure lanes, a 45-minute timeout for manual lanes whose
  capture interval is exactly 20 minutes, pre/post inventory, update unfreeze,
  tunnel cleanup, and artifact upload in `if: always()` steps. Environment
  approval is defense in depth, not permission to execute untrusted code.
- Expose a browser-neutral command that browser plans call with their own
  project/driver name and the shared FND-07 assertion payload.

**Definition of done**

- A dry-run workflow dispatch reaches every host, downloads/verifies the package,
  opens a headed browser, runs an adapter smoke test, uploads schema-valid
  evidence, auto-deregisters its one-job runner, and cleans up.
- Two jobs cannot use the same physical host concurrently. Negative scheduling
  tests prove desktop Safari, trackpad, and every mobile asset all serialize on
  `FW-MAC-M2-01`, while jobs on different hosts may proceed independently.
- A fork SHA and an unmerged base-repository feature-branch SHA both fail before
  any ephemeral runner is registered. Static workflow tests fail if a PR
  trigger, arbitrary `workflow_call`, user-controlled runner label, hardware
  source checkout, `config.sh`/`config.cmd`, the registration-token endpoint, a
  runner start without `--jitconfig`, or unverified artifact execution is
  introduced.
- Pull requests from forks cannot schedule a hardware runner or access
  lab/tunnel/signing secrets; review or environment approval cannot override
  this prohibition.
- Negative controller tests refuse a wrong repository/workflow/ref/SHA,
  absent/tampered/wrong-signer/expired authorization, authorization-to-job or
  package-digest mismatch, unpromoted or duplicate queued job,
  stale/malformed/reused nonce, static-only label match, occupied host lock, or
  missing/unexpected custom label. GitHub-generated read-only platform labels
  are recorded separately and never replace the exact custom set. A controller
  compromise is limited to its one
  installed repository's read-only Actions/Attestations metadata and cannot
  administer or mutate the repository or read repository secrets. The
  repository is public, so confidentiality of source is not a boundary; the
  hardware execution path still forbids source checkout or execution.
- Broker contract tests reject an unauthenticated controller, invalid
  controller signature, replayed request nonce, absent/invalid authorization,
  policy drift, wrong queued job/labels/host, caller-supplied runner
  configuration, invalid JIT group, second JIT retrieval, cleanup for an
  unissued/mismatched/busy runner, cleanup replay, or wildcard deletion.
  A never-online runner is exact-ID deleted after the two-minute
  `startDeadline`, and no second JIT configuration is issued from the same
  authorization. An online-idle runner enters `online_unassigned`; after the
  90-second assignment deadline the positive fixture proves the listener stop,
  exact job is still queued, exact runner is not busy, exact-ID deletion, and
  exact bound-run cancellation. Negative fixtures where the job becomes
  `in_progress`, the runner becomes busy, the runner tuple changes, or the
  deadline has not elapsed perform neither deletion nor cancellation.
  Negative HTTP-client tests fail if the broker calls the registration-token,
  remove-token, label-mutation, non-exact runner-deletion, dispatch, rerun,
  artifact, or any workflow-cancellation endpoint other than cancellation of
  the exact ledger-bound run after the assignment-timeout predicates. A
  different run ID or cancellation in any other lifecycle state fails. Service
  deployment evidence binds the broker binary/configuration digest, and a
  credential inspection proves no broker private key is present on a
  controller or Actions runner.
- Static workflow tests require the hardware job's exact three read permissions
  and reject any write, `id-token`, checkout, unverified/offline attestation, or
  controller reliance on non-API-visible workflow outputs.
- Input/manifest negative tests prove a product lane cannot omit, substitute,
  or reuse a laboratory-readiness run with the wrong commit/digest, and an
  `infrastructure-canary` dispatch cannot supply or consume a laboratory
  readiness result.
- Trust-observer API inspection plus the broker ledger proves no runner remains
  registered at idle, every returned runner ID/name/custom-label tuple matches
  its authorization, every runner accepted at most one workflow job, and every
  normal, cancelled, timed-out, never-online, online-unassigned, or
  launch-failed lifecycle ends `deleted|already_absent` before the host lock is
  released; the online-unassigned run is cancelled rather than left queued.
- Cancelling or timing out a run still restores update policy, stops drivers and
  tunnels, and uploads cleanup diagnostics.
- Browser-specific project and pass/fail ownership remains in
  CHR/SAF/FFX/MOB tasks.

## INF-05 — Implement Mobile Device Control And Authenticated Manual Evidence

**Priority:** P0

**Task definition**

Make Android Chrome and iOS/iPadOS Safari executable on the named physical
devices, while requiring authenticated, attested manual checks for mobile
gestures and desktop trackpad behavior that automation cannot faithfully
reproduce.

**Necessary code changes**

- Add `crates/forge3d-web/tests/device/device-matrix.json` mapping public device
  IDs to Appium capabilities without storing UDIDs/serials.
- Add pinned Appium configurations:
  UiAutomator2 with Chrome for Android and XCUITest with `browserName: Safari`
  for iPhone/iPad. Use a dedicated non-personal Apple Developer CI signing
  identity for WebDriverAgent, held in the protected lab environment.
- Add `crates/forge3d-web/tests/manual/mobile-multitouch.md` with exact steps for
  one-finger orbit, two-finger pan/pinch, S Pen/Apple Pencil orbit, pointer
  cancellation, page-scroll isolation, orientation change,
  background/foreground, unsupported UI, and mandatory
  `SESSION_CHALLENGE_VISIBLE` confirmation. Every selected screenshot/video
  must visibly contain the non-dismissable session watermark; the independent
  environment approver rejects unreadable or missing challenges.
- Add `crates/forge3d-web/tests/manual/infrastructure-manual-canary.md` with only
  session-open, visible-challenge, authenticated-media-upload, and
  session-cleanup step IDs. It must not contain or satisfy a Forge3D product
  interaction assertion and is accepted only by
  `infrastructure-canary`/`canaryMode: manual`.
- Add `.github/workflows/prepare-browser-manual-evidence.yml`, dispatchable
  only from the protected default branch. Its GitHub-hosted
  `observe-manual-intake-trust` job has
  `environment: forge3d-trust-observer`, runs the live verifier, and emits the
  INF-00 observation bound to the input `trusted_sha` and the
  `prepare-manual-intake` consumer job/environment. The separate consumer job
  has `environment: forge3d-manual-evidence`, required reviewers,
  prevent-self-review, protected-branch rules, and admin bypass disabled; it
  receives no observer key/token, applies the INF-00 four-output exact-ID
  handoff, and verifies the same-run observation after approval and before any
  tag/release write. The workflow accepts a full
  validated `trusted_sha`, decimal `packageRunId`, enumerated checklist ID, and
  exact asset ID. The consumer requires the SHA to equal the observation target
  and be a strict post-`trustEpochSha` descendant reachable from the
  observation's current `main`, resolves the package run using INF-03/04's
  exact workflow/job/ref/SHA/signer rules, derives—not accepts—the package
  SHA-256 from its attested manifest, and requires the
  asset/checklist pair to be active in the checked matrices. The closed
  checklist enumeration is `infrastructure-manual-canary`,
  `mobile-multitouch`, or `safari-trackpad`; the first is marked
  `"supportClaim": false` in its intake manifest and cannot be used by the
  product evidence-submission workflow. The observer uses only the standard
  INF-00 read/attestation permissions plus its environment App key. Declare for
  the consumer only
  `contents: write`, `actions: read`, `id-token: write`,
  `attestations: write`, and `artifact-metadata: write`; with those explicit
  permissions it creates an unpublished draft release and tag
  `manual-evidence-intake-<prepare-run-id>` targeted at `trusted_sha`, then
  uploads and attests an `intake-manifest.json` with
  `actions/attest@<reviewed-40-hex-commit> # v4.x.y`. That
  manifest binds the
  prepare run/attempt, source workflow/ref/SHA, package promotion run ID/hash,
  checklist version, selected asset and owning host, expected tester, a
  cryptographically random 128-bit `mediaChallenge`, and an expiry no later
  than 24 hours. The expected tester is the authenticated prepare-workflow
  `github.actor`, never an input.
- Add closed INF-04 manual-session lanes
  `manual-mobile-multitouch` and `manual-safari-trackpad`. Promotion requires
  the intake release ID, verifies the draft/manifest attestation, exact
  tester/SHA/package/checklist/asset/host/expiry, and copies its manifest digest
  plus media challenge into `runner-authorization.json`. The normal
  `forge3d-browser-host-<hostId>` workflow concurrency and controller lock
  reserve the entire host; a mobile/trackpad session can never overlap desktop
  Safari, another device, a performance lane, or another manual session.
- Add
  `crates/forge3d-web/tests/infrastructure/manual-session.schema.json` and
  controller endpoints that generate—not accept from runner input—one
  `manual-session.json`. For a fixed 20-minute session, the controller records
  repository/workflow/run/attempt and hardware job IDs, authorization and
  intake-manifest digests, broker-returned runner ID/name, trusted SHA,
  package/harness digest, host/asset IDs, package promotion run ID, controller
  key ID, OS/build,
  browser/channel/version, driver/Appium versions, headed/login state,
  application/asset origins, route run/job/nonce path, media challenge, UTC
  start/end, and browser/fixture/update/tunnel cleanup results. It signs
  canonical bytes with the host's INF-00 key.
- In the manual hardware job, verify/install the same artifact as automation,
  start INF-03's exact nonce-bound HTTPS fixture, launch the required branded
  browser on the selected physical asset, and render a non-dismissable
  `mediaChallenge` watermark without altering the viewer canvas. Keep the
  browser, route, host lock, and update freeze active for the complete
  20-minute capture window. The tester performs the checked steps and uploads
  media during that window; release-asset `created_at` outside the signed window
  is invalid. Cleanup then stops browser/driver/fixture/tunnels, restores
  updates, and uploads the signed session record before the ephemeral job exits.
- Add a GitHub-hosted `finalize-manual-session` job with `if: always()` after the
  hardware job. It downloads the session record, verifies the pinned controller
  signature/authorization/schema, requires the hardware job and signed cleanup
  fields to have succeeded, cross-checks the signed runner ID/name against the
  workflow-job API, then polls the repository runners API for at most
  five minutes until the exact authorization-bound runner ID and name are
  absent. For these list/get calls it runs in the separate
  `forge3d-trust-observer` environment, mints a short-lived installation token
  from that App's `Administration: read` credential, and destroys the token
  after polling; its `GITHUB_TOKEN` is not treated as runner-read authority.
  As the enumerated observer/finalizer exception, it emits and attests the
  operation-qualified INF-00 trust observation itself, binding the signed
  runner ID/name, authorization digest, terminal job state, absence-response
  digests, this run/attempt, and its own
  `finalize-manual-session`/`forge3d-trust-observer` job/environment pair.
  Static workflow tests prove the observer secret/token is referenced only by
  this GitHub-hosted job and never propagated through outputs, artifacts, the
  hardware job, or controller cleanup. It fails closed if deregistration is not
  observed, and only then attests the signed record with
  `actions/attest@<reviewed-40-hex-commit> # v4.x.y`. Its only `GITHUB_TOKEN`
  permissions are
  `actions: read`, `contents: read`, `id-token: write`,
  `attestations: write`, and `artifact-metadata: write`; all others are `none`.
  Failure produces a non-acceptable diagnostic artifact, never a session
  attestation.
- Document the only media-ingestion command in
  `crates/forge3d-web/docs/browser-lab-runbook.md`: the authenticated tester
  must be a named `milos-agathon/forge3d-web` collaborator with repository
  `write` (not `admin`) access, signs into GitHub CLI as the expected tester,
  and runs
  `gh release upload <intake-tag> <local-media-files>` without `--clobber`.
  This uploads bytes to the draft release; `workflow_dispatch` never receives a
  local path or file. Permit only `.png`, `.jpg`, `.jpeg`, `.webm`, and `.mp4`,
  at most 100 MiB per file and 500 MiB per checklist, with names unique within
  the intake release.
- Add `.github/workflows/submit-browser-manual-evidence.yml`, dispatchable only
  from the same protected default branch. Its GitHub-hosted
  `observe-manual-submission-trust` job is separately bound to
  `forge3d-trust-observer` and emits an observation for the exact intake target
  SHA, run/attempt, and `submit-manual-evidence` consumer. That consumer alone
  references `forge3d-manual-evidence`, receives no observer secret, and
  applies the INF-00 four-output exact-ID handoff to verify the unexpired
  observation before accepting evidence. Accept only the
  numeric intake release database ID, an ordered list of numeric release-asset
  database IDs, exact manual-session workflow `run_id`, exact hardware `job_id`, and
  `step_results` as scalar dispatch inputs. `step_results` is a
  canonical JSON object whose keys must equal the attested checklist's complete
  checked-in step-ID set and whose values are only `"pass"` or `"fail"`; reject
  missing/extra keys and all other values. Reject user-supplied paths, URLs,
  usernames, digests, complete evidence JSON, arbitrary checklist fields, and
  media names. Verify that the intake release is still a non-expired draft, its
  exact tag/target commit match the attested intake manifest, and the
  manifest's attestation has the exact prepare-workflow signer, protected
  source ref, source digest, and repository with
  `--deny-self-hosted-runners`.
- Retrieve the completed manual-session run/job and its attested signed session
  record by the supplied IDs. Require workflow path/ref/SHA, successful
  conclusion, controller signature/key, authorization/intake digests,
  trusted SHA, package, host/asset, OS/browser/driver tuple, route nonce,
  media challenge, and capture window to match. The GitHub-hosted finalizer
  attestation must satisfy exact repository/signer/source constraints and
  `--deny-self-hosted-runners`; the independently verified controller signature
  is the trust source for host observations.
- Before generating evidence, resolve every selected release asset through the
  GitHub API and require its immutable database ID, `uploader.login`, name,
  byte size, MIME type, `created_at`, and API SHA-256 digest to satisfy the
  manifest and allowlist. Download by asset ID, recompute SHA-256 over the bytes,
  require both digests to match, and require every `uploader.login` plus
  `github.actor` to equal the manifest's expected tester. Require every media
  asset's `created_at` to fall within the signed manual-session window and bind
  the session's media challenge into the final record. Reject overwritten,
  duplicate, expired, or post-submission media; the release-asset inventory
  must equal the one workflow-uploaded `intake-manifest.json` plus exactly the
  selected media IDs.
- Accept only enumerated `mobile-multitouch` and `safari-trackpad` checklist IDs
  and their checked-in step IDs from the attested intake manifest. The submit
  workflow generates the evidence JSON; it binds the
  authenticated `github.actor`, repository and workflow IDs, run/attempt,
  protected-environment deployment and approving-reviewer IDs, release tag,
  trusted commit, package SHA-256, checked inventory asset ID, OS/browser
  version, UTC timestamp, pass/fail per enumerated step, prepare run/intake
  release ID, manual-session run/job/authorization/controller-signature/route
  challenge, and verified screenshot/video asset IDs, uploaders, sizes, MIME
  types, timestamps, and digests.
- Add `crates/forge3d-web/scripts/validate-manual-evidence.mjs`. Without accepting
  identity inputs, it compares the previous immutable release tag (or
  repository baseline `ffba491` for the first release) with `trusted_sha`,
  enumerates every commit in that range, resolves each associated merged PR
  author plus directly committed GitHub author/committer logins, and fails if
  an identity cannot be resolved. It
  rejects a `github.actor` in that implementer set or equal to the environment
  approver, validates every bound field/digest, and verifies the exact
  environment, `approved` state, and approving user ID through
  `GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals`.
- Sign the generated JSON and media bundle with
  `actions/attest@<reviewed-40-hex-commit> # v4.x.y`; require
  `id-token: write`, `contents: read`, `actions: read`,
  `pull-requests: read`, `attestations: write`, and
  `artifact-metadata: write`, then verify the retained bundle with
  `gh attestation verify`, requiring the exact repository, signer workflow
  `.github/workflows/submit-browser-manual-evidence.yml`, protected default
  source ref, recorded workflow-run source digest, and
  `--deny-self-hosted-runners`.
  If artifact attestations are unavailable for the repository, this task fails
  closed until a protected verifiable-signature mechanism is approved.
- Never log UDID, Android serial, Apple team ID, or signing material.

**Definition of done**

- Appium opens the run-specific HTTPS fixture and completes every automatable
  assertion on all six devices.
- Each release candidate has one schema-valid, provenance-verified manual
  checklist per mobile device plus one for `FW-TRACKPAD-01`, from an
  authenticated tester other than an implementation PR author and an
  independent protected-environment approver. Each checklist
  resolves to one completed successful manual-session run/job with a valid
  controller signature and hosted finalizer attestation.
- Missing, stale, mismatched-commit/hash, unsigned, or failed manual evidence
  blocks MOB-05/MOB-06.
- The Safari trackpad checklist is bound to both `FW-MAC-M2-01` and
  `FW-TRACKPAD-01`, including the captured firmware/transport/topology, and the
  same exact Safari/macOS/commit/package tuple as SAF-03; missing or failed
  evidence blocks SAF-04.
- Video/screenshot names, GitHub asset IDs, authenticated uploaders, API and
  recomputed SHA-256 digests, and byte counts resolve within the same retained
  evidence bundle; every media upload timestamp is inside the signed session
  window and the evidence binds the displayed session challenge.
- Negative tests for a different uploader, overwritten/duplicate asset,
  mismatched API/recomputed digest, unlisted MIME/extension, expired intake,
  extra/missing checklist step, wrong/incomplete/session run or job,
  controller/authorization/host/asset/browser/package/route/challenge mismatch,
  or media outside the session window fail before final evidence attestation.
- Finalizer contract tests fail when the runner ID/name differs from the signed
  session/job record, the trust-observer installation token is absent/expired,
  the code substitutes `GITHUB_TOKEN` for repository-runner reads, the runner
  remains present after five minutes, or the observer credential is referenced
  by any self-hosted job.
- Manual-workflow contract tests prove `prepare-manual-intake` and
  `submit-manual-evidence` reference only `forge3d-manual-evidence`, receive no
  observer secret/token, and reject a missing, expired, prior-attempt,
  wrong-target/operation/consumer/environment, or wrongly attested trust
  observation before any intake/evidence write.
- The intake draft remains available until INF-06 has copied and byte-verified
  every selected media asset in the final immutable release. Only then may the
  workflow delete the intake draft/tag; failed or incomplete publication keeps
  the intake for audit and retry.
- Device disconnect, lock, trust prompt, browser crash, or WebDriverAgent
  signing failure is reported as infrastructure failure, never a skipped pass.
- INF-03 route cleanup occurs only after the signed capture window ends; later
  submission remains verifiable from the signed route nonce/session record and
  cannot invent inventory values after cleanup.

## INF-06 — Retain, Publish, And Audit Release Evidence

**Priority:** P0

**Task definition**

Make exact-head physical results discoverable and prevent a prior commit or
partial matrix from satisfying a release gate.

**Necessary code changes**

- Add `crates/forge3d-web/scripts/merge-browser-evidence.mjs` to validate and
  merge host, page, package, automation, and manual records into one release
  manifest.
- Upload individual job evidence for 90 days through GitHub Actions. Add the
  repository-admin prerequisite to enable **Settings > Releases > Enable release
  immutability** before the first candidate; this affects only releases created
  after it is enabled. If the setting is unavailable for the repository, INF-06
  fails closed and release evidence is not described as immutable.
- Add `.github/workflows/publish-web-release.yml` with `workflow_dispatch` as
  its only trigger, accepted only from protected `main`. Require a full 40-hex
  `target_sha`, decimal `readinessRunId`, and a
  package-version-matching SemVer tag; reject abbreviated SHAs, tags, other
  refs, fork objects, or a tag/release that already exists.
  A GitHub-hosted `observe-release-publication-trust` job has
  `environment: forge3d-trust-observer`, runs the live verifier, and emits the
  INF-00 observation bound to `target_sha`, tag, this run/attempt, and exactly
  the `validate-release-candidate`/no-environment and
  `publish-release`/`forge3d-web-release` consumers. A separate GitHub-hosted read-only
  `validate-release-candidate` job receives no observer secret, applies the
  INF-00 four-output exact-ID handoff to verify that observation, and requires
  `target_sha` to be a strict post-`trustEpochSha`
  descendant reachable from its recorded current `main`, verifies it is the
  exact SHA in the attested manifest from the supplied successful
  `readinessRunId`/`browser-hardware-release-readiness` job, and matches every
  package and evidence record. It emits an attested
  `release-publication-preflight.json` bound to the observation artifact ID,
  name, artifact digest, content SHA-256, run/attempt, target/tag, readiness
  record, complete asset digest set, and protected publisher job. Validation
  code is checked out only at the protected
  workflow definition SHA (`github.workflow_sha`); neither read-only job checks
  out or executes files from `target_sha`.
- Add `.github/workflows/publish-browser-lab-canary.yml` as the only
  pre-release-matrix publication path. It is dispatchable only from protected
  `main`, derives its candidate exclusively from the workflow run SHA, accepts
  only the four numeric host-canary run IDs plus the numeric generic
  manual-canary run/intake/hardware-job IDs, accepts no source ref or
  support-matrix input, and publishes a fixed
  non-support tag namespace
  `browser-lab-canary-<labInfrastructureDigest>-<run_id>`. A GitHub-hosted
  `observe-lab-canary-publication-trust` job alone references
  `forge3d-trust-observer` and emits an observation bound to the derived
  candidate, fixed tag, run/attempt, and exactly the canary
  preflight/no-environment plus canary-publisher/`forge3d-web-release`
  consumers. A separate read-only
  preflight receives no observer secret, applies the INF-00 four-output
  exact-ID handoff to verify that observation and a strict post-epoch protected
  workflow SHA, and resolves those exact successful
  `infrastructure-canary` records into the complete closed host/manual set,
  computes the prospective laboratory digest, and verifies the
  release-immutability setting, package/intake/session subject attestations, and
  absence of the proposed tag/release. It emits the same attested preflight
  schema with `supportClaim: false`. Its protected mutation job uses the same
  independent-actor/environment rules and least-privilege publication
  permissions as `publish-web-release.yml`, but it uploads only synthetic
  canary assets and a manifest marked `"supportClaim": false`. It cannot invoke,
  emit, or satisfy
  `browser-hardware-release-readiness`. Its publication workflow records
  successful CLI verification in the attested postpublication verification
  record; `browser-lab-infrastructure-readiness` independently resolves and
  verifies that exact record.
- Add `crates/forge3d-web/scripts/resolve-implementation-actors.mjs`. Using the
  GitHub API, compare the previous immutable Forge3D web release tag (or
  baseline `ffba491` for the first release) with `target_sha`, resolve every
  associated merged-PR author and every direct commit author/committer login
  for every commit in that range, and fail closed on an unresolved identity.
  Both INF-05 and INF-06 reuse this resolver.
- Gate the mutation job with a protected `forge3d-web-release` environment:
  required reviewers, prevent-self-review, protected-`main` deployment rule,
  and administrator bypass disabled. Before mutating a tag or release, require
  `github.actor` not to be in the implementation-actor set, retrieve this run's
  approval history, and require every approving reviewer to differ from the
  actor and every implementation actor. Failure or absence of an independent
  approval stops before any release mutation.
- The protected publisher `needs` both read-only jobs, receives neither observer
  App key/token nor their checkout, and before requesting `contents: write`
  re-applies the INF-00 four-output exact-ID handoff to the original unexpired
  trust observation and verifies the attested preflight record. It requires
  their artifact ID/name/artifact/content digests and preflight digest,
  workflow/run/attempt, consumer job/environment, exact target/tag, readiness
  and asset digests, and current `github.workflow_sha` to match. Expiry or any
  mismatch fails before mutation and requires a new dispatch; no publisher may
  substitute a live trust read using its `GITHUB_TOKEN`.
- Declare job permissions explicitly. The preflight receives only
  `contents: read`, `actions: read`, `checks: read`, `pull-requests: read` (the
  last solely for implementation-actor resolution), `id-token: write`,
  `attestations: write`, and
  `artifact-metadata: write` to attest its closed preflight record. The observer
  uses the INF-00 observer permissions and environment App key.
  The protected publication job receives only `contents: write`,
  `actions: read`, and `attestations: read`; all unspecified permissions are
  `none`. The preflight and publication jobs receive no repository secret other
  than the scoped `GITHUB_TOKEN`; only the separate observer job receives its
  environment-scoped App key. The publication job performs no checkout or
  execution of repository source. After the publisher uploads the exact
  postpublication artifact, a separate GitHub-hosted attester with only
  `actions: read`, `id-token: write`, `attestations: write`, and
  `artifact-metadata: write` downloads it by the publisher's numeric artifact
  ID, requires the exact name and archive digest, validates the record against a
  pinned schema without checking out or executing repository source, and
  attests only that record. The publisher never receives attestation-writing
  permission and the attester never receives `contents: write` or an
  environment.
- Only after all preflight and identity gates pass, create a draft release,
  upload the merged manifest, checksums, logs, screenshots/videos copied by
  numeric asset ID from INF-05's draft intakes, manual evidence, and all package
  assets. Download every draft asset, byte-verify its SHA-256 and attestation,
  and publish exactly once only after the complete matrix passes. No
  post-publication asset or tag mutation is part of the workflow.
- After publication, run `gh release verify <tag>` and
  `gh release verify-asset <tag> <path>` for every downloaded release asset;
  retain the release-attestation verification output in the readiness record.
- Add
  `.github/workflows/browser-lab-infrastructure-readiness.yml`, dispatched only
  at `refs/heads/main`, with a required full `candidate_sha` equal to that
  workflow run's SHA; one numeric `packageRunId`; four numeric host-canary run
  IDs; one numeric generic manual-canary run ID plus its intake release and
  hardware job IDs; and one numeric non-support lab-canary release ID. Its
  `observe-lab-readiness-trust` job alone references
  `forge3d-trust-observer` and emits an observation bound to `candidate_sha`,
  this run/attempt, and the separate GitHub-hosted computation job. That
  consumer has immutable display name
  `browser-lab-infrastructure-readiness`, receives no observer secret, verifies
  the observation through the INF-00 four-output exact-ID handoff, and accepts
  only successful
  `browser-hardware.yml` runs from the protected workflow ref with
  `lane: infrastructure-canary`, requires exactly one `canaryMode: host` result
  per fixed host plus one `canaryMode: manual` result, verifies every
  authorization/controller/session/media/package attestation and cleanup
  result, requires every run and release to bind the supplied exact-SHA
  `packageRunId`/digest, and validates the fixed-namespace lab-canary release.
  It computes
  `labInfrastructureDigest` from the exact files/versions named by this plan,
  emits canonical
  `browser-lab-infrastructure-readiness.json`, uploads it under a fixed artifact
  name, and attests it with
  `actions/attest@<reviewed-40-hex-commit> # v4.x.y`. Its explicit permissions are
  `actions: read`, `checks: read`, `contents: read`, `id-token: write`,
  `attestations: write`, and `artifact-metadata: write`; every other
  `GITHUB_TOKEN` permission is `none`; the observer has the separately defined
  INF-00 observer permissions. Inputs select records only; every
  selected value is independently resolved and must form the exact closed set.
- Add `.github/workflows/browser-hardware-release-readiness.yml`, dispatched
  only at `refs/heads/main`, with full `target_sha` equal to the workflow run's
  SHA, one decimal `labReadinessRunId`, and a sorted JSON array of numeric
  evidence workflow run IDs. A preceding
  `observe-hardware-release-readiness-trust` job alone references
  `forge3d-trust-observer` and binds its observation to the exact target,
  run/attempt, and the consumer. That separate GitHub-hosted consumer has
  immutable display name `browser-hardware-release-readiness`, receives no
  observer secret, verifies the observation through the INF-00 four-output
  exact-ID handoff, and then verifies the supplied
  laboratory manifest and hosted attestation, derives the required
  asset/lane/checklist keys from the checked matrices, resolves each selected
  run through the API, rejects duplicate or extra keys, and requires exactly
  one successful record per key at the target commit, package digest, session
  binding, and current laboratory digest. It then runs
  `merge-browser-evidence.mjs`, performs the prior-head/hash/missing-lane
  negative controls, emits and attests canonical
  `browser-hardware-release-readiness.json`, and never dispatches a hardware
  lane. Its consumer permissions equal the laboratory-readiness consumer's
  permissions; its observer permissions equal the laboratory observer's, and
  all others are `none`.
- Contract tests pin both workflow paths, trigger/ref/input rules, immutable
  job names, exact permissions, artifact names/schemas, trust-observer use, and
  separation: the laboratory workflow rejects every product lane, while the
  hardware-release workflow cannot schedule any lane or pass without the
  complete post-execution matrix.
- Update `crates/forge3d-web/docs/release-checklist.md` with evidence location,
  retention, rerun, quarantine, and hardware-substitution rules.

**Definition of done**

- The merged manifest contains one passing exact-commit/package-hash record for
  every required matrix row and no unresolved infrastructure error.
- A negative test using a previous commit, different tarball hash, expired
  manual record, or missing lane fails the release check.
- Contract/negative tests prove a non-`main` dispatch, untrusted or abbreviated
  SHA, pre/at-epoch SHA, live protection drift, mismatched version/tag, existing
  tag/release, implementation-author publisher, self-approval,
  implementation-author approval, or missing independent approval fails before
  `contents: write` performs a mutation.
- Publication/readiness contract tests prove only their `observe-*` jobs
  reference `forge3d-trust-observer`; preflight, computation, and
  `forge3d-web-release` jobs receive no observer secret and reject a missing,
  expired, prior-run/attempt, wrong-target/tag/operation/consumer/environment,
  or wrongly attested trust observation/preflight record before publication or
  readiness attestation.
- Actions evidence remains available for 90 days. Every evidence asset available
  before publication is attached to the corresponding GitHub Release. The
  postpublication verification record is a separate attested 90-day Actions
  artifact bound to the immutable release ID/tag, release-manifest digest, exact
  run/attempt, and verified asset digests; it is consumed by readiness and never
  mutates the published release.
- A newly published canary or first candidate created after the setting was
  enabled passes `gh release verify`; every asset passes
  `gh release verify-asset`. The separate postpublication verification record
  retains all command output and the release attestation identity and binds them
  to the checksum-bearing release manifest.
- Contract tests prove the lab-canary workflow cannot accept a target SHA,
  browser result, or release-matrix manifest, cannot publish outside its fixed
  namespace, always records `supportClaim: false`, and cannot satisfy or bypass
  `browser-hardware-release-readiness`.
- Quarantined hardware cannot silently remove a required lane; the release is
  blocked or the published support matrix is narrowed through review.
- Every final media asset has the same bytes and SHA-256 as its authenticated
  INF-05 intake asset. Intake drafts/tags are deleted only after immutable
  publication and verification of all final assets succeed.

## Laboratory Infrastructure Execution Gate

`browser-lab-infrastructure-readiness` is the pre-execution gate. It may run
only the enumerated `infrastructure-canary` lane; it does not require or claim a
passing browser support matrix. It reports `LAB_INFRA_READY` only when:

1. INF-00..06 are `CODE_COMPLETE`, the live protected-`main` policy matches
   `repository-trust-policy.json`, and the candidate is a strict descendant of
   `trustEpochSha`.
2. The exact eleven-asset inventory, owning-host mapping, static/nonce label
   contract, workflow-actions lock, trust-observation schema, runner
   distribution/transient-path manifests, controller and registration-broker
   versions, controller signing-key IDs, and policies hash to the recorded
   `labInfrastructureDigest`.
3. Every controller/asset is online, no runner is registered at rest, and one
   authorization-bound one-job JIT canary per host proves broker-derived
   name/custom-label/work-folder binding, host locking, headed adapter
   presentation, external logs, automatic removal or exact-ID broker cleanup,
   and trust-observer confirmation of absence. Inventory/Appium probes resolve
   every attached mobile/accessory ID without running browser support
   assertions.
4. The exact attested package is served through the nonce-bound HTTPS
   application/asset origins; dual-origin CORS/range allow/deny controls and
   mobile certificate reachability pass.
5. The generic manual-session operation inside the `infrastructure-canary` lane
   proves host reservation, signed session inventory, challenge-bound
   authenticated media intake/submission, cleanup, and retained provenance
   without invoking a product checklist or asserting that a product gesture
   passed. Its selected submission-run creation, signed canary creation, and
   selected submission-run completion must occur in that order and all fall
   inside the same inclusive `acceptanceWindowHours=24` window as the final
   host evidence; 24 hours is accepted and 24 hours plus 1 millisecond is
   rejected.
6. Release immutability is enabled and
   `publish-browser-lab-canary.yml` creates one non-support `lab-canary`
   release that proves draft-first upload, byte/digest/attestation verification,
   publish-once immutability, CLI verification, and intake cleanup without
   consulting the post-physical release-matrix gate.

All browser/manual physical acceptance lanes except `infrastructure-canary`
remain `LAB_INFRA_BLOCKED` until this check passes with a matching
`labInfrastructureDigest`. This is the only gate that unlocks their execution.

## Hardware Release-Matrix Publication Gate

`browser-hardware-release-readiness` is evaluated only after the unlocked
physical lanes run. It reports `RELEASE_MATRIX_READY` only when:

1. Every required CHR/SAF/FFX/MOB asset/lane and manual checklist has a passing
   exact-`trusted_sha`, exact-package-digest record with no unresolved
   infrastructure error.
2. Every record references the same currently passing
   `browser-lab-infrastructure-readiness` manifest and unchanged
   `labInfrastructureDigest`; changed infrastructure invalidates the matrix.
3. Manual evidence resolves to a completed, successful signed manual-session
   run/job on the same host/asset/browser/OS/package/route challenge.
4. The merged release manifest, prior-head/hash/missing-lane negative controls,
   protected publisher separation, and immutable draft-first canary all pass.

Only `RELEASE_MATRIX_READY` unlocks `publish-web-release.yml` and a `SUPPORTED`
claim. It is never a prerequisite for scheduling the physical lanes whose
results it evaluates.

## Primary References

- GitHub protected-branch requirements, restrictions, and administrator
  enforcement:
  <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches>
- GitHub deployment-environment model (one environment per job and
  environment-scoped secret access):
  <https://docs.github.com/en/enterprise-cloud@latest/actions/concepts/workflows-and-actions/deployment-environments>
- GitHub secure-use guidance requiring full-length commit SHAs for immutable
  action and reusable-workflow references:
  <https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions>
- GitHub branch-protection REST API:
  <https://docs.github.com/en/rest/branches/branch-protection>
- GitHub self-hosted runner labels:
  <https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/apply-labels>
- GitHub repository JIT configuration, runner-list/get, and exact-ID deletion
  endpoints and permissions:
  <https://docs.github.com/en/rest/actions/self-hosted-runners?apiVersion=2026-03-10>
- GitHub secure-use guidance for
  `run.sh --jitconfig <encoded_jit_config>` and one-job JIT runners:
  <https://docs.github.com/en/actions/reference/security/secure-use#using-just-in-time-runners>
- GitHub ephemeral-runner and external-log guidance:
  <https://docs.github.com/en/actions/reference/runners/self-hosted-runners>
- GitHub runner `_diag/Runner_*` and `_diag/Worker_*` log behavior:
  <https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/monitor-and-troubleshoot>
- GitHub 60-second assignment requeue and 24-hour unmatched-job timeout:
  <https://docs.github.com/en/actions/reference/runners/self-hosted-runners#routing-precedence-for-self-hosted-runners>
- GitHub warning that approval does not make untrusted code safe on a
  self-hosted runner:
  <https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#controlling-changes-from-forks-to-workflows-in-public-repositories>
- GitHub Actions artifact attestations:
  <https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations>
- `actions/upload-artifact` outputs, including `artifact-id` and
  `artifact-digest`:
  <https://github.com/actions/upload-artifact#outputs>
- GitHub Actions artifact metadata and exact-ID download endpoints:
  <https://docs.github.com/en/rest/actions/artifacts>
- GitHub workflow-job REST representation:
  <https://docs.github.com/en/rest/actions/workflow-jobs>
- GitHub artifact-attestation REST API and required token access:
  <https://docs.github.com/en/rest/users/attestations>
- `actions/attest` permission requirements, including
  `artifact-metadata: write`:
  <https://github.com/actions/attest>
- GitHub CLI file upload to release assets:
  <https://cli.github.com/manual/gh_release_upload>
- GitHub release-asset API:
  <https://docs.github.com/en/rest/releases/assets>
- GitHub CLI attestation policy flags:
  <https://cli.github.com/manual/gh_attestation_verify>
- GitHub workflow-run approval history API:
  <https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run>
- RFC 8785 JSON Canonicalization Scheme:
  <https://www.rfc-editor.org/rfc/rfc8785>
- GitHub immutable release behavior and draft-first publication:
  <https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/supply-chain-security/immutable-releases>
- GitHub immutable release and asset verification:
  <https://docs.github.com/en/enterprise-cloud@latest/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity>
- Current WebGPU adapter information contract:
  <https://gpuweb.github.io/types/interfaces/GPUAdapterInfo.html>
- Cloudflare Tunnel configuration and token control:
  <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/>
- Apple Safari WebDriver:
  <https://developer.apple.com/documentation/safari-developer-tools/webdriver/>
- iPhone models compatible with iOS 26:
  <https://support.apple.com/guide/iphone/iphe3fa5df43/ios>
- iPad models compatible with iPadOS 26:
  <https://support.apple.com/guide/ipad/ipad213a25b2/ipados>
- Apple Pencil compatibility:
  <https://support.apple.com/en-euro/108937>
- Apple Magic Trackpad (USB-C, 2024) specifications:
  <https://support.apple.com/en-gb/121932>
- Apple Magic Trackpad regulatory/model listing (`A3120`):
  <https://support.apple.com/ko-kr/121932>
- Samsung Galaxy Tab S9 in-box S Pen specification:
  <https://news.samsung.com/global/samsung-galaxy-tab-s9-sets-the-new-standard-to-bring-galaxys-premium-experience-to-a-tablet>
- Chrome Android WebGPU rollout:
  <https://developer.chrome.com/blog/new-in-webgpu-121>
