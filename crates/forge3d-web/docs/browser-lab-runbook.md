# Forge3D Browser Laboratory Runbook

This runbook is the operating contract for the fixed inventory in
`tests/infrastructure/hardware-matrix.json`. Repository files contain only
public asset IDs and controller public keys. Serial numbers, Apple UDIDs,
Android device serials, Bluetooth addresses, App private keys, encoded JIT
configurations, tunnel tokens, and personal Apple accounts are never written to
the repository, Actions artifacts, broker ledger, or controller logs.

The checked matrix is currently in `provisioning` state. That is deliberate:
repository code can be reviewed before physical custody, protected-branch
policy, controller keys, and clean JIT canaries exist. A pending matrix is not
`LAB_INFRA_READY` and cannot support a browser claim.

## Roles And Trust Boundaries

- A repository administrator owns the `main` protection rule. No workflow,
  controller, or browser-lab credential may edit it.
- The `forge3d-trust-observer` GitHub App has only Administration read, Actions
  read, Attestations read, and Metadata read on
  `milos-agathon/forge3d-web`. Its Actions key is stored only in the protected
  `forge3d-trust-observer` environment. Controller copies live in each
  controller service account's OS credential store.
- The registration broker uses a different App with Administration write,
  Actions write, and Metadata read. Those permissions can alter repository
  policy and workflow availability even though the broker API is narrow. Treat
  broker compromise as trust-root compromise.
- Each controller runs outside any repository checkout and runner work root,
  under a dedicated non-login service account. It has no broker App key.
- Windows uses the per-service virtual account
  `NT SERVICE\forge3d-browser-lab-controller`, never `LocalSystem`. Grant only
  service logon plus `SeDebugPrivilege`, `SeAssignPrimaryTokenPrivilege`, and
  `SeIncreaseQuotaPrivilege` for the checked token/process bridge; deny
  interactive and Remote Desktop logon. The bridge must use the verified
  active-console Windows shell token and must not call the LocalSystem-only
  `WTSQueryUserToken`. Prove the complete WinSW launch/stop path on the live
  host before activation.
- A hardware job receives neither App key, installation token, controller
  private key, encoded-config history, nor authority to register another
  runner.

Implementation actors must not approve their own protected environments or
the final policy/release change. The approver and protected publisher are
separate people or service identities.

## Protected-Main Bootstrap

1. Merge the bootstrap PR that creates the two GitHub-hosted checks exactly
   named `Web Runtime / Build And Contract Tests` and
   `Web Runtime / Browser Preflight`.
2. Enable GitHub's full-length Actions SHA policy when the repository exposes
   it. The checked static action-lock gate remains mandatory even when the live
   setting is unavailable.
3. Create the `main` rule with strict App-bound checks, zero required
   approvals, stale-review dismissal for any voluntary review, no latest-push
   approval requirement, conversation resolution, administrator enforcement,
   and no force push, deletion, or bypass actor.
4. Run a canary PR proving direct and force pushes, deletion, unresolved
   conversations, and administrator bypass are rejected. Preserve API
   responses showing zero required approvals and no latest-push approval
   requirement together with the attempted-command results.
5. Merge a separate policy-pin PR that changes `bootstrapState` to `active` and
   sets `trustEpochSha` to the canary merge SHA. The epoch SHA itself and every
   earlier commit remain ineligible; only strict descendants may be promoted.
6. Run `node scripts/verify-repository-trust.mjs` with a short-lived
   trust-observer installation token against current `main`.

Automatic broker and browser packaging remain non-privileged and skip their
observer and build jobs while the checked policy is exactly
`pending-protection-canary` with a null `trustEpochSha`. Manual packaging fails
in that state. The reviewed policy-pin change in step 5 activates the observer
and package jobs; missing observer credentials or any inconsistent bootstrap
state then fails closed.

If an environment approval takes longer than the observation's 30-minute
validity window, rerun the dispatch. Never reuse an observation from another
run, attempt, operation, job, environment, or target SHA.

Before the first laboratory canary, a repository administrator must enable
**Settings > Releases > Enable release immutability**. For the exact
`publish-lab-canary`, `compute-lab-readiness`,
`compute-hardware-release-readiness`, and `publish-web-release` operations, the
trust-observer job reads the dedicated `/immutable-releases` endpoint with
GitHub API version `2026-03-10`, requires `enabled: true` and a boolean
`enforced_by_owner`, and binds both semantic values plus the live response
digest into its canonical attested observation. Other trust operations retain
the base repository-trust response set and do not depend on release
immutability. Preflight and publisher jobs have no observer credential; they
consume the exact verified, unexpired observation and fail closed when the
required setting proof is absent or disabled. Only releases created after
enablement are eligible; an older mutable release cannot be used as the canary
or the prior immutable release baseline.

## Authenticated Manual Media Intake

