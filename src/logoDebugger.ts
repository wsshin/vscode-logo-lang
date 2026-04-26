// Copyright (c) 2026 Zion Nursery and Primary School, Kovaipudur
// SPDX-License-Identifier: MIT
// Logo Debugger interface
// Date: 20-April-2026

import * as fs from 'fs';
import * as path from 'path';
import {
  Token,
  ProcedureDef,
  TurtleState,
  DrawCommand,
  DEFAULT_TURTLE,
  tokenize,
  extractProcedures,
  findMatchingBracket,
  evalExpression,
  evalCondition,
  VariableLookup,
} from './logoInterpreter';

export { DrawCommand, TurtleState, Token, ProcedureDef } from './logoInterpreter';

export type StepMode = 'continue' | 'stepIn' | 'stepOver' | 'stepOut';

export interface CallFrameInfo {
  procedure: string;
  line: number;          // procedure's source-line-start (TO line)
  sourcePath: string;
}

interface ControlFrame {
  kind: 'repeat' | 'if' | 'ifelse' | 'proc' | 'load';
  savedTokens: Token[];
  savedIndex: number;
  // repeat
  iteration?: number;
  totalIterations?: number;
  // proc
  procedure?: string;
  sourceLineStart?: number;
  sourcePath?: string;
  callLine?: number;
  callSourcePath?: string;
  savedVars?: Map<string, number>;
  // load
  loadPath?: string;
}

export interface ExecutionSnapshot {
  currentLine: number;
  currentSourcePath: string;
  executionTokens: Token[];
  executionIndex: number;
  turtle: TurtleState;
  variables: Map<string, number>;
  drawCommandsCount: number;
  controlStack: ControlFrame[];
  pendingEntryPause: { line: number; sourcePath: string } | null;
}

const ANON_SOURCE = '<anonymous>';

function cloneFrame(f: ControlFrame): ControlFrame {
  return {
    kind: f.kind,
    savedTokens: f.savedTokens,
    savedIndex: f.savedIndex,
    iteration: f.iteration,
    totalIterations: f.totalIterations,
    procedure: f.procedure,
    sourceLineStart: f.sourceLineStart,
    sourcePath: f.sourcePath,
    callLine: f.callLine,
    callSourcePath: f.callSourcePath,
    savedVars: f.savedVars ? new Map(f.savedVars) : undefined,
    loadPath: f.loadPath,
  };
}

export class LogoRuntime implements VariableLookup {
  // Public-ish fields (some accessed via `as any` in tests)
  procedures = new Map<string, ProcedureDef>();
  executionTokens: Token[] = [];
  executionIndex = 0;
  stepMode: StepMode = 'continue';
  pauseRequested = false;
  lastSteppedLine = 0;

  private turtle: TurtleState = { ...DEFAULT_TURTLE };
  private variables = new Map<string, number>();
  private drawCommands: DrawCommand[] = [];
  private controlStack: ControlFrame[] = [];
  private breakpoints = new Map<string, Set<number>>();
  private history: ExecutionSnapshot[] = [];
  // Main-program tokens stashed at load time so execute() can restart after
  // completion/stop even if the last frame wasn't the top level.
  private mainTokens: Token[] = [];

  private currentLine = 0;
  private currentSourcePath = ANON_SOURCE;
  private mainSourcePath = ANON_SOURCE;
  private lastSteppedSourcePath = ANON_SOURCE;

  private stopped = false;
  private debugMode = false;
  private started = false;
  private lastPauseReason: 'breakpoint' | 'step' | 'entry' = 'entry';
  private pendingEntryPause: { line: number; sourcePath: string } | null = null;

  // Call-site metadata stack (captured at the moment of proc call, used when
  // reading call stack and when restoring state on stepBack).
  private loadStack: string[] = [];
  private loadedFiles = new Set<string>();

  private printCallback: ((msg: string) => void) | null = null;
  private stepCallback: (() => void) | null = null;

  get variablesMap(): Map<string, number> { return this.variables; }

  // ─── Public API ─────────────────────────────────────────────────────

  loadProgram(source: string, filePath?: string): void {
    this.mainSourcePath = filePath ? path.resolve(filePath) : ANON_SOURCE;
    this.currentSourcePath = this.mainSourcePath;
    this.lastSteppedSourcePath = this.mainSourcePath;

    const raw = tokenize(source, this.mainSourcePath);
    const { main, procedures } = extractProcedures(raw);
    this.procedures = procedures;
    this.mainTokens = main;
    this.breakpoints = new Map();
    this.loadedFiles = new Set();
    this.resetRuntimeState();

    if (filePath) {
      this.loadedFiles.add(this.mainSourcePath);
    }
  }

