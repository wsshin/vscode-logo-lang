import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LogoRuntime } from '../logoRuntime';

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

/** Create a temp directory and return its path. */
function mkTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'logo-load-test-'));
}

/** Remove a directory and all its contents. */
function rmTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════
//  LOAD functional tests
// ═══════════════════════════════════════════════════════════════════════

(async () => {
  console.log('🧪 loadDebug tests starting...\n');

  const tmpDir = mkTempDir();

  try {
    // ─────────────────────────────────────────────────────────────────────
    //  1. Basic LOAD: loaded file's commands execute
    // ─────────────────────────────────────────────────────────────────────
    console.log('--- 1. Basic LOAD: loaded commands execute ---');
    {
      const loadedPath = path.join(tmpDir, 'square.logo');
      fs.writeFileSync(loadedPath, 'FD 10\nRT 90\nFD 20\n');

      const mainPath = path.join(tmpDir, 'main.logo');
      const mainSrc = `LOAD "${loadedPath}\n`;
      fs.writeFileSync(mainPath, mainSrc);

      const rt = new LogoRuntime();
      rt.loadProgram(mainSrc, mainPath);
      const done = await rt.execute();
      assert(done, '1a: execution should complete');

      const cmds = rt.getDrawCommands();
      // FD 10 produces a line, RT 90 produces a move (heading change), FD 20 produces a line
      const lines = cmds.filter(c => c.type === 'line');
      assert(lines.length === 2, `1b: expected 2 line commands, got ${lines.length}`);

      const turtle = rt.getTurtleState();
      assert(Math.abs(turtle.x - 20) < 1e-6, `1c: expected x ≈ 20, got ${turtle.x}`);
      assert(Math.abs(turtle.y - 10) < 1e-6, `1d: expected y ≈ 10, got ${turtle.y}`);
      assert(turtle.angle === 90, `1e: expected angle 90, got ${turtle.angle}`);
      console.log('  ✅ Basic LOAD executes commands');
    }

    // ─────────────────────────────────────────────────────────────────────
    //  2. LOAD defines procedures that caller can invoke
    // ─────────────────────────────────────────────────────────────────────
    console.log('--- 2. LOAD defines procedures callable from caller ---');
    {
      const loadedPath = path.join(tmpDir, 'shapes.logo');
      fs.writeFileSync(loadedPath, 'TO TRIANGLE\n  FD 10\n  RT 120\n  FD 10\n  RT 120\n  FD 10\n  RT 120\nEND\n');

      const mainPath = path.join(tmpDir, 'main2.logo');
      const mainSrc = `LOAD "${loadedPath}\nTRIANGLE\n`;
      fs.writeFileSync(mainPath, mainSrc);

      const rt = new LogoRuntime();
      rt.loadProgram(mainSrc, mainPath);
      const done = await rt.execute();
      assert(done, '2a: execution should complete');

      const lines = rt.getDrawCommands().filter(c => c.type === 'line');
      assert(lines.length === 3, `2b: expected 3 line commands from triangle, got ${lines.length}`);
      console.log('  ✅ LOAD defines callable procedures');
    }

    // ─────────────────────────────────────────────────────────────────────
    //  3. Relative path LOAD resolves from caller's directory
    // ─────────────────────────────────────────────────────────────────────
    console.log('--- 3. Relative path LOAD ---');
    {
      const subDir = path.join(tmpDir, 'sub');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'helper.logo'), 'FD 5\n');

      const mainPath = path.join(subDir, 'main.logo');
      const mainSrc = `LOAD "helper.logo\n`;
      fs.writeFileSync(mainPath, mainSrc);

      const rt = new LogoRuntime();
      rt.loadProgram(mainSrc, mainPath);
      const done = await rt.execute();
      assert(done, '3a: execution should complete');

      const lines = rt.getDrawCommands().filter(c => c.type === 'line');
      assert(lines.length === 1, `3b: expected 1 line from helper, got ${lines.length}`);
      console.log('  ✅ Relative-path LOAD resolves correctly');
    }

    // ─────────────────────────────────────────────────────────────────────
    //  4. LOAD via variable name
    // ─────────────────────────────────────────────────────────────────────
    console.log('--- 4. LOAD with filename variable ---');
    {
      const loadedPath = path.join(tmpDir, 'by_var.logo');
      fs.writeFileSync(loadedPath, 'RT 45\n');

      const mainPath = path.join(tmpDir, 'main4.logo');
      const mainSrc = `MAKE "F "${loadedPath}\nLOAD :F\n`;
      fs.writeFileSync(mainPath, mainSrc);

      const rt = new LogoRuntime();
      rt.loadProgram(mainSrc, mainPath);
      const done = await rt.execute();
      assert(done, '4a: execution should complete');

      const turtle = rt.getTurtleState();
      assert(turtle.angle === 45, `4b: expected angle 45, got ${turtle.angle}`);
      console.log('  ✅ LOAD with variable filename');
    }

    // ─────────────────────────────────────────────────────────────────────
    //  5. Cyclic LOAD is detected and errors out
    // ─────────────────────────────────────────────────────────────────────
    console.log('--- 5. Cyclic LOAD detection ---');
    {
      const fileA = path.join(tmpDir, 'cyc_a.logo');
      const fileB = path.join(tmpDir, 'cyc_b.logo');
      fs.writeFileSync(fileA, `LOAD "${fileB}\n`);
      fs.writeFileSync(fileB, `LOAD "${fileA}\n`);

      const mainSrc = `LOAD "${fileA}\n`;
      const mainPath = path.join(tmpDir, 'main5.logo');
      fs.writeFileSync(mainPath, mainSrc);

      const rt = new LogoRuntime();
      rt.loadProgram(mainSrc, mainPath);
      let errMsg = '';
      try {
        await rt.execute();
      } catch (e) {
        errMsg = (e as Error).message;
      }
      assert(/Cyclic LOAD/.test(errMsg), `5a: expected Cyclic LOAD error, got "${errMsg}"`);
      console.log('  ✅ Cyclic LOAD detected');
    }

    // ─────────────────────────────────────────────────────────────────────
    //  6. LOAD of non-existent file throws
    // ─────────────────────────────────────────────────────────────────────
    console.log('--- 6. LOAD of non-existent file errors ---');
    {
      const missing = path.join(tmpDir, 'does_not_exist.logo');
      const mainSrc = `LOAD "${missing}\n`;
      const mainPath = path.join(tmpDir, 'main6.logo');
      fs.writeFileSync(mainPath, mainSrc);

      const rt = new LogoRuntime();
      rt.loadProgram(mainSrc, mainPath);
      let errMsg = '';
      try {
        await rt.execute();
      } catch (e) {
        errMsg = (e as Error).message;
      }
      assert(/LOAD failed/.test(errMsg), `6a: expected "LOAD failed" error, got "${errMsg}"`);
      console.log('  ✅ Missing file errors');
    }

    // ─────────────────────────────────────────────────────────────────────
    //  7. LOAD with relative path but no real source errors
    // ─────────────────────────────────────────────────────────────────────
    console.log('--- 7. Relative-path LOAD without real source errors ---');
    {
      const rt = new LogoRuntime();
      // loadProgram without a file path → the main source has no real path;
      // a relative LOAD cannot be resolved.
      rt.loadProgram(`LOAD "helper.logo\n`);
      let errMsg = '';
      try {
        await rt.execute();
      } catch (e) {
        errMsg = (e as Error).message;
      }
      assert(/real source file path/.test(errMsg),
        `7a: expected "real source file path" error, got "${errMsg}"`);
      console.log('  ✅ Relative path without real source errors');
    }

    // ─────────────────────────────────────────────────────────────────────
    //  8. LOAD inside a procedure works
    // ─────────────────────────────────────────────────────────────────────
    console.log('--- 8. LOAD from inside a procedure ---');
    {
      const loadedPath = path.join(tmpDir, 'in_proc.logo');
      fs.writeFileSync(loadedPath, 'FD 7\n');

      const mainPath = path.join(tmpDir, 'main8.logo');
      const mainSrc = `TO DOLOAD\n  LOAD "${loadedPath}\nEND\nDOLOAD\n`;
      fs.writeFileSync(mainPath, mainSrc);

      const rt = new LogoRuntime();
      rt.loadProgram(mainSrc, mainPath);
      const done = await rt.execute();
      assert(done, '8a: execution should complete');

      const lines = rt.getDrawCommands().filter(c => c.type === 'line');
      assert(lines.length === 1, `8b: expected 1 line from LOAD inside proc, got ${lines.length}`);
      console.log('  ✅ LOAD from inside a procedure');
    }

    // ─────────────────────────────────────────────────────────────────────
    //  9. Breakpoint inside a LOADed file pauses there
    // ─────────────────────────────────────────────────────────────────────
    console.log('--- 9. Breakpoint inside LOADed file ---');
    {
      const loadedPath = path.join(tmpDir, 'brk.logo');
      // line 1: FD 10
      // line 2: RT 90
      // line 3: FD 20
      fs.writeFileSync(loadedPath, 'FD 10\nRT 90\nFD 20\n');

      const mainPath = path.join(tmpDir, 'main9.logo');
      // line 1: LOAD "brk.logo"
      // line 2: FD 5
      fs.writeFileSync(mainPath, `LOAD "${loadedPath}\nFD 5\n`);

      const rt = new LogoRuntime();
      rt.loadProgram(`LOAD "${loadedPath}\nFD 5\n`, mainPath);
      const bps = new Map<string, number[]>();
      bps.set(loadedPath, [2]); // breakpoint on RT 90 inside loaded file
      rt.setSourceBreakpoints(bps);

      const done = await rt.execute();
      assert(!done, '9a: expected pause at breakpoint inside loaded file');
      assert(rt.getCurrentLine() === 2,
        `9b: expected pause at line 2, got ${rt.getCurrentLine()}`);
      assert(rt.getCurrentLocation().sourcePath === loadedPath,
        `9c: expected pause in loaded file, got ${rt.getCurrentLocation().sourcePath}`);

      // Before the pause only FD 10 should have run
      let lineCmds = rt.getDrawCommands().filter(c => c.type === 'line');
      assert(lineCmds.length === 1, `9d: expected 1 line before break, got ${lineCmds.length}`);

      // Continue: should finish the loaded file, then the main file's FD 5
      const finalDone = await cont(rt);
      assert(finalDone, '9e: expected completion after continue');
      lineCmds = rt.getDrawCommands().filter(c => c.type === 'line');
      assert(lineCmds.length === 3, `9f: expected 3 total lines, got ${lineCmds.length}`);
      console.log('  ✅ Breakpoint inside LOADed file');
    }

    // ─────────────────────────────────────────────────────────────────────
    //  10. StepIn crosses into a LOADed file
    // ─────────────────────────────────────────────────────────────────────
    console.log('--- 10. StepIn crosses into LOADed file ---');
    {
      const loadedPath = path.join(tmpDir, 'stepin.logo');
      // line 1: FD 10
      // line 2: RT 30
      fs.writeFileSync(loadedPath, 'FD 10\nRT 30\n');

      // Main LOAD at a line number that differs from the loaded file's first
      // line, so stepIn's line-number-based "new location" check fires.
      const mainPath = path.join(tmpDir, 'main10.logo');
      // line 1: ; header
      // line 2: ; header
      // line 3: LOAD "stepin.logo"
      // line 4: FD 5
      const mainSrc = `; header\n; header\nLOAD "${loadedPath}\nFD 5\n`;
      fs.writeFileSync(mainPath, mainSrc);

      const rt = new LogoRuntime();
      rt.loadProgram(mainSrc, mainPath);
      rt.setBreakpoints([3], mainPath); // pause at the LOAD line (line 3)
      let done = await rt.execute();
      assert(!done, '10a: expected pause at LOAD line');
      assert(rt.getCurrentLine() === 3, `10b: got line ${rt.getCurrentLine()}`);

      // stepIn → should land on the first executable line of the loaded file
      done = await step(rt, 'stepIn');
      assert(!done, '10c: expected pause inside loaded file');
      assert(rt.getCurrentLocation().sourcePath === loadedPath,
        `10d: expected to be in loaded file, got ${rt.getCurrentLocation().sourcePath}`);
      assert(rt.getCurrentLine() === 1,
        `10e: expected loaded-file line 1, got ${rt.getCurrentLine()}`);

      // stepIn → line 2 of loaded file
      done = await step(rt, 'stepIn');
      assert(!done, '10f: expected pause at loaded-file line 2');
      assert(rt.getCurrentLine() === 2, `10g: got line ${rt.getCurrentLine()}`);
      console.log('  ✅ StepIn crosses into LOADed file');
    }

    // ─────────────────────────────────────────────────────────────────────
    //  11. Reverse debugging (stepBack) across LOAD
    // ─────────────────────────────────────────────────────────────────────
    console.log('--- 11. StepBack restores state including loaded-file history ---');
    {
      const loadedPath = path.join(tmpDir, 'rev.logo');
      fs.writeFileSync(loadedPath, 'FD 10\nFD 20\n');

      const mainPath = path.join(tmpDir, 'main11.logo');
      const mainSrc = `LOAD "${loadedPath}\n`;
      fs.writeFileSync(mainPath, mainSrc);

      const rt = new LogoRuntime();
      rt.loadProgram(mainSrc, mainPath);
      const bps = new Map<string, number[]>();
      bps.set(loadedPath, [2]); // pause on FD 20
      rt.setSourceBreakpoints(bps);

      let done = await rt.execute();
      assert(!done, '11a: expected pause at loaded-file line 2');
      assert(rt.getCurrentLine() === 2, `11b: got ${rt.getCurrentLine()}`);

      // At this point FD 10 has executed (1 line draw command), FD 20 has not.
      const before = rt.getDrawCommands().filter(c => c.type === 'line').length;
      assert(before === 1, `11c: expected 1 line pre-pause, got ${before}`);

      // Grab the previous state (state just before FD 10 ran, ideally)
      const history = rt.getExecutionHistory();
      assert(history.length >= 2, `11d: expected ≥2 history entries, got ${history.length}`);
      const prev = history[history.length - 2];
      rt.restoreState(prev);

      // After restore, before FD 10 ran → 0 lines (or fewer than before)
      const afterRestore = rt.getDrawCommands().filter(c => c.type === 'line').length;
      assert(afterRestore < before,
        `11e: expected fewer lines after restore, got ${afterRestore} (was ${before})`);
      console.log('  ✅ StepBack restores LOAD state');
    }

  } finally {
    rmTempDir(tmpDir);
  }

  console.log('');
  console.log('════════════════════════════════════════════');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log('════════════════════════════════════════════');

  if (failed > 0) {
    console.error('❌ loadDebug tests failed');
    process.exit(1);
  } else {
    console.log('🎉 All loadDebug tests passed');
  }
})();
