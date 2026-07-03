import type { VerifyFinding } from '../../domain/types.js'
import type { CrudStep } from './types.js'

/** A high-severity finding for a CRUD happy-path step that did not succeed. */
export function crudFinding(entity: string, step: CrudStep, detail: string): VerifyFinding {
  return {
    category: 'crud',
    severity: 'high',
    title: `CRUD ${step} 失敗: ${entity}`,
    detail,
    evidence: `entity=${entity} step=${step}`,
  }
}
