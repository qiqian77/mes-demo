/*
 * 离线训练 / 评估脚本（零第三方依赖）
 *
 *   node tools/build-model.mjs            生成数据集、训练多个模型、输出对比报告
 *   node tools/build-model.mjs --verify   重新训练并核对现有产物是否可复现
 *
 * 数据全部来自 js/simulate.js 这台本地模拟器 —— 与页面上的实时读数是同一套代码。
 * 标签按参考论文的「按寿命比例构造样本」定义：remainingRatio = 1 - stage。
 * 训练集 / 测试集按设备划分（同一台设备不会同时出现在两边），避免泄漏。
 *
 * 除页面在用的标准化岭回归外，还在同一数据、同一划分、同一评估口径下训练了
 * 常数基线 / kNN / 梯度提升树 / 多层感知机，用来做真正可比的模型对比。
 * 论文表 5 的数值单独列出作为方法对照，数据集与标签口径不同，不能直接比大小。
 *
 * 注意：这是模拟数据上的回归实验，不是现场采集数据，也不是论文模型的复现。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY = process.argv.includes('--verify');
const SEED = 20261112;
const N_DEVICES = 48;
const STAGES = Array.from({ length: 19 }, (_, i) => (i + 1) * 0.05);
const LAMBDA = 0.01;

const FEATURES = [
  { key: 'tempRise',    label: '相对基线温升', unit: '℃' },
  { key: 'tempStd',     label: '温度波动',     unit: '℃' },
  { key: 'tempTrend',   label: '温升斜率',     unit: '℃/点' },
  { key: 'currentRise', label: '相对基线电流', unit: 'A' },
  { key: 'currentStd',  label: '电流波动',     unit: 'A' },
  { key: 'spikeRate',   label: '毛刺占比',     unit: '比例' },
  { key: 'ripple',      label: '电流纹波',     unit: 'A' }
];

/* ---------- 载入与页面完全相同的模拟器 ---------- */
const simSrc = fs.readFileSync(path.join(ROOT, 'js/simulate.js'), 'utf8');
const ctx = vm.createContext({ console, Math, Date, JSON });
ctx.window = ctx;
vm.runInContext(simSrc, ctx, { filename: 'js/simulate.js' });
const Sim = ctx.Simulator;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const n6 = x => Number(x).toFixed(6);

/* ---------- 1. 生成带标签的样本集 ---------- */
const devices = Array.from({ length: N_DEVICES }, (_, i) => ({
  id: 'TR-' + String(i + 1).padStart(2, '0'),
  degrade: 0.85 + rand() * 0.30,
  tempBase: 64 + rand() * 6,
  currentBase: 17 + rand() * 3,
  ratedLife: 90 + rand() * 70
}));

// 固定种子洗牌后按设备 8:2 划分，测试设备对训练过程完全不可见
const order = devices.map((_, i) => i);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}
const testIds = new Set(order.slice(0, Math.round(N_DEVICES * 0.2)).map(i => devices[i].id));

const samples = [];
devices.forEach((dev, di) => {
  STAGES.forEach((stage, si) => {
    const seed = (SEED + di * 10007 + si * 101) >>> 0;
    const batch = Sim.generate(dev, seed, stage);
    Sim.clean(batch);
    const f = Sim.features(batch, dev);
    const row = {
      deviceId: dev.id,
      split: testIds.has(dev.id) ? 'test' : 'train',
      stage: n6(stage),
      remainingRatio: n6(1 - stage),
      ratedLife: n6(dev.ratedLife),
      degrade: n6(dev.degrade),
      tempBase: n6(dev.tempBase),
      currentBase: n6(dev.currentBase)
    };
    FEATURES.forEach(fe => { row[fe.key] = n6(f[fe.key]); });
    samples.push(row);
  });
});

const csvHeader = ['deviceId', 'split', 'stage', 'remainingRatio', 'ratedLife', 'degrade', 'tempBase', 'currentBase', ...FEATURES.map(f => f.key)];
const csv = [csvHeader.join(',')].concat(samples.map(s => csvHeader.map(k => s[k]).join(','))).join('\n') + '\n';
const datasetSha = crypto.createHash('sha256').update(csv).digest('hex');

/* ---------- 2. 共享工具：标准化、求解、评估 ---------- */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    if (Math.abs(d) < 1e-12) throw new Error('矩阵奇异，无法求解');
    for (let j = col; j <= n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (!f) continue;
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(row => row[n]);
}

