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
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e5,
});

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
const coverBoxes = [
  {x:0,z:-34,w:70,d:1.4,h:5},{x:0,z:34,w:70,d:1.4,h:5},{x:-34,z:0,w:1.4,d:70,h:5},{x:34,z:0,w:1.4,d:70,h:5},
  {x:-15,z:-12,w:7,d:3,h:2.6},{x:-3,z:-14,w:4,d:4,h:1.5},{x:10,z:-12,w:7,d:3,h:2.8},
  {x:-19,z:0,w:3,d:8,h:2.2},{x:-8,z:-1,w:5,d:3,h:1.4},{x:6,z:2,w:4,d:5,h:2.4},{x:19,z:0,w:3,d:8,h:2.2},
  {x:-13,z:15,w:8,d:3,h:2.6},{x:0,z:13,w:5,d:4,h:1.5},{x:13,z:15,w:8,d:3,h:2.6},
  {x:-2,z:0,w:2,d:2,h:3.6},
  // High spawn-screen barriers with offset flanking gaps, matching the Three.js arena.
  {x:-24,z:20,w:20,d:1.8,h:7.2},{x:13,z:20,w:42,d:1.8,h:7.2},
  {x:-13.5,z:-20,w:41,d:1.8,h:7.2},{x:23.5,z:-20,w:21,d:1.8,h:7.2},
  {x:-10,z:-8,w:1.6,d:10,h:6.8},{x:10,z:8,w:1.6,d:10,h:6.8},
  {x:-28,z:-27,w:.7,d:.7,h:4},{x:28,z:27,w:.7,d:.7,h:4},{x:-28,z:27,w:.7,d:.7,h:4},{x:28,z:-27,w:.7,d:.7,h:4}
];
function isShotBlocked(origin, direction, maxDistance) {
  let nearest = maxDistance;
  for (const box of coverBoxes) {
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

const weapons = {
  pistol: { price: 0, damage: 26, range: 55, rate: 280, slot:'sidearm' },
  revolver: { price: 550, damage: 47, range: 62, rate: 480, slot:'sidearm' },
  smg: { price: 850, damage: 17, range: 25, rate: 85, slot:'primary' },
  shotgun: { price: 1100, damage: 48, range: 13, rate: 780, slot:'primary' },
  rifle: { price: 1950, damage: 32, range: 50, rate: 120, slot:'primary' },
  dmr: { price: 2200, damage: 44, range: 75, rate: 420, slot:'primary' },
  sniper: { price: 3000, damage: 78, range: 100, rate: 1050, slot:'primary' },
  lmg: { price: 2500, damage: 22, range: 42, rate: 105, slot:'primary' },
  burst: { price: 1600, damage: 23, range: 45, rate: 320, slot:'primary' },
};

function code6() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function safeName(name) { return String(name || 'PLAYER').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 16) || 'PLAYER'; }
function compatible(rule, device) { return rule === 'crossplay' || rule === device; }
function publicPlayer(p) { return { x:p.x, y:0, z:p.z, yaw:p.yaw, pitch:p.pitch, name:p.name, hp:p.hp, armor:p.armor, weapon:p.weapon, device:p.device, score:p.score }; }
function playerById(room, id) { return room?.players.get(id); }
function selfPayload(p) { return { money:p.money, hp:p.hp, armor:p.armor, armorTier:p.armorTier, weapon:p.weapon, ownedWeapons:[...(p.ownedWeapons||['pistol'])], boughtPrimary:p.boughtPrimary, armorPurchased:p.armorPurchased, x:p.x, y:0, z:p.z, yaw:p.yaw, pitch:p.pitch }; }
function playersSnapshot(room) { return Object.fromEntries([...room.players.entries()].map(([id,p])=>[id,publicPlayer(p)])); }
function emitState(room) {
  const players = playersSnapshot(room);
  for (const [id,p] of room.players) {
    io.to(id).emit('roundState', {
      code: room.code, phase: room.phase, round: room.round, endsAt: room.phaseEndsAt,
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
  p.z = index === 0 ? 27 : -27;
  p.yaw = index === 0 ? 0 : Math.PI;
  p.pitch = 0;
}
function beginRound(room) {
  if (!rooms.has(room.code) || room.players.size !== 2) return;
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
  if (!rooms.has(room.code) || room.players.size !== 2 || room.phase !== 'buy') return;
  room.phase = 'live';
  room.phaseEndsAt = Date.now() + ROUND_MS;
  room.liveEndsAt = room.phaseEndsAt;
  io.to(room.code).emit('roundPhase', { phase:'live', round:room.round, endsAt:room.phaseEndsAt });
  room.timer = setTimeout(() => {
    const entries = [...room.players.entries()];
    if (entries.length !== 2) return;
    const [idA,a] = entries[0], [idB,b] = entries[1];
    const ratioA = a.hp + a.armor * .25, ratioB = b.hp + b.armor * .25;
    if (Math.abs(ratioA-ratioB)<1) endRound(room,null,'시간 종료 · 체력 동률');
    else endRound(room,ratioA>ratioB?idA:idB,'시간 종료 · 체력 우세');
  }, ROUND_MS);
}
function endRound(room, winnerId, reason='적 처치') {
  if (!room || room.phase !== 'live') return;
  if (room.timer) clearTimeout(room.timer);
  room.phase='ended';
  let matchOver=false;
  if (winnerId && room.players.has(winnerId)) room.players.get(winnerId).score += 1;
  if ([...room.players.values()].some(p=>p.score>=WINS_TO_MATCH)) matchOver=true;
  for (const [id,p] of room.players) {
    const won = winnerId===id;
    const reward = won?ROUND_WIN_REWARD:ROUND_LOSS_REWARD;
    p.money += reward;
    io.to(id).emit('roundResult', {
      winnerId, reason, scores:Object.fromEntries([...room.players.entries()].map(([pid,pl])=>[pid,pl.score])),
      selfMoney:p.money, reward, matchOver, round:room.round, nextRoundInMs:matchOver?0:NEXT_ROUND_MS,
    });
  }
  if (matchOver) {
    room.phase='matchover';
    return;
  }
  room.timer=setTimeout(()=>beginRound(room),NEXT_ROUND_MS);
}
function closeRoom(room) {
  if (room?.timer) clearTimeout(room.timer);
  if (room) rooms.delete(room.code);
}
function leaveRoom(socket, announce=true) {
  const code=socket.data.roomCode;
  if (!code) return;
  const room=rooms.get(code);
  socket.data.roomCode=null;
  socket.leave(code);
  if (!room) return;
  room.players.delete(socket.id);
  if (announce) socket.to(code).emit('playerLeft',{id:socket.id});
  if (room.players.size===0) closeRoom(room);
  else {
    if (room.timer) clearTimeout(room.timer);
    room.timer=null;room.phase='waiting';room.phaseEndsAt=0;room.liveEndsAt=0;
    io.to(code).emit('roomMessage',{message:'상대 연결이 종료됐습니다. 새 플레이어가 참가할 때까지 대기합니다.'});
  }
}

io.on('connection', socket => {
  socket.data.roomCode=null;
  socket.on('createRoom', payload => {
    const name=safeName(payload?.name), device=payload?.device==='mobile'?'mobile':'pc';
    const requestedRule=['pc','mobile','crossplay'].includes(payload?.rule)?payload.rule:'crossplay';
    if (!compatible(requestedRule,device)) {
      socket.emit('roomError',{message:requestedRule==='pc'?'PC끼리 모드는 PC를 선택해야 합니다.':'모바일끼리 모드는 모바일을 선택해야 합니다.'});return;
    }
    leaveRoom(socket,false);
    const code=code6();
    const p={id:socket.id,name,device,x:0,z:0,yaw:0,pitch:0,hp:100,armor:0,armorTier:'none',money:STARTING_CREDITS,weapon:'pistol',ownedWeapons:['pistol'],score:0,boughtPrimary:false,armorPurchased:false,lastFireAt:0};
    const room={code,rule:requestedRule,players:new Map([[socket.id,p]]),phase:'waiting',round:0,phaseEndsAt:0,liveEndsAt:0,timer:null};
    rooms.set(code,room);socket.data.roomCode=code;socket.join(code);
    socket.emit('roomCreated',{code,rule:requestedRule,device});
  });
  socket.on('joinRoom', payload => {
    const code=String(payload?.code||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
    const room=rooms.get(code);
    if (!room) {socket.emit('roomError',{message:'방을 찾을 수 없습니다. 코드가 정확한지 확인하세요.'});return;}
    if (room.players.size>=2) {socket.emit('roomError',{message:'이미 두 명이 참가한 방입니다.'});return;}
    const device=payload?.device==='mobile'?'mobile':'pc';
    if (!compatible(room.rule,device)) {
      const message=room.rule==='pc'?'이 방은 PC끼리 대전하는 방입니다. PC 기기 선택 후 참가하세요.':room.rule==='mobile'?'이 방은 모바일끼리 대전하는 방입니다. 모바일 기기 선택 후 참가하세요.':'기기 설정을 확인하세요.';
      socket.emit('roomError',{message});return;
    }
    leaveRoom(socket,false);
    const name=safeName(payload?.name);
    const p={id:socket.id,name,device,x:0,z:0,yaw:0,pitch:0,hp:100,armor:0,armorTier:'none',money:STARTING_CREDITS,weapon:'pistol',ownedWeapons:['pistol'],score:0,boughtPrimary:false,armorPurchased:false,lastFireAt:0};
    room.players.set(socket.id,p);socket.data.roomCode=code;socket.join(code);
    socket.emit('roomJoined',{code,rule:room.rule,device});
    socket.to(code).emit('playerJoined',{id:socket.id,player:publicPlayer(p)});
    socket.emit('playersSnapshot',playersSnapshot(room));
    beginRound(room);
  });
  socket.on('move', payload => {
    const room=rooms.get(socket.data.roomCode);const p=playerById(room,socket.id);if(!p||!payload)return;
    const x=Number(payload.x),z=Number(payload.z),yaw=Number(payload.yaw),pitch=Number(payload.pitch);
    if (![x,z,yaw,pitch].every(Number.isFinite))return;
    p.x=Math.max(-31,Math.min(31,x));p.z=Math.max(-31,Math.min(31,z));p.yaw=Math.max(-Math.PI*2,Math.min(Math.PI*2,yaw));p.pitch=Math.max(-1.35,Math.min(1.35,pitch));
    socket.to(room.code).emit('playerMoved',{id:socket.id,x:p.x,y:0,z:p.z,yaw:p.yaw,pitch:p.pitch,name:p.name,hp:p.hp,weapon:p.weapon,device:p.device});
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
    const room=rooms.get(socket.data.roomCode);const shooter=playerById(room,socket.id);
    if(!room||!shooter||room.phase!=='live'||shooter.hp<=0)return;
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
      const [targetId,target]=targetEntry;const center={x:target.x,y:1.13,z:target.z};const vx=center.x-origin.x,vy=center.y-origin.y,vz=center.z-origin.z;
      const distance=Math.hypot(vx,vy,vz);const dot=(vx*direction.x+vy*direction.y+vz*direction.z)/(distance||1);
      // Wide enough to tolerate network jitter, narrow enough to discourage blind map-wide hits.
      const horizontalDistance=Math.hypot(vx,vz);const horizLen=Math.hypot(direction.x,direction.z)||1;const horizontalDot=(vx*direction.x+vz*direction.z)/(horizontalDistance*horizLen||1);
      if(distance<=w.range&&dot>.945&&horizontalDot>.955&&!isShotBlocked(origin,direction,distance)){
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
  });
  socket.on('leaveRoom',()=>leaveRoom(socket,true));
  socket.on('disconnect',()=>leaveRoom(socket,true));
});

httpServer.listen(PORT,'0.0.0.0',()=>{
  console.log(`NEON STRIKE listening on http://localhost:${PORT}`);
  console.log(`Mode: ${isProduction?'production':'development'} | Socket.IO ready`);
});

process.on('SIGINT',()=>{for(const room of rooms.values())if(room.timer)clearTimeout(room.timer);httpServer.close(()=>process.exit(0));});
process.on('SIGTERM',()=>{for(const room of rooms.values())if(room.timer)clearTimeout(room.timer);httpServer.close(()=>process.exit(0));});
