# Infrastructure manual-session canary

This checklist proves only session provenance. It cannot satisfy a Forge3D
product gesture or browser-support assertion.

- [ ] `SESSION_OPEN` — Open the nonce-bound HTTPS session on the selected asset.
- [ ] `VISIBLE_CHALLENGE` — Capture the complete non-dismissable media
  challenge and UTC session clock.
- [ ] `AUTHENTICATED_MEDIA_UPLOAD` — Upload one allowlisted synthetic media
  file as the expected authenticated tester.
- [ ] `SESSION_CLEANUP` — Confirm the route, browser, host lock, update policy,
  media intake, and one-job runner are cleaned up.
