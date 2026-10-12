// 统一右键菜单组件 —— 桌面（renderer.js 经 shared-core）与浏览器（pet.ts 经 bundle）
// 共用**同一份**菜单树与**同一份**渲染实现（"全部同一个组件"，两端行为/外观严格一致）。
//
// 本文件是 src/shared 唯一的 DOM 渲染例外（共享约定：只含无 DOM 依赖的纯逻辑）：
//   - buildMenuTree / isNoMirrorAnimation：纯函数，可单测，无 DOM；
//   - MENU_CSS / mountContextMenu：DOM 层，两端共用（菜单必须长成同一个样）。
// 菜单数据单一事实来源 = 合并后的 animations 配置（用户覆盖层自动生效）。
//
// 菜单层级（与产品定义一致）：
//   一级 = 工具项 + 动作：打开网站 / 查看余额 / 重载配置（桌面端专属）与 回到初始位置（两端共用），由各壳注入；
//   二级（动作的子级）= 分类：待机 / 转向 / 拖拽 / 点击回应 / 移动 / config 随机动作分类 / 事件档位
//   三级 = 具体动画名
//
// DOM 结构（真正的菜单布局逻辑）：**每一级是独立的面板 div，全部平级挂到根容器下**，
// 各面板按触发项的屏幕位置贴边定位（右侧展开、贴右/下边缘自动翻转）、各自独立滚动；
// 绝不把子面板嵌套进父面板/父项内部（同一容器包裹会让子菜单被父容器的滚动区裁切）。
//
// 级联保持模型（标准菜单行为，杜绝对齐缝隙/面板间移动导致的消失）：
//   - 只要指针还在这棵菜单树内（任意可见面板/项上），就**绝不自动收起**子面板；
//     悬停另一个分类时才切换其子面板（hideChain 旧链 + 展开新链）；
//   - 指针整体离开菜单树（root mouseleave，软 200ms）才关闭整个菜单；
//   - 点击项 / 点击菜单外 / Esc 关闭。
//   不再使用"逐项 mouseleave 延迟关闭定时器"——旧实现里鼠标从分类项移向三级面板时，
//   会同时给父项（动作）排下无人取消的关闭定时器，导致二级+三级一起消失。
import { DEFAULT_MENU_ITEMS, DEFAULT_MENU_STYLE, PET_MODES, PET_MODE_LABELS } from './types';
import type { Animations, Category, MenuItemConfig, MenuStyleConfig, PetMode } from './types';

/** 叶子：可点击的菜单项 */
export interface MenuLeaf {
  label: string;
  /** 播放的动画名（点播动作）；action 优先于 anim */
  anim?: string;
  /** 自定义动作：open-site=打开网站（桌面形态）/ settings=桌宠设置页（浏览器形态）/
   * show-balance=查看余额；whisper=立即碎碎念一句；chat=打开对话弹窗；home=回到初始位置；
   * reload=重载配置（桌面端专属：重启桌面 Helper，全部桌面宠物窗口按最新配置重建——
   * 浏览器端刷新页面即可，不注入此项）；set-mode=切换行为模式（值见 mode 字段）。
   * 手动触发均不受 whisperEnabled 影响（该字段只关自动周期轮询） */
  action?: 'open-site' | 'settings' | 'show-balance' | 'whisper' | 'chat' | 'home' | 'reload' | 'set-mode';
  /** action==='set-mode' 时的目标模式（wander=自由散步 / follow=跟随鼠标 / idle=原地待机） */
  mode?: PetMode;
}

/** 分支：带子菜单的项 */
export interface MenuBranch {
  label: string;
  children: MenuNode[];
}

export type MenuNode = MenuLeaf | MenuBranch;

/** 事件名 → 分类标签（无映射时用事件名本身） */
const EVENT_LABELS: Record<string, string> = {
  balance: '余额档位',
  whisper: '碎碎念',
  workStatus: '工作状态',
};

const leaf = (anim: string): MenuLeaf => ({ label: anim, anim });

/**
 * 由合并后的 animations 配置推导菜单树 —— 输出 [{ 动作 → [ 分类 → [ 具体动画 ] ] }]：
 * 一级只有一个「动作」分支；二级 = 分类（待机/转向/拖拽/点击回应/移动 + config 随机动作
 * 分类 + 事件档位）；三级 = 具体动画名。空池/空分类自动省略。
 */
