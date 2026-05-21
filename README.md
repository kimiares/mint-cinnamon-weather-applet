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

