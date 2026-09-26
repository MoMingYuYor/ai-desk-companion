import { describe, expect, it } from 'vitest'
import { argumentsHash, stableStringify, validateToolInput } from '../../src/main/tools/schema'
import { ToolRegistry } from '../../src/main/tools/registry'
import { toolSuccess, type ToolDefinition } from '../../src/main/tools/types'

// C-04:注册表与严格 schema。核心断言:未知字段、缺失必填、类型不符、
// 枚举与数值越界、重复注册、未注册查找,全部拒绝。

function def(over: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'fixture.read',
    description: '测试读工具',
    riskLevel: 'read',
    timeoutMs: 1000,
    retryable: false,
    inputSchema: { fields: [{ name: 'query', type: 'string', required: true }] },
    execute: () => toolSuccess({ ok: true }),
    ...over
  }
}

describe('ToolRegistry', () => {
  it('注册后可按名获取,名称字典序列出', () => {
    const registry = new ToolRegistry()
    registry.register(def())
    registry.register(def({ name: 'fixture.write', riskLevel: 'reversible_write' }))
    expect(registry.has('fixture.read')).toBe(true)
    expect(registry.get('fixture.read').name).toBe('fixture.read')
    expect(registry.list()).toEqual(['fixture.read', 'fixture.write'])
    expect(registry.size).toBe(2)
  })

  it('重复注册抛错', () => {
    const registry = new ToolRegistry()
    registry.register(def())
    expect(() => registry.register(def())).toThrow(/重复注册/)
  })

  it('空名注册抛错', () => {
    const registry = new ToolRegistry()
    expect(() => registry.register(def({ name: '   ' }))).toThrow(/不能为空/)
  })

  it('未注册工具查找抛 VALIDATION', () => {
    const registry = new ToolRegistry()
    expect(() => registry.get('ghost.tool')).toThrow(/未注册的工具/)
  })

  it('注册后的定义被冻结:运行期改写风险等级无效', () => {
    const registry = new ToolRegistry()
    registry.register(def())
    const got = registry.get('fixture.read') as ToolDefinition & { riskLevel?: string }
    expect(() => {
      ;(got as { riskLevel: string }).riskLevel = 'irreversible_write'
    }).toThrow()
    expect(registry.get('fixture.read').riskLevel).toBe('read')
  })
})

describe('validateToolInput 严格 schema', () => {
  const schema = {
    fields: [
      { name: 'query', type: 'string', required: true } as const,
      { name: 'limit', type: 'number' } as const,
      { name: 'priority', type: 'string', enum: ['high', 'normal'] } as const,
      { name: 'weight', type: 'number', min: 0, max: 1 } as const,
      { name: 'verbose', type: 'boolean' } as const
    ]
  }

  it('合法输入通过并只保留 schema 字段', () => {
    const got = validateToolInput(schema, { query: '机器学习', limit: 3, weight: 0.5 })
    expect(got).toEqual({ query: '机器学习', limit: 3, weight: 0.5 })
  })

  it('未知字段拒绝(额外字段不进工具执行函数)', () => {
    expect(() => validateToolInput(schema, { query: 'x', evil: '1' })).toThrow(/未知字段:evil/)
    // 模型自报的风险声明同样作为未知字段被拒
    expect(() => validateToolInput(schema, { query: 'x', riskLevel: 'read' })).toThrow(/未知字段:riskLevel/)
    expect(() => validateToolInput(schema, { query: 'x', needsConfirmation: false })).toThrow(/未知字段/)
  })

  it('缺失必填拒绝;可省字段缺省通过', () => {
    expect(() => validateToolInput(schema, {})).toThrow(/缺少必填字段:query/)
    const got = validateToolInput(schema, { query: 'x' })
    expect(got).toEqual({ query: 'x' })
  })

  it('类型不符拒绝(含 number 的 NaN 与非有限值)', () => {
    expect(() => validateToolInput(schema, { query: 1 })).toThrow(/必须是字符串/)
    expect(() => validateToolInput(schema, { query: 'x', limit: '3' })).toThrow(/必须是有限数字/)
    expect(() => validateToolInput(schema, { query: 'x', limit: Number.NaN })).toThrow(/必须是有限数字/)
    expect(() => validateToolInput(schema, { query: 'x', verbose: 'yes' })).toThrow(/必须是布尔值/)
  })

  it('枚举越界拒绝', () => {
    expect(() => validateToolInput(schema, { query: 'x', priority: 'urgent' })).toThrow(/'high' \/ 'normal'/)
    expect(validateToolInput(schema, { query: 'x', priority: 'high' }).priority).toBe('high')
  })

  it('数值范围越界拒绝', () => {
    expect(() => validateToolInput(schema, { query: 'x', weight: -0.1 })).toThrow(/不能小于 0/)
    expect(() => validateToolInput(schema, { query: 'x', weight: 1.1 })).toThrow(/不能大于 1/)
  })

  it('非对象输入拒绝(数组、null、字符串)', () => {
    expect(() => validateToolInput(schema, [])).toThrow(/必须是对象/)
    expect(() => validateToolInput(schema, null)).toThrow(/必须是对象/)
    expect(() => validateToolInput(schema, 'x')).toThrow(/必须是对象/)
  })
})

describe('参数 hash 与稳定序列化', () => {
  it('键序不同、内容相同的参数得到同一 hash', () => {
    expect(argumentsHash({ a: 1, b: 'x' })).toBe(argumentsHash({ b: 'x', a: 1 }))
  })

  it('内容不同 hash 不同', () => {
    expect(argumentsHash({ a: 1 })).not.toBe(argumentsHash({ a: 2 }))
  })

  it('嵌套对象与数组也稳定', () => {
    const a = { list: [1, { y: 2, x: 1 }], z: null }
    const b = { z: null, list: [1, { x: 1, y: 2 }] }
    expect(stableStringify(a)).toBe(stableStringify(b))
  })

  it('hash 与工具名绑定由网关负责:schema 层只管参数本身', () => {
    // 记录契约:网关 hashOf = argumentsHash({ tool, arguments }),同名同参才共享批准
    expect(stableStringify({ tool: 't', arguments: { a: 1 } })).toContain('"tool":"t"')
  })
})
