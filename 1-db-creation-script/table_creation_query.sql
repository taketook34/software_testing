-- Створення структури ядра CRM для навантажувального стенду
-- 1. Довідник клієнтів/користувачів
CREATE TABLE IF NOT EXISTS users (
id INT AUTO_INCREMENT PRIMARY KEY,
username VARCHAR(100) NOT NULL,
role VARCHAR(50) DEFAULT 'client',
linked_exchange VARCHAR(50) DEFAULT NULL,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- 2. Журнал угод
CREATE TABLE IF NOT EXISTS deals (
id INT AUTO_INCREMENT PRIMARY KEY,
user_id INT NULL,
date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
type VARCHAR(50) NOT NULL DEFAULT 'exchange',
status VARCHAR(50) NOT NULL DEFAULT 'new',
comment TEXT NULL,
version INT NOT NULL DEFAULT 1,
not_regular TINYINT(1) NOT NULL DEFAULT 0,
not_regular_reason VARCHAR(255) NULL,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
CONSTRAINT fk_deals_user FOREIGN KEY (user_id)
REFERENCES users(id) ON DELETE SET NULL,
INDEX idx_deals_date (date),
INDEX idx_deals_status (status),
INDEX idx_deals_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- 3. Деталізація позицій угоди (Спліт-виплати / Прийом коштів)
CREATE TABLE IF NOT EXISTS deal_item (
id INT AUTO_INCREMENT PRIMARY KEY,
deal_id INT NOT NULL,
direction ENUM('IN', 'OUT') NOT NULL,
currency VARCHAR(10) NOT NULL,
amount DECIMAL(18, 4) NOT NULL,
recipient VARCHAR(150) NULL,
status VARCHAR(50) NOT NULL DEFAULT 'pending',
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
CONSTRAINT fk_deal_item_deal FOREIGN KEY (deal_id)
REFERENCES deals(id) ON DELETE CASCADE,
INDEX idx_deal_item_deal_id (deal_id),
INDEX idx_deal_item_recipient (recipient),
INDEX idx_deal_item_currency (currency)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;