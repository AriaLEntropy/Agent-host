/**
 * 最小 JSON5 解析器。
 *
 * Ported from botbus-protocol/Sources/BotBusConnectors/OpenClaw/OpenClawConfig.swift
 * (`normalizedJSON5` / `parseObject`) and OpenClaw's own config parser
 * (Apache-2.0). Behaviour-preserving TypeScript port for Agent-host.
 *
 * 上游的做法是先把 JSON5 归一化成标准 JSON 再交给 JSONSerialization；Node 没有
 * JSON5 内置解析，又不能再加依赖，所以这里直接写一个递归下降解析器。覆盖用户
 * 手改 `openclaw.json` 时最常见、也是上游明确支持的写法：
 *
 * - `//` 与 `/* *\/` 注释（字符串里的 `//` 不受影响）；
 * - 尾逗号；
 * - 单引号字符串、`\'` / `\"` / `\xNN` / `\uNNNN` 等转义、反斜杠换行续行；
 * - 不带引号的键（含 `$` / `_` / Unicode 标识符）；
 * - JSON5 的数字写法：正负号、十六进制、`Infinity`、`NaN`、`.5`。
 *
 * 不支持的冷门语法直接抛 `Json5Error`；调用方（配置读取）一律退回默认值，
 * 与上游"解析失败不抛错"的语义一致。
 */

