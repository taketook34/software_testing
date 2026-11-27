<h1 align="center">Етап 4. Навантажувальне тестування API (k6)</h1>

Скрипти k6 реалізують модель навантаження (п. 3.2), сценарії тестування (п. 3.3) та пороги SLA (п. 3.5) тест-плану для API CRM, що працює на `http://localhost:3000`. Формат запитів відповідає `API_PAYLOADS.md`.

## Структура

| Файл | Призначення |
|---|---|
| [`main.js`](main.js) | точка входу: `setup` (перевірка `/api/health`), розподіл операцій, `teardown` |
| [`config.js`](config.js) | параметри середовища, профілі навантаження (`smoke`, `baseline`, `load`, `stress`, `spike`), пороги SLA |
| [`lib/data.js`](lib/data.js) | генерація payload-ів (угоди зі спліт-виплатами, статуси, query-параметри пошуку) |
| [`lib/api.js`](lib/api.js) | запити до ендпоінтів, checks, кастомні метрики |

## Модель навантаження (п. 3.2)

Кожна ітерація VU обирає операцію з вагами:

| Операція | Частка | Що відправляється |
|---|---|---|
| `POST /api/deals` | 50% | угода `exchange`/`transfer`, 1 позиція `IN` + 2–3 позиції `OUT` на різні `recipient` |
| `PATCH /api/deals/{id}/status` | 20% | перехід `new → pending / partially_fulfilled → fulfilled → closed` з актуальною `version` |
| `GET /api/deals` (моніторинг, 3А) | 15% | `status` + `user_id` або `status=uncompleted` |
| `GET /api/deals` (пошук, 3Б) | 15% | `username` (LIKE) + `recipient` (EXISTS), або з `type` / `status=all` |

PATCH працює з угодами, які створив цей самий VU, тому знає їхню поточну версію. Частина PATCH (`CONFLICT_PROBE_RATIO`, за замовчуванням 10%) іде на випадкові історичні угоди з `version=1`. Так імітуються конкурентні касири й перевіряється оптимістичне блокування (`409 Conflict`).

## Сценарії (п. 3.3)

| `TEST_TYPE` | Профіль | Тривалість |
|---|---|---|
| `smoke` | 1 VU (перевірка, що скрипт і API працюють) | 30 с |
| `baseline` | 5 VUs стабільно | 3 хв |
| `load` | 0 → 50 (1 хв), 50 (5 хв), 50 → 0 (1 хв) | 7 хв |
| `stress` | 50 → 100 → 150 → 200 VUs, по 2 хв на сходинку | 10 хв |
| `spike` | 5 VUs (30 с) → 200 VUs (1 хв) → 10 VUs (1 хв) | 2.5 хв |

## Пороги (SLA, п. 3.5)

