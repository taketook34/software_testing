"""
Наповнення CRM-бази (users, deals, deal_item) тестовими даними.

Параметри підключення беруться з файлу local.env поруч зі скриптом (див. .env.example).

Приклади:
    python db_func.py --check                          # лише перевірити підключення
    python db_func.py                                  # 100 users, 1000 deals
    python db_func.py --users 1000 --deals 50000 --truncate
    python db_func.py --clear                          # лише очистити таблиці
"""

import argparse
import os
import random
import sys
import time
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import pymysql
from dotenv import load_dotenv
from faker import Faker

BASE_DIR = Path(__file__).resolve().parent

# --- Довідники значень --------------------------------------------------------

ROLES = [("client", 85), ("manager", 10), ("admin", 5)]
EXCHANGES = ["Binance", "Kraken", "Coinbase", "WhiteBIT", "Bybit", "OKX", "KuCoin"]

DEAL_TYPES = [("exchange", 60), ("deposit", 15), ("withdrawal", 15), ("split_payout", 10)]
DEAL_STATUSES = [("new", 10), ("in_progress", 15), ("completed", 60), ("cancelled", 10), ("failed", 5)]
NOT_REGULAR_REASONS = [
    "Сума перевищує ліміт",
    "Нетиповий отримувач",
    "Ручне коригування курсу",
    "Підозра на шахрайство",
    "Повторна угода за короткий час",
]

# валюта -> (мін. сума, макс. сума)
CURRENCIES = {
    "UAH": (100, 500_000),
    "USD": (10, 20_000),
    "EUR": (10, 20_000),
    "USDT": (10, 50_000),
    "BTC": (0.0005, 2),
    "ETH": (0.01, 30),
}
ITEM_STATUSES = [("pending", 15), ("processed", 70), ("rejected", 10), ("refunded", 5)]


def weighted(choices):
    values, weights = zip(*choices)
    return random.choices(values, weights=weights)[0]


# --- Підключення --------------------------------------------------------------

def load_config():
    load_dotenv(BASE_DIR / "local.env")

    cfg = {}
    uri = os.getenv("DB_SERVICE_URI", "").strip()
    if uri:
        # mysql://user:password@host:port/dbname?ssl-mode=REQUIRED
        parsed = urlparse(uri)
        cfg = {
            "host": parsed.hostname,
            "port": parsed.port,
            "user": unquote(parsed.username or ""),
            "password": unquote(parsed.password or ""),
            "database": parsed.path.lstrip("/"),
            "ssl_mode": parse_qs(parsed.query).get("ssl-mode", [None])[0],
        }

    # окремі поля мають пріоритет над URI
    overrides = {
        "host": os.getenv("DB_HOST"),
        "port": os.getenv("DB_PORT"),
        "user": os.getenv("DB_USER"),
        "password": os.getenv("DB_PASSWORD"),
        "database": os.getenv("DB_NAME"),
        "ssl_mode": os.getenv("DB_SSL_MODE"),
    }
    for key, value in overrides.items():
        if value and value.strip():
            cfg[key] = value.strip()

    missing = [k for k in ("host", "port", "user", "password", "database") if not cfg.get(k)]
    if missing:
        sys.exit(f"У .env не заповнено: {', '.join(missing)} (або вкажи DB_SERVICE_URI)")

    cfg["port"] = int(cfg["port"])
    cfg["ssl_mode"] = (cfg.get("ssl_mode") or "REQUIRED").upper()

    ca = os.getenv("DB_CA_CERT", "./ca.pem").strip()
    ca_path = Path(ca) if Path(ca).is_absolute() else BASE_DIR / ca
    cfg["ca_cert"] = ca_path
    return cfg


def connect(cfg):
    ssl_args = {}
    if cfg["ssl_mode"] != "DISABLED":
        if not cfg["ca_cert"].is_file():
            sys.exit(f"Не знайдено CA certificate: {cfg['ca_cert']}")
        ssl_args = {"ssl_ca": str(cfg["ca_cert"]), "ssl_verify_cert": True}

    return pymysql.connect(
        host=cfg["host"],
        port=cfg["port"],
        user=cfg["user"],
        password=cfg["password"],
        database=cfg["database"],
        charset="utf8mb4",
        connect_timeout=15,
        autocommit=False,
        **ssl_args,
    )


