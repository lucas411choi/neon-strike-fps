import * as THREE from 'three';
import { io } from 'socket.io-client';

const $ = (id) => document.getElementById(id);
const canvas = $('game-canvas');
const menu = $('main-menu');
const hud = $('hud');
const buyMenu = $('buy-menu');
const pauseMenu = $('pause-menu');
const endScreen = $('end-screen');
const touchControls = $('touch-controls');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const WEAPONS = [
  { id:'pistol', name:'ATLAS PISTOL', short:'ATLAS', type:'SIDEARM', price:0, damage:26, head:1.65, rate:0.28, mag:12, reserve:48, reload:1.15, spread:0.006, range:55, control:8, color:0xb8c8d9, desc:'안정적인 기본 권총' },
  { id:'smg', name:'VIPER SMG', short:'VIPER', type:'SMG', price:1100, damage:17, head:1.45, rate:0.085, mag:30, reserve:120, reload:1.45, spread:0.023, range:25, control:5, color:0x55e6d2, desc:'근거리 고연사 · 낮은 피해' },
  { id:'shotgun', name:'BREACH SG', short:'BREACH', type:'SHOTGUN', price:1850, damage:10, pellets:7, head:1.2, rate:0.78, mag:7, reserve:28, reload:1.7, spread:0.075, range:13, control:3, color:0xd9a36a, desc:'7발 산탄 · 근거리 제압' },
  { id:'rifle', name:'VANTAGE AR', short:'VANTAGE', type:'ASSAULT RIFLE', price:2900, damage:32, head:1.6, rate:0.12, mag:30, reserve:90, reload:1.55, spread:0.012, range:50, control:7, color:0x8aafff, desc:'중거리까지 균형 잡힌 소총' },
  { id:'dmr', name:'RAIL DMR', short:'RAIL', type:'MARKSMAN', price:2500, damage:44, head:1.75, rate:0.42, mag:12, reserve:48, reload:1.65, spread:0.003, range:75, control:9, color:0x9ec4d6, desc:'정밀한 단발 · 높은 피해' },
  { id:'sniper', name:'LONGSHOT SR', short:'LONGSHOT', type:'SNIPER', price:4500, damage:78, head:1.9, rate:1.05, mag:5, reserve:20, reload:2.0, spread:0.001, range:100, control:10, color:0xdfb5ff, desc:'장거리 고위력 · 느린 연사' },
  { id:'lmg', name:'TITAN LMG', short:'TITAN', type:'LMG', price:3600, damage:22, head:1.5, rate:0.105, mag:60, reserve:180, reload:2.4, spread:0.022, range:42, control:4, color:0xe6c36e, desc:'대용량 탄창 · 긴 재장전' },
  { id:'burst', name:'ION BURST', short:'ION', type:'BURST RIFLE', price:2400, damage:23, head:1.65, rate:0.32, mag:24, reserve:96, reload:1.5, spread:0.009, range:45, control:8, color:0x85e5ff, desc:'3점사 · 정교한 중거리 교전' },
];
const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map(w => [w.id, w]));
const platformName = { pc:'PC', mobile:'MOBILE' };

const state = {
  device: matchMedia('(pointer:coarse)').matches ? 'mobile' : 'pc',
  rule:'crossplay', difficulty:'normal', name:'PLAYER', mode:'menu', phase:'menu',
  round:0, selfScore:0, enemyScore:0, money:800, hp:100, armor:0,
  currentWeapon:'pistol', owned:new Set(['pistol']), ammo:{},
  pos:new THREE.Vector3(0,0,15), velocityY:0, yaw:0, pitch:0,
  keys:new Set(), touchMove:{x:0,y:0}, canJump:true,
  lastShot:0, reloading:false, reloadUntil:0, lastFrame:performance.now(), fpsFrames:0, fpsStamp:0,
  phaseEnd:0, roundLimit:0, botList:[], remotePlayers:new Map(), shotFx:[], muzzleUntil:0,
  roomCode:'', socket:null, socketReady:false, paused:false, resultShown:false,
  buyPrimaryThisRound:false, armorPurchased:false, matchOver:false, botFireTimers:[],
  pointerLocked:false, mobileLook:null, audio:null, noiseBuffer:null, currentToastTimer:0,
};
for (const weapon of WEAPONS) state.ammo[weapon.id] = { mag: weapon.mag, reserve: weapon.reserve };

// Three.js renderer and compact, procedural arena.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x08101b);
scene.fog = new THREE.FogExp2(0x08101b, 0.0125);
const camera = new THREE.PerspectiveCamera(76, window.innerWidth / window.innerHeight, 0.08, 150);
camera.rotation.order = 'YXZ';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !matchMedia('(pointer:coarse)').matches, powerPreference:'high-performance', alpha:false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;

scene.add(new THREE.HemisphereLight(0x9fc9e8, 0x18202d, 1.6));
const keyLight = new THREE.DirectionalLight(0xc7e6ff, 2.0);
keyLight.position.set(-9, 18, 8);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.left = -35; keyLight.shadow.camera.right = 35; keyLight.shadow.camera.top = 35; keyLight.shadow.camera.bottom = -35;
scene.add(keyLight);
const cyanLight = new THREE.PointLight(0x1cebd4, 21, 30); cyanLight.position.set(-12,4,-9); scene.add(cyanLight);
const redLight = new THREE.PointLight(0xff315b, 18, 28); redLight.position.set(14,4,10); scene.add(redLight);

const materials = {
  floor:new THREE.MeshStandardMaterial({ color:0x111a25, roughness:0.82, metalness:0.22 }),
  wall:new THREE.MeshStandardMaterial({ color:0x202e3d, roughness:0.65, metalness:0.38 }),
  wallDark:new THREE.MeshStandardMaterial({ color:0x101a27, roughness:0.7, metalness:0.25 }),
  cyan:new THREE.MeshStandardMaterial({ color:0x4cf4d5, emissive:0x167e75, emissiveIntensity:1.7, metalness:0.35, roughness:0.3 }),
  red:new THREE.MeshStandardMaterial({ color:0xff607b, emissive:0x771d34, emissiveIntensity:1.5, metalness:0.3, roughness:0.35 }),
  white:new THREE.MeshStandardMaterial({ color:0xc5d9ec, metalness:0.7, roughness:0.35 }),
};
const colliders = [];
const obstacleMeshes = [];
function addBox(x,y,z,w,h,d,mat,{collision=true,accent=null,rotation=0}={}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat);
  mesh.position.set(x,y+h/2,z); mesh.rotation.y=rotation; mesh.castShadow=true; mesh.receiveShadow=true; scene.add(mesh);
  if (collision) { colliders.push({x,z,w,d,h}); obstacleMeshes.push(mesh); }
  if (accent) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(w*0.86,0.035,0.04), accent);
    line.position.set(x,y+h*.82,z-d*.501); scene.add(line);
  }
  return mesh;
}
const floor = new THREE.Mesh(new THREE.PlaneGeometry(72,72), materials.floor); floor.rotation.x=-Math.PI/2; floor.position.y=-0.05; floor.receiveShadow=true; scene.add(floor);
const grid = new THREE.GridHelper(72, 72, 0x2a666d, 0x213341); grid.position.y=-0.035; grid.material.transparent=true; grid.material.opacity=0.42; scene.add(grid);
// Outer walls, cover boxes, lanes, and illuminated strips.
addBox(0,0,-34,70,5,1.4,materials.wallDark,{accent:materials.cyan});
addBox(0,0,34,70,5,1.4,materials.wallDark,{accent:materials.red});
addBox(-34,0,0,1.4,5,70,materials.wallDark);
addBox(34,0,0,1.4,5,70,materials.wallDark);
[
  [-15,0,-12,7,2.6,3,materials.wall],[-3,0,-14,4,1.5,4,materials.wallDark],[10,0,-12,7,2.8,3,materials.wall],
  [-19,0,0,3,2.2,8,materials.wallDark],[-8,0,-1,5,1.4,3,materials.wall],[6,0,2,4,2.4,5,materials.wallDark],[19,0,0,3,2.2,8,materials.wall],
  [-13,0,15,8,2.6,3,materials.wall],[0,0,13,5,1.5,4,materials.wallDark],[13,0,15,8,2.6,3,materials.wall],
  [-2,0,0,2,3.6,2,materials.wall],[-24,0,-20,4,1.2,4,materials.wall],[24,0,20,4,1.2,4,materials.wall],
].forEach(([x,y,z,w,h,d,mat])=>addBox(x,y,z,w,h,d,mat,{accent:mat===materials.wall?materials.cyan:null}));
for (let i=-3;i<=3;i++) {
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(.045,.02,58), i%2===0?materials.cyan:materials.red);
  stripe.position.set(i*8,.005,0); stripe.material= stripe.material.clone(); stripe.material.transparent=true; stripe.material.opacity=.18; scene.add(stripe);
}
function addGlowPillar(x,z,color) {
  addBox(x,0,z,.7,4,.7,materials.wallDark,{collision:true});
  const strip = new THREE.Mesh(new THREE.BoxGeometry(.72,2.7,.73),color); strip.position.set(x,2,z); scene.add(strip);
  const light=new THREE.PointLight(color.color,2.2,8);light.position.set(x,3,z);scene.add(light);
}
addGlowPillar(-28,-27,materials.cyan); addGlowPillar(28,27,materials.red); addGlowPillar(-28,27,materials.cyan); addGlowPillar(28,-27,materials.red);

