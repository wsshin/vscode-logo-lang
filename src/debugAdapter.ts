// Debug Adapter for Logo language
import {
  DebugSession,
  InitializedEvent,
  TerminatedEvent,
  StoppedEvent,
  BreakpointEvent,
  OutputEvent,
  Event,
  Thread,
  StackFrame,
  Scope,
  Source,
  Handles,
  Breakpoint
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { LogoRuntime, DrawCommand } from './logoRuntime';
import * as fs from 'fs';
import * as path from 'path';

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  program: string;
  stopOnEntry?: boolean;
  trace?: boolean;
}

export class LogoDebugSession extends DebugSession {
  private static THREAD_ID = 1;
  private runtime: LogoRuntime;
  private variableHandles = new Handles<string>();
  private breakpoints = new Map<string, number[]>();
  private stopOnEntry: boolean = false;
  private currentSourceFile: string = '';
  private sourceLines: string[] = [];
  private isRunning: boolean = false;

  constructor() {
    super();
    this.runtime = new LogoRuntime();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    args: DebugProtocol.InitializeRequestArguments
  ): void {
    response.body = response.body || {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsEvaluateForHovers = true;
    response.body.supportsStepBack = true;
    response.body.supportsStepInTargetsRequest = false;
    response.body.supportsSetVariable = false;
    response.body.supportsRestartRequest = false;

    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments
  ): Promise<void> {
    this.stopOnEntry = args.stopOnEntry || false;
    this.currentSourceFile = args.program;

    try {
      const source = fs.readFileSync(args.program, 'utf-8');
      this.sourceLines = source.split('\n');
      this.runtime.loadProgram(source);

      // Set up callback for PRINT output – send as custom event so
      // the extension can route it to the dedicated LOGO terminal.
      this.runtime.setPrintCallback((message: string) => {
        this.sendEvent(new Event('logo.printOutput', { text: message }));
      });

      // Set up callback for when execution pauses
      this.runtime.setStepCallback(() => {
        // Send current draw commands to update SVG
        const drawCommands = this.runtime.getDrawCommands();
        this.sendEvent(new OutputEvent(
          JSON.stringify({ type: 'drawCommands', commands: drawCommands }) + '\n',
          'stdout'
        ));
        
        this.sendEvent(new StoppedEvent('step', LogoDebugSession.THREAD_ID));
      });

      this.sendEvent(new OutputEvent(`Loaded Logo program: ${args.program}\n`));
      
      if (this.stopOnEntry) {
        this.sendEvent(new StoppedEvent('entry', LogoDebugSession.THREAD_ID));
      } else {
        // Start execution in continue mode
        this.continueExecution();
      }

      this.sendResponse(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sendErrorResponse(response, {
        id: 1001,
        format: `Cannot load program: ${errorMessage}`
      });
    }
  }

  protected setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ): void {
    const path = args.source.path as string;
    const clientLines = args.lines || [];

    this.breakpoints.set(path, clientLines);
    
    // Update runtime breakpoints
    this.runtime.setBreakpoints(clientLines);

    const breakpoints = clientLines.map(line => {
      const bp: DebugProtocol.Breakpoint = new Breakpoint(true, line);
      bp.id = this.convertClientLineToDebugger(line);
      return bp;
    });

    response.body = {
      breakpoints: breakpoints
    };

    this.sendResponse(response);
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = {
      threads: [new Thread(LogoDebugSession.THREAD_ID, 'Logo Main Thread')]
    };
    this.sendResponse(response);
  }

  protected stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments
  ): void {
    const callStack = this.runtime.getCallStack();
    const currentLine = this.runtime.getCurrentLine();

    const frames: StackFrame[] = [];

    // Current frame
    frames.push(
      new StackFrame(
        0,
        'main',
        new Source(
          path.basename(this.currentSourceFile),
          this.currentSourceFile
        ),
        currentLine,
        0
      )
    );

    // Call stack frames
    callStack.forEach((frame, index) => {
      frames.push(
        new StackFrame(
          index + 1,
          frame.procedure,
          new Source(
            path.basename(this.currentSourceFile),
            this.currentSourceFile
          ),
          frame.line,
          0
        )
      );
    });

    response.body = {
      stackFrames: frames,
      totalFrames: frames.length
    };

    this.sendResponse(response);
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments
  ): void {
    response.body = {
      scopes: [
        new Scope('Variables', this.variableHandles.create('variables'), false),
        new Scope('Turtle', this.variableHandles.create('turtle'), false)
      ]
    };
    this.sendResponse(response);
  }