  private resetRuntimeState(): void {
    this.executionTokens = this.mainTokens;
    this.executionIndex = 0;
    this.turtle = { ...DEFAULT_TURTLE };
    this.variables = new Map();
    this.stringVars = new Map();
    this.drawCommands = [];
    this.controlStack = [];
    this.history = [];
    this.stopped = false;
    this.started = false;
    this.pauseRequested = false;
    this.currentLine = 0;
    this.currentSourcePath = this.mainSourcePath;
    this.lastSteppedLine = 0;
    this.lastSteppedSourcePath = this.mainSourcePath;
    this.pendingEntryPause = null;
    this.loadStack = [];
  }

  setDebugMode(enabled: boolean): void { this.debugMode = enabled; }
  setStepMode(mode: StepMode): void {
    this.stepMode = mode;
    if (mode !== 'continue') {
      this.debugMode = true;
      // Arm a single-step request so the next execute() pauses at the next
      // line change. Tests also set these directly; their assignments come
      // after this call and simply overwrite with the same values.
      this.pauseRequested = true;
      this.lastSteppedLine = this.currentLine;
      this.lastSteppedSourcePath = this.currentSourcePath;
    } else {
      this.pauseRequested = false;
    }
  }
  setPrintCallback(fn: (msg: string) => void): void { this.printCallback = fn; }
  setStepCallback(fn: () => void): void { this.stepCallback = fn; }

  setBreakpoints(lines: number[], filePath?: string): void {
    const sp = filePath ? path.resolve(filePath) : this.mainSourcePath;
    this.breakpoints.set(sp, new Set(lines));
    if (lines.length > 0) this.debugMode = true;
  }

  setSourceBreakpoints(map: Map<string, number[]>): void {
    this.breakpoints = new Map();
    for (const [p, lines] of map.entries()) {
      this.breakpoints.set(path.resolve(p), new Set(lines));
      if (lines.length > 0) this.debugMode = true;
    }
  }

  stop(): void { this.stopped = true; }

  tokenize(src: string, sourcePath?: string): Token[] {
    return tokenize(src, sourcePath);
  }

  get(name: string): number | undefined {
    return this.variables.get(name);
  }

  getVariables(): Map<string, number> { return this.variables; }

  getTurtleState(): TurtleState { return { ...this.turtle }; }

  getDrawCommands(): DrawCommand[] { return this.drawCommands; }

  getCurrentLine(): number { return this.currentLine; }

  getCurrentLocation(): { line: number; sourcePath: string } {
    return { line: this.currentLine, sourcePath: this.currentSourcePath };
  }

  getCallStack(): CallFrameInfo[] {
    const result: CallFrameInfo[] = [];
    for (let i = this.controlStack.length - 1; i >= 0; i--) {
      const f = this.controlStack[i];
      if (f.kind === 'proc') {
        result.push({
          procedure: f.procedure!,
          line: f.sourceLineStart!,
          sourcePath: f.sourcePath ?? this.mainSourcePath,
        });
      }
    }
    return result;
  }

  getLastPauseReason(): string {
    switch (this.lastPauseReason) {
      case 'breakpoint': return 'breakpoint';
      case 'step': return 'step';
      case 'entry': return 'entry';
    }
  }

  getExecutionHistory(): ExecutionSnapshot[] { return this.history; }

  restoreState(s: ExecutionSnapshot): void {
    this.currentLine = s.currentLine;
    this.currentSourcePath = s.currentSourcePath;
    this.executionTokens = s.executionTokens;
    this.executionIndex = s.executionIndex;
    this.turtle = { ...s.turtle };
    this.variables = new Map(s.variables);
    this.drawCommands.length = s.drawCommandsCount;
    this.controlStack = s.controlStack.map(cloneFrame);
    this.pendingEntryPause = s.pendingEntryPause ? { ...s.pendingEntryPause } : null;
    this.lastSteppedLine = s.currentLine;
    this.lastSteppedSourcePath = s.currentSourcePath;
  }

  // ─── Execution loop ─────────────────────────────────────────────────

