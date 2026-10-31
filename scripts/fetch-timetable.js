/**
 * 分片抓「上海 MaaS」发车班次 → data/tt-XX.json → FTP 推到站点 htdocs/tt-XX.json
 *
 * 环境变量：
 *   SHARD_INDEX  当前分片（1 起）
 *   SHARD_TOTAL  总分片数
 *
 * 每条线路只需 3 个请求：搜索(拿 lineId) + 两个方向的 querybusline
 * （querybusline 的 busLine.dispatchCarSchedule.dispatchCars 就是「接下来 3 班」）
 */
const fs = require('fs');
const path = require('path');

const API = 'https://api.shmaas.net';
const CITY = '310100';
const SHARD_INDEX = parseInt(process.env.SHARD_INDEX || '1', 10);
const SHARD_TOTAL = parseInt(process.env.SHARD_TOTAL || '1', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);
const OUT_DIR = path.join(__dirname, '..', 'data');
const OUT = path.join(OUT_DIR, `tt-${String(SHARD_INDEX).padStart(2, '0')}.json`);
const LINES_FILE = path.join(__dirname, '..', 'lines.txt');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function todayCN() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
}

async function post(pathname, body, attempt = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(API + pathname, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Saic-CityCode': CITY,
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429) throw new Error('HTTP 429 限流');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json.errCode !== undefined && json.errCode !== 0) throw new Error('errCode ' + json.errCode + ' ' + (json.errMsg || ''));
    return json.data || {};
  } catch (e) {
    if (attempt < 2) {
      await sleep(1500 * (attempt + 1));
      return post(pathname, body, attempt + 1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function cleanPlate(s) {
  const str = String(s || '');
  const m = str.match(/([\u4e00-\u9fa5][A-Za-z][-·\s]?[0-9A-Za-z]{4,6})/u);
  if (m) return m[1].replace(/[-·\s]/g, '').toUpperCase();
  return str.replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '').toUpperCase();
}

function norm(s) {
  return String(s || '')
    .replace(/[\s\u3000]/g, '')
    .replace(/路$/, '')
    .replace(/专线$/, '')
    .replace(/线$/, '')
    .toLowerCase();
}

async function fetchLine(name) {
  const search = await post('/traffic/v2/querytrafficline', {
    keywords: name, type: 0, pageNo: 1, pageSize: 20,
  });
  const groups = search.trafficStop || [];
  const cands = [];
  for (const g of groups) {
    for (const li of (g.stopLineInfo || [])) cands.push(li);
    if (g.lineInfo) cands.push(g.lineInfo);
  }
  if (!cands.length) return { found: false, dirs: {} };

  const want = norm(name);
  let hit = cands.find(x => String(x.lineName) === name)
    || cands.find(x => norm(x.lineName) === want)
    || cands.find(x => norm(x.lineName).replace(/^0+/, '') === want.replace(/^0+/, ''));
  if (!hit) return { found: false, dirs: {} };

  const out = {};
  for (const dir of ['0', '1']) {
    let d;
    try {
      d = await post('/traffic/v1/querybusline', { lineId: hit.lineId, lineName: name, direction: dir });
    } catch (e) {
      continue;
    }
    const bus = d.busLine || {};
    const cars = ((bus.dispatchCarSchedule || {}).dispatchCars) || [];
    const rows = [];
    for (const c of cars) {
      const t = String(c.time || '');
      const p = cleanPlate(c.vehicle);
      if (t && p) rows.push([t, p]);
    }
    if (rows.length) {
      out[dir] = {
        f: String(bus.earlyTime || ''),
        l: String(bus.lateTime || ''),
        r: rows,
      };
    }
  }
  return { found: true, dirs: out };
}

async function pool(items, limit, worker) {
  let i = 0;
  const results = [];
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await worker(items[idx]);
      } catch (e) {
        results[idx] = { error: e.message };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

(async () => {
  const all = fs.readFileSync(LINES_FILE, 'utf8')
    .split(/\r?\n/)
    .map(s => s.replace(/#.*$/, '').trim())
    .filter(Boolean);

  const mine = all.filter((_, i) => i % SHARD_TOTAL === SHARD_INDEX - 1);
  console.log(`分片 ${SHARD_INDEX}/${SHARD_TOTAL}：${mine.length} 条线路`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const day = todayCN();
  const db = { updated: null, day, shard: String(SHARD_INDEX), lines: {} };
  if (fs.existsSync(OUT)) {
    try {
      const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (old && old.day === day && old.lines) db.lines = old.lines;
    } catch (e) {}
  }

  let ok = 0, empty = 0, failed = 0, added = 0, matched = 0, notFound = 0;
  const notFoundNames = [];
  const t0 = Date.now();

  await pool(mine, CONCURRENCY, async (name) => {
    let res = null;
    try {
      res = await fetchLine(name);
    } catch (e) {
      failed++;
      return;
    }
    if (!res.found) { notFound++; notFoundNames.push(name); return; }
    matched++;
    if (!Object.keys(res.dirs).length) { empty++; return; }
    ok++;
    for (const [dir, info] of Object.entries(res.dirs)) {
      const key = `${name}|${dir}`;
      const cell = db.lines[key] || { f: info.f, l: info.l, r: [] };
      const seen = new Map((cell.r || []).map(r => [r[0], r[1]]));
      for (const [t, p] of info.r) {
        if (!seen.has(t)) { seen.set(t, p); added++; }
      }
      cell.r = [...seen.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      cell.f = info.f || cell.f;
      cell.l = info.l || cell.l;
      db.lines[key] = cell;
    }
  });

  db.updated = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00');
  db.nf = notFoundNames.slice(0, 200);
  db.stats = { lines: mine.length, found: matched, withData: ok, empty: empty, notFound: notFound, failed: failed, added: added };
  fs.writeFileSync(OUT, JSON.stringify(db));

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const size = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`完成：有数据 ${ok} / 空 ${empty} / 失败 ${failed}，新增 ${added} 班，用时 ${secs}s，输出 ${OUT} (${size}KB)`);
})();
