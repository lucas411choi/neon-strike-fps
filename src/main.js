import * as THREE from 'three';
import { io } from 'socket.io-client';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { XP_PER_LEVEL, getHitMultiplier } from './shared-rules.js';
import { STORE_SKINS, STORE_BUNDLES, STORE_ROLL_COST, TRAINING_QUEST_TARGET, TRAINING_QUEST_REWARD, getStoreSkin } from './store-catalog.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game-canvas');
const menu = $('main-menu');
const hud = $('hud');
const buyMenu = $('buy-menu');
const pauseMenu = $('pause-menu');
const endScreen = $('end-screen');
const touchControls = $('touch-controls');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SESSION_KEY = 'neon-strike-session-v1';
const AUTH_TOKEN_KEY = 'neon-strike-auth-token-v1';
let initialAuthToken = '';
try { initialAuthToken = localStorage.getItem(AUTH_TOKEN_KEY) || ''; } catch {}
let CLIENT_SESSION_ID;
try { CLIENT_SESSION_ID = sessionStorage.getItem(SESSION_KEY); if (!CLIENT_SESSION_ID) { CLIENT_SESSION_ID = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`); sessionStorage.setItem(SESSION_KEY, CLIENT_SESSION_ID); } } catch { CLIENT_SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

const WEAPONS = [
  { id:'pistol', name:'ATLAS PISTOL', short:'ATLAS', type:'SIDEARM', slot:'sidearm', price:0, damage:10, head:1.30, rate:0.32, mag:12, reserve:36, reload:1.15, spread:0.007, recoil:0.010, range:55, control:8, color:0xb8c8d9, desc:'안정적인 기본 권총 · 우주 합금 슬라이드' },
  { id:'revolver', name:'IRONCLAD .45', short:'IRONCLAD', type:'HEAVY SIDEARM', slot:'sidearm', price:550, damage:30, head:1.30, rate:0.52, mag:6, reserve:24, reload:1.75, spread:0.0055, recoil:0.025, range:62, control:8, color:0xd9ac70, desc:'6발 실린더 · 묵직한 고출력 탄' },
  { id:'smg', name:'VIPER SMG', short:'VIPER', type:'SMG', slot:'primary', price:850, damage:7, head:1.30, rate:0.12, mag:30, reserve:90, reload:1.45, spread:0.022, recoil:0.013, range:25, control:5, color:0x55e6d2, desc:'근거리 고연사 · 발사 간격을 줄인 안정형' },
  { id:'shotgun', name:'BREACH SG', short:'BREACH', type:'SHOTGUN', slot:'primary', price:1100, damage:6.5, pellets:10, head:1.08, rate:0.86, mag:7, reserve:21, reload:1.7, spread:0.105, recoil:0.046, range:16, control:3, color:0xd9a36a, desc:'10발 산탄 · 근거리 강력, 원거리 피해 감소' },
  { id:'rifle', name:'VANTAGE AR', short:'VANTAGE', type:'ASSAULT RIFLE', slot:'primary', price:1950, damage:15, head:1.30, rate:0.13, mag:30, reserve:60, reload:1.55, spread:0.012, recoil:0.018, range:50, control:7, color:0x8aafff, desc:'중거리 균형형 · 우클릭 정밀 조준', scopeFov:54 },
  { id:'dmr', name:'RAIL DMR', short:'RAIL', type:'MARKSMAN', slot:'primary', price:2200, damage:20, head:1.30, rate:0.32, mag:12, reserve:36, reload:1.65, spread:0.004, recoil:0.027, range:75, control:9, color:0x9ec4d6, desc:'정밀 단발 · 개선된 빠른 후속 사격', scopeFov:40 },
  { id:'sniper', name:'LONGSHOT SR', short:'LONGSHOT', type:'SNIPER', slot:'primary', price:3000, damage:78, head:1.30, rate:1.12, mag:5, reserve:15, reload:2.0, spread:0.0012, hipSpread:0.060, scopeSpread:0.0012, recoil:0.082, range:100, control:10, color:0xdfb5ff, desc:'고위력 저격총 · 노줌 명중률 낮음, 발사 후 자동 줌아웃', scopeFov:29 },
  { id:'lmg', name:'TITAN LMG', short:'TITAN', type:'LMG', slot:'primary', price:2500, damage:16, head:1.30, rate:0.115, mag:60, reserve:120, reload:2.4, spread:0.026, recoil:0.021, range:42, control:4, color:0xe6c36e, desc:'대용량 탄창 · 강한 지속 반동' },
  { id:'burst', name:'ION BURST', short:'ION', type:'BURST RIFLE', slot:'primary', price:1600, damage:14, head:1.30, rate:0.30, burstCount:3, burstGap:0.055, mag:24, reserve:72, reload:1.5, spread:0.010, recoil:0.025, range:45, control:8, color:0x85e5ff, desc:'3점사 위상 펄스 · 3발을 빠르게 발사', scopeFov:50 },
  { id:'knife', name:'ORBITAL EDGE', short:'ORBITAL', type:'MELEE', slot:'melee', price:0, damage:40, head:1, rate:0.48, mag:Infinity, reserve:Infinity, reload:0, spread:0, recoil:0.002, range:2.65, control:10, color:0x7af9e8, desc:'근접 전용 40 피해 · 이동 속도 +10%' },
];
const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map(w => [w.id, w]));
const platformName = { pc:'PC', mobile:'MOBILE' };

const state = {
  device: matchMedia('(pointer:coarse)').matches ? 'mobile' : 'pc',
  rule:'crossplay', difficulty:'normal', name:'PLAYER', mode:'menu', phase:'menu', playMode:'training', selectedMap:'arena', mapId:'arena', mapBounds:31.8, lobbyPage:'play', lobbyMapCycle:-1, lobbySelectedWeapon:'rifle',
  round:0, selfScore:0, enemyScore:0, money:450, hp:100, armor:0, armorTier:'none',
  authToken:initialAuthToken, account:null, accountMode:'register', xpLoginNoticeShown:false,
  currentWeapon:'pistol', owned:new Set(['pistol','knife']), ammo:{},
  pos:new THREE.Vector3(0,0,15), velocityY:0, yaw:0, pitch:0,
  keys:new Set(), touchMove:{x:0,y:0}, canJump:true,
  lastShot:0, reloading:false, reloadUntil:0, lastFrame:performance.now(), fpsFrames:0, fpsStamp:0,
  phaseEnd:0, roundLimit:0, botList:[], trainingTargets:[], remotePlayers:new Map(), shotFx:[], muzzleUntil:0,
  roomCode:'', socket:null, socketReady:false, paused:false, resultShown:false,
  buyPrimaryThisRound:false, armorPurchased:false, matchOver:false, botFireTimers:[],
  pointerLocked:false, mobileLook:null, audio:null, noiseBuffer:null, currentToastTimer:0, zoomed:false, baseFov:76, localNextRoundTimer:null,
  fireHeld:false, sniperMustRelease:false, lastEmptyToast:0, recoilHeat:0, viewKick:0, walkCycle:0, walkIntensity:0, footstepAccumulator:0, lastFootstepSound:0,
  burstRemaining:0, burstNextAt:0, burstId:0, burstSeq:1, weaponMotion:{drawAt:performance.now(),inspectAt:0,fireAt:0,knifeAt:0,reloadAt:0},
  killCam:null, killCamActive:false, killEffects:[], roundResultTimer:null, roundResultPending:null, killCamTimer:null, killCamSavedWeapon:null,
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

const hemiLight = new THREE.HemisphereLight(0x9fc9e8, 0x18202d, 1.6); scene.add(hemiLight);
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
const worldRoot = new THREE.Group(); scene.add(worldRoot);
let mapScopedMaterials = [];
const stairRamps = [];
const elevatedPlatforms = [];
const MAP_META = {
  arena:{name:'ARENA / HELIX YARD',bounds:31.8,spawn:27,floor:0x111a25,sky:0x08101b,fog:0x08101b,fogDensity:.0125},
  palace:{name:'경복궁 야외 / PALACE COURT',bounds:45.5,spawn:40,floor:0x71875c,sky:0x9cc8ed,fog:0xb6d8ed,fogDensity:.0034},
  city:{name:'도시 / METRO DISTRICT',bounds:66,spawn:52,floor:0x323b45,sky:0x8797a9,fog:0x8797a9,fogDensity:.0026},
};
function addBox(x,y,z,w,h,d,mat,{collision=true,accent=null,rotation=0,rotationX=0,rotationZ=0,solidTop=false}={}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat);
  mesh.position.set(x,y+h/2,z); mesh.rotation.set(rotationX,rotation,rotationZ); mesh.castShadow=true; mesh.receiveShadow=true; worldRoot.add(mesh);
  if (collision) { colliders.push({x,z,w,d,h,solidTop}); obstacleMeshes.push(mesh); }
  if (accent) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(w*0.86,0.035,0.04), accent);
    line.position.set(x,y+h*.82,z-d*.501); line.rotation.y=rotation; worldRoot.add(line);
  }
  return mesh;
}
function addCylinder(x,y,z,rTop,rBottom,h,mat,{collision=false,segments=10}={}) {
  const mesh=new THREE.Mesh(new THREE.CylinderGeometry(rTop,rBottom,h,segments),mat);
  mesh.position.set(x,y+h/2,z);mesh.castShadow=true;mesh.receiveShadow=true;worldRoot.add(mesh);
  if(collision){colliders.push({x,z,w:Math.max(rTop,rBottom)*2,d:Math.max(rTop,rBottom)*2,h});obstacleMeshes.push(mesh);}
  return mesh;
}
function addSphere(x,y,z,r,mat,scale={x:1,y:1,z:1}) {
  const mesh=new THREE.Mesh(new THREE.SphereGeometry(r,9,7),mat);mesh.position.set(x,y,z);mesh.scale.set(scale.x,scale.y,scale.z);mesh.castShadow=true;worldRoot.add(mesh);return mesh;
}
function addTree(x,z,leafColor=0x2d7148,scale=1){
  const trunk=new THREE.MeshStandardMaterial({color:0x65462f,roughness:.95});const leaves=new THREE.MeshStandardMaterial({color:leafColor,roughness:.9});mapScopedMaterials.push(trunk,leaves);
  addCylinder(x,0,z,.24*scale,.34*scale,2.2*scale,trunk,{segments:7});
  addSphere(x,2.7*scale,z,.95*scale,leaves,{x:1,y:1.12,z:1});
  addSphere(x-.48*scale,2.35*scale,z+.1,.64*scale,leaves,{x:1,y:1,z:1});
  addSphere(x+.45*scale,2.5*scale,z-.12,.68*scale,leaves,{x:1,y:1,z:1});
}
function clearMap(){
  worldRoot.traverse(o=>{if(o.geometry)o.geometry.dispose();});
  for(const m of mapScopedMaterials)m.dispose();mapScopedMaterials=[];
  worldRoot.clear();colliders.length=0;obstacleMeshes.length=0;stairRamps.length=0;elevatedPlatforms.length=0;
}
function addBoundary(bounds,wallHeight,mat,accent=null){
  const edge=bounds+1.8, length=edge*2;
  addBox(0,0,-edge,length,wallHeight,1.5,mat,{accent});
  addBox(0,0,edge,length,wallHeight,1.5,mat,{accent});
  addBox(-edge,0,0,1.5,wallHeight,length,mat);
  addBox(edge,0,0,1.5,wallHeight,length,mat);
}
function buildArenaMap(){
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(72,72), materials.floor); floor.rotation.x=-Math.PI/2; floor.position.y=-0.05; floor.receiveShadow=true; worldRoot.add(floor);
  const grid = new THREE.GridHelper(72,72,0x2a666d,0x213341); grid.position.y=-0.035; grid.material.transparent=true; grid.material.opacity=.42; worldRoot.add(grid);
  addBoundary(31.8,5,materials.wallDark,materials.cyan);
  [[-15,-12,7,2.6,3,materials.wall],[-3,-14,4,1.5,4,materials.wallDark],[10,-12,7,2.8,3,materials.wall],[-19,0,3,2.2,8,materials.wallDark],[-8,-1,5,1.4,3,materials.wall],[6,2,4,2.4,5,materials.wallDark],[19,0,3,2.2,8,materials.wallDark],[-13,15,8,2.6,3,materials.wall],[0,13,5,1.5,4,materials.wallDark],[13,15,8,2.6,3,materials.wall],[-2,0,2,3.6,2,materials.wall]].forEach(([x,z,w,h,d,mat])=>addBox(x,0,z,w,h,d,mat,{accent:mat===materials.wall?materials.cyan:null}));
  // Short high barriers block instant spawn-to-spawn shots but leave obvious flank gaps.
  for(const z of [-20,20])for(const x of [-18,0,18])addBox(x,0,z,x===0?14:10,6.2,1.35,materials.wallDark,{accent:z>0?materials.red:materials.cyan});
  addBox(-10,0,-8,1.6,6.8,10,materials.wallDark,{accent:materials.cyan});addBox(10,0,8,1.6,6.8,10,materials.wallDark,{accent:materials.red});
  for(let i=-3;i<=3;i++){const stripe=new THREE.Mesh(new THREE.BoxGeometry(.045,.02,58),i%2===0?materials.cyan:materials.red);stripe.position.set(i*8,.005,0);stripe.material=stripe.material.clone();stripe.material.transparent=true;stripe.material.opacity=.18;worldRoot.add(stripe);mapScopedMaterials.push(stripe.material);}
  [[-28,-27,materials.cyan],[28,27,materials.red],[-28,27,materials.cyan],[28,-27,materials.red]].forEach(([x,z,color])=>{addBox(x,0,z,.7,4,.7,materials.wallDark);const strip=new THREE.Mesh(new THREE.BoxGeometry(.72,2.7,.73),color);strip.position.set(x,2,z);worldRoot.add(strip);});
}
function buildPalaceMap(){
  materials.floor.color.setHex(0x71875c);materials.floor.roughness=.98;materials.floor.metalness=0;
  materials.wall.color.setHex(0xe0d1ad);materials.wall.roughness=.9;materials.wall.metalness=0;
  materials.wallDark.color.setHex(0x574b3e);materials.wallDark.roughness=.9;materials.wallDark.metalness=0;
  materials.cyan.color.setHex(0x176e54);materials.cyan.emissive.setHex(0x073d2c);materials.cyan.emissiveIntensity=.32;
  materials.red.color.setHex(0x9c2636);materials.red.emissive.setHex(0x3b0710);materials.red.emissiveIntensity=.22;
  materials.white.color.setHex(0xf2e7c9);materials.white.metalness=0;materials.white.roughness=.8;
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(96,96),materials.floor);floor.rotation.x=-Math.PI/2;floor.position.y=-.05;floor.receiveShadow=true;worldRoot.add(floor);
  const stoneMat=new THREE.MeshStandardMaterial({color:0xbcb39f,roughness:.96});const darkStone=new THREE.MeshStandardMaterial({color:0x746a58,roughness:.9});const greenTile=new THREE.MeshStandardMaterial({color:0x244c3d,roughness:.75});mapScopedMaterials.push(stoneMat,darkStone,greenTile);
  addBox(0,-.015,0,12,.02,95,stoneMat,{collision:false});
  for(let z=-43;z<=43;z+=5)addBox(0,.005,z,12,.025,.06,darkStone,{collision:false});
  addBoundary(45.5,3.2,darkStone);
  // Traditional palace facade and tiered dark-tile roof, deliberately outdoors rather than an interior.
  addBox(0,0,-27,30,4.8,10,materials.wall);
  addBox(0,4.8,-27,31,.55,10,materials.red,{collision:false});
  for(let x=-13.5;x<=13.51;x+=4.5){addBox(x,0,-21.75,.62,5.9,.72,materials.red);addBox(x,4.7,-21.75,.82,.32,.88,materials.cyan,{collision:false});}
  addBox(0,5.7,-21.6,31,.42,1.2,materials.cyan,{collision:false});
  addBox(0,6.6,-23.3,34,.65,4.2,materials.wallDark,{collision:false,rotationX:.20});
  addBox(0,6.6,-27.7,34,.65,4.2,materials.wallDark,{collision:false,rotationX:-.20});
  addBox(0,7.15,-25.5,34,.35,.6,greenTile,{collision:false});
  for(let x=-15;x<=15;x+=2.5){addBox(x,7.35,-25.5,.16,.16,7.1,materials.red,{collision:false});}
  // Red-green palace gates / side pavilions and low stone cover.
  for(const x of [-24,24]){
    addBox(x,0,-17,9,3.6,6,materials.wall);for(let px=x-3;px<=x+3;px+=3)addBox(px,0,-13.8,.42,4.2,.42,materials.red);
    addBox(x,4.1,-17,11,.48,7,materials.wallDark,{collision:false,rotationX:.15});addBox(x,4.3,-17,11,.26,1.0,materials.cyan,{collision:false});
  }
  for(const z of [-7,4,16,28]){
    addBox(-20,0,z,10,1.18,1.2,darkStone);addBox(20,0,z,10,1.18,1.2,darkStone);
    addBox(-8,0,z+2,4,.92,1.1,stoneMat);addBox(8,0,z-2,4,.92,1.1,stoneMat);
  }
  // Stone lanterns / ornaments.
  for(const [x,z] of [[-15,-8],[15,-8],[-15,13],[15,13],[-31,3],[31,3]]){
    addBox(x,0,z,.65,1.2,.65,darkStone);addBox(x,1.2,z,.9,.18,.9,stoneMat);addBox(x,1.38,z,.45,.35,.45,materials.wallDark);
  }
  for(const z of [-36,-25,-12,2,14,27,37]){addTree(-38,z,z%2?0x2d7945:0x3e8450,.9);addTree(38,z,z%2?0x2d7945:0x3e8450,.9);}
  // Short high stone walls; side gaps stay open so players can flank naturally.
  for(const z of [-33,33])for(const x of [-24,0,24])addBox(x,0,z,x===0?13:10,5.8,1.35,materials.wallDark,{accent:z>0?materials.red:materials.cyan});
}
function buildCityMap(){
  materials.floor.color.setHex(0x303943);materials.floor.roughness=.96;materials.floor.metalness=.05;
  materials.wall.color.setHex(0x57616b);materials.wall.roughness=.75;materials.wall.metalness=.12;
  materials.wallDark.color.setHex(0x171f29);materials.wallDark.roughness=.8;materials.wallDark.metalness=.22;
  materials.cyan.color.setHex(0x5cc9d5);materials.cyan.emissive.setHex(0x124751);materials.cyan.emissiveIntensity=.7;
  materials.red.color.setHex(0xd17d54);materials.red.emissive.setHex(0x462013);materials.red.emissiveIntensity=.5;
  materials.white.color.setHex(0xd9e1e8);materials.white.metalness=.05;materials.white.roughness=.55;
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(148,148),materials.floor);floor.rotation.x=-Math.PI/2;floor.position.y=-.05;floor.receiveShadow=true;worldRoot.add(floor);
  const roadMat=new THREE.MeshStandardMaterial({color:0x1f252d,roughness:.99});const laneMat=new THREE.MeshStandardMaterial({color:0xe4ca7d,emissive:0x30240b,roughness:.9});const glassMat=new THREE.MeshStandardMaterial({color:0x418caa,metalness:.32,roughness:.22,emissive:0x102c36});const shopMat=new THREE.MeshStandardMaterial({color:0xc66c49,roughness:.8});const metroMat=new THREE.MeshStandardMaterial({color:0x213b4a,metalness:.25,roughness:.6});mapScopedMaterials.push(roadMat,laneMat,glassMat,shopMat,metroMat);
  addBox(0,-.02,0,22,.025,124,roadMat,{collision:false});
  for(let z=-58;z<=58;z+=7){addBox(0,.01,z, .14,.02,3,laneMat,{collision:false});addBox(-10,.01,z, .12,.02,2,materials.white,{collision:false});addBox(10,.01,z,.12,.02,2,materials.white,{collision:false});}
  // Segmented city perimeter: two 10m gates on every side let players leave the wall ring instead of being trapped.
  const edge=59.8, wallRanges=[[-59,-15],[-5,5],[15,59]];
  for(const [a,b] of wallRanges){
    const length=b-a, center=(a+b)/2;
    addBox(center,0,-edge,length,7,1.5,materials.wallDark);
    addBox(center,0,edge,length,7,1.5,materials.wallDark);
    addBox(-edge,0,center,1.5,7,length,materials.wallDark);
    addBox(edge,0,center,1.5,7,length,materials.wallDark);
  }
  // Paved apron outside the openings marks a small walkable perimeter before the invisible world limit.
  addBox(0,-.025,-64,145,.025,7,roadMat,{collision:false});
  addBox(0,-.025,64,145,.025,7,roadMat,{collision:false});
  addBox(-64,-.025,0,7,.025,145,roadMat,{collision:false});
  addBox(64,-.025,0,7,.025,145,roadMat,{collision:false});
  // Tall office blocks; two rooftops are reached by visible stairs and a walkable height ramp.
  addBox(-31,0,-29,14,7,16,materials.wallDark,{solidTop:true});addBox(-31,7,-29,14,.2,16,materials.wall,{collision:false});
  elevatedPlatforms.push({xMin:-38,xMax:-24,zMin:-37,zMax:-20.5,height:7});
  stairRamps.push({xMin:-33.2,xMax:-28.8,zMin:-20.5,zMax:-8,height:7});
  for(let i=0;i<12;i++){const h=(i+1)*7/12;addBox(-31,h-.24,-8-(i+.5),3.8,.24,1.04,materials.wall,{collision:false});}
  // Roof access for a second, lower block on the eastern side.
  addBox(31,0,18,13,5.5,15,materials.wall,{solidTop:true});addBox(31,5.5,18,13,.2,15,materials.white,{collision:false});
  elevatedPlatforms.push({xMin:24.5,xMax:37.5,zMin:10.5,zMax:26.5,height:5.5});
  stairRamps.push({xMin:29,xMax:33,zMin:26.5,zMax:38,height:5.5});
  for(let i=0;i<11;i++){const h=(i+1)*5.5/11;addBox(31,h-.22,38-(i+.5)*1.15,4,.22,1.18,materials.wall,{collision:false});}
  // Small buildings create alleys and crossfire angles.
  const buildings=[[-43,-6,12,17,8],[-16,-31,9,12,5],[18,-31,15,12,8],[45,-17,10,16,7],[-45,22,13,18,9],[13,40,18,10,6],[43,39,15,13,8],[-12,39,13,11,6]];
  for(const [x,z,w,d,h] of buildings){
    addBox(x,0,z,w,h,d,materials.wallDark,{solidTop:true});
    addBox(x,Math.max(1,h*.35),z-d/2-.05,w*.72,Math.min(1.4,h*.18),.12,glassMat,{collision:false});
    addBox(x,Math.max(1,h*.35)+.9,z-d/2-.1,w*.76,.14,.22,materials.red,{collision:false});
  }
  // Shops and striped awnings as practical waist-high street cover.
  for(const [x,z,c] of [[-20,-4,0xc66c49],[20,4,0x3b9c92],[-19,20,0xc7a45b],[19,-19,0x6a82b8]]){
    addBox(x,0,z,10,3.4,6,materials.wall,{solidTop:true});
    addBox(x,1.15,z-3.12,8.8,.6,.55,shopMat,{collision:false});
    addBox(x,1.9,z-3.13,6.2,1.0,.14,glassMat,{collision:false});
    addBox(x,3.2,z-3,11,.28,7,materials.red,{collision:false});
    addBox(x,0,z+4,4,1.2,1.3,materials.wallDark);
  }
  // Metro entrance: side walls and canopy make a readable, low cover landmark.
  addBox(0,0,29,11,1.65,7,metroMat);addBox(-5.1,0,29,1,2.5,9,materials.wall);addBox(5.1,0,29,1,2.5,9,materials.wall);
  addBox(0,2.7,29,12,.35,9,materials.wallDark,{collision:false});
  addBox(0,1.9,24.1,7,.12,.2,materials.cyan,{collision:false});
  for(let z=-48;z<=48;z+=16){addBox(-6,0,z,.25,5,.25,materials.wallDark,{collision:false});addBox(-6,5,z,.5,.35,.5,materials.red,{collision:false});addBox(6,0,z,.25,5,.25,materials.wallDark,{collision:false});addBox(6,5,z,.5,.35,.5,materials.cyan,{collision:false});}
  // Compact tall street barricades. All three sections are short with walkable side gaps.
  for(const z of [-43,43])for(const x of [-18,0,18])addBox(x,0,z,x===0?14:11,7.1,1.55,materials.wallDark,{accent:z>0?materials.red:materials.cyan});
  // Street-side barriers and street trees.
  for(const [x,z] of [[-8,-17],[8,17],[-8,39],[8,-39]])addBox(x,0,z,4,1.35,1.4,materials.wall,{accent:materials.cyan});
  for(const z of [-47,-30,-10,12,32,48]){addTree(-53,z,0x476d50,.75);addTree(53,z,0x476d50,.75);}
}
function buildMap(mapId='arena'){
  const id=Object.hasOwn(MAP_META,mapId)?mapId:'arena';
  clearMap();state.mapId=id;state.mapBounds=MAP_META[id].bounds;
  scene.background.setHex(MAP_META[id].sky);scene.fog=new THREE.FogExp2(MAP_META[id].fog,MAP_META[id].fogDensity);
  if(id==='arena'){
    materials.floor.color.setHex(0x111a25);materials.floor.roughness=.82;materials.floor.metalness=.22;materials.wall.color.setHex(0x202e3d);materials.wallDark.color.setHex(0x101a27);materials.cyan.color.setHex(0x4cf4d5);materials.cyan.emissive.setHex(0x167e75);materials.cyan.emissiveIntensity=1.7;materials.red.color.setHex(0xff607b);materials.red.emissive.setHex(0x771d34);materials.red.emissiveIntensity=1.5;materials.white.color.setHex(0xc5d9ec);materials.white.metalness=.7;materials.white.roughness=.35;
    hemiLight.color.setHex(0x9fc9e8);hemiLight.groundColor.setHex(0x18202d);hemiLight.intensity=1.6;keyLight.color.setHex(0xc7e6ff);keyLight.intensity=2;
    buildArenaMap();
  }else if(id==='palace'){
    hemiLight.color.setHex(0xe2f1ff);hemiLight.groundColor.setHex(0x526844);hemiLight.intensity=2.15;keyLight.color.setHex(0xffe4b6);keyLight.intensity=2.35;buildPalaceMap();
  }else{
    hemiLight.color.setHex(0xb8c8e0);hemiLight.groundColor.setHex(0x262b32);hemiLight.intensity=1.45;keyLight.color.setHex(0xe0e6f0);keyLight.intensity=1.6;buildCityMap();
  }
  const meta=MAP_META[id];
  const mapLabel=document.querySelector('.map-label');if(mapLabel){const title=id==='arena'?'MAP 01 / HELIX YARD':id==='palace'?'MAP 02 / PALACE COURT':'MAP 03 / METRO DISTRICT';const live=mapLabel.querySelector('.map-live');mapLabel.childNodes.forEach(n=>{if(n.nodeType===Node.TEXT_NODE&&n.textContent.trim())n.textContent=' '+title+' ';});if(live)live.textContent='LIVE SIMULATION';}
}
function selectMap(mapId){
  if(!Object.hasOwn(MAP_META,mapId))return;
  state.selectedMap=mapId;
  document.querySelectorAll('[data-map]').forEach(b=>b.classList.toggle('selected',b.dataset.map===mapId));
  const meta=MAP_META[mapId],index=mapId==='arena'?'01':mapId==='palace'?'02':'03';
  const mapStatus=$('map-status');if(mapStatus)mapStatus.textContent=`선택된 맵: ${meta.name}`;
  const label=$('selected-map-label');if(label)label.textContent=mapId==='arena'?'아레나':mapId==='palace'?'경복궁 야외':'도시';
  const description=$('map-card-description');if(description)description.textContent=mapId==='arena'?'네온 전술 구역 · 짧은 고지 엄폐물과 우회 통로':mapId==='palace'?'경복궁이 보이는 야외 정원 · 전통 단청과 기와 지붕':'넓은 도심 교전 구역 · 계단, 상점, 지하철 엄폐물';
  const indexLabel=$('map-card-index');if(indexLabel)indexLabel.textContent=`${index} / 03`;
  const chip=$('map-art-chip');if(chip)chip.textContent=`MAP ${index}`;
  const art=$('lobby-map-art');if(art)art.className=`lobby-map-art ${mapId==='arena'?'arena-art':mapId==='palace'?'palace-art':'city-art'}`;
  const topMap=$('menu-map-name');if(topMap)topMap.textContent=`MAP ${index} / ${mapId==='arena'?'HELIX YARD':mapId==='palace'?'GYEONGBOKGUNG COURT':'METRO DISTRICT'}`;
  // Only rebuild the actual combat space outside the lobby; the lobby background cycles independently.
  if(state.mode!=='menu')buildMap(mapId);
}
function cycleSelectedMap(direction=1){const ids=['arena','palace','city'];const current=Math.max(0,ids.indexOf(state.selectedMap));selectMap(ids[(current+direction+ids.length)%ids.length]);}
function setPlayMode(mode){state.playMode=mode==='online'?'online':'training';document.querySelectorAll('[data-play-mode]').forEach(b=>b.classList.toggle('selected',b.dataset.playMode===state.playMode));const online=state.playMode==='online';$('online-join-options')?.classList.toggle('hidden',!online);$('start-battle-label').textContent=online?'방 만들기':'훈련 시작';$('start-battle-subtitle').textContent=online?'FRIEND MATCH / FIRST TO 6':'TRAINING RANGE';setMenuStatus(online?'방을 만들고 코드를 친구에게 공유하거나, 받은 코드로 참가하세요.':'훈련장에서는 과녁과 사람 더미를 사격하고 무기를 자유롭게 바꿀 수 있어요.');}
function setLobbyPage(page){
  const allowed=['quests','shop','play','skins','account','weapons'];
  const chosen=allowed.includes(page)?page:'play';state.lobbyPage=chosen;
  document.querySelectorAll('[data-lobby-tab]').forEach(b=>b.classList.toggle('active',b.dataset.lobbyTab===chosen));
  $('lobby-play-view')?.classList.toggle('hidden',chosen!=='play');
  $('lobby-weapons-view')?.classList.toggle('hidden',chosen!=='weapons');
  $('lobby-shop-view')?.classList.toggle('hidden',chosen!=='shop');
  $('lobby-skins-view')?.classList.toggle('hidden',chosen!=='skins');
  $('lobby-quests-view')?.classList.toggle('hidden',chosen!=='quests');
  $('lobby-coming-soon-view')?.classList.add('hidden');
  $('lobby-account-view')?.classList.toggle('hidden',chosen!=='account');
  if(chosen==='weapons')renderLobbyWeapons();
  if(chosen==='account')renderAccountPanel();
  if(chosen==='quests')renderQuestPanel();
  if(['shop','skins','quests'].includes(chosen))void refreshStoreState({silent:true});
}

let trainingXpQueue = Promise.resolve();
let storeState = { dailySkinIds: [], dailyDate: '', rollCost: STORE_ROLL_COST };
let storeBusy = false;
let gachaRequestBusy = false;
function getAuthToken(){return state.authToken||'';}
function accountMessage(id,message,type=''){const el=$(id);if(!el)return;el.textContent=message||'';el.classList.toggle('error',type==='error');el.classList.toggle('success',type==='success');}
function renderAccountPanel(){
  const loggedIn=!!state.account;
  $('account-auth-panel')?.classList.toggle('hidden',loggedIn);
  $('account-profile-panel')?.classList.toggle('hidden',!loggedIn);
  document.querySelectorAll('[data-account-mode]').forEach(button=>button.classList.toggle('selected',button.dataset.accountMode===state.accountMode));
  const submit=$('account-auth-submit');
  if(submit){const title=state.accountMode==='register'?'회원가입':'로그인';submit.querySelector('b').textContent=title;submit.querySelector('small').textContent=state.accountMode==='register'?'CREATE PLAYER ID':'SIGN IN TO PLAYER ID';}
  const password=$('account-password');if(password)password.autocomplete=state.accountMode==='register'?'new-password':'current-password';
  if(!loggedIn)return;
  const account=state.account,level=Math.max(1,Number(account.level)||1),xp=Math.max(0,Number(account.xp)||0),needed=level*XP_PER_LEVEL;
  $('account-profile-name').textContent=account.username;
  $('account-level').textContent=`LV. ${level}`;
  $('account-xp').textContent=`${xp} / ${needed} XP`;
  $('account-next-level').textContent=`다음 레벨까지 ${Math.max(0,needed-xp)} XP`;
  $('account-xp-fill').style.width=`${Math.min(100,(xp/needed)*100)}%`;
  const neonPoints=$('account-neon-points');if(neonPoints)neonPoints.textContent=`${Math.max(0,Number(account.neonPoints)||0).toLocaleString('en-US')} NP`;
}
function setAccountSession(token,account){
  state.authToken=token||'';state.account=account||null;
  try{if(state.authToken)localStorage.setItem(AUTH_TOKEN_KEY,state.authToken);else localStorage.removeItem(AUTH_TOKEN_KEY);}catch{}
  renderAccountPanel();
}
async function loadStoredAccount(){
  const token=state.authToken;
  if(!token){renderAccountPanel();return;}
  try{
    const response=await fetch('/api/account/me',{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});
    const data=await response.json().catch(()=>({}));
    // Ignore stale network responses if the player logged in/out while this request was in flight.
    if(state.authToken!==token)return;
    if(response.ok&&data.account){state.account=data.account;renderAccountPanel();}
    else if(response.status===401){setAccountSession('',null);accountMessage('account-auth-message',data.error||'다시 로그인해 주세요.','error');}
    else if(response.status===503){accountMessage('account-auth-message',data.error||'계정 저장소가 준비되지 않았습니다.','error');}
    else if(!response.ok){accountMessage('account-auth-message',data.error||'계정 정보를 불러오지 못했습니다.','error');}
  }catch{if(state.authToken===token)accountMessage('account-auth-message','서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.','error');}
}
async function submitAccountAuth(event){
  event.preventDefault();
  const submitButton=$('account-auth-submit');
  if(submitButton?.disabled)return;
  if(submitButton)submitButton.disabled=true;
  const username=$('account-username').value.trim(),password=$('account-password').value;
  const requestedMode=state.accountMode;
  accountMessage('account-auth-message','처리 중입니다…');
  const route=requestedMode==='register'?'/api/account/register':'/api/account/login';
  try{
    const response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password}),cache:'no-store'});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data.token||!data.account){accountMessage('account-auth-message',data.error||'계정 요청에 실패했습니다.', 'error');return;}
    setAccountSession(data.token,data.account);state.xpLoginNoticeShown=false;$('account-password').value='';
    accountMessage('account-profile-message',requestedMode==='register'?'회원가입 완료! 계정과 XP가 저장됩니다.':'로그인 성공! 저장된 레벨과 XP를 불러왔습니다.','success');
    showToast(`${data.account.username} 로그인 완료 · LV.${data.account.level}`,2200);
  }catch{accountMessage('account-auth-message','서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.','error');}
  finally{if(submitButton)submitButton.disabled=false;}
}
async function logoutAccount(){
  const token=state.authToken;
  try{if(token)await fetch('/api/account/logout',{method:'POST',headers:{Authorization:`Bearer ${token}`},cache:'no-store'});}catch{}
  setAccountSession('',null);accountMessage('account-auth-message','로그아웃했습니다. 다시 로그인하면 저장된 진행도를 불러옵니다.','success');showToast('로그아웃했습니다.');
}
function awardTrainingXP(){
  // Capture the owning account at the kill event; queued awards must never leak into a newly logged-in account.
  const tokenAtKill=getAuthToken();
  if(!tokenAtKill){if(!state.xpLoginNoticeShown){state.xpLoginNoticeShown=true;showToast('훈련 XP를 저장하려면 계정 탭에서 로그인하세요.',2600);}return Promise.resolve();}
  // Serialize target awards so fast multi-target practice cannot lose XP to the server cooldown.
  trainingXpQueue = trainingXpQueue.catch(()=>{}).then(async()=>{
    for(let attempt=0;attempt<4;attempt++){
      try{
        const response=await fetch('/api/account/xp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${tokenAtKill}`},body:JSON.stringify({reason:'training_hit'}),cache:'no-store'});
        const data=await response.json().catch(()=>({}));
        if(response.status===429&&attempt<3){const wait=Math.max(150,Math.min(3000,Number(data.retryAfterMs)||1000));await new Promise(resolve=>setTimeout(resolve,wait));continue;}
        // If this token is no longer the active login, don't overwrite or clear the new player's session/profile.
        if(state.authToken!==tokenAtKill)return;
        if(response.ok&&data.account){state.account=data.account;if(state.lobbyPage==='account')renderAccountPanel();if(['shop','skins','quests'].includes(state.lobbyPage))renderStoreCurrentPage();if(data.questReward)showToast(`훈련 계약 완료! +${data.questReward} 네온 포인트`,2200);else showToast(`훈련 보상 +${data.awardedXP||10} XP · LV.${state.account.level}`,950);}
        else if(response.status===401){setAccountSession('',null);showToast('로그인 세션이 만료됐어요. 계정 탭에서 다시 로그인하세요.',2400);}
        else if(!response.ok)console.warn('[xp] training award rejected:',data.error||response.status);
        return;
      }catch(error){console.warn('[xp] training award failed',error);return;}
    }
  });
  return trainingXpQueue;
}
function applyAccountUpdated(payload){const account=payload?.account||payload;if(account&&account.username&&state.account&&Number(account.id)===Number(state.account.id)){state.account=account;if(state.lobbyPage==='account')renderAccountPanel();if(['shop','skins','quests'].includes(state.lobbyPage))renderStoreCurrentPage();}}
function skinPreviewMarkup(skin){
  return `<div class="store-skin-art theme-${skin.theme}"><span class="store-skin-model"><i></i><b></b><em></em></span><small>${skin.weaponId.toUpperCase()}</small></div>`;
}
function setStoreFeedback(message,type=''){
  const el=$('store-feedback');if(!el)return;el.textContent=message||'';el.classList.toggle('error',type==='error');el.classList.toggle('success',type==='success');
}
function storeAuthRequired(){
  if(state.account&&getAuthToken())return true;
  setStoreFeedback('상점·스킨·퀘스트 진행도를 저장하려면 계정에 로그인하세요.','error');
  showToast('먼저 계정 탭에서 로그인하세요.',1800);
  return false;
}
async function storeRequest(route, body=null){
  if(!getAuthToken())throw new Error('계정에 로그인해야 이용할 수 있습니다.');
  const options={method:body===null?'GET':'POST',headers:{Authorization:`Bearer ${getAuthToken()}`,'Cache-Control':'no-cache'},cache:'no-store'};
  if(body!==null){options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
  const response=await fetch(route,options);const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||'요청에 실패했습니다.');
  if(data.account){state.account=data.account;if(state.lobbyPage==='account')renderAccountPanel();}
  return data;
}
async function refreshStoreState({silent=false}={}){
  if(!getAuthToken()||!state.account){
    if(!silent)setStoreFeedback('계정에 로그인해야 네온 포인트와 스킨을 이용할 수 있습니다.','error');
    renderStoreCurrentPage();return;
  }
  try{
    const data=await storeRequest('/api/store/state');
    storeState={dailySkinIds:Array.isArray(data.dailySkinIds)?data.dailySkinIds:[],dailyDate:String(data.dailyDate||''),rollCost:Number(data.rollCost)||STORE_ROLL_COST};
    renderStoreCurrentPage();
  }catch(error){if(!silent)setStoreFeedback(error.message,'error');}
}
function renderStoreCurrentPage(){
  const points=Math.max(0,Number(state.account?.neonPoints)||0).toLocaleString('en-US');
  if($('store-neon-points'))$('store-neon-points').textContent=`${points} NP`;
  if($('skins-neon-points'))$('skins-neon-points').textContent=`${points} NP`;
  if($('store-daily-date'))$('store-daily-date').textContent=storeState.dailyDate?`RESET ${storeState.dailyDate}`:'TODAY';
  if(state.lobbyPage==='shop')renderShopPage();
  if(state.lobbyPage==='skins')renderOwnedSkins();
  if(state.lobbyPage==='quests')renderQuestPanel();
}
function renderShopPage(){
  const bundles=$('store-bundle-grid'),daily=$('store-daily-grid');if(!bundles||!daily)return;
  const owned=new Set(state.account?.ownedSkins||[]);const loggedIn=!!state.account&&!!getAuthToken();
  bundles.innerHTML=STORE_BUNDLES.map((bundle,index)=>{
    const alreadyOwned=bundle.skinIds.every(id=>owned.has(id));
    const count=bundle.skinIds.filter(id=>!owned.has(id)).length;
    return `<article class="store-bundle-card bundle-${bundle.theme} ${index===0?'bundle-featured':''}"><div class="bundle-ribbon">${index===0?'FEATURED LIMITED BUNDLE':'LIMITED DROP'}</div><div class="bundle-visual">${bundle.skinIds.slice(0,index===0?4:3).map(id=>{const skin=getStoreSkin(id);return `<span class="bundle-mini theme-${skin?.theme||'classic'}">${skin?.weaponId==='knife'?'◈':skin?.weaponId==='sniper'?'⌁':'▰'}</span>`;}).join('')}</div><div class="bundle-copy"><small>${bundle.name}</small><h3>${bundle.displayName}</h3><p>${bundle.description}</p><div class="bundle-price">${bundle.price.toLocaleString('en-US')} <span>NP</span></div><button class="store-primary-button" data-bundle-purchase="${bundle.id}" ${!loggedIn||alreadyOwned?'disabled':''}>${alreadyOwned?'전부 보유 중':`번들 구매 · ${count}개 획득`} <span>↗</span></button></div></article>`;
  }).join('');
  const dailyIds=storeState.dailySkinIds||[];
  daily.innerHTML=dailyIds.length?dailyIds.map(id=>{
    const skin=getStoreSkin(id);if(!skin)return '';
    const has=owned.has(skin.id);
    return `<article class="daily-skin-card rarity-${skin.rarity}">${skinPreviewMarkup(skin)}<div class="daily-skin-copy"><small>${skin.rarity.toUpperCase()} · ${skin.weaponId.toUpperCase()}</small><b>${skin.displayName}</b><span>${skin.price} NP</span><button data-daily-purchase="${skin.id}" ${!loggedIn||has?'disabled':''}>${has?'보유 중':'구매하기'}</button></div></article>`;
  }).join(''):'<div class="store-empty-message">로그인하면 오늘의 스킨 3종을 불러옵니다.</div>';
  if(!loggedIn)setStoreFeedback('계정에 로그인해야 번들 구매, 스킨 뽑기, 코드 사용이 가능합니다.');
}
function renderOwnedSkins(){
  const grid=$('owned-skins-grid'),empty=$('skins-empty-state');if(!grid||!empty)return;
  const owned=new Set(state.account?.ownedSkins||[]);const ids=[...owned].map(id=>getStoreSkin(id)).filter(Boolean);
  grid.innerHTML='';empty.classList.toggle('hidden',ids.length>0||!state.account);grid.classList.toggle('hidden',!ids.length);
  if(!state.account){empty.classList.remove('hidden');empty.querySelector('h3').textContent='로그인이 필요합니다';empty.querySelector('p').textContent='계정 탭에서 로그인하면 모든 기기에서 보유 스킨을 불러옵니다.';return;}
  empty.querySelector('h3').textContent='아직 보유한 스킨이 없습니다';empty.querySelector('p').textContent='상점에서 번들을 구매하거나 보급 상자를 열어 첫 스킨을 획득하세요.';
  for(const skin of ids){
    const equipped=state.account.equippedSkins?.[skin.weaponId]===skin.id;
    const card=document.createElement('article');card.className=`owned-skin-card rarity-${skin.rarity}`;
    card.innerHTML=`${skinPreviewMarkup(skin)}<div class="owned-skin-copy"><small>${skin.rarity.toUpperCase()} · ${skin.weaponId.toUpperCase()}</small><b>${skin.displayName}</b><p>${skin.description}</p><div class="owned-skin-actions"><button data-equip-skin="${skin.id}" ${equipped?'disabled':''}>${equipped?'장착 중':'장착하기'}</button><button class="subtle" data-unequip-weapon="${skin.weaponId}" ${!equipped?'disabled':''}>기본 외형</button></div></div>`;
    grid.append(card);
  }
}
function renderQuestPanel(){
  const account=state.account;const progress=Math.max(0,Number(account?.trainingQuestProgress)||0);const label=$('quest-progress-label');
  if(label)label.textContent=`${progress} / ${TRAINING_QUEST_TARGET}`;
  const fill=$('quest-progress-fill');if(fill)fill.style.width=`${Math.min(100,progress/TRAINING_QUEST_TARGET*100)}%`;
  const copy=$('quest-progress-copy');if(copy)copy.textContent=account?`완료까지 ${TRAINING_QUEST_TARGET-progress}개 · 완료 시 +${TRAINING_QUEST_REWARD} NP · 반복 가능`:'진행도를 계정에 저장하려면 계정 탭에서 로그인하세요.';
}
async function buyStoreProduct(productType,productId){
  if(storeBusy)return;if(!storeAuthRequired())return;storeBusy=true;
  try{const data=await storeRequest('/api/store/buy',{productType,productId});setStoreFeedback(`${data.productName} 구매 완료 · ${data.cost} NP 사용`,'success');showToast(`${data.purchasedSkinIds.length}개 스킨을 획득했습니다.`,1900);renderStoreCurrentPage();}
  catch(error){setStoreFeedback(error.message,'error');showToast(error.message,2200);}
  finally{storeBusy=false;}
}
async function redeemStoreCode(event){
  event?.preventDefault();if(storeBusy)return;if(!storeAuthRequired())return;const input=$('store-code-input');const code=input?.value.trim()||'';if(!code){setStoreFeedback('코드를 입력하세요.','error');return;}storeBusy=true;
  try{const data=await storeRequest('/api/store/redeem',{code});setStoreFeedback(data.message||`+${data.reward} NP 지급 완료`,'success');showToast(`+${Number(data.reward||0).toLocaleString('en-US')} 네온 포인트`,2200);if(input)input.value='';renderStoreCurrentPage();}
  catch(error){setStoreFeedback(error.message,'error');}
  finally{storeBusy=false;}
}
async function equipOwnedSkin(skinId,weaponId=null){
  if(storeBusy||!storeAuthRequired())return;const skin=getStoreSkin(skinId);if(!skin&&!weaponId)return;const targetWeapon=weaponId||skin.weaponId;storeBusy=true;
  try{const data=await storeRequest('/api/store/equip',{weaponId:targetWeapon,skinId:skinId||''});setStoreFeedback(data.equippedSkinId?`${skin.displayName} 장착 완료`:'기본 외형으로 변경했습니다.','success');if(state.mode!=='menu'&&targetWeapon===state.currentWeapon)buildGun(state.currentWeapon);renderStoreCurrentPage();showToast(data.equippedSkinId?'스킨 장착 완료':'기본 외형으로 변경',1200);}
  catch(error){setStoreFeedback(error.message,'error');showToast(error.message,1900);}
  finally{storeBusy=false;}
}
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function rollStoreSkin(){
  if(gachaRequestBusy)return;if(!storeAuthRequired())return;
  if((Number(state.account?.neonPoints)||0)<STORE_ROLL_COST){showToast(`네온 포인트 ${STORE_ROLL_COST} NP가 필요합니다.`);return;}
  gachaRequestBusy=true;const overlay=$('gacha-overlay'),stage=$('gacha-stage'),finish=$('gacha-finish');
  overlay.classList.remove('hidden');stage.classList.remove('revealed');stage.classList.add('playing');overlay.classList.add('playing');finish.disabled=true;finish.textContent='신호 전송 중…';$('gacha-phase-label').textContent='지구에서 보급 신호를 전송합니다';$('gacha-title').textContent='보급 신호를 기다리는 중';$('gacha-copy').textContent='궤도 수송선이 신호를 수신하고 보급 상자를 투하합니다.';$('gacha-reveal-card').classList.add('hidden');
  try{
    const pending=storeRequest('/api/store/roll');
    await delay(900);$('gacha-phase-label').textContent='궤도 수송선이 신호를 수신했습니다';
    await delay(1500);$('gacha-phase-label').textContent='보급 상자 대기권 진입';
    await delay(1550);const data=await pending;await refreshStoreState({silent:true});
    stage.classList.remove('playing');stage.classList.add('revealed');const card=$('gacha-reveal-card');card.classList.remove('hidden');card.className=`gacha-reveal-card rarity-${data.skin.rarity}`;card.innerHTML=`${skinPreviewMarkup(data.skin)}<small>${data.skin.rarity.toUpperCase()} DROP</small><b>${data.skin.displayName}</b><p>${data.skin.description}</p>`;
    $('gacha-phase-label').textContent='보급품 확보 완료';$('gacha-title').textContent='스킨을 획득했습니다!';$('gacha-copy').textContent='획득한 스킨은 계정에 저장되었습니다. 스킨 메뉴에서 장착할 수 있습니다.';finish.disabled=false;finish.textContent='확인';renderStoreCurrentPage();
  }catch(error){stage.classList.remove('playing');$('gacha-title').textContent='보급 요청 실패';$('gacha-copy').textContent=error.message;finish.disabled=false;finish.textContent='닫기';}
  finally{gachaRequestBusy=false;}
}
function closeGacha(){const overlay=$('gacha-overlay');if(!overlay)return;overlay.classList.add('hidden');overlay.classList.remove('playing');$('gacha-stage')?.classList.remove('playing','revealed');}

