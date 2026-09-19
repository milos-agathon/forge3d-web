# Safari Magic Trackpad acceptance

Every capture must show `SESSION_CHALLENGE_VISIBLE`, `FW-MAC-M2-01`,
`FW-TRACKPAD-01`, Safari/macOS versions, trackpad firmware/transport, exact
package hash, and the direct USB-C pairing topology.

- [ ] `SESSION_CHALLENGE_VISIBLE` — Confirm the complete watermark is readable.
- [ ] `TRACKPAD_ORBIT` — Orbit with a one-finger click-drag.
- [ ] `TRACKPAD_PAN` — Pan with the checked secondary gesture.
- [ ] `TRACKPAD_TWO_FINGER_SCROLL_ZOOM` — Two-finger scroll in both directions
  over the focused canvas and confirm the viewer zoom changes. Trackpad pinch
  is not a Forge3D viewer control and is neither required nor claimed.
- [ ] `TRACKPAD_MOMENTUM_END` — Lift both fingers after a two-finger scroll and
  confirm inertial wheel events terminate cleanly without an idle render loop.
- [ ] `TRACKPAD_PAGE_SCROLL_ISOLATION` — Confirm two-finger scrolling over the
  focused canvas changes viewer zoom without moving the surrounding page, then
  move outside the canvas and confirm the same gesture scrolls the page normally.
- [ ] `TRACKPAD_CLEANUP` — Confirm Safari, fixture, Bluetooth gesture session,
  update freeze, and host reservation cleanup.
