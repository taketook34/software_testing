// Генерація тестових даних і payload-ів відповідно до API_PAYLOADS.md
import { CONFIG } from '../config.js';

export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function weightedPick(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r < 0) return item;
  }
  return items[items.length - 1];
}

function round(value, digits) {
  const k = Math.pow(10, digits);
  return Math.round(value * k) / k;
}

// Точність сум: DECIMAL(18,4) у БД; для BTC — 4 знаки, для решти — 2
function precision(currency) {
  return currency === 'BTC' ? 4 : 2;
}

// Реквізити отримувачів (контейнери виплат) та каси прийому
const CONTAINER_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
export const OUT_RECIPIENTS = [];
for (const letter of CONTAINER_LETTERS) {
  for (let n = 1; n <= 5; n++) {
    const num = CONTAINER_LETTERS.indexOf(letter) * 100 + 100 + n; // A101, B202 ...
    OUT_RECIPIENTS.push(`TRC20_CONTAINER_${letter}${num}`);
  }
}
const CASH_DESKS = [
  'CASH_DESK_KYIV_1', 'CASH_DESK_KYIV_2', 'CASH_DESK_LVIV_1',
  'CASH_DESK_ODESA_1', 'CASH_DESK_DNIPRO_1',
];
const BANK_RECIPIENTS = ['IBAN_UA_PRIVAT_001', 'IBAN_UA_MONO_002', 'SWIFT_EU_SEPA_003'];

// Пари обміну: валюта прийому → валюта виплати, курс, діапазон суми прийому
const EXCHANGE_PAIRS = [
  { from: 'USD', to: 'USDT', rate: 0.995, min: 500, max: 50000 },
  { from: 'EUR', to: 'USDT', rate: 1.07, min: 500, max: 50000 },
  { from: 'USDT', to: 'USD', rate: 0.99, min: 500, max: 50000 },
  { from: 'USDT', to: 'EUR', rate: 0.92, min: 500, max: 50000 },
  { from: 'BTC', to: 'USDT', rate: 90000, min: 0.05, max: 2 },
  { from: 'USDT', to: 'BTC', rate: 1 / 90000, min: 5000, max: 100000 },
];
const TRANSFER_CURRENCIES = [
  { currency: 'USD', min: 500, max: 50000 },
  { currency: 'EUR', min: 500, max: 50000 },
  { currency: 'USDT', min: 500, max: 50000 },
];

function outRecipient(currency) {
  return currency === 'USD' || currency === 'EUR' ? pick(BANK_RECIPIENTS.concat(OUT_RECIPIENTS)) : pick(OUT_RECIPIENTS);
}

// Розбиває суму на `parts` додатних частин (спліт-виплата)
function splitAmount(total, parts, digits) {
  const weights = [];
  for (let i = 0; i < parts; i++) weights.push(0.5 + Math.random());
  const wSum = weights.reduce((s, w) => s + w, 0);
  const result = [];
  let rest = total;
  for (let i = 0; i < parts - 1; i++) {
    const part = round((total * weights[i]) / wSum, digits);
    result.push(part);
    rest -= part;
  }
  result.push(round(rest, digits));
  const minUnit = 1 / Math.pow(10, digits);
  return result.map((a) => (a > 0 ? a : minUnit));
}

export function randomUserId() {
  return randInt(CONFIG.USER_ID_MIN, CONFIG.USER_ID_MAX);
}

// Payload для POST /api/deals: 1 позиція IN + 2–3 позиції OUT
export function buildCreateDealPayload() {
  const type = Math.random() < 0.8 ? 'exchange' : 'transfer';
  let inCurrency;
  let outCurrency;
  let inAmount;
  let outTotal;

  if (type === 'exchange') {
    const pair = pick(EXCHANGE_PAIRS);
    inCurrency = pair.from;
    outCurrency = pair.to;
    inAmount = round(pair.min + Math.random() * (pair.max - pair.min), precision(inCurrency));
    outTotal = round(inAmount * pair.rate * 0.998, precision(outCurrency)); // з урахуванням комісії
  } else {
    const c = pick(TRANSFER_CURRENCIES);
    inCurrency = c.currency;
    outCurrency = c.currency;
    inAmount = round(c.min + Math.random() * (c.max - c.min), precision(inCurrency));
    outTotal = round(inAmount * 0.999, precision(outCurrency));
  }

  const outParts = randInt(2, 3);
  const items = [
    { direction: 'IN', currency: inCurrency, amount: inAmount, recipient: pick(CASH_DESKS) },
  ];
  for (const amount of splitAmount(outTotal, outParts, precision(outCurrency))) {
    items.push({ direction: 'OUT', currency: outCurrency, amount, recipient: outRecipient(outCurrency) });
  }

  const notRegular = Math.random() < 0.05 ? 1 : 0;
  return {
    user_id: randomUserId(),
    type,
    date: new Date().toISOString(),
    comment: `k6 ${CONFIG.TEST_TYPE}: OTC split payout ${inCurrency} -> ${outCurrency}`,
    not_regular: notRegular,
    not_regular_reason: notRegular ? 'Large amount, manual AML check' : null,
    items,
  };
}

// Наступний статус угоди за бізнес-процесом:
// new → pending / partially_fulfilled → fulfilled → closed
export function nextStatus(current) {
  switch (current) {
    case 'new':
      return Math.random() < 0.5 ? 'pending' : 'partially_fulfilled';
    case 'pending':
      return 'partially_fulfilled';
    case 'partially_fulfilled':
      return 'fulfilled';
    case 'fulfilled':
      return 'closed';
    default:
      return null;
  }
}

// Payload для PATCH /api/deals/{id}/status
export function buildStatusPayload(status, version) {
  const payload = { status, version };
  // Варіант А (partially_fulfilled) — перша pending-позиція → completed;
  // Варіант Б (fulfilled / closed) — усі позиції → completed
  if (status === 'partially_fulfilled' || status === 'fulfilled' || status === 'closed') {
    payload.item_status = 'completed';
  }
  return payload;
}

// Query для сценарію 3А — оперативний моніторинг активних угод
export function buildMonitoringQuery() {
  if (Math.random() < 0.5) {
    return { status: pick(['new', 'pending', 'partially_fulfilled']), user_id: randomUserId(), page: 1, limit: 20 };
  }
  return { status: 'uncompleted', page: randInt(1, 5), limit: 20 };
}

// Query для сценарію 3Б — багатокритеріальний пошук (LEFT JOIN users + EXISTS по recipient)
export function buildSearchQuery() {
  const r = Math.random();
  const q = { page: 1, limit: 20 };
  if (r < 0.5) {
    q.username = pick(CONFIG.SEARCH_USERNAMES);
    q.recipient = pick(OUT_RECIPIENTS);
  } else if (r < 0.75) {
    q.username = pick(CONFIG.SEARCH_USERNAMES);
    q.type = pick(['exchange', 'transfer']);
  } else {
    q.recipient = pick(OUT_RECIPIENTS);
    q.status = 'all';
  }
  return q;
}

export function toQueryString(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}
