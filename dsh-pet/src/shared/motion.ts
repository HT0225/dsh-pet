// 移动几何与角落定位：纯计算（无 DOM / ref），可独立单测。
// 坐标语义：移动规划归一化为视口比例（ratio），px 换算由调用方（rAF 驱动 / customPos）完成；
// 角落定位返回宠物根节点左上角的像素坐标（浏览器 overlay 用 CSS 同语义，桌面模式用它摆放 sprite）。
import { randomBetween } from './pickers';
import { rectAtPoint } from './displays';
import type { Corner, Rect } from './types';

/** 一次移动的几何参数（比例坐标） */
export interface MovePlan {
  startRatio: number;
  startYRatio: number;
  targetRatio: number;
  /** 终点 Y（比例）：默认 = startYRatio（纯水平，旧行为不变）；给了 yDist 且 Y 校验通过时 ≠ startY */
  targetYRatio: number;
  totalRatio: number;
}

/** 计算一次移动的起点/终点比例坐标；目标越出视口边缘（含边距）时返回 null。
 *  sideAllow = 左右透明边余量（视频画布内宠物身体居中、两侧透明）：边界按"身体"贴边而不是
 *  按"整个视频盒"贴边——宠物能走到屏幕边缘，但身体永不越界（不会漫游到屏幕外丢失）。
 *
 *  areas 传入时（桌面多显示器）边界改判**工作区并集**而不是视口外接矩形：落点的身体两侧
 *  各留 margin 后仍须落在某块屏上。缝隙两侧都有屏 ⇒ 可自由走过去（允许骑缝）；外接矩形里的
 *  空洞没有屏 ⇒ 走不进去。不传时按 W/H 单矩形判定，浏览器 overlay 行为逐位不变。 */
export const planMove = (o: {
  cx: number;
  cy: number;
  W: number;
  H: number;
  dir: 1 | -1;
  minDist: number;
  maxDist: number;
  margin: number;
  halfW: number;
  /** 可选：身体相对视频盒左/右各留多少像素（默认 0 = 旧行为，按视频盒贴边） */
  sideAllow?: number;
  /** 可选：显示器工作区列表（与 cx/cy 同坐标系）。给了就按并集判定落点可达性 */
  areas?: Rect[];
  /** 可选：宠物半高（Y 方向边界判定用；提供 yDist 时必须给，否则跳过 Y 尝试） */
  halfH?: number;
  /** 可选：Y 方向随机偏移范围（px，给了才尝试垂直移动；Y 校验失败自动退回纯水平） */
  yDist?: { min: number; max: number };
}): MovePlan | null => {
  const side = o.sideAllow ?? 0;
  const distance = randomBetween(o.minDist, o.maxDist);
  const target = o.cx + o.dir * distance;

  /** 目标点 (targetX, targetCy) 的身体是否可达（halfH 只在 Y 变化时用） */
  const valid = (targetX: number, targetCy: number): boolean => {
    const yChanged = Math.abs(targetCy - o.cy) > 0.5;
    if (o.areas && o.areas.length > 0) {
      // 身体左右缘各外扩 margin 后都得落在某块屏上（可以分属不同屏 = 允许骑缝行走）
      const bodyHalf = o.halfW - side;
      if (!rectAtPoint(o.areas, targetX - bodyHalf - o.margin, targetCy)) return false;
      if (!rectAtPoint(o.areas, targetX + bodyHalf + o.margin, targetCy)) return false;
      if (yChanged && o.halfH !== undefined) {
        if (!rectAtPoint(o.areas, targetX, targetCy - o.halfH - o.margin)) return false;
        if (!rectAtPoint(o.areas, targetX, targetCy + o.halfH + o.margin)) return false;
      }
      return true;
    }
    // margin 语义 =「身体到屏幕边缘的安全距」：盒中心可到 margin + halfW - side（身体左缘 = margin）
    const leftBound = o.margin + o.halfW - side;
    const rightBound = o.W - o.margin - o.halfW + side;
    if (targetX < leftBound || targetX > rightBound) return false;
    if (yChanged && o.halfH !== undefined) {
      const topBound = o.margin + o.halfH;
      const bottomBound = o.H - o.margin - o.halfH;
      if (targetCy < topBound || targetCy > bottomBound) return false;
    }
    return true;
  };

  const makePlan = (targetX: number, targetCy: number): MovePlan => ({
    startRatio: o.cx / o.W,
    startYRatio: o.cy / o.H,
    targetRatio: targetX / o.W,
    targetYRatio: targetCy / o.H,
    totalRatio: Math.abs(targetX - o.cx) / o.W,
  });

  // 尝试 Y 偏移（随机方向）：先夹到该方向的可用空间（不越界），再校验完整落点。
  // 有效就走斜线；该方向没空间（如底部想往下）→ 退回纯水平（左右走），
  // 与用户约定一致——「下面没有空间了，那就让他左右走」，不硬挤、不越界。
  if (o.yDist && o.halfH !== undefined && o.yDist.max > 0) {
    const sign: -1 | 1 = Math.random() < 0.5 ? -1 : 1;
    const topBound = o.margin + o.halfH;
    const bottomBound = o.H - o.margin - o.halfH;
    // 该方向可用余量（中心能走多远才碰边）
    const available = sign === -1 ? o.cy - topBound : bottomBound - o.cy;
    if (available > 0) {
      // 偏移夹进 [min(dMin,dMax), min(yDist.max, available)]——保证不越出上下界
      const dMax = Math.min(o.yDist.max, available);
      const dMin = Math.min(o.yDist.min, dMax);
      const dy = randomBetween(dMin, dMax) * sign;
      const targetCy = o.cy + dy;
      if (Math.abs(targetCy - o.cy) > 0.5 && valid(target, targetCy)) {
        return makePlan(target, targetCy);
      }
    }
    // 这个方向没空间 / Y 校验失败 → 落到下面的纯水平（左右走）
  }

  if (!valid(target, o.cy)) return null;
  return makePlan(target, o.cy);
};

