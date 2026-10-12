/**
 * dsh-pet 设置页（独立模式版）—— 与宿主既有的 HTTP 契约对接，零框架、零构建。
 *
 * 数据流（与 DSH 内的 React 设置页同一套契约，只是壳不同）：
 *   GET  /dsh-pet-7340/config         → 成品聚合（{ main:{...}, <文件宠物条目>:{...} }）
 *   PUT  /dsh-pet-7340/config         → 白名单写用户层（pets + 四开关 + physics + 模型 + 对话条数）
 *                                        未传的顶层字段由宿主从磁盘透传保留（用户手改的不丢）
 *   PUT  /dsh-pet-7340/config/file    → 原文写用户配置（「查看 / 编辑 JSON」用；整文件替换）
 *   POST /dsh-pet-7340/config         → 恢复默认（把包内默认整份覆盖用户配置）
 *   POST /dsh-pet-7340/reload         → 重载桌面小窗（服务器无图形环境时宿主自动跳过）
 *   GET  /dsh-pet-7340/config/meta    → 配置文件路径（展示给用户，方便直接改）
 *
 * 保存后用 localStorage 发一次信号（dsh-pet-rev），已打开的桌宠页据此重新 boot，
 * 不必手动刷新；桌面小窗那条路走宿主的 syncDesktop（PUT 已触发）。
 */
'use strict';

const API = location.origin + '/dsh-pet-7340';
const REV_KEY = 'dsh-pet-rev';
/** 与 host/config.ts 的 ID_FORBIDDEN 同一套（反斜杠/斜杠/控制字符，防配置值逃逸出文件名） */
const ID_FORBIDDEN = /[\\/:\x00-\x1f]/;
/** physics 的合法域（与 host config.ts 的 physicsValid 同一套规则，前端先拦一遍少一次 400） */
const PHYSICS_RANGE = {
  gravity: [0, 5000],
  restitution: [0, 1],
  groundFriction: [0, 20],
  throwPower: [0.01, 5],
};

/** 宿主合并后的成品条目（main = 用户可编辑层的完成品）；meta = 配置文件路径 */
let merged = null;
let meta = null;
/** 表单草稿：{ pets, globals, physics } —— 只含可写（白名单）字段 */
let draft = null;
let dirty = false;
let loading = false;

const $ = (selector) => document.querySelector(selector);

/** 建元素：props.class/text/on*（事件），其余原样 setAttribute */
// 菜单默认清单/默认外观 —— 与 src/shared/types.ts 的 DEFAULT_MENU_ITEMS / DEFAULT_MENU_STYLE
// 逐字段一致（settings.html 不加载 shared-core，故内嵌一份；改动需两侧同步）。
const DEFAULT_MENU_ITEMS = [
  { id: 'site', label: '桌宠设置', visible: true },
  { id: 'balance', label: '查看余额', visible: true },
  { id: 'whisper', label: '碎碎念', visible: true },
  { id: 'chat', label: '对话', visible: true },
  { id: 'home', label: '回到初始位置', visible: true },
  { id: 'reload', label: '重载配置', visible: true },
  { id: 'animations', label: '动作', visible: true },
];
const DEFAULT_MENU_STYLE = { anim: 'none', fontSize: 13, radius: 8, bg: '#ffffff', fg: '#2b2b2b', hoverBg: '#2b63ff' };

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  let pendingValue;
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2).toLowerCase(), value);
    // value 必须等 min/max/step 落定后再写：range 的属性式赋值会**当场**按旧边界（默认 0~100）
    // 把 498 夹成 100，随后新 min 一上又夹成 120 —— 表单回读永远是错的
    else if (key === 'value') pendingValue = value;
    else node.setAttribute(key, value);
  }
  if (pendingValue !== undefined) node.value = pendingValue;
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

function setStatus(text, kind) {
  const node = $('#status');
  node.textContent = text;
  node.className = kind || '';
}

function setBusy(busy) {
  loading = busy;
  for (const id of ['#btn-save', '#btn-discard', '#add-pet', '#btn-reset', '#btn-reload', '#btn-json']) {
    const node = $(id);
    if (node) node.disabled = busy;
  }
  $('#btn-save').textContent = busy ? '保存中…' : '保存';
  // 忙完回到「未修改就不许点」的口径：load/保存收尾都会走这里，按钮状态只由 dirty 决定
  $('#btn-save').disabled = busy || !dirty;
}

