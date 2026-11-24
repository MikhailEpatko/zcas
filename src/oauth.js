'use strict';
/**
 * Запись учётных данных ZCode OAuth на диск + снимок аккаунта
 *
 * Поток (CLI OAuth + системный браузер):
 *   1. oauthCli.ZaiAuthFlow.poll() после входа пользователя возвращает {token, zaiAccessToken, refreshToken, user}
 *      (token — zcode JWT из CLI OAuth, уже содержит права на запрос биллинга)
 *   2. finishLogin(tokenSet) → writeOAuthCredentials зашифрованно пишет на диск
 *   3. manager.capture() делает снимок аккаунта
 *
 * Этот модуль НЕ отвечает за генерацию URL входа / сетевой обмен на token (это в oauthCli.js).
 * Здесь только: безопасная запись полученного набора token в файлы логина ZCode + вспомогательные функции.
 */
const fs = require('fs');
const path = require('path');
const { CREDENTIALS_FILE, CONFIG_FILE } = require('./paths');
const { encrypt, detectEncryptFormat } = require('./zcodeCrypto');
const { extractFingerprint } = require('./fingerprint');
const manager = require('./manager');

// ===== Конфигурация Z.ai provider (для полей при записи на диск) =====
// Совпадает с oauthBrowser.OAUTH; вход bigmodel удалён (в новом потоке только zai)
const PROVIDER = {
  id: 'zai',
  providerIds: ['builtin:zai-start-plan', 'builtin:zai-coding-plan', 'builtin:zai'],
};

/**
 * Записывает набор token (из oauthBrowser) в файлы логина ZCode, затем делает снимок аккаунта.
 *
 * @param {object} opts
 * @param {object} opts.tokenSet - возврат oauthBrowser.exchangeToken()
 * @param {string} opts.tokenSet.token - zcode JWT (обязателен)
 * @param {string} [opts.tokenSet.zaiAccessToken] - zai oauth access_token
 * @param {string} [opts.tokenSet.refreshToken] - zai refresh_token
 * @param {object} [opts.tokenSet.user] - данные пользователя (email/name/avatar...)
 * @param {string} [opts.label] - пользовательское имя аккаунта (если пусто — берётся email)
 * @param {string} [opts.note='']
 * @param {boolean} [opts.overwrite=true]
 */
async function finishLogin({ tokenSet, label, note = '', overwrite = true } = {}) {
  if (!tokenSet || !tokenSet.token) throw new Error('Отсутствует token (zcode JWT)');

  const userInfo = normalizeUserInfo(tokenSet.user || {});

  // Сохраняем прежнее содержимое логина (снимок в память перед записью), восстановим после capture —
  // чтобы добавление аккаунта не затрагивало текущий логин
  const prevCredentials = fs.existsSync(CREDENTIALS_FILE) ? fs.readFileSync(CREDENTIALS_FILE, 'utf8') : null;
  const prevConfig = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;

  // Пишем token нового аккаунта (capture-у нужно прочитать актуальный логин из каталога v2)
  writeOAuthCredentials(tokenSet, userInfo);

  let captured;
  try {
    captured = manager.capture({ label, note, overwrite });
  } finally {
    // Восстанавливаем прежний логин: возвращаем в каталог v2 credentials/config к содержимому до capture
    // (в том числе если capture упал). Так клиент ZCode и фронтенд инструмента продолжат видеть
    // "текущий аккаунт" прежним (добавление не переключает)
    if (prevCredentials !== null) fs.writeFileSync(CREDENTIALS_FILE, prevCredentials, 'utf8');
    if (prevConfig !== null) fs.writeFileSync(CONFIG_FILE, prevConfig, 'utf8');
  }

  return {
    userInfo,
    fingerprint: extractFingerprint(),
    account: captured.meta,
    created: captured.created,
    skipped: captured.skipped,
  };
}

