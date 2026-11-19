# dsh-api-cost

> Track API token spend in DeepSeek Harness — per chat, in your currency, with live rates.

[![CI](https://github.com/OrstedOshua/dsh-api-cost/actions/workflows/ci.yml/badge.svg)](https://github.com/OrstedOshua/dsh-api-cost/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A DeepSeek Harness plugin that tracks **real API token cost** from usage data — separately for every chat — with configurable prices, currency & language selectors, and live exchange rates.

---

## Features

- **Per-chat cost** — listens to session events (`assistant/message` with provider-reported `usage`) and accumulates cost separately for every conversation.
- **Price freeze on use** — each token is billed at the prices in effect when the request happened; changing prices never rewrites already-spent amounts.
- **Session-header indicator** — shows the current chat's cost next to the context indicator; click to open a quick menu (prices, clear this chat, counting switch).
- **Daily spend chart** — a 20-day bar chart fills in as you spend, so you can see how much was spent each day.
- **Chat names** — chats are named like in DSH (with an inline rename option), so you don't stare at UUIDs.
- **Flexible prices** — set a price per 1M tokens for input, output and cache tokens.
- **Language** — Russian and English UI (selectable in settings).
- **Currency** — RUB / USD / EUR / CNY, with values converted at live rates.
- **Live rates** — exchange rates auto-loaded hourly from a free, open source (`open.er-api.com`).

## Screenshots

![Daily spend chart](assets/screenshot-1.png)
![Chats](assets/screenshot-2.png)

## Install

The package is a standard DSH bundle. Add it via the DSH plugin manager or the `/plugin-manager` command, then:

1. Enable the `dsh-api-cost` plugin.
2. Open **Settings → API Cost**: pick language and currency, set prices, save.

## Development

```bash
# syntax check
node --check lib/client.js
node --check lib/index.js

# tests
cd dsh-api-cost && npm test
```

State is stored in `$DSH_HOME/token-cost-state.json` (or `~/.dsh/token-cost-state.json`).

## License

MIT
