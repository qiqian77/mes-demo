/*
 * 本地轻量模型推理
 * 权重不是手写的：由 tools/build-model.mjs 在带标签的样本上做标准化岭回归训练得到，
 * 评估报告见 model/evaluation.json。页面只做前向计算，不训练、不联网、不调推理服务。
 *
 * 推理链：清洗后窗口 → 7 个相对量特征 → 按训练集均值/标准差标准化
 *        → 线性加权得到「剩余寿命占额定寿命的比例」(0–1)
 *        → 乘以该设备额定寿命得到天数；风险分 = 100 × (1 − 该比例)。
 * 风险分和剩余寿命是同一个量的两种表达，不会互相矛盾。
 */
(function (global) {
  'use strict';

  var config = global.MES_RISK_MODEL_FALLBACK;
  var source = 'model/risk-model.js（本地内联副本）';

  function validate(cfg) {
    return cfg && typeof cfg.bias === 'number' && Array.isArray(cfg.features) &&
      cfg.features.length > 0 && typeof cfg.features[0].mean === 'number' &&
      cfg.training && cfg.evaluation && cfg.thresholds;
  }

  function info() {
    return {
      name: config.name,
      version: config.version,
      kind: config.kind,
      builtAt: config.builtAt,
      featureCount: config.features.length,
      source: source,
      training: config.training,
      evaluation: config.evaluation,
      comparison: config.comparison,
      reference: config.reference
    };
  }

  async function load() {
    // file:// 下 fetch 一定会被 CORS 拦下，直接走内联副本，不在控制台留错误
    if (location.protocol !== 'file:') {
      try {
        var res = await fetch('model/risk-model.json', { cache: 'no-store' });
        if (res.ok) {
          var json = await res.json();
          if (validate(json)) { config = json; source = 'model/risk-model.json（fetch 加载）'; }
        }
      } catch (err) {
        // 读不到就继续用训练脚本生成的内联副本，两份内容一致
      }
    }
    return info();
  }

  function infer(batch, device) {
    var f = global.Simulator.features(batch, device);
    var ratio = config.bias;
    var rows = config.features.map(function (def) {
      var value = f[def.key] || 0;
      var z = (value - def.mean) / (def.std || 1);
      var effect = def.weight * z;
      ratio += effect;
      return {
        key: def.key,
        label: def.label,
        unit: def.unit,
        weight: def.weight,
        value: Math.round(value * 1000) / 1000,
        norm: Math.round(z * 100) / 100,
        // 对风险分的影响：+ 表示把风险推高，- 表示拉低；单位与风险分一致
        contribution: Math.round(-100 * effect * 10) / 10
      };
    });

    ratio = Math.max(0, Math.min(1, ratio));
    var score = Math.round(100 * (1 - ratio));
    var level = score >= config.thresholds.high ? 'high' : score >= config.thresholds.medium ? 'medium' : 'low';
    var ratedLife = device.ratedLife || 128;
    var rul = Math.round(ratio * ratedLife);
    var advice = {
      high: '模型估计剩余寿命约 ' + rul + ' 天，温升与电流波动已明显偏离基线。建议 24 小时内安排停机检查并准备备件；风险超过阈值，系统会自动创建维保工单。',
      medium: '模型估计剩余寿命约 ' + rul + ' 天，存在缓慢退化迹象。建议纳入本周巡检，重点观察温升斜率与电流纹波，暂不调整生产计划。',
      low: '模型估计剩余寿命约 ' + rul + ' 天，各项特征接近基线。按常规周期巡检即可，无需调整维护计划。'
    }[level];

    return {
      score: score,
      level: level,
      levelText: { high: '高风险', medium: '需关注', low: '正常' }[level],
      ratio: Math.round(ratio * 1000) / 1000,
      rul: rul,
      ratedLife: ratedLife,
      stage: batch.stage,
      advice: advice,
      features: rows,
      deviceId: device.id,
      at: new Date().toISOString(),
      model: config.name + ' / ' + config.version
    };
  }

  global.Model = { load: load, infer: infer, info: info, get config() { return config; } };
})(window);