function metrics(pairs) {
  const n = pairs.length;
  const mae = pairs.reduce((a, [t, p]) => a + Math.abs(t - p), 0) / n;
  const rmse = Math.sqrt(pairs.reduce((a, [t, p]) => a + (t - p) ** 2, 0) / n);
  const ybar = pairs.reduce((a, [t]) => a + t, 0) / n;
  const sst = pairs.reduce((a, [t]) => a + (t - ybar) ** 2, 0);
  const sse = pairs.reduce((a, [t, p]) => a + (t - p) ** 2, 0);
  return { mae, rmse, r2: sst ? 1 - sse / sst : 0, n };
}

const train = samples.filter(s => s.split === 'train');
const test = samples.filter(s => s.split === 'test');
const keys = FEATURES.map(f => f.key);
const X = s => keys.map(k => Number(s[k]));
const y = s => Number(s.remainingRatio);
const life = s => Number(s.ratedLife);
const clamp01 = v => Math.max(0, Math.min(1, v));

const mu = keys.map((_, j) => train.reduce((a, s) => a + X(s)[j], 0) / train.length);
const sigma = keys.map((_, j) => {
  const m = mu[j];
  return Math.sqrt(train.reduce((a, s) => a + (X(s)[j] - m) ** 2, 0) / train.length) || 1;
});
const z = s => keys.map((k, j) => (Number(s[k]) - mu[j]) / sigma[j]);
const Ztr = train.map(z);
const ytr = train.map(y);
const yMean = ytr.reduce((a, v) => a + v, 0) / ytr.length;

function evaluate(key, name, family, predictFn, inUse) {
  const ratioPairs = test.map(s => [y(s), clamp01(predictFn(s))]);
  const dayPairs = test.map(s => [y(s) * life(s), clamp01(predictFn(s)) * life(s)]);
  const mr = metrics(ratioPairs), md = metrics(dayPairs);
  return {
    key, name, family, inUse: !!inUse,
    MAE: Number(mr.mae.toFixed(4)),
    RMSE: Number(mr.rmse.toFixed(4)),
    R2: Number(mr.r2.toFixed(4)),
    MAE_days: Number(md.mae.toFixed(2)),
    RMSE_days: Number(md.rmse.toFixed(2))
  };
}

/* ---------- 3. 页面在用模型：标准化岭回归（闭式解） ---------- */
const zMean = keys.map((_, j) => Ztr.reduce((a, row) => a + row[j], 0) / Ztr.length);
const yc = ytr.map(v => v - yMean);
const A = keys.map((_, i) => keys.map((_, j) =>
  Ztr.reduce((a, row) => a + row[i] * row[j], 0) + (i === j ? LAMBDA : 0)
));
const b = keys.map((_, i) => Ztr.reduce((a, row, r) => a + row[i] * yc[r], 0));
const w = solve(A, b);
const bias = yMean - w.reduce((a, wi, i) => a + wi * zMean[i], 0);
const ridgePredict = s => bias + w.reduce((a, wi, i) => a + wi * z(s)[i], 0);

/* ---------- 4. 同口径基准模型 ---------- */
// 4.1 常数基线
const constantPredict = () => yMean;

// 4.2 k 近邻回归（标准化特征、欧氏距离、k=7）
const KNN_K = 7;
function knnPredict(s) {
  const q = z(s), dist = [];
  for (let i = 0; i < Ztr.length; i++) {
    let d = 0;
    for (let j = 0; j < q.length; j++) d += (q[j] - Ztr[i][j]) ** 2;
    dist.push([d, ytr[i]]);
  }
  dist.sort((a, b) => a[0] - b[0]);
  let sum = 0;
  for (let i = 0; i < KNN_K; i++) sum += dist[i][1];
  return sum / KNN_K;
}

// 4.3 CART 回归树 + 梯度提升（对应论文中 LGBM / XGBoost 那类树模型）
const thresholds = keys.map((_, j) => {
  const vals = Ztr.map(row => row[j]).sort((a, b) => a - b);
  return Array.from({ length: 12 }, (_, q) => vals[Math.floor((q + 1) / 13 * vals.length)])
    .filter((v, i, arr) => arr.indexOf(v) === i);
});
const MIN_LEAF = 12, MAX_DEPTH = 3;

