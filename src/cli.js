#!/usr/bin/env node
'use strict';
/**
 * ZCode — переключатель аккаунтов, CLI
 *
 * (Консоль Windows по умолчанию использует GBK, а Node выводит UTF-8 —
 *  из-за этого возможны «кракозябры». Здесь при запуске переключаем
 *  stdout/stderr в UTF-8, чтобы текст отображался корректно.) */
try {
  if (process.stdout.isTTY && typeof process.stdout.handle?.setEncoding === 'function') {
    process.stdout.handle.setEncoding('utf8');
  }
} catch (_) {}
// Принудительно декодируем запись как UTF-8
try { process.stdout.setDefaultEncoding('utf8'); } catch (_) {}
try { process.stderr.setDefaultEncoding('utf8'); } catch (_) {}

/**
 * ZCode — переключатель аккаунтов, CLI
 *
 * Использование:
 *   node src/cli.js status                          текущий аккаунт + список сохранённых
 *   node src/cli.js capture [--name имя] [--note заметка]   сохранить текущий логин как снимок
 *   node src/cli.js list                            список всех сохранённых аккаунтов
 *   node src/cli.js use <id|номер> [--no-restart] [--force]   переключиться на аккаунт (по умолчанию перезапускает ZCode)
 *   node src/cli.js delete <id|номер>               удалить снимок аккаунта
 *   node src/cli.js rename <id|номер> <новое имя>   переименовать аккаунт
 *   node src/cli.js rollback                        откат к логину до переключения
 *
 * Примечание: <id|номер> — это либо короткий id аккаунта (например a86931xx),
 *             либо порядковый номер из вывода list (1,2,3...).
 */
const manager = require('./manager');
const switcher = require('./switcher');
const quota = require('./quota');
const { findZCodeExe, CREDENTIALS_FILE, CONFIG_FILE } = require('./paths');