  async execute(): Promise<boolean> {
    // Re-entrant restart: if the program has finished (ran to end or was
    // stopped) and execute() is called again, rewind to a fresh start.
    // Detect via structural state — not pauseRequested, which setStepMode
    // clears during resume/continue transitions.
    const finished = this.started && (
      this.stopped ||
      (this.executionIndex >= this.executionTokens.length && this.controlStack.length === 0)
    );
    if (finished) {
      this.resetRuntimeState();
    }
    this.started = true;
    const startingDepth = this.controlStack.length;

    while (true) {
      if (this.stopped) return true;

      // Pending proc-entry pseudo-pause: synthesizes a line-change at the
      // procedure's TO line before the first body token runs.
      if (this.pendingEntryPause) {
        const { line, sourcePath } = this.pendingEntryPause;
        this.pendingEntryPause = null;
        this.currentLine = line;
        this.currentSourcePath = sourcePath;
        if (this.debugMode) {
          this.pushSnapshot();
          if (this.shouldPauseAtCurrent(startingDepth)) {
            return this.emitPause();
          }
        }
        continue;
      }

      // End-of-frame handling
      if (this.executionIndex >= this.executionTokens.length) {
        if (this.controlStack.length === 0) {
          return true;
        }
        const top = this.controlStack[this.controlStack.length - 1];
        if (top.kind === 'repeat') {
          top.iteration!++;
          if (top.iteration! < top.totalIterations!) {
            this.executionIndex = 0;
            continue;
          }
        }
        if (top.kind === 'proc') {
          // Restore variable bindings that existed before the call
          this.variables = top.savedVars!;
        }
        if (top.kind === 'load' && top.loadPath) {
          // Pop from cyclic-detection stack; leaves loadedFiles intact.
          const idx = this.loadStack.lastIndexOf(top.loadPath);
          if (idx !== -1) this.loadStack.splice(idx, 1);
        }
        // Pop frame, restoring caller's tokens/index
        this.executionTokens = top.savedTokens;
        this.executionIndex = top.savedIndex;
        this.controlStack.pop();
        continue;
      }

      const token = this.executionTokens[this.executionIndex];
      const tokenLine = token.line;
      const tokenSourcePath = token.sourcePath ?? this.mainSourcePath;

      // Line transition → snapshot + pause check (only when debugging)
      if (tokenLine !== this.currentLine || tokenSourcePath !== this.currentSourcePath) {
        this.currentLine = tokenLine;
        this.currentSourcePath = tokenSourcePath;
        if (this.debugMode) {
          this.pushSnapshot();
          if (this.shouldPauseAtCurrent(startingDepth)) {
            return this.emitPause();
          }
        }
      }

      this.executeStatement();
    }
  }

  // ─── Pause / snapshot helpers ───────────────────────────────────────

  private pushSnapshot(): void {
    this.history.push({
      currentLine: this.currentLine,
      currentSourcePath: this.currentSourcePath,
      executionTokens: this.executionTokens,
      executionIndex: this.executionIndex,
      turtle: { ...this.turtle },
      variables: new Map(this.variables),
      drawCommandsCount: this.drawCommands.length,
      controlStack: this.controlStack.map(cloneFrame),
      pendingEntryPause: this.pendingEntryPause ? { ...this.pendingEntryPause } : null,
    });
  }

  private shouldPauseAtCurrent(startingDepth: number): boolean {
    // Breakpoint – always honoured.
    const bps = this.breakpoints.get(this.currentSourcePath);
    if (bps && bps.has(this.currentLine)) {
      this.lastPauseReason = 'breakpoint';
      return true;
    }

    if (!this.pauseRequested) return false;

    // Don't re-pause on the line we most recently stepped from.
    if (this.currentLine === this.lastSteppedLine &&
        this.currentSourcePath === this.lastSteppedSourcePath) {
      return false;
    }

    const depth = this.controlStack.length;
    switch (this.stepMode) {
      case 'continue': return false;
      case 'stepIn':
        this.lastPauseReason = 'step';
        return true;
      case 'stepOver':
        if (depth <= startingDepth) { this.lastPauseReason = 'step'; return true; }
        return false;
      case 'stepOut':
        if (depth < startingDepth) { this.lastPauseReason = 'step'; return true; }
        return false;
    }
    return false;
  }

  private emitPause(): boolean {
    this.lastSteppedLine = this.currentLine;
    this.lastSteppedSourcePath = this.currentSourcePath;
    if (this.stepCallback) this.stepCallback();
    return false;
  }

