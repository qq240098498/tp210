// 梯级联合调度：上下游关系登记、按日传递量、两库合计出库与总控约束
// 口径（与 README 一致）：
//   传递量 = 上游出库流量 × 传递比例，滞后 lagDays 天计入下游入库；
//   合计出库 = 联合调度组（登记了上下游关系的水库）当日出库流量之和；
//   余量 = 总出库上限 − 当日合计出库；
//   登记出库让某日合计超过总出库上限或断面要求上限时拦截（409），点名日期与水库；
//   断面要求下限只在页面标注，不拦登记（登记只会让合计变大，不可能把合计登记到下限以下）。
const store = require('./store');
const { AppError } = require('./errors');

// 空值（null/''/undefined）视为「未设定」，不参与约束
function limitOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function controlOf(data) {
  const raw = Object.assign({}, store.DEFAULT_CONTROL, (data && data.control) || {});
  return {
    maxTotalReleaseFlow: limitOf(raw.maxTotalReleaseFlow),
    sectionName: String(raw.sectionName || ''),
    sectionMinFlow: limitOf(raw.sectionMinFlow),
    sectionMaxFlow: limitOf(raw.sectionMaxFlow),
    remark: String(raw.remark || ''),
  };
}

function reservoirName(data, id) {
  const found = (data.reservoirs || []).find((r) => r.id === id);
  return found ? found.name : '';
}

function decorateLink(data, link) {
  return Object.assign({}, link, {
    upstreamName: reservoirName(data, link.upstreamId),
    downstreamName: reservoirName(data, link.downstreamId),
  });
}

function listLinks(data) {
  return (data.links || []).map((link) => decorateLink(data, link));
}

// 联合调度组：登记了上下游关系的水库；一条都没有时按全部水库
function cascadeReservoirs(data) {
  const ids = [];
  for (const link of data.links || []) {
    if (ids.indexOf(link.upstreamId) < 0) ids.push(link.upstreamId);
    if (ids.indexOf(link.downstreamId) < 0) ids.push(link.downstreamId);
  }
  const pool = ids.length ? ids : (data.reservoirs || []).map((r) => r.id);
  return (data.reservoirs || []).filter((r) => pool.indexOf(r.id) >= 0);
}

// 出库流量按 日期 -> 水库 汇总（同库同日可有多条）
function releaseMap(data) {
  const byDay = {};
  for (const row of data.releases || []) {
    const date = String(row.date);
    if (!byDay[date]) byDay[date] = {};
    byDay[date][row.reservoirId] = store.round((byDay[date][row.reservoirId] || 0) + Number(row.flow), 3);
  }
  return byDay;
}

function releaseOn(byDay, reservoirId, date) {
  const day = byDay[date];
  if (!day) return 0;
  const value = day[reservoirId];
  return value === undefined ? 0 : value;
}

function totalOn(byDay, reservoirs, date) {
  let total = 0;
  for (const r of reservoirs) total += releaseOn(byDay, r.id, date);
  return store.round(total, 3);
}

// 流量（m³/s）按每天 86400 秒折算成水量（万m³），与水量平衡同一口径
function flowToWan(flow) {
  return store.round((Number(flow) * 86400) / 10000, 3);
}