function renderLobbyWeapons(){
  const grid=$('lobby-weapon-cards');if(!grid)return;grid.innerHTML='';
  const selected=WEAPON_BY_ID[state.lobbySelectedWeapon]||WEAPON_BY_ID.rifle;
  $('showcase-weapon-name').textContent=selected.name;$('showcase-weapon-desc').textContent=selected.desc;$('showcase-power').textContent=selected.damage;$('showcase-control').textContent=`${selected.control} / 10`;$('showcase-mag').textContent=selected.mag;
  const model=$('lobby-weapon-showcase')?.querySelector('.weapon-showcase-model');if(model){model.className=`weapon-showcase-model ${selected.id}-showcase`;model.style.setProperty('--showcase-color',`#${selected.color.toString(16).padStart(6,'0')}`);}
  updateWeaponPreview(selected.id);
  for(const w of WEAPONS){
    const button=document.createElement('button');button.className='lobby-weapon-card'+(state.lobbySelectedWeapon===w.id?' selected':'');
    button.innerHTML=`<span class="weapon-card-index">${String(WEAPONS.indexOf(w)+1).padStart(2,'0')} / ${w.type}</span><span class="weapon-mini-stage ${w.id}-showcase"><span class="weapon-mini-model" style="--showcase-color:#${w.color.toString(16).padStart(6,'0')}"><i></i><b></b><em></em><span></span></span></span><b>${w.name}</b><small>${w.desc}</small><span class="weapon-card-stats"><em>DMG ${w.damage}</em><em>${w.slot==='melee'?'MELEE':`MAG ${w.mag}`}</em></span>`;
    button.addEventListener('click',()=>{state.lobbySelectedWeapon=w.id;renderLobbyWeapons();});grid.append(button);
  }
}
function getSpawn(mapId=state.mapId,side=0){const z=MAP_META[mapId]?.spawn??27;return {x:side===0?-3:3,z:side===0?z:-z,yaw:side===0?0:Math.PI};}
function getGroundHeight(x,z){
  for(const p of elevatedPlatforms){if(x>=p.xMin&&x<=p.xMax&&z>=p.zMin&&z<=p.zMax)return p.height;}
  for(const r of stairRamps){if(x>=r.xMin&&x<=r.xMax&&z>=r.zMin&&z<=r.zMax)return THREE.MathUtils.clamp(((r.zMax-z)/(r.zMax-r.zMin))*r.height,0,r.height);}
  return 0;
}
const gunRoot = new THREE.Group(); camera.add(gunRoot); scene.add(camera);
let muzzleMesh = null;
const weaponModelSources = new Map();
const skinWeaponModelSources = new Map();
const weaponModelLoader = new GLTFLoader();
const WEAPON_MODEL_BASE_URL = '/models/weapons/';
const SKIN_MODEL_CONFIG = {
  prime_knife: { weaponId: 'knife', url: '/models/skins/prime1-karambit.glb', scale: .43, remoteScale: .23, inspect: 'karambit-spin' },
};
function getWeaponModelSource(weaponId, skinId = null) {
  return (skinId && skinWeaponModelSources.get(skinId)) || weaponModelSources.get(weaponId) || null;
}
const WEAPON_MODEL_CONFIG = {
  pistol:   { scale: .40, remoteScale: .25, offset: [.32, -.23, -.58] },
  revolver: { scale: .38, remoteScale: .24, offset: [.32, -.23, -.58] },
  smg:      { scale: .30, remoteScale: .19, offset: [.32, -.23, -.58] },
  shotgun:  { scale: .30, remoteScale: .19, offset: [.32, -.23, -.58] },
  rifle:    { scale: .28, remoteScale: .18, offset: [.32, -.23, -.58] },
  dmr:      { scale: .27, remoteScale: .17, offset: [.32, -.23, -.58] },
  sniper:   { scale: .23, remoteScale: .15, offset: [.32, -.23, -.58] },
  lmg:      { scale: .26, remoteScale: .17, offset: [.32, -.23, -.58] },
  burst:    { scale: .29, remoteScale: .18, offset: [.32, -.23, -.58] },
  knife:    { scale: .43, remoteScale: .23, offset: [.32, -.27, -.60] },
};
let weaponPreviewRenderer = null;
let weaponPreviewScene = null;
let weaponPreviewCamera = null;
let weaponPreviewModelRoot = null;
let weaponPreviewCurrentId = null;
let weaponPreviewLastSize = { width: 0, height: 0 };

