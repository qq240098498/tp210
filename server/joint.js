// 联合调度：上下游关系、传递量、两库合计出库与总控约束都集中在这里
const { AppError } = require('./errors');
const store = require('./store');

// 总控约束（数字都强制转成 Number，单位 m³/s，按日考核）
function controlOf(data) {
  const raw = data.jointControl || {};
  return {
    maxTotalReleaseFlow: Number(raw.maxTotalReleaseFlow),
    sectionName: String(raw.sectionName || ''),
    sectionMinFlow: Number(raw.sectionMinFlow),
    sectionMaxFlow: Number(raw.sectionMaxFlow),
  };
}

// 联合体成员：登记了上下游关系的所有水库；一条关系都没有时按全部水库算
function membersOf(data) {
  const ids = [];
  for (const link of data.links) {
    if (ids.indexOf(link.upstreamId) < 0) ids.push(link.upstreamId);
    if (ids.indexOf(link.downstreamId) < 0) ids.push(link.downstreamId);
  }
  const source = ids.length ? ids : data.reservoirs.map((r) => r.id);
  return source
    .map((id) => data.reservoirs.find((r) => r.id === id))
    .filter(Boolean)
    .map((r) => ({ id: r.id, code: r.code, name: r.name }));
}

function reservoirName(data, id) {
  const found = data.reservoirs.find((r) => r.id === id);
  return found ? found.name : id;
}

function decorateLink(data, link) {
  return Object.assign({}, link, {
    upstreamName: reservoirName(data, link.upstreamId),
    downstreamName: reservoirName(data, link.downstreamId),
  });
}

function listLinks(data) {
  return data.links.map((link) => decorateLink(data, link));
}

function validateLink(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  const upstreamId = String(merged.upstreamId || '');
  const downstreamId = String(merged.downstreamId || '');
  if (!data.reservoirs.some((r) => r.id === upstreamId)) errors.upstreamId = '上游水库不存在';
  if (!data.reservoirs.some((r) => r.id === downstreamId)) errors.downstreamId = '下游水库不存在';
  if (upstreamId && downstreamId && upstreamId === downstreamId) errors.downstreamId = '上下游不能是同一座水库';
  const lagDays = Number(merged.lagDays);
  if (!Number.isInteger(lagDays) || lagDays < 0) errors.lagDays = '传递时长要填不小于 0 的整数天';
  const ratio = Number(merged.ratio);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) errors.ratio = '传递比例要填 0 到 1 之间的小数';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '上下游关系没通过校验，请按提示补齐', errors);
  }
  return { upstreamId, downstreamId, lagDays, ratio, remark: String(merged.remark || '').trim() };
}

function createLink(data, payload) {
  const value = validateLink(data, payload, null);
  const duplicated = data.links.some((l) => l.upstreamId === value.upstreamId && l.downstreamId === value.downstreamId);
  if (duplicated) {
    throw new AppError(409, 'LINK_EXISTS', reservoirName(data, value.upstreamId) + ' 到 ' + reservoirName(data, value.downstreamId) + ' 的关系已经登记过了');
  }
  const link = {
    id: store.nextId('link', data.links),
    upstreamId: value.upstreamId,
    downstreamId: value.downstreamId,
    lagDays: value.lagDays,
    ratio: value.ratio,
    remark: value.remark,
  };
  data.links.push(link);
  return decorateLink(data, link);
}

function updateLink(data, id, payload) {
  const link = data.links.find((l) => l.id === id);
  if (!link) throw new AppError(404, 'LINK_NOT_FOUND', '这条上下游关系不存在');
  const value = validateLink(data, payload, link);
  const duplicated = data.links.some(
    (l) => l.id !== id && l.upstreamId === value.upstreamId && l.downstreamId === value.downstreamId
  );
  if (duplicated) {
    throw new AppError(409, 'LINK_EXISTS', reservoirName(data, value.upstreamId) + ' 到 ' + reservoirName(data, value.downstreamId) + ' 的关系已经登记过了');
  }
  Object.assign(link, value);
  return decorateLink(data, link);
}

