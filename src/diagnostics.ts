// Simple Logo diagnostics analyzer (no vscode dependency)

export type Severity = 'error' | 'warning';

export interface DiagnosticItem {
  line: number; // 0-based
  startChar: number; // 0-based
  length: number;
  severity: Severity;
  message: string;
}

export function analyzeSource(source: string): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];
  const lines = source.split('\n');

  // Helper to add diagnostic
  function push(line: number, startChar: number, length: number, severity: Severity, message: string) {
    diagnostics.push({ line, startChar, length, severity, message });
  }

  // ----- String literal check (no multi-line strings supported) -----
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Find comment start
    const commentIndex = line.indexOf(';');
    const codePart = commentIndex === -1 ? line : line.substring(0, commentIndex);

    // Check unclosed quote count in this line
    const quoteCount = (codePart.match(/"/g) || []).length;
    if (quoteCount % 2 === 1) {
      const idx = codePart.indexOf('"');
      push(i, idx >= 0 ? idx : 0, 1, 'error', 'Unterminated string literal');
    }
  }

  // ----- Brackets and parentheses (file-wide) -----
  type Bracket = { ch: string; line: number; col: number };
  const stack: Bracket[] = [];
  let inString = false;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    // ignore comments
    const commentIndex = line.indexOf(';');
    const codePart = commentIndex === -1 ? line : line.substring(0, commentIndex);

    for (let ci = 0; ci < codePart.length; ci++) {
      const ch = codePart[ci];
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '(' || ch === '[') {
        stack.push({ ch, line: li, col: ci });
      } else if (ch === ')') {
        const last = stack.pop();
        if (!last || last.ch !== '(') {
          push(li, ci, 1, 'error', "Unmatched ')' parenthesis");
        }
      } else if (ch === ']') {
        const last = stack.pop();
        if (!last || last.ch !== '[') {
          push(li, ci, 1, 'error', "Unmatched ']' bracket");
        }
      }
    }
  }

  // Remaining unclosed bracket/paren
  for (const b of stack) {
    push(b.line, b.col, 1, 'error', `Unclosed '${b.ch}'`);
  }

  // ----- TO/END procedure balancing and duplicate names -----
  interface ProcInfo { name: string | null; line: number; col: number }
  const procStack: ProcInfo[] = [];
  const procNames = new Map<string, { firstLine: number }>();

  const tokenRegex = /\bTO\b|\bEND\b|\b[A-Za-z_][A-Za-z0-9_]*\b/gi;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const commentIndex = line.indexOf(';');
    const codePart = commentIndex === -1 ? line : line.substring(0, commentIndex);

    let match: RegExpExecArray | null;
    tokenRegex.lastIndex = 0;
    while ((match = tokenRegex.exec(codePart)) !== null) {
      const token = match[0];
      const startCol = match.index;

      if (/^TO$/i.test(token)) {
        // find next identifier for procedure name
        const rest = codePart.substring(tokenRegex.lastIndex);
        const nameMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)/i.exec(rest);
        if (!nameMatch) {
          push(li, startCol, token.length, 'error', 'Missing procedure name after TO');
          procStack.push({ name: null, line: li, col: startCol });
        } else {
          const name = nameMatch[1];
          // duplicate name warning
          const upper = name.toUpperCase();
          if (procNames.has(upper)) {
            push(li, startCol + token.length + rest.indexOf(name), name.length, 'warning', `Procedure '${name}' already defined (previous at line ${procNames.get(upper)!.firstLine + 1})`);
          } else {
            procNames.set(upper, { firstLine: li });
          }
          procStack.push({ name, line: li, col: startCol });
        }
      } else if (/^END$/i.test(token)) {
        if (procStack.length === 0) {
          push(li, startCol, token.length, 'error', 'END without matching TO');
        } else {
          procStack.pop();
        }
      }
    }
  }

  for (const p of procStack) {
    push(p.line, p.col, 2, 'error', 'Missing END for procedure');
  }

  // ----- Unsupported command warnings -----
  // Supported command set (upper-case)
  const supported = new Set<string>([
    'FD','FORWARD','BK','BACK','BACKWARD','RT','RIGHT','LT','LEFT','ARC','SETH','SETHEADING',
    'PU','PENUP','PD','PENDOWN','CS','CLEARSCREEN','CLEAN','HOME','SETPOS','HT','HIDETURTLE','ST','SHOWTURTLE','SETPENCOLOR','SETPC',
    'REPEAT','IF','STOP','MAKE'
  ]);

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const commentIndex = line.indexOf(';');
    const codePart = commentIndex === -1 ? line : line.substring(0, commentIndex);
    const trimmed = codePart.trim();
    if (!trimmed) continue;

    // Check first token on the line
    const m = /^[\s]*([A-Za-z_][A-Za-z0-9_]*)/.exec(codePart);
    if (m) {
      const token = m[1];
      // tokenStart is the actual column where the token begins (handles leading whitespace)
      const tokenStart = m.index + (m[0].indexOf(token));
      const up = token.toUpperCase();

      // Skip known keywords, procedure definitions, and procedure names
      if (up === 'TO' || up === 'END') continue;
      if (procNames.has(up)) continue;

      // Basic parameter validation for some common commands
      const parts = codePart.trim().split(/\s+/);
      const arg = parts.length > 1 ? parts[1] : null;

      const isNumber = (s: string | null) => s !== null && /^-?\d+(?:\.\d+)?$/.test(s);

      if (up === 'FD' || up === 'FORWARD' || up === 'BK' || up === 'BACK' || up === 'BACKWARD') {
        // Expect at least one parameter (no validation of numeric or extra args)
        if (!arg) {
          push(li, tokenStart, token.length, 'error', `${token.toUpperCase()} expects 1 argument`);
        }
      }

      if (up === 'RT' || up === 'RIGHT' || up === 'LT' || up === 'LEFT') {
        if (!arg) {
          push(li, tokenStart, token.length, 'error', `${token.toUpperCase()} expects 1 argument`);
        }
      }

      if (up === 'ARC') {
        const arg2 = parts.length > 2 ? parts[2] : null;
        if (!arg || !arg2) {
          push(li, tokenStart, token.length, 'error', `${token.toUpperCase()} expects 2 arguments`);
        }
      }

      if (up === 'REPEAT') {
        // Expect at least a repeat count and a bracketed block
        if (!arg) {
          push(li, tokenStart, token.length, 'error', `REPEAT expects an argument`);
        } else {
          const trimmedArg = arg.trim();
          // Handle case: REPEAT [ ...  (missing count)
          if (trimmedArg.startsWith('[')) {
            push(li, tokenStart, token.length, 'error', `REPEAT expects an argument`);
          }

          // Check for '[' on same line or any following non-commented lines
          const after = codePart.substring(m.index + token.length);
          if (!after.includes('[')) {
            let found = false;
            for (let sj = li + 1; sj < lines.length; sj++) {
              const sline = lines[sj];
              const sCommentIndex = sline.indexOf(';');
              const sCodePart = sCommentIndex === -1 ? sline : sline.substring(0, sCommentIndex);
              if (sCodePart.indexOf('[') !== -1) {
                found = true;
                break;
              }
            }
            if (!found) {
              push(li, tokenStart, token.length, 'error', `REPEAT expects a block`);
            }
          }
        }
      }

      if (up === 'SETPENCOLOR' || up === 'SETPC') {
        if (!arg) {
          push(li, tokenStart, token.length, 'error', `${token.toUpperCase()} expects 1 argument`);
        }
      }

      // Unsupported command warning (only if not a supported command or known proc)
      if (!supported.has(up) && !procNames.has(up) && up !== 'TO' && up !== 'END') {
        push(li, tokenStart, token.length, 'warning', `Unsupported command '${token}'`);
      }
    }

    // Also check for commands immediately after '[' (e.g., single-line REPEAT/IF blocks)
    let idx = 0;
    while (true) {
      const br = codePart.indexOf('[', idx);
      if (br === -1) break;
      // find first word after '['
      const after = codePart.substring(br + 1);
      const m2 = /^[\s]*([A-Za-z_][A-Za-z0-9_]*)/.exec(after);
      if (m2) {
        const token = m2[1];
        // compute column relative to codePart: br + 1 + index within 'after' plus any leading spaces within m2[0]
        const tokenStart = br + 1 + m2.index + (m2[0].indexOf(token));
        const up = token.toUpperCase();
        if (!supported.has(up) && !procNames.has(up) && up !== 'TO' && up !== 'END') {
          push(li, tokenStart, token.length, 'warning', `Unsupported command '${token}'`);
        }
      }
      idx = br + 1;
    }
  }

  return diagnostics;
}
