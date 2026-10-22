export const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function cleanNickname(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 18);
}
export function nicknameKey(value) {
  return cleanNickname(value).toLocaleLowerCase("en-US");
}
export function normalizeText(value) {
  return String(value ?? "").normalize("NFKD").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}
export function guessMatches(guess, secret) {
  const a = normalizeText(guess).replace(/\s/g, ""), b = normalizeText(secret).replace(/\s/g, "");
  if (a === b) return true;
  const limit = b.length > 8 ? 2 : 1;
  if (Math.abs(a.length - b.length) > limit) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length] <= limit;
}
