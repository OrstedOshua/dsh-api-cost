#!/usr/bin/env python3
"""Generate store assets for dsh-api-cost: icon-180.png + placeholder screenshots.

The icon is rendered from the design in icon.svg (rounded card + trend line + points)
at 180x180 with a brand gradient. Screenshots are lightweight UI mockups.
"""
import os
import math
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "assets")
os.makedirs(ASSETS, exist_ok=True)


def _font(size, bold=False):
    """Try common Windows UI fonts, fall back to PIL default."""
    candidates = []
    if bold:
        candidates = ["seguisb.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"]
    else:
        candidates = ["segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"]
    for name in candidates:
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def round_rect(draw, box, radius, **kw):
    draw.rounded_rectangle(box, radius=radius, **kw)


def gradient_v(size, top, bottom):
    w, h = size
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        for x in range(w):
            px[x, y] = (r, g, b)
    return img


def render_icon():
    S = 720  # supersampled
    img = gradient_v((S, S), (99, 102, 241), (139, 92, 246))
    d = ImageDraw.Draw(img)
    scale = S / 180.0

    def s(v):
        return int(v * scale)

    # Panel card
    card = (s(30), s(30), s(150), s(150))
    round_rect(d, card, s(20), fill=(255, 255, 255))

    # Bars (cost chart) - three rounded bars
    bars = [(s(52), s(116), s(66), s(132)), (s(88), s(96), s(102), s(132)),
            (s(124), s(74), s(138), s(132))]
    for x0, y0, x1, y1 in bars:
        round_rect(d, [x0, y0, x1, y1], s(4), fill=(79, 70, 229))

    # Trend line
    pts = [(s(54), s(120)), (s(90), s(102)), (s(126), s(84)), (s(142), s(76))]
    d.line(pts, fill=(15, 23, 42), width=s(3), joint="curve")
    for (x, y) in pts:
        d.ellipse([x - s(3), y - s(3), x + s(3), y + s(3)], fill=(15, 23, 42))
    return img.resize((180, 180), Image.LANCZOS)


def mock_window(W, H, title):
    """A light-themed app window mockup."""
    img = Image.new("RGB", (W, H), (245, 247, 250))
    d = ImageDraw.Draw(img)
    # Title bar
    d.rectangle([0, 0, W, 56], fill=(255, 255, 255))
    d.rectangle([0, 56, W, 57], fill=(226, 232, 240))
    f_title = _font(24, bold=True)
    d.text((24, 15), title, font=f_title, fill=(15, 23, 42))
    # Traffic dots
    d.ellipse([W - 96, 20, W - 78, 38], fill=(248, 113, 113))
    d.ellipse([W - 68, 20, W - 50, 38], fill=(251, 191, 36))
    d.ellipse([W - 40, 20, W - 22, 38], fill=(52, 211, 153))
    return img, d


def panel_card(d, x, y, w, h, heading):
    d.rounded_rectangle([x, y, x + w, y + h], radius=12, fill=(255, 255, 255))
    d.rounded_rectangle([x, y, x + w, y + h], radius=12,
                        outline=(226, 232, 240), width=2)
    d.text((x + 18, y + 14), heading, font=_font(20, bold=True),
           fill=(30, 41, 59))


def stat_box(d, x, y, w, h, label, value):
    d.rounded_rectangle([x, y, x + w, y + h], radius=10,
                        fill=(238, 242, 255))
    d.text((x + 14, y + 12), label, font=_font(16), fill=(100, 116, 139))
    d.text((x + 14, y + 38), value, font=_font(26, bold=True),
           fill=(79, 70, 229))


def bar_row(d, x, y, w, label, value, frac):
    d.text((x, y), label, font=_font(17), fill=(51, 65, 85))
    d.text((x + w - 120, y), value, font=_font(17, bold=True),
           fill=(15, 23, 42))
    d.rounded_rectangle([x, y + 30, x + w, y + 38], radius=4,
                        fill=(226, 232, 240))
    bw = int((w - 120) * frac)
    if bw > 8:
        d.rounded_rectangle([x, y + 30, x + bw, y + 38], radius=4,
                            fill=(79, 70, 229))


def screenshot_1():
    W, H = 1280, 800
    img, d = mock_window(W, H, "dsh-api-cost — Сводная статистика")
    panel_card(d, 40, 90, 1200, 200, "Статистика за период")
    stat_box(d, 70, 150, 260, 100, "Всего токенов", "1 284 052")
    stat_box(d, 360, 150, 260, 100, "Стоимость", "$0.423")
    stat_box(d, 650, 150, 260, 100, "Чатов", "42")
    stat_box(d, 940, 150, 260, 100, "Экономия кэша", "18%")
    panel_card(d, 40, 320, 1200, 300, "Расходы по чатам")
    rows = [("Личные заметки / исследование", "$0.142", 0.9),
            ("План миграции API", "$0.098", 0.6),
            ("Ревью кода", "$0.064", 0.4),
            ("Письмо клиенту", "$0.031", 0.2)]
    y = 390
    for label, value, frac in rows:
        bar_row(d, 70, y, 1140, label, value, frac)
        y += 58
    img.save(os.path.join(ASSETS, "screenshot-1.png"))


