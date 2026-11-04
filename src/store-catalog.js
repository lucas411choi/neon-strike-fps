/** NEON STRIKE cosmetic catalog. Prices and ownership are validated by the server. */
const weaponNames = {
  pistol: 'ATLAS PISTOL', revolver: 'IRONCLAD .45', smg: 'VIPER SMG', shotgun: 'BREACH SG',
  rifle: 'VANTAGE AR', dmr: 'RAIL DMR', sniper: 'LONGSHOT SR', lmg: 'TITAN LMG', burst: 'ION BURST', knife: 'ORBITAL EDGE',
};

export const STORE_SKINS = Object.freeze([
  ...Object.entries(weaponNames).map(([weaponId, weaponName]) => ({
    id: `classic_${weaponId}`, name: `CLASSIC · ${weaponName}`, displayName: `클래식 · ${weaponName}`,
    weaponId, rarity: 'normal', price: 100, bundleId: 'classic_bundle',
    description: '우주 장비를 현실적인 금속·폴리머 외장으로 바꾸는 기본 스킨.', theme: 'classic',
  })),
  { id:'halloween_pistol', name:'PEPPERMINT PISTOL', displayName:'박하사탕 권총', weaponId:'pistol', rarity:'rare', price:200, bundleId:'halloween_2026_bundle', description:'박하사탕 소용돌이와 유령 에너지를 두른 권총. 킬 모션: 유령이 상대를 하늘로 데려갑니다.', theme:'halloween-candy', killEffect:'ghost-lift' },
  { id:'halloween_dmr', name:'GHOST SHEET RAIL', displayName:'유령천 RAIL DMR', weaponId:'dmr', rarity:'rare', price:200, bundleId:'halloween_2026_bundle', description:'유령천이 총신을 감싼 RAIL DMR. 킬 모션: 유령이 상대를 하늘로 데려갑니다.', theme:'halloween-ghost', killEffect:'ghost-lift' },
  { id:'halloween_lmg', name:'PUMPKIN CANDY TITAN', displayName:'호박 사탕 TITAN LMG', weaponId:'lmg', rarity:'rare', price:200, bundleId:'halloween_2026_bundle', description:'호박 포구에서 사탕 에너지가 발사되는 LMG. 킬 모션: 유령이 상대를 하늘로 데려갑니다.', theme:'halloween-pumpkin', killEffect:'ghost-lift' },
  { id:'prime_knife', name:'PRIME GOLD KARAMBIT', displayName:'프라임 골드 카람빗', weaponId:'knife', rarity:'premium', price:300, bundleId:'prime_1_bundle', description:'황금 카람빗. 관찰 모션은 칼 돌리기, 휘두를 때 황금 오라, 킬 모션은 황금 화살과 빛.', theme:'prime-gold', inspect:'karambit-spin', killEffect:'gold-arrows' },
  { id:'prime_sniper', name:'PRIME GOLD LONGSHOT', displayName:'프라임 골드 LONGSHOT', weaponId:'sniper', rarity:'premium', price:300, bundleId:'prime_1_bundle', description:'고급스러운 금색 저격소총. 관찰 모션은 양손 들기, 킬 모션은 황금 화살과 빛.', theme:'prime-gold', inspect:'sniper-present', killEffect:'gold-arrows' },
  { id:'oni_burst', name:'ONI SPIRIT BURST', displayName:'도깨비 영혼 버스트', weaponId:'burst', rarity:'premium', price:350, bundleId:'oni_bundle', description:'붉은 칠기와 금색 장식, 초록 불꽃 눈을 가진 도깨비 얼굴. 관찰 시 눈이 발광하며 초록 오라가 피어납니다.', theme:'oni', inspect:'oni-eye-aura', killEffect:'oni-stab-dissolve' },
  { id:'oni_revolver', name:'ONI SPIRIT REVOLVER', displayName:'도깨비 영혼 리볼버', weaponId:'revolver', rarity:'premium', price:350, bundleId:'oni_bundle', description:'도깨비 가면과 비취색 실린더 에너지를 장착한 프리미엄 리볼버. 관찰 시 눈과 오라가 발광합니다.', theme:'oni', inspect:'oni-eye-aura', killEffect:'oni-stab-dissolve' },
  { id:'oni_katana', name:'ONIMARU KATANA', displayName:'오니마루 장검', weaponId:'knife', rarity:'premium', price:400, bundleId:'oni_bundle', description:'붉은 칠기 칼집과 금색 장식, 비취빛 날을 가진 도깨비 장검. 칼집을 소환하고 수평으로 천천히 뽑아냅니다.', theme:'oni', inspect:'oni-sheath-draw', killEffect:'oni-stab-dissolve' },
]);

export const STORE_BUNDLES = Object.freeze([
  // The Halloween, Classic and Prime skin records remain available for existing owners / daily rotation.
  // Only the new Oni premium bundle is sold as a bundle.
  { id:'oni_bundle', name:'ONI 2026', displayName:'도깨비 번들', price:750, limited:true, theme:'oni', description:'도깨비 버스트 · 도깨비 리볼버 · 오니마루 장검 · 초록 불꽃 도깨비 프로필 · 초록색 이름 색상', skinIds:STORE_SKINS.filter(s=>s.bundleId==='oni_bundle').map(s=>s.id), profileIds:['oni'], nameColorIds:['green'] },
]);

export const STORE_ROLL_COST = 150;
export const TRAINING_QUEST_TARGET = 67;
export const TRAINING_QUEST_REWARD = 22;

export function getStoreSkin(skinId) { return STORE_SKINS.find(s => s.id === String(skinId)) || null; }
export function getStoreBundle(bundleId) { return STORE_BUNDLES.find(b => b.id === String(bundleId)) || null; }

// Kept as a simple helper for previews; the server now persists a per-account selection for 24 hours.
export function getDailySkinIds(dateString = new Date().toISOString().slice(0, 10)) {
  const pool = STORE_SKINS.map(s => s.id);
  let seed = 2166136261;
  for (const char of String(dateString)) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3);
}
