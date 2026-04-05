// Logo Runtime - implements the Logo language interpreter
import * as fs from 'fs';
import * as path from 'path';

class StopException extends Error {
  constructor() {
    super('STOP');
    this.name = 'StopException';
  }
}

class PauseException extends Error {
  constructor() {
    super('PAUSE');
    this.name = 'PauseException';
  }
}

export interface TurtleState {
  x: number;
  y: number;
  angle: number;
  penDown: boolean;
  penColor: string;
  visible: boolean;
}

export interface DrawCommand {
  type: 'reset' | 'line' | 'move' | 'clean' | 'hideturtle' | 'showturtle';
  from?: { x: number; y: number };
  to?: { x: number; y: number };
  color?: string;
  angle?: number;
}

export type LogoValue = number | string;

export interface LogoToken {
  value: string;
  line: number;
  sourcePath: string;
}

export interface LogoProcedure {
  name: string;
  params: string[];
  body: LogoToken[];
  sourcePath: string;
  sourceLineStart: number;
  sourceLineEnd: number;
}

export interface ExecutionState {
  turtle: TurtleState;
  variables: Map<string, LogoValue>;
  drawCommands: DrawCommand[];
  callStack: Array<{ procedure: string; line: number; vars: Map<string, LogoValue>; sourcePath: string }>;
  currentLine: number;
  executionIndex: number;
}

export type StepMode = 'continue' | 'stepOver' | 'stepIn' | 'stepOut' | null;

export class LogoRuntime {
  private static readonly MEMORY_SOURCE_PATH = '<memory>';

  private turtle: TurtleState = {
    x: 0,
    y: 0,
    angle: 0,
    penDown: true,
    penColor: '#000000',
    visible: true
  };

  private procedures: Map<string, LogoProcedure> = new Map();
  private variables: Map<string, LogoValue> = new Map();
  private callStack: Array<{ procedure: string; line: number; vars: Map<string, LogoValue>; sourcePath: string }> = [];
  private drawCommands: DrawCommand[] = [];
  private sourceLines: string[] = [];
  private rootSourcePath: string = LogoRuntime.MEMORY_SOURCE_PATH;
  private currentLine: number = 0;
  private stopExecution: boolean = false;
  private breakpoints: Set<number> = new Set();
  private stepMode: StepMode = null;
  private stepStartCallStackDepth: number = 0;
  private executionHistory: ExecutionState[] = [];
  private maxHistorySize: number = 1000;
  private onStepCallback?: () => void;
  private onPrintCallback?: (message: string) => void;
  private pauseRequested: boolean = false;
  private executionTokens: LogoToken[] = [];
  private executionIndex: number = 0;
  private justResumed: boolean = false;
  private lastSteppedLine: number = -1;
  private insideSingleLineBlock: boolean = false;
  private debugMode: boolean = false;
  private opaqueExecutionDepth: number = 0;
  private activeLoadStack: string[] = [];

  constructor() {}

  public loadProgram(source: string, rootFilePath?: string): void {
    this.sourceLines = source.split('\n');
    this.rootSourcePath = this.normalizeSourcePath(rootFilePath);
    this.procedures.clear();
    this.variables.clear();
    this.callStack = [];
    this.drawCommands = [];
    this.executionHistory = [];
    this.activeLoadStack = [];
    this.resetTurtle();
    this.parse(source, this.rootSourcePath);
  }

  private resetTurtle(): void {
    this.turtle = {
      x: 0,
      y: 0,
      angle: 0,
      penDown: true,
      penColor: '#000000',
      visible: true
    };
  }

  public getDrawCommands(): DrawCommand[] {
    return this.drawCommands;
  }

  public getTurtleState(): TurtleState {
    return { ...this.turtle };
  }

  public getCurrentLine(): number {
    return this.currentLine;
  }

  public getCallStack(): Array<{ procedure: string; line: number }> {
    return this.callStack
      .filter(frame => frame.sourcePath === this.rootSourcePath)
      .map(frame => ({
        procedure: frame.procedure,
        line: frame.line
      }))
      .reverse();
  }

  public getVariables(): Map<string, LogoValue> {
    return new Map(this.variables);
  }

  public setBreakpoints(lines: number[]): void {
    this.breakpoints = new Set(lines);
  }

  public setStepMode(mode: StepMode): void {
    this.stepMode = mode;
    this.stepStartCallStackDepth = this.callStack.length;
  }

  public setStepCallback(callback: () => void): void {
    this.onStepCallback = callback;
  }

  public setPrintCallback(callback: (message: string) => void): void {
    this.onPrintCallback = callback;
  }

  public setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  public getExecutionHistory(): ExecutionState[] {
    return this.executionHistory;
  }

  public restoreState(state: ExecutionState): void {
    this.turtle = { ...state.turtle };
    this.variables = new Map(state.variables);
    this.drawCommands = [...state.drawCommands];
    this.callStack = state.callStack.map(frame => ({
      procedure: frame.procedure,
      line: frame.line,
      vars: new Map(frame.vars),
      sourcePath: frame.sourcePath
    }));
    this.currentLine = state.currentLine;
    this.executionIndex = state.executionIndex;
    // Reset lastSteppedLine so step over/in/out work correctly after stepping back
    this.lastSteppedLine = -1;
  }

  private saveExecutionState(): void {
    const state: ExecutionState = {
      turtle: { ...this.turtle },
      variables: new Map(this.variables),
      drawCommands: [...this.drawCommands],
      callStack: this.callStack.map(frame => ({
        procedure: frame.procedure,
        line: frame.line,
        vars: new Map(frame.vars),
        sourcePath: frame.sourcePath
      })),
      currentLine: this.currentLine,
      executionIndex: this.executionIndex
    };

    this.executionHistory.push(state);

    // Limit history size
    if (this.executionHistory.length > this.maxHistorySize) {
      this.executionHistory.shift();
    }
  }

