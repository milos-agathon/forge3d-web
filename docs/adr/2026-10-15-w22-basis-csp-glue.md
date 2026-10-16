# W22: static closure adapter for Basis Universal's JavaScript glue

Status: accepted implementation decision. Scope: E05 integration of W04.

The dependency remains Basis Universal 2.0.3 at upstream commit
`21fb6e242b1e425a7557c5655bb1b475f71933ca`. Its original JS/WASM files and
W00 SHA-256/SRI pins remain unchanged. A real BasisLZ fixture demonstrated
that the upstream Embind JavaScript factory uses two `new Function` sites,
which fail the package's existing strict CSP. Adding `unsafe-eval` would
weaken that contract.

`prepare-basis-csp.mjs` verifies both upstream artifacts before replacing
only `createJsInvoker` and `__emval_create_invoker` with static closures in
a separately named `basis_transcoder.csp.js`. The adapter calls the original
wire converters, native invokers and destructor machinery. The decoder,
WASM memory handling, texture conversion and compression algorithms remain
upstream-owned. The generated adapter has an additional exact W00 digest.
Changes to either replacement boundary or adapter output fail preparation.

The implementation/security review checked the original generated bodies:
argument conversion/order and method `this`, scalar/class returns, explicit
destructors and destructor stacks, emval function/method/construction/value
calls, wire pointer stride and return conversion are preserved. Neither
replacement compiles or evaluates strings. This is a local glue adaptation,
without a decoder substitution or a claim of independent review. Upstream
Apache-2.0 notices ship in `assets/basis/LICENSE` with the adapted artifact.

Validation includes the pinned upstream BasisLZ image, exact replay, malformed
containers, memory limits and installed-tarball execution with `script-src
'self' 'wasm-unsafe-eval'` and `worker-src 'self'`. Runtime fixture execution
is required in addition to source and digest checks. The original unrestricted
glue remains available for applications that explicitly configure its URL.