const gunRoot = new THREE.Group(); camera.add(gunRoot); scene.add(camera);
let muzzleMesh = null;
function buildGun(id) {
  gunRoot.clear();
  const w=WEAPON_BY_ID[id]||WEAPONS[0];
  const mainMat=new THREE.MeshStandardMaterial({color:w.color,metalness:.7,roughness:.32});
  const darkMat=new THREE.MeshStandardMaterial({color:0x101925,metalness:.55,roughness:.42});
  const accentMat=new THREE.MeshStandardMaterial({color:0x4cf4d5,emissive:0x167e75,emissiveIntensity:1.1,metalness:.4,roughness:.35});
  const box=(x,y,z,sx,sy,sz,mat)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),mat);m.position.set(x,y,z);gunRoot.add(m);return m;};
  const cylinder=(x,y,z,r1,r2,len,mat,axis='z')=>{const m=new THREE.Mesh(new THREE.CylinderGeometry(r1,r2,len,10),mat);m.position.set(x,y,z);if(axis==='z')m.rotation.x=Math.PI/2;else m.rotation.z=Math.PI/2;gunRoot.add(m);return m;};
  // Silhouette is deliberately different by weapon family.
  box(.32,-.27,-.60,.20,.17,.56,darkMat);
  if(id==='pistol'){
    box(.32,-.22,-.47,.17,.13,.30,mainMat);box(.34,-.34,-.52,.13,.19,.12,darkMat);cylinder(.32,-.23,-.76,.035,.035,.28,mainMat);box(.32,-.17,-.54,.08,.035,.09,accentMat);
  } else if(id==='smg'){
    box(.32,-.24,-.54,.22,.17,.38,mainMat);box(.32,-.37,-.50,.13,.24,.13,darkMat);cylinder(.32,-.24,-.81,.035,.035,.3,darkMat);box(.23,-.20,-.58,.04,.25,.13,accentMat);box(.32,-.15,-.51,.05,.07,.12,darkMat);
  } else if(id==='shotgun'){
    box(.32,-.22,-.55,.24,.18,.42,mainMat);box(.32,-.34,-.47,.14,.22,.16,darkMat);cylinder(.32,-.23,-.86,.047,.047,.43,mainMat);cylinder(.39,-.31,-.67,.025,.025,.28,darkMat);box(.25,-.16,-.56,.08,.07,.12,accentMat);
  } else if(id==='rifle'){
    box(.32,-.22,-.55,.21,.17,.49,mainMat);box(.32,-.34,-.48,.12,.24,.18,darkMat);cylinder(.32,-.22,-.88,.031,.031,.40,mainMat);box(.32,-.12,-.56,.12,.06,.12,darkMat);box(.24,-.23,-.62,.06,.22,.12,accentMat);box(.33,-.29,-.62,.1,.12,.18,darkMat);
  } else if(id==='dmr'){
    box(.32,-.22,-.53,.19,.15,.38,mainMat);box(.32,-.34,-.46,.12,.22,.16,darkMat);cylinder(.32,-.22,-.95,.026,.026,.52,mainMat);box(.32,-.14,-.61,.12,.09,.2,darkMat);cylinder(.32,-.12,-.60,.035,.035,.16,accentMat,'x');box(.24,-.22,-.62,.04,.2,.12,accentMat);
  } else if(id==='sniper'){
    box(.32,-.22,-.51,.2,.14,.38,mainMat);box(.32,-.33,-.45,.12,.23,.17,darkMat);cylinder(.32,-.22,-1.00,.027,.027,.65,mainMat);box(.32,-.11,-.56,.09,.08,.28,darkMat);cylinder(.32,-.07,-.56,.045,.045,.18,accentMat,'x');box(.32,-.24,-.82,.08,.07,.16,darkMat);
  } else if(id==='lmg'){
    box(.32,-.23,-.55,.27,.2,.48,mainMat);box(.32,-.38,-.55,.15,.24,.23,darkMat);cylinder(.32,-.22,-.91,.036,.036,.48,mainMat);box(.32,-.34,-.70,.12,.18,.2,accentMat);box(.23,-.18,-.57,.05,.23,.15,darkMat);box(.32,-.11,-.53,.09,.07,.2,darkMat);
  } else {
    box(.32,-.22,-.56,.23,.16,.45,mainMat);box(.32,-.34,-.47,.13,.22,.16,darkMat);cylinder(.32,-.22,-.88,.032,.032,.38,mainMat);box(.32,-.13,-.55,.09,.08,.15,accentMat);box(.26,-.20,-.64,.05,.18,.16,darkMat);box(.38,-.20,-.64,.05,.18,.16,darkMat);
  }
  box(.32,-.30,-.67,.13,.10,.12,darkMat);
  // Small ejection port and team-status strip.
  box(.205,-.20,-.58,.012,.035,.11,accentMat);
  muzzleMesh=new THREE.Mesh(new THREE.SphereGeometry(.075,8,8),new THREE.MeshBasicMaterial({color:0xffe9a5,transparent:true,opacity:.95}));
  muzzleMesh.position.set(.32,-.23,-1.12);muzzleMesh.visible=false;gunRoot.add(muzzleMesh);
  gunRoot.position.set(0,0,0);
}

function makeCharacter({color=0x67c9ff, accent=0x143345, onlineId=null, name='BOT'}={}) {
  const root=new THREE.Group();
  const bodyMat=new THREE.MeshStandardMaterial({color,metalness:.35,roughness:.47});
  const accentMat=new THREE.MeshStandardMaterial({color:accent,metalness:.48,roughness:.38});
  const dark=new THREE.MeshStandardMaterial({color:0x111925,metalness:.35,roughness:.65});
  const headMat=new THREE.MeshStandardMaterial({color:0xb9c9d5,metalness:.15,roughness:.55});
  function part(geo,mat,x,y,z,partName){const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;m.userData.part=partName||'body';root.add(m);return m;}
  part(new THREE.BoxGeometry(.72,.82,.36),bodyMat,0,1.05,0,'body');
  part(new THREE.BoxGeometry(.78,.16,.4),accentMat,0,1.38,0,'body');
  const head=part(new THREE.SphereGeometry(.225,12,10),headMat,0,1.67,0,'head');head.scale.set(.86,1.02,.86);
  part(new THREE.BoxGeometry(.34,.11,.28),dark,0,1.63,-.10,'head');
  const visor=part(new THREE.BoxGeometry(.28,.055,.035),new THREE.MeshStandardMaterial({color:onlineId?0x6ee9ff:0xff5f7c,emissive:onlineId?0x16717f:0x7c1029,emissiveIntensity:1.5}),0,1.68,-.204,'head');
  part(new THREE.BoxGeometry(.24,.18,.27),accentMat,-.49,1.19,0,'body');part(new THREE.BoxGeometry(.24,.18,.27),accentMat,.49,1.19,0,'body');
  const arm1=part(new THREE.BoxGeometry(.18,.52,.19),bodyMat,-.47,.88,-.04,'body');arm1.rotation.z=-.13;
  const arm2=part(new THREE.BoxGeometry(.18,.52,.19),bodyMat,.47,.88,-.04,'body');arm2.rotation.z=.13;
  const leg1=part(new THREE.BoxGeometry(.25,.55,.28),dark,-.19,.35,0,'body');
  const leg2=part(new THREE.BoxGeometry(.25,.55,.28),dark,.19,.35,0,'body');
  const pack=part(new THREE.BoxGeometry(.37,.45,.17),accentMat,0,1.1,.23,'body');
  root.userData={onlineId,name,parts:[head,visor],legs:[leg1,leg2],arms:[arm1,arm2],bodyMat,accentMat};
  return root;
}
function setTargetId(group,id) { group.traverse(o=>{if(o.isMesh)o.userData.targetId=id;}); }
function disposeGroup(group) { group.traverse(o=>{if(o.geometry)o.geometry.dispose();}); scene.remove(group); }