# --- Генерація даних ----------------------------------------------------------

def next_id(cur, table):
    cur.execute(f"SELECT COALESCE(MAX(id), 0) FROM {table}")
    return cur.fetchone()[0] + 1


def insert_batches(conn, sql, rows_iter, batch_size, label, total):
    """Вставляє рядки пакетами з комітом після кожного пакета."""
    done = 0
    batch = []
    with conn.cursor() as cur:
        for row in rows_iter:
            batch.append(row)
            if len(batch) >= batch_size:
                cur.executemany(sql, batch)
                conn.commit()
                done += len(batch)
                batch.clear()
                print(f"\r  {label}: {done}/{total}" if total else f"\r  {label}: {done}", end="", flush=True)
        if batch:
            cur.executemany(sql, batch)
            conn.commit()
            done += len(batch)
    print(f"\r  {label}: {done}" + " " * 20)
    return done


def gen_users(fake, first_id, count, period_start, now):
    used = set()
    for i in range(count):
        # username унікальний в межах запуску
        name = fake.user_name()
        while name in used:
            name = f"{fake.user_name()}{random.randint(1, 9999)}"
        used.add(name)

        role = weighted(ROLES)
        exchange = random.choice(EXCHANGES) if role == "client" and random.random() < 0.6 else None
        created = fake.date_time_between(start_date=period_start, end_date=now)
        yield (first_id + i, name, role, exchange, created)


def gen_deals(fake, first_id, count, user_ids, period_start, now, items_out):
    """Генерує угоди; позиції кожної угоди складає в items_out (список)."""
    for i in range(count):
        deal_id = first_id + i
        user_id = random.choice(user_ids) if user_ids and random.random() < 0.95 else None
        date = fake.date_time_between(start_date=period_start, end_date=now)
        deal_type = weighted(DEAL_TYPES)
        status = weighted(DEAL_STATUSES)
        comment = fake.sentence(nb_words=8) if random.random() < 0.3 else None
        version = random.choices([1, 2, 3, 4], weights=[70, 20, 7, 3])[0]
        not_regular = 1 if random.random() < 0.05 else 0
        reason = random.choice(NOT_REGULAR_REASONS) if not_regular else None
        created = min(date + timedelta(seconds=random.randint(0, 300)), now)

        items_out.extend(gen_items(fake, deal_id, deal_type, status, created))
        yield (deal_id, user_id, date, deal_type, status, comment, version, not_regular, reason, created)


def gen_items(fake, deal_id, deal_type, deal_status, deal_created):
    if deal_type == "deposit":
        directions = ["IN"]
    elif deal_type == "withdrawal":
        directions = ["OUT"]
    elif deal_type == "split_payout":
        directions = ["IN"] + ["OUT"] * random.randint(2, 4)
    else:  # exchange
        directions = ["IN", "OUT"]

    items = []
    for direction in directions:
        currency = random.choice(list(CURRENCIES))
        low, high = CURRENCIES[currency]
        amount = Decimal(str(round(random.uniform(low, high), 4)))
        recipient = fake.name() if direction == "OUT" else None
        if deal_status in ("completed",):
            status = weighted([("processed", 90), ("refunded", 10)])
        elif deal_status in ("cancelled", "failed"):
            status = weighted([("rejected", 70), ("refunded", 30)])
        else:
            status = weighted(ITEM_STATUSES)
        created = deal_created + timedelta(seconds=random.randint(0, 60))
        items.append((deal_id, direction, currency, amount, recipient, status, created))
    return items


# --- Основна логіка -----------------------------------------------------------

def truncate_all(conn):
    with conn.cursor() as cur:
        cur.execute("SET FOREIGN_KEY_CHECKS = 0")
        for table in ("deal_item", "deals", "users"):
            cur.execute(f"TRUNCATE TABLE {table}")
        cur.execute("SET FOREIGN_KEY_CHECKS = 1")
    conn.commit()
    print("Таблиці очищено.")