export function buildMenuTree(animations: Animations): MenuNode[] {
  const groups: MenuNode[] = [];
  const pools: Array<[string, string[]]> = [
    ['待机', animations.idle],
    ['转向', animations.turn],
    ['拖拽', animations.drag],
    ['点击回应', animations.clicks],
    ['移动', animations.moves.actions.map((m) => m.name)],
  ];
  for (const [label, pool] of pools) {
    if (pool.length) groups.push({ label, children: pool.map(leaf) });
  }
  // config 随机动作分类（noMirror 分类照样可点播，播放端朝右时强制朝左见 isNoMirrorAnimation）
  const cats = (animations.categories ?? []).filter((c) => c.actions.length > 0);
  for (const c of cats) {
    groups.push({ label: c.id, children: c.actions.map(leaf) });
  }
  // 事件动画：每个事件为一个分类（不来自随机链，点播与代码触发同一池）。
  // 数组槽位（档内随机候选）展平为逐个叶子——所有候选都可右键点播预览。
  const events = animations.events ?? {};
  for (const key of Object.keys(events)) {
    const pool = events[key] ?? [];
    const names: string[] = [];
    for (const slot of pool) {
      if (typeof slot === 'string') names.push(slot);
      else names.push(...slot);
    }
    if (names.length) groups.push({ label: EVENT_LABELS[key] ?? key, children: names.map(leaf) });
  }
  if (!groups.length) return [];
  return [{ label: '动作', children: groups }];
}

/** 该动画是否属于 noMirror 分类（文字类）：朝右（镜像）时点播前强制朝左，避免文字镜像 */
export function isNoMirrorAnimation(categories: Category[], anim: string): boolean {
  return (categories ?? []).some((c) => c.noMirror === true && c.actions.includes(anim));
}

/**
 * 按条目级 menuItems 配置组装工具项 + 动作分支（纯函数，可单测）：
 * 数组顺序 = 菜单顺序，visible=false 跳过，label 用配置文字；未知 id 跳过（配置漂移防御）。
 * site 项按形态给动作：桌面 = open-site（打开网站）/ 浏览器 = settings（桌宠设置页）；
 * balance 项还要 pet 的 balanceEnabled 为真（该宠物没开余额就不给入口）；
 * animations 项 = buildMenuTree 的整棵动画树，label 覆盖其根标题（「动作」→ 自定义）；
 * mode 项 = 三档模式子菜单（叶子 action='set-mode'），opts.currentMode 给当前档打 ✓ 前缀
 * （渲染是纯文本 span，直接写进 label 即可；不传 currentMode 则不打勾）。
 */
export function buildToolItems(
  items: MenuItemConfig[] | undefined,
  opts: { windowed: boolean; balanceEnabled: boolean; animations: Animations; currentMode?: PetMode },
): MenuNode[] {
  const out: MenuNode[] = [];
  // 缺省/空数组 → 默认菜单（= 上线前的硬编码清单），配置缺失绝不等于「菜单消失」
  const list = Array.isArray(items) && items.length ? items : DEFAULT_MENU_ITEMS;
  for (const it of list) {
    if (!it || typeof it !== 'object' || it.visible !== true) continue;
    const label = typeof it.label === 'string' && it.label ? it.label : it.id;
    switch (it.id) {
      case 'site':
        out.push({ label, action: opts.windowed ? 'open-site' : 'settings' });
        break;
      case 'balance':
        if (opts.balanceEnabled) out.push({ label, action: 'show-balance' });
        break;
      case 'whisper':
      case 'chat':
      case 'home':
      case 'reload':
        out.push({ label, action: it.id });
        break;
      case 'mode':
        // 模式子菜单：三档固定叶子（label 来自 PET_MODE_LABELS，与设置页下拉同源）；
        // 当前档打 ✓ 前缀（仅当调用方传了 currentMode——桌面 sprite 每次开菜单都传）
        out.push({
          label,
          children: PET_MODES.map((m) => ({
            label: (opts.currentMode === m ? '✓ ' : '') + PET_MODE_LABELS[m],
            action: 'set-mode' as const,
            mode: m,
          })),
        });
        break;
      case 'animations': {
        const tree = buildMenuTree(opts.animations);
        if (tree.length) {
          tree[0].label = label;
          out.push(tree[0]);
        }
        break;
      }
      default:
        break; // 未知 id：忽略（旧配置含新字段/手改漂移时不让菜单崩）
    }
  }
  return out;
}

