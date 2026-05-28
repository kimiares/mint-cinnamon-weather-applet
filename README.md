# Mint Cinnamon Weather Applet

Cinnamon-апплет для **Linux Mint**, показывающий прогноз погоды **на 7 дней** в виде таблицы.  
Данные — [Open-Meteo](https://open-meteo.com/) (бесплатно, без API-ключа).

## Что показывает таблица

| Колонка  | Описание |
|----------|----------|
| День     | День недели + дата |
| Погода   | Текстовое описание (Ясно, Дождь, …) |
| Темп.    | Максимум / минимум, °C |
| Ветер    | Макс. скорость (км/ч) + стрелка направления |
| Влажн.   | Средняя влажность за день, % |
| Облачн.  | Средняя облачность за день, % |

Текущий день выделяется цветом. Иконка в панели меняется по типу погоды.

## Установка

```bash
# 1. Скопировать папку апплета
mkdir -p ~/.local/share/cinnamon/applets
cp -r /path/to/mint-cinnamon-weather-applet \
      ~/.local/share/cinnamon/applets/mint-weather@copilot

# 2. Скомпилировать GSettings-схему
glib-compile-schemas ~/.local/share/cinnamon/applets/mint-weather@copilot/schemas

# 3. В настройках Cinnamon → Апплеты → добавить «Mint Weather»
```

## Настройка

Откройте настройки апплета (правый клик → «Настройки»):

| Параметр        | По умолчанию | Описание |
|-----------------|-------------|----------|
| Latitude        | 55.7558     | Широта вашего города |
| Longitude       | 37.6173     | Долгота вашего города |
| Timezone        | auto        | Часовой пояс (`auto` определяет автоматически) |
| City name       | Moscow      | Название города — только для отображения в заголовке |
| Refresh interval| 600 с       | Интервал обновления данных |

Координаты города можно найти на [latlong.net](https://www.latlong.net/) или в Google Maps.

## Зависимости

- `gjs` (входит в Cinnamon)
- `libsoup` (входит в Linux Mint) — для HTTP; при отсутствии используется `curl`
- `glib-compile-schemas` (пакет `libglib2.0-dev-bin`)

## Требования

Cinnamon 3.0+, Linux Mint 19+.

## Важное правило безопасности

ВНИМАНИЕ: Copilot и автоматические агенты не должны выполнять git commit или git push в этом репозитории без вашего явного письменного разрешения. Я подготовил/а это изменение в README, но не буду его коммитить или пушить без отдельного согласия.


---

Job search scraper

A simple standalone Python scraper was added at jobs/scrape_jobs.py to extract job listings from:
- https://djinni.co/jobs/?primary_keyword=.NET
- https://www.work.ua/jobs-net-developer/
- https://robota.ua/zapros/net-developer/ukraine

Usage:
  python3 jobs/scrape_jobs.py --query ".NET"

Requirements:
  pip install -r jobs/requirements.txt

Notes:
- This is a best-effort extractor; selectors are generic. Improve parsers for more accurate results.
- No git commits or new branch were created — awaiting explicit approval to create a branch and commit the changes.


