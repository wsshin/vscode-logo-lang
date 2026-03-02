import * as vscode from 'vscode';

interface LogoCompletionItem {
  label: string;
  detail: string;
  insertText?: string;
  kind: vscode.CompletionItemKind;
  documentation?: string;
}

export class LogoCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): vscode.CompletionItem[] {
    const completionItems: vscode.CompletionItem[] = [];

    // Control flow keywords
    const controlKeywords: LogoCompletionItem[] = [
      { label: 'TO', detail: 'Define a procedure', kind: vscode.CompletionItemKind.Keyword },
      { label: 'END', detail: 'End procedure definition', kind: vscode.CompletionItemKind.Keyword },
      { label: 'REPEAT', detail: 'Repeat commands', kind: vscode.CompletionItemKind.Keyword },
      { label: 'IF', detail: 'Conditional statement', kind: vscode.CompletionItemKind.Keyword },
      { label: 'STOP', detail: 'Stop execution', kind: vscode.CompletionItemKind.Keyword },
    ];

    // Turtle movement commands
    const turtleCommands: LogoCompletionItem[] = [
      { label: 'FORWARD', detail: 'Move forward', kind: vscode.CompletionItemKind.Function },
      { label: 'FD', detail: 'Move forward', kind: vscode.CompletionItemKind.Function },
      { label: 'BACK', detail: 'Move backward', kind: vscode.CompletionItemKind.Function },
      { label: 'BACKWARD', detail: 'Move backward', kind: vscode.CompletionItemKind.Function },
      { label: 'BK', detail: 'Move backward', kind: vscode.CompletionItemKind.Function },
      { label: 'RIGHT', detail: 'Turn right', kind: vscode.CompletionItemKind.Function },
      { label: 'RT', detail: 'Turn right', kind: vscode.CompletionItemKind.Function },
      { label: 'LEFT', detail: 'Turn left', kind: vscode.CompletionItemKind.Function },
      { label: 'LT', detail: 'Turn left', kind: vscode.CompletionItemKind.Function },
      { label: 'ARC', detail: 'Draw an arc (angle, radius)', kind: vscode.CompletionItemKind.Function },
      { label: 'SETHEADING', detail: 'Set heading', kind: vscode.CompletionItemKind.Function },
      { label: 'SETH', detail: 'Set heading', kind: vscode.CompletionItemKind.Function },
      { label: 'SETPOS', detail: 'Set position', kind: vscode.CompletionItemKind.Function },
      { label: 'HOME', detail: 'Return to home position', kind: vscode.CompletionItemKind.Function }
    ];

    // Pen commands
    const penCommands: LogoCompletionItem[] = [
      { label: 'PENUP', detail: 'Lift pen up', kind: vscode.CompletionItemKind.Function },
      { label: 'PU', detail: 'Lift pen up', kind: vscode.CompletionItemKind.Function },
      { label: 'PENDOWN', detail: 'Put pen down', kind: vscode.CompletionItemKind.Function },
      { label: 'PD', detail: 'Put pen down', kind: vscode.CompletionItemKind.Function },
      { label: 'SETPENCOLOR', detail: 'Set pen color', kind: vscode.CompletionItemKind.Function },
      { label: 'SETPC', detail: 'Set pen color', kind: vscode.CompletionItemKind.Function },
    ];

    // Screen commands
    const screenCommands: LogoCompletionItem[] = [
      { label: 'CLEARSCREEN', detail: 'Clear the screen', kind: vscode.CompletionItemKind.Function },
      { label: 'CS', detail: 'Clear the screen', kind: vscode.CompletionItemKind.Function },
      { label: 'CLEAN', detail: 'Clear graphics only', kind: vscode.CompletionItemKind.Function },
      { label: 'HIDETURTLE', detail: 'Hide the turtle', kind: vscode.CompletionItemKind.Function },
      { label: 'HT', detail: 'Hide the turtle', kind: vscode.CompletionItemKind.Function },
      { label: 'SHOWTURTLE', detail: 'Show the turtle', kind: vscode.CompletionItemKind.Function },
      { label: 'ST', detail: 'Show the turtle', kind: vscode.CompletionItemKind.Function },
    ];

    // Code snippets
    const snippets: LogoCompletionItem[] = [
      {
        label: 'to square',
        detail: 'Draw a square',
        insertText: 'TO SQUARE :SIZE\n\tREPEAT 4 [\n\t\tFD :SIZE\n\t\tRT 90\n\t]\nEND',
        kind: vscode.CompletionItemKind.Snippet,
        documentation: 'Creates a procedure to draw a square'
      },
      {
        label: 'to triangle',
        detail: 'Draw a triangle',
        insertText: 'TO TRIANGLE :SIZE\n\tREPEAT 3 [\n\t\tFD :SIZE\n\t\tRT 120\n\t]\nEND',
        kind: vscode.CompletionItemKind.Snippet,
        documentation: 'Creates a procedure to draw a triangle'
      },
      {
        label: 'to circle',
        detail: 'Draw a circle',
        insertText: 'TO CIRCLE :RADIUS\n\t:STEPS = 36\n\t:ANGLE = 360 / :STEPS\n\t:SIDE = 2 * 3.14159 * :RADIUS / :STEPS\n\tREPEAT :STEPS [\n\t\tFD :SIDE\n\t\tRT :ANGLE\n\t]\nEND',
        kind: vscode.CompletionItemKind.Snippet,
        documentation: 'Creates a procedure to draw a circle'
      },
      {
        label: 'to polygon',
        detail: 'Draw a polygon',
        insertText: 'TO POLYGON :SIZE :SIDES\n\tREPEAT :SIDES [\n\t\tFD :SIZE\n\t\tRT 360 / :SIDES\n\t]\nEND',
        kind: vscode.CompletionItemKind.Snippet,
        documentation: 'Creates a procedure to draw any regular polygon'
      }
    ];

    // Combine all completions
    const allCompletions: LogoCompletionItem[] = [
      ...controlKeywords,
      ...turtleCommands,
      ...penCommands,
      ...screenCommands,
      ...snippets
    ];

    // Convert to CompletionItems
    allCompletions.forEach(item => {
      const completionItem = new vscode.CompletionItem(item.label, item.kind);
      completionItem.detail = item.detail;
      if (item.insertText) {
        completionItem.insertText = new vscode.SnippetString(item.insertText);
      }
      if (item.documentation) {
        completionItem.documentation = new vscode.MarkdownString(item.documentation);
      }
      completionItems.push(completionItem);
    });

    // Add variable suggestions (scan document for :variables)
    const text = document.getText();
    const variablePattern = /:[A-Za-z_][A-Za-z0-9_]*/g;
    const variables = new Set<string>();
    let match;
    while ((match = variablePattern.exec(text)) !== null) {
      variables.add(match[0]);
    }

    variables.forEach(variable => {
      const completionItem = new vscode.CompletionItem(variable, vscode.CompletionItemKind.Variable);
      completionItem.detail = 'Variable';
      completionItems.push(completionItem);
    });

    return completionItems;
  }
}
