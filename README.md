# PROOF OF GREED 🧾

Кассовый чек твоей жадности из блокчейна: вставь кошелёк → страница читает **сырые логи `valorVault` + key-шопов + claim vault** в Abstract chain → печатает lifetime P&L игры **Maze of Gains** (ключи с 03.02.2026, топ-апы, хиты, ETH-бaунти/джекпоты, кэшаут, NET, вердикт-штамп) → скачай PNG и постись.

Один файл `greed.html`, ноль зависимостей, ноль бэкенда: RPC Abstract открыт для браузера (CORS `*`), все денежные каналы сверены с цепочкой транзакционно (аудиты 20–23.09.2026).

## Данные (источник истины)

| Событие | Сигнатура | Смысл |
|---|---|---|
| `valorVault` `0x73a19dd2…` | deposit | word0 = USDC, внесённые игроком (word1 = VALOR ×1e6) |
| `valorVault` `0x33b093f4…` | withdrawal | word0 = USDC, выведенные игроком (перевод vault→игрок в той же tx) |
| `valorVault` `0xddb801b4…` | win credit | word0 = USD-кредит выигрыша (bounty/gem/throne), без перевода в tx |
| key-шопы `0x404d1f54…` | KeysPurchased | word2 = totalPaid USDC ($1/ключ; легаси 0.001 ETH/ключ — по $1-номиналу игры), считаем с 03.02.2026 |
| claim vault `0x1ddd787c…` | bounty paid | word0 = **ethWei** — реальные ETH-выплаты игроку с 03.02.2026 (~616 ETH) |
| claim vault `0x05b8b3cb…` | jackpot paid | word0 = **ethWei** (~314 ETH ≈ `jackpotsPaidEth` API) |

`NET = withdrawn + ETH-клеймы(по споту) − (ключи + топ-апы)` (реализованный кэш). Хиты в NET не входят (сначала кредит, потом вывод — без двойного счёта). Невидимы никому: серверные VALOR-ключи, Robinhood-relay (квантифицировано карточкой PostHog), недельные доли пула.

## Живой слой

- **LIVE VAULT TELEMETRY + TAPE** — клиентский поллинг RPC каждые 45 c: казна vault, fed/cashed/hits за 24 ч, лента последних движений.
- **data/*.json** — «бэкенд без сервера»: GitHub Actions (`workflows/data.yml`, cron каждые 10 минут; GitHub разрежает schedule до ~4–6 прогонов/сутки — свежесть каждой цифры видна на самом сайте в «bot-updated / copy time») гоняет `scripts/build-data.mjs` (инкрементальный скан vault + пулы playmog.xyz, у которых нет CORS) и коммитит `data/hall.json` (все кошельки с агрегатами + топы + **ники игроков** из публичного `/api/profile/{address}`), `data/pools.json` и `data/posthog.json` (серверные метрики сезона из публичного PostHog-дашборда игры: ключи Abstract vs Robinhood-relay, выплаченные гемы, гонка corn — committed/raffle/uncommitted, EVE — квантификация невидимого на цепи слоя). Сайт рисует из них карточки пулов, сервер-vs-цепь, **CORN RACE & RAFFLES** и **HALL OF GREED**; живые значения фетчатся прямо из браузера (CORS-открытый PostHog), бот-копия — фолбэк. Локально с `file://` этот слой просто скрыт.

## Запуск

```bash
# локально
start greed.html            # или: python -m http.server → http://localhost:8000/greed.html
node scripts/build-data.mjs # обновить data/*.json вручную

# деплой: основной репо приватный (proof-of-greed); сайт живёт в публичном зеркале
# proof-of-greed-site (Pages free-план не даёт Pages приватным репо):
#   greed.html, art/, og.png, data/, scripts/build-data.mjs, .github/workflows/data.yml
# зеркало само обновляет data/ кроном (фактически ~4–6 раз/сутки: GH троттлит schedule); код меняем здесь → пушим туда же
```

## Остальной проект

- `mog-sentinel.mjs` — CLI-монитор/EV-калькулятор Deed Season;
- `mog-tg-bot.mjs` — Telegram-компаньон (`/receipt 0x…` = текстовый чек P&L из цепи);
- `mog-dash.mjs` + `dash.html` — живой дашборд с CORS-прокси;
- `guide.html`, `gameplay.html`, `quickstart.html`, `floors10*.html` — фан-гайды (PDF рядом);
- `PROOF-OF-GREED-PLAN.md` — план, проверенные факты цепи, статус фаз.

Fan project · not affiliated with Onchain Heroes · **not financial advice** · the maze always eats its share.