const raycaster = new THREE.Raycaster();
const targetObjects = [];
function registerTarget(group,id) { setTargetId(group,id); group.traverse(o=>{if(o.isMesh)targetObjects.push(o);}); }
function unregisterTarget(id) { for(let i=targetObjects.length-1;i>=0;i--)if(targetObjects[i].userData.targetId===id)targetObjects.splice(i,1); }
function updateRemotePlayer(id,data) {
  if(id===state.socket?.id)return;
  let remote=state.remotePlayers.get(id);
  if(!remote){
    const root=makeCharacter({color:0xff6c85,accent:0x52233a,onlineId:id,name:data.name||'OPPONENT'});root.position.set(data.x||0,0,data.z||0);scene.add(root);registerTarget(root,id);
    remote={id,root,target:new THREE.Vector3(data.x||0,0,data.z||0),yaw:data.yaw||0,name:data.name||'OPPONENT',hp:data.hp??100};state.remotePlayers.set(id,remote);
  }
  remote.target.set(data.x||0,0,data.z||0);remote.yaw=data.yaw||0;remote.name=data.name||remote.name;if(data.hp!=null)remote.hp=data.hp;
}
function clearRemotePlayers(){ for(const [id,r] of state.remotePlayers){unregisterTarget(id);disposeGroup(r.root);}state.remotePlayers.clear(); }

// Procedural sound effects; no copyrighted samples or external audio downloads.
function initAudio(){
  if(state.audio){if(state.audio.state==='suspended')state.audio.resume();return;}
  const Ctx=window.AudioContext||window.webkitAudioContext;if(!Ctx)return;
  state.audio=new Ctx();
  const length=Math.floor(state.audio.sampleRate*.25);state.noiseBuffer=state.audio.createBuffer(1,length,state.audio.sampleRate);
  const ch=state.noiseBuffer.getChannelData(0);for(let i=0;i<length;i++)ch[i]=Math.random()*2-1;
}
function soundShot(weaponId){
  initAudio();const ctx=state.audio;if(!ctx)return;const t=ctx.currentTime;const w=WEAPON_BY_ID[weaponId]||WEAPONS[0];
  const osc=ctx.createOscillator(),gain=ctx.createGain(),filter=ctx.createBiquadFilter();
  osc.type=weaponId==='sniper'?'sawtooth':weaponId==='pistol'?'triangle':'square';osc.frequency.setValueAtTime(weaponId==='shotgun'?105:weaponId==='sniper'?75:150+Math.random()*55,t);osc.frequency.exponentialRampToValueAtTime(38,t+.095);
  filter.type='lowpass';filter.frequency.value=weaponId==='sniper'?950:weaponId==='shotgun'?1700:2400;
  gain.gain.setValueAtTime(.0001,t);gain.gain.exponentialRampToValueAtTime(weaponId==='sniper'?.62:weaponId==='shotgun'?.38:.24,t+.005);gain.gain.exponentialRampToValueAtTime(.0001,t+(weaponId==='sniper'?.28:.13));
  osc.connect(filter).connect(gain).connect(ctx.destination);osc.start(t);osc.stop(t+.3);
  const noise=ctx.createBufferSource(),ng=ctx.createGain(),nf=ctx.createBiquadFilter();noise.buffer=state.noiseBuffer;nf.type='bandpass';nf.frequency.value=weaponId==='shotgun'?750:1800;
  ng.gain.setValueAtTime(.0001,t);ng.gain.exponentialRampToValueAtTime(weaponId==='sniper'?.33:.17,t+.003);ng.gain.exponentialRampToValueAtTime(.0001,t+.09);noise.connect(nf).connect(ng).connect(ctx.destination);noise.start(t);noise.stop(t+.1);
}
function soundReload(){initAudio();if(!state.audio)return;const ctx=state.audio,t=ctx.currentTime;[420,250,510].forEach((f,i)=>{const o=ctx.createOscillator(),g=ctx.createGain();o.type='square';o.frequency.value=f;g.gain.setValueAtTime(.0001,t+i*.14);g.gain.exponentialRampToValueAtTime(.055,t+i*.14+.008);g.gain.exponentialRampToValueAtTime(.0001,t+i*.14+.055);o.connect(g).connect(ctx.destination);o.start(t+i*.14);o.stop(t+i*.14+.06);});}
function soundHit(){initAudio();if(!state.audio)return;const c=state.audio,t=c.currentTime;const o=c.createOscillator(),g=c.createGain();o.type='sine';o.frequency.setValueAtTime(850,t);o.frequency.exponentialRampToValueAtTime(1350,t+.04);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.12,t+.006);g.gain.exponentialRampToValueAtTime(.0001,t+.09);o.connect(g).connect(c.destination);o.start(t);o.stop(t+.1);}
function soundKill(){initAudio();if(!state.audio)return;const c=state.audio,t=c.currentTime;[660,990,1320].forEach((f,i)=>{const o=c.createOscillator(),g=c.createGain();o.type='sine';o.frequency.setValueAtTime(f,t+i*.055);o.frequency.exponentialRampToValueAtTime(f*1.25,t+i*.055+.05);g.gain.setValueAtTime(.0001,t+i*.055);g.gain.exponentialRampToValueAtTime(.11,t+i*.055+.008);g.gain.exponentialRampToValueAtTime(.0001,t+i*.055+.17);o.connect(g).connect(c.destination);o.start(t+i*.055);o.stop(t+i*.055+.18);});}
function soundBuy(){initAudio();if(!state.audio)return;const c=state.audio,t=c.currentTime,o=c.createOscillator(),g=c.createGain();o.type='triangle';o.frequency.setValueAtTime(420,t);o.frequency.exponentialRampToValueAtTime(760,t+.07);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.09,t+.008);g.gain.exponentialRampToValueAtTime(.0001,t+.14);o.connect(g).connect(c.destination);o.start(t);o.stop(t+.15);}

function showToast(message,ms=2300){const t=$('toast');t.textContent=message;t.classList.remove('hidden');clearTimeout(state.currentToastTimer);state.currentToastTimer=setTimeout(()=>t.classList.add('hidden'),ms);}
function setMenuStatus(text){$('menu-status').textContent=text;}
function setModeUI(){menu.classList.add('hidden');hud.classList.remove('hidden');buyMenu.classList.add('hidden');pauseMenu.classList.add('hidden');endScreen.classList.add('hidden');state.paused=false;}
function backToMenu(){
  state.mode='menu';state.phase='menu';state.paused=false;state.keys.clear();state.roomCode='';
  if(document.pointerLockElement)document.exitPointerLock();
  if(state.socket){state.socket.emit('leaveRoom');state.socket.disconnect();state.socket=null;state.socketReady=false;}
  clearRemotePlayers();clearBots();menu.classList.remove('hidden');hud.classList.add('hidden');buyMenu.classList.add('hidden');pauseMenu.classList.add('hidden');endScreen.classList.add('hidden');touchControls.classList.add('hidden');
  $('room-code').value='';setMenuStatus('AI 라운드전에서 돈을 모으고 다음 라운드 무기를 구매하세요.');
}
function setDevice(device){state.device=device;document.querySelectorAll('[data-device]').forEach(b=>b.classList.toggle('selected',b.dataset.device===device));touchControls.classList.toggle('hidden',device!=='mobile');renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,device==='mobile'?1.25:1.75));renderer.setSize(window.innerWidth,window.innerHeight);}
function setRule(rule){state.rule=rule;document.querySelectorAll('[data-rule]').forEach(b=>b.classList.toggle('selected',b.dataset.rule===rule));}
function setDifficulty(d){state.difficulty=d;document.querySelectorAll('[data-difficulty]').forEach(b=>b.classList.toggle('selected',b.dataset.difficulty===d));}
function hideAllModals(){buyMenu.classList.add('hidden');pauseMenu.classList.add('hidden');endScreen.classList.add('hidden');}