/**
 * 角落 + 边距 → 宠物根节点左上角像素坐标。
 * 与浏览器 overlay 的 CSS 角落语义一致：
 *   top-left     = left:marginX, top:marginY
 *   top-right    = right:marginX, top:marginY
 *   bottom-left  = left:marginX, bottom:marginY
 *   bottom-right = right:marginX, bottom:marginY
 * 桌面模式用同一套几何摆放宠物（根节点 = 舞台）。
 *
 * area 传入时角落取**那块屏**而不是视口外接矩形。多显示器不规则布局下外接矩形的角落可能
 * 压根不属于任何显示器（实测右倒 T 型双屏：top-left 落在主屏上方的空洞里，配了该角落的宠物
 * 开机即隐身），所以桌面端必须传主屏工作区。不传时按 W/H，浏览器 overlay 行为不变。
 */
export const anchorPixel = (o: {
  corner: Corner;
  marginX: number;
  marginY: number;
  size: number;
  W: number;
  H: number;
  /** 可选：角落所属的工作区矩形（与调用方同坐标系）；缺省用 {0,0,W,H} */
  area?: Rect;
}): { x: number; y: number } => {
  const height = (o.size * 9) / 16;
  const a = o.area ?? { x: 0, y: 0, width: o.W, height: o.H };
  const left = a.x + o.marginX;
  const top = a.y + o.marginY;
  const right = a.x + a.width - o.size - o.marginX;
  const bottom = a.y + a.height - height - o.marginY;
  switch (o.corner) {
    case 'top-left':
      return { x: left, y: top };
    case 'top-right':
      return { x: right, y: top };
    case 'bottom-left':
      return { x: left, y: bottom };
    case 'bottom-right':
      return { x: right, y: bottom };
  }
};