function markDirty() {
  dirty = true;
  setStatus('有未保存的修改', 'dirty');
  $('#btn-save').disabled = loading;
}

/** 只通知别的标签页：桌宠页据此重新 boot（自己这个标签页靠随后的状态刷新） */
function notifyPetPage() {
  try {
    localStorage.setItem(REV_KEY, String(Date.now()));
  } catch {
    /* 隐私模式下 localStorage 可能被禁：忽略即可，用户手动刷新仍生效 */
  }
}

async function api(path, options) {
  let res;
  try {
    res = await fetch(API + path, options);
  } catch (error) {
    throw new Error('网络错误：' + (error && error.message ? error.message : String(error)));
  }
  if (res.status === 401) {
    throw new Error('令牌缺失或错误：请从桌宠页点「设置页」进入，或用带 ?token=… 的地址打开本页');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应（404 文本等）走下面的 status 分支 */
  }
  if (!res.ok) {
    const error = new Error((data && data.error) || 'HTTP ' + res.status);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

/** 成品 → 草稿（只取白名单字段；file pet 条目与派生字段一律不进表单） */
function deriveDraft() {
  const main = (merged && merged.main) || {};
  const base = Array.isArray(main.pets) ? main.pets.filter((p) => p && p.extra !== true) : [];
  const phys = main.physics && typeof main.physics === 'object' ? main.physics : {};
  draft = {
    pets: base.map((p) => ({
      id: String(p.id || ''),
      name: String(p.name || p.id || ''),
      size: Number(p.size) || 462,
      balanceEnabled: p.balanceEnabled === true,
      whisperEnabled: p.whisperEnabled === true,
      workStatusEnabled: p.workStatusEnabled === true,
      fixedEnabled: p.fixedEnabled === true,
      display: ['web', 'desktop', 'both', 'none'].includes(p.display) ? p.display : 'both',
      // 右键菜单：按默认清单为骨架、用成品值补齐（成品由宿主合并保证字段在且合法）；
      // 菜单顺序 = 数组顺序，label/visible 直接来自成品
      menuItems: DEFAULT_MENU_ITEMS.map((d) => {
        const m = Array.isArray(p.menuItems) ? p.menuItems.find((x) => x && x.id === d.id) : null;
        return m ? { id: d.id, label: String(m.label || d.label), visible: m.visible !== false } : { ...d };
      }),
      menuStyle: { ...DEFAULT_MENU_STYLE, ...(p.menuStyle && typeof p.menuStyle === 'object' ? p.menuStyle : {}) },
      position: {
        corner: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(p.position && p.position.corner)
          ? p.position.corner
          : 'bottom-right',
        marginX: Number(p.position && p.position.marginX) || 0,
        marginY: Number(p.position && p.position.marginY) || 0,
      },
    })),
    globals: {
      notificationsEnabled: main.notificationsEnabled === true,
      whisperImageEnabled: main.whisperImageEnabled === true,
      chatImageEnabled: main.chatImageEnabled === true,
      confineToScreen: main.confineToScreen === true,
      chatMemoryRounds: Number(main.chatMemoryRounds) || 0,
      chatImageLimit: Number(main.chatImageLimit) || 0,
    },
    physics: {
      gravity: Number.isFinite(Number(phys.gravity)) ? Number(phys.gravity) : 1400,
      restitution: Number.isFinite(Number(phys.restitution)) ? Number(phys.restitution) : 0.78,
      groundFriction: Number.isFinite(Number(phys.groundFriction)) ? Number(phys.groundFriction) : 2.5,
      ceilingBounce: phys.ceilingBounce !== false,
      throwPower: Number.isFinite(Number(phys.throwPower)) ? Number(phys.throwPower) : 1,
      petCollision: phys.petCollision === true,
    },
  };
}

/** 非 main 条目 = 文件宠物（pet/<名>-config.json）：只读提示，设置页永不回写它们 */
function filePets() {
  if (!merged) return [];
  const out = [];
  for (const [entry, conf] of Object.entries(merged)) {
    if (entry === 'main' || !conf || !Array.isArray(conf.pets)) continue;
    for (const p of conf.pets) out.push({ entry, id: String(p.id || ''), name: String(p.name || p.id || '') });
  }
  return out;
}

// ---------- 控件 ----------

function textField(label, value, onInput, options = {}) {
  const input = el('input', {
    type: 'text',
    value,
    readonly: options.readonly ? '' : undefined,
    oninput: (e) => onInput(e.target.value),
  });
  return el('label', { class: 'field' }, el('span', { class: 'lbl', text: label }), input);
}

function numberField(label, value, onInput, options = {}) {
  const input = el('input', {
    type: 'number',
    value: String(value),
    min: options.min !== undefined ? String(options.min) : undefined,
    max: options.max !== undefined ? String(options.max) : undefined,
    step: options.step !== undefined ? String(options.step) : '1',
    oninput: (e) => onInput(e.target.value === '' ? NaN : Number(e.target.value)),
  });
  return el('label', { class: 'field' }, el('span', { class: 'lbl', text: label }), input);
}

/** 滑杆 + 数字回显（尺寸与物理参数用） */
function rangeField(label, value, min, max, step, onInput) {
  const output = el('output', { text: String(value) });
  const range = el('input', {
    type: 'range',
    value: String(value),
    min: String(min),
    max: String(max),
    step: String(step),
    oninput: (e) => {
      output.textContent = e.target.value;
      onInput(Number(e.target.value));
    },
  });
  const num = el('input', {
    type: 'number',
    value: String(value),
    min: String(min),
    max: String(max),
    step: String(step),
    oninput: (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      range.value = String(v);
      output.textContent = e.target.value;
      onInput(v);
    },
  });
  return el(
    'label',
    { class: 'field' },
    el('span', { class: 'lbl', text: label }),
    el('div', { class: 'range-row' }, range, num, output),
  );
}

function selectField(label, value, options, onChange) {
  const select = el(
    'select',
    { onchange: (e) => onChange(e.target.value) },
    options.map((opt) =>
      el('option', { value: opt.value, selected: opt.value === value ? '' : undefined, text: opt.label }),
    ),
  );
  return el('label', { class: 'field' }, el('span', { class: 'lbl', text: label }), select);
}

/** 圆点开关（布尔）：整块 label 可点，状态显式着色 */
function toggle(label, value, onChange) {
  const input = el('input', {
    type: 'checkbox',
    checked: value ? '' : undefined,
    onchange: (e) => onChange(e.target.checked),
  });
  const node = el('label', { class: 'toggle' + (value ? ' on' : '') }, input, el('span', { class: 'dot' }), label);
  input.addEventListener('change', () => node.classList.toggle('on', input.checked));
  return node;
}

const CORNERS = [
  { value: 'top-left', label: '左上' },
  { value: 'top-right', label: '右上' },
  { value: 'bottom-left', label: '左下' },
  { value: 'bottom-right', label: '右下' },
];
const DISPLAYS = [
  { value: 'web', label: '仅浏览器页' },
  { value: 'desktop', label: '仅桌面小窗' },
  { value: 'both', label: '浏览器 + 桌面' },
  { value: 'none', label: '隐藏（保留配置）' },
];

function cornerField(position) {
  const wrap = el('div', { class: 'corners' });
  for (const opt of CORNERS) {
    const input = el('input', {
      type: 'radio',
      name: 'corner-' + Math.random().toString(36).slice(2),
      value: opt.value,
      checked: opt.value === position.corner ? '' : undefined,
      onchange: () => {
        position.corner = opt.value;
        for (const child of wrap.children)
          child.classList.toggle('on', child.querySelector('input').value === opt.value);
        markDirty();
      },
    });
    wrap.append(el('label', { class: opt.value === position.corner ? 'on' : '' }, input, opt.label));
  }
  return el('div', { class: 'field' }, el('span', { class: 'lbl', text: '停靠角落' }), wrap);
}

// ---------- 渲染 ----------

/** color input 只认 #rrggbb：#rgb 归一化、其它一律回落默认白（读入值来自合法配置，正常都能识别） */
function normalizeHex(c) {
  const s = String(c || '');
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s))
    return (
      '#' +
      s
        .slice(1)
        .split('')
        .map((ch) => ch + ch)
        .join('')
    );
  return '#ffffff';
}

