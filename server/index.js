import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const isProduction = process.env.NODE_ENV === 'production';
const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true, app: 'NEON STRIKE', time: Date.now() }));

if (isProduction) {
  app.use(express.static(distDir, { maxAge: '1h', etag: true }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/socket.io') || req.path.startsWith('/healthz')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, credentials: false },
  transports: ['polling', 'websocket'],
  pingInterval: 25000,
  pingTimeout: 60000,
  maxHttpBufferSize: 1e5,
  connectionStateRecovery: { maxDisconnectionDuration: 120000, skipMiddlewares: true },
});

io.engine.on('connection_error', error => console.warn('[Socket.IO] connection error:', error?.code || '', error?.message || ''));

const PORT = Number(process.env.PORT || 3000);
const BUY_MS = 12_000;
const ROUND_MS = 90_000;
const NEXT_ROUND_MS = 5_000;
const WINS_TO_MATCH = 6;
const STARTING_CREDITS = 450;
const ROUND_WIN_REWARD = 650;
const ROUND_LOSS_REWARD = 400;
const KILL_REWARD = 75;
const rooms = new Map();
const mapCoverBoxes = {
  arena: [
    {x:0,z:-34,w:70,d:1.4,h:5},{x:0,z:34,w:70,d:1.4,h:5},{x:-34,z:0,w:1.4,d:70,h:5},{x:34,z:0,w:1.4,d:70,h:5},
    {x:-15,z:-12,w:7,d:3,h:2.6},{x:-3,z:-14,w:4,d:4,h:1.5},{x:10,z:-12,w:7,d:3,h:2.8},
    {x:-19,z:0,w:3,d:8,h:2.2},{x:-8,z:-1,w:5,d:3,h:1.4},{x:6,z:2,w:4,d:5,h:2.4},{x:19,z:0,w:3,d:8,h:2.2},
    {x:-13,z:15,w:8,d:3,h:2.6},{x:0,z:13,w:5,d:4,h:1.5},{x:13,z:15,w:8,d:3,h:2.6},{x:-2,z:0,w:2,d:2,h:3.6},
    ...[-20,20].flatMap(z=>[ {x:-18,z,w:10,d:1.35,h:6.2},{x:0,z,w:14,d:1.35,h:6.2},{x:18,z,w:10,d:1.35,h:6.2} ]),
    {x:-10,z:-8,w:1.6,d:10,h:6.8},{x:10,z:8,w:1.6,d:10,h:6.8},
    {x:-28,z:-27,w:.7,d:.7,h:4},{x:28,z:27,w:.7,d:.7,h:4},{x:-28,z:27,w:.7,d:.7,h:4},{x:28,z:-27,w:.7,d:.7,h:4}
  ],
  palace: [
    {x:0,z:-47.3,w:95,d:1.5,h:3.2},{x:0,z:47.3,w:95,d:1.5,h:3.2},{x:-47.3,z:0,w:1.5,d:95,h:3.2},{x:47.3,z:0,w:1.5,d:95,h:3.2},
    {x:0,z:-27,w:30,d:10,h:4.8},{x:0,z:-21.75,w: .62,d:.72,h:5.9},
    {x:-24,z:-17,w:9,d:6,h:3.6},{x:24,z:-17,w:9,d:6,h:3.6},
    ...[-7,4,16,28].flatMap(z=>[{x:-20,z,w:10,d:1.2,h:1.18},{x:20,z,w:10,d:1.2,h:1.18},{x:-8,z:z+2,w:4,d:1.1,h:.92},{x:8,z:z-2,w:4,d:1.1,h:.92}]),
    ...[-33,33].flatMap(z=>[ {x:-24,z,w:10,d:1.35,h:5.8},{x:0,z,w:13,d:1.35,h:5.8},{x:24,z,w:10,d:1.35,h:5.8} ]),
  ],
  city: [
    ...[-59, -15, 15].map(a=>({x:(a===-59?-37:a===-15?0:37),z:-59.8,w:a===-59?44: a===-15?10:44,d:1.5,h:7})),
    ...[-59, -15, 15].map(a=>({x:(a===-59?-37:a===-15?0:37),z:59.8,w:a===-59?44: a===-15?10:44,d:1.5,h:7})),
    ...[-59, -15, 15].map(a=>({x:-59.8,z:(a===-59?-37:a===-15?0:37),w:1.5,d:a===-59?44:a===-15?10:44,h:7})),
    ...[-59, -15, 15].map(a=>({x:59.8,z:(a===-59?-37:a===-15?0:37),w:1.5,d:a===-59?44:a===-15?10:44,h:7})),
    {x:-31,z:-29,w:14,d:16,h:7},{x:31,z:18,w:13,d:15,h:5.5},
    ...[[-43,-6,12,17,8],[-16,-31,9,12,5],[18,-31,15,12,8],[45,-17,10,16,7],[-45,22,13,18,9],[13,40,18,10,6],[43,39,15,13,8],[-12,39,13,11,6]].map(([x,z,w,d,h])=>({x,z,w,d,h})),
    ...[[-20,-4],[20,4],[-19,20],[19,-19]].map(([x,z])=>({x,z,w:10,d:6,h:3.4})),
    {x:0,z:29,w:11,d:7,h:1.65},{x:-5.1,z:29,w:1,d:9,h:2.5},{x:5.1,z:29,w:1,d:9,h:2.5},
    ...[[-8,-17],[8,17],[-8,39],[8,-39]].map(([x,z])=>({x,z,w:4,d:1.4,h:1.35})),
    // Short high cover at the spawn sight line, leaving wide routes around each segment.
    ...[-43,43].flatMap(z=>[ {x:-18,z,w:11,d:1.55,h:7.1},{x:0,z,w:14,d:1.55,h:7.1},{x:18,z,w:11,d:1.55,h:7.1} ]),
  ]
};
function isShotBlocked(origin, direction, maxDistance, mapId='arena') {
  let nearest = maxDistance;
  for (const box of mapCoverBoxes[mapId] || mapCoverBoxes.arena) {
    let tMin = 0, tMax = maxDistance;
    for (const axis of ['x','z']) {
      const d = direction[axis], p = origin[axis], half = box[axis === 'x' ? 'w' : 'd'] / 2;
      const min = box[axis] - half, max = box[axis] + half;
      if (Math.abs(d) < 1e-7) { if (p < min || p > max) { tMin = Infinity; break; } }
      else {
        let a = (min-p)/d, b = (max-p)/d;
        if (a>b) [a,b] = [b,a];
        tMin = Math.max(tMin,a); tMax = Math.min(tMax,b);
      }
    }
    if (tMin <= tMax && tMax >= 0 && tMin < nearest) {
      const t = Math.max(0,tMin), y = origin.y + direction.y*t;
      if (y >= 0 && y <= box.h) nearest = t;
    }
  }
  return nearest < maxDistance - .12;
}
function mapBounds(mapId){return mapId==='city'?66:mapId==='palace'?45.5:31.8;}
function mapSpawn(mapId){return mapId==='city'?52:mapId==='palace'?40:27;}

function code6() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function safeName(name) { return String(name || 'PLAYER').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16) || 'PLAYER'; }
function safeSessionId(value) { return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100); }
function compatible(rule, device) { return rule === 'crossplay' || rule === device; }
function publicPlayer(p) { return { x:p.x, y:p.y||0, z:p.z, yaw:p.yaw, pitch:p.pitch, name:p.name, hp:p.hp, armor:p.armor, weapon:p.weapon, device:p.device, score:p.score }; }
function playerById(room, id) { return room?.players.get(id); }
function selfPayload(p) { return { money:p.money, hp:p.hp, armor:p.armor, armorTier:p.armorTier, weapon:p.weapon, ownedWeapons:[...(p.ownedWeapons||['pistol'])], boughtPrimary:p.boughtPrimary, armorPurchased:p.armorPurchased, x:p.x, y:p.y||0, z:p.z, yaw:p.yaw, pitch:p.pitch }; }
function playersSnapshot(room) { return Object.fromEntries([...room.players.entries()].map(([id,p])=>[id,publicPlayer(p)])); }
function emitState(room) {
  const players = playersSnapshot(room);
  for (const [id,p] of room.players) {
    io.to(id).emit('roundState', {
      code: room.code, map: room.map || 'arena', phase: room.phase, round: room.round, endsAt: room.phaseEndsAt,
      roundEndsAt: room.liveEndsAt, scores: Object.fromEntries([...room.players.entries()].map(([pid,pl])=>[pid,pl.score])),
      self: selfPayload(p), players,
    });
  }
}
function resetPlayerForRound(room, p, index) {
  p.hp = 100;
  p.armor = Math.max(0, p.armor); // Retain surviving shield points between rounds.
  if (p.armor <= 0) p.armorTier = 'none';
  p.boughtPrimary = false;
  p.armorPurchased = p.armorTier === 'heavy';
  p.lastFireAt = 0;
  // Spawn both players at opposite ends of the arena, out of immediate contact.
  p.x = index === 0 ? -3 : 3;
  p.y = 0;
  const spawn=mapSpawn(room.map);p.z = index === 0 ? spawn : -spawn;
  p.yaw = index === 0 ? 0 : Math.PI;
  p.pitch = 0;
}
function beginRound(room) {
  if (!rooms.has(room.code) || room.players.size !== 2 || [...room.players.values()].some(p=>p.connected===false)) return;
  room.phaseBeforeDisconnect=null;room.remainingPhaseMs=0;
  if (room.timer) clearTimeout(room.timer);
  room.round += 1;
  room.phase = 'buy';
  room.phaseEndsAt = Date.now() + BUY_MS;
  room.liveEndsAt = room.phaseEndsAt + ROUND_MS;
  [...room.players.values()].forEach((p,i)=>resetPlayerForRound(room,p,i));
  emitState(room);
  room.timer = setTimeout(() => startLive(room), BUY_MS);
}
function startLive(room) {
  if (!rooms.has(room.code) || room.players.size !== 2 || [...room.players.values()].some(p=>p.connected===false) || room.phase !== 'buy') return;
  room.phase = 'live';
  room.phaseEndsAt = Date.now() + ROUND_MS;
  room.liveEndsAt = room.phaseEndsAt;
  io.to(room.code).emit('roundPhase', { phase:'live', round:room.round, endsAt:room.phaseEndsAt });
  room.timer = setTimeout(() => resolveTimedRound(room), ROUND_MS);
}
function resolveTimedRound(room) {
  if (!room || room.phase !== 'live' || room.players.size !== 2) return;
  const entries = [...room.players.entries()];
  const [idA,a] = entries[0], [idB,b] = entries[1];
  const ratioA = a.hp + a.armor * .25, ratioB = b.hp + b.armor * .25;
  if (Math.abs(ratioA-ratioB)<1) endRound(room,null,'시간 종료 · 체력 동률');
  else endRound(room,ratioA>ratioB?idA:idB,'시간 종료 · 체력 우세');
}
function restoreRoomPhaseAfterDisconnect(room) {
  if (!room?.phaseBeforeDisconnect) return;
  const phase = room.phaseBeforeDisconnect;
  const remaining = Math.max(1000, Number(room.remainingPhaseMs) || 1000);
  room.phaseBeforeDisconnect = null;
  room.remainingPhaseMs = 0;
  room.phase = phase;
  if (phase === 'buy') {
    room.phaseEndsAt = Date.now() + remaining;
    room.liveEndsAt = room.phaseEndsAt + ROUND_MS;
    room.timer = setTimeout(() => startLive(room), remaining);
  } else if (phase === 'live') {
    room.phaseEndsAt = Date.now() + remaining;
    room.liveEndsAt = room.phaseEndsAt;
    room.timer = setTimeout(() => resolveTimedRound(room), remaining);
  } else if (phase === 'waiting') {
    room.phaseEndsAt = 0;
    room.liveEndsAt = 0;
  }
}
function endRound(room, winnerId, reason='적 처치') {
  if (!room || room.phase !== 'live') return;
  if (room.timer) clearTimeout(room.timer);
  room.phase='ended';room.lastWinnerId=winnerId;room.lastReason=reason;
  let matchOver=false;
  if (winnerId && room.players.has(winnerId)) room.players.get(winnerId).score += 1;
  if ([...room.players.values()].some(p=>p.score>=WINS_TO_MATCH)) matchOver=true;
  for (const [id,p] of room.players) {
    const won = winnerId===id;
    const reward = won?ROUND_WIN_REWARD:ROUND_LOSS_REWARD;
    p.money += reward;
    io.to(id).emit('roundResult', {
      winnerId, reason, scores:Object.fromEntries([...room.players.entries()].map(([pid,pl])=>[pid,pl.score])),
      selfMoney:p.money, reward, matchOver, round:room.round, nextRoundInMs:0,
    });
  }
  if (matchOver) {
    room.phase='matchover';room.lastMatchOver=true;
    return;
  }
  // The next round begins only when a player presses the explicit next-round button.
  room.timer=null;
}
function closeRoom(room) {
  if (room?.timer) clearTimeout(room.timer);
  if (room) { for (const p of room.players.values()) if (p.reconnectTimer) clearTimeout(p.reconnectTimer); rooms.delete(room.code); }
}
function leaveRoom(socket, announce=true) {
  const code=socket.data.roomCode;
  if (!code) return;
  const room=rooms.get(code);
  socket.data.roomCode=null;
  socket.leave(code);
  if (!room) return;
  const existing=room.players.get(socket.id);
  if(existing?.reconnectTimer)clearTimeout(existing.reconnectTimer);
  room.players.delete(socket.id);
  if (announce) io.to(code).emit('playerLeft',{id:socket.id});
  if (room.players.size===0) closeRoom(room);
  else {
    if (room.timer) clearTimeout(room.timer);
    room.timer=null;room.phase='waiting';room.phaseEndsAt=0;room.liveEndsAt=0;
    io.to(code).emit('roomMessage',{message:'상대가 나갔습니다. 새 플레이어가 참가하거나 다시 연결할 때까지 대기합니다.'});
  }
}
function suspendDisconnectedSocket(socket) {
  const code=socket.data.roomCode;
  const room=rooms.get(code);
  if(!room)return;
  const p=room.players.get(socket.id);
  if(!p)return;
  p.connected=false;
  if(room.timer)clearTimeout(room.timer);
  room.timer=null;
  // Pause the current round rather than resetting the match when a network blip occurs.
  if(!room.phaseBeforeDisconnect){
    room.phaseBeforeDisconnect=room.phase;
    const deadline=room.phase==='buy'?room.phaseEndsAt:room.phase==='live'?room.liveEndsAt:0;
    room.remainingPhaseMs=deadline?Math.max(1000,deadline-Date.now()):0;
  }
  io.to(code).emit('roomMessage',{message:`${p.name} 연결이 끊겼습니다. 현재 라운드를 보존하고 90초 동안 재연결을 기다립니다.`});
  if(p.reconnectTimer)clearTimeout(p.reconnectTimer);
  p.reconnectTimer=setTimeout(()=>{
    const currentRoom=rooms.get(code);if(!currentRoom)return;
    const entry=[...currentRoom.players.entries()].find(([,candidate])=>candidate.sessionId===p.sessionId);
    if(!entry)return;
    const [oldId,stale]=entry;currentRoom.players.delete(oldId);stale.reconnectTimer=null;
    io.to(code).emit('playerLeft',{id:oldId});
    if(currentRoom.timer)clearTimeout(currentRoom.timer);
    currentRoom.timer=null;currentRoom.phase='waiting';currentRoom.phaseEndsAt=0;currentRoom.liveEndsAt=0;currentRoom.phaseBeforeDisconnect=null;currentRoom.remainingPhaseMs=0;
    if(currentRoom.players.size===0)closeRoom(currentRoom);
    else io.to(code).emit('roomMessage',{message:'상대의 재연결 시간이 만료되었습니다. 새 플레이어가 참가할 수 있습니다.'});
  },90000);
  p.reconnectTimer.unref?.();
}