  private normalizeSourcePath(filePath?: string): string {
    if (!filePath) {
      return LogoRuntime.MEMORY_SOURCE_PATH;
    }

    return path.resolve(filePath);
  }

  private hasRealSourcePath(sourcePath: string): boolean {
    return sourcePath !== LogoRuntime.MEMORY_SOURCE_PATH;
  }

  private isOpaqueDebugExecution(): boolean {
    return this.debugMode && this.opaqueExecutionDepth > 0;
  }

  private shouldTrackVisibleDebugState(sourcePath: string): boolean {
    return !this.debugMode || (!this.isOpaqueDebugExecution() && sourcePath === this.rootSourcePath);
  }

  private saveExecutionStateIfVisible(sourcePath: string): void {
    if (this.shouldTrackVisibleDebugState(sourcePath)) {
      this.saveExecutionState();
    }
  }

  private shouldPauseAtLine(sourcePath: string): boolean {
    if (!this.shouldTrackVisibleDebugState(sourcePath)) {
      return false;
    }

    const shouldPauseForBreakpoint = this.breakpoints.has(this.currentLine) &&
      (!this.justResumed || this.currentLine !== this.lastSteppedLine);
    const shouldPauseForStepMode = !this.justResumed && this.shouldPauseForStepMode();
    return shouldPauseForBreakpoint || shouldPauseForStepMode;
  }

  private async runOpaqueIfNeeded<T>(opaque: boolean, fn: () => Promise<T>): Promise<T> {
    if (!opaque) {
      return fn();
    }

    const previousLine = this.currentLine;
    this.opaqueExecutionDepth++;
    try {
      return await fn();
    } finally {
      this.opaqueExecutionDepth = Math.max(0, this.opaqueExecutionDepth - 1);
      this.currentLine = previousLine;
    }
  }

  private shouldPause(): boolean {
    if (this.isOpaqueDebugExecution()) {
      return false;
    }

    // Never pause if we're inside a single-line block
    if (this.insideSingleLineBlock) {
      return false;
    }

    // Check breakpoint
    if (this.breakpoints.has(this.currentLine)) {
      return true;
    }

    return this.shouldPauseForStepMode();
  }

  private shouldPauseForStepMode(): boolean {
    // Check step mode
    if (this.stepMode === 'stepOver') {
      // Pause if we're at the same or shallower call stack depth AND on a different line
      return this.callStack.length <= this.stepStartCallStackDepth &&
             this.currentLine !== this.lastSteppedLine;
    } else if (this.stepMode === 'stepIn') {
      // Always pause on next line (not on same line)
      return this.currentLine !== this.lastSteppedLine;
    } else if (this.stepMode === 'stepOut') {
      // Pause when we return to a shallower call stack
      return this.callStack.length < this.stepStartCallStackDepth;
    }

    return false;
  }

  private async pauseExecution(): Promise<void> {
    // Clear step mode (it's been completed)
    this.stepMode = null;
    this.lastSteppedLine = this.currentLine; // Remember where we paused
    if (this.onStepCallback) {
      this.onStepCallback();
    }
    // Return immediately - the debug adapter will control continuation
  }

  private parse(source: string, sourcePath: string): void {
    const tokens = this.tokenize(source, sourcePath);
    let i = 0;

    while (i < tokens.length) {
      if (tokens[i].value.toUpperCase() === 'TO') {
        const result = this.parseProcedure(tokens, i);
        this.procedures.set(result.procedure.name.toUpperCase(), result.procedure);
        i = result.nextIndex;
      } else {
        i++;
      }
    }
  }

  private tokenize(source: string, sourcePath: string = this.rootSourcePath): LogoToken[] {
    const tokens: LogoToken[] = [];
    const lines = source.split('\n');

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      let line = lines[lineNum];

      // Remove comments
      const commentIndex = line.indexOf(';');
      if (commentIndex !== -1) {
        line = line.substring(0, commentIndex);
      }

      line = line.trim();
      if (!line) continue;

      // First split on spaces, brackets, and parentheses
      const parts = line.match(/:[A-Za-z_][A-Za-z0-9_]*|"[^\s\[\]\(\)]*|\(|\)|\[|\]|[^\s\[\]\(\)]+/g) || [];

      for (const part of parts) {
        // If it's not a variable or string, further split on operators
        if (!part.startsWith(':') && !part.startsWith('"') && !['(', ')', '[', ']'].includes(part)) {
          // Split on operators while keeping them
          const subParts = part.split(/([+\-*\/=<>])/).filter(p => p.length > 0);
          for (const subPart of subParts) {
            tokens.push({ value: subPart, line: lineNum + 1, sourcePath });
          }
        } else {
          tokens.push({ value: part, line: lineNum + 1, sourcePath });
        }
      }
    }

    return tokens;
  }

  private parseProcedure(
    tokens: LogoToken[],
    startIndex: number
  ): { procedure: LogoProcedure; nextIndex: number } {
    let i = startIndex + 1;
    const name = tokens[i++].value;
    const params: string[] = [];
    const startLine = tokens[startIndex].line;

    // Parse parameters - only those on the same line as TO
    while (i < tokens.length && tokens[i].line === startLine && tokens[i].value.startsWith(':')) {
      params.push(tokens[i].value.substring(1)); // Remove ':' prefix
      i++;
    }

    // Parse body until END
    const body: any[] = [];
    let depth = 1;

    while (i < tokens.length && depth > 0) {
      if (tokens[i].value.toUpperCase() === 'TO') {
        depth++;
      } else if (tokens[i].value.toUpperCase() === 'END') {
        depth--;
        if (depth === 0) break;
      }
      body.push(tokens[i]);
      i++;
    }

    const endLine = i < tokens.length ? tokens[i].line : tokens[tokens.length - 1].line;

    return {
      procedure: {
        name,
        params,
        body,
        sourcePath: tokens[startIndex].sourcePath,
        sourceLineStart: startLine,
        sourceLineEnd: endLine
      },
      nextIndex: i + 1
    };
  }