function makeAmmoFor(id,full=true){const w=WEAPON_BY_ID[id];if(!state.ammo[id])state.ammo[id]={mag:w.mag,reserve:w.reserve};if(full){state.ammo[id].mag=w.mag;state.ammo[id].reserve=w.reserve;}}
function currentWeapon(){return WEAPON_BY_ID[state.currentWeapon]||WEAPONS[0];}
function setWeapon(id,notify=false){
  if(!WEAPON_BY_ID[id])return;
  if(!state.owned.has(id)){if(notify)showToast('구매한 무기만 장착할 수 있어요. B를 눌러 구매하세요.');return;}
  state.currentWeapon=id;buildGun(id);updateHUD();if(notify)showToast(`${WEAPON_BY_ID[id].name} 장착`);
}
function updateHUD(){
  $('health-value').textContent=Math.max(0,Math.ceil(state.hp));$('health-fill').style.width=`${Math.max(0,state.hp)}%`;$('armor-value').textContent=Math.max(0,Math.ceil(state.armor));
  $('money-value').textContent=state.money.toLocaleString('en-US');$('buy-money').textContent=state.money.toLocaleString('en-US');
  const w=currentWeapon(),a=state.ammo[w.id]||{mag:w.mag,reserve:w.reserve};
  $('weapon-class').textContent=w.type;$('weapon-name').textContent=w.name;$('weapon-index').textContent=`${WEAPONS.findIndex(x=>x.id===w.id)+1} / ${WEAPONS.length}`;
  $('weapon-stat').textContent=`CONTROL / ${w.control.toFixed(1)}`;$('ammo-current').textContent=a.mag;$('ammo-reserve').textContent=a.reserve;
  const bars=$('weapon-stat-bars');bars.querySelectorAll('i').forEach((i,index)=>i.classList.toggle('on',index<Math.max(1,Math.round(w.control/2))));
  $('self-score').textContent=state.selfScore;$('enemy-score').textContent=state.enemyScore;$('round-label').textContent=`ROUND ${String(Math.max(1,state.round)).padStart(2,'0')}`;
  $('net-label').textContent=state.mode==='online'?(state.socketReady?'ONLINE / ROOM '+state.roomCode:'CONNECTING...'):'LOCAL AI MATCH';$('net-dot').classList.toggle('offline',state.mode==='online'&&!state.socketReady);
  $('objective-label').textContent=state.mode==='online'?'ELIMINATE OPPONENT':'ELIMINATE HOSTILES';
  renderBuyList();
}

function renderBuyList(){
  const list=$('buy-list');if(!list)return;list.innerHTML='';
  for(const w of WEAPONS){
    const owned=state.owned.has(w.id),canBuy=w.price===0||state.money>=w.price;
    const card=document.createElement('button');card.className='weapon-card'+(state.currentWeapon===w.id?' equipped':'')+(!canBuy?' cant-afford':'');card.style.setProperty('--gun-color',`#${w.color.toString(16).padStart(6,'0')}`);
    card.innerHTML=`<div class="weapon-art"><div class="weapon-silhouette"></div></div><span class="gun-type">${w.type}</span><strong>${w.name}</strong><div class="gun-price">${w.price===0?'FREE':`◈ ${w.price.toLocaleString('en-US')}`}</div><div class="gun-desc">${w.desc}</div><div class="buy-action">${state.currentWeapon===w.id?'장착 중':owned?'재장착':'구매 / 장착'}</div>`;
    card.disabled=state.phase!=='buy'||state.mode==='online'&&(!state.socketReady||state.buyPrimaryThisRound)||(!owned&&w.price>state.money);
    card.addEventListener('click',()=>buyWeapon(w.id));list.append(card);
  }
  const armor=document.createElement('button');armor.className='weapon-card'+(state.armor>=50?' equipped':'')+(state.money<400||state.armorPurchased?' cant-afford':'');
  armor.innerHTML=`<div class="weapon-art"><div style="font-size:31px;color:#73bdff;text-shadow:0 0 15px #73bdff80">⬡</div></div><span class="gun-type">DEFENSE / GEAR</span><strong>LIGHT ARMOR</strong><div class="gun-price">◈ 400</div><div class="gun-desc">피해 일부를 흡수하는 보호구</div><div class="buy-action">${state.armor>=50?'보유 중':'구매 / 장착'}</div>`;
  armor.disabled=state.phase!=='buy'||state.money<400||state.armorPurchased||state.armor>=50;
  armor.addEventListener('click',buyArmor);list.append(armor);
}

