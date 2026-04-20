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

async function step(
  rt: LogoRuntime,
  mode: 'stepIn' | 'stepOver' | 'stepOut'
): Promise<boolean> {
  (rt as any).pauseRequested = true;
  rt.setStepMode(mode);
  (rt as any).lastSteppedLine = rt.getCurrentLine();
  return rt.execute();
}

async function cont(rt: LogoRuntime): Promise<boolean> {
  (rt as any).pauseRequested = true;
  rt.setStepMode('continue');
  (rt as any).lastSteppedLine = rt.getCurrentLine();
  return rt.execute();
}

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
//  Tests for PR #10: multi-line IF / IFELSE resume behavior
// ═══════════════════════════════════════════════════════════════════════

(async () => {
  console.log('🧪 ifDebug tests starting...\n');

  // ─────────────────────────────────────────────────────────────────────
  //  1. Multi-line IF (true branch) — stepIn visits each inner line
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 1. Multi-line IF (true): stepIn through inner lines ---');
  {
    // 1  IF 1 < 2 [
    // 2    FD 10
    // 3    RT 90
    // 4  ]
    // 5  FD 5
    const src = [
      'IF 1 < 2 [',
      '  FD 10',
      '  RT 90',
      ']',
      'FD 5',
    ].join('\n');

    const { rt } = await launch(src, [1]);
    assert(rt.getCurrentLine() === 1, `1a: expected pause at IF line 1, got ${rt.getCurrentLine()}`);

    // stepIn → first inner line (FD 10, line 2)
    let done = await step(rt, 'stepIn');
    assert(!done, '1b: expected pause inside IF block');
    assert(rt.getCurrentLine() === 2, `1c: expected line 2, got ${rt.getCurrentLine()}`);

    // Execute FD 10, stepIn → line 3 (RT 90)
    done = await step(rt, 'stepIn');
    assert(!done, '1d: expected pause on line 3');
    assert(rt.getCurrentLine() === 3, `1e: expected line 3, got ${rt.getCurrentLine()}`);
    // After FD 10 we should have advanced ~10 units along y-axis (angle 0)
    const afterFD = rt.getTurtleState();
    assert(Math.round(afterFD.y) === 10, `1f: expected y≈10 after FD 10, got ${afterFD.y}`);

    // Execute RT 90, stepIn → line 5 (after the block)
    done = await step(rt, 'stepIn');
    assert(!done, '1g: expected pause after block');
    assert(rt.getCurrentLine() === 5, `1h: expected line 5 after block, got ${rt.getCurrentLine()}`);
    const afterRT = rt.getTurtleState();
    assert(Math.round(afterRT.angle) === 90, `1i: expected angle 90 after RT 90, got ${afterRT.angle}`);

    // Continue → completes
    done = await cont(rt);
    assert(done === true, '1j: expected execution to complete');

    console.log('  ✅ Multi-line IF stepIn visits each inner line\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  2. Multi-line IF (false branch) — block skipped, no inner pauses
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 2. Multi-line IF (false): block skipped ---');
  {
    const src = [
      'IF 1 > 2 [',
      '  FD 10',
      '  RT 90',
      ']',
      'FD 5',
    ].join('\n');

    const { rt } = await launch(src, [1]);
    assert(rt.getCurrentLine() === 1, `2a: expected pause at IF line 1, got ${rt.getCurrentLine()}`);

    // stepIn should skip the (falsy) IF block and pause at line 5
    let done = await step(rt, 'stepIn');
    assert(!done, '2b: expected pause after skipped IF');
    assert(rt.getCurrentLine() === 5, `2c: expected line 5 after skipped block, got ${rt.getCurrentLine()}`);

    // Turtle must not have moved inside the IF
    const t = rt.getTurtleState();
    assert(Math.round(t.x) === 0 && Math.round(t.y) === 0,
      `2d: turtle must not move when IF is false, got (${t.x}, ${t.y})`);
    assert(Math.round(t.angle) === 0, `2e: turtle angle must stay 0 when IF is false, got ${t.angle}`);

    done = await cont(rt);
    assert(done === true, '2f: expected execution to complete');

    console.log('  ✅ Multi-line IF (false) skipped correctly\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  3. Multi-line IF — breakpoint on inner line, resume does NOT re-run
  //     commands that already executed (the bug fixed by PR #10)
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 3. Multi-line IF: resume from inner breakpoint is not re-entrant ---');
  {
    // 1  IF 1 < 2 [
    // 2    FD 10
    // 3    RT 90
    // 4    FD 20
    // 5  ]
    // 6  FD 5
    const src = [
      'IF 1 < 2 [',
      '  FD 10',
      '  RT 90',
      '  FD 20',
      ']',
      'FD 5',
    ].join('\n');

    // Break on line 4 (FD 20). When we pause there, FD 10 and RT 90 should
    // already have executed. After continuing, FD 20 must execute exactly once.
    const { rt } = await launch(src, [4]);
    assert(rt.getCurrentLine() === 4, `3a: expected pause at line 4, got ${rt.getCurrentLine()}`);

    // State at pause: FD 10 → y=10, then RT 90 → angle=90. FD 20 hasn't run yet.
    let t = rt.getTurtleState();
    assert(Math.round(t.y) === 10, `3b: expected y≈10 before FD 20, got ${t.y}`);
    assert(Math.round(t.angle) === 90, `3c: expected angle 90 before FD 20, got ${t.angle}`);

    // Continue to completion. If the bug were present, resuming would re-enter
    // the IF block from the top and execute FD 10 / RT 90 / FD 20 a second time.
    rt.setBreakpoints([]);
    const done = await cont(rt);
    assert(done === true, '3d: expected completion');

    // Expected net motion: FD 10 (y+=10, angle=0), RT 90 (angle=90),
    // FD 20 (x+=20, angle=90), FD 5 (x+=5). Total: x=25, y=10.
    t = rt.getTurtleState();
    assert(Math.round(t.x) === 25, `3e: expected x≈25 (no re-execution), got ${t.x}`);
    assert(Math.round(t.y) === 10, `3f: expected y≈10 (no re-execution), got ${t.y}`);
    assert(Math.round(t.angle) === 90, `3g: expected angle 90, got ${t.angle}`);

    console.log('  ✅ Multi-line IF breakpoint resume does not re-run completed commands\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  4. Multi-line IFELSE (true branch) — stepIn visits true-branch lines
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 4. Multi-line IFELSE (true): stepIn through true branch ---');
  {
    // 1  IFELSE 1 < 2 [
    // 2    FD 10
    // 3    RT 90
    // 4  ] [
    // 5    FD 99
    // 6    RT 45
    // 7  ]
    // 8  FD 5
    const src = [
      'IFELSE 1 < 2 [',
      '  FD 10',
      '  RT 90',
      '] [',
      '  FD 99',
      '  RT 45',
      ']',
      'FD 5',
    ].join('\n');

    const { rt } = await launch(src, [1]);
    assert(rt.getCurrentLine() === 1, `4a: expected pause at IFELSE line 1, got ${rt.getCurrentLine()}`);

    let done = await step(rt, 'stepIn');
    assert(!done, '4b: expected pause inside true branch');
    assert(rt.getCurrentLine() === 2, `4c: expected line 2, got ${rt.getCurrentLine()}`);

    done = await step(rt, 'stepIn');
    assert(!done, '4d: expected pause on line 3');
    assert(rt.getCurrentLine() === 3, `4e: expected line 3, got ${rt.getCurrentLine()}`);

    done = await step(rt, 'stepIn');
    assert(!done, '4f: expected pause after block');
    assert(rt.getCurrentLine() === 8, `4g: expected line 8 (after IFELSE), got ${rt.getCurrentLine()}`);

    // False branch must not have run
    const t = rt.getTurtleState();
    assert(Math.round(t.y) === 10, `4h: expected y≈10 from true branch FD 10, got ${t.y}`);
    assert(Math.round(t.angle) === 90, `4i: expected angle 90 from true-branch RT 90, got ${t.angle}`);

    done = await cont(rt);
    assert(done === true, '4j: expected execution to complete');

    console.log('  ✅ Multi-line IFELSE stepIn visits true-branch lines only\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  5. Multi-line IFELSE (false branch) — stepIn visits false-branch lines
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 5. Multi-line IFELSE (false): stepIn through false branch ---');
  {
    const src = [
      'IFELSE 1 > 2 [',
      '  FD 10',
      '  RT 90',
      '] [',
      '  FD 20',
      '  RT 45',
      ']',
      'FD 5',
    ].join('\n');

    const { rt } = await launch(src, [1]);
    assert(rt.getCurrentLine() === 1, `5a: expected pause at IFELSE line 1, got ${rt.getCurrentLine()}`);

    let done = await step(rt, 'stepIn');
    assert(!done, '5b: expected pause inside false branch');
    assert(rt.getCurrentLine() === 5, `5c: expected line 5 (first false-branch line), got ${rt.getCurrentLine()}`);

    done = await step(rt, 'stepIn');
    assert(!done, '5d: expected pause on line 6');
    assert(rt.getCurrentLine() === 6, `5e: expected line 6, got ${rt.getCurrentLine()}`);

    done = await step(rt, 'stepIn');
    assert(!done, '5f: expected pause after block');
    assert(rt.getCurrentLine() === 8, `5g: expected line 8, got ${rt.getCurrentLine()}`);

    // True branch must NOT have executed — only FD 20 / RT 45
    const t = rt.getTurtleState();
    assert(Math.round(t.y) === 20, `5h: expected y≈20 from false branch FD 20, got ${t.y}`);
    assert(Math.round(t.angle) === 45, `5i: expected angle 45 from false branch RT 45, got ${t.angle}`);

    done = await cont(rt);
    assert(done === true, '5j: expected execution to complete');

    console.log('  ✅ Multi-line IFELSE stepIn visits false-branch lines only\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  6. Multi-line IFELSE — breakpoint inside true branch, resume correct
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 6. Multi-line IFELSE: resume from inner breakpoint is not re-entrant ---');
  {
    // 1  IFELSE 1 < 2 [
    // 2    FD 10
    // 3    RT 90
    // 4    FD 20
    // 5  ] [
    // 6    FD 99
    // 7  ]
    // 8  FD 5
    const src = [
      'IFELSE 1 < 2 [',
      '  FD 10',
      '  RT 90',
      '  FD 20',
      '] [',
      '  FD 99',
      ']',
      'FD 5',
    ].join('\n');

    const { rt } = await launch(src, [4]);
    assert(rt.getCurrentLine() === 4, `6a: expected pause at line 4, got ${rt.getCurrentLine()}`);

    let t = rt.getTurtleState();
    assert(Math.round(t.y) === 10, `6b: expected y≈10 before FD 20, got ${t.y}`);
    assert(Math.round(t.angle) === 90, `6c: expected angle 90 before FD 20, got ${t.angle}`);

    rt.setBreakpoints([]);
    const done = await cont(rt);
    assert(done === true, '6d: expected completion');

    // Expected: FD 10 (y=10), RT 90, FD 20 (x=20), FD 5 (x=25) → x=25, y=10
    // False-branch FD 99 must NOT run.
    t = rt.getTurtleState();
    assert(Math.round(t.x) === 25, `6e: expected x≈25, got ${t.x}`);
    assert(Math.round(t.y) === 10, `6f: expected y≈10, got ${t.y}`);

    console.log('  ✅ Multi-line IFELSE breakpoint resume does not re-run completed commands\n');
  }

  // ─────────────────────────────────────────────────────────────────────
  //  7. Nested IF inside multi-line IF — resume through two levels of state
  // ─────────────────────────────────────────────────────────────────────
  console.log('--- 7. Nested IF inside IF: resume preserves outer+inner state ---');
  {
    // 1  IF 1 < 2 [
    // 2    FD 10
    // 3    IF 1 < 2 [
    // 4      RT 90
    // 5      FD 20
    // 6    ]
    // 7    FD 30
    // 8  ]
    // 9  FD 5
    const src = [
      'IF 1 < 2 [',
      '  FD 10',
      '  IF 1 < 2 [',
      '    RT 90',
      '    FD 20',
      '  ]',
      '  FD 30',
      ']',
      'FD 5',
    ].join('\n');

    // Breakpoint inside the inner IF block (line 5: FD 20). By the time we
    // pause, FD 10 and RT 90 must have run; FD 20 has not.
    const { rt } = await launch(src, [5]);
    assert(rt.getCurrentLine() === 5, `7a: expected pause at line 5, got ${rt.getCurrentLine()}`);

    let t = rt.getTurtleState();
    assert(Math.round(t.y) === 10, `7b: expected y≈10 (FD 10 ran), got ${t.y}`);
    assert(Math.round(t.angle) === 90, `7c: expected angle 90 (inner RT 90 ran), got ${t.angle}`);

    // Resume to completion. If either IF's resume state were lost we'd either
    // crash, skip remaining inner/outer statements, or re-run earlier ones.
    rt.setBreakpoints([]);
    const done = await cont(rt);
    assert(done === true, '7d: expected execution to complete');

    // Expected: FD 10 (y=10), RT 90 (angle=90), FD 20 (x=20), FD 30 (x=50),
    // FD 5 (x=55) → x=55, y=10.
    t = rt.getTurtleState();
    assert(Math.round(t.x) === 55, `7e: expected x≈55, got ${t.x}`);
    assert(Math.round(t.y) === 10, `7f: expected y≈10, got ${t.y}`);
    assert(Math.round(t.angle) === 90, `7g: expected angle 90, got ${t.angle}`);

    console.log('  ✅ Nested IF resume preserves outer and inner state\n');
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
    console.log('🎉 All ifDebug tests passed');
    process.exit(0);
  }
})();
