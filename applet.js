const Applet      = imports.ui.applet;
const PopupMenu   = imports.ui.popupMenu;
const St          = imports.gi.St;
const GLib        = imports.gi.GLib;
const Gio         = imports.gi.Gio;
const Lang        = imports.lang;
const ByteArray   = imports.byteArray;

let Soup;
try { Soup = imports.gi.Soup; } catch (e) { Soup = null; }

// ── Weather code → human label + panel icon name ──────────────────────────
const WMO_ICONS = {
    0:  ['weather-clear',         'Ясно'],
    1:  ['weather-few-clouds',    'Малооблачно'],
    2:  ['weather-clouds',        'Облачно'],
    3:  ['weather-overcast',      'Пасмурно'],
    45: ['weather-fog',           'Туман'],
    48: ['weather-fog',           'Туман с изморозью'],
    51: ['weather-showers-scattered', 'Лёгкая морось'],
    53: ['weather-showers-scattered', 'Морось'],
    55: ['weather-showers',       'Густая морось'],
    61: ['weather-showers-scattered', 'Лёгкий дождь'],
    63: ['weather-showers',       'Дождь'],
    65: ['weather-showers',       'Сильный дождь'],
    71: ['weather-snow-scattered','Лёгкий снег'],
    73: ['weather-snow',          'Снег'],
    75: ['weather-snow',          'Сильный снег'],
    77: ['weather-snow',          'Снежная крупа'],
    80: ['weather-showers-scattered', 'Ливень'],
    81: ['weather-showers',       'Ливень'],
    82: ['weather-storm',         'Сильный ливень'],
    85: ['weather-snow-scattered','Снежный ливень'],
    86: ['weather-snow',          'Сильный снежный ливень'],
    95: ['weather-storm',         'Гроза'],
    99: ['weather-storm',         'Гроза с градом'],
};

function wmoInfo(code) {
    if (code === null || code === undefined) return ['weather-severe-alert', 'Нет данных'];
    return WMO_ICONS[code] || ['weather-severe-alert', `Код ${code}`];
}

// ── Wind direction degrees → Unicode arrow ────────────────────────────────
function windArrow(deg) {
    if (deg === null || deg === undefined) return '';
    const arrows = ['↓','↙','←','↖','↑','↗','→','↘'];
    // wind direction = where wind comes FROM; arrow shows where it blows TO
    const idx = Math.round(((deg + 180) % 360) / 45) % 8;
    return arrows[idx];
}

// ── Aggregate hourly array (168 values for 7 days) → per-day means ────────
function hourlyMeans(arr, days) {
    const result = [];
    for (let d = 0; d < days; d++) {
        let sum = 0, count = 0;
        for (let h = 0; h < 24; h++) {
            const v = arr[d * 24 + h];
            if (v !== null && v !== undefined) { sum += v; count++; }
        }
        result.push(count > 0 ? Math.round(sum / count) : null);
    }
    return result;
}

// ── Day-of-week abbreviations (RU) ───────────────────────────────────────
const DOW_RU = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];

function formatDate(isoStr) {
    const d = new Date(isoStr + 'T12:00:00');
    const dow = DOW_RU[d.getDay()];
    return `${dow} ${d.getDate()}.${String(d.getMonth() + 1).padStart(2,'0')}`;
}