function colorField(label, value, onInput) {
  const input = el('input', {
    type: 'color',
    value: normalizeHex(value),
    oninput: (e) => onInput(e.target.value),
  });
  return el('label', { class: 'field' }, el('span', { class: 'lbl', text: label }), input);
}

/** 一只宠物的「右键菜单」编辑块：菜单项列表（顺序/文字/显示）+ 菜单外观（动画/字号/圆角/三色） */
function renderMenuEditor(pet) {
  const wrap = el('div', { class: 'menu-editor' });
  wrap.append(
    el('div', { class: 'menu-sec', text: '右键菜单（↑↓ 调顺序，即菜单从上到下的顺序；取消「显示」= 该项不出现）' }),
  );
  const rows = el('div', { class: 'menu-rows' });
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= pet.menuItems.length) return;
    const t = pet.menuItems[i];
    pet.menuItems[i] = pet.menuItems[j];
    pet.menuItems[j] = t;
    renderPets();
    markDirty();
  };
  pet.menuItems.forEach((item, i) => {
    const row = el('div', { class: 'menu-row' });
    row.append(
      el('button', {
        class: 'btn small',
        text: '\u2191',
        title: '上移',
        disabled: i === 0 ? '' : undefined,
        onclick: () => move(i, -1),
      }),
      el('button', {
        class: 'btn small',
        text: '\u2193',
        title: '下移',
        disabled: i === pet.menuItems.length - 1 ? '' : undefined,
        onclick: () => move(i, 1),
      }),
      el('code', { class: 'mid', text: item.id }),
      el('input', {
        type: 'text',
        value: item.label,
        maxlength: '40',
        title: '菜单文字（最多 40 字）',
        oninput: (e) => {
          item.label = e.target.value;
          markDirty();
        },
      }),
      el(
        'label',
        { class: 'chk' },
        el('input', {
          type: 'checkbox',
          checked: item.visible ? 'checked' : undefined,
          onchange: (e) => {
            item.visible = e.target.checked;
            markDirty();
          },
        }),
        el('span', { text: '显示' }),
      ),
    );
    rows.append(row);
  });
  wrap.append(rows);

  const st = pet.menuStyle;
  const styleGrid = el('div', { class: 'grid menu-style' });
  styleGrid.append(
    selectField(
      '弹出动画',
      st.anim,
      [
        { value: 'none', label: '无（默认）' },
        { value: 'fade', label: '淡入' },
        { value: 'scale', label: '缩放淡入' },
      ],
      (v) => {
        st.anim = v;
        markDirty();
      },
    ),
    numberField(
      '字号 px（10~24）',
      st.fontSize,
      (v) => {
        st.fontSize = v;
        markDirty();
      },
      { min: 10, max: 24 },
    ),
    numberField(
      '圆角 px（0~24）',
      st.radius,
      (v) => {
        st.radius = v;
        markDirty();
      },
      { min: 0, max: 24 },
    ),
    colorField('面板背景色', st.bg, (v) => {
      st.bg = v;
      markDirty();
    }),
    colorField('文字颜色', st.fg, (v) => {
      st.fg = v;
      markDirty();
    }),
    colorField('悬停底色', st.hoverBg, (v) => {
      st.hoverBg = v;
      markDirty();
    }),
  );
  wrap.append(el('div', { class: 'menu-sec', text: '菜单外观（弹出动画 / 字号 / 圆角 / 配色）' }), styleGrid);
  return wrap;
}