def screenshot_2():
    W, H = 1280, 800
    img, d = mock_window(W, H, "dsh-api-cost — Настройки цен")
    panel_card(d, 40, 90, 600, 400, "Цены за 1M токенов")
    fields = [("Входные токены", "$0.27"), ("Выходные токены", "$1.10"),
              ("Кэш входных", "$0.027"), ("Валюта", "USD")]
    y = 160
    for label, value in fields:
        d.text((70, y), label, font=_font(18), fill=(51, 65, 85))
        d.rounded_rectangle([70, y + 28, 560, y + 64], radius=8,
                            fill=(255, 255, 255),
                            outline=(203, 213, 225), width=2)
        d.text((84, y + 34), value, font=_font(20), fill=(15, 23, 42))
        y += 80
    panel_card(d, 680, 90, 560, 400, "Язык и оформление")
    d.text((710, 160), "Язык интерфейса", font=_font(18), fill=(51, 65, 85))
    d.rounded_rectangle([710, 188, 1200, 224], radius=8, fill=(255, 255, 255),
                        outline=(203, 213, 225), width=2)
    d.text((724, 194), "Русский", font=_font(20), fill=(15, 23, 42))
    d.text((710, 260), "Формат чисел", font=_font(18), fill=(51, 65, 85))
    d.rounded_rectangle([710, 288, 1200, 324], radius=8, fill=(255, 255, 255),
                        outline=(203, 213, 225), width=2)
    d.text((724, 294), "1 234 567.89", font=_font(20), fill=(15, 23, 42))
    img.save(os.path.join(ASSETS, "screenshot-2.png"))


def screenshot_3():
    W, H = 1280, 800
    img, d = mock_window(W, H, "dsh-api-cost — История чатов")
    panel_card(d, 40, 90, 1200, 560, "Топ-200 чатов по стоимости")
    rows = [("2026-11-16 · Личные заметки", "$0.142", "512 300"),
            ("2026-11-16 · План миграции", "$0.098", "410 112"),
            ("2026-11-15 · Ревью кода", "$0.064", "288 904"),
            ("2026-11-15 · Письмо клиенту", "$0.031", "120 640"),
            ("2026-11-14 · Настройка API", "$0.022", "88 312")]
    y = 170
    for label, value, toks in rows:
        d.rounded_rectangle([70, y, 1140, y + 72], radius=10,
                            fill=(255, 255, 255),
                            outline=(226, 232, 240), width=2)
        d.text((94, y + 24), label, font=_font(19), fill=(30, 41, 59))
        d.text((1040, y + 24), toks, font=_font(18), fill=(100, 116, 139))
        d.text((1140 - 160, y + 24), value, font=_font(19, bold=True),
               fill=(79, 70, 229))
        y += 92
    img.save(os.path.join(ASSETS, "screenshot-3.png"))


def screenshot_4():
    W, H = 1280, 800
    img, d = mock_window(W, H, "dsh-api-cost — Экспорт / Импорт")
    panel_card(d, 40, 90, 580, 320, "Экспорт")
    d.rounded_rectangle([70, 170, 560, 260], radius=12, fill=(238, 242, 255))
    d.text((100, 198), "Скачать JSON (настройки + статистика)",
           font=_font(20, bold=True), fill=(79, 70, 229))
    panel_card(d, 660, 90, 580, 320, "Импорт")
    d.rounded_rectangle([690, 170, 1180, 260], radius=12, fill=(238, 242, 255))
    d.text((720, 198), "Загрузить JSON-файл", font=_font(20, bold=True),
           fill=(79, 70, 229))
    img.save(os.path.join(ASSETS, "screenshot-4.png"))


def screenshot_5():
    W, H = 1280, 800
    img, d = mock_window(W, H, "dsh-api-cost — Уведомления")
    panel_card(d, 40, 90, 1200, 360, "Детали тумблера уведомлений")
    toggles = [("Показывать уведомление при высоком расходе (> $0.50)", True),
                ("Включать звук", False),
                ("Показывать в статус-баре", True)]
    y = 170
    for label, on in toggles:
        d.text((70, y), label, font=_font(20), fill=(30, 41, 59))
        x0, y0 = 1080, y
        track = (x0, y0, x0 + 64, y0 + 32)
        if on:
            d.rounded_rectangle(track, radius=16, fill=(79, 70, 229))
            d.ellipse([x0 + 36, y0 + 2, x0 + 62, y0 + 30], fill=(255, 255, 255))
        else:
            d.rounded_rectangle(track, radius=16, fill=(203, 213, 225))
            d.ellipse([x0 + 2, y0 + 2, x0 + 28, y0 + 30], fill=(255, 255, 255))
        y += 80
    d.text((70, 430), "Порог уведомления",
           font=_font(20, bold=True), fill=(30, 41, 59))
    d.rounded_rectangle([70, 460, 560, 500], radius=8, fill=(255, 255, 255),
                        outline=(203, 213, 225), width=2)
    d.text((84, 466), "$0.50", font=_font(20), fill=(15, 23, 42))
    img.save(os.path.join(ASSETS, "screenshot-5.png"))


def screenshot_6():
    W, H = 1280, 800
    img, d = mock_window(W, H, "dsh-api-cost — Очистка")
    panel_card(d, 40, 90, 1200, 320, "Пакетная очистка чатов")
    d.rounded_rectangle([70, 180, 1170, 300], radius=12, fill=(254, 242, 242),
                        outline=(254, 202, 202), width=2)
    d.text((100, 210), "Очистить все чаты (42) и обнулить статистику",
           font=_font(22, bold=True), fill=(220, 38, 38))
    d.rounded_rectangle([1040, 200, 1140, 276], radius=10, fill=(220, 38, 38))
    d.text((1062, 228), "Очистить", font=_font(20, bold=True),
           fill=(255, 255, 255))
    img.save(os.path.join(ASSETS, "screenshot-6.png"))


render_icon().save(os.path.join(ASSETS, "icon-180.png"))
screenshot_1()
screenshot_2()
screenshot_3()
screenshot_4()
screenshot_5()
screenshot_6()
print("done")
