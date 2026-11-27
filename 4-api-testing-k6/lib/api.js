// Обгортки над ендпоінтами API з перевірками (checks) і кастомними метриками
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { CONFIG } from '../config.js';
import { toQueryString } from './data.js';

// Error Rate за SLA: лише аварійні збої — HTTP 5xx, таймаути, розриви з'єднань (status 0)
export const serverErrors = new Rate('server_errors');
// Спрацювання Rate Limiter (HTTP 429) — очікувано у Spike Test
export const rateLimited = new Rate('rate_limited');
export const rateLimitedCount = new Counter('rate_limited_count');
// Конфлікти оптимістичного блокування (HTTP 409) — нормальна поведінка
export const versionConflicts = new Counter('version_conflicts');
// Інші неочікувані 4xx (невалідний payload, неіснуючий user_id/deal)
export const clientErrors = new Counter('client_errors_4xx');
export const dealsCreated = new Counter('deals_created');
export const dealsUpdated = new Counter('deals_updated');

// 409 та 429 — очікувані бізнес-відповіді, не рахуємо їх у http_req_failed
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409, 429));

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

function params(name, op) {
  return {
    headers: JSON_HEADERS,
    timeout: CONFIG.REQUEST_TIMEOUT,
    tags: { name, op, kind: 'api' },
  };
}

function track(res) {
  const isServerError = res.status === 0 || res.status >= 500;
  serverErrors.add(isServerError);
  rateLimited.add(res.status === 429);
  if (res.status === 429) rateLimitedCount.add(1);
  if (res.status === 409) versionConflicts.add(1);
  if (res.status >= 400 && res.status < 500 && res.status !== 409 && res.status !== 429) {
    clientErrors.add(1);
  }
}

function safeJson(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

export function healthCheck() {
  const res = http.get(`${CONFIG.BASE_URL}/api/health`, {
    timeout: '10s',
    tags: { name: 'GET /api/health', op: 'health', kind: 'service' },
  });
  return { res, body: safeJson(res) };
}

// POST /api/deals
export function createDeal(payload) {
  const res = http.post(`${CONFIG.BASE_URL}/api/deals`, JSON.stringify(payload), params('POST /api/deals', 'create'));
  track(res);
  const body = safeJson(res);
  check(res, {
    'create: status 201 або 429': (r) => r.status === 201 || r.status === 429,
    'create: success=true та dealId': () =>
      res.status !== 201 || (body !== null && body.success === true && Number.isInteger(body.dealId)),
    'create: status=new, version=1': () =>
      res.status !== 201 || (body !== null && body.status === 'new' && body.version === 1),
    'create: itemsCount збігається': () =>
      res.status !== 201 || (body !== null && body.itemsCount === payload.items.length),
  });
  if (res.status === 201) dealsCreated.add(1);
  return { res, body };
}

// PATCH /api/deals/{id}/status
export function updateDealStatus(dealId, payload, expectConflict) {
  const res = http.patch(
    `${CONFIG.BASE_URL}/api/deals/${dealId}/status`,
    JSON.stringify(payload),
    params('PATCH /api/deals/{id}/status', 'update_status'),
  );
  track(res);
  const body = safeJson(res);
  const allowed = expectConflict ? [200, 404, 409, 429] : [200, 409, 429];
  check(res, {
    'update: очікуваний статус (200/409/429)': (r) => allowed.indexOf(r.status) !== -1,
    'update: 200 → статус і версія оновлені': () =>
      res.status !== 200 ||
      (body !== null && body.success === true && body.status === payload.status && body.version > payload.version),
    'update: 409 → повертає currentVersion': () =>
      res.status !== 409 || (body !== null && Number.isInteger(body.currentVersion)),
  });
  if (res.status === 200) dealsUpdated.add(1);
  return { res, body };
}

// GET /api/deals
export function listDeals(query, op) {
  const res = http.get(`${CONFIG.BASE_URL}/api/deals?${toQueryString(query)}`, params('GET /api/deals', op));
  track(res);
  const body = safeJson(res);
  check(res, {
    [`${op}: status 200 або 429`]: (r) => r.status === 200 || r.status === 429,
    [`${op}: deals — масив, limit дотримано`]: () =>
      res.status !== 200 || (body !== null && Array.isArray(body.deals) && body.deals.length <= query.limit),
  });
  return { res, body };
}
