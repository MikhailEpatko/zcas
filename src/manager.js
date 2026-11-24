'use strict';
/**
 * Управление снимками аккаунтов: list / capture / delete / rename / load
 *
 * Структура хранилища:
 *   accounts/
 *     <shortId>.meta.json   -> { id, shortId, provider, label, note, capturedAt, filename }
 *     <shortId>.snap.json    -> { credentials, config }  (полный логин)
 */
const fs = require('fs');
const path = require('path');
const { STORE_DIR } = require('./paths');
const { extractFingerprint } = require('./fingerprint');
const { readSnapshot, switchTo, rollback } = require('./switcher');
const { validateSnapshot } = require('./accountHealth');

function ensureStore() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

function metaPath(id) { return path.join(STORE_DIR, id + '.meta.json'); }
function snapPath(id) { return path.join(STORE_DIR, id + '.snap.json'); }

/**
 * Выводит список всех сохранённых аккаунтов
 * @returns {Array<{id, shortId, provider, label, note, capturedAt, sizeKb}>}
 */
function list() {
  ensureStore();
  const files = fs.readdirSync(STORE_DIR).filter((f) => f.endsWith('.meta.json'));
  const result = [];
  for (const f of files) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(STORE_DIR, f), 'utf8'));
      let sizeKb = 0;
      let health = {
        status: 'error',
        summary: 'Снимок аккаунта отсутствует или нечитаем',
        warnings: [],
        errors: ['Снимок аккаунта отсутствует или нечитаем'],
        details: {},
      };
      try {
        const stat = fs.statSync(snapPath(meta.id));
        sizeKb = Math.round(stat.size / 1024);
        const snapshot = load(meta.id);
        health = validateSnapshot(snapshot, meta);
      } catch (_) {}
      result.push({ ...meta, sizeKb, health });
    } catch (_) {}
  }
  result.sort((a, b) => (a.capturedAt || 0) - (b.capturedAt || 0));
  return result;
}

/**
 * Сохраняет снимок текущего логина как новый аккаунт
 * @param {{label?:string, note?:string, overwrite?:boolean}} opts
 * @returns {{id, meta, created:boolean}}
 */
function capture(opts = {}) {
  const { label, note = '', overwrite = false } = opts;
  ensureStore();

  const fp = extractFingerprint();
  if (!fp) throw new Error('Не удалось извлечь отпечаток аккаунта из текущего логина (сначала войдите в любой аккаунт в ZCode)');

  // Дедупликация по email: id предпочтительно использовать emailShortId (та же почта = перезапись), без почты — короткий shortId
  const id = fp.emailShortId || fp.shortId;
  const exists = fs.existsSync(metaPath(id));

  if (exists && !overwrite) {
    // Уже существует → пропускаем (та же почта считается одним аккаунтом)
    const oldMeta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
    return { id, meta: oldMeta, created: false, skipped: true, message: 'Этот аккаунт уже существует (' + oldMeta.label + ')' };
  }

  const snap = readSnapshot();
  fs.writeFileSync(snapPath(id), JSON.stringify(snap, null, 0), 'utf8');

  const meta = {
    id,
    shortId: fp.shortId,
    emailShortId: fp.emailShortId || fp.shortId,
    userId: fp.userId,
    provider: fp.provider,
    label: label || fp.label,
    email: fp.email,
    name: fp.name,
    avatar: fp.avatar,
    customerId: fp.customerId,
    userKey: fp.userKey,
    source: fp.source,
    note,
    capturedAt: Date.now(),
  };
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2), 'utf8');

  return { id, meta, created: true };
}

/** Читает один снимок аккаунта (без переключения) */
function load(id) {
  const p = snapPath(id);
  if (!fs.existsSync(p)) throw new Error('Снимок аккаунта не найден: ' + id);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Переключается на указанный аккаунт */
async function use(id, opts = {}) {
  if (!fs.existsSync(snapPath(id))) throw new Error('Снимок аккаунта не найден: ' + id);
  const snap = load(id);
  return switchTo(snap, opts);
}

/** Удаляет снимок аккаунта */
function remove(id) {
  let removed = 0;
  for (const f of [metaPath(id), snapPath(id)]) {
    try { fs.unlinkSync(f); removed++; } catch (_) {}
  }
  return removed > 0;
}

/** Переименовывает аккаунт (меняет label/note) */
function rename(id, label, note) {
  if (!fs.existsSync(metaPath(id))) throw new Error('Аккаунт не найден: ' + id);
  const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  if (label) meta.label = label;
  if (note !== undefined) meta.note = note;
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

function safeId(id) {
  const s = String(id || '').trim();
  if (!/^[a-zA-Z0-9_-]{4,64}$/.test(s)) throw new Error('Недопустимый id аккаунта: ' + s);
  return s;
}

function atomicWriteJson(filePath, data, compact = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, compact ? 0 : 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function assertJsonText(text, name) {
  if (typeof text !== 'string' || !text.trim()) throw new Error(name + ' пуст');
  try { JSON.parse(text); } catch (e) { throw new Error(name + ' не является корректным JSON: ' + e.message); }
}

/** Экспортирует снимки аккаунтов (по умолчанию все) */
function exportAccounts(ids) {
  ensureStore();
  const wanted = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  const metas = list().filter((m) => !wanted || wanted.has(m.id));
  const accounts = [];
  for (const meta of metas) {
    const id = safeId(meta.id);
    const sp = snapPath(id);
    if (!fs.existsSync(sp)) continue;
    accounts.push({
      meta,
      snapshot: JSON.parse(fs.readFileSync(sp, 'utf8')),
    });
  }
  return {
    version: 1,
    app: 'zcode-account-switcher',
    exportedAt: Date.now(),
    accounts,
  };
}

/** Импортирует снимки аккаунтов, по умолчанию пропуская уже существующие */
function importAccounts(payload, opts = {}) {
  ensureStore();
  const overwrite = !!opts.overwrite;
  if (!payload || typeof payload !== 'object') throw new Error('Неверный формат файла импорта');
  if (!Array.isArray(payload.accounts)) throw new Error('В файле импорта отсутствует массив accounts');

  const imported = [];
  const skipped = [];
  for (const item of payload.accounts) {
    try {
      const meta = item && item.meta;
      const snapshot = item && item.snapshot;
      const id = safeId(meta && meta.id);
      if (!snapshot || typeof snapshot !== 'object') throw new Error('отсутствует snapshot');
      assertJsonText(snapshot.credentials, 'credentials');
      // config есть только у старых версий клиента
      if (snapshot.config != null) assertJsonText(snapshot.config, 'config');

      if (!overwrite && (fs.existsSync(metaPath(id)) || fs.existsSync(snapPath(id)))) {
        skipped.push({ id, label: meta.label, reason: 'уже существует' });
        continue;
      }

      const cleanMeta = { ...meta, id };
      atomicWriteJson(snapPath(id), {
        credentials: snapshot.credentials,
        config: snapshot.config,
      }, true);
      atomicWriteJson(metaPath(id), cleanMeta, false);
      imported.push({ id, label: cleanMeta.label || cleanMeta.email || id });
    } catch (e) {
      skipped.push({ id: item && item.meta && item.meta.id, reason: e.message || String(e) });
    }
  }
  return { imported, skipped, count: imported.length };
}

/** Отпечаток текущего логина (для status) */
function current() {
  return extractFingerprint();
}

module.exports = { list, capture, load, use, remove, rename, current, exportAccounts, importAccounts, metaPath, snapPath };