| Метрика k6 | Поріг |
|---|---|
| `http_req_duration{kind:api}` | `avg < 600 мс`, `p(99) < 5000 мс` |
| `http_req_duration{op:create}`, `{op:update_status}` | `p(95) < 1500 мс` |
| `server_errors` (5xx, таймаути, розриви з'єднань) | `rate < 0.1%` |
| `http_reqs{kind:api}` (лише `load` і `stress`) | `rate >= 80 RPS` |

Відповіді `409` (конфлікт версій) і `429` (Rate Limiter) вважаються очікуваними: вони не потрапляють у `http_req_failed`, а рахуються окремо в метриках `version_conflicts` і `rate_limited` / `rate_limited_count`. Інші 4xx (невалідний payload, неіснуючий `user_id`) рахуються в `client_errors_4xx`.

У `stress` і `spike` пороги можуть не виконуватися — це очікувано, бо ці тести шукають точку деградації та перевіряють спрацювання Rate Limiter.

## Встановлення k6

**Debian / Ubuntu:**

```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

**Windows:**

```powershell
winget install k6 --source winget
# або
choco install k6
```

**macOS:**

```bash
brew install k6
```

**Docker** (без встановлення):

```bash
docker pull grafana/k6
```

Перевірка:

```bash
k6 version
```

Інших залежностей немає: скрипти використовують лише вбудовані модулі k6.

## Запуск

Усі команди виконуються з папки `4-api-testing-k6`. API має працювати на `http://localhost:3000`.

```bash
cd 4-api-testing-k6
mkdir -p results
```

**Smoke (швидка перевірка):**

```bash
k6 run -e TEST_TYPE=smoke main.js
```

**1. Baseline Test:**

```bash
k6 run -e TEST_TYPE=baseline --summary-export=results/baseline.json main.js
```

**2. Load Test:**

```bash
k6 run -e TEST_TYPE=load --summary-export=results/load.json main.js
```

**3. Stress Test:**

```bash
k6 run -e TEST_TYPE=stress --summary-export=results/stress.json main.js
```

**4. Spike Test:**

```bash
k6 run -e TEST_TYPE=spike --summary-export=results/spike.json main.js
```

**Порівняльний експеримент** (після зміни `connectionLimit` на 20–30 і додавання індексу `deal_item(deal_id, recipient)`): ті самі команди для `load` і `stress`, але з іншим іменем файлу результатів:

```bash
k6 run -e TEST_TYPE=load --summary-export=results/load_tuned.json main.js
k6 run -e TEST_TYPE=stress --summary-export=results/stress_tuned.json main.js
```

### HTML-звіт (вбудований веб-дашборд k6)

Під час тесту дашборд відкривається на `http://localhost:5665`, а після завершення зберігається HTML-звіт:

```bash
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=results/load-report.html \
  k6 run -e TEST_TYPE=load main.js
```

Windows (PowerShell):

```powershell
$env:K6_WEB_DASHBOARD="true"; $env:K6_WEB_DASHBOARD_EXPORT="results/load-report.html"
k6 run -e TEST_TYPE=load main.js
```

### Відправка метрик k6 у Prometheus (для Grafana)

Prometheus має бути запущений з `--web.enable-remote-write-receiver` (див. `API_PAYLOADS.md`).

```bash
K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write \
K6_PROMETHEUS_RW_TREND_STATS="avg,p(95),p(99),max" \
  k6 run -o experimental-prometheus-rw -e TEST_TYPE=load main.js
```

Windows (PowerShell):

```powershell
$env:K6_PROMETHEUS_RW_SERVER_URL="http://localhost:9090/api/v1/write"
$env:K6_PROMETHEUS_RW_TREND_STATS="avg,p(95),p(99),max"
k6 run -o experimental-prometheus-rw -e TEST_TYPE=load main.js
```

### Запуск через Docker

```bash
docker run --rm -i --network host -v "$PWD:/scripts" -w /scripts grafana/k6 \
  run -e TEST_TYPE=load --summary-export=results/load.json main.js
```

`--network host` дає контейнеру доступ до `localhost:3000` на Linux. На Windows і macOS замість цього додайте `-e BASE_URL=http://host.docker.internal:3000`.

## Параметри (`-e NAME=value`)

| Параметр | За замовч. | Опис |
|---|---|---|
| `TEST_TYPE` | `baseline` | `smoke`, `baseline`, `load`, `stress`, `spike` |
| `BASE_URL` | `http://localhost:3000` | адреса API |
| `USER_ID_MIN` / `USER_ID_MAX` | `1` / `10000` | діапазон існуючих `users.id` (FK `fk_deals_user`) |
| `DEAL_ID_MIN` / `DEAL_ID_MAX` | `1` / `1000000` | діапазон існуючих `deals.id` для конкурентних PATCH |
| `CONFLICT_PROBE_RATIO` | `0.1` | частка PATCH на історичні угоди (перевірка `409`) |
| `THINK_TIME_MIN` / `THINK_TIME_MAX` | `0.1` / `0.5` | пауза між ітераціями VU, с (`0` / `0` вимикає паузу) |
| `REQUEST_TIMEOUT` | `30s` | таймаут HTTP-запиту |
| `SEARCH_USERNAMES` | список українських імен/прізвищ | значення `username` для пошуку 3Б, через кому |

Якщо в БД менше даних, ніж у тест-плані (наприклад, 1000 користувачів і 50 000 угод), передайте реальні межі. Інакше POST з неіснуючим `user_id` повертатиме `400`:

```bash
k6 run -e TEST_TYPE=baseline -e USER_ID_MAX=1000 -e DEAL_ID_MAX=50000 main.js
```

## Що дивитися в результатах

- `http_req_duration` з розбивкою за тегами `op` (`create`, `update_status`, `list_monitoring`, `list_search`): значення avg, p95 і p99.
- `http_reqs`: пропускна здатність (RPS).
- `server_errors`: Error Rate за SLA.
- `rate_limited`, `rate_limited_count`: спрацювання Rate Limiter (насамперед у `spike`).
- `version_conflicts`: робота оптимістичного блокування.
- `deals_created`, `deals_updated`: кількість успішних записів.
- Лог `teardown`: стан пулу з `/api/health` після тесту (відновлення після піку).
- Метрика `crm_mysql_pool_queue_length` з `/api/metrics` у Prometheus/Grafana: насичення пулу підключень.