function buyWeapon(id){
  if(state.phase!=='buy'){showToast('총기는 구매 단계에서만 살 수 있어요.');return;}
  const w=WEAPON_BY_ID[id];if(!w)return;
  if(state.currentWeapon===id){showToast('이미 장착한 무기입니다.');return;}
  if(state.mode==='online'){
    if(!state.socketReady){showToast('서버에 연결 중입니다.');return;}
    state.socket.emit('buy',{kind:'weapon',weaponId:id});return;
  }
  if(id!=='pistol'&&state.buyPrimaryThisRound){showToast('이번 구매 단계에는 주무기 하나만 살 수 있어요.');return;}
  if(state.money<w.price){showToast(`크레딧이 부족합니다. ${w.price.toLocaleString()} CR 필요`);return;}
  if(id!=='pistol'){state.money-=w.price;state.buyPrimaryThisRound=true;state.owned=new Set(['pistol',id]);}
  else state.owned.add(id);
  makeAmmoFor(id,true);setWeapon(id);soundBuy();$('buy-feedback').textContent=`${w.name} 구매 완료`;updateHUD();
}
function buyArmor(){
  if(state.phase!=='buy')return;
  if(state.mode==='online'){state.socket.emit('buy',{kind:'armor'});return;}
  if(state.armorPurchased||state.armor>=50){showToast('방어구를 이미 보유하고 있습니다.');return;}
  if(state.money<400){showToast('크레딧이 부족합니다.');return;}
  state.money-=400;state.armor=50;state.armorPurchased=true;soundBuy();$('buy-feedback').textContent='경량 방어구 장착 완료';updateHUD();
}
function openBuy(){if(state.phase!=='buy'||state.paused)return;buyMenu.classList.remove('hidden');updateHUD();}
function closeBuy(){buyMenu.classList.add('hidden');}
function startLocalRound(){
  state.round++;state.phase='buy';state.hp=100;state.armor=0;state.velocityY=0;state.pos.set(0,0,19);state.yaw=0;state.pitch=0;state.phaseEnd=Date.now()+12000;state.roundLimit=Date.now()+102000;
  state.buyPrimaryThisRound=false;state.armorPurchased=false;state.reloading=false;state.resultShown=false;state.matchOver=false;
  makeAmmoFor(state.currentWeapon,true);state.botFireTimers=[];clearBots();setModeUI();$('phase-label').textContent='BUY PHASE';$('buy-countdown').textContent='12초';$('buy-feedback').textContent='라운드 시작 전 장비를 구매하세요.';
  updateHUD();openBuy();showToast(`ROUND ${state.round} — 구매 단계`,1800);
}
function startAIMatch(){
  initAudio();if(state.socket){state.socket.disconnect();state.socket=null;state.socketReady=false;}clearRemotePlayers();
  state.mode='ai';state.name=($('player-name').value.trim()||'PLAYER').slice(0,16);state.money=800;state.hp=100;state.armor=0;state.selfScore=0;state.enemyScore=0;state.round=0;state.currentWeapon='pistol';state.owned=new Set(['pistol']);state.ammo={};for(const w of WEAPONS)state.ammo[w.id]={mag:w.mag,reserve:w.reserve};buildGun('pistol');state.pos.set(0,0,19);state.yaw=0;state.pitch=0;state.buyPrimaryThisRound=false;state.matchOver=false;
  startLocalRound();
}
function spawnBots(){
  clearBots();const count=3;
  for(let i=0;i<count;i++){
    const angle=(i/count)*Math.PI*2+Math.PI/5;const dist=19+(i%2)*4;const x=Math.cos(angle)*dist,z=Math.sin(angle)*dist;
    const root=makeCharacter({color:[0xff607b,0xf58e66,0xd16aff][i],accent:0x391d33,name:`BOT-${i+1}`});root.position.set(x,0,z);scene.add(root);
    const id=`bot-${i}`;registerTarget(root,id);
    state.botList.push({id,root,hp:100,alive:true,fireAt:Date.now()+1000+Math.random()*1000,movePhase:Math.random()*8,name:`BOT-${i+1}`,weapon:['smg','rifle','dmr'][i]});
  }
}
function clearBots(){for(const b of state.botList){unregisterTarget(b.id);disposeGroup(b.root);}state.botList=[];}
function beginLocalLive(){
  if(state.phase!=='buy')return;
  state.phase='live';state.phaseEnd=Date.now()+90000;buyMenu.classList.add('hidden');$('phase-label').textContent='LIVE';$('objective-label').textContent='ELIMINATE HOSTILES';spawnBots();showToast('라운드 시작! 적 3명을 모두 처치하세요.',1800);updateHUD();
}
function endLocalRound(win,reason=''){
  if(state.mode!=='ai'||state.phase==='ended'||state.phase==='matchover')return;
  state.phase='ended';state.resultShown=true;const reward=win?3000:1900;state.money+=reward;
  if(win)state.selfScore++;else state.enemyScore++;
  state.matchOver=state.selfScore>=5||state.enemyScore>=5;
  $('result-kicker').textContent=state.matchOver?'MATCH RESULT':'ROUND RESULT';
  $('result-title').innerHTML=state.matchOver?(win?'MATCH<br/><span>VICTORY.</span>':'MATCH<br/><span>DEFEAT.</span>'):(win?'ROUND<br/><span>WON.</span>':'ROUND<br/><span>LOST.</span>');
  $('result-copy').textContent=reason|| (win?'적 팀을 전멸시켰습니다.':'다음 라운드에는 장비와 엄폐를 활용하세요.');$('result-reward').textContent=`+${reward.toLocaleString()} CR`;
  $('next-round').textContent=state.matchOver?'다시 도전':'다음 라운드';$('next-round').classList.remove('hidden');endScreen.classList.remove('hidden');buyMenu.classList.add('hidden');soundKill();updateHUD();
}
function nextLocalRound(){
  endScreen.classList.add('hidden');if(state.matchOver){state.selfScore=0;state.enemyScore=0;state.money=800;state.currentWeapon='pistol';state.owned=new Set(['pistol']);for(const w of WEAPONS)state.ammo[w.id]={mag:w.mag,reserve:w.reserve};state.round=0;}
  startLocalRound();
}
function switchWeaponByNumber(n){const w=WEAPONS[n-1];if(w)setWeapon(w.id,true);}
function reloadWeapon(){
  if(state.phase!=='live'||state.reloading)return;const w=currentWeapon(),a=state.ammo[w.id];if(a.mag>=w.mag||a.reserve<=0)return;
  state.reloading=true;state.reloadUntil=performance.now()+w.reload*1000;soundReload();showToast('재장전 중...',700);
}
function applyLocalDamage(damage){let left=damage;if(state.armor>0){const absorbed=Math.min(state.armor,damage*.48);state.armor-=absorbed;left-=absorbed;}state.hp=Math.max(0,state.hp-left);updateHUD();if(state.hp<=0)endLocalRound(false,'플레이어가 쓰러졌습니다.');}
function addShotFx(from,to,color=0x8ffff0){
  const geo=new THREE.BufferGeometry().setFromPoints([from.clone(),to.clone()]);const mat=new THREE.LineBasicMaterial({color,transparent:true,opacity:.85});const line=new THREE.Line(geo,mat);scene.add(line);state.shotFx.push({line,mat,geo,expires:performance.now()+75});
}
function cameraForward(){const d=new THREE.Vector3();camera.getWorldDirection(d);return d.normalize();}
function doShoot(){
  if(state.phase!=='live'||state.paused||state.reloading)return;
  initAudio();const w=currentWeapon(),ammo=state.ammo[w.id],now=performance.now();if(now-state.lastShot<w.rate*1000)return;
  if(ammo.mag<=0){showToast('탄약이 없습니다. R로 재장전하세요.',850);return;}state.lastShot=now;ammo.mag--;soundShot(w.id);if(muzzleMesh){muzzleMesh.visible=true;state.muzzleUntil=now+55;}
  const direction=cameraForward();const origin=camera.position.clone();let bestHit=null;const pellets=w.id==='shotgun'?7:1;let totalDamage=0;let hitPoint=origin.clone().add(direction.clone().multiplyScalar(w.range));let hitOwner=null;
  for(let i=0;i<pellets;i++){
    const d=direction.clone();const spread=w.spread;
    d.x+=(Math.random()-.5)*spread;d.y+=(Math.random()-.5)*spread;d.z+=(Math.random()-.5)*spread;d.normalize();raycaster.set(origin,d);raycaster.far=w.range;
    const hits=raycaster.intersectObjects(targetObjects,false);let h=hits.find(x=>{
      const targetId=x.object.userData.targetId;
      if(!targetId)return false;
      if(String(targetId).startsWith('bot-'))return state.botList.some(b=>b.id===targetId&&b.alive);
      return state.mode==='online'&&state.remotePlayers.has(targetId);
    });
    if(h){const blockers=raycaster.intersectObjects(obstacleMeshes,false);if(blockers.length&&blockers[0].distance<h.distance-.06)h=null;}
    if(h){
      hitPoint=h.point;hitOwner=h.object.userData.targetId;
      if(String(hitOwner).startsWith('bot-')){
        const bot=state.botList.find(b=>b.id===hitOwner);if(bot&&bot.alive){const head=h.object.userData.part==='head';totalDamage+=w.damage*(head?w.head:1);}
      } else if(state.mode==='online'){
        // Online hits are resolved by the room server; the local ray is only for tracer feedback.
        totalDamage=0;
      }
    }
  }
  addShotFx(origin,hitPoint,w.id==='sniper'?0xffdfb5:0x73f8e4);
  if(state.mode==='ai'&&hitOwner&&String(hitOwner).startsWith('bot-')&&totalDamage>0){const bot=state.botList.find(b=>b.id===hitOwner);if(bot&&bot.alive){bot.hp-=totalDamage;soundHit();$('hit-marker').classList.remove('hidden');setTimeout(()=>$('hit-marker').classList.add('hidden'),100);if(bot.hp<=0){bot.hp=0;bot.alive=false;bot.root.visible=false;unregisterTarget(bot.id);state.money+=200;soundKill();$('kill-banner').innerHTML=`${bot.name} ELIMINATED <small>+200 CR</small>`;$('kill-banner').classList.remove('hidden');setTimeout(()=>$('kill-banner').classList.add('hidden'),850);updateHUD();if(state.botList.every(b=>!b.alive))endLocalRound(true,'적 3명을 모두 처치했습니다.');}}}
  if(state.mode==='online'&&state.socketReady){state.socket.emit('fire',{weaponId:w.id,origin:{x:origin.x,y:origin.y,z:origin.z},direction:{x:direction.x,y:direction.y,z:direction.z}});}
  updateHUD();
}
function collideAt(x,z){
  const radius=.48;if(Math.abs(x)>31.8||Math.abs(z)>31.8)return true;
  for(const c of colliders){if(Math.abs(x-c.x)<c.w/2+radius&&Math.abs(z-c.z)<c.d/2+radius)return true;}
  return false;
}
function movePlayer(dt){
  if(state.phase!=='live'||state.paused)return;
  const forward=(state.keys.has('KeyW')?1:0)-(state.keys.has('KeyS')?1:0)-state.touchMove.y;
  const strafe=(state.keys.has('KeyD')?1:0)-(state.keys.has('KeyA')?1:0)+state.touchMove.x;
  const fast=state.keys.has('ShiftLeft')||state.keys.has('ShiftRight');const speed=fast?8.4:5.2;
  let dx=0,dz=0;
  const fx=-Math.sin(state.yaw),fz=-Math.cos(state.yaw);const rx=Math.cos(state.yaw),rz=-Math.sin(state.yaw);
  dx=(fx*forward+rx*strafe);dz=(fz*forward+rz*strafe);const len=Math.hypot(dx,dz);if(len>1){dx/=len;dz/=len;}
  const nx=state.pos.x+dx*speed*dt,nz=state.pos.z+dz*speed*dt;
  if(!collideAt(nx,state.pos.z))state.pos.x=nx;if(!collideAt(state.pos.x,nz))state.pos.z=nz;
  if(state.keys.has('Space')&&state.canJump){state.velocityY=5.5;state.canJump=false;}
  state.velocityY-=14*dt;state.pos.y+=state.velocityY*dt;if(state.pos.y<0){state.pos.y=0;state.velocityY=0;state.canJump=true;}
  if(state.mode==='online'&&state.socketReady){state._moveAcc=(state._moveAcc||0)+dt;if(state._moveAcc>.05){state._moveAcc=0;state.socket.emit('move',{x:state.pos.x,y:0,z:state.pos.z,yaw:state.yaw,pitch:state.pitch,name:state.name});}}
}
function updateAI(dt){
  if(state.mode!=='ai'||state.phase!=='live'||state.paused)return;
  const diff={easy:{speed:1.15,rate:2.1,damage:7,accuracy:.24,range:18},normal:{speed:1.65,rate:1.35,damage:10,accuracy:.43,range:23},hard:{speed:2.05,rate:.88,damage:13,accuracy:.63,range:27}}[state.difficulty]||{speed:1.65,rate:1.35,damage:10,accuracy:.43,range:23};
  const now=Date.now();
  for(const bot of state.botList){if(!bot.alive)continue;const v=new THREE.Vector3(state.pos.x-bot.root.position.x,0,state.pos.z-bot.root.position.z);const dist=v.length();if(dist>.001){v.normalize();bot.root.rotation.y=Math.atan2(-v.x,-v.z);}
    bot.movePhase+=dt;
    if(dist>6){let steer=1;if(Math.abs(bot.root.position.x)<3&&Math.abs(bot.root.position.z)<3)steer=.55;const nx=bot.root.position.x+v.x*diff.speed*dt*steer,nz=bot.root.position.z+v.z*diff.speed*dt*steer;if(!collideAt(nx,bot.root.position.z))bot.root.position.x=nx;if(!collideAt(bot.root.position.x,nz))bot.root.position.z=nz;}
    else{const side=Math.sin(bot.movePhase*1.7)*.6;const nx=bot.root.position.x+v.z*side*dt,nz=bot.root.position.z-v.x*side*dt;if(!collideAt(nx,bot.root.position.z))bot.root.position.x=nx;if(!collideAt(bot.root.position.x,nz))bot.root.position.z=nz;}
    // Slightly delayed, difficulty-tuned hitscan attacks. The game emits a restrained sound cue when bots fire.
    if(dist<diff.range&&now>=bot.fireAt){bot.fireAt=now+diff.rate*1000+(Math.random()-.5)*260;const from=new THREE.Vector3(bot.root.position.x,1.35,bot.root.position.z);const to=new THREE.Vector3(state.pos.x,1.25,state.pos.z);const rayDir=to.clone().sub(from);const rayDist=rayDir.length();rayDir.normalize();raycaster.set(from,rayDir);raycaster.far=rayDist;const cover=raycaster.intersectObjects(obstacleMeshes,false);const clearShot=!cover.length||cover[0].distance>=rayDist-.35;if(clearShot&&Math.random()<diff.accuracy){const falloff=THREE.MathUtils.clamp(1-dist/(diff.range*1.7),.35,1);applyLocalDamage(diff.damage*falloff);if(state.phase!=='live')return;}if(clearShot&&Math.random()<.35)soundBotShot();}
  }
}
function soundBotShot(){initAudio();const c=state.audio;if(!c)return;const t=c.currentTime,o=c.createOscillator(),g=c.createGain();o.type='triangle';o.frequency.setValueAtTime(160,t);o.frequency.exponentialRampToValueAtTime(48,t+.065);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.055,t+.004);g.gain.exponentialRampToValueAtTime(.0001,t+.085);o.connect(g).connect(c.destination);o.start(t);o.stop(t+.09);}

