# W22/E05 review prompt

Review `codex/w22-codec-integration` in
`C:\Users\milos\.codex\worktrees\w22-codec-integration\forge3d-web` against base
`9086b37edc31fd3a038e6ca7672c4c21931cb980`; assess review fixes separately from
`2612777bbf2b6dde376c75f93652d1696a11c2ec`. Do not trust completion claims.

Read W22/E05, parity rules and W04/W06/W08 ownership in
`docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md`, W00
`docs/parity/dependency-lock.json`, and `crates/forge3d-web/docs/{codecs,w22-evidence}.md`.
Trace actual delegated implementations, generated dist, workers and WASM.

Prove: every pinned E05 fixture selects one codec or exact typed unavailable
result; replay preserves bytes AND metadata with full implementation/input/
parameter fingerprints; corruption/staleness, cancellation, backpressure,
transient/persistent budgets, quota rollback, device loss and disposal are sound.
Attempt the decoy HDR header before allocation and mutate transitive fingerprint
inputs. On the original rendered `offline-denoise-v1` scene through the registry,
require SSIM gain >=0.02, MSE reduction >=20%, converged regression <=0.005 and
GPU/CPU max error <=1e-4. Check W04 real Basis integer returns/initialization,
CSP/SRI, multi-strip TIFFs, useful shipped example and fixture exclusion.

Run the sequential reproduction commands in `w22-evidence.md`; inspect raw
per-case source/installed artifacts in `docs/parity/w22-review-*-evidence.json`.
Verify installed implementation provenance despite external test inputs. Separate
Chromium preflight and injected quota/repeat-cycle evidence from untested physical
profiles, other browser families and actual origin-quota exhaustion. No subagents.
Report only reproducible actionable findings with severity, requirement, path:line,
impact and repro; list any unverified acceptance gates explicitly.
