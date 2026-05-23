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

// Map OpenWeatherMap weather id -> approximate WMO code used by WMO_ICONS
function mapOWMToWmo(id) {
    if (id === null || id === undefined) return null;
    // Thunderstorm 200-232 -> 95
    if (id >= 200 && id < 300) return 95;
    // Drizzle 300-321 -> 51
    if (id >= 300 && id < 500) return 51;
    // Rain 500-531 -> 63
    if (id >= 500 && id < 600) return 63;
    // Snow 600-622 -> 73
    if (id >= 600 && id < 700) return 73;
    // Atmosphere (mist, fog) 700-781 -> 45
    if (id >= 700 && id < 800) return 45;
    // Clear 800 -> 0
    if (id === 800) return 0;
    // Clouds 801-804 -> 1/2/3
    if (id === 801) return 1;
    if (id === 802) return 2;
    if (id === 803 || id === 804) return 3;
    return null;
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

        // remember metadata path for fallback schema reading
        try { this._metadataPath = metadata.path; } catch (e) { this._metadataPath = null; }

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
        // data source: 'open-meteo' (default) or 'openweathermap'
        try {
            this._dataSource = this._settings ? this._settings.get_string('data-source') : 'open-meteo';
        } catch (e) {
            this._dataSource = 'open-meteo';
        }
        try {
            this._apiKey = this._settings ? this._settings.get_string('api-key') : '';
        } catch (e) {
            this._apiKey = '';
        }
        try {
            this._meteostatKey = this._settings ? this._settings.get_string('meteostat-api-key') : '';
        } catch (e) {
            this._meteostatKey = '';
        }

        // If settings didn't provide a meteostat key (schema not installed), try to read default from local schema XML file
        try {
            if ((!this._meteostatKey || this._meteostatKey.length === 0) && this._metadataPath) {
                const schemaPath = this._metadataPath + '/schemas/org.cinnamon.applets.mint-weather.gschema.xml';
                try {
                    const [ok, contents] = GLib.file_get_contents(schemaPath);
                    if (ok && contents) {
                        const txt = ByteArray.toString(contents);
                        const m = txt.match(/<key\s+name="meteostat-api-key"[\s\S]*?<default>([\s\S]*?)<\/default>/i);
                        if (m && m[1]) {
                            // strip quotes and whitespace
                            const raw = m[1].trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
                            if (raw && raw.length > 0) this._meteostatKey = raw;
                        }
                    }
                } catch (e) { global.logError('mint-weather: failed reading schema file for meteostat key: ' + e); }
            }
        } catch (e) { /* ignore */ }

        // Debug: report if meteostat key is present (masked)
        try {
            if (this._meteostatKey && this._meteostatKey.length) {
                const masked = this._meteostatKey.slice(0,4) + '...' + this._meteostatKey.slice(-4);
                global.log(`mint-weather: meteostat key loaded (default): ${masked}`);
            } else {
                global.log('mint-weather: meteostat key not found in settings or local schema');
            }
        } catch (e) { /* ignore */ }
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
        ['День', 'Погода', 'Темп.', 'Ветер', 'Дождь', 'Рассвет / Закат', 'UV', 'Осадки'].forEach((h, i) => {
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
            for (let c = 0; c < 8; c++) {
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
        // Data source selector (click to cycle)
        this._sourceItem = new PopupMenu.PopupBaseMenuItem({ reactive: true, style_class: 'weather-source-item' });
        this._sourceLabel = new St.Label({ text: `Источник: ${this._dataSource || 'open-meteo'}`, style_class: 'weather-source-label' });
        this._sourceItem.addActor(this._sourceLabel, { expand: true });
        this._sourceItem.connect('activate', () => {
            try {
                const sources = ['open-meteo','meteostat'];
                const idx = sources.indexOf(this._dataSource) >= 0 ? sources.indexOf(this._dataSource) : 0;
                const next = sources[(idx + 1) % sources.length];
                let setOk = false;
                if (this._settings) {
                    try {
                        this._settings.set_string('data-source', next);
                        try { const tmpApi = this._settings.get_string('api-key'); if (tmpApi && tmpApi.length) this._apiKey = tmpApi; } catch (e) { this._apiKey = ''; }
                        try { const tmpM = this._settings.get_string('meteostat-api-key'); if (tmpM && tmpM.length) this._meteostatKey = tmpM; } catch (e) { this._meteostatKey = ''; }
                        setOk = true;
                    } catch (e) {
                        global.logError('mint-weather: cannot set data-source key: ' + e);
                    }
                }
                if (!setOk) {
                    this._dataSource = next;
                    try {
                        if (this._settings) {
                            try { const tmpApi = this._settings.get_string('api-key'); if (tmpApi && tmpApi.length) this._apiKey = tmpApi; } catch (e) { this._apiKey = ''; }
                            try { const tmpM = this._settings.get_string('meteostat-api-key'); if (tmpM && tmpM.length) this._meteostatKey = tmpM; } catch (e) { this._meteostatKey = ''; }
                        }
                    } catch (e) { this._apiKey = ''; this._meteostatKey = ''; }
                }
                this._sourceLabel.set_text(`Источник: ${next}`);
                this._refresh();
            } catch (e) { global.logError('mint-weather: source cycle failed: ' + e); }
        });
        this.menu.addMenuItem(this._sourceItem);

        // Mark the popup actor so stylesheet can target day/night adjustments
        try {
            if (this.menu && this.menu.actor && this.menu.actor.add_style_class_name) {
                this.menu.actor.add_style_class_name('weather-popup');
            }
        } catch (e) { global.logError('mint-weather: failed to add popup style class: ' + e); }

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
            const precip    = fc.precip[i] !== null && fc.precip[i] !== undefined ? `${fc.precip[i]}%` : '—';
            const precipSum = fc.precipSum[i] !== null && fc.precipSum[i] !== undefined ? `${fc.precipSum[i].toFixed(1)}мм` : '—';
            const uv        = fc.uv[i] !== null && fc.uv[i] !== undefined ? `${Math.round(fc.uv[i])}` : '—';
            const sunrise = fc.sunrise[i] ? fc.sunrise[i].slice(11, 16) : '—';
            const sunset  = fc.sunset[i]  ? fc.sunset[i].slice(11, 16)  : '—';
            const sunStr  = `↑${sunrise} ↓${sunset}`;
            const [, desc] = wmoInfo(fc.codes[i]);

            labels[0].set_text(formatDate(date));
            labels[1].set_text(desc);
            labels[2].set_text(`${tmax} / ${tmin}`);
            labels[3].set_text(wind);
            labels[4].set_text(precip);
            labels[5].set_text(sunStr);
            labels[6].set_text(uv);
            labels[7].set_text(precipSum);

            // Highlight today
            const todayStyle = isToday(date) ? 'weather-today' : '';
            box.style_class = `weather-row ${todayStyle}`.trim();
        }

        const now = new Date();
        this._footerLabel.set_text(`Обновлено: ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`);

        // Day/night brightness toggle based on today's sunrise/sunset
        try {
            if (this.menu && this.menu.actor && fc.sunrise && fc.sunset && fc.sunrise[0] && fc.sunset[0]) {
                const sr = new Date(fc.sunrise[0]);
                const ss = new Date(fc.sunset[0]);
                const isDayNow = now >= sr && now < ss;
                if (this.menu.actor.remove_style_class_name) {
                    this.menu.actor.remove_style_class_name('weather-day');
                    this.menu.actor.remove_style_class_name('weather-night');
                    this.menu.actor.add_style_class_name(isDayNow ? 'weather-day' : 'weather-night');
                }
            }
        } catch (e) { global.logError('mint-weather: day/night toggle failed: ' + e); }

    },

    // ── Fetch from Open-Meteo ─────────────────────────────────────────────
    _refresh: function() {
        const daily  = 'temperature_2m_max,temperature_2m_min,windspeed_10m_max,winddirection_10m_dominant,weathercode,precipitation_probability_max,precipitation_sum,uv_index_max,sunrise,sunset';
        const hourly = 'relative_humidity_2m';
        let url = null;
        let extraHeaders = null;
        if (this._dataSource === 'openweathermap') {
            if (!this._apiKey || this._apiKey.length === 0) {
                this._setError('OpenWeatherMap API key not set');
                return;
            }
            url = `https://api.openweathermap.org/data/2.5/onecall?lat=${this._lat}&lon=${this._lon}&exclude=minutely,hourly&units=metric&appid=${this._apiKey}&lang=ru`;
        } else if (this._dataSource === 'meteostat') {
            // Meteostat via RapidAPI - use hardcoded key as fallback
            const METEOSTAT_KEY = '5295884457msh2c0134444e26c3ep176f19jsn223c9b2620a2';
            const key = (this._meteostatKey && this._meteostatKey.length) ? this._meteostatKey
                      : (this._apiKey && this._apiKey.length) ? this._apiKey
                      : METEOSTAT_KEY;
            // Meteostat only has historical data — request last 7 days (today-6 → today)
            const endD  = (function() { const d = new Date(); return d.toISOString().slice(0,10); })();
            const start = (function() { const d = new Date(); d.setDate(d.getDate()-6); return d.toISOString().slice(0,10); })();
            url = `https://meteostat.p.rapidapi.com/point/daily?lat=${this._lat}&lon=${this._lon}&start=${start}&end=${endD}&units=metric`;
            extraHeaders = { 'x-rapidapi-host': 'meteostat.p.rapidapi.com', 'x-rapidapi-key': key };
        } else {
            url = `https://api.open-meteo.com/v1/forecast?latitude=${this._lat}&longitude=${this._lon}`
                 + `&daily=${daily}&hourly=${hourly}&timezone=${encodeURIComponent(this._tz)}&forecast_days=7`;
        }

        if (this._httpSession && Soup) {
            try {
                const msg = Soup.Message.new('GET', url);
                // Attach extra headers if provided (Meteostat via RapidAPI)
                try {
                    if (extraHeaders) {
                        for (const h in extraHeaders) {
                            try { msg.request_headers.append(h, extraHeaders[h]); } catch (e) {
                                try { msg.set_request_header(h, extraHeaders[h]); } catch (e2) { global.logError('mint-weather: failed to set header ' + h + ': ' + e2); }
                            }
                        }
                    }
                } catch (e) { global.logError('mint-weather: header attach failed: ' + e); }

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
                        this._fetchViaCurl(url, extraHeaders);
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

    _fetchViaCurl: function(url, headers) {
        try {
            let headerFlags = '';
            if (headers) {
                for (const h in headers) {
                    // curl header format: -H 'Key: Value'
                    const val = headers[h].toString().replace(/'/g, "'\\''");
                    headerFlags += ` -H '${h}: ${val}'`;
                }
            }
            const cmd = `curl -s --max-time 15 ${headerFlags} '${url}'`;
            const [ok, stdout] = GLib.spawn_command_line_sync(cmd);
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
            if (!d) { this._setError('Нет данных'); return; }

            // Detect OpenWeatherMap error responses (e.g. invalid API key)
            if (d.cod && (d.cod === 401 || d.cod === '401')) { this._setError('OpenWeatherMap: Invalid API key'); return; }
            if (d.cod && d.message) { this._setError(`OpenWeatherMap: ${d.message}`); return; }

            if (!d.daily) {
                // Maybe this is a Meteostat response (array or {data: []}) — normalize to d.daily
                if (this._dataSource === 'meteostat' || (Array.isArray(d) && d.length && d[0].date) || (d.data && Array.isArray(d.data))) {
                    const od = d.data && Array.isArray(d.data) ? d.data : (Array.isArray(d) ? d : []);
                    if (od.length === 0) { this._setError('Meteostat: нет данных за период'); return; }
                    const norm = { time: [], temperature_2m_max: [], temperature_2m_min: [], windspeed_10m_max: [], winddirection_10m_dominant: [], weathercode: [], precipitation_probability_max: [], precipitation_sum: [], uv_index_max: [], sunrise: [], sunset: [] };
                    for (let i = 0; i < od.length && i < 7; i++) {
                        const it = od[i];
                        norm.time.push(it.date ? it.date.slice(0,10) : null);
                        norm.temperature_2m_max.push((it.tmax !== undefined && it.tmax !== null) ? it.tmax : null);
                        norm.temperature_2m_min.push((it.tmin !== undefined && it.tmin !== null) ? it.tmin : null);
                        // Meteostat wspd is km/h — convert to m/s to match Open-Meteo units
                        norm.windspeed_10m_max.push((it.wspd !== undefined && it.wspd !== null) ? (it.wspd / 3.6) : null);
                        norm.winddirection_10m_dominant.push((it.wdir !== undefined && it.wdir !== null) ? it.wdir : null);
                        // Heuristic weathercode mapping
                        let wc = null;
                        if (it.snow !== undefined && it.snow > 0) wc = 73; // snow
                        else if (it.prcp !== undefined && it.prcp >= 5) wc = 63; // rain
                        else if (it.prcp !== undefined && it.prcp > 0) wc = 51; // drizzle
                        else wc = 0; // clear as fallback
                        norm.weathercode.push(wc);
                        norm.precipitation_probability_max.push(null);
                        norm.precipitation_sum.push((it.prcp !== undefined && it.prcp !== null) ? it.prcp : null);
                        norm.uv_index_max.push(null);
                        norm.sunrise.push(null);
                        norm.sunset.push(null);
                    }
                    d.daily = { time: norm.time, temperature_2m_max: norm.temperature_2m_max, temperature_2m_min: norm.temperature_2m_min, windspeed_10m_max: norm.windspeed_10m_max, winddirection_10m_dominant: norm.winddirection_10m_dominant, weathercode: norm.weathercode, precipitation_probability_max: norm.precipitation_probability_max, precipitation_sum: norm.precipitation_sum, uv_index_max: norm.uv_index_max, sunrise: norm.sunrise, sunset: norm.sunset };
                } else {
                    this._setError('Нет данных'); return;
                }
            }

            // If OpenWeatherMap response (daily[].temp exists as object) normalize to structure used by Open-Meteo
            if (d.daily && d.daily.length && d.daily[0].temp && typeof d.daily[0].temp === 'object') {
                const od = d.daily;
                const norm = { time: [], temperature_2m_max: [], temperature_2m_min: [], windspeed_10m_max: [], winddirection_10m_dominant: [], weathercode: [], precipitation_probability_max: [], precipitation_sum: [], uv_index_max: [], sunrise: [], sunset: [] };
                for (let i=0;i<od.length && i<7;i++) {
                    const it = od[i];
                    const date = new Date(it.dt * 1000);
                    norm.time.push(date.toISOString().slice(0,10));
                    norm.temperature_2m_max.push(it.temp.max || null);
                    norm.temperature_2m_min.push(it.temp.min || null);
                    norm.windspeed_10m_max.push(it.wind_speed || null);
                    norm.winddirection_10m_dominant.push(it.wind_deg || null);
                    const w = (it.weather && it.weather[0] && it.weather[0].id) ? it.weather[0].id : null;
                    norm.weathercode.push(mapOWMToWmo(w));
                    norm.precipitation_probability_max.push((it.pop !== undefined && it.pop !== null) ? Math.round(it.pop * 100) : null);
                    norm.precipitation_sum.push((it.rain !== undefined ? it.rain : (it.snow !== undefined ? it.snow : null)) || null);
                    norm.uv_index_max.push(it.uvi || null);
                    norm.sunrise.push(new Date(it.sunrise * 1000).toISOString());
                    norm.sunset.push(new Date(it.sunset * 1000).toISOString());
                }
                d.daily = { time: norm.time, temperature_2m_max: norm.temperature_2m_max, temperature_2m_min: norm.temperature_2m_min, windspeed_10m_max: norm.windspeed_10m_max, winddirection_10m_dominant: norm.winddirection_10m_dominant, weathercode: norm.weathercode, precipitation_probability_max: norm.precipitation_probability_max, precipitation_sum: norm.precipitation_sum, uv_index_max: norm.uv_index_max, sunrise: norm.sunrise, sunset: norm.sunset };
            }

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
                precip:   daily.precipitation_probability_max || [],
                precipSum: daily.precipitation_sum           || [],
                uv:       daily.uv_index_max                 || [],
                sunrise:  daily.sunrise || [],
                sunset:   daily.sunset  || [],
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