function beginOnline(){
  if((state.rule==='pc'&&state.device!=='pc')||(state.rule==='mobile'&&state.device!=='mobile')){showToast(state.rule==='pc'?'PC끼리 모드는 PC를 선택하세요.':'모바일끼리 모드는 모바일을 선택하세요.');return;}
  initAudio();state.mode='online';state.name=($('player-name').value.trim()||'PLAYER').slice(0,16);state.money=800;state.hp=100;state.armor=0;state.selfScore=0;state.enemyScore=0;state.round=0;state.currentWeapon='pistol';state.owned=new Set(['pistol']);state.ammo={};for(const w of WEAPONS)state.ammo[w.id]={mag:w.mag,reserve:w.reserve};state.pos.set(0,0,18);state.yaw=Math.PI;state.pitch=0;state.buyPrimaryThisRound=false;state.phase='waiting';state.roomCode='';clearBots();clearRemotePlayers();setModeUI();$('phase-label').textContent='CONNECTING';$('objective-label').textContent='WAITING FOR OPPONENT';updateHUD();
  const socket=io({transports:['websocket','polling'],reconnection:true});state.socket=socket;
  socket.on('connect',()=>{state.socketReady=true;updateHUD();});
  socket.on('connect_error',()=>{state.socketReady=false;updateHUD();setMenuStatus('온라인 서버에 연결할 수 없습니다. 서버가 배포되어 있는지 확인하세요.');showToast('온라인 서버 연결 실패. 공개 배포 주소에서 접속했는지 확인하세요.',3200);});
  socket.on('roomCreated',data=>{state.roomCode=data.code;state.phase='waiting';$('phase-label').textContent='WAITING';$('objective-label').textContent='WAITING FOR OPPONENT';showToast(`방 생성 완료 · 코드 ${data.code} · 친구에게 코드 공유`,4000);showRoomWait(data.code);updateHUD();});
  socket.on('roomJoined',data=>{state.roomCode=data.code;showRoomWait(data.code);});
  socket.on('roomError',data=>{showToast(data.message||'방에 참가하지 못했습니다.',3200);state.phase='waiting';});
  socket.on('playerJoined',data=>{updateRemotePlayer(data.id,data.player);hideRoomWait();showToast(`${data.player.name||'상대'} 접속 · 라운드 준비`,2000);});
  socket.on('playerLeft',data=>{const r=state.remotePlayers.get(data.id);if(r){unregisterTarget(data.id);disposeGroup(r.root);state.remotePlayers.delete(data.id);}showToast('상대 플레이어 연결이 종료됐습니다.',3000);state.phase='waiting';$('phase-label').textContent='WAITING';});
  socket.on('playersSnapshot',data=>{for(const [id,p] of Object.entries(data||{}))updateRemotePlayer(id,p);});
  socket.on('playerMoved',data=>updateRemotePlayer(data.id,data));
  socket.on('roundState',data=>{
    hideRoomWait();endScreen.classList.add('hidden');state.phase=data.phase;state.round=data.round;state.phaseEnd=data.endsAt;state.roundLimit=data.roundEndsAt||0;state.selfScore=data.scores?.[socket.id]||0;state.enemyScore=Object.entries(data.scores||{}).filter(([id])=>id!==socket.id).reduce((a,[,v])=>a+v,0);state.money=data.self?.money??state.money;state.hp=data.self?.hp??100;state.armor=data.self?.armor??state.armor;state.currentWeapon=data.self?.weapon||state.currentWeapon;state.buyPrimaryThisRound=!!data.self?.boughtPrimary;state.owned=new Set(['pistol',...(data.self?.weapon&&data.self.weapon!=='pistol'?[data.self.weapon]:[])]);state.pos.set(data.self?.x??0,0,data.self?.z??18);state.yaw=data.self?.yaw??state.yaw;state.pitch=data.self?.pitch??0;state.reloading=false;buildGun(state.currentWeapon);if(data.phase==='buy'){clearRemotePlayers();for(const [id,p]of Object.entries(data.players||{}))if(id!==socket.id)updateRemotePlayer(id,p);$('phase-label').textContent='BUY PHASE';openBuy();}else{$('phase-label').textContent='LIVE';closeBuy();}updateHUD();
  });
  socket.on('selfState',data=>{if(data.money!=null)state.money=data.money;if(data.hp!=null)state.hp=data.hp;if(data.armor!=null)state.armor=data.armor;if(data.weapon){state.currentWeapon=data.weapon;state.owned=new Set(['pistol',data.weapon]);buildGun(data.weapon);}if(data.boughtPrimary!=null)state.buyPrimaryThisRound=data.boughtPrimary;updateHUD();});
  socket.on('roundPhase',data=>{state.phase=data.phase;state.phaseEnd=data.endsAt;if(data.phase==='live')state.roundLimit=data.endsAt;if(data.phase==='live'){$('phase-label').textContent='LIVE';closeBuy();showToast(`ROUND ${data.round} — FIGHT`,1600);}if(data.phase==='buy'){$('phase-label').textContent='BUY PHASE';openBuy();}updateHUD();});
  socket.on('shotFx',data=>{if(data.id===socket.id)return;const from=new THREE.Vector3(data.origin.x,data.origin.y,data.origin.z),to=new THREE.Vector3(data.end.x,data.end.y,data.end.z);addShotFx(from,to,0xff718a);soundShot(data.weaponId);});
  socket.on('damage',data=>{if(data.targetId===socket.id){state.hp=data.hp;if(data.armor!=null)state.armor=data.armor;updateHUD();soundHit();if(data.hp<=0)showToast('쓰러졌습니다. 다음 라운드를 준비하세요.',1800);}if(data.attackerId===socket.id&&data.targetId!==socket.id){$('hit-marker').classList.remove('hidden');setTimeout(()=>$('hit-marker').classList.add('hidden'),110);soundHit();}if(data.killed&&data.attackerId===socket.id){soundKill();$('kill-banner').innerHTML=`TARGET ELIMINATED <small>+200 CR</small>`;$('kill-banner').classList.remove('hidden');setTimeout(()=>$('kill-banner').classList.add('hidden'),900);}});
  socket.on('buyResult',data=>{if(!data.ok){showToast(data.message||'구매할 수 없습니다.');return;}state.money=data.money;state.armor=data.armor??state.armor;if(data.weapon){state.currentWeapon=data.weapon;state.owned=new Set(['pistol',data.weapon]);makeAmmoFor(data.weapon,true);buildGun(data.weapon);}state.buyPrimaryThisRound=!!data.boughtPrimary;state.armorPurchased=!!data.armorPurchased;soundBuy();$('buy-feedback').textContent=data.message||'구매 완료';updateHUD();});
  socket.on('roundResult',data=>{state.phase='ended';state.selfScore=data.scores?.[socket.id]||0;state.enemyScore=Object.entries(data.scores||{}).filter(([id])=>id!==socket.id).reduce((a,[,v])=>a+v,0);state.money=data.selfMoney??state.money;state.matchOver=!!data.matchOver;$('result-kicker').textContent=data.matchOver?'MATCH RESULT':'ROUND RESULT';const won=data.winnerId===socket.id;$('result-title').innerHTML=data.matchOver?(won?'MATCH<br/><span>VICTORY.</span>':'MATCH<br/><span>DEFEAT.</span>'):(won?'ROUND<br/><span>WON.</span>':'ROUND<br/><span>LOST.</span>');$('result-copy').textContent=data.reason|| (won?'라운드 승리!':'상대가 라운드를 가져갔습니다.');$('result-reward').textContent=`+${(data.reward??0).toLocaleString()} CR`;$('next-round').classList.toggle('hidden',!!data.matchOver||state.mode==='online');$('next-round').textContent='상대가 다음 라운드를 준비 중…';endScreen.classList.remove('hidden');updateHUD();});
  socket.on('roomMessage',data=>showToast(data.message));
  socket.emit('createRoom',{name:state.name,device:state.device,rule:state.rule});
  }
