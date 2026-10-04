import { butterfly } from './butterfly'
import { fox } from './fox'
import type { Rig } from './types'

export * from './types'

/** 已实现的物种库。加物种 = 在这里登记一份 rig。 */
export const SPECIES = {
  butterfly,
  fox,
} as const

export type SpeciesId = keyof typeof SPECIES

export const SPECIES_LIST: Rig[] = [butterfly, fox]

/**
 * 描述 → 物种。**故意只做很轻的匹配**:物种是「骨」,描述主要该反映在配色/性格上。
 * 匹配不到就退回蝴蝶(当前辨识度最高的一只)。
 */
export function speciesFor(descr: string): Rig {
  const t = descr || ''
  if (/狐|狸|fennec|fox/i.test(t)) return fox
  if (/蝶|蛾|butterfly|moth/i.test(t)) return butterfly
  // 其余描述暂时都回蝴蝶,等物种库补齐再细化
  return butterfly
}
