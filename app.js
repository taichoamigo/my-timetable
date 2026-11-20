const STORAGE_KEY_STATION = 'last_station_id';
const STORAGE_KEY_ENABLED = 'enabled_station_ids';
const DISPLAY_LIMIT = 3;

// 日本の祝日（振替休日含む：2026年後半〜2027年）
const JP_HOLIDAYS = new Set([
  // 2026年
  '2026-11-23',
  // 2027年
  '2027-01-01', '2027-01-11', '2027-02-11', '2027-02-23',
  '2027-03-21', '2027-03-22', '2027-04-29', '2027-05-03',
  '2027-05-04', '2027-05-05', '2027-07-19', '2027-08-11',
  '2027-09-20', '2027-09-23', '2027-10-11', '2027-11-03',
  '2027-11-23'
]);

let timetableData = null;
let enabledStationIds = loadEnabledStationIds();
let currentStationId = localStorage.getItem(STORAGE_KEY_STATION) || null;
let currentDayType = getDefaultDayType();

const elSelect = document.getElementById('station-select');
const elLocateBtn = document.getElementById('locate-btn');
const elSettingsBtn = document.getElementById('settings-btn');
const elStatus = document.getElementById('status-text');
const elDayTypeBtn = document.getElementById('daytype-btn');
const elClock = document.getElementById('clock');
const elContainer = document.getElementById('timetable-container');

const elRainBar = document.getElementById('rain-bar');
let lastRainFetch = { key: null, time: 0 };

const elModal = document.getElementById('settings-modal');
const elCloseSettingsBtn = document.getElementById('close-settings-btn');
const elSaveSettingsBtn = document.getElementById('save-settings-btn');
const elChecklist = document.getElementById('station-checklist');

function loadEnabledStationIds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ENABLED);
    return raw ? JSON.parse(raw) : null; // null = 全駅有効（初期状態）
  } catch {
    return null;
  }
}

function getEnabledStations() {
  if (!timetableData) return [];
  if (!enabledStationIds || enabledStationIds.length === 0) {
    return timetableData.stations;
  }
  const filtered = timetableData.stations.filter(s => enabledStationIds.includes(s.id));
  return filtered.length > 0 ? filtered : timetableData.stations;
}

