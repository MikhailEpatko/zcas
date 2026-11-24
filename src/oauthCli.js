'use strict';
/**
 * Процесс входа через ZCode CLI OAuth (портирован из zcode2api, класс ZaiAuthFlow).
 *
 * В отличие от Web OAuth (chat.z.ai/api/oauth/authorize), CLI OAuth обращается
 * к интерфейсу zcode.z.ai, специально разработанному для сторонних CLI-инструментов:
 * возвращаемый JWT уже содержит права на запрос биллинга, так что для проверки
 * квоты не нужно «активировать» вход в клиенте ZCode.
 *
 * Поток:
 *   1. init()  → POST /oauth/cli/init  → получаем { flow_id, authorize_url }
 *   2. пользователь открывает authorize_url в системном браузере и входит
 *   3. poll(flow_id) → опрашиваем, пока status=ready, получаем { token, zai.access_token, zai.refresh_token, user }
 *
 * Структура данных из poll полностью совпадает с oauthBrowser.exchangeToken(),
 * поэтому oauth.finishLogin() для записи на диск используется как есть.
 *
 * poll_token: запросы init и poll оба передают Authorization: Bearer <poll_token>,
 * он идентифицирует один и тот же процесс входа (как в референсном проекте).
 */
const crypto = require('crypto');

const API_BASE = 'https://zcode.z.ai/api/v1';

class ZaiAuthFlow {
  constructor(apiBase) {
    this.apiBase = apiBase || API_BASE;
    // poll_token: идентифицирует один процесс входа; нужен и в init, и в poll
    this.pollToken = crypto.randomBytes(32).toString('hex');
  }

  /**
   * Запускает процесс OAuth.
   * @returns {Promise<{flowId:string, authorizeUrl:string}>}
   */
  async init() {
    const res = await fetch(this.apiBase + '/oauth/cli/init', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + this.pollToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: 'zai' }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('OAuth init HTTP ' + res.status + ': ' + (t || '').slice(0, 200));
    }
    const json = await res.json();
    const data = (json && json.data) || {};
    const flowId = data.flow_id;
    const authorizeUrl = data.authorize_url;
    if (!flowId || !authorizeUrl) {
      throw new Error('Полученные данные процесса OAuth неполны');
    }
    return { flowId: flowId, authorizeUrl: authorizeUrl };
  }

  /**
   * Опрашивает состояние входа.
   * @param {string} flowId
   * @returns {Promise<{status:string, token?:string, zai?:object, user?:object}>}
   *   status: 'pending' | 'ready' | 'failed'
   *   при ready прилагаются token / zai.access_token / zai.refresh_token / user
   */
  async poll(flowId) {
    const res = await fetch(this.apiBase + '/oauth/cli/poll/' + flowId, {
      headers: { Authorization: 'Bearer ' + this.pollToken },
    });
    if (!res.ok) {
      throw new Error('OAuth poll HTTP ' + res.status);
    }
    const json = await res.json();
    return (json && json.data) || {};
  }
}

module.exports = { ZaiAuthFlow, API_BASE };