/** 菜单样式 —— 两端注入同一份（浏览器并入 plugin css；桌面入窗口 head）。
 *  每一级面板是独立的绝对定位盒子（.dsh-pet-menu-column），位置由 JS 内联写入；
 *  面板与面板之间互不嵌套，各自独立滚动。 */
export const MENU_CSS = [
  // 可配置项全走 CSS 变量（--dsh-menu-*，mountContextMenu 按 MenuStyleConfig 写到根容器），
  // 变量缺失时回落的字面量 = 上线前的硬编码值，未配置外观时像素级不变。
  '.dsh-pet-menu{position:fixed;left:0;top:0;z-index:2147483000;color:var(--dsh-menu-fg,#2b2b2b);',
  'font-size:var(--dsh-menu-fs,13px);line-height:1.5;',
  "font-family:'Microsoft YaHei UI','Segoe UI','PingFang SC',sans-serif;user-select:none;pointer-events:auto}",
  '.dsh-pet-menu,.dsh-pet-menu *{box-sizing:border-box}',
  '.dsh-pet-menu-column{position:absolute;min-width:150px;max-width:240px;padding:4px;',
  'background:var(--dsh-menu-bg,rgba(255,255,255,.98));border:1px solid rgba(0,0,0,.12);',
  'border-radius:var(--dsh-menu-radius,8px);',
  'box-shadow:0 8px 28px rgba(0,0,0,.2);max-height:min(62vh,460px);overflow-y:auto;',
  // 自定义滚动条：细圆角半透明条（Chromium 系 Chrome/Edge/Electron 走 ::-webkit-scrollbar；
  // Firefox 走 scrollbar-width/scrollbar-color）。thumb 用 border+background-clip 内缩 2px 留白，
  // 与菜单的圆角白底协调；hover 加深并与 item:hover 的蓝呼应。track 透明不抢视觉。
  'scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.22) transparent}',
  '.dsh-pet-menu-column::-webkit-scrollbar{width:8px;height:8px}',
  '.dsh-pet-menu-column::-webkit-scrollbar-track{background:transparent}',
  '.dsh-pet-menu-column::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:4px;',
  'border:2px solid transparent;background-clip:content-box}',
  '.dsh-pet-menu-column::-webkit-scrollbar-thumb:hover{background:rgba(43,99,255,.4);',
  'border:2px solid transparent;background-clip:content-box}',
  '.dsh-pet-menu-column::-webkit-scrollbar-corner{background:transparent}',
  '.dsh-pet-menu-item{position:relative;display:flex;align-items:center;justify-content:space-between;',
  'gap:14px;padding:5px 12px;border-radius:6px;white-space:nowrap;cursor:default}',
  // 悬停底色：第一行 = 不支持 color-mix 的老引擎兜底（固定蓝 14%，即原样式）；
  // 第二行按用户配置的 hoverBg 混 16% 浓度（原透明质感），支持则覆盖第一行
  '.dsh-pet-menu-item:hover{background:rgba(43,99,255,.14)}',
  '.dsh-pet-menu-item:hover{background:color-mix(in srgb,var(--dsh-menu-hover,#2b63ff) 16%,transparent)}',
  // 弹出动画（mountContextMenu 按 MenuStyleConfig.anim 打 data-anim）：
  // none=无动画（默认，保持原行为）/ fade=淡入 / scale=缩放淡入；每级面板各自播一遍
  '@keyframes dsh-menu-fade{from{opacity:0}to{opacity:1}}',
  '@keyframes dsh-menu-pop{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}',
  '.dsh-pet-menu[data-anim=fade] .dsh-pet-menu-column{animation:dsh-menu-fade .12s ease-out}',
  '.dsh-pet-menu[data-anim=scale] .dsh-pet-menu-column{animation:dsh-menu-pop .12s ease-out}',
  '.dsh-pet-menu-item>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis}',
  '.dsh-pet-menu-arrow{color:#9aa0a6;font-size:12px;flex:none}',
].join('');

/** mountContextMenu 返回值 */
export interface ContextMenuMount {
  /** 已挂载的根元素（document.body 下） */
  el: HTMLElement;
  /** 关闭并清理（幂等） */
  close: () => void;
}

