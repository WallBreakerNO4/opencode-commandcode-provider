/**
 * JS 对象字面量子集解析器：把 bundle 里截取出的目录对象文本解析为纯数据。
 *
 * 为什么不用 new Function / eval：构建侧红线是「绝不执行 command-code 包内代码」。
 * 受限 eval 虽经调研验证可行（docs/research/model-metadata-sources.md §五附录），
 * 但其安全边界依赖「截取到的恰好只是字面量」这一人工前提；本解析器把前提变成
 * 结构保证——只接受数据形状（对象 / 数组 / 字符串 / 数字 / 布尔 / null / 标识符
 * 引用），遇到函数体、方法简写、调用、模板串等任何可执行形状立即报错，getter
 * 的函数体只做括号配平跳过、内容不解析，包内代码无论如何都进不了执行栈。
 */

/** 解析结果：标识符引用不在此处求值，由调用方（bundle.ts）注入定义解析 */
export type Literal =
  | { kind: "primitive"; value: string | number | boolean | null }
  | { kind: "array"; items: Literal[] }
  | { kind: "object"; entries: Array<{ key: string; value: Literal }> }
  | { kind: "ref"; name: string }

export class LiteralSyntaxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LiteralSyntaxError"
  }
}

class Scanner {
  private pos: number

  constructor(private readonly src: string, start = 0) {
    this.pos = start
  }

  get index(): number {
    return this.pos
  }

  atEnd(): boolean {
    return this.pos >= this.src.length
  }

  fail(message: string): never {
    const line = this.src.slice(0, this.pos).split("\n").length
    throw new LiteralSyntaxError(`${message}（偏移 ${this.pos}，行 ${line}）`)
  }

  skipTrivia(): void {
    for (;;) {
      while (this.pos < this.src.length && /\s/.test(this.src[this.pos] ?? "")) this.pos++
      if (this.src.startsWith("//", this.pos)) {
        const nl = this.src.indexOf("\n", this.pos)
        this.pos = nl === -1 ? this.src.length : nl + 1
        continue
      }
      if (this.src.startsWith("/*", this.pos)) {
        const end = this.src.indexOf("*/", this.pos + 2)
        if (end === -1) this.fail("块注释未闭合")
        this.pos = end + 2
        continue
      }
      return
    }
  }

  peek(): string {
    const ch = this.src[this.pos]
    if (ch === undefined) this.fail("输入提前结束")
    return ch
  }

  /** 不消费地向前看：下一个 token 是否为标识符（getter 判别用） */
  peekIdentAhead(): boolean {
    let probe = this.pos
    while (probe < this.src.length && /\s/.test(this.src[probe] ?? "")) probe++
    return /[A-Za-z_$]/.test(this.src[probe] ?? "")
  }

  /** 若下一字符为 ch 则消费并返回 true */
  match(ch: string): boolean {
    this.skipTrivia()
    if (this.src[this.pos] === ch) {
      this.pos++
      return true
    }
    return false
  }

  expect(ch: string): void {
    this.skipTrivia()
    if (this.src[this.pos] !== ch) {
      this.fail(`期望「${ch}」，实际「${this.src[this.pos] ?? "EOF"}」`)
    }
    this.pos++
  }

  readIdentifier(): string {
    this.skipTrivia()
    const start = this.pos
    while (this.pos < this.src.length && /[A-Za-z0-9_$]/.test(this.src[this.pos] ?? "")) this.pos++
    if (this.pos === start) this.fail("期望标识符")
    return this.src.slice(start, this.pos)
  }

  /** 对象键：标识符或字符串（数字键目录里不出现，遇到报错） */
  readKey(): string {
    this.skipTrivia()
    const ch = this.peek()
    if (ch === '"' || ch === "'") return this.readString()
    if (/[A-Za-z_$]/.test(ch)) return this.readIdentifier()
    this.fail(`期望对象键，实际「${ch}」`)
  }

