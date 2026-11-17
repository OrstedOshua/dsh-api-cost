# dsh-api-cost

A DeepSeek Harness plugin that tracks API token cost from real usage data,
per chat, with configurable prices, currency + language selectors, and live
exchange rates.

## Features

- **Per-chat cost** — listens to session events (`assistant/message` with the
  provider-reported `usage`) and accumulates cost separately for every chat.
- **Price freeze on use** — each token is billed at the prices in effect when
  the request happened; changing prices never rewrites already-spent amounts.
- **Session-header indicator** — shows the current chat's cost next to the
  context indicator; click opens a menu (prices, clear this chat, counting
  switch).
- **Flexible prices** — set a price per 1M tokens separately for input,
  output and cache tokens.
- **Language** — Russian and English UI (selectable in settings).
- **Currency** — RUB / USD / EUR / CNY (selectable in settings).
- **Live rates** — exchange rates auto-loaded hourly from a free, open source
  (`open.er-api.com`) and shown in settings.

## Install

The package is a standard DSH bundle. Add it from its source (npm package or
GitHub): use the DSH plugin manager or the `/plugin-manager` command. After
installation:

1. Enable the `dsh-api-cost` plugin.
2. Open **Settings → API Cost**: pick language and currency, set prices, save.

## Development

```bash
# syntax check
node --check lib/client.js
node --check lib/index.js
```

State is stored in `$DSH_HOME/token-cost-state.json` (or
`~/.dsh/token-cost-state.json`).

## License

MIT