function resumePlayer(socket,payload) {
  const code=String(payload?.code||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
  const sessionId=safeSessionId(payload?.sessionId);
  const room=rooms.get(code);
  if(!room||!sessionId){socket.emit('roomError',{message:'재연결 정보를 찾을 수 없습니다. 새 방을 만들거나 방 코드로 다시 참가하세요.'});return;}
  const entry=[...room.players.entries()].find(([,p])=>p.sessionId===sessionId);
  if(!entry){socket.emit('roomError',{message:'재연결 대기 시간이 끝났습니다. 방 코드를 다시 입력해 주세요.'});return;}
  const [oldId,p]=entry;
  if(p.reconnectTimer)clearTimeout(p.reconnectTimer);
  p.reconnectTimer=null;p.connected=true;p.id=socket.id;
  if(oldId!==socket.id)room.players.delete(oldId);
  room.players.set(socket.id,p);socket.data.roomCode=code;socket.data.sessionId=sessionId;socket.join(code);
  if(oldId!==socket.id)io.to(code).emit('playerLeft',{id:oldId});
  socket.emit('roomResumed',{code,map:room.map,rule:room.rule,phase:room.phase,round:room.round});
  socket.emit('playersSnapshot',playersSnapshot(room));
  if(room.players.size===2&&[...room.players.values()].every(candidate=>candidate.connected!==false)){
    restoreRoomPhaseAfterDisconnect(room);
    io.to(code).emit('playerJoined',{id:socket.id,player:publicPlayer(p)});
    if(room.phase==='waiting')beginRound(room);
    else if(room.phase==='ended'||room.phase==='matchover'){
      for(const [pid,player] of room.players){io.to(pid).emit('roundResult',{winnerId:room.lastWinnerId??null,reason:room.lastReason||'라운드 종료',scores:Object.fromEntries([...room.players.entries()].map(([key,value])=>[key,value.score])),selfMoney:player.money,reward:0,matchOver:room.phase==='matchover',round:room.round,nextRoundInMs:0});}
    } else emitState(room);
  }
}

io.on('connection', socket => {
  socket.on('error', error => console.warn('[Socket.IO] socket error:', socket.id, error?.message || error));
  if (socket.data.roomCode === undefined) socket.data.roomCode=null;
  socket.on('createRoom', payload => {
    const name=safeName(payload?.name), device=payload?.device==='mobile'?'mobile':'pc', sessionId=safeSessionId(payload?.sessionId);
    const requestedRule=['pc','mobile','crossplay'].includes(payload?.rule)?payload.rule:'crossplay';
    const requestedMap=['arena','palace','city'].includes(payload?.map)?payload.map:'arena';
    if (!compatible(requestedRule,device)) {
      socket.emit('roomError',{message:requestedRule==='pc'?'PC끼리 모드는 PC를 선택해야 합니다.':'모바일끼리 모드는 모바일을 선택해야 합니다.'});return;
    }
    leaveRoom(socket,false);
    const code=code6();
    const p={id:socket.id,sessionId,name,device,connected:true,x:0,y:0,z:0,yaw:0,pitch:0,hp:100,armor:0,armorTier:'none',money:STARTING_CREDITS,weapon:'pistol',ownedWeapons:['pistol'],score:0,boughtPrimary:false,armorPurchased:false,lastFireAt:0,reconnectTimer:null};
    const room={code,rule:requestedRule,map:requestedMap,players:new Map([[socket.id,p]]),phase:'waiting',round:0,phaseEndsAt:0,liveEndsAt:0,timer:null};
    rooms.set(code,room);socket.data.roomCode=code;socket.join(code);
    socket.emit('roomCreated',{code,rule:requestedRule,device,map:room.map});
  });
  socket.on('joinRoom', payload => {
    const code=String(payload?.code||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
    const room=rooms.get(code);
    if (!room) {socket.emit('roomError',{message:'방을 찾을 수 없습니다. 코드가 정확한지 확인하세요.'});return;}
    if (room.players.size>=2) {socket.emit('roomError',{message:'이미 두 명이 참가한 방입니다.'});return;}
    const device=payload?.device==='mobile'?'mobile':'pc';
    const sessionId=safeSessionId(payload?.sessionId);
    if (!compatible(room.rule,device)) {
      const message=room.rule==='pc'?'이 방은 PC끼리 대전하는 방입니다. PC 기기 선택 후 참가하세요.':room.rule==='mobile'?'이 방은 모바일끼리 대전하는 방입니다. 모바일 기기 선택 후 참가하세요.':'기기 설정을 확인하세요.';
      socket.emit('roomError',{message});return;
    }
    leaveRoom(socket,false);
    const name=safeName(payload?.name);
    const p={id:socket.id,sessionId,name,device,connected:true,x:0,y:0,z:0,yaw:0,pitch:0,hp:100,armor:0,armorTier:'none',money:STARTING_CREDITS,weapon:'pistol',ownedWeapons:['pistol'],score:0,boughtPrimary:false,armorPurchased:false,lastFireAt:0,reconnectTimer:null};
    room.players.set(socket.id,p);socket.data.roomCode=code;socket.join(code);
    socket.emit('roomJoined',{code,rule:room.rule,device,map:room.map});
    socket.to(code).emit('playerJoined',{id:socket.id,player:publicPlayer(p)});
    socket.emit('playersSnapshot',playersSnapshot(room));
    beginRound(room);
  });
  socket.on('resumeRoom', payload => resumePlayer(socket,payload));
  socket.on('move', payload => {
    const room=rooms.get(socket.data.roomCode);const p=playerById(room,socket.id);if(!p||p.connected===false||!payload)return;
    const x=Number(payload.x),y=Number(payload.y??0),z=Number(payload.z),yaw=Number(payload.yaw),pitch=Number(payload.pitch);
    if (![x,y,z,yaw,pitch].every(Number.isFinite))return;
    const bound=mapBounds(room.map);p.x=Math.max(-bound,Math.min(bound,x));p.y=Math.max(0,Math.min(8,y));p.z=Math.max(-bound,Math.min(bound,z));p.yaw=Math.max(-Math.PI*2,Math.min(Math.PI*2,yaw));p.pitch=Math.max(-1.35,Math.min(1.35,pitch));
    socket.to(room.code).emit('playerMoved',{id:socket.id,x:p.x,y:p.y,z:p.z,yaw:p.yaw,pitch:p.pitch,name:p.name,hp:p.hp,weapon:p.weapon,device:p.device});
  });
  socket.on('buy', payload => {
    const room=rooms.get(socket.data.roomCode);const p=playerById(room,socket.id);
    if(!room||!p||room.phase!=='buy'){socket.emit('buyResult',{ok:false,message:'구매 단계에서만 살 수 있습니다.'});return;}
    if(payload?.kind==='armor'){
      const tier=payload?.tier==='heavy'?'heavy':'light';
      const gear=tier==='heavy'?{cost:1000,value:110,name:'중량 보호막'}:{cost:400,value:60,name:'경량 보호막'};
      if(tier==='light'&&p.armorTier!=='none'){socket.emit('buyResult',{ok:false,message:'이미 보호막을 보유 중입니다. 중량 보호막으로 강화할 수 있습니다.'});return;}
      if(tier==='heavy'&&p.armorTier==='heavy'){socket.emit('buyResult',{ok:false,message:'이미 중량 보호막을 보유하고 있습니다.'});return;}
      if(p.money<gear.cost){socket.emit('buyResult',{ok:false,message:'크레딧이 부족합니다.'});return;}
      p.money-=gear.cost;p.armor=gear.value;p.armorTier=tier;p.armorPurchased=tier==='heavy';
      socket.emit('buyResult',{ok:true,message:`${gear.name} 장착 완료`,money:p.money,armor:p.armor,armorTier:p.armorTier,armorPurchased:p.armorPurchased,weapon:p.weapon,boughtPrimary:p.boughtPrimary});
      return;
    }
    const id=String(payload?.weaponId||'');const w=weapons[id];
    if(!w){socket.emit('buyResult',{ok:false,message:'알 수 없는 무기입니다.'});return;}
    p.ownedWeapons ||= ['pistol'];
    if(p.ownedWeapons.includes(id)){
      p.weapon=id;
      socket.emit('buyResult',{ok:true,message:`${id.toUpperCase()} 장착`,money:p.money,armor:p.armor,armorTier:p.armorTier,weapon:p.weapon,ownedWeapons:p.ownedWeapons,boughtPrimary:p.boughtPrimary,armorPurchased:p.armorPurchased});
      return;
    }
    if(w.slot==='primary'&&p.boughtPrimary){socket.emit('buyResult',{ok:false,message:'이번 구매 단계에 새 주무기는 하나만 살 수 있습니다.'});return;}
    if(p.money<w.price){socket.emit('buyResult',{ok:false,message:'크레딧이 부족합니다.'});return;}
    if(w.slot==='primary'){
      p.money-=w.price;p.boughtPrimary=true;
      p.ownedWeapons=p.ownedWeapons.filter(ownedId=>weapons[ownedId]?.slot!=='primary');
      p.ownedWeapons.push(id);
    } else {
      if(id!=='pistol')p.money-=w.price;
      p.ownedWeapons.push(id);
    }
    p.weapon=id;
    socket.emit('buyResult',{ok:true,message:`${id.toUpperCase()} 구매/장착 완료`,money:p.money,armor:p.armor,armorTier:p.armorTier,weapon:p.weapon,ownedWeapons:p.ownedWeapons,boughtPrimary:p.boughtPrimary,armorPurchased:p.armorPurchased});
  });
  socket.on('equipWeapon', payload => {
    const room=rooms.get(socket.data.roomCode);const p=playerById(room,socket.id);const id=String(payload?.weaponId||'');
    if(!room||!p||!['buy','live'].includes(room.phase)){socket.emit('equipResult',{ok:false,message:'현재는 무기를 교체할 수 없습니다.'});return;}
    p.ownedWeapons ||= ['pistol'];
    if(!weapons[id]||!p.ownedWeapons.includes(id)){socket.emit('equipResult',{ok:false,message:'구매한 무기만 장착할 수 있습니다.'});return;}
    p.weapon=id;
    socket.emit('equipResult',{ok:true,weapon:id,ownedWeapons:p.ownedWeapons});
    socket.to(room.code).emit('playerWeapon',{id:socket.id,weapon:id});
  });
  socket.on('fire', payload => {
    try {
    const room=rooms.get(socket.data.roomCode);const shooter=playerById(room,socket.id);
    if(!room||!shooter||shooter.connected===false||room.phase!=='live'||shooter.hp<=0)return;
    const id=String(payload?.weaponId||'');const w=weapons[id];if(!w||id!==shooter.weapon)return;
    const now=Date.now();if(now-shooter.lastFireAt < w.rate*.72)return;shooter.lastFireAt=now;
    const o=payload?.origin,d=payload?.direction;
    if(!o||!d||![o.x,o.y,o.z,d.x,d.y,d.z].every(v=>Number.isFinite(Number(v))))return;
    const dirLen=Math.hypot(Number(d.x),Number(d.y),Number(d.z));if(dirLen<.7||dirLen>1.3)return;
    const origin={x:Number(o.x),y:Number(o.y),z:Number(o.z)};const direction={x:Number(d.x)/dirLen,y:Number(d.y)/dirLen,z:Number(d.z)/dirLen};
    const targetEntry=[...room.players.entries()].find(([id2,p])=>id2!==socket.id&&p.hp>0);
    let end={x:origin.x+direction.x*w.range,y:origin.y+direction.y*w.range,z:origin.z+direction.z*w.range};
    let hit=null;
    if(targetEntry){
      const [targetId,target]=targetEntry;const center={x:target.x,y:(target.y||0)+1.13,z:target.z};const vx=center.x-origin.x,vy=center.y-origin.y,vz=center.z-origin.z;
      const distance=Math.hypot(vx,vy,vz);const dot=(vx*direction.x+vy*direction.y+vz*direction.z)/(distance||1);
      // Wide enough to tolerate network jitter, narrow enough to discourage blind map-wide hits.
      const horizontalDistance=Math.hypot(vx,vz);const horizLen=Math.hypot(direction.x,direction.z)||1;const horizontalDot=(vx*direction.x+vz*direction.z)/(horizontalDistance*horizLen||1);
      if(distance<=w.range&&dot>.91&&(horizontalDistance<0.8||horizontalDot>.88)&&!isShotBlocked(origin,direction,distance,room.map)){
        hit={id:targetId,p:target};end=center;
      }
    }
    io.to(room.code).emit('shotFx',{id:socket.id,weaponId:id,origin,end});
    if(!hit)return;
    let damage=w.damage;
    if(id==='shotgun')damage=48;
    const t=hit.p;let left=damage;if(t.armor>0){const absorbRatio=t.armorTier==='heavy'?.60:.35;const absorbed=Math.min(t.armor,damage*absorbRatio);t.armor-=absorbed;left-=absorbed;if(t.armor<=0){t.armor=0;t.armorTier='none';}}t.hp=Math.max(0,t.hp-left);
    const killed=t.hp<=0;
    if(killed)shooter.money+=KILL_REWARD;
    io.to(room.code).emit('damage',{attackerId:socket.id,targetId:hit.id,hp:t.hp,armor:t.armor,armorTier:t.armorTier,killed,damage});
    for(const [pid,p] of room.players)if(pid===hit.id)io.to(pid).emit('selfState',selfPayload(p));
    socket.emit('selfState',selfPayload(shooter));
    if(killed)endRound(room,socket.id,`${shooter.name} 처치 성공`);
    } catch (error) {
      console.error('[NEON STRIKE] fire handler error:', error?.stack || error);
      socket.emit('roomMessage',{message:'사격 처리 중 오류가 발생했습니다. 연결은 유지됩니다.'});
    }
  });
  socket.on('nextRound',()=>{
    const room=rooms.get(socket.data.roomCode);
    if(!room||room.players.size!==2||[...room.players.values()].some(p=>p.connected===false)||room.phase!=='ended')return;
    if([...room.players.values()].some(p=>p.score>=WINS_TO_MATCH))return;
    if(room.timer)clearTimeout(room.timer);
    room.timer=null;
    beginRound(room);
  });
  socket.on('leaveRoom',()=>leaveRoom(socket,true));
  socket.on('disconnect',reason=>{
    // A recoverable network drop keeps the room slot briefly so two players do not lose the match.
    if(socket.data.intentionalLeave){leaveRoom(socket,true);return;}
    if(socket.recovered) { const room=rooms.get(socket.data.roomCode); const p=room?.players.get(socket.id); if(p?.reconnectTimer)clearTimeout(p.reconnectTimer); }
    suspendDisconnectedSocket(socket);
  });
  if(socket.recovered&&socket.data.roomCode){
    const room=rooms.get(socket.data.roomCode);const p=room?.players.get(socket.id);
    if(p){p.connected=true;if(p.reconnectTimer)clearTimeout(p.reconnectTimer);p.reconnectTimer=null;socket.join(room.code);if(room.players.size===2&&[...room.players.values()].every(candidate=>candidate.connected!==false))restoreRoomPhaseAfterDisconnect(room);socket.emit('roomResumed',{code:room.code,map:room.map,rule:room.rule,phase:room.phase,round:room.round});if(room.players.size===2&&[...room.players.values()].every(candidate=>candidate.connected!==false)){if(room.phase==='waiting')beginRound(room);else if(room.phase==='ended'||room.phase==='matchover'){for(const [pid,player] of room.players)io.to(pid).emit('roundResult',{winnerId:room.lastWinnerId??null,reason:room.lastReason||'라운드 종료',scores:Object.fromEntries([...room.players.entries()].map(([key,value])=>[key,value.score])),selfMoney:player.money,reward:0,matchOver:room.phase==='matchover',round:room.round,nextRoundInMs:0});}else emitState(room);}}
  }
});

httpServer.listen(PORT,'0.0.0.0',()=>{
  console.log(`NEON STRIKE listening on http://localhost:${PORT}`);
  console.log(`Mode: ${isProduction?'production':'development'} | Socket.IO ready`);
});

process.on('SIGINT',()=>{for(const room of rooms.values())if(room.timer)clearTimeout(room.timer);httpServer.close(()=>process.exit(0));});
process.on('SIGTERM',()=>{for(const room of rooms.values())if(room.timer)clearTimeout(room.timer);httpServer.close(()=>process.exit(0));});
