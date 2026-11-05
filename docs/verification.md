# Verification — 2026-11-05

- `npm test`: 4 integration/security test groups passed, including authentication, Origin/CSRF, viewer restrictions, private layouts, safe RTSP additions and persistence, MSE message allowlist/revocation, FLV proxy, blocked RTSP publish methods and source recovery after restart.
- `docker compose build` and `docker compose up -d --build --force-recreate`: passed on Docker Desktop / Linux arm64. Gateway healthy, go2rtc 1.9.15 running.
- Native go2rtc `/api/config`: 404 even with the internal credential; `/api/streams`: accessible only internally with authentication for controlled reconciliation. No 1984 host port published.
- RTSP relay without credentials: `401 Unauthorized`.
- Actual synthetic H.264/AAC stream: browser WebRTC, MSE and HTTP-FLV each decoded 640×360 frames (`readyState=4`, advancing playback). RTSP source inspected successfully with ffprobe. This does not establish H.265 compatibility on every browser.
- Browser UI: admin RTSP add form, source insertion, four-tile preset, pointer dragging, keyboard resizing, save/reload persistence and playback mode restoration verified. Mobile login and desktop wall reviewed.
- Real user-supplied source: TCP connection refused on port 8554; no real-camera playback could be verified.
- During the initial isolated test run, no production users were created. UI test accounts lived in a temporary database; test container and preview process were removed after verification.
- Formal penetration testing, multi-hour load testing, MFA/OIDC and server-enforced immediate WebRTC revocation remain outside this version. See README for security boundaries.

## Hidden entrance and IP logging update

- Six test groups passed after adding hidden routing, access storage/export, trusted-proxy address resolution and spoofed-header rejection.
- Docker gateway rebuilt and deployed with existing users/layouts retained.
- Browser confirmed public root renders the restricted-access page with no sign-in UI. An existing administrator successfully signed in at the generated private entrance.
- Admin access viewer shows root visits, static requests and login events, with masked `[entry]` paths and Hong Kong display times.
- Current Docker Desktop browser peer is `192.168.0.1`, not a verified public client IP. No proxy trust was enabled automatically; router blocking requires deployment-specific source-IP verification.
- Local verification screenshots are excluded from Git. The private entrance itself is stored in the database / optional environment configuration, not in this document.

## Playback sharing and handoff update — 2026-11-06

- Seven integration/security test groups passed. New checks cover admin/CSRF restrictions, single-camera scope, token hashing and log masking, cross-origin playback, expiry, and revocation closing existing MSE/FLV connections.
- Gateway Docker image rebuilt and deployed successfully, preserving existing data.
- Isolated browser fixture: created a share via the admin UI; the standalone player decoded synthetic H.264/AAC in both MSE and FLV at 640×360, readyState 4 and advancing playback. UI revocation removed the full links and marked the grant revoked.
- These synthetic tests do not verify the remote user camera, H.265 on all browsers, Internet routing, or third-party live platforms.
- Added HANDOFF.md covering installation, upgrade, account/entrance recovery, architecture, API contracts, tests, and remaining work. No production credentials or camera addresses are included.
