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

// 表示用の種別名に変換（小田急線の特急 → ロマンスカー）
function formatTypeLabel(type, line) {
  if (type === '特急' && line && (line.includes('小田急') || line.include('千代田'))) {
    return '特急ロマンスカー';
  }
  return type;
}

// 駅の路線名ラベルを取得（station.lineが空ならdirectionsから自動生成）
function getStationLineLabel(station) {
  if (station.line) return station.line;
  const lines = [...new Set(station.directions.map(d => d.line).filter(Boolean))];
  return lines.join('・');
}

function getEnabledStations() {
  if (!timetableData) return [];
  const visible = timetableData.stations.filter(s => !s.hidden);
  if (!enabledStationIds || enabledStationIds.length === 0) {
    return visible;
  }
  const filtered = visible.filter(s => enabledStationIds.includes(s.id));
  return filtered.length > 0 ? filtered : visible;
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
          totalMin,
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

// 時刻表オブジェクトを分単位のフラットな配列に変換
function flattenSchedule(scheduleObj) {
  const list = [];
  if (!scheduleObj) return list;
  const hours = Object.keys(scheduleObj).map(Number).sort((a, b) => a - b);
  for (const h of hours) {
    for (const entry of scheduleObj[String(h)]) {
      const [mStr, type, dest, note] = entry.split(':');
      const m = Number(mStr);
      list.push({
        totalMin: h * 60 + m,
        timeStr: `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
        type,
        dest,
        isOrigin: note === '始発'
      });
    }
  }
  return list;
}

function getHubSchedule(stationId, dirIndex, dayType) {
  const st = timetableData?.stations.find(s => s.id === stationId);
  const dir = st?.directions?.[dirIndex];
  return flattenSchedule(dir?.timetable?.[dayType]);
}

// 乗換ヒントを自動計算
function getTransferHints(stationId, dir, train, dayType) {
  const hints = [];
  const FAST_TYPES = new Set(['快速急行', '快急', '急行', '通勤急行', '特急']);

  // 1. 玉川学園前（上り）→ 新百合ヶ丘で待ち合わせする速達・特急 / リレーで向ヶ丘遊園の始発
  if (stationId === 'tamagawagakuen' && dir.name.includes('上り')) {
    const shinyuriUp = getHubSchedule('shinyurigaoka', 0, dayType);
    const mukogaokaUp = getHubSchedule('mukogaoka_yuen', 0, dayType);
    const arrShinyuri = train.totalMin + 7; // 玉川学園前 → 新百合ヶ丘（約7分）

    // 自分の乗っている各停が新百合ヶ丘を出る時刻を先に特定
    const sameTrainAtShinyuri = shinyuriUp.find(t =>
      t.type === train.type &&
      t.dest === train.dest &&
      t.totalMin >= arrShinyuri &&
      t.totalMin <= arrShinyuri + 10
    );
    const depShinyuri = sameTrainAtShinyuri ? sameTrainAtShinyuri.totalMin : arrShinyuri + 1;

    // 新百合ヶ丘での速達・特急乗換（自分の各停が発車する前の待ち合わせ便のみ）
    if (train.type === '各停') {
      const fast = shinyuriUp.find(t =>
        FAST_TYPES.has(t.type) &&
        t.totalMin >= arrShinyuri + 1 &&
        t.totalMin <= depShinyuri
      );
      if (fast) {
        const fastLabel = formatTypeLabel(fast.type, '小田急線');
        hints.push(`新百合 ${fast.timeStr} ${fastLabel}`);
      }
    }

    // 2段階リレー：新百合ヶ丘発から向ヶ丘遊園の始発を照合
    const arrMukogaoka = depShinyuri + 7; // 新百合ヶ丘 → 向ヶ丘遊園（約7分）
    const origin = mukogaokaUp.find(t =>
      t.isOrigin &&
      t.totalMin >= arrMukogaoka + 1 &&
      t.totalMin <= arrMukogaoka + 6
    );
    if (origin) {
      hints.push(`向ヶ丘(始発) ${origin.timeStr} ${origin.type}${origin.dest}`);
    }
  }

// 2. 新宿（下り・小田急）→ 新百合ヶ丘リレーで各停へ
  if (stationId === 'odakyu_shinjuku' && (dir.line === '小田急線' || dir.name.includes('下り'))) {
    if (FAST_TYPES.has(train.type)) {
      const shinyuriDown = getHubSchedule('shinyurigaoka', 1, dayType);
      // 自分の乗った快速急行・急行が新百合ヶ丘を出る時刻を特定（新宿から19〜30分後）
      const sameTrain = shinyuriDown.find(t =>
        t.type === train.type &&
        t.dest === train.dest &&
        t.totalMin >= train.totalMin + 19 &&
        t.totalMin <= train.totalMin + 30
      );
      const baseMin = sameTrain ? sameTrain.totalMin : train.totalMin + 21;
      const local = shinyuriDown.find(t =>
        t.type === '各停' &&
        t.totalMin >= baseMin &&
        t.totalMin <= baseMin + 6
      );
      if (local) {
        hints.push(`新百合 ${local.timeStr} 各停${local.dest}`);
      }
    }
  }

  // 3. 代々木上原（下り・小田急）→ 新百合ヶ丘リレーで各停へ
  if (stationId === 'yoyogi_uehara' && dir.line === '小田急線') {
    if (FAST_TYPES.has(train.type)) {
      const shinyuriDown = getHubSchedule('shinyurigaoka', 1, dayType);
      // 自分の乗った快速急行・急行が新百合ヶ丘を出る時刻を特定（代々木上原から14〜25分後）
      const sameTrain = shinyuriDown.find(t =>
        t.type === train.type &&
        t.dest === train.dest &&
        t.totalMin >= train.totalMin + 14 &&
        t.totalMin <= train.totalMin + 25
      );
      const baseMin = sameTrain ? sameTrain.totalMin : train.totalMin + 16;
      const local = shinyuriDown.find(t =>
        t.type === '各停' &&
        t.totalMin >= baseMin &&
        t.totalMin <= baseMin + 6
      );
      if (local) {
        hints.push(`新百合 ${local.timeStr} 各停${local.dest}`);
      }
    }
  }
  
  return hints;
}

function rebuildStationSelect() {
  const stations = getEnabledStations();
  elSelect.innerHTML = stations
    .map(s => {
      const lineLabel = getStationLineLabel(s);
      const label = lineLabel ? `${s.name}（${lineLabel}）` : s.name;
      return `<option value="${s.id}">${label}</option>`;
    })
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
// 深夜0〜3時台は24〜27時台として計算（時刻表の "24" キーと合わせる）
  const nowMinutes = (h < 4 ? h + 24 : h) * 60 + m;

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
          const hints = getTransferHints(station.id, dir, t, currentDayType);
          const hintHtml = hints.length > 0
            ? `<div class="transfer-hint">↳ ${hints.join(' / ')}</div>`
            : '';
		  const lineName = dir.line || station.line;
          const displayType = formatTypeLabel(t.type, lineName);
          return `
            <div class="train-item">
              <div class="train-row">
                <div class="train-info">
                  <span class="dep-time">${t.timeStr}</span>
                  <span class="badge" data-type="${t.type}">${displayType}</span>
                  <span class="dest">${t.dest}</span>
                </div>
                <div class="countdown ${urgentClass}">${diffLabel}</div>
              </div>
              ${hintHtml}
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
  elChecklist.innerHTML = timetableData.stations.filter(s => !s.hidden).map(s => `
    <label class="check-item">
      <input type="checkbox" value="${s.id}" ${activeIds.has(s.id) ? 'checked' : ''}>
      <span>${s.name}</span>
      <span class="line-sub">${getStationLineLabel(s)}</span>
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