function renderPets() {
  const list = $('#pet-list');
  list.textContent = '';
  draft.pets.forEach((pet, index) => {
    const card = el('div', { class: 'pet-card' + (pet.display === 'none' ? ' is-hidden' : '') });
    card.append(
      el(
        'div',
        { class: 'pet-head' },
        el('span', { class: 'pet-idx', text: String(index + 1) }),
        el('b', { text: pet.name || pet.id || '（未命名）' }),
        el('span', { class: 'id', text: pet.id }),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn small', text: '复制', onclick: () => duplicatePet(index) }),
        el('button', {
          class: 'btn small danger',
          text: '删除',
          disabled: draft.pets.length <= 1 ? '' : undefined,
          onclick: () => removePet(index),
        }),
      ),
    );

    const grid = el('div', { class: 'grid' });
    grid.append(
      textField('显示名（给人看，可重复）', pet.name, (v) => {
        pet.name = v;
        markDirty();
      }),
      textField('标识 id（程序认，唯一；素材按它取）', pet.id, (v) => {
        pet.id = v.trim();
        markDirty();
      }),
      rangeField('尺寸（像素，宠物视频框宽）', pet.size, 120, 900, 6, (v) => {
        pet.size = v;
        markDirty();
      }),
      selectField('显示位置', pet.display, DISPLAYS, (v) => {
        pet.display = v;
        renderPets();
        markDirty();
      }),
      numberField('水平边距 marginX', pet.position.marginX, (v) => {
        pet.position.marginX = v;
        markDirty();
      }),
      numberField('垂直边距 marginY', pet.position.marginY, (v) => {
        pet.position.marginY = v;
        markDirty();
      }),
      cornerField(pet.position),
    );
    card.append(grid);

    const toggles = el('div', { class: 'toggles' });
    toggles.append(
      toggle('宠物固定（不自己走动）', pet.fixedEnabled, (v) => {
        pet.fixedEnabled = v;
        markDirty();
      }),
      toggle('余额功能', pet.balanceEnabled, (v) => {
        pet.balanceEnabled = v;
        markDirty();
      }),
      toggle('碎碎念', pet.whisperEnabled, (v) => {
        pet.whisperEnabled = v;
        markDirty();
      }),
      toggle('工作状态联动', pet.workStatusEnabled, (v) => {
        pet.workStatusEnabled = v;
        markDirty();
      }),
    );
    card.append(toggles);
    card.append(renderMenuEditor(pet));
    list.append(card);
  });

  const files = filePets();
  $('#file-pets').textContent = files.length
    ? `另有 ${files.length} 只文件宠物（${[...new Set(files.map((f) => f.entry))].join('、')}）由 pet/ 目录定义，此处只读、不会被保存覆盖。`
    : '';
}

