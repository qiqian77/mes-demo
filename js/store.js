/*
 * 单一状态源：设备、工单、清洗批次、清洗记录都保存在这里，
 * 并写入 localStorage，刷新页面不会丢演示数据。
 */
(function (global) {
  'use strict';

  var KEY = 'mes-demo-state-v2';
  var state = null;

  function isoAgo(hours) { return new Date(Date.now() - hours * 3600000).toISOString(); }
  function pad(n, len) { return String(n).padStart(len || 3, '0'); }

  // stage = 已消耗的寿命比例，ratedLife = 该型号的额定寿命（天）。
  // degrade 只是同型号设备之间的小幅个体差异，训练样本也在这个范围内取样。
  var DEVICE_SEED = [
    { id: 'EQ-01', name: '主轴驱动单元', type: 'S26a', line: '一号装配线', status: 'online', installedAt: '2023-04-18', hours: 12480, stage: 0.10, ratedLife: 140, degrade: 0.92,  tempBase: 65, currentBase: 18.2 },
    { id: 'EQ-02', name: '液压泵站',     type: 'S51d', line: '一号装配线', status: 'online', installedAt: '2022-11-06', hours: 18760, stage: 0.22, ratedLife: 132, degrade: 0.945, tempBase: 67, currentBase: 19.1 },
    { id: 'EQ-03', name: '冷却风机',     type: 'S100', line: '二号装配线', status: 'online', installedAt: '2021-08-30', hours: 26340, stage: 0.88, ratedLife: 128, degrade: 0.97,  tempBase: 66, currentBase: 17.8 },
    { id: 'EQ-04', name: '送料伺服',     type: 'Saa3', line: '二号装配线', status: 'online', installedAt: '2023-09-12', hours: 9810,  stage: 0.50, ratedLife: 150, degrade: 0.995, tempBase: 68, currentBase: 18.6 },
    { id: 'EQ-05', name: '减速机',       type: 'S26a', line: '三号装配线', status: 'online', installedAt: '2024-02-25', hours: 6240,  stage: 0.06, ratedLife: 145, degrade: 1.02,  tempBase: 64, currentBase: 17.4 },
    { id: 'EQ-06', name: '空压机组',     type: 'S51d', line: '动力站',     status: 'offline', installedAt: '2020-06-14', hours: 34120, stage: 0.04, ratedLife: 120, degrade: 1.045, tempBase: 69, currentBase: 20.3 },
    { id: 'EQ-07', name: '循环水泵',     type: 'S100', line: '三号装配线', status: 'online', installedAt: '2022-03-19', hours: 21150, stage: 0.32, ratedLife: 136, degrade: 1.07,  tempBase: 65, currentBase: 17.9 },
    { id: 'EQ-08', name: '卷绕机构',     type: 'Saa3', line: '一号装配线', status: 'online', installedAt: '2023-01-08', hours: 14220, stage: 0.48, ratedLife: 130, degrade: 1.095, tempBase: 68, currentBase: 18.9 }
  ];

  function order(id, deviceId, source, riskScore, status, hoursAgo, handler, description) {
    return {
      id: id, deviceId: deviceId, source: source, riskScore: riskScore, status: status,
      createdAt: isoAgo(hoursAgo), handler: handler || '', description: description || '',
      log: [{ at: isoAgo(hoursAgo), text: '工单创建' + (source === '人工录入' ? '（人工录入）' : '（' + source + '）') }]
        .concat(status !== '待处理' ? [{ at: isoAgo(Math.max(0, hoursAgo - 1)), text: status === '处理中' ? '派工给 ' + (handler || '值班班组') + '，开始处理' : '处理完成并归档' }] : [])
    };
  }

  function runFrom(batch) {
    var steps = batch.steps || [];
    return {
      id: 'R-' + batch.id.slice(2),
      batchId: batch.id,
      deviceId: batch.deviceId,
      createdAt: batch.cleanedAt || batch.createdAt,
      points: batch.points,
      missing: (steps[0] && steps[0].count) || 0,
      spikes: (steps[1] && steps[1].count) || 0,
      window: 5,
      method: '线性插值 · Hampel · 5 点滑动平均',
      rawKept: true
    };
  }

  function buildSeed() {
    var s = {
      version: 2,
      devices: DEVICE_SEED.map(function (d) { return Object.assign({}, d); }),
      orders: [],
      runs: [],
      batches: {},
      seq: { order: 6, device: 8 },
      ui: { dashDevice: 'EQ-03', signalDevice: 'EQ-03', predictDevice: 'EQ-03', metric: 'temp', realtime: true }
    };

    s.devices.forEach(function (d, i) {
      var batch = global.Simulator.generate(d, 20261112 + i * 137, d.stage);
      global.Simulator.clean(batch);
      s.batches[d.id] = batch;
      var r = global.Model.infer(batch, d);
      d.riskScore = r.score;
      d.level = r.level;
      d.rul = r.rul;
      d.lastCheck = batch.cleanedAt;
    });

    // 工单上的风险分取该设备建档时的评估值，和台账里显示的一致
    var risk = function (id) { return s.devices.find(function (d) { return d.id === id; }).riskScore; };
    s.orders = [
      order('WO-20261112-006', 'EQ-03', 'AI 预测自动生成', risk('EQ-03'), '已完成', 20, '张师傅', '冷却风机温升超阈值自动建单，更换轴承并复测后归档；近期温升再次抬头。'),
      order('WO-20261112-005', 'EQ-04', '人工录入', risk('EQ-04'), '处理中', 9, '李工', '送料伺服温升偏快，安排润滑与温升复测。'),
      order('WO-20261112-004', 'EQ-07', '人工录入', risk('EQ-07'), '待处理', 6, '', '循环水泵例行巡检，检查机械密封。'),
      order('WO-20261112-003', 'EQ-02', '人工录入', risk('EQ-02'), '已完成', 19, '王工', '液压泵站压力波动，滤芯更换完成。'),
      order('WO-20261112-002', 'EQ-01', '人工录入', risk('EQ-01'), '待处理', 4, '', '主轴驱动单元季度保养。'),
      order('WO-20261112-001', 'EQ-05', '巡检录入', risk('EQ-05'), '待处理', 2, '', '减速机油位检查。')
    ];

    ['EQ-01', 'EQ-07', 'EQ-04'].forEach(function (id, i) {
      var b = Object.assign({}, s.batches[id]);
      b.cleanedAt = isoAgo(5 - i * 1.7);
      s.runs.push(runFrom(b));
    });
    return s;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* file:// 下可能不可写，内存态仍可用 */ }
  }

  function init() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.version === 2 && parsed.devices && parsed.orders && parsed.batches) { state = parsed; return state; }
      }
    } catch (e) { /* 忽略，重新播种 */ }
    state = buildSeed();
    save();
    return state;
  }

  function device(id) { return state.devices.find(function (d) { return d.id === id; }); }

  function woId() {
    state.seq.order += 1;
    var d = new Date();
    return 'WO-' + d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) + '-' + pad(state.seq.order);
  }

  function addOrder(data) {
    var o = Object.assign({
      id: woId(), createdAt: new Date().toISOString(), status: '待处理', handler: '', log: []
    }, data);
    if (!o.log.length) o.log = [{ at: o.createdAt, text: '工单创建' + (o.source === '人工录入' ? '（人工录入）' : '（' + o.source + '）') }];
    state.orders.unshift(o);
    save();
    return o;
  }

  function updateOrder(id, patch) {
    var o = state.orders.find(function (x) { return x.id === id; });
    if (!o) return null;
    Object.assign(o, patch);
    save();
    return o;
  }

  function autoOrder(device, result) {
    if (result.level !== 'high') return { created: false, reason: 'low' };
    var dup = state.orders.find(function (o) {
      return o.deviceId === device.id && o.status !== '已完成' && Math.abs(o.riskScore - result.score) <= 3;
    });
    if (dup) return { created: false, reason: 'duplicate', order: dup };
    var o = addOrder({
      deviceId: device.id,
      source: 'AI 预测自动生成',
      riskScore: result.score,
      status: '待处理',
      description: '模型估计剩余寿命约 ' + result.rul + ' 天（额定 ' + result.ratedLife + ' 天），风险分 ' + result.score + '。' + result.advice
    });
    return { created: true, order: o };
  }

  function addDevice(data) {
    state.seq.device += 1;
    var id = 'EQ-' + pad(state.seq.device, 2);
    var d = Object.assign({
      id: id, status: 'online', installedAt: new Date().toISOString().slice(0, 10),
      hours: 0, stage: 0.08, ratedLife: 128, degrade: 1.0,
      tempBase: 66, currentBase: 18, line: '一号装配线', type: 'S26a'
    }, data, { id: id });
    var batch = global.Simulator.generate(d, Date.now() >>> 0, d.stage);
    global.Simulator.clean(batch);
    state.batches[id] = batch;
    var r = global.Model.infer(batch, d);
    d.riskScore = r.score; d.level = r.level; d.rul = r.rul; d.lastCheck = batch.cleanedAt;
    state.devices.push(d);
    save();
    return d;
  }

  function updateDevice(id, patch) {
    var d = device(id);
    if (!d) return null;
    Object.assign(d, patch);
    save();
    return d;
  }

  function setBatch(deviceId, batch) {
    state.batches[deviceId] = batch;
    var d = device(deviceId);
    if (d) {
      var r = global.Model.infer(batch, d);
      d.riskScore = r.score; d.level = r.level; d.rul = r.rul; d.lastCheck = batch.cleanedAt;
    }
    save();
  }

  function addRun(batch) {
    var r = runFrom(batch);
    state.runs.unshift(r);
    if (state.runs.length > 24) state.runs.length = 24;
    save();
    return r;
  }

  function reset() {
    try { localStorage.removeItem(KEY); } catch (e) { /* noop */ }
    state = buildSeed();
    save();
    return state;
  }

  global.Store = {
    init: init, save: save, reset: reset,
    get state() { return state; },
    device: device, addDevice: addDevice, updateDevice: updateDevice,
    addOrder: addOrder, updateOrder: updateOrder, autoOrder: autoOrder,
    setBatch: setBatch, addRun: addRun,
    setUI: function (patch) { Object.assign(state.ui, patch); save(); }
  };
})(window);
