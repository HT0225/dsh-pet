// 与 config.jsonc 结构完全同构的类型模型（唯一事实来源 = config.jsonc 的
// animations / animationWeights / pets）。运行时（浏览器 PetCard / 桌面 sprite /
// 设置页）直接使用这套结构，不额外造转换后的类型。
//
// 本目录（src/shared）是浏览器 bundle 与桌面 shared-core（构建产物）共用的
// 纯逻辑层：无 React / DOM 依赖，两边各有一层薄壳做渲染与输入绑定。

/** 支持的角落 */
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** 轴对齐矩形（左上角 + 宽高）。显示器工作区、窗口内容区、可视夹取区共用同一形状。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 宠物的显示位置（四个值，必填）：
 * - web     = 只显示在浏览器 overlay
 * - desktop = 只显示在桌面模式（Electron 透明窗）
 * - both    = 两者都显示
 * - none    = 都不显示（保留配置但不参与显示）
 */
export type PetDisplay = 'web' | 'desktop' | 'both' | 'none';

/** 移动动作：一个动作名 + 可选覆盖参数（未写字段取 moves.default） */
export interface MoveSpec {
  name: string;
  params?: Record<string, number>;
}

/** 移动池 */
export interface MovesConfig {
  default: Record<string, number>;
  actions: MoveSpec[];
}

/** 随机动作分类（带文字、镜像会颠倒，facing=right 时跳过） */
export interface Category {
  id: string;
  weight: number;
  noMirror?: boolean;
  actions: string[];
}

/** 事件档位槽位：单个动画名（固定播放，原行为）或候选数组（触发时档内随机抽 1，尽量不连续重复） */
export type EventSlot = string | string[];

/** 事件动画：事件名 → 档位槽位数组（数组顺序 = 档位顺序；不进随机链，只由代码显式触发） */
export type Events = Record<string, EventSlot[]>;

/** 动画权重 */
export interface Weights {
  idle: number;
  turn: number;
  move: number;
}

/** config.jsonc 的 animations 段 */
export interface Animations {
  idle: string[];
  turn: string[];
  drag: string[];
  clicks: string[];
  moves: MovesConfig;
  categories: Category[];
  events: Events;
}

/** 一只宠物（与 jsonc pets[i] 同形，position 嵌套）。
 *  可选段（animations / animationWeights / extra / assetRoot / eventsRefreshSec / physics / confineToScreen /
 *  workStatusTexts / whisperModel / chatModel）为渲染期派生或「文件定义宠物」专用：
 *  - animations / animationWeights / eventsRefreshSec / physics / confineToScreen / whisperModel / chatModel：所属条目的条目级字段，由配置合并
 *    （host readAllConfig / 客户端 flattenConfigPets）在拍平时吹进每只实例——多实例共享。
 *    其中 physics / confineToScreen / whisperImageEnabled / chatImageEnabled / chatImageLimit /
 *    chatMemoryRounds / whisperModel / chatModel / eventsRefreshSec 是**全局默认**：文件宠物条目的合并基座取**用户层**
 *    （main-config.jsonc），即"设置页改一次，所有宠物（含 pet pack）都生效"；种类文件仍可在自己
 *    顶层覆盖（见 host/config.ts 的 GLOBAL_DEFAULT_KEYS）。其余条目级字段（animations /
 *    whisperPrompt / memes / workStatusTexts …）的基座是**内置默认**，与用户层无关；
 *  - extra: true 标记该宠物由 pet/ 目录文件定义：设置页不可编辑、保存时排除，
 *    由拍平逻辑统一打标，**永不出现在持久化配置里**；
 *  - assetRoot: 素材目录名（= 配置文件前缀 `<名>`，即 `pet/<名>-animation/`）；素材 URL
 *    用它而不是 id——多实例共享同一素材目录。main 等常规宠物并入 main 条目（assetRoot=main）。
 */
