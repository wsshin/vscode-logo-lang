// Logo Runtime - implements the Logo language interpreter

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

export interface LogoProcedure {
  name: string;
  params: string[];
  body: any[];
  sourceLineStart: number;
  sourceLineEnd: number;
}

export interface ExecutionState {
  turtle: TurtleState;
  variables: Map<string, number>;
  drawCommands: DrawCommand[];
  callStack: Array<{ procedure: string; line: number; vars: Map<string, number> }>;
  currentLine: number;
  executionIndex: number;
}

export type StepMode = 'continue' | 'stepOver' | 'stepIn' | 'stepOut' | null;

export class LogoRuntime {
  private turtle: TurtleState = {
    x: 0,
    y: 0,
    angle: 0,
    penDown: true,
    penColor: '#000000',
    visible: true
  };

  private procedures: Map<string, LogoProcedure> = new Map();
  private variables: Map<string, number> = new Map();
  private callStack: Array<{ procedure: string; line: number; vars: Map<string, number> }> = [];
  private drawCommands: DrawCommand[] = [];
  private sourceLines: string[] = [];
  private currentLine: number = 0;
  private stopExecution: boolean = false;
  private breakpoints: Set<number> = new Set();
  private stepMode: StepMode = null;
  private stepStartCallStackDepth: number = 0;
  private executionHistory: ExecutionState[] = [];
  private maxHistorySize: number = 1000;
  private onStepCallback?: () => void;
  private pauseRequested: boolean = false;
  private executionTokens: Array<{ value: string; line: number }> = [];
  private executionIndex: number = 0;
  private justResumed: boolean = false;
  private lastSteppedLine: number = -1;
  private insideSingleLineBlock: boolean = false;

  constructor() {}

  public loadProgram(source: string): void {
    this.sourceLines = source.split('\n');
    this.procedures.clear();
    this.variables.clear();
    this.drawCommands = [];
    this.resetTurtle();
    this.parse(source);
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
    return this.callStack.map(frame => ({
      procedure: frame.procedure,
      line: frame.line
    }));
  }