function parseArgs(argv) {
  const out = { _: [], flags: {}, kv: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out.flags[key] = true;
      } else {
        out.kv[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function fmtDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Принимает как порядковый номер, так и id */
function resolveId(input) {
  if (!input) throw new Error('Укажите id или порядковый номер аккаунта');
  const list = manager.list();
  if (list.length === 0) throw new Error('Нет сохранённых аккаунтов');
  // Чистое число → порядковый номер
  if (/^\d+$/.test(input)) {
    const idx = parseInt(input, 10);
    if (idx < 1 || idx > list.length) throw new Error(`Номер вне диапазона (1~${list.length})`);
    return list[idx - 1].id;
  }
  // Иначе трактуем как id (поддерживается совпадение по префиксу)
  const exact = list.find((x) => x.id === input);
  if (exact) return exact.id;
  const pref = list.filter((x) => x.id.startsWith(input));
  if (pref.length === 1) return pref[0].id;
  if (pref.length > 1) throw new Error('Префикс id совпал с несколькими аккаунтами — укажите более полный id');
  throw new Error('Аккаунт не найден: ' + input);
}

function printTable(list) {
  if (list.length === 0) {
    console.log('  (нет сохранённых аккаунтов — добавьте через `capture`)');
    return;
  }
  console.log('');
  console.log('  Номер  id          Название             provider                 Сохранён            Размер');
  console.log('  -----  ----------  -------------------  -----------------------  ------------------  -----');
  list.forEach((a, i) => {
    const no = String(i + 1).padStart(5);
    const id = (a.id || '').padEnd(10).slice(0, 10);
    const label = (a.label || '').padEnd(19).slice(0, 19);
    const prov = (a.provider || '').padEnd(23).slice(0, 23);
    const dt = fmtDate(a.capturedAt).padEnd(18);
    const sz = (a.sizeKb || 0) + 'КБ';
    console.log(`  ${no}  ${id}  ${label}  ${prov}  ${dt}  ${sz}`);
  });
  console.log('');
}

function fmtQuota(value) {
  if (value == null) return 'н/д';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
}

function printQuota(q) {
  console.log('=== Квота ZCode ===');
  console.log('Всего:   ' + fmtQuota(q.total));
  console.log('Исп.:    ' + fmtQuota(q.used));
  console.log('Ост.:    ' + fmtQuota(q.remaining));
  console.log('Прогр.:  ' + (q.percentUsed == null ? 'н/д' : q.percentUsed.toFixed(1) + '%'));
  if (q.refreshedAt) console.log('Обнов.:  ' + fmtDate(q.refreshedAt));
  if (q.items && q.items.length) {
    console.log('');
    console.log('▶ Квота по моделям:');
    q.items.forEach((item) => {
      console.log(`  - ${item.name}: ост. ${fmtQuota(item.remaining)} / всего ${fmtQuota(item.total)} (${item.unit || 'quota'})`);
    });
  }
}

const cmd = (process.argv[2] || 'status').toLowerCase();
const args = parseArgs(process.argv.slice(3));

async function main() {
  switch (cmd) {
    case 'status': {
      const cur = manager.current();
      console.log('=== Переключатель аккаунтов ZCode ===');
      console.log('Клиент ZCode:  ' + (findZCodeExe() || 'не найден'));
      console.log('Статус:        ' + (switcher.isZCodeRunning() ? '✅ запущен' : '⛔ не запущен'));
      console.log('Каталог логина: ' + require('path').dirname(CREDENTIALS_FILE));
      if (cur) {
        console.log('');
        console.log('▶ Текущий аккаунт:');
        console.log('  Отпечаток ID: ' + cur.shortId + (cur.userId ? '  (user_id=' + cur.userId + ')' : ''));
        console.log('  Источник:     ' + cur.source);
        console.log('  Provider:     ' + cur.provider);
      } else {
        console.log('\n⚠ Не удалось определить текущий аккаунт (возможно, вход не выполнен, либо логин зашифрован и нечитаем)');
      }
      console.log('');
      console.log('▶ Сохранённые снимки аккаунтов:');
      printTable(manager.list());
      return;
    }

    case 'list': {
      printTable(manager.list());
      return;
    }

    case 'quota': {
      const q = await quota.getQuotaOverview();
      printQuota(q);
      return;
    }

    case 'capture': {
      const r = manager.capture({
        label: args.kv.name,
        note: args.kv.note || '',
        overwrite: !!args.flags.overwrite,
      });
      if (r.created) {
        console.log('✅ Аккаунт сохранён: ' + r.meta.label + '  (id=' + r.meta.id + ')');
      } else if (r.skipped) {
        console.log('ℹ ' + r.message + '. Чтобы перезаписать, добавьте --overwrite.');
      }
      return;
    }

    case 'use': {
      const id = resolveId(args._[0]);
      const meta = JSON.parse(require('fs').readFileSync(manager.metaPath(id), 'utf8'));
      console.log('🔄 Переключение на аккаунт: ' + meta.label + '  (id=' + id + ')');
      const opts = {
        restart: !args.flags['no-restart'],
        force: args.flags.force !== false, // по умолчанию force
      };
      const r = await manager.use(id, opts);
      console.log('✅ Логин переключён.');
      if (r.restarted) console.log('🚀 ZCode автоматически перезапущен, новый логин сразу активен.');
      else console.log('ℹ ZCode не был перезапущен (--no-restart, либо запуск не удался). Запустите вручную.');
      return;
    }

    case 'delete':
    case 'remove': {
      const id = resolveId(args._[0]);
      const ok = manager.remove(id);
      console.log(ok ? '🗑 Аккаунт удалён: ' + id : '⚠ Аккаунт не найден: ' + id);
      return;
    }

    case 'rename': {
      const id = resolveId(args._[0]);
      const newName = args._[1];
      if (!newName) throw new Error('Укажите новое имя');
      const m = manager.rename(id, newName);
      console.log('✏ Переименовано: ' + m.label);
      return;
    }

    case 'rollback': {
      const r = await switcher.rollback({
        restart: !args.flags['no-restart'],
        force: args.flags.force !== false,
      });
      console.log('↩ Откат к логину до переключения выполнен.');
      if (r.restarted) console.log('🚀 ZCode перезапущен.');
      return;
    }

    case 'kill': {
      const running = switcher.isZCodeRunning();
      if (!running) { console.log('ZCode не запущен.'); return; }
      console.log('Закрытие ZCode...');
      const ok = await switcher.killZCode();
      console.log(ok ? '✅ Закрыто.' : '⚠ Таймаут закрытия.');
      return;
    }

    case 'launch': {
      try { switcher.launchZCode(); console.log('🚀 ZCode запущен.'); }
      catch (e) { console.error('❌ ' + e.message); process.exit(1); }
      return;
    }

    default:
      console.log('Переключатель аккаунтов ZCode\n');
      console.log('Использование:');
      console.log('  status                          текущий аккаунт + список сохранённых');
      console.log('  capture [--name имя]            сохранить текущий логин как снимок');
      console.log('  list                            список всех аккаунтов');
      console.log('  quota                           квота текущего аккаунта');
      console.log('  use <id|номер> [--no-restart]   переключить аккаунт (по умолчанию ZCode перезапускается)');
      console.log('  delete <id|номер>               удалить аккаунт');
      console.log('  rename <id|номер> <новое имя>   переименовать');
      console.log('  rollback                        откат к логину до переключения');
      console.log('  kill / launch                   закрыть / запустить ZCode вручную');
      console.log('');
      console.log('Важно: не запускайте `use`, `kill` и `rollback` из встроенного терминала');
      console.log('       ZCode — они могут закрыть текущую сессию.');
  }
}

main().catch((e) => {
  console.error('❌ ' + e.message);
  process.exit(1);
});
