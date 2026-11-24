'use strict';
/**
 * Шифрование/расшифровка credentials ZCode в форматах enc:v1 и enc:v2
 *
 * Подтверждено реверсом ZCode app.asar:
 *   - алгоритм: aes-256-gcm
 *   - тело: <nonce_base64url>.<authTag_base64url>.<cipherText_base64url> (nonce 12 байт, authTag 16 байт)
 *
 * enc:v1 (старые версии клиента):
 *   - формат: enc:v1:<тело>
 *   - ключ: sha256(secret)
 *   - secret: приоритет у process.env.ZCODE_CREDENTIAL_SECRET, иначе
 *     `zcode-credential-fallback:${platform}:${homedir}:${username}`
 *
 * enc:v2 (проверено на клиенте 4.0.0):
 *   - формат: enc:v2:<os|env>:<fingerprint>:<тело>, fingerprint = sha256(ключ).hex[:24]
 *   - источник "env": ключ = sha256(secret) — как у enc:v1
 *   - источник "os": 32 случайных байта в системном хранилище секретов. На macOS — Keychain:
 *     сервис "ZCode Credential Encryption", account = sha256(абсолютный путь credentials.json) в hex.
 *     Ключ привязан к машине → значения enc:v2:os с другой машины не расшифровываются.
 *   - чтение ключа "os" реализовано только для macOS (утилита `security`)
 *
 * Это позволяет инструменту читать/писать зашифрованные поля credentials.json
 * в окружении текущего пользователя.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const { CREDENTIALS_FILE } = require('./paths');

const PREFIX = 'enc:v1:';
const PREFIX_V2 = 'enc:v2:';
const PREFIX_V2_OS = 'enc:v2:os:';
const PREFIX_V2_ENV = 'enc:v2:env:';
const KEYCHAIN_SERVICE = 'ZCode Credential Encryption';
const ALGO = 'aes-256-gcm';
const NONCE_SIZE = 12;
const TAG_SIZE = 16;
const KEY_SIZE = 32;
const CREDENTIAL_SECRET_ENV = 'ZCODE_CREDENTIAL_SECRET';
const KEYCHAIN_TIMEOUT_MS = 60000;

function defaultCredentialSecret(env = process.env) {
  if (env[CREDENTIAL_SECRET_ENV]) return env[CREDENTIAL_SECRET_ENV];
  let username = 'unknown';
  try { username = os.userInfo().username; } catch (_) {}
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
}

function deriveKey(secret = defaultCredentialSecret()) {
  return crypto.createHash('sha256').update(secret).digest();
}

function b64urlToBuffer(s) {
  return Buffer.from(s, 'base64url');
}

function bufferToB64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** Любое значение в конверте enc: (v1, v2 и неизвестные версии — они упадут в decrypt, а не вернутся как открытый текст) */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('enc:');
}

// ---- Ключ enc:v2:os из системного хранилища секретов ----

// Результат обращения к хранилищу: { key: Buffer|null, error?: Error }. Кэш на время процесса:
// каждое обращение к Keychain может показать пользователю запрос доступа, поэтому повторяем его не чаще раза за запуск
let osKeyLookup;

function keychainAccountFor(credentialsFile) {
  return crypto.createHash('sha256').update(credentialsFile).digest('hex');
}

function lookupOsKey() {
  if (osKeyLookup) return osKeyLookup;
  const result = { key: null };
  if (process.platform === 'darwin') {
    try {
      const encoded = execFileSync('/usr/bin/security', [
        'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', keychainAccountFor(CREDENTIALS_FILE), '-w',
      ], { encoding: 'utf8', timeout: KEYCHAIN_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (encoded) {
        result.key = Buffer.from(encoded, 'base64url');
        if (result.key.length !== KEY_SIZE) throw new Error('Ключ шифрования ZCode в Keychain имеет неверную длину: ' + result.key.length);
      }
    } catch (e) {
      // Таймаут = macOS ждёт, пока пользователь разрешит доступ к записи Keychain
      if (e.code === 'ETIMEDOUT') {
        result.error = new Error('Истекло ожидание доступа к Keychain. Разрешите утилите `security` читать запись "' +
          KEYCHAIN_SERVICE + '" (кнопка «Всегда разрешать») и повторите');
      } else if (e.status !== 44) {
        // Код 44 = errSecItemNotFound: записи нет (клиент ещё не создавал ключ) — это не ошибка.
        // Иначе — Keychain закрыт или доступ запрещён
        result.error = new Error('Не удалось прочитать ключ шифрования ZCode из Keychain: ' + ((e.stderr && String(e.stderr).trim()) || e.message));
      }
    }
  }
  osKeyLookup = result;
  return result;
}

/**
 * Ищет ключ enc:v2:os в системном хранилище секретов (обращается к хранилищу один раз за процесс).
 * macOS: Keychain, сервис "ZCode Credential Encryption", account = sha256(путь credentials.json) в hex.
 * @returns {Buffer|null} 32 байта либо null, если записи нет
 * @throws {Error} хранилище недоступно или доступ не разрешён
 */
function findOsKey() {
  const result = lookupOsKey();
  if (result.error) throw result.error;
  return result.key;
}

/** Ключ enc:v2:os этой машины; бросает ошибку с причиной, если он недоступен */
function getOsKey() {
  if (process.platform !== 'darwin') throw new Error('Чтение ключа enc:v2:os поддержано только на macOS (Keychain)');
  const key = findOsKey();
  if (!key) {
    throw new Error('В Keychain нет ключа ZCode ("' + KEYCHAIN_SERVICE + '") — логин зашифрован на другой машине или под другой учётной записью');
  }
  return key;
}

/** fingerprint ключа — первые 24 hex-символа sha256(ключ), как в значении enc:v2 */
function keyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
}

// ---- Шифрование / расшифровка ----

/** Шифрует текст ключом: nonce.tag.cipher (base64url) */
function seal(plainText, key) {
  const nonce = crypto.randomBytes(NONCE_SIZE);
  const cipher = crypto.createCipheriv(ALGO, key, nonce);
  const cipherText = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), cipherText].map(bufferToB64url).join('.');
}

