const STORAGE_KEY_STATION = 'last_station_id';
const STORAGE_KEY_ENABLED = 'enabled_station_ids';
const DISPLAY_LIMIT = 3;

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
  const day = new Date().getDay();
  return (day === 0 || day === 6) ? 'holiday' : 'weekday';
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

function locateAndSelect() {
  if (!('geolocation' in navigator)) {
    elStatus.textContent = '位置情報非対応';
    return;
  }

  const startTime = performance.now();
  elStatus.textContent = '測位中...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const elapsed = Math.round(performance.now() - startTime);
      const { latitude, longitude } = pos.coords;
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
      elStatus.textContent = `測位失敗 (${err.code}) / 手動切替可`;
    },
    {
      enableHighAccuracy: false,
      timeout: 2000,
      maximumAge: 180000
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