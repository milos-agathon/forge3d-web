# W13 third inline review fixes

Follow-up to `efbcdb2` in the same `codex/w13-labels` worktree. Both supplied
findings were confirmed and fixed without subagents.

## Final behavior

The full attempted-input signature contains the layer revision/disposal state,
camera and canvas dimensions. Changed inputs retry label generation, including
a return to a previously valid view or viewport. An error clears label nodes and
`getLabelReport()`; a later successful layout restores both without a layer edit.
Identical attempted inputs reuse the cleared scene rather than repeating work.
Device recovery resets the attempted-input signature and retries on its new runtime.

Error suppression has a separate key containing the revision/disposal state and
error code/message. It controls notification only, never placement retries.
Continued frame failures report once; success resets notification suppression.
`setLabels` throws to its caller, and label refresh inside `screenshot` rejects
its promise, without invoking `onError`. Background frame/recovery refreshes use
`onError`. A caller-handled failure is also remembered, avoiding a later duplicate
callback for the same ongoing failure. Device-loss routing is unchanged.

## Regression evidence

A real-font unit regression places two `W` labels at world x=0 and x=100. Camera A
shows one label, camera B shows both, and the vertex budget is 1.5 times a single
label's measured allocation. B fails and clears labels; A restores the original
accepted label and byte count without changing the layer revision. Widening then
restoring the canvas repeats this failure/recovery independently of camera changes.
The same test verifies that three changed failing frame inputs generate only one
callback. Existing capture/replacement tests now require zero caller callbacks.

`viewerBudget` exercises the same transitions in source, dist and the installed
package. The [committed package evidence](w13-package-consumer-evidence.json)
measures one label at 10248 vertex bytes with a budget of 15372 bytes. Its valid
frame covers 301 pixels. The failing camera clears coverage to zero; returning
to A restores all 301 pixels with zero changed bytes. Returning from the failing
viewport and from repeated failing frames also restores byte-identical pixels.
The revision stays unchanged and status stays `ready`. Both caller error counts
are zero; the first and repeated frame-error counts are exactly one.

Before rebuilding dist, the new source regression passed while the untouched
`efbcdb2` dist failed because its caller callback count was one instead of zero.
After rebuilding, both source and dist passed all recovery assertions.

## Executed checks

- All 866 TypeScript tests in 50 files passed with
  `node node_modules/vitest/vitest.mjs run --maxWorkers=2`.
- All 13 WebGPU browser checks passed: 11 W13 and two shared W02 checks,
  including 30 runtime create/render/loss/dispose cycles.
- All nine installed-tarball workflows and the Vite-built consumer passed under
  strict CSP, with no page errors or remote requests. Browser: Chromium 148.0.7778.96.
- Typechecking/public API, package contract and release-hardening checks passed.
- Parity: all 15 tests passed; 6531 records and 31 locked consumers verified,
  with no unresolved records or dependency-lock violations.
- Seven documentation-link checks and `git diff --check` passed.

Final tested tarball SHA-256: `495bc15f9807abc502b067d04634f2ec6868c1544b26ed777bfe2b9f12b3a2d8`.

## Limits

Only Windows Chromium preflight was run. No Rust/native-contract source changed;
Rust/Clippy and native oracle regeneration were not repeated. Existing native
oracle comparisons passed as part of the full unit suite. The previously noted
U-turn and combined scatter/probe browser gaps remain untested here. The separate
FND branded-browser/hardware matrix remains open.
