// dsh-api-cost client bundle.
//  - A session-header indicator (right-aligned utility) shows the current
//    chat's accumulated cost. Clicking it opens a small menu (prices, clear
//    this chat, toggle counting) rendered through a portal onto document.body.
//  - A settings section shows prices, the global counting switch, language and
//    currency selectors, live exchange rates, and a list of tracked chats with
//    per-chat clear buttons.
//  - UI language (ru/en) and currency (RUB/USD/EUR/CNY) are stored on the host
//    and applied here; rates are fetched on the host and shown for reference.
// Hand-written __ModuleLoader__ factory (no build step). External requires are
// react + react-dom, which the loader module table provides.
window.__ModuleLoader__.load({ id: "dsh-api-cost", factory: (require) => {

	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	let react = require("react");
	let reactDom = require("react-dom");
	const h = react.createElement;
	const { useState, useEffect, useCallback, useRef } = react;
	const { createPortal } = reactDom;

	const NS = "api-cost";
	const inject = ["slots", "locale"];

	const API_PATH = "/api/token-cost";

	const LANGUAGES = [
		{ id: "ru", label: "Русский" },
		{ id: "en", label: "English" },
	];
	const CURRENCIES = [
		{ id: "RUB", symbol: "₽" },
		{ id: "USD", symbol: "$" },
		{ id: "EUR", symbol: "€" },
		{ id: "CNY", symbol: "¥" },
	];

	// Currency-aware, never-throwing money formatter.
	function fmtMoney(n, currency, language, decimals) {
		const code = currency || "RUB";
		const locale = language === "ru" ? "ru-RU" : "en-US";
		try {
			const nf = new Intl.NumberFormat(locale, {
				style: "currency",
				currency: code,
				maximumFractionDigits: decimals ? 2 : 0,
			});
			return nf.format(Number.isFinite(n) ? n : 0);
		} catch {
			try {
				const sym = (CURRENCIES.find((c) => c.id === code) || {}).symbol || code;
				const m = Number.isFinite(n) ? n : 0;
				return (decimals ? m.toFixed(2) : m.toFixed(0)) + " " + sym;
			} catch {
				return "?";
			}
		}
	}

	function safeT(t, key, params) {
		try {
			const r = t(key, params);
			return typeof r === "string" ? r : String(r === undefined || r === null ? key : r);
		} catch {
			return String(key);
		}
	}

	const DICTS = {
		ru: {
			label: "Стоимость токенов",
			desc: "Стоимость токенов: цены, валюта, язык, подсчёт и список чатов.",
			loading: "Загрузка…",
			todayTitle: "Стоимость этого чата",
			languageTitle: "Язык",
			currencyTitle: "Валюта",
			pricesTitle: "Цены за 1 млн токенов",
			priceInput: "Входные",
			priceOutput: "Выходные",
			priceCache: "Кэш",
			enabledLabel: "Подсчёт включён",
			enabledOn: "Включён",
			enabledOff: "Выключён",
			save: "Сохранить",
			saving: "Сохранение…",
			saved: "Сохранено",
			saveError: "Ошибка сохранения: {error}",
			readError: "Не удалось загрузить данные: {error}",
			unknownError: "Неизвестная ошибка",
			authFailed: "Сессия не прошла авторизацию. Обновите страницу.",
			sessionsTitle: "Чаты",
			sessionsEmpty: "Чатов с зафиксированным расходом пока нет.",
			clearChat: "Очистить",
			cleared: "Очищено",
			actionError: "Ошибка: {error}",
			ratesTitle: "Курсы валют (1 USD)",
			ratesAuto: "Обновляются автоматически раз в час из открытого источника.",
			ratesUnavailable: "Курсы временно недоступны.",
			// Menu
			menuPrices: "Цены",
			menuClear: "Очистить стоимость чата",
			menuCounting: "Подсчёт",
			offBadge: "выкл",
		},
		en: {
			label: "Token Cost",
			desc: "Token cost: prices, currency, language, counting and a chat list.",
			loading: "Loading…",
			todayTitle: "This chat's cost",
			languageTitle: "Language",
			currencyTitle: "Currency",
			pricesTitle: "Prices per 1M tokens",
			priceInput: "Input",
			priceOutput: "Output",
			priceCache: "Cache",
			enabledLabel: "Counting enabled",
			enabledOn: "Enabled",
			enabledOff: "Disabled",
			save: "Save",
			saving: "Saving…",
			saved: "Saved",
			saveError: "Save failed: {error}",
			readError: "Failed to load data: {error}",
			unknownError: "Unknown error",
			authFailed: "Session authentication failed, please refresh.",
			sessionsTitle: "Chats",
			sessionsEmpty: "No chats with recorded spend yet.",
			clearChat: "Clear",
			cleared: "Cleared",
			actionError: "Error: {error}",
			ratesTitle: "Exchange rates (1 USD)",
			ratesAuto: "Auto-refreshed hourly from a free open source.",
			ratesUnavailable: "Rates temporarily unavailable.",
			menuPrices: "Prices",
			menuClear: "Clear this chat's cost",
			menuCounting: "Counting",
			offBadge: "off",
		},
	};

	// Translator for a chosen language (ru/en), independent of the host locale.
	function makeT(language) {
		const dict = DICTS[language] || DICTS.ru;
		return (key, params) => {
			try {
				const template = dict[key] !== undefined ? dict[key] : String(key);
				if (params && typeof template === "string") {
					let out = template;
					for (const k of Object.keys(params)) {
						out = out.split("{" + k + "}").join(String(params[k]));
					}
					return out;
				}
				return template;
			} catch {
				return String(key);
			}
		};
	}

	function failureCode(res) {
		return res.status === 401 || res.status === 403 ? "authFailed" : "HTTP " + res.status;
	}

	const MENU_CSS = [
		".dtc-menu {",
		"  position: fixed;",
		"  z-index: 9990;",
		"  min-width: 240px;",
		"  background: var(--dsw-alias-surface-float);",
		"  border: 1px solid var(--dsw-alias-border-l4);",
		"  border-radius: var(--dsw-radius-md);",
		"  box-shadow: 0 8px 24px rgba(0,0,0,0.18);",
		"  padding: 6px;",
		"  font-size: 13px;",
		"  line-height: 20px;",
		"  color: inherit;",
		"}",
		".dtc-menu-item {",
		"  display: flex;",
		"  align-items: center;",
		"  gap: 8px;",
		"  padding: 6px 10px;",
		"  border-radius: var(--dsw-radius-sm);",
		"  cursor: pointer;",
		"  user-select: none;",
		"  white-space: nowrap;",
		"}",
		".dtc-menu-item:hover {",
		"  background: var(--dsw-alias-fill-hover);",
		"}",
		".dtc-menu-label {",
		"  opacity: 0.7;",
		"  padding: 4px 10px 2px;",
		"  font-size: 12px;",
		"  text-transform: uppercase;",
		"  letter-spacing: 0.04em;",
		"}",
		".dtc-menu-divider {",
		"  height: 1px;",
		"  margin: 4px 6px;",
		"  background: var(--dsw-alias-border-l2);",
		"}",
		".dtc-menu-note {",
		"  padding: 4px 10px;",
		"  opacity: 0.75;",
		"  font-size: 12px;",
		"}",
		".dtc-menu-row {",
		"  display: flex;",
		"  align-items: center;",
		"  justify-content: space-between;",
		"  gap: 12px;",
		"  padding: 6px 10px;",
		"}",
		".dtc-toggle {",
		"  position: relative;",
		"  width: 42px;",
		"  height: 24px;",
		"  border-radius: 999px;",
		"  border: 0.5px solid var(--dsw-alias-border-l4);",
		"  background: var(--dsw-alias-fill-hover);",
		"  cursor: pointer;",
		"  padding: 0;",
		"  transition: background 0.15s ease;",
		"  flex-shrink: 0;",
		"}",
		".dtc-toggle::after {",
		"  content: \"\";",
		"  position: absolute;",
		"  top: 2px;",
		"  left: 2px;",
		"  width: 18px;",
		"  height: 18px;",
		"  border-radius: 999px;",
		"  background: var(--dsw-alias-label-primary-foreground);",
		"  transition: transform 0.15s ease;",
		"}",
		".dtc-toggle[aria-checked=\"true\"] {",
		"  background: var(--dsw-alias-state-success-primary);",
		"}",
		".dtc-toggle[aria-checked=\"true\"]::after { transform: translateX(18px); }",
		".dtc-toggle:focus-visible { outline: 2px solid var(--dsw-alias-border-accent); outline-offset: 2px; }",
		".dtc-chip {",
		"  background: transparent;",
		"  border: none;",
		"  cursor: pointer;",
		"  color: inherit;",
		"  opacity: 0.75;",
		"  font-size: 12px;",
		"  line-height: 20px;",
		"  padding: 0 2px;",
		"  white-space: nowrap;",
		"  user-select: none;",
		"  display: inline-flex;",
		"  align-items: center;",
		"  gap: 4px;",
		"}",
		".dtc-chip:hover {",
		"  opacity: 1;",
		"}",
		".dtc-chip-off {",
		"  opacity: 0.45;",
		"  text-decoration: line-through;",
		"}",
	].join("\n");

	// ---------------------------------------------------- session header indicator
	function TokenCostChip(props) {
		const [language, setLanguage] = useState("ru");
		const [currency, setCurrency] = useState("RUB");
		const t = makeT(language);
		const [cost, setCost] = useState(null);
		const [enabled, setEnabled] = useState(true);
		const [prices, setPrices] = useState(null);
		const [open, setOpen] = useState(false);
		const [pos, setPos] = useState(null);
		const [notice, setNotice] = useState(null);
		const rootRef = useRef(null);
		const panelRef = useRef(null);

		useEffect(() => {
			let cancelled = false;
			const sessionId = props.sessionId;
			if (!sessionId) return () => { cancelled = true; };
			fetch(API_PATH + "?session=" + encodeURIComponent(sessionId), { cache: "no-store" })
				.then((res) => (res.ok ? res.json() : null))
				.then((json) => {
					if (cancelled || !json) return;
					try {
						setLanguage(json.language === "en" ? "en" : "ru");
						setCurrency(CURRENCIES.some((c) => c.id === json.currency) ? json.currency : "RUB");
						setCost(Number(json.session?.costRub) || 0);
						setEnabled(Boolean(json.enabled));
						setPrices({
							input: Number(json.prices?.input) || 0,
							output: Number(json.prices?.output) || 0,
							cache: Number(json.prices?.cache) || 0,
						});
					} catch { /* keep last known */ }
				})
				.catch(() => {});
			return () => { cancelled = true; };
		}, [props.sessionId]);

		const post = useCallback((body) => {
			return fetch(API_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}).then(async (res) => {
				const json = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(json.error || failureCode(res));
				return json;
			});
		}, []);

		const toggle = useCallback(() => {
			if (!open && rootRef.current) {
				try {
					const r = rootRef.current.getBoundingClientRect();
					const menuWidth = 280;
					const left = Math.max(8, r.left - menuWidth);
					const top = r.bottom + 4;
					setPos({ left, top });
				} catch {
					setPos({ left: 8, top: 0 });
				}
			}
			setOpen((prev) => !prev);
		}, [open]);

		useEffect(() => {
			if (!open) return;
			const onDown = (e) => {
				try {
					if (panelRef.current && panelRef.current.contains(e.target)) return;
					if (rootRef.current && rootRef.current.contains(e.target)) return;
					setOpen(false);
				} catch {
					setOpen(false);
				}
			};
			const onKey = (e) => {
				if (e.key === "Escape") setOpen(false);
			};
			document.addEventListener("mousedown", onDown);
			document.addEventListener("keydown", onKey);
			return () => {
				document.removeEventListener("mousedown", onDown);
				document.removeEventListener("keydown", onKey);
			};
		}, [open]);

		const doClear = useCallback(() => {
			post({ action: "clearSession", session: props.sessionId })
				.then(() => {
					setCost(0);
					setNotice({ kind: "ok", text: safeT(t, "cleared") });
				})
				.catch((e) => setNotice({ kind: "error", text: safeT(t, "actionError", { error: e.message }) }));
		}, [post, props.sessionId, t]);

		const doToggle = useCallback(() => {
			post({ action: "setEnabled", enabled: !enabled })
				.then((json) => {
					setEnabled(Boolean(json.enabled));
					setNotice({ kind: "ok", text: json.enabled ? safeT(t, "enabledOn") : safeT(t, "enabledOff") });
				})
				.catch((e) => setNotice({ kind: "error", text: safeT(t, "actionError", { error: e.message }) }));
		}, [post, enabled, t]);

		const display = cost === null ? "–" : fmtMoney(cost, currency, language, true);
		const priceLine = prices
			? safeT(t, "priceInput") + ": " + fmtMoney(prices.input, currency, language)
				+ " · " + safeT(t, "priceOutput") + ": " + fmtMoney(prices.output, currency, language)
				+ " · " + safeT(t, "priceCache") + ": " + fmtMoney(prices.cache, currency, language)
			: "";

		return h("span", { ref: rootRef, style: { position: "relative", display: "inline-flex", alignItems: "center" } },
			h("style", null, MENU_CSS),
			h("button", {
				type: "button",
				className: "dtc-chip" + (enabled ? "" : " dtc-chip-off"),
				title: safeT(t, "todayTitle"),
				"aria-haspopup": "dialog",
				"aria-expanded": open,
				disabled: !props.sessionId,
				onClick: toggle,
			}, display),
			open && pos
				? createPortal(
					h("div", {
						ref: panelRef,
						className: "dtc-menu",
						role: "dialog",
						"data-api-cost-menu": "",
						style: { left: pos.left, top: pos.top },
					},
						h("div", { className: "dtc-menu-label" }, safeT(t, "menuPrices")),
						h("div", { className: "dtc-menu-note" }, priceLine),
						h("div", { className: "dtc-menu-divider" }),
						h("div", {
							className: "dtc-menu-item",
							onClick: () => { doClear(); setOpen(false); },
						}, safeT(t, "menuClear")),
						h("div", { className: "dtc-menu-row" },
							h("span", null, safeT(t, "menuCounting")),
							h("button", {
								type: "button",
								role: "switch",
								className: "dtc-toggle",
								"aria-checked": enabled ? "true" : "false",
								"aria-label": safeT(t, "menuCounting"),
								onClick: doToggle,
							}),
						),
						notice
							? h("div", {
								className: "dtc-menu-note",
								style: notice.kind === "error" ? { color: "var(--dsw-alias-state-error-primary)" } : undefined,
							}, notice.text)
							: null,
					),
					document.body,
				)
				: null,
		);
	}

	// ------------------------------------------------------------ settings section
	function TokenCostSection(props) {
		const [language, setLanguage] = useState("ru");
		const [currency, setCurrency] = useState("RUB");
		const t = makeT(language);
		const [loaded, setLoaded] = useState(false);
		const [enabled, setEnabled] = useState(true);
		const [prices, setPrices] = useState({ input: 0, output: 0, cache: 0 });
		const [sessions, setSessions] = useState([]);
		const [rates, setRates] = useState(null);
		const [saving, setSaving] = useState(false);
		const [notice, setNotice] = useState({ kind: "idle" });
		const [clearedId, setClearedId] = useState(null);

		const load = useCallback(() => {
			let cancelled = false;
			fetch(API_PATH, { cache: "no-store" })
				.then((res) => {
					if (!res.ok) throw new Error(failureCode(res));
					return res.json();
				})
				.then((json) => {
					if (cancelled) return;
					setLanguage(json.language === "en" ? "en" : "ru");
					setCurrency(CURRENCIES.some((c) => c.id === json.currency) ? json.currency : "RUB");
					setEnabled(Boolean(json.enabled));
					setPrices({
						input: Number(json.prices?.input) || 0,
						output: Number(json.prices?.output) || 0,
						cache: Number(json.prices?.cache) || 0,
					});
					setSessions(Array.isArray(json.sessions) ? json.sessions : []);
					setRates(json.rates && typeof json.rates === "object" ? json.rates : null);
					setLoaded(true);
				})
				.catch((error) => {
					if (cancelled) return;
					setNotice({ kind: "error", key: "readError", errorParam: error.message });
					setLoaded(true);
				});
			return () => { cancelled = true; };
		}, []);

		useEffect(() => { load(); }, [load]);

		const post = useCallback((body) => {
			return fetch(API_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}).then(async (res) => {
				const json = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(json.error || failureCode(res));
				return json;
			});
		}, []);

		const savePrices = useCallback(() => {
			setSaving(true);
			setNotice({ kind: "idle" });
			post({ action: "setPrices", prices })
				.then((json) => {
					setPrices({
						input: Number(json.prices?.input) || 0,
						output: Number(json.prices?.output) || 0,
						cache: Number(json.prices?.cache) || 0,
					});
					setNotice({ kind: "ok", key: "saved" });
				})
				.catch((error) => setNotice({ kind: "error", key: "saveError", errorParam: error.message }))
				.finally(() => setSaving(false));
		}, [prices, post]);

		const toggleEnabled = useCallback(() => {
			post({ action: "setEnabled", enabled: !enabled })
				.then((json) => setEnabled(Boolean(json.enabled)))
				.catch((error) => setNotice({ kind: "error", key: "saveError", errorParam: error.message }));
		}, [post, enabled]);

		const applyLanguage = useCallback((lang) => {
			post({ action: "setLanguage", language: lang })
				.then((json) => setLanguage(json.language === "en" ? "en" : "ru"))
				.catch((error) => setNotice({ kind: "error", key: "saveError", errorParam: error.message }));
		}, [post]);

		const applyCurrency = useCallback((cur) => {
			post({ action: "setCurrency", currency: cur })
				.then((json) => setCurrency(CURRENCIES.some((c) => c.id === json.currency) ? json.currency : "RUB"))
				.catch((error) => setNotice({ kind: "error", key: "saveError", errorParam: error.message }));
		}, [post]);

		const clearChat = useCallback((sessionId) => {
			post({ action: "clearSession", session: sessionId })
				.then(() => {
					setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
					setClearedId(sessionId);
				})
				.catch((error) => setNotice({ kind: "error", key: "actionError", errorParam: error.message }));
		}, [post]);

		const setP = (key) => (e) => {
			const v = e.target.value.replace(",", ".");
			const n = Number(v);
			setPrices((prev) => ({ ...prev, [key]: Number.isFinite(n) && n >= 0 ? n : 0 }));
		};

		const errorText = (param) =>
			!param ? t("unknownError") : param === "authFailed" ? t("authFailed") : param;

		const CARD_STYLE = {
			border: "0.5px solid var(--dsw-alias-border-l4)",
			borderRadius: "var(--dsw-radius-md)",
			padding: "14px 16px",
			marginBottom: "16px",
		};
		const ROW_STYLE = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: "12px",
			padding: "6px 0",
			borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
		};
		const LABEL_STYLE = { color: "inherit", opacity: 0.75, fontSize: "13px" };
		const INPUT_STYLE = {
			width: "110px",
			boxSizing: "border-box",
			padding: "4px 8px",
			fontSize: "13px",
			background: "transparent",
			color: "inherit",
			border: "0.5px solid var(--dsw-alias-border-l4)",
			borderRadius: "var(--dsw-radius-sm)",
		};
		const BUTTON_CSS = [
			".dtc-btn {",
			"  box-sizing: border-box;",
			"  display: inline-flex;",
			"  align-items: center;",
			"  justify-content: center;",
			"  gap: 4px;",
			"  height: 32px;",
			"  padding: 0 12px;",
			"  border: none;",
			"  border-radius: var(--dsw-radius-md);",
			"  cursor: pointer;",
			"  font-size: 13px;",
			"  line-height: 20px;",
			"  background: var(--dsw-alias-button-primary-fill);",
			"  color: var(--dsw-alias-label-primary-foreground);",
			"}",
			".dtc-btn:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }",
			".dtc-btn:disabled { cursor: not-allowed; opacity: 0.4; }",
			".dtc-btn-ghost {",
			"  background: transparent;",
			"  color: inherit;",
			"  opacity: 0.75;",
			"  border: 0.5px solid var(--dsw-alias-border-l4);",
			"}",
			".dtc-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-fill-hover); opacity: 1; }",
			".dtc-seg {",
			"  display: inline-flex;",
			"  align-items: center;",
			"  justify-content: center;",
			"  min-width: 52px;",
			"  height: 32px;",
			"  padding: 0 12px;",
			"  border: 0.5px solid var(--dsw-alias-border-l4);",
			"  background: transparent;",
			"  color: inherit;",
			"  opacity: 0.7;",
			"  font-size: 13px;",
			"  line-height: 20px;",
			"  cursor: pointer;",
			"  user-select: none;",
			"}",
			".dtc-seg:first-child { border-radius: var(--dsw-radius-md) 0 0 var(--dsw-radius-md); }",
			".dtc-seg:last-child { border-radius: 0 var(--dsw-radius-md) var(--dsw-radius-md) 0; }",
			".dtc-seg + .dtc-seg { margin-left: -0.5px; }",
			".dtc-seg:hover:not(:disabled) { background: var(--dsw-alias-fill-hover); opacity: 1; }",
			".dtc-seg-active {",
			"  background: var(--dsw-alias-button-primary-fill);",
			"  color: var(--dsw-alias-label-primary-foreground);",
			"  opacity: 1;",
			"}",
			".dtc-toggle {",
			"  position: relative;",
			"  width: 42px;",
			"  height: 24px;",
			"  border-radius: 999px;",
			"  border: 0.5px solid var(--dsw-alias-border-l4);",
			"  background: var(--dsw-alias-fill-hover);",
			"  cursor: pointer;",
			"  padding: 0;",
			"  transition: background 0.15s ease;",
			"  flex-shrink: 0;",
			"}",
			".dtc-toggle::after {",
			"  content: \"\";",
			"  position: absolute;",
			"  top: 2px;",
			"  left: 2px;",
			"  width: 18px;",
			"  height: 18px;",
			"  border-radius: 999px;",
			"  background: var(--dsw-alias-label-primary-foreground);",
			"  transition: transform 0.15s ease;",
			"}",
			".dtc-toggle[aria-checked=\"true\"] {",
			"  background: var(--dsw-alias-state-success-primary);",
			"}",
			".dtc-toggle[aria-checked=\"true\"]::after { transform: translateX(18px); }",
			".dtc-toggle:focus-visible { outline: 2px solid var(--dsw-alias-border-accent); outline-offset: 2px; }",
		].join("\n");

		const numField = (key, label) =>
			h("div", { style: ROW_STYLE, key: key },
				h("span", { style: LABEL_STYLE }, label + " (" + fmtMoney(1, currency, language) + ")"),
				h("input", { style: INPUT_STYLE, type: "number", min: 0, step: "0.01", value: prices[key], onChange: setP(key) }),
			);

		const seg = (items, active, onPick) =>
			h("div", { style: { display: "inline-flex" } },
				items.map((it) =>
					h("button", {
						key: it.id,
						type: "button",
						className: "dtc-seg" + (active === it.id ? " dtc-seg-active" : ""),
						"aria-pressed": active === it.id ? "true" : "false",
						onClick: () => onPick(it.id),
					}, it.label || it.symbol),
				),
			);

		const ratesRows = rates
			? CURRENCIES.filter((c) => c.id !== "USD").map((c) =>
				h("div", { style: { ...ROW_STYLE, borderBottom: "none" }, key: c.id },
					h("span", { style: LABEL_STYLE }, "1 USD → " + c.symbol),
					h("span", { style: { fontSize: "13px" } }, Number(rates[c.id] || 0).toFixed(4)),
				),
			)
			: null;

		return h("div", { style: { maxWidth: "720px" } },
			h("style", null, BUTTON_CSS),
			h("p", { style: { marginTop: 0, opacity: 0.75, fontSize: "13px" } }, t("desc")),

			// Language
			h("div", { style: CARD_STYLE },
				h("div", { style: { fontWeight: 600, marginBottom: "8px" } }, t("languageTitle")),
				!loaded
					? h("p", { style: { opacity: 0.6 } }, t("loading"))
					: seg(LANGUAGES, language, applyLanguage),
			),

			// Currency
			h("div", { style: CARD_STYLE },
				h("div", { style: { fontWeight: 600, marginBottom: "8px" } }, t("currencyTitle")),
				!loaded
					? h("p", { style: { opacity: 0.6 } }, t("loading"))
					: seg(CURRENCIES, currency, applyCurrency),
			),

			// Rates
			h("div", { style: CARD_STYLE },
				h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, t("ratesTitle")),
				h("p", { style: { marginTop: 0, opacity: 0.6, fontSize: "12px" } }, t("ratesAuto")),
				!loaded
					? h("p", { style: { opacity: 0.6 } }, t("loading"))
					: rates === null
						? h("p", { style: { opacity: 0.6 } }, t("ratesUnavailable"))
						: h("div", null, ratesRows),
			),

			// Enabled switch
			h("div", { style: CARD_STYLE },
				h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, t("enabledLabel")),
				!loaded
					? h("p", { style: { opacity: 0.6 } }, t("loading"))
					: h("div", { style: { ...ROW_STYLE, borderBottom: "none" } },
						h("span", { style: LABEL_STYLE }, enabled ? t("enabledOn") : t("enabledOff")),
						h("button", {
							type: "button",
							role: "switch",
							className: "dtc-toggle",
							"aria-checked": enabled ? "true" : "false",
							"aria-label": t("enabledLabel"),
							onClick: toggleEnabled,
						}),
					),
			),

			// Prices
			h("div", { style: CARD_STYLE },
				h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, t("pricesTitle")),
				numField("input", t("priceInput")),
				numField("output", t("priceOutput")),
				numField("cache", t("priceCache")),
				h("div", { style: { display: "flex", alignItems: "center", gap: "12px", marginTop: "12px" } },
					h("button", { className: "dtc-btn", disabled: saving, onClick: savePrices },
						saving ? t("saving") : t("save")),
					notice.kind === "ok"
						? h("span", { style: { fontSize: "13px", opacity: 0.85 } }, t(notice.key))
						: notice.kind === "error"
							? h("span", { style: { fontSize: "13px", color: "var(--dsw-alias-state-error-primary)" } }, t(notice.key, { error: errorText(notice.errorParam) }))
							: null,
				),
			),

			// Chats
			h("div", { style: CARD_STYLE },
				h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, t("sessionsTitle")),
				!loaded
					? h("p", { style: { opacity: 0.6 } }, t("loading"))
					: sessions.length === 0
						? h("p", { style: { opacity: 0.6 } }, t("sessionsEmpty"))
						: sessions.map((s) =>
							h("div", { style: ROW_STYLE, key: s.sessionId },
								h("div", { style: { display: "flex", flexDirection: "column", minWidth: 0 } },
									h("span", { style: { fontSize: "12px", opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, s.sessionId),
									h("span", { style: { fontSize: "13px" } },
										fmtMoney(s.costRub, currency, language, true) + " · " + fmtMoney(s.inputTokens + s.outputTokens, currency, language) + " tok"),
								),
								h("button", {
									className: "dtc-btn dtc-btn-ghost",
									onClick: () => clearChat(s.sessionId),
								}, clearedId === s.sessionId ? t("cleared") : t("clearChat")),
							),
						),
			),
		);
	}

	function apply(ctx) {
		ctx.effect(() => ctx.locale.register(NS, DICTS), "api-cost: dictionaries");
		const t = makeT("ru");
		ctx.slots.inject("settings.section", () => ctx.slots.register({
			name: "settings.section",
			id: "api-cost",
			order: 40,
			locale: NS,
			label: () => t("label"),
		}, TokenCostSection));
		ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
			name: "conversation.session.header.utilities",
			id: "api-cost",
			order: 40,
			locale: NS,
			label: () => t("label"),
		}, TokenCostChip));
	}

	exports.name = NS;
	exports.inject = inject;
	exports.apply = apply;
	exports.DICTS = DICTS;
	return module.exports;
}
});
