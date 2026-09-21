# Safari Magic Trackpad acceptance

Every capture must show `SESSION_CHALLENGE_VISIBLE`, `FW-MAC-M2-01`,
`FW-TRACKPAD-01`, the exact Safari channel/version and macOS build, the
trackpad firmware and Bluetooth gesture transport, the exact package hash,
and the direct USB-C pairing/charging topology. Keep the canvas focused for
the gesture steps.

- [ ] `SESSION_CHALLENGE_VISIBLE` — Confirm the complete watermark is readable.
- [ ] `TRACKPAD_ORBIT` — Orbit with a one-finger click-drag.
- [ ] `TRACKPAD_PAN` — Pan with the checked secondary gesture.
- [ ] `TRACKPAD_TWO_FINGER_SCROLL_ZOOM` — Zoom in both directions with
  two-finger scrolling and confirm inertial wheel deltas settle cleanly.
- [ ] `NO_SAFARI_GESTURE_EVENT_LISTENERS` — Confirm the installed viewer owns
  zero `gesturestart`, `gesturechange`, or `gestureend` listeners. Touch pinch
  remains implemented through Pointer Events on touch devices.
- [ ] `TRACKPAD_MOMENTUM_END` — Confirm momentum stops without an idle render
  loop.
- [ ] `TRACKPAD_PAGE_SCROLL_ISOLATION` — Confirm canvas gestures do not move the
  surrounding page.
- [ ] `TRACKPAD_OUTSIDE_CANVAS_PAGE_SCROLL` — Move the pointer outside the
  canvas and confirm two-finger scrolling moves the surrounding page normally.
- [ ] `TRACKPAD_CLEANUP` — Confirm Safari, fixture, Bluetooth gesture session,
  direct-USB pairing/charging state, update freeze, and host reservation
  cleanup.

Trackpad pinch is outside the Forge3D v1 viewer-input contract. Safari may
apply its normal page/browser gesture; this checklist neither intercepts that
gesture nor treats it as mandatory Forge3D viewer acceptance.