/** Расшифровывает nonce.tag.cipher (base64url) ключом */
function openSealed(sealed, key, format) {
  const parts = sealed.split('.');
  if (parts.length !== 3) throw new Error('Неверный формат ' + format);
  const [nonce, tag, cipherText] = parts.map(b64urlToBuffer);
  if (nonce.length !== NONCE_SIZE || tag.length !== TAG_SIZE) throw new Error('Неверный формат ' + format);
  const decipher = crypto.createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
}

/** Расшифровывает значение enc:v2:<os|env>:<fingerprint>:<тело>; ключ сверяется по fingerprint, как это делает клиент */
function decryptV2(value, secret) {
  const parts = value.slice(PREFIX_V2.length).split(':');
  if (parts.length !== 3) throw new Error('Неверный формат enc:v2');
  const [source, fingerprint, sealed] = parts;
  const key = source === 'os' ? getOsKey() : source === 'env' ? deriveKey(secret) : null;
  if (!key) throw new Error('Неизвестный источник ключа enc:v2: ' + source);
  if (keyFingerprint(key) !== fingerprint) {
    throw new Error('Значение enc:v2:' + source + ' зашифровано другим ключом (fingerprint ' + fingerprint + ')' +
      (source === 'env' ? ' — не задан ZCODE_CREDENTIAL_SECRET' : ' — снимок сделан на другой машине'));
  }
  return openSealed(sealed, key, 'enc:v2');
}

function decrypt(value, secret = defaultCredentialSecret()) {
  if (!isEncrypted(value)) return value;
  if (value.startsWith(PREFIX_V2)) return decryptV2(value, secret);
  if (!value.startsWith(PREFIX)) {
    throw new Error('Неподдерживаемый формат шифрования: ' + value.slice(0, value.indexOf(':', 4) + 1));
  }
  return openSealed(value.slice(PREFIX.length), deriveKey(secret), 'enc:v1');
}

/**
 * Формат, в котором клиент ZCode шифрует credentials на этой машине (для encrypt).
 * Ориентируется на содержимое credentials.json: ключ в системном хранилище создаёт
 * только новый клиент (старый пишет enc:v1).
 * @returns {'v2:os'|'v2:env'|'v1'}
 */
function detectEncryptFormat() {
  let text = '';
  try { text = fs.readFileSync(CREDENTIALS_FILE, 'utf8'); } catch (_) {}
  if (text.includes(PREFIX_V2_ENV)) return 'v2:env';
  if (text.includes(PREFIX_V2_OS) || findOsKey()) return 'v2:os';
  return 'v1';
}

/** Шифрует текст в формате, который использует клиент ZCode на этой машине (см. detectEncryptFormat) */
function encrypt(plainText, secret = defaultCredentialSecret()) {
  const format = detectEncryptFormat();
  if (format === 'v1') return PREFIX + seal(plainText, deriveKey(secret));
  const key = format === 'v2:env' ? deriveKey(secret) : getOsKey();
  return (format === 'v2:env' ? PREFIX_V2_ENV : PREFIX_V2_OS) + keyFingerprint(key) + ':' + seal(plainText, key);
}

function tryJson(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

function decryptJson(value, secret = defaultCredentialSecret()) {
  const plain = decrypt(value, secret);
  return tryJson(plain);
}

module.exports = {
  PREFIX,
  PREFIX_V2,
  PREFIX_V2_OS,
  PREFIX_V2_ENV,
  KEYCHAIN_SERVICE,
  isEncrypted,
  defaultCredentialSecret,
  deriveKey,
  detectEncryptFormat,
  findOsKey,
  keyFingerprint,
  decrypt,
  encrypt,
  decryptJson,
};
