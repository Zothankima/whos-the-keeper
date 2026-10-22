import express from "express";
import http from "node:http";
import { randomInt, randomUUID, createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import { ROOM_CODE_CHARS, cleanNickname, nicknameKey, normalizeText, guessMatches } from "./game-rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, pingInterval: 25000, pingTimeout: 20000 });
app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), { etag: true, maxAge: "1h" }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "whos-the-keeper" }));
app.get("/ready", (_req, res) => res.json({ ready: true }));

const rooms = new Map();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "rooms.json");
const MAX_PLAYERS = 8, MIN_PLAYERS = 3, DISCONNECT_GRACE_MS = Math.max(50, Number(process.env.DISCONNECT_GRACE_MS || 60_000)), ROOM_IDLE_MS = 6 * 60 * 60 * 1000;
const CATEGORIES = {
  Animals: ["Elephant","Penguin","Giraffe","Octopus","Kangaroo","Dolphin","Tiger","Owl","Camel","Panda","Crocodile","Butterfly"],
  Food: ["Pizza","Biryani","Ice cream","Sushi","Mango","Noodles","Samosa","Chocolate","Burger","Pancake","Watermelon","Popcorn"],
  Places: ["Eiffel Tower","Taj Mahal","Hospital","Airport","Beach","Library","Great Wall of China","Mount Everest","Cinema","Railway station","Zoo","Desert"],
  Jobs: ["Doctor","Teacher","Pilot","Farmer","Chef","Police officer","Astronaut","Singer","Driver","Tailor","Judge","Fisherman"],
  "Everyday objects": ["Umbrella","Toothbrush","Mirror","Bicycle","Clock","Key","Spectacles","Pillow","Mobile phone","Scissors","Candle","Bucket"]
};
function tokenHash(token) { return createHash("sha256").update(String(token)).digest("hex"); }
function makeCode() { let code=""; for(let i=0;i<4;i++) code+=ROOM_CODE_CHARS[randomInt(ROOM_CODE_CHARS.length)]; return code; }
function choose(arr) { return arr[randomInt(arr.length)]; }
function publicRoom(room) {
  const players = [...room.players.values()].map(p=>({id:p.id,nickname:p.nickname,connected:p.connected,isHost:p.id===room.hostId,joinedAt:p.joinedAt,score:p.score||0}));
  const g=room.game;
  const game = g ? { phase:g.phase, roundNumber:g.roundNumber, totalRounds:g.totalRounds || Math.min(5, room.players.size), category:g.category||null, remainingQuestions:g.remainingQuestions, currentQuestion:g.currentQuestion ? {id:g.currentQuestion.id,playerId:g.currentQuestion.playerId,nickname:room.players.get(g.currentQuestion.playerId)?.nickname||"Player",text:g.currentQuestion.text,askedAt:g.currentQuestion.askedAt,deadline:g.currentQuestion.deadline} : null, questionLog:g.questionLog, lastResult:g.lastResult||null, podium:g.podium||null, roundKeeperId:g.keeperId||null, roundScores:g.roundScores||{} } : null;
  return {code:room.code,status:room.status,hostId:room.hostId,players,minPlayers:MIN_PLAYERS,maxPlayers:MAX_PLAYERS,updatedAt:room.updatedAt,game};
}
function sendPrivate(room) {
  if (!room.game) return;
  for (const p of room.players.values()) if (p.connected && p.socketId) {
    const g=room.game, keeper=p.id===g.keeperId;
    io.to(p.socketId).emit("game:private", {isKeeper:keeper,phase:g.phase,choices:keeper&&g.phase==="choosing_secret"?g.choices:[],secret:keeper&&g.secret?g.secret:null,canAsk:g.phase==="active"&&!keeper&&!g.currentQuestion,canAnswer:g.phase==="active"&&keeper&&!!g.currentQuestion,canGuess:g.phase==="active"&&p.id!==g.keeperId,meId:p.id});
  }
}
function emitRoom(room) { room.updatedAt=Date.now(); io.to(room.code).emit("room:state",publicRoom(room)); sendPrivate(room); persist(); }
function getRoom(code) { return rooms.get(String(code??"").trim().toUpperCase()); }
function emitError(socket,message,code="INVALID_ACTION") { socket.emit("app:error",{code,message}); }
function findPlayer(socket) { const room=getRoom(socket.data.roomCode); const player=room?.players.get(socket.data.playerId); return {room,player}; }
function nicknameTaken(room,nickname,excludeSocketId=null) {
  const key=nicknameKey(nickname);
  if([...room.players.values()].some(p=>nicknameKey(p.nickname)===key)) return true;
  for(const other of io.sockets.sockets.values()) {
    if(other.id!==excludeSocketId&&other.data.roomCode===room.code&&other.data.spectator&&other.data.spectatorNickname&&nicknameKey(other.data.spectatorNickname)===key) return true;
  }
  return false;
}
function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = [...rooms.values()].map(room => ({
      ...room, players: [...room.players.values()].map(({ disconnectTimer, socketId, connected, ...p }) => ({ ...p, connected: false, socketId: null })),
      game: room.game ? { ...room.game, questionTimer: null } : null
    }));
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (error) {
    console.error("Could not persist room state:", error.message);
  }
}
function restoreRooms() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    for (const data of saved) {
      if (!data?.code || !Array.isArray(data.players)) continue;
      const room = { ...data, players: new Map(), game: data.game ? { ...data.game, questionTimer: null } : null };
      for (const raw of data.players) {
        const p = { ...raw, connected: false, socketId: null, disconnectedAt: Date.now(), disconnectTimer: null };
        room.players.set(p.id, p);
      }
      if (room.players.size) {
        if (room.game && ["active", "choosing_secret"].includes(room.game.phase)) {
          room.game.resumePhase = room.game.phase;
          room.game.phase = "waiting_players";
          room.status = "paused";
        }
        rooms.set(room.code, room);
        for (const p of room.players.values()) {
          p.disconnectTimer = setTimeout(() => { const r = getRoom(room.code); if (r?.players.has(p.id) && !r.players.get(p.id).connected) removePlayer(r, p.id); }, DISCONNECT_GRACE_MS);
          p.disconnectTimer.unref?.();
        }
        if (room.game?.currentQuestion && room.game.phase === "active") {
          const g = room.game, delay = Math.max(0, (g.currentQuestion.deadline || Date.now()) - Date.now());
          g.questionTimer = setTimeout(() => {
            if (room.game !== g || g.phase !== "active" || !g.currentQuestion) return;
            const q = g.currentQuestion; g.questionLog.push({ ...q, answer: "Skipped", status: "skipped" }); g.currentQuestion = null;
            io.to(room.code).emit("game:question-skipped", { id: q.id }); emitRoom(room);
          }, delay);
          g.questionTimer.unref?.();
        }
      }
    }
  } catch (error) { console.error("Could not restore saved rooms:", error.message); }
}
function createRoom() { let code; do{code=makeCode();}while(rooms.has(code)); const now=Date.now(); const room={code,hostId:null,players:new Map(),status:"lobby",createdAt:now,updatedAt:now,game:null}; rooms.set(code,room); return room; }
function attachPlayer(socket,room,nickname,requestedPlayerId=null,suppliedToken=null) {
  const existing=requestedPlayerId&&room.players.get(requestedPlayerId);
  if(existing){if(nicknameKey(existing.nickname)!==nicknameKey(nickname))throw new Error("This reconnect token belongs to a different nickname."); if(existing.disconnectTimer)clearTimeout(existing.disconnectTimer); existing.disconnectTimer=null; existing.connected=true; existing.socketId=socket.id; existing.disconnectedAt=null; socket.data.roomCode=room.code; socket.data.playerId=existing.id; socket.data.spectator=false; socket.data.spectatorNickname=null; socket.join(room.code); socket.emit("room:joined",{room:publicRoom(room),playerId:existing.id,reconnectToken:suppliedToken,rejoined:true}); if(room.game?.phase==="waiting_players"&&[...room.players.values()].filter(p=>p.connected).length>=MIN_PLAYERS) resumeGame(room); else emitRoom(room); return existing;}
  if(room.players.size>=MAX_PLAYERS)throw new Error("This room is full (8 players maximum).");
  if(nicknameTaken(room,nickname,socket.id))throw new Error("That nickname is already taken in this room. Try another.");
  const reconnectToken=randomUUID()+randomUUID(); const p={id:randomUUID(),nickname,reconnectTokenHash:tokenHash(reconnectToken),connected:true,socketId:socket.id,joinedAt:Date.now(),disconnectedAt:null,disconnectTimer:null,score:0};
  room.players.set(p.id,p); if(!room.hostId)room.hostId=p.id; socket.data.roomCode=room.code; socket.data.playerId=p.id; socket.data.spectator=false; socket.data.spectatorNickname=null; socket.join(room.code);
  socket.emit("room:joined",{room:publicRoom(room),playerId:p.id,reconnectToken,rejoined:false}); if(room.game?.phase==="waiting_players"&&[...room.players.values()].filter(x=>x.connected).length>=MIN_PLAYERS) resumeGame(room); else emitRoom(room); return p;
}
function cancelQuestionTimer(g) { if(g.questionTimer)clearTimeout(g.questionTimer); g.questionTimer=null; }
function endRound(room,reason,secretReveal=true) {
  const g=room.game; if(!g||["round_over","game_over"].includes(g.phase))return; cancelQuestionTimer(g); g.phase="round_over"; g.lastResult={reason,secret:g.secret,category:g.category,keeperId:g.keeperId,correctPlayerId:g.correctPlayerId||null,remainingQuestions:g.remainingQuestions,wrongGuesses:g.wrongGuesses};
  const keeper=room.players.get(g.keeperId); if(keeper) keeper.score+=(reason==="no_questions"?15:reason==="correct_guess"?Math.min(10,g.wrongGuesses*2):0);
  g.roundScores=Object.fromEntries([...room.players.values()].map(p=>[p.id,p.score]));
  io.to(room.code).emit("game:round-ended",{...g.lastResult,secretReveal});
  g.completedRounds=(g.completedRounds||0)+1;
  if(g.roundNumber>=g.totalRounds){g.phase="game_over";room.status="game_over";g.podium=[...room.players.values()].sort((a,b)=>b.score-a.score||a.joinedAt-b.joinedAt).map((p,i)=>({id:p.id,nickname:p.nickname,score:p.score,place:i+1}));io.to(room.code).emit("game:over",{podium:g.podium});}
  emitRoom(room);
}
function nextRound(room) {
  const connected=[...room.players.values()].filter(p=>p.connected).sort((a,b)=>a.joinedAt-b.joinedAt);
  if(connected.length<MIN_PLAYERS){room.status="paused";room.game.phase="waiting_players";emitRoom(room);io.to(room.code).emit("game:notice",{message:"Waiting for at least 3 connected players to continue."});return;}
  const g=room.game; g.roundNumber+=1;
  if(g.roundNumber>g.totalRounds){g.phase="game_over";room.status="game_over";g.podium=[...room.players.values()].sort((a,b)=>b.score-a.score).map((p,i)=>({id:p.id,nickname:p.nickname,score:p.score,place:i+1}));emitRoom(room);return;}
  const eligible=connected; const keeper=eligible[(g.roundNumber-1)%eligible.length]; const availableCategories=Object.keys(CATEGORIES).filter(cat=>CATEGORIES[cat].some(item=>!g.usedSecrets.includes(item))); const category=choose(availableCategories.length?availableCategories:Object.keys(CATEGORIES));
  g.phase="choosing_secret";g.keeperId=keeper.id;g.category=category;g.choices=CATEGORIES[category].filter(item=>!g.usedSecrets.includes(item)).sort(()=>Math.random()-.5).slice(0,3);g.secret=null;g.remainingQuestions=20;g.currentQuestion=null;g.questionLog=[];g.wrongGuesses=0;g.correctPlayerId=null;g.lastResult=null;g.roundScores={};room.status="playing";
  io.to(room.code).emit("game:round-start",{roundNumber:g.roundNumber,category,keeperNickname:keeper.nickname});emitRoom(room);
}
function startGame(room) { const connectedCount=[...room.players.values()].filter(p=>p.connected).length; for(const p of room.players.values())p.score=0;room.game={phase:"waiting",roundNumber:0,totalRounds:Math.min(5,connectedCount),completedRounds:0,keeperId:null,category:null,choices:[],secret:null,remainingQuestions:20,currentQuestion:null,questionLog:[],wrongGuesses:0,correctPlayerId:null,lastResult:null,roundScores:{},usedSecrets:[],questionTimer:null,podium:null};nextRound(room); }
function scheduleQuestionTimeout(room) { const g=room.game;cancelQuestionTimer(g);g.currentQuestion.deadline=Date.now()+20_000;g.questionTimer=setTimeout(()=>{if(room.game!==g||g.phase!=="active"||!g.currentQuestion)return;const q=g.currentQuestion;g.questionLog.push({...q,answer:"Skipped",status:"skipped"});g.currentQuestion=null;io.to(room.code).emit("game:question-skipped",{id:q.id});emitRoom(room);},20_000);g.questionTimer.unref?.(); }
function resumeGame(room) {
  const g=room.game;
  if(!g||g.phase!=="waiting_players")return;
  if(g.resumePhase){g.phase=g.resumePhase;delete g.resumePhase;room.status="playing";if(g.phase==="active"&&g.currentQuestion)scheduleQuestionTimeout(room);emitRoom(room);io.to(room.code).emit("game:notice",{message:"Enough players are back. The round continues!"});}
  else nextRound(room);
}
function removePlayer(room,playerId) { const p=room.players.get(playerId);if(!p)return;if(p.disconnectTimer)clearTimeout(p.disconnectTimer);if(room.game&&room.game.keeperId===playerId&&room.game.phase!=="round_over"&&room.game.phase!=="game_over"){const g=room.game;cancelQuestionTimer(g);g.phase="round_over";g.completedRounds=(g.completedRounds||0)+1;g.lastResult={reason:"keeper_disconnected",secret:g.secret,category:g.category,keeperId:g.keeperId,correctPlayerId:null,remainingQuestions:g.remainingQuestions,wrongGuesses:g.wrongGuesses};io.to(room.code).emit("game:round-ended",g.lastResult);}
  room.players.delete(playerId);if(room.hostId===playerId)room.hostId=[...room.players.values()].filter(x=>x.connected).sort((a,b)=>a.joinedAt-b.joinedAt)[0]?.id??[...room.players.values()].sort((a,b)=>a.joinedAt-b.joinedAt)[0]?.id??null;
  if(room.players.size===0){if(room.game)cancelQuestionTimer(room.game);rooms.delete(room.code);persist();}else emitRoom(room);
}

