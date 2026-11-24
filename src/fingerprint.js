'use strict';
/**
 * Извлечение отпечатка аккаунта
 *
 * Идея:
 *   - user_id — самый стабильный уникальный идентификатор аккаунта, лежит в payload JWT клиента:
 *       • новый клиент (4.x): JWT (zcodejwttoken) лежит в credentials.json, зашифрован enc:v2;
 *         config.json у него нет
 *       • старый клиент: тот же JWT лежит открытым в config.json (provider.*.options.apiKey)
 *   - user_info/access_token в credentials.json зашифрованы (enc:v1 / enc:v2);
 *     подтверждено, что расшифровываются ключом ZCode этой машины,
 *     используются для отображения email/аватара/имени пользователя.
 *
 * Структура отпечатка:
 *   { userId, shortId, provider, label, email, name, avatar, capturedAt }
 */
const fs = require('fs');
const { CREDENTIALS_FILE, CONFIG_FILE } = require('./paths');
const { decrypt, decryptJson, isEncrypted } = require('./zcodeCrypto');

/**
 * Разбирает payload JWT (без проверки подписи — только чтение payload)
 * @param {string} jwt
 * @returns {object|null}
 */
function decodeJwt(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    let p = parts[1];
    // base64url -> base64
    p = p.replace(/-/g, '+').replace(/_/g, '/');
    // Дополняем padding
    while (p.length % 4) p += '=';
    const json = Buffer.from(p, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function readCredentialProfile() {
  try {
    const rawCred = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    const activeProviderRaw = rawCred['oauth:active_provider'];
    let activeProvider = 'zai';
    try {
      activeProvider = isEncrypted(activeProviderRaw) ? decrypt(activeProviderRaw) : activeProviderRaw || 'zai';
    } catch (_) {}

    const userInfoKey = `oauth:${activeProvider}:user_info`;
    const userInfo = rawCred[userInfoKey] ? decryptJson(rawCred[userInfoKey]) : null;
    const accessToken = rawCred[`oauth:${activeProvider}:access_token`];
    let accessPayload = null;
    try {
      accessPayload = decodeJwt(isEncrypted(accessToken) ? decrypt(accessToken) : accessToken);
    } catch (_) {}

    // zcodejwttoken — JWT, по которому клиент вызывает API (в старом клиенте тот же JWT лежал в config.json)
    const zcodeJwt = rawCred.zcodejwttoken;
    let jwtPayload = null;
    try {
      jwtPayload = decodeJwt(isEncrypted(zcodeJwt) ? decrypt(zcodeJwt) : zcodeJwt);
    } catch (_) {}

    return {
      activeProvider,
      email: userInfo && userInfo.email,
      name: userInfo && (userInfo.name || userInfo.username || userInfo.displayName),
      avatar: userInfo && userInfo.avatar,
      credentialUserId: userInfo && userInfo.user_id,
      customerId: accessPayload && accessPayload.customer_id,
      accessUserId: accessPayload && (accessPayload.user_id || accessPayload.sub),
      userKey: accessPayload && accessPayload.user_key,
      jwtUserId: jwtPayload && (jwtPayload.user_id || jwtPayload.sub),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Извлекает отпечаток аккаунта из текущего логина (credentials.json, а у старого клиента — ещё config.json)
 * @returns {{userId:string, shortId:string, provider:string, label:string} | null}
 */
function extractFingerprint() {
  const profile = readCredentialProfile();

  // 1. Старый клиент: в config.json ищем provider с enabled=true и apiKey (открытый JWT)
  try {
    const rawCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const providers = rawCfg.provider || {};
    // Приоритет у enabled=true; затем любой с apiKey
    const candidates = [];
    for (const [id, p] of Object.entries(providers)) {
      const apiKey = p && p.options && p.options.apiKey;
      if (!apiKey || typeof apiKey !== 'string') continue;
      if (apiKey.startsWith('enc:') || apiKey.length < 30) continue; // зашифрованный или не похож на JWT — пропускаем
      candidates.push({ id, provider: p, apiKey });
    }
    // enabled имеет приоритет
    candidates.sort((a, b) => (b.provider.enabled ? 1 : 0) - (a.provider.enabled ? 1 : 0));

    for (const c of candidates) {
      const payload = decodeJwt(c.apiKey);
      if (payload && (payload.user_id || payload.sub)) {
        return buildFingerprint(payload.user_id || payload.sub, c.id, profile,
          profile && profile.email ? 'config.jwt+credentials.user_info' : 'config.jwt');
      }
    }
  } catch (_) {}

  // 2. Новый клиент: JWT (zcodejwttoken) в credentials.json; без него — user_id из user_info / access_token
  const credUserId = profile && (profile.jwtUserId || profile.credentialUserId || profile.accessUserId);
  if (credUserId) {
    return buildFingerprint(credUserId, profile.activeProvider, profile,
      profile.email ? 'credentials.jwt+credentials.user_info' : 'credentials.jwt');
  }

  // 3. Запасной вариант: логин не расшифровывается (ключ другой машины),
  //    генерируем слабый отпечаток из шифрованной строки active_provider (только для дедупликации)
  try {
    const rawCred = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    const hash = simpleHash(rawCred['oauth:active_provider'] || '');
    return buildFingerprint('enc-' + hash, (profile && profile.activeProvider) || '(encrypted)', profile, 'credentials.fallback');
  } catch (_) {}

  return null;
}

function buildFingerprint(userId, provider, profile, source) {
  const shortId = String(userId).slice(0, 8);
  const email = profile && profile.email;
  // Ключ дедупликации по почте: есть почта → хеш почты, нет → короткий user_id
  const emailShortId = email ? ('em-' + simpleHash(email.toLowerCase()).slice(0, 10)) : shortId;
  return {
    userId,
    shortId,
    emailShortId,
    provider,
    label: (profile && (profile.email || profile.name)) || 'Аккаунт-' + shortId,
    email,
    name: profile && profile.name,
    avatar: profile && profile.avatar,
    customerId: profile && profile.customerId,
    userKey: profile && profile.userKey,
    source,
  };
}

function simpleHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

module.exports = { decodeJwt, readCredentialProfile, extractFingerprint };