  // ─── Statement dispatcher ───────────────────────────────────────────

  private executeStatement(): void {
    const tok = this.executionTokens[this.executionIndex];
    const up = tok.value.toUpperCase();

    // Variable assignment:  :X = expr
    if (tok.value.startsWith(':') && this.peek(1) && this.peek(1)!.value === '=') {
      const name = tok.value.slice(1).toUpperCase();
      const { value, end } = evalExpression(this.executionTokens, this.executionIndex + 2, this);
      this.variables.set(name, value);
      this.executionIndex = end;
      return;
    }

    this.executionIndex++;

    switch (up) {
      case 'FD': case 'FORWARD': return this.doForward(+1);
      case 'BK': case 'BACK': case 'BACKWARD': return this.doForward(-1);
      case 'RT': case 'RIGHT': return this.doRotate(+1);
      case 'LT': case 'LEFT': return this.doRotate(-1);
      case 'SETH': case 'SETHEADING': {
        const { value, end } = evalExpression(this.executionTokens, this.executionIndex, this);
        this.executionIndex = end;
        this.turtle.angle = normalizeAngle(value);
        this.pushHeadingUpdate();
        return;
      }
      case 'PU': case 'PENUP': this.turtle.penDown = false; return;
      case 'PD': case 'PENDOWN': this.turtle.penDown = true; return;
      case 'HT': case 'HIDETURTLE':
        this.turtle.visible = false;
        this.drawCommands.push({ type: 'hideturtle' });
        return;
      case 'ST': case 'SHOWTURTLE':
        this.turtle.visible = true;
        this.drawCommands.push({ type: 'showturtle' });
        return;
      case 'FILL':
        return;
      case 'CS': case 'CLEARSCREEN':
        this.turtle = { ...DEFAULT_TURTLE };
        this.drawCommands.push({ type: 'reset' });
        return;
      case 'CLEAN':
        this.drawCommands.push({ type: 'clean' });
        return;
      case 'HOME': {
        const from = { x: this.turtle.x, y: this.turtle.y };
        this.turtle.x = 0;
        this.turtle.y = 0;
        this.turtle.angle = 0;
        this.drawCommands.push({
          type: this.turtle.penDown ? 'line' : 'move',
          from, to: { x: 0, y: 0 }, color: this.turtle.penColor, angle: 0,
        });
        return;
      }
      case 'SETPOS': return this.doSetPos();
      case 'SETPENCOLOR': case 'SETPC': return this.doSetPenColor();
      case 'ARC': return this.doArc();
      case 'REPEAT': return this.doRepeat();
      case 'IF': return this.doIf();
      case 'IFELSE': return this.doIfElse();
      case 'STOP': return this.doStop();
      case 'MAKE': return this.doMake();
      case 'PRINT': case 'PR': return this.doPrint();
      case 'LOAD': return this.doLoad();
      default:
        return this.doProcedureCall(tok);
    }
  }

  private peek(offset: number): Token | undefined {
    return this.executionTokens[this.executionIndex + offset];
  }

  private doForward(sign: 1 | -1): void {
    const { value, end } = evalExpression(this.executionTokens, this.executionIndex, this);
    this.executionIndex = end;
    const dist = sign * value;
    const rad = this.turtle.angle * Math.PI / 180;
    const from = { x: this.turtle.x, y: this.turtle.y };
    // Angle 0 = +y, clockwise positive.
    this.turtle.x += dist * Math.sin(rad);
    this.turtle.y += dist * Math.cos(rad);
    const to = { x: this.turtle.x, y: this.turtle.y };
    this.drawCommands.push({
      type: this.turtle.penDown ? 'line' : 'move',
      from, to, color: this.turtle.penColor, angle: this.turtle.angle,
    });
  }

  private doRotate(sign: 1 | -1): void {
    const { value, end } = evalExpression(this.executionTokens, this.executionIndex, this);
    this.executionIndex = end;
    this.turtle.angle = normalizeAngle(this.turtle.angle + sign * value);
    this.pushHeadingUpdate();
  }

  // Emit a zero-distance move so the webview picks up a heading change with
  // no position change (needed for RT/LT/SETH that aren't followed by FD/BK).
  private pushHeadingUpdate(): void {
    this.drawCommands.push({
      type: 'move',
      to: { x: this.turtle.x, y: this.turtle.y },
      angle: this.turtle.angle,
    });
  }

