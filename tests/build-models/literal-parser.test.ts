import { describe, expect, test } from "bun:test"
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  lastEntry,
  LiteralSyntaxError,
  parseObjectText,
  parseValueAt,
} from "../../scripts/build-models/literal-parser.ts"

describe("对象字面量子集解析器（构建侧不执行包内代码的结构保证）", () => {
  test("基础形状：嵌套对象 / 数组 / 字符串 / 数字 / !0 !1 / null", () => {
    const literal = parseObjectText(String.raw`{A:{id:"x",reasoning:!0,off:!1,n:1e6,hex:0x10,neg:-3,arr:["a","b"],nothing:null}}`)
    expect(literal.kind).toBe("object")
    if (literal.kind !== "object") return
    const inner = lastEntry(literal, "A")!
    expect(inner?.kind).toBe("object")
    if (inner?.kind !== "object") return
    expect(asString(lastEntry(inner, "id")!)).toBe("x")
    expect(asBoolean(lastEntry(inner, "reasoning")!)).toBe(true)
    expect(asBoolean(lastEntry(inner, "off")!)).toBe(false)
    expect(asNumber(lastEntry(inner, "n")!)).toBe(1_000_000)
    expect(asNumber(lastEntry(inner, "hex")!)).toBe(16)
    expect(asNumber(lastEntry(inner, "neg")!)).toBe(-3)
    expect(asStringArray(lastEntry(inner, "arr")!)).toEqual(["a", "b"])
    expect(lastEntry(inner, "nothing")!).toEqual({ kind: "primitive", value: null })
  })

  test("字符串转义：单双引号、\\n、\\uXXXX、\\u{...}、未知转义取字符本身", () => {
    const literal = parseObjectText(`{s1:"a\\nb",s2:'单引号',s3:"\\u4e2d",s4:"\\u{1F600}",s5:"\\d"}`)
    expect(literal.kind).toBe("object")
    if (literal.kind !== "object") return
    expect(asString(lastEntry(literal, "s1")!)).toBe("a\nb")
    expect(asString(lastEntry(literal, "s2")!)).toBe("单引号")
    expect(asString(lastEntry(literal, "s3")!)).toBe("中")
    expect(asString(lastEntry(literal, "s4")!)).toBe("😀")
    expect(asString(lastEntry(literal, "s5")!)).toBe("d")
  })

  test("标识符引用解析为 ref 节点，不在此层求值", () => {
    const literal = parseObjectText(`{provider:NR,spec:QR,chain:YR}`)
    expect(literal.kind).toBe("object")
    if (literal.kind !== "object") return
    expect(lastEntry(literal, "provider")!).toEqual({ kind: "ref", name: "NR" })
    expect(lastEntry(literal, "chain")!).toEqual({ kind: "ref", name: "YR" })
  })

  test("getter 只配平跳过：属性不产出、函数体内容不解析", () => {
    // 函数体里塞进解析器拒绝的形状（调用、花括号、字符串含花括号），只要配平就应静默跳过
    const literal = parseObjectText(`{id:"x",get hidden(){return isEnded(Foo.bar,{a:"}"})},n:1}`)
    expect(literal.kind).toBe("object")
    if (literal.kind !== "object") return
    expect(lastEntry(literal, "id")!).toEqual({ kind: "primitive", value: "x" })
    expect(lastEntry(literal, "hidden")!).toBeUndefined()
    expect(asNumber(lastEntry(literal, "n")!)).toBe(1)
  })

  test("尾随逗号与注释容忍；键可以是字符串", () => {
    const literal = parseObjectText(`{id:"x",/* 块注释 */"key with space":1,} // 行注释`)
    expect(literal.kind).toBe("object")
    if (literal.kind !== "object") return
    expect(asNumber(lastEntry(literal, "key with space")!)).toBe(1)
  })

  test("拒绝：方法简写（代码不是数据）", () => {
    expect(() => parseObjectText(`{id:"x",label(){return 1}}`)).toThrow(LiteralSyntaxError)
  })

  test("拒绝：值位置函数调用 / 箭头函数 / 模板串 / 二元运算 / 数组展开", () => {
    expect(() => parseObjectText(`{a:foo()}`)).toThrow(LiteralSyntaxError)
    expect(() => parseObjectText(String.raw`{a:()=>1}`)).toThrow(LiteralSyntaxError)
    expect(() => parseObjectText("{a:`tpl`}")).toThrow(LiteralSyntaxError)
    expect(() => parseObjectText(`{a:1+2}`)).toThrow(LiteralSyntaxError)
    expect(() => parseObjectText(`{a:[...b]}`)).toThrow(LiteralSyntaxError)
    expect(() => parseObjectText(`{a:!2}`)).toThrow(LiteralSyntaxError)
    expect(() => parseObjectText(`{a:new Date()}`)).toThrow(LiteralSyntaxError)
  })

  test("拒绝：对象之后剩余内容 / 未闭合 / 裸换行进字符串", () => {
    expect(() => parseObjectText(`{a:1} garbage`)).toThrow(LiteralSyntaxError)
    expect(() => parseObjectText(`{a:1`)).toThrow(LiteralSyntaxError)
    expect(() => parseObjectText(`{a:"多\n行"}`)).toThrow(LiteralSyntaxError)
  })

  test("parseValueAt：从任意偏移解析值并报告结束位置", () => {
    const src = `var X="hello",Y={n:1};`
    const stringStart = src.indexOf('"')
    const parsed = parseValueAt(src, stringStart)
    expect(parsed.literal).toEqual({ kind: "primitive", value: "hello" })
    expect(src.slice(parsed.end)).toBe(`,Y={n:1};`)
  })
})