  readString(): string {
    this.skipTrivia()
    const quote = this.peek()
    if (quote !== '"' && quote !== "'") this.fail("期望字符串")
    this.pos++
    let out = ""
    for (;;) {
      const ch = this.src[this.pos]
      if (ch === undefined) this.fail("字符串未闭合")
      if (ch === quote) {
        this.pos++
        return out
      }
      if (ch === "\n") this.fail("字符串内出现裸换行（minified 代码不应出现）")
      if (ch !== "\\") {
        out += ch
        this.pos++
        continue
      }
      this.pos++
      const esc = this.src[this.pos]
      this.pos++
      if (esc === undefined) this.fail("字符串未闭合")
      switch (esc) {
        case "n": out += "\n"; break
        case "t": out += "\t"; break
        case "r": out += "\r"; break
        case "b": out += "\b"; break
        case "f": out += "\f"; break
        case "v": out += "\v"; break
        case "0": out += "\0"; break
        case "\n": break // 行接续
        case "x": out += this.readHex(2); break
        case "u":
          out += this.src[this.pos] === "{" ? this.readUnicodeCodePoint() : this.readHex(4)
          break
        default:
          // 与 JS 语义一致：未知转义即字符本身
          out += esc
      }
    }
  }

  private readHex(count: number): string {
    const start = this.pos
    this.pos += count
    return this.codePoint(this.src.slice(start, this.pos))
  }

  private readUnicodeCodePoint(): string {
    this.expect("{")
    const start = this.pos
    while (this.pos < this.src.length && this.src[this.pos] !== "}") this.pos++
    const hex = this.src.slice(start, this.pos)
    this.expect("}")
    return this.codePoint(hex)
  }

  private codePoint(hex: string): string {
    if (!/^[0-9a-fA-F]+$/.test(hex)) this.fail(`非法十六进制转义「${hex}」`)
    const code = Number.parseInt(hex, 16)
    if (!Number.isFinite(code)) this.fail(`非法码点「${hex}」`)
    return String.fromCodePoint(code)
  }

  readNumber(): number {
    this.skipTrivia()
    let text = ""
    if (this.src[this.pos] === "-") {
      text += "-"
      this.pos++
    }
    if (this.src.startsWith("0x", this.pos) || this.src.startsWith("0X", this.pos)) {
      this.pos += 2
      const start = this.pos
      while (this.pos < this.src.length && /[0-9a-fA-F]/.test(this.src[this.pos] ?? "")) this.pos++
      if (this.pos === start) this.fail("非法十六进制数字")
      text = `${text}0x${this.src.slice(start, this.pos)}`
    } else {
      const start = this.pos
      while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos] ?? "")) this.pos++
      if (this.src[this.pos] === ".") {
        this.pos++
        while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos] ?? "")) this.pos++
      }
      if (this.src[this.pos] === "e" || this.src[this.pos] === "E") {
        this.pos++
        if (this.src[this.pos] === "+" || this.src[this.pos] === "-") this.pos++
        const expStart = this.pos
        while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos] ?? "")) this.pos++
        if (this.pos === expStart) this.fail("非法指数")
      }
      if (this.pos === start) this.fail("期望数字")
      text += this.src.slice(start, this.pos)
    }
    const value = Number(text)
    if (!Number.isFinite(value)) this.fail(`非法数字「${text}」`)
    return value
  }

  /** 跳过一对已开括号的平衡区域；内容不解析（getter 函数体只配平、不执行） */
  skipBalanced(open: string, close: string): void {
    this.expect(open)
    let depth = 1
    let inString: string | undefined
    while (depth > 0) {
      const ch = this.src[this.pos]
      if (ch === undefined) this.fail("平衡区域未闭合")
      if (inString !== undefined) {
        if (ch === "\\") {
          this.pos += 2
          continue
        }
        if (ch === inString) inString = undefined
        this.pos++
        continue
      }
      if (ch === '"' || ch === "'") {
        inString = ch
        this.pos++
        continue
      }
      if (ch === open) depth++
      else if (ch === close) depth--
      this.pos++
    }
  }
}

/** 解析恰好一个完整的值（默认入口：整个输入必须是一个对象字面量） */
export function parseObjectText(text: string): Literal {
  const scanner = new Scanner(text)
  const value = parseValue(scanner)
  scanner.skipTrivia()
  if (!scanner.atEnd()) scanner.fail("对象之后仍有剩余内容")
  return value
}