function isToday(isoStr) {
    const now = new Date();
    return isoStr === `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Applet
// ═════════════════════════════════════════════════════════════════════════════

function WeatherApplet(metadata, orientation, panelHeight, instance_id) {
    this._init(metadata, orientation, panelHeight, instance_id);
}

WeatherApplet.prototype = {
    __proto__: Applet.TextIconApplet.prototype,

    _init: function(metadata, orientation, panelHeight, instance_id) {
        Applet.TextIconApplet.prototype._init.call(this, orientation, panelHeight, instance_id);

        this.set_applet_icon_symbolic_name('weather-clear-symbolic');
        this.set_applet_label('…');
        this.hide_applet_label(false);
        this.set_applet_tooltip('Погода на неделю — нажмите для обновления');

        // ── GSettings ──
        try {
            let schemaDir = metadata.path + '/schemas';
            let schemaSource = Gio.SettingsSchemaSource.new_from_directory(
                schemaDir,
                Gio.SettingsSchemaSource.get_default(),
                false
            );
            let schema = schemaSource.lookup('org.cinnamon.applets.mint-weather', true);
            this._settings = new Gio.Settings({ settings_schema: schema });
        } catch (e) {
            global.logError('mint-weather: GSettings schema not found: ' + e);
            this._settings = null;
        }

        this._loadSettings();

        if (this._settings) {
            this._settings.connect('changed', () => {
                this._loadSettings();
                this._refresh();
            });
        }

        // ── Popup menu ──
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this._menuBuilt = false;

        // ── HTTP ──
        if (Soup) {
            try { this._httpSession = new Soup.Session(); }
            catch (e) { this._httpSession = null; }
        } else {
            this._httpSession = null;
        }

        this._forecast = null;
        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._interval, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    },

    _loadSettings: function() {
        this._lat      = this._settings ? this._settings.get_double('latitude')        : 55.7558;
        this._lon      = this._settings ? this._settings.get_double('longitude')       : 37.6173;
        this._tz       = this._settings ? this._settings.get_string('timezone')        : 'auto';
        this._cityName = this._settings ? this._settings.get_string('city-name')       : 'Погода';
        this._interval = this._settings ? this._settings.get_int('refresh-interval')   : 600;
    },

    // ── Build the static popup skeleton ──────────────────────────────────
    _buildPopupSkeleton: function() {
        this.menu.removeAll();

        // Header
        this._headerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: 'weather-header-item' });
        this._headerLabel = new St.Label({ text: this._cityName, style_class: 'weather-header-label' });
        this._headerItem.addActor(this._headerLabel, { expand: true });
        this.menu.addMenuItem(this._headerItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Column headers
        const colItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: 'weather-col-header-item' });
        const colBox  = new St.BoxLayout({ style_class: 'weather-row' });
        ['День', 'Погода', 'Темп.', 'Ветер', 'Влажн.', 'Облачн.'].forEach((h, i) => {
            const lbl = new St.Label({ text: h, style_class: `weather-col-header weather-col-${i}` });
            colBox.add_child(lbl);
        });
        colItem.addActor(colBox, { expand: true });
        this.menu.addMenuItem(colItem);

        // 7 day rows
        this._dayItems = [];
        for (let i = 0; i < 7; i++) {
            const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: 'weather-day-item' });
            const box  = new St.BoxLayout({ style_class: 'weather-row' });

            const labels = [];
            for (let c = 0; c < 6; c++) {
                const lbl = new St.Label({ text: '—', style_class: `weather-cell weather-col-${c}` });
                box.add_child(lbl);
                labels.push(lbl);
            }

            item.addActor(box, { expand: true });
            this.menu.addMenuItem(item);
            this._dayItems.push({ item, labels, box });
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Footer: last update time
        this._footerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: 'weather-footer-item' });
        this._footerLabel = new St.Label({ text: '', style_class: 'weather-footer-label' });
        this._footerItem.addActor(this._footerLabel, { expand: true });
        this.menu.addMenuItem(this._footerItem);
    },

    // ── Populate rows from cached forecast ───────────────────────────────
    _updatePopup: function() {
        if (!this._forecast) return;
        if (!this._menuBuilt) return;  // skeleton not ready yet

        this._headerLabel.set_text(`${this._cityName}  —  прогноз на неделю`);

        const fc = this._forecast;
        const count = Math.min(fc.dates.length, 7);

        for (let i = 0; i < 7; i++) {
            const { labels, box } = this._dayItems[i];

            if (i >= count) {
                labels.forEach(l => l.set_text(''));
                continue;
            }

            const date   = fc.dates[i];
            const tmax   = fc.tmax[i]   !== null ? `+${Math.round(fc.tmax[i])}°` : '—';
            const tmin   = fc.tmin[i]   !== null ? `${Math.round(fc.tmin[i])}°`  : '—';
            const wind   = fc.wind[i]   !== null ? `${Math.round(fc.wind[i])} ${windArrow(fc.winddir[i])}` : '—';
            const humid  = fc.humidity[i] !== null ? `${fc.humidity[i]}%`   : '—';
            const cloud  = fc.cloud[i]    !== null ? `${fc.cloud[i]}%`      : '—';
            const [, desc] = wmoInfo(fc.codes[i]);

            labels[0].set_text(formatDate(date));
            labels[1].set_text(desc);
            labels[2].set_text(`${tmax} / ${tmin}`);
            labels[3].set_text(wind);
            labels[4].set_text(humid);
            labels[5].set_text(cloud);

            // Highlight today
            const todayStyle = isToday(date) ? 'weather-today' : '';
            box.style_class = `weather-row ${todayStyle}`.trim();
        }

        const now = new Date();
        this._footerLabel.set_text(`Обновлено: ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`);
    },

    // ── Fetch from Open-Meteo ─────────────────────────────────────────────
    _refresh: function() {
        const daily  = 'temperature_2m_max,temperature_2m_min,windspeed_10m_max,winddirection_10m_dominant,weathercode';
        const hourly = 'relative_humidity_2m,cloudcover';
        const url    = `https://api.open-meteo.com/v1/forecast?latitude=${this._lat}&longitude=${this._lon}`
                     + `&daily=${daily}&hourly=${hourly}&timezone=${encodeURIComponent(this._tz)}&forecast_days=7`;

        if (this._httpSession && Soup) {
            try {
                const msg = Soup.Message.new('GET', url);
                this._httpSession.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        if (msg.get_status() === Soup.Status.OK) {
                            this._handleResponse(ByteArray.toString(bytes.get_data()));
                        } else {
                            this._setError(`HTTP ${msg.get_status()}`);
                        }
                    } catch (e) {
                        global.logError('mint-weather: ' + e);
                        this._fetchViaCurl(url);
                    }
                });
            } catch (e) {
                global.logError('mint-weather: ' + e);
                this._fetchViaCurl(url);
            }
        } else {
            this._fetchViaCurl(url);
        }
    },

    _fetchViaCurl: function(url) {
        try {
            const [ok, stdout] = GLib.spawn_command_line_sync(`curl -s --max-time 15 '${url}'`);
            if (ok && stdout) {
                this._handleResponse(ByteArray.toString(stdout));
            } else {
                this._setError('curl failed');
            }
        } catch (e) {
            global.logError('mint-weather: ' + e);
            this._setError('Ошибка запроса');
        }
    },

    _handleResponse: function(text) {
        try {
            const d = JSON.parse(text);
            if (!d || !d.daily) { this._setError('Нет данных'); return; }

            const daily  = d.daily;
            const hourly = d.hourly || {};
            const days   = (daily.time || []).length;

            this._forecast = {
                dates:    daily.time || [],
                tmax:     daily.temperature_2m_max     || [],
                tmin:     daily.temperature_2m_min     || [],
                wind:     daily.windspeed_10m_max      || [],
                winddir:  daily.winddirection_10m_dominant || [],
                codes:    daily.weathercode            || [],
                humidity: hourlyMeans(hourly.relative_humidity_2m || [], days),
                cloud:    hourlyMeans(hourly.cloudcover || [], days),
            };

            // Update panel icon and temperature label from today's weather code
            const [iconName] = wmoInfo(this._forecast.codes[0]);
            try {
                this.set_applet_icon_symbolic_name(`${iconName}-symbolic`);
            } catch (e) {
                this.set_applet_icon_symbolic_name('weather-clear-symbolic');
            }

            // Show today's temperature range next to icon
            const tmax = this._forecast.tmax[0];
            const tmin = this._forecast.tmin[0];
            if (tmax !== null && tmax !== undefined) {
                const fmt = t => (Math.round(t) >= 0 ? `+${Math.round(t)}` : `${Math.round(t)}`);
                const label = tmin !== null && tmin !== undefined
                    ? `${fmt(tmax)}° / ${fmt(tmin)}°`
                    : `${fmt(tmax)}°`;
                this.set_applet_label(label);
                this.set_applet_tooltip(`${this._cityName}: ${label}`);
            }

            this._updatePopup();
        } catch (e) {
            global.logError('mint-weather: ' + e);
            this._setError('Ошибка разбора');
        }
    },

    _setError: function(msg) {
        this.set_applet_icon_symbolic_name('weather-severe-alert-symbolic');
        this.set_applet_label('?');
        this.set_applet_tooltip(msg);
        if (this._headerLabel) this._headerLabel.set_text(msg);
    },

    // ── Applet events ─────────────────────────────────────────────────────
    on_applet_clicked: function(event) {
        if (!this._menuBuilt) {
            this._buildPopupSkeleton();
            this._menuBuilt = true;
        }
        this._refresh();
        this.menu.toggle();
        if (this.menu.isOpen) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._updatePopup();
                return GLib.SOURCE_REMOVE;
            });
        }
    },

    on_applet_removed: function() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
    }
};

function main(metadata, orientation, panelHeight, instance_id) {
    return new WeatherApplet(metadata, orientation, panelHeight, instance_id);
}
