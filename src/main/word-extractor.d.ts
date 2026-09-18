declare module 'word-extractor' {
  interface WordDocument {
    getBody(): string
    getFootnotes(): string
    getEndnotes(): string
    getHeaders(): string
    getFooters(): string
  }
  export default class WordExtractor {
    extract(path: string): Promise<WordDocument>
  }
}
