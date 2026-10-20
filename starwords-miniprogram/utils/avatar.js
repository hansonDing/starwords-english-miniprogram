// 星星形象（Avatar）：纯逻辑模块，不碰 wx、无副作用，方便直接跑自检。
//
// 精灵图取图约定（与单词图完全一致）：
//   <view class="avatar-clip">            ← 外层裁切：position:relative + overflow:hidden
//     <image class="avatar-img" ...>      ← 内层整图位移：宽 400%、高 200%
//   tx = -100 / cols * col ，ty = -100 / rows * row
//   （百分比相对**内层图自身**尺寸，所以位移量要除以列数/行数）
//
// ⚠️ 三处必须同时改，否则真机取图错位且零报错：
//     · 本文件 SPRITE
//     · starwords-miniprogram-scripts/gen-avatars.py（生成器）
//     · starwords-miniprogram/app.wxss 里 .avatar-img 的 400% / 200%
//   check-static [4m] 会拦。

// 4 列 × 2 行：第 0 行男孩（boy-1..4），第 1 行女孩（girl-1..4）
const SPRITE = { cols: 4, rows: 2, cell: 192, src: '../../assets/avatars.png' };

const GENDERS = [
  { id: 'boy', name: '男孩' },
  { id: 'girl', name: '女孩' },
];

const DEFAULT_ID = 'boy-1';

// 8 个拟人卡通形象。顺序 = 精灵图落位顺序（左到右、上到下）：
// 第 i 个形象在第 (i % 4) 列、第 floor(i / 4) 行。
// id / 名称必须与 starwords-miniprogram-scripts/avatar-map.json 完全一致（check-static [4m] 比对）。
const LIST = [
  { id: 'boy-1', gender: 'boy', name: '棒球帽', col: 0, row: 0 },
  { id: 'boy-2', gender: 'boy', name: '短袖T恤', col: 1, row: 0 },
  { id: 'boy-3', gender: 'boy', name: '背带裤', col: 2, row: 0 },
  { id: 'boy-4', gender: 'boy', name: '小超人', col: 3, row: 0 },
  { id: 'girl-1', gender: 'girl', name: '蝴蝶结', col: 0, row: 1 },
  { id: 'girl-2', gender: 'girl', name: '双马尾', col: 1, row: 1 },
  { id: 'girl-3', gender: 'girl', name: '花裙子', col: 2, row: 1 },
  { id: 'girl-4', gender: 'girl', name: '草帽', col: 3, row: 1 },
];

/** 按 id 查形象；查不到返回 null（**不兜底**，需要兜底请用 tileOf） */
function findById(id) {
  if (typeof id !== 'string' || !id) return null;
  for (let i = 0; i < LIST.length; i++) {
    if (LIST[i].id === id) return LIST[i];
  }
  return null;
}

/** 某个性别的全部形象；非法性别返回空数组（不抛异常） */
function listByGender(gender) {
  return LIST.filter((x) => x.gender === gender);
}

/**
 * 老存档里的形象 id 迁移。
 *
 * 形象曾经是「每性别 6 个」，现在只有 4 个 —— 存着 girl-5 / girl-6 的孩子
 * 如果被直接兜底成默认形象（男孩），就是「我女儿突然变成男孩」，静默又刺眼。
 * 所以：形式是 `<性别>-<序号>` 但序号已下线 → 迁移到**同性别第 1 个**。
 *
 * 完全不是形象 id → 返回 ''（由调用方决定是清空还是兜底默认）。
 */
function migrateId(id) {
  if (typeof id !== 'string' || !id) return '';
  const item = findById(id);
  if (item) return item.id; // 还在册 → 原样返回
  const m = /^(boy|girl)-\d+$/.exec(id);
  if (!m) return '';
  const list = listByGender(m[1]);
  return list.length ? list[0].id : '';
}

/** 把任意脏数据归一成合法 id（合法 → 原样；老 id → 同性别第 1 个；其余 → 默认形象） */
function normalizeId(id) {
  const item = findById(id);
  if (item) return item.id;
  return migrateId(id) || DEFAULT_ID;
}

/** 取图坐标（百分比，已按 4×2 算好）：返回数字，WXML 里直接 translate({{tx}}%, {{ty}}%) */
function coordsOf(item) {
  return {
    tx: Math.round((-100 / SPRITE.cols) * item.col * 100) / 100,
    ty: Math.round((-100 / SPRITE.rows) * item.row * 100) / 100,
  };
}

/**
 * 拿一个可以直接渲染的「图块」：{ id, gender, name, col, row, tx, ty }
 * **永不返回 null** —— 脏数据一律兜底成默认形象。页面靠这条保证形象不会空白。
 */
function tileOf(id) {
  const item = findById(normalizeId(id));
  const c = coordsOf(item);
  return {
    id: item.id,
    gender: item.gender,
    name: item.name,
    col: item.col,
    row: item.row,
    tx: c.tx,
    ty: c.ty,
  };
}

function defaultTile() {
  return tileOf(DEFAULT_ID);
}

module.exports = {
  SPRITE,
  GENDERS,
  LIST,
  DEFAULT_ID,
  findById,
  listByGender,
  migrateId,
  normalizeId,
  coordsOf,
  tileOf,
  defaultTile,
};
