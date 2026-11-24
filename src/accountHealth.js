'use strict';
/**
 * Проверка «здоровья» снимка аккаунта
 *
 * Цель: перед реальным переключением с помощью лёгких статических проверок
 * понять, «цел / читаем / с большой вероятностью пригоден» ли снимок аккаунта.
 * Здесь — только локальная проверка структуры и полей, сеть не затрагивается.
 */
const { decodeJwt } = require('./fingerprint');
const { decrypt, decryptJson, isEncrypted } = require('./zcodeCrypto');
const quota = require('./quota');

function validateSnapshot(snapshot, meta = {}) {
  const details = {
    hasCredentials: false,
    hasConfig: false,
    canParseCredentials: false,
    canParseConfig: false,
    hasTokens: false,
    canDecryptUserInfo: false,
    hasProviderApiKey: false,
    userId: meta.userId || null,
    provider: meta.provider || null,
  };
  const warnings = [];
  const errors = [];

  if (!snapshot || typeof snapshot !== 'object') {
    return finalize(details, warnings, ['Снимок аккаунта отсутствует или имеет неверный формат']);
  }

  details.hasCredentials = typeof snapshot.credentials === 'string' && snapshot.credentials.trim() !== '';
  // config.json есть только у старых версий клиента — его отсутствие не ошибка
  details.hasConfig = typeof snapshot.config === 'string' && snapshot.config.trim() !== '';

  if (!details.hasCredentials) errors.push('Отсутствует логин credentials');
  if (!details.hasCredentials) return finalize(details, warnings, errors);

  let credentials = null;
  let config = null;

  try {
    credentials = JSON.parse(snapshot.credentials);
    details.canParseCredentials = true;
  } catch (_) {
    errors.push('credentials.json не является корректным JSON');
  }

  if (details.hasConfig) {
    try {
      config = JSON.parse(snapshot.config);
      details.canParseConfig = true;
    } catch (_) {
      errors.push('config.json не является корректным JSON');
    }
  }

  if (!details.canParseCredentials || (details.hasConfig && !details.canParseConfig)) return finalize(details, warnings, errors);

  const tokens = quota.readCandidateTokensFromSnapshot(snapshot);
  details.hasTokens = tokens.length > 0;
  if (!details.hasTokens) {
    errors.push('Не найден token для входа/запроса');
  }

  const providerInfo = extractProviderInfo(credentials, config);
  details.provider = details.provider || providerInfo.provider || null;
  details.hasProviderApiKey = !!providerInfo.apiKey;
  details.userId = details.userId || providerInfo.userId || null;

  if (!details.hasProviderApiKey) {
    warnings.push('Не найден apiKey активного provider');
  }
  if (!details.userId) {
    warnings.push('Не удалось извлечь стабильный user_id из снимка');
  }

  const userInfoState = checkUserInfo(credentials, providerInfo.provider);
  details.canDecryptUserInfo = userInfoState.canDecryptUserInfo;
  if (userInfoState.warning) warnings.push(userInfoState.warning);

  return finalize(details, warnings, errors);
}

function extractProviderInfo(credentials, config) {
  const activeProvider = readActiveProvider(credentials);
  const providers = config && config.provider && typeof config.provider === 'object' ? config.provider : {};
  const candidates = [];

  // Новый клиент: вместо apiKey в config.json — зашифрованный JWT (zcodejwttoken) в credentials.json
  const zcodeJwt = decryptOrNull(credentials && credentials.zcodejwttoken);
  if (zcodeJwt) {
    const payload = decodeJwt(zcodeJwt);
    candidates.push({
      id: activeProvider || 'zcodejwttoken',
      enabled: true,
      apiKey: zcodeJwt,
      userId: payload && (payload.user_id || payload.sub),
    });
  }

  for (const [id, p] of Object.entries(providers)) {
    const apiKey = p && p.options && p.options.apiKey;
    if (!apiKey || typeof apiKey !== 'string') continue;
    const payload = decodeJwt(apiKey);
    candidates.push({
      id,
      enabled: !!(p && p.enabled),
      apiKey,
      userId: payload && (payload.user_id || payload.sub),
    });
  }

  candidates.sort((a, b) => Number(b.enabled) - Number(a.enabled));
  const preferred = candidates[0] || null;

  return {
    provider: activeProvider || (preferred && preferred.id) || null,
    apiKey: preferred && preferred.apiKey,
    userId: preferred && preferred.userId,
  };
}

function readActiveProvider(credentials) {
  if (!credentials || typeof credentials !== 'object') return null;
  return decryptOrNull(credentials['oauth:active_provider']);
}

/** Значение из credentials.json: расшифровывает, если оно зашифровано; null — если значения нет или ключ недоступен */
function decryptOrNull(value) {
  if (!value) return null;
  try {
    const plain = isEncrypted(value) ? decrypt(value) : value;
    return typeof plain === 'string' ? plain : null;
  } catch (_) {
    return null;
  }
}

function checkUserInfo(credentials, provider) {
  if (!credentials || typeof credentials !== 'object') {
    return { canDecryptUserInfo: false, warning: 'Структура credentials нарушена — невозможно проверить user_info' };
  }

  const keys = [];
  if (provider) keys.push(`oauth:${provider}:user_info`);
  keys.push('oauth:zai:user_info', 'oauth:bigmodel:user_info');

  for (const key of keys) {
    const value = credentials[key];
    if (!value) continue;
    if (!isEncrypted(value)) return { canDecryptUserInfo: true };
    try {
      const data = decryptJson(value);
      if (data && typeof data === 'object') return { canDecryptUserInfo: true };
      return { canDecryptUserInfo: false, warning: 'user_info присутствует, но после расшифровки это не корректный JSON' };
    } catch (_) {
      return { canDecryptUserInfo: false, warning: 'user_info нельзя расшифровать в окружении этой машины' };
    }
  }

  return { canDecryptUserInfo: false, warning: 'user_info не найден — данные профиля в интерфейсе могут быть неполными' };
}

function finalize(details, warnings, errors) {
  const status = errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'healthy';
  const summary =
    status === 'healthy'
      ? 'Снимок цел, можно использовать'
      : status === 'warning'
        ? warnings[0]
        : errors[0];
  return { status, summary, warnings, errors, details };
}

module.exports = {
  validateSnapshot,
};