  private doSetPos(): void {
    // SETPOS [x y]
    if (this.executionTokens[this.executionIndex]?.value !== '[') {
      throw new Error(`SETPOS expects '[x y]' at line ${this.currentLine}`);
    }
    const openIdx = this.executionIndex;
    const closeIdx = findMatchingBracket(this.executionTokens, openIdx);
    const x = evalExpression(this.executionTokens, openIdx + 1, this);
    const y = evalExpression(this.executionTokens, x.end, this);
    this.executionIndex = closeIdx + 1;
    const from = { x: this.turtle.x, y: this.turtle.y };
    this.turtle.x = x.value;
    this.turtle.y = y.value;
    const to = { x: this.turtle.x, y: this.turtle.y };
    this.drawCommands.push({
      type: this.turtle.penDown ? 'line' : 'move',
      from, to, color: this.turtle.penColor, angle: this.turtle.angle,
    });
  }

  private doSetPenColor(): void {
    const t = this.executionTokens[this.executionIndex];
    if (!t) throw new Error('SETPENCOLOR expects 1 argument');
    if (t.value.startsWith('"')) {
      this.turtle.penColor = t.value.slice(1);
      this.executionIndex++;
      return;
    }
    const { value, end } = evalExpression(this.executionTokens, this.executionIndex, this);
    this.executionIndex = end;
    this.turtle.penColor = paletteColor(Math.round(value));
  }

  private doArc(): void {
    // ARC angle radius
    const a = evalExpression(this.executionTokens, this.executionIndex, this);
    const r = evalExpression(this.executionTokens, a.end, this);
    this.executionIndex = r.end;
    if (a.value === 0 || r.value === 0) return;

    const center = { x: this.turtle.x, y: this.turtle.y };
    const startAngle = this.turtle.angle;
    const segments = Math.max(1, Math.ceil(Math.abs(a.value) / 5));
    const stepAngle = a.value / segments;

    const pointOnArc = (angle: number): { x: number; y: number } => {
      const rad = angle * Math.PI / 180;
      return {
        x: center.x + r.value * Math.sin(rad),
        y: center.y + r.value * Math.cos(rad),
      };
    };

    let from = pointOnArc(startAngle);
    for (let i = 0; i < segments; i++) {
      const to = pointOnArc(startAngle + stepAngle * (i + 1));
      if (this.turtle.penDown) {
        this.drawCommands.push({
          type: 'line',
          from,
          to,
          color: this.turtle.penColor,
          angle: startAngle,
        });
      }
      from = to;
    }
    this.drawCommands.push({ type: 'move', to: center, angle: startAngle });
  }

  private doRepeat(): void {
    const { value: count, end } = evalExpression(this.executionTokens, this.executionIndex, this);
    this.executionIndex = end;
    const openIdx = this.executionIndex;
    if (this.executionTokens[openIdx]?.value !== '[') {
      throw new Error(`REPEAT expects '[' at line ${this.currentLine}`);
    }
    const closeIdx = findMatchingBracket(this.executionTokens, openIdx);
    const body = this.executionTokens.slice(openIdx + 1, closeIdx);
    this.executionIndex = closeIdx + 1;
    const n = Math.trunc(count);
    if (n <= 0) return;
    this.pushFrame({
      kind: 'repeat',
      savedTokens: this.executionTokens,
      savedIndex: this.executionIndex,
      iteration: 0,
      totalIterations: n,
    }, body);
  }

  private doIf(): void {
    const { value: cond, end } = evalCondition(this.executionTokens, this.executionIndex, this);
    this.executionIndex = end;
    const openIdx = this.executionIndex;
    if (this.executionTokens[openIdx]?.value !== '[') {
      throw new Error(`IF expects '[' at line ${this.currentLine}`);
    }
    const closeIdx = findMatchingBracket(this.executionTokens, openIdx);
    const body = this.executionTokens.slice(openIdx + 1, closeIdx);
    this.executionIndex = closeIdx + 1;
    if (cond) {
      this.pushFrame({
        kind: 'if',
        savedTokens: this.executionTokens,
        savedIndex: this.executionIndex,
      }, body);
    }
  }

