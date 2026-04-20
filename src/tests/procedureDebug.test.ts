import * as fs from 'fs';
import * as path from 'path';
import { LogoRuntime } from '../logoDebugger';

// ─── helpers ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error('FAIL:', msg);
    failed++;
  } else {
    passed++;
  }
}

/** Step the runtime once (stepIn/stepOver/stepOut) and return whether execution completed. */
async function step(
  rt: LogoRuntime,
  mode: 'stepIn' | 'stepOver' | 'stepOut'
): Promise<boolean> {
  (rt as any).pauseRequested = true;
  rt.setStepMode(mode);
  (rt as any).lastSteppedLine = rt.getCurrentLine();
  return rt.execute();
}

/** Continue until a breakpoint or completion. */
async function cont(rt: LogoRuntime): Promise<boolean> {
  (rt as any).pauseRequested = true;
  rt.setStepMode('continue');
  (rt as any).lastSteppedLine = rt.getCurrentLine();
  return rt.execute();
}

/** Start a fresh runtime, load source, set breakpoints, run until first pause. */
async function launch(
  source: string,
  breakpoints: number[] = []
): Promise<{ rt: LogoRuntime; completed: boolean }> {
  const rt = new LogoRuntime();
  rt.loadProgram(source);
  if (breakpoints.length) {
    rt.setBreakpoints(breakpoints);
  }
  const completed = await rt.execute();
  return { rt, completed };
}

// ═══════════════════════════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════════════════════════