function getDefaultDayType() {
  const now = new Date();
  // 深夜0時〜3時台は「前日の終電」扱いにする
  if (now.getHours() < 4) {
    now.setDate(now.getDate() - 1);
  }

  const day = now.getDay();
  if (day === 0 || day === 6) return 'holiday';

  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const mmdd = `${m}-${d}`;

  // 年末年始（12/30〜1/3）は小田急・メトロ・都営とも土休日ダイヤ
  if (mmdd === '12-30' || mmdd === '12-31' || mmdd === '01-01' || mmdd === '01-02' || mmdd === '01-03') {
    return 'holiday';
  }

  return JP_HOLIDAYS.has(`${y}-${mmdd}`) ? 'holiday' : 'weekday';
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => deg * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearestStation(lat, lon) {
  const stations = getEnabledStations();
  let nearest = null;
  let minDist = Infinity;
  for (const st of stations) {
    const dist = haversineKm(lat, lon, st.lat, st.lon);
    if (dist < minDist) {
      minDist = dist;
      nearest = { station: st, dist };
    }
  }
  return nearest;
}

function getNextTrains(scheduleObj, nowMinutes) {
  const results = [];
  const hours = Object.keys(scheduleObj).map(Number).sort((a, b) => a - b);

  for (const h of hours) {
    for (const entry of scheduleObj[String(h)]) {
      const [mStr, type, dest] = entry.split(':');
      const m = Number(mStr);
      const totalMin = h * 60 + m;
      if (totalMin >= nowMinutes) {
        results.push({
          timeStr: `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
          type,
          dest,
          diff: totalMin - nowMinutes
        });
        if (results.length >= DISPLAY_LIMIT) return results;
      }
    }
  }
  return results;
}

function rebuildStationSelect() {
  const stations = getEnabledStations();
  elSelect.innerHTML = stations
    .map(s => `<option value="${s.id}">${s.name}（${s.line}）</option>`)
    .join('');

  if (!stations.some(s => s.id === currentStationId)) {
    currentStationId = stations[0].id;
    localStorage.setItem(STORAGE_KEY_STATION, currentStationId);
  }
  elSelect.value = currentStationId;
}

function render() {
  if (!timetableData) return;

  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const nowMinutes = h * 60 + m;

  elClock.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  elDayTypeBtn.textContent = currentDayType === 'weekday' ? '平日ダイヤ' : '土休日ダイヤ';

  const stations = getEnabledStations();
  const station = stations.find(s => s.id === currentStationId) || stations[0];
  currentStationId = station.id;
  elSelect.value = station.id;

  elContainer.innerHTML = station.directions.map(dir => {
    const schedule = dir.timetable[currentDayType] || {};
    const trains = getNextTrains(schedule, nowMinutes);

    const rowsHtml = trains.length === 0
      ? `<div class="empty-msg">本日の運転は終了しました</div>`
      : trains.map(t => {
          const urgentClass = t.diff <= 5 ? 'urgent' : '';
          const diffLabel = t.diff === 0 ? 'まもなく' : `あと${t.diff}分`;
          return `
            <div class="train-row">
              <div class="train-info">
                <span class="dep-time">${t.timeStr}</span>
                <span class="badge" data-type="${t.type}">${t.type}</span>
                <span class="dest">${t.dest}</span>
              </div>
              <div class="countdown ${urgentClass}">${diffLabel}</div>
            </div>
          `;
        }).join('');

    return `
      <section class="direction-card">
        <div class="direction-title">
          <span>${dir.name}</span>
          <span>${dir.line || station.line}</span>
        </div>
        ${rowsHtml}
      </section>
    `;
  }).join('');
}

async function fetchRainForecast(lat, lon) {
  // 小数第2位（約1km四方）で丸めて5分間キャッシュ
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (lastRainFetch.key === key && Date.now() - lastRainFetch.time < 300000) {
    return;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&minutely_15=precipitation&forecast_minutely_15=5&timezone=Asia%2FTokyo`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP error');
    const data = await res.json();

    const times = data.minutely_15?.time || [];
    const precips = data.minutely_15?.precipitation || [];
    if (times.length === 0) return;

    lastRainFetch = { key, time: Date.now() };
    const hasRain = precips.some(p => p > 0);

    elRainBar.classList.remove('hidden');
    if (!hasRain) {
      elRainBar.classList.remove('wet');
      elRainBar.innerHTML = `<span>☀️ 1時間先まで雨の予報なし</span>`;
      return;
    }

    elRainBar.classList.add('wet');
    const slotsHtml = times.map((t, idx) => {
      const hhmm = t.slice(11, 16); // "YYYY-MM-DDTHH:MM" -> "HH:MM"
      const mm = precips[idx];
      const activeClass = mm > 0 ? 'active' : '';
      return `<span class="rain-slot ${activeClass}">${hhmm} <b>${mm.toFixed(1)}</b>mm</span>`;
    }).join('');

    elRainBar.innerHTML = `<span>☔</span><div class="rain-slots">${slotsHtml}</div>`;
  } catch {
    // オフライン・タイムアウト時は静かに隠す
    elRainBar.classList.add('hidden');
  }
}

function locateAndSelect() {
  if (!('geolocation' in navigator)) {
    elStatus.textContent = '位置情報非対応';
    return;
  }

  const startTime = performance.now();
  elStatus.textContent = '測位中...';

  let settled = false;
  // Android ChromeでAPI自体がハングした場合の強制タイムアウト
  const fallbackTimer = setTimeout(() => {
    if (!settled) {
      settled = true;
      elStatus.textContent = '測位タイムアウト / 手動切替可';
    }
  }, 10500);

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);

      const elapsed = Math.round(performance.now() - startTime);
      const { latitude, longitude } = pos.coords;
      fetchRainForecast(latitude, longitude);
      const result = findNearestStation(latitude, longitude);
      if (result) {
        const distText = result.dist < 1
          ? `${Math.round(result.dist * 1000)}m`
          : `${result.dist.toFixed(1)}km`;
        elStatus.textContent = `最寄り判定: ${distText} (${elapsed}ms)`;

        if (currentStationId !== result.station.id) {
          currentStationId = result.station.id;
          localStorage.setItem(STORAGE_KEY_STATION, currentStationId);
          render();
        }
      }
    },
    (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      elStatus.textContent = `測位失敗 (${err.code}) / 手動切替可`;
    },
    {
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 300000
    }
  );
}

// --- 設定モーダル制御 ---
function openSettings() {
  if (!timetableData) return;
  const activeIds = new Set(getEnabledStations().map(s => s.id));
  elChecklist.innerHTML = timetableData.stations.map(s => `
    <label class="check-item">
      <input type="checkbox" value="${s.id}" ${activeIds.has(s.id) ? 'checked' : ''}>
      <span>${s.name}</span>
      <span class="line-sub">${s.line}</span>
    </label>
  `).join('');
  elModal.classList.remove('hidden');
}

function closeSettings() {
  elModal.classList.add('hidden');
}

function saveSettings() {
  const checked = [...elChecklist.querySelectorAll('input[type="checkbox"]:checked')]
    .map(cb => cb.value);

  if (checked.length === 0) {
    alert('最低1つの駅を選択してください。');
    return;
  }

  enabledStationIds = checked;
  localStorage.setItem(STORAGE_KEY_ENABLED, JSON.stringify(enabledStationIds));
  rebuildStationSelect();
  closeSettings();
  render();
  locateAndSelect();
}

async function init() {
  try {
    const res = await fetch('./data.json');
    timetableData = await res.json();

    rebuildStationSelect();
    render();
    locateAndSelect();
  } catch (e) {
    elStatus.textContent = 'データ読込エラー';
  }
}

elSelect.addEventListener('change', (e) => {
  currentStationId = e.target.value;
  localStorage.setItem(STORAGE_KEY_STATION, currentStationId);
  elStatus.textContent = '手動選択中';
  render();
  const st = timetableData.stations.find(s => s.id === currentStationId);
  if (st) fetchRainForecast(st.lat, st.lon);
});

elLocateBtn.addEventListener('click', locateAndSelect);
elSettingsBtn.addEventListener('click', openSettings);
elCloseSettingsBtn.addEventListener('click', closeSettings);
elSaveSettingsBtn.addEventListener('click', saveSettings);
elModal.addEventListener('click', (e) => {
  if (e.target === elModal) closeSettings();
});

elDayTypeBtn.addEventListener('click', () => {
  currentDayType = currentDayType === 'weekday' ? 'holiday' : 'weekday';
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    currentDayType = getDefaultDayType();
    render();
    locateAndSelect();
  }
});

setInterval(render, 10000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

init();