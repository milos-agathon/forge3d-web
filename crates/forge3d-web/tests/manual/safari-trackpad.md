# Safari Magic Trackpad acceptance

Every capture must show `SESSION_CHALLENGE_VISIBLE`, `FW-MAC-M2-01`,
`FW-TRACKPAD-01`, Safari/macOS versions, trackpad firmware/transport, exact
package hash, and the direct USB-C pairing topology.

- [ ] `SESSION_CHALLENGE_VISIBLE` — Confirm the complete watermark is readable.
- [ ] `TRACKPAD_ORBIT` — Orbit with a one-finger click-drag.
- [ ] `TRACKPAD_PAN` — Pan with the checked secondary gesture.
- [ ] `TRACKPAD_PINCH_ZOOM` — Pinch smoothly in both directions.
- [ ] `TRACKPAD_MOMENTUM_END` — Confirm momentum stops without an idle render
  loop.
- [ ] `TRACKPAD_PAGE_SCROLL_ISOLATION` — Confirm canvas gestures do not move the
  surrounding page.
- [ ] `TRACKPAD_CLEANUP` — Confirm Safari, fixture, Bluetooth gesture session,
  update freeze, and host reservation cleanup.