The expected tester must be a named `milos-agathon/forge3d-web` collaborator
with repository `write` access, not `admin`, and must authenticate GitHub CLI as
the same login recorded by the intake manifest. The only supported media
ingestion command is:

```sh
gh release upload <intake-tag> <local-media-files>
```

Do not add `--clobber`. A workflow dispatch never accepts a local path, media
name, username, URL, or digest. Upload only uniquely named `.png`, `.jpg`,
`.jpeg`, `.webm`, or `.mp4` files during the controller-signed 20-minute
session. Each file is limited to 100 MiB and the complete checklist to 500 MiB.
The submission workflow resolves numeric asset IDs, checks the authenticated
uploader and API digest, downloads the bytes, and recomputes SHA-256 before
attesting the bundle.

For the generic laboratory canary, use checklist
`infrastructure-manual-canary`. Upload the challenged media during the
controller-signed 20-minute Browser Hardware session. After the signed session
and its finalizer finish, dispatch `submit-browser-manual-evidence.yml` with the
intake release ID, selected numeric media asset IDs, the Browser Hardware
session run ID, and its exact hardware job ID. The resulting Submit Browser
Manual Evidence run ID is the
`manualCanaryRunId` consumed by canary publication and laboratory readiness;
the separate `manualHardwareJobId` remains the signed underlying hardware job.
This record has `supportClaim: false` and cannot create a product matrix row.

## Physical Custody And Topology

The asset custodian records the location and raw serial/UDID mapping only in
the protected lab inventory. Apply the latest security patch within seven days
of release unless a tracked browser/driver exception requires a shorter
window. Keep automatic OS upgrades disabled during an acceptance run.

`FW-MAC-M2-01` owns all six mobile devices and `FW-TRACKPAD-01`. Mobile devices
connect directly by USB; a reviewed powered hub may be added only through a
matrix change that names the model, port map, and power budget. The Magic
Trackpad pairs and charges through a direct USB-C-to-USB-C cable without a hub,
then uses Bluetooth for gestures. Capture only its model, firmware, transport,
battery state, capture time, and direct topology:

```sh
node scripts/capture-trackpad-inventory.mjs \
  --output trackpad-inventory.json
```

Do not publish `system_profiler` source output. The sanitizer intentionally
discards serial number, Bluetooth address, location ID, and every other stable
identifier.

## Controller Keys And Inventory

Generate one non-exported ECDSA P-256 key in each controller account's native
credential store. Check in only the public JWK and a unique
`controller-<asset>-p256-vN` key ID. Controller records are canonicalized with
RFC 8785 JSON Canonicalization Scheme rules and signed with
`SHA256withECDSA`. Rotation is a reviewed matrix change and invalidates the
previous laboratory digest.

Install a native opaque signing provider beside each controller: CNG with a
non-exportable key on Windows, Keychain with a non-exportable key on macOS, and
PKCS#11 with a non-exportable key on Linux. Never export the key or configure a
PEM signing path. Before enabling the service, run the provider's checked
`describe --key-id` contract and verify the exact platform backend, P-256
curve, `SHA256withECDSA` algorithm, key ID, and `exportable: false`. Add the
provider's exact platform digest to the reviewed helper policy and verify a
live signature against the checked public JWK. Source validation does not
replace this live OS-keystore proof.

Populate `controller-helper-digest-policy.json` with one reviewed SHA-256 for
every required external helper's exact platform, identity, and checked version;
then change its state to `active` in the same review. Install that exact policy
and its closed schema from the attested controller package. Package-owned
bridges are manifest-bound; every other helper, including the signer, must be
allowlist-bound. Any missing entry or byte substitution keeps the controller
offline.

For a host-mode infrastructure canary, the controller reads the neutral
adapter, route, and inventory observations before wiping the runner job root.
Only after broker-proven exact runner absence does it store one immutable
signed receipt outside the runner tree. The GitHub-hosted finalizer retrieves
that receipt through the checked exact-run mTLS URL, verifies the checked
controller JWK, independently confirms runner absence with the trust-observer
App, and then creates the hosted-attested `lab-host-canary.json`. The
self-hosted hardware job never receives the controller key or observer token.

Before enabling a host:

1. Confirm its exact model, CPU/GPU, RAM, OS build, display server, physical
   asset label, attached models, browser lanes, and controller identity.
2. Change the host, controller, and attached assets to `active`, clear the
   maintenance reason, and change matrix `provisioningState` to `active` only
   when all four hosts are ready.
3. Run
   `node scripts/validate-hardware-matrix.mjs --require-provisioned`.
4. Sign the live inventory on its owning controller and verify the signature
   against the checked JWK before upload.

Substituting any host, GPU, browser channel, OS family, device, pen, trackpad,
controller, runner label, or HTTPS route requires a reviewed matrix change.