function showRoomWait(code){let panel=$('room-wait');if(!panel){panel=document.createElement('div');panel.id='room-wait';panel.className='room-wait';panel.innerHTML='<div class="room-wait-card"><small>PRIVATE MATCH / INVITE</small><h3>친구를 기다리는 중</h3><p>아래 6자리 코드를 친구에게 공유하세요.</p><strong id="wait-code">------</strong><button id="copy-room-code" class="solid-button">방 코드 복사</button><button id="cancel-room-wait" class="outline-button full-button">메인 메뉴로</button></div>';document.body.append(panel);$('copy-room-code').addEventListener('click',()=>navigator.clipboard?.writeText(state.roomCode).then(()=>showToast('방 코드를 복사했습니다.')).catch(()=>showToast(`방 코드: ${state.roomCode}`)));$('cancel-room-wait').addEventListener('click',backToMenu);}
  $('wait-code').textContent=code||'------';panel.classList.remove('hidden');}
function hideRoomWait(){const p=$('room-wait');if(p)p.classList.add('hidden');}
function joinOnline(){const code=$('room-code').value.trim().toUpperCase().replace(/[^A-Z0-9]/g,'');if(code.length!==6){showToast('6자리 방 코드를 입력하세요.');return;}initAudio();state.mode='online';state.name=($('player-name').value.trim()||'PLAYER').slice(0,16);state.rule=state.rule||'crossplay';state.money=800;state.hp=100;state.armor=0;state.selfScore=0;state.enemyScore=0;state.round=0;state.currentWeapon='pistol';state.owned=new Set(['pistol']);state.phase='waiting';state.roomCode='';clearBots();clearRemotePlayers();setModeUI();updateHUD();
  const socket=io({transports:['websocket','polling'],reconnection:true});state.socket=socket;socket.on('connect',()=>{state.socketReady=true;updateHUD();socket.emit('joinRoom',{code,name:state.name,device:state.device});});socket.on('connect_error',()=>{state.socketReady=false;showToast('온라인 서버 연결 실패. 배포된 게임 주소인지 확인하세요.',3200);});
  // Reuse identical room listeners by registering a lightweight join-mode bridge.
  socket.on('roomError',d=>showToast(d.message||'방 입장 실패',3200));socket.on('roomJoined',d=>{state.roomCode=d.code;showRoomWait(d.code);});
  socket.on('playerJoined',d=>{updateRemotePlayer(d.id,d.player);hideRoomWait();});socket.on('playerLeft',d=>{const r=state.remotePlayers.get(d.id);if(r){unregisterTarget(d.id);disposeGroup(r.root);state.remotePlayers.delete(d.id);}state.phase='waiting';});socket.on('playerMoved',d=>updateRemotePlayer(d.id,d));socket.on('playersSnapshot',d=>{for(const[id,p]of Object.entries(d||{}))if(id!==socket.id)updateRemotePlayer(id,p);});
  socket.on('roundState',d=>{hideRoomWait();endScreen.classList.add('hidden');state.phase=d.phase;state.round=d.round;state.phaseEnd=d.endsAt;state.roundLimit=d.roundEndsAt||0;state.selfScore=d.scores?.[socket.id]||0;state.enemyScore=Object.entries(d.scores||{}).filter(([id])=>id!==socket.id).reduce((a,[,v])=>a+v,0);state.money=d.self?.money??800;state.hp=d.self?.hp??100;state.armor=d.self?.armor??0;state.currentWeapon=d.self?.weapon||'pistol';state.owned=new Set(['pistol',...(state.currentWeapon!=='pistol'?[state.currentWeapon]:[])]);state.buyPrimaryThisRound=!!d.self?.boughtPrimary;buildGun(state.currentWeapon);if(d.phase==='buy')openBuy();else closeBuy();$('phase-label').textContent=d.phase==='buy'?'BUY PHASE':'LIVE';updateHUD();});
  socket.on('roundPhase',d=>{state.phase=d.phase;state.phaseEnd=d.endsAt;if(d.phase==='live')state.roundLimit=d.endsAt;$('phase-label').textContent=d.phase==='buy'?'BUY PHASE':'LIVE';if(d.phase==='buy')openBuy();else closeBuy();});socket.on('selfState',d=>{state.money=d.money??state.money;state.hp=d.hp??state.hp;state.armor=d.armor??state.armor;if(d.weapon){state.currentWeapon=d.weapon;state.owned=new Set(['pistol',d.weapon]);buildGun(d.weapon);}state.buyPrimaryThisRound=!!d.boughtPrimary;updateHUD();});
  socket.on('buyResult',d=>{if(!d.ok){showToast(d.message||'구매할 수 없습니다.');return;}state.money=d.money;state.armor=d.armor??state.armor;if(d.weapon){state.currentWeapon=d.weapon;state.owned=new Set(['pistol',d.weapon]);makeAmmoFor(d.weapon,true);buildGun(d.weapon);}state.buyPrimaryThisRound=!!d.boughtPrimary;state.armorPurchased=!!d.armorPurchased;soundBuy();updateHUD();});socket.on('shotFx',d=>{if(d.id!==socket.id){addShotFx(new THREE.Vector3(d.origin.x,d.origin.y,d.origin.z),new THREE.Vector3(d.end.x,d.end.y,d.end.z),0xff718a);soundShot(d.weaponId);}});socket.on('damage',d=>{if(d.targetId===socket.id){state.hp=d.hp;state.armor=d.armor??state.armor;updateHUD();soundHit();}if(d.attackerId===socket.id&&d.targetId!==socket.id){$('hit-marker').classList.remove('hidden');setTimeout(()=>$('hit-marker').classList.add('hidden'),110);soundHit();}if(d.killed&&d.attackerId===socket.id){soundKill();$('kill-banner').classList.remove('hidden');setTimeout(()=>$('kill-banner').classList.add('hidden'),900);}});
  socket.on('roundResult',d=>{state.phase='ended';state.selfScore=d.scores?.[socket.id]||0;state.enemyScore=Object.entries(d.scores||{}).filter(([id])=>id!==socket.id).reduce((a,[,v])=>a+v,0);state.money=d.selfMoney??state.money;state.matchOver=!!d.matchOver;const won=d.winnerId===socket.id;$('result-kicker').textContent=d.matchOver?'MATCH RESULT':'ROUND RESULT';$('result-title').innerHTML=d.matchOver?(won?'MATCH<br/><span>VICTORY.</span>':'MATCH<br/><span>DEFEAT.</span>'):(won?'ROUND<br/><span>WON.</span>':'ROUND<br/><span>LOST.</span>');$('result-copy').textContent=d.reason||'';$('result-reward').textContent=`+${(d.reward||0).toLocaleString()} CR`;$('next-round').classList.toggle('hidden',!!d.matchOver||state.mode==='online');$('next-round').textContent='다음 라운드는 자동 시작';endScreen.classList.remove('hidden');updateHUD();});
}

