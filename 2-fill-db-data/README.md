# Наповнення БД тестовими даними

Скрипт `db_func.py` підключається до MySQL на Aiven і заповнює таблиці `users`, `deals`, `deal_item` згенерованими даними (або очищає їх).
Таблиці мають бути вже створені запитом з [`../1-db-creation-script/table_creation_query.sql`](../1-db-creation-script/table_creation_query.sql).

## Налаштування

```bash
cd 2-fill-db-data
python3 -m venv fill-env
source fill-env/bin/activate
pip install -r requirements.txt
```

1. Скопіюй `.env.example` у `local.env` і заповни параметри з Aiven (Console → сервіс → Overview → Connection information): або `DB_SERVICE_URI`, або окремі поля `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
2. Завантаж з Aiven **CA certificate** і збережи як `ca.pem` у цій папці.

`local.env` і `ca.pem` у git не потрапляють (див. `.gitignore`).

## Запуск

```bash
source fill-env/bin/activate

python db_func.py --check                                # перевірити підключення
python db_func.py --users 10 --deals 50                  # заповнити
python db_func.py --clear                                # очистити всі таблиці (з підтвердженням)
python db_func.py --truncate --users 1000 --deals 50000  # очистити і заповнити заново
python db_func.py --help                                 # усі опції
```

| Опція | За замовч. | Опис |
|---|---|---|
| `--users N` | 100 | кількість користувачів |
| `--deals N` | 1000 | кількість угод (на кожну 1–5 позицій у `deal_item`) |
| `--days N` | 365 | дати угод за останні N днів |
| `--batch-size N` | 1000 | рядків в одному пакеті вставки |
| `--locale` | `uk_UA` | мова згенерованих імен (`en_US`, ...) |
| `--seed N` | — | однакові дані при кожному запуску |
| `--truncate` | — | очистити таблиці перед заповненням |
| `--clear` | — | лише очистити таблиці |
| `--check` | — | лише перевірити підключення і показати кількість рядків |
