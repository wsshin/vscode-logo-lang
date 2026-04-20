import { LogoRuntime } from '../logoDebugger';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

(async () => {
  console.log('🧪 repeatDebug tests starting...');

  // Single-line REPEAT: stepOver should skip internal lines and pause after block
  const srcSingle = `REPEAT 5 [ FD 50 RT 144 ]\nFD 10`;
  const rt1 = new LogoRuntime();
  rt1.loadProgram(srcSingle);
  // DEBUG: print tokens and internal state before stepping
  // eslint-disable-next-line no-console
  const tokensSingle = (rt1 as any).tokenize(srcSingle);
  // Simulate that we're paused on the REPEAT line and now issuing a stepOver
  (rt1 as any).executionTokens = tokensSingle;
  (rt1 as any).executionIndex = 0; // at REPEAT token
  (rt1 as any).pauseRequested = true;
  rt1.setStepMode('stepOver');
  (rt1 as any).lastSteppedLine = 1;
  // eslint-disable-next-line no-console
  console.log('DEBUG before execute: pauseRequested=', (rt1 as any).pauseRequested, 'stepMode=', (rt1 as any).stepMode, 'lastSteppedLine=', (rt1 as any).lastSteppedLine, 'executionTokens.length=', (rt1 as any).executionTokens.length);

  let paused = await rt1.execute();
  // execute returns false when paused, true when completed
  assert(paused === false, 'Single-line REPEAT: expected to pause after stepOver, got complete');
  assert(rt1.getCurrentLine() === 2, `Single-line REPEAT: expected to be paused at line 2, got ${rt1.getCurrentLine()}`);
  console.log('✅ Single-line REPEAT stepOver behaved as expected');

  // Multiline REPEAT stepIn: should pause on first line in block and then step through iterations
  const srcMulti = `REPEAT 3 [\n FD 10\n RT 90\n]\nFD 5`;
  const rt2 = new LogoRuntime();
  rt2.loadProgram(srcMulti);

  // Simulate that we're paused on the REPEAT line and now issuing a stepIn
  const tokensMulti = (rt2 as any).tokenize(srcMulti);
  (rt2 as any).executionTokens = tokensMulti;
  (rt2 as any).executionIndex = 0; // at REPEAT token
  (rt2 as any).pauseRequested = true;
  rt2.setStepMode('stepIn');
  (rt2 as any).lastSteppedLine = 1;
  let result = await rt2.execute();
  assert(result === false, 'Multiline REPEAT stepIn: expected to pause inside block');
  assert(rt2.getCurrentLine() === 2, `Multiline stepIn: expected to pause at line 2, got ${rt2.getCurrentLine()}`);
  console.log('✅ Multiline REPEAT stepIn paused at first inner line');

  // Continue stepIn to next inner line
  (rt2 as any).pauseRequested = true;
  rt2.setStepMode('stepIn');
  (rt2 as any).lastSteppedLine = rt2.getCurrentLine();
  result = await rt2.execute();
  assert(result === false, 'Multiline REPEAT stepIn: expected to pause on next inner line');
  assert(rt2.getCurrentLine() === 3, `Multiline stepIn: expected to pause at line 3, got ${rt2.getCurrentLine()}`);
  console.log('✅ Multiline REPEAT stepIn advanced to next inner line');

  // Continue another stepIn - should loop back to line 2 (next iteration)
  (rt2 as any).pauseRequested = true;
  rt2.setStepMode('stepIn');
  (rt2 as any).lastSteppedLine = rt2.getCurrentLine();
  result = await rt2.execute();
  assert(result === false, 'Multiline REPEAT stepIn: expected to pause on next iteration inner line');
  assert(rt2.getCurrentLine() === 2, `Multiline stepIn: expected to loop back to line 2, got ${rt2.getCurrentLine()}`);
  console.log('✅ Multiline REPEAT stepIn loops over iterations as expected');

  // Multiline REPEAT stepOver from outer REPEAT line should pause after the block
  const rt3 = new LogoRuntime();
  rt3.loadProgram(srcMulti);
  // Simulate paused on the REPEAT line and issuing a stepOver
  const tokensMultiRT3 = (rt3 as any).tokenize(srcMulti);
  (rt3 as any).executionTokens = tokensMultiRT3;
  (rt3 as any).executionIndex = 0; // at REPEAT token
  (rt3 as any).pauseRequested = true;
  rt3.setStepMode('stepOver');
  (rt3 as any).lastSteppedLine = 1;

  result = await rt3.execute();
  assert(result === false, 'Multiline REPEAT stepOver: expected to pause after block');
  assert(rt3.getCurrentLine() === 5, `Multiline REPEAT stepOver: expected to be paused at line 5, got ${rt3.getCurrentLine()}`);
  console.log('✅ Multiline REPEAT stepOver jumped to line after block');

  // 4-line multiline REPEAT stepIn: should pause on each inner line and execute RT commands
  const src4Line = `REPEAT 2 [\n FD 10\n RT 90\n FD 20\n RT 45\n]\nFD 0`;
  const rt4 = new LogoRuntime();
  rt4.loadProgram(src4Line);
  const tokens4 = (rt4 as any).tokenize(src4Line);
  (rt4 as any).executionTokens = tokens4;
  (rt4 as any).executionIndex = 0; // at REPEAT

  // Step into first inner line
  (rt4 as any).pauseRequested = true;
  rt4.setStepMode('stepIn');
  (rt4 as any).lastSteppedLine = 1;
  result = await rt4.execute();
  assert(result === false, '4-line REPEAT stepIn: expected to pause inside block at line 2');
  assert(rt4.getCurrentLine() === 2, `4-line stepIn: expected line 2, got ${rt4.getCurrentLine()}`);

  // Execute line 2 (FD 10) and step to line 3
  (rt4 as any).pauseRequested = true;
  rt4.setStepMode('stepIn');
  (rt4 as any).lastSteppedLine = rt4.getCurrentLine();
  result = await rt4.execute();
  assert(result === false, '4-line REPEAT stepIn: expected to pause at line 3');
  assert(rt4.getCurrentLine() === 3, `4-line stepIn: expected line 3, got ${rt4.getCurrentLine()}`);

  // Execute line 3 (RT 90) and step to line 4
  (rt4 as any).pauseRequested = true;
  rt4.setStepMode('stepIn');
  (rt4 as any).lastSteppedLine = rt4.getCurrentLine();
  result = await rt4.execute();
  assert(result === false, '4-line REPEAT stepIn: expected to pause at line 4');
  assert(rt4.getCurrentLine() === 4, `4-line stepIn: expected line 4, got ${rt4.getCurrentLine()}`);
  // After executing RT 90 the turtle should have turned 90 degrees
  const t1 = rt4.getTurtleState();
  assert(Math.round(t1.angle) === 90, `Expected angle 90 after RT, got ${t1.angle}`);

  // Execute line 4 (FD 20) and step to line 5
  (rt4 as any).pauseRequested = true;
  rt4.setStepMode('stepIn');
  (rt4 as any).lastSteppedLine = rt4.getCurrentLine();
  result = await rt4.execute();
  assert(result === false, '4-line REPEAT stepIn: expected to pause at line 5');
  assert(rt4.getCurrentLine() === 5, `4-line stepIn: expected line 5, got ${rt4.getCurrentLine()}`);

  // Execute line 5 (RT 45) and step to next iteration (should loop back to line 2)
  (rt4 as any).pauseRequested = true;
  rt4.setStepMode('stepIn');
  (rt4 as any).lastSteppedLine = rt4.getCurrentLine();
  result = await rt4.execute();
  assert(result === false, '4-line REPEAT stepIn: expected to loop back to line 2');
  assert(rt4.getCurrentLine() === 2, `4-line stepIn: expected to loop to line 2, got ${rt4.getCurrentLine()}`);
  // After RT 45, angle should be 135 (90 + 45)
  const t2 = rt4.getTurtleState();
  assert(Math.round(t2.angle) === 135, `Expected angle 135 after second RT, got ${t2.angle}`);
  console.log('✅ 4-line REPEAT stepIn iterated and executed rotations correctly');

  console.log('🎉 All repeatDebug tests passed');
  process.exit(0);
})();