export interface Pet {
  /** 唯一标识（程序定位用：素材/记忆/端点参数都按它；绝不重叠，冲突即配置错误） */
  id: string;
  /** 显示名（可重复）：悬浮提示、AI 人设（无条件追加「你的名字是 X」）、未来命令行定位的显示层。
   *  与 id 的区别：id 唯一、程序认它；name 给人看、可重复。缺失/留空按该宠物 id 处理并告警 */
  name: string;
  size: number;
  /** 是否启用余额功能：true=触发余额动画+显示余额气泡；false=该宠物完全禁用余额。缺失即配置错误 */
  balanceEnabled: boolean;
  /** 是否启用碎碎念：true=按 eventsRefreshSec.whisper 周期生成一句话并播碎碎念动画；false=禁用。
   *  缺失默认 true（内置默认开启：碎碎念每次生成会调用当前对话的模型，本地 LLM 单并发时
   *  会顶掉正在跑的任务的 KV cache，见 config.jsonc 注释——不需要的宠物请显式写 false） */
  whisperEnabled: boolean;
  /** 是否启用工作状态联动：true=监听 DSH 会话事件（tool/call 等），按 animations.events.workStatus
   *  数组切档位动画 + 气泡；false=禁用。缺失默认 true（内置默认开启）。监听不调用模型，无 KV cache 风险 */
  workStatusEnabled: boolean;
  /** 宠物固定：true = 随机动画链不再抽「转向(turn) / 移动(move)」两档——宠物不自己翻朝向、
   *  也不自己走开，只播原地待机与随机小动作（这两档权重按 0 算，份额自然并入随机小动作）。
   *  **只影响随机链**：右键菜单点播（含「转向 / 移动」两项）、/anim 接口与命令、事件动画
   *  （余额/碎碎念/工作状态）、点击回应与拖拽一律照常——用户主动触发的不受此限制。
   *  缺失默认 false（保持原行为：会自己走、会自己翻） */
  fixedEnabled: boolean;
  /** 行为模式（三选一，取代设置页原「宠物固定」开关；缺失按 fixedEnabled 回落）：
   *  wander=自由散步（随机链照常掷骰，会自己走动/转向）· follow=跟随鼠标（朝光标水平走动，
   *  只左右跟、不上下飞）· idle=原地待机（等价旧 fixedEnabled：位置永不变，只播原地动画）。
   *  **只约束随机链**：右键点播、点击回应、拖拽抛掷、事件动画一律不受影响（与 fixedEnabled 同语义）。
   *  缺失时消费端回落：fixedEnabled===true → idle，否则 wander（老配置行为逐位不变） */
  mode?: PetMode;
  /** 右键菜单项（条目级，host 合并已填默认）：顺序/文字/显隐见 MenuItemConfig */
  menuItems: MenuItemConfig[];
  /** 菜单外观（条目级，host 合并已填默认）：动画/字号/圆角/配色见 MenuStyleConfig */
  menuStyle: MenuStyleConfig;
  /** 显示位置（web/desktop/both/none，必填）：缺失即配置错误，代码不做兜底 */
  display: PetDisplay;
  position: { corner: Corner; marginX: number; marginY: number };
  animations?: Animations;
  animationWeights?: Weights;
  extra?: boolean;
  assetRoot?: string;
  /** 全局默认：事件刷新周期（秒，事件名 → 间隔；整段替换，缺的键由消费端各自兜底）。
   *  `.whisper` 按所属条目读（种类可覆盖）；`.balance` 的消费端只读 main 条目。 */
  eventsRefreshSec?: Record<string, number>;
  /** 全局默认：拖拽抛掷物理参数（用户在 main-config.jsonc 里写一次即对所有宠物生效，
   *  含 pet pack；种类文件顶层写了则用自己那份。host 合并已填默认，拍平时吹入） */
  physics?: PhysicsParams;
  /** 全局默认：拖拽抛掷是否锁定在当前屏幕（归属规则同 physics） */
  confineToScreen?: boolean;
  /** 条目级：工作状态气泡文案（二维数组，外层索引 = workStatus 档位 0..5，内层每档可多句随机抽；
   *  host 合并已填默认，拍平时吹入；整字段缺失 = 不弹工作状态文本，只播动画） */
  workStatusTexts?: string[][];
  /** 全局默认：碎碎念单独指定的服务商 + 模型（host 合并已填默认，拍平时吹入；
   *  provider 与 model 都为空 = 跟随当前对话的模型） */
  whisperModel?: ModelSelection;
  /** 全局默认：对话单独指定的服务商 + 模型（同上，都为空 = 跟随当前对话的模型） */
  chatModel?: ModelSelection;
}

/** 一处「服务商 + 模型」选择（config.jsonc 的 whisperModel / chatModel 段）。
 *  provider 与 model **要么都为空（= 跟随当前对话的模型）要么都非空**——只填一半是配置错误。 */
export interface ModelSelection {
  /** 服务商路由 id（与 DSH 模型选择器同一命名空间） */
  provider: string;
  /** 该服务商下的模型 id */
  model: string;
}

/** 菜单项（条目级）：右键菜单的工具项与「动作」分支 —— 数组顺序 = 菜单渲染顺序 */
export interface MenuItemConfig {
  /** 固定 id（不可改）：site=设置/打开网站 · balance=余额 · whisper=碎碎念 · chat=对话 ·
   *  mode=模式（自由散步/跟随鼠标/原地待机 子菜单，label 即分支标题）· home=回初始位置 ·
   *  reload=重载配置 · animations=动作（动画树分支，label 即分支标题） */
  id: string;
  /** 显示文字（自定义，1~40 字符） */
  label: string;
  /** 是否在菜单里显示 */
  visible: boolean;
}

/** 菜单外观（条目级）：弹出动画 / 字号 / 圆角 / 三色（经 CSS 变量注入菜单组件） */
export interface MenuStyleConfig {
  /** 弹出动画：none=无（默认，保持原行为）/ fade=淡入 / scale=缩放淡入 */
  anim: 'none' | 'fade' | 'scale';
  /** 字号 px（10~24） */
  fontSize: number;
  /** 面板圆角 px（0~24） */
  radius: number;
  /** 面板背景色（#rgb / #rrggbb） */
  bg: string;
  /** 文字色（#rgb / #rrggbb） */
  fg: string;
  /** 悬停底色（#rgb / #rrggbb，渲染时按 16% 浓度混透明，保持原半透明质感） */
  hoverBg: string;
}