function removeLink(data, id) {
  const found = data.links.find((l) => l.id === id);
  if (!found) throw new AppError(404, 'LINK_NOT_FOUND', '这条上下游关系不存在');
  data.links = data.links.filter((l) => l.id !== id);
  return { removed: id };
}

function saveControl(data, payload) {
  const merged = Object.assign({}, controlOf(data), payload || {});
  const errors = {};
  const maxTotalReleaseFlow = Number(merged.maxTotalReleaseFlow);
  if (!Number.isFinite(maxTotalReleaseFlow) || maxTotalReleaseFlow <= 0) errors.maxTotalReleaseFlow = '总出库上限要填正数';
  const sectionMinFlow = Number(merged.sectionMinFlow);
  if (!Number.isFinite(sectionMinFlow) || sectionMinFlow < 0) errors.sectionMinFlow = '断面最小流量要填非负数字';
  const sectionMaxFlow = Number(merged.sectionMaxFlow);
  if (!Number.isFinite(sectionMaxFlow) || sectionMaxFlow <= 0) errors.sectionMaxFlow = '断面最大流量要填正数';
  if (Number.isFinite(sectionMinFlow) && Number.isFinite(sectionMaxFlow) && sectionMinFlow > sectionMaxFlow) {
    errors.sectionMaxFlow = '断面最大流量不能小于断面最小流量';
  }
  const sectionName = String(merged.sectionName || '').trim();
  if (!sectionName) errors.sectionName = '控制断面名称不能为空';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '总控约束没通过校验，请按提示补齐', errors);
  }
  data.jointControl = { maxTotalReleaseFlow, sectionName, sectionMinFlow, sectionMaxFlow };
  return controlOf(data);
}

// 某库某日的出库流量合计（一天可能有多条出库记录）
function dayRelease(data, reservoirId, date) {
  return data.releases
    .filter((r) => r.reservoirId === reservoirId && r.date === date)
    .reduce((s, r) => s + Number(r.flow), 0);
}

// 一天的联合调度行：各库出库、传递量、合计、余量、断面与状态
function dayRow(data, date) {
  const control = controlOf(data);
  const members = membersOf(data);
  const releases = {};
  let totalFlow = 0;
  for (const m of members) {
    const value = store.round(dayRelease(data, m.id, date), 3);
    releases[m.id] = value;
    totalFlow += value;
  }
  totalFlow = store.round(totalFlow, 3);
  const totalVolumeWan = store.round((totalFlow * 86400) / 10000, 3);

  // 传递量：上游出库 × 比例，lagDays 天后到达下游入库；每日同时给「发出」与「到达」两个口径
  const transferOut = [];
  const transferIn = [];
  for (const link of data.links) {
    const outFlow = store.round(dayRelease(data, link.upstreamId, date) * Number(link.ratio), 3);
    transferOut.push({
      linkId: link.id,
      upstreamId: link.upstreamId,
      upstreamName: reservoirName(data, link.upstreamId),
      downstreamId: link.downstreamId,
      downstreamName: reservoirName(data, link.downstreamId),
      releaseDate: date,
      arriveDate: store.addDays(date, Number(link.lagDays)),
      flow: outFlow,
      volumeWan: store.round((outFlow * 86400) / 10000, 3),
    });
    const releaseDate = store.addDays(date, -Number(link.lagDays));
    const inFlow = store.round(dayRelease(data, link.upstreamId, releaseDate) * Number(link.ratio), 3);
    transferIn.push({
      linkId: link.id,
      upstreamId: link.upstreamId,
      upstreamName: reservoirName(data, link.upstreamId),
      downstreamId: link.downstreamId,
      downstreamName: reservoirName(data, link.downstreamId),
      releaseDate,
      arriveDate: date,
      flow: inFlow,
      volumeWan: store.round((inFlow * 86400) / 10000, 3),
    });
  }

  const cap = control.maxTotalReleaseFlow;
  const margin = store.round(cap - totalFlow, 3);
  const exceeded = totalFlow > cap;
  let sectionState = '正常';
  if (totalFlow < control.sectionMinFlow) sectionState = '低于断面要求';
  else if (totalFlow > control.sectionMaxFlow) sectionState = '高于断面要求';
  return {
    date,
    releases,
    totalFlow,
    totalVolumeWan,
    transferOut,
    transferIn,
    cap,
    margin,
    exceeded,
    section: {
      name: control.sectionName,
      minFlow: control.sectionMinFlow,
      maxFlow: control.sectionMaxFlow,
      flow: totalFlow,
      ok: sectionState === '正常',
      state: sectionState,
    },
    status: exceeded ? '超出上限' : sectionState,
  };
}

