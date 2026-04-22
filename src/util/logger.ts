import * as vscode from 'vscode';

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('INFO', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('WARN', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('ERROR', message, args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('DEBUG', message, args);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private write(level: string, message: string, args: unknown[]): void {
    const timestamp = new Date().toISOString();
    const suffix = args.length
      ? ' ' + args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ')
      : '';
    this.channel.appendLine(`[${timestamp}] ${level} ${message}${suffix}`);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
