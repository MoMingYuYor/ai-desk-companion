// 检索分块(C-05):规范文本上的连续切片,码点 offset、左闭右开。
//
// 参数(总体规格第 5 节,待评测配置目标):段落优先截断,
// 目标每块约 800 码点、单块上限 1,200 码点、相邻重叠约 120 码点。
//
// 码点约定:offset 是 Unicode 码点索引(与 Array.from(text) 对齐),
// 不是 UTF-16 下标——JS 字符串切片是 UTF-16 语义,须显式换算;
// 任何 chunk 的 content 都能用 Array.from(text).slice(start,end).join('') 复原。

export const CHUNK_TARGET_CODEPOINTS = 800
export const CHUNK_MAX_CODEPOINTS = 1200
export const CHUNK_OVERLAP_CODEPOINTS = 120

export interface TextChunk {
  /** 块序号,从 0 递增 */
  index: number
  /** 起始码点 offset(含) */
  startOffset: number
  /** 结束码点 offset(不含) */
  endOffset: number
  /** 规范文本的连续切片 */
  content: string
}

export interface ChunkerOptions {
  target?: number
  max?: number
  overlap?: number
}

/**
 * 把规范文本切成连续重叠块:
 * - 优先在窗口内最后一个 '\n' 后断行(段落优先);
 * - 无段落边界时按目标长度硬断(不超过上限);
 * - 相邻块重叠不超过 overlap(短块场景由下界保证推进)。
 */
export function chunkText(text: string, options: ChunkerOptions = {}): TextChunk[] {
  const target = options.target ?? CHUNK_TARGET_CODEPOINTS
  const max = options.max ?? CHUNK_MAX_CODEPOINTS
  const overlap = options.overlap ?? CHUNK_OVERLAP_CODEPOINTS
  if (max < target || overlap >= max) {
    throw new Error(`分块参数非法:target=${target}, max=${max}, overlap=${overlap}`)
  }

  const cps = Array.from(text)
  // 码点 i 的 UTF-16 起始下标;哨兵 u16[cps.length] = text.length
  const u16 = new Array<number>(cps.length + 1)
  let acc = 0
  for (let i = 0; i < cps.length; i += 1) {
    u16[i] = acc
    acc += cps[i]!.length
  }
  u16[cps.length] = text.length

  const chunks: TextChunk[] = []
  let start = 0
  while (start < cps.length) {
    const hardEnd = Math.min(start + max, cps.length)
    let end: number
    if (hardEnd >= cps.length) {
      end = cps.length
    } else {
      let brk = -1
      for (let i = hardEnd; i > start; i -= 1) {
        if (cps[i] === '\n') {
          brk = i
          break
        }
      }
      end = brk >= 0 ? brk + 1 : start + target
    }
    chunks.push({
      index: chunks.length,
      startOffset: start,
      endOffset: end,
      content: text.slice(u16[start], u16[end])
    })
    if (end >= cps.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks
}

/** 校验 offset 与文本的码点对齐:content 必须等于码点切片(引用定位的回归防线) */
export function verifyChunkAlignment(text: string, chunk: Pick<TextChunk, 'startOffset' | 'endOffset' | 'content'>): boolean {
  const resliced = Array.from(text)
    .slice(chunk.startOffset, chunk.endOffset)
    .join('')
  return resliced === chunk.content
}
