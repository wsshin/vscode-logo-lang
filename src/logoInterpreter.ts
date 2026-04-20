// Copyright (c) 2026 Zion Nursery and Primary School, Kovaipudur
// SPDX-License-Identifier: MIT
// Logo interpreter
// Date: 20-April-2026

export interface Position {
  x: number;
  y: number;
}

export interface DrawCommand {
  type: 'line' | 'move' | 'reset' | 'clean' | 'hideturtle' | 'showturtle';
  from?: Position;
  to?: Position;
  color?: string;
  angle?: number;
}

export interface TurtleState {
  x: number;
  y: number;
  angle: number;      // degrees, 0 = +y (up), CW positive
  penDown: boolean;
  penColor: string;
  visible: boolean;
}

export interface Token {
  value: string;
  line: number;       // 1-based
  column: number;     // 0-based
  sourcePath?: string;
}

export interface ProcedureDef {
  name: string;
  params: string[];
  body: Token[];
  sourceLineStart: number;
  sourcePath?: string;
}

export const DEFAULT_TURTLE: TurtleState = {
  x: 0,
  y: 0,
  angle: 0,
  penDown: true,
  penColor: '#000000',
  visible: true,
};

const SINGLE_OPS = new Set(['+', '-', '*', '/', '<', '>', '=', '(', ')', '[', ']']);
const MULTI_OPS = ['<=', '>=', '<>'];

export function tokenize(source: string, sourcePath?: string): Token[] {
  const tokens: Token[] = [];
  const lines = source.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === ';') break;
      if (/\s/.test(ch)) { i++; continue; }

      // Word literal "word (Logo-style; no closing quote)
      if (ch === '"') {
        let j = i + 1;
        while (j < line.length && !/[\s\[\]\(\)]/.test(line[j])) j++;
        tokens.push({ value: line.slice(i, j), line: li + 1, column: i, sourcePath });
        i = j;
        continue;
      }

      // Variable reference :VAR
      if (ch === ':') {
        let j = i + 1;
        while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++;
        tokens.push({ value: line.slice(i, j), line: li + 1, column: i, sourcePath });
        i = j;
        continue;
      }

      // Number (including leading decimal)
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(line[i + 1] || ''))) {
        let j = i;
        while (j < line.length && /[0-9.]/.test(line[j])) j++;
        tokens.push({ value: line.slice(i, j), line: li + 1, column: i, sourcePath });
        i = j;
        continue;
      }

      // Two-char operators
      const two = line.slice(i, i + 2);
      if (MULTI_OPS.includes(two)) {
        tokens.push({ value: two, line: li + 1, column: i, sourcePath });
        i += 2;
        continue;
      }

      if (SINGLE_OPS.has(ch)) {
        tokens.push({ value: ch, line: li + 1, column: i, sourcePath });
        i++;
        continue;
      }

      // Identifier
      if (/[A-Za-z_]/.test(ch)) {
        let j = i + 1;
        while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++;
        tokens.push({ value: line.slice(i, j), line: li + 1, column: i, sourcePath });
        i = j;
        continue;
      }

      // Unknown; skip.
      i++;
    }
  }
  return tokens;
}

// Extract procedure definitions. Returns the remaining "main" tokens (outside
// TO/END) together with a Map<UPPER_NAME, ProcedureDef>.
export function extractProcedures(
  tokens: Token[],
  existing?: Map<string, ProcedureDef>
): { main: Token[]; procedures: Map<string, ProcedureDef> } {
  const procedures = existing ?? new Map<string, ProcedureDef>();
  const main: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.value.toUpperCase() === 'TO') {
      const startLine = t.line;
      const sourcePath = t.sourcePath;
      i++;
      if (i >= tokens.length) throw new Error(`Missing procedure name after TO at line ${startLine}`);
      const name = tokens[i].value.toUpperCase();
      i++;
      const params: string[] = [];
      while (i < tokens.length &&
             tokens[i].value.startsWith(':') &&
             tokens[i].line === startLine) {
        params.push(tokens[i].value.slice(1).toUpperCase());
        i++;
      }
      const body: Token[] = [];
      let depth = 1;
      while (i < tokens.length) {
        const v = tokens[i].value.toUpperCase();
        if (v === 'TO') depth++;
        else if (v === 'END') {
          depth--;
          if (depth === 0) { i++; break; }
        }
        body.push(tokens[i]);
        i++;
      }
      procedures.set(name, { name, params, body, sourceLineStart: startLine, sourcePath });
      continue;
    }
    main.push(t);
    i++;
  }
  return { main, procedures };
}

