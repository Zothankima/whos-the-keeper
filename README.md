# Who's the Keeper?

A mobile-first, real-time multiplayer guessing game for 3–8 people. It runs in a browser and uses Socket.IO for live room updates.

## Current release-candidate scope

- Create/join a four-character room code; no account required.
- Nickname validation, host transfer, remove-player control, and 60-second reconnect window.
- Total rounds are set when the game starts to the connected player count, capped at five (for example, 3 players means 3 rounds; 8 players means 5). Keeper privately chooses one of three category items.
- Yes / No / Sometimes answers, a 20-second question-answer deadline, duplicate-question checks, 20-question counter, guess penalties and scoring.
- Final guesses at any time, typo-tolerant matching, wrong-guess lockout, round reveal, podium, same-room rematch.
- Late joiners can spectate during a running game; spectators are promoted into the lobby as players after the host selects Play again, subject to room capacity and nickname uniqueness. Sound effects are optional and off by default.
- If too few players remain connected, the round pauses; a new player can fill an open slot and resume it. The host can end a game from any game phase: finished rounds go to the podium, while a game with no finished round returns to the lobby.
- Room/game state is saved to a JSON file, including game state needed to restore after a process restart. On restart, players have to reconnect within the 60-second reservation window.
- `/health` and `/ready` health endpoints.

## Requirements

- Node.js 20 or newer (Node 22 recommended)
- npm

## Run locally

```sh
npm install
npm start
```

Open `http://localhost:3000`. For a three-player test, use separate browser profiles or devices. On the same Wi-Fi, phones can use your computer's LAN IP and port 3000.

For development with automatic restarts:

```sh
npm run dev
```

## Tests

```sh
npm test
```

The integration tests start a real server and use Socket.IO clients to test gameplay, reconnect-timeout recovery, host end-game behavior, spectator promotion after Play again, and round-count limits. They require development dependencies (`npm install`). Four small unit tests cover rule helpers. These tests do not replace real-device testing.

## Deploy to Fly.io

The included `Dockerfile` and `fly.toml` are a starting deployment configuration. A persistent volume is configured at `/data`, and the server writes its room snapshot there. Use **one app machine** for this version: room state is not shared between multiple server instances.

1. Create a Fly.io account and install `flyctl`.
2. Change `app = "whos-the-keeper-change-me"` in `fly.toml` to a globally unique app name.
3. In this project folder, run `fly launch --no-deploy` if you need to create the app, reviewing the generated configuration carefully. If the app and volume are created manually, ensure a volume named `wtk_data` is mounted at `/data` in the app's primary region.
4. Run `fly deploy`.
5. Verify `https://YOUR-APP-NAME.fly.dev/health` returns `{"ok":true,"service":"whos-the-keeper"}` and test with three separate devices/browsers.

Hosting providers, accounts, DNS, and billing are outside this source project; the app has **not** been deployed by preparing these files. Do not scale this version to multiple instances until shared state/locking is implemented. Persistent JSON snapshots are suitable for a small single-instance launch, not a high-traffic production service.

## Important limitations before a public launch

- Real-time gameplay is implemented, but the multiplayer integration test has not run in this environment because npm dependency installation timed out. Run `npm install && npm test` in an environment with npm registry access before publishing.
- The project has not been deployed or tested across real phones and networks. Do a three-player smoke test, disconnect/reconnect test, keeper-disconnect test, and rematch test before sharing publicly. In this environment, `npm install` could not resolve `registry.npmjs.org` (`EAI_AGAIN`), so the five Socket.IO integration tests were skipped rather than executed; run `npm install && npm test` where npm registry access works.
- A restart saves the game state, but each disconnected player's 60-second reservation still applies. If the app is offline longer, the room may be cleaned up.
- This is a small MVP, not a hardened high-traffic service. There is no account system, moderation/reporting, analytics, multi-instance shared state, or abuse-rate limiting.

## Architecture

- `server.js` is authoritative for roles, secrets, deadlines, scores and room membership.
- `public/` contains the responsive client.
- `DATA_DIR` controls where the atomic JSON room snapshot is stored (default: `./data`; Fly config uses `/data`). Keep this directory private and persistent. `DISCONNECT_GRACE_MS` overrides the 60-second reconnect window for automated tests; leave it unset for normal play.
- `test/` contains sanity tests and a Socket.IO end-to-end test.
