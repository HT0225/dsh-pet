'use strict';
/**
 * dsh-pet 桌宠桌面壳（Windows）—— 全屏透明置顶窗加载服务器桌宠页。
 *
 * 设计要点：
 *  - **全屏 + 透明 + 置顶**：主屏铺满（逻辑像素，DPI 自动换算）；桌宠页 body 本就是
 *    background:transparent，宠物直接浮在桌面上，活动范围 = 整块屏幕（页面视口 = 屏幕）。
 *  - **鼠标默认穿透**：setIgnoreMouseEvents(true, { forward: true }) —— 平时点桌面/其它
 *    窗口完全不受影响；forward 让 mousemove 仍转发给页面，页面侧的命中判定
 *    （sprite.setInteractive：光标在宠物身上 / 菜单或对话框打开 = true）照常工作，
 *    经 preload 的 petShell.setInteractive 上报 → 这里翻转穿透，光标离开再翻回。
 *  - **不注入 petBridge**：渲染继续走浏览器分支（IS_WINDOWED=false，DOM 定位），
 *    窗口本身永不移动 —— 与浏览器页形态共用同一套代码、同一份配置（服务器侧唯一来源）。
 *  - **托盘常驻**：显隐 / 刷新 / 打开设置页 / 退出；快捷键 Ctrl+Alt+H 显隐、Ctrl+Alt+Q 退出。
 *  - **window.open 交给系统浏览器**：页面右键「桌宠设置」在系统浏览器里打开设置页，
 *    壳内不开第二个窗。
 */
const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, globalShortcut, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');

// 配置（桌宠页地址，含 ?token=…）存 **exe 同级目录** 的 config.json：绿色版友好，
// 删掉它再启动即重新进入首次设置。开发模式（npx electron .）存脚本目录。
const BASE_DIR = app.isPackaged ? path.dirname(process.execPath) : __dirname;
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const ICON_PATH = path.join(__dirname, 'icon.png');

/** 读 config.json：{ url: 桌宠页地址, interactEnabled: 互动是否开启(记住上次) } */
function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      url: typeof cfg.url === 'string' ? cfg.url.trim() : '',
      interactEnabled: cfg.interactEnabled !== false, // 缺省 = 开（原行为）
    };
  } catch {
    return { url: '', interactEnabled: true };
  }
}

