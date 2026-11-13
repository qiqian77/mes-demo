/*
 * Universe 数据查询层
 * 按 Universe / crossfilter-universe（https://github.com/artem-khromov/universe）
 * 的 filter + query(groupBy / select) 语义实现一个轻量本地版本。
 * 项目没有构建步骤，所以不引入打包依赖，直接在浏览器里跑同一套查询写法：
 *   Universe.create(rows).filter('status', '待处理').query({ groupBy: 'type', select: { $count: true } })
 * 台账筛选、告警排序、工单统计都走这一层，保证各页看到的是同一份过滤结果。
 */
(function (global) {
  'use strict';

  var OPS = {
    $eq: function (a, b) { return a === b; },
    $ne: function (a, b) { return a !== b; },
    $gt: function (a, b) { return a > b; },
    $gte: function (a, b) { return a >= b; },
    $lt: function (a, b) { return a < b; },
    $lte: function (a, b) { return a <= b; },
    $in: function (a, b) { return Array.isArray(b) && b.indexOf(a) !== -1; }
  };

  function test(value, condition) {
    if (condition === null || condition === undefined) return true;
    if (typeof condition === 'function') return !!condition(value);
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      return Object.keys(condition).every(function (op) {
        var fn = OPS[op];
        return fn ? fn(value, condition[op]) : true;
      });
    }
    if (Array.isArray(condition)) return OPS.$in(value, condition);
    return value === condition;
  }

  function rowMatches(row, filters) {
    return Object.keys(filters).every(function (key) {
      return test(row[key], filters[key]);
    });
  }

  function Universe(rows) {
    this.rows = Array.isArray(rows) ? rows.slice() : [];
    this.filters = {};
  }

  Universe.prototype.filter = function (field, condition) {
    if (field && typeof field === 'object') {
      var obj = field;
      for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) this.filters[k] = obj[k];
    } else {
      this.filters[field] = condition;
    }
    return this;
  };

  Universe.prototype.clear = function (field) {
    if (field) delete this.filters[field];
    else this.filters = {};
    return this;
  };

  Universe.prototype.visible = function () {
    var filters = this.filters;
    return this.rows.filter(function (row) { return rowMatches(row, filters); });
  };

  Universe.prototype.add = function (rows) {
    this.rows = this.rows.concat(rows || []);
    return this;
  };

  Universe.prototype.query = function (spec) {
    spec = spec || {};
    var extra = spec.filter || {};
    var rows = this.visible().filter(function (row) { return rowMatches(row, extra); });
    var groups = {};
    var order = [];

    rows.forEach(function (row) {
      var key = spec.groupBy ? row[spec.groupBy] : '全部';
      var label = key === undefined || key === null || key === '' ? '未填写' : String(key);
      if (!groups[label]) { groups[label] = []; order.push(label); }
      groups[label].push(row);
    });

    var select = spec.select || { $count: true };
    var data = order.map(function (key) {
      var list = groups[key];
      var value = {};
      Object.keys(select).forEach(function (out) {
        var rule = select[out];
        if (out === '$count') { value.count = list.length; return; }
        var op = typeof rule === 'string' ? rule : (rule && rule.$sum) ? '$sum' : (rule && rule.$avg) ? '$avg' : null;
        var src = (rule && (rule.$sum || rule.$avg)) || out;
        if (op === '$sum') value[out] = list.reduce(function (s, r) { return s + (Number(r[src]) || 0); }, 0);
        else if (op === '$avg') value[out] = list.length ? list.reduce(function (s, r) { return s + (Number(r[src]) || 0); }, 0) / list.length : 0;
        else value[out] = list.reduce(function (s, r) { return s + (Number(r[out]) || 0); }, 0);
      });
      return { key: key, value: value, rows: list };
    });

    return {
      data: data,
      total: rows.length,
      rows: rows,
      keys: order,
      filters: Object.assign({}, this.filters, extra)
    };
  };

  global.Universe = {
    create: function (rows) { return new Universe(rows); },
    count: function (rows, filter) {
      return global.Universe.create(rows).query({ select: { $count: true }, filter: filter || {} }).total;
    }
  };
})(window);
