# Mobile multitouch acceptance

Every capture must keep the non-dismissable `SESSION_CHALLENGE_VISIBLE`
watermark readable. Record each step as exactly `pass` or `fail`.

- [ ] `SESSION_CHALLENGE_VISIBLE` — Confirm the complete session challenge,
  asset ID, package hash, and UTC capture clock are visible.
- [ ] `ONE_FINGER_ORBIT` — Orbit with one finger and confirm the page does not
  scroll.
- [ ] `TWO_FINGER_PAN` — Pan with two fingers without changing orbit.
- [ ] `PINCH_ZOOM` — Pinch in and out and confirm deterministic zoom.
- [ ] `PEN_OR_PENCIL_ORBIT` — On `FW-AND-PEN-01` use the S Pen; on
  `FW-IPAD-01` use Apple Pencil Pro. Other phones record the step as pass only
  after confirming it is not applicable for that checked asset in the session
  record.
- [ ] `POINTER_CANCELLATION` — Interrupt an active gesture and confirm the next
  gesture begins cleanly.
- [ ] `PAGE_SCROLL_ISOLATION` — Confirm gestures on the focused canvas do not
  scroll or zoom the surrounding page.
- [ ] `ORIENTATION_CHANGE` — Rotate portrait to landscape and back; confirm the
  viewer resizes and remains interactive.
- [ ] `BACKGROUND_FOREGROUND` — Background and foreground the browser; confirm
  rendering suspends and resumes without duplicate listeners.
- [ ] `UNSUPPORTED_UI` — Exercise the checked unsupported-state fixture and
  confirm it is visible and actionable rather than a blank canvas.
- [ ] `SESSION_CLEANUP` — Confirm browser, driver, fixture, tunnel, update
  freeze, and device reservation cleanup completes.
