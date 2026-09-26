// 检索分词(C-05):中文字符相邻二元组 + 英文数字词,确定性、无外部依赖。
//
// 实测依据(依赖与工具链基线 §7):FTS4 默认分词器把整段 CJK 当单一 token,
// 中文查询全部落空;经二元组预处理后六个测试词全部命中。索引与查询必须
// 使用同一预处理器与同一版本号;分词实现自本版本起锁定。
//
// 安全不变量:产物 token 只含 [a-z0-9] 与 CJK 字符,不含引号/空格/运算符,
// 因此被双引号包裹后进入 FTS MATCH 表达式不可能构成语法注入
// (实测:带引号的关键字词 "or"/"near"/"and"/"not" 均按普通词处理)。

export const SEARCH_VERSION = 1

const CJK_RE = /[\u4e00-\u9fa5]/
const WORD_RE = /[a-zA-Z0-9]/
/** 分词产物形状;buildMatchQuery 据此拒绝任何越形值(防御纵深) */
const TOKEN_RE = /^[a-z0-9\u4e00-\u9fa5]+$/

/**
 * 文本 → 检索 token 序列:
 * - CJK 连续段拆相邻二元组(单字自成一词):"机器学习" → 机器/器学/学习
 * - 英文数字连续段转小写保留:Python/FastAPI → python / fastapi
 * - 其余字符(标点、空白、其他文字)作为分隔符丢弃
 */
export function tokenizeForSearch(text: string): string[] {
  const out: string[] = []
  const chars = Array.from(text)
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]!
    if (CJK_RE.test(ch)) {
      let j = i
      while (j < chars.length && CJK_RE.test(chars[j]!)) j += 1
      const run = chars.slice(i, j)
      if (run.length === 1) {
        out.push(run[0]!)
      } else {
        for (let k = 0; k + 1 < run.length; k += 1) out.push(run[k]! + run[k + 1]!)
      }
      i = j
      continue
    }
    if (WORD_RE.test(ch)) {
      let j = i
      while (j < chars.length && WORD_RE.test(chars[j]!)) j += 1
      out.push(chars.slice(i, j).join('').toLowerCase())
      i = j
      continue
    }
    i += 1
  }
  return out
}

/**
 * 由分词产物构造 FTS MATCH 表达式:每个 token 双引号包裹,OR 连接
 * (召回优先,排序由应用层词频计分决定)。非分词产物形状的 token 拒绝,
 * 用户输入永远不直接拼接进表达式。
 */
export function buildMatchQuery(tokens: readonly string[]): string {
  if (tokens.length === 0) return ''
  for (const token of tokens) {
    if (!TOKEN_RE.test(token)) throw new Error(`非法检索词,拒绝进入 MATCH 表达式:${JSON.stringify(token)}`)
  }
  return tokens.map((token) => `"${token}"`).join(' OR ')
}
