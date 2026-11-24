'use strict';
/**
 * Ядро переключения: обнаружение процесса / резервное копирование / замена логина / откат (кроссплатформенно: Windows + Linux + macOS)
 *
 * Стратегия безопасности:
 *   1. Перед переключением ZCode необходимо закрыть (менять credentials.json/config.json
 *      на работающем клиенте ненадёжно — клиент сам перезаписывает файлы)
 *   2. Перед заменой текущие копии файлов бэкапятся в .last (для отката в один шаг)
 *   3. Атомарная запись: пишем в .tmp, затем делаем rename (исключает «полу-записанный» логин)
 *
 * Логин нового клиента (4.x) — только credentials.json; config.json есть лишь у старых версий,
 * поэтому снимок без config — норма (см. readSnapshot).
 */
const fs = require('fs');
const path = require('path');
const { exec, execSync, execFileSync } = require('child_process');
const { CREDENTIALS_FILE, CONFIG_FILE, findZCodeExe, findZCodeLaunch } = require('./paths');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const BACKUP_DIR = path.join(__dirname, '..', '.last'); // логин до последнего переключения (для отката)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Windows: имя образа главного процесса ZCode (для tasklist)
 */
const WIN_IMAGENAME = 'ZCode.exe';

/** Экранирует строку в фиксированное регулярное выражение для pgrep -f (убирает спецсимволы) */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Обнаружение процесса (кроссплатформенно)
// ============================================================================

/**
 * Проверяет, запущен ли ZCode
 *
 * Windows: tasklist /FI IMAGENAME eq ZCode.exe
 * Linux:   точное совпадение comm == ZCode, либо командная строка содержит путь AppImage;
 *          не используем широкий grep 'zcode' (он ошибочно матчил бы zcode-cli, zcode-host, этот инструмент)
 * macOS:   тот же путь, что на Linux: главный процесс приложения .app находится через pgrep -x ZCode
 */
