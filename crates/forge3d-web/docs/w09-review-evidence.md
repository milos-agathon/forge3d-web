# W09 review remediation evidence

All fourteen review findings are closed. The owner independently re-verified
native divergence repros, byte-exact fixtures and the 367/174/711 test totals
plus 17 W09 browser checks. Corrections and all new fixtures are committed in
`5424bc7fd43f353574190b312c1921934f4542a7`; the clean-commit W09 package gate
passes for that exact revision. The documentation follow-up records this run
and does not claim a package certificate for its own later revision.
Reference-hardware acceptance remains unqualified. No push, publication or
release was performed.

The historical reflection baker has one behavior-preserving source deviation:
`hammersley_2d` uses `bits.rotate_right(16)` instead of
`(bits << 16) | (bits >> 16)` to satisfy strict Clippy. This swaps the same two
16-bit halves of every u32; the fixture generator still executes untouched
historical native source. Mojibake in 28 runtime comments is restored to em dashes.

## Review closure

| Finding | Correction and evidence |
| --- | --- |
| 1. Native HLOD | Static cluster draws, singleton exclusion, 3D cells, native center/radius/surface-distance activation. Historical CPU cluster fixture, independent selection checks, and static/exclusive GPU pixels. |
| 2. QEM | Native midpoint quadric heap, no 4096-triangle cap, historical positions/indices/normals oracle, and 600-instance dense HLOD test. |
| 3. Mask ordering | Edge checks precede native density RNG draws; arbitrary rectangular masks resample. Four filtered/edge/mask native cases. |
| 4. Narrow oracle | Independent historical QEM/HLOD/LOD/wind-uniform fixtures; native-vs-port GPU WGSL execution; asymmetric off-center probes, environment rotation, face-swap and wrong-direction controls; multiple normals, six faces and three roughness values. |
| 5. Hashes | Approved seed-42/time-0.37 display, HDR and ID hashes stored with RTX 3070 Windows Chromium metadata and checked in source/dist and installed-consumer runs. |
| 6. Probe tests | Edge/outside weights, native ridge occlusion brightness, environment rotation, 64 probes, invalid update retains frame, clear changes frame, and dispatched-worker cancellation. |
| 7. Native limits | Independent 4096-irradiance/256-reflection dimension products, paired reflection placements, compatible legacy fields and additive memory reports. |
| 8. Storage gate | Real layout counts: VT requires three base storage buffers or four with probes. Boundary tests use actual bind-group entries. |
| 9. Shader variant | Probe region and binding absent when disabled. Both shared shaders resolve exactly to W08; physical preflight display/HDR bytes match independently rebuilt W08. |
| 10. Weak assertions | Actual worker frame/time differences, scene time, static HLOD pixels and one cluster ID replace main-thread/statistics-only assertions. Installed-package assertions aligned. |
| 11. Tiny slack | Exactly actual diagonal times 1e-5; tiny-scene and static-mesh containment rejection controls. |
| 12. Synchronous bake | One whole-grid WASM request in a self-hosted module worker; cancellation terminates dispatched work and browser animation remains responsive. |
| 13. Budgets | Local 60-second installed-package observation below; reference-integrated blocked on INF-00 and reference-discrete absent. No reference-budget pass is claimed. |
| 14. Plan/API | Removed eight approved internal root exports and aligned exact API locks; documented worker setCamera; restored native QEM requirement and consistent W09 code status. |

## Observed validation

- 367 terrain-enabled core Rust tests (`--features webgpu`), zero ignored/filtered.
- 174 web Rust tests, including shader variants and historical wind uniforms.
- 711 TypeScript unit tests, 45 files.
- API typechecks, exact declaration snapshot and emitted facade checks.
- 91 W04/W06/W07/W08/W09 Chromium preflight regression checks with
  `FORGE3D_WEBGPU_REQUIRED=1`, `FORGE3D_W09_COMPARE_W08=1`, and
  `FORGE3D_W09_PINNED_HASH_PROFILE=chromium-preflight-rtx3070-win`; no skips.
- Final W09 suite: 17 Chromium preflight tests pass with the same strict
  environment variables, including the approved private-export boundary.
- Release hardening and documentation checks; parity verifier: 15 tests and
  6531 mappings, zero unresolved/schema/lock errors.
- Release WASM, TypeScript and self-hosted dist builds; offline local tarball
  install and W09 render/scene/worker/native/memory checks. Its 150 requests
  contain no source or unpublished pkg paths.
- All five expanded native fixtures regenerate byte-for-byte; no-probe
  shader text matches W08 exactly.
- Follow-up rotation correction: both filtered reflection-baker tests pass;
  strict Clippy confirms the manual-rotate finding is gone (remaining failures
  are listed below). Scoped diff whitespace check.

The installed consumer measured flat SH error
`5.82857729e-08`, ridge SH error
`4.65748011e-08`, and reflection error
`3.27587351e-07`. Coverage is 22,528 flat pixels,
24,576 ridge pixels with three normals, and 18,432 reflection pixels.
The independent GPU math oracle executes 210 wind and 63 contact/blend samples
against the historical native WGSL and rejects a reversed wind direction.