/**
 * Зашифрованно записывает набор token в credentials.json + config.json.
 *
 * Поля при записи (совпадают с реальной структурой клиента ZCode):
 *   credentials.json:
 *     oauth:active_provider          = enc(zai)
 *     oauth:zai:access_token         = enc(zaiAccessToken)
 *     oauth:zai:refresh_token        = enc(refreshToken)
 *     oauth:zai:user_info            = enc(user JSON)
 *     zcodejwttoken                  = enc(token)            ← JWT для вызова API
 *   config.json (только старый клиент; новый (4.x) этот файл не использует и не создаёт):
 *     provider[builtin:zai-*].options.apiKey = token(открытый JWT, содержит user_id)
 *
 * @returns {{credentialsFile:string, configFile:string|null}} configFile = null, если config.json не писался
 */
function writeOAuthCredentials(tokenSet, userInfo = {}) {
  backupCurrentLoginState('oauth');

  const credentials = readJsonIfExists(CREDENTIALS_FILE, {});
  // Если клиент хранит логин в формате enc:v2 (или уже привязал ключ к системе) — config.json ему не нужен
  const config = detectEncryptFormat() === 'v1' ? readJsonIfExists(CONFIG_FILE, {}) : null;

  const zcodeJwtToken = tokenSet.token;          // JWT для вызова API
  const accessToken = tokenSet.zaiAccessToken;    // zai oauth access_token
  const refreshToken = tokenSet.refreshToken;

  credentials['oauth:active_provider'] = encrypt(PROVIDER.id);
  if (accessToken) credentials[`oauth:${PROVIDER.id}:access_token`] = encrypt(accessToken);
  if (refreshToken) credentials[`oauth:${PROVIDER.id}:refresh_token`] = encrypt(refreshToken);
  if (zcodeJwtToken) credentials.zcodejwttoken = encrypt(zcodeJwtToken);
  credentials[`oauth:${PROVIDER.id}:user_info`] = encrypt(JSON.stringify(userInfo || {}));

  if (config) {
    if (!config.provider || typeof config.provider !== 'object') config.provider = {};
    if (zcodeJwtToken) updateConfigProviders(config, PROVIDER, zcodeJwtToken);
  }

  atomicWriteJson(CREDENTIALS_FILE, credentials);
  if (config) atomicWriteJson(CONFIG_FILE, config);

  return { credentialsFile: CREDENTIALS_FILE, configFile: config ? CONFIG_FILE : null };
}

/**
 * Записывает apiKey(JWT) zai в слоты всех zai-provider в config.json и отключает остальные provider.
 */
function updateConfigProviders(config, provider, apiKey) {
  for (const id of provider.providerIds) {
    if (!config.provider[id] || typeof config.provider[id] !== 'object') {
      config.provider[id] = { enabled: true, options: {} };
    }
    if (!config.provider[id].options || typeof config.provider[id].options !== 'object') {
      config.provider[id].options = {};
    }
    config.provider[id].enabled = true;
    config.provider[id].options.apiKey = apiKey;
  }
}

// ===== Вспомогательные функции =====

/** Приводит объект user из oauthBrowser к стандартному userInfo */
function normalizeUserInfo(user) {
  const u = user || {};
  return {
    email: u.email || u.mail || '',
    name: u.name || u.username || u.nickName || u.displayName || '',
    avatar: u.avatar || u.avatarUrl || u.picture || '',
    user_id: u.user_id || u.userId || u.id || u.customerNumber || u.sub || '',
  };
}

function backupCurrentLoginState(reason = 'backup') {
  const dir = path.join(__dirname, '..', '.last', reason + '-' + timestamp());
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(CREDENTIALS_FILE)) fs.copyFileSync(CREDENTIALS_FILE, path.join(dir, 'credentials.json'));
  if (fs.existsSync(CONFIG_FILE)) fs.copyFileSync(CONFIG_FILE, path.join(dir, 'config.json'));
  return dir;
}

function readJsonIfExists(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error('Не удалось прочитать JSON ' + filePath + ': ' + e.message);
  }
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.zcas.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = {
  PROVIDER,
  finishLogin,
  writeOAuthCredentials,
  updateConfigProviders,
  normalizeUserInfo,
};