  protected variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ): void {
    const variables: DebugProtocol.Variable[] = [];
    const id = this.variableHandles.get(args.variablesReference);

    if (id === 'variables') {
      const vars = this.runtime.getVariables();
      vars.forEach((value, name) => {
        variables.push({
          name: name,
          type: 'number',
          value: String(value),
          variablesReference: 0
        });
      });
    } else if (id === 'turtle') {
      const turtle = this.runtime.getTurtleState();
      variables.push(
        { name: 'x', type: 'number', value: turtle.x.toFixed(2), variablesReference: 0 },
        { name: 'y', type: 'number', value: turtle.y.toFixed(2), variablesReference: 0 },
        { name: 'heading', type: 'number', value: turtle.angle.toFixed(2), variablesReference: 0 },
        { name: 'penDown', type: 'boolean', value: String(turtle.penDown), variablesReference: 0 },
        { name: 'penColor', type: 'string', value: turtle.penColor, variablesReference: 0 }
      );
    }

    response.body = {
      variables: variables
    };

    this.sendResponse(response);
  }

  protected continueRequest(
    response: DebugProtocol.ContinueResponse,
    args: DebugProtocol.ContinueArguments
  ): void {
    this.runtime.setStepMode('continue');
    this.sendResponse(response);
    this.continueExecution();
  }

  protected nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments
  ): void {
    this.runtime.setStepMode('stepOver');
    this.sendResponse(response);
    this.continueExecution();
  }

  protected stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments
  ): void {
    this.runtime.setStepMode('stepIn');
    this.sendResponse(response);
    this.continueExecution();
  }

  protected stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments
  ): void {
    this.runtime.setStepMode('stepOut');
    this.sendResponse(response);
    this.continueExecution();
  }

  protected stepBackRequest(
    response: DebugProtocol.StepBackResponse,
    args: DebugProtocol.StepBackArguments
  ): void {
    const history = this.runtime.getExecutionHistory();
    
    if (history.length >= 2) {
      // Go back one state (the last entry is current, so we want the one before)
      const previousState = history[history.length - 2];
      this.runtime.restoreState(previousState);
      
      // Remove the last state from history
      history.pop();
      
      // Send updated draw commands for SVG
      const drawCommands = this.runtime.getDrawCommands();
      this.sendEvent(new OutputEvent(
        JSON.stringify({ type: 'drawCommands', commands: drawCommands }) + '\n',
        'stdout'
      ));
      
      this.sendEvent(new StoppedEvent('step back', LogoDebugSession.THREAD_ID));
    } else {
      this.sendEvent(new OutputEvent('Cannot step back: at beginning of execution\n', 'console'));
    }
    
    this.sendResponse(response);
  }

  protected reverseContinueRequest(
    response: DebugProtocol.ReverseContinueResponse,
    args: DebugProtocol.ReverseContinueArguments
  ): void {
    const history = this.runtime.getExecutionHistory();
    const sourceFile = this.currentSourceFile;
    const breakpoints = this.breakpoints.get(sourceFile) || [];
    
    if (history.length < 2) {
      this.sendEvent(new OutputEvent('Cannot reverse continue: at beginning of execution\n', 'console'));
      this.sendResponse(response);
      return;
    }
    
    // Step backward through history until we hit a breakpoint or reach the beginning
    let steppedBack = false;
    while (history.length >= 2) {
      // Remove current state
      history.pop();
      
      // Get previous state
      const previousState = history[history.length - 1];
      this.runtime.restoreState(previousState);
      steppedBack = true;
      
      // Check if this line has a breakpoint
      if (breakpoints.includes(previousState.currentLine)) {
        // Found a breakpoint, stop here
        break;
      }
    }
    
    if (steppedBack) {
      // Send updated draw commands for SVG
      const drawCommands = this.runtime.getDrawCommands();
      this.sendEvent(new OutputEvent(
        JSON.stringify({ type: 'drawCommands', commands: drawCommands }) + '\n',
        'stdout'
      ));
      
      this.sendEvent(new StoppedEvent('breakpoint', LogoDebugSession.THREAD_ID));
    } else {
      this.sendEvent(new OutputEvent('Cannot reverse continue: at beginning of execution\n', 'console'));
    }
    
    this.sendResponse(response);
  }

  protected evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ): void {
    const vars = this.runtime.getVariables();
    const value = vars.get(args.expression);

    if (value !== undefined) {
      response.body = {
        result: String(value),
        variablesReference: 0
      };
    } else {
      response.body = {
        result: 'undefined',
        variablesReference: 0
      };
    }

    this.sendResponse(response);
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    args: DebugProtocol.DisconnectArguments
  ): void {
    this.runtime.stop();
    this.sendResponse(response);
  }

  private async continueExecution(): Promise<void> {
    if (this.isRunning) return;
    
    this.isRunning = true;

    try {
      // Execute until breakpoint or completion
      const completed = await this.runtime.execute();
      
      if (completed) {
        // Send draw commands
        const drawCommands = this.runtime.getDrawCommands();
        this.sendEvent(new OutputEvent(
          JSON.stringify({ type: 'drawCommands', commands: drawCommands }) + '\n',
          'stdout'
        ));

        this.sendEvent(new TerminatedEvent());
      }
      // If not completed, execution is paused (callback will send StoppedEvent)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.sendEvent(new OutputEvent(`Error: ${errorMessage}\n`, 'stderr'));
      this.sendEvent(new TerminatedEvent());
    } finally {
      this.isRunning = false;
    }
  }
}

// Start the debug adapter
LogoDebugSession.run(LogoDebugSession);
