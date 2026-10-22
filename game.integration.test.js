import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

let connect;
try { ({ io: connect } = await import("socket.io-client")); } catch {}

async function startServer(t, { graceMs = 60_000 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "wtk-test-"));
  const portServer = createServer();
  await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, DISCONNECT_GRACE_MS: String(graceMs) },
    stdio: "ignore"
  });
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.disconnect();
    child.kill("SIGTERM");
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(1000)]);
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { healthy = true; break; } } catch {}
    await delay(100);
  }
  assert.equal(healthy, true, "server should start and expose its health endpoint");
  const makeClient = async () => {
    const c = connect(base, { transports: ["websocket"], reconnection: false, timeout: 3000 });
    clients.push(c);
    await new Promise((resolve, reject) => { c.once("connect", resolve); c.once("connect_error", reject); });
    return c;
  };
  return { makeClient, clients };
}

function event(client, name, predicate = () => true, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off(name, handler); reject(new Error(`Timed out waiting for ${name}`)); }, timeout);
    const handler = data => {
      if (!predicate(data)) return;
      clearTimeout(timer); client.off(name, handler); resolve(data);
    };
    client.on(name, handler);
  });
}

async function createRoomWithPlayers(t, names = ["Host Player", "Second Player", "Third Player"], options = {}) {
  const env = await startServer(t, options);
  const clients = await Promise.all(names.map(() => env.makeClient()));
  const firstJoined = event(clients[0], "room:joined");
  clients[0].emit("room:create", { nickname: names[0] });
  const first = await firstJoined;
  const players = [first];
  for (let i = 1; i < clients.length; i++) {
    const joined = event(clients[i], "room:joined");
    clients[i].emit("room:join", { code: first.room.code, nickname: names[i] });
    players.push(await joined);
  }
  return { ...env, clients, players, code: first.room.code, host: clients[0], hostPlayerId: first.playerId };
}

async function startActiveRound(room) {
  const privateChoice = new Promise(resolve => {
    const handlers = [];
    for (const client of room.clients) {
      const handler = data => {
        if (data.phase === "choosing_secret" && data.choices?.length === 3) {
          handlers.forEach(([c, h]) => c.off("game:private", h));
          resolve({ client, data });
        }
      };
      handlers.push([client, handler]);
      client.on("game:private", handler);
    }
  });
  const started = event(room.host, "room:state", r => r.game?.phase === "choosing_secret");
  room.host.emit("room:start");
  const startState = await started;
  const { client: keeper, data } = await privateChoice;
  const active = event(room.host, "room:state", r => r.game?.phase === "active");
  keeper.emit("game:choose-secret", { secret: data.choices[0] });
  await active;
  return { keeper, secret: data.choices[0], startState };
}

test("two players can start a game and host target is public", { skip: !connect && "Install dev dependencies to run multiplayer integration tests" }, async t => {
 const room=await createRoomWithPlayers(t,["Host Player","Second Player"]);
 const changed=event(room.host,"room:state",r=>r.targetScore===30);
 room.host.emit("room:set-target",{targetScore:30}); assert.equal((await changed).targetScore,30);
 const start=event(room.host,"room:state",r=>r.game?.phase==="choosing_secret");
 room.host.emit("room:start"); const state=await start; assert.equal(state.game.targetScore,30);
});
test("hint event is delivered only to requesting guesser and cannot be used twice", { skip: !connect && "Install dev dependencies to run multiplayer integration tests" }, async t => {
 const room=await createRoomWithPlayers(t,["Host Player","Second Player"]);
 const {keeper,secret}=await startActiveRound(room); const guesser=room.clients.find(c=>c!==keeper);
 const otherHints=[]; for(const c of room.clients) if(c!==guesser)c.on("game:hint",d=>otherHints.push(d));
 const hint=event(guesser,"game:hint");guesser.emit("game:use-hint");const data=await hint;assert.ok(data.hint);assert.equal(data.used,true);
 const err=event(guesser,"app:error",d=>d.message.includes("already used"));guesser.emit("game:use-hint");await err;
 assert.equal(otherHints.length,0);
 const ended=event(guesser,"game:round-ended");guesser.emit("game:guess",{guess:secret});const result=await ended;assert.equal(result.reason,"correct_guess");
});