function buildTree(rows, targets, depth) {
  const n = rows.length;
  const leafValue = targets.reduce((a, v) => a + v, 0) / n;
  if (depth >= MAX_DEPTH || n < MIN_LEAF * 2) return { leaf: true, value: leafValue };
  let best = null;
  for (let j = 0; j < keys.length; j++) {
    for (const t of thresholds[j]) {
      let nl = 0, sl = 0, sr = 0;
      for (let i = 0; i < n; i++) {
        if (rows[i][j] <= t) { nl++; sl += targets[i]; } else sr += targets[i];
      }
      if (nl < MIN_LEAF || n - nl < MIN_LEAF) continue;
      const total = sl + sr;
      const gain = sl * sl / nl + sr * sr / (n - nl) - total * total / n;
      if (!best || gain > best.gain) best = { j, t, gain };
    }
  }
  if (!best || best.gain <= 1e-9) return { leaf: true, value: leafValue };
  const li = [], ri = [], lt = [], rt = [];
  for (let i = 0; i < n; i++) {
    if (rows[i][best.j] <= best.t) { li.push(rows[i]); lt.push(targets[i]); }
    else { ri.push(rows[i]); rt.push(targets[i]); }
  }
  return {
    leaf: false, j: best.j, t: best.t,
    left: buildTree(li, lt, depth + 1),
    right: buildTree(ri, rt, depth + 1)
  };
}
function treePredict(node, row) {
  while (!node.leaf) node = row[node.j] <= node.t ? node.left : node.right;
  return node.value;
}
const GBDT_ROUNDS = 60, GBDT_LR = 0.08;
const gbdtTrees = [];
{
  const F = Ztr.map(() => yMean);
  for (let m = 0; m < GBDT_ROUNDS; m++) {
    const residual = Ztr.map((_, i) => ytr[i] - F[i]);
    const tree = buildTree(Ztr, residual, 0);
    gbdtTrees.push(tree);
    for (let i = 0; i < Ztr.length; i++) F[i] += GBDT_LR * treePredict(tree, Ztr[i]);
  }
}
function gbdtPredict(s) {
  const row = z(s);
  let v = yMean;
  for (const tree of gbdtTrees) v += GBDT_LR * treePredict(tree, row);
  return v;
}