/** 在 src 的 start 处解析一个值，返回值与结束位置（供引用求值、目录截取复用） */
export function parseValueAt(src: string, start: number): { literal: Literal; end: number } {
  const scanner = new Scanner(src, start)
  scanner.skipTrivia()
  const literal = parseValue(scanner)
  return { literal, end: scanner.index }
}

function parseValue(scanner: Scanner): Literal {
  scanner.skipTrivia()
  const ch = scanner.peek()
  switch (ch) {
    case "{":
      return parseObject(scanner)
    case "[":
      return parseArray(scanner)
    case '"':
    case "'":
      return { kind: "primitive", value: scanner.readString() }
    case "!": {
      // minify 布尔：仅接受 !0 / !1（即 true / false），其余一元表达式一律拒绝
      scanner.match("!")
      const num = scanner.readNumber()
      if (num === 0) return { kind: "primitive", value: true }
      if (num === 1) return { kind: "primitive", value: false }
      scanner.fail(`仅接受 !0 / !1，遇到 !${num}`)
      break
    }
    default: {
      if (/[0-9-]/.test(ch)) return { kind: "primitive", value: scanner.readNumber() }
      if (/[A-Za-z_$]/.test(ch)) {
        const ident = scanner.readIdentifier()
        if (ident === "true") return { kind: "primitive", value: true }
        if (ident === "false") return { kind: "primitive", value: false }
        if (ident === "null" || ident === "undefined") return { kind: "primitive", value: null }
        return { kind: "ref", name: ident }
      }
      scanner.fail(`值位置出现不可接受的字符「${ch}」`)
    }
  }
  throw new Error("unreachable")
}

function parseObject(scanner: Scanner): Literal {
  scanner.expect("{")
  const entries: Array<{ key: string; value: Literal }> = []
  for (;;) {
    scanner.skipTrivia()
    if (scanner.match("}")) break
    const key = scanner.readKey()
    // getter：get/set <名>(…){…}——只配平跳过，不产出属性
    if ((key === "get" || key === "set") && scanner.peekIdentAhead()) {
      scanner.readIdentifier() // 属性名
      scanner.skipBalanced("(", ")")
      scanner.skipBalanced("{", "}")
      if (scanner.match(",")) continue
      scanner.expect("}")
      break
    }
    // 方法简写 foo(…){…} 是代码不是数据：拒绝而非跳过
    scanner.skipTrivia()
    if (scanner.peek() === "(") scanner.fail("对象字面量中出现方法简写（疑似代码），拒绝解析")
    scanner.expect(":")
    const value = parseValue(scanner)
    entries.push({ key, value })
    if (scanner.match(",")) continue
    scanner.expect("}")
    break
  }
  return { kind: "object", entries }
}

function parseArray(scanner: Scanner): Literal {
  scanner.expect("[")
  const items: Literal[] = []
  for (;;) {
    scanner.skipTrivia()
    if (scanner.match("]")) break
    if (scanner.peek() === ".") scanner.fail("数组展开（spread）不是数据，拒绝解析")
    items.push(parseValue(scanner))
    if (scanner.match(",")) continue
    scanner.expect("]")
    break
  }
  return { kind: "array", items }
}

// —— 取值便捷函数：把 Literal 收窄为调用方要的数据形状 ——

export function asString(literal: Literal): string | undefined {
  return literal.kind === "primitive" && typeof literal.value === "string" ? literal.value : undefined
}

export function asNumber(literal: Literal): number | undefined {
  return literal.kind === "primitive" && typeof literal.value === "number" ? literal.value : undefined
}

export function asBoolean(literal: Literal): boolean | undefined {
  return literal.kind === "primitive" && typeof literal.value === "boolean" ? literal.value : undefined
}

export function asStringArray(literal: Literal): string[] | undefined {
  if (literal.kind !== "array") return undefined
  const out: string[] = []
  for (const item of literal.items) {
    const s = asString(item)
    if (s === undefined) return undefined
    out.push(s)
  }
  return out
}

/** 对象条目按 key 取值（后写覆盖先写，与 JS 对象语义一致） */
export function lastEntry(object: Extract<Literal, { kind: "object" }>, key: string): Literal | undefined {
  let found: Literal | undefined
  for (const entry of object.entries) {
    if (entry.key === key) found = entry.value
  }
  return found
}