  private doIfElse(): void {
    const { value: cond, end } = evalCondition(this.executionTokens, this.executionIndex, this);
    this.executionIndex = end;
    const trueOpen = this.executionIndex;
    if (this.executionTokens[trueOpen]?.value !== '[') {
      throw new Error(`IFELSE expects '[' at line ${this.currentLine}`);
    }
    const trueClose = findMatchingBracket(this.executionTokens, trueOpen);
    let falseOpen = trueClose + 1;
    if (this.executionTokens[falseOpen]?.value !== '[') {
      throw new Error(`IFELSE expects false-branch '[' at line ${this.currentLine}`);
    }
    const falseClose = findMatchingBracket(this.executionTokens, falseOpen);
    this.executionIndex = falseClose + 1;
    const body = cond
      ? this.executionTokens.slice(trueOpen + 1, trueClose)
      : this.executionTokens.slice(falseOpen + 1, falseClose);
    this.pushFrame({
      kind: 'ifelse',
      savedTokens: this.executionTokens,
      savedIndex: this.executionIndex,
    }, body);
  }

  private doStop(): void {
    // Unwind until we pop the innermost proc frame.
    while (this.controlStack.length > 0) {
      const top = this.controlStack[this.controlStack.length - 1];
      if (top.kind === 'proc') {
        this.variables = top.savedVars!;
        this.executionTokens = top.savedTokens;
        this.executionIndex = top.savedIndex;
        this.controlStack.pop();
        return;
      }
      this.executionTokens = top.savedTokens;
      this.executionIndex = top.savedIndex;
      this.controlStack.pop();
    }
    // At top level: jump past the remaining tokens.
    this.executionIndex = this.executionTokens.length;
  }