  public async execute(): Promise<boolean> {
    if (this.pauseRequested) {
      // We're paused, so we should resume from where we left off
      this.pauseRequested = false;
      this.justResumed = true;
    } else {
      // Starting fresh execution
      this.stopExecution = false;
      this.executionTokens = this.tokenize(this.sourceLines.join('\n'), this.rootSourcePath);
      this.executionIndex = 0;
      this.executionHistory = []; // Clear history for new execution
      this.justResumed = false;
      this.lastSteppedLine = -1; // Reset last stepped line
    }

    // Execute commands until we pause or complete
    while (this.executionIndex < this.executionTokens.length && !this.stopExecution) {
      const token = this.executionTokens[this.executionIndex];

      if (token.value.toUpperCase() === 'TO') {
        // Skip procedure definitions
        let depth = 1;
        this.executionIndex++;
        while (this.executionIndex < this.executionTokens.length && depth > 0) {
          if (this.executionTokens[this.executionIndex].value.toUpperCase() === 'TO') depth++;
          else if (this.executionTokens[this.executionIndex].value.toUpperCase() === 'END') depth--;
          this.executionIndex++;
        }
      } else {
        // Get the line number for the current command
        const currentLineNum = token.line;
        this.currentLine = currentLineNum;
        this.saveExecutionStateIfVisible(token.sourcePath);

        if (this.shouldPauseAtLine(token.sourcePath)) {
          this.pauseRequested = true;
          await this.pauseExecution();
          return false; // Paused, not complete
        }

        const tokenIsRepeat = token.value.toUpperCase() === 'REPEAT';
        const clearJustResumedNow = tokenIsRepeat &&
          this.stepMode === 'stepIn' &&
          this.lastSteppedLine === currentLineNum;
        if (clearJustResumedNow) {
          this.justResumed = false;
        }

        // Execute all commands on this line
        try {
          while (this.executionIndex < this.executionTokens.length &&
                 !this.stopExecution &&
                 !this.pauseRequested &&
                 this.executionTokens[this.executionIndex].line === currentLineNum) {
            const result = await this.executeCommand(this.executionTokens, this.executionIndex);
            this.executionIndex = result.nextIndex;

            // After executing a command, check if we should pause for step out
            // This handles the case where a procedure returns and we need to pause at the caller
            if (this.stepMode === 'stepOut' && this.callStack.length < this.stepStartCallStackDepth) {
              this.pauseRequested = true;
              await this.pauseExecution();
              return false; // Paused after step out
            }
          }
        } catch (e) {
          if (e instanceof PauseException) {
            return false;
          }
          // Re-throw other exceptions
          throw e;
        } finally {
          this.justResumed = false;
        }
      }
    }

    return true; // Execution complete
  }

  public stop(): void {
    this.stopExecution = true;
  }