The `FW-MAC-M2-01` host-mode canary must also open a real Appium session on
each of the six attached mobile asset IDs. Every device must navigate the same
run/job/nonce HTTPS route and execute the in-browser certificate, package
SHA-256, WASM MIME, allowed/denied CORS, and range checks before the controller
can sign the canary. Host-side HTTP/Node probes, the desktop canary browser,
emulation, inventory declarations, and Appium configuration alone are not
mobile route evidence. Appium sessions explicitly request and must return
`acceptInsecureCerts: false`; certificate bypasses, private-CA exceptions, and
insecure driver defaults fail closed. Private serials and UDIDs remain inside the protected
device-control helper and are never recorded.

## Runner Distribution And One-Job Lifecycle

The pinned runner version and official archive hashes are in
`tests/infrastructure/browser-policy.json`. A controller must:

1. Download the exact platform archive and verify its SHA-256 before extraction.
2. Extract into a new unique install root owned only by the controller account.
3. Verify every file, directory, executable mode, and symlink against
   `runner-distribution-manifest.json`; reject missing and extra paths.
4. Ask the broker for JIT configuration only after validating an unexpired,
   attested authorization. The caller cannot select repository, runner name,
   labels, work folder, group ID, or runner ID.
5. Launch exactly one listener with custom labels `forge3d-web`, the checked
   host `hw-*` label, and the authorization nonce's `jit-*` label. Workflows
   route on all three. GitHub-generated platform labels are informational only.
6. Stop the listener at the assignment deadline, preserve `_diag/Runner_*` and
   `_diag/Worker_*` externally, request exact-ID cleanup, and wipe the unique
   install and `_work` roots.
7. Re-verify every manifest entry after the job. Enumerate non-manifest paths
   and permit only `runner-transient-path-policy.json`. An executable, symlink,
   unknown root path, or changed distribution entry is `INFRA_ERROR`.

The transient policy remains `pending` until an otherwise-clean v2.336.0 JIT
canary on every host demonstrates each path. Change it to `verified` and set
browser policy to `active` only in the reviewed canary evidence PR. Runner
auto-update is forbidden; update the archive pins, regenerate the full
manifest, review transient behavior, and repeat all four canaries.

No repository runner may exist while a promoted job is not queued. Query the
exact runner ID every five seconds. If it becomes online and unassigned while
the job remains queued, start a 90-second assignment deadline. At timeout stop
the local listener, re-prove the runner is not busy and the exact job is still
queued, delete only the ledger-bound runner ID, cancel only the bound run, and
verify cancellation. A busy runner, changed job state, ID/name/label mismatch,
or replay fails closed without deletion or cancellation.

## Diagnostic Retention And Wipe

Forward `_diag/Runner_*` and `_diag/Worker_*` before cleanup. Redact tokens,
authorization headers, encoded JIT configuration, mobile identifiers, and
paths containing controller account names. Retain token-free controller and
broker decision logs according to the release evidence policy. The broker
ledger retains authorization digest, run/job and runner IDs, derived name and
labels, timestamps, observations, stop proof, and cleanup decision—never the
encoded JIT configuration.

After evidence upload and exact-ID cleanup:

- stop remaining listener/worker processes;
- verify the runner is absent or non-busy before broker deletion;
- wipe the unique work and install roots;
- verify no repository runner remains;
- require the host cleanup receipt to report updates restored, browser stopped,
  drivers stopped, Appium stopped, and tunnels stopped as five explicit true
  results before releasing the host lock or signing evidence;
- quarantine the host if the controller was unreachable, the listener stop is
  unproven, an immutable path changed, or an unknown transient path appeared.

## Maintenance And Change Control

Set a host and its attachments to `maintenance` before patching, browser/driver
changes, key rotation, accessory replacement, or controller/broker deployment.
Required lanes fail closed while an asset is in maintenance; they do not skip
and do not inherit evidence from a substitute.

Every change PR includes:

- the reason and affected public asset IDs;
- old/new OS, browser, runner, controller, broker, key, or topology values;
- regenerated policy/manifest digests;
- negative tests for the changed boundary;
- a new clean JIT canary on every affected host;
- confirmation that no secret or stable hardware identifier entered Git,
  logs, or artifacts.

Repository code completion is not physical infrastructure readiness. Only the
separate readiness workflow may report `LAB_INFRA_READY`, and only after live
protected-main policy, controller signatures, runner absence at rest, all four
JIT canaries, and the fixed inventory pass at the exact current SHA. Each
selected host run completion, controller completion, hosted finalizer
observation, hardware-job completion, and inventory capture must be no more
than `acceptanceWindowHours` old (currently 24 hours) and must not be in the
future. The generic authenticated manual canary's signed `createdAt` and its
selected submission-run creation and completion must satisfy that same
inclusive window and occur in that order; exactly 24 hours old is accepted and
24 hours plus 1 millisecond is rejected. The Mac record additionally carries
the exact six-device Appium route evidence and its digest into the readiness
manifest.