// 登记出库前的总控拦截：合计超过上限类约束时抛 409，点名是哪一天、哪一库造成的
function assertReleaseAllowed(data, reservoirId, date, flow) {
  const group = cascadeReservoirs(data);
  if (!group.some((r) => r.id === reservoirId)) return; // 不在联合调度组里的库不参与合计
  const control = controlOf(data);
  const byDay = releaseMap(data);
  const before = totalOn(byDay, group, date);
  const after = store.round(before + Number(flow), 3);
  const name = reservoirName(data, reservoirId);
  const cause = '造成超限的是「' + name + '」在 ' + date + ' 登记的这 ' + Number(flow) + ' m³/s';
  if (control.maxTotalReleaseFlow !== null && after > control.maxTotalReleaseFlow) {
    const over = store.round(after - control.maxTotalReleaseFlow, 3);
    throw new AppError(
      409,
      'TOTAL_RELEASE_LIMIT_EXCEEDED',
      '已拦下：' + date + ' 联合调度组合计出库将达 ' + after + ' m³/s，超过总出库上限 '
        + control.maxTotalReleaseFlow + ' m³/s（超出 ' + over + '）。' + cause + '，请下调该库当日出库或改期。',
      {
        reservoirId: '「' + name + '」这笔出库让 ' + date + ' 的合计超过总出库上限',
        date: date + ' 合计出库将达 ' + after + ' m³/s，超上限 ' + over + ' m³/s',
        flow: '登记后合计 ' + after + ' m³/s > 总出库上限 ' + control.maxTotalReleaseFlow + ' m³/s',
      }
    );
  }
  if (control.sectionMaxFlow !== null && after > control.sectionMaxFlow) {
    const over = store.round(after - control.sectionMaxFlow, 3);
    const section = control.sectionName || '下游控制断面';
    throw new AppError(
      409,
      'SECTION_MAX_EXCEEDED',
      '已拦下：' + date + ' 联合调度组合计出库将达 ' + after + ' m³/s，超过' + section + '要求上限 '
        + control.sectionMaxFlow + ' m³/s（超出 ' + over + '）。' + cause + '，请下调该库当日出库或改期。',
      {
        reservoirId: '「' + name + '」这笔出库让 ' + date + ' 的合计超过断面要求上限',
        date: date + ' 合计出库将达 ' + after + ' m³/s，超断面要求上限 ' + over + ' m³/s',
        flow: '登记后合计 ' + after + ' m³/s > 断面要求上限 ' + control.sectionMaxFlow + ' m³/s',
      }
    );
  }
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

// 按日联合调度：逐日给出各库出库、传递量、合计出库、余量与超限明细
function daily(data, query) {
  const q = query || {};
  const control = controlOf(data);
  const links = listLinks(data);
  const byDay = releaseMap(data);
  const dates = (data.releases || []).map((r) => String(r.date)).sort();
  const latest = dates.length ? dates[dates.length - 1] : store.todayIso();
  const from = validDate(q.from) ? String(q.from) : store.addDays(latest, -13);
  const to = validDate(q.to) ? String(q.to) : latest;
  if (to < from) {
    throw new AppError(400, 'INVALID_PAYLOAD', '结束日期不能早于起始日期', { to: '结束日期不能早于起始日期' });
  }
  if (store.daysBetween(from, to) > 366) {
    throw new AppError(400, 'INVALID_PAYLOAD', '窗口最长 366 天，请缩小起止日期', { to: '窗口最长 366 天' });
  }

  const group = cascadeReservoirs(data);
  const reservoirs = group.map((r) => ({ id: r.id, code: r.code, name: r.name }));
  const section = control.sectionName || '下游控制断面';
  const days = [];
  const allViolations = [];
  let windowTotalWan = 0;
  let maxDay = null;
  let minMargin = null;
  let minMarginDate = '';

  for (let date = from; date <= to; date = store.addDays(date, 1)) {
    const releases = {};
    for (const r of reservoirs) releases[r.id] = releaseOn(byDay, r.id, date);
    const totalRelease = totalOn(byDay, reservoirs, date);
    const totalReleaseWan = flowToWan(totalRelease);
    windowTotalWan = store.round(windowTotalWan + totalReleaseWan, 3);

    // 当日到达下游的传递量：来源日是 lagDays 天前的上游出库
    const transfers = links.map((link) => {
      const sourceDate = store.addDays(date, -Number(link.lagDays));
      const upstreamRelease = releaseOn(byDay, link.upstreamId, sourceDate);
      const amount = store.round(upstreamRelease * Number(link.ratio), 3);
      return {
        linkId: link.id,
        upstreamId: link.upstreamId,
        upstreamName: link.upstreamName,
        downstreamId: link.downstreamId,
        downstreamName: link.downstreamName,
        lagDays: Number(link.lagDays),
        sourceDate,
        upstreamRelease,
        ratio: Number(link.ratio),
        amount,
        amountWan: flowToWan(amount),
      };
    });
    const transferTotal = store.round(transfers.reduce((s, t) => s + t.amount, 0), 3);

    const margin = control.maxTotalReleaseFlow === null ? null : store.round(control.maxTotalReleaseFlow - totalRelease, 3);

    // 超限要指出是哪一天、哪一库造成的：列出当天各库出库，最大的记为主因
    const contributors = reservoirs
      .map((r) => ({ id: r.id, name: r.name, flow: releases[r.id] }))
      .filter((c) => c.flow > 0)
      .sort((a, b) => b.flow - a.flow);
    const contributorText = contributors.length
      ? contributors.map((c) => c.name + ' ' + c.flow + ' m³/s').join('、')
      : '各库当日均无出库';
    const main = contributors.length ? contributors[0] : null;
    const mainText = main ? '，主要是「' + main.name + '」造成的' : '';

    const violations = [];
    if (control.maxTotalReleaseFlow !== null && totalRelease > control.maxTotalReleaseFlow) {
      violations.push({
        type: 'TOTAL_LIMIT',
        date,
        mainContributor: main ? main.name : '',
        message: date + ' 合计出库 ' + totalRelease + ' m³/s 超总出库上限 ' + control.maxTotalReleaseFlow
          + ' m³/s（超出 ' + store.round(totalRelease - control.maxTotalReleaseFlow, 3) + '）；当天出库：' + contributorText + mainText,
      });
    }
    if (control.sectionMaxFlow !== null && totalRelease > control.sectionMaxFlow) {
      violations.push({
        type: 'SECTION_MAX',
        date,
        mainContributor: main ? main.name : '',
        message: date + ' 合计出库 ' + totalRelease + ' m³/s 超' + section + '要求上限 ' + control.sectionMaxFlow
          + ' m³/s（超出 ' + store.round(totalRelease - control.sectionMaxFlow, 3) + '）；当天出库：' + contributorText + mainText,
      });
    }
    if (control.sectionMinFlow !== null && totalRelease < control.sectionMinFlow) {
      violations.push({
        type: 'SECTION_MIN',
        date,
        mainContributor: '',
        message: date + ' 合计出库 ' + totalRelease + ' m³/s 低于' + section + '要求下限 ' + control.sectionMinFlow
          + ' m³/s（差 ' + store.round(control.sectionMinFlow - totalRelease, 3) + '）；当天出库：' + contributorText,
      });
    }

    let sectionState = '未设断面要求';
    if (control.sectionMinFlow !== null || control.sectionMaxFlow !== null) {
      if (control.sectionMaxFlow !== null && totalRelease > control.sectionMaxFlow) sectionState = '高于断面上限';
      else if (control.sectionMinFlow !== null && totalRelease < control.sectionMinFlow) sectionState = '低于断面下限';
      else sectionState = '正常';
    }

    for (const v of violations) allViolations.push(v);
    if (!maxDay || totalRelease > maxDay.totalRelease) maxDay = { date, totalRelease };
    if (margin !== null && (minMargin === null || margin < minMargin)) {
      minMargin = margin;
      minMarginDate = date;
    }

    days.push({
      date,
      releases,
      totalRelease,
      totalReleaseWan,
      maxTotalReleaseFlow: control.maxTotalReleaseFlow,
      margin,
      sectionName: control.sectionName,
      sectionMinFlow: control.sectionMinFlow,
      sectionMaxFlow: control.sectionMaxFlow,
      sectionState,
      transfers,
      transferTotal,
      transferTotalWan: flowToWan(transferTotal),
      ok: violations.length === 0,
      violations,
    });
  }

  // 当前：窗口内含今天取今天，否则取窗口最后一天
  const today = store.todayIso();
  const currentDate = today >= from && today <= to ? today : to;
  const currentDay = days.find((d) => d.date === currentDate) || days[days.length - 1] || null;

  return {
    from,
    to,
    control,
    links,
    reservoirs,
    days,
    current: currentDay
      ? {
          date: currentDay.date,
          totalRelease: currentDay.totalRelease,
          totalReleaseWan: currentDay.totalReleaseWan,
          maxTotalReleaseFlow: currentDay.maxTotalReleaseFlow,
          margin: currentDay.margin,
          sectionName: control.sectionName,
          sectionMinFlow: control.sectionMinFlow,
          sectionMaxFlow: control.sectionMaxFlow,
          sectionState: currentDay.sectionState,
        }
      : null,
    summary: {
      dayCount: days.length,
      totalReleaseWan: windowTotalWan,
      maxDay,
      minMargin,
      minMarginDate,
      violationDays: days.filter((d) => !d.ok).length,
      violations: allViolations,
    },
  };
}

// 从 fromId 沿已登记的下游方向走，能否走到 toId（用来挡循环关系）
function reaches(links, fromId, toId) {
  const seen = {};
  const stack = [fromId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === toId) return true;
    if (seen[cur]) continue;
    seen[cur] = true;
    for (const link of links) {
      if (link.upstreamId === cur) stack.push(link.downstreamId);
    }
  }
  return false;
}