// Clone GLB assets per player/viewmodel so each instance can animate and dispose
// safely without mutating the shared loader cache. Generated models are optional;
// the in-code procedural weapon remains as a fallback if an asset fails to load.
function cloneModelForGame(source) {
  const clone = source.clone(true);
  clone.traverse(object => {
    if (!object.isMesh) return;
    if (object.geometry) object.geometry = object.geometry.clone();
    if (object.material) object.material = Array.isArray(object.material)
      ? object.material.map(material => material.clone())
      : object.material.clone();
    object.castShadow = false;
    object.receiveShadow = false;
    object.frustumCulled = true;
    object.userData.noHitbox = true;
  });
  return clone;
}

function disposeWeaponModel(model) {
  if (!model) return;
  model.traverse(object => {
    object.geometry?.dispose();
    const mats = Array.isArray(object.material) ? object.material : (object.material ? [object.material] : []);
    for (const material of mats) material.dispose?.();
  });
}

function ensureWeaponPreviewRenderer() {
  const canvasPreview = $('weapon-preview-canvas');
  if (!canvasPreview || state.lobbyPage !== 'weapons') return false;
  const width = Math.max(1, canvasPreview.clientWidth);
  const height = Math.max(1, canvasPreview.clientHeight);
  if (!weaponPreviewRenderer) {
    try {
      weaponPreviewRenderer = new THREE.WebGLRenderer({ canvas: canvasPreview, alpha: true, antialias: state.device !== 'mobile', powerPreference: 'low-power' });
      weaponPreviewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
      weaponPreviewRenderer.outputColorSpace = THREE.SRGBColorSpace;
      weaponPreviewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
      weaponPreviewRenderer.toneMappingExposure = 1.18;
      weaponPreviewRenderer.setClearColor(0x000000, 0);
      weaponPreviewScene = new THREE.Scene();
      weaponPreviewCamera = new THREE.PerspectiveCamera(34, width / height, .05, 40);
      weaponPreviewCamera.position.set(.28, .48, 3.7);
      weaponPreviewCamera.lookAt(0, 0, 0);
      weaponPreviewScene.add(new THREE.HemisphereLight(0xbfe7ff, 0x15212d, 2.1));
      const key = new THREE.DirectionalLight(0xe6f5ff, 2.8); key.position.set(-2.5, 3.5, 4); weaponPreviewScene.add(key);
      const rim = new THREE.PointLight(0x36f5df, 14, 8); rim.position.set(1.5, .7, -1.8); weaponPreviewScene.add(rim);
      const fill = new THREE.PointLight(0x658dff, 7, 7); fill.position.set(-2, -1, 2); weaponPreviewScene.add(fill);
    } catch (error) {
      console.warn('[NEON STRIKE] 3D armory preview unavailable; in-game weapon models still work.', error);
      weaponPreviewRenderer = null;
      return false;
    }
  }
  if (width !== weaponPreviewLastSize.width || height !== weaponPreviewLastSize.height) {
    weaponPreviewRenderer.setSize(width, height, false);
    weaponPreviewCamera.aspect = width / height;
    weaponPreviewCamera.updateProjectionMatrix();
    weaponPreviewLastSize = { width, height };
  }
  return true;
}

function updateWeaponPreview(weaponId) {
  weaponPreviewCurrentId = weaponId;
  if (state.lobbyPage !== 'weapons' || !ensureWeaponPreviewRenderer()) return;
  const equippedSkinId = state.account?.equippedSkins?.[weaponId] || null;
  const source = getWeaponModelSource(weaponId, equippedSkinId);
  if (!source) return; // The asset loader will call this again once the model arrives.
  if (weaponPreviewModelRoot) {
    weaponPreviewScene.remove(weaponPreviewModelRoot);
    disposeWeaponModel(weaponPreviewModelRoot);
    weaponPreviewModelRoot = null;
  }
  const model = cloneModelForGame(source);
  model.name = `ARMORY_PREVIEW_${weaponId.toUpperCase()}`;
  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  const dimensions = bounds.getSize(new THREE.Vector3());
  const largest = Math.max(dimensions.x, dimensions.y, dimensions.z, .01);
  const scale = 2.35 / largest;
  model.position.copy(center).multiplyScalar(-1);
  const wrapper = new THREE.Group();
  wrapper.name = 'ARMORY_PREVIEW_ROTATING_ROOT';
  wrapper.scale.setScalar(scale);
  wrapper.rotation.set(.10, -.24, -.035);
  wrapper.add(model);
  weaponPreviewScene.add(wrapper);
  weaponPreviewModelRoot = wrapper;
}

function resizeWeaponPreview() {
  if (weaponPreviewRenderer && state.lobbyPage === 'weapons') ensureWeaponPreviewRenderer();
}

function applyWeaponSkinVisual(model, skinId, weaponId) {
  const skin=getStoreSkin(skinId);
  if(!skin||!model)return;
  const palettes={
    classic:{base:0x7c8791,dark:0x242c32,accent:0xabb9c4,emissive:0x000000,metal:0.82,rough:.36},
    'halloween-candy':{base:0xf0eee2,dark:0x284b45,accent:0x68e5cf,emissive:0x2a8c83,metal:.42,rough:.28},
    'halloween-ghost':{base:0xe8f0ee,dark:0x87979a,accent:0xbceee7,emissive:0x6bc4c0,metal:.28,rough:.62},
    'halloween-pumpkin':{base:0xd66d25,dark:0x283b24,accent:0xffb83d,emissive:0x8e3d11,metal:.5,rough:.34},
    'prime-gold':{base:0xd9ad45,dark:0x392c15,accent:0xffe8a0,emissive:0x9b6515,metal:.94,rough:.2},
  };
  const palette=palettes[skin.theme];
  if(!palette)return;
  let meshIndex=0;
  model.traverse(object=>{
    if(!object.isMesh)return;
    const name=String(object.name||'').toUpperCase();
    const grip=/GRIP|HANDLE|MAGAZINE|STOCK|GUARD/.test(name);
    const luminous=/LIGHT|ACCENT|CORE|STRIPE|EMISSIVE/.test(name);
    const chosen=grip?palette.dark:luminous?palette.accent:palette.base;
    const materials=Array.isArray(object.material)?object.material:[object.material];
    for(const material of materials){
      if(!material)continue;
      if(material.color)material.color.setHex(chosen);
      if(material.emissive)material.emissive.setHex(luminous?palette.emissive:0x000000);
      if('emissiveIntensity' in material)material.emissiveIntensity=luminous?1.15:0;
      if('metalness' in material)material.metalness=grip?.5:palette.metal;
      if('roughness' in material)material.roughness=grip?.54:palette.rough;
      if(skin.theme==='halloween-ghost'&&'transparent' in material&&!grip){material.transparent=true;material.opacity=.86;material.depthWrite=false;}
      material.needsUpdate=true;
    }
    // Add light-weight theme accessories so Halloween / Prime models read differently at a glance.
    if(meshIndex===0&&skin.theme==='halloween-candy'){
      const candy=new THREE.Mesh(new THREE.SphereGeometry(.105,12,8),new THREE.MeshStandardMaterial({color:0xf5efe0,roughness:.28,metalness:.15,emissive:0x2c786c,emissiveIntensity:.4}));
      candy.name='SKIN_CANDY_ORB';candy.position.set(.02,.11,.02);candy.scale.set(1,.78,1);candy.userData.noHitbox=true;object.add(candy);
    } else if(meshIndex===0&&skin.theme==='halloween-pumpkin'){
      const pumpkin=new THREE.Mesh(new THREE.SphereGeometry(.105,10,8),new THREE.MeshStandardMaterial({color:0xf17a26,roughness:.45,metalness:.12,emissive:0x752a0a,emissiveIntensity:.3}));
      pumpkin.name='SKIN_PUMPKIN_ORB';pumpkin.position.set(-.01,.10,.02);pumpkin.scale.set(1,.85,1);pumpkin.userData.noHitbox=true;object.add(pumpkin);
    }
    meshIndex++;
  });
  model.userData.skinId=skin.id;
}

function applyProceduralSkinPalette(weaponId, mainMat, darkMat, accentMat) {
  const skin=getStoreSkin(state.account?.equippedSkins?.[weaponId]);if(!skin)return;
  const palette={
    classic:[0x87919a,0x252c32,0xc2cbd2],
    'halloween-candy':[0xf3ede2,0x31564d,0x75e5d1],
    'halloween-ghost':[0xe5efec,0x849393,0xc4f3ed],
    'halloween-pumpkin':[0xd97026,0x263b24,0xffb941],
    'prime-gold':[0xdcb24b,0x392a14,0xffe5a0],
  }[skin.theme];
  if(!palette)return;
  mainMat.color.setHex(palette[0]);darkMat.color.setHex(palette[1]);accentMat.color.setHex(palette[2]);
  mainMat.metalness=skin.theme==='classic'?.84:skin.theme==='prime-gold'?.95:.45;
  accentMat.emissive.setHex(skin.theme==='prime-gold'?0x8e5b12:skin.theme==='classic'?0x000000:0x288a80);
  accentMat.emissiveIntensity=skin.theme==='classic'?.05:.75;
}

function applyCustomWeaponModel(weaponId) {
  const equippedSkinId = state.account?.equippedSkins?.[weaponId] || null;
  const source = getWeaponModelSource(weaponId, equippedSkinId);
  const config = WEAPON_MODEL_CONFIG[weaponId];
  if (!source || !config || state.currentWeapon !== weaponId) return false;
  const fallbackParts = gunRoot.userData.proceduralWeaponChildren || [];
  // Hide the procedural silhouette but keep its small muzzle flash visible.
  for (const child of fallbackParts) child.visible = child === muzzleMesh;
  const old = gunRoot.userData.customWeaponModel;
  if (old) {
    gunRoot.remove(old);
    disposeWeaponModel(old);
  }
  const model = cloneModelForGame(source);
  model.name = `NEON_${weaponId.toUpperCase()}_VIEWMODEL`;
  model.position.set(...config.offset);
  // Exported assets use local +X as the barrel direction and -Y as the grip direction.
  model.rotation.set(0, Math.PI / 2, 0);
  model.scale.setScalar(config.scale);
  applyWeaponSkinVisual(model, state.account?.equippedSkins?.[weaponId], weaponId);
  const magazineNodes = [];
  model.traverse(object => {
    if (!object.isMesh || !(object.name === 'MAGAZINE' || object.name.startsWith('MAGAZINE_'))) return;
    object.userData.basePosition = object.position.clone();
    magazineNodes.push(object);
  });
  if (magazineNodes.length) model.userData.magazineNodes = magazineNodes;
  gunRoot.add(model);
  gunRoot.userData.customWeaponModel = model;
  if (magazineNodes.length) {
    if (gunRoot.userData.reloadMagazine) gunRoot.userData.reloadMagazine.visible = false;
    if (gunRoot.userData.reloadInsertMagazine) gunRoot.userData.reloadInsertMagazine.visible = false;
  }
  return true;
}

function loadWeaponModels() {
  for (const weapon of WEAPONS) {
    const url = `${WEAPON_MODEL_BASE_URL}${weapon.id}.glb`;
    weaponModelLoader.load(url, gltf => {
      weaponModelSources.set(weapon.id, gltf.scene);
      if (state.currentWeapon === weapon.id) applyCustomWeaponModel(weapon.id);
      if (state.lobbyPage === 'weapons' && state.lobbySelectedWeapon === weapon.id) updateWeaponPreview(weapon.id);
      // Replace the procedural weapon currently held by remote players when its GLB arrives.
      for (const remote of state.remotePlayers.values()) {
        if (remote.weapon !== weapon.id) continue;
        unregisterTarget(remote.id);
        buildCharacterWeapon(remote.root, weapon.id, remote.skinId||remote.equippedSkins?.[weapon.id]||null);
        registerTarget(remote.root, remote.id);
      }
      console.info(`[NEON STRIKE] 3D weapon model loaded: ${weapon.id}`);
    }, undefined, error => {
      console.info(`[NEON STRIKE] Model ${weapon.id} unavailable; using procedural fallback.`, error?.message || 'asset unavailable');
    });
  }
  // Special skin models are separate GLB assets so premium skins change the silhouette,
  // not only the material palette. Failed loads safely keep the normal weapon model.
  for (const [skinId, config] of Object.entries(SKIN_MODEL_CONFIG)) {
    weaponModelLoader.load(config.url, gltf => {
      skinWeaponModelSources.set(skinId, gltf.scene);
      if (state.currentWeapon === config.weaponId && state.account?.equippedSkins?.[config.weaponId] === skinId) {
        applyCustomWeaponModel(config.weaponId);
      }
      if (state.lobbyPage === 'weapons' && state.lobbySelectedWeapon === config.weaponId) updateWeaponPreview(config.weaponId);
      for (const remote of state.remotePlayers.values()) {
        const remoteSkin = remote.skinId || remote.equippedSkins?.[config.weaponId] || null;
        if (remote.weapon !== config.weaponId || remoteSkin !== skinId) continue;
        unregisterTarget(remote.id);
        buildCharacterWeapon(remote.root, config.weaponId, skinId);
        registerTarget(remote.root, remote.id);
      }
      console.info(`[NEON STRIKE] 3D skin model loaded: ${skinId}`);
    }, undefined, error => {
      console.warn(`[NEON STRIKE] Skin model ${skinId} unavailable; using base weapon model.`, error?.message || 'asset unavailable');
    });
  }
}
function buildGun(id) {
  if(state.zoomed) setZoom(false);
  for(const child of [...gunRoot.children])child.traverse(object=>{object.geometry?.dispose();if(Array.isArray(object.material))object.material.forEach(material=>material.dispose());else object.material?.dispose();});
  gunRoot.clear();
  const w=WEAPON_BY_ID[id]||WEAPONS[0];
  const weaponVisualRoot = new THREE.Group(); weaponVisualRoot.name = 'procedural-weapon-visual'; gunRoot.add(weaponVisualRoot);
  let buildRoot = weaponVisualRoot;
  const mainMat=new THREE.MeshStandardMaterial({color:w.color,metalness:.7,roughness:.32});
  const darkMat=new THREE.MeshStandardMaterial({color:0x101925,metalness:.55,roughness:.42});
  const accentMat=new THREE.MeshStandardMaterial({color:0x4cf4d5,emissive:0x167e75,emissiveIntensity:1.1,metalness:.4,roughness:.35});
  applyProceduralSkinPalette(id,mainMat,darkMat,accentMat);
  const box=(x,y,z,sx,sy,sz,mat)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),mat);m.position.set(x,y,z);buildRoot.add(m);return m;};
  const cylinder=(x,y,z,r1,r2,len,mat,axis='z')=>{const m=new THREE.Mesh(new THREE.CylinderGeometry(r1,r2,len,10),mat);m.position.set(x,y,z);if(axis==='z')m.rotation.x=Math.PI/2;else m.rotation.z=Math.PI/2;buildRoot.add(m);return m;};
  // Silhouette is deliberately different by weapon family. The knife has its own clean melee silhouette.
  if(id!=='knife')box(.32,-.27,-.60,.20,.17,.56,darkMat);
  if(id==='knife'){
    box(.32,-.29,-.45,.12,.095,.22,darkMat);box(.32,-.235,-.58,.19,.045,.065,accentMat);
    box(.32,-.21,-.77,.08,.04,.22,mainMat);box(.32,-.18,-.50,.035,.025,.15,accentMat);
  } else if(id==='pistol'){
    box(.32,-.22,-.47,.17,.13,.30,mainMat);box(.34,-.34,-.52,.13,.19,.12,darkMat);cylinder(.32,-.23,-.76,.035,.035,.28,mainMat);box(.32,-.17,-.54,.08,.035,.09,accentMat);
  } else if(id==='revolver'){
    box(.32,-.22,-.47,.19,.14,.27,mainMat);box(.34,-.34,-.51,.14,.22,.13,darkMat);cylinder(.32,-.22,-.70,.043,.043,.34,mainMat);cylinder(.32,-.22,-.51,.09,.09,.12,accentMat,'x');box(.32,-.15,-.49,.11,.04,.08,darkMat);box(.32,-.29,-.61,.07,.12,.08,darkMat);
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
  if(w.scopeFov){
    box(.32,-.105,-.60,id==='sniper'?.25:.20,.085,.22,darkMat);
    cylinder(.32,-.055,-.60,id==='sniper'?.072:.055,id==='sniper'?.072:.055,.065,accentMat,'x');
    cylinder(.32,-.055,-.60,id==='sniper'?.056:.042,id==='sniper'?.056:.042,.07,mainMat,'x');
    // Scope glass glows softly in the game's phase-energy palette.
    const lens=new THREE.Mesh(new THREE.CircleGeometry(id==='sniper'?.045:.032,16),new THREE.MeshBasicMaterial({color:0x64fff0,transparent:true,opacity:.6}));lens.position.set(.32,-.055,-.565);lens.rotation.y=Math.PI/2;buildRoot.add(lens);
  }
  // Functional-looking silhouettes: each weapon gets parts associated with its real-world family, recolored for the NEON universe.
  if(id==='pistol'){
    box(.32,-.125,-.53,.17,.045,.26,darkMat);box(.32,-.095,-.43,.035,.045,.06,accentMat);box(.32,-.095,-.70,.035,.045,.07,accentMat);box(.405,-.22,-.49,.018,.055,.25,accentMat);
  }else if(id==='revolver'){
    for(let n=0;n<6;n++){const a=n*Math.PI/3;const port=new THREE.Mesh(new THREE.CylinderGeometry(.018,.018,.012,8),darkMat);port.position.set(.32+Math.cos(a)*.055,-.22+Math.sin(a)*.055,-.515);port.rotation.x=Math.PI/2;buildRoot.add(port);}
    box(.32,-.13,-.40,.11,.07,.08,accentMat);box(.39,-.20,-.40,.08,.04,.10,darkMat);
  }else if(id==='smg'){
    box(.32,-.18,-.28,.25,.07,.18,darkMat);box(.32,-.43,-.59,.12,.22,.14,mainMat);box(.32,-.36,-.81,.13,.11,.09,darkMat);box(.22,-.23,-.68,.08,.13,.12,accentMat);
  }else if(id==='shotgun'){
    cylinder(.27,-.22,-.86,.035,.035,.47,accentMat);box(.32,-.27,-.69,.20,.10,.21,darkMat);box(.32,-.35,-.45,.15,.16,.20,mainMat);
  }else if(id==='rifle'){
    box(.32,-.41,-.63,.13,.20,.15,mainMat);box(.32,-.08,-.55,.16,.06,.13,accentMat);box(.18,-.20,-.57,.06,.14,.18,darkMat);box(.45,-.18,-.38,.16,.09,.17,darkMat);
  }else if(id==='dmr'){
    box(.32,-.39,-.65,.10,.18,.13,mainMat);box(.23,-.44,-.91,.025,.14,.04,accentMat);box(.41,-.44,-.91,.025,.14,.04,accentMat);box(.32,-.02,-.56,.11,.04,.14,darkMat);
  }else if(id==='sniper'){
    box(.32,-.29,-.47,.26,.12,.32,darkMat);box(.32,-.39,-.64,.14,.19,.16,mainMat);box(.20,-.21,-.63,.055,.06,.32,accentMat);box(.44,-.21,-.63,.055,.06,.32,accentMat);cylinder(.32,-.07,-.64,.079,.079,.26,darkMat,'x');
  }else if(id==='lmg'){
    box(.43,-.36,-.58,.24,.19,.24,darkMat);box(.43,-.26,-.58,.20,.045,.20,accentMat);box(.21,-.40,-.86,.045,.15,.12,mainMat);box(.40,-.13,-.48,.13,.07,.10,darkMat);
  }else if(id==='burst'){
    cylinder(.27,-.22,-.89,.025,.025,.42,accentMat);cylinder(.37,-.22,-.89,.025,.025,.42,mainMat);box(.32,-.10,-.56,.20,.09,.20,accentMat);box(.32,-.36,-.61,.13,.15,.18,darkMat);box(.18,-.20,-.58,.05,.18,.15,mainMat);
  }
  if(id==='knife'){
    // Broad angular monomolecular blade: visibly knife-shaped, with a luminous inset edge.
    const bladeShape=new THREE.Shape();bladeShape.moveTo(.24,-.28);bladeShape.lineTo(.13,-.13);bladeShape.lineTo(.055,.10);bladeShape.lineTo(.18,.045);bladeShape.lineTo(.30,-.16);bladeShape.lineTo(.24,-.28);
    const bladeMesh=new THREE.Mesh(new THREE.ShapeGeometry(bladeShape),mainMat);bladeMesh.position.z=-.88;bladeMesh.material.side=THREE.DoubleSide;buildRoot.add(bladeMesh);
    const edgeLine=new THREE.Mesh(new THREE.BoxGeometry(.018,.32,.012),accentMat);edgeLine.position.set(.17,-.065,-.895);edgeLine.rotation.z=.42;buildRoot.add(edgeLine);
    box(.24,-.28,-.86,.15,.035,.06,accentMat);box(.32,-.34,-.56,.105,.20,.14,darkMat);
  }
  if(id!=='knife'){
    box(.32,-.30,-.67,.13,.10,.12,darkMat);
    // Small ejection port and team-status strip.
    box(.205,-.20,-.58,.012,.035,.11,accentMat);
    muzzleMesh=new THREE.Mesh(new THREE.SphereGeometry(.075,8,8),new THREE.MeshBasicMaterial({color:0xffe9a5,transparent:true,opacity:.95}));
    muzzleMesh.position.set(.32,-.23,-1.12);muzzleMesh.visible=false;buildRoot.add(muzzleMesh);
  } else muzzleMesh=null;
  const proceduralWeaponChildren = [...weaponVisualRoot.children];
  buildRoot = gunRoot;
  // First-person forearms and gloves anchor the weapon instead of making it float alone.
  const sleeveMat=new THREE.MeshStandardMaterial({color:0x162738,metalness:.28,roughness:.72});
  const gloveMat=new THREE.MeshStandardMaterial({color:0x111923,metalness:.18,roughness:.64});
  const rightSleeve=box(.43,-.46,-.24,.18,.20,.32,sleeveMat);
  const rightHand=box(.36,-.355,-.48,.14,.09,.15,gloveMat);
  let leftSleeve=null,leftHand=null;
  if(w.slot==='primary'){
    leftSleeve=box(.095,-.50,-.40,.14,.19,.30,sleeveMat);
    leftHand=box(.20,-.355,-.63,.14,.09,.17,gloveMat);
  }else if(w.slot==='sidearm'){
    leftSleeve=box(-.02,-.57,-.34,.14,.18,.22,sleeveMat);leftHand=box(.115,-.45,-.53,.13,.09,.14,gloveMat);leftSleeve.visible=false;leftHand.visible=false;
  }
  let reloadMagazine=null,reloadInsertMagazine=null;
  if(w.slot!=='melee'){
    const magDims=id==='lmg'?[.17,.19,.22]:id==='shotgun'?[.12,.17,.13]:id==='pistol'||id==='revolver'?[.09,.13,.10]:[.12,.17,.13];
    const magX=id==='lmg'?.43:.32,magY=-.405,magZ=id==='pistol'||id==='revolver'?- .52:-.62;
    reloadMagazine=box(magX,magY,magZ,magDims[0],magDims[1],magDims[2],darkMat);
    reloadMagazine.userData.basePosition=reloadMagazine.position.clone();
    reloadInsertMagazine=box(.13,-.64,-.51,magDims[0],magDims[1],magDims[2],darkMat);reloadInsertMagazine.visible=false;reloadInsertMagazine.userData.slotPosition=new THREE.Vector3(magX,magY,magZ);
  }
  for(const handPart of [leftSleeve,leftHand,rightSleeve,rightHand])if(handPart)handPart.userData.baseRotation=handPart.rotation.clone();
  gunRoot.userData={leftSleeve,leftHand,rightSleeve,rightHand,reloadMagazine,reloadInsertMagazine,proceduralWeaponChildren,weaponVisualRoot};
  gunRoot.position.set(0,0,0);gunRoot.rotation.set(0,0,0);
  applyCustomWeaponModel(id);
  state.weaponMotion.drawAt=performance.now();state.weaponMotion.inspectAt=0;state.weaponMotion.fireAt=0;state.weaponMotion.knifeAt=0;
}