function renderGlobals() {
  const box = $('#global-fields');
  box.textContent = '';
  const g = draft.globals;
  const add = (label, key) =>
    box.append(
      toggle(label, g[key], (v) => {
        g[key] = v;
        markDirty();
      }),
    );
  add('碎碎念配图', 'whisperImageEnabled');
  add('对话配图', 'chatImageEnabled');
  add('抛掷锁定当前屏幕', 'confineToScreen');
  box.append(
    numberField(
      '对话记忆轮数（0 = 不带历史）',
      g.chatMemoryRounds,
      (v) => {
        g.chatMemoryRounds = v;
        markDirty();
      },
      { min: 0, max: 100 },
    ),
    numberField(
      '对话配图张数上限',
      g.chatImageLimit,
      (v) => {
        g.chatImageLimit = v;
        markDirty();
      },
      { min: 0, max: 20 },
    ),
  );
}

function renderPhysics() {
  const box = $('#physics-fields');
  box.textContent = '';
  const p = draft.physics;
  box.append(
    rangeField('重力 gravity（px/s²，0 = 失重）', p.gravity, 0, 5000, 50, (v) => {
      p.gravity = v;
      markDirty();
    }),
    rangeField('反弹系数 restitution（0~1）', p.restitution, 0, 1, 0.01, (v) => {
      p.restitution = v;
      markDirty();
    }),
    rangeField('地面摩擦 groundFriction（/s）', p.groundFriction, 0, 20, 0.1, (v) => {
      p.groundFriction = v;
      markDirty();
    }),
    rangeField('总力度 throwPower（0.01~5）', p.throwPower, 0.01, 5, 0.01, (v) => {
      p.throwPower = v;
      markDirty();
    }),
  );
  const toggles = $('#physics-toggles');
  toggles.textContent = '';
  toggles.append(
    toggle('碰顶反弹 ceilingBounce', p.ceilingBounce, (v) => {
      p.ceilingBounce = v;
      markDirty();
    }),
    toggle('多宠物互相碰撞 petCollision', p.petCollision, (v) => {
      p.petCollision = v;
      markDirty();
    }),
  );
}