function isBranchNode(n: MenuNode): n is MenuBranch {
  return 'children' in n && Array.isArray((n as MenuBranch).children);
}

/**
 * 挂载一个系统风格右键菜单（级联子菜单）到 document.body。
 * 位置为视口坐标（桌面=窗口视口，浏览器=页面视口）——两端一致。
 *
 * 结构：根容器（fixed，零尺寸）下平级挂**每一级独立面板**，绝无嵌套；
 * 面板按触发项屏幕位置贴边定位（右/下边缘自动翻转夹取）。
 * 级联：悬停分支切换/展开子面板；指针整体离开菜单树（root mouseleave）才关闭整棵菜单；
 * 点击项回调后自动关闭、点击菜单外或按 Esc 关闭；超高列表面板内独立滚动。
 *
 * clamp（可选，#41）：菜单允许占用的矩形（视口局部坐标，默认整个视口）。
 * 桌面模式传「窗口 ∩ 工作区」：宠物贴屏幕底/右时窗口外扩余量伸出屏幕，菜单走进
 * 伸出的部分会被 OS 裁掉——约束到该矩形内即可完整显示，**窗口/宠物零移动零闪帧**。
 */
export function mountContextMenu(opts: {
  tree: MenuNode[];
  x: number;
  y: number;
  onAction: (leaf: MenuLeaf) => void;
  /** 菜单被关闭（点项/点外/Esc）后的通知：挂载方据此复位自身状态（如桌面可交互标记） */
  onClose?: () => void;
  /** 菜单允许占用的矩形（视口局部坐标）；缺省 = 整个视口（浏览器既有行为） */
  clamp?: { x: number; y: number; w: number; h: number };
  /** 外观（条目级 menuStyle）：缺省 = MENU_CSS 的字面量默认（原样视觉） */
  style?: MenuStyleConfig;
}): ContextMenuMount {
  const { tree, x, y, onAction, onClose, clamp, style } = opts;
  // 夹取基准：缺省整个视口；桌面传入「窗口 ∩ 工作区」后各级面板都只在这个矩形内落位/翻转。
  // 防御：clamp 含非有限值（如坐标来源缺失变成 NaN）时回落整个视口——否则面板会落到 (0,0)
  const c =
    clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h)
      ? clamp
      : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  const root = document.createElement('div');
  root.className = 'dsh-pet-menu';
  root.style.left = '0px';
  root.style.top = '0px';
  root.addEventListener('contextmenu', (e) => e.preventDefault());
  // 外观注入：CSS 变量写到根容器（MENU_CSS 各规则用 var(…, 原字面量) 回落）；
  // data-anim 驱动弹出动画三态（none 不写属性 = 无动画，与未配置一致）。
  // 数值/颜色来自 saveUserConfig 校验过的配置；这里仍做一次类型守卫（缺字段回落默认）。
  if (style) {
    const s = { ...DEFAULT_MENU_STYLE, ...style };
    if (Number.isFinite(s.fontSize)) root.style.setProperty('--dsh-menu-fs', s.fontSize + 'px');
    if (Number.isFinite(s.radius)) root.style.setProperty('--dsh-menu-radius', s.radius + 'px');
    if (typeof s.bg === 'string' && s.bg) root.style.setProperty('--dsh-menu-bg', s.bg);
    if (typeof s.fg === 'string' && s.fg) root.style.setProperty('--dsh-menu-fg', s.fg);
    if (typeof s.hoverBg === 'string' && s.hoverBg) root.style.setProperty('--dsh-menu-hover', s.hoverBg);
    if (s.anim === 'fade' || s.anim === 'scale') root.dataset.anim = s.anim;
  }

  let closed = false;

  /** 每个面板当前展开的子面板（无 = 未展开）；hideChain 会沿链清除 */
  const openChild = new Map<HTMLElement, HTMLElement>();
  /** 指针整体离开菜单树的兜底关闭定时器（root mouseover 重新进入即取消） */
  let leaveTimer: number | null = null;

  /** 关闭某面板及其后代面板整条链（display:none + 清 openChild 链） */
  const hideChain = (panel: HTMLElement): void => {
    panel.style.display = 'none';
    const child = openChild.get(panel);
    if (child) {
      openChild.delete(panel);
      hideChain(child);
    }
  };

  /** 把面板显示在触发项旁边：右缘展开，贴右/下边缘自动翻转夹取（在 clamp 矩形内） */
  const showPanel = (panel: HTMLElement, item: HTMLElement): void => {
    const rect = item.getBoundingClientRect();
    panel.style.left = '';
    panel.style.top = '';
    panel.style.display = 'block';
    let left = rect.right + 4;
    if (left + panel.offsetWidth > c.x + c.w - 4) left = rect.left - panel.offsetWidth - 4;
    left = Math.max(c.x + 4, left);
    let top = rect.top;
    if (top + panel.offsetHeight > c.y + c.h - 4) top = Math.max(c.y + 4, c.y + c.h - 4 - panel.offsetHeight);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  };

  /** 构建一层面板（nodes 列表）；分支项的子面板**平级**挂到 root 下，不嵌套。
   *  面板自身先入 DOM、子面板随后入 → 层级越深绘制越靠上（子菜单盖在父菜单上层）。 */
  const buildPanel = (nodes: MenuNode[]): HTMLElement => {
    const panel = document.createElement('div');
    panel.className = 'dsh-pet-menu-column';
    panel.style.display = 'none';
    // 桌面 clamp：把列高封顶到可视矩形内（否则 62vh 相对的是窗口高度，可视区更小时仍会溢出被裁）
    if (clamp) panel.style.maxHeight = Math.min(460, Math.max(120, c.h - 16)) + 'px';
    root.appendChild(panel);
    for (const node of nodes) {
      const item = document.createElement('div');
      item.className = 'dsh-pet-menu-item';
      if (isBranchNode(node)) {
        item.classList.add('dsh-pet-menu-branch');
        const label = document.createElement('span');
        label.textContent = node.label;
        const arrow = document.createElement('span');
        arrow.className = 'dsh-pet-menu-arrow';
        arrow.textContent = '▸';
        item.appendChild(label);
        item.appendChild(arrow);
        const childPanel = buildPanel(node.children); // 递归：子面板已入树（晚于本面板）
        // 悬停分支：收掉本面板其它分支已展开的子面板链，再展开当前分支的儿子面板。
        // （指针在本菜单树内移动绝不自动收起——跨 4px 缝隙/面板间隙都不会触发关闭）
        item.addEventListener('mouseenter', () => {
          const prev = openChild.get(panel);
          if (prev && prev !== childPanel) hideChain(prev);
          openChild.set(panel, childPanel);
          showPanel(childPanel, item);
        });
      } else {
        const label = document.createElement('span');
        label.textContent = node.label;
        item.appendChild(label);
        item.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          close();
          onAction(node);
        });
      }
      panel.appendChild(item);
    }
    return panel;
  };

  const rootPanel = buildPanel(tree);
  rootPanel.style.display = 'block';

  // 关键：把菜单根容器真正挂进文档（v1→v2 重写时漏掉的挂载——不 append 则一切"静默无显示"）
  document.body.appendChild(root);

  // 根面板定位：按 (x,y) 下落，超出 clamp 矩形时夹回（与子面板同一套逻辑但无触发项）
  rootPanel.style.left = '';
  rootPanel.style.top = '';
  const rw = rootPanel.offsetWidth;
  const rh = rootPanel.offsetHeight;
  rootPanel.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - rw - 4)) + 'px';
  rootPanel.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - rh - 4)) + 'px';

  // 指针整体离开菜单树（离开全部面板的并集）→ 200ms 后关闭整棵菜单；
  // 期间任何指针移动（mouseover 冒泡到 root）都视为仍在菜单内，取消关闭
  root.addEventListener('mouseleave', () => {
    if (leaveTimer !== null) window.clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(() => {
      leaveTimer = null;
      close();
    }, 200);
  });
  root.addEventListener('mouseover', () => {
    if (leaveTimer !== null) {
      window.clearTimeout(leaveTimer);
      leaveTimer = null;
    }
  });

  const onDocPointerDown = (e: MouseEvent): void => {
    if (closed) return;
    if (root.contains(e.target as Node)) return;
    close();
  };
  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (closed) return;
    if (e.key === 'Escape') close();
  };
  document.addEventListener('mousedown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (leaveTimer !== null) window.clearTimeout(leaveTimer);
    leaveTimer = null;
    document.removeEventListener('mousedown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    root.remove();
    if (onClose) onClose();
  };

  return { el: root, close };
}
