'use client'

/**
 * lab 演示用的「当前是第几天」全局状态。
 *
 * **为什么不用 React state 驱动**:播放时每天推进约 4~48 次/秒,若走 setState,
 * 六个渲染器每帧都要重跑 React 调和;canvas/WebGL 那几套更不该被 React 碰到。
 * 所以这里是一个极小的外部 store:各渲染器在自己的 rAF 里 `get()` 读值直接画,
 * 只有 HUD(阶段徽章、进度条)通过 `useSyncExternalStore` 订阅。
 *
 * 挂在 globalThis 上,避免 React 18/19 严格模式双挂载时建出两个 store。
 */

import { useSyncExternalStore } from 'react'

export const MAX_DAY = 60
export const SPEEDS = [1, 4, 12] as const
export type Speed = (typeof SPEEDS)[number]

/** 1× 速度下 60 天约 15 秒走完 */
const DAYS_PER_SEC_AT_1X = 4

type Listener = () => void

class DayStore {
  private _day = 0
  private _playing = false
  private _speed: Speed = 4
  private _loop = true
  private _raf = 0
  private _last = 0

  private readonly dayListeners = new Set<Listener>()
  private readonly flagListeners = new Set<Listener>()
  private snap = { playing: false, speed: 4 as Speed, loop: true }

  get day(): number {
    return this._day
  }

  /**
   * 渲染器每帧读一次。**必须读 getter 而不是缓存的快照字段** ——
   * 播放中天数每帧都在变,缓存字段要等 `emitDay` 通知订阅者才更新,
   * 而渲染器不是订阅者。
   */
  get(): number {
    return this._day
  }
  get playing(): boolean {
    return this._playing
  }
  get speed(): Speed {
    return this._speed
  }
  get loop(): boolean {
    return this._loop
  }

  setDay(d: number) {
    const next = Math.min(MAX_DAY, Math.max(0, d))
    if (next === this._day) return
    this._day = next
    this.emitDay()
  }

  setSpeed(s: Speed) {
    if (s === this._speed) return
    this._speed = s
    this.emitFlag()
  }

  setLoop(on: boolean) {
    if (on === this._loop) return
    this._loop = on
    this.emitFlag()
  }

  toggle() {
    if (this._playing) this.pause()
    else this.play()
  }

  play() {
    // 已在末尾时从头播,避免「按了播放没反应」
    if (this._day >= MAX_DAY - 1e-6) this._day = 0
    if (this._playing) return
    this._playing = true
    this._last = performance.now()
    this._raf = requestAnimationFrame(this.tick)
    this.emitFlag()
    this.emitDay()
  }

  /**
   * 首次进页面自动开播。
   *
   * 必须在 effect 里调:`play()` 用到 `performance.now()` 与 `requestAnimationFrame`,
   * 直接在渲染期调用既拿不到(SSR),又会因两端初始 HTML 不同而 hydration mismatch。
   * 只播一次(挂在 globalThis 上的 `__zxLabAutoplayed`),来回切路由不会把用户的
   * 暂停/调速重置掉。
   */
  autoplayOnce() {
    const gg = globalThis as unknown as { __zxLabAutoplayed?: boolean }
    if (gg.__zxLabAutoplayed) return
    gg.__zxLabAutoplayed = true
    this.play()
  }

  pause() {
    if (!this._playing) return
    this._playing = false
    if (this._raf) cancelAnimationFrame(this._raf)
    this._raf = 0
    this.emitFlag()
  }

  /** 回到第 0 天并暂停 */
  reset() {
    this.pause()
    this._day = 0
    this.emitDay()
  }

  private readonly tick = (now: number) => {
    if (!this._playing) return
    // 上限 100ms:切标签页回来时不要「补帧」直接跳到末尾
    const dt = Math.min(0.1, (now - this._last) / 1000)
    this._last = now
    const next = this._day + dt * DAYS_PER_SEC_AT_1X * this._speed
    if (next >= MAX_DAY) {
      if (this._loop) {
        this._day = 0
      } else {
        this._day = MAX_DAY
        this._playing = false
        this._raf = 0
        this.emitFlag()
      }
    } else {
      this._day = next
    }
    this.emitDay()
    if (this._playing) this._raf = requestAnimationFrame(this.tick)
  }

  subscribeDay = (l: Listener) => {
    this.dayListeners.add(l)
    return () => void this.dayListeners.delete(l)
  }

  subscribeFlag = (l: Listener) => {
    this.flagListeners.add(l)
    return () => void this.flagListeners.delete(l)
  }

  /** useSyncExternalStore 要求快照在值未变时**引用稳定**,这里返回缓存值 */
  getDaySnapshot = () => this._day

  /**
   * 三个 flag 打包成一个快照。
   *
   * **只有在字段真的变了才换新对象** —— useSyncExternalStore 用 `Object.is` 比较
   * 前后两次 getSnapshot 的返回值,如果每次都返回同一个对象引用,React 会认为
   * 「没变化」而**跳过重渲染**:播放/调速/循环的按钮就会失灵(状态变了但 UI 不动)。
   */
  getFlagSnapshot = () => {
    if (
      this.snap.playing !== this._playing ||
      this.snap.speed !== this._speed ||
      this.snap.loop !== this._loop
    ) {
      this.snap.playing = this._playing
      this.snap.speed = this._speed
      this.snap.loop = this._loop
      this.snap = { ...this.snap }
    }
    return this.snap
  }

  private emitDay() {
    for (const l of this.dayListeners) l()
  }
  private emitFlag() {
    for (const l of this.flagListeners) l()
  }
}

const g = globalThis as unknown as { __zxLabDay?: DayStore }

export const dayStore: DayStore = (g.__zxLabDay ??= new DayStore())

/** HUD 订阅当前天数 */
export function useLabDay(): number {
  return useSyncExternalStore(dayStore.subscribeDay, dayStore.getDaySnapshot, () => 0)
}

/** HUD 订阅播放/速度/循环状态 */
export function useLabFlags() {
  return useSyncExternalStore(dayStore.subscribeFlag, dayStore.getFlagSnapshot, dayStore.getFlagSnapshot)
}