function buildCharacterWeapon(root,weaponId='pistol',skinId=null){
  const previous=root.userData.remoteWeaponModel;
  if(previous){root.remove(previous);previous.traverse(o=>{o.geometry?.dispose();if(Array.isArray(o.material))o.material.forEach(m=>m.dispose());else o.material?.dispose();});}
  const w=WEAPON_BY_ID[weaponId]||WEAPON_BY_ID.pistol;
  const customSource = getWeaponModelSource(weaponId, skinId);
  const modelConfig = WEAPON_MODEL_CONFIG[weaponId];
  if (customSource && modelConfig) {
    const customRig = cloneModelForGame(customSource);
    customRig.name = `NEON_${weaponId.toUpperCase()}_REMOTE`;
    customRig.position.set(.20, 1.02, -.31);
    customRig.rotation.set(0, Math.PI / 2, 0);
    customRig.scale.setScalar(modelConfig.remoteScale);
    applyWeaponSkinVisual(customRig, skinId, weaponId);
    customRig.traverse(object => { if (object.isMesh) object.userData.noHitbox = true; });
    root.add(customRig);
    root.userData.remoteWeaponModel = customRig;
    root.userData.remoteWeaponId = weaponId;
    return customRig;
  }
  const rig=new THREE.Group();rig.position.set(.20,.99,-.34);
  const bodyMat=new THREE.MeshStandardMaterial({color:w.color,metalness:.72,roughness:.34});
  const darkMat=new THREE.MeshStandardMaterial({color:0x101923,metalness:.55,roughness:.42});
  const detailMat=new THREE.MeshStandardMaterial({color:0x4be6d0,emissive:0x0c5c58,emissiveIntensity:.8,metalness:.35,roughness:.38});
  const box=(x,y,z,sx,sy,sz,mat)=>{const mesh=new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),mat);mesh.position.set(x,y,z);mesh.castShadow=true;rig.add(mesh);return mesh;};
  const barrel=(x,y,z,r,len,mat)=>{const mesh=new THREE.Mesh(new THREE.CylinderGeometry(r,r,len,8),mat);mesh.rotation.x=Math.PI/2;mesh.position.set(x,y,z);mesh.castShadow=true;rig.add(mesh);return mesh;};
  // The character faces local -Z. All weapon families have a distinct silhouette and point forward.
  if(weaponId==='knife'){
    box(0,-.015,-.12,.08,.08,.18,darkMat);box(0,.025,-.25,.16,.035,.06,detailMat);
    const blade=new THREE.Mesh(new THREE.ConeGeometry(.04,.38,4),bodyMat);blade.rotation.x=-Math.PI/2;blade.position.set(0,.025,-.47);rig.add(blade);
  }else if(weaponId==='pistol'||weaponId==='revolver'){
    box(0,0,-.12,weaponId==='revolver'?.18:.14,.12,.24,bodyMat);
    box(0,-.105,-.105,.095,.19,.09,darkMat);
    barrel(0,.012,-.315,weaponId==='revolver'?.035:.026,.20,bodyMat);
    if(weaponId==='revolver'){const cylinder=new THREE.Mesh(new THREE.CylinderGeometry(.065,.065,.105,10),detailMat);cylinder.rotation.x=Math.PI/2;cylinder.position.set(0,-.015,-.12);rig.add(cylinder);}
  }else{
    const long=weaponId==='sniper'||weaponId==='dmr';
    box(0,0,-.16,weaponId==='lmg'?.24:.19,.15,long?.36:.31,bodyMat);
    box(0,-.105,-.12,.12,.20,.15,darkMat);
    barrel(0,.005,long?-.49:-.42,weaponId==='shotgun'?.043:.025,long?.50:.36,bodyMat);
    if(weaponId==='shotgun')barrel(.075,-.06,-.38,.018,.29,darkMat);
    if(weaponId==='lmg')box(0,-.17,-.18,.17,.13,.22,detailMat);
    if(['rifle','dmr','sniper','burst'].includes(weaponId)){
      box(0,.105,-.19,.11,.06,.16,darkMat);
      if(weaponId==='sniper'||weaponId==='dmr'){
        box(0,.155,-.19,.075,.045,.17,detailMat);barrel(0,.155,-.19,.03,.13,darkMat);
      }
    }
    box(0,-.105,-.25,.09,.17,.10,darkMat);
  }
  box(-.012,.04,-.13,.012,.024,.18,detailMat);
  rig.traverse(object=>{if(object.isMesh)object.userData.noHitbox=true;});
  root.add(rig);root.userData.remoteWeaponModel=rig;root.userData.remoteWeaponId=weaponId;
  return rig;
}

function makeCharacter({color=0x67c9ff, accent=0x143345, onlineId=null, name='BOT'}={}) {
  const root=new THREE.Group();
  const bodyMat=new THREE.MeshStandardMaterial({color,metalness:.42,roughness:.38});
  const accentMat=new THREE.MeshStandardMaterial({color:accent,metalness:.58,roughness:.30});
  const dark=new THREE.MeshStandardMaterial({color:0x101923,metalness:.40,roughness:.54});
  const headMat=new THREE.MeshStandardMaterial({color:0x9cabb7,metalness:.25,roughness:.48});
  const trimMat=new THREE.MeshStandardMaterial({color:0x263e50,metalness:.72,roughness:.26});
  const glowMat=new THREE.MeshStandardMaterial({color:onlineId?0x6ee9ff:0xff5f7c,emissive:onlineId?0x16717f:0x7c1029,emissiveIntensity:1.6,metalness:.35,roughness:.25});
  function part(geo,mat,x,y,z,partName){const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;m.userData.part=partName||'body';root.add(m);return m;}
  function detail(parent,geo,mat,x,y,z,rx=0,ry=0,rz=0){const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);m.rotation.set(rx,ry,rz);m.castShadow=true;m.receiveShadow=true;m.userData.noHitbox=true;parent.add(m);return m;}
  // Core hit volumes are kept simple and authoritative; the extra armor is cosmetic.
  part(new THREE.BoxGeometry(.72,.82,.36),bodyMat,0,1.05,0,'body');
  part(new THREE.BoxGeometry(.78,.16,.4),accentMat,0,1.38,0,'body');
  const head=part(new THREE.SphereGeometry(.225,12,10),headMat,0,1.67,0,'head');head.scale.set(.86,1.02,.86);
  part(new THREE.BoxGeometry(.34,.11,.28),dark,0,1.63,-.10,'head');
  const visor=part(new THREE.BoxGeometry(.28,.055,.035),glowMat,0,1.68,-.204,'head');
  const shoulderL=part(new THREE.IcosahedronGeometry(.155,1),accentMat,-.49,1.20,-.025,'body');shoulderL.scale.set(1.15,.82,1.05);
  const shoulderR=part(new THREE.IcosahedronGeometry(.155,1),accentMat,.49,1.20,-.025,'body');shoulderR.scale.set(1.15,.82,1.05);
  const arm1=part(new THREE.BoxGeometry(.18,.52,.19),bodyMat,-.39,.94,-.13,'body');arm1.rotation.x=-.62;arm1.rotation.z=-.12;
  const arm2=part(new THREE.BoxGeometry(.18,.52,.19),bodyMat,.39,.94,-.13,'body');arm2.rotation.x=-.62;arm2.rotation.z=.12;
  const leg1=part(new THREE.BoxGeometry(.25,.55,.28),dark,-.19,.35,0,'legs');
  const leg2=part(new THREE.BoxGeometry(.25,.55,.28),dark,.19,.35,0,'legs');
  const pack=part(new THREE.BoxGeometry(.37,.45,.17),accentMat,0,1.1,.23,'body');

  // Armored helmet, brow, cheek plates and illuminated identity strip.
  detail(root,new THREE.BoxGeometry(.39,.14,.34),dark,0,1.815,.005);
  detail(root,new THREE.BoxGeometry(.36,.045,.065),trimMat,0,1.735,-.193);
  detail(root,new THREE.BoxGeometry(.045,.115,.19),accentMat,-.205,1.66,-.075);
  detail(root,new THREE.BoxGeometry(.045,.115,.19),accentMat,.205,1.66,-.075);
  detail(root,new THREE.BoxGeometry(.13,.025,.018),glowMat,0,1.817,-.178);
  detail(root,new THREE.CylinderGeometry(.125,.14,.075,10),trimMat,0,1.47,0);

  // Layered chest plate with a centered ion core and two armored ribs.
  const chest=detail(root,new THREE.IcosahedronGeometry(.30,1),trimMat,0,1.12,-.19);
  chest.scale.set(.92,.84,.36);
  detail(root,new THREE.BoxGeometry(.28,.22,.052),dark,0,1.13,-.294);
  detail(root,new THREE.BoxGeometry(.10,.16,.018),glowMat,0,1.13,-.327);
  detail(root,new THREE.BoxGeometry(.20,.025,.018),accentMat,-.145,1.24,-.287);
  detail(root,new THREE.BoxGeometry(.20,.025,.018),accentMat,.145,1.24,-.287);
  detail(root,new THREE.BoxGeometry(.64,.12,.39),dark,0,.73,0);
  detail(root,new THREE.BoxGeometry(.18,.12,.075),trimMat,-.29,.75,-.225);
  detail(root,new THREE.BoxGeometry(.18,.12,.075),trimMat,.29,.75,-.225);
  detail(root,new THREE.BoxGeometry(.16,.045,.025),glowMat,0,.66,-.204);

  // Shoulder caps, forearm guards and gloves follow their animated limb meshes.
  detail(arm1,new THREE.IcosahedronGeometry(.105,1),trimMat,0,.145,-.035).scale.set(1.05,.75,1.0);
  detail(arm2,new THREE.IcosahedronGeometry(.105,1),trimMat,0,.145,-.035).scale.set(1.05,.75,1.0);
  detail(arm1,new THREE.BoxGeometry(.205,.18,.035),accentMat,0,-.035,-.105);
  detail(arm2,new THREE.BoxGeometry(.205,.18,.035),accentMat,0,-.035,-.105);
  detail(arm1,new THREE.BoxGeometry(.15,.025,.02),glowMat,0,-.06,-.128);
  detail(arm2,new THREE.BoxGeometry(.15,.025,.02),glowMat,0,-.06,-.128);
  detail(arm1,new THREE.BoxGeometry(.19,.105,.20),dark,0,-.205,-.012);
  detail(arm2,new THREE.BoxGeometry(.19,.105,.20),dark,0,-.205,-.012);

  // Segmented thigh/shin plates and low-profile boots move with each leg.
  for(const leg of [leg1,leg2]){
    detail(leg,new THREE.BoxGeometry(.205,.22,.045),accentMat,0,.095,-.153);
    detail(leg,new THREE.BoxGeometry(.17,.15,.035),trimMat,0,-.085,-.164);
    detail(leg,new THREE.BoxGeometry(.14,.022,.015),glowMat,0,.10,-.181);
    detail(leg,new THREE.BoxGeometry(.27,.12,.34),dark,0,-.275,-.005);
    detail(leg,new THREE.BoxGeometry(.20,.025,.03),trimMat,0,-.24,-.17);
  }
  // Backpack power cell and side vents add a readable futuristic silhouette from behind.
  detail(pack,new THREE.BoxGeometry(.23,.27,.06),dark,0,.015,.112);
  detail(pack,new THREE.BoxGeometry(.13,.19,.025),glowMat,0,.015,.15);
  detail(pack,new THREE.BoxGeometry(.055,.28,.035),trimMat,-.145,.02,.105);
  detail(pack,new THREE.BoxGeometry(.055,.28,.035),trimMat,.145,.02,.105);

  root.userData={onlineId,name,parts:[head,visor],legs:[leg1,leg2],arms:[arm1,arm2],bodyMat,accentMat,walkPhase:Math.random()*6,baseBodyY:1.05};
  buildCharacterWeapon(root,'pistol');
  return root;
}

function setTargetId(group,id) { group.traverse(o=>{if(o.isMesh&&!o.userData.noHitbox)o.userData.targetId=id;}); }
function disposeGroup(group) { const disposed=new Set();group.traverse(o=>{if(o.geometry)o.geometry.dispose();const mats=Array.isArray(o.material)?o.material:(o.material?[o.material]:[]);for(const mat of mats){if(mat===hitFlashMaterial||disposed.has(mat))continue;disposed.add(mat);mat.dispose?.();}});scene.remove(group); }

const raycaster = new THREE.Raycaster();
const targetObjects = [];
const hitFlashMaterial = new THREE.MeshStandardMaterial({color:0xff263f, emissive:0xff001f, emissiveIntensity:2.8, metalness:.05, roughness:.48});
function registerTarget(group,id) { setTargetId(group,id); group.traverse(o=>{if(o.isMesh&&!o.userData.noHitbox)targetObjects.push(o);}); }
function flashCharacter(root, duration=135) {
  if (!root) return;
  if (root.userData.hitFlashTimer) clearTimeout(root.userData.hitFlashTimer);
  root.traverse(object => {
    if (!object.isMesh) return;
    if (!Object.hasOwn(object.userData, 'hitFlashOriginal')) object.userData.hitFlashOriginal = object.material;
    object.material = Array.isArray(object.material) ? object.material.map(() => hitFlashMaterial) : hitFlashMaterial;
  });
  root.userData.hitFlashTimer = setTimeout(() => {
    root.traverse(object => {
      if (!object.isMesh || !Object.hasOwn(object.userData, 'hitFlashOriginal')) return;
      object.material = object.userData.hitFlashOriginal;
      delete object.userData.hitFlashOriginal;
    });
    root.userData.hitFlashTimer = null;
  }, duration);
}
function unregisterTarget(id) { for(let i=targetObjects.length-1;i>=0;i--)if(targetObjects[i].userData.targetId===id)targetObjects.splice(i,1); }
function updateRemotePlayer(id,data) {
  if(id===state.socket?.id)return;
  let remote=state.remotePlayers.get(id);
  const weapon=data.weapon||remote?.weapon||'pistol';
  const skinId=data.skinId||data.equippedSkins?.[weapon]||remote?.skinId||null;
  if(!remote){
    const root=makeCharacter({color:0xff6c85,accent:0x52233a,onlineId:id,name:data.name||'OPPONENT'});buildCharacterWeapon(root,weapon,skinId);root.position.set(data.x||0,data.y||0,data.z||0);scene.add(root);registerTarget(root,id);
    remote={id,root,target:new THREE.Vector3(data.x||0,data.y||0,data.z||0),yaw:data.yaw||0,name:data.name||'OPPONENT',hp:data.hp??100,weapon,skinId,equippedSkins:data.equippedSkins||{},walkPhase:Math.random()*6,lastX:data.x||0,lastZ:data.z||0};state.remotePlayers.set(id,remote);
  }
  remote.target.set(data.x||0,data.y||0,data.z||0);remote.yaw=data.yaw||0;remote.name=data.name||remote.name;if(data.hp!=null)remote.hp=data.hp;
  if(data.equippedSkins)remote.equippedSkins=data.equippedSkins;
  if(weapon!==remote.weapon||skinId!==remote.skinId){remote.weapon=weapon;remote.skinId=skinId;buildCharacterWeapon(remote.root,weapon,skinId);}
}
function updateRemoteWeaponModel(id, weaponId, skinId=null){
  const remote=state.remotePlayers.get(id);
  if(!remote||!WEAPON_BY_ID[weaponId])return;
  const nextSkin=skinId||remote.equippedSkins?.[weaponId]||null;
  if(remote.weapon===weaponId&&remote.skinId===nextSkin)return;
  remote.weapon=weaponId;remote.skinId=nextSkin;buildCharacterWeapon(remote.root,weaponId,nextSkin);
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
  initAudio();const ctx=state.audio;if(!ctx)return;const t=ctx.currentTime;
  // Each weapon gets a distinct mechanical crack, low-frequency punch, and NEON STRIKE phase-energy tail.
  const profiles={
    pistol:{low:138,crack:2350,tail:740,lowpass:4200,noise:.24,sub:.17,duration:.13,glint:.045},
    revolver:{low:76,crack:1150,tail:420,lowpass:1900,noise:.30,sub:.34,duration:.22,glint:.085},
    smg:{low:175,crack:3100,tail:1120,lowpass:5200,noise:.19,sub:.12,duration:.095,glint:.025},
    shotgun:{low:54,crack:780,tail:260,lowpass:1150,noise:.50,sub:.42,duration:.25,glint:.07},
    rifle:{low:105,crack:2650,tail:880,lowpass:3800,noise:.31,sub:.24,duration:.16,glint:.055},
    dmr:{low:128,crack:3450,tail:1460,lowpass:5100,noise:.28,sub:.21,duration:.15,glint:.09},
    sniper:{low:43,crack:620,tail:310,lowpass:900,noise:.55,sub:.48,duration:.38,glint:.16},
    lmg:{low:68,crack:1780,tail:540,lowpass:2600,noise:.39,sub:.32,duration:.21,glint:.035},
    burst:{low:205,crack:3900,tail:1850,lowpass:6100,noise:.24,sub:.13,duration:.12,glint:.12},
    knife:{low:360,crack:2500,tail:1250,lowpass:4500,noise:.09,sub:.035,duration:.10,glint:.11},
  };
  const p=profiles[weaponId]||profiles.pistol;
  const tone=(type,f0,f1,vol,dur,delay=0,filterType='lowpass',cutoff=p.lowpass)=>{
    const o=ctx.createOscillator(),g=ctx.createGain(),f=ctx.createBiquadFilter();o.type=type;f.type=filterType;f.frequency.setValueAtTime(cutoff,t+delay);
    o.frequency.setValueAtTime(Math.max(1,f0),t+delay);o.frequency.exponentialRampToValueAtTime(Math.max(1,f1),t+delay+dur*.72);
    g.gain.setValueAtTime(.0001,t+delay);g.gain.exponentialRampToValueAtTime(Math.max(.0002,vol),t+delay+.004);g.gain.exponentialRampToValueAtTime(.0001,t+delay+dur);
    o.connect(f).connect(g).connect(ctx.destination);o.start(t+delay);o.stop(t+delay+dur+.01);
  };
  const transient=(delay,dur,vol,frequency,q=0.8)=>{
    const n=ctx.createBufferSource(),g=ctx.createGain(),f=ctx.createBiquadFilter();n.buffer=state.noiseBuffer;f.type='bandpass';f.frequency.setValueAtTime(frequency,t+delay);f.Q.value=q;
    g.gain.setValueAtTime(.0001,t+delay);g.gain.exponentialRampToValueAtTime(Math.max(.0002,vol),t+delay+.002);g.gain.exponentialRampToValueAtTime(.0001,t+delay+dur);
    n.connect(f).connect(g).connect(ctx.destination);n.start(t+delay);n.stop(t+delay+dur+.01);
  };
  // Low thump + filtered, weapon-specific crack.
  tone(weaponId==='knife'?'triangle':'sawtooth',p.low,p.low*.42,p.sub,p.duration*.95);
  transient(0,.045,p.noise,p.crack,weaponId==='shotgun'?0.5:1.25);
  // A short synthesized energy coil gives the weapons a coherent space-combat identity without making them sound alike.
  tone(weaponId==='sniper'?'sine':'triangle',p.tail,p.tail*(weaponId==='sniper'?.45:.72),p.glint,weaponId==='sniper'?.24:.095,weaponId==='sniper'?.045:.012,'lowpass',p.tail*2.1);
  if(['revolver','shotgun','lmg','sniper'].includes(weaponId))transient(.045,.11,p.noise*.32,p.crack*.58,.55);
  // A fast, quiet mechanical/electromagnetic return click separates the weapon families.
  const clicks={pistol:[1850,.018,.045],revolver:[920,.028,.07],smg:[2450,.012,.025],shotgun:[620,.035,.075],rifle:[1320,.016,.038],dmr:[1780,.014,.045],sniper:[470,.045,.10],lmg:[780,.024,.05],burst:[3200,.012,.035]};
  if(clicks[weaponId]){const [freq,dur,vol]=clicks[weaponId];tone('square',freq,freq*.72,vol,dur,p.duration*.46,'highpass',Math.max(650,freq*.7));}
}
function soundFootstep({volume=.12,remote=false}={}){
  initAudio();const ctx=state.audio;if(!ctx||!state.noiseBuffer)return;const t=ctx.currentTime;
  const n=ctx.createBufferSource(),filter=ctx.createBiquadFilter(),gain=ctx.createGain(),low=ctx.createOscillator(),lg=ctx.createGain();
  n.buffer=state.noiseBuffer;filter.type='lowpass';filter.frequency.value=remote?380:560;
  gain.gain.setValueAtTime(.0001,t);gain.gain.exponentialRampToValueAtTime(Math.max(.001,volume),t+.008);gain.gain.exponentialRampToValueAtTime(.0001,t+.075);
  low.type='sine';low.frequency.setValueAtTime(remote?74:92,t);low.frequency.exponentialRampToValueAtTime(42,t+.06);lg.gain.setValueAtTime(.0001,t);lg.gain.exponentialRampToValueAtTime(volume*.32,t+.005);lg.gain.exponentialRampToValueAtTime(.0001,t+.07);
  n.connect(filter).connect(gain).connect(ctx.destination);low.connect(lg).connect(ctx.destination);n.start(t);n.stop(t+.08);low.start(t);low.stop(t+.08);
}
function soundKnife(){soundShot('knife');}

