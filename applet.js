// ── Imports ───────────────────────────────────────────────────────────────────

const Applet    = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings    = imports.ui.settings;
const St          = imports.gi.St;
const Gtk         = imports.gi.Gtk;
const GLib        = imports.gi.GLib;
const Gio         = imports.gi.Gio;
const ByteArray   = imports.byteArray;

let Soup;
try { Soup = imports.gi.Soup; } catch (e) { Soup = null; }

// ── Constants ─────────────────────────────────────────────────────────────────

// WMO weather interpretation code → [icon-name, human label (RU)]
const WMO_ICONS = {
    0:  ['weather-clear',             'Ясно'],
    1:  ['weather-few-clouds',        'Малооблачно'],
    2:  ['weather-clouds',            'Облачно'],
    3:  ['weather-overcast',          'Пасмурно'],
    45: ['weather-fog',               'Туман'],
    48: ['weather-fog',               'Туман с изморозью'],
    51: ['weather-showers-scattered', 'Лёгкая морось'],
    53: ['weather-showers-scattered', 'Морось'],
    55: ['weather-showers',           'Густая морось'],
    61: ['weather-showers-scattered', 'Лёгкий дождь'],
    63: ['weather-showers',           'Дождь'],
    65: ['weather-showers',           'Сильный дождь'],
    71: ['weather-snow-scattered',    'Лёгкий снег'],
    73: ['weather-snow',              'Снег'],
    75: ['weather-snow',              'Сильный снег'],
    77: ['weather-snow',              'Снежная крупа'],
    80: ['weather-showers-scattered', 'Ливень'],
    81: ['weather-showers',           'Ливень'],
    82: ['weather-storm',             'Сильный ливень'],
    85: ['weather-snow-scattered',    'Снежный ливень'],
    86: ['weather-snow',              'Сильный снежный ливень'],
    95: ['weather-storm',             'Гроза'],
    99: ['weather-storm',             'Гроза с градом'],
};

// Russian day-of-week abbreviations, Sunday-first
const DOW_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

// Forecast table column headers (order must match label assignments in _renderDayRow)
const COL_HEADERS = ['День', 'Погода', 'Темп.', 'Ветер', 'Дождь', 'Рассвет / Закат', 'UV', 'Осадки'];

// ── Utility functions ─────────────────────────────────────────────────────────

// Return [iconName, description] for a WMO weather code
function wmoInfo(code) {
    if (code === null || code === undefined) return ['weather-severe-alert', 'Нет данных'];
    return WMO_ICONS[code] || ['weather-severe-alert', `Код ${code}`];
}

// Wind direction degrees → Unicode arrow showing where wind blows TO
function windArrow(deg) {
    if (deg === null || deg === undefined) return '';
    const arrows = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'];
    const idx = Math.round(((deg + 180) % 360) / 45) % 8;
    return arrows[idx];
}

// Format temperature with correct sign prefix: +12 or -3
function formatTemp(t) {
    const r = Math.round(t);
    return r >= 0 ? `+${r}` : `${r}`;
}