/** 行为模式（pets[].mode）：自由散步 / 跟随鼠标 / 原地待机（取代原「宠物固定」开关） */
export type PetMode = 'wander' | 'follow' | 'idle';

/** 全部合法模式值（host 校验与组装共用；顺序 = 菜单子项/设置页下拉的展示顺序） */
export const PET_MODES = ['wander', 'follow', 'idle'] as const;

/** 模式 → 展示名（右键菜单叶子与设置页下拉共用；改动需同步 settings.js 的内嵌副本） */
export const PET_MODE_LABELS: Record<PetMode, string> = {
  wander: '自由散步',
  follow: '跟随鼠标',
  idle: '原地待机',
};

/** 菜单项固定 id 集合（校验与组装共用，顺序 = 未配置时的默认菜单顺序） */
export const MENU_ITEM_IDS = ['site', 'balance', 'whisper', 'chat', 'mode', 'home', 'reload', 'animations'] as const;

/** 未配置时的默认菜单项（= 上线前的硬编码菜单，行为零变化） */
export const DEFAULT_MENU_ITEMS: MenuItemConfig[] = [
  { id: 'site', label: '桌宠设置', visible: true },
  { id: 'balance', label: '查看余额', visible: true },
  { id: 'whisper', label: '碎碎念', visible: true },
  { id: 'chat', label: '对话', visible: true },
  { id: 'mode', label: '模式', visible: true },
  { id: 'home', label: '回到初始位置', visible: true },
  { id: 'reload', label: '重载配置', visible: true },
  { id: 'animations', label: '动作', visible: true },
];

/** 未配置时的默认菜单外观（逐字段对应 MENU_CSS 的既有硬编码值） */
export const DEFAULT_MENU_STYLE: MenuStyleConfig = {
  anim: 'none',
  fontSize: 13,
  radius: 8,
  bg: '#ffffff',
  fg: '#2b2b2b',
  hoverBg: '#2b63ff',
};

/** config.jsonc 的 physics 段：拖拽抛掷手感参数（全局，所有宠物共用）。
 *  默认值 = src/shared/physics.ts 的常量（1400 / 0.78 / 2.5 / true / 1.0 / false），内置配置与代码两侧保持一致。 */
export interface PhysicsParams {
  /** 重力加速度（px/s²）：抛掷下落/反弹的基础重力，越大落得越快；0 = 无重力（合法，永不下落/均匀直线飞行） */
  gravity: number;
  /** 碰壁反弹恢复系数 0~1（1 = 完全弹性，0 = 撞上即停；墙/地共用） */
  restitution: number;
  /** 地面水平摩擦（/s）：落地时水平速度的衰减率，0 = 无摩擦 */
  groundFriction: number;
  /** 顶部是否反弹：true = 碰顶反弹；false = 顶部无边界，抛掷可飞出屏幕顶部（重力仍会拉回落） */
  ceilingBounce: boolean;
  /** 总力度（拖拽/抛掷输出增益）：弹簧跟手 K/C、甩抛初速与软上限整体 ×p（1.0 = 现状；必须 > 0） */
  throwPower: number;
  /** 多宠物互相碰撞开关：true = 飞行中被甩出的宠物撞到其它宠物时按动量守恒弹开；false = 关闭（默认，互相穿过） */
  petCollision: boolean;
}

/** config.jsonc 全集——运行时直接使用（ANIM 即本类型） */
export interface ClientConfig {
  /** 系统通知总开关：true=对话完成/生成失败/输出截断/权限申请/用户选择时弹出系统通知；缺失即配置错误 */
  notificationsEnabled: boolean;
  /** 碎碎念配图开关：true=碎碎念每次从表情包池随机抽 1 张连同文本显示（碎碎念无上下文，故随机） */
  whisperImageEnabled: boolean;
  /** 对话配图开关：true=对话时把表情包清单交模型按语境选 1 张（可不选）；false=纯文本 */
  chatImageEnabled: boolean;
  /** 拖拽抛掷是否锁定在当前屏幕：true=甩出去只在松手时所在那块屏内弹（屏缝当墙）；
   *  false=跨屏飞行（现状）。根字段（不属于 physics：它不改手感，只改「被允许去哪」），
   *  条目级，缺失即配置错误 */
  confineToScreen: boolean;
  pets: Pet[];
  animations: Animations;
  animationWeights: Weights;
  /** 拖拽抛掷物理参数（全局，所有宠物共用；host 合并已填默认） */
  physics: PhysicsParams;
  /** 碎碎念用的服务商 + 模型（条目级，host 合并已填默认；两者都为空 = 跟随当前对话的模型） */
  whisperModel: ModelSelection;
  /** 对话用的服务商 + 模型（条目级，host 合并已填默认；两者都为空 = 跟随当前对话的模型） */
  chatModel: ModelSelection;
  /** 事件刷新周期（秒）：事件名 → 间隔；balance = 余额数据刷新 + 动画触发间隔 */
  eventsRefreshSec: Record<string, number>;
}