// 当前状态：取不晚于今天、且有出库记录的最近一天；都没有就用今天
function currentStatus(data) {
  const members = membersOf(data);
  const memberIds = members.map((m) => m.id);
  const dates = data.releases.filter((r) => memberIds.indexOf(r.reservoirId) >= 0).map((r) => r.date);
  const today = store.todayIso();
  let current = dates.filter((d) => d <= today).sort().slice(-1)[0];
  if (!current) current = dates.sort().slice(-1)[0] || today;
  return dayRow(data, current);
}

function overview(data) {
  return {
    control: controlOf(data),
    links: listLinks(data),
    members: membersOf(data),
    current: currentStatus(data),
  };
}

function plan(data, from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to || ''))) {
    throw new AppError(400, 'INVALID_PAYLOAD', '请给出起止日期（年-月-日）');
  }
  if (to < from) throw new AppError(400, 'INVALID_PAYLOAD', '结束日期不能早于起始日期');
  const days = [];
  const span = store.daysBetween(from, to);
  for (let i = 0; i <= span; i += 1) {
    days.push(dayRow(data, store.addDays(from, i)));
  }
  const exceededDays = days.filter((d) => d.exceeded).length;
  return {
    from,
    to,
    control: controlOf(data),
    links: listLinks(data),
    members: membersOf(data),
    days,
    summary: {
      dayCount: days.length,
      totalVolumeWan: store.round(days.reduce((s, d) => s + d.totalVolumeWan, 0), 3),
      meanTotalFlow: store.round(days.reduce((s, d) => s + d.totalFlow, 0) / Math.max(1, days.length), 3),
      exceededDays,
      sectionBadDays: days.filter((d) => !d.section.ok).length,
    },
  };
}

// 登记出库流量时的总控拦截：当日合计超过上限就拦下，并点名是哪一天、哪一座库
function checkRelease(data, reservoirId, date, addedFlow) {
  const control = controlOf(data);
  const cap = Number(control.maxTotalReleaseFlow);
  if (!Number.isFinite(cap) || cap <= 0) return;
  const members = membersOf(data);
  if (!members.some((m) => m.id === reservoirId)) return;
  const totalBefore = members.reduce((s, m) => s + dayRelease(data, m.id, date), 0);
  const totalAfter = store.round(totalBefore + Number(addedFlow), 3);
  if (totalAfter <= cap) return;
  const name = reservoirName(data, reservoirId);
  const over = store.round(totalAfter - cap, 3);
  throw new AppError(
    409,
    'JOINT_LIMIT_EXCEEDED',
    '已拦下：' + date + ' ' + name + ' 再出库 ' + addedFlow + ' m³/s 后，联合体当日合计出库 '
      + totalAfter + ' m³/s，超过总出库上限 ' + cap + ' m³/s（超出 ' + over + '）',
    {
      date: date + ' 当日合计出库超上限',
      reservoirId: name + ' 这笔出库导致超限',
      flow: '加上这笔后合计 ' + totalAfter + '，上限 ' + cap + '，超出 ' + over,
    }
  );
}

module.exports = {
  controlOf,
  membersOf,
  listLinks,
  createLink,
  updateLink,
  removeLink,
  saveControl,
  dayRelease,
  dayRow,
  currentStatus,
  overview,
  plan,
  checkRelease,
};
