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
const SESSION_KEY = 'neon-strike-session-v1';
let CLIENT_SESSION_ID;
try { CLIENT_SESSION_ID = sessionStorage.getItem(SESSION_KEY); if (!CLIENT_SESSION_ID) { CLIENT_SESSION_ID = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`); sessionStorage.setItem(SESSION_KEY, CLIENT_SESSION_ID); } } catch { CLIENT_SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

const WEAPONS = [
  { id:'pistol', name:'ATLAS PISTOL', short:'ATLAS', type:'SIDEARM', slot:'sidearm', price:0, damage:26, head:1.65, rate:0.28, mag:12, reserve:36, reload:1.15, spread:0.006, range:55, control:8, color:0xb8c8d9, desc:'안정적인 기본 권총' },
  { id:'revolver', name:'IRONCLAD .45', short:'IRONCLAD', type:'HEAVY SIDEARM', slot:'sidearm', price:550, damage:47, head:1.9, rate:0.48, mag:6, reserve:24, reload:1.75, spread:0.0035, range:62, control:8, color:0xd9ac70, desc:'6발 실린더 · 강력한 단발' },
  { id:'smg', name:'VIPER SMG', short:'VIPER', type:'SMG', slot:'primary', price:850, damage:17, head:1.45, rate:0.085, mag:30, reserve:90, reload:1.45, spread:0.023, range:25, control:5, color:0x55e6d2, desc:'근거리 고연사 · 낮은 피해' },
  { id:'shotgun', name:'BREACH SG', short:'BREACH', type:'SHOTGUN', slot:'primary', price:1100, damage:10, pellets:7, head:1.2, rate:0.78, mag:7, reserve:21, reload:1.7, spread:0.075, range:13, control:3, color:0xd9a36a, desc:'7발 산탄 · 근거리 제압' },
  { id:'rifle', name:'VANTAGE AR', short:'VANTAGE', type:'ASSAULT RIFLE', slot:'primary', price:1950, damage:32, head:1.6, rate:0.12, mag:30, reserve:60, reload:1.55, spread:0.012, range:50, control:7, color:0x8aafff, desc:'중거리 균형형 · 우클릭 정밀 조준', scopeFov:54 },
  { id:'dmr', name:'RAIL DMR', short:'RAIL', type:'MARKSMAN', slot:'primary', price:2200, damage:44, head:1.75, rate:0.42, mag:12, reserve:36, reload:1.65, spread:0.003, range:75, control:9, color:0x9ec4d6, desc:'정밀 단발 · 2배율 조준', scopeFov:38 },
  { id:'sniper', name:'LONGSHOT SR', short:'LONGSHOT', type:'SNIPER', slot:'primary', price:3000, damage:78, head:1.9, rate:1.05, mag:5, reserve:15, reload:2.0, spread:0.001, range:100, control:10, color:0xdfb5ff, desc:'고배율 원형 스코프 · 장거리 저격', scopeFov:20 },
  { id:'lmg', name:'TITAN LMG', short:'TITAN', type:'LMG', slot:'primary', price:2500, damage:22, head:1.5, rate:0.105, mag:60, reserve:120, reload:2.4, spread:0.022, range:42, control:4, color:0xe6c36e, desc:'대용량 탄창 · 긴 재장전' },
  { id:'burst', name:'ION BURST', short:'ION', type:'BURST RIFLE', slot:'primary', price:1600, damage:23, head:1.65, rate:0.32, mag:24, reserve:72, reload:1.5, spread:0.009, range:45, control:8, color:0x85e5ff, desc:'3점사 · 우클릭 정밀 조준', scopeFov:50 },
];
const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map(w => [w.id, w]));
const platformName = { pc:'PC', mobile:'MOBILE' };

const state = {
  device: matchMedia('(pointer:coarse)').matches ? 'mobile' : 'pc',
  rule:'crossplay', difficulty:'normal', name:'PLAYER', mode:'menu', phase:'menu', playMode:'training', selectedMap:'arena', mapId:'arena', mapBounds:31.8, lobbyPage:'play', lobbyMapCycle:-1, lobbySelectedWeapon:'rifle',
  round:0, selfScore:0, enemyScore:0, money:450, hp:100, armor:0, armorTier:'none',
  currentWeapon:'pistol', owned:new Set(['pistol']), ammo:{},
  pos:new THREE.Vector3(0,0,15), velocityY:0, yaw:0, pitch:0,
  keys:new Set(), touchMove:{x:0,y:0}, canJump:true,
  lastShot:0, reloading:false, reloadUntil:0, lastFrame:performance.now(), fpsFrames:0, fpsStamp:0,
  phaseEnd:0, roundLimit:0, botList:[], trainingTargets:[], remotePlayers:new Map(), shotFx:[], muzzleUntil:0,
  roomCode:'', socket:null, socketReady:false, paused:false, resultShown:false,
  buyPrimaryThisRound:false, armorPurchased:false, matchOver:false, botFireTimers:[],
  pointerLocked:false, mobileLook:null, audio:null, noiseBuffer:null, currentToastTimer:0, zoomed:false, baseFov:76, localNextRoundTimer:null,
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
function addBox(x,y,z,w,h,d,mat,{collision=true,accent=null,rotation=0,rotationX=0,rotationZ=0}={}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat);
  mesh.position.set(x,y+h/2,z); mesh.rotation.set(rotationX,rotation,rotationZ); mesh.castShadow=true; mesh.receiveShadow=true; worldRoot.add(mesh);
  if (collision) { colliders.push({x,z,w,d,h}); obstacleMeshes.push(mesh); }
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
  addBox(-31,0,-29,14,7,16,materials.wallDark);addBox(-31,7,-29,14,.2,16,materials.wall,{collision:false});
  elevatedPlatforms.push({xMin:-38,xMax:-24,zMin:-37,zMax:-20.5,height:7});
  stairRamps.push({xMin:-33.2,xMax:-28.8,zMin:-20.5,zMax:-8,height:7});
  for(let i=0;i<12;i++){const h=(i+1)*7/12;addBox(-31,h-.24,-8-(i+.5),3.8,.24,1.04,materials.wall,{collision:false});}
  // Roof access for a second, lower block on the eastern side.
  addBox(31,0,18,13,5.5,15,materials.wall);addBox(31,5.5,18,13,.2,15,materials.white,{collision:false});
  elevatedPlatforms.push({xMin:24.5,xMax:37.5,zMin:10.5,zMax:26.5,height:5.5});
  stairRamps.push({xMin:29,xMax:33,zMin:26.5,zMax:38,height:5.5});
  for(let i=0;i<11;i++){const h=(i+1)*5.5/11;addBox(31,h-.22,38-(i+.5)*1.15,4,.22,1.18,materials.wall,{collision:false});}
  // Small buildings create alleys and crossfire angles.
  const buildings=[[-43,-6,12,17,8],[-16,-31,9,12,5],[18,-31,15,12,8],[45,-17,10,16,7],[-45,22,13,18,9],[13,40,18,10,6],[43,39,15,13,8],[-12,39,13,11,6]];
  for(const [x,z,w,d,h] of buildings){
    addBox(x,0,z,w,h,d,materials.wallDark);
    addBox(x,Math.max(1,h*.35),z-d/2-.05,w*.72,Math.min(1.4,h*.18),.12,glassMat,{collision:false});
    addBox(x,Math.max(1,h*.35)+.9,z-d/2-.1,w*.76,.14,.22,materials.red,{collision:false});
  }
  // Shops and striped awnings as practical waist-high street cover.
  for(const [x,z,c] of [[-20,-4,0xc66c49],[20,4,0x3b9c92],[-19,20,0xc7a45b],[19,-19,0x6a82b8]]){
    addBox(x,0,z,10,3.4,6,materials.wall);
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
  const chosen=['weapons','shop','play','skins','account'].includes(page)?page:'play';state.lobbyPage=chosen;
  document.querySelectorAll('[data-lobby-tab]').forEach(b=>b.classList.toggle('active',b.dataset.lobbyTab===chosen));
  $('lobby-play-view')?.classList.toggle('hidden',chosen!=='play');
  $('lobby-weapons-view')?.classList.toggle('hidden',chosen!=='weapons');
  $('lobby-coming-soon-view')?.classList.toggle('hidden',['play','weapons'].includes(chosen));
  if(['shop','skins','account'].includes(chosen)){
    const titles={shop:'상점 · 개발 중입니다',skins:'스킨 · 개발 중입니다',account:'계정 · 개발 중입니다'};
    $('coming-soon-title').textContent=titles[chosen];
    $('coming-soon-copy').textContent='이 인터페이스는 다음 업데이트에서 추가될 예정입니다.';
  }
  if(chosen==='weapons')renderLobbyWeapons();
}
function renderLobbyWeapons(){
  const grid=$('lobby-weapon-cards');if(!grid)return;grid.innerHTML='';
  const selected=WEAPON_BY_ID[state.lobbySelectedWeapon]||WEAPON_BY_ID.rifle;
  $('showcase-weapon-name').textContent=selected.name;$('showcase-weapon-desc').textContent=selected.desc;$('showcase-power').textContent=selected.damage;$('showcase-control').textContent=`${selected.control} / 10`;$('showcase-mag').textContent=selected.mag;
  const model=$('lobby-weapon-showcase')?.querySelector('.weapon-showcase-model');if(model){model.className=`weapon-showcase-model ${selected.id}-showcase`;model.style.setProperty('--showcase-color',`#${selected.color.toString(16).padStart(6,'0')}`);}
  for(const w of WEAPONS){
    const button=document.createElement('button');button.className='lobby-weapon-card'+(state.lobbySelectedWeapon===w.id?' selected':'');
    button.innerHTML=`<span class="weapon-card-index">${String(WEAPONS.indexOf(w)+1).padStart(2,'0')} / ${w.type}</span><span class="weapon-mini-stage ${w.id}-showcase"><span class="weapon-mini-model" style="--showcase-color:#${w.color.toString(16).padStart(6,'0')}"><i></i><b></b><em></em><span></span></span></span><b>${w.name}</b><small>${w.desc}</small><span class="weapon-card-stats"><em>DMG ${w.damage}</em><em>MAG ${w.mag}</em></span>`;
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
function buildGun(id) {
  if(state.zoomed) setZoom(false);
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
    const scopeBody=box(.32,-.105,-.60,.22,.085,.20,darkMat);
    cylinder(.32,-.055,-.60,.055,.055,.055,accentMat,'x');
    cylinder(.32,-.055,-.60,.042,.042,.06,mainMat,'x');
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
    const root=makeCharacter({color:0xff6c85,accent:0x52233a,onlineId:id,name:data.name||'OPPONENT'});root.position.set(data.x||0,data.y||0,data.z||0);scene.add(root);registerTarget(root,id);
    remote={id,root,target:new THREE.Vector3(data.x||0,data.y||0,data.z||0),yaw:data.yaw||0,name:data.name||'OPPONENT',hp:data.hp??100};state.remotePlayers.set(id,remote);
  }
  remote.target.set(data.x||0,data.y||0,data.z||0);remote.yaw=data.yaw||0;remote.name=data.name||remote.name;if(data.hp!=null)remote.hp=data.hp;
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
function setModeUI(){menu.classList.add('hidden');hud.classList.remove('hidden');buyMenu.classList.add('hidden');pauseMenu.classList.add('hidden');endScreen.classList.add('hidden');state.paused=false;const trainingButton=$('training-weapon-button');if(trainingButton)trainingButton.classList.toggle('hidden',state.mode!=='training');}
function backToMenu(){
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
  if(!state.owned.has(id)){if(notify)showToast('구매한 무기만 장착할 수 있어요. 구매 단계에서 구입하세요.');return;}
  if(state.mode==='online'){
    if(!state.socketReady||!state.socket){if(notify)showToast('서버에 연결 중입니다.');return;}
    if(id===state.currentWeapon)return;
    state.socket.emit('equipWeapon',{weaponId:id});return;
  }
  state.currentWeapon=id;buildGun(id);updateHUD();if(notify)showToast(`${WEAPON_BY_ID[id].name} 장착`);
}
function updateHUD(){
  $('health-value').textContent=Math.max(0,Math.ceil(state.hp));$('health-fill').style.width=`${Math.max(0,state.hp)}%`;$('armor-value').textContent=Math.max(0,Math.ceil(state.armor));const armorLabel=$('armor-tier-label');if(armorLabel)armorLabel.textContent=state.armorTier==='heavy'?'HEAVY':state.armorTier==='light'?'LIGHT':'NONE';
  $('money-value').textContent=state.money.toLocaleString('en-US');$('buy-money').textContent=state.money.toLocaleString('en-US');
  const shopAvailable=state.mode!=='menu'&&state.phase==='buy';$('open-buy').classList.toggle('hidden',!shopAvailable);$('touch-buy').classList.toggle('hidden',!shopAvailable);
  const w=currentWeapon(),a=state.ammo[w.id]||{mag:w.mag,reserve:w.reserve};
  $('weapon-class').textContent=w.type;$('weapon-name').textContent=w.name;$('weapon-index').textContent=`${String(WEAPONS.findIndex(x=>x.id===w.id)+1).padStart(2,'0')} / ${String(WEAPONS.length).padStart(2,'0')}`;
  $('weapon-stat').textContent=`CONTROL / ${w.control.toFixed(1)}`;$('ammo-current').textContent=a.mag;$('ammo-reserve').textContent=a.reserve;
  const bars=$('weapon-stat-bars');bars.querySelectorAll('i').forEach((i,index)=>i.classList.toggle('on',index<Math.max(1,Math.round(w.control/2))));
  $('self-score').textContent=state.selfScore;$('enemy-score').textContent=state.enemyScore;$('round-label').textContent=`ROUND ${String(Math.max(1,state.round)).padStart(2,'0')}`;
  $('net-label').textContent=state.mode==='online'?(state.socketReady?'ONLINE / ROOM '+state.roomCode:'RECONNECTING...'):state.mode==='training'?'TRAINING RANGE':'READY';$('net-dot').classList.toggle('offline',state.mode==='online'&&!state.socketReady);
  $('objective-label').textContent=state.mode==='training'?'SHOOT TARGETS · 100 DAMAGE TO RESET':`FIRST TO 6 ROUNDS · ${state.selfScore}-${state.enemyScore}`;
  renderBuyList();
}

function renderBuyList(){
  const list=$('buy-list');if(!list)return;list.innerHTML='';
  for(const w of WEAPONS){
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
  state.round++;state.phase='buy';state.hp=100;if(state.armor<=0)state.armorTier='none';state.velocityY=0;const spawn=getSpawn(state.mapId,0);state.pos.set(spawn.x,0,spawn.z);state.yaw=spawn.yaw;state.pitch=0;state.phaseEnd=Date.now()+12000;state.roundLimit=state.phaseEnd+90000;
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
  const z=MAP_META[state.mapId]?.spawn??27;
  const dummies=[{x:-6,z:z-5},{x:6,z:z-5},{x:-11,z:z-10},{x:11,z:z-10}];
  dummies.forEach((pt,i)=>{
    const id=`practice-dummy-${i+1}`,root=makeCharacter({color:i%2?0xcbd8e0:0x9bb4c4,accent:0x293b4b,name:`DUMMY ${String(i+1).padStart(2,'0')}`});
    root.position.set(pt.x,0,pt.z);root.rotation.y=Math.PI;scene.add(root);registerTarget(root,id);state.trainingTargets.push({id,root,hp:100,maxHp:100,alive:true,respawnAt:0,name:`사람 더미 ${i+1}`});
  });
  // Stationary concentric paper targets at several heights.
  const boardPositions=[{x:-10,z:z-8,y:1.65},{x:0,z:z-8,y:1.65},{x:10,z:z-8,y:1.65},{x:0,z:z-14,y:2.5}];
  boardPositions.forEach((pt,i)=>{
    const id=`practice-board-${i+1}`,root=new THREE.Group();
    const outer=new THREE.Mesh(new THREE.CircleGeometry(.78,32),new THREE.MeshStandardMaterial({color:0xdce5e9,roughness:.9}));outer.position.set(pt.x,pt.y,pt.z);root.add(outer);
    const rings=[{r:.58,c:0x327a8b},{r:.39,c:0xdf4f5f},{r:.20,c:0xe2ba61},{r:.075,c:0x202a38}];
    rings.forEach(({r,c})=>{const m=new THREE.Mesh(new THREE.CircleGeometry(r,28),new THREE.MeshStandardMaterial({color:c,roughness:.85}));m.position.set(pt.x,pt.y,pt.z+.006+(0.006*(.8-r)));root.add(m);});
    scene.add(root);registerTarget(root,id);state.trainingTargets.push({id,root,hp:100,maxHp:100,alive:true,respawnAt:0,name:`과녁 ${i+1}`});
  });
}
function updateTrainingTargets(now=Date.now()){
  for(const target of state.trainingTargets){if(!target.alive&&target.respawnAt&&now>=target.respawnAt){target.hp=target.maxHp;target.alive=true;target.respawnAt=0;target.root.visible=true;registerTarget(target.root,target.id);}}
}
function renderTrainingWeapons(){
  const grid=$('training-weapon-grid');if(!grid)return;grid.innerHTML='';
  for(const w of WEAPONS){const button=document.createElement('button');button.className='training-weapon-option'+(state.currentWeapon===w.id?' selected':'');button.innerHTML=`<div class="weapon-mini-stage ${w.id}-showcase"><div class="weapon-mini-model" style="--showcase-color:#${w.color.toString(16).padStart(6,'0')}"><i></i><b></b><em></em><span></span></div></div><small>${w.type}</small><b>${w.name}</b><span>DMG ${w.damage} · MAG ${w.mag}</span>`;button.addEventListener('click',()=>{state.owned.add(w.id);setWeapon(w.id);makeAmmoFor(w.id,true);$('training-weapon-menu').classList.add('hidden');});grid.append(button);}
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
  endScreen.classList.add('hidden');if(state.matchOver){state.selfScore=0;state.enemyScore=0;state.money=450;state.armor=0;state.armorTier='none';state.currentWeapon='pistol';state.owned=new Set(['pistol']);for(const w of WEAPONS)state.ammo[w.id]={mag:w.mag,reserve:w.reserve};state.round=0;}
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
function switchWeaponByNumber(n){const w=WEAPONS[n-1];if(w)setWeapon(w.id,true);}
function reloadWeapon(){
  if(state.phase!=='live'||state.paused||state.reloading)return;
  if(state.mode==='training'){const w=currentWeapon();makeAmmoFor(w.id,true);updateHUD();showToast('훈련장 무한 탄약 · 재장전할 필요가 없습니다.',900);return;}
  const w=currentWeapon(),a=state.ammo[w.id];
  if(a.mag>=w.mag||a.reserve<=0){showToast(a.mag>=w.mag?'탄창이 이미 가득 찼습니다.':'예비 탄약이 없습니다.',900);return;}
  state.reloading=true;state.reloadWeaponId=w.id;state.reloadUntil=performance.now()+w.reload*1000;soundReload();showToast('재장전 중...',700);
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
function doShoot(){
  if(state.phase!=='live'||state.paused||state.reloading)return;
  initAudio();const w=currentWeapon(),ammo=state.ammo[w.id],now=performance.now();if(now-state.lastShot<w.rate*1000)return;
  if(state.mode!=='training'&&ammo.mag<=0){showToast('탄약이 없습니다. R로 재장전하세요.',850);return;}state.lastShot=now;if(state.mode==='training'){ammo.mag=w.mag;ammo.reserve=w.reserve;}else ammo.mag--;soundShot(w.id);if(muzzleMesh){muzzleMesh.visible=true;state.muzzleUntil=now+55;}
  const direction=cameraForward();const origin=camera.position.clone();let bestHit=null;const pellets=w.id==='shotgun'?7:1;let totalDamage=0;let hitPoint=origin.clone().add(direction.clone().multiplyScalar(w.range));let hitOwner=null;
  for(let i=0;i<pellets;i++){
    const d=direction.clone();const spread=state.zoomed?w.spread*.35:w.spread;
    d.x+=(Math.random()-.5)*spread;d.y+=(Math.random()-.5)*spread;d.z+=(Math.random()-.5)*spread;d.normalize();raycaster.set(origin,d);raycaster.far=w.range;
    const hits=raycaster.intersectObjects(targetObjects,false);let h=hits.find(x=>{
      const targetId=x.object.userData.targetId;
      if(!targetId)return false;
      if(String(targetId).startsWith('bot-'))return state.mode==='ai'&&state.botList.some(b=>b.id===targetId&&b.alive);
      if(String(targetId).startsWith('practice-'))return state.mode==='training'&&state.trainingTargets.some(t=>t.id===targetId&&t.alive);
      return state.mode==='online'&&state.remotePlayers.has(targetId);
    });
    if(h){const blockers=raycaster.intersectObjects(obstacleMeshes,false);if(blockers.length&&blockers[0].distance<h.distance-.06)h=null;}
    if(h){
      hitPoint=h.point;hitOwner=h.object.userData.targetId;
      if(String(hitOwner).startsWith('bot-')){
        const bot=state.botList.find(b=>b.id===hitOwner);if(bot&&bot.alive){const head=h.object.userData.part==='head';totalDamage+=w.damage*(head?w.head:1);}
      } else if(String(hitOwner).startsWith('practice-')){
        const target=state.trainingTargets.find(t=>t.id===hitOwner);if(target&&target.alive){const head=h.object.userData.part==='head';totalDamage+=w.damage*(head?w.head:1);}
      } else if(state.mode==='online'){
        // Online hits are resolved by the room server; the local ray is only for tracer feedback.
        totalDamage=0;
      }
    }
  }
  addShotFx(origin,hitPoint,w.id==='sniper'?0xffdfb5:0x73f8e4);
  if(state.mode==='training'&&hitOwner&&String(hitOwner).startsWith('practice-')&&totalDamage>0){
    const target=state.trainingTargets.find(t=>t.id===hitOwner&&t.alive);
    if(target){target.hp-=totalDamage;soundHit();$('hit-marker').classList.remove('hidden');setTimeout(()=>$('hit-marker').classList.add('hidden'),100);showToast(`${target.name} · ${Math.max(0,Math.round(target.hp))} HP`,500);
      if(target.hp<=0){target.hp=0;target.alive=false;target.respawnAt=Date.now()+3000;target.root.visible=false;unregisterTarget(target.id);soundKill();$('kill-banner').innerHTML=`${target.name.toUpperCase()} RESET <small>RESPAWN 3 SEC</small>`;$('kill-banner').classList.remove('hidden');setTimeout(()=>$('kill-banner').classList.add('hidden'),900);}
    }
  }
  if(state.mode==='ai'&&hitOwner&&String(hitOwner).startsWith('bot-')&&totalDamage>0){const bot=state.botList.find(b=>b.id===hitOwner);if(bot&&bot.alive){bot.hp-=totalDamage;soundHit();$('hit-marker').classList.remove('hidden');setTimeout(()=>$('hit-marker').classList.add('hidden'),100);if(bot.hp<=0){bot.hp=0;bot.alive=false;bot.root.visible=false;unregisterTarget(bot.id);state.money+=75;soundKill();$('kill-banner').innerHTML=`${bot.name} ELIMINATED <small>+75 CR</small>`;$('kill-banner').classList.remove('hidden');setTimeout(()=>$('kill-banner').classList.add('hidden'),850);updateHUD();if(state.botList.every(b=>!b.alive))endLocalRound(true,'상대 플레이어를 처치했습니다.');}}}
  if(state.mode==='online'&&state.socketReady){state.socket.emit('fire',{weaponId:w.id,origin:{x:origin.x,y:origin.y,z:origin.z},direction:{x:direction.x,y:direction.y,z:direction.z}});}
  updateHUD();
}
function collideAt(x,z,y=state.pos.y){
  const radius=.48;if(Math.abs(x)>state.mapBounds||Math.abs(z)>state.mapBounds)return true;
  for(const c of colliders){if(y>=c.h-.04)continue;if(Math.abs(x-c.x)<c.w/2+radius&&Math.abs(z-c.z)<c.d/2+radius)return true;}
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
  if(!collideAt(nx,state.pos.z,state.pos.y))state.pos.x=nx;if(!collideAt(state.pos.x,nz,state.pos.y))state.pos.z=nz;
  const groundBefore=getGroundHeight(state.pos.x,state.pos.z);
  if(state.pos.y<=groundBefore+.06&&state.velocityY<=0){state.pos.y=groundBefore;state.velocityY=0;state.canJump=true;}
  if(state.keys.has('Space')&&state.canJump){state.velocityY=5.5;state.canJump=false;}
  state.velocityY-=14*dt;state.pos.y+=state.velocityY*dt;const groundAfter=getGroundHeight(state.pos.x,state.pos.z);if(state.pos.y<groundAfter){state.pos.y=groundAfter;state.velocityY=0;state.canJump=true;}
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

function beginOnline(){
  if((state.rule==='pc'&&state.device!=='pc')||(state.rule==='mobile'&&state.device!=='mobile')){showToast(state.rule==='pc'?'PC끼리 모드는 PC를 선택하세요.':'모바일끼리 모드는 모바일을 선택하세요.');return;}
  initAudio();state.mode='online';state.name=($('player-name').value.trim()||'PLAYER').slice(0,16);state.money=450;state.hp=100;state.armor=0;state.armorTier='none';state.selfScore=0;state.enemyScore=0;state.round=0;state.currentWeapon='pistol';state.owned=new Set(['pistol']);state.ammo={};for(const w of WEAPONS)state.ammo[w.id]={mag:w.mag,reserve:w.reserve};state.pos.set(0,0,27);state.yaw=Math.PI;state.pitch=0;state.buyPrimaryThisRound=false;state.phase='waiting';state.roomCode='';clearBots();clearRemotePlayers();setModeUI();$('phase-label').textContent='CONNECTING';$('objective-label').textContent='WAITING FOR OPPONENT';updateHUD();
  const socket=io({transports:['websocket','polling'],tryAllTransports:true,upgrade:true,reconnection:true,reconnectionAttempts:Infinity,reconnectionDelay:500,reconnectionDelayMax:4000,timeout:20000});state.socket=socket;let connectCount=0;
  socket.on('connect',()=>{const reconnect=connectCount++>0;state.socketReady=true;updateHUD();if(reconnect&&!socket.recovered&&state.roomCode)socket.emit('resumeRoom',{code:state.roomCode,sessionId:CLIENT_SESSION_ID});});
  socket.on('disconnect',reason=>{state.socketReady=false;updateHUD();if(state.mode==='online'&&reason!=='io client disconnect')showToast('온라인 연결을 복구하는 중입니다…',2600);});
  socket.on('connect_error',()=>{state.socketReady=false;updateHUD();setMenuStatus('온라인 서버에 연결할 수 없습니다. 서버가 배포되어 있는지 확인하세요.');showToast('온라인 서버 연결 실패. 공개 배포 주소에서 접속했는지 확인하세요.',3200);});
  socket.on('roomCreated',data=>{if(data.map&&state.mapId!==data.map)buildMap(data.map);state.roomCode=data.code;state.phase='waiting';$('phase-label').textContent='WAITING';$('objective-label').textContent='WAITING FOR OPPONENT';showToast(`방 생성 완료 · 코드 ${data.code} · 친구에게 코드 공유`,4000);showRoomWait(data.code);updateHUD();});
  socket.on('roomJoined',data=>{if(data.map&&state.mapId!==data.map)buildMap(data.map);state.roomCode=data.code;showRoomWait(data.code);});
  socket.on('roomResumed',data=>{if(data.map&&state.mapId!==data.map)buildMap(data.map);state.roomCode=data.code;hideRoomWait();showToast('온라인 연결이 복구됐습니다.',1800);updateHUD();});
  socket.on('roomError',data=>{showToast(data.message||'방에 참가하지 못했습니다.',3200);state.phase='waiting';});
  socket.on('playerJoined',data=>{updateRemotePlayer(data.id,data.player);hideRoomWait();showToast(`${data.player.name||'상대'} 접속 · 라운드 준비`,2000);});
  socket.on('playerLeft',data=>{const r=state.remotePlayers.get(data.id);if(r){unregisterTarget(data.id);disposeGroup(r.root);state.remotePlayers.delete(data.id);}showToast('상대 플레이어 연결이 종료됐습니다.',3000);state.phase='waiting';$('phase-label').textContent='WAITING';});
  socket.on('playersSnapshot',data=>{for(const [id,p] of Object.entries(data||{}))updateRemotePlayer(id,p);});
  socket.on('playerMoved',data=>updateRemotePlayer(data.id,data));
  socket.on('roundState',data=>{
    if(data.map&&state.mapId!==data.map)buildMap(data.map);hideRoomWait();endScreen.classList.add('hidden');state.phase=data.phase;state.round=data.round;state.phaseEnd=data.endsAt;state.roundLimit=data.roundEndsAt||0;state.selfScore=data.scores?.[socket.id]||0;state.enemyScore=Object.entries(data.scores||{}).filter(([id])=>id!==socket.id).reduce((a,[,v])=>a+v,0);state.money=data.self?.money??state.money;state.hp=data.self?.hp??100;state.armor=data.self?.armor??state.armor;state.armorTier=data.self?.armorTier??state.armorTier;state.currentWeapon=data.self?.weapon||state.currentWeapon;state.buyPrimaryThisRound=!!data.self?.boughtPrimary;state.owned=new Set(data.self?.ownedWeapons||['pistol',...(data.self?.weapon&&data.self.weapon!=='pistol'?[data.self.weapon]:[])]);state.pos.set(data.self?.x??0,data.self?.y??0,data.self?.z??27);state.yaw=data.self?.yaw??state.yaw;state.pitch=data.self?.pitch??0;state.reloading=false;state.reloadWeaponId=null;makeAmmoFor(state.currentWeapon,true);buildGun(state.currentWeapon);if(data.phase==='buy'){clearRemotePlayers();for(const [id,p]of Object.entries(data.players||{}))if(id!==socket.id)updateRemotePlayer(id,p);$('phase-label').textContent='BUY PHASE';openBuy();}else{$('phase-label').textContent='LIVE';closeBuy();}updateHUD();
  });
  socket.on('selfState',data=>{if(data.money!=null)state.money=data.money;if(data.hp!=null)state.hp=data.hp;if(data.armor!=null)state.armor=data.armor;if(data.armorTier)state.armorTier=data.armorTier;if(data.ownedWeapons)state.owned=new Set(data.ownedWeapons);if(data.weapon&&data.weapon!==state.currentWeapon){state.currentWeapon=data.weapon;buildGun(data.weapon);}if(data.boughtPrimary!=null)state.buyPrimaryThisRound=data.boughtPrimary;updateHUD();});
  socket.on('roundPhase',data=>{state.phase=data.phase;state.phaseEnd=data.endsAt;if(data.phase==='live')state.roundLimit=data.endsAt;if(data.phase==='live'){$('phase-label').textContent='LIVE';closeBuy();showToast(`ROUND ${data.round} — FIGHT`,1600);}if(data.phase==='buy'){$('phase-label').textContent='BUY PHASE';openBuy();}updateHUD();});
  socket.on('shotFx',data=>{if(data.id===socket.id)return;const from=new THREE.Vector3(data.origin.x,data.origin.y,data.origin.z),to=new THREE.Vector3(data.end.x,data.end.y,data.end.z);addShotFx(from,to,0xff718a);soundShot(data.weaponId);});
  socket.on('damage',data=>{if(data.targetId===socket.id){state.hp=data.hp;if(data.armor!=null)state.armor=data.armor;if(data.armorTier)state.armorTier=data.armorTier;updateHUD();soundHit();if(data.hp<=0){setZoom(false);showToast('라운드 패배 · 다음 라운드를 준비하세요.',1800);}}if(data.attackerId===socket.id&&data.targetId!==socket.id){$('hit-marker').classList.remove('hidden');setTimeout(()=>$('hit-marker').classList.add('hidden'),110);soundHit();}if(data.killed&&data.attackerId===socket.id){soundKill();$('kill-banner').innerHTML=`TARGET ELIMINATED <small>+75 CR</small>`;$('kill-banner').classList.remove('hidden');setTimeout(()=>$('kill-banner').classList.add('hidden'),900);}});
  socket.on('equipResult',data=>{if(!data.ok){showToast(data.message||'무기를 장착할 수 없습니다.');return;}state.currentWeapon=data.weapon;if(data.ownedWeapons)state.owned=new Set(data.ownedWeapons);makeAmmoFor(data.weapon);buildGun(data.weapon);updateHUD();showToast(`${WEAPON_BY_ID[data.weapon]?.name||data.weapon} 장착`,900);});socket.on('buyResult',data=>{if(!data.ok){showToast(data.message||'구매할 수 없습니다.');return;}state.money=data.money;state.armor=data.armor??state.armor;if(data.armorTier)state.armorTier=data.armorTier;if(data.ownedWeapons)state.owned=new Set(data.ownedWeapons);if(data.weapon&&data.weapon!==state.currentWeapon){state.currentWeapon=data.weapon;makeAmmoFor(data.weapon,true);buildGun(data.weapon);}state.buyPrimaryThisRound=!!data.boughtPrimary;state.armorPurchased=!!data.armorPurchased;soundBuy();$('buy-feedback').textContent=data.message||'구매 완료';updateHUD();});
  socket.on('roundResult',data=>{setZoom(false);state.phase='ended';state.selfScore=data.scores?.[socket.id]||0;state.enemyScore=Object.entries(data.scores||{}).filter(([id])=>id!==socket.id).reduce((a,[,v])=>a+v,0);state.money=data.selfMoney??state.money;state.matchOver=!!data.matchOver;$('result-kicker').textContent=data.matchOver?'MATCH RESULT':'ROUND RESULT';const won=data.winnerId===socket.id;$('result-title').innerHTML=data.matchOver?(won?'MATCH<br/><span>VICTORY.</span>':'MATCH<br/><span>DEFEAT.</span>'):(won?'ROUND<br/><span>WON.</span>':'ROUND<br/><span>LOST.</span>');$('result-copy').textContent=data.matchOver?(data.reason||'6라운드 선취로 매치가 끝났습니다.'):`${data.reason|| (won?'라운드 승리!':'상대가 라운드를 가져갔습니다.')} · 이번 라운드만 종료됐습니다. 현재 점수 ${state.selfScore}-${state.enemyScore}. 아래 '다음 라운드 시작' 버튼을 누르면 다음 라운드로 진행하며, 먼저 6승을 하면 매치가 끝납니다.`;$('result-reward').textContent=`+${(data.reward??0).toLocaleString()} CR`;$('next-round').classList.toggle('hidden',!!data.matchOver);$('next-round').disabled=false;$('next-round').textContent='다음 라운드 시작';endScreen.classList.remove('hidden');updateHUD();});
  socket.on('roomMessage',data=>showToast(data.message));
  socket.emit('createRoom',{name:state.name,device:state.device,rule:state.rule,map:state.selectedMap,sessionId:CLIENT_SESSION_ID});
  }
function showRoomWait(code){let panel=$('room-wait');if(!panel){panel=document.createElement('div');panel.id='room-wait';panel.className='room-wait';panel.innerHTML='<div class="room-wait-card"><small>PRIVATE MATCH / INVITE</small><h3>친구를 기다리는 중</h3><p>아래 6자리 코드를 친구에게 공유하세요.</p><strong id="wait-code">------</strong><button id="copy-room-code" class="solid-button">방 코드 복사</button><button id="cancel-room-wait" class="outline-button full-button">메인 메뉴로</button></div>';document.body.append(panel);$('copy-room-code').addEventListener('click',()=>navigator.clipboard?.writeText(state.roomCode).then(()=>showToast('방 코드를 복사했습니다.')).catch(()=>showToast(`방 코드: ${state.roomCode}`)));$('cancel-room-wait').addEventListener('click',backToMenu);}
  $('wait-code').textContent=code||'------';panel.classList.remove('hidden');}
function hideRoomWait(){const p=$('room-wait');if(p)p.classList.add('hidden');}
function joinOnline(){const code=$('room-code').value.trim().toUpperCase().replace(/[^A-Z0-9]/g,'');if(code.length!==6){showToast('6자리 방 코드를 입력하세요.');return;}initAudio();state.mode='online';state.name=($('player-name').value.trim()||'PLAYER').slice(0,16);state.rule=state.rule||'crossplay';state.money=450;state.hp=100;state.armor=0;state.armorTier='none';state.selfScore=0;state.enemyScore=0;state.round=0;state.currentWeapon='pistol';state.owned=new Set(['pistol']);state.phase='waiting';state.roomCode='';clearBots();clearRemotePlayers();setModeUI();updateHUD();
  const socket=io({transports:['websocket','polling'],tryAllTransports:true,upgrade:true,reconnection:true,reconnectionAttempts:Infinity,reconnectionDelay:500,reconnectionDelayMax:4000,timeout:20000});state.socket=socket;let connectCount=0;socket.on('connect',()=>{const reconnect=connectCount++>0;state.socketReady=true;updateHUD();if(!reconnect)socket.emit('joinRoom',{code,name:state.name,device:state.device,map:state.selectedMap,sessionId:CLIENT_SESSION_ID});else if(!socket.recovered&&state.roomCode)socket.emit('resumeRoom',{code:state.roomCode,sessionId:CLIENT_SESSION_ID});});socket.on('disconnect',reason=>{state.socketReady=false;updateHUD();if(state.mode==='online'&&reason!=='io client disconnect')showToast('온라인 연결을 복구하는 중입니다…',2600);});socket.on('connect_error',()=>{state.socketReady=false;showToast('온라인 서버 연결 실패. 배포된 게임 주소인지 확인하세요.',3200);});
  // Reuse identical room listeners by registering a lightweight join-mode bridge.
  socket.on('roomError',d=>showToast(d.message||'방 입장 실패',3200));socket.on('roomJoined',d=>{if(d.map&&state.mapId!==d.map)buildMap(d.map);state.roomCode=d.code;showRoomWait(d.code);});
  socket.on('roomResumed',d=>{if(d.map&&state.mapId!==d.map)buildMap(d.map);state.roomCode=d.code;hideRoomWait();showToast('온라인 연결이 복구됐습니다.',1800);updateHUD();});
  socket.on('playerJoined',d=>{updateRemotePlayer(d.id,d.player);hideRoomWait();});socket.on('playerLeft',d=>{const r=state.remotePlayers.get(d.id);if(r){unregisterTarget(d.id);disposeGroup(r.root);state.remotePlayers.delete(d.id);}state.phase='waiting';});socket.on('playerMoved',d=>updateRemotePlayer(d.id,d));socket.on('playersSnapshot',d=>{for(const[id,p]of Object.entries(d||{}))if(id!==socket.id)updateRemotePlayer(id,p);});
  socket.on('roundState',d=>{if(d.map&&state.mapId!==d.map)buildMap(d.map);hideRoomWait();endScreen.classList.add('hidden');state.phase=d.phase;state.round=d.round;state.phaseEnd=d.endsAt;state.roundLimit=d.roundEndsAt||0;state.selfScore=d.scores?.[socket.id]||0;state.enemyScore=Object.entries(d.scores||{}).filter(([id])=>id!==socket.id).reduce((a,[,v])=>a+v,0);state.money=d.self?.money??650;state.hp=d.self?.hp??100;state.armor=d.self?.armor??0;state.armorTier=d.self?.armorTier??'none';state.currentWeapon=d.self?.weapon||'pistol';state.owned=new Set(d.self?.ownedWeapons||['pistol',...(state.currentWeapon!=='pistol'?[state.currentWeapon]:[])]);state.buyPrimaryThisRound=!!d.self?.boughtPrimary;state.pos.set(d.self?.x??0,d.self?.y??0,d.self?.z??27);state.yaw=d.self?.yaw??state.yaw;state.pitch=d.self?.pitch??0;state.reloading=false;state.reloadWeaponId=null;makeAmmoFor(state.currentWeapon,true);clearRemotePlayers();for(const[id,player]of Object.entries(d.players||{}))if(id!==socket.id)updateRemotePlayer(id,player);buildGun(state.currentWeapon);if(d.phase==='buy')openBuy();else closeBuy();$('phase-label').textContent=d.phase==='buy'?'BUY PHASE':'LIVE';updateHUD();});
  socket.on('roundPhase',d=>{state.phase=d.phase;state.phaseEnd=d.endsAt;if(d.phase==='live')state.roundLimit=d.endsAt;$('phase-label').textContent=d.phase==='buy'?'BUY PHASE':'LIVE';if(d.phase==='buy')openBuy();else closeBuy();});socket.on('selfState',d=>{state.money=d.money??state.money;state.hp=d.hp??state.hp;state.armor=d.armor??state.armor;state.armorTier=d.armorTier??state.armorTier;if(d.ownedWeapons)state.owned=new Set(d.ownedWeapons);if(d.weapon&&d.weapon!==state.currentWeapon){state.currentWeapon=d.weapon;buildGun(d.weapon);}state.buyPrimaryThisRound=!!d.boughtPrimary;updateHUD();});
  socket.on('buyResult',d=>{if(!d.ok){showToast(d.message||'구매할 수 없습니다.');return;}state.money=d.money;state.armor=d.armor??state.armor;state.armorTier=d.armorTier??state.armorTier;if(d.ownedWeapons)state.owned=new Set(d.ownedWeapons);if(d.weapon&&d.weapon!==state.currentWeapon){state.currentWeapon=d.weapon;makeAmmoFor(d.weapon,true);buildGun(d.weapon);}state.buyPrimaryThisRound=!!d.boughtPrimary;state.armorPurchased=!!d.armorPurchased;soundBuy();updateHUD();});socket.on('shotFx',d=>{if(d.id!==socket.id){addShotFx(new THREE.Vector3(d.origin.x,d.origin.y,d.origin.z),new THREE.Vector3(d.end.x,d.end.y,d.end.z),0xff718a);soundShot(d.weaponId);}});socket.on('damage',d=>{if(d.targetId===socket.id){state.hp=d.hp;state.armor=d.armor??state.armor;state.armorTier=d.armorTier??state.armorTier;updateHUD();soundHit();}if(d.attackerId===socket.id&&d.targetId!==socket.id){$('hit-marker').classList.remove('hidden');setTimeout(()=>$('hit-marker').classList.add('hidden'),110);soundHit();}if(d.killed&&d.attackerId===socket.id){soundKill();$('kill-banner').classList.remove('hidden');setTimeout(()=>$('kill-banner').classList.add('hidden'),900);}});
  socket.on('roundResult',d=>{setZoom(false);state.phase='ended';state.selfScore=d.scores?.[socket.id]||0;state.enemyScore=Object.entries(d.scores||{}).filter(([id])=>id!==socket.id).reduce((a,[,v])=>a+v,0);state.money=d.selfMoney??state.money;state.matchOver=!!d.matchOver;const won=d.winnerId===socket.id;$('result-kicker').textContent=d.matchOver?'MATCH RESULT':'ROUND RESULT';$('result-title').innerHTML=d.matchOver?(won?'MATCH<br/><span>VICTORY.</span>':'MATCH<br/><span>DEFEAT.</span>'):(won?'ROUND<br/><span>WON.</span>':'ROUND<br/><span>LOST.</span>');$('result-copy').textContent=d.matchOver?(d.reason||'6라운드 선취로 매치가 끝났습니다.'):`${d.reason||'라운드 종료'} · 이번 라운드만 종료됐습니다. 현재 점수 ${state.selfScore}-${state.enemyScore}. 아래 '다음 라운드 시작' 버튼을 누르면 다음 라운드로 진행하며, 먼저 6승을 하면 매치가 끝납니다.`;$('result-reward').textContent=`+${(d.reward||0).toLocaleString()} CR`;$('next-round').classList.toggle('hidden',!!d.matchOver);$('next-round').disabled=false;$('next-round').textContent='다음 라운드 시작';endScreen.classList.remove('hidden');updateHUD();});
}

function setupEvents(){
  document.querySelectorAll('[data-device]').forEach(b=>b.addEventListener('click',()=>setDevice(b.dataset.device)));
  document.querySelectorAll('[data-map]').forEach(b=>b.addEventListener('click',()=>selectMap(b.dataset.map)));
  document.querySelectorAll('[data-rule]').forEach(b=>b.addEventListener('click',()=>setRule(b.dataset.rule)));
  document.querySelectorAll('[data-lobby-tab]').forEach(b=>b.addEventListener('click',()=>setLobbyPage(b.dataset.lobbyTab)));
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
    state.keys.add(e.code);
    if(e.code==='KeyR')reloadWeapon();if(e.code==='KeyQ')toggleZoom();if(e.code==='KeyT'&&state.mode==='training')openTrainingWeapons();if(/^Digit[1-9]$/.test(e.code))switchWeaponByNumber(Number(e.code.slice(-1)));
    if(e.code==='KeyB'&&state.phase==='buy')openBuy();
  });window.addEventListener('keyup',e=>state.keys.delete(e.code));window.addEventListener('blur',()=>state.keys.clear());
  canvas.addEventListener('pointerdown',e=>{if(state.mode==='menu'||state.device==='mobile'||state.paused)return;initAudio();if(document.pointerLockElement!==canvas){canvas.requestPointerLock?.();}if(e.button===0)doShoot();if(e.button===2)toggleZoom();});
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  document.addEventListener('pointerlockchange',()=>{state.pointerLocked=document.pointerLockElement===canvas;});
  document.addEventListener('mousemove',e=>{if(state.device!=='pc'||document.pointerLockElement!==canvas||state.phase!=='live'||state.paused)return;state.yaw-=e.movementX*.00215;state.pitch-=e.movementY*.00215;state.pitch=THREE.MathUtils.clamp(state.pitch,-1.28,1.28);});
  $('touch-fire').addEventListener('pointerdown',e=>{e.preventDefault();initAudio();doShoot();});$('touch-scope').addEventListener('pointerdown',e=>{e.preventDefault();toggleZoom();});$('touch-jump').addEventListener('pointerdown',e=>{e.preventDefault();state.keys.add('Space');});$('touch-jump').addEventListener('pointerup',()=>state.keys.delete('Space'));$('touch-reload').addEventListener('pointerdown',e=>{e.preventDefault();reloadWeapon();});$('touch-switch').addEventListener('pointerdown',e=>{e.preventDefault();if(state.mode==='training'){openTrainingWeapons();return;}const current=WEAPONS.findIndex(w=>w.id===state.currentWeapon);for(let i=1;i<=WEAPONS.length;i++){const n=(current+i)%WEAPONS.length;if(state.owned.has(WEAPONS[n].id)){setWeapon(WEAPONS[n].id);break;}}});
  const pad=$('move-pad'),stick=$('move-stick');let padPointer=null;
  pad.addEventListener('pointerdown',e=>{e.preventDefault();padPointer=e.pointerId;pad.setPointerCapture(e.pointerId);updatePad(e);});pad.addEventListener('pointermove',e=>{if(e.pointerId===padPointer)updatePad(e);});
  const resetPad=()=>{padPointer=null;state.touchMove.x=0;state.touchMove.y=0;stick.style.transform='translate(0px,0px)';};pad.addEventListener('pointerup',resetPad);pad.addEventListener('pointercancel',resetPad);
  function updatePad(e){const r=pad.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;let x=(e.clientX-cx)/(r.width*.36),y=(e.clientY-cy)/(r.height*.36);const l=Math.hypot(x,y);if(l>1){x/=l;y/=l;}state.touchMove.x=x;state.touchMove.y=y;stick.style.transform=`translate(${x*27}px,${y*27}px)`;}
  const look=$('look-zone');look.addEventListener('pointerdown',e=>{if(state.device!=='mobile')return;e.preventDefault();look.setPointerCapture(e.pointerId);state.mobileLook={id:e.pointerId,x:e.clientX,y:e.clientY};initAudio();});
  look.addEventListener('pointermove',e=>{if(!state.mobileLook||state.mobileLook.id!==e.pointerId)return;const dx=e.clientX-state.mobileLook.x,dy=e.clientY-state.mobileLook.y;state.mobileLook.x=e.clientX;state.mobileLook.y=e.clientY;state.yaw-=dx*.006;state.pitch-=dy*.005;state.pitch=THREE.MathUtils.clamp(state.pitch,-1.22,1.22);});
  const endLook=e=>{if(state.mobileLook&&state.mobileLook.id===e.pointerId)state.mobileLook=null;};look.addEventListener('pointerup',endLook);look.addEventListener('pointercancel',endLook);
  window.addEventListener('resize',()=>{camera.aspect=window.innerWidth/window.innerHeight;camera.updateProjectionMatrix();renderer.setSize(window.innerWidth,window.innerHeight);});
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
    for(const [id,r]of state.remotePlayers){r.root.position.lerp(r.target,Math.min(1,dt*12));r.root.rotation.y=r.yaw;}
  }else if(state.mode==='training'){
    if(state.phase==='live'&&!state.paused)movePlayer(dt);
    updateTrainingTargets(Date.now());
  }else{
    if(state.phase==='live'&&!state.paused){movePlayer(dt);updateAI(dt);}
  }
  if(state.mode!=='menu'){
    camera.position.set(state.pos.x,state.pos.y+1.58,state.pos.z);camera.rotation.order='YXZ';camera.rotation.y=state.yaw;camera.rotation.x=state.pitch;
    gunRoot.position.x=state.device==='mobile'?.03:0;gunRoot.visible=state.phase==='live'||state.phase==='buy';
    completeReload(now);
    if(state.phase==='buy'&&Date.now()>=state.phaseEnd&&state.mode==='ai')beginLocalLive();
    if(state.mode==='ai'&&state.phase==='live'&&Date.now()>=state.roundLimit)endLocalRound(state.hp>0,'시간 종료');
    if(state.phase==='buy')$('buy-countdown').textContent=`${Math.max(0,Math.ceil((state.phaseEnd-Date.now())/1000))}초`;
    if(state.mode==='training')$('match-timer').textContent='∞';
    else {const remaining=Math.max(0,Math.ceil(((state.phase==='buy'?state.phaseEnd:state.phase==='live'?state.roundLimit:Date.now())-Date.now())/1000));$('match-timer').textContent=`${String(Math.floor(remaining/60)).padStart(2,'0')}:${String(remaining%60).padStart(2,'0')}`;}
  }
  if(muzzleMesh&&now>state.muzzleUntil)muzzleMesh.visible=false;
  for(let i=state.shotFx.length-1;i>=0;i--){const fx=state.shotFx[i];if(now>=fx.expires){scene.remove(fx.line);fx.geo.dispose();fx.mat.dispose();state.shotFx.splice(i,1);}}
}
function animate(now){requestAnimationFrame(animate);const dt=Math.min(.05,(now-state.lastFrame)/1000||0);state.lastFrame=now;updateWorld(dt,now);
  state.fpsFrames++;if(now-state.fpsStamp>450){$('fps-value').textContent=Math.round(state.fpsFrames*1000/(now-state.fpsStamp||450));state.fpsFrames=0;state.fpsStamp=now;}
  renderer.render(scene,camera);
}

buildMap('arena');setDevice(state.device);setRule('crossplay');selectMap('arena');setPlayMode('training');setLobbyPage('play');buildGun('pistol');setupEvents();renderLobbyWeapons();updateHUD();requestAnimationFrame(animate);

if (import.meta.env.PROD && 'serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(() => {}); }