  private async executeCommand(
    tokens: LogoToken[],
    startIndex: number
  ): Promise<{ nextIndex: number; value?: any }> {
    if (startIndex >= tokens.length) {
      return { nextIndex: startIndex };
    }

    const token = tokens[startIndex];
    const cmd = token.value.toUpperCase();

    // Turtle movement commands
    if (cmd === 'FD' || cmd === 'FORWARD') {
      const distance = await this.evaluateExpression(tokens, startIndex + 1);
      this.forward(this.asNumber(distance.value));
      return { nextIndex: distance.nextIndex };
    }

    if (cmd === 'BK' || cmd === 'BACK' || cmd === 'BACKWARD') {
      const distance = await this.evaluateExpression(tokens, startIndex + 1);
      this.forward(-this.asNumber(distance.value));
      return { nextIndex: distance.nextIndex };
    }

    if (cmd === 'ARC') {
      const angle = await this.evaluateExpression(tokens, startIndex + 1);
      const radius = await this.evaluateExpression(tokens, angle.nextIndex);
      this.arc(this.asNumber(angle.value), this.asNumber(radius.value));
      return { nextIndex: radius.nextIndex };
    }

    if (cmd === 'RT' || cmd === 'RIGHT') {
      const angle = await this.evaluateExpression(tokens, startIndex + 1);
      this.turtle.angle += this.asNumber(angle.value);
      // Create a move command to update the turtle's rotation immediately
      this.drawCommands.push({
        type: 'move',
        to: { x: this.turtle.x, y: this.turtle.y },
        angle: this.turtle.angle
      });
      return { nextIndex: angle.nextIndex };
    }

    if (cmd === 'LT' || cmd === 'LEFT') {
      const angle = await this.evaluateExpression(tokens, startIndex + 1);
      this.turtle.angle -= this.asNumber(angle.value);
      // Create a move command to update the turtle's rotation immediately
      this.drawCommands.push({
        type: 'move',
        to: { x: this.turtle.x, y: this.turtle.y },
        angle: this.turtle.angle
      });
      return { nextIndex: angle.nextIndex };
    }

    if (cmd === 'SETH' || cmd === 'SETHEADING') {
      const angle = await this.evaluateExpression(tokens, startIndex + 1);
      this.turtle.angle = this.asNumber(angle.value);
      // Create a move command to update the turtle's rotation immediately
      this.drawCommands.push({
        type: 'move',
        to: { x: this.turtle.x, y: this.turtle.y },
        angle: this.turtle.angle
      });
      return { nextIndex: angle.nextIndex };
    }

    if (cmd === 'PU' || cmd === 'PENUP') {
      this.turtle.penDown = false;
      return { nextIndex: startIndex + 1 };
    }

    if (cmd === 'PD' || cmd === 'PENDOWN') {
      this.turtle.penDown = true;
      return { nextIndex: startIndex + 1 };
    }

    if (cmd === 'CS' || cmd === 'CLEARSCREEN') {
      this.drawCommands.push({ type: 'reset' });
      this.resetTurtle();
      return { nextIndex: startIndex + 1 };
    }

    if (cmd === 'CLEAN') {
      this.drawCommands.push({ type: 'clean' });
      return { nextIndex: startIndex + 1 };
    }

    if (cmd === 'HOME') {
      if (this.turtle.penDown) {
        this.drawCommands.push({
          type: 'line',
          from: { x: this.turtle.x, y: this.turtle.y },
          to: { x: 0, y: 0 },
          color: this.turtle.penColor,
          angle: this.turtle.angle
        });
      } else {
        this.drawCommands.push({
          type: 'move',
          to: { x: 0, y: 0 },
          angle: this.turtle.angle
        });
      }
      this.turtle.x = 0;
      this.turtle.y = 0;
      this.turtle.angle = 0;
      return { nextIndex: startIndex + 1 };
    }

    if (cmd === 'SETPOS') {
      const posResult = await this.parseListArgument(tokens, startIndex + 1);
      if (posResult.values.length >= 2) {
        const newX = posResult.values[0];
        const newY = posResult.values[1];

        if (this.turtle.penDown) {
          this.drawCommands.push({
            type: 'line',
            from: { x: this.turtle.x, y: this.turtle.y },
            to: { x: newX, y: newY },
            color: this.turtle.penColor,
            angle: this.turtle.angle
          });
        } else {
          this.drawCommands.push({
            type: 'move',
            to: { x: newX, y: newY },
            angle: this.turtle.angle
          });
        }

        this.turtle.x = newX;
        this.turtle.y = newY;
      }
      return { nextIndex: posResult.nextIndex };
    }

    if (cmd === 'HT' || cmd === 'HIDETURTLE') {
      this.turtle.visible = false;
      this.drawCommands.push({ type: 'hideturtle' });
      return { nextIndex: startIndex + 1 };
    }

    if (cmd === 'ST' || cmd === 'SHOWTURTLE') {
      this.turtle.visible = true;
      this.drawCommands.push({ type: 'showturtle' });
      return { nextIndex: startIndex + 1 };
    }

    if (cmd === 'SETPENCOLOR' || cmd === 'SETPC') {
      const color = await this.evaluateExpression(tokens, startIndex + 1);
      this.turtle.penColor = this.numberToColor(this.asNumber(color.value));
      return { nextIndex: color.nextIndex };
    }

    // Output commands
    if (cmd === 'PRINT' || cmd === 'PR') {
      const nextIndex = startIndex + 1;
      if (nextIndex >= tokens.length) {
        throw new Error('PRINT expects an argument');
      }
      const nextToken = tokens[nextIndex];

      let message: string;
      let endIndex: number;

      if (nextToken.value.startsWith('"')) {
        // Quoted word: PRINT "Hello
        message = nextToken.value.substring(1);
        endIndex = nextIndex + 1;
      } else if (nextToken.value === '[') {
        // List: PRINT [Hello World]
        const words: string[] = [];
        let i = nextIndex + 1;
        while (i < tokens.length && tokens[i].value !== ']') {
          words.push(tokens[i].value);
          i++;
        }
        message = words.join(' ');
        endIndex = i < tokens.length && tokens[i].value === ']' ? i + 1 : i;
      } else {
        // Numeric expression or variable
        const value = await this.evaluateExpression(tokens, nextIndex);
        message = String(value.value);
        endIndex = value.nextIndex;
      }

      if (this.onPrintCallback) {
        this.onPrintCallback(message);
      }
      return { nextIndex: endIndex };
    }

    if (cmd === 'LOAD') {
      const targetPath = this.resolveLoadTarget(tokens, startIndex);
      await this.loadAndExecuteFile(targetPath);
      return { nextIndex: startIndex + 2 };
    }

    // Control structures
    if (cmd === 'REPEAT') {
      return await this.executeRepeat(tokens, startIndex);
    }

    if (cmd === 'IF') {
      return await this.executeIf(tokens, startIndex);
    }

    if (cmd === 'IFELSE') {
      return await this.executeIfElse(tokens, startIndex);
    }

    if (cmd === 'STOP') {
      throw new StopException();
    }

    // MAKE "name value
    if (cmd === 'MAKE') {
      const nameIndex = startIndex + 1;
      if (nameIndex >= tokens.length || tokens[nameIndex].line !== token.line) {
        throw new Error('MAKE expects first argument to be a quoted variable name');
      }

      const makeName = this.parseMakeVariableName(tokens[nameIndex].value);
      const valueIndex = nameIndex + 1;
      if (valueIndex >= tokens.length || tokens[valueIndex].line !== token.line) {
        throw new Error('MAKE expects a value expression');
      }

      const result = await this.evaluateValue(tokens, valueIndex);
      this.variables.set(makeName, result.value);
      return { nextIndex: result.nextIndex };
    }

    // Assignment
    if (token.value.startsWith(':') && startIndex + 1 < tokens.length && tokens[startIndex + 1].value === '=') {
      const varName = token.value.substring(1); // Remove ':' prefix
      const result = await this.evaluateExpression(tokens, startIndex + 2);
      this.variables.set(varName, result.value);
      return { nextIndex: result.nextIndex };
    }

    // Procedure call
    const procName = cmd;
    if (this.procedures.has(procName)) {
      // Pass the call site line number so step-in can pause at procedure entry
      return await this.executeProcedure(procName, tokens, startIndex + 1, token.line);
    }

    return { nextIndex: startIndex + 1 };
  }

