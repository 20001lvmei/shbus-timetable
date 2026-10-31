/**
 * 定时抓「上海 MaaS」的发车班次，合并进 timetable.json
 * 由 GitHub Actions 每 5 分钟跑一次（见 .github/workflows/timetable.yml）
 *
 * 只抓「首发站接下来 3 班」——上游一次只给这么多；靠每 5 分钟一次累积，
 * 一天下来就能拼出全天发车表（时间 + 车牌）。自编号由站点用自己的对照表补。
 */
const fs = require('fs');
const path = require('path');

const API = 'https://api.shmaas.net';
const CITY = '310100';
const OUT = path.join(__dirname, '..', 'timetable.json');
const LINES_FILE = path.join(__dirname, '..', 'lines.txt');
const KEEP_DAYS = 7;

function today() {
  // 用上海时区
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

async function api(pathname, body) {
  const res = await fetch(API + pathname, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Saic-CityCode': CITY,
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}`);
  const json = await res.json();
  if (json.errCode !== 0 && json.errCode !== undefined) {
    throw new Error(`errCode ${json.errCode} ${json.errMsg || ''}`);
  }
  return json.data || {};
}

function cleanPlate(s) {
  const m = String(s || '').match(/([\u4e00-\u9fa5][A-Za-z][-·\s]?[0-9A-Za-z]{4,6})/u);
  return m ? m[1].replace(/[-·\s]/g, '').toUpperCase() : String(s || '').replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '');
}

async function fetchLine(name) {
  const search = await api('/traffic/v2/querytrafficline', {
    keywords: name, type: 0, pageNo: 1, pageSize: 20,
  });
  const groups = search.trafficStop || [];
  const candidates = [];
  for (const g of groups) {
    for (const li of (g.stopLineInfo || [])) candidates.push(li);
    if (g.lineInfo) candidates.push(g.lineInfo);
  }
  const exact = candidates.find(x => x.lineName === name) || candidates[0];
  if (!exact) return null;

  const result = { line: exact.lineName, lineId: exact.lineId, dirs: {} };
  for (const dir of ['0', '1']) {
    let detail;
    try {
      detail = await api('/traffic/v1/querybusline', {
        lineId: exact.lineId, lineName: exact.lineName, direction: dir,
      });
    } catch (e) { continue; }
    const bus = detail.busLine || {};
    const stops = bus.stop || [];
    if (!stops.length) continue;
    const first = stops[0];
    let eta;
    try {
      eta = await api('/traffic/v1/getbusstoparrivedetails', {
        lineName: bus.lineName || exact.lineName,
        stopName: first.stopName,
        stopId: first.stopId,
        direction: dir,
      });
    } catch (e) { continue; }
    const cars = ((eta.dispatchCarSchedule || {}).dispatchCars) || [];
    const rows = cars
      .map(c => ({ time: String(c.time || ''), plate: cleanPlate(c.vehicle) }))
      .filter(r => r.time && r.plate);
    if (rows.length) {
      result.dirs[dir] = {
        start: bus.upStartStop || first.stopName,
        end: bus.upEndStop || '',
        first: bus.earlyTime || '',
        last: bus.lateTime || '',
        rows,
      };
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return Object.keys(result.dirs).length ? result : null;
}

(async () => {
  const lines = fs.readFileSync(LINES_FILE, 'utf8')
    .split(/\r?\n/)
    .map(s => s.replace(/#.*$/, '').trim())
    .filter(Boolean);

  let db = { updated: null, days: {} };
  if (fs.existsSync(OUT)) {
    try { db = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { db = { updated: null, days: {} }; }
  }
  if (!db.days) db.days = {};

  const day = today();
  db.days[day] = db.days[day] || {};

  let added = 0;
  for (const name of lines) {
    try {
      const line = await fetchLine(name);
      if (!line) { console.error(`跳过 ${name}：上游没有数据`); continue; }
      for (const [dir, info] of Object.entries(line.dirs)) {
        const key = `${line.line}|${dir}`;
        const cell = db.days[day][key] || { start: info.start, end: info.end, first: info.first, last: info.last, rows: [] };
        const byTime = new Map((cell.rows || []).map(r => [r.time, r]));
        for (const r of info.rows) {
          if (!byTime.has(r.time)) { byTime.set(r.time, r); added++; }
        }
        cell.rows = [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
        cell.start = info.start || cell.start;
        cell.end = info.end || cell.end;
        cell.first = info.first || cell.first;
        cell.last = info.last || cell.last;
        db.days[day][key] = cell;
      }
      console.log(`${name}: 完成`);
    } catch (e) {
      console.error(`${name}: ${e.message}`);
    }
  }

  // 清理超过 KEEP_DAYS 的日期
  const keys = Object.keys(db.days).sort();
  while (keys.length > KEEP_DAYS) delete db.days[keys.shift()];

  db.updated = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00');
  fs.writeFileSync(OUT, JSON.stringify(db, null, 1));
  console.log(`新增 ${added} 班，文件已更新：${OUT}`);
})();