function renderPaths() {
  const dl = $('#paths');
  dl.textContent = '';
  const rows = [
    ['用户配置', meta && meta.user],
    ['内置默认', meta && meta.default],
    ['动画素材', meta && meta.animations],
    ['表情包', meta && meta.memes],
  ];
  for (const [term, value] of rows) {
    if (!value) continue;
    dl.append(el('dt', { text: term }), el('dd', { text: String(value) }));
  }
}

function renderAll() {
  renderPets();
  renderGlobals();
  renderPhysics();
  renderPaths();
  $('#btn-save').disabled = !dirty || loading;
}

// ---------- 校验（与 saveUserConfig 同口径，前端先给红字） ----------

function validateDraft() {
  const errors = [];
  if (!draft.pets.length) errors.push('至少保留一只宠物');
  const seen = new Set();
  draft.pets.forEach((pet, i) => {
    const where = `第 ${i + 1} 只宠物`;
    const id = String(pet.id || '');
    if (!id) errors.push(`${where}：id 不能为空`);
    else if (id.length > 64) errors.push(`${where}：id 超过 64 字符`);
    else if (ID_FORBIDDEN.test(id)) errors.push(`${where}：id 含 \\ / : 或控制字符`);
    else if (seen.has(id)) errors.push(`${where}：id「${id}」与其他宠物重复`);
    if (id) seen.add(id);
    if (!(Number(pet.size) > 0)) errors.push(`${where}：尺寸必须是大于 0 的数字`);
    if (!Number.isFinite(Number(pet.position.marginX)) || !Number.isFinite(Number(pet.position.marginY))) {
      errors.push(`${where}：边距必须是数字`);
    }
    if (!CORNERS.some((c) => c.value === pet.position.corner)) errors.push(`${where}：角落取值非法`);
    if (!DISPLAYS.some((d) => d.value === pet.display)) errors.push(`${where}：显示位置取值非法`);
    // 右键菜单（与后端 menuItemsValid/menuStyleValid 同口径）
    const items = Array.isArray(pet.menuItems) ? pet.menuItems : [];
    if (!items.length) errors.push(`${where}：右键菜单至少保留一项`);
    items.forEach((m) => {
      const ml = String(m.label || '').trim();
      if (!ml) errors.push(`${where}：菜单项「${m.id}」文字不能为空`);
      else if (ml.length > 40) errors.push(`${where}：菜单项「${m.id}」文字超过 40 字`);
    });
    const st = pet.menuStyle;
    if (!['none', 'fade', 'scale'].includes(st.anim)) errors.push(`${where}：菜单动画取值非法`);
    if (!Number.isInteger(Number(st.fontSize)) || Number(st.fontSize) < 10 || Number(st.fontSize) > 24)
      errors.push(`${where}：菜单字号需为 10~24 的整数`);
    if (!Number.isInteger(Number(st.radius)) || Number(st.radius) < 0 || Number(st.radius) > 24)
      errors.push(`${where}：菜单圆角需为 0~24 的整数`);
    for (const c of [st.bg, st.fg, st.hoverBg]) {
      if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(c)))
        errors.push(`${where}：菜单颜色需为 #rgb 或 #rrggbb`);
    }
  });
  const p = draft.physics;
  for (const [key, [lo, hi]] of Object.entries(PHYSICS_RANGE)) {
    const v = Number(p[key]);
    if (!Number.isFinite(v) || v < lo || v > hi) errors.push(`物理参数 ${key} 需在 ${lo} ~ ${hi} 之间`);
  }
  const g = draft.globals;
  if (!Number.isFinite(Number(g.chatMemoryRounds)) || Number(g.chatMemoryRounds) < 0)
    errors.push('对话记忆轮数必须 ≥ 0');
  if (!Number.isFinite(Number(g.chatImageLimit)) || Number(g.chatImageLimit) < 0) errors.push('配图张数上限必须 ≥ 0');
  return errors;
}

