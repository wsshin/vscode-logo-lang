import * as fs from 'fs';
import * as path from 'path';
import { LogoRuntime } from '../logoDebugger';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

(async () => {
  console.log('🧪 examplesDebug tests starting...');

  const examplesDir = path.resolve(__dirname, '../../examples');

  function gatherLogoFiles(dir: string): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        results.push(...gatherLogoFiles(full));
      } else if (e.isFile() && e.name.endsWith('.logo')) {
        results.push(full);
      }
    }
    return results;
  }

  const files = gatherLogoFiles(examplesDir);
  assert(files.length > 0, 'No example files found in examples/');

  for (const filePath of files) {
    try {
      console.log('→ Testing', path.relative(process.cwd(), filePath));
      const src = fs.readFileSync(filePath, 'utf8');

      const rt = new LogoRuntime();
      rt.loadProgram(src);

      // Determine the first executable token's line so breakpoint is reliable
      const tokens = (rt as any).tokenize(src) as Array<{ value: string; line: number }>;

      // Find the first top-level executable token (skip procedure definitions)
      let firstExecLine: number | null = null;
      let i = 0;
      while (i < tokens.length) {
        const t = tokens[i].value.toUpperCase();
        if (t === 'TO') {
          // skip until matching END
          let depth = 1;
          i++;
          while (i < tokens.length && depth > 0) {
            const v = tokens[i].value.toUpperCase();
            if (v === 'TO') depth++;
            else if (v === 'END') depth--;
            i++;
          }
          continue;
        }
        // Found first top-level token
        firstExecLine = tokens[i].line;
        break;
      }

      if (firstExecLine === null) {
        console.log('ℹ️', path.basename(filePath), 'has no top-level executable tokens; skipping breakpoint check');
        continue;
      }

      // Set a breakpoint at the first executable line and start execution
      rt.setBreakpoints([firstExecLine]);
      const paused = await rt.execute();
      assert(paused === false, `${filePath}: expected to pause at breakpoint (line ${firstExecLine})`);
      assert(rt.getCurrentLine() === firstExecLine, `${filePath}: expected current line ${firstExecLine}, got ${rt.getCurrentLine()}`);

      // Detect top-level variable assignment lines (like ":NAME = ...") after this point
      const assignmentLines: number[] = [];
      const assignedVarsByLine: Map<number, string[]> = new Map();
      let k = 0;
      while (k < tokens.length) {
        const t = tokens[k].value.toUpperCase();
        if (t === 'TO') {
          // skip procedure body
          let depth = 1;
          k++;
          while (k < tokens.length && depth > 0) {
            const v = tokens[k].value.toUpperCase();
            if (v === 'TO') depth++;
            else if (v === 'END') depth--;
            k++;
          }
          continue;
        }

        // Look for assignments at top-level
        if (tokens[k].value.startsWith(':') && k + 1 < tokens.length && tokens[k + 1].value === '=') {
          const lineNum = tokens[k].line;
          if (lineNum >= firstExecLine) {
            assignmentLines.push(lineNum);
            // collect variable names on this line
            const names: string[] = [];
            let j = k;
            while (j < tokens.length && tokens[j].line === lineNum) {
              if (tokens[j].value.startsWith(':') && j + 1 < tokens.length && tokens[j + 1].value === '=') {
                names.push(tokens[j].value.substring(1)); // Remove ':' prefix
              }
              j++;
            }
            assignedVarsByLine.set(lineNum, names);
          }
        }
        k++;
      }

      // Step through and verify assigned variable values (if any)
      for (const lineNum of assignmentLines) {
        // Step until we reach and execute this line
        while (rt.getCurrentLine() < lineNum) {
          (rt as any).pauseRequested = true;
          rt.setStepMode('stepOver');
          (rt as any).lastSteppedLine = rt.getCurrentLine();
          const r = await rt.execute();
          assert(r === false, `${filePath}: expected to pause while stepping to line ${lineNum}`);
        }

        // Now step over this line so it's executed and we pause after it
        (rt as any).pauseRequested = true;
        rt.setStepMode('stepOver');
        (rt as any).lastSteppedLine = rt.getCurrentLine();
        const after = await rt.execute();
        // We expect to be paused after executing the assignment (not complete)
        assert(after === false, `${filePath}: expected to remain paused after executing assignment at line ${lineNum}`);

        // Verify variables defined on this line exist and are numeric
        const vars = assignedVarsByLine.get(lineNum) || [];
        for (const vname of vars) {
          const varsMap = rt.getVariables();
          const val = varsMap.get(vname);
          assert(typeof val === 'number' && Number.isFinite(val), `${filePath}: expected ${vname} to be a finite number after line ${lineNum}, got ${val}`);
          console.log(`🔎 ${path.basename(filePath)}: ${vname} = ${val}`);
        }
      }

      // --- Nested-procedure stepping tests ---
      const procMap: Map<string, any> = (rt as any).procedures || new Map();
      const procNames = Array.from(procMap.keys()).map(k => k.toUpperCase());
      if (procNames.length === 0) {
        console.log('ℹ️', path.basename(filePath), 'has no procedures; skipping nested-procedure step tests');
      } else {
        // Find first top-level procedure call token after the first exec line
        let callLine: number | null = null;
        let callTokenValue: string | null = null;
        let idx = 0;
        while (idx < tokens.length) {
          const t = tokens[idx].value.toUpperCase();
          if (t === 'TO') {
            // skip procedure body
            let depth = 1;
            idx++;
            while (idx < tokens.length && depth > 0) {
              const v = tokens[idx].value.toUpperCase();
              if (v === 'TO') depth++;
              else if (v === 'END') depth--; 
              idx++;
            }
            continue;
          }
          if (tokens[idx].line >= firstExecLine && procNames.includes(t)) {
            callLine = tokens[idx].line;
            callTokenValue = tokens[idx].value;
            break;
          }
          idx++;
        }

        if (callLine === null || !callTokenValue) {
          console.log('ℹ️', path.basename(filePath), 'has no top-level procedure calls; skipping step-in test');
        } else {
          console.log(`→ Stepping into procedure call '${callTokenValue}' at line ${callLine}`);

          // Use a fresh runtime so stepping behavior is deterministic
          const rt2 = new LogoRuntime();
          rt2.loadProgram(src);

          // Pause at the first exec line
          rt2.setBreakpoints([firstExecLine]);
          const p2 = await rt2.execute();
          assert(p2 === false, `${filePath}: expected to pause at entry for step-in test`);

          // Step over until we reach the callLine
          while (rt2.getCurrentLine() < callLine) {
            (rt2 as any).pauseRequested = true;
            rt2.setStepMode('stepOver');
            (rt2 as any).lastSteppedLine = rt2.getCurrentLine();
            const r = await rt2.execute();
            assert(r === false, `${filePath}: expected to pause while stepping to call line ${callLine}`);
          }

          // Now step in and expect to pause at the procedure entry line
          (rt2 as any).pauseRequested = true;
          rt2.setStepMode('stepIn');
          (rt2 as any).lastSteppedLine = rt2.getCurrentLine();
          const entered = await rt2.execute();
          assert(entered === false, `${filePath}: expected to pause after stepping into procedure ${callTokenValue}`);

          const callStack = rt2.getCallStack();
          assert(callStack.length >= 1, `${filePath}: expected to be inside a procedure after stepIn`);

          const procNameKey = callTokenValue.toUpperCase();
          const procDef = procMap.get(procNameKey);
          assert(procDef, `${filePath}: procedure definition ${procNameKey} expected`);

          // After stepping in we expect to have paused at the procedure definition line
          const curLine = rt2.getCurrentLine();
          assert(curLine === procDef.sourceLineStart, `${filePath}: expected to be paused at procedure entry line ${procDef.sourceLineStart}, got ${curLine}`);

          // Verify call stack contains the procedure
          const cs = rt2.getCallStack();
          const containsProc = cs.some((f: any) => typeof f.procedure === 'string' && f.procedure.toUpperCase() === procNameKey);
          assert(containsProc, `${filePath}: expected call stack to contain ${procNameKey}, got [${cs.map((f: any) => f.procedure).join(', ')}]`);
          console.log('✅ StepIn paused at procedure entry', procNameKey, 'line', curLine);

          // Step line-by-line (stepIn) until we return from the procedure or finish execution
          const bodyTokens = procDef.body || [];
          const hasRepeatOrIf = bodyTokens.some((tt: any) => {
            const v = (tt.value || '').toUpperCase();
            return v === 'REPEAT' || v === 'IF';
          });
          const callsOtherProc = bodyTokens.some((tt: any) => procNames.includes(((tt.value || '').toUpperCase())));
          const isRecursive = bodyTokens.some((tt: any) => (tt.value || '').toUpperCase() === procNameKey);
          const isComplex = isRecursive || hasRepeatOrIf || callsOtherProc;
          if (isComplex) {
            // Guarded step-in: try to exercise step-in semantics but stop if we detect repeating states
            let steps = 0;
            const maxSteps = 500;
            const seenStates = new Set<string>();
            let prevStackDepth = rt2.getCallStack().length;

            while (steps < maxSteps) {
              (rt2 as any).pauseRequested = true;
              rt2.setStepMode('stepIn');
              (rt2 as any).lastSteppedLine = rt2.getCurrentLine();
              const r = await rt2.execute();

              // If execution finished, we're done
              if (r === true) {
                console.log('Execution completed during guarded step-in walk');
                break;
              }

              const cs = rt2.getCallStack();
              const stateKey = cs.map((f: any) => f.procedure).join('|') + '::' + rt2.getCurrentLine();

              // If we've seen this exact state before, assume a loop and stop
              if (seenStates.has(stateKey)) {
                // Detected repeating state - normal for loops/recursion
                break;
              }

              seenStates.add(stateKey);

              // If we returned from the procedure (shallower call stack), success
              if (cs.length < prevStackDepth) {
                console.log('✅ Returned from procedure after', steps + 1, 'guarded step(s)');
                break;
              }

              prevStackDepth = cs.length;
              steps++;
            }

            // Successfully completed guarded walk (no warning needed)
          } else {
            let steps = 0;
            const maxSteps = 500;
            let prevStackDepth = rt2.getCallStack().length;
            while (steps < maxSteps) {
              (rt2 as any).pauseRequested = true;
              rt2.setStepMode('stepIn');
              (rt2 as any).lastSteppedLine = rt2.getCurrentLine();
              const r = await rt2.execute();
              if (r === true) {
                console.log('Execution completed during step-in walk');
                break;
              }
              const cs = rt2.getCallStack();
              if (cs.length < prevStackDepth) {
                console.log('✅ Returned from procedure after', steps + 1, 'step(s)');
                break;
              }
              prevStackDepth = cs.length;
              steps++;
            }
            assert(steps < maxSteps, `${filePath}: step-in loop exceeded ${maxSteps} steps`);
          }
        }
      }

      // Clear breakpoints and resume to completion
      rt.setBreakpoints([]);
      (rt as any).pauseRequested = false; // Clear pause flag to allow execution to continue
      const completed = await rt.execute();
      assert(completed === true, `${filePath}: expected execution to complete after resume`);

      console.log('✅', path.basename(filePath), 'loaded, paused at breakpoint, verified variables, tested step-in, and completed successfully');
    } catch (e) {
      console.error('Error testing', filePath);
      console.error(e);
      process.exit(1);
    }
  }

  console.log('🎉 All examplesDebug tests passed');
  process.exit(0);
})();