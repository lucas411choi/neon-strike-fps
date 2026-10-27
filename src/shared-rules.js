/** Pure rules shared by the browser and server. Keep gameplay math in one place. */
export const XP_PER_LEVEL = 150;

export function applyExperienceProgress(levelValue, xpValue, amountValue) {
  let level = Math.max(1, Math.floor(Number(levelValue) || 1));
  let xp = Math.max(0, Math.floor(Number(xpValue) || 0));
  const amount = Math.max(0, Math.min(250, Math.floor(Number(amountValue) || 0)));
  xp += amount;
  let levelUps = 0;
  // A single award is capped at 250 XP, so this loop can only advance a small
  // number of levels. The guard also protects against corrupted persisted rows.
  while (xp >= level * XP_PER_LEVEL && level < 1_000_000 && levelUps < 100) {
    xp -= level * XP_PER_LEVEL;
    level += 1;
    levelUps += 1;
  }
  return { level, xp, levelUps, nextLevelXp: level * XP_PER_LEVEL };
}

export function getHitMultiplier(part) {
  if (part === 'head') return 1.30;
  if (part === 'legs') return 0.65;
  return 1;
}

export function calculateHitDamage(baseDamage, part = 'torso') {
  const damage = Math.max(0, Number(baseDamage) || 0);
  return damage * getHitMultiplier(part);
}

export function normalizeUsername(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isValidUsername(value) {
  return /^[a-z0-9_]{3,20}$/.test(normalizeUsername(value));
}

export function isValidPassword(value) {
  const password = String(value ?? '');
  return password.length >= 8 && password.length <= 128;
}