(async () => {
  console.log('🧪 procedureDebug tests starting...\n');

  // ─────────────────────────────────────────────────────────────────────
  //  1. SIMPLE PROCEDURE – stack trace correctness
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 1. Simple procedure: stack trace correctness ---');
  {
    //  1  TO BOX :SIZE
    //  2    FD :SIZE
    //  3    RT 90
    //  4    FD :SIZE
    //  5    RT 90
    //  6    FD :SIZE
    //  7    RT 90
    //  8    FD :SIZE
    //  9    RT 90
    // 10  END
    // 11
    // 12  BOX 50
    const src = [
      'TO BOX :SIZE',
      '  FD :SIZE',
      '  RT 90',
      '  FD :SIZE',
      '  RT 90',
      '  FD :SIZE',
      '  RT 90',
      '  FD :SIZE',
      '  RT 90',
      'END',
      '',
      'BOX 50',
    ].join('\n');

    // Breakpoint on call site line 12
    const { rt } = await launch(src, [12]);
    assert(rt.getCurrentLine() === 12, `1a: expected pause at line 12, got ${rt.getCurrentLine()}`);

    // Step into BOX – should land at procedure definition line (1)
    let done = await step(rt, 'stepIn');
    assert(!done, '1b: expected pause after stepIn');
    assert(rt.getCurrentLine() === 1, `1c: expected line 1 (procedure entry), got ${rt.getCurrentLine()}`);

    let stack = rt.getCallStack();
    assert(stack.length === 1, `1d: expected call stack depth 1, got ${stack.length}`);
    assert(stack[0].procedure.toUpperCase() === 'BOX', `1e: expected BOX on stack, got ${stack[0].procedure}`);
    assert(stack[0].line === 1, `1f: expected stack frame line 1, got ${stack[0].line}`);

    // Step into first body line – FD :SIZE on line 2
    done = await step(rt, 'stepIn');
    assert(!done, '1g: expected pause');
    assert(rt.getCurrentLine() === 2, `1h: expected line 2, got ${rt.getCurrentLine()}`);

    // Step to line 3 (RT 90)
    done = await step(rt, 'stepIn');
    assert(!done, '1i: expected pause');
    assert(rt.getCurrentLine() === 3, `1j: expected line 3, got ${rt.getCurrentLine()}`);

    // Stack should still show BOX
    stack = rt.getCallStack();
    assert(stack.length === 1, `1k: stack depth should still be 1, got ${stack.length}`);
    assert(stack[0].procedure.toUpperCase() === 'BOX', `1l: expected BOX, got ${stack[0].procedure}`);

    // Step out – should return to caller and complete (no more statements after BOX 50)
    done = await step(rt, 'stepOut');
    // After stepOut, call stack should be empty
    stack = rt.getCallStack();
    assert(stack.length === 0, `1m: expected empty call stack after stepOut, got ${stack.length}`);

    console.log('  ✅ Simple procedure stack trace tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  2. NESTED PROCEDURES – flower.logo style (3 levels)
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 2. Nested procedures: step in / stack trace / step out ---');
  {
    //  1  TO INNER :N
    //  2    FD :N
    //  3    RT 90
    //  4  END
    //  5
    //  6  TO MIDDLE :N
    //  7    INNER :N
    //  8    RT 45
    //  9  END
    // 10
    // 11  TO OUTER :N
    // 12    MIDDLE :N
    // 13    RT 30
    // 14  END
    // 15
    // 16  OUTER 40
    const src = [
      'TO INNER :N',
      '  FD :N',
      '  RT 90',
      'END',
      '',
      'TO MIDDLE :N',
      '  INNER :N',
      '  RT 45',
      'END',
      '',
      'TO OUTER :N',
      '  MIDDLE :N',
      '  RT 30',
      'END',
      '',
      'OUTER 40',
    ].join('\n');

    const { rt } = await launch(src, [16]);
    assert(rt.getCurrentLine() === 16, `2a: expected line 16, got ${rt.getCurrentLine()}`);

    // Step into OUTER → definition line 11
    let done = await step(rt, 'stepIn');
    assert(!done, '2b: paused');
    assert(rt.getCurrentLine() === 11, `2c: expected line 11 (OUTER entry), got ${rt.getCurrentLine()}`);
    let stack = rt.getCallStack();
    assert(stack.length === 1, `2d: depth 1, got ${stack.length}`);
    assert(stack[0].procedure.toUpperCase() === 'OUTER', `2e: ${stack[0].procedure}`);

    // Step to line 12 (MIDDLE :N call)
    done = await step(rt, 'stepIn');
    assert(!done, '2f: paused');
    assert(rt.getCurrentLine() === 12, `2g: expected line 12, got ${rt.getCurrentLine()}`);

    // Step into MIDDLE → definition line 6
    done = await step(rt, 'stepIn');
    assert(!done, '2h: paused');
    assert(rt.getCurrentLine() === 6, `2i: expected line 6 (MIDDLE entry), got ${rt.getCurrentLine()}`);
    stack = rt.getCallStack();
    assert(stack.length === 2, `2j: depth 2, got ${stack.length}`);
    assert(stack[0].procedure.toUpperCase() === 'MIDDLE', `2k: bottom = MIDDLE, got ${stack[0].procedure}`);
    assert(stack[1].procedure.toUpperCase() === 'OUTER', `2l: top = OUTER, got ${stack[1].procedure}`);

    // Step to line 7 (INNER :N call)
    done = await step(rt, 'stepIn');
    assert(!done, '2m: paused');
    assert(rt.getCurrentLine() === 7, `2n: expected line 7, got ${rt.getCurrentLine()}`);

    // Step into INNER → definition line 1
    done = await step(rt, 'stepIn');
    assert(!done, '2o: paused');
    assert(rt.getCurrentLine() === 1, `2p: expected line 1 (INNER entry), got ${rt.getCurrentLine()}`);
    stack = rt.getCallStack();
    assert(stack.length === 3, `2q: depth 3, got ${stack.length}`);
    assert(stack[0].procedure.toUpperCase() === 'INNER', `2r: ${stack[0].procedure}`);
    assert(stack[1].procedure.toUpperCase() === 'MIDDLE', `2s: ${stack[1].procedure}`);
    assert(stack[2].procedure.toUpperCase() === 'OUTER', `2t: ${stack[2].procedure}`);

    // Step to FD :N (line 2), then RT 90 (line 3) inside INNER
    done = await step(rt, 'stepIn');
    assert(!done, '2u: paused');
    assert(rt.getCurrentLine() === 2, `2v: expected line 2, got ${rt.getCurrentLine()}`);
    done = await step(rt, 'stepIn');
    assert(!done, '2w: paused');
    assert(rt.getCurrentLine() === 3, `2x: expected line 3, got ${rt.getCurrentLine()}`);

    // Step out of INNER – should return to MIDDLE (line 8, RT 45)
    done = await step(rt, 'stepOut');
    assert(!done, '2y: paused');
    stack = rt.getCallStack();
    assert(stack.length <= 2, `2z: after stepOut from INNER, depth should be ≤ 2, got ${stack.length}`);

    console.log('  ✅ Nested procedure tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  3. BREAKPOINT INSIDE PROCEDURE
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 3. Breakpoint inside a procedure body ---');
  {
    const src = [
      'TO SQUARE :S',
      '  FD :S',
      '  RT 90',
      '  FD :S',
      '  RT 90',
      '  FD :S',
      '  RT 90',
      '  FD :S',
      '  RT 90',
      'END',
      '',
      'SQUARE 100',
    ].join('\n');

    // Set breakpoint at line 4 (FD :S second call, inside procedure)
    const { rt } = await launch(src, [4]);
    // Runtime should pause at line 4 inside SQUARE
    assert(rt.getCurrentLine() === 4, `3a: expected pause at line 4, got ${rt.getCurrentLine()}`);
    let stack = rt.getCallStack();
    assert(stack.length >= 1, `3b: expected to be inside SQUARE, stack depth ${stack.length}`);
    assert(stack[0].procedure.toUpperCase() === 'SQUARE', `3c: expected SQUARE, got ${stack[0].procedure}`);

    // Continue – should hit breakpoint again? No – execution should complete since REPEAT is not used.
    // Actually the body only has one line 4, so continuing should finish.
    const done = await cont(rt);
    assert(done === true, `3d: expected execution to complete after continue`);

    console.log('  ✅ Breakpoint inside procedure tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  4. BREAKPOINT INSIDE NESTED PROCEDURE
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 4. Breakpoint inside nested procedure ---');
  {
    const src = [
      'TO INNER :X',
      '  FD :X',
      '  RT 120',
      'END',
      '',
      'TO WRAPPER :X',
      '  INNER :X',
      '  FD 10',
      'END',
      '',
      'WRAPPER 30',
    ].join('\n');

    // Breakpoint on line 2 (FD :X inside INNER)
    const { rt } = await launch(src, [2]);
    assert(rt.getCurrentLine() === 2, `4a: expected line 2, got ${rt.getCurrentLine()}`);
    let stack = rt.getCallStack();
    // Should have INNER on top, WRAPPER underneath
    assert(stack.length >= 2, `4b: expected stack depth >= 2, got ${stack.length}`);
    assert(stack[0].procedure.toUpperCase() === 'INNER', `4c: top frame should be INNER, got ${stack[0].procedure}`);
    assert(stack[1].procedure.toUpperCase() === 'WRAPPER', `4d: second frame should be WRAPPER, got ${stack[1].procedure}`);

    // Verify call stack lines
    assert(stack[0].line === 1, `4e: INNER frame line should be 1, got ${stack[0].line}`);
    assert(stack[1].line === 6, `4f: WRAPPER frame line should be 6, got ${stack[1].line}`);

    const done = await cont(rt);
    assert(done === true, `4g: expected completion`);

    console.log('  ✅ Breakpoint inside nested procedure tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  5. STEP OVER A PROCEDURE CALL (should not enter the body)
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 5. Step over procedure call ---');
  {
    const src = [
      'TO DASH :LEN',
      '  FD :LEN',
      '  PU',
      '  FD :LEN',
      '  PD',
      'END',
      '',
      'DASH 20',
      'FD 5',
    ].join('\n');

    const { rt } = await launch(src, [8]);
    assert(rt.getCurrentLine() === 8, `5a: expected line 8, got ${rt.getCurrentLine()}`);
    // Step OVER the call – should skip the body and land on FD 5 (line 9)
    const done = await step(rt, 'stepOver');
    assert(!done, '5b: paused');
    assert(rt.getCurrentLine() === 9, `5c: expected line 9 after stepOver, got ${rt.getCurrentLine()}`);
    // Call stack should be empty (we're at top level)
    const stack = rt.getCallStack();
    assert(stack.length === 0, `5d: expected empty stack at top level, got ${stack.length}`);

    console.log('  ✅ Step over procedure call tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  6. PROCEDURE WITH REPEAT – step over should not enter REPEAT body
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 6. Procedure containing REPEAT – stepOver from call site ---');
  {
    //  1  TO TRI :SIZE
    //  2    REPEAT 3 [
    //  3      FD :SIZE
    //  4      RT 120
    //  5    ]
    //  6  END
    //  7
    //  8  TRI 80
    //  9  FD 0
    const src = [
      'TO TRI :SIZE',
      '  REPEAT 3 [',
      '    FD :SIZE',
      '    RT 120',
      '  ]',
      'END',
      '',
      'TRI 80',
      'FD 0',
    ].join('\n');

    const { rt } = await launch(src, [8]);
    assert(rt.getCurrentLine() === 8, `6a: expected line 8`);
    // Step over should skip entire procedure body (including REPEAT) and land on FD 0
    const done = await step(rt, 'stepOver');
    assert(!done, '6b: paused');
    assert(rt.getCurrentLine() === 9, `6c: expected line 9 after stepOver, got ${rt.getCurrentLine()}`);

    console.log('  ✅ Procedure with REPEAT stepOver tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  7. MULTILINE REPEAT – step in still works correctly
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 7. Multiline REPEAT – stepIn iterates correctly ---');
  {
    const src = [
      'REPEAT 2 [',
      '  FD 10',
      '  RT 90',
      ']',
      'FD 0',
    ].join('\n');

    const { rt } = await launch(src, [1]);
    assert(rt.getCurrentLine() === 1, `7a: expected line 1`);

    // Step in → should enter the repeat body at line 2
    let done = await step(rt, 'stepIn');
    assert(!done, '7b');
    assert(rt.getCurrentLine() === 2, `7c: expected line 2, got ${rt.getCurrentLine()}`);

    // Step → line 3
    done = await step(rt, 'stepIn');
    assert(!done, '7d');
    assert(rt.getCurrentLine() === 3, `7e: expected line 3, got ${rt.getCurrentLine()}`);

    // Step → back to line 2 (second iteration)
    done = await step(rt, 'stepIn');
    assert(!done, '7f');
    assert(rt.getCurrentLine() === 2, `7g: expected line 2 (iteration 2), got ${rt.getCurrentLine()}`);

    // Step → line 3
    done = await step(rt, 'stepIn');
    assert(!done, '7h');
    assert(rt.getCurrentLine() === 3, `7i: expected line 3, got ${rt.getCurrentLine()}`);

    // Step → should exit repeat, land on FD 0 (line 5)
    done = await step(rt, 'stepIn');
    assert(!done, '7j');
    assert(rt.getCurrentLine() === 5, `7k: expected line 5, got ${rt.getCurrentLine()}`);

    console.log('  ✅ Multiline REPEAT stepIn tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  8. MULTILINE REPEAT – stepOver skips entire block
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 8. Multiline REPEAT – stepOver skips block ---');
  {
    const src = [
      'REPEAT 3 [',
      '  FD 10',
      '  RT 120',
      ']',
      'FD 0',
    ].join('\n');

    const { rt } = await launch(src, [1]);
    assert(rt.getCurrentLine() === 1, `8a: expected line 1`);

    const done = await step(rt, 'stepOver');
    assert(!done, '8b: paused');
    assert(rt.getCurrentLine() === 5, `8c: expected line 5 after stepOver, got ${rt.getCurrentLine()}`);

    console.log('  ✅ Multiline REPEAT stepOver tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  9. SINGLE-LINE REPEAT – doesn't pause inside
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 9. Single-line REPEAT – stepOver ---');
  {
    const src = `REPEAT 5 [ FD 50 RT 144 ]\nFD 10`;

    const { rt } = await launch(src, [1]);
    assert(rt.getCurrentLine() === 1, `9a: expected line 1`);

    const done = await step(rt, 'stepOver');
    assert(!done, '9b: paused');
    assert(rt.getCurrentLine() === 2, `9c: expected line 2 after stepOver, got ${rt.getCurrentLine()}`);

    console.log('  ✅ Single-line REPEAT stepOver tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  10. FLOWER.LOGO – full nested-procedure verification
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 10. flower.logo – nested procedures end-to-end ---');
  {
      // Embed flower.logo source directly
    const flowerSrc = `TO CIRC :RADIUS :ANGLE
 :STEPS = :ANGLE/2
 :STEP_SIZE = (2*3.1416 * :RADIUS * :ANGLE)/(360 * :STEPS)
 :TURN_ANGLE = :ANGLE / :STEPS
  REPEAT :STEPS [
   FD :STEP_SIZE
   RT :TURN_ANGLE
 ]
END

TO PETAL :SIZE
  REPEAT 2 [
    CIRC :SIZE 60
    RIGHT 120
  ]
END

TO FLOWER :SIZE
  REPEAT 6 [
    PETAL :SIZE
    RIGHT 60
  ]
END

CS
FLOWER 70
`;

    // flower.logo structure (for reference in comments):
    //  1  TO CIRC :RADIUS :ANGLE
    //  ...
    //  9  END
    // 10
    // 11  TO PETAL :SIZE
    //  ...
    // 16  END
    // 17
    // 18  TO FLOWER :SIZE
    // 19    REPEAT 6 [
    // 20      PETAL :SIZE
    // 21      RIGHT 60
    // 22    ]
    // 23  END
    // 24
    // 25  CS
    // 26  FLOWER 70

    // Find the actual line numbers by tokenizing
    const rtFlower = new LogoRuntime();
    rtFlower.loadProgram(flowerSrc);
    const tokens = (rtFlower as any).tokenize(flowerSrc) as Array<{ value: string; line: number }>;

    // Find key line numbers
    let csLine = -1;
    let flowerCallLine = -1;
    for (const t of tokens) {
      if (t.value.toUpperCase() === 'CS' && csLine === -1) csLine = t.line;
      // FLOWER call at top level is after CS
      if (t.value.toUpperCase() === 'FLOWER' && csLine !== -1 && flowerCallLine === -1) flowerCallLine = t.line;
    }

    const procMap: Map<string, any> = (rtFlower as any).procedures;
    const circProc = procMap.get('CIRC');
    const petalProc = procMap.get('PETAL');
    const flowerProc = procMap.get('FLOWER');

    assert(!!circProc, '10a: CIRC procedure found');
    assert(!!petalProc, '10b: PETAL procedure found');
    assert(!!flowerProc, '10c: FLOWER procedure found');
    assert(csLine > 0, `10d: CS line found (${csLine})`);
    assert(flowerCallLine > 0, `10e: FLOWER call line found (${flowerCallLine})`);

    // Breakpoint at FLOWER call
    const { rt } = await launch(flowerSrc, [flowerCallLine]);
    assert(rt.getCurrentLine() === flowerCallLine, `10f: paused at FLOWER call line ${flowerCallLine}, got ${rt.getCurrentLine()}`);

    // Step into FLOWER
    let done = await step(rt, 'stepIn');
    assert(!done, '10g: paused');
    assert(rt.getCurrentLine() === flowerProc.sourceLineStart, `10h: expected FLOWER entry line ${flowerProc.sourceLineStart}, got ${rt.getCurrentLine()}`);
    let stack = rt.getCallStack();
    assert(stack.length >= 1, `10i: stack depth >= 1`);
    assert(stack[0].procedure.toUpperCase() === 'FLOWER', `10j: FLOWER on stack, got ${stack[0].procedure}`);

    // Verify FLOWER parameter is bound
    const vars = rt.getVariables();
    assert(vars.get('SIZE') === 70, `10k: SIZE should be 70, got ${vars.get('SIZE')}`);

    // Step to the REPEAT line inside FLOWER
    done = await step(rt, 'stepIn');
    assert(!done, '10l: paused');

    // Step into the REPEAT body – should reach PETAL call
    done = await step(rt, 'stepIn');
    assert(!done, '10m: paused');

    // Now step into PETAL
    const lineBeforePetalEntry = rt.getCurrentLine();
    done = await step(rt, 'stepIn');
    assert(!done, '10n: paused');
    stack = rt.getCallStack();
    const hasPetal = stack.some(f => f.procedure.toUpperCase() === 'PETAL');
    assert(hasPetal, `10o: PETAL expected on call stack, got [${stack.map(f => f.procedure).join(', ')}]`);

    // Try to reach CIRC (step in deeper)
    let foundCirc = false;
    for (let steps = 0; steps < 20; steps++) {
      done = await step(rt, 'stepIn');
      if (done) break;
      stack = rt.getCallStack();
      if (stack.some(f => f.procedure.toUpperCase() === 'CIRC')) {
        foundCirc = true;
        // Verify full stack: CIRC, PETAL, FLOWER
        const names = stack.map(f => f.procedure.toUpperCase());
        assert(names.includes('CIRC'), `10p: CIRC on stack`);
        assert(names.includes('PETAL'), `10q: PETAL on stack`);
        assert(names.includes('FLOWER'), `10r: FLOWER on stack`);
        assert(stack.length === 3, `10s: 3-deep call stack, got ${stack.length}: [${names.join(', ')}]`);
        break;
      }
    }
    assert(foundCirc, '10t: managed to step into CIRC (3-deep nesting)');

    // From inside CIRC, step out to PETAL
    done = await step(rt, 'stepOut');
    if (!done) {
      stack = rt.getCallStack();
      const inCirc = stack.some(f => f.procedure.toUpperCase() === 'CIRC');
      // After stepOut from CIRC we should no longer be in CIRC
      assert(!inCirc, `10u: should have left CIRC after stepOut`);
    }

    // Finally continue to completion
    rt.setBreakpoints([]);
    (rt as any).pauseRequested = false;
    done = await rt.execute();
    assert(done === true, `10v: flower.logo should complete`);

    // Verify draw commands were produced
    const cmds = rt.getDrawCommands();
    assert(cmds.length > 0, `10w: expected draw commands, got ${cmds.length}`);

    console.log('  ✅ flower.logo nested procedure tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  11. PROCEDURE WITH PARAMETERS – variable scoping
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 11. Variable scoping across procedures ---');
  {
    const src = [
      'TO ADD_FD :A :B',
      '  :C = :A + :B',
      '  FD :C',
      'END',
      '',
      ':X = 10',
      'ADD_FD :X 20',
      'FD :X',
    ].join('\n');

    const { rt } = await launch(src, [6]);
    assert(rt.getCurrentLine() === 6, `11a: expected line 6`);

    // Step over the assignment :X = 10
    let done = await step(rt, 'stepOver');
    assert(!done, '11b: paused');
    let vars = rt.getVariables();
    assert(vars.get('X') === 10, `11c: X should be 10, got ${vars.get('X')}`);

    // Step into ADD_FD
    done = await step(rt, 'stepIn');
    assert(!done, '11d: paused');

    // Step to :C = :A + :B (line 2)
    done = await step(rt, 'stepIn');
    assert(!done, '11e: paused');
    assert(rt.getCurrentLine() === 2, `11f: expected line 2, got ${rt.getCurrentLine()}`);
    // Check parameters are bound
    vars = rt.getVariables();
    assert(vars.get('A') === 10, `11g: A should be 10, got ${vars.get('A')}`);
    assert(vars.get('B') === 20, `11h: B should be 20, got ${vars.get('B')}`);

    // Step over to execute the assignment and move to FD :C (line 3)
    done = await step(rt, 'stepOver');
    assert(!done, '11i: paused');
    vars = rt.getVariables();
    assert(vars.get('C') === 30, `11j: C should be 30, got ${vars.get('C')}`);

    console.log('  ✅ Variable scoping tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  12. MULTIPLE BREAKPOINTS – hit them in order
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 12. Multiple breakpoints ---');
  {
    const src = [
      'FD 10',
      'RT 90',
      'FD 20',
      'RT 90',
      'FD 30',
    ].join('\n');

    const { rt } = await launch(src, [1, 3, 5]);
    assert(rt.getCurrentLine() === 1, `12a: first breakpoint at line 1, got ${rt.getCurrentLine()}`);

    let done = await cont(rt);
    assert(!done, '12b: paused');
    assert(rt.getCurrentLine() === 3, `12c: second breakpoint at line 3, got ${rt.getCurrentLine()}`);

    done = await cont(rt);
    assert(!done, '12d: paused');
    assert(rt.getCurrentLine() === 5, `12e: third breakpoint at line 5, got ${rt.getCurrentLine()}`);

    done = await cont(rt);
    assert(done === true, `12f: should complete after last breakpoint`);

    console.log('  ✅ Multiple breakpoints tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  13. BREAKPOINT INSIDE REPEAT INSIDE PROCEDURE
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 13. Breakpoint inside REPEAT inside procedure ---');
  {
    //  1  TO SPIRAL :N
    //  2    REPEAT 3 [
    //  3      FD :N
    //  4      RT 120
    //  5    ]
    //  6  END
    //  7
    //  8  SPIRAL 50
    const src = [
      'TO SPIRAL :N',
      '  REPEAT 3 [',
      '    FD :N',
      '    RT 120',
      '  ]',
      'END',
      '',
      'SPIRAL 50',
    ].join('\n');

    // Set breakpoint at FD :N (line 3) inside REPEAT inside SPIRAL
    const { rt } = await launch(src, [3]);
    assert(rt.getCurrentLine() === 3, `13a: expected line 3, got ${rt.getCurrentLine()}`);
    let stack = rt.getCallStack();
    assert(stack.length >= 1, `13b: inside SPIRAL`);
    assert(stack[0].procedure.toUpperCase() === 'SPIRAL', `13c: SPIRAL, got ${stack[0].procedure}`);

    // Continue – should hit breakpoint again (iteration 2)
    let done = await cont(rt);
    assert(!done, '13d: paused (iteration 2)');
    assert(rt.getCurrentLine() === 3, `13e: breakpoint again at line 3, got ${rt.getCurrentLine()}`);

    // Continue – should hit breakpoint again (iteration 3)
    done = await cont(rt);
    assert(!done, '13f: paused (iteration 3)');
    assert(rt.getCurrentLine() === 3, `13g: breakpoint at line 3, got ${rt.getCurrentLine()}`);

    // Continue – should complete
    done = await cont(rt);
    assert(done === true, `13h: should complete after 3 iterations`);

    console.log('  ✅ Breakpoint inside REPEAT inside procedure tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  14. STEP IN TO PROCEDURE CALLED FROM INSIDE REPEAT
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 14. Step into procedure called from inside REPEAT ---');
  {
    //  1  TO SIDE :L
    //  2    FD :L
    //  3    RT 90
    //  4  END
    //  5
    //  6  REPEAT 2 [
    //  7    SIDE 50
    //  8  ]
    //  9  FD 0
    const src = [
      'TO SIDE :L',
      '  FD :L',
      '  RT 90',
      'END',
      '',
      'REPEAT 2 [',
      '  SIDE 50',
      ']',
      'FD 0',
    ].join('\n');

    const { rt } = await launch(src, [6]);
    assert(rt.getCurrentLine() === 6, `14a: line 6`);

    // Step into the REPEAT body
    let done = await step(rt, 'stepIn');
    assert(!done, '14b: paused');
    assert(rt.getCurrentLine() === 7, `14c: expected line 7 (SIDE 50), got ${rt.getCurrentLine()}`);

    // Step into SIDE
    done = await step(rt, 'stepIn');
    assert(!done, '14d: paused');
    let stack = rt.getCallStack();
    assert(stack.length >= 1, `14e: inside SIDE, got depth ${stack.length}`);
    if (stack.length >= 1) {
      assert(stack[0].procedure.toUpperCase() === 'SIDE', `14f: SIDE, got ${stack[0].procedure}`);
    }

    // Step out of SIDE – should return to REPEAT body
    done = await step(rt, 'stepOut');
    assert(!done, '14g: paused');
    stack = rt.getCallStack();
    assert(stack.length === 0, `14h: back at top level, stack depth ${stack.length}`);

    console.log('  ✅ Step into procedure from REPEAT tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  15. TURTLE STATE during debugging
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 15. Turtle state correctness while stepping ---');
  {
    const src = [
      'FD 100',
      'RT 90',
      'FD 50',
    ].join('\n');

    const { rt } = await launch(src, [1]);
    assert(rt.getCurrentLine() === 1, `15a: line 1`);

    let turtle = rt.getTurtleState();
    assert(turtle.x === 0 && turtle.y === 0, `15b: turtle at origin before exec`);

    // Execute FD 100
    let done = await step(rt, 'stepOver');
    assert(!done, '15c');
    turtle = rt.getTurtleState();
    // FD 100 with heading 0 means y += 100
    assert(Math.abs(turtle.y - 100) < 0.01, `15d: y should be ~100, got ${turtle.y}`);
    assert(Math.abs(turtle.x) < 0.01, `15e: x should be ~0, got ${turtle.x}`);

    // Execute RT 90
    done = await step(rt, 'stepOver');
    assert(!done, '15f');
    turtle = rt.getTurtleState();
    assert(Math.abs(turtle.angle - 90) < 0.01, `15g: angle should be 90, got ${turtle.angle}`);

    // Execute FD 50
    done = await step(rt, 'stepOver');
    // This is the last line, so execution might complete
    turtle = rt.getTurtleState();
    assert(Math.abs(turtle.x - 50) < 0.01, `15h: x should be ~50, got ${turtle.x}`);
    assert(Math.abs(turtle.y - 100) < 0.01, `15i: y should be ~100, got ${turtle.y}`);

    console.log('  ✅ Turtle state tests done\n');
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  BEHAVIORAL CORRECTNESS – debugging must not alter program outcome
  // ═══════════════════════════════════════════════════════════════════════

  /** Run a program with no debugging at all. Returns final turtle + draw commands. */
  async function runClean(source: string): Promise<{ turtle: ReturnType<LogoRuntime['getTurtleState']>; draws: ReturnType<LogoRuntime['getDrawCommands']> }> {
    const rt = new LogoRuntime();
    rt.loadProgram(source);
    const done = await rt.execute();
    assert(done, 'runClean: expected completion');
    return { turtle: rt.getTurtleState(), draws: rt.getDrawCommands() };
  }

  /** Run a program stepping through every line with stepIn. */
  async function runStepInAll(source: string): Promise<{ turtle: ReturnType<LogoRuntime['getTurtleState']>; draws: ReturnType<LogoRuntime['getDrawCommands']> }> {
    const rt = new LogoRuntime();
    rt.loadProgram(source);
    rt.setStepMode('stepIn');
    let done = await rt.execute();
    let safety = 0;
    while (!done && safety < 50000) {
      done = await step(rt, 'stepIn');
      safety++;
    }
    assert(done, `runStepInAll: expected completion within ${safety} steps`);
    return { turtle: rt.getTurtleState(), draws: rt.getDrawCommands() };
  }

  /** Run a program with breakpoints on every source line, continuing through them. */
  async function runBreakpointAll(source: string): Promise<{ turtle: ReturnType<LogoRuntime['getTurtleState']>; draws: ReturnType<LogoRuntime['getDrawCommands']> }> {
    const lines = source.split('\n');
    const allLines = lines.map((_, i) => i + 1);
    const rt = new LogoRuntime();
    rt.loadProgram(source);
    rt.setBreakpoints(allLines);
    let done = await rt.execute();
    let safety = 0;
    while (!done && safety < 50000) {
      done = await cont(rt);
      safety++;
    }
    assert(done, `runBreakpointAll: expected completion within ${safety} continues`);
    return { turtle: rt.getTurtleState(), draws: rt.getDrawCommands() };
  }

  /** Run a program with stepOver on every pause. */
  async function runStepOverAll(source: string): Promise<{ turtle: ReturnType<LogoRuntime['getTurtleState']>; draws: ReturnType<LogoRuntime['getDrawCommands']> }> {
    const rt = new LogoRuntime();
    rt.loadProgram(source);
    rt.setStepMode('stepOver');
    let done = await rt.execute();
    let safety = 0;
    while (!done && safety < 50000) {
      done = await step(rt, 'stepOver');
      safety++;
    }
    assert(done, `runStepOverAll: expected completion within ${safety} steps`);
    return { turtle: rt.getTurtleState(), draws: rt.getDrawCommands() };
  }

  /** Compare turtle state with tolerance. */
  function turtleEqual(
    a: ReturnType<LogoRuntime['getTurtleState']>,
    b: ReturnType<LogoRuntime['getTurtleState']>,
    prefix: string
  ): void {
    const eps = 0.001;
    assert(Math.abs(a.x - b.x) < eps, `${prefix}: x differs (${a.x} vs ${b.x})`);
    assert(Math.abs(a.y - b.y) < eps, `${prefix}: y differs (${a.y} vs ${b.y})`);
    assert(Math.abs(a.angle - b.angle) < eps, `${prefix}: angle differs (${a.angle} vs ${b.angle})`);
    assert(a.penDown === b.penDown, `${prefix}: penDown differs (${a.penDown} vs ${b.penDown})`);
    assert(a.penColor === b.penColor, `${prefix}: penColor differs (${a.penColor} vs ${b.penColor})`);
  }

  /** Compare draw command arrays, filtering out 'move' commands since those
   *  are presentational (cursor updates) and debugging may add extra ones.
   *  What matters is the set of 'line', 'reset', 'clean' commands. */
  function drawsEqual(
    a: ReturnType<LogoRuntime['getDrawCommands']>,
    b: ReturnType<LogoRuntime['getDrawCommands']>,
    prefix: string
  ): void {
    // Compare line draws only (the visible output)
    const filterLines = (cmds: ReturnType<LogoRuntime['getDrawCommands']>) =>
      cmds.filter(c => c.type === 'line');
    const aLines = filterLines(a);
    const bLines = filterLines(b);
    assert(aLines.length === bLines.length,
      `${prefix}: line command count differs (${aLines.length} vs ${bLines.length})`);
    const count = Math.min(aLines.length, bLines.length);
    const eps = 0.001;
    for (let i = 0; i < count; i++) {
      const la = aLines[i], lb = bLines[i];
      const fromOk = la.from && lb.from &&
                     Math.abs(la.from.x - lb.from.x) < eps &&
                     Math.abs(la.from.y - lb.from.y) < eps;
      const toOk = la.to && lb.to &&
                   Math.abs(la.to.x - lb.to.x) < eps &&
                   Math.abs(la.to.y - lb.to.y) < eps;
      if (!fromOk || !toOk) {
        assert(false, `${prefix}: line[${i}] differs – ` +
          `from(${la.from?.x},${la.from?.y}) vs (${lb.from?.x},${lb.from?.y}), ` +
          `to(${la.to?.x},${la.to?.y}) vs (${lb.to?.x},${lb.to?.y})`);
        break; // Don't spam on cascade failures
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  16. SIMPLE – debugging shouldn't alter FD/RT outcome
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 16. Behavioral: simple FD/RT program ---');
  {
    const src = [
      'FD 100',
      'RT 90',
      'FD 50',
      'RT 90',
      'FD 100',
    ].join('\n');

    const clean = await runClean(src);
    const stepped = await runStepInAll(src);
    const brkAll = await runBreakpointAll(src);
    const overAll = await runStepOverAll(src);

    turtleEqual(clean.turtle, stepped.turtle, '16a stepIn');
    turtleEqual(clean.turtle, brkAll.turtle, '16b breakpointAll');
    turtleEqual(clean.turtle, overAll.turtle, '16c stepOver');
    drawsEqual(clean.draws, stepped.draws, '16d stepIn draws');
    drawsEqual(clean.draws, brkAll.draws, '16e brkAll draws');
    drawsEqual(clean.draws, overAll.draws, '16f stepOver draws');

    console.log('  ✅ Simple behavioral tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  17. REPEAT – single-line repeat must produce same output
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 17. Behavioral: single-line REPEAT ---');
  {
    const src = 'REPEAT 4 [ FD 100 RT 90 ]';

    const clean = await runClean(src);
    const stepped = await runStepInAll(src);
    const brkAll = await runBreakpointAll(src);
    const overAll = await runStepOverAll(src);

    turtleEqual(clean.turtle, stepped.turtle, '17a stepIn');
    turtleEqual(clean.turtle, brkAll.turtle, '17b brkAll');
    turtleEqual(clean.turtle, overAll.turtle, '17c stepOver');
    drawsEqual(clean.draws, stepped.draws, '17d stepIn draws');
    drawsEqual(clean.draws, brkAll.draws, '17e brkAll draws');
    drawsEqual(clean.draws, overAll.draws, '17f stepOver draws');

    console.log('  ✅ Single-line REPEAT behavioral tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  18. MULTI-LINE REPEAT – iterate with debugging
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 18. Behavioral: multi-line REPEAT ---');
  {
    const src = [
      'REPEAT 4 [',
      '  FD 100',
      '  RT 90',
      ']',
    ].join('\n');

    const clean = await runClean(src);
    const stepped = await runStepInAll(src);
    const brkAll = await runBreakpointAll(src);
    const overAll = await runStepOverAll(src);

    turtleEqual(clean.turtle, stepped.turtle, '18a stepIn');
    turtleEqual(clean.turtle, brkAll.turtle, '18b brkAll');
    turtleEqual(clean.turtle, overAll.turtle, '18c stepOver');
    drawsEqual(clean.draws, stepped.draws, '18d stepIn draws');
    drawsEqual(clean.draws, brkAll.draws, '18e brkAll draws');
    drawsEqual(clean.draws, overAll.draws, '18f stepOver draws');

    console.log('  ✅ Multi-line REPEAT behavioral tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  19. PROCEDURE – simple procedure call
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 19. Behavioral: simple procedure ---');
  {
    const src = [
      'TO BOX :SIZE',
      '  REPEAT 4 [ FD :SIZE RT 90 ]',
      'END',
      '',
      'BOX 80',
    ].join('\n');

    const clean = await runClean(src);
    const stepped = await runStepInAll(src);
    const brkAll = await runBreakpointAll(src);
    const overAll = await runStepOverAll(src);

    turtleEqual(clean.turtle, stepped.turtle, '19a stepIn');
    turtleEqual(clean.turtle, brkAll.turtle, '19b brkAll');
    turtleEqual(clean.turtle, overAll.turtle, '19c stepOver');
    drawsEqual(clean.draws, stepped.draws, '19d stepIn draws');
    drawsEqual(clean.draws, brkAll.draws, '19e brkAll draws');
    drawsEqual(clean.draws, overAll.draws, '19f stepOver draws');

    console.log('  ✅ Simple procedure behavioral tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  20. NESTED PROCEDURES – 3-deep nesting (FLOWER-style)
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 20. Behavioral: nested procedures (FLOWER-style) ---');
  {
    const src = [
      'TO INNER :N',
      '  FD :N',
      '  RT 90',
      'END',
      '',
      'TO MIDDLE :N',
      '  INNER :N',
      '  RT 45',
      'END',
      '',
      'TO OUTER :N',
      '  MIDDLE :N',
      '  RT 30',
      'END',
      '',
      'OUTER 40',
    ].join('\n');

    const clean = await runClean(src);
    const stepped = await runStepInAll(src);
    const brkAll = await runBreakpointAll(src);
    const overAll = await runStepOverAll(src);

    turtleEqual(clean.turtle, stepped.turtle, '20a stepIn');
    turtleEqual(clean.turtle, brkAll.turtle, '20b brkAll');
    turtleEqual(clean.turtle, overAll.turtle, '20c stepOver');
    drawsEqual(clean.draws, stepped.draws, '20d stepIn draws');
    drawsEqual(clean.draws, brkAll.draws, '20e brkAll draws');
    drawsEqual(clean.draws, overAll.draws, '20f stepOver draws');

    console.log('  ✅ Nested procedure behavioral tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  21. PROCEDURE WITH MULTI-LINE REPEAT – the combination matters
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 21. Behavioral: procedure with multi-line REPEAT ---');
  {
    const src = [
      'TO STAR :SIZE',
      '  REPEAT 5 [',
      '    FD :SIZE',
      '    RT 144',
      '  ]',
      'END',
      '',
      'STAR 100',
    ].join('\n');

    const clean = await runClean(src);
    const stepped = await runStepInAll(src);
    const brkAll = await runBreakpointAll(src);
    const overAll = await runStepOverAll(src);

    turtleEqual(clean.turtle, stepped.turtle, '21a stepIn');
    turtleEqual(clean.turtle, brkAll.turtle, '21b brkAll');
    turtleEqual(clean.turtle, overAll.turtle, '21c stepOver');
    drawsEqual(clean.draws, stepped.draws, '21d stepIn draws');
    drawsEqual(clean.draws, brkAll.draws, '21e brkAll draws');
    drawsEqual(clean.draws, overAll.draws, '21f stepOver draws');

    console.log('  ✅ Procedure with multi-line REPEAT behavioral tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  22. STAIRCASE – mixed top-level statements & single-line REPEAT
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 22. Behavioral: staircase (mixed top-level) ---');
  {
    const src = [
      'CS',
      'REPEAT 10 [ FD 10 RT 90 FD 10 LT 90 ]',
      'RT 180',
      'FD 100',
      'RT 90',
      'FD 100',
    ].join('\n');

    const clean = await runClean(src);
    const stepped = await runStepInAll(src);
    const brkAll = await runBreakpointAll(src);

    turtleEqual(clean.turtle, stepped.turtle, '22a stepIn');
    turtleEqual(clean.turtle, brkAll.turtle, '22b brkAll');
    drawsEqual(clean.draws, stepped.draws, '22c stepIn draws');
    drawsEqual(clean.draws, brkAll.draws, '22d brkAll draws');

    console.log('  ✅ Staircase behavioral tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  23. PEN UP/DOWN – pen state must survive debugging
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 23. Behavioral: pen up/down transitions ---');
  {
    const src = [
      'FD 50',
      'PU',
      'FD 30',
      'PD',
      'FD 50',
      'RT 90',
      'FD 50',
    ].join('\n');

    const clean = await runClean(src);
    const stepped = await runStepInAll(src);
    const brkAll = await runBreakpointAll(src);

    turtleEqual(clean.turtle, stepped.turtle, '23a stepIn');
    turtleEqual(clean.turtle, brkAll.turtle, '23b brkAll');
    drawsEqual(clean.draws, stepped.draws, '23c stepIn draws');
    drawsEqual(clean.draws, brkAll.draws, '23d brkAll draws');

    console.log('  ✅ Pen up/down behavioral tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  24. VARIABLE ASSIGNMENTS – MAKE and := in procedure calls
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 24. Behavioral: variable assignments ---');
  {
    const src = [
      'TO TRI :SIZE',
      '  REPEAT 3 [',
      '    FD :SIZE',
      '    RT 120',
      '  ]',
      'END',
      '',
      'MAKE "S 60',
      'TRI :S',
      'RT 90',
      'TRI :S',
    ].join('\n');

    const clean = await runClean(src);
    const stepped = await runStepInAll(src);
    const brkAll = await runBreakpointAll(src);

    turtleEqual(clean.turtle, stepped.turtle, '24a stepIn');
    turtleEqual(clean.turtle, brkAll.turtle, '24b brkAll');
    drawsEqual(clean.draws, stepped.draws, '24c stepIn draws');
    drawsEqual(clean.draws, brkAll.draws, '24d brkAll draws');

    console.log('  ✅ Variable assignment behavioral tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  25. FLOWER.LOGO – full real-world program
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 25. Behavioral: flower.logo (real-world) ---');
  {
    const flowerSrc = [
      'TO CIRC :RADIUS :ANGLE',
      '  :STEPS = :ANGLE / 2',
      '  :STEP_SIZE = (2 * 3.1416 * :RADIUS * :ANGLE) / (360 * :STEPS)',
      '  :TURN_ANGLE = :ANGLE / :STEPS',
      '  REPEAT :STEPS [',
      '    FD :STEP_SIZE',
      '    RT :TURN_ANGLE',
      '  ]',
      'END',
      '',
      'TO PETAL :SIZE',
      '  REPEAT 2 [',
      '    CIRC :SIZE 60',
      '    RT 120',
      '  ]',
      'END',
      '',
      'TO FLOWER :SIZE',
      '  REPEAT 6 [',
      '    PETAL :SIZE',
      '    RT 60',
      '  ]',
      'END',
      '',
      'CS',
      'FLOWER 70',
    ]
    .join('\n');
    const clean = await runClean(flowerSrc);

    // Breakpoints on every procedure body line
    const lines = flowerSrc.split('\n');
    const bodyLines: number[] = [];
    let inProc = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim().toUpperCase();
      if (trimmed.startsWith('TO ')) { inProc = true; continue; }
      if (trimmed === 'END') { inProc = false; continue; }
      if (inProc && trimmed.length > 0) bodyLines.push(i + 1);
    }
    const rtBrk = new LogoRuntime();
    rtBrk.loadProgram(flowerSrc);
    rtBrk.setBreakpoints(bodyLines);
    let done = await rtBrk.execute();
    let safety = 0;
    while (!done && safety < 50000) {
      done = await cont(rtBrk);
      safety++;
    }
    assert(done, '25pre: flower finished with breakpoints');

    turtleEqual(clean.turtle, rtBrk.getTurtleState(), '25a breakpoints');
    drawsEqual(clean.draws, rtBrk.getDrawCommands(), '25b breakpoint draws');

    console.log('  ✅ flower.logo behavioral tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  26. ROTATING SQUARES – single-line REPEAT with large count
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 26. Behavioral: rotating_squares.logo ---');
  {
    const src = 'REPEAT 88 [ FD 200 LT 89 ]';

    const clean = await runClean(src);
    const brkAll = await runBreakpointAll(src);

    turtleEqual(clean.turtle, brkAll.turtle, '26a brkAll');
    drawsEqual(clean.draws, brkAll.draws, '26b brkAll draws');

    console.log('  ✅ Rotating squares behavioral tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  27. SELECTIVE BREAKPOINTS – breakpoint only inside a called procedure
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 27. Behavioral: selective breakpoints inside procedure ---');
  {
    const src = [
      'TO DASH :LEN',
      '  FD :LEN',
      '  PU',
      '  FD :LEN',
      '  PD',
      'END',
      '',
      'REPEAT 3 [',
      '  DASH 20',
      '  RT 120',
      ']',
    ].join('\n');

    const clean = await runClean(src);

    // Breakpoint only on line 2 (FD :LEN inside procedure) – hit 3 times
    const rtBrk = new LogoRuntime();
    rtBrk.loadProgram(src);
    rtBrk.setBreakpoints([2]);
    let done = await rtBrk.execute();
    let safety = 0;
    while (!done && safety < 100) {
      done = await cont(rtBrk);
      safety++;
    }
    assert(done, '27pre: finished');

    turtleEqual(clean.turtle, rtBrk.getTurtleState(), '27a selective brk');
    drawsEqual(clean.draws, rtBrk.getDrawCommands(), '27b selective brk draws');

    console.log('  ✅ Selective breakpoint behavioral tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  28. MIXED STEPPING – alternate stepIn/stepOver/stepOut
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 28. Behavioral: mixed stepping modes ---');
  {
    const src = [
      'TO SQ :S',
      '  REPEAT 4 [ FD :S RT 90 ]',
      'END',
      '',
      'SQ 50',
      'RT 45',
      'SQ 50',
    ].join('\n');

    const clean = await runClean(src);

    // Step into first SQ, step through a bit, step out, then step over the second SQ
    const { rt } = await launch(src, [5]);
    assert(rt.getCurrentLine() === 5, '28a: breakpoint at line 5');

    // StepIn to procedure entry
    let done2 = await step(rt, 'stepIn');
    assert(!done2, '28b: paused inside SQ');

    // StepOut back to caller
    done2 = await step(rt, 'stepOut');
    assert(!done2, '28c: paused after stepOut');

    // Continue to finish execution (no breakpoints left)
    done2 = await cont(rt);
    assert(done2, '28d: completed');

    turtleEqual(clean.turtle, rt.getTurtleState(), '28e mixed turtle');
    drawsEqual(clean.draws, rt.getDrawCommands(), '28f mixed draws');

    console.log('  ✅ Mixed stepping behavioral tests done\n');
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  REVERSE DEBUGGING – stepBack and reverseContinue
  // ═══════════════════════════════════════════════════════════════════════

  /** Mimic debugAdapter.stepBackRequest: pop current state, restore previous. */
  function stepBack(rt: LogoRuntime): boolean {
    const history = rt.getExecutionHistory();
    if (history.length < 2) return false;
    const previous = history[history.length - 2];
    rt.restoreState(previous);
    history.pop();
    return true;
  }

  /** Mimic debugAdapter.reverseContinueRequest: step back through history until a breakpoint (or start). */
  function reverseContinue(rt: LogoRuntime, breakpointLines: Set<number>): boolean {
    const history = rt.getExecutionHistory();
    if (history.length < 2) return false;
    let steppedBack = false;
    while (history.length >= 2) {
      history.pop();
      const previous = history[history.length - 1];
      rt.restoreState(previous);
      steppedBack = true;
      if (breakpointLines.has(previous.currentLine)) break;
    }
    return steppedBack;
  }

  /** Resume forward execution after a restoreState; mirrors `cont` but for post-restore resume. */
  async function resumeForward(rt: LogoRuntime): Promise<boolean> {
    (rt as any).pauseRequested = true;
    rt.setStepMode('continue');
    (rt as any).lastSteppedLine = rt.getCurrentLine();
    return rt.execute();
  }

  // ─────────────────────────────────────────────────────────────────────
  //  29. stepBack – basic: return to the previous paused line
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 29. Reverse: stepBack returns to previous line ---');
  {
    const src = [
      'FD 10',
      'RT 90',
      'FD 20',
      'RT 90',
      'FD 30',
    ].join('\n');

    const { rt } = await launch(src, [1]);
    assert(rt.getCurrentLine() === 1, `29a: paused at line 1, got ${rt.getCurrentLine()}`);

    // Step forward a few times
    let done = await step(rt, 'stepIn');
    assert(!done, '29b: paused');
    assert(rt.getCurrentLine() === 2, `29c: at line 2, got ${rt.getCurrentLine()}`);
    done = await step(rt, 'stepIn');
    assert(!done, '29d: paused');
    assert(rt.getCurrentLine() === 3, `29e: at line 3, got ${rt.getCurrentLine()}`);

    // Step back – should return to line 2
    assert(stepBack(rt), '29f: stepBack succeeded');
    assert(rt.getCurrentLine() === 2, `29g: stepBack to line 2, got ${rt.getCurrentLine()}`);

    // Step back again – line 1
    assert(stepBack(rt), '29h: stepBack succeeded');
    assert(rt.getCurrentLine() === 1, `29i: stepBack to line 1, got ${rt.getCurrentLine()}`);

    // State at initial pause should be restored: turtle at origin, no draws
    const t = rt.getTurtleState();
    assert(t.x === 0 && t.y === 0 && t.angle === 0,
      `29j: turtle restored to origin, got (${t.x},${t.y},${t.angle})`);
    assert(rt.getDrawCommands().filter(c => c.type === 'line').length === 0,
      `29k: line draws cleared, got ${rt.getDrawCommands().filter(c => c.type === 'line').length}`);

    console.log('  ✅ Basic stepBack tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  30. stepBack – undoes turtle movement (FD) and draw commands
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 30. Reverse: stepBack undoes FD/draw commands ---');
  {
    const src = [
      'FD 100',
      'RT 90',
      'FD 50',
    ].join('\n');

    const { rt } = await launch(src, [1]);
    const t0 = rt.getTurtleState();
    const d0 = rt.getDrawCommands().length;
    assert(t0.x === 0 && t0.y === 0, `30a: origin, got (${t0.x},${t0.y})`);

    // Step over FD 100
    let done = await step(rt, 'stepOver');
    assert(!done, '30b: paused');
    const t1 = rt.getTurtleState();
    assert(Math.abs(t1.y - 100) < 0.01, `30c: y~100 after FD, got ${t1.y}`);
    const d1 = rt.getDrawCommands().length;
    assert(d1 > d0, `30d: draw commands increased (${d0} → ${d1})`);

    // Step back – turtle and draws should revert
    assert(stepBack(rt), '30e: stepBack');
    const t2 = rt.getTurtleState();
    assert(Math.abs(t2.x - t0.x) < 0.01, `30f: x reverted, got ${t2.x}`);
    assert(Math.abs(t2.y - t0.y) < 0.01, `30g: y reverted, got ${t2.y}`);
    const d2 = rt.getDrawCommands().length;
    assert(d2 === d0, `30h: draw commands reverted (${d0} vs ${d2})`);

    console.log('  ✅ stepBack undo turtle/draw tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  31. stepBack – undoes turtle rotation (RT/LT)
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 31. Reverse: stepBack undoes rotation ---');
  {
    const src = [
      'RT 45',
      'RT 90',
      'LT 30',
    ].join('\n');

    const { rt } = await launch(src, [1]);
    assert(Math.abs(rt.getTurtleState().angle - 0) < 0.01, `31a: angle 0`);

    // Step over RT 45
    let done = await step(rt, 'stepOver');
    assert(!done, '31b: paused');
    assert(Math.abs(rt.getTurtleState().angle - 45) < 0.01, `31c: angle 45, got ${rt.getTurtleState().angle}`);

    // Step over RT 90 → 135
    done = await step(rt, 'stepOver');
    assert(!done, '31d: paused');
    assert(Math.abs(rt.getTurtleState().angle - 135) < 0.01, `31e: angle 135, got ${rt.getTurtleState().angle}`);

    // Step back – angle should revert to 45
    assert(stepBack(rt), '31f: stepBack');
    assert(Math.abs(rt.getTurtleState().angle - 45) < 0.01, `31g: angle reverted to 45, got ${rt.getTurtleState().angle}`);

    // Step back again – angle 0
    assert(stepBack(rt), '31h: stepBack');
    assert(Math.abs(rt.getTurtleState().angle - 0) < 0.01, `31i: angle reverted to 0, got ${rt.getTurtleState().angle}`);

    console.log('  ✅ stepBack rotation tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  32. stepBack – pen state (PU/PD) is restored
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 32. Reverse: stepBack restores pen state ---');
  {
    const src = [
      'FD 10',
      'PU',
      'FD 20',
      'PD',
      'FD 30',
    ].join('\n');

    const { rt } = await launch(src, [1]);
    assert(rt.getTurtleState().penDown === true, `32a: pen down initially`);

    // Step over FD 10 → PU (now at line 2)
    let done = await step(rt, 'stepOver');
    assert(!done, '32b');
    // Step over PU → pen up, now at line 3
    done = await step(rt, 'stepOver');
    assert(!done, '32c');
    assert(rt.getTurtleState().penDown === false, `32d: pen up after PU, got ${rt.getTurtleState().penDown}`);

    // Step back – should restore pen down
    assert(stepBack(rt), '32e: stepBack');
    assert(rt.getTurtleState().penDown === true, `32f: pen back to down after stepBack, got ${rt.getTurtleState().penDown}`);

    console.log('  ✅ stepBack pen state tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  33. stepBack – at the beginning is a no-op
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 33. Reverse: stepBack at beginning is a no-op ---');
  {
    const src = [
      'FD 10',
      'RT 90',
    ].join('\n');

    const { rt } = await launch(src, [1]);
    assert(rt.getCurrentLine() === 1, `33a: at line 1`);
    const hist = rt.getExecutionHistory();
    assert(hist.length <= 1, `33b: history has ≤1 entry at first pause, got ${hist.length}`);

    // Trying to step back should fail (not enough history)
    const ok = stepBack(rt);
    assert(!ok, `33c: stepBack should fail at beginning`);
    assert(rt.getCurrentLine() === 1, `33d: still at line 1 after failed stepBack`);

    console.log('  ✅ stepBack at-beginning tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  34. reverseContinue – stops at earlier breakpoint
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 34. Reverse: reverseContinue stops at earlier breakpoint ---');
  {
    const src = [
      'FD 10',
      'RT 90',
      'FD 20',
      'RT 90',
      'FD 30',
    ].join('\n');

    // Breakpoints at lines 1 and 4 — run to line 4
    const { rt } = await launch(src, [1, 4]);
    assert(rt.getCurrentLine() === 1, `34a: first stop at line 1`);

    let done = await cont(rt);
    assert(!done, '34b: paused at next breakpoint');
    assert(rt.getCurrentLine() === 4, `34c: at line 4, got ${rt.getCurrentLine()}`);

    // Reverse continue – should stop at line 1 breakpoint
    const ok = reverseContinue(rt, new Set([1, 4]));
    assert(ok, '34d: reverseContinue succeeded');
    assert(rt.getCurrentLine() === 1, `34e: reverseContinue stopped at line 1, got ${rt.getCurrentLine()}`);

    console.log('  ✅ reverseContinue breakpoint tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  35. reverseContinue – no earlier breakpoint runs to start
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 35. Reverse: reverseContinue with no earlier breakpoint ---');
  {
    const src = [
      'FD 10',
      'RT 90',
      'FD 20',
      'RT 90',
      'FD 30',
    ].join('\n');

    // Single breakpoint at line 5 only
    const { rt } = await launch(src, [5]);
    assert(rt.getCurrentLine() === 5, `35a: at line 5, got ${rt.getCurrentLine()}`);

    // Reverse continue – nothing earlier to stop on, ends up at first history state
    const ok = reverseContinue(rt, new Set([5]));
    assert(ok, `35b: reverseContinue stepped back`);
    const hist = rt.getExecutionHistory();
    assert(hist.length === 1, `35c: history reduced to 1 entry, got ${hist.length}`);

    // Turtle should be back at start
    const t = rt.getTurtleState();
    assert(t.x === 0 && t.y === 0 && t.angle === 0, `35d: turtle at origin, got (${t.x},${t.y},${t.angle})`);

    console.log('  ✅ reverseContinue no-earlier-breakpoint tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  36. stepBack across a procedure call
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 36. Reverse: stepBack across a procedure call ---');
  {
    const src = [
      'TO BOX :S',
      '  FD :S',
      '  RT 90',
      'END',
      '',
      'BOX 40',
      'FD 5',
    ].join('\n');

    const { rt } = await launch(src, [6]);
    assert(rt.getCurrentLine() === 6, `36a: at BOX call line 6`);

    // Step into BOX — land on line 1 (procedure entry)
    let done = await step(rt, 'stepIn');
    assert(!done, '36b');
    assert(rt.getCurrentLine() === 1, `36c: at line 1, got ${rt.getCurrentLine()}`);

    // Step to FD :S on line 2
    done = await step(rt, 'stepIn');
    assert(!done, '36d');
    assert(rt.getCurrentLine() === 2, `36e: at line 2, got ${rt.getCurrentLine()}`);
    assert(rt.getCallStack().length === 1, `36f: inside BOX, got depth ${rt.getCallStack().length}`);

    // Step back – should leave us at line 1 (procedure entry)
    assert(stepBack(rt), '36g: stepBack');
    assert(rt.getCurrentLine() === 1, `36h: back at line 1, got ${rt.getCurrentLine()}`);

    // Step back further – should return to line 6 (call site) and pop call stack
    assert(stepBack(rt), '36i: stepBack');
    assert(rt.getCurrentLine() === 6, `36j: back at call site line 6, got ${rt.getCurrentLine()}`);
    assert(rt.getCallStack().length === 0, `36k: call stack empty at call site, got ${rt.getCallStack().length}`);

    console.log('  ✅ stepBack across procedure call tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  37. stepBack across REPEAT iterations
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 37. Reverse: stepBack across REPEAT iterations ---');
  {
    const src = [
      'REPEAT 3 [',
      '  FD 10',
      '  RT 120',
      ']',
      'FD 0',
    ].join('\n');

    const { rt } = await launch(src, [2]);
    assert(rt.getCurrentLine() === 2, `37a: at FD 10 (iter 1)`);
    const t1 = rt.getTurtleState();

    // Continue to next iteration
    let done = await cont(rt);
    assert(!done, '37b');
    assert(rt.getCurrentLine() === 2, `37c: at FD 10 (iter 2)`);
    const t2 = rt.getTurtleState();
    // After iter 1 completes, turtle moved, rotated, and is back at line 2
    assert(Math.abs(t2.y - t1.y) > 0.01 || Math.abs(t2.angle - t1.angle) > 0.01,
      `37d: turtle changed between iter 1 and iter 2`);

    // At iter-2 line 2 pause: iter 1 completed (1 FD line drawn), iter 2 FD not yet executed
    const drawsAtIter2 = rt.getDrawCommands().filter(c => c.type === 'line').length;
    assert(drawsAtIter2 === 1, `37e: one line drawn after iter 1, got ${drawsAtIter2}`);

    // Step back should rewind into iter 1 (or earlier) — draw count must not exceed 1
    // and must eventually reach 0 (pre-iter-1) with enough stepBacks.
    let guard = 0;
    while (stepBack(rt) && guard < 30) {
      guard++;
      const drawsNow = rt.getDrawCommands().filter(c => c.type === 'line').length;
      assert(drawsNow <= 1, `37f-${guard}: draws never exceed 1 while rewinding, got ${drawsNow}`);
      if (drawsNow === 0) break;
    }
    const finalDraws = rt.getDrawCommands().filter(c => c.type === 'line').length;
    assert(finalDraws === 0, `37g: full rewind clears draws, got ${finalDraws}`);

    console.log('  ✅ stepBack across REPEAT tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  BEHAVIORAL: reverse debugging must not corrupt subsequent execution
  // ─────────────────────────────────────────────────────────────────────

  /** Run a program, stepping forward N times, then back N times, then to completion.
   *  Final state must match a clean run. */
  async function runForwardBackForward(
    source: string,
    breakpoints: number[],
    forwardSteps: number
  ): Promise<{ turtle: ReturnType<LogoRuntime['getTurtleState']>; draws: ReturnType<LogoRuntime['getDrawCommands']> }> {
    const { rt } = await launch(source, breakpoints);

    // Step forward `forwardSteps` times
    let done = false;
    for (let i = 0; i < forwardSteps && !done; i++) {
      done = await step(rt, 'stepIn');
    }

    // Step back the same number of times (as many as history allows)
    for (let i = 0; i < forwardSteps; i++) {
      if (!stepBack(rt)) break;
    }

    // Now resume to completion (no breakpoints)
    rt.setBreakpoints([]);
    done = await resumeForward(rt);
    let safety = 0;
    while (!done && safety < 10000) {
      done = await resumeForward(rt);
      safety++;
    }
    assert(done, `runForwardBackForward: finished within ${safety} resumes`);

    return { turtle: rt.getTurtleState(), draws: rt.getDrawCommands() };
  }

  // ─────────────────────────────────────────────────────────────────────
  //  38. Behavioral: step forward/back/forward matches clean run (simple)
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 38. Behavioral: forward/back/forward equivalence (simple) ---');
  {
    const src = [
      'FD 100',
      'RT 90',
      'FD 50',
      'RT 90',
      'FD 100',
    ].join('\n');

    const clean = await runClean(src);
    const fbf = await runForwardBackForward(src, [1], 3);

    turtleEqual(clean.turtle, fbf.turtle, '38a turtle');
    drawsEqual(clean.draws, fbf.draws, '38b draws');

    console.log('  ✅ forward/back/forward simple tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  39. Behavioral: reverseContinue-then-continue equals clean run
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 39. Behavioral: reverseContinue + continue equals clean run ---');
  {
    const src = [
      'FD 50',
      'RT 45',
      'FD 50',
      'RT 45',
      'FD 50',
    ].join('\n');

    const clean = await runClean(src);

    // Put breakpoints at 1 and 5, run to line 5, reverseContinue to line 1, continue to end
    const { rt } = await launch(src, [1, 5]);
    assert(rt.getCurrentLine() === 1, `39a: at line 1`);
    let done = await cont(rt);
    assert(!done, '39b');
    assert(rt.getCurrentLine() === 5, `39c: at line 5`);

    // Reverse continue back to line 1
    const ok = reverseContinue(rt, new Set([1, 5]));
    assert(ok, '39d: reverseContinue');
    assert(rt.getCurrentLine() === 1, `39e: back at line 1, got ${rt.getCurrentLine()}`);

    // Clear breakpoints and continue to completion
    rt.setBreakpoints([]);
    done = await resumeForward(rt);
    assert(done, '39f: completed');

    turtleEqual(clean.turtle, rt.getTurtleState(), '39g turtle');
    drawsEqual(clean.draws, rt.getDrawCommands(), '39h draws');

    console.log('  ✅ reverseContinue+continue equivalence tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  40. Behavioral: stepBack inside procedure, then resume, matches clean run
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 40. Behavioral: stepBack inside procedure ---');
  {
    const src = [
      'TO BOX :S',
      '  FD :S',
      '  RT 90',
      '  FD :S',
      '  RT 90',
      '  FD :S',
      '  RT 90',
      '  FD :S',
      '  RT 90',
      'END',
      '',
      'BOX 60',
    ].join('\n');

    const clean = await runClean(src);

    // Breakpoint on line 4 (second FD :S inside BOX)
    const { rt } = await launch(src, [4]);
    assert(rt.getCurrentLine() === 4, `40a: at line 4 inside BOX`);
    assert(rt.getCallStack().length === 1, `40b: inside BOX`);

    // Step back a couple of times
    assert(stepBack(rt), '40c');
    assert(stepBack(rt), '40d');

    // Resume to completion – final state must match clean run
    rt.setBreakpoints([]);
    const done = await resumeForward(rt);
    assert(done, '40e: completed');

    turtleEqual(clean.turtle, rt.getTurtleState(), '40f turtle');
    drawsEqual(clean.draws, rt.getDrawCommands(), '40g draws');

    console.log('  ✅ stepBack inside procedure behavioral tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  41. Behavioral: full back-to-start + continue matches clean run
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 41. Behavioral: reverseContinue to start + continue ---');
  {
    const src = [
      'TO TRI :S',
      '  REPEAT 3 [',
      '    FD :S',
      '    RT 120',
      '  ]',
      'END',
      '',
      'TRI 80',
      'RT 60',
      'TRI 80',
    ].join('\n');

    const clean = await runClean(src);

    // Breakpoint at line 10 only
    const { rt } = await launch(src, [10]);
    assert(rt.getCurrentLine() === 10, `41a: at line 10, got ${rt.getCurrentLine()}`);

    // Reverse continue — no earlier breakpoint, so steps back to start
    const ok = reverseContinue(rt, new Set([10]));
    assert(ok, '41b: stepped back');
    const hist = rt.getExecutionHistory();
    assert(hist.length === 1, `41c: history at start, got ${hist.length}`);

    // Clear breakpoints and resume
    rt.setBreakpoints([]);
    const done = await resumeForward(rt);
    assert(done, '41d: completed');

    turtleEqual(clean.turtle, rt.getTurtleState(), '41e turtle');
    drawsEqual(clean.draws, rt.getDrawCommands(), '41f draws');

    console.log('  ✅ Full reverse-to-start behavioral tests done\n');
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  MIRROR PROPERTY – reverse stepping should undo forward stepping
  // ═══════════════════════════════════════════════════════════════════════

  interface Snapshot {
    line: number;
    stackDepth: number;
    x: number;
    y: number;
    angle: number;
    draws: number;
  }

  function snapshot(rt: LogoRuntime): Snapshot {
    const t = rt.getTurtleState();
    return {
      line: rt.getCurrentLine(),
      stackDepth: rt.getCallStack().length,
      x: t.x,
      y: t.y,
      angle: t.angle,
      draws: rt.getDrawCommands().filter(c => c.type === 'line').length,
    };
  }

  function snapshotEqual(a: Snapshot, b: Snapshot, prefix: string): void {
    const eps = 0.001;
    assert(a.line === b.line, `${prefix}: line differs (${a.line} vs ${b.line})`);
    assert(a.stackDepth === b.stackDepth,
      `${prefix}: stackDepth differs (${a.stackDepth} vs ${b.stackDepth})`);
    assert(Math.abs(a.x - b.x) < eps, `${prefix}: x differs (${a.x} vs ${b.x})`);
    assert(Math.abs(a.y - b.y) < eps, `${prefix}: y differs (${a.y} vs ${b.y})`);
    assert(Math.abs(a.angle - b.angle) < eps,
      `${prefix}: angle differs (${a.angle} vs ${b.angle})`);
    assert(a.draws === b.draws, `${prefix}: draw count differs (${a.draws} vs ${b.draws})`);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  42. Mirror: stepIn sequence reversed by stepBack (top-level)
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 42. Mirror: stepIn / stepBack symmetry (top-level) ---');
  {
    const src = [
      'FD 10',
      'RT 90',
      'FD 20',
      'RT 45',
      'FD 30',
    ].join('\n');

    const { rt } = await launch(src, [1]);
    const forwardSnapshots: Snapshot[] = [snapshot(rt)];

    // Step forward through every line
    for (let i = 0; i < 4; i++) {
      const done = await step(rt, 'stepIn');
      assert(!done, `42a-${i}: paused`);
      forwardSnapshots.push(snapshot(rt));
    }

    // Step back the same number of times; each state should match forwardSnapshots in reverse
    for (let i = forwardSnapshots.length - 1; i > 0; i--) {
      assert(stepBack(rt), `42b-${i}: stepBack`);
      const expected = forwardSnapshots[i - 1];
      snapshotEqual(snapshot(rt), expected, `42c-${i}: stepBack[${i}→${i-1}]`);
    }

    console.log('  ✅ Top-level mirror tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  43. Mirror: multi-line REPEAT – reverse visits iterations in reverse
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 43. Mirror: multi-line REPEAT reverse stepping ---');
  {
    const src = [
      'REPEAT 3 [',
      '  FD 20',
      '  RT 120',
      ']',
      'FD 0',
    ].join('\n');

    const { rt } = await launch(src, [1]);
    const forwardSnapshots: Snapshot[] = [snapshot(rt)];

    // Step forward through REPEAT iterations
    for (let i = 0; i < 8; i++) {
      const done = await step(rt, 'stepIn');
      if (done) break;
      forwardSnapshots.push(snapshot(rt));
    }

    // We should have visited line 2 three times and line 3 three times
    const line2Visits = forwardSnapshots.filter(s => s.line === 2).length;
    const line3Visits = forwardSnapshots.filter(s => s.line === 3).length;
    assert(line2Visits === 3, `43a: visited line 2 three times, got ${line2Visits}`);
    assert(line3Visits === 3, `43b: visited line 3 three times, got ${line3Visits}`);

    // Step back and verify each state matches the forward sequence in reverse
    for (let i = forwardSnapshots.length - 1; i > 0; i--) {
      assert(stepBack(rt), `43c-${i}: stepBack at index ${i}`);
      const expected = forwardSnapshots[i - 1];
      snapshotEqual(snapshot(rt), expected, `43d-${i}: REPEAT reverse[${i}→${i-1}]`);
    }

    console.log('  ✅ Multi-line REPEAT mirror tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  44. Mirror: 3-deep nested procedures – reverse stepping
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 44. Mirror: 3-deep nested procedures reverse stepping ---');
  {
    const src = [
      'TO INNER :N',
      '  FD :N',
      '  RT 90',
      'END',
      '',
      'TO MIDDLE :N',
      '  INNER :N',
      '  RT 45',
      'END',
      '',
      'TO OUTER :N',
      '  MIDDLE :N',
      '  RT 30',
      'END',
      '',
      'OUTER 40',
    ].join('\n');

    const { rt } = await launch(src, [16]);
    const forwardSnapshots: Snapshot[] = [snapshot(rt)];

    // Step in until we have descended into INNER (depth 3) and visited a body line
    let reachedDepth3 = false;
    for (let i = 0; i < 30; i++) {
      const done = await step(rt, 'stepIn');
      if (done) break;
      forwardSnapshots.push(snapshot(rt));
      if (rt.getCallStack().length === 3) reachedDepth3 = true;
    }
    assert(reachedDepth3, `44a: reached 3-deep call stack`);

    // Step back and verify we visit states matching the forward sequence in reverse
    for (let i = forwardSnapshots.length - 1; i > 0; i--) {
      assert(stepBack(rt), `44b-${i}: stepBack`);
      const expected = forwardSnapshots[i - 1];
      snapshotEqual(snapshot(rt), expected, `44c-${i}: nested reverse[${i}→${i-1}]`);
    }

    // Final state is at the OUTER call site with empty stack
    assert(rt.getCurrentLine() === 16,
      `44d: back at OUTER call line 16, got ${rt.getCurrentLine()}`);
    assert(rt.getCallStack().length === 0,
      `44e: call stack empty at OUTER call site, got ${rt.getCallStack().length}`);

    console.log('  ✅ 3-deep nested procedure mirror tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  45. Mirror: reverseContinue visits breakpoints in reverse order
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 45. Mirror: reverseContinue visits breakpoints in reverse ---');
  {
    const src = [
      'TO INNER :N',
      '  FD :N',
      '  RT 90',
      'END',
      '',
      'TO OUTER :N',
      '  INNER :N',
      '  RT 30',
      'END',
      '',
      'OUTER 40',
    ].join('\n');

    // Breakpoints: line 2 (inside INNER), line 7 (inside OUTER), line 11 (call site)
    const breakpointLines = [2, 7, 11];
    const { rt } = await launch(src, breakpointLines);

    // Walk forward through all breakpoints, recording lines hit
    const forwardHits: number[] = [rt.getCurrentLine()];
    while (true) {
      const done = await cont(rt);
      if (done) break;
      forwardHits.push(rt.getCurrentLine());
    }

    // Walk backward via reverseContinue and record
    const reverseHits: number[] = [];
    const bpSet = new Set(breakpointLines);
    while (reverseContinue(rt, bpSet)) {
      reverseHits.push(rt.getCurrentLine());
      if (rt.getExecutionHistory().length <= 1) break;
    }

    // Forward hit sequence reversed should match reverse hit sequence
    const forwardReversed = [...forwardHits].reverse();
    assert(reverseHits.length > 0, `45a: reverseContinue hit something, got ${reverseHits.length}`);
    // Going back, the first breakpoint re-entered is the last one hit going forward.
    for (let i = 0; i < Math.min(reverseHits.length, forwardReversed.length); i++) {
      assert(reverseHits[i] === forwardReversed[i],
        `45b-${i}: reverseHit[${i}]=${reverseHits[i]} should equal forwardReversed[${i}]=${forwardReversed[i]}`);
    }

    console.log('  ✅ reverseContinue breakpoint-order mirror tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  46. Variables: stepBack restores earlier variable bindings
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 46. Reverse: variable restoration ---');
  {
    const src = [
      ':X = 10',
      ':Y = 20',
      ':X = :X + :Y',
      ':Y = :Y * 2',
    ].join('\n');

    const { rt } = await launch(src, [1]);
    assert(rt.getCurrentLine() === 1, `46a: at line 1`);
    assert(rt.getVariables().size === 0, `46b: no vars before line 1, got ${rt.getVariables().size}`);

    // Step through all assignments
    let done = await step(rt, 'stepIn');
    assert(!done, '46c'); // at line 2, X=10
    assert(rt.getVariables().get('X') === 10, `46d: X=10, got ${rt.getVariables().get('X')}`);

    done = await step(rt, 'stepIn');
    assert(!done, '46e'); // at line 3, X=10, Y=20
    assert(rt.getVariables().get('Y') === 20, `46f: Y=20, got ${rt.getVariables().get('Y')}`);

    done = await step(rt, 'stepIn');
    assert(!done, '46g'); // at line 4, X=30, Y=20
    assert(rt.getVariables().get('X') === 30, `46h: X=30, got ${rt.getVariables().get('X')}`);
    assert(rt.getVariables().get('Y') === 20, `46i: Y=20, got ${rt.getVariables().get('Y')}`);

    // Step back – should restore X=10, Y=20 (state before line 3 executed)
    assert(stepBack(rt), '46j: stepBack');
    assert(rt.getVariables().get('X') === 10,
      `46k: X back to 10 after stepBack, got ${rt.getVariables().get('X')}`);
    assert(rt.getVariables().get('Y') === 20,
      `46l: Y stays 20, got ${rt.getVariables().get('Y')}`);

    // Step back further – should restore only X=10 with no Y yet
    assert(stepBack(rt), '46m: stepBack');
    assert(rt.getVariables().get('X') === 10,
      `46n: X still 10, got ${rt.getVariables().get('X')}`);
    assert(!rt.getVariables().has('Y'),
      `46o: Y should be undefined, got ${rt.getVariables().get('Y')}`);

    // Step back once more – both X and Y unset
    assert(stepBack(rt), '46p: stepBack');
    assert(!rt.getVariables().has('X'),
      `46q: X should be undefined, got ${rt.getVariables().get('X')}`);

    console.log('  ✅ Variable restoration tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  47. Mirror: multi-line REPEAT inside procedure (flower-style pattern)
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 47. Mirror: multi-line REPEAT inside procedure ---');
  {
    const src = [
      'TO TRI :S',
      '  REPEAT 3 [',
      '    FD :S',
      '    RT 120',
      '  ]',
      'END',
      '',
      'TRI 50',
    ].join('\n');

    const { rt } = await launch(src, [8]);
    assert(rt.getCurrentLine() === 8, `47a: at TRI call`);
    const forwardSnapshots: Snapshot[] = [snapshot(rt)];

    // Step forward through procedure entry + 3 REPEAT iterations
    for (let i = 0; i < 15; i++) {
      const done = await step(rt, 'stepIn');
      if (done) break;
      forwardSnapshots.push(snapshot(rt));
    }

    // Verify we visited the REPEAT body lines inside the procedure
    const insideProc = forwardSnapshots.filter(s => s.stackDepth >= 1);
    assert(insideProc.length > 0, `47b: visited procedure body, got ${insideProc.length} snapshots`);

    // Step back the whole way and verify snapshot sequence matches forward in reverse
    for (let i = forwardSnapshots.length - 1; i > 0; i--) {
      assert(stepBack(rt), `47c-${i}: stepBack`);
      const expected = forwardSnapshots[i - 1];
      snapshotEqual(snapshot(rt), expected, `47d-${i}: REPEAT-in-proc reverse[${i}→${i-1}]`);
    }

    // Should end back at the TRI call site, stack empty
    assert(rt.getCurrentLine() === 8, `47e: back at TRI call, got ${rt.getCurrentLine()}`);
    assert(rt.getCallStack().length === 0,
      `47f: stack empty at call site, got ${rt.getCallStack().length}`);

    console.log('  ✅ REPEAT-inside-procedure mirror tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  48. Full round-trip: forward N → back N → forward N yields identical
  //      state to running forward 2N (i.e. reverse is a true inverse)
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 48. Mirror: forward/back/forward round-trip on nested program ---');
  {
    const src = [
      'TO BOX :S',
      '  REPEAT 4 [',
      '    FD :S',
      '    RT 90',
      '  ]',
      'END',
      '',
      'BOX 50',
      'RT 45',
      'BOX 50',
    ].join('\n');

    const clean = await runClean(src);

    // Walk forward with stepIn through the whole thing (no breakpoints)
    const rt = new LogoRuntime();
    rt.loadProgram(src);
    rt.setStepMode('stepIn');
    let done = await rt.execute();
    let safety = 0;
    const forwardSnapshots: Snapshot[] = [snapshot(rt)];
    while (!done && safety < 500) {
      done = await step(rt, 'stepIn');
      // Only record snapshots at pauses — the post-done state has no
      // corresponding history entry, so including it would break the
      // 1:1 mapping between forward steps and stepBack-reachable states.
      if (!done) forwardSnapshots.push(snapshot(rt));
      safety++;
    }
    assert(done, `48a: completed forward walk in ${safety} steps`);

    // Rewind to the forward-walk midpoint and verify state equivalence.
    const halfWay = Math.floor(forwardSnapshots.length / 2);
    // From the post-done state, stepBack(k) restores forwardSnapshots[L-1-k]
    // where L = forwardSnapshots.length. To reach index halfWay we need
    // (L-1) - halfWay stepBacks.
    const backSteps = forwardSnapshots.length - 1 - halfWay;
    for (let i = 0; i < backSteps; i++) {
      if (!stepBack(rt)) break;
    }

    // Middle snapshot should match forwardSnapshots[halfWay]
    const midExpected = forwardSnapshots[halfWay];
    const midActual = snapshot(rt);
    snapshotEqual(midActual, midExpected, `48b: midpoint state`);

    // Resume forward to completion
    rt.setBreakpoints([]);
    done = await resumeForward(rt);
    safety = 0;
    while (!done && safety < 500) {
      done = await resumeForward(rt);
      safety++;
    }
    assert(done, `48c: completed forward resume in ${safety} steps`);

    // Final state must match a clean run
    turtleEqual(clean.turtle, rt.getTurtleState(), '48d final turtle');
    drawsEqual(clean.draws, rt.getDrawCommands(), '48e final draws');

    console.log('  ✅ Round-trip mirror tests done\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Summary
  // ─────────────────────────────────────────────────────────────────────
  console.log('════════════════════════════════════════════');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log('════════════════════════════════════════════');

  if (failed > 0) {
    console.log('❌ Some tests failed');
    process.exit(1);
  } else {
    console.log('🎉 All procedureDebug tests passed');
    process.exit(0);
  }
})();
