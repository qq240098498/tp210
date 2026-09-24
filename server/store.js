const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

const dataFile = path.join(__dirname, '..', 'data', 'db.json');

const DEFAULT_SETTINGS = {
  volumeUnit: '万m³',
  flowUnit: 'm³/s',
  floodSeasonStart: '05-15',
  floodSeasonEnd: '09-15',
  balanceToleranceWan: 0.5,
  lossPerDayWan: 1.2,
  levelPrecision: 0.01,
  inflowAttentionFlow: 120,
  inflowSeriousFlow: 260,
};

// 联合调度总控约束的默认值（流量单位 m³/s，按日考核）
const DEFAULT_JOINT_CONTROL = {
  maxTotalReleaseFlow: 150,
  sectionName: '白河下游控制断面',
  sectionMinFlow: 50,
  sectionMaxFlow: 140,
};

function normalize(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  data.jointControl = Object.assign({}, DEFAULT_JOINT_CONTROL, data.jointControl || {});
  for (const key of ['reservoirs', 'curves', 'levels', 'inflows', 'releases', 'orders', 'links']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  return data;
}

function load() {
  let text;
  try {
    text = fs.readFileSync(dataFile, 'utf8');
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件读不出来，请检查 data/db.json 是否还在');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件解析失败，请检查 data/db.json 的内容');
  }
  return normalize(raw);
}

function save(data) {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
}

function nextId(prefix, list) {
  let max = 0;
  for (const item of list || []) {
    const matched = String(item.id || '').match(/(\d+)$/);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return prefix + '-' + String(max + 1).padStart(4, '0');
}

function todayIso() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
}

function round(n, digits) {
  const d = digits == null ? 4 : digits;
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(d));
}

// 两个日期之间相差的天数
function daysBetween(from, to) {
  const a = String(from || '').split('-').map(Number);
  const b = String(to || '').split('-').map(Number);
  if (a.length !== 3 || b.length !== 3) return 0;
  const start = Date.UTC(a[0], a[1] - 1, a[2]);
  const end = Date.UTC(b[0], b[1] - 1, b[2]);
  return Math.round((end - start) / 86400000);
}

// 日期加减天数，返回 年-月-日
function addDays(dateStr, n) {
  const parts = String(dateStr || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x))) return '';
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}

module.exports = { load, save, nextId, normalize, todayIso, round, daysBetween, addDays, DEFAULT_SETTINGS, DEFAULT_JOINT_CONTROL, dataFile };
