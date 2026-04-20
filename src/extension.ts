// Main extension file
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LogoRuntime, DrawCommand } from './logoDebugger';
import { LogoCompletionProvider } from './completionProvider';
import { analyzeSource } from './diagnostics';

let graphicsPanel: vscode.WebviewPanel | undefined;
let previewPanel: vscode.WebviewPanel | undefined;
let previewSourceUri: vscode.Uri | undefined;
let diagnosticsCollection: vscode.DiagnosticCollection | undefined;

// Shared LOGO output channel (appears next to Debug Console)
let logoOutputChannel: vscode.OutputChannel | undefined;

function getLogoOutputChannel(): vscode.OutputChannel {
  if (!logoOutputChannel) {
    logoOutputChannel = vscode.window.createOutputChannel('LOGO');
  }
  logoOutputChannel.show(true);
  return logoOutputChannel;
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Logo Debugger extension is now active');

  // Register completion provider
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    'logo',
    new LogoCompletionProvider(),
    ':', // Trigger on ':' for variables
  );
  context.subscriptions.push(completionProvider);

  // Create diagnostics collection for Logo and wire listeners
  diagnosticsCollection = vscode.languages.createDiagnosticCollection('logo');
  context.subscriptions.push(diagnosticsCollection);

  function updateDiagnosticsForDocument(doc: vscode.TextDocument) {
    if (doc.languageId !== 'logo') return;
    const items = analyzeSource(doc.getText(), doc.uri.fsPath);
    const diagnostics: vscode.Diagnostic[] = items.map(it => {
      const range = new vscode.Range(it.line, it.startChar, it.line, it.startChar + it.length);
      const severity = it.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
      return new vscode.Diagnostic(range, it.message, severity);
    });
    diagnosticsCollection!.set(doc.uri, diagnostics);
  }

  // Wire workspace events to update diagnostics
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(updateDiagnosticsForDocument));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => updateDiagnosticsForDocument(e.document)));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(updateDiagnosticsForDocument));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => diagnosticsCollection!.delete(doc.uri)));

  // Refresh diagnostics for already-open documents
  vscode.workspace.textDocuments.forEach(updateDiagnosticsForDocument);

  // Register command to show graphics
  const showGraphicsCommand = vscode.commands.registerCommand(
    'logo.showGraphics',
    () => {
      showGraphicsPanel(context);
    }
  );

  context.subscriptions.push(showGraphicsCommand);

  const runFileCommand = vscode.commands.registerCommand(
    'logo.runFile',
    async (resource?: vscode.Uri) => {
      const document = await resolveLogoDocument(resource);
      if (!document) {
        vscode.window.showErrorMessage('No active Logo editor found. Open a .logo file and try again.');
        return;
      }

      try {
        const runtime = new LogoRuntime();
        runtime.loadProgram(document.getText(), document.fileName);

        // Route PRINT output to the LOGO output channel
        const outputChannel = getLogoOutputChannel();
        outputChannel.clear();
        runtime.setPrintCallback((message: string) => {
          outputChannel.appendLine(message);
        });

        await runtime.execute();

        showGraphicsPanel(context);
        updateGraphics(runtime.getDrawCommands());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to run Logo program: ${message}`);
      }
    }
  );

  context.subscriptions.push(runFileCommand);

  // Register command to show preview (like Markdown preview)
  const showPreviewCommand = vscode.commands.registerCommand(
    'logo.showPreview',
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'logo') {
        vscode.window.showErrorMessage('Open a .logo file to preview.');
        return;
      }
      showPreviewPanel(context, editor.document);
    }
  );
  context.subscriptions.push(showPreviewCommand);

  // Auto-update preview on save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === 'logo' && previewPanel && previewSourceUri && doc.uri.toString() === previewSourceUri.toString()) {
        runPreview(doc);
      }
    })
  );

  // Listen for debug session custom events
  vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
    if (event.event === 'logo.drawCommands') {
      updateGraphics(event.body.commands);
    }
    if (event.event === 'logo.printOutput') {
      const outputChannel = getLogoOutputChannel();
      outputChannel.appendLine(event.body.text);
    }
  });

  // Auto-show graphics panel when debugging starts and clear previous output
  vscode.debug.onDidStartDebugSession((session) => {
    if (session.type === 'logo') {
      showGraphicsPanel(context);
      const outputChannel = getLogoOutputChannel();
      outputChannel.clear();
    }
  });

  // Monitor debug console output for draw commands
  vscode.debug.registerDebugAdapterTrackerFactory('logo', {
    createDebugAdapterTracker(session: vscode.DebugSession) {
      return {
        onDidSendMessage: (message: any) => {
          if (message.type === 'event' && message.event === 'output') {
            try {
              const output = message.body.output;
              if (output.includes('drawCommands')) {
                const data = JSON.parse(output);
                if (data.type === 'drawCommands') {
                  updateGraphics(data.commands);
                }
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      };
    }
  });
}

async function resolveLogoDocument(resource?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  if (resource) {
    const existingDocument = vscode.workspace.textDocuments.find(
      doc => doc.uri.toString() === resource.toString()
    );
    const document = existingDocument ?? await vscode.workspace.openTextDocument(resource);
    return document.languageId === 'logo' ? document : undefined;
  }

  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument?.languageId === 'logo') {
    return activeDocument;
  }

  return undefined;
}

function showGraphicsPanel(context: vscode.ExtensionContext) {
  if (graphicsPanel) {
    graphicsPanel.reveal(vscode.ViewColumn.Two, true);
  } else {
    graphicsPanel = vscode.window.createWebviewPanel(
      'logoGraphics',
      'Logo Graphics',
      {
        viewColumn: vscode.ViewColumn.Two,
        preserveFocus: true
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    graphicsPanel.webview.html = getWebviewContent(context);

    graphicsPanel.onDidDispose(() => {
      graphicsPanel = undefined;
    });
  }
}

function updateGraphics(commands: DrawCommand[]) {
  if (graphicsPanel) {
    graphicsPanel.webview.postMessage({
      command: 'draw',
      commands: commands
    });
  }
}

function getWebviewContent(context: vscode.ExtensionContext): string {
  const htmlPath = path.join(context.extensionPath, 'webview', 'graphics.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  
  // Add Content Security Policy
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">`;
  html = html.replace('<meta charset="UTF-8">', `<meta charset="UTF-8">\n    ${cspMeta}`);
  
  return html;
}

function showPreviewPanel(context: vscode.ExtensionContext, document: vscode.TextDocument) {
  previewSourceUri = document.uri;

  if (previewPanel) {
    previewPanel.reveal(vscode.ViewColumn.Two);
  } else {
    previewPanel = vscode.window.createWebviewPanel(
      'logoPreview',
      'Preview: ' + path.basename(document.fileName),
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    previewPanel.webview.html = getWebviewContent(context);

    previewPanel.onDidDispose(() => {
      previewPanel = undefined;
      previewSourceUri = undefined;
    });
  }

  // Update title when source changes
  previewPanel.title = 'Preview: ' + path.basename(document.fileName);

  // Run the program immediately
  runPreview(document);
}

function runPreview(document: vscode.TextDocument) {
  const source = document.getText();
  const runtime = new LogoRuntime();
  runtime.loadProgram(source, document.fileName);
  // Run without breakpoints/stepping
  runtime.setStepMode('continue');
  runtime.execute().then(() => {
    const commands = runtime.getDrawCommands();
    if (previewPanel) {
      previewPanel.webview.postMessage({
        command: 'draw',
        commands: commands
      });
    }
  }).catch((err) => {
    // Silently ignore runtime errors in preview
    const commands = runtime.getDrawCommands();
    if (previewPanel) {
      previewPanel.webview.postMessage({
        command: 'draw',
        commands: commands
      });
    }
  });
}

export function deactivate() {
  if (graphicsPanel) {
    graphicsPanel.dispose();
  }
  if (previewPanel) {
    previewPanel.dispose();
  }
  if (diagnosticsCollection) {
    diagnosticsCollection.clear();
    diagnosticsCollection.dispose();
  }
}
