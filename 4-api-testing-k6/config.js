// Конфігурація тестів: параметри середовища, профілі навантаження (п. 3.3 тест-плану)
// та пороги SLA (п. 3.5). Усі параметри можна перевизначити через `k6 run -e NAME=value`.

function envInt(name, def) {
  const v = __ENV[name];
  return v === undefined || v === '' ? def : parseInt(v, 10);
}

function envFloat(name, def) {
  const v = __ENV[name];
  return v === undefined || v === '' ? def : parseFloat(v);
}

function envList(name, def) {
  const v = __ENV[name];
  return v === undefined || v === '' ? def : v.split(',').map((s) => s.trim()).filter(Boolean);
}

export const CONFIG = {
  BASE_URL: (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  TEST_TYPE: (__ENV.TEST_TYPE || 'baseline').toLowerCase(),

  // Діапазон існуючих users.id (п. 3.4: 10 000 користувачів)
  USER_ID_MIN: envInt('USER_ID_MIN', 1),
  USER_ID_MAX: envInt('USER_ID_MAX', 10000),

  // Діапазон існуючих deals.id (п. 3.4: 1 000 000 угод) — для конкурентних PATCH
  DEAL_ID_MIN: envInt('DEAL_ID_MIN', 1),
  DEAL_ID_MAX: envInt('DEAL_ID_MAX', 1000000),

  // Частка PATCH-запитів до "чужих" (історичних) угод для перевірки оптимістичного
  // блокування (очікувано 409 Conflict). Решта PATCH — по угодах, створених цим VU.
  CONFLICT_PROBE_RATIO: envFloat('CONFLICT_PROBE_RATIO', 0.1),

  // Пауза між ітераціями VU (think time), секунди
  THINK_TIME_MIN: envFloat('THINK_TIME_MIN', 0.1),
  THINK_TIME_MAX: envFloat('THINK_TIME_MAX', 0.5),

  // Таймаут HTTP-запиту
  REQUEST_TIMEOUT: __ENV.REQUEST_TIMEOUT || '30s',

  // Значення для багатокритеріального пошуку (сценарій 3Б). username шукається через LIKE %...%
  SEARCH_USERNAMES: envList('SEARCH_USERNAMES', [
    'Шевченко', 'Коваленко', 'Бондаренко', 'Ткаченко', 'Мельник',
    'Олександр', 'Марія', 'Іван', 'Олена', 'Андрій',
  ]),
};

// Профіль робочого навантаження (п. 3.2): 50% POST / 20% PATCH / 15% GET-моніторинг / 15% GET-пошук
export const WORKLOAD_MIX = [
  { op: 'create', weight: 50 },
  { op: 'update_status', weight: 20 },
  { op: 'list_monitoring', weight: 15 },
  { op: 'list_search', weight: 15 },
];

// Профілі навантаження (п. 3.3)
const SCENARIOS = {
  // Додатковий короткий прогін для перевірки, що скрипт і API працюють
  smoke: {
    executor: 'constant-vus',
    vus: 1,
    duration: '30s',
  },

  // 1. Baseline Test: 5 VUs стабільно, 3 хв
  baseline: {
    executor: 'constant-vus',
    vus: 5,
    duration: '3m',
  },

  // 2. Load Test: 0 → 50 (1 хв), 50 (5 хв), 50 → 0 (1 хв) = 7 хв
  load: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '1m', target: 50 },
      { duration: '5m', target: 50 },
      { duration: '1m', target: 0 },
    ],
    gracefulRampDown: '30s',
  },

  // 3. Stress Test: ступінчасто 50 → 100 → 150 → 200 VUs, 10 хв
  stress: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '30s', target: 50 },
      { duration: '2m', target: 50 },
      { duration: '30s', target: 100 },
      { duration: '2m', target: 100 },
      { duration: '30s', target: 150 },
      { duration: '2m', target: 150 },
      { duration: '30s', target: 200 },
      { duration: '1m30s', target: 200 },
      { duration: '30s', target: 0 },
    ],
    gracefulRampDown: '30s',
  },

  // 4. Spike Test: 5 VUs (30 с) → стрибок до 200 VUs (1 хв) → спад до 10 VUs (1 хв) = 2.5 хв
  spike: {
    executor: 'ramping-vus',
    startVUs: 5,
    stages: [
      { duration: '30s', target: 5 },
      { duration: '5s', target: 200 },
      { duration: '55s', target: 200 },
      { duration: '5s', target: 10 },
      { duration: '55s', target: 10 },
    ],
    gracefulRampDown: '10s',
  },
};

// Пороги SLA (п. 3.5). Для Stress/Spike вони навмисно можуть не виконуватися —
// результат показує, де саме відбувається деградація.
function buildThresholds(testType) {
  const t = {
    // Avg Latency ≤ 600 мс, p99 ≤ 5000 мс по всіх операціях
    'http_req_duration{kind:api}': ['avg<600', 'p(99)<5000'],
    // p95 ≤ 1500 мс — жорсткий поріг для касових операцій
    'http_req_duration{op:create}': ['p(95)<1500'],
    'http_req_duration{op:update_status}': ['p(95)<1500'],
    // Окремо фіксуємо затримки читання (без жорсткого порогу p95)
    'http_req_duration{op:list_monitoring}': ['p(99)<5000'],
    'http_req_duration{op:list_search}': ['p(99)<5000'],
    // Error Rate < 0.1%: лише аварійні збої (HTTP 5xx, таймаути, розриви з'єднань)
    server_errors: ['rate<0.001'],
  };
  // Throughput ≥ 80 RPS — цільовий показник під робочим навантаженням
  if (testType === 'load' || testType === 'stress') {
    t['http_reqs{kind:api}'] = ['rate>=80'];
  }
  return t;
}

export function buildOptions() {
  const testType = CONFIG.TEST_TYPE;
  const scenario = SCENARIOS[testType];
  if (!scenario) {
    throw new Error(
      `Невідомий TEST_TYPE="${testType}". Доступні: ${Object.keys(SCENARIOS).join(', ')}`,
    );
  }
  return {
    scenarios: { [testType]: Object.assign({ exec: 'default' }, scenario) },
    thresholds: buildThresholds(testType),
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
    tags: { test_type: testType },
  };
}