  private async executeRepeat(
    tokens: LogoToken[],
    startIndex: number
  ): Promise<{ nextIndex: number }> {
    const count = await this.evaluateExpression(tokens, startIndex + 1);
    let i = count.nextIndex;

    if (i >= tokens.length || tokens[i].value !== '[') {
      return { nextIndex: i };
    }

    const blockStart = i + 1;
    let depth = 1;
    i++;

    while (i < tokens.length && depth > 0) {
      if (tokens[i].value === '[') depth++;
      else if (tokens[i].value === ']') depth--;
      i++;
    }

    const blockEnd = i - 1;
    const repeatLine = tokens[startIndex].line;
    let isSingleLine = true;
    for (let j = blockStart; j < blockEnd; j++) {
      if (tokens[j].line !== repeatLine) {
        isSingleLine = false;
        break;
      }
    }

    if (isSingleLine) {
      this.insideSingleLineBlock = true;
    }

    let suppressPauseForThisBlock = false;
    if (this.stepMode === 'stepOver' && this.lastSteppedLine === tokens[startIndex].line) {
      suppressPauseForThisBlock = true;
      (this as any)._suppressPauseCounter = ((this as any)._suppressPauseCounter || 0) + 1;
    }

    let repStart = 0;
    let resumeJ: number | null = null;
    const pausedState = (this as any)._pausedRepeatState;
    if (pausedState && pausedState.startIndex === startIndex) {
      repStart = pausedState.rep;
      resumeJ = pausedState.j;
    }

    for (let rep = repStart; rep < this.asNumber(count.value) && !this.stopExecution && !this.pauseRequested; rep++) {
      let j = resumeJ !== null ? resumeJ : blockStart;
      resumeJ = null;
      let lastLineInBlock = -1;

      while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
        const currentLineNum = j < tokens.length ? tokens[j].line : -1;

        if (!isSingleLine && currentLineNum !== lastLineInBlock && currentLineNum !== -1) {
          lastLineInBlock = currentLineNum;
          this.currentLine = currentLineNum;
          this.saveExecutionStateIfVisible(tokens[j].sourcePath);

          if (this.shouldPauseAtLine(tokens[j].sourcePath)) {
            if (!(this as any)._suppressPauseCounter) {
              (this as any)._pausedRepeatState = {
                startIndex,
                count: this.asNumber(count.value),
                rep,
                j,
                blockStart,
                blockEnd,
                iAfter: i,
                isSingleLine
              };

              this.insideSingleLineBlock = false;
              this.pauseRequested = true;
              await this.pauseExecution();

              if (this.stepMode !== 'stepOut') {
                throw new PauseException();
              }
            } else if (this.stepMode === 'stepOut' && this.callStack.length < this.stepStartCallStackDepth) {
              (this as any)._suppressPauseCounter = 0;
              (this as any)._pausedRepeatState = {
                startIndex,
                count: this.asNumber(count.value),
                rep,
                j,
                blockStart,
                blockEnd,
                iAfter: i,
                isSingleLine
              };
              this.insideSingleLineBlock = false;
              this.pauseRequested = true;
              await this.pauseExecution();
              throw new PauseException();
            }
          }
          this.justResumed = false;
        }

        while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
          const tokenLine = tokens[j].line;
          if (tokenLine !== currentLineNum) {
            break;
          }

          this.currentLine = tokenLine;
          const result = await this.executeCommand(tokens, j);
          j = result.nextIndex;
        }
      }
    }

    this.insideSingleLineBlock = false;

    if (suppressPauseForThisBlock) {
      (this as any)._suppressPauseCounter = Math.max(0, ((this as any)._suppressPauseCounter || 1) - 1);
    }

    if ((this as any)._pausedRepeatState && (this as any)._pausedRepeatState.startIndex === startIndex) {
      delete (this as any)._pausedRepeatState;
    }
    return { nextIndex: i };
  }

  private async executeIf(
    tokens: LogoToken[],
    startIndex: number
  ): Promise<{ nextIndex: number }> {
    const condition = await this.evaluateExpression(tokens, startIndex + 1);
    let i = condition.nextIndex;

    if (i >= tokens.length || tokens[i].value !== '[') {
      return { nextIndex: i };
    }

    const blockStart = i + 1;
    let depth = 1;
    i++;

    while (i < tokens.length && depth > 0) {
      if (tokens[i].value === '[') depth++;
      else if (tokens[i].value === ']') depth--;
      i++;
    }

    const blockEnd = i - 1;
    const ifLine = tokens[startIndex].line;
    let isSingleLine = true;
    for (let j = blockStart; j < blockEnd; j++) {
      if (tokens[j].line !== ifLine) {
        isSingleLine = false;
        break;
      }
    }

    if (isSingleLine) {
      this.insideSingleLineBlock = true;
    }

    if (this.asNumber(condition.value) !== 0) {
      let j = blockStart;
      let lastLineInBlock = -1;

      while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
        const currentLineNum = j < tokens.length ? tokens[j].line : -1;

        if (!isSingleLine && currentLineNum !== lastLineInBlock && currentLineNum !== -1) {
          lastLineInBlock = currentLineNum;
          this.currentLine = currentLineNum;
          this.saveExecutionStateIfVisible(tokens[j].sourcePath);

          if (this.shouldPauseAtLine(tokens[j].sourcePath)) {
            this.insideSingleLineBlock = false;
            this.pauseRequested = true;
            await this.pauseExecution();
            throw new PauseException();
          }
          this.justResumed = false;
        }

        while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
          const tokenLine = tokens[j].line;
          if (tokenLine !== currentLineNum) {
            break;
          }

          this.currentLine = tokenLine;
          const result = await this.executeCommand(tokens, j);
          j = result.nextIndex;
        }
      }
    }

    this.insideSingleLineBlock = false;
    return { nextIndex: i };
  }

  private async executeIfElse(
    tokens: LogoToken[],
    startIndex: number
  ): Promise<{ nextIndex: number }> {
    const condition = await this.evaluateExpression(tokens, startIndex + 1);
    let i = condition.nextIndex;

    if (i >= tokens.length || tokens[i].value !== '[') {
      return { nextIndex: i };
    }

    const trueBlockStart = i + 1;
    let depth = 1;
    i++;

    while (i < tokens.length && depth > 0) {
      if (tokens[i].value === '[') depth++;
      else if (tokens[i].value === ']') depth--;
      i++;
    }

    const trueBlockEnd = i - 1;

    if (i >= tokens.length || tokens[i].value !== '[') {
      return { nextIndex: i };
    }

    const falseBlockStart = i + 1;
    depth = 1;
    i++;

    while (i < tokens.length && depth > 0) {
      if (tokens[i].value === '[') depth++;
      else if (tokens[i].value === ']') depth--;
      i++;
    }

    const falseBlockEnd = i - 1;
    const blockStart = this.asNumber(condition.value) !== 0 ? trueBlockStart : falseBlockStart;
    const blockEnd = this.asNumber(condition.value) !== 0 ? trueBlockEnd : falseBlockEnd;
    const ifElseLine = tokens[startIndex].line;
    let isSingleLine = true;
    for (let j = blockStart; j < blockEnd; j++) {
      if (tokens[j].line !== ifElseLine) {
        isSingleLine = false;
        break;
      }
    }

    if (isSingleLine) {
      this.insideSingleLineBlock = true;
    }

    let j = blockStart;
    let lastLineInBlock = -1;

    while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
      const currentLineNum = j < tokens.length ? tokens[j].line : -1;

      if (!isSingleLine && currentLineNum !== lastLineInBlock && currentLineNum !== -1) {
        lastLineInBlock = currentLineNum;
        this.currentLine = currentLineNum;
        this.saveExecutionStateIfVisible(tokens[j].sourcePath);

        if (this.shouldPauseAtLine(tokens[j].sourcePath)) {
          this.insideSingleLineBlock = false;
          this.pauseRequested = true;
          await this.pauseExecution();
          throw new PauseException();
        }
        this.justResumed = false;
      }

      while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
        const tokenLine = tokens[j].line;
        if (tokenLine !== currentLineNum) {
          break;
        }

        this.currentLine = tokenLine;
        const result = await this.executeCommand(tokens, j);
        j = result.nextIndex;
      }
    }

    this.insideSingleLineBlock = false;
    return { nextIndex: i };
  }

  private async executeProcedure(
    name: string,
    tokens: LogoToken[],
    startIndex: number,
    callSiteLine?: number
  ): Promise<{ nextIndex: number; value?: any }> {
    const proc = this.procedures.get(name);
    if (!proc) {
      return { nextIndex: startIndex };
    }

    const pausedState = (this as any)._pausedProcState;
    const isResuming = pausedState && pausedState.procName === name &&
      pausedState.callSiteLine === callSiteLine &&
      pausedState.callStackDepth === this.callStack.length;

    let savedVars: Map<string, LogoValue>;
    let i: number;

    if (isResuming) {
      savedVars = pausedState.savedVars;
      i = pausedState.returnIndex;
      delete (this as any)._pausedProcState;
    } else {
      savedVars = new Map(this.variables);
      i = startIndex;
      for (const param of proc.params) {
        const arg = await this.evaluateExpression(tokens, i);
        const paramName = param.startsWith(':') ? param.substring(1) : param;
        this.variables.set(paramName, arg.value);
        i = arg.nextIndex;
      }

      if ((this as any)._pausedOnProcedureEntry &&
          (this as any)._pausedOnProcedureEntry.callSiteLine === callSiteLine &&
          (this as any)._pausedOnProcedureEntry.procName === name) {
        delete (this as any)._pausedOnProcedureEntry;
      }

      this.callStack.push({
        procedure: proc.name,
        line: proc.sourceLineStart,
        vars: new Map(this.variables),
        sourcePath: proc.sourcePath
      });

      if (proc.sourcePath === this.rootSourcePath &&
          this.stepMode === 'stepIn' &&
          typeof callSiteLine === 'number' &&
          this.lastSteppedLine === callSiteLine) {
        this.justResumed = false;
        this.currentLine = proc.sourceLineStart;
        this.saveExecutionStateIfVisible(proc.sourcePath);
        if (this.shouldPause()) {
          this.pauseRequested = true;
          (this as any)._pausedOnProcedureEntry = { callSiteLine, procName: name };
          (this as any)._pausedProcState = {
            procName: name,
            callSiteLine,
            savedVars,
            returnIndex: i,
            callStackDepth: this.callStack.length
          };

          await this.pauseExecution();
          throw new PauseException();
        }
      }
    }

    let j = 0;
    let pausedException: PauseException | null = null;
    const opaqueProcedure = this.debugMode && proc.sourcePath !== this.rootSourcePath;

    try {
      await this.runOpaqueIfNeeded(opaqueProcedure, async () => {
        let lastLineInProc = -1;
        while (j < proc.body.length && !this.stopExecution && !this.pauseRequested) {
          const currentLineNum = j < proc.body.length ? proc.body[j].line : -1;

          if (currentLineNum !== lastLineInProc && currentLineNum !== -1) {
            lastLineInProc = currentLineNum;
            this.currentLine = currentLineNum;
            this.saveExecutionStateIfVisible(proc.body[j].sourcePath);

            if (this.shouldPauseAtLine(proc.body[j].sourcePath)) {
              this.pauseRequested = true;
              (this as any)._pausedProcState = {
                procName: name,
                callSiteLine,
                savedVars,
                returnIndex: i,
                callStackDepth: this.callStack.length
              };

              await this.pauseExecution();
              throw new PauseException();
            }
            this.justResumed = false;
          }

          while (j < proc.body.length && !this.stopExecution && !this.pauseRequested) {
            const tokenLine = proc.body[j].line;
            if (tokenLine !== currentLineNum) {
              break;
            }
            this.currentLine = tokenLine;
            const result = await this.executeCommand(proc.body, j);
            j = result.nextIndex;
          }
        }
      });
    } catch (e) {
      if (e instanceof StopException) {
        // STOP exits only this procedure.
      } else if (e instanceof PauseException) {
        pausedException = e;
        (this as any)._pausedProcState = {
          procName: name,
          callSiteLine,
          savedVars,
          returnIndex: i,
          callStackDepth: this.callStack.length
        };
      } else {
        throw e;
      }
    } finally {
      if (!pausedException) {
        this.callStack.pop();

        if (this.stepMode === 'stepOut' && this.callStack.length < this.stepStartCallStackDepth) {
          if (typeof callSiteLine === 'number') {
            this.currentLine = callSiteLine;
          }
          this.saveExecutionStateIfVisible(this.rootSourcePath);
          this.pauseRequested = true;
          await this.pauseExecution();
          throw new PauseException();
        }

        const localVars = this.variables;
        this.variables = savedVars;
        for (const [key, value] of localVars) {
          const isParam = proc.params.some(p => (p.startsWith(':') ? p.substring(1) : p) === key);
          if (savedVars.has(key) && !isParam) {
            this.variables.set(key, value);
          }
        }
      }
    }

    if (pausedException) {
      throw pausedException;
    }

    return { nextIndex: i };
  }

  private async evaluateExpression(
    tokens: LogoToken[],
    startIndex: number
  ): Promise<{ value: LogoValue; nextIndex: number }> {
    if (startIndex >= tokens.length) {
      return { value: 0, nextIndex: startIndex };
    }

    return this.parseExpression(tokens, startIndex);
  }

  private async evaluateValue(
    tokens: LogoToken[],
    startIndex: number
  ): Promise<{ value: LogoValue; nextIndex: number }> {
    if (startIndex >= tokens.length) {
      return { value: 0, nextIndex: startIndex };
    }

    const token = tokens[startIndex];
    if (token.value.startsWith('"')) {
      return { value: token.value.substring(1), nextIndex: startIndex + 1 };
    }

    return this.evaluateExpression(tokens, startIndex);
  }

  private async parseExpression(
    tokens: LogoToken[],
    startIndex: number
  ): Promise<{ value: LogoValue; nextIndex: number }> {
    let left = await this.parsePrimary(tokens, startIndex);

    while (left.nextIndex < tokens.length) {
      const op = tokens[left.nextIndex].value;
      if (!['+', '-', '*', '/', '=', '<', '>'].includes(op)) {
        break;
      }

      const right = await this.parsePrimary(tokens, left.nextIndex + 1);
      let result = 0;
      const leftNumber = this.asNumber(left.value);
      const rightNumber = this.asNumber(right.value);
      switch (op) {
        case '+': result = leftNumber + rightNumber; break;
        case '-': result = leftNumber - rightNumber; break;
        case '*': result = leftNumber * rightNumber; break;
        case '/': result = rightNumber !== 0 ? leftNumber / rightNumber : 0; break;
        case '=': result = left.value === right.value ? 1 : 0; break;
        case '<': result = leftNumber < rightNumber ? 1 : 0; break;
        case '>': result = leftNumber > rightNumber ? 1 : 0; break;
      }

      left = { value: result, nextIndex: right.nextIndex };
    }

    return left;
  }

  private async parsePrimary(
    tokens: LogoToken[],
    startIndex: number
  ): Promise<{ value: LogoValue; nextIndex: number }> {
    if (startIndex >= tokens.length) {
      return { value: 0, nextIndex: startIndex };
    }

    const token = tokens[startIndex];
    if (/^-?[0-9]+(\.[0-9]+)?$/.test(token.value)) {
      return { value: parseFloat(token.value), nextIndex: startIndex + 1 };
    }

    if (token.value.startsWith('"')) {
      return { value: token.value.substring(1), nextIndex: startIndex + 1 };
    }

    if (token.value.startsWith(':')) {
      const varName = token.value.substring(1);
      const value = this.variables.get(varName) || 0;
      return { value, nextIndex: startIndex + 1 };
    }

    if (token.value.toUpperCase() === 'RANDOM') {
      const upperBound = await this.parsePrimary(tokens, startIndex + 1);
      const numericUpperBound = this.asNumber(upperBound.value);
      if (numericUpperBound <= 0) {
        return { value: 0, nextIndex: upperBound.nextIndex };
      }

      return {
        value: Math.floor(Math.random() * numericUpperBound),
        nextIndex: upperBound.nextIndex
      };
    }

    if (token.value === '(') {
      const expr = await this.parseExpression(tokens, startIndex + 1);
      if (expr.nextIndex < tokens.length && tokens[expr.nextIndex].value === ')') {
        return { value: expr.value, nextIndex: expr.nextIndex + 1 };
      }
      return expr;
    }

    return { value: 0, nextIndex: startIndex + 1 };
  }

  private parseMakeVariableName(tokenValue: string): string {
    if (!tokenValue.startsWith('"')) {
      throw new Error('MAKE expects first argument to be a quoted variable name');
    }

    const varName = tokenValue.substring(1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
      throw new Error('MAKE expects first argument to be a quoted variable name');
    }

    return varName;
  }

  private async parseListArgument(
    tokens: LogoToken[],
    startIndex: number
  ): Promise<{ values: number[]; nextIndex: number }> {
    const values: number[] = [];

    if (startIndex >= tokens.length || tokens[startIndex].value !== '[') {
      return { values, nextIndex: startIndex };
    }

    let i = startIndex + 1;
    while (i < tokens.length && tokens[i].value !== ']') {
      const result = await this.evaluateExpression(tokens, i);
      values.push(this.asNumber(result.value));
      i = result.nextIndex;
    }

    if (i < tokens.length && tokens[i].value === ']') {
      i++;
    }

    return { values, nextIndex: i };
  }

  private asNumber(value: LogoValue): number {
    if (typeof value === 'number') {
      return value;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private resolveLoadTarget(tokens: LogoToken[], startIndex: number): string {
    const commandToken = tokens[startIndex];
    const filenameToken = tokens[startIndex + 1];
    if (!filenameToken || filenameToken.line !== commandToken.line) {
      throw new Error('LOAD expects a filename argument');
    }

    let filename: string;
    if (filenameToken.value.startsWith('"')) {
      filename = filenameToken.value.substring(1);
    } else if (filenameToken.value.startsWith(':')) {
      const varName = filenameToken.value.substring(1);
      const variableValue = this.variables.get(varName);
      if (typeof variableValue !== 'string' || variableValue.length === 0) {
        throw new Error(`LOAD variable '${varName}' must contain a filename`);
      }
      filename = variableValue;
    } else {
      throw new Error('LOAD expects a quoted filename or filename variable');
    }

    if (tokens[startIndex + 2] && tokens[startIndex + 2].line === commandToken.line) {
      throw new Error('LOAD expects exactly 1 argument');
    }

    if (path.isAbsolute(filename)) {
      return path.normalize(filename);
    }
    if (!this.hasRealSourcePath(commandToken.sourcePath)) {
      throw new Error('LOAD requires a real source file path for relative paths');
    }

    return path.resolve(path.dirname(commandToken.sourcePath), filename);
  }

  private async loadAndExecuteFile(targetPath: string): Promise<void> {
    const normalizedPath = path.normalize(targetPath);
    if (this.activeLoadStack.includes(normalizedPath)) {
      const chain = [...this.activeLoadStack, normalizedPath].join(' -> ');
      throw new Error(`Cyclic LOAD detected: ${chain}`);
    }

    let source: string;
    try {
      source = fs.readFileSync(normalizedPath, 'utf8');
    } catch (error) {
      throw new Error(`LOAD failed for ${normalizedPath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.activeLoadStack.push(normalizedPath);
    try {
      this.parse(source, normalizedPath);
      const loadedTokens = this.tokenize(source, normalizedPath);
      await this.runOpaqueIfNeeded(this.debugMode, async () => {
        let index = 0;
        while (index < loadedTokens.length && !this.stopExecution) {
          const token = loadedTokens[index];
          if (token.value.toUpperCase() === 'TO') {
            let depth = 1;
            index++;
            while (index < loadedTokens.length && depth > 0) {
              const current = loadedTokens[index].value.toUpperCase();
              if (current === 'TO') depth++;
              else if (current === 'END') depth--;
              index++;
            }
            continue;
          }

          const currentLineNum = token.line;
          while (index < loadedTokens.length &&
                 !this.stopExecution &&
                 loadedTokens[index].line === currentLineNum) {
            const result = await this.executeCommand(loadedTokens, index);
            index = result.nextIndex;
          }
        }
      });
    } finally {
      this.activeLoadStack.pop();
    }
  }

  private forward(distance: number): void {
    const radians = (this.turtle.angle * Math.PI) / 180;
    const newX = this.turtle.x + distance * Math.sin(radians);
    const newY = this.turtle.y + distance * Math.cos(radians);

    if (this.turtle.penDown) {
      this.drawCommands.push({
        type: 'line',
        from: { x: this.turtle.x, y: this.turtle.y },
        to: { x: newX, y: newY },
        color: this.turtle.penColor,
        angle: this.turtle.angle
      });
    } else {
      this.drawCommands.push({
        type: 'move',
        to: { x: newX, y: newY },
        angle: this.turtle.angle
      });
    }

    this.turtle.x = newX;
    this.turtle.y = newY;
  }

  private arc(angle: number, radius: number): void {
    if (angle === 0 || radius === 0) {
      return;
    }

    const segments = Math.max(1, Math.ceil(Math.abs(angle) / 5));
    const stepAngle = angle / segments;

    const deg2rad = Math.PI / 180
    for (let i = 0; i < segments; i++) {
      const startX = this.turtle.x;
      const startY = this.turtle.y;
      const startHeading = this.turtle.angle;

      const headingRadians = startHeading * deg2rad;
      const centerX = startX + radius * Math.cos(headingRadians);
      const centerY = startY - radius * Math.sin(headingRadians);

      const endHeading = startHeading + stepAngle;
      const endHeadingRadians = endHeading * deg2rad;
      const newX = centerX - radius * Math.cos(endHeadingRadians);
      const newY = centerY + radius * Math.sin(endHeadingRadians);

      if (this.turtle.penDown) {
        this.drawCommands.push({
          type: 'line',
          from: { x: startX, y: startY },
          to: { x: newX, y: newY },
          color: this.turtle.penColor,
          angle: endHeading
        });
      } else {
        this.drawCommands.push({
          type: 'move',
          to: { x: newX, y: newY },
          angle: endHeading
        });
      }

      this.turtle.x = newX;
      this.turtle.y = newY;
      this.turtle.angle = endHeading;
    }
  }

  private numberToColor(num: number): string {
    const colors = [
      '#000000', '#FF0000', '#00FF00', '#0000FF',
      '#FFFF00', '#FF00FF', '#00FFFF', '#FFFFFF'
    ];
    const index = Math.floor(Math.abs(num)) % colors.length;
    return colors[index];
  }
}
