/** 生物 DNA 核心:类型 / 校验 / 成长数学 / 程序兜底 / 确定性打分。零依赖。
 *
 * 从 zxLumen-Blog 的 `packages/shared/src/creature/` 整批迁移而来(blog 侧不再保留)。
 * luminari 是评分引擎的**权威版**。
 */

export {
  ARCHETYPES,
  TRAIT_AXES,
  STAGE_COUNT,
  STAGE_LABELS,
  STAGE_SIZE,
  ARCHETYPE_SHAPE,
  normalizeDna,
  formAt,
  resolveForm,
} from './spec.js'
export type { Archetype, Palette, ShapeHints, Motion, StagePlan, CreatureDna, FormState, TraitAxis } from './spec.js'

export {
  STAGE_XP,
  DAILY_XP,
  MAX_XP,
  INTERACT_XP,
  INTERACT_CAP,
  elapsedDays,
  interactXp,
  totalXp,
  stageFloatOf,
  progressOf,
  growthOf,
  growthAtDay,
  daysToStage,
} from './growth.js'
export type { InteractCounts, GrowthInput, Growth } from './growth.js'

export { fallbackDna, keywordMatch, DEFAULT_DNA, PRESET_DESCRIPTIONS } from './fallback.js'
export { randomBatch, DENSITY_LABEL, type Density, type RandomItem, type RandomBatch } from './random.js'

export { normalizeBlueprint, compileBlueprint, BP_ROLES, MOTION_FAMILIES } from './blueprint.js'
export type {
  CreatureBlueprint,
  BpPart,
  BpRole,
  BpMotion,
  MotionFamily,
  CompiledRig,
  CompiledPart,
  CompiledBlueprint,
} from './blueprint.js'

export {
  CRAFT_WEIGHTS,
  APPEAL_WEIGHTS,
  WEIGHTS,
  WEIGHT_TOTAL,
  CRAFT_TOTAL,
  APPEAL_TOTAL,
  SCORE_AXES,
  SCORE_KEYS,
  CRAFT_KEYS,
  APPEAL_KEYS,
  AXIS_OF,
  AXIS_MIX,
  SCORE_DIM_FLOOR,
  SCORE_VERSION,
  weightedGeometricMean,
  combineAxes,
  heuristicScore,
  craftScore,
  heatOf,
  rankScore,
  rankOf,
} from './score.js'
export type {
  ScoreBreakdown,
  ScoreKey,
  ScoreAxis,
  ScoreContext,
  ScorePart,
  ScoreMotionRule,
  RankedCreature,
} from './score.js'

/** 批次级多样性 / 新颖度(不进 ScoreBreakdown.total,理由见 diversity.ts) */
export { diversityOf } from './diversity.js'
export type { DiversityReport, DiversityPerItem, DimSpread } from './diversity.js'

/** 维度杠杆分析:各维权重占比 vs 实际方差份额,用来抓「白拿权重」的死重 */
export { leverageOf, DEAD_WEIGHT_SHARE, DEAD_WEIGHT_RATIO } from './leverage.js'
export type { LeverageReport, LeverageRow } from './leverage.js'

/** 逐维校准:各维与人工评价的秩相关 + 分布 */
export { rhoOf, distOf, calibrate, deadThreshold, DIM_KEYS, MIN_N_FOR_RHO } from './calibrate.js'
export type { Calibration, DimCalib, Dist, RatedRow, DimKey } from './calibrate.js'

/** 成对偏好聚合(Davidson Bradley–Terry)+ 位置偏差合并。视觉裁判的实验用 */
export { fitBradleyTerry, reconcilePair } from './bt.js'
export type { BtResult, BtOptions, PairResult, PairOutcome } from './bt.js'