  private doMake(): void {
    const makeLine = this.currentLine;
    const nameTok = this.executionTokens[this.executionIndex];
    if (!nameTok || nameTok.line !== makeLine || !nameTok.value.startsWith('"')) {
      throw new Error(`MAKE expects first argument to be a quoted variable name at line ${makeLine}`);
    }
    const rawName = nameTok.value.slice(1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawName)) {
      throw new Error(`MAKE expects first argument to be a quoted variable name at line ${makeLine}`);
    }
    const name = rawName.toUpperCase();
    this.executionIndex++;
    const valueTok = this.executionTokens[this.executionIndex];
    if (!valueTok || valueTok.line !== makeLine) {
      throw new Error(`MAKE expects a value expression at line ${makeLine}`);
    }
    if (valueTok.value.startsWith('"')) {
      // String value (sidecar map, used e.g. by LOAD via :VAR).
      this.stringVars.set(name, valueTok.value.slice(1));
      this.executionIndex++;
      return;
    }
    const { value, end } = evalExpression(this.executionTokens, this.executionIndex, this);
    this.executionIndex = end;
    this.variables.set(name, value);
  }

  private doPrint(): void {
    const t = this.executionTokens[this.executionIndex];
    if (!t) {
      throw new Error('PRINT expects an argument');
    }
    if (t.value === '[') {
      // PRINT [data list] – literal words separated by spaces.
      const close = findMatchingBracket(this.executionTokens, this.executionIndex);
      const parts = this.executionTokens.slice(this.executionIndex + 1, close).map(tk => tk.value);
      this.executionIndex = close + 1;
      if (this.printCallback) this.printCallback(parts.join(' '));
      return;
    }
    if (t.value.startsWith('"')) {
      const s = t.value.slice(1);
      this.executionIndex++;
      if (this.printCallback) this.printCallback(s);
      return;
    }
    // Bare string variable: PRINT :S prints the stringVars entry if one exists
    // and no arithmetic operator follows. PRINT :S + 1 still falls through to
    // evalExpression (which will throw 'Undefined variable' for string-only vars).
    if (t.value.startsWith(':')) {
      const name = t.value.slice(1).toUpperCase();
      const s = this.stringVars.get(name);
      if (s !== undefined) {
        const next = this.executionTokens[this.executionIndex + 1];
        const followedByOp = next && next.line === t.line &&
          ['+', '-', '*', '/', '<', '>', '=', '<=', '>=', '<>'].includes(next.value);
        if (!followedByOp) {
          this.executionIndex++;
          if (this.printCallback) this.printCallback(s);
          return;
        }
      }
    }
    const { value, end } = evalExpression(this.executionTokens, this.executionIndex, this);
    this.executionIndex = end;
    if (this.printCallback) this.printCallback(String(value));
  }

  private stringVars = new Map<string, string>();

  private doLoad(): void {
    const loadLine = this.currentLine;
    const t = this.executionTokens[this.executionIndex];
    if (!t || t.line !== loadLine) {
      throw new Error(`LOAD expects a filename argument at line ${loadLine}`);
    }
    let target: string;
    if (t.value.startsWith('"')) {
      target = t.value.slice(1);
      this.executionIndex++;
    } else if (t.value.startsWith(':')) {
      const name = t.value.slice(1).toUpperCase();
      const s = this.stringVars.get(name);
      if (s === undefined || s.length === 0) {
        throw new Error(`LOAD variable ':${name}' must contain a filename`);
      }
      target = s;
      this.executionIndex++;
    } else {
      throw new Error(`LOAD expects a quoted filename or filename variable at line ${loadLine}`);
    }

    const next = this.executionTokens[this.executionIndex];
    if (next && next.line === loadLine) {
      throw new Error(`LOAD expects exactly 1 argument at line ${loadLine}`);
    }

    let resolved: string;
    if (path.isAbsolute(target)) {
      resolved = path.normalize(target);
    } else {
      const base = this.currentSourcePath;
      if (!base || base === ANON_SOURCE) {
        throw new Error('LOAD with a relative path requires a real source file path');
      }
      resolved = path.resolve(path.dirname(base), target);
    }

    if (this.loadStack.includes(resolved)) {
      const chain = [...this.loadStack, resolved].join(' -> ');
      throw new Error(`Cyclic LOAD detected: ${chain}`);
    }

    let src: string;
    try {
      src = fs.readFileSync(resolved, 'utf-8');
    } catch (e) {
      throw new Error(`LOAD failed: cannot read '${resolved}' (${(e as Error).message})`);
    }

    const loadedTokens = tokenize(src, resolved);
    const { main, procedures } = extractProcedures(loadedTokens, this.procedures);
    this.procedures = procedures;
    this.loadStack.push(resolved);
    this.loadedFiles.add(resolved);

    // Push a load frame so the loaded file's main tokens run "in place".
    this.controlStack.push({
      kind: 'load',
      savedTokens: this.executionTokens,
      savedIndex: this.executionIndex,
      loadPath: resolved,
    });
    this.executionTokens = main;
    this.executionIndex = 0;
  }

  private doProcedureCall(tok: Token): void {
    const name = tok.value.toUpperCase();
    const proc = this.procedures.get(name);
    if (!proc) {
      throw new Error(`Unknown procedure '${tok.value}' at line ${tok.line}`);
    }
    // Parse positional arguments.
    const args: number[] = [];
    for (let k = 0; k < proc.params.length; k++) {
      const { value, end } = evalExpression(this.executionTokens, this.executionIndex, this);
      args.push(value);
      this.executionIndex = end;
    }
    const savedVars = new Map(this.variables);
    for (let k = 0; k < proc.params.length; k++) {
      this.variables.set(proc.params[k], args[k]);
    }
    this.controlStack.push({
      kind: 'proc',
      savedTokens: this.executionTokens,
      savedIndex: this.executionIndex,
      procedure: proc.name,
      sourceLineStart: proc.sourceLineStart,
      sourcePath: proc.sourcePath,
      callLine: tok.line,
      callSourcePath: tok.sourcePath ?? this.mainSourcePath,
      savedVars,
    });
    this.executionTokens = proc.body;
    this.executionIndex = 0;
    // Schedule an entry pause at the TO line so stepIn surfaces there.
    this.pendingEntryPause = {
      line: proc.sourceLineStart,
      sourcePath: proc.sourcePath ?? this.mainSourcePath,
    };
  }

  // ─── Frame helpers ──────────────────────────────────────────────────

  private pushFrame(frame: ControlFrame, body: Token[]): void {
    this.controlStack.push(frame);
    this.executionTokens = body;
    this.executionIndex = 0;
  }
}

function normalizeAngle(a: number): number {
  const r = a % 360;
  return r < 0 ? r + 360 : r;
}

// A small 16-color palette by index for SETPENCOLOR numeric form.
const PALETTE = [
  '#000000', '#0000ff', '#00ff00', '#00ffff',
  '#ff0000', '#ff00ff', '#ffff00', '#ffffff',
  '#800000', '#808000', '#008000', '#008080',
  '#000080', '#800080', '#808080', '#c0c0c0',
];

function paletteColor(idx: number): string {
  if (idx < 0 || idx >= PALETTE.length) return '#000000';
  return PALETTE[idx];
}