function soundReload(){initAudio();if(!state.audio)return;const ctx=state.audio,t=ctx.currentTime;[420,250,510].forEach((f,i)=>{const o=ctx.createOscillator(),g=ctx.createGain();o.type='square';o.frequency.value=f;g.gain.setValueAtTime(.0001,t+i*.14);g.gain.exponentialRampToValueAtTime(.055,t+i*.14+.008);g.gain.exponentialRampToValueAtTime(.0001,t+i*.14+.055);o.connect(g).connect(ctx.destination);o.start(t+i*.14);o.stop(t+i*.14+.06);});}
function soundHit(){initAudio();if(!state.audio)return;const c=state.audio,t=c.currentTime;const o=c.createOscillator(),g=c.createGain();o.type='sine';o.frequency.setValueAtTime(850,t);o.frequency.exponentialRampToValueAtTime(1350,t+.04);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.12,t+.006);g.gain.exponentialRampToValueAtTime(.0001,t+.09);o.connect(g).connect(c.destination);o.start(t);o.stop(t+.1);}
function soundKill(){initAudio();if(!state.audio)return;const c=state.audio,t=c.currentTime;[660,990,1320].forEach((f,i)=>{const o=c.createOscillator(),g=c.createGain();o.type='sine';o.frequency.setValueAtTime(f,t+i*.055);o.frequency.exponentialRampToValueAtTime(f*1.25,t+i*.055+.05);g.gain.setValueAtTime(.0001,t+i*.055);g.gain.exponentialRampToValueAtTime(.11,t+i*.055+.008);g.gain.exponentialRampToValueAtTime(.0001,t+i*.055+.17);o.connect(g).connect(c.destination);o.start(t+i*.055);o.stop(t+i*.055+.18);});}
function soundBuy(){initAudio();if(!state.audio)return;const c=state.audio,t=c.currentTime,o=c.createOscillator(),g=c.createGain();o.type='triangle';o.frequency.setValueAtTime(420,t);o.frequency.exponentialRampToValueAtTime(760,t+.07);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.09,t+.008);g.gain.exponentialRampToValueAtTime(.0001,t+.14);o.connect(g).connect(c.destination);o.start(t);o.stop(t+.15);}


function showToast(message,ms=2300){const t=$('toast');t.textContent=message;t.classList.remove('hidden');clearTimeout(state.currentToastTimer);state.currentToastTimer=setTimeout(()=>t.classList.add('hidden'),ms);}
function setMenuStatus(text){$('menu-status').textContent=text;}
function setModeUI(){menu.classList.add('hidden');hud.classList.remove('hidden');buyMenu.classList.add('hidden');pauseMenu.classList.add('hidden');endScreen.classList.add('hidden');state.paused=false;const trainingButton=$('training-weapon-button');if(trainingButton)trainingButton.classList.toggle('hidden',state.mode!=='training');}
function backToMenu(){
  state.fireHeld=false;state.sniperMustRelease=false;
  if(state.localNextRoundTimer){clearTimeout(state.localNextRoundTimer);state.localNextRoundTimer=null;}
  setZoom(false);state.mode='menu';state.phase='menu';state.paused=false;state.keys.clear();state.roomCode='';
  if(document.pointerLockElement)document.exitPointerLock();
  if(state.socket){state.socket.emit('leaveRoom');state.socket.disconnect();state.socket=null;state.socketReady=false;}
  clearRemotePlayers();clearBots();menu.classList.remove('hidden');hud.classList.add('hidden');buyMenu.classList.add('hidden');pauseMenu.classList.add('hidden');endScreen.classList.add('hidden');touchControls.classList.add('hidden');$('training-weapon-button')?.classList.add('hidden');
  $('room-code').value='';setMenuStatus('훈련장에서 자유롭게 사격하거나 친구와 온라인 1대1을 플레이하세요.');
}
function setDevice(device){state.device=device;document.querySelectorAll('[data-device]').forEach(b=>b.classList.toggle('selected',b.dataset.device===device));touchControls.classList.toggle('hidden',device!=='mobile');renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,device==='mobile'?1.25:1.75));renderer.setSize(window.innerWidth,window.innerHeight);}
function setRule(rule){state.rule=rule;document.querySelectorAll('[data-rule]').forEach(b=>b.classList.toggle('selected',b.dataset.rule===rule));}
function setDifficulty(d){state.difficulty=d;document.querySelectorAll('[data-difficulty]').forEach(b=>b.classList.toggle('selected',b.dataset.difficulty===d));}
function hideAllModals(){buyMenu.classList.add('hidden');pauseMenu.classList.add('hidden');endScreen.classList.add('hidden');}

function makeAmmoFor(id,full=true){const w=WEAPON_BY_ID[id];if(!state.ammo[id])state.ammo[id]={mag:w.mag,reserve:w.reserve};if(full){state.ammo[id].mag=w.mag;state.ammo[id].reserve=w.reserve;}}
function currentWeapon(){return WEAPON_BY_ID[state.currentWeapon]||WEAPONS[0];}
function setWeapon(id,notify=false){
  if(!WEAPON_BY_ID[id])return;
  state.fireHeld=false;state.sniperMustRelease=false;state.burstRemaining=0;state.burstNextAt=0;if(state.zoomed)setZoom(false);
  if(!state.owned.has(id)){if(notify)showToast('구매한 무기만 장착할 수 있어요. 구매 단계에서 구입하세요.');return;}
  if(state.mode==='online'){
    if(!state.socketReady||!state.socket){if(notify)showToast('서버에 연결 중입니다.');return;}
    if(id===state.currentWeapon)return;
    state.socket.emit('equipWeapon',{weaponId:id});return;
  }
  state.currentWeapon=id;buildGun(id);updateHUD();if(notify)showToast(`${WEAPON_BY_ID[id].name} 장착`);
}
function updateAmmoHUD(){
  const w=currentWeapon(),a=state.ammo[w.id]||{mag:w.mag,reserve:w.reserve};
  $('ammo-current').textContent=w.slot==='melee'?'—':a.mag;
  $('ammo-reserve').textContent=w.slot==='melee'?'—':a.reserve;
}
function updateHUD(){
  $('health-value').textContent=Math.max(0,Math.ceil(state.hp));$('health-fill').style.width=`${Math.max(0,state.hp)}%`;$('armor-value').textContent=Math.max(0,Math.ceil(state.armor));const armorLabel=$('armor-tier-label');if(armorLabel)armorLabel.textContent=state.armorTier==='heavy'?'HEAVY':state.armorTier==='light'?'LIGHT':'NONE';
  $('money-value').textContent=state.money.toLocaleString('en-US');$('buy-money').textContent=state.money.toLocaleString('en-US');
  const shopAvailable=state.mode!=='menu'&&state.phase==='buy';$('open-buy').classList.toggle('hidden',!shopAvailable);$('touch-buy').classList.toggle('hidden',!shopAvailable);
  const w=currentWeapon();
  $('weapon-class').textContent=w.type;$('weapon-name').textContent=w.name;$('weapon-index').textContent=w.slot==='melee'?'03 / 03':`${w.slot==='primary'?'01':w.id==='pistol'?'02':String(WEAPONS.findIndex(x=>x.id===w.id)+1).padStart(2,'0')} / ${String(WEAPONS.length).padStart(2,'0')}`;
  $('weapon-stat').textContent=w.slot==='melee'?'MELEE / 40 DMG':`CONTROL / ${w.control.toFixed(1)}`;updateAmmoHUD();const ammoLabel=document.querySelector('.ammo-label');if(ammoLabel)ammoLabel.textContent=w.slot==='melee'?'MELEE':'AMMO';
  const bars=$('weapon-stat-bars');bars.querySelectorAll('i').forEach((i,index)=>i.classList.toggle('on',index<Math.max(1,Math.round(w.control/2))));
  $('self-score').textContent=state.selfScore;$('enemy-score').textContent=state.enemyScore;$('round-label').textContent=`ROUND ${String(Math.max(1,state.round)).padStart(2,'0')}`;
  $('net-label').textContent=state.mode==='online'?(state.socketReady?'ONLINE / ROOM '+state.roomCode:'RECONNECTING...'):state.mode==='training'?'TRAINING RANGE':'READY';$('net-dot').classList.toggle('offline',state.mode==='online'&&!state.socketReady);
  $('objective-label').textContent=state.mode==='training'?'SHOOT TARGETS · 100 DAMAGE TO RESET':`FIRST TO 6 ROUNDS · ${state.selfScore}-${state.enemyScore}`;
  renderBuyList();
}

function renderBuyList(){
  const list=$('buy-list');if(!list)return;list.innerHTML='';
  for(const w of WEAPONS){
    if(w.slot==='melee')continue;
    const owned=state.owned.has(w.id),canBuy=w.price===0||state.money>=w.price;
    const card=document.createElement('button');card.className='weapon-card'+(state.currentWeapon===w.id?' equipped':'')+(!canBuy?' cant-afford':'');card.style.setProperty('--gun-color',`#${w.color.toString(16).padStart(6,'0')}`);
    card.innerHTML=`<div class="weapon-art"><div class="weapon-silhouette"></div></div><span class="gun-type">${w.type}</span><strong>${w.name}</strong><div class="gun-price">${w.price===0?'FREE':`◈ ${w.price.toLocaleString('en-US')}`}</div><div class="gun-desc">${w.desc}</div><div class="buy-action">${state.currentWeapon===w.id?'장착 중':owned?'재장착':'구매 / 장착'}</div>`;
    card.disabled=state.phase!=='buy'||(state.mode==='online'&&!state.socketReady)||(!owned&&w.slot==='primary'&&state.buyPrimaryThisRound)||(!owned&&w.price>state.money);
    card.addEventListener('click',()=>buyWeapon(w.id));list.append(card);
  }
  const armors=[
    {tier:'light',name:'LIGHT ARMOR',price:400,value:60,absorb:'35%',desc:'경량 합금 · 보호막 60 · 피해 흡수 35%'},
    {tier:'heavy',name:'HEAVY ARMOR',price:1000,value:110,absorb:'60%',desc:'중량 복합장갑 · 보호막 110 · 피해 흡수 60%'}
  ];
  for(const gear of armors){
    const equipped=state.armorTier===gear.tier;
    const canUpgrade=gear.tier==='heavy'&&state.armorTier==='light';
    const alreadyBetter=gear.tier==='light'&&state.armorTier!=='none';
    const card=document.createElement('button');card.className='weapon-card'+(equipped?' equipped':'')+(state.money<gear.price||alreadyBetter||equipped?' cant-afford':'');
    card.innerHTML=`<div class="weapon-art"><div style="font-size:31px;color:${gear.tier==='heavy'?'#d9a7ff':'#73bdff'};text-shadow:0 0 15px #73bdff80">⬡</div></div><span class="gun-type">DEFENSE / GEAR</span><strong>${gear.name}</strong><div class="gun-price">◈ ${gear.price.toLocaleString('en-US')}</div><div class="gun-desc">${gear.desc}</div><div class="buy-action">${equipped?'보유 중':canUpgrade?'강화 구매':'구매 / 장착'}</div>`;
    card.disabled=state.phase!=='buy'||state.money<gear.price||alreadyBetter||equipped;
    card.addEventListener('click',()=>buyArmor(gear.tier));list.append(card);
  }
}

function buyWeapon(id){
  if(state.phase!=='buy'){showToast('총기는 구매 단계에서만 살 수 있어요.');return;}
  const w=WEAPON_BY_ID[id];if(!w)return;
  if(state.currentWeapon===id){showToast('이미 장착한 무기입니다.');return;}
  if(state.owned.has(id)){setWeapon(id,true);return;}
  if(state.mode==='online'){
    if(!state.socketReady){showToast('서버에 연결 중입니다.');return;}
    state.socket.emit('buy',{kind:'weapon',weaponId:id});return;
  }
  if((w.slot||'primary')==='primary'&&state.buyPrimaryThisRound){showToast('이번 구매 단계에는 주무기 하나만 살 수 있어요.');return;}
  if(state.money<w.price){showToast(`크레딧이 부족합니다. ${w.price.toLocaleString()} CR 필요`);return;}
  if(w.slot==='primary'){state.money-=w.price;state.buyPrimaryThisRound=true;state.owned=new Set([...state.owned].filter(x=>(WEAPON_BY_ID[x]?.slot||'sidearm')==='sidearm').concat(id));}
  else if(id!=='pistol'){state.money-=w.price;state.owned.add(id);}
  makeAmmoFor(id,true);setWeapon(id);soundBuy();$('buy-feedback').textContent=`${w.name} 구매 완료`;updateHUD();
}

function buyArmor(tier='light'){
  if(state.phase!=='buy'){showToast('보호막은 구매 단계에서만 살 수 있습니다.');return;}
  const gear=tier==='heavy'?{cost:1000,value:110,absorb:.60,name:'중량 보호막'}:{cost:400,value:60,absorb:.35,name:'경량 보호막'};
  if(tier==='light'&&state.armorTier!=='none'){showToast('이미 보호막을 보유 중입니다. 중량 보호막으로 강화할 수 있어요.');return;}
  if(tier==='heavy'&&state.armorTier==='heavy'){showToast('이미 중량 보호막을 보유하고 있습니다.');return;}
  if(state.mode==='online'){state.socket.emit('buy',{kind:'armor',tier});return;}
  if(state.money<gear.cost){showToast('크레딧이 부족합니다.');return;}
  state.money-=gear.cost;state.armor=gear.value;state.armorTier=tier;state.armorPurchased=tier==='heavy';soundBuy();$('buy-feedback').textContent=`${gear.name} 장착 완료`;updateHUD();
}
function openBuy(){if(state.phase!=='buy'||state.paused)return;buyMenu.classList.remove('hidden');updateHUD();}
function closeBuy(){buyMenu.classList.add('hidden');}
function startLocalRound(){
  state.round++;state.phase='buy';state.hp=100;if(state.armor<=0)state.armorTier='none';state.velocityY=0;state.owned=new Set(['pistol','knife']);state.currentWeapon='pistol';buildGun('pistol');const spawn=getSpawn(state.mapId,0);state.pos.set(spawn.x,0,spawn.z);state.yaw=spawn.yaw;state.pitch=0;state.phaseEnd=Date.now()+12000;state.roundLimit=state.phaseEnd+90000;
  state.buyPrimaryThisRound=false;state.armorPurchased=state.armorTier==='heavy';state.reloading=false;state.resultShown=false;state.matchOver=false;setZoom(false);
  makeAmmoFor(state.currentWeapon,true);state.botFireTimers=[];clearBots();setModeUI();$('phase-label').textContent='BUY PHASE';$('buy-countdown').textContent='12초';$('buy-feedback').textContent='라운드 시작 전 장비를 구매하세요.';
  updateHUD();openBuy();showToast(`ROUND ${state.round} — 구매 단계`,1800);
}
function startTraining(){
  if(state.localNextRoundTimer){clearTimeout(state.localNextRoundTimer);state.localNextRoundTimer=null;}
  initAudio();if(state.socket){state.socket.emit('leaveRoom');state.socket.disconnect();state.socket=null;state.socketReady=false;}clearRemotePlayers();clearBots();clearTrainingTargets();
  state.mode='training';buildMap(state.selectedMap);state.name=($('player-name').value.trim()||'PLAYER').slice(0,16);state.money=0;state.hp=100;state.armor=0;state.armorTier='none';state.selfScore=0;state.enemyScore=0;state.round=1;state.currentWeapon='pistol';state.owned=new Set(WEAPONS.map(w=>w.id));state.ammo={};for(const w of WEAPONS)state.ammo[w.id]={mag:w.mag,reserve:w.reserve};buildGun('pistol');const spawn=getSpawn(state.mapId,0);state.pos.set(0,0,spawn.z-1.5);state.yaw=0;state.pitch=0;state.velocityY=0;state.buyPrimaryThisRound=false;state.matchOver=false;state.paused=false;state.phase='live';state.phaseEnd=0;state.roundLimit=0;state.reloading=false;
  setModeUI();$('phase-label').textContent='TRAINING';$('round-label').textContent='PRACTICE';$('objective-label').textContent='SHOOT TARGETS · 100 DAMAGE TO RESET';$('match-timer').textContent='∞';$('buy-feedback').textContent='훈련장에서는 크레딧을 사용하지 않습니다.';closeBuy();spawnTrainingTargets();updateHUD();showToast('훈련장 시작 · 과녁과 사람 더미는 100 피해를 받으면 3초 후 재생성됩니다.',4200);
}
function clearTrainingTargets(){
  for(const target of state.trainingTargets||[]){unregisterTarget(target.id);disposeGroup(target.root);}
  state.trainingTargets=[];
}
function spawnTrainingTargets(){
  clearTrainingTargets();
  const map=state.mapId;
  const positions={
    arena:{dummies:[[-17,8],[-7,3],[7,3],[17,8],[-20,-9],[20,-9],[-12,-23],[12,-23],[0,-5],[0,17]],boards:[[-22,4],[-9,-12],[9,-12],[22,4],[-20,21],[20,21],[0,-25]]},
    palace:{dummies:[[-29,14],[-17,8],[-5,12],[8,12],[21,8],[30,14],[-28,-6],[27,-6],[-15,30],[15,30]],boards:[[-34,10],[-20,-1],[-7,4],[7,4],[20,-1],[34,10],[0,34]]},
    city:{dummies:[[-50,-35],[-48,5],[-42,32],[-15,-18],[15,-17],[48,-34],[48,9],[42,35],[-14,50],[18,50],[0,-48],[0,12]],boards:[[-52,-20],[-35,18],[-18,34],[18,34],[35,18],[52,-20],[-4,-46],[4,45]]}
  };
  const config=positions[map]||positions.arena;
  config.dummies.forEach(([x,z],i)=>{
    const id=`practice-dummy-${i+1}`,root=makeCharacter({color:i%2?0xcbd8e0:0x9bb4c4,accent:0x293b4b,name:`DUMMY ${String(i+1).padStart(2,'0')}`});
    const y=getGroundHeight(x,z);root.position.set(x,y,z);root.rotation.y=Math.PI;scene.add(root);registerTarget(root,id);state.trainingTargets.push({id,root,hp:100,maxHp:100,alive:true,respawnAt:0,name:`사람 더미 ${i+1}`,baseY:y,fallenAt:0,fallDirection:1});
  });
  config.boards.forEach(([x,z],i)=>{
    const id=`practice-board-${i+1}`,root=new THREE.Group(),y=getGroundHeight(x,z)+1.65;
    const outer=new THREE.Mesh(new THREE.CircleGeometry(.78,32),new THREE.MeshStandardMaterial({color:0xdce5e9,roughness:.9}));outer.position.set(x,y,z);root.add(outer);
    const rings=[{r:.58,c:0x327a8b},{r:.39,c:0xdf4f5f},{r:.20,c:0xe2ba61},{r:.075,c:0x202a38}];
    rings.forEach(({r,c})=>{const m=new THREE.Mesh(new THREE.CircleGeometry(r,28),new THREE.MeshStandardMaterial({color:c,roughness:.85}));m.position.set(x,y,z+.006+(0.006*(.8-r)));root.add(m);});
    scene.add(root);registerTarget(root,id);state.trainingTargets.push({id,root,hp:100,maxHp:100,alive:true,respawnAt:0,name:`과녁 ${i+1}`,baseY:y,fallenAt:0,fallDirection:1});
  });
}