function createLink(data, payload) {
  const body = payload || {};
  const errors = {};
  const upstream = (data.reservoirs || []).find((r) => r.id === body.upstreamId);
  const downstream = (data.reservoirs || []).find((r) => r.id === body.downstreamId);
  if (!upstream) errors.upstreamId = '上游水库不存在，请重新选择';
  if (!downstream) errors.downstreamId = '下游水库不存在，请重新选择';
  if (upstream && downstream && upstream.id === downstream.id) errors.downstreamId = '下游水库不能和上游是同一座';
  const lagDays = Number(body.lagDays);
  if (!Number.isInteger(lagDays) || lagDays < 0 || lagDays > 30) errors.lagDays = '传递时长要填 0 到 30 的整数天';
  const ratio = Number(body.ratio);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) errors.ratio = '传递比例要大于 0 且不超过 1';
  if (upstream && downstream && upstream.id !== downstream.id) {
    if ((data.links || []).some((l) => l.upstreamId === upstream.id && l.downstreamId === downstream.id)) {
      errors.downstreamId = '这两座水库的上下游关系已经登记过了';
    } else if (reaches(data.links || [], downstream.id, upstream.id)) {
      errors.downstreamId = '这样登记会形成循环的上下游关系';
    }
  }
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '上下游关系没通过校验，请按提示补齐', errors);
  }
  const link = {
    id: store.nextId('link', data.links),
    upstreamId: upstream.id,
    downstreamId: downstream.id,
    lagDays,
    ratio,
    remark: String(body.remark || ''),
  };
  data.links.push(link);
  return decorateLink(data, link);
}