// 4.4 单隐层多层感知机（对应论文中深度学习模型的轻量替身）
const HIDDEN = 12, EPOCHS = 160, BATCH = 32, LR = 0.05;
const mlpRand = rng(SEED ^ 0x5f3a9c);
const W1 = Array.from({ length: HIDDEN }, () => Array.from({ length: keys.length }, () => (mlpRand() - 0.5) * 0.6));
const b1 = Array(HIDDEN).fill(0);
const W2 = Array.from({ length: HIDDEN }, () => (mlpRand() - 0.5) * 0.6);
let b2 = yMean;
{
  const idx = Ztr.map((_, i) => i);
  for (let ep = 0; ep < EPOCHS; ep++) {
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(mlpRand() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    for (let st = 0; st < idx.length; st += BATCH) {
      const batch = idx.slice(st, st + BATCH);
      const gW1 = Array.from({ length: HIDDEN }, () => Array(keys.length).fill(0));
      const gb1 = Array(HIDDEN).fill(0);
      const gW2 = Array(HIDDEN).fill(0);
      let gb2 = 0;
      for (const i of batch) {
        const x = Ztr[i];
        const h = Array(HIDDEN);
        for (let k = 0; k < HIDDEN; k++) {
          let s = b1[k];
          for (let j = 0; j < keys.length; j++) s += W1[k][j] * x[j];
          h[k] = Math.tanh(s);
        }
        let out = b2;
        for (let k = 0; k < HIDDEN; k++) out += W2[k] * h[k];
        const d = out - ytr[i];
        for (let k = 0; k < HIDDEN; k++) {
          gW2[k] += d * h[k];
          const dh = d * W2[k] * (1 - h[k] * h[k]);
          gb1[k] += dh;
          for (let j = 0; j < keys.length; j++) gW1[k][j] += dh * x[j];
        }
        gb2 += d;
      }
      const scale = LR / batch.length;
      for (let k = 0; k < HIDDEN; k++) {
        for (let j = 0; j < keys.length; j++) W1[k][j] -= scale * gW1[k][j];
        b1[k] -= scale * gb1[k];
        W2[k] -= scale * gW2[k];
      }
      b2 -= scale * gb2;
    }
  }
}
function mlpPredict(s) {
  const x = z(s);
  let out = b2;
  for (let k = 0; k < HIDDEN; k++) {
    let v = b1[k];
    for (let j = 0; j < keys.length; j++) v += W1[k][j] * x[j];
    out += W2[k] * Math.tanh(v);
  }
  return out;
}

/* ---------- 5. 统一评估与双层对比 ---------- */
const comparisonRows = [
  evaluate('constant', '常数基线', '对照', constantPredict),
  evaluate('ridge', '标准化岭回归（页面在用）', '线性', ridgePredict, true),
  evaluate('knn', 'k 近邻回归（k=' + KNN_K + '）', '非参数', knnPredict),
  evaluate('gbdt', '梯度提升树（' + GBDT_ROUNDS + ' 轮）', '树模型', gbdtPredict),
  evaluate('mlp', '多层感知机（7-12-1）', '神经网络', mlpPredict)
];
const ridgeRow = comparisonRows.find(r => r.key === 'ridge');
const constantRow = comparisonRows.find(r => r.key === 'constant');

const literature = {
  source: '刘宗宇, 廖雪超.《基于特征融合的机械核心部件剩余寿命预测》表 5「评价指标对比」',
  note: '论文在 916 个全生命周期采样文件上、以剩余寿命天数直接为标签测得，并按 8:2 划分训练/测试；本项目在 912 条本地模拟窗口上、以剩余寿命比例为标签，再按设备额定寿命换算成天数。数据集、标签定义、特征维度与划分口径都不同，两组数值不能比大小，只能看方法谱系与量级。',
  rows: [
    { name: 'M1 LGBM',          family: '树模型',       MAE: 14.647, RMSE: 19.775, R2: 0.890 },
    { name: 'M2 LSTM',          family: '循环网络',     MAE: 6.863,  RMSE: 9.442,  R2: 0.974 },
    { name: 'M3 CNN-BiLSTM',    family: '卷积 + 循环',  MAE: 13.679, RMSE: 18.812, R2: 0.899 },
    { name: 'M4 XGBT-DCNN',     family: '树模型 + 卷积', MAE: 12.672, RMSE: 17.100, R2: 0.917 },
    { name: 'M5 Informer',      family: '注意力模型',   MAE: 10.108, RMSE: 13.472, R2: 0.950 },
    { name: 'M6 XGBT-Informer', family: '本文方法',     MAE: 4.069,  RMSE: 6.422,  R2: 0.988 }
  ]
};

const comparison = {
  note: '全部方法共用同一份 912 条模拟样本、同一按设备 8:2 划分、同一 7 个特征、同一评估口径（MAE / RMSE / R² 针对剩余寿命比例；天数按各设备额定寿命换算）。只有这一层可以直接比较。',
  rows: comparisonRows,
  literature: literature
};

const evaluation = {
  note: '在模拟数据上、按设备留出的测试集测得；不代表真实设备上的泛化能力。',
  split: '按设备 8:2 划分，测试设备未参与训练与标准化统计量计算',
  seed: SEED,
  devices: N_DEVICES,
  stagesPerDevice: STAGES.length,
  samples: samples.length,
  trainSamples: train.length,
  testSamples: test.length,
  testDevices: Array.from(testIds).sort(),
  datasetSha256: datasetSha,
  target: 'remainingRatio = 1 - stage（剩余寿命占额定寿命的比例）',
  model: '标准化岭回归，lambda = ' + LAMBDA,
  ratio: { MAE: ridgeRow.MAE, RMSE: ridgeRow.RMSE, R2: ridgeRow.R2, n: test.length },
  days: { MAE: ridgeRow.MAE_days, RMSE: ridgeRow.RMSE_days, n: test.length },
  baseline: {
    description: '常数预测（训练集标签均值）作为对照，用于确认模型确实学到了退化信号',
    MAE: constantRow.MAE, RMSE: constantRow.RMSE, R2: constantRow.R2
  },
  comparison: { note: comparison.note, rows: comparisonRows }
};

const model = {
  name: 'rul-ridge-v1',
  version: '1.0.0',
  kind: '7 特征标准化岭回归 · 估计剩余寿命比例',
  builtAt: new Date().toISOString(),
  training: {
    script: 'node tools/build-model.mjs',
    verify: 'node tools/build-model.mjs --verify',
    seed: SEED,
    samples: samples.length,
    trainSamples: train.length,
    testSamples: test.length,
    split: evaluation.split,
    datasetSha256: datasetSha,
    lambda: LAMBDA
  },
  features: FEATURES.map((f, i) => ({
    key: f.key, label: f.label, unit: f.unit,
    weight: Number(w[i].toFixed(8)),
    mean: Number(mu[i].toFixed(8)),
    std: Number(sigma[i].toFixed(8))
  })),
  bias: Number(bias.toFixed(8)),
  thresholds: { medium: 42, high: 70 },
  evaluation: evaluation,
  comparison: comparison,
  reference: {
    dataset: '设备类型编号与「按寿命比例构造样本」的做法参考科大讯飞 2019 工程机械核心部件数据集（S26a / S51d / S100 / Saa3 四类、916 个全生命周期采样文件、14 个字段）。本项目数据并非该数据集，而是本地模拟器生成。',
    papers: [
      '刘宗宇, 廖雪超. 基于特征融合的机械核心部件剩余寿命预测. 计算机技术与发展, 2024 (网络首发).',
      '刘晓勇. 基于深度学习的机械设备退化状态建模及剩余寿命预测. 哈尔滨工业大学硕士学位论文, 2018.'
    ],
    reportedMetrics: { model: '文献 XGBT-Informer（非本项目）', MAE: 4.069, RMSE: 6.422, R2: 0.988 },
    caveat: '本项目使用本地模拟数据训练标准化岭回归，未复现论文中的 Informer / LSTM / SDAE，未使用真实设备数据，也未做跨设备型号或跨数据集的泛化验证。同口径对比表可与本项目数据上的其它方法比较；论文表 5 数值仅作方法对照，两者不可比。'
  }
};

/* ---------- 6. 输出或核对 ---------- */
if (VERIFY) {
  const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'model/risk-model.json'), 'utf8'));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const checks = {
    datasetSha256: current.training.datasetSha256 === datasetSha,
    weights: same(current.features.map(f => f.weight), model.features.map(f => f.weight)),
    scaler: same(current.features.map(f => [f.mean, f.std]), model.features.map(f => [f.mean, f.std])),
    bias: current.bias === model.bias,
    evaluation: same(current.evaluation.ratio, evaluation.ratio) && same(current.evaluation.days, evaluation.days),
    comparison: same(current.comparison.rows, model.comparison.rows)
  };
  const ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ reproducible: ok ? 'PASS' : 'FAIL', checks, datasetSha256: datasetSha }, null, 2));
  process.exit(ok ? 0 : 1);
} else {
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  // 不写 BOM：模型里的 datasetSha256 就是这份文件的真实字节哈希，
  // 用 `sha256sum data/samples.csv` 可直接核对
  fs.writeFileSync(path.join(ROOT, 'data/samples.csv'), csv, 'utf8');
  fs.writeFileSync(path.join(ROOT, 'model/evaluation.json'), JSON.stringify(evaluation, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(ROOT, 'model/comparison.json'), JSON.stringify(comparison, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(ROOT, 'model/risk-model.json'), JSON.stringify(model, null, 2) + '\n', 'utf8');
  fs.writeFileSync(
    path.join(ROOT, 'model/risk-model.js'),
    '/* 本文件由 tools/build-model.mjs 自动生成，请勿手工编辑。\n' +
    '   file:// 下 fetch 被浏览器跳过，页面直接使用这份内联副本。 */\n' +
    'window.MES_RISK_MODEL_FALLBACK = ' + JSON.stringify(model, null, 2) + ';\n',
    'utf8'
  );
  console.log('样本      ' + samples.length + ' 条（训练 ' + train.length + ' / 测试 ' + test.length + '），测试设备 ' + testIds.size + ' 台');
  console.log('同口径对比（剩余寿命比例 / R²，越低越好的是 MAE、RMSE）');
  comparisonRows.forEach(r => {
    console.log('  ' + (r.inUse ? '* ' : '  ') + r.name.padEnd(26, ' ') +
      ' MAE ' + String(r.MAE).padEnd(7) + ' RMSE ' + String(r.RMSE).padEnd(7) +
      ' R² ' + String(r.R2).padEnd(7) + ' 天数 MAE ' + r.MAE_days);
  });
  console.log('论文表 5  ' + literature.rows.length + ' 个模型的报告值已写入对照（数据集不同，不可比）');
  console.log('数据集    data/samples.csv  sha256 ' + datasetSha.slice(0, 16) + '…');
  console.log('已写出    model/risk-model.json / .js / evaluation.json / comparison.json');
}