function setupEvents(){
  document.querySelectorAll('[data-device]').forEach(b=>b.addEventListener('click',()=>setDevice(b.dataset.device)));
  document.querySelectorAll('[data-rule]').forEach(b=>b.addEventListener('click',()=>setRule(b.dataset.rule)));
  document.querySelectorAll('[data-difficulty]').forEach(b=>b.addEventListener('click',()=>setDifficulty(b.dataset.difficulty)));
  $('play-ai').addEventListener('click',startAIMatch);$('create-room').addEventListener('click',beginOnline);$('join-room').addEventListener('click',joinOnline);
  $('room-code').addEventListener('input',e=>{e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);});
  $('open-buy').addEventListener('click',openBuy);$('touch-buy').addEventListener('click',openBuy);$('close-buy').addEventListener('click',closeBuy);$('buy-start').addEventListener('click',()=>{closeBuy();if(state.mode==='ai')beginLocalLive();});
  $('resume-game').addEventListener('click',()=>{state.paused=false;pauseMenu.classList.add('hidden');if(state.device==='pc'&&state.mode!=='menu')canvas.requestPointerLock?.();});
  $('leave-game').addEventListener('click',backToMenu);$('end-menu').addEventListener('click',backToMenu);$('next-round').addEventListener('click',()=>{if(state.mode==='ai')nextLocalRound();else if(state.mode==='online')showToast('온라인 매치는 서버가 다음 라운드를 시작합니다.');});
  $('quality-select').addEventListener('change',e=>{const q=e.target.value;renderer.shadowMap.enabled=q==='high';renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,q==='low'?.85:q==='medium'?1.25:1.75));renderer.setSize(window.innerWidth,window.innerHeight);});
  window.addEventListener('keydown',e=>{
    if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();
    if(e.code==='Escape'){if(!buyMenu.classList.contains('hidden')){closeBuy();return;}if(!pauseMenu.classList.contains('hidden')){state.paused=false;pauseMenu.classList.add('hidden');return;}if(state.mode!=='menu'&&state.phase!=='ended'&&state.phase!=='matchover'){state.paused=true;pauseMenu.classList.remove('hidden');if(document.pointerLockElement)document.exitPointerLock();}return;}
    if(state.mode==='menu'||state.phase==='ended'||state.paused)return;
    state.keys.add(e.code);
    if(e.code==='KeyB'){openBuy();}if(e.code==='KeyR')reloadWeapon();if(/^Digit[1-8]$/.test(e.code))switchWeaponByNumber(Number(e.code.slice(-1)));
  });window.addEventListener('keyup',e=>state.keys.delete(e.code));window.addEventListener('blur',()=>state.keys.clear());
  canvas.addEventListener('pointerdown',e=>{if(state.mode==='menu'||state.device==='mobile'||state.paused)return;initAudio();if(document.pointerLockElement!==canvas){canvas.requestPointerLock?.();}if(e.button===0)doShoot();});
  document.addEventListener('pointerlockchange',()=>{state.pointerLocked=document.pointerLockElement===canvas;});
  document.addEventListener('mousemove',e=>{if(state.device!=='pc'||document.pointerLockElement!==canvas||state.phase!=='live'||state.paused)return;state.yaw-=e.movementX*.00215;state.pitch-=e.movementY*.00215;state.pitch=THREE.MathUtils.clamp(state.pitch,-1.28,1.28);});
  $('touch-fire').addEventListener('pointerdown',e=>{e.preventDefault();initAudio();doShoot();});$('touch-jump').addEventListener('pointerdown',e=>{e.preventDefault();state.keys.add('Space');});$('touch-jump').addEventListener('pointerup',()=>state.keys.delete('Space'));$('touch-reload').addEventListener('pointerdown',e=>{e.preventDefault();reloadWeapon();});$('touch-switch').addEventListener('pointerdown',e=>{e.preventDefault();const current=WEAPONS.findIndex(w=>w.id===state.currentWeapon);for(let i=1;i<=WEAPONS.length;i++){const n=(current+i)%WEAPONS.length;if(state.owned.has(WEAPONS[n].id)){setWeapon(WEAPONS[n].id);break;}}});
  const pad=$('move-pad'),stick=$('move-stick');let padPointer=null;
  pad.addEventListener('pointerdown',e=>{e.preventDefault();padPointer=e.pointerId;pad.setPointerCapture(e.pointerId);updatePad(e);});
  pad.addEventListener('pointermove',e=>{if(e.pointerId===padPointer)updatePad(e);});
  const resetPad=()=>{padPointer=null;state.touchMove.x=0;state.touchMove.y=0;stick.style.transform='translate(0px,0px)';};pad.addEventListener('pointerup',resetPad);pad.addEventListener('pointercancel',resetPad);
  function updatePad(e){const r=pad.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;let x=(e.clientX-cx)/(r.width*.36),y=(e.clientY-cy)/(r.height*.36);const l=Math.hypot(x,y);if(l>1){x/=l;y/=l;}state.touchMove.x=x;state.touchMove.y=y;stick.style.transform=`translate(${x*27}px,${y*27}px)`;}
  const look=$('look-zone');look.addEventListener('pointerdown',e=>{if(state.device!=='mobile')return;e.preventDefault();look.setPointerCapture(e.pointerId);state.mobileLook={id:e.pointerId,x:e.clientX,y:e.clientY};initAudio();});
  look.addEventListener('pointermove',e=>{if(!state.mobileLook||state.mobileLook.id!==e.pointerId)return;const dx=e.clientX-state.mobileLook.x,dy=e.clientY-state.mobileLook.y;state.mobileLook.x=e.clientX;state.mobileLook.y=e.clientY;state.yaw-=dx*.006;state.pitch-=dy*.005;state.pitch=THREE.MathUtils.clamp(state.pitch,-1.22,1.22);});
  const endLook=e=>{if(state.mobileLook&&state.mobileLook.id===e.pointerId)state.mobileLook=null;};look.addEventListener('pointerup',endLook);look.addEventListener('pointercancel',endLook);
  window.addEventListener('resize',()=>{camera.aspect=window.innerWidth/window.innerHeight;camera.updateProjectionMatrix();renderer.setSize(window.innerWidth,window.innerHeight);});
}

function updateWorld(dt,now){
  if(state.mode==='menu'){
    camera.position.set(Math.sin(now*.00008)*3,11,28);camera.lookAt(0,1,0);
    return;
  }
  if(state.mode==='online'){
    if(state.phase==='live'&&!state.paused)movePlayer(dt);
    for(const [id,r]of state.remotePlayers){r.root.position.lerp(r.target,Math.min(1,dt*12));r.root.rotation.y=r.yaw;}
  }else{
    if(state.phase==='live'&&!state.paused){movePlayer(dt);updateAI(dt);}
  }
  if(state.mode!=='menu'){
    camera.position.set(state.pos.x,state.pos.y+1.58,state.pos.z);camera.rotation.order='YXZ';camera.rotation.y=state.yaw;camera.rotation.x=state.pitch;
    gunRoot.position.x=state.device==='mobile'?.03:0;gunRoot.visible=state.phase==='live'||state.phase==='buy';
    if(state.phase==='buy'&&Date.now()>=state.phaseEnd&&state.mode==='ai')beginLocalLive();
    if(state.mode==='ai'&&state.phase==='live'&&Date.now()>=state.roundLimit)endLocalRound(state.hp>0,'시간 종료');
    if(state.phase==='buy'){$('buy-countdown').textContent=`${Math.max(0,Math.ceil((state.phaseEnd-Date.now())/1000))}초`;}
    const remaining=Math.max(0,Math.ceil((state.phase==='buy'?state.phaseEnd:state.phase==='live'?state.roundLimit:Date.now())-Date.now())/1000);
    $('match-timer').textContent=`${String(Math.floor(remaining/60)).padStart(2,'0')}:${String(Math.floor(remaining%60)).padStart(2,'0')}`;
  }
  if(muzzleMesh&&now>state.muzzleUntil)muzzleMesh.visible=false;
  for(let i=state.shotFx.length-1;i>=0;i--){const fx=state.shotFx[i];if(now>=fx.expires){scene.remove(fx.line);fx.geo.dispose();fx.mat.dispose();state.shotFx.splice(i,1);}}
}
function animate(now){requestAnimationFrame(animate);const dt=Math.min(.05,(now-state.lastFrame)/1000||0);state.lastFrame=now;updateWorld(dt,now);
  state.fpsFrames++;if(now-state.fpsStamp>450){$('fps-value').textContent=Math.round(state.fpsFrames*1000/(now-state.fpsStamp||450));state.fpsFrames=0;state.fpsStamp=now;}
  renderer.render(scene,camera);
}

setDevice(state.device);setRule('crossplay');setDifficulty('normal');buildGun('pistol');setupEvents();updateHUD();requestAnimationFrame(animate);

if (import.meta.env.PROD && 'serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(() => {}); }
