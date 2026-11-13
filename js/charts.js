/*
 * ECharts 统一图表层：四张图共用同一套坐标、提示框与配色，
 * 不在各页面里散落 option，切换视图时统一销毁与重建。
 */
(function (global) {
  'use strict';

  var C = {
    ink: '#20261f',
    ink2: '#4b544b',
    muted: '#7d867c',
    line: '#d3d9cf',
    split: '#eef1ea',
    accent: '#2e6b60',
    accentLight: '#7b9c94',
    amber: '#ab7624',
    danger: '#a54b3c',
    raw: '#b3bcb2'
  };
  var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  var instances = {};

  function base() {
    return {
      textStyle: { fontFamily: FONT, color: C.ink2, fontSize: 11.5 },
      animationDuration: 420,
      animationDurationUpdate: 260,
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#fff',
        borderColor: '#e6e9e2',
        borderWidth: 1,
        padding: [9, 12],
        textStyle: { color: C.ink, fontSize: 12, fontFamily: FONT },
        extraCssText: 'box-shadow:0 6px 20px rgba(28,36,29,.09);border-radius:6px;',
        axisPointer: { type: 'line', lineStyle: { color: '#c8d0c5', width: 1 } }
      },
      legend: { show: false },
      grid: { left: 14, right: 18, top: 20, bottom: 6, containLabel: true }
    };
  }

  function catAxis(data, withLabel) {
    return {
      type: 'category', data: data, boundaryGap: false,
      axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false },
      interval: Math.max(0, Math.floor(data.length / 9) - 1),
      axisLabel: {
        color: C.muted, fontSize: 10.5, margin: 10, hideOverlap: true,
        show: withLabel !== false,
        formatter: function (v) { return String(v).slice(3); }
      }
    };
  }

  function valAxis(name, opts) {
    return Object.assign({
      type: 'value', name: name || '', nameTextStyle: { color: C.muted, fontSize: 10.5, padding: [0, 0, 0, 4] },
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: C.muted, fontSize: 10.5 },
      splitLine: { lineStyle: { color: C.split, type: 'dashed' } }
    }, opts || {});
  }

  function mount(id) {
    var el = document.getElementById(id);
    if (!el || !global.echarts) return null;
    if (instances[id]) { instances[id].dispose(); delete instances[id]; }
    var chart = global.echarts.init(el, null, { renderer: 'canvas' });
    instances[id] = chart;
    return chart;
  }

  function get(id) { return instances[id]; }
  function disposeAll() {
    Object.keys(instances).forEach(function (k) { instances[k].dispose(); });
    instances = {};
  }
  function resizeAll() {
    Object.keys(instances).forEach(function (k) { try { instances[k].resize(); } catch (e) { /* noop */ } });
  }

  function timeLabels(batch) {
    var out = [];
    for (var i = 0; i < batch.points; i++) {
      var d = new Date(batch.startAt + i * batch.interval);
      out.push(d.toTimeString().slice(0, 8));
    }
    return out;
  }

  function signal(id, batch, metric) {
    var chart = mount(id);
    if (!chart) return;
    var isTemp = metric === 'temp';
    var labels = timeLabels(batch);
    var raw = batch.raw[metric];
    var clean = batch.clean ? batch.clean[metric] : null;
    var spikeIdx = (batch.spikeIdx && batch.spikeIdx[metric]) || [];
    var missing = (batch.missing || []).filter(function (m) { return m.channel === metric; });
    var marks = spikeIdx.map(function (i) { return { value: [i, raw[i]], kind: 'spike' }; })
      .concat(missing.map(function (m) { return { value: [m.index, null], kind: 'missing' }; }));

    var series = [
      {
        name: '原始读数', type: 'line', data: raw, showSymbol: false, connectNulls: false, z: 2,
        lineStyle: { color: C.raw, width: 1.3, type: 'dashed' }, itemStyle: { color: C.raw }
      },
      {
        name: '清洗后', type: 'line', data: clean || [], showSymbol: false, smooth: 0.2, z: 3,
        lineStyle: { color: C.accent, width: 2 }, itemStyle: { color: C.accent }
      },
      {
        name: '异常标记', type: 'scatter', z: 5, symbolSize: 7,
        data: marks.map(function (m) {
          return { value: m.value, itemStyle: { color: m.kind === 'missing' ? C.amber : C.danger } };
        }),
        tooltip: { show: false }
      }
    ];

    chart.setOption(Object.assign(base(), {
      grid: { left: 14, right: 20, top: 22, bottom: 8, containLabel: true },
      xAxis: catAxis(labels),
      yAxis: valAxis('', { scale: true }),
      tooltip: Object.assign(base().tooltip, {
        formatter: function (items) {
          var head = '<div style="color:#7d867c;font-size:11px;margin-bottom:5px">' + items[0].axisValue + '</div>';
          var lines = items.filter(function (it) { return it.seriesName !== '异常标记' && it.value !== null && it.value !== undefined && it.value !== '-'; })
            .map(function (it) {
              return '<div style="display:flex;justify-content:space-between;gap:20px">' +
                '<span>' + it.marker + it.seriesName + '</span><b style="font-variant-numeric:tabular-nums">' +
                Number(it.value).toFixed(2) + ' ' + (isTemp ? '℃' : 'A') + '</b></div>';
            }).join('');
          return head + lines;
        }
      }),
      series: series
    }), true);
  }

  function realtime(id, points) {
    var chart = get(id) || mount(id);
    if (!chart) return;
    var labels = points.map(function (p) { return new Date(p.time).toTimeString().slice(0, 8); });
    chart.setOption(Object.assign(base(), {
      grid: { left: 14, right: 20, top: 22, bottom: 8, containLabel: true },
      xAxis: catAxis(labels),
      yAxis: [
        valAxis('', { scale: true }),
        valAxis('', { scale: true, splitLine: { show: false } })
      ],
      series: [
        {
          name: '温度', type: 'line', yAxisIndex: 0, data: points.map(function (p) { return p.temp; }),
          showSymbol: false, smooth: 0.25, lineStyle: { color: C.accent, width: 2 },
          areaStyle: { color: 'rgba(46,107,96,.075)' }, itemStyle: { color: C.accent }
        },
        {
          name: '电流', type: 'line', yAxisIndex: 1, data: points.map(function (p) { return p.current; }),
          showSymbol: false, smooth: 0.25, lineStyle: { color: C.amber, width: 1.6 }, itemStyle: { color: C.amber }
        }
      ]
    }), true);
  }

  function orders(id, data) {
    var chart = mount(id);
    if (!chart) return;
    var palette = { '待处理': C.danger, '处理中': C.amber, '已完成': C.accentLight };
    var items = data.map(function (d) {
      return {
        value: d.value.count,
        itemStyle: { color: palette[d.key] || C.accentLight, borderRadius: [3, 3, 0, 0] }
      };
    });
    chart.setOption(Object.assign(base(), {
      grid: { left: 14, right: 18, top: 24, bottom: 4, containLabel: true },
      xAxis: {
        type: 'category', data: data.map(function (d) { return d.key; }),
        axisLine: { lineStyle: { color: C.line } }, axisTick: { show: false },
        axisLabel: { color: C.ink2, fontSize: 11.5, margin: 10 }
      },
      yAxis: valAxis('张', { minInterval: 1, min: 0 }),
      tooltip: Object.assign(base().tooltip, { trigger: 'item', formatter: '{b}：{c} 张工单' }),
      series: [{
        type: 'bar', barWidth: 34, data: items,
        label: { show: true, position: 'top', color: C.ink, fontSize: 12, fontFamily: FONT }
      }]
    }), true);
  }

  function features(id, rows) {
    var chart = mount(id);
    if (!chart) return;
    var sorted = rows.slice().sort(function (a, b) { return a.contribution - b.contribution; });
    var max = Math.max.apply(null, rows.map(function (r) { return r.contribution; }));
    chart.setOption(Object.assign(base(), {
      grid: { left: 10, right: 40, top: 12, bottom: 4, containLabel: true },
      xAxis: valAxis('', { max: Math.max(20, Math.ceil(max + 4)), splitLine: { lineStyle: { color: C.split, type: 'dashed' } } }),
      yAxis: {
        type: 'category', data: sorted.map(function (r) { return r.label; }),
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: C.ink2, fontSize: 11.5, margin: 10 }
      },
      tooltip: Object.assign(base().tooltip, {
        trigger: 'item',
        formatter: function (p) {
          var r = sorted[p.dataIndex];
          return r.label + '<br/>观测值 <b>' + r.value + ' ' + r.unit + '</b><br/>对风险分 <b>' +
            (r.contribution > 0 ? '+' : '') + r.contribution + '</b> 分';
        }
      }),
      series: [{
        type: 'bar', barWidth: 12,
        data: sorted.map(function (r) {
          return { value: r.contribution, itemStyle: { color: r.contribution === max ? C.amber : C.accent, borderRadius: [0, 3, 3, 0] } };
        }),
        label: { show: true, position: 'right', color: C.muted, fontSize: 11, formatter: '{c}' }
      }]
    }), true);
  }

  global.Charts = { mount: mount, get: get, disposeAll: disposeAll, resizeAll: resizeAll, signal: signal, realtime: realtime, orders: orders, features: features, colors: C };
})(window);
