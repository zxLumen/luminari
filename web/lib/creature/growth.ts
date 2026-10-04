/**
 * 成长数学:**阶段是时间的纯函数,不需要任何定时任务。**
 *
 * 全站没有 cron、没有后台 worker;阶段由 `createdAt` 与 `now` 现算。这带来两个直接好处:
 *  - 零流量时照样每天长大(没有请求就没有「推进」,但读的时候一样算得对);
 *  - 互动加速只是给总经验加个数,不影响阶段方向 —— 方向永远由描述在创建时写死。
 *
 * 经验用**小数天**而不是自然日:`days = (now - createdAt) / 86400000`。这样时间轴
 * 拖动是连续���(23:50 创建的生物不会在 10 分钟后突然跳一级),`stageFloat` 也保持单调。
 */

import { STAGE_COUNT } from './spec.js'

/** 各阶段经验门槛 */
export const STAGE_XP = [0, 40, 140, 340] as const

/** 每个现实日自动获得的经验(纯挂机,无需任何互动) */
export const DAILY_XP = 18

/** 互动加速:访客无需投票,只是路过时多看/点了一下 */
export const INTERACT_XP = { hover: 1, click: 4, revisit: 3 } as const

export const MAX_XP = STAGE_XP[STAGE_COUNT - 1]

/** 一个访客对一只生物的互动计数(interact JSON 的一格) */
export interface InteractCounts {
  /** 悬停次数(同一访客每只最多计到上限,防无限刷) */
  h: number
  /** 点击次数 */
  c: number
}

/** 单访客单只生物的互动计入上限:再刷也不加分 */
export const INTERACT_CAP = 12

const DAY_MS = 86_400_000

/** 已过天数(小数,负数夹到 0) */
export function elapsedDays(createdAtMs: number, nowMs: number): number {
  return Math.max(0, (nowMs - createdAtMs) / DAY_MS)
}

/**
 * 互动经验合计。
 *
 * `interact` 按 cid 分桶,每个 cid 的贡献封顶 `INTERACT_CAP`,这样单个访客反复悬停
 * 刷不出分数(不改变阶段方向,只影响速度)。
 */
export function interactXp(interact: Record<string, InteractCounts> | null | undefined): number {
  if (!interact) return 0
  let sum = 0
  for (const key in interact) {
    const row = interact[key]
    if (!row) continue
    const h = Math.max(0, Math.min(INTERACT_CAP, Number(row.h) || 0))
    const c = Math.max(0, Math.min(INTERACT_CAP, Number(row.c) || 0))
    sum += h * INTERACT_XP.hover + c * INTERACT_XP.click
  }
  return sum
}

export interface GrowthInput {
  /** 创建时刻(ms) */
  createdAtMs: number
  /** 已结算的互动经验(入库字段 stage_xp) */
  stageXp: number
  /** 按 cid 分桶的互动明细 */
  interact?: Record<string, InteractCounts> | null
  nowMs?: number
}

export interface Growth {
  /** 总经验 = 时间经验 + 互动经验 */
  xp: number
  /** 时间贡献的那部分(调试/展示用) */
  timeXp: number
  /** 连续阶段值 0.0..3.0,渲染器据此做阶段内插值 */
  stageFloat: number
  /** 下取整阶段 0..3 */
  stage: number
  /** 当前阶段内进度 0..1 */
  progress: number
  /** 距下一阶段的剩余经验(已满级为 0) */
  toNext: number
  /** 是否已到最终形态 */
  maxed: boolean
}

/** 总经验 */
export function totalXp(input: GrowthInput, nowMs = Date.now()): { xp: number; timeXp: number } {
  const timeXp = Math.floor(elapsedDays(input.createdAtMs, nowMs) * DAILY_XP)
  const xp = timeXp + Math.max(0, input.stageXp | 0) + interactXp(input.interact)
  return { xp, timeXp }
}

/**
 * 连续阶段值 —— 六套渲染器共用的「今天长到哪儿了」。
 *
 * 在相邻门槛之间线性插值:xp 落在 T[i] 与 T[i+1] 之间就返回 i + 比例。
 * 线性而非缓动,是为了让时间轴拖动与实际挂机成长严格一致(可测、可复现)。
 */
export function stageFloatOf(xp: number): number {
  if (!Number.isFinite(xp) || xp <= 0) return 0
  if (xp >= MAX_XP) return STAGE_COUNT - 1
  for (let i = STAGE_COUNT - 1; i > 0; i--) {
    const hi = STAGE_XP[i]
    const lo = STAGE_XP[i - 1]
    if (xp >= lo) {
      if (xp >= hi) return i
      return i - 1 + (xp - lo) / (hi - lo)
    }
  }
  return 0
}

/** 当前阶段内的进度 0..1 */
export function progressOf(stageFloat: number): number {
  const s = Math.min(Math.max(stageFloat, 0), STAGE_COUNT - 1)
  const i = Math.min(Math.floor(s), STAGE_COUNT - 2)
  if (i < 0) return 1
  return s - i
}

export function growthOf(input: GrowthInput, nowMs = Date.now()): Growth {
  const { xp, timeXp } = totalXp(input, nowMs)
  const stageFloat = stageFloatOf(xp)
  const stage = Math.min(Math.floor(stageFloat), STAGE_COUNT - 1)
  const maxed = stageFloat >= STAGE_COUNT - 1 - 1e-6
  const nextAt = STAGE_XP[Math.min(stage + 1, STAGE_COUNT - 1)]
  return {
    xp,
    timeXp,
    stageFloat,
    stage,
    progress: maxed ? 1 : progressOf(stageFloat),
    toNext: maxed ? 0 : Math.max(0, nextAt - xp),
    maxed,
  }
}

/** 演示与测试用:站在「创建后的第 day 天」看它长成什么样 */
export function growthAtDay(input: Omit<GrowthInput, 'nowMs'>, day: number): Growth {
  const created = input.createdAtMs
  return growthOf(input, created + Math.max(0, day) * DAY_MS)
}

/** 达到某阶段大约需要多少天(纯时间、无互动),用于文案与阈值调参 */
export function daysToStage(stage: number): number {
  const s = Math.min(Math.max(Math.round(stage), 0), STAGE_COUNT - 1)
  return STAGE_XP[s] / DAILY_XP
}