function updateTrainingTargets(now=Date.now()){
  for(const target of state.trainingTargets){
    if(!target.alive&&target.fallenAt){const t=Math.min(1,(performance.now()-target.fallenAt)/520);target.root.rotation.z=Math.sin(t*Math.PI/2)*1.34*(target.fallDirection||1);target.root.position.y=target.baseY-Math.sin(t*Math.PI/2)*.22;}
    if(!target.alive&&target.respawnAt&&now>=target.respawnAt){target.hp=target.maxHp;target.alive=true;target.respawnAt=0;target.fallenAt=0;target.root.rotation.z=0;target.root.position.y=target.baseY;target.root.visible=true;registerTarget(target.root,target.id);}
  }
}
function renderTrainingWeapons(){
  const grid=$('training-weapon-grid');if(!grid)return;grid.innerHTML='';
  for(const w of WEAPONS){const button=document.createElement('button');button.className='training-weapon-option'+(state.currentWeapon===w.id?' selected':'');button.innerHTML=`<div class="weapon-mini-stage ${w.id}-showcase"><div class="weapon-mini-model" style="--showcase-color:#${w.color.toString(16).padStart(6,'0')}"><i></i><b></b><em></em><span></span></div></div><small>${w.type}</small><b>${w.name}</b><span>DMG ${w.damage} · ${w.slot==='melee'?'MELEE':'MAG '+w.mag}</span>`;button.addEventListener('click',()=>{state.owned.add(w.id);setWeapon(w.id);makeAmmoFor(w.id,true);$('training-weapon-menu').classList.add('hidden');});grid.append(button);}
}
function openTrainingWeapons(){if(state.mode!=='training')return;renderTrainingWeapons();$('training-weapon-menu').classList.remove('hidden');}
function spawnBots(){
  clearBots();
  // A single rival spawns at the far end, making this a true 1v1 round.
  const id='bot-0';
  const root=makeCharacter({color:0xff607b,accent:0x391d33,name:'RIVAL-01'});
  const spawn=getSpawn(state.mapId,1);root.position.set(spawn.x,0,spawn.z);root.rotation.y=spawn.yaw;scene.add(root);registerTarget(root,id);
  state.botList.push({id,root,hp:100,alive:true,fireAt:Date.now()+1300+Math.random()*500,movePhase:Math.random()*8,name:'RIVAL-01',weapon:'rifle'});
}
function clearBots(){for(const b of state.botList){unregisterTarget(b.id);disposeGroup(b.root);}state.botList=[];}
function beginLocalLive(){
  if(state.phase!=='buy')return;
  state.phase='live';state.phaseEnd=Date.now()+90000;state.roundLimit=state.phaseEnd;buyMenu.classList.add('hidden');$('phase-label').textContent='LIVE';$('objective-label').textContent=state.mode==='training'?'SHOOT TARGETS · 100 DAMAGE TO RESET':`FIRST TO 6 ROUNDS · ${state.selfScore}-${state.enemyScore}`;spawnBots();showToast('라운드 시작! 상대를 처치하세요. 선착순 6승!',1800);updateHUD();
}
function endLocalRound(win,reason=''){
  if(state.mode!=='ai'||state.phase==='ended'||state.phase==='matchover')return;
  if(state.localNextRoundTimer){clearTimeout(state.localNextRoundTimer);state.localNextRoundTimer=null;}
  setZoom(false);state.phase='ended';state.resultShown=true;const reward=win?650:400;state.money+=reward;
  if(win)state.selfScore++;else state.enemyScore++;
  state.matchOver=state.selfScore>=6||state.enemyScore>=6;
  $('result-kicker').textContent=state.matchOver?'MATCH RESULT':'ROUND RESULT';
  $('result-title').innerHTML=state.matchOver?(win?'MATCH<br/><span>VICTORY.</span>':'MATCH<br/><span>DEFEAT.</span>'):(win?'ROUND<br/><span>WON.</span>':'ROUND<br/><span>LOST.</span>');
  $('result-copy').textContent=state.matchOver?`최종 점수 ${state.selfScore}-${state.enemyScore}. ${win?'6라운드 선취로 매치에서 승리했습니다.':'상대가 6승을 먼저 달성했습니다.'}`:`${reason|| (win?'상대 플레이어를 처치했습니다.':'이번 라운드에서 패배했습니다.')} · 매치는 계속됩니다 (${state.selfScore}-${state.enemyScore}). 5초 후 다음 라운드가 자동 시작됩니다. 먼저 6승을 하면 매치가 끝납니다.`;
  $('result-reward').textContent=`+${reward.toLocaleString()} CR`;
  $('next-round').textContent=state.matchOver?'다시 도전':'다음 라운드 바로 시작';$('next-round').classList.remove('hidden');endScreen.classList.remove('hidden');buyMenu.classList.add('hidden');soundKill();updateHUD();
  if(!state.matchOver)state.localNextRoundTimer=setTimeout(()=>{state.localNextRoundTimer=null;if(state.mode==='ai'&&state.phase==='ended'&&!state.matchOver)nextLocalRound();},5000);
}
function nextLocalRound(){
  if(state.localNextRoundTimer){clearTimeout(state.localNextRoundTimer);state.localNextRoundTimer=null;}
  endScreen.classList.add('hidden');if(state.matchOver){state.selfScore=0;state.enemyScore=0;state.money=450;state.armor=0;state.armorTier='none';state.currentWeapon='pistol';state.owned=new Set(['pistol','knife']);for(const w of WEAPONS)state.ammo[w.id]={mag:w.mag,reserve:w.reserve};state.round=0;}
  startLocalRound();
}
function setZoom(active){
  const overlay=$('scope-overlay');if(!overlay)return;
  const w=currentWeapon();
  if(active&&!w.scopeFov){showToast('이 무기는 조준경이 없습니다.',1000);return;}
  state.zoomed=!!active;
  camera.fov=state.zoomed?w.scopeFov:state.baseFov;camera.updateProjectionMatrix();
  overlay.classList.toggle('hidden',!state.zoomed);
  overlay.classList.toggle('sniper-scope',state.zoomed&&w.id==='sniper');
  overlay.classList.toggle('precision-only',state.zoomed&&w.id!=='sniper');
  $('crosshair').classList.toggle('hidden',state.zoomed);
  if(state.zoomed)showToast(w.id==='sniper'?'저격 스코프 · 우클릭 또는 Q로 해제':'정밀 조준 · 우클릭 또는 Q로 해제',1000);
}
function toggleZoom(){if(state.mode==='menu'||state.phase!=='live'||state.paused)return;setZoom(!state.zoomed);}
function switchWeaponByNumber(n){
  if(n===1){const primary=WEAPONS.find(w=>w.slot==='primary'&&state.owned.has(w.id));if(!primary){showToast('현재 주무기가 없습니다.',1100);return;}const current=WEAPONS.find(w=>w.id===state.currentWeapon);const chosen=current?.slot==='primary'&&state.owned.has(current.id)?current:primary;setWeapon(chosen.id,true);return;}
  if(n===2){if(state.owned.has('pistol'))setWeapon('pistol',true);return;}
  if(n===3){if(state.owned.has('knife'))setWeapon('knife',true);return;}
  // Number keys 4–9 remain as convenience shortcuts for any additional purchased weapons.
  const candidate=WEAPONS[n-1];if(candidate&&candidate.slot!=='melee'&&state.owned.has(candidate.id))setWeapon(candidate.id,true);
}
function reloadWeapon(){
  if(state.phase!=='live'||state.paused||state.reloading)return;
  if(state.mode==='training'){const w=currentWeapon();makeAmmoFor(w.id,true);updateHUD();showToast('훈련장 무한 탄약 · 재장전할 필요가 없습니다.',900);return;}
  const w=currentWeapon(),a=state.ammo[w.id];
  if(w.slot==='melee'){showToast('칼은 재장전할 필요가 없습니다.',900);return;}
  if(a.mag>=w.mag||a.reserve<=0){showToast(a.mag>=w.mag?'탄창이 이미 가득 찼습니다.':'예비 탄약이 없습니다.',900);return;}
  state.reloading=true;state.reloadWeaponId=w.id;state.reloadUntil=performance.now()+w.reload*1000;state.weaponMotion.reloadAt=performance.now();soundReload();showToast('재장전 중...',700);
}
function completeReload(now){
  if(!state.reloading||now<state.reloadUntil)return;
  const id=state.reloadWeaponId||state.currentWeapon,w=WEAPON_BY_ID[id],a=state.ammo[id];
  if(w&&a){const needed=Math.max(0,w.mag-a.mag),loaded=Math.min(needed,a.reserve);a.mag+=loaded;a.reserve-=loaded;}
  state.reloading=false;state.reloadWeaponId=null;updateHUD();showToast('재장전 완료',650);
}
function applyLocalDamage(damage){let left=damage;if(state.armor>0){const ratio=state.armorTier==='heavy'?.60:.35;const absorbed=Math.min(state.armor,damage*ratio);state.armor-=absorbed;left-=absorbed;if(state.armor<=0){state.armor=0;state.armorTier='none';}}state.hp=Math.max(0,state.hp-left);updateHUD();if(state.hp<=0)endLocalRound(false,'플레이어가 쓰러졌습니다.');}
function addShotFx(from,to,color=0x8ffff0){
  const geo=new THREE.BufferGeometry().setFromPoints([from.clone(),to.clone()]);const mat=new THREE.LineBasicMaterial({color,transparent:true,opacity:.85});const line=new THREE.Line(geo,mat);scene.add(line);state.shotFx.push({line,mat,geo,expires:performance.now()+75});
}
function cameraForward(){const d=new THREE.Vector3();camera.getWorldDirection(d);return d.normalize();}
function doShoot(fromBurst=false){
  if(state.phase!=='live'||state.paused||state.reloading)return false;
  const w=currentWeapon(),ammo=state.ammo[w.id],now=performance.now();
  if(w.id==='burst'&&fromBurst&&state.burstRemaining<=0)return false;
  if(!fromBurst&&now-state.lastShot<w.rate*1000)return false;
  if(!fromBurst&&w.id==='burst'&&state.burstRemaining>0)return false;
  if(w.id!=='knife'&&state.mode!=='training'&&ammo.mag<=0){if(now-state.lastEmptyToast>1200){showToast('탄약이 없습니다. R로 재장전하세요.',850);state.lastEmptyToast=now;}state.burstRemaining=0;return false;}
  let burstIdForShot=null,burstSeqForShot=null;
  if(w.id==='burst'){
    if(!fromBurst){state.burstId=(state.burstId+1)%2147483000;if(state.burstId===0)state.burstId=1;state.burstRemaining=2;state.burstNextAt=now*(1)+(w.burstGap||.055)*1000;state.burstSeq=1;burstIdForShot=state.burstId;burstSeqForShot=0;}
    else{burstIdForShot=state.burstId;burstSeqForShot=state.burstSeq++;state.burstRemaining=Math.max(0,state.burstRemaining-1);state.burstNextAt=state.burstRemaining?now+(w.burstGap||.055)*1000:0;}
  }
  state.lastShot=now;state.weaponMotion.fireAt=now;
  if(w.id==='knife')state.weaponMotion.knifeAt=now;
  state.recoilHeat=Math.min(2.4,state.recoilHeat+Math.max(.12,w.recoil*18));state.viewKick=Math.min(.14,state.viewKick+(w.recoil||.003));
  if(state.mode==='training'){ammo.mag=w.mag;ammo.reserve=w.reserve;}else if(w.id!=='knife')ammo.mag--;
  if(w.id==='knife')soundKnife();else soundShot(w.id);
  if(muzzleMesh&&w.id!=='knife'){muzzleMesh.visible=true;state.muzzleUntil=now+55;}
  const direction=cameraForward();const origin=camera.position.clone();let hitPoint=origin.clone().add(direction.clone().multiplyScalar(w.range));
  const pellets=w.id==='shotgun'?(w.pellets||10):1;const localDamageByTarget=new Map();let firstShotDirection=direction.clone();
  for(let i=0;i<pellets;i++){
    const d=direction.clone();const heatFactor=1+state.recoilHeat*(1.25-w.control*.075);
    let spread=state.zoomed?(w.scopeSpread??w.spread*.34):w.id==='sniper'?(w.hipSpread??.06):w.spread;
    if(w.id==='shotgun')spread*=1.0;
    spread*=heatFactor;
    d.x+=(Math.random()-.5)*spread;d.y+=(Math.random()-.5)*spread;d.z+=(Math.random()-.5)*spread;d.normalize();if(i===0)firstShotDirection.copy(d);raycaster.set(origin,d);raycaster.far=w.range;
    const hits=raycaster.intersectObjects(targetObjects,false);let h=hits.find(x=>{
      const targetId=x.object.userData.targetId;if(!targetId)return false;
      if(String(targetId).startsWith('bot-'))return state.mode==='ai'&&state.botList.some(b=>b.id===targetId&&b.alive);
      if(String(targetId).startsWith('practice-'))return state.mode==='training'&&state.trainingTargets.some(t=>t.id===targetId&&t.alive);
      return state.mode==='online'&&state.remotePlayers.has(targetId);
    });
    if(h){const blockers=raycaster.intersectObjects(obstacleMeshes,false);if(blockers.length&&blockers[0].distance<h.distance-.06)h=null;}
    if(h){hitPoint=h.point;const hitOwner=h.object.userData.targetId;const part=h.object.userData.part||'body';
      if(String(hitOwner).startsWith('bot-')){const bot=state.botList.find(b=>b.id===hitOwner);if(bot&&bot.alive){let dealt=w.damage*getHitMultiplier(part);if(w.id==='knife')dealt=40;if(w.id==='shotgun')dealt*=Math.max(.20,1-(h.distance/w.range)*.78);localDamageByTarget.set(hitOwner,(localDamageByTarget.get(hitOwner)||0)+dealt);}}
      else if(String(hitOwner).startsWith('practice-')){const target=state.trainingTargets.find(t=>t.id===hitOwner);if(target&&target.alive){let dealt=w.damage*getHitMultiplier(part);if(w.id==='knife')dealt=40;if(w.id==='shotgun')dealt*=Math.max(.20,1-(h.distance/w.range)*.78);localDamageByTarget.set(hitOwner,(localDamageByTarget.get(hitOwner)||0)+dealt);flashCharacter(target.root);}}
      // Online damage remains server-authoritative. The server samples shotgun pellets independently.
    }
  }
  if(w.id!=='knife')addShotFx(origin,hitPoint,w.id==='sniper'?0xffdfb5:0x73f8e4);
  if(state.mode==='training'&&localDamageByTarget.size){
    for(const [targetId,damage] of localDamageByTarget){const target=state.trainingTargets.find(t=>t.id===targetId&&t.alive);if(!target)continue;target.hp-=damage;soundHit();$('hit-marker').classList.remove('hidden');setTimeout(()=>$('hit-marker').classList.add('hidden'),100);if(target.hp<=0){target.hp=0;target.alive=false;const isDummy=target.id.startsWith('practice-dummy-');target.respawnAt=Date.now()+(isDummy?5000:3000);target.fallenAt=isDummy?performance.now():0;target.fallDirection=(target.root.position.x-state.pos.x)>=0?1:-1;if(!isDummy)target.root.visible=false;unregisterTarget(target.id);void awardTrainingXP();soundKill();$('kill-banner').innerHTML=`${target.name.toUpperCase()} RESET <small>RESPAWN ${isDummy?5:3} SEC · +10 XP</small>`;$('kill-banner').classList.remove('hidden');setTimeout(()=>$('kill-banner').classList.add('hidden'),900);}}
  }
  if(state.mode==='ai'&&localDamageByTarget.size){for(const [targetId,damage] of localDamageByTarget){const bot=state.botList.find(b=>b.id===targetId&&b.alive);if(!bot)continue;bot.hp-=damage;flashCharacter(bot.root);soundHit();$('hit-marker').classList.remove('hidden');setTimeout(()=>$('hit-marker').classList.add('hidden'),100);if(bot.hp<=0){bot.hp=0;bot.alive=false;bot.root.visible=false;unregisterTarget(bot.id);state.money+=75;soundKill();$('kill-banner').innerHTML=`${bot.name} ELIMINATED <small>+75 CR</small>`;$('kill-banner').classList.remove('hidden');setTimeout(()=>$('kill-banner').classList.add('hidden'),850);updateHUD();}}if(state.botList.every(b=>!b.alive))endLocalRound(true,'상대 플레이어를 처치했습니다.');}
  if(state.mode==='online'&&state.socketReady){const serverAim=w.id==='shotgun'?direction:firstShotDirection;const payload={weaponId:w.id,origin:{x:origin.x,y:origin.y,z:origin.z},direction:{x:serverAim.x,y:serverAim.y,z:serverAim.z}};if(w.id==='burst'){payload.burstId=burstIdForShot;payload.burstSeq=burstSeqForShot;}state.socket.emit('fire',payload);}
  if(w.id==='sniper'){state.sniperMustRelease=true;setZoom(false);}
  updateAmmoHUD();return true;
}

function collideAt(x,z,y=state.pos.y){
  const radius=.48;if(Math.abs(x)>state.mapBounds||Math.abs(z)>state.mapBounds)return true;
  for(const c of colliders){
    const overlaps=Math.abs(x-c.x)<c.w/2+radius&&Math.abs(z-c.z)<c.d/2+radius;
    if(!overlaps)continue;
    if(c.solidTop){
      if(y<c.h-.04)return true;
      const walkableRoof=elevatedPlatforms.find(platform=>x>=platform.xMin&&x<=platform.xMax&&z>=platform.zMin&&z<=platform.zMax&&Math.abs(platform.height-c.h)<.25);
      // Only explicitly authored rooftops can be traversed above their roof height.
      if(walkableRoof&&y<=c.h+2.1)continue;
      return true;
    }
    if(y>=c.h-.04)continue;
    return true;
  }
  return false;
}
function movePlayer(dt){
  if(state.phase!=='live'||state.paused||state.killCamActive)return;
  const forward=(state.keys.has('KeyW')?1:0)-(state.keys.has('KeyS')?1:0)-state.touchMove.y;
  const strafe=(state.keys.has('KeyD')?1:0)-(state.keys.has('KeyA')?1:0)+state.touchMove.x;
  const slowWalk=state.keys.has('ShiftLeft')||state.keys.has('ShiftRight');
  const knifeBoost=state.currentWeapon==='knife'?1.1:1;
  const speed=5.2*knifeBoost*(slowWalk?.58:1);
  let dx=0,dz=0;
  const fx=-Math.sin(state.yaw),fz=-Math.cos(state.yaw);const rx=Math.cos(state.yaw),rz=-Math.sin(state.yaw);
  dx=(fx*forward+rx*strafe);dz=(fz*forward+rz*strafe);const len=Math.hypot(dx,dz);if(len>1){dx/=len;dz/=len;}
  const moving=len>.12;state.walkIntensity+=( (moving?1:0)-state.walkIntensity )*Math.min(1,dt*11);
  if(moving)state.walkCycle+=dt*(slowWalk?6.2:10.2)*Math.min(1,len);
  const nx=state.pos.x+dx*speed*dt,nz=state.pos.z+dz*speed*dt;
  if(!collideAt(nx,state.pos.z,state.pos.y))state.pos.x=nx;if(!collideAt(state.pos.x,nz,state.pos.y))state.pos.z=nz;
  const groundBefore=getGroundHeight(state.pos.x,state.pos.z);
  if(state.pos.y<=groundBefore+.06&&state.velocityY<=0){state.pos.y=groundBefore;state.velocityY=0;state.canJump=true;}
  if(state.keys.has('Space')&&state.canJump){state.velocityY=5.5;state.canJump=false;}
  state.velocityY-=14*dt;state.pos.y+=state.velocityY*dt;const groundAfter=getGroundHeight(state.pos.x,state.pos.z);if(state.pos.y<groundAfter){state.pos.y=groundAfter;state.velocityY=0;state.canJump=true;}
  // Normal movement produces soft boots-on-metal footsteps; holding Shift switches to a slower, silent walk.
  if(moving&&!slowWalk){
    state.footstepAccumulator+=dt;
    const interval=state.currentWeapon==='knife'?.43:.47;
    if(state.footstepAccumulator>=interval){state.footstepAccumulator%=interval;soundFootstep({volume:.13});if(state.mode==='online'&&state.socketReady)state.socket.volatile.emit('footstep');}
  }else state.footstepAccumulator=0;
  if(state.mode==='online'&&state.socketReady){state._moveAcc=(state._moveAcc||0)+dt;if(state._moveAcc>.05){state._moveAcc=0;state.socket.volatile.emit('move',{x:state.pos.x,y:state.pos.y,z:state.pos.z,yaw:state.yaw,pitch:state.pitch,name:state.name});}}
}

function updateAI(dt){
  if(state.mode!=='ai'||state.phase!=='live'||state.paused)return;
  const diff={easy:{speed:1.15,rate:2.1,damage:7,accuracy:.24,range:18},normal:{speed:1.65,rate:1.35,damage:10,accuracy:.43,range:23},hard:{speed:2.05,rate:.88,damage:13,accuracy:.63,range:27}}[state.difficulty]||{speed:1.65,rate:1.35,damage:10,accuracy:.43,range:23};
  const now=Date.now();
  for(const bot of state.botList){if(!bot.alive)continue;
    let targetX=state.pos.x,targetZ=state.pos.z;const bz=bot.root.position.z,pz=state.pos.z;
    // Route around the staggered tall barriers instead of walking into them forever.
    if(state.mapId!=='arena'){targetX=state.pos.x;targetZ=state.pos.z;}
    else if(bz < -20 && pz > -20){targetX=10;targetZ=Math.abs(bot.root.position.x-10)>1.8?-24:-16;}
    else if(bz > -18 && bz < 20 && pz > 20){targetX=-11;targetZ=Math.abs(bot.root.position.x+11)>1.8?5:24;}
    else if(bz > 20 && pz < 20){targetX=-11;targetZ=Math.abs(bot.root.position.x+11)>1.8?24:16;}
    else if(bz < 18 && pz < -20){targetX=10;targetZ=Math.abs(bot.root.position.x-10)>1.8?5:-24;}
    const v=new THREE.Vector3(targetX-bot.root.position.x,0,targetZ-bot.root.position.z);const dist=v.length();if(dist>.001){v.normalize();bot.root.rotation.y=Math.atan2(-v.x,-v.z);}
    const playerDistance=Math.hypot(state.pos.x-bot.root.position.x,state.pos.z-bot.root.position.z);
    bot.movePhase+=dt;
    if(playerDistance>6&&dist>.3){let steer=1;const nx=bot.root.position.x+v.x*diff.speed*dt*steer,nz=bot.root.position.z+v.z*diff.speed*dt*steer;if(!collideAt(nx,bot.root.position.z))bot.root.position.x=nx;if(!collideAt(bot.root.position.x,nz))bot.root.position.z=nz;}
    else{const side=Math.sin(bot.movePhase*1.7)*.6;const nx=bot.root.position.x+v.z*side*dt,nz=bot.root.position.z-v.x*side*dt;if(!collideAt(nx,bot.root.position.z))bot.root.position.x=nx;if(!collideAt(bot.root.position.x,nz))bot.root.position.z=nz;}
    // Slightly delayed, difficulty-tuned hitscan attacks. The game emits a restrained sound cue when bots fire.
    if(playerDistance<diff.range&&now>=bot.fireAt){bot.fireAt=now+diff.rate*1000+(Math.random()-.5)*260;const from=new THREE.Vector3(bot.root.position.x,1.35,bot.root.position.z);const to=new THREE.Vector3(state.pos.x,1.25,state.pos.z);const rayDir=to.clone().sub(from);const rayDist=rayDir.length();rayDir.normalize();raycaster.set(from,rayDir);raycaster.far=rayDist;const cover=raycaster.intersectObjects(obstacleMeshes,false);const clearShot=!cover.length||cover[0].distance>=rayDist-.35;if(clearShot&&Math.random()<diff.accuracy){const falloff=THREE.MathUtils.clamp(1-playerDistance/(diff.range*1.7),.35,1);applyLocalDamage(diff.damage*falloff);if(state.phase!=='live')return;}if(clearShot&&Math.random()<.35)soundBotShot();}
  }
}
function soundBotShot(){initAudio();const c=state.audio;if(!c)return;const t=c.currentTime,o=c.createOscillator(),g=c.createGain();o.type='triangle';o.frequency.setValueAtTime(160,t);o.frequency.exponentialRampToValueAtTime(48,t+.065);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.055,t+.004);g.gain.exponentialRampToValueAtTime(.0001,t+.085);o.connect(g).connect(c.destination);o.start(t);o.stop(t+.09);}