export class Json5Error extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message}（位置 ${position}）`);
    this.name = "Json5Error";
  }
}

const IDENTIFIER_START = /[$_\p{ID_Start}]/u;
const IDENTIFIER_PART = /[$_‌‍\p{ID_Continue}]/u;
const WHITESPACE = /[\s﻿]/u;
const HEX = /^[0-9a-fA-F]+$/;
const DECIMAL = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const DIGIT = /[0-9]/;

/** 解析一段 JSON5 文本。根可以是对象、数组或任意 JSON5 值。 */
export function parseJson5(text: string): unknown {
  let index = 0;

  const fail: (message: string, at?: number) => never = (message, at = index) => {
    throw new Json5Error(message, at);
  };

  const skipWhitespace = () => {
    while (index < text.length) {
      const char = text[index];
      if (WHITESPACE.test(char)) {
        index += 1;
        continue;
      }
      if (char === "/" && text[index + 1] === "/") {
        index += 2;
        while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index += 1;
        continue;
      }
      if (char === "/" && text[index + 1] === "*") {
        const start = index;
        index += 2;
        while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
        if (index >= text.length) fail("块注释没有结束", start);
        index += 2;
        continue;
      }
      break;
    }
  };

  const parseString = (): string => {
    const quote = text[index];
    index += 1;
    let output = "";
    while (index < text.length) {
      const char = text[index];
      if (char === quote) {
        index += 1;
        return output;
      }
      if (char === "\\") {
        index += 1;
        const escaped = text[index];
        if (escaped === undefined) fail("字符串在转义符后结束");
        if (escaped === "\n") {
          index += 1;
          continue;
        }
        if (escaped === "\r") {
          index += 1;
          if (text[index] === "\n") index += 1;
          continue;
        }
        if (escaped === "u") {
          const hex = text.slice(index + 1, index + 5);
          if (!HEX.test(hex) || hex.length !== 4) fail("\\u 转义后面要跟四位十六进制", index);
          output += String.fromCharCode(Number.parseInt(hex, 16));
          index += 5;
          continue;
        }
        if (escaped === "x") {
          const hex = text.slice(index + 1, index + 3);
          if (!HEX.test(hex) || hex.length !== 2) fail("\\x 转义后面要跟两位十六进制", index);
          output += String.fromCharCode(Number.parseInt(hex, 16));
          index += 3;
          continue;
        }
        if (escaped === "0" && !DIGIT.test(text[index + 1] ?? "")) {
          output += "\0";
          index += 1;
          continue;
        }
        const simple = SIMPLE_ESCAPES[escaped];
        if (simple === undefined) fail(`不认识的转义 \\${escaped}`);
        output += simple;
        index += 1;
        continue;
      }
      if (char === "\n" || char === "\r" || char === " " || char === " ") {
        fail("字符串里不能直接换行（要换行请写 \\\\ 续行）");
      }
      output += char;
      index += 1;
    }
    return fail("字符串没有结束");
  };

  const parseNumber = (): number => {
    let sign = 1;
    if (text[index] === "+" || text[index] === "-") {
      if (text[index] === "-") sign = -1;
      index += 1;
    }
    if (text.startsWith("Infinity", index)) {
      index += "Infinity".length;
      return sign * Number.POSITIVE_INFINITY;
    }
    if (text.startsWith("NaN", index)) {
      index += "NaN".length;
      return Number.NaN;
    }
    if (text[index] === "0" && (text[index + 1] === "x" || text[index + 1] === "X")) {
      const start = index + 2;
      let end = start;
      while (end < text.length && /[0-9a-fA-F]/.test(text[end])) end += 1;
      if (end === start) fail("十六进制数缺少数字", start);
      const value = Number.parseInt(text.slice(start, end), 16);
      index = end;
      return sign * value;
    }
    const match = DECIMAL.exec(text.slice(index));
    if (!match) fail("不是合法的数字");
    index += match[0].length;
    return sign * Number(match[0]);
  };

  const parseIdentifier = (): string => {
    const start = index;
    if (!IDENTIFIER_START.test(text[index] ?? "")) fail("这里应该是一个键");
    index += 1;
    while (index < text.length && IDENTIFIER_PART.test(text[index])) index += 1;
    return text.slice(start, index);
  };

  const parseKey = (): string => {
    const char = text[index];
    if (char === "\"" || char === "'") return parseString();
    if (char !== undefined && (DIGIT.test(char) || char === "+" || char === "-" || char === ".")) {
      return String(parseNumber());
    }
    return parseIdentifier();
  };

  const parseObject = (): Record<string, unknown> => {
    index += 1; // {
    const output: Record<string, unknown> = {};
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return output;
    }
    while (true) {
      skipWhitespace();
      if (index >= text.length) fail("对象没有结束");
      const key = parseKey();
      skipWhitespace();
      if (text[index] !== ":") fail("键后面应该是冒号");
      index += 1;
      skipWhitespace();
      const value = parseValue();
      defineKey(output, key, value);
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return output; // 尾逗号
        }
        continue;
      }
      if (text[index] === "}") {
        index += 1;
        return output;
      }
      fail("对象里缺少逗号或右花括号");
    }
  };

  const parseArray = (): unknown[] => {
    index += 1; // [
    const output: unknown[] = [];
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return output;
    }
    while (true) {
      skipWhitespace();
      if (index >= text.length) fail("数组没有结束");
      output.push(parseValue());
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return output; // 尾逗号
        }
        continue;
      }
      if (text[index] === "]") {
        index += 1;
        return output;
      }
      fail("数组里缺少逗号或右方括号");
    }
  };

  const parseValue = (): unknown => {
    skipWhitespace();
    const char = text[index];
    if (char === undefined) fail("意外结束");
    if (char === "{" ) return parseObject();
    if (char === "[") return parseArray();
    if (char === "\"" || char === "'") return parseString();
    if (char === "t" && text.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (char === "f" && text.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (char === "n" && text.startsWith("null", index)) {
      index += 4;
      return null;
    }
    if (DIGIT.test(char) || char === "+" || char === "-" || char === ".") return parseNumber();
    if (IDENTIFIER_START.test(char)) {
      const word = parseIdentifier();
      if (word === "Infinity") return Number.POSITIVE_INFINITY;
      if (word === "NaN") return Number.NaN;
      return fail(`不认识的值 ${word}`);
    }
    return fail(`不认识的字符 ${char}`);
  };

  skipWhitespace();
  if (index >= text.length) fail("空文本");
  const value = parseValue();
  skipWhitespace();
  if (index < text.length) fail("根值后面还有内容");
  return value;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "'": "'",
  "\"": "\"",
  "\\": "\\",
  "/": "/",
};

/** `__proto__` 不能走普通赋值，否则会改掉对象的原型。 */
function defineKey(target: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
