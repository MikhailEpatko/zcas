'use strict';
/**
 * Тесты запроса квоты ZCode (src/quota.js)
 *
 * Запуск: node --test test/quota.test.js
 *
 * Сеть подменена моделью интерфейса квоты. Контракт модели снят с zcode.z.ai по клиенту 4.0.0:
 * billing/balance без заголовка X-Device-Mid с UUID отвечает 400 «parameter error» (code 3001).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const quota = require('../src/quota');

const CURRENT_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/current';
const BALANCE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ответы billing/* в том же составе полей, что клиент пишет в лог (usage-stats: billing/balance)
const PLAN = {
  user_plan_id: 'upl_2124910851297812480',
  plan_id: 'zcode-v3-start-plan-0817',
  name: 'ZCode Start Plan',
  status: 'active',
  starts_at: 1795453200,
  ends_at: 1795881599,
  entitlements: [
    { entitlement_id: 'ent-zcode-v3-start-plan-0817-1', show_name: 'GLM-5.4', meter: 'model_usage', unit_type: 'token', grant_units: 3000000, period: 'daily' },
    { entitlement_id: 'ent_2_0817_glm_5p3f', show_name: 'GLM-5.3-Flash', meter: 'model_usage', unit_type: 'token', grant_units: 5000000, period: 'daily' },
  ],
};

const CURRENT = { code: 0, msg: '', data: { server_time: 1795538932, plans: [PLAN] } };

const BALANCE = {
  code: 0,
  msg: '',
  data: {
    server_time: 1795538932,
    plans: [PLAN],
    balances: [
      { bucket_id: 'bucket_1', user_plan_id: 'upl_2124910851297812480', plan_id: 'zcode-v3-start-plan-0817', entitlement_id: 'ent-zcode-v3-start-plan-0817-1', show_name: 'GLM-5.4', meter: 'model_usage', unit_type: 'token', total_units: 3000000, used_units: 700000, remaining_units: 2300000 },
      { bucket_id: 'bucket_2', user_plan_id: 'upl_2124910851297812480', plan_id: 'zcode-v3-start-plan-0817', entitlement_id: 'ent_2_0817_glm_5p3f', show_name: 'GLM-5.3-Flash', meter: 'model_usage', unit_type: 'token', total_units: 5000000, used_units: 1000000, remaining_units: 4000000 },
    ],
  },
};

function ok(body) {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
}

function fail(status, body) {
  return { ok: false, status, statusText: '', text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

/** Модель zcode.z.ai: тариф доступен любому авторизованному токену, баланс — только с идентификатором устройства */
function billingServer(request) {
  if (!request.authorization) return fail(401, '');
  if (request.url === CURRENT_URL) return ok(CURRENT);
  if (!UUID_PATTERN.test(request.headers['x-device-mid'] || '')) return fail(400, { code: 3001, msg: 'parameter error' });
  return ok(BALANCE);
}

/**
 * Подменяет global.fetch моделью интерфейса квоты до конца теста.
 * @returns {Array<{url:string, authorization:string, headers:object}>} выполненные запросы (имена заголовков в нижнем регистре)
 */
function stubBilling(t, respond = billingServer) {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, init) => {
    const headers = Object.fromEntries(Object.entries(init.headers).map(([name, value]) => [name.toLowerCase(), value]));
    const request = { url: String(url), authorization: headers.authorization, headers };
    requests.push(request);
    return respond(request);
  };
  t.after(() => { global.fetch = originalFetch; });
  return requests;
}

/** Пишет файл во временный каталог и удаляет каталог после теста */
function tempFile(t, name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcas-quota-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const filePath = path.join(dir, name);
  if (content !== undefined) fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

test('запрос квоты передаёт идентификатор устройства клиента и возвращает сводку тарифа и баланса', async (t) => {
  const requests = stubBilling(t);

  const result = await quota.queryQuotaByToken('jwt-клиента');

  assert.equal(result.total, 8000000);
  assert.equal(result.used, 1700000);
  assert.equal(result.remaining, 6300000);
  assert.ok(Math.abs(result.percentUsed - 21.25) < 1e-9);
  assert.deepEqual(result.planTier, { label: 'Start Plan', tier: 'start' });
  assert.deepEqual(result.items.map((item) => [item.name, item.remaining, item.total]), [
    ['GLM-5.4', 2300000, 3000000],
    ['GLM-5.3-Flash', 4000000, 5000000],
  ]);
  assert.deepEqual(requests.map((request) => request.url), [CURRENT_URL, BALANCE_URL]);
  for (const request of requests) {
    assert.match(request.headers['x-device-mid'] || '', UUID_PATTERN, request.url + ': ожидается заголовок X-Device-Mid с UUID');
  }
});

test('идентификатор устройства берётся из файла телеметрии клиента', async (t) => {
  const stateFile = tempFile(t, 'telemetry-state.json', JSON.stringify({ deviceMid: '6f1c3d2a-0b7e-4f5a-9c1d-2e3b4a5c6d7e', lastDailyActiveDate: '2026-11-24' }));

  assert.equal(quota.readDeviceMid(stateFile), '6f1c3d2a-0b7e-4f5a-9c1d-2e3b4a5c6d7e');
});

test('без пригодного идентификатора в файле телеметрии генерируется свой UUID', async (t) => {
  const cases = [
    ['файла нет', tempFile(t, 'missing.json')],
    ['файл не JSON', tempFile(t, 'broken.json', 'not json')],
    ['значение не UUID', tempFile(t, 'not-uuid.json', JSON.stringify({ deviceMid: 'not-a-uuid' }))],
    ['значения нет', tempFile(t, 'empty.json', JSON.stringify({}))],
  ];

  for (const [caseName, stateFile] of cases) {
    assert.match(quota.readDeviceMid(stateFile), UUID_PATTERN, caseName);
  }
});

test('ошибка баланса, не связанная с авторизацией, возвращается сразу и не подменяется ошибкой запасного токена', async (t) => {
  const requests = stubBilling(t, (request) => {
    // токен авторизован, но баланс сервер не отдаёт; запасной OAuth-токен интерфейс квоты не признаёт
    if (request.authorization === 'Bearer oauth-токен') return fail(401, '');
    if (request.url === BALANCE_URL) return fail(400, { code: 3001, msg: 'parameter error' });
    return ok(CURRENT);
  });

  await assert.rejects(quota.queryQuotaByTokens(['jwt-клиента', 'oauth-токен']), /HTTP 400 от интерфейса квоты: parameter error/);

  assert.deepEqual(requests.map((request) => request.authorization), ['Bearer jwt-клиента', 'Bearer jwt-клиента']);
});

test('токен, отклонённый авторизацией, заменяется следующим кандидатом', async (t) => {
  const requests = stubBilling(t, (request) => {
    if (request.authorization === 'Bearer устаревший-jwt') return fail(403, '');
    return billingServer(request);
  });

  const result = await quota.queryQuotaByTokens(['устаревший-jwt', 'jwt-клиента']);

  assert.equal(result.total, 8000000);
  assert.deepEqual(requests.map((request) => request.authorization), ['Bearer устаревший-jwt', 'Bearer jwt-клиента', 'Bearer jwt-клиента']);
});

test('если все токены отклонены авторизацией, возвращается ошибка последнего кандидата', async (t) => {
  const requests = stubBilling(t, () => fail(401, ''));

  await assert.rejects(quota.queryQuotaByTokens(['первый-токен', 'второй-токен']), /HTTP 401 от интерфейса квоты/);

  assert.equal(requests.length, 2);
});