function resetKillCam(){
  if(state.killCamTimer){clearTimeout(state.killCamTimer);state.killCamTimer=null;}
  if(state.roundResultTimer){clearTimeout(state.roundResultTimer);state.roundResultTimer=null;}
  state.killCam=null;state.killCamActive=false;state.roundResultPending=null;
  $('killcam-label')?.classList.add('hidden');
  if(state.killCamSavedWeapon){state.killCamSavedWeapon=null;}
  for(const effect of state.killEffects||[]){scene.remove(effect.group);effect.group.traverse(o=>{o.geometry?.dispose();if(Array.isArray(o.material))o.material.forEach(m=>m.dispose());else o.material?.dispose();});}
  state.killEffects=[];
  if(gunRoot)gunRoot.visible=state.mode!=='menu';
}
function spawnSkinKillEffect(data){
  const skin=getStoreSkin(data.skinId);const effectType=skin?.killEffect;if(!effectType)return;
  const victim=data.victim||{};const origin=new THREE.Vector3(Number(victim.x)||0,Number(victim.y)||0,Number(victim.z)||0);
  const group=new THREE.Group();group.position.copy(origin);scene.add(group);
  if(effectType==='ghost-lift'){
    const glow=new THREE.Mesh(new THREE.SphereGeometry(.42,12,10),new THREE.MeshStandardMaterial({color:0xeaf8f6,emissive:0x8adbd7,emissiveIntensity:1.8,transparent:true,opacity:.9,roughness:.25}));glow.position.y=1.7;glow.scale.set(.8,1.15,.65);group.add(glow);
    const tail=new THREE.Mesh(new THREE.ConeGeometry(.32,.75,12),new THREE.MeshStandardMaterial({color:0xdaf3ef,emissive:0x3c8d89,emissiveIntensity:.7,transparent:true,opacity:.72,side:THREE.DoubleSide}));tail.position.y=1.15;tail.rotation.x=Math.PI;group.add(tail);
    for(let i=0;i<3;i++){const eye=new THREE.Mesh(new THREE.SphereGeometry(.045,8,6),new THREE.MeshBasicMaterial({color:0x14242e}));eye.position.set(i===0?-.11:.11,1.77,.36);group.add(eye);}
  }else if(effectType==='gold-arrows'){
    const gold=new THREE.MeshStandardMaterial({color:0xffd56b,emissive:0xffb51c,emissiveIntensity:1.8,metalness:.8,roughness:.18});
    for(let i=0;i<9;i++){const arrow=new THREE.Mesh(new THREE.ConeGeometry(.07,.66,5),gold.clone());const angle=i*Math.PI*2/9;arrow.position.set(Math.cos(angle)*(.35+(i%3)*.14),.8+(i%4)*.22,Math.sin(angle)*(.35+(i%3)*.14));arrow.rotation.set(Math.PI/2,0,-angle);group.add(arrow);}
    const flash=new THREE.Mesh(new THREE.SphereGeometry(.7,12,8),new THREE.MeshBasicMaterial({color:0xffdf84,transparent:true,opacity:.32,depthWrite:false}));flash.position.y=1;group.add(flash);
  }
  state.killEffects.push({group,type:effectType,started:performance.now(),duration:effectType==='ghost-lift'?4600:2600,origin:origin.clone()});
}
function beginKillCam(data){
  if(state.mode!=='online'||!data?.killer)return;
  if(state.killCamTimer)clearTimeout(state.killCamTimer);
  state.killCam={...data,startedAt:performance.now()};state.killCamActive=true;state.phase='ended';state.paused=false;state.keys.clear();state.fireHeld=false;state.sniperMustRelease=false;state.touchMove.x=0;state.touchMove.y=0;state.mobileLook=null;
  if(document.pointerLockElement)document.exitPointerLock();
  $('killcam-label')?.classList.remove('hidden');$('killcam-label')?.querySelector('span')&&( $('killcam-label').querySelector('span').textContent='시점 고정 · 5초');
  endScreen.classList.add('hidden');setZoom(false);spawnSkinKillEffect(data);
  const victim=state.remotePlayers.get(data.victimId);
  if(victim){victim.root.userData.killFallAt=performance.now();victim.root.userData.killFallStartZ=victim.root.rotation.z;victim.root.userData.killFallStartY=victim.root.position.y;victim.root.userData.killFallDirection=(victim.root.position.x-data.killer.x)>=0?1:-1;}
  // The eliminated player's screen switches to a frozen replay of the killer's last first-person view.
  if(data.victimId===state.socket?.id){gunRoot.visible=false;}
  state.killCamTimer=setTimeout(()=>{
    state.killCamTimer=null;state.killCamActive=false;state.killCam=null;$('killcam-label')?.classList.add('hidden');
    const victimRemote=data.victimId&&state.remotePlayers.get(data.victimId);if(victimRemote){delete victimRemote.root.userData.killFallAt;victimRemote.root.rotation.z=0;}
    gunRoot.visible=state.phase==='live'||state.phase==='buy';
    if(state.roundResultPending){const pending=state.roundResultPending;state.roundResultPending=null;renderOnlineRoundResult(pending);}
  },Math.max(500,Number(data.durationMs)||5000));
}
function renderOnlineRoundResult(data){
  setZoom(false);state.phase='ended';state.selfScore=data.scores?.[state.socket?.id]||0;state.enemyScore=Object.entries(data.scores||{}).filter(([id])=>id!==state.socket?.id).reduce((a,[,v])=>a+v,0);state.money=data.selfMoney??state.money;state.matchOver=!!data.matchOver;
  const won=data.winnerId===state.socket?.id;$('result-kicker').textContent=data.matchOver?'MATCH RESULT':'ROUND RESULT';$('result-title').innerHTML=data.matchOver?(won?'MATCH<br/><span>VICTORY.</span>':'MATCH<br/><span>DEFEAT.</span>'):(won?'ROUND<br/><span>WON.</span>':'ROUND<br/><span>LOST.</span>');
  $('result-copy').textContent=data.matchOver?(data.reason||'6라운드 선취로 매치가 끝났습니다.'):`${data.reason||'라운드 종료'} · 이번 라운드만 종료됐습니다. 현재 점수 ${state.selfScore}-${state.enemyScore}. 다음 라운드 버튼을 눌러 계속하세요.`;
  $('result-reward').textContent=`+${(data.reward??0).toLocaleString()} CR`;$('next-round').classList.toggle('hidden',!!data.matchOver);$('next-round').disabled=false;$('next-round').textContent='다음 라운드 시작';endScreen.classList.remove('hidden');updateHUD();
}
function handleOnlineRoundResult(data){
  // Lock input immediately, but don't reveal the round result until the five-second killcam is complete.
  state.phase='ended';state.selfScore=data.scores?.[state.socket?.id]||0;state.enemyScore=Object.entries(data.scores||{}).filter(([id])=>id!==state.socket?.id).reduce((a,[,v])=>a+v,0);state.money=data.selfMoney??state.money;state.matchOver=!!data.matchOver;setZoom(false);
  if(state.roundResultTimer){clearTimeout(state.roundResultTimer);state.roundResultTimer=null;}
  const delayMs=Math.max(0,Number(data.killCamMs)||0);
  if(state.killCamActive||delayMs>0){state.roundResultPending=data;if(!state.killCamActive){state.roundResultTimer=setTimeout(()=>{state.roundResultTimer=null;const pending=state.roundResultPending;state.roundResultPending=null;if(pending)renderOnlineRoundResult(pending);},delayMs);}return;}
  renderOnlineRoundResult(data);
}

function beginOnline(){
  if((state.rule==='pc'&&state.device!=='pc')||(state.rule==='mobile'&&state.device!=='mobile')){showToast(state.rule==='pc'?'PC끼리 모드는 PC를 선택하세요.':'모바일끼리 모드는 모바일을 선택하세요.');return;}
  initAudio();state.mode='online';state.name=($('player-name').value.trim()||'PLAYER').slice(0,16);state.money=450;state.hp=100;state.armor=0;state.armorTier='none';state.selfScore=0;state.enemyScore=0;state.round=0;state.currentWeapon='pistol';state.owned=new Set(['pistol','knife']);state.ammo={};for(const w of WEAPONS)state.ammo[w.id]={mag:w.mag,reserve:w.reserve};state.pos.set(0,0,27);state.yaw=Math.PI;state.pitch=0;state.buyPrimaryThisRound=false;state.phase='waiting';state.roomCode='';clearBots();clearRemotePlayers();clearTrainingTargets();resetKillCam();setModeUI();$('phase-label').textContent='CONNECTING';$('objective-label').textContent='WAITING FOR OPPONENT';updateHUD();
  const socket=io({transports:['websocket','polling'],tryAllTransports:true,upgrade:true,reconnection:true,reconnectionAttempts:Infinity,reconnectionDelay:500,reconnectionDelayMax:4000,timeout:20000});state.socket=socket;let connectCount=0;
  socket.on('connect',()=>{const reconnect=connectCount++>0;state.socketReady=true;updateHUD();if(reconnect&&!socket.recovered&&state.roomCode)socket.emit('resumeRoom',{code:state.roomCode,sessionId:CLIENT_SESSION_ID});});
  socket.on('disconnect',reason=>{state.socketReady=false;updateHUD();if(state.mode==='online'&&reason!=='io client disconnect')showToast('온라인 연결을 복구하는 중입니다…',2600);});
  socket.on('connect_error',()=>{state.socketReady=false;updateHUD();setMenuStatus('온라인 서버에 연결할 수 없습니다. 서버가 배포되어 있는지 확인하세요.');showToast('온라인 서버 연결 실패. 공개 배포 주소에서 접속했는지 확인하세요.',3200);});
  socket.on('roomCreated',data=>{if(data.map&&state.mapId!==data.map)buildMap(data.map);state.roomCode=data.code;state.phase='waiting';$('phase-label').textContent='WAITING';$('objective-label').textContent='WAITING FOR OPPONENT';showToast(`방 생성 완료 · 코드 ${data.code} · 친구에게 코드 공유`,4000);showRoomWait(data.code);updateHUD();});
  socket.on('roomJoined',data=>{if(data.map&&state.mapId!==data.map)buildMap(data.map);state.roomCode=data.code;showRoomWait(data.code);});
  socket.on('roomResumed',data=>{if(data.map&&state.mapId!==data.map)buildMap(data.map);state.roomCode=data.code;hideRoomWait();showToast('온라인 연결이 복구됐습니다.',1800);updateHUD();});
  socket.on('killCamStart',data=>beginKillCam(data));
  socket.on('roomError',data=>{showToast(data.message||'방에 참가하지 못했습니다.',3200);state.phase='waiting';});
  socket.on('playerJoined',data=>{updateRemotePlayer(data.id,data.player);hideRoomWait();showToast(`${data.player.name||'상대'} 접속 · 라운드 준비`,2000);});
  socket.on('playerLeft',data=>{const r=state.remotePlayers.get(data.id);if(r){unregisterTarget(data.id);disposeGroup(r.root);state.remotePlayers.delete(data.id);}showToast('상대 플레이어 연결이 종료됐습니다.',3000);state.phase='waiting';$('phase-label').textContent='WAITING';});
  socket.on('playersSnapshot',data=>{for(const [id,p] of Object.entries(data||{}))updateRemotePlayer(id,p);});
  socket.on('playerMoved',data=>updateRemotePlayer(data.id,data));
  socket.on('playerWeapon',data=>updateRemoteWeaponModel(data.id,data.weapon,data.skinId));
  socket.on('footstep',data=>{if(data.id===socket.id)return;const remote=state.remotePlayers.get(data.id);if(!remote)return;const dist=remote.root.position.distanceTo(state.pos);if(dist<23)soundFootstep({volume:Math.max(.015,.11*(1-dist/25)),remote:true});});
  socket.on('roundState',data=>{
    clearTrainingTargets();
    if(data.map&&state.mapId!==data.map)buildMap(data.map);hideRoomWait();endScreen.classList.add('hidden');state.phase=data.phase;state.round=data.round;state.phaseEnd=data.endsAt;state.roundLimit=data.roundEndsAt||0;state.selfScore=data.scores?.[socket.id]||0;state.enemyScore=Object.entries(data.scores||{}).filter(([id])=>id!==socket.id).reduce((a,[,v])=>a+v,0);state.money=data.self?.money??state.money;state.hp=data.self?.hp??100;state.armor=data.self?.armor??state.armor;state.armorTier=data.self?.armorTier??state.armorTier;state.currentWeapon=data.self?.weapon||state.currentWeapon;state.buyPrimaryThisRound=!!data.self?.boughtPrimary;state.owned=new Set(data.self?.ownedWeapons||['pistol',...(data.self?.weapon&&data.self.weapon!=='pistol'?[data.self.weapon]:[])]);state.pos.set(data.self?.x??0,data.self?.y??0,data.self?.z??27);state.yaw=data.self?.yaw??state.yaw;state.pitch=data.self?.pitch??0;state.reloading=false;state.reloadWeaponId=null;makeAmmoFor(state.currentWeapon,true);buildGun(state.currentWeapon);if(data.phase==='buy'){clearRemotePlayers();for(const [id,p]of Object.entries(data.players||{}))if(id!==socket.id)updateRemotePlayer(id,p);$('phase-label').textContent='BUY PHASE';openBuy();}else{$('phase-label').textContent='LIVE';closeBuy();}updateHUD();
  });
  socket.on('selfState',data=>{if(data.money!=null)state.money=data.money;if(data.hp!=null)state.hp=data.hp;if(data.armor!=null)state.armor=data.armor;if(data.armorTier)state.armorTier=data.armorTier;if(data.ownedWeapons)for(const weaponId of data.ownedWeapons)state.owned.add(weaponId);if(data.weapon&&data.weapon!==state.currentWeapon){state.currentWeapon=data.weapon;buildGun(data.weapon);}if(data.boughtPrimary!=null)state.buyPrimaryThisRound=data.boughtPrimary;updateHUD();});
  socket.on('roundPhase',data=>{state.phase=data.phase;state.phaseEnd=data.endsAt;if(data.phase==='live')state.roundLimit=data.endsAt;if(data.phase==='live'){$('phase-label').textContent='LIVE';closeBuy();showToast(`ROUND ${data.round} — FIGHT`,1600);}if(data.phase==='buy'){$('phase-label').textContent='BUY PHASE';openBuy();}updateHUD();});
  socket.on('shotFx',data=>{if(data.id===socket.id)return;if(data.weaponId!=='knife'){const from=new THREE.Vector3(data.origin.x,data.origin.y,data.origin.z),to=new THREE.Vector3(data.end.x,data.end.y,data.end.z);addShotFx(from,to,0xff718a);}soundShot(data.weaponId);});
  socket.on('damage',data=>{if(data.targetId===socket.id){state.hp=data.hp;if(data.armor!=null)state.armor=data.armor;if(data.armorTier)state.armorTier=data.armorTier;updateHUD();soundHit();if(data.hp<=0){setZoom(false);showToast('라운드 패배 · 다음 라운드를 준비하세요.',1800);}}if(data.targetId!==socket.id){const target=state.remotePlayers.get(data.targetId);if(target)flashCharacter(target.root);}if(data.attackerId===socket.id&&data.targetId!==socket.id){$('hit-marker').classList.remove('hidden');setTimeout(()=>$('hit-marker').classList.add('hidden'),110);soundHit();}if(data.killed&&data.attackerId===socket.id){soundKill();$('kill-banner').innerHTML=`TARGET ELIMINATED <small>CR REWARD · ROUND ${state.round}</small>`;$('kill-banner').classList.remove('hidden');setTimeout(()=>$('kill-banner').classList.add('hidden'),900);}});
  socket.on('equipResult',data=>{if(!data.ok){showToast(data.message||'무기를 장착할 수 없습니다.');return;}state.currentWeapon=data.weapon;if(data.ownedWeapons)for(const weaponId of data.ownedWeapons)state.owned.add(weaponId);makeAmmoFor(data.weapon);buildGun(data.weapon);updateHUD();showToast(`${WEAPON_BY_ID[data.weapon]?.name||data.weapon} 장착`,900);});socket.on('buyResult',data=>{if(!data.ok){showToast(data.message||'구매할 수 없습니다.');return;}state.money=data.money;state.armor=data.armor??state.armor;if(data.armorTier)state.armorTier=data.armorTier;if(data.ownedWeapons)for(const weaponId of data.ownedWeapons)state.owned.add(weaponId);if(data.weapon&&data.weapon!==state.currentWeapon){state.currentWeapon=data.weapon;makeAmmoFor(data.weapon,true);buildGun(data.weapon);}state.buyPrimaryThisRound=!!data.boughtPrimary;state.armorPurchased=!!data.armorPurchased;soundBuy();$('buy-feedback').textContent=data.message||'구매 완료';updateHUD();});
  socket.on('roundResult',data=>handleOnlineRoundResult(data));
  socket.on('roomMessage',data=>showToast(data.message));
  socket.on('accountUpdated',applyAccountUpdated);
  socket.emit('createRoom',{name:state.name,device:state.device,rule:state.rule,map:state.selectedMap,sessionId:CLIENT_SESSION_ID,authToken:getAuthToken()});
  }
function showRoomWait(code){let panel=$('room-wait');if(!panel){panel=document.createElement('div');panel.id='room-wait';panel.className='room-wait';panel.innerHTML='<div class="room-wait-card"><small>PRIVATE MATCH / INVITE</small><h3>친구를 기다리는 중</h3><p>아래 6자리 코드를 친구에게 공유하세요.</p><strong id="wait-code">------</strong><button id="copy-room-code" class="solid-button">방 코드 복사</button><button id="cancel-room-wait" class="outline-button full-button">메인 메뉴로</button></div>';document.body.append(panel);$('copy-room-code').addEventListener('click',()=>navigator.clipboard?.writeText(state.roomCode).then(()=>showToast('방 코드를 복사했습니다.')).catch(()=>showToast(`방 코드: ${state.roomCode}`)));$('cancel-room-wait').addEventListener('click',backToMenu);}
  $('wait-code').textContent=code||'------';panel.classList.remove('hidden');}
function hideRoomWait(){const p=$('room-wait');if(p)p.classList.add('hidden');}
function joinOnline(){const code=$('room-code').value.trim().toUpperCase().replace(/[^A-Z0-9]/g,'');if(code.length!==6){showToast('6자리 방 코드를 입력하세요.');return;}initAudio();state.mode='online';state.name=($('player-name').value.trim()||'PLAYER').slice(0,16);state.rule=state.rule||'crossplay';state.money=450;state.hp=100;state.armor=0;state.armorTier='none';state.selfScore=0;state.enemyScore=0;state.round=0;state.currentWeapon='pistol';state.owned=new Set(['pistol','knife']);state.phase='waiting';state.roomCode='';clearBots();clearRemotePlayers();clearTrainingTargets();resetKillCam();setModeUI();updateHUD();
  const socket=io({transports:['websocket','polling'],tryAllTransports:true,upgrade:true,reconnection:true,reconnectionAttempts:Infinity,reconnectionDelay:500,reconnectionDelayMax:4000,timeout:20000});state.socket=socket;let connectCount=0;socket.on('connect',()=>{const reconnect=connectCount++>0;state.socketReady=true;updateHUD();if(!reconnect)socket.emit('joinRoom',{code,name:state.name,device:state.device,map:state.selectedMap,sessionId:CLIENT_SESSION_ID,authToken:getAuthToken()});else if(!socket.recovered&&state.roomCode)socket.emit('resumeRoom',{code:state.roomCode,sessionId:CLIENT_SESSION_ID});});socket.on('disconnect',reason=>{state.socketReady=false;updateHUD();if(state.mode==='online'&&reason!=='io client disconnect')showToast('온라인 연결을 복구하는 중입니다…',2600);});socket.on('connect_error',()=>{state.socketReady=false;showToast('온라인 서버 연결 실패. 배포된 게임 주소인지 확인하세요.',3200);});
  // Reuse identical room listeners by registering a lightweight join-mode bridge.
  socket.on('roomError',d=>showToast(d.message||'방 입장 실패',3200));socket.on('accountUpdated',applyAccountUpdated);socket.on('roomJoined',d=>{if(d.map&&state.mapId!==d.map)buildMap(d.map);state.roomCode=d.code;showRoomWait(d.code);});
  socket.on('roomResumed',d=>{if(d.map&&state.mapId!==d.map)buildMap(d.map);state.roomCode=d.code;hideRoomWait();showToast('온라인 연결이 복구됐습니다.',1800);updateHUD();});socket.on('killCamStart',d=>beginKillCam(d));
  socket.on('playerJoined',d=>{updateRemotePlayer(d.id,d.player);hideRoomWait();});socket.on('playerLeft',d=>{const r=state.remotePlayers.get(d.id);if(r){unregisterTarget(d.id);disposeGroup(r.root);state.remotePlayers.delete(d.id);}state.phase='waiting';});socket.on('playerMoved',d=>updateRemotePlayer(d.id,d));socket.on('playerWeapon',d=>updateRemoteWeaponModel(d.id,d.weapon));socket.on('playersSnapshot',d=>{for(const[id,p]of Object.entries(d||{}))if(id!==socket.id)updateRemotePlayer(id,p);});
  socket.on('roundState',d=>{clearTrainingTargets();if(d.map&&state.mapId!==d.map)buildMap(d.map);hideRoomWait();endScreen.classList.add('hidden');state.phase=d.phase;state.round=d.round;state.phaseEnd=d.endsAt;state.roundLimit=d.roundEndsAt||0;state.selfScore=d.scores?.[socket.id]||0;state.enemyScore=Object.entries(d.scores||{}).filter(([id])=>id!==socket.id).reduce((a,[,v])=>a+v,0);state.money=d.self?.money??650;state.hp=d.self?.hp??100;state.armor=d.self?.armor??0;state.armorTier=d.self?.armorTier??'none';state.currentWeapon=d.self?.weapon||'pistol';state.owned=new Set(d.self?.ownedWeapons||['pistol',...(state.currentWeapon!=='pistol'?[state.currentWeapon]:[])]);state.buyPrimaryThisRound=!!d.self?.boughtPrimary;state.pos.set(d.self?.x??0,d.self?.y??0,d.self?.z??27);state.yaw=d.self?.yaw??state.yaw;state.pitch=d.self?.pitch??0;state.reloading=false;state.reloadWeaponId=null;makeAmmoFor(state.currentWeapon,true);clearRemotePlayers();for(const[id,player]of Object.entries(d.players||{}))if(id!==socket.id)updateRemotePlayer(id,player);buildGun(state.currentWeapon);if(d.phase==='buy')openBuy();else closeBuy();$('phase-label').textContent=d.phase==='buy'?'BUY PHASE':'LIVE';updateHUD();});
  socket.on('roundPhase',d=>{state.phase=d.phase;state.phaseEnd=d.endsAt;if(d.phase==='live')state.roundLimit=d.endsAt;$('phase-label').textContent=d.phase==='buy'?'BUY PHASE':'LIVE';if(d.phase==='buy')openBuy();else closeBuy();});socket.on('selfState',d=>{state.money=d.money??state.money;state.hp=d.hp??state.hp;state.armor=d.armor??state.armor;state.armorTier=d.armorTier??state.armorTier;if(d.ownedWeapons)for(const weaponId of d.ownedWeapons)state.owned.add(weaponId);if(d.weapon&&d.weapon!==state.currentWeapon){state.currentWeapon=d.weapon;buildGun(d.weapon);}state.buyPrimaryThisRound=!!d.boughtPrimary;updateHUD();});
  socket.on('buyResult',d=>{if(!d.ok){showToast(d.message||'구매할 수 없습니다.');return;}state.money=d.money;state.armor=d.armor??state.armor;state.armorTier=d.armorTier??state.armorTier;if(d.ownedWeapons)for(const weaponId of d.ownedWeapons)state.owned.add(weaponId);if(d.weapon&&d.weapon!==state.currentWeapon){state.currentWeapon=d.weapon;makeAmmoFor(d.weapon,true);buildGun(d.weapon);}state.buyPrimaryThisRound=!!d.boughtPrimary;state.armorPurchased=!!d.armorPurchased;soundBuy();updateHUD();});socket.on('shotFx',d=>{if(d.id!==socket.id){if(d.weaponId!=='knife')addShotFx(new THREE.Vector3(d.origin.x,d.origin.y,d.origin.z),new THREE.Vector3(d.end.x,d.end.y,d.end.z),0xff718a);soundShot(d.weaponId);}});socket.on('damage',d=>{if(d.targetId===socket.id){state.hp=d.hp;state.armor=d.armor??state.armor;state.armorTier=d.armorTier??state.armorTier;updateHUD();soundHit();}if(d.targetId!==socket.id){const target=state.remotePlayers.get(d.targetId);if(target)flashCharacter(target.root);}if(d.attackerId===socket.id&&d.targetId!==socket.id){$('hit-marker').classList.remove('hidden');setTimeout(()=>$('hit-marker').classList.add('hidden'),110);soundHit();}if(d.killed&&d.attackerId===socket.id){soundKill();$('kill-banner').classList.remove('hidden');setTimeout(()=>$('kill-banner').classList.add('hidden'),900);}});socket.on('footstep',d=>{if(d.id===socket.id)return;const remote=state.remotePlayers.get(d.id);if(!remote)return;const dist=remote.root.position.distanceTo(state.pos);if(dist<23)soundFootstep({volume:Math.max(.015,.11*(1-dist/25)),remote:true});});
  socket.on('roundResult',d=>handleOnlineRoundResult(d));
}

