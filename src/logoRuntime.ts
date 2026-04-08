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
  currentSourcePath: string;
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
  private currentSourcePath: string = LogoRuntime.MEMORY_SOURCE_PATH;
  private stopExecution: boolean = false;
  private breakpoints: Map<string, Set<number>> = new Map();
  private stepMode: StepMode = null;
  private stepStartCallStackDepth: number = 0;
  private executionHistory: ExecutionState[] = [];
  private maxHistorySize: number = 1000;
  private onStepCallback?: () => void;
  private onPrintCallback?: (message: string) => void;
  private pauseRequested: boolean = false;
  private executionTokens: LogoToken[] = [];
  private executionIndex: number = 0;
  private lastSteppedLine: number = -1;
  private lastSteppedSourcePath: string = LogoRuntime.MEMORY_SOURCE_PATH;
  private insideSingleLineBlock: boolean = false;
  private debugMode: boolean = false;
  private opaqueExecutionDepth: number = 0;
  private activeLoadStack: string[] = [];
  private pendingPauseReason: 'step' | 'breakpoint' = 'step';
  private lastPauseReason: 'step' | 'breakpoint' = 'step';

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
    this.breakpoints.clear();
    this.currentLine = 0;
    this.currentSourcePath = this.rootSourcePath;
    this.lastSteppedLine = -1;
    this.lastSteppedSourcePath = this.rootSourcePath;
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

  public getCurrentLocation(): { line: number; sourcePath: string } {
    return {
      line: this.currentLine,
      sourcePath: this.currentSourcePath
    };
  }

  public getCallStack(): Array<{ procedure: string; line: number; sourcePath: string }> {
    return this.callStack
      .map(frame => ({
        procedure: frame.procedure,
        line: frame.line,
        sourcePath: frame.sourcePath
      }))
      .reverse();
  }

  public getVariables(): Map<string, LogoValue> {
    return new Map(this.variables);
  }

  public setBreakpoints(lines: number[], sourcePath?: string): void {
    const normalizedSourcePath = this.normalizeSourcePath(sourcePath ?? this.rootSourcePath);
    this.breakpoints.set(normalizedSourcePath, new Set(lines));
  }

  public setSourceBreakpoints(breakpointsBySource: Map<string, number[]>): void {
    this.breakpoints.clear();
    breakpointsBySource.forEach((lines, sourcePath) => {
      const normalizedSourcePath = this.normalizeSourcePath(sourcePath);
      this.breakpoints.set(normalizedSourcePath, new Set(lines));
    });
  }

  public setStepMode(mode: StepMode): void {
    this.stepMode = mode;
    this.stepStartCallStackDepth = this.callStack.length;
    this.lastSteppedSourcePath = this.currentSourcePath;
  }

  public setStepCallback(callback: () => void): void {
    this.onStepCallback = callback;
  }

  public getLastPauseReason(): 'step' | 'breakpoint' {
    return this.lastPauseReason;
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
    this.currentSourcePath = state.currentSourcePath;
    this.executionIndex = state.executionIndex;
    // Reset lastSteppedLine so step over/in/out work correctly after stepping back
    this.lastSteppedLine = -1;
    this.lastSteppedSourcePath = this.currentSourcePath;
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
      currentSourcePath: this.currentSourcePath,
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

  private hasBreakpointAtLine(sourcePath: string, line: number): boolean {
    const lines = this.breakpoints.get(this.normalizeSourcePath(sourcePath));
    return lines?.has(line) ?? false;
  }

  private setCurrentLocation(line: number, sourcePath: string): void {
    this.currentLine = line;
    this.currentSourcePath = sourcePath;
  }

  private shouldTrackVisibleDebugState(sourcePath: string): boolean {
    return !this.debugMode ||
      !this.isOpaqueDebugExecution() ||
      this.hasBreakpointAtLine(sourcePath, this.currentLine);
  }

  private saveExecutionStateIfVisible(sourcePath: string): void {
    if (this.shouldTrackVisibleDebugState(sourcePath)) {
      this.saveExecutionState();
    }
  }

  private shouldPauseAtLine(sourcePath: string): boolean {
    const isNewLocation = this.currentLine !== this.lastSteppedLine ||
      sourcePath !== this.lastSteppedSourcePath;
    const shouldPauseForBreakpoint = this.hasBreakpointAtLine(sourcePath, this.currentLine) &&
      isNewLocation;
    if (shouldPauseForBreakpoint) {
      this.pendingPauseReason = 'breakpoint';
      return true;
    }

    if (!this.shouldTrackVisibleDebugState(sourcePath)) {
      return false;
    }

    const shouldPauseForStepMode = isNewLocation &&
      this.shouldPauseForStepMode();
    if (shouldPauseForStepMode) {
      this.pendingPauseReason = 'step';
    }
    return shouldPauseForStepMode;
  }

  private async runOpaqueIfNeeded<T>(opaque: boolean, fn: () => Promise<T>): Promise<T> {
    if (!opaque) {
      return fn();
    }

    const previousLine = this.currentLine;
    const previousSourcePath = this.currentSourcePath;
    this.opaqueExecutionDepth++;
    try {
      return await fn();
    } finally {
      this.opaqueExecutionDepth = Math.max(0, this.opaqueExecutionDepth - 1);
      if (!this.pauseRequested) {
        this.currentLine = previousLine;
        this.currentSourcePath = previousSourcePath;
      }
    }
  }

  private shouldPause(sourcePath: string): boolean {
    if (this.insideSingleLineBlock) {
      return false;
    }

    return this.shouldPauseAtLine(sourcePath);
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

  private savePausedLoadState(targetPath: string, tokens: LogoToken[], index: number): void {
    const states: Array<{ targetPath: string; tokens: LogoToken[]; index: number }> =
      (this as any)._pausedLoadStates || [];
    const existingIndex = states.findIndex(state => state.targetPath === targetPath);
    if (existingIndex !== -1) {
      states.splice(existingIndex, 1);
    }
    states.push({ targetPath, tokens, index });
    (this as any)._pausedLoadStates = states;
  }

  private async pauseExecution(): Promise<void> {
    // Clear step mode (it's been completed)
    this.stepMode = null;
    this.lastSteppedLine = this.currentLine; // Remember where we paused
    this.lastSteppedSourcePath = this.currentSourcePath;
    this.lastPauseReason = this.pendingPauseReason;
    this.pendingPauseReason = 'step';
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
    } else {
      // Starting fresh execution
      this.stopExecution = false;
      this.executionTokens = this.tokenize(this.sourceLines.join('\n'), this.rootSourcePath);
      this.executionIndex = 0;
      this.executionHistory = []; // Clear history for new execution
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
        this.setCurrentLocation(currentLineNum, token.sourcePath);

        // Check if we're resuming from inside a nested construct (procedure/REPEAT).
        // If so, skip the pause check — the nested construct handles its own pausing.
        const resumingInsideNested =
          ((this as any)._pausedProcStates && (this as any)._pausedProcStates.length > 0) ||
          ((this as any)._pausedRepeatStates && (this as any)._pausedRepeatStates.length > 0) ||
          ((this as any)._pausedLoadStates && (this as any)._pausedLoadStates.length > 0);

        // Save state before executing (for reverse debugging)
        this.saveExecutionStateIfVisible(token.sourcePath);

        // Check if we should pause before executing this line
        // When resuming from a nested construct, skip this check entirely to avoid
        // re-triggering breakpoints at the call site.
        if (!resumingInsideNested) {
          if (this.shouldPauseAtLine(token.sourcePath)) {
            this.pauseRequested = true;
            await this.pauseExecution();
            return false; // Paused, not complete
          }
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
            // If a procedure completed and stepOut fired, advance past it
            if (typeof (this as any)._stepOutNextIndex === 'number') {
              this.executionIndex = (this as any)._stepOutNextIndex;
              delete (this as any)._stepOutNextIndex;
            }
            // Pause was requested from nested context, return false to indicate pause
            return false;
          }
          // Re-throw other exceptions
          throw e;
        } finally {
          // no-op: justResumed removed, pause guards use lastSteppedLine
        }
      }
    }

    // If pauseRequested was set (e.g. by stepOut returning from a procedure
    // without throwing), report a pause rather than completion.
    if (this.pauseRequested) {
      return false;
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

  /** Push a REPEAT's pause state onto the stack, replacing any existing entry for the same repeatLine. */
  private _pushRepeatState(
    repeatLine: number, count: number, rep: number, j: number,
    blockStart: number, blockEnd: number, iAfter: number, isSingleLine: boolean
  ): void {
    const states: any[] = (this as any)._pausedRepeatStates || [];
    // Replace any existing entry for this repeatLine
    const idx = states.findIndex((s: any) => s.repeatLine === repeatLine);
    if (idx !== -1) states.splice(idx, 1);
    states.push({ repeatLine, count, rep, j, blockStart, blockEnd, iAfter, isSingleLine });
    (this as any)._pausedRepeatStates = states;
  }

  private async executeRepeat(
    tokens: LogoToken[],
    startIndex: number
  ): Promise<{ nextIndex: number }> {
    const count = await this.evaluateExpression(tokens, startIndex + 1);
    let i = count.nextIndex;

    // Find the block in brackets
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

    // Determine if this is a single-line REPEAT block
    const repeatLine = tokens[startIndex].line;
    let isSingleLine = true;
    for (let j = blockStart; j < blockEnd; j++) {
      if (tokens[j].line !== repeatLine) {
        isSingleLine = false;
        break;
      }
    }

    // If single-line, mark that we're inside a single-line block
    if (isSingleLine) {
      this.insideSingleLineBlock = true;
    }

    // If we're stepping over this REPEAT from its own line, suppress pauses until the block completes
    let suppressPauseForThisBlock = false;
    if (this.stepMode === 'stepOver' && this.lastSteppedLine === tokens[startIndex].line) {
      suppressPauseForThisBlock = true;
      // Use a counter in case of nested blocks
      (this as any)._suppressPauseCounter = ((this as any)._suppressPauseCounter || 0) + 1;
    }

    // Execute the block count times
    // Support resuming from a pause inside a REPEAT by restoring saved state.
    // _pausedRepeatStates is an array (stack) so nested REPEATs across procedure
    // boundaries can each save/restore independently.
    let repStart = 0;
    let resumeJ: number | null = null;
    const pausedStatesArr: any[] = (this as any)._pausedRepeatStates || [];
    const myStateIdx = pausedStatesArr.findIndex((s: any) => s.repeatLine === repeatLine);
    if (myStateIdx !== -1) {
      const pausedState = pausedStatesArr[myStateIdx];
      repStart = pausedState.rep;
      resumeJ = pausedState.j;
      // Remove our entry from the stack
      pausedStatesArr.splice(myStateIdx, 1);
      (this as any)._pausedRepeatStates = pausedStatesArr;
    }

    for (let rep = repStart; rep < this.asNumber(count.value) && !this.stopExecution && !this.pauseRequested; rep++) {
      let j = resumeJ !== null ? resumeJ : blockStart;
      // When resuming, initialise lastLineInBlock to the resume line so we
      // don't re-trigger a pause check for a line we already paused at/past.
      let lastLineInBlock = resumeJ !== null && j < tokens.length ? tokens[j].line : -1;
      resumeJ = null; // only use resumeJ for first loop

      while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
        // Get the current line number
        const currentLineNum = j < tokens.length ? tokens[j].line : -1;

        // For multi-line blocks, check if we moved to a new line
        if (!isSingleLine && currentLineNum !== lastLineInBlock && currentLineNum !== -1) {
          lastLineInBlock = currentLineNum;
          this.setCurrentLocation(currentLineNum, tokens[j].sourcePath);

          // Save state for reverse debugging
          this.saveExecutionStateIfVisible(tokens[j].sourcePath);

          // Check if we should pause (skip if on same line we just paused at)
          // When there are deeper paused procedure/repeat states, suppress pause checks
          // so this REPEAT passes through to reach the actual paused location.
          const repeatPassingThrough = ((this as any)._pausedProcStates && (this as any)._pausedProcStates.length > 0) ||
                                       ((this as any)._pausedRepeatStates && (this as any)._pausedRepeatStates.length > 0);
          if (!repeatPassingThrough && this.shouldPauseAtLine(tokens[j].sourcePath)) {
            // Only pause if we are not suppressing pauses for this block
            if (!(this as any)._suppressPauseCounter) {
              // Save repeat state to resume later
              this._pushRepeatState(repeatLine, this.asNumber(count.value), rep, j, blockStart, blockEnd, i, isSingleLine);

              this.insideSingleLineBlock = false;
              this.pauseRequested = true;
              await this.pauseExecution();

              // For step out, don't throw the exception - let execution continue to exit the procedure
              if (this.stepMode !== 'stepOut') {
                throw new PauseException(); // Throw to bubble up and pause execution
              }
            } else {
              // Suppressed pause - but for step out, we should still pause
              if (this.stepMode === 'stepOut' && this.callStack.length < this.stepStartCallStackDepth) {
                // Clear suppression for step out
                (this as any)._suppressPauseCounter = 0;
                // Save repeat state
                this._pushRepeatState(repeatLine, this.asNumber(count.value), rep, j, blockStart, blockEnd, i, isSingleLine);
                this.insideSingleLineBlock = false;
                this.pauseRequested = true;
                await this.pauseExecution();
                throw new PauseException();
              }
            }
          }
        }

        // Execute all commands on this line
        try {
          while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
            const tokenLine = tokens[j].line;

            // If we've moved to a different line, break to trigger pause check
            if (tokenLine !== currentLineNum) {
              break;
            }

            this.setCurrentLocation(tokenLine, tokens[j].sourcePath);
            const result = await this.executeCommand(tokens, j);
            j = result.nextIndex;
          }
        } catch (e) {
          if (e instanceof PauseException) {
            // If a procedure completed via stepOut, advance j past it
            if (typeof (this as any)._stepOutNextIndex === 'number') {
              j = (this as any)._stepOutNextIndex;
              delete (this as any)._stepOutNextIndex;
            }
            // A procedure call (or deeper construct) inside the REPEAT body
            // paused execution. Save current repeat state so we can resume.
            this._pushRepeatState(repeatLine, this.asNumber(count.value), rep, j, blockStart, blockEnd, i, isSingleLine);
            throw e;
          }
          throw e;
        }
        // Line done — clear so breakpoints re-trigger on revisit
        this.lastSteppedLine = -1;
      }
    }

    // Clear single-line block flag
    this.insideSingleLineBlock = false;

    // Clear suppression counter if set
    if (suppressPauseForThisBlock) {
      (this as any)._suppressPauseCounter = Math.max(0, ((this as any)._suppressPauseCounter || 1) - 1);
    }

    // Clear paused repeat state now that we've completed the repeat
    const statesArr: any[] = (this as any)._pausedRepeatStates || [];
    const cleanIdx = statesArr.findIndex((s: any) => s.repeatLine === repeatLine);
    if (cleanIdx !== -1) {
      statesArr.splice(cleanIdx, 1);
      (this as any)._pausedRepeatStates = statesArr;
    }
    return { nextIndex: i };
  }

  private async executeIf(
    tokens: LogoToken[],
    startIndex: number
  ): Promise<{ nextIndex: number }> {
    const condition = await this.evaluateExpression(tokens, startIndex + 1);
    let i = condition.nextIndex;

    // Find the block in brackets
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

    // Determine if this is a single-line IF block
    const ifLine = tokens[startIndex].line;
    let isSingleLine = true;
    for (let j = blockStart; j < blockEnd; j++) {
      if (tokens[j].line !== ifLine) {
        isSingleLine = false;
        break;
      }
    }

    // If single-line, mark that we're inside a single-line block
    if (isSingleLine) {
      this.insideSingleLineBlock = true;
    }

    // Execute the block if condition is true (non-zero)
    if (this.asNumber(condition.value) !== 0) {
      let j = blockStart;
      let lastLineInBlock = -1;

      while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
        // Get the current line number
        const currentLineNum = j < tokens.length ? tokens[j].line : -1;

        // For multi-line blocks, check if we moved to a new line
        if (!isSingleLine && currentLineNum !== lastLineInBlock && currentLineNum !== -1) {
          lastLineInBlock = currentLineNum;
          this.setCurrentLocation(currentLineNum, tokens[j].sourcePath);

          // Save state for reverse debugging
          this.saveExecutionStateIfVisible(tokens[j].sourcePath);

          // Check if we should pause (skip if on same line we just paused at)
          if (this.shouldPauseAtLine(tokens[j].sourcePath)) {
            this.insideSingleLineBlock = false;
            this.pauseRequested = true;
            await this.pauseExecution();
            throw new PauseException(); // Throw to bubble up and pause execution
          }
        }

        // Execute all commands on this line
        while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
          const tokenLine = tokens[j].line;

          // If we've moved to a different line, break to trigger pause check
          if (tokenLine !== currentLineNum) {
            break;
          }

          this.setCurrentLocation(tokenLine, tokens[j].sourcePath);
          const result = await this.executeCommand(tokens, j);
          j = result.nextIndex;
        }
        // Line done — clear so breakpoints re-trigger on revisit
        this.lastSteppedLine = -1;
      }
    }

    // Clear single-line block flag
    this.insideSingleLineBlock = false;

    return { nextIndex: i };
  }

  private async executeIfElse(
    tokens: LogoToken[],
    startIndex: number
  ): Promise<{ nextIndex: number }> {
    const condition = await this.evaluateExpression(tokens, startIndex + 1);
    let i = condition.nextIndex;

    // Find the true block in brackets
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

    // Find the false block in brackets
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

    // Determine if this is a single-line IFELSE block
    const ifElseLine = tokens[startIndex].line;
    let isSingleLine = true;
    for (let j = blockStart; j < blockEnd; j++) {
      if (tokens[j].line !== ifElseLine) {
        isSingleLine = false;
        break;
      }
    }

    // If single-line, mark that we're inside a single-line block
    if (isSingleLine) {
      this.insideSingleLineBlock = true;
    }

    let j = blockStart;
    let lastLineInBlock = -1;

    while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
      // Get the current line number
      const currentLineNum = j < tokens.length ? tokens[j].line : -1;

      // For multi-line blocks, check if we moved to a new line
      if (!isSingleLine && currentLineNum !== lastLineInBlock && currentLineNum !== -1) {
        lastLineInBlock = currentLineNum;
        this.setCurrentLocation(currentLineNum, tokens[j].sourcePath);

        // Save state for reverse debugging
        this.saveExecutionStateIfVisible(tokens[j].sourcePath);

        // Check if we should pause (skip if on same line we just paused at)
        if (this.shouldPauseAtLine(tokens[j].sourcePath)) {
          this.insideSingleLineBlock = false;
          this.pauseRequested = true;
          await this.pauseExecution();
          throw new PauseException(); // Throw to bubble up and pause execution
        }
      }

      // Execute all commands on this line
      while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
        const tokenLine = tokens[j].line;

        // If we've moved to a different line, break to trigger pause check
        if (tokenLine !== currentLineNum) {
          break;
        }

        this.setCurrentLocation(tokenLine, tokens[j].sourcePath);
        const result = await this.executeCommand(tokens, j);
        j = result.nextIndex;
      }
      // Line done — clear so breakpoints re-trigger on revisit
      this.lastSteppedLine = -1;
    }

    // Clear single-line block flag
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

    // _pausedProcStates is an array used as a stack (unshift/shift) for nested procedure states.
    // Each procedure that catches a PauseException from a deeper procedure pushes its state
    // so all levels can resume correctly.
    const pausedStates: any[] = (this as any)._pausedProcStates || [];

    // Check if we're resuming from a paused state inside this procedure
    const isResuming = pausedStates.length > 0 && pausedStates[0].procName === name &&
                       pausedStates[0].callSiteLine === callSiteLine;

    let savedVars: Map<string, LogoValue>;
    let i: number;

    let resumeBodyIndex: number | null = null;

    if (isResuming) {
      // Resuming from pause - restore saved state
      const pausedState = pausedStates.shift();
      savedVars = pausedState.savedVars;
      i = pausedState.returnIndex;
      resumeBodyIndex = pausedState.bodyIndex ?? null;
      // Update the array reference
      (this as any)._pausedProcStates = pausedStates;
      // Don't push to call stack again - it's already there from when we paused
    } else {
      // Normal entry - set up procedure execution
      savedVars = new Map(this.variables);

      // Evaluate arguments and bind to parameters
      i = startIndex;
      for (const param of proc.params) {
        const arg = await this.evaluateExpression(tokens, i);
        const paramName = param.startsWith(':') ? param.substring(1) : param; // Remove ':' prefix
        this.variables.set(paramName, arg.value);
        i = arg.nextIndex;
      }

      // If we paused on entering the procedure entry previously for this call site, clear that marker
      if ((this as any)._pausedOnProcedureEntry && (this as any)._pausedOnProcedureEntry.callSiteLine === callSiteLine && (this as any)._pausedOnProcedureEntry.procName === name) {
        delete (this as any)._pausedOnProcedureEntry;
      }

      // Add to call stack
      this.callStack.push({
        procedure: proc.name,
        line: proc.sourceLineStart,
        vars: new Map(this.variables),
        sourcePath: proc.sourcePath
      });

      // If the user requested a 'stepIn' from the call site, pause at the procedure entry now
      // We do this after argument binding and after pushing the call frame so the stack reflects the entry
      if (this.stepMode === 'stepIn' &&
          typeof callSiteLine === 'number' &&
          this.lastSteppedLine === callSiteLine) {
        // Pause at procedure definition line
        this.setCurrentLocation(proc.sourceLineStart, proc.sourcePath);
        this.saveExecutionStateIfVisible(proc.sourcePath);
        if (this.shouldPause(proc.sourcePath)) {
          this.pauseRequested = true;
          (this as any)._pausedOnProcedureEntry = { callSiteLine, procName: name };

          // Initialize the paused states stack with this procedure's state
          (this as any)._pausedProcStates = [{
            procName: name,
            callSiteLine,
            savedVars,
            returnIndex: i,
            bodyIndex: 0
          }];

          await this.pauseExecution();
          throw new PauseException();
        }
      }
    }

    // Execute procedure body
    let j = resumeBodyIndex !== null ? resumeBodyIndex : 0;
    let lastLineInProc = -1;
    let pausedException: PauseException | null = null;
    // When resuming and there's a paused repeat state to pass through, skip the
    // pause check on the resume line (one-shot) so we reach the nested REPEAT.
    let skipResumeLinePause = isResuming && resumeBodyIndex !== null && ((this as any)._pausedRepeatStates && (this as any)._pausedRepeatStates.length > 0);

    try {
      await this.runOpaqueIfNeeded(false, async () => {
        while (j < proc.body.length && !this.stopExecution && !this.pauseRequested) {
        const currentLineNum = j < proc.body.length ? proc.body[j].line : -1;

        if (currentLineNum !== lastLineInProc && currentLineNum !== -1) {
          lastLineInProc = currentLineNum;
          this.setCurrentLocation(currentLineNum, proc.body[j].sourcePath);

          this.saveExecutionStateIfVisible(proc.body[j].sourcePath);

          // When there are deeper paused procedure states in the stack, we're "passing through"
          // this procedure to reach the actual paused location — suppress all pause checks.
          // Also suppress once when passing through a resume line to reach a paused REPEAT.
          const passingThrough = ((this as any)._pausedProcStates && (this as any)._pausedProcStates.length > 0) || skipResumeLinePause;
          if (skipResumeLinePause) skipResumeLinePause = false;
          if (!passingThrough && this.shouldPauseAtLine(proc.body[j].sourcePath)) {
            this.pauseRequested = true;

            // Initialize/update the paused states stack with this procedure's state
            const states: any[] = (this as any)._pausedProcStates || [];
            // Remove any existing entry for this procedure
            const idx = states.findIndex((s: any) => s.procName === name && s.callSiteLine === callSiteLine);
            if (idx !== -1) {
              states.splice(idx, 1);
            }
            states.unshift({
              procName: name,
              callSiteLine,
              savedVars,
              returnIndex: i,
              bodyIndex: j
            });
            (this as any)._pausedProcStates = states;

            await this.pauseExecution();
            throw new PauseException();
          }
        }

        // Execute all commands on this line
        while (j < proc.body.length && !this.stopExecution && !this.pauseRequested) {
          const tokenLine = proc.body[j].line;
          if (tokenLine !== currentLineNum) {
            break;
          }
          this.setCurrentLocation(tokenLine, proc.body[j].sourcePath);
          const result = await this.executeCommand(proc.body, j);
          j = result.nextIndex;
        }
        // Guard passed for this line — clear so breakpoints re-trigger on revisit
        this.lastSteppedLine = -1;
        }
      });
    } catch (e) {
      if (e instanceof StopException) {
        // STOP just exits this procedure
      } else if (e instanceof PauseException) {
        pausedException = e;

        // If a nested procedure completed via stepOut, advance j past it
        if (typeof (this as any)._stepOutNextIndex === 'number') {
          j = (this as any)._stepOutNextIndex;
          delete (this as any)._stepOutNextIndex;
        }

        // Push this procedure's state onto the stack so outer procedures can resume correctly.
        // Only push if the top of the stack isn't already this procedure (avoid duplicates
        // when the pause originated at this level's breakpoint check above).
        const states: any[] = (this as any)._pausedProcStates || [];
        const topIsThisProc = states.length > 0 && states[0].procName === name && states[0].callSiteLine === callSiteLine;
        if (!topIsThisProc) {
          states.unshift({
            procName: name,
            callSiteLine,
            savedVars,
            returnIndex: i,
            bodyIndex: j
          });
          (this as any)._pausedProcStates = states;
        }
      } else {
        throw e;
      }
    } finally {
      if (!pausedException) {
        this.callStack.pop();

        // Restore variables before any stepOut pause
        const localVars = this.variables;
        this.variables = savedVars;

        for (const [key, value] of localVars) {
          const isParam = proc.params.some(p => (p.startsWith(':') ? p.substring(1) : p) === key);
          if (savedVars.has(key) && !isParam) {
            this.variables.set(key, value);
          }
        }

        if (this.stepMode === 'stepOut' && this.callStack.length < this.stepStartCallStackDepth) {
          if (typeof callSiteLine === 'number') {
            this.setCurrentLocation(callSiteLine, this.rootSourcePath);
          }
          this.saveExecutionStateIfVisible(this.rootSourcePath);
          this.pauseRequested = true;
          await this.pauseExecution();
          // Save the nextIndex so callers catching PauseException can advance
          // past the completed procedure call instead of re-executing it.
          (this as any)._stepOutNextIndex = i;
          throw new PauseException();
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
    // Parse left-to-right so operators are left-associative.
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

    // Number literal
    if (/^-?[0-9]+(\.[0-9]+)?$/.test(token.value)) {
      return { value: parseFloat(token.value), nextIndex: startIndex + 1 };
    }

    if (token.value.startsWith('"')) {
      return { value: token.value.substring(1), nextIndex: startIndex + 1 };
    }

    // Variable
    if (token.value.startsWith(':')) {
      const varName = token.value.substring(1); // Remove ':' prefix
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

    // Parenthesized expression
    if (token.value === '(') {
      const expr = await this.parseExpression(tokens, startIndex + 1);
      // Skip closing paren if present
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

    // Parse values until we hit the closing bracket
    while (i < tokens.length && tokens[i].value !== ']') {
      const result = await this.evaluateExpression(tokens, i);
      values.push(this.asNumber(result.value));
      i = result.nextIndex;
    }

    // Skip the closing bracket
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

    const pausedLoadStates: Array<{ targetPath: string; tokens: LogoToken[]; index: number }> =
      (this as any)._pausedLoadStates || [];
    const pausedLoadStateIndex = pausedLoadStates.findIndex(state => state.targetPath === normalizedPath);

    let loadedTokens: LogoToken[];
    let index = 0;
    if (pausedLoadStateIndex !== -1) {
      const pausedState = pausedLoadStates.splice(pausedLoadStateIndex, 1)[0];
      (this as any)._pausedLoadStates = pausedLoadStates;
      loadedTokens = pausedState.tokens;
      index = pausedState.index;
    } else {
      let source: string;
      try {
        source = fs.readFileSync(normalizedPath, 'utf8');
      } catch (error) {
        throw new Error(`LOAD failed for ${normalizedPath}: ${error instanceof Error ? error.message : String(error)}`);
      }

      this.parse(source, normalizedPath);
      loadedTokens = this.tokenize(source, normalizedPath);
    }

    this.activeLoadStack.push(normalizedPath);
    try {
      const opaqueLoadedExecution = this.debugMode && this.stepMode === 'stepOver';
      await this.runOpaqueIfNeeded(opaqueLoadedExecution, async () => {
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
          this.setCurrentLocation(currentLineNum, token.sourcePath);
          this.saveExecutionStateIfVisible(token.sourcePath);
          if (this.shouldPauseAtLine(token.sourcePath)) {
            this.savePausedLoadState(normalizedPath, loadedTokens, index);
            this.pauseRequested = true;
            await this.pauseExecution();
            throw new PauseException();
          }

          try {
            while (index < loadedTokens.length &&
                   !this.stopExecution &&
                   loadedTokens[index].line === currentLineNum) {
              const result = await this.executeCommand(loadedTokens, index);
              index = result.nextIndex;
            }
          } catch (e) {
            if (e instanceof PauseException) {
              this.savePausedLoadState(normalizedPath, loadedTokens, index);
            }
            throw e;
          }
          this.lastSteppedLine = -1;
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