/** 草稿 → PUT /config 请求体（只带白名单字段，宿主按「传了才算」处理） */
function saveBody() {
  const body = {
    ...draft.globals,
    chatMemoryRounds: Number(draft.globals.chatMemoryRounds),
    chatImageLimit: Number(draft.globals.chatImageLimit),
    physics: { ...draft.physics },
    pets: draft.pets.map((pet) => ({
      id: pet.id,
      name: pet.name,
      size: Number(pet.size),
      balanceEnabled: !!pet.balanceEnabled,
      whisperEnabled: !!pet.whisperEnabled,
      workStatusEnabled: !!pet.workStatusEnabled,
      fixedEnabled: !!pet.fixedEnabled,
      display: pet.display,
      // 右键菜单：整份随请求（后端 menuItemsValid/menuStyleValid 权威校验，非法整份拒绝）
      menuItems: pet.menuItems.map((m) => ({ id: m.id, label: String(m.label).trim(), visible: m.visible === true })),
      menuStyle: {
        anim: ['none', 'fade', 'scale'].includes(pet.menuStyle.anim) ? pet.menuStyle.anim : 'none',
        fontSize: Number(pet.menuStyle.fontSize),
        radius: Number(pet.menuStyle.radius),
        bg: pet.menuStyle.bg,
        fg: pet.menuStyle.fg,
        hoverBg: pet.menuStyle.hoverBg,
      },
      position: {
        corner: pet.position.corner,
        marginX: Number(pet.position.marginX),
        marginY: Number(pet.position.marginY),
      },
    })),
  };
  return body;
}

// ---------- 动作 ----------

function uniqueId() {
  const used = new Set(draft.pets.map((p) => p.id));
  for (let n = 1; n < 999; n += 1) {
    const id = 'pet' + n;
    if (!used.has(id)) return id;
  }
  return 'pet' + Date.now();
}

function addPet() {
  const template = draft.pets[0];
  draft.pets.push(
    template
      ? JSON.parse(JSON.stringify(template))
      : {
          id: 'pet1',
          name: '新宠物',
          size: 462,
          balanceEnabled: false,
          whisperEnabled: false,
          workStatusEnabled: true,
          fixedEnabled: false,
          display: 'both',
          menuItems: JSON.parse(JSON.stringify(DEFAULT_MENU_ITEMS)),
          menuStyle: { ...DEFAULT_MENU_STYLE },
          position: { corner: 'bottom-right', marginX: 24, marginY: 24 },
        },
  );
  draft.pets[draft.pets.length - 1].id = uniqueId();
  draft.pets[draft.pets.length - 1].name = '新宠物 ' + draft.pets.length;
  renderPets();
  markDirty();
}

function duplicatePet(index) {
  const copy = JSON.parse(JSON.stringify(draft.pets[index]));
  copy.id = uniqueId();
  copy.name = copy.name + ' 副本';
  draft.pets.splice(index + 1, 0, copy);
  renderPets();
  markDirty();
}

function removePet(index) {
  draft.pets.splice(index, 1);
  renderPets();
  markDirty();
}

