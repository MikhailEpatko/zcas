'use strict';
/**
 * Константы путей (кроссплатформенно: Windows + Linux + macOS)
 *
 * Файлы логина клиента ZCode (одинаковое расположение на всех платформах):
 *   ~/.zcode/v2/credentials.json   -> OAuth-токены и профиль пользователя, значения зашифрованы (enc:v1 / enc:v2)
 *   ~/.zcode/v2/config.json        -> apiKey JWT для каждого provider (открытый текст, содержит user_id);
 *                                      есть только у старых версий клиента (в 4.x файл не создаётся)
 *
 * Исполняемый файл клиента ZCode:
 *   Windows: C:\Program Files\ZCode\ZCode.exe (и несколько кандидатов)
 *   Linux:   AppImage (~/.local/opt/zcode/ZCode-*-linux-x64.AppImage),
 *            определяется через переменную ZCODE_BIN / .desktop Exec / zcode в PATH
 *   macOS:   ZCode.app в /Applications или ~/Applications, либо ZCODE_BIN
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

// Каталог данных ZCode (на Linux и Windows одинаков: ~/.zcode/v2)
const ZCODE_V2_DIR = path.join(HOME, '.zcode', 'v2');

// Файлы логина (полный снимок аккаунта; config.json — только у старых версий клиента)
const CREDENTIALS_FILE = path.join(ZCODE_V2_DIR, 'credentials.json');
const CONFIG_FILE = path.join(ZCODE_V2_DIR, 'config.json');

// ---- Windows: каталоги установки клиента ZCode (по приоритету; первый существующий будет выбран) ----
// Измерено на текущей машине: C:\Program Files\ZCode\ZCode.exe
const PROGRAM_FILES = process.env.ProgramFiles || 'C:\\Program Files';
const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ZCODE_EXE_CANDIDATES_WIN = [
  path.join(PROGRAM_FILES, 'ZCode', 'ZCode.exe'),
  path.join(PROGRAM_FILES_X86, 'ZCode', 'ZCode.exe'),
  path.join(LOCAL_APPDATA, 'Programs', 'ZCode', 'ZCode.exe'),
  path.join(APPDATA, '..', 'Local', 'Programs', 'ZCode', 'ZCode.exe'),
  'D:\\Program Files\\ZCode\\ZCode.exe',
];
// Старое имя сохранено для совместимости внешних ссылок
const ZCODE_EXE_CANDIDATES = ZCODE_EXE_CANDIDATES_WIN;

// ---- macOS: исполняемый файл внутри ZCode.app ----
const ZCODE_EXE_CANDIDATES_MAC = [
  '/Applications/ZCode.app/Contents/MacOS/ZCode',
  path.join(HOME, 'Applications', 'ZCode.app', 'Contents', 'MacOS', 'ZCode'),
];

// ---- Linux: каталоги-кандидаты исполняемого файла клиента ZCode ----
// AppImage обычно ставится в ~/.local/opt/zcode/; также сканируем ~/Applications, ~/.local/bin и т.п.
const LINUX_APPIMAGE_DIRS = [
  path.join(HOME, '.local', 'opt', 'zcode'),
  path.join(HOME, 'Applications'),
  path.join(HOME, '.local', 'bin'),
];

// Каталог хранения снимков аккаунтов (в каталоге этого инструмента, чтобы не засорять v2)
const STORE_DIR = path.join(__dirname, '..', 'accounts');

/**
 * Убирает поля-плейсхолдеры из строки Exec .desktop-файла: %U %u %F %f %i %c %k %d %D %n %N %v %m и т.д.
 * Также обрабатывает плейсхолдеры в кавычках, например "%U". Оставляет только настоящую команду и аргументы.
 * @param {string} execLine
 * @returns {string}
 */
