/*
  比特币定投（DCA）策略实验室
  - 数据: ./public/btc-price.csv（已裁剪 2017-01-01 至 2025-11-01）
  - 图表: Chart.js + date-fns 适配
  - 策略: DCA、一次性买入、逢跌买入、趋势定投
*/

const state = {
  raw: [],           // [{t: Date, p: number}] ascending by date
  start: null,
  end: null,
  charts: {},
};

async function loadCSV() {
  const res = await fetch('./public/btc-price.csv');
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const [d, p] = lines[i].split(',');
    const date = new Date(d.trim());
    const price = Number(p.trim());
    if (!isNaN(date) && !isNaN(price)) out.push({ t: date, p: price });
  }
  // 文件是按日期倒序，翻转为升序
  out.sort((a, b) => a.t - b.t);
  return out;
}

function clampRange(data, start, end) {
  return data.filter(d => d.t >= start && d.t <= end);
}

function fmtUSD(n) {
  if (!isFinite(n)) return '-';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}
function fmtPct(x) {
  if (!isFinite(x)) return '-';
  return (x * 100).toFixed(2) + '%';
}
function daysBetween(a, b) { return (b - a) / 86400000; }

// 计算简单移动平均
function sma(arr, window) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= window) sum -= arr[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

// 生成频率下的买入日期索引
function buildScheduleIdx(data, start, end, frequency) {
  const idx = [];
  let iStart = data.findIndex(d => d.t >= start);
  if (iStart < 0) return idx;
  let cursor = new Date(data[iStart].t);
  const lastDate = data[data.length - 1].t;
  const endDate = end <= lastDate ? end : lastDate;

  const stepDays = frequency === 'daily' ? 1 : (frequency === 'weekly' ? 7 : 30);
  while (cursor <= endDate) {
    // 找到 cursor 最接近且不小于 cursor 的索引
    let j = iStart;
    while (j < data.length && data[j].t < cursor) j++;
    if (j < data.length && data[j].t <= endDate) idx.push(j);
    cursor = new Date(cursor.getTime() + stepDays * 86400000);
  }
  return idx;
}

function simulateDCA(data, start, end, amount, frequency) {
  const schedule = buildScheduleIdx(data, start, end, frequency);
  let cashIn = 0, units = 0;
  const timeline = [];
  let sPtr = 0; // 指向下一个买点索引

  for (let i = 0; i < data.length; i++) {
    const { t, p } = data[i];
    if (t < start || t > end) continue;

    if (sPtr < schedule.length && i === schedule[sPtr]) {
      cashIn += amount;
      const buyUnits = amount / p;
      units += buyUnits;
      sPtr++;
    }
    const value = units * p;
    timeline.push({ t, p, cashIn, units, value });
  }
  return { timeline, result: { cashIn, units, endValue: timeline.at(-1)?.value || 0 } };
}

function simulateLumpSum(data, start, end, amount, frequency) {
  // 取与 DCA 同等总投入：期数 × 金额
  const periods = buildScheduleIdx(data, start, end, frequency).length;
  const total = periods * amount;
  // 在起始日（或之后的第一个可交易日）一次性买入
  const iStart = data.findIndex(d => d.t >= start);
  if (iStart < 0) return { timeline: [], result: { cashIn: 0, units: 0, endValue: 0 } };
  const startPrice = data[iStart].p;
  const units = total / startPrice;
  const timeline = [];
  for (let i = iStart; i < data.length && data[i].t <= end; i++) {
    const { t, p } = data[i];
    timeline.push({ t, p, cashIn: total, units, value: units * p });
  }
  return { timeline, result: { cashIn: total, units, endValue: timeline.at(-1)?.value || 0 } };
}

function simulateDipBuy(data, start, end, amount, frequency, dipPct = 0.2) {
  // 每期先累积现金，遇到从近高点的回撤 >= dipPct 时，用全部现金买入
  const schedule = buildScheduleIdx(data, start, end, frequency);
  const scheduleSet = new Set(schedule);
  let cashIn = 0, units = 0, cashPile = 0;
  const timeline = [];
  let peak = -Infinity;

  for (let i = 0; i < data.length; i++) {
    const { t, p } = data[i];
    if (t < start || t > end) continue;

    // 定期增加现金
    if (scheduleSet.has(i)) { cashIn += amount; cashPile += amount; }

    peak = Math.max(peak, p);
    const drawdown = (peak - p) / peak; // 相对近高回撤

    if (isFinite(drawdown) && drawdown >= dipPct && cashPile > 0) {
      const buyUnits = cashPile / p;
      units += buyUnits;
      cashPile = 0;
    }

    const value = units * p + cashPile; // 剩余现金也计入组合价值
    timeline.push({ t, p, cashIn, units, value, cashPile });
  }
  return { timeline, result: { cashIn, units, endValue: timeline.at(-1)?.value || 0 } };
}

function simulateTrendDCA(data, start, end, amount, frequency, maN = 200) {
  const prices = data.map(d => d.p);
  const ma = sma(prices, maN);
  const schedule = buildScheduleIdx(data, start, end, frequency);
  const scheduleSet = new Set(schedule);

  let cashIn = 0, units = 0, cashPile = 0;
  const timeline = [];

  for (let i = 0; i < data.length; i++) {
    const { t, p } = data[i];
    if (t < start || t > end) continue;

    if (scheduleSet.has(i)) { cashIn += amount; cashPile += amount; }

    if (i >= maN - 1 && p > ma[i] && cashPile > 0) {
      const buyUnits = cashPile / p;
      units += buyUnits;
      cashPile = 0;
    }

    const value = units * p + cashPile;
    timeline.push({ t, p, cashIn, units, value, cashPile, ma: ma[i] });
  }
  return { timeline, result: { cashIn, units, endValue: timeline.at(-1)?.value || 0 } };
}

// 指标计算
function metricsFromTimeline(tl) {
  if (!tl.length) return {};
  const cashIn = tl.at(-1).cashIn || 0;
  const endValue = tl.at(-1).value || 0;
  const startDate = tl[0].t, endDate = tl.at(-1).t;
  const years = daysBetween(startDate, endDate) / 365.25;
  const pnl = endValue - cashIn;
  const rtn = cashIn > 0 ? (endValue / cashIn - 1) : 0;
  const cagr = (cashIn > 0 && years > 0) ? (Math.pow(endValue / cashIn, 1 / years) - 1) : 0;

  // 组合价值的日度收益（含现金在内的总价值）
  const rets = [];
  for (let i = 1; i < tl.length; i++) {
    const prev = tl[i - 1].value;
    const cur = tl[i].value;
    const r = prev > 0 ? (cur / prev - 1) : 0;
    if (isFinite(r)) rets.push(r);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / (Math.max(1, rets.length - 1));
  const volDaily = Math.sqrt(Math.max(0, variance));
  const volAnn = volDaily * Math.sqrt(365);
  const sharpe = volAnn > 0 ? (cagr / volAnn) : 0; // 无风险收益视作 0

  // 最大回撤（基于组合价值）
  let peak = -Infinity, mdd = 0;
  for (const p of tl.map(x => x.value)) {
    peak = Math.max(peak, p);
    if (peak > 0) mdd = Math.min(mdd, p / peak - 1);
  }

  return { cashIn, endValue, pnl, rtn, cagr, volAnn, sharpe, mdd };
}

function renderMetrics(el, m) {
  const items = [
    ['总投入', fmtUSD(m.cashIn)],
    ['期末价值', fmtUSD(m.endValue)],
    ['净收益', fmtUSD(m.pnl)],
    ['总收益率', fmtPct(m.rtn)],
    ['年化收益率（CAGR）', fmtPct(m.cagr)],
    ['年化波动率', fmtPct(m.volAnn)],
    ['夏普比率（≈）', (isFinite(m.sharpe) ? m.sharpe.toFixed(2) : '-')],
    ['最大回撤', fmtPct(m.mdd)],
  ];
  el.innerHTML = items.map(([k, v]) => `<li><strong>${k}：</strong>${v}</li>`).join('');
}

function drawdownSeries(tl) {
  let peak = -Infinity;
  return tl.map(({ t, value }) => {
    peak = Math.max(peak, value);
    const dd = peak > 0 ? (value / peak - 1) : 0;
    return { t, dd };
  });
}

function ensureCharts() {
  const gridColor = 'rgba(255,255,255,0.12)';
  const timeScale = { type: 'time', time: { unit: 'month' }, grid: { color: gridColor } };
  const linearScale = { type: 'linear', grid: { color: gridColor } };

  if (!state.charts.price) {
    state.charts.price = new Chart(document.getElementById('priceChart'), {
      type: 'line',
      data: { datasets: [] },
      options: { responsive: true, animation: false, parsing: false,
        scales: { x: timeScale, y: { ...linearScale, ticks: { callback: v => '$' + v } } },
        plugins: { legend: { labels: { color: '#dbe7ff' } } }
      }
    });
  }
  if (!state.charts.value) {
    state.charts.value = new Chart(document.getElementById('valueChart'), {
      type: 'line', data: { datasets: [] },
      options: { responsive: true, animation: false, parsing: false,
        scales: { x: timeScale, y: { ...linearScale, ticks: { callback: v => '$' + v } } },
        plugins: { legend: { labels: { color: '#dbe7ff' } } }
      }
    });
  }
  if (!state.charts.dd) {
    state.charts.dd = new Chart(document.getElementById('ddChart'), {
      type: 'line', data: { datasets: [] },
      options: { responsive: true, animation: false, parsing: false,
        scales: { x: timeScale, y: { ...linearScale, ticks: { callback: v => (v*100).toFixed(0)+'%' } } },
        plugins: { legend: { labels: { color: '#dbe7ff' } } }
      }
    });
  }
  if (!state.charts.contrib) {
    state.charts.contrib = new Chart(document.getElementById('contribChart'), {
      type: 'line', data: { datasets: [] },
      options: { responsive: true, animation: false, parsing: false,
        scales: { x: timeScale, y: { ...linearScale, ticks: { callback: v => '$' + v } } },
        plugins: { legend: { labels: { color: '#dbe7ff' } } }
      }
    });
  }
}

function updateCharts(priceTl, dca, ls, dip, trend) {
  const priceDs = priceTl.map(({ t, p }) => ({ x: t, y: p }));
  const buyMarkers = dca.timeline.filter((x, i, arr) => i===0 || x.units > arr[i-1].units).map(({ t, p }) => ({ x: t, y: p }));

  state.charts.price.data.datasets = [
    { label: 'BTC 价格', data: priceDs, borderColor: '#3b82f6', pointRadius: 0, tension: .1 },
    { label: 'DCA 买入点', data: buyMarkers, type: 'scatter', borderColor: '#22d3ee', backgroundColor: '#22d3ee', pointRadius: 2 }
  ];
  state.charts.price.update();

  const toLine = tl => tl.map(({ t, value }) => ({ x: t, y: value }));
  state.charts.value.data.datasets = [
    { label: 'DCA 定投', data: toLine(dca.timeline), borderColor: '#22d3ee', pointRadius: 0, tension: .1 },
    { label: '一次性买入', data: toLine(ls.timeline), borderColor: '#8b5cf6', pointRadius: 0, tension: .1 },
    { label: '逢跌买入', data: toLine(dip.timeline), borderColor: '#10b981', pointRadius: 0, tension: .1 },
    { label: '趋势定投', data: toLine(trend.timeline), borderColor: '#f59e0b', pointRadius: 0, tension: .1 },
  ];
  state.charts.value.update();

  const toDD = tl => drawdownSeries(tl).map(({ t, dd }) => ({ x: t, y: dd }));
  state.charts.dd.data.datasets = [
    { label: 'DCA 定投', data: toDD(dca.timeline), borderColor: '#22d3ee', pointRadius: 0 },
    { label: '一次性买入', data: toDD(ls.timeline), borderColor: '#8b5cf6', pointRadius: 0 },
    { label: '逢跌买入', data: toDD(dip.timeline), borderColor: '#10b981', pointRadius: 0 },
    { label: '趋势定投', data: toDD(trend.timeline), borderColor: '#f59e0b', pointRadius: 0 },
  ];
  state.charts.dd.update();

  state.charts.contrib.data.datasets = [
    { label: '总投入（DCA）', data: dca.timeline.map(({ t, cashIn }) => ({ x: t, y: cashIn })), borderColor: 'rgba(59,130,246,.8)', backgroundColor: 'rgba(59,130,246,.2)', pointRadius: 0, tension: .1, fill: false },
    { label: '组合价值（DCA）', data: dca.timeline.map(({ t, value }) => ({ x: t, y: value })), borderColor: 'rgba(34,211,238,1)', backgroundColor: 'rgba(34,211,238,.15)', pointRadius: 0, tension: .1, fill: true },
  ];
  state.charts.contrib.update();
}

function refresh() {
  const start = new Date(document.getElementById('startDate').value);
  const end = new Date(document.getElementById('endDate').value);
  const frequency = document.getElementById('frequency').value;
  const amount = Number(document.getElementById('amount').value || 0);
  const dipPct = Number(document.getElementById('dipPct').value || 20) / 100;
  const maDays = Number(document.getElementById('maDays').value || 200);

  const priceTl = clampRange(state.raw, start, end);
  const dca = simulateDCA(state.raw, start, end, amount, frequency);
  const ls = simulateLumpSum(state.raw, start, end, amount, frequency);
  const dip = simulateDipBuy(state.raw, start, end, amount, frequency, dipPct);
  const trend = simulateTrendDCA(state.raw, start, end, amount, frequency, maDays);

  // 指标
  renderMetrics(document.getElementById('metrics-dca'), metricsFromTimeline(dca.timeline));
  renderMetrics(document.getElementById('metrics-ls'), metricsFromTimeline(ls.timeline));
  renderMetrics(document.getElementById('metrics-dip'), metricsFromTimeline(dip.timeline));
  renderMetrics(document.getElementById('metrics-trend'), metricsFromTimeline(trend.timeline));

  updateCharts(priceTl, dca, ls, dip, trend);
}

function initUI() {
  // 填充默认日期范围
  const minDate = state.raw[0].t; // 升序后的最小日期
  const maxDate = state.raw[state.raw.length - 1].t; // 最大日期
  const startEl = document.getElementById('startDate');
  const endEl = document.getElementById('endDate');

  function toYMD(d) { return d.toISOString().slice(0, 10); }
  startEl.min = toYMD(minDate);
  startEl.max = toYMD(maxDate);
  endEl.min = toYMD(minDate);
  endEl.max = toYMD(maxDate);
  startEl.value = toYMD(minDate);
  endEl.value = toYMD(maxDate);

  document.querySelectorAll('.presets button').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.preset;
      if (p === '100w') { document.getElementById('amount').value = 100; document.getElementById('frequency').value = 'weekly'; }
      if (p === '50w') { document.getElementById('amount').value = 50; document.getElementById('frequency').value = 'weekly'; }
      if (p === '500w') { document.getElementById('amount').value = 500; document.getElementById('frequency').value = 'weekly'; }
      refresh();
    });
  });

  document.getElementById('runBacktest').addEventListener('click', refresh);

  // 自动刷新：核心参数变化时
  ['startDate', 'endDate', 'frequency', 'amount', 'dipPct', 'maDays'].forEach(id => {
    document.getElementById(id).addEventListener('change', refresh);
  });
}

async function main() {
  state.raw = await loadCSV();
  ensureCharts();
  initUI();
  refresh();
}

main();