function setupEvents(){
  document.querySelectorAll('[data-device]').forEach(b=>b.addEventListener('click',()=>setDevice(b.dataset.device)));
  document.querySelectorAll('[data-map]').forEach(b=>b.addEventListener('click',()=>selectMap(b.dataset.map)));
  document.querySelectorAll('[data-rule]').forEach(b=>b.addEventListener('click',()=>setRule(b.dataset.rule)));
  document.querySelectorAll('[data-lobby-tab]').forEach(b=>b.addEventListener('click',()=>setLobbyPage(b.dataset.lobbyTab)));
  document.querySelectorAll('[data-account-mode]').forEach(b=>b.addEventListener('click',()=>{state.accountMode=b.dataset.accountMode;accountMessage('account-auth-message',state.accountMode==='register'?'아이디와 비밀번호를 입력해 가입하세요.':'가입한 아이디와 비밀번호로 로그인하세요.');renderAccountPanel();}));
  $('account-auth-form')?.addEventListener('submit',submitAccountAuth);$('account-logout')?.addEventListener('click',logoutAccount);
  $('store-code-form')?.addEventListener('submit',redeemStoreCode);
  $('store-roll-button')?.addEventListener('click',rollStoreSkin);
  $('gacha-finish')?.addEventListener('click',closeGacha);$('gacha-close')?.addEventListener('click',closeGacha);
  $('store-bundle-grid')?.addEventListener('click',e=>{const b=e.target.closest('[data-bundle-purchase]');if(b)void buyStoreProduct('bundle',b.dataset.bundlePurchase);});
  $('store-daily-grid')?.addEventListener('click',e=>{const b=e.target.closest('[data-daily-purchase]');if(b)void buyStoreProduct('daily',b.dataset.dailyPurchase);});
  $('owned-skins-grid')?.addEventListener('click',e=>{const equip=e.target.closest('[data-equip-skin]');if(equip)void equipOwnedSkin(equip.dataset.equipSkin);const unequip=e.target.closest('[data-unequip-weapon]');if(unequip)void equipOwnedSkin('',unequip.dataset.unequipWeapon);});
  document.querySelectorAll('[data-play-mode]').forEach(b=>b.addEventListener('click',()=>setPlayMode(b.dataset.playMode)));
  $('map-prev').addEventListener('click',()=>cycleSelectedMap(-1));$('map-next').addEventListener('click',()=>cycleSelectedMap(1));
  $('start-battle').addEventListener('click',()=>state.playMode==='online'?beginOnline():startTraining());
  $('join-room').addEventListener('click',joinOnline);
  $('room-code').addEventListener('input',e=>{e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);});
  $('training-weapon-button').addEventListener('click',openTrainingWeapons);$('close-training-weapons').addEventListener('click',()=>$('training-weapon-menu').classList.add('hidden'));
  $('training-weapon-menu').addEventListener('click',e=>{if(e.target===$('training-weapon-menu'))$('training-weapon-menu').classList.add('hidden');});
  $('open-buy').addEventListener('click',()=>{if(state.mode==='online'&&state.phase==='buy')openBuy();});$('touch-buy').addEventListener('click',()=>{if(state.mode==='online'&&state.phase==='buy')openBuy();});$('close-buy').addEventListener('click',closeBuy);$('buy-start').addEventListener('click',()=>{closeBuy();if(state.mode==='ai')beginLocalLive();});
  $('resume-game').addEventListener('click',()=>{state.paused=false;pauseMenu.classList.add('hidden');if(state.device==='pc'&&state.mode!=='menu')canvas.requestPointerLock?.();});
  $('leave-game').addEventListener('click',backToMenu);$('end-menu').addEventListener('click',backToMenu);$('next-round').addEventListener('click',()=>{if(state.mode==='ai')nextLocalRound();else if(state.mode==='online'&&state.phase==='ended'&&!state.matchOver&&state.socketReady){$('next-round').disabled=true;$('next-round').textContent='다음 라운드로 이동 중…';state.socket.emit('nextRound');}});
  $('quality-select').addEventListener('change',e=>{const q=e.target.value;renderer.shadowMap.enabled=q==='high';renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,q==='low'?.85:q==='medium'?1.25:1.75));renderer.setSize(window.innerWidth,window.innerHeight);});
  window.addEventListener('keydown',e=>{
    if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();
    if(e.code==='Escape'){
      if(!$('training-weapon-menu').classList.contains('hidden')){$('training-weapon-menu').classList.add('hidden');return;}
      if(!buyMenu.classList.contains('hidden')){closeBuy();return;}
      if(!pauseMenu.classList.contains('hidden')){state.paused=false;pauseMenu.classList.add('hidden');return;}
      if(state.mode!=='menu'&&state.phase!=='ended'&&state.phase!=='matchover'){state.paused=true;pauseMenu.classList.remove('hidden');if(document.pointerLockElement)document.exitPointerLock();}return;
    }
    if(state.mode==='menu'||state.phase==='ended'||state.paused)return;
    if(e.code==='Enter'&&state.phase==='live'){state.weaponMotion.inspectAt=performance.now();showToast('무기 관찰',700);return;}
    state.keys.add(e.code);
    if(e.code==='KeyR')reloadWeapon();if(e.code==='KeyQ')toggleZoom();if(e.code==='KeyT'&&state.mode==='training')openTrainingWeapons();if(/^Digit[1-9]$/.test(e.code))switchWeaponByNumber(Number(e.code.slice(-1)));
    if(e.code==='KeyB'&&state.phase==='buy')openBuy();
  });window.addEventListener('keyup',e=>state.keys.delete(e.code));window.addEventListener('blur',()=>{state.keys.clear();state.fireHeld=false;});
  window.addEventListener('pointerup',()=>{state.fireHeld=false;state.sniperMustRelease=false;});window.addEventListener('pointercancel',()=>{state.fireHeld=false;state.sniperMustRelease=false;});
  canvas.addEventListener('pointerdown',e=>{if(state.mode==='menu'||state.device==='mobile'||state.paused)return;initAudio();if(document.pointerLockElement!==canvas){canvas.requestPointerLock?.();}if(e.button===0){state.fireHeld=true;state.sniperMustRelease=false;doShoot();}if(e.button===2)toggleZoom();});
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  document.addEventListener('pointerlockchange',()=>{state.pointerLocked=document.pointerLockElement===canvas;});
  document.addEventListener('mousemove',e=>{if(state.device!=='pc'||document.pointerLockElement!==canvas||state.phase!=='live'||state.paused||state.killCamActive)return;state.yaw-=e.movementX*.00215;state.pitch-=e.movementY*.00215;state.pitch=THREE.MathUtils.clamp(state.pitch,-1.28,1.28);});
  $('touch-fire').addEventListener('pointerdown',e=>{e.preventDefault();initAudio();state.fireHeld=true;state.sniperMustRelease=false;$('touch-fire').setPointerCapture?.(e.pointerId);doShoot();});$('touch-fire').addEventListener('pointerup',()=>{state.fireHeld=false;state.sniperMustRelease=false;});$('touch-fire').addEventListener('pointercancel',()=>{state.fireHeld=false;state.sniperMustRelease=false;});$('touch-scope').addEventListener('pointerdown',e=>{e.preventDefault();toggleZoom();});$('touch-jump').addEventListener('pointerdown',e=>{e.preventDefault();state.keys.add('Space');});$('touch-jump').addEventListener('pointerup',()=>state.keys.delete('Space'));$('touch-reload').addEventListener('pointerdown',e=>{e.preventDefault();reloadWeapon();});$('touch-switch').addEventListener('pointerdown',e=>{e.preventDefault();if(state.mode==='training'){openTrainingWeapons();return;}const current=WEAPONS.findIndex(w=>w.id===state.currentWeapon);for(let i=1;i<=WEAPONS.length;i++){const n=(current+i)%WEAPONS.length;if(state.owned.has(WEAPONS[n].id)){setWeapon(WEAPONS[n].id);break;}}});
  const pad=$('move-pad'),stick=$('move-stick');let padPointer=null;
  pad.addEventListener('pointerdown',e=>{e.preventDefault();padPointer=e.pointerId;pad.setPointerCapture(e.pointerId);updatePad(e);});pad.addEventListener('pointermove',e=>{if(e.pointerId===padPointer)updatePad(e);});
  const resetPad=()=>{padPointer=null;state.touchMove.x=0;state.touchMove.y=0;stick.style.transform='translate(0px,0px)';};pad.addEventListener('pointerup',resetPad);pad.addEventListener('pointercancel',resetPad);
  function updatePad(e){const r=pad.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;let x=(e.clientX-cx)/(r.width*.36),y=(e.clientY-cy)/(r.height*.36);const l=Math.hypot(x,y);if(l>1){x/=l;y/=l;}state.touchMove.x=x;state.touchMove.y=y;stick.style.transform=`translate(${x*27}px,${y*27}px)`;}
  const look=$('look-zone');look.addEventListener('pointerdown',e=>{if(state.device!=='mobile')return;e.preventDefault();look.setPointerCapture(e.pointerId);state.mobileLook={id:e.pointerId,x:e.clientX,y:e.clientY};initAudio();});
  look.addEventListener('pointermove',e=>{if(state.killCamActive||state.phase!=='live'||!state.mobileLook||state.mobileLook.id!==e.pointerId)return;const dx=e.clientX-state.mobileLook.x,dy=e.clientY-state.mobileLook.y;state.mobileLook.x=e.clientX;state.mobileLook.y=e.clientY;state.yaw-=dx*.006;state.pitch-=dy*.005;state.pitch=THREE.MathUtils.clamp(state.pitch,-1.22,1.22);});
  const endLook=e=>{if(state.mobileLook&&state.mobileLook.id===e.pointerId)state.mobileLook=null;};look.addEventListener('pointerup',endLook);look.addEventListener('pointercancel',endLook);
  window.addEventListener('resize',()=>{camera.aspect=window.innerWidth/window.innerHeight;camera.updateProjectionMatrix();renderer.setSize(window.innerWidth,window.innerHeight);resizeWeaponPreview();});
}

function updateWorld(dt,now){
  if(state.mode==='menu'){
    const mapIds=['arena','palace','city'];const cycle=Math.floor(now/10500)%mapIds.length;
    if(state.lobbyMapCycle!==cycle){state.lobbyMapCycle=cycle;const id=mapIds[cycle];canvas.classList.remove('lobby-scene-refresh');void canvas.offsetWidth;buildMap(id);canvas.classList.add('lobby-scene-refresh');setTimeout(()=>canvas.classList.remove('lobby-scene-refresh'),1150);const n=String(cycle+1).padStart(2,'0');const label=$('lobby-background-name');if(label)label.textContent=`MAP ${n} / ${cycle===0?'HELIX YARD':cycle===1?'GYEONGBOKGUNG COURT':'METRO DISTRICT'}`;}
    const radius=state.mapId==='city'?73:state.mapId==='palace'?57:43;const orbit=now*.000055;
    camera.position.set(Math.sin(orbit)*radius,Math.max(13,radius*.36+Math.sin(orbit*.7)*2),Math.cos(orbit)*radius);camera.lookAt(0,2,0);gunRoot.visible=false;
    return;
  }
  if(state.mode==='online'){
    if(state.phase==='live'&&!state.paused)movePlayer(dt);
    for(const [id,r]of state.remotePlayers){
      const beforeX=r.root.position.x,beforeZ=r.root.position.z;r.root.position.lerp(r.target,Math.min(1,dt*12));r.root.rotation.y=r.yaw;
      const fallAt=r.root.userData.killFallAt;if(fallAt){const fallT=Math.min(1,(now-fallAt)/420);r.root.rotation.z=(r.root.userData.killFallStartZ||0)+Math.sin(fallT*Math.PI/2)*1.34*(r.root.userData.killFallDirection||1);r.root.position.y=(r.root.userData.killFallStartY||0)-Math.sin(fallT*Math.PI/2)*.22;continue;}
      const moving=Math.hypot(r.root.position.x-beforeX,r.root.position.z-beforeZ)>.001;
      const gait=r.root.userData;if(gait?.legs&&gait?.arms){if(moving){gait.walkPhase=(gait.walkPhase||0)+dt*12;const swing=Math.sin(gait.walkPhase)*.52;gait.legs[0].rotation.x=swing;gait.legs[1].rotation.x=-swing;gait.arms[0].rotation.x=-.62-swing*.33;gait.arms[1].rotation.x=-.62+swing*.33;r.root.position.y=(r.target.y||0)+Math.abs(Math.sin(gait.walkPhase*2))*.035;}else{gait.legs[0].rotation.x*=.75;gait.legs[1].rotation.x*=.75;gait.arms[0].rotation.x+=( -.62-gait.arms[0].rotation.x)*.25;gait.arms[1].rotation.x+=( -.62-gait.arms[1].rotation.x)*.25;r.root.position.y+=((r.target.y||0)-r.root.position.y)*.25;}}
    }
  }else if(state.mode==='training'){
    if(state.phase==='live'&&!state.paused)movePlayer(dt);
    updateTrainingTargets(Date.now());
  }else{
    if(state.phase==='live'&&!state.paused){movePlayer(dt);updateAI(dt);}
  }
  if(state.mode!=='menu'){
    state.recoilHeat=Math.max(0,state.recoilHeat-dt*2.15);state.viewKick=Math.max(0,state.viewKick-dt*.72);
    const bob=state.walkIntensity>0?Math.abs(Math.sin(state.walkCycle*2))*.038*state.walkIntensity:0;
    const sway=state.walkIntensity>0?Math.sin(state.walkCycle)*.022*state.walkIntensity:0;
    if(state.killCamActive&&state.mode==='online'&&state.killCam&&state.socket?.id===state.killCam.victimId){const k=state.killCam.killer;camera.position.set(k.x,(k.y||0)+1.58,k.z);camera.rotation.order='YXZ';camera.rotation.y=k.yaw||0;camera.rotation.x=THREE.MathUtils.clamp(k.pitch||0,-1.3,1.3);gunRoot.visible=false;}else{camera.position.set(state.pos.x+sway*.24,state.pos.y+1.58+bob,state.pos.z);camera.rotation.order='YXZ';camera.rotation.y=state.yaw;camera.rotation.x=THREE.MathUtils.clamp(state.pitch+state.viewKick,-1.3,1.3);}
    const activeWeapon=currentWeapon();
    // Weapon draw, reload, recoil, inspect and melee-swing poses are procedural and allocation-free per frame.
    const motion=state.weaponMotion, clamp01=v=>Math.max(0,Math.min(1,v)), easeOut=v=>1-Math.pow(1-v,3);
    const drawT=clamp01((now-motion.drawAt)/(reduceMotion?80:440)), drawOffset=(1-easeOut(drawT));
    const fireAge=now-motion.fireAt, fireKick=fireAge>=0&&fireAge<180?Math.exp(-fireAge/52):0;
    let inspectX=0,inspectY=0,inspectZ=0,inspectRot=0;
    if(motion.inspectAt&&now-motion.inspectAt<1500){const it=(now-motion.inspectAt)/1500;inspectY=Math.sin(Math.PI*it)*.085;inspectX=Math.sin(Math.PI*it)*.13;inspectRot=Math.sin(Math.PI*it)*.55;}
    const reloadProgress=state.reloading&&activeWeapon.reload>0?clamp01((now-(motion.reloadAt||now))/(activeWeapon.reload*1000)):0;
    const reloadWave=state.reloading?Math.sin(Math.PI*reloadProgress):0;
    const knifeAge=now-motion.knifeAt, knifeWave=activeWeapon.id==='knife'&&knifeAge>=0&&knifeAge<310?Math.sin(Math.PI*clamp01(knifeAge/310)):0;
    gunRoot.position.x=(state.device==='mobile'?.03:0)+sway+inspectX+reloadWave*(activeWeapon.slot==='sidearm'?.10:.035);
    gunRoot.position.y=bob*.65+drawOffset*.48+inspectY-reloadWave*.09;
    gunRoot.position.z=state.viewKick*1.2+drawOffset*.65+fireKick*.13;
    gunRoot.rotation.x=-fireKick*.10+reloadWave*.11+knifeWave*.16;
    gunRoot.rotation.y=inspectRot+reloadWave*.05;
    gunRoot.rotation.z=-drawOffset*.42+Math.sin(state.walkCycle)*.018*state.walkIntensity+inspectRot*.45+reloadWave*(activeWeapon.slot==='sidearm'?.16:.06)-knifeWave*.88;
    // Prime 1 karambit gets a distinct inspect spin. This animates the actual custom GLB
    // while keeping the original model orientation outside the 1.5 s inspect window.
    const heldSkinModel=gunRoot.userData.customWeaponModel;
    if(heldSkinModel&&activeWeapon.id==='knife'&&state.account?.equippedSkins?.knife==='prime_knife'){
      const inspectAge=now-motion.inspectAt;
      if(motion.inspectAt&&inspectAge>=0&&inspectAge<1500){
        const inspectT=clamp01(inspectAge/1500);
        const easedSpin=inspectT*inspectT*(3-2*inspectT);
        heldSkinModel.rotation.z=Math.PI*2*easedSpin;
      }else heldSkinModel.rotation.z=0;
    }
    const hands=gunRoot.userData||{};const showSupportHand=activeWeapon.slot==='primary'||(state.reloading&&activeWeapon.slot==='sidearm');
    if(hands.leftSleeve){hands.leftSleeve.visible=showSupportHand;const br=hands.leftSleeve.userData.baseRotation;if(br){hands.leftSleeve.rotation.x=br.x+reloadWave*.42+fireKick*.12;hands.leftSleeve.rotation.z=br.z-reloadWave*.28;}}
    if(hands.leftHand){hands.leftHand.visible=showSupportHand;const br=hands.leftHand.userData.baseRotation;if(br){hands.leftHand.rotation.x=br.x+reloadWave*.52;hands.leftHand.rotation.z=br.z-reloadWave*.22;}}
    if(hands.rightSleeve){const br=hands.rightSleeve.userData.baseRotation;if(br)hands.rightSleeve.rotation.x=br.x-fireKick*.22+reloadWave*.12;}
    if(hands.rightHand){const br=hands.rightHand.userData.baseRotation;if(br)hands.rightHand.rotation.x=br.x-fireKick*.27+reloadWave*.18;}
    // Magazine removal/insertion phases make the reload readable instead of only bobbing the weapon.
    const modelMagazines=hands.customWeaponModel?.userData?.magazineNodes || [];
    if(modelMagazines.length){
      const removing=state.reloading&&reloadProgress>=.22&&reloadProgress<.43;
      const absent=state.reloading&&reloadProgress>=.43&&reloadProgress<.58;
      const inserting=state.reloading&&reloadProgress>=.58&&reloadProgress<.84;
      const dx=removing?((reloadProgress-.22)/.21)*.08:inserting?((1-easeOut(clamp01((reloadProgress-.58)/.26)))*.08):0;
      const dy=removing?((reloadProgress-.22)/.21)*.27:inserting?((1-easeOut(clamp01((reloadProgress-.58)/.26)))*.27):0;
      const rz=removing?-((reloadProgress-.22)/.21)*.18:inserting?-(1-clamp01((reloadProgress-.58)/.26))*.18:0;
      for(const part of modelMagazines){const base=part.userData.basePosition||part.position.clone();part.position.copy(base);part.position.y-=dy;part.position.z+=dx;part.rotation.z=rz;part.visible=!absent;}
      if(hands.reloadMagazine)hands.reloadMagazine.visible=false;
      if(hands.reloadInsertMagazine)hands.reloadInsertMagazine.visible=false;
    } else if(hands.customWeaponModel){
      // Tubular shotgun feeds, revolver cylinders and the knife do not use a detachable box magazine.
      if(hands.reloadMagazine)hands.reloadMagazine.visible=false;
      if(hands.reloadInsertMagazine)hands.reloadInsertMagazine.visible=false;
    } else {
      if(hands.reloadMagazine){const base=hands.reloadMagazine.userData.basePosition||new THREE.Vector3(.32,-.405,-.62);hands.reloadMagazine.position.copy(base);const removing=reloadProgress>=.22&&reloadProgress<.43;const magazineAbsent=reloadProgress>=.43&&reloadProgress<.58;const inserting=reloadProgress>=.58&&reloadProgress<.84;hands.reloadMagazine.visible=!magazineAbsent&&!inserting;if(removing){const k=(reloadProgress-.22)/.21;hands.reloadMagazine.position.x-=k*.10;hands.reloadMagazine.position.y-=k*.25;hands.reloadMagazine.rotation.x=k*.45;}else hands.reloadMagazine.rotation.x=0;}
      if(hands.reloadInsertMagazine){const entering=state.reloading&&reloadProgress>=.48&&reloadProgress<.84;hands.reloadInsertMagazine.visible=entering;if(entering){const k=clamp01((reloadProgress-.48)/.36);const slot=hands.reloadInsertMagazine.userData.slotPosition;hands.reloadInsertMagazine.position.set(.13+(slot.x-.13)*easeOut(k),-.68+(slot.y+.68)*easeOut(k),-.51+(slot.z+.51)*easeOut(k));hands.reloadInsertMagazine.rotation.x=(1-k)*-.28;}else hands.reloadInsertMagazine.rotation.x=0;}
    }
    gunRoot.visible=state.phase==='live'||state.phase==='buy';
    // A burst trigger sends three paced server-authoritative bullets. Sniper still requires a fresh click.
    if(state.burstRemaining>0&&now>=state.burstNextAt&&state.phase==='live'&&!state.paused)doShoot(true);
    else if(state.fireHeld&&!state.sniperMustRelease&&activeWeapon.id!=='sniper'&&state.phase==='live'&&!state.paused&&now-state.lastShot>=activeWeapon.rate*1000)doShoot();
    completeReload(now);
    if(state.phase==='buy'&&Date.now()>=state.phaseEnd&&state.mode==='ai')beginLocalLive();
    if(state.mode==='ai'&&state.phase==='live'&&Date.now()>=state.roundLimit)endLocalRound(state.hp>0,'시간 종료');
    if(state.phase==='buy')$('buy-countdown').textContent=`${Math.max(0,Math.ceil((state.phaseEnd-Date.now())/1000))}초`;
    if(state.mode==='training')$('match-timer').textContent='∞';
    else {const remaining=Math.max(0,Math.ceil(((state.phase==='buy'?state.phaseEnd:state.phase==='live'?state.roundLimit:Date.now())-Date.now())/1000));$('match-timer').textContent=`${String(Math.floor(remaining/60)).padStart(2,'0')}:${String(remaining%60).padStart(2,'0')}`;}
  }
  if(muzzleMesh&&now>state.muzzleUntil)muzzleMesh.visible=false;
  for(let i=state.killEffects.length-1;i>=0;i--){const fx=state.killEffects[i],t=(now-fx.started)/fx.duration;if(t>=1){scene.remove(fx.group);fx.group.traverse(o=>{o.geometry?.dispose();if(Array.isArray(o.material))o.material.forEach(m=>m.dispose());else o.material?.dispose();});state.killEffects.splice(i,1);continue;}if(fx.type==='ghost-lift'){fx.group.position.y=fx.origin.y+t*5.2;fx.group.position.x=fx.origin.x+Math.sin(t*5)*.28;fx.group.traverse(o=>{if(o.material&&'opacity' in o.material)o.material.opacity=Math.max(0,.9-t*.9);});}else{fx.group.position.y=fx.origin.y+t*2.1;fx.group.scale.setScalar(1+t*.45);fx.group.traverse(o=>{if(o.material&&'opacity' in o.material)o.material.opacity=Math.max(0,.8-t*.8);});}}
  for(let i=state.shotFx.length-1;i>=0;i--){const fx=state.shotFx[i];if(now>=fx.expires){scene.remove(fx.line);fx.geo.dispose();fx.mat.dispose();state.shotFx.splice(i,1);}}
}
function animate(now){requestAnimationFrame(animate);const dt=Math.min(.05,(now-state.lastFrame)/1000||0);state.lastFrame=now;updateWorld(dt,now);
  state.fpsFrames++;if(now-state.fpsStamp>450){$('fps-value').textContent=Math.round(state.fpsFrames*1000/(now-state.fpsStamp||450));state.fpsFrames=0;state.fpsStamp=now;}
  renderer.render(scene,camera);
  if(weaponPreviewRenderer && state.mode==='menu' && state.lobbyPage==='weapons' && weaponPreviewScene && weaponPreviewCamera){
    if(weaponPreviewModelRoot && !reduceMotion) weaponPreviewModelRoot.rotation.y += dt*.28;
    weaponPreviewRenderer.render(weaponPreviewScene,weaponPreviewCamera);
  }
}

buildMap('arena');setDevice(state.device);setRule('crossplay');selectMap('arena');setPlayMode('training');setLobbyPage('play');buildGun('pistol');setupEvents();renderLobbyWeapons();updateHUD();void loadStoredAccount();requestAnimationFrame(animate);loadWeaponModels();

if (import.meta.env.PROD && 'serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(() => {}); }
