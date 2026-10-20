/**
 * Go plan 判据：官方 1.84.0 起 view=client catalog 与包内嵌目录的原生口径。
 * 放在 catalog 领域层，供产物组装、对账断言与主编排共用，避免判据住在某一消费者里。
 */

import type { CatalogEntry } from "./bundle.ts"

export const GO_MIN_PLAN = "individual-go"

export function isGoPlanVisible(entry: CatalogEntry): boolean {
  return entry.minimumPlan === GO_MIN_PLAN && entry.hidden !== true
}
