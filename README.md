# Cloudflare Worker — Edge-фильтр для APK-трафика

Первая линия обороны. JavaScript V8-скрипт на Edge-нодах Cloudflare, время ответа 2-5мс. Фильтрует мусор ДО того как он дойдёт до бэкенда — экономит ресурсы сервера и API-лимиты IPinfo/IPQS.

---

## Что проверяет (в порядке приоритета)

| # | Проверка | Источник | Результат |
|---|---------|---------|----------|
| 0 | Кнопка паники | KV `PANIC_MODE` | Весь трафик → белая |
| 1 | X-Client-Secret | Заголовок | Нет секрета → 403 |
| 2 | Бот User-Agent | Заголовок | Googlebot/bingbot → 403 |
| 3 | Десктоп User-Agent | Заголовок | Windows/Mac/X11 → 403 |
| 4 | Не Android | Заголовок | Нет "Android" в UA → 403 |
| 5 | Страна модерации | cf-ipcountry | US/GB/DE/FR... → 403 |
| 6 | ASN датацентра | request.cf.asn | Google/AWS/CF → 403 |
| ✓ | Всё чисто | — | Proxy → FastAPI |

---

## Архитектура

```
Юзер/Бот → Cloudflare Worker (Edge, 2-5ms)
                ├─ Грязный → 403/404/redirect (не доходит до сервера)
                └─ Чистый → Nginx → FastAPI (глубокий скоринг)
```

---

## KV Storage (динамические списки)

Настройки хранятся в Cloudflare KV и обновляются из админки:

| Ключ | Описание | Пример |
|------|---------|--------|
| `BLOCKED_COUNTRIES` | Страны через запятую | US,GB,DE,FR,IN |
| `BLOCKED_ASNS` | ASN через запятую | 15169,8075,16509 |
| `BLOCKED_UA` | Подстроки ботов | Googlebot,bingbot |
| `CLIENT_SECRET` | Секретный ключ | myappkey123 |
| `PANIC_MODE` | Режим паники | true/false |
| `WHITE_FLOW_TYPE` | Тип ответа | show_403/show_404/redirect_safe/fake_html |
| `SAFE_URL` | Белая ссылка | https://play.google.com |

---

## Деплой

### 1. Установи Wrangler

```bash
npm install
```

### 2. Авторизуйся в Cloudflare

```bash
npx wrangler login
```

### 3. Создай KV namespace

```bash
npx wrangler kv namespace create CONFIG
# Скопируй ID в wrangler.toml
```

### 4. Заполни KV дефолтами

```bash
npx wrangler kv key put --binding CONFIG "BLOCKED_COUNTRIES" "US,GB,DE,FR,NL,SE,CA,AU,JP,SG,IN"
npx wrangler kv key put --binding CONFIG "BLOCKED_ASNS" "15169,8075,16509,14618,13335,14061,24940,16276,32934,20473"
npx wrangler kv key put --binding CONFIG "CLIENT_SECRET" "your-secret-here"
npx wrangler kv key put --binding CONFIG "PANIC_MODE" "false"
npx wrangler kv key put --binding CONFIG "WHITE_FLOW_TYPE" "redirect_safe"
```

### 5. Настрой wrangler.toml

```toml
[vars]
BACKEND_URL = "https://your-backend.com"
SAFE_URL = "https://play.google.com/store"
```

### 6. Задеплой

```bash
npx wrangler deploy
```

### 7. Привяжи домен

В Cloudflare Dashboard → Workers → apk-filter → Settings → Triggers → Add Custom Domain

---

## Локальная разработка

```bash
npx wrangler dev
# Worker на http://localhost:8787

# Тесты:
curl http://localhost:8787/ -H "X-Client-Secret: test"
curl http://localhost:8787/ -H "User-Agent: Googlebot"
```

---

## Связь с остальными компонентами

- **Админ-панель** → обновляет KV через Cloudflare API (кнопка "Сохранить")
- **Кнопка паники** → ставит `PANIC_MODE=true` в KV → весь трафик на белую
- **FastAPI** → получает только чистый трафик + заголовки X-CF-Country, X-CF-ASN

---

## Honeypot (ловушки для ботов)

Worker блокирует ботов которые сканируют стандартные пути. Легитимное приложение никогда не обращается к `/robots.txt` или `/wp-admin` — значит кто зашёл туда, тот бот.

Блокируемые пути:
```
/robots.txt, /sitemap.xml, /admin, /wp-admin, /wp-login.php,
/.env, /config.php, /.git/config, /phpmyadmin, /xmlrpc.php,
/login, /signin, /debug, /server-status, /backup, /dump.sql
```

На Edge (Worker) — мгновенный блок. На бэкенде (FastAPI) — IP автоматически банится в Redis на 7 дней.

---

## Текущий деплой

- **Worker URL:** `https://apk-filter.koskoro.workers.dev`
- **Backend:** `https://api.threeamigosteam.com/engine`
- **KV Namespace:** CONFIG (`05d3222196c447998ff472d630b43fa0`)
- **SSL:** Let's Encrypt на `api.threeamigosteam.com`

---

## Что входит в Этап 1

Этот репозиторий — часть инфраструктурного фундамента:

| Компонент | Что делает | Где |
|-----------|-----------|-----|
| **CF Worker** | Edge-фильтрация за 2-5мс | Этот репо |
| **Nginx** | Reverse proxy, SSL, rate limit, real IP | Сервер 31.76.251.103 |
| **Redis** | Rate limiting 100 req/min + honeypot баны | Сервер |
| **Honeypot** | 30+ ловушек, автобан ботов | Worker + FastAPI |

Конфиги Nginx лежат в `nginx/` папке этого репо для удобства деплоя.