The same 4096-triangle halving workload measured 2082.112 ms before and
64.5096 ms after (one execution each after a small warm-up, not a statistical
benchmark). Native output and indices match; the old implementation produced
2047 triangles where native and the heap port produce 2048.

## Local performance observation

See [raw preflight observation](w09-chromium-preflight.json). Hardware:
NVIDIA GeForce RTX 3070, driver `32.0.16.1060`, Windows build
`10.0.26300.9550` (26H2), bundled Chromium `148.0.7778.96`, ANGLE D3D11.
The exact 192x128 manifest workload uses two instances, 16 probes, four-texel
reflections and 64 SH rays.

| Observation | Value |
| --- | --- |
| Duration / rendered-and-read frames | 60.4387 s / 15538 |
| Render plus readback p95 | 5.900 ms |
| Committed GPU bytes | 250172 |
| Main-realm WASM linear memory | 3145728 bytes |
| Reported JS heap | 16506598 bytes |
| Enumerated owned typed arrays | 43136 bytes |
| Sum of reported CPU components | 19695462 bytes |

The CPU sum is an observation of those components, not OS resident memory,
a complete allocation census or worker bake peak. GPU work and readback were
executed. These results are Chromium preflight only and cannot qualify either
reference profile.

The tested local tarball SHA-256 was `b8c8cf43d761189b2f279eafac8505db1f1ca378193b2fba772607baccb6d821`. The code
was tested before adding this final evidence document to the source snapshot;
it is not a clean-commit or published-package certificate.

## Clean-commit installed-package acceptance

`npm run test:package-consumer:w09` completed with exit code zero on clean
commit `5424bc7fd43f353574190b312c1921934f4542a7`. It rebuilt WASM, TypeScript,
self-hosted dist and the example, passed API/release-hardening checks, all six
documentation tests and 118 browser-harness tests with no skips, then packed
and installed the exact tarball in an independent consumer.

The default required lane used installed Chrome `154.0.8037.58`, headless,
with no extra launch arguments and a non-fallback `nvidia / ampere` adapter.
The installed W09 scatter, scene/time, worker, HLOD, probe edge/stress/rejection,
cancellation, native payload and GPU SH/reflection comparisons passed.
Native SH payload max error remains zero; flat/ridge GPU SH and reflection
errors match the values above after the rotation rewrite. The separate viewer
benchmark submitted all 600 measured frames with zero skipped frames.

The accepted tarball SHA-256 is
`0fc393364d088d66b61f121f348d452e6b1f4388f59dbb8fc523b23b522c8e9f`.
See [recorded acceptance](w09-clean-package-acceptance.json) for the exact
revision, browser/adapter metadata, results and retained raw evidence hashes.
The package gate reports `PASS`; Windows RTX 3070 hardware observations remain
**Chromium preflight**, with no integrated or Ubuntu/Vulkan budget qualification.

## Remaining required evidence

- **reference-integrated: BLOCKED on INF-00.** Only pinned `FW-WIN-I12-01`,
  labels `forge3d-web` + `hw-win-intel12`, may qualify the integrated
  scatter-probes-v1 budget. Owner reports maintenance/unprovisioned. A run must
  attest that machine's exact adapter, driver and OS; no substitute is allowed.
- **reference-discrete: ABSENT.** Qualifying runs require `FW-LNX-NV-01` on
  Ubuntu/Vulkan. The available Windows RTX 3070 is Chromium preflight.
- Headed browser, cross-backend render portability, reference-hardware
  hashes and full reference CPU/frame-time budget qualifications are unrun.
- The full Windows release infrastructure retains its existing POSIX/symlink
  prerequisites; the narrower W09 clean-package gate now passes as recorded above.
- Strict Clippy does not pass. The combined core/web all-targets WebGPU lane
  stops on 36 core findings in unchanged files after the rotation fix. Web-only no-deps lint reports
  29 existing input/offline/terrain/IBL/test findings after the new placement
  remainder finding was corrected and lint rerun. No lint allow-list or gate weakening was added.

## Execution and reusable steering

Earlier scatter, probe and GPU implementation lanes used `gpt-5.6-sol` with
`xhigh` reasoning. After the owner's instruction to avoid subagents, remaining
implementation, integration, validation and final review were performed inline;
the delegated reviewer did not complete a review. The parent session's exact
model/effort identifier is not available as verifiable tool metadata.

No unrelated worktree cleanup, production dependency change, threshold change,
test skip, or reference-hardware substitution was performed. Existing native
worktrees and the separate historical clone were left intact.

Reusable documentation proposal: note that `types/index.d.ts` is a curated
facade, while module declarations are emitted. Copying the whole generated
facade can erase compatibility aliases such as TerrainRig. Also record that
the historical reflection baker raises face resolution below four; normalize
it before output sizing. Neither AGENTS.md nor a skill was modified.
