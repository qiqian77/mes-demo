/*
 * 页面与交互：hash 路由的五个视图 + 抽屉表单 + 演示闭环。
 * 所有页面读同一份 Store.state，任何写入都会即时反映到总览、台账和工单统计。
 */
(function () {
  'use strict';

  var S = null;
  var F = { assetQ: '', assetType: '', assetStatus: '', orderStatus: '', orderSource: '', orderQ: '' };
  var PREDICT = null;
  var LIVE = { points: [], tick: 0, timer: null };
  var highlightOrder = null;
  var ROUTES = ['dashboard', 'signal', 'predict', 'assets', 'orders'];
  var CRUMB = { dashboard: '车间总览', signal: '数据与清洗', predict: '风险预测', assets: '设备台账', orders: '维保工单' };

  /* ---------- helpers ---------- */
  function pad(n, l) { return String(n).padStart(l || 2, '0'); }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmt(iso) {
    var d = new Date(iso);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + d.toTimeString().slice(0, 8);
  }
  function fmtShort(iso) {
    var d = new Date(iso);
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + d.toTimeString().slice(0, 5);
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function dev(id) { return Store.device(id) || { id: id, name: '未知设备', type: '-' }; }
  function levelTag(level) {
    return {
      high: '<span class="tag tag--danger tag--dot">高风险</span>',
      medium: '<span class="tag tag--warn tag--dot">需关注</span>',
      low: '<span class="tag tag--ok tag--dot">正常</span>'
    }[level] || '';
  }
  function riskBar(score) {
    score = Number(score) || 0;
    var lv = score >= 70 ? 'high' : score >= 42 ? 'mid' : 'low';
    var width = Math.max(0, Math.min(100, score));
    var tip = {
      high: '高风险 · 风险分 ' + score + '（≥ 70）\n建议 24 小时内停机检查并准备备件；系统会自动创建维保工单。',
      mid: '需关注 · 风险分 ' + score + '（42–69）\n建议纳入本周巡检，重点观察温升斜率与电流纹波。',
      low: '正常 · 风险分 ' + score + '（< 42）\n各项特征接近基线，按常规周期巡检即可。'
    }[lv] + '\n分级阈值：42 分需关注 / 70 分高风险';
    return '<span class="risk-bar risk-bar--' + lv + '" data-tip="' + esc(tip).replace(/\n/g, '&#10;') + '">' +
      '<span class="risk-bar__track"><span class="risk-bar__fill" style="width:' + width + '%"></span></span>' +
      '<b class="risk-bar__num">' + score + '</b>' +
      (lv === 'high' ? '<span class="risk-bar__alert" aria-label="高风险警告">!</span>' : '') +
      '</span>';
  }
  function statusTag(status) {
    return {
      '待处理': '<span class="tag tag--danger">待处理</span>',
      '处理中': '<span class="tag tag--warn">处理中</span>',
      '已完成': '<span class="tag tag--ok">已完成</span>'
    }[status] || '<span class="tag tag--quiet">' + esc(status) + '</span>';
  }
  function deviceOptions(selected, includeEmpty) {
    var html = includeEmpty ? '<option value="">全部设备</option>' : '';
    return html + S.devices.map(function (d) {
      return '<option value="' + d.id + '"' + (d.id === selected ? ' selected' : '') + '>' + esc(d.id + ' · ' + d.name) + '</option>';
    }).join('');
  }

  /* ---------- UI primitives ---------- */
  function toast(msg, sub, kind) {
    var root = document.getElementById('toast-root');
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' is-' + kind : '');
    el.innerHTML = '<span class="bar"></span><div>' + esc(msg) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>';
    root.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; el.style.transition = 'opacity .25s, transform .25s'; }, 3400);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3750);
  }

  /* ---------- 悬停说明：浮层挂在 body 上，不受表格 overflow 裁剪 ---------- */
  var tipEl = null, tipTarget = null, tipTimer = null, tipAnchor = null;
  function hideTip() {
    clearTimeout(tipTimer);
    tipTarget = null;
    tipAnchor = null;
    if (tipEl) tipEl.classList.remove('is-on');
  }
  function showTip(target) {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'ui-tip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = target.getAttribute('data-tip') || '';
    tipEl.classList.add('is-on');
    tipEl.style.visibility = 'hidden';
    // 以鼠标实际悬停的子元素为中心，而不是整条组件的中心
    var r = (tipAnchor && tipAnchor.isConnected ? tipAnchor : target).getBoundingClientRect();
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    var top = r.top - h - 9;
    if (top < 8) top = r.bottom + 9;
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
    tipEl.style.visibility = '';
  }
  function bindTips() {
    document.addEventListener('mouseover', function (e) {
      var el = e.target.closest && e.target.closest('[data-tip]');
      if (!el) return;
      tipAnchor = e.target;
      if (el === tipTarget) {
        if (tipEl && tipEl.classList.contains('is-on')) showTip(el);
        return;
      }
      tipTarget = el;
      clearTimeout(tipTimer);
      tipTimer = setTimeout(function () { if (tipTarget === el) showTip(el); }, 90);
    });
    document.addEventListener('mouseout', function (e) {
      var el = e.target.closest && e.target.closest('[data-tip]');
      if (!el) return;
      if (e.relatedTarget && el.contains(e.relatedTarget)) return;
      hideTip();
    });
    window.addEventListener('scroll', hideTip, true);
  }

  function openDrawer(html) {
    document.getElementById('drawer-root').innerHTML =
      '<div class="drawer-backdrop" data-action="close-drawer"></div><div class="drawer">' + html + '</div>';
    var first = document.querySelector('.drawer input, .drawer select, .drawer textarea');
    if (first) setTimeout(function () { try { first.focus(); } catch (e) { /* noop */ } }, 60);
  }
  function closeDrawer() { document.getElementById('drawer-root').innerHTML = ''; }
  function drawerHead(title, sub) {
    return '<div class="drawer-head"><div><h2>' + esc(title) + '</h2>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div>' +
      '<button class="drawer-close" data-action="close-drawer" aria-label="关闭">×</button></div>';
  }

  /* ---------- 总览 ---------- */
  function viewDashboard() {
    var online = Universe.count(S.devices, { status: 'online' });
    var high = Universe.create(S.devices).query({ groupBy: 'level', select: { $count: true }, filter: { status: 'online' } }).data;
    var highCount = (high.find(function (x) { return x.key === 'high'; }) || { value: { count: 0 } }).value.count;
    var pending = Universe.count(S.orders, { status: '待处理' });
    var alerts = S.devices.filter(function (d) { return d.status === 'online' && d.riskScore >= 42; })
      .sort(function (a, b) { return b.riskScore - a.riskScore; }).slice(0, 5);
    var now = new Date();

    return '' +
      '<div class="page-head"><div>' +
        '<div class="eyebrow">Overview · 车间总览</div>' +
        '<h1>' + (now.getMonth() + 1) + ' 月 ' + now.getDate() + ' 日，' + online + ' 台设备在线</h1>' +
        '<p>曲线每 2 秒追加一个采样点（实际采样间隔 5 秒）。告警、工单统计和台账读的是同一份数据，改一处，其它页面同步变。</p>' +
      '</div><div class="page-actions">' +
        '<button class="uv-btn uv-btn--ghost" data-action="run-demo">跑一遍演示</button>' +
        '<label class="uv-switch"><input type="checkbox" data-change="realtime"' + (S.ui.realtime ? ' checked' : '') + '><span class="uv-switch__track"></span><span>实时推送</span></label>' +
      '</div></div>' +

      '<div class="grid grid--kpi">' +
        kpi('设备在线', online + '<small>/ ' + S.devices.length + ' 台</small>', '离线 ' + (S.devices.length - online) + ' 台 · 动力站空压机组', '') +
        kpi('高风险设备', highCount + '<small>台</small>', '风险分 ≥ 70，需安排停机检查', highCount ? 'kpi--alert' : '') +
        kpi('待处理工单', pending + '<small>张</small>', '共 ' + S.orders.length + ' 张工单在册', pending ? 'kpi--warn' : '') +
        kpi('清洗批次', S.runs.length + '<small>批</small>', '每批 120 点 · 原始与清洗数据均留存', '') +
      '</div>' +

      '<div class="grid grid--2 mt16">' +
        '<div class="card">' +
          '<div class="card-head"><h2>实时数据曲线 <span class="sub">温度 / 电流</span></h2>' +
            '<div class="tools"><select class="uv-select" id="dash-device" data-change="dash-device" style="width:172px">' + deviceOptions(S.ui.dashDevice) + '</select></div></div>' +
          '<div class="card-body" style="padding-bottom:8px">' +
            '<div class="chart-legend" style="margin-bottom:6px"><span><i style="background:#2e6b60"></i>温度 ℃（左轴）</span><span><i style="background:#ab7624"></i>电流 A（右轴）</span><span class="muted">最近 ' + Math.max(36, LIVE.points.length) + ' 点</span></div>' +
            '<div class="chart chart--tall" id="chart-realtime"></div>' +
          '</div>' +
          '<div class="card-foot">演示环境按 2 秒推送一次采样；停产设备不参与曲线刷新。</div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-head"><h2>风险告警 <span class="sub">按风险分排序</span></h2><span class="tag tag--quiet">' + alerts.length + ' 条</span></div>' +
          '<ul class="alerts">' + (alerts.length ? alerts.map(function (d, i) {
            return '<li data-action="goto-predict" data-id="' + d.id + '" style="cursor:pointer">' +
              '<span class="alert-rank">' + pad(i + 1) + '</span><div class="alert-main">' +
              '<div class="line1"><span class="name">' + esc(d.name) + '</span><span class="score">' + d.riskScore + ' 分</span></div>' +
              '<div class="line2">' + esc(d.id + ' · ' + d.type + ' · ' + d.line) + '　估计剩余寿命 ' + d.rul + ' 天 · ' +
              (d.level === 'high' ? '<span style="color:#a54b3c">高风险</span>' : '需关注') + '</div></div></li>';
          }).join('') : '<li><div class="empty">当前没有超阈值的设备</div></li>') + '</ul>' +
          '<div class="card-foot">阈值：42 分需关注，70 分高风险。点击任一设备可直达风险预测。</div>' +
        '</div>' +
      '</div>' +

      '<div class="grid grid--2 mt16">' +
        '<div class="card">' +
          '<div class="card-head"><h2>工单统计 <span class="sub">按当前状态</span></h2><span class="tag tag--quiet">Universe 聚合</span></div>' +
          '<div class="card-body"><div class="chart chart--short" id="chart-orders"></div></div>' +
          '<div class="card-foot">状态在「维保工单」里流转后，这张图会立即重新聚合。</div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-head"><h2>演示闭环 <span class="sub">现场约 1 分钟</span></h2>' +
            '<div class="tools"><button class="uv-btn uv-btn--ghost uv-btn--small" data-action="run-demo">自动跑一遍</button></div></div>' +
          '<div class="card-body card-body--flush"><div class="path path--v">' +
            '<a href="#/signal"><span class="step">01</span><div><div class="title">采集并清洗</div><div class="desc">生成带毛刺的温度 / 电流，对照清洗前后曲线</div></div></a>' +
            '<a href="#/predict"><span class="step">02</span><div><div class="title">本地模型推理</div><div class="desc">输入清洗后特征，回归估计剩余寿命与风险等级</div></div></a>' +
            '<a href="#/orders"><span class="step">03</span><div><div class="title">超标自动建单</div><div class="desc">风险 ≥ 70 自动生成待处理维保工单</div></div></a>' +
            '<a href="#/orders"><span class="step">04</span><div><div class="title">状态流转回写</div><div class="desc">派工 → 完成，总览统计同步刷新</div></div></a>' +
          '</div></div>' +
        '</div>' +
      '</div>';
  }

  function kpi(label, value, foot, cls) {
    return '<div class="kpi ' + (cls || '') + '"><div class="kpi__label">' + esc(label) + '</div>' +
      '<div class="kpi__value">' + value + '</div><div class="kpi__foot">' + foot + '</div></div>';
  }

  /* ---------- 数据与清洗 ---------- */
  /* 当前通道的批次统计，填进筛选栏原来空着的区域 */
  function channelStats(b, metric) {
    var src = (b.clean && b.clean[metric]) || b.raw[metric].filter(function (x) { return x !== null; });
    var u = Simulator.util;
    var spikes = ((b.spikeIdx && b.spikeIdx[metric]) || []).length;
    var missing = (b.missing || []).filter(function (m) { return m.channel === metric; }).length;
    var unit = metric === 'temp' ? '℃' : 'A';
    return '<span>均值 <b>' + u.mean(src).toFixed(2) + '</b> ' + unit + '</span>' +
      '<span>波动 <b>' + u.std(src).toFixed(2) + '</b></span>' +
      '<span class="' + (spikes ? 'is-warn' : '') + '">尖峰 <b>' + spikes + '</b> 点</span>' +
      '<span class="' + (missing ? 'is-warn' : '') + '">缺失 <b>' + missing + '</b> 点</span>';
  }

  function viewSignal() {
    var b = S.batches[S.ui.signalDevice] || S.batches[S.devices[0].id];
    var d = dev(b.deviceId);
    var metric = S.ui.metric;
    var isTemp = metric === 'temp';
    var rows = [];
    var spikeIdx = (b.spikeIdx && b.spikeIdx[metric]) || [];
    for (var i = 0; i < 12; i++) {
      var rawVal = b.raw[metric][i];
      var cleanVal = b.clean ? b.clean[metric][i] : null;
      var bad = rawVal === null || spikeIdx.indexOf(i) !== -1;
      rows.push('<tr>' +
        '<td class="mono muted">' + new Date(b.startAt + i * b.interval).toTimeString().slice(0, 8) + '</td>' +
        '<td class="num">' + (rawVal === null ? '<span class="muted">缺失</span>' : rawVal.toFixed(2)) + '</td>' +
        '<td class="num">' + (cleanVal === null || cleanVal === undefined ? '<span class="muted">—</span>' : cleanVal.toFixed(2)) + '</td>' +
        '<td>' + (bad ? '<span class="tag tag--warn">' + (rawVal === null ? '缺失' : '尖峰') + '</span>' : '<span class="muted">—</span>') + '</td>' +
        '</tr>');
    }

    return '' +
      '<div class="page-head"><div>' +
        '<div class="eyebrow">Signal · 数据与清洗</div><h1>采集信号与清洗记录</h1>' +
        '<p>每批 120 个点、间隔 5 秒。原始数据不会被覆盖，清洗结果单独存放；两者的对照曲线和明细都可以导出。</p>' +
      '</div><div class="page-actions">' +
        '<button class="uv-btn uv-btn--ghost" data-action="resample">重新采样</button>' +
        '<button class="uv-btn" data-action="clean">执行清洗</button>' +
        '<button class="uv-btn uv-btn--ghost" data-action="export-csv">导出 CSV</button>' +
      '</div></div>' +

      '<div class="card">' +
        '<div class="filter-bar">' +
          '<div class="uv-field"><label>设备</label><select class="uv-select" id="signal-device" data-change="signal-device">' + deviceOptions(b.deviceId) + '</select></div>' +
          '<div class="uv-field uv-field--seg"><label>通道</label><div class="seg">' +
            '<button data-action="metric" data-v="temp" class="' + (isTemp ? 'is-on' : '') + '">温度 ℃</button>' +
            '<button data-action="metric" data-v="current" class="' + (!isTemp ? 'is-on' : '') + '">电流 A</button>' +
          '</div></div>' +
          '<div class="uv-field uv-field--stats"><label>当前通道 · ' + (b.clean ? '清洗后' : '原始') + '</label>' +
            '<div class="channel-stats">' + channelStats(b, metric) + '</div></div>' +
          '<div class="spacer"></div>' +
          '<div class="note" style="text-align:right">批次 <b class="mono">' + esc(b.id) + '</b><br>' +
            esc(d.name) + ' · ' + b.points + ' 点 · 5 s · ' + (b.clean ? '已清洗' : '<span style="color:#ab7624">待清洗</span>') + '</div>' +
        '</div>' +
        '<div class="card-body">' +
          (b.clean ? '' : '<div class="inline-note" style="margin-bottom:12px"><span class="mark">!</span><div>本批次只保留了原始读数。点击右上角「执行清洗」后，会依次做缺失填补、尖峰抑制与平滑，并把结果写入一条清洗记录。</div></div>') +
          '<div class="chart-legend" style="margin-bottom:8px">' +
            '<span><i class="dash"></i>原始读数 ' + (isTemp ? '℃' : 'A') + '</span><span><i style="background:#2e6b60"></i>清洗后 ' + (isTemp ? '℃' : 'A') + '</span>' +
            '<span><i style="background:#a54b3c;height:6px;width:6px;border-radius:50%"></i>尖峰</span>' +
            '<span><i style="background:#ab7624;height:6px;width:6px;border-radius:50%"></i>缺失</span>' +
          '</div>' +
          '<div class="chart chart--tall" id="chart-signal"></div>' +
        '</div>' +
        '<div class="card-foot">清洗只追加结果，不改写 <span class="mono">batch.raw</span>；导出 CSV 会同时写出原始列与清洗列。</div>' +
      '</div>' +

      '<div class="grid grid--2even mt16">' +
        '<div class="card">' +
          '<div class="card-head"><h2>清洗步骤与记录</h2><span class="tag tag--quiet">' + (b.clean ? '已执行' : '未执行') + '</span></div>' +
          '<div class="card-body">' +
            '<ul class="method-list">' + (b.clean ? b.steps.map(function (s, i) {
              return '<li><span class="idx">' + pad(i + 1) + '</span><div class="txt"><b>' + esc(s.name) + '</b>' +
                (s.count ? ' <span class="mono" style="color:#a54b3c">' + s.count + ' ' + s.unit + '</span>' : '') +
                '<small>' + esc(s.rule) + '</small></div></li>';
            }).join('') : '<li><span class="idx">—</span><div class="txt">尚未执行清洗<small>先点「重新采样」生成新批次，再点「执行清洗」</small></div></li>') + '</ul>' +
            '<div class="divider"></div>' +
            '<dl class="kv">' +
              '<dt>设备</dt><dd>' + esc(d.id + ' · ' + d.name) + '</dd>' +
              '<dt>采样区间</dt><dd class="mono">' + fmt(new Date(b.startAt).toISOString()) + ' 起</dd>' +
              '<dt>工况阶段</dt><dd class="mono">已消耗 ' + Math.round((b.stage || 0) * 100) + '%（模拟）</dd>' +
              '<dt>随机种子</dt><dd class="mono">' + (b.seed || '—') + '</dd>' +
              '<dt>注入毛刺</dt><dd class="mono">' + b.outliers.length + ' 点</dd>' +
              '<dt>丢包</dt><dd class="mono">' + b.missing.length + ' 点</dd>' +
              '<dt>原始数据</dt><dd><span class="tag tag--ok">完整保留</span></dd>' +
            '</dl>' +
          '</div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-head"><h2>采样明细 <span class="sub">前 12 点</span></h2><span class="tag tag--quiet">' + (isTemp ? '温度 ℃' : '电流 A') + '</span></div>' +
          '<div class="table-wrap"><table class="tbl"><thead><tr><th>时间</th><th>原始</th><th>清洗后</th><th>标记</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>' +
          '<div class="card-foot">完整 120 点请用「导出 CSV」查看；清洗记录见下方表格。</div>' +
        '</div>' +
      '</div>' +

      '<div class="card mt16">' +
        '<div class="card-head"><h2>清洗记录 <span class="sub">最近 ' + Math.min(S.runs.length, 8) + ' 批</span></h2><span class="tag tag--quiet">共 ' + S.runs.length + ' 条</span></div>' +
        '<div class="table-wrap"><table class="tbl"><thead><tr><th>批次</th><th>设备</th><th>采样点</th><th>缺失填补</th><th>尖峰修正</th><th>平滑窗口</th><th>执行时间</th><th>原始数据</th></tr></thead><tbody>' +
          (S.runs.length ? S.runs.slice(0, 8).map(function (r) {
            var rd = dev(r.deviceId);
            return '<tr><td class="num">' + esc(r.batchId) + '</td><td class="strong">' + esc(rd.name) + '</td>' +
              '<td class="num">' + r.points + '</td><td class="num">' + r.missing + '</td>' +
              '<td class="num">' + r.spikes + '</td><td class="num">' + r.window + '</td>' +
              '<td class="mono muted">' + fmtShort(r.createdAt) + '</td>' +
              '<td>' + (r.rawKept ? '<span class="tag tag--ok">已留存</span>' : '<span class="tag tag--quiet">—</span>') + '</td></tr>';
          }).join('') : '<tr><td colspan="8"><div class="empty"><strong>还没有清洗记录</strong>执行一次清洗即可生成</div></td></tr>') +
        '</tbody></table></div>' +
        '<div class="card-foot">记录与批次数据保存在浏览器 localStorage，刷新页面后仍在；README 里有一键恢复初始数据的方法。</div>' +
      '</div>';
  }

  /* ---------- 风险预测 ---------- */
  function viewPredict() {
    var info = Model.info();
    var ref = info.reference;
    var tr = info.training;
    var ev = info.evaluation;
    var th = Model.config.thresholds;
    var cmp = info.comparison || { note: '', rows: [], literature: { rows: [], note: '', source: '' } };
    var lit = cmp.literature || { rows: [], note: '', source: '' };
    var cmpRows = (cmp.rows || []).map(function (m) {
      return '<tr class="' + (m.inUse ? 'row-flash' : '') + '">' +
        '<td class="strong">' + esc(m.name) + (m.inUse ? ' <span class="tag tag--accent">在用</span>' : '') + '</td>' +
        '<td class="muted">' + esc(m.family) + '</td>' +
        '<td class="num">' + Number(m.MAE).toFixed(4) + '</td><td class="num">' + Number(m.RMSE).toFixed(4) + '</td>' +
        '<td class="num">' + Number(m.R2).toFixed(4) + '</td><td class="num">' + Number(m.MAE_days).toFixed(2) + '</td></tr>';
    }).join('');
    var litRows = (lit.rows || []).map(function (m) {
      return '<tr><td class="strong">' + esc(m.name) + '</td><td class="muted">' + esc(m.family) + '</td>' +
        '<td class="num">' + Number(m.MAE).toFixed(3) + '</td><td class="num">' + Number(m.RMSE).toFixed(3) + '</td>' +
        '<td class="num">' + Number(m.R2).toFixed(3) + '</td></tr>';
    }).join('');
    var selected = S.ui.predictDevice;
    var d = dev(selected);
    var usable = PREDICT && PREDICT.result.deviceId === selected;
    var r = usable ? PREDICT.result : null;
    var auto = usable ? PREDICT.auto : null;

    var resultHtml;
    if (!r) {
      resultHtml = '<div class="empty" style="padding:46px 16px"><strong>还没有运行预测</strong>' +
        '选择设备后点「运行预测」，模型会用该设备最近一批清洗数据的 7 个特征估计剩余寿命比例。</div>';
    } else {
      var autoLine = auto && auto.created
        ? '<span class="tag tag--danger">已自动建单</span> <span class="linkish" data-action="view-order" data-id="' + esc(auto.order.id) + '">' + esc(auto.order.id) + '</span>'
        : auto && auto.reason === 'duplicate'
          ? '<span class="tag tag--warn">已有未闭环工单</span> <span class="muted">' + esc(auto.order.id) + '，未重复创建</span>'
          : '<span class="tag tag--ok">未超阈值</span> <span class="muted">无需自动建单</span>';
      resultHtml = '<div class="result-hero">' +
        '<div class="result-score ' + (r.level === 'high' ? 'is-high' : r.level === 'medium' ? 'is-mid' : '') + '"><b>' + r.score + '</b><span>风险分</span></div>' +
        '<div class="result-text"><h3>' + esc(d.name) + '　' + levelTag(r.level) + '</h3>' +
          '<p>' + esc(r.advice) + '</p>' +
          '<div class="result-meta">' +
            '<div>估计剩余寿命<b>' + r.rul + ' 天</b></div>' +
            '<div>剩余寿命比例<b>' + (r.ratio * 100).toFixed(1) + '%</b></div>' +
            '<div>额定寿命<b>' + r.ratedLife + ' 天</b></div>' +
            '<div>模型版本<b style="font-size:12px">' + esc(r.model) + '</b></div>' +
          '</div></div></div>' +
        '<div class="card-foot" style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">' + autoLine +
          '<span class="muted">推理时间 ' + fmtShort(r.at) + '</span></div>';
    }

    return '' +
      '<div class="page-head"><div>' +
        '<div class="eyebrow">Prediction · 风险预测</div><h1>设备风险与剩余寿命</h1>' +
        '<p>权重由 <span class="mono">tools/build-model.mjs</span> 在带标签样本上离线训练，页面本地加载后只做前向计算。模型估计的是剩余寿命占额定寿命的比例，天数按设备额定寿命换算；不联网、不在线训练。</p>' +
      '</div><div class="page-actions"><button class="uv-btn uv-btn--ghost" data-action="reload-model">重新加载模型</button></div></div>' +

      '<div class="grid grid--2">' +
        '<div class="stack">' +
          '<div class="card">' +
            '<div class="card-head"><h2>运行预测</h2><span class="tag tag--accent">' + esc(info.name + ' v' + info.version) + '</span></div>' +
            '<div class="filter-bar">' +
              '<div class="uv-field"><label>设备</label><select class="uv-select" id="predict-device" data-change="predict-device">' + deviceOptions(selected) + '</select></div>' +
              '<div class="uv-field uv-field--wide"><label>输入数据</label><div class="inline-note" style="padding:5px 10px">最近一批清洗数据 · ' + Simulator.POINTS + ' 点 · 5 s 间隔</div></div>' +
              '<div class="spacer"></div><button class="uv-btn" data-action="run-predict">运行预测</button>' +
            '</div>' + resultHtml +
          '</div>' +
          '<div class="card">' +
            '<div class="card-head"><h2>特征影响 <span class="sub">对风险分的加减</span></h2><span class="tag tag--quiet">' + info.featureCount + ' 个特征</span></div>' +
            '<div class="card-body">' +
              (r ? '<div class="chart chart--short" id="chart-features"></div>' :
                '<div class="empty" style="height:206px;display:flex;align-items:center;justify-content:center;flex-direction:column">运行预测后显示各特征对风险分的影响</div>') +
            '</div>' +
            '<div class="card-foot">正值推高风险、负值拉低风险，数值为标准化特征 × 回归权重 × 100。特征全部用相对基线量，避免型号差异干扰。</div>' +
          '</div>' +
        '</div>' +

        '<div class="stack">' +
          '<div class="card">' +
            '<div class="card-head"><h2>模型与实测指标</h2><span class="tag tag--ok tag--dot">已加载</span></div>' +
            '<div class="card-body">' +
              '<dl class="kv">' +
                '<dt>名称</dt><dd class="mono">' + esc(info.name + ' v' + info.version) + '</dd>' +
                '<dt>结构</dt><dd>' + esc(info.kind) + '</dd>' +
                '<dt>构建时间</dt><dd class="mono">' + esc(info.builtAt.slice(0, 10)) + '</dd>' +
                '<dt>加载来源</dt><dd class="mono" style="font-size:11px">' + esc(info.source) + '</dd>' +
                '<dt>训练样本</dt><dd class="mono">' + tr.trainSamples + ' 条 / 共 ' + tr.samples + ' 条</dd>' +
                '<dt>测试划分</dt><dd>' + esc(ev.split) + '</dd>' +
                '<dt>数据指纹</dt><dd class="mono" style="font-size:11px">sha256 ' + esc(tr.datasetSha256.slice(0, 16)) + '…</dd>' +
                '<dt>复现命令</dt><dd class="mono" style="font-size:11px">' + esc(tr.verify) + '</dd>' +
                '<dt>分级阈值</dt><dd>' + th.medium + ' 分需关注 · ' + th.high + ' 分高风险</dd>' +
              '</dl>' +
              '<div class="divider"></div>' +
              '<div class="section-title">本项目实测 · 留出测试集（' + ev.testSamples + ' 条）</div>' +
              '<table class="tbl"><thead><tr><th>指标</th><th>数值</th><th>口径</th></tr></thead><tbody>' +
                '<tr><td>R²</td><td class="num">' + ev.ratio.R2 + '</td><td class="muted">剩余寿命比例</td></tr>' +
                '<tr><td>MAE</td><td class="num">' + ev.ratio.MAE + '</td><td class="muted">剩余寿命比例</td></tr>' +
                '<tr><td>RMSE</td><td class="num">' + ev.ratio.RMSE + '</td><td class="muted">剩余寿命比例</td></tr>' +
                '<tr><td>MAE</td><td class="num">' + ev.days.MAE + ' 天</td><td class="muted">按额定寿命换算</td></tr>' +
                '<tr><td>RMSE</td><td class="num">' + ev.days.RMSE + ' 天</td><td class="muted">按额定寿命换算</td></tr>' +
              '</tbody></table>' +
              '<div class="inline-note mt16"><span class="mark">i</span><div>' + esc(ev.note) +
                ' 常数基线 R² 为 ' + ev.baseline.R2 + '，可确认模型学到了退化信号而非均值。</div></div>' +
              '<div class="divider"></div>' +
              '<div class="section-title">数据与训练过程</div>' +
              '<ul class="method-list">' +
                '<li><span class="idx">01</span><div class="txt"><b>数据与标签</b><small>' + esc(ev.target) + '。按寿命比例逐段取窗口，参考论文「按寿命比例构造样本」的做法。</small></div></li>' +
                '<li><span class="idx">02</span><div class="txt"><b>特征工程</b><small>补缺失 → Hampel 去尖峰 → 5 点平滑 → 7 个相对量特征 → 按训练集统计量标准化。</small></div></li>' +
                '<li><span class="idx">03</span><div class="txt"><b>模型</b><small>' + esc(ev.model) + '，闭式解、确定性可复算。论文用 Informer / LSTM，本项目未复现。</small></div></li>' +
              '</ul>' +
            '</div>' +
            '<div class="card-foot">' + esc(ref.caveat) + '</div>' +
          '</div>' +
          '<div class="card">' +
            '<div class="card-head"><h2>参考文献与对照</h2></div>' +
            '<div class="card-body">' +
              '<ul class="method-list">' + ref.papers.map(function (p, i) {
                return '<li><span class="idx">' + pad(i + 1) + '</span><div class="txt">' + esc(p) + '</div></li>';
              }).join('') + '</ul>' +
              '<div class="divider"></div>' +
              '<div class="section-title">文献报告值（非本项目，不可比）</div>' +
              '<table class="tbl"><thead><tr><th>模型</th><th>MAE</th><th>RMSE</th><th>R²</th></tr></thead><tbody>' +
                '<tr><td>' + esc(ref.reportedMetrics.model) + '</td><td class="num">' + ref.reportedMetrics.MAE + '</td><td class="num">' + ref.reportedMetrics.RMSE + '</td><td class="num">' + ref.reportedMetrics.R2 + '</td></tr>' +
              '</tbody></table>' +
            '</div>' +
            '<div class="card-foot">' + esc(ref.dataset) + '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="grid grid--2 mt16">' +
        '<div class="card card--compare">' +
          '<div class="card-head"><h2>同口径实测对比 <span class="sub">同一数据 · 同一划分</span></h2>' +
            '<span class="tag tag--accent">' + cmp.rows.length + ' 个方法</span></div>' +
          '<div class="table-wrap"><table class="tbl tbl--compact"><thead><tr>' +
            '<th>方法</th><th>类型</th><th>MAE</th><th>RMSE</th><th>R²</th><th>MAE / 天</th>' +
          '</tr></thead><tbody>' + cmpRows + '</tbody></table></div>' +
          '<div class="card-body"><div class="inline-note"><span class="mark">i</span><div>' + esc(cmp.note) +
            ' MAE、RMSE 越低越好，R² 越接近 1 越好；最后一列是按各设备额定寿命换算成天之后的 MAE。高亮行是页面实际加载的模型。</div></div></div>' +
          '<div class="card-foot">岭回归在这份数据上误差最低，且权重可逐项核对，因此被选为页面模型。</div>' +
        '</div>' +
        '<div class="card card--compare">' +
          '<div class="card-head"><h2>论文表 5 对照 <span class="sub">不同数据集，不可比</span></h2>' +
            '<span class="tag tag--quiet">' + lit.rows.length + ' 个基准模型</span></div>' +
          '<div class="table-wrap"><table class="tbl tbl--compact"><thead><tr>' +
            '<th>模型</th><th>类型</th><th>MAE</th><th>RMSE</th><th>R²</th>' +
          '</tr></thead><tbody>' + litRows + '</tbody></table></div>' +
          '<div class="card-body"><div class="inline-note"><span class="mark">!</span><div>' + esc(lit.note) + '</div></div></div>' +
          '<div class="card-foot">' + esc(lit.source) + '</div>' +
        '</div>' +
      '</div>';
  }

  /* ---------- 设备台账 ---------- */
  function assetRows() {
    var u = Universe.create(S.devices);
    if (F.assetType) u.filter('type', F.assetType);
    if (F.assetStatus) u.filter('status', F.assetStatus);
    var q = F.assetQ.trim().toLowerCase();
    var list = u.visible().filter(function (d) {
      return !q || (d.id + d.name + d.type + d.line).toLowerCase().indexOf(q) !== -1;
    });
    if (!list.length) return '<tr><td colspan="9"><div class="empty"><strong>没有匹配的设备</strong>换个筛选条件试试</div></td></tr>';
    return list.map(function (d) {
      var rowCls = (highlightOrder === d.id ? 'row-flash' : '') + (Number(d.riskScore) >= 70 ? ' is-risk-high' : '');
      return '<tr class="' + rowCls + '">' +
        '<td class="num">' + esc(d.id) + '</td><td class="strong">' + esc(d.name) + '</td>' +
        '<td><span class="tag tag--quiet mono">' + esc(d.type) + '</span></td><td>' + esc(d.line) + '</td>' +
        '<td>' + (d.status === 'online' ? '<span class="tag tag--ok tag--dot">在线</span>' : '<span class="tag tag--quiet">离线</span>') + '</td>' +
        '<td class="num">' + Number(d.hours).toLocaleString() + '</td>' +
        '<td>' + riskBar(d.riskScore) + '</td><td class="num">' + d.rul + '</td>' +
        '<td><div class="actions"><span class="row-link" data-action="view-device" data-id="' + d.id + '">查看</span>' +
        '<span class="row-link" data-action="edit-device" data-id="' + d.id + '">编辑</span></div></td></tr>';
    }).join('');
  }

  function viewAssets() {
    var types = Array.from(new Set(S.devices.map(function (d) { return d.type; })));
    return '' +
      '<div class="page-head"><div>' +
        '<div class="eyebrow">Assets · 设备台账</div><h1>设备台账</h1>' +
        '<p>在册 ' + S.devices.length + ' 台设备，覆盖 ' + types.length + ' 类部件。风险分与剩余寿命由离线训练的回归模型对最近一批清洗数据估计，数据来自本地模拟器。</p>' +
      '</div><div class="page-actions"><button class="uv-btn" data-action="new-device">新增设备</button></div></div>' +
      '<div class="card">' +
        '<div class="filter-bar">' +
          '<div class="uv-field uv-field--wide"><label>搜索</label><input class="uv-input" data-input="asset-q" placeholder="编号 / 名称 / 产线" value="' + esc(F.assetQ) + '"></div>' +
          '<div class="uv-field"><label>设备类型</label><select class="uv-select" data-change="asset-type"><option value="">全部类型</option>' +
            types.map(function (t) { return '<option value="' + esc(t) + '"' + (F.assetType === t ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div>' +
          '<div class="uv-field"><label>运行状态</label><select class="uv-select" data-change="asset-status"><option value="">全部状态</option>' +
            '<option value="online"' + (F.assetStatus === 'online' ? ' selected' : '') + '>在线</option>' +
            '<option value="offline"' + (F.assetStatus === 'offline' ? ' selected' : '') + '>离线</option></select></div>' +
          '<div class="spacer"></div><span class="note">筛选走 Universe 查询层，与总览共用字段定义</span>' +
        '</div>' +
        '<div class="table-wrap"><table class="tbl"><thead><tr><th>编号</th><th>设备名称</th><th>类型</th><th>产线</th><th>状态</th><th>累计工时 h</th><th>风险分</th><th>估计 RUL / 天</th><th>操作</th></tr></thead>' +
          '<tbody id="asset-rows">' + assetRows() + '</tbody></table></div>' +
        '<div class="card-foot">类型编号 S26a / S51d / S100 / Saa3 沿用《基于特征融合的机械核心部件剩余寿命预测》中的四类设备。</div>' +
      '</div>';
  }

  /* ---------- 维保工单 ---------- */
  function orderRows() {
    var u = Universe.create(S.orders);
    if (F.orderStatus) u.filter('status', F.orderStatus);
    if (F.orderSource) u.filter('source', F.orderSource);
    var q = F.orderQ.trim().toLowerCase();
    var list = u.visible().filter(function (o) {
      var d = dev(o.deviceId);
      return !q || (o.id + d.name + o.deviceId + o.handler).toLowerCase().indexOf(q) !== -1;
    });
    if (!list.length) return '<tr><td colspan="8"><div class="empty"><strong>没有匹配的工单</strong>换个筛选条件试试</div></td></tr>';
    return list.map(function (o) {
      var d = dev(o.deviceId);
      return '<tr class="' + (highlightOrder === o.id ? 'row-flash' : '') + '">' +
        '<td class="num">' + esc(o.id) + '</td><td class="strong">' + esc(d.name) + '<span class="muted mono" style="font-size:11px"> · ' + esc(o.deviceId) + '</span></td>' +
        '<td>' + (o.source === 'AI 预测自动生成' ? '<span class="tag tag--accent">' + esc(o.source) + '</span>' : '<span class="tag tag--quiet">' + esc(o.source) + '</span>') + '</td>' +
        '<td>' + riskBar(o.riskScore) + '</td><td>' + statusTag(o.status) + '</td>' +
        '<td class="mono muted">' + fmtShort(o.createdAt) + '</td><td>' + (esc(o.handler) || '<span class="muted">未派工</span>') + '</td>' +
        '<td><span class="row-link" data-action="view-order" data-id="' + esc(o.id) + '">查看 / 处理</span></td></tr>';
    }).join('');
  }

  function viewOrders() {
    var sources = Array.from(new Set(S.orders.map(function (o) { return o.source; })));
    var q = Universe.create(S.orders).query({ groupBy: 'status', select: { $count: true } });
    var counts = ['待处理', '处理中', '已完成'].map(function (k) {
      var h = q.data.find(function (x) { return x.key === k; });
      return k + ' ' + (h ? h.value.count : 0);
    }).join(' · ');
    return '' +
      '<div class="page-head"><div>' +
        '<div class="eyebrow">Work orders · 维保工单</div><h1>维保工单</h1>' +
        '<p>待处理 → 处理中 → 已完成。派工和完工都会写入处理记录，总览的工单统计随即重新聚合。</p>' +
      '</div><div class="page-actions"><button class="uv-btn" data-action="new-order">新建工单</button></div></div>' +
      '<div class="card">' +
        '<div class="filter-bar">' +
          '<div class="uv-field uv-field--wide"><label>搜索</label><input class="uv-input" data-input="order-q" placeholder="工单号 / 设备 / 处理人" value="' + esc(F.orderQ) + '"></div>' +
          '<div class="uv-field"><label>状态</label><select class="uv-select" data-change="order-status"><option value="">全部状态</option>' +
            ['待处理', '处理中', '已完成'].map(function (k) { return '<option value="' + k + '"' + (F.orderStatus === k ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select></div>' +
          '<div class="uv-field"><label>来源</label><select class="uv-select" data-change="order-source"><option value="">全部来源</option>' +
            sources.map(function (k) { return '<option value="' + esc(k) + '"' + (F.orderSource === k ? ' selected' : '') + '>' + esc(k) + '</option>'; }).join('') + '</select></div>' +
          '<div class="spacer"></div><span class="note mono">' + counts + '</span>' +
        '</div>' +
        '<div class="table-wrap"><table class="tbl"><thead><tr><th>工单号</th><th>设备</th><th>来源</th><th>风险分</th><th>状态</th><th>创建时间</th><th>处理人</th><th>操作</th></tr></thead>' +
          '<tbody id="order-rows">' + orderRows() + '</tbody></table></div>' +
        '<div class="card-foot">风险分 ≥ 70 时，「风险预测」页会自动生成一张待处理工单；同一设备已有未闭环工单时不会重复创建。</div>' +
      '</div>';
  }

  /* ---------- 抽屉 ---------- */
  function openDeviceView(id) {
    var d = dev(id);
    var b = S.batches[id];
    openDrawer(drawerHead(d.name, d.id + ' · 设备档案') +
      '<div class="drawer-body">' +
        '<dl class="kv">' +
          '<dt>设备编号</dt><dd class="mono">' + esc(d.id) + '</dd>' +
          '<dt>设备类型</dt><dd class="mono">' + esc(d.type) + '</dd>' +
          '<dt>所属产线</dt><dd>' + esc(d.line) + '</dd>' +
          '<dt>运行状态</dt><dd>' + (d.status === 'online' ? '<span class="tag tag--ok tag--dot">在线</span>' : '<span class="tag tag--quiet">离线</span>') + '</dd>' +
          '<dt>投用日期</dt><dd class="mono">' + esc(d.installedAt) + '</dd>' +
          '<dt>累计工时</dt><dd class="mono">' + Number(d.hours).toLocaleString() + ' h</dd>' +
          '<dt>额定寿命</dt><dd class="mono">' + (d.ratedLife || 128) + ' 天</dd>' +
          '<dt>寿命阶段</dt><dd class="mono">已消耗 ' + Math.round((d.stage || 0) * 100) + '%（模拟工况）</dd>' +
          '<dt>风险分</dt><dd>' + riskBar(d.riskScore) + '　' + levelTag(d.level) + '</dd>' +
          '<dt>估计剩余寿命</dt><dd class="mono">' + d.rul + ' 天</dd>' +
          '<dt>最近评估</dt><dd class="mono">' + fmtShort(d.lastCheck) + '</dd>' +
        '</dl>' +
        '<div class="divider"></div><div class="section-title">最近一批采样</div>' +
        '<div class="inline-note"><span class="mark">◆</span><div>批次 <b class="mono">' + esc(b ? b.id : '—') + '</b> · ' + (b ? b.points : 0) + ' 点 · 温度与电流双通道。' +
          '原始读数与清洗结果分别保存，可在「数据与清洗」页对照曲线。</div></div>' +
      '</div>' +
      '<div class="drawer-foot"><button class="uv-btn uv-btn--ghost" data-action="edit-device" data-id="' + esc(d.id) + '">编辑台账</button>' +
        '<button class="uv-btn" data-action="goto-predict" data-id="' + esc(d.id) + '">去风险预测</button></div>');
  }

  function openDeviceForm(id) {
    var editing = !!id;
    var d = editing ? dev(id) : { name: '', type: 'S26a', line: '一号装配线', status: 'online', installedAt: new Date().toISOString().slice(0, 10), hours: 0 };
    var lines = Array.from(new Set(S.devices.map(function (x) { return x.line; })));
    var types = Array.from(new Set(S.devices.map(function (x) { return x.type; })));
    openDrawer(drawerHead(editing ? '编辑设备台账' : '新增设备', editing ? d.id + ' · ' + d.name : '新增后会立即生成一批模拟采样数据') +
      '<div class="drawer-body"><div class="form-grid">' +
        '<div class="uv-field span2"><label>设备名称</label><input class="uv-input" id="f-name" value="' + esc(d.name) + '" placeholder="例如：冷却风机"></div>' +
        '<div class="uv-field"><label>设备类型</label><select class="uv-select" id="f-type">' + types.map(function (t) { return '<option' + (t === d.type ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div>' +
        '<div class="uv-field"><label>所属产线</label><select class="uv-select" id="f-line">' + lines.map(function (t) { return '<option' + (t === d.line ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div>' +
        '<div class="uv-field"><label>运行状态</label><select class="uv-select" id="f-status"><option value="online"' + (d.status === 'online' ? ' selected' : '') + '>在线</option><option value="offline"' + (d.status === 'offline' ? ' selected' : '') + '>离线</option></select></div>' +
        '<div class="uv-field"><label>投用日期</label><input class="uv-input" type="date" id="f-installed" value="' + esc(d.installedAt) + '"></div>' +
        '<div class="uv-field span2"><label>累计工时（h）</label><input class="uv-input" type="number" id="f-hours" value="' + Number(d.hours) + '" min="0"></div>' +
      '</div>' +
      '<div class="inline-note mt16"><span class="mark">i</span><div>新增设备的工况按低退化基线生成，可在「数据与清洗」页重新采样后查看曲线。</div></div></div>' +
      '<div class="drawer-foot"><button class="uv-btn uv-btn--ghost" data-action="close-drawer">取消</button>' +
        '<button class="uv-btn" data-action="save-device" data-id="' + esc(id || '') + '">' + (editing ? '保存修改' : '创建设备') + '</button></div>');
  }

  function statusFlow(status) {
    var arr = ['待处理', '处理中', '已完成'];
    var cur = arr.indexOf(status);
    return '<div class="status-flow">' + arr.map(function (s, i) {
      return '<span class="step ' + (i < cur ? 'is-done' : i === cur ? 'is-now' : '') + '">' + s + '</span>' + (i < arr.length - 1 ? '<span class="arrow">→</span>' : '');
    }).join('') + '</div>';
  }

  function openOrderView(id) {
    var o = S.orders.find(function (x) { return x.id === id; });
    if (!o) { toast('工单不存在', '', 'warn'); return; }
    var d = dev(o.deviceId);
    var foot;
    if (o.status === '待处理') {
      foot = '<div class="uv-field"><label>派工给</label><input class="uv-input" id="f-handler" placeholder="例如：李工" value="' + esc(o.handler) + '"></div>' +
        '<button class="uv-btn" data-action="advance-order" data-id="' + esc(o.id) + '">派工并推进到处理中</button>';
    } else if (o.status === '处理中') {
      foot = '<div class="uv-field"><label>处理记录</label><input class="uv-input" id="f-note" placeholder="填写处理结果"></div>' +
        '<button class="uv-btn" data-action="finish-order" data-id="' + esc(o.id) + '">标记已完成</button>';
    } else {
      foot = '<span class="tag tag--ok tag--dot">工单已闭环</span>';
    }
    openDrawer(drawerHead(o.id, d.name + ' · ' + o.deviceId) +
      '<div class="drawer-body">' +
        '<dl class="kv">' +
          '<dt>设备</dt><dd>' + esc(d.name) + ' <span class="mono muted">' + esc(o.deviceId) + '</span></dd>' +
          '<dt>工单来源</dt><dd>' + esc(o.source) + '</dd>' +
          '<dt>风险分</dt><dd>' + riskBar(o.riskScore) + '</dd>' +
          '<dt>当前状态</dt><dd>' + statusTag(o.status) + '</dd>' +
          '<dt>创建时间</dt><dd class="mono">' + fmt(o.createdAt) + '</dd>' +
          '<dt>处理人</dt><dd>' + (esc(o.handler) || '<span class="muted">尚未派工</span>') + '</dd>' +
        '</dl>' +
        '<div class="divider"></div><div class="section-title">状态流转</div>' + statusFlow(o.status) +
        '<div class="divider"></div><div class="section-title">问题描述</div>' +
        '<div class="note">' + (esc(o.description) || '暂无描述') + '</div>' +
        '<div class="divider"></div><div class="section-title">处理记录</div>' +
        '<ul class="timeline">' + o.log.map(function (l) {
          return '<li><div class="t">' + fmt(l.at) + '</div><div class="d">' + esc(l.text) + '</div></li>';
        }).join('') + '</ul>' +
      '</div>' +
      '<div class="drawer-foot">' + foot + '</div>');
  }

  function openOrderForm() {
    openDrawer(drawerHead('新建维保工单', '人工录入；AI 生成的工单由预测页自动创建') +
      '<div class="drawer-body"><div class="form-grid">' +
        '<div class="uv-field span2"><label>设备</label><select class="uv-select" id="f-device">' + deviceOptions(S.devices[0].id) + '</select></div>' +
        '<div class="uv-field"><label>来源</label><select class="uv-select" id="f-source"><option>人工录入</option><option>巡检录入</option></select></div>' +
        '<div class="uv-field"><label>风险分</label><input class="uv-input" type="number" id="f-score" value="45" min="0" max="99"></div>' +
        '<div class="uv-field span2"><label>问题描述</label><textarea class="uv-textarea" id="f-desc" placeholder="写清现象、位置与初步判断"></textarea></div>' +
      '</div><div class="inline-note mt16"><span class="mark">i</span><div>新建工单默认进入「待处理」，之后在详情里派工、填写处理记录并标记完成。</div></div></div>' +
      '<div class="drawer-foot"><button class="uv-btn uv-btn--ghost" data-action="close-drawer">取消</button>' +
        '<button class="uv-btn" data-action="save-order">创建工单</button></div>');
  }

  /* ---------- 演示闭环 ---------- */
  async function runDemo() {
    var d = Store.device('EQ-03');
    if (!d) return;
    toast('① 采集 EQ-03 冷却风机的 120 个采样点', '模拟工况含随机毛刺与 3 处传感器丢包');
    await wait(520);
    // 演示用固定工况种子，保证每次都能复现「高风险 → 自动建单」这一步
    var b = Simulator.generate(d, 0xC0FFEE, d.stage);
    Simulator.clean(b);
    Store.setBatch(d.id, b);
    var run = Store.addRun(b);
    toast('② 清洗完成并写入记录 ' + run.batchId, '补缺失 ' + run.missing + ' 点 · 修正尖峰 ' + run.spikes + ' 点');
    await wait(520);
    var r = Model.infer(b, d);
    var auto = Store.autoOrder(d, r);
    PREDICT = { result: r, auto: auto };
    toast('③ 风险分 ' + r.score + '（' + r.levelText + '），估计剩余寿命 ' + r.rul + ' 天',
      auto.created ? '已自动创建工单 ' + auto.order.id : auto.reason === 'duplicate' ? '已有未闭环工单 ' + auto.order.id + '，未重复创建' : '未超阈值，无需自动建单',
      r.level === 'high' ? 'danger' : '');
    await wait(720);
    highlightOrder = auto.order ? auto.order.id : null;
    S.ui.signalDevice = d.id; S.ui.predictDevice = d.id; S.ui.dashDevice = d.id;
    Store.save();
    location.hash = '#/orders';
    render();
    if (auto.order) setTimeout(function () { openOrderView(auto.order.id); }, 280);
    toast('④ 在工单详情里派工、完成，再回总览看统计变化', '演示链路至此跑通');
  }

  /* ---------- actions ---------- */
  var handlers = {
    'close-drawer': closeDrawer,
    'metric': function (el) { Store.setUI({ metric: el.dataset.v }); render(); },
    'resample': function () {
      var d = dev(S.ui.signalDevice);
      var b = Simulator.generate(d, Date.now() >>> 0, d.stage);
      Store.setBatch(d.id, b);
      render();
      toast('已生成新批次 ' + b.id, '120 点原始数据已留存，尚未清洗', '');
    },
    'clean': function () {
      var d = dev(S.ui.signalDevice);
      var b = S.batches[d.id];
      if (!b) return;
      Simulator.clean(b);
      Store.setBatch(d.id, b);
      var run = Store.addRun(b);
      render();
      toast('清洗完成', '缺失 ' + run.missing + ' 点 · 尖峰 ' + run.spikes + ' 点 · 记录 ' + run.batchId + ' 已保存');
    },
    'export-csv': function () {
      var d = dev(S.ui.signalDevice);
      var b = S.batches[d.id];
      var blob = new Blob([Simulator.toCSV(b, d)], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = b.id + '-' + d.id + '.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast('已导出 ' + a.download, '含原始列、清洗列与异常标记');
    },
    'reload-model': async function () {
      var info = await Model.load();
      toast('模型已重新加载', info.name + ' · 留出测试集 R² ' + info.evaluation.ratio.R2 + ' · ' + info.source);
      render();
    },
    'run-predict': function () {
      var d = dev(S.ui.predictDevice);
      var b = S.batches[d.id];
      if (!b || !b.clean) { toast('该设备还没有清洗数据', '请先到「数据与清洗」页执行清洗', 'warn'); return; }
      var r = Model.infer(b, d);
      var auto = Store.autoOrder(d, r);
      PREDICT = { result: r, auto: auto };
      render();
      if (auto.created) {
        highlightOrder = auto.order.id;
        toast('风险 ' + r.score + ' 分，已自动创建工单 ' + auto.order.id, '估计剩余寿命 ' + r.rul + ' 天，可在维保工单里派工', 'danger');
      } else if (auto.reason === 'duplicate') {
        toast('风险 ' + r.score + ' 分，已有未闭环工单 ' + auto.order.id, '未重复建单', 'warn');
      } else {
        toast('推理完成：' + r.levelText + ' · ' + r.score + ' 分', '估计剩余寿命 ' + r.rul + ' 天，未触发自动建单');
      }
    },
    'goto-predict': function (el) {
      closeDrawer();
      Store.setUI({ predictDevice: el.dataset.id });
      PREDICT = null;
      location.hash = '#/predict';
      render();
    },
    'run-demo': runDemo,
    'view-device': function (el) { openDeviceView(el.dataset.id); },
    'edit-device': function (el) { openDeviceForm(el.dataset.id); },
    'new-device': function () { openDeviceForm(null); },
    'save-device': function (el) {
      var id = el.dataset.id;
      var name = document.getElementById('f-name').value.trim();
      if (!name) { toast('请填写设备名称', '', 'warn'); return; }
      var patch = {
        name: name,
        type: document.getElementById('f-type').value,
        line: document.getElementById('f-line').value,
        status: document.getElementById('f-status').value,
        installedAt: document.getElementById('f-installed').value,
        hours: Number(document.getElementById('f-hours').value) || 0
      };
      var d = id ? Store.updateDevice(id, patch) : Store.addDevice(patch);
      closeDrawer(); render();
      toast(id ? '台账已更新' : '设备 ' + d.id + ' 已创建', '已生成对应的模拟采样批次');
    },
    'new-order': openOrderForm,
    'save-order': function () {
      var o = Store.addOrder({
        deviceId: document.getElementById('f-device').value,
        source: document.getElementById('f-source').value,
        riskScore: Math.max(0, Math.min(99, Number(document.getElementById('f-score').value) || 0)),
        description: document.getElementById('f-desc').value.trim()
      });
      closeDrawer(); highlightOrder = o.id; render();
      toast('工单 ' + o.id + ' 已创建', '当前状态：待处理');
    },
    'view-order': function (el) { openOrderView(el.dataset.id); },
    'advance-order': function (el) {
      var id = el.dataset.id;
      var who = (document.getElementById('f-handler') || {}).value || '值班班组';
      var o = S.orders.find(function (x) { return x.id === id; });
      if (!o) return;
      Store.updateOrder(id, { status: '处理中', handler: who.trim() || '值班班组', log: o.log.concat([{ at: new Date().toISOString(), text: '派工给 ' + who.trim() + '，开始处理' }]) });
      render(); openOrderView(id);
      toast('工单已推进到「处理中」', '处理人：' + who.trim());
    },
    'finish-order': function (el) {
      var id = el.dataset.id;
      var note = (document.getElementById('f-note') || {}).value || '处理完成并归档';
      var o = S.orders.find(function (x) { return x.id === id; });
      if (!o) return;
      Store.updateOrder(id, { status: '已完成', log: o.log.concat([{ at: new Date().toISOString(), text: note.trim() }]) });
      render(); openOrderView(id);
      toast('工单已闭环', '总览的工单统计已同步刷新');
    }
  };

  var changes = {
    'dash-device': function (el) { Store.setUI({ dashDevice: el.value }); render(); },
    'signal-device': function (el) { Store.setUI({ signalDevice: el.value }); render(); },
    'predict-device': function (el) { Store.setUI({ predictDevice: el.value }); render(); },
    'realtime': function (el) { Store.setUI({ realtime: el.checked }); el.checked ? startRealtime() : stopRealtime(); toast(el.checked ? '实时推送已开启' : '实时推送已暂停'); },
    'asset-type': function (el) { F.assetType = el.value; refreshRows('asset-rows', assetRows); },
    'asset-status': function (el) { F.assetStatus = el.value; refreshRows('asset-rows', assetRows); },
    'order-status': function (el) { F.orderStatus = el.value; refreshRows('order-rows', orderRows); },
    'order-source': function (el) { F.orderSource = el.value; refreshRows('order-rows', orderRows); }
  };

  var inputs = {
    'asset-q': function (el) { F.assetQ = el.value; refreshRows('asset-rows', assetRows); },
    'order-q': function (el) { F.orderQ = el.value; refreshRows('order-rows', orderRows); }
  };

  function refreshRows(id, fn) {
    var t = document.getElementById(id);
    if (t) t.innerHTML = fn();
  }

  /* ---------- 实时曲线 ---------- */
  function startRealtime() {
    stopRealtime();
    LIVE.timer = setInterval(function () {
      if (!Charts.get('chart-realtime') || !S.ui.realtime) return;
      var d = dev(S.ui.dashDevice);
      LIVE.tick += 1;
      LIVE.points.push(Simulator.live(d, LIVE.tick, LIVE.points[LIVE.points.length - 1]));
      if (LIVE.points.length > 48) LIVE.points.shift();
      Charts.realtime('chart-realtime', LIVE.points);
    }, 2000);
  }
  function stopRealtime() { if (LIVE.timer) { clearInterval(LIVE.timer); LIVE.timer = null; } }

  /* ---------- 渲染 ---------- */
  var views = { dashboard: viewDashboard, signal: viewSignal, predict: viewPredict, assets: viewAssets, orders: viewOrders };

  function route() {
    var r = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
    return ROUTES.indexOf(r) === -1 ? 'dashboard' : r;
  }

  function render() {
    hideTip();
    var r = route();
    stopRealtime();
    Charts.disposeAll();
    document.getElementById('view').innerHTML = views[r]();
    document.getElementById('crumb-current').textContent = CRUMB[r];
    document.querySelectorAll('#nav a').forEach(function (a) {
      a.classList.toggle('is-active', a.dataset.nav === r);
    });

    if (r === 'dashboard') {
      var q = Universe.create(S.orders).query({ groupBy: 'status', select: { $count: true } });
      var data = ['待处理', '处理中', '已完成'].map(function (k) {
        var hit = q.data.find(function (x) { return x.key === k; });
        return { key: k, value: { count: hit ? hit.value.count : 0 } };
      });
      Charts.orders('chart-orders', data);
      var b = S.batches[S.ui.dashDevice] || S.batches[S.devices[0].id];
      LIVE.points = [];
      if (b && b.clean) {
        for (var i = Math.max(0, b.points - 36); i < b.points; i++) {
          LIVE.points.push({ time: b.startAt + i * b.interval, temp: b.clean.temp[i], current: b.clean.current[i] });
        }
      }
      LIVE.tick = b ? b.points : 0;
      Charts.realtime('chart-realtime', LIVE.points);
      if (S.ui.realtime) startRealtime();
    } else if (r === 'signal') {
      var sb = S.batches[S.ui.signalDevice] || S.batches[S.devices[0].id];
      Charts.signal('chart-signal', sb, S.ui.metric);
    } else if (r === 'predict' && PREDICT && PREDICT.result.deviceId === S.ui.predictDevice) {
      Charts.features('chart-features', PREDICT.result.features);
    }
  }

  function bind() {
    bindTips();
    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      var fn = handlers[el.dataset.action];
      if (fn) { e.preventDefault(); fn(el, e); }
    });
    document.addEventListener('change', function (e) {
      var el = e.target.closest('[data-change]');
      if (!el) return;
      var fn = changes[el.dataset.change];
      if (fn) fn(el, e);
    });
    document.addEventListener('input', function (e) {
      var el = e.target.closest('[data-input]');
      if (!el) return;
      var fn = inputs[el.dataset.input];
      if (fn) fn(el, e);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
    window.addEventListener('hashchange', render);
    window.addEventListener('resize', function () { Charts.resizeAll(); });
  }

  function startClock() {
    function tick() {
      var d = new Date();
      document.getElementById('clock').textContent =
        d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + d.toTimeString().slice(0, 8);
    }
    tick(); setInterval(tick, 1000);
  }

  async function boot() {
    await Model.load();
    Store.init();
    S = Store.state;
    if (!location.hash) location.hash = '#/dashboard';
    bind();
    render();
    startClock();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