  public getVariables(): Map<string, number> {
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
      vars: new Map(frame.vars)
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
        vars: new Map(frame.vars)
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

  private shouldPause(): boolean {
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

  private parse(source: string): void {
    const tokens = this.tokenize(source);
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

  private tokenize(source: string): Array<{ value: string; line: number }> {
    const tokens: Array<{ value: string; line: number }> = [];
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
      const parts = line.match(/:[A-Za-z_][A-Za-z0-9_]*|"[^"]*"|\(|\)|\[|\]|[^\s\[\]\(\)]+/g) || [];

      for (const part of parts) {
        // If it's not a variable or string, further split on operators
        if (!part.startsWith(':') && !part.startsWith('"') && !['(', ')', '[', ']'].includes(part)) {
          // Split on operators while keeping them
          const subParts = part.split(/([+\-*\/=<>])/).filter(p => p.length > 0);
          for (const subPart of subParts) {
            tokens.push({ value: subPart, line: lineNum + 1 });
          }
        } else {
          tokens.push({ value: part, line: lineNum + 1 });
        }
      }
    }

    return tokens;
  }

  private parseProcedure(
    tokens: Array<{ value: string; line: number }>,
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
      procedure: { name, params, body, sourceLineStart: startLine, sourceLineEnd: endLine },
      nextIndex: i + 1
    };
  }

  public async execute(): Promise<boolean> {
    if (this.pauseRequested) {
      // We're paused, so we should resume from where we left off
      this.pauseRequested = false;
      this.justResumed = true; // Skip first pause check
    } else {
      // Starting fresh execution
      this.stopExecution = false;
      this.executionTokens = this.tokenize(this.sourceLines.join('\n'));
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
        // Save state before executing (for reverse debugging)
        this.saveExecutionState();

        // Check if we should pause before executing this line
        // When resuming, skip breakpoint check if we're on the same line we just paused at
        // (to avoid immediately re-triggering the same breakpoint)
        const shouldPauseForBreakpoint = this.breakpoints.has(this.currentLine) &&
                                         (!this.justResumed || this.currentLine !== this.lastSteppedLine);
        const shouldPauseForStepMode = !this.justResumed && this.shouldPauseForStepMode();

        if (shouldPauseForBreakpoint || shouldPauseForStepMode) {
          this.pauseRequested = true;
          await this.pauseExecution();
          return false; // Paused, not complete
        }

        // If this is a top-level REPEAT and we're stepping in from the REPEAT line,
        // clear `justResumed` now so the nested block will pause at its first line.
        const tokenIsRepeat = token.value.toUpperCase() === 'REPEAT';
        const clearJustResumedNow = tokenIsRepeat && this.stepMode === 'stepIn' && this.lastSteppedLine === currentLineNum;
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
            // Pause was requested from nested context, return false to indicate pause
            return false;
          }
          // Re-throw other exceptions
          throw e;
        } finally {
          // Clear the justResumed flag after we've executed (or paused)
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
    tokens: Array<{ value: string; line: number }>,
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
      this.forward(distance.value);
      return { nextIndex: distance.nextIndex };
    }

    if (cmd === 'BK' || cmd === 'BACK' || cmd === 'BACKWARD') {
      const distance = await this.evaluateExpression(tokens, startIndex + 1);
      this.forward(-distance.value);
      return { nextIndex: distance.nextIndex };
    }

    if (cmd === 'ARC') {
      const angle = await this.evaluateExpression(tokens, startIndex + 1);
      const radius = await this.evaluateExpression(tokens, angle.nextIndex);
      this.arc(angle.value, radius.value);
      return { nextIndex: radius.nextIndex };
    }

    if (cmd === 'RT' || cmd === 'RIGHT') {
      const angle = await this.evaluateExpression(tokens, startIndex + 1);
      this.turtle.angle += angle.value;
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
      this.turtle.angle -= angle.value;
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
      this.turtle.angle = angle.value;
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
      this.turtle.penColor = this.numberToColor(color.value);
      return { nextIndex: color.nextIndex };
    }

    // Control structures
    if (cmd === 'REPEAT') {
      return await this.executeRepeat(tokens, startIndex);
    }

    if (cmd === 'IF') {
      return await this.executeIf(tokens, startIndex);
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

      const result = await this.evaluateExpression(tokens, valueIndex);
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
    tokens: Array<{ value: string; line: number }>,
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
    // Support resuming from a pause inside a REPEAT by restoring saved state
    let repStart = 0;
    let resumeJ: number | null = null;
    const pausedState = (this as any)._pausedRepeatState;
    if (pausedState && pausedState.startIndex === startIndex) {
      repStart = pausedState.rep;
      resumeJ = pausedState.j;
    }

    for (let rep = repStart; rep < count.value && !this.stopExecution && !this.pauseRequested; rep++) {
      let j = resumeJ !== null ? resumeJ : blockStart;
      resumeJ = null; // only use resumeJ for first loop
      let lastLineInBlock = -1;

      while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
        // Get the current line number
        const currentLineNum = j < tokens.length ? tokens[j].line : -1;

        // For multi-line blocks, check if we moved to a new line
        if (!isSingleLine && currentLineNum !== lastLineInBlock && currentLineNum !== -1) {
          lastLineInBlock = currentLineNum;
          this.currentLine = currentLineNum;

          // Save state for reverse debugging
          this.saveExecutionState();

          // Check if we should pause (skip breakpoint if on same line we just resumed from)
          const shouldPauseForBreakpoint = this.breakpoints.has(this.currentLine) &&
                                           (!this.justResumed || this.currentLine !== this.lastSteppedLine);
          const shouldPauseForStepMode = !this.justResumed && this.shouldPauseForStepMode();

          if (shouldPauseForBreakpoint || shouldPauseForStepMode) {
            // Only pause if we are not suppressing pauses for this block
            if (!(this as any)._suppressPauseCounter) {
              // Save repeat state to resume later
              (this as any)._pausedRepeatState = {
                startIndex,
                count: count.value,
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
                (this as any)._pausedRepeatState = {
                  startIndex,
                  count: count.value,
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
          }
          this.justResumed = false;
        }

        // Execute all commands on this line
        while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
          const tokenLine = tokens[j].line;

          // If we've moved to a different line, break to trigger pause check
          if (tokenLine !== currentLineNum) {
            break;
          }

          this.currentLine = tokenLine;
          const result = await this.executeCommand(tokens, j);
          j = result.nextIndex;
        }
      }
    }

    // Clear single-line block flag
    this.insideSingleLineBlock = false;

    // Clear suppression counter if set
    if (suppressPauseForThisBlock) {
      (this as any)._suppressPauseCounter = Math.max(0, ((this as any)._suppressPauseCounter || 1) - 1);
    }

    // Clear paused repeat state now that we've completed the repeat
    if ((this as any)._pausedRepeatState && (this as any)._pausedRepeatState.startIndex === startIndex) {
      delete (this as any)._pausedRepeatState;
    }
    return { nextIndex: i };
  }

  private async executeIf(
    tokens: Array<{ value: string; line: number }>,
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
    if (condition.value !== 0) {
      let j = blockStart;
      let lastLineInBlock = -1;

      while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
        // Get the current line number
        const currentLineNum = j < tokens.length ? tokens[j].line : -1;

        // For multi-line blocks, check if we moved to a new line
        if (!isSingleLine && currentLineNum !== lastLineInBlock && currentLineNum !== -1) {
          lastLineInBlock = currentLineNum;
          this.currentLine = currentLineNum;

          // Save state for reverse debugging
          this.saveExecutionState();

          // Check if we should pause (skip breakpoint if on same line we just resumed from)
          const shouldPauseForBreakpoint = this.breakpoints.has(this.currentLine) &&
                                           (!this.justResumed || this.currentLine !== this.lastSteppedLine);
          const shouldPauseForStepMode = !this.justResumed && this.shouldPauseForStepMode();

          if (shouldPauseForBreakpoint || shouldPauseForStepMode) {
            this.insideSingleLineBlock = false;
            this.pauseRequested = true;
            await this.pauseExecution();
            throw new PauseException(); // Throw to bubble up and pause execution
          }
          this.justResumed = false;
        }

        // Execute all commands on this line
        while (j < blockEnd && !this.stopExecution && !this.pauseRequested) {
          const tokenLine = tokens[j].line;

          // If we've moved to a different line, break to trigger pause check
          if (tokenLine !== currentLineNum) {
            break;
          }

          this.currentLine = tokenLine;
          const result = await this.executeCommand(tokens, j);
          j = result.nextIndex;
        }
      }
    }

    // Clear single-line block flag
    this.insideSingleLineBlock = false;

    return { nextIndex: i };
  }

  private async executeProcedure(
    name: string,
    tokens: Array<{ value: string; line: number }>,
    startIndex: number,
    callSiteLine?: number
  ): Promise<{ nextIndex: number; value?: any }> {
    const proc = this.procedures.get(name);
    if (!proc) {
      return { nextIndex: startIndex };
    }

    // Check if we're resuming from a paused state inside this procedure
    const pausedState = (this as any)._pausedProcState;
    const isResuming = pausedState && pausedState.procName === name &&
                       pausedState.callSiteLine === callSiteLine &&
                       pausedState.callStackDepth === this.callStack.length;

    let savedVars: Map<string, number>;
    let i: number;

    if (isResuming) {
      // Resuming from pause - restore saved state
      savedVars = pausedState.savedVars;
      i = pausedState.returnIndex;
      // Clear the paused state
      delete (this as any)._pausedProcState;
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
        vars: new Map(this.variables)
      });

      // If the user requested a 'stepIn' from the call site, pause at the procedure entry now
      // We do this after argument binding and after pushing the call frame so the stack reflects the entry
      if (this.stepMode === 'stepIn' && typeof callSiteLine === 'number' && this.lastSteppedLine === callSiteLine) {
        // Ensure we can pause immediately (clear justResumed which is set on resume)
        this.justResumed = false;

        // Pause at procedure definition line
        this.currentLine = proc.sourceLineStart;
        this.saveExecutionState();
        if (this.shouldPause()) {
          this.pauseRequested = true;
          (this as any)._pausedOnProcedureEntry = { callSiteLine, procName: name };

          // Save state to resume from this point
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

    // Execute procedure body
    let j = 0;
    let stopped = false;
    let lastLineInProc = -1;
    let pausedException: PauseException | null = null; // Track if we're exiting due to pause

    try {
      while (j < proc.body.length && !this.stopExecution && !this.pauseRequested) {
        // Get the current line number
        const currentLineNum = j < proc.body.length ? proc.body[j].line : -1;

        // Check if we moved to a new line
        if (currentLineNum !== lastLineInProc && currentLineNum !== -1) {
          lastLineInProc = currentLineNum;
          this.currentLine = currentLineNum;

          // Save state for reverse debugging
          this.saveExecutionState();

          // Check if we should pause (skip breakpoint if on same line we just resumed from)
          const shouldPauseForBreakpoint = this.breakpoints.has(this.currentLine) &&
                                           (!this.justResumed || this.currentLine !== this.lastSteppedLine);
          const shouldPauseForStepMode = !this.justResumed && this.shouldPauseForStepMode();

          if (shouldPauseForBreakpoint || shouldPauseForStepMode) {
            this.pauseRequested = true;

            // Save state to resume from this point
            (this as any)._pausedProcState = {
              procName: name,
              callSiteLine,
              savedVars,
              returnIndex: i,
              callStackDepth: this.callStack.length
            };

            await this.pauseExecution();
            throw new PauseException(); // Throw to bubble up and pause execution
          }
          this.justResumed = false;
        }

        // Execute all commands on this line
        while (j < proc.body.length && !this.stopExecution && !this.pauseRequested) {
          const tokenLine = proc.body[j].line;

          // If we've moved to a different line, break to trigger pause check
          if (tokenLine !== currentLineNum) {
            break;
          }

          this.currentLine = tokenLine;
          const result = await this.executeCommand(proc.body, j);
          j = result.nextIndex;
        }
      }
    } catch (e) {
      if (e instanceof StopException) {
        stopped = true;
        // STOP just exits this procedure, not the whole program
      } else if (e instanceof PauseException) {
        // Save the pause exception so finally block knows we're pausing (not completing)
        pausedException = e;

        // Save procedure state so we can resume from here
        (this as any)._pausedProcState = {
          procName: name,
          callSiteLine,
          savedVars,
          returnIndex: i,
          callStackDepth: this.callStack.length
        };

        // Don't re-throw here - let finally block handle it after cleanup decision
      } else {
        throw e;
      }
    } finally {
      // Only pop the stack and restore variables if we're actually completing (not pausing mid-execution)
      if (!pausedException) {
        // Remove from call stack
        this.callStack.pop();

        // Check if we should pause after returning from the procedure (for step out)
        if (this.stepMode === 'stepOut' && this.callStack.length < this.stepStartCallStackDepth) {
          // Update current line to the call site so debugger shows correct location
          if (typeof callSiteLine === 'number') {
            this.currentLine = callSiteLine;
          }
          this.saveExecutionState();
          this.pauseRequested = true;
          await this.pauseExecution();
          throw new PauseException();
        }

        // Restore variables (keep only the original variables, discard procedure-local ones)
        // But preserve any global variables that were modified
        const localVars = this.variables;
        this.variables = savedVars;

        // Copy back any variables that existed before and were modified
        for (const [key, value] of localVars) {
          // Check if this is not a parameter (params are now stored without ':' prefix)
          const isParam = proc.params.some(p => (p.startsWith(':') ? p.substring(1) : p) === key);
          if (savedVars.has(key) && !isParam) {
            this.variables.set(key, value);
          }
        }
      }
    }

    // If we caught a pause exception, re-throw it after finally block has run
    if (pausedException) {
      throw pausedException;
    }

    return { nextIndex: i };
  }

  private async evaluateExpression(
    tokens: Array<{ value: string; line: number }>,
    startIndex: number
  ): Promise<{ value: number; nextIndex: number }> {
    if (startIndex >= tokens.length) {
      return { value: 0, nextIndex: startIndex };
    }

    return this.parseExpression(tokens, startIndex);
  }

  private async parseExpression(
    tokens: Array<{ value: string; line: number }>,
    startIndex: number
  ): Promise<{ value: number; nextIndex: number }> {
    // Parse primary (number or variable)
    const primary = await this.parsePrimary(tokens, startIndex);

    // Check for binary operator
    if (primary.nextIndex < tokens.length) {
      const op = tokens[primary.nextIndex].value;

      if (['+', '-', '*', '/', '=', '<', '>'].includes(op)) {
        const right = await this.parseExpression(tokens, primary.nextIndex + 1);

        let result = 0;
        switch (op) {
          case '+': result = primary.value + right.value; break;
          case '-': result = primary.value - right.value; break;
          case '*': result = primary.value * right.value; break;
          case '/': result = right.value !== 0 ? primary.value / right.value : 0; break;
          case '=': result = primary.value === right.value ? 1 : 0; break;
          case '<': result = primary.value < right.value ? 1 : 0; break;
          case '>': result = primary.value > right.value ? 1 : 0; break;
        }

        return { value: result, nextIndex: right.nextIndex };
      }
    }

    return primary;
  }

  private async parsePrimary(
    tokens: Array<{ value: string; line: number }>,
    startIndex: number
  ): Promise<{ value: number; nextIndex: number }> {
    if (startIndex >= tokens.length) {
      return { value: 0, nextIndex: startIndex };
    }

    const token = tokens[startIndex];

    // Number literal
    if (/^-?[0-9]+(\.[0-9]+)?$/.test(token.value)) {
      return { value: parseFloat(token.value), nextIndex: startIndex + 1 };
    }

    // Variable
    if (token.value.startsWith(':')) {
      const varName = token.value.substring(1); // Remove ':' prefix
      const value = this.variables.get(varName) || 0;
      return { value, nextIndex: startIndex + 1 };
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

    let varName = tokenValue.substring(1);
    // Accept both Logo-style words ("name) and full quoted strings ("name")
    if (varName.endsWith('"')) {
      varName = varName.substring(0, varName.length - 1);
    }

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
      throw new Error('MAKE expects first argument to be a quoted variable name');
    }

    return varName;
  }

  private async parseListArgument(
    tokens: Array<{ value: string; line: number }>,
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
      values.push(result.value);
      i = result.nextIndex;
    }

    // Skip the closing bracket
    if (i < tokens.length && tokens[i].value === ']') {
      i++;
    }

    return { values, nextIndex: i };
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