function stripDesktopPlaceholders(execLine) {
  if (!execLine) return '';
  // Сначала режем на поля и проверяем каждое: «чистый плейсхолдер» отбрасываем, остальное оставляем
  // Простой токенизатор: учитывает двойные кавычки
  const tokens = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < execLine.length; i++) {
    const ch = execLine[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (/\s/.test(ch) && !inQ) {
      if (cur) tokens.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  const filtered = tokens.filter((t) => !/^%[a-zA-Z]+$/.test(t));
  return filtered.join(' ');
}

/**
 * Разбирает строку Exec из .desktop-файла, возвращает { cmd, args, raw }.
 * @param {string} desktopPath
 * @returns {{cmd:string, args:string[], raw:string}|null}
 */
function parseDesktopExec(desktopPath) {
  try {
    const text = fs.readFileSync(desktopPath, 'utf8');
    const lines = text.split(/\r?\n/);
    let execRaw = '';
    let inDesktop = true;
    for (const line of lines) {
      const m = line.match(/^\s*Exec\s*=\s*(.*)$/);
      if (m) { execRaw = m[1].trim(); break; }
      // Останавливаемся после перехода в другую секцию (Exec действует только в [Desktop Entry])
      if (/^\[/.test(line) && line.trim() !== '[Desktop Entry]') inDesktop = false;
    }
    if (!execRaw) return null;
    const cleaned = stripDesktopPlaceholders(execRaw);
    if (!cleaned) return null;
    // Повторно режем по кавычкам/пробелам — получаем cmd + args
    const parts = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (/\s/.test(ch) && !inQ) { if (cur) parts.push(cur); cur = ''; }
      else cur += ch;
    }
    if (cur) parts.push(cur);
    if (!parts.length) return null;
    return { cmd: parts[0], args: parts.slice(1), raw: execRaw };
  } catch (_) {
    return null;
  }
}

/**
 * Ищет новейший ZCode AppImage в указанном каталоге (сортировка по версии в имени файла, берётся наибольший).
 * @param {string} dir
 * @returns {string|null}
 */
function findAppImageInDir(dir) {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
    const files = fs.readdirSync(dir).filter((f) => /ZCode.*linux.*x64\.AppImage$/i.test(f));
    if (!files.length) return null;
    files.sort(); // лексикографически: 3.1.1 > 3.1.0
    return path.join(dir, files[files.length - 1]);
  } catch (_) {
    return null;
  }
}

/**
 * Linux: ищет исполняемый файл/AppImage ZCode в стандартных расположениях.
 * Приоритет:
 *   1) process.env.ZCODE_BIN (явно указан пользователем)
 *   2) Exec= из ~/.local/share/applications/*.desktop
 *   3) новейший AppImage в каталогах ~/.local/opt/zcode и др.
 *   4) zcode / ZCode в PATH (внимание: может быть временной точкой монтирования AppImage — как последний запасной вариант)
 * @returns {{cmd:string, args:string[], via:string}|null}
 */
function findZCodeLinux() {
  // 1) Переменная окружения
  if (process.env.ZCODE_BIN && fs.existsSync(process.env.ZCODE_BIN)) {
    return { cmd: process.env.ZCODE_BIN, args: [], via: 'ZCODE_BIN' };
  }

  // 2) .desktop-файлы (несколько расположений, по приоритету)
  const desktopDirs = [
    path.join(HOME, '.local', 'share', 'applications'),
    '/usr/share/applications',
    '/usr/local/share/applications',
  ];
  for (const d of desktopDirs) {
    try {
      if (!fs.existsSync(d)) continue;
      const entries = fs.readdirSync(d).filter((f) => /\.desktop$/i.test(f) && /zcode/i.test(f));
      for (const f of entries) {
        const parsed = parseDesktopExec(path.join(d, f));
        if (parsed && parsed.cmd && fs.existsSync(parsed.cmd)) {
          return { cmd: parsed.cmd, args: parsed.args, via: `desktop:${f}` };
        }
      }
    } catch (_) {}
  }

  // 3) Каталоги с AppImage
  for (const d of LINUX_APPIMAGE_DIRS) {
    const ai = findAppImageInDir(d);
    if (ai) return { cmd: ai, args: [], via: `appimage:${d}` };
  }

  // 4) Запасной вариант через PATH (which/where)
  try {
    const cmd = IS_WIN ? 'where ZCode 2>nul & where zcode 2>nul' : 'command -v ZCode; command -v zcode';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    // Пропускаем временные точки монтирования AppImage (/tmp/.mount_*) — они нестабильны
    if (line && !/\/tmp\/\.mount_/.test(line) && fs.existsSync(line)) {
      return { cmd: line, args: [], via: 'PATH' };
    }
  } catch (_) {}

  return null;
}

/**
 * macOS: ищет исполняемый файл клиента внутри ZCode.app.
 * Приоритет:
 *   1) process.env.ZCODE_BIN (явно указан пользователем)
 *   2) стандартные расположения .app
 * В PATH не смотрим: там может стоять npm-CLI `zcode`, это не клиент.
 * @returns {{cmd:string, args:string[], via:string}|null}
 */
function findZCodeMac() {
  if (process.env.ZCODE_BIN && fs.existsSync(process.env.ZCODE_BIN)) {
    return { cmd: process.env.ZCODE_BIN, args: [], via: 'ZCODE_BIN' };
  }
  for (const p of ZCODE_EXE_CANDIDATES_MAC) {
    try {
      if (fs.existsSync(p)) return { cmd: p, args: [], via: 'app' };
    } catch (_) {}
  }
  return null;
}

/**
 * Находит фактический путь к клиенту ZCode (кроссплатформенно).
 * Windows: строка-путь к exe; Linux: путь к AppImage/исполняемому файлу;
 * macOS: путь к исполняемому файлу внутри ZCode.app.
 * Для полной команды (с аргументами) используйте findZCodeLaunch().
 */
function findZCodeExe() {
  if (IS_WIN) {
    for (const p of ZCODE_EXE_CANDIDATES_WIN) {
      try {
        if (fs.existsSync(p)) return p;
      } catch (_) {}
    }
    return null;
  }
  const found = IS_MAC ? findZCodeMac() : findZCodeLinux();
  return found ? found.cmd : null;
}

/**
 * Возвращает полную информацию о команде запуска ZCode (с аргументами).
 * Windows: { cmd: '<exe>', args: [], via: 'win' }
 * Linux:   { cmd, args, via } или null
 * macOS:   { cmd: '<exe внутри .app>', args: [], via } или null
 * Используется для launch / отображения статуса. Если нет — возвращает null.
 */
function findZCodeLaunch() {
  if (IS_WIN) {
    const exe = findZCodeExe();
    return exe ? { cmd: exe, args: [], via: 'win' } : null;
  }
  return IS_MAC ? findZCodeMac() : findZCodeLinux();
}

module.exports = {
  HOME,
  APPDATA,
  ZCODE_V2_DIR,
  CREDENTIALS_FILE,
  CONFIG_FILE,
  ZCODE_EXE_CANDIDATES,
  ZCODE_EXE_CANDIDATES_MAC,
  LINUX_APPIMAGE_DIRS,
  STORE_DIR,
  findZCodeExe,
  findZCodeLaunch,
  // экспортировано для тестов/отладки
  stripDesktopPlaceholders,
  parseDesktopExec,
};