// Format an ISO date string as "Dow DD.MM" using Russian abbreviations
function formatDate(isoStr) {
    const d = new Date(isoStr + 'T12:00:00');
    return `${DOW_RU[d.getDay()]} ${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Return true when isoStr (YYYY-MM-DD) matches today's local date
function isToday(isoStr) {
    const now = new Date();
    const mm  = String(now.getMonth() + 1).padStart(2, '0');
    const dd  = String(now.getDate()).padStart(2, '0');
    return isoStr === `${now.getFullYear()}-${mm}-${dd}`;
}

// Extract HH:MM from an ISO datetime string, or '—' when absent
function sliceTime(isoDatetime) {
    return isoDatetime ? isoDatetime.slice(11, 16) : '—';
}

// ═════════════════════════════════════════════════════════════════════════════
// Applet
// ═════════════════════════════════════════════════════════════════════════════

function WeatherApplet(metadata, orientation, panelHeight, instance_id) {
    this._init(metadata, orientation, panelHeight, instance_id);
}

WeatherApplet.prototype = {
    __proto__: Applet.TextIconApplet.prototype,

    // ── Initialisation ────────────────────────────────────────────────────

    _init: function(metadata, orientation, panelHeight, instance_id) {
        Applet.TextIconApplet.prototype._init.call(this, orientation, panelHeight, instance_id);

        this.set_applet_icon_symbolic_name('weather-clear-symbolic');
        this.set_applet_label('…');
        this.hide_applet_label(false);
        this.set_applet_tooltip('Погода на неделю — нажмите для обновления');

        // Defaults (overwritten by bindProperty below)
        this._lat      = 55.7558;
        this._lon      = 37.6173;
        this._tz       = 'auto';
        this._cityName = 'Погода';
        this._interval = 600;

        this._appletSettings = new Settings.AppletSettings(this, 'mint-weather@copilot', instance_id);
        this._appletSettings.bindProperty(Settings.BindingDirection.IN, 'latitude',         '_lat',      this._onSettingsChanged.bind(this));
        this._appletSettings.bindProperty(Settings.BindingDirection.IN, 'longitude',        '_lon',      this._onSettingsChanged.bind(this));
        this._appletSettings.bindProperty(Settings.BindingDirection.IN, 'timezone',         '_tz',       this._onSettingsChanged.bind(this));
        this._appletSettings.bindProperty(Settings.BindingDirection.IN, 'city-name',        '_cityName', this._onSettingsChanged.bind(this));
        this._appletSettings.bindProperty(Settings.BindingDirection.IN, 'refresh-interval', '_interval', this._onSettingsChanged.bind(this));

        this._initMenu(orientation);
        this._initHttp();

        this._forecast = null;
        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.round(this._interval), () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    },

    _onSettingsChanged: function() {
        this._refresh();
    },

    _initMenu: function(orientation) {
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu        = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this._menuBuilt  = false;
    },

    _initHttp: function() {
        if (Soup) {
            try { this._httpSession = new Soup.Session(); }
            catch (e) { this._httpSession = null; }
        } else {
            this._httpSession = null;
        }
    },

    _loadSettings: function() {
        // kept for compatibility — settings are now bound via AppletSettings.bindProperty
    },

    // ── Data fetching ─────────────────────────────────────────────────────

    _buildApiUrl: function() {
        const daily  = 'temperature_2m_max,temperature_2m_min,windspeed_10m_max,' +
                       'winddirection_10m_dominant,weathercode,precipitation_probability_max,' +
                       'precipitation_sum,uv_index_max,sunrise,sunset';
        const hourly = 'relative_humidity_2m';
        // If user chose 'auto', use the system local timezone so sunrise/sunset
        // times are always returned in the user's local time, not the timezone
        // inferred from coordinates (which may differ in winter, e.g. Kyiv vs Moscow).
        const tz = (this._tz === 'auto')
            ? GLib.TimeZone.new_local().get_identifier()
            : this._tz;
        return 'https://api.open-meteo.com/v1/forecast'
             + `?latitude=${this._lat}&longitude=${this._lon}`
             + `&daily=${daily}&hourly=${hourly}`
             + `&timezone=${encodeURIComponent(tz)}&forecast_days=7`;
    },

    _refresh: function() {
        const url = this._buildApiUrl();

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
            const proc = Gio.Subprocess.new(
                ['curl', '-s', '--max-time', '15', url],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    if (stdout) {
                        this._handleResponse(stdout);
                    } else {
                        this._setError('curl failed');
                    }
                } catch (e) {
                    global.logError('mint-weather: curl finish: ' + e);
                    this._setError('Ошибка запроса');
                }
            });
        } catch (e) {
            global.logError('mint-weather: ' + e);
            this._setError('Ошибка запроса');
        }
    },

    // ── Response handling ─────────────────────────────────────────────────

    _handleResponse: function(text) {
        try {
            const data = JSON.parse(text);
            if (!data || !data.daily) { this._setError('Нет данных'); return; }

            this._forecast = this._parseForecast(data);
            this._updatePanelIndicator();
            this._updatePopup();
        } catch (e) {
            global.logError('mint-weather: ' + e);
            this._setError('Ошибка разбора');
        }
    },

    _parseForecast: function(data) {
        const daily = data.daily;
        return {
            dates:     daily.time                          || [],
            tmax:      daily.temperature_2m_max            || [],
            tmin:      daily.temperature_2m_min            || [],
            wind:      daily.windspeed_10m_max             || [],
            winddir:   daily.winddirection_10m_dominant    || [],
            codes:     daily.weathercode                   || [],
            precip:    daily.precipitation_probability_max || [],
            precipSum: daily.precipitation_sum             || [],
            uv:        daily.uv_index_max                  || [],
            sunrise:   daily.sunrise                       || [],
            sunset:    daily.sunset                        || [],
        };
    },

    _updatePanelIndicator: function() {
        const fc         = this._forecast;
        const [iconName] = wmoInfo(fc.codes[0]);
        const iconFull   = `${iconName}-symbolic`;
        const iconToSet  = Gtk.IconTheme.get_default().has_icon(iconFull) ? iconFull : 'weather-clear-symbolic';
        this.set_applet_icon_symbolic_name(iconToSet);

        const tmax = fc.tmax[0];
        const tmin = fc.tmin[0];
        if (tmax !== null && tmax !== undefined) {
            const label = (tmin !== null && tmin !== undefined)
                ? `${formatTemp(tmax)}° / ${formatTemp(tmin)}°`
                : `${formatTemp(tmax)}°`;
            this.set_applet_label(label);
            this.set_applet_tooltip(`${this._cityName}: ${label}`);
        }
    },

    _setError: function(msg) {
        this.set_applet_icon_symbolic_name('weather-severe-alert-symbolic');
        this.set_applet_label('?');
        this.set_applet_tooltip(msg);
        if (this._headerLabel) this._headerLabel.set_text(msg);
    },

    // ── Popup construction ────────────────────────────────────────────────

    _buildPopupSkeleton: function() {
        this.menu.removeAll();
        this._buildPopupHeader();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildPopupColHeaders();
        this._buildPopupDayRows();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildPopupFooter();
        this._addPopupStyleClass('weather-popup');
    },

    _buildPopupHeader: function() {
        this._headerItem  = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: 'weather-header-item' });
        this._headerLabel = new St.Label({ text: this._cityName, style_class: 'weather-header-label' });
        this._headerItem.addActor(this._headerLabel, { expand: true });
        this.menu.addMenuItem(this._headerItem);
    },

    _buildPopupColHeaders: function() {
        const colItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: 'weather-col-header-item' });
        const colBox  = new St.BoxLayout({ style_class: 'weather-row' });
        COL_HEADERS.forEach((h, i) => {
            colBox.add_child(new St.Label({ text: h, style_class: `weather-col-header weather-col-${i}` }));
        });
        colItem.addActor(colBox, { expand: true });
        this.menu.addMenuItem(colItem);
    },

    _buildPopupDayRows: function() {
        this._dayItems = [];
        for (let i = 0; i < 7; i++) {
            const item   = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: 'weather-day-item' });
            const box    = new St.BoxLayout({ style_class: 'weather-row' });
            const labels = [];
            for (let c = 0; c < COL_HEADERS.length; c++) {
                const lbl = new St.Label({ text: '—', style_class: `weather-cell weather-col-${c}` });
                box.add_child(lbl);
                labels.push(lbl);
            }
            item.addActor(box, { expand: true });
            this.menu.addMenuItem(item);
            this._dayItems.push({ labels, box });
        }
    },

    _buildPopupFooter: function() {
        this._footerItem  = new PopupMenu.PopupBaseMenuItem({ reactive: false, style_class: 'weather-footer-item' });
        this._footerLabel = new St.Label({ text: '', style_class: 'weather-footer-label' });
        this._footerItem.addActor(this._footerLabel, { expand: true });
        this.menu.addMenuItem(this._footerItem);
    },

    _addPopupStyleClass: function(cls) {
        try {
            if (this.menu && this.menu.actor && this.menu.actor.add_style_class_name)
                this.menu.actor.add_style_class_name(cls);
        } catch (e) {
            global.logError('mint-weather: failed to add popup style class: ' + e);
        }
    },

    // ── Popup rendering ───────────────────────────────────────────────────

    _updatePopup: function() {
        if (!this._forecast || !this._menuBuilt) return;

        this._headerLabel.set_text(`${this._cityName}  —  прогноз на неделю`);

        const fc    = this._forecast;
        const count = Math.min(fc.dates.length, 7);
        const now   = new Date();

        for (let i = 0; i < 7; i++) {
            const { labels, box } = this._dayItems[i];
            if (i >= count) { labels.forEach(l => l.set_text('')); continue; }
            this._renderDayRow(labels, box, i, fc);
        }

        this._footerLabel.set_text(
            `Обновлено: ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
        );
        this._applyDayNightClass(now, fc);
    },

    _renderDayRow: function(labels, box, i, fc) {
        const date      = fc.dates[i];
        const tmax      = fc.tmax[i]      !== null ? `${formatTemp(fc.tmax[i])}°`                     : '—';
        const tmin      = fc.tmin[i]      !== null ? `${formatTemp(fc.tmin[i])}°`                     : '—';
        const wind      = fc.wind[i]      !== null ? `${Math.round(fc.wind[i])} ${windArrow(fc.winddir[i])}` : '—';
        const precip    = fc.precip[i]    != null  ? `${fc.precip[i]}%`                               : '—';
        const precipSum = fc.precipSum[i] != null  ? `${fc.precipSum[i].toFixed(1)}мм`                : '—';
        const uv        = fc.uv[i]        != null  ? `${Math.round(fc.uv[i])}`                        : '—';
        const sunStr    = `↑${sliceTime(fc.sunrise[i])} ↓${sliceTime(fc.sunset[i])}`;
        const [, desc]  = wmoInfo(fc.codes[i]);

        labels[0].set_text(formatDate(date));
        labels[1].set_text(desc);
        labels[2].set_text(`${tmax} / ${tmin}`);
        labels[3].set_text(wind);
        labels[4].set_text(precip);
        labels[5].set_text(sunStr);
        labels[6].set_text(uv);
        labels[7].set_text(precipSum);

        box.style_class = isToday(date) ? 'weather-row weather-today' : 'weather-row';
    },

    _applyDayNightClass: function(now, fc) {
        try {
            if (this.menu && this.menu.actor && this.menu.actor.remove_style_class_name &&
                    fc.sunrise && fc.sunset && fc.sunrise[0] && fc.sunset[0]) {
                const isDayNow = now >= new Date(fc.sunrise[0]) && now < new Date(fc.sunset[0]);
                this.menu.actor.remove_style_class_name('weather-day');
                this.menu.actor.remove_style_class_name('weather-night');
                this.menu.actor.add_style_class_name(isDayNow ? 'weather-day' : 'weather-night');
            }
        } catch (e) {
            global.logError('mint-weather: day/night toggle failed: ' + e);
        }
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
    },

    // Explicit configure handler for right-click "Configure..." menu item
    configureApplet: function(tab) {
        if (typeof tab !== 'number') tab = 0;
        const uuid = this._uuid || 'mint-weather@copilot';
        const iid  = this.instance_id || '';
        const cmd  = `xlet-settings applet ${uuid}` + (iid ? ` -i ${iid}` : '') + ` -t ${tab}`;
        global.log(`[mint-weather] configureApplet called: ${cmd}`);
        try {
            let [ok, argv] = GLib.shell_parse_argv(cmd);
            let proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            proc.wait_async(null, null);
        } catch(e) {
            global.logError('[mint-weather] configureApplet error: ' + e.message);
        }
    },
};

function main(metadata, orientation, panelHeight, instance_id) {
    return new WeatherApplet(metadata, orientation, panelHeight, instance_id);
}
