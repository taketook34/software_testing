// Навантажувальне тестування CRM API (k6).
// Тип тесту обирається змінною TEST_TYPE: smoke | baseline | load | stress | spike
//   k6 run -e TEST_TYPE=load main.js
import { sleep, fail } from 'k6';
import { CONFIG, WORKLOAD_MIX, buildOptions } from './config.js';
import {
  buildCreateDealPayload,
  buildStatusPayload,
  buildMonitoringQuery,
  buildSearchQuery,
  nextStatus,
  weightedPick,
  randInt,
  pick,
} from './lib/data.js';
import { healthCheck, createDeal, updateDealStatus, listDeals } from './lib/api.js';

export const options = buildOptions();

// Угоди, створені поточним VU (кожен VU має власну копію модуля).
// PATCH проводить їх по ланцюжку статусів з актуальною версією.
const MAX_POOL = 200;
const myDeals = [];

function rememberDeal(deal) {
  myDeals.push(deal);
  if (myDeals.length > MAX_POOL) myDeals.shift();
}

function forgetDeal(deal) {
  const i = myDeals.indexOf(deal);
  if (i !== -1) myDeals.splice(i, 1);
}

export function setup() {
  const { res, body } = healthCheck();
  if (res.status !== 200) {
    fail(`API недоступне: GET ${CONFIG.BASE_URL}/api/health → ${res.status}`);
  }
  console.log(
    `TEST_TYPE=${CONFIG.TEST_TYPE}, BASE_URL=${CONFIG.BASE_URL}, health=${JSON.stringify(body)}`,
  );
  return { startedAt: new Date().toISOString() };
}

function doCreate() {
  const { res, body } = createDeal(buildCreateDealPayload());
  if (res.status === 201 && body && body.dealId) {
    rememberDeal({ id: body.dealId, version: body.version || 1, status: body.status || 'new' });
  }
}

// PATCH по "чужій" історичній угоді з припущенням version=1 —
// імітує конкурентний доступ касирів; очікувано 409 Conflict (або 200/404).
function doConflictProbe() {
  const id = randInt(CONFIG.DEAL_ID_MIN, CONFIG.DEAL_ID_MAX);
  const status = pick(['partially_fulfilled', 'fulfilled']);
  updateDealStatus(id, buildStatusPayload(status, 1), true);
}

function doUpdateStatus() {
  if (Math.random() < CONFIG.CONFLICT_PROBE_RATIO) {
    doConflictProbe();
    return;
  }
  if (myDeals.length === 0) {
    // На старті у VU ще немає власних угод — створюємо одну, щоб було що оновлювати
    doCreate();
    return;
  }

  const deal = pick(myDeals);
  const status = nextStatus(deal.status);
  if (!status) {
    forgetDeal(deal);
    return;
  }

  const { res, body } = updateDealStatus(deal.id, buildStatusPayload(status, deal.version), false);
  if (res.status === 200 && body) {
    deal.version = body.version;
    deal.status = body.status || status;
    if (deal.status === 'closed') forgetDeal(deal);
  } else if (res.status === 409 && body) {
    // Оптимістичне блокування: синхронізуємо локальний стан з актуальним
    if (Number.isInteger(body.currentVersion)) deal.version = body.currentVersion;
    if (body.currentStatus) deal.status = body.currentStatus;
  } else if (res.status === 404) {
    forgetDeal(deal);
  }
}

export default function () {
  const { op } = weightedPick(WORKLOAD_MIX);
  switch (op) {
    case 'create':
      doCreate();
      break;
    case 'update_status':
      doUpdateStatus();
      break;
    case 'list_monitoring':
      listDeals(buildMonitoringQuery(), 'list_monitoring');
      break;
    case 'list_search':
      listDeals(buildSearchQuery(), 'list_search');
      break;
    default:
      break;
  }
  // Невеликий think time між діями оператора/касира
  if (CONFIG.THINK_TIME_MAX > 0) {
    sleep(CONFIG.THINK_TIME_MIN + Math.random() * (CONFIG.THINK_TIME_MAX - CONFIG.THINK_TIME_MIN));
  }
}

export function teardown(data) {
  const { body } = healthCheck();
  console.log(
    `Тест ${CONFIG.TEST_TYPE} (старт ${data.startedAt}) завершено. ` +
      `Health після тесту (стан пулу, recovery): ${JSON.stringify(body)}`,
  );
}