function readUrl() {
  const fromEnv = (process.env.DSH_PET_URL || '').trim();
  if (fromEnv) return fromEnv;
  return readConfig().url;
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/**
 * 壳日志：exe 同目录的 shell.log（append；无写权限时回退 userData）。
 * 排障刚需：启动/页面加载失败/退出都会留痕，用户双击没反应时直接看这个文件。
 */
const LOG_PATH = (() => {
  const primary = path.join(BASE_DIR, 'shell.log');
  try {
    fs.appendFileSync(primary, ''); // 探测可写
    return primary;
  } catch {
    return path.join(app.getPath('userData'), 'shell.log');
  }
})();
function log(msg) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toLocaleString()}] ${msg}\n`, 'utf8');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

let petWin = null;
let tray = null;
let petVisible = true;
// 互动开关：false = 宠物对鼠标完全隐身（点击/右键全部穿透到下层，光标划过也不接管、不弹悬浮提示），
// 动画与漫游照常自动播放。状态记住（config.json），托盘切换。
let interactEnabled = readConfig().interactEnabled;

/** 建全屏透明置顶主窗并加载桌宠页 */
function createPetWindow(url) {
  // 只铺**工作区**（display.workArea = 屏幕去掉任务栏的那块，多屏第一版只做主屏）。
  // 不用完整 bounds 的原因：Windows 任务栏自身是置顶窗口，与本壳的置顶互相抢 z 序（经常是任务栏赢），
  // 用完整屏幕矩形时底部会被任务栏压住；铺工作区后窗口与任务栏**不重叠**，遮挡从根上消失，
  // 页面视口 = 工作区 → 宠物活动范围也自动避开任务栏（不会走到那一条底下去）。
  // **字段名坑（0.2.2 修复的线上事故）**：Electron 的 Display 没有 workAreaBounds（那是 Win32
  // MONITORINFO 的名字），只有 workArea（Rectangle）——写错则整行为 undefined，解构直接抛
  // TypeError，窗口从未创建而进程活着（whenReady 链异常无处可去）→ 表现为"双击没反应、
  // 进程在跑"。启动链因此另加了 .catch（见下方 whenReady）。
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  log(`主窗几何 ${width}x${height} @(${x},${y})（workArea，不含任务栏）`);
  petWin = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true, // 背景透明 → 宠物浮在真实桌面上
    frame: false,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false, // 不用 fullscreen API：Windows 上 transparent+fullscreen 有黑底坑，
    // 用「精确铺满屏幕矩形的无框窗」等效达成
    alwaysOnTop: true,
    skipTaskbar: true, // 不占任务栏（显隐靠托盘）
    hasShadow: false,
    show: false, // 页面就绪前先藏着，避免首帧闪烁
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 后台节流关掉：全屏透明窗被遮挡时动画照跑
    },
  });
  petWin.setAlwaysOnTop(true, 'screen-saver'); // 盖过普通窗口与普通置顶窗
  log('主窗创建完成（transparent/topmost/ignore-mouse 已设置）');
  petWin.setIgnoreMouseEvents(true, { forward: true }); // 默认穿透；forward 保留 mousemove 给页面

  // 页面 window.open（右键「桌宠设置」等）→ 系统浏览器打开，壳内不开新窗
  petWin.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  petWin.webContents.on('did-finish-load', () => {
    log('页面加载完成: ' + url);
    petVisible = true;
    if (petWin && !petWin.isVisible()) petWin.showInactive(); // showInactive：不抢当前应用焦点
    // 页面每次加载/刷新后推一次互动开关的当前值（页面据此决定是否响应鼠标）
    petWin.webContents.send('pet-shell:interact-changed', interactEnabled);
    syncTray();
  });
  // 加载失败（服务器未开/断网）：退避重试 3 次，仍失败只记日志（托盘里可手动刷新）
  let retries = 0;
  petWin.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    if (errorCode === -3) return; // ERR_ABORTED（页面内部跳转）忽略
    if (retries < 3) {
      retries += 1;
      setTimeout(() => {
        if (petWin && !petWin.isDestroyed()) void petWin.loadURL(url);
      }, 2000 * retries);
    } else {
      console.error('[dsh-pet-shell] 页面加载失败:', errorCode, errorDescription, url);
      log('页面加载失败(重试耗尽): ' + errorCode + ' ' + errorDescription + ' url=' + url);
    }
  });
  void petWin.loadURL(url);

  // 光标轮询（跟随鼠标模式的兜底源，60ms ≈ 16Hz）：setIgnoreMouseEvents(true) 期间页面靠
  // forward 转发的 mousemove 拿光标，但光标落到任务栏条 / 更高层置顶窗上时钩子收不到——
  // 这里按**真实光标**（screen.getCursorScreenPoint）独立推送给页面，断流也不断跟。
  // 单位：getBounds 与 getCursorScreenPoint 同为 DIP（壳不强制 device scale，未线性化），
  // 相减即窗口局部 DIP = 本页 CSS px（壳无 zoomFactor，页面原点 = 窗口原点）。
  const cursorTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed()) return;
    const b = petWin.getBounds();
    if (b.width < 8 || b.height < 8) return; // 窗口尺寸还没落定
    const p = screen.getCursorScreenPoint();
    petWin.webContents.send('pet-shell:cursor', { x: p.x - b.x, y: p.y - b.y });
  }, 60);
  petWin.on('closed', () => clearInterval(cursorTimer));
}

// 页面上报：true = 光标在宠物/菜单/弹窗上 → 壳接管鼠标；false = 恢复穿透。
// 互动暂停（interactEnabled=false）时**忽略一切接管请求**：点击/右键永远穿透到下层。
ipcMain.on('pet-shell:interactive', (_e, on) => {
  if (!interactEnabled) return;
  if (petWin && !petWin.isDestroyed()) petWin.setIgnoreMouseEvents(!on, { forward: true });
});

/** 切换互动开关：关 → 立刻交还鼠标；两种状态都同步托盘菜单与页面（页面据此关 tip、永不上报接管） */
function toggleInteract() {
  interactEnabled = !interactEnabled;
  writeConfig({ interactEnabled });
  if (petWin && !petWin.isDestroyed()) {
    if (!interactEnabled) petWin.setIgnoreMouseEvents(true, { forward: true }); // 正接管中也立即穿透
    petWin.webContents.send('pet-shell:interact-changed', interactEnabled);
  }
  createTray(); // 重建菜单（勾选态/文案跟着变）
}

// 首次设置：保存桌宠页地址（可重复调用）
ipcMain.handle('pet-shell:save-url', (_e, raw) => {
  const url = String(raw || '').trim();
  if (!/^https?:\/\//.test(url)) return { ok: false, error: '地址必须以 http(s):// 开头' };
  writeConfig({ url });
  if (!petWin || petWin.isDestroyed()) {
    createPetWindow(url);
    createTray();
    registerShortcuts();
  }
  return { ok: true };
});

function toggleVisible() {
  if (!petWin || petWin.isDestroyed()) return;
  if (petWin.isVisible()) {
    petWin.hide();
    petVisible = false;
  } else {
    petWin.showInactive();
    petVisible = true;
  }
  syncTray();
}

function refreshPet() {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.reloadIgnoringCache();
}

/** 设置页地址 = 桌宠页同目录的 settings.html（同源同令牌） */
function openSettingsPage() {
  const url = readUrl();
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/[^/]*$/, '/settings.html');
    void shell.openExternal(u.toString());
  } catch {
    void shell.openExternal(url);
  }
}

function syncTray() {
  if (tray) tray.setToolTip('dsh-pet 桌宠（' + (petVisible ? '显示中' : '已隐藏') + '）');
}

/** 建托盘（幂等：只换菜单不重建对象——toggleInteract 等会反复调用） */
function createTray() {
  if (!tray) {
    tray = new Tray(ICON_PATH); // Windows 10+ 原生支持 png 图标
    tray.on('click', toggleVisible); // 单击托盘图标 = 显示/隐藏
  }
  tray.setToolTip('dsh-pet 桌宠');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: petVisible ? '隐藏宠物' : '显示宠物', click: toggleVisible },
      {
        label: interactEnabled ? '互动：开启（可点击宠物）' : '互动：已暂停（点击穿透给桌面）',
        type: 'checkbox',
        checked: interactEnabled,
        click: toggleInteract,
      },
      { label: '刷新页面', click: refreshPet },
      { type: 'separator' },
      { label: '打开设置页（浏览器）', click: openSettingsPage },
      { label: '在浏览器打开桌宠页', click: () => void shell.openExternal(readUrl()) },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]),
  );
  syncTray();
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Alt+H', toggleVisible);
  globalShortcut.register('CommandOrControl+Alt+Q', () => app.quit());
}

/** 首次运行（没有 config.json）：小窗输入桌宠页地址（含 ?token=…） */
function createSetupWindow() {
  const win = new BrowserWindow({
    width: 560,
    height: 260,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'dsh-pet 桌宠壳 · 首次设置',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  void win.loadFile(path.join(__dirname, 'setup.html'));
}

// 单实例：重复启动 = 唤起已有的壳，不叠第二个全屏窗
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 没拿到单实例锁：**别再静默退出**（用户双击没任何反应会完全懵）——弹原生框说明现状与处理办法。
  // 触发场景：另一个实例真在跑；或上次是异常关闭、锁未释放（Windows 上偶发），此时按框里指引处理即可。
  log('单实例锁被占用（已有实例在跑，或上次异常关闭未释放锁）');
  dialog.showErrorBox(
    'dsh-pet 桌宠已经在运行',
    '可能的情况与处理：\n\n' +
      '1) 宠物其实已经在你桌面上 —— 看看右下角托盘区（含隐藏图标 ^）的马头图标，' +
      '单击它即可显示/隐藏宠物。\n\n' +
      '2) 托盘没有图标 —— 说明上一次退出没退干净、锁还占着：' +
      '按 Ctrl+Shift+Esc 打开任务管理器，结束所有 dsh-pet-shell.exe 进程，再重新双击启动。\n\n' +
      '（排查记录见 exe 同目录的 shell.log）',
  );
  app.quit();
} else {
  app.on('second-instance', () => {
    if (petWin && !petWin.isDestroyed()) {
      if (!petWin.isVisible()) toggleVisible();
      else petWin.showInactive();
    }
  });

  app.whenReady()
    .then(() => {
      log('壳启动 v' + app.getVersion() + ' config=' + CONFIG_PATH);
      const url = readUrl();
      if (url) {
        log('加载桌宠页: ' + url);
        createPetWindow(url);
        createTray();
        registerShortcuts();
      } else {
        createSetupWindow();
      }
    })
    .catch((err) => {
      // 启动链任何异常：留日志 + 弹框 + 退出。**绝不允许"进程活着但没有窗口"**——
      // 0.2.x 踩过：createPetWindow 里字段名写错抛 TypeError，进程挂着占单实例锁，
      // 用户表现为双击无反应且之后再也起不来。
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      log('启动失败: ' + msg);
      dialog.showErrorBox('dsh-pet 桌宠壳启动失败', msg + '\n\n（详情见 exe 同目录的 shell.log）');
      app.quit();
    });
}

// 托盘常驻：关窗不退出（本壳只有托盘与退出路径）
app.on('window-all-closed', () => {});
app.on('will-quit', () => {
  log('退出');
  globalShortcut.unregisterAll();
  if (tray) tray.destroy();
});
// 退出兜底：quit 流程若被拖住（渲染进程卡住等），3 秒后强制结束进程 —— 防止"看着关了、
// 进程还在"导致单实例锁不释放，下次双击静默失败（0.2.0 用户实际踩过）。
let forceQuitTimer = null;
app.on('before-quit', () => {
  if (forceQuitTimer) return;
  forceQuitTimer = setTimeout(() => {
    log('quit 流程超时，强制退出');
    app.exit(0);
  }, 3000);
});
