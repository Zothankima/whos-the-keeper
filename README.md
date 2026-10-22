# Who's the Keeper?

A mobile-first, real-time multiplayer guessing game for 2–8 people. It runs in a browser and uses Socket.IO for live room updates.

## Rules

- Rooms support 2–8 players, with a 60-second reconnect window, host transfer and host controls.
- The host chooses a match target of 30 or 50 points in the lobby (default 50). Play continues round by round until a player reaches or passes the target.
- The Keeper rotates in join order, skipping disconnected or removed players. The Keeper privately chooses one of three secret options from a category.
- Guessers share 10 tries per round. An answered yes/no question costs one try; a question skipped after the Keeper's 20-second answer deadline is free. A wrong final guess costs one try and locks that player out for five seconds.
- A correct guess earns 10 points, or 7 if that guesser used their one private hint that round. If all tries run out, the Keeper earns 10 points. Hints reveal the secret's first letters and word lengths privately and do not cost a try.
- Duplicate questions are rejected and final guesses tolerate small typos. The secret is never included in public room state during an active round.
- Keeper disconnects and host-skipped rounds score no points and reveal the secret. At the target score, the game shows the winner and final podium.
- Play again keeps the same room and target, resets scores, and promotes spectators into available player slots.
- Older incompatible saved rooms are safely reset to the lobby during restore.

## Development

```sh
npm install
npm test
npm start
```

## Requirements

- Node.js 20 or newer (Node 22 recommended)
- npm

## Run locally

```sh
npm install
npm start
```

Open `http://localhost:3000`. For a multiplayer test, use separate browser profiles or devices. On the same Wi-Fi, phones can use your computer's LAN IP and port 3000.

For development with automatic restarts:

```sh
npm run dev
```

## Tests

```sh
npm test
```

The integration tests start a real server and use Socket.IO clients to test two-player starts, lobby target selection, and private hint behavior. They require development dependencies (`npm install`). Four small unit tests cover rule helpers. These tests do not replace real-device testing.

## Deploy to Fly.io

The included `Dockerfile` and `fly.toml` are a starting deployment configuration. A persistent volume is configured at `/data`, and the server writes its room snapshot there. Use **one app machine** for this version: room state is not shared between multiple server instances.

1. Create a Fly.io account and install `flyctl`.
2. Change `app = "whos-the-keeper-change-me"` in `fly.toml` to a globally unique app name.
3. In this project folder, run `fly launch --no-deploy` if you need to create the app, reviewing the generated configuration carefully. If the app and volume are created manually, ensure a volume named `wtk_data` is mounted at `/data` in the app's primary region.
4. Run `fly deploy`.
5. Verify `https://YOUR-APP-NAME.fly.dev/health` returns `{"ok":true,"service":"whos-the-keeper"}` and test with two or more separate devices/browsers.

Hosting providers, accounts, DNS, and billing are outside this source project; the app has **not** been deployed by preparing these files. Do not scale this version to multiple instances until shared state/locking is implemented. Persistent JSON snapshots are suitable for a small single-instance launch, not a high-traffic production service.

## Important limitations before a public launch

- Real-time gameplay is implemented, but the multiplayer integration test has not run in this environment because npm dependency installation timed out. Run `npm install && npm test` in an environment with npm registry access before publishing.
- The project has not been deployed or tested across real phones and networks. Do a three-player smoke test, disconnect/reconnect test, keeper-disconnect test, and rematch test before sharing publicly. In this environment, `npm install` could not resolve `registry.npmjs.org` (`EAI_AGAIN`), so the two Socket.IO integration tests were skipped rather than executed; run `npm install && npm test` where npm registry access works.
- A restart saves the game state, but each disconnected player's 60-second reservation still applies. If the app is offline longer, the room may be cleaned up.
- This is a small MVP, not a hardened high-traffic service. There is no account system, moderation/reporting, analytics, multi-instance shared state, or abuse-rate limiting.

## Architecture

- `server.js` is authoritative for roles, secrets, deadlines, scores and room membership.
- `public/` contains the responsive client.
- `DATA_DIR` controls where the atomic JSON room snapshot is stored (default: `./data`; Fly config uses `/data`). Keep this directory private and persistent. `DISCONNECT_GRACE_MS` overrides the 60-second reconnect window for automated tests; leave it unset for normal play.
- `test/` contains sanity tests and a Socket.IO end-to-end test.
