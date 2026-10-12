'use strict';
/**
 * 壳与页面的唯一通道（contextIsolation 下的 contextBridge）：
 *  - petShell.setInteractive(bool)：桌宠页 sprite 的可交互状态上报 → 主窗翻转鼠标穿透；
 *  - petShell.saveUrl(url)：首次设置页保存桌宠页地址（invoke，返回 {ok, error?}）。
 * **不注入 petBridge**：页面保持浏览器形态（IS_WINDOWED=false，DOM 定位），
 * 全屏窗只是「更大的页面视口」。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petShell', {
  setInteractive: (on) => ipcRenderer.send('pet-shell:interactive', !!on),
  saveUrl: (url) => ipcRenderer.invoke('pet-shell:save-url', url),
});
