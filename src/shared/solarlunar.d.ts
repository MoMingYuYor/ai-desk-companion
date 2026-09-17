// solarlunar 最小类型声明(该包的 d.ts 在 ESM 解析下不被识别)
declare module 'solarlunar' {
  interface SolarLunarResult {
    lYear: number
    lMonth: number
    lDay: number
    monthCn: string
    dayCn: string
    isLeap: boolean
    isTerm: boolean
    term: string
    gzYear: string
    animal: string
  }
  const solarLunar: {
    solar2lunar(y: number, m: number, d: number): SolarLunarResult
  }
  export default solarLunar
}