async function loadConfig() {
  setBusy(true);
  setStatus('正在加载配置…');
  try {
    const [cfg, metaIn] = await Promise.all([api('/config'), api('/config/meta')]);
    merged = cfg;
    meta = metaIn;
    deriveDraft();
    dirty = false;
    renderAll();
    const n = draft.pets.length;
    setStatus(`已加载：${n} 只宠物，文件宠物 ${filePets().length} 只`, '');
  } catch (error) {
    setStatus('加载失败：' + error.message, 'bad');
    $('#pet-err').textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function save() {
  if (loading || !dirty) return;
  const errors = validateDraft();
  if (errors.length) {
    $('#pet-err').textContent = errors.join('\n');
    setStatus('保存被拦下：' + errors[0], 'bad');
    return;
  }
  $('#pet-err').textContent = '';
  setBusy(true);
  try {
    const body = JSON.stringify(saveBody());
    const put = (query) =>
      api('/config' + query, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
    let result;
    try {
      result = await put('');
    } catch (error) {
      // 409 = 用户配置文件连 JSONC 都解析不了（真损坏）：确认后带 force=1 重建
      const file = (error.data && error.data.userFile) || '';
      if (
        error.status === 409 &&
        window.confirm(
          '用户配置文件无法解析（已损坏）：\n' + file + '\n\n继续会按表单内容重建并丢弃该文件的其余内容。继续吗？',
        )
      ) {
        result = await put('?force=1');
      } else {
        throw error;
      }
    }
    merged = result;
    deriveDraft();
    dirty = false;
    renderAll();
    notifyPetPage();
    setStatus('已保存 ' + new Date().toLocaleTimeString(), 'ok');
  } catch (error) {
    setStatus('保存失败：' + error.message, 'bad');
  } finally {
    setBusy(false);
  }
}

async function restoreDefault() {
  if (!window.confirm('把包内默认配置整份覆盖用户配置？\n\n你手改过的精调字段（人设、模型、动画池…）会一并被覆盖。'))
    return;
  setBusy(true);
  try {
    merged = await api('/config', { method: 'POST' });
    deriveDraft();
    dirty = false;
    renderAll();
    notifyPetPage();
    setStatus('已恢复内置默认配置', 'ok');
  } catch (error) {
    setStatus('恢复失败：' + error.message, 'bad');
  } finally {
    setBusy(false);
  }
}

async function reloadDesktop() {
  setBusy(true);
  try {
    await api('/reload', { method: 'POST' });
    setStatus('已请求重载桌面小窗（服务器无图形环境时宿主会自动跳过）', 'ok');
  } catch (error) {
    setStatus('重载失败：' + error.message, 'bad');
  } finally {
    setBusy(false);
  }
}

// ---------- JSON 编辑（原文写用户配置文件；模型/人设/动画池等高级字段只能在这里改） ----------

function ensureJsonSection() {
  let section = $('#sec-json');
  if (section) return section;
  section = el('section', { class: 'card', id: 'sec-json' });
  section.append(
    el('h2', { text: '高级：直接编辑用户配置 JSON' }),
    el('p', {
      class: 'hint',
      text: '下面是合并后的 main 条目（= 用户配置文件的完整形态）。应用后整份覆盖用户配置文件，模型、AI 人设、动画池、表情包等字段以此处为准。',
    }),
    el('textarea', {
      id: 'json-box',
      spellcheck: 'false',
      style:
        'width:100%;min-height:340px;font:12.5px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:10px;border:1px solid #d4d7dd;border-radius:8px;resize:vertical;',
    }),
    el(
      'div',
      { class: 'row', style: 'margin-top:10px;' },
      el('button', { class: 'btn primary', id: 'btn-json-apply', text: '应用到配置文件', onclick: applyJson }),
      el('button', { class: 'btn', text: '取消', onclick: () => (section.style.display = 'none') }),
    ),
    el('p', { class: 'err', id: 'json-err' }),
  );
  // 锚点兜底：HTML 里的锚被改名时也别让整段静默崩掉（null.after 这类错误界面上看不出原因）
  const anchor = $('#sec-files') || $('.wrap');
  if (anchor) anchor.after(section);
  else document.body.append(section);
  return section;
}

async function applyJson() {
  const box = $('#json-box');
  const errNode = $('#json-err');
  errNode.textContent = '';
  let parsed;
  try {
    parsed = JSON.parse(box.value);
  } catch (error) {
    errNode.textContent = 'JSON 解析失败：' + error.message;
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errNode.textContent = '顶层必须是一个 JSON 对象 { … }';
    return;
  }
  if (!window.confirm('用上面的 JSON 整份覆盖用户配置文件？（写盘前会做结构校验）')) return;
  setBusy(true);
  try {
    await api('/config/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    // 写成功只回 { ok, user }：再拉一次成品聚合，让表单按宿主的合并结果重新渲染
    merged = await api('/config');
    deriveDraft();
    dirty = false;
    renderAll();
    notifyPetPage();
    setStatus('已写入配置文件 ' + new Date().toLocaleTimeString(), 'ok');
    $('#sec-json').style.display = 'none';
  } catch (error) {
    errNode.textContent = '写入失败：' + error.message;
  } finally {
    setBusy(false);
  }
}

function openJson() {
  const section = ensureJsonSection();
  $('#json-box').value = JSON.stringify(merged && merged.main ? merged.main : {}, null, 2);
  $('#json-err').textContent = '';
  section.style.display = '';
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- 启动 ----------

function boot() {
  $('#add-pet').addEventListener('click', addPet);
  $('#btn-save').addEventListener('click', save);
  $('#btn-discard').addEventListener('click', () => void loadConfig());
  $('#btn-reset').addEventListener('click', () => void restoreDefault());
  $('#btn-reload').addEventListener('click', () => void reloadDesktop());
  $('#btn-json').addEventListener('click', openJson);
  void loadConfig();
}

document.addEventListener('DOMContentLoaded', boot);
