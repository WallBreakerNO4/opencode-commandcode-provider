/**
 * 预请求退避状态机（disguise.md §5 + §11 参数速查）。指纹记录与 lifecycle 两个
 * 预请求合记一个结局（照抄 MAXeaglet 的耦合结构）；任何结局都不影响主请求，
 * 本模块只推进「下次允许尝试的时刻」。
 *
 * 结局三态：
 * - success：`nextInitAt = now + 8h + rand×2h`（长驻补发节奏），`failCount = 0`
 * - transient（网络错误 / 超时 / 5xx 任一）：`now + min(60s × 2^failCount, 15min)`，`failCount++`
 * - rejected（4xx 含 401/403 任一）：长冷却 `now + 8h + rand×2h`——服务器明确说
 *   「不」之后继续敲门更像机器人，安静是上策
 *
 * 时间直接取 `Date.now()`（testing.md：生产代码不加时钟注入参数，测试走 fake timers）。
 */

/** 成功 / 4xx 长冷却的基础间隔：8h（ground truth 未获证实，保守保留，#9） */
export const SUCCESS_INTERVAL_MS = 8 * 60 * 60 * 1000
/** 成功 / 长冷却的随机抖动上限：`floor(random × 2h)` 均匀分布 */
export const JITTER_MS = 2 * 60 * 60 * 1000
/** 瞬时失败退避基数：60s × 2^failCount */
export const TRANSIENT_BASE_MS = 60 * 1000
/** 瞬时失败退避封顶：15min */
export const TRANSIENT_CAP_MS = 15 * 60 * 1000

/** 预请求单元（两请求合记）的结局分类（§5 表） */
export type PreflightOutcome = "success" | "transient" | "rejected"

export interface PreflightState {
  /** 下次允许预请求的时刻（epoch ms）；0 = 立即可试（首见 key / 重启归零）。
   * 成功结局下即规格 §5 的 `nextInitAt`（长驻补发节奏），其余结局是重试时刻 */
  nextAttemptAt: number
  /** 瞬时失败连续计数，驱动指数退避档位；成功清零 */
  failCount: number
}

export function initialPreflightState(): PreflightState {
  return { nextAttemptAt: 0, failCount: 0 }
}

/** 8h + floor(random × 2h) 均匀抖动（成功与 4xx 长冷却共用同一节奏） */
function jitteredInterval(): number {
  return SUCCESS_INTERVAL_MS + Math.floor(Math.random() * JITTER_MS)
}

/** 按结局推进状态；返回新状态对象，不改入参 */
export function applyPreflightOutcome(state: PreflightState, outcome: PreflightOutcome): PreflightState {
  const now = Date.now()

  if (outcome === "transient") {
    // 指数按旧计数取档：第 1 次失败 60s、第 2 次 120s……第 5 次起封顶 15min
    const delay = Math.min(TRANSIENT_BASE_MS * 2 ** state.failCount, TRANSIENT_CAP_MS)
    return { nextAttemptAt: now + delay, failCount: state.failCount + 1 }
  }

  if (outcome === "rejected") {
    // 4xx 不动 failCount：规格只在成功时指明清零；长冷却本身远超任何退避档位，
    // 计数去留的可观察差异仅在「4xx 冷却后紧跟瞬时失败」一档，保持最小语义
    return { nextAttemptAt: now + jitteredInterval(), failCount: state.failCount }
  }

  return { nextAttemptAt: now + jitteredInterval(), failCount: 0 }
}
