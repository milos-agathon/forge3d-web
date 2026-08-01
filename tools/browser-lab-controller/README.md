# Forge3D browser lab controller

This controller runs outside the repository and GitHub Actions runner folders.
Its installed service continuously polls the fixed hardware workflow using a
single-repository GitHub App token with only Actions read, Attestations read,
and Metadata read. It resolves one valid, unexpired, GitHub-hosted-attested
`runner-authorization.json`, acquires the owning host lock, verifies the pinned
runner distribution, requests one broker-created repository JIT configuration
over mTLS, and launches only `run.sh|run.cmd --jitconfig <opaque-value>`.

On Windows, the controller remains a Session-0 service, but it never launches
the runner or browser there. It verifies the checked SHA-256 of
`windows-interactive-session-bridge.ps1`, sends the JIT configuration through
the bridge's standard input, and the bridge opens and duplicates the verified
active-console Windows shell token before using `CreateProcessAsUser` on
`winsta0\default`. It does not call the LocalSystem-only `WTSQueryUserToken`.
The bridge rejects a missing or
locked physical console session, paths outside the controller jobs root, any
entrypoint other than `run.cmd --jitconfig`, and environment variables outside
the runner allowlist. Its receipt identifies the exact console session and
user-session runner PID used for lifecycle monitoring and tree cleanup.
The bridge creates the runner suspended, assigns it to a kill-on-close Job
Object, and resumes it only after that checked containment exists. If launch
fails before the receipt is accepted, it terminates the Job Object, awaits the
runner handle, and returns checked cleanup evidence; closing handles alone is
never treated as absence.
The WinSW service runs as the dedicated, non-login virtual account
`NT SERVICE\forge3d-browser-lab-controller`, never `LocalSystem` or the
interactive lab account. Provisioning must grant that identity only the
checked service-logon, `SeDebugPrivilege`, `SeAssignPrimaryTokenPrivilege`, and
`SeIncreaseQuotaPrivilege` rights required by the session bridge, explicitly
deny interactive and Remote Desktop logon, and verify the bridge with a live
physical-console launch before activation. ACL the controller code, service
XML, bridge script, environment file, and helper executables to Administrators,
SYSTEM, and read/execute for this virtual account, with no write access for the
service or interactive lab identities.

On macOS and Linux, the installed service runs as the dedicated non-login
`forge3d-lab-controller` account and cannot launch `run.sh` directly. It
verifies the SHA-256 of `unix-interactive-session-bridge.mjs`; that bridge
verifies its separately pinned session contract and is the only command the
controller account may run through passwordless `sudo`. The bridge requires the
checked `forge3d-lab` graphical account, refuses the controller account or a
different user, and returns the exact runner PID plus session evidence. Linux
requires one active, unlocked, local GNOME Wayland login, its owned
`/run/user/<uid>` bus, live user-manager display variables, and a
`systemd-run --user --scope` execution domain verified from the runner PID's
cgroup. macOS requires the same console user, an unlocked on-console Aqua
session, and a live `gui/<uid>` launchd namespace. The user-side launcher
creates a dedicated runner process group. The verified distribution remains
owned by the controller account; the bridge gives only the checked graphical
identity search access to the exact controller-owned `jobs/<nonce>` directory.
It creates and hands off only the seven exact files and trees in
`runner-transient-path-policy.json`, using the controller group, setgid
directories, and a `0007` runner umask so the unprivileged controller can read
ordinary diagnostics and remove the job without privileged recursive
reclamation. Provisioning must keep the dedicated controller group exclusive
to the controller identity. Linux must provide `/usr/bin/setfacl`; macOS uses
the native per-user `search` ACL. The root bridge permits `SIGTERM` and the
separately allowlisted forced `SIGKILL` only for that user's checked process
group whose working directory is under the jobs root. Both operations have a
bounded process-group absence wait, including when the long-lived launch bridge
has already exited. Launch-bridge exit is never accepted as runner absence;
failure to prove process-group exit quarantines the host, retains its lock, and
leaves the job root intact.
The launch bridge applies the same checked wait before reporting a failed
handshake as cleaned up.

Provisioning must install all three Unix bridge files as root-owned, non-writable
artifacts and grant `forge3d-lab-controller` passwordless access only to the
fixed bridge path, including its fixed launch and `--stop` contracts. The
repository sudoers sources are `0644` because Git cannot represent `0440`;
provisioning must install them root-owned at `0440` before enabling the service.
Linux cannot set `NoNewPrivileges=true` because that would disable the narrowly
configured sudo transition. The checked
`browser-lab-controller.sudoers-linux` and
`browser-lab-controller.sudoers-macos` files are the complete allowed sudo
surface; the bridge rejects direct root use of its internal user-child mode.
The macOS launch daemon explicitly sets
`UserName=forge3d-lab-controller`; neither platform runs the controller as the
graphical account.

The environment loaded by systemd, WinSW, or `--environment-file` is passed
explicitly into production dependencies before runner sanitization. Only
standard runtime fields and the checked browser/update/Playwright/geckodriver/
Appium/device/Cloudflared/WDA prefixes cross into the JIT process. Controller
GitHub App, broker mTLS, health TLS, signing, lock, and service variables do
not cross. Unix bridges replace controller identity/display values with the
observed graphical login's home, user, runtime bus, and display session.

Controller evidence signing never reads a PEM private-key file. Windows uses a
digest-allowlisted native provider backed by a non-exportable CNG P-256 key;
macOS uses the same closed provider protocol backed by a non-exportable
Keychain P-256 key. The provider must attest its platform backend, curve,
algorithm, key ID, and `exportable: false` before the service starts. Its stderr
is suppressed and its digest is rechecked before every signature. Linux uses
the same opaque contract with a non-exportable PKCS#11 key. Only the explicit
test adapter accepts an in-memory private key.

Every external helper, including the signing provider, must match one exact
platform/identity/version SHA-256 in the attested
`controller-helper-digest-policy.json`. Package-owned bridges remain bound to
the attested package manifest. A pending policy, missing identity, version
mismatch, changed byte, self-rewritten installation receipt, or extra helper
fails service startup.

It never gives the runner its controller GitHub App private key or installation
token, a registration/remove token, repository secret, or source checkout. The
host lock is released only after broker-confirmed exact-ID absence, distribution
verification, external diagnostic forwarding, host cleanup, and complete
per-job work-root removal. Cleanup must explicitly prove updates restored,
browser stopped, drivers stopped, Appium stopped, and tunnels stopped before
unlock or evidence signing. Otherwise the host is quarantined.

The broker's existing five-second mTLS health probe carries a bounded lifecycle
header from its exact issuance ledger. Only the dedicated
`broker:forge3d-browser-lab` client identity may provide it. The controller
starts no local assignment clock: it stops an online-unassigned listener only
after a broker observation at or beyond the persisted `assignmentDeadline`
shows the exact runner online and idle, never busy, and the exact job still
queued. Missing, stale, mismatched, or ever-busy observations fail closed.

For an `infrastructure-canary` host run, the controller reads the neutral
browser/route/inventory observations before wiping the job root, waits for
broker-proven exact runner absence, signs one canonical host-canary receipt,
and stores it outside the runner tree. The mTLS service exposes that immutable
receipt only by exact run ID and attempt. A GitHub-hosted trust finalizer must
verify the checked controller public key before it can convert the receipt into
attested laboratory evidence.

For a manual run, the controller also binds the observed unlocked local session,
visible challenge watermark, exact 20-minute window, browser/driver, dual
origins, package, and cleanup proof. It signs and stores that manual-session
receipt only after the broker proves the JIT runner absent.