restoreRooms();

io.on("connection",socket=>{
  socket.on("room:create",({nickname}={})=>{try{const n=cleanNickname(nickname);if(n.length<2)throw new Error("Choose a nickname with at least 2 characters.");attachPlayer(socket,createRoom(),n);}catch(e){emitError(socket,e.message);}});
  socket.on("room:join",({code,nickname,reconnectToken}={})=>{try{const n=cleanNickname(nickname),c=String(code??"").trim().toUpperCase();if(!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(c))throw new Error("Enter a valid 4-character room code.");const r=getRoom(c);if(!r||Date.now()-r.updatedAt>ROOM_IDLE_MS)throw new Error("We couldn't find that room. Check the code or create a new room.");if(n.length<2)throw new Error("Choose a nickname with at least 2 characters.");if(reconnectToken){const p=[...r.players.values()].find(x=>x.reconnectTokenHash===tokenHash(reconnectToken));if(p)return attachPlayer(socket,r,p.nickname,p.id,reconnectToken);}if(nicknameTaken(r,n,socket.id))throw new Error("That nickname is already taken in this room. Try another.");if(r.status!=="lobby"&&!(r.game?.phase==="waiting_players"&&r.players.size<MAX_PLAYERS)) { socket.data.roomCode=r.code; socket.data.playerId=null; socket.data.spectator=true; socket.data.spectatorNickname=n; socket.join(r.code); socket.emit("room:joined",{room:publicRoom(r),playerId:null,reconnectToken:null,rejoined:false,spectating:true}); return; } attachPlayer(socket,r,n);}catch(e){emitError(socket,e.message);}});
  socket.on("room:reconnect",({code,playerId,reconnectToken}={})=>{try{const r=getRoom(code),p=r?.players.get(playerId);if(!p||p.reconnectTokenHash!==tokenHash(reconnectToken))throw new Error("We couldn't restore this player session. Please rejoin the room.");attachPlayer(socket,r,p.nickname,p.id,reconnectToken);}catch(e){emitError(socket,e.message,"RECONNECT_FAILED");}});
  socket.on("room:start",()=>{const {room,player}=findPlayer(socket);if(!room||!player)return emitError(socket,"Join a room first.");if(room.hostId!==player.id)return emitError(socket,"Only the host can start the game.");if(room.status!=="lobby")return emitError(socket,"This game has already started.");if([...room.players.values()].filter(p=>p.connected).length<MIN_PLAYERS)return emitError(socket,"You need at least 3 connected players to start.");startGame(room);});
  socket.on("game:choose-secret",({secret}={})=>{const {room,player}=findPlayer(socket),g=room?.game;if(!g||!player||g.phase!=="choosing_secret"||player.id!==g.keeperId)return emitError(socket,"Only the Keeper can choose the secret right now.");if(!g.choices.includes(secret))return emitError(socket,"Choose one of the three secret options.");g.secret=secret;if(!g.usedSecrets.includes(secret))g.usedSecrets.push(secret);g.phase="active";io.to(room.code).emit("game:active",{category:g.category,keeperNickname:player.nickname});emitRoom(room);});
  socket.on("game:ask-question",({text}={})=>{const {room,player}=findPlayer(socket),g=room?.game;if(!g||!player||g.phase!=="active")return emitError(socket,"There isn't an active round.");if(player.id===g.keeperId)return emitError(socket,"The Keeper can't ask questions.");if(g.currentQuestion)return emitError(socket,"Wait for the current question to be answered or skipped.");if(g.remainingQuestions<=0)return endRound(room,"no_questions");const q=String(text??"").trim().replace(/\s+/g," ");if(q.length<3||q.length>120)return emitError(socket,"Questions must be 3–120 characters long.");if(g.questionLog.some(x=>normalizeText(x.text)===normalizeText(q)))return emitError(socket,"That question has already been asked this round.");g.currentQuestion={id:randomUUID(),playerId:player.id,text:q,askedAt:Date.now(),deadline:Date.now()+20_000};scheduleQuestionTimeout(room);io.to(room.code).emit("game:question",{id:g.currentQuestion.id,playerId:player.id,nickname:player.nickname,text:q,deadline:g.currentQuestion.deadline});emitRoom(room);});
  socket.on("game:answer-question",({answer}={})=>{const {room,player}=findPlayer(socket),g=room?.game;if(!g||!player||g.phase!=="active"||player.id!==g.keeperId||!g.currentQuestion)return emitError(socket,"Only the Keeper can answer the current question.");const a=String(answer??"");if(!["Yes","No","Sometimes"].includes(a))return emitError(socket,"Choose Yes, No, or Sometimes.");cancelQuestionTimer(g);const q={...g.currentQuestion,answer:a,status:"answered",answeredAt:Date.now()};g.questionLog.push(q);g.currentQuestion=null;g.remainingQuestions=Math.max(0,g.remainingQuestions-1);io.to(room.code).emit("game:answered",{id:q.id,answer:a,remainingQuestions:g.remainingQuestions});if(g.remainingQuestions===0)endRound(room,"no_questions");else emitRoom(room);});
  socket.on("game:guess",({guess}={})=>{const {room,player}=findPlayer(socket),g=room?.game;if(!g||!player||g.phase!=="active")return emitError(socket,"There isn't an active round.");if(player.id===g.keeperId)return emitError(socket,"The Keeper can't guess their own secret.");if(player.lockedUntil>Date.now())return emitError(socket,`Wait ${Math.ceil((player.lockedUntil-Date.now())/1000)} seconds before guessing again.`);const value=String(guess??"").trim().slice(0,100);if(value.length<1)return emitError(socket,"Type a guess first.");if(guessMatches(value,g.secret)){player.score+=10+g.remainingQuestions;g.correctPlayerId=player.id;io.to(room.code).emit("game:correct-guess",{playerId:player.id,nickname:player.nickname,guess:value});endRound(room,"correct_guess");return;}g.wrongGuesses++;g.remainingQuestions=Math.max(0,g.remainingQuestions-2);player.lockedUntil=Date.now()+5000;io.to(room.code).emit("game:wrong-guess",{playerId:player.id,nickname:player.nickname,lockSeconds:5,remainingQuestions:g.remainingQuestions});if(g.remainingQuestions===0)endRound(room,"no_questions");else emitRoom(room);});
  socket.on("game:skip-round",()=>{const {room,player}=findPlayer(socket),g=room?.game;if(!room||!player)return emitError(socket,"Join a room first.");if(room.hostId!==player.id)return emitError(socket,"Only the host can skip the round.");if(!g||!['choosing_secret','active'].includes(g.phase))return emitError(socket,"There is no active round to skip.");endRound(room,"host_skipped");});
  socket.on("game:next-round",()=>{const {room,player}=findPlayer(socket);if(!room||!player)return emitError(socket,"Join a room first.");if(room.hostId!==player.id)return emitError(socket,"Only the host can continue.");if(room.game?.phase!=="round_over")return emitError(socket,"The round is not over yet.");nextRound(room);});
  socket.on("game:end-game",()=>{const {room,player}=findPlayer(socket);if(!room||!player)return emitError(socket,"Join a room first.");if(room.hostId!==player.id)return emitError(socket,"Only the host can end the game.");const g=room.game;if(!g){room.status="lobby";emitRoom(room);return;}cancelQuestionTimer(g);if((g.completedRounds||0)===0){room.status="lobby";room.game=null;for(const p of room.players.values())p.score=0;emitRoom(room);io.to(room.code).emit("game:notice",{message:"Game ended before a round finished. Back to the lobby."});return;}g.phase="game_over";room.status="game_over";g.podium=[...room.players.values()].sort((a,b)=>b.score-a.score||a.joinedAt-b.joinedAt).map((p,i)=>({id:p.id,nickname:p.nickname,score:p.score,place:i+1}));io.to(room.code).emit("game:over",{podium:g.podium});emitRoom(room);});
  socket.on("game:play-again",async()=>{const {room,player}=findPlayer(socket);if(!room||!player||room.hostId!==player.id)return emitError(socket,"Only the host can start a rematch.");if(room.game?.phase!=="game_over")return emitError(socket,"Finish the current game first.");room.status="lobby";room.game=null;for(const p of room.players.values())p.score=0;emitRoom(room);const sockets=await io.in(room.code).fetchSockets();for(const spectator of sockets){if(!spectator.data.spectator||!spectator.data.spectatorNickname||room.players.size>=MAX_PLAYERS)continue;try{attachPlayer(spectator,room,spectator.data.spectatorNickname);}catch(error){emitError(spectator,error.message);}}});
  socket.on("room:remove-player",({playerId}={})=>{const {room,player}=findPlayer(socket);if(!room||!player)return emitError(socket,"Join a room first.");if(room.hostId!==player.id)return emitError(socket,"Only the host can remove players.");if(playerId===player.id)return emitError(socket,"You can't remove yourself. Leave the room instead.");const target=room.players.get(playerId);if(!target)return emitError(socket,"That player is no longer in the room.");if(target.socketId){io.to(target.socketId).emit("room:removed",{message:"The host removed you from this room."});const s=io.sockets.sockets.get(target.socketId);if(s){s.leave(room.code);s.data.roomCode=null;s.data.playerId=null;}}removePlayer(room,target.id);});
  socket.on("room:leave",()=>{const {room,player}=findPlayer(socket);if(!room)return;if(player)removePlayer(room,player.id);socket.leave(room.code);socket.data.roomCode=null;socket.data.playerId=null;socket.data.spectator=false;});
  socket.on("disconnect",()=>{const {room,player}=findPlayer(socket);if(!room||!player||player.socketId!==socket.id)return;player.connected=false;player.disconnectedAt=Date.now();player.socketId=null;if(room.hostId===player.id)room.hostId=[...room.players.values()].filter(p=>p.connected).sort((a,b)=>a.joinedAt-b.joinedAt)[0]?.id??player.id;player.disconnectTimer=setTimeout(()=>{const r=getRoom(room.code),p=r?.players.get(player.id);if(p&&!p.connected&&p.disconnectedAt&&Date.now()-p.disconnectedAt>=DISCONNECT_GRACE_MS)removePlayer(r,p.id);},DISCONNECT_GRACE_MS);player.disconnectTimer.unref?.();if(room.game?.keeperId===player.id&&!['round_over','game_over'].includes(room.game.phase)){const g=room.game;cancelQuestionTimer(g);g.phase="round_over";delete g.resumePhase;g.completedRounds=(g.completedRounds||0)+1;g.lastResult={reason:"keeper_disconnected",secret:g.secret,category:g.category,keeperId:g.keeperId,correctPlayerId:null,remainingQuestions:g.remainingQuestions,wrongGuesses:g.wrongGuesses};io.to(room.code).emit("game:round-ended",g.lastResult);}else if(room.game&&['active','choosing_secret'].includes(room.game.phase)&&[...room.players.values()].filter(p=>p.connected).length<MIN_PLAYERS){const g=room.game;g.resumePhase=g.phase;g.phase="waiting_players";room.status="paused";cancelQuestionTimer(g);io.to(room.code).emit("game:notice",{message:"Round paused until at least 3 players reconnect."});}emitRoom(room);});
});
setInterval(()=>{const now=Date.now();for(const r of rooms.values())if(r.players.size===0||now-r.updatedAt>ROOM_IDLE_MS){if(r.game)cancelQuestionTimer(r.game);rooms.delete(r.code);}},10*60*1000).unref();
const port=Number(process.env.PORT||3000);
server.listen(port,"0.0.0.0",()=>console.log(`Who's the Keeper? listening on port ${port}`));