def fill(conn, args):
    fake = Faker(args.locale)
    if args.seed is not None:
        random.seed(args.seed)
        Faker.seed(args.seed)

    now = datetime.now().replace(microsecond=0)
    period_start = now - timedelta(days=args.days)

    with conn.cursor() as cur:
        first_user_id = next_id(cur, "users")
        first_deal_id = next_id(cur, "deals")

    # 1. users
    insert_batches(
        conn,
        "INSERT INTO users (id, username, role, linked_exchange, created_at) VALUES (%s, %s, %s, %s, %s)",
        gen_users(fake, first_user_id, args.users, period_start, now),
        args.batch_size, "users", args.users,
    )

    with conn.cursor() as cur:
        cur.execute("SELECT id FROM users")
        user_ids = [row[0] for row in cur.fetchall()]

    # 2. deals + 3. deal_item (позиції вставляються слідом за кожним пакетом угод)
    deal_sql = (
        "INSERT INTO deals (id, user_id, date, type, status, comment, version, "
        "not_regular, not_regular_reason, created_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
    )
    item_sql = (
        "INSERT INTO deal_item (deal_id, direction, currency, amount, recipient, status, created_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s)"
    )

    items = []
    deals_done = items_done = 0
    batch = []
    with conn.cursor() as cur:
        for deal in gen_deals(fake, first_deal_id, args.deals, user_ids, period_start, now, items):
            batch.append(deal)
            if len(batch) >= args.batch_size:
                deals_done, items_done = flush_deals(conn, cur, deal_sql, item_sql, batch, items,
                                                     deals_done, items_done, args.deals)
        if batch:
            deals_done, items_done = flush_deals(conn, cur, deal_sql, item_sql, batch, items,
                                                 deals_done, items_done, args.deals)
    print(f"\r  deals: {deals_done}, deal_item: {items_done}" + " " * 20)


def flush_deals(conn, cur, deal_sql, item_sql, batch, items, deals_done, items_done, total):
    cur.executemany(deal_sql, batch)
    cur.executemany(item_sql, items)
    conn.commit()
    deals_done += len(batch)
    items_done += len(items)
    batch.clear()
    items.clear()
    print(f"\r  deals: {deals_done}/{total}, deal_item: {items_done}", end="", flush=True)
    return deals_done, items_done


def print_counts(conn):
    with conn.cursor() as cur:
        for table in ("users", "deals", "deal_item"):
            cur.execute(f"SELECT COUNT(*) FROM {table}")
            print(f"  {table}: {cur.fetchone()[0]} рядків")


def parse_args():
    p = argparse.ArgumentParser(description="Наповнення CRM-бази тестовими даними")
    p.add_argument("--users", type=int, default=100, help="кількість користувачів (за замовч. 100)")
    p.add_argument("--deals", type=int, default=1000, help="кількість угод (за замовч. 1000)")
    p.add_argument("--days", type=int, default=365, help="за скільки останніх днів генерувати дати")
    p.add_argument("--batch-size", type=int, default=1000, help="рядків в одному пакеті вставки")
    p.add_argument("--locale", default="uk_UA", help="локаль Faker (uk_UA, en_US, ...)")
    p.add_argument("--seed", type=int, help="seed для відтворюваних даних")
    p.add_argument("--truncate", action="store_true", help="очистити таблиці перед заповненням")
    p.add_argument("--clear", action="store_true", help="лише очистити таблиці, без заповнення")
    p.add_argument("--check", action="store_true", help="лише перевірити підключення")
    return p.parse_args()


def main():
    args = parse_args()
    cfg = load_config()

    print(f"Підключення до {cfg['host']}:{cfg['port']}/{cfg['database']} як {cfg['user']} ...")
    try:
        conn = connect(cfg)
    except pymysql.MySQLError as e:
        sys.exit(f"Помилка підключення: {e}")

    try:
        with conn.cursor() as cur:
            cur.execute("SELECT VERSION()")
            print(f"Підключено. MySQL {cur.fetchone()[0]}")

        if args.check:
            print_counts(conn)
            return

        if args.clear:
            answer = input("Видалити ВСІ дані з users, deals, deal_item? [y/N]: ")
            if answer.strip().lower() != "y":
                print("Скасовано.")
                return
            truncate_all(conn)
            print_counts(conn)
            return

        if args.truncate:
            truncate_all(conn)

        started = time.time()
        print("Заповнення:")
        fill(conn, args)
        print(f"Готово за {time.time() - started:.1f} с. Зараз у базі:")
        print_counts(conn)
    except KeyboardInterrupt:
        conn.rollback()
        print("\nПерервано. Вже закомічені пакети залишились у базі.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