function isZCodeRunning() {
  if (IS_WIN) {
    try {
      const out = execSync('tasklist /FI "IMAGENAME eq ' + WIN_IMAGENAME + '" /NH /FO CSV', {
        encoding: 'utf8',
        windowsHide: true,
      });
      return new RegExp('"' + WIN_IMAGENAME + '"', 'i').test(out);
    } catch (_) {
      return false;
    }
  }

  // Linux
  try {
    // 1) Точное совпадение comm == ZCode
    try {
      execSync('pgrep -x ZCode', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return true;
    } catch (_) {}

    // 2) Путь к файлу AppImage присутствует в командной строке
    const launch = findZCodeLaunch();
    if (launch && launch.cmd) {
      const pat = escapeRegex(launch.cmd);
      try {
        execSync('pgrep -f ' + JSON.stringify(pat), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return true;
      } catch (_) {}
    }
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Linux: собирает PID главного процесса ZCode (comm==ZCode + командная строка содержит путь AppImage), с дедупликацией.
 * Не собирает дочерние процессы zcode-cli / zcode-host / crashpad (они завершаются вместе с главным процессом).
 * @returns {number[]}
 */
function collectZCodePids() {
  const pidSet = new Set();

  // 1) Точное совпадение comm == ZCode
  try {
    const out = execSync('pgrep -x ZCode', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split(/\r?\n/)) {
      const n = parseInt(line.trim(), 10);
      if (n > 0) pidSet.add(n);
    }
  } catch (_) {}

  // 2) Процессы, в командной строке которых есть путь к AppImage (настоящая точка входа главного процесса Electron)
  const launch = findZCodeLaunch();
  if (launch && launch.cmd) {
    try {
      const pat = escapeRegex(launch.cmd);
      const out = execSync('pgrep -f ' + JSON.stringify(pat), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split(/\r?\n/)) {
        const n = parseInt(line.trim(), 10);
        if (n > 0 && n !== process.pid) pidSet.add(n);
      }
    } catch (_) {}
  }

  return Array.from(pidSet);
}

/**
 * Закрывает ZCode (все процессы). Ждёт максимум waitMs.
 *
 * Windows: taskkill /F /IM ZCode.exe
 * Linux:   сначала SIGTERM, ждём корректного выхода; если по таймауту не вышел — SIGKILL.
 *          Действует только на главный процесс ZCode (comm==ZCode / путь AppImage),
 *          не «убивает» широкий поиск по 'zcode'.
 */
async function killZCode({ waitMs = 8000 } = {}) {
  if (!isZCodeRunning()) return true;

  if (IS_WIN) {
    try {
      execSync('taskkill /F /IM ' + WIN_IMAGENAME, { encoding: 'utf8', windowsHide: true, stdio: 'ignore' });
    } catch (_) {
      // Даже если taskkill завершился с ошибкой — продолжаем ждать
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (!isZCodeRunning()) return true;
      await sleep(400);
    }
    return !isZCodeRunning();
  }

  // Linux: собираем целевые PID и посылаем сигналы каждому
  const pids = collectZCodePids();
  if (!pids.length) return !isZCodeRunning();

  // SIGTERM — корректный выход
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isZCodeRunning()) return true;
    await sleep(400);
  }
  // Всё ещё не вышел → SIGKILL
  for (const pid of collectZCodePids()) {
    try { process.kill(pid, 'SIGKILL'); } catch (_) {}
  }
  await sleep(500);
  return !isZCodeRunning();
}

/**
 * Запускает ZCode
 *
 * Windows: напрямую exec exe, detached
 * Linux:   использует обнаруженный AppImage/исполняемый файл + аргументы, spawn detached, не блокирует;
 *          DISPLAY/WAYLAND наследуются от окружения вызывающей стороны.
 * macOS:   open -a <ZCode.app> через LaunchServices — приложение не наследует окружение CLI,
 *          а уже запущенное просто активируется (второй экземпляр не стартует).
 */
function launchZCode() {
  if (IS_WIN) {
    const exe = findZCodeExe();
    if (!exe) throw new Error('ZCode.exe не найден — проверьте путь установки (ZCODE_EXE_CANDIDATES_WIN в paths.js) или задайте ZCODE_BIN');
    try {
      exec('"' + exe + '"', { windowsHide: false, detached: true, stdio: 'ignore' }).unref();
      return true;
    } catch (e) {
      throw new Error('Не удалось запустить ZCode: ' + e.message);
    }
  }

  if (IS_MAC) {
    const exe = findZCodeExe();
    if (!exe) throw new Error('ZCode.app не найден — проверьте /Applications/ZCode.app или задайте ZCODE_BIN');
    try {
      // .../ZCode.app/Contents/MacOS/ZCode -> .../ZCode.app
      execFileSync('open', ['-a', path.resolve(exe, '..', '..', '..')], { stdio: 'ignore' });
      return true;
    } catch (e) {
      throw new Error('Не удалось запустить ZCode: ' + e.message);
    }
  }

  // Linux
  const launch = findZCodeLaunch();
  if (!launch || !launch.cmd) {
    throw new Error(
      'Исполняемый файл ZCode не найден. Сделайте одно из:\n' +
      '  1) задайте переменную окружения ZCODE_BIN, указывающую на AppImage, или\n' +
      '  2) убедитесь, что существует ~/.local/opt/zcode/*.AppImage или ~/.local/share/applications/zcode.desktop.\n' +
      'Либо переключитесь через `use <id> --no-restart` и запустите ZCode вручную.'
    );
  }
  const { spawn } = require('child_process');
  try {
    const child = spawn(launch.cmd, launch.args || [], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    return true;
  } catch (e) {
    throw new Error('Не удалось запустить ZCode: ' + e.message);
  }
}

/** Текст файла либо null, если файла нет */
function readOptionalText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

/**
 * Читает один логин (содержимое файлов логина).
 * config — только у старых версий клиента; у нового (4.x) файла нет, тогда null.
 */
function readSnapshot() {
  return {
    credentials: fs.readFileSync(CREDENTIALS_FILE, 'utf8'),
    config: readOptionalText(CONFIG_FILE),
  };
}

/** Атомарно записывает логин: сначала .tmp, затем rename. Снимок без config файл config.json не трогает */
function writeSnapshot(snap) {
  atomicWrite(CREDENTIALS_FILE, snap.credentials);
  if (snap.config) atomicWrite(CONFIG_FILE, snap.config);
}

function atomicWrite(filePath, content) {
  const tmp = filePath + '.zcas.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  // rename атомарен (в пределах одного диска)
  fs.renameSync(tmp, filePath);
}

/** Копирует текущий логин в .last (для отката в один шаг): ровно те файлы, которые есть сейчас */
function backupCurrentLogin() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const config = readOptionalText(CONFIG_FILE);
    fs.writeFileSync(path.join(BACKUP_DIR, 'credentials.json'), fs.readFileSync(CREDENTIALS_FILE, 'utf8'), 'utf8');
    // Копия из .last предыдущего переключения не должна выдавать себя за текущее состояние
    if (config !== null) fs.writeFileSync(path.join(BACKUP_DIR, 'config.json'), config, 'utf8');
    else try { fs.unlinkSync(path.join(BACKUP_DIR, 'config.json')); } catch (_) {}
  } catch (e) {
    throw new Error('Не удалось сохранить резервную копию логина: ' + e.message);
  }
}

/**
 * Переключается на указанный снимок аккаунта
 * @param {{credentials:string, config?:string|null}} target
 * @param {{restart?:boolean, force?:boolean}} opts
 *   - restart: после переключения автоматически перезапустить ZCode (по умолчанию true)
 *   - force:   даже если ZCode запущен — принудительно завершить (по умолчанию true, иначе переключение ненадёжно)
 */
async function switchTo(target, opts = {}) {
  const { restart = true, force = true } = opts;

  if (!target || !target.credentials) {
    throw new Error('Снимок целевого аккаунта неполон');
  }

  const running = isZCodeRunning();
  if (running && !force) {
    throw new Error('ZCode запущен — сначала закройте его, либо используйте --force');
  }

  // 1. Закрываем ZCode
  if (running) {
    const ok = await killZCode();
    if (!ok) throw new Error('Таймаут закрытия ZCode — переключение отменено (чтобы не повредить логин)');
  }

  // 2. Бэкапим текущий логин в .last (для отката)
  backupCurrentLogin();

  // 3. Атомарная замена
  try {
    writeSnapshot(target);
  } catch (e) {
    // Замена не удалась: пытаемся восстановить из только что созданного .last
    try { restoreLast(); } catch (_) {}
    throw new Error('Не удалось записать логин — выполнен автоматический откат: ' + e.message);
  }

  // 4. Перезапуск
  let launched = false;
  if (restart) {
    try { launchZCode(); launched = true; } catch (e) {
      console.warn('⚠ Не удалось запустить ZCode (логин уже переключён): ' + e.message);
    }
  }

  return { restarted: launched, wasRunning: running };
}

/** Откат к .last (логин до переключения) */
async function rollback(opts = {}) {
  const { restart = true, force = true } = opts;
  if (!fs.existsSync(path.join(BACKUP_DIR, 'credentials.json'))) {
    throw new Error('Нет резервной копии для отката (.last не существует)');
  }
  if (isZCodeRunning() && !force) {
    throw new Error('ZCode запущен — сначала закройте его, либо используйте --force');
  }
  if (isZCodeRunning()) {
    const ok = await killZCode();
    if (!ok) throw new Error('Таймаут закрытия ZCode');
  }
  restoreLast();
  let launched = false;
  if (restart) { try { launchZCode(); launched = true; } catch (_) {} }
  return { restarted: launched };
}

function restoreLast() {
  const c = fs.readFileSync(path.join(BACKUP_DIR, 'credentials.json'), 'utf8');
  const g = readOptionalText(path.join(BACKUP_DIR, 'config.json'));
  atomicWrite(CREDENTIALS_FILE, c);
  if (g !== null) atomicWrite(CONFIG_FILE, g);
}

/** Существует ли резервная копия .last для отката */
function hasLastBackup() {
  return fs.existsSync(path.join(BACKUP_DIR, 'credentials.json'));
}

module.exports = {
  isZCodeRunning,
  killZCode,
  launchZCode,
  readSnapshot,
  writeSnapshot,
  backupCurrentLogin,
  switchTo,
  rollback,
  hasLastBackup,
  collectZCodePids,
  BACKUP_DIR,
};