function removeLink(data, id) {
  const found = (data.links || []).find((l) => l.id === id);
  if (!found) throw new AppError(404, 'LINK_NOT_FOUND', '这条上下游关系不存在');
  data.links = data.links.filter((l) => l.id !== id);
  return { removed: id };
}

function parseLimitField(value, field, errors, positive) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || (positive && n <= 0) || (!positive && n < 0)) {
    errors[field] = positive ? '要填正数，留空表示不设' : '要填非负数字，留空表示不设';
    return null;
  }
  return n;
}

function saveControl(data, payload) {
  const body = payload || {};
  const errors = {};
  const maxTotal = parseLimitField(body.maxTotalReleaseFlow, 'maxTotalReleaseFlow', errors, true);
  const sectionMin = parseLimitField(body.sectionMinFlow, 'sectionMinFlow', errors, false);
  const sectionMax = parseLimitField(body.sectionMaxFlow, 'sectionMaxFlow', errors, true);
  if (sectionMin !== null && sectionMax !== null && sectionMin > sectionMax) {
    errors.sectionMinFlow = '断面要求下限不能高于断面要求上限';
  }
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '总控约束没通过校验，请按提示补齐', errors);
  }
  data.control = {
    maxTotalReleaseFlow: maxTotal,
    sectionName: String(body.sectionName || '').trim(),
    sectionMinFlow: sectionMin,
    sectionMaxFlow: sectionMax,
    remark: String(body.remark || ''),
  };
  return controlOf(data);
}

module.exports = {
  controlOf,
  listLinks,
  createLink,
  removeLink,
  saveControl,
  daily,
  assertReleaseAllowed,
  cascadeReservoirs,
};
