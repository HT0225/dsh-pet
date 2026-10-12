/**
 * buildToolItems —— 右键菜单的配置驱动组装（纯函数）。
 *
 * 为什么单独测：这是「设置页改菜单 → 菜单立刻变样」的唯一翻译层，
 * 顺序/显隐/label/形态分发/balance 门槛/动画树根标题/缺省回落全部压在这一个函数上；
 * sprite.js 是手写 JS 不进测试 glob，这里红了设置页再对也没用。
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { buildToolItems } from './menu.ts';
import { DEFAULT_MENU_ITEMS, type Animations, type MenuItemConfig } from './types.ts';

/** 最小合法 animations（buildMenuTree 需要 moves.actions 结构） */
const ANIM: Animations = {
  idle: ['待机A'],
  turn: [],
  drag: [],
  clicks: [],
  moves: { default: { minDist: 100, maxDist: 300, margin: 100, leadSec: 0.2, tailSec: 0.2 }, actions: [] },
  categories: [],
  events: {},
} as unknown as Animations;

const opts = (over: Partial<{ windowed: boolean; balanceEnabled: boolean }> = {}) => ({
  windowed: over.windowed ?? false,
  balanceEnabled: over.balanceEnabled ?? true,
  animations: ANIM,
});

/** 取组装结果的一级 label 列表（断言顺序用） */
const labels = (items: MenuItemConfig[] | undefined, o = opts()) => buildToolItems(items, o).map((n) => n.label);

describe('buildToolItems —— 菜单项配置驱动', () => {
  test('缺省/空数组 → 默认菜单（配置缺失绝不等于菜单消失）', () => {
    assert.deepEqual(
      labels(undefined),
      DEFAULT_MENU_ITEMS.map((m) => m.label),
    );
    assert.deepEqual(
      labels([]),
      DEFAULT_MENU_ITEMS.map((m) => m.label),
    );
  });

  test('数组顺序 = 菜单顺序（可把重载配置挪到最前）', () => {
    const items: MenuItemConfig[] = [
      { id: 'reload', label: '重启', visible: true },
      { id: 'chat', label: '聊天', visible: true },
    ];
    assert.deepEqual(labels(items), ['重启', '聊天']);
  });

  test('label 覆盖生效；visible=false 的项不出现在菜单里', () => {
    const items: MenuItemConfig[] = [
      { id: 'site', label: '我的设置', visible: true },
      { id: 'whisper', label: '说点什么', visible: false },
      { id: 'home', label: '回家', visible: true },
    ];
    assert.deepEqual(labels(items), ['我的设置', '回家']);
  });

  test('site 项按形态分发：浏览器= settings（桌宠设置页），桌面= open-site（打开网站）', () => {
    const items: MenuItemConfig[] = [{ id: 'site', label: '入口', visible: true }];
    const web = buildToolItems(items, opts({ windowed: false }));
    assert.equal((web[0] as { action?: string }).action, 'settings');
    const desktop = buildToolItems(items, opts({ windowed: true }));
    assert.equal((desktop[0] as { action?: string }).action, 'open-site');
  });

  test('balance 项还要该宠物开了余额；关了就不给入口', () => {
    const items: MenuItemConfig[] = [
      { id: 'balance', label: '余额', visible: true },
      { id: 'home', label: '回家', visible: true },
    ];
    assert.deepEqual(labels(items, opts({ balanceEnabled: true })), ['余额', '回家']);
    assert.deepEqual(labels(items, opts({ balanceEnabled: false })), ['回家']);
  });

  test('animations 项 = 整棵动画树，label 覆盖其根标题（「动作」→自定义）', () => {
    const items: MenuItemConfig[] = [{ id: 'animations', label: '小剧场', visible: true }];
    const out = buildToolItems(items, opts());
    assert.equal(out.length, 1);
    assert.equal(out[0].label, '小剧场');
    const children = (out[0] as { children?: unknown[] }).children;
    assert.ok(Array.isArray(children) && children.length, '动画树分支必须带子分类');
  });

  test('动画池全空 → 动画树项不出现（空分支不占位）；未知 id 忽略', () => {
    const emptyAnim = { ...ANIM, idle: [] } as Animations;
    const items: MenuItemConfig[] = [
      { id: 'animations', label: '动作', visible: true },
      { id: 'future-feature', label: '未来的项', visible: true },
    ];
    const out = buildToolItems(items, { ...opts(), animations: emptyAnim });
    assert.deepEqual(out, [], '池空 + 未知 id 都不产出节点');
  });

  test('全隐藏 → 空数组（调用方 onContextMenu 直接 return，不弹空菜单）', () => {
    const items = DEFAULT_MENU_ITEMS.map((m) => ({ ...m, visible: false }));
    assert.deepEqual(buildToolItems(items, opts()), []);
  });
});
