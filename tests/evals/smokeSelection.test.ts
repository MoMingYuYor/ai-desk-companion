import { expect, it } from 'vitest'
import { selectExplicitSmokeCases } from '../../src/main/evals/experiment'
import { loadDatasetFromDir } from '../../src/main/evals/dataset'
import { join } from 'node:path'

it('指定 dev 案例清单保留顺序，未知、holdout、重复、空清单拒绝', () => {
  const dataset = loadDatasetFromDir(join(process.cwd(), 'evals/datasets/personal_ops_v2'))
  const ids = dataset.dev.slice(0, 2).map(c => c.case_id).reverse()
  expect(selectExplicitSmokeCases(dataset.cases, ids).map(c => c.case_id)).toEqual(ids)
  for (const invalid of [[], ['unknown'], [ids[0]!, ids[0]!], [dataset.holdout[0]!.case_id]]) {
    expect(() => selectExplicitSmokeCases(dataset.cases, invalid)).toThrow()
  }
})
