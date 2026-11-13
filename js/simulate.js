/*
 * 本地信号模拟器与清洗流水线
 * 不接任何硬件：温度(℃)、电流(A) 两路时序由一台带退化机理的模拟器生成。
 *
 * 退化模型：设备有额定寿命 ratedLife 和当前寿命阶段 stage(0–1)。
 * 随 stage 增大，温度基线抬升、窗口内温升变陡、噪声与毛刺增多、电流波动加大。
 * 训练样本与页面上的实时读数都调用这里的 generate()，是同一套数据分布。
 *
 * 清洗流程对应参考论文的「去噪 → 特征」环节，用浏览器可跑的轻量实现代替：
 * 线性插值补缺失、Hampel 滤波压尖峰、5 点滑动平均平滑，最后按训练集统计量标准化。
 */
(function (global) {
  'use strict';

  var POINTS = 120;
  var INTERVAL = 5000; // 5 秒一个采样点

  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s += 0x6D2B79F5;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gauss(rand) {
    var u = Math.max(rand(), 1e-9), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function round(x) { return Math.round(x * 100) / 100; }
  function mean(a) { return a.reduce(function (s, x) { return s + x; }, 0) / (a.length || 1); }
  function median(a) {
    var b = a.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(b.length / 2);
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }
  function std(a) {
    var m = mean(a);
    return Math.sqrt(mean(a.map(function (x) { return (x - m) * (x - m); })));
  }
  function slope(a) {
    var n = a.length, mx = (n - 1) / 2, my = mean(a), num = 0, den = 0;
    for (var i = 0; i < n; i++) { num += (i - mx) * (a[i] - my); den += (i - mx) * (i - mx); }
    return den ? num / den : 0;
  }
  function ripple(a) {
    var s = 0;
    for (var i = 1; i < a.length; i++) s += Math.abs(a[i] - a[i - 1]);
    return s / Math.max(1, a.length - 1);
  }

  /**
   * @param device 需含 tempBase / currentBase / degrade / stage
   * @param seed   显式随机种子，保证同一批数据可复现
   * @param stage  寿命阶段，省略时用 device.stage
   */
  function generate(device, seed, stage) {
    var rand = rng(seed || 1);
    var d = device.degrade == null ? 1 : device.degrade;
    var p = typeof stage === 'number' ? stage : (device.stage == null ? 0.5 : device.stage);
    var tBase = device.tempBase || 66;
    var cBase = device.currentBase || 18;
    var startAt = Date.now() - (POINTS - 1) * INTERVAL;
    var temp = [], current = [], outliers = [], missing = [];

    for (var i = 0; i < POINTS; i++) {
      var frac = i / POINTS;
      var t = tBase + d * (4 + 12 * p) + d * 5 * p * frac
        + 1.1 * Math.sin(i / 9) + gauss(rand) * (0.8 + d * 1.8 * p);
      var c = cBase + d * (1 + 2.2 * p) + 0.45 * Math.sin(i / 6 + 1)
        + gauss(rand) * (0.3 + d * 0.8 * p);

      if (rand() < 0.012 + d * 0.055 * p) {
        t += (7 + rand() * 9) * (rand() > 0.45 ? 1 : -1);
        outliers.push({ index: i, channel: 'temp', raw: round(t) });
      }
      if (rand() < 0.010 + d * 0.032 * p) {
        c += (4 + rand() * 4) * (rand() > 0.5 ? 1 : -1);
        outliers.push({ index: i, channel: 'current', raw: round(c) });
      }
      temp.push(round(t));
      current.push(round(c));
    }

    // 传感器偶发丢包：留出 3 个空洞，交给清洗环节补齐
    [17, 63, 104].forEach(function (idx) {
      var ch = idx === 63 ? current : temp;
      missing.push({ index: idx, channel: idx === 63 ? 'current' : 'temp' });
      ch[idx] = null;
    });

    return {
      id: 'B-' + new Date(startAt).getTime().toString(36).toUpperCase().slice(-6) + '-' + String(Math.floor(rand() * 90) + 10),
      deviceId: device.id,
      createdAt: new Date().toISOString(),
      startAt: startAt,
      interval: INTERVAL,
      points: POINTS,
      stage: Math.round(p * 1000) / 1000,
      seed: seed >>> 0,
      raw: { temp: temp, current: current },
      clean: null,
      outliers: outliers,
      missing: missing,
      steps: [],
      cleanedAt: null
    };
  }

  function fillMissing(arr) {
    var out = arr.slice(), count = 0;
    for (var i = 0; i < out.length; i++) {
      if (out[i] !== null) continue;
      var l = i - 1, r = i + 1;
      while (l >= 0 && out[l] === null) l--;
      while (r < out.length && out[r] === null) r++;
      var lv = l >= 0 ? out[l] : null, rv = r < out.length ? out[r] : null;
      out[i] = lv !== null && rv !== null ? (lv + rv) / 2 : (lv !== null ? lv : (rv !== null ? rv : 0));
      count++;
    }
    return { values: out, count: count };
  }

  function hampel(arr, radius, k) {
    var out = arr.slice(), hits = [];
    for (var i = 0; i < arr.length; i++) {
      // 统计窗口排除中心点，否则尖峰自己会把 MAD 拉大、把自己掩盖过去
      var from = Math.max(0, i - radius), to = Math.min(arr.length - 1, i + radius), win = [];
      for (var j = from; j <= to; j++) if (j !== i) win.push(arr[j]);
      var med = median(win);
      var mad = median(win.map(function (x) { return Math.abs(x - med); }));
      var limit = k * 1.4826 * Math.max(mad, 0.1);
      if (Math.abs(arr[i] - med) > limit) { out[i] = med; hits.push(i); }
    }
    return { values: out, hits: hits };
  }

  function smooth(arr, radius) {
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var from = Math.max(0, i - radius), to = Math.min(arr.length - 1, i + radius);
      var s = 0;
      for (var j = from; j <= to; j++) s += arr[j];
      out.push(s / (to - from + 1));
    }
    return out;
  }

  function clean(batch) {
    var filledT = fillMissing(batch.raw.temp), filledC = fillMissing(batch.raw.current);
    var ht = hampel(filledT.values, 3, 3), hc = hampel(filledC.values, 3, 3);
    var t = smooth(ht.values, 2), c = smooth(hc.values, 2);
    var spikeCount = ht.hits.length + hc.hits.length;

    batch.clean = { temp: t.map(round), current: c.map(round) };
    batch.spikeIdx = { temp: ht.hits, current: hc.hits };
    batch.cleanedAt = new Date().toISOString();
    batch.steps = [
      { name: '缺失值填补', rule: '相邻点线性插值', count: filledT.count + filledC.count, unit: '点' },
      { name: '尖峰抑制', rule: 'Hampel 滤波 · 窗口 7（排除中心点）· 3×MAD', count: spikeCount, unit: '点' },
      { name: '高频平滑', rule: '5 点滑动平均，对应论文的高通滤波 + 小波降噪环节', count: 0, unit: '' },
      { name: '特征标准化', rule: '减去训练集均值、除以训练集标准差（仅模型输入）', count: 0, unit: '' }
    ];
    return batch;
  }

  // 全部使用相对量，避免设备型号基线温度/电流差异成为混杂因素
  function features(batch, device) {
    var src = batch.clean || {
      temp: batch.raw.temp.filter(function (x) { return x !== null; }),
      current: batch.raw.current.filter(function (x) { return x !== null; })
    };
    return {
      tempRise: mean(src.temp) - (device.tempBase || 66),
      tempStd: std(src.temp),
      tempTrend: slope(src.temp),
      currentRise: mean(src.current) - (device.currentBase || 18),
      currentStd: std(src.current),
      spikeRate: (batch.outliers ? batch.outliers.length : 0) / (batch.points * 2),
      ripple: ripple(src.current)
    };
  }

  // 大屏实时曲线：从上一读数做带均值回归的小步随机游走，接续历史批次末尾
  function live(device, tick, prev) {
    var d = device.degrade == null ? 1 : device.degrade;
    var p = device.stage == null ? 0.5 : device.stage;
    var targetT = (device.tempBase || 66) + d * (4 + 17 * p);
    var targetC = (device.currentBase || 18) + d * (1 + 2.2 * p);
    var baseT = prev ? prev.temp : targetT;
    var baseC = prev ? prev.current : targetC;
    var spike = (tick % 37 === 0) ? (3 + d * 4 * p) : 0;
    return {
      time: Date.now(),
      temp: round(baseT + (targetT - baseT) * 0.22 + Math.sin(tick / 6) * 0.16 + (Math.random() - 0.5) * (0.6 + d * 1.1 * p) + spike),
      current: round(baseC + (targetC - baseC) * 0.22 + (Math.random() - 0.5) * (0.18 + d * 0.16 * p))
    };
  }

  function toCSV(batch, device) {
    var lines = ['时间,设备编号,原始温度(℃),清洗温度(℃),原始电流(A),清洗电流(A),异常标记'];
    for (var i = 0; i < batch.points; i++) {
      var ts = new Date(batch.startAt + i * batch.interval).toISOString().replace('T', ' ').slice(0, 19);
      var flagT = (batch.spikeIdx && batch.spikeIdx.temp.indexOf(i) !== -1) || batch.missing.some(function (m) { return m.index === i && m.channel === 'temp'; });
      var flagC = (batch.spikeIdx && batch.spikeIdx.current.indexOf(i) !== -1) || batch.missing.some(function (m) { return m.index === i && m.channel === 'current'; });
      lines.push([
        ts, device.id,
        batch.raw.temp[i] === null ? '' : batch.raw.temp[i],
        batch.clean ? batch.clean.temp[i] : '',
        batch.raw.current[i] === null ? '' : batch.raw.current[i],
        batch.clean ? batch.clean.current[i] : '',
        flagT || flagC ? '异常' : ''
      ].join(','));
    }
    return '\ufeff' + lines.join('\r\n');
  }

  global.Simulator = {
    POINTS: POINTS,
    INTERVAL: INTERVAL,
    generate: generate,
    clean: clean,
    features: features,
    live: live,
    toCSV: toCSV,
    util: { mean: mean, std: std, slope: slope, median: median, ripple: ripple }
  };
})(window);