// Find the matching ']' for the '[' at startBracket. Throws if unclosed.
export function findMatchingBracket(tokens: Token[], startBracket: number): number {
  let depth = 1;
  for (let i = startBracket + 1; i < tokens.length; i++) {
    if (tokens[i].value === '[') depth++;
    else if (tokens[i].value === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Unclosed '[' at line ${tokens[startBracket].line}`);
}

// ─── Expression evaluator ─────────────────────────────────────────────
// Each function returns { value, end } where `end` is the index AFTER the
// last consumed token.

export interface VariableLookup {
  get(name: string): number | undefined;
}

export function evalExpression(
  tokens: Token[],
  start: number,
  vars: VariableLookup
): { value: number; end: number } {
  let { value: left, end: i } = evalTerm(tokens, start, vars);
  while (i < tokens.length) {
    const op = tokens[i].value;
    if (op !== '+' && op !== '-') break;
    const { value: right, end: j } = evalTerm(tokens, i + 1, vars);
    left = op === '+' ? left + right : left - right;
    i = j;
  }
  return { value: left, end: i };
}

function evalTerm(tokens: Token[], start: number, vars: VariableLookup): { value: number; end: number } {
  let { value: left, end: i } = evalFactor(tokens, start, vars);
  while (i < tokens.length) {
    const op = tokens[i].value;
    if (op !== '*' && op !== '/') break;
    const { value: right, end: j } = evalFactor(tokens, i + 1, vars);
    left = op === '*' ? left * right : left / right;
    i = j;
  }
  return { value: left, end: i };
}

function evalFactor(tokens: Token[], start: number, vars: VariableLookup): { value: number; end: number } {
  if (start < tokens.length) {
    const v = tokens[start].value;
    if (v === '-') {
      const { value, end } = evalFactor(tokens, start + 1, vars);
      return { value: -value, end };
    }
    if (v === '+') {
      return evalFactor(tokens, start + 1, vars);
    }
  }
  return evalAtom(tokens, start, vars);
}

function evalAtom(tokens: Token[], start: number, vars: VariableLookup): { value: number; end: number } {
  if (start >= tokens.length) {
    throw new Error('Unexpected end of expression');
  }
  const t = tokens[start];
  if (t.value === '(') {
    const { value, end } = evalExpression(tokens, start + 1, vars);
    if (end >= tokens.length || tokens[end].value !== ')') {
      throw new Error(`Missing ')' starting at line ${t.line}`);
    }
    return { value, end: end + 1 };
  }
  if (t.value.startsWith(':')) {
    const name = t.value.slice(1).toUpperCase();
    const v = vars.get(name);
    if (v === undefined) {
      throw new Error(`Undefined variable :${name} at line ${t.line}`);
    }
    return { value: v, end: start + 1 };
  }
  const up = t.value.toUpperCase();
  if (up === 'RANDOM') {
    const { value, end } = evalAtom(tokens, start + 1, vars);
    return { value: value > 0 ? Math.floor(Math.random() * value) : 0, end };
  }
  if (up === 'INT') {
    const { value, end } = evalFactor(tokens, start + 1, vars);
    return { value: Math.trunc(value), end };
  }
  if (up === 'REMAINDER') {
    const a = evalFactor(tokens, start + 1, vars);
    const b = evalFactor(tokens, a.end, vars);
    // Guard div-by-zero (JS `%` returns NaN) and use truncation formula so
    // negative inputs match the reference computeRemainder exactly.
    const r = b.value === 0 ? 0 : a.value - Math.trunc(a.value / b.value) * b.value;
    return { value: r, end: b.end };
  }
  const n = Number(t.value);
  if (!Number.isNaN(n)) {
    return { value: n, end: start + 1 };
  }
  throw new Error(`Expected number, variable, or '(' at line ${t.line}, got '${t.value}'`);
}

export function evalCondition(
  tokens: Token[],
  start: number,
  vars: VariableLookup
): { value: boolean; end: number } {
  const { value: left, end: i } = evalExpression(tokens, start, vars);
  if (i < tokens.length) {
    const op = tokens[i].value;
    if (op === '<' || op === '>' || op === '=' || op === '<=' || op === '>=' || op === '<>') {
      const { value: right, end: j } = evalExpression(tokens, i + 1, vars);
      switch (op) {
        case '<': return { value: left < right, end: j };
        case '>': return { value: left > right, end: j };
        case '=': return { value: left === right, end: j };
        case '<=': return { value: left <= right, end: j };
        case '>=': return { value: left >= right, end: j };
        case '<>': return { value: left !== right, end: j };
      }
    }
  }
  return { value: left !== 0, end: i };
}
